import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Root-only, explicit additive activation witness. The private snapshots may
// contain business data and encrypted credentials; never publish their rows.
assert.deepEqual(process.argv.slice(2), ['--apply-local150']);
assert.equal(process.cwd(), '<workspace>/app');
const configPath = resolve('.local.json');
assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, configPath);
assert.equal((await stat(configPath)).mode & 0o777, 0o600);
assert.match(process.env.DYNA_EXPECTED_RUNTIME_REVISION ?? '', /^[a-f0-9]{40}$/);
assert.equal(createHash('sha256').update(await readFile(resolve('server/150_warehouse_automatic_wz.sql'))).digest('hex'), 'e8617aa82f088e2521e5267f79b9c25692f8a30fa9478faa5426ad7cb57a47c1');
const { migrate, pool } = await import('../server/db');
const { warehouseAutomaticWzAvailable } = await import('../server/warehouse-automatic-wz');
const database = new URL(pool.options.connectionString!);
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '55432');
assert.equal(database.pathname, '/dynaminds');
const family = ['previews', 'operations', 'revisions', 'configurations', 'admissions', 'manifest'].map(n => 'warehouse_automatic_wz_' + n);
const directory = resolve('data/warehouse-automatic-wz167-migration-' + randomUUID());
await mkdir(directory, { mode: 0o700 });
let step = 'preflight';
const exact = (actual: unknown, expected: unknown, label: string) => assert(isDeepStrictEqual(actual, expected), label);
async function capture() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const rows: Record<string, any[]> = {};
    for (const { tablename } of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows) {
      assert.match(tablename, /^[a-z][a-z0-9_]*$/);
      rows[tablename] = (await c.query(`SELECT to_jsonb(r) row FROM public."${tablename}" r ORDER BY 1`)).rows;
    }
    const functions = (await c.query("SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p) meta,pg_get_functiondef(p.oid) definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN('f','p') ORDER BY p.oid")).rows;
    const triggers = (await c.query("SELECT t.oid,c.relname,to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid")).rows;
    const tables = (await c.query(`SELECT c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
      (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attnum),'[]') FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) columns,
      (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p WHERE p.polrelid=c.oid) policies,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(x),'definition',pg_get_constraintdef(x.oid,false)) ORDER BY x.oid),'[]') FROM pg_constraint x WHERE x.conrelid=c.oid) constraints,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid),'[]') FROM pg_index i WHERE i.indrelid=c.oid) indexes
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.oid`)).rows;
    await c.query('COMMIT');
    return { rows, functions, triggers, tables };
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
async function save(name: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  await writeFile(resolve(directory, name + '.private.json'), bytes, { mode: 0o600, flag: 'wx' });
  return createHash('sha256').update(bytes).digest('hex');
}
try {
  const health = await (await fetch('http://127.0.0.1:4100/api/health')).json() as any;
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.schema_revision, '149_stocktake_adjustments');
  assert.equal(health.revision, process.env.DYNA_EXPECTED_RUNTIME_REVISION);
  const manifest = [...(await readFile(resolve('server/db.ts'), 'utf8')).matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)].map(m => m[1]);
  assert.equal(manifest.length, 150);
  const applied = (await pool.query('SELECT name FROM migrations ORDER BY name')).rows.map(r => r.name);
  exact(applied, manifest.slice(0, 149), 'Exact pre150 ledger');
  exact(manifest.filter(name => !applied.includes(name)), ['150_warehouse_automatic_wz'], 'Only150 pending');
  assert.equal(await warehouseAutomaticWzAvailable(), false);
  step = 'capture_before';
  const before = await capture(), beforeSha = await save('before', before);
  assert.equal(before.rows.migrations.at(-1)?.row.name, '149_stocktake_adjustments');
  step = 'apply150'; await migrate();
  step = 'capture_after';
  const after = await capture(), afterSha = await save('after', after);
  step = 'verify';
  for (const [name, rows] of Object.entries(before.rows))
    exact(name === 'migrations' ? after.rows[name].filter(x => x.row.name !== '150_warehouse_automatic_wz') : after.rows[name], rows, 'All old global rows: ' + name);
  assert.deepEqual(Object.keys(after.rows).filter(n => !before.rows[n]).sort(), family.slice().sort());
  for (const n of family.filter(n => n !== 'warehouse_automatic_wz_manifest')) assert.deepEqual(after.rows[n], []);
  assert.equal(after.rows.warehouse_automatic_wz_manifest.length, 1);
  for (const f of before.functions) exact(after.functions.filter(x => x.oid === f.oid), [f], 'Old function/OID/ACL: ' + f.signature);
  for (const t of before.triggers) exact(after.triggers.filter(x => x.oid === t.oid), [t], 'Old trigger: ' + t.relname);
  let riAdded = 0;
  for (const t of before.tables) {
    const now = after.tables.find(x => x.oid === t.oid); assert(now);
    exact(now, t, 'Old relation metadata: ' + t.relname);
  }
  const additions = after.triggers.filter(x => !before.triggers.some(t => t.oid === x.oid));
  const newRelationOids = after.tables.filter(x => family.includes(x.relname)).map(x => x.oid);
  for (const t of additions) {
    if (t.meta.tgisinternal) {
      riAdded++;
      const constraint = (await pool.query('SELECT conrelid,confrelid,convalidated FROM pg_constraint WHERE oid=$1', [t.meta.tgconstraint])).rows[0];
      assert(constraint?.convalidated && newRelationOids.includes(constraint.conrelid));
    } else assert(family.includes(t.relname), 'Only own new user triggers');
  }
  assert.equal(additions.filter(x => !x.meta.tgisinternal).length, 7);
  assert.equal(riAdded, 96);
  assert.equal(after.functions.filter(x => !before.functions.some(f => f.oid === x.oid)).length, 15);
  assert(await warehouseAutomaticWzAvailable());
  const publicResult = { status: 'PASS', old_tables: Object.keys(before.rows).length, new_tables: family.length,
    old_rows_functions_oids_acl_and_table_metadata_exact: true, old_triggers_exact: true,
    new_validated_ri_triggers: riAdded, new_user_triggers: 7, issuer_available: false,
    private_before_sha256: beforeSha, private_after_sha256: afterSha, private_directory: directory,
    old_schema: '149_stocktake_adjustments', new_schema: '150_warehouse_automatic_wz' };
  await save('result', publicResult);
  console.log(JSON.stringify(publicResult));
} catch (e) {
  await save('failure', { status: 'FAIL', step });
  console.error(JSON.stringify({ status: 'FAIL', step, private_directory: directory }));
  process.exitCode = 1;
} finally { await pool.end(); }
