// Local synthetic fixture and read-only verification; never emits private links or sessions.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2],
  path = 'data/portal-stage015.json';
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
    documents: (await pool.query('SELECT id,order_id,number,kind,mode FROM documents ORDER BY id'))
      .rows,
    cases: (
      await pool.query(
        'SELECT id,order_id,state,refund_amount,version FROM return_cases ORDER BY id',
      )
    ).rows,
    movements: (await pool.query('SELECT id,product_id,delta FROM stock_movements ORDER BY id'))
      .rows,
  };
}
let cookie = '';
async function api(url: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(url === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert(r.ok, `${url}: ${r.status}`);
  return d;
}
try {
  if (phase === 'baseline') {
    assert.equal((await api('/health')).schema_revision, '014_returns');
    const before = await snapshot();
    await writeFile(path, JSON.stringify({ before }, null, 2));
    console.log(
      JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length]))),
    );
  } else {
    const d = JSON.parse(await readFile(path, 'utf8'));
    assert.equal((await api('/health')).schema_revision, '015_buyer_portal');
    if (phase === 'migrated') {
      assert.deepEqual(await snapshot(), d.before);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM return_cases WHERE submitted_by <> 'operator'",
          )
        ).rows[0].n,
        0,
      );
      d.migration = { unchanged_business_snapshot: true, legacy_origin_operator: true };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.migration));
    } else if (phase === 'setup') {
      assert(!d.fixture, 'fixture exists');
      await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
      const org = await api('/workspaces', 'POST', {
        name: 'QA Portal 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      const w = (await api('/warehouses')).data[0];
      const p = await api('/products', 'POST', {
        name: 'QA Portal — produkt demonstracyjny',
        sku: 'QA-PORTAL-20261004',
        price: 11001,
        quantity: 6,
        warehouse_id: w.id,
      });
      const o = await api('/orders', 'POST', {
        customer_name: 'Kupujący QA Portal',
        email: 'buyer@example.test',
        warehouse_id: w.id,
        shipping_cost: 1499,
        items: [{ product_id: p.id, quantity: 2 }],
        address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
      });
      for (const status of ['paid', 'picking'])
        await api('/orders/' + o.id + '/status', 'PATCH', { status });
      for (let i = 0; i < 2; i++) await api('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
      await api('/orders/' + o.id + '/ship-demo', 'POST', {});
      await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
      d.fixture = {
        tenant_id: org.user.tenant_id,
        organization: 'QA Portal 20261004',
        warehouse_id: w.id,
        product_id: p.id,
        sku: p.sku,
        order_id: o.id,
        order_number: o.number,
        total: 23501,
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.fixture));
    } else if (phase === 'verify') {
      const after = await snapshot();
      for (const name of ['orders', 'stock', 'documents', 'cases', 'movements'] as const) {
        const prior = d.before[name];
        const select =
          name === 'stock'
            ? (x: any) => x.tenant_id !== d.fixture.tenant_id
            : (x: any) => prior.some((p: any) => p.id === x.id);
        assert.deepEqual(after[name].filter(select), prior, 'prior ' + name + ' changed');
      }
      const o = (
        await pool.query(
          'SELECT status,total,portal_token,portal_enabled,portal_expires_at FROM orders WHERE id=$1',
          [d.fixture.order_id],
        )
      ).rows[0];
      const cases = (
        await pool.query(
          'SELECT id,number,kind,state,submitted_by,refund_amount,refunded_at FROM return_cases WHERE order_id=$1 ORDER BY created_at',
          [d.fixture.order_id],
        )
      ).rows;
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2',
          [d.fixture.product_id, d.fixture.warehouse_id],
        )
      ).rows[0];
      assert.equal(o.total, 23501);
      assert.equal(o.status, 'return_completed');
      assert(o.portal_enabled && o.portal_expires_at);
      assert.equal(cases.length, 3);
      assert(cases.every((r: any) => r.submitted_by === 'buyer'));
      assert.equal(cases.filter((r: any) => r.state === 'closed').length, 2);
      assert.equal(cases.filter((r: any) => r.state === 'rejected').length, 1);
      assert.equal(
        cases.reduce((n: number, r: any) => n + r.refund_amount, 0),
        23501,
      );
      assert.deepEqual(stock, { on_hand: 5, reserved: 0 });
      const moves = (
        await pool.query(
          "SELECT delta FROM stock_movements WHERE product_id=$1 AND kind='return'",
          [d.fixture.product_id],
        )
      ).rows;
      assert.deepEqual(moves, [{ delta: 1 }]);
      const docs = (
        await pool.query(
          "SELECT kind,mode,(data->>'total')::int AS total FROM documents WHERE order_id=$1 ORDER BY created_at",
          [d.fixture.order_id],
        )
      ).rows;
      assert.equal(
        docs
          .filter((x: any) => x.kind === 'correction')
          .reduce((n: number, x: any) => n + x.total, 0),
        -23501,
      );
      const publicData = await api('/public/orders/' + o.portal_token + '/data');
      assert.equal(publicData.cases.length, 3);
      assert(!publicData.can_request);
      for (const hidden of [
        'tenant_id',
        'warehouse_id',
        'customer_name',
        'settlement',
        'portal_token',
        'receive_note',
      ])
        assert(!JSON.stringify(publicData).includes('"' + hidden + '"'));
      const openapi = await api('/v1/openapi');
      const operations = Object.values(openapi.paths).reduce(
        (n: number, p: any) => n + Object.keys(p).length,
        0,
      );
      assert.equal(operations, 37);
      const report = {
        scope:
          'native local HTTP/PostgreSQL and synthetic Chrome buyer/operator flow; no external payments or messages',
        fixture: d.fixture,
        migration: d.migration,
        prior_business_snapshot_unchanged: true,
        order_status: o.status,
        cases,
        stock,
        restock_moves: moves,
        documents: docs,
        public_case_count: publicData.cases.length,
        public_projection_private_fields_absent: true,
        rotated_link_active: true,
        public_api_operations: operations,
      };
      await writeFile(
        process.env.DYNA_PORTAL_OUTPUT ?? 'docs/portal-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      if (!process.env.DYNA_PORTAL_OUTPUT)
        await writeFile('docs/openapi.json', JSON.stringify(openapi, null, 2) + '\n');
      console.log(JSON.stringify(report));
    } else throw Error('unknown phase');
  }
} finally {
  await pool.end();
}
