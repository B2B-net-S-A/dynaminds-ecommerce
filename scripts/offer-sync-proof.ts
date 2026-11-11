// Local exercise. Outputs exclude credentials and private buyer links.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2],
  path = 'data/offer-sync-stage017.json';
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
    listings:
      'SELECT id,tenant_id,product_id,price,price_currency,status,last_result FROM listings ORDER BY id',
    price_lists: 'SELECT id,tenant_id,name,version,active FROM price_lists ORDER BY id',
    price_items:
      'SELECT tenant_id,price_list_id,product_id,price FROM price_list_items ORDER BY tenant_id,price_list_id,product_id',
    offer_plans: 'SELECT id,tenant_id,state,phase,result FROM offer_plans ORDER BY id',
  };
  const out: Record<string, any[]> = {};
  for (const [k, q] of Object.entries(queries)) out[k] = (await pool.query(q)).rows;
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
async function login(tenant?: string) {
  await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
  if (tenant) await api('/workspaces/switch', 'POST', { tenant_id: tenant });
}
try {
  if (phase === 'baseline') {
    assert.equal((await api('/health')).schema_revision, '016_pricing');
    const before = await snapshot();
    await writeFile(path, JSON.stringify({ before }, null, 2));
    console.log(
      JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length]))),
    );
  } else {
    const d = JSON.parse(await readFile(path, 'utf8'));
    const health = await api('/health');
    assert.equal(health.schema_revision, '017_offer_sync');
    if (phase === 'migrated') {
      assert.deepEqual(await snapshot(), d.before);
      d.migration = {
        unchanged_business_snapshot: true,
        counts: Object.fromEntries(Object.entries(d.before).map(([k, v]: any) => [k, v.length])),
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.migration));
    } else if (phase === 'setup') {
      assert(!d.fixture);
      const existing = (
        await pool.query("SELECT id FROM tenants WHERE name='QA Autosync 20261004'")
      ).rows;
      assert(existing.length <= 1, 'Ambiguous QA organization');
      await login(existing[0]?.id);
      const org = existing[0]
        ? { user: { tenant_id: existing[0].id } }
        : await api('/workspaces', 'POST', {
            name: 'QA Autosync 20261004',
            currency: 'PLN',
            locale: 'pl-PL',
          });
      const w = (await api('/warehouses')).data[0];
      const products = (await api('/products?search=QA-SYNC-20261004')).data;
      assert(products.length <= 1);
      const p =
        products[0] ??
        (await api('/products', 'POST', {
          name: 'QA Autosync — produkt demonstracyjny',
          sku: 'QA-SYNC-20261004',
          price: 10000,
          quantity: 12,
          warehouse_id: w.id,
        }));
      const channels = (
        await pool.query(
          "SELECT id FROM channels WHERE tenant_id=$1 AND provider='woocommerce' AND settings->>'simulation'='true'",
          [org.user.tenant_id],
        )
      ).rows;
      assert(channels.length <= 1);
      const ch = channels[0]
        ? { channel_id: channels[0].id }
        : await api('/integrations/demo-import', 'POST', {});
      const list = await api('/price-lists', 'POST', {
        name: 'QA Autosync — PLN',
        currency: 'PLN',
        fallback: true,
        adjustment_bps: 0,
        adjustment_amount: 0,
      });
      await api('/price-lists/' + list.id + '/items', 'PUT', {
        version: list.version,
        items: [{ product_id: p.id, price: 15000 }],
      });
      const preview = await api('/integrations/' + ch.channel_id + '/offers/preview', 'POST', {
        operation: 'create_draft',
        product_id: p.id,
        warehouse_id: w.id,
        stock: true,
        price: true,
      });
      await api('/offer-plans/' + preview.id + '/queue', 'POST', { confirm_live: false });
      d.fixture = {
        tenant_id: org.user.tenant_id,
        organization: 'QA Autosync 20261004',
        warehouse_id: w.id,
        product_id: p.id,
        sku: p.sku,
        channel_id: ch.channel_id,
        price_list_id: list.id,
      };
      d.checkpoints = [];
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.fixture));
    } else {
      await login(d.fixture.tenant_id);
      if (phase === 'checkpoint') {
        const l = (
          await pool.query(
            "SELECT id,price,price_currency,(last_result->>'stock_quantity')::int AS quantity,status FROM listings WHERE tenant_id=$1 AND product_id=$2",
            [d.fixture.tenant_id, d.fixture.product_id],
          )
        ).rows[0];
        assert(l);
        const expectedPrice = Number(process.argv[3]),
          expectedQty = Number(process.argv[4]);
        assert.equal(l.price, expectedPrice);
        assert.equal(l.quantity, expectedQty);
        const cfg = await api('/integrations/' + d.fixture.channel_id + '/offer-sync');
        assert(cfg.config);
        const point = {
          at: new Date().toISOString(),
          listing: l,
          enabled: cfg.config.enabled,
          version: cfg.config.version,
          jobs: cfg.jobs.map((j: any) => ({
            id: j.id,
            state: j.state,
            created_at: j.created_at,
            stats: j.stats,
          })),
          items: cfg.data.map((i: any) => ({
            sku: i.sku,
            state: i.state,
            plan_state: i.plan_state,
            desired_applied: i.result?.desired_applied,
            local_changed: i.result?.local_changed,
            scope: i.result?.scope,
          })),
        };
        d.checkpoints.push(point);
        await writeFile(path, JSON.stringify(d, null, 2));
        console.log(
          JSON.stringify({
            price: l.price,
            quantity: l.quantity,
            enabled: cfg.config.enabled,
            checkpoints: d.checkpoints.length,
          }),
        );
      } else if (phase === 'fulfill') {
        const orders = (
          await pool.query('SELECT id FROM orders WHERE tenant_id=$1', [d.fixture.tenant_id])
        ).rows;
        assert.equal(orders.length, 1);
        let o = await api('/orders/' + orders[0].id);
        assert.equal(o.status, 'paid');
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
        o = await api('/orders/' + o.id);
        for (const i of o.picking_items)
          for (let n = 0; n < i.quantity; n++)
            await api('/orders/' + o.id + '/scan', 'POST', { code: i.sku });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + o.id + '/ship-demo', 'POST', {});
        await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
        let r = await api('/orders/' + o.id + '/returns', 'POST', {
          client_key: randomUUID(),
          reason: 'QA autosync — zwrot demonstracyjny',
          shipping_refund: o.shipping_cost,
          items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
        });
        r = await api('/returns/' + r.id + '/receive', 'POST', {
          version: r.version,
          shipping_refund: o.shipping_cost,
          note: 'QA lokalne przyjęcie',
          items: r.items.map((i: any) => ({
            item_id: i.item_id,
            accepted: i.requested,
            restocked: i.requested,
          })),
        });
        await api('/returns/' + r.id + '/document', 'POST', {});
        await api('/returns/' + r.id + '/refund', 'POST', {
          version: r.version,
          amount: o.total,
          reference: 'QA-SYMULACJA-AUTOSYNC-BEZ-PRZELEWU',
          confirmed: true,
        });
        console.log(
          JSON.stringify({
            demo_fulfillment_and_return: 1,
            real_payments: 0,
            provider_requests: 0,
          }),
        );
      } else if (phase === 'verify') {
        const after = await snapshot();
        for (const [k, prior] of Object.entries(d.before) as [string, any[]][])
          assert.deepEqual(
            after[k].filter((x) => x.tenant_id !== d.fixture.tenant_id),
            prior,
            'Changed prior ' + k,
          );
        const cfg = await api('/integrations/' + d.fixture.channel_id + '/offer-sync');
        assert.equal(cfg.config.enabled, false);
        const listing = after.listings.find((x) => x.tenant_id === d.fixture.tenant_id);
        assert.equal(listing.price, 18000);
        assert.equal(listing.price_currency, 'PLN');
        assert.equal(Number(listing.last_result.stock_quantity), 12);
        const p = after.products.find((x) => x.id === d.fixture.product_id);
        assert.equal(p.price, 10000);
        const stock = after.stock.find((x) => x.product_id === p.id);
        assert.deepEqual([stock.on_hand, stock.reserved], [12, 0]);
        const orders = after.orders.filter((x) => x.tenant_id === d.fixture.tenant_id);
        assert.equal(orders.length, 1);
        assert.equal(orders[0].status, 'return_completed');
        assert.equal(orders[0].total, 32000);
        const docs = after.documents.filter((x) => x.tenant_id === d.fixture.tenant_id);
        assert.equal(docs.length, 2);
        assert(docs.every((x) => x.mode === 'demo' && x.currency === 'PLN'));
        assert.deepEqual(
          docs.map((x) => Number(x.total)).sort((a, b) => a - b),
          [-32000, 32000],
        );
        const plans = (
          await pool.query(
            'SELECT id,state,phase,sync_version,payload,result,created_at FROM offer_plans WHERE tenant_id=$1 ORDER BY created_at,id',
            [d.fixture.tenant_id],
          )
        ).rows;
        assert(
          plans.every(
            (p) =>
              p.state === 'done' &&
              p.result.scope === 'local_simulation' &&
              p.result.desired_applied,
          ),
        );
        assert(plans.filter((p) => p.sync_version).length >= 5);
        assert(d.checkpoints.length >= 7);
        const paused = d.checkpoints.filter((x: any) => !x.enabled && x.listing.price === 16000);
        assert.equal(paused.length, 2);
        assert(new Date(paused[1].at).getTime() - new Date(paused[0].at).getTime() >= 30000);
        assert.deepEqual(
          paused[1].jobs.map((j: any) => j.id),
          paused[0].jobs.map((j: any) => j.id),
        );
        const report = {
          stage: '017_offer_sync',
          health,
          migration: d.migration,
          fixture: d.fixture,
          preserved_prior_rows: d.migration.counts,
          checkpoints: d.checkpoints,
          orders,
          documents: docs,
          stock,
          base_product_price: p.price,
          listing,
          offer_plans: plans,
          final_configuration: { enabled: cfg.config.enabled, version: cfg.config.version },
          coordinator_jobs: cfg.jobs,
          provider_confirmation: false,
          real_payments: 0,
        };
        await writeFile(
          process.env.PROOF_OUTPUT ?? 'docs/offer-sync-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(
          JSON.stringify({
            preserved_prior_data: true,
            automatic_plans: plans.filter((p) => p.sync_version).length,
            checkpoints: d.checkpoints.length,
            stock: [12, 0],
            schedule_enabled: false,
          }),
        );
      } else throw Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
