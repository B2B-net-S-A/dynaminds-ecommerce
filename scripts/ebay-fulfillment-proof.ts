// Local API/UI proof. No eBay authentication or provider requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/ebay-fulfillment-stage064.json',
  phase = process.argv[2];
let cookie = '';
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, `${path}: ${r.status}`);
  return r.json() as any;
}
async function fp(t: string, tenants: string[]) {
  assert(/^[a-z][a-z0-9_]*$/.test(t));
  const rows = (
    await pool.query(
      `SELECT to_jsonb(t)::text row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
try {
  if (phase === 'baseline') {
    const previous = JSON.parse(await readFile('data/ebay-oauth-stage063.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of [
      ...Object.keys(previous.before),
      'ebay_fulfillment_plans',
      'ebay_fulfillment_simulations',
    ])
      before[t] = await fp(t, tenants);
    await writeFile(
      file,
      JSON.stringify({ tenants, before, baseline_at: new Date().toISOString() }, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log({ prior_tenants: tenants.length, stable_tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      const email = 'qa-ebay-fulfillment@demo.local';
      const signed = await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA wysyłka eBay',
        organization: { name: 'QA wysyłka eBay 064', currency: 'PLN', locale: 'pl-PL' },
      });
      const f: any = (s.fixture = { email, tenant: signed.user.tenant_id });
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/ebay-example', 'POST', {})).channel_id;
      f.sku = 'EBAY-FULFILLMENT-QA-064';
      f.product = (
        await api('/products', 'POST', {
          sku: f.sku,
          name: 'Produkt QA przekazania wysyłki eBay',
          price: 9999,
          vat: 23,
          quantity: 12,
          warehouse_id: f.warehouse,
        })
      ).id;
      await api(`/integrations/${f.channel}/mappings`, 'POST', {
        external_id: 'EBAY-DEMO-SKU',
        sku: f.sku,
      });
      const inbound = (await api(`/integrations/${f.channel}/imports`)).data[0];
      const o = await api(`/imports/${inbound.id}/commit`, 'POST', {
        warehouse_id: f.warehouse,
        expected_hash: inbound.source_hash,
      });
      f.order = o.id;
      f.number = o.number;
      f.total = o.total;
      await api(`/orders/${o.id}/status`, 'PATCH', { status: 'picking' });
      for (let n = 0; n < 2; n++) await api(`/orders/${o.id}/scan`, 'POST', { code: f.sku });
      await api(`/orders/${o.id}/status`, 'PATCH', { status: 'packed' });
      const shipped = await api(`/orders/${o.id}/ship-demo`, 'POST', {});
      f.shipment = shipped.shipments[0].id;
      f.tracking = shipped.shipments[0].tracking_number;
      f.document = (await api(`/orders/${o.id}/documents`, 'POST', { kind: 'invoice' })).id;
      console.log(f);
    } else if (phase === 'verify') {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      const h = await api('/health');
      if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
      const o = await api(`/orders/${f.order}`);
      assert.equal(o.status, 'shipped');
      assert.equal(o.total, 10001);
      assert.equal(o.shipping_cost, 1000);
      const ch = (await pool.query('SELECT * FROM channels WHERE id=$1', [f.channel])).rows[0];
      assert(ch.settings.simulation);
      const plans = (await api(`/orders/${f.order}/ebay-fulfillment`)).data;
      const done = plans.find((p: any) => p.state === 'done' && !p.result?.unchanged);
      assert(done, 'Zatwierdź podgląd wysyłki w IAB');
      assert.equal(done.phase, 'done');
      assert.equal(done.payload.trackingNumber, f.tracking);
      assert.equal(done.payload.shippingCarrierCode, 'Other');
      assert.deepEqual(done.payload.lineItems, [{ lineItemId: '6001001', quantity: 2 }]);
      const remote = (
        await pool.query(
          'SELECT fulfillments FROM ebay_fulfillment_simulations WHERE order_id=$1',
          [f.order],
        )
      ).rows[0].fulfillments;
      assert.equal(remote.length, 1);
      assert.equal(remote[0].shipmentTrackingNumber, f.tracking);
      assert.deepEqual(
        (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
          .rows,
        [{ on_hand: 10, reserved: 0 }],
      );
      assert.deepEqual(
        (await pool.query('SELECT amount FROM payment_entries WHERE order_id=$1', [f.order])).rows,
        [{ amount: 10001 }],
      );
      f.plan = done.id;
      const backgroundTables = [
        'audit_events',
        'listings',
        'odoo_catalog_schedules',
        'odoo_catalog_sync_runs',
        'odoo_catalog_sync_items',
      ];
      const differences: any[] = [];
      for (const [t, b] of Object.entries(s.before)) {
        const actual = await fp(t, s.tenants);
        if (JSON.stringify(actual) !== JSON.stringify(b)) {
          assert(backgroundTables.includes(t), t + ' unexpectedly changed for prior tenant');
          differences.push({ table: t, before: b, after: actual });
        }
      }
      const background = (
        await pool.query(
          "SELECT r.id,r.tenant_id,r.created_at,r.state,r.simulation,c.provider,c.settings->>'simulation' channel_simulation FROM odoo_catalog_sync_runs r JOIN channels c ON c.id=r.channel_id WHERE r.tenant_id=ANY($1::uuid[]) AND r.created_at>$2 ORDER BY r.created_at",
          [s.tenants, s.baseline_at],
        )
      ).rows;
      if (differences.length) {
        assert(background.length > 0);
        assert(
          background.every(
            (r) =>
              r.provider === 'odoo' &&
              r.simulation &&
              r.channel_simulation === 'true' &&
              r.state === 'success',
          ),
        );
        const newAudits = (
          await pool.query(
            'SELECT action,entity_id FROM audit_events WHERE tenant_id=ANY($1::uuid[]) AND created_at>$2',
            [s.tenants, s.baseline_at],
          )
        ).rows;
        assert(
          newAudits.every(
            (r) =>
              ['odoo.catalog.sync.queue', 'odoo.catalog.sync.page'].includes(r.action) &&
              background.some((b) => b.id === r.entity_id),
          ),
        );
      }
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_eBay_fulfillment_queue_and_worker_simulation',
        revision: h.revision,
        schema_revision: h.schema_revision,
        prior_tenants_compared: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length - differences.length,
        prior_tenant_background_runs: background,
        prior_tenant_changed_tables: differences,
        order_id: f.order,
        order_number: f.number,
        total: o.total,
        shipping_cost: o.shipping_cost,
        shipment_mode: o.shipments[0].mode,
        tracking: f.tracking,
        plan_id: done.id,
        state: done.state,
        phase: done.phase,
        line_items: done.payload.lineItems,
        shipping_carrier_code: done.payload.shippingCarrierCode,
        simulated_fulfillments: remote.length,
        stock: { on_hand: 10, reserved: 0 },
        payment_entries: 1,
        invoice_demo: true,
        provider_authenticated: false,
        provider_requests: 0,
        whole_goal_complete: false,
      };
      await writeFile(
        process.argv[3]
          ? 'data/ebay-fulfillment-runtime-064.json'
          : 'docs/ebay-fulfillment-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    } else throw Error('Unknown phase');
    await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  }
} finally {
  await pool.end();
}
