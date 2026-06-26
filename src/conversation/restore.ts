import { eventSchema, type Event } from '../event/index.js';
import { ConversationState, conversationExecutionStatus, type ConversationExecutionStatus } from './state.js';

export interface DroppedEventFields {
  readonly index: number;
  readonly fields: readonly string[];
}

export interface ConversationRestoreResult {
  readonly state: ConversationState;
  readonly droppedStateFields: readonly string[];
  readonly droppedEventFields: readonly DroppedEventFields[];
}

const unsupportedStateFields = new Set([
  'confirmation_policy',
  'security_analyzer',
  'secret_registry',
]);

const unsupportedEventFields = new Set([
  'critic_result',
  'security_risk',
  'summary',
]);

export function restoreConversationState(payload: unknown): ConversationRestoreResult {
  const source = Array.isArray(payload) ? { events: payload } : recordOrThrow(payload, 'conversation restore payload');
  const droppedStateFields = sortedKeys(source, unsupportedStateFields);
  const droppedEventFields: DroppedEventFields[] = [];
  const eventPayloads = Array.isArray(source.events) ? source.events : [];
  const events = eventPayloads.map((event, index) => migrateEvent(event, index, droppedEventFields));
  const executionStatus = parseExecutionStatus(source.executionStatus ?? source.execution_status);

  return {
    state: new ConversationState({ events, executionStatus }),
    droppedStateFields,
    droppedEventFields,
  };
}

function migrateEvent(payload: unknown, index: number, droppedEventFields: DroppedEventFields[]): Event {
  const event = { ...recordOrThrow(payload, `event ${index}`) };
  const dropped = sortedKeys(event, unsupportedEventFields);
  for (const field of dropped) {
    delete event[field];
  }

  if (isRecord(event.tool_call)) {
    const toolCall = { ...event.tool_call };
    if (Object.hasOwn(toolCall, 'security_risk')) {
      delete toolCall.security_risk;
      dropped.push('tool_call.security_risk');
    }
    event.tool_call = toolCall;
  }

  if (event.kind === 'ActionEvent' && !isRecord(event.action)) {
    event.action = actionFromToolCall(event.tool_call);
  }

  if (dropped.length > 0) {
    droppedEventFields.push({ index, fields: dropped });
  }

  return eventSchema.parse(event);
}

function parseExecutionStatus(value: unknown): ConversationExecutionStatus {
  if (typeof value === 'string' && Object.values(conversationExecutionStatus).includes(value as ConversationExecutionStatus)) {
    return value as ConversationExecutionStatus;
  }
  return conversationExecutionStatus.IDLE;
}

function actionFromToolCall(toolCall: unknown): Record<string, unknown> {
  if (!isRecord(toolCall) || typeof toolCall.arguments !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    return { arguments: toolCall.arguments };
  }
  return { arguments: toolCall.arguments };
}

function sortedKeys(record: Readonly<Record<string, unknown>>, fields: ReadonlySet<string>): string[] {
  return Object.keys(record).filter((key) => fields.has(key)).sort();
}

function recordOrThrow(value: unknown, name: string): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  throw new TypeError(`${name} must be an object`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
