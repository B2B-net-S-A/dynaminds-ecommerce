/** ROOT ONLY. Read-only before/after migration checkpoint; no login, writes,
 * migration, worker or provider. Private full-row fingerprints never leave disk. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const root = '<workspace>/app';
const phase = process.argv[2];
assert(['before', 'after'].includes(phase));
const output = resolve(root, `data/return-destinations-native161-${phase}.json`);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesDigest = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const identifier = (v: string) => { assert.match(v, /^[a-z][a-z0-9_]*$/); return `"${v}"`; };
const added = ['warehouse_inventory_policies', 'warehouse_inventory_policy_revisions',
  'warehouse_inventory_policy_previews', 'warehouse_inventory_policy_operations',
  'warehouse_inventory_policy_admissions', 'return_destination_statuses',
  'return_destination_status_revisions', 'return_destination_status_previews',
  'return_destination_status_operations', 'return_destination_status_admissions'].sort();
const configPath = resolve(root, '.local.json');
const configBytes = await readFile(configPath);
const config = JSON.parse(configBytes.toString('utf8'));
const c = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres',
  password: config.dbPassword, database: 'dynaminds', connectionTimeoutMillis: 5000 });
let step = 'connect';
try {
  await c.connect();
  step = 'health';
  const response = await fetch('http://127.0.0.1:4100/api/health', { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const h = await response.json() as Record<string, unknown>;
  assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  const expectedSchema = phase === 'before' ? '145_order_merge_counters' : '147_return_destination_statuses';
  assert.equal(h.schema_revision, expectedSchema);
  assert.equal(h.revision, process.env.QA_EXPECTED_REVISION);
  if (phase === 'after') {
    assert.equal(h.warehouse_inventory_policies_available, true);
    assert.equal(h.return_destination_statuses_available, true);
    assert.equal(h.return_destinations_available, false);
  }
  step = 'snapshot';
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL TimeZone='UTC'");
  const names: string[] = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).rows.map(r => r.table_name);
  const tables: Record<string, { count: number; sha256: string; columns: string[] }> = {};
  for (const name of names) {
    const columns: string[] = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [name])).rows.map(r => r.column_name);
    const rows = (await c.query(`SELECT to_jsonb(x) row FROM ${identifier(name)} x ORDER BY 1`)).rows;
    tables[name] = { count: rows.length, sha256: digest(rows), columns };
  }
  const migrations = (await c.query('SELECT to_jsonb(x) row FROM migrations x ORDER BY 1')).rows;
  const metadata: Record<string, any[]> = {
    relations: (await c.query("SELECT oid::text,relname,relkind,relowner::regrole::text owner,relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p','i','S') ORDER BY oid")).rows,
    functions: (await c.query("SELECT oid::text,proname,pg_get_function_identity_arguments(oid) arguments,proowner::regrole::text owner,proacl::text,pg_get_functiondef(oid) definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f' ORDER BY oid")).rows,
    policies: (await c.query("SELECT p.oid::text,to_jsonb(p) definition FROM pg_policy p JOIN pg_class r ON r.oid=p.polrelid WHERE r.relnamespace='public'::regnamespace ORDER BY p.oid")).rows,
    triggers: (await c.query("SELECT t.oid::text,to_jsonb(t) catalog,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE r.relnamespace='public'::regnamespace ORDER BY t.oid")).rows,
    constraints: (await c.query("SELECT k.oid::text,k.conname name,k.conrelid::regclass::text relation,pg_get_constraintdef(k.oid,true) definition,k.convalidated FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname='public' ORDER BY k.oid")).rows,
  };
  await c.query('COMMIT');
  step = 'file-custody';
  const files: Record<string, { sha256: string; mode: number; size: number }> = {};
  async function captureFile(path: string, name: string) {
    const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink());
    files[name] = { sha256: bytesDigest(await readFile(path)), mode: stat.mode & 0o777, size: stat.size };
  }
  await captureFile(configPath, '.local.json');
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['postgres', 'pg', 'backups', 'restores', 'ollama-runtime'].includes(entry.name) || entry.name.startsWith('return-destinations-native161-')) continue;
      const name = prefix + entry.name, path = resolve(directory, entry.name);
      assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) await visit(path, name + '/');
      else if (entry.isFile() && /\.(json|png|jpe?g|webp|pdf|eml)$/i.test(entry.name)) await captureFile(path, name);
    }
  }
  await visit(resolve(root, 'data'), 'data/');
  let compared = 0;
  if (phase === 'before') assert(added.every(name => !tables[name]));
  else {
    step = 'compare';
    const before = JSON.parse(await readFile(resolve(root, 'data/return-destinations-native161-before.json'), 'utf8'));
    assert.deepEqual(names, [...Object.keys(before.tables), ...added].sort());
    for (const [name, value] of Object.entries(before.tables)) {
      if (name === 'migrations') continue;
      assert.deepEqual(tables[name], value, 'Exact complete old table: ' + name); compared++;
    }
    for (const name of added) assert.equal(tables[name].count, 0, 'New module remains globally empty');
    const newLedger = ['146_warehouse_inventory_policies', '147_return_destination_statuses'];
    assert.deepEqual(migrations.filter(r => !newLedger.includes(r.row.name)), before.migrations);
    assert.deepEqual(migrations.filter(r => newLedger.includes(r.row.name)).map(r => r.row.name).sort(), newLedger);
    for (const [kind, rows] of Object.entries(before.metadata) as [string, any[]][]) {
      const current = new Map(metadata[kind].map(r => [r.oid, r]));
      for (const row of rows) {
        if (kind === 'constraints' && row.relation === 'api_keys' && ['api_keys_scopes_check', 'api_keys_scopes_check1'].includes(row.name)) continue;
        assert.deepEqual(current.get(row.oid), row, 'Old metadata preserved: ' + kind);
      }
    }
    const checks = metadata.constraints.filter(r => r.relation === 'api_keys' && ['api_keys_scopes_check', 'api_keys_scopes_check1'].includes(r.name));
    assert.equal(checks.length, 2); assert(checks.every(r => r.convalidated));
    assert(checks.some(r => r.definition.includes('returns:configure')));
    assert(checks.some(r => r.definition.includes('<= 20')));
    assert.deepEqual(files, before.files, 'All pinned original files and config remain byte-identical');
    assert.equal(bytesDigest(await readFile(configPath)), bytesDigest(configBytes));
  }
  step = 'exclusive-write';
  const f = await open(output, 'wx', 0o600);
  try { await f.writeFile(JSON.stringify({ phase, revision: h.revision, schema: expectedSchema, tables, migrations, metadata, files }, null, 2) + '\n'); await f.sync(); }
  finally { await f.close(); }
  console.log(JSON.stringify({ result: 'PASS', phase, schema: expectedSchema, table_count: names.length, compared_old_tables: compared, pinned_files: Object.keys(files).length }));
} catch (e) {
  const code = (e as { code?: string }).code;
  console.log(JSON.stringify({ result: 'FAIL', phase, step, code: code === 'ERR_ASSERTION' ? code : 'CHECKPOINT_FAILURE' }));
  process.exitCode = 1;
} finally { await c.end().catch(() => undefined); }
