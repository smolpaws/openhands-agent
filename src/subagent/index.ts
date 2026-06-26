import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, posix, sep } from 'node:path';

// Retain permission_mode as a known frontmatter key so legacy agent files load,
// but do not expose or enforce Python confirmation semantics.
const knownAgentFields = new Set([
  'name',
  'description',
  'model',
  'color',
  'tools',
  'skills',
  'max_iteration_per_run',
  'max_budget_per_run',
  'hooks',
  'profile_store_dir',
  'mcp_servers',
  'permission_mode',
  'condenser',
]);

const agentDirectories = ['.agents/agents', '.openhands/agents'] as const;
const skipFiles = new Set(['README.md', 'readme.md']);

export interface AgentDefinitionOptions {
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly color?: string | null;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly system_prompt?: string;
  readonly source?: string | null;
  readonly when_to_use_examples?: readonly string[];
  readonly hooks?: unknown;
  readonly max_iteration_per_run?: number | null;
  readonly max_budget_per_run?: number | null;
  readonly mcp_servers?: Record<string, unknown> | null;
  readonly profile_store_dir?: string | null;
  readonly condenser?: unknown;
  readonly metadata?: Record<string, unknown>;
}

export class AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly color: string | null;
  readonly tools: string[];
  readonly skills: string[];
  readonly system_prompt: string;
  readonly source: string | null;
  readonly when_to_use_examples: string[];
  readonly hooks: unknown;
  readonly max_iteration_per_run: number | null;
  readonly max_budget_per_run: number | null;
  readonly mcp_servers: Record<string, unknown> | null;
  readonly profile_store_dir: string | null;
  readonly condenser: unknown;
  readonly metadata: Record<string, unknown>;

  constructor(options: AgentDefinitionOptions) {
    this.name = options.name;
    this.description = options.description ?? '';
    this.model = options.model ?? 'inherit';
    this.color = options.color ?? null;
    this.tools = [...(options.tools ?? [])];
    this.skills = [...(options.skills ?? [])];
    this.system_prompt = options.system_prompt ?? '';
    this.source = options.source ?? null;
    this.when_to_use_examples = [...(options.when_to_use_examples ?? [])];
    this.hooks = options.hooks ?? null;
    this.max_iteration_per_run = positiveNumberOrNull(options.max_iteration_per_run ?? null, 'max_iteration_per_run');
    this.max_budget_per_run = positiveNumberOrNull(options.max_budget_per_run ?? null, 'max_budget_per_run');
    this.mcp_servers = options.mcp_servers ?? null;
    this.profile_store_dir = options.profile_store_dir ?? null;
    this.condenser = options.condenser ?? null;
    this.metadata = { ...(options.metadata ?? {}) };
  }

  static async load(agentPath: string): Promise<AgentDefinition> {
    const fileContent = await readFile(agentPath, 'utf8');
    const parsed = parseFrontmatter(fileContent);
    const metadata = parsed.metadata;
    const name = stringField(metadata.name, basename(agentPath, extname(agentPath)));
    const description = stringField(metadata.description, '');

    return new AgentDefinition({
      name,
      description,
      model: stringField(metadata.model, 'inherit'),
      color: nullableString(metadata.color),
      tools: stringList(metadata.tools, false),
      skills: stringList(metadata.skills, true),
      max_iteration_per_run: optionalNumber(metadata.max_iteration_per_run),
      max_budget_per_run: optionalNumber(metadata.max_budget_per_run),
      mcp_servers: recordOrNull(metadata.mcp_servers, 'mcp_servers'),
      profile_store_dir: nullableString(metadata.profile_store_dir),
      hooks: metadata.hooks,
      condenser: metadata.condenser,
      system_prompt: parsed.content.trim(),
      source: toPosixPath(agentPath),
      when_to_use_examples: examplesFrom(description),
      metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => !knownAgentFields.has(key))),
    });
  }
}

export async function loadProjectAgents(projectDir: string): Promise<AgentDefinition[]> {
  return loadAgentsFromDirs(agentDirectories.map((dir) => join(projectDir, dir)));
}

export async function loadUserAgents(): Promise<AgentDefinition[]> {
  return loadAgentsFromDirs(agentDirectories.map((dir) => join(homedir(), dir)));
}

export async function loadAgentsFromDirs(directories: readonly string[]): Promise<AgentDefinition[]> {
  const seen = new Set<string>();
  const result: AgentDefinition[] = [];
  for (const directory of directories) {
    for (const definition of await loadAgentsFromDir(directory)) {
      if (!seen.has(definition.name)) {
        seen.add(definition.name);
        result.push(definition);
      }
    }
  }
  return result;
}

export async function loadAgentsFromDir(agentsDir: string): Promise<AgentDefinition[]> {
  if (!(await isDirectory(agentsDir))) {
    return [];
  }
  const definitions: AgentDefinition[] = [];
  for (const entry of (await readdir(agentsDir)).sort()) {
    const path = join(agentsDir, entry);
    if (skipFiles.has(entry) || extname(entry).toLowerCase() !== '.md' || await isDirectory(path)) {
      continue;
    }
    try {
      definitions.push(await AgentDefinition.load(path));
    } catch {
      // Match Python behavior: skip invalid individual agent files.
    }
  }
  return definitions;
}

export type AgentFactoryFunction = (llm: unknown) => unknown;
export interface AgentFactory {
  readonly factoryFunc: AgentFactoryFunction;
  readonly definition: AgentDefinition;
}

const agentFactories = new Map<string, AgentFactory>();

export function registerAgent(name: string, factoryFunc: AgentFactoryFunction, description: string | AgentDefinition): void {
  if (agentFactories.has(name)) {
    throw new Error(`Agent '${name}' already registered`);
  }
  agentFactories.set(name, { factoryFunc, definition: resolveAgentDefinition(name, description) });
}

export function registerAgentIfAbsent(name: string, factoryFunc: AgentFactoryFunction, description: string | AgentDefinition): boolean {
  if (agentFactories.has(name)) {
    return false;
  }
  agentFactories.set(name, { factoryFunc, definition: resolveAgentDefinition(name, description) });
  return true;
}

export function getAgentFactory(name: string | null | undefined): AgentFactory {
  const deprecated: Record<string, string> = { default: 'general-purpose', 'default cli mode': 'general-purpose', explore: 'code-explorer', bash: 'bash-runner' };
  const factoryName = name === null || name === undefined || name.length === 0 ? 'general-purpose' : deprecated[name] ?? name;
  const factory = agentFactories.get(factoryName);
  if (factory === undefined) {
    const available = [...agentFactories.keys()].sort().join(', ') || 'none registered';
    throw new Error(`Unknown agent '${name ?? ''}'. Available types: ${available}. Use registerAgent() to add custom agent types.`);
  }
  return factory;
}

export function getFactoryInfo(): string {
  if (agentFactories.size === 0) {
    return '- No user-registered agents yet. Call registerAgent(...) to add custom agents.';
  }
  return [...agentFactories.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, factory]) => {
    const tools = factory.definition.tools.length > 0 ? ` (tools: ${factory.definition.tools.join(', ')})` : '';
    return `- **${name}**: ${factory.definition.description}${tools}`;
  }).join('\n');
}

export function getRegisteredAgentDefinitions(): AgentDefinition[] {
  return [...agentFactories.values()].map((factory) => factory.definition);
}

export function resetAgentRegistryForTests(): void {
  agentFactories.clear();
}

function resolveAgentDefinition(name: string, description: string | AgentDefinition): AgentDefinition {
  return description instanceof AgentDefinition ? description : new AgentDefinition({ name, description });
}

function parseFrontmatter(fileContent: string): { metadata: Record<string, unknown>; content: string } {
  if (!fileContent.startsWith('---')) {
    return { metadata: {}, content: fileContent };
  }
  const end = fileContent.indexOf('\n---', 3);
  if (end === -1) {
    return { metadata: {}, content: fileContent };
  }
  return { metadata: parseSimpleYaml(fileContent.slice(3, end)), content: fileContent.slice(end + 4).replace(/^\r?\n/, '') };
}

function parseSimpleYaml(frontmatter: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const line of frontmatter.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      continue;
    }
    metadata[trimmed.slice(0, separator).trim()] = parseScalar(trimmed.slice(separator + 1).trim());
  }
  return metadata;
}

function parseScalar(value: string): unknown {
  const unquoted = stripQuotes(value);
  if (unquoted === 'true') {
    return true;
  }
  if (unquoted === 'false') {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/u.test(unquoted)) {
    return Number(unquoted);
  }
  if (unquoted.startsWith('[') && unquoted.endsWith(']')) {
    return unquoted.slice(1, -1).split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  }
  return unquoted;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stringField(value: unknown, fallback: string): string {
  return value === undefined || value === null ? fallback : scalarToString(value);
}

function nullableString(value: unknown): string | null {
  return value === undefined || value === null ? null : scalarToString(value);
}

function scalarToString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  throw new Error('Expected a scalar string-compatible value');
}

function stringList(value: unknown, splitComma: boolean): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string') {
    return splitComma ? value.split(',').map((part) => part.trim()).filter((part) => part.length > 0) : [value];
  }
  return [];
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return Number(value);
  }
  return null;
}

function positiveNumberOrNull(value: number | null, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be positive`);
  }
  return value;
}

function recordOrNull(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${field} must be a mapping`);
}

function examplesFrom(description: string): string[] {
  return [...description.matchAll(/<example>(.*?)<\/example>/gis)].map((match) => match[1]?.trim() ?? '').filter((example) => example.length > 0);
}

function toPosixPath(path: string): string {
  return path.split(sep).join(posix.sep);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
