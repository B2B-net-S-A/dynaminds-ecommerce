/** Logical dump → restore → start on a real clone, so a future migration cannot silently break restoring from pg_dump.
 * DATABASE_URL is a fresh PG04 clone dynaminds_dumprestore_YYYYMMDD_NN of the restored template. The test runs the real
 * migrate() to HEAD, pg_dump --format=custom of it, restorePlainDump (server/recovery-dump-restore.ts) into the NEW database
 * <clone>_r, and server/index.ts on <clone>_r. pg_dump loses the 262 database ACL and every explicit owner-only relation /
 * schema ACL equal to the default; after the restore path both must equal the source byte for byte, the startup
 * normalizer must be idempotent, 16 guards true and /api/health answer with the source schema revision.
 * Red on 30.10.2026 before the normalizer listed 211..261: "263 requires complete261 predecessor:relation
 * public.stocktake_adjustment_usage". The restored database and the dump are removed afterwards; rerun = NEW clone. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { migrate, pool } from '../server/db';
import { restorePlainDump } from '../server/recovery-dump-restore';
import { normalizeOrdinaryLegacyOwnerAcls } from '../server/ordinary-legacy-schema.mjs';

assert.equal(process.env.DYNA_TEST, 'true');
const sourceUrl = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(sourceUrl.hostname, '127.0.0.1');
assert.equal(sourceUrl.port, '57084');
assert.match(sourceUrl.pathname, /^\/dynaminds_dumprestore_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_dumprestore_YYYYMMDD_NN of the restored template required');
const source = sourceUrl.pathname.slice(1), restored = source + '_r';
const restoredUrl = new URL(sourceUrl.href);
restoredUrl.pathname = '/' + restored;
const password = decodeURIComponent(sourceUrl.password);
// The 15 reconcile guards of tools/scale/load/lib.mjs (RECONCILE_GUARDS) and the 263 manual OFF verdict.
const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards',
  'ordinary188_structure_valid', 'return_credit211_metadata_valid', 'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid',
  'local_invoice_guards', 'warehouse_wz_issuer_guards', 'email_inbound_guards', 'catalog_stock_control_guards', 'financial_return_guards',
  'stocktake_adjustment_guards', 'manual_off_verdict_valid'];
// ACL representation of everything pg_dump/pg_restore can carry or lose, NULL kept as NULL.
const ACL_SQL = `SELECT 'relation '||n.nspname||'.'||c.relname k, c.relacl::text acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  UNION ALL SELECT 'schema '||nspname, nspacl::text FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
  UNION ALL SELECT 'function '||p.oid::regprocedure::text, p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL SELECT 'type '||t.oid::regtype::text, t.typacl::text FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  UNION ALL SELECT 'database', datacl::text FROM pg_database WHERE datname=current_database()
  ORDER BY 1`;
let directory = '', dump = '';
let restoredClient: pg.Client | undefined;
const sourceAcls = async () => (await pool.query(ACL_SQL)).rows;

before(async () => {
  const exists = (await pool.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [restored])).rows[0].n;
  assert.equal(exists, 0, `${restored} must not exist yet`);
  await migrate();
  directory = await mkdtemp(join(tmpdir(), 'dyna-dump-restore-'));
  dump = join(directory, 'source.dump');
  const tool = resolve(process.env.DYNA_PG_TOOLS ?? resolve(homedir(), '.local/share/dynaminds/pg-tools/18/bin'), 'pg_dump');
  const r = spawnSync(tool, ['--host=127.0.0.1', '--port=57084', '--username=postgres', '--no-password', `--dbname=${source}`,
    '--format=custom', `--file=${dump}`], { env: { PATH: process.env.PATH, PGPASSWORD: password, LC_ALL: 'C' }, encoding: 'utf8' });
  assert.equal(r.status, 0, 'pg_dump: ' + (r.stderr ?? '').slice(0, 400));
});

after(async () => {
  await restoredClient?.end().catch(() => {});
  await pool.query(`DROP DATABASE IF EXISTS "${restored}" WITH (FORCE)`).catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
  await pool.end();
});

test('restorePlainDump: the 262 database ACL and the dropped owner-only ACLs are back, equal to the source', async () => {
  const result = await restorePlainDump(dump, restored);
  assert.equal(result.status, 'restored');
  assert.deepEqual(result.temporary, { database: restored, applied: true, appTemp: false, reapplied: true });
  // pg_dump really dropped them (30.10.2026 at HEAD 263: 240 tables, 14 sequences, ordinary187_private).
  assert.ok(result.owner_default_acls_materialized > 0, 'the dump omitted default-equivalent ACLs');
  restoredClient = new pg.Client({ connectionString: restoredUrl.href, options: '-c jit=off -c timezone=UTC' });
  await restoredClient.connect();
  const [left, right] = [await sourceAcls(), (await restoredClient.query(ACL_SQL)).rows];
  assert.equal(right.length, left.length);
  assert.deepEqual(right.filter((r, i) => r.k !== left[i].k || r.acl !== left[i].acl), [], 'restored ACL representation differs from the source');
  await restoredClient.query("SET SESSION statement_timeout='120s'");
  assert.deepEqual(await normalizeOrdinaryLegacyOwnerAcls(restoredClient), { owner_default_acls_materialized: 0 }, 'startup normalizer is idempotent after the restore');
});

test('restored database: 16 guards true and the same ledger as the source', async () => {
  assert(restoredClient, 'restore ran');
  const ledger = 'SELECT count(*)::int n, max(name) last FROM migrations';
  assert.deepEqual((await restoredClient.query(ledger)).rows[0], (await pool.query(ledger)).rows[0]);
  const values: Record<string, unknown> = {};
  for (const g of GUARDS) values[g] = (await restoredClient.query(`SELECT public.${g}() ok`)).rows[0].ok;
  assert.deepEqual(Object.entries(values).filter(([, v]) => v !== true), [], 'guards not true');
});

test('server/index.ts starts on the restored database and /api/health reports the source schema revision', async () => {
  const last = (await pool.query('SELECT max(name) last FROM migrations')).rows[0].last;
  const port = '47263';
  const env = { ...process.env, DATABASE_URL: restoredUrl.href, PORT: port, DYNA_WORKER_DISABLED: 'true', DYNA_TEST_ALLOWED_PORTS: '57084' } as NodeJS.ProcessEnv;
  const child = spawn(process.execPath, ['--import', './tests/loopback-only-network.mjs', 'node_modules/tsx/dist/cli.mjs', 'server/index.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', exited: number | null | undefined;
  child.stderr!.on('data', (d) => { if (stderr.length < 65536) stderr += String(d); });
  const exit = new Promise<void>((done) => child.on('exit', (code) => { exited = code; done(); }));
  try {
    const deadline = Date.now() + 300_000;
    let health: { status: number; body: any } | undefined;
    while (exited === undefined && Date.now() < deadline && !health) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); health = { status: r.status, body: await r.json() }; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    assert(health, `server/index.ts did not listen (exit ${exited}): ${stderr.slice(-2000)}`);
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.schema_revision, last);
  } finally {
    if (exited === undefined) child.kill('SIGTERM');
    await exit;
  }
});
