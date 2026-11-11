import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt, decrypt } from '../server/security';
import {
  channelRead,
  refreshOAuth,
  readScopes,
  withAllegroRequestContext,
  type IntegrationContext,
} from '../server/channel-access';
import { tick } from '../server/worker';
import { scheduleDue, processIntegrationJob } from '../server/sync';
import { demoWooOrder } from '../server/import-routes';
import { WooCommerce } from '../server/integrations';
assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance, cookie: string, otherCookie: string, viewerCookie: string, userId: string;
let authenticatedRequest: FastifyRequest;
let fail = false,
  tokenCalls = 0,
  eventsSeen: string[] = [],
  providerCalls: string[] = [];
const raw = (id: number) => ({ ...structuredClone(demoWooOrder), id });
const config = {
  clientId: 'test-client',
  clientSecret: 'test-app-secret',
  redirectUri: 'http://127.0.0.1:4100/api/oauth/allegro/callback',
};
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status });
const ctx: IntegrationContext = {
  oauthConfig: () => config,
  transport: async (url, init) => {
    providerCalls.push(url);
    const u = new URL(url);
    if (u.pathname === '/auth/oauth/token') {
      tokenCalls++;
      const params = new URLSearchParams(String(init.body));
      assert.ok(['authorization_code', 'refresh_token'].includes(params.get('grant_type')!));
      return json({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 43199 });
    }
    if (fail) return json({ secret: 'DO_NOT_LOG' }, 401);
    if (u.pathname === '/order/event-stats') return json({ latestEvent: { id: 'event-0' } });
    if (u.pathname === '/order/events') {
      eventsSeen.push(u.searchParams.get('from') ?? '');
      return json({
        events:
          u.searchParams.get('from') === 'event-0'
            ? [{ id: 'event-1', order: { checkoutForm: { id: 'order-a' } } }]
            : [],
      });
    }
    if (u.pathname.startsWith('/order/checkout-forms/')) return json(allegroOrder());
    if (u.pathname === '/order/checkout-forms') return json({ checkoutForms: [], totalCount: 0 });
    if (/\/orders\/\d+$/.test(u.pathname))
      return json({ ...raw(97001), customer_note: 'Aktualny stan z API' });
    const page = Number(u.searchParams.get('page'));
    return json(page === 1 ? Array.from({ length: 50 }, (_, i) => raw(20000 + i)) : [raw(20050)]);
  },
};
function allegroOrder() {
  return {
    id: 'order-a',
    status: 'READY_FOR_PROCESSING',
    buyer: { email: 'test@example.test' },
    payment: { type: 'ONLINE', paidAmount: { amount: '10.00', currency: 'PLN' } },
    delivery: {
      address: {
        firstName: 'Jan',
        lastName: 'Test',
        city: 'Warszawa',
        street: 'Testowa 1',
        zipCode: '00-001',
        countryCode: 'PL',
      },
      cost: { amount: '0.00', currency: 'PLN' },
    },
    summary: { totalToPay: { amount: '10.00', currency: 'PLN' } },
    lineItems: [
      {
        offer: { id: 'offer-a', name: 'Produkt' },
        quantity: 1,
        price: { amount: '10.00', currency: 'PLN' },
      },
    ],
  };
}
const req = (url: string, method: any = 'GET', payload?: any, session = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: session } });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport, oauthConfig: ctx.oauthConfig });
  app.addHook('preHandler', async req => {
    if (req.url === '/api/auth/me') authenticatedRequest = req;
  });
  async function login(email: string) {
    const r = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email, password: 'DynaDemo!2026' },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  cookie = await login('admin@demo.local');
  otherCookie = await login('other@demo.local');
  viewerCookie = await login('viewer@demo.local');
  userId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  const me = await req('/api/auth/me');
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(authenticatedRequest.actor.userId, userId);
  assert.equal(authenticatedRequest.actor.tenantId, DEMO_TENANT);
});
beforeEach(async () => {
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
  fail = false;
  tokenCalls = 0;
  eventsSeen = [];
  providerCalls = [];
});
after(async () => {
  await app.close();
  await pool.end();
});
async function channel(provider = 'woocommerce', simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      'INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,sync_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        DEMO_TENANT,
        provider,
        'Kanał testowy',
        'sandbox',
        encrypt({
          consumer_key: 'key',
          consumer_secret: 'secret',
          access_token: 'old-token',
          refresh_token: 'old-refresh',
          webhook_secret: 'local-test-webhook-secret',
        }),
        JSON.stringify({ store_url: 'https://example.com', simulation }),
        userId,
      ],
    ),
  );
  return id;
}
async function job(id: string) {
  return (await tenantTx(DEMO_TENANT, (c) => c.query('SELECT * FROM jobs WHERE id=$1', [id])))
    .rows[0];
}
test('OAuth: PKCE, ograniczone zakresy, jednorazowy stan i zaszyfrowane tokeny', async () => {
  const ch = await channel('allegro');
  const started = await req(`/api/integrations/${ch}/oauth/start`, 'POST');
  assert.equal(started.statusCode, 200, started.body);
  const u = new URL(started.json().url),
    state = u.searchParams.get('state')!;
  assert.equal(u.hostname, 'allegro.pl.allegrosandbox.pl');
  assert.equal(u.searchParams.get('scope'), readScopes);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const pending = (
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('SELECT * FROM oauth_states WHERE channel_id=$1', [ch]),
    )
  ).rows[0];
  assert.notEqual(pending.verifier, decrypt(pending.verifier).verifier);
  assert.equal(
    u.searchParams.get('code_challenge'),
    createHash('sha256').update(decrypt(pending.verifier).verifier).digest('base64url'),
  );
  const callback = `/api/oauth/allegro/callback?state=${state}&code=test-code`;
  assert.equal((await req(callback, 'GET', undefined, otherCookie)).statusCode, 422);
  const completed = await req(callback);
  assert.equal(completed.statusCode, 302, completed.body);
  assert.equal(completed.headers.location, '/?integration=connected');
  assert.equal(tokenCalls, 1);
  assert.equal((await req(callback)).statusCode, 422);
  assert.equal(tokenCalls, 1);
  const saved = (
    await tenantTx(DEMO_TENANT, (c) => c.query('SELECT * FROM channels WHERE id=$1', [ch]))
  ).rows[0];
  assert.ok(!saved.credentials.includes('new-token'));
  assert.equal(decrypt(saved.credentials).refresh_token, 'new-refresh');
  assert.ok(saved.token_expires_at);
  assert.ok(!(await req('/api/integrations')).body.includes('new-token'));
});
test('wygasły stan OAuth i viewer nie mogą autoryzować konta', async () => {
  const ch = await channel('allegro');
  assert.equal(
    (await req(`/api/integrations/${ch}/oauth/start`, 'POST', undefined, viewerCookie)).statusCode,
    403,
  );
  const started = await req(`/api/integrations/${ch}/oauth/start`, 'POST');
  const state = new URL(started.json().url).searchParams.get('state')!;
  await tenantTx(DEMO_TENANT, (c) =>
    c.query("UPDATE oauth_states SET expires_at=now()-interval '1 minute' WHERE channel_id=$1", [
      ch,
    ]),
  );
  assert.equal((await req(`/api/oauth/allegro/callback?state=${state}&code=code`)).statusCode, 422);
  assert.equal(tokenCalls, 0);
});
test('równoczesne odświeżenie rotuje refresh token raz, także ponad rozmiar puli', async () => {
  const ch = await channel('allegro');
  await Promise.all(
    Array.from({ length: 14 }, () => refreshOAuth(DEMO_TENANT, ch, 'old-token',
      withAllegroRequestContext(ctx, authenticatedRequest))),
  );
  assert.equal(tokenCalls, 1);
  const saved = (
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('SELECT credentials FROM channels WHERE id=$1', [ch]),
    )
  ).rows[0];
  assert.equal(decrypt(saved.credentials).access_token, 'new-token');
});
test('odczyt po HTTP 401 odświeża token i ponawia jeden raz bez ujawniania odpowiedzi', async () => {
  const ch = await channel('allegro');
  let reads = 0;
  const localCtx = {
    ...ctx,
    transport: async (url: string, init: RequestInit) =>
      url.includes('/auth/oauth/token')
        ? ctx.transport!(url, init)
        : ++reads === 1
          ? json({ token: 'DO_NOT_LOG' }, 401)
          : json({ checkoutForms: [], totalCount: 0 }),
  };
  const result = await channelRead<{ data: any[] }>(
    DEMO_TENANT,
    ch,
    (client) => (client as any).orders(),
    withAllegroRequestContext(localCtx, authenticatedRequest),
  );
  assert.equal(reads, 2);
  assert.equal(tokenCalls, 1);
  assert.equal(result.data.length, 0);
});
test('zlecenie równoczesne tworzy jedno zadanie; kolejne strony są checkpointowane', async () => {
  const ch = await channel();
  const results = await Promise.all([
    req(`/api/integrations/${ch}/sync`, 'POST'),
    req(`/api/integrations/${ch}/sync`, 'POST'),
  ]);
  results.forEach((r) => assert.equal(r.statusCode, 200, r.body));
  assert.equal(results[0].json().id, results[1].json().id);
  const id = results[0].json().id;
  await tick(ctx);
  let j = await job(id);
  assert.equal(j.state, 'pending');
  assert.equal(j.payload.page, 2);
  await tick(ctx);
  j = await job(id);
  assert.equal(j.state, 'done');
  const count = await tenantTx(DEMO_TENANT, (c) =>
    c.query('SELECT count(*)::int AS count FROM inbound_orders WHERE channel_id=$1', [ch]),
  );
  assert.equal(count.rows[0].count, 51);
});
test('awaria, backoff, limit prób i ręczne ponowienie zachowują stronę', async () => {
  const ch = await channel();
  const r = await req(`/api/integrations/${ch}/sync`, 'POST'),
    id = r.json().id;
  fail = true;
  for (let i = 0; i < 5; i++) {
    await tick(ctx);
    const j = await job(id);
    assert.equal(j.payload.page, 1);
    assert.ok(!j.error.includes('DO_NOT_LOG'));
    if (i < 4)
      await tenantTx(DEMO_TENANT, (c) => c.query('UPDATE jobs SET run_at=now() WHERE id=$1', [id]));
  }
  assert.equal((await job(id)).state, 'failed');
  assert.equal((await req(`/api/integration-jobs/${id}/retry`, 'POST')).statusCode, 200);
  fail = false;
  await tick(ctx);
  assert.equal((await job(id)).payload.page, 2);
});
test('porzucona dzierżawa jest odzyskiwana; stary worker nie zapisuje wyniku', async () => {
  const ch = await channel(),
    r = await req(`/api/integrations/${ch}/sync`, 'POST'),
    id = r.json().id,
    old = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "UPDATE jobs SET state='running',lease_token=$2,locked_at=now()-interval '3 minutes' WHERE id=$1",
      [id, old],
    ),
  );
  const stale = await job(id);
  await tick(ctx);
  assert.equal((await job(id)).payload.page, 2);
  await processIntegrationJob(stale, ctx);
  assert.equal((await job(id)).payload.page, 2);
  const runs = await tenantTx(DEMO_TENANT, (c) =>
    c.query('SELECT count(*)::int AS count FROM integration_runs WHERE channel_id=$1', [ch]),
  );
  assert.equal(runs.rows[0].count, 1);
});
test('Allegro: bootstrap i dziennik zdarzeń zapisują trwały kursor', async () => {
  const ch = await channel('allegro'),
    r = await req(`/api/integrations/${ch}/sync`, 'POST'),
    id = r.json().id;
  await tick(ctx);
  assert.equal((await job(id)).payload.phase, 'events');
  await tick(ctx);
  await tick(ctx);
  assert.equal((await job(id)).state, 'done');
  assert.deepEqual(eventsSeen, ['event-0', 'event-1']);
  const saved = (
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('SELECT event_cursor,bootstrap_done FROM channels WHERE id=$1', [ch]),
    )
  ).rows[0];
  assert.equal(saved.event_cursor, 'event-1');
  assert.equal(saved.bootstrap_done, true);
});
test('harmonogram zleca zadanie raz i wyłącza je po utracie roli administratora', async () => {
  const ch = await channel();
  assert.equal(
    (await req(`/api/integrations/${ch}/sync`, 'PATCH', { enabled: true, interval: 60 }))
      .statusCode,
    200,
  );
  await scheduleDue();
  // A long-running channel must not occupy the scheduler's due batch forever.
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE channels SET next_sync_at=now() WHERE id=$1', [ch]),
  );
  await scheduleDue();
  assert.equal(
    (
      await tenantTx(DEMO_TENANT, (c) =>
        c.query('SELECT next_sync_at>now() AS deferred FROM channels WHERE id=$1', [ch]),
      )
    ).rows[0].deferred,
    true,
  );
  const active = await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "SELECT count(*)::int AS count FROM jobs WHERE kind='orders.sync' AND payload->>'channel_id'=$1 AND state='pending'",
      [ch],
    ),
  );
  assert.equal(active.rows[0].count, 1);
  try {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      userId,
    ]);
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE channels SET next_sync_at=now() WHERE id=$1', [ch]),
    );
    await scheduleDue();
    assert.equal(
      (
        await tenantTx(DEMO_TENANT, (c) =>
          c.query('SELECT sync_enabled FROM channels WHERE id=$1', [ch]),
        )
      ).rows[0].sync_enabled,
      false,
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      userId,
    ]);
  }
});
async function webhook(ch: string, body: string, delivery = 'delivery-a', signature?: string) {
  return app.inject({
    url: `/api/webhooks/woocommerce/${ch}`,
    method: 'POST',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-wc-webhook-signature':
        signature ??
        createHmac('sha256', 'local-test-webhook-secret').update(body).digest('base64'),
      'x-wc-webhook-topic': 'order.updated',
      'x-wc-webhook-delivery-id': delivery,
    },
  });
}
test('podpis surowych bajtów, deduplikacja dostaw i konflikt zmienionej treści', async () => {
  const ch = await channel(),
    body = JSON.stringify(raw(97001), null, 2);
  assert.equal((await webhook(ch, body, 'bad', 'invalid')).statusCode, 401);
  const good = await webhook(ch, body);
  assert.equal(good.statusCode, 202, good.body);
  const repeat = await webhook(ch, body);
  assert.equal(repeat.json().duplicate, true);
  assert.equal(repeat.json().job_id, good.json().job_id);
  assert.equal(
    (await webhook(ch, JSON.stringify({ ...raw(97001), customer_note: 'changed' }))).statusCode,
    409,
  );
  await tick(ctx);
  assert.equal((await job(good.json().job_id)).state, 'done');
  const inbound = (
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('SELECT normalized FROM inbound_orders WHERE channel_id=$1', [ch]),
    )
  ).rows[0];
  assert.equal(inbound.normalized.note, 'Aktualny stan z API');
  assert.ok(providerCalls.some((u) => u.endsWith('/orders/97001')));
});
test('odbiorniki i zadania są izolowane, sekrety nie występują w panelu', async () => {
  const ch = await channel();
  assert.equal(
    (await req(`/api/integrations/${ch}/sync`, 'GET', undefined, otherCookie)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/api/integrations/${ch}/sync`, 'GET', undefined, viewerCookie)).statusCode,
    403,
  );
  assert.ok(
    !(await req(`/api/integrations/${ch}/sync`)).body.includes('local-test-webhook-secret'),
  );
  await webhook(ch, JSON.stringify(raw(97001)));
  assert.equal(
    (await tenantTx(SECOND_TENANT, (c) => c.query('SELECT * FROM webhook_deliveries'))).rowCount,
    0,
  );
});
test('lokalny przykład wykonuje podpisaną dostawę bez transportu zewnętrznego', async () => {
  const ch = await channel('woocommerce', true);
  const r = await req(`/api/integrations/${ch}/demo-webhook`, 'POST');
  assert.equal(r.statusCode, 200, r.body);
  await tick(ctx);
  assert.equal((await job(r.json().job_id)).state, 'done');
  assert.equal(providerCalls.length, 0);
  assert.equal((await req(`/api/integrations/${ch}/sync`, 'POST')).statusCode, 422);
});
