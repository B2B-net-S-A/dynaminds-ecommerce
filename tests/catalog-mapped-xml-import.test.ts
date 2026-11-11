import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '',
  warehouse = '',
  address = 1,
  providerCalls = 0;
let a: Row, b: Row;
const prefix = '/catalog/file-imports';
const xmlMapping = {
  record_path: '/feed/items/item',
  fields: {
    sku: { path: '@code', value_type: 'text' },
    name: { path: 'label', value_type: 'text' },
    description: { path: 'detail', value_type: 'text' },
    category: { path: 'group/@code', value_type: 'text' },
    price_minor: { path: 'price', value_type: 'decimal_money' },
    vat_rate: { path: 'vat', value_type: 'integer' },
    active: { path: 'enabled', value_type: 'boolean' },
    weight_g: { path: 'weight', value_type: 'integer' },
    ean: { path: 'gtin', value_type: 'text' },
  },
};
function request(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', payload?: Row) {
  return app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
    remoteAddress: '127.118.4.' + address,
  });
}
async function ok(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  payload?: Row,
  status = 200,
): Promise<Row> {
  const r = await request(path, method, payload);
  assert.equal(
    r.statusCode,
    status,
    path.startsWith('/auth') ? `${path}: ${r.statusCode}` : r.body,
  );
  if (path.startsWith(prefix)) assert.match(String(r.headers['cache-control'] ?? ''), /no-store/);
  return r.json();
}
const quote = (v: string) =>
  v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function item(p: Row, price: string, name = 'Nowa nazwa ' + p.sku) {
  return `<item code="${quote(p.sku)}"><label>${quote(name)}</label><alias_label>${quote(name)}</alias_label><detail><![CDATA[Łódź & opis 雪]]></detail><group code="MAP-Ż"/><price>${price}</price><vat>23</vat><enabled>true</enabled><weight>1001</weight><gtin>0011800000001</gtin></item>`;
}
const feed = (...items: string[]) => '<feed><items>' + items.join('') + '</items></feed>';
const input = (content: string, extra: Row = {}): Row => ({
  client_key: randomUUID(),
  format: 'xml',
  content,
  warehouse_id: warehouse,
  currency: 'PLN',
  mode: 'update',
  identity: 'sku',
  empty_policy: 'skip',
  delimiter: ',',
  mapping: {},
  ignore_readonly_fields: false,
  xml_mapping: xmlMapping,
  ...extra,
});
const command = (p: Row): Row => ({
  client_key: randomUUID(),
  scope_hash: p.preview.scope_hash,
  confirmed: true,
});
const executePath = (p: Row) => `${prefix}/previews/${p.preview.id}/execute`;
const protectedTables = [
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'stock_location_operations',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'payment_entries',
  'wms_operations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_layer_movements',
  'wms_reservation_layers',
  'wms_issue_fragments',
  'wms_return_fragments',
  'price_lists',
  'price_list_items',
  'product_translations',
];
const evidenceTables = [
  'catalog_file_import_previews',
  'catalog_file_import_rows',
  'catalog_file_import_executions',
  'catalog_file_import_execution_rows',
];
async function snapshot(names: string[]): Promise<Row> {
  const out: Row = {};
  for (const name of names)
    out[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        DEMO_TENANT,
      ])
    ).rows;
  return out;
}
async function products() {
  return (
    await pool.query(
      'SELECT to_jsonb(p) row FROM products p WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
      [DEMO_TENANT, [a.id, b.id]],
    )
  ).rows;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      providerCalls++;
      throw Error('Mapped local XML must not call providers');
    },
  });
  const r = await request('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
});
beforeEach(async () => {
  address++;
  const suffix = randomUUID();
  a = await ok(
    '/products',
    'POST',
    {
      sku: 'XML-A-' + suffix,
      name: 'Original XML A',
      description: 'Original A',
      price: 2599,
      vat: 23,
      quantity: 12,
      warehouse_id: warehouse,
    },
    201,
  );
  b = await ok(
    '/products',
    'POST',
    {
      sku: 'XML-B-' + suffix,
      name: 'Original XML B',
      description: 'Original B',
      price: 1001,
      vat: 23,
      quantity: 10,
      warehouse_id: warehouse,
    },
    201,
  );
  await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Mapped XML genuine reservation',
      email: 'qa-xml@example.test',
      warehouse_id: warehouse,
      items: [{ product_id: a.id, quantity: 3 }],
    },
    201,
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

test('mapped feed updates genuine own catalog, freezes mapping and replays both changed and NOP executions without touching physical/price-list/translation rows', async () => {
  const options = await ok(prefix + '/options');
  assert.equal(options.xml_mapping_supported, true);
  assert.deepEqual(options.xml_value_types, ['text', 'integer', 'decimal_money', 'boolean']);
  const untouched = await snapshot(protectedTables),
    beforeProducts = await products();
  const body = input(feed(item(a, '100.01'), item(b, '0.00')));
  const p = await ok(prefix + '/preview', 'POST', body, 201);
  assert.equal(p.preview.ready, true);
  assert.equal(p.preview.updated, 2);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.preview.config.xml_mapping, xmlMapping);
  assert.deepEqual(
    p.rows.map((r: Row) => [r.product_id, r.after.price]),
    [
      [a.id, 10001],
      [b.id, 0],
    ],
  );
  assert.equal(p.rows[0].after.description, 'Łódź & opis 雪');
  assert.equal(p.rows[0].after.ean, '0011800000001');
  const replayPreview = await ok(prefix + '/preview', 'POST', body);
  assert.equal(replayPreview.reused, true);
  assert.deepEqual(replayPreview.rows, p.rows);
  // Equal decoded product patches still have distinct mapping consent/request hashes.
  const changedMapping = {
    ...xmlMapping,
    fields: { ...xmlMapping.fields, name: { path: 'alias_label', value_type: 'text' } },
  };
  assert.equal(
    (await request(prefix + '/preview', 'POST', { ...body, xml_mapping: changedMapping }))
      .statusCode,
    409,
  );
  const consent = command(p),
    done = await ok(executePath(p), 'POST', consent, 201);
  assert.equal(done.execution.updated, 2);
  const saved = await products();
  for (const previous of beforeProducts) {
    const current = saved.find((r) => r.row.id === previous.row.id)!.row;
    assert.equal(current.version, previous.row.version + 1);
    assert.equal(current.price, current.id === a.id ? 10001 : 0);
    assert.equal(current.category, 'MAP-Ż');
    assert.equal(current.description, 'Łódź & opis 雪');
  }
  assert.deepEqual(await snapshot(protectedTables), untouched);
  const afterDone = await snapshot([
    ...evidenceTables,
    'products',
    'product_logistics',
    'audit_events',
  ]);
  const retry = await ok(executePath(p), 'POST', consent);
  assert.equal(retry.reused, true);
  assert.deepEqual(retry.rows, done.rows);
  assert.deepEqual(
    await snapshot([...evidenceTables, 'products', 'product_logistics', 'audit_events']),
    afterDone,
  );
  const nop = await ok(prefix + '/preview', 'POST', { ...body, client_key: randomUUID() }, 201);
  assert.equal(nop.preview.ready, true);
  assert.equal(nop.preview.unchanged, 2);
  const beforeNop = await products();
  const nopBody = command(nop),
    nopDone = await ok(executePath(nop), 'POST', nopBody, 201);
  assert.equal(nopDone.execution.unchanged, 2);
  assert.deepEqual(await products(), beforeNop);
  const afterNop = await snapshot([
    ...evidenceTables,
    'products',
    'product_logistics',
    'audit_events',
  ]);
  assert.equal((await ok(executePath(nop), 'POST', nopBody)).reused, true);
  assert.deepEqual(
    await snapshot([...evidenceTables, 'products', 'product_logistics', 'audit_events']),
    afterNop,
  );
  assert.deepEqual(await snapshot(protectedTables), untouched);
  assert.equal(providerCalls, 0);
});

test('a late version change in one real product rejects the entire mapped XML batch and leaves no execution or second product update', async () => {
  const p = await ok(
    prefix + '/preview',
    'POST',
    input(feed(item(a, '10.00'), item(b, '17.00'))),
    201,
  );
  assert.equal(p.preview.ready, true);
  const current = await ok('/products/' + a.id);
  const edited = await ok('/products/' + a.id, 'PATCH', {
    version: current.version,
    name: current.name,
    price: current.price,
    ean: current.ean,
    vat: current.vat,
    category: current.category,
    active: current.active,
    attributes: current.attributes,
    images: current.images,
    description: 'Independent current edit',
  });
  assert.equal(edited.version, current.version + 1);
  assert.equal(edited.description, 'Independent current edit');
  const before = await snapshot([
    ...protectedTables,
    ...evidenceTables,
    'products',
    'product_logistics',
    'audit_events',
  ]);
  const denied = await request(executePath(p), 'POST', command(p));
  assert.equal(denied.statusCode, 409, denied.body);
  assert.deepEqual(
    await snapshot([
      ...protectedTables,
      ...evidenceTables,
      'products',
      'product_logistics',
      'audit_events',
    ]),
    before,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM catalog_file_import_executions WHERE tenant_id=$1 AND preview_id=$2',
        [DEMO_TENANT, p.preview.id],
      )
    ).rows[0].n,
    0,
  );
});

test('multiple XML nodes for one mapped scalar reject structurally before any preview, receipt or catalog effect', async () => {
  const before = await snapshot([
    ...protectedTables,
    ...evidenceTables,
    'products',
    'audit_events',
  ]);
  const content = feed(
    item(a, '10.00').replace('</label>', '</label><label>Ambiguous second name</label>'),
  );
  const r = await request(prefix + '/preview', 'POST', input(content));
  assert.equal(r.statusCode, 422, r.body);
  assert.deepEqual(
    await snapshot([...protectedTables, ...evidenceTables, 'products', 'audit_events']),
    before,
  );
});

test('decimal-money XML values retain invalid rows without rounding/exponent coercion or partially executing a good sibling', async () => {
  const before = await snapshot([...protectedTables, 'products', 'product_logistics']);
  for (const amount of ['1e2', '1.001', '1,00', '21474836.48']) {
    const p = await ok(
      prefix + '/preview',
      'POST',
      input(feed(item(a, amount), item(b, '17.00'))),
      201,
    );
    assert.equal(p.preview.ready, false);
    assert.equal(p.rows.length, 2);
    assert(p.rows[0].errors.length > 0);
    assert.equal((await request(executePath(p), 'POST', command(p))).statusCode, 409);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM catalog_file_import_executions WHERE tenant_id=$1 AND preview_id=$2',
          [DEMO_TENANT, p.preview.id],
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await snapshot([...protectedTables, 'products', 'product_logistics']), before);
  }
  assert.equal(providerCalls, 0);
});
