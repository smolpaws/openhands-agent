import type { LLMConvertibleEvent } from '../event/index.js';

export interface CriticResultOptions {
  readonly score: number;
  readonly message?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export class CriticResult {
  static readonly THRESHOLD = 0.5;
  static readonly DISPLAY_THRESHOLD = 0.2;

  readonly score: number;
  readonly message: string | null;
  readonly metadata: Record<string, unknown> | null;

  constructor(options: CriticResultOptions) {
    if (options.score < 0 || options.score > 1) {
      throw new Error('Critic score must be between 0 and 1');
    }
    this.score = options.score;
    this.message = options.message ?? null;
    this.metadata = options.metadata ?? null;
  }

  get success(): boolean {
    return this.score >= CriticResult.THRESHOLD;
  }

  get starRating(): string {
    const filled = Math.round(this.score * 5);
    return '★'.repeat(filled) + '☆'.repeat(5 - filled);
  }

  visualize(): string {
    const percentage = (this.score * 100).toFixed(1);
    return `Critic: agent success likelihood ${this.starRating} (${percentage}%)${this.message ? `\n  ${this.message}` : ''}`;
  }
}

export interface IterativeRefinementConfig {
  readonly success_threshold?: number;
  readonly max_iterations?: number;
}

export interface Critic {
  readonly mode?: 'finish_and_message' | 'all_actions';
  readonly iterative_refinement?: IterativeRefinementConfig | null;
  evaluate(events: readonly LLMConvertibleEvent[], gitPatch?: string | null): CriticResult;
}

export abstract class CriticBase implements Critic {
  readonly mode: 'finish_and_message' | 'all_actions';
  readonly iterative_refinement: Required<IterativeRefinementConfig> | null;

  constructor(options: { readonly mode?: 'finish_and_message' | 'all_actions'; readonly iterative_refinement?: IterativeRefinementConfig | null } = {}) {
    this.mode = options.mode ?? 'finish_and_message';
    this.iterative_refinement = options.iterative_refinement === undefined || options.iterative_refinement === null ? null : {
      success_threshold: options.iterative_refinement.success_threshold ?? 0.6,
      max_iterations: options.iterative_refinement.max_iterations ?? 3,
    };
  }

  abstract evaluate(events: readonly LLMConvertibleEvent[], gitPatch?: string | null): CriticResult;

  getFollowupPrompt(criticResult: CriticResult, iteration: number): string {
    const scorePercent = (criticResult.score * 100).toFixed(1);
    return `The task appears incomplete (iteration ${iteration}, predicted success likelihood: ${scorePercent}%).\n\nPlease review what you've done and verify each requirement is met.\nList what's working and what needs fixing, then complete the task.\n`;
  }

  shouldRefine(criticResult: CriticResult): boolean {
    return this.iterative_refinement !== null && criticResult.score < this.iterative_refinement.success_threshold;
  }
}

export class PassCritic extends CriticBase {
  evaluate(): CriticResult {
    return new CriticResult({ score: 1.0, message: 'PassCritic always succeeds' });
  }
}

export class EmptyPatchCritic extends CriticBase {
  evaluate(_events: readonly LLMConvertibleEvent[], gitPatch?: string | null): CriticResult {
    if (gitPatch === undefined || gitPatch === null || gitPatch.trim().length === 0) {
      return new CriticResult({ score: 0.0, message: 'Git patch is empty or missing' });
    }
    return new CriticResult({ score: 1.0, message: 'Git patch is non-empty' });
  }
}

export class AgentFinishedCritic extends CriticBase {
  evaluate(events: readonly LLMConvertibleEvent[], gitPatch?: string | null): CriticResult {
    if (gitPatch === undefined || gitPatch === null || gitPatch.trim().length === 0) {
      return new CriticResult({ score: 0.0, message: 'Agent did not produce a non-empty git patch. Empty git patch' });
    }
    if (!hasFinishAction(events)) {
      return new CriticResult({ score: 0.0, message: 'Agent did not finish properly. No FinishAction found' });
    }
    return new CriticResult({ score: 1.0, message: 'Agent completed with FinishAction and non-empty patch' });
  }
}

function hasFinishAction(events: readonly LLMConvertibleEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'ActionEvent') {
      return event.tool_name === 'FinishTool' || event.tool_name === 'finish';
    }
  }
  return false;
}
