import { InMemorySecretStore, OpenAISubscriptionAuth, llmProfileSchema } from '@smolpaws/openhands-agent';
import { runConversationRegression } from './conversation-regression.js';
import { readSubscriptionConfig, subscriptionIdentity } from './subscriptions-config.js';

const target = (await readSubscriptionConfig()).targets.find(t => t.id === process.argv[2]);
if (!target?.enabled || !process.send || process.env.GITHUB_ACTIONS === 'true') process.exit(2);
const base = subscriptionIdentity(target);
const controller = new AbortController();
const cancel = (message: unknown) => {
  if (message && typeof message === 'object' && 'cancel' in message && message.cancel === true) controller.abort();
};
const disconnect = () => controller.abort();
process.on('message', cancel);
process.on('disconnect', disconnect);
const report = (value: unknown) => { if (process.connected) process.send?.(value); };
try {
  // The SDK alone reads, validates, refreshes and persists OAuth credentials.
  // An expired access token is not a missing login: the factory refreshes it.
  if (!new OpenAISubscriptionAuth().getCredentials()) {
    report({ ...base, status: 'unavailable', reason: 'subscription-login-required' });
  } else {
    const evidence = await runConversationRegression({
      profile: llmProfileSchema.parse({ profileId: target.id, providerId: 'openai', model: target.model,
        authType: 'subscription', subscriptionVendor: 'openai', timeoutSeconds: 60 }),
      store: new InMemorySecretStore(), signal: controller.signal, repoRoot: process.cwd(), timeoutMs: 220_000, maxRequests: 18,
    });
    report({ ...base, status: 'passed', evidence });
  }
} catch (error) {
  // Never send exception text, request headers, provider bodies or credentials.
  const message = error instanceof Error ? error.message : '';
  const http = /(?:HTTP\s+|Token refresh failed:\s*)(\d{3})/u.exec(message)?.[1];
  const category = /unavailable:(insufficient-credit|exhausted-quota|model-unavailable)/u.exec(message)?.[1];
  const phase = error instanceof Error && 'regressionPhase' in error && typeof error.regressionPhase === 'string'
    && ['setup', 'read', 'edit', 'parallel', 'restore', 'plain'].includes(error.regressionPhase) ? error.regressionPhase : undefined;
  const auth = message === 'OpenAI subscription login is required' || /^Token refresh failed:/u.test(message);
  const network = message === 'fetch failed';
  const unavailable = auth || network || category || (http && ['401', '403', '404', '429', '500', '502', '503', '504'].includes(http));
  const reason = auth ? 'subscription-auth-unavailable' : category ? `provider-${category}` : http ? `provider-http-${http}`
    : network ? 'provider-network-unavailable' : phase ? `conversation-${phase}` : 'scenario-error';
  report({ ...base, status: unavailable ? 'unavailable' : 'failed', reason });
} finally {
  process.off('message', cancel);
  process.off('disconnect', disconnect);
  if (process.connected) process.disconnect();
}
