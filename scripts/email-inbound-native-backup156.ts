/** ROOT ONLY, one shot after accepted QA156 Chrome/local SMTP.
 * Creates a fresh encrypted whole-instance archive and a fresh isolated restore.
 * Never sends email, runs workers, migrates, corrupts source rows or drops a database.
 * Successful restore/archive/key are retained for root's separate readonly API proof.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';

const root = '<workspace>/app';
const schema = '141_email_inbound',
  revision = process.env.QA_EXPECTED_REVISION ?? '';
const acceptedPath = resolve(root, 'data/email-inbound-chrome156.json');
const setupPath = resolve(root, 'data/email-inbound-stage156.json');
const fixturePath = resolve(root, 'data/imap-fixture156/config.json');
const configPath = resolve(root, '.local.json');
const journalPath = resolve(root, 'data/email-inbound-backup156.json');
const reportPath = resolve(root, 'docs/email-inbound-native-backup156.json');
const directory = resolve(root, 'data/email-inbound-backup156-' + randomUUID());
const keyPath = resolve(directory, 'recovery-key');
const tables = [
  'email_inbound_accounts',
  'email_inbound_acquisitions',
  'email_inbound_sources',
  'email_inbound_previews',
  'email_inbound_messages',
  'email_inbound_bindings',
  'email_inbound_reply_previews',
  'email_inbound_replies',
  'email_inbound_operations',
  'email_inbound_admissions',
] as const;
type Row = Record<string, any>;
type Recovery = typeof import('../server/recovery');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value));
const preserved = new Map<string, Buffer>();
let source: pg.Client | undefined, copy: pg.Client | undefined, pool: pg.Pool | undefined;
let journal: Row | undefined,
  step = 'preflight';
function same(actual: unknown, expected: unknown, label: string) {
  assert(isDeepStrictEqual(actual, expected), label);
}
function uuid(value: unknown): asserts value is string {
  assert(
    typeof value === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value),
    'Canonical fixture identity',
  );
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('Exclusive output already exists');
}
async function privateRead(path: string, max = 128 * 1024 * 1024) {
  const s = await lstat(path);
  assert(
    s.isFile() && !s.isSymbolicLink() && (s.mode & 0o777) === 0o600 && s.size > 0 && s.size <= max,
    'Private regular custody file',
  );
  const bytes = await readFile(path);
  preserved.set(path, bytes);
  return bytes;
}
async function wx(path: string, value: unknown, mode = 0o600) {
  const f = await open(path, 'wx', mode);
  try {
    await f.writeFile(JSON.stringify(value, null, 2) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
}
async function save() {
  const s = await lstat(journalPath);
  assert(s.isFile() && !s.isSymbolicLink() && (s.mode & 0o777) === 0o600);
  const tmp = journalPath + '.' + randomUUID() + '.tmp';
  try {
    await wx(tmp, journal);
    await rename(tmp, journalPath);
    const d = await open(dirname(journalPath), 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
async function custody<T>(label: string, action: () => Promise<T>): Promise<T> {
  assert(journal && journal.pending === null);
  step = label;
  journal.pending = { step: label, started_at: new Date().toISOString() };
  await save();
  const result = await action();
  journal.completed.push({ step: label, completed_at: new Date().toISOString() });
  journal.pending = null;
  await save();
  return result;
}
async function fileSha(path: string) {
  const h = createHash('sha256');
  for await (const b of createReadStream(path)) h.update(b);
  return h.digest('hex');
}
async function health() {
  const r = await fetch('http://127.0.0.1:4100/api/health', {
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(r.status, 200);
  const h = await r.json();
  assert.equal(h.status, 'ok');
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema);
  assert.equal(h.mode, 'local');
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.restore_preview, false);
  assert.equal(h.email_inbound_available, true);
}
async function rr<T>(c: pg.Client, action: () => Promise<T>) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    const result = await action();
    await c.query('COMMIT');
    return result;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
  }
}
async function inbound(c: pg.Client) {
  const rows: Record<string, Row[]> = {},
    snapshot: Row = {};
  for (const table of tables) {
    rows[table] = (await c.query(`SELECT to_jsonb(x) row FROM ${table} x ORDER BY 1`)).rows;
    snapshot[table] = { count: rows[table].length, sha256: hash(rows[table]) };
  }
  return { rows, snapshot };
}
async function own(c: pg.Client, tenant: string, user: string) {
  const names = (
    await c.query(
      "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND(table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY 1",
    )
  ).rows;
  const rows: Record<string, Row[]> = {},
    snapshot: Row = {};
  for (const { table_name: table } of names) {
    assert.match(table, /^[a-z][a-z0-9_]*$/);
    const field = ['users', 'tenants'].includes(table) ? 'id' : 'tenant_id';
    rows[table] = (
      await c.query(`SELECT to_jsonb(x) row FROM "${table}" x WHERE ${field}=$1 ORDER BY 1`, [
        table === 'users' ? user : tenant,
      ])
    ).rows;
    snapshot[table] = { count: rows[table].length, sha256: hash(rows[table]) };
  }
  return { rows, snapshot };
}
async function main() {
  assert.equal(resolve(process.cwd()), root);
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, configPath);
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.equal(
    process.env.APP_REVISION,
    revision,
    'Backup manifest must carry the verified revision',
  );
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(
    process.env.QA156_NATIVE_BACKUP_CONFIRM,
    'BACKUP_ACCEPTED_OWN_EMAIL_AND_RETAIN_ISOLATED_RESTORE',
  );
  for (const d of ['data', 'docs']) {
    const s = await lstat(resolve(root, d));
    assert(s.isDirectory() && !s.isSymbolicLink());
  }
  for (const path of [journalPath, reportPath, directory]) await absent(path);
  const acceptedBytes = await privateRead(acceptedPath),
    setupBytes = await privateRead(setupPath),
    fixtureBytes = await privateRead(fixturePath, 32768);
  assert.equal(
    sha(acceptedBytes),
    process.env.QA156_CHROME_SHA256,
    'Exact accepted Chrome custody bytes',
  );
  assert.equal(sha(setupBytes), process.env.QA156_PREPARE_SHA256, 'Exact original prepare bytes');
  await privateRead(configPath, 32768);
  const accepted: Row = JSON.parse(acceptedBytes.toString()),
    setup: Row = JSON.parse(setupBytes.toString()),
    fixture: Row = JSON.parse(fixtureBytes.toString());
  assert.equal(accepted.stage, 156);
  assert.equal(accepted.status, 'VERIFIED_LOCAL_SMTP');
  assert.equal(accepted.schema_revision, schema);
  assert.equal(accepted.pending, null);
  assert.equal(accepted.prepare_sha256, sha(setupBytes));
  assert.equal(accepted.fixture_config_sha256, sha(fixtureBytes));
  assert.equal(setup.stage, 156);
  assert.equal(setup.pending, null);
  assert.equal(setup.phase, 'prepare');
  assert.equal(setup.status, 'PHASE_COMPLETE');
  assert.equal(fixture.stage, 156);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.host, '127.0.0.1');
  assert.equal(fixture.port, 4112);
  const ids = accepted.ids;
  for (const key of [
    'tenant_id',
    'user_id',
    'order_id',
    'account_id',
    'reply_id',
    'job_id',
    'email_message_id',
    'batch_id',
  ])
    uuid(ids[key]);
  for (const key of ['tenant_id', 'user_id', 'order_id']) assert.equal(ids[key], setup.actor[key]);
  assert.equal(ids.account_id, setup.actor.account.id);
  assert.equal(accepted.smtp_proof.accepted_by_local_smtp, true);
  assert.equal(accepted.smtp_proof.delivered, false);
  assert(
    accepted.verify_checkpoint?.rows && accepted.verify_checkpoint?.snapshot,
    'Accepted complete native checkpoint',
  );
  await health();
  const recovery: Recovery = await import('../server/recovery'),
    db = await import('../server/db');
  pool = db.pool;
  const local = recovery.localDatabase();
  assert.equal(local.database, 'dynaminds');
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.port, 55432);
  source = new pg.Client(local);
  await source.connect();
  const native = (
    await source.query(
      'SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port',
    )
  ).rows[0];
  same(
    native,
    { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 },
    'Exact local native source',
  );
  const baseline = await rr(source, async () => {
    const captured = await own(source!, ids.tenant_id, ids.user_id);
    same(captured, accepted.verify_checkpoint, 'Native accepted own checkpoint must be unchanged');
    const ownSources = captured.rows.email_inbound_sources.map((x) => x.row);
    assert.equal(ownSources.length, 3);
    same(
      ownSources.map((x) => x.uid).sort(),
      ['1', '2', '4'],
      'Exactly the accepted own three sources',
    );
    for (const s of ownSources) {
      const m = fixture.messages.find((m: Row) => String(m.uid) === s.uid);
      assert(m, 'Known own fixture source');
      assert.equal(m.file, 'message-' + s.uid + '.eml');
      const raw = await privateRead(resolve(root, 'data/imap-fixture156', m.file), 4194304);
      assert.equal(s.raw_sha256, sha(raw));
      assert.equal(s.raw_bytes, raw.length);
    }
    const em = captured.rows.email_messages
      .map((x) => x.row)
      .filter((x) => x.id === ids.email_message_id);
    assert.equal(em.length, 1);
    assert.equal(em[0].state, 'smtp_accepted');
    assert(em[0].attempted_at);
    assert.equal(em[0].job_id, ids.job_id);
    assert.equal(em[0].batch_id, ids.batch_id);
    const { validateRecoveredInboundEmail } = await import('../server/email-inbound-recovery');
    const verified = await validateRecoveredInboundEmail(source!, db.localConfig.encryptionKey);
    assert(verified >= 4);
    return {
      manifest: await recovery.tableFingerprints(source!),
      schema: await recovery.schemaFingerprint(source!),
      inbound: await inbound(source!),
      own: captured,
      encrypted_records_verified: verified,
    };
  });
  const beforeDatabases = (
    await source.query('SELECT datname FROM pg_database ORDER BY datname')
  ).rows.map((x) => x.datname);
  await mkdir(directory, { mode: 0o700 });
  const ds = await lstat(directory);
  assert(ds.isDirectory() && !ds.isSymbolicLink() && (ds.mode & 0o777) === 0o700);
  const k = await open(keyPath, 'wx', 0o600);
  try {
    await k.writeFile(randomBytes(32).toString('hex') + '\n');
    await k.sync();
  } finally {
    await k.close();
  }
  await privateRead(keyPath, 100);
  journal = {
    stage: 156,
    status: 'IN_PROGRESS',
    revision,
    schema_revision: schema,
    accepted_custody_sha256: sha(acceptedBytes),
    setup_file_sha256: sha(setupBytes),
    pending: null,
    completed: [],
    directory,
    key_path: keyPath,
    source: {
      manifest: baseline.manifest,
      schema: baseline.schema,
      inbound_rows: baseline.inbound.rows,
      inbound_snapshot: baseline.inbound.snapshot,
      own_snapshot: baseline.own.snapshot,
    },
    provider_verified: false,
    delivered: false,
  };
  await wx(journalPath, journal);
  const backup = await custody('encrypted-whole-backup', async () => {
    const b = await recovery.createBackup({
      directory: resolve(directory, 'backup'),
      keyFile: keyPath,
    });
    journal!.backup = b;
    await save();
    return b;
  });
  assert.equal(backup.status, 'created');
  assert.equal(backup.source, 'dynaminds');
  assert.equal(backup.encryption, 'AES-256-GCM');
  assert.equal(backup.tables, Object.keys(baseline.manifest).length);
  assert.equal(await fileSha(backup.file), backup.sha256);
  const restored = await custody('isolated-whole-restore', async () => {
    const r = await recovery.restoreBackup(backup.file, {
      directory: resolve(directory, 'restore'),
      keyFile: keyPath,
    });
    const name = recovery.restoreDatabaseName(r.database);
    assert(!beforeDatabases.includes(name), 'Restore owns a new database');
    journal!.restored = r;
    await save();
    return r;
  });
  assert.equal(restored.status, 'verified');
  assert.equal(restored.revision, revision);
  assert.equal(restored.preview_only, true);
  assert.equal(restored.worker_enabled, false);
  assert.equal(restored.row_fingerprints_match, true);
  assert.equal(restored.schema_fingerprint_match, true);
  assert(restored.encrypted_records_verified >= 4);
  copy = new pg.Client({ ...local, database: recovery.restoreDatabaseName(restored.database) });
  await copy.connect();
  const checked = await rr(copy, async () => {
    same(
      await recovery.tableFingerprints(copy!),
      baseline.manifest,
      'Whole restored manifest exactly matches source',
    );
    assert.equal(await recovery.schemaFingerprint(copy!), baseline.schema);
    same(await inbound(copy!), baseline.inbound, 'All ten inbound tables exactly restored');
    same(
      await own(copy!, ids.tenant_id, ids.user_id),
      baseline.own,
      'Full own accepted graph exactly restored',
    );
    const { validateRecoveredInboundEmail } = await import('../server/email-inbound-recovery');
    const verified = await validateRecoveredInboundEmail(copy!, db.localConfig.encryptionKey);
    assert.equal(verified, baseline.encrypted_records_verified);
    return verified;
  });
  await rr(source, async () => {
    same(
      await recovery.tableFingerprints(source!),
      baseline.manifest,
      'Original whole database unchanged',
    );
    assert.equal(await recovery.schemaFingerprint(source!), baseline.schema);
  });
  for (const [path, bytes] of preserved)
    assert((await readFile(path)).equals(bytes), 'Private input custody unchanged');
  await health();
  journal.status = 'NATIVE_EMAIL_BACKUP_RESTORE_PASS';
  journal.encrypted_records_verified = checked;
  await save();
  const report = {
    stage: 156,
    status: journal.status,
    revision,
    schema_revision: schema,
    whole_instance_tables: Object.keys(baseline.manifest).length,
    inbound_tables: tables.length,
    own_tables: Object.keys(baseline.own.snapshot).length,
    whole_manifest_exact: true,
    whole_schema_acl_exact: true,
    inbound_rows_exact: true,
    own_accepted_graph_exact: true,
    source_unchanged: true,
    private_inputs_unchanged: true,
    encrypted_records_verified: checked,
    archive_sha256: backup.sha256,
    inbound_snapshot_sha256: hash(baseline.inbound.snapshot),
    accepted_custody_sha256: sha(acceptedBytes),
    restore_retained: true,
    readonly_app_api_verified: false,
    provider_verified: false,
    delivered: false,
    full_goal_complete: false,
  };
  await wx(reportPath, report, 0o644);
  process.stdout.write(
    JSON.stringify({
      stage: 156,
      status: report.status,
      restore_retained: true,
      provider_verified: false,
    }) + '\n',
  );
}
main()
  .catch(async (error: unknown) => {
    const ownFrame =
      error instanceof Error
        ? error.stack
            ?.split('\n')
            .find(
              (line) => /^\s+at /.test(line) && line.includes('email-inbound-native-backup156.ts:'),
            )
        : undefined;
    const sourceLine =
      ownFrame?.match(/email-inbound-native-backup156\.ts:([0-9]+):[0-9]+/)?.[1] ?? 'unknown';
    if (journal) {
      journal.status = 'INCOMPLETE_REQUIRES_MANUAL_REVIEW';
      journal.failed_step = step;
      journal.failed_source_line = sourceLine;
      await save().catch(() => {});
    }
    process.stderr.write(
      'QA156_NATIVE_BACKUP_FAILED_STEP_' +
        step +
        '_SOURCE_LINE_' +
        sourceLine +
        '_NO_PRIVATE_OUTPUT\n',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await copy?.end().catch(() => {});
    await source?.end().catch(() => {});
    await pool?.end().catch(() => {});
  });
