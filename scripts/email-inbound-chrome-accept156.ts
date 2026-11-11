/** Root-run ONLY. read|send|verify|verify-after-restart; never changes prepare journal.
 * Synthetic TLS mailbox and local SMTP acceptance do not prove provider delivery.
 * send claims exactly one previously reviewed own job and invokes processEmail once.
 * Pending/unknown send is never resumed, reaped or retried by this helper.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';

const ROOT = '<workspace>/app',
  BASE = 'http://127.0.0.1:4100/api';
const ORIGINAL = resolve(ROOT, 'data/email-inbound-stage156.json'),
  CUSTODY = resolve(ROOT, 'data/email-inbound-chrome156.json');
const CONFIG = resolve(ROOT, 'data/imap-fixture156/config.json'),
  MAILBOX = resolve(ROOT, 'data/smtp-mailbox');
const phase = process.argv[2],
  revision = process.env.QA_EXPECTED_REVISION ?? '',
  schema = '141_email_inbound';
const phases = ['read', 'send', 'verify', 'verify-after-restart'];
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fingerprint = (v: unknown) => sha(JSON.stringify(v));
const uuid = (v: unknown) => {
  assert.equal(typeof v, 'string');
  assert.match(v as string, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return v as string;
};
let pool: Pool | undefined,
  originalBytes: Buffer,
  configBytes: Buffer,
  original: any,
  fixture: any,
  a: any,
  state: any,
  step = 'preflight';
async function privateRead(path: string, max = 128 * 1024 * 1024) {
  const s = await lstat(path);
  assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, 0o600);
  assert(s.size > 0 && s.size <= max);
  return readFile(path);
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('Exclusive artifact exists');
}
async function wx(path: string, v: unknown, mode = 0o600) {
  const f = await open(path, 'wx', mode);
  try {
    await f.writeFile(JSON.stringify(v, null, 2) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
}
async function save() {
  await privateRead(CUSTODY);
  const tmp = CUSTODY + '.' + randomUUID() + '.tmp';
  try {
    await wx(tmp, state);
    await rename(tmp, CUSTODY);
    const d = await open(dirname(CUSTODY), 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
async function unchangedInputs() {
  assert((await privateRead(ORIGINAL)).equals(originalBytes));
  assert((await privateRead(CONFIG, 32768)).equals(configBytes));
}
async function get(path: string) {
  assert(path.startsWith('/') && !path.includes('://'));
  const r = await fetch(BASE + path, {
    headers: { cookie: a.cookie, 'X-Workspace-ID': a.tenant_id },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200, 'Exact scoped read status');
  const b = Buffer.from(await r.arrayBuffer());
  assert(b.length <= 16 * 1024 * 1024);
  return JSON.parse(b.toString());
}
async function authority() {
  const h = await get('/health');
  assert.equal(h.status, 'ok');
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema);
  assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.email_inbound_available, true);
  const me = (await get('/auth/me')).user;
  assert.equal(me.id, a.user_id);
  assert.equal(me.tenant_id, a.tenant_id);
  assert.equal(me.role, 'admin');
}
async function capture() {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names = (
      await c.query(
        "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND(table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY 1",
      )
    ).rows;
    const rows: Record<string, any[]> = {},
      snapshot: Record<string, { count: number; sha256: string }> = {};
    for (const { table_name } of names) {
      assert.match(table_name, /^[a-z][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(table_name) ? 'id' : 'tenant_id',
        value = table_name === 'users' ? a.user_id : a.tenant_id;
      rows[table_name] = (
        await c.query(`SELECT to_jsonb(x) row FROM "${table_name}" x WHERE ${key}=$1 ORDER BY 1`, [
          value,
        ])
      ).rows;
      snapshot[table_name] = {
        count: rows[table_name].length,
        sha256: fingerprint(rows[table_name]),
      };
    }
    await c.query('COMMIT');
    return { rows, snapshot };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
const emailTables = new Set([
  'audit_events',
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
  'customer_message_threads',
  'customer_messages',
  'email_batches',
  'email_messages',
  'jobs',
]);
function commerce(cp: any) {
  assert.deepEqual(Object.keys(cp.snapshot), Object.keys(a.born.snapshot));
  for (const name of Object.keys(cp.snapshot)) {
    if (!emailTables.has(name))
      assert.deepEqual(
        cp.snapshot[name],
        a.born.snapshot[name],
        'Original commerce unchanged ' + name,
      );
    const normalized = (r: any) =>
      name === 'email_inbound_accounts'
        ? Object.fromEntries(
            Object.entries(r).filter(
              ([k]) => !['version', 'uidvalidity', 'last_uid', 'updated_at'].includes(k),
            ),
          )
        : r;
    const current = new Set(cp.rows[name].map((x: any) => fingerprint(normalized(x.row))));
    for (const old of a.born.rows[name])
      assert(current.has(fingerprint(normalized(old.row))), 'Retained original own row ' + name);
  }
}
const rows = (cp: any, table: string) => cp.rows[table].map((x: any) => x.row);
function one(cp: any, table: string, id: string) {
  const found = rows(cp, table).filter((x: any) => x.id === id);
  assert.equal(found.length, 1);
  return found[0];
}
function graph(cp: any, replyId?: string) {
  const replies = rows(cp, 'email_inbound_replies');
  assert.equal(replies.length, 1, 'Exactly one reviewed Chrome reply');
  for (const table of [
    'email_batches',
    'email_messages',
    'email_inbound_bindings',
    'customer_message_threads',
    'customer_messages',
  ])
    assert.equal(rows(cp, table).length, 1, 'Exactly one own causal graph ' + table);
  assert.equal(
    rows(cp, 'jobs').length,
    a.born.snapshot.jobs.count + 1,
    'Exactly one new job above original prepare baseline',
  );
  const r = replies[0];
  uuid(r.id);
  if (replyId) assert.equal(r.id, replyId);
  assert.equal(r.actor_id, a.user_id);
  assert.equal(r.api_key_id, null);
  const m = one(cp, 'email_inbound_messages', r.message_id),
    p = one(cp, 'email_inbound_reply_previews', r.preview_id),
    b = one(cp, 'email_batches', r.batch_id),
    em = one(cp, 'email_messages', r.email_message_id),
    j = one(cp, 'jobs', r.job_id),
    ch = one(cp, 'channels', b.channel_id),
    binding = one(cp, 'email_inbound_bindings', m.binding_id),
    source = one(cp, 'email_inbound_sources', m.source_id);
  const bornJobs = rows(a.born, 'jobs');
  assert(!bornJobs.some((old: any) => old.id === j.id), 'Chosen reply job is newly created');
  for (const old of bornJobs)
    assert.deepEqual(one(cp, 'jobs', old.id), old, 'Original prepare job retained exactly');
  assert.equal(m.account_id, a.account.id);
  assert.equal(m.order_id, a.order_id);
  assert.equal(m.state, 'bound');
  assert.equal(binding.order_id, a.order_id);
  assert.equal(binding.message_id, m.id);
  assert.equal(binding.core_message_id, m.core_message_id);
  assert.equal(binding.actor_id, a.user_id);
  assert.equal(p.actor_id, a.user_id);
  assert.equal(p.message_id, m.id);
  assert.equal(p.api_key_id, null);
  assert.equal(b.inbound_reply_preview_id, p.id);
  assert.equal(b.actor_id, a.user_id);
  assert.equal(b.inbound_api_key_id, null);
  assert.equal(b.template_id, null);
  assert.equal(b.template_version, null);
  assert.equal(b.mode, 'smtp');
  assert.equal(b.external_allowed, false);
  assert.equal(b.channel_id, a.smtp_channel_id);
  assert.equal(ch.provider, 'smtp');
  assert.equal(ch.mode, 'sandbox');
  assert.equal(ch.settings.delivery, 'local_sink');
  assert.equal(ch.settings.host, '127.0.0.1');
  assert.equal(ch.settings.port, 1025);
  assert.equal(em.batch_id, b.id);
  assert.equal(em.order_id, a.order_id);
  assert.equal(em.job_id, j.id);
  assert.deepEqual(em.payload, p.payload.payload);
  assert.deepEqual(em.snapshot, p.payload);
  assert.deepEqual(em.sender, p.payload.sender);
  assert.deepEqual(r.snapshot.payload, p.payload);
  assert.equal(j.tenant_id, a.tenant_id);
  assert.equal(j.kind, 'email.send');
  assert.equal(j.max_attempts, 1);
  assert.deepEqual(j.payload, { message_id: em.id });
  assert.equal(
    p.payload.payload.recipient,
    (source.headers.reply_to ?? source.headers.from).address.toLowerCase(),
  );
  assert(p.payload.payload.recipient.endsWith('.test'));
  assert.equal(p.payload.payload.in_reply_to, source.headers.message_id);
  assert.deepEqual(p.payload.payload.references, [
    ...source.headers.references,
    ...(source.headers.message_id ? [source.headers.message_id] : []),
  ]);
  return { r, m, p, b, em, j, ch, binding, source };
}
async function sourceProof(cp: any) {
  const { decrypt } = await import('../server/security');
  const { parseInboundMime } = await import('../server/email-inbound-mime');
  const sources = rows(cp, 'email_inbound_sources');
  assert.equal(sources.length, 3);
  assert.deepEqual(sources.map((s: any) => s.uid).sort(), ['1', '2', '4']);
  const proof = [];
  for (const source of sources) {
    assert.equal(source.account_id, a.account.id);
    assert.equal(source.folder, 'INBOX');
    assert.equal(source.uidvalidity, '156');
    const expected = fixture.messages.find((m: any) => String(m.uid) === source.uid);
    assert(expected);
    assert.equal(source.raw_sha256, expected.sha256);
    assert.equal(source.raw_bytes, expected.byte_count);
    const body = decrypt(source.content_encrypted) as any,
      raw = Buffer.from(body.raw_base64, 'base64');
    assert.equal(raw.toString('base64'), body.raw_base64);
    assert.equal(sha(raw), source.raw_sha256);
    assert.equal(raw.length, source.raw_bytes);
    assert(raw.equals(await privateRead(resolve(dirname(CONFIG), expected.file), 4194304)));
    const parsed = await parseInboundMime(raw);
    assert.deepEqual(parsed.headers, source.headers);
    assert.equal(parsed.text, source.text_body);
    assert.equal(parsed.attachments.length, source.attachments.length);
    assert.equal(parsed.attachments.length, body.attachments.length);
    for (const [index, f] of parsed.attachments.entries()) {
      assert.deepEqual(source.attachments[index], {
        index,
        filename: f.filename,
        mime: f.mime,
        bytes: f.bytes.length,
        sha256: f.sha256,
      });
      assert.deepEqual(body.attachments[index], {
        ...source.attachments[index],
        content_base64: f.bytes.toString('base64'),
      });
    }
    proof.push({
      source_id: source.id,
      uid: source.uid,
      raw_sha256: sha(raw),
      bytes: raw.length,
      attachments: source.attachments,
    });
  }
  return proof;
}
async function apiGraph(g: any) {
  const accounts = await get('/email-inbound/accounts');
  assert(accounts.data.some((c: any) => c.id === a.account.id));
  const messages: any[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await get(
      '/email-inbound/messages?account_id=' +
        a.account.id +
        '&limit=50' +
        (cursor ? '&cursor=' + cursor : ''),
    );
    messages.push(...page.data);
    assert(messages.length <= 3);
    cursor = page.next_cursor;
    if (cursor) {
      uuid(cursor);
      assert(!seen.has(cursor));
      seen.add(cursor);
    }
  } while (cursor);
  assert.equal(messages.length, 3);
  const message = (await get('/email-inbound/messages/' + g.m.id)).message;
  assert.equal(message.order_id, a.order_id);
  assert.equal(message.binding_id, g.binding.id);
  const thread = await get('/customer-messages/' + g.binding.thread_id);
  const core = thread.data.find((m: any) => m.id === g.binding.core_message_id);
  assert(core);
  assert.equal(core.kind, 'email');
  assert.equal(core.body, g.source.text_body);
  assert.equal(core.email.message_id, g.m.id);
  assert.deepEqual(core.email.from, g.source.headers.from);
  const cp = state.read_checkpoint;
  const imports = rows(cp, 'email_inbound_operations').filter(
    (op: any) =>
      op.kind === 'import' &&
      op.result.import.new_count === 3 &&
      op.result.import.message_ids.includes(g.m.id),
  );
  assert.equal(imports.length, 1, 'Exact first import containing reviewed source');
  const imported = imports[0];
  assert.equal(imported.actor_id, a.user_id);
  const nativePreview = one(cp, 'email_inbound_previews', imported.target_id),
    ac = one(cp, 'email_inbound_acquisitions', nativePreview.acquisition_id);
  assert.equal(ac.actor_id, a.user_id);
  assert.equal(ac.account_id, a.account.id);
  assert.equal(ac.state, 'ready');
  assert.equal(ac.preview_id, nativePreview.id);
  const acquisition = await get('/email-inbound/acquisitions/' + ac.id),
    preview = await get('/email-inbound/previews/' + nativePreview.id),
    importReceipt = await get('/email-inbound/imports/' + imported.id);
  assert.equal(acquisition.acquisition.id, ac.id);
  assert.equal(preview.preview.id, nativePreview.id);
  assert.equal(preview.preview.summary.rows, 3);
  assert.equal(importReceipt.import.id, imported.id);
  assert.deepEqual(importReceipt.import.message_ids, imported.result.import.message_ids);
  const replyPreview = await get('/email-inbound/reply-previews/' + g.p.id),
    reply = await get('/email-inbound/replies/' + g.r.id);
  assert.equal(replyPreview.reply_preview.id, g.p.id);
  assert.deepEqual(replyPreview.reply_preview.snapshot, g.p.payload);
  assert.equal(reply.reply.id, g.r.id);
  assert.equal(reply.reply.delivered, false);
  assert.deepEqual(reply.reply.snapshot.snapshot, g.p.payload);
  return {
    accounts,
    messages,
    message,
    thread,
    acquisition,
    preview,
    importReceipt,
    replyPreview,
    reply,
  };
}
async function mailbox(): Promise<Record<string, string>> {
  let s;
  try {
    s = await lstat(MAILBOX);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  assert(s.isDirectory() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, 0o700);
  const result: Record<string, string> = {};
  for (const name of (await readdir(MAILBOX)).sort()) {
    assert.match(name, /^[a-f0-9-]{36}\.json$/);
    result[name] = sha(await privateRead(resolve(MAILBOX, name), 6 * 1024 * 1024));
  }
  return result;
}
function workerDelta(before: any, after: any, g: any) {
  assert.deepEqual(Object.keys(before.snapshot), Object.keys(after.snapshot));
  const allowed: Record<string, { id: string; fields: string[] }> = {
    email_batches: { id: g.b.id, fields: ['state'] },
    email_messages: {
      id: g.em.id,
      fields: ['state', 'attempted_at', 'result', 'error', 'updated_at'],
    },
    jobs: { id: g.j.id, fields: ['state', 'attempts', 'locked_at', 'lease_token', 'error'] },
  };
  for (const table of Object.keys(before.snapshot)) {
    if (table === 'audit_events') {
      const current = new Map(rows(after, table).map((r: any) => [r.id, r]));
      for (const row of rows(before, table)) assert.deepEqual(current.get(row.id), row);
      const extra = rows(after, table).filter(
        (r: any) => !rows(before, table).some((o: any) => o.id === r.id),
      );
      assert.equal(extra.length, 1);
      assert.equal(extra[0].action, 'email.result');
      assert.equal(extra[0].entity_id, g.em.id);
      continue;
    }
    if (!allowed[table]) {
      assert.deepEqual(
        before.snapshot[table],
        after.snapshot[table],
        'Only chosen SMTP lifecycle changed ' + table,
      );
      continue;
    }
    const spec = allowed[table];
    assert.equal(before.snapshot[table].count, after.snapshot[table].count);
    const stripped = (cp: any) =>
      rows(cp, table).map((r: any) =>
        r.id === spec.id
          ? Object.fromEntries(Object.entries(r).filter(([key]) => !spec.fields.includes(key)))
          : r,
      );
    assert.deepEqual(stripped(after), stripped(before));
  }
}
async function read() {
  step = 'read-own-graph';
  await absent(CUSTODY);
  const before = await capture();
  commerce(before);
  const g = graph(before);
  assert.equal(g.em.state, 'queued');
  assert.equal(g.em.attempted_at, null);
  assert.equal(g.j.state, 'pending');
  assert.equal(g.j.attempts, 0);
  assert.equal(g.j.lease_token, null);
  const proof = await sourceProof(before);
  state = {
    stage: 156,
    schema_revision: schema,
    prepare_sha256: sha(originalBytes),
    prepare_revision: original.runtime_revision,
    fixture_config_sha256: sha(configBytes),
    read_revision: revision,
    status: 'READ_IN_PROGRESS',
    pending: null,
    ids: {
      tenant_id: a.tenant_id,
      user_id: a.user_id,
      order_id: a.order_id,
      account_id: a.account.id,
      reply_id: g.r.id,
      job_id: g.j.id,
      email_message_id: g.em.id,
      batch_id: g.b.id,
    },
    read_checkpoint: before,
    source_proof: proof,
  };
  const api = await apiGraph(g);
  assert.equal(api.reply.reply.state, 'queued');
  const after = await capture();
  assert.deepEqual(after.snapshot, before.snapshot, 'All reads effect-free');
  await unchangedInputs();
  state.read_api = api;
  state.mailbox_before = await mailbox();
  state.status = 'READ_CONFIRMED';
  await wx(CUSTODY, state);
}
async function send() {
  step = 'send-preflight';
  assert.equal(state.status, 'READ_CONFIRMED');
  assert.equal(state.pending, null);
  assert.equal(process.env.QA156_SEND_CONFIRM, 'SEND_ONE_OWN_LOCAL_SMTP_JOB');
  assert.equal(process.env.QA156_EXPECTED_JOB_ID, state.ids.job_id);
  assert.equal(process.env.QA156_EXPECTED_REPLY_ID, state.ids.reply_id);
  const before = await capture();
  assert.deepEqual(
    before.snapshot,
    state.read_checkpoint.snapshot,
    'Accepted Chrome baseline unchanged',
  );
  commerce(before);
  const g = graph(before, state.ids.reply_id);
  assert.equal(g.em.state, 'queued');
  assert.equal(g.em.attempted_at, null);
  assert.equal(g.j.state, 'pending');
  assert.equal(g.j.attempts, 0);
  assert.equal(g.j.lease_token, null);
  assert.deepEqual(await mailbox(), state.mailbox_before);
  await authority();
  await unchangedInputs();
  const lease = randomUUID();
  state.pending = {
    operation: 'ONE_OWN_SMTP_JOB',
    job_id: g.j.id,
    reply_id: g.r.id,
    tenant_id: a.tenant_id,
    email_message_id: g.em.id,
    lease_token: lease,
    started_at: new Date().toISOString(),
    claim: null,
  };
  state.status = 'SEND_PENDING_DO_NOT_RETRY';
  await save();
  step = 'exact-own-claim';
  const c = await pool!.connect();
  let job: any;
  try {
    await c.query('BEGIN');
    const r = await c.query(
      "UPDATE jobs j SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE j.id=$1 AND j.tenant_id=$3 AND j.kind='email.send' AND j.state='pending' AND j.attempts=0 AND j.max_attempts=1 AND j.run_at<=now() AND j.lease_token IS NULL AND EXISTS(SELECT 1 FROM email_inbound_replies r JOIN email_messages em ON(em.tenant_id,em.id)=(r.tenant_id,r.email_message_id) JOIN email_batches b ON(b.tenant_id,b.id)=(r.tenant_id,r.batch_id) JOIN channels ch ON(ch.tenant_id,ch.id)=(b.tenant_id,b.channel_id) WHERE r.tenant_id=$3 AND r.id=$4 AND r.actor_id=$5 AND r.job_id=j.id AND r.api_key_id IS NULL AND em.id=$6 AND em.job_id=j.id AND em.state='queued' AND em.attempted_at IS NULL AND b.inbound_reply_preview_id=r.preview_id AND b.channel_id=$7 AND ch.provider='smtp' AND ch.mode='sandbox' AND ch.settings->>'delivery'='local_sink' AND ch.settings->>'host'='127.0.0.1' AND ch.settings->>'port'='1025' AND j.payload=jsonb_build_object('message_id',em.id)) RETURNING j.*",
      [g.j.id, lease, a.tenant_id, g.r.id, a.user_id, g.em.id, a.smtp_channel_id],
    );
    assert.equal(r.rowCount, 1, 'Exactly one own reviewed job claimed');
    job = r.rows[0];
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  state.pending.claim = job;
  await save();
  step = 'one-process-email';
  const { processEmail } = await import('../server/email');
  await processEmail(job);
  state.send_checkpoint = await capture();
  commerce(state.send_checkpoint);
  const actual = graph(state.send_checkpoint, state.ids.reply_id);
  workerDelta(state.read_checkpoint, state.send_checkpoint, g);
  state.send_result = {
    state: actual.em.state,
    result: actual.em.result,
    job_state: actual.j.state,
  };
  state.completed_send = state.pending;
  state.pending = null;
  state.status = 'SEND_RESULT_RECORDED';
  state.send_revision = revision;
  await unchangedInputs();
  await save();
  assert.equal(actual.em.state, 'smtp_accepted', 'No resend for any nonaccepted result');
  assert.equal(actual.em.result.accepted_by_smtp, true);
  assert.equal(actual.em.result.local_sink, true);
  assert.equal(actual.em.result.delivered, false);
  assert.equal(actual.j.state, 'done');
  assert.equal(actual.j.attempts, 1);
  assert.equal(actual.j.lease_token, null);
}
async function verify() {
  step = 'verify-own-smtp';
  assert.equal(state.status, 'SEND_RESULT_RECORDED');
  assert.equal(state.pending, null);
  const before = await capture();
  assert.deepEqual(before.snapshot, state.send_checkpoint.snapshot);
  commerce(before);
  const g = graph(before, state.ids.reply_id);
  assert.equal(g.em.state, 'smtp_accepted');
  assert.equal(g.j.state, 'done');
  assert.equal(g.j.attempts, 1);
  assert.equal(g.j.lease_token, null);
  assert(g.em.attempted_at);
  assert.equal(g.em.result.accepted_by_smtp, true);
  assert.equal(g.em.result.local_sink, true);
  assert.equal(g.em.result.delivered, false);
  assert.equal(g.em.result.message_id, `<${g.em.id}@dynaminds.local>`);
  const files = await mailbox();
  for (const name of Object.keys(state.mailbox_before))
    assert.equal(files[name], state.mailbox_before[name]);
  const added = Object.keys(files).filter((name) => !(name in state.mailbox_before));
  assert.equal(added.length, 1, 'Exactly one new local sink artifact');
  const { decrypt } = await import('../server/security');
  const { simpleParser } = await import('mailparser');
  const stored = decrypt(
    (await privateRead(resolve(MAILBOX, added[0]), 6 * 1024 * 1024)).toString(),
  ) as any;
  const raw = Buffer.from(stored.raw_base64, 'base64');
  assert.equal(raw.toString('base64'), stored.raw_base64);
  assert(raw.length > 0 && raw.length <= 4 * 1024 * 1024);
  assert.equal(stored.recipient, g.em.payload.recipient);
  assert.equal(typeof stored.accepted_at, 'string');
  const parsed = await simpleParser(raw);
  assert.equal(parsed.messageId, `<${g.em.id}@dynaminds.local>`);
  assert.equal(parsed.headers.get('x-dynaminds-message'), g.em.id);
  assert.equal(parsed.inReplyTo, g.em.payload.in_reply_to ?? undefined);
  const refs =
    parsed.references === undefined
      ? []
      : Array.isArray(parsed.references)
        ? parsed.references
        : [parsed.references];
  assert.deepEqual(refs, g.em.payload.references);
  const to = Array.isArray(parsed.to) ? parsed.to.flatMap((x) => x.value) : parsed.to?.value;
  assert.equal(to?.length, 1);
  assert.equal(to?.[0].address, g.em.payload.recipient);
  assert.equal(parsed.subject, g.em.payload.subject);
  assert.equal(
    parsed.text?.replace(/\r\n/g, '\n').replace(/\n$/, ''),
    g.em.payload.text.replace(/\r\n/g, '\n'),
  );
  assert.equal(parsed.attachments.length, 0);
  state.verify_api = await apiGraph(g);
  assert.equal(state.verify_api.reply.reply.state, 'smtp_accepted');
  assert.equal(state.verify_api.reply.reply.delivered, false);
  state.verify_sources = await sourceProof(before);
  const after = await capture();
  assert.deepEqual(after.snapshot, before.snapshot, 'Verify all GETs effect-free');
  await unchangedInputs();
  state.verify_checkpoint = after;
  state.smtp_proof = {
    file: added[0],
    encrypted_sha256: files[added[0]],
    raw_sha256: sha(raw),
    raw_bytes: raw.length,
    message_id: parsed.messageId,
    accepted_by_local_smtp: true,
    delivered: false,
  };
  state.status = 'VERIFIED_LOCAL_SMTP';
  state.verify_revision = revision;
  await save();
}
async function verifyAfterRestart() {
  step = 'read-after-restart';
  assert.equal(state.status, 'VERIFIED_LOCAL_SMTP');
  assert.equal(state.pending, null);
  const before = await capture();
  assert.deepEqual(
    before.snapshot,
    state.verify_checkpoint.snapshot,
    'All accepted own tables retained after restart',
  );
  commerce(before);
  const g = graph(before, state.ids.reply_id);
  assert.equal(g.em.state, 'smtp_accepted');
  assert.equal(g.j.state, 'done');
  assert.equal(g.j.attempts, 1);
  assert.equal(g.j.lease_token, null);
  assert.deepEqual(
    await mailbox(),
    state.verified_mailbox,
    'All accepted encrypted sink files retained',
  );
  const api = await apiGraph(g);
  assert.equal(api.reply.reply.state, 'smtp_accepted');
  assert.equal(api.reply.reply.delivered, false);
  await sourceProof(before);
  const after = await capture();
  assert.deepEqual(after.snapshot, before.snapshot, 'Restart readback GETs effect-free');
  await unchangedInputs();
  state.restart_checkpoint = after;
  state.restart_api = api;
  state.restart_revision = revision;
}
async function main() {
  assert(phases.includes(phase ?? ''));
  assert.equal(process.argv.length, 3);
  assert.equal(resolve(process.cwd()), ROOT);
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.match(revision, /^[a-f0-9]{40}$/);
  for (const path of [resolve(ROOT, 'data'), resolve(ROOT, 'docs'), dirname(CONFIG)]) {
    const s = await lstat(path);
    assert(s.isDirectory() && !s.isSymbolicLink());
  }
  assert.equal((await lstat(dirname(CONFIG))).mode & 0o777, 0o700);
  originalBytes = await privateRead(ORIGINAL);
  assert.equal(
    sha(originalBytes),
    process.env.QA156_PREPARE_SHA256,
    'Original prepare bytes preserved',
  );
  original = JSON.parse(originalBytes.toString());
  assert.equal(original.stage, 156);
  assert.equal(original.schema_revision, schema);
  assert.equal(original.phase, 'prepare');
  assert.equal(original.status, 'PHASE_COMPLETE');
  assert.equal(original.pending, null);
  a = original.actor;
  for (const key of ['user_id', 'tenant_id', 'order_id', 'smtp_channel_id']) uuid(a[key]);
  uuid(a.account.id);
  assert(a.cookie.startsWith('dyna_session='));
  configBytes = await privateRead(CONFIG, 32768);
  assert.equal(sha(configBytes), original.fixture_config_sha256);
  fixture = JSON.parse(configBytes.toString());
  assert.equal(fixture.stage, 156);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.host, '127.0.0.1');
  assert.equal(fixture.port, 4112);
  assert.deepEqual(
    fixture.messages.map((m: any) => m.uid),
    [1, 2, 4],
  );
  for (const m of fixture.messages) {
    assert.equal(m.file, 'message-' + m.uid + '.eml');
    const raw = await privateRead(resolve(dirname(CONFIG), m.file), 4194304);
    assert.equal(raw.length, m.byte_count);
    assert.equal(sha(raw), m.sha256);
  }
  pool = (await import('../server/db')).pool;
  const u = new URL(pool.options.connectionString!);
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.port, '55432');
  assert.equal(u.pathname, '/dynaminds');
  assert.deepEqual(
    (
      await pool.query(
        'SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port',
      )
    ).rows[0],
    { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 },
  );
  await authority();
  const output = resolve(ROOT, 'docs/email-inbound-chrome156-' + phase + '.json');
  await absent(output);
  if (phase !== 'read') {
    const b = await privateRead(CUSTODY);
    assert.equal(sha(b), process.env.QA156_CHROME_SHA256);
    state = JSON.parse(b.toString());
    assert.equal(state.stage, 156);
    assert.equal(state.schema_revision, schema);
    assert.equal(state.prepare_sha256, sha(originalBytes));
    assert.equal(state.fixture_config_sha256, sha(configBytes));
    assert.equal(state.pending, null);
    for (const key of ['tenant_id', 'user_id', 'order_id']) assert.equal(state.ids[key], a[key]);
    assert.equal(state.ids.account_id, a.account.id);
  }
  await (
    { read, send, verify, 'verify-after-restart': verifyAfterRestart } as Record<
      string,
      () => Promise<void>
    >
  )[phase!]();
  await unchangedInputs();
  await authority();
  if (phase === 'verify') {
    state.verified_mailbox = await mailbox();
    assert.deepEqual(
      Object.keys(state.verified_mailbox).sort(),
      [...Object.keys(state.mailbox_before), state.smtp_proof.file].sort(),
    );
    for (const key of Object.keys(state.mailbox_before))
      assert.equal(state.verified_mailbox[key], state.mailbox_before[key]);
    assert.equal(state.verified_mailbox[state.smtp_proof.file], state.smtp_proof.encrypted_sha256);
  }
  state.phase = phase;
  await save();
  const cp =
    state.restart_checkpoint ??
    state.verify_checkpoint ??
    state.send_checkpoint ??
    state.read_checkpoint;
  await wx(
    output,
    {
      stage: 156,
      phase,
      status: phase!.startsWith('verify')
        ? 'LIMITED_LOCAL_IMAP_CHROME_SMTP_PASS'
        : 'OWN_CHROME_PHASE_PASS',
      revision,
      schema_revision: schema,
      prepare_revision: original.runtime_revision,
      prepare_journal_preserved: true,
      prepare_sha256: sha(originalBytes),
      ...state.ids,
      own_tables: Object.keys(cp.snapshot).length,
      own_snapshot_sha256: fingerprint(cp.snapshot),
      source_raw_exact: true,
      attachments_binary_exact: true,
      commerce_unchanged: true,
      original_prepare_phase: 'prepare',
      pending: null,
      one_job_process_invocation: phase !== 'read',
      current_phase_send_invocations: phase === 'send' ? 1 : 0,
      smtp: phase!.startsWith('verify') ? state.smtp_proof : null,
      synthetic_mailbox: true,
      provider_verified: false,
      delivered: false,
      chrome_interactions_executed_by_helper: false,
      full_goal_complete: false,
      custody_sha256: sha(await privateRead(CUSTODY)),
    },
    0o644,
  );
  process.stdout.write(
    JSON.stringify({
      stage: 156,
      phase,
      status: 'PASS',
      provider_verified: false,
      delivered: false,
    }) + '\n',
  );
}
main()
  .catch(async (error: unknown) => {
    if (state?.pending) {
      state.status = 'UNKNOWN_OR_UNCONFIRMED_SEND_DO_NOT_RETRY';
      await save().catch(() => {});
    }
    const safePhase = phases.includes(phase ?? '') ? phase : 'invalid';
    const e = error as { stack?: unknown; code?: unknown };
    const source =
      typeof e?.stack === 'string'
        ? e.stack.match(/email-inbound-chrome-accept156\.ts:(\d+):(\d+)/)
        : null;
    const allowedCodes = [
      'ERR_ASSERTION',
      '23514',
      '23505',
      '23503',
      '42501',
      '42P01',
      '42703',
      '42883',
      '40001',
      '40P01',
      '55000',
      'ECONNREFUSED',
      'ETIMEDOUT',
    ];
    const code =
      typeof e?.code === 'string' && allowedCodes.includes(e.code) ? e.code : 'UNCLASSIFIED';
    process.stderr.write(
      JSON.stringify({
        status: 'QA156_CHROME_ACCEPT_FAILED',
        phase: safePhase,
        step,
        code,
        source_line: source ? Number(source[1]) : null,
        source_column: source ? Number(source[2]) : null,
        private_output: false,
      }) + '\n',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool?.end();
  });
