// Own local QA firm only. Baseline, session and credentials stay in ignored data/, mode 0600.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';
const file = 'data/shopify-stage086.json',
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
async function snapshot(ids: string[]) {
  const result: any = {};
  for (const t of tables)
    result[t] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [ids],
      )
    ).rows;
  return result;
}
let cookie = '';
async function api(p: string, m = 'GET', b?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method: m,
    headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  assert.equal(r.status, status, p + ' ' + (await r.clone().text()));
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as any;
}
try {
  if (phase === 'baseline') {
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((x) => x.id),
      accounts = (await pool.query('SELECT id,email,password_hash,name FROM users ORDER BY id'))
        .rows;
    await writeFile(
      file,
      JSON.stringify(
        { ids, accounts, before: await snapshot(ids), baseline_at: new Date().toISOString() },
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
      assert.equal(h.schema_revision, '065_shopify_oauth');
      s.email = 'qa-shopify-086@demo.local';
      s.password = 'DynaShopify!2026';
      assert(!s.tenant, 'QA firm already prepared');
      const r = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA Shopify86',
          organization: { name: 'QA Shopify OAuth 086' },
        },
        201,
      );
      s.tenant = r.user.tenant_id;
      s.user = r.user.id;
      s.warehouse = (await api('/warehouses')).data[0].id;
      const e = await api('/integrations/shopify-example', 'POST', {});
      s.channel = e.channel_id;
      s.cookie = cookie;
      await save();
      console.log({ tenant: s.tenant, channel: s.channel, ready_for_OAuth_UI: true });
    } else if (phase === 'flow') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      const account = await api(`/integrations/${s.channel}/shopify-account`);
      assert(account.bound && account.grant_matches && account.has_refresh_token);
      assert.equal(account.source, 'simulation');
      assert(account.scopes.includes('write_merchant_managed_fulfillment_orders'));
      const e = await api('/integrations/shopify-example', 'POST', {});
      s.inbound = e.data[0].id;
      s.product = (
        await api(
          '/products',
          'POST',
          {
            sku: 'QA-SHOPIFY086',
            name: 'Produkt OAuth Shopify86',
            price: 1500,
            vat: 23,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        )
      ).id;
      await api(`/integrations/${s.channel}/mappings`, 'POST', {
        external_id: 'gid://shopify/ProductVariant/701',
        sku: 'QA-SHOPIFY086',
      });
      const source = (await api(`/integrations/${s.channel}/imports`)).data.find(
          (x: any) => x.id === s.inbound,
        ),
        o = await api(`/imports/${s.inbound}/commit`, 'POST', {
          warehouse_id: s.warehouse,
          expected_hash: source.source_hash,
        });
      s.order = o.id;
      s.number = o.number;
      await save();
      await api(`/orders/${s.order}/status`, 'PATCH', { status: 'picking' });
      for (let i = 0; i < 2; i++)
        await api(`/orders/${s.order}/scan`, 'POST', { code: 'QA-SHOPIFY086' });
      await api(`/orders/${s.order}/status`, 'PATCH', { status: 'packed' });
      await api(`/orders/${s.order}/ship-demo`, 'POST', {});
      const p = await api(`/orders/${s.order}/shopify-fulfillment/preview`, 'POST', {
        company: 'DPD',
      });
      s.plan = p.id;
      await save();
      await api(`/shopify-fulfillment-plans/${p.id}/queue`, 'POST', { confirm_external: false });
      let done: any;
      for (let i = 0; i < 100; i++) {
        done = (await api(`/orders/${s.order}/shopify-fulfillment`)).data.find(
          (x: any) => x.id === p.id,
        );
        if (done?.state === 'done') break;
        assert(!['failed', 'conflict'].includes(done?.state), done?.error);
        await setTimeout(200);
      }
      assert.equal(done.state, 'done');
      s.document = (await api(`/orders/${s.order}/documents`, 'POST', { kind: 'invoice' })).id;
      const detail = await api(`/orders/${s.order}`),
        item = detail.items[0];
      const ret = await api(
        `/orders/${s.order}/returns`,
        'POST',
        {
          client_key: randomUUID(),
          kind: 'return',
          reason: 'QA lokalnego OAuth i zwrotu',
          items: [{ item_id: item.id, quantity: 2 }],
        },
        201,
      );
      s.return_id = ret.id;
      await save();
      const current = await api(`/returns/${ret.id}`);
      await api(`/returns/${ret.id}/receive`, 'POST', {
        version: current.version,
        note: 'QA przyjęcie dwóch sztuk',
        items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
      });
      s.correction = (await api(`/returns/${ret.id}/document`, 'POST', {})).id;
      await save();
      console.log({
        order: s.number,
        fulfillment: done.remote_id,
        return: s.return_id,
        flow_complete: true,
      });
    } else if (phase === 'verify') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      const h = await api('/health'),
        a = await api(`/integrations/${s.channel}/shopify-account`),
        o = await api(`/orders/${s.order}`),
        ret = await api(`/returns/${s.return_id}`),
        plans = (await api(`/orders/${s.order}/shopify-fulfillment`)).data;
      assert.equal(h.schema_revision, '065_shopify_oauth');
      assert(a.bound && a.grant_matches && a.source === 'simulation');
      assert.equal(o.status, 'return_received');
      assert.equal(o.total, 3299);
      assert.equal(ret.state, 'refund_pending');
      assert.equal(ret.refund_amount, 2799);
      assert.equal(ret.refunded_at, null);
      assert.equal(plans[0].state, 'done');
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [s.tenant, s.product],
        )
      ).rows;
      assert.deepEqual(stock, [{ on_hand: 10, reserved: 0 }]);
      const states = (
        await pool.query(
          'SELECT state,count(*)::int n FROM shopify_oauth_states WHERE tenant_id=$1 GROUP BY state',
          [s.tenant],
        )
      ).rows;
      assert(states.some((x) => x.state === 'cancelled' && x.n >= 1));
      assert(states.some((x) => x.state === 'done' && x.n >= 2));
      assert.deepEqual(await snapshot(s.ids), s.before, 'Prior firms business rows');
      assert.deepEqual(
        (
          await pool.query(
            'SELECT id,email,password_hash,name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
            [s.accounts.map((x: any) => x.id)],
          )
        ).rows,
        s.accounts,
        'Prior account fields',
      );
      const docs = (
        await pool.query(
          'SELECT kind,mode,data FROM documents WHERE tenant_id=$1 AND order_id=$2 ORDER BY kind',
          [s.tenant, s.order],
        )
      ).rows;
      assert.equal(docs.length, 2);
      assert(docs.every((x) => x.mode === 'demo'));
      assert.equal(docs.find((x) => x.kind === 'invoice').data.total, 3299);
      assert.equal(docs.find((x) => x.kind === 'correction').data.total, -2799);
      const report = {
        stage: 86,
        at: new Date().toISOString(),
        baseline_at: s.baseline_at,
        revision: h.revision,
        schema: h.schema_revision,
        tenant: s.tenant,
        order: s.order,
        number: o.number,
        total: 3299,
        stock: stock[0],
        shop_id: a.shop_id,
        scopes: a.scopes,
        oauth_state_counts: states,
        oauth_UI:
          'start, cancel, complete and reauthorize in IAB; native API prepared own account/channel',
        commercial_flow:
          'catalog/mapping/import/reservation/picking/packing/DEMO shipment/Shopify simulation/invoice/full return/correction verified by native API',
        fulfillment_id: plans[0].remote_id,
        invoice_total: 3299,
        correction_total: -2799,
        return_state: ret.state,
        refund_executed: false,
        prior_firms: s.ids.length,
        prior_accounts: s.accounts.length,
        prior_business_tables_exact: tables.length,
        prior_account_fields_exact: true,
        simulation: true,
        external_HTTP_requests: 0,
        provider_account_verified: false,
        goal_complete: false,
      };
      await writeFile('data/shopify-oauth-native-qa.json', JSON.stringify(report, null, 2) + '\n');
      console.log(report);
    } else throw Error('Unknown phase');
  }
} finally {
  await pool.end();
}
