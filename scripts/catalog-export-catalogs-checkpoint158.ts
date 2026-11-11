/** ROOT ONLY. GET metadata + owner UTC REPEATABLE READ READ ONLY.
 * No login, preview, file request, profile write, migration, worker or provider.
 * Original setup157, accepted commerce157 and prior162 custody never rebase.
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
const schema = '143_catalog_export_catalogs';
const restored = phase === 'after-restore' || phase === 'after-restore-chrome';
const port = restored ? (process.env.QA158_RESTORE_PORT ?? '4198') : '4100';
const base = 'http://127.0.0.1:' + port;
const CATALOG_TABLES = ['product_catalogs', 'product_catalog_warehouses', 'product_catalog_price_lists',
  'product_catalog_languages', 'product_catalog_previews', 'product_catalog_operations', 'product_catalog_admissions'];
type Row = Record<string, any>;
type Fingerprint = { count: number; sha256: string };
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => sha(JSON.stringify(v));
const inputs = new Map<string, { sha256: string; mode: number; max: number }>();
let client: pg.Client | undefined, actor: Row, cookie = '', step = 'preflight', reads = 0;
function uuid(v: unknown): string {
  assert(typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v));
  return v;
}
function id(v: string) { assert.match(v, /^[a-z][a-z0-9_]*$/); return '"' + v + '"'; }
async function regular(file: string, mode?: number, max = 256 * 1024 * 1024) {
  const s = await lstat(file);
  assert(s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= max);
  if (mode !== undefined) assert.equal(s.mode & 0o777, mode);
  const bytes = await readFile(file), observed = { sha256: sha(bytes), mode: s.mode & 0o777, max };
  const old = inputs.get(file); if (old) assert.deepEqual(observed, old, 'Input bytes and mode unchanged');
  inputs.set(file, observed); return bytes;
}
async function pinned(file: string, digest: string | undefined, mode: number, max?: number) {
  assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
  const bytes = await regular(file, mode, max); assert.equal(sha(bytes), digest); return bytes;
}
async function absent(file: string) {
  try { await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive output exists; no overwrite or resume');
}
async function wx(file: string, value: unknown, mode: number) {
  const handle = await open(file, 'wx', mode);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
async function request(route: string, prefix = '/api', session = cookie) {
  assert(['/api', '/api/v1'].includes(prefix));
  const path = route.split('?')[0];
  assert(['/health', '/auth/me', '/product-catalogs/options', '/catalog/exports/options', '/products'].includes(path)
    || /^\/products\/[a-f0-9-]{36}$/.test(path), 'Only fixed metadata GET routes');
  assert(!route.includes('://') && !route.includes('#') && !route.startsWith('//'));
  return fetch(base + prefix + route, { method: 'GET', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(20000), headers: session ? { cookie: session, 'X-Workspace-ID': uuid(actor.tenant_id) } : {} });
}
async function get(route: string, prefix = '/api'): Promise<Row> {
  const r = await request(route, prefix); assert.equal(r.status, 200, 'Scoped metadata GET');
  const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length <= 16 * 1024 * 1024);
  reads++; return JSON.parse(bytes.toString('utf8'));
}
async function health() {
  const h = await get('/health');
  assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.restore_preview, restored); assert.equal(h.product_catalogs_available, true);
}
async function catalogSchema142(c: pg.Client) {
  // Exact same named subset as accepted157. New143 functions/trigger belong to
  // catalog_export_*, so they are intentionally compared separately below.
  const tableSecurity = (await c.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
    has_table_privilege('dyna_app',c.oid,'SELECT') app_select,has_table_privilege('dyna_app',c.oid,'INSERT,UPDATE,DELETE') app_write,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0 AND a.privilege_type IN('SELECT','INSERT','UPDATE','DELETE')) public_access
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY 1`, [CATALOG_TABLES])).rows;
  const functions = (await c.query(`SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,
    has_function_privilege('dyna_app',p.oid,'EXECUTE') app_execute,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'product_catalog_%' ORDER BY 1`)).rows;
  const constraints = (await c.query(`SELECT c.relname table_name,k.conname,pg_get_constraintdef(k.oid,true) definition,k.convalidated
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY 1,2`, [CATALOG_TABLES])).rows;
  const triggers = (await c.query(`SELECT c.relname table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace
    AND(t.tgfoid IN(SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'product_catalog_%') OR c.relname=ANY($1::text[])) ORDER BY 1,2`, [CATALOG_TABLES])).rows;
  const policies = (await c.query("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY 1,2", [CATALOG_TABLES])).rows;
  const columns = (await c.query("SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY 1,2", [CATALOG_TABLES])).rows;
  assert.equal(tableSecurity.length, 7);
  for (const t of tableSecurity) { assert(t.relrowsecurity && t.relforcerowsecurity); assert.equal(t.app_select, false); assert.equal(t.app_write, false); assert.equal(t.public_access, false); }
  assert(functions.length > 0); for (const f of functions) assert.equal(f.public_execute, false);
  return { tableSecurity, functions, constraints, triggers, policies, columns };
}
async function capture(prior: Row, accepted: Row) {
  const c = client!; await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    const names: string[] = (await c.query(`SELECT table_name FROM information_schema.tables t
      WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions'
      AND(table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY 1`)).rows.map(r => r.table_name);
    assert.deepEqual(names, Object.keys(accepted.rows).sort(), '143 adds no business tables');
    const rows: Record<string, Row[]> = {}, snapshot: Record<string, Fingerprint> = {}, earlier: Record<string, Fingerprint> = {}, globalCatalog: Record<string, Row[]> = {};
    for (const name of names) {
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      rows[name] = (await c.query(`SELECT to_jsonb(x) row FROM ${id(name)} x WHERE ${id(key)}=$1 ORDER BY 1`, [name === 'users' ? actor.user_id : actor.tenant_id])).rows;
      snapshot[name] = { count: rows[name].length, sha256: fp(rows[name]) };
      if (prior.tables[name]) {
        const columns: string[] = prior.columns[name]; assert(Array.isArray(columns) && columns.length > 0);
        const old = (await c.query(`SELECT to_jsonb(x) row FROM (SELECT ${columns.map(id).join(',')} FROM ${id(name)} WHERE ${id(key)}=ANY($1::uuid[])) x ORDER BY 1`, [name === 'users' ? prior.users : prior.tenants])).rows;
        earlier[name] = { count: old.length, sha256: fp(old) };
        assert.deepEqual(earlier[name], prior.tables[name], 'Earlier old-column business projection');
      }
    }
    assert.equal(Object.keys(earlier).length, 413);
    assert.deepEqual(rows, accepted.rows, 'All own commerce, financial, WMS, audit and catalog rows remain accepted157');
    assert.deepEqual(snapshot, accepted.snapshot);
    for (const name of CATALOG_TABLES) globalCatalog[name] = (await c.query(`SELECT to_jsonb(x) row FROM ${id(name)} x ORDER BY 1`)).rows;
    assert.deepEqual(globalCatalog, accepted.global_catalog_rows, 'All firms142 catalog rows remain exact');
    assert.equal((await c.query('SELECT product_catalog_guards() ok,catalog_export_catalogs_guards() export_ok')).rows[0].ok, true);
    assert.equal((await c.query('SELECT catalog_export_catalogs_guards() ok')).rows[0].ok, true);
    const catalogSchema = await catalogSchema142(c); assert.deepEqual(catalogSchema, accepted.catalog_schema, 'Unchanged142 schema subset');
    const exportFunctions = (await c.query(`SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,r.rolname owner,
      has_function_privilege('dyna_app',p.oid,'EXECUTE') app_execute,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.pronamespace='public'::regnamespace
      AND(p.proname LIKE 'catalog_export_catalogs_%' OR p.proname='catalog_export_profile_definition_valid') ORDER BY 1`)).rows;
    assert.equal(exportFunctions.length, 4);
    for (const f of exportFunctions) { assert.equal(f.public_execute, false); assert.equal(f.app_execute, f.signature !== 'catalog_export_catalogs_profile_guard()'); }
    const exportTriggers = (await c.query(`SELECT t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t
      WHERE t.tgrelid='catalog_export_profiles'::regclass AND t.tgname='catalog_export_catalogs_profile_guard' AND NOT t.tgisinternal`)).rows;
    assert.equal(exportTriggers.length, 1); assert.equal(exportTriggers[0].tgenabled, 'O');
    await c.query('COMMIT');
    return { rows, snapshot, earlier, global_catalog_rows: globalCatalog, catalog_schema142: catalogSchema,
      export_schema143: { functions: exportFunctions, triggers: exportTriggers } };
  } finally { await c.query('ROLLBACK').catch(() => undefined); }
}
async function apiProof(current: Row) {
  const proof: Row[] = [];
  // auth/me has only the ordinary route; public metadata is also cloned to v1.
  const me = await get('/auth/me', '/api');
  assert.equal(me.user.id, actor.user_id); assert.equal(me.user.tenant_id, actor.tenant_id); assert.equal(me.user.role, 'admin');
  for (const prefix of ['/api', '/api/v1']) {
    const catalogs = await get('/product-catalogs/options', prefix);
    assert.equal(catalogs.available, true); assert.equal(catalogs.can_read, true); assert.equal(catalogs.current_role, 'admin');
    assert.equal(catalogs.read_only, restored); assert.equal(catalogs.can_manage, !restored);
    assert.equal(catalogs.catalogs.length, 2); assert.equal(catalogs.catalogs.filter((h: Row) => h.is_default).length, 1);
    const list = await get('/products?limit=50', prefix);
    assert.equal(list.data.length, 4); assert.equal(list.meta.cursor, null);
    assert.deepEqual(list.data.map((p: Row) => p.id).sort(), current.rows.products.map((r: Row) => r.row.id).sort());
    const options: Row[] = [], products: Row[] = [];
    for (const head of catalogs.catalogs) {
      const native = current.rows.product_catalogs.find((r: Row) => r.row.id === head.id)?.row; assert(native);
      assert.equal(head.name, native.name); assert.equal(head.active, true); assert.equal(head.version, String(native.version));
      const wh = current.rows.product_catalog_warehouses.filter((r: Row) => r.row.catalog_id === head.id).map((r: Row) => r.row.warehouse_id).sort();
      const prices = current.rows.product_catalog_price_lists.filter((r: Row) => r.row.catalog_id === head.id).map((r: Row) => r.row.price_list_id).sort();
      assert.deepEqual(head.warehouse_ids, wh); assert.deepEqual(head.price_list_ids, prices);
      const selected = await get('/catalog/exports/options?catalog_id=' + uuid(head.id), prefix);
      assert.equal(selected.available, true); assert.equal(selected.catalog_available, true); assert.equal(selected.current_role, 'admin');
      assert.equal(selected.can_read, true); assert.equal(selected.read_only, restored); assert.equal(selected.catalog.id, head.id);
      assert.equal(selected.catalog.version, head.version); assert.equal(selected.count.capped, false);
      const source = current.rows.products.filter((r: Row) => r.row.catalog_id === head.id);
      assert.equal(selected.count.matched_products, source.length);
      assert.deepEqual(selected.sources.warehouses.data.map((r: Row) => r.id).sort(), wh);
      assert.deepEqual(selected.sources.price_lists.data.map((r: Row) => r.id).sort(), prices);
      assert.equal(selected.sources.allow_inventory, true);
      assert.equal(selected.sources.warehouses.capped, false); assert.equal(selected.sources.price_lists.capped, false);
      options.push(selected);
      const scoped = await get('/products?limit=50&catalog_id=' + uuid(head.id), prefix);
      assert.equal(scoped.meta.cursor, null); assert.deepEqual(scoped.data.map((p: Row) => p.id).sort(), source.map((r: Row) => r.row.id).sort());
      for (const p of source) {
        const detail = await get('/products/' + uuid(p.row.id), prefix);
        assert.equal(detail.id, p.row.id); assert.equal(detail.catalog_id, head.id);
        assert.equal(detail.sku, p.row.sku); assert.equal(detail.name, p.row.name); assert.equal(detail.price, p.row.price);
        products.push(detail);
      }
    }
    const legacy = await get('/catalog/exports/options', prefix);
    assert.equal(legacy.catalog_available, true); assert.equal(legacy.catalog, null); assert.equal(legacy.count.matched_products, 4);
    assert.equal(legacy.read_only, restored);
    proof.push({ prefix, me, catalogs, list, options, products, legacy });
  }
  return proof;
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert.equal(await realpath(ROOT), ROOT); assert.equal(process.argv.length, 3);
  assert(['before-native', 'after-reads', 'after-restart', 'after-restart-chrome', 'after-restore', 'after-restore-chrome'].includes(phase));
  assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION, revision);
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert(!process.env.DYNA_TEST);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(ROOT, '.local.json'));
  assert.equal(process.env.QA158_CHECKPOINT_CONFIRM, 'READ_ONLY_ACCEPTED157_AND_EARLIER162');
  if (restored) { assert(['4196', '4198'].includes(port)); assert.equal(process.env.DYNA_PREVIEW_PORT, port); }
  for (const name of ['data', 'docs']) { const path = resolve(ROOT, name), s = await lstat(path); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(path), path); }
  const output = resolve(ROOT, 'data/catalog-export-catalogs-checkpoint158-' + phase + '.json');
  const report = resolve(ROOT, 'docs/catalog-export-catalogs-native158-' + phase + '.json');
  await absent(output); await absent(report);
  const setupBytes = await pinned(resolve(ROOT, 'data/product-catalogs-stage157.json'), process.env.QA157_SETUP_SHA256, 0o600);
  const setup: Row = JSON.parse(setupBytes.toString());
  assert.equal(setup.stage, 157); assert.equal(setup.complete, true); assert.equal(setup.pending, null); assert.equal(setup.schema_revision, '142_product_catalogs');
  actor = setup.actor; uuid(actor.tenant_id); uuid(actor.user_id); cookie = actor.cookie;
  assert(typeof cookie === 'string' && cookie.startsWith('dyna_session='));
  const acceptedBytes = await pinned(resolve(ROOT, 'data/product-catalogs-checkpoint157-after-commerce.json'), process.env.QA157_ACCEPTED_SHA256, 0o600);
  const accepted: Row = JSON.parse(acceptedBytes.toString());
  assert.equal(accepted.stage, 157); assert.equal(accepted.phase, 'after-commerce'); assert.equal(accepted.status, 'NATIVE_CATALOG_CHECKPOINT_PASS');
  assert.equal(accepted.schema_revision, '142_product_catalogs'); assert.equal(accepted.tenant_id, actor.tenant_id); assert.equal(accepted.user_id, actor.user_id);
  assert.equal(accepted.setup_file_sha256, sha(setupBytes)); assert.equal(Object.keys(accepted.rows).length, 420); assert.equal(accepted.rows.products.length, 4);
  const priorBytes = await pinned(resolve(WT, 'docs/product-catalogs-preservation157-before.json'), process.env.QA157_PRESERVATION_SHA256, 0o644);
  const prior: Row = JSON.parse(priorBytes.toString());
  assert.equal(prior.stage, 157); assert.equal(prior.phase, 'before'); assert.equal(prior.status, 'PRESERVATION_PASS');
  assert.equal(prior.tenants.length, 162); assert.equal(Object.keys(prior.tables).length, 413); assert.equal(Object.keys(prior.private_files).length, 366);
  assert(!prior.tenants.includes(actor.tenant_id)); assert.equal(accepted.preservation_baseline_sha256, sha(priorBytes));
  const configBytes = await regular(resolve(ROOT, '.local.json'), 0o600, 65536); assert.equal(sha(configBytes), prior.config.sha256);
  for (const [name, entry] of Object.entries(prior.private_files) as [string, Row][]) {
    assert.match(name, /^[A-Za-z0-9_.-]+\.json$/); const bytes = await regular(resolve(ROOT, 'data', name), entry.mode); assert.equal(sha(bytes), entry.sha256);
  }
  let config: Row = JSON.parse(configBytes.toString()), database = 'dynaminds';
  if (restored) {
    const resultPath = process.env.QA158_RESTORE_RESULT_PATH ?? '';
    assert.equal(resultPath, resolve(resultPath)); assert(resultPath.startsWith(resolve(ROOT, 'data') + '/')); assert.equal(basename(resultPath), 'result.json');
    assert.equal(await realpath(dirname(resultPath)), dirname(resultPath));
    const result: Row = JSON.parse((await pinned(resultPath, process.env.QA158_RESTORE_RESULT_SHA256, 0o600, 65536)).toString());
    assert.equal(result.directory, dirname(resultPath)); assert.match(basename(result.directory), /^[a-f0-9]{16}$/);
    assert.equal(result.database, 'dynaminds_restore_' + basename(result.directory)); assert.equal(result.source, 'dynaminds');
    assert.equal(result.status, 'verified'); assert.equal(result.preview_only, true); assert.equal(result.worker_enabled, false);
    assert.equal(result.row_fingerprints_match, true); assert.equal(result.schema_fingerprint_match, true);
    assert.equal(result.config, resolve(result.directory, 'local-config.json'));
    config = JSON.parse((await regular(result.config, 0o600, 65536)).toString()); database = result.database;
    const authPath = resolve(ROOT, 'data/catalog-export-catalogs-restore-auth158.json');
    const auth: Row = JSON.parse((await pinned(authPath, process.env.QA158_RESTORE_AUTH_SHA256, 0o600, 65536)).toString());
    assert.equal(auth.stage, 158); assert.equal(auth.tenant_id, actor.tenant_id); assert.equal(auth.user_id, actor.user_id); assert.equal(String(auth.port), port);
    assert(typeof auth.cookie === 'string' && auth.cookie.startsWith('dyna_session_preview_' + port + '=') && auth.cookie !== cookie);
    assert.equal((await request('/auth/me', '/api', cookie)).status, 401); cookie = auth.cookie;
  }
  if (process.env.DATABASE_URL) {
    const db = new URL(process.env.DATABASE_URL); assert.equal(db.hostname, '127.0.0.1'); assert.equal(db.port, '55432'); assert.equal(db.pathname, '/' + database); assert.equal(db.username, 'postgres');
  }
  assert.equal(typeof config.dbPassword, 'string');
  client = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: config.dbPassword, database }); await client.connect();
  assert.deepEqual((await client.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0], { role: 'postgres', db: database, host: '127.0.0.1', port: 55432 });
  step = 'health'; await health(); step = 'before-get'; const before = await capture(prior, accepted);
  for (const product of setup.setup_checkpoint.rows.products) assert.deepEqual(before.rows.products.find(r => r.row.id === product.row.id), product, 'Original setup default products unchanged');
  if (phase !== 'before-native') {
    const firstBytes = await pinned(resolve(ROOT, 'data/catalog-export-catalogs-checkpoint158-before-native.json'), process.env.QA158_BEFORE_SHA256, 0o600);
    const first: Row = JSON.parse(firstBytes.toString());
    assert.equal(first.stage, 158); assert.equal(first.phase, 'before-native'); assert.equal(first.status, 'READ_ONLY_CATALOG_EXPORT_CHECKPOINT_PASS');
    assert.equal(first.schema_revision, schema); assert.equal(first.setup_file_sha256, sha(setupBytes)); assert.equal(first.accepted157_sha256, sha(acceptedBytes));
    assert.equal(first.preservation157_sha256, sha(priorBytes)); assert.equal(first.tenant_id, actor.tenant_id); assert.equal(first.user_id, actor.user_id);
    assert.deepEqual(before, first.capture, 'Exact first143 read baseline, without rebasing157');
  }
  step = 'api-metadata'; const api = await apiProof(before);
  step = 'after-get'; const after = await capture(prior, accepted); assert.deepEqual(after, before, 'All GET metadata leaves all business/catalog rows exact'); await health();
  step = 'custody';
  for (const [file, expected] of inputs) { const bytes = await regular(file, expected.mode, expected.max); assert.equal(sha(bytes), expected.sha256); }
  const checkpoint = { stage: 158, status: 'READ_ONLY_CATALOG_EXPORT_CHECKPOINT_PASS', phase, revision, schema_revision: schema,
    tenant_id: actor.tenant_id, user_id: actor.user_id, setup_file_sha256: sha(setupBytes), accepted157_sha256: sha(acceptedBytes),
    preservation157_sha256: sha(priorBytes), capture: before, api, sessions_excluded: true, no_helper_mutations: true, baseline_rebased: false };
  await wx(output, checkpoint, 0o600);
  await wx(report, { stage: 158, status: checkpoint.status, phase, revision, schema_revision: schema,
    own_tables: Object.keys(before.snapshot).length, own_snapshot_sha256: fp(before.snapshot),
    own_products: before.rows.products.length, catalog_tables: Object.fromEntries(CATALOG_TABLES.map(name => [name, before.snapshot[name]])),
    global_catalog_rows_sha256: fp(before.global_catalog_rows), schema142_subset_sha256: fp(before.catalog_schema142), schema143_subset_sha256: fp(before.export_schema143),
    earlier_firms: 162, earlier_old_tables: 413, earlier_projection_sha256: fp(before.earlier), private_files_preserved: 366, config_preserved: true,
    setup157_sha256: sha(setupBytes), accepted157_sha256: sha(acceptedBytes), preservation157_sha256: sha(priorBytes), checkpoint_sha256: sha(await readFile(output)),
    api_gets: reads, metadata_prefixes: ['/api', '/api/v1'], restored, primary_cookie_rejected: restored,
    get_business_rows_unchanged: true, no_helper_mutations: true, baseline_rebased: false, sessions_excluded: true,
    file_bytes_verified: false, preview_verified: false, profile_writes_verified: false, provider_verified: false,
    raw_sql_final_pin_verified: false, scale_verified: false, full_goal_complete: false }, 0o644);
  process.stdout.write('READ_ONLY_CATALOG_EXPORT_CHECKPOINT_PASS\n');
}
main().catch((error: unknown) => {
  const stack = error instanceof Error ? error.stack ?? '' : '';
  const line = stack.match(/catalog-export-catalogs-checkpoint158\.ts:(\d+):(\d+)/);
  process.stderr.write(JSON.stringify({ status: 'QA158_READ_CHECKPOINT_FAILED', step,
    ...(line ? { source_line: Number(line[1]), source_column: Number(line[2]) } : {}), private_details_withheld: true }) + '\n');
  process.exitCode = 1;
}).finally(async () => { await client?.end(); });
