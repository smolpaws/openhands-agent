import { describe, expect, it, vi } from 'vitest';

import { textContent } from '../../llm/index.js';
import { CondenseTool, condenseActionSchema, condenseObservationSchema, type CondenseExecutionContext } from '../condense.js';
import { ToolRegistry } from '../index.js';

describe('CondenseTool opt-in host contract', () => {
  it('describes agent-controlled timing and exposes an optional future-self message', () => {
    const tool = CondenseTool.create();
    expect(tool.name).toBe('condense');
    expect(tool.usable).toBe(true);
    expect(tool.meta).toEqual({ smolpaws_agent_condense: true });
    expect(tool.description).toContain('You decide when');
    expect(tool.description).toContain('existing tools');
    expect(tool.description).toContain('only tool call');
    expect(tool.description).toContain('16,384');
    expect(tool.description).toContain('does not write memory');
    expect(tool.toResponsesTool().parameters).toMatchObject({
      type: 'object',
      properties: { message_to_future_self: { type: 'string', maxLength: 16384 } },
      additionalProperties: false,
    });
    expect(tool.toResponsesTool().parameters.required ?? []).toEqual([]);
    expect(() => new ToolRegistry().resolve({ name: 'condense', params: {} })).toThrow('Unknown tool: condense');
  });

  it('keeps an omitted note absent and supplies observation defaults', () => {
    expect(condenseActionSchema.parse({})).toEqual({});
    expect(condenseObservationSchema.parse({})).toEqual({
      kind: 'CondenseObservation', content: [], is_error: false, request_id: null, message_to_future_self: null,
    });
  });

  it.each(['', '  My notes.\n\n  Keep these spaces.\t', '😀'.repeat(8192)])(
    'passes valid future-self text unchanged to the host and its observation', async text => {
      const result = condenseObservationSchema.parse({
        content: [textContent('Request prepared.')], request_id: 'request-1', message_to_future_self: text,
      });
      const requestCondensation = vi.fn(async () => result);
      const context: CondenseExecutionContext = { requestCondensation };
      const observation = await CondenseTool.create().execute({ message_to_future_self: text }, context);
      expect(requestCondensation).toHaveBeenCalledExactlyOnceWith({ message_to_future_self: text });
      expect(observation).toEqual(result);
      expect(observation.message_to_future_self).toBe(text);
    },
  );

  it('delegates an omitted message once to a synchronous host callback', async () => {
    const result = condenseObservationSchema.parse({ request_id: 'request-2' });
    const requestCondensation = vi.fn(() => result);
    await expect(CondenseTool.create().execute({}, { requestCondensation })).resolves.toEqual(result);
    expect(requestCondensation).toHaveBeenCalledExactlyOnceWith({});
  });

  it.each([
    null,
    { message_to_future_self: null },
    { message_to_future_self: 3 },
    { message_to_future_self: 'x'.repeat(16385) },
    { message_to_future_self: '😀'.repeat(8192) + 'x' },
    { message_to_future_self: 'notes', extra: true },
  ])('rejects invalid actions before any host callback', async action => {
    const requestCondensation = vi.fn();
    await expect(CondenseTool.create().execute(action, { requestCondensation })).rejects.toThrow();
    expect(requestCondensation).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { requestCondensation: true }, []])(
    'returns a typed error without active condensation context', async context => {
      const observation = await CondenseTool.create().execute({ message_to_future_self: 'keep me' }, context);
      expect(observation).toMatchObject({
        kind: 'CondenseObservation', is_error: true, request_id: null, message_to_future_self: 'keep me',
      });
      expect(observation.content[0]?.text).toBe('Cannot request context condensation without an active agent-reset context.');
      expect(condenseObservationSchema.parse(observation)).toEqual(observation);
    },
  );

  it('validates host observations without retrying the callback', async () => {
    const requestCondensation = vi.fn(() => ({ kind: 'CondenseObservation', request_id: 17 }));
    await expect(CondenseTool.create().execute({}, { requestCondensation })).rejects.toThrow();
    expect(requestCondensation).toHaveBeenCalledOnce();
    expect(() => condenseObservationSchema.parse({ extra: true })).toThrow();
    expect(() => condenseObservationSchema.parse({ content: [{ type: 'image', image_urls: ['image'] }] })).toThrow();
  });

  it('propagates host persistence failures without claiming success or retrying', async () => {
    const failure = new Error('intent persistence failed');
    const requestCondensation = vi.fn(async () => { throw failure; });
    await expect(CondenseTool.create().execute({}, { requestCondensation })).rejects.toBe(failure);
    expect(requestCondensation).toHaveBeenCalledOnce();
  });
});
