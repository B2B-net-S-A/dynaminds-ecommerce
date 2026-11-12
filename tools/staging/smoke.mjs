#!/usr/bin/env node
// Smoke of the local staging (tools/staging/refresh.sh, docs/staging.md): GET /api/health → 200 and status "ok",
// then every demo test account logs in, reads /api/auth/me and logs out.
//
//   node tools/staging/smoke.mjs --base http://127.0.0.1:4300 --credentials <file>
//
// The credentials file is the demo seed's private copy ($DEMO_ROOT/private/credentials.json, 0600, outside the
// repository). Only role keys, HTTP statuses and short reasons are printed: never e-mails, passwords or cookies.
// Self-contained (plain fetch), because launchd runs a copy of this file outside the repository.
// Exit: 0 = all green, 1 = health or a login failed, 2 = bad arguments or unreadable credentials.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SESSION = 'dyna_session';

const cookieOf = (res) => {
  const raw = (res.headers.getSetCookie?.() ?? []).find((v) => v.startsWith(SESSION + '='));
  return raw ? raw.split(';')[0] : null;
};

async function call(base, method, path, { body, cookie, timeoutMs }) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  return fetch(base + path, {
    method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function readCredentials(file) {
  let users;
  // JSON.parse quotes a piece of the text in its error, and the text holds passwords.
  try { users = JSON.parse(readFileSync(file, 'utf8')).users; } catch (e) {
    throw new Error(e.code ? `nie można odczytać pliku z kontami (${e.code})` : 'plik z kontami nie jest poprawnym JSON-em');
  }
  if (!Array.isArray(users) || users.length === 0) throw new Error('brak kont w pliku z kontami testowymi');
  for (const u of users) if (!u?.key || !u?.email || !u?.password) throw new Error('niepełne konto testowe (key/email/password)');
  return users;
}

/** Returns { ok, health, logins: { <key>: 'ok' | '<reason>' } } without any secret in it. */
export async function smoke(base, users, { timeoutMs = 15000 } = {}) {
  const result = { ok: false, health: null, logins: {} };
  try {
    const h = await call(base, 'GET', '/api/health', { timeoutMs });
    const body = await h.json().catch(() => null);
    result.health = h.status === 200 && body?.status === 'ok' ? 'ok' : `HTTP ${h.status} status=${body?.status ?? '?'}`;
  } catch (e) {
    result.health = `brak odpowiedzi (${e.name})`;
    return result;
  }
  for (const u of users) {
    try {
      const login = await call(base, 'POST', '/api/auth/login', { body: { email: u.email, password: u.password }, timeoutMs });
      await login.arrayBuffer();
      const cookie = cookieOf(login);
      if (login.status !== 200 || !cookie) { result.logins[u.key] = `logowanie HTTP ${login.status}`; continue; }
      const me = await call(base, 'GET', '/api/auth/me', { cookie, timeoutMs });
      await me.arrayBuffer();
      await (await call(base, 'POST', '/api/auth/logout', { body: {}, cookie, timeoutMs })).arrayBuffer();
      result.logins[u.key] = me.status === 200 ? 'ok' : `/api/auth/me HTTP ${me.status}`;
    } catch (e) {
      result.logins[u.key] = `brak odpowiedzi (${e.name})`;
    }
  }
  result.ok = result.health === 'ok' && Object.values(result.logins).every((v) => v === 'ok');
  return result;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--base', '--credentials'].includes(argv[i])) throw new Error(`nieznany argument ${argv[i]}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`brak wartości dla ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.base || !out.credentials) throw new Error('podaj --base i --credentials');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let a, users;
  try {
    a = args(process.argv.slice(2));
    users = readCredentials(a.credentials);
  } catch (e) {
    console.error(`smoke: ${e.message}`);
    process.exit(2);
  }
  const r = await smoke(a.base.replace(/\/$/, ''), users);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
