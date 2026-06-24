import { imageContent, textContent, type Content } from '../llm/index.js';

export class MCPError extends Error {}

export class MCPTimeoutError extends MCPError {
  constructor(message: string, readonly timeout: number, readonly config: Record<string, unknown> | null = null) {
    super(message);
  }
}

export interface McpTextContentBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface McpImageContentBlock {
  readonly type: 'image';
  readonly mimeType: string;
  readonly data: string;
}

export type McpContentBlock = McpTextContentBlock | McpImageContentBlock | Record<string, unknown>;

export interface McpCallToolResult {
  readonly content: readonly McpContentBlock[];
  readonly isError?: boolean;
}

export interface McpToolSpec {
  readonly name: string;
  readonly description?: string | null;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown> | null;
  readonly meta?: Record<string, unknown> | null;
}

export interface McpClientLike {
  isConnected(): boolean;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallToolResult>;
}

export class MCPToolAction {
  readonly data: Record<string, unknown>;

  constructor(data: Record<string, unknown> = {}) {
    this.data = { ...data };
  }

  toMcpArguments(): Record<string, unknown> {
    return { ...this.data };
  }
}

export class MCPToolObservation {
  readonly content: Content[];
  readonly is_error: boolean;
  readonly tool_name: string;

  constructor(options: { readonly content: readonly Content[]; readonly is_error?: boolean; readonly tool_name: string }) {
    this.content = [...options.content];
    this.is_error = options.is_error ?? false;
    this.tool_name = options.tool_name;
  }

  static fromText(text: string, options: { readonly is_error?: boolean; readonly tool_name: string }): MCPToolObservation {
    return new MCPToolObservation({ content: [textContent(text)], is_error: options.is_error ?? false, tool_name: options.tool_name });
  }

  static fromCallToolResult(toolName: string, result: McpCallToolResult): MCPToolObservation {
    const content: Content[] = [textContent(`[Tool '${toolName}' executed.]`)];
    for (const block of result.content) {
      if (isMcpTextBlock(block)) {
        content.push(textContent(block.text));
      } else if (isMcpImageBlock(block)) {
        content.push(imageContent([`data:${block.mimeType};base64,${block.data}`]));
      }
    }
    return new MCPToolObservation({ content, is_error: result.isError ?? false, tool_name: toolName });
  }

  visualize(): string {
    const lines = [`[MCP Tool '${this.tool_name}' Observation]`];
    for (const block of this.content) {
      if (block.type === 'text') {
        lines.push(block.text);
      } else if (block.type === 'image') {
        lines.push(`[Image with ${block.image_urls.length} URLs]`);
      }
    }
    return `${this.is_error ? '❌ ERROR: ' : ''}${lines.join('\n')}`;
  }
}

export class MCPToolExecutor {
  constructor(readonly toolName: string, readonly client: McpClientLike, readonly timeoutSeconds = 300) {}

  async execute(action: MCPToolAction): Promise<MCPToolObservation> {
    if (!this.client.isConnected()) {
      return MCPToolObservation.fromText(`MCP client not connected for tool '${this.toolName}'. The connection may have been closed or failed to establish.`, { is_error: true, tool_name: this.toolName });
    }
    try {
      const result = await withTimeout(this.client.callTool(this.toolName, action.toMcpArguments()), this.timeoutSeconds);
      return MCPToolObservation.fromCallToolResult(this.toolName, result);
    } catch (error) {
      const message = error instanceof MCPTimeoutError ? `MCP tool '${this.toolName}' timed out after ${this.timeoutSeconds} seconds.` : `Error calling MCP tool ${this.toolName}: ${String(error)}`;
      return MCPToolObservation.fromText(message, { is_error: true, tool_name: this.toolName });
    }
  }
}

export class MCPToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown> | null;
  readonly meta: Record<string, unknown> | null;
  readonly executor: MCPToolExecutor;

  constructor(spec: McpToolSpec, client: McpClientLike) {
    this.name = spec.name;
    this.description = spec.description ?? 'No description provided';
    this.inputSchema = spec.inputSchema ?? { type: 'object', properties: {} };
    this.annotations = spec.annotations ?? null;
    this.meta = spec.meta ?? null;
    this.executor = new MCPToolExecutor(spec.name, client);
  }

  static create(spec: McpToolSpec, client: McpClientLike): MCPToolDefinition[] {
    return [new MCPToolDefinition(spec, client)];
  }

  actionFromArguments(arguments_: Record<string, unknown>): MCPToolAction {
    const sanitized = Object.fromEntries(Object.entries(arguments_).filter(([, value]) => value !== null && value !== undefined));
    return new MCPToolAction(sanitized);
  }

  toMcpTool(inputSchema?: Record<string, unknown> | null, outputSchema?: Record<string, unknown> | null): Record<string, unknown> {
    if (inputSchema !== undefined || outputSchema !== undefined) {
      throw new Error('MCPTool.toMcpTool does not support overriding schemas');
    }
    return { name: this.name, description: this.description, inputSchema: this.inputSchema };
  }

  toOpenAiTool(): Record<string, unknown> {
    return { type: 'function', function: { name: this.name, description: this.description, parameters: this.inputSchema } };
  }

  toResponsesTool(): Record<string, unknown> {
    return { type: 'function', name: this.name, description: this.description, parameters: this.inputSchema };
  }
}

export function toCamelCase(value: string): string {
  return value.split(/[_\-\s]+/u).filter((part) => part.length > 0).map((part) => part[0]?.toUpperCase() + part.slice(1)).join('');
}

export function createMcpTools(config: Record<string, unknown>, clientFactory: (config: Record<string, unknown>) => { readonly tools: readonly MCPToolDefinition[] }): { readonly tools: readonly MCPToolDefinition[] } {
  return clientFactory(config);
}

async function withTimeout<T>(promise: Promise<T>, timeoutSeconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new MCPTimeoutError(`MCP operation timed out after ${timeoutSeconds} seconds`, timeoutSeconds)), timeoutSeconds * 1000);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function isMcpTextBlock(block: McpContentBlock): block is McpTextContentBlock {
  return block.type === 'text' && typeof block.text === 'string';
}

function isMcpImageBlock(block: McpContentBlock): block is McpImageContentBlock {
  return block.type === 'image' && typeof block.mimeType === 'string' && typeof block.data === 'string';
}
