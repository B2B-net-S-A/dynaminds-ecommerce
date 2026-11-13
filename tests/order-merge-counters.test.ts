import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

assert.equal(process.env.DYNA_TEST, 'true');
const originalDatabaseUrl = process.env.DATABASE_URL;
const url = new URL(originalDatabaseUrl ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.match(url.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
const scratchName = url.pathname.slice(1) + '_merge145_' + randomUUID().replaceAll('-', '').slice(0, 12);
assert.match(scratchName, /^dynaminds_test_\d+_merge145_[a-f0-9]{12}$/);
const scratchUrl = new URL(url); scratchUrl.pathname = '/' + scratchName;
const admin = new pg.Client({ connectionString: url.href });
let scratchCreated = false, adminConnected = false;
let app: Awaited<ReturnType<typeof import('../server/app').buildApp>>;
let pool: pg.Pool;
let tenant = '', warehouse = '', user = '', cookie = '', transportCalls = 0;
async function ok(path: string, method: any = 'GET', body?: Row, status = 200) {
  const r = await app.inject({ method, url: '/api' + path, payload: body,
    headers: { cookie }, remoteAddress: '127.121.145.1' });
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 1200)}`);
  return r.json() as Row;
}
async function rows(table: string, own = true) {
  assert.match(table, /^[a-z][a-z0-9_]*$/);
  return (await pool.query(`SELECT to_jsonb(q) row FROM "${table}" q ${own ? 'WHERE tenant_id=$1' : ''} ORDER BY 1`, own ? [tenant] : [])).rows.map(r => r.row);
}
const custodyTables = ['reservations', 'reservation_locations', 'wms_reservation_layers'];
const physicalTables = ['stock', 'stock_locations', 'stock_movements', 'stock_location_movements',
  'wms_lots', 'wms_cost_layers', 'wms_layer_positions', 'wms_layer_movements',
  'wms_operations', 'wms_issue_fragments', 'wms_return_fragments'];
async function snapshot(tables: string[]) {
  const data: Row = {};
  for (const table of tables) data[table] = await rows(table);
  return data;
}
async function allRows() {
  const names = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN('sessions','migrations') ORDER BY 1")).rows.map(r => r.tablename as string);
  const data: Row = {};
  for (const table of names) data[table] = await rows(table, false);
  return data;
}
before(async () => {
  // Never import runtime modules until their pool selects this owned nested DB.
  // The parent scratch may already contain current-schema fixtures of other files.
  await admin.connect(); adminConnected = true;
  await admin.query(`CREATE DATABASE "${scratchName}"`); scratchCreated = true;
  process.env.DATABASE_URL = scratchUrl.href;
  pool = (await import('../server/db')).pool;
  assert.equal(new URL(pool.options.connectionString!).pathname, '/' + scratchName);
  // Construct historical144 without uninstalling145 or touching the parent ledger.
  assert.equal((await pool.query("SELECT to_regclass('public.migrations') relation")).rows[0].relation, null,
    'Historical preservation requires an empty, exclusively owned disposable database');
  const central = await readFile(new URL('../server/db.ts', import.meta.url), 'utf8');
  const section = central.slice(central.indexOf('for (const [name, file] of ['));
  assert(section.startsWith('for (const [name, file] of ['));
  const manifest = [...section.matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)]
    .map(m => ({ name: m[1], file: m[2] })).filter(m => Number(m.name.slice(0, 3)) <= 144);
  assert.equal(manifest.length, 144); assert.equal(manifest[0].name, '001_foundation');
  assert.equal(manifest.at(-1)?.name, '144_b2b_catalog_scopes');
  const c = await pool.connect();
  try {
    for (const migration of manifest) {
      await c.query('BEGIN');
      try {
        await c.query(await readFile(new URL('../server/' + migration.file, import.meta.url), 'utf8'));
        if (migration.name === '092_wms_stocktakes')
          await c.query(await readFile(new URL('../server/wms-stocktake-invariants.sql', import.meta.url), 'utf8'));
        if (migration.name === '108_b2b_dropshipping')
          await c.query(await readFile(new URL('../server/108_b2b_dropship_dispatch.sql', import.meta.url), 'utf8'));
        await c.query('INSERT INTO migrations(name) VALUES($1)', [migration.name]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally { c.release(); }
  assert.equal((await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name, '144_b2b_catalog_scopes');
  const { seed } = await import('./fixtures');
  const { buildApp } = await import('../server/app');
  await seed();
  app = await buildApp({ integrationTransport: async () => { transportCalls++; throw Error('No provider in merge counter test'); } });
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  transportCalls = 0;
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress: '127.121.145.1' });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  tenant = randomUUID(); warehouse = randomUUID();
  // Explicit disposable owner fixture for membership; commercial operations below use real API.
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own145 counter fixture','enterprise')", [tenant]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, user]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Own145 warehouse','COUNTER145')", [warehouse, tenant]);
  const sw = await app.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: tenant }, headers: { cookie }, remoteAddress: '127.121.145.1' });
  assert.equal(sw.statusCode, 200); cookie = String(sw.headers['set-cookie']).split(';')[0];
});
after(async () => {
  try { await app?.close(); }
  finally {
    try { await pool?.end(); }
    finally {
      try { if (scratchCreated) await admin.query(`DROP DATABASE "${scratchName}" WITH (FORCE)`); }
      finally {
        try { if (adminConnected) await admin.end(); }
        finally {
          if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = originalDatabaseUrl;
        }
      }
    }
  }
});
async function product() {
  return ok('/products', 'POST', { sku: 'COUNTER-' + randomUUID(), name: 'Counter provenance',
    price: 1000, vat: 23, quantity: 10, warehouse_id: warehouse, location: 'A-01' }, 201);
}
async function opening(p: Row) {
  const stock = (await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [tenant, warehouse, p.id])).rows[0];
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'Own145 genuine known-cost opening',
    lines: [{ warehouse_id: warehouse, product_id: p.id, location: 'A-01', quantity: 10,
      stock_version: String(stock.version), lot_code: 'COUNTER145', unit_cost_minor: '101' }],
  }, 201);
  assert.equal(preview.ready, true);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true, ack_unknown_costs: false,
  }, 201);
}
async function order(p: Row, quantity: number) {
  return ok('/orders', 'POST', { customer_name: 'Same own buyer', email: 'counter@example.test',
    warehouse_id: warehouse, payment_mode: 'cod', items: [{ product_id: p.id, quantity }],
    address: { street: 'Testowa 145', city: 'Warszawa', postal_code: '00-001', phone: '500600700' } }, 201);
}
async function scan(o: Row, p: Row) {
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'picking' }));
  const layer = (await rows('wms_reservation_layers')).find(r => r.order_id === o.id);
  await ok('/orders/' + o.id + '/scan', 'POST', { client_key: randomUUID(), code: p.sku,
    location: 'A-01', ...(layer ? { layer_id: layer.layer_id } : {}) });
}
async function preview(a: Row, b: Row, mode: string) {
  const { preview: p } = await ok('/order-merges/previews', 'POST', { client_key: randomUUID(),
    main_order_id: a.id, order_ids_to_merge: [b.id], merge_mode: mode, sum_delivery_costs: true }, 201);
  assert.equal(p.ready, true, JSON.stringify(p.conflicts)); return p;
}
const consent = (p: Row) => ({ client_key: randomUUID(), preview_id: p.id,
  scope_hash: p.scope_hash, confirmed: true, confirmed_receiver_selection: true });

test('additive145 preserves every old full row, custody issuer OID/owner/ACL/dependencies and installed104 seals', async () => {
  const ledger = (await pool.query('SELECT name FROM migrations ORDER BY name')).rows.map(r => r.name);
  assert.equal(ledger.at(-1), '144_b2b_catalog_scopes', 'This preservation gate must start from genuine144, before145 registration');
  assert.equal(ledger.includes('145_order_merge_counters'), false);
  const issuerBefore = (await pool.query("SELECT pg_get_functiondef('order_merge_transfer_custody(uuid)'::regprocedure) definition")).rows[0].definition as string;
  assert.equal(issuerBefore.includes('consumed_quantity'), false, 'The original104 issuer is required, not a reapplication of145');
  assert.equal(issuerBefore.includes('released_quantity'), false);
  const baseline = await allRows();
  const identity = async () => (await pool.query("SELECT oid,proowner,proacl,prosecdef,proconfig FROM pg_proc WHERE oid='order_merge_transfer_custody(uuid)'::regprocedure")).rows;
  const dependencies = async () => (await pool.query("SELECT * FROM pg_depend WHERE (classid='pg_proc'::regclass AND objid='order_merge_transfer_custody(uuid)'::regprocedure) OR(refclassid='pg_proc'::regclass AND refobjid='order_merge_transfer_custody(uuid)'::regprocedure) ORDER BY 1,2,3,4,5,6,7")).rows;
  const triggers = async () => (await pool.query("SELECT t.oid,t.tgrelid,t.tgname,t.tgfoid,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' ORDER BY t.oid")).rows;
  const otherFunctions = async () => (await pool.query("SELECT p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN('f','p') AND p.oid<>'order_merge_transfer_custody(uuid)'::regprocedure ORDER BY p.oid")).rows;
  const oldIdentity = await identity(), oldDependencies = await dependencies(), oldTriggers = await triggers(), oldFunctions = await otherFunctions();
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(await readFile(new URL('../server/145_order_merge_counters.sql', import.meta.url), 'utf8')); await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  assert.deepEqual(await allRows(), baseline);
  assert.deepEqual(await identity(), oldIdentity); assert.deepEqual(await dependencies(), oldDependencies);
  assert.deepEqual(await triggers(), oldTriggers);
  assert.deepEqual(await otherFunctions(), oldFunctions, 'Every other public function definition/identity/grant is unchanged');
  const issuerAfter = (await pool.query("SELECT pg_get_functiondef('order_merge_transfer_custody(uuid)'::regprocedure) definition")).rows[0].definition as string;
  assert.notEqual(issuerAfter, issuerBefore); assert(issuerAfter.includes('consumed_quantity') && issuerAfter.includes('released_quantity'));
});

// Merging itself needs the current schema (orderMergesAvailable asks for 209's delivery inheritance), so the
// behaviour tests below run with every later migration installed over the genuine 144+145 rows.
test('every later migration installs over the genuine 145 rows', async () => {
  await app.close();
  await pool.query("INSERT INTO migrations(name) VALUES('145_order_merge_counters')");
  const { migrate } = await import('../server/db');
  await migrate();
  const { buildApp } = await import('../server/app');
  app = await buildApp({ integrationTransport: async () => { transportCalls++; throw Error('No provider in merge counter test'); } });
});

for (const on of [false, true]) for (const mode of ['technical_merge', 'into_main_order']) {
  test(`145 ${on ? 'ON' : 'OFF'} ${mode}: exact counter/full-row proof, shared target aggregation and immutable replay`, async () => {
    const p = await product(); if (on) await opening(p);
    const a = await order(p, 2), b = await order(p, 3);
    await scan(a, p); await scan(b, p);
    const oldCustody = await snapshot(custodyTables), physical = await snapshot(physicalTables);
    const pv = await preview(a, b, mode), body = consent(pv);
    const result = await ok('/order-merges/execute', 'POST', body, 201);
    const target = result.execution.target_order_id;
    assert.deepEqual(await snapshot(physicalTables), physical, 'No release/reFIFO/stock/journal/cost mutation');
    const proof = (await rows('order_merge_custody_transfers')).find(r => r.execution_id === result.execution.id);
    assert(proof);
    for (const [table, key] of [['reservations', 'reservations'], ['reservation_locations', 'locations'], ['wms_reservation_layers', 'layers']]) {
      const sourceIds = [a.id, b.id].filter(id => id !== target);
      const expectedSource = oldCustody[table].filter((r: Row) => sourceIds.includes(r.order_id)).map((r: Row) =>
        table === 'reservation_locations' ? r : { ...r, state: 'transferred' });
      const actual = await rows(table);
      assert.deepEqual(actual.filter(r => sourceIds.includes(r.order_id)), expectedSource, 'Source full original fields retained');
      const targetRows = actual.filter(r => r.order_id === target);
      assert.equal(targetRows.length, table === 'wms_reservation_layers' && !on ? 0 : 1);
      if (targetRows.length) { assert.equal(targetRows[0].quantity, 5); assert.equal(targetRows[0].consumed_quantity, 0); assert.equal(targetRows[0].released_quantity, 0); }
      if (table !== 'reservations' && targetRows.length) assert.equal(targetRows[0].scanned, 2);
      const scope = actual.filter(r => [a.id, b.id, target].includes(r.order_id));
      const sorted = (rs: Row[]) => [...rs].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
      // Object insertion order is not authority: compare sorted keys through SQL's canonical jsonb.
      const canonical = async (rs: Row[]) => (await pool.query('SELECT value FROM jsonb_array_elements($1::jsonb) value ORDER BY value', [JSON.stringify(rs)])).rows.map(r => r.value);
      assert.deepEqual(await canonical(sorted(scope)), await canonical(proof.after_snapshot[key]));
    }
    const oldRows = await allRows();
    const replay = await ok('/order-merges/execute', 'POST', body, 200);
    assert.equal(replay.execution.id, result.execution.id); assert.deepEqual(await allRows(), oldRows);
    // This receipt was born under145: committed-proof replay, not a pre134 historical receipt fixture.
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      await c.query('SET LOCAL ROLE dyna_app'); await c.query('SELECT order_merge_transfer_custody($1)', [result.execution.id]);
      await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    assert.deepEqual(await allRows(), oldRows); assert.equal(transportCalls, 0);
  });
}

test('145 refuses every nonzero C/L table counter before custody writes and preserves exact original rows on rollback', async () => {
  const p = await product(); await opening(p);
  const a = await order(p, 2), b = await order(p, 3), pv = await preview(a, b, 'into_main_order');
  const baseline = await allRows();
  for (const table of custodyTables) for (const counter of ['consumed_quantity', 'released_quantity']) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      // Explicit aborted owner corruption fixture, not a claim of an actual parcel issue/release.
      // It isolates the typed issuer denial rather than an earlier ordinary row-trigger denial.
      await c.query("SET LOCAL session_replication_role='replica'");
      await c.query(`UPDATE "${table}" SET "${counter}"=1 WHERE tenant_id=$1 AND order_id=$2`, [tenant, a.id]);
      const h = (await c.query('SELECT * FROM order_merge_previews WHERE tenant_id=$1 AND id=$2', [tenant, pv.id])).rows[0];
      const custody = (await c.query('SELECT order_merge_custody_snapshot($1::uuid[]) f', [[a.id, b.id]])).rows[0].f;
      const frozen = { ...h.snapshot, custody };
      await c.query('UPDATE order_merge_previews SET snapshot=$3 WHERE tenant_id=$1 AND id=$2', [tenant, pv.id, frozen]);
      const execution = { ...h, id: randomUUID(), preview_id: pv.id, client_key: randomUUID(),
        request: consent(pv), state: 'done', before_snapshot: frozen, after_snapshot: {} };
      await c.query('INSERT INTO order_merge_executions SELECT * FROM jsonb_populate_record(NULL::order_merge_executions,$1::jsonb)', [JSON.stringify(execution)]);
      await c.query("SET LOCAL session_replication_role='origin'");
      await c.query('SET LOCAL ROLE dyna_app');
      await assert.rejects(() => c.query('SELECT order_merge_transfer_custody($1)', [execution.id]),
        (e: any) => e.code === '23514' && e.message === 'Scalanie wymaga pierwotnych rezerwacji bez wydania, zwolnienia i planu paczek');
    } finally { await c.query('ROLLBACK'); c.release(); }
    assert.deepEqual(await allRows(), baseline, `${table}.${counter} immutable after rollback`);
  }
});

test('145 refuses a genuinely accepted ordinary parcel plan with pristine counters before any custody write', async () => {
  const p = await product(), a = await order(p, 2), b = await order(p, 3);
  const pv = await preview(a, b, 'into_main_order');
  await scan(a, p);
  await ok('/orders/' + a.id + '/scan', 'POST', { client_key: randomUUID(), code: p.sku, location: 'A-01' });
  await ok('/orders/' + a.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + a.id + '/status', { status: 'packed' }));
  const current = await ok('/orders/' + a.id);
  assert.equal(current.items.length, 1);
  const parcelPreview = (await ok('/order-parcels/orders/' + a.id + '/previews', 'POST', {
    client_key: randomUUID(), order_version: String(current.version), protocol: 'commercial_v1',
    parcels: [0, 1].map(() => ({ source_kind: 'demo', cod_minor: 1000,
      items: [{ item_id: current.items[0].id, quantity: 1 }] })),
  }, 201)).preview;
  const plan = (await ok('/order-parcels/previews/' + parcelPreview.id + '/apply', 'POST', {
    client_key: randomUUID(), scope_hash: parcelPreview.scope_hash, confirmed: true,
  }, 201)).plan;
  assert.equal(plan.order_id, a.id); assert(plan.progress.every((r: Row) => r.state === 'pending'));
  for (const table of custodyTables) for (const r of await rows(table)) {
    assert.equal(r.consumed_quantity, 0); assert.equal(r.released_quantity, 0);
  }
  assert.equal((await rows('order_parcel_dispatches')).length, 0);
  assert.equal((await rows('order_parcel_releases')).length, 0);
  const baseline = await allRows(), c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const h = (await c.query('SELECT * FROM order_merge_previews WHERE tenant_id=$1 AND id=$2', [tenant, pv.id])).rows[0];
    // The merge was reviewed before the ordinary plan. An isolated tentative execution
    // exercises the issuer's explicit plan fence before its later stale snapshot CAS.
    // No plan or custody receipt is fabricated and the entire execution is rolled back.
    const execution = { ...h, id: randomUUID(), preview_id: pv.id, client_key: randomUUID(),
      request: consent(pv), state: 'done', before_snapshot: h.snapshot, after_snapshot: {} };
    await c.query('INSERT INTO order_merge_executions SELECT * FROM jsonb_populate_record(NULL::order_merge_executions,$1::jsonb)', [JSON.stringify(execution)]);
    await c.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(() => c.query('SELECT order_merge_transfer_custody($1)', [execution.id]),
      (e: any) => e.code === '23514' && e.message === 'Scalanie wymaga pierwotnych rezerwacji bez wydania, zwolnienia i planu paczek');
  } finally { await c.query('ROLLBACK'); c.release(); }
  assert.deepEqual(await allRows(), baseline, 'Accepted plan, shipments, zero counters and every other business row survive denial unchanged');
  assert.equal(transportCalls, 0);
});
