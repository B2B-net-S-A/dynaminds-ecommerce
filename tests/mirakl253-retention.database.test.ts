/** Migration 253_mirakl_webhook_retention (prepared as 263, registered after 252): retention of
 * the Mirakl webhook event log mirakl262_webhook_events (252). The log stays append-only, also for the owner; events
 * older than 90 days leave only through mirakl263_purge_webhook_events() of the caller's tenant (at most 1000 per call),
 * which the worker step mirakl.operations (sweepMirakl262Due) calls for every tenant with expired events.
 * Database test on a fresh disposable clone dynaminds_m253_YYYYMMDD_NN of the restored template; the real migrate()
 * applies 253 and its ledger row. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { sweepMirakl262Due } from '../server/mirakl262';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:25[3456789]|26[0123])_202610(?:28|29|30)_[0-9]{2}$/, 'fresh clone dynaminds_m253_YYYYMMDD_NN (or m254/m255/m256/m257/m258/m259/m260/m261/m262/m263 after 254/255/256/257/258/259/260/261/262) of the restored template');
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

const A = DEMO_TENANT, B = SECOND_TENANT;
/** Owner insert with a backdated received_at (INSERT is not guarded; the app inserts as dyna_app). */
async function events(tenant: string, endpoint: string, n: number, ageDays: number): Promise<void> {
  await pool.query(`INSERT INTO mirakl262_webhook_events(id,tenant_id,endpoint_id,event_id,event_type,body_sha256,outcome,received_at)
    SELECT gen_random_uuid(),$1,$2,'ev-'||$4||'-'||g||'-'||left(md5(random()::text),8),'ORDER_STATE_CHANGED',repeat('a',64),'recorded',
      now()-make_interval(secs=>$3::float8*86400) FROM generate_series(1,$5::int) g`, [tenant, endpoint, ageDays, Math.round(ageDays), n]);
}
const count = async (tenant: string, olderThanDays?: number) => (await pool.query(
  'SELECT count(*)::int n FROM mirakl262_webhook_events WHERE tenant_id=$1 AND ($2::float8 IS NULL OR received_at<now()-make_interval(secs=>$2::float8*86400))',
  [tenant, olderThanDays ?? null])).rows[0].n as number;
const purge = (tenant: string) => tenantTx(tenant, async c => Number((await c.query('SELECT public.mirakl263_purge_webhook_events() n')).rows[0].n));
const code = (expected: string) => (e: any) => { assert.equal(e?.code, expected, String(e?.message)); return true; };
async function clean() {
  // Test-only reset between tests: the owner lifts the row guard inside one transaction.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE mirakl262_webhook_events DISABLE TRIGGER mirakl263_webhook_events_append_only');
    await c.query('DELETE FROM mirakl262_webhook_events WHERE tenant_id=ANY($1::uuid[])', [[A, B]]);
    await c.query('ALTER TABLE mirakl262_webhook_events ENABLE TRIGGER mirakl263_webhook_events_append_only');
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

before(async () => {
  await migrate();
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='253_mirakl_webhook_retention'")).rows[0].n, 1, 'migrate() applied 253');
  assert.equal((await pool.query("SELECT to_regprocedure('public.mirakl263_purge_webhook_events()') IS NOT NULL ok")).rows[0].ok, true, '253 purge present');
  await seed();
});
after(async () => { await pool.end(); });

test('the event log stays append-only: dyna_app cannot delete or update; the owner cannot delete a recent row, update or truncate', async () => {
  await clean();
  const ep = randomUUID();
  await events(A, ep, 1, 0);
  await events(A, ep, 1, 120);
  await assert.rejects(tenantTx(A, c => c.query('DELETE FROM mirakl262_webhook_events')), code('42501'));
  await assert.rejects(tenantTx(A, c => c.query("UPDATE mirakl262_webhook_events SET outcome='recorded'")), code('42501'));
  await assert.rejects(pool.query("DELETE FROM mirakl262_webhook_events WHERE tenant_id=$1 AND received_at>now()-interval '1 day'", [A]), code('55000'));
  await assert.rejects(pool.query("DELETE FROM mirakl262_webhook_events WHERE tenant_id=$1 AND received_at<now()-interval '100 days'", [A]), code('55000'),
    'an old row too: only the purge of its tenant may remove it');
  await assert.rejects(pool.query("UPDATE mirakl262_webhook_events SET event_type='X' WHERE tenant_id=$1", [A]), code('55000'));
  await assert.rejects(pool.query('TRUNCATE mirakl262_webhook_events'), code('55000'));
  // The purge of tenant B sets the flag only for B: tenant A's old row stays.
  assert.equal(await purge(B), 0);
  assert.equal(await count(A), 2);
});

test('the purge removes only the caller tenant\'s events older than 90 days, at most 1000 per call; no tenant is refused', async () => {
  await clean();
  const a = randomUUID(), b = randomUUID();
  await events(A, a, 3, 91);
  await events(A, a, 1, 89);
  await events(A, randomUUID(), 2, 200); // a replaced (old) endpoint: its events expire as well
  await events(B, b, 1003, 95);
  await events(B, b, 2, 10);
  assert.equal(await purge(A), 5);
  assert.equal(await count(A), 1, 'the 89-day event stays');
  assert.equal(await count(B), 1005, 'the other tenant is untouched');
  assert.equal(await purge(B), 1000, 'bounded per call');
  assert.equal(await purge(B), 3);
  assert.equal(await purge(B), 0);
  assert.equal(await count(B), 2);
  await assert.rejects(pool.query('SELECT public.mirakl263_purge_webhook_events()'), code('42501'));
  assert.equal((await pool.query("SELECT current_setting('mirakl263.purge',true) v")).rows[0].v ?? '', '', 'no flag outlives the purge');
});

test('the worker step mirakl.operations purges every tenant with expired events and keeps the window', async () => {
  await clean();
  await events(A, randomUUID(), 4, 100);
  await events(A, randomUUID(), 2, 30);
  await events(B, randomUUID(), 3, 365);
  await sweepMirakl262Due();
  assert.equal(await count(A, 90), 0);
  assert.equal(await count(B, 90), 0);
  assert.equal(await count(A), 2);
  assert.equal(await count(B), 0);
  await sweepMirakl262Due();
  assert.equal(await count(A), 2, 'nothing inside the window leaves');
});
