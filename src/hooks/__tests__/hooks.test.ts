import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HookConfig,
  HookDecision,
  HookDefinition,
  HookEventType,
  HookExecutor,
  HookMatcher,
  hookEventSchema,
} from '../index.js';

describe('HookConfig', () => {
  it('normalizes legacy PascalCase hook config and matches tools', () => {
    const config = HookConfig.fromObject({
      hooks: {
        PreToolUse: [
          { matcher: 'terminal', hooks: [{ command: 'echo ok' }] },
          { matcher: '/file_.*/', hooks: [{ command: 'echo file' }] },
        ],
      },
    });

    expect(config.isEmpty()).toBe(false);
    expect(config.getHooksForEvent(HookEventType.PreToolUse, 'terminal')).toHaveLength(1);
    expect(config.getHooksForEvent(HookEventType.PreToolUse, 'file_editor')).toHaveLength(1);
    expect(config.getHooksForEvent(HookEventType.PreToolUse, 'browser')).toHaveLength(0);
  });

  it('validates hook definition field requirements', () => {
    expect(() => new HookDefinition({ type: 'command' })).toThrow(/command/);
    expect(() => new HookDefinition({ type: 'agent', command: 'nope' })).toThrow(/must not/);
    expect(new HookDefinition({ type: 'agent', system_prompt: 'review' }).displayCommand).toBe('agent-hook:review');
  });

  it('loads from project hooks.json and merges configs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-hooks-'));
    try {
      await writeFile(join(root, '.openhands', 'hooks.json'), '{}').catch(async () => {
        await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, '.openhands'), { recursive: true }));
        await writeFile(join(root, '.openhands', 'hooks.json'), JSON.stringify({ PostToolUse: [{ matcher: '*', hooks: [{ command: 'echo post' }] }] }));
      });
      const loaded = await HookConfig.load({ workingDir: root });
      const merged = HookConfig.merge([loaded, HookConfig.fromObject({ Stop: [{ matcher: '*', hooks: [{ command: 'echo stop' }] }] })]);

      expect(loaded.getHooksForEvent(HookEventType.PostToolUse, 'anything')).toHaveLength(1);
      expect(merged?.hasHooksForEvent(HookEventType.Stop)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('HookExecutor and HookManager-like behavior', () => {
  it('executes command hooks with JSON stdin and structured stdout', async () => {
    const executor = new HookExecutor({ workingDir: process.cwd() });
    const event = hookEventSchema.parse({ event_type: HookEventType.PreToolUse, tool_name: 'terminal', tool_input: { command: 'pwd' } });

    const result = await executor.execute(new HookDefinition({ command: 'node -e "process.stdin.resume();process.stdin.on(\'data\',()=>process.stdout.write(JSON.stringify({decision:\'deny\',reason:\'blocked\',additionalContext:\'ctx\'})))"' }), event);

    expect(result.decision).toBe(HookDecision.Deny);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('blocked');
    expect(result.additionalContext).toBe('ctx');
    expect(result.shouldContinue).toBe(false);
  });

  it('treats exit code 2 as blocking and stops executeAll', async () => {
    const executor = new HookExecutor({ workingDir: process.cwd() });
    const event = hookEventSchema.parse({ event_type: HookEventType.PreToolUse, tool_name: 'terminal' });
    const hooks = [new HookDefinition({ command: 'node -e "process.exit(2)"' }), new HookDefinition({ command: 'node -e "process.exit(0)"' })];

    const results = await executor.executeAll(hooks, event, undefined, true);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ blocked: true, exit_code: 2 });
  });
});

describe('HookMatcher', () => {
  it('supports wildcard, exact, explicit regex, and invalid regex fallback', () => {
    expect(new HookMatcher({ matcher: '*' }).matches('anything')).toBe(true);
    expect(new HookMatcher({ matcher: 'terminal' }).matches('terminal')).toBe(true);
    expect(new HookMatcher({ matcher: '/file_.*/' }).matches('file_editor')).toBe(true);
    expect(new HookMatcher({ matcher: '/[/' }).matches('file_editor')).toBe(false);
  });
});
