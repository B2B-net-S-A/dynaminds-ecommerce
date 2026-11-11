#!/usr/bin/env node
// Public entrance of the hosted demo. The release listens only on loopback and accepts
// only loopback origins, so this process takes the platform's public HTTP port and relays to it:
//  - HTTP Basic before anything else (the demo holds fictional data, but the application is built for a trusted local network);
//  - a state-changing request must carry no Origin or exactly DYNA_PUBLIC_ORIGIN; the header is then removed, which is what the
//    release's own check expects of a same-machine caller, so its refusal of foreign origins is kept here;
//  - /api/health stays open for the platform's health check and answers only ok/starting;
//  - X-Forwarded-* and Authorization do not reach the application.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const need = (name) => { const v = process.env[name]; if (!v) throw new Error(`${name} required`); return v; };
const publicOrigin = need('DYNA_PUBLIC_ORIGIN');
const user = need('DEMO_BASIC_AUTH_USER'), password = need('DEMO_BASIC_AUTH_PASSWORD');
const listenPort = Number(process.env.PORT ?? 10000), appPort = Number(process.env.DEMO_APP_PORT ?? 4300);
const digest = (s) => createHash('sha256').update(s).digest();
const expected = digest(`Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`);
const authorized = (req) => timingSafeEqual(digest(req.headers.authorization ?? ''), expected);
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const STARTING = `<!doctype html><html lang="pl"><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>DYNAMINDS</title>
<body style="font-family:system-ui;margin:20vh auto;max-width:32rem;text-align:center"><h1>Aplikacja się uruchamia</h1><p>To potrwa kilka minut. Strona odświeży się sama.</p></body></html>`;

// Answered from memory: the application counts every request of this entrance against one rate-limit bucket (all clients are
// 127.0.0.1 to it), so unauthenticated health traffic must never reach it.
// agent: false because Node's global agent keeps sockets alive with a 5 s timeout, this poll's own interval: at idle a reused
// socket timed out right after the request was sent, and each such false failure answered 503 until the next poll.
let healthy = false, hasRun = false;
function poll() {
  const up = http.get({ host: '127.0.0.1', port: appPort, path: '/api/health', timeout: 5000, agent: false }, (r) => { r.resume(); healthy = r.statusCode === 200; hasRun ||= healthy; });
  up.on('error', () => { healthy = false; });
  up.on('timeout', () => { up.destroy(); healthy = false; });
}
poll(); setInterval(poll, 5000).unref();
// A start takes 5-6 minutes and the platform sends no traffic to an instance answering 503, so a visitor would get its 502
// instead of the "starting" page. A start that never finishes turns 503 at the platform's own deploy limit of 15 minutes.
const startedAt = Date.now(), startLimitMs = Number(process.env.DEMO_START_LIMIT_SECONDS ?? 900) * 1000;
function health(res) {
  const starting = !hasRun && Date.now() - startedAt < startLimitMs;
  res.writeHead(healthy || starting ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  // The release commit lets the deploy pipeline confirm which build answers (a starting new container says "starting").
  const commit = process.env.DEMO_RELEASE_COMMIT;
  res.end(JSON.stringify({ status: healthy ? 'ok' : 'starting', ...(commit ? { commit } : {}) }));
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/health' && req.method === 'GET') return health(res);
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="DYNAMINDS demo", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Wymagane logowanie do demo.');
  }
  if (!req.url.startsWith('/')) { res.writeHead(400); return res.end(); }
  if (!SAFE.has(req.method) && req.headers.origin !== undefined && req.headers.origin !== publicOrigin) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Niedozwolone pochodzenie żądania');
  }
  const headers = { ...req.headers, host: `127.0.0.1:${appPort}` };
  for (const h of Object.keys(headers)) if (h === 'origin' || h === 'authorization' || h.startsWith('x-forwarded-') || h === 'forwarded' || h === 'x-real-ip' || h === 'cf-connecting-ip' || h === 'true-client-ip') delete headers[h];
  const up = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode, r.rawHeaders);
    r.pipe(res);
    r.on('error', () => res.destroy());
  });
  up.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '10', 'cache-control': 'no-store' });
    res.end(STARTING);
  });
  // A client that went away ends the upstream request too, so the release frees its slot (ordinary-request-lifetime).
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
});
server.listen(listenPort, '0.0.0.0', () => console.log(JSON.stringify({ status: 'DEMO_EDGE_LISTENING', port: listenPort, app: appPort })));
const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop); process.once('SIGINT', stop);
