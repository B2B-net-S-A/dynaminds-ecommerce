import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlActor, CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import { b2bDropshipReturnReceiveInput } from '../server/b2b-dropshipping-returns-schema';
import { bootstrap151169, install152169, facts169, raw169, consent169, physicalExact169, type Facts, type Row } from './catalog-stock-control169-fixture';
import { createReturnHarness, freshReturnFixture, requestRetail, sourcePreview, submitReturn,
  supplierCase, receiveBody, returnBase } from './b2b-dropshipping-returns-fixture';
import { createMixedHarness, freshMixedFixture, requestMixedReturn, localBody, localReceive,
  mixedStock, prefix } from './b2b-return-local-origins-fixture';

// SOURCE_AUTHORED_NOT_RUN. Root runs this file alone in an empty numeric scratch
// database. Both provider transports are existing controlled fixture transports;
// physical fulfillment/returns use the actual public callers and parent proofs.
let supplierHarness: Awaited<ReturnType<typeof createReturnHarness>>;
let localHarness: Awaited<ReturnType<typeof createMixedHarness>>;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  // The two markers have no source/WH/product/reason columns: SQL099 marks
  // the real aggregate UPDATE; SQL100 separately marks the actual return
  // journal INSERT. Assert the installed transition-table wiring and later
  // prove those exact source rows, rather than inventing marker provenance.
  const markerTriggers = (await pool.query(`SELECT c.relname table_name,t.tgname trigger_name,
    p.proname function_name,t.tgtype::integer trigger_type,t.tgenabled enabled,
    t.tgnewtable new_rows,t.tgoldtable old_rows
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
      AND (c.relname,t.tgname) IN (('stock','purchasing_source_update'),('stock_movements','replenishment_forecast_insert'))
    ORDER BY c.relname,t.tgname`)).rows;
  assert.deepEqual(markerTriggers, [
    { table_name: 'stock', trigger_name: 'purchasing_source_update', function_name: 'purchasing_source_changed',
      trigger_type: 16, enabled: 'O', new_rows: 'purchasing_new_rows', old_rows: 'purchasing_old_rows' },
    { table_name: 'stock_movements', trigger_name: 'replenishment_forecast_insert', function_name: 'replenishment_forecast_changed',
      trigger_type: 4, enabled: 'O', new_rows: 'forecast_new_rows', old_rows: null },
  ]);
  supplierHarness = await createReturnHarness();
  localHarness = await createMixedHarness();
});
after(async () => {
  try { await supplierHarness?.app.close(); await localHarness?.app.close(); }
  finally { await pool.end(); }
});

const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };
const key = (row: Row) => JSON.stringify(row);
function appended(beforeRows: Facts, afterRows: Facts, table: string): Row[] {
  const after = new Set(raw169(afterRows, table).map(key));
  for (const row of raw169(beforeRows, table)) assert(after.has(key(row)), 'Old append-only row retained: ' + table);
  const old = new Set(raw169(beforeRows, table).map(key));
  return raw169(afterRows, table).filter(r => !old.has(key(r)));
}
type Side = { tenant: string; user: string; warehouse: string };
async function activate(side: Side, productId: string) {
  const product = one((await pool.query('SELECT catalog_id FROM products WHERE tenant_id=$1 AND id=$2', [side.tenant, productId])).rows);
  const actor: CatalogStockControlActor = { tenantId: side.tenant, userId: side.user, role: 'admin', source: 'manual' };
  const context = { writersAvailable: true }, beforeRows = await facts169();
  const { source } = await sourceCatalogStockControl(actor, product.catalog_id, context);
  assert.equal(source.ready, true, JSON.stringify(source.blockers));
  assert.deepEqual(source.blockers, []);
  const { preview } = await previewCatalogStockControl(actor, product.catalog_id, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version, policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.series.version })),
  }, context);
  assert.equal(preview.ready, true);
  const { operation } = await commitCatalogStockControl(actor, preview.id, consent169(preview), context);
  assert.equal(operation.after.strict, true);
  physicalExact169(beforeRows, await facts169());
  return product.catalog_id as string;
}

type Scope = { side: Side; product_id: string; order_id: string; return_id: string; item_id: string; refund: number };
function without(row: Row, fields: string[]) {
  return Object.fromEntries(Object.entries(row).filter(([name]) => !fields.includes(name)));
}
function changedOnly(beforeRows: Facts, afterRows: Facts, table: string, select: (r: Row) => boolean, fields: string[]) {
  const old = raw169(beforeRows, table), now = raw169(afterRows, table);
  assert.equal(now.length, old.length, 'No additional/removal mutable rows: ' + table);
  assert.deepEqual(now.filter(r => !select(r)), old.filter(r => !select(r)), 'Outside exact mutable scope: ' + table);
  const a = one(old.filter(select)), b = one(now.filter(select));
  assert.deepEqual(without(b, fields), without(a, fields), 'Other fields retained: ' + table);
  return { before: a, after: b };
}

/** Full global row comparison with explicit row-level mutation/addition proofs. */
function graph(beforeRows: Facts, afterRows: Facts, scope: Scope, protocol: 'rma' | 'dropship_supplier') {
  const { side, product_id, order_id, return_id, item_id, refund } = scope;
  const own = (r: Row) => r.tenant_id === side.tenant;
  const additions = new Map<string, number>([
    ['catalog_stock_return_admissions', 1], ['catalog_stock_return_receipts', 1],
    ['catalog_stock_return_documents', 1], ['catalog_stock_return_rows', 1],
    ['catalog_stock_return_stock_maps', 1], ['catalog_stock_return_item_maps', 1],
    ['catalog_stock_control_series', 1],
    ['catalog_stock_control_effect_admissions', 1], ['catalog_stock_control_effects', 1],
    ['catalog_stock_control_effect_journals', 2], ['stock_movements', 1], ['stock_location_movements', 1],
    ['purchasing_stock_changes', 2], ['order_events', 1],
    ['audit_events', protocol === 'dropship_supplier' ? 2 : 1],
    [protocol === 'dropship_supplier' ? 'b2b_dropship_return_proofs' : 'b2b_return_local_proofs', 1],
  ]);
  if (protocol === 'dropship_supplier') additions.set('b2b_dropship_return_actions', 1);
  const mutable = new Set(['orders', 'return_cases', 'return_items', 'stock', 'stock_locations', 'catalog_stock_control_counters']);
  assert.deepEqual(Object.keys(afterRows), Object.keys(beforeRows));
  for (const table of Object.keys(beforeRows)) {
    if (additions.has(table)) {
      const rows = appended(beforeRows, afterRows, table);
      assert.equal(rows.length, additions.get(table), 'Exact actual append count: ' + table);
      assert(rows.every(own), 'No foreign/global append: ' + table);
    } else if (!mutable.has(table)) assert.deepEqual(afterRows[table], beforeRows[table], 'Literal preservation of all other rows/sessions: ' + table);
  }
  const orders = changedOnly(beforeRows, afterRows, 'orders', r => own(r) && r.id === order_id, ['updated_at', 'version']);
  assert.equal(BigInt(orders.after.version), BigInt(orders.before.version) + 1n);
  const rma = changedOnly(beforeRows, afterRows, 'return_cases', r => own(r) && r.id === return_id,
    ['state', 'receipt', 'refunded_shipping', 'refund_amount', 'decision_note', 'received_at', 'receipt_sequence', 'version', 'updated_at']);
  assert.equal(rma.before.state, 'requested'); assert.equal(rma.after.state, 'refund_pending');
  assert.equal(rma.after.refund_amount, refund); assert.equal(rma.after.refunded_shipping, 0);
  assert.equal(BigInt(rma.after.version), BigInt(rma.before.version) + 1n); assert(rma.after.received_at);
  const ri = changedOnly(beforeRows, afterRows, 'return_items', r => own(r) && r.return_id === return_id && r.item_id === item_id,
    ['accepted', 'restocked', 'refund_amount']);
  assert.equal(ri.after.accepted, 1); assert.equal(ri.after.restocked, 1); assert.equal(ri.after.refund_amount, refund);
  const stock = changedOnly(beforeRows, afterRows, 'stock', r => own(r) && r.warehouse_id === side.warehouse && r.product_id === product_id,
    ['on_hand', 'available', 'version']);
  assert.equal(stock.after.on_hand, stock.before.on_hand + 1); assert.equal(stock.after.available, stock.before.available + 1);
  assert.equal(stock.after.reserved, stock.before.reserved); assert.equal(BigInt(stock.after.version), BigInt(stock.before.version) + 1n);

  const stockMovement = one(appended(beforeRows, afterRows, 'stock_movements'));
  assert.equal(stockMovement.tenant_id, side.tenant); assert.equal(stockMovement.product_id, product_id);
  assert.equal(stockMovement.warehouse_id, side.warehouse); assert.equal(stockMovement.order_id, order_id);
  assert.equal(stockMovement.return_id, return_id); assert.equal(stockMovement.kind, 'return'); assert.equal(stockMovement.delta, 1);
  const markers = appended(beforeRows, afterRows, 'purchasing_stock_changes');
  assert.equal(markers.length, 2);
  assert(markers.every(m => m.tenant_id === side.tenant));
  assert.deepEqual(markers.map(m => Object.keys(m).sort()), [['id', 'tenant_id'], ['id', 'tenant_id']],
    'Marker schema is tenant/id only; exact WH/product/reason is proved by aggregate delta and return journal');
  assert.notEqual(markers[0].id, markers[1].id);
  const binMovement = one(appended(beforeRows, afterRows, 'stock_location_movements'));
  assert.equal(binMovement.tenant_id, side.tenant); assert.equal(binMovement.product_id, product_id);
  assert.equal(binMovement.warehouse_id, side.warehouse); assert.equal(binMovement.location, 'ZWROT');
  assert.equal(binMovement.kind, 'stock_in'); assert.equal(binMovement.delta, 1);
  const isBin = (r: Row) => own(r) && r.warehouse_id === side.warehouse && r.product_id === product_id && r.location === 'ZWROT';
  assert.deepEqual(raw169(afterRows, 'stock_locations').filter(r => !isBin(r)), raw169(beforeRows, 'stock_locations').filter(r => !isBin(r)));
  const oldBin = raw169(beforeRows, 'stock_locations').filter(isBin);
  const bin = one(raw169(afterRows, 'stock_locations').filter(isBin));
  assert.equal(bin.quantity, (oldBin[0]?.quantity ?? 0) + 1);
  if (oldBin.length) assert.deepEqual(without(bin, ['quantity']), without(one(oldBin), ['quantity']));

  const admission = one(appended(beforeRows, afterRows, 'catalog_stock_return_admissions'));
  const receipt = one(appended(beforeRows, afterRows, 'catalog_stock_return_receipts'));
  assert.equal(admission.protocol, protocol); assert.equal(admission.actor_id, side.user); assert.equal(admission.api_key_id, null);
  assert.equal(admission.return_id, return_id); assert.equal(admission.order_id, order_id); assert.equal(admission.sealed, true);
  assert.equal(receipt.id, admission.id); assert.equal(receipt.return_id, return_id); assert.equal(receipt.order_id, order_id);
  assert.equal(receipt.wms_operation_id, null); assert.equal(receipt.assistant_receipt_id, null); assert.equal(receipt.exchange_id, null);
  assert.equal(receipt.parcel_receipt_return_id, null);
  assert.deepEqual(receipt.proof.stock_movement_ids, [stockMovement.id]);
  assert.deepEqual(receipt.proof.location_movement_ids, [binMovement.id]); assert.deepEqual(receipt.proof.layer_movement_ids, []);
  const doc = one(appended(beforeRows, afterRows, 'catalog_stock_return_documents'));
  assert.equal(doc.receipt_id, receipt.id); assert.equal(doc.return_id, return_id); assert.equal(doc.warehouse_id, side.warehouse);
  assert.equal(doc.payload.kind, 'PZ'); assert.equal(doc.payload.row_count, 1); assert.equal(doc.payload.quantity, '1');
  assert.equal(doc.payload.wms_enabled, false); assert.equal(String(doc.sequence), '1');
  const series = one(appended(beforeRows, afterRows, 'catalog_stock_control_series'));
  assert.equal(series.id, doc.series_id); assert.equal(String(series.version), '1');
  assert.equal(series.kind, 'PZ'); assert.equal(series.warehouse_id, side.warehouse);
  assert.equal(doc.number, `${series.prefix}/${doc.year}/000001`);
  const counters = appended(beforeRows, afterRows, 'catalog_stock_control_counters');
  assert.equal(counters.length, 1); assert.equal(counters[0].tenant_id, side.tenant);
  assert.equal(counters[0].series_id, series.id); assert.equal(counters[0].year, doc.year); assert.equal(String(counters[0].value), '1');
  const row = one(appended(beforeRows, afterRows, 'catalog_stock_return_rows'));
  assert.equal(row.document_id, doc.id); assert.equal(row.ordinal, 0); assert.equal(row.bin_movement_id, binMovement.id);
  assert.equal(row.product_id, product_id); assert.equal(row.warehouse_id, side.warehouse); assert.equal(row.location, 'ZWROT'); assert.equal(row.quantity, 1);
  for (const field of ['unit_cost_minor', 'value_minor', 'currency']) assert.equal(Object.hasOwn(row.payload, field), false, 'OFF does not invent cost');
  const sm = one(appended(beforeRows, afterRows, 'catalog_stock_return_stock_maps'));
  assert.equal(sm.row_id, row.id); assert.equal(sm.stock_movement_id, stockMovement.id); assert.equal(sm.quantity, 1);
  const im = one(appended(beforeRows, afterRows, 'catalog_stock_return_item_maps'));
  assert.equal(im.row_id, row.id); assert.equal(im.return_id, return_id); assert.equal(im.item_id, item_id);
  assert.equal(im.arrival_id, null); assert.equal(im.quantity, 1);
  const effect = one(appended(beforeRows, afterRows, 'catalog_stock_control_effects'));
  assert.equal(effect.admission_id, admission.id); assert.deepEqual(effect.proof.stock_movement_ids, [stockMovement.id]);
  assert.deepEqual(effect.proof.location_movement_ids, [binMovement.id]); assert.deepEqual(effect.proof.layer_movement_ids, []);
  const journals = appended(beforeRows, afterRows, 'catalog_stock_control_effect_journals');
  assert(journals.every(j => j.admission_id === admission.id));
  assert.deepEqual(journals.map(j => j.journal_id).sort(), [stockMovement.id, binMovement.id].sort());
  const event = one(appended(beforeRows, afterRows, 'order_events'));
  assert.equal(event.order_id, order_id); assert.equal(event.kind, 'return.received'); assert.equal(event.detail.return_id, return_id);
  // An empty frozen rule list queues no automation job (server/events.ts), so jobs stays literally unchanged.
  assert.deepEqual(afterRows.jobs, beforeRows.jobs);
  const audits = appended(beforeRows, afterRows, 'audit_events');
  assert.equal(audits.filter(r => r.action === 'return.received' && r.entity_id === return_id).length, 1);
  return { receipt, doc, admission, audits };
}

test('strict OFF supplier111 receive uses its real applied bridge parent, one PZ and exact physical replay', async () => {
  const f = await freshReturnFixture(supplierHarness, false);
  const catalogId = await activate(f.supplier, f.source.id); // Fulfilled, no requested RMA yet.
  const flags = await f.ok('/catalog-stock-control/history?catalog_id=' + catalogId + '&limit=1', 'GET', undefined, f.supplier.cookie);
  assert.equal(flags.writers_available, false); assert.equal(flags.activation_available, false);
  const retail = await requestRetail(f), { preview } = await sourcePreview(f, retail);
  const submitted = await submitReturn(f, preview); assert.equal(submitted.cases.length, 1);
  const caseId = submitted.cases[0].id, c = await supplierCase(f, caseId), body = await receiveBody(f, c, 1);
  const supplierRma = await f.ok('/returns/' + c.supplier_return_id, 'GET', undefined, f.supplier.cookie);
  assert.equal(supplierRma.items.length, 1);
  const beforeRows = await facts169();
  const received = await f.ok(returnBase + '/cases/' + caseId + '/receive', 'POST', body, f.supplier.cookie);
  assert.equal(received.reused, false); assert.equal(received.case.state, 'received'); assert.equal(received.case.wholesale_refund_minor, '700');
  const afterRows = await facts169();
  const proof = graph(beforeRows, afterRows, { side: f.supplier, product_id: f.source.id,
    order_id: f.forwarded.supplier_order_id, return_id: supplierRma.id, item_id: supplierRma.items[0].item_id, refund: 700 }, 'dropship_supplier');
  const native = one(appended(beforeRows, afterRows, 'b2b_dropship_return_proofs'));
  assert.equal(native.id, proof.receipt.dropship_admission_id); assert.equal(native.kind, 'receive'); assert.equal(native.applied, true);
  assert.equal(native.tenant_id, f.supplier.tenant); assert.equal(native.actor_tenant_id, f.supplier.tenant);
  assert.equal(native.actor_id, f.supplier.user); assert.equal(native.return_id, supplierRma.id); assert.equal(native.case_id, caseId);
  assert.equal(native.transaction_id, proof.admission.txid);
  assert.equal(proof.receipt.local_proof_id, null);
  const action = one(appended(beforeRows, afterRows, 'b2b_dropship_return_actions'));
  assert.equal(action.id, native.action_id); assert.equal(action.kind, 'receive'); assert.equal(action.client_key, body.client_key);
  assert.equal(action.case_id, caseId); assert.deepEqual(action.request, b2bDropshipReturnReceiveInput.parse(body));
  assert.equal(proof.audits.filter(r => r.action === 'b2b.dropship.return.receive' && r.entity_id === caseId).length, 1);
  for (const table of Object.keys(beforeRows)) assert.deepEqual(afterRows[table].filter(x => x.row.tenant_id === f.buyer.tenant),
    beforeRows[table].filter(x => x.row.tenant_id === f.buyer.tenant), 'Buyer side literally unchanged without retail reconciliation: ' + table);
  assert.deepEqual(await f.stock(), { on_hand: 18, reserved: 0, available: 18 });
  const replay = await f.ok(returnBase + '/cases/' + caseId + '/receive', 'POST', body, f.supplier.cookie);
  assert.equal(replay.reused, true); assert.equal(replay.case.id, received.case.id);
  assert.deepEqual(await facts169(), afterRows, 'Full global replay purity: native parent/PZ/counters/cash/sessions');
});

test('strict OFF explicit local112 origin binds the actual mixed shipment, one PZ and unchanged supplier side', async () => {
  const f = await freshMixedFixture(localHarness, false);
  const catalogId = await activate(f.buyer, f.product.id); // Both local and supplier dispatch completed first.
  const flags = await f.ok('/catalog-stock-control/history?catalog_id=' + catalogId + '&limit=1');
  assert.equal(flags.writers_available, false); assert.equal(flags.activation_available, false);
  const rma = await requestMixedReturn(f), originBody = await localBody(f, rma);
  const { origin, reused } = await f.ok(prefix + '/returns/' + rma.id + '/local-origin', 'POST', originBody);
  assert.equal(reused, false); assert.equal(origin.items[0].shipment_id, f.localShipment);
  const body = await localReceive(f, rma, origin, 1), beforeRows = await facts169();
  const storedOrigin = one(raw169(beforeRows, 'b2b_return_local_origins').filter(r => r.tenant_id === f.buyer.tenant && r.id === origin.id));
  assert.equal(storedOrigin.return_id, rma.id); assert.equal(storedOrigin.order_id, f.order.id);
  assert.equal(storedOrigin.actor_id, f.buyer.user); assert.deepEqual(storedOrigin.request, originBody);
  const received = await f.ok('/returns/' + rma.id + '/receive', 'POST', body);
  assert.equal(received.id, rma.id); assert.equal(received.refund_amount, 2500); assert.equal(received.state, 'refund_pending');
  const afterRows = await facts169();
  const proof = graph(beforeRows, afterRows, { side: f.buyer, product_id: f.product.id,
    order_id: f.order.id, return_id: rma.id, item_id: f.customerItem.id, refund: 2500 }, 'rma');
  const native = one(appended(beforeRows, afterRows, 'b2b_return_local_proofs'));
  assert.equal(native.id, proof.receipt.local_proof_id); assert.equal(native.origin_id, origin.id);
  assert.equal(native.return_id, rma.id); assert.equal(native.actor_id, f.buyer.user); assert.equal(native.api_key_id, null); assert.equal(native.applied, true);
  assert.equal(native.transaction_id, proof.admission.txid);
  assert.equal(proof.receipt.dropship_admission_id, null);
  for (const table of Object.keys(beforeRows)) assert.deepEqual(afterRows[table].filter(x => x.row.tenant_id === f.supplier.tenant),
    beforeRows[table].filter(x => x.row.tenant_id === f.supplier.tenant), 'Supplier physical/financial/source rows literally unchanged: ' + table);
  assert.deepEqual(await mixedStock(f), { on_hand: 5, reserved: 0, available: 5 });
  assert.deepEqual(await mixedStock(f, true), { on_hand: 18, reserved: 0, available: 18 });
  const originReplay = await f.ok(prefix + '/returns/' + rma.id + '/local-origin', 'POST', originBody);
  assert.equal(originReplay.reused, true); assert.equal(originReplay.origin.id, origin.id);
  const replay = await f.ok('/returns/' + rma.id + '/receive', 'POST', body);
  assert.equal(replay.id, received.id); assert.equal(replay.version, received.version);
  assert.deepEqual(await facts169(), afterRows, 'Full global local-origin/core replay purity including sessions');
});
