import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { decrypt, tokenHash, checkPassword } from '../server/security';
import { totp } from '../server/totp';

assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
const oldPassword = 'RecoveryOriginal!2026',
  nextPassword = 'RecoveryChanged!2026';
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
async function signup() {
  const r = await req('/api/auth/signup', 'POST', {
    email: randomUUID() + '@example.test',
    name: 'QA Recovery',
    password: oldPassword,
    organization: { name: 'QA recovery ' + randomUUID().slice(0, 8) },
  });
  assert.equal(r.statusCode, 201, r.body);
  return { user: r.json().user, cookie: cookieOf(r) };
}
let linkRequestNumber = 0;
async function requestLink(a: any, headers: any = {}) {
  // Distinct source IPs exercise the durable per-address budget independently of the IP gate.
  const r = await app.inject({
    url: '/api/auth/password/request',
    method: 'POST',
    payload: { email: a.user.email },
    headers,
    remoteAddress: '127.0.1.' + ((++linkRequestNumber % 240) + 1),
  });
  assert.equal(r.statusCode, 202, r.body);
  const mail = (
    await pool.query(
      "SELECT body_encrypted FROM account_local_mail WHERE user_id=$1 AND kind='password_reset'",
      [a.user.id],
    )
  ).rows[0];
  assert(mail);
  return decrypt(mail.body_encrypted).url.split('#password-reset=')[1];
}
async function reset(token: string, extra: any = {}) {
  return req('/api/auth/password/reset', 'POST', {
    token,
    password: nextPassword,
    confirm_password: nextPassword,
    ...extra,
  });
}
async function freshLink(a: any) {
  await pool.query("UPDATE account_reset_limits SET last_request=now()-interval '2 minutes'");
  return requestLink(a);
}
async function enableMfa(a: any) {
  const enrolled = await req(
    '/api/auth/security/enroll',
    'POST',
    { password: oldPassword },
    a.cookie,
  );
  assert.equal(enrolled.statusCode, 200, enrolled.body);
  const confirmed = await req(
    '/api/auth/security/confirm',
    'POST',
    { password: oldPassword, code: totp(enrolled.json().secret) },
    a.cookie,
  );
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  a.cookie = cookieOf(confirmed);
  return confirmed.json().recovery_codes as string[];
}

test('known and unknown emails return the same generic 202, without a token or automatic login', async () => {
  const a = await signup();
  const before = (await pool.query('SELECT * FROM users WHERE id=$1', [a.user.id])).rows[0];
  const known = await req('/api/auth/password/request', 'POST', {
    email: a.user.email.toUpperCase(),
  });
  const unknown = await req('/api/auth/password/request', 'POST', {
    email: randomUUID() + '@example.test',
  });
  assert.equal(known.statusCode, 202);
  assert.equal(unknown.statusCode, 202);
  assert.deepEqual(known.json(), unknown.json());
  assert.equal(known.headers['cache-control'], 'no-store');
  assert.equal(known.headers['set-cookie'], undefined);
  assert.deepEqual(
    (await pool.query('SELECT * FROM users WHERE id=$1', [a.user.id])).rows[0],
    before,
  );
  assert.equal((await req('/api/auth/me', 'GET', undefined, a.cookie)).statusCode, 200);
  const mail = (await pool.query('SELECT * FROM account_local_mail WHERE user_id=$1', [a.user.id]))
    .rows[0];
  const body = decrypt(mail.body_encrypted),
    token = body.url.split('#password-reset=')[1];
  assert.match(token, /^[a-f0-9]{64}$/);
  assert(!mail.body_encrypted.includes(token));
  const record = (
    await pool.query('SELECT * FROM account_password_resets WHERE user_id=$1', [a.user.id])
  ).rows[0];
  assert.equal(record.token_hash, tokenHash(token));
  assert(!JSON.stringify(record).includes(token));
  assert.equal(
    new Date(record.expires_at).getTime() - new Date(record.created_at).getTime(),
    15 * 60000,
  );
});
test('reset revokes sessions in all organizations, preserves memberships and notifies without password', async () => {
  const a = await signup();
  const second = await req('/api/workspaces', 'POST', { name: 'Second recovery org' }, a.cookie);
  assert.equal(second.statusCode, 201, second.body);
  const cookie2 = cookieOf(second);
  const token = await requestLink(a);
  const r = await reset(token);
  assert.equal(r.statusCode, 200, r.body);
  assert(r.json().sessions_revoked);
  assert.equal(r.headers['set-cookie'], undefined);
  for (const cookie of [a.cookie, cookie2])
    assert.equal((await req('/api/auth/me', 'GET', undefined, cookie)).statusCode, 401);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [a.user.id])).rows[0]
      .n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM memberships WHERE user_id=$1', [a.user.id]))
      .rows[0].n,
    2,
  );
  assert.equal(
    (await req('/api/auth/login', 'POST', { email: a.user.email, password: oldPassword }))
      .statusCode,
    401,
  );
  assert.equal(
    (await req('/api/auth/login', 'POST', { email: a.user.email, password: nextPassword }))
      .statusCode,
    200,
  );
  assert.equal((await reset(token)).statusCode, 401);
  const mails = (await pool.query('SELECT * FROM account_local_mail WHERE user_id=$1', [a.user.id]))
    .rows;
  assert.equal(mails.length, 1);
  assert.equal(mails[0].kind, 'password_changed');
  const text = JSON.stringify(decrypt(mails[0].body_encrypted));
  assert(!text.includes(nextPassword));
  assert(!text.includes(token));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM audit_events WHERE user_id=$1 AND action='account.password_reset'",
        [a.user.id],
      )
    ).rows[0].n,
    2,
  );
});
test('expired, unknown and superseded links cannot change passwords', async () => {
  const a = await signup(),
    old = await requestLink(a),
    replacement = await freshLink(a);
  assert.notEqual(old, replacement);
  assert.equal((await reset(old)).statusCode, 401);
  await pool.query(
    "UPDATE account_password_resets SET created_at=now()-interval '20 minutes',expires_at=now()-interval '5 minutes' WHERE user_id=$1",
    [a.user.id],
  );
  assert.equal((await reset(replacement)).statusCode, 401);
  assert.equal((await reset('a'.repeat(64))).statusCode, 401);
  assert(
    checkPassword(
      oldPassword,
      (await pool.query('SELECT password_hash FROM users WHERE id=$1', [a.user.id])).rows[0]
        .password_hash,
    ),
  );
});
test('two concurrent reset attempts consume the link exactly once', async () => {
  const a = await signup(),
    token = await requestLink(a);
  const rs = await Promise.all([reset(token), reset(token)]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 401]);
  assert.equal(
    (await pool.query('SELECT version FROM account_security WHERE user_id=$1', [a.user.id])).rows[0]
      .version,
    '1',
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM account_local_mail WHERE user_id=$1', [
        a.user.id,
      ])
    ).rows[0].n,
    1,
  );
});
test('email cooldown and hourly quota survive app rebuild, suppressing mail without account lockout', async () => {
  const a = await signup(),
    token = await requestLink(a);
  assert.equal(await requestLink(a), token);
  await app.close();
  app = await buildApp();
  assert.equal(await requestLink(a), token);
  let last = token;
  for (let i = 0; i < 4; i++) {
    const next = await freshLink(a);
    assert.notEqual(next, last);
    last = next;
  }
  assert.equal(await freshLink(a), last);
  assert.equal((await req('/api/auth/me', 'GET', undefined, a.cookie)).statusCode, 200);
  await pool.query(
    "UPDATE account_reset_limits SET window_start=now()-interval '2 hours',last_request=now()-interval '2 minutes'",
  );
  await app.close();
  app = await buildApp();
  assert.notEqual(await requestLink(a), last);
});
test('simultaneous requests for one email produce one token and one mail', async () => {
  const a = await signup();
  const rs = await Promise.all([requestLink(a), requestLink(a)]);
  assert.equal(rs[0], rs[1]);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM account_local_mail WHERE user_id=$1', [
        a.user.id,
      ])
    ).rows[0].n,
    1,
  );
});
test('MFA is required, preserved, and recovery codes are consumed once', async () => {
  const a = await signup(),
    codes = await enableMfa(a),
    token = await requestLink(a);
  const before = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [a.user.id]))
    .rows[0];
  const challenge = await reset(token);
  assert.equal(challenge.statusCode, 200);
  assert.deepEqual(challenge.json(), { mfa_required: true });
  assert.equal((await req('/api/auth/me', 'GET', undefined, a.cookie)).statusCode, 200);
  assert.equal((await reset(token, { code: codes[0] })).statusCode, 200);
  const after = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [a.user.id]))
    .rows[0];
  assert.equal(after.secret_encrypted, before.secret_encrypted);
  assert.equal(after.last_step, before.last_step);
  assert.equal(after.recovery_hashes.length, 7);
  assert(after.enabled_at);
  assert.equal(BigInt(after.version), BigInt(before.version) + 1n);
  const login = await req('/api/auth/login', 'POST', {
    email: a.user.email,
    password: nextPassword,
  });
  assert.deepEqual(login.json(), { mfa_required: true });
  assert.equal(
    (
      await req('/api/auth/login', 'POST', {
        email: a.user.email,
        password: nextPassword,
        code: codes[0],
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await req('/api/auth/login', 'POST', {
        email: a.user.email,
        password: nextPassword,
        code: codes[1],
      })
    ).statusCode,
    200,
  );
});
test('wrong MFA attempts commit lockout without consuming link or changing password', async () => {
  const a = await signup();
  await enableMfa(a);
  const token = await requestLink(a);
  for (let i = 0; i < 5; i++)
    assert.equal((await reset(token, { code: 'INVALID' })).statusCode, 401);
  assert.equal((await reset(token, { code: 'INVALID' })).statusCode, 429);
  const row = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [a.user.id]))
    .rows[0];
  assert.equal(row.failures, 5);
  assert(row.locked_until);
  assert(
    checkPassword(
      oldPassword,
      (await pool.query('SELECT password_hash FROM users WHERE id=$1', [a.user.id])).rows[0]
        .password_hash,
    ),
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM account_password_resets WHERE user_id=$1', [
        a.user.id,
      ])
    ).rows[0].n,
    1,
  );
});
test('normal password change or security version change invalidates an outstanding reset', async () => {
  const a = await signup(),
    token = await requestLink(a);
  const changed = await req(
    '/api/auth/security/password',
    'POST',
    { password: oldPassword, new_password: nextPassword },
    a.cookie,
  );
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await reset(token)).statusCode, 401);
  const second = await freshLink(a);
  await pool.query('UPDATE account_security SET version=version+1 WHERE user_id=$1', [a.user.id]);
  assert.equal((await reset(second)).statusCode, 401);
});
test('pending MFA enrollment is cleared after password recovery', async () => {
  const a = await signup();
  assert.equal(
    (await req('/api/auth/security/enroll', 'POST', { password: oldPassword }, a.cookie))
      .statusCode,
    200,
  );
  assert.equal((await reset(await requestLink(a))).statusCode, 200);
  const row = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [a.user.id]))
    .rows[0];
  assert.equal(row.pending_encrypted, null);
  assert.equal(row.pending_session_hash, null);
  assert.equal(row.pending_expires_at, null);
  assert.equal(row.enabled_at, null);
});
test('tenant SQL cannot read or modify account recovery, limits or encrypted mailbox', async () => {
  const a = await signup();
  await requestLink(a);
  for (const table of ['account_password_resets', 'account_reset_limits', 'account_local_mail']) {
    await assert.rejects(
      tenantTx(a.user.tenant_id, (c) => c.query('SELECT * FROM ' + table)),
      /permission denied/,
    );
    await assert.rejects(
      tenantTx(a.user.tenant_id, (c) => c.query('DELETE FROM ' + table)),
      /permission denied/,
    );
  }
  assert.equal(
    (await req('/api/auth/password/mailbox', 'GET', undefined, a.cookie)).statusCode,
    404,
  );
});
test('untrusted origins are refused and Host cannot inject a reset URL', async () => {
  const a = await signup();
  assert.equal(
    (
      await req('/api/auth/password/request', 'POST', { email: a.user.email }, undefined, {
        origin: 'https://evil.example',
      })
    ).statusCode,
    403,
  );
  const token = await requestLink(a, { host: 'evil.example' });
  const mail = decrypt(
    (
      await pool.query(
        "SELECT body_encrypted FROM account_local_mail WHERE user_id=$1 AND kind='password_reset'",
        [a.user.id],
      )
    ).rows[0].body_encrypted,
  );
  assert.equal(mail.url, 'http://127.0.0.1:5173/#password-reset=' + token);
  assert.equal((await reset(token, { redirect: 'https://evil.example' })).statusCode, 422);
});
test('password policy, confirmation, malformed token and body fields are validated without consumption', async () => {
  const a = await signup(),
    token = await requestLink(a);
  assert.equal(
    (await reset(token, { password: 'short', confirm_password: 'short' })).statusCode,
    422,
  );
  assert.equal((await reset(token, { confirm_password: 'OtherPassword!2026' })).statusCode, 422);
  assert.equal((await reset('../invalid')).statusCode, 422);
  assert.equal((await reset(token)).statusCode, 200);
});
test('read-only restore blocks both public mutations; database-bound links cannot migrate', async () => {
  const a = await signup(),
    token = await requestLink(a);
  const preview = await buildApp({ readOnly: true });
  try {
    for (const url of ['/api/auth/password/request', '/api/auth/password/reset'])
      assert.equal((await preview.inject({ url, method: 'POST', payload: {} })).statusCode, 423);
  } finally {
    await preview.close();
  }
  await pool.query(
    "UPDATE account_password_resets SET database_name='different_database' WHERE user_id=$1",
    [a.user.id],
  );
  assert.equal((await reset(token)).statusCode, 401);
});
test('older restored schemas register routes with explicit unavailable responses', async () => {
  await pool.query('ALTER TABLE account_password_resets RENAME TO qa_hidden_password_resets');
  try {
    const legacy = await buildApp();
    try {
      assert.equal(
        (await legacy.inject({ url: '/api/health' })).json().password_recovery_available,
        false,
      );
      assert.equal(
        (
          await legacy.inject({
            url: '/api/auth/password/request',
            method: 'POST',
            payload: { email: 'unknown@example.test' },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await legacy.inject({ url: '/api/auth/password/reset', method: 'POST', payload: {} }))
          .statusCode,
        404,
      );
    } finally {
      await legacy.close();
    }
  } finally {
    await pool.query('ALTER TABLE qa_hidden_password_resets RENAME TO account_password_resets');
  }
});

test('IP limiter rejects the sixth request even when emails differ', async () => {
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await req('/api/auth/password/request', 'POST', { email: randomUUID() + '@example.test' }))
        .statusCode,
      202,
    );
  assert.equal(
    (await req('/api/auth/password/request', 'POST', { email: randomUUID() + '@example.test' }))
      .statusCode,
    429,
  );
});
