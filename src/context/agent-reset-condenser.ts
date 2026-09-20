import type { Condenser } from './condenser.js';
import { contextWarningThresholdsSchema, DEFAULT_CONTEXT_WARNING_THRESHOLDS } from './context-warnings.js';
import type { View } from './view.js';

/** Opt-in agent control. Normal preparation never summarizes or clears history. */
export class AgentResetCondenser implements Condenser {
  readonly warningThresholds: readonly number[];

  constructor(options: { readonly warningThresholds?: readonly number[] } = {}) {
    this.warningThresholds = contextWarningThresholdsSchema.parse(options.warningThresholds ?? DEFAULT_CONTEXT_WARNING_THRESHOLDS);
  }

  condense(view: View): View { return view; }
  handlesCondensationRequests(): boolean { return false; }
}

/** Host maintenance has no genuine agent-authored tool exchange to retain. */
export class AgentControlledCondensationError extends Error {
  constructor() {
    super('Agent-controlled condensation requires the agent to call its condense tool; host condensation is not supported in this mode.');
    this.name = 'AgentControlledCondensationError';
  }
}
