import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { base32, unbase32, hotp, totp, matchedStep, totpStep } from '../server/totp';
import { decrypt, tokenHash } from '../server/security';

assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
const password = 'AccountSecurity!2026';
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
test('public integration API keys cannot read or mutate account security', async () => {
  const a = await signup();
  const key = await req(
    '/api/developer/keys',
    'POST',
    { name: 'QA key', scopes: ['orders:read'] },
    a.cookie,
  );
  assert.equal(key.statusCode, 201, key.body);
  const headers = { authorization: 'Bearer ' + key.json().token };
  assert.equal(
    (await req('/api/auth/security', 'GET', undefined, undefined, headers)).statusCode,
    403,
  );
  assert.equal(
    (await req('/api/auth/security/enroll', 'POST', { password }, undefined, headers)).statusCode,
    403,
  );
  assert.equal((await status(a)).enabled, false);
});
async function signup() {
  const r = await req('/api/auth/signup', 'POST', {
    email: randomUUID() + '@example.test',
    name: 'QA MFA',
    password,
    organization: { name: 'QA MFA ' + randomUUID().slice(0, 8) },
  });
  assert.equal(r.statusCode, 201, r.body);
  return { user: r.json().user, cookie: cookieOf(r), codes: [] as string[], secret: '' };
}
async function login(a: any, code?: string, pw = password, extra: any = {}) {
  return req('/api/auth/login', 'POST', {
    email: a.user.email,
    password: pw,
    ...(code ? { code } : {}),
    ...extra,
  });
}
async function status(a: any) {
  const r = await req('/api/auth/security', 'GET', undefined, a.cookie);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function enroll(a: any) {
  const r = await req('/api/auth/security/enroll', 'POST', { password }, a.cookie);
  assert.equal(r.statusCode, 200, r.body);
  a.secret = r.json().secret;
  return r.json();
}
async function enable(a: any) {
  await enroll(a);
  const r = await req(
    '/api/auth/security/confirm',
    'POST',
    { password, code: totp(a.secret) },
    a.cookie,
  );
  assert.equal(r.statusCode, 200, r.body);
  a.cookie = cookieOf(r);
  a.codes = r.json().recovery_codes;
  return r;
}
async function security(a: any, action: string, code?: string, extra: any = {}) {
  return req(
    '/api/auth/security/' + action,
    'POST',
    { password, ...(code ? { code } : {}), ...extra },
    a.cookie,
  );
}

test('RFC 4226 HOTP: all ten official vectors and canonical Base32 round trips', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  const codes = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  codes.forEach((code, i) => assert.equal(hotp(secret, BigInt(i)), code));
  for (const len of [1, 2, 5, 20, 32, 64]) {
    const bytes = randomBytes(len);
    assert.deepEqual(unbase32(base32(bytes)), bytes);
  }
  assert.throws(() => unbase32('bad+secret'));
});
test('RFC 6238: official SHA1/SHA256/SHA512 vectors, including year 2603', () => {
  const timestamps = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
  const expected = {
    sha1: ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'],
    sha256: ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706'],
    sha512: ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826'],
  };
  for (const algorithm of ['sha1', 'sha256', 'sha512'] as const) {
    const len = algorithm === 'sha1' ? 20 : algorithm === 'sha256' ? 32 : 64;
    const secret = base32(Buffer.from('1234567890'.repeat(7).slice(0, len)));
    timestamps.forEach((time, i) =>
      assert.equal(totp(secret, time * 1000, 8, algorithm), expected[algorithm][i]),
    );
  }
});
test('TOTP permits one adjacent step, rejects replay, malformed codes and wider drift', () => {
  const secret = base32(randomBytes(20)),
    now = 1700000100000,
    step = totpStep(now);
  assert.equal(matchedStep(secret, hotp(secret, step), -1n, now), step);
  assert.equal(matchedStep(secret, hotp(secret, step + 1n), -1n, now), step + 1n);
  assert.equal(matchedStep(secret, hotp(secret, step - 1n), -1n, now), step - 1n);
  assert.equal(matchedStep(secret, hotp(secret, step), step, now), undefined);
  assert.equal(matchedStep(secret, hotp(secret, step + 3n), -1n, now), undefined);
  assert.equal(matchedStep(secret, '12e345', -1n, now), undefined);
});
test('enrollment is encrypted, session-bound, expires and leaves old login working until confirmation', async () => {
  const a = await signup(),
    other = cookieOf(await login(a)),
    setup = await enroll(a);
  assert.match(setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.qr, /^data:image\/png;base64,/);
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  const row = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [a.user.id]))
    .rows[0];
  assert(!row.pending_encrypted.includes(setup.secret));
  assert.equal(decrypt(row.pending_encrypted).secret, setup.secret);
  assert.equal((await status(a)).enabled, false);
  assert.equal((await login(a)).statusCode, 200);
  assert.equal(
    (await req('/api/auth/security/confirm', 'POST', { password, code: totp(a.secret) }, other))
      .statusCode,
    409,
  );
  await pool.query(
    "UPDATE account_security SET pending_expires_at=now()-interval '1 second' WHERE user_id=$1",
    [a.user.id],
  );
  assert.equal((await security(a, 'confirm', totp(a.secret))).statusCode, 409);
});
test('confirmation requires password and code, rotates all sessions and never exposes saved secrets or recovery plaintext', async () => {
  const a = await signup(),
    old = a.cookie,
    other = cookieOf(await login(a));
  await enroll(a);
  assert.equal((await security(a, 'confirm', 'bad')).statusCode, 401);
  assert.equal(
    (
      await req(
        '/api/auth/security/confirm',
        'POST',
        { password: 'wrong', code: totp(a.secret) },
        old,
      )
    ).statusCode,
    401,
  );
  const r = await security(a, 'confirm', totp(a.secret));
  assert.equal(r.statusCode, 200, r.body);
  a.cookie = cookieOf(r);
  a.codes = r.json().recovery_codes;
  assert.equal(a.codes.length, 8);
  assert.notEqual(a.cookie, old);
  assert.equal(r.json().token, undefined);
  for (const cookie of [old, other])
    assert.equal((await req('/api/auth/me', 'GET', undefined, cookie)).statusCode, 401);
  const s = await status(a);
  assert.equal(s.enabled, true);
  assert.equal(s.sessions.length, 1);
  assert.equal(s.recovery_remaining, 8);
  const stored = JSON.stringify(
    (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [a.user.id])).rows,
  );
  assert(!stored.includes(a.secret));
  for (const code of a.codes) assert(!stored.includes(code.replaceAll('-', '')));
  for (const field of [
    'secret',
    'secret_encrypted',
    'recovery_codes',
    'pending_encrypted',
    'token_hash',
    'version',
  ])
    assert(!JSON.stringify(s).includes('"' + field + '"'));
  const audit = JSON.stringify(
    (await pool.query('SELECT * FROM audit_events WHERE tenant_id=$1', [a.user.tenant_id])).rows,
  );
  assert(!audit.includes(a.secret));
  assert(!audit.includes(a.codes[0]));
  assert(!audit.includes(password));
});
test('password-only login issues no session, recovery code is single-use and confirmation TOTP cannot be replayed', async () => {
  const a = await signup();
  await enable(a);
  const count = (await pool.query('SELECT count(*) FROM sessions WHERE user_id=$1', [a.user.id]))
    .rows[0].count;
  const required = await login(a);
  assert.deepEqual(required.json(), { mfa_required: true });
  assert.equal(cookieOf(required), undefined);
  assert.equal(
    (await pool.query('SELECT count(*) FROM sessions WHERE user_id=$1', [a.user.id])).rows[0].count,
    count,
  );
  assert.equal((await login(a, totp(a.secret))).statusCode, 401);
  const ok = await login(a, a.codes[0].toLowerCase());
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await login(a, a.codes[0])).statusCode, 401);
  assert.equal((await status(a)).recovery_remaining, 7);
});
test('simultaneous TOTP and recovery logins consume exactly one proof each', async () => {
  const a = await signup();
  await enable(a);
  const results = await Promise.all([login(a, a.codes[0]), login(a, a.codes[0])]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 401]);
  const future = hotp(a.secret, totpStep() + 1n);
  const next = await Promise.all([login(a, future), login(a, future)]);
  assert.deepEqual(next.map((r) => r.statusCode).sort(), [200, 401]);
  assert.equal((await status(a)).recovery_remaining, 7);
});
test('five persisted failures block the account across app instances and reset only after the lock expires', async () => {
  const a = await signup();
  await enable(a);
  for (let i = 0; i < 5; i++) assert.equal((await login(a, 'bad')).statusCode, 401);
  assert.equal((await login(a, a.codes[0])).statusCode, 429);
  await app.close();
  app = await buildApp();
  assert.equal((await login(a, a.codes[0])).statusCode, 429);
  assert.equal((await security(a, 'disable', a.codes[0])).statusCode, 429);
  await pool.query(
    "UPDATE account_security SET locked_until=now()-interval '1 second' WHERE user_id=$1",
    [a.user.id],
  );
  assert.equal((await login(a, a.codes[0])).statusCode, 200);
  assert.equal(
    (
      await pool.query('SELECT failures,locked_until FROM account_security WHERE user_id=$1', [
        a.user.id,
      ])
    ).rows[0].failures,
    0,
  );
});
test('new recovery codes replace old ones and revoke other sessions; disabling requires both factors', async () => {
  const a = await signup();
  await enable(a);
  const old = a.cookie,
    other = cookieOf(await login(a, a.codes[0]));
  const r = await security(a, 'recovery', a.codes[1]);
  assert.equal(r.statusCode, 200, r.body);
  a.cookie = cookieOf(r);
  const codes = r.json().recovery_codes;
  assert.equal((await login(a, a.codes[2])).statusCode, 401);
  for (const cookie of [old, other])
    assert.equal((await req('/api/auth/me', 'GET', undefined, cookie)).statusCode, 401);
  assert.equal((await security(a, 'disable')).statusCode, 401);
  const disabled = await security(a, 'disable', codes[0]);
  assert.equal(disabled.statusCode, 200, disabled.body);
  a.cookie = cookieOf(disabled);
  assert.equal((await status(a)).enabled, false);
  assert.equal((await status(a)).recovery_remaining, 0);
  assert.equal((await login(a)).statusCode, 200);
});
test('MFA persists across organizations, switch rotates session and revocation cannot affect another account', async () => {
  const a = await signup(),
    b = await signup();
  await enable(a);
  const organization = await req(
    '/api/workspaces',
    'POST',
    { name: 'Druga firma MFA', currency: 'EUR' },
    a.cookie,
  );
  assert.equal(organization.statusCode, 201, organization.body);
  a.cookie = cookieOf(organization);
  assert.equal((await status(a)).enabled, true);
  const other = cookieOf(await login(a, a.codes[0])),
    s = await status(a),
    otherSession = s.sessions.find((v: any) => !v.current);
  const foreign = (await status(b)).sessions[0];
  assert.equal(
    (await req('/api/auth/security/sessions/' + foreign.id, 'DELETE', undefined, a.cookie))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await req(
        '/api/auth/security/sessions/' + s.sessions.find((v: any) => v.current).id,
        'DELETE',
        undefined,
        a.cookie,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await req('/api/auth/security/sessions/' + otherSession.id, 'DELETE', undefined, a.cookie))
      .statusCode,
    200,
  );
  assert.equal((await req('/api/auth/me', 'GET', undefined, other)).statusCode, 401);
  assert.equal((await status(b)).enabled, false);
});
test('password change validates length and factor, preserves MFA, revokes sessions and invalidates pending enrollment', async () => {
  const a = await signup();
  await enable(a);
  const old = a.cookie,
    other = cookieOf(await login(a, a.codes[0]));
  assert.equal(
    (await security(a, 'password', a.codes[1], { new_password: 'short' })).statusCode,
    422,
  );
  assert.equal(
    (await security(a, 'password', 'bad', { new_password: 'NewPassword!2026' })).statusCode,
    401,
  );
  const changed = await security(a, 'password', a.codes[1], { new_password: 'NewPassword!2026' });
  assert.equal(changed.statusCode, 200, changed.body);
  a.cookie = cookieOf(changed);
  for (const cookie of [old, other])
    assert.equal((await req('/api/auth/me', 'GET', undefined, cookie)).statusCode, 401);
  assert.equal((await login(a, a.codes[2])).statusCode, 401);
  assert.equal((await login(a, a.codes[2], 'NewPassword!2026')).statusCode, 200);
  assert.equal((await status(a)).enabled, true);
  const b = await signup();
  await enroll(b);
  const r = await security(b, 'password', undefined, { new_password: 'ChangedLocal!2026' });
  assert.equal(r.statusCode, 200);
  b.cookie = cookieOf(r);
  assert.equal((await status(b)).pending_expires_at, null);
  assert.equal(
    (
      await req(
        '/api/auth/security/confirm',
        'POST',
        { password: 'ChangedLocal!2026', code: totp(b.secret) },
        b.cookie,
      )
    ).statusCode,
    409,
  );
});
test('login with an invitation requires MFA before consuming the invitation or granting membership', async () => {
  const a = await signup(),
    owner = await signup();
  await enable(a);
  const invite = await req(
    '/api/workspaces/invitations',
    'POST',
    { email: a.user.email, role: 'viewer' },
    owner.cookie,
  );
  assert.equal(invite.statusCode, 201);
  assert.deepEqual(
    (await login(a, undefined, password, { invitation_token: invite.json().token })).json(),
    { mfa_required: true },
  );
  assert.equal(
    (
      await pool.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
        owner.user.tenant_id,
        a.user.id,
      ])
    ).rowCount,
    0,
  );
  const accepted = await login(a, a.codes[0], password, { invitation_token: invite.json().token });
  assert.equal(accepted.statusCode, 200, accepted.body);
  a.cookie = cookieOf(accepted);
  assert.equal(accepted.json().user.role, 'viewer');
  assert.equal((await status(a)).enabled, true);
});
test('tenant role cannot read authentication tables or override a different account MFA', async () => {
  const a = await signup(),
    b = await signup();
  await enable(a);
  const c = await pool.connect();
  try {
    for (const table of ['account_security', 'sessions', 'users'])
      for (const permission of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        assert.equal(
          (
            await c.query('SELECT has_table_privilege($1,$2,$3) allowed', [
              'dyna_app',
              table,
              permission,
            ])
          ).rows[0].allowed,
          false,
        );
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(c.query('SELECT * FROM account_security'), /permission denied/);
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
  assert.equal(
    (
      await req(
        '/api/auth/security/disable',
        'POST',
        { password, code: a.codes[0], user_id: a.user.id },
        b.cookie,
      )
    ).statusCode,
    409,
  );
  assert.equal((await status(a)).enabled, true);
});
test('read-only recovery preview requires MFA login and blocks all account mutations with its own cookie', async () => {
  const a = await signup();
  await enable(a);
  const preview = await buildApp({ readOnly: true, previewPort: 4102 });
  try {
    const required = await preview.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: a.user.email, password },
    });
    assert.equal(required.json().mfa_required, true);
    const logged = await preview.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: a.user.email, password, code: a.codes[0] },
    });
    assert.equal(logged.statusCode, 200, logged.body);
    assert.match(cookieOf(logged), /^dyna_session_preview_4102=/);
    const headers = { cookie: cookieOf(logged) };
    assert.equal((await preview.inject({ url: '/api/auth/security', headers })).statusCode, 200);
    for (const action of ['enroll', 'confirm', 'disable', 'recovery', 'password'])
      assert.equal(
        (
          await preview.inject({
            url: '/api/auth/security/' + action,
            method: 'POST',
            headers,
            payload: { password, code: a.codes[1] },
          })
        ).statusCode,
        423,
      );
    assert.equal(
      (await preview.inject({ url: '/api/auth/security/enroll', method: 'DELETE', headers }))
        .statusCode,
      423,
    );
  } finally {
    await preview.close();
  }
});
test('cancel and replacement invalidate pending setup, and stale account generations cannot authenticate', async () => {
  const a = await signup(),
    first = await enroll(a);
  await enroll(a);
  const current = (
    await pool.query('SELECT pending_encrypted FROM account_security WHERE user_id=$1', [a.user.id])
  ).rows[0];
  assert.notEqual(decrypt(current.pending_encrypted).secret, first.secret);
  assert.equal(
    (await req('/api/auth/security/enroll', 'DELETE', undefined, a.cookie)).statusCode,
    200,
  );
  assert.equal((await security(a, 'confirm', totp(a.secret))).statusCode, 409);
  await enable(a);
  await pool.query('UPDATE sessions SET account_version=account_version-1 WHERE token_hash=$1', [
    tokenHash(a.cookie.split('=')[1]),
  ]);
  assert.equal((await req('/api/auth/me', 'GET', undefined, a.cookie)).statusCode, 401);
  assert.equal(
    (await req('/api/workspaces', 'POST', { name: 'Nieautoryzowana firma' }, a.cookie)).statusCode,
    401,
  );
});
