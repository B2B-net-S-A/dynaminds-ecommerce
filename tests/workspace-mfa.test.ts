import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { pimIncomplete, tenantDataDigest } from './torn-module-fixture';
import { totp } from '../server/totp';
import { tokenHash } from '../server/security';

assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
const password = 'WorkspaceMfa!2026';
const cookieOf = (r: any) => r.headers['set-cookie']?.toString().split(';')[0];
const req = (url: string, method: any = 'GET', payload?: any, cookie?: string, headers: any = {}) =>
  app.inject({ url, method, payload, headers: { ...(cookie ? { cookie } : {}), ...headers } });
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
    name: 'QA Workspace MFA',
    password,
    ...(extra.invitation_token
      ? {}
      : { organization: { name: 'QA Protected ' + randomUUID().slice(0, 8) } }),
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return { user: r.json().user, cookie: cookieOf(r), codes: [] as string[] };
}
async function enable(a: any) {
  const setup = await req('/api/auth/security/enroll', 'POST', { password }, a.cookie);
  assert.equal(setup.statusCode, 200, setup.body);
  const r = await req(
    '/api/auth/security/confirm',
    'POST',
    {
      password,
      code: totp(setup.json().secret),
    },
    a.cookie,
  );
  assert.equal(r.statusCode, 200, r.body);
  a.cookie = cookieOf(r);
  a.user = r.json().user;
  a.codes = r.json().recovery_codes;
  return r;
}
async function invite(a: any, email: string, role = 'operator') {
  const r = await req('/api/workspaces/invitations', 'POST', { email, role }, a.cookie);
  assert.equal(r.statusCode, 201, r.body);
  return r.json().token;
}
async function join(a: any, b: any, role = 'operator') {
  const token = await invite(a, b.user.email, role);
  const r = await req('/api/workspaces/invitations/accept', 'POST', { token }, b.cookie);
  assert.equal(r.statusCode, 200, r.body);
  b.cookie = cookieOf(r);
  b.user = r.json().user;
}
async function policy(a: any, required = true, version = 0, code = a.codes.shift(), pw = password) {
  return req(
    '/api/workspaces/security',
    'PATCH',
    {
      require_mfa: required,
      version,
      password: pw,
      code,
    },
    a.cookie,
  );
}
async function protect(a: any) {
  await enable(a);
  const r = await policy(a);
  assert.equal(r.statusCode, 200, r.body);
  a.cookie = cookieOf(r);
  a.user = r.json().user;
  assert.equal(r.json().policy.version, 1);
  return r;
}
async function switchTo(a: any, id: string) {
  const r = await req('/api/workspaces/switch', 'POST', { tenant_id: id }, a.cookie);
  assert.equal(r.statusCode, 200, r.body);
  a.cookie = cookieOf(r);
  a.user = r.json().user;
  return r;
}
async function stamp(a: any, value: string) {
  await pool.query(`UPDATE sessions SET mfa_verified_at=${value} WHERE token_hash=$1`, [
    tokenHash(a.cookie.split('=')[1]),
  ]);
}
async function checkBlocked(a: any, readOnly = false) {
  for (const [url, method, payload] of [
    ['/api/products', 'GET', undefined],
    ['/api/orders', 'GET', undefined],
    ['/api/dashboard', 'GET', undefined],
    ['/api/workspaces/settings', 'PATCH', { name: 'Bypass', locale: 'pl-PL' }],
    ['/api/products', 'POST', {}],
    ['/api/integrations/workspace', 'GET', undefined],
  ] as const) {
    const r = await req(url, method, payload, a.cookie);
    if (readOnly && method !== 'GET') {
      assert.equal(r.statusCode, 423);
      continue;
    }
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(r.json().code, 'MFA_REQUIRED');
  }
}

test('optional by default: no policy or MFA proof is invented for password sessions', async () => {
  const a = await signup();
  assert.equal(a.user.organization_requires_mfa, false);
  assert.equal(a.user.mfa_required, false);
  assert.equal((await req('/api/health')).json().workspace_mfa_available, true);
  assert.equal((await req('/api/products', 'GET', undefined, a.cookie)).statusCode, 200);
  const p = (await req('/api/workspaces/security', 'GET', undefined, a.cookie)).json();
  assert.equal(p.version, 0);
  assert.equal(p.require_mfa, false);
  assert.equal(p.members.length, 1);
  const s = (await pool.query('SELECT mfa_verified_at FROM sessions WHERE user_id=$1', [a.user.id]))
    .rows[0];
  assert.equal(s.mfa_verified_at, null);
});
test('administrator policy requires own active MFA, password and fresh factor; audit excludes secrets', async () => {
  const a = await signup();
  assert.equal((await policy(a, true, 0, 'bad')).statusCode, 409);
  await enable(a);
  assert.equal((await policy(a, true, 0, a.codes[0], 'wrong')).statusCode, 401);
  const r = await policy(a, true, 0, a.codes[0]);
  assert.equal(r.statusCode, 200, r.body);
  a.cookie = cookieOf(r);
  assert.equal(r.json().user.mfa_required, false);
  assert.equal(r.json().user.organization_requires_mfa, true);
  const oldCode = await policy(a, false, 1, a.codes[0]);
  assert.equal(oldCode.statusCode, 401);
  const audit = JSON.stringify(
    (
      await pool.query(
        "SELECT detail FROM audit_events WHERE tenant_id=$1 AND action='workspace.mfa_policy_changed'",
        [a.user.tenant_id],
      )
    ).rows,
  );
  assert(!audit.includes(password));
  assert(!audit.includes(a.codes[0]));
  assert(audit.includes('recovery'));
});
test('existing non-enrolled member is gated immediately and enrollment restores business access', async () => {
  const a = await signup(),
    b = await signup();
  await join(a, b);
  await protect(a);
  await checkBlocked(b);
  for (const path of ['/api/auth/me', '/api/auth/security', '/api/workspaces'])
    assert.equal((await req(path, 'GET', undefined, b.cookie)).statusCode, 200);
  const me = (await req('/api/auth/me', 'GET', undefined, b.cookie)).json().user;
  assert.equal(me.mfa_enrollment_required, true);
  assert.equal((await req('/api/workspaces/security', 'GET', undefined, b.cookie)).statusCode, 403);
  const r = await enable(b);
  assert.equal(r.json().recovery_codes.length, 8);
  assert.equal(b.user.mfa_required, false);
  assert.equal((await req('/api/products', 'GET', undefined, b.cookie)).statusCode, 200);
  const p = (await req('/api/workspaces/security', 'GET', undefined, b.cookie)).json();
  assert.equal(p.require_mfa, true);
  assert.equal(p.members, undefined);
  assert.equal((await policy(b, false, 1)).statusCode, 403);
});
test('password login and signup with protected invitation yield restricted sessions, never business access', async () => {
  const a = await signup(),
    b = await signup();
  await join(a, b);
  await protect(a);
  const login = await req('/api/auth/login', 'POST', { email: b.user.email, password });
  assert.equal(login.statusCode, 200, login.body);
  b.cookie = cookieOf(login);
  // Login selects the original optional organization; switching back enforces the protected policy.
  await switchTo(b, a.user.tenant_id);
  await checkBlocked(b);
  const email = randomUUID() + '@example.test',
    token = await invite(a, email);
  const invited = await signup({ email, invitation_token: token });
  assert.equal(invited.user.tenant_id, a.user.tenant_id);
  assert.equal(invited.user.mfa_required, true);
  await checkBlocked(invited);
});
test('step-up rotates only current session, rejects old cookie and preserves another proven session', async () => {
  const a = await signup();
  await protect(a);
  const other = await req('/api/auth/login', 'POST', {
    email: a.user.email,
    password,
    code: a.codes.shift(),
  });
  assert.equal(other.statusCode, 200, other.body);
  const otherCookie = cookieOf(other),
    old = a.cookie;
  await stamp(a, 'NULL');
  await checkBlocked(a);
  const me = (await req('/api/auth/me', 'GET', undefined, a.cookie)).json().user;
  assert.equal(me.mfa_enrollment_required, false);
  const r = await req(
    '/api/auth/security/verify',
    'POST',
    { password, code: a.codes.shift() },
    a.cookie,
  );
  assert.equal(r.statusCode, 200, r.body);
  a.cookie = cookieOf(r);
  assert.equal(r.json().user.mfa_required, false);
  assert.equal((await req('/api/auth/me', 'GET', undefined, old)).statusCode, 401);
  assert.equal((await req('/api/products', 'GET', undefined, otherCookie)).statusCode, 200);
  assert.equal((await req('/api/products', 'GET', undefined, a.cookie)).statusCode, 200);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [a.user.id])).rows[0]
      .n,
    2,
  );
});
test('8-hour proof deadline survives workspace switches; optional organization stays accessible', async () => {
  const a = await signup();
  await protect(a);
  const create = await req(
    '/api/workspaces',
    'POST',
    { name: 'Optional ' + randomUUID(), currency: 'PLN', locale: 'pl-PL' },
    a.cookie,
  );
  assert.equal(create.statusCode, 201, create.body);
  const protectedId = a.user.tenant_id;
  a.cookie = cookieOf(create);
  a.user = create.json().user;
  const optionalId = a.user.tenant_id;
  await stamp(a, "now()-interval '9 hours'");
  const original = (
    await pool.query('SELECT mfa_verified_at FROM sessions WHERE token_hash=$1', [
      tokenHash(a.cookie.split('=')[1]),
    ])
  ).rows[0].mfa_verified_at;
  assert.equal((await req('/api/products', 'GET', undefined, a.cookie)).statusCode, 200);
  await switchTo(a, protectedId);
  assert.equal(a.user.mfa_required, true);
  await checkBlocked(a);
  const inherited = (
    await pool.query('SELECT mfa_verified_at FROM sessions WHERE token_hash=$1', [
      tokenHash(a.cookie.split('=')[1]),
    ])
  ).rows[0].mfa_verified_at;
  assert.equal(inherited.toISOString(), original.toISOString());
  await switchTo(a, optionalId);
  assert.equal(a.user.mfa_required, false);
});
test('required membership prevents disabling global MFA even from another optional firm and does not consume factor', async () => {
  const a = await signup(),
    b = await signup();
  await join(a, b);
  await protect(a);
  await enable(b);
  const optional = await req(
    '/api/workspaces',
    'POST',
    { name: 'Own optional', currency: 'PLN', locale: 'pl-PL' },
    b.cookie,
  );
  assert.equal(optional.statusCode, 201, optional.body);
  b.cookie = cookieOf(optional);
  b.user = optional.json().user;
  const code = b.codes.shift();
  const denied = await req('/api/auth/security/disable', 'POST', { password, code }, b.cookie);
  assert.equal(denied.statusCode, 409, denied.body);
  const status = (await req('/api/auth/security', 'GET', undefined, b.cookie)).json();
  assert.deepEqual(
    status.required_by_organizations.map((w: any) => w.id),
    [a.user.tenant_id],
  );
  const off = await policy(a, false, 1);
  assert.equal(off.statusCode, 200, off.body);
  a.cookie = cookieOf(off);
  const allowed = await req('/api/auth/security/disable', 'POST', { password, code }, b.cookie);
  assert.equal(allowed.statusCode, 200, allowed.body);
});
test('stale version leaves recovery proof unused and concurrent administrator edits have one winner', async () => {
  const a = await signup(),
    b = await signup();
  await join(a, b, 'admin');
  await enable(a);
  await enable(b);
  const results = await Promise.all([policy(a), policy(b)]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const winner = results[0].statusCode === 200 ? a : b,
    loser = winner === a ? b : a;
  winner.cookie = cookieOf(results[winner === a ? 0 : 1]);
  // Both proofs were shifted locally. The losing compare-and-set must not consume its code.
  const remaining = (await req('/api/auth/security', 'GET', undefined, loser.cookie)).json();
  assert.equal(remaining.recovery_remaining, 8);
  const first = await policy(winner, false, 0, winner.codes[0]);
  assert.equal(first.statusCode, 409);
  const retry = await policy(winner, false, 1, winner.codes[0]);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().policy.version, 2);
});
test('step-up invalid factors persist lockout across app instances and never issue a new cookie', async () => {
  const a = await signup();
  await protect(a);
  await stamp(a, 'NULL');
  for (let i = 0; i < 5; i++) {
    const r = await req(
      '/api/auth/security/verify',
      'POST',
      { password, code: 'invalid' },
      a.cookie,
    );
    assert.equal(r.statusCode, 401);
    assert.equal(cookieOf(r), undefined);
  }
  await app.close();
  app = await buildApp();
  const blocked = await req(
    '/api/auth/security/verify',
    'POST',
    { password, code: a.codes[0] },
    a.cookie,
  );
  assert.equal(blocked.statusCode, 429);
  assert.equal(
    (await pool.query('SELECT failures FROM account_security WHERE user_id=$1', [a.user.id]))
      .rows[0].failures,
    5,
  );
  await stamp(a, 'NULL');
  await checkBlocked(a);
});
test('API keys require enrolled owner under firm policy and cannot modify policy even after enrollment', async () => {
  const a = await signup(),
    b = await signup();
  await join(a, b, 'admin');
  const key = await req(
    '/api/developer/keys',
    'POST',
    { name: 'Before policy', scopes: ['orders:read'] },
    b.cookie,
  );
  assert.equal(key.statusCode, 201, key.body);
  const headers = { authorization: 'Bearer ' + key.json().token };
  await protect(a);
  assert.equal((await req('/api/v1/orders', 'GET', undefined, undefined, headers)).statusCode, 403);
  await enable(b);
  assert.equal((await req('/api/v1/orders', 'GET', undefined, undefined, headers)).statusCode, 200);
  await stamp(b, 'NULL'); // Service key needs active enrollment, not an interactive session proof.
  assert.equal((await req('/api/v1/orders', 'GET', undefined, undefined, headers)).statusCode, 200);
  assert.equal(
    (await req('/api/workspaces/security', 'GET', undefined, undefined, headers)).statusCode,
    403,
  );
  assert.equal(
    (
      await req(
        '/api/workspaces/security',
        'PATCH',
        { require_mfa: false, version: 1, password, code: b.codes[0] },
        undefined,
        headers,
      )
    ).statusCode,
    403,
  );
});
test('policy roster is tenant scoped and policy/session tables are unavailable to tenant SQL role', async () => {
  const a = await signup(),
    b = await signup();
  await protect(a);
  const p = (await req('/api/workspaces/security', 'GET', undefined, a.cookie)).json();
  assert(!JSON.stringify(p).includes(b.user.email));
  assert.equal(p.members[0].mfa_enabled, true);
  for (const sql of [
    'SELECT * FROM workspace_security_policies',
    'UPDATE workspace_security_policies SET require_mfa=false',
    'SELECT * FROM sessions',
  ])
    await assert.rejects(
      () => tenantTx(a.user.tenant_id, (c) => c.query(sql)),
      (e: any) => e.code === '42501',
    );
});
test('readonly preview preserves MFA login, exposes policy and rejects enrollment, step-up and policy writes', async () => {
  const a = await signup();
  await protect(a);
  await app.close();
  app = await buildApp({ readOnly: true });
  const login = await req('/api/auth/login', 'POST', {
    email: a.user.email,
    password,
    code: a.codes.shift(),
  });
  assert.equal(login.statusCode, 200, login.body);
  a.cookie = cookieOf(login);
  assert.match(a.cookie, /^dyna_session_preview_4101=/);
  assert.equal((await req('/api/workspaces/security', 'GET', undefined, a.cookie)).statusCode, 200);
  assert.equal((await policy(a, false, 1)).statusCode, 423);
  assert.equal(
    (await req('/api/auth/security/enroll', 'POST', { password }, a.cookie)).statusCode,
    423,
  );
  await stamp(a, 'NULL');
  assert.equal(
    (await req('/api/auth/security/verify', 'POST', { password, code: a.codes[0] }, a.cookie))
      .statusCode,
    423,
  );
  await checkBlocked(a, true); // Read operations are still protected when the proof is absent.
});
test('concurrent activation and global MFA disable serialize without leaving unprotected business access', async () => {
  const a = await signup(),
    b = await signup();
  await join(a, b);
  await enable(a);
  await enable(b);
  const [activation, disable] = await Promise.all([
    policy(a),
    req('/api/auth/security/disable', 'POST', { password, code: b.codes.shift() }, b.cookie),
  ]);
  assert.equal(activation.statusCode, 200, activation.body);
  assert([200, 409].includes(disable.statusCode), disable.body);
  if (disable.statusCode === 200) {
    b.cookie = cookieOf(disable);
    await checkBlocked(b);
  } else {
    assert.equal(
      (await req('/api/auth/security', 'GET', undefined, b.cookie)).json().enabled,
      true,
    );
    assert.equal((await req('/api/products', 'GET', undefined, b.cookie)).statusCode, 200);
  }
});
test('pre-policy schema dropped from the full schema fails closed with 503 and no effects; restored policy schema is a complete install again', async () => {
  const a = await signup();
  await enable(a);
  await pool.query(
    'DROP TABLE workspace_security_policies; ALTER TABLE sessions DROP COLUMN mfa_verified_at',
  );
  try {
    // In the fully migrated schema this is a torn install, not an older restored backup:
    // construction and tenant transactions fail closed (PIM integrity), with no write.
    const digest = await tenantDataDigest();
    await assert.rejects(buildApp(), pimIncomplete);
    assert.ok(a.user.tenant_id);
    await assert.rejects(
      tenantTx(a.user.tenant_id, (c) => c.query('SELECT 1')),
      pimIncomplete,
    );
    assert.deepEqual(await tenantDataDigest(), digest);
  } finally {
    await pool.query(
      await readFile(new URL('../server/057_workspace_mfa.sql', import.meta.url), 'utf8'),
    );
  }
  assert.equal((await pool.query('SELECT public.pim_dictionary_valid() valid')).rows[0].valid, true);
});
