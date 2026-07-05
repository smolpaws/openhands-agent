import { z } from 'zod';

import {
  Agent,
  ConversationState,
  LocalConversation,
  StuckDetector,
  ToolDefinition,
  llmProfileSchema,
  messageEventSchema,
  messageSchema,
  observationEventSchema,
  textContent,
  type LLMClient,
  type Message,
} from '@smolpaws/openhands-agent';

const scriptedLlm = (script: readonly Message[]): LLMClient => {
  const responses = [...script];
  return {
    profile: llmProfileSchema.parse({ profileId: 'example', providerId: 'mock', model: 'mock' }),
    async complete() {
      const message = responses.shift();
      if (message === undefined) {
        return { message: messageSchema.parse({ role: 'assistant', content: 'No scripted response left.' }), usage: null, raw: {} };
      }
      return { message, usage: null, raw: {} };
    },
  };
};

const responses: Message[] = [
  messageSchema.parse({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call-one', name: 'one', arguments: '{}', origin: 'completion' },
      { id: 'call-two', name: 'two', arguments: '{}', origin: 'completion' },
    ],
  }),
];

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

const state = new ConversationState();
const conversation = new LocalConversation({
  agent: new Agent({ llm: scriptedLlm(responses), tools: [one, two], toolConcurrencyLimit: 2 }),
  state,
});

conversation.sendMessage('Run both tools in parallel.');
conversation.pause();
await conversation.run();
console.log('pausedEvents', state.events.length);
conversation.resume();
await conversation.run();

const observations = state.events.filter((event) => event.kind === 'ObservationEvent');
console.log('parallelToolResults', observations.map((event) => event.observation));

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
