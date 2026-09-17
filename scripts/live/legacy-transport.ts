// Preloaded in legacy scripts so their native requests share the suite's
// deadline and safe failure classification without publishing their output.
import { providerFailure } from './provider-failure.js';

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const error = await providerFailure(response);
    process.send?.({ providerFailure: error.message });
    throw error;
  }
  return response;
};
