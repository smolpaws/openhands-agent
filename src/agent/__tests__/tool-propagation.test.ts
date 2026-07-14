import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConversationState } from '../../conversation/index.js';
import { llmProfileSchema, messageSchema } from '../../llm/index.js';
import type { LLMClient, LLMCompletionResponse } from '../../llm/client.js';
import { ToolDefinition } from '../../tool/index.js';
import { Agent } from '../agent.js';

describe('Agent tool propagation', () => {
  it('passes exactly usable tools and dispatches returned calls to the real tool', async () => {
    const executions: string[] = [];
    const usable = new ToolDefinition({
      name: 'record_value',
      description: 'Record one value.',
      inputSchema: z.object({ value: z.string() }).strict(),
      executor: ({ value }) => {
        executions.push(value);
        return { recorded: value };
      },
    });
    const unusable = new ToolDefinition({
      name: 'hidden_tool',
      description: 'Must not be advertised.',
      inputSchema: z.object({}).strict(),
      usable: false,
    });
    let receivedTools: readonly ToolDefinition[] | undefined;
    const llm: LLMClient = {
      profile: llmProfileSchema.parse({ profileId: 'test', providerId: 'test', model: 'test' }),
      async complete(_messages, tools): Promise<LLMCompletionResponse> {
        receivedTools = tools;
        return {
          message: messageSchema.parse({
            role: 'assistant',
            content: [],
            tool_calls: [{ id: 'call-1', responses_item_id: null, name: 'record_value', arguments: '{"value":"from-llm"}', origin: 'completion' }],
          }),
          usage: null,
        };
      },
    };
    const agent = new Agent({ llm, tools: [usable, unusable] });

    const events = await agent.step(new ConversationState());

    expect(receivedTools).toEqual([usable]);
    expect(executions).toEqual(['from-llm']);
    expect(events.map((event) => event.kind)).toEqual(['ActionEvent', 'ObservationEvent']);
    expect(events[1]).toMatchObject({
      kind: 'ObservationEvent',
      tool_name: 'record_value',
      observation: { recorded: 'from-llm' },
    });
  });
});
