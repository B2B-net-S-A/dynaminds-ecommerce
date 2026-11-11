/** 264: one full catalog_stock_control_guards() per READ ONLY REPEATABLE READ transaction (load run full-20261028-01,
 * docs/scale/LOAD-TEST-FULL-20261028.md section 3: the order detail ran one full guard per return case).
 * Runs on a fresh PG04 clone dynaminds_p264_YYYYMMDD_NN of the restored template; the real migrate() brings it to HEAD.
 * Every transaction here is read only or rolled back; the clone is not changed beyond migrate().
 * The question for every case: can a reused 'available' answer where a full guard could have answered differently? */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { migrate, pool, tenantReadTx } from '../server/db';
import { getOrder } from '../server/domain';
import { catalogStockControlAvailabilityInTx } from '../server/catalog-stock-control-transaction';
import { relaxPoolTimeouts } from './failure-helpers';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_p264_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_p264_YYYYMMDD_NN required');
relaxPoolTimeouts(120);

let tenant = '', orderId = '';
before(async () => {
  await migrate();
  const row = (await pool.query(`SELECT order_id,tenant_id FROM return_cases WHERE order_id IS NOT NULL
    GROUP BY order_id,tenant_id HAVING count(*)>=3 ORDER BY count(*) DESC,order_id LIMIT 1`)).rows[0];
  assert(row, 'an order with at least three return cases');
  tenant = row.tenant_id; orderId = row.order_id;
});
after(async () => { await pool.end(); });

/** Function call counters of this transaction; track_functions is superuser-only, so it is set as the owner.
 * pg_stat_xact_user_functions also shows this backend's not yet flushed counts of earlier transactions, so every
 * count is taken against the baseline read when tracking starts. */
let base = new Map<string, number>();
const raw = async (c: PoolClient, f: string) =>
  (await c.query('SELECT coalesce(sum(calls),0)::int n FROM pg_stat_xact_user_functions WHERE funcname=$1', [f])).rows[0].n as number;
async function track(c: PoolClient) {
  const role = (await c.query('SELECT current_user r')).rows[0].r;
  await c.query('RESET ROLE'); await c.query("SET LOCAL track_functions='all'");
  base = new Map([['catalog_stock_control_guards', await raw(c, 'catalog_stock_control_guards')], ['guard_verdict', await raw(c, 'guard_verdict')]]);
  if (role === 'dyna_app') await c.query('SET LOCAL ROLE dyna_app');
}
const calls = async (c: PoolClient, f: string) => (await raw(c, f)) - (base.get(f) ?? 0);
const guards = (c: PoolClient) => calls(c, 'catalog_stock_control_guards');

/** A transaction as the application opens it, on one fixed client: owner session, dyna_app role, tenant context. */
async function tx<T>(c: PoolClient, mode: string, fn: () => Promise<T>, end: 'COMMIT' | 'ROLLBACK' = 'COMMIT') {
  await c.query(`BEGIN ${mode}`);
  try {
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await track(c);
    const r = await fn(); await c.query(end); return r;
  } catch (e) { await c.query('ROLLBACK'); throw e; }
}
const RO = 'ISOLATION LEVEL REPEATABLE READ READ ONLY';
async function times(c: PoolClient, n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await catalogStockControlAvailabilityInTx(c));
  return out;
}

test('one order-detail read with at least three return cases runs the full guard once', async () => {
  const r = await tenantReadTx(tenant, async (c) => {
    await track(c);
    const order: any = await getOrder(c, orderId);
    return { order, n: await guards(c) };
  });
  assert(r.order.returns.cases.length >= 3, 'the order read covers at least three return cases');
  for (const rc of r.order.returns.cases) assert(Array.isArray(rc.stock_receipts));
  assert.equal(r.n, 1, 'one full catalog guard per read transaction, not one per return case');
});

test('repeated availability in one READ ONLY REPEATABLE READ transaction: the first is a full guard, the rest reuse it', async () => {
  const c = await pool.connect();
  try {
    for (const mode of [RO, 'ISOLATION LEVEL SERIALIZABLE READ ONLY']) {
      const r = await tx(c, mode, async () => ({ v: await times(c, 4), n: await guards(c) }));
      assert.deepEqual(r.v, ['available', 'available', 'available', 'available'], mode);
      assert.equal(r.n, 1, mode);
    }
  } finally { c.release(); }
});

test('separate transactions on the same client do not share the reuse; COMMIT, ROLLBACK and ROLLBACK TO end it', async () => {
  const c = await pool.connect();
  try {
    assert.equal(await tx(c, RO, async () => { await times(c, 2); return guards(c); }), 1);
    assert.equal(await tx(c, RO, async () => { await times(c, 2); return guards(c); }), 1, 'a new transaction runs its own full guard');
    assert.equal(await tx(c, RO, async () => { await times(c, 2); return guards(c); }, 'ROLLBACK'), 1);
    assert.equal(await tx(c, RO, async () => { await times(c, 1); return guards(c); }), 1, 'after a rolled back transaction');
    assert.equal(await tx(c, RO, async () => {
      await c.query('SAVEPOINT s'); await times(c, 2); await c.query('ROLLBACK TO SAVEPOINT s');
      await times(c, 2); return guards(c);
    }), 2, 'a rolled back savepoint drops the reuse: the next call is a full guard again');
    assert.equal(await tx(c, RO, async () => (await c.query("SELECT current_setting('app.catalog_stock_control_tx',true) m")).rows[0].m), '',
      'the transaction-local marker does not outlive its transaction');
  } finally { c.release(); }
});

test('READ COMMITTED and read-write REPEATABLE READ never reuse; every call asks the verdict again', async () => {
  const c = await pool.connect();
  try {
    const rc = await tx(c, 'ISOLATION LEVEL READ COMMITTED', async () => ({ v: await times(c, 3), n: await calls(c, 'guard_verdict') }), 'ROLLBACK');
    assert.deepEqual(rc.v, ['available', 'available', 'available']);
    assert.equal(rc.n, 3, 'READ COMMITTED: a new snapshot per statement, so three verdicts (cheap there by 248)');
    const rw = await tx(c, 'ISOLATION LEVEL REPEATABLE READ', async () => ({ v: await times(c, 3), n: await guards(c) }), 'ROLLBACK');
    assert.deepEqual(rw.v, ['available', 'available', 'available']);
    assert.equal(rw.n, 3, 'a read-write transaction may change what the guard reads, so three full guards');
  } finally { c.release(); }
});

test('a changed session setting or role between calls is a miss', async () => {
  const c = await pool.connect();
  try {
    assert.equal(await tx(c, RO, async () => {
      await times(c, 1); await c.query("SET LOCAL xmloption=document"); await times(c, 2); return guards(c);
    }), 2);
    assert.equal(await tx(c, RO, async () => {
      await times(c, 1); await c.query('RESET ROLE'); await times(c, 2); return guards(c);
    }), 2, 'owner call after a dyna_app call');
  } finally { c.release(); }
});

test('a session with own TEMP relations never reuses', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app');
    await c.query('CREATE TEMP TABLE zz_memo264(x int) ON COMMIT PRESERVE ROWS'); await c.query('COMMIT');
    assert.equal(await tx(c, RO, async () => { await times(c, 3); return guards(c); }), 3);
  } finally {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app'); await c.query('DROP TABLE IF EXISTS pg_temp.zz_memo264'); await c.query('COMMIT');
    c.release(true);
  }
});

test('unavailable and errors are never reused as available (scripted client)', async () => {
  let ok: boolean | Error = false, marker = '', guardRuns = 0, sets = 0;
  const stub = {
    release() {},
    async query(sql: string, params?: unknown[]) {
      if (sql.startsWith("SELECT current_setting('transaction_isolation')")) return { rows: [{ snapshot: true, marker, session: 's' }] };
      if (sql.startsWith('SELECT current_user role')) return { rows: [{ role: 'postgres', owner: 'postgres' }] };
      if (sql.includes("to_regprocedure('public.catalog_stock_control_installed()')")) return { rows: [{ marker: 'x', partial: true, ledger: true, verdict: 'y' }] };
      if (sql.includes('guard_verdict')) { guardRuns++; if (ok instanceof Error) throw ok; return { rows: [{ ok }] }; }
      if (sql.startsWith("SELECT set_config('app.catalog_stock_control_tx'")) { sets++; marker = String(params![0]); return { rows: [{}] }; }
      throw new Error('unexpected ' + sql);
    },
  } as unknown as PoolClient;
  assert.deepEqual([await catalogStockControlAvailabilityInTx(stub), await catalogStockControlAvailabilityInTx(stub)], ['unavailable', 'unavailable']);
  assert.deepEqual([guardRuns, sets], [2, 0], 'unavailable: a full guard every time, nothing stored');
  ok = new Error('guard raised');
  await assert.rejects(catalogStockControlAvailabilityInTx(stub), /guard raised/);
  assert.deepEqual([guardRuns, sets], [3, 0], 'an error stores nothing');
  ok = true;
  assert.deepEqual([await catalogStockControlAvailabilityInTx(stub), await catalogStockControlAvailabilityInTx(stub)], ['available', 'available']);
  assert.deepEqual([guardRuns, sets], [4, 1], 'available: stored once, reused once');
  marker = ''; ok = false; // a new transaction: the marker reverted
  assert.equal(await catalogStockControlAvailabilityInTx(stub), 'unavailable');
  assert.deepEqual([guardRuns, sets], [5, 1]);
});
