import { agentErrorEventSchema, type ActionEvent, type AgentErrorEvent, type Event } from '../event/index.js';
import type { CancellationToken } from './state.js';

export type ToolRunner = (action: ActionEvent) => readonly Event[] | Promise<readonly Event[]>;

export interface ParallelToolExecutorOptions {
  readonly maxConcurrency?: number;
}

export interface ExecuteBatchOptions {
  readonly cancelToken?: CancellationToken | null;
}

export class ParallelToolExecutor {
  readonly maxConcurrency: number;

  constructor(options: ParallelToolExecutorOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 1);
  }

  async executeBatch(
    actions: readonly ActionEvent[],
    runner: ToolRunner,
    options: ExecuteBatchOptions = {},
  ): Promise<readonly (readonly Event[])[]> {
    if (actions.length === 0) {
      return [];
    }

    const results: Event[][] = Array.from({ length: actions.length }, () => []);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < actions.length) {
        const index = nextIndex;
        nextIndex += 1;
        const action = actions[index];
        if (action !== undefined) {
          results[index] = await this.runSafe(action, runner, options.cancelToken ?? null);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.maxConcurrency, actions.length) }, () => worker()));
    return results;
  }

  private async runSafe(action: ActionEvent, runner: ToolRunner, cancelToken: CancellationToken | null): Promise<Event[]> {
    if (cancelToken?.isCancelled === true) {
      return [cancelledError(action)];
    }

    try {
      return [...(await runner(action))];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        agentErrorEventSchema.parse({
          error: `Error executing tool '${action.tool_name}': ${message}`,
          tool_name: action.tool_name,
          tool_call_id: action.tool_call_id,
        }),
      ];
    }
  }
}

function cancelledError(action: ActionEvent): AgentErrorEvent {
  return agentErrorEventSchema.parse({
    error: 'Tool call cancelled by interrupt.',
    tool_name: action.tool_name,
    tool_call_id: action.tool_call_id,
  });
}
