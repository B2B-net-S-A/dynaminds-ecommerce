// SMSAPI live send (sms.send) and delivery callback (sms.delivery.callback) local contracts.
// Fake transport and in-memory auth/tenant ports only: no request leaves the process, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { sendSmsApiLive, SmsLiveRejected, SmsLiveUnknown, type SmsLiveRequest } from '../server/sms-live-transport';
import {
  newSmsApiCallbackToken,
  requireSmsApiCallbackToken,
  smsApiNotifyUrl,
  SMSAPI_CALLBACK_IPS,
  SMSAPI_CALLBACK_TOKEN,
  DeliveryRefusal,
  type DeliveryEvent,
} from '../server/sms-delivery';
import { registerSmsDeliveryCallbacks } from '../server/sms-delivery-routes';
import { registerSmsSubmissionRoutes } from '../server/sms-submission-routes';
import { decrypt, encrypt } from '../server/security';

const TOKEN = 'smsapi-oauth-token-secret';
const SMSAPI_IP = SMSAPI_CALLBACK_IPS[0];
const message = (over: Partial<SmsLiveRequest> = {}): SmsLiveRequest => ({
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  recipient: '48500500500',
  payload: 'Zamówienie wysłane',
  sender: 'Dynaminds',
  max_parts: 2,
  callbackUrl: 'https://app.example/callbacks/smsapi/0f8fad5b-d9cb-469f-a165-70867728950e/' + 'a'.repeat(43),
  ...over,
});
const accepted = (over: Record<string, unknown> = {}) => ({
  count: 1,
  list: [{ id: '1460969715572091219', points: 0.16, number: '48500500500', date_sent: 1761400000, status: 'QUEUE', ...over }],
});
function fake(...replies: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = replies.shift();
    assert.ok(next, 'nieoczekiwane dodatkowe wywołanie SMSAPI');
    return next();
  };
  return { calls, transport };
}
const json = (value: unknown, status = 200) => () => Response.json(value, { status });

test('sms.send: dokładnie jeden POST /sms.do z Bearer, idx, check_idx i notify_url z tokenem; paragon z odpowiedzi', async () => {
  const f = fake(json(accepted()));
  const m = message();
  const receipt = await sendSmsApiLive(TOKEN, m, f.transport);
  assert.equal(f.calls.length, 1);
  const [{ url, init }] = f.calls;
  assert.equal(url, 'https://api.smsapi.pl/sms.do');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, {
    Authorization: 'Bearer ' + TOKEN,
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  const body = Object.fromEntries(new URLSearchParams(String(init.body)));
  assert.deepEqual(body, {
    to: '48500500500',
    message: 'Zamówienie wysłane',
    from: 'Dynaminds',
    idx: m.id.replaceAll('-', ''),
    check_idx: '1',
    format: 'json',
    encoding: 'utf-8',
    max_parts: '2',
    notify_url: m.callbackUrl,
  });
  assert.equal('test' in body, false, 'live wysyłka nie może mieć test=1');
  assert.deepEqual(receipt, {
    providerId: '1460969715572091219',
    idx: m.id.replaceAll('-', ''),
    recipient: '48500500500',
    providerSentAt: 1761400000,
    status: 'QUEUE',
    points: 0.16,
  });
});

test('sms.send: nieprawidłowy zakres odrzucany przed jakimkolwiek wywołaniem', async () => {
  for (const [token, over] of [
    ['', {}],
    [TOKEN, { callbackUrl: 'http://app.example/callbacks/smsapi/x' }],
    [TOKEN, { recipient: '+48500500500' }],
    [TOKEN, { max_parts: 11 }],
    [TOKEN, { id: 'not-a-uuid' }],
    [TOKEN, { sender: 'Za długi nadawca' }],
    [TOKEN, { payload: '' }],
  ] as [string, Partial<SmsLiveRequest>][]) {
    const f = fake();
    await assert.rejects(sendSmsApiLive(token, message(over), f.transport), (e: Error) => !(e instanceof SmsLiveUnknown));
    assert.equal(f.calls.length, 0);
  }
});

test('sms.send: kod błędu SMSAPI -> odrzucenie; 53 (duplikat idx) i odpowiedzi niejednoznaczne -> niepewne, zawsze jeden POST', async () => {
  const rejected = fake(json({ error: 13, message: 'Invalid number' }));
  await assert.rejects(sendSmsApiLive(TOKEN, message(), rejected.transport), (e: unknown) => e instanceof SmsLiveRejected && e.providerCode === 13);
  assert.equal(rejected.calls.length, 1);
  const cases: (() => Response | Promise<Response>)[] = [
    json({ error: 53, message: 'idx already used' }),
    json({ error: 'busy' }, 429),
    json({}, 500),
    () => new Response('<html>', { status: 200 }),
    () => new Response('x'.repeat(70000), { status: 200 }),
    json(accepted({ number: '48600600600' })),
    json(accepted({ date_sent: 0 })),
    json(accepted({ id: 'a,b' })),
    json({ ...accepted(), count: 2 }),
    () => Promise.reject(new Error('socket hang up')),
  ];
  for (const reply of cases) {
    const f = fake(reply);
    await assert.rejects(sendSmsApiLive(TOKEN, message(), f.transport), SmsLiveUnknown);
    assert.equal(f.calls.length, 1, 'niepewny wynik nigdy nie ponawia POST');
  }
});

test('token callbacku: 32 losowe bajty base64url, porównanie stałoczasowe, brak tokenu = odmowa', () => {
  const a = newSmsApiCallbackToken(), b = newSmsApiCallbackToken();
  assert.match(a, SMSAPI_CALLBACK_TOKEN);
  assert.notEqual(a, b);
  requireSmsApiCallbackToken(a, a);
  for (const [expected, presented] of [[a, b], [a, a.slice(0, 42)], [a, a + 'x'], [null, a], [undefined, a], ['short', 'short'], [a, undefined]])
    assert.throws(() => requireSmsApiCallbackToken(expected, presented), (e: unknown) => e instanceof DeliveryRefusal && e.status === 404);
  assert.equal(smsApiNotifyUrl('https://app.example/callbacks/smsapi/id', a), 'https://app.example/callbacks/smsapi/id/' + a);
  assert.throws(() => smsApiNotifyUrl('https://app.example/callbacks/smsapi/id', undefined), (e: unknown) => e instanceof DeliveryRefusal && e.status === 409);
});

const ENDPOINT = '3b241101-e2bb-4255-8caf-4136c566a962';
const report = (over: Record<string, string> = {}) => ({
  MsgId: '1460969715572091219',
  status: '404',
  status_name: 'DELIVERED',
  sent_at: '1761400000',
  donedate: '1761400060',
  username: 'konto@sklep.pl',
  to: '48500500500',
  idx: '0f8fad5b' + 'd9cb469fa16570867728950e',
  ...over,
});
type Endpoint = { id: string; tenantId: string; channelId: string; account: string; enabled: boolean; callbackToken: string | null };
async function callbackApp(endpoint: Endpoint | null, opts: { readOnly?: boolean; fail?: boolean } = {}) {
  const app = Fastify();
  const resolved: string[] = [], reconciled: DeliveryEvent[][] = [];
  registerSmsDeliveryCallbacks(app, {
    readOnly: opts.readOnly ?? false,
    resolveEndpoint: async id => (resolved.push(id), endpoint && endpoint.id === id ? endpoint : null),
    reconcile: async (_e, events) => {
      if (opts.fail) throw new Error('db down: konto@sklep.pl 48500500500');
      reconciled.push(events);
    },
  });
  await app.ready();
  return { app, resolved, reconciled };
}
const get = (app: FastifyInstance, path: string, query: Record<string, string>, remoteAddress: string = SMSAPI_IP) =>
  app.inject({ method: 'GET', url: path + '?' + new URLSearchParams(query), remoteAddress });

test('sms.delivery.callback: poprawny token i IP SMSAPI -> OK i jedno uzgodnienie partii raportów', async () => {
  const token = newSmsApiCallbackToken();
  const ep = { id: ENDPOINT, tenantId: randomUUID(), channelId: randomUUID(), account: 'konto@sklep.pl', enabled: true, callbackToken: token };
  const { app, reconciled } = await callbackApp(ep);
  const r = await get(app, `/callbacks/smsapi/${ENDPOINT}/${token}`, report());
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, 'OK');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(reconciled.length, 1);
  assert.deepEqual(reconciled[0], [{
    providerId: '1460969715572091219', code: 404, sentAt: 1761400000, doneAt: 1761400060,
    account: 'konto@sklep.pl', recipient: '48500500500', idx: report().idx,
  }]);
  // POST form, IPv4-mapped peer, batch of two reports.
  const two = report({ MsgId: 'a1,a2', status: '403,404', status_name: 'SENT,DELIVERED', sent_at: '1761400000,1761400000', donedate: '0,1761400060', username: 'konto@sklep.pl,konto@sklep.pl', to: '48500500500,48500500501', idx: 'x1,x2' });
  const p = await app.inject({ method: 'POST', url: `/callbacks/smsapi/${ENDPOINT}/${token}`, remoteAddress: '::ffff:' + SMSAPI_IP,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(two).toString() });
  assert.equal(p.statusCode, 200, p.body);
  assert.deepEqual(reconciled[1].map(e => [e.providerId, e.code]), [['a1', 403], ['a2', 404]]);
  await app.close();
});

test('sms.delivery.callback: zły, brakujący lub stary URL bez tokenu -> 404 bez uzgodnienia; obcy IP -> 403 przed odczytem endpointu', async () => {
  const token = newSmsApiCallbackToken();
  const ep = { id: ENDPOINT, tenantId: randomUUID(), channelId: randomUUID(), account: 'konto@sklep.pl', enabled: true, callbackToken: token };
  const { app, resolved, reconciled } = await callbackApp(ep);
  for (const path of [
    `/callbacks/smsapi/${ENDPOINT}/${newSmsApiCallbackToken()}`,
    `/callbacks/smsapi/${ENDPOINT}/${token.slice(0, 42)}`,
    `/callbacks/smsapi/${ENDPOINT}`,
    `/callbacks/smsapi/${randomUUID()}/${token}`,
  ]) {
    const r = await get(app, path, report());
    assert.equal(r.statusCode, 404, path);
    assert.equal(r.body, 'Callback not acknowledged');
    assert(!r.body.includes(token));
  }
  // Malformed token is refused before the endpoint lookup.
  const before = resolved.length;
  assert.equal((await get(app, `/callbacks/smsapi/${ENDPOINT}/short`, report())).statusCode, 404);
  assert.equal((await get(app, `/callbacks/smsapi/${ENDPOINT}`, report())).statusCode, 404);
  assert.equal(resolved.length, before);
  // Correct token from a foreign peer: IP check first, no lookup.
  for (const ip of ['127.0.0.1', '10.0.0.5', '89.174.81.99']) {
    const r = await get(app, `/callbacks/smsapi/${ENDPOINT}/${token}`, report(), ip);
    assert.equal(r.statusCode, 403, ip);
  }
  const spoof = await app.inject({ method: 'GET', url: `/callbacks/smsapi/${ENDPOINT}/${token}?` + new URLSearchParams(report()),
    remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': SMSAPI_IP } });
  assert.equal(spoof.statusCode, 403);
  assert.equal(resolved.length, before);
  assert.equal(reconciled.length, 0);
  await app.close();
});

test('sms.delivery.callback: endpoint bez tokenu, wyłączony, tryb odczytu, zły raport i błąd zapisu -> brak ACK', async () => {
  const token = newSmsApiCallbackToken();
  const base = { id: ENDPOINT, tenantId: randomUUID(), channelId: randomUUID(), account: 'konto@sklep.pl', enabled: true, callbackToken: token };
  const url = `/callbacks/smsapi/${ENDPOINT}/${token}`;
  for (const [ep, opts, status] of [
    [{ ...base, callbackToken: null }, {}, 404],
    [{ ...base, enabled: false }, {}, 404],
    [base, { readOnly: true }, 423],
    [base, { fail: true }, 503],
  ] as [Endpoint, { readOnly?: boolean; fail?: boolean }, number][]) {
    const { app, reconciled } = await callbackApp(ep, opts);
    const r = await get(app, url, report());
    assert.equal(r.statusCode, status);
    assert.equal(r.body, 'Callback not acknowledged');
    assert(!r.body.includes('48500500500') && !r.body.includes('konto@sklep.pl'));
    assert.equal(reconciled.length, 0);
    await app.close();
  }
  const { app, reconciled } = await callbackApp(base);
  for (const bad of [report({ status: '999' }), report({ status_name: 'SENT' }), report({ to: 'abc' }), report({ donedate: '0' })])
    assert.equal((await get(app, url, bad)).statusCode, 422);
  const wrongType = await app.inject({ method: 'POST', url, remoteAddress: SMSAPI_IP, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(report()) });
  assert.equal(wrongType.statusCode, 415);
  assert.equal(reconciled.length, 0);
  await app.close();
});

test('konfiguracja live: token callbacku tylko w zaszyfrowanych danych kanału, URL bazowy bez sekretu, callback działa przez prawdziwy resolver', async () => {
  const tenantId = randomUUID(), userId = randomUUID(), session = 'sess-' + randomUUID();
  const stored: { channels: any[]; endpoints: any[] } = { channels: [], endpoints: [] };
  const submissionLookups: unknown[][] = [];
  const auth = {
    query: async (sql: string, params: any[]) => {
      if (sql.includes('FROM sessions s')) {
        assert.equal(params[0], createHash('sha256').update(session).digest('hex'));
        return { rows: [{ user_id: userId }] };
      }
      if (sql.includes('FROM sms_delivery_endpoints e')) {
        const e = stored.endpoints.find(x => x.id === params[0]);
        const ch = e && stored.channels.find(x => x.id === e.channel_id);
        return { rows: e && ch ? [{ id: e.id, tenant_id: e.tenant_id, channel_id: e.channel_id, account_username: e.account_username, enabled: true, credentials: ch.credentials }] : [] };
      }
      throw new Error('unexpected auth SQL: ' + sql);
    },
  } as any;
  const client = {
    query: async (sql: string, params: any[]) => {
      if (sql.startsWith('INSERT INTO channels')) stored.channels.push({ id: params[0], tenant_id: params[1], credentials: params[3], settings: JSON.parse(params[4]) });
      else if (sql.startsWith('INSERT INTO sms_delivery_endpoints')) stored.endpoints.push({ id: params[0], tenant_id: params[1], channel_id: params[2], account_username: params[3], callback_url: params[4] });
      else if (sql.includes('FROM sms_delivery_submissions s')) submissionLookups.push(params);
      else throw new Error('unexpected tenant SQL: ' + sql);
      return { rows: [] };
    },
  };
  const app = Fastify();
  app.addHook('onRequest', async req => {
    if (req.url.startsWith('/api/')) (req as any).actor = { role: 'admin', tenantId, userId };
  });
  registerSmsSubmissionRoutes(app, {
    readOnly: false, sessionName: 'dyna_session', auth, encrypt,
    tenantTx: (async (t: string, work: (c: any) => Promise<unknown>) => {
      if (t !== tenantId) throw new Error('wrong tenant');
      // Callback reconcile runs in the same tenantTx port; capture instead of SQL.
      return work(client);
    }) as any,
  });
  await app.ready();
  const created = await app.inject({
    method: 'POST', url: '/api/sms/live-endpoints', headers: { authorization: 'Bearer ' + session },
    payload: { name: 'SMS live', sender: 'Dynaminds', access_token: TOKEN, account_username: 'konto@sklep.pl', callback_origin: 'https://app.example', confirm_external: true },
  });
  assert.equal(created.statusCode, 200, created.body);
  const body = created.json();
  assert.equal(body.callback_url, 'https://app.example/callbacks/smsapi/' + body.id);
  assert.equal(body.callback_token, 'configured');
  const [ch] = stored.channels, [ep] = stored.endpoints;
  assert.equal(ep.callback_url, body.callback_url, 'kolumna callback_url nie zawiera sekretu');
  const credentials = decrypt(ch.credentials);
  assert.deepEqual(Object.keys(credentials).sort(), ['access_token', 'callback_token']);
  assert.match(credentials.callback_token, SMSAPI_CALLBACK_TOKEN);
  assert(!created.body.includes(credentials.callback_token) && !created.body.includes(TOKEN));
  assert(!JSON.stringify(stored.endpoints).includes(credentials.callback_token));
  // The URL sent to SMSAPI as notify_url is base + secret segment; the real resolver decrypts and compares it.
  const notify = new URL(smsApiNotifyUrl(ep.callback_url, credentials.callback_token));
  const wrong = await get(app, notify.pathname.replace(/[^/]+$/, newSmsApiCallbackToken()), report());
  assert.equal(wrong.statusCode, 404);
  const legacy = await get(app, '/callbacks/smsapi/' + body.id, report());
  assert.equal(legacy.statusCode, 404);
  assert.equal(submissionLookups.length, 0, 'zły token nie dochodzi do uzgodnienia');
  // Accepted token reaches the tenant reconcile (no submission row here -> refused 404, never OK).
  const right = await get(app, notify.pathname, report());
  assert.equal(right.statusCode, 404);
  assert.equal(submissionLookups.length, 1);
  assert.equal(submissionLookups[0][0], tenantId);
  assert.equal(submissionLookups[0][2], '1460969715572091219');
  await app.close();
});
