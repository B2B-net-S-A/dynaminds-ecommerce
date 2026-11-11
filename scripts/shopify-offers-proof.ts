// Native localhost proof; labelled synthetic Shopify order, DEMO shipping/documents/refund.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/shopify-offers-stage032.json';
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
      ...(tenant &&
      !['/auth/login', '/auth/signup', '/workspaces', '/workspaces/switch'].includes(path)
        ? { 'x-workspace-id': tenant }
        : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
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
    const n = (
      await pool.query(
        "SELECT count(*)::int n FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='admin@demo.local' AND m.role='admin'",
      )
    ).rows[0].n;
    await writeFile(file, JSON.stringify({ tenants, before, admin_organizations: n }), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({ tables: tables.length, tenants: tenants.length, admin_organizations: n }),
    );
  } else {
    const d = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup') {
      assert(!d.fixture);
      if (d.admin_organizations < 20) {
        await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
        const org = await api('/workspaces', 'POST', {
          name: 'QA Shopify oferty 20261004',
          currency: 'PLN',
          locale: 'pl-PL',
        });
        tenant = org.user.tenant_id;
        d.login = 'admin@demo.local';
      } else {
        const org = await api('/auth/signup', 'POST', {
          email: 'qa-shopify-offers@demo.local',
          name: 'QA Shopify oferty',
          password: 'DynaDemo!2026',
          organization: { name: 'QA Shopify oferty 20261004', currency: 'PLN', locale: 'pl-PL' },
        });
        tenant = org.user.tenant_id;
        d.login = 'qa-shopify-offers@demo.local';
      }
      const w = (await api('/warehouses')).data[0],
        p = await api('/products', 'POST', {
          sku: 'QA-SHOPIFY',
          name: 'QA Shopify — import i realizacja',
          warehouse_id: w.id,
          quantity: 10,
          price: 1500,
          vat: 23,
        });
      const example = await api('/integrations/shopify-example', 'POST');
      assert.equal(example.scope, 'local_simulation');
      const mapping = await api('/integrations/' + example.channel_id + '/mappings', 'POST', {
        external_id: 'gid://shopify/ProductVariant/701',
        sku: p.sku,
      });
      d.fixture = {
        tenant_id: tenant,
        warehouse_id: w.id,
        product_id: p.id,
        channel_id: example.channel_id,
        listing_id: mapping.id,
        inbound_id: example.data[0].id,
      };
    } else {
      await api('/auth/login', 'POST', { email: d.login, password: 'DynaDemo!2026' });
      tenant = d.fixture.tenant_id;
      await api('/workspaces/switch', 'POST', { tenant_id: tenant });
      const f = d.fixture;
      if (phase === 'import') {
        const a = await api('/imports/' + f.inbound_id + '/commit', 'POST', {
            warehouse_id: f.warehouse_id,
          }),
          b = await api('/imports/' + f.inbound_id + '/commit', 'POST', {
            warehouse_id: f.warehouse_id,
          });
        assert.equal(a.id, b.id);
        assert.equal(a.total, 3299);
        assert.equal(a.status, 'paid');
        assert.equal(a.source, 'shopify');
        f.order_id = a.id;
        console.log(
          JSON.stringify({
            order: a.number,
            total: a.total,
            status: a.status,
            replay_same_id: true,
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
          reason: 'QA Shopify — zwrot lokalny',
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
        f.return_id = r.id;
      } else if (
        phase === 'synchronize' ||
        phase === 'auto-reserved' ||
        phase === 'auto-returned'
      ) {
        const cfgPath = '/integrations/' + f.channel_id + '/offer-sync';
        const expected = phase === 'auto-reserved' ? 8 : 10;
        if (phase === 'synchronize') {
          const locations = await api('/integrations/' + f.channel_id + '/shopify-locations');
          if (!locations.inventory_location_id)
            await api('/integrations/' + f.channel_id + '/shopify-location', 'PATCH', {
              location_id: locations.data[0].id,
              expected_location_id: null,
            });
          const product = await api('/products/' + f.product_id);
          await api('/products/' + product.id, 'PATCH', {
            ...product,
            price: 2000,
            components: [],
          });
          const plan = await api('/integrations/' + f.channel_id + '/offers/preview', 'POST', {
            operation: 'sync',
            product_id: f.product_id,
            listing_id: f.listing_id,
            warehouse_id: f.warehouse_id,
            stock: true,
            price: true,
          });
          await api('/offer-plans/' + plan.id + '/queue', 'POST', {});
          f.manual_plan = plan.id;
        } else {
          const current = await api(cfgPath);
          if (!current.config?.enabled)
            await api(cfgPath, 'PATCH', {
              version: current.config?.version ?? 0,
              enabled: true,
              warehouse_id: f.warehouse_id,
              price_list_id: null,
              stock: true,
              price: true,
              interval_seconds: 30,
              verify_seconds: 60,
            });
          await api(cfgPath, 'POST', {});
        }
        let row: any;
        for (let n = 0; n < 100; n++) {
          row = (await pool.query('SELECT last_result FROM listings WHERE id=$1', [f.listing_id]))
            .rows[0].last_result;
          if (row?.stock_quantity === expected && row?.regular_price === '20.00') break;
          await new Promise((r) => setTimeout(r, 200));
        }
        assert.equal(row.stock_quantity, expected);
        assert.equal(row.regular_price, '20.00');
        assert.equal(row.scope, 'local_simulation');
        f[phase] = {
          price: row.regular_price,
          available: row.stock_quantity,
          location: row.location_id,
        };
        if (phase === 'auto-returned') {
          const cfg = (await api(cfgPath)).config;
          await api(cfgPath, 'PATCH', {
            version: cfg.version,
            enabled: false,
            warehouse_id: f.warehouse_id,
            price_list_id: null,
            stock: true,
            price: true,
            interval_seconds: 30,
            verify_seconds: 60,
          });
        }
        console.log(JSON.stringify(f[phase]));
      } else if (phase === 'verify') {
        for (const t of tables)
          assert.deepEqual(
            await fingerprint(t, d.tenants),
            d.before[t],
            t + ' previous business data changed',
          );
        const o = await api('/orders/' + f.order_id);
        assert.equal(o.status, 'return_completed');
        assert.equal(o.total, 3299);
        assert.equal(o.source, 'shopify');
        const stock = (
          await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product_id])
        ).rows[0];
        assert.deepEqual(stock, { on_hand: 10, reserved: 0 });
        const documents = (
          await pool.query(
            "SELECT kind,mode,data->>'total' total FROM documents WHERE order_id=$1 ORDER BY kind",
            [o.id],
          )
        ).rows;
        assert.equal(documents.length, 2);
        assert(documents.every((r) => r.mode === 'demo'));
        const queue = (await api('/integrations/' + f.channel_id + '/imports')).data[0];
        assert.equal(queue.order_id, o.id);
        assert.equal(queue.normalized.items[0].line_total, 2799);
        const spec = await api('/developer/openapi');
        await writeFile('docs/openapi.json', JSON.stringify(spec, null, 2) + '\n');
        const proof = {
          checked_at: new Date().toISOString(),
          scope: 'local_synthetic_native_and_chrome_qa',
          previous_business_tables_preserved: tables.length,
          previous_tenants: d.tenants.length,
          schema_revision: '029_stocktakes',
          fixture: f,
          stock,
          order: {
            number: o.number,
            status: o.status,
            total: o.total,
            currency: o.currency,
            source: o.source,
          },
          documents,
          inbound_state: queue.state,
          source_total: queue.normalized.total,
          source_line_total: queue.normalized.items[0].line_total,
          source_shipping: queue.normalized.shipping_cost,
          external_provider_requests: 0,
          real_shipments: 0,
          real_payments: 0,
        };
        await writeFile('docs/shopify-offers-qa.json', JSON.stringify(proof, null, 2) + '\n');
        console.log(JSON.stringify(proof));
      }
    }
    if (phase !== 'verify') await writeFile(file, JSON.stringify(d), { mode: 0o600 });
    if (phase === 'setup') console.log(JSON.stringify(d.fixture));
  }
} finally {
  await pool.end();
}
