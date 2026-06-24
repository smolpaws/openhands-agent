import { describe, expect, it } from 'vitest';

import { condensationRequestSchema, condensationSchema, messageEventSchema } from '../../event/index.js';
import { textContent } from '../../llm/index.js';
import { NoCondensationAvailableError, NoOpCondenser, PipelineCondenser, RollingCondenser, View, condensationRequirement, type CondensationRequirement, type Condenser } from '../index.js';

describe('View', () => {
  it('applies condensation events and inserts summaries at the requested offset', () => {
    const first = userEvent('first');
    const second = userEvent('second');
    const third = userEvent('third');
    const condensation = condensationSchema.parse({
      forgotten_event_ids: [first.id, second.id],
      summary: 'Earlier: first and second',
      summary_offset: 0,
      llm_response_id: 'resp-1',
    });

    const view = View.fromEvents([first, second, condensation, third]);

    expect(view.events.map((event) => event.kind)).toEqual(['CondensationSummaryEvent', 'MessageEvent']);
    expect(view.events[0]).toMatchObject({ kind: 'CondensationSummaryEvent', id: `${condensation.id}-summary`, summary: 'Earlier: first and second' });
    expect(view.events[1]?.id).toBe(third.id);
  });

  it('tracks unhandled condensation requests until a condensation arrives', () => {
    const request = condensationRequestSchema.parse({});
    const view = View.fromEvents([userEvent('start'), request]);

    expect(view.unhandledCondensationRequest).toBe(true);

    view.appendEvent(condensationSchema.parse({ forgotten_event_ids: [], llm_response_id: 'resp-1' }));
    expect(view.unhandledCondensationRequest).toBe(false);
  });
});

describe('condensers', () => {
  it('NoOpCondenser returns the same view', () => {
    const view = View.fromEvents([userEvent('hello')]);
    expect(new NoOpCondenser().condense(view)).toBe(view);
  });

  it('PipelineCondenser stops once a condenser returns a condensation', () => {
    const condensation = condensationSchema.parse({ forgotten_event_ids: [], llm_response_id: 'resp-1' });
    const calls: string[] = [];
    const first: Condenser = { condense: () => { calls.push('first'); return condensation; }, handlesCondensationRequests: () => false };
    const second: Condenser = { condense: (view) => { calls.push('second'); return view; }, handlesCondensationRequests: () => false };

    expect(new PipelineCondenser([first, second]).condense(View.fromEvents([]))).toBe(condensation);
    expect(calls).toEqual(['first']);
  });

  it('RollingCondenser falls back for soft missing condensation and hard reset for hard failures', () => {
    class TestCondenser extends RollingCondenser {
      constructor(private readonly requirement: CondensationRequirement, private readonly reset = false) { super(); }
      condensationRequirement(): CondensationRequirement { return this.requirement; }
      getCondensation(): never { throw new NoCondensationAvailableError('none'); }
      hardContextReset() { return this.reset ? condensationSchema.parse({ forgotten_event_ids: [], llm_response_id: 'reset' }) : null; }
    }
    const view = View.fromEvents([userEvent('hello')]);

    expect(new TestCondenser(condensationRequirement.SOFT).condense(view)).toBe(view);
    expect(new TestCondenser(condensationRequirement.HARD, true).condense(view)).toMatchObject({ kind: 'Condensation', llm_response_id: 'reset' });
    expect(() => new TestCondenser(condensationRequirement.HARD).condense(view)).toThrow(NoCondensationAvailableError);
  });
});

function userEvent(text: string) {
  return messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent(text)] } });
}
