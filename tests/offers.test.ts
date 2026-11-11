import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processOfferJob, failOffer } from '../server/offers';
import { Problem } from '../server/errors';
import {
  offerWriteScope,
  readScopes,
  beginOAuth,
  finishOAuth,
  type IntegrationContext,
} from '../server/channel-access';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  actor: any,
  nextId = 10000;
const store = new Map<string, any>(),
  calls: { url: string; method: string; body: any }[] = [];
let lost = false,
  failWrite = false,
  currency = 'PLN',
  includeTax = 'yes',
  pendingAllegro = false,
  operationDone = false,
  unauthorizedAfterWrite = false,
  unauthorizedRead = false,
  invalidOperationLocation = false,
  tokenScope = readScopes + ' ' + offerWriteScope;
let afterWrite: (() => Promise<void>) | undefined;
const json = (data: any, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers });
const ctx: IntegrationContext = {
  oauthConfig: () => ({
    clientId: 'app',
    clientSecret: 'fixture',
    redirectUri: 'http://127.0.0.1:4100/api/oauth/allegro/callback',
  }),
  transport: async (url, init) => {
    const u = new URL(url),
      method = init.method ?? 'GET',
      body = init.body
        ? u.pathname === '/auth/oauth/token'
          ? Object.fromEntries(new URLSearchParams(String(init.body)))
          : JSON.parse(String(init.body))
        : null;
    calls.push({ url, method, body });
    if (u.pathname === '/auth/oauth/token')
      return json({
        access_token: 'renewed-fixture',
        refresh_token: 'renewed-refresh',
        expires_in: 3600,
        scope: tokenScope,
      });
    if (u.pathname.includes('/settings/general/')) return json({ value: currency });
    if (u.pathname.includes('/settings/tax/')) return json({ value: includeTax });
    if (u.pathname === '/wp-json/wc/v3/products' && method === 'GET')
      return json([...store.values()].filter((p) => p.sku === u.searchParams.get('sku')));
    if (u.pathname.includes('/operations/')) {
      assert.equal(init.redirect, 'manual');
      return operationDone
        ? new Response(null, {
            status: 303,
            headers: { location: 'https://evil.example/never-follow' },
          })
        : json({ operation: { status: 'IN_PROGRESS' } }, 202);
    }
    const key = u.pathname.split('/').at(-1)!;
    if (method === 'GET') {
      if (unauthorizedRead) {
        unauthorizedRead = false;
        return json({}, 401);
      }
      return store.has(key) ? json(store.get(key)) : json({}, 404);
    }
    if (failWrite) return json({ secret: 'NEVER_LOG_PROVIDER_BODY' }, 503);
    if (method === 'POST') {
      const p = { id: nextId++, ...body, sale_price: '', parent_id: 0 };
      store.set(String(p.id), p);
      await afterWrite?.();
      if (lost) {
        lost = false;
        throw new Problem(502, 'Odpowiedź utracona');
      }
      return json(p, 201);
    }
    const previous = store.get(key);
    assert.ok(previous, 'fixture remote missing');
    if (method === 'PATCH' && pendingAllegro) {
      previous.pending = body;
      return json(previous, 202, {
        location: invalidOperationLocation
          ? 'https://evil.example/operations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          : u.origin + u.pathname + '/operations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'retry-after': '5',
      });
    }
    const changed = { ...previous, ...body };
    store.set(key, changed);
    await afterWrite?.();
    if (unauthorizedAfterWrite) {
      unauthorizedAfterWrite = false;
      unauthorizedRead = true;
    }
    return json(changed);
  },
};
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: auth } });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport, oauthConfig: ctx.oauthConfig });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  warehouse = (await req('/api/warehouses')).json().data[0].id;
  actor = {
    tenantId: DEMO_TENANT,
    userId: (await req('/api/auth/me')).json().user.id,
    role: 'admin',
  };
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  lost = false;
  failWrite = false;
  currency = 'PLN';
  includeTax = 'yes';
  pendingAllegro = false;
  operationDone = false;
  unauthorizedAfterWrite = false;
  unauthorizedRead = false;
  invalidOperationLocation = false;
  tokenScope = readScopes + ' ' + offerWriteScope;
  afterWrite = undefined;
});
async function channel(provider = 'woocommerce', mode = 'sandbox', simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,oauth_scopes) VALUES($1,$2,$3,'Oferta QA',$4,$5,$6,$7)`,
      [
        id,
        DEMO_TENANT,
        provider,
        mode,
        encrypt(
          provider === 'woocommerce'
            ? { consumer_key: 'fixture', consumer_secret: 'fixture' }
            : { access_token: 'fixture' },
        ),
        JSON.stringify({ store_url: 'https://shop.example', simulation }),
        readScopes + ' ' + offerWriteScope,
      ],
    ),
  );
  return { id, provider, mode };
}
async function product(quantity = 10, extra: any = {}) {
  const r = await req('/api/products', 'POST', {
    sku: 'OFFER-' + randomUUID().slice(0, 10),
    name: 'Produkt ofertowy QA',
    price: 12300,
    vat: 23,
    quantity,
    warehouse_id: warehouse,
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function linked(ch: any, p: any, remoteExtra: any = {}) {
  const id = String(nextId++),
    r =
      ch.provider === 'woocommerce'
        ? {
            id: Number(id),
            sku: p.sku,
            type: 'simple',
            parent_id: 0,
            status: 'draft',
            regular_price: '10.00',
            sale_price: '',
            stock_quantity: 2,
            manage_stock: true,
            backorders: 'no',
            ...remoteExtra,
          }
        : {
            id,
            sellingMode: { price: { amount: '10.00', currency: 'PLN' } },
            stock: { available: 2, unit: 'UNIT' },
            publication: { status: 'INACTIVE' },
            ...remoteExtra,
          };
  store.set(id, r);
  if (ch.provider === 'woocommerce' && remoteExtra.parent_id) {
    store.set(String(remoteExtra.parent_id), {
      id: remoteExtra.parent_id,
      type: 'variable',
      variations: [Number(id)],
    });
    delete r.parent_id;
    delete r.type;
  }
  const result = await req('/api/integrations/' + ch.id + '/mappings', 'POST', {
    external_id: id,
    sku: p.sku,
  });
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}
async function preview(ch: any, p: any, l?: any, extra: any = {}) {
  return req('/api/integrations/' + ch.id + '/offers/preview', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    operation: l ? 'sync' : 'create_draft',
    ...(l ? { listing_id: l.id } : {}),
    ...extra,
  });
}
async function plan(ch: any, p: any, l?: any, extra: any = {}) {
  const r = await preview(ch, p, l, extra);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function queue(d: any, extra: any = {}) {
  return req('/api/offer-plans/' + d.id + '/queue', 'POST', extra);
}
async function getPlan(d: any) {
  return tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM offer_plans WHERE id=$1', [d.id])).rows[0],
  );
}
async function execute(d: any) {
  const p = await getPlan(d),
    job = await tenantTx(
      DEMO_TENANT,
      async (c) =>
        (
          await c.query(
            "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
            [p.job_id, randomUUID()],
          )
        ).rows[0],
    );
  try {
    await processOfferJob(job, ctx);
  } catch (e) {
    await failOffer(job, e);
  }
  return getPlan(d);
}
test('Woo szkic wysyła dokładną cenę, dostępny stan, opis, parametry i korelację; powiązanie powstaje po odczycie API', async () => {
  const ch = await channel(),
    p = await product(10, { description: 'Opis <bez HTML>', attributes: { Kolor: 'czarny' } }),
    d = await plan(ch, p);
  assert.equal(d.payload.status, 'draft');
  assert.equal(d.payload.regular_price, '123.00');
  assert.equal(d.payload.stock_quantity, 10);
  assert.match(d.payload.description, /&lt;/);
  assert.equal((await queue(d)).statusCode, 200);
  const done = await execute(d);
  assert.equal(done.state, 'done');
  assert.equal(done.result.scope, 'external_api_verified');
  const listing = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM listings WHERE id=$1', [done.listing_id])).rows[0],
  );
  assert.equal(listing.product_id, p.id);
  assert.equal(listing.external_id, done.remote_id);
  assert.ok(calls.some((c) => c.method === 'POST' && c.body?.meta_data?.[0]?.value === d.id));
});
test('utrata odpowiedzi po POST odnajduje własny produkt po SKU i znaczniku; nie tworzy duplikatu', async () => {
  const ch = await channel(),
    p = await product(),
    d = await plan(ch, p);
  await queue(d);
  lost = true;
  assert.equal((await execute(d)).phase, 'write_started');
  const before = calls.filter((c) => c.method === 'POST' && c.body?.sku === p.sku).length;
  assert.equal((await execute(d)).state, 'done');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.body?.sku === p.sku).length, before);
  assert.equal([...store.values()].filter((s) => s.sku === p.sku).length, 1);
});
test('istniejące obce SKU jest konfliktem; nie zostaje przejęte ani nadpisane', async () => {
  const ch = await channel(),
    p = await product();
  store.set(String(nextId), { id: nextId++, sku: p.sku });
  assert.equal((await preview(ch, p)).statusCode, 409);
  const q = await product(),
    d = await plan(ch, q);
  await queue(d);
  store.set(String(nextId), { id: nextId++, sku: q.sku });
  const result = await execute(d);
  assert.equal(result.state, 'conflict');
  assert.equal(result.phase, 'ready');
});
test('zmiana lokalnego stanu po podglądzie blokuje kolejkę, a po kolejce blokuje zapis zewnętrzny', async () => {
  const ch = await channel(),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await req('/api/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    delta: 1,
    note: 'Zmiana po podglądzie',
  });
  assert.equal((await queue(d)).statusCode, 409);
  const fresh = await plan(ch, p, l);
  await queue(fresh);
  await req('/api/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    delta: 1,
    note: 'Zmiana po kolejce',
  });
  const before = calls.filter((c) => c.method === 'PUT').length;
  assert.equal((await execute(fresh)).state, 'conflict');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, before);
});
test('nowa rezerwacja zmniejsza dostępny stan w planie i unieważnia wcześniejszy podgląd', async () => {
  const ch = await channel(),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await req('/api/orders', 'POST', {
    warehouse_id: warehouse,
    customer_name: 'QA Oferty',
    email: 'qa@example.test',
    items: [{ product_id: p.id, quantity: 3 }],
  });
  assert.equal((await queue(d)).statusCode, 409);
  const n = await plan(ch, p, l);
  assert.equal(n.payload.stock_quantity, 7);
});
test('zmiana oferty zewnętrznej po podglądzie daje konflikt bez PUT', async () => {
  const ch = await channel(),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  store.get(l.external_id).stock_quantity = 1;
  assert.equal((await execute(d)).state, 'conflict');
  assert.equal(store.get(l.external_id).stock_quantity, 1);
});
test('aktualizacja i publikacja potwierdzają wynik przez GET; kolejka planu jest idempotentna', async () => {
  const ch = await channel(),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l, { operation: 'publish' });
  const r = await Promise.all([queue(d), queue(d)]);
  assert.equal(r[0].json().job_id, r[1].json().job_id);
  assert.equal((await execute(d)).state, 'done');
  assert.equal(store.get(l.external_id).status, 'publish');
  assert.equal(store.get(l.external_id).stock_quantity, 10);
  assert.equal(store.get(l.external_id).regular_price, '123.00');
});
test('netto jest przeliczone z brutto; zmiana ustawień waluty/tax po podglądzie blokuje także utworzenie', async () => {
  includeTax = 'no';
  const ch = await channel(),
    p = await product(),
    d = await plan(ch, p);
  assert.equal(d.payload.regular_price, '100.00');
  assert.equal(d.price_basis, 'net');
  await queue(d);
  currency = 'EUR';
  assert.equal((await execute(d)).state, 'conflict');
  currency = 'PLN';
  includeTax = 'yes';
});
test('wariant Woo używa endpointu rodzica; rodzic i aktywna promocja są weryfikowane', async () => {
  const ch = await channel(),
    p = await product(),
    l = await linked(ch, p, { type: 'variation', parent_id: 99 });
  assert.equal((await preview(ch, p, l)).statusCode, 422);
  const d = await plan(ch, p, l, { parent_external_id: '99' });
  await queue(d);
  assert.equal((await execute(d)).state, 'done');
  assert.ok(
    calls.some(
      (c) => c.method === 'PUT' && c.url.endsWith('/products/99/variations/' + l.external_id),
    ),
  );
  store.get(l.external_id).sale_price = '5.00';
  assert.equal((await preview(ch, p, l, { parent_external_id: '99' })).statusCode, 409);
  assert.equal(
    (await preview(ch, p, l, { parent_external_id: '99', price: false })).statusCode,
    200,
  );
});
test('zestaw wysyła minimalną dostępność składników, a wyłączony produkt stan zero', async () => {
  const ch = await channel(),
    a = await product(9),
    b = await product(3),
    kit = await product(0, {
      kind: 'bundle',
      components: [
        { product_id: a.id, quantity: 2 },
        { product_id: b.id, quantity: 1 },
      ],
    });
  const d = await plan(ch, kit);
  assert.equal(d.quantity, 3);
  const off = await product(10, { active: false }),
    l = await linked(ch, off);
  assert.equal((await plan(ch, off, l)).quantity, 0);
  assert.equal((await preview(ch, off, l, { operation: 'publish' })).statusCode, 422);
});
test('przypisania nie można zmienić przy aktywnym zapisie; zmiana przed kolejką unieważnia plan', async () => {
  const ch = await channel(),
    p = await product(),
    q = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  assert.equal(
    (
      await req('/api/integrations/' + ch.id + '/mappings', 'POST', {
        external_id: l.external_id,
        sku: q.sku,
      })
    ).statusCode,
    409,
  );
  await execute(d);
  const n = await plan(ch, p, l);
  assert.equal(
    (
      await req('/api/integrations/' + ch.id + '/mappings', 'POST', {
        external_id: l.external_id,
        sku: q.sku,
      })
    ).statusCode,
    200,
  );
  assert.equal((await queue(n)).statusCode, 409);
});
test('live wymaga potwierdzenia, rola i firma ograniczają podgląd/plan/listę', async () => {
  const ch = await channel('woocommerce', 'live'),
    p = await product(),
    d = await plan(ch, p);
  assert.equal((await queue(d)).statusCode, 422);
  assert.equal((await queue(d, { confirm_live: true })).statusCode, 200);
  await execute(d);
  assert.equal(
    (await req('/api/integrations/' + ch.id + '/offers', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req('/api/offer-plans/' + d.id + '/queue', 'POST', {}, other)).statusCode,
    404,
  );
  assert.equal(
    (await req('/api/integrations/' + ch.id + '/offers', 'GET', undefined, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req('/api/offer-plans/' + d.id + '/queue', 'POST', {}, viewer)).statusCode,
    403,
  );
});
test('lokalny przykład wykonuje wyraźną symulację bez połączenia z siecią', async () => {
  const ch = await channel('woocommerce', 'sandbox', true),
    p = await product(),
    before = calls.length,
    d = await plan(ch, p);
  assert.equal(d.scope, 'local_simulation');
  await queue(d);
  const done = await execute(d);
  assert.equal(done.state, 'done');
  assert.equal(done.result.scope, 'local_simulation');
  assert.match(done.remote_id, /^DEMO-/);
  assert.equal(calls.length, before);
});
test('Allegro 202 nie kończy zadania; polling 202/303 potwierdza zmianę przez GET bez ponownego PATCH', async () => {
  const ch = await channel('allegro'),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  pendingAllegro = true;
  operationDone = false;
  let done = await execute(d);
  assert.equal(done.state, 'queued');
  assert.equal(done.phase, 'verify');
  assert.ok(done.operation_id);
  const patch = calls.filter((c) => c.method === 'PATCH').length;
  done = await execute(d);
  assert.equal(done.state, 'queued');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, patch);
  operationDone = true;
  const r = store.get(l.external_id);
  Object.assign(r, r.pending);
  delete r.pending;
  done = await execute(d);
  assert.equal(done.state, 'done');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, patch);
  assert.equal(
    calls.some((c) => c.url.startsWith('https://evil.example')),
    false,
  );
  pendingAllegro = false;
});
test('Allegro bez prawa zapisu nie może zakolejkować zmian, a OAuth oferuje osobną zgodę na zapis', async () => {
  const ch = await channel('allegro'),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE channels SET oauth_scopes=$2 WHERE id=$1', [ch.id, readScopes]),
  );
  assert.equal((await queue(d)).statusCode, 422);
  const start = await beginOAuth(actor, ch.id, ctx, true);
  assert.ok(new URL(start.url).searchParams.get('scope')!.includes(offerWriteScope));
});
test('ostatni błąd zapisu pozostawia jawny niepewny wynik i blokuje nowe zmiany do uzgodnienia', async () => {
  const ch = await channel(),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  failWrite = true;
  for (let i = 0; i < 5; i++) await execute(d);
  failWrite = false;
  assert.equal((await getPlan(d)).state, 'failed');
  assert.equal((await getPlan(d)).phase, 'write_started');
  const n = await plan(ch, p, l);
  assert.equal((await queue(n)).statusCode, 409);
  const retry = await req('/api/offer-plans/' + d.id + '/reconcile', 'POST');
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal((await execute(d)).state, 'done');
});
test('stary lease nie może wysłać żądania ani zapisać wyniku; worker dispatchuje offer.write', async () => {
  const ch = await channel(),
    p = await product(),
    d = await plan(ch, p);
  await queue(d);
  const planRow = await getPlan(d);
  const job = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM jobs WHERE id=$1', [planRow.job_id])).rows[0],
  );
  job.lease_token = randomUUID();
  const before = calls.length;
  await processOfferJob(job, ctx);
  assert.equal(calls.length, before);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE jobs SET run_at=now()-interval '1 day' WHERE id=$1", [job.id]),
  );
  await tick(ctx);
  assert.equal((await getPlan(d)).state, 'done');
});

test('uzgodnienie odczytem zamyka niepewny wynik bez ponownego PUT i zachowuje faktyczny stan dostawcy', async () => {
  const ch = await channel(),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  failWrite = true;
  for (let i = 0; i < 5; i++) await execute(d);
  failWrite = false;
  await req('/api/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    delta: 1,
    note: 'Nowy stan po awarii',
  });
  assert.equal((await req('/api/offer-plans/' + d.id + '/reconcile', 'POST')).statusCode, 200);
  const before = calls.filter((c) => c.method === 'PUT').length;
  assert.equal((await execute(d)).state, 'failed');
  assert.equal(calls.filter((c) => c.method === 'PUT').length, before);
  assert.equal(
    (await req('/api/offer-plans/' + d.id + '/reconcile', 'POST', { accept_observed: true }))
      .statusCode,
    200,
  );
  const done = await execute(d);
  assert.equal(done.state, 'done');
  assert.equal(done.result.scope, 'external_api_observed');
  assert.equal(done.result.desired_applied, false);
  assert.equal(done.result.verified_payload, undefined);
  assert.equal(done.result.actual_snapshot.stock_quantity, 2);
  assert.equal(done.result.local_changed, true);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, before);
  const fresh = await plan(ch, p, l);
  assert.equal((await queue(fresh)).statusCode, 200);
  await execute(fresh);
});
test('odczyt po nieudanym tworzeniu bez produktu zamyka wynik bez fikcyjnego powiązania', async () => {
  const ch = await channel(),
    p = await product(),
    d = await plan(ch, p);
  await queue(d);
  failWrite = true;
  for (let i = 0; i < 5; i++) await execute(d);
  failWrite = false;
  const before = calls.filter((c) => c.method === 'POST').length;
  assert.equal(
    (await req('/api/offer-plans/' + d.id + '/reconcile', 'POST', { accept_observed: true }))
      .statusCode,
    200,
  );
  const done = await execute(d);
  assert.equal(done.state, 'done');
  assert.equal(done.remote_id, null);
  assert.equal(done.listing_id, null);
  assert.equal(done.result.desired_applied, false);
  assert.equal(calls.filter((c) => c.method === 'POST').length, before);
  assert.equal((await queue(await plan(ch, p))).statusCode, 200);
});
test('utracony POST odzyskuje zapisany wynik przy nowej cenie lokalnej i zachowuje cenę wysłaną', async () => {
  const ch = await channel(),
    p = await product(),
    d = await plan(ch, p);
  await queue(d);
  lost = true;
  await execute(d);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE products SET price=99900,version=version+1 WHERE id=$1', [p.id]),
  );
  const before = calls.filter((c) => c.method === 'POST').length;
  const done = await execute(d);
  assert.equal(done.state, 'done');
  assert.equal(done.result.local_changed, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, before);
  const listing = await tenantTx(
    DEMO_TENANT,
    async (c) =>
      (await c.query('SELECT price FROM listings WHERE id=$1', [done.listing_id])).rows[0],
  );
  assert.equal(listing.price, 12300);
});
test('zmiana stanu podczas żądania jest ujawniona po odczycie wyniku zapisu', async () => {
  const ch = await channel(),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  afterWrite = async () => {
    const r = await req('/api/inventory/adjust', 'POST', {
      product_id: p.id,
      warehouse_id: warehouse,
      delta: 1,
      note: 'Zmiana podczas API',
    });
    assert.equal(r.statusCode, 200, r.body);
  };
  const done = await execute(d);
  assert.equal(done.state, 'done');
  assert.equal(done.result.local_changed, true);
  assert.equal(store.get(l.external_id).stock_quantity, 10);
});
test('odświeżenie tokena Allegro z zawężonym zakresem zatrzymuje zapis przed PATCH', async () => {
  const ch = await channel('allegro'),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "UPDATE channels SET credentials=$2,token_expires_at=now()-interval '1 minute' WHERE id=$1",
      [ch.id, encrypt({ access_token: 'fixture', refresh_token: 'fixture-refresh' })],
    ),
  );
  tokenScope = readScopes;
  const before = calls.filter((c) => c.method === 'PATCH').length;
  assert.equal((await execute(d)).state, 'failed');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, before);
  const row = await tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT oauth_scopes FROM channels WHERE id=$1', [ch.id])).rows[0],
  );
  assert.equal(row.oauth_scopes, readScopes);
});
test('401 podczas weryfikacji Allegro odświeża token i wraca przez trwałą fazę bez drugiego PATCH', async () => {
  const ch = await channel('allegro'),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "UPDATE channels SET credentials=$2,token_expires_at=now()+interval '1 hour' WHERE id=$1",
      [ch.id, encrypt({ access_token: 'fixture', refresh_token: 'fixture-refresh' })],
    ),
  );
  unauthorizedAfterWrite = true;
  const before = calls.filter((c) => c.method === 'PATCH').length;
  const interrupted = await execute(d);
  assert.equal(interrupted.state, 'queued');
  assert.equal(interrupted.phase, 'write_started');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, before + 1);
  const done = await execute(d);
  assert.equal(done.state, 'done');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, before + 1);
});

test('drugi podgląd utworzenia szkicu nie tworzy kolejnej oferty po zakończeniu pierwszego', async () => {
  const ch = await channel('woocommerce', 'sandbox', true),
    p = await product(),
    a = await plan(ch, p),
    b = await plan(ch, p);
  await queue(a);
  assert.equal((await execute(a)).state, 'done');
  assert.equal((await queue(b)).statusCode, 409);
  assert.equal((await preview(ch, p)).statusCode, 409);
});
test('wyszukiwanie i kursor ofert obejmują cały kanał bez ograniczenia do 200; obca firma i rola są blokowane', async () => {
  const ch = await channel(),
    p = await product();
  await tenantTx(DEMO_TENANT, async (c) => {
    for (let i = 0; i < 205; i++)
      await c.query(
        'INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,price,created_at) VALUES($1,$2,$3,$4,$5,1000,now()-make_interval(secs=>$6))',
        [randomUUID(), DEMO_TENANT, ch.id, p.id, String(800000 + i), i],
      );
  });
  let cursor = '',
    found: string[] = [];
  do {
    const r = await req(
      '/api/integrations/' +
        ch.id +
        '/offer-listings?limit=100' +
        (cursor ? '&after=' + cursor : ''),
    );
    assert.equal(r.statusCode, 200, r.body);
    found.push(...r.json().data.map((l: any) => l.external_id));
    cursor = r.json().meta.cursor;
  } while (cursor);
  assert.equal(found.length, 205);
  assert.equal(new Set(found).size, 205);
  const search = await req('/api/integrations/' + ch.id + '/offer-listings?search=800204');
  assert.equal(search.json().data.length, 1);
  assert.equal(search.json().data[0].external_id, '800204');
  assert.equal(
    (await req('/api/integrations/' + ch.id + '/offer-listings', 'GET', undefined, other))
      .statusCode,
    404,
  );
  assert.equal(
    (await req('/api/integrations/' + ch.id + '/offer-listings', 'GET', undefined, viewer))
      .statusCode,
    403,
  );
});

test('symulacja synchronizacji zachowuje opublikowany status i cenę przy zmianie wyłącznie stanu', async () => {
  const ch = await channel('woocommerce', 'sandbox', true),
    p = await product(),
    a = await plan(ch, p);
  await queue(a);
  const created = await execute(a),
    l = { id: created.listing_id };
  const publish = await plan(ch, p, l, { operation: 'publish' });
  await queue(publish);
  await execute(publish);
  await req('/api/inventory/adjust', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    delta: 1,
    note: 'Stan po publikacji',
  });
  const sync = await plan(ch, p, l, { price: false });
  assert.equal(sync.before.status, 'publish');
  await queue(sync);
  assert.equal((await execute(sync)).result.desired_applied, true);
  const next = await plan(ch, p, l);
  assert.equal(next.before.status, 'publish');
  assert.equal(next.before.stock_quantity, 11);
  assert.equal(next.before.regular_price, '123.00');
});
test('nowa reguła cenowa Allegro od podglądu blokuje ręczne nadpisanie ceny', async () => {
  const ch = await channel('allegro'),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  store.get(l.external_id).sellingMode.priceAutomation = { rule: { id: 'new-rule' } };
  const before = calls.filter((c) => c.method === 'PATCH').length;
  assert.equal((await execute(d)).state, 'conflict');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, before);
});

test('WooCommerce sprawdza przynależność wariantu po liście rodzica, bez parent_id w odpowiedzi wariantu', async () => {
  const ch = await channel(),
    p = await product(),
    l = await linked(ch, p, { parent_id: 199 });
  assert.equal(store.get(l.external_id).parent_id, undefined);
  const good = await preview(ch, p, l, { parent_external_id: '199' });
  assert.equal(good.statusCode, 200, good.body);
  store.get('199').variations = [];
  assert.equal((await preview(ch, p, l, { parent_external_id: '199' })).statusCode, 422);
});

test('Allegro odrzuca obcy Location po 202 i pozostawia niepewny zapis do uzgodnienia', async () => {
  const ch = await channel('allegro'),
    p = await product(),
    l = await linked(ch, p),
    d = await plan(ch, p, l);
  await queue(d);
  pendingAllegro = true;
  invalidOperationLocation = true;
  const result = await execute(d);
  assert.equal(result.state, 'failed');
  assert.equal(result.phase, 'write_started');
  assert.equal(result.operation_id, null);
  assert.equal(
    calls.some((c) => c.url.startsWith('https://evil.example')),
    false,
  );
});
async function priceList(p: any, currency = 'PLN', price = 15001) {
  const r = await req('/api/price-lists', 'POST', { name: 'Cennik oferty QA', currency });
  assert.equal(r.statusCode, 201, r.body);
  const l = r.json();
  const set = await req('/api/price-lists/' + l.id + '/items', 'PUT', {
    version: 1,
    items: [{ product_id: p.id, price }],
  });
  assert.equal(set.statusCode, 200, set.body);
  return set.json();
}
test('cennik EUR ustala cenę Woo netto, walutę powiązania i nie zmienia katalogu', async () => {
  const ch = await channel(),
    p = await product(),
    l = await priceList(p, 'EUR', 1234);
  currency = 'EUR';
  includeTax = 'no';
  const d = await plan(ch, p, undefined, { price_list_id: l.id });
  assert.equal(d.currency, 'EUR');
  assert.equal(d.payload.regular_price, '10.03');
  await queue(d);
  const done = await execute(d);
  assert.equal(done.state, 'done');
  assert(done.result.desired_applied);
  const mapped = (
    await pool.query('SELECT price,price_currency FROM listings WHERE id=$1', [done.listing_id])
  ).rows[0];
  assert.deepEqual(mapped, { price: 1234, price_currency: 'EUR' });
  assert.equal(
    (await pool.query('SELECT price FROM products WHERE id=$1', [p.id])).rows[0].price,
    12300,
  );
});
test('zmiana cennika po podglądzie odrzuca kolejkę bez wywołania zapisu', async () => {
  const ch = await channel(),
    p = await product(),
    l = await priceList(p);
  const d = await plan(ch, p, undefined, { price_list_id: l.id });
  await req('/api/price-lists/' + l.id + '/items', 'PUT', {
    version: l.version,
    items: [{ product_id: p.id, price: 15002 }],
  });
  assert.equal((await queue(d)).statusCode, 409);
  assert.equal((await getPlan(d)).state, 'preview');
});
test('zmiana cennika w kolejce daje konflikt przed POST', async () => {
  const ch = await channel(),
    p = await product(),
    l = await priceList(p);
  const d = await plan(ch, p, undefined, { price_list_id: l.id });
  await queue(d);
  await req('/api/price-lists/' + l.id + '/items', 'PUT', {
    version: l.version,
    items: [{ product_id: p.id, price: 15002 }],
  });
  const before = calls.filter((c) => c.method === 'POST').length;
  const result = await execute(d);
  assert.equal(result.state, 'conflict');
  assert.equal(calls.filter((c) => c.method === 'POST').length, before);
});
test('uzgodnienie po utracie odpowiedzi działa po wyłączeniu cennika i nie powtarza POST', async () => {
  const ch = await channel(),
    p = await product(),
    l = await priceList(p, 'EUR');
  currency = 'EUR';
  const d = await plan(ch, p, undefined, { price_list_id: l.id });
  await queue(d);
  afterWrite = async () => {
    const r = await req('/api/price-lists/' + l.id, 'PATCH', {
      name: l.name,
      active: false,
      fallback: false,
      adjustment_bps: 0,
      adjustment_amount: 0,
      version: l.version,
    });
    assert.equal(r.statusCode, 200, r.body);
  };
  lost = true;
  const first = await execute(d);
  assert.equal(first.phase, 'write_started');
  const writes = calls.filter((c) => c.method === 'POST').length;
  afterWrite = undefined;
  const result = await execute(d);
  assert.equal(result.state, 'done');
  assert.equal(result.result.local_changed, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, writes);
  assert.equal(result.result.desired_applied, true);
});

test('synchronizacja samego stanu sklepu EUR nie wymaga cennika i zachowuje cenę EUR', async () => {
  const ch = await channel(),
    p = await product(),
    list = await priceList(p, 'EUR', 1234);
  currency = 'EUR';
  includeTax = 'no';
  const first = await plan(ch, p, undefined, { price_list_id: list.id });
  await queue(first);
  const created = await execute(first);
  const l = (await pool.query('SELECT * FROM listings WHERE id=$1', [created.listing_id])).rows[0];
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE price_lists SET active=false WHERE id=$1', [list.id]),
  );
  const update = await plan(ch, p, l, { price: false });
  assert.equal(update.payload.regular_price, undefined);
  await queue(update);
  const done = await execute(update);
  assert.equal(done.state, 'done');
  assert(done.result.desired_applied);
  assert.equal(store.get(l.external_id).regular_price, '10.03');
  assert.deepEqual(
    (await pool.query('SELECT price,price_currency FROM listings WHERE id=$1', [l.id])).rows[0],
    { price: 1234, price_currency: 'EUR' },
  );
});
