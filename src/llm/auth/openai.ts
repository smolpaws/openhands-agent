import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { z } from 'zod';
import { login, type SubscriptionLoginOptions } from './login.js';
import { CredentialStore, OAuthCredentials } from './credentials.js';
import type { FetchResponseLike } from '../client.js';

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const ISSUER = 'https://auth.openai.com';
export const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const DEVICE_CODE_TIMEOUT_SECONDS = 900;
export const OAUTH_TIMEOUT_SECONDS = 300;
export const DEFAULT_OAUTH_PORT = 1455;
// Pinned Python settings/acp_providers.py _CODEX_MODELS; this is data, not ACP execution.
export const OPENAI_CODEX_MODELS: readonly string[] = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
];
export const CONSENT_BANNER =
  "Signing in with ChatGPT uses your ChatGPT account. By continuing, you confirm you are a ChatGPT End User and are subject to OpenAI's Terms of Use.\nhttps://openai.com/policies/terms-of-use/\n";
export type DeviceCode = {
  readonly verification_url: string;
  readonly user_code: string;
  readonly device_auth_id: string;
  readonly interval: number;
};
export type OAuthFetch = (
  url: string,
  init: {
    method: 'POST' | 'GET';
    headers: Readonly<Record<string, string>>;
    body?: string;
  },
) => Promise<FetchResponseLike>;
const defaultFetch: OAuthFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().default(3600),
});

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}
export function buildAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
  return `${ISSUER}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri, scope: 'openid profile email offline_access', code_challenge: challenge, code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', state, originator: 'openhands' }).toString()}`;
}

export interface OpenAISubscriptionAuthOptions {
  credentialStore?: CredentialStore;
  fetch?: OAuthFetch;
  now?: () => number;
}
/** Shared OAuth lifecycle. Server handlers own pending-login sessions; the SDK owns tokens. */
export class OpenAISubscriptionAuth {
  readonly vendor = 'openai';
  private readonly store: CredentialStore;
  private readonly fetchImpl: OAuthFetch;
  private readonly now: () => number;
  private refreshPromise: Promise<OAuthCredentials | null> | null = null;
  private generation = 0;
  private jwks: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
  constructor(options: OpenAISubscriptionAuthOptions = {}) {
    this.store = options.credentialStore ?? new CredentialStore();
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.now = options.now ?? Date.now;
  }
  login(options: SubscriptionLoginOptions = {}): Promise<OAuthCredentials> {
    return login(this, options);
  }
  getCredentials(): OAuthCredentials | null {
    return this.store.get(this.vendor);
  }
  hasValidCredentials(): boolean {
    const c = this.getCredentials();
    return c !== null && !c.isExpired(this.now());
  }
  saveCredentials(credentials: OAuthCredentials): void {
    if (credentials.vendor !== this.vendor) throw new Error('Invalid subscription vendor');
    this.generation++;
    this.store.save(credentials);
  }
  logout(): boolean {
    this.generation++;
    return this.store.delete(this.vendor);
  }
  async refreshIfNeeded(): Promise<OAuthCredentials | null> {
    if (this.refreshPromise) return this.refreshPromise;
    const credentials = this.getCredentials();
    if (credentials === null || !credentials.isExpired(this.now())) return credentials;
    const generation = this.generation;
    this.refreshPromise = (async () => {
      const tokens = await this.tokenRequest(
        {
          grant_type: 'refresh_token',
          refresh_token: credentials.refresh_token,
        },
        'Token refresh',
      );
      // A late refresh must never resurrect a logged-out account or overwrite a new login.
      const current = this.getCredentials();
      if (generation !== this.generation || current?.refresh_token !== credentials.refresh_token) return current;
      return this.store.updateTokens(
        this.vendor,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in,
        this.now(),
      );
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }
  private async request(path: string, body: Record<string, unknown>): Promise<FetchResponseLike> {
    return this.fetchImpl(`${ISSUER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  private async tokenRequest(
    data: Record<string, string>,
    operation: string,
  ): Promise<z.infer<typeof tokenResponseSchema>> {
    const response = await this.fetchImpl(`${ISSUER}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...data, client_id: CLIENT_ID }).toString(),
    });
    if (!response.ok) throw new Error(`${operation} failed: ${response.status}`);
    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid token response from OpenAI');
    return parsed.data;
  }
  async startDeviceLogin(): Promise<DeviceCode> {
    const response = await this.request('/api/accounts/deviceauth/usercode', {
      client_id: CLIENT_ID,
    });
    if (!response.ok) {
      if (response.status === 404)
        throw new Error('Device code login is not enabled for this OpenAI server. Use browser login instead.');
      throw new Error(`Device code request failed with status ${response.status}`);
    }
    const data = z
      .object({
        device_auth_id: z.string().min(1),
        user_code: z.string().optional(),
        usercode: z.string().optional(),
        interval: z.union([z.string(), z.number()]).default(5),
      })
      .safeParse(await response.json());
    if (!data.success) throw new Error('Invalid device code response from OpenAI');
    const interval = Number(String(data.data.interval).trim());
    const userCode = data.data.user_code || data.data.usercode;
    if (!userCode || !Number.isInteger(interval)) throw new Error('Invalid device code response from OpenAI');
    return {
      verification_url: `${ISSUER}/codex/device`,
      user_code: userCode,
      device_auth_id: data.data.device_auth_id,
      interval: Math.max(interval, 1),
    };
  }
  async pollDeviceLogin(deviceCode: DeviceCode, options: { persist?: boolean } = {}): Promise<OAuthCredentials | null> {
    const response = await this.request('/api/accounts/deviceauth/token', {
      device_auth_id: deviceCode.device_auth_id,
      user_code: deviceCode.user_code,
    });
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) throw new Error(`Device auth failed with status ${response.status}`);
    const parsed = z
      .object({
        authorization_code: z.string().min(1),
        code_verifier: z.string().min(1),
      })
      .safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid device token response from OpenAI');
    return this.exchangeCode(
      parsed.data.authorization_code,
      `${ISSUER}/deviceauth/callback`,
      parsed.data.code_verifier,
      options.persist ?? true,
    );
  }
  async exchangeCode(code: string, redirectUri: string, verifier: string, persist = true): Promise<OAuthCredentials> {
    const tokens = await this.tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      'Token exchange',
    );
    if (!tokens.refresh_token) throw new Error('Invalid token response from OpenAI');
    const credentials = new OAuthCredentials({
      vendor: this.vendor,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: this.now() + tokens.expires_in * 1000,
    });
    if (persist) this.saveCredentials(credentials);
    return credentials;
  }
  async extractChatGPTAccountId(credentials: OAuthCredentials): Promise<string | null> {
    try {
      const parts = credentials.access_token.split('.');
      if (parts.length !== 3) return null;
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString()) as { alg: string; kid?: string };
      // OpenAI's published JWTs are RSA signed; never accept unsigned or symmetric tokens.
      if (header.alg !== 'RS256') return null;
      if (!this.jwks?.keys.length || this.now() - this.jwks.fetchedAt > 3_600_000) {
        const response = await this.fetchImpl(`${ISSUER}/.well-known/jwks.json`, { method: 'GET', headers: {} });
        if (!response.ok) return null;
        const data = (await response.json()) as { keys: JsonWebKey[] };
        if (!Array.isArray(data.keys)) return null;
        this.jwks = { keys: data.keys, fetchedAt: this.now() };
      }
      const key = this.jwks.keys.find(
        (k) =>
          k.kty === 'RSA' &&
          (header.kid === undefined || k.kid === header.kid) &&
          (k.use === undefined || k.use === 'sig'),
      );
      if (
        !key ||
        !verify(
          'RSA-SHA256',
          Buffer.from(`${headerPart}.${payloadPart}`),
          createPublicKey({ key, format: 'jwk' }),
          Buffer.from(signaturePart, 'base64url'),
        )
      )
        return null;
      const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as Record<string, unknown>;
      const now = this.now() / 1000;
      if (claims.exp !== undefined && (typeof claims.exp !== 'number' || claims.exp <= now)) return null;
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now)) return null;
      const auth = claims['https://api.openai.com/auth'] as { chatgpt_account_id?: unknown } | undefined;
      return typeof auth?.chatgpt_account_id === 'string' && auth.chatgpt_account_id ? auth.chatgpt_account_id : null;
    } catch {
      return null;
    }
  }
}

export const DEFAULT_SYSTEM_MESSAGE =
  'You are OpenHands agent, a helpful AI assistant that can interact with a computer to solve tasks.';
export function injectSystemPrefix(
  inputItems: Record<string, unknown>[],
  prefixContent: Record<string, unknown>,
): void {
  for (const item of inputItems) {
    if (item.type === 'message' && item.role === 'user') {
      const content: unknown[] = Array.isArray(item.content)
        ? (item.content as unknown[])
        : item.content
          ? [item.content]
          : [];
      item.content = [prefixContent, ...content];
      return;
    }
  }
  inputItems.unshift({ role: 'user', content: [prefixContent] });
}
export function transformForSubscription(
  systemChunks: readonly string[],
  inputItems: Record<string, unknown>[],
): [string, Record<string, unknown>[]] {
  if (systemChunks.length)
    injectSystemPrefix(inputItems, {
      type: 'input_text',
      text: `Context (system prompt):\n${systemChunks.join('\n\n---\n\n')}\n\n`,
    });
  return [
    DEFAULT_SYSTEM_MESSAGE,
    inputItems.map((item) => (item.type === 'message' ? { role: item.role, content: item.content || [] } : item)),
  ];
}
