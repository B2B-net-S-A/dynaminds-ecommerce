/** SOURCE AUTHORED ONLY. Root executes using its disposable PostgreSQL harness. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { publicApiDocument } from '../server/developer-api';
import { seed } from './fixtures';
import { productCatalogFacts } from './product-catalogs-fixture';
import { adjustmentActor, countedAdjustmentSource, stocktakeAdjustmentFixture, type AdjustmentTestRow as Row } from './stocktake-adjustments-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
const base = '/warehouse-document-register', adjustments = '/stocktake-adjustments';
let app: Awaited<ReturnType<typeof buildApp>>, providers = 0;
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ integrationTransport: async () => { providers++; throw Error('No providers in warehouse register contract166'); } });
});
after(async () => { try { assert.equal(providers, 0); await app?.close(); } finally { await pool.end(); } });

async function facts(tenant: string) {
  return { business: await productCatalogFacts(tenant), sessions: (await pool.query('SELECT to_jsonb(s) row FROM sessions s WHERE tenant_id=$1 ORDER BY 1', [tenant])).rows };
}
async function posted(on: boolean) {
  const f = await stocktakeAdjustmentFixture(app, on), source = await countedAdjustmentSource(f);
  const series: Record<string, Row> = {};
  for (const kind of ['PW', 'RW']) series[kind] = (await f.ok(adjustments + '/series', 'POST', {
    client_key: randomUUID(), kind, name: 'Own unified register ' + kind, prefix: 'U166-' + kind + '-' + randomUUID().slice(0, 8).toUpperCase(),
  }, 201)).series;
  const preview = (await f.ok(adjustments + '/previews', 'POST', {
    client_key: randomUUID(), source_kind: source.source_kind, stocktake_id: source.id, version: source.version,
    ...(on ? { review_id: source.review_id, scope_hash: source.scope_hash } : { review_hash: source.review_hash }),
    pw_series_id: series.PW.id, rw_series_id: series.RW.id,
  }, 201)).preview;
  const receipt = await f.ok(adjustments + '/previews/' + preview.id + '/post', 'POST', { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true }, 201);
  assert.equal(receipt.documents.length, 2);
  const legacy: Row[] = [];
  let destination: Row | undefined;
  if (!on) {
    destination = await f.ok('/warehouses', 'POST', { name: 'Own MM destination166', code: 'MM-' + randomUUID().slice(0, 8) });
    for (const kind of ['receipt', 'transfer', 'issue', 'count']) {
      const inventory = await f.ok('/inventory?product_id=' + f.products[0].id);
      const stock = inventory.data.find((s: Row) => s.warehouse_id === f.warehouse.id);
      assert(stock);
      const lines: Row[] = [];
      for (const p of f.products) {
        const basis = kind === 'count' ? (await f.ok('/inventory?' + new URLSearchParams({ product_id: p.id, warehouse_id: f.warehouse.id }))).data.find((s: Row) => s.warehouse_id === f.warehouse.id && s.product_id === p.id) : null;
        if (kind === 'count') assert(basis);
        lines.push({ product_id: p.id, quantity: kind === 'receipt' ? 2 : kind === 'count' ? 3 : 1, location: 'A-01', ...(kind === 'count' ? { expected_version: String(basis.version) } : {}) });
      }
      const d = await f.ok('/warehouse-documents', 'POST', { kind, warehouse_id: f.warehouse.id,
        ...(kind === 'transfer' ? { destination_id: destination.id } : {}),
        reference: 'Own166 genuine ' + kind, note: 'Actual source lines retained', lines }, 201);
      assert.equal(d.lines.length, 3);
      legacy.push(kind === 'count' ? d : await f.ok('/warehouse-documents/' + d.id + '/post', 'POST', { version: d.version }));
    }
  }
  return { f, receipt, preview, source, legacy, destination };
}
type Born = Awaited<ReturnType<typeof posted>>;
const born = new Map<boolean, Promise<Born>>();
function fixture(on: boolean) { let value = born.get(on); if (!value) { value = posted(on); born.set(on, value); } return value; }
const costKeys = ['currency', 'exponent', 'unit_cost_minor', 'value_minor', 'known_pw_minor', 'known_rw_minor', 'unknown_pw_quantity', 'unknown_rw_quantity', 'rows_sha256', 'scope_hash', 'private_scope_nonce', '_exponent'];
function noCosts(reply: Row) {
  const text = JSON.stringify(reply);
  for (const key of costKeys) {
    assert(!text.includes('"' + key + '"'), 'Quantity DTO omits ' + key);
    if (typeof reply.content === 'string') assert(!reply.content.includes(key), 'Serialized quantity file omits ' + key);
  }
}
function quantityProjection(v: any): any {
  if (Array.isArray(v)) return v.map(quantityProjection);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !costKeys.includes(k)).map(([k, x]) => [k, quantityProjection(x)]));
  return v;
}
function csvRows(content: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) { if (c === '"' && content[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
    else if (c === '"') { assert.equal(cell, ''); quoted = true; }
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && content[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  assert.equal(quoted, false); assert.deepEqual(row, []); assert.equal(cell, '', 'Complete CRLF terminated CSV'); return rows;
}
const csvColumns = ['record_type','origin','document_id','number','kind','status','source_kind','created_at','warehouse_id','warehouse_name','warehouse_code','destination_id','destination_name','destination_code','warehouse_names','value_available','row_names','row_count','pw_quantity','rw_quantity','version','reference','note','posted_at','receipt_id','preview_id','stocktake_id','posting_id','operation_id','series_id','year','sequence','ordinal','source_ordinal','line_id','product_id','sku','name','quantity','location','delta','expected_on_hand','expected_reserved','expected_version','lot_id','lot_code','expiry_date','layer_id','movement_id','stock_movement_id','movement_kind','movement_created_at'];
const csvValueColumns = ['currency','exponent','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','unit_cost_minor','value_minor','cost_state'];
function scalar(v: unknown) { return v == null ? '' : typeof v === 'string' && /^[\s]*[=+\-@\t\r\n]/u.test(v) ? "'" + v : String(v); }
type XmlNode = { name: string; attrs: Record<string, unknown>; children: XmlNode[]; text: string };
function xmlObject(n: XmlNode): any {
  if (n.attrs.nil === 'true') { assert.equal(n.text, ''); assert.equal(n.children.length, 0); assert.deepEqual(n.attrs, { nil: 'true' }); return null; }
  assert.deepEqual(n.attrs, {});
  if (!n.children.length) return n.text;
  assert.equal(n.text, ''); const entries = n.children.map(x => [x.name, xmlObject(x)]);
  assert.equal(new Set(entries.map(x => x[0])).size, entries.length, 'No duplicate XML fields'); return Object.fromEntries(entries);
}
function xmlExpected(v: any): any {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(xmlExpected);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, xmlExpected(x)]));
  return String(v);
}
function complete(reply: Row, detail: Row, productIds: string[]) {
  assert.equal(reply.row_count, productIds.length); assert.equal(reply.document.row_count, productIds.length);
  assert.deepEqual(new Set(detail.rows.map((r: Row) => r.product_id)), new Set(productIds));
  const expected = reply.values_included ? detail : quantityProjection(detail);
  const header = { ...expected.document, value_available: reply.values_included };
  assert.deepEqual(reply.document, header); assert.equal(reply.filename, `${header.kind}-${header.origin}-${header.id}.${reply.format}`);
  assert.match(reply.snapshot_at, /^\d{4}-\d\d-\d\dT/);
  if (reply.format === 'xml') {
    assert.equal(reply.content_type, 'application/xml; charset=utf-8');
    const parser = new SaxesParser(), stack: XmlNode[] = []; let root: XmlNode | undefined;
    parser.on('doctype', () => assert.fail('No DTD in local document export'));
    parser.on('opentag', node => { const n: XmlNode = { name: node.name, attrs: Object.fromEntries(Object.entries(node.attributes)), children: [], text: '' }; if (stack.length) stack.at(-1)!.children.push(n); else { assert.equal(root, undefined); root = n; } stack.push(n); });
    parser.on('text', text => { if (stack.length) stack.at(-1)!.text += text; else assert.equal(text.trim(), ''); });
    parser.on('closetag', () => { stack.pop(); }); parser.write(reply.content).close();
    assert(root); assert.equal(root.name, 'warehouse_document'); assert.deepEqual(root.attrs, { version: '1' });
    assert.deepEqual(root.children.map(n => n.name), ['document', 'evidence', 'rows', 'movements']);
    assert.deepEqual(xmlObject(root.children[0]), xmlExpected(header)); assert.deepEqual(xmlObject(root.children[1]), xmlExpected(expected.evidence));
    for (const [index, records] of [[2, expected.rows], [3, expected.movements]] as const) {
      const container: XmlNode = root.children[index]; assert.deepEqual(container.attrs, {}); assert.equal(container.text, '');
      assert(container.children.every((n: XmlNode) => n.name === 'row')); assert.equal(container.children.length, records.length);
      assert.deepEqual(container.children.map(xmlObject), records.map(xmlExpected), 'Full source rows and actual movements remain separate and exact');
    }
  } else {
    assert.equal(reply.content_type, 'text/csv; charset=utf-8');
    const [columns, ...serialized] = csvRows(reply.content);
    assert(columns);
    assert.deepEqual(columns, [...csvColumns, ...(reply.values_included ? csvValueColumns : [])]);
    const common = { origin: header.origin, document_id: header.id, number: header.number, kind: header.kind, status: header.status, source_kind: header.source_kind, created_at: header.created_at, warehouse_id: header.warehouse.id };
    const records = [{ ...common, ...expected.evidence, record_type: 'document', warehouse_name: header.warehouse.name, warehouse_code: header.warehouse.code, destination_id: header.destination?.id, destination_name: header.destination?.name, destination_code: header.destination?.code, warehouse_names: header.warehouse_names, value_available: header.value_available, row_names: 'recorded', row_count: header.row_count, ...header.summary },
      ...expected.rows.map((r: Row) => ({ ...common, ...r, record_type: 'row', ...(reply.values_included ? { exponent: header.summary.exponent, cost_state: r.unit_cost_minor === null ? 'unknown' : 'known' } : {}) })),
      ...expected.movements.map((m: Row) => ({ ...common, record_type: 'movement', product_id: m.product_id, warehouse_id: m.warehouse_id, delta: m.delta, movement_id: m.id, movement_kind: m.kind, movement_created_at: m.created_at }))];
    assert.deepEqual(serialized, records.map((r: Row) => columns.map(k => scalar(r[k]))), 'Every full header/source/movement field survives CSV serialization');
  }
}

test('public v1 typed union and export descriptors keep inventory/value scopes and read-only copies retain GETs', () => {
  const paths = publicApiDocument().paths as Record<string, any>;
  for (const path of [base, base + '/{origin}/{id}', base + '/{origin}/{id}/export']) {
    const op = paths[path]?.get; assert(op, path);
    assert.deepEqual(op['x-required-scopes'], ['inventory:read']);
    assert.deepEqual(op['x-value-required-scopes'], ['purchasing:read']);
    assert.equal(op['x-value-required-role'], 'admin');
    assert.equal(paths[path].post, undefined, 'Unified register contains no writer');
  }
  const parameters = paths[base].get.parameters;
  for (const name of ['origin', 'kind', 'source_kind', 'status', 'warehouse_id', 'number_prefix', 'from', 'to', 'limit', 'cursor']) assert(parameters.some((p: Row) => p.name === name), name);
  assert.equal(parameters.find((p: Row) => p.name === 'limit').schema.maximum, 50);
  assert.equal(parameters.find((p: Row) => p.name === 'cursor').schema.maxLength, 4096);
  assert.deepEqual(paths[base + '/{origin}/{id}'].get.parameters.find((p: Row) => p.name === 'origin').schema.enum, ['warehouse', 'stocktake_adjustment', 'wms_correction']);
  const exporting = paths[base + '/{origin}/{id}/export'].get.parameters;
  assert.equal(exporting.find((p: Row) => p.name === 'format').required, true);
  assert.deepEqual(exporting.find((p: Row) => p.name === 'format').schema.enum, ['csv', 'xml']);
  const restored = publicApiDocument({ readOnly: true, port: 4198 }).paths as Record<string, any>;
  for (const path of [base, base + '/{origin}/{id}', base + '/{origin}/{id}/export']) assert(restored[path]?.get);
  assert(paths['/warehouse-documents'].post, 'Existing legacy writer remains separate');
  assert(paths[adjustments + '/previews/{id}/post'].post, 'Existing149 single-post remains separate');
  assert.equal(restored['/warehouse-documents']?.post, undefined);
  assert.equal(restored[adjustments + '/previews/{id}/post']?.post, undefined);
});

test('genuine mixed legacy and149 v1 pages preserve typed measurement/MM provenance; reads do not write stock or sessions', async () => {
  const d = await fixture(false), foreign = await fixture(true);
  const key = await d.f.ok('/developer/keys', 'POST', { name: 'Own166 inventory reader', scopes: ['inventory:read'] }, 201);
  const unrelated = await d.f.ok('/developer/keys', 'POST', { name: 'Own166 unrelated reader', scopes: ['products:read'] }, 201);
  const otherActor = await adjustmentActor(app, d.f.tenant, 'operator@demo.local');
  const before = await facts(d.f.tenant), otherBefore = await facts(foreign.f.tenant);
  const page = await d.f.ok(base + '?limit=50', 'GET', undefined, 200, key);
  assert.equal(page.data.length, 6); assert.equal(page.meta.cursor, null); assert.equal(page.meta.limit, 50); noCosts(page);
  assert.deepEqual(new Set(page.data.map((h: Row) => h.kind)), new Set(['PZ', 'MM', 'WZ', 'count', 'PW', 'RW']));
  for (const h of page.data) {
    const detail = await d.f.ok(`${base}/${h.origin}/${h.id}`, 'GET', undefined, 200, key);
    assert.equal(detail.document.id, h.id); assert.equal(detail.document.origin, h.origin); assert.equal(detail.rows.length, 3);
    assert.equal(detail.row_names, 'recorded'); noCosts(detail);
    if (h.origin === 'warehouse') {
      assert.equal(h.warehouse_names, 'current'); assert.equal(h.value_available, false); assert.equal(h.summary, null);
      const original = d.legacy.find(v => v.id === h.id); assert(original);
      for (const row of detail.rows) {
        assert.equal(row.origin, 'warehouse'); assert.equal(row.quantity, original.lines.find((v: Row) => v.product_id === row.product_id).quantity);
        for (const field of ['current_on_hand', 'current_reserved', 'current_version', 'delta', 'unit_cost_minor']) assert.equal(Object.hasOwn(row, field), false, 'Recorded measurement is not live stock or fabricated signed delta');
      }
      if (h.kind === 'MM') {
        assert.equal(h.destination.id, d.destination!.id); assert.equal(detail.movements.length, 6);
        for (const p of d.f.products) {
          const m = detail.movements.filter((v: Row) => v.product_id === p.id);
          assert.deepEqual(new Set(m.map((v: Row) => v.warehouse_id)), new Set([d.f.warehouse.id, d.destination!.id]));
          assert.deepEqual(m.map((v: Row) => v.delta).sort((a: number, b: number) => a - b), [-1, 1]);
        }
      }
      if (h.kind === 'count') { assert.equal(h.status, 'draft'); assert.equal(detail.movements.length, 0); }
    } else { assert.equal(h.warehouse_names, 'frozen'); assert.equal(h.status, 'posted'); assert.equal(detail.evidence.receipt_id, d.receipt.receipt.id); }
    for (const format of ['csv', 'xml']) {
      const result = await d.f.ok(`${base}/${h.origin}/${h.id}/export?format=${format}`, 'GET', undefined, 200, key);
      assert.equal(result.values_included, false); assert.equal(result.format, format); noCosts(result); complete(result, detail, d.f.products.map(p => p.id));
    }
  }
  const mm = page.data.find((h: Row) => h.kind === 'MM'); assert(mm);
  const destinationFilter = await d.f.ok(base + '?warehouse_id=' + d.destination!.id);
  assert.deepEqual(destinationFilter.data.map((h: Row) => h.id), [mm.id], 'MM matches the actual destination as well as source');
  const first = await d.f.ok(base + '?limit=1'); assert(first.meta.cursor);
  const nextPath = base + '?' + new URLSearchParams({ limit: '1', cursor: first.meta.cursor });
  const next = await d.f.ok(nextPath); assert.equal(next.data.length, 1); assert.notEqual(next.data[0].id, first.data[0].id);
  for (const f of [foreign.f, otherActor]) assert.equal((await f.request(nextPath)).statusCode, 409);
  assert.equal((await d.f.request(nextPath, 'GET', undefined, key)).statusCode, 409);
  assert.equal((await d.f.request(base + '?' + new URLSearchParams({ limit: '2', cursor: first.meta.cursor }))).statusCode, 409);
  assert.equal((await d.f.request(base + '?cursor=notAuthenticated166')).statusCode, 422);
  assert.equal((await foreign.f.request(`${base}/warehouse/${mm.id}`)).statusCode, 404);
  assert.equal((await d.f.request(base + '?warehouse_id=' + foreign.f.warehouse.id)).statusCode, 404);
  assert.equal((await d.f.request(base, 'GET', undefined, unrelated)).statusCode, 403);
  for (const suffix of ['?limit=51', '?kind=invoice', '?number_prefix=%00', '?from=2026-10-08T00:00:00Z&to=2026-10-07T00:00:00Z', '?cost_filter=1']) assert.equal((await d.f.request(base + suffix)).statusCode, 422);
  assert.deepEqual(await facts(d.f.tenant), before); assert.deepEqual(await facts(foreign.f.tenant), otherBefore);
});

test('ON149 export preserves zero/NULL and full frozen rows; explicit false masks eligible admin and current v1 value grant is required', async () => {
  const d = await fixture(true), quantity = await d.f.ok('/developer/keys', 'POST', { name: 'Own166 quantity', scopes: ['inventory:read'] }, 201);
  const full = await d.f.ok('/developer/keys', 'POST', { name: 'Own166 value', scopes: ['inventory:read', 'purchasing:read'] }, 201);
  const before = await facts(d.f.tenant);
  const page = await d.f.ok(base, 'GET', undefined, 200, full); assert.equal(page.data.length, 2);
  for (const h of page.data) {
    assert.equal(h.origin, 'stocktake_adjustment'); assert.equal(h.source_kind, 'wms'); assert.equal(h.warehouse_names, 'frozen'); assert.equal(h.value_available, true);
    const detail = await d.f.ok(`${base}/${h.origin}/${h.id}`, 'GET', undefined, 200, full);
    assert.equal(detail.rows.length, 3); assert(detail.rows.some((r: Row) => r.unit_cost_minor === '0'));
    if (h.kind === 'RW') { assert(detail.rows.some((r: Row) => r.unit_cost_minor === null)); assert(detail.rows.some((r: Row) => r.unit_cost_minor === '1000')); }
    for (const format of ['csv', 'xml']) {
      const path = `${base}/${h.origin}/${h.id}/export?format=${format}`;
      const noValue = await d.f.ok(path + '&include_values=false', 'GET', undefined, 200, full); noCosts(noValue); complete(noValue, detail, d.f.products.map(p => p.id));
      assert.equal((await d.f.request(path + '&include_values=true', 'GET', undefined, quantity)).statusCode, 403);
      const valued = await d.f.ok(path + '&include_values=true', 'GET', undefined, 200, full);
      assert.equal(valued.values_included, true); assert.equal(valued.can_read_value, true); complete(valued, detail, d.f.products.map(p => p.id));
      for (const suffix of ['', '?format=html', '?format=csv&include_values=0', '?format=csv&extra=1']) assert.equal((await d.f.request(`${base}/${h.origin}/${h.id}/export` + suffix)).statusCode, 422);
    }
  }
  assert.deepEqual(await facts(d.f.tenant), before);
});

test('actual restored App exposes the mixed union and complete GET exports; old legacy/149 normal and v1 malformed writes423 before parse', async () => {
  const d = await fixture(false), copy = await buildApp({ readOnly: true, previewPort: 4198 }), remoteAddress = '127.166.1.1';
  try {
    assert.equal((await copy.inject({ url: '/api' + base, headers: { cookie: d.f.cookie }, remoteAddress })).statusCode, 401);
    const login = await copy.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress }); assert.equal(login.statusCode, 200);
    const switched = await copy.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: d.f.tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress }); assert.equal(switched.statusCode, 200);
    const cookie = String(switched.headers['set-cookie']).split(';')[0], before = await facts(d.f.tenant);
    const page = await copy.inject({ url: '/api' + base, headers: { cookie }, remoteAddress }); assert.equal(page.statusCode, 200); assert.equal(page.json().read_only, true); assert.equal(page.json().data.length, 6);
    for (const h of page.json().data) {
      const detail = await copy.inject({ url: `/api${base}/${h.origin}/${h.id}`, headers: { cookie }, remoteAddress }); assert.equal(detail.statusCode, 200);
      const reply = await copy.inject({ url: `/api${base}/${h.origin}/${h.id}/export?format=xml&include_values=true`, headers: { cookie }, remoteAddress });
      assert.equal(reply.statusCode, 200); assert.equal(reply.json().read_only, true); assert.equal(reply.json().values_included, false, 'OFF/legacy does not fabricate costs'); noCosts(reply.json()); complete(reply.json(), detail.json(), d.f.products.map(p => p.id));
    }
    for (const namespace of ['/api', '/api/v1']) for (const path of ['/warehouse-documents', '/warehouse-documents/' + d.legacy[0].id + '/post', adjustments + '/previews/' + d.preview.id + '/post']) {
      const r = await copy.inject({ method: 'POST', url: namespace + path, payload: '{', headers: { 'content-type': 'application/json' }, remoteAddress });
      assert.equal(r.statusCode, 423); assert.equal(r.headers['set-cookie'], undefined);
    }
    assert.deepEqual(await facts(d.f.tenant), before, 'GETs and preparse refusals are inert after deliberate isolated copy login');
  } finally { await copy.close(); }
});

test('genuine posted legacy count keeps measured zero and its exact recorded delta; cancelled draft never invents a physical movement', async () => {
  const d = await fixture(false), measured: Row[] = [];
  for (const [index, p] of d.f.products.entries()) {
    const stock = (await d.f.ok('/inventory?' + new URLSearchParams({ warehouse_id: d.f.warehouse.id, product_id: p.id }))).data.find((s: Row) => s.warehouse_id === d.f.warehouse.id && s.product_id === p.id);
    assert(stock); assert.equal(stock.reserved, 0);
    if (index === 0) assert(stock.on_hand > 0, 'Real count has a nonzero physical discrepancy before measuring zero');
    measured.push({ product_id: p.id, quantity: index === 0 ? 0 : stock.on_hand, location: 'A-01', expected_version: String(stock.version), original: stock.on_hand });
  }
  const draft = await d.f.ok('/warehouse-documents', 'POST', { kind: 'count', warehouse_id: d.f.warehouse.id, reference: 'Own166 actual zero count', lines: measured.map(({ original, ...line }) => line) }, 201);
  const postedCount = await d.f.ok('/warehouse-documents/' + draft.id + '/post', 'POST', { version: draft.version }); assert.equal(postedCount.status, 'posted');
  const unused = await d.f.ok('/warehouse-documents', 'POST', { kind: 'receipt', warehouse_id: d.f.warehouse.id, lines: d.f.products.map(p => ({ product_id: p.id, quantity: 1, location: 'A-01' })) }, 201);
  const cancelled = await d.f.ok('/warehouse-documents/' + unused.id + '/cancel', 'POST', { version: unused.version }); assert.equal(cancelled.status, 'cancelled');
  const before = await facts(d.f.tenant);
  const detail = await d.f.ok(`${base}/warehouse/${draft.id}`);
  assert.equal(detail.document.kind, 'count'); assert.equal(detail.document.status, 'posted'); assert.equal(detail.movements.length, 1);
  for (const r of detail.rows) {
    const original = measured.find(x => x.product_id === r.product_id); assert(original);
    assert.equal(r.quantity, original.quantity); assert.equal(r.expected_on_hand, original.original); assert.equal(r.expected_reserved, 0); assert.equal(r.expected_version, original.expected_version);
    assert.equal(Object.hasOwn(r, 'delta'), false, 'Count rows remain measurements; actual delta belongs to the journal');
  }
  const changed = measured[0]; assert.deepEqual(detail.movements.map((m: Row) => ({ product_id: m.product_id, warehouse_id: m.warehouse_id, delta: m.delta, kind: m.kind })), [{ product_id: changed.product_id, warehouse_id: d.f.warehouse.id, delta: -changed.original, kind: 'count' }]);
  const cancelledDetail = await d.f.ok(`${base}/warehouse/${unused.id}`); assert.equal(cancelledDetail.document.status, 'cancelled'); assert.deepEqual(cancelledDetail.movements, []);
  for (const [id, expected] of [[draft.id, detail], [unused.id, cancelledDetail]]) for (const format of ['csv', 'xml']) {
    const exported = await d.f.ok(`${base}/warehouse/${id}/export?format=${format}`); noCosts(exported); complete(exported, expected, d.f.products.map(p => p.id));
  }
  assert.deepEqual((await d.f.ok(base + '?kind=count&status=posted')).data.map((h: Row) => h.id), [draft.id]);
  assert.deepEqual((await d.f.ok(base + '?status=cancelled')).data.map((h: Row) => h.id), [unused.id]);
  assert.deepEqual(await facts(d.f.tenant), before, 'Posted/cancelled history GETs do not perform another count, movement or cancellation');
});
