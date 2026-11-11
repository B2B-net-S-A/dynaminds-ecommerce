import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { postStocktakeAdjustmentInTx } from '../server/stocktake-adjustments';
import { seed } from './fixtures';
import { productCatalogFacts } from './product-catalogs-fixture';
import { adjustmentActor, stocktakeAdjustmentFixture, countedAdjustmentSource, type AdjustmentFixture, type AdjustmentTestRow as Row } from './stocktake-adjustments-fixture';

// Authored only: root runs this against its disposable host PostgreSQL harness.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_(?:test_\d+|(?:p277|m26[123])_202610(?:29|30)_\d{2})$/);
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
const prefix = '/stocktake-adjustments';
const tables = ['series', 'series_commands', 'counters', 'previews', 'preview_rows', 'admissions', 'receipts', 'documents', 'document_rows'].map(name => 'stocktake_adjustment_' + name);
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw Error('Adjustment tests must not call providers'); } });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });
const sort = (rows: unknown[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const consent = (p: Row) => ({ client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true });
const raw = (snapshot: Record<string, any[]>, table: string) => snapshot[table].map(x => x.row);

async function series(f: AdjustmentFixture) {
  const result: Record<string, Row> = {};
  for (const kind of ['PW', 'RW']) {
    const body = { client_key: randomUUID(), kind, name: 'Own ' + kind, prefix: kind + randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase() };
    const born = await f.ok(prefix + '/series', 'POST', body, 201);
    assert.equal(born.reused, false); assert.equal(born.series.kind, kind);
    const after = await productCatalogFacts(f.tenant);
    const replay = await f.ok(prefix + '/series', 'POST', body);
    assert.equal(replay.reused, true); assert.deepEqual(replay.series, born.series);
    assert.deepEqual(await productCatalogFacts(f.tenant), after, 'Series exact replay does not allocate a number');
    result[kind] = born.series;
  }
  return result;
}
async function prepare(f: AdjustmentFixture, mode: 'mixed'|'nop'|'shortage'|'surplus' = 'mixed', selected?: Record<string, Row>, blind = false) {
  const s = selected ?? await series(f), source = await countedAdjustmentSource(f, mode, blind);
  const body = { client_key: randomUUID(), source_kind: source.source_kind, stocktake_id: source.id, version: source.version,
    ...(f.on ? { review_id: source.review_id, scope_hash: source.scope_hash } : { review_hash: source.review_hash }),
    ...(mode === 'mixed' || mode === 'surplus' ? { pw_series_id: s.PW.id } : {}),
    ...(mode === 'mixed' || mode === 'shortage' ? { rw_series_id: s.RW.id } : {}),
  };
  const before = await productCatalogFacts(f.tenant);
  const born = await f.ok(prefix + '/previews', 'POST', body, 201), p = born.preview;
  assert.equal(born.reused, false); assert.equal(p.stocktake_id, source.id); assert.equal(p.source_kind, source.source_kind);
  assert.equal(p.can_post, true); assert.equal(p.receipt_id, null);
  const after = await productCatalogFacts(f.tenant);
  for (const name of ['stock', 'stock_locations', 'stock_movements', 'stock_location_movements', 'wms_cost_layers', 'wms_layer_positions', 'wms_layer_movements', 'wms_operations', 'reservations', 'reservation_locations', 'wms_reservation_layers']) assert.deepEqual(after[name], before[name], 'Preview is physically inert: ' + name);
  const replay = await f.ok(prefix + '/previews', 'POST', body);
  assert.equal(replay.reused, true); assert.equal(replay.preview.id, p.id);
  assert.deepEqual(await productCatalogFacts(f.tenant), after, 'Preview exact replay has no extra evidence or audit');
  return { f, source, series: s, body, preview: p, postBody: consent(p) };
}

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} genuine blind source and unpublished manifest require fresh admin, including role loss after preview birth`, async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app, on), 'mixed', undefined, true);
  const sourcePath = prefix + '/sources/' + d.source.source_kind + '/' + d.source.id;
  const protectedPaths = [sourcePath, prefix + '/previews/' + d.preview.id, prefix + '/previews/' + d.preview.id + '/rows'];
  // Prove these are real, nonempty, expected-stock-bearing blind artifacts,
  // then test current permission rather than a synthetic unavailable mock.
  assert.equal((await d.f.ok(sourcePath)).source.can_preview, true);
  assert.equal((await rows(d.f, protectedPaths[2])).length, 6);
  const op = await adjustmentActor(app, d.f.tenant, 'operator@demo.local'), view = await adjustmentActor(app, d.f.tenant, 'viewer@demo.local');
  await pool.query("UPDATE memberships SET role=CASE WHEN user_id=$2 THEN 'operator' ELSE 'viewer' END WHERE tenant_id=$1 AND user_id=ANY($3::uuid[])", [d.f.tenant, op.user, [op.user, view.user]]);
  const baseline = await productCatalogFacts(d.f.tenant);
  for (const a of [op, view]) for (const path of protectedPaths) assert.equal((await a.request(path)).statusCode, 403, 'No expected stock/delta from active blind source to inventory reader');
  try {
    await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [d.f.tenant, d.f.user]);
    for (const path of protectedPaths) assert.equal((await d.f.request(path)).statusCode, 403, 'Existing preview does not retain former admin access');
  } finally { await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [d.f.tenant, d.f.user]); }
  assert.deepEqual(await productCatalogFacts(d.f.tenant), baseline, 'Denied blind reads have no evidence/audit/physical changes');
  const result = await posted(d);
  for (const a of [op, view]) {
    const document = await a.ok(prefix + '/documents/' + result.documents[0].id);
    assert.equal(document.can_read_value, false); assert.equal(document.document.id, result.documents[0].id);
    const page = await a.ok(prefix + '/documents/' + result.documents[0].id + '/rows'); assert(page.data.length > 0);
    const json = JSON.stringify(page); for (const field of ['unit_cost_minor', 'value_minor', 'known_pw_minor', 'known_rw_minor', 'rows_sha256', 'private_scope_nonce']) assert(!json.includes('"' + field + '"'));
  }
});
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function rows(f: AdjustmentFixture, path: string) {
  const result: Row[] = []; let cursor: string | null = null;
  do {
    const page = await f.ok(path + '?limit=1' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)));
    assert(page.data.length <= 1); result.push(...page.data);
    const next = page.meta?.cursor ?? page.next_cursor ?? null;
    assert(next === null || (typeof next === 'string' && next !== cursor)); cursor = next;
    assert(result.length <= 20, 'Bounded fixture EOF must be genuine');
  } while (cursor !== null);
  return result;
}
async function posted(d: Prepared) {
  const result = await d.f.ok(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody, 201);
  assert.equal(result.reused, false); assert.equal(result.receipt.preview_id, d.preview.id);
  assert.equal(result.receipt.scope_hash, d.preview.scope_hash); assert.equal(result.receipt.source.stocktake_id, d.source.id);
  assert.equal(result.receipt.source.state, 'posted'); assert.deepEqual(result.receipt.documents, result.documents);
  return result;
}
async function verifyPhysical(d: Prepared, result: Row, before: Record<string, any[]>) {
  const now = await productCatalogFacts(d.f.tenant);
  const expected = d.source.lines.map(l => ({ line: l, delta: d.source.measured.find(m => m.id === l.id)!.quantity - Number(l.current_quantity) })).filter(x => x.delta !== 0);
  const documents: Row[] = result.documents;
  assert.deepEqual(documents.map(doc => doc.kind).sort(), [...new Set(expected.map(x => x.delta > 0 ? 'PW' : 'RW'))].sort());
  assert.equal(new Set(documents.map(doc => doc.number)).size, documents.length);
  const allRows: Row[] = [];
  for (const doc of documents) {
    assert.equal(doc.receipt_id, result.receipt.id); assert.equal(doc.stocktake_id, d.source.id); assert.equal(doc.source_kind, d.source.source_kind);
    assert.equal(doc.series_id, d.series[doc.kind].id); assert.equal(doc.warehouse.id, d.f.warehouse.id);
    assert.equal(doc.number, `${d.series[doc.kind].prefix}/${doc.year}/${String(doc.sequence).padStart(6, '0')}`);
    const lines = await rows(d.f, prefix + '/documents/' + doc.id + '/rows'); assert.equal(lines.length, doc.row_count);
    for (const row of lines) { assert.equal(row.kind, doc.kind); assert(row.quantity > 0); assert.equal(Math.abs(row.delta), row.quantity); assert.equal(Math.sign(row.delta), doc.kind === 'PW' ? 1 : -1); }
    allRows.push(...lines);
  }
  assert.deepEqual(sort(allRows.map(r => [r.line_id, r.product_id, r.location, r.delta])), sort(expected.map(x => [x.line.id, x.line.product_id, x.line.location, x.delta])));
  for (const p of d.f.products) {
    const stock = raw(now, 'stock').find(s => s.product_id === p.id && s.warehouse_id === d.f.warehouse.id);
    const totalDelta = expected.filter(x => x.line.product_id === p.id).reduce((n, x) => n + x.delta, 0);
    const old = raw(before, 'stock').find(s => s.product_id === p.id && s.warehouse_id === d.f.warehouse.id);
    assert.equal(stock.on_hand, old.on_hand + totalDelta); assert.equal(stock.reserved, old.reserved);
    const binRows = raw(now, 'stock_locations').filter(s => s.product_id === p.id && s.warehouse_id === d.f.warehouse.id);
    assert.equal(binRows.reduce((n, b) => n + b.quantity, 0), stock.on_hand);
    for (const line of d.source.lines.filter(l => l.product_id === p.id)) assert.equal(binRows.find(b => b.location === line.location).quantity, d.source.measured.find(m => m.id === line.id)!.quantity);
  }
  const changed = (table: string) => raw(now, table).filter(r => !raw(before, table).some(b => b.id === r.id));
  assert.deepEqual(sort(changed('stock_location_movements').map(r => [r.product_id, r.location, r.delta, r.kind])), sort(expected.map(x => [x.line.product_id, x.line.location, x.delta, d.f.on ? 'wms_stocktake' : 'stocktake'])));
  // Net-zero per product intentionally has no aggregate movement. PW/RW
  // describe the two existing bin/layer changes, not a second stock operation.
  assert.deepEqual(sort(changed('stock_movements').map(r => [r.product_id, r.delta])), sort(d.f.products.map(p => ({ product_id: p.id, delta: expected.filter(x => x.line.product_id === p.id).reduce((n, x) => n + x.delta, 0) })).filter(x => x.delta !== 0).map(x => [x.product_id, x.delta])));
  for (const table of ['orders', 'order_items', 'payment_entries', 'return_cases', 'return_items', 'documents', 'warehouse_documents', 'warehouse_document_lines', 'reservations', 'reservation_locations', 'wms_reservation_layers', 'wms_issue_fragments', 'wms_return_fragments']) assert.deepEqual(now[table], before[table], 'Adjustment does not rewrite sale, financial or warehouse-document graph: ' + table);
  if (!d.f.on) {
    assert.equal(result.receipt.source.operation_id, null); assert.equal(result.receipt.source.posting_id, null);
    for (const row of allRows) for (const key of ['unit_cost_minor', 'value_minor']) assert(row[key] === undefined || row[key] === null, 'OFF must not fabricate historical cost');
    for (const table of ['wms_cost_layers', 'wms_layer_positions', 'wms_layer_movements', 'wms_operations']) assert.deepEqual(now[table], before[table]);
  } else {
    const op = raw(now, 'wms_operations').find(x => x.id === result.receipt.source.operation_id);
    assert(op); assert.equal(op.kind, 'stocktake_post'); assert.equal(op.stocktake_id, d.source.id); assert.equal(op.stocktake_posting_id, result.receipt.source.posting_id); assert.equal(op.warehouse_document_id, null);
    const moves = changed('wms_layer_movements'); assert.equal(moves.length, expected.length);
    assert.equal(changed('wms_operations').length, 1);
    assert.deepEqual(sort(moves.map(m => [m.product_id, m.location, m.delta])), sort(expected.map(x => [x.line.product_id, x.line.location, x.delta])));
    for (const row of allRows) {
      const move = moves.find(m => m.product_id === row.product_id && m.location === row.location && m.delta === row.delta); assert(move);
      assert.equal(row.layer_id, move.layer_id); assert.equal(row.value_minor, move.value_delta === null ? null : String(BigInt(move.value_delta) < 0n ? -BigInt(move.value_delta) : BigInt(move.value_delta)));
      const layer = raw(now, 'wms_cost_layers').find(l => l.id === move.layer_id); assert(layer); assert.equal(layer.warehouse_document_id, null);
      assert.equal(row.unit_cost_minor, layer.unit_cost_minor === null ? null : String(layer.unit_cost_minor));
      assert.equal(move.value_delta === null ? null : String(move.value_delta), layer.unit_cost_minor === null ? null : String(BigInt(layer.unit_cost_minor) * BigInt(move.delta)));
    }
    const unknownShortage = allRows.filter(r => r.kind === 'RW' && r.product_id === d.f.products[2].id);
    if (unknownShortage.length) assert(unknownShortage.every(r => r.unit_cost_minor === null && r.value_minor === null));
    const zero = allRows.filter(r => r.product_id === d.f.products[0].id); assert(zero.every(r => r.unit_cost_minor === '0' && r.value_minor === '0'));
  }
  return now;
}

for (const mode of ['shortage', 'surplus'] as const) test(`ON genuine ${mode} binds each numbered row to its one existing nonzero SKU movement`, async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app, true), mode), before = await productCatalogFacts(d.f.tenant);
  const result = await posted(d), after = await verifyPhysical(d, result, before);
  assert.equal(result.documents.length, 1); assert.equal(result.documents[0].kind, mode === 'shortage' ? 'RW' : 'PW');
  const documentRows = await rows(d.f, prefix + '/documents/' + result.documents[0].id + '/rows');
  assert.equal(documentRows.length, 3);
  const movements = raw(after, 'stock_movements').filter(x => !raw(before, 'stock_movements').some(y => y.id === x.id));
  assert.equal(movements.length, 3);
  for (const row of documentRows) {
    assert.match(row.stock_movement_id, /^[a-f0-9-]{36}$/);
    const actual = movements.find(x => x.id === row.stock_movement_id); assert(actual);
    assert.equal(actual.tenant_id, d.f.tenant); assert.equal(actual.warehouse_id, d.f.warehouse.id);
    assert.equal(actual.product_id, row.product_id); assert.equal(actual.delta, mode === 'shortage' ? -1 : 1);
    assert.equal(actual.kind, 'wms_stocktake'); assert.equal(actual.note, 'Inwentaryzacja WMS ' + d.source.id);
  }
  const replay = await d.f.ok(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody);
  assert.equal(replay.reused, true); assert.deepEqual(replay.documents, result.documents);
  assert.deepEqual(await productCatalogFacts(d.f.tenant), after, 'Nonzero exact replay allocates no extra movement or number');
});

test('ON preview can_post reflects compound purchasing scopes while exact inventory-only reads expose no private cost hash', async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app, true));
  const limited = await d.f.ok('/developer/keys', 'POST', { name: 'Own inventory writer without purchasing', scopes: ['inventory:read', 'inventory:write'] }, 201);
  const before = await productCatalogFacts(d.f.tenant);
  const read = await d.f.ok(prefix + '/previews/' + d.preview.id, 'GET', undefined, 200, limited);
  assert.equal(read.can_read_value, false); assert.equal(read.can_write, false); assert.equal(read.preview.can_post, false);
  for (const key of ['rows_sha256', 'unit_cost_minor', 'known_pw_minor', 'nonce']) assert(!JSON.stringify(read).includes('"' + key + '"'));
  assert.equal((await d.f.request(prefix + '/previews', 'POST', { ...d.body, client_key: randomUUID() }, limited)).statusCode, 403);
  assert.equal((await d.f.request(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody, limited)).statusCode, 403);
  assert.deepEqual(await productCatalogFacts(d.f.tenant), before);
});

test('a real private current-TX prepare without core/receipt cannot commit an orphan admission or consume counters', async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app)), before = await productCatalogFacts(d.f.tenant), c = await pool.connect(); let prepared = false;
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [d.f.tenant]);
    const eid = randomUUID();
    assert.equal((await c.query('SELECT public.stocktake_adjustment_prepare($1,$2,$3,$4,NULL::uuid) id', [d.preview.id, eid, JSON.stringify(d.postBody), d.f.user])).rows[0].id, eid);
    prepared = true;
    await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'), (e: any) => e.code === '23514' && e.message === 'Brak pełnej zgody PW/RW');
  } finally { await c.query('ROLLBACK'); c.release(); }
  assert.equal(prepared, true); assert.deepEqual(await productCatalogFacts(d.f.tenant), before);
});

for (const on of [false, true]) {
  test(`${on ? 'ON' : 'OFF'} genuine mixed net-zero count posts PW/RW once with exact bin/layer provenance, replay and read purity`, async () => {
    const d = await prepare(await stocktakeAdjustmentFixture(app, on)), before = await productCatalogFacts(d.f.tenant);
    const result = await posted(d), after = await verifyPhysical(d, result, before);
    assert.equal(result.documents.length, 2);
    const retry = await d.f.ok(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody);
    assert.equal(retry.reused, true); assert.deepEqual(retry.receipt, result.receipt); assert.deepEqual(retry.documents, result.documents);
    await d.f.ok(prefix + '/receipts/' + result.receipt.id); await d.f.ok(prefix + '/previews/' + d.preview.id);
    for (const document of result.documents) await d.f.ok(prefix + '/documents/' + document.id);
    assert.deepEqual(await productCatalogFacts(d.f.tenant), after, 'Replay and all receipt/document GETs preserve every own row, counter and audit');
    const changed = await d.f.request(prefix + '/previews/' + d.preview.id + '/post', 'POST', { ...d.postBody, scope_hash: '0'.repeat(64) }); assert.equal(changed.statusCode, 409);
    assert.equal((await d.f.request(prefix + '/previews/' + d.preview.id + '/post', 'POST', { ...d.postBody, confirmed: false })).statusCode, 422);
    assert.equal((await d.f.request(prefix + '/previews/' + d.preview.id + '/post', 'POST', { ...d.postBody, client_key: randomUUID() })).statusCode, 409, 'A new key is not historical replay of an already numbered source');
    assert.equal((await d.f.request(prefix + '/previews', 'POST', { ...d.body, version: String(BigInt(d.body.version) + 1n) })).statusCode, 409, 'The same preview key cannot change canonical source version');
    assert.deepEqual(await productCatalogFacts(d.f.tenant), after);
    const sibling = await adjustmentActor(app, d.f.tenant, 'operator@demo.local'); assert.notEqual(sibling.user, d.f.user);
    const afterSibling = await productCatalogFacts(d.f.tenant);
    assert.equal((await sibling.request(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody)).statusCode, 409);
    assert.deepEqual(await productCatalogFacts(d.f.tenant), afterSibling);
  });
  test(`${on ? 'ON' : 'OFF'} NOP posts no document, no sequence/counter and no physical operation`, async () => {
    const d = await prepare(await stocktakeAdjustmentFixture(app, on), 'nop'), before = await productCatalogFacts(d.f.tenant), result = await posted(d);
    assert.deepEqual(result.documents, []); assert.deepEqual(result.receipt.documents, []);
    const after = await productCatalogFacts(d.f.tenant);
    for (const name of ['stock', 'stock_locations', 'stock_movements', 'stock_location_movements', 'wms_cost_layers', 'wms_layer_positions', 'wms_layer_movements', 'stocktake_adjustment_counters', 'stocktake_adjustment_documents', 'stocktake_adjustment_document_rows']) assert.deepEqual(after[name], before[name], 'NOP never assigns a number or physical delta: ' + name);
    // The existing ON core may retain its genuine NOP operation receipt. It
    // still has no layer/bin/stock movement or numbered adjustment document.
    const replay = await d.f.ok(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody); assert.equal(replay.reused, true);
    assert.deepEqual(await productCatalogFacts(d.f.tenant), after);
  });
  test(`${on ? 'ON' : 'OFF'} legacy posting after a new preview cannot create delayed PW/RW history or consume a number`, async () => {
    const d = await prepare(await stocktakeAdjustmentFixture(app, on));
    const path = (on ? '/wms-lots/stocktakes/' : '/stocktakes/') + d.source.id + '/post';
    const body = on ? { client_key: randomUUID(), version: d.source.version, review_id: d.source.review_id, scope_hash: d.source.scope_hash, confirmed: true } : { version: d.source.version, confirmed: true };
    await d.f.ok(path, 'POST', body, on ? 201 : 200);
    const before = await productCatalogFacts(d.f.tenant);
    assert.equal((await d.f.request(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody)).statusCode, 409);
    assert.deepEqual(await productCatalogFacts(d.f.tenant), before, 'No delayed evidence backfill after genuine legacy physical posting');
    assert.deepEqual(raw(before, 'stocktake_adjustment_documents'), []); assert.deepEqual(raw(before, 'stocktake_adjustment_counters'), []);
  });
}

test('concurrent own posts serialize one source receipt and two numbered documents; distinct sources share counters without duplicate numbers', async () => {
  const f = await stocktakeAdjustmentFixture(app), selected = await series(f), first = await prepare(f, 'mixed', selected);
  const path = prefix + '/previews/' + first.preview.id + '/post';
  const pair = await Promise.all([f.request(path, 'POST', first.postBody), f.request(path, 'POST', first.postBody)]);
  assert.deepEqual(pair.map(r => r.statusCode).sort(), [200, 201]);
  const one = pair.find(r => r.statusCode === 201)!.json(); assert.equal(pair.find(r => r.statusCode === 200)!.json().receipt.id, one.receipt.id);
  const second = await prepare(f, 'mixed', selected);
  const beforeWrongParent = await productCatalogFacts(f.tenant);
  assert.equal((await f.request(prefix + '/previews/' + second.preview.id + '/post', 'POST', first.postBody)).statusCode, 409, 'A known post key cannot be transferred to another own source preview');
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeWrongParent);
  const otherWarehouse = await stocktakeAdjustmentFixture(app, false, f.tenant), third = await prepare(otherWarehouse, 'mixed', selected);
  const [done, doneOther] = await Promise.all([posted(second), posted(third)]);
  for (const kind of ['PW', 'RW']) {
    const old = one.documents.find((x: Row) => x.kind === kind), next = done.documents.find((x: Row) => x.kind === kind), nextOther = doneOther.documents.find((x: Row) => x.kind === kind);
    assert.deepEqual([BigInt(next.sequence), BigInt(nextOther.sequence)].sort((a, b) => a < b ? -1 : 1), [BigInt(old.sequence) + 1n, BigInt(old.sequence) + 2n]);
    assert.equal(new Set([old.number, next.number, nextOther.number]).size, 3);
  }
  const after = await productCatalogFacts(f.tenant); assert.equal(raw(after, 'stocktake_adjustment_receipts').length, 3); assert.equal(raw(after, 'stocktake_adjustment_documents').length, 6);
});

test('foreign source/series/preview/document access and key cost scope remain denied without any business delta', async () => {
  const own = await prepare(await stocktakeAdjustmentFixture(app, true)), foreign = await prepare(await stocktakeAdjustmentFixture(app)), result = await posted(own);
  const beforeOwn = await productCatalogFacts(own.f.tenant), beforeForeign = await productCatalogFacts(foreign.f.tenant);
  for (const path of [prefix + '/previews/' + own.preview.id, prefix + '/receipts/' + result.receipt.id, prefix + '/documents/' + result.documents[0].id]) assert.equal((await foreign.f.request(path)).statusCode, 404);
  assert.equal((await foreign.f.request(prefix + '/previews', 'POST', { ...foreign.body, client_key: randomUUID(), stocktake_id: own.source.id })).statusCode, 404);
  assert.equal((await foreign.f.request(prefix + '/previews', 'POST', { ...foreign.body, client_key: randomUUID(), pw_series_id: own.series.PW.id })).statusCode, 404);
  const key = await own.f.ok('/developer/keys', 'POST', { name: 'Quantity only adjustment read', scopes: ['inventory:read'] }, 201);
  const read = await own.f.request(prefix + '/documents/' + result.documents[0].id, 'GET', undefined, key);
  assert.equal(read.statusCode, 200); assert.equal(read.json().can_read_value, false);
  const body = JSON.stringify(read.json()); for (const field of ['unit_cost_minor', 'value_minor', 'known_pw_minor', 'known_rw_minor', 'rows_sha256', 'private_scope_nonce']) assert(!body.includes('"' + field + '"'), 'Private value/frame omitted: ' + field);
  const keyBaseline = await productCatalogFacts(own.f.tenant);
  assert.equal((await own.f.request(prefix + '/previews/' + own.preview.id + '/post', 'POST', own.postBody, key)).statusCode, 403);
  assert.deepEqual(await productCatalogFacts(own.f.tenant), keyBaseline);
  // Key birth is intentional metadata. It cannot modify the foreign tenant.
  assert.deepEqual(await productCatalogFacts(foreign.f.tenant), beforeForeign);
  for (const table of ['stock', 'stock_locations', ...tables]) assert.deepEqual((await productCatalogFacts(own.f.tenant))[table], beforeOwn[table]);
});

async function observeWait(held: PoolClient, pending: Promise<any>, kind: 'series' | 'stock' = 'series') {
  const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  void pending.catch(() => undefined); const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const active = (await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [pid])).rows;
    // A held stock row is reached by the real core's stock SELECT, not by the
    // outer adjustment SQL call. Both must actually be blocked by this PID.
    if (active.some(r => kind === 'series' ? /stocktake_adjustment/i.test(r.query) : /\b(?:from|join)\s+(?:public\.)?stock\b/i.test(r.query))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Actual posting must reach the deliberately held series/physical lock');
}
for (const blocker of ['series', 'stock'] as const) test(`fresh role withdrawal after genuine held ${blocker} wait rolls back stock, documents, counter and audit`, async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app, true)), baseline = await productCatalogFacts(d.f.tenant), held = await pool.connect(); let pending: Promise<any> | undefined;
  try {
    await held.query('BEGIN');
    if (blocker === 'series') await held.query('SELECT id FROM stocktake_adjustment_series WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [d.f.tenant, d.series.PW.id]);
    else await held.query('SELECT product_id FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 FOR UPDATE', [d.f.tenant, d.f.warehouse.id, d.f.products[0].id]);
    pending = d.f.request(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody);
    await observeWait(held, pending, blocker);
    await held.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [d.f.tenant, d.f.user]);
    await held.query('COMMIT'); const response = await pending; assert.equal(response.statusCode, 403);
  } finally {
    await held.query('ROLLBACK').catch(() => undefined); held.release(); if (pending) await pending.catch(() => undefined);
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [d.f.tenant, d.f.user]);
  }
  assert.deepEqual(await productCatalogFacts(d.f.tenant), baseline, 'All business rows/counters/audit rolled back after real wait and role withdrawal');
});

test('a genuine compound WMS key expires during a held series wait and cannot commit physical post or a number', async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app, true));
  const key = await d.f.ok('/developer/keys', 'POST', { name: 'Own full adjustment writer', scopes: ['inventory:read', 'inventory:write', 'purchasing:read', 'purchasing:write'] }, 201);
  const p = (await d.f.ok(prefix + '/previews', 'POST', { ...d.body, client_key: randomUUID() }, 201, key)).preview;
  const body = consent(p), baseline = await productCatalogFacts(d.f.tenant);
  const original = (await pool.query('SELECT expires_at::text,revoked_at::text,scopes FROM api_keys WHERE tenant_id=$1 AND id=$2', [d.f.tenant, key.id])).rows[0]; assert(original);
  const held = await pool.connect(); let pending: Promise<any> | undefined;
  try {
    await held.query('BEGIN'); await held.query('SELECT id FROM stocktake_adjustment_series WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [d.f.tenant, d.series.PW.id]);
    pending = d.f.request(prefix + '/previews/' + p.id + '/post', 'POST', body, key); await observeWait(held, pending);
    await held.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [d.f.tenant, key.id]);
    await held.query('COMMIT'); assert.equal((await pending).statusCode, 401);
  } finally {
    await held.query('ROLLBACK').catch(() => undefined); held.release(); if (pending) await pending.catch(() => undefined);
    await pool.query('UPDATE api_keys SET expires_at=$3::timestamptz,revoked_at=$4::timestamptz,scopes=$5 WHERE tenant_id=$1 AND id=$2', [d.f.tenant, key.id, original.expires_at, original.revoked_at, original.scopes]);
  }
  assert.deepEqual(await productCatalogFacts(d.f.tenant), baseline, 'Late expiry rolls back all physical/documents/number/audit; exact control-row repair only');
});

test('failure of the second numbered document rolls back the already applied core post and first document/counter', async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app, true)), baseline = await productCatalogFacts(d.f.tenant), suffix = randomUUID().replaceAll('-', ''), fn = 'test_adjustment_failure_' + suffix, marker = 'test_adjustment_marker_' + suffix;
  // A real database INSERT failure, deliberately restricted to this own tenant
  // and RW document, is observed after physical core/PW/counter in the same TX.
  // A disposable observer sequence is nontransactional: an earlier unrelated
  // refusal cannot falsely satisfy this oracle. It is not business numbering.
  await pool.query(`CREATE SEQUENCE public.${marker}`);
  try {
    await pool.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tenant_id='${d.f.tenant}'::uuid AND NEW.kind='RW' THEN
        IF (SELECT count(*) FROM public.stocktake_adjustment_documents WHERE tenant_id=NEW.tenant_id AND receipt_id=NEW.receipt_id AND kind='PW')<>1
          OR (SELECT count(*) FROM public.stocktake_adjustment_document_rows x JOIN public.stocktake_adjustment_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE d.tenant_id=NEW.tenant_id AND d.receipt_id=NEW.receipt_id AND d.kind='PW')<>3
          OR (SELECT state FROM public.wms_stocktakes WHERE tenant_id=NEW.tenant_id AND id='${d.source.id}'::uuid) IS DISTINCT FROM 'posted'
          OR (SELECT count(*) FROM public.wms_layer_movements m JOIN public.wms_operations o ON(o.tenant_id,o.id)=(m.tenant_id,m.operation_id) WHERE o.tenant_id=NEW.tenant_id AND o.stocktake_id='${d.source.id}'::uuid)<>6
          OR (SELECT sequence FROM public.stocktake_adjustment_counters WHERE tenant_id=NEW.tenant_id AND series_id='${d.series.PW.id}'::uuid AND year=NEW.year) IS DISTINCT FROM 1::bigint
        THEN RAISE EXCEPTION 'Rollback observer did not reach completed core and first document' USING ERRCODE='23514'; END IF;
        PERFORM nextval('public.${marker}'::regclass);
        RAISE EXCEPTION 'Controlled final adjustment document failure' USING ERRCODE='23514';
      END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON public.stocktake_adjustment_documents FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    const response = await d.f.request(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody);
    assert.equal(response.statusCode, 409);
    assert.deepEqual((await pool.query(`SELECT last_value::text,is_called FROM public.${marker}`)).rows[0], { last_value: '1', is_called: true }, 'A generic prepare/manifest failure cannot pretend that the last document failed');
    assert.deepEqual(await productCatalogFacts(d.f.tenant), baseline);
  } finally { await pool.query(`DROP TRIGGER IF EXISTS ${fn} ON public.stocktake_adjustment_documents`); await pool.query(`DROP FUNCTION IF EXISTS public.${fn}()`); await pool.query(`DROP SEQUENCE public.${marker}`); }
  await posted(d);
});

test('raw dyna_app cannot forge series/document/source receipts or call private issuer; existing numbered evidence denies UPDATE and DELETE', async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app, true)), result = await posted(d), baseline = await productCatalogFacts(d.f.tenant);
  const c = await pool.connect();
  try {
    for (const sql of [
      'SELECT * FROM public.stocktake_adjustment_admissions',
      `INSERT INTO public.stocktake_adjustment_series SELECT * FROM public.stocktake_adjustment_series WHERE false`,
      `INSERT INTO public.stocktake_adjustment_receipts SELECT * FROM public.stocktake_adjustment_receipts WHERE false`,
      `INSERT INTO public.stocktake_adjustment_documents SELECT * FROM public.stocktake_adjustment_documents WHERE false`,
      `SELECT public.stocktake_adjustment_prepare('${d.preview.id}'::uuid,'${randomUUID()}'::uuid,'${JSON.stringify(d.postBody)}'::jsonb,'${d.f.user}'::uuid,NULL::uuid)`,
    ]) {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE dyna_app'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [d.f.tenant]);
        await assert.rejects(c.query(sql), (e: any) => e.code === '42501', 'No private raw INSERT/SELECT/issuer EXEC grant');
      } finally { await c.query('ROLLBACK'); }
    }
    // Owner corruption is tested separately from lack of app privileges. A
    // real existing document must itself remain immutable under its trigger.
    for (const statement of [
      'UPDATE public.stocktake_adjustment_documents SET number=number||\'X\' WHERE tenant_id=$1 AND id=$2',
      'DELETE FROM public.stocktake_adjustment_documents WHERE tenant_id=$1 AND id=$2',
      'UPDATE public.stocktake_adjustment_document_rows SET payload=payload||\'{"quantity":999}\'::jsonb WHERE tenant_id=$1 AND document_id=$2',
      'DELETE FROM public.stocktake_adjustment_document_rows WHERE tenant_id=$1 AND document_id=$2',
    ]) {
      await c.query('BEGIN');
      try { await assert.rejects(c.query(statement, [d.f.tenant, result.documents[0].id]), (e: any) => e.code === '23514' && /niezmienny/i.test(e.message)); }
      finally { await c.query('ROLLBACK'); }
    }
  } finally { c.release(); }
  assert.deepEqual(await productCatalogFacts(d.f.tenant), baseline);
});

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} genuine post and explicit deferred flush seal the source journal against a later extra fragment`, async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app, on)), before = await productCatalogFacts(d.f.tenant); let reached = false;
  await assert.rejects(tenantTx(d.f.tenant, async c => {
    const result = await postStocktakeAdjustmentInTx(c, d.f.actor, d.preview.id, d.postBody);
    assert.equal(result.documents.length, 2); assert.equal(result.receipt.source.state, 'posted');
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('RESET ROLE');
    const proof = (await c.query('SELECT sealed,txid=pg_current_xact_id() current_tx FROM public.stocktake_adjustment_admissions WHERE(tenant_id,id)=($1,$2)', [d.f.tenant, result.receipt.id])).rows[0];
    assert.deepEqual(proof, { sealed: true, current_tx: true });
    const actual = (await c.query('SELECT count(*)::int n FROM public.stocktake_adjustment_document_rows x JOIN public.stocktake_adjustment_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=($1,$2)', [d.f.tenant, result.receipt.id])).rows[0]; assert.equal(actual.n, 6);
    await c.query('SET LOCAL ROLE dyna_app'); reached = true;
    // An extra journal only (no matching stock delta) after the actual finish
    // and flush must fail immediately. A deferred trigger already fired is
    // not evidence that this later mutation will be examined at COMMIT.
    await c.query(`INSERT INTO public.stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind,operation_id,note,stocktake_id)
      VALUES($1,$2,$3,'A-01',1,$4,$5,'Extra fragment after real PW/RW finish',$6)`,
    [d.f.tenant, d.f.warehouse.id, d.f.products[0].id, on ? 'wms_stocktake' : 'stocktake', on ? result.receipt.source.operation_id : d.source.id, on ? null : d.source.id]);
    // A posting transaction takes the tenant-wide WMS admission before it starts, as the route's own transaction does
    // (server/stocktake-adjustments.ts: writing -> wmsAdmission 'serial'; rule of 250).
  }, { wmsAdmission: 'serial' }), (e: any) => e.code === '23514' && e.message === 'Źródło dokumentu PW/RW jest zapieczętowane');
  assert.equal(reached, true, 'The hostile mutation must follow real physical core and sealed documents');
  assert.deepEqual(await productCatalogFacts(d.f.tenant), before, 'The complete real transaction rolls back after a late extra fragment');
});

test('torn149 denies startup and the already built endpoint before a new write, then exact metadata repair restores read purity', async () => {
  const d = await prepare(await stocktakeAdjustmentFixture(app)), before = await productCatalogFacts(d.f.tenant), c = await pool.connect();
  const name = 'stocktake_adjustment_complete';
  try {
    await c.query(`ALTER TABLE public.stocktake_adjustment_receipts DISABLE TRIGGER ${name}`);
    try {
      await assert.rejects(buildApp(), (e: any) => e.status === 503);
      assert.equal((await d.f.request(prefix + '/options')).statusCode, 503);
      assert.equal((await d.f.request(prefix + '/previews/' + d.preview.id + '/post', 'POST', d.postBody)).statusCode, 503);
      assert.deepEqual(await productCatalogFacts(d.f.tenant), before, 'No physical/counter/evidence mutation from a torn module');
    } finally { await c.query(`ALTER TABLE public.stocktake_adjustment_receipts ENABLE TRIGGER ${name}`); }
  } finally { c.release(); }
  await d.f.ok(prefix + '/previews/' + d.preview.id);
  assert.deepEqual(await productCatalogFacts(d.f.tenant), before);
});
