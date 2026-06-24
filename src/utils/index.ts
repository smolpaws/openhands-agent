import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_TEXT_CONTENT_LIMIT = 50_000;
export const DEFAULT_TRUNCATE_NOTICE =
  '<response clipped><NOTE>Due to the max output limit, only part of the full response has been shown to you.</NOTE>';

export const DEFAULT_TRUNCATE_NOTICE_WITH_PERSIST =
  '<response clipped><NOTE>Due to the max output limit, only part of the full response has been shown to you. The complete output has been saved to {filePath} - you can use other tools to view the full content (truncated part starts around line {lineNum}).</NOTE>';

export interface MaybeTruncateOptions {
  readonly truncateAfter?: number | null;
  readonly truncateNotice?: string;
  readonly saveDir?: string | null;
  readonly toolPrefix?: string;
}

export function maybeTruncate(content: string, options: MaybeTruncateOptions = {}): string {
  const truncateAfter = options.truncateAfter;
  const truncateNotice = options.truncateNotice ?? DEFAULT_TRUNCATE_NOTICE;

  if (truncateAfter === undefined || truncateAfter === null || truncateAfter <= 0 || content.length <= truncateAfter) {
    return content;
  }

  if (truncateNotice.length >= truncateAfter) {
    return truncateNotice.slice(0, truncateAfter);
  }

  const availableChars = truncateAfter - truncateNotice.length;
  const proposedHead = Math.floor(availableChars / 2) + (availableChars % 2);
  let finalNotice = truncateNotice;

  if (options.saveDir !== undefined && options.saveDir !== null && options.saveDir !== '') {
    const savedFilePath = saveFullContent(content, options.saveDir, options.toolPrefix ?? 'output');
    if (savedFilePath !== null) {
      const headContentLines = content.slice(0, proposedHead).split(/\r?\n/u).length;
      finalNotice = DEFAULT_TRUNCATE_NOTICE_WITH_PERSIST.replace('{filePath}', savedFilePath).replace(
        '{lineNum}',
        String(headContentLines + 1),
      );
    }
  }

  if (finalNotice.length >= truncateAfter) {
    return finalNotice.slice(0, truncateAfter);
  }

  const remaining = truncateAfter - finalNotice.length;
  const headChars = Math.min(proposedHead, remaining);
  const tailChars = remaining - headChars;

  return content.slice(0, headChars) + finalNotice + (tailChars > 0 ? content.slice(-tailChars) : '');
}

function saveFullContent(content: string, saveDir: string, toolPrefix: string): string | null {
  try {
    mkdirSync(saveDir, { recursive: true });
    const contentHash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
    const filePath = path.join(saveDir, `${toolPrefix}_output_${contentHash}.txt`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, 'utf8');
    }
    return filePath;
  } catch {
    return null;
  }
}

export function toPosixPath(inputPath: string | { toString(): string }): string {
  return inputPath.toString().replace(/\\/gu, '/');
}

export function posixPathName(inputPath: string | { toString(): string }): string {
  const normalized = toPosixPath(inputPath).replace(/\/+$/u, '');
  if (normalized.length === 0) {
    return '';
  }
  return normalized.split('/').at(-1) ?? '';
}

const urlSchemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const windowsDriveAbsolutePattern = /^[A-Za-z]:[\\/]/u;

export function isAbsolutePathSource(inputPath: string | { toString(): string }): boolean {
  const value = inputPath.toString().trim();
  if (value.length === 0) {
    return false;
  }
  return value.startsWith('/') || value.startsWith('\\') || path.isAbsolute(value) || windowsDriveAbsolutePattern.test(value);
}

export function isHostAbsolutePath(inputPath: string | { toString(): string }): boolean {
  const value = inputPath.toString().trim();
  return value.length > 0 && path.isAbsolute(value);
}

export function isLocalPathSource(source: string): boolean {
  const value = source.trim();
  if (value.length === 0) {
    return false;
  }
  if (value.startsWith('file://') || value.startsWith('~') || value.startsWith('.')) {
    return true;
  }
  if (isAbsolutePathSource(value)) {
    return true;
  }
  return value.includes('\\') && !urlSchemePattern.test(value);
}

const ZWJ = '\u200d';

export function sanitizeOpenHandsMentions(text: string): string {
  return text.replace(/@(OpenHands)\b/giu, `@${ZWJ}$1`);
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextPageId?: string | null;
}

export async function* pageIterator<T, P extends Record<string, unknown>>(
  searchFunc: (params: P & { pageId?: string }) => Promise<Page<T>>,
  params: P,
): AsyncGenerator<T> {
  let pageId = typeof params.pageId === 'string' ? params.pageId : undefined;
  const rest = { ...params };
  delete rest.pageId;

  while (true) {
    const pageParams = (pageId === undefined ? rest : { ...rest, pageId }) as P & { pageId?: string };
    const page = await searchFunc(pageParams);
    for (const item of page.items) {
      yield item;
    }
    pageId = page.nextPageId ?? undefined;
    if (pageId === undefined || pageId === '') {
      break;
    }
  }
}

const SENSITIVE_ENV_VARS = new Set(['SESSION_API_KEY']);

export function sanitizedEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  for (const key of SENSITIVE_ENV_VARS) {
    delete result[key];
  }

  if (Object.hasOwn(result, 'LD_LIBRARY_PATH_ORIG')) {
    const original = result.LD_LIBRARY_PATH_ORIG;
    if (original === undefined || original === '') {
      delete result.LD_LIBRARY_PATH;
    } else {
      result.LD_LIBRARY_PATH = original;
    }
  }

  return result;
}

export interface ExecuteCommandOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly printOutput?: boolean;
}

export interface CommandResult {
  readonly command: string | readonly string[];
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function executeCommand(command: string | readonly string[], options: ExecuteCommandOptions = {}): CommandResult {
  const shell = typeof command === 'string';
  const executable = shell ? command : command[0];
  if (executable === undefined) {
    throw new Error('Command must not be empty');
  }

  const args = shell ? [] : command.slice(1);
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: sanitizedEnv(options.env),
    shell,
    timeout: options.timeoutMs,
    encoding: 'utf8',
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (options.printOutput ?? true) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }

  return {
    command,
    status: result.error?.name === 'ETIMEDOUT' ? -1 : result.status,
    stdout,
    stderr,
  };
}

export const SECRET_KEY_PATTERNS = new Set([
  'AUTHORIZATION',
  'COOKIE',
  'CREDENTIAL',
  'KEY',
  'PASSWORD',
  'SECRET',
  'SESSION',
  'TOKEN',
]);

export const SENSITIVE_URL_PARAMS = new Set(['tavilyapikey', 'apikey', 'api_key', 'token', 'access_token', 'secret', 'key']);

export function isSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  return [...SECRET_KEY_PATTERNS].some((pattern) => upper.includes(pattern));
}

export function redactUrlCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)([^@/]+)@(.+)$/u, '$1****@$3');
}

const embeddedUrlCredentialsPattern = /(https?:\/\/)[^/@\s]+@/gu;

export function redactUrlCredentialsInText(text: string): string {
  return text.replace(embeddedUrlCredentialsPattern, '$1****@');
}

export function redactUrlParams(url: string): string {
  if (url.length === 0 || !url.includes('?')) {
    return url;
  }

  try {
    const parsed = new URL(url);
    if (parsed.search.length === 0) {
      return url;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAMS.has(key.toLowerCase()) || isSecretKey(key)) {
        const values = parsed.searchParams.getAll(key);
        parsed.searchParams.delete(key);
        for (let index = 0; index < Math.max(1, values.length); index += 1) {
          parsed.searchParams.append(key, '<redacted>');
        }
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

const keyValueSecretPattern = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|authorization|cookie|credential|password|secret|session|token|key)[A-Za-z0-9_.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/giu;
const anthropicKeyPattern = /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/gu;

export function redactTextSecrets(text: string): string {
  return redactUrlCredentialsInText(text)
    .replace(anthropicKeyPattern, '<redacted>')
    .replace(keyValueSecretPattern, (_match: string, key: string) => `${key}=<redacted>`);
}

