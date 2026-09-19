import { expect, test } from 'vitest';
import { llmProfileSchema } from '../index.js';
import { buildChatCompletionsBody, buildOpenAIResponsesBody } from '../openai.js';

const base = { profileId: 'astra', providerId: 'litellm_proxy', model: 'openai/gpt-6-astra' };
test('explicit verbosity survives profile persistence and reaches both OpenAI wire formats', () => {
  for (const verbosity of ['low', 'medium', 'high']) {
    const profile = llmProfileSchema.parse(JSON.parse(JSON.stringify({ ...base, verbosity })));
    expect(buildChatCompletionsBody(profile, [])).toHaveProperty('verbosity', verbosity);
    expect(buildOpenAIResponsesBody(profile, [])).toHaveProperty('text.verbosity', verbosity);
  }
});
test('omission preserves existing profiles and requests; invalid values are rejected', () => {
  const profile = llmProfileSchema.parse(base);
  expect(profile).not.toHaveProperty('verbosity');
  expect(buildChatCompletionsBody(profile, [])).not.toHaveProperty('verbosity');
  expect(buildOpenAIResponsesBody(profile, [])).not.toHaveProperty('text');
  for (const verbosity of ['', 'minimal', null, 1]) expect(llmProfileSchema.safeParse({ ...base, verbosity }).success).toBe(false);
});
