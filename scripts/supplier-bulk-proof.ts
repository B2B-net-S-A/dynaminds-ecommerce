// Isolated synthetic organization on native local runtime; no provider requests.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/supplier-bulk-stage038.json',
  email = 'qa-bigbuy-bulk@demo.local',
  password = 'DynaDemo!2026';
const tables = [
  ...Object.keys(JSON.parse(await readFile('data/supplier-catalog-stage037.json', 'utf8')).before),
  'supplier_sources',
  'supplier_catalog_reads',
  'supplier_catalog_items',
  'supplier_catalog_purchases',
];
let state: any,
  cookie = '';
async function fingerprint(tenants: string[]) {
  const out: any = {};
  for (const table of tables) {
    assert(/^[a-z_]+$/.test(table));
    const rows = (
      await pool.query(
        'SELECT ' +
          (table === 'supplier_catalog_items' ? "(to_jsonb(t)-'bulk_run_id')" : 'to_jsonb(t)') +
          '::text row FROM ' +
          table +
          ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
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
const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
async function api(path: string, method = 'GET', body?: any, key?: string, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, expected, path + ': ' + JSON.stringify(d));
  return d;
}
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    assert(!(await pool.query("SELECT 1 FROM migrations WHERE name='031_supplier_bulk'")).rowCount);
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    state = { tenants, before: await fingerprint(tenants) };
    await save();
    console.log(JSON.stringify({ old_tenants: tenants.length, business_tables: tables.length }));
  } else {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup' && !state.fixture) {
      await api(
        '/auth/signup',
        'POST',
        {
          email,
          password,
          name: 'QA BigBuy masowy',
          organization: { name: 'QA BigBuy masowy 20261004' },
        },
        undefined,
        201,
      );
      const me = (await api('/auth/me')).user;
      assert.equal(me.tenant_name, 'QA BigBuy masowy 20261004');
      state.fixture = { tenant: me.tenant_id, warehouse: (await api('/warehouses')).data[0].id };
      await save();
    } else await api('/auth/login', 'POST', { email, password });
    const f = state.fixture;
    if (phase === 'zero') {
      const product = (await api('/products?q=LOCAL-BB-1000')).data.find(
        (p: any) => p.sku === 'LOCAL-BB-1000',
      );
      assert(product);
      const stock = (await api('/inventory?product_id=' + product.id)).data[0];
      assert.equal(stock.on_hand, 0);
      assert.equal(product.price, 5000);
      state.zero_stock_verified = true;
      await save();
      console.log(JSON.stringify({ product: product.id, stock_before_receipt: 0, price: 5000 }));
    }
    if (phase === 'setup') {
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      if (!f.supplier) {
        f.supplier = (
          await api('/suppliers', 'POST', { name: 'BigBuy QA', code: 'BB-QA' }, undefined, 201)
        ).id;
        await save();
      }
      console.log(JSON.stringify(f));
    }
    if (phase === 'verify' || phase === 'fulfill' || phase === 'runtime') {
      const sources = (await api('/supplier-sources')).data;
      assert.equal(sources.length, 1);
      f.source = sources[0].id;
      const items: any[] = [];
      let cursor: string | null = null;
      do {
        const page = await api(
          '/supplier-catalog?source_id=' +
            f.source +
            '&limit=25' +
            (cursor ? '&after=' + cursor : ''),
        );
        items.push(...page.data);
        cursor = page.meta.cursor;
      } while (cursor);
      assert.equal(new Set(items.map((i) => i.id)).size, 107);
      assert.equal(items.length, 107);
      const runs = (await api('/supplier-bulk-runs?source_id=' + f.source)).data;
      assert.equal(runs.length, 1);
      f.bulk = runs[0].id;
      assert.equal(runs[0].state, 'success');
      assert.equal(runs[0].published, 107);
      assert.equal(runs[0].rejected, 0);
      const simple = items.find((i: any) => i.sku === 'BB-1000'),
        variant = items.find((i: any) => i.sku === 'BB-V-303');
      assert(simple && variant);
      assert(simple.snapshot.simulation);
      assert.equal(simple.snapshot.quantity, 8);
      assert.equal(variant.snapshot.unit_cost, 1550);
      f.product = simple.product_id;
      assert(f.product);
      const purchases = (await api('/purchase-orders')).data;
      assert.equal(purchases.length, 1);
      const po = await api('/purchase-orders/' + purchases[0].id);
      f.purchase = po.id;
      assert.equal(po.currency, 'EUR');
      assert.equal(po.lines[0].quantity, 5);
      assert.equal(po.lines[0].unit_cost, 1100);
      assert.equal(po.state, 'received');
      assert.equal(po.receipts.length, 2);
      assert.equal((await api('/products/' + f.product)).price, 5000);
      if (phase === 'fulfill') {
        if (!f.order) {
          const body = {
            customer_name: 'QA zakup BigBuy',
            email: 'bigbuy-qa@example.test',
            warehouse_id: f.warehouse,
            items: [{ product_id: f.product, quantity: 2 }],
          };
          const created = await api('/orders', 'POST', body, 'bigbuy-bulk-stage038-sale', 201);
          const replay = await api('/orders', 'POST', body, 'bigbuy-bulk-stage038-sale');
          assert.equal(replay.id, created.id);
          f.order = created.id;
          await save();
        }
        let order = await api('/orders/' + f.order);
        if (order.status === 'new')
          await api('/orders/' + f.order + '/status', 'PATCH', { status: 'paid' });
        order = await api('/orders/' + f.order);
        if (order.status === 'paid')
          await api('/orders/' + f.order + '/status', 'PATCH', { status: 'picking' });
        order = await api('/orders/' + f.order);
        if (order.status === 'picking') {
          for (const i of order.picking_items)
            for (let n = i.scanned; n < i.quantity; n++)
              await api('/orders/' + order.id + '/scan', 'POST', { code: 'LOCAL-BB-1000' });
          await api('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
        }
        order = await api('/orders/' + f.order);
        if (order.status === 'packed') await api('/orders/' + order.id + '/ship-demo', 'POST', {});
        order = await api('/orders/' + f.order);
        if (!order.documents.some((d: any) => d.kind === 'invoice'))
          await api('/orders/' + order.id + '/documents', 'POST', { kind: 'invoice' });
        let r = (await api('/orders/' + order.id + '/returns')).cases[0];
        if (!r)
          r = await api(
            '/orders/' + order.id + '/returns',
            'POST',
            {
              client_key: randomUUID(),
              reason: 'QA lokalne przyjęcie BigBuy',
              items: order.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
            },
            undefined,
            201,
          );
        else r = await api('/returns/' + r.id);
        if (r.state === 'requested')
          r = await api('/returns/' + r.id + '/receive', 'POST', {
            version: r.version,
            note: 'QA dostawa i zwrot',
            items: r.items.map((i: any) => ({
              item_id: i.item_id,
              accepted: i.requested,
              restocked: i.requested,
            })),
          });
        await api('/returns/' + r.id + '/document', 'POST', {});
        if (r.state === 'refund_pending')
          await api('/returns/' + r.id + '/refund', 'POST', {
            version: r.version,
            amount: order.total,
            reference: 'QA-BEZ-PRZELEWU',
            confirmed: true,
          });
        f.return = r.id;
        await save();
      }
      const stock = (await api('/inventory?product_id=' + f.product)).data[0];
      assert.equal(stock.on_hand, 5);
      assert.equal(stock.reserved, 0);
      if (f.order) assert.equal((await api('/orders/' + f.order)).status, 'return_completed');
      assert.deepEqual(await fingerprint(state.tenants), state.before);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM supplier_catalog_items WHERE tenant_id=ANY($1::uuid[]) AND bulk_run_id IS NOT NULL',
            [state.tenants],
          )
        ).rowCount,
        0,
      );
      const health = await api('/health');
      assert.equal(health.schema_revision, '031_supplier_bulk');
      const captured = (
        await pool.query(
          'SELECT snapshot,client_key FROM supplier_catalog_purchases WHERE purchase_id=$1',
          [po.id],
        )
      ).rows[0];
      const metadata = captured.snapshot;
      assert.equal(metadata[0].unit_cost, 1100);
      assert.equal(metadata[0].bulk_run_id, f.bulk);
      const replay = await api('/supplier-sources/' + f.source + '/purchase', 'POST', {
        client_key: captured.client_key,
        warehouse_id: f.warehouse,
        items: metadata.map((m: any) => ({
          id: m.item_id,
          version: m.version,
          quantity: m.quantity,
        })),
      });
      assert.equal(replay.id, po.id);
      assert.equal(replay.replayed, true);
      const readCounts = (
        await pool.query(
          'SELECT state,count(*)::int n FROM supplier_catalog_reads WHERE tenant_id=$1 GROUP BY state',
          [f.tenant],
        )
      ).rows;
      assert(readCounts.every((r) => r.state === 'success'));
      const refreshed = readCounts.length > 0;
      if (refreshed) {
        assert(simple.read_id);
        assert.equal(simple.bulk_run_id, null);
        assert.equal(simple.product_id, f.product);
      }
      const proof = {
        checked_at: new Date().toISOString(),
        scope: 'local_synthetic_supplier_bulk_purchase_receipts_fulfillment',
        bulk_run: f.bulk,
        bulk_published: 107,
        bulk_rejected: 0,
        zero_stock_before_receipt_verified: state.zero_stock_verified === true,
        full_catalog_pagination_unique: true,
        health,
        old_tenants: state.tenants.length,
        preserved_business_tables: tables.length,
        old_business_rows_unchanged: true,
        source: f.source,
        read_states: readCounts,
        point_refresh_preserves_link_price_stock_purchase: refreshed,
        catalog_items: items.length,
        supplier_quantity: 8,
        product: f.product,
        product_sale_price: 5000,
        purchase: po.id,
        purchase_replay_same_id: true,
        purchase_quantity: 5,
        purchase_currency: 'EUR',
        unit_cost: 1100,
        total_net: 5500,
        receipts: 2,
        stock: { on_hand: stock.on_hand, reserved: stock.reserved, available: stock.available },
        order: f.order ?? null,
        return: f.return ?? null,
        provider_requests: 0,
        authenticated_provider_confirmed: false,
      };
      await writeFile(
        phase === 'runtime'
          ? 'data/supplier-bulk-stage038-runtime.json'
          : 'docs/supplier-bulk-native-qa.json',
        JSON.stringify(proof, null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
      await save();
    }
  }
} finally {
  await pool.end();
}
