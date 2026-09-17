/** Provider-agnostic LLM error classification for recovery control flow.

Background: upstream `software-agent-sdk` distinguishes content-policy blocks
from generic bad requests so the sequential/reasoning agent loop can recover
softly (emit a user nudge and continue) instead of hard-erroring. A content-policy
block is deterministic for a fixed (messages, model): a bare retry trips the same
filter, so recovery requires changing the request, not re-sending it.

In this transpilation no LiteLLM exception layer exists; provider clients own
their error mapping. This module supplies the shared classification predicate and
exception type that provider clients raise and the agent loop catches.
 */

const CONTENT_POLICY_PATTERNS: readonly string[] = [
  'content_policy',
  'content filtering policy',
  'output blocked by content filtering',
];

export class LLMBadRequestError extends Error {
  constructor(message = 'Provider rejected the LLM request') {
    super(message);
    this.name = 'LLMBadRequestError';
  }
}

export class LLMContextWindowExceedError extends LLMBadRequestError {
  constructor(message = 'LLM context window exceeded') {
    super(message);
    this.name = 'LLMContextWindowExceedError';
  }
}

export class LLMMalformedConversationHistoryError extends LLMBadRequestError {
  constructor(message = 'Provider rejected malformed conversation history') {
    super(message);
    this.name = 'LLMMalformedConversationHistoryError';
  }
}

export class LLMContentPolicyViolationError extends LLMBadRequestError {
  constructor(message = 'Output blocked by content filtering policy') {
    super(message);
    this.name = 'LLMContentPolicyViolationError';
  }
}

/** True when the provider blocked the request/response via its content filter. */
export function isContentPolicyViolation(error: unknown): boolean {
  if (hasCause(error, value => value instanceof LLMContentPolicyViolationError)) {
    return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const typeName = error instanceof Error ? error.name.toLowerCase() : '';
  return CONTENT_POLICY_PATTERNS.some((pattern) => normalized.includes(pattern) || typeName.includes(pattern));
}

// PORT: sdk/llm/exceptions/classifier.py. The native adapters replace LiteLLM's
// typed exception boundary: arbitrary application errors never match by text.
const LONG_PROMPT_PATTERNS = [
  'contextwindowexceedederror', 'prompt is too long',
  'input length and `max_tokens` exceed context limit',
  'please reduce the length of', 'exceeds the available context size',
  'context length exceeded', 'input exceeds the context window',
  'context window exceeds limit', 'maximum context length',
];
const MALFORMED_HISTORY_PATTERNS = [
  'tool_use ids were found without `tool_result` blocks immediately after',
  '`tool_use` ids were found without `tool_result` blocks immediately after',
  'each `tool_use` block must have a corresponding `tool_result` block in the next message',
  'each tool_use must have a single result', 'found multiple `tool_result` blocks with id:',
  'unexpected `tool_use_id` found in `tool_result` blocks',
  'each `tool_result` block must have a corresponding `tool_use` block in the previous message',
  "must be followed by tool messages responding to each 'tool_call_id'",
  'failed to parse tool call arguments as json',
];
const CONTEXT_CODES = new Set(['context_length_exceeded', 'context_window_exceeded', 'input_context_length_exceeded']);

function hasCause(error: unknown, predicate: (error: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (predicate(error)) return true;
    error = error.cause;
  }
  return false;
}

/** Includes the typed cause retained by LLMResponseError for failed paid responses. */
export function isContextWindowExceeded(error: unknown): boolean {
  return hasCause(error, value => value instanceof LLMContextWindowExceedError);
}

export function looksLikeMalformedConversationHistoryError(error: unknown): boolean {
  return hasCause(error, value => value instanceof LLMMalformedConversationHistoryError);
}

function errorDetails(body: unknown): string[] {
  if (typeof body === 'string') {
    try { return errorDetails(JSON.parse(body) as unknown); } catch { return [body]; }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const object = body as Record<string, unknown>;
  return ['code', 'type', 'message', 'status'].flatMap(key => typeof object[key] === 'string' ? [object[key]] : [])
    .concat(object.error === undefined ? [] : errorDetails(object.error));
}

/** Called only at a provider ingress, never over arbitrary conversation text.
 * No response body is retained in the error (subscription failures may echo input).
 */
export function providerResponseError(provider: string, status: number, body: unknown): Error {
  const message = `${provider} completion failed with HTTP ${status}`;
  const details = errorDetails(body).map(value => value.toLowerCase());
  const text = details.join(' ');
  // Explicit transport auth/rate-limit failures must never start condensation.
  if ([401, 403, 429].includes(status)) return new Error(message);
  if (CONTENT_POLICY_PATTERNS.some(pattern => text.includes(pattern)))
    return new LLMContentPolicyViolationError();
  if (/invalid api key|unauthorized|missing api key|invalid authentication|access denied|status 40[13]/u.test(text))
    return new Error(message);
  if (/max_(?:output_|completion_)?tokens(?: value)? (?:must be|is too (?:large|high)|cannot exceed)/u.test(text))
    return new LLMBadRequestError(message);
  if ([200, 400, 413, 422, 500, 502, 503].includes(status)) {
    if (details.some(value => CONTEXT_CODES.has(value)) || LONG_PROMPT_PATTERNS.some(pattern => text.includes(pattern))
      || /input token count[^.]*exceeds the maximum number of tokens/u.test(text))
      return new LLMContextWindowExceedError(message);
    if (MALFORMED_HISTORY_PATTERNS.some(pattern => text.includes(pattern)))
      return new LLMMalformedConversationHistoryError(message);
  }
  return status >= 400 && status < 500 ? new LLMBadRequestError(message) : new Error(message);
}

/** Support typed transport wrappers used by advanced/injected provider clients. */
export function mapProviderException(error: unknown): unknown {
  if (error instanceof Error && ['BadRequestError', 'OpenAIError', 'APIConnectionError', 'InternalServerError', 'ContextWindowExceededError'].includes(error.name)) {
    if (error.name === 'ContextWindowExceededError') return new LLMContextWindowExceedError();
    return providerResponseError('LLM provider', error.name === 'BadRequestError' ? 400 : 500, error.message);
  }
  return error;
}
