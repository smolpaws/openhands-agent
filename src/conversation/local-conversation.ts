import { conversationErrorEventSchema, messageEventSchema, type Event } from '../event/index.js';
import { textContent } from '../llm/index.js';
import type { Agent } from '../agent/index.js';
import { ConversationState, conversationExecutionStatus } from './state.js';
import { StuckDetector, type StuckDetectionThresholds } from './stuck-detector.js';

export interface LocalConversationOptions {
  readonly agent: Agent;
  readonly state?: ConversationState;
  readonly maxIterations?: number;
  readonly stuckDetection?: boolean | StuckDetectionThresholds;
}

export class LocalConversation {
  readonly agent: Agent;
  readonly state: ConversationState;
  readonly maxIterations: number;
  readonly stuckDetector: StuckDetector | null;

  constructor(options: LocalConversationOptions) {
    this.agent = options.agent;
    this.state = options.state ?? new ConversationState();
    this.maxIterations = options.maxIterations ?? 500;
    this.stuckDetector = createStuckDetector(this.state, options.stuckDetection);
  }

  sendMessage(text: string): Event {
    const event = messageEventSchema.parse({
      source: 'user',
      llm_message: {
        role: 'user',
        content: [textContent(text)],
      },
    });
    this.state.appendEvent(event);
    if (this.state.executionStatus !== conversationExecutionStatus.RUNNING) {
      this.state.executionStatus = conversationExecutionStatus.IDLE;
    }
    return event;
  }

  pause(): void {
    this.state.executionStatus = conversationExecutionStatus.PAUSED;
  }

  resume(): void {
    if (this.state.executionStatus === conversationExecutionStatus.PAUSED) {
      this.state.executionStatus = conversationExecutionStatus.IDLE;
    }
  }

  async run(): Promise<void> {
    if (this.state.executionStatus === conversationExecutionStatus.PAUSED) {
      return;
    }
    if (
      this.state.executionStatus === conversationExecutionStatus.IDLE ||
      this.state.executionStatus === conversationExecutionStatus.ERROR ||
      this.state.executionStatus === conversationExecutionStatus.STUCK
    ) {
      this.state.executionStatus = conversationExecutionStatus.RUNNING;
    }

    let iteration = 0;
    while (this.state.executionStatus === conversationExecutionStatus.RUNNING) {
      if (this.stuckDetector?.isStuck() === true) {
        this.state.executionStatus = conversationExecutionStatus.STUCK;
        return;
      }

      const emitted = await this.agent.step(this.state);
      iteration += 1;

      if (emitted.some(isSuccessfulFinishObservation)) {
        this.state.executionStatus = conversationExecutionStatus.FINISHED;
        return;
      }

      if (iteration >= this.maxIterations) {
        this.state.executionStatus = conversationExecutionStatus.ERROR;
        this.state.appendEvent(
          conversationErrorEventSchema.parse({
            source: 'environment',
            code: 'MaxIterationsReached',
            detail: `Agent reached maximum iterations limit (${this.maxIterations}).`,
          }),
        );
        return;
      }
    }
  }

  async arun(): Promise<void> {
    await this.run();
  }
}

function createStuckDetector(state: ConversationState, option: boolean | StuckDetectionThresholds | undefined): StuckDetector | null {
  if (option === undefined || option === false) {
    return null;
  }
  if (option === true) {
    return new StuckDetector(state);
  }
  return new StuckDetector(state, option);
}

function isSuccessfulFinishObservation(event: Event): boolean {
  if (event.kind !== 'ObservationEvent' || event.tool_name !== 'finish') {
    return false;
  }
  const isError = event.observation.is_error;
  return isError !== true;
}
