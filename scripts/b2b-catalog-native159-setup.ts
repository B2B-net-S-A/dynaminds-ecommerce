/** ROOT ONLY — first tranche: read-only BEFORE143 / AFTER144+145 checkpoint.
 * This does NOT prepare QA159 actors or issue any HTTP/SQL mutation. There is
 * no signup, login, worker, migration, provider, retry or resume path here.
 * The later two-firm writer must preserve this exclusive custody verbatim.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const ROOT = '<workspace>/app';
const WT = '<workspace>/worktrees/stock-file-import';
const phase = process.argv[2];
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = phase === 'before-migration' ? '143_catalog_export_catalogs' : '145_order_merge_counters';
const NEW = ['b2b_supplier_catalog_scopes', 'b2b_buyer_catalog_scopes', 'b2b_catalog_scope_previews',
  'b2b_catalog_scope_operations', 'b2b_catalog_scope_admissions', 'b2b_catalog_bindings'].sort();
const CATALOGS = ['product_catalogs', 'product_catalog_warehouses', 'product_catalog_price_lists',
  'product_catalog_languages', 'product_catalog_previews', 'product_catalog_operations', 'product_catalog_admissions'];
const RUN_COLUMNS = ['catalog_scope', 'catalog_scope_hash', 'api_key_id'];
type Row = Record<string, any>;
type Fingerprint = { count: number; sha256: string };
type Table = { columns: string[]; fingerprint: Fingerprint;
  historical_columns?: string[]; historical_fingerprint?: Fingerprint };
type Capture = { tables: Record<string, Table>; own: Record<string, Fingerprint>; earlier: Record<string, Fingerprint>;
  catalog_global: Record<string, Fingerprint>; migrations: Row[]; metadata: Record<string, Row[]> };
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => sha(JSON.stringify(v));
const inputs = new Map<string, { sha256: string; mode: number; max: number }>();
let client: pg.Client | undefined, step = 'preflight', actor: Row, prior: Row, accepted: Row, baseline: Row;
let replacement145: { function: string; source_sha256: string; body_sha256: string; body: string } | undefined;
let reads = 0;
function identifier(v: string) { assert.match(v, /^[a-z][a-z0-9_]*$/); return '"' + v + '"'; }
function functionEnvelope(definition: string) {
  // pg_get_functiondef() may omit the SQL statement's trailing semicolon.
  // Both old/new envelopes are still compared verbatim below.
  const match = /\bAS (\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)([\s\S]*)\1;?\s*$/.exec(definition);
  assert(match, 'Expected complete PostgreSQL function definition');
  const bodyStart = match.index + 'AS '.length + match[1].length;
  return { prefix: definition.slice(0, bodyStart),
    body: match[2], suffix: definition.slice(bodyStart + match[2].length) };
}
function uuid(v: unknown): string {
  assert(typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)); return v;
}
async function regular(file: string, mode: number, max = 256 * 1024 * 1024) {
  const s = await lstat(file); assert(s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= max);
  assert.equal(s.mode & 0o777, mode);
  const bytes = await readFile(file), observed = { sha256: sha(bytes), mode, max };
  const old = inputs.get(file); if (old) assert.deepEqual(observed, old, 'Pinned input custody unchanged');
  inputs.set(file, observed); return bytes;
}
async function pinned(file: string, digest: string | undefined, mode: number, max?: number) {
  assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
  const bytes = await regular(file, mode, max); assert.equal(sha(bytes), digest); return bytes;
}
async function absent(file: string) {
  try { await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive evidence already exists; no overwrite or resume');
}
async function wx(file: string, value: unknown, mode: number) {
  const bytes = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(bytes) <= 256 * 1024 * 1024);
  const f = await open(file, 'wx', mode);
  try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
}
async function get(route: '/health' | '/auth/me') {
  // The only callable HTTP routes are ordinary, read-only health and identity.
  const r = await fetch('http://127.0.0.1:4100/api' + route, { method: 'GET', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(15000), headers: route === '/auth/me'
      ? { cookie: actor.cookie, 'X-Workspace-ID': uuid(actor.tenant_id) } : {} });
  assert.equal(r.status, 200); const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length <= 1024 * 1024);
  reads++; return JSON.parse(bytes.toString('utf8')) as Row;
}
async function health() {
  const h = await get('/health');
  assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema); assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.product_catalogs_available, true);
  if (phase === 'after-migration') assert.equal(h.b2b_catalog_scope_available, true);
  else assert.notEqual(h.b2b_catalog_scope_available, true);
}
async function metadata(c: pg.Client): Promise<Record<string, Row[]>> {
  // Match old objects by their actual OID and exact definitions/ACL. Additive
  // objects are recorded separately; pg_class.relnatts is intentionally absent
  // because the declared three-column ALTER legitimately increases it.
  return {
    relations: (await c.query("SELECT oid::text,relname,relkind,relowner::regrole::text owner,relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p','i','S') ORDER BY oid")).rows,
    functions: (await c.query("SELECT oid::text,proname,pg_get_function_identity_arguments(oid) arguments,proowner::regrole::text owner,proacl::text,pg_get_functiondef(oid) definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f' ORDER BY oid")).rows,
    policies: (await c.query("SELECT p.oid::text,to_jsonb(p) definition FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace ORDER BY p.oid")).rows,
    triggers: (await c.query("SELECT t.oid::text,to_jsonb(t) catalog,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid")).rows,
    constraints: (await c.query("SELECT k.oid::text,to_jsonb(k) catalog,pg_get_constraintdef(k.oid,true) definition FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname='public' ORDER BY k.oid")).rows,
    columns: (await c.query("SELECT a.attrelid::text||':'||a.attnum::text oid,c.relname,a.attname,a.atttypid::text,a.attnum,a.attnotnull,a.attisdropped,a.attidentity,a.attgenerated,a.attcollation::text,a.attacl::text,pg_get_expr(d.adbin,d.adrelid) default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND a.attnum>0 ORDER BY a.attrelid,a.attnum")).rows,
    indexes: (await c.query("SELECT i.indexrelid::text oid,pg_get_indexdef(i.indexrelid) definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace ORDER BY i.indexrelid")).rows,
    sequences: (await c.query("SELECT s.seqrelid::text oid,to_jsonb(s) definition FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid WHERE c.relnamespace='public'::regnamespace ORDER BY s.seqrelid")).rows,
  };
}
async function capture(before?: Capture): Promise<Capture> {
  const c = client!; await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    const all: string[] = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' ORDER BY 1")).rows.map(r => r.table_name);
    const business: string[] = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND(table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY 1")).rows.map(r => r.table_name);
    const oldNames = Object.keys(baseline.capture.rows).sort(); assert.equal(oldNames.length, 420);
    assert.deepEqual(business, [...oldNames, ...(before ? NEW : [])].sort());
    if (before) assert.deepEqual(all, [...Object.keys(before.tables), ...NEW].sort(), 'Only six declared tables added');
    else assert(NEW.every(name => !all.includes(name)), 'No144 evidence exists before migration');
    assert.deepEqual((await c.query('SELECT id FROM tenants ORDER BY id')).rows.map(r => r.id), [...prior.tenants, actor.tenant_id].sort());
    assert.deepEqual((await c.query('SELECT id FROM users ORDER BY id')).rows.map(r => r.id), [...prior.users, actor.user_id].sort());
    const tables: Record<string, Table> = {}, own: Record<string, Fingerprint> = {}, earlier: Record<string, Fingerprint> = {}, catalogGlobal: Record<string, Fingerprint> = {};
    for (const name of all) {
      const cols: string[] = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [name])).rows.map(r => r.column_name);
      assert(cols.length > 0); cols.forEach(identifier);
      const previous = before?.tables[name];
      if (previous) assert.deepEqual(cols, name === 'b2b_catalog_runs' ? [...previous.columns, ...RUN_COLUMNS] : previous.columns, 'Declared old-table column delta');
      const projection = previous?.columns ?? cols;
      const rows = (await c.query(`SELECT to_jsonb(x) row FROM (SELECT ${projection.map(identifier).join(',')} FROM ${identifier(name)}) x ORDER BY 1`)).rows;
      const fingerprint = { count: rows.length, sha256: fp(rows) };
      if (previous && name !== 'migrations') assert.deepEqual(fingerprint, previous.fingerprint, 'All historical rows/columns retained: ' + name);
      const fullRows = previous && name === 'b2b_catalog_runs'
        ? (await c.query(`SELECT to_jsonb(x) row FROM ${identifier(name)} x ORDER BY 1`)).rows
        : rows;
      tables[name] = { columns: cols, fingerprint: { count: fullRows.length, sha256: fp(fullRows) },
        ...(previous && name !== 'migrations' ? { historical_columns: projection, historical_fingerprint: fingerprint } : {}) };
      if (NEW.includes(name)) assert.equal(rows.length, 0, '144 tables globally empty, not just current firm');
      if (business.includes(name) && !NEW.includes(name)) {
        const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
        const ownRows = (await c.query(`SELECT to_jsonb(x) row FROM (SELECT ${projection.map(identifier).join(',')} FROM ${identifier(name)} WHERE ${identifier(key)}=$1) x ORDER BY 1`, [name === 'users' ? actor.user_id : actor.tenant_id])).rows;
        own[name] = { count: ownRows.length, sha256: fp(ownRows) };
        assert.deepEqual(ownRows, baseline.capture.rows[name], 'QA157 remains accepted158 without rebase: ' + name);
        assert.deepEqual(own[name], accepted.snapshot[name]);
        if (prior.tables[name]) {
          const historicalCols: string[] = prior.columns[name]; assert(historicalCols.every(column => cols.includes(column)));
          const oldRows = (await c.query(`SELECT to_jsonb(x) row FROM (SELECT ${historicalCols.map(identifier).join(',')} FROM ${identifier(name)} WHERE ${identifier(key)}=ANY($1::uuid[])) x ORDER BY 1`, [name === 'users' ? prior.users : prior.tenants])).rows;
          earlier[name] = { count: oldRows.length, sha256: fp(oldRows) }; assert.deepEqual(earlier[name], prior.tables[name]);
        }
      }
      if (CATALOGS.includes(name)) {
        catalogGlobal[name] = fingerprint;
        assert.equal(fingerprint.sha256, fp(baseline.capture.global_catalog_rows[name]), 'All163 firms catalog rows unchanged');
      }
    }
    assert.equal(Object.keys(earlier).length, 413);
    const migrations = (await c.query('SELECT to_jsonb(x) row FROM migrations x ORDER BY 1')).rows;
    const ledger = migrations.map(r => r.row.name); assert.equal(ledger.length, before ? 145 : 143);
    assert.equal(new Set(ledger).size, ledger.length); assert(ledger.includes(schema));
    if (before) {
      const addedNames = ['144_b2b_catalog_scopes', '145_order_merge_counters'];
      assert.deepEqual(migrations.filter(r => !addedNames.includes(r.row.name)), before.migrations, 'No migration history rewrite');
      assert.deepEqual(migrations.filter(r => addedNames.includes(r.row.name)).map(r => r.row.name).sort(), addedNames,
        'Only144 and145 are declared new migration rows');
      const nullable = (await c.query('SELECT catalog_scope,catalog_scope_hash,api_key_id FROM b2b_catalog_runs')).rows;
      assert(nullable.every(r => r.catalog_scope === null && r.catalog_scope_hash === null && r.api_key_id === null));
      const guards = (await c.query('SELECT public.b2b_catalog_scope_installed() installed,public.b2b_catalog_scope_guards() guards')).rows[0];
      assert.deepEqual(guards, { installed: true, guards: true });
      for (const name of NEW) {
        const safe = (await c.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('dyna_app',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') app_table,has_any_column_privilege('dyna_app',oid,'SELECT,INSERT,UPDATE') app_column,EXISTS(SELECT 1 FROM aclexplode(coalesce(relacl,acldefault('r',relowner))) a WHERE a.grantee=0) public_grant FROM pg_class WHERE oid=$1::regclass", [name])).rows[0];
        assert.deepEqual(safe, { relrowsecurity: true, relforcerowsecurity: true, app_table: false, app_column: false, public_grant: false });
        assert.equal((await c.query('SELECT count(*)::int n FROM pg_constraint WHERE conrelid=$1::regclass AND NOT convalidated', [name])).rows[0].n, 0);
        assert.equal((await c.query("SELECT count(*)::int n FROM pg_attribute a,LATERAL aclexplode(a.attacl) x WHERE a.attrelid=$1::regclass AND NOT a.attisdropped AND x.grantee=0", [name])).rows[0].n, 0);
      }
      const funcs = (await c.query("SELECT p.proname,has_function_privilege('dyna_app',p.oid,'EXECUTE') app,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'b2b_catalog_scope_%'")).rows;
      assert(funcs.length > 0); assert(funcs.every(f => f.app === false && f.public === false));
    }
    assert.deepEqual((await c.query('SELECT public.product_catalog_guards() ok,public.catalog_export_catalogs_guards() export_ok')).rows[0], { ok: true, export_ok: true });
    const currentMetadata = await metadata(c);
    if (before) {
      assert(replacement145);
      const issuer = (await c.query("SELECT oid::text,prosrc FROM pg_proc WHERE oid='public.order_merge_transfer_custody(uuid)'::regprocedure")).rows;
      assert.equal(issuer.length, 1);
      assert.equal(issuer[0].prosrc, replacement145.body, 'Installed issuer body is exactly pinned145 source');
      const oldIssuer = before.metadata.functions.filter(row => row.oid === issuer[0].oid);
      assert.equal(oldIssuer.length, 1, 'Replacement preserves the original143 function OID');
      assert.equal(oldIssuer[0].proname, 'order_merge_transfer_custody');
      let replaced = 0;
      for (const [kind, oldRows] of Object.entries(before.metadata)) {
        const current = new Map(currentMetadata[kind].map(row => [row.oid, row]));
        for (const row of oldRows) {
          const actual = current.get(row.oid);
          if (kind === 'functions' && row.oid === issuer[0].oid) {
            assert(actual);
            const oldParts = functionEnvelope(row.definition), newParts = functionEnvelope(actual.definition);
            assert.deepEqual({ prefix: newParts.prefix, suffix: newParts.suffix },
              { prefix: oldParts.prefix, suffix: oldParts.suffix }, 'Only the declared function body changes');
            assert.equal(newParts.body, replacement145.body);
            assert.notEqual(newParts.body, oldParts.body, '145 must replace the historical104 body');
            assert.deepEqual({ ...actual, definition: row.definition }, row, 'Function identity/owner/ACL retained exactly');
            replaced++;
          } else assert.deepEqual(actual, row, 'Old143 OID/ACL/definition unchanged: ' + kind);
        }
      }
      assert.equal(replaced, 1);
    }
    await c.query('COMMIT');
    return { tables, own, earlier, catalog_global: catalogGlobal, migrations, metadata: currentMetadata };
  } finally { await c.query('ROLLBACK').catch(() => undefined); }
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert.equal(await realpath(ROOT), ROOT); assert.equal(process.argv.length, 3);
  assert(['before-migration', 'after-migration'].includes(phase)); assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(process.env.APP_REVISION, revision); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert(!process.env.DYNA_TEST);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(ROOT, '.local.json')); assert(!process.env.DYNA_PREVIEW_PORT);
  assert.equal(process.env.QA159_CHECKPOINT_CONFIRM, 'READ_ONLY_ORIGINAL162_QA157_BEFORE_NEW_PAIR');
  for (const name of ['data', 'docs']) { const p = resolve(ROOT, name), s = await lstat(p); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(p), p); }
  const output = resolve(ROOT, 'data/b2b-catalog-native159-' + phase + '.json');
  const report = resolve(ROOT, 'docs/b2b-catalog-native159-' + phase + '.json'); await absent(output); await absent(report);
  const setupBytes = await pinned(resolve(ROOT, 'data/product-catalogs-stage157.json'), process.env.QA157_SETUP_SHA256, 0o600);
  const setup: Row = JSON.parse(setupBytes.toString()); assert.equal(setup.stage, 157); assert.equal(setup.complete, true); assert.equal(setup.pending, null);
  assert.equal(setup.schema_revision, '142_product_catalogs'); actor = setup.actor; uuid(actor.tenant_id); uuid(actor.user_id);
  assert(typeof actor.cookie === 'string' && /^dyna_session=[A-Za-z0-9_.-]+$/.test(actor.cookie));
  const priorBytes = await pinned(resolve(WT, 'docs/product-catalogs-preservation157-before.json'), process.env.QA157_PRESERVATION_SHA256, 0o644);
  prior = JSON.parse(priorBytes.toString()); assert.equal(prior.status, 'PRESERVATION_PASS'); assert.equal(prior.stage, 157); assert.equal(prior.phase, 'before');
  assert.equal(prior.tenants.length, 162); prior.tenants.forEach(uuid); prior.users.forEach(uuid);
  assert.equal(Object.keys(prior.tables).length, 413); assert.equal(Object.keys(prior.private_files).length, 366); assert(!prior.tenants.includes(actor.tenant_id));
  const acceptedBytes = await pinned(resolve(ROOT, 'data/product-catalogs-checkpoint157-after-commerce.json'), process.env.QA157_ACCEPTED_SHA256, 0o600);
  accepted = JSON.parse(acceptedBytes.toString()); assert.equal(accepted.status, 'NATIVE_CATALOG_CHECKPOINT_PASS'); assert.equal(accepted.phase, 'after-commerce');
  assert.equal(accepted.stage, 157); assert.equal(accepted.tenant_id, actor.tenant_id); assert.equal(accepted.user_id, actor.user_id);
  assert.equal(accepted.setup_file_sha256, sha(setupBytes)); assert.equal(accepted.preservation_baseline_sha256, sha(priorBytes));
  const baselineBytes = await pinned(resolve(ROOT, 'data/catalog-export-catalogs-checkpoint158-before-native.json'), process.env.QA158_BEFORE_SHA256, 0o600);
  baseline = JSON.parse(baselineBytes.toString()); assert.equal(baseline.stage, 158); assert.equal(baseline.phase, 'before-native');
  assert.equal(baseline.status, 'READ_ONLY_CATALOG_EXPORT_CHECKPOINT_PASS'); assert.equal(baseline.schema_revision, '143_catalog_export_catalogs');
  assert.equal(baseline.tenant_id, actor.tenant_id); assert.equal(baseline.user_id, actor.user_id);
  assert.equal(baseline.setup_file_sha256, sha(setupBytes)); assert.equal(baseline.accepted157_sha256, sha(acceptedBytes)); assert.equal(baseline.preservation157_sha256, sha(priorBytes));
  assert.deepEqual(baseline.capture.rows, accepted.rows); assert.deepEqual(baseline.capture.snapshot, accepted.snapshot);
  assert.deepEqual(baseline.capture.global_catalog_rows, accepted.global_catalog_rows);
  const configBytes = await regular(resolve(ROOT, '.local.json'), 0o600, 65536); assert.equal(sha(configBytes), prior.config.sha256);
  for (const [name, entry] of Object.entries(prior.private_files) as [string, Row][]) {
    assert.match(name, /^[A-Za-z0-9_.-]+\.json$/); const bytes = await regular(resolve(ROOT, 'data', name), entry.mode); assert.equal(sha(bytes), entry.sha256);
  }
  let before: Capture | undefined, beforeBytes: Buffer | undefined;
  if (phase === 'after-migration') {
    beforeBytes = await pinned(resolve(ROOT, 'data/b2b-catalog-native159-before-migration.json'), process.env.QA159_BEFORE_SHA256, 0o600);
    const old: Row = JSON.parse(beforeBytes.toString()); assert.equal(old.stage, 159); assert.equal(old.phase, 'before-migration');
    assert.equal(old.status, 'READ_ONLY_B2B_CATALOG_CHECKPOINT_PASS'); assert.equal(old.schema_revision, '143_catalog_export_catalogs');
    assert.equal(old.inputs.setup157, sha(setupBytes)); assert.equal(old.inputs.accepted157, sha(acceptedBytes));
    assert.equal(old.inputs.preservation162, sha(priorBytes)); assert.equal(old.inputs.checkpoint158, sha(baselineBytes)); assert.equal(old.inputs.config, sha(configBytes));
    before = old.capture;
    const sql = await pinned(resolve(ROOT, 'server/145_order_merge_counters.sql'), process.env.QA159_MERGE145_SHA256, 0o644, 128 * 1024);
    const source = sql.toString('utf8');
    assert.equal((source.match(/CREATE OR REPLACE FUNCTION /g) ?? []).length, 1);
    const body = /CREATE OR REPLACE FUNCTION order_merge_transfer_custody\(p_execution uuid\) RETURNS void\s+LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS \$\$([\s\S]*?)\$\$;/.exec(source);
    assert(body, 'Expected the exact declared145 issuer');
    replacement145 = { function: 'public.order_merge_transfer_custody(uuid)', source_sha256: sha(sql), body_sha256: sha(body[1]), body: body[1] };
  }
  await health(); const me = await get('/auth/me'); assert.equal(me.user.id, actor.user_id); assert.equal(me.user.tenant_id, actor.tenant_id); assert.equal(me.user.role, 'admin');
  const config: Row = JSON.parse(configBytes.toString()); assert.equal(typeof config.dbPassword, 'string');
  if (process.env.DATABASE_URL) { const u = new URL(process.env.DATABASE_URL); assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/dynaminds'); assert.equal(u.username, 'postgres'); }
  client = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: config.dbPassword, database: 'dynaminds' }); await client.connect();
  assert.deepEqual((await client.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0], { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
  step = 'capture'; const first = await capture(before); await health();
  step = 'read-only-unchanged'; const final = await capture(before); assert.deepEqual(final, first, 'No business or schema drift while checkpoint reads');
  step = 'custody'; for (const [file, entry] of inputs) assert.equal(sha(await regular(file, entry.mode, entry.max)), entry.sha256);
  const inputHashes = { setup157: sha(setupBytes), accepted157: sha(acceptedBytes), preservation162: sha(priorBytes), checkpoint158: sha(baselineBytes), config: sha(configBytes), ...(beforeBytes ? { before159: sha(beforeBytes) } : {}), ...(replacement145 ? { merge145: replacement145.source_sha256 } : {}) };
  const declaredReplacement = replacement145 ? { function: replacement145.function, source_sha256: replacement145.source_sha256,
    body_sha256: replacement145.body_sha256, oid_owner_acl_retained: true, all_other_old_definitions_retained: true } : undefined;
  const checkpoint = { stage: 159, phase, status: 'READ_ONLY_B2B_CATALOG_CHECKPOINT_PASS', revision, schema_revision: schema,
    inputs: inputHashes, capture: first, ...(declaredReplacement ? { declared_replaced_function: declaredReplacement } : {}),
    sessions_excluded: true, helper_business_mutations: 0, fixture_prepared: false, baseline_rebased: false };
  await wx(output, checkpoint, 0o600);
  await wx(report, { stage: 159, phase, status: checkpoint.status, revision, schema_revision: schema,
    historical_firms: 162, qa157_firms: 1, historical_old_tables: 413, qa157_business_tables: 420,
    full_business_tables_excluding_sessions: Object.keys(first.tables).length,
    global_snapshot_sha256: fp(Object.fromEntries(Object.entries(first.tables).map(([name, table]) => [name, table.fingerprint]))),
    qa157_snapshot_sha256: fp(first.own), historical_snapshot_sha256: fp(first.earlier), global_catalog_sha256: fp(first.catalog_global),
    schema_metadata_sha256: fp(first.metadata), old_schema_objects_retained: Boolean(before),
    ...(declaredReplacement ? { declared_replaced_function: declaredReplacement } : {}),
    new144_tables: before ? Object.fromEntries(NEW.map(name => [name, first.tables[name].fingerprint])) : {},
    private_original_files_preserved: 366, config_preserved: true, input_hashes: inputHashes,
    checkpoint_sha256: sha(await readFile(output)), api_gets: reads, sessions_excluded: true,
    helper_business_mutations: 0, fixture_prepared: false, baseline_rebased: false,
    worker_verified: false, provider_verified: false, native_ui_verified: false, full_goal_complete: false }, 0o644);
  process.stdout.write('READ_ONLY_B2B_CATALOG_CHECKPOINT_PASS\n');
}
main().catch((error: unknown) => {
  const stack = error instanceof Error ? error.stack ?? '' : '', match = stack.match(/b2b-catalog-native159-setup\.ts:(\d+):(\d+)/);
  process.stderr.write(JSON.stringify({ status: 'QA159_CHECKPOINT_FAILED', step,
    ...(match ? { source_line: Number(match[1]), source_column: Number(match[2]) } : {}), private_details_withheld: true }) + '\n'); process.exitCode = 1;
}).finally(async () => {
  try { await client?.end(); } catch {
    process.stderr.write('QA159_CHECKPOINT_CLOSE_FAILED_PRIVATE_DETAILS_WITHHELD\n'); process.exitCode = 1;
  }
});
