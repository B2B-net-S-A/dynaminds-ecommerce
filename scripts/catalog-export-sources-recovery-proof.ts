/** QA116: actual encrypted restore of accepted data; invoked only by the operator. */
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
assert(revision && /^[a-f0-9]{7,40}$/.test(revision), 'Expected revision required');
const schema = '097_catalog_export_sources';
const source = localDatabase(),
  port = 4156;
const admin = new pg.Client({ ...source, database: 'postgres' });
const statePath = 'data/catalog-export-sources-stage116.json';
const reportPath = 'docs/catalog-export-sources-recovery-qa.json';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
let state: Json | undefined, copied: pg.Client | undefined;
let child: ReturnType<typeof spawn> | undefined, owned: string | undefined;
let prior: string[] = [],
  phase = 'prerequisites',
  report: Json | undefined;
let failed = false,
  cleanupError = false,
  checkpointVerified = false;

async function ownCheckpoint(c: pg.Client | pg.PoolClient, s: Json) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Json = {};
    assert.equal(s.own_names.length, 20);
    assert.equal(new Set(s.own_names).size, 20);
    for (const name of s.own_names as string[]) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const value = name === 'users' ? s.user : s.tenant;
      const column = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${column}=$1 ORDER BY 1`, [
          value,
        ])
      ).rows;
      result[name] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
    }
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}
async function sourceCheckpoint(s: Json) {
  const c = await pool.connect();
  try {
    return await ownCheckpoint(c, s);
  } finally {
    c.release();
  }
}
async function globalSnapshot(c: pg.Client) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const tables = await tableFingerprints(c),
      schemaHash = await schemaFingerprint(c);
    const sessions = (await c.query('SELECT id,tenant_id,user_id FROM sessions ORDER BY id')).rows;
    await c.query('COMMIT');
    return { tables, schemaHash, sessions };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  }
}
function expectedMatrix(s: Json, product: Json) {
  const bundle = product.id === s.products.bundle.id;
  return {
    inventory_json: [s.warehouses.second, s.warehouses.main].map((w, i) => {
      const physical =
        product.id === s.products.a.id
          ? { on_hand: 12, reserved: 3, available: 9 }
          : { on_hand: 10, reserved: 0, available: 10 };
      return {
        warehouse_id: w.id,
        warehouse_name: w.name,
        warehouse_code: w.code,
        status: bundle || i === 1 ? 'available' : 'missing',
        source: bundle ? 'components' : 'stock',
        on_hand: bundle || i === 0 ? null : physical.on_hand,
        reserved: bundle || i === 0 ? null : physical.reserved,
        available: bundle ? (i === 0 ? 0 : 4) : i === 0 ? null : physical.available,
      };
    }),
    prices_json: [s.lists.eur, s.lists.pln].map((l, i) => {
      const override = i === 0 && product.id === s.products.a.id;
      const gross = Number((BigInt(product.price) * 10500n + 5000n) / 10000n) + 19;
      return {
        price_list_id: l.id,
        price_list_name: l.name,
        currency: l.currency,
        version: l.version,
        own_price_minor: override ? 0 : null,
        effective_price_minor: i === 0 ? (override ? 0 : null) : gross,
        source: i === 0 ? (override ? 'override' : null) : 'rule',
        status: i === 0 && !override ? 'missing' : 'available',
      };
    }),
  };
}
async function request(base: string, path: string, options: RequestInit = {}) {
  return fetch(base + path, { ...options, signal: AbortSignal.timeout(30000) });
}
async function jsonRead(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()) as Json;
}

try {
  await admin.connect();
  prior = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
    (r) => r.datname,
  );
  assert.equal(prior.length, 17, 'Expected original database inventory');
  const stat = await lstat(statePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
  state = JSON.parse(await readFile(statePath, 'utf8')) as Json;
  const s = state;
  assert.equal(s.stage, 116);
  assert(s.setup_complete && !s.pending && s.own_snapshot && s.accepted_checkpoint);
  assert.equal(s.runtime_revision, revision);
  assert.equal(s.schema_revision, schema);
  assert.equal(s.own_snapshot_timezone, 'UTC');
  assert.deepEqual(s.own_snapshot, s.accepted_checkpoint);
  assert.equal(s.profiles.length, 2);
  assert.deepEqual(s.profiles.map((p: Json) => p.profile.definition.format).sort(), ['csv', 'xml']);
  const native: Json = JSON.parse(
    await readFile('docs/catalog-export-sources-native-readback-qa.json', 'utf8'),
  );
  assert.equal(native.status, 'PASS');
  assert.equal(native.runtime_revision, revision);
  assert.equal(native.schema_revision, schema);
  assert.equal(native.own_tenant, s.tenant);
  assert.deepEqual(native.own_checkpoint, s.accepted_checkpoint);
  assert.equal(native.files.length, 2);
  assert.equal(native.profiles_count, 3);
  assert.equal(s.accepted_checkpoint.catalog_export_profiles.count, 3);
  assert.equal(native.accepted_checkpoint_exact, true);
  assert.deepEqual(
    await sourceCheckpoint(s),
    s.accepted_checkpoint,
    'Accepted source data changed',
  );
  checkpointVerified = true;
  const main = 'http://127.0.0.1:4100/api';
  const health = (await (await request(main, '/health')).json()) as Json;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, schema);
  const probe = createServer();
  await new Promise<void>((done, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => done());
  });
  await new Promise<void>((done) => probe.close(() => done()));
  process.env.APP_REVISION = revision;
  phase = 'encrypted_backup';
  const backup = await createBackup();
  phase = 'isolated_restore';
  const restored = await restoreBackup(backup.file, {
    directory: 'data/catalog-export-sources-116-restore',
  });
  const name = restoreDatabaseName(restored.database);
  assert(!prior.includes(name));
  owned = name;
  assert.equal(restored.status, 'verified');
  assert.equal(restored.revision, revision);
  assert.equal(restored.tables, 267);
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      restored.preview_only &&
      restored.worker_enabled === false,
  );
  const config: Json = JSON.parse(await readFile(restored.config, 'utf8'));
  copied = new pg.Client({ ...source, database: name, password: config.dbPassword });
  await copied.connect();
  assert.deepEqual(
    await ownCheckpoint(copied, s),
    s.accepted_checkpoint,
    'Accepted copied data changed',
  );
  const before = await globalSnapshot(copied);
  assert.equal(Object.keys(before.tables).length, 267);
  const foreign = (
    await copied.query('SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1', [s.tenant])
  ).rows[0];
  assert(foreign);
  const rlsTables = [
    'catalog_export_profiles',
    'warehouses',
    'stock',
    'bundle_components',
    'price_lists',
    'price_list_items',
  ];
  const flags = (
    await copied.query(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[]) AND relnamespace='public'::regnamespace",
      [rlsTables],
    )
  ).rows;
  assert.equal(flags.length, rlsTables.length);
  assert(flags.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  await copied.query('BEGIN');
  try {
    await copied.query('SET LOCAL ROLE dyna_app');
    await copied.query("SELECT set_config('app.tenant_id',$1,true)", [s.tenant]);
    assert.equal(
      (await copied.query('SELECT count(*)::int n FROM catalog_export_profiles')).rows[0].n,
      s.accepted_checkpoint.catalog_export_profiles.count,
    );
    assert.equal(
      (
        await copied.query('SELECT count(*)::int n FROM warehouses WHERE id=ANY($1::uuid[])', [
          Object.values(s.warehouses).map((w: any) => w.id),
        ])
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await copied.query('SELECT count(*)::int n FROM price_lists WHERE id=ANY($1::uuid[])', [
          Object.values(s.lists).map((l: any) => l.id),
        ])
      ).rows[0].n,
      2,
    );
    await copied.query("SELECT set_config('app.tenant_id',$1,true)", [foreign.id]);
    for (const table of rlsTables) {
      assert.equal(
        (
          await copied.query(`SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`, [
            s.tenant,
          ])
        ).rows[0].n,
        0,
      );
    }
  } finally {
    await copied.query('ROLLBACK');
  }
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
        assert(h.restore_preview);
        assert.equal(h.revision, revision);
        assert.equal(h.schema_revision, schema);
        ready = true;
        break;
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
    assert(
      !childError && child.exitCode === null && child.signalCode === null,
      'Owned preview exited',
    );
    await delay(150);
  }
  assert(ready, 'Owned preview did not become ready');
  assert.equal(
    (await request(base, '/catalog/export-profiles', { headers: { cookie: s.cookie } })).status,
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
  const me = await jsonRead(await request(base, '/auth/me', { headers }));
  assert.equal(me.user.id, s.user);
  assert.equal(me.user.tenant_id, s.tenant);
  assert.equal(me.user.role, 'admin');
  assert.equal((await request(main, '/auth/me', { headers: { cookie } })).status, 401);
  assert.equal(
    (
      await request(base, '/catalog/export-profiles', {
        headers: { cookie, 'X-Workspace-ID': foreign.id },
      })
    ).status,
    409,
  );
  const list = await jsonRead(await request(base, '/catalog/export-profiles', { headers }));
  assert(list.available && list.read_only && !list.can_manage);
  assert.equal(list.data.length, 3);
  const uiProfile = list.data.find((p: Json) => p.name === 'QA116 XML własny źródła');
  assert(uiProfile && !uiProfile.archived && uiProfile.version === 1);
  assert.deepEqual(
    uiProfile.definition,
    s.profiles.find((p: Json) => p.profile.definition.format === 'xml').profile.definition,
  );
  const uiDetail = await jsonRead(
    await request(base, '/catalog/export-profiles/' + uiProfile.id, { headers }),
  );
  assert(uiDetail.read_only && !uiDetail.can_manage);
  assert.deepEqual(uiDetail.profile, uiProfile);
  const options = await jsonRead(await request(base, '/catalog/exports/options', { headers }));
  assert(
    options.read_only &&
      options.sources.allow_inventory &&
      options.sources.warehouses.available &&
      options.sources.price_lists.available,
  );
  assert.equal(options.catalog_currency, 'PLN');
  const products = Object.values(s.products) as Json[],
    ids = products.map((p) => p.id);
  const samples: Json[] = [],
    files: Json[] = [];
  for (const saved of s.profiles as Json[]) {
    const p = list.data.find((row: Json) => row.id === saved.profile.id);
    assert(p);
    assert.deepEqual(p, saved.profile);
    const detail = await jsonRead(
      await request(base, '/catalog/export-profiles/' + p.id, { headers }),
    );
    assert(detail.read_only && !detail.can_manage);
    assert.deepEqual(detail.profile, p);
    const input = { ...p.definition, selection: 'selected', ids };
    assert.deepEqual(input.warehouse_ids, [s.warehouses.second.id, s.warehouses.main.id]);
    assert.deepEqual(input.price_list_ids, [s.lists.eur.id, s.lists.pln.id]);
    const preview = await jsonRead(
      await request(base, '/catalog/exports/preview', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
    assert.deepEqual(preview.count, { matched_products: 3, capped: false });
    assert.equal(preview.catalog_currency, 'PLN');
    assert.equal(preview.sample_limit, 3);
    assert.equal(preview.read_only, true);
    assert.deepEqual(
      preview.sample.map((row: Json) => row.product_id),
      [...ids].sort(),
    );
    for (const row of preview.sample) {
      const product = products.find((p) => p.id === row.product_id);
      assert(product);
      assert.equal(row.sku, product.sku);
      assert.equal(row.name, product.name);
      assert.deepEqual(
        { inventory_json: row.inventory_json, prices_json: row.prices_json },
        expectedMatrix(s, product),
      );
    }
    samples.push({ format: p.definition.format, count: 3, exact_matrix_and_source_order: true });
    const response = await request(base, '/catalog/exports/file', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-catalog-currency'), 'PLN');
    assert.equal(response.headers.get('x-catalog-export-count'), '3');
    assert(
      response.headers
        .get('content-type')
        ?.startsWith(p.definition.format === 'csv' ? 'text/csv' : 'application/xml'),
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    const reference = native.files.find((file: Json) => file.profile_id === p.id);
    assert(reference);
    assert.equal(reference.format, p.definition.format);
    assert.equal(reference.version, p.version);
    assert.equal(reference.rows, 3);
    assert.equal(
      reference.artifact,
      `docs/catalog-export-sources-native-custom.${p.definition.format}`,
    );
    assert.deepEqual(bytes, await readFile(reference.artifact));
    assert.equal(bytes.length, reference.bytes);
    assert.equal(sha(bytes), reference.sha256);
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    files.push({
      format: p.definition.format,
      profile_id: p.id,
      bytes: bytes.length,
      sha256: sha(bytes),
      rows: 3,
    });
  }
  const deniedPaths = [
    ['POST', '/catalog/export-profiles'],
    ['PATCH', '/catalog/export-profiles/' + s.profiles[0].profile.id],
    ['POST', '/stock-location-counts'],
    ['PUT', '/price-lists/' + s.lists.pln.id + '/items'],
  ];
  for (const [method, path] of deniedPaths) {
    const response = await request(base, path, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(response.status, 423);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(
    await ownCheckpoint(copied, s),
    s.accepted_checkpoint,
    'Readonly own checkpoint changed',
  );
  const after = await globalSnapshot(copied);
  assert.equal(after.schemaHash, before.schemaHash);
  assert.deepEqual(Object.keys(after.tables), Object.keys(before.tables));
  for (const [name, fingerprint] of Object.entries(before.tables))
    if (name !== 'sessions')
      assert.deepEqual(after.tables[name], fingerprint, 'Readonly table changed: ' + name);
  const oldIds = new Set(before.sessions.map((row) => row.id));
  const added = after.sessions.filter((row) => !oldIds.has(row.id));
  assert.equal(added.length, 1);
  assert.equal(added[0].tenant_id, s.tenant);
  assert.equal(added[0].user_id, s.user);
  assert.equal(after.sessions.length, before.sessions.length + 1);
  await copied.query("SET TIME ZONE 'UTC'");
  const oldSessions = (
    await copied.query(
      "SELECT count(*)::text count,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),1,16))::bit(64)::bigint),0)::text high,coalesce(sum(('x'||substr(md5(to_jsonb(t)::text),17,16))::bit(64)::bigint),0)::text low FROM sessions t WHERE id<>$1",
      [added[0].id],
    )
  ).rows[0];
  assert.deepEqual(oldSessions, before.tables.sessions, 'All original sessions must remain exact');
  report = {
    status: 'PASS',
    stage: 116,
    runtime_revision: revision,
    schema_revision: schema,
    tables: restored.tables,
    row_manifest_exact_before_preview: true,
    schema_fingerprint_exact: true,
    encrypted_records_verified: restored.encrypted_records_verified,
    own_checkpoint_tables: 20,
    own_checkpoint_exact_source_and_copy: true,
    profiles_exact: list.data.length,
    force_rls_tables: rlsTables,
    foreign_scope_denied: true,
    previews: samples,
    export_files: files,
    writes_denied_before_parse: deniedPaths.length,
    non_session_tables_exact_after_preview: true,
    original_sessions_exact: true,
    new_own_preview_sessions: 1,
    source_cookie_denied: true,
    preview_cookie_denied_on_source: true,
    foreign_workspace_denied: true,
    preview_only: true,
    worker_enabled: false,
    provider_operations: false,
    full_goal_complete: false,
  };
} catch {
  // HTTP bodies, connection errors and private state may contain credentials.
  failed = true;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let n = 0; n < 30 && child.exitCode === null && child.signalCode === null; n++)
      await delay(100);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((done) => child!.once('exit', () => done()));
    }
  }
  // Attempt every owned cleanup/check even if closing one handle fails.
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
        'All earlier databases must survive',
      );
  } catch {
    cleanupError = true;
  }
  try {
    if (checkpointVerified && state)
      assert.deepEqual(
        await sourceCheckpoint(state),
        state.accepted_checkpoint,
        'Source checkpoint changed during recovery',
      );
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
        stage: 116,
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
    JSON.stringify({ status: 'FAIL', stage: 116, phase, cleanup_verified: !cleanupError }) + '\n',
  );
  process.exitCode = 1;
} else {
  report.original_databases_preserved = prior.length;
  report.owned_preview_and_database_removed = true;
  report.source_checkpoint_exact_after_cleanup = true;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({
      status: 'PASS',
      stage: 116,
      tables: report.tables,
      files: 2,
      denied: 4,
      original_databases_preserved: prior.length,
    }) + '\n',
  );
}
