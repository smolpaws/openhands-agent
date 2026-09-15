import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildAuthorizeUrl,
  DEFAULT_OAUTH_PORT,
  DEVICE_CODE_TIMEOUT_SECONDS,
  generatePKCE,
  OAUTH_TIMEOUT_SECONDS,
  type DeviceCode,
  type OpenAISubscriptionAuth,
} from './openai.js';
import type { OAuthCredentials } from './credentials.js';

export type SubscriptionLoginOptions = {
  authMethod?: 'browser' | 'device_code';
  oauthPort?: number;
  timeoutSeconds?: number;
  /** The host displays consent and opens/displays this URL. No credentials are logged. */
  onAuthorize?: (url: string) => void | Promise<void>;
  /** The host privately displays the one-time code and verification URL. */
  onDeviceCode?: (code: DeviceCode) => void | Promise<void>;
};

export async function login(
  auth: OpenAISubscriptionAuth,
  options: SubscriptionLoginOptions,
): Promise<OAuthCredentials> {
  if (options.authMethod === 'device_code') {
    if (!options.onDeviceCode) throw new Error('Device login requires an onDeviceCode display callback');
    const device = await auth.startDeviceLogin();
    await options.onDeviceCode(device);
    const deadline = performance.now() + (options.timeoutSeconds ?? DEVICE_CODE_TIMEOUT_SECONDS) * 1000;
    while (performance.now() < deadline) {
      const credentials = await auth.pollDeviceLogin(device);
      if (credentials) return credentials;
      await delay(Math.min(device.interval * 1000, Math.max(0, deadline - performance.now())));
    }
    throw new Error('Device auth timed out');
  }
  if (options.authMethod !== undefined && options.authMethod !== 'browser')
    throw new Error('Unsupported OpenAI auth method');
  if (!options.onAuthorize) throw new Error('Browser login requires an onAuthorize callback');
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(32).toString('base64url');
  let resolve!: (credentials: OAuthCredentials) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<OAuthCredentials>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let redirectUri = '';
  let handling = false;
  let active = true;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/auth/callback') {
      response.writeHead(404).end();
      return;
    }
    if (handling) {
      response.writeHead(409).end();
      return;
    }
    handling = true;
    const fail = (message: string, status = 400): void => {
      response
        .writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Authorization failed. Return to OpenHands.');
      reject(new Error(message));
    };
    if (url.searchParams.has('error')) {
      fail('OpenAI authorization failed');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      fail('Missing authorization code');
      return;
    }
    if (url.searchParams.get('state') !== state) {
      fail('Invalid state - potential CSRF attack');
      return;
    }
    auth
      .exchangeCode(code, redirectUri, verifier, false)
      .then((credentials) => {
        if (!active) return;
        auth.saveCredentials(credentials);
        response
          .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Authorization successful. You can return to OpenHands.');
        resolve(credentials);
      })
      .catch(() => {
        fail('OpenAI token exchange failed', 500);
      });
  });
  const port = options.oauthPort ?? Number(process.env.OPENHANDS_OAUTH_PORT || DEFAULT_OAUTH_PORT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((yes, no) => {
      server.once('error', no);
      server.listen(port, '127.0.0.1', yes);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not start OAuth callback server');
    redirectUri = `http://localhost:${address.port}/auth/callback`;
    timer = setTimeout(
      () => reject(new Error('OAuth callback timeout - authorization took too long')),
      (options.timeoutSeconds ?? OAUTH_TIMEOUT_SECONDS) * 1000,
    );
    const [credentials] = await Promise.all([
      result,
      options.onAuthorize(buildAuthorizeUrl(redirectUri, challenge, state)),
    ]);
    return credentials;
  } finally {
    active = false;
    clearTimeout(timer);
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  }
}
