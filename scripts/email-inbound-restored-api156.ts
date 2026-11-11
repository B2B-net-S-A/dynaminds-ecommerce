/** Root-run QA156 restored API proof. No server/worker/provider/migration starts.
 * The only successful mutation is one normal login in the isolated restore.
 * All inbound writes intentionally contain malformed JSON and must return423.
 * Credentials/cookies stay in RAM; source journals and restore inputs are read-only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Client } from 'pg';

const ROOT = '<workspace>/app';
const BASE = 'http://127.0.0.1:4196/api';
const SCHEMA = '141_email_inbound';
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const paths = {
  prepare: resolve(ROOT, 'data/email-inbound-stage156.json'),
  accepted: resolve(ROOT, 'data/email-inbound-chrome156.json'),
  backup: resolve(ROOT, 'data/email-inbound-backup156.json'),
  primaryConfig: resolve(ROOT, '.local.json'),
  report: resolve(ROOT, 'docs/email-inbound-restored-api156.json'),
};
const tables = [
  'accounts',
  'acquisitions',
  'sources',
  'previews',
  'messages',
  'bindings',
  'reply_previews',
  'replies',
  'operations',
  'admissions',
].map((n) => 'email_inbound_' + n);
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
type Row = Record<string, any>;
type Fingerprints = Record<string, { count: number; sha256: string }>;
let client: Client | undefined;
let step = 'preflight';
let cookie = '';
let actor: Row;
let reads = 0;
const inputs = new Map<string, Buffer>();
const uuid = (v: unknown) => {
  assert.equal(typeof v, 'string');
  assert.match(v as string, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return v as string;
};
const one = (rows: Row[]) => {
  assert.equal(rows.length, 1);
  return rows[0];
};
const rows = (snapshot: Row, name: string): Row[] => snapshot.rows[name].map((x: Row) => x.row);
async function privateRead(path: string, max = 128 * 1024 * 1024) {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  assert(stat.size > 0 && stat.size <= max);
  const bytes = await readFile(path);
  inputs.set(path, bytes);
  return bytes;
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw Error('Exclusive output already exists');
}
async function json(response: Response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= 16 * 1024 * 1024);
  return JSON.parse(bytes.toString('utf8')) as Row;
}
async function request(path: string, method = 'GET', raw?: string, session = cookie) {
  assert(path.startsWith('/') && !path.startsWith('//') && !path.includes('://'));
  return fetch(BASE + path, {
    method,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(session ? { cookie: session, 'X-Workspace-ID': uuid(actor.tenant_id) } : {}),
      ...(raw === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(raw === undefined ? {} : { body: raw }),
  });
}
async function get(path: string, inbound = false) {
  const response = await request(path);
  assert.equal(response.status, 200);
  const dto = await json(response);
  if (inbound) {
    assert.equal(dto.available, true);
    assert.equal(dto.read_only, true);
    assert.equal(dto.can_read, true);
    assert.equal(dto.can_write, false);
    assert.equal(dto.current_role, 'admin');
  }
  reads++;
  return dto;
}
async function health() {
  const h = await get('/health');
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, SCHEMA);
  assert.equal(h.restore_preview, true);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.email_inbound_available, true);
}
async function capture() {
  await client!.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client!.query("SET LOCAL TimeZone='UTC'");
    const names = (
      await client!.query(
        "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND(table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY 1",
      )
    ).rows;
    const found: Record<string, Row[]> = {},
      snapshot: Fingerprints = {};
    for (const { table_name: name } of names) {
      assert.match(name, /^[a-z][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      found[name] = (
        await client!.query(`SELECT to_jsonb(x) row FROM "${name}" x WHERE ${key}=$1 ORDER BY 1`, [
          name === 'users' ? actor.user_id : actor.tenant_id,
        ])
      ).rows;
      snapshot[name] = { count: found[name].length, sha256: sha(JSON.stringify(found[name])) };
    }
    for (const name of tables) assert(Object.hasOwn(snapshot, name));
    const sessions = (
      await client!.query(
        'SELECT to_jsonb(s) row FROM sessions s WHERE user_id=$1 ORDER BY token_hash',
        [actor.user_id],
      )
    ).rows;
    await client!.query('COMMIT');
    return { rows: found, snapshot, sessions };
  } finally {
    await client!.query('ROLLBACK').catch(() => {});
  }
}
async function main() {
  assert.equal(process.argv.length, 2);
  assert.equal(resolve(process.cwd()), ROOT);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, paths.primaryConfig);
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.equal(process.env.DYNA_PREVIEW_PORT, '4196');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.match(revision, /^[a-f0-9]{40}$/);
  for (const dir of [resolve(ROOT, 'data'), resolve(ROOT, 'docs')]) {
    const stat = await lstat(dir);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
  }
  await absent(paths.report);
  const prepareBytes = await privateRead(paths.prepare),
    acceptedBytes = await privateRead(paths.accepted);
  assert.equal(sha(prepareBytes), process.env.QA156_PREPARE_SHA256);
  assert.equal(sha(acceptedBytes), process.env.QA156_CHROME_SHA256);
  const prepare = JSON.parse(prepareBytes.toString()),
    accepted = JSON.parse(acceptedBytes.toString());
  assert.equal(prepare.stage, 156);
  assert.equal(prepare.schema_revision, SCHEMA);
  assert.equal(prepare.phase, 'prepare');
  assert.equal(prepare.status, 'PHASE_COMPLETE');
  assert.equal(prepare.pending, null);
  actor = prepare.actor;
  for (const key of ['user_id', 'tenant_id', 'order_id', 'smtp_channel_id']) uuid(actor[key]);
  uuid(actor.account.id);
  assert.equal(typeof actor.email, 'string');
  assert.equal(actor.email, 'qa156-' + prepare.suffix + '@demo.local');
  assert.equal(typeof actor.password, 'string');
  assert(actor.password.length >= 12);
  assert.equal(typeof actor.cookie, 'string');
  assert(actor.cookie.startsWith('dyna_session='));
  assert.equal(accepted.stage, 156);
  assert.equal(accepted.schema_revision, SCHEMA);
  assert.equal(accepted.status, 'VERIFIED_LOCAL_SMTP');
  assert.equal(accepted.pending, null);
  assert.equal(accepted.prepare_sha256, sha(prepareBytes));
  for (const key of ['user_id', 'tenant_id', 'order_id'])
    assert.equal(accepted.ids[key], actor[key]);
  assert.equal(accepted.ids.account_id, actor.account.id);
  for (const key of ['reply_id', 'job_id', 'email_message_id', 'batch_id']) uuid(accepted.ids[key]);
  const backupBytes = await privateRead(paths.backup),
    backup = JSON.parse(backupBytes.toString());
  assert.equal(sha(backupBytes), process.env.QA156_BACKUP_SHA256);
  assert.equal(backup.stage, 156);
  assert.equal(backup.status, 'NATIVE_EMAIL_BACKUP_RESTORE_PASS');
  assert.equal(backup.revision, revision);
  assert.equal(backup.schema_revision, SCHEMA);
  assert.equal(backup.accepted_custody_sha256, sha(acceptedBytes));
  assert.equal(backup.setup_file_sha256, sha(prepareBytes));
  const resultPath = process.env.QA156_RESTORE_RESULT_PATH ?? '';
  assert.equal(resultPath, resolve(resultPath));
  assert.equal(resultPath, resolve(backup.restored.directory, 'result.json'));
  const dataPrefix = resolve(ROOT, 'data') + '/';
  assert(backup.restored.directory.startsWith(dataPrefix));
  assert.match(
    backup.restored.directory.slice(dataPrefix.length),
    /^email-inbound-backup156-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/restore\/[a-f0-9]{16}$/,
  );
  const resultBytes = await privateRead(resultPath, 65536),
    result = JSON.parse(resultBytes.toString());
  assert.deepEqual(result, backup.restored);
  assert.match(result.database, /^dynaminds_restore_[a-f0-9]{16}$/);
  assert.equal(result.database, 'dynaminds_restore_' + basename(result.directory));
  assert.equal(result.directory, dirname(resultPath));
  assert.equal(result.config, resolve(result.directory, 'local-config.json'));
  assert.equal(result.images, resolve(result.directory, 'images'));
  assert.equal(result.status, 'verified');
  assert.equal(result.source, 'dynaminds');
  assert.equal(result.preview_only, true);
  assert.equal(result.worker_enabled, false);
  assert.equal(result.row_fingerprints_match, true);
  assert.equal(result.schema_fingerprint_match, true);
  assert.equal(result.revision, revision);
  const config = JSON.parse((await privateRead(result.config, 65536)).toString());
  await privateRead(paths.primaryConfig, 65536);
  assert.equal(typeof config.dbPassword, 'string');
  const pg = await import('pg');
  client = new pg.default.Client({
    host: '127.0.0.1',
    port: 55432,
    user: 'postgres',
    password: config.dbPassword,
    database: result.database,
  });
  await client.connect();
  assert.deepEqual(
    (
      await client.query(
        'SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port',
      )
    ).rows[0],
    { role: 'postgres', db: result.database, host: '127.0.0.1', port: 55432 },
  );
  step = 'restore-health';
  await health();
  step = 'before-login-snapshot';
  const before = await capture();
  assert.deepEqual(before.snapshot, accepted.verify_checkpoint.snapshot);
  assert.deepEqual(before.snapshot, backup.source.own_snapshot);
  for (const name of tables) assert.deepEqual(before.rows[name], backup.source.inbound_rows[name]);
  assert.equal(rows(before, 'email_inbound_replies').length, 1);
  const expectedReply = one(
    rows(before, 'email_inbound_replies').filter((r) => r.id === accepted.ids.reply_id),
  );
  const source = one(
    rows(before, 'email_inbound_sources').filter(
      (r) =>
        r.id ===
        one(rows(before, 'email_inbound_messages').filter((m) => m.id === expectedReply.message_id))
          .source_id,
    ),
  );
  const preview = one(
    rows(before, 'email_inbound_reply_previews').filter((p) => p.id === expectedReply.preview_id),
  );
  const expectedMail = one(
    rows(before, 'email_inbound_messages').filter((m) => m.id === expectedReply.message_id),
  );
  const uid2Source = one(
    rows(before, 'email_inbound_sources').filter(
      (s) => s.uid === '2' && s.account_id === actor.account.id,
    ),
  );
  const uid2 = one(
    rows(before, 'email_inbound_messages').filter((m) => m.source_id === uid2Source.id),
  );
  assert.equal(uid2Source.uidvalidity, '156');
  assert.equal(uid2Source.attachments.length, 2);
  assert.deepEqual(
    uid2Source.attachments.map((f: Row) => f.index),
    [0, 1],
  );
  const binding = one(
    rows(before, 'email_inbound_bindings').filter((b) => b.id === expectedMail.binding_id),
  );
  step = 'primary-cookie-isolation';
  assert.equal((await request('/auth/me', 'GET', undefined, actor.cookie)).status, 401);
  step = 'normal-own-restored-login';
  const login = await request(
    '/auth/login',
    'POST',
    JSON.stringify({ email: actor.email, password: actor.password }),
    '',
  );
  assert.equal(login.status, 200);
  const loginBody = await json(login);
  assert.equal(loginBody.user.id, actor.user_id);
  assert.equal(loginBody.user.tenant_id, actor.tenant_id);
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert(cookie.startsWith('dyna_session_preview_4196='));
  const me = await get('/auth/me');
  assert.equal(me.user.id, actor.user_id);
  assert.equal(me.user.tenant_id, actor.tenant_id);
  assert.equal(me.user.role, 'admin');
  step = 'restored-inbound-get';
  const options = await get('/email-inbound/options', true);
  assert.equal(options.can_manage_accounts, false);
  const accounts = await get('/email-inbound/accounts', true);
  const account = one(accounts.data.filter((r: Row) => r.id === actor.account.id));
  assert.equal(account.host, '127.0.0.1');
  assert.equal(account.port, 4112);
  assert.equal(account.transport, 'local_fixture');
  assert.equal(account.username, undefined);
  assert.equal(account.password, undefined);
  assert.equal(account.credentials, undefined);
  const full = (await get('/email-inbound/messages/' + uid2.id, true)).message;
  assert.equal(full.id, uid2.id);
  assert.equal(full.raw_sha256, uid2Source.raw_sha256);
  assert.equal(full.uid, '2');
  assert.equal(full.uidvalidity, '156');
  assert.equal(full.account_id, actor.account.id);
  assert.equal(full.text, uid2Source.text_body);
  assert.deepEqual(full.headers, uid2Source.headers);
  assert.deepEqual(full.attachments, uid2Source.attachments);
  assert.equal(full.can_bind, false);
  assert.equal(full.can_reply, false);
  const readPreview = (await get('/email-inbound/reply-previews/' + preview.id, true))
    .reply_preview;
  assert.equal(readPreview.id, preview.id);
  assert.equal(readPreview.can_queue, false);
  assert.equal(readPreview.queued_reply_id, expectedReply.id);
  assert.deepEqual(readPreview.snapshot, preview.payload);
  const reply = (await get('/email-inbound/replies/' + expectedReply.id, true)).reply;
  assert.equal(reply.id, expectedReply.id);
  assert.equal(reply.preview_id, preview.id);
  assert.equal(reply.message_id, expectedMail.id);
  assert.equal(reply.snapshot.id, preview.id);
  assert.equal(reply.snapshot.message_id, expectedMail.id);
  assert.equal(reply.snapshot.scope_hash, preview.scope_hash);
  assert.deepEqual(reply.snapshot.snapshot, preview.payload);
  assert.equal(reply.snapshot.can_queue, undefined);
  assert.equal(reply.snapshot.queued_reply_id, undefined);
  const payload = reply.snapshot.snapshot.payload;
  assert.equal(
    payload.recipient,
    (source.headers.reply_to ?? source.headers.from).address.toLowerCase(),
  );
  assert.equal(payload.in_reply_to, source.headers.message_id);
  assert.deepEqual(payload.references, [
    ...source.headers.references,
    ...(source.headers.message_id ? [source.headers.message_id] : []),
  ]);
  assert.equal(reply.state, 'smtp_accepted');
  assert.equal(reply.delivered, false);
  assert.equal(reply.result.accepted_by_smtp, true);
  assert.equal(reply.result.local_sink, true);
  assert.equal(reply.result.delivered, false);
  const attachmentProof: Row[] = [];
  for (const prefix of ['', '/v1'])
    for (const file of uid2Source.attachments) {
      const dto = await get(
        prefix +
          '/email-inbound/messages/' +
          uid2.id +
          '/attachments/' +
          file.index +
          '/content?workspace_id=' +
          actor.tenant_id,
        true,
      );
      assert.equal(dto.message_id, uid2.id);
      assert.equal(dto.index, file.index);
      assert.equal(dto.filename, file.filename);
      assert.equal(dto.mime, file.mime);
      const bytes = Buffer.from(dto.content_base64, 'base64');
      assert.equal(bytes.toString('base64'), dto.content_base64);
      assert.equal(bytes.length, file.bytes);
      assert.equal(dto.bytes, file.bytes);
      assert.equal(sha(bytes), file.sha256);
      assert.equal(dto.sha256, file.sha256);
      attachmentProof.push({
        api: prefix ? 'v1' : 'ordinary',
        index: file.index,
        bytes: bytes.length,
        sha256: sha(bytes),
      });
    }
  step = 'staff-thread';
  const thread = await get('/customer-messages/' + binding.thread_id);
  const staff = one(thread.data.filter((m: Row) => m.id === binding.core_message_id));
  assert.equal(staff.kind, 'email');
  assert.equal(staff.body, source.text_body);
  assert.equal(staff.email.message_id, expectedMail.id);
  assert.equal(staff.email.account_id, actor.account.id);
  assert.deepEqual(staff.email.from, source.headers.from);
  assert.equal(staff.email.subject, source.headers.subject);
  assert.equal(staff.email.raw_sha256, source.raw_sha256);
  let publicPortal: 'NO_EMAIL_VISIBLE' | 'SKIPPED_NO_ACTIVE_LINK' = 'SKIPPED_NO_ACTIVE_LINK';
  const order = one(rows(before, 'orders').filter((o) => o.id === actor.order_id));
  if (
    typeof order.portal_token === 'string' &&
    order.portal_enabled &&
    (!order.portal_expires_at || Date.parse(order.portal_expires_at) > Date.now())
  ) {
    assert.match(order.portal_token, /^[a-f0-9]{48}$/);
    const response = await request(
      '/public/orders/' + order.portal_token + '/messages',
      'GET',
      undefined,
      '',
    );
    assert.equal(response.status, 200);
    const dto = await json(response);
    assert(Array.isArray(dto.data));
    assert(dto.data.every((m: Row) => ['buyer', 'reply'].includes(m.kind)));
    assert(!dto.data.some((m: Row) => m.id === binding.core_message_id || m.email));
    publicPortal = 'NO_EMAIL_VISIBLE';
    reads++;
  }
  step = 'malformed-write-denials';
  const acceptedAcquisitionId = uuid(accepted.read_api?.acquisition?.acquisition?.id);
  const acceptedPreviewId = uuid(accepted.read_api?.preview?.preview?.id);
  const acquisition = one(
    rows(before, 'email_inbound_acquisitions').filter((a) => a.id === acceptedAcquisitionId),
  );
  const inboundPreview = one(
    rows(before, 'email_inbound_previews').filter((p) => p.id === acceptedPreviewId),
  );
  assert.equal(acquisition.preview_id, inboundPreview.id);
  assert.equal(inboundPreview.acquisition_id, acquisition.id);
  assert.equal(acquisition.account_id, actor.account.id);
  assert.equal(inboundPreview.account_id, actor.account.id);
  const targets: [string, string][] = [
    ['POST', '/accounts'],
    ['PATCH', '/accounts/' + actor.account.id],
    ['POST', '/accounts/' + actor.account.id + '/previews'],
    ['POST', '/acquisitions/' + acquisition.id + '/reconcile'],
    ['POST', '/previews/' + inboundPreview.id + '/import'],
    ['POST', '/messages/' + uid2.id + '/bind'],
    ['POST', '/messages/' + expectedMail.id + '/reply-previews'],
    ['POST', '/reply-previews/' + preview.id + '/queue'],
  ];
  let denials = 0;
  for (const prefix of ['', '/v1'])
    for (const [method, route] of targets) {
      const response = await request(prefix + '/email-inbound' + route, method, '{');
      assert.equal(response.status, 423, 'Restore refuses write before parsing malformed JSON');
      denials++;
    }
  step = 'unchanged-read-only-evidence';
  await health();
  const after = await capture();
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.deepEqual(after.rows, before.rows);
  const priorSessions = new Map(before.sessions.map((s: Row) => [s.row.token_hash, s]));
  for (const old of before.sessions)
    assert.deepEqual(
      one(after.sessions.filter((s: Row) => s.row.token_hash === old.row.token_hash)),
      old,
    );
  const freshSessions = after.sessions.filter((s: Row) => !priorSessions.has(s.row.token_hash));
  assert.equal(freshSessions.length, 1);
  assert.equal(freshSessions[0].row.user_id, actor.user_id);
  assert.equal(freshSessions[0].row.tenant_id, actor.tenant_id);
  for (const [path, bytes] of inputs) {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o777, 0o600);
    assert((await readFile(path)).equals(bytes));
  }
  const report = {
    stage: 156,
    status: 'LIMITED_RESTORED_API_PASS',
    revision,
    schema_revision: SCHEMA,
    port: 4196,
    restore_preview: true,
    workers_enabled: false,
    own_tables: Object.keys(before.snapshot).length,
    own_snapshot: before.snapshot,
    own_snapshot_sha256: sha(JSON.stringify(before.snapshot)),
    inbound_tables: Object.fromEntries(tables.map((name) => [name, before.snapshot[name]])),
    all_own_non_session_rows_unchanged: true,
    ten_inbound_tables_unchanged: true,
    primary_cookie_denied: true,
    own_restored_login_sessions_added: 1,
    full_uid2_and_reply_snapshot_exact: true,
    staff_email_sender_and_full_body_exact: true,
    attachments: attachmentProof,
    public_portal: publicPortal,
    metadata_reads: reads,
    malformed_write_denials: denials,
    ordinary_and_v1_denied_before_parser: true,
    prepare_sha256: sha(prepareBytes),
    accepted_custody_sha256: sha(acceptedBytes),
    backup_custody_sha256: sha(backupBytes),
    restore_result_sha256: sha(resultBytes),
    private_input_bytes_preserved: true,
    provider_calls: 0,
    smtp_send_invocations: 0,
    chrome_verified_by_helper: false,
    provider_verified: false,
    delivered: false,
    full_goal_complete: false,
  };
  const file = await open(paths.report, 'wx', 0o644);
  try {
    await file.writeFile(JSON.stringify(report, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  process.stdout.write(
    JSON.stringify({
      stage: 156,
      status: 'PASS',
      own_tables: Object.keys(before.snapshot).length,
      denials,
    }) + '\n',
  );
}
main()
  .catch((error: unknown) => {
    const location =
      error instanceof Error
        ? /email-inbound-restored-api156\.ts:(\d+):(\d+)/.exec(error.stack ?? '')
        : null;
    process.stderr.write(
      'QA156_RESTORED_API_FAILED_STEP_' +
        step +
        '_LINE_' +
        (location?.[1] ?? 'unknown') +
        '_NO_PRIVATE_OUTPUT\n',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    cookie = '';
    await client?.end();
  });
