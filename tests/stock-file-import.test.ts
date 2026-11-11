import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
const prefix = '/stock-file-imports';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  user = '',
  ip = 1;
let warehouses: string[] = [];
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie },
    remoteAddress: '127.4.115.' + ip,
  });
async function ok(path: string, method: any = 'GET', payload?: any, status = 200): Promise<Row> {
  const r = await req(path, method, payload);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 600)}`);
  assert.match(String(r.headers['cache-control'] ?? ''), /no-store/);
  return r.json();
}
// Existing setup endpoints need not have the new module's cache policy.
async function setupApi(path: string, method: any = 'GET', payload?: any): Promise<Row> {
  const r = await req(path, method, payload);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: ${r.body.slice(0, 600)}`);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.STOCK_FILE_IMPORT_TEST_LOG === 'true',
    integrationTransport: async () => {
      throw Error('Stock count import must remain local');
    },
  });
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ip++;
  tenant = randomUUID();
  warehouses = [randomUUID(), randomUUID()].sort();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Stock file engine','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  for (const [i, id] of warehouses.entries())
    await pool.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4)', [
      id,
      tenant,
      'Count ' + i,
      'COUNT-' + i,
    ]);
  const login = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const own = async (table: string) =>
  (
    await pool.query(`SELECT to_jsonb(t) row FROM "${table}" t WHERE tenant_id=$1 ORDER BY 1`, [
      tenant,
    ])
  ).rows;
async function snapshot(exclude: string[] = []) {
  const names = (
    await pool.query(
      "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name) WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' AND c.table_name<>'sessions' ORDER BY 1",
    )
  ).rows;
  const out: Row = {};
  for (const { table_name: n } of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(n));
    if (!exclude.includes(n)) out[n] = await own(n);
  }
  return out;
}
const physical = [
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_layer_movements',
  'wms_operations',
];
async function selected(names: string[]) {
  const out: Row = {};
  for (const n of names) out[n] = await own(n);
  return out;
}
const protectedCommerce = [
  'products',
  'product_sku_aliases',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_reservation_layers',
  'payment_entries',
  'wms_issue_fragments',
  'wms_return_fragments',
];
async function product(quantity = 10): Promise<Row> {
  return setupApi('/products', 'POST', {
    name: 'Physical count item',
    sku: 'COUNT-' + randomUUID(),
    price: 2500,
    vat: 23,
    warehouse_id: warehouses[0],
    quantity,
    location: 'A-01',
  });
}
async function prepare(on = false, reserve = true, unknown = false) {
  const p = await product();
  const document = await setupApi('/warehouse-documents', 'POST', {
    kind: 'receipt',
    warehouse_id: warehouses[1],
    reference: 'Own second warehouse opening',
    lines: [{ product_id: p.id, quantity: 3, location: 'A-01' }],
  });
  await setupApi('/warehouse-documents/' + document.id + '/post', 'POST', {
    version: document.version,
  });
  const lots: Row = {};
  if (on) {
    const stocks = (
      await pool.query(
        'SELECT warehouse_id,version,on_hand FROM stock WHERE tenant_id=$1 AND product_id=$2 ORDER BY warehouse_id',
        [tenant, p.id],
      )
    ).rows;
    const opening = await setupApi('/wms-lots/opening-previews', 'POST', {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Genuine two warehouse opening',
      lines: stocks.map((s) => ({
        warehouse_id: s.warehouse_id,
        product_id: p.id,
        location: 'A-01',
        quantity: s.on_hand,
        stock_version: String(s.version),
        lot_code: 'COUNT-' + s.warehouse_id,
        unit_cost_minor: unknown ? null : '317',
      })),
    });
    assert.equal(opening.preview.ready, true);
    await setupApi('/wms-lots/opening-previews/' + opening.preview.id + '/activate', 'POST', {
      client_key: randomUUID(),
      scope_hash: opening.preview.scope_hash,
      confirmed: true,
      ack_unknown_costs: unknown,
    });
    for (const r of (
      await pool.query(
        'SELECT DISTINCT p.warehouse_id,l.lot_id FROM wms_layer_positions p JOIN wms_cost_layers l ON (l.tenant_id,l.id,l.product_id)=(p.tenant_id,p.layer_id,p.product_id) WHERE p.tenant_id=$1 AND p.product_id=$2',
        [tenant, p.id],
      )
    ).rows)
      lots[r.warehouse_id] = r.lot_id;
  }
  let order: Row | null = null;
  if (reserve)
    order = await setupApi('/orders', 'POST', {
      customer_name: 'Reserved original order',
      email: 'count@example.test',
      phone: '500600700',
      payment_mode: 'cod',
      warehouse_id: warehouses[0],
      address: {
        street: 'Testowa',
        building_number: '1',
        city: 'Warszawa',
        post_code: '00-001',
        country: 'PL',
      },
      items: [{ product_id: p.id, quantity: 4 }],
    });
  return { p, lots, order, on };
}
function input(p: Row, lots: Row = {}, changes: Row = {}): Row {
  const on = Object.keys(lots).length > 0;
  return {
    client_key: randomUUID(),
    file_name: 'count.csv',
    note: 'Explicit physical warehouse count',
    definition: {
      format: 'csv',
      xml_mode: 'positions',
      delimiter: ';',
      identity: 'sku',
      identity_field: 'Kod',
      spreadsheet_safe: false,
      empty_policy: 'skip',
    },
    targets: warehouses.map((warehouse_id, i) => ({
      warehouse_id,
      quantity_scope: 'position',
      mapping: {
        quantity: 'Stan' + i,
        ...(on
          ? { lot_id: 'Partia' + i, unit_cost_minor: 'Koszt' + i, currency: 'Waluta' + i }
          : {}),
      },
      default_location: 'A-01',
    })),
    content: on
      ? `Kod;Stan0;Partia0;Koszt0;Waluta0;Stan1;Partia1;Koszt1;Waluta1\n${p.sku};8;${lots[warehouses[0]]};; ;5;${lots[warehouses[1]]};0;PLN`.replace(
          ';; ;',
          ';;;',
        )
      : `Kod;Stan0;Stan1\n${p.sku};8;5`,
    resolutions: [],
    ...changes,
  };
}
async function preview(b: Row) {
  return (await ok(prefix + '/previews', 'POST', b, 201)).preview as Row;
}
const consent = (p: Row, extra: Row = {}) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
  ack_unknown_loss_warehouse_ids: [],
  ack_surplus_warehouse_ids: [],
  ...extra,
});
const executePath = (p: Row) => prefix + '/previews/' + p.id + '/execute';
async function rows(kind: 'previews' | 'executions', id: string) {
  const all: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await ok(
      prefix + '/' + kind + '/' + id + '/rows' + (cursor ? '?cursor=' + cursor : ''),
    );
    assert(page.rows.length <= 50);
    all.push(...page.rows);
    cursor = page.next_cursor ?? undefined;
    assert.equal(new Set(all.map((r) => r.index)).size, all.length);
    if (!cursor) assert.equal(page.total, all.length);
  } while (cursor);
  return all;
}
async function stocks(p: Row) {
  return (
    await pool.query(
      'SELECT warehouse_id,on_hand,reserved,version FROM stock WHERE tenant_id=$1 AND product_id=$2 ORDER BY warehouse_id',
      [tenant, p.id],
    )
  ).rows;
}

for (const on of [false, true])
  test(`stock file atomically counts two warehouses WMS ${on ? 'ON' : 'OFF'} with reserved units, genuine receipts and exact replay`, async () => {
    const f = await prepare(on),
      before = await selected(physical),
      commerce = await selected(protectedCommerce),
      b = input(f.p, f.lots),
      p = await preview(b);
    assert.equal(p.summary.changed, 2);
    assert.equal(p.summary.invalid, 0);
    assert.equal(p.summary.conflicts, 0);
    assert.deepEqual(await selected(physical), before);
    assert.equal((await own('wms_stocktakes')).length, 0, 'Preview must not open child stocktakes');
    const r = await rows('previews', p.id);
    assert.equal(r.length, 2);
    assert.deepEqual(
      r.map((x) => [x.before.quantity, x.after.quantity]),
      [
        [10, 8],
        [3, 5],
      ],
    );
    if (on) {
      assert.equal(r[0].valuation.known_loss_minor, '634');
      assert.equal(r[1].valuation.known_surplus_minor, '0');
    }
    const body = consent(p, { ack_surplus_warehouse_ids: on ? [warehouses[1]] : [] });
    const executed = (await ok(executePath(p), 'POST', body, 201)).execution;
    const s = await stocks(f.p);
    assert.deepEqual(
      s.map((x) => [x.on_hand, x.reserved]),
      [
        [8, 4],
        [5, 0],
      ],
    );
    assert.deepEqual(await selected(protectedCommerce), commerce);
    assert.equal((await rows('executions', executed.id)).length, 2);
    if (on) {
      const heads = await own('wms_stocktakes');
      assert.equal(heads.length, 2);
      assert(heads.every((x) => x.row.state === 'posted'));
      assert.equal((await own('wms_stocktake_postings')).length, 2);
      const layers = (await own('wms_cost_layers')).map((x) => x.row);
      assert(layers.some((x) => x.stocktake_line_id && String(x.unit_cost_minor) === '0'));
      assert.equal((await own('wms_issue_fragments')).length, 0);
    } else
      assert.equal(
        (await own('stock_location_movements')).length - before.stock_location_movements.length,
        2,
      );
    const accepted = await snapshot();
    assert.equal((await ok(executePath(p), 'POST', body, 200)).reused, true);
    assert.deepEqual(await snapshot(), accepted);
    const changed = { ...body, client_key: randomUUID() };
    assert.equal((await req(executePath(p), 'POST', changed)).statusCode, 409);
    assert.deepEqual(await snapshot(), accepted);
    // Retained reserved custody remains usable after the shortage of free units.
    await setupApi('/orders/' + f.order!.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => setupApi(orderPath, 'GET', undefined), '/orders/' + f.order!.id + '/status', { status: 'picking' }));
    const layer = on
      ? (
          await pool.query(
            'SELECT layer_id,location FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2',
            [tenant, f.order!.id],
          )
        ).rows[0]
      : null;
    await setupApi('/orders/' + f.order!.id + '/scan', 'POST', {
      code: f.p.sku,
      location: 'A-01',
      ...(on ? { client_key: randomUUID(), layer_id: layer?.layer_id } : {}),
    });
    assert.equal((await stocks(f.p))[0].on_hand, 8);
  });

test('stock file last warehouse CAS conflict rolls back every first warehouse child and journal', async () => {
  const f = await prepare(true),
    p = await preview(input(f.p, f.lots));
  // A genuine reservation changes the last target after preview, without manufacturing a version.
  await setupApi('/orders', 'POST', {
    customer_name: 'Last warehouse race',
    email: 'last@example.test',
    address: {
      street: 'Testowa',
      building_number: '1',
      city: 'Warszawa',
      post_code: '00-001',
      country: 'PL',
    },
    payment_mode: 'cod',
    warehouse_id: warehouses[1],
    items: [{ product_id: f.p.id, quantity: 1 }],
  });
  const before = await snapshot();
  assert.equal(
    (await req(executePath(p), 'POST', consent(p, { ack_surplus_warehouse_ids: [warehouses[1]] })))
      .statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
});

test('stock file reserved zero is rejected while absent physical zero and explicit none do not materialize stock or bump versions', async () => {
  const f = await prepare(false),
    bad = input(f.p);
  bad.content = `Kod;Stan0;Stan1\n${f.p.sku};0;3`;
  const p = await preview(bad);
  assert(p.summary.invalid + p.summary.conflicts > 0);
  const before = await snapshot();
  assert.equal((await req(executePath(p), 'POST', consent(p))).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  const absent = await product(0);
  const third = randomUUID();
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Absent count','ABSENT')",
    [third, tenant],
  );
  const b = input(absent);
  b.targets = [
    {
      warehouse_id: third,
      quantity_scope: 'position',
      mapping: { quantity: 'Stan', operation: 'Op' },
      default_location: 'A-01',
    },
  ];
  b.content = `Kod;Stan;Op\n${absent.sku};0;count\n${f.p.sku};999;none`;
  const physicalBefore = await selected(physical),
    q = await preview(b);
  assert.equal(q.summary.changed, 0);
  const e = await ok(executePath(q), 'POST', consent(q), 201);
  assert(e.execution.id);
  assert.deepEqual(await selected(physical), physicalBefore);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM stock WHERE tenant_id=$1 AND warehouse_id=$2', [
        tenant,
        third,
      ])
    ).rows[0].n,
    0,
  );
});

test('stock file aggregate count requires all real bins and exact distribution instead of writing available quantity', async () => {
  const f = await prepare(false, false);
  const s = (await stocks(f.p))[0];
  await setupApi('/stock-location-moves', 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouses[0],
    product_id: f.p.id,
    expected_version: String(s.version),
    location: 'A-01',
    destination: 'B-02',
    quantity: 4,
    note: 'Genuine split physical bin',
  });
  const b = input(f.p);
  b.targets = [
    {
      warehouse_id: warehouses[0],
      quantity_scope: 'warehouse_total',
      mapping: { quantity: 'Stan' },
      default_location: null,
    },
  ];
  b.definition = { ...b.definition, format: 'xml', xml_mode: 'catalog', identity_field: 'sku' };
  b.targets[0].mapping = { quantity: 'inventory_json' };
  b.content = `<catalog currency="PLN"><product><sku type="string">${f.p.sku}</sku><inventory_json type="array"><item type="object"><entry key="warehouse_id" type="string">${warehouses[0]}</entry><entry key="status" type="string">available</entry><entry key="source" type="string">stock</entry><entry key="on_hand" type="number">9</entry><entry key="available" type="number">1</entry></item></inventory_json></product></catalog>`;
  const blocked = await preview(b);
  assert(blocked.summary.invalid > 0);
  b.client_key = randomUUID();
  b.resolutions = [
    {
      source_index: 0,
      warehouse_id: warehouses[0],
      positions: [
        { location: 'A-01', lot: null, quantity: 9, unit_cost_minor: null, currency: null },
      ],
    },
  ];
  const incomplete = await preview(b);
  assert(incomplete.summary.invalid + incomplete.summary.conflicts > 0);
  b.client_key = randomUUID();
  b.resolutions[0].positions = [
    { location: 'A-01', lot: null, quantity: 5, unit_cost_minor: null, currency: null },
    { location: 'B-02', lot: null, quantity: 4, unit_cost_minor: null, currency: null },
  ];
  const p = await preview(b);
  assert.equal(p.summary.invalid, 0);
  await ok(executePath(p), 'POST', consent(p), 201);
  const bins = (
    await pool.query(
      'SELECT location,quantity FROM stock_locations WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 ORDER BY location',
      [tenant, warehouses[0], f.p.id],
    )
  ).rows;
  assert.deepEqual(bins, [
    { location: 'A-01', quantity: 5 },
    { location: 'B-02', quantity: 4 },
  ]);
});

test('stock file identity ambiguity and duplicate physical rows block the whole file, historical SKU resolves the immutable product', async () => {
  const p = await product(),
    old = p.sku;
  await setupApi('/products/' + p.id, 'PATCH', {
    name: p.name,
    price: p.price,
    sku: 'RENAMED-' + randomUUID(),
    version: p.version,
  });
  const b = input({ ...p, sku: old });
  b.definition.identity = 'historical_sku';
  b.targets = b.targets.slice(0, 1);
  b.content = `Kod;Stan0\n${old};10`;
  const historical = await preview(b);
  assert.equal((await rows('previews', historical.id))[0].product_id, p.id);
  const dup = { ...b, client_key: randomUUID(), content: b.content + '\n' + old + ';9' };
  const d = await preview(dup);
  assert(d.summary.invalid + d.summary.conflicts > 0);
  const before = await snapshot();
  assert.equal((await req(executePath(d), 'POST', consent(d))).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  await setupApi('/products', 'POST', {
    name: p.name,
    sku: 'OTHER-' + randomUUID(),
    price: 1,
    quantity: 0,
    warehouse_id: warehouses[0],
  });
  const named = {
    ...b,
    client_key: randomUUID(),
    definition: { ...b.definition, identity: 'name' },
    content: `Kod;Stan0\n${p.name};9`,
  };
  const ambiguous = await preview(named);
  assert(ambiguous.summary.invalid > 0);
});

test('stock file complete 53-row pagination, mapping profile CAS and later profile changes do not alter frozen preview', async () => {
  const products: Row[] = [];
  for (let i = 0; i < 53; i++) products.push(await product(1));
  const b = input(products[0]);
  b.targets = b.targets.slice(0, 1);
  b.content = 'Kod;Stan0\n' + products.map((p) => p.sku + ';1').join('\n');
  const profile = (
    await ok(
      prefix + '/profiles',
      'POST',
      {
        client_key: randomUUID(),
        name: 'Own reusable map',
        definition: b.definition,
        targets: b.targets,
      },
      201,
    )
  ).profile;
  assert.equal(profile.version, 1);
  const p = await preview(b),
    before = await selected(physical),
    all = await rows('previews', p.id);
  assert.equal(all.length, 53);
  assert.equal(new Set(all.map((x) => x.product_id)).size, 53);
  const update = {
    client_key: randomUUID(),
    version: 1,
    name: 'Changed current mapping',
    definition: b.definition,
    targets: b.targets,
  };
  assert.equal((await ok(prefix + '/profiles/' + profile.id, 'PATCH', update)).profile.version, 2);
  const accepted = await snapshot();
  assert.equal(
    (
      await req(prefix + '/profiles/' + profile.id, 'PATCH', {
        ...update,
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), accepted);
  const execution = (await ok(executePath(p), 'POST', consent(p), 201)).execution;
  assert.equal((await rows('executions', execution.id)).length, 53);
  assert.deepEqual(await selected(physical), before);
});

test('stock file unknown loss needs exactly its warehouse consent and preserves unknown cost instead of inventing zero value', async () => {
  const f = await prepare(true, false, true),
    b = input(f.p, f.lots);
  b.targets = b.targets.slice(0, 1);
  b.definition.format = 'xml';
  b.content = `<dynaminds-stock-counts version="1"><row><field name="Kod">${f.p.sku}</field><field name="Stan0">8</field><field name="Partia0">${f.lots[warehouses[0]]}</field><field name="Koszt0"></field><field name="Waluta0"></field></row></dynaminds-stock-counts>`;
  const p = await preview(b);
  assert.equal(p.summary.unknown_loss_quantity, 2);
  const before = await snapshot();
  for (const ids of [[], [warehouses[1]], [warehouses[0], warehouses[1]]]) {
    const response = await req(
      executePath(p),
      'POST',
      consent(p, { ack_unknown_loss_warehouse_ids: ids }),
    );
    assert.equal(response.statusCode, 422);
    assert.deepEqual(await snapshot(), before);
  }
  const executed = (
    await ok(
      executePath(p),
      'POST',
      consent(p, { ack_unknown_loss_warehouse_ids: [warehouses[0]] }),
      201,
    )
  ).execution;
  const observed = await rows('executions', executed.id);
  assert.equal(observed.length, 1);
  assert.equal((await stocks(f.p))[0].on_hand, 8);
  const layers = (await own('wms_cost_layers')).map((x) => x.row);
  assert(layers.every((x) => x.unit_cost_minor === null));
  assert.equal((await own('wms_stocktake_postings')).length, 1);
  assert.equal((await own('wms_issue_fragments')).length, 0);
});
