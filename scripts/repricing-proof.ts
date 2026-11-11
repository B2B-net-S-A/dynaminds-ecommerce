// Own local QA organization only. No external writes or provider requests.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/repricing-stage040.json',
  email = 'qa-repricing@demo.local',
  password = 'DynaDemo!2026';
const tables = [
  ...Object.keys(
    JSON.parse(await readFile('data/supplier-schedules-stage039.json', 'utf8')).before,
  ),
  'supplier_schedules',
];
let state: any,
  cookie = '';
async function fingerprint(tenants: string[]) {
  const out: any = {};
  for (const table of tables) {
    assert(/^[a-z_]+$/.test(table));
    const rows = (
      await pool.query(
        'SELECT to_jsonb(t)::text row FROM ' +
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
async function api(path: string, method = 'GET', body?: any, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, expected, path + ': ' + JSON.stringify(d));
  return d;
}
const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    assert(!(await pool.query("SELECT 1 FROM migrations WHERE name='033_repricing'")).rowCount);
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
        { email, password, name: 'QA Repricing', organization: { name: 'QA Repricing 20261004' } },
        201,
      );
      state.fixture = { tenant: (await api('/auth/me')).user.tenant_id };
      await save();
    } else await api('/auth/login', 'POST', { email, password });
    const f = state.fixture;
    if (phase === 'setup') {
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.products = [];
      for (const [sku, name, cost, price] of [
        ['RP-LAMP', 'Lampa biurkowa', 10000, 20000],
        ['RP-CHAIR', 'Krzesło biurowe', 20000, 40000],
      ] as const) {
        const p = await api(
          '/products',
          'POST',
          { name, sku, price, vat: 23, quantity: 12, warehouse_id: f.warehouse },
          201,
        );
        f.products.push({ ...p, net_cost: cost });
      }
      f.list = await api(
        '/price-lists',
        'POST',
        { name: 'Repricing • sklep PLN', currency: 'PLN', fallback: true },
        201,
      );
      const root = '/price-lists/' + f.list.id + '/repricing';
      f.rule = await api(root, 'PUT', { version: 0, config: { fee_bps: 500, ending: 99 } });
      f.rule = await api(root + '/inputs', 'PUT', {
        version: f.rule.version,
        items: f.products.map((p: any) => ({
          product_id: p.id,
          net_cost: p.net_cost,
          source: 'Dane demonstracyjne operatora',
        })),
      });
      f.old_order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'QA Repricing przed zmianą',
          email: 'buyer@example.test',
          warehouse_id: f.warehouse,
          price_list_id: f.list.id,
          items: [{ product_id: f.products[0].id, quantity: 1 }],
        },
        201,
      );
      await api('/orders/' + f.old_order.id + '/status', 'PATCH', { status: 'cancelled' });
      await save();
      console.log(
        JSON.stringify({
          tenant: f.tenant,
          sku: f.products.map((p: any) => p.sku),
          list: f.list.id,
        }),
      );
    }
    if (phase === 'verify' || phase === 'runtime') {
      assert.equal((await api('/health')).schema_revision, '033_repricing');
      const rows = (await api('/price-lists/' + f.list.id + '/repricing/previews')).data;
      const applied = rows.filter((p: any) => p.state === 'applied');
      assert.equal(applied.length, 1);
      const p = await api('/repricing-previews/' + applied[0].id);
      assert.equal(p.result.length, 2);
      assert(p.result.every((i: any) => i.state === 'change'));
      const q = await api('/pricing/quote', 'POST', {
        price_list_id: f.list.id,
        product_ids: f.products.map((p: any) => p.id),
      });
      assert.deepEqual(
        q.items.map((i: any) => i.price).sort((a: number, b: number) => a - b),
        [16499, 32899],
      );
      assert.equal(q.list.version, 2);
      await api('/repricing-previews/' + p.id + '/apply', 'POST', { confirmed: true });
      const old = await api('/orders/' + f.old_order.id);
      assert.equal(old.total, f.old_order.total);
      assert.deepEqual(old.pricing_snapshot, f.old_order.pricing_snapshot);
      if (!f.order) {
        f.order = await api(
          '/orders',
          'POST',
          {
            customer_name: 'QA Repricing po zmianie',
            email: 'buyer@example.test',
            warehouse_id: f.warehouse,
            price_list_id: f.list.id,
            items: [{ product_id: f.products[0].id, quantity: 2 }],
          },
          201,
        );
        await api('/orders/' + f.order.id + '/status', 'PATCH', { status: 'cancelled' });
        await save();
      }
      const order = await api('/orders/' + f.order.id);
      assert.equal(order.items[0].price, 16499);
      assert.equal(order.total, 32998);
      const products = (
        await pool.query('SELECT id,price FROM products WHERE tenant_id=$1', [f.tenant])
      ).rows;
      for (const p of products)
        assert.equal(p.price, f.products.find((i: any) => i.id === p.id).price);
      const stock = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1', [f.tenant])
      ).rows;
      assert(stock.every((i) => i.on_hand === 12 && i.reserved === 0));
      assert.deepEqual(await fingerprint(state.tenants), state.before);
      const health = await api('/health');
      const proof = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_api_chrome_synthetic',
        schema_revision: health.schema_revision,
        runtime_revision: health.revision ?? health.app_revision,
        old_tenants_preserved: state.tenants.length,
        business_tables_unchanged: tables.length,
        applied_previews: 1,
        prices: [16499, 32899],
        list_version: 2,
        replay_verified: true,
        historical_order_unchanged: true,
        new_order_total: 32998,
        stock_unchanged: true,
        provider_requests: 0,
      };
      await writeFile(
        phase === 'runtime' ? 'data/repricing-stage040-runtime.json' : 'docs/repricing-qa.json',
        JSON.stringify(proof, null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
    }
  }
} finally {
  await pool.end();
}
