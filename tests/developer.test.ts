import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { apiScopes, publicOperations } from '../server/developer-api';
import { tick } from '../server/worker';
import {
  processOutbound,
  failOutbound,
  verifyWebhook,
  signWebhook,
  createWebhookTransport,
} from '../server/outbound-webhooks';
import { decrypt, tokenHash } from '../server/security';
import type { Transport } from '../server/integrations';
assert.equal(process.env.DYNA_TEST, 'true');
// Without the genuine startup gate, every tenantTx first runs the full schema
// validators on a pool session (server/db.ts:287); pim_dictionary_valid() alone
// takes 5-8 s on a shared PG04, so it hit the 8 s session limit (57014) under load.
// The gated server runs the same validators once at startup with 120 s
// (server/db.ts:115). Pool sessions of this file get that budget; statements
// inside tenantTx keep SET LOCAL statement_timeout='8s' and lock_timeout stays 8 s.
assert.equal(pool.totalCount, 0);
assert.match(pool.options.options ?? '', /-c statement_timeout=8000 /);
pool.options.options = pool.options.options!.replace('-c statement_timeout=8000 ', '-c statement_timeout=120000 ');
let app: Awaited<ReturnType<typeof buildApp>>;
const password = 'DeveloperLocal!2026';
const req = (url: string, method: any = 'GET', payload?: any, cookie?: string, extra: any = {}) =>
  app.inject({ url, method, payload, headers: { ...(cookie ? { cookie } : {}), ...extra } });
const bearer = (token: string) => ({ authorization: 'Bearer ' + token });
const cookieOf = (r: any) => r.headers['set-cookie'].toString().split(';')[0];
before(async () => {
  await migrate();
  await seed();
});
beforeEach(async () => {
  // Only rows tick() can claim or deliver; the suite database is shared.
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
  await pool.query('UPDATE outbound_subscriptions SET enabled=false WHERE enabled');
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
});
after(async () => {
  await pool.end();
});
test('transport HTTPS przypina publiczny IP dla obu trybów lookup, zachowuje Retry-After i odrzuca body odpowiedzi', async () => {
  let options: any,
    sent = '',
    destroyed = false;
  const transport = createWebhookTransport({
    validate: async (url) => url,
    addresses: async () => [{ address: '93.184.216.34', family: 4 }],
    request: ((url: URL, init: any, callback: any) => {
      assert.equal(url.hostname, 'example.org');
      options = init;
      const request = new EventEmitter() as any;
      request.end = (body: string) => {
        sent = body;
        queueMicrotask(() =>
          callback({
            statusCode: 429,
            headers: { 'retry-after': '600' },
            destroy: () => {
              destroyed = true;
            },
          }),
        );
      };
      return request;
    }) as any,
  });
  const response = await transport('https://example.org/webhook', {
    method: 'POST',
    headers: { 'x-dyna-signature': 'v1=test' },
    body: '{"event":"QA"}',
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '600');
  assert.equal(await response.text(), '');
  assert(destroyed);
  assert.equal(sent, '{"event":"QA"}');
  assert.equal(options.servername, 'example.org');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['x-dyna-signature'], 'v1=test');
  options.lookup('example.org', {}, (error: unknown, address: string, family: number) => {
    assert.equal(error, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
  options.lookup('example.org', { all: true }, (error: unknown, addresses: any) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  });
});
async function owner() {
  const r = await req('/api/auth/signup', 'POST', {
    name: 'QA API',
    email: randomUUID() + '@example.test',
    password,
    organization: { name: 'QA API ' + randomUUID() },
  });
  assert.equal(r.statusCode, 201, r.body);
  return { cookie: cookieOf(r), user: r.json().user };
}
async function key(a: any, scopes: string[] = [...apiScopes]) {
  const r = await req('/api/developer/keys', 'POST', { name: 'QA API key', scopes }, a.cookie);
  assert.equal(r.statusCode, 201);
  return r.json();
}
async function hook(a: any, events = ['order.created'], enable = true, mode = 'local') {
  const r = await req(
    '/api/developer/webhooks',
    'POST',
    {
      name: 'QA webhook',
      events,
      mode,
      ...(mode === 'https' ? { url: 'https://example.org/dyna-callback' } : {}),
    },
    a.cookie,
  );
  assert.equal(r.statusCode, 201);
  const s = r.json();
  if (enable)
    assert.equal(
      (
        await req(
          '/api/developer/webhooks/' + s.id + '/enable',
          'POST',
          { confirm_destination: mode === 'local' ? 'local' : s.url },
          a.cookie,
        )
      ).statusCode,
      200,
    );
  return s;
}
async function product(a: any) {
  const w = (await req('/api/warehouses', 'GET', undefined, a.cookie)).json().data[0].id;
  const p = await req(
    '/api/products',
    'POST',
    {
      name: 'QA produkt API',
      sku: 'API-' + randomUUID(),
      price: 100,
      warehouse_id: w,
      quantity: 100,
    },
    a.cookie,
  );
  assert.equal(p.statusCode, 201, p.body);
  return { ...p.json(), warehouse_id: w };
}
function order(p: any) {
  return {
    customer_name: 'QA Kupujący',
    email: 'buyer@example.test',
    warehouse_id: p.warehouse_id,
    items: [{ product_id: p.id, quantity: 2 }],
  };
}
async function delivery(a: any) {
  return (
    await pool.query(
      'SELECT d.*,e.body,e.payload FROM outbound_deliveries d JOIN outbound_events e ON (e.tenant_id,e.id)=(d.tenant_id,d.event_id) WHERE d.tenant_id=$1 ORDER BY d.created_at DESC LIMIT 1',
      [a.user.tenant_id],
    )
  ).rows[0];
}
async function claim(d: any) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *",
      [d.job_id, randomUUID()],
    )
  ).rows[0];
}
const localTransport: Transport = async (url, init) => {
  const r = await app.inject({
    method: 'POST',
    url: new URL(url).pathname,
    payload: String(init.body),
    headers: init.headers as any,
  });
  return new Response(r.body, { status: r.statusCode });
};
async function run(d: any, transport: Transport = localTransport) {
  const j = await claim(d);
  try {
    await processOutbound(j, { transport });
  } catch (e) {
    await failOutbound(j, e);
  }
  return j;
}

test('OpenAPI opisuje wszystkie rzeczywiście zarejestrowane operacje i schemat tworzenia', async () => {
  const r = await req('/api/v1/openapi');
  assert.equal(r.statusCode, 200, r.body);
  const spec = r.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(
    Object.values(spec.paths).reduce((n: any, p: any) => n + Object.keys(p).length, 0),
    publicOperations.length,
  );
  assert.deepEqual(
    spec.paths['/orders'].post.requestBody.content['application/json'].schema.required,
    ['customer_name', 'email', 'warehouse_id', 'items'],
  );
  assert.equal(
    spec.paths['/orders'].get.parameters.find((p: any) => p.name === 'after').schema.format,
    undefined,
  );
});
test('klucz przechowuje hash i prefix; listy/audyt nie ujawniają tokenu', async () => {
  const a = await owner(),
    k = await key(a, ['orders:read']);
  const db = (await pool.query('SELECT token_hash FROM api_keys WHERE id=$1', [k.id])).rows[0];
  assert.equal(db.token_hash, tokenHash(k.token));
  const list = await req('/api/developer/keys', 'GET', undefined, a.cookie);
  assert(!list.body.includes(k.token));
  assert(!list.body.includes(db.token_hash));
  assert(!(await req('/api/audit', 'GET', undefined, a.cookie)).body.includes(k.token));
  assert.equal(
    (await req('/api/v1/orders', 'GET', undefined, undefined, bearer(k.token))).statusCode,
    200,
  );
});
test('zakresy odczytu nie zapisują, nie odczytują innych obszarów ani panelu admina', async () => {
  const a = await owner(),
    k = await key(a, ['orders:read']);
  for (const [url, method] of [
    ['/api/v1/orders', 'POST'],
    ['/api/v1/products', 'GET'],
    ['/api/developer/keys', 'GET'],
    ['/api/settings', 'GET'],
    ['/api/integrations', 'GET'],
    ['/api/auth/me', 'GET'],
    ['/api/orders', 'GET'],
  ] as const)
    assert.equal((await req(url, method, undefined, undefined, bearer(k.token))).statusCode, 403);
  assert.equal(
    (await req('/api/v1/orders', 'POST', {}, a.cookie, bearer(k.token))).statusCode,
    403,
  );
  assert.equal((await req('/api/v1/orders')).statusCode, 401);
});
test('klucz jest przypisany do firmy, nawet gdy właściciel przełączy sesję', async () => {
  const a = await owner(),
    p = await product(a),
    k = await key(a, ['products:read']);
  const other = await owner(),
    privateProduct = await product(other);
  assert.equal(
    (
      await req(
        '/api/v1/products/' + privateProduct.id,
        'GET',
        undefined,
        undefined,
        bearer(k.token),
      )
    ).statusCode,
    404,
  );
  const switched = await req('/api/workspaces', 'POST', { name: 'QA kolejna' }, a.cookie);
  assert.equal(switched.statusCode, 201);
  const list = (await req('/api/v1/products', 'GET', undefined, undefined, bearer(k.token))).json();
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].id, p.id);
  assert.equal(
    (
      await req('/api/v1/products', 'GET', undefined, undefined, {
        ...bearer(k.token),
        'x-workspace-id': other.user.tenant_id,
      })
    ).statusCode,
    409,
  );
});
test('wygasły i cofnięty klucz przestaje działać; obca firma nie cofa cudzych kluczy', async () => {
  const a = await owner(),
    b = await owner(),
    k = await key(a);
  assert.equal(
    (await req('/api/developer/keys/' + k.id, 'DELETE', undefined, b.cookie)).statusCode,
    404,
  );
  await pool.query("UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1", [k.id]);
  assert.equal(
    (await req('/api/v1/orders', 'GET', undefined, undefined, bearer(k.token))).statusCode,
    401,
  );
  const next = await key(a);
  await req('/api/developer/keys/' + next.id, 'DELETE', undefined, a.cookie);
  assert.equal(
    (await req('/api/v1/orders', 'GET', undefined, undefined, bearer(next.token))).statusCode,
    401,
  );
});
test('operator i podgląd nie tworzą kluczy ani webhooków; role tracą stare klucze trwale', async () => {
  const a = await owner(),
    k = await key(a),
    s = await hook(a);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    a.user.tenant_id,
    a.user.id,
  ]);
  assert.equal(
    (await req('/api/developer/keys', 'POST', { name: 'Bad', scopes: ['orders:read'] }, a.cookie))
      .statusCode,
    403,
  );
  assert.equal((await req('/api/developer/webhooks', 'GET', undefined, a.cookie)).statusCode, 403);
  assert.equal(
    (await req('/api/v1/orders', 'GET', undefined, undefined, bearer(k.token))).statusCode,
    401,
  );
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    a.user.tenant_id,
    a.user.id,
  ]);
  assert.equal(
    (await req('/api/v1/orders', 'GET', undefined, undefined, bearer(k.token))).statusCode,
    401,
  );
  assert.equal(
    (
      await req(
        '/api/developer/webhooks/' + s.id + '/enable',
        'POST',
        { confirm_destination: 'local' },
        a.cookie,
      )
    ).statusCode,
    404,
  );
});
test('limit kluczy jest atomowy przy równoczesnym tworzeniu i nie ogranicza innej firmy', async () => {
  const a = await owner();
  for (let n = 0; n < 19; n++) await key(a, ['orders:read']);
  const r = await Promise.all(
    Array.from({ length: 5 }, () =>
      req('/api/developer/keys', 'POST', { name: 'Race', scopes: ['orders:read'] }, a.cookie),
    ),
  );
  assert.equal(r.filter((x) => x.statusCode === 201).length, 1);
  assert(r.filter((x) => x.statusCode !== 201).every((x) => x.statusCode === 409));
  const b = await owner();
  await key(b);
});
test('publiczne zamówienie wymaga idempotencji; replay współbieżny rezerwuje raz', async () => {
  const a = await owner(),
    k = await key(a),
    p = await product(a),
    body = order(p);
  assert.equal(
    (await req('/api/v1/orders', 'POST', body, undefined, bearer(k.token))).statusCode,
    422,
  );
  const headers = { ...bearer(k.token), 'idempotency-key': randomUUID() };
  const r = await Promise.all(
    Array.from({ length: 6 }, () => req('/api/v1/orders', 'POST', body, undefined, headers)),
  );
  assert(
    r.every((x) => [200, 201].includes(x.statusCode)),
    r.map((x) => x.statusCode).join(','),
  );
  assert.equal(new Set(r.map((x) => x.json().id)).size, 1);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE tenant_id=$1', [a.user.tenant_id])).rows[0]
      .reserved,
    2,
  );
  const changed = await req(
    '/api/v1/orders',
    'POST',
    { ...body, customer_name: 'Zmiana' },
    undefined,
    headers,
  );
  assert.equal(changed.statusCode, 409);
});
test('cały proces API: produkt, zamówienie, skany, paczka/dokument DEMO i zwrot z webhookami', async () => {
  const a = await owner(),
    k = await key(a),
    s = await hook(a, ['order.created', 'order.status_changed', 'item.scanned']);
  const auth = bearer(k.token);
  const w = (await req('/api/v1/warehouses', 'GET', undefined, undefined, auth)).json().data[0].id;
  const p = (
    await req(
      '/api/v1/products',
      'POST',
      { name: 'API proces', sku: 'API-FLOW', price: 100, quantity: 5, warehouse_id: w },
      undefined,
      auth,
    )
  ).json();
  const o = await req('/api/v1/orders', 'POST', order({ ...p, warehouse_id: w }), undefined, {
    ...auth,
    'idempotency-key': randomUUID(),
  });
  assert.equal(o.statusCode, 201, o.body);
  const id = o.json().id;
  const status = async (value: string) => {
    const r = await req(
      '/api/v1/orders/' + id + '/status',
      'PATCH',
      await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined, undefined, auth), '/api/v1/orders/' + id + '/status', { status: value }),
      undefined,
      auth,
    );
    assert.equal(r.statusCode, 200, r.body);
  };
  // Required CAS contract: raw requests intentionally bypass the legacy serial adapter.
  assert.equal((await req('/api/v1/orders/' + id + '/status', 'PATCH', { status:'paid' }, undefined, auth)).statusCode,422);
  for (const invalid of ['abc','1e1','1.1','+1',' 1','1\n','9223372036854775808'])
    assert.equal((await req('/api/v1/orders/' + id + '/status', 'PATCH', { status:'paid',expected_version:invalid }, undefined, auth)).statusCode,422);
  const originalVersion=String(o.json().version);
  await status('paid');
  assert.equal((await req('/api/v1/orders/' + id + '/status', 'PATCH', { status:'cancelled',expected_version:originalVersion }, undefined, auth)).statusCode,409);
  assert.equal((await req('/api/v1/orders/' + id, 'GET', undefined, undefined, auth)).json().status,'paid');
  await status('picking');
  assert.equal(
    (await req('/api/v1/orders/' + id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined, undefined, auth), '/api/v1/orders/' + id + '/status', { status: 'packed' }), undefined, auth))
      .statusCode,
    409,
  );
  for (let n = 0; n < 2; n++)
    assert.equal(
      (await req('/api/v1/orders/' + id + '/scan', 'POST', { code: 'API-FLOW' }, undefined, auth))
        .statusCode,
      200,
    );
  await status('packed');
  assert.equal(
    (await req('/api/v1/orders/' + id + '/ship-demo', 'POST', {}, undefined, auth)).statusCode,
    200,
  );
  assert.equal(
    (await req('/api/v1/orders/' + id + '/documents', 'POST', { kind: 'invoice' }, undefined, auth))
      .statusCode,
    200,
  );
  await status('delivered');
  await status('completed');
  await status('return_initiated');
  await status('return_received');
  assert.equal(
    (
      await req(
        '/api/v1/orders/' + id + '/documents',
        'POST',
        { kind: 'correction' },
        undefined,
        auth,
      )
    ).statusCode,
    200,
  );
  await status('return_completed');
  while (await tick({ transport: localTransport })) {}
  const stock = (await req('/api/v1/inventory', 'GET', undefined, undefined, auth)).json().data[0];
  assert.equal(stock.on_hand, 5);
  assert.equal(stock.reserved, 0);
  const sent = (await req('/api/developer/webhooks', 'GET', undefined, a.cookie)).json();
  assert(sent.deliveries.length >= 10);
  assert(sent.deliveries.every((d: any) => d.state === 'delivered'));
  assert.equal(sent.deliveries.length, sent.inbox.length);
  assert(sent.inbox.every((i: any) => i.payload.organization_id === a.user.tenant_id));
  assert(!JSON.stringify(sent.inbox).includes('buyer@example.test'));
  assert.equal(
    (await pool.query('SELECT secret FROM outbound_subscriptions WHERE id=$1', [s.id])).rows[0]
      .secret === s.secret,
    false,
  );
});
test('cursor publicznego API przechodzi między stronami bez obcego tenanta', async () => {
  const a = await owner(),
    k = await key(a),
    p = await product(a);
  for (let n = 0; n < 3; n++)
    await req('/api/v1/orders', 'POST', order(p), undefined, {
      ...bearer(k.token),
      'idempotency-key': randomUUID(),
    });
  const first = (
    await req('/api/v1/orders?limit=2', 'GET', undefined, undefined, bearer(k.token))
  ).json();
  assert.equal(first.data.length, 2);
  const second = (
    await req(
      '/api/v1/orders?limit=2&after=' + encodeURIComponent(first.meta.cursor),
      'GET',
      undefined,
      undefined,
      bearer(k.token),
    )
  ).json();
  assert.equal(second.data.length, 1);
  assert(!first.data.some((o: any) => o.id === second.data[0].id));
});
test('disabled webhook nie zapisuje zdarzeń; włączenie wymaga dokładnego odbiorcy', async () => {
  const a = await owner(),
    s = await hook(a, ['order.created'], false),
    p = await product(a);
  await req('/api/orders', 'POST', order(p), a.cookie);
  assert.equal(
    (await pool.query('SELECT 1 FROM outbound_events WHERE tenant_id=$1', [a.user.tenant_id]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await req(
        '/api/developer/webhooks/' + s.id + '/enable',
        'POST',
        { confirm_destination: 'wrong' },
        a.cookie,
      )
    ).statusCode,
    422,
  );
});
test('podpis obejmuje surowe bajty i czas, odrzuca zmianę treści i replay po 5 minutach', () => {
  const secret = 'test',
    body = Buffer.from('{"a":1}'),
    ts = Math.floor(Date.now() / 1000),
    sig = signWebhook(secret, body, ts);
  verifyWebhook(secret, body, String(ts), sig);
  assert.throws(() => verifyWebhook(secret, Buffer.from('{ "a":1}'), String(ts), sig));
  assert.throws(() => verifyWebhook(secret, body, String(ts), sig, (ts + 301) * 1000));
  assert.throws(() => verifyWebhook(secret, body, String(ts), 'bad'));
});
test('lokalny odbiorca weryfikuje HTTP/podpis i deduplikuje tę samą dostawę', async () => {
  const a = await owner(),
    s = await hook(a),
    p = await product(a);
  await req('/api/orders', 'POST', order(p), a.cookie);
  const d = await delivery(a),
    ts = Math.floor(Date.now() / 1000),
    headers = {
      'content-type': 'application/json',
      'x-dyna-timestamp': String(ts),
      'x-dyna-signature': signWebhook(s.secret, d.body, ts),
      'x-dyna-delivery-id': d.id,
      'x-dyna-event-id': d.event_id,
    };
  const url = '/api/local-webhooks/' + s.id;
  assert.equal(
    (
      await req(url, 'POST', d.body, undefined, {
        ...headers,
        'x-dyna-signature': 'v1=' + '0'.repeat(64),
      })
    ).statusCode,
    401,
  );
  const first = await req(url, 'POST', d.body, undefined, headers);
  assert.equal(first.statusCode, 202, first.body);
  const again = await req(url, 'POST', d.body, undefined, headers);
  assert.equal(again.statusCode, 202);
  assert.equal(again.json().duplicate, true);
  assert.equal(
    (await pool.query('SELECT 1 FROM local_webhook_inbox WHERE delivery_id=$1', [d.id])).rowCount,
    1,
  );
});
test('brak stanu cofa także zdarzenie i dostawę webhooka', async () => {
  const a = await owner();
  await hook(a);
  const p = await product(a);
  const b = { ...order(p), items: [{ product_id: p.id, quantity: 101 }] };
  assert.equal((await req('/api/orders', 'POST', b, a.cookie)).statusCode, 409);
  assert.equal(
    (await pool.query('SELECT 1 FROM outbound_events WHERE tenant_id=$1', [a.user.tenant_id]))
      .rowCount,
    0,
  );
});
test('retry 500 zachowuje identyfikator i body; późniejszy ACK zapisuje sukces', async () => {
  const a = await owner();
  await hook(a);
  const p = await product(a);
  await req('/api/orders', 'POST', order(p), a.cookie);
  const d = await delivery(a);
  let calls: any[] = [];
  const failed: Transport = async (_u, init) => {
    calls.push(init);
    return new Response('private error', { status: 500 });
  };
  await run(d, failed);
  assert.equal((await delivery(a)).state, 'queued');
  assert(!JSON.stringify(await delivery(a)).includes('private error'));
  await run(d, async (u, init) => {
    calls.push(init);
    return localTransport(u, init);
  });
  assert.equal((await delivery(a)).state, 'delivered');
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['X-Dyna-Delivery-ID'], calls[1].headers['X-Dyna-Delivery-ID']);
});
test('429 szanuje Retry-After, trwałe 400 nie jest automatycznie ponawiane', async () => {
  const a = await owner();
  await hook(a);
  const p = await product(a);
  await req('/api/orders', 'POST', order(p), a.cookie);
  const d = await delivery(a);
  await run(d, async () => new Response(null, { status: 429, headers: { 'retry-after': '600' } }));
  const j = (
    await pool.query('SELECT extract(epoch from run_at-now()) AS delay FROM jobs WHERE id=$1', [
      d.job_id,
    ])
  ).rows[0];
  assert(Number(j.delay) > 590);
  await run(d, async () => new Response(null, { status: 400 }));
  assert.equal((await delivery(a)).state, 'failed');
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [d.job_id])).rows[0].state,
    'failed',
  );
});
test('pause cancels pending delivery; ręczne ponowienie po włączeniu używa tego samego ID', async () => {
  const a = await owner(),
    s = await hook(a),
    p = await product(a);
  await req('/api/orders', 'POST', order(p), a.cookie);
  const d = await delivery(a);
  await req('/api/developer/webhooks/' + s.id + '/disable', 'POST', {}, a.cookie);
  let calls = 0;
  await run(d, async () => {
    calls++;
    return new Response(null, { status: 200 });
  });
  assert.equal(calls, 0);
  assert.equal((await delivery(a)).state, 'cancelled');
  await req(
    '/api/developer/webhooks/' + s.id + '/enable',
    'POST',
    { confirm_destination: 'local' },
    a.cookie,
  );
  assert.equal(
    (await req('/api/developer/deliveries/' + d.id + '/retry', 'POST', {}, a.cookie)).statusCode,
    200,
  );
  await run(d);
  assert.equal((await delivery(a)).state, 'delivered');
  assert.equal(
    (await req('/api/developer/deliveries/' + d.id + '/retry', 'POST', {}, a.cookie)).statusCode,
    409,
  );
});
test('stary lease nie wysyła i nie nadpisuje statusu nowego workera', async () => {
  const a = await owner();
  await hook(a);
  const p = await product(a);
  await req('/api/orders', 'POST', order(p), a.cookie);
  const d = await delivery(a),
    old = await claim(d);
  await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [old.id, randomUUID()]);
  let calls = 0;
  await processOutbound(old, {
    transport: async () => {
      calls++;
      return new Response(null, { status: 200 });
    },
  });
  await failOutbound(old, new Error('stale'));
  assert.equal(calls, 0);
  assert.equal((await delivery(a)).state, 'queued');
  await run(d, async () => {
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [d.job_id, randomUUID()]);
    return new Response(null, { status: 200 });
  });
  assert.equal((await delivery(a)).state, 'queued');
});
test('odbiór po utracie ACK jest deduplikowany i zakończony przy retry', async () => {
  const a = await owner();
  await hook(a);
  const p = await product(a);
  await req('/api/orders', 'POST', order(p), a.cookie);
  const d = await delivery(a);
  await run(d, async (u, i) => {
    await localTransport(u, i);
    throw new Error('lost ack');
  });
  assert.equal((await delivery(a)).state, 'queued');
  await run(d);
  assert.equal((await delivery(a)).state, 'delivered');
  assert.equal(
    (await pool.query('SELECT 1 FROM local_webhook_inbox WHERE delivery_id=$1', [d.id])).rowCount,
    1,
  );
});
test('RLS chroni outbox/dostawy/skrzynkę, sekret nie występuje w podglądzie', async () => {
  const a = await owner(),
    b = await owner(),
    s = await hook(a),
    p = await product(a);
  await req('/api/orders', 'POST', order(p), a.cookie);
  const d = await delivery(a);
  await run(d);
  for (const table of [
    'outbound_events',
    'outbound_subscriptions',
    'outbound_deliveries',
    'local_webhook_inbox',
  ])
    assert.equal(
      (await tenantTx(b.user.tenant_id, (c) => c.query('SELECT * FROM ' + table))).rowCount,
      0,
    );
  const state = await req('/api/developer/webhooks', 'GET', undefined, a.cookie);
  assert(!state.body.includes(s.secret));
  assert.equal(
    (await req('/api/developer/webhooks/' + s.id + '/disable', 'POST', {}, b.cookie)).statusCode,
    404,
  );
  await assert.rejects(
    tenantTx(a.user.tenant_id, (c) => c.query('SELECT * FROM api_keys')),
    /permission denied/,
  );
});
test('HTTPS konfiguracja odrzuca prywatne URL, query i credentials, nie wysyła przed zatwierdzeniem', async () => {
  const a = await owner();
  for (const url of [
    'http://127.0.0.1:4100/',
    'https://127.0.0.1/',
    'https://example.org/?token=x',
    'https://u:p@example.org/',
  ])
    assert.equal(
      (
        await req(
          '/api/developer/webhooks',
          'POST',
          { name: 'Bad URL', mode: 'https', url, events: ['order.created'] },
          a.cookie,
        )
      ).statusCode,
      422,
    );
  const s = await hook(a, ['order.created'], false, 'https');
  assert.equal(s.enabled, false);
  assert.equal(
    (
      await req(
        '/api/developer/webhooks/' + s.id + '/enable',
        'POST',
        { confirm_destination: 'local' },
        a.cookie,
      )
    ).statusCode,
    422,
  );
});
