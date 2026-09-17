import { randomUUID } from 'node:crypto';

import { condensationRequestSchema, conversationErrorEventSchema, messageEventSchema, type Event } from '../event/index.js';
import { LocalFileStore, type FileStore } from '../io/index.js';
import { textContent } from '../llm/index.js';
import type { Agent } from '../agent/index.js';
import { EventLog, EVENTS_DIR } from './event-log.js';
import { ConversationState, conversationExecutionStatus } from './state.js';
import { StuckDetector, type StuckDetectionThresholds } from './stuck-detector.js';
import { applyAgentStepBoundary, type AgentStepBoundary } from './ext/step-boundary.js';

export interface LocalConversationOptions {
  readonly agent: Agent;
  readonly state?: ConversationState;
  readonly maxIterations?: number;
  readonly stuckDetection?: boolean | StuckDetectionThresholds;
  readonly conversationId?: string;
  readonly conversationsDir?: string;
  readonly fileStore?: FileStore;
  /** Runs before the first step and after each fully persisted step, including finish. */
  readonly onStepBoundary?: AgentStepBoundary;
}

export class LocalConversation {
  private activeAgent: Agent;
  private readonly onStepBoundary: AgentStepBoundary | undefined;
  private runInProgress: Promise<void> | null = null;
  private stepTail: Promise<void> = Promise.resolve();
  private stepUserMessageId: string | null = null;

  get agent(): Agent { return this.activeAgent; }
  /** Last user event included when an agent step began; later arrivals remain queued. */
  get lastStepUserMessageId(): string | null { return this.stepUserMessageId; }
  readonly state: ConversationState;
  readonly maxIterations: number;
  readonly stuckDetector: StuckDetector | null;
  readonly conversationId: string | null;

  constructor(options: LocalConversationOptions) {
    this.activeAgent = options.agent;
    this.onStepBoundary = options.onStepBoundary;
    this.conversationId = options.conversationId ?? (options.state === undefined && hasPersistentStore(options) ? randomUUID() : null);
    this.state = options.state ?? createConversationState(options, this.conversationId);
    this.maxIterations = options.maxIterations ?? 500;
    this.stuckDetector = createStuckDetector(this.state, options.stuckDetection);
  }

  sendMessage(text: string): Event {
    const event = this.createUserMessageEvent(text);
    this.state.appendEvent(event);
    this.resetIdleStatusAfterMessage();
    return event;
  }

  async sendMessageAsync(text: string): Promise<Event> {
    const event = this.createUserMessageEvent(text);
    await this.state.appendEventAsync(event);
    this.resetIdleStatusAfterMessage();
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
    if (this.runInProgress !== null) return this.runInProgress;
    const run = this.runOnce();
    this.runInProgress = run;
    try {
      await run;
    } finally {
      this.runInProgress = null;
    }
  }

  /** Force one condensation step after the currently executing step, without resuming a run. */
  async condense(): Promise<void> {
    await this.withStepLock(async () => {
      if (this.agent.condenser?.handlesCondensationRequests?.() !== true) {
        throw new Error('Cannot condense conversation: configure a condenser that handles condensation requests.');
      }
      await this.state.appendEventAsync(condensationRequestSchema.parse({}));
      // A maintenance summary does not answer queued user input.
      await this.agent.step(this.state);
      this.activeAgent = await applyAgentStepBoundary(this.agent, this.state, this.onStepBoundary);
    });
  }

  private withStepLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stepTail.then(operation);
    this.stepTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async runOnce(): Promise<void> {
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
    await this.withStepLock(async () => {
      if (this.state.executionStatus === conversationExecutionStatus.RUNNING) {
        this.activeAgent = await applyAgentStepBoundary(this.agent, this.state, this.onStepBoundary);
      }
    });
    while (this.state.executionStatus === conversationExecutionStatus.RUNNING) {
      await this.withStepLock(async () => {
        if (this.state.executionStatus !== conversationExecutionStatus.RUNNING) return;
        if (this.stuckDetector !== null && this.checkStuckOrNudge()) return;

        this.stepUserMessageId = latestUserMessageId(this.state.events);
        const emitted = await this.agent.step(this.state);
        iteration += 1;

        if (emitted.some(isSuccessfulFinishObservation)) {
          this.state.executionStatus = conversationExecutionStatus.FINISHED;
        } else if (iteration >= this.maxIterations && this.state.executionStatus === conversationExecutionStatus.RUNNING) {
          this.state.executionStatus = conversationExecutionStatus.ERROR;
          await this.state.appendEventAsync(
            conversationErrorEventSchema.parse({
              source: 'environment',
              code: 'MaxIterationsReached',
              detail: `Agent reached maximum iterations limit (${this.maxIterations}).`,
            }),
          );
        }
        this.activeAgent = await applyAgentStepBoundary(this.agent, this.state, this.onStepBoundary);
      });
    }
  }

  /**
   * Nudge once on a repeating action-error streak, otherwise apply isStuck().
   * Returns true when STUCK was set and the run loop should stop.
   */
  private checkStuckOrNudge(): boolean {
    if (this.stuckDetector === null) {
      return false;
    }
    const nudge = this.stuckDetector.getActionErrorNudge();
    if (nudge !== null) {
      this.state.appendEvent(
        messageEventSchema.parse({
          source: 'environment',
          llm_message: { role: 'user', content: [textContent(nudge)] },
        }),
      );
      return false;
    }
    if (this.stuckDetector.isStuck()) {
      this.state.executionStatus = conversationExecutionStatus.STUCK;
      return true;
    }
    return false;
  }

  async arun(): Promise<void> {
    await this.run();
  }

  private createUserMessageEvent(text: string): Event {
    return messageEventSchema.parse({
      source: 'user',
      llm_message: {
        role: 'user',
        content: [textContent(text)],
      },
    });
  }

  private resetIdleStatusAfterMessage(): void {
    if (this.state.executionStatus !== conversationExecutionStatus.RUNNING) {
      this.state.executionStatus = conversationExecutionStatus.IDLE;
    }
  }

}

function hasPersistentStore(options: LocalConversationOptions): boolean {
  return options.fileStore !== undefined || options.conversationsDir !== undefined || options.conversationId !== undefined;
}

function createConversationState(options: LocalConversationOptions, conversationId: string | null): ConversationState {
  if (conversationId === null) {
    return new ConversationState();
  }
  const store = options.fileStore ?? new LocalFileStore(options.conversationsDir ?? '.openhands/conversations');
  return new ConversationState({ eventLog: new EventLog(store, conversationEventDir(conversationId)) });
}

function conversationEventDir(conversationId: string): string {
  const safeConversationId = conversationId.replace(/^\/+|\/+$/gu, '');
  if (safeConversationId.length === 0 || safeConversationId.includes('..')) {
    throw new Error(`Invalid conversationId: ${conversationId}`);
  }
  return `${safeConversationId}/${EVENTS_DIR}`;
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

function latestUserMessageId(events: readonly Event[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'MessageEvent' && event.source === 'user') return event.id;
  }
  return null;
}
