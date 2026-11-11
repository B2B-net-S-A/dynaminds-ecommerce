/** Migration 256_return_receipt_verdicts (prepared as 272) front door for financial_return_capture on a real clone
 * (docs/parity/RETURN-RECEIPT-GEN272-20261029.md "Integracja jako 256"; the catalog side of the same route is the 255 stock_verdict_ generation).
 * Runs on a fresh PG04 clone dynaminds_m256_YYYYMMDD_NN of the restored template; the real migrate() applies 256 and its
 * ledger row (the prepared run applied 272 by hand; that step is dropped). The 182 generation is cold-approved the way release startup does it.
 * The question for every case: does the front door give the same answer or the same error as the sealed function, and
 * does it skip the full guards only where the sealed function would answer NULL? Every comparison runs in savepoints of
 * one owner transaction that is rolled back; tampering is part of those savepoints. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { adjustmentActor } from './stocktake-adjustments-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m(?:25[6789]|26[0123])_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m256_YYYYMMDD_NN of the restored template required');
pool.options.query_timeout = 120000;

const A = new pg.Client({ connectionString: database.href, options: '-c jit=off -c timezone=UTC -c statement_timeout=120000 -c lock_timeout=8000 -c track_functions=all' });
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let f: Awaited<ReturnType<typeof adjustmentActor>>;
let order: Row, line: Row, requested: Row[] = [], received: Row, viaHttp: Row, hash = '';

before(async () => {
  await migrate();
  await seed();
  await A.connect();
  assert.equal((await A.query("SELECT count(*)::int n FROM migrations WHERE name='256_return_receipt_verdicts'")).rows[0].n, 1, 'the real migrate() applied 256 with its ledger row');
  // The HTTP case counts the route's calls in pg_stat_user_functions: the application pool's sessions must track
  // functions, so the clone carries ALTER DATABASE … SET track_functions=all (as the prepared run's clone did).
  assert.equal((await pool.query("SELECT current_setting('track_functions') v")).rows[0].v, 'all', 'clone with ALTER DATABASE SET track_functions=all required');
  app = await buildApp({ integrationTransport: async () => { throw new Error('No external transport in 272'); } });
  const tenant = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own return receipt272','enterprise')", [tenant]);
  f = await adjustmentActor(app, tenant);
  const wh = await f.ok('/warehouses', 'POST', { name: 'R272 WH', code: 'R272-' + randomUUID().slice(0, 8) });
  const product = await f.ok('/products', 'POST', { name: 'R272 product', sku: 'R272-' + randomUUID(), price: 1000, vat: 23, warehouse_id: wh.id, quantity: 9, location: 'A-01' }, 201);
  order = await f.ok('/orders', 'POST', { source: 'manual', customer_name: 'R272 buyer', email: 'r272@example.test',
    address: { street: 'R272', city: 'Warszawa', postal_code: '00-272', country: 'PL', phone: '500000272' },
    warehouse_id: wh.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0, items: [{ product_id: product.id, quantity: 4 }] }, 201);
  order = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt', amount: Number(order.total), currency: 'PLN', method: 'other', reference: 'r272', confirmed: true });
  order = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking', expected_version: String(order.version) });
  let d = await f.ok('/orders/' + order.id);
  for (const it of d.picking_items ?? d.items) {
    const locs = it.locations?.length ? it.locations : [{ quantity: it.quantity, scanned: it.scanned ?? 0 }];
    for (const loc of locs) for (let u = 0; u < Number(loc.quantity) - Number(loc.scanned ?? 0); u++)
      await f.ok('/orders/' + order.id + '/scan', 'POST', { code: it.sku, ...(loc.location ? { location: loc.location } : {}) });
  }
  d = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed', expected_version: String(d.version) });
  await f.ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  d = await f.ok('/orders/' + order.id);
  line = d.returns.items.find((x: Row) => x.available > 0); assert(line);
  for (let n = 0; n < 4; n++) requested.push(await f.ok('/orders/' + order.id + '/returns', 'POST', { client_key: randomUUID(), reason: 'r272', items: [{ item_id: line.id, quantity: 1 }] }, 201));
  viaHttp = requested.pop()!; received = requested.pop()!;
  // one case already received (the sealed functions treat it as history)
  const r = await f.request('/returns/' + received.id + '/receive', 'POST', body(received));
  assert.equal(r.statusCode, 200, r.body);
  hash = (await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 1', [f.user, tenant])).rows[0].token_hash;
  assert.match(hash, /^[a-f0-9]{64}$/);
  // release startup cold-approves the 182 generation (without it every verdict is the full guard)
  await A.query("SELECT public.ordinary187_approve(repeat('a',64),repeat('b',64),repeat('c',64))");
});
after(async () => { try { await app?.close(); } finally { await A.end(); await pool.end(); } });

const body = (rc: Row, over: Row = {}, item: Row = {}) => ({ version: Number(rc.version), shipping_refund: 0, note: 'r272',
  items: [{ item_id: line.id, accepted: 1, restocked: 1, ...item }], ...over });
const calls = async (name: string) => Number((await A.query('SELECT coalesce(sum(calls),0) n FROM pg_stat_xact_user_functions WHERE funcname=$1', [name])).rows[0].n);
const COUNTED = ['financial_return_guards', 'financial_return_capture', 'b2b_credit_fingerprint'];
/** One call as the TS adapter makes it (owner, tenant context, inside the write transaction), at a savepoint that is
 * rolled back; `setup` runs first in the same savepoint (tampering). */
async function call(sql: string, params: unknown[], setup: string[] = []) {
  await A.query('SAVEPOINT s');
  const before = Object.fromEntries(await Promise.all(COUNTED.map(async (n) => [n, await calls(n)])));
  const t = performance.now();
  let out: unknown;
  try {
    for (const q of setup) await A.query(q);
    out = (await A.query(sql, params)).rows[0].v;
  } catch (e: any) { out = 'ERROR ' + e.code + ' ' + e.message; }
  const ms = performance.now() - t;
  // Function counters survive ROLLBACK TO (the sealed side's own count >= 1 checks that), so an error case reads them too.
  await A.query('ROLLBACK TO SAVEPOINT s');
  const used = Object.fromEntries(await Promise.all(COUNTED.map(async (n) => [n, (await calls(n)) - before[n]])));
  return { out, ms, used };
}
const SEALED_CAPTURE = 'SELECT public.financial_return_capture($1,$2,$3,$4,$5::jsonb) v', FRONT_CAPTURE = 'SELECT public.return_receipt272_financial_capture($1,$2,$3,$4,$5::jsonb) v';
async function both(params: unknown[], setup: string[] = []) {
  const sealed = await call(SEALED_CAPTURE, params, setup);
  const front = await call(FRONT_CAPTURE, params, setup);
  assert.deepEqual(front.out, sealed.out, 'same answer or error as the sealed function');
  return { sealed, front };
}
async function owner<T>(fn: () => Promise<T>, isolation = 'READ COMMITTED') {
  await A.query('BEGIN ISOLATION LEVEL ' + isolation);
  try {
    await A.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    return await fn();
  } finally { await A.query('ROLLBACK'); }
}
/** Commit a verdict the way the first writer after a change does (a read-write RC transaction). */
const warm = () => A.query("SELECT public.guard_verdict('financial_return_guards') v");

test('256 is installed on this clone: one owner-only front door', async () => {
  const r = (await A.query(`SELECT p.oid::regprocedure::text sig,p.prosecdef d,pg_get_userbyid(p.proowner)=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.return_cases'::regclass) own,
    has_function_privilege('dyna_app',p.oid,'EXECUTE') app FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'return_receipt272_') ORDER BY 1`)).rows;
  assert.deepEqual(r, [{ sig: 'return_receipt272_financial_capture(uuid,uuid,text,uuid,jsonb)', d: true, own: true, app: false }]);
});

test('financial capture: same answer or error as the sealed capture; NULL without a full guard only where the sealed capture is NULL', async () => {
  await warm();
  const [rc] = requested;
  await owner(async () => {
    const q = (over: Row = {}, item: Row = {}) => JSON.stringify(body(rc, over, item));
    const cases: [string, unknown[], boolean][] = [
      ['restock 1', [f.user, null, hash, rc.id, q()], true],
      ['restock 0, no B2B invoice', [f.user, null, hash, rc.id, q({}, { restocked: 0 })], true],
      ['nothing accepted', [f.user, null, hash, rc.id, q({}, { accepted: 0, restocked: 0 })], true],
      ['received case', [f.user, null, hash, received.id, JSON.stringify(body(received, {}, { restocked: 0 }))], true],
      ['request with wms_lots, no restock', [f.user, null, hash, rc.id, q({ wms_lots: { client_key: randomUUID(), policy_version: '1', stock_versions: [], picks: [] } }, { restocked: 0 })], true],
      ['no identity hash', [f.user, null, null, rc.id, q()], false],
      ['malformed hash', [f.user, null, 'x'.repeat(64), rc.id, q()], false],
      ['no such session', [f.user, null, 'a'.repeat(64), rc.id, q()], false],
      ['foreign user', [randomUUID(), null, hash, rc.id, q()], false],
      ['unknown RMA', [f.user, null, hash, randomUUID(), q()], false],
      ['non-numeric quantity', [f.user, null, hash, rc.id, q({}, { accepted: '1' })], false],
    ];
    for (const [name, params, fast] of cases) {
      const { sealed, front } = await both(params);
      assert(sealed.used.financial_return_guards >= 1, name + ': the sealed capture runs its full guard');
      if (fast) {
        assert.equal(front.out, null, name);
        assert.deepEqual([front.used.financial_return_guards, front.used.financial_return_capture], [0, 0], name + ': verdict hit, no full guard, no sealed call');
      }
      console.log(`# financial ${name}: sealed ${sealed.ms.toFixed(0)} ms, front ${front.ms.toFixed(0)} ms, b2b_credit_fingerprint ${sealed.used.b2b_credit_fingerprint}->${front.used.b2b_credit_fingerprint} -> ${JSON.stringify(front.out).slice(0, 90)}`);
    }
  });
});

test('tampering: a state the full guard rejects is rejected by the front door too (the verdict misses, the sealed function raises)', async () => {
  await warm();
  const [rc] = requested;
  const capture = [f.user, null, hash, rc.id, JSON.stringify(body(rc))];
  const probe = (sig: string) => `UPDATE pg_catalog.pg_proc SET prosrc=prosrc||E'\\n-- p272 probe\\n' WHERE oid='public.${sig}'::regprocedure`;
  await owner(async () => {
    for (const [name, setup] of [
      ['owner DDL on a financial return table', ['ALTER TABLE public.financial_return_receipts ADD COLUMN zz_probe272 int']],
      ['sealed financial frame body changed', [probe('financial_return_frame(uuid,uuid,text,uuid,jsonb)')]],
      ['sealed capture body changed', [probe('financial_return_capture(uuid,uuid,text,uuid,jsonb)')]],
      ['sealed identity body changed', [probe('financial_return_identity(uuid,uuid,text,uuid,boolean)')]],
      ['b2b_credit fingerprinted function changed', [probe('b2b_credit_fingerprint()')]],
    ] as const) {
      const { front } = await both(capture, [...setup]);
      assert.match(String(front.out), /^ERROR 55000 /, name + ': ' + String(front.out));
    }
  });
});

test('REPEATABLE READ: the verdict is the full guard; answers still match', async () => {
  const [rc] = requested;
  await owner(async () => {
    const g = await both([f.user, null, hash, rc.id, JSON.stringify(body(rc))]);
    assert.equal(g.front.out, null);
    assert(g.front.used.financial_return_guards >= 1, 'no cached answer outside READ COMMITTED');
  }, 'REPEATABLE READ');
});

test('cost on a verdict hit: median of 5, front door vs sealed (restock 1)', async () => {
  await warm();
  const [rc] = requested;
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[2];
  await owner(async () => {
    const r: Record<string, number[]> = { sc: [], fc: [] };
    for (let n = 0; n < 5; n++) {
      r.sc.push((await call(SEALED_CAPTURE, [f.user, null, hash, rc.id, JSON.stringify(body(rc))])).ms);
      r.fc.push((await call(FRONT_CAPTURE, [f.user, null, hash, rc.id, JSON.stringify(body(rc))])).ms);
    }
    console.log(`# median ms: financial capture sealed ${med(r.sc).toFixed(1)} front ${med(r.fc).toFixed(1)}`);
    assert(med(r.fc) < med(r.sc));
  });
});

test('the ordinary receive over HTTP goes through the front door and records the receipt', async () => {
  await warm();
  const before = Object.fromEntries((await A.query("SELECT funcname,calls FROM pg_stat_user_functions WHERE funcname='return_receipt272_financial_capture'")).rows.map((r) => [r.funcname, Number(r.calls)]));
  const reply = await f.request('/returns/' + viaHttp.id + '/receive', 'POST', body(viaHttp));
  assert.equal(reply.statusCode, 200, reply.body);
  const data = reply.json();
  assert.equal(data.reused, false); assert.equal(data.receive_receipt.return_id, viaHttp.id); assert(data.receive_receipt.receipt_sequence > 0);
  assert.equal((await pool.query("SELECT state FROM return_cases WHERE id=$1", [viaHttp.id])).rows[0].state, 'refund_pending');
  await new Promise((r) => setTimeout(r, 11500)); // an idle backend flushes its statistics within 10 s (PGSTAT_IDLE_INTERVAL)
  const now = Object.fromEntries((await A.query("SELECT funcname,calls FROM pg_stat_user_functions WHERE funcname='return_receipt272_financial_capture'")).rows.map((r) => [r.funcname, Number(r.calls)]));
  const n = 'return_receipt272_financial_capture'; assert((now[n] ?? 0) > (before[n] ?? 0), n + ' called by the route');
});
