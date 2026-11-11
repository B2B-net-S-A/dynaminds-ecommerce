/**
 * Stage101 B1 recovery drill — run only after native acceptance and full restart.
 * Input: data/order-field-mappings-stage102.json, an existing regular private 0600 file.
 * Requires the host-native local postgres cluster (55432) and live HTTP API (4100).
 * Optional: PROOF_REVISION (expected live SHA), DYNA_PREVIEW_PORT (4101..4199, default4102).
 * Creates a sealed backup and an isolated readonly restore. Removes only its own restore DB.
 * Never logs QA credentials, cookies, encryption keys, decrypted CSV or private file contents.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
  manifestSchema,
  tableFingerprints,
  schemaFingerprint,
} from '../server/recovery';
import { decrypt } from '../server/security';
import {
  parseOrderFieldBatchCsv,
  orderFieldBatchCsvBytes,
} from '../server/order-field-batches-csv';

const statePath = 'data/order-field-mappings-stage102.json';
const liveBase = 'http://127.0.0.1:4100/api';
const schema = '080_order_field_mappings';
const batchTables = [
  'order_field_mapping_profiles',
  'order_field_mapping_revisions',
  'order_field_source_observations',
  'order_field_mapping_previews',
  'order_field_mapping_rows',
  'order_field_mapping_executions',
  'order_field_mapping_execution_rows',
];
const businessTables = [
  'orders',
  'order_items',
  'order_pick_items',
  'stock',
  'stock_movements',
  'reservations',
  'order_events',
  'shipments',
  'documents',
  'payment_entries',
  'return_cases',
  'order_field_definitions',
  'order_field_definition_revisions',
  'order_field_options',
  'order_field_values',
  'order_field_value_events',
  'order_field_files',
  'order_field_requests',
  ...batchTables,
];
// Match the current decrypt handlers in server/recovery.ts. Counts come from restored rows;
// neither an encrypted-record total nor a database table count is hardcoded.
const encryptedSources: [string, string][] = [
  ['channels', 'credentials'],
  ['outbound_subscriptions', 'secret'],
  ['oauth_states', 'verifier'],
  ['amazon_oauth_states', 'verifier'],
  ['shopify_oauth_states', 'verifier'],
  ['shopify_webhook_configs', 'signing_secret'],
  ['account_security', 'secret_encrypted'],
  ['account_security', 'pending_encrypted'],
  ['account_local_mail', 'body_encrypted'],
  ['odoo_invoice_files', 'content_encrypted'],
  ['payment_import_files', 'encrypted_bytes'],
  ['order_field_files', 'encrypted_bytes'],
  ['order_field_batch_previews', 'encrypted_bytes'],
  ['order_field_source_observations', 'encrypted_bytes'],
  ['invoice_email_files', 'content_encrypted'],
  ['email_message_files', 'content_encrypted'],
];
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Queryable = { query: (...args: any[]) => Promise<any> };
async function ownFingerprints(client: Queryable, tenant: string) {
  const result: Record<string, { count: number; sha256: string }> = {};
  for (const table of businessTables) {
    const rows = (
      await client.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
    result[table] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
  }
  return result;
}
async function readOwnSnapshot(tenant: string, databaseName?: string) {
  const client = new pg.Client({
    ...localDatabase(),
    ...(databaseName ? { database: databaseName } : {}),
  });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await ownFingerprints(client, tenant);
    await client.query('COMMIT');
    return result;
  } finally {
    await client.end();
  }
}
function assertSame(actual: unknown, expected: unknown, context: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), context);
}
let child: ReturnType<typeof spawn> | undefined;
let database: string | undefined;
let report: any;
try {
  const stat = await lstat(statePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert(state.apiAcceptance && state.initialImports.length === 3 && state.reconcile);
  const health = (await (await fetch(liveBase + '/health')).json()) as any;
  assert.equal(health.schema_revision, schema);
  assert(health.order_field_mappings_available);
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
  process.env.APP_REVISION = health.revision;
  const before = await readOwnSnapshot(state.tenant);
  assert(before.order_field_mapping_executions.count >= 4);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM order_field_mapping_executions WHERE tenant_id=$1 AND state='queued'",
        [state.tenant],
      )
    ).rows[0].n,
    0,
  );
  const port = Number(process.env.DYNA_PREVIEW_PORT ?? 4102);
  assert(Number.isInteger(port) && port >= 4101 && port <= 4199);
  let occupied = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    occupied = true;
  } catch {}
  assert(!occupied, 'Preview port occupied');
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/order-field-mappings-102-restore',
  });
  database = restoreDatabaseName(restored.database);
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      restored.worker_enabled === false,
  );
  assert.equal(restored.revision, health.revision);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(resolve(restored.directory, 'manifest.json'), 'utf8')),
  );
  const recovered = JSON.parse(await readFile(restored.config, 'utf8'));
  const client = new pg.Client({ ...localDatabase(), database });
  await client.connect();
  let profiles: any[] = [],
    observations: any[] = [],
    previews: any[] = [],
    executions: any[] = [],
    migrationCount = 0,
    foreign = '';
  const encryptionCounts: Record<string, number> = {};
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const actual = await tableFingerprints(client);
    assertSame(actual, manifest.tables, 'Full restored table snapshot');
    assert.equal(
      await schemaFingerprint(client, manifest.schema_fingerprint_version ?? 1),
      manifest.schema_sha256,
    );
    assert.equal(restored.tables, Object.keys(actual).length);
    assertSame(await ownFingerprints(client, state.tenant), before, 'Exact own restored commerce');
    const migrations = (await client.query('SELECT name FROM migrations ORDER BY name')).rows;
    assert.equal(migrations.at(-1).name, schema);
    migrationCount = migrations.length;
    for (const [table, column] of encryptedSources) {
      if (
        (await client.query('SELECT to_regclass($1) present', ['public.' + table])).rows[0].present
      )
        encryptionCounts[table + '.' + column] = (
          await client.query(`SELECT count(*)::int n FROM ${table} WHERE ${column} IS NOT NULL`)
        ).rows[0].n;
    }
    assert.equal(
      Object.values(encryptionCounts).reduce((sum, count) => sum + count, 0),
      restored.encrypted_records_verified,
      'Every encrypted source is counted and verified by restore',
    );
    profiles = (
      await client.query(
        'SELECT id FROM order_field_mapping_profiles WHERE tenant_id=$1 ORDER BY id',
        [state.tenant],
      )
    ).rows;
    observations = (
      await client.query(
        'SELECT * FROM order_field_source_observations WHERE tenant_id=$1 ORDER BY id',
        [state.tenant],
      )
    ).rows;
    previews = (
      await client.query(
        'SELECT id,kind FROM order_field_mapping_previews WHERE tenant_id=$1 ORDER BY id',
        [state.tenant],
      )
    ).rows;
    executions = (
      await client.query(
        'SELECT id,kind,state FROM order_field_mapping_executions WHERE tenant_id=$1 ORDER BY id',
        [state.tenant],
      )
    ).rows;
    assert.equal(profiles.length, 3);
    assert(
      observations.length >= 6 &&
        previews.length >= 4 &&
        executions.every((r) => r.state !== 'queued'),
    );
    for (const row of observations) {
      const encoded = decrypt(row.encrypted_bytes, recovered.encryptionKey).content_base64;
      assert.equal(typeof encoded, 'string');
      const bytes = Buffer.from(encoded, 'base64');
      assert.equal(bytes.toString('base64'), encoded);
      assert.equal(bytes.length, row.byte_count);
      assert.equal(sha(bytes), row.file_hash);
      const values = JSON.parse(bytes.toString('utf8'));
      assert(Array.isArray(values) && values.length <= 20);
    }
    foreign = (
      await client.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [state.tenant])
    ).rows[0].id;
    await client.query('COMMIT');
    for (const table of batchTables) {
      const rls = (
        await client.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(rls.relrowsecurity && rls.relforcerowsecurity);
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE dyna_app');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [foreign]);
        assert.equal(
          (
            await client.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [
              state.tenant,
            ])
          ).rows[0].n,
          0,
        );
      } finally {
        await client.query('ROLLBACK');
      }
      assert.equal(
        (await client.query("SELECT has_table_privilege('dyna_app',$1,'DELETE') allowed", [table]))
          .rows[0].allowed,
        false,
      );
      await client.query('BEGIN');
      try {
        await assert.rejects(
          client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [state.tenant]),
          /immutable|append-only/i,
        );
      } finally {
        await client.query('ROLLBACK');
      }
    }
    await client.query('BEGIN');
    try {
      await assert.rejects(
        client.query('UPDATE order_field_mapping_executions SET state=state WHERE tenant_id=$1', [
          state.tenant,
        ]),
        /immutable/i,
      );
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      resolve(restored.directory, 'result.json'),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DYNA_PREVIEW_PORT: String(port) },
      stdio: 'ignore',
    },
  );
  const base = `http://127.0.0.1:${port}/api`;
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const h = (await r.json()) as any;
        assert(h.restore_preview && h.order_field_mappings_available);
        assert.equal(h.revision, health.revision);
        assert.equal(h.schema_revision, schema);
        ready = true;
        break;
      }
    } catch {}
    assert(child.exitCode === null && child.signalCode === null, 'Preview process exited');
    await setTimeout(200);
  }
  assert(ready);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: state.email, password: state.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const req = (path: string, method = 'GET', body?: unknown, workspace = state.tenant) =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', 'X-Workspace-Id': workspace },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const reads = [
    '/order-field-mappings/metadata',
    '/order-field-mappings/profiles',
    '/order-field-mappings/previews',
    '/order-field-mappings/executions',
    ...profiles.flatMap((r) => [
      '/order-field-mappings/profiles/' + r.id,
      '/order-field-mappings/profiles/' + r.id + '/revisions',
    ]),
    ...observations.map((r) => '/order-field-mappings/sources/' + r.id),
    ...state.channels.map((c: any) => '/order-field-mappings/sources?channel_id=' + c.id),
    ...executions.map((r) => '/order-field-mappings/executions/' + r.id),
  ];
  for (const path of reads) {
    const r = await req(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const json = (await r.json()) as any;
    assert(
      json.available &&
        json.read_only &&
        !json.can_admin &&
        !json.can_import &&
        !json.can_reconcile,
    );
  }
  let rowPages = 0;
  for (const p of previews) {
    let cursor: string | undefined;
    do {
      const r = await req(
        '/order-field-mappings/previews/' +
          p.id +
          (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      );
      assert.equal(r.status, 200);
      const json = (await r.json()) as any;
      assert(json.available && json.read_only && Array.isArray(json.data));
      rowPages++;
      cursor = json.meta?.cursor;
    } while (cursor);
  }
  const firstInitial = previews.find((p) => p.kind === 'initial').id,
    firstReconcile = previews.find((p) => p.kind === 'reconcile').id;
  const writes: [string, string, unknown][] = [
    ['/order-field-mappings/profiles', 'POST', {}],
    ['/order-field-mappings/profiles/' + profiles[0].id, 'PATCH', {}],
    ['/order-field-mappings/previews', 'POST', {}],
    ['/order-field-mappings/previews/' + firstInitial + '/import', 'POST', {}],
    ['/order-field-mappings/previews/' + firstReconcile + '/queue', 'POST', {}],
    ['/order-field-mappings/executions/' + executions[0].id + '/cancel', 'POST', {}],
  ];
  for (const [path, method, body] of writes)
    assert.equal((await req(path, method, body)).status, 423, path);
  assert.equal(
    (await req('/order-field-mappings/metadata', 'GET', undefined, foreign)).status,
    409,
  );
  assert.equal((await fetch(liveBase + '/auth/me', { headers: { cookie } })).status, 401);
  assertSame(
    await readOwnSnapshot(state.tenant, database),
    before,
    'Readonly restored own commerce unchanged',
  );
  assertSame(await readOwnSnapshot(state.tenant), before, 'Live own commerce unchanged');
  report = {
    stage: 102,
    verified_at: new Date().toISOString(),
    source_revision: restored.revision,
    schema,
    backup_id: backup.id,
    restore_tables: restored.tables,
    migrations: migrationCount,
    all_snapshot_rows_verified: true,
    schema_fingerprint_verified: true,
    encrypted_records_verified: restored.encrypted_records_verified,
    encrypted_sources: encryptionCounts,
    own_observations_decoded: observations.length,
    source_checksum_verified: true,
    qa_business_tables_exact: businessTables.length,
    force_RLS_verified: true,
    foreign_rows_hidden: true,
    evidence_append_only: true,
    terminal_results_immutable: true,
    preview_read_paths: reads.length,
    preview_row_pages: rowPages,
    preview_mutation_statuses: writes.map(() => 423),
    workspace_mismatch_status: 409,
    preview_cookie_on_live_http: 401,
    worker_enabled: false,
    external_provider_verified: false,
    goal_complete: false,
  };
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((r) => child!.once('exit', () => r()));
    child.kill('SIGTERM');
    if (!(await Promise.race([exited.then(() => true), setTimeout(10000).then(() => false)]))) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  if (database) {
    const admin = new pg.Client({ ...localDatabase(), database: 'postgres' });
    await admin.connect();
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [database],
      );
      await admin.query('DROP DATABASE ' + database);
    } finally {
      await admin.end();
    }
  }
  await pool.end();
}
assert(report);
report.preview_database_removed = true;
await writeFile('docs/order-field-mappings-recovery-qa.json', JSON.stringify(report, null, 2));
console.log({
  stage: 102,
  tables: report.restore_tables,
  migrations: report.migrations,
  encrypted: report.encrypted_records_verified,
  observations: report.own_observations_decoded,
  reads: report.preview_read_paths,
  writes423: report.preview_mutation_statuses.length,
  cleanup: true,
});
