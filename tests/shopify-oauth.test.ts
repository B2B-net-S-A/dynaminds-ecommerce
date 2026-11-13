import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT } from './fixtures';
import { rewriteShipmentFixture } from './shipment-identity-fixture';
import { encrypt, decrypt, tokenHash } from '../server/security';
import { channelRead } from '../server/channel-access';
import { refreshShopifyOAuth, shopifyAccountPolicy } from '../server/shopify-oauth';
import { importConnectionHash } from '../server/imports';
import {
  shopifyFulfillmentIdentity,
  processShopifyFulfillment,
} from '../server/shopify-fulfillment';
import { processOfferJob } from '../server/offers';
import { processIntegrationJob } from '../server/sync';
import { shopifyFulfillmentFixture } from './shopify-fulfillment-fixture';
import { SHOPIFY_VERSION, Shopify } from '../server/shopify';
import { Problem } from '../server/errors';
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  other = '',
  viewer = '',
  user = '',
  ip = 1;
let calls: any[] = [],
  hook: () => Promise<void> = async () => {},
  tokenStatus = 200,
  shopId = 'gid://shopify/Shop/1',
  scopes = ['read_orders', 'read_products', 'read_inventory', 'read_locations'],
  tokenOverride: any = {},
  badShop = false,
  unauthorized = 0,
  ff = shopifyFulfillmentFixture();
let variant: any = null;
const client = 'CLIENT086',
  secret = 'SHOPIFY-SECRET086-QA-ONLY';
const json = (v: any, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
  });
const ctx = {
  transport: async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/admin/oauth/access_token')) {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert(init.signal);
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('client_id'), client);
      assert.equal(body.get('client_secret'), secret);
      await hook();
      return json(
        {
          access_token: 'shpat_QA086_access_' + calls.length,
          refresh_token: 'shprt_QA086_refresh_' + calls.length,
          expires_in: 3600,
          refresh_token_expires_in: 7776000,
          scope: scopes.join(','),
          ...tokenOverride,
        },
        tokenStatus,
      );
    }
    const b = JSON.parse(String(init.body));
    if (unauthorized > 0) {
      unauthorized--;
      return json({}, 401);
    }
    const shop = {
      id: shopId,
      name: 'QA shop',
      myshopifyDomain: badShop ? 'other.myshopify.com' : new URL(url).hostname,
      currencyCode: 'PLN',
      taxesIncluded: true,
    };
    if (b.query.includes('query DynaShop'))
      return json({
        data: {
          shop,
          currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
        },
      });
    if (b.query.includes('query DynaTranslationLocales')) {
      await hook();
      return json({
        data: {
          shop,
          currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
          shopLocales: [
            { locale: 'pl', name: 'Polski', primary: true, published: true },
            { locale: 'de', name: 'Niemiecki', primary: false, published: true },
            { locale: 'fr', name: 'Francuski', primary: false, published: false },
          ],
        },
      });
    }
    if (b.query.includes('query DynaOrders'))
      return json({
        data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      });
    if (b.query.includes('query DynaOffer('))
      return json({ data: { shop, productVariant: structuredClone(variant) } });
    if (b.query.includes('mutation DynaOfferPrice')) {
      variant.price = b.variables.variants[0].price;
      return json({
        data: {
          productVariantsBulkUpdate: {
            product: { id: variant.product.id },
            productVariants: [{ id: variant.id, price: variant.price }],
            userErrors: [],
          },
        },
      });
    }
    if (b.query.includes('Fulfillment')) return ff.transport(url, init);
    throw new Error('Unexpected GraphQL operation');
  },
};
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie: auth },
    remoteAddress: '127.0.6.' + ip,
  });
const ok = async (p: string, m: any = 'GET', b?: any, a = cookie) => {
  const r = await req(p, m, b, a);
  assert(r.statusCode >= 200 && r.statusCode < 300, r.body);
  return r.json();
};
async function login(email = 'admin@demo.local') {
  const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0];
}
before(async () => {
  assert.equal(process.env.DYNA_TEST, 'true');
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  cookie = await login();
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  user = (await ok('/auth/me')).user.id;
});
beforeEach(async () => {
  ip++;
  calls = [];
  hook = async () => {};
  tokenStatus = 200;
  shopId = 'gid://shopify/Shop/1';
  scopes = ['read_orders', 'read_products', 'read_inventory', 'read_locations'];
  tokenOverride = {};
  badShop = false;
  unauthorized = 0;
  ff = shopifyFulfillmentFixture();
  variant = null;
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
afterEach(async () => {
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
});
after(async () => {
  await app.close();
  await pool.end();
});
async function create(extra: any = {}, auth = cookie) {
  return (
    await ok(
      '/integrations',
      'POST',
      {
        provider: 'shopify',
        name: 'QA Shopify OAuth086',
        mode: 'sandbox',
        settings: { store_url: 'https://qa-' + randomUUID() + '.myshopify.com', ...extra.settings },
        credentials: { client_id: client, client_secret: secret, ...extra.credentials },
      },
      auth,
    )
  ).id as string;
}
const ch = async (id: string) =>
  (await pool.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0];
const binding = async (id: string) =>
  (await pool.query('SELECT * FROM shopify_account_bindings WHERE channel_id=$1', [id])).rows[0];
const start = (id: string, body: any = {}, auth = cookie) =>
  ok(`/integrations/${id}/shopify-oauth/start`, 'POST', body, auth);
function returned(s: any, extra: Record<string, string> = {}) {
  const u = new URL(s.url),
    p = {
      code: 'code086+/=&%',
      state: u.searchParams.get('state')!,
      shop: u.hostname,
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...extra,
    };
  const hmac = createHmac('sha256', secret)
    .update(
      Object.entries(p)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('&'),
    )
    .digest('hex');
  const r = new URL(u.searchParams.get('redirect_uri')!);
  Object.entries({ ...p, hmac }).forEach(([k, v]) => r.searchParams.set(k, v));
  return r.toString();
}
const finish = (s: any, extra?: Record<string, string>, auth = cookie) =>
  req('/oauth/shopify/finish', 'POST', { return_url: returned(s, extra) }, auth);
async function connect(body: any = {}) {
  const id = await create(),
    s = await start(id, body);
  scopes = s.requested_scopes;
  const r = await finish(s);
  assert.equal(r.statusCode, 200, r.body);
  return { id, s };
}
async function expire(id: string) {
  await pool.query("UPDATE channels SET token_expires_at=now()-interval '1 second' WHERE id=$1", [
    id,
  ]);
}
const tokenCalls = () => calls.filter((c) => c.url.endsWith('/admin/oauth/access_token'));
test('Shopify OAuth: standalone URL, expiring offline exchange, GraphQL store/scopes, encrypted state and binding', async () => {
  const id = await create(),
    s = await start(id);
  assert.equal(s.scope, 'external_consent');
  const u = new URL(s.url);
  assert.equal(u.pathname, '/admin/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), client);
  assert.equal(u.searchParams.get('grant_options[]'), null);
  assert(!s.url.includes(secret));
  const r = await finish(s);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().shop_id, shopId);
  const channel = await ch(id),
    b = await binding(id),
    creds = decrypt(channel.credentials);
  assert.equal(channel.status, 'authorized_read');
  assert.equal(b.source, 'graphql');
  assert.equal(b.grant_id, creds.oauth_grant_id);
  assert.equal(b.scopes.join(','), creds.granted_scope);
  assert.equal(new URLSearchParams(tokenCalls()[0].init.body).get('expiring'), '1');
  const st = (await pool.query('SELECT * FROM shopify_oauth_states WHERE channel_id=$1', [id]))
    .rows[0];
  assert.equal(st.state, 'done');
  assert(st.exchange_started_at);
  assert(!st.verifier.includes(secret));
  assert.equal(decrypt(st.verifier).provider, 'shopify');
  const cached = await ok(`/integrations/${id}/shopify-account`);
  assert(cached.bound && cached.grant_matches && cached.has_refresh_token);
  assert(!JSON.stringify(cached).includes('shpat_'));
});
test('Shopify OAuth: opt-in write permissions imply reads and never enable schedules', async () => {
  const { id, s } = await connect({
    products_write: true,
    inventory_write: true,
    publications_write: true,
    fulfillment_write: true,
    translations_write: true,
  });
  assert(s.requested_scopes.includes('write_products'));
  assert(!s.requested_scopes.includes('read_products'));
  assert(s.requested_scopes.includes('write_merchant_managed_fulfillment_orders'));
  assert(s.requested_scopes.includes('write_translations'));
  assert(s.requested_scopes.includes('read_locales'));
  assert.equal((await ch(id)).sync_enabled, false);
});
test('Shopify OAuth: callback must belong to original browser session, user and tenant', async () => {
  const id = await create(),
    s = await start(id),
    secondSession = await login();
  for (const a of [other, viewer, secondSession])
    assert([403, 422].includes((await finish(s, undefined, a)).statusCode));
  assert.equal(tokenCalls().length, 0);
  assert.equal((await finish(s)).statusCode, 200);
});
test('Shopify OAuth: viewer cannot start or inspect account; other firm cannot see channel', async () => {
  const id = await create();
  assert.equal(
    (await req(`/integrations/${id}/shopify-oauth/start`, 'POST', {}, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req(`/integrations/${id}/shopify-account`, 'GET', undefined, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req(`/integrations/${id}/shopify-account`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(calls.length, 0);
});
test('Shopify OAuth: HMAC tampering, wrong domain, duplicate keys, old timestamp and redirect are rejected before exchange', async () => {
  const id = await create(),
    s = await start(id);
  const valid = returned(s);
  for (const v of [
    valid.replace('code086', 'evil'),
    returned(s, { shop: 'attacker.myshopify.com' }),
    valid + '&shop=' + new URL(s.url).hostname,
    returned(s, { timestamp: String(Math.floor(Date.now() / 1000) - 601) }),
    valid.replace('127.0.0.1', 'localhost'),
    valid + '#fragment',
    'invalid-url',
  ]) {
    const r = await req('/oauth/shopify/finish', 'POST', { return_url: v });
    assert([422, 403].includes(r.statusCode), r.body);
  }
  assert.equal(tokenCalls().length, 0);
  assert.equal((await finish(s)).statusCode, 200);
});
test('Shopify OAuth: concurrent and repeated callbacks exchange code only once', async () => {
  const s = await start(await create());
  const r = await Promise.all([finish(s), finish(s)]);
  assert.deepEqual(r.map((x) => x.statusCode).sort(), [200, 422]);
  assert.equal(tokenCalls().length, 1);
  assert.equal((await finish(s)).statusCode, 422);
});
test('Shopify OAuth: signed direct local callback returns a fixed local redirect', async () => {
  const s = await start(await create()),
    u = new URL(returned(s));
  const r = await app.inject({
    url: u.pathname + u.search,
    headers: { cookie, host: u.host },
    remoteAddress: '127.0.6.' + ip,
  });
  assert.equal(r.statusCode, 302, r.body);
  assert.equal(r.headers.location, '/?integration=shopify_connected');
});
test('Shopify OAuth: cancellation before exchange restores status; old callback cannot be used', async () => {
  const id = await create(),
    s = await start(id);
  await ok(`/integrations/${id}/shopify-oauth/cancel`, 'POST', {});
  assert.equal((await ch(id)).status, 'awaiting_oauth');
  assert.equal((await finish(s)).statusCode, 422);
  assert.equal(tokenCalls().length, 0);
  const count = await pool.query('SELECT 1 FROM shopify_oauth_scopes WHERE channel_id=$1', [id]);
  assert.equal(count.rowCount, 0);
});
test('Shopify OAuth: same app/store is owned by one tenant/channel even across sandbox/live labels', async () => {
  const id = await create(),
    s = await start(id),
    a = await ch(id),
    second = await create({ settings: a.settings }, other);
  const r = await req(`/integrations/${second}/shopify-oauth/start`, 'POST', {}, other);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal((await finish(s)).statusCode, 200);
});
test('Shopify OAuth: failed exchange is durable, secret-safe, cannot replay code and retains ownership', async () => {
  const id = await create(),
    s = await start(id);
  tokenStatus = 500;
  tokenOverride = { error: secret };
  const r = await finish(s);
  assert.equal(r.statusCode, 502);
  assert(!r.body.includes(secret));
  assert.equal((await finish(s)).statusCode, 422);
  assert.equal(tokenCalls().length, 1);
  await ok(`/integrations/${id}/shopify-oauth/cancel`, 'POST', {});
  assert.equal((await ch(id)).status, 'shopify_reauthorization_required');
  assert.equal(
    (await pool.query('SELECT 1 FROM shopify_oauth_scopes WHERE channel_id=$1', [id])).rowCount,
    1,
  );
});
test('Shopify OAuth: mismatched shop or incomplete scopes never save tokens or bind store', async () => {
  for (const invalid of ['shop', 'scope', 'online', 'refresh']) {
    const id = await create(),
      s = await start(id);
    badShop = invalid === 'shop';
    tokenOverride =
      invalid === 'scope'
        ? { scope: 'read_products' }
        : invalid === 'online'
          ? { associated_user: { id: 1 } }
          : invalid === 'refresh'
            ? { refresh_token: undefined }
            : {};
    const r = await finish(s);
    assert([502, 403].includes(r.statusCode), r.body);
    assert.equal(await binding(id), undefined);
    assert.equal(decrypt((await ch(id)).credentials).access_token, undefined);
  }
});
test('Shopify OAuth: role revoked during HTTP prevents token persistence and GraphQL probe', async () => {
  const id = await create(),
    s = await start(id);
  hook = async () => {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  };
  assert.equal((await finish(s)).statusCode, 403);
  assert.equal(await binding(id), undefined);
  assert.equal(calls.length, 1);
});
test('Shopify OAuth: logout during HTTP prevents token persistence', async () => {
  const local = await login(),
    id = await create({}, local),
    s = await start(id, {}, local);
  hook = async () => {
    await req('/auth/logout', 'POST', {}, local);
  };
  assert.equal((await finish(s, undefined, local)).statusCode, 401);
  assert.equal(await binding(id), undefined);
});
test('Shopify OAuth: initial binding refuses existing marketplace history', async () => {
  const id = await create(),
    wh = (await ok('/warehouses')).data[0].id;
  const p = await ok('/products', 'POST', {
    sku: 'LEGACY-' + randomUUID(),
    name: 'Legacy Shopify',
    price: 100,
    vat: 23,
    quantity: 1,
    warehouse_id: wh,
  });
  await ok(`/integrations/${id}/mappings`, 'POST', {
    external_id: 'gid://shopify/ProductVariant/1',
    sku: p.sku,
  });
  assert.equal((await req(`/integrations/${id}/shopify-oauth/start`, 'POST', {})).statusCode, 409);
  assert.equal(calls.length, 0);
});
test('Shopify OAuth: reauthorization needs confirmation, keeps immutable shop, disables read during consent', async () => {
  const { id } = await connect();
  assert.equal((await req(`/integrations/${id}/shopify-oauth/start`, 'POST', {})).statusCode, 422);
  const before = await ch(id),
    s = await start(id, { confirm_same_account: true });
  await assert.rejects(
    channelRead(DEMO_TENANT, id, (c) => (c as Shopify).test(), ctx),
    (e: any) => e.status === 409,
  );
  shopId = 'gid://shopify/Shop/2';
  assert.equal((await finish(s)).statusCode, 409);
  assert.equal((await binding(id)).shop_id, 'gid://shopify/Shop/1');
  assert.equal((await ch(id)).credentials, before.credentials);
});
test('Shopify OAuth: periodic refresh rotates both tokens, retains grant and fingerprints, validates immediately before/after', async () => {
  const { id } = await connect(),
    before = await ch(id),
    old = decrypt(before.credentials),
    fp = importConnectionHash(before),
    ful = shopifyFulfillmentIdentity(before);
  await expire(id);
  let validations = 0;
  const current = await refreshShopifyOAuth(DEMO_TENANT, id, undefined, ctx, () => {
    validations++;
  });
  const credentials = decrypt(current.credentials);
  assert.notEqual(credentials.access_token, old.access_token);
  assert.notEqual(credentials.refresh_token, old.refresh_token);
  assert.equal(credentials.oauth_grant_id, old.oauth_grant_id);
  assert.equal(importConnectionHash(current), fp);
  assert.equal(shopifyFulfillmentIdentity(current), ful);
  assert.equal(validations, 2);
  const p = new URLSearchParams(tokenCalls()[1].init.body);
  assert.equal(p.get('grant_type'), 'refresh_token');
  assert.equal(p.get('refresh_token'), old.refresh_token);
  assert.equal(p.get('code'), null);
});
test('Shopify OAuth: simultaneous reads refresh exactly once and use current token', async () => {
  const { id } = await connect();
  await expire(id);
  calls = [];
  const r = await Promise.all(
    [1, 2, 3].map(() => channelRead(DEMO_TENANT, id, (c) => (c as Shopify).test(), ctx)),
  );
  assert.equal(r.length, 3);
  assert.equal(tokenCalls().length, 1);
});
test('Shopify OAuth: 401 refresh replays read once, never replays a write callback', async () => {
  const { id } = await connect();
  unauthorized = 1;
  await channelRead(DEMO_TENANT, id, (c) => (c as Shopify).test(), ctx);
  assert.equal(tokenCalls().length, 2);
  let entered = 0;
  await assert.rejects(
    channelRead(
      DEMO_TENANT,
      id,
      async () => {
        entered++;
        throw new Problem(401, 'Unauthorized after mutation');
      },
      ctx,
      false,
    ),
    (e: any) => e.status === 502,
  );
  assert.equal(entered, 1);
  assert.equal(tokenCalls().length, 3);
});
test('Shopify OAuth: refresh refuses expanded/revoked scopes and altered grant without saving credentials', async () => {
  const { id } = await connect();
  await expire(id);
  const before = await ch(id);
  tokenOverride = { scope: 'read_products' };
  await assert.rejects(
    refreshShopifyOAuth(DEMO_TENANT, id, undefined, ctx),
    (e: any) => e.status === 403,
  );
  assert.equal((await ch(id)).credentials, before.credentials);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    id,
    encrypt({ ...decrypt(before.credentials), client_secret: 'altered-secret-QA086' }),
  ]);
  const n = calls.length;
  await assert.rejects(
    channelRead(DEMO_TENANT, id, (c) => (c as Shopify).test(), ctx),
    (e: any) => e.status === 409,
  );
  assert.equal(calls.length, n);
});
test('Shopify OAuth: expired refresh blocks network; credential CAS and revoked job fence block persistence', async () => {
  const { id } = await connect();
  await expire(id);
  const before = await ch(id);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    id,
    encrypt({ ...decrypt(before.credentials), refresh_expires_at: '2020-01-01T00:00:00Z' }),
  ]);
  let n = calls.length;
  await assert.rejects(
    refreshShopifyOAuth(DEMO_TENANT, id, undefined, ctx),
    (e: any) => e.status === 401,
  );
  assert.equal(calls.length, n);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [id, before.credentials]);
  hook = async () => {
    await pool.query(
      'UPDATE channels SET settings=settings||\'{"unexpected":true}\'::jsonb WHERE id=$1',
      [id],
    );
  };
  await assert.rejects(
    refreshShopifyOAuth(DEMO_TENANT, id, undefined, ctx),
    (e: any) => e.status === 409,
  );
  assert.equal((await ch(id)).credentials, before.credentials);
});
test('Shopify OAuth: session-independent job fence rejects after refresh HTTP', async () => {
  const { id } = await connect();
  await expire(id);
  const before = await ch(id);
  let active = true;
  hook = async () => {
    active = false;
  };
  await assert.rejects(
    refreshShopifyOAuth(DEMO_TENANT, id, undefined, ctx, () => {
      if (!active) throw new Problem(409, 'job revoked');
    }),
    (e: any) => e.status === 409,
  );
  assert.equal((await ch(id)).credentials, before.credentials);
});
test('Shopify OAuth: manual token works without refresh and preserves legacy source fingerprint', async () => {
  const id = await create({
    credentials: { client_id: '', client_secret: '', access_token: 'shpat_QA086_manual_token' },
  });
  await ok(`/integrations/${id}/test`, 'POST', {});
  assert.equal(tokenCalls().length, 0);
  const channel = await ch(id);
  assert.equal(
    importConnectionHash(channel),
    tokenHash(
      JSON.stringify(
        Object.fromEntries(
          Object.entries({
            provider: channel.provider,
            mode: channel.mode,
            settings: channel.settings,
            credentials: channel.credentials,
          }).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    ),
  );
});
test('Shopify OAuth: app credentials require pair, rejects arbitrary flags and callback domains', async () => {
  for (const change of [
    { credentials: { client_id: client } },
    { credentials: {} },
    { credentials: { access_token: 'shpat_QA086_manual_token', oauth_grant_id: randomUUID() } },
    { settings: { store_url: 'https://qa.myshopify.com', simulation: 'true' } },
    {
      settings: {
        store_url: 'https://qa.myshopify.com',
        oauth_redirect_uri: 'https://evil.test/api/oauth/shopify/callback',
      },
    },
  ]) {
    const r = await req('/integrations', 'POST', {
      provider: 'shopify',
      name: 'Invalid QA086',
      mode: 'sandbox',
      settings: { store_url: 'https://qa.myshopify.com' },
      credentials: { client_id: client, client_secret: secret },
      ...change,
    });
    assert.equal(r.statusCode, 422, r.body);
  }
});
test('Shopify OAuth: forced tenant RLS and immutable account/state, owner functions hide global claims', async () => {
  const { id } = await connect(),
    b = await binding(id);
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query(
        "UPDATE shopify_account_bindings SET shop_id='gid://shopify/Shop/99' WHERE channel_id=$1",
        [id],
      ),
    ),
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE shopify_oauth_states SET verifier=$2 WHERE channel_id=$1', [
        id,
        encrypt({ fake: true }),
      ]),
    ),
  );
  await assert.rejects(tenantTx(DEMO_TENANT, (c) => c.query('SELECT * FROM shopify_oauth_scopes')));
  assert.equal((await binding(id)).shop_id, b.shop_id);
  assert.equal(
    (await req(`/integrations/${id}/shopify-account`, 'GET', undefined, other)).statusCode,
    404,
  );
});
test('Shopify OAuth: local example verifies and reauthorizes without HTTP', async () => {
  const example = await ok('/integrations/shopify-example', 'POST', {}),
    id = example.channel_id,
    s = await start(id, { fulfillment_write: true });
  assert.equal(s.url, null);
  assert.equal(
    (await req('/oauth/shopify/finish', 'POST', { return_url: s.demo_return_url })).statusCode,
    200,
  );
  assert.equal(calls.length, 0);
  assert.equal((await binding(id)).source, 'simulation');
  const again = await start(id);
  assert.equal(
    (await req('/oauth/shopify/finish', 'POST', { return_url: again.demo_return_url })).statusCode,
    200,
  );
  assert.equal(calls.length, 0);
});
test('Shopify OAuth: read-only recovery blocks callback and writes before HTTP', async () => {
  const { id } = await connect(),
    s = await start(id, { confirm_same_account: true }),
    ro = await buildApp({ readOnly: true, integrationTransport: ctx.transport });
  calls = [];
  const loginResponse = await ro.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  const auth = loginResponse.headers['set-cookie']!.toString().split(';')[0],
    u = new URL(returned(s));
  for (const r of [
    await ro.inject({
      url: '/api/oauth/shopify/finish',
      method: 'POST',
      payload: { return_url: u.toString() },
      headers: { cookie: auth },
    }),
    await ro.inject({ url: u.pathname + u.search, headers: { cookie: auth, host: u.host } }),
    await ro.inject({
      url: `/api/integrations/${id}/shopify-oauth/start`,
      method: 'POST',
      payload: { confirm_same_account: true },
      headers: { cookie: auth },
    }),
  ])
    assert.equal(r.statusCode, 423, r.body);
  assert.equal(calls.length, 0);
  await ro.close();
});

async function claimJob(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
test('Shopify OAuth: queued OMS sync survives token rotation and completes original checkpoint', async () => {
  const { id } = await connect(),
    queued = await ok(`/integrations/${id}/sync`, 'POST', {});
  await expire(id);
  const job = await claimJob(queued.id);
  await processIntegrationJob(job, ctx);
  const result = (await pool.query('SELECT * FROM jobs WHERE id=$1', [job.id])).rows[0];
  assert.equal(result.state, 'done', result.error);
  assert((await ch(id)).bootstrap_done);
  assert.equal(tokenCalls().length, 2);
});
test('Shopify OAuth: approved fulfillment refreshes before mutation and retains frozen plan', async () => {
  const { id } = await connect({ fulfillment_write: true }),
    wh = (await ok('/warehouses')).data[0].id;
  const p = await ok('/products', 'POST', {
    sku: 'OAUTH-SHIP-' + randomUUID(),
    name: 'OAuth shipping',
    price: 1500,
    vat: 23,
    quantity: 10,
    warehouse_id: wh,
  });
  await ok(`/integrations/${id}/mappings`, 'POST', {
    external_id: 'gid://shopify/ProductVariant/701',
    sku: p.sku,
  });
  const staged = (await ok(`/integrations/${id}/stage-orders`, 'POST', { data: [ff.state.raw] }))
    .data[0];
  const order = await ok(`/imports/${staged.id}/commit`, 'POST', {
    warehouse_id: wh,
    expected_hash: staged.source_hash,
  });
  await ok(`/orders/${order.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), `/orders/${order.id}/status`, { status: 'picking' }));
  for (let i = 0; i < 2; i++) await ok(`/orders/${order.id}/scan`, 'POST', { code: p.sku });
  await ok(`/orders/${order.id}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), `/orders/${order.id}/status`, { status: 'packed' }));
  await ok(`/orders/${order.id}/ship-demo`, 'POST', {});
  await rewriteShipmentFixture("UPDATE shipments SET mode='sandbox',tracking_number=$2 WHERE order_id=$1", [
    order.id,
    'QA086-' + randomUUID(),
  ]);
  const plan = await ok(`/orders/${order.id}/shopify-fulfillment/preview`, 'POST', {
    company: 'DPD',
  });
  await ok(`/shopify-fulfillment-plans/${plan.id}/queue`, 'POST', { confirm_external: true });
  await expire(id);
  const saved = (await pool.query('SELECT * FROM shopify_fulfillment_plans WHERE id=$1', [plan.id]))
    .rows[0];
  await processShopifyFulfillment(await claimJob(saved.job_id), ctx);
  const after = (await pool.query('SELECT * FROM shopify_fulfillment_plans WHERE id=$1', [plan.id]))
    .rows[0];
  assert.equal(after.state, 'done', after.error);
  assert.equal(after.connection_hash, saved.connection_hash);
  assert.equal(
    ff.calls.filter((c) => c.query.includes('mutation DynaFulfillmentCreate')).length,
    1,
  );
  assert.equal(tokenCalls().length, 2);
});
test('Shopify OAuth: approved price offer survives refresh while a new grant invalidates prior previews', async () => {
  const { id } = await connect({ products_write: true }),
    wh = (await ok('/warehouses')).data[0].id;
  const p = await ok('/products', 'POST', {
    sku: 'OAUTH-PRICE-' + randomUUID(),
    name: 'OAuth price',
    price: 12300,
    vat: 23,
    quantity: 10,
    warehouse_id: wh,
  });
  variant = {
    id: 'gid://shopify/ProductVariant/701',
    sku: p.sku,
    price: '10.00',
    compareAtPrice: '200.00',
    taxable: true,
    requiresComponents: false,
    inventoryPolicy: 'CONTINUE',
    product: { id: 'gid://shopify/Product/70', status: 'ACTIVE' },
    inventoryItem: { id: 'gid://shopify/InventoryItem/7', tracked: true, requiresShipping: true },
  };
  const listing = await ok(`/integrations/${id}/mappings`, 'POST', {
    external_id: variant.id,
    sku: p.sku,
  });
  const input = {
    product_id: p.id,
    listing_id: listing.id,
    warehouse_id: wh,
    operation: 'sync',
    price: true,
    stock: false,
  };
  const plan = await ok(`/integrations/${id}/offers/preview`, 'POST', input);
  await ok(`/offer-plans/${plan.id}/queue`, 'POST', { confirm_live: true });
  await expire(id);
  const stored = (await pool.query('SELECT * FROM offer_plans WHERE id=$1', [plan.id])).rows[0];
  await processOfferJob(await claimJob(stored.job_id), ctx);
  const after = (await pool.query('SELECT * FROM offer_plans WHERE id=$1', [plan.id])).rows[0];
  assert.equal(after.state, 'done', after.error);
  assert.equal(variant.price, '123.00');
  assert.equal(tokenCalls().length, 2);
  await pool.query('UPDATE products SET price=12400,version=version+1 WHERE id=$1', [p.id]);
  const preview = await ok(`/integrations/${id}/offers/preview`, 'POST', input),
    s = await start(id, { confirm_same_account: true, products_write: true });
  scopes = s.requested_scopes;
  assert.equal((await finish(s)).statusCode, 200);
  const r = await req(`/offer-plans/${preview.id}/queue`, 'POST', { confirm_live: true });
  assert.equal(r.statusCode, 409, r.body);
});

test('Shopify OAuth: consent refuses queued work and OMS refuses scheduling during consent', async () => {
  const { id } = await connect();
  await ok(`/integrations/${id}/sync`, 'POST', {});
  assert.equal(
    (await req(`/integrations/${id}/shopify-oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    409,
  );
  await pool.query("UPDATE jobs SET state='done' WHERE payload->>'channel_id'=$1", [id]);
  await start(id, { confirm_same_account: true });
  assert.equal((await req(`/integrations/${id}/sync`, 'POST', {})).statusCode, 409);
});
test('Shopify OAuth: abandoned exchange after process failure can be replaced after expiry without replaying code', async () => {
  const id = await create(),
    s = await start(id);
  await ok(`/integrations/${id}/shopify-oauth/cancel`, 'POST', {});
  await pool.query(
    `INSERT INTO shopify_oauth_states(id,tenant_id,channel_id,user_id,session_hash,state_hash,account_hash,verifier,state,expires_at,exchange_started_at,consumed_at) SELECT $2,tenant_id,channel_id,user_id,session_hash,$3,account_hash,verifier,'exchanging',now()-interval '1 minute',now()-interval '11 minutes',now()-interval '11 minutes' FROM shopify_oauth_states WHERE channel_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [id, randomUUID(), tokenHash(randomUUID())],
  );
  await pool.query("UPDATE channels SET status='shopify_oauth_pending' WHERE id=$1", [id]);
  const next = await start(id);
  assert.equal((await finish(s)).statusCode, 422);
  assert.equal((await finish(next)).statusCode, 200);
  assert.equal(tokenCalls().length, 1);
});

test('Shopify locales: read metadata from actual token scopes, exact shop binding and current administrator', async () => {
  const { id } = await connect({ translations_write: true });
  const before = calls.length;
  const r = await ok(`/integrations/${id}/shopify-locales`);
  assert.equal(r.source, 'graphql');
  assert.equal(r.shopId, shopId);
  assert.deepEqual(
    r.locales.map((l: any) => [l.locale, l.primary, l.published]),
    [
      ['pl', true, true],
      ['de', false, true],
      ['fr', false, false],
    ],
  );
  assert.equal(calls.length, before + 1);
  assert(!JSON.stringify(r).includes('shpat_'));
  const deniedBefore = calls.length;
  assert.equal(
    (await req(`/integrations/${id}/shopify-locales`, 'GET', undefined, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req(`/integrations/${id}/shopify-locales`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(calls.length, deniedBefore);
  scopes = scopes.filter((s) => s !== 'read_locales');
  assert.equal((await req(`/integrations/${id}/shopify-locales`)).statusCode, 403);
});
test('Shopify locales: read rechecks revoked role after provider response and forbids read during consent', async () => {
  const { id } = await connect({ translations_write: true });
  hook = async () => {
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  };
  assert.equal((await req(`/integrations/${id}/shopify-locales`)).statusCode, 403);
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  hook = async () => {};
  await start(id, { confirm_same_account: true, translations_write: true });
  const count = calls.length;
  assert.equal((await req(`/integrations/${id}/shopify-locales`)).statusCode, 409);
  assert.equal(calls.length, count);
});
test('Shopify locales: local example needs translation opt-in and never contacts a provider', async () => {
  const id = (await ok('/integrations/shopify-example', 'POST', {})).channel_id;
  let s = await start(id, { confirm_same_account: true });
  await ok('/oauth/shopify/finish', 'POST', { return_url: s.demo_return_url });
  assert.equal((await req(`/integrations/${id}/shopify-locales`)).statusCode, 403);
  s = await start(id, { confirm_same_account: true, translations_write: true });
  await ok('/oauth/shopify/finish', 'POST', { return_url: s.demo_return_url });
  const before = calls.length,
    r = await ok(`/integrations/${id}/shopify-locales`);
  assert.equal(r.source, 'local_simulation');
  assert.equal(r.locales.length, 4);
  assert.equal(calls.length, before);
});
test('Shopify locales: recovery preview refuses reads before touching provider or credentials', async () => {
  const { id } = await connect({ translations_write: true }),
    before = calls.length;
  const ro = await buildApp({ readOnly: true, integrationTransport: ctx.transport });
  try {
    const login = await ro.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const result = await ro.inject({
      url: `/api/integrations/${id}/shopify-locales`,
      headers: { cookie: login.headers['set-cookie']!.toString().split(';')[0] },
    });
    assert.equal(result.statusCode, 423, result.body);
    assert.equal(calls.length, before);
  } finally {
    await ro.close();
  }
});
