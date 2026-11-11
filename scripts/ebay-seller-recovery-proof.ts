import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  localDatabase,
  restoreDatabaseName,
} from '../server/recovery';
let name: string | undefined, child: ReturnType<typeof spawn> | undefined;
try {
  const f = JSON.parse(await readFile('data/ebay-seller-stage069.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/ebay-seller-069-restore' });
  name = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const tables = [
    'channels',
    'oauth_states',
    'ebay_account_bindings',
    'ebay_fulfillment_configs',
    'ebay_fulfillment_receipts',
    'ebay_fulfillment_plans',
    'ebay_fulfillment_simulations',
    'listings',
    'offer_plans',
    'shipments',
    'audit_events',
    'offer_sync_configs',
    'jobs',
    'products',
    'stock',
    'orders',
    'inbound_orders',
    'payment_entries',
  ];
  const c = new pg.Client({ ...localDatabase(), database: name });
  await c.connect();
  let migrations = 0;
  try {
    for (const table of tables) {
      const q = `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`;
      assert.deepEqual(
        (await c.query(q, [f.tenant])).rows,
        (await pool.query(q, [f.tenant])).rows,
        table,
      );
    }
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 48);
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    for (const table of tables)
      assert.equal(
        (await c.query(`SELECT 1 FROM ${table} WHERE tenant_id<>$1 LIMIT 1`, [f.tenant])).rowCount,
        0,
        table,
      );
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      restored.directory + '/result.json',
    ],
    { cwd: process.cwd(), env: { ...process.env, DYNA_PREVIEW_PORT: '4102' }, stdio: 'ignore' },
  );
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    assert.equal(child.exitCode, null);
    try {
      const h: any = await (await fetch('http://127.0.0.1:4102/api/health')).json();
      if (h.restore_preview) {
        healthy = true;
        break;
      }
    } catch {}
    await setTimeout(250);
  }
  assert(healthy);
  const login = await fetch('http://127.0.0.1:4102/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: f.email, password: 'DynaDemo!2026' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert(cookie.startsWith('dyna_session_preview_4102='));
  async function api(p: string, method = 'GET', body?: any, status = 200) {
    const r = await fetch('http://127.0.0.1:4102/api' + p, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, status, p);
    return r;
  }
  const integrations: any = await (await api('/integrations')).json();
  const ch = integrations.channels.find((c: any) => c.id === f.channel);
  assert(ch);
  assert.equal(ch.status, 'simulation');
  assert.equal(ch.sync_enabled, false);
  const identity: any = await (await api(`/integrations/${f.channel}/ebay-account`)).json();
  assert.equal(identity.bound, true);
  assert.equal(identity.source, 'simulation');
  assert.equal(identity.username, 'DEMO — lokalny sprzedawca');
  const offers: any = await (await api(`/integrations/${f.channel}/offers`)).json();
  const plans = offers.data.filter(
    (p: any) => ['create_draft', 'publish'].includes(p.operation) && p.state === 'done',
  );
  assert.equal(plans.length, 2);
  assert.equal(plans[0].result.scope, 'local_simulation');
  assert.equal(plans[0].result.desired_applied, true);
  const creation = plans.find((p: any) => p.operation === 'create_draft'),
    publication = plans.find((p: any) => p.operation === 'publish');
  assert.equal(creation.result.ebay_creation_steps.offer_verified, true);
  assert.equal(creation.result.ebay_offer_id, publication.result.ebay_publication.offer_id);
  await api(
    `/integrations/${f.channel}/offers/preview`,
    'POST',
    { product_id: f.product, operation: 'create_draft' },
    423,
  );
  await api(`/offer-plans/${plans[0].id}/queue`, 'POST', {}, 423);
  await api(`/integrations/${f.channel}/oauth/start`, 'POST', {}, 423);
  const report = {
    checked_at: new Date().toISOString(),
    scope: 'native_local_eBay_new_draft_creation_and_publication_backup_restored',
    tables: restored.tables,
    migrations,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: true,
    schema_fingerprint_match: true,
    qa_business_tables_match: tables.length,
    rls_checked_tables: tables.length,
    worker_enabled: false,
    provider_requests: 0,
    integrations_read_http: 200,
    cached_identity_http: 200,
    publication_history_http: 200,
    local_creation_plans_confirmed: 1,
    local_publication_plans_confirmed: 1,
    distinct_published_offers: 1,
    identity_source: identity.source,
    identity_username: identity.username,
    mutations_blocked_http: 423,
    separate_preview_cookie: true,
    whole_goal_complete: false,
  };
  await writeFile('docs/ebay-seller-recovery-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  if (child && child.exitCode === null) {
    const stopped = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGTERM');
    await stopped;
  }
  if (name) await pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await pool.end();
}
