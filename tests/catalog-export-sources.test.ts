import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import {
  catalogExportSourceFrame,
  catalogExportSourceRows,
  catalogExportSourceOptions,
  type CatalogExportSourceValues,
} from '../server/catalog-export-sources';
import { catalogExportDefinitionInput } from '../server/catalog-export';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
type Product = { id: string; sku: string; kind: string; price: number };
type List = {
  id: string;
  name: string;
  currency: string;
  version: number;
  active: boolean;
  fallback: boolean;
  adjustment_bps: number;
  adjustment_amount: number;
};
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
let app: Awaited<ReturnType<typeof buildApp>> | undefined,
  cookie = '',
  wh1 = '',
  wh2 = '';
let a: Product, b: Product, group: Product, variant: Product, bundle: Product, pln: List, eur: List;
let providerCalls = 0;
const prefix = 'QA116-' + randomUUID().slice(0, 8);
const request = (path: string, method: Method = 'GET', payload?: Record<string, unknown>) => {
  assert(app);
  return app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
    remoteAddress: '127.116.1.1',
  });
};
async function ok<T>(
  path: string,
  method: Method = 'GET',
  payload?: Record<string, unknown>,
  status = 200,
): Promise<T> {
  const r = await request(path, method, payload);
  assert.equal(r.statusCode, status, path.startsWith('/auth/') ? method + ' ' + path : r.body);
  return r.json<T>();
}
async function product(extra: Record<string, unknown> = {}) {
  return ok<Product>(
    '/products',
    'POST',
    {
      name: 'Produkt źródła eksportu',
      sku: prefix + '-' + randomUUID(),
      price: 10001,
      quantity: 0,
      warehouse_id: wh1,
      ...extra,
    },
    201,
  );
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      providerCalls++;
      throw Error('Export sources must not contact providers');
    },
  });
  const login = await request('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200, 'POST /auth/login');
  cookie = String(login.headers['set-cookie']).split(';')[0];
  wh1 = (await ok<{ data: { id: string }[] }>('/warehouses')).data[0].id;
  wh2 = (
    await ok<{ id: string }>('/warehouses', 'POST', { name: prefix + ' second', code: prefix })
  ).id;
  a = await product({ quantity: 12 });
  b = await product({ quantity: 20 });
  group = await product({ kind: 'group' });
  variant = await product({ kind: 'variant', parent_id: group.id, quantity: 7 });
  bundle = await product({
    kind: 'bundle',
    components: [
      { product_id: a.id, quantity: 2 },
      { product_id: b.id, quantity: 3 },
    ],
  });
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,6)', [
      DEMO_TENANT,
      wh2,
      a.id,
    ]),
  );
  await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Rezerwacja eksportu',
      email: 'export116@example.test',
      warehouse_id: wh1,
      items: [
        { product_id: a.id, quantity: 3 },
        { product_id: b.id, quantity: 4 },
      ],
    },
    201,
  );
  pln = await ok<List>(
    '/price-lists',
    'POST',
    {
      name: prefix + ' PLN',
      currency: 'PLN',
      fallback: true,
      adjustment_bps: 500,
      adjustment_amount: 19,
    },
    201,
  );
  eur = await ok<List>(
    '/price-lists',
    'POST',
    { name: prefix + ' EUR', currency: 'EUR', fallback: false },
    201,
  );
  pln = await ok<List>('/price-lists/' + pln.id + '/items', 'PUT', {
    version: pln.version,
    items: [{ product_id: a.id, price: 0 }],
  });
  eur = await ok<List>('/price-lists/' + eur.id + '/items', 'PUT', {
    version: eur.version,
    items: [{ product_id: a.id, price: 699 }],
  });
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
function definition(format: 'csv' | 'xml' = 'csv') {
  return {
    format,
    columns: ['sku', 'inventory_json', 'prices_json'],
    headers: {},
    spreadsheet_safe: false,
    warehouse_ids: [wh2, wh1],
    price_list_ids: [eur.id, pln.id],
  };
}
async function matrices(ids: string[]) {
  return tenantTx(
    DEMO_TENANT,
    async (c) => {
      const f = await catalogExportSourceFrame(c, definition(), DEMO_TENANT);
      return catalogExportSourceRows(c, ids, f, 'PLN');
    },
    { wmsAdmission: 'read' },
  );
}
function csv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && c === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (c === '\r' || c === '\n')) {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  assert.equal(quoted, false);
  assert.equal(cell, '');
  return rows;
}
async function snapshots() {
  const names = [
    'products',
    'stock',
    'stock_locations',
    'reservations',
    'reservation_locations',
    'orders',
    'order_items',
    'price_lists',
    'price_list_items',
    'catalog_export_profiles',
    'audit_events',
    'order_events',
  ];
  const out: Record<string, unknown> = {};
  for (const name of names)
    out[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        DEMO_TENANT,
      ])
    ).rows;
  return out;
}

test('own two-warehouse matrix distinguishes reservations, missing stock, variant, group and component-only bundle availability', async () => {
  const rows = await matrices([a.id, b.id, group.id, variant.id, bundle.id]);
  assert.deepEqual(
    rows
      .get(a.id)!
      .inventory_json.map((r) => [r.warehouse_id, r.on_hand, r.reserved, r.available, r.status]),
    [
      [wh2, 6, 0, 6, 'available'],
      [wh1, 12, 3, 9, 'available'],
    ],
  );
  assert.deepEqual(
    rows.get(b.id)!.inventory_json.map((r) => [r.on_hand, r.reserved, r.available, r.status]),
    [
      [null, null, null, 'missing'],
      [20, 4, 16, 'available'],
    ],
  );
  assert.deepEqual(
    rows
      .get(bundle.id)!
      .inventory_json.map((r) => [r.source, r.on_hand, r.reserved, r.available, r.status]),
    [
      ['components', null, null, 0, 'available'],
      ['components', null, null, 4, 'available'],
    ],
  );
  assert(
    rows
      .get(group.id)!
      .inventory_json.every(
        (r) => r.status === 'not_applicable' && r.available === null && r.on_hand === null,
      ),
  );
  assert.equal(rows.get(variant.id)!.inventory_json[1].available, 7);
  const r = await request('/catalog/exports/file', 'POST', {
    ...definition(),
    selection: 'selected',
    ids: [a.id, b.id, bundle.id, group.id, variant.id],
  });
  assert.equal(r.statusCode, 200, r.body);
  const [head, ...body] = csv(r.body);
  assert.deepEqual(head, ['sku', 'inventory_json', 'prices_json']);
  assert.equal(body.length, 5);
  const exported = new Map(
    body.map((row) => [
      row[0],
      {
        inventory_json: JSON.parse(row[1]),
        prices_json: JSON.parse(row[2]),
      } as CatalogExportSourceValues,
    ]),
  );
  for (const p of [a, b, bundle, group, variant])
    assert.deepEqual(exported.get(p.sku), rows.get(p.id));
});

test('two currencies retain override zero, exact pricing rule, missing price and group not-applicable without FX', async () => {
  const rows = await matrices([a.id, b.id, group.id]);
  assert.deepEqual(
    rows
      .get(a.id)!
      .prices_json.map((r) => [
        r.price_list_id,
        r.currency,
        r.own_price_minor,
        r.effective_price_minor,
        r.source,
        r.status,
      ]),
    [
      [eur.id, 'EUR', 699, 699, 'override', 'available'],
      [pln.id, 'PLN', 0, 0, 'override', 'available'],
    ],
  );
  assert.deepEqual(
    rows
      .get(b.id)!
      .prices_json.map((r) => [r.own_price_minor, r.effective_price_minor, r.source, r.status]),
    [
      [null, null, null, 'missing'],
      [null, 10520, 'rule', 'available'],
    ],
  );
  const quote = await ok<{ items: { product_id: string; price: number; source: string }[] }>(
    '/pricing/quote',
    'POST',
    {
      price_list_id: pln.id,
      product_ids: [a.id, b.id],
    },
  );
  for (const p of [a, b]) {
    const actual = quote.items.find((i) => i.product_id === p.id);
    assert(actual);
    assert.equal(rows.get(p.id)!.prices_json[1].effective_price_minor, actual.price);
    assert.equal(rows.get(p.id)!.prices_json[1].source, actual.source);
  }
  assert(
    rows
      .get(group.id)!
      .prices_json.every((r) => r.status === 'not_applicable' && r.effective_price_minor === null),
  );
});

test('invalid derived prices become explicit null statuses; a disabled or empty component bundle never pretends physical stock', async () => {
  const zero = await product({ price: 0 });
  const negative = await ok<List>(
    '/price-lists',
    'POST',
    { name: prefix + ' negative', currency: 'PLN', fallback: true, adjustment_amount: -1 },
    201,
  );
  const big = await product({ price: 100000000 }),
    overflow = await ok<List>(
      '/price-lists',
      'POST',
      { name: prefix + ' overflow', currency: 'PLN', fallback: true, adjustment_bps: 100000 },
      201,
    );
  const bad = await tenantTx(
    DEMO_TENANT,
    async (c) => {
      const f = await catalogExportSourceFrame(
        c,
        { columns: ['prices_json'], price_list_ids: [negative.id, overflow.id] },
        DEMO_TENANT,
      );
      return catalogExportSourceRows(c, [zero.id, big.id], f, 'PLN');
    },
    { wmsAdmission: 'read' },
  );
  assert.equal(bad.get(zero.id)!.prices_json[0].status, 'invalid_out_of_range');
  assert.equal(bad.get(zero.id)!.prices_json[0].effective_price_minor, null);
  assert.equal(bad.get(big.id)!.prices_json[1].status, 'invalid_out_of_range');
  assert.equal(bad.get(big.id)!.prices_json[1].effective_price_minor, null);
  const component = await product({ quantity: 5 }),
    kit = await product({
      kind: 'bundle',
      components: [{ product_id: component.id, quantity: 1 }],
    });
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE products SET active=false WHERE id=$1', [component.id]),
  );
  let kitRows = (await matrices([kit.id])).get(kit.id)!;
  assert(
    kitRows.inventory_json.every(
      (r) => r.status === 'unavailable' && r.available === 0 && r.on_hand === null,
    ),
  );
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('DELETE FROM bundle_components WHERE bundle_id=$1', [kit.id]),
  );
  kitRows = (await matrices([kit.id])).get(kit.id)!;
  assert(kitRows.inventory_json.every((r) => r.status === 'unavailable' && r.available === 0));
});

test('XML keeps source arrays and row fields structural, and source reads/downloads leave all selected business evidence unchanged', async () => {
  const before = await snapshots(),
    expected = (await matrices([a.id])).get(a.id)!;
  const r = await request('/catalog/exports/file', 'POST', {
    ...definition('xml'),
    selection: 'selected',
    ids: [a.id],
  });
  assert.equal(r.statusCode, 200, r.body);
  type Node = { name: string; attrs: Record<string, string>; text: string; children: Node[] };
  const parser = new SaxesParser({ xmlns: false }),
    stack: Node[] = [];
  let root: Node | undefined;
  parser.on('opentag', (tag) => {
    const n: Node = {
      name: tag.name,
      attrs: tag.attributes as Record<string, string>,
      text: '',
      children: [],
    };
    if (stack.length) stack.at(-1)!.children.push(n);
    else root = n;
    stack.push(n);
  });
  parser.on('text', (text) => {
    if (stack.length) stack.at(-1)!.text += text;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.write(r.body).close();
  assert(root);
  function decode(n: Node): unknown {
    if (n.attrs.nil === 'true') return null;
    if (n.attrs.type === 'array') return n.children.map(decode);
    if (n.attrs.type === 'object')
      return Object.fromEntries(n.children.map((c) => [c.attrs.key, decode(c)]));
    if (n.attrs.type === 'number') return Number(n.text);
    if (n.attrs.type === 'boolean') return n.text === 'true';
    return n.text;
  }
  const p = root.children.find((n) => n.name === 'product');
  assert(p);
  for (const field of ['inventory_json', 'prices_json'] as const) {
    const n: Node | undefined = p.children.find((n: Node) => n.name === field);
    assert(n);
    assert.equal(n.attrs.type, 'array');
    assert.deepEqual(decode(n), expected[field]);
  }
  assert.deepEqual(await snapshots(), before);
  assert.equal(providerCalls, 0);
});

test('source profiles persist selector presence and order, canonical create retry survives reads, while legacy definitions omit new properties', async () => {
  const body = { name: prefix + ' persisted', definition: definition(), client_key: randomUUID() };
  const created = await ok<{ profile: { id: string; definition: ReturnType<typeof definition> } }>(
    '/catalog/export-profiles',
    'POST',
    body,
    201,
  );
  assert.deepEqual(created.profile.definition, body.definition);
  const replay = await ok<{ reused: boolean; profile: { id: string } }>(
    '/catalog/export-profiles',
    'POST',
    {
      ...body,
      client_key: body.client_key.toUpperCase(),
      definition: {
        ...body.definition,
        warehouse_ids: body.definition.warehouse_ids.map((id) => id.toUpperCase()),
      },
    },
  );
  assert(replay.reused);
  assert.equal(replay.profile.id, created.profile.id);
  const detail = await ok<{ profile: { definition: unknown } }>(
    '/catalog/export-profiles/' + created.profile.id,
  );
  assert.deepEqual(detail.profile.definition, body.definition);
  const legacy = { format: 'csv', columns: ['sku', 'name'], headers: {}, spreadsheet_safe: false };
  const old = await ok<{ profile: { definition: Record<string, unknown> } }>(
    '/catalog/export-profiles',
    'POST',
    { name: prefix + ' legacy', definition: legacy, client_key: randomUUID() },
    201,
  );
  assert.deepEqual(old.profile.definition, legacy);
  assert.equal(Object.hasOwn(old.profile.definition, 'warehouse_ids'), false);
  assert.equal(Object.hasOwn(old.profile.definition, 'price_list_ids'), false);
  const before = await snapshots();
  const r = await request('/catalog/exports/file', 'POST', {
    ...created.profile.definition,
    selection: 'selected',
    ids: [a.id, b.id],
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(await snapshots(), before);
});

test('source selection is strict and ordered; active own metadata and empty filtered preview do not invent data', async () => {
  for (const d of [
    { ...definition(), warehouse_ids: undefined },
    { ...definition(), price_list_ids: [] },
    { ...definition(), warehouse_ids: [wh1, wh1.toUpperCase()] },
    { ...definition(), columns: ['sku'] },
    { ...definition(), warehouse_ids: Array.from({ length: 11 }, () => randomUUID()) },
  ])
    assert.equal(catalogExportDefinitionInput.safeParse(d).success, false);
  const normalized = catalogExportDefinitionInput.parse({
    ...definition(),
    warehouse_ids: [wh2.toUpperCase(), wh1],
  });
  assert.deepEqual(normalized.warehouse_ids, [wh2, wh1]);
  const options = await tenantTx(DEMO_TENANT, (c) => catalogExportSourceOptions(c, true), {
    wmsAdmission: 'read',
  });
  assert(options.warehouses.available && options.price_lists.available);
  assert(options.warehouses.data.some((w) => w.id === wh2));
  assert(options.price_lists.data.some((l) => l.id === eur.id && l.currency === 'EUR'));
  const hidden = await tenantTx(DEMO_TENANT, (c) => catalogExportSourceOptions(c, false), {
    wmsAdmission: 'read',
  });
  assert.deepEqual(hidden.warehouses.data, []);
  const sample = await ok<{
    sample: { product_id: string; inventory_json: unknown[]; prices_json: unknown[] }[];
  }>('/catalog/exports/preview', 'POST', {
    ...definition(),
    selection: 'selected',
    ids: [a.id, b.id],
  });
  assert.equal(sample.sample.length, 2);
  const empty = await ok<{ sample: unknown[]; count: { matched_products: number } }>(
    '/catalog/exports/preview',
    'POST',
    { ...definition(), selection: 'filtered', search: prefix + 'NOTFOUND' },
  );
  assert.deepEqual(empty.sample, []);
  assert.equal(empty.count.matched_products, 0);
  const inactive = await ok<List>(
    '/price-lists',
    'POST',
    { name: prefix + ' inactive', currency: 'PLN' },
    201,
  );
  await ok('/price-lists/' + inactive.id, 'PATCH', {
    name: inactive.name,
    version: inactive.version,
    active: false,
    fallback: false,
    adjustment_bps: 0,
    adjustment_amount: 0,
  });
  for (const ids of [[inactive.id], [randomUUID()]]) {
    const r = await request('/catalog/exports/file', 'POST', {
      ...definition(),
      price_list_ids: ids,
      selection: 'selected',
      ids: [a.id],
    });
    assert.equal(r.statusCode, 422, r.body);
  }
  assert.equal(providerCalls, 0);
});

test('imported legacy over-cap metadata is bounded at 200 with honest capped flags and no denied warehouse-name projection', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [DEMO_TENANT]);
    // Isolated rollback-only imported/legacy fixture. The current enterprise plan
    // allows 100 warehouses/lists; this explicitly models pre-existing over-cap data
    // without changing a production plan or any schema/trigger definition.
    await c.query("SET LOCAL session_replication_role='replica'");
    const fixtures = Array.from({ length: 201 }, (_, i) => ({
      id: randomUUID(),
      name: prefix + ' source ' + i,
      code: prefix + '-' + i,
    }));
    await c.query(
      `INSERT INTO warehouses(id,tenant_id,name,code)
   SELECT id,$1,name,code FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,name text,code text)`,
      [DEMO_TENANT, JSON.stringify(fixtures)],
    );
    await c.query(
      `INSERT INTO price_lists(id,tenant_id,name,currency)
   SELECT id,$1,name,'PLN' FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,name text)`,
      [DEMO_TENANT, JSON.stringify(fixtures)],
    );
    // Restore every guard before exercising the ordinary application's reader.
    await c.query("SET LOCAL session_replication_role='origin'");
    await c.query('SET LOCAL ROLE dyna_app');
    const visible = await catalogExportSourceOptions(c, true);
    assert.equal(visible.warehouses.data.length, 200);
    assert.equal(visible.warehouses.capped, true);
    assert.equal(visible.price_lists.data.length, 200);
    assert.equal(visible.price_lists.capped, true);
    const denied = await catalogExportSourceOptions(c, false);
    assert.deepEqual(denied.warehouses.data, []);
    assert.equal(denied.warehouses.capped, false);
    assert.equal(denied.price_lists.data.length, 200);
    assert.equal(denied.price_lists.capped, true);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('500 selected and all 501 filtered products retain complete two-source matrices across every 100-product batch boundary', async () => {
  const range = prefix + '-range-';
  const products = await tenantTx(DEMO_TENANT, async (c) => {
    // Normal enterprise product quota (500000); all genuine product, alias, stock,
    // bin and deferred consistency triggers stay enabled for this range fixture.
    const p = (
      await c.query<Product>(
        `INSERT INTO products(id,tenant_id,sku,name,price)
   SELECT gen_random_uuid(),$1,$2||lpad(g::text,4,'0'),'Range export '||g::text,10000+g
   FROM generate_series(0,500) AS g RETURNING id,sku,kind,price`,
        [DEMO_TENANT, range],
      )
    ).rows;
    const rows = p.map((product) => ({
      ...product,
      index: Number(product.sku.slice(range.length)),
    }));
    // Each stock row runs the warehouse policy guards six times (~13 ms per row, 13.11.2026), so
    // 1002 rows in one statement passed the 8 s statement_timeout. Batches of 100 keep every trigger.
    for (let i = 0; i < rows.length; i += 100)
      await c.query(
        `INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand)
   SELECT $1::uuid,$2::uuid,id,20+(index%10) FROM jsonb_to_recordset($4::jsonb) AS x(id uuid,index integer)
   UNION ALL SELECT $1::uuid,$3::uuid,id,10+(index%7) FROM jsonb_to_recordset($4::jsonb) AS x(id uuid,index integer)`,
        [DEMO_TENANT, wh1, wh2, JSON.stringify(rows.slice(i, i + 100))],
      );
    await c.query(
      `INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price)
   SELECT $1::uuid,$2::uuid,id,index FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,index integer) WHERE index%3=0`,
      [DEMO_TENANT, eur.id, JSON.stringify(rows)],
    );
    return rows;
  });
  assert.equal(products.length, 501);
  const expected = new Map(products.map((p) => [p.id, p]));
  const before = await snapshots();
  const config = { ...definition(), columns: ['id', 'sku', 'inventory_json', 'prices_json'] };
  for (const selection of ['selected', 'filtered'] as const) {
    const selected = products.slice(0, 500);
    const r = await request('/catalog/exports/file', 'POST', {
      ...config,
      selection,
      ...(selection === 'selected'
        ? { ids: selected.map((p) => p.id) }
        : { search: range, active: 'all' }),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(Number(r.headers['x-catalog-export-count']), selection === 'selected' ? 500 : 501);
    const [head, ...rows] = csv(r.body);
    assert.deepEqual(head, config.columns);
    const ids = rows.map((row) => row[0]);
    assert.equal(new Set(ids).size, rows.length);
    assert.deepEqual(
      [...ids].sort(),
      (selection === 'selected' ? selected : products).map((p) => p.id).sort(),
    );
    for (const row of rows) {
      const p = expected.get(row[0]);
      assert(p);
      assert.equal(row[1], p.sku);
      const inventory = JSON.parse(row[2]) as CatalogExportSourceValues['inventory_json'],
        prices = JSON.parse(row[3]) as CatalogExportSourceValues['prices_json'];
      assert.deepEqual(
        inventory.map((s) => [s.warehouse_id, s.status, s.on_hand, s.reserved, s.available]),
        [
          [wh2, 'available', 10 + (p.index % 7), 0, 10 + (p.index % 7)],
          [wh1, 'available', 20 + (p.index % 10), 0, 20 + (p.index % 10)],
        ],
      );
      assert.equal(prices.length, 2);
      assert.equal(prices[0].price_list_id, eur.id);
      assert.equal(prices[1].price_list_id, pln.id);
      assert.equal(prices[0].currency, 'EUR');
      assert.equal(prices[0].version, eur.version);
      assert.equal(prices[1].currency, 'PLN');
      assert.equal(prices[1].version, pln.version);
      assert.deepEqual(
        [
          prices[0].status,
          prices[0].own_price_minor,
          prices[0].effective_price_minor,
          prices[0].source,
        ],
        p.index % 3 === 0
          ? ['available', p.index, p.index, 'override']
          : ['missing', null, null, null],
      );
      assert.deepEqual(
        [
          prices[1].status,
          prices[1].own_price_minor,
          prices[1].effective_price_minor,
          prices[1].source,
        ],
        ['available', null, Math.floor((p.price * 10500 + 5000) / 10000) + 19, 'rule'],
      );
    }
  }
  assert.deepEqual(await snapshots(), before);
  assert.equal(providerCalls, 0);
});
