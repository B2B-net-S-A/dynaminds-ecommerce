/** Root-only QA151 checks AFTER both plans, BEFORE any parcel dispatch.
 * No execution is implied by authoring this file. HTTP writes are exact replay
 * or explicit denials. SQL attacks and real physical work must roll back.
 * An existing journal is never resumed; unknown results need manual inspection.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../server/domain';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const fixturePath = resolve(root, 'data/order-parcels-stage151.json');
const journalPath = resolve(root, 'data/order-parcels-stage151-guards.json');
const reportPath = resolve(root, 'docs/order-parcels-native151-guards.json');
const schema = '135_order_parcel_completion_fix';
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const digest = (v: unknown) => sha(JSON.stringify(v));
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Snapshot = Record<string, { count: number; sha256: string }>;
type PairSnapshot = Record<'off' | 'on', Snapshot>;
type FixtureActor = {
  label: string; on: boolean; tenant_id: string; user_id: string; cookie: string;
  order_id: string; warehouse_id: string; complete: boolean;
  components: Array<{ id: string; recipe_quantity: number; initial_quantity: number }>;
};
type Plan = {
  id: string; preview_id: string; order_id: string; actor_id: string;
  api_key_id: null; scope_hash: string; request: Record<string, unknown>;
  payload: { parcels: any[]; source: { order: { id: string }; wms_enabled: boolean } };
};
let database: Pool | undefined;
let step = 'preflight';
let journal: any;
let tenantTx: typeof import('../server/db').tenantTx;
let consume: typeof import('../server/order-parcel-stock').consumeOrderParcelInTx;

async function regular(path: string, privateFile = false) {
  const f = await lstat(path);
  assert(f.isFile() && !f.isSymbolicLink(), 'Regular controlled file');
  if (privateFile) assert.equal(f.mode & 0o777, 0o600, 'Private mode');
  return readFile(path);
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('Exclusive QA output already exists; do not resume');
}
async function exclusive(path: string, value: unknown, mode: number) {
  const f = await open(path, 'wx', mode);
  try { await f.writeFile(encode(value)); await f.sync(); } finally { await f.close(); }
}
async function save() {
  await regular(journalPath, true);
  const tmp = journalPath + '.' + randomUUID() + '.tmp';
  try {
    await exclusive(tmp, journal, 0o600); await rename(tmp, journalPath);
    const d = await open(dirname(journalPath), 'r');
    try { await d.sync(); } finally { await d.close(); }
  } finally { await unlink(tmp).catch(() => {}); }
}
async function json(r: Response) {
  const b = Buffer.from(await r.arrayBuffer());
  assert(b.length <= 8 * 1024 * 1024, 'Bounded HTTP response');
  return JSON.parse(b.toString('utf8'));
}
async function health() {
  const r = await fetch(base + '/health', { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 200);
  const h = await json(r);
  assert.equal(h.status, 'ok'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema); assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.order_parcels_available, true);
}
function headers(a: FixtureActor) {
  return { cookie: a.cookie, 'X-Workspace-ID': a.tenant_id, 'Content-Type': 'application/json' };
}
async function get(a: FixtureActor, path: string) {
  assert(path.startsWith('/') && !path.includes('://'));
  const r = await fetch(base + path, { headers: headers(a), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 200, 'Fresh authenticated own GET'); return json(r);
}
async function snapshot(actors: Record<'off' | 'on', FixtureActor>): Promise<PairSnapshot> {
  const c = await database!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const native = (await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0];
    assert.deepEqual(native, { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
    const names: string[] = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY table_name")).rows.map(r => r.table_name);
    const result: PairSnapshot = { off: {}, on: {} };
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const column = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      for (const key of ['off', 'on'] as const) {
        const a = actors[key];
        const rows = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE ${column}=$1 ORDER BY 1`, [name === 'users' ? a.user_id : a.tenant_id])).rows;
        result[key][name] = { count: rows.length, sha256: digest(rows) };
      }
    }
    await c.query('COMMIT'); return result;
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
function principal(a: FixtureActor): Actor {
  return { tenantId: a.tenant_id, userId: a.user_id, role: 'admin', source: 'manual' };
}

async function main() {
  assert.equal(resolve(process.cwd()), root);
  assert.equal(resolve(dirname(fileURLToPath(import.meta.url)), '..'), root);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json'));
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.QA151_GUARDS_CONFIRM, 'CHECK_TWO_OWN_PLANS_BEFORE_FIRST_DISPATCH');
  assert.match(revision, /^[a-f0-9]{40}$/);
  await regular(resolve(root, '.local.json'), true);
  for (const path of [resolve(root, 'data'), resolve(root, 'docs')]) {
    const d = await lstat(path); assert(d.isDirectory() && !d.isSymbolicLink());
  }
  await absent(journalPath); await absent(reportPath);
  const fixtureBytes = await regular(fixturePath, true);
  const s = JSON.parse(fixtureBytes.toString('utf8'));
  assert.equal(s.stage, 151); assert.equal(s.complete, true); assert.equal(s.pending, null);
  assert.equal(s.schema_revision, '134_order_parcels');
  const actors: Record<'off' | 'on', FixtureActor> = { off: s.off, on: s.on };
  for (const key of ['off', 'on'] as const) {
    const a = actors[key]; assert.equal(a.complete, true); assert.equal(a.on, key === 'on');
    for (const id of [a.tenant_id, a.user_id, a.order_id, a.warehouse_id]) assert.match(id, uuid);
    assert(a.cookie.startsWith('dyna_session=') && !/[\r\n]/.test(a.cookie));
    assert.equal(a.components.length, a.on ? 2 : 1);
  }
  assert.notEqual(actors.off.tenant_id, actors.on.tenant_id);
  await health();
  const dbModule = await import('../server/db');
  database = dbModule.pool; tenantTx = dbModule.tenantTx;
  consume = (await import('../server/order-parcel-stock')).consumeOrderParcelInTx;
  const url = new URL(database.options.connectionString!);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55432'); assert.equal(url.pathname, '/dynaminds');
  const baseline = await snapshot(actors);
  const plans = {} as Record<'off' | 'on', Plan>;
  const publicPlans: Record<string, unknown> = {};
  const c = await database.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    for (const key of ['off', 'on'] as const) {
      const a = actors[key];
      const rows = (await c.query('SELECT * FROM order_parcel_plans WHERE tenant_id=$1 AND order_id=$2', [a.tenant_id, a.order_id])).rows;
      assert.equal(rows.length, 1, 'Exactly one own approved plan');
      const p = rows[0] as Plan; plans[key] = p;
      assert.equal(p.actor_id, a.user_id); assert.equal(p.api_key_id, null);
      assert.equal(p.payload.source.order.id, a.order_id); assert.equal(p.payload.source.wms_enabled, a.on);
      assert.deepEqual(Object.keys(p.request).sort(), ['client_key', 'confirmed', 'scope_hash']);
      assert.match(p.request.client_key as string, uuid); assert.equal(p.request.confirmed, true); assert.equal(p.request.scope_hash, p.scope_hash);
      assert.deepEqual(p.payload.parcels.map(r => r.index), [0, 1]);
      assert.equal(new Set(p.payload.parcels.map(r => r.shipment_id)).size, 2);
      assert.equal(baseline[key].order_parcel_plans.count, 1); assert.equal(baseline[key].order_parcel_allocations.count, 2);
      assert.equal(baseline[key].order_parcel_dispatches.count, 0);
      const shipments = (await c.query('SELECT id,dispatched_at,mode,channel_id FROM shipments WHERE tenant_id=$1 AND order_id=$2 ORDER BY id', [a.tenant_id, a.order_id])).rows;
      assert.equal(shipments.length, 2); assert(shipments.every(r => !r.dispatched_at && r.mode === 'demo' && r.channel_id === null));
      assert.deepEqual(shipments.map(r => r.id).sort(), p.payload.parcels.map(r => r.shipment_id).sort());
      const reservations = (await c.query('SELECT product_id,quantity,consumed_quantity,state FROM reservations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id', [a.tenant_id, a.order_id])).rows;
      assert.equal(reservations.length, a.components.length);
      for (const r of reservations) {
        const product = a.components.find(v => v.id === r.product_id); assert(product);
        assert.equal(r.quantity, 3 * product.recipe_quantity); assert.equal(r.consumed_quantity, 0); assert.equal(r.state, 'active');
      }
      assert.equal((await c.query('SELECT status FROM orders WHERE tenant_id=$1 AND id=$2', [a.tenant_id, a.order_id])).rows[0].status, 'packed');
    }
    await c.query('COMMIT');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  for (const key of ['off', 'on'] as const) {
    const a = actors[key];
    const me = await get(a, '/auth/me'); assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.role, 'admin');
    const view = await get(a, '/order-parcels/plans/' + plans[key].id);
    assert.equal(view.available, true); assert.equal(view.read_only, false); assert.equal(view.can_write, true);
    assert.equal(view.plan.id, plans[key].id); assert.equal(view.plan.complete, false);
    assert.deepEqual(view.plan.progress.map((r: any) => r.state), ['pending', 'pending']);
    publicPlans[key] = view.plan;
  }
  assert.deepEqual(await snapshot(actors), baseline, 'Preflight GETs preserve all business tables');
  journal = { stage: 151, revision, schema_revision: schema, fixture_sha256: sha(fixtureBytes), before: baseline, plans, pending: null, completed: [], complete: false };
  await exclusive(journalPath, journal, 0o600);

  async function check(label: string, a: FixtureActor, request: unknown, action: () => Promise<Record<string, unknown>>) {
    step = a.label + ':' + label; await health();
    assert.equal(sha(await regular(fixturePath, true)), sha(fixtureBytes), 'Original fixture bytes unchanged');
    const me = await get(a, '/auth/me'); assert.equal(me.user.id, a.user_id); assert.equal(me.user.role, 'admin');
    const before = await snapshot(actors); assert.deepEqual(before, baseline, 'Prior business effects absent');
    journal.pending = { step, tenant_id: a.tenant_id, request, before_sha256: digest(before), received: null };
    await save();
    const result = await action();
    journal.pending.received = result; await save();
    const after = await snapshot(actors); assert.deepEqual(after, before, 'Complete own pair rollback including audit');
    assert.equal(sha(await regular(fixturePath, true)), sha(fixtureBytes));
    journal.completed.push({ step, ...result, before_sha256: digest(before), after_sha256: digest(after), all_business_rows_exact: true });
    journal.pending = null; await save();
  }
  async function http(a: FixtureActor, method: string, path: string, body: unknown, expected: number, message?: string, replay?: unknown) {
    const r = await fetch(base + path, { method, headers: headers(a), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
    const data = await json(r);
    // Retain even an unexpected response before assertions or a process exit.
    journal.pending.received = { status: r.status, response_sha256: digest(data) }; await save();
    assert.equal(r.status, expected, 'Exact HTTP result');
    if (message) assert.equal(data.detail, message, 'Exact intended denial');
    if (expected === 422) assert(typeof data.detail === 'string' && data.detail.includes('confirmed:'), 'Consent schema reached');
    if (replay) { assert.equal(data.reused, true); assert.deepEqual(data.plan, replay, 'Original plan with unchanged current progress'); }
    return { status: expected, response_sha256: digest(data) };
  }
  async function rejected(fn: () => Promise<unknown>, expected: { code?: string; status?: number; message: string }) {
    let caught: any;
    try { await fn(); } catch (e) { caught = e; }
    journal.pending.received = caught ? {
      sql_or_finalizer_rejected: true,
      observed_code: typeof caught.code === 'string' ? caught.code : null,
      observed_status: typeof caught.status === 'number' ? caught.status : null,
      message_sha256: sha(String(caught.message ?? '')),
    } : { unexpected_transaction_commit: true };
    await save();
    assert(caught, 'The operation must reject and roll back');
    if (expected.code) assert.equal(caught.code, expected.code, 'Exact SQL code');
    if (expected.status) assert.equal(caught.status, expected.status, 'Exact final IAM status');
    assert.equal(caught.message, expected.message, 'Intended guard reached');
    return { code: expected.code ?? null, status: expected.status ?? null };
  }
  async function prepared(c: PoolClient, a: FixtureActor, p: Plan, request: any, operationId: string) {
    const context = (await c.query("SELECT current_user role,current_setting('app.tenant_id') tenant_id")).rows[0];
    assert.deepEqual(context, { role: 'dyna_app', tenant_id: a.tenant_id });
    const id = (await c.query('SELECT order_parcel_prepare_dispatch($1,$2,$3,$4,$5,$6) id', [p.id, 0, operationId, request, a.user_id, null])).rows[0].id;
    assert.equal(id, operationId, 'New genuine admission, not a replay');
    const scope = (await c.query('SELECT order_parcel_dispatch_scope($1,$2,$3,$4,$5) r', [p.id, 0, id, a.user_id, null])).rows[0].r;
    assert.equal(scope.order_id, a.order_id); assert.equal(scope.receipt_id, id);
    assert.deepEqual(scope.parcel, p.payload.parcels[0]);
    const before = (await c.query('SELECT product_id,on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY product_id', [a.tenant_id, a.warehouse_id])).rows;
    const receipt = await consume(c, principal(a), { operation_id: id, plan_id: p.id, parcel_index: 0, shipment_id: scope.parcel.shipment_id, order_id: a.order_id, allocations: scope.parcel.products });
    assert.equal(receipt.operation_id, id); assert.equal(receipt.stock_movements.length, a.components.length);
    assert.equal(receipt.location_movements.length, a.components.length);
    if (a.on) { assert(receipt.wms); assert.equal(receipt.wms.operation_id, id); assert.equal(receipt.wms.fragment_ids.length, 2); }
    else assert.equal(receipt.wms, null);
    const after = (await c.query('SELECT product_id,on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 ORDER BY product_id', [a.tenant_id, a.warehouse_id])).rows;
    assert.equal(after.length, before.length);
    for (let n = 0; n < before.length; n++) {
      const q = scope.parcel.products.find((r: any) => r.product_id === before[n].product_id)?.quantity ?? 0;
      assert.deepEqual(after[n], { ...before[n], on_hand: before[n].on_hand - q, reserved: before[n].reserved - q });
    }
    const consumed = (await c.query('SELECT product_id,quantity,consumed_quantity,state FROM reservations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id', [a.tenant_id, a.order_id])).rows;
    for (const r of consumed) {
      const q = scope.parcel.products.find((p: any) => p.product_id === r.product_id)?.quantity ?? 0;
      const original = a.components.find(v => v.id === r.product_id)!;
      assert.equal(r.quantity, original.recipe_quantity * 3); assert.equal(r.consumed_quantity, q); assert.equal(r.state, 'active');
    }
    return receipt;
  }
  const deny = 'Zamówienie ma zatwierdzony podział na paczki. Wydawaj towar przez plan paczek';
  for (const key of ['off', 'on'] as const) {
    const a = actors[key], p = plans[key];
    for (const spec of [
      { label: 'legacy-cancel', method: 'PATCH', path: '/orders/' + a.order_id + '/status', body: { status: 'cancelled' }, status: 409, message: deny },
      { label: 'legacy-whole-order-ship', method: 'POST', path: '/orders/' + a.order_id + '/ship-demo', body: {}, status: 409, message: deny },
      { label: 'committed-plan-exact-replay', method: 'POST', path: '/order-parcels/previews/' + p.preview_id + '/apply', body: p.request, status: 200, replay: publicPlans[key] },
      { label: 'same-key-altered-hash', method: 'POST', path: '/order-parcels/previews/' + p.preview_id + '/apply', body: { ...p.request, scope_hash: (p.scope_hash[0] === '0' ? '1' : '0') + p.scope_hash.slice(1) }, status: 409, message: 'Klucz planu ma inny zakres' },
      { label: 'false-consent', method: 'POST', path: '/order-parcels/previews/' + p.preview_id + '/apply', body: { ...p.request, confirmed: false }, status: 422 },
    ]) await check(spec.label, a, { method: spec.method, path: spec.path, body: spec.body }, () => http(a, spec.method, spec.path, spec.body, spec.status, spec.message, spec.replay));

    const product = a.components[0];
    await check('raw-app-counter-without-admission', a, { operation: 'UPDATE own reservation consumed_quantity + 1', order_id: a.order_id, product_id: product.id }, async () => {
      let reached = false;
      const result = await rejected(() => tenantTx(a.tenant_id, async c => {
        assert.equal((await c.query('SELECT current_user role')).rows[0].role, 'dyna_app'); reached = true;
        await c.query('UPDATE reservations SET consumed_quantity=consumed_quantity+1 WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3', [a.tenant_id, a.order_id, product.id]);
      }), { code: '23514', message: 'Zmiana rezerwacji wymaga bieżącej zgody paczki' });
      assert(reached); return { ...result, reached_raw_app_update: true };
    });
    for (const extra of [false, true]) {
      const request = { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true }, operationId = randomUUID();
      const abort = Object.assign(new Error('QA151 deliberate abort after real consume before finish'), { code: 'QA151_ABORT' });
      await check(extra ? 'extra-shipment-journal-bijection' : 'genuine-consume-abort-before-finish', a, { plan_id: p.id, index: 0, operation_id: operationId, body: request, extra_journal: extra }, async () => {
        let consumed = false, reachedFinish = false;
        const result = await rejected(() => tenantTx(a.tenant_id, async c => {
          const receipt = await prepared(c, a, p, request, operationId); consumed = true;
          if (!extra) throw abort;
          await c.query("INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,order_id,delta,kind,note) VALUES($1,$2,$3,$4,$5,-1,'shipment','QA151 deliberate unclaimed extra journal, no stock update')", [randomUUID(), a.tenant_id, product.id, a.warehouse_id, a.order_id]);
          reachedFinish = true;
          await c.query('SELECT order_parcel_finish_dispatch($1,$2,$3,$4)', [operationId, receipt, a.user_id, null]);
        }), extra ? { code: '23514', message: 'Wydanie wymaga dokładnej bijekcji świeżych rzeczywistych ruchów' } : { code: 'QA151_ABORT', message: abort.message });
        assert(consumed); assert.equal(reachedFinish, extra);
        return { ...result, genuine_physical_consume_reached: true, finish_reached: reachedFinish };
      });
    }
  }
  // Actual tenantTx's WMS finalizer is active for ON. OFF intentionally skips
  // that finalizer; this check makes no OFF or externally-concurrent IAM claim.
  const a = actors.on, p = plans.on;
  const request = { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true }, operationId = randomUUID();
  await check('late-own-role-withdrawal-after-full-flush', a, { plan_id: p.id, index: 0, operation_id: operationId, body: request, own_role_transition: 'admin->viewer inside rolled-back transaction' }, async () => {
    let fullFlush = false, callbackReturned = false;
    const result = await rejected(() => tenantTx(a.tenant_id, async c => {
      const receipt = await prepared(c, a, p, request, operationId);
      await c.query('SELECT order_parcel_finish_dispatch($1,$2,$3,$4)', [operationId, receipt, a.user_id, null]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE'); fullFlush = true;
      await c.query('SET LOCAL ROLE postgres');
      const changed = await c.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2 AND role='admin'", [a.tenant_id, a.user_id]);
      assert.equal(changed.rowCount, 1, 'Only the own QA membership changed in the aborted TX');
      await c.query('SET LOCAL ROLE dyna_app');
      assert.equal((await c.query('SELECT current_user role')).rows[0].role, 'dyna_app');
      callbackReturned = true;
      // No explicit throw: genuine tenantTx finalization must reject the viewer.
    }), { status: 403, message: 'Bieżąca rola nie pozwala zapisać operacji WMS' });
    assert(fullFlush && callbackReturned, 'Real full graph precedes finalizer IAM refusal');
    return { ...result, complete_graph_flushed: true, tenant_tx_finalizer_reached: true, wms_enabled: true, concurrent_actor_revocation_proven: false };
  });
  step = 'final-readback'; await health();
  const after = await snapshot(actors); assert.deepEqual(after, baseline);
  assert.equal(journal.completed.length, 17); assert.equal(journal.pending, null);
  assert.equal(sha(await regular(fixturePath, true)), sha(fixtureBytes));
  journal.after = after; journal.complete = true; journal.status = 'OWN_OFF_ON_GUARDS_PASS'; await save();
  await exclusive(reportPath, {
    stage: 151, status: 'OWN_OFF_ON_GUARDS_PASS', revision, schema_revision: schema,
    checks: journal.completed, firms: (['off', 'on'] as const).map(key => ({ wms_enabled: actors[key].on, own_tables: Object.keys(baseline[key]).length, before_sha256: digest(baseline[key]), after_sha256: digest(after[key]), committed_dispatches: 0 })),
    sessions_excluded: true, original_setup_bytes_exact: true, all_owned_business_rows_exact: true,
    journal_sha256: sha(await regular(journalPath, true)), committed_stock_issues: 0,
    membership_changes_committed: 0, late_finalizer_role_test_wms_on_only: true,
    external_concurrent_iam_proven: false, api_key_revocation_proven: false,
    partial_cancel_replan_proven: false, provider_verified: false, full_goal_complete: false,
  }, 0o644);
  console.log(JSON.stringify({ status: 'OWN_OFF_ON_GUARDS_PASS', checks: 17, committed_dispatches: 0 }));
}
main().catch((e: unknown) => {
  const error = e as { code?: unknown; stack?: unknown };
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'PRIVATE_DETAILS_WITHHELD';
  const sourceFrames = typeof error.stack === 'string' ? [...error.stack.matchAll(/order-parcels-native-guards151\.ts:(\d+):\d+/g)].map(m => Number(m[1])) : [];
  console.error(JSON.stringify({ status: 'QA151_GUARDS_FAILED', step, code, source_frames: [...new Set(sourceFrames)], pending_must_be_inspected: Boolean(journal?.pending) }));
  process.exitCode = 1;
}).finally(() => database?.end());
