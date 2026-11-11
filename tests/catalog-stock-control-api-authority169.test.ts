import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import {
  sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl,
  catalogStockControlDetail, catalogStockControlRows, catalogStockControlHistory,
  exportCatalogStockControlDocument,
} from '../server/catalog-stock-control';
import { seed } from './fixtures';
import {
  bootstrap151169, install152169, fixture169, facts169, physicalExact169,
  own169, consent169, type Fixture169, type Row,
} from './catalog-stock-control169-fixture';
import type { CatalogStockControlActor } from '../server/catalog-stock-control-schema';

// Root executes in a fresh numeric disposable PG DB. This private service gate
// certifies only BO API authority; it never enables the public writer capability.
const privateGate = { writersAvailable: true };
let app: Awaited<ReturnType<typeof buildApp>>;
let providers = 0;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: async () => {
    providers++; throw new Error('No external provider in BO authority169');
  } });
});
after(async () => { try { assert.equal(providers, 0); await app?.close(); } finally { await pool.end(); } });

const privateFields = new Set([
  'unit_cost_minor', 'value_minor', 'known_value_minor', 'known_quantity',
  'zero_cost_quantity', 'unknown_quantity', 'currency', 'exponent', 'rows_sha256',
  'nonce', 'frame', 'raw',
]);
function noValues(value: unknown) {
  if (Array.isArray(value)) { value.forEach(noValues); return; }
  if (value && typeof value === 'object') for (const [key, nested] of Object.entries(value)) {
    assert.equal(privateFields.has(key), false, 'No private value/hash/frame field: ' + key);
    noValues(nested);
  }
}
async function issue(f: Fixture169, scopes: string[]) {
  const key = await f.ok('/developer/keys', 'POST', { name: 'Own BO authority169', scopes }, 201);
  const saved = (await pool.query('SELECT * FROM public.api_keys WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id])).rows;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].user_id, f.user); assert.equal(saved[0].revoked_at, null);
  assert.deepEqual([...saved[0].scopes].sort(), [...scopes].sort(), 'No implicit PIM, cost or write scope');
  const actor: CatalogStockControlActor = { ...f.actor, source: 'api', apiKeyId: key.id };
  return { key, actor };
}
function draft(source: Row) {
  return {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version,
    policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.series.version })),
  };
}
const forbidden = (error: unknown) => {
  assert.equal((error as { status?: number }).status, 403);
  return true;
};
async function activate(f: Fixture169, actor: CatalogStockControlActor) {
  const before = await facts169();
  const source = await sourceCatalogStockControl(actor, f.primary.id, privateGate);
  assert.equal(source.can_manage, true); assert.equal(source.source.can_preview, true);
  const body = draft(source.source);
  const { preview } = await previewCatalogStockControl(actor, f.primary.id, body, privateGate);
  assert.equal(preview.ready, true); assert.equal(preview.can_commit, true);
  assert.deepEqual(preview.request, {
    ...body,
    warehouse_policy_versions: [...body.warehouse_policy_versions].sort((a, b) => a.warehouse_id.localeCompare(b.warehouse_id)),
    series_versions: [...body.series_versions].sort((a, b) => a.warehouse_id.localeCompare(b.warehouse_id)),
  });
  const consent = consent169(preview);
  const reply = await commitCatalogStockControl(actor, preview.id, consent, privateGate);
  assert.equal(reply.reused, false);
  assert.deepEqual(reply.operation.request, consent);
  assert.deepEqual(reply.operation.before, { catalog_id: f.primary.id, version: '0', strict: false, operation_id: null });
  assert.deepEqual(reply.operation.after, { catalog_id: f.primary.id, version: '1', strict: true, operation_id: reply.operation.id });
  assert.equal(reply.operation.preview_id, preview.id);
  assert.equal(reply.operation.documents.length, 2, 'Actual populated and empty warehouses each receive immutable BO');
  const after = await facts169(); physicalExact169(before, after);
  for (const table of Object.keys(before).filter(t => !t.startsWith('catalog_stock_control_')))
    assert.deepEqual(after[table], before[table], 'Activation does not edit PIM, costs, stock or unrelated rows/sessions: ' + table);
  const savedPreview = own169(after, 'catalog_stock_control_previews', f.tenant).find(p => p.id === preview.id);
  const savedOperation = own169(after, 'catalog_stock_control_operations', f.tenant).find(o => o.id === reply.operation.id);
  assert(savedPreview && savedOperation);
  assert.equal(savedPreview.actor_id, f.user); assert.equal(savedOperation.actor_id, f.user);
  assert.equal(savedPreview.api_key_id, actor.apiKeyId ?? null);
  assert.equal(savedOperation.api_key_id, actor.apiKeyId ?? null);
  assert.deepEqual(savedOperation.request, consent);
  return { source, body, preview, consent, reply, after, savedPreview };
}

for (const on of [false, true]) {
  test(`${on ? 'ON' : 'OFF'} inventory:read/write-only stored key activates immutable BO without PIM/cost authority or physical changes`, async () => {
    const f = await fixture169(app, on), { key, actor } = await issue(f, ['inventory:read', 'inventory:write']);
    const publicSource = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source', 'GET', undefined, 200, key);
    assert.equal(publicSource.writers_available, false); assert.equal(publicSource.activation_available, false);
    assert.equal(publicSource.source.can_preview, false); assert.equal(publicSource.can_manage, true);
    assert.equal(publicSource.can_read_value, false); noValues(publicSource.source);
    const publicBefore = await facts169();
    const unavailable = await f.request('/catalog-stock-control/catalogs/' + f.primary.id + '/previews', 'POST', draft(publicSource.source), key);
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.deepEqual(await facts169(), publicBefore, 'No public readiness override or hidden activation');
    const accepted = await activate(f, actor);
    for (const result of [accepted.source, accepted.reply]) { assert.equal(result.can_read_value, false); noValues(result); }
    noValues(accepted.preview);
    if (on) {
      const costs = accepted.savedPreview.frame.rows.map((r: Row) => r.unit_cost_minor);
      assert(costs.includes('0') && costs.includes('1000') && costs.includes(null), 'Genuine private frozen cost0/known/NULL frame exists; its public projection must remain redacted');
    }
    for (const document of accepted.reply.operation.documents) {
      const detail = await catalogStockControlDetail(actor, 'document', document.id);
      const rows = await catalogStockControlRows(actor, 'document', document.id, { limit: 100 });
      assert.equal(rows.meta.cursor, null); assert.equal(rows.data.length, document.row_count);
      assert.equal(detail.can_read_value, false); noValues(detail); noValues(rows);
      assert.equal(rows.data.length, document.warehouse.id === f.warehouse.id ? (on ? 3 : 1) : 0);
      await assert.rejects(exportCatalogStockControlDocument(actor, document.id, { format: 'csv', include_values: 'true' }), forbidden);
    }
    const history = await catalogStockControlHistory(actor, { catalog_id: f.primary.id, limit: 50 });
    assert.equal(history.data.length, 1); assert.equal(history.data[0].id, accepted.reply.operation.id); noValues(history);
    const replay = await commitCatalogStockControl(actor, accepted.preview.id, accepted.consent, privateGate);
    assert.equal(replay.reused, true); assert.deepEqual(replay.operation, accepted.reply.operation); noValues(replay);
    assert.deepEqual(await facts169(), accepted.after, 'Read, denied value export and exact immutable consent replay change no global row/session');
  });

  test(`${on ? 'ON' : 'OFF'} inventory-read-only key reads source/history but cannot activate; missing inventory-read and value export are denied atomically`, async () => {
    const f = await fixture169(app, on);
    const accepted = await activate(f, f.actor);
    const reader = await issue(f, ['inventory:read']);
    const withoutRead = await issue(f, ['inventory:write']);
    const before = await facts169();
    // The other catalog remains nonstrict, so refusal is actual scope authority,
    // rather than ALREADY_STRICT or a stale source shortcut.
    const source = await sourceCatalogStockControl(reader.actor, f.secondary.id, privateGate);
    assert.equal(source.source.ready, true); assert.equal(source.can_manage, false);
    assert.equal(source.source.can_preview, false); assert.equal(source.can_read_value, false); noValues(source);
    const publicRead = await f.ok('/catalog-stock-control/catalogs/' + f.secondary.id + '/source', 'GET', undefined, 200, reader.key);
    assert.equal(publicRead.can_manage, false); noValues(publicRead);
    const history = await catalogStockControlHistory(reader.actor, { catalog_id: f.primary.id, limit: 50 });
    assert.equal(history.data.length, 1); assert.equal(history.data[0].id, accepted.reply.operation.id); noValues(history);
    const publicHistory = await f.ok('/catalog-stock-control/history?catalog_id=' + f.primary.id + '&limit=50', 'GET', undefined, 200, reader.key);
    assert.equal(publicHistory.can_manage, false); noValues(publicHistory);
    await assert.rejects(previewCatalogStockControl(reader.actor, f.secondary.id, draft(source.source), privateGate), forbidden);
    const deniedPreview = await f.request('/catalog-stock-control/catalogs/' + f.secondary.id + '/previews', 'POST', draft(source.source), reader.key);
    assert.equal(deniedPreview.statusCode, 403, deniedPreview.body);
    for (const format of ['csv', 'xml']) {
      const document = accepted.reply.operation.documents[0];
      await assert.rejects(exportCatalogStockControlDocument(reader.actor, document.id, { format, include_values: 'true' }), forbidden);
      const deniedExport = await f.request('/catalog-stock-control/documents/' + document.id + '/export?format=' + format + '&include_values=true', 'GET', undefined, reader.key);
      assert.equal(deniedExport.statusCode, 403, deniedExport.body);
    }
    await assert.rejects(sourceCatalogStockControl(withoutRead.actor, f.secondary.id, privateGate), forbidden);
    await assert.rejects(catalogStockControlHistory(withoutRead.actor, { catalog_id: f.primary.id }), forbidden);
    for (const path of ['/catalogs/' + f.secondary.id + '/source', '/history?catalog_id=' + f.primary.id]) {
      const denied = await f.request('/catalog-stock-control' + path, 'GET', undefined, withoutRead.key);
      assert.equal(denied.statusCode, 403, denied.body);
    }
    assert.deepEqual(await facts169(), before, 'Read-only and missing-read key refusals retain the entire DB including all sessions');
  });
}
