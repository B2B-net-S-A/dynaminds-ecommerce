import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import {
  bootstrap151169, install152169, fixture169, facts169, physicalExact169,
  own169, consent169, sort169, type Facts, type Row,
} from './catalog-stock-control169-fixture';

// Root executes in a fresh numeric disposable DB. The only internal readiness
// gate is genuine BO activation; ordinary WMS opening uses the real HTTP API.
// This test requires a certified wms_opening adapter; it may fail until that
// adapter exists. It does not enable or certify the public BO writer capability.
let app: Awaited<ReturnType<typeof buildApp>>;
let providers = 0;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: async () => {
    providers++; throw new Error('No external provider in opening169');
  } });
});
after(async () => { try { assert.equal(providers, 0); await app?.close(); } finally { await pool.end(); } });
const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };
function retained(before: Facts, after: Facts, tables: string[]) {
  for (const table of tables) assert.deepEqual(after[table], before[table], 'Literal immutable/physical preservation: ' + table);
}

test('strict OFF BO → genuine tenant-wide WMS opening preserves stock/bins and old BO while certifying only actual new opening layer journals; exact replay is pure', async () => {
  const f = await fixture169(app, false);
  const costs = new Map<string, string | null>([[f.products[0].id, '0'], [f.other.id, '1000']]);
  for (const [cost, quantity, location] of [['1000', 3, 'A-02'], [null, 4, 'A-03']] as const) {
    const p = await f.ok('/products', 'POST', {
      catalog_id: f.primary.id, name: 'Opening169 ' + String(cost), sku: 'OPEN169-' + randomUUID(),
      kind: 'simple', price: 1501, vat: 23, warehouse_id: f.warehouse.id, quantity, location,
    }, 201);
    costs.set(p.id, cost);
  }
  const publicSource = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(publicSource.writers_available, false); assert.equal(publicSource.activation_available, false);
  const privateGate = { writersAvailable: true };
  const { source } = await sourceCatalogStockControl(f.actor, f.primary.id, privateGate);
  assert.equal(source.ready, true); assert.equal(source.snapshot.wms_enabled, false);
  const beforeBO = await facts169();
  const { preview: boPreview } = await previewCatalogStockControl(f.actor, f.primary.id, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version, policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.series.version })),
  }, privateGate);
  const bo = (await commitCatalogStockControl(f.actor, boPreview.id, consent169(boPreview), privateGate)).operation;
  assert.equal(bo.after.strict, true); assert.equal(bo.documents.length, 2);
  physicalExact169(beforeBO, await facts169());
  const oldBO = await facts169();
  assert.deepEqual(own169(oldBO, 'catalog_stock_control_policies', f.tenant).map(p => p.catalog_id), [f.primary.id]);
  const savedBO = bo.documents.map(d => ({ document: d, rows: oldBO.catalog_stock_control_rows.filter(r => r.row.document_id === d.id) }));
  const mainBO = bo.documents.find(d => d.warehouse.id === f.warehouse.id); assert(mainBO);
  assert.equal(mainBO.row_count, 3);
  assert.equal(Object.hasOwn(mainBO.summary, 'known_value_minor'), false, 'OFF BO must not be retrospectively valued by WMS activation');

  const positive = own169(oldBO, 'stock_locations', f.tenant).filter(b => b.quantity > 0);
  assert.equal(positive.length, 4); assert(positive.some(b => b.product_id === f.other.id));
  assert.equal(own169(oldBO, 'products', f.tenant).find(p => p.id === f.other.id)!.catalog_id, f.secondary.id);
  const scope = await f.ok('/wms-lots/opening-scope');
  assert.deepEqual(scope.active_blockers, []); assert.equal(scope.meta.total, 4); assert.equal(scope.meta.cursor, null);
  assert.deepEqual(sort169(scope.data.map((b: Row) => [b.warehouse_id, b.product_id, b.location, b.quantity])),
    sort169(positive.map(b => [b.warehouse_id, b.product_id, b.location, b.quantity])), 'Real opening scope is all positive bins across both own catalog pools');
  const lines = scope.data.map((bin: Row) => ({
    warehouse_id: bin.warehouse_id, product_id: bin.product_id, location: bin.location,
    quantity: bin.quantity, stock_version: String(bin.stock_version),
    lot_code: 'OPEN169-' + randomUUID(), unit_cost_minor: costs.get(bin.product_id),
  }));
  assert(lines.every((l: Row) => l.unit_cost_minor !== undefined));
  const input = { client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'Genuine whole-tenant opening after immutable OFF BO', lines };
  const beforeIncomplete = await facts169();
  const incomplete = (await f.ok('/wms-lots/opening-previews', 'POST', { ...input, client_key: randomUUID(), lines: lines.filter((l: Row) => l.product_id !== f.other.id) }, 201)).preview;
  assert.equal(incomplete.ready, false, 'A per-catalog approximation must not enable tenant-wide WMS');
  physicalExact169(beforeIncomplete, await facts169());
  const rejectedBefore = await facts169();
  const rejected = await f.request('/wms-lots/opening-previews/' + incomplete.id + '/activate', 'POST', {
    client_key: randomUUID(), scope_hash: incomplete.scope_hash, confirmed: true, ack_unknown_costs: true,
  });
  assert.equal(rejected.statusCode, 409, rejected.body); assert.deepEqual(await facts169(), rejectedBefore);

  const opening = (await f.ok('/wms-lots/opening-previews', 'POST', input, 201)).preview;
  assert.equal(opening.ready, true); assert.deepEqual(opening.issues, []);
  const consent = { client_key: randomUUID(), scope_hash: opening.scope_hash, confirmed: true, ack_unknown_costs: true };
  const missingAckBefore = await facts169();
  const missingAck = await f.request('/wms-lots/opening-previews/' + opening.id + '/activate', 'POST', { ...consent, ack_unknown_costs: false });
  assert.equal(missingAck.statusCode, 422, missingAck.body);
  assert.deepEqual(await facts169(), missingAckBefore, 'No tentative policy, layer, number or admission after missing unknown-cost consent');
  const beforeActivation = await facts169();
  const result = await f.ok('/wms-lots/opening-previews/' + opening.id + '/activate', 'POST', consent, 201);
  assert.equal(result.reused, false); assert.equal(result.operation.kind, 'opening');
  assert.equal(result.result.preview_id, opening.id); assert.equal(result.result.scope_hash, opening.scope_hash);
  const after = await facts169();
  const physicalWithoutLayers = ['stock', 'stock_locations', 'stock_movements', 'stock_location_movements',
    'stock_file_import_epochs', 'purchasing_stock_changes', 'reservations', 'reservation_locations', 'wms_reservation_layers',
    'wms_issue_fragments', 'wms_return_fragments', 'warehouse_documents', 'warehouse_document_lines'];
  retained(beforeActivation, after, physicalWithoutLayers);
  const originalBOtables = Object.keys(oldBO).filter(t => t.startsWith('catalog_stock_control_') && !t.startsWith('catalog_stock_control_effect'));
  retained(oldBO, after, originalBOtables);
  const op = one(own169(after, 'wms_operations', f.tenant));
  assert.equal(op.id, result.operation.id); assert.equal(op.kind, 'opening'); assert.equal(op.client_key, consent.client_key);
  assert.deepEqual(op.request, { preview_id: opening.id, ...consent });
  assert.equal(op.warehouse_document_id, null); assert.equal(op.order_id, null);
  const policy = one(own169(after, 'wms_policies', f.tenant));
  assert.equal(policy.enabled, true); assert.equal(String(policy.version), '1'); assert.equal(policy.opening_operation_id, op.id);
  assert.equal(result.result.layers.length, lines.length);
  const movements = own169(after, 'wms_layer_movements', f.tenant);
  assert.equal(movements.length, 4);
  for (const line of lines as Row[]) {
    const layer = one(own169(after, 'wms_cost_layers', f.tenant).filter(l => l.product_id === line.product_id));
    const lot = one(own169(after, 'wms_lots', f.tenant).filter(l => l.id === layer.lot_id));
    const position = one(own169(after, 'wms_layer_positions', f.tenant).filter(p => p.layer_id === layer.id));
    const movement = one(movements.filter(m => m.layer_id === layer.id));
    assert.equal(layer.operation_id, op.id); assert.equal(layer.quantity_received, line.quantity);
    assert.equal(layer.unit_cost_minor === null ? null : String(layer.unit_cost_minor), line.unit_cost_minor);
    assert.equal(layer.currency, 'PLN'); assert.equal(layer.exponent, 2);
    assert.equal(layer.warehouse_document_id, null); assert.equal(layer.purchase_receipt_id, null);
    assert.equal(lot.operation_id, op.id); assert.equal(lot.origin, 'opening'); assert.equal(lot.lot_code, line.lot_code);
    assert.equal(position.warehouse_id, line.warehouse_id); assert.equal(position.product_id, line.product_id);
    assert.equal(position.location, line.location); assert.equal(position.quantity, line.quantity); assert.equal(position.reserved, 0);
    assert.equal(movement.operation_id, op.id); assert.equal(movement.kind, 'opening');
    assert.equal(movement.warehouse_id, line.warehouse_id); assert.equal(movement.product_id, line.product_id);
    assert.equal(movement.location, line.location); assert.equal(movement.delta, line.quantity);
    assert.equal(movement.value_delta === null ? null : String(movement.value_delta),
      line.unit_cost_minor === null ? null : String(BigInt(line.quantity) * BigInt(line.unit_cost_minor)));
  }
  const admission = one(own169(after, 'catalog_stock_control_effect_admissions', f.tenant));
  assert.equal(admission.source_kind, 'wms_opening'); assert.equal(admission.source_id, opening.id);
  assert.equal(admission.actor_id, f.user); assert.equal(admission.api_key_id, null); assert.equal(admission.sealed, true);
  assert.equal(admission.number, null, 'Opening layers do not manufacture a new physical PZ or rewrite old BO numbers');
  assert.deepEqual(admission.request.product_ids, [...costs.keys()].sort());
  assert.deepEqual(admission.request.warehouse_ids, [...new Set(lines.map((l: Row) => l.warehouse_id))].sort());
  const effect = one(own169(after, 'catalog_stock_control_effects', f.tenant));
  assert.equal(effect.admission_id, admission.id); assert.equal(effect.operation_id, op.id); assert.equal(effect.warehouse_document_id, null);
  assert.deepEqual(effect.proof.stock_movement_ids, []); assert.deepEqual(effect.proof.location_movement_ids, []);
  assert.deepEqual([...effect.proof.layer_movement_ids].sort(), movements.map(m => m.id).sort());
  const journals = own169(after, 'catalog_stock_control_effect_journals', f.tenant);
  assert.equal(journals.length, 4);
  for (const movement of movements) {
    const j = one(journals.filter(j => j.journal_id === movement.id));
    assert.equal(j.admission_id, admission.id); assert.equal(j.kind, 'layer');
    assert.equal(j.layer_movement_id, movement.id); assert.equal(j.stock_movement_id, null); assert.equal(j.location_movement_id, null);
  }
  for (const saved of savedBO) {
    const d = await f.ok('/catalog-stock-control/documents/' + saved.document.id);
    assert.deepEqual(d.document, saved.document);
    assert.deepEqual(after.catalog_stock_control_rows.filter(r => r.row.document_id === saved.document.id), saved.rows);
  }
  const allowedNew = new Set(['wms_policies', 'wms_lots', 'wms_cost_layers', 'wms_layer_positions', 'wms_layer_movements', 'wms_operations',
    'catalog_stock_control_effect_admissions', 'catalog_stock_control_effects', 'catalog_stock_control_effect_journals', 'audit_events']);
  for (const table of Object.keys(beforeActivation)) {
    if (!allowedNew.has(table)) assert.deepEqual(after[table], beforeActivation[table], 'No unrelated side effects: ' + table);
    else {
      const oldRows = new Set(beforeActivation[table].map(r => JSON.stringify(r)));
      assert.equal(after[table].filter(r => oldRows.has(JSON.stringify(r))).length, oldRows.size, 'Every prior global row retained: ' + table);
      assert(after[table].filter(r => !oldRows.has(JSON.stringify(r))).every(r => r.row.tenant_id === f.tenant), 'Only literal own opening additions: ' + table);
    }
  }
  const replayBefore = await facts169();
  const replay = await f.ok('/wms-lots/opening-previews/' + opening.id + '/activate', 'POST', consent, 200);
  assert.equal(replay.reused, true); assert.deepEqual(replay.operation, result.operation); assert.deepEqual(replay.result, result.result);
  assert.deepEqual(await facts169(), replayBefore, 'Historical replay creates no second operation, layer, journal, admission, counter, audit or session');
  const publicAfter = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(publicAfter.writers_available, false); assert.equal(publicAfter.activation_available, false);
});
