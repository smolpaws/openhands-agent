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

export class LLMContentPolicyViolationError extends Error {
  constructor(message = 'Output blocked by content filtering policy') {
    super(message);
    this.name = 'LLMContentPolicyViolationError';
  }
}

/** True when the provider blocked the request/response via its content filter. */
export function isContentPolicyViolation(error: unknown): boolean {
  if (error instanceof LLMContentPolicyViolationError) {
    return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const typeName = error instanceof Error ? error.name.toLowerCase() : '';
  return CONTENT_POLICY_PATTERNS.some((pattern) => normalized.includes(pattern) || typeName.includes(pattern));
}