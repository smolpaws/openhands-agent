import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
