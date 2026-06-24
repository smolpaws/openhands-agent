import { describe, expect, it } from 'vitest';

import { Agent } from '../agent.js';
import { ConversationState, messageEventSchema, textContent, type LLMClient } from '../../index.js';
import { AgentContext, type Condenser } from '../../context/index.js';
import { condensationSchema } from '../../event/index.js';
import { skillSchema } from '../../skills/index.js';

describe('Agent context and condenser integration', () => {
  it('prepends rendered context to LLM messages', async () => {
    const llm = recordingLlm();
    const context = new AgentContext({
      currentDatetime: '2026-01-01T00:00:00Z',
      skills: [skillSchema.parse({ name: 'repo', content: 'Repo context.' })],
    });
    const agent = new Agent({ llm, context, systemPrompt: 'Base system.' });
    const state = new ConversationState({ events: [messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent('hello')] } })] });

    await agent.step(state);

    expect(llm.messages[0]?.role).toBe('system');
    expect(llm.messages[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Base system.') });
    expect(llm.messages[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Repo context.') });
  });

  it('emits condensation without calling the LLM when condenser requests it', async () => {
    const llm = recordingLlm();
    const condensation = condensationSchema.parse({ forgotten_event_ids: [], llm_response_id: 'resp-1' });
    const condenser: Condenser = { condense: () => condensation };
    const agent = new Agent({ llm, condenser });
    const state = new ConversationState();

    const events = await agent.step(state);

    expect(events).toEqual([condensation]);
    expect(state.events).toEqual([condensation]);
    expect(llm.messages).toEqual([]);
  });
});

function recordingLlm(): LLMClient & { messages: Parameters<LLMClient['complete']>[0] } {
  const messages: Parameters<LLMClient['complete']>[0] = [];
  return {
    messages,
    async complete(input) {
      messages.splice(0, messages.length, ...input);
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [textContent('done')], tool_calls: null, tool_call_id: null, name: null, reasoning_content: null, thinking_blocks: [], responses_reasoning_item: null },
        usage: null,
        raw: null,
      };
    },
  };
}
