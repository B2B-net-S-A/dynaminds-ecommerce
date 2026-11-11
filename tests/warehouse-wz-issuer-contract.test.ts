/** Authored without running the app or tests. Root owns disposable PG execution. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SaxesParser } from 'saxes';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { publicApiDocument } from '../server/developer-api';
import { automaticWzSourceInput } from '../server/warehouse-wz-issuer-schema';
import { issuedWzQuery, issuedWzExportQuery } from '../server/warehouse-wz-issued-schema';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture, adjustmentActor } from './stocktake-adjustments-fixture';
import { productCatalogFacts } from './product-catalogs-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
const base = '/warehouse-wz-issued';
const paths = ['/options','/documents','/documents/{id}','/documents/{id}/export'];
const money = ['unit_cost_minor','value_minor','known_value_minor','unknown_quantity','currency','exponent','line_total','vat'];
const identity = ['number','id','receipt_id','series_id','year','sequence','warehouse_id','order_id','shipment_id',
  'source_kind','plan_id','parcel_index','dispatch_id','warehouse_name','warehouse_code','created_at','physical_quantity'];
const summaryCosts = ['known_value_minor','unknown_quantity','currency','exponent'];
const physical = ['ordinal','product_id','sku','name','quantity','location','stock_movement_id','location_movement_id','operation_id','issue_fragment_id','layer_movement_id','layer_id','lot_id'];
const costs = ['unit_cost_minor','value_minor','currency','exponent'];
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
before(async () => {
  await migrate(); await seed();
  // Root may register151 after authoring this suite. Before registration, apply
  // the same genuine migration once in this owned scratch; never hide a module.
  const exists = (await pool.query("SELECT to_regprocedure('public.warehouse_wz_issuer_installed()') marker")).rows[0].marker;
  if (!exists) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(await readFile(new URL('../server/151_warehouse_wz_issuer.sql', import.meta.url), 'utf8'));
      await c.query("INSERT INTO migrations(name) VALUES('151_warehouse_wz_issuer')"); await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw Error('No provider in issuer read contracts'); } });
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });

async function facts(tenant: string) {
  return { business: await productCatalogFacts(tenant), sessions: (await pool.query('SELECT to_jsonb(r) row FROM sessions r WHERE tenant_id=$1 ORDER BY 1', [tenant])).rows };
}
async function packedFixture(on: boolean, existing?: Awaited<ReturnType<typeof stocktakeAdjustmentFixture>>, quantity = 3) {
  const f = existing ?? await stocktakeAdjustmentFixture(app, on); assert.equal(f.on, on);
  if (!existing) {
    const p = (await f.ok('/warehouse-automatic-wz/warehouses/' + f.warehouse.id + '/previews', 'POST', {
      client_key: randomUUID(), expected_version: '0', settings: { enabled: true, moment: 'physical_dispatch', series_name: 'Own contract168', prefix: 'C168' },
    }, 201)).preview;
    await f.ok('/warehouse-automatic-wz/previews/' + p.id + '/commit', 'POST', { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true }, 201);
  }
  const order = await f.ok('/orders', 'POST', { source: 'manual', customer_name: 'Own issued contract168', email: 'contract168@example.test',
    address: { street: 'Own168', city: 'Warszawa', postal_code: '00-168', country: 'PL', phone: '500000168' },
    warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: f.products.map(product => ({ product_id: product.id, quantity })),
  }, 201);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt', amount: order.total,
    currency: 'PLN', method: 'other', reference: 'Own local declared payment168', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  if (on) {
    const a = await f.ok('/wms-lots/orders/' + order.id + '/allocations'); assert.equal(a.meta.cursor, null);
    for (const r of a.data) {
      const product = f.products.find(product => product.id === r.product_id); assert(product);
      for (let n = 0; n < r.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: product.sku, location: r.location, layer_id: r.layer_id });
    }
  } else {
    for (const r of (await pool.query('SELECT * FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id,location', [f.tenant, order.id])).rows) {
      const product = f.products.find(product => product.id === r.product_id); assert(product);
      for (let n = 0; n < r.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: product.sku, location: r.location });
    }
  }
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  return { ...f, order };
}
async function issued(on: boolean) {
  const f = await packedFixture(on), { order } = f;
  await f.ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  const saved = (await pool.query('SELECT * FROM warehouse_wz_issuer_documents WHERE tenant_id=$1 AND payload->\'source\'->>\'order_id\'=$2', [f.tenant, order.id])).rows;
  assert.equal(saved.length, 1);
  const rawRows = (await pool.query('SELECT payload FROM warehouse_wz_issuer_rows WHERE tenant_id=$1 AND document_id=$2 ORDER BY ordinal', [f.tenant, saved[0].id])).rows.map(r => r.payload);
  assert.equal(rawRows.length, 6); return { ...f, order, saved: saved[0], rawRows };
}
function noMoney(value: unknown) {
  if (Array.isArray(value)) for (const x of value) noMoney(x);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assert(!money.includes(key), 'No value or original commercial price key under an inventory-only grant: ' + key); noMoney(child);
  }
}
function scalar(value: unknown) {
  let s = String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s; return s;
}
function csvRows(content: string) {
  assert(content.startsWith('\ufeff')); const out: string[][] = [], row: string[] = []; let value = '', quoted = false;
  for (let i = 1; i < content.length; i++) {
    const c = content[i];
    if (quoted) { if (c === '"') { if (content[i + 1] === '"') { value += '"'; i++; } else quoted = false; } else value += c; }
    else if (c === '"') { assert.equal(value, ''); quoted = true; }
    else if (c === ';') { row.push(value); value = ''; }
    else if (c === '\r') { assert.equal(content[++i], '\n'); row.push(value); out.push([...row]); row.length = 0; value = ''; }
    else { assert.notEqual(c, '\n'); value += c; }
  }
  assert.equal(quoted, false); assert.equal(value, ''); assert.equal(row.length, 0); return out;
}
type Node = { name: string; attrs: Record<string, unknown>; text: string; children: Node[] };
function xmlTree(content: string) {
  assert(!content.includes('<!DOCTYPE')); let root: Node | undefined, error: Error | undefined; const stack: Node[] = [], parser = new SaxesParser();
  parser.on('error', e => { error = e; });
  parser.on('opentag', tag => {
    const node: Node = { name: tag.name, attrs: Object.fromEntries(Object.entries(tag.attributes)), text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node); else { assert.equal(root, undefined); root = node; } stack.push(node);
  });
  parser.on('text', text => { if (stack.length) stack.at(-1)!.text += text; else assert.equal(text.trim(), ''); });
  parser.on('closetag', () => { stack.pop(); }); parser.write(content).close(); assert.equal(error, undefined); assert(root); assert.equal(stack.length, 0); return root;
}
function exportProof(reply: Row, detail: Row) {
  const d = detail.document, values = reply.values_included, keys = [...physical, ...(values ? costs : [])];
  const headKeys = [...identity, ...(values ? summaryCosts : [])];
  const commercial = values ? d.commercial_lines : d.commercial_lines.map((line: Row) => {
    const { line_total, vat, currency, ...quantityOnly } = line; return quantityOnly;
  });
  const expectedDocument = { ...d, value_available: values, commercial_lines: commercial,
    summary: values ? d.summary : { physical_quantity: d.summary.physical_quantity } };
  assert.deepEqual(reply.document, expectedDocument);
  assert.equal(reply.row_count, detail.rows.length); assert.equal(reply.document.id, d.id); assert.match(reply.snapshot_at, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(reply.filename, 'WZ-' + d.id + '.' + reply.format);
  const ids = [d.number,d.id,d.receipt_id,d.series_id,d.year,d.sequence,d.warehouse.id,d.source.order_id,d.source.shipment_id,
    d.source.kind,d.source.plan_id ?? null,d.source.parcel_index ?? null,d.source.dispatch_id ?? null,
    d.warehouse.name,d.warehouse.code,d.created_at,d.summary.physical_quantity,
    ...(values ? [d.summary.known_value_minor,d.summary.unknown_quantity,d.summary.currency,d.summary.exponent] : [])];
  if (reply.format === 'csv') {
    assert.equal(reply.content_type, 'text/csv; charset=utf-8');
    const [columns, ...data] = csvRows(reply.content); assert.deepEqual(columns, [...headKeys, ...keys, 'commercial_lines_json']);
    assert.deepEqual(data, detail.rows.map((r: Row, i: number) => [...ids, ...keys.map(k => r[k]), i === 0 ? JSON.stringify(commercial) : ''].map(scalar)), 'Every independent identity/physical/value/manifest field survives CSV');
  } else {
    assert.equal(reply.content_type, 'application/xml; charset=utf-8'); const root = xmlTree(reply.content); assert.equal(root.name, 'wz'); assert.deepEqual(root.attrs, {});
    assert.deepEqual(root.children.map(n => n.name), [...headKeys, 'commercial_lines_json', 'rows']);
    for (let i = 0; i < headKeys.length; i++) { assert.equal(root.children[i].text, String(ids[i] ?? '')); assert.deepEqual(root.children[i].attrs, {}); }
    assert.deepEqual(JSON.parse(root.children[headKeys.length].text), commercial);
    const container: Node = root.children.at(-1)!; assert.equal(container.children.length, detail.rows.length);
    for (let i = 0; i < detail.rows.length; i++) {
      const node = container.children[i], r = detail.rows[i]; assert.equal(node.name, 'row'); assert.deepEqual(node.attrs, {});
      assert.deepEqual(node.children.map(n => n.name), keys);
      for (let j = 0; j < keys.length; j++) { const value = r[keys[j]], n = node.children[j]; assert.equal(n.text, String(value ?? '')); assert.deepEqual(n.attrs, value === null ? { unknown: 'true' } : {}); assert.equal(n.children.length, 0); }
    }
  }
}

test('public v1 exposes four issued-WZ GETs, explicit bounded queries/value grants and the same reads in restore', () => {
  for (const readOnly of [false, true]) {
    const document = publicApiDocument(readOnly ? { readOnly: true, port: 4198 } : undefined), actual = document.paths as Record<string, Row>;
    const entries = Object.entries(actual).filter(([path]) => path.startsWith(base + '/'));
    assert.equal(entries.length, 4);
    for (const path of paths) {
      const op = actual[base + path]?.get; assert(op, path); assert.equal(actual[base + path].post, undefined);
      assert.deepEqual(op['x-required-scopes'], ['inventory:read']);
      assert.deepEqual(op['x-value-required-scopes'], ['purchasing:read']); assert.equal(op['x-value-required-role'], 'admin');
      for (const status of ['401','403','404','413','422','503']) assert(op.responses[status]);
    }
    const list = actual[base + '/documents'].get.parameters as Row[];
    assert.deepEqual(list.map(p => p.name).sort(), ['warehouse_id','order_id','limit','cursor'].sort());
    assert.equal(list.find(p => p.name === 'limit')!.schema.maximum, 50); assert.equal(list.find(p => p.name === 'limit')!.schema.default, 50);
    assert.equal(list.find(p => p.name === 'cursor')!.schema.maxLength, 1024);
    const exportParams = actual[base + '/documents/{id}/export'].get.parameters as Row[];
    assert.deepEqual(exportParams.find(p => p.name === 'format')!.schema.enum, ['csv','xml']);
    assert.equal(exportParams.find(p => p.name === 'include_values')!.schema.default, 'false');
  }
});

test('actual source/read parsers deny public issue authority, unsupported dispatch kind and unbounded or value-coercing queries', () => {
  const source = { kind: 'demo', order_id: randomUUID(), shipment_id: randomUUID() };
  assert(automaticWzSourceInput.safeParse(source).success);
  for (const extra of [{ actor_id: randomUUID() }, { tenant_id: randomUUID() }, { physical: {} }, { series_id: randomUUID() }, { backfill: true }]) assert(!automaticWzSourceInput.safeParse({ ...source, ...extra }).success);
  assert(!automaticWzSourceInput.safeParse({ ...source, kind: 'invoice' }).success);
  for (const q of [{ limit: '51' },{ limit: '0' },{ cursor: 'a'.repeat(1025) },{ cursor: '=' },{ tenant_id: randomUUID() },{ order_id: 'other' }]) assert(!issuedWzQuery.safeParse(q).success);
  for (const q of [{ include_values: true },{ include_values: '1' },{ format: 'pdf' },{ force: true }]) assert(!issuedWzExportQuery.safeParse(q).success);
  assert.deepEqual(issuedWzExportQuery.parse({}), { format: 'csv', include_values: false });
});

for (const on of [false, true]) test(`${on ? 'ON 0/1000/NULL' : 'OFF'} real v1 detail and complete CSV/XML bind to all actual stored rows; repeated bytes are stable and reads pure`, async () => {
  const f = await issued(on), key = await f.ok('/developer/keys', 'POST', { name: 'Own issued reader168', scopes: ['inventory:read','purchasing:read'] }, 201);
  const before = await facts(f.tenant);
  const detail = await f.ok(base + '/documents/' + f.saved.id, 'GET', undefined, 200, key);
  assert.equal(detail.document.value_available, on); assert.equal(detail.document.row_count, 6); assert.equal(detail.rows.length, 6);
  assert.deepEqual(detail.rows, f.rawRows); assert.deepEqual(detail.document, { ...f.saved.payload, value_available: on });
  assert.equal(detail.document.summary.physical_quantity, 9);
  if (on) { assert.equal(detail.document.summary.known_value_minor, '3000'); assert.equal(detail.document.summary.unknown_quantity, 3); }
  else for (const row of detail.rows) for (const cost of costs) assert.equal(Object.hasOwn(row, cost), false);
  for (const format of ['csv','xml']) {
    const result = await f.ok(base + '/documents/' + f.saved.id + '/export?format=' + format + '&include_values=true', 'GET', undefined, 200, key);
    assert.equal(result.values_included, on); exportProof(result, detail);
    const repeated = await f.ok(base + '/documents/' + f.saved.id + '/export?format=' + format + '&include_values=true', 'GET', undefined, 200, key);
    assert.equal(repeated.content, result.content, 'Transient RR read-time stays outside downloaded bytes');
    assert.match(repeated.snapshot_at, /^\d{4}-\d\d-\d\dT.*Z$/);
  }
  assert.deepEqual(await facts(f.tenant), before);
});

test('inventory-only key and viewer receive no valuation or original commercial money in detail/list/CSV/XML; foreign IDs stay404', async () => {
  const f = await issued(true), foreign = await stocktakeAdjustmentFixture(app), key = await f.ok('/developer/keys', 'POST', { name: 'Own inventory-only reader168', scopes: ['inventory:read'] }, 201);
  const viewer = await adjustmentActor(app, f.tenant, 'viewer@demo.local'); await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, viewer.user]);
  const before = await facts(f.tenant), other = await facts(foreign.tenant);
  for (const principal of ['key','viewer']) {
    const read = principal === 'key' ? (p: string) => f.ok(p, 'GET', undefined, 200, key) : (p: string) => viewer.ok(p);
    const detail = await read(base + '/documents/' + f.saved.id); assert.equal(detail.can_read_value, false); noMoney(detail);
    const list = await read(base + '/documents?limit=1&warehouse_id=' + f.warehouse.id); assert.equal(list.data.length, 1); noMoney(list);
    for (const format of ['csv','xml']) {
      const result = await read(base + '/documents/' + f.saved.id + '/export?format=' + format + '&include_values=false');
      assert.equal(result.values_included, false); noMoney(result.document); exportProof(result, detail);
      for (const field of money) assert.equal(result.content.includes(field), false, field);
    }
  }
  assert.equal((await f.request(base + '/documents/' + f.saved.id + '/export?include_values=true', 'GET', undefined, key)).statusCode, 403);
  for (const path of ['/documents/' + f.saved.id, '/documents/' + f.saved.id + '/export', '/documents?warehouse_id=' + f.warehouse.id, '/documents?order_id=' + f.order.id]) assert.equal((await foreign.request(base + path)).statusCode, 404);
  assert.deepEqual(await facts(f.tenant), before); assert.deepEqual(await facts(foreign.tenant), other);
});

test('real read-only app keeps issued reads and blocks malformed normal/v1 mutation attempts before parse; no login or session delta', async () => {
  const f = await issued(true), key = await f.ok('/developer/keys', 'POST', { name: 'Own read-only boundary168', scopes: ['inventory:read'] }, 201);
  const before = await facts(f.tenant), copy = await buildApp({ readOnly: true });
  try {
    for (const ns of ['/api','/api/v1']) for (const path of ['/options','/documents','/documents/' + f.saved.id,'/documents/' + f.saved.id + '/export']) {
      const r = await copy.inject({ method: 'POST', url: ns + base + path, headers: { 'content-type': 'application/json' }, payload: '{' });
      assert.equal(r.statusCode, 423);
    }
    const read = await copy.inject({ method: 'GET', url: '/api/v1' + base + '/documents/' + f.saved.id, headers: { authorization: 'Bearer ' + key.token } });
    assert.equal(read.statusCode, 200); assert.equal(read.json().read_only, true); assert.equal(read.json().document.id, f.saved.id);
    assert.deepEqual(await facts(f.tenant), before);
  } finally { await copy.close(); }
});

test('actual private prepare cannot commit an orphan dispatch admission; immutable saved documents and their physical provenance deny update/delete', async () => {
  const unissued = await packedFixture(false), before = await facts(unissued.tenant), c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL TimeZone='UTC'"); await c.query("SELECT set_config('app.tenant_id',$1,true)", [unissued.tenant]);
    const id = (await c.query('SELECT public.warehouse_wz_issuer_prepare($1,NULL,$2::jsonb) id', [unissued.user, JSON.stringify({ kind: 'demo', order_id: unissued.order.id, shipment_id: randomUUID() })])).rows[0].id;
    assert(id, 'A genuine packed/current configuration source creates a private admission');
    await assert.rejects(c.query('SET CONSTRAINTS warehouse_wz_issuer_complete IMMEDIATE'), (e: any) => e.code === '23514' && e.message === 'Niepełny automatyczny WZ');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  assert.deepEqual(await facts(unissued.tenant), before);
  const f = await issued(true), saved = await facts(f.tenant), client = await pool.connect();
  try {
    for (const [query, id] of [
      ['UPDATE public.warehouse_wz_issuer_documents SET payload=payload WHERE id=$1', f.saved.id],
      ['DELETE FROM public.warehouse_wz_issuer_documents WHERE id=$1', f.saved.id],
      ['UPDATE public.stock_movements SET delta=delta WHERE id=$1', f.rawRows[0].stock_movement_id],
      ['DELETE FROM public.stock_location_movements WHERE id=$1', f.rawRows[0].location_movement_id],
      ['UPDATE public.wms_issue_fragments SET quantity=quantity WHERE id=$1', f.rawRows[0].issue_fragment_id],
      ['DELETE FROM public.wms_layer_movements WHERE id=$1', f.rawRows[0].layer_movement_id],
    ]) {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
      await assert.rejects(client.query(query, [id]), (e: any) => e.code === '23514'); await client.query('ROLLBACK');
    }
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  assert.deepEqual(await facts(f.tenant), saved);
});

for (const values of [false, true]) test(`real export final current-role wait ${values ? 'refuses requested valuation' : 'redacts the full detail and export'} after late admin loss without changing any document`, async () => {
  const f = await issued(true), before = await facts(f.tenant), held = await pool.connect();
  let pending: ReturnType<typeof f.request> | undefined;
  try {
    await held.query('BEGIN'); await held.query('UPDATE memberships SET role=role WHERE tenant_id=$1 AND user_id=$2', [f.tenant, f.user]);
    pending = f.request(base + '/documents/' + f.saved.id + '/export?format=xml&include_values=' + values);
    let completed = false; void pending.then(() => { completed = true; }, () => { completed = true; });
    const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid, end = Date.now() + 6000;
    let observed = false;
    while (Date.now() < end) {
      assert.equal(completed, false);
      const waits = (await pool.query(`SELECT query FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rows;
      if (waits.some(r => /FROM memberships.*FOR SHARE/.test(r.query))) { observed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(observed, 'The actual RC response fence is blocked after the immutable RR data snapshot');
    await held.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); await held.query('COMMIT');
    const response = await pending; assert.equal(response.statusCode, values ? 403 : 200);
    if (!values) {
      const result = response.json(); assert.equal(result.can_read_value, false); assert.equal(result.values_included, false); noMoney(result.document);
      for (const key of money) assert.equal(result.content.includes(key), false);
    }
  } finally {
    await held.query('ROLLBACK').catch(() => {}); held.release(); if (pending) await pending.catch(() => {});
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  }
  assert.deepEqual(await facts(f.tenant), before);
});

test('a list cursor issued after an observed final role downgrade pages two genuine WZs under the returned viewer grant; tamper and changed actor/filter refuse', async () => {
  const f = await issued(true);
  // The first genuine issue leaves one unit of every component in the original
  // warehouse. Consume that actual remainder; do not fabricate a second head.
  const second = await packedFixture(true, f, 1);
  await second.ok('/orders/' + second.order.id + '/ship-demo', 'POST', {});
  const heads = (await pool.query('SELECT id FROM warehouse_wz_issuer_documents WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC', [f.tenant])).rows;
  assert.equal(heads.length, 2);
  const other = await adjustmentActor(app, f.tenant, 'viewer@demo.local'); assert.notEqual(other.user, f.user);
  const before = await facts(f.tenant), held = await pool.connect(); let pending: ReturnType<typeof f.request> | undefined;
  try {
    await held.query('BEGIN'); await held.query('UPDATE memberships SET role=role WHERE tenant_id=$1 AND user_id=$2', [f.tenant, f.user]);
    pending = f.request(base + '/documents?limit=1');
    let finished = false; void pending.then(() => { finished = true; }, () => { finished = true; });
    const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid, end = Date.now() + 6000;
    let observed = false;
    while (Date.now() < end) {
      assert.equal(finished, false);
      const waits = (await pool.query(`SELECT query FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rows;
      if (waits.some(r => /FROM memberships.*FOR SHARE/.test(r.query))) { observed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(observed, 'The list is actually waiting at the fresh RC member PIN after its data snapshot');
    await held.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); await held.query('COMMIT');
    const response = await pending; assert.equal(response.statusCode, 200);
    const first = response.json(); assert.equal(first.current_role, 'viewer'); assert.equal(first.can_read_value, false); noMoney(first);
    assert.equal(first.data.length, 1); assert.equal(first.data[0].id, heads[0].id); assert.equal(first.meta.limit, 1);
    assert.equal(typeof first.meta.cursor, 'string'); assert(first.meta.cursor.length > 0);
    const token = first.meta.cursor as string, encoded = encodeURIComponent(token);
    const next = await f.ok(base + '/documents?limit=1&cursor=' + encoded);
    assert.equal(next.current_role, 'viewer'); assert.equal(next.can_read_value, false); noMoney(next);
    assert.equal(next.data.length, 1); assert.equal(next.data[0].id, heads[1].id); assert.equal(next.meta.cursor, null);
    assert.notEqual(next.data[0].id, first.data[0].id);
    const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    envelope.signature = (envelope.signature[0] === '0' ? '1' : '0') + envelope.signature.slice(1);
    const tampered = Buffer.from(JSON.stringify(envelope)).toString('base64url');
    assert.equal((await f.request(base + '/documents?limit=1&cursor=' + tampered)).statusCode, 422);
    assert.equal((await other.request(base + '/documents?limit=1&cursor=' + encoded)).statusCode, 422);
    assert.equal((await f.request(base + '/documents?limit=1&order_id=' + f.order.id + '&cursor=' + encoded)).statusCode, 422);
    assert.equal((await f.request(base + '/documents?limit=2&cursor=' + encoded)).statusCode, 422);
  } finally {
    await held.query('ROLLBACK').catch(() => {}); held.release(); if (pending) await pending.catch(() => {});
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  }
  assert.deepEqual(await facts(f.tenant), before, 'Pagination/denials and repaired test IAM change no document, counter, journal or session');
});
