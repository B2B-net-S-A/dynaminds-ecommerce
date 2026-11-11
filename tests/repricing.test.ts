import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { calculateReprice, repricingConfig } from '../server/repricing';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  other = '',
  viewer = '',
  tenant = '',
  warehouse = '';
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie, extra: any = {}) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie: auth, ...extra } });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  cookie = (
    await req('/auth/signup', 'POST', {
      email: 'repricing-test@demo.local',
      password: 'DynaDemo!2026',
      name: 'Repricing QA',
      organization: { name: 'Repricing QA' },
    })
  ).headers['set-cookie']!.toString().split(';')[0];
  tenant = (await ok('/auth/me')).user.tenant_id;
  await ok('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
  warehouse = (await ok('/warehouses')).data[0].id;
  for (const email of ['other@demo.local', 'viewer@demo.local']) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' });
    const auth = r.headers['set-cookie']!.toString().split(';')[0];
    if (email.startsWith('other')) other = auth;
    else viewer = auth;
  }
});
after(async () => {
  await app.close();
  await pool.end();
});
async function fixture(extra: any = {}, currency = 'PLN', vat = 23) {
  const p = await ok('/products', 'POST', {
    name: 'Repricing QA',
    sku: 'RP-' + randomUUID(),
    warehouse_id: warehouse,
    quantity: 10,
    price: 20000,
    vat,
  });
  const l = await ok('/price-lists', 'POST', {
    name: 'Repricing ' + randomUUID().slice(0, 8),
    currency,
    fallback: currency === 'PLN',
  });
  const root = '/price-lists/' + l.id + '/repricing';
  let rule = await ok(root, 'PUT', { version: 0, config: { fee_bps: 500, ...extra } });
  rule = await ok(root + '/inputs', 'PUT', {
    version: rule.version,
    items: [{ product_id: p.id, net_cost: 10000, source: 'Manual QA' }],
  });
  return { p, l, root, rule };
}
const preview = (f: any, ids = [f.p.id], key = randomUUID()) =>
  ok(f.root + '/previews', 'POST', { client_key: key, product_ids: ids });
const apply = (p: any) => ok('/repricing-previews/' + p.id + '/apply', 'POST', { confirmed: true });
async function editRule(f: any, config: any) {
  f.rule = await ok(f.root, 'PUT', {
    version: f.rule.version,
    config: { ...f.rule.config, ...config },
  });
}
async function input(f: any, extra: any = {}) {
  f.rule = await ok(f.root + '/inputs', 'PUT', {
    version: f.rule.version,
    items: [{ product_id: f.p.id, net_cost: 10000, source: 'Manual QA', ...extra }],
  });
}
async function price(f: any) {
  return (await ok('/pricing/quote', 'POST', { price_list_id: f.l.id, product_ids: [f.p.id] }))
    .items[0].price;
}
test('marża po prowizji, VAT i kosztach jest liczona w groszach, a minimum zawsze zaokrąglone w górę', () => {
  for (const vat of [0, 5, 8, 23])
    for (const cost of [0, 1, 10001, 100000000]) {
      const c = repricingConfig.parse({ fee_bps: 500, max_price: 100000000 });
      const r = calculateReprice(
        c,
        { id: 'p', sku: 'p', version: 1, active: true, kind: 'simple', vat },
        { net_cost: cost },
        20000,
        Date.now(),
      );
      if (r.state === 'blocked') {
        assert(cost > 60000000);
        continue;
      }
      assert(BigInt(r.proposed_price!) * 100n * 7500n >= BigInt(cost) * BigInt(100 + vat) * 10000n);
      assert(BigInt(r.floor!) * 100n * 8500n >= BigInt(cost) * BigInt(100 + vat) * 10000n);
    }
});
test('reguła docelowej marży → podgląd → atomowy cennik, concurrent replay nie zapisuje drugi raz', async () => {
  const f = await fixture(),
    p = await preview(f);
  assert.equal(p.result[0].proposed_price, 16400);
  assert.equal(p.result[0].floor, 14471);
  assert.equal(await price(f), 20000);
  const [a, b] = await Promise.all([apply(p), apply(p)]);
  assert.equal(a.id, b.id);
  assert.equal(a.applied_list_version, 2);
  assert.equal(await price(f), 16400);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action=$2',
        [p.id, 'repricing.apply'],
      )
    ).rows[0].n,
    1,
  );
});
test('replay podglądu ma stały zakres, ten sam klucz nie może wskazać innych SKU ani cennika', async () => {
  const f = await fixture(),
    key = randomUUID(),
    p = await preview(f, undefined, key);
  assert.equal((await preview(f, undefined, key)).id, p.id);
  const g = await fixture();
  assert.equal(
    (await req(g.root + '/previews', 'POST', { client_key: key, product_ids: [g.p.id] }))
      .statusCode,
    409,
  );
});
test('konkurencja niższa niż koszt nie omija minimum; ,99 respektuje maksimum', async () => {
  const f = await fixture({ strategy: 'competitor', ending: 99, max_price: 18000 });
  await input(f, { competitor_price: 10000, observed_at: new Date().toISOString() });
  let p = await preview(f);
  assert.equal(p.result[0].proposed_price, 14499);
  await apply(p);
  await input(f, { competitor_price: 50000, observed_at: new Date().toISOString() });
  p = await preview(f);
  assert.equal(p.result[0].proposed_price, 17999);
  await editRule(f, { max_price: 14480 });
  p = await preview(f);
  assert.equal(p.result[0].state, 'blocked');
  assert.equal(
    (await req('/repricing-previews/' + p.id + '/apply', 'POST', { confirmed: true })).statusCode,
    409,
  );
});
test('brak kosztu lub obserwacji oraz stary odczyt blokują całą partię bez częściowego zapisu', async () => {
  const f = await fixture({ strategy: 'competitor' }),
    g = await fixture();
  await input(f, { competitor_price: 18000, observed_at: new Date().toISOString() });
  const p = await preview(f, [f.p.id, g.p.id]);
  assert.equal(p.result.filter((i: any) => i.state === 'blocked').length, 1);
  assert.equal(
    (await req('/repricing-previews/' + p.id + '/apply', 'POST', { confirmed: true })).statusCode,
    409,
  );
  assert.equal(await price(f), 20000);
  await input(f, {
    competitor_price: 18000,
    observed_at: new Date(Date.now() - 7200000).toISOString(),
  });
  assert.equal((await preview(f)).result[0].state, 'blocked');
  await input(f);
  assert.equal((await preview(f)).result[0].state, 'blocked');
});
test('ważność obserwacji jest ponownie sprawdzana przy zapisie', async () => {
  const f = await fixture({ strategy: 'competitor', observation_minutes: 1 });
  await input(f, { competitor_price: 18000, observed_at: new Date().toISOString() });
  const p = await preview(f);
  await pool.query(
    "UPDATE repricing_inputs SET observed_at=now()-interval '2 minutes' WHERE price_list_id=$1",
    [f.l.id],
  );
  assert.equal(
    (await req('/repricing-previews/' + p.id + '/apply', 'POST', { confirmed: true })).statusCode,
    409,
  );
  assert.equal(await price(f), 20000);
});
test('edycja kosztu, reguły, cennika i produktu unieważnia podgląd', async () => {
  for (const mode of ['cost', 'rule', 'list', 'product']) {
    const f = await fixture(),
      p = await preview(f);
    if (mode === 'cost') await input(f, { net_cost: 12000 });
    if (mode === 'rule') await editRule(f, { min_margin_bps: 1100 });
    if (mode === 'list')
      await ok('/price-lists/' + f.l.id + '/items', 'PUT', {
        version: 1,
        items: [{ product_id: f.p.id, price: 19000 }],
      });
    if (mode === 'product')
      await pool.query('UPDATE products SET version=version+1,vat=8 WHERE id=$1', [f.p.id]);
    assert.equal(
      (await req('/repricing-previews/' + p.id + '/apply', 'POST', { confirmed: true })).statusCode,
      409,
      mode,
    );
  }
});
test('wyłączenie reguły lub cennika i wygasły podgląd blokują zapis', async () => {
  for (const mode of ['disabled', 'inactive', 'expired']) {
    const f = await fixture(),
      p = await preview(f);
    if (mode === 'disabled') await editRule(f, { enabled: false });
    if (mode === 'inactive')
      await pool.query('UPDATE price_lists SET active=false WHERE id=$1', [f.l.id]);
    if (mode === 'expired')
      await pool.query(
        "UPDATE repricing_previews SET expires_at=now()-interval '1 second' WHERE id=$1",
        [p.id],
      );
    assert.equal(
      (await req('/repricing-previews/' + p.id + '/apply', 'POST', { confirmed: true })).statusCode,
      409,
    );
  }
});
test('granice, zduplikowane SKU, przyszła obserwacja oraz wersje równoległych edycji są sprawdzane', async () => {
  const f = await fixture();
  for (const config of [
    { min_margin_bps: 3000, target_margin_bps: 2000 },
    { fee_bps: 5000, target_margin_bps: 5000 },
    { min_price: 101, max_price: 100 },
    { ending: 98 },
  ])
    assert.equal((await req(f.root, 'PUT', { version: f.rule.version, config })).statusCode, 422);
  assert.equal(
    (
      await req(f.root + '/inputs', 'PUT', {
        version: f.rule.version,
        items: [
          {
            product_id: f.p.id,
            net_cost: 1,
            source: 'QA',
            competitor_price: 1,
            observed_at: new Date(Date.now() + 60000).toISOString(),
          },
        ],
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req(f.root + '/previews', 'POST', {
        client_key: randomUUID(),
        product_ids: [f.p.id, f.p.id],
      })
    ).statusCode,
    422,
  );
  const results = await Promise.all([
    req(f.root, 'PUT', { version: f.rule.version, config: f.rule.config }),
    req(f.root, 'PUT', { version: f.rule.version, config: f.rule.config }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
});
test('osobna waluta wymaga jawnego kosztu, nie używa ceny katalogowej jako FX', async () => {
  const f = await fixture({}, 'EUR'),
    p = await preview(f);
  assert.equal(p.result[0].current_price, null);
  assert.equal(p.currency, 'EUR');
  await apply(p);
  assert.equal(await price(f), 16400);
  assert.equal(
    (await pool.query('SELECT price FROM products WHERE id=$1', [f.p.id])).rows[0].price,
    20000,
  );
});
test('kierunek i wykluczenie nieaktywnych SKU nie przepuszczają niedozwolonej zmiany', async () => {
  const f = await fixture({ direction: 'up' });
  assert.equal((await preview(f)).result[0].state, 'blocked');
  await editRule(f, { direction: 'down' });
  let p = await preview(f);
  await apply(p);
  p = await preview(f);
  assert.equal(p.result[0].state, 'unchanged');
  await apply(p);
  assert.equal((await ok('/price-lists/' + f.l.id + '/items')).list.version, 2);
  await pool.query('UPDATE products SET active=false WHERE id=$1', [f.p.id]);
  assert.equal((await preview(f)).result[0].state, 'blocked');
});
test('tenant RLS, obcy podgląd, viewer i zakresy publicznego API', async () => {
  const f = await fixture(),
    p = await preview(f);
  for (const path of [
    f.root,
    f.root + '/inputs',
    f.root + '/previews',
    '/repricing-previews/' + p.id,
  ])
    assert.equal((await req(path, 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (await req('/repricing-previews/' + p.id + '/apply', 'POST', { confirmed: true }, viewer))
      .statusCode,
    403,
  );
  assert.equal((await req(f.root, 'PUT', { version: 0, config: {} }, viewer)).statusCode, 403);
  await tenantTx(tenant, async (c) => {
    for (const table of ['repricing_rules', 'repricing_inputs', 'repricing_previews'])
      assert.equal(
        (await c.query('SELECT * FROM ' + table + ' WHERE tenant_id<>$1', [tenant])).rowCount,
        0,
      );
  });
  await tenantTx(SECOND_TENANT, async (c) => {
    for (const table of ['repricing_rules', 'repricing_inputs', 'repricing_previews'])
      assert.equal((await c.query('SELECT * FROM ' + table)).rowCount, 0);
  });
  await assert.rejects(
    tenantTx(SECOND_TENANT, (c) =>
      c.query('INSERT INTO repricing_rules(tenant_id,price_list_id,config) VALUES($1,$2,$3)', [
        tenant,
        randomUUID(),
        {},
      ]),
    ),
  );
  const k = await ok('/developer/keys', 'POST', {
    name: 'Repricing read',
    scopes: ['products:read'],
  });
  const headers = { authorization: 'Bearer ' + k.token };
  assert.equal(
    (await req('/v1/price-lists/' + f.l.id + '/repricing', 'GET', undefined, '', headers))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await req(
        '/v1/repricing-previews/' + p.id + '/apply',
        'POST',
        { confirmed: true },
        '',
        headers,
      )
    ).statusCode,
    403,
  );
  const spec = (await req('/v1/openapi')).json();
  assert(spec.paths['/price-lists/{id}/repricing']);
});
test('istniejące zamówienia zachowują kwoty sprzed repricingu', async () => {
  const f = await fixture(),
    r = await req(
      '/orders',
      'POST',
      {
        customer_name: 'Repricing QA',
        email: 'buyer@example.test',
        warehouse_id: warehouse,
        price_list_id: f.l.id,
        items: [{ product_id: f.p.id, quantity: 2 }],
      },
      cookie,
      { 'idempotency-key': randomUUID() },
    );
  assert.equal(r.statusCode, 201, r.body);
  const o = r.json();
  await apply(await preview(f));
  const after = await ok('/orders/' + o.id);
  assert.equal(after.total, o.total);
  assert.deepEqual(after.pricing_snapshot, o.pricing_snapshot);
  const r2 = await req(
    '/orders',
    'POST',
    {
      customer_name: 'Repricing QA',
      email: 'buyer@example.test',
      warehouse_id: warehouse,
      price_list_id: f.l.id,
      items: [{ product_id: f.p.id, quantity: 1 }],
    },
    cookie,
    { 'idempotency-key': randomUUID() },
  );
  assert.equal(r2.statusCode, 201, r2.body);
  assert.equal(r2.json().items[0].price, 16400);
});

test('partia 500 SKU jest atomowa, wejścia i historia mają kompletną paginację', async () => {
  const f = await fixture();
  const ids = await tenantTx(tenant, async (c) =>
    (
      await c.query(
        "INSERT INTO products(id,tenant_id,sku,name,price) SELECT gen_random_uuid(),$1,'RP-BATCH-'||g,'Repricing batch',20000 FROM generate_series(1,500) g RETURNING id",
        [tenant],
      )
    ).rows.map((p) => p.id),
  );
  f.rule = await ok(f.root + '/inputs', 'PUT', {
    version: f.rule.version,
    items: ids.map((id) => ({ product_id: id, net_cost: 10000, source: 'QA batch' })),
  });
  const start = performance.now(),
    p = await preview(f, ids);
  assert.equal(p.result.length, 500);
  await apply(p);
  const prices = (await ok('/price-lists/' + f.l.id + '/items?limit=100')).data;
  assert.equal(prices.length, 100);
  assert(prices.every((i: any) => i.price === 16400));
  let cursor: string | null = null,
    all: string[] = [];
  do {
    const page = await ok(f.root + '/inputs?limit=100' + (cursor ? '&after=' + cursor : ''));
    all.push(...page.data.map((i: any) => i.product_id));
    cursor = page.meta.cursor;
  } while (cursor);
  assert.equal(all.length, 501);
  assert.equal(new Set(all).size, 501);
  assert.equal(
    (
      await req(f.root + '/previews', 'POST', {
        client_key: randomUUID(),
        product_ids: [...ids, f.p.id],
      })
    ).statusCode,
    422,
  );
  for (let n = 0; n < 3; n++) await preview(f);
  let history = await ok(f.root + '/previews?limit=2');
  assert.equal(history.data.length, 2);
  assert(history.meta.cursor);
  history = await ok(f.root + '/previews?limit=2&after=' + history.meta.cursor);
  assert.equal(history.data.length, 2);
  assert.equal(history.meta.cursor, null);
  console.log(
    'Repricing 500 SKU preview/apply (local isolated DB): ' +
      Math.round(performance.now() - start) +
      'ms; not sustained capacity proof',
  );
});

test('zastosowany repricing trafia przez offer-sync do symulowanej oferty Woo bez HTTP dostawcy', async () => {
  const { encrypt } = await import('../server/security');
  const { processOfferSync } = await import('../server/offer-sync');
  const { processOfferJob } = await import('../server/offers');
  const f = await fixture(),
    channel = randomUUID();
  await tenantTx(tenant, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','Repricing simulation','sandbox',$3,$4)",
      [
        channel,
        tenant,
        encrypt({ consumer_key: 'fixture', consumer_secret: 'fixture' }),
        JSON.stringify({ store_url: 'https://shop.example', simulation: true }),
      ],
    ),
  );
  await ok('/integrations/' + channel + '/mappings', 'POST', {
    external_id: '900123',
    sku: f.p.sku,
  });
  await ok('/integrations/' + channel + '/offer-sync', 'PATCH', {
    version: 0,
    enabled: true,
    warehouse_id: warehouse,
    price_list_id: f.l.id,
    stock: false,
    price: true,
    interval_seconds: 30,
    verify_seconds: 60,
  });
  await apply(await preview(f));
  const job = await ok('/integrations/' + channel + '/offer-sync', 'POST', {});
  const claim = async (id: string) =>
    (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
        [id, randomUUID()],
      )
    ).rows[0];
  const noHttp = {
    transport: async () => {
      throw Error('Unexpected provider HTTP');
    },
  };
  await processOfferSync(await claim(job.id), noHttp);
  const plan = (await pool.query('SELECT * FROM offer_plans WHERE channel_id=$1', [channel]))
    .rows[0];
  assert.equal(plan.payload.regular_price, '164.00');
  await processOfferJob(await claim(plan.job_id), noHttp);
  const done = (await pool.query('SELECT state,result FROM offer_plans WHERE id=$1', [plan.id]))
    .rows[0];
  assert.equal(done.state, 'done');
  assert.equal(done.result.scope, 'local_simulation');
  await pool.query('UPDATE offer_sync_configs SET enabled=false WHERE channel_id=$1', [channel]);
});

test('podgląd odtworzonej kopii odczytuje reguły, ale blokuje zastosowanie i edycję', async () => {
  const f = await fixture(),
    p = await preview(f),
    copy = await buildApp({ readOnly: true });
  try {
    const login = await copy.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'repricing-test@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200);
    const copyCookie = String(login.headers['set-cookie']).split(';')[0];
    assert.equal(
      (await copy.inject({ url: '/api' + f.root, headers: { cookie } })).statusCode,
      401,
    );
    const request = (path: string, method: any = 'GET', payload?: any) =>
      copy.inject({ url: '/api' + path, method, payload, headers: { cookie: copyCookie } });
    assert.equal((await request(f.root)).statusCode, 200);
    assert.equal((await request('/repricing-previews/' + p.id)).statusCode, 200);
    assert.equal(
      (await request(f.root, 'PUT', { version: f.rule.version, config: f.rule.config })).statusCode,
      423,
    );
    assert.equal(
      (await request('/repricing-previews/' + p.id + '/apply', 'POST', { confirmed: true }))
        .statusCode,
      423,
    );
  } finally {
    await copy.close();
  }
});
