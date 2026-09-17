import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../agent.js';
import { LocalConversation } from '../../conversation/local-conversation.js';
import { ConversationState } from '../../conversation/state.js';
import { LLMSummarizingCondenser } from '../../context/llm-summarizing-condenser.js';
import { View } from '../../context/view.js';
import { actionEventSchema, messageEventSchema, observationEventSchema, type Event } from '../../event/index.js';
import { llmProfileSchema, messageSchema, type Message } from '../../llm/index.js';
import { LLMContextWindowExceedError } from '../../llm/exceptions.js';
import { FinishTool } from '../../tool/builtins.js';
import { ToolDefinition } from '../../tool/index.js';

const profile = llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'fixture' });
const summaryProfile = llmProfileSchema.parse({ ...profile, profileId: 'summary' });
const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: text } });
const summaryClient = () => ({ profile: summaryProfile, complete: vi.fn(async () => ({ responseId: 'summary-id', usage: { promptTokens: 10, completionTokens: 5 }, message: messageSchema.parse({ role: 'assistant', content: 'Earlier work completed.' }) })) });
const toolResponse = (call: number, tool: string, args: unknown) => ({ responseId: `response-${call}`, usage: { promptTokens: 20, completionTokens: 5 }, message: messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: `call-${call}`, name: tool, arguments: JSON.stringify(args), origin: 'completion' }] }) });

// Adapt pinned c03_delayed_condensation.py with a real continuous signed tool loop,
// rather than mocking the range selector. A completed loop makes a later cut available.
describe('source integration condensation contracts', () => {
  it('c03 delays an unsafe soft cut and condenses on a later safe step', async () => {
    const history: Event[] = [];
    for (let i = 0; i < 4; i++) {
      const action = actionEventSchema.parse({ id: `action-${i}`, tool_name: 'terminal', tool_call_id: `call-${i}`, llm_response_id: `response-${i}`,
        action: { command: `echo ${i}` }, thought: [], thinking_blocks: i === 0 ? [{ type: 'thinking', thinking: 'Plan', signature: 'signed-initial-loop' }] : [],
        tool_call: { id: `call-${i}`, name: 'terminal', arguments: JSON.stringify({ command: `echo ${i}` }), origin: 'completion' } });
      history.push(action, observationEventSchema.parse({ action_id: action.id, tool_name: 'terminal', tool_call_id: action.tool_call_id, observation: { text: String(i), is_error: false } }));
    }
    const summary = summaryClient(), main = { profile, complete: vi.fn(async () => ({ usage: null, message: messageSchema.parse({ role: 'assistant', content: 'Loop complete.' }) })) };
    const conversation = new LocalConversation({ state: new ConversationState({ events: history }), agent: new Agent({ llm: main, condenser: new LLMSummarizingCondenser({ llm: summary, maxSize: 6, keepFirst: 1, minimumProgress: 0.2 }) }) });
    await conversation.run();
    expect(main.complete).toHaveBeenCalledTimes(1);
    expect(summary.complete).not.toHaveBeenCalled();
    expect(conversation.state.events.some(event => event.kind === 'Condensation')).toBe(false);
    // The protected prefix is longer than maxSize; require genuine event reduction
    // (20%) so replacing one event by one summary cannot spin at the default 10%.
    for (let i = 0; i < 4; i++) conversation.sendMessage(`Next task detail ${i}.`);
    await conversation.run();
    expect(summary.complete.mock.calls.length).toBeGreaterThan(0);
    expect(main.complete).toHaveBeenCalledTimes(2);
    expect(conversation.state.executionStatus).toBe('finished');
    expect(conversation.state.events.slice(0, history.length)).toEqual(history);
  });

  it.each(['tokens', 'events'] as const)('c04/c05 %s pressure produces actual summaries and tool continuation', async mode => {
    const summary = summaryClient(), executed: string[] = [];
    const terminal = new ToolDefinition({ name: 'terminal', description: 'Fixture echo tool', inputSchema: z.object({ command: z.string() }), executor: ({ command }) => {
      executed.push(command); return { text: `${command}\n${'Public context fixture. '.repeat(60)}`, is_error: false };
    } });
    const complete = vi.fn(async () => { const n = complete.mock.calls.length; return toolResponse(n, n % 2 ? 'terminal' : 'finish', n % 2 ? { command: `echo ${(n + 1) / 2}` } : { message: 'done' }); });
    const main = { profile, complete, getTokenCount: async (messages: readonly Message[]) => 40 + Math.ceil(JSON.stringify(messages).length / 4) };
    const conversation = new LocalConversation({ agent: new Agent({ llm: main, tools: [terminal, FinishTool.create()], condenser: new LLMSummarizingCondenser({ llm: summary, maxSize: mode === 'events' ? 10 : 1000, maxTokens: mode === 'tokens' ? 700 : null, keepFirst: 1 }) }), maxIterations: 15 });
    for (let turn = 1; turn <= 3; turn++) { conversation.sendMessage(`Echo ${turn} and finish.`); await conversation.run(); }
    const condensations = conversation.state.events.filter(event => event.kind === 'Condensation');
    expect(condensations.length).toBeGreaterThan(0);
    expect(condensations.every(event => event.forgotten_event_ids.size > 0)).toBe(true);
    expect(summary.complete.mock.calls.length).toBe(condensations.length);
    expect(executed).toEqual(['echo 1', 'echo 2', 'echo 3']);
    expect(conversation.state.executionStatus).toBe('finished');
    expect(conversation.state.stats.usage_to_metrics.condenser?.records).toHaveLength(summary.complete.mock.calls.length);
    const lastCondensation = conversation.state.events.findLastIndex(event => event.kind === 'Condensation');
    expect(conversation.state.events.slice(lastCondensation + 1).some(event => event.kind === 'ActionEvent')).toBe(true);
  });

  it('c02 explicit hard reset then normal condensation retains the earlier summary', async () => {
    const summary = summaryClient();
    let calls = 0;
    const main = { profile, complete: vi.fn(async () => {
      calls++;
      return calls === 1 ? { usage: null, message: messageSchema.parse({ role: 'assistant', content: 'hello world' }) }
        : toolResponse(calls, calls % 2 === 0 ? 'terminal' : 'finish', calls % 2 === 0 ? { command: 'echo 1' } : { message: 'done' });
    }) };
    const terminal = new ToolDefinition({ name: 'terminal', description: 'Fixture echo', inputSchema: z.object({ command: z.string() }), executor: () => ({ text: '1', is_error: false }) });
    const conversation = new LocalConversation({ agent: new Agent({ llm: main, tools: [terminal, FinishTool.create()], condenser: new LLMSummarizingCondenser({ llm: summary, maxSize: 100, keepFirst: 4 }) }) });
    conversation.sendMessage('Echo hello world.');
    await conversation.run();
    await conversation.condense();
    const first = conversation.state.events.find(event => event.kind === 'Condensation')!;
    expect(first.summary_offset).toBe(0);
    for (let turn = 0; turn < 2; turn++) { conversation.sendMessage('Run echo 1 and finish.'); await conversation.run(); }
    await conversation.condense();
    const condensations = conversation.state.events.filter(event => event.kind === 'Condensation');
    expect(condensations).toHaveLength(2);
    expect(condensations[1]!.summary_offset).toBeGreaterThan(0);
    expect(condensations[1]!.forgotten_event_ids.has(`${first.id}-summary`)).toBe(false);
    expect(View.fromEvents(conversation.state.events).events.some(event => event.kind === 'CondensationSummaryEvent' && event.id === `${first.id}-summary`)).toBe(true);
    conversation.sendMessage('Continue once more.');
    await conversation.run();
    expect(conversation.state.executionStatus).toBe('finished');
    expect(summary.complete).toHaveBeenCalledTimes(2);
  });

  it('forced small-context overflow recovers through a request and independent summary, then completes', async () => {
    const summary = summaryClient();
    const complete = vi.fn(async (messages: readonly Message[]) => {
      const text = messages.flatMap(message => message.content).filter(item => item.type === 'text').map(item => item.text).join('');
      if (text.length > 250) throw new LLMContextWindowExceedError('Synthetic provider input limit exceeded');
      return toolResponse(complete.mock.calls.length, 'finish', { message: 'continued after reduction' });
    });
    const original = Array.from({ length: 6 }, (_, i) => user(`Task ${i}: ${'x'.repeat(90)}`));
    const conversation = new LocalConversation({ state: new ConversationState({ events: original }), agent: new Agent({ llm: { profile, complete }, tools: [FinishTool.create()], condenser: new LLMSummarizingCondenser({ llm: summary, maxSize: 1000, keepFirst: 0 }) }), maxIterations: 10 });
    await conversation.run();
    expect(conversation.state.events.filter(event => event.kind === 'CondensationRequest')).toHaveLength(1);
    expect(conversation.state.events.filter(event => event.kind === 'Condensation')).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(summary.complete).toHaveBeenCalledTimes(1);
    expect(conversation.state.executionStatus).toBe('finished');
    expect(View.fromEvents(conversation.state.events).length).toBeLessThan(original.length);
    expect(conversation.state.events.slice(0, original.length)).toEqual(original);
  });
});
