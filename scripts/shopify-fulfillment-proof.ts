// Dedicated local QA firm. Credentials and exact prior-state snapshots remain ignored, mode 0600.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/shopify-stage085.json',
  phase = process.argv[2];
const tables = [
  'products',
  'stock',
  'orders',
  'order_items',
  'shipments',
  'documents',
  'reservations',
  'return_cases',
  'return_items',
  'payment_entries',
  'channels',
  'email_templates',
  'email_batches',
  'email_messages',
  'email_message_files',
  'invoice_email_files',
  'picking_waves',
  'picking_wave_orders',
  'automation_rules',
  'api_keys',
];
async function snapshot(ids: string[], names = tables) {
  const result: any = {};
  for (const t of names) {
    if (!(await pool.query('SELECT to_regclass($1) p', ['public.' + t])).rows[0].p) continue;
    result[t] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [ids],
      )
    ).rows;
  }
  return result;
}
let cookie = '';
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, status, path + ' ' + (await r.clone().text()));
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as any;
}
try {
  if (phase === 'baseline') {
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      accounts = (await pool.query('SELECT id,email,password_hash,name FROM users ORDER BY id'))
        .rows;
    await writeFile(
      file,
      JSON.stringify(
        { ids, before: await snapshot(ids), accounts, at: new Date().toISOString() },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({ prior_firms: ids.length, prior_accounts: accounts.length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8')),
      save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    if (phase === 'setup') {
      const h = await api('/health');
      assert.equal(h.schema_revision, '064_shopify_fulfillment');
      assert(h.shopify_fulfillment_available);
      s.email = 'qa-shopify-085@demo.local';
      s.password = 'DynaShopify!2026';
      if (!s.tenant) {
        const r = await api(
          '/auth/signup',
          'POST',
          {
            email: s.email,
            password: s.password,
            name: 'QA Shopify85',
            organization: { name: 'QA Shopify 085' },
          },
          201,
        );
        s.tenant = r.user.tenant_id;
        s.user = r.user.id;
        await save();
      } else await api('/auth/login', 'POST', { email: s.email, password: s.password });
      s.cookie = cookie;
      s.warehouse = (await api('/warehouses')).data[0].id;
      const example = await api('/integrations/shopify-example', 'POST', {});
      s.channel = example.channel_id;
      s.inbound = example.data[0].id;
      s.product ??= (
        await api(
          '/products',
          'POST',
          {
            sku: 'QA-SHOPIFY',
            name: 'Żółty produkt Shopify85',
            price: 1500,
            vat: 23,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        )
      ).id;
      await save();
      await api('/integrations/' + s.channel + '/mappings', 'POST', {
        external_id: 'gid://shopify/ProductVariant/701',
        sku: 'QA-SHOPIFY',
      });
      if (!s.order) {
        const source = (await api('/integrations/' + s.channel + '/imports')).data.find(
          (v: any) => v.id === s.inbound,
        );
        const o = await api('/imports/' + s.inbound + '/commit', 'POST', {
          warehouse_id: s.warehouse,
          expected_hash: source.source_hash,
        });
        s.order = o.id;
        await save();
      }
      let o = await api('/orders/' + s.order);
      s.number = o.number;
      assert.equal(o.total, 3299);
      if (o.status === 'paid')
        await api('/orders/' + s.order + '/status', 'PATCH', { status: 'picking' });
      o = await api('/orders/' + s.order);
      if (o.status === 'picking') {
        for (let n = Number(o.items[0].scanned); n < 2; n++)
          await api('/orders/' + s.order + '/scan', 'POST', { code: 'QA-SHOPIFY' });
        await api('/orders/' + s.order + '/status', 'PATCH', { status: 'packed' });
      }
      await save();
      console.log({
        tenant: s.tenant,
        order: s.order,
        number: s.number,
        total: 3299,
        packed_for_UI: true,
      });
    } else if (phase === 'verify') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      const h = await api('/health'),
        o = await api('/orders/' + s.order),
        plans = (await api('/orders/' + s.order + '/shopify-fulfillment')).data;
      assert.equal(plans.length, 1);
      const p = plans[0];
      assert.equal(p.state, 'done');
      assert.equal(p.phase, 'done');
      assert.equal(p.result.fulfillment.status, 'SUCCESS');
      assert.equal(p.payload.fulfillment.notifyCustomer, false);
      assert.equal(p.payload.lines[0].quantity, 2);
      assert.equal(p.payload.fulfillment.trackingInfo.number, o.shipments[0].tracking_number);
      assert.equal(o.status, 'shipped');
      assert.equal(o.total, 3299);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [s.tenant, s.product],
          )
        ).rows,
        [{ on_hand: 8, reserved: 0 }],
      );
      assert(o.shipments.every((v: any) => v.mode === 'demo'));
      const before = await snapshot(s.ids, Object.keys(s.before));
      for (const t of Object.keys(s.before))
        assert.deepEqual(before[t], s.before[t], 'Previous firms ' + t);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT id,email,password_hash,name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
            [s.accounts.map((r: any) => r.id)],
          )
        ).rows,
        s.accounts,
      );
      const report = {
        stage: 85,
        at: new Date().toISOString(),
        revision: h.revision,
        schema: h.schema_revision,
        tenant: s.tenant,
        order: s.order,
        number: s.number,
        total: 3299,
        stock: { on_hand: 8, reserved: 0 },
        local_UI_confirmation: true,
        simulation: true,
        external_HTTP_requests: 0,
        notify_customer: false,
        fulfillment_id: p.remote_id,
        phase: p.phase,
        source_line_ids: p.payload.lines,
        allocations: p.payload.fulfillment.lineItemsByFulfillmentOrder,
        tracking: p.payload.fulfillment.trackingInfo,
        prior_firms: s.ids.length,
        prior_accounts: s.accounts.length,
        prior_business_tables_exact: Object.keys(s.before).length,
        UI_scope:
          'DEMO shipment and fulfillment preview/approval; account, product and import prepared via native API',
        provider_account_verified: false,
      };
      await writeFile('data/shopify-fulfillment-native-qa.json', JSON.stringify(report, null, 2));
      console.log(report);
      s.plan = p.id;
      await save();
    } else if (phase === 'end-to-end') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      const o = await api('/orders/' + s.order),
        history = await api('/orders/' + s.order + '/shopify-fulfillment'),
        docs = (
          await pool.query(
            'SELECT id,kind,mode,data FROM documents WHERE tenant_id=$1 AND order_id=$2 ORDER BY kind',
            [s.tenant, s.order],
          )
        ).rows,
        returns = (
          await pool.query(
            'SELECT id,state,refund_amount,refunded_at FROM return_cases WHERE tenant_id=$1 AND order_id=$2',
            [s.tenant, s.order],
          )
        ).rows;
      const report = JSON.parse(await readFile('data/shopify-fulfillment-native-qa.json', 'utf8'));
      assert.equal(o.status, 'return_received');
      assert.equal(o.total, 3299);
      assert.equal(history.data.length, 1);
      assert.equal(history.data[0].id, s.plan);
      assert.equal(history.data[0].state, 'done');
      assert.equal(history.data[0].remote_id, report.fulfillment_id);
      assert.equal(history.ready, false);
      assert.match(history.reason, /Realizacja przesyłki została potwierdzona/);
      assert.equal(docs.length, 2);
      assert(docs.every((d) => d.mode === 'demo'));
      assert.equal(docs.find((d) => d.kind === 'invoice').data.total, 3299);
      assert.equal(docs.find((d) => d.kind === 'correction').data.total, -2799);
      assert.equal(returns.length, 1);
      assert.equal(returns[0].state, 'refund_pending');
      assert.equal(returns[0].refund_amount, 2799);
      assert.equal(returns[0].refunded_at, null);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT accepted,restocked FROM return_items WHERE tenant_id=$1 AND return_id=$2',
            [s.tenant, returns[0].id],
          )
        ).rows,
        [{ accepted: 2, restocked: 2 }],
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [s.tenant, s.product],
          )
        ).rows,
        [{ on_hand: 10, reserved: 0 }],
      );
      for (const [t, rows] of Object.entries(await snapshot(s.ids, Object.keys(s.before))))
        assert.deepEqual(rows, s.before[t], 'Previous firms ' + t);
      report.end_to_end = {
        verified_at: new Date().toISOString(),
        revision: (await api('/health')).revision,
        status: 'return_received',
        stock: { on_hand: 10, reserved: 0 },
        invoice_total: 3299,
        correction_total: -2799,
        return_amount: 2799,
        return_state: 'refund_pending',
        accepted: 2,
        restocked: 2,
        refund_executed: false,
        historical_fulfillment_retained: true,
        UI_scope:
          'DEMO shipment, fulfillment preview/approval, invoice, return receive and correction; initial account/catalog/import/picking prepared via native API',
      };
      s.document = docs.find((d) => d.kind === 'invoice').id;
      s.correction = docs.find((d) => d.kind === 'correction').id;
      s.return_id = returns[0].id;
      await save();
      await writeFile('data/shopify-fulfillment-native-qa.json', JSON.stringify(report, null, 2));
      console.log(report.end_to_end);
    } else throw Error('Unknown phase');
  }
} finally {
  await pool.end();
}
