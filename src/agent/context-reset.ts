import { CondenserCompletionCallbackError, type CondenserContext } from '../context/condenser.js';
import type { LLMSummarizingCondenser } from '../context/llm-summarizing-condenser.js';
import { AGENT_RESET_RECOVERY } from '../context/reset-notices.js';
import { View } from '../context/view.js';
import type { ConversationState } from '../conversation/state.js';
import { agentErrorEventSchema, condensationRequestSchema, condensationSchema, conversationStateUpdateEventSchema,
  observationEventSchema, type ActionEvent, type Condensation, type CondensationRequest, type Event, type LLMConvertibleEvent } from '../event/index.js';
import { condensationOperationFailureSchema } from '../event/condensation-metadata.js';
import type { LLMClient } from '../llm/client.js';
import { hasCompletedLlmRequestAfter, unconsumedUserEventIds } from '../llm/request-history.js';
import { textContent } from '../llm/index.js';
import { condenseObservationSchema, type CondenseExecutionContext } from '../tool/condense.js';
import type { ToolDefinition } from '../tool/index.js';

export const CONDENSATION_FAILURE_KEY = 'condensation_operation_failure';
export type HardCondenser = Pick<LLMSummarizingCondenser, 'hardContextReset'>;

export async function executeCondenseTool(
  tool: ToolDefinition, action: ActionEvent, state: ConversationState, inputEventId: string | null, soleCall: boolean,
): Promise<readonly Event[]> {
  const observation = observationEventSchema.parse({ action_id: action.id, tool_name: action.tool_name,
    tool_call_id: action.tool_call_id, observation: {} });
  const context: CondenseExecutionContext = {
    requestCondensation: async args => {
      if (!soleCall) return condenseObservationSchema.parse({ is_error: true,
        content: [textContent('Call condense as the only tool in a response. No history was cleared; finish your other tools first.')],
        message_to_future_self: args.message_to_future_self ?? null });
      const request = condensationRequestSchema.parse({ details: { version: 1, trigger: 'agent', input_event_id: inputEventId,
        action_id: action.id, observation_id: observation.id } });
      await state.appendEventAsync(request);
      return condenseObservationSchema.parse({ request_id: request.id, message_to_future_self: args.message_to_future_self ?? null,
        content: [textContent(AGENT_RESET_RECOVERY + (args.message_to_future_self === undefined ? '' : `\n\nMessage from your past self:\n${args.message_to_future_self}`))] });
    },
  };
  return [observationEventSchema.parse({ ...observation, observation: await tool.execute(action.action, context) })];
}

/** Resume only a fully durable tool result; never replay tool execution or paid fallback. */
export async function finishPendingContextReset(state: ConversationState): Promise<readonly Event[] | null> {
  const request = pendingRequest(state.events);
  if (request === null) return null;
  const details = request.details!;
  if (details.trigger === 'provider_context_window') {
    const message = 'Hard condensation was interrupted before its commit. History is intact; another automatic recovery requires a successful main-model response.';
    await recordFailure(state, request, message);
    throw new Error(message);
  }
  const observation = state.events.find(event => event.id === details.observation_id);
  if (observation?.kind !== 'ObservationEvent' || observation.observation['is_error'] !== false) {
    const message = 'Condense was interrupted before its result was durable. No history was cleared; the agent can request it again.';
    const emitted: Event[] = [];
    const action = state.pendingActions().find(event => event.id === details.action_id);
    if (action !== undefined) emitted.push(await state.appendEventAsync(agentErrorEventSchema.parse({
      tool_name: action.tool_name, tool_call_id: action.tool_call_id, error: message, classification: { kind: 'internal', retryable: false },
    })));
    emitted.push(await recordFailure(state, request, message));
    return emitted;
  }
  const activeEvents = activeEventsBeforeEnforcement(state.events);
  const inputIndex = inputBoundary(state.events, details.input_event_id);
  const retain = new Set([details.action_id, details.observation_id]);
  const positions = new Map(state.events.map((event, index) => [event.id, index]));
  const forgotten = activeEvents.filter(event => event.kind !== 'SystemPromptEvent' && !retain.has(event.id)
    && !(genuineUser(event) && (positions.get(event.id) ?? -1) > inputIndex));
  const commit = condensationSchema.parse({ forgotten_event_ids: forgotten.map(event => event.id),
    reset: { version: 1, request_id: request.id } });
  // Validate the same representation that restore will replay before committing.
  View.fromEvents([...state.events, commit]);
  return [await state.appendEventAsync(commit)];
}

export async function recoverContextWindow(
  state: ConversationState, history: readonly Event[], inputEventId: string | null,
  main: LLMClient, hardCondenser: HardCondenser, context: CondenserContext,
): Promise<readonly Event[]> {
  let previousRecovery: CondensationRequest | undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index]!;
    if (event.kind === 'CondensationRequest' && event.details?.trigger === 'provider_context_window') {
      previousRecovery = event;
      break;
    }
  }
  if (previousRecovery !== undefined && !hasCompletedLlmRequestAfter(history, previousRecovery.id)) {
    throw new Error('Provider rejected context again after a hard-condensation attempt; recovery stopped without another summarizer call. A successful main-model response is required before automatic recovery can run again.');
  }
  const view = View.fromEvents(history);
  const protectedIds = unconsumedUserEventIds(view.events, history);
  const request = condensationRequestSchema.parse({ details: { version: 1, trigger: 'provider_context_window',
    input_event_id: inputEventId, protected_user_event_ids: [...protectedIds] } });
  const emitted: Event[] = [await state.appendEventAsync(request)];
  let commit: Condensation;
  try {
    const eligible = new View(view.events.filter(event => event.kind !== 'SystemPromptEvent' && !protectedIds.has(event.id)));
    if (eligible.length === 0) throw new Error('No consumed history is available for hard condensation; pending user input was preserved.');
    const summary = await hardCondenser.hardContextReset(eligible, main, context);
    if (summary === null || summary.summary === null || !summary.summary.trim()) throw new Error('Hard condensation did not produce a usable summary; history is intact.');
    // The summary reads valid history; the full reset also discards old raw tool
    // remnants that property enforcement omitted from that summary input.
    const forgotten = activeEventsBeforeEnforcement(history).filter(event => event.kind !== 'SystemPromptEvent' && !protectedIds.has(event.id));
    commit = condensationSchema.parse({ ...summary, forgotten_event_ids: forgotten.map(event => event.id),
      reset: { version: 1, request_id: request.id } });
    View.fromEvents([...state.events, commit]);
  } catch (error) {
    // Record failure before propagating; a later run cannot replay this paid operation.
    const cause = error instanceof CondenserCompletionCallbackError ? error.cause : error;
    await recordFailure(state, request, 'Hard condensation failed before commit. History is intact; automatic recovery will not repeat until a main-model request succeeds.');
    throw cause;
  }
  // A failed acknowledgement can follow a successful durable write. Never append
  // an abort for that uncertain commit; restore resolves the request from the log.
  emitted.push(await state.appendEventAsync(commit));
  return emitted;
}

function pendingRequest(history: readonly Event[]): CondensationRequest | null {
  const done = new Set(history.flatMap(event => event.kind === 'Condensation' && event.reset !== undefined ? [event.reset.request_id]
    : event.kind === 'ConversationStateUpdateEvent' && event.key === CONDENSATION_FAILURE_KEY ? [condensationOperationFailureSchema.parse(event.value).request_id] : []));
  return history.find((event): event is CondensationRequest => event.kind === 'CondensationRequest' && event.details !== undefined && !done.has(event.id)) ?? null;
}

async function recordFailure(state: ConversationState, request: CondensationRequest, error: string): Promise<Event> {
  return state.appendEventAsync(conversationStateUpdateEventSchema.parse({ key: CONDENSATION_FAILURE_KEY,
    value: condensationOperationFailureSchema.parse({ version: 1, request_id: request.id, error }) }));
}

function genuineUser(event: LLMConvertibleEvent): boolean {
  return event.kind === 'MessageEvent' && event.source === 'user' && event.llm_message.role === 'user';
}

function inputBoundary(history: readonly Event[], id: string | null): number {
  const index = id === null ? -1 : history.findIndex(event => event.id === id);
  if (id !== null && index < 0) throw new Error('Reset input boundary is missing from history');
  return index;
}

/** Replay condensation without pruning incomplete historical tool batches. */
function activeEventsBeforeEnforcement(history: readonly Event[]): readonly LLMConvertibleEvent[] {
  const view = new View();
  for (const event of history) view.appendEvent(event);
  return view.events;
}
