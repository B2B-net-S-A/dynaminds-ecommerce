/** ROOT ONLY, source-authored. One explicit existing-buyer login in copy4198;
 * then six malformed POSTs that must be rejected423 before parsing. No signup,
 * provider, normal business mutation, automatic retry, resume or disposal.
 * Every sent request has durable private pending custody first. Unknown stops.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const ROOT = '<workspace>/app';
const WT = '<workspace>/worktrees/stock-file-import';
const CONFIG = resolve(ROOT, '.local.json');
const FLOW = resolve(ROOT, 'data/b2b-catalog-native159-flow.json');
const AFTER = resolve(ROOT, 'data/b2b-catalog-native159-after-migration.json');
const ACCEPTED = resolve(ROOT, 'data/b2b-catalog-native159-chrome-after-checkout.json');
const COPY = resolve(ROOT, 'data/b2b-catalog-native159-recovery-restored-copy.json');
const JOURNAL = resolve(ROOT, 'data/b2b-catalog-native159-copy-api-probes.json');
const REPORT = resolve(ROOT, 'docs/b2b-catalog-native159-copy-api-probes.json');
const BASE = 'http://127.0.0.1:4198';
const SCHEMA = '145_order_merge_counters';
const COOKIE = 'dyna_session_preview_4198';
const revision = process.env.QA_EXPECTED_REVISION ?? '';
type Row = Record<string, any>;
type Capture = { rows: Record<string, { row: Row }[]>; snapshot: Record<string, { count: number; sha256: string }> };
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => hash(JSON.stringify(v));
const pins = new Map<string, { digest: string; mode: number }>();
let client: pg.Client | undefined, flow: Row, baseline: Row, accepted: Row, prior: Row, buyer: Row;
let journal: Row | undefined, journalSHA = '', writable = false, cookie = '', step = 'preflight';
function uuid(v: unknown): string {
  assert(typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)); return v;
}
function id(v: string) { assert.match(v, /^[a-z][a-z0-9_]*$/); return '"' + v + '"'; }
async function bytes(path: string, mode: number) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(await realpath(path), path);
  assert.equal(s.mode & 0o777, mode); assert(s.size > 0 && s.size <= 256 * 1024 * 1024); return readFile(path);
}
async function pin(path: string, digest: unknown, mode = 0o600): Promise<Row> {
  assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)); const b = await bytes(path, mode);
  assert.equal(hash(b), digest); pins.set(path, { digest, mode }); return JSON.parse(b.toString('utf8'));
}
async function directory(path: string, privateOnly = false) {
  const s = await lstat(path); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(path), path);
  if (privateOnly) assert.equal(s.mode & 0o777, 0o700);
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive evidence exists; no resume');
}
async function wx(path: string, value: unknown, mode: number) {
  const b = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(b) <= 256 * 1024 * 1024);
  const f = await open(path, 'wx', mode); try { await f.writeFile(b); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); } return hash(b);
}
async function save() {
  assert(writable && journal); assert.equal(hash(await bytes(JOURNAL, 0o600)), journalSHA);
  const temp = JOURNAL + '.' + randomUUID() + '.tmp';
  try {
    const digest = await wx(temp, journal, 0o600); await rename(temp, JOURNAL);
    const d = await open(dirname(JOURNAL), 'r'); try { await d.sync(); } finally { await d.close(); } journalSHA = digest;
  } finally { await unlink(temp).catch(() => undefined); }
}
async function custody() {
  for (const [path, p] of pins) assert.equal(hash(await bytes(path, p.mode)), p.digest);
  for (const [name, p] of Object.entries(prior.private_files) as [string, Row][]) {
    assert.match(name, /^[A-Za-z0-9_.-]+\.json$/); assert.equal(hash(await bytes(resolve(ROOT, 'data', name), p.mode)), p.sha256);
  }
  if (writable) assert.equal(hash(await bytes(JOURNAL, 0o600)), journalSHA);
}
async function body(r: Response): Promise<Row> {
  assert(r.body); const reader = r.body.getReader(), chunks: Buffer[] = []; let n = 0;
  try { for (;;) { const v = await reader.read(); if (v.done) break; n += v.value.byteLength;
    assert(n <= 4 * 1024 * 1024); chunks.push(Buffer.from(v.value)); } }
  finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function get(path: string, auth = false, expected = 200): Promise<Row | null> {
  assert(/^\/api\/(?:health|auth\/me|b2b\/network\/(?:links\/[a-f0-9-]+\/(?:catalog|catalog-scope)|orders\/[a-f0-9-]+))$/.test(path));
  const headers: Record<string, string> = auth ? { cookie, 'X-Workspace-ID': uuid(buyer.tenant_id) } : {};
  const r = await fetch(BASE + path, { method: 'GET', headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, expected); if (expected !== 200) { await r.body?.cancel(); return null; } return body(r);
}
async function health() {
  const h = (await get('/api/health'))!; assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, SCHEMA); assert.equal(h.restore_preview, true); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.product_catalogs_available, true); assert.equal(h.b2b_catalog_scope_available, true);
}
async function identity() {
  const me = (await get('/api/auth/me', true))!; assert.equal(me.user.id, buyer.user_id);
  assert.equal(me.user.tenant_id, buyer.tenant_id); assert.equal(me.user.role, 'admin');
}
async function capture(): Promise<{ capture: Capture; global_snapshot: Record<string, Row>; sessions: { row: Row }[] }> {
  const c = client!; await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    const tables: string[] = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' ORDER BY 1")).rows.map(r => r.table_name);
    assert.deepEqual(tables, Object.keys(baseline.capture.tables).sort()); assert.equal(tables.length, 440);
    const tenants = [uuid(flow.actors.supplier.tenant_id), uuid(buyer.tenant_id)];
    const users = [uuid(flow.actors.supplier.user_id), uuid(buyer.user_id)]; assert.equal(new Set(tenants).size, 2); assert.equal(new Set(users).size, 2);
    const own: Capture = { rows: {}, snapshot: {} }, global: Record<string, Row> = {};
    for (const name of tables) {
      const columns: string[] = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [name])).rows.map(r => r.column_name);
      assert.deepEqual(columns, baseline.capture.tables[name].columns);
      const key = name === 'users' || name === 'tenants' ? 'id' : columns.includes('tenant_id') ? 'tenant_id' : columns.includes('user_id') ? 'user_id' : null;
      const ids = name === 'users' || key === 'user_id' ? users : tenants;
      const old = (await c.query(`SELECT to_jsonb(x) row FROM ${id(name)} x${key ? ` WHERE ${id(key)} IS NULL OR NOT (${id(key)}=ANY($1::uuid[]))` : ''} ORDER BY 1`, key ? [ids] : [])).rows;
      global[name] = { count: old.length, sha256: fp(old) }; assert.deepEqual(global[name], baseline.capture.tables[name].fingerprint);
      if (key) { own.rows[name] = (await c.query(`SELECT to_jsonb(x) row FROM ${id(name)} x WHERE ${id(key)}=ANY($1::uuid[]) ORDER BY 1`, [ids])).rows;
        own.snapshot[name] = { count: own.rows[name].length, sha256: fp(own.rows[name]) }; }
    }
    assert.equal(Object.keys(own.rows).length, 429); assert.deepEqual(own, accepted.capture);
    assert.deepEqual((await c.query('SELECT public.product_catalog_guards() product_guards,public.b2b_catalog_scope_installed() installed,public.b2b_catalog_scope_guards() guards')).rows[0], { product_guards: true, installed: true, guards: true });
    const sessions = (await c.query('SELECT to_jsonb(x) row FROM sessions x ORDER BY 1')).rows;
    await c.query('COMMIT'); return { capture: own, global_snapshot: global, sessions };
  } finally { await c.query('ROLLBACK').catch(() => undefined); }
}
async function post(label: string, path: string, raw: string, expected: number, login = false) {
  assert(journal && journal.pending === null); await custody(); await health(); if (!login) await identity();
  const allowed = journal.probes as { label: string; path: string }[];
  assert(login ? label === 'login' && path === '/api/auth/login' && expected === 200
    : allowed.some(v => v.label === label && v.path === path) && raw === '{"' && expected === 423);
  const headers = { 'Content-Type': 'application/json', ...(login ? {} : { cookie, 'X-Workspace-ID': uuid(buyer.tenant_id) }) };
  const intent = { label, method: 'POST', path, raw_body: raw, headers, expected_status: expected,
    tenant_id: buyer.tenant_id, user_id: buyer.user_id };
  const intentFile = resolve(ROOT, 'data/b2b-catalog-native159-copy-api-probes-' + label + '-intent.json');
  const responseFile = resolve(ROOT, 'data/b2b-catalog-native159-copy-api-probes-' + label + '-response.json');
  await absent(intentFile); await absent(responseFile);
  const intentSHA = await wx(intentFile, intent, 0o600);
  journal.pending = { label, intent_file: intentFile, intent_sha256: intentSHA, state: 'UNKNOWN_UNTIL_VALIDATED_RESPONSE' }; await save();
  const r = await fetch(BASE + path, { method: 'POST', headers, body: raw, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, expected);
  let payload: Row | null = null;
  if (login) {
    const set = r.headers.get('set-cookie') ?? ''; const match = new RegExp('(?:^|,\\s*)(' + COOKIE + '=[A-Za-z0-9_.-]+)(?:;|$)').exec(set);
    assert(match); cookie = match[1]; payload = await body(r);
    assert.equal(payload.user.id, buyer.user_id); assert.equal(payload.user.tenant_id, buyer.tenant_id); assert.equal(payload.user.role, 'admin');
  } else await r.body?.cancel();
  await custody(); assert.equal(hash(await bytes(intentFile, 0o600)), intentSHA);
  const responseSHA = await wx(responseFile, { label, path, status: r.status, intent_sha256: intentSHA,
    ...(login ? { cookie, payload } : {}), known_response: true }, 0o600);
  journal.completed.push({ label, path, status: r.status, intent_sha256: intentSHA, response_sha256: responseSHA });
  journal.cookie = cookie; journal.pending = null; await save();
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert.equal(await realpath(ROOT), ROOT); assert.equal(process.argv.length, 2);
  assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION, revision);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, CONFIG); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.equal(process.env.DYNA_PREVIEW_PORT, '4198');
  assert(!process.env.DATABASE_URL); assert(!process.env.DYNA_TEST);
  assert.equal(process.env.QA159_COPY_API_PROBES_CONFIRM, 'LOGIN_EXISTING_OWN_COPY_BUYER_AND_SIX_MALFORMED_423_ONLY');
  await directory(resolve(ROOT, 'data')); await directory(resolve(ROOT, 'docs')); await absent(JOURNAL); await absent(REPORT);
  flow = await pin(FLOW, process.env.QA159_FLOW_JOURNAL_SHA256); baseline = await pin(AFTER, process.env.QA159_AFTER_MIGRATION_SHA256);
  accepted = await pin(ACCEPTED, process.env.QA159_CHROME_AFTER_CHECKOUT_SHA256);
  assert.equal(flow.stage, 159); assert.equal(flow.status, 'CONFIRMED'); assert.equal(flow.pending, null); assert.equal(flow.complete, false);
  assert.deepEqual(flow.completed_phases, ['prepare', 'configure', 'refresh']); assert.deepEqual(Object.keys(flow.actors).sort(), ['buyer', 'supplier']);
  assert.equal(flow.schema_revision, SCHEMA); assert.equal(baseline.schema_revision, SCHEMA); assert.equal(baseline.status, 'READ_ONLY_B2B_CATALOG_CHECKPOINT_PASS');
  assert.equal(flow.after_migration_sha256, pins.get(AFTER)!.digest);
  assert.equal(accepted.status, 'DURABLE_DB_ACTION_VERIFIED'); assert.equal(accepted.phase, 'after-checkout'); assert.equal(accepted.schema_revision, SCHEMA);
  assert.equal(accepted.revision, flow.runtime_revision); assert.equal(accepted.flow_journal_sha256, pins.get(FLOW)!.digest); assert.equal(accepted.after_migration_sha256, pins.get(AFTER)!.digest);
  let predecessor = accepted.predecessor_sha256;
  for (const phase of ['before-checkout', 'after-quote', 'before-quote', 'after-bind', 'before-bind', 'handoff']) {
    const v = await pin(resolve(ROOT, 'data/b2b-catalog-native159-chrome-' + phase + '.json'), predecessor);
    assert.equal(v.phase, phase); assert.equal(v.stage, 159); assert.equal(v.schema_revision, SCHEMA);
    assert.equal(v.flow_journal_sha256, pins.get(FLOW)!.digest); assert.equal(v.after_migration_sha256, pins.get(AFTER)!.digest); predecessor = v.predecessor_sha256;
    if (phase === 'handoff') { assert.equal(predecessor, null); assert.deepEqual(v.capture, flow.last_capture); }
  }
  const copy = await pin(COPY, process.env.QA159_COPY_READBACK_SHA256);
  assert.equal(copy.status, 'READ_ONLY_B2B_RECOVERY_READBACK_PASS'); assert.equal(copy.phase, 'restored-copy'); assert.equal(copy.schema_revision, SCHEMA);
  assert.equal(copy.accepted_after_checkout_sha256, pins.get(ACCEPTED)!.digest); assert.equal(copy.flow_journal_sha256, pins.get(FLOW)!.digest);
  assert.equal(copy.after_migration_sha256, pins.get(AFTER)!.digest); assert.deepEqual(copy.capture, accepted.capture);
  assert.equal(copy.own_full_rows_exact, true); assert.equal(copy.original_global_rows_exact, true); assert.equal(copy.scope_guards_active, true);
  prior = await pin(resolve(WT, 'docs/product-catalogs-preservation157-before.json'), baseline.inputs.preservation162, 0o644);
  assert.equal(prior.status, 'PRESERVATION_PASS'); assert.equal(prior.tenants.length, 162); assert.equal(Object.keys(prior.private_files).length, 366);
  assert.equal(baseline.inputs.config, prior.config.sha256); const primary = await pin(CONFIG, baseline.inputs.config);
  for (const [name, digest] of [['product-catalogs-stage157.json', baseline.inputs.setup157], ['product-catalogs-checkpoint157-after-commerce.json', baseline.inputs.accepted157],
    ['catalog-export-catalogs-checkpoint158-before-native.json', baseline.inputs.checkpoint158], ['b2b-catalog-native159-before-migration.json', baseline.inputs.before159]]) await pin(resolve(ROOT, 'data', name), digest);
  const resultPath = process.env.QA159_RESTORE_RESULT_PATH ?? '';
  const match = /^\/Users\/arturtwardowski\/DYNA Ecomerce\/app\/data\/(b2b-catalog-backup159-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/restore\/([a-f0-9]{16})\/result\.json$/.exec(resultPath);
  assert(match); await directory(resolve(ROOT, 'data', match[1]), true); await directory(dirname(dirname(resultPath)), true); await directory(dirname(resultPath), true);
  const result = await pin(resultPath, process.env.QA159_RESTORE_RESULT_SHA256);
  assert.equal(copy.restore_result_sha256, pins.get(resultPath)!.digest); assert.equal(result.id, match[2]); assert.equal(result.database, 'dynaminds_restore_' + match[2]);
  assert.equal(result.directory, dirname(resultPath)); assert.equal(result.config, resolve(result.directory, 'local-config.json')); assert.equal(result.images, resolve(result.directory, 'images'));
  assert.equal(result.status, 'verified'); assert.equal(result.preview_only, true); assert.equal(result.worker_enabled, false); assert.equal(result.source, 'dynaminds');
  assert.equal(result.row_fingerprints_match, true); assert.equal(result.schema_fingerprint_match, true); assert.equal(result.revision, accepted.revision); assert.equal(result.tables, 441);
  const configBytes = await bytes(result.config, 0o600); pins.set(result.config, { digest: hash(configBytes), mode: 0o600 });
  const config = JSON.parse(configBytes.toString('utf8')); assert.deepEqual(Object.keys(config).sort(), ['dbPassword', 'encryptionKey']); assert.equal(config.encryptionKey, primary.encryptionKey);
  assert(typeof config.dbPassword === 'string' && config.dbPassword.length > 0); buyer = flow.actors.buyer;
  uuid(buyer.tenant_id); uuid(buyer.user_id); assert(typeof buyer.email === 'string' && typeof buyer.password === 'string' && buyer.password.length > 0);
  await custody(); await health();
  client = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: config.dbPassword, database: result.database, connectionTimeoutMillis: 10000, query_timeout: 60000 }); await client.connect();
  assert.deepEqual((await client.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0], { role: 'postgres', db: result.database, host: '127.0.0.1', port: 55432 });
  step = 'before'; const before = await capture(); assert.deepEqual(before.global_snapshot, copy.global_snapshot);
  const previews = accepted.capture.rows.b2b_catalog_scope_previews.map((r: { row: Row }) => r.row).filter((r: Row) => r.tenant_id === buyer.tenant_id && r.kind === 'buyer');
  assert.equal(previews.length, 1); const previewId = uuid(previews[0].id), link = uuid(buyer.link.id), item = uuid(buyer.item.id);
  const quote = accepted.capture.rows.b2b_network_quotes.map((r: { row: Row }) => r.row).filter((r: Row) => r.tenant_id === buyer.tenant_id);
  assert.equal(quote.length, 1); const quoteId = uuid(quote[0].id);
  const probes = [
    { label: 'scope-preview', path: `/api/b2b/network/links/${link}/catalog-scope/previews` },
    { label: 'scope-commit', path: `/api/b2b/catalog-scope/previews/${previewId}/commit` },
    { label: 'bind', path: `/api/b2b/network/links/${link}/catalog/${item}/bind` },
    { label: 'quote', path: `/api/b2b/network/links/${link}/quotes` },
    { label: 'checkout', path: `/api/b2b/network/links/${link}/quotes/${quoteId}/checkout` },
    { label: 'v1-scope-preview', path: `/api/v1/b2b/network/links/${link}/catalog-scope/previews` },
  ];
  // Reserve all custody names before the first request; prior unknown cannot resume.
  for (const label of ['login', ...probes.map(p => p.label)]) for (const suffix of ['intent', 'response']) await absent(resolve(ROOT, `data/b2b-catalog-native159-copy-api-probes-${label}-${suffix}.json`));
  journal = { stage: 159, status: 'IN_PROGRESS', runtime_revision: revision, archive_revision: result.revision,
    schema_revision: SCHEMA, tenant_id: buyer.tenant_id, user_id: buyer.user_id,
    flow_journal_sha256: pins.get(FLOW)!.digest, accepted_after_checkout_sha256: pins.get(ACCEPTED)!.digest,
    copy_readback_sha256: pins.get(COPY)!.digest, restore_result_sha256: pins.get(resultPath)!.digest,
    before, probes, pending: null, completed: [], cookie: null, automatic_retry: false };
  journalSHA = await wx(JOURNAL, journal, 0o600); writable = true;
  step = 'login'; await post('login', '/api/auth/login', JSON.stringify({ email: buyer.email, password: buyer.password }), 200, true); await identity();
  for (const p of probes) { step = p.label; await post(p.label, p.path, '{"', 423); }
  step = 'after'; await identity(); await health(); await custody(); const after = await capture();
  assert.deepEqual(after.capture, before.capture); assert.deepEqual(after.global_snapshot, before.global_snapshot);
  const oldSessionKeys = new Set(before.sessions.map(fp)); const added = after.sessions.filter(r => !oldSessionKeys.has(fp(r)));
  assert.equal(added.length, 1); assert.equal(after.sessions.length, before.sessions.length + 1);
  const token = cookie.slice((COOKIE + '=').length); assert.equal(added[0].row.token_hash, hash(token));
  assert.equal(added[0].row.user_id, buyer.user_id); assert.equal(added[0].row.tenant_id, buyer.tenant_id);
  assert.deepEqual(after.sessions.filter(r => oldSessionKeys.has(fp(r))), before.sessions);
  assert.equal(journal.pending, null); assert.equal(journal.completed.length, 7); assert(journal.completed.slice(1).every((r: Row) => r.status === 423));
  journal.status = 'COPY_API_PROBES_PASS'; journal.after = after; journal.business_rows_exact = true; journal.sessions_added = 1; await save(); await custody();
  await wx(REPORT, { stage: 159, status: 'COPY_API_PROBES_PASS', runtime_revision: revision, archive_revision: result.revision,
    schema_revision: SCHEMA, flow_journal_sha256: pins.get(FLOW)!.digest, accepted_after_checkout_sha256: pins.get(ACCEPTED)!.digest,
    copy_readback_sha256: pins.get(COPY)!.digest, restore_result_sha256: pins.get(resultPath)!.digest, private_journal_sha256: journalSHA,
    authenticated_copy_login: true, authenticated_identity_verified: true, login_count: 1, own_sessions_added: 1, prior_sessions_exact: true,
    malformed_posts: probes.map(p => ({ operation: p.label, status: 423 })), malformed_posts_count: 6,
    normal_prefix_denials: 5, v1_prefix_denials: 1, api_key_authentication_verified: false,
    own_tables: 429, original_global_tables: 440, own_snapshot_sha256: fp(after.capture.snapshot), global_snapshot_sha256: fp(after.global_snapshot),
    business_rows_exact: true, all_original_global_rows_exact: true, config_and_original_366_private_files_exact: true,
    original_journals_unchanged: true, baseline_rebased: false, provider_calls: 0,
    normal_business_mutations_sent: 0, automatic_retry: false, browser_unknown_resolved: false,
    native_ui_verified: false, provider_verified: false, raw_sql_principal_verified: false, raw_terminal_pin_verified: false, full_goal_complete: false }, 0o644);
  process.stdout.write('QA159_COPY_API_PROBES_PASS\n');
}
main().catch(async (error: unknown) => {
  if (writable && journal) { journal.status = journal.pending ? 'UNKNOWN_STOPPED_NO_RETRY' : 'FAILED_NO_RETRY'; await save().catch(() => undefined); }
  const line = (error instanceof Error ? error.stack ?? '' : '').match(/b2b-catalog-native159-copy-api-probes\.ts:(\d+):(\d+)/);
  process.stderr.write(JSON.stringify({ status: 'QA159_COPY_API_PROBES_FAILED', step,
    ...(line ? { source_line: Number(line[1]) } : {}), unknown_request_retained: Boolean(journal?.pending), secrets_omitted: true }) + '\n'); process.exitCode = 1;
}).finally(async () => { await client?.end().catch(() => undefined); });
