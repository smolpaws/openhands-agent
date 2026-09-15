// Ported from tests/sdk/llm/auth/test_credentials.py and test_openai.py at the canonical pin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  CredentialStore,
  OAuthCredentials,
  OpenAISubscriptionAuth,
  transformForSubscription,
  CLIENT_ID,
  OPENAI_CODEX_MODELS,
} from '../auth/index.js';
import { llmProfileSchema, messageSchema } from '../index.js';
import { createClientFromProfile } from '../factory.js';
import { InMemorySecretStore } from '../../secrets/index.js';
const dirs: string[] = [];
const store = () => new CredentialStore(dirs[dirs.push(mkdtempSync(join(tmpdir(), 'oauth-test-'))) - 1]);
const creds = (expires_at = Date.now() + 3600000) =>
  new OAuthCredentials({
    vendor: 'openai',
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at,
  });
const response = (payload: unknown, status = 200) => ({
  ok: status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
describe('OAuth credentials (Python parity)', () => {
  it('round trips credentials with private permissions and 60 second expiry buffer', () => {
    const s = store(),
      c = creds(61000);
    s.save(c);
    expect(s.get('openai')).toEqual(c);
    expect(c.isExpired(1000)).toBe(false);
    expect(c.isExpired(1001)).toBe(true);
    expect(statSync(s.credentialsDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.credentialsDir, 'openai_oauth.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(s.credentialsDir, 'openai_oauth.json'), 'utf8'))).toEqual({ ...c });
    expect(s.delete('openai')).toBe(true);
    expect(s.delete('openai')).toBe(false);
  });
  it('removes malformed credentials and preserves the refresh token when omitted', () => {
    const s = store();
    writeFileSync(join(s.credentialsDir, 'openai_oauth.json'), '{');
    expect(s.get('openai')).toBeNull();
    s.save(creds());
    expect(s.updateTokens('openai', 'new', null, 3600)?.refresh_token).toBe('refresh');
  });
  it('refreshes expired credentials, coalesces concurrent refresh, and does not leak errors', async () => {
    const s = store();
    s.save(creds(0));
    const fetch = vi.fn(async () => response({ access_token: 'new', expires_in: 3600 }));
    const a = new OpenAISubscriptionAuth({ credentialStore: s, fetch });
    const [c, d] = await Promise.all([a.refreshIfNeeded(), a.refreshIfNeeded()]);
    expect(c?.access_token).toBe('new');
    expect(d).toEqual(c);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(fetch.mock.calls[0]![1].body).get('grant_type')).toBe('refresh_token');
    expect(await a.refreshIfNeeded()).toEqual(c);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not resurrect credentials when logout races a refresh', async () => {
    const s = store();
    s.save(creds(0));
    let release!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const a = new OpenAISubscriptionAuth({
      credentialStore: s,
      fetch: async () => {
        await wait;
        return response({ access_token: 'new' });
      },
    });
    const pending = a.refreshIfNeeded();
    a.logout();
    release();
    expect(await pending).toBeNull();
    expect(s.get('openai')).toBeNull();
  });
  it('starts a device login, treats 403/404 as pending, and exchanges without persisting until requested', async () => {
    const s = store();
    const values = [
      response({ device_auth_id: 'id', usercode: 'ABCD-1234', interval: '2' }),
      response({}, 403),
      response({}, 404),
      response({ authorization_code: 'code', code_verifier: 'verifier' }),
      response({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
      }),
    ];
    const fetch = vi.fn(async () => values.shift()!);
    const a = new OpenAISubscriptionAuth({ credentialStore: s, fetch });
    const d = await a.startDeviceLogin();
    expect(d).toEqual({
      verification_url: 'https://auth.openai.com/codex/device',
      device_auth_id: 'id',
      user_code: 'ABCD-1234',
      interval: 2,
    });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      client_id: CLIENT_ID,
    });
    expect(await a.pollDeviceLogin(d)).toBeNull();
    expect(await a.pollDeviceLogin(d)).toBeNull();
    const c = await a.pollDeviceLogin(d, { persist: false });
    expect(c?.access_token).toBe('access');
    expect(s.get('openai')).toBeNull();
    a.saveCredentials(c!);
    expect(a.logout()).toBe(true);
    expect(new URLSearchParams(fetch.mock.calls[4]![1].body).get('redirect_uri')).toBe(
      'https://auth.openai.com/deviceauth/callback',
    );
  });
  it('verifies JWT signature and standard time claims before reading the account id', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test' };
    const jwt = (payload: unknown) => {
      const input =
        Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url') +
        '.' +
        Buffer.from(JSON.stringify(payload)).toString('base64url');
      return input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
    };
    const fetch = vi.fn(async () => response({ keys: [jwk] }));
    const a = new OpenAISubscriptionAuth({ credentialStore: store(), fetch });
    const c = creds();
    c.access_token = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account' },
      exp: Date.now() / 1000 + 3600,
    });
    expect(await a.extractChatGPTAccountId(c)).toBe('account');
    c.access_token = jwt({
      exp: 1,
      'https://api.openai.com/auth': { chatgpt_account_id: 'account' },
    });
    expect(await a.extractChatGPTAccountId(c)).toBeNull();
    c.access_token = c.access_token.slice(0, -8) + 'invalidx';
    expect(await a.extractChatGPTAccountId(c)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('normalizes system context while preserving function and reasoning items', () => {
    expect(
      transformForSubscription(
        ['one', 'two'],
        [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
          { type: 'function_call_output', call_id: 'c', output: 'done' },
        ],
      ),
    ).toEqual([
      'You are OpenHands agent, a helpful AI assistant that can interact with a computer to solve tasks.',
      [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Context (system prompt):\none\n\n---\n\ntwo\n\n',
            },
            { type: 'input_text', text: 'hello' },
          ],
        },
        { type: 'function_call_output', call_id: 'c', output: 'done' },
      ],
    ]);
  });
  it('restores an explicit subscription profile without API keys and streams Codex with refreshed credentials', async () => {
    const s = store();
    s.save(creds());
    const calls: {
      url: string;
      init: { body: string; headers: Readonly<Record<string, string>> };
    }[] = [];
    const fetch = async (url: string, init: any) => {
      calls.push({ url, init });
      return response({ keys: [] });
    };
    const auth = new OpenAISubscriptionAuth({ credentialStore: s, fetch });
    const llmFetch = async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        ...response({}),
        text: async () =>
          `data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } })}\n\n`,
      };
    };
    const p = llmProfileSchema.parse({
      profileId: 'chatgpt',
      providerId: 'openai',
      model: 'openai/gpt-5.5',
      authType: 'subscription',
      temperature: 1,
      maxOutputTokens: 20,
    });
    const client = await createClientFromProfile(p, new InMemorySecretStore(), {
      subscriptionAuth: auth,
      fetch: llmFetch,
    });
    expect(
      (
        await client.complete([
          messageSchema.parse({ role: 'system', content: 'system' }),
          messageSchema.parse({ role: 'user', content: 'hello' }),
        ])
      ).message.content[0],
    ).toMatchObject({ text: 'ok' });
    const call = calls.find((c) => c.url.endsWith('/responses'))!;
    expect(call.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(call.init.headers.authorization).toBe('Bearer access');
    const body = JSON.parse(call.init.body);
    expect(body).toMatchObject({
      model: 'gpt-5.5',
      stream: true,
      store: false,
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(JSON.stringify(client.profile)).not.toContain('access');
    expect(OPENAI_CODEX_MODELS).toContain('gpt-6-astra');
  });
});

// tests/sdk/llm/test_subscription_mode.py: unsupported options, lost streamed output, stale reasoning ids.
import { buildOpenAIResponsesBody } from '../openai.js';
import { readSubscriptionResponse } from '../auth/stream.js';
it('omits subscription-unsupported options and prior reasoning without changing API transport', () => {
  const p = llmProfileSchema.parse({
    profileId: 'sub',
    providerId: 'openai',
    model: 'gpt-5.5',
    authType: 'subscription',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    reasoningEffort: 'high',
    reasoningSummary: 'detailed',
    promptCacheRetention: '24h',
    temperature: 1,
    maxOutputTokens: 10,
  });
  const m = messageSchema.parse({
    role: 'assistant',
    content: 'ok',
    responses_reasoning_item: { id: 'rs_old', encrypted_content: 'encrypted' },
  });
  const body = buildOpenAIResponsesBody(p, [m]);
  for (const key of ['reasoning', 'include', 'temperature', 'max_output_tokens', 'prompt_cache_retention'])
    expect(body).not.toHaveProperty(key);
  expect(JSON.stringify(body)).not.toContain('rs_old');
  expect(m.responses_reasoning_item?.id).toBe('rs_old');
  expect(buildOpenAIResponsesBody({ ...p, authType: 'api_key', baseUrl: null }, [m])).toHaveProperty('include');
});
it('reconstructs empty completed output from output_item.done, including tool calls, over split CRLF frames', async () => {
  const item = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'terminal',
    arguments: '{}',
  };
  const wire = `data: ${JSON.stringify({ type: 'response.output_item.done', item })}\r\n\r\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [], usage: { input_tokens: 1 } } })}\r\n\r\n`;
  const chunks = [...Buffer.from(wire)].map((b) => Uint8Array.of(b));
  const cancel = vi.fn(async () => {});
  const r = {
    ...response({}),
    body: {
      getReader: () => ({
        read: async () => (chunks.length ? { done: false, value: chunks.shift()! } : { done: true }),
        cancel,
      }),
    },
  };
  expect(await readSubscriptionResponse(r)).toEqual({
    output: [item],
    usage: { input_tokens: 1 },
  });
  expect(cancel).toHaveBeenCalledOnce();
});
it('refreshes credentials again between calls on an already-created client', async () => {
  const s = store();
  s.save(creds(100000));
  let now = 0;
  const auth = new OpenAISubscriptionAuth({
    credentialStore: s,
    now: () => now,
    fetch: async () => response({ access_token: 'new', expires_in: 3600 }),
  });
  const headers: unknown[] = [];
  const client = await createClientFromProfile(
    llmProfileSchema.parse({
      profileId: 'sub',
      providerId: 'openai',
      model: 'gpt-5.5',
      authType: 'subscription',
    }),
    new InMemorySecretStore(),
    {
      subscriptionAuth: auth,
      fetch: async (_url, init) => {
        headers.push(init.headers.authorization);
        return {
          ...response({}),
          text: async () => `data: {"type":"response.completed","response":{"output":[]}}\n\n`,
        };
      },
    },
  );
  await client.complete([]);
  now = 90000;
  await client.complete([]);
  expect(headers).toEqual(['Bearer access', 'Bearer new']);
});
import { generatePKCE, buildAuthorizeUrl } from '../auth/index.js';
it('generates unique PKCE pairs and preserves authorization URL fields', () => {
  const a = generatePKCE(),
    b = generatePKCE();
  expect(a.verifier).not.toBe(b.verifier);
  expect(a.challenge).toHaveLength(43);
  const url = new URL(buildAuthorizeUrl('http://localhost:1455/auth/callback', a.challenge, 'state'));
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
  expect(url.searchParams.get('state')).toBe('state');
});
it('browser login validates callback state, exchanges PKCE, persists and closes callback server', async () => {
  const s = store();
  const a = new OpenAISubscriptionAuth({
    credentialStore: s,
    fetch: async () => response({ access_token: 'a', refresh_token: 'r' }),
  });
  let callbackStatus = 0;
  const c = await a.login({
    authMethod: 'browser',
    oauthPort: 0,
    onAuthorize: async (url) => {
      const u = new URL(url);
      const redirect = new URL(u.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', 'code');
      redirect.searchParams.set('state', u.searchParams.get('state')!);
      callbackStatus = (await fetch(redirect)).status;
    },
  });
  expect(c.access_token).toBe('a');
  expect(callbackStatus).toBe(200);
  expect(s.get('openai')?.access_token).toBe('a');
});
it('browser login rejects invalid state without exchanging or storing credentials', async () => {
  const s = store(),
    exchange = vi.fn(async () => response({}));
  const a = new OpenAISubscriptionAuth({ credentialStore: s, fetch: exchange });
  await expect(
    a.login({
      authMethod: 'browser',
      oauthPort: 0,
      onAuthorize: async (url) => {
        const u = new URL(url);
        const redirect = new URL(u.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'code');
        redirect.searchParams.set('state', 'bad');
        await fetch(redirect);
      },
    }),
  ).rejects.toThrow('Invalid state');
  expect(exchange).not.toHaveBeenCalled();
  expect(s.get('openai')).toBeNull();
});
it('subscription ignores stale credential headers and refreshes authoritative request values', async () => {
  const s = store();
  s.save(creds());
  const a = new OpenAISubscriptionAuth({ credentialStore: s });
  const calls: Readonly<Record<string, string>>[] = [];
  const client = await createClientFromProfile(
    llmProfileSchema.parse({
      profileId: 'sub',
      providerId: 'openai',
      model: 'gpt-5.5',
      authType: 'subscription',
      headers: {
        Authorization: 'Bearer stale',
        authorization: 'stale',
        'ChatGPT-Account-ID': 'old',
      },
    }),
    new InMemorySecretStore(),
    {
      subscriptionAuth: a,
      fetch: async (_url, init) => {
        calls.push(init.headers);
        return {
          ...response({}),
          text: async () => `data: {"type":"response.completed","response":{"output":[]}}\n\n`,
        };
      },
    },
  );
  await client.complete([]);
  expect(calls[0]).toHaveProperty('authorization', 'Bearer access');
  expect(calls[0]).not.toHaveProperty('Authorization');
  expect(calls[0]).not.toHaveProperty('ChatGPT-Account-ID');
});
it('does not persist a token exchange that finishes after browser login timed out', async () => {
  const s = store();
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const a = new OpenAISubscriptionAuth({
    credentialStore: s,
    fetch: async () => {
      await wait;
      return response({ access_token: 'late', refresh_token: 'late-refresh' });
    },
  });
  await expect(
    a.login({
      oauthPort: 0,
      timeoutSeconds: 0.02,
      onAuthorize: async (url) => {
        const u = new URL(url),
          redirect = new URL(u.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('code', 'c');
        redirect.searchParams.set('state', u.searchParams.get('state')!);
        await fetch(redirect).catch(() => {});
      },
    }),
  ).rejects.toThrow('timeout');
  release();
  await new Promise((r) => setTimeout(r, 20));
  expect(s.get('openai')).toBeNull();
});

import { getCredentialsDir } from '../auth/index.js';
import { homedir } from 'node:os';
import subscriptionGolden from './fixtures/subscription-transform.json';
it('matches transformations generated by executing the pinned Python functions', () => {
  for (const fixture of subscriptionGolden.cases) {
    expect(transformForSubscription(fixture.system, structuredClone(fixture.input))).toEqual(fixture.expected);
  }
});
it('expands user persistence paths and anchors relative paths before working-directory changes', () => {
  const initial = process.cwd();
  const original = process.env.OH_PERSISTENCE_DIR;
  try {
    process.env.OH_PERSISTENCE_DIR = '~/custom-openhands';
    expect(getCredentialsDir()).toBe(join(homedir(), 'custom-openhands', 'auth'));
    process.env.OH_PERSISTENCE_DIR = 'relative-openhands';
    vi.spyOn(process, 'cwd').mockReturnValue('/different-working-directory');
    expect(getCredentialsDir()).toBe(join(initial, 'relative-openhands', 'auth'));
  } finally {
    if (original === undefined) delete process.env.OH_PERSISTENCE_DIR;
    else process.env.OH_PERSISTENCE_DIR = original;
  }
});
