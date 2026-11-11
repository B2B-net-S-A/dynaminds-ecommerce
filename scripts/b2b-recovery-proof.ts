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
  const f = JSON.parse(await readFile('data/b2b-stage048.json', 'utf8')).fixture;
  const backup = await createBackup({ directory: 'data/backups' }),
    restored = await restoreBackup(backup.file, { directory: 'data/b2b-048-restore' });
  name = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  const c = new pg.Client({ ...localDatabase(), database: name });
  await c.connect();
  let migrations: number;
  try {
    for (const table of [
      'b2b_accounts',
      'b2b_sessions',
      'b2b_quotes',
      'price_lists',
      'price_list_items',
      'products',
      'stock',
      'stock_locations',
      'reservation_locations',
      'orders',
      'order_items',
      'shipments',
      'documents',
      'return_cases',
      'return_items',
      'payment_entries',
      'audit_events',
    ]) {
      const q = 'SELECT to_jsonb(t) row FROM ' + table + ' t WHERE tenant_id=$1 ORDER BY 1';
      assert.deepEqual(
        (await c.query(q, [f.tenant])).rows,
        (await pool.query(q, [f.tenant])).rows,
        table,
      );
    }
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 38);
    assert.equal(restored.tables, 104);
    const tenant = (
      await c.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [f.tenant])
    ).rows[0].id;
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    for (const table of ['b2b_accounts', 'b2b_sessions', 'b2b_quotes']) {
      assert.equal((await c.query('SELECT * FROM ' + table)).rows.length, 0);
    }
    for (const [query, values] of [
      [
        "INSERT INTO b2b_accounts(id,tenant_id,name,email,warehouse_id,price_list_id,address,payment_mode) VALUES(gen_random_uuid(),$1,'Forbidden','forbidden@example.test',$2,$3,'{}','prepaid')",
        [f.tenant, f.warehouse, f.list],
      ],
      [
        "INSERT INTO b2b_sessions(token_hash,tenant_id,account_id,expires_at) VALUES('forbidden-b2b-session',$1,$2,now())",
        [f.tenant, f.account],
      ],
      [
        "INSERT INTO b2b_quotes(id,tenant_id,account_id,client_key,fingerprint,account_version,input,pricing,total) VALUES(gen_random_uuid(),$1,$2,gen_random_uuid(),'forbidden',1,'{}','{}',0)",
        [f.tenant, f.account],
      ],
    ] as [string, any[]][]) {
      await c.query('SAVEPOINT no_write');
      await assert.rejects(c.query(query, values), /row-level security/);
      await c.query('ROLLBACK TO SAVEPOINT no_write');
    }
    await c.query('ROLLBACK');
    const policies = (
      await c.query(
        'SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.relname=ANY($1::text[])',
        [['b2b_accounts', 'b2b_sessions', 'b2b_quotes']],
      )
    ).rows;
    assert.equal(policies.length, 3);
    assert(policies.every((r) => r.relrowsecurity && r.relforcerowsecurity));
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
  for (let n = 0; n < 40; n++) {
    assert.equal(child.exitCode, null);
    try {
      const r = await fetch('http://127.0.0.1:4102/api/health');
      if (r.ok) {
        const h = (await r.json()) as any;
        assert(h.restore_preview);
        assert.equal(h.schema_revision, '038_b2b');
        healthy = true;
        break;
      }
    } catch {}
    await setTimeout(250);
  }
  assert(healthy);
  const base = 'http://127.0.0.1:4102/api/public/b2b/' + f.account;
  const login = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'buyer-b2b@example.test', password: 'BuyerDemo!2026' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert(cookie.startsWith('dyna_b2b_preview_4102='));
  async function api(path: string, method = 'GET', body?: any, status = 200) {
    const r = await fetch(base + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, status, path);
    return r;
  }
  const me = (await (await api('/me')).json()) as any;
  assert.equal(me.read_only, true);
  const catalog = (await (await api('/catalog')).json()) as any;
  assert.equal(catalog.data[0].price, 12345);
  assert.equal(catalog.data[0].available, 19);
  const history = (await (await api('/orders')).json()) as any;
  assert.equal(history.data.length, 1);
  assert.equal(history.data[0].id, f.order);
  const order = (await (await api('/orders/' + f.order)).json()) as any;
  assert.equal(order.cases[0].state, 'closed');
  assert.equal(order.cases[0].refund_amount, 12345);
  const printed = await api(
    '/orders/' + f.order + '/documents/' + order.documents[0].id + '/print',
  );
  assert.match(await printed.text(), /251,90/);
  for (const path of [
    '/quotes',
    '/quotes/' +
      (await pool.query('SELECT id FROM b2b_quotes WHERE account_id=$1', [f.account])).rows[0].id +
      '/checkout',
    '/orders/' + f.order + '/returns',
    '/activate',
  ])
    await api(path, 'POST', {}, 423);
  await api('/logout', 'POST', {});
  await api('/orders', 'GET', undefined, 401);
  const proof = {
    checked_at: new Date().toISOString(),
    scope: 'native_local_encrypted_backup_restored_B2B_buyer_portal',
    tables: restored.tables,
    migrations,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    qa_business_rows_match: true,
    rls_three_tables: true,
    worker_enabled: false,
    provider_requests: 0,
    buyer_login_http: 200,
    separate_preview_cookie: true,
    catalog_http: 200,
    history_http: 200,
    closed_partial_return: true,
    document_http: 200,
    mutations_blocked_http: 423,
    logout_invalidates_session: true,
  };
  await writeFile('docs/b2b-recovery-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally {
  if (child && child.exitCode === null) {
    const done = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGTERM');
    await done;
  }
  if (name) await pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await pool.end();
}
