import {
  MCPToolAction,
  MCPToolDefinition,
  MCPToolExecutor,
  type McpClientLike,
} from '@smolpaws/openhands-agent';

const client: McpClientLike = {
  isConnected: () => true,
  async callTool(name, args) {
    return {
      content: [{ type: 'text', text: `${name} received ${JSON.stringify(args)}` }],
      isError: false,
    };
  },
};

const [tool] = MCPToolDefinition.create(
  {
    name: 'echo',
    description: 'Echo an MCP argument payload.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  client,
);

if (tool === undefined) {
  throw new Error('expected one MCP tool');
}

const action = tool.actionFromArguments({ text: 'hello', omitted: undefined });
const observation = await new MCPToolExecutor(tool.name, client).execute(new MCPToolAction(action.toMcpArguments()));

console.log(tool.toOpenAiTool());
console.log(observation.visualize());
