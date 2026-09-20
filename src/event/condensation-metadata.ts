import { z } from 'zod';

const eventIdSchema = z.string().min(1);
const requestFields = {
  version: z.literal(1),
  input_event_id: eventIdSchema.nullable().default(null),
};

/** EXT-SDK-004: request provenance is durable; it is not inferred from a boolean. */
export const condensationRequestDetailsSchema = z.discriminatedUnion('trigger', [
  z.object({
    ...requestFields,
    trigger: z.literal('agent'),
    action_id: eventIdSchema,
    observation_id: eventIdSchema,
  }).strict().refine(details => details.action_id !== details.observation_id
    && details.input_event_id !== details.action_id && details.input_event_id !== details.observation_id,
  'Reset input, action and observation must have distinct event IDs'),
  z.object({
    ...requestFields,
    trigger: z.literal('provider_context_window'),
    protected_user_event_ids: z.array(eventIdSchema).refine(ids => new Set(ids).size === ids.length,
      'Protected user event IDs must be unique'),
  }).strict(),
]);

/** One Condensation is the commit; references resolve against the append-only log. */
export const condensationResetSchema = z.object({
  version: z.literal(1),
  request_id: eventIdSchema,
}).strict();

export const condensationOperationFailureSchema = z.object({
  version: z.literal(1),
  request_id: eventIdSchema,
  error: z.string(),
}).strict();

export type CondensationRequestDetails = z.infer<typeof condensationRequestDetailsSchema>;
