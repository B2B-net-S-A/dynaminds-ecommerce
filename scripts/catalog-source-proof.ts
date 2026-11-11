// Local exercise, synthetic records only. Never outputs sessions or private buyer links.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2],
  path = 'data/catalog-source-stage018.json';
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
    assert.equal((await api('/health')).schema_revision, '017_offer_sync');
    const before = await snapshot();
    await writeFile(path, JSON.stringify({ before }, null, 2));
    console.log(
      JSON.stringify(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length]))),
    );
  } else {
    const d = JSON.parse(await readFile(path, 'utf8'));
    const health = await api('/health');
    assert.equal(health.schema_revision, '018_catalog_sources');
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
        (await pool.query("SELECT id FROM tenants WHERE name='QA Katalog 20261004'")).rowCount,
        0,
      );
      await login();
      const org = await api('/workspaces', 'POST', {
        name: 'QA Katalog 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      const w = (await api('/warehouses')).data[0];
      const ch = await api('/integrations/demo-import', 'POST', {});
      assert.equal((await api('/products')).data.length, 0);
      d.fixture = {
        tenant_id: org.user.tenant_id,
        organization: 'QA Katalog 20261004',
        warehouse_id: w.id,
        channel_id: ch.channel_id,
      };
      d.checkpoints = [];
      await writeFile(path, JSON.stringify(d, null, 2));
      console.log(JSON.stringify(d.fixture));
    } else {
      await login(d.fixture.tenant_id);
      if (phase === 'checkpoint') {
        const rows = await snapshot(),
          expectedReserved = Number(process.argv[3]),
          expectedRemote = Number(process.argv[4]);
        const products = rows.products.filter((x) => x.tenant_id === d.fixture.tenant_id);
        assert.equal(products.length, 4);
        const simple = products.find((x) => x.sku === 'DEMO-IMPORT')!;
        const group = products.find((x) => x.sku === 'DEMO-GROUP')!;
        assert.equal(group.kind, 'group');
        assert.equal(
          products.filter((x) => x.parent_id === group.id && x.kind === 'variant').length,
          2,
        );
        assert(!rows.stock.some((x) => x.product_id === group.id));
        const stock = rows.stock.find((x) => x.product_id === simple.id)!;
        assert.deepEqual([stock.on_hand, stock.reserved], [20, expectedReserved]);
        const listing = rows.listings.find((x) => x.product_id === simple.id)!;
        assert.equal(Number(listing.last_result.stock_quantity), expectedRemote);
        assert.equal(simple.price, 3167);
        assert.equal(listing.price, 3167);
        d.checkpoints.push({
          at: new Date().toISOString(),
          products,
          stock,
          listings: rows.listings.filter((x) => x.tenant_id === d.fixture.tenant_id),
        });
        await writeFile(path, JSON.stringify(d, null, 2));
        console.log(
          JSON.stringify({
            products: 4,
            parent_linked_variants: 2,
            stock: [20, expectedReserved],
            observed_offer_quantity: expectedRemote,
            checkpoints: d.checkpoints.length,
          }),
        );
      } else if (phase === 'fulfill') {
        const orders = (
          await pool.query('SELECT id FROM orders WHERE tenant_id=$1', [d.fixture.tenant_id])
        ).rows;
        assert.equal(orders.length, 1);
        let o = await api('/orders/' + orders[0].id);
        assert.equal(o.status, 'paid');
        assert.equal(o.total, 10001);
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
          reason: 'QA katalog — zwrot demonstracyjny',
          shipping_refund: o.shipping_cost,
          items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
        });
        r = await api('/returns/' + r.id + '/receive', 'POST', {
          version: r.version,
          shipping_refund: o.shipping_cost,
          note: 'QA lokalne przyjęcie',
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
          reference: 'QA-SYMULACJA-KATALOG-BEZ-PRZELEWU',
          confirmed: true,
        });
        console.log(
          JSON.stringify({
            demo_fulfillment_and_return: 1,
            real_payments: 0,
            provider_requests: 0,
          }),
        );
      } else if (phase === 'verify') {
        const after = await snapshot();
        for (const [k, prior] of Object.entries(d.before) as [string, any[]][])
          assert.deepEqual(
            after[k].filter((x) => x.tenant_id !== d.fixture.tenant_id),
            prior,
            'Changed prior ' + k,
          );
        const cfg = await api('/integrations/' + d.fixture.channel_id + '/offer-sync');
        assert.equal(cfg.config.enabled, false);
        assert.equal(cfg.data.length, 3);
        assert(cfg.data.every((x: any) => ['unchanged', 'verified'].includes(x.state) && !x.error));
        const products = after.products.filter((x) => x.tenant_id === d.fixture.tenant_id);
        assert.equal(products.length, 4);
        const stocks = after.stock.filter((x) => x.tenant_id === d.fixture.tenant_id);
        assert.equal(stocks.length, 3);
        assert.deepEqual(
          stocks.map((x) => x.on_hand).sort((a, b) => a - b),
          [6, 7, 20],
        );
        assert(stocks.every((x) => x.reserved === 0));
        const listings = after.listings.filter((x) => x.tenant_id === d.fixture.tenant_id);
        assert.equal(listings.length, 3);
        assert(listings.filter((x) => x.parent_external_id === '702').length === 2);
        assert.equal(
          Number(listings.find((x) => x.external_id === '701')!.last_result.stock_quantity),
          20,
        );
        const orders = after.orders.filter((x) => x.tenant_id === d.fixture.tenant_id);
        assert.equal(orders.length, 1);
        assert.equal(orders[0].status, 'return_completed');
        assert.equal(orders[0].total, 10001);
        const docs = after.documents.filter((x) => x.tenant_id === d.fixture.tenant_id);
        assert.deepEqual(
          docs.map((x) => Number(x.total)).sort((a, b) => a - b),
          [-10001, 10001],
        );
        assert(docs.every((x) => x.mode === 'demo' && x.currency === 'PLN'));
        const runs = (
          await pool.query(
            'SELECT id,state,fetched,context,cursor,import_stock FROM catalog_source_runs WHERE tenant_id=$1 ORDER BY created_at,id',
            [d.fixture.tenant_id],
          )
        ).rows;
        assert.equal(runs.length, 2);
        assert(runs.every((x) => x.state === 'ready' && x.fetched === 4));
        const entries = (
          await pool.query(
            'SELECT run_id,external_id,parent_external_id,kind,state,result FROM catalog_source_items WHERE tenant_id=$1 ORDER BY run_id,external_id',
            [d.fixture.tenant_id],
          )
        ).rows;
        assert.equal(entries.length, 8);
        assert(entries.every((x) => x.state === 'applied'));
        assert.equal(entries.filter((x) => x.result.action === 'created').length, 4);
        assert.equal(entries.filter((x) => x.result.action === 'linked').length, 4);
        const plans = (
          await pool.query(
            'SELECT id,state,phase,sync_version,payload,result FROM offer_plans WHERE tenant_id=$1 ORDER BY created_at,id',
            [d.fixture.tenant_id],
          )
        ).rows;
        assert(plans.every((x) => x.state === 'done' && x.result.scope === 'local_simulation'));
        assert(plans.some((x) => x.payload.stock_quantity === 17 && x.result.desired_applied));
        assert(plans.some((x) => x.payload.stock_quantity === 20 && x.result.desired_applied));
        assert(d.checkpoints.length >= 4);
        const report = {
          stage: '018_catalog_sources',
          health,
          migration: d.migration,
          fixture: d.fixture,
          preserved_prior_rows: d.migration.counts,
          checkpoints: d.checkpoints,
          products,
          stock: stocks,
          listings,
          orders,
          documents: docs,
          source_runs: runs,
          source_entries: entries,
          offer_plans: plans,
          final_configuration: { enabled: cfg.config.enabled, version: cfg.config.version },
          final_sync_items: cfg.data,
          provider_confirmation: false,
          real_payments: 0,
        };
        await writeFile(
          process.env.PROOF_OUTPUT ?? 'docs/catalog-source-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(
          JSON.stringify({
            preserved_prior_data: true,
            products: 4,
            groups: 1,
            variants: 2,
            source_entries: 8,
            imported_order_and_return: 10001,
            offer_quantities: [17, 20],
            schedule_enabled: false,
          }),
        );
      } else throw Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
