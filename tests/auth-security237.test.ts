/** Migration 237 (docs/parity/AUTH-SECURITY237-20261027.md): login event history incl. failures (SEC-005),
 * a durable per-login failed-password lock (SEC-012) and API key rotation with last_used_at (API-001).
 * Database test on a disposable clone migrated to HEAD. */
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { totp } from '../server/totp';
import { decrypt } from '../server/security';

assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
const password = 'AuthSecurity237!2026';
const nextPassword = 'AuthSecurity237!Reset';
let ipCounter = 0;
// A distinct source address per request keeps the in-memory per-IP limiter (10/min) out of the picture:
// whatever refuses here must be the durable per-login counter.
const ip = () => '10.237.' + (Math.floor(++ipCounter / 250) % 250) + '.' + ((ipCounter % 250) + 1);
const cookieOf = (r: any) => r.headers['set-cookie']?.toString().split(';')[0];
const req = (url: string, method: any = 'GET', payload?: any, cookie?: string, headers: any = {}, on = app) =>
  on.inject({ url, method, payload, remoteAddress: ip(), headers: { 'user-agent': 'QA-237/1.0', ...(cookie ? { cookie } : {}), ...headers } });
const login = (email: string, pw: string, extra: any = {}, on = app) =>
  req('/api/auth/login', 'POST', { email, password: pw, ...extra }, undefined, {}, on);
before(async () => {
  await migrate();
  await seed();
});
beforeEach(async () => {
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
});
after(async () => {
  await pool.end();
});
async function signup(extra: any = {}) {
  const r = await req('/api/auth/signup', 'POST', {
    email: randomUUID() + '@example.test',
    name: 'QA 237',
    password,
    ...(extra.invitation_token ? {} : { organization: { name: 'QA 237 ' + randomUUID().slice(0, 8) } }),
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return { user: r.json().user, cookie: cookieOf(r) as string, secret: '' };
}
async function join(a: any, b: any, role: string) {
  const inv = await req('/api/workspaces/invitations', 'POST', { email: b.user.email, role }, a.cookie);
  assert.equal(inv.statusCode, 201, inv.body);
  const r = await req('/api/workspaces/invitations/accept', 'POST', { token: inv.json().token }, b.cookie);
  assert.equal(r.statusCode, 200, r.body);
  b.cookie = cookieOf(r);
  b.user = r.json().user;
}
async function enableMfa(a: any) {
  const setup = await req('/api/auth/security/enroll', 'POST', { password }, a.cookie);
  assert.equal(setup.statusCode, 200, setup.body);
  a.secret = setup.json().secret;
  const r = await req('/api/auth/security/confirm', 'POST', { password, code: totp(a.secret) }, a.cookie);
  assert.equal(r.statusCode, 200, r.body);
  a.cookie = cookieOf(r);
}
const events = async (where: string, values: unknown[]) =>
  (await pool.query(`SELECT * FROM auth237_login_events WHERE ${where} ORDER BY created_at,id`, values)).rows;

test('SEC-005: every login outcome leaves an event (IP, UA, time); unknown e-mail only as a keyed hash', async () => {
  const a = await signup();
  const startedAt = Date.now();
  assert.equal((await login(a.user.email, 'wrong-password-1')).statusCode, 401);
  const unknown = 'nobody-' + randomUUID() + '@example.test';
  assert.equal((await login(unknown, 'wrong-password-1')).statusCode, 401);
  const ok = await login(a.user.email.toUpperCase(), password);
  assert.equal(ok.statusCode, 200, ok.body);
  const mine = await events('user_id=$1', [a.user.id]);
  assert.deepEqual(mine.map((e) => [e.outcome, e.status]), [['password_failed', 401], ['success', 200]]);
  for (const e of mine) {
    assert.match(e.ip, /^10\.237\./);
    assert.equal(e.user_agent, 'QA-237/1.0');
    assert(new Date(e.created_at).getTime() >= startedAt - 5000);
    assert.match(e.subject_hash, /^[a-f0-9]{64}$/);
  }
  assert.equal(mine[0].tenant_id, null);
  assert.equal(mine[1].tenant_id, a.user.tenant_id);
  assert.equal(mine[0].subject_hash, mine[1].subject_hash, 'one subject per normalised login');
  // The unknown e-mail: no user, no tenant, no plaintext anywhere in the row.
  const theirs = (await pool.query("SELECT * FROM auth237_login_events WHERE user_id IS NULL AND created_at>=to_timestamp($1/1000.0) AND outcome='password_failed'", [startedAt])).rows;
  const row = theirs.find((e) => !JSON.stringify(e).includes(a.user.email));
  assert(row, 'unknown attempt recorded');
  assert(!JSON.stringify(theirs).includes(unknown) && !JSON.stringify(theirs).includes(unknown.split('@')[0]));
  assert.notEqual(row.subject_hash, mine[0].subject_hash);
  assert.equal(row.tenant_id, null);
});

test('SEC-005: the owner sees own history incl. failures; an admin sees the members; viewer and other workspaces do not', async () => {
  const a = await signup(), b = await signup(), outsider = await signup();
  await join(a, b, 'viewer');
  assert.equal((await login(b.user.email, 'wrong-password-2')).statusCode, 401);
  assert.equal((await login(outsider.user.email, 'wrong-password-3')).statusCode, 401);
  const own = await req('/api/auth/security/logins', 'GET', undefined, b.cookie);
  assert.equal(own.statusCode, 200, own.body);
  assert(own.json().data.some((e: any) => e.outcome === 'password_failed' && e.ip && e.user_agent === 'QA-237/1.0'));
  assert(own.json().data.every((e: any) => !('subject_hash' in e) && !('user_id' in e)));
  const admin = await req('/api/workspaces/security/logins', 'GET', undefined, a.cookie);
  assert.equal(admin.statusCode, 200, admin.body);
  const rows = admin.json().data;
  assert(rows.some((e: any) => e.user_email === b.user.email && e.outcome === 'password_failed'));
  assert(!rows.some((e: any) => e.user_email === outsider.user.email), 'non-member history stays private');
  assert(rows.every((e: any) => !('subject_hash' in e)));
  // Past the 90-day retention an event is not shown even before the bounded purge removed it.
  await pool.query("INSERT INTO auth237_login_events(user_id,subject_hash,outcome,status,created_at) SELECT user_id,subject_hash,'password_failed',401,clock_timestamp()-interval '120 days' FROM auth237_login_events WHERE user_id=$1 LIMIT 1", [b.user.id]);
  const aged = (await req('/api/auth/security/logins', 'GET', undefined, b.cookie)).json().data;
  assert(aged.every((e: any) => Date.now() - Date.parse(e.created_at) < 91 * 86400000));
  assert((await req('/api/workspaces/security/logins', 'GET', undefined, a.cookie)).json().data.every((e: any) => Date.now() - Date.parse(e.created_at) < 91 * 86400000));
  await pool.query("DELETE FROM auth237_login_events WHERE user_id=$1 AND created_at<clock_timestamp()-interval '100 days'", [b.user.id]);
  assert.equal((await req('/api/workspaces/security/logins', 'GET', undefined, b.cookie)).statusCode, 403);
  const other = await req('/api/workspaces/security/logins', 'GET', undefined, outsider.cookie);
  assert.equal(other.statusCode, 200);
  assert(!other.json().data.some((e: any) => e.user_email === b.user.email));
});

test('SEC-005: wrong MFA and the MFA lock are recorded; the lock answers 429', async () => {
  const a = await signup();
  await enableMfa(a);
  for (let i = 0; i < 5; i++) assert.equal((await login(a.user.email, password, { code: '000000' })).statusCode, 401);
  const locked = await login(a.user.email, password, { code: totp(a.secret) });
  assert.equal(locked.statusCode, 429, locked.body);
  const rows = await events('user_id=$1', [a.user.id]);
  assert.deepEqual(rows.map((e) => e.outcome), ['mfa_failed', 'mfa_failed', 'mfa_failed', 'mfa_failed', 'mfa_failed', 'mfa_locked']);
  assert.deepEqual(rows.map((e) => e.status), [401, 401, 401, 401, 401, 429]);
});

test('SEC-012: five wrong passwords lock the login durably: 429 even with the right password, after an app rebuild', async () => {
  const a = await signup();
  for (let i = 0; i < 5; i++) assert.equal((await login(a.user.email, 'wrong-password-' + i)).statusCode, 401);
  const refused = await login(a.user.email, password);
  assert.equal(refused.statusCode, 429, refused.body);
  // A new process/instance has a fresh in-memory limiter; the lock lives in PostgreSQL.
  await app.close();
  app = await buildApp();
  const again = await login(a.user.email, password);
  assert.equal(again.statusCode, 429, again.body);
  assert.equal(again.json().detail, refused.json().detail);
  const rows = await events('user_id=$1', [a.user.id]);
  assert.deepEqual(rows.map((e) => e.outcome), ['password_failed', 'password_failed', 'password_failed', 'password_failed', 'password_failed', 'password_locked', 'password_locked']);
  // After the lock expires the right password signs in and clears the counter.
  await pool.query("UPDATE auth237_login_throttle SET locked_until=clock_timestamp()-interval '1 second' WHERE subject_hash=$1", [rows[0].subject_hash]);
  const ok = await login(a.user.email, password);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await pool.query('SELECT count(*)::int n FROM auth237_login_throttle WHERE subject_hash=$1', [rows[0].subject_hash])).rows[0].n, 0);
});

test('SEC-012: the counter is shared by two live instances and backs off after the first lock', async () => {
  const a = await signup(), second = await buildApp();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(a.user.email, 'wrong-' + i, {}, i % 2 ? second : app)).statusCode, 401);
    assert.equal((await login(a.user.email, password, {}, second)).statusCode, 429);
    assert.equal((await login(a.user.email, password, {}, app)).statusCode, 429);
    const subject = (await events('user_id=$1', [a.user.id]))[0].subject_hash;
    const first = (await pool.query('SELECT failures,locked_until-updated_at AS span FROM auth237_login_throttle WHERE subject_hash=$1', [subject])).rows[0];
    assert.equal(first.failures, 5);
    assert.equal(first.span.minutes, 5);
    // Expired lock, still within the hour: one more wrong password locks again for longer.
    await pool.query("UPDATE auth237_login_throttle SET locked_until=clock_timestamp()-interval '1 second' WHERE subject_hash=$1", [subject]);
    assert.equal((await login(a.user.email, 'wrong-6', {}, second)).statusCode, 401);
    const next = (await pool.query('SELECT failures,locked_until-updated_at AS span FROM auth237_login_throttle WHERE subject_hash=$1', [subject])).rows[0];
    assert.equal(next.failures, 6);
    assert.equal(next.span.minutes, 10);
    assert.equal((await login(a.user.email, password, {}, app)).statusCode, 429);
  } finally {
    await second.close();
  }
});

test('SEC-012: simultaneous right-password logins after a failure never fail (one counter row per attempt)', async () => {
  const a = await signup();
  for (let round = 0; round < 8; round++) {
    assert.equal((await login(a.user.email, 'wrong-' + round)).statusCode, 401);
    const both = await Promise.all([login(a.user.email, password), login(a.user.email, password), login(a.user.email, password)]);
    assert.deepEqual(both.map((r) => r.statusCode), [200, 200, 200], both.map((r) => r.body).join('\n'));
  }
});

test('SEC-012: no account enumeration: unknown e-mail and wrong password answer alike, lock alike, and take alike long', async () => {
  const known = [await signup(), await signup()];
  // Everything but the date header and the per-request request_id must be identical.
  const strip = (r: any) => {
    const { date, ...h } = r.headers;
    const { request_id, ...body } = r.json();
    assert.match(String(request_id), /^req-/);
    return { status: r.statusCode, body, headers: h };
  };
  const timeKnown: number[] = [], timeUnknown: number[] = [];
  let firstKnown: any, firstUnknown: any;
  for (let i = 0; i < 8; i++) {
    const k = known[i % 2], u = 'nobody-' + randomUUID() + '@example.test';
    let t = process.hrtime.bigint();
    const rk = await login(k.user.email, 'wrong-' + i);
    timeKnown.push(Number(process.hrtime.bigint() - t) / 1e6);
    t = process.hrtime.bigint();
    const ru = await login(u, 'wrong-' + i);
    timeUnknown.push(Number(process.hrtime.bigint() - t) / 1e6);
    firstKnown ??= strip(rk);
    firstUnknown ??= strip(ru);
    assert.deepEqual(strip(rk), strip(ru));
  }
  assert.deepEqual(firstKnown, firstUnknown);
  const median = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
  const mk = median(timeKnown), mu = median(timeUnknown);
  console.log(JSON.stringify({ enumeration_timing_ms: { known_median: mk, unknown_median: mu, known: timeKnown, unknown: timeUnknown } }));
  assert(Math.abs(mk - mu) <= Math.max(25, 0.35 * Math.max(mk, mu)), `timing differs beyond noise: ${mk} vs ${mu}`);
  // The same lock for an address that has no account.
  const ghost = 'ghost-' + randomUUID() + '@example.test', real = await signup();
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(strip(await login(ghost, 'x' + i)), strip(await login(real.user.email, 'x' + i)));
  }
  const g = await login(ghost, password), r = await login(real.user.email, password);
  assert.equal(g.statusCode, 429);
  assert.deepEqual(strip(g), strip(r));
});

test('SEC-005/012: a completed password reset is recorded and clears the login lock', async () => {
  const a = await signup();
  for (let i = 0; i < 5; i++) assert.equal((await login(a.user.email, 'wrong-' + i)).statusCode, 401);
  assert.equal((await login(a.user.email, password)).statusCode, 429);
  const requested = await req('/api/auth/password/request', 'POST', { email: a.user.email });
  assert.equal(requested.statusCode, 202, requested.body);
  const mail = (await pool.query("SELECT body_encrypted FROM account_local_mail WHERE user_id=$1 AND kind='password_reset'", [a.user.id])).rows[0];
  const token = decrypt(mail.body_encrypted).url.split('#password-reset=')[1];
  const reset = await req('/api/auth/password/reset', 'POST', { token, password: nextPassword, confirm_password: nextPassword });
  assert.equal(reset.statusCode, 200, reset.body);
  const ok = await login(a.user.email, nextPassword);
  assert.equal(ok.statusCode, 200, ok.body);
  const outcomes = (await events('user_id=$1', [a.user.id])).map((e) => e.outcome);
  assert.deepEqual(outcomes.slice(-2), ['password_reset', 'success']);
});

async function key(a: any, scopes = ['orders:read'], expires_days = 30) {
  const r = await req('/api/developer/keys', 'POST', { name: 'Rotacja 237', scopes, expires_days }, a.cookie);
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
const useKey = (token: string) => req('/api/v1/orders?limit=1', 'GET', undefined, undefined, { authorization: 'Bearer ' + token });
const state = async (a: any) => {
  const r = await req('/api/developer/keys/state', 'GET', undefined, a.cookie);
  assert.equal(r.statusCode, 200, r.body);
  return new Map<string, any>(r.json().data.map((s: any) => [s.key_id, s]));
};

test('API-001: rotation issues a new secret with the same scopes, revokes the old one at once and is audited', async () => {
  const a = await signup();
  const old = await key(a, ['orders:read', 'crm:read'], 7);
  assert.equal((await useKey(old.token)).statusCode, 200);
  const r = await req('/api/developer/keys/' + old.id + '/rotate', 'POST', {}, a.cookie);
  assert.equal(r.statusCode, 201, r.body);
  const fresh = r.json();
  assert.notEqual(fresh.token, old.token);
  assert.match(fresh.token, /^dyna_api_[a-f0-9]{64}$/);
  assert.equal(fresh.rotated_from_id, old.id);
  assert.deepEqual([...fresh.scopes].sort(), ['crm:read', 'orders:read']);
  assert.equal(fresh.name, old.name);
  assert(Math.abs(Date.parse(fresh.expires_at) - Date.now() - 7 * 86400000) < 120000, 'same lifetime as the predecessor');
  assert.equal((await useKey(old.token)).statusCode, 401);
  assert.equal((await useKey(fresh.token)).statusCode, 200);
  const list = (await req('/api/developer/keys', 'GET', undefined, a.cookie)).json().data;
  assert(list.find((k: any) => k.id === old.id).revoked_at);
  assert.deepEqual([...list.find((k: any) => k.id === fresh.id).scopes].sort(), ['crm:read', 'orders:read']);
  assert.equal((await state(a)).get(fresh.id).rotated_from_id, old.id);
  const audit = (await pool.query("SELECT user_id,detail FROM audit_events WHERE tenant_id=$1 AND action='api_key.rotated' AND entity_id=$2", [a.user.tenant_id, fresh.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user_id, a.user.id);
  assert.equal(audit[0].detail.rotated_from, old.id);
  assert.equal(audit[0].detail.overlap_seconds, 0);
  assert(!JSON.stringify(audit).includes(fresh.token) && !JSON.stringify(audit).includes(old.token));
  // One successor per key; a revoked key cannot be rotated again.
  assert.equal((await req('/api/developer/keys/' + old.id + '/rotate', 'POST', {}, a.cookie)).statusCode, 409);
});

test('API-001: an optional overlap keeps the old key valid only briefly, then it is refused', async () => {
  const a = await signup();
  const old = await key(a);
  const r = await req('/api/developer/keys/' + old.id + '/rotate', 'POST', { overlap_seconds: 2 }, a.cookie);
  assert.equal(r.statusCode, 201, r.body);
  assert.equal((await useKey(old.token)).statusCode, 200, 'still valid during the overlap');
  assert.equal((await req('/api/developer/keys/' + old.id + '/rotate', 'POST', {}, a.cookie)).statusCode, 409, 'one successor');
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.equal((await useKey(old.token)).statusCode, 401, 'refused after the overlap');
  assert.equal((await useKey(r.json().token)).statusCode, 200);
  assert.equal((await req('/api/developer/keys/' + old.id + '/rotate', 'POST', { overlap_seconds: 3601 }, a.cookie)).statusCode, 422);
});

test('API-001: viewer and operator cannot rotate or read key state; another workspace gets 404; an API key gets 403', async () => {
  const a = await signup(), viewer = await signup(), operator = await signup(), other = await signup();
  await join(a, viewer, 'viewer');
  await join(a, operator, 'operator');
  const k = await key(a);
  for (const who of [viewer, operator]) {
    assert.equal((await req('/api/developer/keys/' + k.id + '/rotate', 'POST', {}, who.cookie)).statusCode, 403);
    assert.equal((await req('/api/developer/keys/state', 'GET', undefined, who.cookie)).statusCode, 403);
  }
  assert.equal((await req('/api/developer/keys/' + k.id + '/rotate', 'POST', {}, other.cookie)).statusCode, 404);
  assert.equal((await req('/api/developer/keys/' + k.id + '/rotate', 'POST', {}, undefined, { authorization: 'Bearer ' + k.token })).statusCode, 403);
  assert.equal((await useKey(k.token)).statusCode, 200, 'refused rotations left the key alone');
});

test('API-001: last_used_at is written at most once a minute per key, not on every request', async () => {
  const a = await signup();
  const k = await key(a);
  assert.equal((await state(a)).get(k.id)?.last_used_at ?? null, null);
  const xmin = async () => (await pool.query('SELECT xmin::text x FROM auth237_api_key_state WHERE key_id=$1', [k.id])).rows[0]?.x;
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = process.hrtime.bigint();
    assert.equal((await useKey(k.token)).statusCode, 200);
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (i === 0) assert(await xmin(), 'first use is recorded');
  }
  const after20 = await xmin();
  const s = (await state(a)).get(k.id);
  assert(s.last_used_at && Date.now() - Date.parse(s.last_used_at) < 60000);
  assert.match(s.last_used_ip, /^10\.237\./);
  // Twenty requests, one row version: the touch is skipped while the stamp is younger than a minute.
  await useKey(k.token);
  assert.equal(await xmin(), after20);
  await pool.query("UPDATE auth237_api_key_state SET last_used_at=clock_timestamp()-interval '2 minutes' WHERE key_id=$1", [k.id]);
  const stale = await xmin();
  await useKey(k.token);
  assert.notEqual(await xmin(), stale, 'a stale stamp is refreshed');
  const median = [...times].sort((x, y) => x - y)[10];
  console.log(JSON.stringify({ api_key_requests: times.length, row_versions_written: 1, median_ms: median, times }));
});
