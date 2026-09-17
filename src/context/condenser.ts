import type { Condensation, LLMConvertibleEvent } from '../event/index.js';
import type { LLMClient, LLMCompletionResponse } from '../llm/client.js';
import type { LLMProfile, Message } from '../llm/index.js';
import type { ToolDefinition } from '../tool/index.js';
import type { View } from './view.js';

export type CondenserResult = View | Condensation;
export type MaybeCondenserResult = CondenserResult | Promise<CondenserResult>;
export type CondensationRequirement = 'hard' | 'soft';
type MaybePromise<T> = T | Promise<T>;

export interface CondenserCompletionAttempt {
  readonly llm: LLMClient;
  readonly response?: LLMCompletionResponse;
  readonly error?: unknown;
  readonly startedAt: number;
  readonly completedAt: number;
}

/** Explicit per-operation host state; a condenser never owns a conversation or global metrics. */
export interface CondenserContext {
  readonly tools?: readonly ToolDefinition[];
  readonly messagesForEvents?: (events: readonly LLMConvertibleEvent[]) => readonly Message[];
  readonly projectEvents?: (events: readonly LLMConvertibleEvent[], profile: LLMProfile) => readonly LLMConvertibleEvent[];
  readonly onCompletion?: (attempt: CondenserCompletionAttempt) => void | Promise<void>;
}

export const condensationRequirement = { HARD: 'hard', SOFT: 'soft' } as const satisfies Record<string, CondensationRequirement>;

export interface Condenser {
  /** Treat the supplied View as read-only. Synchronous condensers retain their synchronous API. */
  condense(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybeCondenserResult;
  handlesCondensationRequests?(): boolean;
}

export class NoCondensationAvailableError extends Error {
  override name = 'NoCondensationAvailableError';
}

/** Internal marker: persistence failures must never become another provider attempt. */
export class CondenserCompletionCallbackError extends Error {
  constructor(cause: unknown) { super('Condenser completion callback failed', { cause }); }
}

export abstract class RollingCondenser implements Condenser {
  abstract condensationRequirement(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybePromise<CondensationRequirement | null>;
  abstract getCondensation(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybePromise<Condensation>;

  hardContextReset(_view: View, _agentLlm?: LLMClient | null, _context?: CondenserContext): MaybePromise<Condensation | null> { return null; }

  condense(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybeCondenserResult {
    return mapMaybe(this.condensationRequirement(view, agentLlm, context), requirement => {
      if (requirement === null) return view;
      const recover = (error: unknown): MaybeCondenserResult => {
        if (error instanceof CondenserCompletionCallbackError) throw error.cause;
        if (!(error instanceof NoCondensationAvailableError)) throw error;
        if (requirement === condensationRequirement.SOFT) return view;
        const resetFailed = (resetError: unknown): never => {
          if (resetError instanceof CondenserCompletionCallbackError) throw resetError.cause;
          // Python raises hard-reset failures from the original missing-condensation exception.
          if (resetError instanceof Error && resetError.cause === undefined) resetError.cause = error;
          throw resetError;
        };
        try {
          const reset = this.hardContextReset(view, agentLlm, context);
          if (reset instanceof Promise) return reset.then(value => { if (value === null) throw error; return value; }, resetFailed);
          if (reset !== null) return reset;
        } catch (resetError) { return resetFailed(resetError); }
        throw error;
      };
      try {
        const result = this.getCondensation(view, agentLlm, context);
        return result instanceof Promise ? result.catch(recover) : result;
      } catch (error) { return recover(error); }
    });
  }
}

export class NoOpCondenser implements Condenser {
  condense(view: View): View { return view; }
  handlesCondensationRequests(): boolean { return false; }
}

export class PipelineCondenser implements Condenser {
  readonly condensers: readonly Condenser[];
  constructor(condensers: readonly Condenser[]) { this.condensers = [...condensers]; }

  condense(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybeCondenserResult {
    let result: MaybeCondenserResult = view;
    for (const condenser of this.condensers) {
      result = mapMaybe<CondenserResult, CondenserResult>(result, value => isCondensation(value) ? value : condenser.condense(value, agentLlm, context));
      if (!(result instanceof Promise) && isCondensation(result)) break;
    }
    return result;
  }
  handlesCondensationRequests(): boolean { return this.condensers.some(condenser => condenser.handlesCondensationRequests?.() === true); }
}

function mapMaybe<T, R>(value: MaybePromise<T>, map: (value: T) => MaybePromise<R>): MaybePromise<R> {
  return value instanceof Promise ? value.then(map) : map(value);
}
function isCondensation(result: CondenserResult): result is Condensation { return 'kind' in result && result.kind === 'Condensation'; }
