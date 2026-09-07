import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_TOOLS,
  FinishTool,
  ThinkTool,
  finishActionSchema,
  thinkActionSchema,
} from '../builtins.js';
import { resolveTool } from '../index.js';

describe('built-in tools', () => {
  it('creates default built-ins with safe annotations', () => {
    for (const createTool of BUILT_IN_TOOLS) {
      const tool = createTool();

      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.executor).toBeDefined();
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('FinishTool validates its message and returns it as an observation', async () => {
    const tool = FinishTool.create();

    expect(tool.name).toBe('finish');
    expect(tool.toMcpTool().inputSchema.properties).toHaveProperty('message');
    await expect(tool.execute({ message: 'All done.' })).resolves.toEqual({ text: 'All done.', is_error: false });
    expect(() => finishActionSchema.parse({})).toThrow();
  });

  it('ThinkTool logs a thought without changing state', async () => {
    const tool = ThinkTool.create();

    expect(tool.name).toBe('think');
    expect(tool.toMcpTool().inputSchema.properties).toHaveProperty('thought');
    await expect(tool.execute({ thought: 'Try the simplest fix first.' })).resolves.toEqual({
      text: 'Your thought has been logged.',
      is_error: false,
    });
    expect(() => thinkActionSchema.parse({ thought: 12 })).toThrow();
  });

  it('resolves built-ins by tool name through the global registry without explicit registration', () => {
    const [finish] = resolveTool({ name: 'finish' });
    const [think] = resolveTool({ name: 'think' });

    expect(finish?.name).toBe('finish');
    expect(think?.name).toBe('think');
  });
});
