/** ROOT ONLY, SOURCE AUTHORED. Separately created148 restore; GET/READ ONLY.
 * No backup/restore/migration/login/worker/business request/disposal.
 * Exported metadata capture has no import-time CLI/config/app/DB side effects.
 * CLI cwd=primary, APP_REVISION=QA_EXPECTED_REVISION, workers OFF, preview4198.
 * QA162_RESTORE_CONFIRM=READ_ONLY_ACCEPTED_148_COPY_BEFORE_LOGIN.
 * Required SHA env: CONFIG, SETUP, ORIGINAL_SETUP, ACCEPTED, MIGRATION_BEFORE,
 * MIGRATION_AFTER, SQL, RESTORE_RESULT (QA162_<name>_SHA256).
 * QA162_ACCEPTED_PHASE=after-on|after-restart; QA162_ARCHIVE_REVISION=<40hex>.
 * QA162_RESTORE_RESULT_PATH=<primary>/data/return-destinations-backup162-UUID/
 * restore/16hex/result.json. Distinct fixed wx0600 sidecars, no resume/rebase.
 */
import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { createHash, createDecipheriv } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { validateReturnAssistantPhoto } from '../server/return-assistant-photo';

type Row = Record<string, any>;
type QueryClient = Pick<pg.Client, 'query'>;
const ROOT = '<workspace>/app';
const SCHEMA = '148_return_destinations';
const FAILED_SETUP_SHA = '189961869a10b03c5642221b810243bbe11c75734fb69a31474519be72c502dd';
const sidecars = ['return_destination_parts', 'return_destination_arrivals',
  'return_destination_fragments', 'return_destination_admissions'];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const shaPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Portable catalogue, not a migration oracle. OIDs/physical statistics/XIDs
 * differ in a real pg_restore; signatures, bodies, owners, effective grants,
 * table/column/policy/constraint/index definitions and trigger flags must match.
 * Caller owns one UTC RR READ ONLY transaction; this function starts none.
 */
export async function captureReturnDestinationRestoreMetadata(c: QueryClient) {
  const tables = (await c.query(`SELECT cl.relname,cl.relkind,
    pg_get_userbyid(cl.relowner) owner,cl.relrowsecurity,cl.relforcerowsecurity,cl.reloptions,
    (SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]') FROM (
      SELECT jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable) x
      FROM aclexplode(coalesce(cl.relacl,acldefault(CASE WHEN cl.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,cl.relowner))) a) q) acl,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'position',a.attnum,
      'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity,
      'default',pg_get_expr(d.adbin,d.adrelid),'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END,
      'acl',(SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]') FROM (
        SELECT jsonb_build_object('grantor',pg_get_userbyid(g.grantor),'grantee',CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,
          'privilege',g.privilege_type,'grantable',g.is_grantable) x FROM aclexplode(a.attacl) g) q)) ORDER BY a.attnum),'[]')
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum)
      WHERE a.attrelid=cl.oid AND a.attnum>0 AND NOT a.attisdropped) columns,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
      'roles',(SELECT jsonb_agg(CASE WHEN u.role=0 THEN 'PUBLIC' ELSE pg_get_userbyid(u.role) END ORDER BY CASE WHEN u.role=0 THEN 'PUBLIC' ELSE pg_get_userbyid(u.role) END) FROM unnest(p.polroles) u(role)),
      'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname),'[]')
      FROM pg_policy p WHERE p.polrelid=cl.oid) policies,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'deferred',k.condeferred,
      'deferrable',k.condeferrable,'validated',k.convalidated,'definition',pg_get_constraintdef(k.oid,true)) ORDER BY k.conname),'[]')
      FROM pg_constraint k WHERE k.conrelid=cl.oid) constraints,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),
      'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive) ORDER BY ic.relname),'[]')
      FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=cl.oid) indexes
    FROM pg_class cl WHERE cl.relnamespace='public'::regnamespace AND cl.relkind IN('r','p','v','m','S') ORDER BY cl.relname`)).rows;
  const functions = (await c.query(`SELECT p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,
    p.prosecdef,p.proconfig,p.prokind,p.provolatile,p.proparallel,p.proleakproof,p.proisstrict,
    pg_get_functiondef(p.oid) definition,
    (SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]') FROM (
      SELECT jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable) x FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) q) acl
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN('f','p') ORDER BY p.oid::regprocedure::text`)).rows;
  const triggers = (await c.query(`SELECT r.relname,t.tgname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,
    t.tgfoid::regprocedure::text function,pg_get_triggerdef(t.oid,false) definition
    FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
    WHERE r.relnamespace='public'::regnamespace AND NOT t.tgisinternal ORDER BY r.relname,t.tgname`)).rows;
  return { tables, functions, triggers };
}

async function directory(path: string) {
  const stat = await lstat(path); assert(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await realpath(path), path);
}
async function bytes(path: string, max = 512 * 1024 * 1024) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, 0o600); assert(s.size > 0 && s.size <= max);
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = await f.stat(); assert.equal(a.ino, s.ino); assert.equal(a.dev, s.dev);
    const result = await f.readFile(); const b = await f.stat();
    assert.equal(b.size, s.size); assert.equal(b.mtimeMs, s.mtimeMs); assert.equal(b.mode, s.mode);
    assert.equal(result.length, s.size); return result;
  } finally { await f.close(); }
}
async function absent(path: string) {
  try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive output exists');
}
async function wx(path: string, value: unknown) {
  await directory(dirname(path)); const body = JSON.stringify(value, null, 2) + '\n';
  assert(Buffer.byteLength(body) <= 512 * 1024 * 1024);
  const f = await open(path, 'wx', 0o600);
  try { await f.writeFile(body); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); }
  return hash(body);
}
async function stableHash(path: string) {
  const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink());
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stable = (s: typeof stat) => { assert(s.isFile()); for (const k of ['size', 'mtimeMs', 'dev', 'ino', 'mode'] as const) assert.equal(s[k], stat[k]); };
  try {
    stable(await f.stat()); const h = createHash('sha256'); let count = 0;
    for await (const b of createReadStream(path, { fd: f.fd, autoClose: false })) { h.update(b); count += b.length; }
    assert.equal(count, stat.size); stable(await f.stat()); stable(await lstat(path));
    return { sha256: h.digest('hex'), mode: stat.mode & 0o777, size: stat.size };
  } finally { await f.close(); }
}

async function main() {
  let step = 'preflight', c: pg.Client | undefined;
  const output = resolve(ROOT, 'data/return-destinations-native162-restore-readback.json');
  const publicOutput = resolve(ROOT, 'docs/return-destinations-native162-restore-readback.json');
  const pins = new Map<string, string>();
  const streamedPins = new Map<string, { sha256: string; mode: number; size: number }>();
  try {
    assert.equal(await realpath(process.cwd()), ROOT);
    assert.equal(process.env.DYNA_TEST, undefined); assert.equal(process.env.DATABASE_URL, undefined);
    assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.equal(process.env.DYNA_PREVIEW_PORT, '4198');
    assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(ROOT, '.local.json'));
    assert.equal(process.env.QA162_RESTORE_CONFIRM, 'READ_ONLY_ACCEPTED_148_COPY_BEFORE_LOGIN');
    const revision = process.env.QA_EXPECTED_REVISION ?? ''; assert.match(revision, /^[a-f0-9]{40}$/);
    assert.equal(process.env.APP_REVISION, revision);
    await directory(resolve(ROOT, 'data')); await directory(resolve(ROOT, 'docs'));
    await absent(output); await absent(publicOutput);
    async function pin(path: string, expected: string | undefined, max?: number) {
      assert.match(expected ?? '', shaPattern); const b = await bytes(path, max);
      assert.equal(hash(b), expected); pins.set(path, expected!); return JSON.parse(b.toString('utf8')) as Row;
    }
    const config = await pin(resolve(ROOT, '.local.json'), process.env.QA162_CONFIG_SHA256, 65536);
    assert.match(config.encryptionKey, shaPattern);
    assert.equal(process.env.QA162_ORIGINAL_SETUP_SHA256, FAILED_SETUP_SHA);
    const originalSetup = await pin(resolve(ROOT, 'data/return-destinations-native162-setup.json'), process.env.QA162_ORIGINAL_SETUP_SHA256);
    assert.equal(originalSetup.stage, 162); assert.equal(originalSetup.status, 'FAILED_NO_RESUME');
    assert.equal(originalSetup.pending, null); assert.equal(originalSetup.complete, false); assert.equal(originalSetup.completed.length, 49);
    assert.equal(originalSetup.off.complete, true); assert.equal(originalSetup.on.complete, false);
    const setup = await pin(resolve(ROOT, 'data/return-destinations-native162-setup-completion.json'), process.env.QA162_SETUP_SHA256);
    assert.equal(setup.stage, 162); assert.equal(setup.schema_revision, SCHEMA);
    assert.equal(setup.status, 'OWN_OFF_ON_SOURCES_READY_FOR_CHROME'); assert.equal(setup.complete, true);
    assert.equal(setup.pending, null); assert.equal(setup.off.complete, true); assert.equal(setup.on.complete, true);
    assert.equal(setup.completed.length, 66); assert.deepEqual(setup.completed.slice(0, 49), originalSetup.completed);
    assert.equal(setup.basis.path, 'data/return-destinations-native162-setup.json'); assert.equal(setup.basis.sha256, FAILED_SETUP_SHA);
    assert.equal(setup.basis.status, 'FAILED_NO_RESUME'); assert.equal(setup.basis.acknowledged_operations, 49);
    assert.equal(setup.basis.original_preserved, true);
    assert.deepEqual(setup.basis.completed_labels, originalSetup.completed.map((r: Row) => [r.actor, r.label]));
    assert.equal(setup.config_sha256, process.env.QA162_CONFIG_SHA256);
    const phase = process.env.QA162_ACCEPTED_PHASE; assert(phase === 'after-on' || phase === 'after-restart');
    const accepted = await pin(resolve(ROOT, 'data/return-destinations-native162-readback-' + phase + '.json'), process.env.QA162_ACCEPTED_SHA256);
    assert.equal(accepted.stage, 162); assert.equal(accepted.phase, phase); assert.equal(accepted.schema_revision, SCHEMA);
    // Accepted status is frozen by the native readback author; pending phases
    // and a migration-only checkpoint must never become intake evidence.
    assert.equal(accepted.status, 'RETURN_DESTINATIONS_NATIVE_READBACK_PASS');
    assert.equal(accepted.setup_sha256, process.env.QA162_SETUP_SHA256);
    assert.equal(accepted.original_setup_sha256, process.env.QA162_ORIGINAL_SETUP_SHA256);
    assert.equal(accepted.config_sha256, process.env.QA162_CONFIG_SHA256);
    assert(accepted.capture?.rows && accepted.capture.portable_metadata);
    for (const label of ['off', 'on']) {
      assert(accepted.actors?.[label]);
      for (const name of ['tenant_id', 'user_id', 'order_id', 'return_id']) assert.equal(accepted.actors[label][name], setup[label][name]);
    }
    assert.notEqual(setup.off.tenant_id, setup.on.tenant_id);
    const before = await pin(resolve(ROOT, 'data/return-destinations-native162-before.json'), process.env.QA162_MIGRATION_BEFORE_SHA256);
    const after = await pin(resolve(ROOT, 'data/return-destinations-native162-after.json'), process.env.QA162_MIGRATION_AFTER_SHA256);
    assert.equal(before.status, 'READ_ONLY_CAPTURED'); assert.equal(before.schema, '147_return_destination_statuses');
    assert.equal(after.status, 'EXACT_ADDITIVE_MIGRATION_VERIFIED'); assert.equal(after.schema, SCHEMA);
    assert.equal(after.before_sha256, process.env.QA162_MIGRATION_BEFORE_SHA256);
    assert.equal(after.source_sql_sha256, process.env.QA162_SQL_SHA256);
    assert.match(process.env.QA162_SQL_SHA256 ?? '', shaPattern);
    const sqlPath = resolve(ROOT, 'server/148_return_destinations.sql');
    assert.equal((await stableHash(sqlPath)).sha256, process.env.QA162_SQL_SHA256);
    const resultPath = process.env.QA162_RESTORE_RESULT_PATH ?? '';
    const match = /^\/Users\/arturtwardowski\/DYNA Ecomerce\/app\/data\/(return-destinations-backup162-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/restore\/([a-f0-9]{16})\/result\.json$/.exec(resultPath);
    assert(match); const base = resolve(ROOT, 'data', match[1]);
    for (const dir of [base, resolve(base, 'restore'), dirname(resultPath)]) await directory(dir);
    const result = await pin(resultPath, process.env.QA162_RESTORE_RESULT_SHA256, 65536);
    const database = 'dynaminds_restore_' + match[2];
    assert.equal(result.id, match[2]); assert.equal(result.database, database); assert.equal(result.directory, dirname(resultPath));
    assert.equal(result.config, resolve(result.directory, 'local-config.json')); assert.equal(result.images, resolve(result.directory, 'images'));
    assert.equal(result.source, 'dynaminds'); assert.equal(result.status, 'verified'); assert.equal(result.preview_only, true);
    assert.equal(result.worker_enabled, false); assert.equal(result.row_fingerprints_match, true); assert.equal(result.schema_fingerprint_match, true);
    const archiveRevision = process.env.QA162_ARCHIVE_REVISION ?? ''; assert.match(archiveRevision, /^[a-f0-9]{40}$/);
    assert.equal(result.revision, archiveRevision);
    const restoredConfigBytes = await bytes(result.config, 65536); pins.set(result.config, hash(restoredConfigBytes));
    const restoredConfig = JSON.parse(restoredConfigBytes.toString('utf8'));
    assert.deepEqual(Object.keys(restoredConfig).sort(), ['dbPassword', 'encryptionKey']);
    assert.equal(restoredConfig.encryptionKey, config.encryptionKey); assert(typeof restoredConfig.dbPassword === 'string' && restoredConfig.dbPassword);
    const manifestPath = resolve(result.directory, 'manifest.json');
    const manifestBytes = await bytes(manifestPath, 67108864); pins.set(manifestPath, hash(manifestBytes));
    const manifest = JSON.parse(manifestBytes.toString('utf8')); assert.equal(manifest.schema_fingerprint_version, 4);
    assert.equal(manifest.database, 'dynaminds'); assert.equal(manifest.revision, archiveRevision);
    assert.equal(result.tables, Object.keys(accepted.capture.rows).length);
    assert.equal(Object.keys(manifest.tables).length, result.tables);
    const dumpPath = resolve(result.directory, 'database.dump'), dump = await stableHash(dumpPath);
    assert.equal(dump.sha256, manifest.dump.sha256); assert.equal(dump.size, manifest.dump.size); streamedPins.set(dumpPath, dump);
    const images: Row[] = manifest.images; assert(Array.isArray(images)); assert.equal(result.image_count, images.length);
    await directory(result.images); assert.equal(new Set(images.map(i => i.id)).size, images.length);
    for (const image of images) { assert.match(image.id, uuidPattern); const path = resolve(result.images, image.id), f = await stableHash(path); assert.equal(f.sha256, image.sha256); assert.equal(f.size, image.size); streamedPins.set(path, f); }
    async function custody() {
      for (const [path, digest] of pins) assert.equal(hash(await bytes(path)), digest);
      for (const [path, expected] of streamedPins) assert.deepEqual(await stableHash(path), expected);
      for (const [relative, expected] of Object.entries(before.capture.files) as [string, Row][]) {
        assert(relative === '.local.json' || relative.startsWith('data/'));
        assert.equal(resolve(ROOT, relative).startsWith(ROOT + '/'), true);
        assert.deepEqual(await stableHash(resolve(ROOT, relative)), expected);
      }
      assert.equal((await stableHash(sqlPath)).sha256, process.env.QA162_SQL_SHA256);
    }
    async function health() {
      const r = await fetch('http://127.0.0.1:4198/api/health', { redirect: 'error', signal: AbortSignal.timeout(15000) });
      assert.equal(r.status, 200); const b = Buffer.from(await r.arrayBuffer()); assert(b.length < 65536);
      const h = JSON.parse(b.toString('utf8')); assert.equal(h.status, 'ok'); assert.equal(h.mode, 'local');
      assert.equal(h.revision, revision); assert.equal(h.schema_revision, SCHEMA); assert.equal(h.restore_preview, true);
      assert.equal(h.background_workers_enabled, false); assert.equal(h.return_destinations_available, true);
      assert.equal(h.warehouse_inventory_policies_available, true); assert.equal(h.return_destination_statuses_available, true);
    }
    step = 'custody-before'; await custody(); await health();
    c = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: restoredConfig.dbPassword,
      database, connectionTimeoutMillis: 5000, options: '-c default_transaction_read_only=on -c TimeZone=UTC' });
    c.on('error', () => {}); await c.connect();
    async function capture() {
      assert(c); await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
      try {
        assert.deepEqual((await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],
          { db: database, role: 'postgres', owner: 'postgres', host: '127.0.0.1', port: 55432, readonly: 'on' });
        const rows: Record<string, Row[]> = {};
        for (const { tablename } of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows) {
          assert.match(tablename, /^[a-z][a-z0-9_]*$/); rows[tablename] = (await c.query(`SELECT to_jsonb(x) row FROM public."${tablename}" x ORDER BY 1`)).rows;
        }
        assert.deepEqual(rows, accepted.capture.rows, 'Exact full-global UTC rows incl sessions before any copy login');
        const portable_metadata = await captureReturnDestinationRestoreMetadata(c);
        assert.deepEqual(portable_metadata, accepted.capture.portable_metadata);
        assert.equal((await c.query('SELECT public.return_destination_installed() AND public.return_destination_guards() ok')).rows[0].ok, true);
        for (const table of sidecars) assert(rows[table]);
        const proofs: Row[] = [];
        for (const actor of [accepted.actors?.off, accepted.actors?.on]) {
          assert(actor); for (const name of ['tenant_id', 'user_id', 'return_id', 'receipt_id', 'session_id', 'preview_id']) assert.match(actor[name], uuidPattern);
          const matches = rows.return_assistant_receipts.filter(r => r.row.id === actor.receipt_id && r.row.tenant_id === actor.tenant_id && r.row.actor_id === actor.user_id && r.row.order_id === actor.order_id && r.row.return_id === actor.return_id && r.row.session_id === actor.session_id && r.row.preview_id === actor.preview_id);
          assert.equal(matches.length, 1);
          assert(rows.return_destination_admissions.some(r => r.row.receipt_id === actor.receipt_id && r.row.tenant_id === actor.tenant_id));
          assert(rows.return_destination_parts.some(r => r.row.receipt_id === actor.receipt_id && r.row.tenant_id === actor.tenant_id));
          proofs.push({ receipt_sha256: hash(JSON.stringify(matches[0])), destination_parts: rows.return_destination_parts.filter(r => r.row.receipt_id === actor.receipt_id).length });
        }
        let photoCount = 0;
        for (const { row } of rows.return_assistant_photos) {
          const b = Buffer.from(row.content_encrypted, 'base64'); assert(b.length >= 28);
          const d = createDecipheriv('aes-256-gcm', Buffer.from(restoredConfig.encryptionKey, 'hex'), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
          const value = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
          const verified = validateReturnAssistantPhoto({ mime: row.mime, content_base64: value.content_base64 });
          assert.equal(verified.byte_count, row.byte_count); assert.equal(verified.sha256, row.sha256);
          assert.equal(verified.width, row.width); assert.equal(verified.height, row.height); photoCount++;
        }
        await c.query('COMMIT'); return { rows, portable_metadata, proofs, photoCount };
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
    }
    step = 'copy-exact'; const first = await capture();
    step = 'read-effect-free'; await health(); await custody(); assert.deepEqual(await capture(), first);
    const report = { stage: 162, status: 'RETURN_DESTINATIONS_RESTORED_READBACK_PASS', phase: 'restored-copy-before-login',
      runtime_revision: revision, archive_revision: archiveRevision, accepted_runtime_revision: accepted.runtime_revision,
      schema_revision: SCHEMA, accepted_sha256: process.env.QA162_ACCEPTED_SHA256,
      completed_setup_sha256: process.env.QA162_SETUP_SHA256, original_failed_setup_sha256: process.env.QA162_ORIGINAL_SETUP_SHA256,
      restore_result_sha256: process.env.QA162_RESTORE_RESULT_SHA256, source_sql_sha256: process.env.QA162_SQL_SHA256,
      global_tables: Object.keys(first.rows).length, full_global_rows_exact: true, sessions_included: true,
      portable_metadata_exact: true, effective_acl_not_raw_oid_identity: true, sidecars: 4, accepted_receipts: first.proofs.length,
      decrypted_photos_validated: first.photoCount, product_images_verified: images.length,
      original_migration_file_custody_exact: true, source_inputs_unchanged: true,
      login_performed: false, business_mutations_performed: false, authenticated_copy_ui: false,
      malformed_write_423_verified: false, provider_verified: false, raw_principal_verified: false, raw_terminal_pin_verified: false };
    const privateSha = await wx(output, { ...report, capture: first });
    await wx(publicOutput, { ...report, private_sha256: privateSha }); console.log(JSON.stringify({ ...report, private_sha256: privateSha }));
  } catch (e) {
    const frame = e instanceof Error ? e.stack?.match(/return-destinations-native162-restore-readback\.ts:(\d+):(\d+)/) : undefined;
    console.log(JSON.stringify({ stage: 162, status: 'FAIL', step, source_line: frame ? Number(frame[1]) : null,
      code: (e as { code?: string }).code === 'ERR_ASSERTION' ? 'ERR_ASSERTION' : 'RESTORE_READBACK_FAILURE' })); process.exitCode = 1;
  } finally { await c?.end().catch(() => undefined); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
