// Preloaded in legacy scripts so their native requests share the suite's
// deadline and safe failure classification without publishing their output.
import { providerFailure } from './provider-failure.js';

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
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
    process.send?.({ providerFailure: error.message });
    throw error;
  }
  if (!response.ok) {
    const error = await providerFailure(response);
    process.send?.({ providerFailure: error.message });
    throw error;
  }
  return response;
};
