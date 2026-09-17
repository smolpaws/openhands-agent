import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { ToolDefinition } from '../tool/index.js';
import type { LLMTokenCountTool } from './client.js';
import type { Message } from './index.js';

// PORT: LiteLLM 1.93.0 litellm_core_utils/token_counter.py (pinned SDK uv.lock).
// These are local text/tool estimates, not provider usage. HF/chat templates and
// opaque multimodal/reasoning tokens cannot be measured by this implementation.
const encodings = new Map<string, Tiktoken>();
function encoder(model: string): Tiktoken {
  const name = /^(?:openai\/)?(?:gpt-(?:4o|4\.1|[5-9])|o[134](?:-|$))/u.test(model) ? 'o200k_base' : 'cl100k_base';
  let value = encodings.get(name);
  if (!value) { value = getEncoding(name); encodings.set(name, value); }
  return value;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function formatType(props: Readonly<Record<string, unknown>>, indent: number): string {
  switch (props.type) {
    case 'string': return Array.isArray(props.enum) ? props.enum.map(value => JSON.stringify(value)).join(' | ') : 'string';
    case 'integer': case 'number': return Array.isArray(props.enum) ? props.enum.map(value => `"${String(value)}"`).join(' | ') : 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return `${formatType(record(props.items), indent)}[]`;
    case 'object': return `{\n${formatParameters(props, indent + 2)}\n}`;
    default: return 'any';
  }
}

function formatParameters(parameters: Readonly<Record<string, unknown>>, indent: number): string {
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  return Object.entries(record(parameters.properties)).flatMap(([key, value]) => {
    const props = record(value);
    const lines = typeof props.description === 'string' && props.description ? [`// ${props.description}`] : [];
    lines.push(`${key}${required.includes(key) ? '' : '?'}: ${formatType(props, indent)},`);
    return lines.map(line => `${' '.repeat(indent)}${line}`);
  }).join('\n');
}

function formatTools(tools: readonly LLMTokenCountTool[]): string {
  const lines = ['namespace functions {', ''];
  for (const tool of tools) {
    const definition = tool instanceof ToolDefinition ? { ...tool.toResponsesTool() } : tool;
    const nested = record(definition.function);
    const fn = Object.keys(nested).length ? nested : definition;
    if (typeof fn.name !== 'string' || !fn.name) continue;
    if (typeof fn.description === 'string' && fn.description) lines.push(`// ${fn.description}`);
    const parameters = record(fn.parameters ?? fn.input_schema);
    if (Object.keys(record(parameters.properties)).length) {
      lines.push(`type ${fn.name} = (_: {`, formatParameters(parameters, 0), '}) => any;');
    } else lines.push(`type ${fn.name} = () => any;`);
    lines.push('');
  }
  lines.push('} // namespace functions');
  return lines.join('\n');
}

export function estimateInputTokens(model: string, messages: readonly Message[], tools: readonly LLMTokenCountTool[] = []): number | null {
  const encoding = encoder(model);
  const count = (text: string) => encoding.encode(text, [], []).length;
  let total = 3; // Assistant reply priming, also present for an empty input.
  for (const message of messages) {
    if (message.content.some(content => content.type !== 'text')
      || message.thinking_blocks?.some(block => block.type === 'redacted_thinking')
      || message.responses_reasoning_item?.encrypted_content) return null;
    total += (model === 'gpt-3.5-turbo-0301' ? 4 : 3) + count(message.role);
    for (const content of message.content) if (content.type === 'text') total += count(content.text);
    if (message.name !== null && message.name !== undefined) total += count(message.name) + (model === 'gpt-3.5-turbo-0301' ? -1 : 1);
    if (message.tool_call_id) total += count(message.tool_call_id);
    for (const call of message.tool_calls ?? []) total += count(call.arguments);
    if (message.reasoning_content) total += count(message.reasoning_content);
    // Avoid double counting native thinking that mirrors reasoning_content.
    if (!message.reasoning_content) {
      for (const block of message.thinking_blocks ?? []) if (block.type === 'thinking') total += count(block.thinking);
    }
  }
  if (tools.length) total += count(formatTools(tools)) + 9 - (messages.some(message => message.role === 'system') ? 4 : 0);
  return total;
}
