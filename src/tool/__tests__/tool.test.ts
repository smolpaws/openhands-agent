import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ToolDefinition,
  ToolRegistry,
  toolAnnotationsSchema,
  toolSpecSchema,
  type ToolExecutor,
} from '../index.js';

const actionSchema = z
  .object({
    command: z.string().describe('Command to execute'),
    optional_field: z.string().nullable().default(null).describe('Optional field'),
    nested: z.record(z.string(), z.unknown()).default({}).describe('Nested object'),
    array_field: z.array(z.number()).default([]).describe('Array field'),
  })
  .strict();

const observationSchema = z
  .object({
    result: z.string(),
    extra_field: z.string().nullable().default(null),
  })
  .strict();

describe('ToolDefinition', () => {
  it('exports MCP and Responses tool schemas from zod input schemas', () => {
    const tool = new ToolDefinition({
      name: 'mock_test',
      description: 'A test tool',
      inputSchema: actionSchema,
      outputSchema: observationSchema,
      annotations: toolAnnotationsSchema.parse({ title: 'Mock Test', readOnlyHint: true }),
    });

    const mcpTool = tool.toMcpTool();
    expect(mcpTool.name).toBe('mock_test');
    expect(mcpTool.description).toBe('A test tool');
    expect(mcpTool.annotations?.readOnlyHint).toBe(true);
    expect(mcpTool.inputSchema.type).toBe('object');
    expect(mcpTool.inputSchema.properties).toHaveProperty('command');
    expect(mcpTool.inputSchema.properties).toHaveProperty('array_field');
    expect(mcpTool.outputSchema?.type).toBe('object');

    const responsesTool = tool.toResponsesTool();
    expect(responsesTool).toMatchObject({ type: 'function', name: 'mock_test', strict: false });
    expect(responsesTool.parameters.type).toBe('object');
  });

  it('validates input, executes, and validates output', async () => {
    const executor: ToolExecutor<z.infer<typeof actionSchema>, z.infer<typeof observationSchema>> = async (action) => ({
      result: `Processed: ${action.command}`,
    });
    const tool = new ToolDefinition({
      name: 'mock_test',
      description: 'A test tool',
      inputSchema: actionSchema,
      outputSchema: observationSchema,
      executor,
    });

    await expect(tool.execute({ command: 'test_command' })).resolves.toEqual({
      result: 'Processed: test_command',
      extra_field: null,
    });
    await expect(tool.execute({ command: 123 })).rejects.toThrow();
  });

  it('throws clearly when no executor is present', async () => {
    const tool = new ToolDefinition({ name: 'mock_test', description: 'A test tool', inputSchema: actionSchema });

    await expect(tool.execute({ command: 'test' })).rejects.toThrow("Tool 'mock_test' has no executor");
  });
});

describe('ToolRegistry', () => {
  it('resolves registered tool instances and rejects params for instances', () => {
    const registry = new ToolRegistry();
    const tool = new ToolDefinition({ name: 'say_hello', description: 'Says hello', inputSchema: actionSchema });

    registry.register('say_hello', tool);

    expect(registry.listRegisteredTools()).toEqual(['say_hello']);
    expect(registry.resolve(toolSpecSchema.parse({ name: 'say_hello' }))).toEqual([tool]);
    expect(() => registry.resolve(toolSpecSchema.parse({ name: 'say_hello', params: { greeting: 'Howdy' } }))).toThrow();
  });

  it('resolves factory registrations with params', async () => {
    const registry = new ToolRegistry();
    registry.registerFactory('say_configurable_hello', (params) => {
      const greeting = typeof params.greeting === 'string' ? params.greeting : 'Hello';
      const punctuation = typeof params.punctuation === 'string' ? params.punctuation : '!';
      return [
        new ToolDefinition({
          name: 'say_configurable_hello',
          description: `${greeting}${punctuation}`,
          inputSchema: z.object({ name: z.string() }).strict(),
          outputSchema: z.object({ message: z.string() }).strict(),
          executor: async (action) => ({ message: `${greeting}, ${action.name}${punctuation}` }),
        }),
      ];
    });

    const [tool] = registry.resolve(
      toolSpecSchema.parse({ name: 'say_configurable_hello', params: { greeting: 'Howdy', punctuation: '?' } }),
    );

    expect(tool?.description).toBe('Howdy?');
    await expect(tool?.execute({ name: 'Alice' })).resolves.toEqual({ message: 'Howdy, Alice?' });
  });

  it('filters unusable tools and errors for unknown tools', () => {
    const registry = new ToolRegistry();
    registry.register('usable', new ToolDefinition({ name: 'usable', description: 'ok', inputSchema: z.object({}).strict() }));
    registry.register('unusable', new ToolDefinition({ name: 'unusable', description: 'no', inputSchema: z.object({}).strict(), usable: false }));

    expect(registry.listUsableTools()).toEqual(['usable']);
    expect(() => registry.resolve({ name: 'missing' })).toThrow("Unknown tool: missing");
  });
});
