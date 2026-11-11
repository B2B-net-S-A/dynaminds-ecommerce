/** ROOT ONLY. Source-authored; GET + native owner RR READ ONLY, no login/write.
 * primary-restart | restored-copy. Immutable Chrome after-checkout is the
 * authority; this helper never rebases it or resolves a browser attempt.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const ROOT = '<workspace>/app';
const WT = '<workspace>/worktrees/stock-file-import';
const CONFIG = resolve(ROOT, '.local.json');
const FLOW = resolve(ROOT, 'data/b2b-catalog-native159-flow.json');
const AFTER = resolve(ROOT, 'data/b2b-catalog-native159-after-migration.json');
const ACCEPTED = resolve(ROOT, 'data/b2b-catalog-native159-chrome-after-checkout.json');
const TABLES = ['b2b_supplier_catalog_scopes', 'b2b_buyer_catalog_scopes',
  'b2b_catalog_scope_previews', 'b2b_catalog_scope_operations',
  'b2b_catalog_scope_admissions', 'b2b_catalog_bindings'].sort();
const SCHEMA = '145_order_merge_counters';
type Row = Record<string, any>;
type Capture = { rows: Record<string, { row: Row }[]>;
  snapshot: Record<string, { count: number; sha256: string }> };
const phase = process.argv[2];
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => hash(JSON.stringify(v));
const pins = new Map<string, { digest: string; mode: number }>();
let step = 'preflight', client: pg.Client | undefined, flow: Row, baseline: Row, accepted: Row, prior: Row;
let reads = 0;
function uuid(v: unknown): string {
  assert(typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)); return v;
}
function id(v: string) { assert.match(v, /^[a-z][a-z0-9_]*$/); return '"' + v + '"'; }
async function directory(path: string, privateOnly = false) {
  const s = await lstat(path); assert(s.isDirectory() && !s.isSymbolicLink());
  assert.equal(await realpath(path), path); if (privateOnly) assert.equal(s.mode & 0o777, 0o700);
}
async function bytes(path: string, mode: number) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(await realpath(path), path); assert.equal(s.mode & 0o777, mode);
  assert(s.size > 0 && s.size <= 256 * 1024 * 1024); return readFile(path);
}
async function pin(path: string, digest: unknown, mode = 0o600): Promise<Row> {
  assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
  const b = await bytes(path, mode); assert.equal(hash(b), digest);
  const previous = pins.get(path); if (previous) assert.deepEqual(previous, { digest, mode });
  pins.set(path, { digest, mode }); return JSON.parse(b.toString('utf8'));
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive evidence exists');
}
async function wx(path: string, value: unknown, mode: number) {
  const b = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(b) <= 256 * 1024 * 1024);
  const f = await open(path, 'wx', mode);
  try { await f.writeFile(b); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); }
}
async function custody() {
  for (const [path, p] of pins) assert.equal(hash(await bytes(path, p.mode)), p.digest);
  for (const [name, p] of Object.entries(prior.private_files) as [string, Row][]) {
    assert.match(name, /^[A-Za-z0-9_.-]+\.json$/);
    assert.equal(hash(await bytes(resolve(ROOT, 'data', name), p.mode)), p.sha256);
  }
}
async function get(route: string, actor?: Row, expected = 200): Promise<Row | null> {
  assert(/^\/(?:health|auth\/me|b2b\/network\/(?:links\/[a-f0-9-]+\/catalog|orders\/[a-f0-9-]+))$/.test(route));
  const headers: Record<string, string> = {};
  if (actor) {
    assert.match(actor.cookie, /^dyna_session=[A-Za-z0-9_.-]+$/);
    headers.cookie = actor.cookie; headers['X-Workspace-ID'] = uuid(actor.tenant_id);
  }
  const port = phase === 'restored-copy' ? 4198 : 4100;
  const r = await fetch(`http://127.0.0.1:${port}/api` + route, { method: 'GET', headers,
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  reads++; assert.equal(r.status, expected, 'Expected read status');
  assert(r.body); const reader = r.body.getReader(), chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) { const v = await reader.read(); if (v.done) break; size += v.value.byteLength;
      assert(size <= 4 * 1024 * 1024); chunks.push(Buffer.from(v.value)); }
  } finally { await reader.cancel().catch(() => undefined); }
  if (expected !== 200) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Row;
}
async function health() {
  const h = (await get('/health'))!; assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local');
  assert.equal(h.revision, revision); assert.equal(h.schema_revision, SCHEMA);
  assert.equal(h.restore_preview, phase === 'restored-copy'); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.product_catalogs_available, true); assert.equal(h.b2b_catalog_scope_available, true);
}
function sorted(v: Row[]) { return [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')); }
function expectedMetadata(defaultTableAcl: string) {
  const m = baseline.capture.metadata as Record<string, Row[]>;
  const names = new Map(m.relations.map(r => [r.oid, r.relname]));
  return {
    tables: sorted(m.relations.filter(r => TABLES.includes(r.relname)).map(r => ({
      name: r.relname, kind: r.relkind, owner: r.owner, acl: r.relacl ?? defaultTableAcl,
      rls: r.relrowsecurity, force_rls: r.relforcerowsecurity }))),
    functions: sorted(m.functions.filter(r => r.proname.startsWith('b2b_catalog_scope_')).map(r => ({
      name: r.proname, arguments: r.arguments, owner: r.owner, acl: r.proacl, definition: r.definition }))),
    columns: sorted(m.columns.filter(r => TABLES.includes(r.relname) && !r.attisdropped).map(r => ({
      table: r.relname, name: r.attname, position: r.attnum, type_oid: r.atttypid,
      not_null: r.attnotnull, identity: r.attidentity, generated: r.attgenerated,
      collation_oid: r.attcollation, acl: r.attacl, default: r.default_value }))),
    triggers: sorted(m.triggers.filter(r => !r.catalog.tgisinternal &&
      (r.catalog.tgname.startsWith('b2b_catalog_scope_') || TABLES.includes(names.get(String(r.catalog.tgrelid))))).map(r => ({
      table: names.get(String(r.catalog.tgrelid)), name: r.catalog.tgname,
      enabled: r.catalog.tgenabled, deferred: r.catalog.tgdeferrable,
      initially_deferred: r.catalog.tginitdeferred, definition: r.definition }))),
  };
}
async function capture(): Promise<{ capture: Capture; metadata: ReturnType<typeof expectedMetadata>; global_snapshot: Record<string, Row> }> {
  const c = client!; await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    const names: string[] = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' ORDER BY 1")).rows.map(r => r.table_name);
    assert.deepEqual(names, Object.keys(baseline.capture.tables).sort());
    const tenants = [uuid(flow.actors.supplier.tenant_id), uuid(flow.actors.buyer.tenant_id)];
    const users = [uuid(flow.actors.supplier.user_id), uuid(flow.actors.buyer.user_id)];
    assert.equal(new Set(tenants).size, 2); assert.equal(new Set(users).size, 2);
    const own: Capture = { rows: {}, snapshot: {} }, global: Record<string, Row> = {};
    for (const name of names) {
      const columns: string[] = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [name])).rows.map(r => r.column_name);
      assert.deepEqual(columns, baseline.capture.tables[name].columns);
      const key = name === 'users' || name === 'tenants' ? 'id' : columns.includes('tenant_id') ? 'tenant_id' : columns.includes('user_id') ? 'user_id' : null;
      const ids = name === 'users' || key === 'user_id' ? users : tenants;
      const old = (await c.query(`SELECT to_jsonb(x) row FROM ${id(name)} x${key ? ` WHERE ${id(key)} IS NULL OR NOT (${id(key)}=ANY($1::uuid[]))` : ''} ORDER BY 1`, key ? [ids] : [])).rows;
      global[name] = { count: old.length, sha256: fp(old) };
      assert.deepEqual(global[name], baseline.capture.tables[name].fingerprint, 'Original global rows unchanged');
      if (key) {
        own.rows[name] = (await c.query(`SELECT to_jsonb(x) row FROM ${id(name)} x WHERE ${id(key)}=ANY($1::uuid[]) ORDER BY 1`, [ids])).rows;
        own.snapshot[name] = { count: own.rows[name].length, sha256: fp(own.rows[name]) };
      }
    }
    assert.equal(Object.keys(own.rows).length, 429); assert.deepEqual(own, accepted.capture, 'Accepted own full rows unchanged');
    assert.deepEqual((await c.query('SELECT public.product_catalog_guards() product_guards,public.b2b_catalog_scope_installed() installed,public.b2b_catalog_scope_guards() guards')).rows[0], { product_guards: true, installed: true, guards: true });
    const metadata = {
      tables: sorted((await c.query("SELECT relname name,relkind kind,relowner::regrole::text owner,coalesce(relacl,acldefault('r',relowner))::text acl,relrowsecurity rls,relforcerowsecurity force_rls FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname", [TABLES])).rows),
      functions: sorted((await c.query("SELECT proname name,pg_get_function_identity_arguments(oid) arguments,proowner::regrole::text owner,proacl::text acl,pg_get_functiondef(oid) definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f' AND starts_with(proname,'b2b_catalog_scope_') ORDER BY proname")).rows),
      columns: sorted((await c.query("SELECT c.relname AS table,a.attname name,a.attnum position,a.atttypid::text type_oid,a.attnotnull not_null,a.attidentity identity,a.attgenerated generated,a.attcollation::text collation_oid,a.attacl::text acl,pg_get_expr(d.adbin,d.adrelid) AS default FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped", [TABLES])).rows),
      triggers: sorted((await c.query("SELECT c.relname AS table,t.tgname name,t.tgenabled enabled,t.tgdeferrable deferred,t.tginitdeferred initially_deferred,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal AND (starts_with(t.tgname,'b2b_catalog_scope_') OR c.relname=ANY($1::text[]))", [TABLES])).rows),
    };
    const defaultTableAcl = (await c.query("SELECT acldefault('r','postgres'::regrole)::text acl")).rows[0].acl;
    assert(baseline.capture.metadata.relations.filter((r: Row) => TABLES.includes(r.relname)).every((r: Row) => r.owner === 'postgres'));
    assert.deepEqual(metadata, expectedMetadata(defaultTableAcl), 'Private scope metadata retained');
    assert.equal(metadata.tables.length, 6); assert(metadata.functions.length >= 19);
    assert(metadata.tables.every(r => r.owner === 'postgres' && r.rls && r.force_rls));
    assert(metadata.functions.every(r => r.owner === 'postgres'));
    await c.query('COMMIT'); return { capture: own, metadata, global_snapshot: global };
  } finally { await c.query('ROLLBACK').catch(() => undefined); }
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert.equal(await realpath(ROOT), ROOT); assert.equal(process.argv.length, 3);
  assert(phase === 'primary-restart' || phase === 'restored-copy'); assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(process.env.APP_REVISION, revision); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, CONFIG); assert(!process.env.DYNA_TEST); assert(!process.env.DATABASE_URL);
  assert.equal(process.env.QA159_RECOVERY_READBACK_CONFIRM, 'READ_ONLY_EXACT_ACCEPTED_CHROME_AND_ORIGINAL_GLOBAL_ROWS');
  assert.equal(process.env.DYNA_PREVIEW_PORT, phase === 'restored-copy' ? '4198' : undefined);
  await directory(resolve(ROOT, 'data')); await directory(resolve(ROOT, 'docs'));
  const suffix = process.env.QA159_RECOVERY_EVIDENCE_SUFFIX;
  assert(suffix === undefined || suffix === 'after-db-pool-fix');
  const name = phase + (suffix ? '-' + suffix : '');
  const output = resolve(ROOT, 'data/b2b-catalog-native159-recovery-' + name + '.json');
  const report = resolve(ROOT, 'docs/b2b-catalog-native159-recovery-' + name + '.json');
  await absent(output); await absent(report);
  flow = await pin(FLOW, process.env.QA159_FLOW_JOURNAL_SHA256);
  assert.equal(flow.stage, 159); assert.equal(flow.schema_revision, SCHEMA); assert.equal(flow.status, 'CONFIRMED');
  assert.equal(flow.pending, null); assert.equal(flow.complete, false); assert.deepEqual(flow.completed_phases, ['prepare', 'configure', 'refresh']);
  assert.deepEqual(Object.keys(flow.actors).sort(), ['buyer', 'supplier']);
  assert(!flow.completed.some((r: Row) => /^(bind|quote|checkout)-/.test(r.label)));
  baseline = await pin(AFTER, process.env.QA159_AFTER_MIGRATION_SHA256);
  assert.equal(baseline.status, 'READ_ONLY_B2B_CATALOG_CHECKPOINT_PASS'); assert.equal(baseline.phase, 'after-migration'); assert.equal(baseline.schema_revision, SCHEMA);
  assert.equal(flow.after_migration_sha256, pins.get(AFTER)!.digest);
  accepted = await pin(ACCEPTED, process.env.QA159_CHROME_AFTER_CHECKOUT_SHA256);
  assert.equal(accepted.stage, 159); assert.equal(accepted.phase, 'after-checkout'); assert.equal(accepted.status, 'DURABLE_DB_ACTION_VERIFIED');
  assert.equal(accepted.schema_revision, SCHEMA); assert.equal(accepted.revision, flow.runtime_revision);
  assert.equal(accepted.flow_journal_sha256, pins.get(FLOW)!.digest); assert.equal(accepted.after_migration_sha256, pins.get(AFTER)!.digest);
  assert.equal(accepted.sessions_excluded, true); assert.equal(accepted.baseline_rebased, false);
  assert(accepted.proof?.purchase?.id); assert.equal(accepted.proof.purchase.tenant_id, flow.actors.buyer.tenant_id);
  // Retain the entire immutable Chrome predecessor chain, not only the last file.
  let previous = accepted.predecessor_sha256;
  for (const p of ['before-checkout', 'after-quote', 'before-quote', 'after-bind', 'before-bind', 'handoff']) {
    const v = await pin(resolve(ROOT, 'data/b2b-catalog-native159-chrome-' + p + '.json'), previous);
    assert.equal(v.phase, p); assert.equal(v.stage, 159); assert.equal(v.flow_journal_sha256, pins.get(FLOW)!.digest);
    assert.equal(v.after_migration_sha256, pins.get(AFTER)!.digest); previous = v.predecessor_sha256;
    if (p === 'handoff') { assert.equal(previous, null); assert.deepEqual(v.capture, flow.last_capture); }
  }
  prior = await pin(resolve(WT, 'docs/product-catalogs-preservation157-before.json'), baseline.inputs.preservation162, 0o644);
  assert.equal(prior.status, 'PRESERVATION_PASS'); assert.equal(prior.tenants.length, 162); assert.equal(Object.keys(prior.private_files).length, 366);
  assert.equal(baseline.inputs.config, prior.config.sha256); const originalConfig = await pin(CONFIG, baseline.inputs.config);
  for (const [name, digest] of [['product-catalogs-stage157.json', baseline.inputs.setup157],
    ['product-catalogs-checkpoint157-after-commerce.json', baseline.inputs.accepted157],
    ['catalog-export-catalogs-checkpoint158-before-native.json', baseline.inputs.checkpoint158],
    ['b2b-catalog-native159-before-migration.json', baseline.inputs.before159]]) await pin(resolve(ROOT, 'data', name), digest);
  let config = originalConfig, database = 'dynaminds', result: Row | null = null;
  if (phase === 'restored-copy') {
    const resultPath = process.env.QA159_RESTORE_RESULT_PATH ?? '';
    const match = /^\/Users\/arturtwardowski\/DYNA Ecomerce\/app\/data\/(b2b-catalog-backup159-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/restore\/([a-f0-9]{16})\/result\.json$/.exec(resultPath);
    assert(match); const base = resolve(ROOT, 'data', match[1]);
    await directory(base, true); await directory(resolve(base, 'restore'), true);
    await directory(dirname(resultPath), true); result = await pin(resultPath, process.env.QA159_RESTORE_RESULT_SHA256);
    database = 'dynaminds_restore_' + match[2]; assert.equal(result.id, match[2]); assert.equal(result.database, database);
    assert.equal(result.directory, dirname(resultPath)); assert.equal(result.config, resolve(result.directory, 'local-config.json'));
    assert.equal(result.images, resolve(result.directory, 'images')); assert.equal(result.source, 'dynaminds');
    assert.equal(result.revision, accepted.revision); assert.equal(result.status, 'verified'); assert.equal(result.preview_only, true);
    assert.equal(result.worker_enabled, false); assert.equal(result.row_fingerprints_match, true); assert.equal(result.schema_fingerprint_match, true);
    const configBytes = await bytes(result.config, 0o600); pins.set(result.config, { digest: hash(configBytes), mode: 0o600 });
    config = JSON.parse(configBytes.toString('utf8')); assert.equal(config.encryptionKey, originalConfig.encryptionKey);
    assert.deepEqual(Object.keys(config).sort(), ['dbPassword', 'encryptionKey']);
  } else { assert(!process.env.QA159_RESTORE_RESULT_PATH); assert(!process.env.QA159_RESTORE_RESULT_SHA256); }
  assert(typeof config.dbPassword === 'string' && config.dbPassword.length > 0);
  assert.match(config.encryptionKey, /^[a-f0-9]{64}$/); await custody(); await health();
  client = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: config.dbPassword,
    database, connectionTimeoutMillis: 10000, query_timeout: 60000 }); await client.connect();
  assert.deepEqual((await client.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0], { role: 'postgres', db: database, host: '127.0.0.1', port: 55432 });
  step = 'native-exact'; const first = await capture();
  if (result) assert.equal(result.tables, Object.keys(baseline.capture.tables).length + 1); // sessions included in generic backup
  step = 'get';
  if (phase === 'restored-copy') {
    for (const a of [flow.actors.supplier, flow.actors.buyer]) await get('/auth/me', a, 401);
  } else {
    for (const a of [flow.actors.supplier, flow.actors.buyer]) {
      const me = (await get('/auth/me', a))!; assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.role, 'admin');
    }
    const b = flow.actors.buyer, catalog = (await get('/b2b/network/links/' + uuid(b.link.id) + '/catalog', b))!;
    assert.equal(catalog.next, null); assert.equal(catalog.data.length, 1); assert.equal(catalog.data[0].id, b.item.id);
    assert.equal(catalog.data[0].product_id, b.selected.id); assert.equal(catalog.target_catalog.id, b.catalog.id);
    const purchase = (await get('/b2b/network/orders/' + uuid(accepted.proof.purchase.id), b))!;
    assert.equal(purchase.id, accepted.proof.purchase.id); assert.equal(purchase.source_order_id, accepted.proof.purchase.source_order_id); assert.equal(purchase.total_gross, 777);
  }
  await health(); await custody(); step = 'reads-effect-free'; assert.deepEqual(await capture(), first);
  const common = { stage: 159, phase, status: 'READ_ONLY_B2B_RECOVERY_READBACK_PASS', revision, schema_revision: SCHEMA,
    evidence_suffix: suffix ?? null, accepted_revision: accepted.revision, archive_revision: result?.revision ?? null,
    flow_journal_sha256: pins.get(FLOW)!.digest, after_migration_sha256: pins.get(AFTER)!.digest,
    accepted_after_checkout_sha256: pins.get(ACCEPTED)!.digest,
    restore_result_sha256: result ? pins.get(process.env.QA159_RESTORE_RESULT_PATH!)!.digest : null,
    own_tables: Object.keys(first.capture.rows).length, own_snapshot_sha256: fp(first.capture.snapshot),
    original_global_tables: Object.keys(first.global_snapshot).length, global_snapshot_sha256: fp(first.global_snapshot),
    private_scope_metadata_sha256: fp(first.metadata), private_scope_tables: 6, private_scope_functions: first.metadata.functions.length,
    own_full_rows_exact: true, original_global_rows_exact: true, scope_guards_active: true,
    private_scope_definitions_owners_effective_acl_rls_columns_triggers_retained: true,
    config_and_original_366_private_files_exact: true, original_flow_journal_unchanged: true,
    sessions_excluded: true, baseline_rebased: false, reads_effect_free: true, get_requests: reads,
    primary_cookie_rejected_in_copy: phase === 'restored-copy', copy_authenticated_ui: false,
    primary_authenticated_get: phase === 'primary-restart', mutation_sent_by_helper: false,
    native_ui_verified: false, browser_unknown_resolved: false, provider_verified: false,
    raw_sql_principal_verified: false, raw_terminal_pin_verified: false, full_goal_complete: false };
  await wx(output, { ...common, capture: first.capture, global_snapshot: first.global_snapshot, metadata: first.metadata }, 0o600);
  await custody(); await wx(report, { ...common, private_sidecar_sha256: hash(await bytes(output, 0o600)) }, 0o644);
  process.stdout.write('QA159_RECOVERY_READBACK_' + phase + '_PASS\n');
}
main().catch((error: unknown) => {
  const line = (error instanceof Error ? error.stack ?? '' : '').match(/b2b-catalog-native159-recovery-readback\.ts:(\d+):(\d+)/);
  const e = error as { actual?: Record<string, Row[]>; expected?: Record<string, Row[]> };
  const metadata_diff = error instanceof Error && error.message.startsWith('Private scope metadata retained') && e.actual && e.expected
    ? Object.keys(e.actual).filter(k => JSON.stringify(e.actual![k]) !== JSON.stringify(e.expected![k])).map(k => ({
      section: k, fields: [...new Set((e.actual![k] ?? []).flatMap((r, i) => Object.keys(r).filter(f => JSON.stringify(r[f]) !== JSON.stringify(e.expected![k]?.[i]?.[f]))))].sort(),
    })) : [];
  process.stderr.write(JSON.stringify({ status: 'QA159_RECOVERY_READBACK_FAILED', step,
    metadata_diff,
    error_kind: error instanceof Error ? error.name : 'Unknown',
    stack_line_refs: error instanceof Error ? [...new Set((error.stack ?? '').match(/[\w.-]+\.(?:ts|js):\d+:\d+/g) ?? [])] : [],
    ...((error as NodeJS.ErrnoException)?.code && /^[A-Z0-9_]+$/.test((error as NodeJS.ErrnoException).code!) ? { error_code: (error as NodeJS.ErrnoException).code } : {}),
    ...(line ? { source_line: Number(line[1]) } : {}), secrets_omitted: true }) + '\n'); process.exitCode = 1;
}).finally(async () => { await client?.end().catch(() => undefined); });
