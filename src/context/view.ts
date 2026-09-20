import {
  condensationSummaryEventSchema,
  messageEventSchema,
  type ActionEvent,
  type Condensation,
  type CondensationRequest,
  type ConversationStateUpdateEvent,
  type Event,
  type LLMConvertibleEvent,
} from '../event/index.js';
import { condensationOperationFailureSchema, condensationRequestDetailsSchema, condensationResetSchema, type CondensationRequestDetails } from '../event/condensation-metadata.js';
import { LLM_REQUEST_BOUNDARY_KEY, llmRequestBoundarySchema, unconsumedUserEventIds } from '../llm/request-history.js';
import { condenseActionSchema, condenseObservationSchema } from '../tool/condense.js';
import { ManipulationIndices } from './manipulation-indices.js';
import { viewProperties } from './view-properties.js';
import { contextWarningMessage } from './context-warnings.js';
import { AGENT_RESET_NOTICE, HARD_RESET_NOTICE } from './reset-notices.js';

export { ManipulationIndices } from './manipulation-indices.js';

export class View {
  readonly events: LLMConvertibleEvent[];
  unhandledCondensationRequest: boolean;
  private readonly history: Event[] = [];
  private propertyHistory: Event[] | null = null;
  private readonly pendingRequests = new Set<string>();
  private readonly abortedRequests = new Set<string>();
  private readonly committedResets = new Set<string>();
  private initialUnhandledRequest: boolean;

  constructor(events: readonly LLMConvertibleEvent[] = [], unhandledCondensationRequest = false) {
    this.events = [...events];
    this.history.push(...events);
    this.initialUnhandledRequest = unhandledCondensationRequest;
    this.unhandledCondensationRequest = unhandledCondensationRequest;
  }

  get length(): number {
    return this.events.length;
  }

  get manipulationIndices(): ManipulationIndices {
    const indices = ManipulationIndices.complete(this.events);
    for (const property of viewProperties) {
      const allowed = property.manipulationIndices(this.events);
      for (const index of indices) if (!allowed.has(index)) indices.delete(index);
    }
    return indices;
  }

  enforceProperties(allEvents: readonly Event[]): void {
    const sourceEvents = this.propertyHistory ?? [...allEvents];
    // Restart after each removal: matching can invalidate a batch, and vice versa.
    while (true) {
      let changed = false;
      for (const property of viewProperties) {
        const removed = property.enforce(this.events, sourceEvents);
        if (removed.size === 0) continue;
        console.warn(`Property ${property.constructor.name} enforced, ${removed.size} events dropped.`);
        const retained = this.events.filter((event) => !removed.has(event.id));
        this.events.length = 0;
        this.events.push(...retained);
        changed = true;
        break;
      }
      if (!changed) return;
    }
  }

  appendEvent(event: Event): void {
    this.history.push(event);
    this.propertyHistory?.push(event);
    switch (event.kind) {
      case 'Condensation':
        this.applyCondensation(event);
        this.pendingRequests.clear();
        this.initialUnhandledRequest = false;
        this.unhandledCondensationRequest = false;
        break;
      case 'ConversationStateUpdateEvent': {
        if (event.key === 'condensation_operation_failure') this.applyRequestFailure(event);
        const warning = contextWarningMessage(event);
        if (warning !== null) this.events.push(warning);
        break;
      }
      case 'CondensationRequest':
        this.pendingRequests.add(event.id);
        this.unhandledCondensationRequest = true;
        break;
      case 'SystemPromptEvent':
      case 'MessageEvent':
      case 'ActionEvent':
      case 'ObservationEvent':
      case 'UserRejectObservation':
      case 'AgentErrorEvent':
      case 'CondensationSummaryEvent':
        this.events.push(event);
        break;
      default:
        break;
    }
  }

  static fromEvents(events: readonly Event[]): View {
    const view = new View();
    for (const event of events) {
      view.appendEvent(event);
    }
    view.enforceProperties(events);
    return view;
  }

  private applyCondensation(condensation: Condensation): void {
    if (condensation.reset !== undefined) {
      const output = this.applyReset(condensation);
      this.events.splice(0, this.events.length, ...output);
      // The validated full reset starts a new tool-loop/batch boundary. Ordinary
      // condensation still compares retained events with its complete source batch.
      this.propertyHistory = [...output];
      return;
    }
    const output = this.events.filter((event) => !condensation.forgotten_event_ids.has(event.id));
    if (condensation.summary !== null && condensation.summary_offset !== null) {
      output.splice(condensation.summary_offset, 0, condensationSummaryEventSchema.parse({
        id: `${condensation.id}-summary`,
        source: condensation.source,
        summary: condensation.summary,
      }));
    }
    this.events.length = 0;
    this.events.push(...output);
  }
  private applyReset(commit: Condensation): LLMConvertibleEvent[] {
    const reset = condensationResetSchema.parse(commit.reset);
    if (this.committedResets.has(reset.request_id)) throw new Error('Reset request was already committed');
    if (this.abortedRequests.has(reset.request_id)) throw new Error('Reset request was aborted after an operation failure');
    const request = this.history.find(event => event.id === reset.request_id);
    if (request?.kind !== 'CondensationRequest' || request.details === undefined) throw new Error('Reset commit has no correlated request');
    const details = condensationRequestDetailsSchema.parse(request.details);
    const inputIndex = details.input_event_id === null ? -1 : this.history.findIndex(event => event.id === details.input_event_id);
    const requestIndex = this.history.indexOf(request);
    if (details.input_event_id !== null && inputIndex < 0 || inputIndex >= requestIndex) throw new Error('Invalid reset input boundary');
    const positions = new Map(this.history.map((event, index) => [event.id, index]));
    const retained = this.events.filter(event => !commit.forgotten_event_ids.has(event.id));
    const fixed = retained.filter(event => event.kind === 'SystemPromptEvent');
    const protectedIds = details.trigger === 'provider_context_window'
      ? this.protectedInput(details, inputIndex) : new Set<string>();
    const pair = details.trigger === 'agent' ? this.resetToolPair(commit, request, details, inputIndex) : [];
    if (details.trigger === 'provider_context_window' && (commit.summary === null || !commit.summary.trim() || commit.summary_offset !== 0)) {
      throw new Error('Hard reset commit requires a usable full-view summary');
    }
    const pairIds = new Set(pair.map(event => event.id));
    const pending = retained.filter(event => event.kind !== 'SystemPromptEvent' && !pairIds.has(event.id));
    if (pending.some(event => !genuineUser(event)
      || !protectedIds.has(event.id) && (positions.get(event.id) ?? -1) <= inputIndex)) throw new Error('Reset retained unexpected old history');
    for (const event of this.events) {
      if (event.kind === 'SystemPromptEvent' && commit.forgotten_event_ids.has(event.id)
        || genuineUser(event) && (protectedIds.has(event.id) || (positions.get(event.id) ?? -1) > inputIndex)
          && commit.forgotten_event_ids.has(event.id)) {
        throw new Error('Reset would discard fixed context or pending input');
      }
    }
    const notice = messageEventSchema.parse({ id: `${commit.id}-notice`, timestamp: commit.timestamp, source: 'environment',
      llm_message: { role: 'user', content: details.trigger === 'agent' ? AGENT_RESET_NOTICE : HARD_RESET_NOTICE } });
    const summary = details.trigger === 'agent' ? [] : [condensationSummaryEventSchema.parse({
      id: `${commit.id}-summary`, timestamp: commit.timestamp, source: 'environment', summary: commit.summary,
    })];
    this.committedResets.add(request.id);
    return [...fixed, notice, ...pair, ...summary, ...pending];
  }

  private resetToolPair(
    commit: Condensation, request: CondensationRequest,
    details: Extract<CondensationRequestDetails, { trigger: 'agent' }>, inputIndex: number,
  ): LLMConvertibleEvent[] {
    const action = this.events.find(event => event.id === details.action_id);
    const observation = this.events.find(event => event.id === details.observation_id);
    if (action?.kind !== 'ActionEvent' || action.tool_name !== 'condense'
      || action.tool_call.name !== action.tool_name || action.tool_call.id !== action.tool_call_id
      || observation?.kind !== 'ObservationEvent' || observation.action_id !== action.id
      || observation.tool_call_id !== action.tool_call_id || observation.tool_name !== 'condense'
      || observation.observation['kind'] !== 'CondenseObservation'
      || commit.summary !== null || commit.summary_offset !== null
      || commit.forgotten_event_ids.has(action.id) || commit.forgotten_event_ids.has(observation.id)) {
      throw new Error('Reset commit does not preserve a successful genuine condense exchange');
    }
    const args = condenseActionSchema.parse(action.action);
    const wireArgs = condenseActionSchema.parse(JSON.parse(action.tool_call.arguments) as unknown);
    const result = condenseObservationSchema.parse(observation.observation);
    if (result.is_error || result.request_id !== request.id
      || wireArgs.message_to_future_self !== args.message_to_future_self
      || result.message_to_future_self !== (args.message_to_future_self ?? null)) {
      throw new Error('Reset tool exchange has inconsistent arguments or observation');
    }
    const actionIndex = this.history.indexOf(action);
    const requestIndex = this.history.indexOf(request);
    if (actionIndex <= inputIndex || actionIndex >= requestIndex || this.history.indexOf(observation) <= requestIndex) throw new Error('Invalid reset tool ordering');
    if (this.history.slice(inputIndex + 1, requestIndex).filter(event => event.kind === 'ActionEvent').length !== 1) throw new Error('Reset requires a sole tool response');
    this.validateAuthoringBoundary(action, details.input_event_id, inputIndex, actionIndex);
    return [action, observation];
  }

  private validateAuthoringBoundary(action: ActionEvent, inputId: string | null, inputIndex: number, actionIndex: number): void {
    const candidates = this.history.flatMap((event, index) => {
      if (event.kind !== 'ConversationStateUpdateEvent' || event.key !== LLM_REQUEST_BOUNDARY_KEY) return [];
      const boundary = llmRequestBoundarySchema.parse(event.value);
      return boundary.response_event_ids.includes(action.id) ? [{ boundary, index }] : [];
    });
    const origin = candidates[0];
    if (candidates.length !== 1 || origin === undefined || origin.boundary.input_event_id !== inputId
      || origin.boundary.response_event_ids.length !== 1 || origin.index <= inputIndex || origin.index >= actionIndex) {
      throw new Error('Reset input boundary does not match the sole authoring response provenance');
    }
  }

  private protectedInput(
    details: Extract<CondensationRequestDetails, { trigger: 'provider_context_window' }>, inputIndex: number,
  ): Set<string> {
    const protectedIds = new Set(details.protected_user_event_ids);
    const activeUsers = new Set(this.events.filter(genuineUser).map(event => event.id));
    if ([...protectedIds].some(id => !activeUsers.has(id))) throw new Error('Reset protected input must reference genuine active user events');
    const inputHistory = this.history.slice(0, inputIndex + 1);
    const inputIds = new Set(inputHistory.map(event => event.id));
    const inputView = this.events.filter(event => inputIds.has(event.id));
    for (const id of unconsumedUserEventIds(inputView, inputHistory)) {
      if (!protectedIds.has(id)) throw new Error('Reset request omitted protected pending user input');
    }
    return protectedIds;
  }

  private applyRequestFailure(event: ConversationStateUpdateEvent): void {
    const failure = condensationOperationFailureSchema.parse(event.value);
    const request = this.history.find(candidate => candidate.id === failure.request_id);
    if (request?.kind !== 'CondensationRequest' || request.details === undefined) throw new Error('Condensation operation failure has no correlated typed request');
    if (this.committedResets.has(request.id)) throw new Error('Cannot abort an already committed reset request');
    this.abortedRequests.add(request.id);
    this.pendingRequests.delete(request.id);
    this.unhandledCondensationRequest = this.initialUnhandledRequest || this.pendingRequests.size > 0;
  }
}

function genuineUser(event: LLMConvertibleEvent): boolean {
  return event.kind === 'MessageEvent' && event.source === 'user' && event.llm_message.role === 'user';
}
