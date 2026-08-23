import { describe, expect, it } from 'vitest';

import {
  BROWSER_TOOL_NAME,
  DEFAULT_EXEC_TOOL_NAMES,
  SUB_AGENT_TOOL_NAME,
  defaultToolSpecs,
} from '../defaults.js';

describe('canonical default tool names', () => {
  it('resolves a deterministic exec set without browser', () => {
    expect(defaultToolSpecs()).toEqual([...DEFAULT_EXEC_TOOL_NAMES]);
    expect(defaultToolSpecs()).not.toContain(BROWSER_TOOL_NAME);
    expect(defaultToolSpecs({ enableBrowser: true })).toContain(BROWSER_TOOL_NAME);
  });

  it('appends the sub-agent tool set when enableSubAgents is set', () => {
    expect(defaultToolSpecs({ enableSubAgents: true })).toEqual([...DEFAULT_EXEC_TOOL_NAMES, SUB_AGENT_TOOL_NAME]);
  });

  it('appends browser before sub-agents when both are enabled', () => {
    expect(defaultToolSpecs({ enableBrowser: true, enableSubAgents: true })).toEqual([
      ...DEFAULT_EXEC_TOOL_NAMES,
      BROWSER_TOOL_NAME,
      SUB_AGENT_TOOL_NAME,
    ]);
  });
});