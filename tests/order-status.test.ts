import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { demoWooOrder } from '../server/import-routes';
import { demoAllegroOrder } from '../server/allegro-example';
import type { FastifyRequest } from 'fastify';
import {
  beginOAuth,
  readScopes,
  orderWriteScope,
  withAllegroRequestContext,
  type IntegrationContext,
} from '../server/channel-access';
import {
  processStatusWrite,
  failStatusJob,
  processStatusScan,
  scheduleStatusesDue,
  STATUS_BATCH,
} from '../server/order-status';
import { Problem } from '../server/errors';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  authenticatedRequest: FastifyRequest,
  cookie: string,
  viewer: string,
  other: string,
  warehouse: string,
  user: string,
  counter = 99100;
const store = new Map<string, any>(),
  calls: { method: string; url: URL; body: any; headers: Headers }[] = [];
let lost = false,
  noApply = false,
  getHook: (() => Promise<void>) | undefined,
  writeHook: (() => Promise<void>) | undefined,
  putError = 0,
  readsFail = false;
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status });
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    const u = new URL(url),
      method = init.method ?? 'GET',
      body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url: u, body, headers: new Headers(init.headers) });
    const allegro = u.pathname.startsWith('/order/'),
      key = u.pathname.split('/').at(allegro && method === 'PUT' ? -2 : -1)!;
    const raw = store.get(key);
    assert(raw, 'Missing fake remote order');
    if (method === 'GET') {
      const hook = getHook;
      getHook = undefined;
      await hook?.();
      if (readsFail) return json({}, 503);
      return json(raw);
    }
    assert.equal(method, 'PUT');
    assert.deepEqual(Object.keys(body), ['status']);
    if (putError) return json({ secret: 'NEVER_EXPOSE_PROVIDER_SECRET' }, putError);
    if (allegro) {
      assert.equal(u.searchParams.get('checkoutForm.revision'), raw.revision);
      assert.equal(
        new Headers(init.headers).get('Content-Type'),
        'application/vnd.allegro.public.v1+json',
      );
    }
    if (!noApply) {
      if (allegro) {
        raw.fulfillment.status = body.status;
        raw.revision += 'x';
      } else {
        raw.status = body.status;
        raw.date_modified_gmt = String(Number(raw.date_modified_gmt) + 1);
      }
    }
    const hook = writeHook;
    writeHook = undefined;
    await hook?.();
    if (lost) {
      lost = false;
      throw new Problem(502, 'Utracono odpowiedź');
    }
    return allegro ? new Response(null, { status: 204 }) : json(raw);
  },
};
const req = (p: string, m: any = 'GET', b?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method: m, payload: b, headers: { cookie: auth } });
async function ok(p: string, m: any = 'GET', b?: any) {
  const r = await req(p, m, b);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  // beginOAuth needs the trusted caller context of a natively authenticated request (withAllegroRequestContext).
  app.addHook('preHandler', async (r) => {
    if (r.url === '/api/auth/me') authenticatedRequest = r;
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
  user = (await ok('/auth/me')).user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  calls.length = 0;
  lost = false;
  noApply = false;
  getHook = undefined;
  writeHook = undefined;
  putError = 0;
  readsFail = false;
});
async function fixture(provider = 'woocommerce', simulation = false, cod = false) {
  const ch = randomUUID(),
    raw: any = structuredClone(provider === 'allegro' ? demoAllegroOrder : demoWooOrder);
  raw.id = provider === 'allegro' ? 'allegro-' + randomUUID() : ++counter;
  raw.date_modified_gmt = '1';
  if (provider === 'allegro') raw.revision = 'revision-1';
  if (cod) {
    if (provider === 'allegro') raw.payment = { type: 'CASH_ON_DELIVERY', paidAmount: null };
    else {
      raw.payment_method = 'cod';
      raw.date_paid = null;
    }
  }
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,settings,credentials,oauth_scopes) VALUES($1,$2,$3,$4,'sandbox',$5,$6,$7)",
      [
        ch,
        DEMO_TENANT,
        provider,
        'Status QA',
        JSON.stringify({ store_url: 'https://example.com', simulation }),
        encrypt({ consumer_key: 'test', consumer_secret: 'test', access_token: 'test' }),
        readScopes + ' ' + orderWriteScope,
      ],
    ),
  );
  const p = await ok('/products', 'POST', {
    sku: 'STATUS-' + randomUUID().slice(0, 8),
    name: 'Status produktu',
    warehouse_id: warehouse,
    quantity: 10,
    price: 1000,
    vat: 23,
  });
  const staged = (await ok('/integrations/' + ch + '/stage-orders', 'POST', { data: [raw] }))
    .data[0];
  await ok('/integrations/' + ch + '/mappings', 'POST', {
    external_id: provider === 'allegro' ? 'demo-offer-1' : '701',
    sku: p.sku,
  });
  const imported = await ok('/imports/' + staged.id + '/commit', 'POST', {
    warehouse_id: warehouse,
  });
  const o = imported.order ?? imported; // Import response has {order} in the established route.
  assert(o.id, JSON.stringify(imported));
  store.set(String(raw.id), raw);
  return { ch, o, p, raw };
}
async function ship(f: any) {
  await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'picking' }));
  for (let n = 0; n < 3; n++) await ok('/orders/' + f.o.id + '/scan', 'POST', { code: f.p.sku });
  await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'packed' }));
  await ok('/orders/' + f.o.id + '/ship-demo', 'POST', {});
}
async function preview(f: any) {
  return ok('/orders/' + f.o.id + '/channel-status/preview', 'POST', {});
}
async function queue(p: any) {
  return ok('/channel-status-plans/' + p.id + '/queue', 'POST', { confirm_external: true });
}
async function claim(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function work(p: any) {
  const j = await claim(p.job_id);
  try {
    await processStatusWrite(j, ctx);
  } catch (e) {
    await failStatusJob(j, e);
  }
  return (await ok('/orders/' + p.order_id + '/channel-status')).data.find(
    (x: any) => x.id === p.id,
  );
}
const puts = () => calls.filter((c) => c.method === 'PUT');
async function configure(f: any, enabled = true, version = 0) {
  return ok('/integrations/' + f.ch + '/order-status', 'PATCH', {
    version,
    enabled,
    confirm_external: true,
  });
}
async function scanJob(ch: string) {
  return (
    await pool.query(
      "SELECT * FROM jobs WHERE kind='order.status.scan' AND state='pending' AND payload->>'channel_id'=$1 ORDER BY created_at DESC LIMIT 1",
      [ch],
    )
  ).rows[0];
}
async function scan(f: any) {
  const found = await scanJob(f.ch);
  assert(found);
  const j = await claim(found.id);
  try {
    await processStatusScan(j, ctx);
  } catch (e) {
    await failStatusJob(j, e);
  }
  return (await pool.query('SELECT * FROM jobs WHERE id=$1', [j.id])).rows[0];
}
test('WooCommerce: podgląd → jedna aktualizacja → GET potwierdzający; bez zmiany lokalnego zamówienia i magazynu', async () => {
  const f = await fixture();
  await ship(f);
  const before = await ok('/orders/' + f.o.id),
    stockBefore = await ok('/inventory');
  const p = await preview(f);
  assert.equal(p.target, 'completed');
  assert.equal(p.remote.status, 'processing');
  assert.equal(puts().length, 0);
  const done = await work(await queue(p));
  assert.equal(done.state, 'done');
  assert.equal(done.result.status, 'completed');
  assert.equal(puts().length, 1);
  assert.equal(puts()[0].url.pathname, '/wp-json/wc/v3/orders/' + f.raw.id);
  assert.deepEqual(await ok('/orders/' + f.o.id), before);
  assert.deepEqual(await ok('/inventory'), stockBefore);
});
test('Allegro: PUT fulfillment z rewizją, 204, potwierdzenie GET', async () => {
  const f = await fixture('allegro');
  const done = await work(await queue(await preview(f)));
  assert.equal(done.state, 'done');
  assert.equal(done.result.status, 'PROCESSING');
  assert.equal(puts().length, 1);
});
test('Allegro: spakowane READY_FOR_SHIPMENT, nadane SENT', async () => {
  const f = await fixture('allegro');
  await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'picking' }));
  for (let n = 0; n < 3; n++) await ok('/orders/' + f.o.id + '/scan', 'POST', { code: f.p.sku });
  await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'packed' }));
  let done = await work(await queue(await preview(f)));
  assert.equal(done.result.status, 'READY_FOR_SHIPMENT');
  await ok('/orders/' + f.o.id + '/ship-demo', 'POST', {});
  done = await work(await queue(await preview(f)));
  assert.equal(done.result.status, 'SENT');
  assert.equal(puts().length, 2);
});
test('Status już zgodny daje potwierdzony no-op', async () => {
  const f = await fixture();
  const done = await work(await queue(await preview(f)));
  assert.equal(done.result.unchanged, true);
  assert.equal(puts().length, 0);
});
test('Ręczny zapis wymaga osobnego potwierdzenia również dla sandbox', async () => {
  const f = await fixture('allegro'),
    p = await preview(f);
  assert.equal((await req('/channel-status-plans/' + p.id + '/queue', 'POST', {})).statusCode, 422);
  assert.equal(puts().length, 0);
});
test('Zmieniona lokalna wersja blokuje kolejkę i worker przed PUT', async () => {
  const f = await fixture();
  await ship(f);
  const p = await preview(f);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE orders SET note='zmiana' WHERE id=$1", [f.o.id]),
  );
  assert.equal(
    (await req('/channel-status-plans/' + p.id + '/queue', 'POST', { confirm_external: true }))
      .statusCode,
    409,
  );
  const queued = await queue(await preview(f));
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE orders SET note='kolejna zmiana' WHERE id=$1", [f.o.id]),
  );
  assert.equal((await work(queued)).state, 'conflict');
  assert.equal(puts().length, 0);
});
test('Zmiana danych odbiorcy między podglądem a zapisem blokuje PUT', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(await preview(f));
  f.raw.billing.address_1 = 'Inna 9';
  const result = await work(p);
  assert.equal(result.state, 'conflict');
  assert.match(result.error, /odbiorcy/);
  assert.equal(puts().length, 0);
});
test('Zmiana rewizji Allegro między podglądem a zapisem blokuje PUT', async () => {
  const f = await fixture('allegro'),
    p = await queue(await preview(f));
  f.raw.revision = 'new';
  assert.equal((await work(p)).state, 'conflict');
  assert.equal(puts().length, 0);
});
test('Zmiana konfiguracji po GET a przed PUT zatrzymuje nowe żądanie', async () => {
  const f = await fixture();
  await ship(f);
  const p = await queue(await preview(f));
  getHook = () =>
    tenantTx(DEMO_TENANT, (c) =>
      c.query("UPDATE orders SET note='w trakcie odczytu' WHERE id=$1", [f.o.id]),
    ).then(() => {});
  assert.equal((await work(p)).state, 'conflict');
  assert.equal(puts().length, 0);
});
for (const provider of ['woocommerce', 'allegro'])
  test(provider + ': utrata odpowiedzi nie powtarza PUT; wznowienie tylko GET', async () => {
    const f = await fixture(provider);
    if (provider === 'woocommerce') await ship(f);
    const p = await queue(await preview(f));
    lost = true;
    let result = await work(p);
    assert.equal(result.state, 'queued');
    assert.equal(result.phase, 'write_started');
    assert.equal(puts().length, 1);
    result = await work(p);
    assert.equal(result.state, 'done');
    assert.equal(puts().length, 1);
  });
test('Niepewny zapis bez zmiany blokuje nowy plan, a ręczne uzgodnienie jest tylko odczytem', async () => {
  const f = await fixture('allegro'),
    p = await queue(await preview(f));
  lost = true;
  noApply = true;
  await work(p);
  await pool.query('UPDATE jobs SET attempts=max_attempts-1 WHERE id=$1', [p.job_id]);
  const failed = await work(p);
  assert.equal(failed.state, 'failed');
  assert.equal(
    (
      await req('/channel-status-plans/' + (await preview(f)).id + '/queue', 'POST', {
        confirm_external: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await req('/channel-status-plans/' + p.id + '/reconcile', 'POST', {})).statusCode,
    409,
  );
  assert.equal(puts().length, 1);
  const closed = await ok('/channel-status-plans/' + p.id + '/reconcile', 'POST', {
    acknowledge_mismatch: true,
  });
  assert.equal(closed.state, 'conflict');
  assert.equal(closed.phase, 'done');
  assert.equal(puts().length, 1);
  assert.equal((await queue(await preview(f))).state, 'queued');
});
test('Jawne 409 Allegro kończy odrzucony zapis bez ponowienia', async () => {
  const f = await fixture('allegro'),
    p = await queue(await preview(f));
  putError = 409;
  const done = await work(p);
  assert.equal(done.state, 'conflict');
  assert.equal(done.phase, 'done');
  assert.equal(puts().length, 1);
  assert(!JSON.stringify(done).includes('NEVER_EXPOSE_PROVIDER_SECRET'));
});
test('Po wysłaniu żądania zmiana lokalnego zamówienia nie zatrzymuje odczytu wyniku', async () => {
  const f = await fixture('allegro'),
    p = await queue(await preview(f));
  writeHook = () =>
    tenantTx(DEMO_TENANT, (c) =>
      c.query("UPDATE orders SET note='po wysłaniu' WHERE id=$1", [f.o.id]),
    ).then(() => {});
  const done = await work(p);
  assert.equal(done.state, 'done');
  assert.equal(done.result.stale_local, true);
  assert.equal(puts().length, 1);
});
test('Równoległe zlecenia i identyczne ponowienie nie tworzą dwóch zapisów', async () => {
  const f = await fixture('allegro'),
    a = await preview(f),
    b = await preview(f);
  const results = await Promise.all([
    req('/channel-status-plans/' + a.id + '/queue', 'POST', { confirm_external: true }),
    req('/channel-status-plans/' + b.id + '/queue', 'POST', { confirm_external: true }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const queued = results.find((r) => r.statusCode === 200)!.json();
  assert.equal((await queue(queued)).job_id, queued.job_id);
  await Promise.all([work(queued), work(queued)]);
  assert.equal(puts().length, 1);
});
test('Anulowanie przed wysłaniem żądania zatrzymuje worker', async () => {
  const f = await fixture('allegro'),
    p = await queue(await preview(f));
  const j = await claim(p.job_id);
  await ok('/channel-status-plans/' + p.id + '/cancel', 'POST', {});
  await processStatusWrite(j, ctx);
  assert.equal(puts().length, 0);
});
test('Obca organizacja i viewer nie mogą czytać ani pisać statusów', async () => {
  const f = await fixture('allegro');
  assert.equal(
    (await req('/orders/' + f.o.id + '/channel-status', 'GET', undefined, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req('/orders/' + f.o.id + '/channel-status', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await tenantTx(SECOND_TENANT, (c) => c.query('SELECT * FROM order_status_plans'))).rowCount,
    0,
  );
});
test('Odebrana rola administratora zatrzymuje PUT', async () => {
  const f = await fixture('allegro'),
    p = await queue(await preview(f));
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  try {
    const j = await claim(p.job_id);
    // The Allegro job authority refuses the withdrawn author before the status policy does.
  await assert.rejects(() => processStatusWrite(j, ctx), /uprawnień|utracił rolę administratora/);
    assert.equal(puts().length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  }
});
test('Brak orders:write nie może być zastąpiony prawem zapisu ofert', async () => {
  const f = await fixture('allegro');
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE channels SET oauth_scopes=$2 WHERE id=$1', [
      f.ch,
      readScopes + ' allegro:api:sale:offers:write',
    ]),
  );
  const p = await preview(f);
  assert.equal(
    (await req('/channel-status-plans/' + p.id + '/queue', 'POST', { confirm_external: true }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await req('/integrations/' + f.ch + '/order-status', 'PATCH', {
        version: 0,
        enabled: true,
        confirm_external: true,
      })
    ).statusCode,
    403,
  );
});
test('OAuth żąda osobnego zakresu zamówień bez uprawnienia płatności', async () => {
  const f = await fixture('allegro');
  const result = await beginOAuth(
    { tenantId: DEMO_TENANT, userId: user, role: 'admin' },
    f.ch,
    withAllegroRequestContext(
      {
        oauthConfig: () => ({
          clientId: 'app',
          clientSecret: 'secret',
          redirectUri: 'http://127.0.0.1:4100/api/oauth/allegro/callback',
        }),
      },
      authenticatedRequest,
    ),
    false,
    true,
  );
  assert.equal(new URL(result.url).searchParams.get('scope'), readScopes + ' ' + orderWriteScope);
  assert(!result.url.includes('payments:write'));
});
test('Refundacja i One Fulfillment blokują zapis', async () => {
  const f = await fixture();
  f.raw.refunds = [{ id: 1 }];
  assert.equal(
    (await req('/orders/' + f.o.id + '/channel-status/preview', 'POST', {})).statusCode,
    409,
  );
  const a = await fixture('allegro');
  a.raw.fulfillment.provider = { id: 'ALLEGRO' };
  assert.equal(
    (await req('/orders/' + a.o.id + '/channel-status/preview', 'POST', {})).statusCode,
    409,
  );
  assert.equal(puts().length, 0);
});
test('Cofnięcie statusu i seller RETURNED nie są dopuszczone', async () => {
  const f = await fixture('allegro');
  f.raw.fulfillment.status = 'SENT';
  assert.equal(
    (await req('/orders/' + f.o.id + '/channel-status/preview', 'POST', {})).statusCode,
    409,
  );
  f.raw.fulfillment.status = 'RETURNED';
  assert.equal(
    (await req('/orders/' + f.o.id + '/channel-status/preview', 'POST', {})).statusCode,
    409,
  );
  assert.equal(puts().length, 0);
});
test('Anulowanie mapuje oba kanały i nie refunduje płatności', async () => {
  for (const provider of ['woocommerce', 'allegro']) {
    const f = await fixture(provider);
    await ok('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'cancelled' }));
    const done = await work(await queue(await preview(f)));
    assert.equal(done.result.status, provider === 'allegro' ? 'CANCELLED' : 'cancelled');
  }
  assert.equal(puts().length, 2);
});
test('Automatyczny catch-up, zdarzenie, brak powtórnego zapisu i pauza', async () => {
  const f = await fixture('allegro');
  await configure(f);
  await scheduleStatusesDue();
  let scanResult = await scan(f);
  assert.equal(scanResult.state, 'done');
  let panel = await ok('/orders/' + f.o.id + '/channel-status'),
    p = panel.data.find((x: any) => x.state === 'queued');
  assert(p);
  await work(p);
  assert.equal(puts().length, 1);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE order_status_configs SET next_run_at=now() WHERE channel_id=$1', [f.ch]),
  );
  await scheduleStatusesDue();
  await scan(f);
  assert.equal((await ok('/orders/' + f.o.id + '/channel-status')).data.length, 1);
  await ship(f);
  assert(await scanJob(f.ch), 'Event must wake a scan');
  await scan(f);
  p = (await ok('/orders/' + f.o.id + '/channel-status')).data.find(
    (x: any) => x.state === 'queued',
  );
  assert(p);
  await configure(f, false, 1);
  assert.equal(
    (await ok('/orders/' + f.o.id + '/channel-status')).data.find((x: any) => x.id === p.id).state,
    'conflict',
  );
  assert.equal(puts().length, 1);
});
test('WooCommerce automatyczny przegląd: harmonogram, REST z Basic auth, kursor i brak drugiego PUT po utracie odpowiedzi', async () => {
  const f = await fixture();
  await ship(f);
  const path = '/wp-json/wc/v3/orders/' + f.raw.id,
    auth = 'Basic ' + Buffer.from('test:test').toString('base64'),
    zero = { checked: 0, queued: 0, skipped: 0, errors: 0 };
  const config = (channel: string) =>
    tenantTx(DEMO_TENANT, async (c) =>
      (
        await c.query(
          'SELECT *,next_run_at>now() AS later FROM order_status_configs WHERE channel_id=$1',
          [channel],
        )
      ).rows[0],
    );
  const tick = async () => {
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE order_status_configs SET next_run_at=now() WHERE channel_id=$1', [f.ch]),
    );
    await scheduleStatusesDue();
    return scan(f);
  };
  const cfg = await configure(f);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.external_authorized, true);
  assert.equal(await scanJob(f.ch), undefined);
  await scheduleStatusesDue();
  const queuedScan = await scanJob(f.ch);
  assert(queuedScan, 'Due WooCommerce config must enqueue a scan');
  assert.deepEqual(queuedScan.payload, {
    channel_id: f.ch,
    actor_id: user,
    version: cfg.version,
    after: null,
    stats: zero,
  });
  let current = await config(f.ch);
  assert.equal(current.last_job_id, queuedScan.id);
  assert.equal(current.later, true);
  await scheduleStatusesDue();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='order.status.scan' AND payload->>'channel_id'=$1",
        [f.ch],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(calls.length, 0);
  const scanned = await scan(f);
  assert.equal(scanned.id, queuedScan.id);
  assert.equal(scanned.state, 'done');
  assert.deepEqual(scanned.payload.stats, { ...zero, checked: 1, queued: 1 });
  assert.equal(scanned.payload.after, f.o.id);
  assert.deepEqual(
    calls.map((c) => [c.method, c.url.origin + c.url.pathname, c.headers.get('authorization')]),
    [['GET', 'https://example.com' + path, auth]],
  );
  current = await config(f.ch);
  assert(current.last_run_at);
  assert.equal(current.last_job_id, scanned.id);
  assert.equal(current.error, null);
  const p = (await ok('/orders/' + f.o.id + '/channel-status')).data.find(
    (x: any) => x.state === 'queued',
  );
  assert(p);
  assert.equal(p.phase, 'ready');
  assert.equal(p.target, 'completed');
  assert.equal(p.config_version, cfg.version);
  assert.equal(p.remote.status, 'processing');
  lost = true;
  let result = await work(p);
  assert.equal(result.state, 'queued');
  assert.equal(result.phase, 'write_started');
  assert.deepEqual(
    calls.slice(1).map((c) => [c.method, c.url.pathname]),
    [
      ['GET', path],
      ['PUT', path],
    ],
  );
  assert.deepEqual(puts()[0].body, { status: 'completed' });
  assert.equal(puts()[0].headers.get('authorization'), auth);
  assert.equal(puts()[0].headers.get('content-type'), 'application/json');
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [p.job_id])).rows[0].state,
    'pending',
  );
  // A due tick while the write result is uncertain neither reads nor writes this order.
  const again = await tick();
  assert.equal(again.state, 'done');
  assert.deepEqual(again.payload.stats, zero);
  assert.equal(calls.length, 3);
  result = await work(p);
  assert.equal(result.state, 'done');
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.unchanged, false);
  assert.deepEqual(calls.slice(3).map((c) => [c.method, c.url.pathname]), [['GET', path]]);
  assert.equal(f.raw.status, 'completed');
  const last = await tick();
  assert.deepEqual(last.payload.stats, zero);
  assert.equal(puts().length, 1);
  assert.equal(calls.length, 4);
  assert.equal((await ok('/orders/' + f.o.id + '/channel-status')).data.length, 1);
  assert.equal((await ok('/orders/' + f.o.id)).status, 'shipped');
});
test('Pauza po utracie odpowiedzi zachowuje GET-only uzgodnienie', async () => {
  const f = await fixture('allegro');
  await configure(f);
  await scheduleStatusesDue();
  await scan(f);
  const p = (await ok('/orders/' + f.o.id + '/channel-status')).data[0];
  lost = true;
  await work(p);
  await configure(f, false, 1);
  const done = await work(p);
  assert.equal(done.state, 'done');
  assert.equal(puts().length, 1);
});
test('Przegląd większy niż 25 zamówień zapisuje kursor i wznawia kolejną stronę', async () => {
  const f = await fixture('allegro');
  for (let n = 0; n < STATUS_BATCH; n++) {
    const raw = structuredClone(f.raw);
    raw.id = 'page-' + randomUUID();
    store.set(raw.id, raw);
    const staged = (await ok('/integrations/' + f.ch + '/stage-orders', 'POST', { data: [raw] }))
      .data[0];
    await ok('/imports/' + staged.id + '/commit', 'POST', { warehouse_id: warehouse }).catch(
      async () => {
        await tenantTx(DEMO_TENANT, (c) =>
          c.query('UPDATE stock SET on_hand=on_hand+100 WHERE warehouse_id=$1 AND product_id=$2', [
            warehouse,
            f.p.id,
          ]),
        );
        await ok('/imports/' + staged.id + '/commit', 'POST', { warehouse_id: warehouse });
      },
    );
  }
  await configure(f);
  await scheduleStatusesDue();
  const first = await scan(f);
  assert.equal(first.state, 'pending');
  assert.equal(first.payload.stats.checked, 25);
  const second = await scan(f);
  assert.equal(second.state, 'done');
  assert.equal(second.payload.stats.checked, 26);
  assert.equal(second.payload.stats.queued, 26);
});
test('Symulator zapisuje osobny stan źródła bez HTTP', async () => {
  const f = await fixture('allegro', true),
    done = await work(await queue(await preview(f)));
  assert.equal(done.state, 'done');
  assert.equal(done.result.status, 'PROCESSING');
  assert.equal(calls.length, 0);
});

test('Nieaktualna dzierżawa nie może wysłać PUT ani zapisać wyniku', async () => {
  const f = await fixture('allegro'),
    p = await queue(await preview(f)),
    old = await claim(p.job_id);
  await pool.query("UPDATE jobs SET state='pending',lease_token=NULL WHERE id=$1", [p.job_id]);
  // The Allegro job authority refuses the stale lease before any provider request.
  await assert.rejects(() => processStatusWrite(old, ctx), /Dzierżawa zadania Allegro została utracona/);
  assert.equal(puts().length, 0);
  const done = await work(p);
  assert.equal(done.state, 'done');
  assert.equal(puts().length, 1);
});
test('Zmiana połączenia blokuje PUT, a żaden sekret nie trafia do panelu', async () => {
  const f = await fixture('allegro'),
    p = await queue(await preview(f));
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      'UPDATE channels SET settings=settings||\'{"oauth_connection_id":"different-account"}\' WHERE id=$1',
      [f.ch],
    ),
  );
  const result = await work(p);
  assert.equal(result.state, 'conflict');
  assert.equal(puts().length, 0);
  const panel = await ok('/integrations/' + f.ch + '/order-status');
  assert(!JSON.stringify(panel).includes('access_token'));
  assert(!JSON.stringify(panel).includes('credentials'));
});
test('Automatyczny niewysłany plan ustępuje nowszemu etapowi zamówienia', async () => {
  const f = await fixture('allegro');
  await configure(f);
  await scheduleStatusesDue();
  await scan(f);
  const first = (await ok('/orders/' + f.o.id + '/channel-status')).data.find(
    (p: any) => p.state === 'queued',
  );
  assert(first);
  await ship(f);
  await scan(f);
  const panel = await ok('/orders/' + f.o.id + '/channel-status');
  assert.equal(panel.data.find((p: any) => p.id === first.id).state, 'conflict');
  const latest = panel.data.find((p: any) => p.state === 'queued');
  assert.equal(latest.target, 'SENT');
  assert.equal((await work(latest)).state, 'done');
  assert.equal(puts().length, 1);
});
test('Równoległe workery ponad rozmiarem puli nie wyczerpują połączeń przez blokady sesyjne', async () => {
  const plans = [];
  for (let n = 0; n < 14; n++) {
    const f = await fixture('allegro');
    plans.push(await queue(await preview(f)));
  }
  const jobs = await Promise.all(plans.map((p) => claim(p.job_id)));
  await Promise.all(jobs.map((j) => processStatusWrite(j, ctx)));
  assert.equal(puts().length, 14);
});

test('Odebrana rola wyłącza automatyczną konfigurację bez zapisu do API', async () => {
  const f = await fixture('allegro');
  await configure(f);
  await scheduleStatusesDue();
  const j = await claim((await scanJob(f.ch)).id);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  try {
    await assert.rejects(
      () => processStatusScan(j, ctx),
      (e) => {
        assert(e instanceof Problem);
        return e.status === 403;
      },
    );
    await failStatusJob(j, new Problem(403, 'Administrator nie ma już uprawnień'));
    const cfg = (
      await tenantTx(DEMO_TENANT, (c) =>
        c.query('SELECT enabled,error FROM order_status_configs WHERE channel_id=$1', [f.ch]),
      )
    ).rows[0];
    assert.equal(cfg.enabled, false);
    assert.match(cfg.error, /uprawnień/);
    assert.equal(puts().length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  }
});
test('401 na PUT odświeża OAuth, lecz nigdy nie odtwarza żądania zapisu', async () => {
  const f = await fixture('allegro'),
    p = await queue(await preview(f));
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
      f.ch,
      encrypt({ access_token: 'test', refresh_token: 'refresh-test' }),
    ]),
  );
  let putCount = 0,
    tokenCount = 0;
  const tokenCtx: IntegrationContext = {
    oauthConfig: () => ({
      clientId: 'test-app',
      clientSecret: 'test-secret',
      redirectUri: 'http://127.0.0.1:4100/api/oauth/allegro/callback',
    }),
    transport: async (url, init) => {
      if (new URL(url).pathname === '/auth/oauth/token') {
        tokenCount++;
        return json({
          access_token: 'new-test',
          refresh_token: 'rotated-test',
          expires_in: 3600,
          scope: readScopes + ' ' + orderWriteScope,
        });
      }
      if (init.method === 'PUT') {
        putCount++;
        if (putCount === 1) return json({}, 401);
      }
      return ctx.transport!(url, init);
    },
  };
  for (let n = 0; n < 2; n++) {
    const j = await claim(p.job_id);
    try {
      await processStatusWrite(j, tokenCtx);
    } catch (e) {
      await failStatusJob(j, e);
    }
  }
  assert.equal(putCount, 1);
  assert.equal(tokenCount, 1);
  const current = (await ok('/orders/' + f.o.id + '/channel-status')).data.find(
    (x: any) => x.id === p.id,
  );
  assert.equal(current.phase, 'write_started');
  assert.equal(current.state, 'queued');
});

for (const provider of ['woocommerce', 'allegro'])
  test(provider + ' COD fulfillment status writes without claiming a payment', async () => {
    const f = await fixture(provider, false, true);
    // Cash on delivery starts ready to fulfil: status paid ("Nowe") with nothing received (server/domain.ts createOrder).
    assert.equal(f.o.status, 'paid');
    assert.equal(f.o.payment.received, 0);
    await ship(f);
    const result = await work(await queue(await preview(f)));
    assert.equal(result.state, 'done');
    const o = await ok('/orders/' + f.o.id);
    assert.equal(o.payment.received, 0);
    assert.equal(o.payment.amount_due, o.total);
    assert.equal(o.status, 'shipped');
    f.raw.payment =
      provider === 'allegro'
        ? {
            type: 'ONLINE',
            paidAmount: { amount: (o.total / 100).toFixed(2), currency: o.currency },
          }
        : f.raw.payment;
    if (provider === 'woocommerce') {
      f.raw.payment_method = 'bacs';
      f.raw.date_paid = '2026-10-04T12:00:00';
    }
    assert.equal(
      (await req('/orders/' + o.id + '/channel-status/preview', 'POST', {})).statusCode,
      409,
    );
  });
