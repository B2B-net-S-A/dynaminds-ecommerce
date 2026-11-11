// SOURCE_AUTHORED_NOT_RUN. Root alone registers the actual adapter and runs PG/HTTP gates.
// No test-only route injection: every request uses the real buildApp normal/v1 graph.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { publicApiDocument } from '../server/developer-api';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture } from './stocktake-adjustments-fixture';
import { bootstrap151169, install152169, facts169, own169, consent169, type Row } from './catalog-stock-control169-fixture';

const path = '/catalog-stock-control/count-documents';
let app: Awaited<ReturnType<typeof buildApp>>, providers = 0;
let absent: Row, absentDetailStatus: number;
const transport = async () => { providers++; throw Error('No providers in COUNT read routes'); };
before(async () => {
  await bootstrap151169(); await seed();
  const historical = await buildApp({ integrationTransport: transport });
  try {
    const login = await historical.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress: '127.169.20.1' });
    assert.equal(login.statusCode, 200);
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] }, before = await facts169();
    const reply = await historical.inject({ url: '/api' + path, headers });
    assert.equal(reply.statusCode, 200, 'Genuine151 absence must reach COUNT neutral read, not BO activation guard');
    assert.equal(reply.headers['cache-control'], 'no-store'); absent = reply.json();
    const detail = await historical.inject({ url: '/api' + path + '/' + randomUUID(), headers });
    absentDetailStatus = detail.statusCode; assert.equal(absentDetailStatus, 404);
    assert.deepEqual(await facts169(), before, 'Pre152 read does not backfill, login, number or change a session');
  } finally { await historical.close(); }
  await install152169(); app = await buildApp({ integrationTransport: transport });
});
after(async () => { try { await app?.close(); assert.equal(providers, 0); } finally { await pool.end(); } });

const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };
const forbidden = new Set(['nonce','proof','frame','request','snapshot','admission_id','actor_id','api_key_id',
  'scope_hash','rows_sha256','input_hash','unit_cost_minor','value_minor','currency','exponent']);
function safe(v: unknown) {
  if (Array.isArray(v)) { for (const x of v) safe(x); return; }
  if (v && typeof v === 'object') for (const [key, value] of Object.entries(v)) {
    assert(!forbidden.has(key), 'Public quantity projection omits ' + key); safe(value);
  }
}
async function born(on: boolean) {
  const f = await stocktakeAdjustmentFixture(app, on);
  const catalog = one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1', [f.tenant])).rows).catalog_id as string;
  const context = { writersAvailable: true }; // Explicit internal test consent; public activation remains false.
  const { source } = await sourceCatalogStockControl(f.actor, catalog, context); assert.equal(source.ready, true);
  const { preview } = await previewCatalogStockControl(f.actor, catalog, { client_key: randomUUID(),
    catalog_version: source.snapshot.catalog.version, policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.series.version })),
  }, context);
  assert.equal((await commitCatalogStockControl(f.actor, preview.id, consent169(preview), context)).operation.after.strict, true);
  const facts = await facts169(); let result: Row;
  if (!on) {
    const stocks = own169(facts, 'stock', f.tenant), products = own169(facts, 'products', f.tenant);
    const rows = f.products.flatMap(p => ['A-01','B-02'].map(location => ({ product_id: p.id,
      product_version: one(products.filter(x => x.id === p.id)).version,
      stock_version: String(one(stocks.filter(x => x.product_id === p.id && x.warehouse_id === f.warehouse.id)).version),
      location, operation: 'count', quantity: location === 'A-01' ? 1 : 3 })));
    const prepared = await f.ok('/inventory-bulk-edit/previews', 'POST', { client_key: randomUUID(), warehouse_id: f.warehouse.id,
      note: 'Actual HTTP COUNT source', rows }, 201); assert.equal(prepared.preview.ready, true);
    result = await f.ok('/inventory-bulk-edit/previews/' + prepared.preview.id + '/execute', 'POST', consent169(prepared.preview), 201);
  } else {
    const positions = own169(facts, 'wms_layer_positions', f.tenant), layers = own169(facts, 'wms_cost_layers', f.tenant);
    const lot = (id: string, location: string) => one(layers.filter(l => l.id === one(positions.filter(p => p.product_id === id && p.location === location)).layer_id)).lot_id;
    const content = 'SKU;Q;LOT;LOC;COST;CUR\n' + f.products.flatMap(p => [
      `${p.sku};1;${lot(p.id,'A-01')};A-01;;`, `${p.sku};3;${lot(p.id,'B-02')};B-02;${p.cost ?? '1000'};PLN`,
    ]).join('\n');
    const prepared = await f.ok('/stock-file-imports/previews', 'POST', { client_key: randomUUID(), file_name: 'count-http169.csv',
      note: 'Actual HTTP0/1000/NULL source', content,
      definition: { format: 'csv', xml_mode: 'positions', delimiter: ';', identity: 'sku', identity_field: 'SKU', spreadsheet_safe: false, empty_policy: 'skip' },
      targets: [{ warehouse_id: f.warehouse.id, quantity_scope: 'position', default_location: 'A-01',
        mapping: { quantity: 'Q', location: 'LOC', lot_id: 'LOT', unit_cost_minor: 'COST', currency: 'CUR' } }], resolutions: [],
    }, 201);
    assert.equal(prepared.preview.summary.invalid, 0); assert.equal(prepared.preview.summary.conflicts, 0);
    result = await f.ok('/stock-file-imports/previews/' + prepared.preview.id + '/execute', 'POST', {
      ...consent169(prepared.preview), ack_unknown_loss_warehouse_ids: [f.warehouse.id], ack_surplus_warehouse_ids: [f.warehouse.id],
    }, 201);
  }
  const documents = result.execution.stock_count_documents as Row[]; assert.equal(documents.length, 2);
  return { ...f, result, documents };
}
type Fixture = Awaited<ReturnType<typeof born>>;
const fixtures = new Map<boolean, Promise<Fixture>>();
function fixture(on = false) { let f = fixtures.get(on); if (!f) { f = born(on); fixtures.set(on, f); } return f; }
async function get(f: Fixture, url: string, status = 200, key?: Row) {
  const reply = await f.request(url, 'GET', undefined, key);
  assert.equal(reply.statusCode, status, 'Actual COUNT GET ' + url);
  assert.equal(reply.headers['cache-control'], 'no-store'); assert.equal(reply.headers['set-cookie'], undefined);
  const value = reply.json(); if (status === 200) safe(value); return value as Row;
}
async function full(f: Fixture, id: string, key?: Row) {
  const rows: Row[] = []; let cursor: string | null = null, head: Row | undefined;
  do {
    const reply = await get(f, path + '/' + id + '?' + new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) }), 200, key);
    assert.equal(reply.available, true); assert.equal(reply.can_read, true); assert.equal(reply.can_read_value, false);
    assert.equal(reply.value_state, 'not_projected'); assert.equal(reply.meta.total, 3); assert.equal(reply.meta.limit, 1);
    if (head) assert.deepEqual(reply.document, head); else head = reply.document;
    assert.equal(reply.data.length, 1); assert.equal(reply.data[0].ordinal, rows.length); rows.push(...reply.data);
    assert(rows.length <= reply.meta.total, 'No repeated page or unbounded row traversal');
    if (reply.meta.cursor !== null) { assert.equal(typeof reply.meta.cursor, 'string'); assert.notEqual(reply.meta.cursor, cursor); }
    cursor = reply.meta.cursor;
  } while (cursor);
  assert(head); assert.equal(rows.length, head.row_count);
  assert.equal(rows.reduce((n, r) => n + BigInt(r.quantity), 0n), BigInt(head.quantity));
  return { head, rows };
}

test('COUNT public GET descriptors retain both native read scopes and bounded typed paging in restored copies', () => {
  const paths = publicApiDocument().paths as Record<string, Row>;
  const copy = publicApiDocument({ readOnly: true, port: 4198 }).paths as Record<string, Row>;
  for (const p of [path, path + '/{id}']) {
    assert(paths[p]?.get, p); assert(copy[p]?.get, p);
    assert.deepEqual(new Set(paths[p].get['x-required-scopes']), new Set(['products:read','inventory:read']));
    assert.equal(paths[p].post, undefined); assert.equal(copy[p].post, undefined);
    assert.equal(paths[p].get.parameters.find((p: Row) => p.name === 'limit').schema.maximum, 50);
    assert.equal(paths[p].get.parameters.find((p: Row) => p.name === 'cursor').schema.maxLength, 4096);
  }
  for (const name of ['protocol','execution_id','warehouse_id','kind']) assert(paths[path].get.parameters.some((p: Row) => p.name === name));
  assert.equal(paths[path + '/{id}'].get.parameters.find((p: Row) => p.name === 'id').schema.format, 'uuid');
});
test('real pre152 HTTP absence is neutral and does not become torn503 or invented history', () => {
  assert.equal(absent.available, false); assert.equal(absent.can_read_value, false); assert.equal(absent.value_state, 'not_projected');
  assert.deepEqual(absent.data, []); assert.equal(absent.meta.cursor, null); assert.equal(absentDetailStatus, 404); safe(absent);
});
test('normal and v1 GETs page real086 tie heads and every frozen signed row with all-global purity', async () => {
  const f = await fixture(), key = await f.ok('/developer/keys', 'POST', { name: 'COUNT HTTP reader', scopes: ['products:read','inventory:read'] }, 201);
  const before = await facts169();
  for (const reader of [undefined, key]) {
    const first = await get(f, path + '?limit=1', 200, reader); assert(first.meta.cursor);
    const second = await get(f, path + '?' + new URLSearchParams({ limit: '1', cursor: first.meta.cursor }), 200, reader);
    assert.equal(second.meta.cursor, null); assert.notEqual(first.data[0].id, second.data[0].id);
    assert.equal(first.data[0].created_at, second.data[0].created_at);
    assert.deepEqual([first.data[0].id,second.data[0].id].sort(), f.documents.map(d => d.id).sort());
    for (const d of [...first.data,...second.data] as Row[]) {
      const detail = await full(f, d.id, reader); assert.deepEqual(detail.head, d);
      const frozen = own169(before, 'catalog_stock_count_rows', f.tenant).filter(r => r.document_id === d.id).sort((a, b) => a.ordinal - b.ordinal);
      assert.deepEqual(detail.rows.map(r => [r.id,r.product_id,r.warehouse_id,r.delta,r.bin_movement_id]), frozen.map(r => [r.id,r.product_id,r.warehouse_id,r.delta,r.bin_movement_id]));
      assert(detail.rows.every(r => r.layer_movement_id === null && (d.kind === 'PW' ? r.delta === 1 : r.delta === -1)));
    }
  }
  assert.deepEqual(await facts169(), before, 'GET pages change no table, counter, stock or session');
});
test('HTTP filters, malformed queries, foreign IDs and cursors fail without alternate private projection', async () => {
  const f = await fixture(), other = await fixture(true), before = await facts169();
  const selected = await get(f, path + '?' + new URLSearchParams({ warehouse_id: f.warehouse.id, execution_id: f.result.execution.id, protocol: 'inventory_bulk', kind: 'PW' }));
  assert.equal(selected.data.length, 1); assert.equal(selected.data[0].kind, 'PW');
  const first = await get(f, path + '?limit=1'); assert(first.meta.cursor);
  await get(other, path + '?' + new URLSearchParams({ limit: '1', cursor: first.meta.cursor }), 409);
  await get(f, path + '?' + new URLSearchParams({ limit: '2', cursor: first.meta.cursor }), 409);
  await get(f, path + '?cursor=notAuthenticated169', 422);
  await get(other, path + '/' + f.documents[0].id, 404);
  await get(f, path + '?warehouse_id=' + other.warehouse.id, 404);
  await get(f, path + '?execution_id=' + other.result.execution.id, 404);
  for (const suffix of ['?limit=0','?limit=51','?protocol=fake','?kind=PZ','?warehouse_id=bad','?include_values=true']) await get(f, path + suffix, 422);
  await get(f, path + '/not-a-uuid', 422);
  const rows = await get(f, path + '/' + f.documents[0].id + '?limit=1'); assert(rows.meta.cursor);
  await get(f, path + '/' + f.documents[1].id + '?' + new URLSearchParams({ limit: '1', cursor: rows.meta.cursor }), 409);
  assert.deepEqual(await facts169(), before);
});
test('current viewer reads quantities, and incomplete or revoked API keys never receive cached heads', async () => {
  const f = await fixture(), key = await f.ok('/developer/keys', 'POST', { name: 'COUNT HTTP authority', scopes: ['products:read','inventory:read'] }, 201);
  const missing = await f.ok('/developer/keys', 'POST', { name: 'COUNT HTTP missing inventory', scopes: ['products:read'] }, 201);
  const before = await facts169(); await get(f, path, 403, missing); assert.deepEqual(await facts169(), before);
  await pool.query("UPDATE memberships SET role='viewer' WHERE(tenant_id,user_id)=($1,$2)", [f.tenant,f.user]);
  try { const current = await facts169();
    // The native013 demotion trigger irrevocably revokes this admin-owned key.
    await get(f, path, 401, key);
    const reply = await get(f, path); assert.equal(reply.current_role, 'viewer');
    await full(f, f.documents[0].id); assert.deepEqual(await facts169(), current); }
  finally { await pool.query("UPDATE memberships SET role='admin' WHERE(tenant_id,user_id)=($1,$2)", [f.tenant,f.user]); }
  // Re-promotion must not revive the exact credential revoked by demotion.
  const revoked = await facts169(); await get(f, path, 401, key); assert.deepEqual(await facts169(), revoked);
});
test('real115 ON quantity HTTP includes actual layer lineage and retains0/NULL only in private source', async () => {
  const f = await fixture(true), before = await facts169(), reply = await get(f, path + '?protocol=stock_file');
  assert.equal(reply.data.length, 2); const rw = one(reply.data.filter((d: Row) => d.kind === 'RW'));
  const detail = await full(f, rw.id), frozen = own169(before, 'catalog_stock_count_rows', f.tenant).filter(r => r.document_id === rw.id);
  assert.deepEqual(frozen.map(r => r.payload.unit_cost_minor).sort(), [null,'0','1000'].sort());
  assert.deepEqual(detail.rows.map(r => r.id).sort(), frozen.map(r => r.id).sort());
  assert(detail.rows.every(r => r.delta === -1 && r.bin_movement_id === null && r.layer_movement_id && r.lot_id && r.layer_id && r.stocktake_line_id && r.stocktake_posting_id));
  assert.deepEqual(await facts169(), before);
});
test('normal unimplemented writes405 and restored normal/v1 malformed writes423 leave every row unchanged', async () => {
  const f = await fixture();
  const before = await facts169();
  for (const namespace of ['/api','/api/v1']) for (const suffix of ['', '/' + f.documents[0].id]) {
    const reply = await app.inject({ method: 'POST', url: namespace + path + suffix, payload: '{',
      headers: { cookie: f.cookie, 'content-type': 'application/json' } }); assert.equal(reply.statusCode, 405);
  }
  assert.deepEqual(await facts169(), before);
  const copy = await buildApp({ readOnly: true, previewPort: 4198, integrationTransport: transport });
  try {
    const remoteAddress = '127.169.20.2';
    assert.equal((await copy.inject({ url: '/api' + path, headers: { cookie: f.cookie }, remoteAddress })).statusCode, 401);
    const login = await copy.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress }); assert.equal(login.statusCode, 200);
    const switched = await copy.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: f.tenant },
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress }); assert.equal(switched.statusCode, 200);
    const cookie = String(switched.headers['set-cookie']).split(';')[0], snapshot = await facts169();
    for (const namespace of ['/api','/api/v1']) {
      const list = await copy.inject({ url: namespace + path, headers: { cookie }, remoteAddress }); assert.equal(list.statusCode, 200);
      assert.equal(list.headers['cache-control'], 'no-store'); assert.equal(list.json().read_only, true); assert.equal(list.json().data.length, 2); safe(list.json());
      const rows = await copy.inject({ url: namespace + path + '/' + f.documents[0].id, headers: { cookie }, remoteAddress });
      assert.equal(rows.statusCode, 200); assert.equal(rows.json().data.length, 3); safe(rows.json());
      for (const suffix of ['', '/' + f.documents[0].id]) {
        const denied = await copy.inject({ method: 'POST', url: namespace + path + suffix, payload: '{',
          headers: { 'content-type': 'application/json' }, remoteAddress }); assert.equal(denied.statusCode, 423);
        assert.equal(denied.headers['set-cookie'], undefined);
      }
    }
    assert.deepEqual(await facts169(), snapshot, 'Only prior explicit copy login/switch changed sessions; all reads/refusals inert');
  } finally { await copy.close(); }
});
test('fresh torn COUNT manifest returns HTTP503 before any fallback, repair or rows change', async () => {
  const f = await fixture();
  await pool.query('ALTER TABLE catalog_stock_count_manifest RENAME TO catalog_stock_count_manifest_routes_hidden');
  try { const before = await facts169();
    for (const url of [path, path + '/' + f.documents[0].id]) await get(f, url, 503);
    assert.deepEqual(await facts169(), before);
  } finally { await pool.query('ALTER TABLE catalog_stock_count_manifest_routes_hidden RENAME TO catalog_stock_count_manifest'); }
});
