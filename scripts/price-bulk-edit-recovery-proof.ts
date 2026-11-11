/** Actual local backup/restore of QA108. Cleanup removes only this run's fresh copy. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
const state = JSON.parse(await readFile('data/price-bulk-edit-stage108.json', 'utf8'));
const schema = '087_price_bulk_edit',
  port = 4138;
const evidence = [
  'price_bulk_edit_previews',
  'price_bulk_edit_rows',
  'price_bulk_edit_executions',
  'price_bulk_edit_execution_rows',
];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let child: ReturnType<typeof spawn> | undefined,
  database: string | undefined,
  prior: string[] = [],
  report: any;
async function names() {
  const c = new pg.Client({ ...localDatabase(), database: 'postgres' });
  await c.connect();
  try {
    return (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname,
    );
  } finally {
    await c.end();
  }
}
async function snapshot(ids: string[], tables: string[], db = localDatabase().database) {
  const c = new pg.Client({ ...localDatabase(), database: db });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Record<string, string> = {};
    for (const t of tables) {
      assert(/^[a-z][a-z0-9_]*$/.test(t));
      out[t] = hash(
        (
          await c.query(
            `SELECT to_jsonb(t) row FROM "${t}" t WHERE ${t === 'tenants' ? 'id' : 'tenant_id'}=ANY($1::uuid[]) ORDER BY 1`,
            [ids],
          )
        ).rows,
      );
    }
    await c.query('COMMIT');
    return out;
  } finally {
    await c.end();
  }
}
async function preservedBusiness(db = localDatabase().database) {
  assert.deepEqual(await snapshot(state.ids, state.protected_names, db), state.before);
  const baselineTimezone = Object.values((await pool.query('SHOW TimeZone')).rows[0])[0];
  const client = new pg.Client({ ...localDatabase(), database: db });
  await client.connect();
  try {
    await client.query("SELECT set_config('TimeZone',$1,false)", [baselineTimezone]);
    const users = (
      await client.query(
        'SELECT to_jsonb(u) row FROM users u WHERE id=ANY($1::uuid[]) ORDER BY id',
        [state.user_ids],
      )
    ).rows;
    assert.equal(hash(users), state.users_hash);
  } finally {
    await client.end();
  }
}

try {
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(health.schema_revision, schema);
  assert(health.price_bulk_edit_available);
  assert.equal(health.revision, state.runtime_revision);
  assert(state.exercised && state.ui_verified && state.own_snapshot);
  await preservedBusiness();
  assert.deepEqual(await snapshot([state.tenant], state.own_names), state.own_snapshot);
  prior = await names();
  process.env.APP_REVISION = health.revision;
  let occupied = false;
  try {
    occupied = (
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })
    ).ok;
  } catch {}
  assert(!occupied);
  const backup = await createBackup({ directory: 'data/backups' });
  const restored = await restoreBackup(backup.file, {
    directory: 'data/price-bulk-edit-108-restore',
  });
  const fresh = restoreDatabaseName(restored.database);
  assert(!prior.includes(fresh));
  database = fresh;
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      !restored.worker_enabled,
  );
  assert.equal(restored.revision, health.revision);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(resolve(restored.directory, 'manifest.json'), 'utf8')),
  );
  assert.deepEqual(await snapshot([state.tenant], state.own_names, database), state.own_snapshot);
  await preservedBusiness(database);
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  let migrations = 0;
  let priorCopySessions: any[] = [];
  try {
    await c.query("SET TIME ZONE 'UTC'");
    assert.deepEqual(await tableFingerprints(c), manifest.tables);
    assert.equal(
      await schemaFingerprint(c, manifest.schema_fingerprint_version ?? 1),
      manifest.schema_sha256,
    );
    const ms = (await c.query('SELECT name FROM migrations ORDER BY name')).rows;
    migrations = ms.length;
    assert.equal(ms.at(-1)?.name, schema);
    priorCopySessions = (
      await c.query('SELECT to_jsonb(s) row FROM sessions s WHERE tenant_id=$1 ORDER BY 1', [
        state.tenant,
      ])
    ).rows;
    for (const t of evidence) {
      const r = (
        await c.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [t],
        )
      ).rows[0];
      assert(r.relrowsecurity && r.relforcerowsecurity);
      assert(
        (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [state.tenant]))
          .rows[0].n > 0,
      );
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE dyna_app');
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [state.ids[0]]);
        assert.equal(
          (await c.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=$1`, [state.tenant]))
            .rows[0].n,
          0,
        );
      } finally {
        await c.query('ROLLBACK');
      }
      for (const sql of [
        `UPDATE ${t} SET tenant_id=tenant_id WHERE tenant_id=$1`,
        `DELETE FROM ${t} WHERE tenant_id=$1`,
      ]) {
        await c.query('BEGIN');
        try {
          await assert.rejects(c.query(sql, [state.tenant]), /immutable/i);
        } finally {
          await c.query('ROLLBACK');
        }
      }
    }
  } finally {
    await c.end();
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
        assert(h.restore_preview && h.price_bulk_edit_available);
        assert.equal(h.schema_revision, schema);
        ready = true;
        break;
      }
    } catch {}
    assert(child.exitCode === null && child.signalCode === null);
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
  const req = (path: string, method = 'GET', body?: any, workspace = state.tenant) =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', 'X-Workspace-Id': workspace },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const reads: string[] = [];
  async function read(path: string) {
    const r = await req(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    reads.push(path);
    const d = (await r.json()) as any;
    assert(d.available && d.read_only && d.can_read && !d.can_write);
    return d;
  }
  await read('/price-bulk-edit');
  const selection = await read(
    '/price-bulk-edit/selection?price_list_id=' +
      state.pln.id +
      '&ids=' +
      state.products.map((p: any) => p.id).join(','),
  );
  assert.equal(
    selection.data.find((r: any) => r.product_id === state.products[0].id).override_price,
    12301,
  );
  const history = await read('/price-bulk-edit/executions');
  assert.equal(history.data.length, 3);
  async function receiptRows(path: string, total: number) {
    const rows: any[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await read(path + (cursor ? '?cursor=' + cursor : ''));
      for (const row of response.data) {
        assert.equal(
          row.index,
          rows.length,
          'Restore HTTP receipt pages must cover contiguous indices',
        );
        rows.push(row);
      }
      cursor = response.meta.cursor;
      if (cursor) {
        assert(!cursors.has(cursor));
        cursors.add(cursor);
      }
    } while (cursor);
    assert.equal(rows.length, total);
    assert.equal(new Set(rows.map((row) => row.product_id)).size, total);
    return rows;
  }
  for (const e of history.data) {
    await read('/price-bulk-edit/previews/' + e.preview_id);
    const approved = await receiptRows(
      '/price-bulk-edit/previews/' + e.preview_id + '/rows',
      e.total,
    );
    assert.equal(
      (await read('/price-bulk-edit/executions/' + e.id)).execution.scope_hash,
      e.scope_hash,
    );
    const executed = await receiptRows('/price-bulk-edit/executions/' + e.id + '/rows', e.total);
    assert.deepEqual(
      executed.map((row) => row.product_id),
      approved.map((row) => row.product_id),
    );
    for (let index = 0; index < executed.length; index++) {
      assert.deepEqual(executed[index].input, approved[index].input);
      assert.deepEqual(executed[index].after, approved[index].after);
    }
    if (e.id === state.bulk_execution.id) {
      assert.deepEqual(executed.map((row) => row.product_id).sort(), [...state.bulk_ids].sort());
      assert(executed.every((row) => row.after.override_price === 11001));
    }
  }
  const writes = [
    '/price-bulk-edit/previews',
    '/price-bulk-edit/previews/' + history.data[0].preview_id + '/execute',
  ];
  for (const path of writes) {
    const r = await req(path, 'POST', { invalid: true });
    assert.equal(r.status, 423, path);
  }
  assert.equal((await req('/price-bulk-edit', 'GET', undefined, state.ids[0])).status, 409);
  assert.equal(
    (await fetch('http://127.0.0.1:4100/api/price-bulk-edit', { headers: { cookie } })).status,
    401,
  );
  const withoutSessions = state.own_names.filter((n: string) => n !== 'sessions');
  assert.deepEqual(
    await snapshot([state.tenant], withoutSessions, database),
    Object.fromEntries(withoutSessions.map((n: string) => [n, state.own_snapshot[n]])),
  );
  const sessionCheck = new pg.Client({ ...localDatabase(), database });
  await sessionCheck.connect();
  try {
    await sessionCheck.query("SET TIME ZONE 'UTC'");
    const rows = (
      await sessionCheck.query(
        'SELECT to_jsonb(s) row FROM sessions s WHERE tenant_id=$1 ORDER BY 1',
        [state.tenant],
      )
    ).rows;
    assert.equal(
      rows.length,
      priorCopySessions.length + 1,
      'Exactly one authentication session created in copy',
    );
    const priorTokens = new Set(priorCopySessions.map((r) => r.row.token_hash));
    assert.deepEqual(
      rows.filter((r) => priorTokens.has(r.row.token_hash)),
      priorCopySessions,
    );
    assert.equal(rows.find((r) => !priorTokens.has(r.row.token_hash)).row.user_id, state.user);
  } finally {
    await sessionCheck.end();
  }
  await preservedBusiness();
  assert.deepEqual(await snapshot([state.tenant], state.own_names), state.own_snapshot);
  report = {
    stage: 108,
    status: 'PASS',
    revision: health.revision,
    schema,
    backup_id: backup.id,
    tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    schema_and_all_rows_exact: true,
    own_tables_exact: state.own_names.length,
    copy_authentication_session_added: 1,
    copied_prior_sessions_exact: true,
    preserved_firms: state.ids.length,
    preserved_users: state.user_ids.length,
    preserved_business_tables: state.protected_names.length,
    business_preservation_scope: state.protected_names,
    read_paths: reads.length,
    full_http_receipt_pages_verified: true,
    bulk_receipt_rows: state.bulk_ids.length,
    writes423: writes.length,
    workspace_mismatch: 409,
    copy_cookie_on_live: 401,
    force_rls_immutable: true,
    worker_enabled: false,
    provider_verified: false,
    goal_complete: false,
    prior_databases: prior.length,
  };
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise<void>((r) => child!.once('exit', () => r()));
    child.kill('SIGTERM');
    if (!(await Promise.race([ended.then(() => true), setTimeout(10000).then(() => false)]))) {
      child.kill('SIGKILL');
      await ended;
    }
  }
  if (database) {
    const c = new pg.Client({ ...localDatabase(), database: 'postgres' });
    await c.connect();
    try {
      await c.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [database],
      );
      await c.query('DROP DATABASE ' + restoreDatabaseName(database));
    } finally {
      await c.end();
    }
  }
  await pool.end();
  if (prior.length) assert.deepEqual(await names(), prior, 'All previous databases preserved');
}
assert(report);
report.own_preview_removed = true;
await writeFile('docs/price-bulk-edit-recovery-qa.json', JSON.stringify(report, null, 2));
console.log(report);
