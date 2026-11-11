import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { decrypt, encrypt, tokenHash } from '../server/security';
import { amazonAccountPolicy } from '../server/amazon-account';
import { AMAZON_MARKETS } from '../server/amazon';
import { amazonSellerCentral } from '../server/amazon-oauth';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  user: string;
let calls: any[] = [],
  hook = async () => {},
  response: () => Response;
const fresh = () =>
  new Response(
    JSON.stringify({
      access_token: 'ACCESS076',
      refresh_token: 'REFRESH076',
      token_type: 'bearer',
      expires_in: 3600,
    }),
  );
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload, headers: { cookie: auth } });
async function ok(p: string, method: any = 'GET', payload?: any, auth = cookie) {
  const r = await req(p, method, payload, auth);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const login = async (email = 'admin@demo.local') => {
  const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0];
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async (url, init) => {
      calls.push({ url, init });
      assert.equal(url, 'https://api.amazon.com/auth/o2/token');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert(init.signal);
      await hook();
      return response();
    },
  });
  cookie = await login();
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  user = (await ok('/auth/me')).user.id;
});
beforeEach(async () => {
  calls = [];
  hook = async () => {};
  response = fresh;
  await pool.query('DELETE FROM amazon_api_buckets');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
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
  const r = await ok(
    '/integrations',
    'POST',
    {
      provider: 'amazon',
      name: 'Amazon OAuth QA076',
      mode: extra.mode ?? 'sandbox',
      credentials: { client_id: 'CLIENT076', client_secret: 'SECRET076', ...extra.credentials },
      settings: {
        region: 'eu',
        selling_partner_id: 'SELLER076',
        application_id: 'amzn1.sellerapps.app.QA076',
        ...extra.settings,
      },
    },
    auth,
  );
  return r.id as string;
}
const ch = async (id: string) =>
  (await pool.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0];
const binding = async (id: string) =>
  (await pool.query('SELECT * FROM amazon_account_bindings WHERE channel_id=$1', [id])).rows[0];
const start = (id: string, body: any = {}, auth = cookie) =>
  ok(`/integrations/${id}/amazon-oauth/start`, 'POST', body, auth);
function returned(s: any, seller = 'SELLER076', code = 'code+/=&%076') {
  const u = new URL(s.redirect_uri);
  u.searchParams.set(
    'state',
    s.url
      ? new URL(s.url).searchParams.get('state')!
      : new URL(s.demo_return_url).searchParams.get('state')!,
  );
  u.searchParams.set('selling_partner_id', seller);
  u.searchParams.set('spapi_oauth_code', code);
  return u;
}
const finish = (s: any, seller = 'SELLER076', code?: string, auth = cookie) =>
  req('/oauth/amazon/finish', 'POST', { return_url: returned(s, seller, code).toString() }, auth);
async function connect(id: string) {
  const s = await start(id);
  const r = await finish(s);
  assert.equal(r.statusCode, 200, r.body);
  return s;
}

test('Amazon OAuth: new connection permits missing refresh token; incomplete application credentials and submitted simulation fail', async () => {
  const id = await create();
  assert.equal((await ch(id)).status, 'awaiting_oauth');
  assert.equal(decrypt((await ch(id)).credentials).refresh_token, '');
  for (const credentials of [
    { client_id: 'CLIENT076' },
    { client_secret: 'SECRET076' },
    { client_id: 'BAD\nID', client_secret: 'SECRET076' },
  ])
    assert.equal(
      (
        await req('/integrations', 'POST', {
          provider: 'amazon',
          name: 'Bad OAuth',
          mode: 'sandbox',
          credentials,
        })
      ).statusCode,
      422,
    );
  const injected = await create({
    settings: { simulation: 'true', server_url: 'https://evil.invalid' },
  });
  assert.equal((await ch(injected)).settings.simulation, undefined);
  assert(!JSON.stringify(await ok('/integrations')).includes('SECRET076'));
});
test('Amazon OAuth: official consent host for every supported marketplace; beta independent from API mode', async () => {
  assert.equal(amazonSellerCentral('A1PA6795UKMFR9'), 'https://sellercentral-europe.amazon.com');
  for (const [market, region] of Object.entries(AMAZON_MARKETS)) {
    const id = await create({ settings: { marketplace_id: market, region } }),
      s = await start(id),
      u = new URL(s.url);
    assert.equal(u.origin, amazonSellerCentral(market));
    assert.equal(u.pathname, '/apps/authorize/consent');
    assert.equal(u.searchParams.get('application_id'), 'amzn1.sellerapps.app.QA076');
    assert.equal(u.searchParams.get('version'), 'beta');
    assert.match(u.searchParams.get('state')!, /^[a-f0-9]{64}$/);
  }
  const id = await create({ mode: 'live', settings: { oauth_beta: 'false' } }),
    s = await start(id);
  assert(!new URL(s.url).searchParams.has('version'));
  assert.equal(calls.length, 0);
});
test('Amazon OAuth: one code exchange stores encrypted refresh grant and immutable callback binding, no API identity claim', async () => {
  const id = await create(),
    s = await start(id),
    r = await finish(s);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().api_identity_verified, false);
  assert.equal(calls.length, 1);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'code+/=&%076');
  assert.equal(form.get('client_id'), 'CLIENT076');
  assert.equal(form.get('client_secret'), 'SECRET076');
  assert.equal(form.get('redirect_uri'), s.redirect_uri);
  const current = await ch(id),
    b = await binding(id);
  assert.equal(decrypt(current.credentials).refresh_token, 'REFRESH076');
  assert(!current.credentials.includes('REFRESH076'));
  assert.equal(decrypt(current.credentials).access_token, undefined);
  assert.equal(b.source, 'oauth_callback');
  assert.equal(b.grant_hash, tokenHash(current.credentials));
  assert.equal(current.sync_enabled, false);
  assert.equal(current.amazon_oauth_attempt, null);
  const cached = await ok(`/integrations/${id}/amazon-account`);
  assert.equal(cached.bound, true);
  assert.equal(cached.api_identity_verified, false);
  assert.equal(cached.seller_id, 'SELLER076');
  assert(!JSON.stringify(cached).includes('REFRESH076'));
  const audit = (
    await pool.query(
      "SELECT detail FROM audit_events WHERE entity_id=$1 AND action='amazon.oauth.connected'",
      [id],
    )
  ).rows;
  assert.equal(audit[0].detail.reconnected, false);
  assert.equal((await finish(s)).statusCode, 422);
  assert.equal(calls.length, 1);
});
test('Amazon OAuth: different callback seller rejected before HTTP, original state still finishable', async () => {
  const id = await create(),
    s = await start(id);
  assert.equal((await finish(s, 'OTHERSELLER')).statusCode, 409);
  assert.equal(calls.length, 0);
  assert.equal((await finish(s)).statusCode, 200);
});
test('Amazon OAuth: same user other browser, other tenant, viewer and missing cookie cannot complete', async () => {
  const id = await create(),
    s = await start(id),
    second = await login();
  for (const auth of [second, other, viewer, ''])
    assert((await finish(s, 'SELLER076', undefined, auth)).statusCode >= 400);
  assert.equal(
    (await req(`/integrations/${id}/amazon-account`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/integrations/${id}/amazon-oauth/start`, 'POST', {}, viewer)).statusCode,
    403,
  );
  assert.equal(calls.length, 0);
  assert.equal((await finish(s)).statusCode, 200);
});
test('Amazon OAuth: manual return rejects wrong origin, path, duplicate and contradictory parameters without consuming state', async () => {
  const id = await create(),
    s = await start(id);
  for (const edit of [
    (u: URL) => (u.hostname = 'evil.invalid'),
    (u: URL) => (u.pathname = '/wrong'),
    (u: URL) => u.searchParams.append('state', 'a'.repeat(64)),
    (u: URL) => u.searchParams.set('error', 'access_denied'),
    (u: URL) => (u.hash = 'fragment'),
  ]) {
    const u = returned(s);
    edit(u);
    const r = await req('/oauth/amazon/finish', 'POST', { return_url: u.toString() });
    assert.equal(r.statusCode, 422, r.body);
  }
  assert.equal(calls.length, 0);
  assert.equal((await finish(s)).statusCode, 200);
});
test('Amazon OAuth: automatic callback strips code from final location and enforces registered origin', async () => {
  const id = await create(),
    s = await start(id),
    u = returned(s);
  const path = u.pathname + u.search;
  const r = await app.inject({ url: path, headers: { cookie, host: '127.0.0.1:4100' } });
  assert.equal(r.statusCode, 302, r.body);
  assert.equal(r.headers.location, '/?integration=connected');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(calls.length, 1);
  assert.equal(
    (await app.inject({ url: path, headers: { cookie, host: '127.0.0.1:4100' } })).statusCode,
    422,
  );
});
const loginReturn = (s: any, input: any = {}) =>
  '/oauth/amazon/login?' +
  new URLSearchParams({
    amazon_callback_uri: 'https://amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.QA076',
    amazon_state: 'AMAZON-STATE076',
    selling_partner_id: 'SELLER076',
    version: 'beta',
    ...input,
  });
test('Amazon OAuth: documented intermediate hop rotates state, preserves Amazon state, and cancellation survives rotation', async () => {
  const id = await create(),
    s = await start(id),
    r = await req(loginReturn(s));
  assert.equal(r.statusCode, 302, r.body);
  const u = new URL(r.headers.location!);
  assert.equal(u.origin, 'https://amazon.com');
  assert.equal(u.searchParams.get('amazon_state'), 'AMAZON-STATE076');
  assert.equal(u.searchParams.get('redirect_uri'), s.redirect_uri);
  assert.notEqual(u.searchParams.get('state'), new URL(s.url).searchParams.get('state'));
  assert.equal((await finish(s)).statusCode, 422);
  const rotated = { ...s, url: u.toString() };
  assert.equal((await finish(rotated)).statusCode, 200);
  const next = await start(id, { confirm_same_account: true });
  assert.equal((await req(loginReturn(next))).statusCode, 302);
  await ok(`/integrations/${id}/amazon-oauth/cancel`, 'POST', {});
  assert.equal((await ch(id)).status, 'authorized_read');
  assert.equal(decrypt((await ch(id)).credentials).refresh_token, 'REFRESH076');
});
test('Amazon OAuth: intermediate continuation rejects foreign host, app/path/query/credentials, beta mismatch and seller mismatch', async () => {
  const id = await create(),
    s = await start(id);
  for (const url of [
    'https://evil.invalid/apps/authorize/confirm/amzn1.sellerapps.app.QA076',
    'https://amazon.com/apps/authorize/confirm/OTHER',
    'http://amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.QA076',
    'https://user@amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.QA076',
    'https://amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.QA076?a=b',
  ])
    assert.equal((await req(loginReturn(s, { amazon_callback_uri: url }))).statusCode, 422);
  assert.equal((await req(loginReturn(s, { selling_partner_id: 'OTHER' }))).statusCode, 409);
  const query = loginReturn(s).replace('&version=beta', '');
  assert.equal((await req(query)).statusCode, 409);
  assert.equal(calls.length, 0);
});
test('Amazon OAuth: new initiation invalidates prior same-session channel and other-session attempt on same channel', async () => {
  const id = await create(),
    id2 = await create(),
    s = await start(id);
  await start(id2);
  assert.equal((await ch(id)).amazon_oauth_attempt, null);
  assert.equal((await finish(s)).statusCode, 422);
  const first = await start(id),
    secondCookie = await login(),
    second = await start(id, {}, secondCookie);
  assert.equal((await finish(first)).statusCode, 422);
  assert.equal((await finish(second, 'SELLER076', undefined, secondCookie)).statusCode, 200);
});
test('Amazon OAuth: expired attempt cancels to original status; tokens retained and schedules remain paused', async () => {
  const id = await create({ credentials: { refresh_token: 'OLD076' } }),
    original = await ch(id);
  await pool.query('UPDATE channels SET sync_enabled=true WHERE id=$1', [id]);
  const s = await start(id, { confirm_same_account: true });
  await pool.query(
    "UPDATE amazon_oauth_states SET expires_at=now()-interval '1 second' WHERE channel_id=$1",
    [id],
  );
  assert.equal((await finish(s)).statusCode, 422);
  assert.equal((await ok(`/integrations/${id}/amazon-account`)).pending_expired, true);
  await ok(`/integrations/${id}/amazon-oauth/cancel`, 'POST', {});
  const current = await ch(id);
  assert.equal(current.status, original.status);
  assert.equal(current.credentials, original.credentials);
  assert.equal(current.sync_enabled, false);
});
test('Amazon OAuth: pending state blocks reads, order queue/schedule and catalog; no vendor HTTP', async () => {
  const id = await create({ credentials: { refresh_token: 'OLD076' } });
  await start(id, { confirm_same_account: true });
  assert.equal((await req(`/integrations/${id}/test`, 'POST')).statusCode, 409);
  assert.equal((await req(`/integrations/${id}/sync`, 'POST')).statusCode, 409);
  assert.equal(
    (await req(`/integrations/${id}/sync`, 'PATCH', { enabled: true, interval: 60 })).statusCode,
    409,
  );
  assert.equal(
    (
      await req(`/integrations/${id}/catalog-source-runs`, 'POST', {
        warehouse_id: warehouse,
        client_key: randomUUID(),
        import_stock: false,
        vat: 23,
      })
    ).statusCode,
    409,
  );
  assert.equal(calls.length, 0);
});
test('Amazon OAuth: unmanaged channel history cannot be attributed using a manual seller ID', async () => {
  const id = await create({ credentials: { refresh_token: 'OLD076' } }),
    p = (
      await pool.query('SELECT id FROM products WHERE tenant_id=$1 AND parent_id IS NULL LIMIT 1', [
        DEMO_TENANT,
      ])
    ).rows[0];
  await pool.query(
    "INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,price) VALUES($1,$2,$3,$4,'LEGACY076',0)",
    [randomUUID(), DEMO_TENANT, id, p.id],
  );
  assert.equal(
    (await req(`/integrations/${id}/amazon-oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    409,
  );
  assert.equal(calls.length, 0);
  assert.equal(await binding(id), undefined);
});
test('Amazon OAuth: reconnect requires same-account confirmation, preserves stable binding, replaces only grant', async () => {
  const id = await create();
  await connect(id);
  const before = await binding(id);
  assert.equal((await req(`/integrations/${id}/amazon-oauth/start`, 'POST', {})).statusCode, 422);
  response = () =>
    new Response(
      JSON.stringify({
        access_token: 'NEWACCESS',
        refresh_token: 'NEWREFRESH076',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );
  const s = await start(id, { confirm_same_account: true });
  assert.equal((await finish(s)).statusCode, 200);
  const after = await binding(id);
  assert.equal(after.seller_hash, before.seller_hash);
  assert.equal(after.created_at.toISOString(), before.created_at.toISOString());
  assert.notEqual(after.grant_hash, before.grant_hash);
  assert.equal(decrypt((await ch(id)).credentials).refresh_token, 'NEWREFRESH076');
});
test('Amazon OAuth: managed identity/config/grant changes refuse later operations and reconnect', async () => {
  const id = await create();
  await connect(id);
  const original = await ch(id);
  for (const settings of [
    { ...original.settings, selling_partner_id: 'OTHER' },
    { ...original.settings, region: 'na', marketplace_id: 'ATVPDKIKX0DER' },
  ]) {
    await pool.query('UPDATE channels SET settings=$2 WHERE id=$1', [id, settings]);
    assert.equal(
      (await req(`/integrations/${id}/amazon-oauth/start`, 'POST', { confirm_same_account: true }))
        .statusCode,
      409,
    );
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) => amazonAccountPolicy(c, { ...original, settings })),
    );
  }
  await pool.query('UPDATE channels SET settings=$2,credentials=$3 WHERE id=$1', [
    id,
    original.settings,
    encrypt({ client_id: 'CLIENT076', client_secret: 'SECRET076', refresh_token: 'INJECTED' }),
  ]);
  assert.equal((await req(`/integrations/${id}/test`, 'POST')).statusCode, 409);
  assert.equal(
    (await req(`/integrations/${id}/amazon-oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    409,
  );
  assert.equal(calls.length, 1);
});
test('Amazon OAuth: binding rows immutable, tenant-isolated, no application DELETE grant', async () => {
  const id = await create();
  await connect(id);
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE amazon_account_bindings SET seller_hash=$2 WHERE channel_id=$1', [
        id,
        'a'.repeat(64),
      ]),
    ),
    /immutable/,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT 1 FROM amazon_account_bindings WHERE channel_id=$1', [id]),
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('DELETE FROM amazon_account_bindings WHERE channel_id=$1', [id]),
    ),
    /permission denied/,
  );
});
for (const [name, result, status] of [
  ['401', () => new Response('SECRET-CODE-NOT-EXPOSED', { status: 401 }), 401],
  [
    '429',
    () => new Response('SECRET-CODE-NOT-EXPOSED', { status: 429, headers: { 'retry-after': '1' } }),
    429,
  ],
  [
    'malformed',
    () => new Response(JSON.stringify({ refresh_token: 'SECRET-CODE-NOT-EXPOSED' })),
    502,
  ],
  [
    'unknown transport',
    () => {
      throw new Error('SECRET-CODE-NOT-EXPOSED');
    },
    502,
  ],
] as const)
  test(
    'Amazon OAuth: ' + name + ' never replays authorization code or replaces old credentials',
    async () => {
      const id = await create({ credentials: { refresh_token: 'OLD076' } }),
        original = await ch(id),
        s = await start(id, { confirm_same_account: true });
      response = result;
      const r = await finish(s);
      assert.equal(r.statusCode, status, r.body);
      assert(!r.body.includes('SECRET-CODE'));
      assert.equal(calls.length, 1);
      assert.equal((await ch(id)).credentials, original.credentials);
      assert.equal((await ch(id)).status, original.status);
      assert.equal((await finish(s)).statusCode, 422);
      assert.equal(calls.length, 1);
    },
  );
test('Amazon OAuth: concurrent callbacks consume once and exchange once', async () => {
  const id = await create(),
    s = await start(id);
  let entered!: () => void, release!: () => void;
  const gate = new Promise<void>((r) => (entered = r)),
    wait = new Promise<void>((r) => (release = r));
  hook = async () => {
    entered();
    await wait;
  };
  const first = finish(s);
  await Promise.race([
    gate,
    first.then((r) => {
      throw Error('First callback failed before gate: ' + r.body);
    }),
    new Promise((_, reject) => setTimeout(() => reject(Error('Gate timeout')), 10000)),
  ]);
  assert.equal((await finish(s)).statusCode, 422);
  release();
  assert.equal((await first).statusCode, 200);
  assert.equal(calls.length, 1);
});
test('Amazon OAuth: cancellation during exchange prevents late token commit', async () => {
  const id = await create(),
    s = await start(id);
  hook = async () => {
    await ok(`/integrations/${id}/amazon-oauth/cancel`, 'POST', {});
  };
  const r = await finish(s);
  assert.equal(r.statusCode, 409);
  assert.equal(await binding(id), undefined);
  assert.equal(decrypt((await ch(id)).credentials).refresh_token, '');
  assert.equal((await ch(id)).status, 'awaiting_oauth');
});
test('Amazon OAuth: replacement attempt during exchange preserves new nonce and rejects late response', async () => {
  const id = await create(),
    s = await start(id);
  let newer: any;
  hook = async () => {
    newer = await start(id);
  };
  assert.equal((await finish(s)).statusCode, 409);
  assert.equal((await ch(id)).status, 'amazon_oauth_pending');
  assert.equal(await binding(id), undefined);
  hook = async () => {};
  assert.equal((await finish(newer)).statusCode, 200);
});
test('Amazon OAuth: revoked session and role changes during HTTP block grant storage', async () => {
  for (const change of ['session', 'role']) {
    const auth = await login(),
      id = await create({}, auth),
      s = await start(id, {}, auth);
    hook = async () => {
      if (change === 'session')
        await pool.query('DELETE FROM sessions WHERE token_hash=$1', [
          tokenHash(auth.slice(auth.indexOf('=') + 1)),
        ]);
      else
        await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          DEMO_TENANT,
          user,
        ]);
    };
    const r = await finish(s, 'SELLER076', undefined, auth);
    assert.equal(r.statusCode, change === 'session' ? 401 : 403, r.body);
    assert.equal(await binding(id), undefined);
    assert.equal(decrypt((await ch(id)).credentials).refresh_token, '');
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
    hook = async () => {};
    const freshSession = await login();
    await start(id, {}, freshSession);
    await ok(`/integrations/${id}/amazon-oauth/cancel`, 'POST', {}, freshSession);
  }
});
test('Amazon OAuth: configuration changes after start reject callback before HTTP', async () => {
  const id = await create(),
    s = await start(id);
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"listing_write":true}\' WHERE id=$1',
    [id],
  );
  assert.equal((await finish(s)).statusCode, 409);
  assert.equal(calls.length, 0);
});
test('Amazon OAuth: local example binds and reconnects without any vendor request, ciphertext changes or physical stock mutation', async () => {
  const example = await ok('/integrations/amazon-example', 'POST'),
    id = example.channel_id,
    original = await ch(id),
    stock = (
      await pool.query('SELECT to_jsonb(s)::text row FROM stock s WHERE tenant_id=$1 ORDER BY 1', [
        DEMO_TENANT,
      ])
    ).rows;
  const s = await start(id);
  assert.equal(s.url, null);
  const r = await req('/oauth/amazon/finish', 'POST', { return_url: s.demo_return_url });
  assert.equal(r.statusCode, 200, r.body);
  const b = await binding(id);
  assert.equal(b.source, 'simulation');
  assert.equal((await ch(id)).status, 'simulation');
  assert.equal((await ch(id)).credentials, original.credentials);
  assert.equal(calls.length, 0);
  assert.equal((await ok(`/integrations/${id}/amazon-account`)).api_identity_verified, false);
  const again = await start(id);
  assert.equal(
    (await req('/oauth/amazon/finish', 'POST', { return_url: again.demo_return_url })).statusCode,
    200,
  );
  assert.deepEqual(
    (
      await pool.query('SELECT to_jsonb(s)::text row FROM stock s WHERE tenant_id=$1 ORDER BY 1', [
        DEMO_TENANT,
      ])
    ).rows,
    stock,
  );
});
test('Amazon OAuth: restored preview denies consent, cancellation and completion, cached binding remains readable', async () => {
  const preview = await buildApp({ readOnly: true });
  const r = await preview.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  const pc = r.headers['set-cookie']!.toString().split(';')[0];
  const id = await create();
  for (const url of [
    `/api/integrations/${id}/amazon-oauth/start`,
    `/api/integrations/${id}/amazon-oauth/cancel`,
    '/api/oauth/amazon/finish',
  ])
    assert.equal(
      (await preview.inject({ url, method: 'POST', payload: {}, headers: { cookie: pc } }))
        .statusCode,
      423,
    );
  assert.equal(
    (
      await preview.inject({
        url: `/api/integrations/${id}/amazon-account`,
        headers: { cookie: pc },
      })
    ).statusCode,
    200,
  );
  await preview.close();
});

test('Amazon OAuth: active jobs prevent consent; managed pending channel blocks offer preview and enabling its schedule', async () => {
  const id = await create();
  await connect(id);
  const job = randomUUID();
  await pool.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'orders.sync',$3,$4)",
    [job, DEMO_TENANT, { channel_id: id, actor_id: user }, job],
  );
  assert.equal(
    (await req(`/integrations/${id}/amazon-oauth/start`, 'POST', { confirm_same_account: true }))
      .statusCode,
    409,
  );
  await pool.query("UPDATE jobs SET state='done' WHERE id=$1", [job]);
  const p = (
      await pool.query('SELECT id FROM products WHERE tenant_id=$1 AND parent_id IS NULL LIMIT 1', [
        DEMO_TENANT,
      ])
    ).rows[0],
    listing = randomUUID();
  await pool.query(
    "INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,price) VALUES($1,$2,$3,$4,'MANAGED076',0)",
    [listing, DEMO_TENANT, id, p.id],
  );
  await start(id, { confirm_same_account: true });
  assert.equal(
    (
      await req(`/integrations/${id}/offers/preview`, 'POST', {
        operation: 'sync',
        product_id: p.id,
        listing_id: listing,
        warehouse_id: warehouse,
        stock: true,
        price: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req(`/integrations/${id}/offer-sync`, 'PATCH', {
        version: 0,
        enabled: true,
        warehouse_id: warehouse,
        stock: true,
        price: true,
        interval_seconds: 30,
        verify_seconds: 60,
        confirm_external: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(calls.length, 1);
});
