import {
  condensationSummaryEventSchema,
  type Condensation,
  type Event,
  type LLMConvertibleEvent,
} from '../event/index.js';
import { ManipulationIndices } from './manipulation-indices.js';
import { viewProperties } from './view-properties.js';

export { ManipulationIndices } from './manipulation-indices.js';

export class View {
  readonly events: LLMConvertibleEvent[];
  unhandledCondensationRequest: boolean;

  constructor(events: readonly LLMConvertibleEvent[] = [], unhandledCondensationRequest = false) {
    this.events = [...events];
    this.unhandledCondensationRequest = unhandledCondensationRequest;
  }

  get length(): number {
    return this.events.length;
  }

  get manipulationIndices(): ManipulationIndices {
    const indices = ManipulationIndices.complete(this.events);
    for (const property of viewProperties) {
      const allowed = property.manipulationIndices(this.events);
      for (const index of indices) if (!allowed.has(index)) indices.delete(index);
    }
    return indices;
  }

  enforceProperties(allEvents: readonly Event[]): void {
    const sourceEvents = [...allEvents];
    // Restart after each removal: matching can invalidate a batch, and vice versa.
    while (true) {
      let changed = false;
      for (const property of viewProperties) {
        const removed = property.enforce(this.events, sourceEvents);
        if (removed.size === 0) continue;
        console.warn(`Property ${property.constructor.name} enforced, ${removed.size} events dropped.`);
        const retained = this.events.filter((event) => !removed.has(event.id));
        this.events.length = 0;
        this.events.push(...retained);
        changed = true;
        break;
      }
      if (!changed) return;
    }
  }

  appendEvent(event: Event): void {
    switch (event.kind) {
      case 'Condensation':
        this.applyCondensation(event);
        this.unhandledCondensationRequest = false;
        break;
      case 'CondensationRequest':
        this.unhandledCondensationRequest = true;
        break;
      case 'SystemPromptEvent':
      case 'MessageEvent':
      case 'ActionEvent':
      case 'ObservationEvent':
      case 'UserRejectObservation':
      case 'AgentErrorEvent':
      case 'CondensationSummaryEvent':
        this.events.push(event);
        break;
      default:
        break;
    }
  }

  static fromEvents(events: readonly Event[]): View {
    const view = new View();
    for (const event of events) {
      view.appendEvent(event);
    }
    view.enforceProperties(events);
    return view;
  }

  private applyCondensation(condensation: Condensation): void {
    const output = this.events.filter((event) => !condensation.forgotten_event_ids.has(event.id));
    if (condensation.summary !== null && condensation.summary_offset !== null) {
      output.splice(condensation.summary_offset, 0, condensationSummaryEventSchema.parse({
        id: `${condensation.id}-summary`,
        source: condensation.source,
        summary: condensation.summary,
      }));
    }
    this.events.length = 0;
    this.events.push(...output);
  }
}
