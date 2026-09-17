import {
  Agent,
  FinishTool,
  LocalConversation,
  ToolDefinition,
  conversationExecutionStatus,
  createClientFromProfile,
} from '@smolpaws/openhands-agent';
import { z } from 'zod';

import { createExampleLlmSecretStore, resolveExampleLlmProfile } from './_shared/exampleProfile.js';

const profile = resolveExampleLlmProfile({
  profileId: 'native-gemini-tools-example',
  providerId: 'gemini',
  model: process.env.GEMINI_TOOL_MODEL?.trim() || 'gemini-3.5-flash-lite',
  maxOutputTokens: 512,
  reasoningEffort: 'low',
});
const store = createExampleLlmSecretStore(profile);

if (store === null) {
  console.log('native-gemini-tools: set GEMINI_API_KEY to run this live tool-invocation example.');
} else {
  const calls: string[] = [];
  const lookupValue = new ToolDefinition({
    name: 'lookup_value',
    description: 'Return the exact verification value. Call this before finish.',
    inputSchema: z.object({ key: z.literal('verification') }).strict(),
    executor: async () => {
      calls.push('lookup_value');
      return { value: 'GEMINI_NATIVE_TOOL_OK' };
    },
  });
  const conversation = new LocalConversation({
    agent: new Agent({
      llm: await createClientFromProfile(profile, store),
      tools: [lookupValue, FinishTool.create()],
      systemPrompt: 'Use native function tools, never textual imitations. Call lookup_value with key verification, then call finish with the returned value.',
    }),
    maxIterations: 5,
  });

  conversation.sendMessage('Look up the verification value and finish with it.');
  await conversation.run();

  const actionEvents = conversation.state.events.filter((event) => event.kind === 'ActionEvent');
  const actionNames = actionEvents.map((event) => event.tool_name);
  const signedThoughtCount = actionEvents.flatMap((event) => event.thinking_blocks)
    .filter((block) => block.type === 'thinking' && block.signature !== null)
    .length;
  assert(conversation.state.executionStatus === conversationExecutionStatus.FINISHED, `conversation status was ${conversation.state.executionStatus}`);
  assert(calls.includes('lookup_value'), 'lookup_value executor was not invoked');
  assert(actionNames.includes('finish'), 'finish was not invoked as a native tool');
  assert(signedThoughtCount > 0, 'Gemini returned no signed thought step to replay');

  console.log(JSON.stringify({
    example: 'native-gemini-tools',
    model: profile.model,
    execution_status: conversation.state.executionStatus,
    native_action_tools: actionNames,
    signed_thought_blocks: signedThoughtCount,
  }));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
