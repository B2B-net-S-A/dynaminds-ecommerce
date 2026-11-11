import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { encrypt } from '../server/security';
import { processCatalogSource } from '../server/catalog-source';
import type { IntegrationContext } from '../server/channel-access';
import {
  sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl,
} from '../server/catalog-stock-control';
import { seed } from './fixtures';
import {
  bootstrap151169, install152169, fixture169, facts169, physical169,
  physicalExact169, own169, raw169, consent169, wait169, type Facts, type Fixture169, type Row,
} from './catalog-stock-control169-fixture';

// Root executes this only in a fresh numeric disposable PG database. The local
// internal BO gate exercises genuine managed SQL152 preview/consent/commit; it
// does NOT certify all writers or change the public capability from false.
let app: Awaited<ReturnType<typeof buildApp>>;
const warehousePostErrors = new Map<string, { name: string; code?: string; message: string; where?: string }>();
let sourceProducts: Row[] = [];
const sourceCalls: string[] = [];
const transport: NonNullable<IntegrationContext['transport']> = async (url, init) => {
  const u = new URL(url);
  assert.equal(u.hostname, 'birth169.example');
  assert.equal(init.method ?? 'GET', 'GET', 'Controlled source acquisition has no external writes');
  sourceCalls.push(u.pathname);
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  if (u.pathname.includes('/settings/general/')) return json({ value: 'PLN' });
  if (u.pathname.includes('/settings/tax/')) return json({ value: 'yes' });
  assert.match(u.pathname, /\/products$/);
  assert.equal(u.searchParams.get('orderby'), 'id');
  assert.equal(u.searchParams.get('order'), 'asc');
  const page = Number(u.searchParams.get('page'));
  assert(Number.isInteger(page) && page > 0);
  return json(sourceProducts.slice((page - 1) * 50, page * 50));
};
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: transport });
  app.addHook('onError', async (request, _reply, error) => {
    const pathname = request.url.split('?')[0];
    if (request.method !== 'POST' || !/^\/api\/warehouse-documents\/[a-f0-9-]{36}\/post$/.test(pathname)) return;
    const sqlError = error as Error & { code?: unknown; where?: unknown };
    // Only bounded original error fields; never request headers/body, cookies,
    // credentials, query parameters, detail rows, SQL parameters or a stack.
    warehousePostErrors.set(pathname, {
      name: sqlError.name.slice(0, 100),
      ...(typeof sqlError.code === 'string' ? { code: sqlError.code.slice(0, 100) } : {}),
      message: sqlError.message.slice(0, 500),
      ...(typeof sqlError.where === 'string' ? { where: sqlError.where.slice(0, 1000) } : {}),
    });
  });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function internalActivation(f: Fixture169) {
  // Same real read first: Node surfaces the original PG code/message instead
  // of buildApp's deliberately sanitized HTTP500. This is not a fallback.
  const directSource = await sourceCatalogStockControl(f.actor, f.primary.id, { writersAvailable: false });
  assert.equal(directSource.writers_available, false);
  assert.equal(directSource.activation_available, false);
  const publicReply = await f.request('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(publicReply.statusCode, 200, publicReply.body);
  const publicSource = publicReply.json();
  assert.equal(publicSource.writers_available, false);
  assert.equal(publicSource.activation_available, false);
  const before = await facts169();
  const context = { writersAvailable: true }; // Private test gate, never a HTTP availability override.
  const { source } = await sourceCatalogStockControl(f.actor, f.primary.id, context);
  assert.equal(source.ready, true); assert.deepEqual(source.blockers, []);
  const request = {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version,
    policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.series.version })),
  };
  const { preview } = await previewCatalogStockControl(f.actor, f.primary.id, request, context);
  assert.equal(preview.ready, true); assert.equal(preview.can_commit, true);
  const result = await commitCatalogStockControl(f.actor, preview.id, consent169(preview), context);
  assert.equal(result.reused, false); assert.equal(result.operation.catalog_id, f.primary.id);
  assert.deepEqual(result.operation.before, { catalog_id: f.primary.id, version: '0', strict: false, operation_id: null });
  assert.deepEqual(result.operation.after, { catalog_id: f.primary.id, version: '1', strict: true, operation_id: result.operation.id });
  physicalExact169(before, await facts169());
  return result.operation;
}

const productInput = (f: Fixture169, quantity: number) => ({
  catalog_id: f.primary.id, name: 'Own strict metadata birth169', sku: 'BIRTH169-' + randomUUID(),
  kind: 'simple', price: 1000, vat: 23, warehouse_id: f.warehouse.id, quantity, location: 'NEW-169',
});
const pzInstruction = 'Utwórz produkt ze stanem 0, a następnie przyjmij towar dokumentem PZ';
function refused(response: { statusCode: number; body: string }) {
  assert.equal(response.statusCode, 422, response.body);
  assert(response.body.includes(pzInstruction), 'The actual response explains the state0 → PZ workflow');
}
const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };

async function assertEmptyBirth(f: Fixture169, before: Facts, id: string) {
  const after = await facts169();
  const product = one(own169(after, 'products', f.tenant).filter(p => p.id === id));
  assert.equal(product.catalog_id, f.primary.id); assert.equal(product.kind, 'simple');
  const stock = one(own169(after, 'stock', f.tenant).filter(s => s.product_id === id));
  assert.equal(stock.warehouse_id, f.warehouse.id);
  assert.equal(stock.on_hand, 0); assert.equal(stock.reserved, 0); assert.equal(stock.available, 0);
  // Genuine025 reconciliation creates a zero bin, not a movement. Do not disable
  // that trigger or mistake the inventory attachment for a physical receipt.
  const bin = one(own169(after, 'stock_locations', f.tenant).filter(s => s.product_id === id));
  assert.equal(bin.warehouse_id, f.warehouse.id); assert.equal(bin.quantity, 0);
  const attachments = new Set(['stock', 'stock_locations', 'stock_file_import_epochs', 'purchasing_stock_changes']);
  for (const table of physical169) if (!attachments.has(table))
    assert.deepEqual(after[table], before[table], 'No physical journal/layer/reservation/policy write: ' + table);
  for (const table of ['stock', 'stock_locations', 'stock_file_import_epochs']) {
    assert.deepEqual(after[table].filter(x => x.row.product_id !== id), before[table], 'All previous inventory attachments exact: ' + table);
    assert.equal(after[table].length, before[table].length + 1);
  }
  const epoch = one(own169(after, 'stock_file_import_epochs', f.tenant).filter(s => s.product_id === id));
  assert.equal(epoch.warehouse_id, f.warehouse.id); assert.equal(String(epoch.version), '1');
  const markerIds = new Set(raw169(before, 'purchasing_stock_changes').map(r => String(r.id)));
  assert.deepEqual(after.purchasing_stock_changes.filter(x => markerIds.has(String(x.row.id))), before.purchasing_stock_changes);
  const marker = one(raw169(after, 'purchasing_stock_changes').filter(r => !markerIds.has(String(r.id))));
  assert.equal(marker.tenant_id, f.tenant); // Actual099 stock INSERT marker; no second journal100 marker.
  for (const table of Object.keys(before).filter(t => t.startsWith('catalog_stock_control_')))
    assert.deepEqual(after[table], before[table], 'No manufactured physical strict admission/BO revision: ' + table);
  const detail = await f.ok('/products/' + id);
  const attached = one(detail.stock.filter((s: Row) => s.warehouse_id === f.warehouse.id));
  assert.equal(attached.on_hand, 0); assert.equal(attached.reserved, 0);
  const inventory = await f.ok('/inventory?warehouse_id=' + f.warehouse.id + '&product_id=' + id);
  const row = one(inventory.data);
  assert.equal(row.product_id, id); assert.equal(row.on_hand, 0);
  assert.equal(row.physical_available, 0); assert.equal(row.sellable_available, 0);
  assert.equal(inventory.meta.cursor, null);
}

for (const on of [false, true]) {
  test(`${on ? 'ON' : 'OFF'} strict product birth0 saves genuine metadata/inventory attachment without any physical journal or layer`, async () => {
    const f = await fixture169(app, on); await internalActivation(f);
    const before = await facts169();
    const p = await f.ok('/products', 'POST', productInput(f, 0), 201);
    await assertEmptyBirth(f, before, p.id);
  });
  test(`${on ? 'ON' : 'OFF'} strict positive birth requires actual PZ and rolls back every global row/session`, async () => {
    const f = await fixture169(app, on); await internalActivation(f);
    const body = productInput(f, 3), before = await facts169();
    refused(await f.request('/products', 'POST', body));
    assert.deepEqual(await facts169(), before, 'No metadata, alias, quota, stock/bin, markers, audit, job or certificate side effect');
  });
}

/** Real source API → literal own job claim → tested processor. No global tick,
 * fabricated normalized rows, raw product/stock seed or external provider. */
async function stagedSource(f: Fixture169, quantities: number[], importStock = true) {
  sourceProducts = quantities.map((quantity, index) => ({
    id: index + 1, type: 'simple', sku: 'SRC-BIRTH169-' + randomUUID(), name: 'Source birth169 ' + index,
    status: 'publish', regular_price: '10.00', tax_status: 'taxable', tax_class: '',
    manage_stock: true, stock_quantity: quantity, attributes: [], images: [],
  }));
  const channel = randomUUID(), callCount = sourceCalls.length;
  await pool.query("INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','Own controlled birth169','sandbox',$3,$4)", [
    channel, f.tenant, encrypt({ consumer_key: 'synthetic169', consumer_secret: 'synthetic169' }),
    JSON.stringify({ store_url: 'https://birth169.example', simulation: false }),
  ]);
  const run = await f.ok('/integrations/' + channel + '/catalog-source-runs', 'POST', {
    client_key: randomUUID(), warehouse_id: f.warehouse.id, vat: 23, import_stock: importStock,
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const job = one((await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 AND tenant_id=$3 AND state='pending' RETURNING *", [run.job_id, randomUUID(), f.tenant])).rows);
    await processCatalogSource(job, { transport });
    const current = one((await pool.query('SELECT state FROM catalog_source_runs WHERE tenant_id=$1 AND id=$2', [f.tenant, run.id])).rows);
    if (current.state === 'ready') break;
    assert.equal(current.state, 'queued'); assert(attempt < 3, 'Bounded own acquisition must finish');
  }
  assert(sourceCalls.length > callCount, 'Real controlled acquisition was actually invoked');
  const view = await f.ok('/catalog-source-runs/' + run.id + '?limit=100&catalog_id=' + f.primary.id);
  assert.equal(view.run.state, 'ready'); assert.equal(view.meta.cursor, null);
  assert.equal(view.data.length, quantities.length);
  assert(view.data.every((r: Row) => r.state === 'staged' && r.candidate_id === null));
  return { run, rows: view.data as Row[] };
}
function applyItem(f: Fixture169, row: Row, quantity?: number) {
  return { id: row.id, catalog_id: f.primary.id, source_hash: row.source_hash,
    expected_product_id: row.candidate_id ?? null, expected_version: row.candidate_version ?? null,
    ...(quantity === undefined ? {} : { quantity_override: quantity }),
  };
}

for (const on of [false, true]) test(`${on ? 'ON' : 'OFF'} real source import refuses mixed positive batch atomically; explicit0 and exact applied replay create no physical journals`, async () => {
  const f = await fixture169(app, on); await internalActivation(f);
  const staged = await stagedSource(f, [4, 4]);
  // applyCatalog locks/executes simple rows by UUID, so the first genuine row
  // provisionally creates0 before the second positive row must roll it back.
  const [first, second] = [...staged.rows].sort((a, b) => a.id.localeCompare(b.id));
  const path = '/catalog-source-runs/' + staged.run.id + '/apply';
  const before = await facts169();
  refused(await f.request(path, 'POST', { items: [applyItem(f, first, 0), applyItem(f, second)] }));
  assert.deepEqual(await facts169(), before, 'Earlier birth0, source state, listing, aliases, audit/quota and all physical rows rolled back together');
  for (const row of [first, second]) {
    const body = { items: [applyItem(f, row, 0)] }, emptyBefore = await facts169();
    const saved = await f.ok(path, 'POST', body);
    assert.equal(saved.created, 1); assert.equal(saved.linked, 0);
    const result = one(saved.data); assert.equal(result.entry_id, row.id); assert.equal(result.action, 'created');
    await assertEmptyBirth(f, emptyBefore, result.product_id);
    const replayBefore = await facts169(), replay = await f.ok(path, 'POST', body);
    assert.equal(replay.created, 0); assert.equal(replay.linked, 0);
    assert.deepEqual(replay.data, [{ ...result, reused: true }]);
    assert.deepEqual(await facts169(), replayBefore, 'Exact applied receipt replay has no new metadata/physical effect');
  }
});

test('strict import_stock=false imports metadata even when real source carries positive availability', async () => {
  const f = await fixture169(app); await internalActivation(f);
  const { run, rows } = await stagedSource(f, [12], false), before = await facts169();
  assert.equal(rows[0].source.quantity, 12, 'Availability is genuine staged source data, not edited to zero');
  const result = await f.ok('/catalog-source-runs/' + run.id + '/apply', 'POST', { items: [applyItem(f, rows[0])] });
  assert.equal(result.created, 1); await assertEmptyBirth(f, before, one(result.data).product_id);
});

test('nonstrict initial0/positive markers remain compatible and an applied pre-BO source receipt replays unchanged after activation', async () => {
  const f = await fixture169(app);
  for (const quantity of [0, 3]) {
    const p = await f.ok('/products', 'POST', productInput(f, quantity), 201), captured = await facts169();
    const movement = one(own169(captured, 'stock_movements', f.tenant).filter(m => m.product_id === p.id));
    assert.equal(movement.kind, 'initial'); assert.equal(movement.delta, quantity);
    assert.equal(one(own169(captured, 'stock', f.tenant).filter(s => s.product_id === p.id)).on_hand, quantity);
    const bins = own169(captured, 'stock_location_movements', f.tenant).filter(m => m.product_id === p.id);
    assert.equal(bins.length, quantity ? 1 : 0); if (quantity) assert.equal(bins[0].delta, quantity);
  }
  const { run, rows } = await stagedSource(f, [2]), body = { items: [applyItem(f, rows[0])] };
  const saved = await f.ok('/catalog-source-runs/' + run.id + '/apply', 'POST', body);
  assert.equal(saved.created, 1);
  const result = one(saved.data), old = await facts169();
  const initial = one(own169(old, 'stock_movements', f.tenant).filter(m => m.product_id === result.product_id));
  assert.equal(initial.kind, 'initial'); assert.equal(initial.delta, 2);
  await internalActivation(f);
  const beforeReplay = await facts169(), replay = await f.ok('/catalog-source-runs/' + run.id + '/apply', 'POST', body);
  assert.equal(replay.created, 0); assert.equal(replay.linked, 0);
  assert.deepEqual(replay.data, [{ ...result, reused: true }]);
  assert.deepEqual(await facts169(), beforeReplay, 'Historic applied birth remains an exact receipt, not a forbidden second positive birth');
  assert.deepEqual(raw169(beforeReplay, 'stock_movements'), raw169(old, 'stock_movements'), 'BO retains all nonstrict original markers');
});

test('OFF strict birth0 → real numbered PZ2 changes the existing aggregate/bin once and binds exact journals; repeated post is pure', async () => {
  const f = await fixture169(app); await internalActivation(f);
  const emptyBefore = await facts169(), p = await f.ok('/products', 'POST', productInput(f, 0), 201);
  await assertEmptyBirth(f, emptyBefore, p.id);
  const beforeDraft = await facts169(), bornStock = one(own169(beforeDraft, 'stock', f.tenant).filter(s => s.product_id === p.id));
  const draft = await f.ok('/warehouse-documents', 'POST', {
    kind: 'receipt', warehouse_id: f.warehouse.id,
    lines: [{ product_id: p.id, quantity: 2, location: bornStock.location }],
    reference: 'Actual PZ alternative to positive product birth169', note: '',
  }, 201);
  assert.equal(draft.status, 'draft'); physicalExact169(beforeDraft, await facts169());
  const postBody = { version: draft.version };
  const postPath = '/warehouse-documents/' + draft.id + '/post';
  warehousePostErrors.delete('/api' + postPath);
  const postResponse = await f.request(postPath, 'POST', postBody);
  if (postResponse.statusCode === 500) {
    const diagnostic = warehousePostErrors.get('/api' + postPath);
    assert(diagnostic, 'HTTP500 must retain the original bounded onError diagnostic');
    throw new Error('Single actual warehouse PZ POST failed: ' + JSON.stringify(diagnostic));
  }
  assert.equal(postResponse.statusCode, 200, postResponse.body);
  const posted = postResponse.json();
  assert.equal(posted.id, draft.id); assert.equal(posted.status, 'posted');
  const after = await facts169();
  const stock = one(own169(after, 'stock', f.tenant).filter(s => s.product_id === p.id));
  assert.equal(stock.warehouse_id, bornStock.warehouse_id); assert.equal(stock.on_hand, 2);
  assert.equal(stock.reserved, 0); assert.equal(stock.available, 2);
  const bin = one(own169(after, 'stock_locations', f.tenant).filter(s => s.product_id === p.id));
  assert.equal(bin.location, bornStock.location); assert.equal(bin.quantity, 2);
  const movement = one(own169(after, 'stock_movements', f.tenant).filter(s => s.product_id === p.id));
  assert.equal(movement.delta, 2); assert.equal(movement.warehouse_document_id, draft.id);
  const binMovement = one(own169(after, 'stock_location_movements', f.tenant).filter(s => s.product_id === p.id));
  assert.equal(binMovement.delta, 2); assert.equal(binMovement.location, bin.location);
  const admission = one(own169(after, 'catalog_stock_control_effect_admissions', f.tenant).filter(a => a.source_id === draft.id));
  assert.equal(admission.source_kind, 'warehouse_document'); assert.equal(admission.sealed, true);
  assert.deepEqual(admission.request.product_ids, [p.id]); assert.deepEqual(admission.request.warehouse_ids, [f.warehouse.id]);
  const effect = one(own169(after, 'catalog_stock_control_effects', f.tenant).filter(e => e.admission_id === admission.id));
  assert.equal(effect.warehouse_document_id, draft.id); assert.equal(effect.operation_id, null);
  assert.deepEqual(effect.proof.stock_movement_ids, [movement.id]);
  assert.deepEqual(effect.proof.location_movement_ids, [binMovement.id]);
  assert.deepEqual(effect.proof.layer_movement_ids, []);
  const journals = own169(after, 'catalog_stock_control_effect_journals', f.tenant).filter(j => j.admission_id === admission.id);
  assert.equal(journals.length, 2);
  const stockJournal = one(journals.filter(j => j.kind === 'stock'));
  assert.equal(stockJournal.journal_id, movement.id); assert.equal(stockJournal.stock_movement_id, movement.id);
  const binJournal = one(journals.filter(j => j.kind === 'bin'));
  assert.equal(binJournal.journal_id, binMovement.id); assert.equal(binJournal.location_movement_id, binMovement.id);
  const number = admission.number;
  const series = one(own169(after, 'catalog_stock_control_series', f.tenant).filter(s => s.id === number.series_id));
  assert.equal(series.kind, 'PZ'); assert.equal(series.warehouse_id, f.warehouse.id);
  assert.equal(number.kind, 'PZ'); assert.equal(number.sequence, '1');
  assert.equal(posted.number, `${series.prefix}/${number.year}/${number.sequence.padStart(6, '0')}`);
  const counter = one(own169(after, 'catalog_stock_control_counters', f.tenant).filter(c => c.series_id === series.id && c.year === number.year));
  assert.equal(String(counter.value), number.sequence);
  for (const table of physical169.filter(t => t.startsWith('wms_')))
    assert.deepEqual(after[table], beforeDraft[table], 'OFF receipt has no hidden WMS writer: ' + table);
  const read = await f.ok('/products/' + p.id);
  assert.equal(one(read.stock.filter((s: Row) => s.warehouse_id === f.warehouse.id)).on_hand, 2);
  const replayBefore = await facts169();
  const replay = await f.ok('/warehouse-documents/' + draft.id + '/post', 'POST', postBody);
  assert.deepEqual(replay, posted);
  assert.deepEqual(await facts169(), replayBefore, 'Same real posting has no second quantity/journal/number/certificate/audit effect');
});

test('actual products:write-only key may create strict birth0 without unrelated inventory/purchasing scopes', async () => {
  const f = await fixture169(app); await internalActivation(f);
  const key = await f.ok('/developer/keys', 'POST', {
    name: 'Own metadata-only strict birth169', scopes: ['products:write'],
  }, 201);
  const stored = one((await pool.query('SELECT scopes FROM api_keys WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id])).rows);
  assert.deepEqual(stored.scopes, ['products:write'], 'Use a genuinely narrow issued key, not an admin-cookie substitute');
  const before = await facts169();
  const p = await f.ok('/products', 'POST', productInput(f, 0), 201, key);
  await assertEmptyBirth(f, before, p.id);
});

test('actual birth0 waiting on catalog lock rejects late admin→operator change and rolls back metadata/inventory attachments', async () => {
  const f = await fixture169(app); await internalActivation(f);
  const before = await facts169(), held = await pool.connect();
  let request: ReturnType<typeof f.request> | undefined;
  try {
    await held.query('BEGIN');
    const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await held.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalog:' + f.tenant]);
    request = f.request('/products', 'POST', productInput(f, 0));
    await wait169(pid, /pg_advisory_xact_lock/);
    assert.deepEqual(await facts169(), before, 'Observed real catalog-lock waiter has not created any product or physical row');
    await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    const withdrawn = await facts169();
    await held.query('COMMIT');
    const reply = await request;
    assert.equal(reply.statusCode, 403, reply.body);
    assert.deepEqual(await facts169(), withdrawn, 'Current operator cannot publish the formerly-admin birth; all non-IAM rows/sessions remain exact');
  } finally {
    await held.query('ROLLBACK').catch(() => {}); held.release();
    await request?.catch(() => undefined);
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  }
  assert.deepEqual(await facts169(), before, 'Only deliberate fixture IAM change was restored; no rolled-back birth residue');
});
