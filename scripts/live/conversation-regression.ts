import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  Agent, FileEditorTool, FinishTool, LocalConversation, TerminalTool, ToolDefinition,
  createClientFromProfile, metricsSnapshot, restoreConversationState,
  type ActionEvent, type Event, type FetchLike, type LLMClient, type LLMCompletionResponse,
  type LLMProfile, type SecretStore,
} from '@smolpaws/openhands-agent';
import { assertConcurrentWireOrder, assertPlainResponseWireOrder } from './conversation-wire.js';
import { providerFailure } from './provider-failure.js';

const execFileAsync = promisify(execFile);
const FINISH_INPUT = 'finish with a finish tool call';
const OLD_WORD = 'Idiomatic';
const NEW_WORD = 'Straightforward';
const DIRECTORIES = ['src', 'examples'] as const;
const PLAIN_REPLY = 'PLAIN-REPLY';
const PLAIN_INPUT = 'Call finish with exactly INFLIGHT-FINISHED.';
type RegressionPhase = 'setup' | 'read' | 'edit' | 'parallel' | 'plain' | 'restore';

export interface ConversationRegressionOptions {
  readonly profile: LLMProfile;
  readonly store: SecretStore;
  readonly repoRoot?: string;
  readonly signal?: AbortSignal;
  /** Optional transport injection; the regression always inspects the final serialized POST body. */
  readonly fetch?: FetchLike;
  readonly maxRequests?: number;
  readonly timeoutMs?: number;
}

export interface ConversationRegressionSummary {
  readonly profileId: string;
  readonly requestedModel: string;
  readonly returnedModels: readonly string[];
  readonly sourceCommit: string;
  readonly requests: number;
  readonly recordedCompletions: number;
  readonly parallelToolExecutions: number;
  readonly wireRequestsChecked: number;
  readonly plainResponseWireRequestsChecked: number;
  readonly checks: readonly string[];
}

/** One real conversation on an isolated snapshot of this repository; no global cwd or profile edits. */
export async function runConversationRegression(options: ConversationRegressionOptions): Promise<ConversationRegressionSummary> {
  const controller = new AbortController();
  const scratch = await mkdtemp(join(tmpdir(), 'openhands-llm-conversation-'));
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  let releaseTools = () => {};
  let releasePlainResponse = () => {};
  let activeRun: Promise<void> | undefined;
  let regressionPhase: RegressionPhase = 'setup';
  try {
    signal.throwIfAborted();
    const repoRoot = resolve(options.repoRoot ?? process.cwd());
    const { stdout: revision } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, signal });
    const sourceCommit = revision.trim();
    const archive = join(scratch, 'source.tar');
    await execFileAsync('git', ['archive', '--format=tar', `--output=${archive}`, sourceCommit], { cwd: repoRoot, signal });
    const workspace = join(scratch, 'repo');
    await execFileAsync('mkdir', ['-p', workspace], { signal });
    await execFileAsync('tar', ['-xf', archive, '-C', workspace], { signal });
    const readmePath = join(workspace, 'README.md');
    const originalReadme = await readFile(readmePath, 'utf8');
    assert.ok(originalReadme.split(OLD_WORD).length === 2, 'README fixture must contain the chosen original word exactly once');
    assert.ok(!originalReadme.includes(NEW_WORD), 'replacement word must be absent from the original README');
    const editedReadme = originalReadme.replace(OLD_WORD, NEW_WORD);
    const expectedListings = new Map<string, string[]>(await Promise.all(DIRECTORIES.map(async directory => [
      `ls -1 ${directory}`, (await readdir(join(workspace, directory))).filter(name => !name.startsWith('.')).sort(),
    ] as const)));

    let requests = 0;
    let wireRequestsChecked = 0;
    let plainResponseWireRequestsChecked = 0;
    let callIds: string[] = [];
    let injected = false;
    let plainInjected = false;
    let plainStarted!: () => void;
    const plainRequestStarted = new Promise<void>(done => { plainStarted = done; });
    const plainResponseReleased = new Promise<void>(done => { releasePlainResponse = done; });
    const responses: LLMCompletionResponse[] = [];
    const realClient = await createClientFromProfile(options.profile, options.store, { fetch: async (url, init) => {
      signal.throwIfAborted();
      assert.ok(++requests <= (options.maxRequests ?? 18), 'conversation exceeded its request budget');
      // This is deliberately below LLMClient.complete: adapters repair tool-result order there.
      if (injected) {
        assertConcurrentWireOrder(JSON.parse(init.body), callIds, FINISH_INPUT);
        wireRequestsChecked += 1;
      } else {
        assert.ok(!init.body.includes(FINISH_INPUT), 'the later user instruction must not appear in an earlier request');
      }
      if (plainInjected) {
        assertPlainResponseWireOrder(JSON.parse(init.body), PLAIN_REPLY, PLAIN_INPUT);
        plainResponseWireRequestsChecked += 1;
      }
      const plainRequest = stage === 'plain' && !plainInjected;
      const pendingResult = waitFor(options.fetch === undefined
        ? fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
        : options.fetch(url, init), signal);
      // Resolve only once a real provider transport has been invoked. Keep its
      // result gated until the caller durably appends the concurrent message.
      if (plainRequest) plainStarted();
      const result = await pendingResult;
      if (plainRequest) await waitFor(plainResponseReleased, signal);
      if (!result.ok) {
        throw await providerFailure(result);
      }
      return result;
    } });
    const llm: LLMClient = { profile: realClient.profile, complete: async (messages, tools) => {
      const response = await realClient.complete(messages, tools);
      if (stage === 'parallel' && !injected) {
        assert.ok(response.message.tool_calls?.length === 2 && response.message.tool_calls.every(call => call.name === 'terminal'),
          'parallel phase requires exactly two terminal calls in one real model response');
      }
      responses.push(response);
      return response;
    } };

    let stage: 'read' | 'edit' | 'parallel' | 'plain' | 'plain-followup' | 'restore' = 'read';
    let reads = 0;
    let edits = 0;
    let started = 0;
    let toolFailure: Error | undefined;
    const checkedTool = async <T>(execute: () => Promise<T>): Promise<T> => {
      try { return await execute(); }
      catch (error) {
        // Only our hand-authored assertion label, never provider content or the
        // possibly verbose assertion diff, becomes a diagnostic error message.
        if (error instanceof assert.AssertionError) toolFailure = new Error(error.message.split('\n')[0]);
        throw error;
      }
    };
    const commands: string[] = [];
    let bothStarted!: () => void;
    const parallelStarted = new Promise<void>(done => { bothStarted = done; });
    const toolsReleased = new Promise<void>(done => { releaseTools = done; });
    signal.addEventListener('abort', releaseTools, { once: true });
    const editor = FileEditorTool.create({ workspaceRoot: workspace });
    const boundedEditor = new ToolDefinition({
      name: editor.name, description: editor.description, inputSchema: editor.inputSchema, outputSchema: editor.outputSchema,
      executor: async action => checkedTool(async () => {
        assert.ok(resolve(workspace, action.path) === readmePath, 'only this isolated README may be opened or edited');
        assert.ok(stage === 'read' || stage === 'edit', 'file effects are not allowed after the edit phase');
        if (action.command === 'view') {
          if (stage === 'read') {
            const lastLine = originalReadme.replace(/\n$/u, '').split('\n').length;
            const startLine = action.view_range?.[0] ?? 1;
            const endLine = action.view_range?.[1] ?? -1;
            assert.ok(startLine === 1 && (endLine === -1 || endLine >= lastLine), 'the read phase must read the complete README');
          }
          reads += 1;
        } else {
          assert.ok(stage === 'edit' && action.command === 'str_replace', 'only the requested word replacement is allowed');
          const before = await readFile(readmePath, 'utf8');
          assert.ok(action.old_str !== null && action.old_str.length > 0 && action.new_str !== null
            && before.split(action.old_str).length === 2
            && before.replace(action.old_str, action.new_str) === editedReadme,
          'the requested edit must produce exactly the chosen word replacement');
          assert.ok(++edits === 1, 'the README replacement must happen exactly once');
        }
        const result = await editor.execute({ ...action, path: readmePath });
        assert.ok(!result.is_error, 'the built-in file editor must succeed');
        return result;
      }),
    });
    const terminal = TerminalTool.create({ workingDir: workspace });
    const boundedTerminal = new ToolDefinition({
      name: terminal.name, description: terminal.description, inputSchema: terminal.inputSchema, outputSchema: terminal.outputSchema,
      executor: async action => checkedTool(async () => {
        assert.ok(stage === 'parallel', 'directory reads belong to the parallel phase');
        const expected = expectedListings.get(action.command);
        assert.ok(expected !== undefined && !action.is_input && !action.reset, 'only the two requested directory reads are allowed');
        assert.ok(!commands.includes(action.command), 'each directory must be read exactly once');
        commands.push(action.command);
        started += 1;
        if (started === 2) bothStarted();
        // Both real built-in tool executions start before either returns an observation.
        const result = await terminal.execute({ ...action, timeout: 10 });
        assert.ok(!result.is_error && result.exit_code === 0, 'the real directory command must succeed');
        assert.deepEqual(result.text.trimEnd().split('\n').sort(), expected, 'directory output must match the real repo snapshot');
        await toolsReleased;
        signal.throwIfAborted();
        return result;
      }),
    });
    const makeAgent = () => new Agent({
      llm, tools: [boundedEditor, boundedTerminal, FinishTool.create()], toolConcurrencyLimit: 2,
      systemPrompt: `You are testing the OpenHands SDK in its own repository snapshot. Working directory: ${workspace}. Follow the user's exact tool instructions. Use file_editor for README reads/edits. Complete each task with finish unless the user explicitly requests ordinary assistant text without tools; then follow that request.`,
    });
    const conversation = new LocalConversation({ agent: makeAgent(), maxIterations: 6 });
    const run = async () => {
      activeRun = conversation.run(); await waitFor(activeRun, signal); activeRun = undefined;
      if (toolFailure !== undefined) throw toolFailure;
    };
    regressionPhase = 'read';
    conversation.sendMessage(`Read the entire README with file_editor. Do not change it. Then call finish with message README-READ.\nREADME path: ${readmePath}`);
    await run();
    assert.ok(reads > 0, 'the model must actually read the README');
    assert.equal(edits, 0, 'the read phase must not edit the README');
    assert.ok(await readFile(readmePath, 'utf8') === originalReadme, 'the read phase must preserve the file');
    assertFinish(conversation.state.events, 'README-READ');

    stage = 'edit';
    regressionPhase = 'edit';
    conversation.sendMessage(`In the README you just read, use file_editor str_replace to replace the exact word ${OLD_WORD} with ${NEW_WORD}. Change nothing else. Then call finish with message README-EDITED.`);
    await run();
    assert.ok(Number(edits) === 1 && await readFile(readmePath, 'utf8') === editedReadme, 'the README must differ by exactly the chosen replacement');
    assertFinish(conversation.state.events, 'README-EDITED');

    stage = 'parallel';
    regressionPhase = 'parallel';
    const parallelStart = conversation.state.events.length;
    conversation.sendMessage('Read the src and examples subdirectories of your current repository using exactly two parallel terminal tool calls in one response: command "ls -1 src" and command "ls -1 examples". Do not combine them into one shell command, and do not call finish in that response. Wait for both tool results and the next user instruction.');
    activeRun = conversation.run();
    try {
      await waitFor(Promise.race([parallelStarted, activeRun.then(() => { throw new Error('Agent stopped without starting both parallel tools'); })]), signal);
      const actions = conversation.state.events.slice(parallelStart).filter(isTerminalAction);
      assert.ok(actions.length === 2 && actions[0]!.llm_response_id === actions[1]!.llm_response_id,
        'the LLM must request both directory reads in the same completion');
      callIds = actions.map(action => action.tool_call_id);
      assert.ok(new Set(callIds).size === 2, 'parallel tool calls must have distinct IDs');
      assert.ok(!conversation.state.events.slice(parallelStart).some(event => event.kind === 'ObservationEvent'), 'inject input before any batch result is persisted');
      await conversation.sendMessageAsync(FINISH_INPUT);
      injected = true;
    } finally { releaseTools(); }
    await waitFor(activeRun, signal);
    activeRun = undefined;
    if (toolFailure !== undefined) throw toolFailure;
    assert.ok(conversation.state.executionStatus === 'finished', 'the parallel continuation must finish');
    assertFinish(conversation.state.events.slice(parallelStart));
    assert.ok(wireRequestsChecked > 0, 'the provider must receive a real post-tool continuation request');
    assert.ok(started === 2, 'both directory tools must execute exactly once');
    assertDurableOverlap(conversation.state.events.slice(parallelStart), callIds);
    assertAccounting(conversation, responses);

    stage = 'plain';
    regressionPhase = 'plain';
    const plainStart = conversation.state.events.length;
    conversation.sendMessage(`For this turn only, reply with ordinary assistant text exactly ${PLAIN_REPLY}. Do not call any tools on this turn.`);
    activeRun = conversation.run();
    let lateInput: Event;
    try {
      await waitFor(Promise.race([plainRequestStarted, activeRun.then(() => { throw new Error('Agent stopped before the plain request started'); })]), signal);
      lateInput = await conversation.sendMessageAsync(PLAIN_INPUT);
      plainInjected = true;
    } finally { releasePlainResponse(); }
    await waitFor(activeRun, signal);
    activeRun = undefined;
    const plainEvents = conversation.state.events.slice(plainStart);
    const arrivalIndex = plainEvents.findIndex(event => event.id === lateInput.id);
    const replyIndex = plainEvents.findIndex(event => event.kind === 'MessageEvent' && event.source === 'agent'
      && event.llm_message.content.some(content => content.type === 'text' && content.text === PLAIN_REPLY));
    assert.ok(arrivalIndex >= 0 && replyIndex > arrivalIndex, 'durable history must retain late input before the in-flight plain reply');
    assert.ok(conversation.lastStepUserMessageId !== lateInput.id, 'the original plain request must not claim to have consumed later input');
    assert.ok(!plainEvents.some(event => event.kind === 'ActionEvent'), 'the plain-response regression needs an actual ordinary assistant reply');
    stage = 'plain-followup';
    // Scheduling is the host's responsibility: LocalConversation correctly
    // stopped at the plain reply, so explicitly run the still-unconsumed input.
    conversation.state.executionStatus = 'idle';
    await run();
    assert.ok(conversation.lastStepUserMessageId === lateInput.id, 'the follow-up must consume the actual queued user event');
    assertFinish(conversation.state.events.slice(plainStart), 'INFLIGHT-FINISHED');
    assert.ok(plainResponseWireRequestsChecked > 0, 'the real provider must see the causal plain-response continuation');

    stage = 'restore';
    regressionPhase = 'restore';
    const beforeRestore = JSON.stringify(conversation.state.events);
    const beforeMetrics = metricsSnapshot(conversation.state.stats);
    const restored = new LocalConversation({ agent: makeAgent(), state: restoreConversationState(JSON.parse(beforeRestore) as Event[]).state, maxIterations: 3 });
    assert.deepEqual(metricsSnapshot(restored.state.stats), beforeMetrics, 'restoration must preserve exact accumulated usage');
    restored.sendMessage('After restoring this conversation, do not repeat any completed file or terminal tools. Call finish with exactly README-RESTORED.');
    activeRun = restored.run();
    await waitFor(activeRun, signal);
    activeRun = undefined;
    assertFinish(restored.state.events, 'README-RESTORED');
    assertAccounting(restored, responses);
    assert.ok(JSON.stringify(conversation.state.events) === beforeRestore, 'restored continuation must not mutate the original history');
    assert.ok(started === 2 && Number(edits) === 1 && await readFile(readmePath, 'utf8') === editedReadme, 'restore must not repeat completed effects');
    return {
      profileId: options.profile.profileId, requestedModel: options.profile.model, sourceCommit,
      returnedModels: [...new Set(responses.flatMap(response => response.model === undefined ? [] : [response.model]))],
      requests, recordedCompletions: metricsSnapshot(restored.state.stats).coverage.completion_count,
      parallelToolExecutions: started, wireRequestsChecked, plainResponseWireRequestsChecked,
      checks: ['read-readme', 'exact-word-edit', 'parallel-real-directories', 'concurrent-durable-arrival', 'wire-results-before-input', 'finish-tool', 'inflight-plain-response-causality', 'restore-without-replay', 'usage-accounting'],
    };
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { regressionPhase });
    throw error;
  } finally {
    controller.abort();
    releaseTools();
    releasePlainResponse();
    // A gate failure must not leave tool effects running after its workspace is deleted.
    if (activeRun !== undefined) await activeRun.catch(() => {});
    clearTimeout(timer);
    await rm(scratch, { recursive: true, force: true });
  }
}

function isTerminalAction(event: Event): event is ActionEvent { return event.kind === 'ActionEvent' && event.tool_name === 'terminal'; }

function assertFinish(events: readonly Event[], expected?: string): void {
  const action = events.filter((event): event is ActionEvent => event.kind === 'ActionEvent' && event.tool_name === 'finish').at(-1);
  assert.ok(action !== undefined, 'a finish tool action is required; ordinary assistant text is insufficient');
  if (expected !== undefined) assert.ok(action.action.message === expected, 'finish must contain the exact requested answer');
  assert.ok(events.some(event => event.kind === 'ObservationEvent' && event.tool_name === 'finish'
    && event.action_id === action.id && event.tool_call_id === action.tool_call_id && event.observation.is_error !== true),
  'finish needs a successful observation linked to its actual call');
  assert.ok(!events.some(event => event.kind === 'AgentErrorEvent' || event.kind === 'ConversationErrorEvent'), 'conversation must contain no tool or runtime errors');
}

function assertDurableOverlap(events: readonly Event[], ids: readonly string[]): void {
  const arrival = events.findIndex(event => event.kind === 'MessageEvent' && event.source === 'user'
    && event.llm_message.content.some(content => content.type === 'text' && content.text === FINISH_INPUT));
  assert.ok(arrival >= 0, 'literal concurrent message must be persisted');
  for (const id of ids) {
    const action = events.findIndex(event => event.kind === 'ActionEvent' && event.tool_call_id === id);
    const results = events.flatMap((event, index) => event.kind === 'ObservationEvent' && event.tool_call_id === id ? [{ event, index }] : []);
    assert.ok(action >= 0 && action < arrival && results.length === 1 && arrival < results[0]!.index,
      'durable order must retain action, concurrent input, observation');
    assert.ok(results[0]!.event.action_id === events[action]!.id && results[0]!.event.observation.is_error !== true,
      'each successful directory result must link to its actual action');
  }
}

function assertAccounting(conversation: LocalConversation, responses: readonly LLMCompletionResponse[]): void {
  const records = Object.values(conversation.state.stats.usage_to_metrics).flatMap(metric => metric.records);
  assert.ok(records.length === responses.length, 'one accounting record is required per real Agent completion');
  assert.ok(new Set(records.map(record => record.record_id)).size === records.length, 'accounting identities must be local and unique');
  for (const [index, record] of records.entries()) {
    const response = responses[index]!;
    assert.ok(record.response_id === (response.responseId ?? null), 'accounting must preserve the provider response identity');
    assert.deepEqual(record.usage, response.usage, 'persisted usage must exactly match the native client completion');
    if (response.model !== undefined) assert.ok(record.model === response.model, 'accounting must preserve the serving model');
  }
}

async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Live conversation deadline or cancellation reached')); });
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
