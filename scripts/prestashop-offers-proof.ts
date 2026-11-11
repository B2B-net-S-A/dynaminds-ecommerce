// Localhost only. Labelled simulation; never contacts PrestaShop or sends a real shipment/payment.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/prestashop-offers-stage030.json';
const tables = [
  'orders',
  'order_items',
  'order_pick_items',
  'products',
  'stock',
  'reservations',
  'stock_movements',
  'stock_locations',
  'reservation_locations',
  'stock_location_movements',
  'stock_location_operations',
  'warehouse_documents',
  'warehouse_document_lines',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'documents',
  'shipments',
  'return_cases',
  'return_items',
  'listings',
  'offer_plans',
  'offer_sync_items',
  'order_status_plans',
  'source_payment_checks',
  'payment_entries',
  'automation_rules',
  'automation_runs',
  'automation_schedules',
  'automation_schedule_runs',
  'automation_schedule_items',
  'automation_schedule_receipts',
  'sms_templates',
  'sms_batches',
  'sms_messages',
  'order_batches',
  'order_batch_items',
  'stocktakes',
  'stocktake_lines',
  'stocktake_measurements',
];
async function fingerprint(table: string, tenants: string[]) {
  const rows = (
    await pool.query(
      'SELECT to_jsonb(t)::text row FROM ' +
        table +
        ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
let cookie = '',
  tenant = '';
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie,
      ...(tenant && !['/auth/login', '/workspaces', '/workspaces/switch'].includes(path)
        ? { 'x-workspace-id': tenant }
        : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert(r.ok, path + ':' + r.status + ' ' + JSON.stringify(d));
  return d;
}
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of tables) before[t] = await fingerprint(t, tenants);
    await writeFile(file, JSON.stringify({ tenants, before, checkpoints: [] }), { mode: 0o600 });
    console.log(
      JSON.stringify({ previous_business_tables: tables.length, tenants: tenants.length }),
    );
  } else {
    const d = JSON.parse(await readFile(file, 'utf8'));
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    if (phase === 'setup') {
      assert(!d.fixture);
      const org = await api('/workspaces', 'POST', {
        name: 'QA Presta oferty 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      tenant = org.user.tenant_id;
      const w = (await api('/warehouses')).data[0],
        p = await api('/products', 'POST', {
          sku: 'QA-DODATEK',
          name: 'QA Presta — oferta i rezerwacje',
          price: 12300,
          vat: 23,
          quantity: 12,
          warehouse_id: w.id,
        });
      const example = await api('/integrations/prestashop-example', 'POST', {}),
        listing = await api('/integrations/' + example.channel_id + '/mappings', 'POST', {
          external_id: '701:0',
          sku: p.sku,
        });
      d.fixture = {
        tenant_id: tenant,
        warehouse_id: w.id,
        product_id: p.id,
        channel_id: example.channel_id,
        listing_id: listing.id,
        inbound_id: example.data[0].id,
      };
    } else {
      tenant = d.fixture.tenant_id;
      await api('/workspaces/switch', 'POST', { tenant_id: tenant });
      const f = d.fixture;
      if (phase === 'reprice') {
        const p = await api('/products/' + f.product_id);
        await api('/products/' + p.id, 'PATCH', {
          ...p,
          version: p.version,
          price: Number(process.argv[3]),
        });
      } else if (phase === 'import') {
        const r = await api('/imports/' + f.inbound_id + '/commit', 'POST', {
          warehouse_id: f.warehouse_id,
        });
        d.fixture.order_id = r.order?.id ?? r.order_id ?? r.id;
        console.log(
          JSON.stringify({
            order_id: d.fixture.order_id,
            number: r.number,
            status: r.status,
            total: r.total,
          }),
        );
      } else if (phase === 'fulfill') {
        let o = await api('/orders/' + f.order_id);
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
          reason: 'QA Presta — zwrot lokalny',
          shipping_refund: o.shipping_cost,
          items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
        });
        r = await api('/returns/' + r.id + '/receive', 'POST', {
          version: r.version,
          shipping_refund: o.shipping_cost,
          note: 'QA przyjęcie',
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
          reference: 'QA-SYMULACJA-BEZ-PRZELEWU',
          confirmed: true,
        });
        d.fixture.return_id = r.id;
      } else if (phase === 'checkpoint') {
        const l = (
            await pool.query('SELECT price,last_result FROM listings WHERE id=$1', [f.listing_id])
          ).rows[0],
          config = (await api('/integrations/' + f.channel_id + '/offer-sync')).config;
        assert.equal(l.last_result.regular_price, process.argv[3]);
        assert.equal(l.last_result.stock_quantity, Number(process.argv[4]));
        const point = {
          at: new Date().toISOString(),
          listing: l,
          enabled: config?.enabled ?? false,
        };
        d.checkpoints.push(point);
        console.log(JSON.stringify(point));
      } else if (phase === 'verify') {
        for (const t of tables)
          assert.deepEqual(
            await fingerprint(t, d.tenants),
            d.before[t],
            t + ' prior fields changed',
          );
        const cfg = await api('/integrations/' + f.channel_id + '/offer-sync');
        assert.equal(cfg.config.enabled, false);
        const l = (
          await pool.query('SELECT price,price_currency,last_result FROM listings WHERE id=$1', [
            f.listing_id,
          ])
        ).rows[0];
        assert.equal(l.price, 17220);
        assert.equal(l.last_result.regular_price, '140.000000');
        assert.equal(l.last_result.product_price, '140.000000');
        assert.equal(l.last_result.stock_quantity, 12);
        const o = await api('/orders/' + f.order_id);
        assert.equal(o.status, 'return_completed');
        assert.equal(o.total, 3299);
        const stock = (
          await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product_id])
        ).rows[0];
        assert.deepEqual(stock, { on_hand: 12, reserved: 0 });
        const plans = (
          await pool.query(
            'SELECT id,state,phase,sync_version,payload,result FROM offer_plans WHERE tenant_id=$1 ORDER BY created_at,id',
            [tenant],
          )
        ).rows;
        assert(plans.length >= 4);
        assert(
          plans.every(
            (p) =>
              p.state === 'done' &&
              p.result.scope === 'local_simulation' &&
              p.result.desired_applied,
          ),
        );
        assert(d.checkpoints.length >= 5);
        const documents = (
          await pool.query(
            "SELECT kind,mode,data->>'total' total FROM documents WHERE order_id=$1 ORDER BY kind",
            [o.id],
          )
        ).rows;
        assert.equal(documents.length, 2);
        assert(documents.every((d) => d.mode === 'demo'));
        const proof = {
          checked_at: new Date().toISOString(),
          scope: 'local_synthetic_chrome_qa',
          previous_business_tables_preserved: tables.length,
          schema_revision: '029_stocktakes',
          fixture: f,
          listing: l,
          stock,
          order: { number: o.number, status: o.status, total: o.total },
          documents,
          plans,
          checkpoints: d.checkpoints,
          external_provider_requests: 0,
          real_shipments: 0,
          real_payments: 0,
        };
        await writeFile('docs/prestashop-offers-qa.json', JSON.stringify(proof, null, 2) + '\n');
        console.log(
          JSON.stringify({
            scope: proof.scope,
            previous_business_tables_preserved: tables.length,
            plans: plans.length,
            stock,
            listing: l.last_result,
            order: proof.order,
          }),
        );
      }
    }
    if (phase !== 'verify') await writeFile(file, JSON.stringify(d), { mode: 0o600 });
    if (phase === 'setup') console.log(JSON.stringify(d.fixture));
  }
} finally {
  await pool.end();
}
