// Own local QA firm only. No Amazon calls, real shipment, payment or external messages.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { setTimeout } from 'node:timers/promises';
const phase = process.argv[2],
  file = 'data/amazon-catalog-stage075.json';
const tables = [
  'products',
  'stock',
  'orders',
  'order_items',
  'reservations',
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
async function api(path: string, method = 'GET', payload?: any, status = 200): Promise<any> {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
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
    console.log({ baseline_tenants: tenants.length, tables: tables.length });
  } else {
    const state = JSON.parse(await readFile(file, 'utf8'));
    const save = () => writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    if (phase === 'migrated') {
      assert.equal((await api('/health')).schema_revision, '054_amazon_offers');
      assert.deepEqual(await fingerprints(state.tenants), state.before);
      state.migration = {
        previous_firms: state.tenants.length,
        business_tables: tables.length,
        unchanged: true,
      };
      await save();
      console.log(state.migration);
    } else if (phase === 'setup') {
      assert(!state.fixture);
      const email = 'qa-amazon-offers@demo.local',
        password = 'DynaOffers!2026';
      const signed = await api(
        '/auth/signup',
        'POST',
        {
          email,
          password,
          name: 'QA Amazon oferty 075',
          organization: { name: 'QA Amazon oferty 075', currency: 'PLN', locale: 'pl-PL' },
        },
        201,
      );
      const f: any = (state.fixture = {
        email,
        password,
        tenant: signed.user.tenant_id,
        user: signed.user.id,
      });
      await save();
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/amazon-example', 'POST', {})).channel_id;
      await save();
      console.log({
        scope: 'local_simulation',
        tenant: f.tenant,
        channel: f.channel,
        products: (await api('/products')).data.length,
      });
    } else {
      const f = state.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: f.password });
      if (phase === 'prepare') {
        assert(!f.product);
        const run = await api(`/integrations/${f.channel}/catalog-source-runs`, 'POST', {
          client_key: randomUUID(),
          warehouse_id: f.warehouse,
          vat: 23,
        });
        f.run = run.id;
        await save();
        let data: any;
        for (let n = 0; n < 100; n++) {
          data = await api(`/catalog-source-runs/${run.id}?limit=100`);
          if (data.run.state !== 'queued') break;
          await setTimeout(100);
        }
        assert.equal(data.run.state, 'ready');
        await api(`/catalog-source-runs/${run.id}/apply`, 'POST', {
          items: data.data.map((r: any) => ({
            id: r.id,
            source_hash: r.source_hash,
            expected_product_id: r.candidate_id,
            expected_version: r.candidate_version,
          })),
        });
        const product = (await api('/products?search=AMAZON-DEMO-SKU')).data.find(
          (p: any) => p.sku === 'AMAZON-DEMO-SKU',
        );
        f.product = product.id;
        f.sku = product.sku;
        await api(`/products/${product.id}`, 'PATCH', {
          version: product.version,
          name: product.name,
          price: 15001,
          vat: 23,
        });
        const supplier = await api(
          '/suppliers',
          'POST',
          { name: 'QA Dostawca 075', code: 'QA-AMAZON-075' },
          201,
        );
        let po = await api(
          '/purchase-orders',
          'POST',
          {
            supplier_id: supplier.id,
            warehouse_id: f.warehouse,
            lines: [{ product_id: f.product, quantity: 10, unit_cost: 6000 }],
            reference: 'QA-075 — dane syntetyczne',
          },
          201,
        );
        po = await api(`/purchase-orders/${po.id}/place`, 'POST', { version: po.version });
        await api(`/purchase-orders/${po.id}/receive`, 'POST', {
          version: po.version,
          client_key: randomUUID(),
          lines: [{ product_id: f.product, quantity: 10, location: 'A-01' }],
        });
        f.purchase_order = po.id;
        await save();
        console.log({
          prepared: true,
          physical_quantity: 10,
          local_price: 15001,
          external_availability: 8,
          external_writes: 0,
        });
      } else if (phase === 'before') {
        const plans = (await api(`/integrations/${f.channel}/offers`)).data.filter(
          (p: any) => p.product_id === f.product && p.state === 'done',
        );
        assert.equal(plans.length, 1);
        assert.equal(plans[0].result.scope, 'local_simulation');
        assert.equal(plans[0].result.actual_snapshot.stock_quantity, 10);
        assert.equal(plans[0].result.actual_snapshot.base_price_minor, 15001);
        f.initial_plan = plans[0].id;
        const inbound = (await api(`/integrations/${f.channel}/imports`)).data[0];
        const o = await api(`/imports/${inbound.id}/commit`, 'POST', {
          warehouse_id: f.warehouse,
          expected_hash: inbound.source_hash,
        });
        f.order = o.id;
        f.number = o.number;
        await save();
        assert.equal(o.total, 24690);
        console.log({
          initial_offer_verified: true,
          reserved_quantity: 2,
          available_quantity: 8,
          order_total: o.total,
        });
      } else if (phase === 'reserved') {
        const plans = (await api(`/integrations/${f.channel}/offers`)).data.filter(
          (p: any) => p.product_id === f.product && p.state === 'done',
        );
        assert.equal(plans.length, 2);
        assert(plans.some((p: any) => p.result.actual_snapshot?.stock_quantity === 8));
        const cfg = await api(`/integrations/${f.channel}/offer-sync`);
        f.sync_version = cfg.config.version;
        await save();
        console.log({ scheduled_reservation_verified: true, plans: 2, available_quantity: 8 });
      } else if (phase === 'finish') {
        const cfg = await api(`/integrations/${f.channel}/offer-sync`);
        const job = await api(`/integrations/${f.channel}/offer-sync`, 'POST', {});
        for (let n = 0; n < 200; n++) {
          const plans = (await api(`/integrations/${f.channel}/offers`)).data.filter(
            (p: any) => p.product_id === f.product && p.state === 'done',
          );
          if (
            plans.length >= 3 &&
            plans.some(
              (p: any) => p.result.actual_snapshot?.stock_quantity === 10 && p.sync_version,
            )
          ) {
            f.final_plan = plans.find(
              (p: any) => p.sync_version && p.result.actual_snapshot?.stock_quantity === 10,
            ).id;
            break;
          }
          await setTimeout(100);
        }
        assert(f.final_plan);
        const cfgNow = (await api(`/integrations/${f.channel}/offer-sync`)).config;
        await api(`/integrations/${f.channel}/offer-sync`, 'PATCH', {
          version: cfgNow.version,
          enabled: false,
          warehouse_id: f.warehouse,
          stock: true,
          price: true,
          interval_seconds: 30,
          verify_seconds: 60,
        });
        await save();
        console.log({ restock_synchronized: true, schedule_disabled: true, job: job.id });
      } else if (phase === 'fulfill') {
        let o = await api(`/orders/${f.order}`);
        assert.equal(o.status, 'new');
        assert.equal((await api(`/orders/${o.id}/payments`)).data.length, 0);
        await api(`/orders/${o.id}/payments`, 'POST', {
          client_key: randomUUID(),
          version: o.version,
          kind: 'receipt',
          amount: o.total,
          currency: o.currency,
          method: 'other',
          reference: 'QA-075-BEZ-PRZELEWU',
          note: 'Syntetyczna deklaracja QA; bez przepływu pieniędzy',
          confirmed: true,
        });
        await api(`/orders/${o.id}/status`, 'PATCH', { status: 'picking' });
        for (let n = 0; n < 2; n++) await api(`/orders/${o.id}/scan`, 'POST', { code: f.sku });
        await api(`/orders/${o.id}/status`, 'PATCH', { status: 'packed' });
        await api(`/orders/${o.id}/ship-demo`, 'POST', {});
        f.document = (await api(`/orders/${o.id}/documents`, 'POST', { kind: 'invoice' })).id;
        await save();
        o = await api(`/orders/${o.id}`);
        let r = await api(
          `/orders/${o.id}/returns`,
          'POST',
          {
            client_key: randomUUID(),
            reason: 'QA katalog Amazon 075',
            shipping_refund: o.shipping_cost,
            items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
          },
          201,
        );
        f.return_id = r.id;
        await save();
        await api(`/returns/${r.id}/receive`, 'POST', {
          version: r.version,
          shipping_refund: o.shipping_cost,
          items: r.items.map((i: any) => ({
            item_id: i.item_id,
            accepted: i.requested,
            restocked: i.requested,
          })),
          note: 'QA lokalne przyjęcie',
        });
        await api(`/returns/${r.id}/document`, 'POST', {});
        r = await api(`/returns/${r.id}`);
        await api(`/returns/${r.id}/refund`, 'POST', {
          version: r.version,
          amount: o.total,
          reference: 'QA-075-BEZ-PRZELEWU',
          confirmed: true,
        });
        console.log({ full_demo_process: true, real_money_moved: 0, external_writes: 0 });
      } else if (phase === 'verify') {
        const order = await api(`/orders/${f.order}`),
          ret = await api(`/returns/${f.return_id}`);
        const stock = (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [f.tenant, f.product],
          )
        ).rows[0];
        assert.equal(order.status, 'return_completed');
        assert.equal(ret.state, 'closed');
        assert.deepEqual(stock, { on_hand: 10, reserved: 0 });
        assert.deepEqual(await fingerprints(state.tenants), state.before);
        const report = {
          stage: 75,
          goal_complete: false,
          verified_at: new Date().toISOString(),
          revision: (await api('/health')).revision,
          scope: 'local_simulation',
          migration: state.migration,
          offers: {
            initial_plan: f.initial_plan,
            final_plan: f.final_plan,
            base_price_minor: 15001,
            initial_available: 10,
            reserved_available: 8,
            restored_available: 10,
            scheduled: true,
          },
          full_process: {
            order_status: order.status,
            total_minor: order.total,
            stock,
            purchase_receipt: true,
            synthetic_payment_and_refund: true,
          },
          previous_firms_unchanged: state.tenants.length,
          business_tables_unchanged: tables.length,
          authenticated_amazon_api_verified: false,
        };
        await writeFile(
          'docs/amazon-offers-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      }
    }
  }
} finally {
  await pool.end();
}
