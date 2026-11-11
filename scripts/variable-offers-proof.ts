// Local variable catalogue exercise, synthetic records only. Never outputs sessions or private buyer links.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2],
  path = 'data/variable-offers-stage019.json';
async function snapshot() {
  const queries = {
    orders: 'SELECT id,tenant_id,number,status,total,currency FROM orders ORDER BY id',
    items:
      'SELECT id,tenant_id,order_id,product_id,quantity,price,line_total,scanned FROM order_items ORDER BY id',
    products:
      'SELECT id,tenant_id,sku,kind,parent_id,price,version,attributes FROM products ORDER BY id',
    stock:
      'SELECT tenant_id,product_id,warehouse_id,on_hand,reserved FROM stock ORDER BY tenant_id,product_id,warehouse_id',
    documents:
      "SELECT id,tenant_id,order_id,number,kind,mode,data->>'total' AS total,data->>'currency' AS currency FROM documents ORDER BY id",
    cases: 'SELECT id,tenant_id,order_id,state,refund_amount,version FROM return_cases ORDER BY id',
    movements: 'SELECT id,tenant_id,product_id,delta FROM stock_movements ORDER BY id',
    listings:
      'SELECT id,tenant_id,product_id,external_id,parent_external_id,warehouse_id,price,price_currency,status,last_result FROM listings ORDER BY id',
    price_lists: 'SELECT id,tenant_id,name,version,active FROM price_lists ORDER BY id',
    price_items:
      'SELECT tenant_id,price_list_id,product_id,price FROM price_list_items ORDER BY tenant_id,price_list_id,product_id',
    offer_plans: 'SELECT id,tenant_id,state,phase,result FROM offer_plans ORDER BY id',
    sync_configs:
      'SELECT tenant_id,channel_id,enabled,version,warehouse_id,price_list_id,next_run_at,last_run_at FROM offer_sync_configs ORDER BY tenant_id,channel_id',
    catalog_runs: 'SELECT id,tenant_id,state,fetched,cursor FROM catalog_source_runs ORDER BY id',
    catalog_items:
      'SELECT id,tenant_id,run_id,state,product_id FROM catalog_source_items ORDER BY id',
    sync_items:
      'SELECT tenant_id,channel_id,listing_id,state,desired_hash,verified_hash,last_checked_at,plan_id,plan_acknowledged FROM offer_sync_items ORDER BY tenant_id,channel_id,listing_id',
  };
  const out: Record<string, any[]> = {};
  for (const [k, q] of Object.entries(queries)) out[k] = (await pool.query(q)).rows;
  return JSON.parse(JSON.stringify(out)) as Record<string, any[]>;
}
let cookie = '';
async function api(url: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert(r.ok, `${method} ${url}: ${r.status}`);
  return d;
}
async function login(tenant?: string) {
  await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
  if (tenant) await api('/workspaces/switch', 'POST', { tenant_id: tenant });
}
try {
  if (phase === 'baseline') {
    assert.equal((await api('/health')).schema_revision, '018_catalog_sources');
    const before = await snapshot();
    await writeFile(path, JSON.stringify({ before }, null, 2));
    console.log(
      JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length]))),
    );
  } else {
    const d = JSON.parse(await readFile(path, 'utf8'));
    const health = await api('/health');
    assert.equal(health.schema_revision, '019_variable_offers');
    if (phase === 'migrated') {
      assert.deepEqual(await snapshot(), d.before);
      d.migration = {
        unchanged_business_snapshot: true,
        counts: Object.fromEntries(Object.entries(d.before).map(([k, v]: any) => [k, v.length])),
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.migration));
    } else if (phase === 'setup') {
      assert(!d.fixture);
      assert.equal(
        (await pool.query("SELECT id FROM tenants WHERE name='QA Warianty 20261004'")).rowCount,
        0,
      );
      await login();
      const org = await api('/workspaces', 'POST', {
        name: 'QA Warianty 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      const warehouse = (await api('/warehouses')).data[0].id;
      const channel = { id: (await api('/integrations/demo-import', 'POST', {})).channel_id };
      await pool.query('UPDATE channels SET name=$2 WHERE id=$1', [
        channel.id,
        'WooCommerce Warianty QA',
      ]);
      const group = await api('/products', 'POST', {
        sku: 'QA-VAR-GROUP-20261004',
        name: 'Koszulka · grupa QA',
        kind: 'group',
        price: 0,
        vat: 23,
        quantity: 0,
        warehouse_id: warehouse,
        attributes: { Materiał: 'Bawełna' },
        description: 'Lokalna grupa QA: kolory i rozmiary.',
      });
      const variants = [];
      for (const [color, size, price] of [
        ['Niebieski', 'M', 24900],
        ['Niebieski', 'L', 25900],
        ['Czerwony', 'M', 26900],
        ['Czerwony', 'L', 27900],
      ] as const)
        variants.push(
          await api('/products', 'POST', {
            sku: `QA-VAR-${color === 'Niebieski' ? 'BLUE' : 'RED'}-${size}-20261004`,
            name: `Koszulka ${color} ${size} QA`,
            kind: 'variant',
            parent_id: group.id,
            attributes: { Kolor: color, Rozmiar: size },
            price,
            vat: 23,
            quantity: 12,
            warehouse_id: warehouse,
            description: 'Wariant demonstracyjny QA.',
          }),
        );
      d.fixture = {
        tenant_id: org.user.tenant_id,
        warehouse_id: warehouse,
        channel_id: channel.id,
        group_id: group.id,
        variant_ids: variants.map((v) => v.id),
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.fixture));
    } else if (phase === 'order') {
      const f = d.fixture;
      assert(f);
      assert(!d.order_id);
      await login(f.tenant_id);
      const o = await api('/orders', 'POST', {
        customer_name: 'Klient QA Warianty',
        email: 'qa-variants@example.invalid',
        warehouse_id: f.warehouse_id,
        source: 'woocommerce',
        items: [
          { product_id: f.variant_ids[0], quantity: 2 },
          { product_id: f.variant_ids[3], quantity: 1 },
        ],
      });
      assert.equal(o.total, 77700);
      d.order_id = o.id;
      await writeFile(path, JSON.stringify(d, null, 2));
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'paid' });
      await api('/integrations/' + f.channel_id + '/offer-sync', 'PATCH', {
        version: 0,
        enabled: true,
        warehouse_id: f.warehouse_id,
        stock: true,
        price: true,
        interval_seconds: 30,
        verify_seconds: 60,
      });
      await api('/integrations/' + f.channel_id + '/offer-sync', 'POST', {});
      for (let n = 0; n < 40; n++) {
        const rows = (
          await pool.query('SELECT product_id,last_result FROM listings WHERE tenant_id=$1', [
            f.tenant_id,
          ])
        ).rows;
        if (
          rows.find((l) => l.product_id === f.variant_ids[0])?.last_result.stock_quantity === 10 &&
          rows.find((l) => l.product_id === f.variant_ids[3])?.last_result.stock_quantity === 11
        )
          break;
        assert(n < 39, 'Worker did not sync reserved quantity');
        await setTimeout(250);
      }
      const stock = (
        await pool.query(
          'SELECT product_id,on_hand,reserved FROM stock WHERE tenant_id=$1 ORDER BY product_id',
          [f.tenant_id],
        )
      ).rows;
      assert.deepEqual(
        stock.find((v) => v.product_id === f.variant_ids[0]),
        { product_id: f.variant_ids[0], on_hand: 12, reserved: 2 },
      );
      assert.deepEqual(
        stock.find((v) => v.product_id === f.variant_ids[3]),
        { product_id: f.variant_ids[3], on_hand: 12, reserved: 1 },
      );
      d.reservation = { order_id: o.id, total: o.total, stock };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(
        JSON.stringify({
          order: o.number,
          total: o.total,
          ordered_variants: 2,
          offer_quantities: [10, 11],
        }),
      );
    } else if (phase === 'fulfill') {
      const f = d.fixture;
      assert(d.order_id);
      assert(!d.fulfillment);
      await login(f.tenant_id);
      let o = await api('/orders/' + d.order_id);
      assert.equal(o.status, 'paid');
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
      o = await api('/orders/' + o.id);
      for (const i of o.picking_items)
        for (let n = 0; n < i.quantity; n++)
          await api('/orders/' + o.id + '/scan', 'POST', { code: i.sku });
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
      await api('/orders/' + o.id + '/ship-demo', 'POST', {});
      await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
      const outbound = (
        await pool.query(
          'SELECT product_id,on_hand,reserved FROM stock WHERE tenant_id=$1 ORDER BY product_id',
          [f.tenant_id],
        )
      ).rows;
      assert.equal(outbound.find((v) => v.product_id === f.variant_ids[0]).on_hand, 10);
      assert.equal(outbound.find((v) => v.product_id === f.variant_ids[3]).on_hand, 11);
      assert(outbound.every((v) => v.reserved === 0));
      let r = await api('/orders/' + o.id + '/returns', 'POST', {
        client_key: randomUUID(),
        reason: 'QA warianty — zwrot demonstracyjny',
        shipping_refund: 0,
        items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
      });
      r = await api('/returns/' + r.id + '/receive', 'POST', {
        version: r.version,
        shipping_refund: 0,
        note: 'QA przyjęcie wariantów',
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
        reference: 'QA-SYMULACJA-WARIANTY-BEZ-PRZELEWU',
        confirmed: true,
      });
      await api('/integrations/' + f.channel_id + '/offer-sync', 'POST', {});
      let acknowledgmentRequested = false;
      for (let n = 0; n < 40; n++) {
        const cfg = await api('/integrations/' + f.channel_id + '/offer-sync');
        const rows = (
          await pool.query(
            'SELECT product_id,last_result FROM listings WHERE tenant_id=$1 AND parent_external_id IS NOT NULL',
            [f.tenant_id],
          )
        ).rows;
        if (
          rows.length === 4 &&
          rows.every((l) => l.last_result.stock_quantity === 12) &&
          cfg.data.length === 4 &&
          cfg.data.every((i: any) => ['verified', 'unchanged'].includes(i.state))
        )
          break;
        if (
          rows.length === 4 &&
          rows.every((l) => l.last_result.stock_quantity === 12) &&
          !acknowledgmentRequested
        ) {
          await api('/integrations/' + f.channel_id + '/offer-sync', 'POST', {});
          acknowledgmentRequested = true;
        }
        assert(n < 39, 'Worker did not restore offer quantity');
        await setTimeout(250);
      }
      const cfg = (await api('/integrations/' + f.channel_id + '/offer-sync')).config;
      await api('/integrations/' + f.channel_id + '/offer-sync', 'PATCH', {
        version: cfg.version,
        enabled: false,
        warehouse_id: f.warehouse_id,
        stock: true,
        price: true,
        interval_seconds: 30,
        verify_seconds: 60,
      });
      d.fulfillment = {
        demo_shipment: true,
        scans: 3,
        order_id: o.id,
        return_id: r.id,
        outbound,
        manual_refund_synthetic: true,
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(
        JSON.stringify({
          demo_fulfillment: true,
          total: o.total,
          return_received: 3,
          offers_restored_to: 12,
          real_payments: 0,
        }),
      );
    } else if (phase === 'settle') {
      const f = d.fixture;
      assert(d.order_id);
      await login(f.tenant_id);
      const o = await api('/orders/' + d.order_id);
      assert.equal(o.status, 'return_completed');
      assert.equal(o.total, 77700);
      await api('/integrations/' + f.channel_id + '/offer-sync', 'POST', {});
      for (let n = 0; n < 40; n++) {
        const cfg = await api('/integrations/' + f.channel_id + '/offer-sync');
        if (
          cfg.data.length === 4 &&
          cfg.data.every((i: any) => ['verified', 'unchanged'].includes(i.state))
        )
          break;
        assert(n < 39, 'Coordinator did not acknowledge confirmed writes');
        await setTimeout(250);
      }
      const cfg = (await api('/integrations/' + f.channel_id + '/offer-sync')).config;
      assert(cfg.enabled);
      await api('/integrations/' + f.channel_id + '/offer-sync', 'PATCH', {
        version: cfg.version,
        enabled: false,
        warehouse_id: f.warehouse_id,
        stock: true,
        price: true,
        interval_seconds: 30,
        verify_seconds: 60,
      });
      const movements = (
        await pool.query(
          'SELECT product_id,delta FROM stock_movements WHERE tenant_id=$1 ORDER BY created_at,id',
          [f.tenant_id],
        )
      ).rows;
      const cases = (
        await pool.query('SELECT id,state,refund_amount FROM return_cases WHERE tenant_id=$1', [
          f.tenant_id,
        ])
      ).rows;
      assert.equal(cases.length, 1);
      assert.equal(cases[0].state, 'closed');
      assert.equal(cases[0].refund_amount, 77700);
      assert.equal(
        o.picking_items.reduce((n: number, i: any) => n + i.scanned, 0),
        3,
      );
      d.fulfillment = {
        demo_shipment: true,
        scans: 3,
        order_id: o.id,
        return_id: cases[0].id,
        movements,
        manual_refund_synthetic: true,
      };
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(
        JSON.stringify({
          order: o.number,
          total: o.total,
          stock_moves: movements.length,
          final_sync_paused: true,
          real_payments: 0,
        }),
      );
    } else if (phase === 'verify') {
      const f = d.fixture;
      assert(f);
      const current = await snapshot();
      for (const [key, rows] of Object.entries(d.before) as [string, any[]][])
        assert.deepEqual(
          current[key].filter((v: any) => v.tenant_id !== f.tenant_id),
          rows,
          key + ' preservation',
        );
      const plans = (
        await pool.query(
          'SELECT id,operation,state,phase,remote_id,result FROM offer_plans WHERE tenant_id=$1 ORDER BY created_at,id',
          [f.tenant_id],
        )
      ).rows;
      const batches = (
        await pool.query(
          'SELECT id,state,input,version FROM variant_offer_batches WHERE tenant_id=$1 ORDER BY created_at,id',
          [f.tenant_id],
        )
      ).rows;
      assert.equal(batches.length, 2);
      assert(batches.every((b) => b.state === 'done'));
      assert.equal(plans.filter((p) => p.operation !== 'sync').length, 10);
      assert(plans.filter((p) => p.operation === 'sync').length >= 4);
      assert(
        plans.every(
          (p) =>
            p.state === 'done' && p.result.scope === 'local_simulation' && p.result.desired_applied,
        ),
      );
      const listings = (
        await pool.query(
          'SELECT product_id,external_id,parent_external_id,last_result FROM listings WHERE tenant_id=$1 ORDER BY product_id',
          [f.tenant_id],
        )
      ).rows;
      assert.equal(listings.length, 5);
      const parent = listings.find((l) => l.product_id === f.group_id);
      assert(parent);
      assert.equal(parent.last_result.type, 'variable');
      assert.equal(parent.last_result.status, 'publish');
      assert(
        listings
          .filter((l) => l.product_id !== f.group_id)
          .every(
            (l) =>
              l.parent_external_id === parent.external_id && l.last_result.status === 'publish',
          ),
      );
      const stock = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1', [f.tenant_id])
      ).rows;
      assert.equal(stock.length, 4);
      assert(stock.every((v) => v.on_hand === 12 && v.reserved === 0));
      const rls = (
        await pool.query(
          "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('variant_offer_batches','variant_offer_batch_items')",
        )
      ).rows;
      assert(rls.every((t) => t.relrowsecurity && t.relforcerowsecurity));
      const orders = current.orders.filter((v) => v.tenant_id === f.tenant_id);
      assert.equal(orders.length, 1);
      assert.equal(orders[0].status, 'return_completed');
      assert.equal(orders[0].total, 77700);
      const documents = current.documents.filter((v) => v.tenant_id === f.tenant_id);
      assert.deepEqual(
        documents.map((v) => Number(v.total)).sort((a, b) => a - b),
        [-77700, 77700],
      );
      assert(documents.every((v) => v.mode === 'demo'));
      const cfg = (
        await pool.query('SELECT enabled,version FROM offer_sync_configs WHERE tenant_id=$1', [
          f.tenant_id,
        ])
      ).rows[0];
      assert.equal(cfg.enabled, false);
      const sync = (
        await pool.query('SELECT listing_id,state,error FROM offer_sync_items WHERE tenant_id=$1', [
          f.tenant_id,
        ])
      ).rows;
      assert.equal(sync.length, 4);
      assert(sync.every((v) => ['unchanged', 'verified'].includes(v.state) && !v.error));
      const proof = {
        orders,
        documents,
        final_sync_config: cfg,
        final_sync_items: sync,
        reservation: d.reservation,
        fulfillment: d.fulfillment,
        health,
        scope: 'local_simulation',
        external_provider_account_verified: false,
        previous_business_rows_preserved: true,
        migration: d.migration,
        fixture: f,
        plans,
        batches,
        listings,
        stock,
        rls,
      };
      await writeFile(
        process.env.PROOF_OUTPUT ?? 'data/variable-offers-native-proof.json',
        JSON.stringify(proof, null, 2),
      );
      console.log(
        JSON.stringify({
          schema: health.schema_revision,
          revision: health.revision,
          plans: plans.length,
          batches: batches.length,
          listings: listings.length,
          previous_business_rows_preserved: true,
        }),
      );
    } else throw Error('Unknown phase');
  }
} finally {
  await pool.end();
}
