/**
 * Stage101 B1 recovery drill — run only after native acceptance and full restart.
 * Input: data/order-field-batches-stage101.json, an existing regular private 0600 file.
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

const statePath = 'data/order-field-batches-stage101.json';
const liveBase = 'http://127.0.0.1:4100/api';
const schema = '079_order_field_batches';
const batchTables = [
  'order_field_batch_previews',
  'order_field_batch_rows',
  'order_field_batch_executions',
  'order_field_batch_execution_rows',
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
let report: Record<string, unknown> | undefined;
let cleanupSucceeded = false;
try {
  const inputStat = await lstat(statePath);
  assert(inputStat.isFile() && !inputStat.isSymbolicLink(), 'QA state must be a regular file');
  assert.equal(inputStat.mode & 0o777, 0o600, 'QA state must have mode0600');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert(typeof state.tenant === 'string' && uuid.test(state.tenant), 'Own QA tenant is required');
  assert(
    typeof state.email === 'string' && typeof state.password === 'string',
    'Existing own QA login is required',
  );
  assert(
    state.apiAcceptance && state.orders?.length >= 2 && state.fields?.length >= 7,
    'Run Stage101 native API acceptance before the recovery drill',
  );
  const response = await fetch(liveBase + '/health');
  assert.equal(response.status, 200, 'Live health must be available');
  const health = (await response.json()) as any;
  assert.equal(health.schema_revision, schema);
  assert(
    health.order_fields_available && health.order_field_batches_available,
    'StageA and B1 must be active',
  );
  assert.match(health.revision, /^[a-f0-9]{40}$/);
  if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
  process.env.APP_REVISION = health.revision;
  const before = await readOwnSnapshot(state.tenant);
  assert(
    before.order_field_batch_previews.count >= 2 && before.order_field_batch_executions.count >= 1,
    'Native CSV and bulk execution evidence must exist',
  );
  const sourcePreviews: any[] = (
    await pool.query(
      'SELECT id,kind FROM order_field_batch_previews WHERE tenant_id=$1 ORDER BY id',
      [state.tenant],
    )
  ).rows;
  assert(
    sourcePreviews.some((p) => p.kind === 'csv') && sourcePreviews.some((p) => p.kind === 'bulk'),
    'Both CSV and bulk preview evidence are required',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM order_field_batch_executions WHERE tenant_id=$1 AND state='queued'",
        [state.tenant],
      )
    ).rows[0].n,
    0,
    'Finish own queued executions before the drill',
  );
  const port = Number(process.env.DYNA_PREVIEW_PORT ?? 4102);
  assert(Number.isInteger(port) && port >= 4101 && port <= 4199, 'Preview port must be4101..4199');
  let occupied = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    occupied = true;
  } catch {}
  assert(!occupied, 'Preview port is occupied');
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/order-field-batches-101-restore',
  });
  database = restoreDatabaseName(restored.database);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert.equal(restored.worker_enabled, false);
  assert.equal(restored.revision, health.revision);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(resolve(restored.directory, 'manifest.json'), 'utf8')),
  );
  const recovered = JSON.parse(await readFile(restored.config, 'utf8'));
  assert(
    typeof recovered.encryptionKey === 'string' && /^[a-f0-9]{64}$/.test(recovered.encryptionKey),
    'Recovered encryption key is invalid',
  );
  const client = new pg.Client({ ...localDatabase(), database });
  await client.connect();
  let ownPreviewIds: string[] = [],
    executionIds: string[] = [],
    fieldIds: string[] = [],
    fileRows: any[] = [];
  let foreignTenant = '',
    foreignFile: string | null = null,
    foreignPreview: string | null = null,
    foreignExecution: string | null = null;
  let migrationCount = 0,
    csvCount = 0,
    parsedCsvRows = 0;
  let nativeCsvSourceSeen = false;
  const encryptionCounts: Record<string, number> = {};
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const actualTables = await tableFingerprints(client);
    assertSame(
      actualTables,
      manifest.tables,
      'Every restored public table must match the sealed snapshot',
    );
    assert.equal(restored.tables, Object.keys(actualTables).length);
    assert.equal(backup.tables, restored.tables);
    assert.equal(
      await schemaFingerprint(client, manifest.schema_fingerprint_version ?? 1),
      manifest.schema_sha256,
    );
    for (const table of batchTables)
      assert(actualTables[table], 'Required batch table is absent: ' + table);
    const migrations = (await client.query('SELECT name FROM migrations ORDER BY name')).rows.map(
      (r) => r.name,
    );
    assert.equal(migrations.at(-1), schema);
    migrationCount = migrations.length;
    assert.equal(String(migrationCount), manifest.tables.migrations.count);
    assertSame(
      await ownFingerprints(client, state.tenant),
      before,
      'Own business rows must be preserved exactly',
    );
    ownPreviewIds = (
      await client.query(
        'SELECT id FROM order_field_batch_previews WHERE tenant_id=$1 ORDER BY id',
        [state.tenant],
      )
    ).rows.map((r) => r.id);
    executionIds = (
      await client.query(
        'SELECT id FROM order_field_batch_executions WHERE tenant_id=$1 ORDER BY id',
        [state.tenant],
      )
    ).rows.map((r) => r.id);
    fieldIds = (
      await client.query(
        'SELECT id FROM order_field_definitions WHERE tenant_id=$1 ORDER BY position,id',
        [state.tenant],
      )
    ).rows.map((r) => r.id);
    assert(
      fieldIds.length >= 7 && fieldIds.length <= 20,
      'The native QA export must contain7..20 own fields',
    );
    const other = (
      await client.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [state.tenant])
    ).rows[0];
    assert(other, 'A prior tenant is required to prove isolation');
    foreignTenant = other.id;
    for (const [table, column] of encryptedSources) {
      const present = (await client.query('SELECT to_regclass($1) present', ['public.' + table]))
        .rows[0].present;
      if (!present) continue;
      const n = (
        await client.query(`SELECT count(*)::int n FROM ${table} WHERE ${column} IS NOT NULL`)
      ).rows[0].n;
      encryptionCounts[table + '.' + column] = n;
    }
    assert.equal(
      Object.values(encryptionCounts).reduce((sum, n) => sum + n, 0),
      restored.encrypted_records_verified,
      'Dynamic decrypt-handler record count must match restore result',
    );
    let cursor: string | null = null;
    while (true) {
      const sources: any[] = (
        await client.query(
          'SELECT id,tenant_id,encrypted_bytes,byte_count,file_hash,config,summary FROM order_field_batch_previews WHERE encrypted_bytes IS NOT NULL AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 5',
          [cursor],
        )
      ).rows;
      if (!sources.length) break;
      for (const source of sources) {
        const content = decrypt(source.encrypted_bytes, recovered.encryptionKey).content_base64;
        assert(typeof content === 'string', 'Restored CSV payload is absent');
        const bytes = orderFieldBatchCsvBytes(content);
        assert.equal(bytes.length, source.byte_count, 'Restored CSV byte_count mismatch');
        assert.equal(sha(bytes), source.file_hash, 'Restored CSV checksum mismatch');
        const parsed = parseOrderFieldBatchCsv(bytes, source.config);
        assert.equal(parsed.file_hash, source.file_hash, 'Decoded CSV checksum mismatch');
        assert.equal(parsed.rows.length, source.summary.total, 'Decoded CSV row count mismatch');
        if (source.tenant_id === state.tenant) {
          csvCount++;
          parsedCsvRows += parsed.rows.length;
          if (state.csvPayload && content === state.csvPayload) {
            nativeCsvSourceSeen = true;
            assert(
              sha(bytes) === sha(Buffer.from(state.csvPayload, 'base64')),
              'Native CSV source must remain byteexact',
            );
          }
        }
      }
      cursor = sources.at(-1).id;
    }
    assert(csvCount >= 1, 'Own encrypted native CSV must be decoded');
    if (state.csvPayload)
      assert(
        nativeCsvSourceSeen,
        'The exact native CSV source must be present in the restored backup',
      );
    fileRows = (
      await client.query(
        'SELECT id,encrypted_bytes,byte_count,file_hash,mime_type FROM order_field_files WHERE tenant_id=$1 ORDER BY id',
        [state.tenant],
      )
    ).rows;
    assert(fileRows.length >= 2, 'Native private files are required');
    for (const f of fileRows) {
      const content = decrypt(f.encrypted_bytes, recovered.encryptionKey).content_base64;
      const bytes = orderFieldBatchCsvBytes(content);
      assert.equal(bytes.length, f.byte_count, 'Restored private file byte_count mismatch');
      assert.equal(sha(bytes), f.file_hash, 'Restored private file checksum mismatch');
    }
    foreignFile =
      (
        await client.query(
          'SELECT id FROM order_field_files WHERE tenant_id<>$1 ORDER BY id LIMIT 1',
          [state.tenant],
        )
      ).rows[0]?.id ?? null;
    foreignPreview =
      (
        await client.query(
          'SELECT id FROM order_field_batch_previews WHERE tenant_id<>$1 ORDER BY id LIMIT 1',
          [state.tenant],
        )
      ).rows[0]?.id ?? null;
    foreignExecution =
      (
        await client.query(
          'SELECT id FROM order_field_batch_executions WHERE tenant_id<>$1 ORDER BY id LIMIT 1',
          [state.tenant],
        )
      ).rows[0]?.id ?? null;
    await client.query('COMMIT');
    for (const table of businessTables.filter((t) => t.startsWith('order_field_'))) {
      const rls = (
        await client.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0];
      assert(rls.relrowsecurity && rls.relforcerowsecurity, table + ' must force RLS');
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE dyna_app');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [foreignTenant]);
        assert.equal(
          (
            await client.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [
              state.tenant,
            ])
          ).rows[0].n,
          0,
          table + ' foreign rows must be hidden',
        );
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [state.tenant]);
        assert.equal(
          (
            await client.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [
              state.tenant,
            ])
          ).rows[0].n,
          before[table].count,
          table + ' own rows must remain accessible',
        );
      } finally {
        await client.query('ROLLBACK');
      }
    }
    for (const table of batchTables) {
      assert.equal(
        (await client.query("SELECT has_table_privilege('dyna_app',$1,'DELETE') allowed", [table]))
          .rows[0].allowed,
        false,
        table + ' must not grant DELETE',
      );
      if (table !== 'order_field_batch_executions')
        assert.equal(
          (
            await client.query("SELECT has_table_privilege('dyna_app',$1,'UPDATE') allowed", [
              table,
            ])
          ).rows[0].allowed,
          false,
          table + ' must not grant UPDATE',
        );
      await client.query('BEGIN');
      try {
        await assert.rejects(
          client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [state.tenant]),
          /append-only|immutable/i,
        );
      } finally {
        await client.query('ROLLBACK');
      }
    }
    await client.query('BEGIN');
    try {
      await assert.rejects(
        client.query('UPDATE order_field_batch_executions SET state=state WHERE tenant_id=$1', [
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
  for (let n = 0; n < 60; n++) {
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const h = (await r.json()) as any;
        assert(h.restore_preview && h.order_fields_available && h.order_field_batches_available);
        assert.equal(h.revision, health.revision);
        assert.equal(h.schema_revision, schema);
        ready = true;
        break;
      }
    } catch {}
    assert(
      child.exitCode === null && child.signalCode === null,
      'Readonly preview exited before health',
    );
    await setTimeout(200);
  }
  assert(ready, 'Readonly preview must become healthy');
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: state.email, password: state.password }),
  });
  assert.equal(login.status, 200, 'Own restored QA login must succeed');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie?.startsWith(`dyna_session_preview_${port}=`), 'Preview cookie must be isolated');
  const req = (path: string, method = 'GET', body?: unknown, workspace = state.tenant) =>
    fetch(base + path, {
      method,
      headers: { cookie: cookie!, 'X-Workspace-ID': workspace, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const reads = [
    '/order-fields',
    ...state.orders.flatMap((order: { id: string }) => [
      '/orders/' + order.id + '/fields',
      '/orders/' + order.id + '/fields/history',
    ]),
    '/order-field-batches',
    '/order-field-batches/previews',
    '/order-field-batches/executions',
    ...ownPreviewIds.map((id) => '/order-field-batches/previews/' + id),
    ...executionIds.map((id) => '/order-field-batches/executions/' + id),
  ];
  let previewPages = 0;
  for (const path of reads) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const r = await req(path + (cursor ? '?' + new URLSearchParams({ cursor }) : ''));
      assert.equal(r.status, 200, 'Readonly read must succeed: ' + path);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const data = (await r.json()) as any;
      assert(
        data.available && data.read_only && data.can_write === false,
        'Readonly flags must be explicit: ' + path,
      );
      assert(
        !Object.hasOwn(data, 'encrypted_bytes') && !Object.hasOwn(data, 'content_base64'),
        'History must not reveal encrypted source bytes',
      );
      if (path.includes('/previews/')) {
        assert(data.data.length <= 50, 'Preview page bound');
        previewPages++;
      }
      if (path === '/order-field-batches/previews' || path === '/order-field-batches/executions')
        assert(data.data.length <= 20, 'History page bound');
      if (path.includes('/executions/'))
        assert(data.data.length <= 100, 'Exact execution selection bound');
      cursor = data.meta?.cursor ?? null;
      if (cursor) {
        assert(!seen.has(cursor), 'History/row cursor must progress');
        seen.add(cursor);
      }
    } while (cursor);
  }
  const exportModes = ['csv_exact', 'csv_sheet', 'json'] as const;
  let exportPages = 0;
  for (const mode of exportModes) {
    let cursor: string | null = null,
      exported = 0;
    const seen = new Set<string>();
    do {
      const q = new URLSearchParams({
        field_ids: JSON.stringify(fieldIds),
        order_ids: JSON.stringify(state.orders.map((o: any) => o.id)),
        mode,
        limit: '1',
        ...(cursor ? { cursor } : {}),
      });
      const r = await req('/order-field-batches/export?' + q);
      assert.equal(r.status, 200, 'Readonly export must succeed');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const result = (await r.json()) as any;
      assert(result.available && result.read_only && result.can_write === false);
      const bytes = Buffer.from(result.content_base64, 'base64');
      assert.equal(
        bytes.toString('base64'),
        result.content_base64,
        'Export base64 must be canonical',
      );
      assert.equal(sha(bytes), result.sha256, 'Export must be byteexact');
      assert(result.count >= 0 && result.count <= 1, 'Export page bound');
      exported += result.count;
      exportPages++;
      if (mode === 'csv_exact' && result.count) {
        const parsed = parseOrderFieldBatchCsv(bytes, result.config);
        assert.equal(parsed.rows.length, result.count);
      }
      if (mode === 'json') {
        const body = JSON.parse(bytes.toString('utf8'));
        assert.equal(body.data.length, result.count);
        assert.equal(body.definitions.length, fieldIds.length);
      }
      cursor = result.meta.cursor;
      if (cursor) {
        assert(!seen.has(cursor), 'Export cursor must progress');
        seen.add(cursor);
      }
    } while (cursor);
    assert.equal(exported, state.orders.length, 'All explicitly selected orders must export');
  }
  for (const f of fileRows) {
    const r = await req('/order-field-files/' + f.id + '/download');
    assert.equal(r.status, 200, 'Readonly private download must succeed');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(r.headers.get('content-type'), f.mime_type);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(bytes.length, f.byte_count);
    assert.equal(sha(bytes), f.file_hash, 'Readonly download must be byteexact');
  }
  const writes: [string, string, unknown][] = [
    ['/order-field-batches/previews', 'POST', { kind: 'bulk' }],
    ['/order-field-batches/previews', 'POST', { kind: 'csv' }],
    ['/order-field-batches/previews/' + ownPreviewIds[0] + '/queue', 'POST', {}],
    ['/order-field-batches/executions/' + executionIds[0] + '/cancel', 'POST', {}],
    ['/order-field-files', 'POST', {}],
  ];
  for (const [path, method, body] of writes)
    assert.equal(
      (await req(path, method, body)).status,
      423,
      'Readonly must reject before parsing: ' + path,
    );
  assert.equal(
    (await req('/order-field-batches', 'GET', undefined, foreignTenant)).status,
    409,
    'Workspace mismatch must fail before data projection',
  );
  const foreignPaths = [
    foreignFile ? '/order-field-files/' + foreignFile + '/download' : null,
    foreignPreview ? '/order-field-batches/previews/' + foreignPreview : null,
    foreignExecution ? '/order-field-batches/executions/' + foreignExecution : null,
  ].filter((p): p is string => p !== null);
  for (const path of foreignPaths)
    assert.equal((await req(path)).status, 404, 'Foreign resource must not be readable');
  assert.equal(
    (await fetch(liveBase + '/auth/me', { headers: { cookie: cookie! } })).status,
    401,
    'Preview cookie must not authenticate on live API',
  );
  assertSame(
    await readOwnSnapshot(state.tenant, database),
    before,
    'Readonly requests must leave restored business evidence unchanged',
  );
  assertSame(
    await readOwnSnapshot(state.tenant),
    before,
    'Drill must leave live QA business data unchanged',
  );
  report = {
    stage: 101,
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
    own_csv_sources_decoded: csvCount,
    own_csv_source_rows: parsedCsvRows,
    csv_checksum_and_byte_count_verified: true,
    private_files_decoded: fileRows.length,
    private_downloads_byte_exact: true,
    qa_business_tables_exact: businessTables.length,
    force_RLS_verified: true,
    foreign_firm_rows_hidden: true,
    batch_evidence_append_only: true,
    batch_terminal_results_immutable: true,
    preview_read_paths: reads.length,
    preview_row_pages: previewPages,
    preview_reads_status: 200,
    export_modes: exportModes,
    export_pages: exportPages,
    export_hashes_verified: true,
    preview_mutation_statuses: writes.map(() => 423),
    workspace_mismatch_status: 409,
    existing_foreign_resource_checks: foreignPaths.length,
    existing_foreign_resource_status: foreignPaths.length ? 404 : null,
    preview_cookie_on_live_http: 401,
    worker_enabled: false,
    restored_QA_business_tables_unchanged: true,
    live_QA_business_tables_unchanged: true,
    external_provider_verified: false,
    goal_complete: false,
  };
} finally {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const done = await Promise.race([
        stopped.then(() => true),
        setTimeout(10000).then(() => false),
      ]);
      if (!done) {
        child.kill('SIGKILL');
        await stopped;
      }
    }
    if (database) {
      await pool.query(`DROP DATABASE ${restoreDatabaseName(database)} WITH (FORCE)`);
      cleanupSucceeded = true;
    }
    if (report) {
      report.own_preview_database_removed = cleanupSucceeded;
      await writeFile(
        'docs/order-field-batches-recovery-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    }
  } finally {
    await pool.end();
  }
}
