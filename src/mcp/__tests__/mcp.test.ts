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

  it('converts names and exposes timeout errors', () => {
    expect(toCamelCase('web-search tool')).toBe('WebSearchTool');
    expect(new MCPTimeoutError('timed out', 30, { mcpServers: {} })).toMatchObject({ timeout: 30 });
  });
});
