/** Root-owned read-only verification; immutable before/after checkpoints are never replaced. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const revision = '1cd31084d129e71c7a588e435b8a9e426be0f3d6';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const digest = (v: unknown) => sha(JSON.stringify(v));
const pinned = new Map<string, string>();
async function document(path: string) {
  const raw = await readFile(path);
  pinned.set(path, sha(raw));
  return JSON.parse(raw.toString('utf8'));
}
async function fileSnapshot(paths: string[]) {
  const result: Record<string, { sha256: string; mode: number }> = {};
  for (const path of paths) {
    assert.match(path, /^data\/[a-zA-Z0-9_.-]+\.json$/);
    const st = await lstat(path);
    assert(st.isFile() && !st.isSymbolicLink());
    result[path] = { sha256: sha(await readFile(path)), mode: st.mode & 0o777 };
  }
  return result;
}
try {
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const before = await document('docs/language-file-import-native-before.json');
  const after = await document('docs/language-file-import-native-after.json');
  const manifest = await document('docs/language-file-import-source-evidence.json');
  const csv = await document('docs/language-file-import-native-csv-readback.json');
  const xml = await document('docs/language-file-import-native-xml-readback.json');
  assert.equal(before.tenants.length, 137);
  assert.deepEqual(after.tenants, before.tenants);
  assert.deepEqual(after.users, before.users);
  assert.equal(Object.keys(before.tables).length, 325);
  assert.equal(Object.keys(after.tables).length, 333);
  for (const [path, expected] of Object.entries(manifest.source_sha256))
    assert.equal(sha(await readFile(path)), expected, 'Source changed: ' + path);
  for (const [path, expected] of Object.entries(manifest.evidence_sha256))
    assert.equal(sha(await readFile(path)), expected, 'Source evidence changed: ' + path);
  const paths = Object.keys(before.private_sha256);
  assert.equal(paths.length, 239);
  const initialFiles = await fileSnapshot(paths);
  for (const path of paths) {
    assert.deepEqual(initialFiles[path], {
      sha256: before.private_sha256[path], mode: before.original_modes[path],
    }, 'Original fixture changed: ' + path);
    assert.equal(initialFiles[path].sha256, after.private_sha256[path]);
    assert.equal(initialFiles[path].mode, after.original_modes[path]);
  }
  const response = await fetch('http://127.0.0.1:4100/api/health', { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const health = await response.json() as any;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '117_language_file_imports');
  assert.equal(health.mode, 'local');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  assert.equal(health.language_file_import_available, true);
  const c = await pool.connect();
  const tables: Record<string, any> = {};
  const allowed = new Set(['audit_events', 'language_file_import_admissions', 'language_file_import_core_witnesses',
    'language_file_import_execution_rows', 'language_file_import_executions', 'language_file_import_previews',
    'language_file_import_rows', 'product_translation_bulk_edit_execution_rows', 'product_translation_bulk_edit_executions',
    'product_translation_bulk_edit_previews', 'product_translation_bulk_edit_rows', 'product_translations', 'products']);
  let unchangedOwn = 0;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    for (const name of Object.keys(after.tables)) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = ['tenants','users'].includes(name) ? 'id' : 'tenant_id';
      const rows = (await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=ANY($1::uuid[]) ORDER BY 1`,
        [name === 'users' ? before.users : before.tenants])).rows;
      tables[name] = { count: rows.length, sha256: digest(rows) };
      assert.deepEqual(tables[name], after.tables[name], 'Old tenant data changed: ' + name);
      if (before.tables[name]) assert.deepEqual(tables[name], before.tables[name]);
      else { assert(name.startsWith('language_file_import_')); assert.equal(rows.length, 0); }
      const own = (await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`,
        [name === 'users' ? (await document('docs/language-file-import-native-setup.json')).user : xml.tenant])).rows;
      assert.deepEqual({count: own.length, sha256: digest(own)}, xml.tables[name], 'Own data changed after XML snapshot: ' + name);
      if (!allowed.has(name)) {
        assert.deepEqual(xml.tables[name], csv.tables[name], 'Unrelated own data changed: ' + name);
        unchangedOwn++;
      }
    }
    assert.deepEqual(csv.products.map((p: any) => p.version), [2,2]);
    const [p0,p1] = csv.products;
    const expected = [[p0.id,'de','Deutsch 0','Łódź\r\nOpis "DE" 0'],
      [p0.id,'en','English 0','English description 0'],[p1.id,'de','Deutsch 1','Łódź\r\nOpis "DE" 1']];
    assert.deepEqual(csv.translations.map((t: any) => [t.product_id,t.locale,t.name,t.description]), expected);
    const executionIds = xml.executions.map((e: any) => e.id);
    assert.equal(executionIds.length, 2);
    const currentExecutions = (await c.query('SELECT id,preview_id,core_execution_id,payload FROM language_file_import_executions WHERE tenant_id=$1 ORDER BY created_at',[xml.tenant])).rows;
    assert.deepEqual(currentExecutions, xml.executions);
    assert.deepEqual(xml.executions[0], csv.executions[0]);
    const receipts: any[] = [];
    for (const [i, execution] of xml.executions.entries()) {
      const file = i ? 'docs/language-file-import-native-valid.xml' : 'docs/language-file-import-native.csv';
      assert.equal(execution.payload.source_hash, sha(await readFile(file)));
      const dbRows = (await c.query('SELECT payload FROM language_file_import_execution_rows WHERE tenant_id=$1 AND execution_id=$2 ORDER BY index',[xml.tenant,execution.id])).rows.map(r => r.payload);
      assert.deepEqual(dbRows, execution.payload.rows);
      for (const row of dbRows) {
        const core = (await c.query('SELECT * FROM product_translation_bulk_edit_execution_rows WHERE tenant_id=$1 AND id=$2',[xml.tenant,row.core_receipt_id])).rows[0];
        assert(core);
        assert.equal(core.id, row.receipt_id);
        assert.equal(core.execution_id, execution.core_execution_id);
        for (const field of ['product_id','locale','before','after','input','status','before_product_version','after_product_version'])
          assert.deepEqual(core[field], row[field], 'Receipt mismatch: ' + field);
        receipts.push({id:core.id,execution_id:core.execution_id,product_id:core.product_id,locale:core.locale});
      }
    }
    assert.equal(receipts.length,5);
    assert.equal(new Set(receipts.map(r => r.id)).size,5);
    for (const t of xml.translations) assert(receipts.some(r => r.id===t.manual_receipt_id && r.product_id===t.product_id && r.locale===t.locale));
    await c.query('COMMIT');
    assert.deepEqual(await fileSnapshot(paths), initialFiles);
    for (const [path, expectedHash] of pinned) assert.equal(sha(await readFile(path)), expectedHash);
    await writeFile('docs/language-file-import-native-post-ui-preservation.json', JSON.stringify({
      status:'PASS', revision, schema_revision:health.schema_revision, tenants:before.tenants, users:before.users,
      tables, private_files:initialFiles, checkpoints_sha256:Object.fromEntries(pinned),
      own_unchanged_tables_csv_to_xml:unchangedOwn, own_total_tables:333, own_allowed_changed_tables:[...allowed],
      csv_exact_texts:true, exact_source_hashes:true, receipts, all_source_hashes_verified:16,
      sessions_excluded:true, original_baseline_rebased:false, provider_calls:false,
      native_existing_translation_remove_verified:false, restart_verified:false, full_goal_complete:false,
    },null,2)+'\n',{flag:'wx'});
    console.log({status:'POST_UI_PASS', old_tenants:137, tables:333, private_files:239, own_unchanged_tables:unchangedOwn, receipts:receipts.length});
  } finally { await c.query('ROLLBACK').catch(()=>{}); c.release(); }
} finally { await pool.end(); }
