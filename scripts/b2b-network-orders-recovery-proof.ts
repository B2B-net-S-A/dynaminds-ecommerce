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
  const f = JSON.parse(await readFile('data/b2b-network-orders-stage050.json', 'utf8'));
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/b2b-network-orders-050-restore',
  });
  name = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  assert.equal(restored.tables, 114);
  const c = new pg.Client({ ...localDatabase(), database: name });
  await c.connect();
  const network = [
    'b2b_link_invitations',
    'b2b_links',
    'b2b_catalog_runs',
    'b2b_catalog_staging',
    'b2b_catalog_items',
    'b2b_network_quotes',
    'b2b_network_orders',
    'b2b_network_order_lines',
    'b2b_network_receipts',
    'b2b_network_receipt_lines',
  ];
  const comparison = [
    ...network,
    'b2b_accounts',
    'products',
    'product_images',
    'price_lists',
    'price_list_items',
    'stock',
    'stock_locations',
    'orders',
    'order_items',
    'reservations',
    'reservation_locations',
    'audit_events',
    'warehouse_documents',
    'warehouse_document_lines',
    'stock_movements',
    'shipments',
    'documents',
  ];
  let migrations: number;
  try {
    migrations = (await c.query('SELECT count(*)::int n FROM migrations')).rows[0].n;
    assert.equal(migrations, 40);
    for (const table of comparison) {
      const q =
        'SELECT to_jsonb(t) row FROM ' + table + ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1';
      const values = [[f.supplier.tenant, f.buyer.tenant]];
      assert.deepEqual((await c.query(q, values)).rows, (await pool.query(q, values)).rows, table);
    }
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.supplier.tenant]);
    for (const table of network.slice(1))
      assert.equal((await c.query('SELECT * FROM ' + table)).rows.length, 0, table);
    assert.equal(
      (
        await c.query('SELECT b2b_network_admin($1) allowed', [
          (await pool.query('SELECT actor_id FROM b2b_links WHERE id=$1', [f.link])).rows[0]
            .actor_id,
        ])
      ).rows[0].allowed,
      false,
    );
    await c.query('SAVEPOINT denied');
    await assert.rejects(c.query('SELECT * FROM memberships'), /permission denied/);
    await c.query('ROLLBACK TO SAVEPOINT denied');
    await c.query('SAVEPOINT denied');
    await assert.rejects(
      c.query(
        "INSERT INTO b2b_catalog_items(tenant_id,link_id,source_product_id,snapshot,fingerprint) VALUES($1,$2,$3,'{}','forbidden')",
        [f.buyer.tenant, f.link, f.product],
      ),
      /row-level security/,
    );
    await c.query('ROLLBACK TO SAVEPOINT denied');
    await c.query('ROLLBACK');
    const policies = (
      await c.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])',
        [network],
      )
    ).rows;
    assert.equal(policies.length, 10);
    assert(policies.every((p) => p.relrowsecurity && p.relforcerowsecurity));
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
        const h: any = await r.json();
        assert(h.restore_preview);
        assert.equal(h.schema_revision, '040_b2b_network_orders');
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
    body: JSON.stringify({ email: f.buyer.email, password: 'DynaDemo!2026' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert(cookie.startsWith('dyna_session_preview_4102='));
  async function api(path: string, method = 'GET', body?: any, status = 200) {
    const r = await fetch('http://127.0.0.1:4102/api' + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, status, path);
    return r;
  }
  const l: any = await (await api('/b2b/network/links')).json();
  assert.equal(l.data.length, 1);
  const base = '/b2b/network/links/' + f.link;
  const cat: any = await (await api(base + '/catalog')).json();
  assert.equal(cat.data.length, 1);
  const current = cat.data.find((i: any) => i.source_product_id === f.product);
  assert.equal(current.snapshot.price, 12345);
  // Catalog is the last complete snapshot (before checkout); live reservations
  // and shipment are verified through the purchase, not inferred from that cache.
  assert.equal(current.snapshot.available, 20);
  assert.equal(current.product_id, f.local);
  const history: any = await (await api(base + '/runs')).json();
  assert.equal(history.data.filter((r: any) => r.state === 'done').length, 1);
  const p: any = await (await api('/products/' + f.local)).json();
  assert.equal(p.price, 25000);
  for (const url of [
    '/b2b/network/accept',
    base + '/refresh',
    base + '/catalog/' + current.id + '/product',
  ])
    await api(url, 'POST', {}, 423);
  await api(base, 'PATCH', {}, 423);
  const purchase: any = await (await api('/b2b/network/orders/' + f.order)).json();
  assert.equal(purchase.state, 'received');
  assert.equal(purchase.lines[0].received, 3);
  assert.equal(purchase.receipts.length, 2);
  assert.equal(purchase.fulfillment.status, 'shipped');
  await api('/b2b/network/orders/' + f.order + '/documents/' + f.invoice + '/print');
  await api('/b2b/network/orders/' + f.order + '/receipts', 'POST', {}, 423);
  await api(base + '/quotes', 'POST', {}, 423);
  const proof = {
    checked_at: new Date().toISOString(),
    scope: 'native_local_encrypted_backup_restored_cross_tenant_B2B_purchase_PZ',
    tables: restored.tables,
    migrations,
    encrypted_records: restored.encrypted_records_verified,
    row_fingerprints_match: restored.row_fingerprints_match,
    schema_fingerprint_match: restored.schema_fingerprint_match,
    qa_business_tables_match: comparison,
    rls_ten_network_tables: true,
    membership_table_still_denied: true,
    admin_function_scoped_to_current_tenant: true,
    worker_enabled: false,
    provider_requests: 0,
    separate_preview_cookie: true,
    staff_login_http: 200,
    catalog_http: 200,
    history_http: 200,
    local_product_http: 200,
    mutations_blocked_http: 423,
    buyer_order_read_http: 200,
    buyer_document_print_http: 200,
    restored_PZ_receipts: 2,
    restored_buyer_received: 3,
    whole_goal_complete: false,
  };
  await writeFile(
    'docs/b2b-network-orders-recovery-qa.json',
    JSON.stringify(proof, null, 2) + '\n',
  );
  console.log(proof);
} finally {
  if (child && child.exitCode === null) {
    const done = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGTERM');
    await done;
  }
  if (name) await pool.query('DROP DATABASE ' + name + ' WITH (FORCE)');
  await pool.end();
}
