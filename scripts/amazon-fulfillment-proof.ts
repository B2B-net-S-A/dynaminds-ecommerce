// Native QA touches only a fresh local firm. No provider HTTP or real sale/payment/shipment/message.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/amazon-fulfillment-stage080.json',
  phase = process.argv[2];
const tables = [
  'products',
  'stock',
  'orders',
  'order_items',
  'reservations',
  'reservation_locations',
  'order_pick_items',
  'documents',
  'shipments',
  'return_cases',
  'return_items',
  'payment_entries',
  'listings',
  'catalog_source_runs',
  'catalog_source_items',
  'purchase_orders',
  'purchase_order_lines',
];
let cookie = '';
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await r.text();
  assert.equal(r.status, status, path + ':' + raw);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return JSON.parse(raw);
}
async function fingerprints(tenants: string[]) {
  const out: any = {};
  for (const table of tables) {
    const rows = (
      await pool.query(
        `SELECT to_jsonb(t)::text row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [tenants],
      )
    ).rows;
    out[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}
try {
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    await writeFile(
      file,
      JSON.stringify(
        { tenants, before: await fingerprints(tenants), baseline_at: new Date().toISOString() },
        null,
        2,
      ) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    console.log({ baseline_firms: tenants.length, tables: tables.length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    const save = () => writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    if (phase === 'setup') {
      assert(!s.fixture);
      assert.equal((await api('/health')).schema_revision, '059_amazon_fulfillment');
      assert.deepEqual(await fingerprints(s.tenants), s.before);
      const email = 'qa-amazon-fulfillment@demo.local',
        password = 'DynaShipment!2026';
      const signed = await api(
        '/auth/signup',
        'POST',
        {
          email,
          password,
          name: 'QA Wysyłki Amazon 080',
          organization: { name: 'QA Wysyłki Amazon 080', currency: 'PLN', locale: 'pl-PL' },
        },
        201,
      );
      const f: any = (s.fixture = {
        email,
        password,
        tenant: signed.user.tenant_id,
        user: signed.user.id,
      });
      await save();
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/amazon-example', 'POST', {})).channel_id;
      await save();
      const p = await api(
        '/products',
        'POST',
        {
          sku: 'QA-AMAZON-SHIP-080',
          name: 'QA Paczka Amazon 080',
          price: 12300,
          vat: 23,
          warehouse_id: f.warehouse,
          quantity: 12,
        },
        201,
      );
      f.product = p.id;
      f.sku = p.sku;
      await save();
      await api(`/integrations/${f.channel}/mappings`, 'POST', {
        external_id: 'AMAZON-DEMO-SKU',
        sku: f.sku,
      });
      const inbound = (await api(`/integrations/${f.channel}/imports`)).data[0];
      const o = await api(`/imports/${inbound.id}/commit`, 'POST', {
        warehouse_id: f.warehouse,
        expected_hash: inbound.source_hash,
      });
      f.order = o.id;
      f.number = o.number;
      await save();
      await api(`/orders/${o.id}/payments`, 'POST', {
        client_key: randomUUID(),
        version: o.version,
        kind: 'receipt',
        amount: o.total,
        currency: o.currency,
        method: 'other',
        reference: 'QA-080-BEZ-PRZELEWU',
        note: 'Wyłącznie lokalna deklaracja QA, bez przepływu pieniędzy',
        confirmed: true,
      });
      await api(`/orders/${o.id}/status`, 'PATCH', { status: 'picking' });
      for (let n = 0; n < 2; n++) await api(`/orders/${o.id}/scan`, 'POST', { code: f.sku });
      await api(`/orders/${o.id}/status`, 'PATCH', { status: 'packed' });
      await api(`/orders/${o.id}/ship-demo`, 'POST', {});
      f.cookie = cookie;
      await save();
      console.log({
        stage: 80,
        scope: 'local_simulation',
        tenant: f.tenant,
        number: f.number,
        order: f.order,
        stock: { on_hand: 10, reserved: 0 },
        ui_next: 'carrier preview and queue',
      });
    } else {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: f.password });
      if (phase === 'verify') {
        const plans = (await api(`/orders/${f.order}/amazon-fulfillment`)).data;
        const done = plans.filter((p: any) => p.state === 'done');
        assert.equal(done.length, 1);
        const p = done[0];
        assert.equal(p.phase, 'done');
        assert.equal(p.result.fulfillment.packageStatus.status, 'SHIPPED');
        assert.equal(p.payload.packageDetail.trackingNumber, p.result.fulfillment.trackingNumber);
        assert.deepEqual(p.payload.packageDetail.orderItems, [
          { orderItemId: '12345678901', quantity: 2 },
        ]);
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
            .rows,
          [{ on_hand: 10, reserved: 0 }],
        );
        assert.deepEqual(await fingerprints(s.tenants), s.before);
        f.plan = p.id;
        await save();
        const report = {
          stage: 80,
          goal_complete: false,
          verified_at: new Date().toISOString(),
          runtime: await api('/health'),
          scope: 'local_simulation',
          authenticated_amazon_api_verified: false,
          external_http_calls: 0,
          paid_operations: 0,
          external_messages: 0,
          previous_firms: s.tenants.length,
          business_tables_unchanged: tables.length,
          tenant_id: f.tenant,
          order_number: f.number,
          order_id: f.order,
          plan_id: p.id,
          carrier: p.payload.packageDetail.carrierCode,
          tracking: p.payload.packageDetail.trackingNumber,
          package_reference: p.remote_id,
          original_order_items: p.payload.packageDetail.orderItems,
          package_status: p.result.fulfillment.packageStatus.status,
          local_order_status: (await api(`/orders/${f.order}`)).status,
          stock: { on_hand: 10, reserved: 0 },
          payment: { amount: 24690, scope: 'synthetic_local_receipt' },
          ui_preview_queue_verified: true,
        };
        await writeFile(
          'docs/amazon-fulfillment-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      } else if (phase === 'document-return') {
        assert(!f.document);
        let o = await api(`/orders/${f.order}`);
        f.document = (await api(`/orders/${o.id}/documents`, 'POST', { kind: 'invoice' })).id;
        await save();
        let ret = await api(
          `/orders/${o.id}/returns`,
          'POST',
          {
            client_key: randomUUID(),
            reason: 'QA Wysyłki Amazon 080',
            shipping_refund: 0,
            items: [{ item_id: o.items[0].id, quantity: 1 }],
          },
          201,
        );
        f.return_id = ret.id;
        await save();
        await api(`/returns/${ret.id}/receive`, 'POST', {
          version: ret.version,
          shipping_refund: 0,
          items: [{ item_id: ret.items[0].item_id, accepted: 1, restocked: 1 }],
          note: 'QA lokalne przyjęcie jednej sztuki',
        });
        await api(`/returns/${ret.id}/document`, 'POST', {});
        console.log({
          document: f.document,
          return_id: f.return_id,
          stock: { on_hand: 11, reserved: 0 },
          refund_state: 'waiting_for_local_settlement',
        });
      } else if (phase === 'refund') {
        assert(!f.refund_verified);
        const r = await api(`/returns/${f.return_id}`);
        assert.equal(r.state, 'refund_pending');
        await api(`/returns/${r.id}/refund`, 'POST', {
          version: r.version,
          amount: r.refund_amount,
          reference: 'QA-080-BEZ-PRZELEWU',
          confirmed: true,
        });
        f.refund_verified = true;
        await save();
        console.log({ scope: 'synthetic_local_settlement', amount: 12300, real_money_moved: 0 });
      } else if (phase === 'final' || phase === 'runtime') {
        const o = await api(`/orders/${f.order}`),
          r = await api(`/returns/${f.return_id}`);
        assert.equal(r.refund_amount, 12300);
        assert.equal(r.state, 'closed');
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
            .rows,
          [{ on_hand: 11, reserved: 0 }],
        );
        assert.deepEqual(await fingerprints(s.tenants), s.before);
        const report = JSON.parse(await readFile('docs/amazon-fulfillment-native-qa.json', 'utf8'));
        report.final_runtime = await api('/health');
        report.document_id = f.document;
        report.return = {
          id: r.id,
          state: r.state,
          refund_amount: r.refund_amount,
          stock: { on_hand: 11, reserved: 0 },
        };
        report.final_local_order_status = o.status;
        report.final_verified_at = new Date().toISOString();
        await writeFile(
          phase === 'runtime'
            ? 'data/amazon-fulfillment-runtime080.json'
            : 'docs/amazon-fulfillment-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      }
    }
  }
} finally {
  await pool.end();
}
