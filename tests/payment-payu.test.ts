import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Problem } from '../server/errors';
import { PayU, PAYU_ENDPOINTS, payuApiUrl, payuProblem, payuRedirectOk, type PayuOptions, type PayuOrderInput } from '../server/payment-payu';
import { createPayuFake, PAYU_FAKE_POS, PAYU_FAKE_SECRET, type PayuFake } from '../server/payment-payu-fake';
// All provider answers here are SYNTHETIC (fake or tests/fixtures/payu/*.json); no test touches the network.
const settings = { pos_id: PAYU_FAKE_POS };
const creds = { client_secret: PAYU_FAKE_SECRET };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/payu/${name}.json`, import.meta.url), 'utf8');
function setup(options: PayuOptions = {}, fake?: PayuFake) {
  let clock = Date.parse('2026-10-26T10:00:00Z');
  const f = fake ?? createPayuFake({ now: () => clock });
  const sleeps: number[] = [];
  const client = new PayU('sandbox', settings, creds, f.transport, {
    now: () => clock,
    timeoutMs: 30,
    sleep: async (ms) => sleeps.push(ms),
    ...options,
  });
  return { client, fake: f, sleeps, tick: (ms: number) => (clock += ms) };
}
const order = (over: Partial<PayuOrderInput> = {}): PayuOrderInput => ({
  extOrderId: 'sess-1',
  description: 'Zamówienie SYNTH-1',
  currency: 'PLN',
  amount: 12345,
  customerIp: '127.0.0.1',
  notifyUrl: 'https://sklep.example/api/public/payu/notify',
  continueUrl: 'https://sklep.example/zamowienie/abc',
  buyer: { email: 'kupujacy@example.invalid' },
  products: [{ name: 'Produkt syntetyczny', unitPrice: 12345, quantity: 1 }],
  ...over,
});
const problem = (status: number, code?: RegExp, message?: RegExp) => (e: unknown) =>
  e instanceof Problem && e.status === status && (!code || code.test(e.code ?? '')) && (!message || message.test(e.message));
const posts = (f: PayuFake, path = '/api/v2_1/orders') => f.calls.filter((c) => c.method === 'POST' && c.path === path).length;
async function paid(amount = 12345) {
  const s = setup();
  const created = await s.client.createOrder(order({ amount, products: [{ name: 'P', unitPrice: amount, quantity: 1 }] }));
  s.fake.setStatus(created.orderId, 'COMPLETED');
  return { ...s, orderId: created.orderId };
}

test('configuration: environment, POS, secret and host allow-list', () => {
  const t = createPayuFake().transport;
  assert.throws(() => new PayU('live', settings, creds, t), problem(422, undefined, /środowisko/));
  assert.throws(() => new PayU('sandbox', {}, creds, t), problem(422, undefined, /pos_id/));
  assert.throws(() => new PayU('sandbox', { pos_id: '12a' }, creds, t), problem(422, undefined, /pos_id/));
  assert.throws(() => new PayU('sandbox', settings, {}, t), problem(422, undefined, /client_secret/));
  assert.throws(() => new PayU('sandbox', settings, { client_secret: 'with space secret' }, t), problem(422));
  assert.equal(new PayU('sandbox', settings, creds, t).endpoint, 'https://secure.snd.payu.com');
  assert.equal(new PayU('production', settings, creds, t).endpoint, 'https://secure.payu.com');
  assert.deepEqual(PAYU_ENDPOINTS, { sandbox: 'https://secure.snd.payu.com', production: 'https://secure.payu.com' });
  assert.throws(() => payuApiUrl('sandbox', '/../x'), problem(422));
  assert.ok(payuRedirectOk('https://merch-prod.snd.payu.com/pay/?orderId=X', 'sandbox'));
  for (const bad of ['https://merch-prod.snd.payu.com/pay/', 'http://secure.payu.com/pay/', 'https://payu.com.evil.example/pay', 'https://u:p@secure.payu.com/pay'])
    assert.equal(payuRedirectOk(bad, 'production'), false, bad);
  assert.equal(payuRedirectOk('https://secure.payu.com/pay/?orderId=X', 'sandbox'), false);
});

test('connection: OAuth client_credentials token is cached until expiry and refreshed after', async () => {
  const { client, fake, tick } = setup();
  const first = await client.test();
  assert.equal(first.environment, 'sandbox');
  assert.equal(first.pos_id, PAYU_FAKE_POS);
  await client.accessToken();
  await client.accessToken();
  assert.equal(fake.calls.filter((c) => c.path.endsWith('/oauth/authorize')).length, 1);
  tick(43199 * 1000 - 30_000); // inside the 60 s skew: refresh before PayU would reject it
  await client.accessToken();
  assert.equal(fake.calls.filter((c) => c.path.endsWith('/oauth/authorize')).length, 2);
});

test('connection: concurrent callers share one token request; bad secret maps to 401 in Polish', async () => {
  const { client, fake } = setup();
  await Promise.all([client.accessToken(), client.accessToken(), client.accessToken()]);
  assert.equal(fake.calls.length, 1);
  const bad = new PayU('sandbox', settings, { client_secret: 'wrong-secret-123' }, createPayuFake().transport, { sleep: async () => {} });
  await assert.rejects(bad.test(), problem(401, /^PAYU_AUTH:invalid_client$/, /client_secret/));
});

test('token rejected by the API (expired early) is dropped and the call repeated once with a new token', async () => {
  const { client, fake } = setup();
  await client.accessToken();
  fake.revokeTokens();
  const created = await client.createOrder(order());
  assert.match(created.orderId, /^SYNTH/);
  assert.equal(fake.calls.filter((c) => c.path.endsWith('/oauth/authorize')).length, 2);
  assert.equal(posts(fake), 2); // first POST refused with 401 before processing, second accepted
  assert.equal(fake.orders.size, 1);
});

test('order.create: redirect payment returns redirectUri and orderId; body carries POS, grosze and extOrderId', async () => {
  const { client, fake } = setup();
  const created = await client.createOrder(order({ currency: 'EUR', buyer: { email: 'k@example.invalid', firstName: 'Anna', language: 'en' } }));
  assert.equal(created.extOrderId, 'sess-1');
  assert.equal(created.status, 'NEW');
  assert.equal(created.recovered, false);
  assert.match(created.redirectUri!, /^https:\/\/merch-prod\.snd\.payu\.com\/pay\//);
  const stored = fake.orders.get(created.orderId)!;
  assert.equal(stored.request.merchantPosId, PAYU_FAKE_POS);
  assert.equal(stored.request.totalAmount, '12345');
  assert.equal(stored.request.currencyCode, 'EUR');
  assert.equal(stored.request.products[0].unitPrice, '12345');
  assert.equal(stored.request.notifyUrl, 'https://sklep.example/api/public/payu/notify');
  assert.equal(stored.request.continueUrl, 'https://sklep.example/zamowienie/abc');
});

test('order.create refuses invalid input before any request', async () => {
  const { client, fake } = setup();
  await assert.rejects(client.createOrder(order({ amount: 12000 })), problem(422, /PAYU_INPUT/, /Suma produktów/));
  await assert.rejects(client.createOrder(order({ currency: 'USD' as 'PLN' })), problem(422, /PAYU_INPUT/, /PLN i EUR/));
  await assert.rejects(client.createOrder(order({ notifyUrl: 'http://sklep.example/n' })), problem(422, /PAYU_INPUT/));
  await assert.rejects(client.createOrder(order({ amount: 0, products: [{ name: 'P', unitPrice: 0, quantity: 1 }] })), problem(422));
  await assert.rejects(client.createOrder(order({ extOrderId: 'bad id/1' })), problem(422, /PAYU_INPUT/));
  assert.equal(fake.calls.length, 0);
});

test('idempotency by extOrderId: same body replays without a request, a different body is a conflict', async () => {
  const { client, fake } = setup();
  const first = await client.createOrder(order());
  const again = await client.createOrder(order());
  assert.deepEqual({ ...again, replayed: false }, first);
  assert.equal(again.replayed, true);
  assert.equal(posts(fake), 1);
  await assert.rejects(client.createOrder(order({ description: 'Inny opis' })), problem(409, undefined, /extOrderId/));
  assert.equal(fake.orders.size, 1);
});

test('lost response on create: looked up by extOrderId, never re-created', async () => {
  for (const kind of ['commit_then_hang', 'commit_then_500'] as const) {
    const { client, fake } = setup();
    fake.fail({ kind }, 'POST /api/v2_1/orders');
    const created = await client.createOrder(order());
    assert.equal(created.recovered, true, kind);
    assert.equal(created.redirectUri, null);
    assert.equal(created.status, 'NEW');
    assert.equal(posts(fake), 1, kind);
    assert.equal(fake.orders.size, 1);
    assert.ok(fake.calls.some((c) => c.method === 'GET' && c.path === '/api/v2_1/orders/ext/sess-1'));
    const replay = await client.createOrder(order());
    assert.equal(replay.replayed, true);
    assert.equal(posts(fake), 1);
  }
});

test('lost response before PayU stored anything: absent is reported, the key stays blocked for a new attempt', async () => {
  const { client, fake } = setup();
  fake.fail({ kind: 'throw' }, 'POST /api/v2_1/orders');
  await assert.rejects(client.createOrder(order()), problem(409, /PAYU_RECONCILE_ABSENT/));
  await assert.rejects(client.createOrder(order()), problem(409, /PAYU_RECONCILE_ABSENT/));
  assert.equal(posts(fake), 1);
  const next = await client.createOrder(order({ extOrderId: 'sess-1-a2' }));
  assert.equal(next.recovered, false);
});

test('ERROR_ORDER_NOT_UNIQUE from PayU (key used by another process) is reconciled by lookup and amount check', async () => {
  const fake = createPayuFake();
  const other = setup({}, fake).client;
  const mine = setup({}, fake).client;
  const theirs = await other.createOrder(order());
  const recovered = await mine.createOrder(order());
  assert.equal(recovered.orderId, theirs.orderId);
  assert.equal(recovered.recovered, true);
  const third = setup({}, fake).client;
  await assert.rejects(
    third.createOrder(order({ amount: 999, products: [{ name: 'P', unitPrice: 999, quantity: 1 }] })),
    problem(409, /PAYU_AMOUNT_MISMATCH/),
  );
  assert.equal(fake.orders.size, 1);
});

test('error mapping: 401/403/429/5xx in Polish; reads retried with Retry-After, mutations sent once', async () => {
  const e = (s: number, body: unknown = {}) => payuProblem(s, body);
  assert.match(e(401).message, /uwierzytelniające/);
  assert.equal(e(403).status, 403);
  assert.match(e(403).message, /odmówił dostępu/);
  assert.equal(e(429).status, 429);
  assert.match(e(429).message, /ograniczył/);
  assert.equal(e(503).status, 502);
  assert.match(e(503).message, /niedostępny \(HTTP 503\)/);
  assert.equal(e(400, { status: { statusCode: 'ERROR_VALUE_INVALID', statusDesc: '<script>' } }).code, 'PAYU_VALIDATION:ERROR_VALUE_INVALID');
  assert.equal(e(400, { status: { statusCode: 'x y<z>' } }).code, 'PAYU_VALIDATION:unknown');
  assert.equal(e(404).status, 404);
  assert.equal(e(400, JSON.parse(fixture('error-not-unique'))).status, 409);

  const read = setup();
  const created = await read.client.createOrder(order());
  read.fake.fail({ kind: 'http', status: 429, retryAfter: '2' }, 'GET');
  read.fake.fail({ kind: 'http', status: 503 }, 'GET');
  assert.equal((await read.client.order(created.orderId)).status, 'NEW');
  assert.deepEqual(read.sleeps, [2000, 500]);
  for (const status of [429, 503, 500]) {
    const s = setup();
    s.fake.fail({ kind: 'http', status }, 'GET');
    s.fake.fail({ kind: 'http', status }, 'GET');
    s.fake.fail({ kind: 'http', status }, 'GET');
    await assert.rejects(s.client.order('SYNTH000001GUEST000P01'), problem(status === 429 ? 429 : 502));
  }
  const forbidden = setup();
  forbidden.fake.fail({ kind: 'http', status: 403, body: { status: { statusCode: 'UNAUTHORIZED_REQUEST' } } }, 'GET');
  await assert.rejects(forbidden.client.order('SYNTH000001GUEST000P01'), problem(403, /PAYU_FORBIDDEN/));
  assert.equal(forbidden.fake.calls.filter((c) => c.method === 'GET').length, 1);

  const write = setup();
  write.fake.fail({ kind: 'http', status: 429 }, 'POST /api/v2_1/orders');
  await assert.rejects(write.client.createOrder(order()), problem(429, /PAYU_RATE_LIMIT/));
  assert.equal(posts(write.fake), 1);
  assert.deepEqual(write.sleeps, []);
  const again = await write.client.createOrder(order()); // definite 4xx refusal released the key
  assert.equal(again.recovered, false);
  const down = setup();
  down.fake.fail({ kind: 'http', status: 503 }, 'POST /api/v2_1/orders');
  await assert.rejects(down.client.createOrder(order()), problem(409, /PAYU_RECONCILE_ABSENT/));
  assert.equal(posts(down.fake), 1);
});

test('timeouts, redirects and garbage are explicit; garbage after a mutation is uncertain', async () => {
  const hang = setup();
  hang.fake.fail({ kind: 'hang' }, 'GET');
  hang.fake.fail({ kind: 'hang' }, 'GET');
  hang.fake.fail({ kind: 'hang' }, 'GET');
  await assert.rejects(hang.client.order('SYNTH000001GUEST000P01'), problem(504, /PAYU_TIMEOUT/));
  const redirect = setup();
  redirect.fake.fail({ kind: 'raw', status: 301, body: '' }, 'GET');
  await assert.rejects(redirect.client.order('SYNTH000001GUEST000P01'), problem(502, /PAYU_REDIRECT/));
  const garbage = setup();
  garbage.fake.fail({ kind: 'raw', status: 200, body: '<html>' }, 'GET');
  garbage.fake.fail({ kind: 'raw', status: 200, body: '<html>' }, 'GET');
  await assert.rejects(garbage.client.order('SYNTH000001GUEST000P01'), problem(502, /PAYU_INVALID_RESPONSE/));
  const lost = setup();
  lost.fake.fail({ kind: 'raw', status: 302, body: '{"status":' }, 'POST /api/v2_1/orders');
  await assert.rejects(lost.client.createOrder(order()), problem(409, /PAYU_RECONCILE_ABSENT/));
});

test('order.status reads status, amount, currency and PAYMENT_ID; foreign host is never contacted', async () => {
  const { client, fake } = setup();
  const created = await client.createOrder(order());
  fake.setStatus(created.orderId, 'COMPLETED');
  const view = await client.order(created.orderId);
  assert.equal(view.status, 'COMPLETED');
  assert.equal(view.amount, 12345);
  assert.equal(view.currency, 'PLN');
  assert.match(view.paymentId!, /^\d+$/);
  await assert.rejects(client.order('SYNTH999999GUEST000P01'), problem(404, /PAYU_NOT_FOUND/));
  await assert.rejects(client.order('../x'), problem(422));
  assert.deepEqual(await client.ordersByExtOrderId('missing'), []);
  assert.ok(fake.calls.every((c) => c.path.startsWith('/')));
  const prod = new PayU('production', settings, creds, fake.transport, { sleep: async () => {} });
  await assert.rejects(prod.test(), problem(504)); // fake refuses anything but its sandbox host
});

test('order.cancel: only before completion, idempotent, lost answer reconciled by reading the status', async () => {
  const { client, fake } = setup();
  const a = await client.createOrder(order());
  assert.deepEqual(await client.cancel(a.orderId), { orderId: a.orderId, status: 'CANCELED', recovered: false });
  assert.deepEqual(await client.cancel(a.orderId), { orderId: a.orderId, status: 'CANCELED', recovered: true });
  const b = await client.createOrder(order({ extOrderId: 'sess-2' }));
  fake.fail({ kind: 'commit_then_hang' }, 'DELETE');
  assert.equal((await client.cancel(b.orderId)).recovered, true);
  const c = await client.createOrder(order({ extOrderId: 'sess-3' }));
  fake.setStatus(c.orderId, 'COMPLETED');
  await assert.rejects(client.cancel(c.orderId), problem(409, undefined, /zwrotu/));
  assert.equal(fake.calls.filter((x) => x.method === 'DELETE').length, 2);
});

test('refund.create: partial then full remainder; refund.status reads PENDING then FINALIZED', async () => {
  const { client, fake, orderId } = await paid(10000);
  const part = await client.refund(orderId, { extRefundId: 'ret-1', description: 'Zwrot części', currency: 'PLN', amount: 2500 });
  assert.equal(part.amount, 2500);
  assert.equal(part.status, 'PENDING');
  assert.equal(part.replayed, false);
  const rest = await client.refund(orderId, { extRefundId: 'ret-2', description: 'Zwrot reszty', currency: 'PLN' });
  assert.equal(rest.amount, 7500);
  fake.finalizeRefund(orderId, part.refundId);
  assert.equal((await client.refundStatus(orderId, part.refundId)).status, 'FINALIZED');
  assert.deepEqual((await client.refunds(orderId)).map((r) => r.amount), [2500, 7500]);
});

test('refund over the captured amount, of an unpaid order or in another currency is refused without a POST', async () => {
  const { client, fake, orderId } = await paid(10000);
  await client.refund(orderId, { extRefundId: 'ret-1', description: 'Zwrot', currency: 'PLN', amount: 6000 });
  await assert.rejects(
    client.refund(orderId, { extRefundId: 'ret-2', description: 'Zwrot', currency: 'PLN', amount: 4001 }),
    problem(422, /PAYU_REFUND_EXCEEDS/),
  );
  await assert.rejects(client.refund(orderId, { extRefundId: 'ret-3', description: 'Zwrot', currency: 'EUR', amount: 1 }), problem(422, undefined, /Waluta/));
  const fresh = await client.createOrder(order({ extOrderId: 'sess-unpaid' }));
  await assert.rejects(client.refund(fresh.orderId, { extRefundId: 'ret-4', description: 'Zwrot', currency: 'PLN', amount: 1 }), problem(409));
  assert.equal(posts(fake, `/api/v2_1/orders/${orderId}/refunds`), 1);
  // PayU's own refusal is mapped too (e.g. a refund created elsewhere in the meantime).
  fake.fail({ kind: 'http', status: 400, body: { status: { statusCode: 'OPENPAYU_BUSINESS_ERROR', codeLiteral: 'REFUND_AMOUNT_TOO_HIGH' } } }, 'POST');
  await assert.rejects(
    client.refund(orderId, { extRefundId: 'ret-5', description: 'Zwrot', currency: 'PLN', amount: 100 }),
    problem(422, /PAYU_REFUND_REJECTED/),
  );
});

test('refund is replay-safe by extRefundId, including a lost answer', async () => {
  const { client, fake, orderId } = await paid(10000);
  fake.fail({ kind: 'commit_then_hang' }, 'POST /api/v2_1/orders/');
  const lost = await client.refund(orderId, { extRefundId: 'ret-1', description: 'Zwrot', currency: 'PLN', amount: 1000 });
  assert.equal(lost.replayed, true);
  assert.equal(lost.amount, 1000);
  const again = await client.refund(orderId, { extRefundId: 'ret-1', description: 'Zwrot', currency: 'PLN', amount: 1000 });
  assert.equal(again.refundId, lost.refundId);
  await assert.rejects(client.refund(orderId, { extRefundId: 'ret-1', description: 'Zwrot', currency: 'PLN', amount: 999 }), problem(409));
  assert.equal(fake.refunds.get(orderId)!.length, 1);
});

test('SYNTHETIC fixtures from the public docs parse through the client', async () => {
  const served: string[] = ['token', 'order-create-302'];
  const statuses: Record<string, number> = { 'order-create-302': 302 };
  const client = new PayU('sandbox', settings, creds, async () => {
    const name = served.shift()!;
    return new Response(fixture(name), { status: statuses[name] ?? 200 });
  }, { sleep: async () => {} });
  const created = await client.createOrder(order({ extOrderId: 'sess-fixture-1' }));
  assert.equal(created.orderId, 'FIXT9ZZ1ABC251026GUEST000P01');
  served.push('order-retrieve-completed');
  const view = await client.order('FIXT9ZZ1ABC251026GUEST000P01');
  assert.deepEqual([view.status, view.amount, view.paymentId], ['COMPLETED', 12345, '7000000001']);
  served.push('error-oauth-invalid-client');
  const other = new PayU('sandbox', settings, creds, async () => new Response(fixture(served.shift()!), { status: 401 }), { sleep: async () => {} });
  await assert.rejects(other.test(), problem(401, /PAYU_AUTH/));
  const refundClient = new PayU('sandbox', settings, creds, async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/authorize')) return new Response(fixture('token'));
    if (init.method === 'GET' && u.pathname.endsWith('/refunds')) return new Response('{"refunds":[]}');
    if (init.method === 'GET') return new Response(fixture('order-retrieve-completed'));
    return new Response(fixture('refund-create'));
  }, { sleep: async () => {} });
  const r = await refundClient.refund('FIXT9ZZ1ABC251026GUEST000P01', { extRefundId: 'ret-fixture-1', description: 'Zwrot', currency: 'PLN', amount: 2345 });
  assert.deepEqual([r.refundId, r.status, r.amount], ['5000001', 'PENDING', 2345]);
});
