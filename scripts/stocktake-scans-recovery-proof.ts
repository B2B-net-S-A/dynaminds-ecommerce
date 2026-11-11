/**
 * QA113 actual full backup/restore. Coordinator-only; this file creates no QA fixtures.
 * Run after both actual operator UI flows and a complete accepted restart:
 * QA_EXPECTED_REVISION=<accepted SHA> npx tsx scripts/stocktake-scans-recovery-proof.ts
 * Private input: data/stocktake-scans-stage113.json (0600). No credentials in output.
 * Stages: prerequisites → backup → isolated restore → SQL proof → readonly loopback
 * → exact source/copy readback → owned cleanup → public PASS (only after cleanup).
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { pool } from '../server/db';
import { verifyStocktakeScansPreservation } from './stocktake-scans-preservation';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
  manifestSchema,
  tableFingerprints,
  schemaFingerprint,
} from '../server/recovery';

type Json = Record<string, any>;
type Digest = { count: number; sha256: string };
type FixtureReference = { tenant: string; engine: 'wms' | 'quantity'; stocktake_id: string };
const statePath = 'data/stocktake-scans-stage113.json';
const baselinePath = 'data/stocktake-scans-stage113-baseline.json';
const reportPath = 'docs/stocktake-scans-recovery-qa.json';
const schema = '095_stocktake_scan_recovery',
  port = 4153;
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const digest = (rows: unknown[]): Digest => ({
  count: rows.length,
  sha256: sha(JSON.stringify(rows)),
});
const prefix = (c: Json) => (c.engine === 'wms' ? '/wms-lots/stocktakes' : '/stocktakes');
const withoutSessions = (v: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(v).filter(([name]) => name !== 'sessions'));
let stage = 'prerequisites';
let child: ReturnType<typeof spawn> | undefined;
let ownedDatabase: string | undefined;
let priorDatabases: string[] | undefined;
let baselineHash: string | undefined;
let report: Json | undefined;

async function databaseNames() {
  const c = new pg.Client({ ...localDatabase(), database: 'postgres' });
  await c.connect();
  try {
    return (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map((r) =>
      String(r.datname),
    );
  } finally {
    await c.end();
  }
}
async function checkpoint(
  s: Json,
  fixture: Json,
  database = localDatabase().database,
  skipSessions = false,
) {
  const c = new pg.Client({ ...localDatabase(), database });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Record<string, Digest> = {};
    for (const name of s.own_names as string[]) {
      assert(/^[a-z][a-z0-9_]*$/.test(name), 'Invalid checkpoint table');
      if (skipSessions && name === 'sessions') continue;
      const predicate =
        name === 'users' ? 'id=ANY($1::uuid[])' : name === 'tenants' ? 'id=$1' : 'tenant_id=$1';
      out[name] = digest(
        (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${predicate} ORDER BY 1`, [
            name === 'users' ? [fixture.user, fixture.operator.user] : fixture.tenant,
          ])
        ).rows,
      );
    }
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}
async function freePort() {
  const listener = createServer();
  try {
    await new Promise<void>((done, reject) => {
      listener.once('error', reject);
      listener.listen(port, '127.0.0.1', () => done());
    });
  } finally {
    if (listener.listening) await new Promise<void>((done) => listener.close(() => done()));
  }
}
async function expectSqlFailure(c: pg.Client, sql: string, args: unknown[], code: string) {
  await c.query('BEGIN');
  try {
    let actual: string | undefined;
    try {
      await c.query(sql, args);
    } catch (error) {
      actual = (error as { code?: string }).code;
    }
    assert.equal(actual, code, 'Expected copied-DB enforcement error');
  } finally {
    await c.query('ROLLBACK');
  }
}

async function run() {
  const stat = await lstat(statePath);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600,
    'Private accepted state required',
  );
  const stateBytes = await readFile(statePath),
    s: Json = JSON.parse(stateBytes.toString('utf8'));
  const acceptedStateHash = sha(stateBytes);
  assert.equal(s.stage, 113);
  assert(s.setup_complete && !s.pending, 'Partial setup/write requires manual readback first');
  assert.equal(s.ui_verified, true, 'Both actual operator browser flows must be attested first');
  assert.equal(s.restart_verified, true, 'Complete accepted restart must precede restore');
  assert.equal(s.api_acceptance?.status, 'PASS');
  assert.equal(s.schema, schema);
  assert.equal(s.own_snapshot_timezone, 'UTC');
  assert(Array.isArray(s.cases) && s.cases.length === 2);
  assert.deepEqual(s.cases.map((c: Json) => c.engine).sort(), ['quantity', 'wms']);
  assert.equal(new Set(s.cases.map((c: Json) => c.tenant)).size, 2);
  const revision = process.env.QA_EXPECTED_REVISION ?? s.runtime_revision;
  assert.match(revision, /^[a-f0-9]{7,40}$/);
  assert.equal(s.runtime_revision, revision, 'Do not silently rebase the accepted source');
  assert.equal(s.restart_revision, revision);
  assert(Array.isArray(s.own_names) && new Set(s.own_names).size === s.own_names.length);
  const dynamicNames = (
    await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
     AND (table_name IN ('tenants','users') OR EXISTS(SELECT 1 FROM information_schema.columns x
      WHERE x.table_schema='public' AND x.table_name=tables.table_name AND x.column_name='tenant_id')) ORDER BY table_name`,
    )
  ).rows.map((r) => String(r.table_name));
  assert.deepEqual(
    [...s.own_names].sort(),
    dynamicNames,
    'Checkpoint must cover every own tenant table and both users',
  );
  for (const c of s.cases) {
    assert(c.ready && c.verified && c.operator?.user && c.user !== c.operator.user);
    assert(typeof c.operator.email === 'string' && typeof c.operator.password === 'string');
    assert(Number.isInteger(c.verified_count) && c.verified_count >= 2);
    assert(Number.isInteger(c.scan_count) && c.scan_count >= c.verified_count + 1);
    assert.deepEqual(Object.keys(c.own_snapshot).sort(), dynamicNames);
    for (const d of Object.values(c.own_snapshot) as Digest[]) {
      assert(Number.isInteger(d.count) && d.count >= 0);
      assert.match(d.sha256, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(await checkpoint(s, c), c.own_snapshot, 'Accepted source checkpoint drift');
  }
  const sourceHealthResponse = await fetch('http://127.0.0.1:4100/api/health', {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(sourceHealthResponse.status, 200);
  const sourceHealth: Json = await sourceHealthResponse.json();
  assert.equal(sourceHealth.revision, revision);
  assert.equal(sourceHealth.schema_revision, schema);
  assert(sourceHealth.stocktake_scans_available && !sourceHealth.restore_preview);
  const baselineBytes = await readFile(baselinePath),
    baseline: Json = JSON.parse(baselineBytes.toString('utf8'));
  baselineHash = sha(baselineBytes);
  assert.equal(baseline.stage, 113);
  assert.equal(baseline.baseline_rebased, false);
  assert.equal(baseline.firms.length, 109, 'All original113 firms must remain protected');
  assert.equal(baseline.users.length, 93);
  assert.equal(baseline.own_checkpoints.length, 3, 'All accepted112 checkpoints required');
  assert.equal(baseline.databases.length, 17, 'Original unrelated database baseline required');
  priorDatabases = await databaseNames();
  assert.deepEqual(
    priorDatabases,
    baseline.databases,
    'Never start with an unexplained copied database',
  );
  await freePort();
  const preservationBefore = await verifyStocktakeScansPreservation();
  assert(
    ['PASS_EXACT_ORIGINAL_ROWS', 'PASS_WITH_SOURCE_BOUND_LOCAL_JOBS'].includes(
      preservationBefore.status,
    ),
  );
  assert.equal(preservationBefore.stage, 113);
  assert.equal(preservationBefore.prior_firms, 109);
  assert.equal(preservationBefore.accepted_stage112_checkpoints_exact, 3);
  assert.equal(
    preservationBefore.earlier_105_preservation,
    'PASS_CORE_AND_SOURCE_TRACED_BACKGROUND',
  );
  assert.equal(preservationBefore.original_baseline_sha256, baselineHash);

  stage = 'backup';
  process.env.APP_REVISION = revision;
  const backup = await createBackup({ directory: 'data/backups' });
  stage = 'restore';
  const restored = await restoreBackup(backup.file, {
    directory: 'data/stocktake-scans-113-restore',
  });
  const fresh = restoreDatabaseName(restored.database);
  assert(!priorDatabases.includes(fresh), 'Do not adopt an earlier database');
  ownedDatabase = fresh; // Only this freshly returned, verified database may be removed.
  assert.equal(restored.status, 'verified');
  assert.equal(restored.revision, revision);
  assert(restored.row_fingerprints_match && restored.schema_fingerprint_match);
  assert(restored.preview_only && restored.worker_enabled === false);
  assert(
    Number.isInteger(restored.encrypted_records_verified) &&
      restored.encrypted_records_verified >= 0,
  );
  const configStat = await lstat(restored.config);
  assert(
    configStat.isFile() && !configStat.isSymbolicLink() && (configStat.mode & 0o777) === 0o600,
  );
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(resolve(restored.directory, 'manifest.json'), 'utf8')),
  );
  assert.equal(manifest.revision, revision);
  assert.equal(restored.tables, Object.keys(manifest.tables).length);
  for (const c of s.cases) assert.deepEqual(await checkpoint(s, c, fresh), c.own_snapshot);

  stage = 'restored_sql';
  const db = new pg.Client({ ...localDatabase(), database: fresh });
  const proofs = new Map<string, Json[]>();
  let originalSessions: Json[] = [],
    migrations = 0,
    immutableChecks = 0,
    foreignKeyChecks = 0,
    rlsChecks = 0;
  await db.connect();
  try {
    await db.query("SET TIME ZONE 'UTC'");
    assert.deepEqual(await tableFingerprints(db), manifest.tables);
    assert.equal(
      await schemaFingerprint(db, manifest.schema_fingerprint_version ?? 1),
      manifest.schema_sha256,
    );
    const ms = (await db.query('SELECT name FROM migrations ORDER BY name')).rows;
    migrations = ms.length;
    assert.equal(ms.at(-1)?.name, schema);
    originalSessions = (await db.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY 1')).rows;
    const protection = (
      await db.query(
        `SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('dyna_app',oid,'SELECT') can_select,
       has_table_privilege('dyna_app',oid,'INSERT') can_insert,has_table_privilege('dyna_app',oid,'UPDATE') can_update,
       has_table_privilege('dyna_app',oid,'DELETE') can_delete FROM pg_class WHERE oid='stocktake_scan_receipts'::regclass`,
      )
    ).rows[0];
    assert.deepEqual(protection, {
      relrowsecurity: true,
      relforcerowsecurity: true,
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
    });
    const fk = (
      await db.query(
        "SELECT convalidated FROM pg_constraint WHERE conrelid='stocktake_scan_receipts'::regclass AND contype='f'",
      )
    ).rows;
    assert.equal(fk.length, 11);
    assert(fk.every((r) => r.convalidated));
    const columns = (
      await db.query(
        "SELECT attname FROM pg_attribute WHERE attrelid='stocktake_scan_receipts'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum",
      )
    ).rows
      .map((r) => '"' + r.attname + '"')
      .join(',');
    for (const fixture of s.cases) {
      const engine = fixture.engine,
        lineTable = engine === 'wms' ? 'wms_stocktake_lines' : 'stocktake_lines';
      const measurementTable =
        engine === 'wms' ? 'wms_stocktake_measurements' : 'stocktake_measurements';
      const headTable = engine === 'wms' ? 'wms_stocktakes' : 'stocktakes';
      const receipts = (
        await db.query(
          'SELECT r.*,to_jsonb(r) raw FROM stocktake_scan_receipts r WHERE tenant_id=$1 AND engine=$2 AND stocktake_id=$3 ORDER BY after_line_version',
          [fixture.tenant, engine, fixture.stocktake_id],
        )
      ).rows as Json[];
      assert.equal(receipts.length, fixture.scan_count);
      assert(receipts.length >= 3);
      proofs.set(engine, receipts);
      const head = (
        await db.query(`SELECT * FROM ${headTable} WHERE (tenant_id,id)=($1,$2)`, [
          fixture.tenant,
          fixture.stocktake_id,
        ])
      ).rows[0];
      assert(head && head.blind && head.warehouse_id === fixture.warehouse);
      assert.equal(head.state, fixture.posted ? 'posted' : 'counting');
      const line = (
        await db.query(`SELECT * FROM ${lineTable} WHERE (tenant_id,id)=($1,$2)`, [
          fixture.tenant,
          fixture.line_id,
        ])
      ).rows[0];
      assert.equal(line.stocktake_id, fixture.stocktake_id);
      assert.equal(line.product_id, fixture.product.id);
      assert.equal(line.location, fixture.location);
      assert.equal(line.counted, fixture.verified_count);
      assert.equal(line.version, receipts.at(-1)!.after_line_version);
      assert.deepEqual(receipts.at(-1)!.result, fixture.last_scan);
      const latestGeneration = receipts.filter(
        (r) => r.generation_id === receipts.at(-1)!.generation_id,
      );
      assert.equal(latestGeneration.length, fixture.verified_count + 1);
      for (const [i, receipt] of latestGeneration.entries()) {
        assert.equal(receipt.actor_id, fixture.operator.user);
        assert.equal(receipt.product_id, fixture.product.id);
        assert.equal(receipt.line_id, fixture.line_id);
        assert.equal(receipt.counted, i);
        assert.equal(receipt.kind, i === 0 ? 'start' : 'increment');
        assert.equal(receipt.prior_scan_id, i === 0 ? null : latestGeneration[i - 1].id);
        assert.equal(BigInt(receipt.after_line_version), BigInt(receipt.before_line_version) + 1n);
        assert.equal(receipt.result.measurement_id, receipt.measurement_id);
      }
      for (const receipt of receipts) {
        assert.equal(receipt.actor_id, fixture.operator.user);
        const m = (
          await db.query(`SELECT * FROM ${measurementTable} WHERE (tenant_id,id)=($1,$2)`, [
            fixture.tenant,
            receipt.measurement_id,
          ])
        ).rows[0];
        assert(
          m && m.stocktake_id === fixture.stocktake_id && m.actor_id === fixture.operator.user,
        );
        const counted = m.result.lines.find((l: Json) => l.line_id === receipt.line_id);
        assert(counted);
        assert.equal(counted.counted, receipt.counted);
        assert.equal(counted.version, receipt.after_line_version);
        assert.equal(counted.before_version, receipt.before_line_version);
        assert.equal(counted.basis_hash, receipt.basis_hash);
        assert.equal(m.result.version, receipt.stocktake_version);
      }
      const sample = receipts.find((r) => r.kind === 'start')!;
      assert(sample);
      await expectSqlFailure(
        db,
        'UPDATE stocktake_scan_receipts SET code=code WHERE id=$1',
        [sample.id],
        '23514',
      );
      immutableChecks++;
      await expectSqlFailure(
        db,
        'DELETE FROM stocktake_scan_receipts WHERE id=$1',
        [sample.id],
        '23514',
      );
      immutableChecks++;
      await expectSqlFailure(
        db,
        `UPDATE ${measurementTable} SET result=result WHERE id=$1`,
        [sample.measurement_id],
        '23514',
      );
      immutableChecks++;
      await expectSqlFailure(
        db,
        `DELETE FROM ${measurementTable} WHERE id=$1`,
        [sample.measurement_id],
        '23514',
      );
      immutableChecks++;
      // Genuine composite FK rejection with an actual restored start receipt. The guard
      // intentionally leaves a missing/foreign parent to FK enforcement; no triggers disabled.
      const foreignCase: FixtureReference | undefined = s.cases.find(
        (c: Json) => c.tenant !== fixture.tenant,
      );
      assert(
        foreignCase && typeof foreignCase.tenant === 'string',
        'Other own fixture tenant required',
      );
      const foreignTenant: string = foreignCase.tenant;
      const forgedId = randomUUID();
      const foreign = {
        ...sample.raw,
        id: forgedId,
        generation_id: forgedId,
        tenant_id: foreignTenant,
        client_key: randomUUID(),
      };
      await expectSqlFailure(
        db,
        `INSERT INTO stocktake_scan_receipts(${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::stocktake_scan_receipts,$1::jsonb)`,
        [JSON.stringify(foreign)],
        '23503',
      );
      foreignKeyChecks++;
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE dyna_app');
        await db.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.tenant]);
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int n FROM stocktake_scan_receipts WHERE engine=$1 AND stocktake_id=$2',
              [engine, fixture.stocktake_id],
            )
          ).rows[0].n,
          receipts.length,
        );
        assert.equal(
          (
            await db.query(
              'SELECT count(*)::int n FROM stocktake_scan_receipts WHERE tenant_id=$1',
              [foreignTenant],
            )
          ).rows[0].n,
          0,
        );
        await db.query("SELECT set_config('app.tenant_id','',true)");
        assert.equal(
          (await db.query('SELECT count(*)::int n FROM stocktake_scan_receipts')).rows[0].n,
          0,
        );
        rlsChecks += 3;
      } finally {
        await db.query('ROLLBACK');
      }
    }
    assert.deepEqual(
      await tableFingerprints(db),
      manifest.tables,
      'All copied SQL probes must rollback',
    );
  } finally {
    await db.end();
  }

  stage = 'readonly_loopback';
  // restore-preview validates copied result/config paths, binds loopback, uses readOnly
  // buildApp with rejecting integration transport, and starts no worker.
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
    let h: Json | undefined;
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (r.ok) h = await r.json();
    } catch {}
    if (h) {
      assert(h.restore_preview && h.stocktake_scans_available);
      assert.equal(h.schema_revision, schema);
      assert.equal(h.revision, revision);
      ready = true;
      break;
    }
    assert(child.exitCode === null && child.signalCode === null, 'Owned preview exited');
    await setTimeout(200);
  }
  assert(ready, 'Owned readonly preview not ready');
  let gets = 0,
    pages = 0,
    writes423 = 0,
    receiptDetails = 0;
  for (const fixture of s.cases) {
    const login = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: fixture.operator.email, password: fixture.operator.password }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(login.status, 200);
    assert(login.headers.get('set-cookie'));
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const req = (path: string, method = 'GET', body?: string, tenant = fixture.tenant) =>
      fetch(base + path, {
        method,
        headers: { cookie, 'Content-Type': 'application/json', 'X-Workspace-Id': tenant },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(10000),
      });
    const read = async (path: string): Promise<Json> => {
      const r = await req(path);
      assert.equal(r.status, 200, 'Copied GET failed');
      assert.match(r.headers.get('cache-control') ?? '', /no-store/);
      const raw = await r.text();
      assert(Buffer.byteLength(raw) <= 5242880);
      const v: Json = JSON.parse(raw);
      assert(v.available && v.read_only);
      assert.equal(v.current_role, 'operator');
      assert.equal(v.can_scan, false);
      assert.equal(v.can_replay, false);
      assert.equal(v.can_resolve, true);
      gets++;
      return v;
    };
    const p = prefix(fixture) + '/' + fixture.stocktake_id;
    const metadata = await read(p + '/scan-metadata');
    assert.equal(metadata.engine, fixture.engine);
    assert.equal(metadata.stocktake.id, fixture.stocktake_id);
    assert.equal(metadata.stocktake.state, fixture.posted ? 'posted' : 'counting');
    assert.equal(metadata.stocktake.blind, true);
    const candidates: Json[] = [],
      history: Json[] = [];
    for (const [path, output] of [
      [
        p +
          '/scan-candidates?limit=100&code=' +
          encodeURIComponent(fixture.ean) +
          '&location=' +
          encodeURIComponent(fixture.location),
        candidates,
      ],
      [p + '/scans?limit=100', history],
      [p + '/scans?limit=100&line_id=' + fixture.line_id, [] as Json[]],
    ] as const) {
      let cursor: string | null = null,
        total: number | undefined;
      const seen = new Set<string>();
      do {
        const v = await read(path + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        assert(Array.isArray(v.data) && v.data.length <= 100);
        const pageTotal: unknown = v.meta.total;
        assert(
          typeof pageTotal === 'number' &&
            Number.isInteger(pageTotal) &&
            pageTotal >= 0 &&
            pageTotal <= 100000,
        );
        if (total === undefined) total = pageTotal;
        else assert.equal(pageTotal, total);
        assert(total !== undefined, 'Every copied page must declare a bounded total');
        output.push(...v.data);
        pages++;
        assert(output.length <= total);
        cursor = v.meta.cursor;
        assert(cursor === null || typeof cursor === 'string');
        if (cursor) {
          assert(!seen.has(cursor));
          seen.add(cursor);
        }
        assert(seen.size <= 1000, 'Bounded copied history');
      } while (cursor);
      assert.equal(output.length, total);
      assert.equal(
        new Set(output.map((r) => (path.includes('scan-candidates') ? r.line_id : r.id))).size,
        output.length,
      );
      if (path.includes('line_id=')) assert.deepEqual(output, history);
    }
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].line_id, fixture.line_id);
    assert.equal(candidates[0].counted, fixture.verified_count);
    for (const candidate of candidates) {
      for (const key of [
        'original_quantity',
        'current_quantity',
        'quantity',
        'reserved',
        'difference',
        'unit_cost_minor',
        'basis_hash',
        'source_snapshot',
      ])
        assert(
          !Object.hasOwn(candidate, key),
          'Blind operator candidate must not expose system quantities/cost',
        );
    }
    const sqlReceipts = proofs.get(fixture.engine)!;
    assert.deepEqual(history.map((r) => r.id).sort(), sqlReceipts.map((r) => r.id).sort());
    for (const receipt of sqlReceipts) {
      assert.deepEqual(
        history.find((r) => r.id === receipt.id),
        receipt.result,
      );
      const detail = await read(p + '/scans/' + receipt.id);
      assert.deepEqual(detail.scan, receipt.result);
      receiptDetails++;
      for (const key of [
        'request',
        'source_snapshot',
        'basis_hash',
        'unit_cost_minor',
        'reserved',
        'quantity',
      ])
        assert(!Object.hasOwn(detail.scan, key), 'Receipt public projection must remain safe');
    }
    for (const path of [p + '/scan-start', p + '/scans']) {
      assert.equal(
        (await req(path, 'POST', '{')).status,
        423,
        'Restore guard must precede malformed JSON parsing',
      );
      writes423++;
    }
    const other: FixtureReference | undefined = s.cases.find(
      (c: Json) => c.tenant !== fixture.tenant,
    );
    assert(
      other &&
        typeof other.tenant === 'string' &&
        typeof other.stocktake_id === 'string' &&
        (other.engine === 'wms' || other.engine === 'quantity'),
      'Other own fixture scope required',
    );
    assert.equal((await req(p + '/scan-metadata', 'GET', undefined, other.tenant)).status, 409);
    assert.equal(
      (await req(prefix(other) + '/' + other.stocktake_id + '/scan-metadata')).status,
      404,
    );
    assert.equal(
      (
        await fetch('http://127.0.0.1:4100/api' + p + '/scan-metadata', {
          headers: { cookie },
          signal: AbortSignal.timeout(5000),
        })
      ).status,
      401,
      'Copied cookie must not authenticate source',
    );
  }
  stage = 'exact_readback';
  for (const fixture of s.cases) {
    assert.deepEqual(
      await checkpoint(s, fixture, fresh, true),
      withoutSessions(fixture.own_snapshot),
    );
    assert.deepEqual(
      await checkpoint(s, fixture),
      fixture.own_snapshot,
      'Source checkpoint must remain exact',
    );
  }
  const check = new pg.Client({ ...localDatabase(), database: fresh });
  await check.connect();
  try {
    await check.query("SET TIME ZONE 'UTC'");
    const sessions: Json[] = (
      await check.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY 1')
    ).rows;
    const old = new Set(originalSessions.map((r) => r.row.token_hash));
    assert.deepEqual(
      sessions.filter((r) => old.has(r.row.token_hash)),
      originalSessions,
    );
    const added = sessions.filter((r) => !old.has(r.row.token_hash));
    assert.equal(added.length, 2);
    assert.equal(sessions.length, originalSessions.length + 2);
    assert.deepEqual(
      added.map((r) => [r.row.tenant_id, r.row.user_id]).sort(),
      s.cases.map((c: Json) => [c.tenant, c.operator.user]).sort(),
    );
    assert.deepEqual(
      withoutSessions(await tableFingerprints(check)),
      withoutSessions(manifest.tables),
    );
    assert.equal(
      await schemaFingerprint(check, manifest.schema_fingerprint_version ?? 1),
      manifest.schema_sha256,
    );
  } finally {
    await check.end();
  }
  assert.equal(
    sha(await readFile(statePath)),
    acceptedStateHash,
    'Do not rewrite accepted private state',
  );
  assert.equal(sha(await readFile(baselinePath)), baselineHash);
  report = {
    stage: 113,
    status: 'PASS',
    revision,
    schema,
    backup_id: backup.id,
    tables: restored.tables,
    migrations,
    encrypted_records_verified: restored.encrypted_records_verified,
    full_manifest_and_schema_exact: true,
    non_session_manifest_exact_after_preview: true,
    immutable_checks: immutableChecks,
    composite_fk_rejections: foreignKeyChecks,
    validated_foreign_keys: 11,
    forced_rls_probes: rlsChecks,
    restored_receipt_details_exact: receiptDetails,
    cases: s.cases.map((c: Json) => ({
      engine: c.engine,
      counted: c.verified_count,
      scan_receipts: c.scan_count,
      terminal: Boolean(c.posted),
      checkpoint_tables: s.own_names.length,
    })),
    readonly_gets: gets,
    paged_responses: pages,
    writes423,
    copied_prior_sessions_exact: true,
    copied_operator_sessions_added: 2,
    worker_enabled: false,
    provider_verified: false,
    hardware_verified: false,
    ui_verified: false,
    goal_complete: false,
    source_checkpoints_exact: true,
    original_baseline_file_unchanged: true,
    prior_databases_preserved: priorDatabases.length,
    preservation_before_backup: preservationBefore,
    original113_firms_protected: 109,
    accepted112_checkpoints_protected: 3,
    legacy105_chain_verified: true,
  };
}

try {
  await run();
} catch (error) {
  // Never expose assertions' actual/expected data, SQL, config, credentials or server bodies.
  await writeFile(
    'data/stocktake-scans-recovery-error.json',
    JSON.stringify(
      {
        stage,
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  report = undefined;
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        stage: 113,
        status: 'INCOMPLETE',
        failed_stage: stage,
        message:
          'Recovery did not prove acceptance. Inspect the failed stage privately; no baseline/state was rewritten.',
        provider_verified: false,
        hardware_verified: false,
        ui_verified: false,
        goal_complete: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.error({
    stage,
    status: 'INCOMPLETE',
    error_type: error instanceof Error ? error.name : 'Error',
  });
  process.exitCode = 1;
} finally {
  stage = 'owned_cleanup';
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child!.once('exit', () => done()));
      child.kill('SIGTERM');
      if (!(await Promise.race([exited.then(() => true), setTimeout(10000).then(() => false)]))) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    if (ownedDatabase) {
      assert(priorDatabases && !priorDatabases.includes(ownedDatabase));
      const admin = new pg.Client({ ...localDatabase(), database: 'postgres' });
      await admin.connect();
      try {
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
          [ownedDatabase],
        );
        await admin.query('DROP DATABASE ' + restoreDatabaseName(ownedDatabase));
      } finally {
        await admin.end();
      }
    }
    if (priorDatabases)
      assert.deepEqual(
        await databaseNames(),
        priorDatabases,
        'Every unrelated database must remain exact, including failure paths',
      );
    if (baselineHash) {
      const after = await verifyStocktakeScansPreservation();
      assert(
        ['PASS_EXACT_ORIGINAL_ROWS', 'PASS_WITH_SOURCE_BOUND_LOCAL_JOBS'].includes(after.status),
      );
      assert.equal(after.stage, 113);
      assert.equal(after.prior_firms, 109);
      assert.equal(after.accepted_stage112_checkpoints_exact, 3);
      assert.equal(after.earlier_105_preservation, 'PASS_CORE_AND_SOURCE_TRACED_BACKGROUND');
      assert.equal(after.original_baseline_sha256, baselineHash);
      assert.equal(sha(await readFile(baselinePath)), baselineHash);
      if (report) report.preservation_after_cleanup = after;
    }
    if (report) {
      report.owned_preview_and_database_removed = true;
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(report);
    }
  } catch (error) {
    report = undefined;
    process.exitCode = 1;
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          stage: 113,
          status: 'INCOMPLETE',
          failed_stage: 'owned_cleanup',
          message:
            'Owned cleanup or original preservation was not proven. No PASS is accepted; inspect copied resource ownership privately.',
          provider_verified: false,
          ui_verified: false,
          goal_complete: false,
        },
        null,
        2,
      ) + '\n',
    );
    console.error({
      stage: 'owned_cleanup',
      status: 'INCOMPLETE',
      error_type: error instanceof Error ? error.name : 'Error',
    });
  } finally {
    await pool.end();
  }
}
