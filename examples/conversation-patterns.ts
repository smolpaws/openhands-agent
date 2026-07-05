import { z } from 'zod';

import {
  ConversationState,
  ParallelToolExecutor,
  StuckDetector,
  ToolDefinition,
  actionEventsFromMessage,
  conversationExecutionStatus,
  messageEventSchema,
  messageSchema,
  observationEventSchema,
  reduceTextContent,
  textContent,
  type ActionEvent,
} from '@smolpaws/openhands-agent';

import { explainSkippedExample, getExampleLlmClient } from './_shared/exampleProfile.js';

const llm = await getExampleLlmClient();
if (llm === null) {
  explainSkippedExample('conversation-patterns real LLM turn');
} else {
  const response = await llm.complete([
    messageSchema.parse({ role: 'user', content: [textContent('Reply with exactly: conversation pong')] }),
  ]);
  console.log('realProfileResponse', reduceTextContent(response.message));
}

const one = new ToolDefinition({
  name: 'one',
  description: 'Return one.',
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({ value: z.string() }).strict(),
  executor: () => ({ value: 'one' }),
});
const two = new ToolDefinition({
  name: 'two',
  description: 'Return two.',
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({ value: z.string() }).strict(),
  executor: () => ({ value: 'two' }),
});

const actionMessage = messageSchema.parse({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: 'call-one', name: 'one', arguments: '{}', origin: 'completion' },
    { id: 'call-two', name: 'two', arguments: '{}', origin: 'completion' },
  ],
});
const tools = new Map([
  [one.name, one],
  [two.name, two],
]);
const parallelResults = await new ParallelToolExecutor({ maxConcurrency: 2 }).executeBatch(
  actionEventsFromMessage(actionMessage, 'example-response'),
  runExampleTool,
);
const observations = parallelResults.flat().filter((event) => event.kind === 'ObservationEvent');
console.log('parallelToolResults', observations.map((event) => event.observation));

const state = new ConversationState({ executionStatus: conversationExecutionStatus.RUNNING });
state.executionStatus = conversationExecutionStatus.PAUSED;
console.log('pausedStatus', state.executionStatus);
state.executionStatus = conversationExecutionStatus.IDLE;
console.log('resumedStatus', state.executionStatus);

const stuckState = new ConversationState();
stuckState.appendEvent(messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent('hello')] } }));
stuckState.appendEvent(messageEventSchema.parse({ source: 'agent', llm_message: { role: 'assistant', content: [textContent('thinking')] } }));
stuckState.appendEvent(messageEventSchema.parse({ source: 'agent', llm_message: { role: 'assistant', content: [textContent('still thinking')] } }));
console.log('stuckMonologue', new StuckDetector(stuckState, { monologue: 2 }).isStuck());

const toolObservation = observationEventSchema.parse({
  action_id: 'manual-action',
  tool_name: 'manual',
  tool_call_id: 'manual-call',
  observation: { content: [textContent('manual observation')] },
});
console.log('manualObservationKind', toolObservation.kind);

async function runExampleTool(action: ActionEvent) {
  const tool = tools.get(action.tool_name);
  if (tool === undefined) {
    throw new Error(`Unknown example tool: ${action.tool_name}`);
  }

  return [
    observationEventSchema.parse({
      action_id: action.id,
      tool_name: action.tool_name,
      tool_call_id: action.tool_call_id,
      observation: await tool.execute(action.action),
    }),
  ];
}
