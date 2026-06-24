import { HookConfig, HookManager, HookTriggerEventType } from '@smolpaws/openhands-agent';

const config = new HookConfig({
  pre_tool_use: [
    {
      matcher: 'terminal',
      hooks: [
        {
          command: `node -e "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ decision: 'allow', additionalContext: 'terminal command allowed by example hook' })))"`,
          timeout: 5,
        },
      ],
    },
  ],
});

const manager = new HookManager({ config, sessionId: 'example-session', workingDir: process.cwd() });
const hooks = config.getHooksForEvent(HookTriggerEventType.PreToolUse, 'terminal');
const result = await manager.runPreToolUse('terminal', { command: 'pwd' });

console.log({
  hookCount: hooks.length,
  shouldContinue: result.shouldContinue,
  additionalContext: result.results[0]?.additionalContext,
});
