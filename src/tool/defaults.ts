import { globalToolRegistry, toolSpecSchema, type ToolSpec } from './index.js';

/**
 * Canonical default tool names for the standard OpenHands agent.
 *
 * Tool *names* are a wire contract: they are persisted in settings/profile JSON
 * and sent by clients, independently of where the implementations live. The
 * TypeScript SDK owns the same default names as upstream
 * ``openhands.sdk.tool.defaults`` so a bare ``tools: null`` settings value can
 * resolve to the same deterministic exec set without importing the concrete
 * tool implementations (environment-dependent tools are injected by the serving
 * layer, not by this default).
 */
export const DEFAULT_EXEC_TOOL_NAMES = ['terminal', 'file_editor', 'task_tracker'] as const;

/** Name of the browser tool set; a serving-layer injection, not a default. */
export const BROWSER_TOOL_NAME = 'browser_tool_set';

/** Name of the sub-agent delegation tool set, gated on ``enable_sub_agents``. */
export const SUB_AGENT_TOOL_NAME = 'task_tool_set';

export interface DefaultToolSpecOptions {
  readonly enableSubAgents?: boolean;
  readonly enableBrowser?: boolean;
}

export function defaultToolSpecs(options: DefaultToolSpecOptions = {}): string[] {
  const names: string[] = [...DEFAULT_EXEC_TOOL_NAMES];
  if (options.enableBrowser === true) {
    names.push(BROWSER_TOOL_NAME);
  }
  if (options.enableSubAgents === true) {
    names.push(SUB_AGENT_TOOL_NAME);
  }
  return names;
}

export const SWITCH_LLM_TOOL_NAME = 'switch_llm';
export function resolveToolSpecs(tools: readonly ToolSpec[] | null | undefined, options: { readonly enableBrowser?: boolean } = {}): ToolSpec[] {
  return (tools === null || tools === undefined) ? [...defaultToolSpecs(options), SWITCH_LLM_TOOL_NAME].map(name => ({ name, params: {} })) : [...tools];
}
export function launchToolSpecs(tools: readonly ToolSpec[] | null | undefined, options: { readonly browserAvailable: boolean }): ToolSpec[] {
  return resolveToolSpecs(tools, { enableBrowser: options.browserAvailable }).filter(tool => options.browserAvailable || tool.name !== BROWSER_TOOL_NAME);
}
export function canonicalToolName(name: string): string { return globalToolRegistry.canonicalToolName(name); }
export function mergeDuplicateTools(tools: readonly ToolSpec[]): ToolSpec[] {
  const byName = new Map<string, ToolSpec>();
  for (const tool of tools) {
    const name = canonicalToolName(tool.name);
    const kept = byName.get(name);
    if (kept === undefined || (Object.keys(tool.params).length > 0 && Object.keys(kept.params).length === 0)) byName.set(name, { name, params: { ...tool.params } });
  }
  return [...byName.values()];
}
export function rejectBuiltinParams(tools: readonly ToolSpec[]): void {
  for (const tool of tools) {
    const builtin = globalToolRegistry.effectiveBuiltinName(tool.name);
    if (builtin !== null && builtin !== 'route_task_to_model' && Object.keys(tool.params).some(key => key !== 'response_schema')) {
      throw new Error(`Tool '${tool.name}' does not accept parameters`);
    }
  }
}
export function normalizeToolSpecs(tools: readonly unknown[]): ToolSpec[] {
  return tools.map(tool => toolSpecSchema.parse(typeof tool === 'string' ? { name: tool } : tool));
}
export function foldRetiredToolSwitches(payload: Readonly<Record<string, unknown>>, options: { readonly sparse?: boolean; readonly enableBrowser?: boolean } = {}): Record<string, unknown> {
  const folded = { ...payload };
  const sparse = options.sparse ?? false;
  const subAgents = popSwitch(folded, 'enable_sub_agents', sparse ? null : false);
  let switchLlm = popSwitch(folded, 'enable_switch_llm_tool', sparse ? null : true);
  let tools = folded.tools;
  if (tools !== null && tools !== undefined && !Array.isArray(tools)) return folded;
  if (!sparse && Array.isArray(tools) && tools.length === 0) tools = folded.tools = null;
  if ((tools === null || tools === undefined) && !subAgents && switchLlm !== false) return folded;
  let entries: ToolSpec[];
  if (tools === null || tools === undefined) {
    entries = defaultToolSpecs({ enableBrowser: options.enableBrowser ?? true, enableSubAgents: subAgents ?? false }).map(name => ({ name, params: {} }));
    switchLlm ??= true;
  } else {
    entries = normalizeToolSpecs(tools as unknown[]);
    if (sparse && subAgents !== null) entries = toggle(entries, SUB_AGENT_TOOL_NAME, subAgents);
  }
  if (switchLlm !== null) entries = toggle(entries, SWITCH_LLM_TOOL_NAME, switchLlm);
  folded.tools = entries;
  return folded;
}
export function dropRetiredToolSwitches(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const dropped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== 'enable_sub_agents' && key !== 'enable_switch_llm_tool') dropped[key] = value;
  }
  return dropped;
}
function toggle(entries: ToolSpec[], name: string, enabled: boolean): ToolSpec[] {
  if (!enabled) return entries.filter(entry => canonicalToolName(entry.name) !== name);
  return entries.some(entry => canonicalToolName(entry.name) === name) ? entries : [...entries, { name, params: {} }];
}
function popSwitch(payload: Record<string, unknown>, key: string, fallback: boolean | null): boolean | null {
  if (!(key in payload)) return fallback;
  const value = payload[key]; delete payload[key];
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === 'string') {
    if (['1', 'true', 't', 'yes', 'y', 'on'].includes(value.toLowerCase())) return true;
    if (['0', 'false', 'f', 'no', 'n', 'off'].includes(value.toLowerCase())) return false;
  }
  throw new TypeError(`${key} must be a boolean.`);
}
