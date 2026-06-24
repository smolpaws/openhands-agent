import {
  condensationSummaryEventSchema,
  type Condensation,
  type Event,
  type LLMConvertibleEvent,
} from '../event/index.js';

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
