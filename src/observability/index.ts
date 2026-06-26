export type EnvLike = Readonly<Record<string, string | undefined>>;
export type SpanType = 'DEFAULT' | 'LLM' | 'TOOL';

export interface ObserveOptions {
  readonly name?: string | null;
  readonly sessionId?: string | null;
  readonly userId?: string | null;
  readonly ignoreInput?: boolean;
  readonly ignoreOutput?: boolean;
  readonly spanType?: SpanType;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly tags?: readonly string[] | null;
  readonly env?: EnvLike;
  readonly adapter?: ObserveAdapter;
}

export interface ObserveAdapter {
  observe<Args extends unknown[], Result>(options: ObserveOptions, fn: (...args: Args) => Result): (...args: Args) => Result;
}

export interface LaminarInitOptions {
  readonly env?: EnvLike;
  readonly initializer?: () => void;
}

export interface RootSpanOptions {
  readonly sessionId?: string | null;
  readonly userId?: string | null;
  readonly attributes?: Readonly<Record<string, string>> | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly tags?: readonly string[] | null;
  readonly env?: EnvLike;
  readonly spanFactory?: (name: string, options: RootSpanOptions) => RootSpanHandle;
}

export interface RootSpanHandle {
  readonly setAttribute?: (key: string, value: string) => void;
  readonly end?: () => void;
}

export class RootSpan {
  readonly handle: RootSpanHandle;
  private ended = false;

  constructor(handle: RootSpanHandle) {
    this.handle = handle;
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.handle.end?.();
  }
}

export const observabilityEnvKeys = [
  'LMNR_PROJECT_API_KEY',
  'OTEL_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
] as const;

let processObservabilityEnabled = false;

export function getEnv(key: string, env: EnvLike = process.env): string | undefined {
  const value = env[key];
  return value === '' ? undefined : value;
}

export function shouldEnableObservability(env: EnvLike = process.env): boolean {
  if (env === process.env && processObservabilityEnabled) {
    return true;
  }
  const enabled = observabilityEnvKeys.some((key) => getEnv(key, env) !== undefined);
  if (enabled && env === process.env) {
    processObservabilityEnabled = true;
  }
  return enabled;
}

export function maybeInitLaminar(options: LaminarInitOptions = {}): boolean {
  if (!shouldEnableObservability(options.env ?? process.env)) {
    return false;
  }
  options.initializer?.();
  return true;
}

export function observe(options: ObserveOptions = {}): <Args extends unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => Result {
  return <Args extends unknown[], Result>(fn: (...args: Args) => Result): ((...args: Args) => Result) => {
    if (!shouldEnableObservability(options.env ?? process.env) || options.adapter === undefined) {
      return fn;
    }
    return options.adapter.observe(options, fn);
  };
}

export function startRootSpan(name: string, options: RootSpanOptions = {}): RootSpan | null {
  if (!shouldEnableObservability(options.env ?? process.env) || options.spanFactory === undefined) {
    return null;
  }
  try {
    const span = options.spanFactory(name, options);
    if (options.attributes !== undefined && options.attributes !== null) {
      for (const [key, value] of Object.entries(options.attributes)) {
        span.setAttribute?.(key, value);
      }
    }
    return new RootSpan(span);
  } catch {
    return null;
  }
}

export function endRootSpan(root: RootSpan | null | undefined): void {
  root?.end();
}

export function extractActionName(actionEvent: unknown): string {
  try {
    if (!isRecord(actionEvent)) {
      return 'agent.execute_action';
    }
    const action = actionEvent.action;
    if (isRecord(action) && typeof action.kind === 'string') {
      return action.kind;
    }
    if (typeof actionEvent.tool_name === 'string') {
      return actionEvent.tool_name;
    }
    if (typeof actionEvent.toolName === 'string') {
      return actionEvent.toolName;
    }
  } catch {
    return 'agent.execute_action';
  }
  return 'agent.execute_action';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
