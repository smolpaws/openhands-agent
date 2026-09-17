import type { LLMConvertibleEvent } from '../event/index.js';

/** Boundaries where events may be inserted, or ranges removed, without splitting an atomic unit. */
export class ManipulationIndices extends Set<number> {
  findNext(threshold: number): number {
    let next: number | undefined;
    for (const index of this) {
      if (index >= threshold && (next === undefined || index < next)) next = index;
    }
    if (next === undefined) throw new RangeError(`No manipulation index found >= ${threshold}.`);
    return next;
  }

  static complete(events: readonly LLMConvertibleEvent[]): ManipulationIndices {
    return new ManipulationIndices(Array.from({ length: events.length + 1 }, (_, index) => index));
  }
}
