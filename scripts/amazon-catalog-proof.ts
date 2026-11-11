// Own local QA firm only. No Amazon calls, real shipment, payment or external messages.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { setTimeout } from 'node:timers/promises';
const phase = process.argv[2],
  file = 'data/amazon-catalog-stage074.json';
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
      assert.equal((await api('/health')).schema_revision, '053_amazon_catalog');
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
      const email = 'qa-amazon-catalog@demo.local',
        password = 'DynaCatalog!2026';
      const signed = await api(
        '/auth/signup',
        'POST',
        {
          email,
          password,
          name: 'QA Amazon katalog 074',
          organization: { name: 'QA Amazon katalog 074', currency: 'PLN', locale: 'pl-PL' },
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
      if (phase === 'catalog') {
        const runs = (await api(`/integrations/${f.channel}/catalog-source-runs`)).data;
        assert.equal(runs.length, 1);
        f.run = runs[0].id;
        const data = await api(`/catalog-source-runs/${f.run}?limit=100`);
        assert.equal(data.run.state, 'ready');
        assert.equal(data.data.length, 4);
        assert(data.data.every((r: any) => r.state === 'applied'));
        const products = (await api('/products')).data;
        assert.equal(products.length, 4);
        const parent = products.find((p: any) => p.sku === 'AMAZON-DEMO-PARENT');
        assert.equal(parent.kind, 'group');
        assert.equal(
          products.filter((p: any) => p.parent_id === parent.id && p.kind === 'variant').length,
          2,
        );
        assert(products.every((p: any) => p.on_hand === 0 && p.reserved === 0));
        f.product = products.find((p: any) => p.sku === 'AMAZON-DEMO-SKU').id;
        f.sku = 'AMAZON-DEMO-SKU';
        state.catalog = {
          products: 4,
          variants: 2,
          source_availability: 8,
          physical_on_hand: 0,
          imported_via_ui: true,
        };
        await save();
        console.log(state.catalog);
      } else if (phase === 'refresh') {
        assert(!f.refresh_run);
        const run = await api(`/integrations/${f.channel}/catalog-source-runs`, 'POST', {
          client_key: randomUUID(),
          warehouse_id: f.warehouse,
          vat: 23,
        });
        f.refresh_run = run.id;
        await save();
        let data: any;
        for (let n = 0; n < 100; n++) {
          data = await api(`/catalog-source-runs/${run.id}?limit=100`);
          if (data.run.state !== 'queued') break;
          await setTimeout(100);
        }
        assert.equal(data.run.state, 'ready');
        assert.equal(data.data.length, 4);
        assert(data.data.every((r: any) => r.source.amazon.attributes.color));
        const result = await api(`/catalog-source-runs/${run.id}/apply`, 'POST', {
          items: data.data.map((r: any) => ({
            id: r.id,
            source_hash: r.source_hash,
            expected_product_id: r.candidate_id,
            expected_version: r.candidate_version,
          })),
        });
        assert.equal(result.created, 0);
        assert.equal(result.linked, 4);
        const product = (await api(`/products?search=${f.sku}`)).data.find(
          (p: any) => p.id === f.product,
        );
        assert.equal(product.price, 12345);
        assert.equal(product.on_hand, 10);
        assert.equal(product.reserved, 0);
        state.refresh = {
          structured_attributes_preserved: true,
          created: 0,
          linked: 4,
          physical_stock_unchanged: true,
          local_price_unchanged: true,
        };
        await save();
        console.log(state.refresh);
      } else if (phase === 'fulfill') {
        assert(!f.order);
        const supplier = await api(
          '/suppliers',
          'POST',
          { name: 'QA Dostawca lokalny', code: 'QA-AMAZON-074' },
          201,
        );
        let po = await api(
          '/purchase-orders',
          'POST',
          {
            supplier_id: supplier.id,
            warehouse_id: f.warehouse,
            lines: [{ product_id: f.product, quantity: 10, unit_cost: 6000 }],
            reference: 'QA-074 — dane syntetyczne',
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
        const inbound = (await api(`/integrations/${f.channel}/imports`)).data[0];
        let o = await api(`/imports/${inbound.id}/commit`, 'POST', {
          warehouse_id: f.warehouse,
          expected_hash: inbound.source_hash,
        });
        f.order = o.id;
        f.number = o.number;
        await save();
        assert.equal(o.total, 24690);
        assert.equal(o.status, 'new');
        assert.equal((await api(`/orders/${o.id}/payments`)).data.length, 0);
        await api(`/orders/${o.id}/payments`, 'POST', {
          client_key: randomUUID(),
          version: o.version,
          kind: 'receipt',
          amount: o.total,
          currency: o.currency,
          method: 'other',
          reference: 'QA-074-BEZ-PRZELEWU',
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
            reason: 'QA katalog Amazon 074',
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
          reference: 'QA-074-BEZ-PRZELEWU',
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
          stage: 74,
          goal_complete: false,
          verified_at: new Date().toISOString(),
          revision: (await api('/health')).revision,
          scope: 'local_simulation',
          migration: state.migration,
          catalog: state.catalog,
          refresh: state.refresh,
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
          'docs/amazon-catalog-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      }
    }
  }
} finally {
  await pool.end();
}
