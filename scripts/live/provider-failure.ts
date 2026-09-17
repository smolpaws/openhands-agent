import type { FetchResponseLike } from '@smolpaws/openhands-agent';

const MAX_ERROR_BYTES = 32 * 1024;
type UnavailableReason = 'insufficient-credit' | 'exhausted-quota' | 'model-unavailable';

/** Read diagnostics only to select a fixed category; provider text never escapes. */
export async function providerFailure(response: FetchResponseLike): Promise<Error> {
  let reason: UnavailableReason | undefined;
  try {
    const text = await boundedErrorText(response);
    if (text !== null) reason = classify(JSON.parse(text));
  } catch {
    // Malformed JSON and read failures can include sensitive data. Do not retain
    // the body or attach the original error as a cause, stack, or diagnostic.
  }
  const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
  return new Error(`Live conversation provider returned HTTP ${status}${reason ? ` unavailable:${reason}` : ''}`);
}

async function boundedErrorText(response: FetchResponseLike): Promise<string | null> {
  if (!response.body) {
    // Small transport test doubles may expose only text(). Native fetch always
    // takes the streaming path, which stops before retaining more than 32 KiB.
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') <= MAX_ERROR_BYTES ? text : null;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return Buffer.concat(chunks, bytes).toString('utf8');
      }
      if (!value || value.byteLength === 0) return null;
      bytes += value.byteLength;
      if (bytes > MAX_ERROR_BYTES) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function classify(value: unknown): UnavailableReason | undefined {
  const root = record(value);
  const error = root.error !== undefined ? record(root.error) : root;
  // Inspect only documented error fields; never search echoed requests, tool
  // arguments, metadata, or arbitrary nested provider content for these phrases.
  const codes = [error.code, error.type, error.status].filter((code): code is string => typeof code === 'string').map(code => code.toLowerCase());
  const message = typeof root.error === 'string' ? root.error : typeof error.message === 'string' ? error.message : '';
  if (codes.some(code => ['insufficient_credit', 'insufficient_credits', 'insufficient_balance', 'credit_balance_too_low', 'billing_hard_limit_reached'].includes(code))
    || /\b(?:credit balance is too low|insufficient (?:credits?|balance)|requires more credits)\b/iu.test(message)) {
    return 'insufficient-credit';
  }
  if (codes.some(code => ['insufficient_quota', 'quota_exceeded', 'resource_exhausted', 'usage_limit_reached', 'budget_exceeded'].includes(code))
    || /\b(?:exceeded (?:your (?:current )?)?quota|quota (?:has been )?(?:exceeded|exhausted))\b/iu.test(message)) {
    return 'exhausted-quota';
  }
  if (codes.some(code => ['model_not_found', 'model_not_available', 'unknown_model'].includes(code))
    || /\bmodel\b.{0,160}\b(?:does not exist|not found|not available|unavailable)\b|\bno endpoints found for\b/iu.test(message)) {
    return 'model-unavailable';
  }
  return undefined;
}
