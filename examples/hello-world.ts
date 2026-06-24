import {
  Agent,
  ConversationState,
  FinishTool,
  LocalConversation,
  llmProfileSchema,
  messageSchema,
  type Event,
  type LLMClient,
} from '@smolpaws/openhands-agent';

const llm: LLMClient = {
  profile: llmProfileSchema.parse({ profileId: 'example', providerId: 'mock', model: 'mock' }),
  async complete() {
    return {
      message: messageSchema.parse({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'finish-1',
            name: 'finish',
            arguments: JSON.stringify({ message: 'Hello from the TypeScript OpenHands agent.' }),
            origin: 'completion',
          },
        ],
      }),
      usage: null,
      raw: {},
    };
  },
};

const state = new ConversationState();
const conversation = new LocalConversation({
  agent: new Agent({ llm, tools: [FinishTool.create()] }),
  state,
});

conversation.sendMessage('Say hello and finish.');
await conversation.run();

const finalObservation = [...state.events].reverse().find(isFinishObservation);
console.log(finalObservation?.observation.text);

function isFinishObservation(event: Event): event is Extract<Event, { kind: 'ObservationEvent' }> {
  return event.kind === 'ObservationEvent' && event.tool_name === 'finish';
}
