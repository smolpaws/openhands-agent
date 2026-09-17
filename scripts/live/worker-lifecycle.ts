import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { LiveResult } from './run.js';

type Identity = Pick<LiveResult, 'target' | 'model' | 'route' | 'scenario'>;
const identifier = z.string().min(1).max(256).regex(/^[a-zA-Z0-9._:/@+-]+$/u);
const count = z.number().int().nonnegative();
const checks = z.array(z.string().min(1).max(100).regex(/^[a-zA-Z0-9 -]+$/u)).max(30);
const evidence = z.union([
  z.object({
    profileId: identifier, requestedModel: identifier, sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    returnedModels: z.array(identifier).max(20), requests: count, recordedCompletions: count,
    parallelToolExecutions: count, wireRequestsChecked: count, plainResponseWireRequestsChecked: count.optional(), checks,
  }).strict(),
  z.object({
    completed: z.array(z.string().regex(/^(?:examples|scripts\/live)\/[a-z0-9.-]+\.ts$/u)).min(1).max(100),
    excluded: z.record(z.string().regex(/^[a-z0-9.-]+\.ts$/u), z.string().max(200)).optional(),
    checks: checks.optional(), reasoningTurns: count.optional(),
  }).strict(),
]);
const reportSchema = z.object({
  target: identifier, model: identifier, route: identifier, scenario: identifier,
  status: z.enum(['passed', 'failed', 'unavailable']), reason: z.string().max(300).optional(),
  evidence: evidence.optional(),
}).strict().refine(value => value.status !== 'passed' || value.evidence !== undefined);

/** The caller starts a separate process group on POSIX, including any legacy children. */
export function waitForWorker(worker: ChildProcess, identity: Identity, timeoutMs: number): Promise<LiveResult> {
  return new Promise(resolveResult => {
    const started = Date.now();
    let reported: z.infer<typeof reportSchema> | undefined;
    let failure: string | undefined;
    const stop = () => {
      if (process.platform !== 'win32' && worker.pid) {
        try { process.kill(-worker.pid, 'SIGKILL'); } catch { worker.kill('SIGKILL'); }
      } else worker.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      failure = 'target-deadline-exceeded';
      stop();
    }, timeoutMs);
    worker.on('message', message => {
      if (failure) return;
      const parsed = reportSchema.safeParse(message);
      if (!parsed.success || reported || Object.entries(identity).some(([key, value]) => parsed.data[key as keyof Identity] !== value)) {
        failure = 'worker-invalid-report';
        stop();
        return;
      }
      // Assertion text and unexpected error strings are not report metadata.
      const reason = parsed.data.reason;
      reported = {
        ...parsed.data,
        ...(reason === undefined ? {} : { reason: safeReason(reason) }),
      };
    });
    worker.on('error', () => { failure ??= 'worker-start-failed'; });
    worker.on('close', (code, signal) => {
      clearTimeout(timer);
      // A successful report is provisional until the process exits cleanly.
      // Kill any descendants that survived their worker, on every exit path.
      stop();
      if (!failure && (code !== 0 || signal !== null)) failure = 'worker-exit-failed';
      if (!failure && !reported) failure = 'worker-missing-report';
      resolveResult({
        ...(failure ? { ...identity, status: 'failed' as const, reason: failure } : reported!),
        durationMs: Date.now() - started,
      });
    });
  });
}

function safeReason(reason: string): string {
  if (/^provider-http-\d{3}$/u.test(reason)) return reason;
  if (/^provider-(insufficient-credit|exhausted-quota|model-unavailable)$/u.test(reason)) return reason;
  if (/^conversation-(setup|read|edit|parallel|restore|plain)$/u.test(reason)) return reason;
  if (/^legacy-script-failed:[a-z0-9.-]+\.ts$/u.test(reason)) return reason;
  if (reason.startsWith('assertion:')) return 'scenario-assertion-failed';
  return ['request-deadline-exceeded', 'provider-network-unavailable', 'scenario-error'].includes(reason) ? reason : 'scenario-error';
}
