/** Actual local backup/restore of QA109. Cleanup removes only this run's fresh copy. */
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
const state = JSON.parse(
  await readFile('data/product-translation-bulk-edit-stage109.json', 'utf8'),
);
const schema = '088_product_translation_bulk_edit',
  port = 4149;
const evidence = [
  'product_translation_bulk_edit_previews',
  'product_translation_bulk_edit_rows',
  'product_translation_bulk_edit_executions',
  'product_translation_bulk_edit_execution_rows',
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
      const overridden = t === 'listings' && (state.listing_overrides?.length ?? 0) > 0;
      const projection =
        t === 'product_translations'
          ? "to_jsonb(t)-'manual_receipt_id'"
          : overridden
            ? "CASE WHEN o.id IS NULL THEN to_jsonb(t) ELSE jsonb_set(jsonb_set(to_jsonb(t),'{last_result,odoo_catalog_sync,run_id}',to_jsonb(o.run_id)),'{last_result,odoo_catalog_sync,observed_at}',to_jsonb(o.observed_at)) END"
            : 'to_jsonb(t)';
      const scope =
        t === 'shopify_translation_claims'
          ? 'EXISTS(SELECT 1 FROM shopify_translation_plans p WHERE p.id=t.plan_id AND p.tenant_id=ANY($1::uuid[]))'
          : `${t === 'tenants' ? 't.id' : 't.tenant_id'}=ANY($1::uuid[])`;
      out[t] = hash(
        (
          await c.query(
            `SELECT ${projection} row FROM "${t}" t ${overridden ? 'LEFT JOIN jsonb_to_recordset($2::jsonb)o(id uuid,run_id text,observed_at text) ON o.id=t.id' : ''} WHERE ${scope} ORDER BY 1`,
            overridden ? [ids, JSON.stringify(state.listing_overrides)] : [ids],
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
  assert(health.product_translation_bulk_edit_available);
  assert.equal(health.revision, state.runtime_revision);
  assert(
    state.fixture_seeded && state.ui_execution && state.ui_rows?.length === 9 && state.checkpoint,
  );
  assert.equal(state.checkpoint_names.length, 25);
  await preservedBusiness();
  assert.deepEqual(await snapshot([state.tenant], state.checkpoint_names), state.checkpoint);
  prior = await names();
  // An earlier compatibility run may already have removed its own old087 copy.
  // Every database that exists at the start remains protected by the final names check.
  const oldCopyExisted = Boolean(state.old_schema_copy && prior.includes(state.old_schema_copy));
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
    directory: 'data/product-translation-bulk-edit-109-restore',
  });
  const fresh = restoreDatabaseName(restored.database);
  assert(!prior.includes(fresh));
  assert.notEqual(fresh, state.old_schema_copy);
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
  assert.deepEqual(
    await snapshot([state.tenant], state.checkpoint_names, database),
    state.checkpoint,
  );
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
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running')",
          [state.tenant],
        )
      ).rows[0].n,
      0,
      'Own QA jobs must be terminal',
    );
    const translations = (
      await c.query(
        `SELECT t.*,r.after receipt_after,r.source receipt_source,r.operation receipt_operation,r.status receipt_status,e.state execution_state FROM product_translations t JOIN product_translation_bulk_edit_execution_rows r ON (r.tenant_id,r.id,r.product_id,r.locale)=(t.tenant_id,t.manual_receipt_id,t.product_id,t.locale) JOIN product_translation_bulk_edit_executions e ON (e.tenant_id,e.id)=(r.tenant_id,r.execution_id) WHERE t.tenant_id=$1 ORDER BY t.product_id,t.locale`,
        [state.tenant],
      )
    ).rows;
    assert.equal(translations.length, 4);
    for (const t of translations) {
      assert(t.manual_receipt_id && !t.ai_draft_id && !t.deepl_draft_id);
      assert.equal(t.execution_state, 'done');
      assert.equal(t.receipt_operation, 'set');
      assert.equal(t.receipt_status, 'changed');
      assert.equal(t.receipt_after.present, true);
      assert.equal(t.receipt_after.name, t.name);
      assert.equal(t.receipt_after.description, t.description);
      assert.equal(t.receipt_after.version, t.version);
      assert.deepEqual(t.receipt_after.provenance, { kind: 'manual', id: t.manual_receipt_id });
      assert(
        state.ui_rows.some(
          (r: any) =>
            r.id === t.manual_receipt_id && r.product_id === t.product_id && r.locale === t.locale,
        ),
      );
    }
    const currentCount = (
      await c.query('SELECT count(*)::int n FROM product_translations WHERE tenant_id=$1', [
        state.tenant,
      ])
    ).rows[0].n;
    assert.equal(
      currentCount,
      translations.length,
      'Every current translation has a genuine manual receipt',
    );
    await c.query('BEGIN');
    try {
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [state.ids[0]]);
      assert.equal(
        (
          await c.query('SELECT count(*)::int n FROM product_translations WHERE tenant_id=$1', [
            state.tenant,
          ])
        ).rows[0].n,
        0,
      );
    } finally {
      await c.query('ROLLBACK');
    }
    await c.query('BEGIN');
    try {
      await assert.rejects(
        c.query(
          "UPDATE product_translations SET name=name||' tampered' WHERE tenant_id=$1 AND product_id=$2 AND locale=$3",
          [state.tenant, translations[0].product_id, translations[0].locale],
        ),
        /Manual translation differs/,
      );
    } finally {
      await c.query('ROLLBACK');
    }
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
        assert(h.restore_preview && h.product_translation_bulk_edit_available);
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
  await read('/product-translation-bulk-edit');
  const selection = await read(
    '/product-translation-bulk-edit/selection?ids=' +
      state.products.map((p: any) => p.id).join(',') +
      '&locales=' +
      state.locales.join(','),
  );
  assert.equal(selection.meta.total, 9);
  assert.equal(selection.data.length, 9);
  assert.equal(selection.meta.cursor, null);
  assert.equal(selection.data.filter((r: any) => r.present).length, 4);
  assert(
    selection.data.filter((r: any) => r.present).every((r: any) => r.provenance?.kind === 'manual'),
  );
  const history = await read('/product-translation-bulk-edit/executions');
  assert.equal(history.data.length, 2);
  assert.equal(history.meta.cursor, null);
  assert(history.data.some((e: any) => e.id === state.ui_execution));
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
    assert.equal(new Set(rows.map((row) => row.product_id + ':' + row.locale)).size, total);
    return rows;
  }
  for (const e of history.data) {
    await read('/product-translation-bulk-edit/previews/' + e.preview_id);
    const approved = await receiptRows(
      '/product-translation-bulk-edit/previews/' + e.preview_id + '/rows',
      e.total,
    );
    assert.equal(
      (await read('/product-translation-bulk-edit/executions/' + e.id)).execution.scope_hash,
      e.scope_hash,
    );
    const executed = await receiptRows(
      '/product-translation-bulk-edit/executions/' + e.id + '/rows',
      e.total,
    );
    assert.deepEqual(
      executed.map((row) => row.product_id),
      approved.map((row) => row.product_id),
    );
    for (let index = 0; index < executed.length; index++) {
      assert.deepEqual(executed[index].input, approved[index].input);
      assert.deepEqual(executed[index].after, approved[index].after);
    }
    assert.deepEqual(
      executed.map((row) => row.id),
      approved.map((row) => row.receipt_id),
    );
    if (e.id === state.ui_execution) {
      assert.equal(e.total, 9);
      assert.equal(e.changed_pairs, 5);
      assert.equal(e.changed_products, 3);
      assert.equal(e.missing_after_count, 5);
      assert.deepEqual(executed, state.ui_rows);
      const removed = executed.find((r) => r.input.operation === 'remove');
      assert(removed);
      assert.equal(removed.after.present, false);
      assert.equal(removed.before.name, 'Version to remove QA109');
      assert(
        executed.some(
          (r) => r.before.provenance?.kind === 'deepl' && r.after.provenance?.kind === 'manual',
        ),
      );
    }
  }
  const writes = [
    '/product-translation-bulk-edit/previews',
    '/product-translation-bulk-edit/previews/' + history.data[0].preview_id + '/execute',
    '/products/' + state.products[0].id,
  ];
  for (const path of writes) {
    const r = await req(path, path.startsWith('/products/') ? 'PATCH' : 'POST', { invalid: true });
    assert.equal(r.status, 423, path);
  }
  assert.equal(
    (await req('/product-translation-bulk-edit', 'GET', undefined, state.ids[0])).status,
    409,
  );
  assert.equal(
    (
      await fetch('http://127.0.0.1:4100/api/product-translation-bulk-edit', {
        headers: { cookie },
      })
    ).status,
    401,
  );
  const withoutSessions = state.checkpoint_names.filter((n: string) => n !== 'sessions');
  assert.deepEqual(
    await snapshot([state.tenant], withoutSessions, database),
    Object.fromEntries(withoutSessions.map((n: string) => [n, state.checkpoint[n]])),
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
  assert.deepEqual(await snapshot([state.tenant], state.checkpoint_names), state.checkpoint);
  report = {
    stage: 109,
    status: 'PASS',
    revision: health.revision,
    schema,
    ui_execution: state.ui_execution,
    backup_id: backup.id,
    tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    schema_and_all_rows_exact: true,
    own_tables_exact: state.checkpoint_names.length,
    copy_authentication_session_added: 1,
    copied_prior_sessions_exact: true,
    preserved_firms: state.ids.length,
    preserved_users: state.user_ids.length,
    preserved_business_tables: state.protected_names.length,
    business_preservation_scope: state.protected_names,
    read_paths: reads.length,
    full_http_receipt_pages_verified: true,
    ui_receipt_rows: state.ui_rows.length,
    current_manual_translations: 4,
    genuine_manual_fk_provenance: true,
    removed_translation_history_exact: true,
    historical_listing_comparison:
      'Only previously traced Odoo run_id/observed_at fields normalized; original baseline retained',
    traced_listing_observation_fields: (state.listing_overrides?.length ?? 0) * 2,
    exact_preserved_business_tables:
      state.protected_names.length - ((state.listing_overrides?.length ?? 0) > 0 ? 1 : 0),
    root_owned_old087_copy_existed_at_start: oldCopyExisted,
    root_owned_old087_copy_preserved: oldCopyExisted,
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
await writeFile('docs/product-translation-bulk-recovery-qa.json', JSON.stringify(report, null, 2));
console.log(report);
