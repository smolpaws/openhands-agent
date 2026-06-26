import { describe, expect, it } from 'vitest';

import { textContent, type Message } from '../../llm/index.js';
import { TestLLM, TestLLMExhaustedError } from '../index.js';

function assistantMessage(text: string): Message {
  return {
    role: 'assistant',
    content: [textContent(text)],
    tool_calls: null,
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}

describe('TestLLM', () => {
  it('returns scripted messages as LLM responses', async () => {
    const llm = TestLLM.fromMessages([assistantMessage('first'), assistantMessage('second')]);

    await expect(llm.complete([{ role: 'user', content: [textContent('hello')] }])).resolves.toMatchObject({
      message: { role: 'assistant', content: [textContent('first')] },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    await expect(llm.complete([{ role: 'user', content: [textContent('again')] }])).resolves.toMatchObject({
      message: { role: 'assistant', content: [textContent('second')] },
    });

    expect(llm.callCount).toBe(2);
    expect(llm.remainingResponses).toBe(0);
  });

  it('raises scripted errors and tracks calls', async () => {
    const scripted = new Error('context too long');
    const llm = TestLLM.fromMessages([scripted, assistantMessage('unused')]);

    await expect(llm.complete([])).rejects.toThrow('context too long');

    expect(llm.callCount).toBe(1);
    expect(llm.remainingResponses).toBe(1);
  });

  it('raises a clear exhaustion error without incrementing call count', async () => {
    const llm = TestLLM.fromMessages([assistantMessage('only')]);

    await llm.complete([]);
    await expect(llm.complete([])).rejects.toBeInstanceOf(TestLLMExhaustedError);

    expect(llm.callCount).toBe(1);
    expect(llm.remainingResponses).toBe(0);
  });

  it('accepts full scripted completion responses', async () => {
    const message = assistantMessage('with raw');
    const llm = TestLLM.fromResponses([{ message, usage: null, raw: { id: 'raw-1' } }]);

    await expect(llm.complete([])).resolves.toEqual({ message, usage: null, raw: { id: 'raw-1' } });
  });
});
