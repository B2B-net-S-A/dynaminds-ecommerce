// Local API/UI proof. No eBay authentication or provider requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/ebay-schedules-stage066.json',
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
    const previous = JSON.parse(await readFile('data/ebay-account-stage065.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of [
      ...Object.keys(previous.before),
      'ebay_fulfillment_configs',
      'ebay_fulfillment_receipts',
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
      const email = 'qa-ebay-schedules@demo.local';
      const signed = await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA automatyczne wysyłki eBay',
        organization: {
          name: 'QA automatyczne wysyłki eBay 066',
          currency: 'PLN',
          locale: 'pl-PL',
        },
      });
      const f: any = (s.fixture = { email, tenant: signed.user.tenant_id });
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/ebay-example', 'POST', {})).channel_id;
      await api(`/integrations/${f.channel}/ebay-account/verify`, 'POST', {});
      f.sku = 'EBAY-FULFILLMENT-QA-066';
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
      f.carrier = shipped.shipments[0].carrier;
      f.document = (await api(`/orders/${o.id}/documents`, 'POST', { kind: 'invoice' })).id;
      console.log(f);
    } else if (phase === 'verify') {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      const h = await api('/health');
      if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
      const data = await api(`/integrations/${f.channel}/ebay-fulfillment`);
      assert.equal(data.config.enabled, false, 'Wyłącz automatyzację w IAB po potwierdzeniu');
      assert.equal(data.config.version, 2);
      const plans = (await api(`/orders/${f.order}/ebay-fulfillment`)).data;
      assert.equal(plans.length, 1);
      const p = plans[0];
      assert.equal(p.state, 'done');
      assert.equal(p.config_version, 1);
      assert.equal(p.payload.trackingNumber, f.tracking);
      assert.equal(p.payload.shippingCarrierCode, 'DPD');
      assert.equal(data.receipts.length, 1);
      assert.equal(data.receipts[0].state, 'queued');
      assert.equal(data.receipts[0].plan_state, 'done');
      assert(data.jobs.some((j: any) => j.stats.queued === 1 && j.state === 'done'));
      const sim = (
        await pool.query(
          'SELECT fulfillments FROM ebay_fulfillment_simulations WHERE order_id=$1',
          [f.order],
        )
      ).rows[0];
      assert.equal(sim.fulfillments.length, 1);
      const o = await api(`/orders/${f.order}`);
      assert.equal(o.status, 'shipped');
      assert.equal(o.total, 10001);
      const stock = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
      ).rows[0];
      assert.deepEqual(stock, { on_hand: 10, reserved: 0 });
      const payments = (
        await pool.query('SELECT amount,currency FROM payment_entries WHERE order_id=$1', [f.order])
      ).rows;
      assert.deepEqual(payments, [{ amount: 10001, currency: 'PLN' }]);
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
          assert(backgroundTables.includes(t), t + ' changed');
          differences.push({ table: t, before: b, after: actual });
        }
      }
      const background = (
        await pool.query(
          "SELECT r.id,r.tenant_id,r.state,r.simulation,c.provider,c.settings->>'simulation' channel_simulation FROM odoo_catalog_sync_runs r JOIN channels c ON c.id=r.channel_id WHERE r.tenant_id=ANY($1::uuid[]) AND r.created_at>$2 ORDER BY r.created_at",
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
        const audits = (
          await pool.query(
            'SELECT action,entity_id FROM audit_events WHERE tenant_id=ANY($1::uuid[]) AND created_at>$2',
            [s.tenants, s.baseline_at],
          )
        ).rows;
        assert(
          audits.every(
            (r) =>
              ['odoo.catalog.sync.queue', 'odoo.catalog.sync.page'].includes(r.action) &&
              background.some((b) => b.id === r.entity_id),
          ),
        );
      }
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_eBay_automatic_shipping',
        revision: h.revision,
        schema_revision: h.schema_revision,
        prior_tenants_compared: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length - differences.length,
        prior_tenant_background_runs: background,
        prior_tenant_changed_tables: differences,
        config_version: 2,
        automation_enabled: false,
        automatic_plans: 1,
        confirmed_shipments: 1,
        receipts: 1,
        scan_jobs: data.jobs.length,
        stock,
        payments,
        order_total: o.total,
        provider_authenticated: false,
        provider_requests: 0,
        whole_goal_complete: false,
      };
      await writeFile(
        process.argv[3]
          ? 'data/ebay-schedules-runtime-066.json'
          : 'docs/ebay-schedules-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    } else throw Error('Unknown phase');
    await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  }
} finally {
  await pool.end();
}
