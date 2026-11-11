/** ROOT ONLY; SOURCE AUTHORED. Read-only BEFORE147 / immediate AFTER148.
 * No app/db imports, migration, login, POST, worker, provider or backup.
 * cwd=primary app; DYNA_LOCAL_CONFIG_PATH=<primary>/.local.json,
 * DYNA_WORKER_DISABLED=true, APP_REVISION=QA_EXPECTED_REVISION=<40hex>,
 * QA162_CHECKPOINT_CONFIRM=READ_ONLY_GLOBAL_147_TO_148_EXACT,
 * QA162_CONFIG_SHA256=<config bytes hash>.
 * after additionally requires QA162_BEFORE_SHA256 and QA162_SQL_SHA256.
 * Outputs data/return-destinations-native162-{before,after}.json (wx0600)
 * and docs/return-destinations-native162-{before,after}.json (wx0600).
 * No resumption/overwrite. Preserve before forever; after compares sessions too.
 * Only the two literal live/restart stdout/stderr logs below are outside file
 * custody; every other regular data file (including historical logs) is pinned.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

type Row = Record<string, any>;
type Capture = { rows: Record<string, Row[]>; metadata: { functions: Row[]; triggers: Row[]; tables: Row[]; relations: Row[] }; files: Record<string, { sha256: string; mode: number; size: number }> };
const ROOT = '<workspace>/app';
const phase = process.argv[2];
const configPath = resolve(ROOT, '.local.json');
const beforePath = resolve(ROOT, 'data/return-destinations-native162-before.json');
const output = resolve(ROOT, `data/return-destinations-native162-${phase}.json`);
const publicOutput = resolve(ROOT, `docs/return-destinations-native162-${phase}.json`);
const excludedLiveFiles = [
  { path: 'data/return-destinations-native161-runtime-dev.private.log', reason: 'Active native runtime stdout/stderr can grow during reads and restart.' },
  { path: 'data/return-destinations-native162-runtime-dev.private.log', reason: 'Planned native restart stdout/stderr is created and grows during restart.' },
];
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => sha(JSON.stringify(v));
const identifier = (v: string) => { assert.match(v, /^[a-z][a-z0-9_]*$/); return '"' + v + '"'; };
const sidecars = ['return_destination_parts', 'return_destination_arrivals', 'return_destination_fragments', 'return_destination_admissions'];
const changed = ['return_assistant_budget()', 'return_assistant_prepare(uuid,uuid,jsonb,uuid,uuid)',
  'return_assistant_physical_validate(return_assistant_admissions)', 'return_assistant_complete()',
  'return_assistant_finish(uuid,uuid,uuid)', 'wms_fragment_consistency()', 'wms_validate_operation_scope(uuid,uuid)',
  'b2b_return_local_finish(uuid)', 'order_parcel_return_validate_receive(uuid,uuid,uuid,jsonb,jsonb)',
  'order_parcel_return_validate_physical(order_parcel_return_admissions)'];
const seals = ['return_cases', 'return_items', 'return_assistant_sessions', 'return_assistant_photos', 'orders',
  'order_items', 'payment_entries', 'documents', 'packing_stations', 'wms_policies', 'stock_movements',
  'wms_return_fragments', 'stock', 'stock_locations', 'stock_location_movements', 'wms_layer_positions',
  'wms_layer_movements', 'wms_cost_layers', 'wms_lots', 'wms_issue_fragments', 'wms_operations', 'reservations',
  'reservation_locations', 'wms_reservation_layers', 'shipments', 'order_parcel_dispatches', 'order_parcel_releases',
  'order_parcel_return_claims', 'order_parcel_commercial_origins', 'order_parcel_origin_fragments',
  'return_destination_statuses', 'return_destination_status_revisions', 'warehouse_inventory_policies',
  'warehouses', 'products', 'product_catalog_warehouses'];
const witnesses = ['stock_movements', 'stock_location_movements', 'wms_return_fragments', 'wms_layer_movements', 'wms_operations'];
const helpers = ['identity(uuid,text)', 'installed()', 'number(jsonb,boolean)', 'request_valid(jsonb)',
  'physical_validate(uuid)', 'require(uuid,uuid,boolean,boolean)', 'source(uuid,uuid,uuid,uuid)',
  'frame(uuid,jsonb,uuid,uuid)', 'lock(uuid,uuid,jsonb,uuid,uuid)', 'extra_budget(bigint,uuid)', 'budget()',
  'seal()', 'snapshot(uuid)', 'resources(uuid,jsonb,uuid,uuid)', 'preview(uuid,uuid,jsonb,uuid,uuid)',
  'prepare(uuid,uuid,jsonb,uuid,uuid)', 'admission_scope(uuid,uuid,uuid,uuid)', 'certificate(uuid)',
  'parcel_payload(uuid,jsonb)', 'legacy_scope(uuid,uuid,uuid,jsonb)', 'validate_parcel(uuid,uuid,uuid,jsonb,jsonb)',
  'finish(uuid,uuid,uuid)', 'record_guard()', 'witness()', 'complete()', 'plan(jsonb,jsonb)', 'guards()']
  .map(s => 'return_destination_' + s);
let step = 'preflight';
let filePathSha256: string | null = null;
let c: pg.Client | undefined;

async function privateRead(path: string, max: number) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600);
  assert(s.size > 0 && s.size <= max); return readFile(path);
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive custody already exists');
}
async function fixedDirectory(path: string) {
  const stat = await lstat(path); assert(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(path), path);
}
async function wx(path: string, value: unknown) {
  await fixedDirectory(dirname(path));
  const bytes = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(bytes) <= 512 * 1024 * 1024);
  const f = await open(path, 'wx', 0o600);
  try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); }
  return sha(bytes);
}
async function files() {
  step = 'files-root';
  await fixedDirectory(resolve(ROOT, 'data'));
  const out: Capture['files'] = {};
  async function file(path: string, key: string) {
    filePathSha256 = sha(key); step = 'files-regular';
    const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink());
    step = 'files-size';
    assert(Number.isSafeInteger(stat.size) && stat.size >= 0);
    const stable = (next: typeof stat) => {
      assert(next.isFile() && !next.isSymbolicLink());
      assert.equal(next.size, stat.size); assert.equal(next.mtimeMs, stat.mtimeMs);
      assert.equal(next.dev, stat.dev); assert.equal(next.ino, stat.ino);
      assert.equal(next.mode, stat.mode);
    };
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let digest: string;
    try {
      step = 'files-open-stable'; stable(await handle.stat());
      step = 'files-stream'; const hash = createHash('sha256'); let bytesRead = 0;
      const stream = createReadStream(path, { fd: handle.fd, autoClose: false });
      for await (const chunk of stream) { hash.update(chunk); bytesRead += chunk.length; }
      step = 'files-stable'; assert.equal(bytesRead, stat.size);
      stable(await handle.stat()); stable(await lstat(path)); digest = hash.digest('hex');
    } finally { await handle.close(); }
    out[key] = { sha256: digest, mode: stat.mode & 0o777, size: stat.size };
  }
  await file(configPath, '.local.json');
  async function visit(directory: string, prefix: string) {
    step = 'files-directory'; filePathSha256 = sha(prefix);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      // Native PG/backup/restore/runtime directories are not application file
      // custody. ALL regular files elsewhere are pinned, not only extensions.
      if (['postgres', 'pg', 'backups', 'restores', 'ollama-runtime'].includes(entry.name)) continue;
      const key = prefix + entry.name, path = resolve(directory, entry.name);
      if (key === 'data/return-destinations-native162-before.json' || key === 'data/return-destinations-native162-after.json') continue;
      step = 'files-entry'; filePathSha256 = sha(key); assert(!entry.isSymbolicLink());
      if (excludedLiveFiles.some(file => file.path === key)) { assert(entry.isFile()); continue; }
      if (entry.isDirectory()) await visit(path, key + '/'); else { assert(entry.isFile()); await file(path, key); }
    }
  }
  await visit(resolve(ROOT, 'data'), 'data/'); filePathSha256 = null; return out;
}
async function health(schema: string, configBytes: Buffer) {
  assert.equal(sha(await privateRead(configPath, 65536)), sha(configBytes));
  const r = await fetch('http://127.0.0.1:4100/api/health', { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200); const raw = Buffer.from(await r.arrayBuffer()); assert(raw.length < 65536);
  const h = JSON.parse(raw.toString('utf8')) as Row;
  assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local'); assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false); assert.equal(h.revision, revision); assert.equal(h.schema_revision, schema);
  assert.equal(h.warehouse_inventory_policies_available, true); assert.equal(h.return_destination_statuses_available, true);
  assert.equal(h.return_destinations_available, phase === 'after'); return { revision: h.revision, schema_revision: h.schema_revision };
}
async function capture(client: pg.Client): Promise<Capture> {
  step = 'capture-begin';
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await client.query("SET LOCAL TimeZone='UTC'");
  try {
    step = 'capture-identity';
    const identity = (await client.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0];
    step = 'capture-identity-database'; assert.equal(identity.db, 'dynaminds');
    step = 'capture-identity-role'; assert.equal(identity.role, 'postgres'); assert.equal(identity.owner, 'postgres');
    step = 'capture-identity-host'; assert.equal(identity.host, '127.0.0.1');
    step = 'capture-identity-port'; assert.equal(identity.port, 55432);
    step = 'capture-identity-readonly'; assert.equal(identity.readonly, 'on');
    const rows: Capture['rows'] = {};
    step = 'capture-rows';
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows;
    for (const { tablename } of tables) rows[tablename] = (await client.query(`SELECT to_jsonb(x) row FROM public.${identifier(tablename)} x ORDER BY 1`)).rows;
    step = 'capture-metadata';
    const metadata = {
      functions: (await client.query(`SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p) meta,pg_get_functiondef(p.oid) definition
        FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN('f','p') ORDER BY p.oid`)).rows,
      triggers: (await client.query(`SELECT t.oid,r.relname,to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition,
        con.conrelid::regclass::text constraint_table,con.contype constraint_type FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
        LEFT JOIN pg_constraint con ON con.oid=t.tgconstraint WHERE r.relnamespace='public'::regnamespace ORDER BY t.oid`)).rows,
      tables: (await client.query(`SELECT c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attnum),'[]') FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) columns,
        (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p WHERE p.polrelid=c.oid) policies,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(x),'definition',pg_get_constraintdef(x.oid,false)) ORDER BY x.oid),'[]') FROM pg_constraint x WHERE x.conrelid=c.oid) constraints,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid),'[]') FROM pg_index i WHERE i.indrelid=c.oid) indexes
        FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.oid`)).rows,
      relations: (await client.query("SELECT oid,relname,relkind,relowner,relacl,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid")).rows,
    };
    step = 'capture-commit'; await client.query('COMMIT');
    step = 'capture-files'; return { rows, metadata, files: await files() };
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; }
}
async function compare(client: pg.Client, old: Capture, now: Capture, sql: string) {
  assert.deepEqual(Object.keys(now.rows).sort(), [...Object.keys(old.rows), ...sidecars].sort());
  for (const [table, rows] of Object.entries(old.rows)) assert.deepEqual(table === 'migrations' ? now.rows[table].filter(r => r.row.name !== '148_return_destinations') : now.rows[table], rows);
  for (const table of sidecars) assert.deepEqual(now.rows[table], []);
  assert.equal(now.rows.migrations.length, old.rows.migrations.length + 1);
  assert.equal(now.rows.migrations.filter(r => r.row.name === '148_return_destinations').length, 1);
  const additions: Row[] = [];
  for (const table of old.metadata.tables) {
    const current = now.metadata.tables.find(r => r.oid === table.oid); assert(current);
    for (const prior of table.constraints) assert.deepEqual(current.constraints.find((r: Row) => r.meta.oid === prior.meta.oid), prior);
    const extra = current.constraints.filter((r: Row) => !table.constraints.some((p: Row) => p.meta.oid === r.meta.oid));
    if (table.relname !== 'return_assistant_receipts') assert.deepEqual(extra, []); additions.push(...extra);
    assert.deepEqual({ ...current, constraints: table.constraints }, table);
  }
  assert.equal(additions.length, 1); const parent = additions[0];
  assert.equal(parent.meta.conname, 'return_destination_parent_complete'); assert.equal(parent.meta.contype, 't');
  assert.equal(String(parent.meta.conrelid), String(old.metadata.tables.find(t => t.relname === 'return_assistant_receipts')!.oid));
  assert.equal(parent.meta.condeferrable, true); assert.equal(parent.meta.condeferred, true); assert.equal(parent.meta.convalidated, true);
  assert.equal(parent.definition, 'TRIGGER DEFERRABLE INITIALLY DEFERRED');
  const patches = sql.match(/FOR patch IN SELECT \* FROM\(VALUES([\s\S]*?)\)v\(signature,needle,replacement\) LOOP/); assert(patches);
  // SELECT of the literal VALUES only; never execute migration/body/DDL.
  const patchRows = (await client.query('SELECT * FROM(VALUES' + patches[1] + ')v(signature,needle,replacement)')).rows;
  assert.deepEqual(patchRows.map(p => p.signature.replace(/^public\./, '')).sort(), [...changed].sort());
  for (const fn of old.metadata.functions) {
    const current = now.metadata.functions.find(r => r.oid === fn.oid); assert(current);
    const patch = patchRows.find(p => p.signature === 'public.' + fn.signature);
    if (!patch) { assert.deepEqual(current, fn); continue; }
    assert.equal(current.signature, fn.signature);
    const priorMeta = { ...fn.meta }, nextMeta = { ...current.meta }; delete priorMeta.prosrc; delete nextMeta.prosrc;
    if (fn.signature === 'wms_fragment_consistency()') {
      assert.equal(priorMeta.prosecdef, false); assert.equal(nextMeta.prosecdef, true);
      assert.deepEqual(nextMeta.proconfig, ['search_path=pg_catalog, public, pg_temp']);
      delete priorMeta.prosecdef; delete nextMeta.prosecdef; delete priorMeta.proconfig; delete nextMeta.proconfig;
    }
    assert.deepEqual(nextMeta, priorMeta); assert.equal(fn.meta.prosrc.split(patch.needle).length, 2);
    let expected = fn.meta.prosrc.replace(patch.needle, patch.replacement);
    if (fn.signature === 'return_assistant_complete()') {
      const anchor = ' PERFORM return_assistant_physical_validate(a);'; assert.equal(expected.split(anchor).length, 2);
      expected = expected.replace(anchor, ' END IF; /* destinations_v1: common financial checks above remain mandatory */\n' + anchor);
    }
    if (['wms_fragment_consistency()', 'wms_validate_operation_scope(uuid,uuid)'].includes(fn.signature))
      expected = expected.replace(/\b(FROM|JOIN)(\s+)(wms_issue_fragments|wms_return_fragments|wms_operations|wms_layer_movements|return_cases|return_items|wms_cost_layers|wms_lots)\b/gi, '$1$2public.$3');
    assert.notEqual(current.meta.prosrc, fn.meta.prosrc); assert.equal(current.meta.prosrc, expected);
  }
  const newFunctions = now.metadata.functions.filter(f => !old.metadata.functions.some(p => p.oid === f.oid));
  assert.deepEqual(newFunctions.map(f => f.signature).sort(), [...helpers].sort());
  for (const prior of old.metadata.triggers) assert.deepEqual(now.metadata.triggers.find(r => r.oid === prior.oid), prior);
  const extra = now.metadata.triggers.filter(t => !old.metadata.triggers.some(p => p.oid === t.oid));
  const expectedUsers = [...sidecars.flatMap(t => [t + ':return_destination_record_guard', t + ':return_destination_complete']),
    ...witnesses.map(t => t + ':return_destination_witness'), ...seals.map(t => t + ':return_destination_seal'), 'return_assistant_receipts:return_destination_parent_complete'];
  assert.equal(expectedUsers.length, 50);
  assert.deepEqual(extra.filter(t => !t.meta.tgisinternal).map(t => t.relname + ':' + t.meta.tgname).sort(), expectedUsers.sort());
  const internal = extra.filter(t => t.meta.tgisinternal); assert.equal(internal.length, 72);
  assert(internal.every(t => t.constraint_type === 'f' && sidecars.includes(t.constraint_table.replace(/^public\./, ''))));
  for (const t of extra.filter(t => !t.meta.tgisinternal)) {
    const role = t.meta.tgname.replace(/^return_destination_/, '');
    const functionName = role === 'parent_complete' ? 'complete' : role;
    assert.equal(String(t.meta.tgfoid), String(newFunctions.find(f => f.signature === 'return_destination_' + functionName + '()')!.oid));
    assert.equal(t.meta.tgenabled, 'O'); assert.equal(t.meta.tgtype, ['complete', 'parent_complete', 'witness'].includes(role) ? 5 : 31);
    assert.equal(t.meta.tgdeferrable, ['complete', 'parent_complete'].includes(role)); assert.equal(t.meta.tginitdeferred, t.meta.tgdeferrable);
  }
  const pt = extra.find(t => t.relname === 'return_assistant_receipts' && t.meta.tgname === 'return_destination_parent_complete'); assert(pt);
  assert.equal(pt.meta.tgconstraint, parent.meta.oid);
  assert.match(pt.definition, /^CREATE CONSTRAINT TRIGGER return_destination_parent_complete AFTER INSERT ON public\.return_assistant_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION (?:public\.)?return_destination_complete\(\)$/);
  for (const prior of old.metadata.relations) assert.deepEqual(now.metadata.relations.find(r => r.oid === prior.oid), prior);
  const newTables = now.metadata.tables.filter(t => !old.metadata.tables.some(p => p.oid === t.oid));
  assert.deepEqual(newTables.map(t => t.relname).sort(), [...sidecars].sort());
  const newRelationOids = new Set(newTables.flatMap(t => [t.oid, ...t.indexes.map((i: Row) => i.meta.indexrelid)]).map(String));
  assert(now.metadata.relations.filter(r => !old.metadata.relations.some(p => p.oid === r.oid)).every(r => newRelationOids.has(String(r.oid))));
  for (const table of sidecars) {
    const acl = (await client.query(`SELECT pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE a.grantee<>c.relowner) other_grants,
      EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl)a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner) column_grants
      FROM pg_class c WHERE c.oid=$1::regclass`, ['public.' + table])).rows[0];
    assert.deepEqual(acl, { owner: 'postgres', relrowsecurity: true, relforcerowsecurity: true, other_grants: false, column_grants: false });
  }
  const acl = (await client.query(`SELECT count(*)::int n FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
    WHERE p.oid=ANY($1::oid[]) AND(a.grantee<>p.proowner OR pg_get_userbyid(p.proowner)<>'postgres')`, [newFunctions.map(f => f.oid)])).rows[0]; assert.equal(acl.n, 0);
  assert.equal((await client.query('SELECT public.return_destination_guards() ok')).rows[0].ok, true);
  assert.deepEqual(now.files, old.files);
}
async function main() {
  assert(['before', 'after'].includes(phase ?? '')); assert.equal(await realpath(process.cwd()), ROOT);
  assert.equal(process.env.DYNA_TEST, undefined); assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, configPath);
  assert.equal(process.env.QA162_CHECKPOINT_CONFIRM, 'READ_ONLY_GLOBAL_147_TO_148_EXACT');
  assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION, revision);
  assert.match(process.env.QA162_CONFIG_SHA256 ?? '', /^[a-f0-9]{64}$/);
  await fixedDirectory(resolve(ROOT, 'data')); await fixedDirectory(resolve(ROOT, 'docs'));
  await absent(output); await absent(publicOutput);
  const configBytes = await privateRead(configPath, 65536); assert.equal(sha(configBytes), process.env.QA162_CONFIG_SHA256);
  const config = JSON.parse(configBytes.toString('utf8')) as Row; assert.equal(typeof config.dbPassword, 'string'); assert(config.dbPassword);
  let basis: Row | undefined, sql = '', sourceSqlSha256: string | null = null;
  if (phase === 'after') {
    assert.match(process.env.QA162_BEFORE_SHA256 ?? '', /^[a-f0-9]{64}$/);
    const bytes = await privateRead(beforePath, 512 * 1024 * 1024); assert.equal(sha(bytes), process.env.QA162_BEFORE_SHA256);
    basis = JSON.parse(bytes.toString('utf8')); assert(basis && basis.stage === 162 && basis.phase === 'before' && basis.status === 'READ_ONLY_CAPTURED');
    assert.equal(basis.schema, '147_return_destination_statuses');
    assert.deepEqual(basis.excluded_live_files, excludedLiveFiles);
    const sqlBytes = await readFile(resolve(ROOT, 'server/148_return_destinations.sql'));
    assert.match(process.env.QA162_SQL_SHA256 ?? '', /^[a-f0-9]{64}$/); assert.equal(sha(sqlBytes), process.env.QA162_SQL_SHA256);
    sql = sqlBytes.toString('utf8'); sourceSqlSha256 = sha(sqlBytes);
  }
  const schema = phase === 'before' ? '147_return_destination_statuses' : '148_return_destinations';
  step = 'health-before'; await health(schema, configBytes);
  c = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: config.dbPassword, database: 'dynaminds', connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on -c TimeZone=UTC' });
  c.on('error', () => { /* no raw client/error/credential output */ });
  step = 'capture'; await c.connect(); const current = await capture(c);
  assert.equal((await c.query('SELECT name FROM public.migrations ORDER BY name DESC LIMIT 1')).rows[0].name, schema);
  if (phase === 'before') {
    assert(sidecars.every(t => !current.rows[t])); assert(!current.rows.migrations.some(r => r.row.name === '148_return_destinations'));
    assert(!current.metadata.functions.some(f => f.signature.startsWith('return_destination_') && !f.signature.startsWith('return_destination_status_')));
  } else {
    step = 'exact-compare'; await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    try { await compare(c, basis!.capture, current, sql); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
    assert.equal(sha(await privateRead(beforePath, 512 * 1024 * 1024)), process.env.QA162_BEFORE_SHA256);
    assert.equal(sha(await readFile(resolve(ROOT, 'server/148_return_destinations.sql'))), sourceSqlSha256);
  }
  step = 'final-custody'; assert.deepEqual(await files(), current.files); await health(schema, configBytes);
  const final = await capture(c); assert.deepEqual(final, current, 'No intervening global rows/sessions/metadata/file delta');
  step = 'exclusive-output';
  const artifact = { stage: 162, phase, status: phase === 'before' ? 'READ_ONLY_CAPTURED' : 'EXACT_ADDITIVE_MIGRATION_VERIFIED',
    revision, schema, source_sql_sha256: sourceSqlSha256, before_sha256: phase === 'after' ? process.env.QA162_BEFORE_SHA256 : null,
    excluded_live_files: excludedLiveFiles, capture: current };
  const custodyHash = await wx(output, artifact);
  const report = { stage: 162, phase, status: 'PASS', claim: phase === 'before' ? 'READ_ONLY_BASELINE' : 'EXACT_ADDITIVE_147_TO_148',
    revision, schema, private_sha256: custodyHash, before_sha256: artifact.before_sha256, source_sql_sha256: sourceSqlSha256,
    global_tables: Object.keys(current.rows).length, compared_old_tables: basis ? Object.keys(basis.capture.rows).length : 0,
    sessions_included: true, pinned_files_including_config: Object.keys(current.files).length,
    excluded_live_files: excludedLiveFiles,
    declared_changed_function_bodies: phase === 'after' ? 10 : 0, added_private_helpers: phase === 'after' ? 27 : 0,
    added_user_triggers: phase === 'after' ? 50 : 0, added_ri_triggers: phase === 'after' ? 72 : 0,
    new_empty_sidecars: phase === 'after' ? 4 : 0, old_table_parent_constraint_additions: phase === 'after' ? 1 : 0,
    business_intake: 'NOT_PERFORMED', provider: 'NOT_PERFORMED', restore: 'NOT_PERFORMED' };
  await wx(publicOutput, report); console.log(JSON.stringify(report));
}
try { await main(); }
catch (e) {
  // Never emit assertion values, rows, stack, pg client, config or SQL details.
  const code = (e as { code?: string }).code;
  const ownFrame = e instanceof Error ? e.stack?.match(/return-destinations-native162-checkpoint\.ts:(\d+):(\d+)/) : undefined;
  console.log(JSON.stringify({ stage: 162, phase: ['before', 'after'].includes(phase ?? '') ? phase : 'invalid', status: 'FAIL', step,
    code: code === 'ERR_ASSERTION' ? code : 'CHECKPOINT_FAILURE',
    source_line: ownFrame ? Number(ownFrame[1]) : null, source_column: ownFrame ? Number(ownFrame[2]) : null,
    file_path_sha256: filePathSha256 })); process.exitCode = 1;
} finally { await c?.end().catch(() => undefined); }
