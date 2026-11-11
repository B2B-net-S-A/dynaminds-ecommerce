// Local QA fixtures only; all credentials and recovery material stay in ignored private data/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { totp } from '../server/totp';

const file = 'data/workspace-mfa-stage078.json';
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
];
let cookie = '';
async function api(path: string, method = 'GET', payload?: unknown, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = (await r.json()) as any;
  assert.equal(r.status, expected, path + ':' + JSON.stringify(body));
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return body;
}
async function fingerprints(tenants: string[]) {
  const out: Record<string, unknown> = {};
  for (const table of tables) {
    const rows = (
      await pool.query(
        `SELECT to_jsonb(t)::text row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [tenants],
      )
    ).rows;
    out[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}
async function save(state: any) {
  await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}
async function enroll(a: any, password: string) {
  const setup = await api('/auth/security/enroll', 'POST', { password });
  const confirmed = await api('/auth/security/confirm', 'POST', {
    password,
    code: totp(setup.secret),
  });
  a.codes = confirmed.recovery_codes;
  a.secret = setup.secret;
  a.cookie = cookie;
  a.user = confirmed.user;
}
try {
  const mode = process.argv[2];
  if (mode === 'setup') {
    assert(!existsSync(file), 'One-time own QA setup; choose another mode afterward');
    const health = await api('/health');
    assert.equal(health.schema_revision, '057_workspace_mfa');
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((t) => t.id);
    const state: any = {
      tenants,
      before: await fingerprints(tenants),
      password: 'DynaWorkspaceMfa!2026',
      created_at: new Date().toISOString(),
    };
    const admin = await api(
      '/auth/signup',
      'POST',
      {
        email: 'qa-workspace-mfa-admin@demo.local',
        name: 'QA Administrator MFA',
        password: state.password,
        organization: { name: 'QA Ochrona firmy 078' },
      },
      201,
    );
    state.admin = { email: admin.user.email, user: admin.user, cookie };
    state.tenant = admin.user.tenant_id;
    const warehouse = (await api('/warehouses')).data[0].id;
    const product = await api(
      '/products',
      'POST',
      {
        sku: 'QA-MFA-078',
        name: 'QA Ochrona zamówień',
        price: 15000,
        quantity: 10,
        warehouse_id: warehouse,
      },
      201,
    );
    state.product = product.id;
    const order = await api(
      '/orders',
      'POST',
      {
        customer_name: 'QA Klient ochrony',
        email: 'qa-mfa-buyer@example.test',
        warehouse_id: warehouse,
        source: 'demo',
        items: [{ product_id: product.id, quantity: 2 }],
      },
      201,
    );
    state.order = order.id;
    await enroll(state.admin, state.password);
    const adminCookie = cookie;
    cookie = '';
    const member = await api(
      '/auth/signup',
      'POST',
      {
        email: 'qa-workspace-mfa-member@demo.local',
        name: 'QA Magazynier MFA',
        password: state.password,
        organization: { name: 'QA Firma dobrowolna 078' },
      },
      201,
    );
    state.member = {
      email: member.user.email,
      user: member.user,
      optional_tenant: member.user.tenant_id,
      cookie,
      codes: [],
    };
    const memberCookie = cookie;
    cookie = adminCookie;
    const invite = await api(
      '/workspaces/invitations',
      'POST',
      { email: state.member.email, role: 'operator' },
      201,
    );
    cookie = memberCookie;
    state.member.user = (
      await api('/workspaces/invitations/accept', 'POST', { token: invite.token })
    ).user;
    state.member.cookie = cookie;
    cookie = adminCookie;
    const policy = await api('/workspaces/security', 'PATCH', {
      require_mfa: true,
      version: 0,
      password: state.password,
      code: state.admin.codes.shift(),
    });
    state.admin.cookie = cookie;
    state.admin.user = policy.user;
    state.own_business_before = await fingerprints([state.tenant]);
    await save(state);
    console.log(
      JSON.stringify({
        setup: 'own_local_qa_only',
        tenant: state.tenant,
        previous_tenants: tenants.length,
        members: 2,
        policy_version: policy.policy.version,
      }),
    );
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    if (mode === 'verify-unenrolled') {
      await api('/auth/login', 'POST', { email: s.member.email, password: s.password });
      const switched = await api('/workspaces/switch', 'POST', { tenant_id: s.tenant });
      assert.equal(switched.user.mfa_required, true);
      assert.equal(switched.user.mfa_enrollment_required, true);
      for (const path of ['/products', '/orders', '/dashboard', '/integrations/workspace']) {
        const r = await api(path, 'GET', undefined, 403);
        assert.equal(r.code, 'MFA_REQUIRED');
      }
      assert.equal((await api('/auth/security')).enabled, false);
      assert.equal((await api('/workspaces')).data.length, 2);
      s.member.cookie = cookie;
      s.member.user = switched.user;
      s.unenrolled_evidence = {
        checked_at: new Date().toISOString(),
        business_gets: 4,
        status: 403,
        code: 'MFA_REQUIRED',
        setup_and_workspace_list_accessible: true,
      };
      assert.deepEqual(await fingerprints(s.tenants), s.before);
      await save(s);
      console.log(JSON.stringify(s.unenrolled_evidence));
    } else if (mode === 'enroll-member') {
      assert(!s.member.codes.length, 'Own member enrollment is one-time');
      cookie = s.member.cookie;
      await enroll(s.member, s.password);
      await save(s);
      assert.equal(s.member.user.mfa_required, false);
      console.log(JSON.stringify({ member_enrolled: true, recovery_codes_private: true }));
    } else if (mode === 'expire-own-member') {
      assert(s.member.codes.length, 'Enroll own member first');
      const changed = await pool.query(
        'UPDATE sessions SET mfa_verified_at=NULL WHERE user_id=$1 AND expires_at>now()',
        [s.member.user.id],
      );
      assert(changed.rowCount);
      console.log(JSON.stringify({ own_qa_sessions_unproven: changed.rowCount }));
    } else if (mode === 'verify') {
      await api('/auth/login', 'POST', {
        email: s.admin.email,
        password: s.password,
        code: s.admin.codes.shift(),
      });
      const health = await api('/health');
      assert.match(health.revision, /^[a-f0-9]{40}$/);
      const policy = await api('/workspaces/security');
      assert.equal(policy.require_mfa, true);
      assert.equal(policy.version, 1);
      assert.equal(policy.members.length, 2);
      assert(policy.members.every((m: any) => m.mfa_enabled));
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [s.tenant, s.product],
        )
      ).rows[0];
      assert.deepEqual(stock, { on_hand: 10, reserved: 2 });
      assert.deepEqual(await fingerprints([s.tenant]), s.own_business_before);
      await api('/auth/login', 'POST', {
        email: s.member.email,
        password: s.password,
        code: s.member.codes.shift(),
      });
      const switched = await api('/workspaces/switch', 'POST', { tenant_id: s.tenant });
      assert.equal(switched.user.mfa_required, false);
      for (const path of ['/products', '/orders', '/dashboard', '/integrations/workspace'])
        await api(path);
      await api(
        '/auth/security/disable',
        'POST',
        { password: s.password, code: s.member.codes[0] },
        409,
      );
      const after = await fingerprints(s.tenants);
      assert.deepEqual(after, s.before);
      const receipt = {
        checked_at: new Date().toISOString(),
        health,
        tenant: s.tenant,
        native_database: true,
        external_http: 0,
        previous_tenants: s.tenants.length,
        previous_business_tables_unchanged: tables.length,
        own_business_tables_unchanged: tables.length,
        stock,
        policy: { require_mfa: true, version: 1, members: 2, enrolled: 2 },
        unenrolled: s.unenrolled_evidence,
        verified_member_business_gets: 4,
        disable_under_required_policy: 409,
        before: s.before,
        after,
        ui_evidence: 'See WORKSPACE-MFA.md and saved local browser screenshots',
      };
      s.member.cookie = cookie;
      s.member.user = switched.user;
      await save(s);
      await writeFile('docs/workspace-mfa-native-qa.json', JSON.stringify(receipt, null, 2) + '\n');
      console.log(
        JSON.stringify({
          verified: true,
          revision: health.revision,
          previous_tenants_unchanged: s.tenants.length,
          stock,
          members_with_mfa: 2,
        }),
      );
    } else
      throw new Error('Use setup, verify-unenrolled, enroll-member, expire-own-member or verify');
  }
} finally {
  await pool.end();
}
