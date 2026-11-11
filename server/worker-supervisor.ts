/** Supervision of the global worker loop: every step (scheduler or job tick) runs in its own
 * try/catch with its own error count and backoff, so one failing step never skips the others.
 * State is in memory of the process that runs the loop; pause is runtime-only (reset on restart),
 * because no installation-wide settings table exists and the loop is shared by all workspaces. */
import { Problem } from './errors';

/** Steps of one lane run one after another; lanes run independently, so a slow job tick never delays the schedulers.
 * A step over its time limit cannot be cancelled (the work keeps its own transaction), so the lane stops waiting for it,
 * counts a TIMEOUT failure and does not start that step again until the hung run settles. */
export type WorkerStep = {
  readonly name: string;
  readonly label: string;
  readonly lane?: string;
  readonly timeoutMs?: number;
  readonly run: () => Promise<unknown>;
};
export type WorkerStepState = 'idle' | 'running' | 'ok' | 'backoff' | 'paused' | 'timeout';
export interface WorkerStepError {
  readonly message: string;
  readonly code: string | null;
  readonly at: string;
}
export interface WorkerStepSnapshot {
  readonly name: string;
  readonly label: string;
  readonly lane: string;
  readonly timeout_ms: number;
  readonly state: WorkerStepState;
  readonly paused: boolean;
  readonly runs: number;
  readonly failures: number;
  readonly consecutive_failures: number;
  readonly last_started_at: string | null;
  readonly last_finished_at: string | null;
  readonly last_success_at: string | null;
  readonly last_duration_ms: number | null;
  readonly last_error: WorkerStepError | null;
  readonly next_run_at: string | null;
}
export interface WorkerLaneSnapshot {
  readonly lane: string;
  readonly cycles: number;
  readonly cycle_running: boolean;
  readonly heartbeat_at: string;
  readonly last_cycle_started_at: string | null;
  readonly last_cycle_finished_at: string | null;
}
export interface WorkerRuntimeSnapshot {
  readonly state: 'RUNNING' | 'STOPPING';
  readonly started_at: string;
  readonly interval_ms: number;
  readonly cycles: number;
  readonly cycle_running: boolean;
  readonly heartbeat_at: string;
  readonly last_cycle_started_at: string | null;
  readonly last_cycle_finished_at: string | null;
  readonly pause_scope: 'RUNTIME_ONLY_RESET_ON_RESTART';
  readonly lanes: readonly WorkerLaneSnapshot[];
  readonly steps: readonly WorkerStepSnapshot[];
}
export type WorkerLogEvent = {
  readonly level: 'error' | 'info';
  readonly component: 'worker';
  readonly event:
    | 'scheduler_failed'
    | 'scheduler_timeout'
    | 'scheduler_timeout_settled'
    | 'scheduler_recovered'
    | 'scheduler_paused'
    | 'scheduler_resumed';
  readonly scheduler: string;
  readonly [key: string]: unknown;
};
export interface WorkerSupervisorOptions {
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Default time limit of a step without its own timeoutMs. */
  readonly stepTimeoutMs?: number;
  readonly log?: (event: WorkerLogEvent) => void;
}
export interface WorkerSupervisor {
  /** One cycle of the given lane, or of every lane in turn when omitted. */
  runCycle(lane?: string): Promise<void>;
  lanes(): readonly string[];
  pause(name: string): WorkerStepSnapshot;
  resume(name: string): WorkerStepSnapshot;
  stopping(): void;
  snapshot(): WorkerRuntimeSnapshot;
}
type Mutable = {
  paused: boolean;
  running: boolean;
  hung: boolean;
  runs: number;
  failures: number;
  consecutive: number;
  startedAt: number | null;
  finishedAt: number | null;
  successAt: number | null;
  durationMs: number | null;
  error: WorkerStepError | null;
  notBefore: number | null;
};
const defaultLog = (event: WorkerLogEvent) =>
  (event.level === 'error' ? console.error : console.info)(JSON.stringify(event));
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const text = (s: string) => s.slice(0, 300);
/** Message safe for any admin of any workspace: the loop is cross-tenant, so raw errors stay in the server log. */
export function publicWorkerError(e: unknown): { message: string; code: string | null } {
  if (e instanceof Problem) return { message: text(e.message), code: e.code ?? String(e.status) };
  const code = typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : null;
  if (code && /^[0-9A-Z]{5}$/.test(code))
    return { message: `Błąd bazy danych (kod ${code}); szczegóły w logu serwera`, code };
  return { message: 'Błąd wewnętrzny schedulera; szczegóły w logu serwera', code: null };
}
class WorkerStepTimeout extends Problem {
  constructor(ms: number) {
    super(504, `Krok przekroczył limit czasu ${Math.round(ms / 1000)} s; działa dalej i nie ruszy ponownie, dopóki się nie zakończy`, 'TIMEOUT');
  }
}
const detail = (e: unknown) => text(e instanceof Error ? e.message : String(e));

export function createWorkerSupervisor(
  steps: readonly WorkerStep[],
  options: WorkerSupervisorOptions = {},
): WorkerSupervisor {
  const now = options.now ?? Date.now,
    intervalMs = options.intervalMs ?? 1000,
    base = options.baseBackoffMs ?? 2000,
    max = options.maxBackoffMs ?? 300_000,
    defaultTimeout = options.stepTimeoutMs ?? 120_000,
    log = options.log ?? defaultLog;
  const names = new Set<string>();
  for (const s of steps) {
    if (names.has(s.name)) throw new Error('Powtórzona nazwa kroku workera: ' + s.name);
    names.add(s.name);
  }
  const state = new Map<string, Mutable>(
    steps.map((s) => [
      s.name,
      { paused: false, running: false, hung: false, runs: 0, failures: 0, consecutive: 0, startedAt: null, finishedAt: null,
        successAt: null, durationMs: null, error: null, notBefore: null },
    ]),
  );
  const startedAt = now();
  const laneOf = (s: WorkerStep) => s.lane ?? 'main';
  const limitOf = (s: WorkerStep) => s.timeoutMs ?? defaultTimeout;
  type Lane = { cycles: number; running: boolean; startedAt: number | null; finishedAt: number | null; heartbeat: number };
  const lanes = new Map<string, Lane>();
  for (const s of steps)
    if (!lanes.has(laneOf(s))) lanes.set(laneOf(s), { cycles: 0, running: false, startedAt: null, finishedAt: null, heartbeat: startedAt });
  let stop = false;
  const find = (name: string) => {
    const s = state.get(name);
    if (!s) throw new Problem(404, 'Nieznany scheduler workera');
    return s;
  };
  const view = (step: WorkerStep): WorkerStepSnapshot => {
    const s = state.get(step.name)!;
    const t = now();
    const backoff = s.notBefore !== null && s.notBefore > t;
    return {
      name: step.name,
      label: step.label,
      lane: laneOf(step),
      timeout_ms: limitOf(step),
      state: s.paused ? 'paused' : s.hung ? 'timeout' : s.running ? 'running' : s.consecutive ? 'backoff' : s.runs === 0 ? 'idle' : 'ok',
      paused: s.paused,
      runs: s.runs,
      failures: s.failures,
      consecutive_failures: s.consecutive,
      last_started_at: iso(s.startedAt),
      last_finished_at: iso(s.finishedAt),
      last_success_at: iso(s.successAt),
      last_duration_ms: s.durationMs,
      last_error: s.error,
      next_run_at: s.paused || stop ? null : iso(backoff ? s.notBefore : Math.max(t, (lanes.get(laneOf(step))!.finishedAt ?? t) + intervalMs)),
    };
  };
  async function runStep(step: WorkerStep) {
    const s = state.get(step.name)!;
    if (s.paused || s.hung) return;
    const begin = now();
    if (s.notBefore !== null && s.notBefore > begin) return;
    s.running = true;
    s.startedAt = begin;
    s.runs++;
    const limit = limitOf(step);
    const work = Promise.resolve().then(step.run);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), limit);
    });
    try {
      if ((await Promise.race([work, timedOut])) === 'timeout') {
        s.hung = true;
        void work.then(
          () => settle(step, s, null),
          (e) => settle(step, s, e),
        );
        throw new WorkerStepTimeout(limit);
      }
      const end = now();
      if (s.consecutive)
        log({ level: 'info', component: 'worker', event: 'scheduler_recovered', scheduler: step.name, after_failures: s.consecutive });
      s.consecutive = 0;
      s.notBefore = null;
      s.successAt = end;
    } catch (e) {
      const end = now();
      s.failures++;
      s.consecutive++;
      const delay = Math.min(max, base * 2 ** Math.min(s.consecutive - 1, 30));
      s.notBefore = end + delay;
      s.error = { ...publicWorkerError(e), at: new Date(end).toISOString() };
      log({ level: 'error', component: 'worker', event: e instanceof WorkerStepTimeout ? 'scheduler_timeout' : 'scheduler_failed', scheduler: step.name,
        consecutive_failures: s.consecutive, failures: s.failures, backoff_ms: delay,
        next_run_at: new Date(s.notBefore).toISOString(), error: detail(e), code: s.error.code });
    } finally {
      clearTimeout(timer);
      s.running = false;
      s.finishedAt = now();
      s.durationMs = s.finishedAt - begin;
    }
  }
  function settle(step: WorkerStep, s: Mutable, e: unknown) {
    s.hung = false;
    log({ level: e ? 'error' : 'info', component: 'worker', event: 'scheduler_timeout_settled', scheduler: step.name,
      ...(e ? { error: detail(e) } : {}) });
  }
  return {
    async runCycle(name) {
      for (const [laneName, lane] of lanes) {
        if (name !== undefined && laneName !== name) continue;
        if (lane.running) continue;
        lane.running = true;
        lane.startedAt = lane.heartbeat = now();
        try {
          for (const step of steps) {
            if (stop) break;
            if (laneOf(step) !== laneName) continue;
            await runStep(step);
            lane.heartbeat = now();
          }
        } finally {
          lane.cycles++;
          lane.running = false;
          lane.finishedAt = lane.heartbeat = now();
        }
      }
    },
    lanes() {
      return [...lanes.keys()];
    },
    pause(name) {
      const s = find(name);
      if (!s.paused) {
        s.paused = true;
        log({ level: 'info', component: 'worker', event: 'scheduler_paused', scheduler: name });
      }
      return view(steps.find((x) => x.name === name)!);
    },
    resume(name) {
      const s = find(name);
      if (s.paused) {
        s.paused = false;
        // The operator asked for it now: the next cycle runs it even if it was backing off.
        s.notBefore = null;
        log({ level: 'info', component: 'worker', event: 'scheduler_resumed', scheduler: name });
      }
      return view(steps.find((x) => x.name === name)!);
    },
    stopping() {
      stop = true;
    },
    snapshot() {
      const all = [...lanes.values()];
      const latest = (pick: (l: Lane) => number | null) =>
        iso(all.reduce<number | null>((m, l) => (pick(l) === null ? m : Math.max(m ?? 0, pick(l)!)), null));
      return {
        state: stop ? 'STOPPING' : 'RUNNING',
        started_at: new Date(startedAt).toISOString(),
        interval_ms: intervalMs,
        cycles: all.reduce((n, l) => n + l.cycles, 0),
        cycle_running: all.some((l) => l.running),
        heartbeat_at: latest((l) => l.heartbeat) ?? new Date(startedAt).toISOString(),
        last_cycle_started_at: latest((l) => l.startedAt),
        last_cycle_finished_at: latest((l) => l.finishedAt),
        pause_scope: 'RUNTIME_ONLY_RESET_ON_RESTART',
        lanes: [...lanes].map(([lane, l]) => ({
          lane,
          cycles: l.cycles,
          cycle_running: l.running,
          heartbeat_at: new Date(l.heartbeat).toISOString(),
          last_cycle_started_at: iso(l.startedAt),
          last_cycle_finished_at: iso(l.finishedAt),
        })),
        steps: steps.map(view),
      };
    },
  };
}

/** The one global loop of this process (server/index.ts). Absent in the ordinary runtime and with DYNA_WORKER_DISABLED=true. */
let active: WorkerSupervisor | undefined;
export function registerWorkerRuntime(s: WorkerSupervisor): () => void {
  active = s;
  return () => {
    if (active === s) active = undefined;
  };
}
export function workerRuntime(): WorkerSupervisor | undefined {
  return active;
}
