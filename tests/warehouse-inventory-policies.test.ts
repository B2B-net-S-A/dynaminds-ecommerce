import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts } from './product-catalogs-fixture';
import * as V from '../server/warehouse-inventory-policies-schema';
import * as S from '../server/warehouse-inventory-policies';

assert.equal(process.env.DYNA_TEST, 'true');
const url = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
assert.match(url.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await migrate(); await seed(); app = await buildApp({ integrationTransport: async () => { throw Error('Warehouse policy tests cannot call providers'); } }); });
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
const prefix = '/warehouse-inventory-policies';
const body = (version = '0', usage: 'sale' | 'custody' = 'custody') => ({ client_key: randomUUID(), version, usage, enabled: true });
const consent = (p: any) => ({ client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true });
async function preview(f: any, wh: string, b = body()) { return (await f.ok(prefix + '/warehouses/' + wh + '/previews', 'POST', b, 201)).preview; }
async function commit(f: any, p: any, b = consent(p)) { return f.ok(prefix + '/previews/' + p.id + '/commit', 'POST', b, 201); }
function noCommerceChange(before: Record<string, any[]>, afterRows: Record<string, any[]>) {
  assert.deepEqual(Object.keys(afterRows), Object.keys(before));
  for (const name of Object.keys(before)) if (!name.startsWith('warehouse_inventory_polic')) assert.deepEqual(afterRows[name], before[name], name);
}
async function policy(f: any, wh: string) { return tenantTx(f.tenant, c => S.warehouseInventoryPolicyInTx(c, wh)); }
async function document(f: any, kind: 'receipt' | 'transfer' | 'issue', wh: string, quantity: number, dest: string | null = null) {
  const d = await f.ok('/warehouse-documents', 'POST', { kind, warehouse_id: wh, destination_id: dest, reference: 'Own policy fixture', lines: [{ product_id: f.product.id, quantity, location: 'POLICY-01' }] }, 201);
  return f.ok('/warehouse-documents/' + d.id + '/post', 'POST', { version: d.version });
}

test('strict consent/version limits and physical availability remain distinct from sellable quantities', () => {
  assert(V.warehouseInventoryPolicyPreviewInput.safeParse(body()).success);
  for (const version of ['00', '-1', '1.0', '9223372036854775807']) assert(!V.warehouseInventoryPolicyPreviewInput.safeParse(body(version)).success);
  assert(!V.warehouseInventoryPolicyCommitInput.safeParse({ client_key: randomUUID(), scope_hash: 'a'.repeat(64), confirmed: false }).success);
  assert(!V.warehouseInventoryPolicyPreviewInput.safeParse({ ...body(), skip_stock: true }).success);
  assert.deepEqual(S.warehouseInventoryAvailability(7, { usage: 'custody', enabled: true, version: '1' }), { physical_available: 7, sellable_available: 0 });
  assert.deepEqual(S.warehouseInventoryAvailability(7, { usage: 'sale', enabled: false, version: '1' }), { physical_available: 7, sellable_available: 0 });
  assert.deepEqual(S.warehouseInventoryAvailability(7, { usage: 'sale', enabled: true, version: '0' }), { physical_available: 7, sellable_available: 7 });
});

test('empty warehouse preview/commit CAS preserves all commerce; exact retry has no extra revision or operation', async () => {
  for (const on of [false, true]) {
    const f = await productCatalogFixture(app, on), born = await productCatalogFacts(f.tenant);
    assert.deepEqual(await policy(f, f.spare.id), { usage: 'sale', enabled: true, version: '0' });
    const b = body(), p = await preview(f, f.spare.id, b), stale = await preview(f, f.spare.id);
    assert.equal(p.ready, true); assert.deepEqual(p.snapshot.blockers, []);
    const r = await commit(f, p); assert.deepEqual(r.operation.after, { usage: 'custody', enabled: true, version: '1' });
    const saved = await productCatalogFacts(f.tenant), c = (await pool.query('SELECT request FROM warehouse_inventory_policy_operations WHERE tenant_id=$1 AND id=$2', [f.tenant, r.operation.id])).rows[0].request;
    const replay = await f.ok(prefix + '/previews/' + p.id + '/commit', 'POST', c);
    assert.equal(replay.reused, true); assert.deepEqual(replay.operation, r.operation);
    const pr = await f.ok(prefix + '/warehouses/' + f.spare.id + '/previews', 'POST', b); assert.equal(pr.reused, true); assert.deepEqual(pr.preview, p);
    assert.equal((await f.request(prefix + '/previews/' + stale.id + '/commit', 'POST', consent(stale))).statusCode, 409);
    assert.equal((await f.request(prefix + '/previews/' + p.id + '/commit', 'POST', { ...c, scope_hash: '0'.repeat(64) })).statusCode, 409);
    assert.deepEqual(await productCatalogFacts(f.tenant), saved); noCommerceChange(born, saved);
  }
});

test('occupied warehouse gives a complete blocked preview and commit cannot change stock, layers or history', async () => {
  const f = await productCatalogFixture(app, true), p = await preview(f, f.warehouse);
  assert.equal(p.ready, false); assert(p.snapshot.blockers.includes('STOCK_NOT_EMPTY')); assert(p.snapshot.blockers.includes('WMS_NOT_EMPTY'));
  const beforeRows = await productCatalogFacts(f.tenant);
  assert.equal((await f.request(prefix + '/previews/' + p.id + '/commit', 'POST', consent(p))).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});

test('empty ON warehouse advances implicit sale0 to stored sale1 and custody2; old receipts replay without extra facts and stale CAS is denied', async () => {
  const f = await productCatalogFixture(app, true), born = await productCatalogFacts(f.tenant);
  assert.deepEqual(await policy(f, f.spare.id), { usage: 'sale', enabled: true, version: '0' });
  const firstPreview = await preview(f, f.spare.id, body('0', 'sale')), firstConsent = consent(firstPreview);
  assert.equal(firstPreview.ready, true); assert.deepEqual(firstPreview.snapshot.blockers, []);
  const first = await commit(f, firstPreview, firstConsent);
  assert.equal(first.reused, false); assert.deepEqual(first.operation.before, { usage: 'sale', enabled: true, version: '0' });
  assert.deepEqual(first.operation.after, { usage: 'sale', enabled: true, version: '1' });
  const stale = await preview(f, f.spare.id, body('1', 'custody'));
  const secondPreview = await preview(f, f.spare.id, body('1', 'custody')), secondConsent = consent(secondPreview);
  assert.deepEqual(secondPreview.snapshot.before, first.operation.after); assert.deepEqual(secondPreview.snapshot.blockers, []);
  const second = await commit(f, secondPreview, secondConsent);
  assert.equal(second.reused, false); assert.deepEqual(second.operation.before, first.operation.after);
  assert.deepEqual(second.operation.after, { usage: 'custody', enabled: true, version: '2' });
  assert.deepEqual(await policy(f, f.spare.id), second.operation.after);
  const saved = await productCatalogFacts(f.tenant); noCommerceChange(born, saved);
  for (const name of ['warehouse_inventory_policy_revisions', 'warehouse_inventory_policy_operations', 'warehouse_inventory_policy_admissions']) {
    assert.equal(saved[name].length, 2, name);
  }
  for (const [p, b, result] of [[firstPreview, firstConsent, first], [secondPreview, secondConsent, second]]) {
    const replay = await f.ok(prefix + '/previews/' + p.id + '/commit', 'POST', b, 200);
    assert.equal(replay.reused, true); assert.deepEqual(replay.operation, result.operation);
    assert.deepEqual(await productCatalogFacts(f.tenant), saved, 'Known exact retry cannot write another revision, operation, admission or commerce fact');
  }
  assert.equal((await f.request(prefix + '/previews/' + stale.id + '/commit', 'POST', consent(stale))).statusCode, 409);
  assert.equal((await f.request(prefix + '/warehouses/' + f.spare.id + '/previews', 'POST', body('1', 'sale'))).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), saved);
});

test('custody receives real OFF stock and transfers it to sale; ordinary warehouse issue is denied atomically', async () => {
  const f = await productCatalogFixture(app), p = await preview(f, f.spare.id); await commit(f, p);
  await document(f, 'receipt', f.spare.id, 4);
  const stock = (await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [f.tenant, f.spare.id, f.product.id])).rows[0];
  assert.deepEqual(stock, { on_hand: 4, reserved: 0 });
  const issue = await f.ok('/warehouse-documents', 'POST', { kind: 'issue', warehouse_id: f.spare.id, destination_id: null, lines: [{ product_id: f.product.id, quantity: 1, location: 'POLICY-01' }] }, 201);
  const beforeRows = await productCatalogFacts(f.tenant);
  assert.equal((await f.request('/warehouse-documents/' + issue.id + '/post', 'POST', { version: issue.version })).statusCode, 409);
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  await document(f, 'transfer', f.spare.id, 2, f.warehouse);
  assert.equal((await pool.query('SELECT on_hand FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [f.tenant, f.spare.id, f.product.id])).rows[0].on_hand, 2);
  const movements = (await pool.query("SELECT kind,delta,warehouse_id FROM stock_movements WHERE tenant_id=$1 AND warehouse_document_id IN(SELECT id FROM warehouse_documents WHERE tenant_id=$1 AND kind='transfer') ORDER BY delta", [f.tenant])).rows;
  assert.deepEqual(movements, [{ kind: 'transfer_out', delta: -2, warehouse_id: f.spare.id }, { kind: 'transfer_in', delta: 2, warehouse_id: f.warehouse }]);
});

test('ON custody receipt then explicitly approved WMS MM preserves the actual layer/cost, paired journals and exact replay', async () => {
  const f = await productCatalogFixture(app, true), productId = f.components[0].id;
  await commit(f, await preview(f, f.spare.id));
  const policyVersion = String((await f.ok('/wms-lots')).policy.version);
  const version = async (warehouseId: string) => String((await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [f.tenant, warehouseId, productId])).rows[0]?.version ?? '0');
  const stock = async (warehouseId: string) => (await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [f.tenant, warehouseId, productId])).rows[0];
  const originalDestination = await stock(f.warehouse);
  const receipt = await f.ok('/wms-lots/receipts', 'POST', {
    client_key: randomUUID(), policy_version: policyVersion, warehouse_id: f.spare.id,
    stock_versions: [{ warehouse_id: f.spare.id, product_id: productId, version: await version(f.spare.id) }],
    lines: [{ product_id: productId, location: 'CUSTODY-ON', quantity: 4, lot_code: 'Own policy custody101', unit_cost_minor: '101', currency: 'PLN' }],
    note: 'Own real custody receipt before transfer', confirmed: true,
  }, 201);
  assert.deepEqual(await stock(f.spare.id), { on_hand: 4, reserved: 0 });
  const layer = (await pool.query('SELECT * FROM wms_cost_layers WHERE tenant_id=$1 AND operation_id=$2 AND product_id=$3', [f.tenant, receipt.operation.id, productId])).rows;
  assert.equal(layer.length, 1); assert.equal(layer[0].unit_cost_minor, '101'); assert.equal(layer[0].quantity_received, 4);
  const valuation = await f.ok('/wms-lots/valuation');
  const p = (await f.ok('/wms-lots/movement-previews', 'POST', {
    client_key: randomUUID(), policy_version: policyVersion, kind: 'transfer', product_id: productId,
    warehouse_id: f.spare.id, location: 'CUSTODY-ON', quantity: 2,
    destination_warehouse_id: f.warehouse, destination_location: 'POLICY-MM', layer_ids: [layer[0].id],
    // Real current CAS for both warehouses; never seed or corrupt stock.
    stock_versions: await Promise.all([f.spare.id, f.warehouse].map(async warehouse_id => ({ warehouse_id, product_id: productId, version: await version(warehouse_id) }))),
    note: 'Own custody to sale preserves origin cost',
  }, 201)).preview;
  assert.equal(p.ready, true);
  const beforeApproval = await productCatalogFacts(f.tenant);
  // A read of the stored full preview cannot move stock or layers.
  await f.ok('/wms-lots/movement-previews/' + p.id);
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeApproval);
  const b = consent(p), applied = await f.ok('/wms-lots/movement-previews/' + p.id + '/execute', 'POST', b, 201);
  assert.equal(applied.reused, false);
  assert.deepEqual(await stock(f.spare.id), { on_hand: 2, reserved: 0 });
  assert.deepEqual(await stock(f.warehouse), { on_hand: originalDestination.on_hand + 2, reserved: originalDestination.reserved });
  const op = (await pool.query('SELECT * FROM wms_operations WHERE tenant_id=$1 AND id=$2', [f.tenant, applied.operation.id])).rows[0];
  assert.equal(op.kind, 'transfer'); assert.equal(op.request.preview_id, p.id);
  assert.equal(op.result.source_warehouse_id, f.spare.id); assert.equal(op.result.destination_warehouse_id, f.warehouse);
  const mm = (await pool.query('SELECT * FROM warehouse_documents WHERE tenant_id=$1 AND id=$2', [f.tenant, op.warehouse_document_id])).rows[0];
  assert.equal(mm.kind, 'transfer'); assert.equal(mm.status, 'posted'); assert.equal(mm.warehouse_id, f.spare.id); assert.equal(mm.destination_id, f.warehouse);
  assert.deepEqual((await pool.query('SELECT product_id,quantity FROM warehouse_document_lines WHERE tenant_id=$1 AND document_id=$2', [f.tenant, mm.id])).rows, [{ product_id: productId, quantity: 2 }]);
  assert.deepEqual((await pool.query('SELECT warehouse_id,delta,kind,order_id FROM stock_movements WHERE tenant_id=$1 AND warehouse_document_id=$2 ORDER BY delta', [f.tenant, mm.id])).rows,
    [{ warehouse_id: f.spare.id, delta: -2, kind: 'wms_transfer', order_id: null }, { warehouse_id: f.warehouse, delta: 2, kind: 'wms_transfer', order_id: null }]);
  assert.deepEqual((await pool.query('SELECT warehouse_id,location,delta,kind,order_id FROM stock_location_movements WHERE tenant_id=$1 AND operation_id=$2 ORDER BY delta', [f.tenant, op.id])).rows,
    [{ warehouse_id: f.spare.id, location: 'CUSTODY-ON', delta: -2, kind: 'wms_transfer', order_id: null }, { warehouse_id: f.warehouse, location: 'POLICY-MM', delta: 2, kind: 'wms_transfer', order_id: null }]);
  assert.deepEqual((await pool.query('SELECT warehouse_id,location,layer_id,delta,value_delta,kind FROM wms_layer_movements WHERE tenant_id=$1 AND operation_id=$2 ORDER BY delta', [f.tenant, op.id])).rows,
    [{ warehouse_id: f.spare.id, location: 'CUSTODY-ON', layer_id: layer[0].id, delta: -2, value_delta: '-202', kind: 'transfer' }, { warehouse_id: f.warehouse, location: 'POLICY-MM', layer_id: layer[0].id, delta: 2, value_delta: '202', kind: 'transfer' }]);
  for (const [warehouseId, location] of [[f.spare.id, 'CUSTODY-ON'], [f.warehouse, 'POLICY-MM']]) {
    assert.deepEqual((await pool.query('SELECT quantity,reserved FROM wms_layer_positions WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 AND location=$4 AND layer_id=$5', [f.tenant, warehouseId, productId, location, layer[0].id])).rows, [{ quantity: 2, reserved: 0 }]);
    assert.deepEqual((await pool.query('SELECT quantity FROM stock_locations WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 AND location=$4', [f.tenant, warehouseId, productId, location])).rows, [{ quantity: 2 }]);
  }
  assert.deepEqual((await pool.query('SELECT * FROM wms_cost_layers WHERE tenant_id=$1 AND id=$2', [f.tenant, layer[0].id])).rows, layer);
  const afterValue = await f.ok('/wms-lots/valuation'); assert.equal(afterValue.valuation.known_minor, valuation.valuation.known_minor); assert.equal(afterValue.valuation.unknown_quantity, valuation.valuation.unknown_quantity);
  const afterRows = await productCatalogFacts(f.tenant), replay = await f.ok('/wms-lots/movement-previews/' + p.id + '/execute', 'POST', b);
  assert.equal(replay.reused, true); assert.deepEqual(replay.operation, applied.operation); assert.deepEqual(replay.result, applied.result);
  assert.deepEqual(await productCatalogFacts(f.tenant), afterRows);
});

test('raw app reservation/increase cannot make custody sellable; private policy writes and foreign getter are denied', async () => {
  const f = await productCatalogFixture(app), p = await preview(f, f.spare.id); await commit(f, p); await document(f, 'receipt', f.spare.id, 2);
  const beforeRows = await productCatalogFacts(f.tenant);
  await assert.rejects(tenantTx(f.tenant, c => c.query('UPDATE stock SET reserved=reserved+1 WHERE warehouse_id=$1 AND product_id=$2', [f.spare.id, f.product.id])), (e: any) => e.code === '23514' && /CUSTODY/.test(e.message));
  await assert.rejects(tenantTx(f.tenant, c => c.query("UPDATE warehouse_inventory_policies SET usage='sale' WHERE warehouse_id=$1", [f.spare.id])), (e: any) => e.code === '42501');
  await assert.rejects(tenantTx(f.tenant, c => c.query(`INSERT INTO return_cases
    SELECT (jsonb_populate_record(NULL::return_cases,to_jsonb(r)||jsonb_build_object('id',$3::uuid,'warehouse_id',$4::uuid,'number',$5::text))).*
    FROM return_cases r WHERE tenant_id=$1 AND id=$2`, [f.tenant, f.rma.id, randomUUID(), f.spare.id, 'RAW-CUSTODY-' + randomUUID()])),
    (e: any) => e.code === '23514' && /CUSTODY/.test(e.message));
  const other = await productCatalogFixture(app);
  await assert.rejects(tenantTx(f.tenant, c => c.query('SELECT warehouse_inventory_policy($1,$2)', [other.tenant, other.warehouse])), (e: any) => e.code === '42501');
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});

test('current admin withdrawal while preview really waits on warehouse aborts every new policy row', async () => {
  const f = await productCatalogFixture(app), beforeRows = await productCatalogFacts(f.tenant), held = await pool.connect();
  let request: Promise<any> | undefined;
  try {
    await held.query('BEGIN'); await held.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.tenant, f.spare.id]);
    const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    request = S.previewWarehouseInventoryPolicy(f.actor, f.spare.id, body());
    void request.catch(() => {});
    const until = Date.now() + 5000; let waited = false;
    while (Date.now() < until) {
      const waiting = (await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [pid])).rows;
      if (waiting.some(r => /warehouse_inventory_policy_preview/.test(r.query))) { waited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(waited, 'The real typed preview must wait on this warehouse');
    await held.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); await held.query('COMMIT');
    await assert.rejects(request, (e: any) => e.status === 403);
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  } finally { await held.query('ROLLBACK').catch(() => {}); held.release(); if (request) await request.catch(() => {}); await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); }
});

test('torn trigger fails closed as503 and exact repair retains all own data', async () => {
  const f = await productCatalogFixture(app), c = await pool.connect(), beforeRows = await productCatalogFacts(f.tenant);
  try {
    await c.query('BEGIN'); await c.query('ALTER TABLE stock DISABLE TRIGGER warehouse_inventory_policy_source_guard');
    await assert.rejects(S.warehouseInventoryPoliciesAvailable(c), (e: any) => e.status === 503);
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    await assert.rejects(c.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4)', [randomUUID(), f.tenant, 'Own torn policy birth', 'TORN-' + randomUUID().slice(0, 8)]),
      (e: any) => e.code === '55000' && e.message === 'Niekompletna polityka magazynów');
  } finally { await c.query('ROLLBACK'); c.release(); }
  assert.equal(await S.warehouseInventoryPoliciesAvailable(), true); assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});

test('foreign table/column/function grants, delegated getter and extra RLS policy fail closed without retained DDL or data changes', async () => {
  const f = await productCatalogFixture(app), beforeRows = await productCatalogFacts(f.tenant), c = await pool.connect();
  // Built-in role exists on the host PostgreSQL; no cluster role/membership is created.
  assert.equal((await c.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='pg_read_all_data') present")).rows[0].present, true);
  const metadata = async () => (await c.query(`SELECT c.relname,c.relacl::text,
    (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'acl',a.attacl::text) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,
    (SELECT jsonb_agg(jsonb_build_object('name',p.polname,'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid) policies
    FROM pg_class c WHERE c.oid IN('warehouse_inventory_policies'::regclass,'warehouse_inventory_policy_previews'::regclass) ORDER BY c.relname`)).rows;
  const functions = async () => (await c.query(`SELECT oid::regprocedure::text signature,proacl::text FROM pg_proc
    WHERE oid IN('warehouse_inventory_policy(uuid,uuid)'::regprocedure,'warehouse_inventory_policy_commit(uuid,uuid,uuid,jsonb)'::regprocedure) ORDER BY 1`)).rows;
  const beforeMetadata = await metadata(), beforeFunctions = await functions();
  const hostileDDL = [
    'GRANT SELECT ON warehouse_inventory_policies TO pg_read_all_data',
    'GRANT UPDATE ON warehouse_inventory_policy_previews TO pg_read_all_data',
    'GRANT SELECT(snapshot) ON warehouse_inventory_policy_previews TO pg_read_all_data',
    'GRANT EXECUTE ON FUNCTION warehouse_inventory_policy_commit(uuid,uuid,uuid,jsonb) TO pg_read_all_data',
    'GRANT EXECUTE ON FUNCTION warehouse_inventory_policy(uuid,uuid) TO pg_read_all_data',
    'GRANT EXECUTE ON FUNCTION warehouse_inventory_policy(uuid,uuid) TO dyna_app WITH GRANT OPTION',
    'CREATE POLICY unexpected_policy ON warehouse_inventory_policies USING(true) WITH CHECK(true)',
  ];
  try {
    for (const ddl of hostileDDL) {
      await c.query('BEGIN');
      try {
        await c.query(ddl);
        assert.equal((await c.query('SELECT warehouse_inventory_policy_guards() ok')).rows[0].ok, false, ddl);
        await assert.rejects(S.warehouseInventoryPoliciesAvailable(c), (e: any) => e.status === 503, ddl);
      } finally { await c.query('ROLLBACK'); }
      assert.equal(await S.warehouseInventoryPoliciesAvailable(c), true, ddl);
      assert.deepEqual(await metadata(), beforeMetadata, ddl);
      assert.deepEqual(await functions(), beforeFunctions, ddl);
    }
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
});
