// Private local QA only. No supplier requests, business transactions or external messages.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, tenantTx } from '../server/db';
import { encrypt } from '../server/security';

const file = 'data/integration-workspace-stage077.json';
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
  const start = performance.now();
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await r.text();
  assert.equal(r.status, expected, path + ':' + body);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return { body: JSON.parse(body), ms: performance.now() - start, bytes: Buffer.byteLength(body) };
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
try {
  if (process.argv[2] === 'setup') {
    assert.ok(!existsSync(file), 'Own native setup is one-time; use verify after setup');
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const before = await fingerprints(tenants);
    const email = 'qa-integrations-workspace@demo.local',
      password = 'DynaWorkspace!2026';
    const signup = await api(
      '/auth/signup',
      'POST',
      {
        name: 'QA Panel integracji',
        email,
        password,
        organization: { name: 'QA Panel integracji 077' },
      },
      201,
    );
    const tenant = signup.body.user.tenant_id;
    await api('/workspaces/plan', 'PATCH', { plan: 'business' });
    const amazon = (await api('/integrations/amazon-example', 'POST')).body.channel_id;
    await tenantTx(tenant, async (c) => {
      for (let i = 1; i <= 30; i++)
        await c.query(
          `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status,created_at) VALUES($1,$2,'woocommerce',$3,'sandbox',$7,$4,$5,$6::timestamptz)`,
          [
            randomUUID(),
            tenant,
            'QA DEMO połączenie ' + String(i).padStart(2, '0'),
            { simulation: true, workspace_fixture: true },
            i <= 2 ? 'error' : 'simulation',
            '2026-10-05T00:00:00.' + String(1 + (i % 3)).padStart(6, '0') + 'Z',
            encrypt({}),
          ],
        );
    });
    await writeFile(
      file,
      JSON.stringify(
        { tenants, before, tenant, email, password, amazon, created_at: new Date().toISOString() },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ setup: 'own_local_qa_only', connections: 31, tenant }));
  } else if (process.argv[2] === 'verify') {
    const state = JSON.parse(await readFile(file, 'utf8'));
    await api('/auth/login', 'POST', { email: state.email, password: state.password });
    const health = (await api('/health')).body;
    const workspace = await api('/integrations/workspace');
    assert.equal(workspace.body.summary.total, 31);
    assert.equal(workspace.body.summary.attention, 2);
    assert.equal(workspace.body.summary.simulation, 31);
    assert.equal(workspace.body.summary.verified_read, 0);
    assert.equal(workspace.body.channels, undefined);
    const first = await api('/integrations/connections?limit=25');
    const second = await api('/integrations/connections?limit=25&after=' + first.body.next);
    assert.equal(first.body.data.length, 25);
    assert.equal(second.body.data.length, 6);
    assert.equal(second.body.next, null);
    const all = [...first.body.data, ...second.body.data];
    assert.equal(new Set(all.map((r: any) => r.id)).size, 31);
    assert.ok(all.every((r: any) => !('credentials' in r)));
    const attention = await api('/integrations/connections?status=attention');
    assert.equal(attention.body.total, 2);
    const provider = await api('/integrations/connections?provider=amazon');
    assert.equal(provider.body.total, 1);
    assert.equal(provider.body.data[0].id, state.amazon);
    const empty = await api('/integrations/connections?search=missing077');
    assert.equal(empty.body.total, 0);
    const after = await fingerprints(state.tenants);
    assert.deepEqual(after, state.before);
    const receipt = {
      checked_at: new Date().toISOString(),
      health,
      tenant: state.tenant,
      native_database: true,
      supplier_http: 0,
      synthetic_connection_fixtures: 30,
      real_local_amazon_example: 1,
      summary: workspace.body.summary,
      registry_providers: workspace.body.registry.length,
      traversal: {
        page_sizes: [25, 6],
        unique: 31,
        credential_fields_excluded: true,
        http_ms: [first.ms, second.ms],
        response_bytes: [first.bytes, second.bytes],
      },
      filters: { attention: 2, amazon: 1, missing: 0 },
      previous_tenants: state.tenants.length,
      previous_business_tables_unchanged: tables.length,
      before: state.before,
      after,
      api_provider_identity_or_external_write_verified: false,
      ui_evidence: 'Manual IAB interactions and saved screenshots; see INTEGRATION-WORKSPACE.md',
    };
    await writeFile(
      'docs/integration-workspace-native-qa.json',
      JSON.stringify(receipt, null, 2) + '\n',
    );
    console.log(
      JSON.stringify({
        verified: true,
        pages: [25, 6],
        previous_tenants_unchanged: state.tenants.length,
        revision: health.revision,
      }),
    );
  } else throw new Error('Use setup (one-time) or verify');
} finally {
  await pool.end();
}
