/** Prepared migration 273 (placeholder number; docs/parity/WZ-ISSUER-GEN273-20261029.md), the TS refresher without a
 * database: one owner transaction READ COMMITTED READ WRITE with the finite cold budget that asks wz_issuer273_refresh(),
 * at most one background refresh per process, errors logged and never thrown into the request that scheduled it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { refreshWzIssuerVerdict, scheduleWzIssuerRefresh } from '../server/wz-issuer273-refresh';

type Answer = (sql: string) => Record<string, unknown> | Error | Promise<Record<string, unknown> | Error>;
function fakePool(answer: Answer) {
  const log: string[] = [];
  let connects = 0, releases = 0;
  const client = {
    query: async (sql: string) => { log.push(sql); const r = await answer(sql); if (r instanceof Error) throw r; return { rows: [r] }; },
    release: (e?: unknown) => { assert.equal(e, undefined, 'a healthy client goes back to the pool'); releases++; },
  };
  const pool = { connect: async () => { connects++; return client; } } as unknown as Pool;
  return { pool, log, counts: () => ({ connects, releases }) };
}
const installed: Answer = (sql) => sql.includes('to_regprocedure') ? { present: 'wz_issuer273_refresh()' } : sql.includes('wz_issuer273_refresh() r') ? { r: true } : {};

test('a refresh is its own READ COMMITTED READ WRITE transaction with the cold budget and asks only wz_issuer273_refresh()', async () => {
  const f = fakePool(installed);
  assert.equal(await refreshWzIssuerVerdict(f.pool), true);
  assert.deepEqual(f.log, ['BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE', "SET LOCAL statement_timeout='120s'",
    "SELECT to_regprocedure('public.wz_issuer273_refresh()') present", 'SELECT public.wz_issuer273_refresh() r', 'COMMIT']);
  assert.deepEqual(f.counts(), { connects: 1, releases: 1 });
});

test('without 273 the refresher answers null and runs nothing else', async () => {
  const f = fakePool((sql) => sql.includes('to_regprocedure') ? { present: null } : {});
  assert.equal(await refreshWzIssuerVerdict(f.pool), null);
  assert.equal(f.log.some((s) => s.includes('wz_issuer273_refresh() r')), false);
  assert.equal(f.log.at(-1), 'COMMIT');
  assert.deepEqual(f.counts(), { connects: 1, releases: 1 });
});

test('a failed refresh rolls back, releases its client and rethrows; scheduled, it is logged and resolves null', async () => {
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const f = fakePool((sql) => sql.includes('wz_issuer273_refresh() r') ? timeout : installed(sql));
  await assert.rejects(refreshWzIssuerVerdict(f.pool), (e: unknown) => e === timeout);
  assert.equal(f.log.at(-1), 'ROLLBACK');
  assert.deepEqual(f.counts(), { connects: 1, releases: 1 });
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: string) => { logged.push(line); };
  try { assert.equal(await scheduleWzIssuerRefresh(f.pool), null); } finally { console.error = original; }
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(logged[0]), { level: 'error', step: 'wz_issuer273.refresh', code: '57014' }, 'the SQLSTATE only, no message');
});

test('a client that cannot roll back is released with its error (discarded by the pool)', async () => {
  const dead = new Error('Connection terminated');
  const released: unknown[] = [];
  const client = { query: async (sql: string) => { if (sql.startsWith('SELECT public.wz_issuer273_refresh') || sql === 'ROLLBACK') throw dead; return { rows: [installed(sql)] }; },
    release: (e?: unknown) => { released.push(e); } };
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(refreshWzIssuerVerdict(pool), (e: unknown) => e === dead);
  assert.deepEqual(released, [dead]);
});

test('at most one background refresh per process: concurrent schedules share it, a later one starts anew', async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const f = fakePool(async (sql) => { if (sql.includes('wz_issuer273_refresh() r')) await gate; return installed(sql); });
  const first = scheduleWzIssuerRefresh(f.pool), second = scheduleWzIssuerRefresh(f.pool);
  assert.equal(first, second, 'the same in-flight refresh');
  open();
  assert.equal(await first, true);
  assert.equal(f.counts().connects, 1);
  assert.equal(await scheduleWzIssuerRefresh(f.pool), true);
  assert.equal(f.counts().connects, 2, 'a settled refresh does not block the next one');
});
