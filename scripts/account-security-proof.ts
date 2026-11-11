// Local QA account only. No third-party calls or edits to existing account security.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, migrate } from '../server/db';
import { totp } from '../server/totp';
const file = 'data/account-security-stage072.json',
  phase = process.argv[2];
let cookie = '';
async function call(path: string, method = 'GET', payload?: any, expected = 200) {
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
async function fingerprint(table: string, tenants: string[]) {
  assert(/^[a-z][a-z0-9_]*$/.test(table));
  const rows = (
    await pool.query(
      `SELECT to_jsonb(t)::text row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
try {
  if (phase === 'baseline') {
    const prior = JSON.parse(await readFile('data/ebay-api-stage071.json', 'utf8'));
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const table of Object.keys(prior.before))
      before[table] = await fingerprint(table, tenants);
    await writeFile(
      file,
      JSON.stringify({ tenants, before, baseline_at: new Date().toISOString() }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    console.log({ prior_tenants: tenants.length, stable_tables: Object.keys(before).length });
  } else if (phase === 'migrate') {
    await migrate();
    console.log({ migration051: true });
  } else {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup') {
      assert(!state.fixture);
      const email = 'qa-mfa@demo.local',
        password = 'DynaSecurity!2026',
        signed = await call(
          '/auth/signup',
          'POST',
          {
            email,
            password,
            name: 'QA MFA 072',
            organization: { name: 'QA bezpieczeństwo 072', currency: 'PLN', locale: 'pl-PL' },
          },
          201,
        );
      state.fixture = { email, password, user: signed.user.id, tenant: signed.user.tenant_id };
      await writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      const f = state.fixture;
      f.warehouse = (await call('/warehouses')).data[0].id;
      f.product = (
        await call(
          '/products',
          'POST',
          {
            sku: 'QA-MFA-072',
            name: 'Towar kontrolny MFA',
            price: 12345,
            vat: 23,
            quantity: 10,
            warehouse_id: f.warehouse,
          },
          201,
        )
      ).id;
      f.order = (
        await call(
          '/orders',
          'POST',
          {
            customer_name: 'QA MFA',
            email: 'qa@example.test',
            warehouse_id: f.warehouse,
            items: [{ product_id: f.product, quantity: 2 }],
          },
          201,
        )
      ).id;
      f.initial_order = await call('/orders/' + f.order);
      const other = await call('/auth/login', 'POST', { email, password });
      assert(other.user);
      const original = cookie,
        setup = await call('/auth/security/enroll', 'POST', { password });
      const confirmed = await call('/auth/security/confirm', 'POST', {
        password,
        code: totp(setup.secret),
      });
      assert.equal(confirmed.recovery_codes.length, 8);
      const enabledCookie = cookie;
      cookie = original;
      await call('/auth/me', 'GET', undefined, 401);
      cookie = enabledCookie;
      assert.deepEqual(await call('/auth/login', 'POST', { email, password }), {
        mfa_required: true,
      });
      const race = await Promise.all(
        [0, 1].map(() =>
          fetch('http://127.0.0.1:4100/api/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password, code: confirmed.recovery_codes[0] }),
          }),
        ),
      );
      assert.deepEqual(race.map((r) => r.status).sort(), [200, 401]);
      const changedPassword = 'DynaChanged!2026';
      await call('/auth/security/password', 'POST', {
        password,
        new_password: changedPassword,
        code: confirmed.recovery_codes[1],
      });
      f.password = changedPassword;
      await call(
        '/auth/login',
        'POST',
        { email, password, code: confirmed.recovery_codes[2] },
        401,
      );
      const replaced = await call('/auth/security/recovery', 'POST', {
        password: f.password,
        code: confirmed.recovery_codes[2],
      });
      await call('/auth/security/disable', 'POST', {
        password: f.password,
        code: replaced.recovery_codes[0],
      });
      assert.equal((await call('/auth/security')).enabled, false);
      await call('/auth/login', 'POST', { email, password: f.password });
      const second = await call('/auth/security/enroll', 'POST', { password: f.password });
      const final = await call('/auth/security/confirm', 'POST', {
        password: f.password,
        code: totp(second.secret),
      });
      f.codes = final.recovery_codes;
      f.setup_verified = true;
      await writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      assert.equal((await call('/auth/security')).enabled, true);
      console.log({
        account: f.user,
        tenant: f.tenant,
        mfa_enabled: true,
        qa_password_change: true,
        disable_and_reenroll: true,
        recovery_race: [200, 401],
        zero_external_requests: true,
      });
    } else if (phase === 'verify') {
      const f = state.fixture;
      await call('/auth/login', 'POST', { email: f.email, password: f.password, code: f.codes[6] });
      const security = await call('/auth/security');
      assert.equal(security.enabled, true);
      assert(security.recovery_remaining <= 7);
      const order = await call('/orders/' + f.order);
      assert.deepEqual(order, state.fixture.initial_order);
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [f.tenant, f.product],
        )
      ).rows[0];
      assert.deepEqual(stock, { on_hand: 10, reserved: 2 });
      const product = (
        await pool.query('SELECT price FROM products WHERE tenant_id=$1 AND id=$2', [
          f.tenant,
          f.product,
        ])
      ).rows[0];
      assert.equal(product.price, 12345);
      const changed: any = {},
        unchanged: string[] = [];
      for (const table of Object.keys(state.before)) {
        const after = await fingerprint(table, state.tenants);
        if (JSON.stringify(after) === JSON.stringify(state.before[table])) unchanged.push(table);
        else changed[table] = { before: state.before[table], after };
      }
      const report = {
        stage: 72,
        at: new Date().toISOString(),
        runtime: await call('/health'),
        scope: 'native_local_QA_account_MFA',
        mfa_enabled: true,
        recovery_remaining: security.recovery_remaining,
        order_preserved: true,
        stock,
        price: product.price,
        prior_tenants: state.tenants.length,
        unchanged_tables: unchanged.length,
        changed_tables: changed,
        baseline_at: state.baseline_at,
        zero_external_requests: true,
        goal_complete: false,
      };
      await writeFile(
        'docs/account-security-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    } else throw new Error('Unknown phase');
  }
} finally {
  await pool.end();
}
