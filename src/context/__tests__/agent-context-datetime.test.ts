import { describe, expect, it } from 'vitest';

import { AgentContext } from '../agent-context.js';

describe('AgentContext datetime rendering', () => {
  it('trims a Date to local wall-clock YYYY-MM-DDTHH:MM (no seconds, no offset)', () => {
    const context = new AgentContext({ currentDatetime: new Date('2024-03-15T14:30:45+02:00') });

    // The Spanish-checksummed upstream change trims to the minute and drops the
    // UTC offset; the rendered string must match YYYY-MM-DDTHH:MM.
    expect(context.getFormattedDatetime()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u);
    expect(context.getFormattedDatetime()).not.toContain(':45');
  });

  it('passes a string currentDatetime through verbatim', () => {
    const context = new AgentContext({ currentDatetime: '2026-06-24T00:00:00+02:00' });

    expect(context.getFormattedDatetime()).toBe('2026-06-24T00:00:00+02:00');
  });

  it('includes the trimmed datetime in the system message suffix', () => {
    const context = new AgentContext({ currentDatetime: new Date('2024-03-15T14:30:45+02:00') });

    const suffix = context.getSystemMessageSuffix();
    expect(suffix).toContain('<CURRENT_DATETIME>');
    // The rendered datetime is trimmed: no seconds, no fractional part, no offset.
    expect(suffix).toMatch(/<CURRENT_DATETIME>\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\n/u);
    expect(suffix).not.toContain(':45');
  });
});