import { acquireEbayApi, releaseEbayApi, ebayApplicationHash } from '../server/ebay-api-limits';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { decrypt, encrypt, tokenHash } from '../server/security';
import {
  Ebay,
  EBAY_FULFILLMENT_WRITE_SCOPE,
  EBAY_READ_SCOPE,
  EBAY_INVENTORY_SCOPE,
  EBAY_INVENTORY_WRITE_SCOPE,
  ebayReadScopes,
} from '../server/ebay';
import { channelRead } from '../server/channel-access';
import { ebayConsentScopes } from '../server/ebay-oauth';
import { EBAY_TRADING_SCOPE } from '../server/ebay-account';
assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance, cookie: string, otherCookie: string, viewerCookie: string, userId: string;
let calls: any[] = [];
let identityCalls: any[] = [];
let identityHook: () => Promise<void> = async () => {};
let identityResponse: any;
const profile = (eias = 'STABLE-EIAS-123', username = 'seller-qa') =>
  '<GetUserResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><User><EIASToken>' +
  eias +
  '</EIASToken><UserID>' +
  username +
  '</UserID><Email>DO-NOT-STORE@example.test</Email></User></GetUserResponse>';
let response: any;
let hook: () => Promise<void> = async () => {};
const good = () => ({
  access_token: 'OAUTH-ACCESS',
  refresh_token: 'OAUTH-REFRESH',
  expires_in: 7200,
  refresh_token_expires_in: 47304000,
  token_type: 'User Access Token',
});
const transport = async (url: string, init: any) => {
  if (new URL(url).pathname === '/ws/api.dll') {
    identityCalls.push({ url, init });
    await identityHook();
    return typeof identityResponse === 'function'
      ? identityResponse()
      : new Response(identityResponse, { status: 200 });
  }
  calls.push({ url, init });
  assert.equal(new URL(url).pathname, '/identity/v1/oauth2/token');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert(init.signal);
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(
    init.headers.Authorization,
    'Basic ' + Buffer.from('CLIENT:APP-SECRET').toString('base64'),
  );
  await hook();
  return typeof response === 'function'
    ? response()
    : new Response(JSON.stringify(response), { status: 200 });
};
const req = (url: string, method: any = 'GET', payload?: any, session = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: session } });
const login = async (email: string) => {
  const r = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email, password: 'DynaDemo!2026' },
  });
  assert.equal(r.statusCode, 200, r.body);
  return String(r.headers['set-cookie']).split(';')[0];
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    oauthConfig: () => ({
      clientId: 'ALLEGRO',
      clientSecret: 'ALLEGRO-SECRET',
      redirectUri: 'http://127.0.0.1:4100/api/oauth/allegro/callback',
    }),
  });
  cookie = await login('admin@demo.local');
  otherCookie = await login('other@demo.local');
  viewerCookie = await login('viewer@demo.local');
  userId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  await pool.query('DELETE FROM ebay_api_leases; DELETE FROM ebay_api_buckets');
  calls = [];
  identityCalls = [];
  identityHook = async () => {};
  identityResponse = profile();
  response = good();
  hook = async () => {};
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
});
after(async () => {
  await app.close();
  await pool.end();
});
async function create(extra: any = {}) {
  const r = await req('/api/integrations', 'POST', {
    provider: 'ebay',
    name: 'eBay OAuth QA',
    mode: 'sandbox',
    credentials: {
      client_id: 'CLIENT',
      client_secret: 'APP-SECRET',
      ru_name: 'DYNAMINDS-QA-RUNAME',
      ...extra.credentials,
    },
    settings: { price_mode: 'gross', ...extra.settings },
    ...Object.fromEntries(
      Object.entries(extra).filter(([k]) => !['credentials', 'settings'].includes(k)),
    ),
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().id as string;
}
async function start(id: string, payload: any = {}) {
  const r = await req(`/api/integrations/${id}/oauth/start`, 'POST', payload);
  assert.equal(r.statusCode, 200, r.body);
  return { r, url: new URL(r.json().url), state: new URL(r.json().url).searchParams.get('state')! };
}
const finish = (state: string, code = 'v^1.1#i^1#f^0#r^1#p^3#+/%=') =>
  req('/api/oauth/ebay/finish', 'POST', { state, code });
const channel = (id: string) =>
  tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0],
  );
async function pending(state: string) {
  return (await pool.query('SELECT * FROM oauth_states WHERE state_hash=$1', [tokenHash(state)]))
    .rows[0];
}

test('eBay OAuth: creation supports RuName or existing refresh token and rejects incomplete credentials', async () => {
  const id = await create();
  const ch = await channel(id);
  assert.equal(ch.status, 'awaiting_oauth');
  assert(!decrypt(ch.credentials).refresh_token);
  const legacy = await create({ credentials: { refresh_token: 'OLD-REFRESH', ru_name: '' } });
  assert.equal((await channel(legacy)).status, 'not_verified');
  for (const credentials of [
    { client_id: 'CLIENT', client_secret: 'APP-SECRET' },
    { client_id: 'CLIENT', client_secret: 'APP-SECRET', ru_name: 'https://evil.invalid' },
    { client_id: 'CLIENT:BAD', client_secret: 'SECRET', ru_name: 'valid' },
  ]) {
    const r = await req('/api/integrations', 'POST', {
      provider: 'ebay',
      name: 'Bad OAuth',
      mode: 'sandbox',
      credentials,
    });
    assert.equal(r.statusCode, 422);
  }
  assert(!JSON.stringify((await req('/api/integrations')).json()).includes('APP-SECRET'));
});
test('eBay OAuth: fixed sandbox/live consent hosts, RuName and exactly the three supported scopes', async () => {
  for (const [mode, access, scope] of [
    ['sandbox', 'orders', EBAY_READ_SCOPE],
    ['sandbox', 'orders_inventory', EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_SCOPE],
    ['live', 'orders_inventory_write', EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_WRITE_SCOPE],
  ]) {
    const id = await create({ mode }),
      s = await start(id, { inventory_access: access });
    assert.equal(
      s.url.origin,
      mode === 'sandbox' ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com',
    );
    assert.equal(s.url.pathname, '/oauth2/authorize');
    assert.equal(s.url.searchParams.get('redirect_uri'), 'DYNAMINDS-QA-RUNAME');
    assert.equal(s.url.searchParams.get('scope'), EBAY_TRADING_SCOPE + ' ' + scope);
    assert.equal(s.url.searchParams.get('response_type'), 'code');
    assert.equal(s.url.searchParams.get('prompt'), 'login');
    assert.equal(s.state.length, 43);
    assert(!s.url.searchParams.has('code_challenge'));
    assert(!s.r.body.includes('APP-SECRET'));
    assert.equal(calls.length, 0);
    const p = await pending(s.state);
    assert.equal(p.scope, EBAY_TRADING_SCOPE + ' ' + scope);
    assert(!p.verifier.includes(s.state));
    assert.equal(decrypt(p.verifier).session_hash, tokenHash(cookie.split('=')[1]));
  }
});
test('eBay OAuth: callback exchanges decoded code once, encrypts tokens, records expiry and preserves RuName', async () => {
  const id = await create(),
    s = await start(id, { inventory_access: 'orders_inventory_write' });
  const code = 'v^1.1#code+/%=';
  const r = await req(
    '/api/oauth/ebay/callback?' + new URLSearchParams({ state: s.state, code, expires_in: '299' }),
  );
  assert.equal(r.statusCode, 302, r.body);
  assert.equal(r.headers.location, '/?integration=connected');
  assert.equal(calls.length, 1);
  const body = new URLSearchParams(String(calls[0].init.body));
  assert.equal(body.get('code'), code);
  assert.equal(body.get('redirect_uri'), 'DYNAMINDS-QA-RUNAME');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.deepEqual([...body.keys()].sort(), ['code', 'grant_type', 'redirect_uri']);
  const ch = await channel(id),
    creds = decrypt(ch.credentials);
  assert.equal(creds.refresh_token, 'OAUTH-REFRESH');
  assert.equal(creds.ru_name, 'DYNAMINDS-QA-RUNAME');
  assert(!ch.credentials.includes('OAUTH-ACCESS'));
  assert.equal(ch.settings.inventory_access, 'orders_inventory_write');
  assert.equal(ch.oauth_scopes, ebayConsentScopes(ch.settings));
  assert(Date.parse(ch.settings.oauth_refresh_expires_at) > Date.now() + 47000000 * 1000);
  assert(ch.settings.oauth_connection_id);
  assert.equal(ch.sync_enabled, false);
  const audits = (await pool.query('SELECT detail FROM audit_events WHERE entity_id=$1', [id]))
    .rows;
  assert(!JSON.stringify(audits).includes(code));
  assert(!JSON.stringify(audits).includes('OAUTH-REFRESH'));
  assert(!r.body.includes('OAUTH-ACCESS'));
  assert.equal((await finish(s.state)).statusCode, 422);
  assert.equal(calls.length, 1);
});
test('eBay OAuth: cancellation consumes state without provider call or changing credentials', async () => {
  const id = await create(),
    before = await channel(id),
    s = await start(id);
  const r = await req(
    '/api/oauth/ebay/callback?' +
      new URLSearchParams({
        state: s.state,
        error: 'access_denied',
        error_description: 'DO-NOT-REFLECT',
      }),
  );
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/?integration=ebay_denied');
  assert.equal(calls.length, 0);
  assert.equal((await channel(id)).credentials, before.credentials);
  assert.equal((await finish(s.state)).statusCode, 422);
});
test('eBay OAuth: invalid state, expired state, other tenant and viewer cannot consume or exchange', async () => {
  const id = await create(),
    s = await start(id);
  assert.equal(
    (await req(`/api/integrations/${id}/oauth/start`, 'POST', {}, viewerCookie)).statusCode,
    403,
  );
  assert.equal(
    (await req('/api/oauth/ebay/finish', 'POST', { state: s.state, code: 'code' }, otherCookie))
      .statusCode,
    422,
  );
  assert.equal(
    (await req('/api/oauth/ebay/finish', 'POST', { state: s.state, code: 'code' }, viewerCookie))
      .statusCode,
    403,
  );
  assert(!(await pending(s.state)).consumed_at);
  assert.equal((await finish('a'.repeat(43))).statusCode, 422);
  await pool.query(
    "UPDATE oauth_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1",
    [tokenHash(s.state)],
  );
  assert.equal((await finish(s.state)).statusCode, 422);
  assert.equal(calls.length, 0);
});
test('eBay OAuth: a second browser session for same user cannot exchange first session state', async () => {
  const id = await create(),
    s = await start(id),
    another = await login('admin@demo.local');
  const r = await req('/api/oauth/ebay/finish', 'POST', { state: s.state, code: 'code' }, another);
  assert.equal(r.statusCode, 422);
  assert(!(await pending(s.state)).consumed_at);
  assert.equal((await finish(s.state)).statusCode, 200);
  assert.equal(calls.length, 1);
});
test('eBay OAuth: a new attempt invalidates previous pending attempt', async () => {
  const id = await create(),
    a = await start(id),
    b = await start(id, { inventory_access: 'orders_inventory' });
  assert.notEqual(a.state, b.state);
  assert((await pending(a.state)).consumed_at);
  assert.equal((await finish(a.state)).statusCode, 422);
  assert.equal((await finish(b.state)).statusCode, 200);
  assert.equal(calls.length, 1);
});
test('eBay OAuth: reconnect requires same-account confirmation and pauses both schedules without changing consent early', async () => {
  const id = await create({ credentials: { refresh_token: 'OLD-REFRESH' } });
  assert.equal(
    (await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {})).statusCode,
    200,
  );
  await pool.query('UPDATE channels SET sync_enabled=true,next_sync_at=now() WHERE id=$1', [id]);
  const warehouse = (
    await pool.query('SELECT id FROM warehouses WHERE tenant_id=$1 LIMIT 1', [DEMO_TENANT])
  ).rows[0].id;
  await pool.query(
    "INSERT INTO offer_sync_configs(tenant_id,channel_id,actor_id,warehouse_id,enabled,stock,price,interval_seconds,verify_seconds,external_authorized,connection_hash,next_run_at) VALUES($1,$2,$3,$4,true,true,true,300,900,true,'OLD-HASH',now())",
    [DEMO_TENANT, id, userId, warehouse],
  );
  assert.equal((await req(`/api/integrations/${id}/oauth/start`, 'POST')).statusCode, 422);
  const s = await start(id, {
    confirm_same_account: true,
    inventory_access: 'orders_inventory_write',
  });
  const ch = await channel(id);
  assert.equal(ch.settings.inventory_access, 'orders');
  assert.equal(ch.oauth_scopes, '');
  assert.equal(decrypt(ch.credentials).refresh_token, 'OLD-REFRESH');
  assert.equal(ch.sync_enabled, false);
  const cfg = (await pool.query('SELECT * FROM offer_sync_configs WHERE channel_id=$1', [id]))
    .rows[0];
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.external_authorized, false);
  assert.equal(cfg.version, 2);
  assert.equal(cfg.next_run_at, null);
  assert.equal((await finish(s.state)).statusCode, 200);
  assert.equal(
    (await pool.query('SELECT enabled FROM offer_sync_configs WHERE channel_id=$1', [id])).rows[0]
      .enabled,
    false,
  );
});
test('eBay OAuth: role revoked during token HTTP cannot persist returned tokens', async () => {
  const id = await create(),
    s = await start(id),
    before = await channel(id);
  hook = async () => {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      userId,
    ]);
  };
  try {
    assert.equal((await finish(s.state)).statusCode, 403);
    assert.equal((await channel(id)).credentials, before.credentials);
    assert((await pending(s.state)).consumed_at);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      userId,
    ]);
  }
});
test('eBay OAuth: changed client or settings during token HTTP cannot receive old-account tokens', async () => {
  for (const field of ['credentials', 'settings']) {
    const id = await create(),
      s = await start(id);
    hook = async () => {
      if (field === 'credentials')
        await pool.query('UPDATE channels SET credentials=$1 WHERE id=$2', [
          encrypt({ client_id: 'OTHER', client_secret: 'OTHER', ru_name: 'OTHER' }),
          id,
        ]);
      else
        await pool.query(
          'UPDATE channels SET settings=settings||\'{"marketplace_id":"EBAY_US"}\'::jsonb WHERE id=$1',
          [id],
        );
    };
    const r = await finish(s.state);
    assert.equal(r.statusCode, 409, r.body);
    assert(!(await channel(id)).token_expires_at);
  }
});
test('eBay OAuth: session expiry or logout during HTTP blocks persistence', async () => {
  for (const action of ['expire', 'logout']) {
    const local = await login('admin@demo.local'),
      id = await create();
    const r = await req(`/api/integrations/${id}/oauth/start`, 'POST', {}, local);
    assert.equal(r.statusCode, 200);
    const state = new URL(r.json().url).searchParams.get('state')!;
    hook = async () => {
      await pool.query(
        action === 'expire'
          ? "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1"
          : 'DELETE FROM sessions WHERE token_hash=$1',
        [tokenHash(local.split('=')[1])],
      );
    };
    assert.equal(
      (await req('/api/oauth/ebay/finish', 'POST', { state, code: 'code' }, local)).statusCode,
      401,
    );
    assert(!(await channel(id)).token_expires_at);
  }
});
test('eBay OAuth: queued work blocks start; work added during HTTP blocks token persistence', async () => {
  const id = await create();
  const insert = () =>
    pool.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'orders.sync',$3,$4)",
      [randomUUID(), DEMO_TENANT, JSON.stringify({ channel_id: id }), randomUUID()],
    );
  await insert();
  assert.equal((await req(`/api/integrations/${id}/oauth/start`, 'POST')).statusCode, 409);
  await pool.query("UPDATE jobs SET state='done' WHERE payload->>'channel_id'=$1", [id]);
  const s = await start(id);
  hook = async () => {
    await insert();
  };
  assert.equal((await finish(s.state)).statusCode, 409);
  assert(!(await channel(id)).token_expires_at);
});
test('eBay OAuth: uncertain write plans block reauthorization before token request', async () => {
  const id = await create(),
    product = (
      await pool.query('SELECT id FROM products WHERE tenant_id=$1 LIMIT 1', [DEMO_TENANT])
    ).rows[0].id,
    warehouse = (
      await pool.query('SELECT id FROM warehouses WHERE tenant_id=$1 LIMIT 1', [DEMO_TENANT])
    ).rows[0].id;
  await pool.query(
    "INSERT INTO offer_plans(id,tenant_id,channel_id,product_id,actor_id,warehouse_id,operation,state,input,local_snapshot,payload,phase) VALUES($1,$2,$3,$4,$5,$6,'sync','failed','{}','{}','{}','write_started')",
    [randomUUID(), DEMO_TENANT, id, product, userId, warehouse],
  );
  assert.equal((await req(`/api/integrations/${id}/oauth/start`, 'POST')).statusCode, 409);
  assert.equal(calls.length, 0);
});
test('eBay OAuth: simulation channel, unsupported permissions and missing RuName rejected', async () => {
  const id = await create();
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"simulation":true}\'::jsonb WHERE id=$1',
    [id],
  );
  assert.equal((await req(`/api/integrations/${id}/oauth/start`, 'POST')).statusCode, 422);
  const real = await create();
  assert.equal(
    (await req(`/api/integrations/${real}/oauth/start`, 'POST', { offers_write: true })).statusCode,
    422,
  );
  const noRuName = await create({ credentials: { ru_name: '', refresh_token: 'OLD' } });
  assert.equal(
    (await req(`/api/integrations/${noRuName}/oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    422,
  );
  assert.equal(calls.length, 0);
});
test('eBay OAuth: malformed or ambiguous callback never exchanges', async () => {
  const id = await create(),
    s = await start(id);
  for (const payload of [
    { state: s.state, code: 'x', error: 'access_denied' },
    { state: s.state },
    { state: s.state, code: 'x'.repeat(1025) },
    { state: s.state, code: 'x\ny' },
  ])
    assert.equal((await req('/api/oauth/ebay/finish', 'POST', payload)).statusCode, 422);
  assert.equal(
    (
      await req(
        '/api/oauth/ebay/callback?' +
          new URLSearchParams({ state: s.state, code: 'x' }) +
          '&state=' +
          s.state,
      )
    ).statusCode,
    422,
  );
  assert.equal(calls.length, 0);
  assert(!(await pending(s.state)).consumed_at);
});
test('eBay OAuth: lost response and provider HTTP errors are consumed once and never retried', async () => {
  for (const kind of ['lost', 400, 401, 429, 503]) {
    const id = await create(),
      s = await start(id),
      before = await channel(id);
    response = () => {
      if (kind === 'lost') throw Error('APP-SECRET code DO-NOT-LOG');
      return new Response(JSON.stringify({ error_description: 'DO-NOT-LOG' }), {
        status: Number(kind),
        headers: { 'retry-after': '0' },
      });
    };
    const n = calls.length,
      r = await finish(s.state);
    assert.equal(r.statusCode, [400, 401].includes(Number(kind)) ? 401 : 502);
    assert(!r.body.includes('DO-NOT-LOG'));
    assert.equal(calls.length, n + 1);
    assert((await pending(s.state)).consumed_at);
    assert.equal((await channel(id)).credentials, before.credentials);
    assert.equal((await finish(s.state)).statusCode, 422);
    assert.equal(calls.length, n + 1);
  }
});
test('eBay OAuth: partial, wrong scope, malformed and oversized tokens never persist', async () => {
  for (const value of [
    { ...good(), refresh_token: undefined },
    { ...good(), refresh_token_expires_in: 0 },
    { ...good(), scope: '' },
    { ...good(), scope: EBAY_READ_SCOPE },
    { ...good(), token_type: 'Application Access Token' },
    () => new Response('not JSON'),
    () => new Response('a'.repeat(65537)),
  ]) {
    const id = await create(),
      s = await start(id, { inventory_access: 'orders_inventory_write' });
    response = value;
    const r = await finish(s.state);
    assert([401, 502].includes(r.statusCode), r.body);
    assert(!(await channel(id)).token_expires_at);
    assert((await pending(s.state)).consumed_at);
  }
});
test('eBay OAuth: explicit valid scope accepted and read-only does not request inventory write', async () => {
  const id = await create(),
    s = await start(id, { inventory_access: 'orders_inventory' });
  response = {
    ...good(),
    scope: EBAY_TRADING_SCOPE + ' ' + EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_SCOPE,
  };
  assert.equal((await finish(s.state)).statusCode, 200);
  assert.equal((await channel(id)).oauth_scopes, response.scope);
  assert(!response.scope.includes(EBAY_INVENTORY_WRITE_SCOPE + ' '));
});
test('eBay OAuth: concurrent callbacks exchange only once', async () => {
  const id = await create(),
    s = await start(id);
  const r = await Promise.all([finish(s.state), finish(s.state)]);
  assert.deepEqual(r.map((x) => x.statusCode).sort(), [200, 422]);
  assert.equal(calls.length, 1);
});
test('eBay OAuth: wrong provider callback cannot send eBay code to Allegro', async () => {
  const id = await create(),
    s = await start(id);
  const r = await req(
    '/api/oauth/allegro/callback?' + new URLSearchParams({ state: s.state, code: 'ebay-code' }),
  );
  assert.equal(r.statusCode, 422);
  assert.equal(calls.length, 0);
});
test('eBay OAuth: token refresh uses new consent, cache avoids HTTP and known refresh expiry requires reconnect', async () => {
  const id = await create(),
    s = await start(id);
  assert.equal((await finish(s.state)).statusCode, 200);
  calls = [];
  await channelRead(
    DEMO_TENANT,
    id,
    async (client) => {
      assert(client instanceof Ebay);
      assert.equal(client.credentials.access_token, 'OAUTH-ACCESS');
      return true;
    },
    { transport },
  );
  assert.equal(calls.length, 0);
  await pool.query("UPDATE channels SET token_expires_at=now()-interval '1 second' WHERE id=$1", [
    id,
  ]);
  response = { access_token: 'REFRESHED', expires_in: 7200, token_type: 'User Access Token' };
  await channelRead(
    DEMO_TENANT,
    id,
    async (client) => {
      assert(client instanceof Ebay);
      assert.equal(client.credentials.access_token, 'REFRESHED');
      return true;
    },
    { transport },
  );
  assert.equal(calls.length, 1);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('refresh_token'), 'OAUTH-REFRESH');
  assert.equal(body.get('scope'), EBAY_READ_SCOPE);
  await pool.query(
    "UPDATE channels SET settings=jsonb_set(settings,'{oauth_refresh_expires_at}',to_jsonb('2000-01-01T00:00:00.000Z'::text)),token_expires_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await assert.rejects(
    () => channelRead(DEMO_TENANT, id, async () => true, { transport }),
    /Zgoda eBay wygasła/,
  );
  assert.equal(calls.length, 1);
});
test('eBay OAuth: restored preview blocks callback and start without consuming state', async () => {
  const id = await create(),
    s = await start(id),
    preview = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    for (const [url, method, payload] of [
      [`/api/integrations/${id}/oauth/start`, 'POST', {}],
      ['/api/oauth/ebay/finish', 'POST', { state: s.state, code: 'code' }],
      [
        '/api/oauth/ebay/callback?' + new URLSearchParams({ state: s.state, code: 'code' }),
        'GET',
        undefined,
      ],
    ] as const) {
      const r = await preview.inject({ url, method: method as any, payload, headers: { cookie } });
      assert.equal(r.statusCode, 423);
    }
    assert.equal(calls.length, 0);
    assert(!(await pending(s.state)).consumed_at);
  } finally {
    await preview.close();
  }
});

test('eBay OAuth: live grant targets production token server; stale connection is consumed without HTTP', async () => {
  const id = await create({ mode: 'live' }),
    s = await start(id);
  assert.equal((await finish(s.state)).statusCode, 200);
  assert.equal(calls[0].url, 'https://api.ebay.com/identity/v1/oauth2/token');
  const other = await create(),
    pending = await start(other);
  await pool.query("UPDATE channels SET mode='live' WHERE id=$1", [other]);
  const n = calls.length;
  assert.equal((await finish(pending.state)).statusCode, 409);
  assert.equal(calls.length, n);
});
test('eBay OAuth: a new start waits for token exchange and cannot be overwritten by previous response', async () => {
  const id = await create(),
    s = await start(id);
  let release!: () => void, entered!: () => void;
  const observed = new Promise<void>((r) => (entered = r)),
    held = new Promise<void>((r) => (release = r));
  hook = async () => {
    entered();
    await held;
  };
  const finishing = finish(s.state);
  await observed;
  const restarting = start(id, {
    confirm_same_account: true,
    inventory_access: 'orders_inventory_write',
  });
  release();
  assert.equal((await finishing).statusCode, 200);
  const next = await restarting;
  assert(!(await pending(next.state)).consumed_at);
  assert.equal((await channel(id)).settings.inventory_access, 'orders');
  assert.equal(calls.length, 1);
  hook = async () => {};
  assert.equal((await finish(next.state)).statusCode, 200);
  assert.equal((await channel(id)).settings.inventory_access, 'orders_inventory_write');
  assert.equal(calls.length, 2);
});

test('eBay OAuth: fulfillment write requires explicit selection, replaces read-only scope and persists consent', async () => {
  const id = await create(),
    s = await start(id, { fulfillment_write: true, inventory_access: 'orders_inventory' });
  assert.equal(
    s.url.searchParams.get('scope'),
    EBAY_TRADING_SCOPE + ' ' + EBAY_FULFILLMENT_WRITE_SCOPE + ' ' + EBAY_INVENTORY_SCOPE,
  );
  assert(!s.url.searchParams.get('scope')!.split(' ').includes(EBAY_READ_SCOPE));
  assert.equal((await finish(s.state)).statusCode, 200);
  const ch = await channel(id);
  assert.equal(ch.settings.fulfillment_write, true);
  assert.equal(
    ch.oauth_scopes,
    EBAY_TRADING_SCOPE + ' ' + EBAY_FULFILLMENT_WRITE_SCOPE + ' ' + EBAY_INVENTORY_SCOPE,
  );
});

test('eBay account: GetUser uses fixed gateway, OAuth header, summary and omits user selection/PII', async () => {
  const id = await create({ mode: 'live' }),
    s = await start(id);
  assert.equal((await finish(s.state)).statusCode, 200);
  assert.equal(identityCalls.length, 1);
  const call = identityCalls[0];
  assert.equal(call.url, 'https://api.ebay.com/ws/api.dll');
  assert.equal(call.init.headers['X-EBAY-API-CALL-NAME'], 'GetUser');
  assert.equal(call.init.headers['X-EBAY-API-IAF-TOKEN'], 'OAUTH-ACCESS');
  assert.equal(call.init.headers['X-EBAY-API-COMPATIBILITY-LEVEL'], '1477');
  assert.equal(call.init.headers['Content-Type'], 'text/xml');
  assert.equal(call.init.redirect, 'error');
  assert(call.init.signal);
  assert(call.init.body.includes('<DetailLevel>ReturnSummary</DetailLevel>'));
  assert(!call.init.body.includes('UserID'));
  assert(!call.init.body.includes('OAUTH-ACCESS'));
  const b = (await req(`/api/integrations/${id}/ebay-account`)).json();
  assert.equal(b.bound, true);
  assert.equal(b.source, 'trading');
  assert.equal(b.username, 'seller-qa');
  assert(!JSON.stringify(b).includes('STABLE-EIAS'));
  assert(!JSON.stringify(b).includes('account_hash'));
  const persisted = (
    await pool.query('SELECT * FROM ebay_account_bindings WHERE channel_id=$1', [id])
  ).rows[0];
  assert.equal(persisted.account_hash.length, 64);
  assert(!JSON.stringify(persisted).includes('DO-NOT-STORE'));
  assert(!JSON.stringify(persisted).includes('STABLE-EIAS'));
});
test('eBay account: different seller cannot replace connected tokens or binding even with confirmation', async () => {
  const id = await create(),
    a = await start(id);
  assert.equal((await finish(a.state)).statusCode, 200);
  const before = await channel(id),
    b = (await pool.query('SELECT * FROM ebay_account_bindings WHERE channel_id=$1', [id])).rows[0];
  const next = await start(id, { confirm_same_account: true });
  identityResponse = profile('OTHER-EIAS', 'seller-qa');
  response = { ...good(), access_token: 'DIFFERENT-ACCESS', refresh_token: 'DIFFERENT-REFRESH' };
  const r = await finish(next.state);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((await channel(id)).credentials, before.credentials);
  assert.deepEqual(
    (await pool.query('SELECT * FROM ebay_account_bindings WHERE channel_id=$1', [id])).rows[0],
    b,
  );
  assert((await pending(next.state)).consumed_at);
  assert.equal((await finish(next.state)).statusCode, 422);
  assert.equal(calls.length, 2);
  assert.equal(identityCalls.length, 2);
});
test('eBay account: same stable EIAS accepts renamed username and preserves original binding timestamp', async () => {
  const id = await create(),
    a = await start(id);
  assert.equal((await finish(a.state)).statusCode, 200);
  const before = (await pool.query('SELECT * FROM ebay_account_bindings WHERE channel_id=$1', [id]))
    .rows[0];
  identityResponse = profile('STABLE-EIAS-123', 'renamed-seller');
  response = { ...good(), refresh_token: 'RECONNECTED' };
  const next = await start(id, { confirm_same_account: true });
  assert.equal((await finish(next.state)).statusCode, 200);
  const after = (await pool.query('SELECT * FROM ebay_account_bindings WHERE channel_id=$1', [id]))
    .rows[0];
  assert.equal(after.account_hash, before.account_hash);
  assert.deepEqual(after.created_at, before.created_at);
  assert.equal(after.username, 'renamed-seller');
  assert.equal(decrypt((await channel(id)).credentials).refresh_token, 'RECONNECTED');
});
test('eBay account: legacy token must be verified before start and base-scope refresh never overwrites Sell cache', async () => {
  const id = await create({ credentials: { refresh_token: 'OLD-REFRESH' } }),
    before = await channel(id);
  assert.equal(
    (await req(`/api/integrations/${id}/oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    409,
  );
  assert.equal(calls.length, 0);
  assert.equal(identityCalls.length, 0);
  const r = await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(calls.length, 1);
  assert.equal(identityCalls.length, 1);
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('scope'), EBAY_TRADING_SCOPE);
  assert.equal(body.get('refresh_token'), 'OLD-REFRESH');
  assert.equal(identityCalls[0].url, 'https://api.sandbox.ebay.com/ws/api.dll');
  assert.equal((await channel(id)).credentials, before.credentials);
  assert.equal((await channel(id)).oauth_scopes, '');
  assert.equal((await channel(id)).token_expires_at, null);
  const s = await start(id, { confirm_same_account: true });
  assert.equal((await finish(s.state)).statusCode, 200);
});
test('eBay account: malformed XML, missing/masked EIAS, duplicates, foreign namespace and API errors cannot persist tokens', async () => {
  const ns = 'urn:ebay:apis:eBLBaseComponents';
  for (const xml of [
    'not XML',
    profile('***'),
    profile(''),
    `<GetUserResponse xmlns="${ns}"><Ack>Success</Ack><User><UserID>same-name</UserID></User></GetUserResponse>`,
    profile().replace('<EIASToken>', '<EIASToken>OTHER</EIASToken><EIASToken>'),
    profile().replace('</User>', '</User><User><EIASToken>OTHER</EIASToken></User>'),
    profile().replace(ns, 'urn:foreign'),
    profile().replace(
      '<Ack>Success</Ack>',
      '<Ack>Failure</Ack><Errors><SeverityCode>Error</SeverityCode><LongMessage>DO-NOT-LOG</LongMessage></Errors>',
    ),
    '<!DOCTYPE GetUserResponse [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + profile(),
    profile().replace('<EIASToken>', '<EIASToken><x/>'),
    'a'.repeat(131073),
  ]) {
    const id = await create(),
      s = await start(id),
      before = await channel(id);
    identityResponse = xml;
    const r = await finish(s.state);
    assert.equal(r.statusCode, 502, r.body);
    assert(!r.body.includes('DO-NOT-LOG'));
    assert.equal((await channel(id)).credentials, before.credentials);
    assert((await pending(s.state)).consumed_at);
    assert.equal((await req(`/api/integrations/${id}/ebay-account`)).json().bound, false);
  }
});
test('eBay account: provider identity outage is never interpreted as success or retried with authorization code', async () => {
  for (const kind of [401, 429, 503, 'lost']) {
    const id = await create(),
      s = await start(id);
    identityResponse = () => {
      if (kind === 'lost') throw Error('OAUTH-ACCESS PRIVATE');
      return new Response('PRIVATE', { status: Number(kind), headers: { 'retry-after': '0' } });
    };
    const n = calls.length,
      m = identityCalls.length,
      r = await finish(s.state);
    assert.equal(r.statusCode, kind === 401 ? 401 : 502);
    assert(!r.body.includes('PRIVATE'));
    assert(!r.body.includes('OAUTH-ACCESS'));
    assert.equal((await finish(s.state)).statusCode, 422);
    assert.equal(calls.length, n + 1);
    assert.equal(identityCalls.length, m + 1);
    assert.equal((await req(`/api/integrations/${id}/ebay-account`)).json().bound, false);
  }
});
test('eBay account: role, session, credentials and queued jobs changed during GetUser cannot commit binding or tokens', async () => {
  for (const change of ['role', 'session', 'credentials', 'job']) {
    const local = await login('admin@demo.local'),
      id = await create(),
      sr = await req(`/api/integrations/${id}/oauth/start`, 'POST', {}, local);
    const state = new URL(sr.json().url).searchParams.get('state')!;
    identityHook = async () => {
      if (change === 'role')
        await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          DEMO_TENANT,
          userId,
        ]);
      if (change === 'session')
        await pool.query('DELETE FROM sessions WHERE token_hash=$1', [
          tokenHash(local.split('=')[1]),
        ]);
      if (change === 'credentials')
        await pool.query('UPDATE channels SET credentials=$1 WHERE id=$2', [
          encrypt({ client_id: 'OTHER', client_secret: 'OTHER', ru_name: 'OTHER' }),
          id,
        ]);
      if (change === 'job')
        await pool.query(
          "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($4,$1,'orders.sync',$2,$3)",
          [DEMO_TENANT, JSON.stringify({ channel_id: id }), randomUUID(), randomUUID()],
        );
    };
    try {
      const r = await req('/api/oauth/ebay/finish', 'POST', { state, code: 'code' }, local);
      assert.equal(
        r.statusCode,
        change === 'role' ? 403 : change === 'session' ? 401 : 409,
        r.body,
      );
      assert(!(await channel(id)).token_expires_at);
      assert.equal(
        (await pool.query('SELECT 1 FROM ebay_account_bindings WHERE channel_id=$1', [id]))
          .rowCount,
        0,
      );
    } finally {
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        userId,
      ]);
      identityHook = async () => {};
      await pool.query("UPDATE jobs SET state='done'");
    }
  }
});
test('eBay account: existing-token read fences revocation after refresh and config change during identity', async () => {
  const id = await create({ credentials: { refresh_token: 'OLD' } });
  hook = async () => {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      userId,
    ]);
  };
  try {
    assert.equal(
      (await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {})).statusCode,
      403,
    );
    assert.equal(identityCalls.length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      userId,
    ]);
    hook = async () => {};
  }
  identityHook = async () => {
    await pool.query("UPDATE channels SET mode='live' WHERE id=$1", [id]);
  };
  assert.equal(
    (await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {})).statusCode,
    409,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM ebay_account_bindings WHERE channel_id=$1', [id])).rowCount,
    0,
  );
});
test('eBay account: known access token avoids refresh; an unexpected account cannot rewrite binding', async () => {
  const id = await create(),
    s = await start(id);
  assert.equal((await finish(s.state)).statusCode, 200);
  calls = [];
  identityCalls = [];
  assert.equal(
    (await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {})).statusCode,
    200,
  );
  assert.equal(calls.length, 0);
  assert.equal(identityCalls.length, 1);
  identityResponse = profile('OTHER');
  assert.equal(
    (await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {})).statusCode,
    409,
  );
  assert.equal((await req(`/api/integrations/${id}/ebay-account`)).json().username, 'seller-qa');
});
test('eBay account: simulation is labelled, requires admin/session, is tenant isolated and makes zero HTTP', async () => {
  const r = await req('/api/integrations/ebay-example', 'POST', {}),
    id = r.json().channel_id;
  for (const session of [otherCookie, viewerCookie]) {
    assert.equal(
      (await req(`/api/integrations/${id}/ebay-account`, 'GET', undefined, session)).statusCode,
      session === viewerCookie ? 403 : 404,
    );
    assert.equal(
      (await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {}, session)).statusCode,
      session === viewerCookie ? 403 : 404,
    );
  }
  assert.equal(
    (await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', { account_hash: 'FORGED' }))
      .statusCode,
    422,
  );
  const done = await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {});
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().source, 'simulation');
  assert.equal(done.json().simulation, true);
  assert.equal(done.json().bound, true);
  assert.equal(calls.length, 0);
  assert.equal(identityCalls.length, 0);
  assert.equal(
    (
      await tenantTx(
        (
          await pool.query(
            "SELECT tenant_id FROM memberships WHERE user_id=(SELECT id FROM users WHERE email='other@demo.local') LIMIT 1",
          )
        ).rows[0].tenant_id,
        (c) => c.query('SELECT 1 FROM ebay_account_bindings WHERE channel_id=$1', [id]),
      )
    ).rowCount,
    0,
  );
});
test('eBay account: database rejects immutable identity changes and app-role deletion', async () => {
  const id = await create(),
    s = await start(id);
  assert.equal((await finish(s.state)).statusCode, 200);
  await assert.rejects(
    () =>
      tenantTx(DEMO_TENANT, (c) =>
        c.query(
          "UPDATE ebay_account_bindings SET account_hash=repeat('a',64) WHERE channel_id=$1",
          [id],
        ),
      ),
    /immutable/,
  );
  await assert.rejects(
    () =>
      tenantTx(DEMO_TENANT, (c) =>
        c.query('DELETE FROM ebay_account_bindings WHERE channel_id=$1', [id]),
      ),
    /permission denied/,
  );
});
test('eBay account: active consent blocks separate verification; recovery allows cached identity but blocks verification', async () => {
  const id = await create({ credentials: { refresh_token: 'OLD' } });
  assert.equal(
    (await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {})).statusCode,
    200,
  );
  await start(id, { confirm_same_account: true });
  const n = identityCalls.length;
  assert.equal(
    (await req(`/api/integrations/${id}/ebay-account/verify`, 'POST', {})).statusCode,
    409,
  );
  assert.equal(identityCalls.length, n);
  const preview = await buildApp({ readOnly: true, integrationTransport: transport });
  const lp = await preview.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  assert.equal(lp.statusCode, 200);
  const previewCookie = String(lp.headers['set-cookie']).split(';')[0];
  try {
    assert.equal(
      (
        await preview.inject({
          url: `/api/integrations/${id}/ebay-account`,
          headers: { cookie: previewCookie },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await preview.inject({
          url: `/api/integrations/${id}/ebay-account/verify`,
          method: 'POST',
          payload: {},
          headers: { cookie: previewCookie },
        })
      ).statusCode,
      423,
    );
  } finally {
    await preview.close();
  }
});

test('optional Account readonly consent persists and refresh requests the exact additional scope', async () => {
  const scope = 'https://api.ebay.com/oauth/api_scope/sell.account.readonly';
  const id = await create(),
    s = await start(id, { inventory_access: 'orders_inventory_write', seller_settings_read: true });
  assert.equal(
    s.url.searchParams.get('scope'),
    EBAY_TRADING_SCOPE + ' ' + EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_WRITE_SCOPE + ' ' + scope,
  );
  assert.equal(decrypt((await pending(s.state)).verifier).seller_settings_read, true);
  assert.equal((await finish(s.state)).statusCode, 200);
  const ch = await channel(id);
  assert.equal(ch.settings.seller_settings_read, true);
  assert(ch.oauth_scopes.split(' ').includes(scope));
  await pool.query("UPDATE channels SET token_expires_at=now()-interval '1 minute' WHERE id=$1", [
    id,
  ]);
  response = {
    access_token: 'REFRESHED-ACCOUNT',
    expires_in: 7200,
    token_type: 'User Access Token',
  };
  await channelRead(DEMO_TENANT, id, async () => true, { transport });
  assert.equal(
    new URLSearchParams(calls.at(-1).init.body).get('scope'),
    ebayReadScopes(ch.settings),
  );
});
test('new consent can remove the optional Account scope without expanding remaining grants', async () => {
  const id = await create({ settings: { seller_settings_read: 'true' } }),
    s = await start(id, { seller_settings_read: false });
  assert(!s.url.searchParams.get('scope')!.includes('sell.account'));
  assert.equal((await finish(s.state)).statusCode, 200);
  assert.equal((await channel(id)).settings.seller_settings_read, false);
});

for (const family of ['oauth', 'trading'])
  test(`API limit: busy ${family} leaves OAuth code unconsumed and frees the other reserved slot`, async () => {
    const id = await create(),
      s = await start(id),
      appHash = ebayApplicationHash('sandbox', 'CLIENT');
    const permits = await Promise.all(
      Array.from({ length: 4 }, () => acquireEbayApi(appHash, family, 'held', 'POST')),
    );
    const r = await finish(s.state);
    assert.equal(r.statusCode, 429, r.body);
    assert(!(await pending(s.state)).consumed_at);
    assert.equal(calls.length, 0);
    assert.equal(identityCalls.length, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM ebay_api_leases')).rows[0].n, 4);
    await Promise.all(permits.map(releaseEbayApi));
    assert.equal((await finish(s.state)).statusCode, 200);
    assert((await pending(s.state)).consumed_at);
    assert.equal(calls.length, 1);
    assert.equal(identityCalls.length, 1);
  });
test('API limit: actual OAuth 429 consumes only that code and shared cooldown preserves a new callback', async () => {
  const first = await create(),
    a = await start(first);
  response = () => new Response('{}', { status: 429, headers: { 'retry-after': '3600' } });
  assert.equal((await finish(a.state)).statusCode, 502);
  assert((await pending(a.state)).consumed_at);
  assert.equal(calls.length, 1);
  const second = await create(),
    b = await start(second);
  response = good();
  assert.equal((await finish(b.state)).statusCode, 429);
  assert(!(await pending(b.state)).consumed_at);
  assert.equal(calls.length, 1);
  await pool.query("UPDATE ebay_api_buckets SET cooldown_until='-infinity'");
  assert.equal((await finish(b.state)).statusCode, 200);
  assert.equal(calls.length, 2);
});

test('API limit: runtime OAuth GetUser consumes its existing reservation without a fifth Trading admission', async () => {
  const id = await create(),
    s = await start(id),
    appHash = ebayApplicationHash('sandbox', 'CLIENT');
  const permits = await Promise.all(
      Array.from({ length: 3 }, () => acquireEbayApi(appHash, 'trading', 'held', 'POST')),
    ),
    old = process.env.DYNA_TEST;
  try {
    process.env.DYNA_TEST = 'false';
    const r = await finish(s.state);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(calls.length, 1);
    assert.equal(identityCalls.length, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM ebay_api_leases')).rows[0].n, 3);
  } finally {
    process.env.DYNA_TEST = old;
    await Promise.all(permits.map(releaseEbayApi));
  }
});
