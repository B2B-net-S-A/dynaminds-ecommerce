import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { encrypt } from '../server/security';
import { tick } from '../server/worker';
import { offerSnapshotHash, processOfferJob } from '../server/offers';
import { processVariantBatch } from '../server/variant-offer-batches';
import { Allegro } from '../server/integrations';
import {
  allegroSettingsReadScope,
  allegroCreationInput,
  allegroCreationContext,
} from '../server/allegro-creation';
import {
  readScopes,
  offerWriteScope,
  type IntegrationContext,
} from '../server/channel-access';
assert.equal(process.env.DYNA_TEST, 'true');
const ids = Array.from({ length: 5 }, (_, i) => '10000000-0000-4000-8000-00000000000' + (i + 1));
const input = {
  product_id: ids[0],
  shipping_rate_id: ids[1],
  return_policy_id: ids[2],
  implied_warranty_id: ids[3],
  responsible_producer_id: ids[4],
  handling_time: 'PT24H',
  safety_information: 'Instrukcja bezpieczeństwa syntetycznego produktu QA.',
  parameters: [{ id: '11323', valuesIds: ['11323_1'] }],
};
const definitions = [
  {
    id: '11323',
    name: 'Stan',
    type: 'dictionary',
    required: true,
    options: { describesProduct: false },
    restrictions: { multipleChoices: false },
    dictionary: [{ id: '11323_1', value: 'Nowy' }],
  },
];
const store = new Map<string, any>(),
  calls: { path: string; method: string; body: any; query: URLSearchParams }[] = [];
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  viewer = '',
  other = '',
  tenant = '',
  user = '',
  warehouse = '',
  next = 30000;
let requestClient = 1;
let lost = false,
  rejectPost = false,
  pending = false,
  operationDone = false,
  invalidLocation = false,
  noId = false,
  resourceChanged = false,
  alterAfterWrite = false,
  readUnauthorized = false,
  hidden = false,
  duplicate = false;
const operationId = '20000000-0000-4000-8000-000000000001';
let settingChanged = '',
  rejectPatchId = '';
let lostPatch = false;
const json = (v: any, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(v), { status, headers });
const ctx: IntegrationContext = {
  oauthConfig: () => ({
    clientId: 'test',
    clientSecret: 'fixture',
    redirectUri: 'http://127.0.0.1:4100/api/oauth/allegro/callback',
  }),
  transport: async (url, init) => {
    const u = new URL(url),
      method = init.method ?? 'GET',
      body = init.body
        ? u.pathname.includes('oauth/token')
          ? Object.fromEntries(new URLSearchParams(String(init.body)))
          : JSON.parse(String(init.body))
        : null;
    calls.push({ path: u.pathname, method, body, query: u.searchParams });
    assert.equal(
      u.hostname,
      u.pathname === '/auth/oauth/token'
        ? 'allegro.pl.allegrosandbox.pl'
        : 'api.allegro.pl.allegrosandbox.pl',
    );
    if (u.pathname === '/auth/oauth/token')
      return json({
        access_token: 'renewed',
        refresh_token: 'renewed-refresh',
        expires_in: 3600,
        scope: [readScopes, offerWriteScope, allegroSettingsReadScope].join(' '),
      });
    if (u.pathname === '/sale/products')
      return json({
        products: [{ id: ids[0], name: 'Produkt katalogowy QA', category: { id: '123' } }],
        nextPage: { id: u.searchParams.has('page.id') ? null : 'page-two' },
      });
    if (u.pathname === '/sale/products/' + ids[0])
      return json({
        id: ids[0],
        name: resourceChanged ? 'Zmiana katalogowa' : 'Produkt katalogowy QA',
        category: { id: '123' },
      });
    if (u.pathname === '/sale/categories/123/parameters')
      return json({
        parameters: [
          ...definitions,
          { id: '1234', name: 'EAN', options: { describesProduct: true } },
        ],
      });
    const resources: Record<string, [string, string]> = {
      '/sale/shipping-rates': ['shippingRates', ids[1]],
      '/after-sales-service-conditions/return-policies': ['returnPolicies', ids[2]],
      '/after-sales-service-conditions/implied-warranties': ['impliedWarranties', ids[3]],
      '/sale/responsible-producers': ['responsibleProducers', ids[4]],
    };
    for (const [path, [key, id]] of Object.entries(resources)) {
      if (u.pathname === path) return json({ [key]: [{ id, name: 'Ustawienie QA' }] });
      if (u.pathname === path + '/' + id)
        return json({ id, name: 'Ustawienie QA', version: settingChanged === path ? 2 : 1 });
    }
    if (u.pathname === '/sale/offers') {
      const rows = hidden
        ? []
        : [...store.values()].filter((r) => r.external.id === u.searchParams.get('external.id'));
      return json({
        offers: duplicate ? [...rows, ...rows] : rows.map((r) => ({ id: r.id })),
        totalCount: duplicate ? 2 : rows.length,
      });
    }
    if (u.pathname.includes('/operations/'))
      return operationDone
        ? new Response(null, {
            status: 303,
            headers: { location: 'https://evil.example/never-follow' },
          })
        : json({}, 202);
    if (u.pathname === '/sale/product-offers' && method === 'POST') {
      if (rejectPost) return json({ secret: 'PROVIDER_BODY_NEVER_LOG' }, 422);
      const id = String(next++),
        r = { id, ...structuredClone(body) };
      store.set(id, r);
      if (alterAfterWrite) r.delivery.handlingTime = 'P2D';
      if (lost) {
        lost = false;
        throw new Error('Lost response with fixture token secret');
      }
      if (pending)
        return json(noId ? {} : { id }, 202, {
          location: invalidLocation
            ? 'https://evil.example/operations/' + operationId
            : `/sale/product-offers/${id}/operations/${operationId}`,
        });
      return json(noId ? {} : { id }, 201);
    }
    if (u.pathname.startsWith('/sale/product-offers/') && method === 'PATCH') {
      const id = u.pathname.split('/').at(-1)!;
      assert.deepEqual(body, { publication: { status: 'ACTIVE' } });
      if (id === rejectPatchId) return json({}, 422);
      const r = store.get(id);
      if (!r) return json({}, 404);
      r.publication = structuredClone(body.publication);
      if (lostPatch) {
        lostPatch = false;
        throw new Error('Lost PATCH response QA');
      }
      if (pending)
        return json({}, 202, { location: `/sale/product-offers/${id}/operations/${operationId}` });
      return json(r);
    }
    if (u.pathname.startsWith('/sale/product-offers/') && method === 'GET') {
      if (readUnauthorized) {
        readUnauthorized = false;
        return json({}, 401);
      }
      return store.has(u.pathname.split('/').at(-1)!)
        ? json(store.get(u.pathname.split('/').at(-1)!))
        : json({}, 404);
    }
    throw new Error('Unexpected request ' + u.pathname);
  },
};
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie, headers: any = {}) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    remoteAddress: '127.0.1.' + requestClient,
    headers: { cookie: auth, ...headers },
  });
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await req(path, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport, oauthConfig: ctx.oauthConfig });
  const r = await req('/auth/signup', 'POST', {
    email: 'allegro-creation@demo.local',
    password: 'DynaDemo!2026',
    name: 'Allegro creation QA',
    organization: { name: 'Allegro creation QA' },
  });
  assert.equal(r.statusCode, 201, r.body);
  cookie = r.headers['set-cookie']!.toString().split(';')[0];
  const me = (await ok('/auth/me')).user;
  tenant = me.tenant_id;
  user = me.id;
  await ok('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
  warehouse = (await ok('/warehouses')).data[0].id;
  for (const email of ['viewer@demo.local', 'other@demo.local']) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' });
    if (email.startsWith('viewer')) viewer = r.headers['set-cookie']!.toString().split(';')[0];
    else other = r.headers['set-cookie']!.toString().split(';')[0];
  }
});
beforeEach(async () => {
  // Independent tests are independent clients; retain the real rate-limit middleware.
  requestClient++;
  settingChanged = '';
  rejectPatchId = '';
  lostPatch = false;
  store.clear();
  calls.length = 0;
  lost =
    rejectPost =
    pending =
    operationDone =
    invalidLocation =
    noId =
    resourceChanged =
    alterAfterWrite =
    readUnauthorized =
    hidden =
    duplicate =
      false;
  await pool.query("UPDATE jobs SET run_at='2100-01-01' WHERE state='pending'");
});
after(async () => {
  await app.close();
  await pool.end();
});
async function fixture(simulation = false) {
  const ch = randomUUID();
  await tenantTx(tenant, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,name,provider,mode,settings,credentials,oauth_scopes,token_expires_at) VALUES($1,$2,'Allegro QA','allegro','sandbox',$3,$4,$5,now()+interval '1 hour')",
      [
        ch,
        tenant,
        JSON.stringify({ simulation }),
        encrypt({ access_token: 'fixture', refresh_token: 'refresh' }),
        [readScopes, offerWriteScope, allegroSettingsReadScope].join(' '),
      ],
    ),
  );
  const p = await ok('/products', 'POST', {
    sku: 'A-CREATE-' + randomUUID().slice(0, 8),
    name: 'Nowy produkt ofertowy QA',
    price: 12300,
    vat: 23,
    quantity: 12,
    warehouse_id: warehouse,
  });
  return { ch, p };
}
async function preview(f: any, extra: any = {}) {
  return req('/integrations/' + f.ch + '/offers/preview', 'POST', {
    product_id: f.p.id,
    warehouse_id: warehouse,
    operation: 'create_draft',
    allegro: input,
    ...extra,
  });
}
async function plan(f: any, extra: any = {}) {
  const r = await preview(f, extra);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function queue(p: any) {
  return ok('/offer-plans/' + p.id + '/queue', 'POST', {});
}
async function row(p: any) {
  return tenantTx(
    tenant,
    async (c) => (await c.query('SELECT * FROM offer_plans WHERE id=$1', [p.id])).rows[0],
  );
}
async function due() {
  await pool.query("UPDATE jobs SET run_at=now() WHERE state='pending' AND kind='offer.write'");
}
const posts = () =>
  calls.filter((c) => c.method === 'POST' && c.path === '/sale/product-offers').length;

test('katalog i ustawienia sprzedawcy używają oficjalnych GET oraz paginacji', async () => {
  const f = await fixture();
  let r = await ok('/integrations/' + f.ch + '/allegro/catalog?phrase=5901234123457');
  assert.equal(r.meta.cursor, 'page-two');
  r = await ok('/integrations/' + f.ch + '/allegro/catalog?phrase=test&after=page-two');
  assert.equal(r.meta.cursor, null);
  for (const resource of ['shipping', 'returns', 'warranties', 'producers'])
    assert.equal(
      (await ok('/integrations/' + f.ch + '/allegro/creation-options?resource=' + resource)).data
        .length,
      1,
    );
  assert.equal(
    (await ok('/integrations/' + f.ch + '/allegro/offer-parameters?product_id=' + ids[0])).data
      .length,
    1,
  );
  assert(calls.every((c) => c.method === 'GET'));
  assert.equal(
    calls.find((c) => c.path === '/sale/shipping-rates')!.query.get('marketplace'),
    'allegro-pl',
  );
  assert.equal(
    (await req('/integrations/' + f.ch + '/allegro/creation-options?resource=returns&offset=60'))
      .statusCode,
    422,
  );
});
test('nowy szkic zachowuje katalog, cenę brutto, dostępny stan, GPSR i warunki sprzedawcy', async () => {
  const f = await fixture(),
    p = await plan(f);
  assert.equal(p.payload.publication.status, 'INACTIVE');
  assert.equal(p.payload.productSet[0].product.id, ids[0]);
  assert.equal(p.payload.external.id, 'dyna-' + p.id);
  assert.equal(p.payload.sellingMode.price.amount, '123.00');
  assert.equal(p.payload.stock.available, 12);
  assert.equal(posts(), 0);
  await queue(p);
  await tick(ctx);
  const done = await row(p);
  assert.equal(done.state, 'done');
  assert.equal(posts(), 1);
  assert.equal(done.result.desired_applied, true);
  const listing = await tenantTx(
    tenant,
    async (c) => (await c.query('SELECT * FROM listings WHERE id=$1', [done.listing_id])).rows[0],
  );
  assert.equal(listing.status, 'INACTIVE');
  assert.equal(listing.price_currency, 'PLN');
  assert.equal((await req('/offer-plans/' + p.id + '/queue', 'POST', {})).statusCode, 200);
  assert.equal(posts(), 1);
});
test('tytuł, waluta, parametry i jawne dane sprzedawcy są wymagane', async () => {
  const f = await fixture();
  for (const extra of [
    { allegro: undefined },
    { stock: false },
    { allegro: { ...input, handling_time: 'PT48H' } },
    { allegro: { ...input, safety_information: '' } },
    { allegro: { ...input, parameters: [] } },
    { allegro: { ...input, parameters: [{ id: '11323', valuesIds: ['unknown'] }] } },
    { allegro: { ...input, parameters: [...input.parameters, ...input.parameters] } },
  ])
    assert.equal((await preview(f, extra)).statusCode, 422);
  await tenantTx(tenant, (c) => c.query("UPDATE products SET name='Krótki' WHERE id=$1", [f.p.id]));
  assert.equal((await preview(f)).statusCode, 422);
  assert.equal(posts(), 0);
});
test('brak odczytu ustawień lub prawa zapisu OAuth nie omija bramki', async () => {
  const f = await fixture();
  await tenantTx(tenant, (c) =>
    c.query('UPDATE channels SET oauth_scopes=$2 WHERE id=$1', [
      f.ch,
      readScopes + ' ' + offerWriteScope,
    ]),
  );
  assert.equal((await preview(f)).statusCode, 422);
  await tenantTx(tenant, (c) =>
    c.query('UPDATE channels SET oauth_scopes=$2 WHERE id=$1', [
      f.ch,
      readScopes + ' ' + allegroSettingsReadScope,
    ]),
  );
  const p = await plan(f);
  assert.equal((await req('/offer-plans/' + p.id + '/queue', 'POST', {})).statusCode, 422);
  assert.equal(posts(), 0);
  const url = await ok('/integrations/' + f.ch + '/oauth/start', 'POST', { offers_write: true });
  assert(new URL(url.url).searchParams.get('scope')!.includes(allegroSettingsReadScope));
});
test('zmiana lokalnego stanu unieważnia podgląd przed kolejką', async () => {
  const f = await fixture(),
    p = await plan(f);
  await ok('/orders', 'POST', {
    channel: 'QA',
    customer_name: 'Buyer QA',
    email: 'buyer-qa@demo.local',
    warehouse_id: warehouse,
    items: [{ product_id: f.p.id, quantity: 2 }],
  });
  assert.equal((await req('/offer-plans/' + p.id + '/queue', 'POST', {})).statusCode, 409);
  const fresh = await plan(f);
  assert.equal(fresh.payload.stock.available, 10);
  assert.equal(posts(), 0);
});
test('zmiana katalogu pomiędzy podglądem a POST zatrzymuje zapis', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  resourceChanged = true;
  await tick(ctx);
  assert.equal((await row(p)).state, 'conflict');
  assert.equal(posts(), 0);
});
test('zmiana treści dostawy, zwrotów, reklamacji lub producenta zatrzymuje POST', async () => {
  for (const path of [
    '/sale/shipping-rates',
    '/after-sales-service-conditions/return-policies',
    '/after-sales-service-conditions/implied-warranties',
    '/sale/responsible-producers',
  ]) {
    settingChanged = '';
    rejectPatchId = '';
    lostPatch = false;
    const f = await fixture(),
      p = await plan(f);
    await queue(p);
    settingChanged = path;
    await tick(ctx);
    assert.equal((await row(p)).state, 'conflict');
    assert.equal(posts(), 0);
  }
});
test('niespójna lista znacznika nie potwierdza tworzenia', async () => {
  for (const data of [
    { offers: [], totalCount: 1 },
    { offers: [{ id: '123' }], totalCount: 0 },
    { offers: [], totalCount: -1 },
  ]) {
    const client = new Allegro('sandbox', { access_token: 'fixture' }, async () => json(data));
    await assert.rejects(client.offersByExternalId('dyna-' + randomUUID()), /Niejednoznaczny/);
  }
});
test('utrata odpowiedzi POST uzgadnia znacznik bez tworzenia duplikatu', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  lost = true;
  await tick(ctx);
  assert.equal((await row(p)).phase, 'write_started');
  await due();
  await tick(ctx);
  assert.equal((await row(p)).state, 'done');
  assert.equal(posts(), 1);
  assert.equal(store.size, 1);
});
test('niewidoczny niepewny wynik blokuje ponowny POST i nowy plan tego SKU', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  lost = true;
  await tick(ctx);
  hidden = true;
  await due();
  await tick(ctx);
  assert.equal((await row(p)).state, 'failed');
  assert.equal(posts(), 1);
  const next = await plan(f);
  assert.equal((await req('/offer-plans/' + next.id + '/queue', 'POST', {})).statusCode, 409);
  hidden = false;
  await ok('/offer-plans/' + p.id + '/reconcile', 'POST', {});
  await tick(ctx);
  assert.equal((await row(p)).state, 'done');
  assert.equal(posts(), 1);
});
test('odmowa POST nie prowadzi do kolejnego tworzenia w retry', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  rejectPost = true;
  await tick(ctx);
  await due();
  await tick(ctx);
  assert.equal((await row(p)).state, 'failed');
  assert.equal(posts(), 1);
  assert(!(await row(p)).error.includes('PROVIDER_BODY'));
});
test('202 zachowuje ID operacji, oczekuje i potwierdza przez GET bez POST', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  pending = true;
  await tick(ctx);
  assert.equal((await row(p)).operation_id, operationId);
  assert.equal((await row(p)).phase, 'verify');
  assert.equal((await row(p)).state, 'queued');
  operationDone = true;
  await due();
  await tick(ctx);
  assert.equal((await row(p)).state, 'done');
  assert.equal(posts(), 1);
});
test('niezaufany Location oraz brak ID odzyskują wyłącznie przez własny znacznik', async () => {
  for (const mode of ['bad-location', 'missing-id']) {
    const f = await fixture(),
      p = await plan(f);
    await queue(p);
    pending = mode === 'bad-location';
    invalidLocation = pending;
    noId = true;
    await tick(ctx);
    if ((await row(p)).state === 'failed')
      await ok('/offer-plans/' + p.id + '/reconcile', 'POST', {});
    else await due();
    pending = false;
    invalidLocation = false;
    noId = false;
    await tick(ctx);
    assert.equal((await row(p)).state, 'done');
  }
  assert.equal(posts(), 2);
  assert(calls.every((c) => !c.path.includes('evil')));
});
test('niezgodny odczyt nie dostaje statusu potwierdzonego i pozwala uzgodnić zaobserwowany wynik', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  alterAfterWrite = true;
  await tick(ctx);
  assert.equal((await row(p)).state, 'failed');
  await ok('/offer-plans/' + p.id + '/reconcile', 'POST', { accept_observed: true });
  await tick(ctx);
  const done = await row(p);
  assert.equal(done.state, 'done');
  assert.equal(done.result.desired_applied, false);
  assert.equal(done.result.scope, 'external_api_observed');
  assert.equal(posts(), 1);
});
test('duplikaty znacznika u dostawcy blokują automatyczne powiązanie', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  lost = true;
  await tick(ctx);
  duplicate = true;
  await due();
  await tick(ctx);
  assert.equal((await row(p)).state, 'failed');
  assert.equal((await row(p)).listing_id, null);
  assert.equal(posts(), 1);
});
test('utrata roli autora przed POST i zmiana połączenia nie wykonują zapisu', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    user,
  ]);
  await tick(ctx);
  assert.equal(posts(), 0);
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    user,
  ]);
  const f2 = await fixture(),
    p2 = await plan(f2);
  await queue(p2);
  await tenantTx(tenant, (c) =>
    c.query(
      'UPDATE channels SET settings=settings||\'{"oauth_connection_id":"changed"}\'::jsonb WHERE id=$1',
      [f2.ch],
    ),
  );
  await tick(ctx);
  assert.equal(posts(), 0);
});
test('stary lease nie wykonuje POST ani nie zapisuje powiązania', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  const r = await row(p),
    job = (
      await pool.query(
        "UPDATE jobs SET state='running',lease_token=$2,attempts=1 WHERE id=$1 RETURNING *",
        [r.job_id, randomUUID()],
      )
    ).rows[0];
  await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, randomUUID()]);
  await processOfferJob(job, ctx);
  assert.equal(posts(), 0);
  assert.equal((await row(p)).listing_id, null);
});
test('RLS i administrator ograniczają katalog oraz zapisy; publiczne API zachowuje zakresy', async () => {
  const f = await fixture();
  assert.equal(
    (await req('/integrations/' + f.ch + '/allegro/catalog?phrase=test', 'GET', undefined, other))
      .statusCode,
    404,
  );
  assert.equal(
    (await req('/integrations/' + f.ch + '/allegro/catalog?phrase=test', 'GET', undefined, viewer))
      .statusCode,
    403,
  );
  const key = await ok('/developer/keys', 'POST', {
    name: 'Allegro readonly',
    scopes: ['products:read'],
  });
  let r = await app.inject({
    url: '/api/v1/integrations/' + f.ch + '/allegro/catalog?phrase=test',
    headers: { authorization: 'Bearer ' + key.token },
  });
  assert.equal(r.statusCode, 200, r.body);
  r = await app.inject({
    url: '/api/v1/integrations/' + f.ch + '/offers/preview',
    method: 'POST',
    headers: { authorization: 'Bearer ' + key.token },
    payload: {
      product_id: f.p.id,
      warehouse_id: warehouse,
      operation: 'create_draft',
      allegro: input,
    },
  });
  assert.equal(r.statusCode, 403);
});
test('symulacja szkicu → publikacja → synchronizacja działa bez HTTP dostawcy', async () => {
  const f = await fixture(true),
    p = await plan(f);
  await queue(p);
  await tick(ctx);
  let r = await row(p);
  assert.equal(r.state, 'done');
  const publish = await preview(f, {
    listing_id: r.listing_id,
    operation: 'publish',
    allegro: undefined,
  });
  assert.equal(publish.statusCode, 200, publish.body);
  await queue(publish.json());
  await tick(ctx);
  assert.equal((await row(publish.json())).state, 'done');
  assert.equal(calls.length, 0);
});
test('producent ma kompletne strony bez pobierania całego konta do pamięci', async () => {
  const client = new Allegro('sandbox', { access_token: 'fixture' }, async (_url, init) => {
    assert.equal(init.method, 'GET');
    return json({
      responsibleProducers: Array.from({ length: 100 }, () => ({ id: randomUUID(), name: 'QA' })),
    });
  });
  assert.equal((await client.creationOptions('producers', 0)).meta.cursor, 100);
  assert.equal((await client.creationOptions('producers', 50000)).meta.cursor, null);
});
test('tworzenie ogranicza odpowiedź do 5 MB i obsługuje 202 bez JSON', async () => {
  const large = new Allegro(
    'sandbox',
    { access_token: 'fixture' },
    async () => new Response('x'.repeat(5 * 1024 * 1024 + 1), { status: 201 }),
  );
  await assert.rejects(large.createDraft({}), /przekracza 5 MB/);
  const accepted = new Allegro(
    'sandbox',
    { access_token: 'fixture' },
    async () =>
      new Response(null, {
        status: 202,
        headers: { location: '/sale/product-offers/12345/operations/' + operationId },
      }),
  );
  assert.deepEqual(await accepted.createDraft({}), { id: '12345', operationId });
});
test('401 po POST rotuje token i ponawia wyłącznie odczyt potwierdzenia', async () => {
  const f = await fixture(),
    p = await plan(f);
  await queue(p);
  readUnauthorized = true;
  await tick(ctx);
  await due();
  await tick(ctx);
  assert.equal((await row(p)).state, 'done');
  assert.equal(posts(), 1);
  assert.equal(calls.filter((c) => c.path === '/auth/oauth/token').length, 1);
});
test('cennik EUR blokuje tworzenie Allegro PL bez przeliczenia FX', async () => {
  const f = await fixture(),
    list = await ok('/price-lists', 'POST', { name: 'EUR QA', currency: 'EUR', fallback: false });
  await ok('/price-lists/' + list.id + '/items', 'PUT', {
    version: 1,
    items: [{ product_id: f.p.id, price: 10000 }],
  });
  assert.equal((await preview(f, { price_list_id: list.id })).statusCode, 422);
  assert.equal(posts(), 0);
});
test('współbieżne plany jednego SKU tworzą tylko jeden szkic', async () => {
  const f = await fixture(),
    plans = await Promise.all([plan(f), plan(f)]),
    responses = await Promise.all(
      plans.map((p) => req('/offer-plans/' + p.id + '/queue', 'POST', {})),
    );
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  await tick(ctx);
  assert.equal(posts(), 1);
  assert.equal(store.size, 1);
});
test('parametry kategorii obejmują zakresy, wiele wartości i wymagania warunkowe', async () => {
  const defs = [
    ...definitions,
    {
      id: '99',
      name: 'Waga',
      type: 'float',
      restrictions: { range: true, min: 0, max: 100, precision: 2 },
      options: { describesProduct: false },
      required: false,
    },
    {
      id: '98',
      name: 'Kody',
      type: 'string',
      restrictions: { minLength: 2, maxLength: 5, allowedNumberOfValues: 3 },
      options: { describesProduct: false },
      required: false,
    },
    {
      id: '97',
      name: 'Typ',
      type: 'string',
      options: { describesProduct: false },
      requiredIf: {
        parametersWithValue: [{ id: '11323', oneOfValueIds: ['11323_1'] }],
        parametersWithoutValue: [],
      },
    },
  ];
  const client = {
    catalogProduct: async () => ({ id: ids[0], name: 'QA', category: { id: '123' } }),
    creationResource: async (_path: string, id: string) => ({ id, name: 'QA' }),
    categoryOfferParameters: async () => defs,
  } as unknown as Allegro;
  const parameters = [
    ...input.parameters,
    { id: '99', rangeValue: { from: '1.01', to: '2.02' } },
    { id: '98', values: ['AA', 'BB'] },
    { id: '97', values: ['type'] },
  ];
  await allegroCreationContext(client, allegroCreationInput.parse({ ...input, parameters }));
  for (const invalid of [
    parameters.filter((p) => p.id !== '97'),
    [...parameters.filter((p) => p.id !== '99'), { id: '99', rangeValue: { from: '3', to: '2' } }],
    [
      ...parameters.filter((p) => p.id !== '99'),
      { id: '99', rangeValue: { from: '1.001', to: '2' } },
    ],
    [...parameters.filter((p) => p.id !== '98'), { id: '98', values: ['A'] }],
  ])
    await assert.rejects(() =>
      allegroCreationContext(client, allegroCreationInput.parse({ ...input, parameters: invalid })),
    );
});

async function batchFixture(count = 3, simulation = false) {
  const f = await fixture(simulation),
    products = [f.p];
  for (let n = 1; n < count; n++)
    products.push(
      await ok('/products', 'POST', {
        sku: 'BATCH-' + randomUUID().slice(0, 8),
        name: 'Produkt partii ofertowej ' + n,
        price: 10000 + n,
        vat: 23,
        quantity: 10,
        warehouse_id: warehouse,
      }),
    );
  const body = {
    name: 'Partia QA',
    warehouse_id: warehouse,
    client_key: randomUUID(),
    items: products.map((p) => ({ product_id: p.id, allegro: input })),
  };
  const b = await ok('/integrations/' + f.ch + '/allegro-batches', 'POST', body);
  return { ...f, products, body, b };
}
async function batchDetail(b: any) {
  return ok('/allegro-batches/' + b.id);
}
async function batchTicks(f: any, states: string[], max = 100) {
  for (let n = 0; n < max; n++) {
    const d = await batchDetail(f.b);
    if (states.includes(d.batch.state)) return d;
    await pool.query(
      "UPDATE jobs SET run_at=CASE WHEN kind='offer.write' THEN now()-interval '1 second' ELSE now() END WHERE state='pending' AND tenant_id=$1 AND (payload->>'batch_id'=$2 OR kind='offer.write' AND payload->>'channel_id'=$3)",
      [tenant, f.b.id, f.ch],
    );
    await tick(ctx);
  }
  assert.fail('Partia nie osiągnęła ' + states.join('/'));
}
test('partia Allegro przygotowuje każde SKU bez POST, a zatwierdzenie tworzy jedną ofertę na SKU', async () => {
  const f = await batchFixture(),
    d = await batchTicks(f, ['review']);
  assert.deepEqual(d.counts, { preview: 3 });
  assert.equal(posts(), 0);
  assert(d.data.every((i: any) => i.payload.publication.status === 'INACTIVE'));
  const response = await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  assert.equal(response.state, 'queued');
  const done = await batchTicks(f, ['done']);
  assert.deepEqual(done.counts, { done: 3 });
  assert.equal(posts(), 3);
  assert.equal(
    (
      await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
        version: d.batch.version,
        confirm_external: true,
      })
    ).state,
    'done',
  );
  assert.equal(posts(), 3);
});
test('partia ma atomowy replay, deduplikację SKU i walidację firmy/roli', async () => {
  const f = await batchFixture(1);
  const responses = await Promise.all([
    req('/integrations/' + f.ch + '/allegro-batches', 'POST', f.body),
    req('/integrations/' + f.ch + '/allegro-batches', 'POST', f.body),
  ]);
  assert(responses.every((r) => r.statusCode === 201 && r.json().id === f.b.id));
  assert.equal(
    (await req('/integrations/' + f.ch + '/allegro-batches', 'POST', { ...f.body, name: 'Inne' }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await req('/integrations/' + f.ch + '/allegro-batches', 'POST', {
        ...f.body,
        client_key: randomUUID(),
        items: [...f.body.items, ...f.body.items],
      })
    ).statusCode,
    422,
  );
  assert.equal((await req('/allegro-batches/' + f.b.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal((await req('/allegro-batches/' + f.b.id, 'GET', undefined, viewer)).statusCode, 403);
  assert.equal(
    (await req('/integrations/' + f.ch + '/allegro-batches', 'POST', f.body, other)).statusCode,
    404,
  );
});
test('błędny podgląd i istniejące powiązanie nie zatrzymują poprawnych SKU partii', async () => {
  const f = await batchFixture();
  await pool.query("UPDATE jobs SET run_at='2100-01-01' WHERE id=$1", [f.b.job_id]);
  const p = await plan({ ch: f.ch, p: f.products[0] });
  await queue(p);
  await tick(ctx);
  await pool.query("UPDATE products SET name='X' WHERE id=$1", [f.products[1].id]);
  const d = await batchTicks(f, ['review']);
  assert.deepEqual(d.counts, { failed: 1, preview: 1, skipped: 1 });
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  const final = await batchTicks(f, ['partial']);
  assert.deepEqual(final.counts, { done: 1, failed: 1, skipped: 1 });
  assert.equal(posts(), 2);
});
test('potwierdzenie partii wymaga zgody zewnętrznej i świeżych planów', async () => {
  const f = await batchFixture(1),
    d = await batchTicks(f, ['review']);
  assert.equal(
    (await req('/allegro-batches/' + f.b.id + '/queue', 'POST', { version: d.batch.version }))
      .statusCode,
    422,
  );
  await pool.query("UPDATE offer_plans SET created_at=now()-interval '31 minutes' WHERE id=$1", [
    d.data[0].plan_id,
  ]);
  assert.equal(
    (
      await req('/allegro-batches/' + f.b.id + '/queue', 'POST', {
        version: d.batch.version,
        confirm_external: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(posts(), 0);
});
test('rezerwacja po podglądzie unieważnia tylko właściwą pozycję partii', async () => {
  const f = await batchFixture(),
    d = await batchTicks(f, ['review']);
  await ok('/orders', 'POST', {
    customer_name: 'Batch reservation',
    email: 'batch-buyer@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: f.products[0].id, quantity: 1 }],
  });
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  const result = await batchTicks(f, ['partial']);
  assert.deepEqual(result.counts, { done: 2, failed: 1 });
  assert.equal(posts(), 2);
});
test('raport partii po niepewnym POST odczytuje uzgodnione plany bez nowego POST', async () => {
  const f = await batchFixture(1),
    d = await batchTicks(f, ['review']);
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  lost = true;
  hidden = true;
  const partial = await batchTicks(f, ['partial']);
  assert.equal(posts(), 1);
  assert.equal(partial.counts.failed, 1);
  hidden = false;
  await ok('/offer-plans/' + partial.data[0].plan_id + '/reconcile', 'POST', {});
  await due();
  await tick(ctx);
  await ok('/allegro-batches/' + f.b.id + '/recheck', 'POST', { version: partial.batch.version });
  assert.equal((await batchTicks(f, ['done'])).counts.done, 1);
  assert.equal(posts(), 1);
});
test('przerwanie i utrata roli zatrzymują kolejne pozycje oraz pozwalają wznowić od checkpointu', async () => {
  const f = await batchFixture(3);
  await tick(ctx);
  const initial = await batchDetail(f.b);
  assert.equal(initial.counts.preview, 1);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    user,
  ]);
  await tick(ctx);
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    user,
  ]);
  const failed = await batchDetail(f.b);
  assert.equal(failed.batch.state, 'failed');
  await ok('/allegro-batches/' + f.b.id + '/retry', 'POST', { version: failed.batch.version });
  const resumed = await batchTicks(f, ['review']);
  assert.equal(resumed.counts.preview, 3);
  await ok('/allegro-batches/' + f.b.id + '/cancel', 'POST', { version: resumed.batch.version });
  assert.deepEqual((await batchDetail(f.b)).counts, { skipped: 3 });
  assert.equal(posts(), 0);
});
test('stara dzierżawa partii nie przygotowuje kolejnych planów', async () => {
  const f = await batchFixture(1);
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [f.b.job_id, randomUUID()],
    )
  ).rows[0];
  await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [job.id, randomUUID()]);
  await processVariantBatch(job, ctx);
  assert.equal(calls.length, 0);
  assert.deepEqual((await batchDetail(f.b)).counts, { pending: 1 });
});
test('paginacja i filtr SKU nie gubią pozycji, a publiczne API chroni partię zakresami', async () => {
  const f = await batchFixture(3, true);
  await batchTicks(f, ['review']);
  const first = await ok('/allegro-batches/' + f.b.id + '?limit=2');
  assert.equal(first.data.length, 2);
  assert(first.meta.cursor);
  const second = await ok('/allegro-batches/' + f.b.id + '?limit=2&after=' + first.meta.cursor);
  assert.equal(second.data.length, 1);
  assert.equal(new Set([...first.data, ...second.data].map((i: any) => i.id)).size, 3);
  assert.equal(
    (await ok('/allegro-batches/' + f.b.id + '?search=' + encodeURIComponent(f.products[0].sku)))
      .data.length,
    1,
  );
  const read = await ok('/developer/keys', 'POST', {
    name: 'Read batch QA',
    scopes: ['products:read'],
  });
  const headers = { authorization: 'Bearer ' + read.token };
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/v1/allegro-batches/' + f.b.id, headers }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/allegro-batches/' + f.b.id + '/queue',
        headers,
        payload: { version: 2 },
      })
    ).statusCode,
    403,
  );
});

test('maksymalna partia 200 SKU ma checkpointy i kompletne strony podglądu bez POST', async () => {
  const f = await fixture(true),
    ids = Array.from({ length: 200 }, () => randomUUID()),
    started = performance.now();
  await tenantTx(tenant, async (c) => {
    await c.query(
      "INSERT INTO products(id,tenant_id,sku,name,price,vat) SELECT id,$1,'MAX-'||id,'Maksymalna partia demonstracyjna QA',12300,23 FROM unnest($2::uuid[]) id",
      [tenant, ids],
    );
    await c.query(
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,reserved) SELECT $1,$2,id,10,0 FROM unnest($3::uuid[]) id',
      [tenant, warehouse, ids],
    );
  });
  const b = await ok('/integrations/' + f.ch + '/allegro-batches', 'POST', {
    name: '200 SKU QA',
    warehouse_id: warehouse,
    client_key: randomUUID(),
    items: ids.map((product_id) => ({ product_id, allegro: input })),
  });
  const d = await batchTicks({ ...f, b }, ['review'], 205);
  assert.deepEqual(d.counts, { preview: 200 });
  assert.equal(posts(), 0);
  assert.equal(calls.length, 0);
  let after = '',
    seen = new Set<string>();
  do {
    const page = await ok(
      '/allegro-batches/' + b.id + '?limit=100' + (after ? '&after=' + after : ''),
    );
    page.data.forEach((i: any) => seen.add(i.product_id));
    after = page.meta.cursor ?? '';
  } while (after);
  assert.equal(seen.size, 200);
  assert.equal(
    (
      await req('/integrations/' + f.ch + '/allegro-batches', 'POST', {
        name: 'Too large',
        warehouse_id: warehouse,
        client_key: randomUUID(),
        items: [...ids, randomUUID()].map((product_id) => ({ product_id, allegro: input })),
      })
    ).statusCode,
    422,
  );
  console.log('ALLEGRO_BATCH_200_PREVIEW_MS=' + Math.round(performance.now() - started));
});

test('wznowienie anulowanego podglądu wraca do przeglądu bez niejawnej zgody na POST', async () => {
  const f = await batchFixture(3),
    review = await batchTicks(f, ['review']);
  await ok('/allegro-batches/' + f.b.id + '/cancel', 'POST', { version: review.batch.version });
  const cancelled = await batchDetail(f.b);
  assert.equal(cancelled.counts.skipped, 3);
  await ok('/allegro-batches/' + f.b.id + '/retry', 'POST', { version: cancelled.batch.version });
  const resumed = await batchTicks(f, ['review']);
  assert.equal(resumed.counts.preview, 3);
  assert.equal(posts(), 0);
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: resumed.batch.version,
    confirm_external: true,
  });
  assert.equal((await batchTicks(f, ['done'])).counts.done, 3);
  assert.equal(posts(), 3);
});
test('wznowienie anulowanej zatwierdzonej partii zachowuje rozpoczętą ofertę i nie duplikuje POST', async () => {
  const f = await batchFixture(3),
    review = await batchTicks(f, ['review']);
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: review.batch.version,
    confirm_external: true,
  });
  await tick(ctx);
  const started = await batchDetail(f.b);
  assert.equal(started.counts.queued, 1);
  await ok('/allegro-batches/' + f.b.id + '/cancel', 'POST', { version: started.batch.version });
  await tick(ctx);
  assert.equal(posts(), 1);
  const cancelled = await batchDetail(f.b);
  assert.equal(cancelled.counts.skipped, 2);
  await ok('/allegro-batches/' + f.b.id + '/retry', 'POST', { version: cancelled.batch.version });
  assert.equal((await batchTicks(f, ['done'])).counts.done, 3);
  assert.equal(posts(), 3);
});

async function publishFixture(count = 3, simulation = false) {
  const f = await batchFixture(count, simulation),
    review = await batchTicks(f, ['review']);
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: review.batch.version,
    confirm_external: true,
  });
  await batchTicks(f, ['done']);
  const listings = (await ok('/integrations/' + f.ch + '/offer-listings')).data;
  calls.length = 0;
  const body = {
    name: 'Publikacja QA',
    operation: 'publish',
    warehouse_id: warehouse,
    client_key: randomUUID(),
    items: listings.map((l: any) => ({ product_id: l.product_id, listing_id: l.id })),
  };
  const b = await ok('/integrations/' + f.ch + '/allegro-batches', 'POST', body);
  return { ...f, listings, body, b };
}
const patches = () => calls.filter((c) => c.method === 'PATCH');
test('publikacja partii ma GET-only podgląd i minimalny PATCH, zachowując ceny i stany', async () => {
  const f = await publishFixture();
  await pool.query(
    'UPDATE products SET price=99999,version=version+1 WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
    [tenant, f.products.map((p: any) => p.id)],
  );
  await pool.query(
    'UPDATE stock SET on_hand=23 WHERE tenant_id=$1 AND product_id=ANY($2::uuid[])',
    [tenant, f.products.map((p: any) => p.id)],
  );
  const d = await batchTicks(f, ['review']);
  assert.deepEqual(d.counts, { preview: 3 });
  assert.equal(patches().length, 0);
  assert.equal(posts(), 0);
  assert(
    d.data.every(
      (i: any) =>
        i.remote_snapshot.publication === 'INACTIVE' &&
        i.remote_snapshot.price &&
        i.remote_snapshot.stock,
    ),
  );
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  const done = await batchTicks(f, ['done']);
  assert.deepEqual(done.counts, { done: 3 });
  assert.equal(patches().length, 3);
  assert.equal(posts(), 0);
  for (const l of f.listings) {
    const remote = store.get(l.external_id);
    assert.equal(remote.publication.status, 'ACTIVE');
    assert.equal(remote.sellingMode.price.amount, (l.price / 100).toFixed(2));
    assert.equal(remote.stock.available, l.last_result.stock_quantity);
    const stock = (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        l.product_id,
      ])
    ).rows[0];
    assert.deepEqual(stock, { on_hand: 23, reserved: 0 });
    const final = (await pool.query('SELECT price,last_result FROM listings WHERE id=$1', [l.id]))
      .rows[0];
    assert.equal(final.price, l.price);
    assert.equal(final.last_result.stock_quantity, l.last_result.stock_quantity);
  }
});
test('publikacja wymaga zgody także sandbox; offers-write wystarcza bez settings-read', async () => {
  const f = await publishFixture(1);
  await pool.query('UPDATE channels SET oauth_scopes=$2 WHERE id=$1', [
    f.ch,
    [readScopes, offerWriteScope].join(' '),
  ]);
  // Start another batch after changing the connection; the previous one correctly remains stale.
  const body = { ...f.body, client_key: randomUUID() };
  f.b = await ok('/integrations/' + f.ch + '/allegro-batches', 'POST', body);
  const d = await batchTicks(f, ['review']);
  assert.deepEqual(d.counts, { preview: 1 });
  assert.equal(
    (await req('/allegro-batches/' + f.b.id + '/queue', 'POST', { version: d.batch.version }))
      .statusCode,
    422,
  );
  assert.equal(patches().length, 0);
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  await batchTicks(f, ['done']);
  assert.equal(patches().length, 1);
});
test('publikacja nie przyjmuje obcego kanału, pomylonego SKU ani danych tworzenia/cennika', async () => {
  const f = await publishFixture(2),
    another = await fixture();
  for (const body of [
    { ...f.body, price_list_id: randomUUID() },
    { ...f.body, items: [{ ...f.body.items[0], allegro: input }] },
    { ...f.body, items: [{ ...f.body.items[0], product_id: f.body.items[1].product_id }] },
    { ...f.body, items: [{ ...f.body.items[0], listing_id: randomUUID() }] },
  ])
    assert.equal(
      (
        await req('/integrations/' + f.ch + '/allegro-batches', 'POST', {
          ...body,
          client_key: randomUUID(),
        })
      ).statusCode,
      422,
    );
  assert.equal(
    (
      await req('/integrations/' + another.ch + '/allegro-batches', 'POST', {
        ...f.body,
        client_key: randomUUID(),
      })
    ).statusCode,
    422,
  );
  assert.equal((await req('/allegro-batches/' + f.b.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal((await req('/allegro-batches/' + f.b.id, 'GET', undefined, viewer)).statusCode, 403);
  assert.equal(patches().length, 0);
});
test('replay publikacji zachowuje partię i zgodę bez powtarzania PATCH', async () => {
  const f = await publishFixture(2),
    d = await batchTicks(f, ['review']);
  assert.equal((await ok('/integrations/' + f.ch + '/allegro-batches', 'POST', f.body)).id, f.b.id);
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  await batchTicks(f, ['done']);
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  assert.equal(patches().length, 2);
});
test('zmiana oferty po podglądzie pozostawia częściowy wynik publikacji', async () => {
  const f = await publishFixture(2),
    d = await batchTicks(f, ['review']);
  store.get(f.listings[0].external_id).sellingMode.price.amount = '999.99';
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  const done = await batchTicks(f, ['partial']);
  assert.deepEqual(done.counts, { done: 1, failed: 1 });
  assert.equal(patches().length, 1);
  assert.equal(store.get(f.listings[0].external_id).publication.status, 'INACTIVE');
});
test('utracony PATCH publikacji odzyskuje aktywną ofertę odczytem bez drugiego PATCH', async () => {
  const f = await publishFixture(1),
    d = await batchTicks(f, ['review']);
  lostPatch = true;
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  await batchTicks(f, ['done']);
  assert.equal(patches().length, 1);
  assert.equal(posts(), 0);
});
test('publikacja 202 oczekuje i weryfikuje ofertę po 303 bez powtórzenia PATCH', async () => {
  const f = await publishFixture(1),
    d = await batchTicks(f, ['review']);
  pending = true;
  await ok('/allegro-batches/' + f.b.id + '/queue', 'POST', {
    version: d.batch.version,
    confirm_external: true,
  });
  operationDone = true;
  await batchTicks(f, ['done']);
  assert.equal(patches().length, 1);
  assert(calls.some((c) => c.path.includes('/operations/')));
});
test('anulowanie i wznowienie publikacji przed zgodą nie aktywuje ofert', async () => {
  const f = await publishFixture(2),
    d = await batchTicks(f, ['review']);
  const cancelled = await ok('/allegro-batches/' + f.b.id + '/cancel', 'POST', {
    version: d.batch.version,
  });
  await ok('/allegro-batches/' + f.b.id + '/retry', 'POST', { version: cancelled.version });
  const resumed = await batchTicks(f, ['review']);
  assert.deepEqual(resumed.counts, { preview: 2 });
  assert.equal(patches().length, 0);
  assert.equal(resumed.batch.input.approved_version, undefined);
});
test('stary klucz tworzenia z etapu043 nadal odtwarza pierwotną partię', async () => {
  const f = await batchFixture(1, true);
  const originalHash = (
    await pool.query('SELECT input_hash FROM variant_offer_batches WHERE id=$1', [f.b.id])
  ).rows[0].input_hash;
  assert.equal(originalHash, offerSnapshotHash(f.body));
  const replay = await ok('/integrations/' + f.ch + '/allegro-batches', 'POST', {
    ...f.body,
    operation: 'create_draft',
  });
  assert.equal(replay.id, f.b.id);
  assert.equal(replay.input_hash, originalHash);
});
