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
  own169, consent169, type Fixture169, type Row,
} from './catalog-stock-control169-fixture';

// Root executes in a fresh numeric disposable DB. Only BO activation uses the
// private managed service gate. WMS preview/activate/replay use actual HTTP and
// real issued keys; public BO writers remain unavailable throughout.
let app: Awaited<ReturnType<typeof buildApp>>;
let providers = 0;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: async () => {
    providers++; throw new Error('No provider in opening authority169');
  } });
});
after(async () => { try { assert.equal(providers, 0); await app?.close(); } finally { await pool.end(); } });
const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };
async function activateBO(f: Fixture169) {
  const publicSource = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(publicSource.writers_available, false); assert.equal(publicSource.activation_available, false);
  const ctx = { writersAvailable: true }, before = await facts169();
  const { source } = await sourceCatalogStockControl(f.actor, f.primary.id, ctx);
  assert.equal(source.ready, true);
  const { preview } = await previewCatalogStockControl(f.actor, f.primary.id, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version,
    policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.series.version })),
  }, ctx);
  const { operation } = await commitCatalogStockControl(f.actor, preview.id, consent169(preview), ctx);
  assert.equal(operation.after.strict, true); physicalExact169(before, await facts169());
  return operation;
}
async function key(f: Fixture169, scopes: string[]) {
  const issued = await f.ok('/developer/keys', 'POST', { name: 'Own genuine WMS opening authority169', scopes }, 201);
  const saved = one((await pool.query('SELECT tenant_id,user_id,scopes,revoked_at FROM public.api_keys WHERE tenant_id=$1 AND id=$2', [f.tenant, issued.id])).rows);
  assert.equal(saved.tenant_id, f.tenant); assert.equal(saved.user_id, f.user); assert.equal(saved.revoked_at, null);
  assert.deepEqual([...saved.scopes].sort(), [...scopes].sort(), 'No PIM scope or implicit purchasing grant');
  return issued;
}

test('strict BO does not weaken ordinary WMS opening cost-write authority: actual compound key succeeds, missing inventory-write or either cost scope refuses atomically', async () => {
  const f = await fixture169(app, false); await activateBO(f);
  const full = await key(f, ['inventory:read', 'inventory:write', 'purchasing:read', 'purchasing:write']);
  const deniedKeys = [
    await key(f, ['inventory:read', 'purchasing:read', 'purchasing:write']),
    await key(f, ['inventory:read', 'inventory:write', 'purchasing:read']),
    await key(f, ['inventory:read', 'inventory:write', 'purchasing:write']),
  ];
  const scope = await f.ok('/wms-lots/opening-scope', 'GET', undefined, 200, full);
  assert.equal(scope.meta.cursor, null); assert.equal(scope.meta.total, 2); assert.deepEqual(scope.active_blockers, []);
  assert(scope.data.some((r: Row) => r.product_id === f.other.id), 'Tenant-wide opening includes the nonstrict catalog sharing this warehouse');
  const input = {
    client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'Actual WMS cost authority, separate from BO authority',
    lines: scope.data.map((b: Row) => ({ warehouse_id: b.warehouse_id, product_id: b.product_id,
      location: b.location, quantity: b.quantity, stock_version: String(b.stock_version),
      lot_code: 'AUTH169-' + randomUUID(), unit_cost_minor: b.product_id === f.other.id ? null : '0' })),
  };
  for (const deniedKey of deniedKeys) {
    const before = await facts169();
    const denied = await f.request('/wms-lots/opening-previews', 'POST', input, deniedKey);
    assert.equal(denied.statusCode, 403, denied.body);
    assert.deepEqual(await facts169(), before, 'Missing WMS scope creates no preview/audit/admission/policy/layer or session');
  }
  const preview = (await f.ok('/wms-lots/opening-previews', 'POST', input, 201, full)).preview;
  assert.equal(preview.ready, true); assert.equal(preview.unknown_quantity, '7');
  const consent = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true, ack_unknown_costs: true };
  for (const deniedKey of deniedKeys) {
    const before = await facts169();
    const denied = await f.request('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', consent, deniedKey);
    assert.equal(denied.statusCode, 403, denied.body);
    assert.deepEqual(await facts169(), before, 'Denied activation retains the entire actual graph including the pending preview');
  }
  const before = await facts169();
  const result = await f.ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', consent, 201, full);
  assert.equal(result.reused, false); assert.equal(result.operation.kind, 'opening');
  const after = await facts169();
  for (const table of ['stock', 'stock_locations', 'stock_movements', 'stock_location_movements', 'stock_file_import_epochs', 'purchasing_stock_changes'])
    assert.deepEqual(after[table], before[table], 'Opening layers do not receive inventory twice: ' + table);
  const op = one(own169(after, 'wms_operations', f.tenant));
  assert.equal(op.id, result.operation.id); assert.equal(op.source, 'api');
  assert.deepEqual(op.request, { preview_id: preview.id, ...consent });
  const admission = one(own169(after, 'catalog_stock_control_effect_admissions', f.tenant));
  assert.equal(admission.source_kind, 'wms_opening'); assert.equal(admission.source_id, preview.id);
  assert.equal(admission.api_key_id, full.id); assert.equal(admission.actor_id, f.user); assert.equal(admission.sealed, true);
  const effect = one(own169(after, 'catalog_stock_control_effects', f.tenant));
  assert.equal(effect.admission_id, admission.id); assert.equal(effect.operation_id, op.id);
  const movements = own169(after, 'wms_layer_movements', f.tenant);
  assert.equal(movements.length, 2); assert(movements.every(m => m.operation_id === op.id));
  assert.deepEqual([...effect.proof.layer_movement_ids].sort(), movements.map(m => m.id).sort());
  assert.deepEqual(effect.proof.stock_movement_ids, []); assert.deepEqual(effect.proof.location_movement_ids, []);
  const replayBefore = await facts169();
  const replay = await f.ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', consent, 200, full);
  assert.equal(replay.reused, true); assert.deepEqual(replay.operation, result.operation); assert.deepEqual(replay.result, result.result);
  assert.deepEqual(await facts169(), replayBefore, 'Narrow genuine compound WMS key exact replay is globally pure');
});

test('real completed nonstrict WMS opening → strict BO → historical opening replay never backfills strict admission or changes frozen BO/layers/numbers', async () => {
  // fixture169(true) performs the ordinary whole-tenant opening before any BO;
  // it does not insert a parent WMS policy, operation or layer directly.
  const f = await fixture169(app, true);
  const legacy = await facts169();
  const opening = one(own169(legacy, 'wms_operations', f.tenant));
  assert.equal(opening.kind, 'opening');
  const preview = one(own169(legacy, 'wms_previews', f.tenant).filter(p => p.id === opening.request.preview_id));
  assert.equal(preview.kind, 'opening'); assert.equal(preview.ready, true);
  assert.equal(preview.snapshot.rows.length, 4, 'Historical actual opening includes both catalog pools, including cost0/known/NULL');
  assert.equal(own169(legacy, 'catalog_stock_control_effect_admissions', f.tenant).length, 0);
  const { preview_id: previewId, ...consent } = opening.request;
  assert.equal(consent.client_key, opening.client_key); assert.equal(consent.confirmed, true); assert.equal(consent.ack_unknown_costs, true);
  const bo = await activateBO(f);
  assert.equal(bo.snapshot.wms_enabled, true); assert.equal(bo.documents.length, 2);
  const before = await facts169();
  assert.equal(own169(before, 'catalog_stock_control_effect_admissions', f.tenant).length, 0);
  const reply = await f.ok('/wms-lots/opening-previews/' + previewId + '/activate', 'POST', consent, 200);
  assert.equal(reply.reused, true); assert.equal(reply.operation.id, opening.id); assert.equal(reply.operation.kind, 'opening');
  assert.deepEqual(reply.result, opening.result);
  assert.deepEqual(await facts169(), before, 'All global rows/sessions unchanged: no new admission, layer, operation, BO row, series/counter or audit');
  for (const document of bo.documents) {
    const detail = await f.ok('/catalog-stock-control/documents/' + document.id);
    assert.deepEqual(detail.document, document, 'Frozen BO detail survives historical opening recovery');
  }
  const source = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(source.writers_available, false); assert.equal(source.activation_available, false);
  assert.deepEqual(await facts169(), before, 'Post-recovery history reads are also pure');
});
