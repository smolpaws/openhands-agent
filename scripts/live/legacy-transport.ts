// Preloaded in legacy scripts so their native requests share the suite's
// deadline and safe failure classification without publishing their output.
import { providerFailure } from './provider-failure.js';

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const optionalMetadata = init?.method === 'GET' && init.redirect === 'error'
    && (url.pathname.endsWith('/v1/model/info') || (url.hostname === 'openrouter.ai' && /^\/api\/v1\/models\/.+\/endpoints$/u.test(url.pathname)));
  let response: Response;
  try {
    response = await nativeFetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    });
  } catch (cause) {
    const deadline = cause instanceof Error && ['AbortError', 'TimeoutError'].includes(cause.name);
    const network = cause instanceof Error && cause.message === 'fetch failed';
    const error = new Error(deadline ? 'request-deadline-exceeded' : network ? 'fetch failed' : 'transport-failed');
    if (deadline) error.name = 'TimeoutError';
    if (!optionalMetadata) process.send?.({ providerFailure: error.message });
    throw error;
  }
  if (!response.ok && !optionalMetadata) {
    const error = await providerFailure(response);
    process.send?.({ providerFailure: error.message });
    throw error;
  }
  return response;
};
