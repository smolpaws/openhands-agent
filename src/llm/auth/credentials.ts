import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const INITIAL_CWD = process.cwd();
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const oauthCredentialsSchema = z.object({
  type: z.literal('oauth').default('oauth'),
  vendor: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().int(),
});
export class OAuthCredentials {
  readonly type = 'oauth' as const;
  vendor: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  constructor(input: z.input<typeof oauthCredentialsSchema>) {
    const parsed = oauthCredentialsSchema.parse(input);
    this.vendor = parsed.vendor;
    this.access_token = parsed.access_token;
    this.refresh_token = parsed.refresh_token;
    this.expires_at = parsed.expires_at;
  }
  isExpired(nowMs = Date.now()): boolean {
    return this.expires_at < nowMs + 60_000;
  }
}
export function getCredentialsDir(): string {
  const configured = process.env.OH_PERSISTENCE_DIR || join(homedir(), '.openhands');
  const expanded =
    configured === '~' ? homedir() : configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
  return join(resolve(INITIAL_CWD, expanded), 'auth');
}

/** OAuth tokens live only in this private, Python-compatible store, never in profiles. */
export class CredentialStore {
  constructor(private readonly directory = getCredentialsDir()) {}
  get credentialsDir(): string {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(this.directory, 0o700);
    return this.directory;
  }
  private file(vendor: string): string {
    if (!/^[A-Za-z0-9_-]+$/u.test(vendor)) throw new Error('Invalid credential vendor');
    return join(this.credentialsDir, `${vendor}_oauth.json`);
  }
  get(vendor: string): OAuthCredentials | null {
    const file = this.file(vendor);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return new OAuthCredentials(oauthCredentialsSchema.parse(JSON.parse(raw)));
    } catch {
      rmSync(file, { force: true });
      return null;
    }
  }
  save(credentials: OAuthCredentials): void {
    const parsed = oauthCredentialsSchema.safeParse(credentials);
    if (!parsed.success) throw new Error('Invalid OAuth credentials');
    const file = this.file(parsed.data.vendor);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(parsed.data, null, 2), {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  delete(vendor: string): boolean {
    try {
      rmSync(this.file(vendor));
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  }
  updateTokens(
    vendor: string,
    accessToken: string,
    refreshToken: string | null | undefined,
    expiresIn: number,
    nowMs = Date.now(),
  ): OAuthCredentials | null {
    const existing = this.get(vendor);
    if (existing === null) return null;
    const updated = new OAuthCredentials({
      vendor,
      access_token: accessToken,
      refresh_token: refreshToken || existing.refresh_token,
      expires_at: nowMs + expiresIn * 1000,
    });
    this.save(updated);
    return updated;
  }
}
