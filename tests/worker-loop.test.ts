import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkerSupervisor,
  publicWorkerError,
  workerRuntime,
  type WorkerLogEvent,
  type WorkerStep,
} from '../server/worker-supervisor';
import { startWorker, workerSteps } from '../server/worker';
import { Problem } from '../server/errors';

const step = (name: string, run: () => Promise<unknown>): WorkerStep => ({ name, label: name, run });
const clock = (start = Date.UTC(2026, 9, 25, 10)) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};
const byName = (s: ReturnType<ReturnType<typeof createWorkerSupervisor>['snapshot']>, name: string) =>
  s.steps.find((x) => x.name === name)!;

test('a scheduler that throws does not prevent the next one in the same cycle', async () => {
  const ran: string[] = [];
  const supervisor = createWorkerSupervisor(
    [
      step('first', async () => void ran.push('first')),
      step('broken', async () => {
        ran.push('broken');
        throw new Error('boom');
      }),
      step('after', async () => void ran.push('after')),
      step('jobs', async () => void ran.push('jobs')),
    ],
    { log: () => {} },
  );
  await supervisor.runCycle();
  assert.deepEqual(ran, ['first', 'broken', 'after', 'jobs']);
});

test('a failing scheduler backs off exponentially, is counted and logged as structured JSON', async () => {
  const c = clock(),
    logs: WorkerLogEvent[] = [];
  let brokenRuns = 0,
    okRuns = 0;
  const supervisor = createWorkerSupervisor(
    [
      step('broken', async () => {
        brokenRuns++;
        throw new Error('relation "x" does not exist');
      }),
      step('ok', async () => void okRuns++),
    ],
    { now: c.now, baseBackoffMs: 2000, maxBackoffMs: 8000, log: (e) => logs.push(e) },
  );
  await supervisor.runCycle();
  let b = byName(supervisor.snapshot(), 'broken');
  assert.equal(b.state, 'backoff');
  assert.equal(b.consecutive_failures, 1);
  assert.equal(b.next_run_at, new Date(c.now() + 2000).toISOString());
  assert.deepEqual(
    { event: logs[0]!.event, scheduler: logs[0]!.scheduler, backoff_ms: logs[0]!.backoff_ms, error: logs[0]!.error },
    { event: 'scheduler_failed', scheduler: 'broken', backoff_ms: 2000, error: 'relation "x" does not exist' },
  );
  c.advance(1000);
  await supervisor.runCycle(); // still backing off: skipped, the other step keeps running
  assert.equal(brokenRuns, 1);
  assert.equal(okRuns, 2);
  c.advance(1000);
  await supervisor.runCycle();
  assert.equal(brokenRuns, 2);
  b = byName(supervisor.snapshot(), 'broken');
  assert.equal(b.consecutive_failures, 2);
  assert.equal(b.next_run_at, new Date(c.now() + 4000).toISOString());
  for (let i = 0; i < 3; i++) {
    c.advance(10_000);
    await supervisor.runCycle();
  }
  b = byName(supervisor.snapshot(), 'broken');
  assert.equal(b.next_run_at, new Date(c.now() + 8000).toISOString(), 'backoff is capped');
  assert.equal(b.failures, 5);
  assert.equal(okRuns, 6);
  assert.equal(byName(supervisor.snapshot(), 'ok').state, 'ok');
});

test('a recovered scheduler resets its consecutive failures and keeps the last error for the operator', async () => {
  const c = clock(),
    logs: WorkerLogEvent[] = [];
  let fail = true;
  const supervisor = createWorkerSupervisor(
    [
      step('flaky', async () => {
        if (fail) throw new Problem(409, 'Konflikt dzierżawy');
      }),
    ],
    { now: c.now, log: (e) => logs.push(e) },
  );
  await supervisor.runCycle();
  fail = false;
  c.advance(2000);
  await supervisor.runCycle();
  const s = byName(supervisor.snapshot(), 'flaky');
  assert.equal(s.state, 'ok');
  assert.equal(s.consecutive_failures, 0);
  assert.equal(s.failures, 1);
  assert.equal(s.last_error?.message, 'Konflikt dzierżawy');
  assert.equal(s.last_success_at, new Date(c.now()).toISOString());
  assert.deepEqual(logs.map((l) => l.event), ['scheduler_failed', 'scheduler_recovered']);
});

test('pause skips only that scheduler; resume runs it on the next cycle even during backoff', async () => {
  const c = clock(),
    ran: string[] = [];
  const supervisor = createWorkerSupervisor(
    [
      step('a', async () => {
        ran.push('a');
        throw new Error('x');
      }),
      step('b', async () => void ran.push('b')),
    ],
    { now: c.now, log: () => {} },
  );
  assert.equal(supervisor.pause('b').state, 'paused');
  assert.equal(byName(supervisor.snapshot(), 'b').next_run_at, null);
  await supervisor.runCycle();
  assert.deepEqual(ran, ['a']);
  supervisor.pause('a');
  supervisor.resume('b');
  await supervisor.runCycle();
  assert.deepEqual(ran, ['a', 'b']);
  supervisor.resume('a'); // was in backoff: operator resume clears the delay
  await supervisor.runCycle();
  assert.deepEqual(ran, ['a', 'b', 'a', 'b']);
  assert.throws(() => supervisor.pause('nope'), (e: unknown) => e instanceof Problem && e.status === 404);
});

test('heartbeat and cycle counters move with each cycle; duplicate step names are refused', async () => {
  const c = clock();
  const supervisor = createWorkerSupervisor([step('a', async () => c.advance(5))], { now: c.now, intervalMs: 1000 });
  const before = supervisor.snapshot();
  assert.equal(before.cycles, 0);
  assert.equal(before.last_cycle_finished_at, null);
  c.advance(100);
  await supervisor.runCycle();
  const after = supervisor.snapshot();
  assert.equal(after.cycles, 1);
  assert.equal(after.heartbeat_at, new Date(c.now()).toISOString());
  assert.equal(after.steps[0]!.last_duration_ms, 5);
  assert.equal(after.steps[0]!.next_run_at, new Date(c.now() + 1000).toISOString());
  assert.equal(after.pause_scope, 'RUNTIME_ONLY_RESET_ON_RESTART');
  assert.throws(() => createWorkerSupervisor([step('a', async () => {}), step('a', async () => {})]));
});

test('public error never exposes raw internal messages', () => {
  assert.deepEqual(publicWorkerError(new Error('password authentication failed for user "postgres"')), {
    message: 'Błąd wewnętrzny schedulera; szczegóły w logu serwera',
    code: null,
  });
  assert.deepEqual(publicWorkerError(Object.assign(new Error('relation "secret_table" does not exist'), { code: '42P01' })), {
    message: 'Błąd bazy danych (kod 42P01); szczegóły w logu serwera',
    code: '42P01',
  });
  assert.equal(publicWorkerError(new Problem(422, 'Brak konfiguracji')).message, 'Brak konfiguracji');
});

test('the real loop has all 19 schedulers (245: IMAP schedules, 251: B2B lifecycle, 252: Mirakl, rules v2 time checks) and the job tick, each isolated by name', () => {
  const names = workerSteps().map((s) => s.name);
  assert.equal(names.length, 20);
  assert.equal(new Set(names).size, 20);
  assert(names.includes('automations.v2.time'));
  assert(names.includes('mirakl.operations'));
  assert(names.includes('email.inbound_schedules'));
  assert(names.includes('b2b.network.lifecycle'));
  assert.equal(names.at(-1), 'jobs.tick');
});

test('startWorker registers the runtime, keeps running after a failing step and unregisters on stop', async () => {
  let okRuns = 0;
  const stop = startWorker(
    {},
    {
      intervalMs: 10,
      steps: [step('broken', async () => Promise.reject(new Error('down'))), step('ok', async () => void okRuns++)],
      supervisor: { log: () => {} },
    },
  );
  try {
    for (let i = 0; i < 100 && okRuns < 3; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(okRuns >= 3, 'later step keeps running every cycle');
    const s = workerRuntime()!.snapshot();
    assert.equal(s.state, 'RUNNING');
    assert.ok(s.cycles >= 3);
    assert.equal(byName(s, 'broken').state, 'backoff');
  } finally {
    await stop();
  }
  assert.equal(workerRuntime(), undefined);
});

test('a slow job lane does not hold the scheduler lane; each lane keeps its own heartbeat', async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let schedulerRuns = 0;
  const stop = startWorker(
    {},
    {
      intervalMs: 10,
      steps: [
        step('scheduler', async () => void schedulerRuns++),
        { name: 'jobs.tick', label: 'jobs', lane: 'jobs', run: () => hold },
      ],
      supervisor: { log: () => {} },
    },
  );
  try {
    for (let i = 0; i < 100 && schedulerRuns < 5; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(schedulerRuns >= 5, 'schedulers keep cycling while a job runs');
    const s = workerRuntime()!.snapshot();
    const lanes = Object.fromEntries(s.lanes.map((l) => [l.lane, l]));
    assert.equal(lanes.jobs!.cycles, 0);
    assert.equal(lanes.jobs!.cycle_running, true);
    assert.ok(lanes.main!.cycles >= 5);
    assert.equal(byName(s, 'jobs.tick').state, 'running');
    assert.equal(byName(s, 'jobs.tick').lane, 'jobs');
  } finally {
    release();
    await stop();
  }
});

test('a step over its time limit is marked TIMEOUT, the lane moves on and it is not started twice', async () => {
  const c = clock(),
    logs: WorkerLogEvent[] = [];
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let hungRuns = 0,
    afterRuns = 0;
  const supervisor = createWorkerSupervisor(
    [
      { name: 'hung', label: 'hung', timeoutMs: 20, run: () => (hungRuns++, hold) },
      step('after', async () => void afterRuns++),
    ],
    { now: c.now, baseBackoffMs: 1000, log: (e) => logs.push(e) },
  );
  const started = Date.now();
  await supervisor.runCycle();
  assert.ok(Date.now() - started < 1000, 'the cycle ends at the time limit, not when the step ends');
  assert.equal(afterRuns, 1);
  let h = byName(supervisor.snapshot(), 'hung');
  assert.equal(h.state, 'timeout');
  assert.equal(h.timeout_ms, 20);
  assert.equal(h.last_error?.code, 'TIMEOUT');
  assert.equal(h.failures, 1);
  assert.equal(logs.find((l) => l.event === 'scheduler_timeout')?.scheduler, 'hung');
  c.advance(5000);
  await supervisor.runCycle();
  assert.equal(hungRuns, 1, 'still running: the same step is not started a second time');
  assert.equal(afterRuns, 2);
  release();
  await hold;
  await new Promise((r) => setImmediate(r));
  h = byName(supervisor.snapshot(), 'hung');
  assert.notEqual(h.state, 'timeout');
  c.advance(5000);
  await supervisor.runCycle();
  assert.equal(hungRuns, 2, 'after the hung run ended the step runs again');
  assert.equal(byName(supervisor.snapshot(), 'hung').state, 'ok');
});

test('every real step has a time limit; the job tick gets a longer one than the schedulers', () => {
  const steps = workerSteps();
  const supervisor = createWorkerSupervisor(steps, { log: () => {} });
  const s = supervisor.snapshot();
  for (const x of s.steps) assert.ok((x.timeout_ms ?? 0) > 0, x.name);
  assert.ok(byName(s, 'jobs.tick').timeout_ms! > byName(s, 'integrations.sync').timeout_ms!);
});
