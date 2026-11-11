import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processCatalogSource, failCatalogSource, applyCatalog } from '../server/catalog-source';
import { normalizeSource } from '../server/catalog-source-normalize';
import { type IntegrationContext } from '../server/channel-access';
import { processOfferJob, failOffer } from '../server/offers';
import { tick } from '../server/worker';
import { processOfferSync, failOfferSync } from '../server/offer-sync';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  warehouse: string;
let currency = 'PLN',
  includeTax = 'yes',
  failPage = 0,
  hook: (() => Promise<void>) | undefined;
const products: any[] = [],
  variants = new Map<string, any[]>(),
  calls: { path: string; method: string; page: number; body: any }[] = [];
const json = (v: any, status = 200) => new Response(JSON.stringify(v), { status });
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    const u = new URL(url),
      method = init.method ?? 'GET',
      page = Number(u.searchParams.get('page') ?? 1),
      body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: u.pathname, method, page, body });
    if (u.pathname.includes('/settings/general/')) return json({ value: currency });
    if (u.pathname.includes('/settings/tax/')) return json({ value: includeTax });
    if (method === 'GET' && u.searchParams.has('page')) {
      const h = hook;
      hook = undefined;
      await h?.();
      if (page === failPage) return json({ secret: 'DO_NOT_EXPOSE_CATALOG_RESPONSE' }, 503);
      assert.equal(u.searchParams.get('orderby'), 'id');
      assert.equal(u.searchParams.get('order'), 'asc');
      const m = u.pathname.match(/\/products\/(\d+)\/variations$/);
      const all = m ? (variants.get(m[1]) ?? []) : products;
      return json(all.slice((page - 1) * 50, page * 50));
    }
    const m = u.pathname.match(/\/products\/(\d+)(?:\/variations\/(\d+))?$/);
    assert(m, 'Unexpected fixture URL');
    const item = m[2]
      ? (variants.get(m[1]) ?? []).find((v) => String(v.id) === m[2])
      : products.find((v) => String(v.id) === m[1]);
    if (!item) return json({}, 404);
    if (method === 'PUT') Object.assign(item, body);
    return json(item);
  },
};
const req = (p: string, method: any = 'GET', b?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload: b, headers: { cookie: auth } });
async function ok(p: string, method: any = 'GET', b?: any) {
  const r = await req(p, method, b);
  assert(r.statusCode < 300, r.body);
  if (r.headers['set-cookie']) cookie = r.headers['set-cookie']!.toString().split(';')[0];
  return r.json();
}
async function login() {
  const r = await req(
    '/auth/login',
    'POST',
    { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    '',
  );
  assert.equal(r.statusCode, 200, r.body);
  cookie = r.headers['set-cookie']!.toString().split(';')[0];
  const s = await req('/workspaces/switch', 'POST', { tenant_id: DEMO_TENANT });
  assert.equal(s.statusCode, 200, s.body);
  cookie = s.headers['set-cookie']!.toString().split(';')[0];
  warehouse = (await ok('/warehouses')).data[0].id;
}
const product = (id: number, x: any = {}) => ({
  id,
  type: 'simple',
  sku: 'SRC-' + randomUUID().slice(0, 12),
  name: 'Produkt źródłowy ' + id,
  status: 'publish',
  regular_price: '10.00',
  tax_status: 'taxable',
  tax_class: '',
  manage_stock: true,
  stock_quantity: 12,
  attributes: [],
  images: [],
  ...x,
});
async function channel(simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','Catalog QA','sandbox',$3,$4)",
      [
        id,
        DEMO_TENANT,
        encrypt({ consumer_key: 'fixture', consumer_secret: 'fixture' }),
        JSON.stringify({ store_url: 'https://shop.example', simulation }),
      ],
    ),
  );
  return { id };
}
async function start(ch: any, x: any = {}) {
  return ok(`/integrations/${ch.id}/catalog-source-runs`, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    vat: 23,
    import_stock: true,
    ...x,
  });
}
async function claim(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function step(r: any) {
  const job = await claim(r.job_id);
  try {
    await processCatalogSource(job, ctx);
  } catch (e) {
    await failCatalogSource(job, e);
  }
  return (await pool.query('SELECT * FROM catalog_source_runs WHERE id=$1', [r.id])).rows[0];
}
async function fetchAll(r: any) {
  for (let n = 0; n < 100; n++) {
    r = await step(r);
    if (r.state !== 'queued') return r;
  }
  throw Error('Fixture did not finish');
}
async function view(r: any, query = '') {
  return ok('/catalog-source-runs/' + r.id + query);
}
const applyItem = (r: any, x: any = {}) => ({
  id: r.id,
  source_hash: r.source_hash,
  expected_product_id: r.candidate_id ?? null,
  expected_version: r.candidate_version ?? null,
  ...x,
});
async function apply(r: any, items: any[]) {
  return ok(`/catalog-source-runs/${r.id}/apply`, 'POST', { items });
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  for (const [email, set] of [
    ['viewer@demo.local', (v: string) => (viewer = v)],
    ['other@demo.local', (v: string) => (other = v)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie']!.toString().split(';')[0]);
  }
  await app.close();
});
after(async () => {
  await pool.end();
});
afterEach(async () => {
  await app.close();
});
beforeEach(async () => {
  app = await buildApp({ integrationTransport: ctx.transport });
  await login();
  currency = 'PLN';
  includeTax = 'yes';
  failPage = 0;
  hook = undefined;
  products.length = 0;
  variants.clear();
  calls.length = 0;
});
test('podgląd nie tworzy katalogu; zatwierdzenie zapisuje produkt, zdjęcia, brutto i ruch raz', async () => {
  const ch = await channel();
  products.push(
    product(101, {
      regular_price: '12.34',
      description: '<p>Opis <script>private()</script>towaru</p>',
      images: [{ src: 'https://images.example/product.jpg' }, { src: 'http://bad.example/a.jpg' }],
      attributes: [{ name: 'Materiał', options: ['Bawełna'] }],
      global_unique_id: '5901234567890',
    }),
  );
  const initial = (await pool.query('SELECT count(*) FROM products')).rows[0].count;
  const run = await fetchAll(await start(ch));
  assert.equal(run.state, 'ready');
  assert.equal((await pool.query('SELECT count(*) FROM products')).rows[0].count, initial);
  const row = (await view(run)).data[0];
  assert.equal(row.source.price, 1234);
  assert.equal(row.source.description, 'Opis towaru');
  assert.equal(row.source.images.length, 1);
  assert(row.issues.some((s: string) => s.includes('zdjęcia')));
  const result = await apply(run, [applyItem(row)]);
  assert.equal(result.created, 1);
  const p = await ok('/products/' + result.data[0].product_id);
  assert.equal(p.price, 1234);
  assert.equal(p.ean, '5901234567890');
  assert.deepEqual(p.attributes, { Materiał: 'Bawełna' });
  assert.deepEqual([p.stock[0].on_hand, p.stock[0].reserved], [12, 0]);
  const replay = await apply(run, [applyItem(row)]);
  assert.equal(replay.created, 0);
  assert(replay.data[0].reused);
  assert.equal(
    (await pool.query('SELECT count(*) FROM stock_movements WHERE product_id=$1', [p.id])).rows[0]
      .count,
    '1',
  );
  assert(calls.every((c) => c.method === 'GET'));
});
test('grupa i warianty mają swoje SKU, parametry, stany i parent_external_id', async () => {
  const ch = await channel(),
    group = product(201, {
      type: 'variable',
      sku: 'GROUP-' + randomUUID().slice(0, 8),
      variations: [202, 203],
    });
  products.push(group);
  variants.set('201', [
    product(202, {
      type: undefined,
      sku: '',
      attributes: [{ name: 'Kolor', option: 'Niebieski' }],
    }),
    product(203, { type: undefined, sku: '', regular_price: '12.50' }),
  ]);
  const r = await fetchAll(await start(ch)),
    rows = (await view(r)).data;
  assert.equal(rows.length, 3);
  const v = rows.find((v: any) => v.external_id === '202');
  assert(v.source.sku.includes('202'));
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [applyItem(v)] })).statusCode,
    422,
  );
  const out = await apply(
    r,
    rows.map((x: any) => applyItem(x)),
  );
  assert.equal(out.created, 3);
  const parent = out.data.find((v: any) => v.kind === 'group');
  const p = await ok('/products/' + parent.product_id);
  assert.equal(p.stock.length, 0);
  assert.equal(p.variants.length, 2);
  const maps = (await pool.query('SELECT * FROM listings WHERE channel_id=$1', [ch.id])).rows;
  assert.equal(maps.length, 2);
  assert(maps.every((m) => m.parent_external_id === '201'));
  assert.equal(
    (await ok('/products/' + out.data.find((x: any) => x.external_id === '202').product_id))
      .attributes.Kolor,
    'Niebieski',
  );
});
test('istniejący SKU zostaje tylko powiązany, nawet gdy ma rezerwacje i inną cenę', async () => {
  const ch = await channel(),
    sku = 'LINK-' + randomUUID().slice(0, 8);
  const p = await ok('/products', 'POST', {
    sku,
    name: 'Produkt zachowany',
    price: 9999,
    warehouse_id: warehouse,
    quantity: 8,
  });
  const o = await ok('/orders', 'POST', {
    customer_name: 'Catalog QA',
    email: 'qa@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: p.id, quantity: 2 }],
  });
  products.push(product(301, { sku, regular_price: '1.00', stock_quantity: 500 }));
  const r = await fetchAll(await start(ch)),
    row = (await view(r)).data[0];
  assert.equal(row.candidate_id, p.id);
  const out = await apply(r, [applyItem(row, { price_override: 100, quantity_override: 500 })]);
  assert.equal(out.linked, 1);
  const saved = await ok('/products/' + p.id);
  assert.equal(saved.price, 9999);
  assert.deepEqual([saved.stock[0].on_hand, saved.stock[0].reserved], [8, 2]);
  await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'cancelled' }));
});
test('dwie równoczesne partie zatwierdzają te same pozycje dokładnie raz', async () => {
  const ch = await channel();
  products.push(product(401));
  const r = await fetchAll(await start(ch)),
    item = applyItem((await view(r)).data[0]);
  const results = await Promise.all([apply(r, [item]), apply(r, [item])]);
  assert.equal(
    results.reduce((n, x) => n + x.created, 0),
    1,
  );
  assert.equal(results.filter((x) => x.data[0].reused).length, 1);
});
test('kolejka oferty czeka na katalog przed blokadą kanału, import nie zakleszcza zatwierdzenia', async () => {
  const ch = await channel();
  products.push(product(49000));
  const first = await fetchAll(await start(ch));
  const created = (
    await apply(
      first,
      (await view(first)).data.map((v: any) => applyItem(v)),
    )
  ).data[0];
  const second = await fetchAll(await start(ch));
  const row = (await view(second)).data[0];
  const preview = await ok(`/integrations/${ch.id}/offers/preview`, 'POST', {
    operation: 'sync',
    listing_id: created.listing_id,
    product_id: created.product_id,
    warehouse_id: warehouse,
    price: true,
    stock: true,
  });
  const me = await ok('/auth/me');
  let queued: ReturnType<typeof req> | undefined;
  try {
    await tenantTx(DEMO_TENANT, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'catalog:' + DEMO_TENANT,
      ]);
      queued = req(`/offer-plans/${preview.id}/queue`, 'POST', { confirm_live: false });
      let waiting = false;
      for (let n = 0; n < 100 && !waiting; n++) {
        waiting = !!(
          await pool.query(
            "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
          )
        ).rowCount;
        if (!waiting) await new Promise((r) => setTimeout(r, 10));
      }
      assert(waiting, 'Queue should be waiting on the catalogue lock');
      await c.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE NOWAIT', [ch.id]);
      const out = await applyCatalog(
        c,
        { tenantId: DEMO_TENANT, userId: me.user.id, role: 'admin' },
        second.id,
        { items: [applyItem(row)] },
      );
      assert.equal(out.linked, 1);
    });
  } finally {
    const response = await queued;
    if (response) assert.equal(response.statusCode, 200, response.body);
  }
});
test('zmienione SKU lub wersja nie nadpisują danych i cofają całą partię', async () => {
  const ch = await channel();
  products.push(product(501), product(502));
  const r = await fetchAll(await start(ch)),
    rows = (await view(r)).data;
  await ok('/products', 'POST', {
    sku: rows[1].source.sku,
    name: 'Produkt utworzony po podglądzie',
    price: 4000,
    warehouse_id: warehouse,
    quantity: 2,
  });
  const count = (await pool.query('SELECT count(*) FROM products')).rows[0].count;
  assert.equal(
    (
      await req(`/catalog-source-runs/${r.id}/apply`, 'POST', {
        items: rows.map((v: any) => applyItem(v)),
      })
    ).statusCode,
    409,
  );
  assert.equal((await pool.query('SELECT count(*) FROM products')).rows[0].count, count);
  assert.equal((await view(r)).data.filter((v: any) => v.state === 'applied').length, 0);
  const fresh = (await view(r)).data;
  const linked = fresh.find((v: any) => v.candidate_id);
  await pool.query('UPDATE products SET version=version+1 WHERE id=$1', [linked.candidate_id]);
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [applyItem(linked)] }))
      .statusCode,
    409,
  );
});
test('kolizja SKU między źródłami i błędny typ nie zostają arbitralnie powiązane', async () => {
  const ch = await channel(),
    sku = 'DUP-' + randomUUID().slice(0, 8);
  products.push(product(601, { sku }), product(602, { sku }));
  const r = await fetchAll(await start(ch)),
    rows = (await view(r)).data;
  assert.equal(
    (
      await req(`/catalog-source-runs/${r.id}/apply`, 'POST', {
        items: rows.map((v: any) => applyItem(v)),
      })
    ).statusCode,
    409,
  );
  assert.equal((await view(r)).data.filter((v: any) => v.state === 'applied').length, 0);
  await ok('/products', 'POST', {
    sku,
    name: 'Istniejąca grupa',
    kind: 'group',
    price: 0,
    warehouse_id: warehouse,
    quantity: 0,
  });
  assert.equal(
    (
      await req(`/catalog-source-runs/${r.id}/apply`, 'POST', {
        items: [applyItem((await view(r)).data[0])],
      })
    ).statusCode,
    409,
  );
});
test('ceny netto i obca waluta nie powodują niejawnego FX; listing zachowuje EUR', async () => {
  currency = 'EUR';
  includeTax = 'no';
  const ch = await channel();
  products.push(product(701, { regular_price: '7.77' }));
  const r = await fetchAll(await start(ch)),
    row = (await view(r)).data[0];
  assert.equal(row.source.price, 956);
  assert.equal(row.source.currency, 'EUR');
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [applyItem(row)] }))
      .statusCode,
    422,
  );
  const out = await apply(r, [applyItem(row, { price_override: 1234 })]);
  const p = await ok('/products/' + out.data[0].product_id);
  assert.equal(p.price, 1234);
  const l = (
    await pool.query('SELECT price,price_currency FROM listings WHERE id=$1', [
      out.data[0].listing_id,
    ])
  ).rows[0];
  assert.deepEqual(l, { price: 956, price_currency: 'EUR' });
});
test('nieznany stan, cena z trzema miejscami i promocja wymagają jawnych ustawień', async () => {
  const ch = await channel();
  products.push(
    product(801, {
      regular_price: '1.999',
      sale_price: '1.00',
      on_sale: true,
      manage_stock: false,
      stock_quantity: null,
    }),
  );
  const r = await fetchAll(await start(ch)),
    row = (await view(r)).data[0];
  assert.equal(row.source.price, null);
  assert.equal(row.source.quantity, null);
  assert(row.issues.some((s: string) => s.includes('promocja')));
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [applyItem(row)] }))
      .statusCode,
    422,
  );
  const out = await apply(r, [applyItem(row, { price_override: 999, quantity_override: 3 })]);
  assert.equal((await ok('/products/' + out.data[0].product_id)).stock[0].on_hand, 3);
});
test('bez przyjęcia stanów nowe SKU mają zero, grupa nie dostaje zapasu', async () => {
  const ch = await channel();
  products.push(product(901, { stock_quantity: 999 }));
  const r = await fetchAll(await start(ch, { import_stock: false }));
  const out = await apply(r, [applyItem((await view(r)).data[0], { quantity_override: 555 })]);
  assert.equal((await ok('/products/' + out.data[0].product_id)).stock[0].on_hand, 0);
});
test('155 produktów i 121 wariantów pobierają wszystkie strony i mają paginację widoku', async () => {
  const ch = await channel();
  for (let i = 0; i < 155; i++) products.push(product(10000 + i));
  products[0].type = 'variable';
  products[0].variations = Array.from({ length: 121 }, (_, i) => 20000 + i);
  variants.set(
    '10000',
    products[0].variations.map((id: number) => product(id, { type: undefined })),
  );
  const r = await fetchAll(await start(ch));
  assert.equal(r.fetched, 276);
  assert.equal(calls.filter((c) => c.path.endsWith('/products')).length, 4);
  assert.equal(calls.filter((c) => c.path.endsWith('/variations')).length, 3);
  const seen = new Set<string>();
  let after = '';
  let count = 0;
  do {
    const d = await view(r, '?limit=19' + (after ? '&after=' + after : ''));
    for (const v of d.data) {
      assert(!seen.has(v.id));
      seen.add(v.id);
      count++;
    }
    after = d.meta.cursor ?? '';
  } while (after);
  assert.equal(count, 276);
  assert.equal((await view(r, '?kind=variant&search=20020')).data.length, 1);
});
test('retry po końcowej awarii wznawia kolejną stronę bez duplikatów', async () => {
  const ch = await channel();
  for (let i = 0; i < 51; i++) products.push(product(30000 + i));
  let r = await start(ch);
  r = await step(r);
  assert.equal(r.fetched, 50);
  await pool.query('UPDATE jobs SET max_attempts=1 WHERE id=$1', [r.job_id]);
  failPage = 2;
  r = await step(r);
  assert.equal(r.state, 'failed');
  assert.equal(r.fetched, 50);
  assert(!r.error.includes('DO_NOT_EXPOSE'));
  failPage = 0;
  const retried = await ok(`/catalog-source-runs/${r.id}/retry`, 'POST', {});
  r = { ...r, job_id: retried.job_id };
  r = await fetchAll(r);
  assert.equal(r.fetched, 51);
  assert.equal(
    (await pool.query('SELECT count(*) FROM catalog_source_items WHERE run_id=$1', [r.id])).rows[0]
      .count,
    '51',
  );
});
test('anulowanie w trakcie GET nie utrwala źródła ani lokalnych produktów', async () => {
  const ch = await channel();
  products.push(product(40000));
  const r = await start(ch);
  hook = async () => {
    await ok(`/catalog-source-runs/${r.id}/cancel`, 'POST', {});
  };
  await step(r);
  assert.equal((await view(r)).run.state, 'cancelled');
  assert.equal((await view(r)).data.length, 0);
  assert.equal((await req(`/catalog-source-runs/${r.id}/retry`, 'POST', {})).statusCode, 409);
});
test('nieaktualna dzierżawa przed i podczas GET nie zapisuje checkpointów', async () => {
  const ch = await channel();
  products.push(product(41000));
  const r = await start(ch),
    job = await claim(r.job_id);
  await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, randomUUID()]);
  await processCatalogSource(job, ctx);
  assert.equal(calls.length, 0);
  hook = async () => {
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, randomUUID()]);
  };
  await step(r);
  assert.equal((await view(r)).data.length, 0);
  assert.equal((await view(r)).run.context, null);
});
test('zmiana połączenia podczas pobierania blokuje zapis strony i dalsze retry', async () => {
  const ch = await channel();
  products.push(product(42000));
  const r = await start(ch);
  hook = async () => {
    await pool.query(
      "UPDATE channels SET settings=jsonb_set(settings,'{store_url}','\"https://changed.example\"'::jsonb) WHERE id=$1",
      [ch.id],
    );
  };
  const after = await step(r);
  assert.equal(after.state, 'failed');
  assert.equal((await view(r)).data.length, 0);
  assert.equal((await req(`/catalog-source-runs/${r.id}/retry`, 'POST', {})).statusCode, 409);
});
test('zmiana waluty lub podatku do końca skanowania wymaga nowego przeglądu', async () => {
  const ch = await channel();
  products.push(product(43000));
  const r = await start(ch);
  hook = async () => {
    includeTax = 'no';
  };
  const after = await step(r);
  assert.equal(after.state, 'failed');
  assert(after.error.includes('podczas pobierania'));
  assert.equal((await view(r)).data.length, 0);
});
test('źródło z innym rodzicem i nieobsługiwane typy nie tworzą produktu', async () => {
  const ch = await channel();
  products.push(product(44000, { type: 'variable' }));
  variants.set('44000', [product(44001, { parent_id: 9999 })]);
  let r = await start(ch);
  r = await step(r);
  r = await fetchAll(r);
  assert.equal(r.state, 'failed');
  assert.equal(r.fetched, 1);
  products.length = 0;
  products.push(product(44002, { type: 'external' }), product(44003, { virtual: true }));
  const next = await fetchAll(await start(ch));
  for (const row of (await view(next)).data)
    assert.equal(
      (await req(`/catalog-source-runs/${next.id}/apply`, 'POST', { items: [applyItem(row)] }))
        .statusCode,
      422,
    );
});
test('powtórny klucz startu scala kliknięcia; inna konfiguracja, hash i replay są konfliktem', async () => {
  const ch = await channel(),
    key = randomUUID();
  products.push(product(45000));
  const [a, b] = await Promise.all([
    start(ch, { client_key: key }),
    start(ch, { client_key: key }),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(
    (
      await req(`/integrations/${ch.id}/catalog-source-runs`, 'POST', {
        client_key: key,
        warehouse_id: warehouse,
        vat: 8,
        import_stock: true,
      })
    ).statusCode,
    409,
  );
  const r = await fetchAll(a),
    row = (await view(r)).data[0];
  assert.equal(
    (
      await req(`/catalog-source-runs/${r.id}/apply`, 'POST', {
        items: [applyItem(row, { source_hash: 'a'.repeat(64) })],
      })
    ).statusCode,
    409,
  );
  await apply(r, [applyItem(row)]);
  assert.equal(
    (
      await req(`/catalog-source-runs/${r.id}/apply`, 'POST', {
        items: [applyItem(row, { price_override: 2000 })],
      })
    ).statusCode,
    409,
  );
});
test('przeterminowany podgląd i obcy magazyn nie zostają zatwierdzone', async () => {
  const ch = await channel();
  products.push(product(46000));
  const r = await fetchAll(await start(ch)),
    row = (await view(r)).data[0];
  await pool.query(
    "UPDATE catalog_source_items SET captured_at=now()-interval '25 hours' WHERE id=$1",
    [row.id],
  );
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [applyItem(row)] }))
      .statusCode,
    409,
  );
  const otherW = (
    await pool.query('SELECT id FROM warehouses WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
  ).rows[0].id;
  assert.equal(
    (
      await req(`/integrations/${ch.id}/catalog-source-runs`, 'POST', {
        client_key: randomUUID(),
        warehouse_id: otherW,
      })
    ).statusCode,
    404,
  );
});
test('kolizja powiązania z innym SKU wycofuje utworzenie produktu i ruchu', async () => {
  const ch = await channel();
  products.push(product(47000));
  const p = await ok('/products', 'POST', {
    sku: 'OTHER-' + randomUUID().slice(0, 8),
    name: 'Inny produkt',
    price: 999,
    warehouse_id: warehouse,
    quantity: 1,
  });
  await ok(`/integrations/${ch.id}/mappings`, 'POST', { external_id: '47000', sku: p.sku });
  const r = await fetchAll(await start(ch)),
    row = (await view(r)).data[0];
  const count = (await pool.query('SELECT count(*) FROM products')).rows[0].count;
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [applyItem(row)] }))
      .statusCode,
    409,
  );
  assert.equal((await pool.query('SELECT count(*) FROM products')).rows[0].count, count);
});
test('zaimportowany wariant używa prawidłowego endpointu zapisu WooCommerce', async () => {
  const ch = await channel(),
    g = product(48000, { type: 'variable', variations: [48001] });
  products.push(g);
  variants.set('48000', [product(48001, { type: undefined, regular_price: '12.00' })]);
  const r = await fetchAll(await start(ch));
  const out = await apply(
    r,
    (await view(r)).data.map((v: any) => applyItem(v)),
  );
  const variant = out.data.find((v: any) => v.kind === 'variant');
  const preview = await ok(`/integrations/${ch.id}/offers/preview`, 'POST', {
    operation: 'sync',
    listing_id: variant.listing_id,
    product_id: variant.product_id,
    warehouse_id: warehouse,
    parent_external_id: '48000',
    price: true,
    stock: true,
  });
  await ok(`/offer-plans/${preview.id}/queue`, 'POST', { confirm_live: false });
  const p = (await pool.query('SELECT * FROM offer_plans WHERE id=$1', [preview.id])).rows[0],
    job = await claim(p.job_id);
  try {
    await processOfferJob(job, ctx);
  } catch (e) {
    await failOffer(job, e);
  }
  assert.equal(
    (await pool.query('SELECT state FROM offer_plans WHERE id=$1', [p.id])).rows[0].state,
    'done',
  );
  assert(
    calls.some((c) => c.method === 'PUT' && c.path.endsWith('/products/48000/variations/48001')),
  );
});
test('role i RLS izolują importy, pozycje, lookup i zatwierdzenia firm', async () => {
  const ch = await channel();
  products.push(product(49000));
  const r = await fetchAll(await start(ch));
  const row = (await view(r)).data[0];
  for (const path of [
    `/integrations/${ch.id}/catalog-source-runs`,
    `/catalog-source-runs/${r.id}`,
    `/catalog-source-runs/${r.id}/candidate?sku=${encodeURIComponent(row.source.sku)}`,
  ]) {
    assert.equal((await req(path, 'GET', undefined, viewer)).statusCode, 403);
    assert.equal((await req(path, 'GET', undefined, other)).statusCode, 404);
  }
  assert.equal(
    (await req(`/catalog-source-runs/${r.id}/apply`, 'POST', { items: [applyItem(row)] }, other))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT id FROM catalog_source_items WHERE run_id=$1', [r.id]),
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT id FROM catalog_source_runs WHERE id=$1', [r.id]),
      )
    ).rowCount,
    0,
  );
});
test('utrata roli zatrzymuje pobieranie, worker obsługuje catalog.fetch', async () => {
  const ch = await channel();
  products.push(product(50000));
  const r = await start(ch),
    user = (await ok('/auth/me')).user.id;
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  try {
    assert.equal((await step(r)).state, 'failed');
    assert.equal(calls.length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  }
  const next = await start(ch);
  await pool.query(
    "UPDATE jobs SET run_at=now()+interval '1 day' WHERE state='pending' AND id<>$1",
    [next.job_id],
  );
  assert(await tick(ctx));
  assert.equal((await view(next)).run.state, 'ready');
});
test('cofnięcie roli podczas GET lub po autoryzacji blokuje checkpoint i zapis katalogu', async () => {
  const ch = await channel();
  products.push(product(51000));
  const r = await start(ch),
    user = (await ok('/auth/me')).user.id;
  const revoke = () =>
    pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  const restore = () =>
    pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  hook = async () => {
    await revoke();
  };
  try {
    assert.equal((await step(r)).state, 'failed');
    assert.equal(
      (await pool.query('SELECT count(*) FROM catalog_source_items WHERE run_id=$1', [r.id]))
        .rows[0].count,
      '0',
    );
  } finally {
    await restore();
  }
  const next = await fetchAll(await start(ch)),
    row = (await view(next)).data[0];
  await revoke();
  try {
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) =>
        applyCatalog(c, { tenantId: DEMO_TENANT, userId: user, role: 'admin' }, next.id, {
          items: [applyItem(row)],
        }),
      ),
      (e: any) => e.status === 403,
    );
    assert.equal(
      (await pool.query('SELECT count(*) FROM products WHERE sku=$1', [row.source.sku])).rows[0]
        .count,
      '0',
    );
  } finally {
    await restore();
  }
});
test('symulator obejmuje produkt, grupę i warianty bez połączeń sieciowych', async () => {
  await ok('/workspaces', 'POST', {
    name: 'Catalog simulator ' + randomUUID().slice(0, 8),
    currency: 'PLN',
    locale: 'pl-PL',
  });
  const newTenant = (await ok('/auth/me')).user.tenant_id;
  warehouse = (await ok('/warehouses')).data[0].id;
  const ch = await ok('/integrations/demo-import', 'POST', {});
  const r = await fetchAll(await start({ id: ch.channel_id }));
  assert.equal(r.fetched, 4);
  const out = await apply(
    r,
    (await view(r)).data.map((v: any) => applyItem(v)),
  );
  assert.equal(out.created, 4);
  assert.equal(calls.length, 0);
  assert.equal(
    (await pool.query('SELECT count(*) FROM listings WHERE tenant_id=$1', [newTenant])).rows[0]
      .count,
    '3',
  );
  await ok(`/integrations/${ch.channel_id}/offer-sync`, 'PATCH', {
    version: 0,
    enabled: true,
    warehouse_id: warehouse,
    stock: true,
    price: true,
    interval_seconds: 300,
    verify_seconds: 900,
  });
  const scheduled = await ok(`/integrations/${ch.channel_id}/offer-sync`, 'POST', {});
  const job = await claim(scheduled.id);
  try {
    await processOfferSync(job, ctx);
  } catch (e) {
    await failOfferSync(job, e);
  }
  const items = (await ok(`/integrations/${ch.channel_id}/offer-sync`)).data;
  assert.equal(items.length, 3);
  assert(
    items.every((i: any) => i.state === 'unchanged'),
    JSON.stringify(items.map((i: any) => ({ sku: i.sku, error: i.error }))),
  );
  assert.equal(calls.length, 0);
  await login();
});
