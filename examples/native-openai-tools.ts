import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  FinishTool,
  LocalConversation,
  ToolDefinition,
  conversationExecutionStatus,
  createClientFromProfile,
  llmProfileSchema,
} from '@smolpaws/openhands-agent';
import { z } from 'zod';

import { createExampleLlmSecretStore } from './_shared/exampleProfile.js';

const profile = llmProfileSchema.parse({
  profileId: 'native-openai-tools-example',
  providerId: 'openai',
  model: process.env.OPENAI_TOOL_MODEL?.trim() || 'gpt-5-nano',
  openAiApiMode: 'responses',
  maxOutputTokens: 1_024,
  reasoningEffort: 'low',
});
const store = createExampleLlmSecretStore(profile);

if (store === null) {
  console.log('native-openai-tools: set OPENAI_API_KEY to run this live tool-invocation example.');
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-native-tools-'));
  const target = path.join(root, 'README.md');
  const calls: string[] = [];
  try {
    await writeFile(target, 'ORIGINAL\n', 'utf8');
    const readFileTool = new ToolDefinition({
      name: 'read_file',
      description: 'Read the UTF-8 contents of README.md before editing it.',
      inputSchema: z.object({ path: z.literal('README.md') }).strict(),
      executor: async () => {
        calls.push('read_file');
        return { content: await readFile(target, 'utf8') };
      },
    });
    const editFileTool = new ToolDefinition({
      name: 'edit_file',
      description: 'Replace README.md with the requested UTF-8 content.',
      inputSchema: z.object({ path: z.literal('README.md'), content: z.string() }).strict(),
      executor: async ({ content }) => {
        calls.push('edit_file');
        await writeFile(target, content, 'utf8');
        return { updated: true };
      },
    });
    const conversation = new LocalConversation({
      agent: new Agent({
        llm: await createClientFromProfile(profile, store),
        tools: [readFileTool, editFileTool, FinishTool.create()],
        systemPrompt: 'Use native function tools, never textual imitations. Read README.md, replace it with exactly UPDATED_BY_NATIVE_TOOL followed by a newline, then call finish.',
      }),
      maxIterations: 8,
    });

    conversation.sendMessage('Perform the requested README update and finish only after verifying the edit tool succeeded.');
    await conversation.run();

    const actionNames = conversation.state.events
      .filter((event) => event.kind === 'ActionEvent')
      .map((event) => event.tool_name);
    assert(conversation.state.executionStatus === conversationExecutionStatus.FINISHED, `conversation status was ${conversation.state.executionStatus}`);
    assert(await readFile(target, 'utf8') === 'UPDATED_BY_NATIVE_TOOL\n', 'README.md was not updated by the edit tool');
    assert(calls.includes('read_file'), 'read_file executor was not invoked');
    assert(calls.includes('edit_file'), 'edit_file executor was not invoked');
    assert(actionNames.includes('finish'), 'finish was not invoked as a native tool');

    console.log(JSON.stringify({
      example: 'native-openai-tools',
      model: profile.model,
      execution_status: conversation.state.executionStatus,
      native_action_tools: actionNames,
      read_executor_invoked: true,
      edit_executor_invoked: true,
      file_updated: true,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
