import { describe, expect, it, vi } from 'vitest';

import { endRootSpan, extractActionName, maybeInitLaminar, observe, shouldEnableObservability, startChildSpan, startRootSpan } from '../index.js';

describe('observability helpers', () => {
  it('gates observability on Laminar or OTEL environment variables', () => {
    expect(shouldEnableObservability({})).toBe(false);
    expect(shouldEnableObservability({ LMNR_PROJECT_API_KEY: 'key' })).toBe(true);
    expect(shouldEnableObservability({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector' })).toBe(true);
  });

  it('keeps observe as a no-op passthrough when observability is disabled', async () => {
    const sync = vi.fn((value: number) => value + 1);
    const asyncFn = vi.fn(async (value: number) => value + 2);

    const observedSync = observe({ name: 'sync', env: {} })(sync);
    const observedAsync = observe({ name: 'async', env: {} })(asyncFn);

    expect(observedSync(1)).toBe(2);
    await expect(observedAsync(1)).resolves.toBe(3);
    expect(sync).toHaveBeenCalledWith(1);
    expect(asyncFn).toHaveBeenCalledWith(1);
  });

  it('does not initialize or start spans without observability env', () => {
    expect(maybeInitLaminar({ env: {}, initializer: () => { throw new Error('unreachable'); } })).toBe(false);
    expect(startRootSpan('conversation', { env: {}, spanFactory: () => { throw new Error('unreachable'); } })).toBeNull();
    expect(() => endRootSpan(null)).not.toThrow();
  });

  it('skips the initializer when the backend is already initialized', () => {
    const initializer = vi.fn();
    expect(maybeInitLaminar({ env: { LMNR_PROJECT_API_KEY: 'key' }, isInitialized: () => true, initializer })).toBe(true);
    expect(initializer).not.toHaveBeenCalled();

    expect(maybeInitLaminar({ env: { LMNR_PROJECT_API_KEY: 'key' }, isInitialized: () => false, initializer })).toBe(true);
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  it('extracts action names defensively', () => {
    expect(extractActionName({ action: { kind: 'terminal' }, tool_name: 'fallback' })).toBe('terminal');
    expect(extractActionName({ tool_name: 'file_editor' })).toBe('file_editor');
    expect(extractActionName(null)).toBe('agent.execute_action');
  });

  it('emits a named child span under the conversation root span', () => {
    const children: string[] = [];
    const root = startRootSpan('conversation', {
      env: { LMNR_PROJECT_API_KEY: 'key' },
      spanFactory: () => ({
        end() {},
        beginChild(childName) { children.push(childName); },
      }),
    });
    expect(root).not.toBeNull();

    startChildSpan(root, 'conversation.run', ['sdk']);

    expect(children).toEqual(['conversation.run']);
  });

  it('no-ops a child span when the root span is absent', () => {
    expect(() => startChildSpan(null, 'conversation.run')).not.toThrow();
  });
});
