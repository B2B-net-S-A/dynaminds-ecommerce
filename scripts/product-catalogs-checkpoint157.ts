/** ROOT ONLY: GET + owner REPEATABLE READ READ ONLY; no login, mutation,
 * migration, worker, provider, backup or restore. First expected acceptance
 * manifest is supplied separately by root; observed rows never become their
 * own expected commerce result. Outputs are exclusive and do not rebase custody.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import pg from 'pg';

const ROOT = '<workspace>/app';
const WT = '<workspace>/worktrees/stock-file-import';
const phase = process.argv[2];
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = process.env.QA157_SCHEMA_REVISION ?? '142_product_catalogs';
const restored = phase === 'after-restore-api';
const base = restored ? 'http://127.0.0.1:4196/api' : 'http://127.0.0.1:4100/api';
const catalogTables = ['product_catalogs', 'product_catalog_warehouses',
  'product_catalog_price_lists', 'product_catalog_languages', 'product_catalog_previews',
  'product_catalog_operations', 'product_catalog_admissions'];
type Row = Record<string, any>;
type Fingerprint = { count: number; sha256: string };
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => sha(JSON.stringify(v));
const inputs = new Map<string, Buffer>();
let client: pg.Client | undefined, actor: Row, cookie = '', step = 'preflight', reads = 0;
function uuid(v: unknown): string {
  assert(typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v), 'Canonical identity');
  return v;
}
async function regular(file: string, mode?: number, max = 256 * 1024 * 1024) {
  const s = await lstat(file);
  assert(s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= max, 'Regular bounded input');
  if (mode !== undefined) assert.equal(s.mode & 0o777, mode);
  const b = await readFile(file); inputs.set(file, b); return b;
}
function ownPath(file: string) {
  assert.equal(file, resolve(file)); assert.equal(dirname(file), resolve(ROOT, 'data'));
  assert.match(basename(file), /^product-catalogs-[a-z0-9-]+\.json$/); return file;
}
async function absent(file: string) {
  try { await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive output exists');
}
async function wx(file: string, value: unknown, mode: number) {
  const f = await open(file, 'wx', mode);
  try { await f.writeFile(JSON.stringify(value, null, 2) + '\n'); await f.sync(); } finally { await f.close(); }
}
async function request(route: string, session = cookie) {
  assert(route.startsWith('/') && !route.startsWith('//') && !route.includes('://'));
  return fetch(base + route, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000),
    headers: session ? { cookie: session, 'X-Workspace-ID': uuid(actor.tenant_id) } : {} });
}
async function get(route: string, catalog = false): Promise<Row> {
  const r = await request(route); assert.equal(r.status, 200, 'Expected scoped GET');
  const b = Buffer.from(await r.arrayBuffer()); assert(b.length <= 16 * 1024 * 1024);
  const d: Row = JSON.parse(b.toString('utf8')); reads++;
  if (catalog) {
    assert.equal(d.available, true); assert.equal(d.can_read, true);
    assert.equal(d.current_role, 'admin'); assert.equal(d.read_only, restored);
    assert.equal(d.can_manage, !restored);
    if (restored && d.preview) assert.equal(d.preview.can_commit, false);
  }
  return d;
}
async function health() {
  const h = await get('/health'); assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local');
  assert.equal(h.revision, revision); assert.equal(h.schema_revision, schema);
  assert.equal(h.restore_preview, restored); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.product_catalogs_available, true);
}
async function paged(route: string) {
  const data: Row[] = [], seen = new Set<string>(); let cursor: string | null = null;
  for (let i = 0; i < 40; i++) {
    const d = await get(route + (route.includes('?') ? '&' : '?') + 'limit=50' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), true);
    assert(Array.isArray(d.data) && d.data.length <= 50); data.push(...d.data);
    if (d.next_cursor === null) return data;
    assert(typeof d.next_cursor === 'string' && d.data.length > 0 && !seen.has(d.next_cursor));
    seen.add(d.next_cursor); cursor = d.next_cursor;
  }
  throw Error('Full page budget exhausted');
}
async function capture(prior: Row) {
  await client!.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client!.query("SET LOCAL TimeZone='UTC'");
    const names: string[] = (await client!.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND(table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY 1")).rows.map(r => r.table_name);
    assert(Object.keys(prior.tables).every(n => names.includes(n)));
    const rows: Record<string, Row[]> = {}, snapshot: Record<string, Fingerprint> = {}, earlier: Record<string, Fingerprint> = {}, globalCatalog: Record<string, Row[]> = {};
    for (const name of names) {
      assert.match(name, /^[a-z][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      rows[name] = (await client!.query(`SELECT to_jsonb(x) row FROM "${name}" x WHERE "${key}"=$1 ORDER BY 1`, [name === 'users' ? actor.user_id : actor.tenant_id])).rows;
      snapshot[name] = { count: rows[name].length, sha256: fp(rows[name]) };
      if (prior.tables[name]) {
        const cols: string[] = prior.columns[name]; assert(Array.isArray(cols) && cols.length > 0);
        for (const col of cols) assert.match(col, /^[a-z][a-z0-9_]*$/);
        const old = (await client!.query(`SELECT to_jsonb(x) row FROM (SELECT ${cols.map(c => '"' + c + '"').join(',')} FROM "${name}" WHERE "${key}"=ANY($1::uuid[])) x ORDER BY 1`, [name === 'users' ? prior.users : prior.tenants])).rows;
        earlier[name] = { count: old.length, sha256: fp(old) };
        assert.deepEqual(earlier[name], prior.tables[name], 'Earlier old-column projection');
      }
    }
    for (const name of catalogTables) { assert(rows[name]); globalCatalog[name] = (await client!.query(`SELECT to_jsonb(x) row FROM "${name}" x ORDER BY 1`)).rows; }
    assert.equal((await client!.query('SELECT product_catalog_guards() ok')).rows[0].ok, true);
    const tableSecurity = (await client!.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,has_table_privilege('dyna_app',c.oid,'SELECT') app_select,has_table_privilege('dyna_app',c.oid,'INSERT,UPDATE,DELETE') app_write,EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0 AND a.privilege_type IN('SELECT','INSERT','UPDATE','DELETE')) public_access FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY 1", [catalogTables])).rows;
    assert.equal(tableSecurity.length, 7);
    for (const t of tableSecurity) { assert(t.relrowsecurity && t.relforcerowsecurity); assert.equal(t.app_select, false); assert.equal(t.app_write, false); assert.equal(t.public_access, false); }
    const functions = (await client!.query("SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,has_function_privilege('dyna_app',p.oid,'EXECUTE') app_execute,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'product_catalog_%' ORDER BY 1")).rows;
    for (const f of functions) assert.equal(f.public_execute, false);
    const constraints = (await client!.query("SELECT c.relname table_name,k.conname,pg_get_constraintdef(k.oid,true) definition,k.convalidated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY 1,2", [catalogTables])).rows;
    const triggers = (await client!.query("SELECT c.relname table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND(t.tgfoid IN(SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'product_catalog_%') OR c.relname=ANY($1::text[])) ORDER BY 1,2", [catalogTables])).rows;
    const policies = (await client!.query("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY 1,2", [catalogTables])).rows;
    const columns = (await client!.query("SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY 1,2", [catalogTables])).rows;
    await client!.query('COMMIT');
    return { rows, snapshot, earlier, global_catalog_rows: globalCatalog, catalog_schema: { tableSecurity, functions, constraints, triggers, policies, columns } };
  } finally { await client!.query('ROLLBACK').catch(() => {}); }
}
async function apiProof(expected: Row, current: Row) {
  const me = await get('/auth/me'); assert.equal(me.user.id, actor.user_id); assert.equal(me.user.tenant_id, actor.tenant_id); assert.equal(me.user.role, 'admin');
  const options = await get('/product-catalogs/options', true), catalogs = await paged('/product-catalogs');
  const history = await paged('/product-catalogs/previews?kind=operation');
  const previews = await paged('/product-catalogs/previews?kind=preview');
  assert.equal(new Set(catalogs.map(c => c.id)).size, catalogs.length);
  assert.deepEqual(catalogs.map(c => c.id).sort(), current.rows.product_catalogs.map((r: Row) => r.row.id).sort());
  assert.deepEqual(history.map(o => o.id).sort(), current.rows.product_catalog_operations.map((r: Row) => r.row.id).sort());
  assert.deepEqual(previews.map(p => p.id).sort(), current.rows.product_catalog_previews.map((r: Row) => r.row.id).sort());
  const detail: Row[] = [], operations: Row[] = [], products: Row[] = [], orders: Row[] = [], returns: Row[] = [];
  for (const c of expected.catalogs) { const d = await get('/product-catalogs/' + uuid(c.id), true); assert.equal(d.catalog.id, c.id); assert.deepEqual(d.catalog.settings, c.settings); detail.push(d); }
  for (const id of expected.operation_ids) {
    const d = await get('/product-catalogs/operations/' + uuid(id), true);
    const native = current.rows.product_catalog_operations.find((r: Row) => r.row.id === id)?.row; assert(native);
    assert.equal(d.operation.id, id); assert.equal(d.operation.preview_id, native.preview_id);
    assert.equal(d.operation.catalog_id, native.catalog_id);
    assert.deepEqual(d.operation.after.settings, native.payload.after.settings);
    const p = await get('/product-catalogs/previews/' + uuid(native.preview_id), true);
    assert.equal(p.preview.operation_id, id); operations.push({ operation: d, preview: p });
  }
  for (const p of expected.products) { const d = await get('/products/' + uuid(p.id)); assert.equal(d.id, p.id); assert.equal(d.catalog_id, uuid(p.catalog_id)); products.push(d); }
  for (const id of expected.order_ids) { const d = await get('/orders/' + uuid(id)); assert.equal(d.id, id); orders.push(d); }
  for (const id of expected.return_ids) { const d = await get('/returns/' + uuid(id)); assert.equal(d.id, id); returns.push(d); }
  return { options, catalogs, history, previews, detail, operations, products, orders, returns };
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert.equal(process.argv.length, 3);
  assert(['after-commerce', 'after-restart', 'after-recovery-restart', 'after-restore-api'].includes(phase));
  assert.match(revision, /^[a-f0-9]{40}$/); assert.match(schema, /^\d{3}_[a-z0-9_]+$/);
  assert.equal(process.env.APP_REVISION, revision); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert(!process.env.DYNA_TEST); assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(ROOT, '.local.json'));
  assert.equal(process.env.QA157_CHECKPOINT_CONFIRM, 'READ_ONLY_OWN_CATALOG_AND_EARLIER_PRESERVATION');
  for (const dir of ['data', 'docs']) { const s = await lstat(resolve(ROOT, dir)); assert(s.isDirectory() && !s.isSymbolicLink()); }
  const out = resolve(ROOT, `data/product-catalogs-checkpoint157-${phase}.json`), report = resolve(ROOT, `docs/product-catalogs-native157-${phase}.json`);
  await absent(out); await absent(report);
  const setupBytes = await regular(resolve(ROOT, 'data/product-catalogs-stage157.json'), 0o600);
  assert.equal(sha(setupBytes), process.env.QA157_SETUP_SHA256);
  const setup: Row = JSON.parse(setupBytes.toString()); assert.equal(setup.stage, 157); assert.equal(setup.schema_revision, '142_product_catalogs'); assert.equal(setup.complete, true); assert.equal(setup.pending, null);
  actor = setup.actor; uuid(actor.tenant_id); uuid(actor.user_id); cookie = actor.cookie;
  assert(typeof cookie === 'string' && cookie.startsWith('dyna_session='));
  const expectedPath = ownPath(process.env.QA157_EXPECTATIONS_PATH ?? ''), expectedBytes = await regular(expectedPath, 0o600);
  assert.equal(sha(expectedBytes), process.env.QA157_EXPECTATIONS_SHA256);
  const expected: Row = JSON.parse(expectedBytes.toString());
  assert.equal(expected.stage, 157); assert.equal(expected.tenant_id, actor.tenant_id);
  for (const name of ['catalogs', 'products', 'operation_ids', 'order_ids', 'return_ids']) assert(Array.isArray(expected[name]) && expected[name].length <= 2000);
  assert(expected.catalogs.length >= 2 && expected.operation_ids.length > 0); assert(expected.expected_counts && typeof expected.expected_counts === 'object');
  const baselineFile = resolve(WT, 'docs/product-catalogs-preservation157-before.json');
  const baselineBytes = await regular(baselineFile), baseline: Row = JSON.parse(baselineBytes.toString());
  assert.equal(baseline.stage, 157); assert.equal(baseline.phase, 'before'); assert.equal(baseline.status, 'PRESERVATION_PASS'); assert.equal(baseline.tenants.length, 162); assert(!baseline.tenants.includes(actor.tenant_id));
  const configBytes = await regular(resolve(ROOT, '.local.json'), 0o600, 65536);
  assert.equal(sha(configBytes), baseline.config.sha256);
  for (const [name, f] of Object.entries(baseline.private_files) as [string, Row][]) {
    assert.match(name, /^[A-Za-z0-9_.-]+\.json$/); const b = await regular(resolve(ROOT, 'data', name));
    assert.equal(sha(b), f.sha256); assert.equal((await lstat(resolve(ROOT, 'data', name))).mode & 0o777, f.mode);
  }
  let database = 'dynaminds', dbConfig: Row = JSON.parse(configBytes.toString());
  if (restored) {
    assert.equal(process.env.DYNA_PREVIEW_PORT, '4196');
    const resultPath = process.env.QA157_RESTORE_RESULT_PATH ?? '';
    assert.equal(resultPath, resolve(resultPath)); assert(resultPath.startsWith(resolve(ROOT, 'data') + '/'));
    assert.equal(basename(resultPath), 'result.json');
    assert.equal(await realpath(dirname(resultPath)), dirname(resultPath), 'Restore directory has no symlink traversal');
    const resultBytes = await regular(resultPath, 0o600, 65536); assert.equal(sha(resultBytes), process.env.QA157_RESTORE_RESULT_SHA256);
    const result: Row = JSON.parse(resultBytes.toString()); assert.equal(result.directory, dirname(resultPath));
    assert.match(basename(result.directory), /^[a-f0-9]{16}$/);
    assert.equal(result.database, 'dynaminds_restore_' + basename(result.directory));
    assert.equal(result.status, 'verified'); assert.equal(result.preview_only, true); assert.equal(result.worker_enabled, false);
    assert.equal(result.row_fingerprints_match, true); assert.equal(result.schema_fingerprint_match, true); assert.equal(result.source, 'dynaminds');
    assert.equal(result.config, resolve(result.directory, 'local-config.json'));
    dbConfig = JSON.parse((await regular(result.config, 0o600, 65536)).toString()); database = result.database;
    const copyAuthBytes = await regular(ownPath(process.env.QA157_RESTORE_AUTH_PATH ?? ''), 0o600, 65536);
    assert.equal(sha(copyAuthBytes), process.env.QA157_RESTORE_AUTH_SHA256);
    const auth: Row = JSON.parse(copyAuthBytes.toString()); assert.equal(auth.tenant_id, actor.tenant_id); assert.equal(auth.user_id, actor.user_id);
    assert(typeof auth.cookie === 'string' && auth.cookie.startsWith('dyna_session_preview_4196=') && auth.cookie !== cookie);
    assert.equal((await request('/auth/me', cookie)).status, 401); cookie = auth.cookie;
  }
  assert.equal(typeof dbConfig.dbPassword, 'string');
  client = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: dbConfig.dbPassword, database }); await client.connect();
  assert.deepEqual((await client.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0], { role: 'postgres', db: database, host: '127.0.0.1', port: 55432 });
  step = 'health'; await health(); step = 'before-reads'; const before = await capture(baseline);
  for (const [name, count] of Object.entries(expected.expected_counts)) { assert(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0); assert.equal(before.snapshot[name]?.count, count, 'Explicit expected own row count'); }
  assert(Array.isArray(expected.native_assertions) && expected.native_assertions.length > 0 && expected.native_assertions.length <= 500);
  for (const a of expected.native_assertions) {
    assert(typeof a.table === 'string' && before.rows[a.table] && a.match && a.expected);
    assert(Object.keys(a.match).length > 0 && Object.keys(a.expected).length > 0);
    const selected = before.rows[a.table].map(r => r.row).filter(r => Object.entries(a.match).every(([k, v]) => fp(r[k]) === fp(v)));
    assert.equal(selected.length, 1, 'Expected single explicit native record');
    for (const [k, v] of Object.entries(a.expected)) assert.deepEqual(selected[0][k], v, 'Explicit native business expectation');
  }
  // The two setup products remain a separate unchanged default-catalog control.
  for (const p of setup.setup_checkpoint.rows.products) {
    assert.deepEqual(before.rows.products.find(r => r.row.id === p.row.id), p, 'Original default product unchanged');
  }
  for (const p of expected.products) assert.equal(before.rows.products.find(r => r.row.id === p.id)?.row.catalog_id, uuid(p.catalog_id));
  const accepted = resolve(ROOT, 'data/product-catalogs-checkpoint157-after-commerce.json');
  if (phase !== 'after-commerce') {
    const b = await regular(accepted, 0o600); assert.equal(sha(b), process.env.QA157_ACCEPTED_SHA256);
    const cp: Row = JSON.parse(b.toString()); assert.equal(cp.status, 'NATIVE_CATALOG_CHECKPOINT_PASS'); assert.equal(cp.phase, 'after-commerce');
    assert.equal(cp.setup_file_sha256, sha(setupBytes)); assert.equal(cp.expectations_sha256, sha(expectedBytes)); assert.equal(cp.preservation_baseline_sha256, sha(baselineBytes));
    assert.deepEqual(before.rows, cp.rows); assert.deepEqual(before.snapshot, cp.snapshot);
    assert.deepEqual(before.global_catalog_rows, cp.global_catalog_rows); assert.deepEqual(before.catalog_schema, cp.catalog_schema);
  }
  step = 'api-reads'; const api = await apiProof(expected, before);
  step = 'after-reads'; const after = await capture(baseline); assert.deepEqual(after, before, 'GETs preserve all observed business and catalog rows'); await health();
  for (const [file, bytes] of inputs) assert((await readFile(file)).equals(bytes), 'Custody unchanged within read operation');
  const cp = { stage: 157, status: 'NATIVE_CATALOG_CHECKPOINT_PASS', phase, revision, schema_revision: schema,
    tenant_id: actor.tenant_id, user_id: actor.user_id, setup_file_sha256: sha(setupBytes), expectations_sha256: sha(expectedBytes), preservation_baseline_sha256: sha(baselineBytes), ...before, api,
    sessions_excluded: true, provider_verified: false, full_goal_complete: false };
  await wx(out, cp, 0o600);
  await wx(report, { stage: 157, status: cp.status, phase, revision, schema_revision: schema,
    own_tables: Object.keys(before.snapshot).length, own_snapshot_sha256: fp(before.snapshot),
    catalog_tables: Object.fromEntries(catalogTables.map(t => [t, before.snapshot[t]])),
    earlier_firms: baseline.tenants.length, earlier_old_tables: Object.keys(before.earlier).length,
    earlier_projection_sha256: fp(before.earlier), private_files_preserved: Object.keys(baseline.private_files).length,
    catalog_schema_sha256: fp(before.catalog_schema), checkpoint_sha256: sha(await readFile(out)),
    api_gets: reads, read_only_api: restored, primary_cookie_rejected: restored, get_business_rows_unchanged: true,
    baseline_rebased: false, sessions_excluded: true, no_helper_mutations: true,
    provider_verified: false, raw_sql_final_pin_verified: false, full_goal_complete: false }, 0o644);
  process.stdout.write('NATIVE_CATALOG_CHECKPOINT_PASS\n');
}
main().catch(() => { process.stderr.write('QA157_CHECKPOINT_FAILED_STEP_' + step + '_PRIVATE_DETAILS_WITHHELD\n'); process.exitCode = 1; }).finally(async () => { await client?.end(); });
