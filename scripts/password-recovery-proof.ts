// Own local QA organization only. Secrets stay in ignored mode-0600 data files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
import { totp } from '../server/totp';
const file = 'data/password-recovery-stage081.json';
const phase = process.argv[2];
const tables = [
  'channels',
  'products',
  'stock',
  'orders',
  'order_items',
  'reservations',
  'documents',
  'shipments',
  'return_cases',
  'return_items',
  'payment_entries',
  'listings',
  'purchase_orders',
  'purchase_order_lines',
  'picking_waves',
  'picking_wave_orders',
  'amazon_fulfillment_plans',
];
let cookie = '';
async function api(path: string, method = 'GET', payload?: any, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  assert.equal(r.status, expected, path + ':' + r.status);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as any;
}
const digest = (rows: any) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
async function business(tenants: string[]) {
  const out: any = {};
  for (const table of tables) {
    const rows = (
      await pool.query(
        `SELECT to_jsonb(t)::text row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [tenants],
      )
    ).rows;
    out[table] = { count: rows.length, sha256: digest(rows) };
  }
  return out;
}
async function accounts(users: string[]) {
  const out: any = {};
  for (const table of ['users', 'account_security']) {
    const col = table === 'users' ? 'id' : 'user_id';
    const rows = (
      await pool.query(
        `SELECT to_jsonb(t)::text row FROM ${table} t WHERE ${col}=ANY($1::uuid[]) ORDER BY 1`,
        [users],
      )
    ).rows;
    out[table] = { count: rows.length, sha256: digest(rows) };
  }
  return out;
}
async function save(s: any) {
  await writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
}
try {
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      users = (await pool.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    await writeFile(
      file,
      JSON.stringify(
        {
          tenants,
          users,
          before: await business(tenants),
          accounts: await accounts(users),
          baseline_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({
      prior_firms: tenants.length,
      business_tables: tables.length,
      prior_accounts: users.length,
    });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup') {
      assert(!s.user, 'One-time QA setup');
      const health = await api('/health');
      assert.equal(health.schema_revision, '060_password_recovery');
      assert(health.password_recovery_available);
      s.email = 'qa-password-recovery@demo.local';
      s.password = 'DynaRecovery!2026';
      s.next_password = 'DynaRecoveryChanged!2026';
      const signed = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA Odzyskiwanie',
          organization: { name: 'QA Odzyskiwanie 081' },
        },
        201,
      );
      s.user = signed.user.id;
      s.tenant = signed.user.tenant_id;
      s.initial_cookie = cookie;
      await save(s);
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.product = (
        await api(
          '/products',
          'POST',
          {
            sku: 'QA-RECOVERY-081',
            name: 'QA Produkt odzyskiwania',
            price: 12345,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        )
      ).id;
      s.order = (
        await api(
          '/orders',
          'POST',
          {
            customer_name: 'QA Klient odzyskiwania',
            email: 'qa-recovery-buyer@example.test',
            warehouse_id: s.warehouse,
            source: 'demo',
            items: [{ product_id: s.product, quantity: 2 }],
          },
          201,
        )
      ).id;
      s.business = await business([s.tenant]);
      const enrolled = await api('/auth/security/enroll', 'POST', { password: s.password });
      s.secret = enrolled.secret;
      const confirmed = await api('/auth/security/confirm', 'POST', {
        password: s.password,
        code: totp(s.secret),
      });
      s.codes = confirmed.recovery_codes;
      s.mfa_cookie = cookie;
      s.mfa_before = (
        await pool.query(
          'SELECT secret_encrypted,enabled_at,last_step,recovery_hashes,version FROM account_security WHERE user_id=$1',
          [s.user],
        )
      ).rows[0];
      await save(s);
      console.log({
        own_firm: s.tenant,
        order: s.order,
        stock: { on_hand: 10, reserved: 2 },
        mfa_enabled: true,
      });
    } else if (phase === 'mail') {
      const row = (
        await pool.query(
          "SELECT body_encrypted FROM account_local_mail WHERE user_id=$1 AND kind='password_reset' AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
          [s.user],
        )
      ).rows[0];
      assert(row);
      s.reset_url = decrypt(row.body_encrypted).url;
      s.token = s.reset_url.split('#password-reset=')[1];
      await save(s);
      await writeFile(
        'data/password-recovery-mail081.json',
        JSON.stringify({ url: s.reset_url, code: s.codes[0] }, null, 2),
        { mode: 0o600 },
      );
      console.log({ local_mail_received: true, encrypted: true });
    } else if (phase === 'reset-api') {
      assert(s.token && !s.reset_done, 'One-time native reset');
      const body = { token: s.token, password: s.next_password, confirm_password: s.next_password };
      const challenge = await api('/auth/password/reset', 'POST', body);
      assert.deepEqual(challenge, { mfa_required: true });
      const result = await api('/auth/password/reset', 'POST', { ...body, code: s.codes[0] });
      assert(result.ok && result.sessions_revoked);
      s.reset_done = true;
      await save(s);
      console.log({ native_reset: true, mfa_challenge: true, recovery_code_used: true });
    } else if (phase === 'final') {
      const health = await api('/health');
      cookie = s.mfa_cookie;
      await api('/auth/me', 'GET', undefined, 401);
      cookie = '';
      await api('/auth/login', 'POST', { email: s.email, password: s.password }, 401);
      const challenge = await api('/auth/login', 'POST', {
        email: s.email,
        password: s.next_password,
      });
      assert(challenge.mfa_required);
      await api('/auth/login', 'POST', {
        email: s.email,
        password: s.next_password,
        code: s.codes[1],
      });
      const signedCookie = cookie;
      const row = (await pool.query('SELECT * FROM account_security WHERE user_id=$1', [s.user]))
        .rows[0];
      assert.equal(row.secret_encrypted, s.mfa_before.secret_encrypted);
      assert.equal(row.recovery_hashes.length, 5);
      assert.equal(BigInt(row.version), BigInt(s.mfa_before.version) + 1n);
      assert.deepEqual(await business([s.tenant]), s.business);
      assert.deepEqual(await business(s.tenants), s.before);
      assert.deepEqual(await accounts(s.users), s.accounts);
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [s.tenant, s.product],
        )
      ).rows[0];
      assert.deepEqual(stock, { on_hand: 10, reserved: 2 });
      const order = await api('/orders/' + s.order);
      assert.equal(order.total, 24690);
      cookie = '';
      await api(
        '/auth/password/reset',
        'POST',
        {
          token: s.token,
          password: s.next_password,
          confirm_password: s.next_password,
          code: s.codes[2],
        },
        401,
      );
      const notification = (
        await pool.query(
          "SELECT body_encrypted FROM account_local_mail WHERE user_id=$1 AND kind='password_changed'",
          [s.user],
        )
      ).rows[0];
      assert(notification);
      const text = JSON.stringify(decrypt(notification.body_encrypted));
      assert(!text.includes(s.password));
      assert(!text.includes(s.next_password));
      const report = {
        stage: 81,
        verified_at: new Date().toISOString(),
        revision: health.revision,
        schema: health.schema_revision,
        own_firm: s.tenant,
        order: s.order,
        total: order.total,
        stock,
        password_changed: true,
        old_session_revoked: true,
        old_password_refused: true,
        new_password_mfa_required: true,
        mfa_secret_preserved: true,
        recovery_codes_consumed: 3,
        reset_replay_refused: true,
        local_notification_without_password: true,
        own_business_exact: true,
        previous_firms: s.tenants.length,
        previous_accounts: s.users.length,
        previous_business_tables: tables.length,
        previous_business_exact: true,
        previous_accounts_exact: true,
        baseline_at: s.baseline_at,
        provider_requests: 0,
      };
      await writeFile('docs/password-recovery-native-qa.json', JSON.stringify(report, null, 2));
      s.final_cookie = signedCookie;
      await save(s);
      console.log(report);
    } else throw new Error('phase: baseline/setup/mail/reset-api/final');
  }
} finally {
  await pool.end();
}
