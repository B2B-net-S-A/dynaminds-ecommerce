// This proof changes only its own local QA organization. Private baseline and login stay in data/.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { demoShopifyOrder } from '../server/shopify-example';
const phase = process.argv[2],
  file = 'data/shopify-stage087.json';
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
  for (const table of tables)
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [ids],
      )
    ).rows;
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
      assert(!s.tenant, 'QA organization already exists');
      const h = await api('/health');
      s.setup_revision = h.revision;
      s.email = 'qa-shopify-087@demo.local';
      s.password = 'DynaShopify!2026';
      const registered = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA Shopify87',
          organization: { name: 'QA Shopify odczyt 087' },
        },
        201,
      );
      s.tenant = registered.user.tenant_id;
      s.user = registered.user.id;
      await save();
      s.warehouse = (await api('/warehouses')).data[0].id;
      const example = await api('/integrations/shopify-example', 'POST', {});
      s.channel = example.channel_id;
      s.inbound = example.data[0].id;
      s.product = (
        await api(
          '/products',
          'POST',
          {
            sku: 'QA-SHOPIFY087',
            name: 'Produkt Shopify87',
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
        sku: 'QA-SHOPIFY087',
      });
      const raw = structuredClone(demoShopifyOrder);
      raw.updatedAt = '2026-10-05T04:00:00.000Z';
      raw.note = 'Nowsza obserwacja QA087';
      const newest = (await api(`/integrations/${s.channel}/stage-orders`, 'POST', { data: [raw] }))
        .data[0];
      const old = (
        await api(`/integrations/${s.channel}/stage-orders`, 'POST', { data: [demoShopifyOrder] })
      ).data[0];
      assert.equal(old.observation, 'older_ignored');
      assert.equal(old.source_hash, newest.source_hash);
      const conflict = { ...raw, note: 'Konflikt tej samej wersji QA087' };
      await api(`/integrations/${s.channel}/stage-orders`, 'POST', { data: [conflict] }, 409);
      await api(`/imports/${s.inbound}/commit`, 'POST', { warehouse_id: s.warehouse }, 422);
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [s.tenant, s.product],
        )
      ).rows;
      assert.deepEqual(stock, [{ on_hand: 10, reserved: 0 }]);
      s.cookie = cookie;
      s.newest_hash = newest.source_hash;
      s.ready_at = new Date().toISOString();
      await save();
      console.log({
        organization: 'QA Shopify odczyt 087',
        channel: s.channel,
        older_ignored: true,
        conflict_409: true,
        no_hash_422: true,
        ready_for_UI: true,
      });
    } else if (phase === 'finish') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      const inbound = (
        await pool.query('SELECT * FROM inbound_orders WHERE id=$1 AND tenant_id=$2', [
          s.inbound,
          s.tenant,
        ])
      ).rows[0];
      assert(inbound.order_id, 'Import must first be approved in the UI');
      s.order = inbound.order_id;
      const order = await api(`/orders/${s.order}`);
      s.number = order.number;
      assert.equal(order.total, 3299);
      assert.equal(order.status, 'paid');
      const replay = await api(`/imports/${s.inbound}/commit`, 'POST', {
        warehouse_id: s.warehouse,
        expected_hash: inbound.source_hash,
      });
      assert.equal(replay.id, s.order);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [s.tenant, s.product],
          )
        ).rows,
        [{ on_hand: 10, reserved: 2 }],
      );
      s.ui_refreshes = Number(
        (
          await pool.query(
            "SELECT count(*) n FROM audit_events WHERE tenant_id=$1 AND action='integration.order.refresh'",
            [s.tenant],
          )
        ).rows[0].n,
      );
      assert(s.ui_refreshes >= 1, 'Point refresh must be exercised in the UI');
      await save();
      await api(`/orders/${s.order}/status`, 'PATCH', { status: 'picking' });
      for (let n = 0; n < 2; n++)
        await api(`/orders/${s.order}/scan`, 'POST', { code: 'QA-SHOPIFY087' });
      await api(`/orders/${s.order}/status`, 'PATCH', { status: 'packed' });
      await api(`/orders/${s.order}/ship-demo`, 'POST', {});
      s.document = (await api(`/orders/${s.order}/documents`, 'POST', { kind: 'invoice' })).id;
      const shipped = await api(`/orders/${s.order}`),
        item = shipped.items[0];
      const ret = await api(
        `/orders/${s.order}/returns`,
        'POST',
        {
          client_key: randomUUID(),
          kind: 'return',
          reason: 'Lokalna weryfikacja odczytu i zwrotu Shopify87',
          items: [{ item_id: item.id, quantity: 2 }],
        },
        201,
      );
      s.return_id = ret.id;
      await save();
      const beforeReceive = await api(`/returns/${ret.id}`);
      await api(`/returns/${ret.id}/receive`, 'POST', {
        version: beforeReceive.version,
        note: 'QA87 przyjęcie',
        items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
      });
      s.correction = (await api(`/returns/${ret.id}/document`, 'POST', {})).id;
      await save();
      const historical = await api(`/orders/${s.order}`),
        stockBefore = (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [s.tenant, s.product],
          )
        ).rows;
      const changed = structuredClone(inbound.raw);
      changed.updatedAt = '2026-10-05T04:01:00.000Z';
      changed.cancelledAt = changed.updatedAt;
      await api(`/integrations/${s.channel}/stage-orders`, 'POST', { data: [changed] });
      const current = (await api(`/integrations/${s.channel}/imports`)).data.find(
        (r: any) => r.id === s.inbound,
      );
      assert(current.source_changed);
      assert.equal(current.state, 'imported');
      await api(
        `/imports/${s.inbound}/commit`,
        'POST',
        { warehouse_id: s.warehouse, expected_hash: current.source_hash },
        409,
      );
      assert.deepEqual(await api(`/orders/${s.order}`), historical);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [s.tenant, s.product],
          )
        ).rows,
        stockBefore,
      );
      s.historical_preserved = true;
      s.finished_at = new Date().toISOString();
      await save();
      console.log({
        order: s.number,
        flow: 'import/replay/picking/scans/packing/DEMO-shipping/invoice/return/correction',
        source_change: 'buffer_only',
        stock: stockBefore,
      });
    } else if (phase === 'verify') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      const h = await api('/health'),
        o = await api(`/orders/${s.order}`),
        ret = await api(`/returns/${s.return_id}`);
      assert.equal(o.status, 'return_received');
      assert.equal(o.total, 3299);
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
      const current = await snapshot(s.ids);
      assert.deepEqual(current, s.before);
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
        verified_at: new Date().toISOString(),
        baseline_at: s.baseline_at,
        setup_revision: s.setup_revision,
        runtime_revision: h.revision,
        schema: h.schema_revision,
        own_organization: s.tenant,
        source_mode: 'local_simulation',
        older_ignored: true,
        same_version_conflict: 409,
        missing_approval_hash: 422,
        UI_refreshes_at_import: s.ui_refreshes,
        UI_refreshes: Number(
          (
            await pool.query(
              "SELECT count(*) n FROM audit_events WHERE tenant_id=$1 AND action='integration.order.refresh'",
              [s.tenant],
            )
          ).rows[0].n,
        ),
        UI_import_verified: true,
        order: s.number,
        total: o.total,
        status: o.status,
        invoice: s.document,
        correction: s.correction,
        return_state: ret.state,
        refund_amount: ret.refund_amount,
        funds_refunded: false,
        stock,
        subsequent_source_change:
          'manually_staged_synthetic_cancellation; buffer only; original OMS and stock exact',
        prior_firms: s.ids.length,
        prior_accounts: s.accounts.length,
        prior_business_tables: tables.length,
        prior_compared_rows_exact: true,
        provider_account_verified: false,
        webhook_receiver_implemented: false,
      };
      await writeFile(
        'docs/shopify-order-read-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    } else throw Error('Use baseline/setup/finish/verify');
  }
} finally {
  await pool.end();
}
