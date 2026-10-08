import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { OPENAI_CODEX_MODELS } from '@smolpaws/openhands-agent';

const target = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
  model: z.string().refine(model => OPENAI_CODEX_MODELS.includes(model)),
  enabled: z.boolean(), reason: z.string().min(1).optional(),
}).strict().refine(value => value.enabled || !!value.reason, 'Disabled targets require a reason');
const config = z.object({ version: z.literal(1), targets: z.array(target).min(1) }).strict()
  .refine(value => new Set(value.targets.map(t => t.id)).size === value.targets.length, 'Duplicate subscription target');
export type SubscriptionTarget = z.infer<typeof target>;
export const parseSubscriptionConfig = (value: unknown) => config.parse(value);
export async function readSubscriptionConfig() {
  return parseSubscriptionConfig(JSON.parse(await readFile(new URL('./subscription-models.json', import.meta.url), 'utf8')));
}
export function subscriptionIdentity(target: SubscriptionTarget) {
  return { target: target.id, model: target.model, route: 'chatgpt-subscription', scenario: 'conversation' };
}
