import { describe, expect, it, vi } from 'vitest';

import { Agent } from '../agent.js';
import { ConversationState } from '../../conversation/state.js';
import { AgentResetCondenser } from '../../context/agent-reset-condenser.js';
import { LLMSummarizingCondenser } from '../../context/llm-summarizing-condenser.js';
import { messageEventSchema, type Event } from '../../event/index.js';
import { llmProfileSchema, messageSchema } from '../../llm/index.js';
import { OpenAIResponsesClient } from '../../llm/openai.js';
import type { FetchLike } from '../../llm/client.js';

// Main's real history contains both images and encrypted Responses reasoning.
// A single opaque item currently makes the entire input count unavailable, even
// when the independently countable text alone already exceeds the saved budget.
// Exercise the native counter, profile budget, wire adapter and real Agent.step;
// only the external provider response is faked. No live history or credentials.
const profile = llmProfileSchema.parse({
  profileId: 'main', providerId: 'openai', model: 'gpt-5',
  openAiApiMode: 'responses', maxInputTokens: 256,
});
const user = (content: string) => messageEventSchema.parse({
  source: 'user', llm_message: { role: 'user', content },
});
const opaqueEvents = {
  image: () => messageEventSchema.parse({
    source: 'user', llm_message: { role: 'user', content: [
      { type: 'image', image_urls: ['https://example.test/fixture.png'] },
    ] },
  }),
  encrypted_reasoning: () => messageEventSchema.parse({
    source: 'agent', llm_message: { role: 'assistant', content: 'Earlier answer',
      responses_reasoning_item: { encrypted_content: 'synthetic-opaque-reasoning' } },
  }),
};
type Modality = keyof typeof opaqueEvents;

function fixture(modality?: Modality) {
  const fetch = vi.fn<FetchLike>(async () => ({
    ok: true, status: 200,
    json: async () => ({ id: 'response', model: 'gpt-5',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continued' }] }],
      usage: { input_tokens: 1200, output_tokens: 1, total_tokens: 1201 },
    }),
    text: async () => '',
  }));
  const main = new OpenAIResponsesClient(profile, 'fixture-key', fetch);
  const textEvents = Array.from({ length: 8 }, (_, i) => user(`Turn ${i}: ${'budget '.repeat(128)}`));
  const events: Event[] = [...textEvents];
  if (modality) events.splice(4, 0, opaqueEvents[modality]());
  const state = new ConversationState({ events });
  const summarize = vi.fn(async () => ({
    message: messageSchema.parse({ role: 'assistant', content: 'Earlier work.' }), usage: null,
  }));
  const summaryClient = { profile: { ...profile, profileId: 'summary' }, complete: summarize };
  return { main, fetch, textEvents, state, summarize, summaryClient };
}

async function assertVisibleTextExceedsBudget(f: ReturnType<typeof fixture>) {
  // This lower bound comes from text alone, not a guessed image/reasoning size.
  const count = await f.main.getTokenCount(f.textEvents.map(event => event.llm_message));
  expect(count).toBeGreaterThan(1000);
  expect(f.main.effectiveMaxInputTokens).toBe(256);
}

async function oldSummarizer(modality?: Modality) {
  const f = fixture(modality);
  await assertVisibleTextExceedsBudget(f);
  // Bootstrap an actual successful response: provider usage drives the next step.
  await new Agent({ llm: f.main, systemPrompt: 'Fixed identity', tools: [] }).step(f.state);
  f.fetch.mockClear();
  const agent = new Agent({ llm: f.main, systemPrompt: 'Fixed identity', tools: [],
    // Reproduce Main's older frozen cap being higher than its selected profile.
    condenser: new LLMSummarizingCondenser({ llm: f.summaryClient, maxTokens: 1000, keepFirst: 0 }),
  });
  await agent.step(f.state);
  // At this public boundary, budget pressure must condense before another main
  // request; assert the durable operation, not just counter internals.
  expect(f.state.events.filter(event => event.kind === 'Condensation')).toHaveLength(1);
  expect(f.summarize).toHaveBeenCalledOnce();
  expect(f.fetch).not.toHaveBeenCalled();
}

async function agentReset(modality?: Modality) {
  const f = fixture(modality);
  await assertVisibleTextExceedsBudget(f);
  // Bootstrap an actual successful response: provider usage drives the next step.
  await new Agent({ llm: f.main, systemPrompt: 'Fixed identity', tools: [] }).step(f.state);
  f.fetch.mockClear();
  await new Agent({ llm: f.main, systemPrompt: 'Fixed identity', tools: [],
    condenser: new AgentResetCondenser(),
    hardCondenser: new LLMSummarizingCondenser({ llm: f.summaryClient }),
  }).step(f.state);
  const warnings = f.state.events.filter(event => event.kind === 'ConversationStateUpdateEvent'
    && event.key === 'agent_context_warning');
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({ value: { input_limit: 256, threshold: 0.9 } });
  // Agent-reset is advisory: exceeding a local budget must not reset or block.
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(f.fetch.mock.calls[0]![1].body!).input).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'user', content: expect.arrayContaining([
      expect.objectContaining({ type: 'input_text', text: expect.stringContaining('Context warning:') }),
    ]) }),
  ]));
  expect(f.state.events.filter(event => event.kind === 'Condensation')).toHaveLength(0);
  expect(f.summarize).not.toHaveBeenCalled();
}

describe('configured input budget with opaque context', () => {
  it('old summarizer honors the smaller main-profile budget for text-only input', async () => {
    await oldSummarizer();
  });
  it('agent-reset warns for text-only input while allowing the main request', async () => {
    await agentReset();
  });
  it.each(['image', 'encrypted_reasoning'] as const)(
    'old summarizer must honor the configured budget despite %s', oldSummarizer,
  );
  it.each(['image', 'encrypted_reasoning'] as const)(
    'agent-reset must warn at the configured budget despite %s', agentReset,
  );
});
