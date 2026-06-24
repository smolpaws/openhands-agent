import type { Condensation } from '../event/index.js';
import type { LLMClient } from '../llm/client.js';
import type { View } from './view.js';

export type CondenserResult = View | Condensation;
export type CondensationRequirement = 'hard' | 'soft';

export const condensationRequirement = {
  HARD: 'hard',
  SOFT: 'soft',
} as const satisfies Record<string, CondensationRequirement>;

export interface Condenser {
  condense(view: View, agentLlm?: LLMClient | null): CondenserResult;
  handlesCondensationRequests?(): boolean;
}

export class NoCondensationAvailableError extends Error {}
export abstract class RollingCondenser implements Condenser {
  abstract condensationRequirement(view: View, agentLlm?: LLMClient | null): CondensationRequirement | null;
  abstract getCondensation(view: View, agentLlm?: LLMClient | null): Condensation;

  hardContextReset(_view: View, _agentLlm?: LLMClient | null): Condensation | null {
    return null;
  }

  condense(view: View, agentLlm?: LLMClient | null): CondenserResult {
    const requirement = this.condensationRequirement(view, agentLlm);
    if (requirement === null) {
      return view;
    }
    try {
      return this.getCondensation(view, agentLlm);
    } catch (error) {
      if (!(error instanceof NoCondensationAvailableError)) {
        throw error;
      }
      if (requirement === condensationRequirement.SOFT) {
        return view;
      }
      const reset = this.hardContextReset(view, agentLlm);
      if (reset !== null) {
        return reset;
      }
      throw error;
    }
  }
}



export class NoOpCondenser implements Condenser {
  condense(view: View): View {
    return view;
  }

  handlesCondensationRequests(): boolean {
    return false;
  }
}

export class PipelineCondenser implements Condenser {
  readonly condensers: readonly Condenser[];

  constructor(condensers: readonly Condenser[]) {
    this.condensers = [...condensers];
  }

  condense(view: View, agentLlm?: LLMClient | null): CondenserResult {
    let result: CondenserResult = view;
    for (const condenser of this.condensers) {
      if (isCondensation(result)) {
        return result;
      }
      result = condenser.condense(result, agentLlm);
    }
    return result;
  }

  handlesCondensationRequests(): boolean {
    return this.condensers.some((condenser) => condenser.handlesCondensationRequests?.() === true);
  }
}

function isCondensation(result: CondenserResult): result is Condensation {
  return 'kind' in result && result.kind === 'Condensation';
}
