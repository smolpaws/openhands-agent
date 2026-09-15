import { expect, it } from 'vitest';
import { z } from 'zod';
import { llmProfileSchema } from '../../../llm/index.js';
import { Agent } from '../../../agent/agent.js';
import { ConversationState } from '../../../conversation/index.js';
import { ToolDefinition } from '../../index.js';
import { SendMediaTool } from '../send-media.js';
import { UpdateTaskTool } from '../task-scheduler.js';

it('opted-in tools receive the durable action identity; ordinary executors remain unchanged', async () => {
  for (const enabled of [false, true]) {
    let received: unknown;
    const tool = new ToolDefinition({ name: 'test', description: 'test', inputSchema: z.object({}),
      ...(enabled ? { meta: { smolpaws_execution_context: true } } : {}), executor: (_action, context) => { received = context; return { ok: true }; } });
    const agent = new Agent({ tools: [tool], llm: { profile: llmProfileSchema.parse({ profileId: 'test', providerId: 'test', model: 'test' }), complete: async () => ({ message: {
      role: 'assistant', content: [], tool_calls: [{ id: 'call-1', name: 'test', arguments: '{}', origin: 'completion' }],
      tool_call_id: null, name: null, reasoning_content: null, thinking_blocks: [], responses_reasoning_item: null,
    }, usage: null }) } });
    const state = new ConversationState();
    await agent.step(state);
    const action = state.events.find(e => e.kind === 'ActionEvent');
    expect(received).toEqual(enabled ? { actionEventId: action?.id, toolCallId: 'call-1' } : undefined);
  }
});
it('media and task update validate input and return intent without host I/O', async () => {
  await expect(SendMediaTool.create().execute({ path: '/workspace/voice.ogg', media_type: 'audio', voice_note: true })).resolves.toMatchObject({ is_error: false });
  await expect(SendMediaTool.create().execute({ path: '', media_type: 'audio' })).rejects.toThrow();
  await expect(UpdateTaskTool.create().execute({ task_id: 'task-1', prompt: 'new prompt' })).resolves.toMatchObject({ is_error: false });
});
