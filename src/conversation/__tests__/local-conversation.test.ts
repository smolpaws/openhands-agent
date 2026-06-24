import { describe, expect, it } from 'vitest';

import { Agent } from '../../agent/index.js';
import { messageEventSchema, type Event } from '../../event/index.js';
import type { LLMClient, LLMCompletionResponse } from '../../llm/client.js';
import { textContent, type LLMProfile, type Message } from '../../llm/index.js';
import { FinishTool, ThinkTool } from '../../tool/builtins.js';
import { conversationExecutionStatus } from '../state.js';
import { LocalConversation } from '../local-conversation.js';

describe('LocalConversation', () => {
  it('runs agent steps until finish tool marks the conversation finished', async () => {
    const llm = new FakeLLM([
      {
        message: assistantToolCall('finish', 'call-finish', { message: 'done' }),
        usage: null,
      },
    ]);
    const agent = new Agent({ llm, tools: [FinishTool.create(), ThinkTool.create()] });
    const conversation = new LocalConversation({ agent, maxIterations: 3 });

    conversation.sendMessage('please finish');
    await conversation.run();

    expect(conversation.state.executionStatus).toBe(conversationExecutionStatus.FINISHED);
    expect(conversation.state.events.map((event) => event.kind)).toEqual(['MessageEvent', 'ActionEvent', 'ObservationEvent']);
    expect(conversation.state.events[2]).toMatchObject({ kind: 'ObservationEvent', tool_name: 'finish', observation: { text: 'done' } });
    expect(llm.requests[0]?.map((message) => message.role)).toEqual(['user']);
  });

  it('continues after non-final content until max iterations is reached', async () => {
    const llm = new FakeLLM([
      { message: assistantContent('still working'), usage: null },
      { message: assistantContent('still working'), usage: null },
    ]);
    const agent = new Agent({ llm, tools: [FinishTool.create()] });
    const conversation = new LocalConversation({ agent, maxIterations: 2 });

    conversation.sendMessage('loop');
    await conversation.run();

    expect(conversation.state.executionStatus).toBe(conversationExecutionStatus.ERROR);
    expect(conversation.state.events.at(-1)).toMatchObject({ kind: 'ConversationErrorEvent', code: 'MaxIterationsReached' });
  });

  it('can pause before a run and resume from paused status', async () => {
    const llm = new FakeLLM([{ message: assistantToolCall('finish', 'call-finish', { message: 'done' }), usage: null }]);
    const conversation = new LocalConversation({ agent: new Agent({ llm, tools: [FinishTool.create()] }) });

    conversation.pause();
    await conversation.run();
    expect(conversation.state.executionStatus).toBe(conversationExecutionStatus.PAUSED);

    conversation.resume();
    await conversation.run();
    expect(conversation.state.executionStatus).toBe(conversationExecutionStatus.FINISHED);
  });

  it('marks the run stuck before another step when stuck patterns are detected', async () => {
    const llm = new FakeLLM([]);
    const conversation = new LocalConversation({
      agent: new Agent({ llm, tools: [FinishTool.create()] }),
      stuckDetection: { monologue: 2 },
    });
    conversation.state.appendEvent(agentMessage('again'));
    conversation.state.appendEvent(agentMessage('again'));

    await conversation.run();

    expect(conversation.state.executionStatus).toBe(conversationExecutionStatus.STUCK);
    expect(llm.requests).toHaveLength(0);
  });

});

class FakeLLM implements LLMClient {
  readonly profile: LLMProfile = { profileId: 'fake', providerId: 'fake', model: 'fake', baseUrl: null, openAiApiMode: 'chat_completions', temperature: null, topP: null, topK: null, maxInputTokens: null, maxOutputTokens: null, timeoutSeconds: null, reasoningEffort: null, reasoningSummary: null, headers: {}, useProfileKeyOverride: false };


  readonly requests: readonly Message[][] = [];
  private readonly responses: LLMCompletionResponse[];

  constructor(responses: readonly LLMCompletionResponse[]) {
    this.responses = [...responses];
  }

  async complete(messages: readonly Message[]): Promise<LLMCompletionResponse> {
    (this.requests as Message[][]).push([...messages]);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error('FakeLLM exhausted');
    }
    return next;
  }
}

function assistantContent(text: string): Message {
  return {
    role: 'assistant',
    content: [textContent(text)],
    tool_calls: null,
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}

function assistantToolCall(name: string, id: string, args: Record<string, unknown>): Message {
  return {
    ...assistantContent(''),
    tool_calls: [{ id, name, arguments: JSON.stringify(args), origin: 'completion' }],
  };
}

function agentMessage(text: string): Event {
  return messageEventSchema.parse({ source: 'agent', llm_message: assistantContent(text) });
}

