// Native local QA in its own synthetic organization. No provider requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/inventory-pages-stage036.json',
  email = 'qa-inventory-pages@demo.local',
  password = 'DynaDemo!2026';
const tables = Object.keys(
  JSON.parse(await readFile('data/shopify-publication-stage034.json', 'utf8')).before,
);
let state: any,
  cookie = '';
const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
async function fingerprints(tenants: string[]) {
  const out: any = {};
  for (const t of tables) {
    assert(/^[a-z_]+$/.test(t));
    const rows = (
      await pool.query(
        'SELECT to_jsonb(t)::text row FROM ' + t + ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [tenants],
      )
    ).rows;
    out[t] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}
async function api(path: string, method = 'GET', body?: any, key?: string, expect = 200) {
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
  const data = await r.json();
  assert.equal(r.status, expect, path + ':' + JSON.stringify(data));
  return data;
}
async function order(p: string, key: string) {
  return api(
    '/orders',
    'POST',
    {
      customer_name: 'QA Paginacja magazynu',
      email: 'inventory-qa@example.test',
      warehouse_id: state.fixture.warehouse,
      items: [{ product_id: p, quantity: key.endsWith('base') ? 2 : 1 }],
    },
    key,
    201,
  );
}
async function pages(path: string) {
  let after = '',
    count = 0,
    pages = 0;
  const ids = new Set<string>();
  do {
    const p = await api(path + (after ? '&after=' + encodeURIComponent(after) : ''));
    for (const row of p.data) {
      const id =
        !path.startsWith('/inventory/movements') && row.warehouse_id && row.product_id
          ? row.warehouse_id + ':' + row.product_id
          : row.id;
      assert(!ids.has(id));
      ids.add(id);
      count++;
    }
    after = p.meta.cursor ?? '';
    pages++;
  } while (after);
  return { count, pages };
}
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    state = { tenants, before: await fingerprints(tenants) };
    await save();
    console.log(JSON.stringify({ old_tenants: tenants.length, business_tables: tables.length }));
  } else {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup' && !state.fixture) {
      const account = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
      if (!account)
        await api(
          '/auth/signup',
          'POST',
          {
            email,
            password,
            name: 'QA Paginacja magazynu',
            organization: { name: 'QA Paginacja magazynu 20261004' },
          },
          undefined,
          201,
        );
      else await api('/auth/login', 'POST', { email, password });
      const me = (await api('/auth/me')).user;
      assert.equal(me.tenant_name, 'QA Paginacja magazynu 20261004');
      state.fixture = { tenant: me.tenant_id, warehouse: (await api('/warehouses')).data[0].id };
      await save();
    } else await api('/auth/login', 'POST', { email, password });
    const f = state.fixture;
    if (phase === 'setup') {
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      const warehouses = (await api('/warehouses')).data;
      f.second_warehouse =
        warehouses.find((w: any) => w.code === 'PAGE2')?.id ??
        (await api('/warehouses', 'POST', { name: 'QA Magazyn dodatkowy', code: 'PAGE2' })).id;
      await save();
      for (let i = 0; i < 105; i++) {
        const sku = 'PAGE-QA-' + String(i).padStart(4, '0');
        const exists = (
          await pool.query('SELECT id FROM products WHERE tenant_id=$1 AND sku=$2', [f.tenant, sku])
        ).rows[0];
        if (!exists)
          await api(
            '/products',
            'POST',
            {
              sku,
              name: 'QA paginacja produktu ' + i,
              price: 1000,
              quantity: 10,
              warehouse_id: f.warehouse,
            },
            undefined,
            201,
          );
      }
      f.products = (
        await pool.query(
          "SELECT id,sku,name FROM products WHERE tenant_id=$1 AND sku LIKE 'PAGE-QA-%' ORDER BY id",
          [f.tenant],
        )
      ).rows;
      assert.equal(f.products.length, 105);
      f.count_product = f.products.at(-1);
      f.adjust_product = f.products.at(-2);
      await save();
      if (!f.receipt) {
        const d = await api(
          '/warehouse-documents',
          'POST',
          {
            kind: 'receipt',
            warehouse_id: f.second_warehouse,
            reference: 'QA paginacja',
            lines: f.products
              .slice(0, 5)
              .map((p: any) => ({ product_id: p.id, quantity: 3, location: 'B-01' })),
          },
          undefined,
          201,
        );
        f.receipt = d.id;
        await save();
        await api('/warehouse-documents/' + d.id + '/post', 'POST', { version: d.version });
      }
      if (!f.order) {
        f.order = (await order(f.count_product.id, 'inventory-pages-036-base')).id;
        await save();
      }
      const first = (await api('/inventory?warehouse_id=' + f.warehouse + '&limit=50')).data;
      assert(!first.some((p: any) => p.product_id === f.count_product.id));
      assert(!first.some((p: any) => p.product_id === f.adjust_product.id));
      console.log(
        JSON.stringify({
          organization: 'QA Paginacja magazynu 20261004',
          products: 105,
          warehouse: f.warehouse,
          count: f.count_product,
          adjust: f.adjust_product,
          order: f.order,
        }),
      );
    } else if (phase === 'reserve') {
      if (!f.extra_order) {
        f.extra_order = (await order(f.count_product.id, 'inventory-pages-036-extra')).id;
        await save();
      }
      const d = (
        await pool.query(
          "SELECT id,status FROM warehouse_documents WHERE tenant_id=$1 AND kind='count' ORDER BY created_at DESC LIMIT 1",
          [f.tenant],
        )
      ).rows[0];
      assert.equal(d.status, 'draft');
      f.count_document = d.id;
      await save();
      console.log(
        JSON.stringify({ extra_order: f.extra_order, count_document: d.id, reserved: 3 }),
      );
    } else if (phase === 'verify') {
      assert.deepEqual(await fingerprints(state.tenants), state.before);
      const stock = (
        await api(
          '/inventory/snapshot?' +
            new URLSearchParams({
              warehouse_id: f.warehouse,
              product_ids: [f.count_product.id, f.adjust_product.id].join(','),
            }),
        )
      ).data;
      const counted = stock.find((s: any) => s.product_id === f.count_product.id),
        adjusted = stock.find((s: any) => s.product_id === f.adjust_product.id);
      assert.deepEqual([counted.on_hand, counted.reserved, counted.available], [9, 3, 6]);
      assert.equal(adjusted.on_hand, 13);
      const d = await api('/warehouse-documents/' + f.count_document);
      assert.equal(d.status, 'posted');
      assert.equal(d.lines.length, 1);
      assert.equal(d.lines[0].product_id, f.count_product.id);
      const inventory = await pages('/inventory?limit=50'),
        movements = await pages('/inventory/movements?limit=50');
      assert.equal(inventory.count, 110);
      assert.equal(inventory.pages, 3);
      assert(movements.count > 100);
      assert(movements.pages >= 3);
      const filtered = await api('/inventory?search=' + f.count_product.sku);
      assert.equal(filtered.data.length, 1);
      assert.equal(filtered.data[0].product_id, f.count_product.id);
      const openapi = await api('/v1/openapi');
      assert(openapi.paths['/inventory/snapshot']);
      await writeFile('docs/openapi.json', JSON.stringify(openapi, null, 2) + '\n');
      const health = await api('/health');
      assert.equal(health.schema_revision, '029_stocktakes');
      const proof = {
        checked_at: new Date().toISOString(),
        health,
        old_tenants_preserved: state.tenants.length,
        business_tables_preserved: tables.length,
        qa_products: 105,
        inventory,
        movements,
        selected_after_first_page: true,
        stock_count: {
          on_hand: counted.on_hand,
          reserved: counted.reserved,
          available: counted.available,
        },
        stock_adjusted: adjusted.on_hand,
        count_document: d.id,
        posted: true,
        openapi: true,
        provider_requests: 0,
      };
      await writeFile(
        process.argv.includes('--runtime')
          ? 'data/inventory-pages-stage036-runtime.json'
          : 'docs/inventory-pages-native-qa.json',
        JSON.stringify(proof, null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
    } else throw new Error('Nieznany etap dowodu');
  }
} finally {
  await pool.end();
}
