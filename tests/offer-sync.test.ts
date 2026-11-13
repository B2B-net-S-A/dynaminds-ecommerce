import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import {
  beginOAuth,
  finishOAuth,
  readScopes,
  offerWriteScope,
  withAllegroRequestContext,
  type IntegrationContext,
} from '../server/channel-access';
import type { FastifyRequest } from 'fastify';
import { processOfferJob, failOffer } from '../server/offers';
import {
  processOfferSync,
  failOfferSync,
  scheduleOffersDue,
  OFFER_SYNC_BATCH,
} from '../server/offer-sync';
import { Problem } from '../server/errors';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  warehouse: string,
  actorId: string,
  authenticatedRequest: FastifyRequest,
  nextId = 900000;
const store = new Map<string, any>(),
  calls: { url: string; method: string; body: any }[] = [];
let hookRead: (() => Promise<void>) | undefined,
  hookWrite: (() => Promise<void>) | undefined,
  lost = false,
  failPut = false,
  currency = 'PLN',
  includeTax = 'yes',
  allegroPending = false,
  operationDone = false;
const json = (d: any, status = 200, headers: any = {}) =>
  new Response(JSON.stringify(d), { status, headers });
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    const u = new URL(url),
      method = init.method ?? 'GET',
      body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: u.pathname, method, body });
    if (u.pathname.includes('/settings/general/')) return json({ value: currency });
    if (u.pathname.includes('/settings/tax/')) return json({ value: includeTax });
    if (u.pathname.includes('/operations/'))
      return operationDone
        ? json({ operation: { status: 'SUCCESS' } })
        : json({ operation: { status: 'IN_PROGRESS' } }, 202);
    const key = u.pathname.split('/').at(-1)!;
    if (method === 'GET') {
      const hook = hookRead;
      hookRead = undefined;
      await hook?.();
      return store.has(key) ? json(store.get(key)) : json({}, 404);
    }
    if (failPut) return json({ secret: 'DO_NOT_EXPOSE_PROVIDER_RESPONSE' }, 503);
    const prior = store.get(key);
    assert(prior, 'Missing fixture product');
    if (allegroPending && method === 'PATCH') {
      prior.pending = body;
      return json(prior, 202, {
        location: u.origin + u.pathname + '/operations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
    }
    store.set(key, { ...prior, ...body });
    const hook = hookWrite;
    hookWrite = undefined;
    await hook?.();
    if (lost) {
      lost = false;
      throw new Problem(502, 'Odpowiedź utracona');
    }
    return json(store.get(key));
  },
};
const req = (p: string, m: any = 'GET', b?: any, auth = cookie) =>
  app.inject({
    url: '/api' + p,
    method: m,
    payload: b,
    headers: { cookie: auth, ...(p === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
async function ok(p: string, m: any = 'GET', b?: any) {
  const r = await req(p, m, b);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  // Direct beginOAuth/finishOAuth calls need the authority of a real authenticated request (Allegro OAuth authority).
  app.addHook('preHandler', async (req) => {
    if (req.url === '/api/auth/me') authenticatedRequest = req;
  });
  for (const [email, set] of [
    ['admin@demo.local', (v: string) => (cookie = v)],
    ['viewer@demo.local', (v: string) => (viewer = v)],
    ['other@demo.local', (v: string) => (other = v)],
  ] as const) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    set(r.headers['set-cookie']!.toString().split(';')[0]);
  }
  warehouse = (await ok('/warehouses')).data[0].id;
  actorId = (await ok('/auth/me')).user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  calls.length = 0;
  hookRead = undefined;
  hookWrite = undefined;
  lost = false;
  failPut = false;
  currency = 'PLN';
  includeTax = 'yes';
  allegroPending = false;
  operationDone = false;
});
async function channel(provider = 'woocommerce', simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,oauth_scopes) VALUES($1,$2,$3,'Autosync QA','sandbox',$4,$5,$6)`,
      [
        id,
        DEMO_TENANT,
        provider,
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
  return { id, provider };
}
async function listing(ch: any, price = 12300, remotePrice = '10.00', extra: any = {}) {
  const p = await ok('/products', 'POST', {
    sku: 'SYNC-' + randomUUID().slice(0, 10),
    name: 'Oferta autosync QA',
    price,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  const external = String(nextId++);
  store.set(
    external,
    ch.provider === 'woocommerce'
      ? {
          id: Number(external),
          sku: p.sku,
          type: 'simple',
          parent_id: 0,
          regular_price: remotePrice,
          sale_price: '',
          stock_quantity: 2,
          manage_stock: true,
          backorders: 'no',
          status: 'draft',
          ...extra,
        }
      : {
          id: external,
          sellingMode: { price: { amount: remotePrice, currency: 'PLN' } },
          stock: { available: 2, unit: 'UNIT' },
          publication: { status: 'INACTIVE' },
          ...extra,
        },
  );
  const l = await ok('/integrations/' + ch.id + '/mappings', 'POST', {
    external_id: external,
    sku: p.sku,
  });
  return { p, l, external };
}
const settings = (x: any = {}) => ({
  version: 0,
  enabled: true,
  warehouse_id: warehouse,
  price_list_id: null,
  stock: true,
  price: true,
  interval_seconds: 30,
  verify_seconds: 60,
  confirm_external: true,
  ...x,
});
async function configure(ch: any, x: any = {}) {
  return ok('/integrations/' + ch.id + '/offer-sync', 'PATCH', settings(x));
}
async function claim(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function executeSync(id: string) {
  const job = await claim(id);
  try {
    await processOfferSync(job, ctx);
  } catch (e) {
    await failOfferSync(job, e);
  }
  return (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
}
async function cycle(ch: any) {
  const r = await ok('/integrations/' + ch.id + '/offer-sync', 'POST', {});
  return executeSync(r.id);
}
async function plans(ch: any) {
  return (
    await pool.query('SELECT * FROM offer_plans WHERE channel_id=$1 ORDER BY created_at,id', [
      ch.id,
    ])
  ).rows;
}
async function write(p: any) {
  const job = await claim(p.job_id);
  try {
    await processOfferJob(job, ctx);
  } catch (e) {
    await failOffer(job, e);
  }
  return (await pool.query('SELECT * FROM offer_plans WHERE id=$1', [p.id])).rows[0];
}
const writes = () => calls.filter((c) => ['PUT', 'PATCH', 'POST'].includes(c.method));
async function complete(ch: any) {
  for (const p of await plans(ch)) if (p.state === 'queued') await write(p);
}
// Do not pass database metadata into the strict configuration contract.
async function pause(ch: any, cfg: any) {
  return configure(ch, {
    version: cfg.version,
    enabled: false,
    warehouse_id: cfg.warehouse_id,
    price_list_id: cfg.price_list_id,
    stock: cfg.stock,
    price: cfg.price,
    interval_seconds: cfg.interval_seconds,
    verify_seconds: cfg.verify_seconds,
  });
}
test('konfiguracja wymaga jawnego zezwolenia dla API, admina i bieżącej wersji', async () => {
  const ch = await channel();
  assert.equal(
    (
      await req(
        '/integrations/' + ch.id + '/offer-sync',
        'PATCH',
        settings({ confirm_external: false }),
      )
    ).statusCode,
    422,
  );
  assert.equal(
    (await req('/integrations/' + ch.id + '/offer-sync', 'PATCH', settings(), viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req('/integrations/' + ch.id + '/offer-sync', 'PATCH', settings(), other)).statusCode,
    404,
  );
  const cfg = await configure(ch);
  assert.equal(cfg.version, 1);
  assert.equal(await configure(ch, { version: 0 }).catch(() => null), null);
  await pause(ch, cfg);
});
test('katalog i rezerwacje wywołują aktualizację, potwierdzenie nie powtarza PUT', async () => {
  const ch = await channel(),
    f = await listing(ch),
    cfg = await configure(ch);
  let j = await cycle(ch);
  assert.equal(j.payload.stats.queued, 1);
  assert.equal(writes().length, 0);
  let p = (await plans(ch))[0];
  assert.equal(p.sync_version, 1);
  assert.equal(p.payload.stock_quantity, 10);
  assert.equal(p.payload.regular_price, '123.00');
  p = await write(p);
  assert.equal(p.state, 'done');
  await cycle(ch);
  assert.equal(writes().length, 1);
  const data = await ok('/integrations/' + ch.id + '/offer-sync');
  assert.equal(data.data[0].state, 'verified');
  assert.equal(data.data[0].verified_hash, data.data[0].desired_hash);
  const order = await ok('/orders', 'POST', {
    customer_name: 'Autosync QA',
    email: 'sync@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: f.p.id, quantity: 3 }],
  });
  await cycle(ch);
  p = (await plans(ch)).at(-1);
  assert.equal(p.payload.stock_quantity, 7);
  await write(p);
  await ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'cancelled' }));
  await cycle(ch);
  p = (await plans(ch)).at(-1);
  assert.equal(p.payload.stock_quantity, 10);
  await write(p);
  await pause(ch, cfg);
});
test('zgodne dane po GET nie tworzą zapisu i później pomijają odczyt do terminu weryfikacji', async () => {
  const ch = await channel(),
    f = await listing(ch, 12300, '123.00', { stock_quantity: 10 }),
    cfg = await configure(ch);
  let j = await cycle(ch);
  assert.equal(j.payload.stats.unchanged, 1);
  assert.equal(writes().length, 0);
  const readCount = calls.length;
  j = await cycle(ch);
  assert.equal(j.payload.stats.skipped, 1);
  assert.equal(calls.length, readCount);
  store.get(f.external).regular_price = '1.00';
  await pool.query(
    "UPDATE offer_sync_items SET last_checked_at=now()-interval '2 minutes' WHERE channel_id=$1",
    [ch.id],
  );
  j = await cycle(ch);
  assert.equal(j.payload.stats.queued, 1);
  await complete(ch);
  assert.equal(store.get(f.external).regular_price, '123.00');
  assert.equal(writes().length, 1);
  await pause(ch, cfg);
});
test('jedna kolejka kanału scala równoczesne uruchomienia i harmonogramy', async () => {
  const ch = await channel(),
    cfg = await configure(ch);
  const r = await Promise.all(
    Array.from({ length: 12 }, () => ok('/integrations/' + ch.id + '/offer-sync', 'POST', {})),
  );
  assert.equal(new Set(r.map((x) => x.id)).size, 1);
  assert.equal(r.filter((x) => !x.reused).length, 1);
  await pool.query('UPDATE offer_sync_configs SET next_run_at=now() WHERE channel_id=$1', [ch.id]);
  await Promise.all([scheduleOffersDue(), scheduleOffersDue()]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='offer.sync' AND payload->>'channel_id'=$1 AND state IN ('pending','running')",
        [ch.id],
      )
    ).rows[0].n,
    1,
  );
  await executeSync(r[0].id);
  await pause(ch, cfg);
});
test('wyłączenie zatrzymuje zaplanowany zapis przed żądaniem HTTP', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch);
  await cycle(ch);
  const p = (await plans(ch))[0],
    job = await claim(p.job_id);
  await pause(ch, cfg);
  const count = calls.length;
  await processOfferJob(job, ctx).catch((e) => failOffer(job, e));
  assert.equal(calls.length, count);
  assert.equal((await plans(ch))[0].state, 'conflict');
  assert.equal(writes().length, 0);
});
test('wyłączenie między GET i PUT zatrzymuje zapis także po rozpoczęciu workera', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch);
  await cycle(ch);
  hookRead = () => pause(ch, cfg).then(() => {});
  await write((await plans(ch))[0]);
  assert.equal(writes().length, 0);
  assert.equal((await plans(ch))[0].state, 'conflict');
});
test('utracona odpowiedź po PUT i wyłączenie harmonogramu uzgadniają wyłącznie GET', async () => {
  const ch = await channel(),
    f = await listing(ch),
    cfg = await configure(ch);
  await cycle(ch);
  lost = true;
  hookWrite = () => pause(ch, cfg).then(() => {});
  let p = await write((await plans(ch))[0]);
  assert.equal(p.state, 'queued');
  assert.equal(p.phase, 'write_started');
  p = await write(p);
  assert.equal(p.state, 'done');
  assert.equal(p.result.scope, 'external_api_observed');
  assert(p.result.desired_applied);
  assert.equal(writes().length, 1);
  assert.equal(store.get(f.external).regular_price, '123.00');
});
test('niepewny nieudany zapis blokuje nowe plany do ręcznego uzgodnienia', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch);
  await cycle(ch);
  let p = (await plans(ch))[0];
  await pool.query('UPDATE jobs SET max_attempts=1 WHERE id=$1', [p.job_id]);
  failPut = true;
  p = await write(p);
  assert.equal(p.state, 'failed');
  assert.equal(p.phase, 'write_started');
  const count = calls.length;
  await cycle(ch);
  assert.equal((await plans(ch)).length, 1);
  assert.equal(calls.length, count);
  assert.equal((await ok('/integrations/' + ch.id + '/offer-sync')).data[0].state, 'blocked');
  failPut = false;
  await ok('/offer-plans/' + p.id + '/reconcile', 'POST', { accept_observed: true });
  p = (await plans(ch))[0];
  assert.equal((await write(p)).state, 'done');
  await cycle(ch);
  assert.equal((await plans(ch)).length, 2);
  await complete(ch);
  await pause(ch, cfg);
});
test('cennik EUR uwzględnia netto Woo i pozostawia cenę katalogu', async () => {
  const ch = await channel(),
    f = await listing(ch),
    l = await ok('/price-lists', 'POST', { name: 'Autosync EUR', currency: 'EUR' });
  await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: 1,
    items: [{ product_id: f.p.id, price: 1234 }],
  });
  currency = 'EUR';
  includeTax = 'no';
  const cfg = await configure(ch, { price_list_id: l.id });
  await cycle(ch);
  const p = (await plans(ch))[0];
  assert.equal(p.payload.regular_price, '10.03');
  await write(p);
  assert.deepEqual(
    (await pool.query('SELECT price,price_currency FROM listings WHERE id=$1', [f.l.id])).rows[0],
    { price: 1234, price_currency: 'EUR' },
  );
  assert.equal(
    (await pool.query('SELECT price FROM products WHERE id=$1', [f.p.id])).rows[0].price,
    12300,
  );
  await pause(ch, cfg);
});
test('sam stan nie zmienia obcej ceny ani nie czyta ustawień cen sklepu', async () => {
  const ch = await channel(),
    f = await listing(ch, 12300, '9.99'),
    cfg = await configure(ch, { price: false });
  currency = 'EUR';
  await cycle(ch);
  let p = (await plans(ch))[0];
  assert.equal(p.payload.regular_price, undefined);
  p = await write(p);
  assert.equal(p.state, 'done');
  assert.equal(store.get(f.external).regular_price, '9.99');
  assert.equal(store.get(f.external).stock_quantity, 10);
  assert(!calls.some((c) => c.url.includes('/settings/')));
  await pause(ch, cfg);
});
test('Allegro synchronizuje cenę i stan w istniejącej ofercie', async () => {
  const ch = await channel('allegro'),
    f = await listing(ch),
    cfg = await configure(ch);
  await cycle(ch);
  let p = (await plans(ch))[0];
  assert.deepEqual(p.payload.sellingMode.price, { amount: '123.00', currency: 'PLN' });
  p = await write(p);
  assert.equal(p.state, 'done');
  assert.equal(store.get(f.external).stock.available, 10);
  assert.equal(writes()[0].method, 'PATCH');
  await pause(ch, cfg);
});
test('zmiana konfiguracji odrzuca stare zapisy i nowe używają nowych opcji', async () => {
  const ch = await channel(),
    f = await listing(ch),
    cfg = await configure(ch);
  await cycle(ch);
  const old = (await plans(ch))[0];
  const next = await configure(ch, { version: cfg.version, price: false });
  assert.equal((await plans(ch))[0].state, 'conflict');
  await cycle(ch);
  const p = (await plans(ch)).at(-1);
  assert.equal(p.sync_version, 2);
  assert.equal(p.payload.regular_price, undefined);
  await write(p);
  assert.equal(store.get(f.external).regular_price, '10.00');
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [old.job_id])).rows[0].state,
    'failed',
  );
  await pause(ch, next);
});
test('utrata roli administratora wyłącza harmonogram i nie wysyła oczekującej oferty', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch);
  await cycle(ch);
  await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    actorId,
  ]);
  try {
    await pool.query('UPDATE offer_sync_configs SET next_run_at=now() WHERE channel_id=$1', [
      ch.id,
    ]);
    await scheduleOffersDue();
    await write((await plans(ch))[0]);
    assert.equal(writes().length, 0);
    assert.equal(
      (await pool.query('SELECT enabled FROM offer_sync_configs WHERE channel_id=$1', [ch.id]))
        .rows[0].enabled,
      false,
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actorId,
    ]);
  }
  await pause(ch, cfg);
});
test('zmiana adresu połączenia unieważnia zgodę przed zapisem', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch);
  await cycle(ch);
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"store_url":"https://other.example"}\'::jsonb WHERE id=$1',
    [ch.id],
  );
  await write((await plans(ch))[0]);
  assert.equal(writes().length, 0);
  await pool.query('UPDATE offer_sync_configs SET next_run_at=now() WHERE channel_id=$1', [ch.id]);
  await scheduleOffersDue();
  assert.equal(
    (await pool.query('SELECT enabled FROM offer_sync_configs WHERE channel_id=$1', [ch.id]))
      .rows[0].enabled,
    false,
  );
  await pause(ch, cfg);
});
test('wiele stron przeglądu i widoku obejmuje 126 powiązań bez duplikatów', async () => {
  const ch = await channel();
  for (let i = 0; i < 126; i++) await listing(ch, 12300, '123.00', { stock_quantity: 10 });
  const cfg = await configure(ch);
  const id = (await ok('/integrations/' + ch.id + '/offer-sync', 'POST', {})).id;
  let j = await executeSync(id);
  assert.equal(j.state, 'pending');
  assert.equal(j.payload.stats.checked, OFFER_SYNC_BATCH);
  let pages = 1;
  while (j.state === 'pending') {
    j = await executeSync(id);
    pages++;
  }
  assert.equal(pages, 6);
  assert.equal(j.payload.stats.checked, 126);
  assert.equal(j.payload.stats.unchanged, 126);
  assert.equal((await plans(ch)).length, 126);
  assert.equal(writes().length, 0);
  const found = new Set<string>();
  let after = '';
  do {
    const d = await ok(
      '/integrations/' + ch.id + '/offer-sync?limit=19' + (after ? '&after=' + after : ''),
    );
    for (const item of d.data) {
      assert(!found.has(item.listing_id));
      found.add(item.listing_id);
    }
    after = d.meta.cursor ?? '';
  } while (after);
  assert.equal(found.size, 126);
  await pause(ch, cfg);
});
test('stary lease nie zapisuje checkpointu i nie tworzy żądania oferty', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch),
    id = (await ok('/integrations/' + ch.id + '/offer-sync', 'POST', {})).id,
    job = await claim(id);
  await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [id, randomUUID()]);
  const count = calls.length;
  await processOfferSync(job, ctx);
  assert.equal(calls.length, count);
  assert.equal((await plans(ch)).length, 0);
  assert.equal(
    (await pool.query('SELECT payload FROM jobs WHERE id=$1', [id])).rows[0].payload.after,
    null,
  );
  await pause(ch, cfg);
});
test('utrata lease podczas GET nie utrwala planu i nie kolejkuje zapisu', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch),
    id = (await ok('/integrations/' + ch.id + '/offer-sync', 'POST', {})).id;
  hookRead = async () => {
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [id, randomUUID()]);
  };
  await executeSync(id);
  assert.equal((await plans(ch)).length, 0);
  assert.equal(writes().length, 0);
  assert.equal(
    (await pool.query('SELECT payload FROM jobs WHERE id=$1', [id])).rows[0].payload.after,
    null,
  );
  await pause(ch, cfg);
});
test('RLS chroni konfiguracje i wyniki, viewer/obca firma nie widzą kanału', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch);
  await cycle(ch);
  assert.equal(
    (await req('/integrations/' + ch.id + '/offer-sync', 'GET', undefined, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req('/integrations/' + ch.id + '/offer-sync', 'GET', undefined, other)).statusCode,
    404,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT * FROM offer_sync_configs WHERE channel_id=$1', [ch.id])).rowCount,
      0,
    );
    assert.equal(
      (await c.query('SELECT * FROM offer_sync_items WHERE channel_id=$1', [ch.id])).rowCount,
      0,
    );
  });
  await complete(ch);
  await pause(ch, cfg);
});
test('wyłączenie w trakcie przeglądu GET nie utrwala podglądu ani zapisu', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch);
  hookRead = () => pause(ch, cfg);
  const j = await cycle(ch);
  assert.equal(j.state, 'failed');
  assert.equal((await plans(ch)).length, 0);
  assert.equal(writes().length, 0);
});
test('zmiana ceny podczas PUT wymaga nowego przeglądu i nowego potwierdzenia', async () => {
  const ch = await channel(),
    f = await listing(ch),
    cfg = await configure(ch);
  await cycle(ch);
  hookWrite = async () => {
    const p = await ok('/products/' + f.p.id);
    await ok('/products/' + p.id, 'PATCH', {
      sku: p.sku,
      name: p.name,
      price: 15000,
      vat: p.vat,
      version: p.version,
    });
  };
  const p = await write((await plans(ch))[0]);
  assert.equal(p.state, 'done');
  assert.equal(p.result.local_changed, true);
  await cycle(ch);
  const next = (await plans(ch)).at(-1);
  assert.equal(next.payload.regular_price, '150.00');
  await write(next);
  await cycle(ch);
  assert.equal(store.get(f.external).regular_price, '150.00');
  assert.equal(writes().length, 2);
  await pause(ch, cfg);
});
test('Allegro 202 po wyłączeniu nadal czeka na operację i wyłącznie odczytuje wynik', async () => {
  const ch = await channel('allegro'),
    f = await listing(ch),
    cfg = await configure(ch);
  await cycle(ch);
  allegroPending = true;
  let p = await write((await plans(ch))[0]);
  assert.equal(p.state, 'queued');
  assert(p.operation_id);
  await pause(ch, cfg);
  p = await write(p);
  assert.equal(p.state, 'queued');
  assert.equal(writes().length, 1);
  assert.equal(
    calls.filter((c) => c.method === 'GET' && c.url.endsWith('/' + f.external)).length,
    2,
  );
  const remote = store.get(f.external);
  store.set(f.external, { ...remote, ...remote.pending });
  operationDone = true;
  p = await write(p);
  assert.equal(p.state, 'done');
  assert.equal(p.result.desired_applied, true);
  assert.equal(p.result.requested_payload.sellingMode.price.amount, '123.00');
  assert.equal(writes().length, 1);
});
test('symulator i wyłączenie produktu synchronizują stan zero bez żądań sieciowych', async () => {
  const ch = await channel('woocommerce', true),
    f = await listing(ch),
    cfg = await configure(ch);
  await cycle(ch);
  await complete(ch);
  const p = await ok('/products/' + f.p.id);
  await ok('/products/' + p.id, 'PATCH', {
    sku: p.sku,
    name: p.name,
    price: p.price,
    vat: p.vat,
    version: p.version,
    active: false,
  });
  await cycle(ch);
  const last = (await plans(ch)).at(-1);
  assert.equal(last.payload.stock_quantity, 0);
  assert.equal((await write(last)).result.scope, 'local_simulation');
  assert.equal(calls.length, 0);
  await pause(ch, cfg);
});
test('po utracie odpowiedzi zmiana sklepu blokuje nawet GET, przywrócenie pozwala uzgodnić', async () => {
  const ch = await channel();
  await listing(ch);
  const cfg = await configure(ch);
  await cycle(ch);
  lost = true;
  let p = await write((await plans(ch))[0]);
  assert.equal(p.state, 'queued');
  await pool.query(
    "UPDATE channels SET settings=jsonb_set(settings,'{store_url}','\"https://other.example\"'::jsonb) WHERE id=$1",
    [ch.id],
  );
  const count = calls.length;
  p = await write(p);
  assert.equal(p.state, 'failed');
  assert.equal(calls.length, count);
  assert(p.error.includes('pierwotne konto'));
  await pool.query(
    "UPDATE channels SET settings=jsonb_set(settings,'{store_url}','\"https://shop.example\"'::jsonb) WHERE id=$1",
    [ch.id],
  );
  await ok('/offer-plans/' + p.id + '/reconcile', 'POST', { accept_observed: true });
  p = await write((await plans(ch))[0]);
  assert.equal(p.state, 'done');
  assert.equal(p.result.scope, 'external_api_observed');
  assert.equal(writes().length, 1);
  await pause(ch, cfg);
});
test('ponowne połączenie OAuth unieważnia zgodę harmonogramu bez mylenia go z refresh', async () => {
  const ch = await channel('allegro');
  await listing(ch);
  const cfg = await configure(ch);
  await cycle(ch);
  const actor = { tenantId: DEMO_TENANT, userId: actorId, role: 'admin' as const };
  const auth: IntegrationContext = {
    oauthConfig: () => ({
      clientId: 'fixture-app',
      clientSecret: 'fixture-app-secret',
      redirectUri: 'http://127.0.0.1:4100/api/oauth/allegro/callback',
    }),
    transport: async (url) => {
      assert.equal(new URL(url).pathname, '/auth/oauth/token');
      return json({
        access_token: 'fixture-new',
        refresh_token: 'fixture-refresh',
        expires_in: 43199,
        scope: readScopes + ' ' + offerWriteScope,
      });
    },
  };
  const trusted = withAllegroRequestContext(auth, authenticatedRequest);
  const started = await beginOAuth(actor, ch.id, trusted, true);
  await finishOAuth(actor, new URL(started.url).searchParams.get('state')!, 'fixture-code', trusted);
  const after = (await pool.query('SELECT settings FROM channels WHERE id=$1', [ch.id])).rows[0];
  assert(after.settings.oauth_connection_id);
  const count = calls.length;
  await write((await plans(ch))[0]);
  assert.equal(calls.length, count);
  await pool.query('UPDATE offer_sync_configs SET next_run_at=now() WHERE channel_id=$1', [ch.id]);
  await scheduleOffersDue();
  assert.equal(
    (await pool.query('SELECT enabled FROM offer_sync_configs WHERE channel_id=$1', [ch.id]))
      .rows[0].enabled,
    false,
  );
  await pause(ch, cfg);
});
