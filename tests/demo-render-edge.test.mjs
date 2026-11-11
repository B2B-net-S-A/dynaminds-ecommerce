// The public entrance of the hosted demo (tools/demo/render/edge.mjs) against a stand-in application on loopback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://demo.example', AUTH = 'Basic ' + Buffer.from('demo:sekret-testowy').toString('base64');
let upstream, edge, port, seen = [];
const free = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const call = (opts, body) => new Promise((ok, bad) => {
  const r = http.request({ host: '127.0.0.1', port, ...opts }, (res) => { let s = ''; res.on('data', (d) => s += d); res.on('end', () => ok({ status: res.statusCode, body: s, headers: res.headers })); });
  r.on('error', bad); r.end(body);
});
const authed = (extra = {}) => ({ authorization: AUTH, ...extra });
const edgeOn = (listen, appPort, env = {}) => spawn(process.execPath, [fileURLToPath(new URL('../tools/demo/render/edge.mjs', import.meta.url))], {
  env: { PATH: process.env.PATH, PORT: String(listen), DEMO_APP_PORT: String(appPort), DYNA_PUBLIC_ORIGIN: ORIGIN, DEMO_BASIC_AUTH_USER: 'demo', DEMO_BASIC_AUTH_PASSWORD: 'sekret-testowy', ...env },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

before(async () => {
  const appPort = await free(); port = await free();
  upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    res.setHeader('set-cookie', ['a=1', 'b=2']); res.end('app');
  });
  upstream.keepAliveTimeout = 72000; // Fastify's default: the application keeps an idle connection far longer than the poll interval.
  upstream.listen(appPort, '127.0.0.1');
  edge = edgeOn(port, appPort);
  await new Promise((ok) => edge.stdout.once('data', ok));
  for (let i = 0; i < 50 && !seen.length; i++) await new Promise((ok) => setTimeout(ok, 20));
  await new Promise((ok) => setTimeout(ok, 50));
});
after(() => { edge.kill(); upstream.close(); });

test('nothing but exact GET /api/health passes without the password', async () => {
  for (const o of [{ path: '/' }, { path: '/api/orders' }, { path: '/api/health?x=1' }, { path: '/api/health', method: 'HEAD' }, { path: '/', headers: { authorization: 'Basic ' + Buffer.from('demo:zle').toString('base64') } }]) {
    assert.equal((await call(o)).status, 401, JSON.stringify(o));
  }
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
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET http://evil.example/ HTTP/1.1\r\nHost: x\r\nAuthorization: ${AUTH}\r\nConnection: close\r\n\r\n`));
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

test('during the start health is 200 "starting", the password still comes first, and ok follows the application', async () => {
  const appPort = await free(), listen = await free();
  const starting = edgeOn(listen, appPort);
  await new Promise((ok) => starting.stdout.once('data', ok));
  const at = (opts) => call({ port: listen, ...opts });
  try {
    const h = await at({ path: '/api/health' });
    assert.equal(h.status, 200);
    assert.equal(h.body, '{"status":"starting"}');
    assert.equal((await at({ path: '/' })).status, 401);
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
