/** Source-authored only. Root runs this suite in an exclusively owned numeric DB. */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { shipDemo } from '../server/domain';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture } from './stocktake-adjustments-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
type Facts = Record<string, { row: Row }[]>;
type Fixture = Awaited<ReturnType<typeof stocktakeAdjustmentFixture>>;
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
const prefix = '/warehouse-automatic-wz';
const rows = (facts: Facts, table: string) => { assert(facts[table], table); return facts[table].map(r => r.row); };

before(async () => {
  await migrate(); await seed();
  if (!(await pool.query("SELECT to_regprocedure('public.warehouse_wz_issuer_installed()') marker")).rows[0].marker) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query(await readFile(new URL('../server/151_warehouse_wz_issuer.sql', import.meta.url), 'utf8'));
      await c.query("INSERT INTO migrations(name) VALUES('151_warehouse_wz_issuer')"); await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw Error('No provider in issuer safety gates'); } });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });

// All public tables, including sessions and private151 rows; no newest-row or
// tenant-prefix exception hides a failed dispatch effect.
async function capture(): Promise<Facts> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const result: Facts = {};
    for (const { tablename } of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
      assert.match(tablename, /^[a-z][a-z0-9_]*$/);
      result[tablename] = (await c.query(`SELECT to_jsonb(r) row FROM public."${tablename}" r ORDER BY 1`)).rows;
    }
    await c.query('COMMIT'); return result;
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

// Observe private authority only on the trusted same transaction. This helper
// cannot grant raw dyna_app SELECT/EXECUTE and never opens a second connection.
async function owner<T>(c: PoolClient, tenant: string, work: () => Promise<T>): Promise<T> {
  const identity = (await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
  assert.equal(identity.owner, 'postgres'); assert.equal(identity.tenant, tenant);
  assert(['postgres', 'dyna_app'].includes(identity.role));
  const restore = identity.role === 'dyna_app'; let failed = false;
  try { if (restore) await c.query('RESET ROLE'); return await work(); }
  catch (e) { failed = true; throw e; }
  finally { if (restore) { try { await c.query('SET LOCAL ROLE dyna_app'); } catch (e) { if (!failed) throw e; } } }
}

async function preview(f: Fixture, enabled: boolean, tag = 'S168') {
  const options = await f.ok(prefix + '/options');
  const configuration = options.warehouses.find((w: Row) => w.id === f.warehouse.id)?.configuration; assert(configuration);
  const body = { client_key: randomUUID(), expected_version: configuration.version,
    settings: { enabled, moment: 'physical_dispatch', series_name: 'Own safety168 ' + tag, prefix: tag } };
  const p = (await f.ok(prefix + '/warehouses/' + f.warehouse.id + '/previews', 'POST', body, 201)).preview;
  return { p, body, consent: { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true } };
}
async function configure(f: Fixture, enabled: boolean) {
  const { p, consent } = await preview(f, enabled);
  return (await f.ok(prefix + '/previews/' + p.id + '/commit', 'POST', consent, 201)).operation;
}
async function packed(on: boolean, enabled = true) {
  const f = await stocktakeAdjustmentFixture(app, on), configuration = await configure(f, enabled);
  const order = await f.ok('/orders', 'POST', { source: 'manual', customer_name: 'Own physical issuer safety168', email: 'safety168@example.test',
    address: { street: 'Own168', city: 'Warszawa', postal_code: '00-168', country: 'PL', phone: '500000168' },
    warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: f.products.map(p => ({ product_id: p.id, quantity: 3 })) }, 201);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt',
    amount: order.total, currency: 'PLN', method: 'other', reference: 'Own declared payment safety168', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  const allocations: Row[] = on ? (await f.ok('/wms-lots/orders/' + order.id + '/allocations')).data :
    (await pool.query('SELECT * FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,location', [f.tenant, order.id])).rows;
  assert.equal(allocations.length, 6);
  if (on) assert.equal((await f.ok('/wms-lots/orders/' + order.id + '/allocations')).meta.cursor, null);
  for (const allocation of allocations) {
    const p = f.products.find(p => p.id === allocation.product_id); assert(p);
    for (let n = 0; n < allocation.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
      client_key: randomUUID(), code: p.sku, location: allocation.location, ...(on ? { layer_id: allocation.layer_id } : {}) });
  }
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  return { ...f, order, configuration };
}

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} genuine packed orphan fails named completeness and independently COMMIT shipment FK; both roll back admission and counter birth`, async () => {
  const f = await packed(on), before = await capture(), c = await pool.connect();
  try {
    for (const boundary of ['complete', 'commit'] as const) {
      try {
        await c.query('BEGIN'); await c.query("SET LOCAL TimeZone='UTC'"); await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
        const id = (await c.query('SELECT public.warehouse_wz_issuer_prepare($1,NULL,$2::jsonb) id',
          [f.user, JSON.stringify({ kind: 'demo', order_id: f.order.id, shipment_id: randomUUID() })])).rows[0].id;
        assert(id);
        const admission = (await c.query('SELECT * FROM public.warehouse_wz_issuer_admissions WHERE tenant_id=$1 AND id=$2', [f.tenant, id])).rows[0];
        assert.equal(admission.sealed, false); assert.equal(admission.after_snapshot, null); assert.equal(admission.physical, null);
        const counters = (await c.query('SELECT sequence FROM public.warehouse_wz_issuer_counters WHERE tenant_id=$1', [f.tenant])).rows;
        assert.equal(counters.length, 1); assert.equal(BigInt(String(counters[0].sequence)), 0n);
        assert.equal((await c.query('SELECT count(*)::int n FROM public.warehouse_wz_issuer_documents WHERE tenant_id=$1', [f.tenant])).rows[0].n, 0);
        if (boundary === 'complete') await assert.rejects(c.query('SET CONSTRAINTS warehouse_wz_issuer_complete IMMEDIATE'),
          (e: any) => e.code === '23514' && e.message === 'Niepełny automatyczny WZ');
        else await assert.rejects(c.query('COMMIT'),
          (e: any) => e.code === '23503' && e.constraint === 'warehouse_wz_issuer_admissions_tenant_id_shipment_id_fkey');
      } finally { await c.query('ROLLBACK').catch(() => {}); }
      assert.deepEqual(await capture(), before, 'Each independent refusal removes all tentative authority/counters and retains every historical row');
    }
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  assert.deepEqual(await capture(), before);
});

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} post-issuer source mutation before flush is caught by the actual deferred full-source validator`, async () => {
  const f = await packed(on), before = await capture(); let observed = false;
  await assert.rejects(() => tenantTx(f.tenant, async c => shipDemo(c, f.actor, f.order.id, async () => {
    await owner(c, f.tenant, async () => {
      const admission = (await c.query('SELECT sealed,after_snapshot FROM public.warehouse_wz_issuer_admissions WHERE tenant_id=$1', [f.tenant])).rows;
      assert.equal(admission.length, 1); assert.equal(admission[0].sealed, false); assert(admission[0].after_snapshot);
      assert.equal((await c.query('SELECT count(*)::int n FROM public.warehouse_wz_issuer_documents WHERE tenant_id=$1', [f.tenant])).rows[0].n, 1);
      const changed = await c.query("UPDATE public.orders SET updated_at=updated_at+interval '1 microsecond' WHERE tenant_id=$1 AND id=$2", [f.tenant, f.order.id]);
      assert.equal(changed.rowCount, 1); observed = true;
      await c.query('SET CONSTRAINTS warehouse_wz_issuer_complete IMMEDIATE');
    });
  })), (e: any) => e.code === '23514' && e.message === 'Źródło zmieniło się po wystawieniu WZ');
  assert.equal(observed, true); assert.deepEqual(await capture(), before);
});

for (const on of [false, true]) for (const target of ['source', 'row'] as const) test(`${on ? 'ON' : 'OFF'} ALL IMMEDIATE seals actual ${target} against subsequent mutation in the dispatch transaction`, async () => {
  const f = await packed(on), before = await capture(); let sealed = false;
  await assert.rejects(() => tenantTx(f.tenant, async c => shipDemo(c, f.actor, f.order.id, async () => {
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await owner(c, f.tenant, async () => {
      const a = (await c.query('SELECT sealed FROM public.warehouse_wz_issuer_admissions WHERE tenant_id=$1', [f.tenant])).rows;
      assert.equal(a.length, 1); assert.equal(a[0].sealed, true); sealed = true;
      if (target === 'source') await c.query("UPDATE public.orders SET updated_at=updated_at+interval '1 microsecond' WHERE tenant_id=$1 AND id=$2", [f.tenant, f.order.id]);
      else await c.query('UPDATE public.warehouse_wz_issuer_rows SET payload=payload WHERE tenant_id=$1', [f.tenant]);
    });
  })), (e: any) => e.code === '23514' && e.message === (target === 'source' ? 'Źródło automatycznego WZ jest zapieczętowane' : 'Dokument i dowód WZ są niezmienne'));
  assert.equal(sealed, true); assert.deepEqual(await capture(), before);
});

async function moduleMetadata() {
  return {
    functions: (await pool.query("SELECT oid,to_jsonb(p) meta,pg_get_functiondef(oid) definition FROM pg_proc p WHERE pronamespace='public'::regnamespace AND proname LIKE 'warehouse_wz_issuer_%' ORDER BY oid")).rows,
    triggers: (await pool.query("SELECT t.oid,to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t WHERE tgname LIKE 'warehouse_wz_issuer_%' ORDER BY t.oid")).rows,
  };
}
for (const torn of ['function ACL', 'source trigger', 'ledger'] as const) test(`installed151 torn ${torn} refuses real public dispatch and reads without effects, then exact repair restores availability`, async () => {
  const f = await packed(false), before = await capture(), metadata = await moduleMetadata();
  const ledger = rows(before, 'migrations').filter(r => r.name === '151_warehouse_wz_issuer'); assert.equal(ledger.length, 1);
  const breakSQL = torn === 'ledger' ? "DELETE FROM public.migrations WHERE name='151_warehouse_wz_issuer'" :
    torn === 'function ACL' ? 'GRANT EXECUTE ON FUNCTION public.warehouse_wz_issuer_effects(uuid,jsonb) TO dyna_app' :
    'ALTER TABLE public.orders DISABLE TRIGGER warehouse_wz_issuer_source_seal';
  const repairSQL = torn === 'ledger' ? 'INSERT INTO public.migrations(name,applied_at) VALUES($1,$2::timestamptz)' :
    torn === 'function ACL' ? 'REVOKE EXECUTE ON FUNCTION public.warehouse_wz_issuer_effects(uuid,jsonb) FROM dyna_app' :
    'ALTER TABLE public.orders ENABLE TRIGGER warehouse_wz_issuer_source_seal';
  const during = torn === 'ledger' ? { ...before, migrations: before.migrations.filter(r => r.row.name !== '151_warehouse_wz_issuer') } : before;
  try {
    await pool.query(breakSQL);
    assert.equal((await pool.query('SELECT public.warehouse_wz_issuer_guards() ok')).rows[0].ok, false);
    assert.equal((await f.request('/orders/' + f.order.id + '/ship-demo', 'POST', {})).statusCode, 503);
    for (const path of ['/warehouse-wz-issued/options','/warehouse-wz-issued/documents']) assert.equal((await f.request(path)).statusCode, 503);
    await assert.rejects(buildApp(), (e: any) => e.status === 503);
    assert.deepEqual(await capture(), during, 'Only the deliberately removed ledger row differs; refusals introduce no effects');
  } finally { await pool.query(repairSQL, torn === 'ledger' ? [ledger[0].name, ledger[0].applied_at] : []); }
  assert.deepEqual(await moduleMetadata(), metadata, 'Repair restores real OID/ACL/body/trigger metadata exactly');
  assert.equal((await pool.query('SELECT public.warehouse_wz_issuer_guards() ok')).rows[0].ok, true);
  assert.equal((await f.request('/warehouse-wz-issued/options')).statusCode, 200);
  assert.deepEqual(await capture(), before);
});

async function waiter(blockerPid: number, pending: Promise<unknown>) {
  let finished = false; void pending.then(() => { finished = true; }, () => { finished = true; });
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    assert.equal(finished, false, 'The genuine request must wait at the expected lock boundary');
    const candidates = (await pool.query("SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [blockerPid])).rows;
    if (candidates.length === 1) return candidates[0];
    assert.equal(candidates.length, 0, 'A unique actual request waits on this holder');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('No real blocked request observed');
}

for (const on of [false, true]) for (const enabled of [false, true]) test(`${on ? 'ON' : 'OFF'} dispatch waits for actual configuration commit and uses its current ${enabled ? 'new series metadata/version' : 'disabled state'}`, async () => {
  const f = await packed(on), draft = await preview(f, enabled, 'NEXT168'), held = await pool.connect();
  let commit: ReturnType<typeof f.request> | undefined, dispatch: ReturnType<typeof f.request> | undefined;
  try {
    await held.query('BEGIN');
    await held.query("SELECT pg_advisory_xact_lock(hashtextextended('automatic-wz:'||$1::text,0))", [f.tenant]);
    const holderPid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    commit = f.request(prefix + '/previews/' + draft.p.id + '/commit', 'POST', draft.consent);
    const configurationWait = await waiter(holderPid, commit);
    dispatch = f.request('/orders/' + f.order.id + '/ship-demo', 'POST', {});
    await waiter(configurationWait.pid, dispatch);
    await held.query('COMMIT');
    const changed = await commit; assert.equal(changed.statusCode, 201);
    const actual = changed.json().operation; assert.equal(actual.after.version, '2'); assert.equal(actual.after.settings.enabled, enabled);
    const shipped = await dispatch; assert.equal(shipped.statusCode, 200);
    const facts = await capture(), ownDocs = rows(facts, 'warehouse_wz_issuer_documents').filter(d => d.tenant_id === f.tenant);
    assert.equal(ownDocs.length, enabled ? 1 : 0);
    if (enabled) {
      assert.equal(ownDocs[0].revision_id, actual.revision_id); assert.equal(ownDocs[0].series_id, actual.after.series_id);
      assert(ownDocs[0].number.startsWith('NEXT168/'));
      const a = rows(facts, 'warehouse_wz_issuer_admissions').filter(a => a.tenant_id === f.tenant); assert.equal(a.length, 1);
      assert.equal(a[0].frame.configurations[0].configuration.version, 2);
      assert.equal(a[0].frame.configurations[0].configuration.revision_id, actual.revision_id); assert.equal(a[0].sealed, true);
    } else for (const table of ['admissions','receipts','rows','counters']) assert.equal(rows(facts, 'warehouse_wz_issuer_' + table).filter(r => r.tenant_id === f.tenant).length, 0);
    assert.equal(rows(facts, 'stock_movements').filter(r => r.tenant_id === f.tenant && r.order_id === f.order.id && r.kind === 'shipment').length, 3);
  } finally {
    await held.query('ROLLBACK').catch(() => {}); held.release();
    if (commit) await commit.catch(() => {}); if (dispatch) await dispatch.catch(() => {});
  }
});

test('a different firm enabled configuration cannot issue for an own disabled warehouse or accept foreign configuration targets', async () => {
  const own = await packed(false, false), foreign = await stocktakeAdjustmentFixture(app); await configure(foreign, true);
  const before = await capture();
  assert.equal((await own.request(prefix + '/warehouses/' + foreign.warehouse.id + '/previews', 'POST', {
    client_key: randomUUID(), expected_version: '1', settings: { enabled: true, moment: 'physical_dispatch', series_name: 'Foreign denied168', prefix: 'FOREIGN168' },
  })).statusCode, 404);
  assert.deepEqual(await capture(), before);
  await own.ok('/orders/' + own.order.id + '/ship-demo', 'POST', {});
  const after = await capture();
  for (const table of ['admissions','receipts','documents','rows','counters']) assert.deepEqual(after['warehouse_wz_issuer_' + table], before['warehouse_wz_issuer_' + table]);
  for (const table of Object.keys(before)) assert.deepEqual(rows(after, table).filter(r => r.tenant_id === foreign.tenant), rows(before, table).filter(r => r.tenant_id === foreign.tenant));
  assert.equal(rows(after, 'stock_movements').filter(r => r.tenant_id === own.tenant && r.order_id === own.order.id && r.kind === 'shipment').length, 3);
});
