// Local synthetic QA. Never prints credentials, session cookies or portal tokens.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2];
const path = 'data/returns-stage014.json';
async function snapshot() {
  return {
    orders: (
      await pool.query('SELECT id,tenant_id,number,status,total,currency FROM orders ORDER BY id')
    ).rows,
    stock: (
      await pool.query(
        'SELECT tenant_id,product_id,warehouse_id,on_hand,reserved FROM stock ORDER BY tenant_id,product_id,warehouse_id',
      )
    ).rows,
    movements: Number((await pool.query('SELECT count(*) FROM stock_movements')).rows[0].count),
    documents: Number((await pool.query('SELECT count(*) FROM documents')).rows[0].count),
  };
}
let cookie = '';
async function api(url: string, method = 'GET', body?: any) {
  const response = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(url === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.headers.get('set-cookie'))
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  const result = await response.json();
  assert(response.ok, `${url}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
try {
  if (phase === 'baseline') {
    assert.equal((await api('/health')).schema_revision, '013_developer_api');
    const before = await snapshot();
    await writeFile(path, JSON.stringify({ before }, null, 2));
    console.log(
      JSON.stringify({
        orders: before.orders.length,
        stock_rows: before.stock.length,
        movements: before.movements,
        documents: before.documents,
      }),
    );
  } else if (phase === 'migrated') {
    const data = JSON.parse(await readFile(path, 'utf8'));
    assert.equal((await api('/health')).schema_revision, '014_returns');
    assert.deepEqual(await snapshot(), data.before);
    const legacy = (
      await pool.query(`SELECT r.id,r.number,r.state,r.refund_amount,r.refunded_at,r.settlement,
      (SELECT sum(accepted)::int FROM return_items i WHERE i.return_id=r.id) AS accepted
      FROM return_cases r WHERE legacy ORDER BY r.id`)
    ).rows;
    assert.equal(
      legacy.length,
      data.before.orders.filter((o: any) => o.status.startsWith('return_')).length,
    );
    assert(legacy.every((r: any) => r.refunded_at === null && r.settlement === null));
    data.migration = {
      unchanged_business_snapshot: true,
      legacy_cases: legacy.length,
      no_invented_payment: true,
    };
    await writeFile(path, JSON.stringify(data, null, 2));
    console.log(JSON.stringify(data.migration));
  } else if (phase === 'setup') {
    const data = JSON.parse(await readFile(path, 'utf8'));
    assert(!data.fixture, 'Fixture already exists; no duplicate setup');
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    const organization = await api('/workspaces', 'POST', {
      name: 'QA Zwroty 20261004',
      currency: 'PLN',
      locale: 'pl-PL',
    });
    const warehouse = (await api('/warehouses')).data[0];
    const product = await api('/products', 'POST', {
      name: 'QA częściowy zwrot — produkt demonstracyjny',
      sku: 'QA-RET-20261004',
      price: 11001,
      quantity: 6,
      warehouse_id: warehouse.id,
    });
    const order = await api('/orders', 'POST', {
      customer_name: 'Klient QA Zwroty',
      email: 'returns@example.test',
      warehouse_id: warehouse.id,
      shipping_cost: 1499,
      items: [{ product_id: product.id, quantity: 2 }],
      address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    });
    // One-cent discount imported into this newly created synthetic order only, before documents.
    const client = await pool.connect();
    await client.query('BEGIN');
    try {
      await client.query('UPDATE order_items SET line_total=22001 WHERE order_id=$1', [order.id]);
      await client.query('UPDATE orders SET total=23500 WHERE id=$1', [order.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    for (const status of ['paid', 'picking'])
      await api('/orders/' + order.id + '/status', 'PATCH', { status });
    for (let i = 0; i < 2; i++)
      await api('/orders/' + order.id + '/scan', 'POST', { code: product.sku });
    await api('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
    await api('/orders/' + order.id + '/ship-demo', 'POST', {});
    await api('/orders/' + order.id + '/documents', 'POST', { kind: 'invoice' });
    data.fixture = {
      tenant_id: organization.user.tenant_id,
      organization: 'QA Zwroty 20261004',
      warehouse_id: warehouse.id,
      product_id: product.id,
      sku: product.sku,
      order_id: order.id,
      number: order.number,
      total: 23500,
      line_total: 22001,
      initial_stock: 6,
      after_shipment: 4,
      synthetic_discount: 1,
    };
    await writeFile(path, JSON.stringify(data, null, 2));
    console.log(JSON.stringify(data.fixture));
  } else if (phase === 'verify') {
    const data = JSON.parse(await readFile(path, 'utf8')),
      f = data.fixture;
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    await api('/workspaces/switch', 'POST', { tenant_id: f.tenant_id });
    const order = await api('/orders/' + f.order_id);
    assert.equal(order.total, 23500);
    assert.equal(order.items[0].line_total, 22001);
    assert.equal(order.status, 'return_completed');
    assert.equal(order.returns.refund_total, 23500);
    assert.equal(order.returns.settled_total, 23500);
    assert.equal(order.returns.items[0].returned, 2);
    assert.equal(order.returns.items[0].available, 0);
    const cases = order.returns.cases;
    assert.equal(cases.length, 2);
    assert(cases.every((r: any) => r.state === 'closed' && !r.legacy));
    assert.deepEqual(
      cases.map((r: any) => r.refund_amount).sort((a: number, b: number) => a - b),
      [11000, 12500],
    );
    const stock = (
      await pool.query(
        'SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2',
        [f.product_id, f.warehouse_id],
      )
    ).rows[0];
    assert.deepEqual(stock, { on_hand: 5, reserved: 0 });
    const documents = (
      await pool.query(
        `SELECT number,kind,mode,return_id,(data->>'total')::int AS total FROM documents WHERE order_id=$1 ORDER BY created_at`,
        [f.order_id],
      )
    ).rows;
    for (const mode of ['demo', 'simulation']) {
      const corrections = documents.filter((d: any) => d.kind === 'correction' && d.mode === mode);
      assert.equal(corrections.length, 2, mode);
      assert.equal(
        corrections.reduce((n: number, d: any) => n + d.total, 0),
        -23500,
      );
    }
    const movements = (
      await pool.query(
        'SELECT delta,return_id FROM stock_movements WHERE order_id=$1 AND return_id IS NOT NULL',
        [f.order_id],
      )
    ).rows;
    assert.equal(movements.length, 1);
    assert.equal(movements[0].delta, 1);
    const previous = await snapshot();
    assert.deepEqual(
      previous.orders.filter((o: any) => o.id !== f.order_id),
      data.before.orders,
    );
    assert.deepEqual(
      previous.stock.filter((s: any) => s.product_id !== f.product_id),
      data.before.stock,
    );
    const spec = await api('/v1/openapi');
    const count = Object.values(spec.paths).reduce(
      (n: number, p: any) => n + Object.keys(p).length,
      0,
    );
    assert.equal(count, 36);
    const key = await api('/developer/keys', 'POST', {
      name: 'QA stage014 read-only proof',
      scopes: ['orders:read'],
    });
    const publicRead = async (url: string, method = 'GET', body?: any) =>
      fetch('http://127.0.0.1:4100/api/v1' + url, {
        method,
        headers: { authorization: 'Bearer ' + key.token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      const response = await publicRead('/orders/' + f.order_id + '/returns');
      assert.equal(response.status, 200);
      const summary = await response.json();
      assert.equal(summary.refund_total, 23500);
      assert.equal(summary.cases.length, 2);
      assert.equal(
        (await publicRead('/returns/' + cases[0].id + '/receive', 'POST', {})).status,
        403,
      );
    } finally {
      await api('/developer/keys/' + key.id, 'DELETE');
    }
    assert.equal((await publicRead('/returns/' + cases[0].id)).status, 401);
    const report = {
      checked_at: new Date().toISOString(),
      scope: 'local_synthetic_UI_and_HTTP_not_provider_account',
      fixture: f,
      migration: data.migration,
      order: {
        number: order.number,
        status: order.status,
        total: order.total,
        line_total: order.items[0].line_total,
        refund_total: order.returns.refund_total,
        settled_total: order.returns.settled_total,
      },
      cases: cases.map((r: any) => ({
        number: r.number,
        kind: r.kind,
        state: r.state,
        refund_amount: r.refund_amount,
        shipping: r.refunded_shipping,
        received: r.items[0].accepted,
        restocked: r.items[0].restocked,
        reference: r.settlement.reference,
      })),
      stock,
      documents,
      movements,
      previous_orders_and_stock_unchanged: true,
      public_api_operations: count,
      bearer_read: true,
      write_denial: 403,
      revoked_key_denial: 401,
    };
    await writeFile('docs/returns-qa.json', JSON.stringify(report, null, 2) + '\n');
    await writeFile('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } else throw new Error('Phase: baseline | migrated | setup | verify');
} finally {
  await pool.end();
}
