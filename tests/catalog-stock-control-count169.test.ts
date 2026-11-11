import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture } from './stocktake-adjustments-fixture';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import { bootstrap151169, install152169, facts169, raw169, own169,
  physicalExact169, consent169, sort169, type Facts, type Row } from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Actual086 bulk OFF and115/116 file OFF/ON routes,
// genuine internal BO consent only. Public activation stays unavailable.
// No149 fake stocktake, provider, raw stock or fabricated parent receipt.
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
const primaryKeys = new Map<string, string[]>();
const nativeQuery169=Client.prototype.query;
if(process.env.DYNA_COUNT169_DEBUG==='true') Client.prototype.query=function(this:Client,...args:any[]) {
  const result=(nativeQuery169 as any).apply(this,args);
  const query=typeof args[0]==='string' ? args[0] : args[0]?.text;
  if(typeof query==='string' && query.startsWith('SELECT public.catalog_stock_count_') && result?.then)
    return result.catch((error:Error & {code?:string;where?:string})=> {
      console.error('COUNT169_NATIVE_SQL',JSON.stringify({code:error.code,message:error.message.slice(0,300),where:error.where?.slice(0,1600)}));throw error;
    });
  return result;
} as typeof Client.prototype.query;
let injectedFailure: { code?: string; message: string }|null = null;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  for (const r of (await pool.query(`SELECT t.relname name,array_agg(a.attname::text ORDER BY k.ordinality) columns
    FROM pg_constraint p JOIN pg_class t ON t.oid=p.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(attnum,ordinality)
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
    WHERE p.contype='p' AND n.nspname='public' GROUP BY t.relname ORDER BY t.relname`)).rows)
    primaryKeys.set(r.name, r.columns);
  app = await buildApp({ integrationTransport: async () => {
    providerCalls++; throw Error('No external transport in strict count169');
  } });
  app.addHook('onError', async (request, _reply, error) => {
    if (process.env.DYNA_COUNT169_DEBUG !== 'true' || request.method !== 'POST' ||
      !/^\/api\/(?:inventory-bulk-edit|stock-file-imports)\/previews\/[a-f0-9-]{36}\/execute$/.test(request.url.split('?')[0])) return;
    const sql = error as Error & {code?:unknown;where?:unknown};
    // Deliberately omit request/headers/body, SQL parameters, detail rows,
    // credentials and stacks. Root enables this only for its scratch gate.
    const diagnostic={...(typeof sql.code==='string'?{code:sql.code.slice(0,60)}:{}),
      message:sql.message.slice(0,400),...(typeof sql.where==='string'?{where:sql.where.slice(0,1000)}:{})};
    process.stderr.write('COUNT169_SQL_DIAGNOSTIC '+JSON.stringify(diagnostic).slice(0,1600)+'\n');
  });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });
const one = (rows: Row[]) => { assert.equal(rows.length, 1); return rows[0]; };
const ids = (rows: Row[]) => rows.map(r => r.id).sort();
const omit = (r: Row, fields: string[]) => Object.fromEntries(Object.entries(r).filter(([key]) => !fields.includes(key)));

async function fixture(on: boolean) {
  // Existing164 fixture supplies actual simple products and two measured bins;
  // it does not create a count/source. Build the second WH before strict BO.
  const f = await stocktakeAdjustmentFixture(app, false);
  const second = await f.ok('/warehouses', 'POST', { name: 'Second strict count warehouse', code: 'CNT-' + randomUUID().slice(0, 8) });
  const pz = await f.ok('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: second.id,
    reference: 'Genuine own count baseline, before BO',
    lines: f.products.map(p => ({ product_id: p.id, quantity: 2, location: 'B-01' })) },201);
  await f.ok('/warehouse-documents/' + pz.id + '/post', 'POST', { version: pz.version });
  if (on) {
    const rows = own169(await facts169(), 'stock_locations', f.tenant);
    assert.equal(rows.length, 9);
    const stocks = own169(await facts169(), 'stock', f.tenant);
    const lines = rows.map(bin => ({ product_id: bin.product_id, warehouse_id: bin.warehouse_id,
      location: bin.location, quantity: bin.quantity,
      stock_version: String(one(stocks.filter(s => s.product_id === bin.product_id && s.warehouse_id === bin.warehouse_id)).version),
      lot_code: 'CNT-' + randomUUID(), unit_cost_minor: one(f.products.filter(p => p.id === bin.product_id)).cost }));
    const opening = (await f.ok('/wms-lots/opening-previews', 'POST', { client_key: randomUUID(),
      policy_version: '0', currency: 'PLN', note: 'Actual whole tenant count opening0/1000/NULL', lines }, 201)).preview;
    assert.equal(opening.ready, true);
    await f.ok('/wms-lots/opening-previews/' + opening.id + '/activate', 'POST', {
      client_key: randomUUID(), scope_hash: opening.scope_hash, confirmed: true, ack_unknown_costs: true }, 201);
  }
  const catalog = one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1', [f.tenant])).rows).catalog_id as string;
  const publicReply = await f.ok('/catalog-stock-control/catalogs/' + catalog + '/source');
  assert.equal(publicReply.writers_available, false); assert.equal(publicReply.activation_available, false);
  const baseline = await facts169(), context = { writersAvailable: true };
  const { source } = await sourceCatalogStockControl(f.actor, catalog, context);
  assert.equal(source.ready, true, JSON.stringify(source.blockers));
  const { preview } = await previewCatalogStockControl(f.actor, catalog, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version, policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: Row) => ({ warehouse_id: w.id, version: w.series.version })),
  }, context);
  const activated = await commitCatalogStockControl(f.actor, preview.id, consent169(preview), context);
  assert.equal(activated.operation.after.strict, true); physicalExact169(baseline, await facts169());
  return { ...f, on, second, catalog };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Protocol = 'inventory_bulk'|'stock_file';

async function bulk(f: Fixture) {
  const state = await facts169(), stocks = own169(state, 'stock', f.tenant), products = own169(state, 'products', f.tenant);
  const rows = f.products.flatMap(p => ['A-01','B-02'].map(location => ({ product_id: p.id,
    product_version: one(products.filter(r => r.id === p.id)).version,
    stock_version: String(one(stocks.filter(r => r.product_id === p.id && r.warehouse_id === f.warehouse.id)).version),
    location, operation: 'count', quantity: location === 'A-01' ? 1 : 3 })));
  const before = await facts169();
  const { preview } = await f.ok('/inventory-bulk-edit/previews', 'POST', {
    client_key: randomUUID(), warehouse_id: f.warehouse.id,
    note: 'Genuine two-bin count; net0 does not erase physical PW/RW', rows }, 201);
  assert.equal(preview.ready, true); assert.equal(preview.changed, 6); physicalExact169(before, await facts169());
  return { protocol: 'inventory_bulk' as const, preview,
    path: '/inventory-bulk-edit/previews/' + preview.id + '/execute', body: consent169(preview) };
}

async function file(f: Fixture) {
  const baseline = await facts169(), positions = own169(baseline, 'wms_layer_positions', f.tenant);
  const layers = own169(baseline, 'wms_cost_layers', f.tenant);
  const lot = (p: Row, warehouse: string, location: string) => {
    const position = one(positions.filter(r => r.product_id === p.id && r.warehouse_id === warehouse && r.location === location));
    return one(layers.filter(r => r.id === position.layer_id)).lot_id;
  };
  const targets = [f.warehouse, f.second].map((w, i) => ({ warehouse_id: w.id,
    quantity_scope: 'position', default_location: i === 0 ? 'A-01' : 'B-01',
    mapping: { quantity: 'Q' + i, ...(f.on ? { lot_id: 'L' + i, unit_cost_minor: 'C' + i, currency: 'V' + i } : {}) } }));
  const content = f.on ? 'SKU;Q0;L0;C0;V0;Q1;L1;C1;V1\n' + f.products.map(p =>
    `${p.sku};1;${lot(p,f.warehouse.id,'A-01')};;;3;${lot(p,f.second.id,'B-01')};${p.cost ?? '1000'};PLN`).join('\n')
    : 'SKU;Q0;Q1\n' + f.products.map(p => `${p.sku};1;3`).join('\n');
  const { preview } = await f.ok('/stock-file-imports/previews', 'POST', {
    client_key: randomUUID(), file_name: 'strict-own-count169.csv', note: 'Actual two warehouse count, no stock reseed', content,
    definition: { format: 'csv', xml_mode: 'positions', delimiter: ';', identity: 'sku', identity_field: 'SKU',
      spreadsheet_safe: false, empty_policy: 'skip' }, targets, resolutions: [] }, 201);
  assert.equal(preview.summary.changed, 6); assert.equal(preview.summary.invalid, 0); assert.equal(preview.summary.conflicts, 0);
  physicalExact169(baseline, await facts169());
  const body = { ...consent169(preview), ack_unknown_loss_warehouse_ids: f.on ? [f.warehouse.id] : [],
    ack_surplus_warehouse_ids: f.on ? [f.second.id] : [] };
  return { protocol: 'stock_file' as const, preview, body,
    path: '/stock-file-imports/previews/' + preview.id + '/execute' };
}
type Prepared = Awaited<ReturnType<typeof bulk>>|Awaited<ReturnType<typeof file>>;

function added(a: Facts, b: Facts, table: string): Row[] {
  const pk = primaryKeys.get(table); assert(pk?.length, 'Actual persisted primary key: ' + table);
  const key = (row: Row) => JSON.stringify(pk.map(field => {
    assert(Object.hasOwn(row, field), `${table}.${field} exists`); return row[field];
  }));
  const old = raw169(a, table), now = raw169(b, table), keys = new Set(old.map(key));
  assert.equal(keys.size, old.length); assert.equal(new Set(now.map(key)).size, now.length);
  assert.deepEqual(b[table].filter(x => keys.has(key(x.row))), a[table], 'Exact old append rows, actual compound PK: ' + table);
  return now.filter(row => !keys.has(key(row)));
}
function expectedBins(f: Fixture, d: Prepared) {
  return f.products.flatMap(p => d.protocol === 'inventory_bulk'
    ? [{ warehouse_id: f.warehouse.id, product_id: p.id, location: 'A-01', delta: -1 },
       { warehouse_id: f.warehouse.id, product_id: p.id, location: 'B-02', delta: 1 }]
    : [{ warehouse_id: f.warehouse.id, product_id: p.id, location: 'A-01', delta: -1 },
       { warehouse_id: f.second.id, product_id: p.id, location: 'B-01', delta: 1 }]);
}
const tuple = (row: Row) => [row.warehouse_id,row.product_id,row.location,row.delta];

function preserve(a: Facts, b: Facts, f: Fixture, d: Prepared) {
  const append = new Set(['stock_movements','stock_location_movements','stock_location_operations',
    'purchasing_stock_changes','audit_events','catalog_stock_control_series','catalog_stock_control_counters',
    'catalog_stock_control_effect_admissions','catalog_stock_control_effects','catalog_stock_control_effect_journals',
    'catalog_stock_count_admissions','catalog_stock_count_receipts','catalog_stock_count_documents',
    'catalog_stock_count_rows','catalog_stock_count_bin_maps','catalog_stock_count_stock_maps','catalog_stock_count_layer_maps','catalog_stock_count_native_maps',
    ...(d.protocol === 'inventory_bulk' ? ['inventory_bulk_edit_executions','inventory_bulk_edit_execution_rows'] :
      ['stock_file_import_executions','stock_file_import_admissions','stock_file_import_core_witnesses',
       ...(f.on ? ['wms_stocktakes','wms_stocktake_lines','wms_stocktake_scope_layers','wms_stocktake_measurements',
         'wms_stocktake_measurement_layers','wms_stocktake_reviews','wms_stocktake_review_rows','wms_stocktake_postings',
         'wms_operations','wms_cost_layers','wms_layer_movements'] :
         ['inventory_bulk_edit_previews','inventory_bulk_edit_rows','inventory_bulk_edit_executions','inventory_bulk_edit_execution_rows'])])]);
  const mutable = new Set(['stock','stock_locations', ...(f.on ? ['wms_layer_positions'] : [])]);
  assert.deepEqual(Object.keys(b), Object.keys(a));
  for (const name of Object.keys(a)) {
    assert.deepEqual(b[name].filter(x => x.row.tenant_id !== f.tenant), a[name].filter(x => x.row.tenant_id !== f.tenant),
      'All foreign/global rows and sessions exact: ' + name);
    if (append.has(name)) assert(added(a,b,name).every(row => row.tenant_id === f.tenant), 'Only explicit own append: ' + name);
    else if (!mutable.has(name)) assert.deepEqual(b[name], a[name], 'No undeclared own changes or second source: ' + name);
  }
  for (const name of Object.keys(a).filter(n => n.startsWith('stocktake_adjustment_')))
    assert.deepEqual(b[name], a[name], 'No fake149 adjustment head, receipt, series or source: ' + name);
  const expected = expectedBins(f,d);
  assert.deepEqual(sort169(added(a,b,'stock_location_movements').map(tuple)), sort169(expected.map(tuple)));
  assert.deepEqual(sort169(added(a,b,'stock_movements').map(r => [r.warehouse_id,r.product_id,r.delta])),
    sort169(expected.map(r => [r.warehouse_id,r.product_id,r.delta])));
  assert.equal(added(a,b,'stock_location_movements').length,6); assert.equal(added(a,b,'stock_movements').length,6);
  for (const old of own169(a,'stock_locations',f.tenant)) {
    const now = one(own169(b,'stock_locations',f.tenant).filter(r => r.warehouse_id===old.warehouse_id && r.product_id===old.product_id && r.location===old.location));
    const delta = expected.filter(r => r.warehouse_id===old.warehouse_id && r.product_id===old.product_id && r.location===old.location).reduce((n,r) => n+r.delta,0);
    assert.deepEqual(omit(now,['quantity']),omit(old,['quantity'])); assert.equal(now.quantity,old.quantity+delta);
  }
  assert.equal(own169(a,'stock_locations',f.tenant).length,own169(b,'stock_locations',f.tenant).length);
  for (const old of own169(a,'stock',f.tenant)) {
    const now = one(own169(b,'stock',f.tenant).filter(r => r.warehouse_id===old.warehouse_id && r.product_id===old.product_id));
    const changes = expected.filter(r => r.warehouse_id===old.warehouse_id && r.product_id===old.product_id);
    assert.deepEqual(omit(now,['on_hand','available','version']),omit(old,['on_hand','available','version']));
    assert.equal(now.on_hand,old.on_hand+changes.reduce((n,r)=>n+r.delta,0)); assert.equal(now.available,now.on_hand-now.reserved);
    assert.equal(BigInt(now.version),BigInt(old.version)+BigInt(changes.length));
  }
  assert.equal(own169(a,'stock',f.tenant).length,own169(b,'stock',f.tenant).length);
  assert.equal(added(a,b,'purchasing_stock_changes').length,f.on ? 4 : 12,
    'ON two batched postings, OFF six per-row native operations; each has one099 update and one100 journal statement');
  assert.equal(added(a,b,'wms_layer_movements').length,f.on ? 6 : 0);
  if (!f.on) for (const table of Object.keys(a).filter(n => n.startsWith('wms_')))
    assert.deepEqual(b[table],a[table],'OFF has no invented operation/layer/value: '+table);
}

async function prove(f: Fixture, d: Prepared, a: Facts, result: Row) {
  const b = await facts169(); preserve(a,b,f,d);
  const execution = result.execution; assert(execution); assert.equal(result.reused,false);
  const receipt = one(added(a,b,'catalog_stock_count_receipts'));
  const admission = one(added(a,b,'catalog_stock_count_admissions'));
  assert.equal(receipt.admission_id,admission.id); assert.equal(admission.count_receipt_id,receipt.id);
  assert.equal(admission.tenant_id,f.tenant); assert.equal(admission.actor_id,f.user);
  assert.equal(admission.api_key_id,null); assert.equal(admission.protocol,d.protocol); assert.equal(admission.source_id,d.preview.id);
  assert.deepEqual(admission.request,d.body); assert.equal(admission.sealed,true);
  assert.equal(receipt.inventory_execution_id,d.protocol==='inventory_bulk' ? execution.id : null);
  assert.equal(receipt.stock_file_execution_id,d.protocol==='stock_file' ? execution.id : null);
  const nativeTable = d.protocol==='inventory_bulk' ? 'inventory_bulk_edit_executions' : 'stock_file_import_executions';
  const native = one(added(a,b,nativeTable).filter(row => row.id===execution.id));
  assert.equal(native.preview_id,d.preview.id); assert.equal(native.actor_id,f.user); assert.equal(native.client_key,d.body.client_key);
  if (d.protocol==='stock_file') assert.deepEqual(native.payload.execute_request,d.body);
  const effectAdmission = one(added(a,b,'catalog_stock_control_effect_admissions'));
  assert.equal(effectAdmission.id,admission.id); assert.equal(effectAdmission.source_kind,'inventory_import');
  assert.equal(effectAdmission.source_id,receipt.id); assert.equal(effectAdmission.sealed,true);
  assert.equal(String(effectAdmission.txid),String(admission.txid));
  const effect = one(added(a,b,'catalog_stock_control_effects'));
  assert.equal(effect.admission_id,admission.id);
  for (const key of ['warehouse_document_id','purchase_receipt_id','dispatch_receipt_id','adjustment_receipt_id','location_operation_id'])
    assert.equal(effect[key],null,'Do not forge an unrelated native source: '+key);
  const witnesses = added(a,b,'catalog_stock_control_effect_journals');
  for (const [kind,table,field] of [['stock','stock_movements','stock_movement_id'],['bin','stock_location_movements','location_movement_id'],['layer','wms_layer_movements','layer_movement_id']] as const) {
    const journals=added(a,b,table), rows=witnesses.filter(row=>row.kind===kind);
    assert.deepEqual(rows.map(row=>row.journal_id).sort(),ids(journals));
    assert(rows.every(row=>row.admission_id===admission.id && row[field]===row.journal_id));
  }
  const documents = added(a,b,'catalog_stock_count_documents'), rows = added(a,b,'catalog_stock_count_rows');
  assert.equal(documents.length,2); assert.equal(rows.length,6);
  assert.equal(added(a,b,'catalog_stock_control_series').length,2); assert.equal(added(a,b,'catalog_stock_control_counters').length,2);
  const expected = d.protocol==='inventory_bulk' ? [[f.warehouse.id,'PW'],[f.warehouse.id,'RW']] : [[f.warehouse.id,'RW'],[f.second.id,'PW']];
  assert.deepEqual(sort169(documents.map(doc=>[doc.warehouse_id,doc.kind])),sort169(expected));
  for (const doc of documents) {
    assert.equal(doc.receipt_id,receipt.id);
    const series = one(own169(b,'catalog_stock_control_series',f.tenant).filter(s=>s.id===doc.series_id));
    assert.equal(series.kind,doc.kind); assert.equal(series.warehouse_id,doc.warehouse_id);
    assert.equal(doc.number,`${series.prefix}/${doc.year}/${String(doc.sequence).padStart(6,'0')}`);
    const counter = one(own169(b,'catalog_stock_control_counters',f.tenant).filter(c=>c.series_id===doc.series_id && c.year===doc.year));
    assert.equal(String(counter.value),String(doc.sequence)); assert.equal(String(doc.sequence),'1');
    const entries=rows.filter(row=>row.document_id===doc.id).sort((x,y)=>x.ordinal-y.ordinal);
    assert.deepEqual(entries.map(row=>row.ordinal),[0,1,2]);
    for (const row of entries) {
      assert.equal(row.warehouse_id,doc.warehouse_id); assert.equal(row.delta,doc.kind==='PW' ? 1 : -1);
      if(f.on) {
        assert.equal(row.bin_movement_id,null,'ON signed rows identify real layer journals; net bins have separate allocations');
        const journal=one(added(a,b,'wms_layer_movements').filter(j=>j.id===row.layer_movement_id));
        assert.deepEqual(tuple(journal),tuple(row));
      } else {
        const bin = one(added(a,b,'stock_location_movements').filter(j=>j.id===row.bin_movement_id));
        assert.deepEqual(tuple(bin),tuple(row));
      }
    }
  }
  if(f.on) assert.deepEqual(rows.map(row=>row.layer_movement_id).sort(),ids(added(a,b,'wms_layer_movements')));
  else assert.deepEqual(rows.map(row=>row.bin_movement_id).sort(),ids(added(a,b,'stock_location_movements')));
  const binMaps=added(a,b,'catalog_stock_count_bin_maps');assert.equal(binMaps.length,f.on ? 6 : 0);
  if(f.on) {
    for(const mapping of binMaps) {
      const row=one(rows.filter(r=>r.id===mapping.row_id)),bin=one(added(a,b,'stock_location_movements').filter(j=>j.id===mapping.bin_movement_id));
      assert.equal(mapping.quantity,Math.abs(row.delta));assert.deepEqual(tuple(bin),tuple(row));
    }
    assert.deepEqual(binMaps.map(m=>m.bin_movement_id).sort(),ids(added(a,b,'stock_location_movements')),'Every actual net bin journal allocated once');
  }
  const maps = added(a,b,'catalog_stock_count_native_maps'); assert.equal(maps.length,6);
  for (const row of rows) {
    const mapping = one(maps.filter(m=>m.row_id===row.id)); assert.equal(mapping.quantity,Math.abs(row.delta));
    assert.equal(mapping.inventory_execution_id,d.protocol==='inventory_bulk' ? execution.id : null);
    assert.equal(mapping.stock_file_execution_id,d.protocol==='stock_file' ? execution.id : null);
    const parentRow = d.protocol==='inventory_bulk'
      ? one(own169(b,'inventory_bulk_edit_execution_rows',f.tenant).filter(r=>r.execution_id===execution.id && r.index===mapping.inventory_row_index))
      : one(native.payload.rows.filter((r:Row)=>r.index===mapping.source_index));
    assert.equal(parentRow.product_id,row.product_id); assert.equal(parentRow.location,row.location);
    if (d.protocol==='stock_file') assert.equal(parentRow.warehouse_id,row.warehouse_id);
    else assert.equal(mapping.inventory_row_index,mapping.source_index);
    if(f.on) {
      assert.equal(row.source_index,mapping.source_index);assert.equal(row.stocktake_line_id,parentRow.line_id);
      assert.equal(parentRow.input.quantity-parentRow.before.quantity,row.delta);
      const line=one(added(a,b,'wms_stocktake_lines').filter(l=>l.id===row.stocktake_line_id));
      assert.equal(line.product_id,row.product_id);assert.equal(line.location,row.location);assert.equal(line.lot_id,parentRow.lot.id);
    }
  }
  const stockMaps=added(a,b,'catalog_stock_count_stock_maps'); assert.equal(stockMaps.length,6);
  for (const mapping of stockMaps) {
    const row=one(rows.filter(r=>r.id===mapping.row_id)), journal=one(added(a,b,'stock_movements').filter(j=>j.id===mapping.stock_movement_id));
    assert.equal(mapping.quantity,1); assert.equal(journal.product_id,row.product_id); assert.equal(journal.warehouse_id,row.warehouse_id);
    assert.equal(Math.sign(journal.delta),Math.sign(row.delta));
  }
  assert.deepEqual(stockMaps.map(m=>m.stock_movement_id).sort(),ids(added(a,b,'stock_movements')));
  const layerMaps=added(a,b,'catalog_stock_count_layer_maps'); assert.equal(layerMaps.length,f.on ? 6 : 0);
  if (f.on) {
    assert.equal(added(a,b,'wms_operations').length,2); assert.equal(added(a,b,'wms_stocktake_postings').length,2);
    assert.equal(added(a,b,'wms_cost_layers').length,3,'Only declared surplus creates three real layers');
    for (const mapping of layerMaps) {
      const row=one(rows.filter(r=>r.id===mapping.row_id)), journal=one(added(a,b,'wms_layer_movements').filter(j=>j.id===mapping.layer_movement_id));
      assert.equal(mapping.quantity,1); assert.deepEqual(tuple(journal),tuple(row));
      const layer=one(own169(b,'wms_cost_layers',f.tenant).filter(l=>l.id===journal.layer_id));
      assert.equal(layer.warehouse_document_id,null); assert.equal(layer.product_id,row.product_id);
      const product=one(f.products.filter(p=>p.id===row.product_id));
      const expectedCost=row.delta<0 ? product.cost : product.cost ?? '1000';
      assert.equal(layer.unit_cost_minor===null ? null : String(layer.unit_cost_minor),expectedCost);
      assert.equal(journal.value_delta===null ? null : String(journal.value_delta),expectedCost===null ? null : String(BigInt(expectedCost)*BigInt(row.delta)));
      if (row.delta<0) assert.deepEqual(layer,one(own169(a,'wms_cost_layers',f.tenant).filter(l=>l.id===layer.id)),'Shortage retains genuine original frozen0/1000/NULL provenance');
      const posting=one(added(a,b,'wms_stocktake_postings').filter(p=>p.operation_id===journal.operation_id));
      assert.equal(row.layer_movement_id,journal.id);assert.equal(row.stocktake_posting_id,posting.id);
      const line=one(added(a,b,'wms_stocktake_lines').filter(l=>l.id===row.stocktake_line_id));
      assert.equal(line.stocktake_id,posting.stocktake_id);assert.equal(line.product_id,row.product_id);assert.equal(line.location,row.location);
      assert.equal(line.lot_id,layer.lot_id);
      const operation=one(added(a,b,'wms_operations').filter(o=>o.id===posting.operation_id));
      assert.equal(operation.warehouse_document_id,null);assert.equal(operation.stocktake_posting_id,posting.id);
      const actualRow=one(operation.result.rows.filter((r:Row)=>r.line_id===line.id));
      assert.equal(actualRow.product_id,row.product_id);assert.equal(actualRow.location,row.location);assert.equal(actualRow.lot_id,layer.lot_id);
      assert.equal(actualRow.delta,row.delta);const fragment=one(actualRow.fragments);
      assert.equal(fragment.id,journal.id);assert.equal(fragment.layer_id,layer.id);assert.equal(fragment.delta,row.delta);assert.equal(fragment.quantity,1);
      assert.equal(fragment.unit_cost_minor,expectedCost);
      assert.equal(fragment.value_delta===null?null:String(fragment.value_delta),journal.value_delta===null?null:String(journal.value_delta));
      assert(native.payload.links.some((link:Row)=>link.posting_id===posting.id && link.operation_id===journal.operation_id && link.warehouse_id===row.warehouse_id));
      assert.equal(mapping.payload.layer_id,layer.id); assert.equal(mapping.payload.lot_id,layer.lot_id);
      assert.equal(mapping.payload.operation_id,journal.operation_id);
      assert.equal(mapping.payload.unit_cost_minor,expectedCost);
      assert.equal(mapping.payload.value_minor,expectedCost,'Allocation is absolute one-unit PW/RW value; signed value remains in its real journal');
      assert.equal(mapping.payload.currency,layer.currency); assert.equal(mapping.payload.exponent,layer.exponent);
    }
    assert.deepEqual(layerMaps.map(m=>m.layer_movement_id).sort(),ids(added(a,b,'wms_layer_movements')));
    const oldPositions=own169(a,'wms_layer_positions',f.tenant), positions=own169(b,'wms_layer_positions',f.tenant);
    for (const old of oldPositions) {
      const now=one(positions.filter(p=>p.layer_id===old.layer_id && p.warehouse_id===old.warehouse_id && p.location===old.location));
      const loss=old.warehouse_id===f.warehouse.id && old.location==='A-01' ? 1 : 0;
      assert.deepEqual(omit(now,['quantity','version']),omit(old,['quantity','version']));
      assert.equal(now.quantity,old.quantity-loss); assert.equal(BigInt(now.version),BigInt(old.version)+BigInt(loss));
    }
    const oldLayers=new Set(oldPositions.map(p=>p.layer_id));
    const newPositions=positions.filter(p=>!oldLayers.has(p.layer_id)); assert.equal(newPositions.length,3);
    assert(newPositions.every(p=>p.warehouse_id===f.second.id && p.location==='B-01' && p.quantity===1 && p.reserved===0));
  }
  assert(Array.isArray(execution.stock_count_documents),'Public native execution must expose genuine saved PW/RW heads');
  assert.deepEqual(execution.stock_count_documents.map((head:Row)=>head.id).sort(),ids(documents));
  for (const head of execution.stock_count_documents as Row[]) {
    const saved=one(documents.filter(doc=>doc.id===head.id));
    for (const key of ['id','receipt_id','warehouse_id','kind','number','series_id','year']) assert.equal(head[key],saved[key]);
    assert.equal(head.source_id,d.preview.id); assert.equal(head.protocol,d.protocol); assert.equal(head.sequence,String(saved.sequence));
    assert.equal(head.quantity,'3'); assert.equal(head.row_count,3); assert.equal(head.wms_enabled,f.on);
  }
  return b;
}

async function replayAndReads(f: Fixture,d:Prepared,result:Row,accepted:Facts) {
  const again=await f.ok(d.path,'POST',d.body,200);
  assert.equal(again.reused,true); assert.equal(again.execution.id,result.execution.id);
  assert.deepEqual(again.execution.stock_count_documents,result.execution.stock_count_documents);
  assert.deepEqual(await facts169(),accepted,'Literal replay adds no native/count admission, PW/RW, number, marker, audit, stock or auth row');
  const module=d.protocol==='inventory_bulk' ? '/inventory-bulk-edit' : '/stock-file-imports';
  const detail=await f.ok(module+'/executions/'+result.execution.id);
  assert.deepEqual(detail.execution.stock_count_documents,result.execution.stock_count_documents);
  const history=await f.ok(module+'/executions');
  const head=one(history.data.filter((row:Row)=>row.id===result.execution.id));
  assert.deepEqual(head.stock_count_documents,result.execution.stock_count_documents);
  let cursor:string|null=null; const nativeRows:Row[]=[];
  do {
    const page=await f.ok(module+'/executions/'+result.execution.id+'/rows'+(cursor===null?'':'?cursor='+encodeURIComponent(cursor)));
    const rows:Row[]=d.protocol==='inventory_bulk' ? page.data : page.rows;
    assert(rows.length<=50); nativeRows.push(...rows);
    const next=d.protocol==='inventory_bulk' ? page.meta.cursor : page.next_cursor;
    assert(next===null || next===undefined || (typeof next==='string' && next!==cursor)); cursor=next??null;
  } while(cursor!==null);
  assert.equal(nativeRows.length,6); assert.equal(new Set(nativeRows.map(row=>row.index)).size,6);
  assert.deepEqual(await facts169(),accepted,'All native detail/history/fullrows and heading reads are completely pure');
  const altered=await f.request(d.path,'POST',{...d.body,scope_hash:'0'.repeat(64)});
  assert.equal(altered.statusCode,409,altered.body); assert.deepEqual(await facts169(),accepted);
  const other=await f.request(d.path,'POST',{...d.body,client_key:randomUUID()});
  assert.equal(other.statusCode,409,other.body); assert.deepEqual(await facts169(),accepted);
}

test('strict086 OFF two-bin net0 bulk publishes genuine one PW/RW per WH/kind with true execution row FKs and no second writer',async()=>{
  const f=await fixture(false),d=await bulk(f),before=await facts169();
  const result=await f.ok(d.path,'POST',d.body,201),accepted=await prove(f,d,before,result);
  assert.equal(added(before,accepted,'inventory_bulk_edit_executions').length,1);
  assert.equal(added(before,accepted,'inventory_bulk_edit_execution_rows').length,6);
  assert.equal(added(before,accepted,'stock_location_operations').length,6);
  await replayAndReads(f,d,result,accepted);
});

for (const on of [false,true]) test(`strict115/116 ${on?'ON':'OFF'} two-WH file count publishes PW/RW over real native child graphs,0/NULL provenance and exact replay`,async()=>{
  const f=await fixture(on),d=await file(f),before=await facts169();
  const result=await f.ok(d.path,'POST',d.body,201),accepted=await prove(f,d,before,result);
  assert.equal(added(before,accepted,'stock_file_import_executions').length,1);
  assert.equal(added(before,accepted,'stock_file_import_admissions').length,1);
  assert.equal(added(before,accepted,'stock_file_import_core_witnesses').length,4);
  if(on) {
    const stocktakes=added(before,accepted,'wms_stocktakes'); assert.equal(stocktakes.length,2);
    assert(stocktakes.every(s=>s.state==='posted' && result.execution.links.some((link:Row)=>link.stocktake_id===s.id && link.posting_id===s.posting_id)));
    assert.equal(added(before,accepted,'wms_stocktake_lines').length,6);
  } else {
    const children=added(before,accepted,'inventory_bulk_edit_executions'); assert.equal(children.length,2);
    assert(children.every(child=>result.execution.links.some((link:Row)=>link.core_execution_id===child.id && link.core_preview_id===child.preview_id)));
    assert.equal(added(before,accepted,'stock_location_operations').length,6);
  }
  await replayAndReads(f,d,result,accepted);
});

test('direct086 bulk remains truthful OFF-only: ON quantity count refusal creates no native or strict publisher effects',async()=>{
  const f=await fixture(true),d=await bulk(f),before=await facts169();
  const response=await f.request(d.path,'POST',d.body);
  assert.equal(response.statusCode,409,response.body);
  assert.deepEqual(await facts169(),before,'Use real115 ON source; a refused native quantity writer is not made valid by strict document publication');
});

for (const on of [false,true]) test(`strict115/116 ${on?'ON':'OFF'} rejects malformed consent, foreign source and actual stale product basis atomically`,async()=>{
  const f=await fixture(on),d=await file(f),before=await facts169();
  for(const body of [{...d.body,confirmed:false},{...d.body,allow_partial:true}]) {
    const reply=await f.request(d.path,'POST',body); assert.equal(reply.statusCode,422,reply.body);
    assert.deepEqual(await facts169(),before,'Invalid body is not a partial import or manufactured PW/RW');
  }
  const badScope=await f.request(d.path,'POST',{...d.body,scope_hash:'f'.repeat(64)});
  assert.equal(badScope.statusCode,409,badScope.body); assert.deepEqual(await facts169(),before);
  const foreign=await fixture(false),foreignBefore=await facts169();
  const missing=await foreign.request(d.path,'POST',d.body);
  assert.equal(missing.statusCode,404,missing.body); assert.deepEqual(await facts169(),foreignBefore,'Foreign source does not expose heads or write either tenant');
  const product=await f.ok('/products/'+f.products[0].id);
  // Native editSchema is a full catalog edit: price is required and the
  // remaining saved metadata must not be silently reset to schema defaults.
  await f.ok('/products/'+product.id,'PATCH',{...product,name:'Changed actual frozen count metadata'});
  const stale=await facts169(),response=await f.request(d.path,'POST',d.body);
  assert.equal(response.statusCode,409,response.body); assert.deepEqual(await facts169(),stale,'Product/source CAS failure retains every row/session and both real WH quantities');
});

test('terminal failure after real115 ON parents and count receipt rolls back both WH, native children, all PW/RW numbers and all global rows',async()=>{
  const f=await fixture(true),d=await file(f);
  // Observe the actual completed count in its own transaction, then make a
  // genuine SQL statement fail before its outer transaction can be committed.
  // No trigger/function is added: changing typed schema would invalidate its
  // manifest during prepare and would never exercise the completed graph.
  const originalQuery=Client.prototype.query;
  let faultReached=false;
  const before=await facts169(); injectedFailure=null;
  Client.prototype.query=function(this:Client,...args:any[]) {
    const result=(originalQuery as any).apply(this,args);
    const text=typeof args[0]==='string' ? args[0] : args[0]?.text;
    if (text==='SELECT public.catalog_stock_count_finish($1,$2,$3,$4::jsonb) receipt' && args[1]?.[0]===f.user) {
      return Promise.resolve(result).then(async answer=>{
        const graph=(await (originalQuery as any).call(this,`SELECT
          (SELECT count(*)::integer FROM public.catalog_stock_count_receipts r JOIN public.stock_file_import_executions e
            ON(e.tenant_id,e.id)=(r.tenant_id,r.stock_file_execution_id) WHERE r.tenant_id=$1) receipts,
          (SELECT count(*)::integer FROM public.wms_stocktake_postings WHERE tenant_id=$1) postings,
          (SELECT count(*)::integer FROM public.catalog_stock_count_documents WHERE tenant_id=$1) documents,
          (SELECT count(*)::integer FROM public.catalog_stock_count_admissions WHERE tenant_id=$1 AND sealed) sealed`,[f.tenant])).rows[0];
        assert.deepEqual(graph,{receipts:1,postings:2,documents:2,sealed:1},'Fault follows real native parents and sealed count publication');
        assert.equal(faultReached,false,'Single actual finish, not a retry');faultReached=true;
        try {
          await (originalQuery as any).call(this,"DO $$BEGIN RAISE EXCEPTION 'COUNT169_INJECTED_TERMINAL_FAILURE' USING ERRCODE='23514'; END$$");
        } catch(error) {
          // Record the actual PostgreSQL failure before its ordinary owner
          // bridge maps23514 to the public409 response. Do not replace it.
          const original=error as Error & {code?:string};
          injectedFailure={code:original.code,message:original.message.slice(0,200)};
          throw error;
        }
        return answer;
      });
    }
    return result;
  } as typeof Client.prototype.query;
  try {
    const response=await f.request(d.path,'POST',d.body);
    assert.equal(response.statusCode,409,response.body);
    assert.equal(faultReached,true,'The single HTTP execute reached its complete native/count graph');
    // TypeScript cannot model the awaited driver's callback assignment across
    // the earlier explicit null reset.
    const observed = injectedFailure as { code?: string; message: string }|null;
    assert(observed,'Actual single HTTP request reached the declared terminal SQL fault');
    assert.equal(observed.code,'23514'); assert.equal(observed.message,'COUNT169_INJECTED_TERMINAL_FAILURE');
    assert.deepEqual(await facts169(),before,'Entire native/count/counter/stock/bin/layer/markers/audit/auth graph rolls back, not only documents');
  } finally {
    Client.prototype.query=originalQuery;
  }
});
