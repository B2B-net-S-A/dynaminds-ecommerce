// Local QA fixture and read-only proof. No provider requests, private links or credentials in outputs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2],
  path = 'data/pricing-stage016.json';
async function snapshot() {
  const queries = {
    orders: 'SELECT id,tenant_id,number,status,total,currency FROM orders ORDER BY id',
    items:
      'SELECT id,tenant_id,order_id,product_id,quantity,price,line_total,scanned FROM order_items ORDER BY id',
    products: 'SELECT id,tenant_id,sku,price,version FROM products ORDER BY id',
    stock:
      'SELECT tenant_id,product_id,warehouse_id,on_hand,reserved FROM stock ORDER BY tenant_id,product_id,warehouse_id',
    documents:
      "SELECT id,tenant_id,order_id,number,kind,mode,data->>'total' AS total,data->>'currency' AS currency FROM documents ORDER BY id",
    cases: 'SELECT id,tenant_id,order_id,state,refund_amount,version FROM return_cases ORDER BY id',
    movements: 'SELECT id,tenant_id,product_id,delta FROM stock_movements ORDER BY id',
    listings: 'SELECT id,tenant_id,product_id,price,status FROM listings ORDER BY id',
  };
  const out: Record<string, any[]> = {};
  for (const [key, query] of Object.entries(queries)) out[key] = (await pool.query(query)).rows;
  return out;
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
  assert(r.ok, `${method} ${url}: ${r.status}`);
  return d;
}
async function login(tenantId?: string) {
  await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
  if (tenantId) await api('/workspaces/switch', 'POST', { tenant_id: tenantId });
}
try {
  if (phase === 'baseline') {
    assert.equal((await api('/health')).schema_revision, '015_buyer_portal');
    const before = await snapshot();
    await writeFile(path, JSON.stringify({ before }, null, 2));
    console.log(
      JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length]))),
    );
  } else {
    const d = JSON.parse(await readFile(path, 'utf8'));
    const health = await api('/health');
    assert.equal(health.schema_revision, '016_pricing');
    if (phase === 'migrated') {
      assert.deepEqual(await snapshot(), d.before);
      d.migration = {
        unchanged_business_snapshot: true,
        orders: d.before.orders.length,
        items: d.before.items.length,
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.migration));
    } else if (phase === 'setup') {
      assert(!d.fixture, 'Fixture already exists');
      await login();
      const org = await api('/workspaces', 'POST', {
        name: 'QA Cenniki 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      const w = (await api('/warehouses')).data[0];
      const p = await api('/products', 'POST', {
        name: 'QA Cenniki — produkt demonstracyjny',
        sku: 'QA-PRICE-20261004',
        price: 10001,
        quantity: 12,
        warehouse_id: w.id,
      });
      const ch = await api('/integrations/demo-import', 'POST', {});
      d.fixture = {
        tenant_id: org.user.tenant_id,
        organization: 'QA Cenniki 20261004',
        warehouse_id: w.id,
        product_id: p.id,
        sku: p.sku,
        channel_id: ch.channel_id,
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.fixture));
    } else if (phase === 'fulfill') {
      await login(d.fixture.tenant_id);
      const orders = (
        await pool.query('SELECT id,currency FROM orders WHERE tenant_id=$1 ORDER BY currency', [
          d.fixture.tenant_id,
        ])
      ).rows;
      assert.equal(orders.length, 2);
      for (const row of orders) {
        let o = await api('/orders/' + row.id);
        assert.equal(o.status, 'paid');
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
        o = await api('/orders/' + o.id);
        for (const item of o.picking_items)
          for (let i = 0; i < item.quantity; i++)
            await api('/orders/' + o.id + '/scan', 'POST', { code: item.sku });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + o.id + '/ship-demo', 'POST', {});
        await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
        let r = await api('/orders/' + o.id + '/returns', 'POST', {
          client_key: randomUUID(),
          reason: 'QA cennik — pełny zwrot demonstracyjny',
          shipping_refund: o.shipping_cost,
          items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
        });
        r = await api('/returns/' + r.id + '/receive', 'POST', {
          version: Number(r.version),
          shipping_refund: o.shipping_cost,
          note: 'QA — lokalne przyjęcie',
          items: r.items.map((i: any) => ({
            item_id: i.item_id,
            accepted: i.requested,
            restocked: i.requested,
          })),
        });
        await api('/returns/' + r.id + '/document', 'POST', {});
        await api('/returns/' + r.id + '/refund', 'POST', {
          version: Number(r.version),
          amount: o.total,
          reference: 'QA-SYMULACJA-CENNIK-' + o.currency + '-BEZ-PRZELEWU',
          confirmed: true,
        });
      }
      console.log(
        JSON.stringify({
          demo_orders_fulfilled_and_returned: 2,
          real_payments: 0,
          provider_requests: 0,
        }),
      );
    } else if (phase === 'verify') {
      await login(d.fixture.tenant_id);
      const after = await snapshot();
      for (const [key, prior] of Object.entries(d.before) as [string, any[]][])
        assert.deepEqual(
          after[key].filter((x) => x.tenant_id !== d.fixture.tenant_id),
          prior,
          'Changed prior ' + key,
        );
      const orders = (
        await pool.query(
          'SELECT id,number,currency,total,status,pricing_snapshot FROM orders WHERE tenant_id=$1 ORDER BY currency',
          [d.fixture.tenant_id],
        )
      ).rows;
      assert.equal(orders.length, 2);
      for (const o of orders) {
        assert.equal(o.total, o.currency === 'EUR' ? 1100 : 31497);
        assert.equal(o.status, 'return_completed');
        assert.equal(o.pricing_snapshot.list.version, 2);
        assert.equal(o.pricing_snapshot.items[0].price, o.currency === 'EUR' ? 999 : 14999);
        const item = after.items.find((x) => x.order_id === o.id);
        assert.equal(item.price, o.pricing_snapshot.items[0].price);
        assert.equal(item.line_total, o.currency === 'EUR' ? 999 : 29998);
        const cases = after.cases.filter((x) => x.order_id === o.id);
        assert.equal(cases.length, 1);
        assert.equal(cases[0].state, 'closed');
        assert.equal(cases[0].refund_amount, o.total);
        const docs = after.documents.filter((x) => x.order_id === o.id);
        assert.equal(docs.length, 2);
        assert(docs.every((x) => x.currency === o.currency && x.mode === 'demo'));
        assert.equal(Number(docs.find((x) => x.kind === 'invoice').total), o.total);
        assert.equal(Number(docs.find((x) => x.kind === 'correction').total), -o.total);
      }
      const product = after.products.find((x) => x.id === d.fixture.product_id);
      assert.equal(product.price, 10001);
      const stock = after.stock.find((x) => x.product_id === d.fixture.product_id);
      assert.deepEqual([stock.on_hand, stock.reserved], [12, 0]);
      const listing = (
        await pool.query(
          "SELECT price,price_currency,status,(last_result->>'stock_quantity')::int AS quantity FROM listings WHERE tenant_id=$1",
          [d.fixture.tenant_id],
        )
      ).rows;
      assert.equal(listing.length, 1);
      assert.equal(listing[0].price, 16000);
      assert.equal(listing[0].price_currency, 'PLN');
      assert.equal(listing[0].quantity, 12);
      const plans = (
        await pool.query(
          'SELECT state,input,result FROM offer_plans WHERE tenant_id=$1 ORDER BY created_at',
          [d.fixture.tenant_id],
        )
      ).rows;
      assert.equal(plans.length, 3);
      assert(
        plans.every(
          (p) =>
            p.state === 'done' && p.result.scope === 'local_simulation' && p.result.desired_applied,
        ),
      );
      const dash = await api('/dashboard');
      assert.equal(dash.orders.length, 2);
      assert.deepEqual(dash.orders.map((o: any) => o.currency).sort(), ['EUR', 'PLN']);
      for (const o of dash.orders) assert.equal(Number(o.total) - Number(o.refund_total), 0);
      const openapi = await api('/v1/openapi');
      const operations = Object.values(openapi.paths).reduce(
        (n: number, v: any) => n + Object.keys(v).length,
        0,
      );
      assert.equal(operations, 43);
      if (!process.env.PROOF_OUTPUT)
        await writeFile('docs/openapi.json', JSON.stringify(openapi, null, 2) + '\n');
      const result = {
        stage: '016_pricing',
        health,
        migration: d.migration,
        fixture: d.fixture,
        preserved_prior_rows: Object.fromEntries(
          Object.entries(d.before).map(([k, v]: any) => [k, v.length]),
        ),
        orders,
        stock,
        base_product_price: product.price,
        listing: listing[0],
        offer_plans: plans.map((p) => ({
          state: p.state,
          scope: p.result.scope,
          price_list_id: p.input.price_list_id,
          verified: p.result.desired_applied,
          local_changed: p.result.local_changed,
        })),
        documents: after.documents.filter((x) => x.tenant_id === d.fixture.tenant_id),
        currency_separated_dashboard: dash.orders,
        public_api_operations: operations,
        provider_confirmation: false,
        real_payments: 0,
      };
      await writeFile(
        process.env.PROOF_OUTPUT ?? 'docs/pricing-qa.json',
        JSON.stringify(result, null, 2) + '\n',
      );
      console.log(
        JSON.stringify({
          preserved_prior_data: true,
          verified_orders: 2,
          verified_offer_plans: 3,
          stock: [stock.on_hand, stock.reserved],
          operations,
        }),
      );
    } else throw Error('Unknown phase');
  }
} finally {
  await pool.end();
}
