import { describe, expect, it } from 'vitest';

import { actionEventSchema } from '../../event/index.js';
import { AgentFinishedCritic, CriticResult, EmptyPatchCritic, PassCritic } from '../index.js';

describe('CriticResult', () => {
  it('reports success above threshold and renders stars', () => {
    const result = new CriticResult({ score: 0.61, message: 'ok' });

    expect(result.success).toBe(true);
    expect(result.starRating).toBe('★★★☆☆');
    expect(result.visualize()).toContain('61.0%');
  });
});

describe('simple critics', () => {
  it('PassCritic always succeeds', () => {
    expect(new PassCritic().evaluate([])).toMatchObject({ score: 1, message: 'PassCritic always succeeds' });
  });

  it('EmptyPatchCritic scores based on patch presence', () => {
    const critic = new EmptyPatchCritic();
    expect(critic.evaluate([], '').success).toBe(false);
    expect(critic.evaluate([], 'diff --git a/file b/file').success).toBe(true);
  });

  it('AgentFinishedCritic requires a non-empty patch and last action to be finish', () => {
    const critic = new AgentFinishedCritic();
    const finish = actionEventSchema.parse({ tool_name: 'FinishTool', tool_call_id: 'call-1', tool_call: { id: 'call-1', name: 'FinishTool', arguments: '{}', origin: 'completion' }, action: { message: 'done' } });
    const terminal = actionEventSchema.parse({ tool_name: 'TerminalTool', tool_call_id: 'call-2', tool_call: { id: 'call-2', name: 'TerminalTool', arguments: '{}', origin: 'completion' }, action: { command: 'pwd' } });

    expect(critic.evaluate([finish], '').success).toBe(false);
    expect(critic.evaluate([finish], 'diff').success).toBe(true);
    expect(critic.evaluate([finish, terminal], 'diff').success).toBe(false);
  });
});
