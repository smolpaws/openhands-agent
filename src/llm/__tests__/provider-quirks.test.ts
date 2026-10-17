import { describe, expect, it } from 'vitest';
import { llmProfileSchema } from '../index.js';
import { isReasoningModel } from '../provider-quirks.js';

const profileFor = (model: string) =>
  llmProfileSchema.parse({ profileId: 'test', providerId: 'deepseek', model });

describe('isReasoningModel', () => {
  it.each(['deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash'])(
    'recognizes %s as a reasoning model (PORT: deepseek-v4.1-flash registration)',
    (model) => {
      expect(isReasoningModel(profileFor(model))).toBe(true);
    },
  );

  it('does not flag non-reasoning deepseek chat models', () => {
    expect(isReasoningModel(profileFor('deepseek-chat'))).toBe(false);
  });
});
