// Local proof: changes only its own QA firm; private account/baseline remain in ignored data/.
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, tenantTx } from '../server/db';
import { encrypt, decrypt } from '../server/security';
const phase = process.argv[2],
  file = 'data/shopify-stage088.json';
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
  const out: any = {};
  for (const t of tables)
    out[t] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [ids],
      )
    ).rows;
  return out;
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
        { ids, accounts, before: await snapshot(ids), baseline_at: new Date().toISOString() },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({ prior_firms: ids.length, prior_accounts: accounts.length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    const save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    if (phase === 'setup') {
      assert(!s.tenant);
      s.email = 'qa-shopify-088@demo.local';
      s.password = 'DynaShopify!2026';
      s.setup_revision = (await api('/health')).revision;
      const r = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA Shopify88',
          organization: { name: 'QA Shopify webhooki 088' },
        },
        201,
      );
      s.tenant = r.user.tenant_id;
      s.user = r.user.id;
      await save();
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.channel = randomUUID();
      await tenantTx(s.tenant, (c) =>
        c.query(
          "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'shopify','Shopify webhooki — przykład lokalny','sandbox',$3,$4,'simulation')",
          [s.channel, s.tenant, encrypt({}), JSON.stringify({ simulation: true })],
        ),
      );
      s.product = (
        await api(
          '/products',
          'POST',
          {
            sku: 'QA-SHOPIFY088',
            name: 'Produkt Shopify88',
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
        sku: 'QA-SHOPIFY088',
      });
      assert.equal((await api(`/integrations/${s.channel}/imports`)).data.length, 0);
      s.ready_at = new Date().toISOString();
      await save();
      console.log({
        organization: 'QA Shopify webhooki 088',
        channel: s.channel,
        empty_buffer: true,
        ready_for_UI: true,
      });
    } else {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      const history = await api(`/integrations/${s.channel}/shopify-webhooks`),
        current = (await api(`/integrations/${s.channel}/imports`)).data[0];
      assert(current?.order_id, 'First event and order import must be approved in UI');
      s.inbound = current.id;
      s.order = current.order_id;
      if (phase === 'concurrent-config') {
        assert(!s.concurrent_version);
        s.original_config_version = history.config.version;
        s.concurrent_version = (
          await api(`/integrations/${s.channel}/shopify-webhooks`, 'PATCH', {
            version: history.config.version,
            enabled: history.config.enabled,
          })
        ).version;
        await save();
        console.log({
          concurrent_configuration_version: s.concurrent_version,
          enabled: history.config.enabled,
        });
      } else if (phase === 'finish') {
        assert(!s.finished_at);
        const first = history.deliveries.find((d: any) => d.topic === 'orders/create');
        assert(first?.outcome === 'processed');
        s.first_delivery = first.id;
        const receipt = (
            await pool.query(
              'SELECT * FROM shopify_webhook_deliveries WHERE id=$1 AND tenant_id=$2',
              [first.id, s.tenant],
            )
          ).rows[0],
          cfg = (
            await pool.query(
              'SELECT signing_secret FROM shopify_webhook_configs WHERE channel_id=$1 AND tenant_id=$2',
              [s.channel, s.tenant],
            )
          ).rows[0];
        const body = JSON.stringify({
            id: receipt.order_gid.split('/').at(-1),
            admin_graphql_api_id: receipt.order_gid,
          }),
          headers = {
            'Content-Type': 'application/json',
            'x-shopify-topic': receipt.topic,
            'x-shopify-api-version': receipt.api_version,
            'x-shopify-shop-domain': receipt.shop_domain,
            'x-shopify-webhook-id': receipt.delivery_id,
            'x-shopify-event-id': receipt.event_id,
            'x-shopify-hmac-sha256': createHmac('sha256', decrypt(cfg.signing_secret).secret)
              .update(body)
              .digest('base64'),
          };
        const result = await fetch(`http://127.0.0.1:4100/api/webhooks/shopify/${s.channel}`, {
          method: 'POST',
          headers,
          body,
        });
        assert.equal(result.status, 200);
        assert.equal(((await result.json()) as any).duplicate, true);
        const bad = await fetch(`http://127.0.0.1:4100/api/webhooks/shopify/${s.channel}`, {
          method: 'POST',
          headers,
          body: body + ' ',
        });
        assert.equal(bad.status, 401);
        s.http_duplicate = 200;
        s.http_altered_signature = 401;
        const o = await api(`/orders/${s.order}`);
        assert.equal(o.total, 3299);
        assert.equal(o.status, 'paid');
        s.number = o.number;
        assert.equal(
          (
            await api(`/imports/${s.inbound}/commit`, 'POST', {
              warehouse_id: s.warehouse,
              expected_hash: current.source_hash,
            })
          ).id,
          s.order,
        );
        await save();
        await api(`/orders/${s.order}/status`, 'PATCH', { status: 'picking' });
        for (let n = 0; n < 2; n++)
          await api(`/orders/${s.order}/scan`, 'POST', { code: 'QA-SHOPIFY088' });
        await api(`/orders/${s.order}/status`, 'PATCH', { status: 'packed' });
        await api(`/orders/${s.order}/ship-demo`, 'POST', {});
        s.document = (await api(`/orders/${s.order}/documents`, 'POST', { kind: 'invoice' })).id;
        const item = (await api(`/orders/${s.order}`)).items[0];
        const ret = await api(
          `/orders/${s.order}/returns`,
          'POST',
          {
            client_key: randomUUID(),
            kind: 'return',
            reason: 'Lokalna weryfikacja webhooków Shopify88',
            items: [{ item_id: item.id, quantity: 2 }],
          },
          201,
        );
        s.return_id = ret.id;
        await save();
        await api(`/returns/${ret.id}/receive`, 'POST', {
          version: (await api(`/returns/${ret.id}`)).version,
          note: 'QA88 przyjęcie',
          items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
        });
        s.correction = (await api(`/returns/${ret.id}/document`, 'POST', {})).id;
        s.historical = await api(`/orders/${s.order}`);
        s.finished_at = new Date().toISOString();
        await save();
        console.log({
          order: s.number,
          flow: 'webhook/worker/UI-import/replay/picking/scans/packing/DEMO-shipping/invoice/return/correction',
          http_duplicate: 200,
          http_altered_signature: 401,
        });
      } else if (phase === 'verify') {
        assert(s.finished_at);
        if (s.concurrent_version) {
          assert.equal(history.config.version, s.concurrent_version + 1);
          assert.equal(history.config.enabled, true);
        }
        const cancelled = history.deliveries.find((d: any) => d.topic === 'orders/cancelled');
        assert(cancelled?.outcome === 'processed', 'Cancellation must first be exercised in UI');
        assert(current.source_changed);
        assert.equal(current.state, 'imported');
        await api(
          `/imports/${s.inbound}/commit`,
          'POST',
          { warehouse_id: s.warehouse, expected_hash: current.source_hash },
          409,
        );
        assert.deepEqual(await api(`/orders/${s.order}`), s.historical);
        const ret = await api(`/returns/${s.return_id}`);
        assert.equal(ret.state, 'refund_pending');
        assert.equal(ret.refund_amount, 2799);
        assert.equal(ret.refunded_at, null);
        const stock = (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [s.tenant, s.product],
          )
        ).rows;
        assert.deepEqual(stock, [{ on_hand: 10, reserved: 0 }]);
        assert.deepEqual(await snapshot(s.ids), s.before);
        assert.deepEqual(
          (
            await pool.query(
              'SELECT id,email,password_hash,name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
              [s.accounts.map((r: any) => r.id)],
            )
          ).rows,
          s.accounts,
        );
        const h = await api('/health');
        assert.equal(h.schema_revision, '066_shopify_webhooks');
        assert(h.shopify_webhooks_available);
        const report = {
          stage: 88,
          verified_at: new Date().toISOString(),
          baseline_at: s.baseline_at,
          setup_revision: s.setup_revision,
          runtime_revision: h.revision,
          schema: h.schema_revision,
          own_organization: s.tenant,
          source_mode: 'local_simulation',
          UI_configuration: true,
          UI_created_event: true,
          UI_import: true,
          UI_cancelled_event: true,
          UI_conflict_and_reload_manually_observed: !!s.concurrent_version,
          configuration_version: history.config.version,
          configuration_enabled: history.config.enabled,
          processed_deliveries: history.deliveries.filter((d: any) => d.outcome === 'processed')
            .length,
          http_duplicate: s.http_duplicate,
          http_altered_signature: s.http_altered_signature,
          order: s.number,
          total: 3299,
          status: s.historical.status,
          invoice: s.document,
          correction: s.correction,
          return_state: ret.state,
          refund_amount: ret.refund_amount,
          funds_refunded: false,
          stock,
          source_change: 'buffer_only',
          historical_OMS_exact: true,
          prior_firms_unchanged: s.ids.length,
          prior_accounts_unchanged: s.accounts.length,
          compared_business_tables: tables.length,
          provider_account_verified: false,
          goal_complete: false,
        };
        await writeFile(
          'data/shopify-webhooks-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      } else throw Error('Unknown proof phase');
    }
  }
} finally {
  await pool.end();
}
