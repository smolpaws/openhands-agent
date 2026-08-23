import { describe, expect, it } from 'vitest';

import { MCPTimeoutError, MCPToolAction, MCPToolDefinition, MCPToolExecutor, MCPToolObservation, toCamelCase } from '../index.js';

describe('MCP wrappers', () => {
  it('wraps tool arguments and renders observations', () => {
    const action = new MCPToolAction({ query: 'openhands' });
    const observation = MCPToolObservation.fromCallToolResult('search', { isError: false, content: [{ type: 'text', text: '{"ok":true}' }, { type: 'image', mimeType: 'image/png', data: 'abc' }] });

    expect(action.toMcpArguments()).toEqual({ query: 'openhands' });
    expect(observation.content).toHaveLength(3);
    expect(observation.visualize()).toContain("[MCP Tool 'search' Observation]");
  });

  it('creates tool definitions and validates required arguments', async () => {
    const calls: unknown[] = [];
    const client = { isConnected: () => true, callTool: async (name: string, args: unknown) => { calls.push([name, args]); return { isError: false, content: [{ type: 'text', text: 'ok' }] }; } };
    const tool = MCPToolDefinition.create({ name: 'web-search', description: 'Search', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } }, client)[0];

    expect(tool?.name).toBe('web-search');
    expect(tool?.toOpenAiTool()).toMatchObject({ type: 'function', function: { name: 'web-search' } });
    expect(tool?.actionFromArguments({ query: 'cats', optional: null }).toMcpArguments()).toEqual({ query: 'cats' });
    expect(tool?.actionFromArguments({})).toMatchObject({ data: {} });
    const observation = await tool?.executor.execute(new MCPToolAction({ query: 'cats' }));

    expect(calls).toEqual([['web-search', { query: 'cats' }]]);
    expect(observation?.is_error).toBe(false);
  });

  it('returns error observations when client is disconnected', async () => {
    const executor = new MCPToolExecutor('tool', { isConnected: () => false, callTool: async () => ({ isError: false, content: [] }) });

    await expect(executor.execute(new MCPToolAction())).resolves.toMatchObject({ is_error: true, tool_name: 'tool' });
  });

  it('reconnects once when the session is lost before calling the tool', async () => {
    let connected = false;
    const calls: string[] = [];
    const client = {
      closed: false,
      isConnected: () => connected,
      connect: async () => { calls.push('connect'); connected = true; },
      callTool: async (name: string) => { calls.push(`call:${name}`); return { isError: false, content: [{ type: 'text', text: 'ok' }] }; },
    };
    const executor = new MCPToolExecutor('tool', client);

    const observation = await executor.execute(new MCPToolAction());

    expect(observation.is_error).toBe(false);
    expect(calls).toEqual(['connect', 'call:tool']);
  });

  it('does not reconnect a closed client', async () => {
    const calls: string[] = [];
    const client = {
      closed: true,
      isConnected: () => false,
      connect: async () => { calls.push('connect'); },
      callTool: async () => ({ isError: false, content: [] }),
    };
    const executor = new MCPToolExecutor('tool', client);

    const observation = await executor.execute(new MCPToolAction());

    expect(observation.is_error).toBe(true);
    expect(observation.visualize()).toContain('closed and cannot be reconnected');
    expect(calls).toEqual([]);
  });

  it('returns an error observation when reconnection fails', async () => {
    const client = {
      closed: false,
      isConnected: () => false,
      connect: async () => { throw new Error('connect refused'); },
      callTool: async () => ({ isError: false, content: [] }),
    };
    const executor = new MCPToolExecutor('tool', client);

    const observation = await executor.execute(new MCPToolAction());

    expect(observation.is_error).toBe(true);
    expect(observation.visualize()).toContain('Reconnection attempt failed');
  });

  it('converts names and exposes timeout errors', () => {
    expect(toCamelCase('web-search tool')).toBe('WebSearchTool');
    expect(new MCPTimeoutError('timed out', 30, { mcpServers: {} })).toMatchObject({ timeout: 30 });
  });
});

// Regression port of upstream tests/sdk/mcp/test_mcp_nested_schema.py
// (fix(mcp): preserve nested object properties in LLM-facing tool schema).
// The TypeScript MCP tool definition passes its inputSchema through verbatim,
// so nested object structure must survive into LLM-facing payloads.
describe('MCP LLM-facing schema preservation', () => {
  const client = { isConnected: () => true, callTool: async () => ({ isError: false, content: [] }) };

  function makeTool(name: string, inputSchema: Record<string, unknown>, description = 'test'): MCPToolDefinition {
    return new MCPToolDefinition({ name, description, inputSchema }, client);
  }

  function openAiParams(tool: MCPToolDefinition): Record<string, any> {
    const openaiTool = tool.toOpenAiTool() as { function: { parameters: Record<string, any> } };
    return openaiTool.function.parameters;
  }

  const issue3955Schema = {
    type: 'object',
    properties: {
      definition: { description: 'Component model ID', type: 'string' },
      position: {
        description: 'Component position',
        type: 'object',
        properties: {
          '0': { type: 'number' },
          '1': { type: 'number' },
        },
        required: ['0', '1'],
      },
    },
    required: ['definition', 'position'],
  };

  it('preserves nested object properties in OpenAI-facing schema (issue #3955)', () => {
    const tool = makeTool('add_diagram_component', issue3955Schema);
    const position = openAiParams(tool).properties.position;

    expect(position.properties).toBeDefined();
    expect(position.properties['0']).toEqual({ type: 'number' });
    expect(position.properties['1']).toEqual({ type: 'number' });
    expect(new Set<string>(position.required)).toEqual(new Set(['0', '1']));
    expect(position.description).toBe('Component position');
  });

  it('preserves nested object properties in Responses-facing schema', () => {
    const tool = makeTool('add_diagram_component', issue3955Schema);
    const params = tool.toResponsesTool().parameters as Record<string, any>;
    const position = params.properties.position;

    expect(position.properties).toBeDefined();
    expect(position.properties['0']).toEqual({ type: 'number' });
    expect(new Set<string>(position.required)).toEqual(new Set(['0', '1']));
  });

  it('preserves three levels of nesting', () => {
    const tool = makeTool('configure_app', {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          description: 'App configuration',
          properties: {
            theme: {
              type: 'object',
              description: 'Theme settings',
              properties: {
                primary: { type: 'string' },
                secondary: { type: 'string' },
              },
              required: ['primary'],
            },
          },
          required: ['theme'],
        },
      },
      required: ['config'],
    });
    const params = openAiParams(tool);
    const config = params.properties.config;
    const theme = config.properties.theme;

    expect(config.properties).toBeDefined();
    expect(theme.properties.primary).toEqual({ type: 'string' });
    expect(theme.properties.secondary).toEqual({ type: 'string' });
    expect(theme.required).toEqual(['primary']);
    expect(config.required).toEqual(['theme']);
  });

  it('preserves arrays of objects', () => {
    const tool = makeTool('batch_create', {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'List of entries',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              label: { type: 'string' },
            },
            required: ['id'],
          },
        },
      },
    });
    const itemsField = openAiParams(tool).properties.items;

    expect(itemsField.type).toBe('array');
    expect(itemsField.items.properties).toBeDefined();
    expect(itemsField.items.properties.id).toEqual({ type: 'integer' });
    expect(itemsField.items.required).toEqual(['id']);
  });

  it('keeps flat schemas intact', () => {
    const tool = makeTool('search', {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer', description: 'Max results' },
      },
      required: ['query'],
    });
    const params = openAiParams(tool);

    expect(params.properties.query).toEqual({ type: 'string', description: 'Search query' });
    expect(params.properties.limit).toEqual({ type: 'integer', description: 'Max results' });
    expect(params.required).toContain('query');
  });
});
