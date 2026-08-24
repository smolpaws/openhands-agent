import { z } from 'zod';

/**
 * Small, privacy-safe failure contract shared by SDK, UI, and telemetry.
 * ``detail`` is inspected locally only to map broad third-party errors to
 * this closed vocabulary; it is never copied into the classification.
 */

export const failureKindSchema = z.union([
  z.literal('auth'),
  z.literal('quota'),
  z.literal('rate_limit'),
  z.literal('config'),
  z.literal('transient'),
  z.literal('agent_action'),
  z.literal('internal'),
  z.literal('unknown'),
]);
export type FailureKind = z.infer<typeof failureKindSchema>;

export const failureActionSchema = z.union([z.literal('none'), z.literal('retry'), z.literal('settings')]);
export type FailureAction = z.infer<typeof failureActionSchema>;

export const errorClassificationSchema = z
  .object({
    kind: failureKindSchema,
    retryable: z.boolean(),
    user_action: failureActionSchema.default('none'),
    error_id: z.string().nullable().default(null),
  })
  .strict();
export type ErrorClassification = z.infer<typeof errorClassificationSchema>;

function failure(kind: FailureKind, retryable = false, userAction: FailureAction = 'none'): ErrorClassification {
  return errorClassificationSchema.parse({ kind, retryable, user_action: userAction });
}

/** Expected, agent-correctable failure — the agent can retry. */
export const AGENT_OUTCOME: ErrorClassification = errorClassificationSchema.parse({
  kind: 'agent_action',
  retryable: true,
  user_action: 'retry',
});

const AUTH_CODES = new Set(['LLMAuthenticationError', 'ACPAuthRequired']);
const RATE_LIMIT_CODES = new Set(['LLMRateLimitError']);
const QUOTA_CODES = new Set(['MaxBudgetReached']);
const CONFIG_CODES = new Set([
  'LLMBadRequestError',
  'ACPInitError',
  'ACPSpawnError',
  'ACPPromptError',
  'NotFoundError',
  'LibTmuxException',
]);
const AGENT_ACTION_RETRY_CODES = new Set(['LLMContextWindowExceedError', 'LLMMalformedConversationHistoryError']);
const AGENT_ACTION_CODES = new Set(['MaxIterationsReached', 'ConversationOwnershipLostError']);
const INTERNAL_CODES = new Set(['KeyError', 'AssertionError', 'PydanticSerializationError', 'AttributeError', 'TypeError']);

const AUTH_TOKENS = [
  'invalid api key',
  'incorrect api key',
  'authentication required',
  'invalid bearer token',
  'invalid proxy server token',
  'unauthorized',
  'error code: 401',
  'status": 401',
  'token_not_found',
  'api key is missing',
];
const QUOTA_TOKENS = [
  'weekly usage limit',
  'daily quota',
  'session usage limit',
  'insufficient balance',
  'more credits',
  'budget has been exceeded',
];
const CONFIG_TOKENS = [
  'provider not provided',
  'no models loaded',
  'does not support thinking',
  'model is no longer available',
  'model not found',
  'invalid params',
  'inactive_service',
  'powershell is not available',
];
const TRANSIENT_TOKENS = [
  'timeout',
  'connection error',
  'connection closed',
  'service temporarily unavailable',
  'bad gateway',
  'cloudflare',
  'cannot connect',
  'name or service not known',
  'error code: 5',
];
const INTERNAL_TOKENS = ['on_token callback', 'duplicate tool names', 'list_tools', 'on_tools_changed', 'surrogates not allowed'];

const TRANSIENT_CODES = new Set([
  'LLMServiceUnavailableError',
  'LLMTimeoutError',
  'ReadTimeout',
  'LLMNoResponseError',
  'MCPTimeoutError',
  'BadGatewayError',
  'HTTPStatusError',
  'RequestError',
  'CloudflareError',
  'OpenAIError',
  'APIError',
  'BaseLLMException',
  'AnthropicError',
  'OpenRouterException',
  'OllamaError',
]);

function includesAny(text: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

/**
 * Classify known failures from a typed code and local provider metadata text.
 *
 * Exception classes whose name alone is authoritative are checked first so
 * incidental wording in ``detail`` cannot override them; opaque/generic
 * wrapper codes are checked after the detail heuristics.
 */
export function classifyError(code: string, detail = ''): ErrorClassification {
  if (AUTH_CODES.has(code)) {
    return failure('auth', false, 'settings');
  }
  if (RATE_LIMIT_CODES.has(code)) {
    return failure('rate_limit', true, 'retry');
  }
  if (QUOTA_CODES.has(code)) {
    return failure('quota', false, 'settings');
  }
  if (CONFIG_CODES.has(code)) {
    return failure('config', false, 'settings');
  }
  if (AGENT_ACTION_RETRY_CODES.has(code)) {
    return failure('agent_action', true, 'retry');
  }
  if (AGENT_ACTION_CODES.has(code)) {
    return failure('agent_action');
  }
  if (INTERNAL_CODES.has(code)) {
    return failure('internal');
  }

  const text = detail.toLowerCase();

  if (includesAny(text, AUTH_TOKENS)) {
    return failure('auth', false, 'settings');
  }
  if (includesAny(text, QUOTA_TOKENS)) {
    return failure('quota', false, 'settings');
  }
  if (text.includes('rate limit') || text.includes('error code: 429') || text.includes('status": 429')) {
    return failure('rate_limit', true, 'retry');
  }
  if (includesAny(text, CONFIG_TOKENS)) {
    return failure('config', false, 'settings');
  }
  if (includesAny(text, TRANSIENT_TOKENS)) {
    return failure('transient', true, 'retry');
  }
  if (includesAny(text, INTERNAL_TOKENS)) {
    return failure('internal');
  }

  if (TRANSIENT_CODES.has(code)) {
    return failure('transient', true, 'retry');
  }

  return failure('unknown');
}
