import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { llmConvertibleEventSchema } from '../../event/index.js';
import { renderCondenserEvent, renderSummarizingPrompt, truncateCondenserEvent } from '../condenser-prompt.js';
import oracle from './fixtures/python-condenser-oracle.json';

// Generated from real pinned Python event renderers and the original Jinja template.
describe('pinned Python summarizer prompt oracle', () => {
  it('is bound to the shared manifest pin', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../transpile/upstream.json', import.meta.url), 'utf8'));
    expect(oracle.upstream_commit).toBe(manifest.commit);
  });
  it.each(oracle.cases)('$name preserves source event preview', ({ event: raw, text }) => {
    const event = llmConvertibleEventSchema.parse(raw);
    expect(renderCondenserEvent(event)).toBe(text);
  });
  it('renders the original prompt with exact whitespace and no opaque signature payloads', () => {
    expect(renderSummarizingPrompt(oracle.cases.map(test => test.text))).toBe(oracle.prompt);
    expect(oracle.prompt).not.toContain('opaque-signature');
    expect(oracle.prompt).not.toContain('private thinking');
  });
  it.each(oracle.truncation)('ports middle clipping by Unicode code points with limit $limit', ({ input, limit, text }) => {
    expect(truncateCondenserEvent(input, limit)).toBe(text);
  });
});

it('renders native switch_llm raw arguments with the pinned builtin class name', () => {
  const event = llmConvertibleEventSchema.parse({ kind: 'ActionEvent', source: 'agent', tool_name: 'switch_llm', action: { llm_name: 'next' },
    tool_call_id: 'native-call', llm_response_id: 'native-response', thought: [],
    tool_call: { id: 'native-call', name: 'switch_llm', arguments: '{"llm_name":"next"}', origin: 'completion' } });
  expect(renderCondenserEvent(event)).toBe('ActionEvent (agent)\n  Thought: \n  Action: SwitchLLMAction');
});
