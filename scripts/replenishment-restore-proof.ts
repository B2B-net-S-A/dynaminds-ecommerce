/** Operator-only QA118: encrypted full restore, exact accepted checkpoints and readonly HTTP. */
import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  localDatabase,
  restoreDatabaseName,
  tableFingerprints,
  schemaFingerprint,
} from '../server/recovery';

type Json = Record<string, any>;
const revision = process.env.QA_EXPECTED_REVISION;
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const schema = '099_replenishment_plans',
  port = 4158;
const statePath = 'data/replenishment-stage118.json';
const reportPath = 'docs/replenishment-recovery-qa.json';
const source = localDatabase(),
  admin = new pg.Client({ ...source, database: 'postgres' });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const stamp = (value: string | Date) => new Date(value).toISOString();
const tables = [
  'purchasing_source_versions',
  'purchasing_stock_changes',
  'replenishment_policies',
  'replenishment_previews',
  'replenishment_rows',
  'replenishment_executions',
  'replenishment_execution_rows',
];
const privateTables = tables.slice(0, 2),
  immutableTables = tables.slice(3);
let state: Json | undefined,
  copied: pg.Client | undefined,
  child: ReturnType<typeof spawn> | undefined;
let owned: string | undefined,
  prior: string[] = [],
  phase = 'prerequisites';
let failed = false,
  cleanupError = false,
  checkpointsVerified = false,
  report: Json | undefined;
const accepted: Json[] = [];
async function privateState(path: string) {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  return JSON.parse(await readFile(path, 'utf8')) as Json;
}
async function checkpoint(c: pg.Client | pg.PoolClient, s: Json) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Json = {};
    for (const name of Object.keys(s.accepted_checkpoint).sort()) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const field = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${field}=$1 ORDER BY 1`, [
          name === 'users' ? s.user : s.tenant,
        ])
      ).rows;
      result[name] = { count: rows.length, sha256: hash(rows) };
    }
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function sourceCheckpoint(s: Json) {
  const c = await pool.connect();
  try {
    return await checkpoint(c, s);
  } finally {
    c.release();
  }
}
async function verifyAccepted(c?: pg.Client) {
  for (const s of accepted)
    assert.deepEqual(
      c ? await checkpoint(c, s) : await sourceCheckpoint(s),
      s.accepted_checkpoint,
      `Accepted stage ${s.stage} checkpoint changed`,
    );
}
async function globalSnapshot(c: pg.Client) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result = {
      tables: await tableFingerprints(c),
      schemaHash: await schemaFingerprint(c),
      sessions: (await c.query('SELECT id,tenant_id,user_id FROM sessions ORDER BY id')).rows,
    };
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function request(base: string, path: string, options: RequestInit = {}) {
  return fetch(base + path, { ...options, signal: AbortSignal.timeout(30000) });
}
async function read(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()) as Json;
}
function readonly(r: Json) {
  assert(r.available && r.can_read && r.read_only);
  assert.equal(r.can_manage, false);
  assert.equal(r.can_preview, false);
  assert.equal(r.can_execute, false);
}
function head(r: Json) {
  return json({
    id: r.id,
    actor_id: r.actor_id,
    warehouse_id: r.warehouse_id,
    ...r.summary,
    ready: r.ready,
    scope_hash: r.scope_hash,
    groups: r.groups,
    warnings: r.warnings ?? [],
    created_at: stamp(r.created_at),
    ...(r.expires_at ? { expires_at: stamp(r.expires_at) } : {}),
    ...(r.preview_id
      ? {
          preview_id: r.preview_id,
          state: r.state,
          before_source_version: String(r.before_source_version),
          after_source_version: String(r.after_source_version),
        }
      : { source_version: String(r.source_version) }),
  });
}
function row(r: Json) {
  return json({
    id: r.id,
    index: r.index,
    product_id: r.product_id,
    sku: r.snapshot.product?.sku ?? null,
    name: r.snapshot.product?.name ?? null,
    policy_snapshot: r.snapshot.policy,
    stock_snapshot: r.snapshot.stock,
    ...r.result,
    status: r.status,
    errors: r.errors,
    warnings: r.warnings,
    contributor_count: r.snapshot.contributors.length,
    ...(r.preview_row_id
      ? { preview_row_id: r.preview_row_id, purchase_order_id: r.purchase_order_id }
      : {}),
  });
}
async function rejectsSql(
  c: pg.Client,
  query: string,
  values: unknown[],
  code: string,
  appRole = false,
) {
  await c.query('BEGIN');
  try {
    if (appRole) await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [state!.tenant]);
    await assert.rejects(c.query(query, values), (e: any) => e.code === code);
  } finally {
    await c.query('ROLLBACK');
  }
}
try {
  await admin.connect();
  prior = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
    (r) => r.datname,
  );
  assert.equal(prior.length, 17);
  state = await privateState(statePath);
  const s = state;
  assert(s.stage === 118 && s.setup_complete && !s.pending && s.accepted_checkpoint);
  assert.equal(Object.keys(s.accepted_checkpoint).length, 28);
  assert.equal(s.preview_ids.length, 2);
  assert.equal(s.execution_ids.length, 2);
  assert(s.policy_id && s.generated_po_id && s.email && s.password && s.cookie);
  const native = JSON.parse(await readFile('docs/replenishment-native-readback-qa.json', 'utf8'));
  assert.equal(native.status, 'PASS');
  assert.equal(native.revision, revision);
  assert.equal(native.schema_revision, schema);
  assert.equal(native.own_tenant, s.tenant);
  assert.equal(native.checkpoint_sha256, hash(s.accepted_checkpoint));
  assert.equal(native.preview_count, 2);
  assert.equal(native.execution_count, 2);
  accepted.push(s);
  for (const [path, stage, count] of [
    ['data/catalog-file-import-stage117.json', 117, 23],
    ['data/catalog-export-sources-stage116.json', 116, 20],
  ] as const) {
    const old = await privateState(path);
    assert(old.stage === stage && old.setup_complete && !old.pending && old.accepted_checkpoint);
    assert.equal(Object.keys(old.accepted_checkpoint).length, count);
    accepted.push(old);
  }
  const secondary = await privateState('data/replenishment-ack-stage118.json');
  assert(
    secondary.stage === 118 &&
      secondary.retry_verified &&
      secondary.after_flow_verified &&
      secondary.final_business_checkpoint,
  );
  assert(secondary.tenant !== s.tenant);
  accepted.push({ ...secondary, accepted_checkpoint: secondary.final_business_checkpoint });
  await verifyAccepted();
  checkpointsVerified = true;
  const main = 'http://127.0.0.1:4100/api';
  const health = (await (await request(main, '/health')).json()) as Json;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, schema);
  assert(health.replenishment_plans_available && !health.restore_preview);
  const probe = createServer();
  await new Promise<void>((done, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', done);
  });
  await new Promise<void>((done) => probe.close(() => done()));
  process.env.APP_REVISION = revision;
  phase = 'encrypted_backup';
  const sourceSequence = (
    await pool.query('SELECT last_value::text,is_called FROM purchasing_stock_changes_id_seq')
  ).rows[0];
  const backup = await createBackup();
  assert.deepEqual(
    (await pool.query('SELECT last_value::text,is_called FROM purchasing_stock_changes_id_seq'))
      .rows[0],
    sourceSequence,
    'Stock marker sequence changed during the backup observation; retry this proof on a stable source',
  );
  phase = 'isolated_restore';
  const restored = await restoreBackup(backup.file, {
    directory: 'data/replenishment-118-restore',
  });
  const name = restoreDatabaseName(restored.database);
  assert(!prior.includes(name));
  owned = name;
  assert.equal(restored.status, 'verified');
  assert.equal(restored.revision, revision);
  assert.equal(restored.tables, 278);
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      restored.preview_only &&
      restored.worker_enabled === false,
  );
  const config = JSON.parse(await readFile(restored.config, 'utf8'));
  copied = new pg.Client({ ...source, database: name, password: config.dbPassword });
  await copied.connect();
  await verifyAccepted(copied);
  const before = await globalSnapshot(copied);
  assert.equal(Object.keys(before.tables).length, 278);
  const manifest = JSON.parse(await readFile(resolve(restored.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.revision, revision);
  assert.deepEqual(before.tables, manifest.tables);
  assert.equal(before.schemaHash, manifest.schema_sha256);
  const migrations = (await copied.query('SELECT name FROM migrations ORDER BY name')).rows;
  assert.equal(migrations.length, 99);
  assert.equal(migrations.at(-1)?.name, schema);
  phase = 'scope_privileges_and_sequence';
  const flags = (
    await copied.query(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname",
      [tables],
    )
  ).rows;
  assert.equal(flags.length, 7);
  assert(flags.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  const foreign = (
    await copied.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [s.tenant])
  ).rows[0];
  assert(foreign);
  await copied.query('BEGIN');
  try {
    await copied.query('SET LOCAL ROLE dyna_app');
    await copied.query("SELECT set_config('app.tenant_id',$1,true)", [foreign.id]);
    for (const table of tables.slice(2))
      assert.equal(
        (
          await copied.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [
            s.tenant,
          ])
        ).rows[0].n,
        0,
      );
  } finally {
    await copied.query('ROLLBACK');
  }
  for (const table of privateTables) {
    const grants: Json = (
      await copied.query(
        "SELECT has_table_privilege('dyna_app',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') permitted",
        [table],
      )
    ).rows[0];
    assert.equal(grants.permitted, false);
    const publicGrants: Json = (
      await copied.query(
        `SELECT count(*)::int n FROM pg_class c,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=$1::regclass AND a.grantee=0`,
        [table],
      )
    ).rows[0];
    assert.equal(publicGrants.n, 0);
    await rejectsSql(copied, `SELECT * FROM ${table} LIMIT 1`, [], '42501', true);
  }
  assert.equal(
    (
      await copied.query(
        "SELECT has_sequence_privilege('dyna_app','purchasing_stock_changes_id_seq','USAGE,SELECT,UPDATE') permitted",
      )
    ).rows[0].permitted,
    false,
  );
  assert.equal(
    (
      await copied.query(`SELECT count(*)::int n FROM pg_class c,
    LATERAL aclexplode(coalesce(c.relacl,acldefault('s',c.relowner))) a
    WHERE c.oid='purchasing_stock_changes_id_seq'::regclass AND a.grantee=0`)
    ).rows[0].n,
    0,
  );
  for (const functionName of [
    'purchasing_source_admit()',
    'purchasing_stock_admit()',
    'purchasing_source_version()',
  ]) {
    const f: Json = (
      await copied.query(
        `SELECT p.prosecdef,p.proconfig,
      has_function_privilege('dyna_app',p.oid,'EXECUTE') app,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE grantee=0 AND privilege_type='EXECUTE') allowed_public
      FROM pg_proc p WHERE p.oid=$1::regprocedure`,
        [functionName],
      )
    ).rows[0];
    assert(
      f.prosecdef &&
        f.app &&
        !f.allowed_public &&
        f.proconfig.includes('search_path=pg_catalog, public'),
    );
  }
  for (const functionName of [
    'purchasing_source_admit()',
    'purchasing_stock_admit()',
    'purchasing_source_version()',
  ]) {
    await copied.query('BEGIN');
    try {
      await copied.query('SET LOCAL ROLE dyna_app');
      await copied.query("SELECT set_config('app.tenant_id','',true)");
      await assert.rejects(copied.query('SELECT ' + functionName), (e: any) => e.code === '42501');
    } finally {
      await copied.query('ROLLBACK');
    }
  }
  for (const table of immutableTables)
    await rejectsSql(copied, `UPDATE ${table} SET id=id WHERE tenant_id=$1`, [s.tenant], '23514');
  await rejectsSql(
    copied,
    'UPDATE purchasing_stock_changes SET tenant_id=tenant_id WHERE tenant_id=$1',
    [s.tenant],
    '23514',
  );
  const maximum = BigInt(
    (await copied.query('SELECT coalesce(max(id),0)::text n FROM purchasing_stock_changes')).rows[0]
      .n,
  );
  const sequence = (
    await copied.query('SELECT last_value::text,is_called FROM purchasing_stock_changes_id_seq')
  ).rows[0];
  assert.deepEqual(
    sequence,
    sourceSequence,
    'Restore must preserve the captured source sequence state exactly',
  );
  assert(BigInt(sequence.last_value) >= maximum);
  // This advances only the owned copy sequence; no source marker or application row is inserted.
  const next = BigInt(
    (await copied.query("SELECT nextval('purchasing_stock_changes_id_seq')::text n")).rows[0].n,
  );
  assert(next > maximum, 'Restored private marker sequence must never reuse an existing id');
  phase = 'readonly_preview';
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
  let childError = false;
  child.once('error', () => {
    childError = true;
  });
  const base = `http://127.0.0.1:${port}/api`;
  let ready = false;
  for (let n = 0; n < 80; n++) {
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const h = (await response.json()) as Json;
        assert(h.restore_preview && h.replenishment_plans_available);
        assert.equal(h.revision, revision);
        assert.equal(h.schema_revision, schema);
        ready = true;
        break;
      }
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
    assert(!childError && child.exitCode === null && child.signalCode === null);
    await delay(150);
  }
  assert(ready);
  assert.equal(
    (await request(base, '/replenishment/options', { headers: { cookie: s.cookie } })).status,
    401,
  );
  const login = await request(base, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: s.email, password: s.password }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert(setCookie);
  const cookie = setCookie.split(';')[0],
    headers = { cookie, 'X-Workspace-ID': s.tenant };
  const me = await read(await request(base, '/auth/me', { headers }));
  assert.equal(me.user.id, s.user);
  assert.equal((await request(main, '/auth/me', { headers: { cookie } })).status, 401);
  assert.equal(
    (
      await request(base, '/replenishment/options', {
        headers: { cookie, 'X-Workspace-ID': foreign.id },
      })
    ).status,
    409,
  );
  readonly(await read(await request(base, '/replenishment/options', { headers })));
  const rawPolicy = (
    await copied.query('SELECT * FROM replenishment_policies WHERE tenant_id=$1', [s.tenant])
  ).rows;
  assert.equal(rawPolicy.length, 1);
  assert.equal(rawPolicy[0].id, s.policy_id);
  const p = rawPolicy[0];
  const policy = await read(await request(base, '/replenishment/policies/' + p.id, { headers }));
  readonly(policy);
  assert.deepEqual(
    policy.policy,
    json({
      id: p.id,
      warehouse_id: p.warehouse_id,
      product_id: p.product_id,
      version: p.version,
      ...p.definition,
      created_at: stamp(p.created_at),
      updated_at: stamp(p.updated_at),
    }),
  );
  const previews = (
    await copied.query(
      'SELECT * FROM replenishment_previews WHERE tenant_id=$1 ORDER BY created_at,id',
      [s.tenant],
    )
  ).rows;
  const executions = (
    await copied.query(
      'SELECT * FROM replenishment_executions WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC',
      [s.tenant],
    )
  ).rows;
  assert.equal(previews.length, 2);
  assert.equal(executions.length, 2);
  assert.deepEqual(previews.map((r) => r.id).sort(), [...s.preview_ids].sort());
  assert.deepEqual(executions.map((r) => r.id).sort(), [...s.execution_ids].sort());
  const history = await read(await request(base, '/replenishment/executions', { headers }));
  readonly(history);
  assert.deepEqual(history.data, executions.map(head));
  assert.equal(history.meta.cursor, null);
  let detailReads = 0,
    contributorReads = 0;
  for (const [kind, rawHeads, rowTable, parent] of [
    ['previews', previews, 'replenishment_rows', 'preview_id'],
    ['executions', executions, 'replenishment_execution_rows', 'execution_id'],
  ] as const)
    for (const h of rawHeads) {
      const detail = await read(await request(base, `/replenishment/${kind}/${h.id}`, { headers }));
      readonly(detail);
      assert.deepEqual(detail[kind === 'previews' ? 'preview' : 'execution'], head(h));
      detailReads++;
      const rawRows: Json[] = (
        await copied.query(
          `SELECT * FROM ${rowTable} WHERE tenant_id=$1 AND ${parent}=$2 ORDER BY index`,
          [s.tenant, h.id],
        )
      ).rows;
      assert.equal(rawRows.length, h.summary.total);
      const page = await read(
        await request(base, `/replenishment/${kind}/${h.id}/rows`, { headers }),
      );
      readonly(page);
      assert.equal(page.scope_hash, h.scope_hash);
      assert.equal(page.meta.total, rawRows.length);
      assert.equal(page.meta.cursor, null);
      assert.deepEqual(page.data, rawRows.map(row));
      detailReads++;
      if (kind === 'previews')
        for (const r of rawRows) {
          const contributors = await read(
            await request(base, `/replenishment/previews/${h.id}/rows/${r.id}/contributors`, {
              headers,
            }),
          );
          readonly(contributors);
          assert.deepEqual(contributors.data, r.snapshot.contributors);
          assert.equal(contributors.meta.cursor, null);
          contributorReads++;
        }
    }
  const po = await read(await request(base, '/purchase-orders/' + s.generated_po_id, { headers }));
  assert.equal(po.state, 'partial');
  assert.equal(po.replenishment_execution_id, executions.find((e) => e.groups.length === 1)!.id);
  assert.equal(po.lines.length, 1);
  assert.equal(po.lines[0].quantity, 12);
  assert.equal(po.lines[0].received_quantity, 6);
  const writes: [string, string][] = [
    ['POST', '/replenishment/policies'],
    ['PATCH', '/replenishment/policies/' + p.id],
    ['POST', '/replenishment/previews'],
    ['POST', '/replenishment/previews/' + previews[0].id + '/execute'],
  ];
  for (const [method, endpoint] of writes) {
    const r = await request(base, endpoint, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(r.status, 423);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  await verifyAccepted(copied);
  const after = await globalSnapshot(copied);
  assert.equal(after.schemaHash, before.schemaHash);
  assert.deepEqual(Object.keys(after.tables), Object.keys(before.tables));
  for (const [name, fingerprint] of Object.entries(before.tables))
    if (name !== 'sessions')
      assert.deepEqual(after.tables[name], fingerprint, 'Readonly changed table ' + name);
  const oldIds = new Set(before.sessions.map((r) => r.id)),
    added = after.sessions.filter((r) => !oldIds.has(r.id));
  assert.equal(added.length, 1);
  assert.equal(added[0].tenant_id, s.tenant);
  assert.equal(added[0].user_id, s.user);
  assert.equal(after.sessions.length, before.sessions.length + 1);
  await copied.query("SET TIME ZONE 'UTC'");
  const retained = (
    await copied.query(
      `SELECT count(*)::text count,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),1,16))::bit(64)::bigint),0)::text high,
    coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),17,16))::bit(64)::bigint),0)::text low FROM sessions t WHERE id<>$1`,
      [added[0].id],
    )
  ).rows[0];
  assert.deepEqual(retained, before.tables.sessions);
  report = {
    status: 'PASS',
    stage: 118,
    runtime_revision: revision,
    schema_revision: schema,
    tables: 278,
    migrations: 99,
    encrypted_records_verified: restored.encrypted_records_verified,
    full_manifest_verified_by_restore: true,
    schema_fingerprint_exact: true,
    own_checkpoint_tables: 28,
    secondary_two_currency_checkpoint_tables: Object.keys(secondary.final_business_checkpoint)
      .length,
    secondary_two_currency_checkpoint_exact_source_and_copy: true,
    historical_checkpoints: [
      { stage: 117, tables: 23 },
      { stage: 116, tables: 20 },
    ],
    accepted_checkpoints_exact_source_and_copy: true,
    force_rls_tables: tables,
    private_tables_no_app_grants: true,
    source_helpers_security_definer_own_scope: true,
    source_helpers_no_public_execute: true,
    immutable_evidence_checks: immutableTables.length + 1,
    private_marker_sequence_nextval_gt_max: true,
    private_marker_sequence_exact_source_at_backup: true,
    sequence_check_only_owned_copy: true,
    foreign_scope_denied: true,
    execution_history_exact: 2,
    public_head_rows_exact: true,
    detail_and_rows_reads: detailReads,
    contributor_reads: contributorReads,
    writes_denied_before_parse: writes.length,
    non_session_tables_exact_after_preview: true,
    original_sessions_exact: true,
    new_own_preview_sessions: 1,
    source_cookie_denied: true,
    preview_cookie_denied_on_source: true,
    foreign_workspace_denied: true,
    preview_only: true,
    worker_enabled: false,
    no_provider_worker_started: true,
    full_goal_complete: false,
  };
} catch (e) {
  failed = true;
  await writeFile(
    'data/replenishment-recovery-error.txt',
    e instanceof Error ? (e.stack ?? e.message) : String(e),
    { mode: 0o600 },
  );
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let n = 0; n < 30 && child.exitCode === null && child.signalCode === null; n++)
      await delay(100);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((done) => child!.once('exit', () => done()));
    }
  }
  try {
    await copied?.end();
  } catch {
    cleanupError = true;
  }
  try {
    if (owned) {
      assert(!prior.includes(owned));
      await admin.query('DROP DATABASE ' + restoreDatabaseName(owned) + ' WITH (FORCE)');
    }
  } catch {
    cleanupError = true;
  }
  try {
    if (prior.length)
      assert.deepEqual(
        (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
          (r) => r.datname,
        ),
        prior,
      );
  } catch {
    cleanupError = true;
  }
  try {
    if (checkpointsVerified) await verifyAccepted();
  } catch {
    cleanupError = true;
  }
  await admin.end().catch(() => {});
  await pool.end().catch(() => {});
}
if (failed || cleanupError || !report) {
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: 'FAIL',
        stage: 118,
        phase,
        cleanup_verified: !cleanupError,
        private_error_details_suppressed: true,
        full_goal_complete: false,
      },
      null,
      2,
    ),
  );
  process.stderr.write(
    JSON.stringify({ status: 'FAIL', phase, cleanup_verified: !cleanupError }) + '\n',
  );
  process.exitCode = 1;
} else {
  Object.assign(report, {
    original_databases_preserved: prior.length,
    owned_preview_and_database_removed: true,
    accepted_source_checkpoints_exact_after_cleanup: true,
  });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({
      status: 'PASS',
      stage: 118,
      tables: 278,
      writes_denied: 4,
      original_databases_preserved: prior.length,
    }) + '\n',
  );
}
