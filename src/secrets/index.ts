import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

export const OPENHANDS_KEYRING_SERVICE = 'openhands';

export const secretRefSchema = z
  .object({
    service: z.string().min(1).default(OPENHANDS_KEYRING_SERVICE),
    account: z.string().min(1),
  })
  .strict();

export type SecretRef = z.infer<typeof secretRefSchema>;

export interface SecretStore {
  get(ref: SecretRef): Promise<string | null>;
  set(ref: SecretRef, value: string): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  has(ref: SecretRef): Promise<boolean>;
}

export interface LlmApiKeyLookup {
  readonly providerId: string;
  readonly profileId?: string;
  readonly useProfileKeyOverride?: boolean;
}

const execFileAsync = promisify(execFile);

export function llmProviderSecretRef(providerId: string): SecretRef {
  return secretRefSchema.parse({ account: `llm-provider:${providerId}` });
}

export function llmProfileSecretRef(profileId: string): SecretRef {
  return secretRefSchema.parse({ account: `llm-profile:${profileId}:api-key` });
}

export async function resolveLlmApiKeyRef(lookup: LlmApiKeyLookup, store: SecretStore): Promise<SecretRef | null> {
  if (lookup.useProfileKeyOverride === true && lookup.profileId !== undefined) {
    const profileRef = llmProfileSecretRef(lookup.profileId);
    if (await store.has(profileRef)) {
      return profileRef;
    }
  }

  const providerRef = llmProviderSecretRef(lookup.providerId);
  return (await store.has(providerRef)) ? providerRef : null;
}

export async function getLlmApiKey(lookup: LlmApiKeyLookup, store: SecretStore): Promise<string | null> {
  const ref = await resolveLlmApiKeyRef(lookup, store);
  return ref === null ? null : store.get(ref);
}

export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  constructor(entries: Iterable<readonly [SecretRef, string]> = []) {
    for (const [ref, value] of entries) {
      this.secrets.set(secretKey(ref), value);
    }
  }

  get(ref: SecretRef): Promise<string | null> {
    return Promise.resolve(this.secrets.get(secretKey(ref)) ?? null);
  }

  set(ref: SecretRef, value: string): Promise<void> {
    this.secrets.set(secretKey(ref), value);
    return Promise.resolve();
  }

  delete(ref: SecretRef): Promise<void> {
    this.secrets.delete(secretKey(ref));
    return Promise.resolve();
  }

  has(ref: SecretRef): Promise<boolean> {
    return Promise.resolve(this.secrets.has(secretKey(ref)));
  }
}

export class MacOSKeychainSecretStore implements SecretStore {
  async get(ref: SecretRef): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        ref.service,
        '-a',
        ref.account,
        '-w',
      ]);
      return trimOneTrailingNewline(stdout);
    } catch (error) {
      if (isMissingKeychainItemError(error)) {
        return null;
      }
      throw error;
    }
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    await execFileAsync('security', [
      'add-generic-password',
      '-s',
      ref.service,
      '-a',
      ref.account,
      '-w',
      value,
      '-U',
    ]);
  }

  async delete(ref: SecretRef): Promise<void> {
    try {
      await execFileAsync('security', ['delete-generic-password', '-s', ref.service, '-a', ref.account]);
    } catch (error) {
      if (!isMissingKeychainItemError(error)) {
        throw error;
      }
    }
  }

  async has(ref: SecretRef): Promise<boolean> {
    return (await this.get(ref)) !== null;
  }
}

function secretKey(ref: SecretRef): string {
  return `${ref.service}\0${ref.account}`;
}

function trimOneTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function isMissingKeychainItemError(error: unknown): boolean {
  return isExecError(error) && (error.code === 44 || error.stderr.includes('could not be found'));
}

function isExecError(error: unknown): error is { readonly code?: number; readonly stderr: string } {
  return typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string';
}
