// Native local exercise. Synthetic tenant only; never logs session cookies or private portal links.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';
const phase = process.argv[2],
  path = 'data/tracking-stage020.json';
async function snapshot() {
  const tables = [
    'orders',
    'order_items',
    'products',
    'stock',
    'documents',
    'return_cases',
    'stock_movements',
    'listings',
    'offer_plans',
    'variant_offer_batches',
    'variant_offer_batch_items',
    'shipping_plans',
  ];
  const out: Record<string, any[]> = {};
  for (const t of tables)
    out[t] = (
      await pool.query(`SELECT to_jsonb(t) AS row FROM ${t} t ORDER BY to_jsonb(t)::text`)
    ).rows.map((x) => x.row);
  // New migration columns are omitted when comparing historical shipments.
  out.shipments = (
    await pool.query(
      'SELECT id,tenant_id,order_id,carrier,tracking_number,mode,status,created_at,channel_id,external_id,dispatched_at,tracking_data,tracking_at FROM shipments ORDER BY id',
    )
  ).rows;
  return JSON.parse(JSON.stringify(out));
}
let cookie = '';
async function api(p: string, m = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method: m,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert(r.ok, `${m} ${p}: ${r.status}`);
  return d;
}
async function login(tenant?: string) {
  await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
  if (tenant) await api('/workspaces/switch', 'POST', { tenant_id: tenant });
}
async function waitPlan(id: string, state: string) {
  for (let n = 0; n < 40; n++) {
    const p = (await pool.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0];
    if (p.state === state) return p;
    assert.notEqual(p.state, 'failed', p.error);
    await setTimeout(500);
  }
  throw new Error('Worker still pending; inspect existing job before retrying');
}
try {
  if (phase === 'baseline') {
    assert.equal((await api('/health')).schema_revision, '019_variable_offers');
    const before = await snapshot();
    await writeFile(path, JSON.stringify({ before }, null, 2));
    console.log(
      JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]: any) => [k, v.length]))),
    );
  } else {
    const d = JSON.parse(await readFile(path, 'utf8'));
    assert.equal((await api('/health')).schema_revision, '020_tracking');
    if (phase === 'migrated') {
      assert.deepEqual(await snapshot(), d.before);
      d.migration = {
        previous_business_rows_unchanged: true,
        counts: Object.fromEntries(Object.entries(d.before).map(([k, v]: any) => [k, v.length])),
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.migration));
    }
    if (phase === 'setup') {
      assert(!d.fixture);
      assert.equal(
        (await pool.query("SELECT id FROM tenants WHERE name='QA Tracking 20261004'")).rowCount,
        0,
      );
      await login();
      const org = await api('/workspaces', 'POST', {
        name: 'QA Tracking 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      const warehouse = (await api('/warehouses')).data[0].id;
      const channel = (await api('/shipping/example', 'POST', {})).id;
      const p = await api('/products', 'POST', {
        sku: 'QA-TRACK-20261004',
        name: 'Bluza · tracking QA',
        price: 14900,
        vat: 23,
        warehouse_id: warehouse,
        quantity: 10,
      });
      d.fixture = {
        tenant_id: org.user.tenant_id,
        warehouse_id: warehouse,
        channel_id: channel,
        product_id: p.id,
        orders: [],
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      // Two independent packages: normal delivery and a return opened while carrier is in transit.
      for (const label of ['Doręczenie', 'Zwrot']) {
        const o = await api('/orders', 'POST', {
          customer_name: 'Klient QA ' + label,
          email: 'tracking-qa@example.invalid',
          warehouse_id: warehouse,
          items: [{ product_id: p.id, quantity: 1 }],
          address: {
            street: 'Testowa 1',
            city: 'Warszawa',
            postal_code: '00-001',
            country: 'PL',
            phone: '500600700',
          },
        });
        d.fixture.orders.push({ id: o.id, number: o.number, label });
        await writeFile(path, JSON.stringify(d, null, 2));
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'paid' });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
        await api('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
        const plan = await api('/orders/' + o.id + '/shipping/preview', 'POST', {
          channel_id: channel,
          service: 'inpost_locker_standard',
          receiver: {
            first_name: 'Klient',
            last_name: 'QA',
            email: 'tracking-qa@example.invalid',
            phone: '500600700',
          },
          target_point: 'WAW01M',
          template: 'small',
          weight: 1,
          cod: 0,
          insurance: 14900,
        });
        await api('/shipping-plans/' + plan.id + '/queue', 'POST', {});
        const quoted = await waitPlan(plan.id, 'quoted');
        await api('/shipping-plans/' + plan.id + '/buy', 'POST', {
          offer_id: quoted.offers[0].id,
          confirm_cost: true,
          ack_unknown_rate: true,
        });
        const ready = await waitPlan(plan.id, 'ready');
        await api('/shipping-plans/' + plan.id + '/dispatch', 'POST', {});
        const doc = await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
        Object.assign(d.fixture.orders.at(-1), {
          plan_id: plan.id,
          shipment_id: ready.shipment_id,
          tracking_number: ready.result.tracking_number,
          document_id: doc.id,
        });
        await writeFile(path, JSON.stringify(d, null, 2));
      }
      await api('/orders/' + d.fixture.orders[1].id + '/status', 'PATCH', {
        status: 'return_initiated',
      });
      console.log(JSON.stringify(d.fixture));
    }
    if (phase === 'verify') {
      const f = d.fixture;
      assert(f);
      const current = await snapshot();
      for (const [k, v] of Object.entries(d.before))
        assert.deepEqual(
          current[k].filter((x: any) => x.tenant_id !== f.tenant_id),
          v,
        );
      const orders = (
        await pool.query(
          'SELECT id,number,status,total,currency FROM orders WHERE tenant_id=$1 ORDER BY number',
          [f.tenant_id],
        )
      ).rows;
      assert.equal(orders.find((x) => x.id === f.orders[0].id).status, 'delivered');
      assert.equal(orders.find((x) => x.id === f.orders[1].id).status, 'return_initiated');
      const shipments = (
        await pool.query(
          'SELECT id,tracking_number,status,tracking_data,tracking_at,dispatched_at,tracking_error FROM shipments WHERE tenant_id=$1 ORDER BY id',
          [f.tenant_id],
        )
      ).rows;
      assert(
        shipments.every(
          (x) =>
            x.status === 'delivered' &&
            x.tracking_data.scope === 'local_simulation' &&
            x.dispatched_at &&
            x.tracking_at &&
            !x.tracking_error,
        ),
      );
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [f.tenant_id, f.product_id],
        )
      ).rows;
      assert.deepEqual(stock, [{ on_hand: 8, reserved: 0 }]);
      const movements = (
        await pool.query(
          'SELECT kind,delta FROM stock_movements WHERE tenant_id=$1 ORDER BY kind,delta',
          [f.tenant_id],
        )
      ).rows;
      assert.equal(movements.filter((x) => x.kind === 'shipment').length, 2);
      assert.equal(
        movements.reduce((s, x) => s + x.delta, 0),
        8,
      );
      const events = (
        await pool.query(
          "SELECT order_id,kind FROM order_events WHERE tenant_id=$1 AND kind='order.delivered'",
          [f.tenant_id],
        )
      ).rows;
      assert.equal(events.length, 1);
      assert.equal(events[0].order_id, f.orders[0].id);
      const cfg = (
        await pool.query(
          'SELECT enabled,version,mark_delivered,interval_seconds FROM tracking_configs WHERE tenant_id=$1',
          [f.tenant_id],
        )
      ).rows[0];
      assert.equal(cfg.enabled, false);
      const jobs = (
        await pool.query(
          "SELECT state,attempts,payload->'result' AS result FROM jobs WHERE tenant_id=$1 AND kind='shipping.tracking' ORDER BY created_at,id",
          [f.tenant_id],
        )
      ).rows;
      assert(jobs.every((x) => x.state === 'done'));
      assert(jobs.length >= 4);
      const report = {
        scope: 'local_simulation',
        migration: d.migration,
        fixture: f,
        orders,
        shipments,
        stock,
        movements,
        events,
        config: cfg,
        jobs,
        previous_business_rows_unchanged: true,
        external_provider_verified: false,
      };
      await writeFile(
        process.env.PROOF_OUTPUT ?? 'docs/tracking-qa.json',
        JSON.stringify(report, null, 2),
      );
      console.log(
        JSON.stringify({
          scope: report.scope,
          orders: orders.length,
          shipments: shipments.length,
          jobs: jobs.length,
          stock,
          previous_business_rows_unchanged: true,
        }),
      );
    }
  }
} finally {
  await pool.end();
}
