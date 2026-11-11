import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import { stocktakeAdjustmentFixture, countedAdjustmentSource, type AdjustmentFixture } from './stocktake-adjustments-fixture';
import { bootstrap151169, install152169, facts169, raw169, own169, physicalExact169,
  consent169, sort169, type Facts, type Row } from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Root executes in one fresh numeric scratch DB.
// Internal BO consent is the existing candidate gate, not public activation.
// All counts/reviews/PW-RW posting use ordinary149 HTTP, never legacy directpost.
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
before(async () => {
  await bootstrap151169(); await seed(); await install152169();
  app = await buildApp({ integrationTransport: async () => {
    providerCalls++; throw new Error('No provider in strict stocktake169');
  } });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });
const prefix = '/stocktake-adjustments';
const one = (xs: Row[]) => { assert.equal(xs.length, 1); return xs[0]; };
const ids = (xs: Row[]) => xs.map(x => x.id).sort();
function added(a: Facts, b: Facts, table: string): Row[] {
  const uuid = (v: unknown) => { assert.equal(typeof v,'string'); assert.match(v as string,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/); return v as string; };
  const key = (row: Row): string => {
    // These three relations have compound primary keys, not an id column.
    if (table === 'catalog_stock_control_effect_journals') {
      assert(['stock','bin','layer'].includes(row.kind));
      return JSON.stringify([uuid(row.tenant_id),uuid(row.admission_id),row.kind,uuid(row.journal_id)]);
    }
    if (table === 'catalog_stock_control_effects') return JSON.stringify([uuid(row.tenant_id),uuid(row.admission_id)]);
    if (table === 'stocktake_adjustment_document_rows') {
      assert(Number.isInteger(row.ordinal) && row.ordinal >= 0);
      return JSON.stringify([uuid(row.tenant_id),uuid(row.document_id),row.ordinal]);
    }
    //099 declares this sole marker identity as bigserial rather than UUID.
    if (table === 'purchasing_stock_changes') { assert.match(String(row.id),/^[1-9][0-9]*$/); return String(row.id); }
    return uuid(row.id);
  };
  const oldRows = raw169(a,table), newRows = raw169(b,table);
  const old = new Set(oldRows.map(key)); assert.equal(old.size,oldRows.length,'Unique old primary keys: ' + table);
  assert.equal(new Set(newRows.map(key)).size,newRows.length,'Unique current primary keys: ' + table);
  assert.deepEqual(b[table].filter(x => old.has(key(x.row))), a[table], 'Every old append row exact: ' + table);
  return newRows.filter(x => !old.has(key(x)));
}
const omit = (row: Row, fields: string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));

async function activate(f: AdjustmentFixture) {
  const catalogIds = (await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1 ORDER BY catalog_id', [f.tenant])).rows;
  assert.equal(catalogIds.length, 1); const catalogId: string = catalogIds[0].catalog_id;
  const publicSource = await f.ok('/catalog-stock-control/catalogs/' + catalogId + '/source');
  assert.equal(publicSource.writers_available, false); assert.equal(publicSource.activation_available, false);
  const baseline = await facts169(), context = { writersAvailable: true };
  const { source } = await sourceCatalogStockControl(f.actor, catalogId, context);
  assert.equal(source.ready, true, JSON.stringify(source.blockers)); assert.deepEqual(source.blockers, []);
  const { preview } = await previewCatalogStockControl(f.actor, catalogId, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version, policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.series.version })),
  }, context);
  assert.equal(preview.ready, true);
  const result = await commitCatalogStockControl(f.actor, preview.id, consent169(preview), context);
  assert.equal(result.operation.after.strict, true); physicalExact169(baseline, await facts169());
  return catalogId;
}

async function prepare(on: boolean, mode: 'mixed'|'shortage') {
  const f = await stocktakeAdjustmentFixture(app, on);
  // BO must precede the genuine open stocktake; no blocker bypass.
  const catalogId = await activate(f), series: Record<string, Row> = {};
  for (const kind of ['PW', 'RW']) series[kind] = (await f.ok(prefix + '/series', 'POST', {
    client_key: randomUUID(), kind, name: 'Actual strict ' + kind,
    prefix: kind + randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase(),
  }, 201)).series;
  const source = await countedAdjustmentSource(f, mode, true);
  const request = { client_key: randomUUID(), source_kind: source.source_kind, stocktake_id: source.id, version: source.version,
    ...(on ? { review_id: source.review_id, scope_hash: source.scope_hash } : { review_hash: source.review_hash }),
    ...(mode === 'mixed' ? { pw_series_id: series.PW.id } : {}), rw_series_id: series.RW.id,
  };
  const beforePreview = await facts169();
  const { preview } = await f.ok(prefix + '/previews', 'POST', request, 201);
  assert.equal(preview.can_post, true); assert.equal(preview.receipt_id, null);
  assert.equal(preview.snapshot.row_count, mode === 'mixed' ? 6 : 3);
  physicalExact169(beforePreview, await facts169());
  return { f, catalogId, series, source, preview, postBody: consent169(preview) };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

async function documentRows(f: AdjustmentFixture, id: string, count: number) {
  const rows: Row[] = []; let cursor: string|null = null;
  do {
    const page = await f.ok(prefix + '/documents/' + id + '/rows?limit=1' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)));
    assert.equal(page.meta.total, count); assert.equal(page.data.length, 1);
    rows.push(...page.data); assert(rows.length <= count);
    const next: string|null = page.meta.cursor;
    assert(next === null || (typeof next === 'string' && next !== cursor)); cursor = next;
  } while (cursor !== null);
  assert.equal(rows.length, count); assert.deepEqual(rows.map(r => r.ordinal), Array.from({ length: count }, (_, i) => i));
  return rows;
}

function preservation(a: Facts, b: Facts, d: Prepared, receipt: Row) {
  const { f, source } = d, mixed = source.mode === 'mixed';
  assert.deepEqual(Object.keys(b), Object.keys(a));
  const counts: Record<string, number> = {
    stock_location_movements: mixed ? 6 : 3, stock_movements: mixed ? 0 : 3,
    //099 stock UPDATE is one marker;100 adds one only for actual nonzero SKU journals.
    purchasing_stock_changes: mixed ? 1 : 2, audit_events: 2,
    stocktake_adjustment_admissions: 1, stocktake_adjustment_receipts: 1,
    stocktake_adjustment_documents: mixed ? 2 : 1, stocktake_adjustment_document_rows: mixed ? 6 : 3,
    catalog_stock_control_effect_admissions: 1, catalog_stock_control_effects: 1,
    catalog_stock_control_effect_journals: f.on ? (mixed ? 12 : 9) : 6,
    ...(f.on ? { wms_operations: 1, wms_stocktake_postings: 1, wms_layer_movements: mixed ? 6 : 3,
      //All six counted lines already have genuine opening lots. Surplus
      //creates one declared-cost layer per B bin, reusing its existing lot.
      wms_lots: 0, wms_cost_layers: mixed ? 3 : 0 } : {}),
  };
  const mutable = new Set(['stock', 'stock_locations', 'stocktake_adjustment_counters',
    f.on ? 'wms_stocktakes' : 'stocktakes', ...(f.on ? ['wms_layer_positions'] : [])]);
  for (const table of Object.keys(a)) {
    assert.deepEqual(b[table].filter(x => x.row.tenant_id !== f.tenant), a[table].filter(x => x.row.tenant_id !== f.tenant),
      'Every counterpart/global/session row exact: ' + table);
    if (Object.hasOwn(counts, table)) {
      const rows = added(a, b, table); assert.equal(rows.length, counts[table], 'Exact native append count: ' + table);
      assert(rows.every(r => r.tenant_id === f.tenant));
    } else if (!mutable.has(table)) assert.deepEqual(b[table], a[table], 'No extra authority or writer: ' + table);
  }
  const stocks = own169(b, 'stock', f.tenant), oldStocks = own169(a, 'stock', f.tenant);
  assert.equal(stocks.length, oldStocks.length);
  for (const old of oldStocks) {
    const now = one(stocks.filter(r => r.warehouse_id === old.warehouse_id && r.product_id === old.product_id));
    assert.deepEqual(omit(now, ['on_hand','available','version']), omit(old, ['on_hand','available','version']));
    assert.equal(now.on_hand, old.on_hand + (mixed ? 0 : -1)); assert.equal(BigInt(now.version), BigInt(old.version) + 1n);
    assert.equal(now.available,now.on_hand-now.reserved);
    assert.equal(now.available,old.available+(mixed ? 0 : -1));
  }
  const bins = own169(b, 'stock_locations', f.tenant), oldBins = own169(a, 'stock_locations', f.tenant);
  assert.equal(bins.length, oldBins.length);
  for (const old of oldBins) {
    const now = one(bins.filter(r => r.warehouse_id === old.warehouse_id && r.product_id === old.product_id && r.location === old.location));
    const measured = source.measured.find(r => source.lines.find(l => l.id === r.id)?.product_id === old.product_id && source.lines.find(l => l.id === r.id)?.location === old.location); assert(measured);
    assert.deepEqual(omit(now, ['quantity']), omit(old, ['quantity'])); assert.equal(now.quantity, measured.quantity);
  }
  const table = f.on ? 'wms_stocktakes' : 'stocktakes', oldHead = one(own169(a, table, f.tenant)), head = one(own169(b, table, f.tenant));
  assert.equal(head.id, source.id); assert.equal(head.state, 'posted'); assert.equal(BigInt(head.version), BigInt(source.version) + 1n);
  assert.deepEqual(omit(head, f.on ? ['state','version','posting_id'] : ['state','version','posted_at','posted_by']),
    omit(oldHead, f.on ? ['state','version','posting_id'] : ['state','version','posted_at','posted_by']));
  if (f.on) assert.equal(head.posting_id, receipt.source.posting_id); else assert.equal(head.posted_by, f.user);
  const counters = own169(b, 'stocktake_adjustment_counters', f.tenant);
  assert.equal(counters.length, mixed ? 2 : 1); assert.equal(own169(a, 'stocktake_adjustment_counters', f.tenant).length, 0);
  assert(counters.every(c => String(c.sequence) === '1' && [d.series.PW.id,d.series.RW.id].includes(c.series_id)));
}

async function verify(d: Prepared, a: Facts, result: Row) {
  const { f, source } = d, b = await facts169(), receipt = result.receipt;
  assert.equal(result.reused, false); assert.deepEqual(result.documents, receipt.documents);
  assert.equal(receipt.preview_id, d.preview.id); assert.equal(receipt.scope_hash, d.preview.scope_hash);
  assert.deepEqual(receipt.request, d.postBody); assert.equal(receipt.source.stocktake_id, source.id);
  assert.equal(receipt.source.version, String(BigInt(source.version) + 1n)); assert.equal(receipt.source.state, 'posted');
  preservation(a, b, d, receipt);
  const parent = one(added(a, b, 'stocktake_adjustment_receipts')), admission = one(added(a, b, 'stocktake_adjustment_admissions'));
  assert.equal(parent.id, receipt.id); assert.equal(admission.id, parent.id); assert.equal(admission.sealed, true);
  assert.equal(parent.preview_id,d.preview.id); assert.equal(parent.source_kind,source.source_kind);
  assert.equal(parent.quantity_stocktake_id,f.on ? null : source.id); assert.equal(parent.wms_stocktake_id,f.on ? source.id : null);
  assert.equal(String(parent.source_version),receipt.source.version); assert.equal(parent.actor_id,f.user); assert.equal(parent.api_key_id,null);
  const token = one(added(a, b, 'catalog_stock_control_effect_admissions')), effect = one(added(a, b, 'catalog_stock_control_effects'));
  assert.equal(token.tenant_id, f.tenant); assert.equal(token.actor_id, f.user); assert.equal(token.api_key_id, null);
  assert.equal(token.source_kind, 'stocktake'); assert.equal(token.source_id, parent.id); assert.equal(token.sealed, true);
  assert.equal(String(token.txid),String(admission.txid),'Strict effect and true149 consent share the same native transaction');
  assert.equal(token.number, null, 'PW/RW retains149 numbering, not a second169 number');
  assert.deepEqual(token.request.warehouse_ids, [f.warehouse.id]); assert.deepEqual([...token.request.product_ids].sort(), ids(f.products));
  assert.equal(effect.admission_id, token.id); assert.equal(effect.adjustment_receipt_id, parent.id);
  assert.equal(effect.proof.receipt_id, parent.id); assert.equal(effect.warehouse_document_id, null);
  assert.equal(effect.dispatch_receipt_id, null); assert.equal(effect.purchase_receipt_id, null);
  const stock = added(a, b, 'stock_movements'), bins = added(a, b, 'stock_location_movements'), layers = added(a, b, 'wms_layer_movements');
  assert.deepEqual([...effect.proof.stock_movement_ids].sort(), ids(stock));
  assert.deepEqual([...effect.proof.location_movement_ids].sort(), ids(bins));
  assert.deepEqual([...effect.proof.layer_movement_ids].sort(), ids(layers));
  const witness = added(a, b, 'catalog_stock_control_effect_journals');
  for (const [kind, movements, field] of [['stock',stock,'stock_movement_id'],['bin',bins,'location_movement_id'],['layer',layers,'layer_movement_id']] as const) {
    const rows = witness.filter(r => r.kind === kind); assert.deepEqual(rows.map(r => r.journal_id).sort(), ids(movements));
    assert(rows.every(r => r.admission_id === token.id && r[field] === r.journal_id));
  }
  const expected = source.lines.map(line => ({ line, delta: source.measured.find(m => m.id === line.id)!.quantity - Number(line.current_quantity) })).filter(x => x.delta !== 0);
  assert.deepEqual(sort169(bins.map(j => [j.product_id,j.location,j.delta,j.kind])), sort169(expected.map(x => [x.line.product_id,x.line.location,x.delta,f.on ? 'wms_stocktake' : 'stocktake'])));
  const rows: Row[] = [];
  for (const doc of result.documents as Row[]) {
    assert.equal(doc.receipt_id, parent.id); assert.equal(doc.stocktake_id, source.id); assert.equal(doc.source_kind, source.source_kind);
    assert.equal(doc.warehouse.id, f.warehouse.id); assert.equal(doc.series_id, d.series[doc.kind].id);
    assert.equal(doc.number, `${d.series[doc.kind].prefix}/${doc.year}/000001`);
    const saved = one(added(a, b, 'stocktake_adjustment_documents').filter(r => r.id === doc.id)); assert.equal(saved.receipt_id, parent.id);
    const pageRows = await documentRows(f, doc.id, doc.row_count); rows.push(...pageRows);
    for (const row of pageRows) {
      const recorded = one(added(a, b, 'stocktake_adjustment_document_rows').filter(r => r.document_id === doc.id && r.ordinal === row.ordinal));
      assert.deepEqual(omit(recorded.payload, ['_exponent']), row, 'Only private currency exponent is omitted from public row');
      assert.equal(recorded.preview_id, d.preview.id); assert.equal(recorded.source_ordinal, row.source_ordinal);
      assert.equal(row.kind, doc.kind); assert.equal(row.quantity, Math.abs(row.delta));
      const journal = one((f.on ? layers : bins).filter(r => r.id === row.movement_id));
      assert.equal(journal.product_id, row.product_id); assert.equal(journal.warehouse_id, f.warehouse.id);
      assert.equal(journal.location, row.location); assert.equal(journal.delta, row.delta);
      assert.equal(f.on ? recorded.wms_movement_id : recorded.quantity_movement_id, journal.id);
      if (source.mode === 'mixed') assert.equal(row.stock_movement_id, null);
      else { const sm = one(stock.filter(r => r.id === row.stock_movement_id)); assert.equal(sm.product_id,row.product_id); assert.equal(sm.delta,row.delta); }
      if (f.on) {
        assert.equal(journal.operation_id, parent.operation_id);
        const layer = one(own169(b, 'wms_cost_layers', f.tenant).filter(r => r.id === journal.layer_id));
        const originalLine = one(source.lines.filter(l => l.id === row.line_id));
        assert.equal(layer.lot_id,originalLine.lot.id,'Counted existing lot remains the authoritative lot for shortage and surplus');
        assert.equal(row.layer_id, layer.id); assert.equal(row.lot_id, layer.lot_id); assert.equal(layer.warehouse_document_id, null);
        assert.equal(layer.product_id,row.product_id); assert.equal(layer.currency,'PLN'); assert.equal(layer.exponent,2);
        const oldLayer = own169(a,'wms_cost_layers',f.tenant).find(l => l.id === layer.id);
        if (row.kind === 'RW') {
          assert(oldLayer,'Shortage consumes an original frozen-cost layer'); assert.deepEqual(layer,oldLayer);
        } else {
          assert.equal(oldLayer,undefined,'Declared surplus creates a new cost layer within the same existing lot');
          assert.equal(layer.operation_id,parent.operation_id); assert.equal(layer.stocktake_line_id,row.line_id);
          assert.equal(layer.quantity_received,row.quantity); assert.equal(layer.purchase_receipt_id,null);
          const product = one(f.products.filter(p => p.id===row.product_id));
          assert.equal(String(layer.unit_cost_minor),product.cost ?? '1000','Cost comes from the genuine surplus review declaration');
        }
        assert.equal(row.unit_cost_minor, layer.unit_cost_minor === null ? null : String(layer.unit_cost_minor));
        assert.equal(row.value_minor, layer.unit_cost_minor === null ? null : String(BigInt(layer.unit_cost_minor) * BigInt(row.quantity)));
        assert.equal(journal.value_delta === null ? null : String(journal.value_delta), layer.unit_cost_minor === null ? null : String(BigInt(layer.unit_cost_minor) * BigInt(row.delta)));
      } else { assert.equal(row.layer_id,null); assert.equal(row.lot_id,null); assert(row.unit_cost_minor == null); assert(row.value_minor == null); }
    }
  }
  assert.deepEqual(sort169(rows.map(r => [r.line_id,r.product_id,r.location,r.delta])), sort169(expected.map(x => [x.line.id,x.line.product_id,x.line.location,x.delta])));
  assert.deepEqual(rows.map(r => r.movement_id).sort(), ids(f.on ? layers : bins));
  assert.deepEqual((result.documents as Row[]).map(d => d.kind).sort(), source.mode === 'mixed' ? ['PW','RW'] : ['RW']);
  assert.equal(receipt.snapshot.summary.pw_quantity, source.mode === 'mixed' ? '3' : '0');
  assert.equal(receipt.snapshot.summary.rw_quantity, '3');
  if (!f.on) {
    assert.equal(parent.operation_id,null); assert.equal(parent.posting_id,null);
    for (const name of Object.keys(a).filter(t => t.startsWith('wms_'))) assert.deepEqual(b[name],a[name], 'OFF no invented layer/operation: ' + name);
  } else {
    const operation = one(added(a, b, 'wms_operations')), posting = one(added(a, b, 'wms_stocktake_postings'));
    assert.equal(operation.id,parent.operation_id); assert.equal(operation.kind,'stocktake_post'); assert.equal(operation.stocktake_id,source.id);
    assert.equal(operation.stocktake_posting_id,posting.id); assert.equal(operation.stocktake_review_id,source.review_id);
    assert.equal(operation.warehouse_document_id,null); assert.equal(posting.id,parent.posting_id); assert.equal(posting.operation_id,operation.id);
    const zero = rows.filter(r => r.product_id === f.products[0].id), unknown = rows.filter(r => r.product_id === f.products[2].id && r.kind === 'RW');
    assert.equal(zero.length,source.mode === 'mixed' ? 2 : 1); assert(zero.every(r => r.unit_cost_minor === '0' && r.value_minor === '0'));
    assert.equal(unknown.length,1); assert.equal(unknown[0].unit_cost_minor,null); assert.equal(unknown[0].value_minor,null);
    assert.equal(receipt.snapshot.summary.currency,'PLN'); assert.equal(receipt.snapshot.summary.exponent,2);
    assert.equal(receipt.snapshot.summary.known_pw_minor,source.mode === 'mixed' ? '2000' : '0');
    assert.equal(receipt.snapshot.summary.known_rw_minor,'1000');
    assert.equal(receipt.snapshot.summary.unknown_pw_quantity,'0'); assert.equal(receipt.snapshot.summary.unknown_rw_quantity,'1');
    // A real declared surplus on the formerly unknown product has cost1000;
    // it must not be mislabelled as the original NULL-cost shortage layer.
    if (source.mode === 'mixed') assert.equal(one(rows.filter(r => r.product_id===f.products[2].id && r.kind==='PW')).unit_cost_minor,'1000');
    const oldLayers = new Set(raw169(a, 'wms_cost_layers').map(l => l.id));
    assert.deepEqual(b.wms_cost_layers.filter(l => oldLayers.has(l.row.id)), a.wms_cost_layers, 'Original known/NULL cost layers remain immutable');
    const prior = own169(a,'wms_layer_positions',f.tenant), current = own169(b,'wms_layer_positions',f.tenant);
    for (const old of prior) {
      const now = one(current.filter(p => p.warehouse_id===old.warehouse_id && p.product_id===old.product_id && p.location===old.location && p.layer_id===old.layer_id));
      const delta = layers.filter(j => j.layer_id===old.layer_id && j.location===old.location).reduce((n,j) => n+j.delta,0);
      assert.deepEqual(omit(now,['quantity','version']),omit(old,['quantity','version'])); assert.equal(now.quantity,old.quantity+delta);
      assert.equal(BigInt(now.version),BigInt(old.version)+(delta===0 ? 0n : 1n));
    }
    const born = current.filter(p => !prior.some(o => o.layer_id===p.layer_id && o.location===p.location));
    assert.equal(born.length,source.mode==='mixed' ? 3 : 0);
    for (const pos of born) {
      assert.equal(pos.warehouse_id,f.warehouse.id); assert.equal(pos.location,'B-02');
      assert.equal(pos.quantity,layers.filter(j => j.layer_id===pos.layer_id && j.location===pos.location).reduce((n,j)=>n+j.delta,0));
      assert.equal(pos.reserved,0); assert.equal(String(pos.version),'1');
      const layer = one(added(a,b,'wms_cost_layers').filter(l => l.id===pos.layer_id)); assert.equal(layer.product_id,pos.product_id);
    }
  }
  assert.deepEqual(await facts169(),b,'Full document paging has no writes');
  return b;
}

for (const [on, mode] of [[false,'mixed'],[true,'mixed'],[true,'shortage']] as const) {
  test(`${on ? 'ON' : 'OFF'} internal strict BO uses real149 ${mode} PW/RW with exact journals, typed effect and replay`, async () => {
    const d = await prepare(on,mode), before = await facts169();
    const posted = await d.f.ok(prefix + '/previews/' + d.preview.id + '/post','POST',d.postBody,201);
    const accepted = await verify(d,before,posted);
    const replay = await d.f.ok(prefix + '/previews/' + d.preview.id + '/post','POST',d.postBody);
    assert.equal(replay.reused,true); assert.deepEqual(replay.receipt,posted.receipt); assert.deepEqual(replay.documents,posted.documents);
    await d.f.ok(prefix + '/receipts/' + posted.receipt.id);
    assert.equal((await d.f.ok(prefix + '/previews/' + d.preview.id)).preview.can_post,false);
    assert.deepEqual(await facts169(),accepted,'Replay/read creates no extra physical writer, effect, audit, number or session');
    assert.equal((await d.f.request(prefix + '/previews/' + d.preview.id + '/post','POST',{...d.postBody,scope_hash:'0'.repeat(64)})).statusCode,409);
    assert.deepEqual(await facts169(),accepted,'Altered consent rolls back every global row');
    const history = await d.f.ok('/catalog-stock-control/history?catalog_id=' + d.catalogId + '&limit=1');
    assert.equal(history.writers_available,false); assert.equal(history.activation_available,false);
    assert.deepEqual(await facts169(),accepted,'Candidate proof never enables the public capability');
  });
}
