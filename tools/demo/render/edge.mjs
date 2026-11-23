#!/usr/bin/env node
// Public entrance of the hosted demo. The release listens only on loopback and accepts
// only loopback origins, so this process takes the platform's public HTTP port and relays to it:
//  - the entrance page before anything else (the demo holds fictional data, but the application is built for a trusted
//    local network): one shared access code and a role sign the visitor into that role's demo account and leave a signed
//    cookie for 30 days, so the browser's Basic dialog and the account's e-mail and password are no longer typed;
//  - a state-changing request must carry no Origin or exactly DYNA_PUBLIC_ORIGIN; the header is then removed, which is what the
//    release's own check expects of a same-machine caller, so its refusal of foreign origins is kept here;
//  - /api/health stays open for the platform's health check and answers only ok/starting;
//  - X-Forwarded-* and Authorization do not reach the application, nor does the entrance cookie.
import http from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const need = (name) => { const v = process.env[name]; if (!v) throw new Error(`${name} required`); return v; };
const publicOrigin = need('DYNA_PUBLIC_ORIGIN');
// DEMO_BASIC_AUTH_PASSWORD is the code of installations configured before the entrance page replaced the Basic dialog.
const accessCode = (process.env.DEMO_ACCESS_CODE || need('DEMO_BASIC_AUTH_PASSWORD')).trim().toLowerCase();
const listenPort = Number(process.env.PORT ?? 10000), appPort = Number(process.env.DEMO_APP_PORT ?? 4300);
const digest = (s) => createHash('sha256').update(s).digest();
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const STARTING = `<!doctype html><html lang="pl"><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>DYNAMINDS</title>
<body style="font-family:system-ui;margin:20vh auto;max-width:32rem;text-align:center"><h1>Aplikacja się uruchamia</h1><p>To potrwa kilka minut. Strona odświeży się sama.</p></body></html>`;

// The demo company's accounts (tools/demo/catalog.json users, seeded by tools/demo/seed.mjs), one per role the visitor may
// choose. Their passwords are random per seed and come as DEMO_ACCOUNT_PASSWORDS, a JSON object keyed like this one.
const ROLES = {
  owner: { email: 'marta.zielinska@pracownia-smakow.example', label: 'Administrator', note: 'Marta Zielińska · pełny dostęp' },
  warehouse: { email: 'tomasz.krawczyk@pracownia-smakow.example', label: 'Magazynier', note: 'Tomasz Krawczyk · zamówienia i magazyn' },
  accounting: { email: 'ewa.domanska@pracownia-smakow.example', label: 'Tylko podgląd', note: 'Ewa Domańska · bez zmian w danych' },
};
const passwords = JSON.parse(need('DEMO_ACCOUNT_PASSWORDS'));
for (const role of Object.keys(ROLES)) if (typeof passwords[role] !== 'string' || !passwords[role]) throw new Error(`DEMO_ACCOUNT_PASSWORDS.${role} required`);
// The cookie is role.expiry.HMAC keyed by the code: changing the code closes every remembered entrance.
const GATE = 'dyna_demo', GATE_SECONDS = 30 * 24 * 3600, SESSION = 'dyna_session';
const gateKey = digest(`dyna-demo-gate\0${accessCode}`);
const sign = (v) => createHmac('sha256', gateKey).update(v).digest('base64url');
const cookieAttrs = (maxAge) => `Path=/; Max-Age=${maxAge}; HttpOnly${publicOrigin.startsWith('https://') ? '; Secure' : ''}; SameSite=Lax`;
const gateCookie = (role) => { const v = `${role}.${Math.floor(Date.now() / 1000) + GATE_SECONDS}`; return `${GATE}=${v}.${sign(v)}; ${cookieAttrs(GATE_SECONDS)}`; };
const GATE_CLEARED = `${GATE}=; ${cookieAttrs(0)}`;
const parseCookies = (header = '') => header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; });
function gateRole(req) {
  const value = parseCookies(req.headers.cookie).find(([k]) => k === GATE)?.[1] ?? '';
  const [role, exp, mac, extra] = value.split('.');
  if (extra !== undefined || !Object.hasOwn(ROLES, role) || !(Number(exp) * 1000 > Date.now()) || !mac) return null;
  const want = Buffer.from(sign(`${role}.${exp}`)), got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? role : null;
}

// Ten wrong codes lock that address for 15 minutes. The platform's proxy appends the visitor's address last.
const FAILS = 10, LOCK_MS = 15 * 60_000, fails = new Map();
// An IPv6 visitor holds a whole /64, so the lock keys IPv6 by that prefix.
// Without the proxy's header every visitor is the proxy's own address and one lock would close the demo for all, so
// that is logged once.
let warnedNoForwarded = false;
const clientOf = (req) => {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  if (!forwarded && !warnedNoForwarded) { warnedNoForwarded = true; console.error(JSON.stringify({ status: 'DEMO_ENTRANCE_NO_FORWARDED_FOR', note: 'the code lock counts per proxy address' })); }
  const ip = forwarded ?? req.socket.remoteAddress ?? '';
  if (!ip.includes(':') || ip.startsWith('::ffff:')) return ip;
  const [head, tail = ''] = ip.split('::');
  const groups = [...head.split(':').filter(Boolean), ...Array(Math.max(0, 8 - head.split(':').filter(Boolean).length - tail.split(':').filter(Boolean).length)).fill('0'), ...tail.split(':').filter(Boolean)];
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
};
const locked = (who) => { const f = fails.get(who); if (f && f.until < Date.now()) fails.delete(who); return (fails.get(who)?.n ?? 0) >= FAILS; };
// A full table drops the expired entries and then the fewest-failure ones (down to 90%), never all of them: a flood of
// one-off addresses must not wipe the count of an address part way into guessing.
const MAX_TRACKED = 10_000;
function failed(who) {
  if (fails.size >= MAX_TRACKED && !fails.has(who)) {
    const now = Date.now();
    for (const [k, f] of fails) if (f.until < now) fails.delete(k);
    if (fails.size >= MAX_TRACKED) {
      const drop = [...fails].sort((a, b) => a[1].n - b[1].n || a[1].until - b[1].until).slice(0, fails.size - MAX_TRACKED * 0.9);
      for (const [k] of drop) fails.delete(k);
    }
  }
  const f = fails.get(who) ?? { n: 0, until: 0 };
  fails.set(who, { n: f.n + 1, until: Date.now() + LOCK_MS });
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
function entrancePage(res, status, message = '', chosen = 'owner') {
  const roles = Object.entries(ROLES).map(([key, r]) => `<label class="role"><input type="radio" name="role" value="${key}"${key === chosen ? ' checked' : ''}><span><b>${esc(r.label)}</b><small>${esc(r.note)}</small></span></label>`).join('');
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
    // Not no-referrer: under it a browser sends the form with Origin: null, which the Origin check refuses.
    'referrer-policy': 'same-origin' });
  res.end(`<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wejdź do demo · DYNAMINDS</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--text:#16181d;--muted:#5d6370;--line:#d6d9df;--accent:#2563eb;--accent-bg:#eaf1ff;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--text:#eceef2;--muted:#a3a9b5;--line:#343944;--accent:#6b9bff;--accent-bg:#1d2a45;--danger:#ff8a80}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px}
.brand{font-weight:600;letter-spacing:.02em;margin-bottom:20px}.brand small{color:var(--muted);font-weight:400}
h1{font-size:22px;margin:0 0 20px}label.f{display:block;font-size:14px;color:var(--muted);margin-bottom:6px}
input[name=code]{width:100%;height:44px;border:1px solid var(--line);border-radius:8px;padding:0 12px;font-size:17px;background:transparent;color:var(--text)}
input[name=code]:focus{outline:2px solid var(--accent);outline-offset:1px}
fieldset{border:0;padding:0;margin:20px 0 0}legend{font-size:14px;color:var(--muted);margin-bottom:6px;padding:0}
.role{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-top:8px;cursor:pointer}
.role:has(input:checked){border-color:var(--accent);background:var(--accent-bg)}.role input{accent-color:var(--accent);margin:0}
.role small{display:block;color:var(--muted);font-size:13px}.role b{font-weight:500}
button{width:100%;height:46px;margin-top:20px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:16px;font-weight:500;cursor:pointer}
.err{color:var(--danger);font-size:14px;margin:10px 0 0}.note{color:var(--muted);font-size:13px;margin:14px 0 0;text-align:center}
</style>
<main><div class="brand">DYNAMINDS <small>Ecommerce · demo</small></div><h1>Wejdź do demo</h1>
<form method="post" action="/demo/wejdz"><label class="f" for="code">Kod dostępu</label>
<input id="code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="100" required autofocus>
${message ? `<p class="err" role="alert">${esc(message)}</p>` : ''}
<fieldset><legend>Wejdź jako</legend>${roles}</fieldset><button>Wejdź</button></form>
<p class="note">To urządzenie zapamięta wejście na 30 dni. Dane w demo są fikcyjne.</p></main></html>`);
}

const readForm = (req) => new Promise((ok) => {
  let body = '', size = 0;
  req.on('data', (d) => { size += d.length; if (size <= 2048) body += d; });
  req.on('end', () => ok(size <= 2048 ? new URLSearchParams(body) : null));
  req.on('error', () => ok(null));
});
// Signs the role's demo account in on loopback; the answer's session cookie goes to the browser.
const appLogin = (role) => new Promise((ok) => {
  const body = JSON.stringify({ email: ROLES[role].email, password: passwords[role] });
  const up = http.request({ host: '127.0.0.1', port: appPort, method: 'POST', path: '/api/auth/login', agent: false, timeout: 15000,
    headers: { host: `127.0.0.1:${appPort}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => {
    let s = ''; r.on('data', (d) => s += d);
    r.on('error', () => ok(null));
    r.on('end', () => {
      let mfa = false; try { mfa = JSON.parse(s).mfa_required === true; } catch {}
      const cookies = [].concat(r.headers['set-cookie'] ?? []);
      const session = cookies.find((c) => c.startsWith(`${SESSION}=`));
      if (r.statusCode !== 200 || mfa || !session) {
        console.error(JSON.stringify({ status: 'DEMO_ENTRANCE_LOGIN_FAILED', role, http: r.statusCode, mfa }));
        return ok(null);
      }
      ok({ cookies, pair: session.split(';')[0] });
    });
  });
  up.on('timeout', () => up.destroy());
  up.on('error', () => ok(null));
  up.end(body);
});

async function enter(req, res) {
  const who = clientOf(req);
  if (locked(who)) return entrancePage(res, 429, 'Za dużo błędnych prób. Spróbuj ponownie za 15 minut.');
  const form = await readForm(req);
  const role = form?.get('role') ?? '';
  if (!form || !Object.hasOwn(ROLES, role)) return entrancePage(res, 400, 'Wybierz rolę.');
  if (!timingSafeEqual(digest((form.get('code') ?? '').trim().toLowerCase()), digest(accessCode))) {
    failed(who);
    return entrancePage(res, 401, 'Nieprawidłowy kod dostępu.', role);
  }
  fails.delete(who);
  const login = await appLogin(role);
  if (!login) return entrancePage(res, 502, 'Nie udało się zalogować na konto demo. Spróbuj za chwilę.', role);
  res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'set-cookie': [gateCookie(role), ...login.cookies] });
  res.end();
}

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

function starting(res) {
  if (res.headersSent) return res.destroy();
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '10', 'cache-control': 'no-store' });
  res.end(STARTING);
}
// Relays one request; `body` is a stream to pipe or a string. `extraCookies` are added to the answer.
function relay(req, res, headers, body, extraCookies) {
  const up = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers }, (r) => {
    const raw = [...r.rawHeaders];
    for (const c of extraCookies) raw.push('set-cookie', c);
    res.writeHead(r.statusCode, raw);
    r.pipe(res);
    r.on('error', () => res.destroy());
  });
  up.on('error', () => starting(res));
  // A client that went away ends the upstream request too, so the release frees its slot (ordinary-request-lifetime).
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  if (typeof body === 'string') up.end(body); else body.pipe(up);
}
// GET /api/auth/me buffered: an answer of 401 to an entered device means the application forgot the session (a reset),
// so the role is signed in again and asked once more. The request carries no body upstream: a declared one that never
// came would hold an application slot, so the body headers are dropped and the client's body is read away.
const BODY_HEADERS = ['content-length', 'transfer-encoding', 'expect', 'connection'];
function me(req, res, headers, extraCookies) {
  const plain = Object.fromEntries(Object.entries(headers).filter(([k]) => !BODY_HEADERS.includes(k)));
  return new Promise((ok) => {
    const up = http.request({ host: '127.0.0.1', port: appPort, method: 'GET', path: req.url, headers: plain, timeout: 30000 }, (r) => {
      const chunks = []; r.on('data', (d) => chunks.push(d));
      r.on('end', () => ok({ status: r.statusCode, raw: r.rawHeaders, body: Buffer.concat(chunks), extraCookies }));
      r.on('error', () => ok(null));
    });
    up.on('timeout', () => up.destroy());
    up.on('error', () => ok(null));
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    up.end();
  });
}

const withSession = (headers, pair) => ({ ...headers, cookie: [...parseCookies(headers.cookie).filter(([k]) => k !== SESSION).map(([k, v]) => `${k}=${v}`), pair].join('; ') });

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/health' && req.method === 'GET') return health(res);
  if (!req.url.startsWith('/')) { res.writeHead(400); return res.end(); }
  if (!SAFE.has(req.method) && req.headers.origin !== undefined && req.headers.origin !== publicOrigin) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Niedozwolone pochodzenie żądania');
  }
  const path = req.url.split('?')[0];
  if (path === '/demo/wejdz' && req.method === 'POST') return enter(req, res);
  const role = gateRole(req);
  if (!role) {
    if ((req.method === 'GET' || req.method === 'HEAD') && !path.startsWith('/api/')) return entrancePage(res, 200);
    req.resume();
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('Wymagane wejście do demo.');
  }
  if (path === '/demo/wejdz') return entrancePage(res, 200);
  let headers = { ...req.headers, host: `127.0.0.1:${appPort}` };
  for (const h of Object.keys(headers)) if (h === 'origin' || h === 'authorization' || h.startsWith('x-forwarded-') || h === 'forwarded' || h === 'x-real-ip' || h === 'cf-connecting-ip' || h === 'true-client-ip') delete headers[h];
  const rest = parseCookies(headers.cookie).filter(([k]) => k !== GATE);
  if (rest.length) headers.cookie = rest.map(([k, v]) => `${k}=${v}`).join('; '); else delete headers.cookie;
  // Logging out forgets the entrance too, so the next visit chooses the role again.
  if (path === '/api/auth/logout') return relay(req, res, headers, req, [GATE_CLEARED]);
  let extraCookies = [];
  // An entered device whose application session expired (8 h) is signed in again as its role.
  if (!rest.some(([k]) => k === SESSION)) {
    const login = await appLogin(role);
    if (login) { extraCookies = login.cookies; headers = withSession(headers, login.pair); }
  }
  if (path !== '/api/auth/me' || req.method !== 'GET') return relay(req, res, headers, req, extraCookies);
  req.resume();
  let answer = await me(req, res, headers, extraCookies);
  if (answer?.status === 401 && !extraCookies.length) {
    const login = await appLogin(role);
    if (login) answer = await me(req, res, withSession(headers, login.pair), login.cookies);
  }
  if (!answer) return starting(res);
  const raw = [...answer.raw];
  for (const c of answer.extraCookies) raw.push('set-cookie', c);
  res.writeHead(answer.status, raw);
  res.end(answer.body);
});
server.listen(listenPort, '0.0.0.0', () => console.log(JSON.stringify({ status: 'DEMO_EDGE_LISTENING', port: listenPort, app: appPort })));
const stop = () => server.close(() => process.exit(0));
process.once('SIGTERM', stop); process.once('SIGINT', stop);
