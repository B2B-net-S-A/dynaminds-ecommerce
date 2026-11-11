import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, migrate } from '../server/db';
const path = 'data/payments-stage023.json';
const tables = [
  'orders',
  'order_items',
  'products',
  'stock',
  'documents',
  'listings',
  'offer_plans',
  'variant_offer_batches',
  'shipping_plans',
  'shipments',
  'warehouse_documents',
  'warehouse_document_lines',
  'suppliers',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'stock_movements',
  'reservations',
  'return_cases',
  'return_items',
  'variant_offer_batch_items',
  'order_status_plans',
  'order_status_simulations',
];
async function fingerprint(table: string, tenants: string[]) {
  const rows = (
    await pool.query(
      `SELECT (to_jsonb(t)-'payment_mode'-'cod_expected')::text AS line FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY line`,
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
try {
  const phase = process.argv[2];
  if (phase === 'before') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((x) => x.id),
      before: Record<string, unknown> = {};
    for (const t of tables) before[t] = await fingerprint(t, tenants);
    await writeFile(path, JSON.stringify({ tenants, before }), { mode: 0o600 });
    console.log(JSON.stringify({ baseline_tables: tables.length, tenants: tenants.length }));
  } else if (phase === 'migrate') {
    const b = JSON.parse(await readFile(path, 'utf8'));
    await migrate();
    for (const t of tables)
      assert.deepEqual(
        await fingerprint(t, b.tenants),
        b.before[t],
        t + ' modified previous business data',
      );
    const counts = (
      await pool.query(
        "SELECT method,kind,count(*)::int AS count FROM payment_entries WHERE method IN ('historical_status','historical_confirmation') GROUP BY method,kind ORDER BY method,kind",
      )
    ).rows;
    b.migration = {
      previous_tables_preserved: tables.length,
      excluded_runtime_tables: [
        'order_status_configs: active worker changes scheduling timestamps',
      ],
      historical_entries: counts,
    };
    await writeFile(path, JSON.stringify(b), { mode: 0o600 });
    console.log(JSON.stringify(b.migration));
  } else if (phase === 'label-snapshots') {
    const r = await pool.query(
      "UPDATE shipments s SET cod_expected=coalesce((p.input->>'cod')::integer,0) FROM shipping_plans p WHERE p.tenant_id=s.tenant_id AND p.order_id=s.order_id AND p.shipment_id=s.id AND s.cod_expected IS DISTINCT FROM coalesce((p.input->>'cod')::integer,0)",
    );
    console.log(
      JSON.stringify({ historical_cod_snapshots: r.rowCount, scope: 'new_metadata_only' }),
    );
  } else if (phase === 'setup') {
    const d = JSON.parse(await readFile(path, 'utf8'));
    assert(!d.fixture);
    let cookie = '';
    let tenant = '';
    async function api(p: string, method = 'GET', body?: any) {
      const r = await fetch('http://127.0.0.1:4100/api' + p, {
        method,
        headers: {
          cookie,
          ...(tenant ? { 'x-workspace-id': tenant } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
      assert(r.ok, method + ' ' + p + ': ' + r.status);
      return r.json();
    }
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    const org = await api('/workspaces', 'POST', {
      name: 'QA Płatności 20261004',
      currency: 'PLN',
      locale: 'pl-PL',
    });
    tenant = org.user.tenant_id;
    await api('/workspaces/plan', 'PATCH', { plan: 'business' });
    const warehouse = (await api('/warehouses')).data[0];
    d.fixture = { tenant_id: tenant, warehouse_id: warehouse.id, orders: [] };
    await writeFile(path, JSON.stringify(d), { mode: 0o600 });
    for (const provider of ['woocommerce', 'allegro', 'prestashop']) {
      const example = await api(
        '/integrations/' +
          (provider === 'woocommerce'
            ? 'demo-import'
            : provider === 'allegro'
              ? 'allegro-example'
              : 'prestashop-example'),
        'POST',
        {},
      );
      const raw = (
        await pool.query('SELECT raw FROM inbound_orders WHERE id=$1', [example.data[0].id])
      ).rows[0].raw;
      if (provider === 'woocommerce') {
        raw.payment_method = 'cod';
      } else if (provider === 'allegro') {
        raw.payment = { type: 'CASH_ON_DELIVERY', paidAmount: null };
      } else {
        raw.module = 'ps_cashondelivery';
        raw.total_paid_real = '0.000000';
        raw._dyna.state.paid = '0';
      }
      const product = await api('/products', 'POST', {
        sku: 'QA-PAY-' + provider.toUpperCase(),
        name: 'Pobranie ' + provider + ' · QA',
        price: 10000,
        quantity: 20,
        warehouse_id: warehouse.id,
      });
      const external =
        provider === 'woocommerce' ? '701' : provider === 'allegro' ? 'demo-offer-1' : '701:0';
      await api('/integrations/' + example.channel_id + '/mappings', 'POST', {
        external_id: external,
        sku: product.sku,
      });
      const inbound = (
        await api('/integrations/' + example.channel_id + '/stage-orders', 'POST', { data: [raw] })
      ).data[0];
      const o = await api('/imports/' + inbound.id + '/commit', 'POST', {
        warehouse_id: warehouse.id,
      });
      assert.equal(o.payment.received, 0);
      assert.equal(o.payment_mode, 'cod');
      assert.equal(o.status, 'new');
      d.fixture.orders.push({
        provider,
        order_id: o.id,
        number: o.number,
        total: o.total,
        product_id: product.id,
        sku: product.sku,
        channel_id: example.channel_id,
      });
      await writeFile(path, JSON.stringify(d), { mode: 0o600 });
    }
    const inpost = await api('/shipping/example', 'POST', {});
    d.fixture.inpost_id = inpost.id;
    const p = await api('/products', 'POST', {
      sku: 'QA-PAY-PREPAID',
      name: 'Przedpłata · QA',
      price: 10000,
      quantity: 20,
      warehouse_id: warehouse.id,
    });
    const o = await api('/orders', 'POST', {
      customer_name: 'Przedpłata QA',
      email: 'qa-prepaid@example.test',
      warehouse_id: warehouse.id,
      items: [{ product_id: p.id, quantity: 1 }],
    });
    d.fixture.prepaid = { order_id: o.id, number: o.number, sku: p.sku, total: o.total };
    await writeFile(path, JSON.stringify(d), { mode: 0o600 });
    console.log(JSON.stringify(d.fixture));
  } else throw Error('Unknown proof phase');
} finally {
  await pool.end();
}
