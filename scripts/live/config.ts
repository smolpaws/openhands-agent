import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const targetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
  label: z.string().min(1),
  route: z.enum(['native', 'openrouter', 'openhands-app', 'openhands-eval']),
  enabled: z.boolean(),
  reason: z.string().min(1).optional(),
  scenario: z.enum(['conversation', 'deepseek-accounting', 'anthropic-cache', 'responses-reasoning', 'examples', 'native-openai-tools', 'native-gemini-tools']),
  credential: z.object({ env: z.string().regex(/^[A-Z][A-Z0-9_]*$/u), keychainAccount: z.string().min(1) }).strict(),
  profile: z.object({
    providerId: z.string().min(1), model: z.string().min(1), baseUrl: z.string().url().nullable().optional(),
    openAiApiMode: z.enum(['responses', 'chat_completions']).optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high']).nullable().optional(),
    maxOutputTokens: z.number().int().positive().max(8192).optional(),
    anthropicCacheTtl: z.enum(['5m', '1h']).optional(),
  }).strict(),
  catalog: z.object({ url: z.string().url(), modelId: z.string().optional() }).strict().optional(),
}).strict().refine(t => t.enabled || !!t.reason, 'Disabled targets require a reason').superRefine((target, context) => {
  if (target.scenario === 'conversation') return;
  if (target.scenario === 'responses-reasoning' && target.profile.openAiApiMode === 'chat_completions') {
    context.addIssue({ code: 'custom', path: ['profile', 'openAiApiMode'], message: 'Reasoning replay scenario requires the Responses API' });
  }
  const provider = target.profile.providerId;
  const nativeEndpoints: Record<string, string> = {
    openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com/v1beta', deepseek: 'https://api.deepseek.com',
  };
  const supported = target.scenario === 'anthropic-cache' ? ['anthropic', 'litellm_proxy', 'openrouter']
    : target.scenario === 'deepseek-accounting' ? ['deepseek']
    : target.scenario === 'native-gemini-tools' ? ['gemini']
    : target.scenario === 'examples' ? ['openai', 'anthropic', 'gemini'] : ['openai'];
  if (!supported.includes(provider)) {
    context.addIssue({ code: 'custom', path: ['profile', 'providerId'], message: 'Scenario does not support this provider; its example could skip without running' });
  }
  // These old scripts choose native endpoints internally. Refuse misleading
  // proxy records rather than claiming to test an endpoint they never use.
  if (target.scenario !== 'anthropic-cache') {
    if (target.route !== 'native') context.addIssue({ code: 'custom', path: ['route'], message: 'Scenario requires a native route' });
    const endpoint = target.profile.baseUrl?.replace(/\/+$/u, '');
    if (endpoint && endpoint !== nativeEndpoints[provider]) {
      context.addIssue({ code: 'custom', path: ['profile', 'baseUrl'], message: 'Scenario uses its native endpoint and cannot honor this override' });
    }
  }
});

const configSchema = z.object({
  version: z.literal(1), updated: z.string(), sources: z.array(z.string().url()), targets: z.array(targetSchema).min(1),
}).strict();
export type LiveTarget = z.infer<typeof targetSchema>;
export type LiveConfig = z.infer<typeof configSchema>;
export type Status = 'passed' | 'failed' | 'unavailable' | 'disabled';

export function parseConfig(value: unknown): LiveConfig {
  const config = configSchema.parse(value);
  const ids = new Set<string>();
  for (const target of config.targets) {
    if (ids.has(target.id)) throw new Error(`Duplicate target: ${target.id}`);
    ids.add(target.id);
  }
  return config;
}

export async function readConfig(path: string | URL = new URL('./models.json', import.meta.url)): Promise<LiveConfig> {
  return parseConfig(JSON.parse(await readFile(path, 'utf8')));
}

export function selectTargets(config: LiveConfig, id?: string): LiveTarget[] {
  if (!id) return config.targets.filter(t => t.enabled);
  const target = config.targets.find(t => t.id === id);
  if (!target) throw new Error(`Unknown target: ${id}`);
  return [target];
}

export function resultExitCode(results: readonly { status: Status }[]): number {
  if (results.some(r => r.status === 'failed')) return 1;
  return results.length === 0 || results.some(r => r.status !== 'passed') ? 2 : 0;
}
