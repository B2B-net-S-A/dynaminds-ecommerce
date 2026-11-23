// The public entrance of the hosted demo (tools/demo/render/edge.mjs) against a stand-in application on loopback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ORIGIN = 'https://demo.example', CODE = 'Lipa-47';
const CATALOG = JSON.parse(readFileSync(new URL('../tools/demo/catalog.json', import.meta.url), 'utf8')).users;
const PASSWORDS = Object.fromEntries(CATALOG.map((u) => [u.key, `haslo-${u.key}`]));
const account = (key) => CATALOG.find((u) => u.key === key);
let upstream, edge, port, seen = [], GATE = '';
const free = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const call = (opts, body) => new Promise((ok, bad) => {
  const r = http.request({ host: '127.0.0.1', port, ...opts }, (res) => { let s = ''; res.on('data', (d) => s += d); res.on('end', () => ok({ status: res.statusCode, body: s, headers: res.headers })); });
  r.on('error', bad); r.end(body);
});
const authed = ({ cookie, ...extra } = {}) => ({ cookie: [GATE, cookie].filter(Boolean).join('; '), ...extra });
const form = (fields) => new URLSearchParams(fields).toString();
const enter = (fields, headers = {}, at = port) => call({ port: at, path: '/demo/wejdz', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers } }, form(fields));
const gateOf = (r) => (r.headers['set-cookie'] ?? []).find((c) => c.startsWith('dyna_demo='))?.split(';')[0];
// The demo accounts' stand-in: each catalog account's own password signs it in with its own session; the warehouse account asks for a code.
function demoApp(req, res) {
  seen.push({ url: req.url, method: req.method, headers: req.headers });
  if (req.url === '/api/auth/login' && req.method === 'POST') {
    let b = ''; req.on('data', (d) => b += d);
    return req.on('end', () => {
      const { email, password } = JSON.parse(b);
      seen.at(-1).body = { email, password };
      if (password !== PASSWORDS[CATALOG.find((u) => u.email === email)?.key]) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"detail":"Nieprawidłowy email lub hasło"}'); }
      if (email === account('warehouse').email) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"mfa_required":true}'); }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `dyna_session=tok-${CATALOG.find((u) => u.email === email).key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800` });
      res.end(JSON.stringify({ user: { email } }));
    });
  }
  if (req.url === '/api/auth/me') {
    const ok = /dyna_session=tok-/.test(req.headers.cookie ?? '');
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    return res.end(ok ? `{"session":"${/dyna_session=([^;]+)/.exec(req.headers.cookie)[1]}"}` : '{"detail":"Sesja wygasła"}');
  }
  res.setHeader('set-cookie', ['a=1', 'b=2']); res.end('app');
}
const edgeOn = (listen, appPort, env = {}) => spawn(process.execPath, [fileURLToPath(new URL('../tools/demo/render/edge.mjs', import.meta.url))], {
  env: { PATH: process.env.PATH, PORT: String(listen), DEMO_APP_PORT: String(appPort), DYNA_PUBLIC_ORIGIN: ORIGIN, DEMO_ACCESS_CODE: CODE, DEMO_ACCOUNT_PASSWORDS: JSON.stringify(PASSWORDS), ...env },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

before(async () => {
  const appPort = await free(); port = await free();
  upstream = http.createServer(demoApp);
  upstream.keepAliveTimeout = 72000; // Fastify's default: the application keeps an idle connection far longer than the poll interval.
  upstream.listen(appPort, '127.0.0.1');
  edge = edgeOn(port, appPort);
  await new Promise((ok) => edge.stdout.once('data', ok));
  for (let i = 0; i < 50 && !seen.length; i++) await new Promise((ok) => setTimeout(ok, 20));
  await new Promise((ok) => setTimeout(ok, 50));
  GATE = gateOf(await enter({ code: CODE, role: 'owner' }));
  assert.ok(GATE, 'the right code opens the demo');
});
after(() => { edge.kill(); upstream.close(); });

test('without the entrance cookie a page shows the entrance and nothing but exact GET /api/health reaches the application', async () => {
  seen = [];
  for (const o of [{ path: '/' }, { path: '/zamowienia/1' }, { path: '/', headers: { cookie: 'dyna_session=tok-owner' } }]) {
    const r = await call(o);
    assert.equal(r.status, 200, JSON.stringify(o));
    assert.match(r.body, /Wejdź do demo/);
    assert.match(r.body, /name="code"/);
    for (const role of ['Administrator', 'Magazynier', 'Tylko podgląd', ...CATALOG.map((u) => u.name)]) assert.match(r.body, new RegExp(role));
    for (const u of CATALOG) assert.match(r.body, new RegExp(`value="${u.key}"`), 'every catalog account is a role to choose');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['referrer-policy'], 'same-origin', 'no-referrer makes the browser post the form with Origin: null');
  }
  for (const o of [{ path: '/api/orders' }, { path: '/api/health?x=1' }, { path: '/api/health', method: 'HEAD' }, { path: '/api/auth/login', method: 'POST', headers: { origin: ORIGIN } }]) {
    assert.equal((await call(o, o.method === 'POST' ? '{}' : undefined)).status, 401, JSON.stringify(o));
  }
  assert.equal(seen.filter((s) => s.url !== '/api/health').length, 0);
});

test('a forged, expired, foreign-code or unknown-role entrance cookie is no entrance', async () => {
  const [role, exp, mac] = GATE.slice('dyna_demo='.length).split('.');
  for (const cookie of [`dyna_demo=accounting.${exp}.${mac}`, `dyna_demo=${role}.${Number(exp) + 1}.${mac}`, `dyna_demo=${role}.${exp}.${mac.slice(1)}`,
    `dyna_demo=${role}.1.${mac}`, `dyna_demo=__proto__.${exp}.${mac}`, 'dyna_demo=', 'dyna_demo=admin']) {
    assert.equal((await call({ path: '/api/orders', headers: { cookie } })).status, 401, cookie);
  }
  const other = await free(), e = edgeOn(other, await free(), { DEMO_ACCESS_CODE: 'inny-kod' });
  await new Promise((ok) => e.stdout.once('data', ok));
  try { assert.match((await call({ port: other, path: '/', headers: { cookie: GATE } })).body, /Wejdź do demo/, 'a changed code closes every remembered entrance'); }
  finally { e.kill(); }
});

test('the right code and a role sign that demo account in and remember the device for 30 days', async () => {
  seen = [];
  const r = await enter({ code: '  lIPA-47 ', role: 'accounting' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/');
  const cookies = r.headers['set-cookie'];
  const gate = cookies.find((c) => c.startsWith('dyna_demo='));
  assert.match(gate, /^dyna_demo=accounting\.\d+\.[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  assert.ok(cookies.some((c) => c.startsWith('dyna_session=tok-accounting;')), 'the application session reaches the browser');
  const login = seen.find((s) => s.url === '/api/auth/login');
  assert.deepEqual(login.body, { email: account('accounting').email, password: PASSWORDS.accounting });
  assert.equal(login.headers.origin, undefined);
});

test('every role signs in the catalog account of the seed with that account\'s own password', async () => {
  seen = [];
  for (const u of CATALOG) await enter({ code: CODE, role: u.key });
  assert.deepEqual(seen.filter((s) => s.url === '/api/auth/login').map((s) => s.body), CATALOG.map((u) => ({ email: u.email, password: PASSWORDS[u.key] })));
});

test('a wrong code, an unknown role or a foreign Origin give no entrance', async () => {
  seen = [];
  const wrong = await enter({ code: 'lipa-48', role: 'owner' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /Nieprawidłowy kod/);
  assert.match((await enter({ code: 'lipa-48', role: 'accounting' })).body, /value="accounting" checked/, 'the chosen role stays chosen');
  assert.equal(gateOf(wrong), undefined);
  for (const role of ['admin', 'root', '__proto__', '']) assert.equal((await enter({ code: CODE, role })).status, 400, role);
  assert.equal((await enter({ code: CODE, role: 'owner' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal(seen.filter((s) => s.url === '/api/auth/login').length, 0, 'nothing above reaches the application');
});

test('ten wrong codes from one address lock that address for 15 minutes, even with the right code', async () => {
  const own = await free(), e = edgeOn(own, await free());
  await new Promise((ok) => e.stdout.once('data', ok));
  try {
    for (let i = 0; i < 10; i++) assert.equal((await enter({ code: 'zly-' + i, role: 'owner' }, { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' }, own)).status, 401);
    const locked = await enter({ code: CODE, role: 'owner' }, { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' }, own);
    assert.equal(locked.status, 429);
    assert.match(locked.body, /15 minut/);
    assert.notEqual((await enter({ code: 'zly', role: 'owner' }, { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, own)).status, 429, 'another visitor is not locked');
  } finally { e.kill(); }
});

test('an entered device without an application session is signed in again as its role', async () => {
  seen = [];
  const r = await call({ path: '/api/auth/me', headers: authed() });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).session, 'tok-owner');
  assert.ok(r.headers['set-cookie'].some((c) => c.startsWith('dyna_session=tok-owner;')));
  const stale = await call({ path: '/api/auth/me', headers: authed({ cookie: 'dyna_session=stary' }) });
  assert.equal(stale.status, 200, 'a session the application no longer knows is replaced');
  assert.equal(JSON.parse(stale.body).session, 'tok-owner');
  assert.ok(seen.every((s) => !(s.headers.cookie ?? '').includes('dyna_demo')), 'the entrance cookie stays at the edge');
});

test('logging out forgets the entrance, so the next visit chooses again', async () => {
  const r = await call({ path: '/api/auth/logout', method: 'POST', headers: authed({ origin: ORIGIN, cookie: 'dyna_session=tok-owner' }) }, '{}');
  assert.equal(r.status, 200);
  assert.ok(r.headers['set-cookie'].includes('dyna_demo=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'));
});

test('an account asking for MFA is refused at the entrance with a Polish reason', async () => {
  const r = await enter({ code: CODE, role: 'warehouse' });
  assert.equal(r.status, 502);
  assert.match(r.body, /Nie udało się zalogować/);
  assert.equal(gateOf(r), undefined);
});

test('health answers from memory: a burst never reaches the application', async () => {
  seen = [];
  const results = await Promise.all(Array.from({ length: 200 }, () => call({ path: '/api/health' })));
  assert.ok(results.every((r) => r.status === 200 && r.body === '{"status":"ok"}'));
  assert.ok(seen.length <= 1, `upstream saw ${seen.length}`);
});

test('a foreign, null or empty Origin is refused before the application', async () => {
  seen = [];
  for (const origin of ['https://evil.example', 'null', '', `${ORIGIN}.evil.example`, 'http://demo.example']) {
    assert.equal((await call({ path: '/api/x', method: 'POST', headers: authed({ origin }) }, '{}')).status, 403, origin);
  }
  assert.equal(seen.filter((s) => s.url === '/api/x').length, 0);
});

test('own Origin passes without the header; identity headers do not reach the application', async () => {
  seen = [];
  const r = await call({ path: '/api/x?y=1', method: 'POST', headers: authed({ origin: ORIGIN, 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4', forwarded: 'for=1.2.3.4', cookie: 'dyna_session=z' }) }, '{"a":1}');
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']);
  const got = seen.find((s) => s.url === '/api/x?y=1');
  for (const h of ['origin', 'authorization', 'x-forwarded-for', 'x-real-ip', 'forwarded']) assert.equal(got.headers[h], undefined, h);
  assert.equal(got.headers.cookie, 'dyna_session=z');
  assert.match(got.headers.host, /^127\.0\.0\.1:/);
});

test('an absolute-form request target is refused even with the password', async () => {
  const status = await new Promise((ok) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET http://evil.example/ HTTP/1.1\r\nHost: x\r\nCookie: ${GATE}\r\nConnection: close\r\n\r\n`));
    let b = ''; s.on('data', (d) => b += d); s.on('end', () => ok(b.split(' ')[1]));
  });
  assert.equal(status, '400');
});

test('an idle healthy application never turns health 503, and every poll has its own connection', async () => {
  // Node 22's global agent keeps connections alive with a 5 s socket timeout, the poll's own interval: a reused socket
  // timed out within a millisecond of the request, which read as a failed poll and answered 503 until the next one.
  seen = [];
  const statuses = new Set();
  const sockets = new Set();
  const collect = (req) => { if (req.url === '/api/health') sockets.add(req.socket); };
  upstream.on('request', collect);
  for (const end = Date.now() + 26000; Date.now() < end; await wait(100)) statuses.add((await call({ path: '/api/health' })).status);
  upstream.off('request', collect);
  const polls = seen.filter((s) => s.url === '/api/health').length;
  assert.deepEqual([...statuses], [200]);
  assert.ok(polls >= 4, `only ${polls} polls`);
  assert.equal(sockets.size, polls);
});

test('during the start health is 200 "starting", the entrance still comes first, and ok follows the application', async () => {
  const appPort = await free(), listen = await free();
  const starting = edgeOn(listen, appPort);
  await new Promise((ok) => starting.stdout.once('data', ok));
  const at = (opts) => call({ port: listen, ...opts });
  try {
    const h = await at({ path: '/api/health' });
    assert.equal(h.status, 200);
    assert.equal(h.body, '{"status":"starting"}');
    assert.equal((await at({ path: '/api/x' })).status, 401);
    assert.equal((await at({ path: '/api/x', method: 'POST', headers: authed({ origin: 'https://evil.example' }) }, '{}')).status, 403);
    const page = await at({ path: '/', headers: authed() });
    assert.equal(page.status, 503);
    assert.match(page.body, /uruchamia/);
    const app = http.createServer((req, res) => res.end('app')).listen(appPort, '127.0.0.1');
    await wait(5200);
    assert.equal((await at({ path: '/api/health' })).body, '{"status":"ok"}');
    await new Promise((ok) => { app.closeAllConnections(); app.close(ok); });
    await wait(5200);
    assert.equal((await at({ path: '/api/health' })).status, 503, 'once it has run, losing the application is a failure');
  } finally { starting.kill(); }
});

test('a start that never finishes turns health 503, so the platform can restart it', async () => {
  const listen = await free();
  const stuck = edgeOn(listen, await free(), { DEMO_START_LIMIT_SECONDS: '1' });
  await new Promise((ok) => stuck.stdout.once('data', ok));
  try {
    assert.equal((await call({ port: listen, path: '/api/health' })).status, 200);
    await wait(1100);
    const h = await call({ port: listen, path: '/api/health' });
    assert.equal(h.status, 503);
    assert.equal(h.body, '{"status":"starting"}');
  } finally { stuck.kill(); }
});

test('with the application down a visitor sees the Polish starting page and health turns 503', async () => {
  await new Promise((ok) => { upstream.closeAllConnections(); upstream.close(ok); });
  const page = await call({ path: '/', headers: authed() });
  assert.equal(page.status, 503);
  assert.match(page.body, /uruchamia/);
  await new Promise((ok) => setTimeout(ok, 5200));
  assert.equal((await call({ path: '/api/health' })).status, 503);
});

test('health reports the release commit when the image carries one, so a deploy can be verified', async () => {
  const appPort = await free(), own = await free();
  const app = http.createServer((req, res) => res.end('app')).listen(appPort, '127.0.0.1');
  const e = edgeOn(own, appPort, { DEMO_RELEASE_COMMIT: '0123456789abcdef0123456789abcdef01234567' });
  try {
    await new Promise((ok) => e.stdout.once('data', ok));
    let r;
    for (let i = 0; i < 50; i++) {
      r = await new Promise((ok, bad) => { const q = http.request({ host: '127.0.0.1', port: own, path: '/api/health' }, (res) => { let s = ''; res.on('data', (d) => s += d); res.on('end', () => ok({ status: res.statusCode, body: s })); }); q.on('error', bad); q.end(); });
      if (JSON.parse(r.body).status === 'ok') break;
      await wait(20);
    }
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { status: 'ok', commit: '0123456789abcdef0123456789abcdef01234567' });
  } finally { e.kill(); app.close(); }
});
