import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_(?:test_\d+|(?:p277|m26[123])_202610(?:29|30)_\d{2})$/);
type Engine = 'wms' | 'quantity';
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>,
  tenant = '',
  warehouse = '',
  ip = 1,
  calls = 0;
const cookies = new Map<string, string>();
const physical = [
  'products',
  'product_sku_aliases',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
  'wms_operations',
  'payment_entries',
  'order_events',
  'jobs',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
const evidence = [
  'stocktakes',
  'stocktake_lines',
  'stocktake_measurements',
  'wms_stocktakes',
  'wms_stocktake_lines',
  'wms_stocktake_scope_layers',
  'wms_stocktake_measurements',
  'wms_stocktake_measurement_layers',
  'wms_stocktake_reviews',
  'wms_stocktake_review_rows',
  'wms_stocktake_postings',
  'stocktake_scan_receipts',
  'audit_events',
];
const auth = (email = 'admin@demo.local') => cookies.get(email)!;
const req = (path: string, method: any = 'GET', payload?: any, cookie = auth()) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.151.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any, cookie?: string) {
  const r = await req(path, method, body, cookie);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: ${r.statusCode}`);
  return r.json() as Row;
}
test('wms: one lot-bin scan preserves two genuine cost layers and records each exactly once', async () => {
  const original = await fixture('wms');
  // The existing stocktake posting creates a genuine second layer of the same
  // lot, with distinct cost; no raw source or quantity invariant is bypassed.
  await manual(original, 8);
  let head = (await ok(original.base)).stocktake;
  const oldLine = (await ok(original.base + '/lines')).data[0];
  const { review } = await ok(original.base + '/reviews', 'POST', {
    client_key: randomUUID(), version: head.version, note: 'Genuine same-lot surplus layer',
    surplus: [{ line_id: oldLine.id, unit_cost_minor: '401', currency: 'PLN' }],
  });
  head = (await ok(original.base)).stocktake;
  await ok(original.base + '/post', 'POST', {
    client_key: randomUUID(), version: head.version, review_id: review.id,
    scope_hash: review.scope_hash, confirmed: true,
  });
  const layers = (await pool.query(
    `SELECT l.id,l.lot_id,l.unit_cost_minor,p.quantity FROM wms_cost_layers l
     JOIN wms_layer_positions p ON (p.tenant_id,p.layer_id,p.product_id)=(l.tenant_id,l.id,l.product_id)
     WHERE l.tenant_id=$1 AND l.product_id=$2 ORDER BY l.fifo_sequence`,
    [tenant, original.products[0].id],
  )).rows;
  assert.equal(layers.length, 2);
  assert.equal(layers[0].lot_id, layers[1].lot_id);
  assert.deepEqual(layers.map(l => ({ quantity: l.quantity, cost: l.unit_cost_minor })), [
    { quantity: 7, cost: '317' }, { quantity: 1, cost: '401' },
  ]);
  const { stocktake } = await ok('/wms-lots/stocktakes', 'POST', {
    client_key: randomUUID(), warehouse_id: warehouse, name: 'Two-layer single lot scope',
    policy_version: '1', blind: true,
  });
  assert.equal(stocktake.line_count, 1);
  const f: Fixture = { ...original, id: stocktake.id, base: '/wms-lots/stocktakes/' + stocktake.id };
  const before = await snapshot(physical), zero = await begin(f), one = await ok(
    f.base + '/scans', 'POST', scanBody(await candidate(f), f.products[0].ean),
  );
  assert.equal(one.scan.counted, 1);
  for (const measurement of [zero.scan.measurement_id, one.scan.measurement_id]) {
    const proof = (await pool.query(
      `SELECT line_id,layer_id FROM wms_stocktake_measurement_layers
       WHERE tenant_id=$1 AND measurement_id=$2 ORDER BY layer_id`, [tenant, measurement],
    )).rows;
    assert.equal(proof.length, 2);
    assert(proof.every(p => p.line_id === one.scan.line_id));
    assert.deepEqual(proof.map(p => p.layer_id), layers.map(l => l.id).sort());
  }
  assert.equal((await pool.query(
    'SELECT count(*)::int n FROM stock_locations WHERE tenant_id=$1 AND product_id=$2',
    [tenant, f.products[0].id],
  )).rows[0].n, 1);
  assert.deepEqual(await snapshot(physical), before);
  assert.equal(calls, 0);
});

test('wms: explicit NULL-lot discovery can start and scan without inventing layers or physical stock', async () => {
  const product = await ok('/products', 'POST', {
    sku: 'FOUND-' + randomUUID(), ean: '000001130', name: 'Explicit discovered physical item',
    price: 100, warehouse_id: warehouse, quantity: 0, location: 'A-01',
  });
  const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
    client_key: randomUUID(), policy_version: '0', currency: 'PLN',
    note: 'Actual empty stock opening for explicit discovery', lines: [],
  });
  assert(preview.ready);
  await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
    client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true, ack_unknown_costs: false,
  });
  const lot = { id: null, lot_code: 'FOUND-113', expiry_date: '2027-01-01' };
  const { stocktake } = await ok('/wms-lots/stocktakes', 'POST', {
    client_key: randomUUID(), warehouse_id: warehouse, name: 'Explicit discovered NULL lot',
    policy_version: '1', blind: true,
    discoveries: [{ product_id: product.id, location: 'FOUND-01',
      lot: { kind: 'new', lot_code: lot.lot_code, expiry_date: lot.expiry_date } }],
  });
  assert.equal(stocktake.line_count, 1);
  const f: Fixture = { engine: 'wms', products: [product], id: stocktake.id,
    base: '/wms-lots/stocktakes/' + stocktake.id };
  const before = await snapshot(physical), c = (await resolve(f, product.ean, auth(), 'FOUND-01')).data[0];
  assert(c); assert.deepEqual(c.lot, lot);
  const zero = await ok(f.base + '/scan-start', 'POST', startBody(c, product.ean));
  const current = (await resolve(f, product.ean, auth(), 'FOUND-01')).data[0];
  assert(current.can_continue);
  const one = await ok(f.base + '/scans', 'POST', scanBody(current, product.ean));
  assert.equal(one.scan.counted, 1); assert.deepEqual(one.scan.lot, lot);
  assert.equal(one.scan.generation_id, zero.scan.id);
  for (const measurement of [zero.scan.measurement_id, one.scan.measurement_id]) assert.equal(
    (await pool.query('SELECT count(*)::int n FROM wms_stocktake_measurement_layers WHERE tenant_id=$1 AND measurement_id=$2',
      [tenant, measurement])).rows[0].n, 0,
  );
  assert.deepEqual(await snapshot(physical), before);
  assert.equal(calls, 0);
});
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      ++calls;
      throw Error('Scanning must never call providers');
    },
    logging: process.env.STOCKTAKE_SCAN_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local']) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
});
beforeEach(async () => {
  ++ip;
  calls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Scan engines own fixture','enterprise')",
    [tenant],
  );
  await pool.query(
    `INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])`,
    [tenant, [...cookies.keys()]],
  );
  for (const [email, cookie] of cookies) {
    const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Scanned warehouse','SCAN')",
    [warehouse, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function snapshot(names = [...physical, ...evidence]) {
  const result: Row = {};
  for (const table of names)
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}
async function fixture(engine: Engine, definitions: Row[] = [{}]) {
  const products: Row[] = [];
  for (const [i, extra] of definitions.entries())
    products.push(
      await ok('/products', 'POST', {
        sku: 'SCAN-' + randomUUID(),
        ean: '000' + (12340 + i),
        name: 'Physical scan product ' + i,
        price: 1234,
        warehouse_id: warehouse,
        quantity: 7,
        location: 'A-01',
        ...extra,
      }),
    );
  const base = engine === 'wms' ? '/wms-lots/stocktakes' : '/stocktakes';
  if (engine === 'wms') {
    const lines = [];
    for (const p of products)
      lines.push({
        warehouse_id: warehouse,
        product_id: p.id,
        location: 'A-01',
        quantity: 7,
        stock_version: (
          await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
            tenant,
            p.id,
          ])
        ).rows[0].version,
        lot_code: 'SCAN-LOT-' + p.id,
        unit_cost_minor: '317',
      });
    const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Controlled scan opening',
      lines,
    });
    assert(preview.ready);
    await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
      client_key: randomUUID(),
      scope_hash: preview.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    });
  }
  const created = await ok(base, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    name: 'Blind scan engine fixture',
    blind: true,
    ...(engine === 'wms' ? { policy_version: '1' } : {}),
  });
  const head = created.stocktake ?? created;
  return { engine, products, id: head.id, base: base + '/' + head.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function resolve(
  f: Fixture,
  code = f.products[0].ean,
  cookie = auth(),
  location = 'A-01',
  limit = 100,
  cursor?: string,
) {
  return ok(
    f.base +
      '/scan-candidates?' +
      new URLSearchParams({ code, location, limit: String(limit), ...(cursor ? { cursor } : {}) }),
    'GET',
    undefined,
    cookie,
  );
}
async function candidate(f: Fixture, cookie = auth(), code = f.products[0].ean) {
  const r = await resolve(f, code, cookie);
  assert.equal(r.data.length, 1);
  return r.data[0] as Row;
}
const startBody = (c: Row, code: string, reset = false) => ({
  client_key: randomUUID(),
  line_id: c.line_id,
  version: c.line_version,
  basis_token: c.basis_token,
  code,
  location: c.location,
  resolution_token: c.resolution_token,
  expires_at: c.expires_at,
  confirmed_zero: true,
  confirmed_reset: reset,
  note: 'Begin explicit physical recount',
});
const scanBody = (c: Row, code: string) => ({
  client_key: randomUUID(),
  line_id: c.line_id,
  version: c.line_version,
  basis_token: c.basis_token,
  generation_id: c.generation_id,
  code,
  location: c.location,
  resolution_token: c.resolution_token,
  expires_at: c.expires_at,
  increment: 1,
});
async function begin(f: Fixture, cookie = auth(), reset = false): Promise<Row> {
  const c = await candidate(f, cookie);
  const body = startBody(c, f.products[0].ean, reset);
  return { body, ...(await ok(f.base + '/scan-start', 'POST', body, cookie)) };
}
async function manual(f: Fixture, quantity: number) {
  if (f.engine === 'wms') {
    const line = (await ok(f.base + '/lines')).data[0];
    return ok(f.base + '/counts', 'POST', {
      client_key: randomUUID(),
      note: 'Independent manual count',
      lines: [{ id: line.id, version: line.version, basis_token: line.basis_token, quantity }],
    });
  }
  const line = (await ok(f.base)).lines[0];
  return ok(f.base + '/counts', 'POST', {
    client_key: randomUUID(),
    note: 'Independent manual count',
    lines: [
      {
        id: line.id,
        version: line.version,
        expected_stock_version: line.current_stock_version,
        quantity,
      },
    ],
  });
}
async function move(f: Fixture, location: string, destination: string) {
  const p = f.products[0],
    version = (
      await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        p.id,
      ])
    ).rows[0].version;
  if (f.engine === 'wms') {
    const { preview } = await ok('/wms-lots/movement-previews', 'POST', {
      client_key: randomUUID(),
      policy_version: '1',
      kind: 'bin_move',
      product_id: p.id,
      warehouse_id: warehouse,
      location,
      destination_location: destination,
      quantity: 1,
      stock_versions: [{ warehouse_id: warehouse, product_id: p.id, version }],
      note: 'Actual physical scan ABA',
    });
    await ok('/wms-lots/movement-previews/' + preview.id + '/execute', 'POST', {
      client_key: randomUUID(),
      scope_hash: preview.scope_hash,
      confirmed: true,
    });
  } else
    await ok('/stock-location-moves', 'POST', {
      client_key: randomUUID(),
      product_id: p.id,
      warehouse_id: warehouse,
      location,
      destination,
      quantity: 1,
      expected_version: version,
      note: 'Actual physical scan ABA',
    });
}
for (const engine of ['wms', 'quantity'] as const) {
  test(
    engine +
      ': explicit zero and scans persist observational receipts without physical/OMS/provider effects',
    async () => {
      const f = await fixture(engine),
        physicalBefore = await snapshot(physical),
        operator = auth('operator@demo.local');
      const before = await candidate(f, operator);
      assert.equal(before.counted, null);
      assert.equal(before.generation_id, null);
      const zero = await begin(f, operator);
      assert.equal(zero.scan.counted, 0);
      assert.equal(zero.scan.previous_count, null);
      assert.equal(zero.scan.generation_id, zero.scan.id);
      assert.equal(zero.scan.increment, 0);
      const receipts = [zero.scan];
      for (let i = 1; i <= 3; ++i) {
        const c = await candidate(f, operator);
        assert(c.can_continue);
        assert.equal(c.generation_id, zero.scan.id);
        const r = await ok(f.base + '/scans', 'POST', scanBody(c, f.products[0].ean), operator);
        assert.equal(r.scan.previous_count, i - 1);
        assert.equal(r.scan.counted, i);
        assert.equal(r.scan.increment, 1);
        receipts.push(r.scan);
      }
      const history = await ok(f.base + '/scans?limit=100', 'GET', undefined, operator);
      assert.equal(history.data.length, 4);
      assert.deepEqual(
        new Set(history.data.map((r: Row) => r.id)),
        new Set(receipts.map((r) => r.id)),
      );
      assert.deepEqual(await snapshot(physical), physicalBefore);
      assert.equal(calls, 0);
    },
  );
  test(
    engine +
      ': manual count and explicit reset invalidate generations while exact old replay stays immutable',
    async () => {
      const f = await fixture(engine),
        zero = await begin(f),
        c = await candidate(f),
        body = scanBody(c, f.products[0].ean),
        first = await ok(f.base + '/scans', 'POST', body);
      await manual(f, 5);
      const afterManual = await candidate(f);
      assert.equal(afterManual.counted, 5);
      assert.equal(afterManual.can_continue, false);
      const oldGeneration = {
        ...scanBody(afterManual, f.products[0].ean),
        generation_id: zero.scan.generation_id,
      };
      const before = await snapshot();
      assert.equal((await req(f.base + '/scans', 'POST', oldGeneration)).statusCode, 409);
      assert.equal(
        (await req(f.base + '/scan-start', 'POST', startBody(afterManual, f.products[0].ean)))
          .statusCode,
        409,
      );
      assert.deepEqual(await snapshot(), before);
      const reset = await begin(f, auth(), true);
      assert.notEqual(reset.scan.generation_id, zero.scan.generation_id);
      assert.equal(reset.scan.previous_count, 5);
      assert.equal(reset.scan.counted, 0);
      const resetSnapshot = await snapshot();
      const retry = await ok(
        f.base + '/scans',
        'POST',
        Object.fromEntries(Object.entries(body).reverse()),
      );
      assert(retry.reused);
      assert.deepEqual(retry.scan, first.scan);
      assert.deepEqual(await snapshot(), resetSnapshot);
      assert.equal(
        (await req(f.base + '/scans', 'POST', { ...body, code: f.products[0].sku })).statusCode,
        409,
      );
      const operatorCandidate = await candidate(f, auth('operator@demo.local'));
      assert(operatorCandidate);
      assert.equal(
        (await req(f.base + '/scans', 'POST', body, auth('operator@demo.local'))).statusCode,
        409,
      );
      assert.deepEqual(await snapshot(), resetSnapshot);
    },
  );
  test(
    engine +
      ': same-version concurrent scans have one winner; same-key retry has exactly one linked measurement',
    async () => {
      const f = await fixture(engine);
      await begin(f);
      const c = await candidate(f),
        a = scanBody(c, f.products[0].ean),
        b = { ...a, client_key: randomUUID() };
      const pair = await Promise.all([
        req(f.base + '/scans', 'POST', a),
        req(f.base + '/scans', 'POST', b),
      ]);
      assert.deepEqual(pair.map((r) => r.statusCode).sort(), [201, 409]);
      const winning = pair.find((r) => r.statusCode === 201)!.json();
      assert.equal(winning.scan.counted, 1);
      const current = await candidate(f),
        key = scanBody(current, f.products[0].ean),
        beforeCount = (
          await pool.query(
            'SELECT count(*)::int n FROM stocktake_scan_receipts WHERE tenant_id=$1',
            [tenant],
          )
        ).rows[0].n;
      const repeated = await Promise.all([
        req(f.base + '/scans', 'POST', key),
        req(f.base + '/scans', 'POST', key),
      ]);
      assert.deepEqual(repeated.map((r) => r.statusCode).sort(), [200, 201]);
      assert.deepEqual(repeated[0].json().scan, repeated[1].json().scan);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM stocktake_scan_receipts WHERE tenant_id=$1',
            [tenant],
          )
        ).rows[0].n,
        beforeCount + 1,
      );
      assert.equal((await candidate(f)).counted, 2);
      const table = engine === 'wms' ? 'wms_stocktake_measurements' : 'stocktake_measurements';
      assert.equal(
        (await pool.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [tenant]))
          .rows[0].n,
        3,
      );
    },
  );
  test(
    engine +
      ': exact code collisions remain explicit candidates; frozen/history SKUs survive rename and out-of-scope codes stay inert',
    async () => {
      const code = '000012340',
        f = await fixture(engine, [{ ean: code }, { sku: code, ean: '000088888' }]);
      const r = await resolve(f, code);
      assert.equal(r.meta.total, 2);
      assert.equal(r.data.length, 2);
      assert.deepEqual(
        new Set(r.data.map((v: Row) => v.product_id)),
        new Set(f.products.map((p) => p.id)),
      );
      assert(r.data.every((v: Row) => v.counted === null));
      const before = await snapshot();
      assert.equal((await resolve(f, '12340')).data.length, 0);
      assert.equal((await resolve(f, code, auth(), 'MISSING-BIN')).data.length, 0);
      assert.deepEqual(await snapshot(), before);
      const p = await ok('/products/' + f.products[0].id);
      await ok('/products/' + p.id, 'PATCH', {
        ...p,
        sku: 'RENAMED-' + randomUUID(),
        ean: '000099999',
        version: p.version,
      });
      const historical = await resolve(f, p.sku);
      assert.equal(historical.data.length, 1);
      assert.equal(historical.data[0].product_id, p.id);
      assert(historical.data[0].matched_by.includes('frozen_sku'));
      assert.equal(historical.data[0].sku, p.sku);
      const current = await resolve(f, '000099999');
      assert.equal(current.data[0].product_id, p.id);
      assert(current.data[0].matched_by.includes('current_ean'));
      const outside = await ok('/products', 'POST', {
        sku: 'OUTSIDE-' + randomUUID(),
        ean: '000077777',
        name: 'Not in frozen scope',
        price: 111,
        warehouse_id: warehouse,
        quantity: 0,
        location: 'A-01',
      });
      assert(outside.id);
      const after = await snapshot();
      assert.equal((await resolve(f, outside.ean)).data.length, 0);
      assert.deepEqual(await snapshot(), after);
    },
  );
  test(
    engine +
      ': changed product/candidate set fences a resolver even when physical quantity is untouched',
    async () => {
      const f = await fixture(engine, [{}, { ean: '000055555' }]),
        c = (await resolve(f)).data.find((v: Row) => v.product_id === f.products[0].id),
        stale = startBody(c, f.products[0].ean);
      const second = await ok('/products/' + f.products[1].id);
      await ok('/products/' + second.id, 'PATCH', {
        ...second,
        ean: f.products[0].ean,
        version: second.version,
      });
      const before = await snapshot();
      assert.equal((await req(f.base + '/scan-start', 'POST', stale)).statusCode, 409);
      assert.deepEqual(await snapshot(), before);
      const fresh = await resolve(f);
      assert.equal(fresh.meta.total, 2);
      assert.deepEqual(
        new Set(fresh.data.map((v: Row) => v.product_id)),
        new Set(f.products.map((p) => p.id)),
      );
    },
  );
  test(
    engine +
      ': physical ABA and manual recount cannot continue a previous start through a fresh resolver',
    async () => {
      const f = await fixture(engine);
      const zero = await begin(f);
      await move(f, 'A-01', 'B-01');
      await move(f, 'B-01', 'A-01');
      const current = await candidate(f);
      assert.equal(current.counted, 0);
      assert.equal(current.can_continue, false);
      const before = await snapshot();
      assert.equal(
        (
          await req(f.base + '/scans', 'POST', {
            ...scanBody(current, f.products[0].ean),
            generation_id: zero.scan.generation_id,
          })
        ).statusCode,
        409,
      );
      assert.deepEqual(await snapshot(), before);
      await begin(f, auth(), true);
      assert.equal((await candidate(f)).can_continue, true);
    },
  );
  test(
    engine + ': receipt history is paged exactly and terminal replay never reopens the line',
    async () => {
      const f = await fixture(engine);
      const first = await begin(f);
      const expected = new Set([first.scan.id]);
      for (let i = 0; i < 5; ++i)
        expected.add(
          (await ok(f.base + '/scans', 'POST', scanBody(await candidate(f), f.products[0].ean)))
            .scan.id,
        );
      let cursor: string | undefined,
        pages = 0;
      const seen = new Set<string>();
      do {
        const page = await ok(
          f.base + '/scans?' + new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) }),
        );
        for (const row of page.data) {
          assert(!seen.has(row.id));
          seen.add(row.id);
        }
        cursor = page.meta.cursor ?? undefined;
        assert(++pages <= 3);
      } while (cursor);
      assert.equal(pages, 3);
      assert.deepEqual(seen, expected);
      const raw = await ok(f.base),
        head = raw.stocktake ?? raw;
      await ok(f.base + '/cancel', 'POST', {
        version: head.version,
        ...(engine === 'wms'
          ? { client_key: randomUUID(), note: 'End actual scan generation' }
          : {}),
      });
      const terminalSnapshot = await snapshot();
      const retry = await ok(f.base + '/scan-start', 'POST', first.body);
      assert(retry.reused);
      assert.deepEqual(retry.scan, first.scan);
      const c = await candidate(f);
      assert.equal(c.can_continue, false);
      assert.equal(
        (await req(f.base + '/scan-start', 'POST', startBody(c, f.products[0].ean, true)))
          .statusCode,
        409,
      );
      assert.deepEqual(await snapshot(), terminalSnapshot);
    },
  );
  test(
    engine +
      ': real scan measurements feed the existing admin review/post and preserve immutable scan replay',
    async () => {
      const f = await fixture(engine),
        first = await begin(f),
        productVersion = f.products[0].version;
      for (let n = 0; n < 3; ++n)
        await ok(f.base + '/scans', 'POST', scanBody(await candidate(f), f.products[0].ean));
      let raw = await ok(f.base),
        h = raw.stocktake ?? raw;
      if (engine === 'wms') {
        const { review } = await ok(f.base + '/reviews', 'POST', {
          client_key: randomUUID(),
          version: h.version,
          note: 'Approve actual three scanned units',
          surplus: [],
        });
        raw = await ok(f.base);
        h = raw.stocktake;
        const posted = await ok(f.base + '/post', 'POST', {
          client_key: randomUUID(),
          version: h.version,
          review_id: review.id,
          scope_hash: review.scope_hash,
          confirmed: true,
        });
        assert.equal(posted.posting.state, 'posted');
        assert.equal(posted.posting.summary.shortage_quantity, 4);
        assert.equal(posted.posting.summary.known_loss_minor, '1268');
        // A stocktake shortage is a warehouse correction, not sales COGS or
        // dispatch. Prove the typed journal and the remaining original layer.
        const movements = (
          await pool.query(
            `SELECT kind,delta,value_delta FROM wms_layer_movements
             WHERE tenant_id=$1 AND operation_id=$2 AND product_id=$3`,
            [tenant, posted.posting.wms_operation_id, f.products[0].id],
          )
        ).rows;
        assert.deepEqual(movements, [{ kind: 'stocktake', delta: -4, value_delta: '-1268' }]);
        const layers = (
          await pool.query(
            `SELECT p.location,p.quantity,p.reserved,l.quantity_received,l.unit_cost_minor,
                    (p.quantity::bigint*l.unit_cost_minor)::text remaining_value_minor
             FROM wms_layer_positions p JOIN wms_cost_layers l
             ON (l.tenant_id,l.id,l.product_id)=(p.tenant_id,p.layer_id,p.product_id)
             WHERE p.tenant_id=$1 AND p.warehouse_id=$2 AND p.product_id=$3`,
            [tenant, warehouse, f.products[0].id],
          )
        ).rows;
        assert.deepEqual(layers, [
          {
            location: 'A-01',
            quantity: 3,
            reserved: 0,
            quantity_received: 7,
            unit_cost_minor: '317',
            remaining_value_minor: '951',
          },
        ]);
        assert.deepEqual(
          (
            await pool.query(
              `SELECT delta,kind FROM stock_location_movements
             WHERE tenant_id=$1 AND operation_id=$2 AND product_id=$3`,
              [tenant, posted.posting.wms_operation_id, f.products[0].id],
            )
          ).rows,
          [{ delta: -4, kind: 'wms_stocktake' }],
        );
        assert.deepEqual(
          (
            await pool.query(
              `SELECT location,quantity FROM stock_locations
             WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3`,
              [tenant, warehouse, f.products[0].id],
            )
          ).rows,
          [{ location: 'A-01', quantity: 3 }],
        );
        const issues = (
          await pool.query(
            'SELECT quantity,value_minor FROM wms_issue_fragments WHERE tenant_id=$1 AND product_id=$2',
            [tenant, f.products[0].id],
          )
        ).rows;
        assert.deepEqual(
          issues,
          [],
          'A physical shortage must not invent a dispatch issue fragment',
        );
      } else {
        h = await ok(f.base + '/review', 'POST', { version: h.version });
        assert.equal(h.state, 'review');
        const posted = await ok(f.base + '/post', 'POST', { version: h.version, confirmed: true });
        assert.equal(posted.state, 'posted');
      }
      assert.equal(
        (
          await pool.query('SELECT on_hand FROM stock WHERE tenant_id=$1 AND product_id=$2', [
            tenant,
            f.products[0].id,
          ])
        ).rows[0].on_hand,
        3,
      );
      assert.equal(
        (
          await pool.query('SELECT version FROM products WHERE tenant_id=$1 AND id=$2', [
            tenant,
            f.products[0].id,
          ])
        ).rows[0].version,
        productVersion,
      );
      const after = await snapshot(),
        retry = await ok(f.base + '/scan-start', 'POST', first.body);
      assert(retry.reused);
      assert.deepEqual(retry.scan, first.scan);
      assert.equal(retry.can_scan, false);
      assert.deepEqual(await snapshot(), after);
      assert.equal(calls, 0);
    },
  );
}
