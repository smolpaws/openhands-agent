#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createOpenAIResponsesClientFromProfile,
  llmProfileSchema,
  messageSchema,
  textContent,
  type FetchLike,
  type LLMCompletionResponse,
  type Message,
} from '@smolpaws/openhands-agent';

import { createExampleLlmSecretStore, providerApiKeyEnvName } from '../../examples/_shared/exampleProfile.js';

const MODEL = process.env.OPENAI_RESPONSES_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || process.env.LLM_MODEL?.trim() || 'gpt-5-mini';
const MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_RESPONSES_MAX_OUTPUT_TOKENS ?? 1024);
const MODE_FULL = 'full';
const MODE_MINIMAL = 'minimal';
const MODE_BOTH = 'both';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_ROOT = join(SCRIPT_DIR, '..', 'fixtures', 'openai-responses');

const profile = llmProfileSchema.parse({
  profileId: process.env.LLM_PROFILE?.trim() || 'live-openai-responses-reasoning',
  providerId: 'openai',
  model: MODEL,
  openAiApiMode: 'responses',
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  reasoningEffort: 'medium',
  reasoningSummary: 'detailed',
});
const maybeStore = createExampleLlmSecretStore(profile);
if (maybeStore === null) {
  console.log(`openai-responses-reasoning: set ${providerApiKeyEnvName(profile.providerId)} to run this live Responses reasoning test.`);
  process.exit(0);
}
const store = maybeStore;

const prompts = [
  'Say "hello world" exactly once. No other text.',
  'In 2-3 sentences, explain why "hello world" is a common first program.',
  'In 2-3 sentences, explain one practical lesson about testing APIs in stateless mode (store=false).',
] as const;

interface RunContext {
  readonly mode: string;
  readonly outDir: string;
  readonly rawReasoningById: Map<string, Record<string, unknown>>;
  turn: number;
}

const safeJson = (value: unknown) => JSON.stringify(value, null, 2);
const stableStringify = (value: unknown) => JSON.stringify(stableCopy(value), null, 2);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableCopy);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableCopy(value[key]);
    }
    return out;
  }
  return value;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 120) {
    return `<string len=${value.length} sha256=${sha256Hex(value).slice(0, 16)}>`;
  }
  if (Array.isArray(value)) {
    return `<array len=${value.length}>`;
  }
  if (isRecord(value)) {
    return `<object keys=${Object.keys(value).length}>`;
  }
  return value;
}

function diffJson(a: unknown, b: unknown, path = '$'): readonly Record<string, unknown>[] {
  if (Object.is(a, b)) {
    return [];
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return [{ path, a: summarizeValue(a), b: summarizeValue(b) }];
    }
    return Array.from({ length: Math.max(a.length, b.length) }).flatMap((_, index) => diffJson(a[index], b[index], `${path}[${index}]`));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) {
      return [{ path, a: summarizeValue(a), b: summarizeValue(b) }];
    }
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((key) => diffJson(a[key], b[key], `${path}.${key}`));
  }
  return [{ path, a: summarizeValue(a), b: summarizeValue(b) }];
}

function parseArgs(): { mode: string; outDir: string } {
  const args = process.argv.slice(2);
  let mode = MODE_BOTH;
  let outDir: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--out-dir') {
      outDir = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (!arg.startsWith('--')) {
      mode = arg.toLowerCase();
    }
  }
  return {
    mode: [MODE_FULL, MODE_MINIMAL, MODE_BOTH].includes(mode) ? mode : MODE_BOTH,
    outDir: outDir === null ? join(DEFAULT_OUT_ROOT, `run-${new Date().toISOString().replaceAll(':', '-')}`) : resolve(outDir),
  };
}

async function writeArtifact(path: string, value: unknown): Promise<void> {
  await writeFile(path, typeof value === 'string' ? value : stableStringify(value), 'utf8');
}

function makeFetch(context: RunContext): FetchLike {
  return async (url, init) => {
    let body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (context.mode === MODE_FULL) {
      body = replayFullReasoningItems(body, context.rawReasoningById);
    }
    await writeArtifact(join(context.outDir, `turn${context.turn}_request.json`), body);

    const response = await fetch(url, { ...init, body: JSON.stringify(body) });
    const responseText = await response.text();
    await writeArtifact(join(context.outDir, `turn${context.turn}_response.json`), responseText);
    return {
      ok: response.ok,
      status: response.status,
      async json() {
        return JSON.parse(responseText) as unknown;
      },
      async text() {
        return responseText;
      },
    };
  };
}

function replayFullReasoningItems(body: Record<string, unknown>, rawReasoningById: ReadonlyMap<string, Record<string, unknown>>): Record<string, unknown> {
  const input = Array.isArray(body.input) ? body.input : [];
  return {
    ...body,
    input: input.map((item) => {
      if (!isRecord(item) || item.type !== 'reasoning' || typeof item.id !== 'string') {
        return item;
      }
      return rawReasoningById.get(item.id) ?? item;
    }),
  };
}

function rawOutputItems(response: LLMCompletionResponse): readonly Record<string, unknown>[] {
  const raw = response.raw;
  if (!isRecord(raw) || !Array.isArray(raw.output)) {
    return [];
  }
  return raw.output.filter(isRecord);
}

function rawReasoningItems(response: LLMCompletionResponse): readonly Record<string, unknown>[] {
  return rawOutputItems(response).filter((item) => item.type === 'reasoning');
}

function summarizeReasoning(item: Record<string, unknown>): Record<string, unknown> {
  const encrypted = typeof item.encrypted_content === 'string' ? item.encrypted_content : null;
  return {
    id: typeof item.id === 'string' ? item.id : null,
    status: typeof item.status === 'string' ? item.status : null,
    summaryCount: Array.isArray(item.summary) ? item.summary.length : 0,
    contentCount: Array.isArray(item.content) ? item.content.length : 0,
    encrypted_content: encrypted === null ? null : `<redacted len=${encrypted.length}>`,
  };
}

async function runConversation(mode: string, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const context: RunContext = { mode, outDir, rawReasoningById: new Map(), turn: 0 };
  const client = await createOpenAIResponsesClientFromProfile(profile, store, { fetch: makeFetch(context) });
  const messages: Message[] = [];
  const summaries: Record<string, unknown>[] = [];

  for (let index = 0; index < prompts.length; index += 1) {
    context.turn = index + 1;
    messages.push(messageSchema.parse({ role: 'user', content: [textContent(prompts[index])] }));
    const response = await client.complete(messages);
    const reasoningItems = rawReasoningItems(response);
    const replayedItems = reasoningItems.map((item) => {
      if (typeof item.id === 'string') {
        context.rawReasoningById.set(item.id, item);
      }
      return response.message.responses_reasoning_item;
    });

    await writeArtifact(join(outDir, `turn${context.turn}_reasoning_received.json`), reasoningItems);
    await writeArtifact(join(outDir, `turn${context.turn}_reasoning_replay.json`), replayedItems);
    await writeArtifact(
      join(outDir, `turn${context.turn}_reasoning_diff.json`),
      reasoningItems.map((item, itemIndex) => ({
        id: typeof item.id === 'string' ? item.id : null,
        differences: diffJson(item, replayedItems[itemIndex]),
      })),
    );

    summaries.push({
      turn: context.turn,
      textLength: response.message.content.map((content) => (content.type === 'text' ? content.text : '')).join('\n').length,
      reasoningItems: reasoningItems.map(summarizeReasoning),
      replayHasEncryptedContent: response.message.responses_reasoning_item?.encrypted_content !== null,
    });
    messages.push(response.message);
  }

  await writeArtifact(join(outDir, 'summary.json'), { mode, model: profile.model, turns: summaries });
  console.log(`openai-responses-reasoning: completed mode=${mode}; artifacts=${outDir}`);
}

const { mode, outDir } = parseArgs();
await mkdir(outDir, { recursive: true });
await writeArtifact(join(outDir, 'run-meta.json'), {
  created_at: new Date().toISOString(),
  model: profile.model,
  store: false,
  include: ['reasoning.encrypted_content'],
  reasoning: { effort: profile.reasoningEffort, summary: profile.reasoningSummary },
  max_output_tokens: profile.maxOutputTokens,
});

if (mode === MODE_BOTH) {
  await runConversation(MODE_FULL, join(outDir, MODE_FULL));
  await runConversation(MODE_MINIMAL, join(outDir, MODE_MINIMAL));
} else {
  await runConversation(mode, join(outDir, mode));
}
