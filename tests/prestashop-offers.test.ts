import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processOfferJob, failOffer } from '../server/offers';
import { processOfferSync, failOfferSync } from '../server/offer-sync';
import { Problem } from '../server/errors';
import { psDesiredPrice } from '../server/prestashop-offers';
import type { IntegrationContext } from '../server/channel-access';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  warehouse: string;
let seq = 400000,
  lostResource = '',
  rejectResource = '',
  currency = 'PLN';
let afterWrite: (() => Promise<void>) | undefined;
const store: Record<string, Map<string, any>> = {};
const calls: { method: string; resource: string; body: string; url: URL }[] = [];
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    const u = new URL(url),
      parts = u.pathname.split('/'),
      resource = parts[3],
      method = init.method ?? 'GET',
      body = String(init.body ?? '');
    assert.equal(u.origin, 'https://shop.example');
    assert.equal(parts[1], 'subdir');
    assert.equal(parts[2], 'api');
    assert.equal(u.searchParams.get('id_shop'), '1');
    assert.equal(
      new Headers(init.headers).get('authorization'),
      'Basic ' + Buffer.from('A'.repeat(32) + ':').toString('base64'),
    );
    assert(!url.includes('A'.repeat(32)));
    calls.push({ method, resource, body, url: u });
    if (method === 'PATCH') {
      assert.equal(new Headers(init.headers).get('content-type'), 'application/xml');
      assert(['products', 'combinations', 'stock_availables'].includes(resource));
      assert.equal(body.match(/<id>(\d+)<\/id>/)?.[1], parts[4]);
      if (rejectResource === resource) return new Response('DO_NOT_EXPOSE_SECRET', { status: 503 });
      const r = store[resource]?.get(parts[4]);
      assert(r);
      // Fixture parser only: application never parses the provider's XML response.
      for (const k of ['price', 'quantity', 'out_of_stock']) {
        const v = body.match(new RegExp('<' + k + '>([^<]+)</' + k + '>'))?.[1];
        if (v !== undefined) r[k] = v;
      }
      const hook = afterWrite;
      afterWrite = undefined;
      await hook?.();
      if (lostResource === resource) {
        lostResource = '';
        throw new Problem(502, 'Utracona odpowiedź fixture');
      }
      return new Response('<?xml version="1.0"?><prestashop/>', {
        headers: { 'content-type': 'application/xml' },
      });
    }
    assert.equal(method, 'GET');
    assert.equal(u.searchParams.get('output_format'), 'JSON');
    let rows = [...(store[resource]?.values() ?? [])];
    for (const [k, val] of u.searchParams)
      if (k.startsWith('filter[')) {
        const field = k.slice(7, -1),
          options = val.slice(1, -1).split('|');
        rows = rows.filter((r) => options.includes(String(r[field])));
      }
    rows = rows.slice(0, Number(u.searchParams.get('limit') ?? 100));
    return Response.json(rows.length ? { [resource]: rows } : []);
  },
};
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie: auth, ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  for (const [email, set] of [
    ['admin@demo.local', (v: string) => (cookie = v)],
    ['viewer@demo.local', (v: string) => (viewer = v)],
    ['other@demo.local', (v: string) => (other = v)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie']!.toString().split(';')[0]);
  }
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  calls.length = 0;
  lostResource = '';
  rejectResource = '';
  currency = 'PLN';
  afterWrite = undefined;
  for (const k of Object.keys(store)) delete store[k];
  store.configurations = new Map([
    ['1', { id: '1', name: 'PS_CURRENCY_DEFAULT', value: '1', id_shop: null, id_shop_group: null }],
  ]);
  store.currencies = new Map([['1', { id: '1', iso_code: currency, active: '1', deleted: '0' }]]);
  store.shops = new Map([['1', { id: '1', id_shop_group: '8' }]]);
  store.shop_groups = new Map([['8', { id: '8', share_stock: '1' }]]);
});
async function fixture(combination = false, simulation = false, channelId?: string) {
  const ch = channelId ?? randomUUID();
  if (!channelId)
    await tenantTx(DEMO_TENANT, (c) =>
      c.query(
        "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'prestashop','Presta oferty QA','sandbox',$3,$4)",
        [
          ch,
          DEMO_TENANT,
          encrypt({ api_key: 'A'.repeat(32) }),
          JSON.stringify({
            store_url: 'https://shop.example/subdir',
            shop_id: '1',
            order_state_ids: '2',
            simulation,
          }),
        ],
      ),
    );
  const p = await ok('/products', 'POST', {
    sku: 'PS-OFFER-' + seq++,
    name: 'Oferta Presta QA',
    quantity: 10,
    price: 12300,
    vat: 23,
    warehouse_id: warehouse,
  });
  const id = String(seq++),
    cid = combination ? String(seq++) : '0',
    sid = String(seq++);
  const base = {
    id,
    price: '10.000000',
    reference: p.sku,
    active: '1',
    is_virtual: '0',
    cache_is_pack: '0',
    ecotax: '0.000000',
    type: 'standard',
    id_tax_rules_group: '4',
    id_default_combination: cid,
    associations: { combinations: combination ? [{ id: cid }] : [] },
    description: [{ id: '1', value: 'Opis zachowany' }],
  };
  (store.products ??= new Map()).set(id, base);
  if (combination)
    (store.combinations ??= new Map()).set(cid, {
      id: cid,
      id_product: id,
      reference: p.sku,
      price: '2.000000',
    });
  const stock = {
    id: sid,
    id_product: id,
    id_product_attribute: cid,
    id_shop: '1',
    id_shop_group: '0',
    quantity: '2',
    depends_on_stock: '0',
    out_of_stock: '1',
  };
  (store.stock_availables ??= new Map()).set(sid, stock);
  const external = id + ':' + cid,
    l = await ok('/integrations/' + ch + '/mappings', 'POST', {
      external_id: external,
      sku: p.sku,
    });
  return { ch, p, id, cid, sid, external, l, base, stock };
}
async function reserve(f: any, quantity: number) {
  return ok('/orders', 'POST', {
    customer_name: 'QA Presta rezerwacja',
    email: 'presta@example.test',
    warehouse_id: warehouse,
    address: { country: 'PL' },
    items: [{ product_id: f.p.id, quantity }],
  });
}
async function preview(f: any, extra: any = {}, auth = cookie) {
  return req(
    '/integrations/' + f.ch + '/offers/preview',
    'POST',
    {
      product_id: f.p.id,
      listing_id: f.l.id,
      warehouse_id: warehouse,
      operation: 'sync',
      ...extra,
    },
    auth,
  );
}
async function plan(f: any, extra: any = {}) {
  const r = await preview(f, extra);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const getPlan = (d: any) =>
  tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM offer_plans WHERE id=$1', [d.id])).rows[0],
  );
async function queue(d: any) {
  return ok('/offer-plans/' + d.id + '/queue', 'POST', { confirm_live: true });
}
async function claim(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function execute(d: any) {
  const p = await getPlan(d),
    job = await claim(p.job_id);
  try {
    await processOfferJob(job, ctx);
  } catch (e) {
    await failOffer(job, e);
  }
  return getPlan(d);
}
const writes = () => calls.filter((c) => c.method === 'PATCH');
async function configure(f: any, extra: any = {}) {
  return ok('/integrations/' + f.ch + '/offer-sync', 'PATCH', {
    version: 0,
    enabled: true,
    warehouse_id: warehouse,
    price_list_id: null,
    stock: true,
    price: true,
    interval_seconds: 30,
    verify_seconds: 60,
    confirm_external: true,
    ...extra,
  });
}
async function cycle(f: any) {
  const d = await ok('/integrations/' + f.ch + '/offer-sync', 'POST', {}),
    job = await claim(d.id);
  try {
    await processOfferSync(job, ctx);
  } catch (e) {
    await failOfferSync(job, e);
  }
  return (await pool.query('SELECT * FROM jobs WHERE id=$1', [d.id])).rows[0];
}
test('Presta: minimalne XML PATCH netto i dostępnego stanu; GET potwierdza obie części', async () => {
  const f = await fixture();
  await reserve(f, 3);
  const d = await plan(f);
  assert.equal(d.provider, 'prestashop');
  assert.equal(d.price_basis, 'net');
  assert.deepEqual(d.payload, { regular_price: '100.000000', stock_quantity: 7, out_of_stock: 0 });
  await queue(d);
  const r = await execute(d);
  assert.equal(r.state, 'done', r.error);
  assert.equal(writes().length, 2);
  assert.deepEqual(
    writes().map((x) => x.resource),
    ['products', 'stock_availables'],
  );
  assert(writes()[0].body.endsWith('<price>100.000000</price></product></prestashop>'));
  assert(!writes()[0].body.includes('description'));
  assert.equal(f.base.description[0].value, 'Opis zachowany');
  assert.equal(f.stock.quantity, '7');
  assert.equal(f.stock.out_of_stock, '0');
  assert.deepEqual(r.result.presta_steps, { price: 'verified', stock: 'verified' });
  assert.equal(r.result.scope, 'external_api_verified');
  const l = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM listings WHERE id=$1', [f.l.id])).rows[0],
  );
  assert.equal(l.last_result.product_price, '100.000000');
  assert.equal(l.price, 12300);
});
test('Presta: cena kombinacji jako ujemny wpływ; rodzic i inne kombinacje pozostają', async () => {
  const f = await fixture(true);
  f.base.price = '150.000000';
  store.combinations.set('99999', {
    id: '99999',
    id_product: f.id,
    price: '5.000000',
    reference: 'OTHER',
  });
  const d = await plan(f);
  await queue(d);
  const r = await execute(d);
  assert.equal(r.state, 'done', r.error);
  assert(writes()[0].body.includes('<price>-50.000000</price>'));
  assert.equal(writes()[0].resource, 'combinations');
  assert.equal(f.base.price, '150.000000');
  assert.equal(store.combinations.get('99999').price, '5.000000');
  assert.equal(f.stock.quantity, '10');
});
test('Presta: utracona odpowiedź ceny → GET i tylko nietknięta część stanu', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  lostResource = 'products';
  let r = await execute(d);
  assert.equal(r.state, 'queued', r.error);
  assert.equal(r.result.presta_steps.price, 'started');
  assert.equal(writes().length, 1);
  r = await execute(d);
  assert.equal(r.state, 'done', r.error);
  assert.equal(writes().length, 2);
  assert.equal(writes()[1].resource, 'stock_availables');
});
test('Presta: utracona odpowiedź stanu → ponowienie wyłącznie odczytu', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  lostResource = 'stock_availables';
  assert.equal((await execute(d)).state, 'queued');
  const count = writes().length;
  assert.equal((await execute(d)).state, 'done');
  assert.equal(writes().length, count);
});
test('Presta: niepewna próba bez skutku nie powtarza PATCH; uzgodnienie zamyka wynik', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  rejectResource = 'products';
  assert.equal((await execute(d)).state, 'queued');
  rejectResource = '';
  let r = await execute(d);
  assert.equal(r.state, 'failed');
  assert.match(r.error, /Rozpoczęta próba/);
  assert.equal(writes().length, 1);
  f.base.ecotax = '2.000000';
  f.stock.depends_on_stock = '1';
  await ok('/offer-plans/' + d.id + '/reconcile', 'POST', { accept_observed: true });
  r = await execute(d);
  assert.equal(r.state, 'done', r.error);
  assert.equal(r.result.desired_applied, false);
  assert.equal(writes().length, 1);
  f.base.ecotax = '0.000000';
  f.stock.depends_on_stock = '0';
  const fresh = await plan(f);
  await queue(fresh);
  assert.equal((await execute(fresh)).state, 'done');
  assert.equal(writes().length, 3);
});
test('Presta: obce zmiany po podglądzie kończą konflikt bez PATCH', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  f.stock.quantity = '3';
  const r = await execute(d);
  assert.equal(r.state, 'conflict', r.error);
  assert.equal(writes().length, 0);
});
test('Presta: rezerwacja przed kolejką unieważnia podgląd', async () => {
  const f = await fixture(),
    d = await plan(f);
  await reserve(f, 1);
  assert.equal(
    (await req('/offer-plans/' + d.id + '/queue', 'POST', { confirm_live: true })).statusCode,
    409,
  );
  assert.equal(writes().length, 0);
});
test('Presta: rezerwacja między częściami blokuje zapis nieaktualnego stanu', async () => {
  const f = await fixture(),
    d = await plan(f);
  await queue(d);
  afterWrite = async () => {
    await reserve(f, 1);
  };
  const r = await execute(d);
  assert.equal(r.state, 'failed', r.error);
  assert.equal(writes().length, 1);
  assert.equal(f.stock.quantity, '2');
  await ok('/offer-plans/' + d.id + '/reconcile', 'POST', { accept_observed: true });
  assert.equal((await execute(d)).state, 'done');
  assert.equal(writes().length, 1);
});
test('Presta: lokalna symulacja nie wysyła HTTP i pamięta cenę netto rodzica', async () => {
  const f = await fixture(false, true),
    d = await plan(f);
  assert.equal(d.scope, 'local_simulation');
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  assert.equal(calls.length, 0);
  const next = await plan(f);
  assert.equal(next.before.product_price, '100.000000');
  assert.equal(next.before.regular_price, '100.000000');
});
test('Presta: również sandbox wymaga potwierdzenia zewnętrznego zapisu', async () => {
  const f = await fixture(),
    d = await plan(f);
  assert.equal((await req('/offer-plans/' + d.id + '/queue', 'POST', {})).statusCode, 422);
  assert.equal(writes().length, 0);
});
test('Presta: cena specjalna blokuje cenę, ale nie synchronizację samego stanu', async () => {
  const f = await fixture();
  store.specific_prices = new Map([['1', { id: '1', id_product: f.id }]]);
  assert.equal((await preview(f)).statusCode, 409);
  const d = await plan(f, { price: false });
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  assert.deepEqual(
    writes().map((x) => x.resource),
    ['stock_availables'],
  );
});
test('Presta: obca waluta blokuje cenę; sam stan nie wymaga uprawnień konfiguracji', async () => {
  const f = await fixture();
  store.currencies.get('1').iso_code = 'EUR';
  assert.equal((await preview(f)).statusCode, 422);
  calls.length = 0;
  const d = await plan(f, { price: false });
  assert(
    !calls.some((x) => ['currencies', 'configurations', 'specific_prices'].includes(x.resource)),
  );
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
});
test('Presta: waluta grupy ma pierwszeństwo przed globalną konfiguracją', async () => {
  const f = await fixture();
  store.configurations.set('2', {
    id: '2',
    name: 'PS_CURRENCY_DEFAULT',
    value: '2',
    id_shop: null,
    id_shop_group: '8',
  });
  store.currencies.set('2', { id: '2', iso_code: 'EUR', active: '1', deleted: '0' });
  assert.equal((await preview(f)).statusCode, 422);
  store.configurations.set('3', {
    id: '3',
    name: 'PS_CURRENCY_DEFAULT',
    value: '1',
    id_shop: '1',
    id_shop_group: '8',
  });
  assert.equal((await preview(f)).statusCode, 200);
});
test('Presta: niejednoznaczna waluta i nieprawidłowy scope konfiguracji są blokowane', async () => {
  const f = await fixture();
  store.configurations.set('2', {
    id: '2',
    name: 'PS_CURRENCY_DEFAULT',
    value: '1',
    id_shop: null,
    id_shop_group: null,
  });
  assert.equal((await preview(f)).statusCode, 422);
  store.configurations.delete('2');
  store.configurations.get('1').id_shop = 'garbage';
  assert.equal((await preview(f)).statusCode, 422);
});
test('Presta: wybiera właściwy stock_available bez nadpisania drugiego sklepu', async () => {
  const f = await fixture();
  store.stock_availables.set('99998', { ...f.stock, id: '99998', id_shop: '2', quantity: '99' });
  const d = await plan(f);
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  assert.equal(store.stock_availables.get('99998').quantity, '99');
  assert.equal(d.before.stock_id, f.sid);
});
test('Presta: współdzielony stan wymaga potwierdzenia grupy sklepu', async () => {
  const f = await fixture();
  f.stock.id_shop = '0';
  f.stock.id_shop_group = '8';
  const d = await plan(f);
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  store.shop_groups.get('8').share_stock = '0';
  assert.equal((await preview(f)).statusCode, 422);
});
test('Presta: obca grupa, duplikat stanu i brak stanu blokują zapis', async () => {
  const f = await fixture();
  f.stock.id_shop = '0';
  f.stock.id_shop_group = '9';
  assert.equal((await preview(f)).statusCode, 422);
  f.stock.id_shop = '1';
  f.stock.id_shop_group = '0';
  store.stock_availables.set('99997', { ...f.stock, id: '99997' });
  assert.equal((await preview(f)).statusCode, 422);
  store.stock_availables.clear();
  assert.equal((await preview(f)).statusCode, 422);
  assert.equal(writes().length, 0);
});
test('Presta: zaawansowany magazyn blokuje stan, ale pozwala zmienić samą cenę', async () => {
  const f = await fixture();
  f.stock.depends_on_stock = '1';
  assert.equal((await preview(f)).statusCode, 422);
  const d = await plan(f, { stock: false });
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  assert.equal(writes().length, 1);
  assert.equal(f.stock.quantity, '2');
  const listing = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT last_result FROM listings WHERE id=$1', [f.l.id])).rows[0],
  );
  assert.equal(listing.last_result.stock_quantity, 2);
});
test('Presta: powiązanie kombinacji nie może wskazywać rodzica innego produktu', async () => {
  const f = await fixture(true);
  store.combinations.get(f.cid).id_product = '999';
  assert.equal((await preview(f)).statusCode, 502);
  assert.equal(writes().length, 0);
});
test('Presta: prosty produkt z kombinacjami, wirtualny i pakiet natywny są blokowane', async () => {
  const f = await fixture();
  f.base.associations.combinations = [{ id: '123' }];
  assert.equal((await preview(f)).statusCode, 422);
  f.base.associations.combinations = [];
  f.base.is_virtual = '1';
  assert.equal((await preview(f)).statusCode, 422);
  f.base.is_virtual = '0';
  f.base.type = 'pack';
  assert.equal((await preview(f)).statusCode, 422);
});
test('Presta: brak SKU dopuszcza mapowanie ID; obce SKU blokuje plan', async () => {
  const f = await fixture();
  f.base.reference = '';
  assert.equal((await preview(f)).statusCode, 200);
  f.base.reference = 'OTHER';
  assert.equal((await preview(f)).statusCode, 409);
});
test('Presta: publikacja i tworzenie produktu pozostają poza zakresem; RLS i role', async () => {
  const f = await fixture();
  assert.equal((await preview(f, { operation: 'publish' })).statusCode, 422);
  assert.equal((await preview(f, {}, viewer)).statusCode, 403);
  assert.equal((await preview(f, {}, other)).statusCode, 404);
  assert.equal(
    (await req('/integrations/' + f.ch + '/offer-sync', 'GET', undefined, other)).statusCode,
    404,
  );
});
test('Presta: harmonogram zapisuje, ponowny przebieg nie tworzy nowego zapisu', async () => {
  const f = await fixture();
  await configure(f);
  assert.equal((await cycle(f)).state, 'done');
  let plans = (await pool.query('SELECT * FROM offer_plans WHERE channel_id=$1', [f.ch])).rows;
  assert.equal(plans.length, 1);
  assert.equal(plans[0].state, 'queued');
  assert.equal((await execute(plans[0])).state, 'done');
  const count = writes().length;
  await cycle(f);
  plans = (await pool.query('SELECT * FROM offer_plans WHERE channel_id=$1', [f.ch])).rows;
  assert.equal(plans.length, 1);
  assert.equal(writes().length, count);
  const data = await ok('/integrations/' + f.ch + '/offer-sync');
  assert(['verified', 'unchanged'].includes(data.data[0].state));
});
test('Presta: pauza harmonogramu między ceną i stanem blokuje drugie żądanie', async () => {
  const f = await fixture();
  const cfg = await configure(f);
  await cycle(f);
  const d = (await pool.query('SELECT * FROM offer_plans WHERE channel_id=$1', [f.ch])).rows[0];
  afterWrite = async () => {
    await configure(f, { version: cfg.version, enabled: false });
  };
  const r = await execute(d);
  assert.equal(r.state, 'failed', r.error);
  assert.equal(writes().length, 1);
  assert.equal(f.stock.quantity, '2');
});
test('Presta: netto liczone całkowitymi mikrojednostkami i z poprawnym zaokrągleniem', () => {
  assert.equal(psDesiredPrice(12300, 23), '100.000000');
  assert.equal(psDesiredPrice(1, 23), '0.008130');
  assert.equal(psDesiredPrice(999, 8), '9.250000');
  assert.equal(psDesiredPrice(0, 23), '0.000000');
});

test('Presta: cache pakietu i ecotax nie omijają polityki ceny lub stanu', async () => {
  const f = await fixture();
  f.base.cache_is_pack = '1';
  assert.equal((await preview(f)).statusCode, 422);
  f.base.cache_is_pack = '0';
  f.base.ecotax = '1.000000';
  assert.equal((await preview(f)).statusCode, 422);
  assert.equal((await preview(f, { price: false })).statusCode, 200);
});
test('Presta: 27 powiązań w dwóch partiach; kursor wyników bez pominięć', async () => {
  const f = await fixture();
  for (let i = 1; i < 27; i++) await fixture(false, false, f.ch);
  await configure(f);
  assert.equal((await cycle(f)).state, 'pending');
  assert.equal((await cycle(f)).state, 'done');
  const plans = (await pool.query('SELECT * FROM offer_plans WHERE channel_id=$1', [f.ch])).rows;
  assert.equal(plans.length, 27);
  assert(plans.every((p) => p.state === 'queued'));
  for (const p of plans) assert.equal((await execute(p)).state, 'done');
  let cursor = '',
    total = 0;
  const ids = new Set();
  do {
    const d = await ok(
      '/integrations/' + f.ch + '/offer-sync?limit=9' + (cursor ? '&after=' + cursor : ''),
    );
    for (const i of d.data) {
      assert(!ids.has(i.listing_id));
      ids.add(i.listing_id);
      total++;
    }
    cursor = d.meta.cursor;
  } while (cursor);
  assert.equal(total, 27);
  assert.equal(writes().length, 54);
});
