import { z } from 'zod';

export type JsonObject = Record<string, unknown>;
export type ToolExecutor<TAction = unknown, TObservation = unknown> = (
  action: TAction,
  context?: unknown,
) => TObservation | Promise<TObservation>;
export type ToolFactory = (params: Readonly<Record<string, unknown>>, context?: unknown) => readonly ToolDefinition[];

export const toolAnnotationsSchema = z
  .object({
    title: z.string().nullable().default(null),
    readOnlyHint: z.boolean().default(false),
    destructiveHint: z.boolean().default(true),
    idempotentHint: z.boolean().default(false),
    openWorldHint: z.boolean().default(true),
  })
  .strict();

export const toolSpecSchema = z
  .object({
    name: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type ToolSpec = z.infer<typeof toolSpecSchema>;

export interface ToolDefinitionOptions<TInputSchema extends z.ZodType = z.ZodType, TOutputSchema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema?: TOutputSchema;
  readonly executor?: ToolExecutor<z.infer<TInputSchema>, z.infer<TOutputSchema>>;
  readonly annotations?: ToolAnnotations;
  readonly meta?: JsonObject;
  readonly usable?: boolean;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: JsonObject;
}

export interface ResponsesTool {
  readonly type: 'function';
  readonly name: string;
  readonly description?: string;
  readonly strict: false;
  readonly parameters: JsonObject;
}

export class ToolDefinition<TInputSchema extends z.ZodType = z.ZodType, TOutputSchema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema | undefined;
  readonly executor: ToolExecutor<z.infer<TInputSchema>, z.infer<TOutputSchema>> | undefined;
  readonly annotations: ToolAnnotations | undefined;
  readonly meta: JsonObject | undefined;
  readonly usable: boolean;

  constructor(options: ToolDefinitionOptions<TInputSchema, TOutputSchema>) {
    this.name = options.name;
    this.description = options.description;
    this.inputSchema = options.inputSchema;
    this.outputSchema = options.outputSchema;
    this.executor = options.executor;
    this.annotations = options.annotations;
    this.meta = options.meta;
    this.usable = options.usable ?? true;
  }

  async execute(input: unknown, context?: unknown): Promise<z.infer<TOutputSchema>> {
    if (this.executor === undefined) {
      throw new Error(`Tool '${this.name}' has no executor`);
    }

    const action = this.inputSchema.parse(input);
    const result = await this.executor(action, context);
    if (this.outputSchema === undefined) {
      return result;
    }
    return this.outputSchema.parse(result);
  }

  toMcpTool(inputSchema?: JsonObject, outputSchema?: JsonObject): McpTool {
    const tool: {
      name: string;
      description: string;
      inputSchema: JsonObject;
      outputSchema?: JsonObject;
      annotations?: ToolAnnotations;
      _meta?: JsonObject;
    } = {
      name: this.name,
      description: this.description,
      inputSchema: inputSchema ?? schemaToJsonObject(this.inputSchema),
    };

    const derivedOutputSchema = outputSchema ?? (this.outputSchema === undefined ? undefined : schemaToJsonObject(this.outputSchema));
    if (derivedOutputSchema !== undefined) {
      tool.outputSchema = derivedOutputSchema;
    }
    if (this.annotations !== undefined) {
      tool.annotations = this.annotations;
    }
    if (this.meta !== undefined) {
      tool._meta = this.meta;
    }
    return tool;
  }

  toResponsesTool(): ResponsesTool {
    return {
      type: 'function',
      name: this.name,
      description: this.description,
      strict: false,
      parameters: schemaToJsonObject(this.inputSchema),
    };
  }
}

export class ToolRegistry {
  private readonly registrations = new Map<string, ToolDefinition | ToolFactory>();

  register(name: string, tool: ToolDefinition): void {
    this.registrations.set(name, tool);
  }

  registerFactory(name: string, factory: ToolFactory): void {
    this.registrations.set(name, factory);
  }

  resolve(spec: ToolSpec, context?: unknown): readonly ToolDefinition[] {
    const parsedSpec = toolSpecSchema.parse(spec);
    const registration = this.registrations.get(parsedSpec.name);
    if (registration === undefined) {
      throw new Error(`Unknown tool: ${parsedSpec.name}`);
    }

    if (registration instanceof ToolDefinition) {
      if (Object.keys(parsedSpec.params).length > 0) {
        throw new Error(`Registered tool instance '${parsedSpec.name}' does not accept params`);
      }
      return [registration];
    }

    return registration(parsedSpec.params, context);
  }

  listRegisteredTools(): readonly string[] {
    return [...this.registrations.keys()];
  }

  listUsableTools(): readonly string[] {
    return [...this.registrations.entries()]
      .filter(([_name, registration]) => !(registration instanceof ToolDefinition) || registration.usable)
      .map(([name]) => name);
  }
}

export const globalToolRegistry = new ToolRegistry();

export function registerTool(name: string, tool: ToolDefinition): void {
  globalToolRegistry.register(name, tool);
}

export function registerToolFactory(name: string, factory: ToolFactory): void {
  globalToolRegistry.registerFactory(name, factory);
}

export function resolveTool(spec: ToolSpec, context?: unknown): readonly ToolDefinition[] {
  return globalToolRegistry.resolve(spec, context);
}

export function listRegisteredTools(): readonly string[] {
  return globalToolRegistry.listRegisteredTools();
}

export function listUsableTools(): readonly string[] {
  return globalToolRegistry.listUsableTools();
}

function schemaToJsonObject(schema: z.ZodType): JsonObject {
  const jsonSchema = z.toJSONSchema(schema);
  if (!isJsonObject(jsonSchema)) {
    throw new Error('Zod schema did not produce a JSON object schema');
  }
  return jsonSchema;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
