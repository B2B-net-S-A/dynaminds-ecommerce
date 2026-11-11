/** Root-run QA156, explicit phase CLI. Never starts IMAP/SMTP, workers or migrations.
 * prepare births exactly one new own actor/firm/order via ordinary local API.
 * receive performs one genuine TLS fixture read; every later write requires its
 * own invocation and preserved journal SHA. Unknown results never resume/retry.
 * Synthetic mailbox content and SMTP acceptance are NOT provider/delivery proof.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';
const root = '<workspace>/app',
  base = 'http://127.0.0.1:4100/api';
const path = resolve(root, 'data/email-inbound-stage156.json'),
  configPath = resolve(root, 'data/imap-fixture156/config.json');
const phase = process.argv[2],
  revision = process.env.QA_EXPECTED_REVISION ?? '',
  schema = '141_email_inbound';
const phases = [
  'prepare',
  'receive',
  'import',
  'bind',
  'reply-preview',
  'queue',
  'verify',
] as const;
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => sha(JSON.stringify(v));
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
let pool: Pool | undefined,
  state: any,
  step = 'preflight',
  fixture: any,
  configBytes: Buffer;
const uuid = (v: unknown): string => {
  assert.equal(typeof v, 'string');
  assert.match(v as string, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return v as string;
};
async function absent(file: string) {
  try {
    await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('Exclusive output already exists');
}
async function privateRead(file: string, max = 8 * 1024 * 1024) {
  const s = await lstat(file);
  assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, 0o600);
  assert(s.size > 0 && s.size <= max);
  return readFile(file);
}
async function wx(file: string, value: unknown, mode = 0o600) {
  const f = await open(file, 'wx', mode);
  try {
    await f.writeFile(encode(value));
    await f.sync();
  } finally {
    await f.close();
  }
}
async function save() {
  await privateRead(path);
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await wx(temp, state);
    await rename(temp, path);
    const d = await open(dirname(path), 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}
async function json(r: Response) {
  const bytes = Buffer.from(await r.arrayBuffer());
  assert(bytes.length <= 16 * 1024 * 1024, 'Bounded API response');
  return JSON.parse(bytes.toString('utf8'));
}
function headers(extra: Record<string, string> = {}) {
  return {
    ...(state?.actor.cookie
      ? { cookie: state.actor.cookie, 'X-Workspace-ID': state.actor.tenant_id }
      : {}),
    'Content-Type': 'application/json',
    ...extra,
  };
}
async function get(route: string) {
  assert(route.startsWith('/') && !route.includes('://'));
  const r = await fetch(base + route, {
    headers: headers(),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200, 'Own scoped GET');
  return json(r);
}
async function health() {
  const h = await get('/health');
  assert.equal(h.status, 'ok');
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema);
  assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.email_inbound_available, true);
  return h;
}
async function identity() {
  const me = await get('/auth/me');
  assert.equal(me.user.tenant_id, state.actor.tenant_id);
  assert.equal(me.user.id, state.actor.user_id);
  assert.equal(me.user.role, 'admin');
}
function permitted(route: string) {
  if (phase === 'prepare')
    return (
      [
        '/auth/signup',
        '/workspaces/billing/preview',
        '/products',
        '/orders',
        '/integrations/smtp-example',
        '/email-inbound/accounts',
      ].includes(route) ||
      Boolean(
        state.actor.billing_preview?.id &&
        route === '/workspaces/billing/previews/' + state.actor.billing_preview.id + '/commit',
      )
    );
  if (phase === 'receive')
    return route === '/email-inbound/accounts/' + state.actor.account.id + '/previews';
  if (phase === 'import')
    return route === '/email-inbound/previews/' + state.actor.preview.id + '/import';
  if (phase === 'bind')
    return route === '/email-inbound/messages/' + state.actor.message_id + '/bind';
  if (phase === 'reply-preview')
    return route === '/email-inbound/messages/' + state.actor.message_id + '/reply-previews';
  if (phase === 'queue')
    return route === '/email-inbound/reply-previews/' + state.actor.reply_preview.id + '/queue';
  return false;
}
async function post(
  label: string,
  route: string,
  body: any,
  status: number,
  assign: (d: any, r: Response) => void,
  extra: Record<string, string> = {},
) {
  step = label;
  assert.equal(state.pending, null);
  assert(permitted(route), 'Explicit own phase route');
  await health();
  if (route !== '/auth/signup') await identity();
  state.pending = {
    phase,
    label,
    method: 'POST',
    route,
    body,
    extra_headers: extra,
    expected_status: status,
    response: null,
  };
  state.status = 'PENDING_WRITE';
  await save();
  let r: Response, d: any;
  try {
    r = await fetch(base + route, {
      method: 'POST',
      headers: headers(extra),
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
    });
    d = await json(r);
  } catch {
    state.status = 'UNKNOWN_RESULT_DO_NOT_RETRY';
    await save();
    throw Error('Unconfirmed write requires manual inspection');
  }
  state.pending.response = { status: r.status, data: d };
  await save();
  assert.equal(r.status, status, 'Exact phase API status');
  assign(d, r);
  await save();
  state.completed.push({ phase, label, route, status: r.status, response_sha256: fp(d) });
  state.pending = null;
  state.status = 'CONFIRMED';
  await save();
  return d;
}
async function capture() {
  const a = state.actor,
    c = await pool!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const n = (
      await c.query(
        'SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port',
      )
    ).rows[0];
    assert.deepEqual(n, { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
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
        target = table_name === 'users' ? a.user_id : a.tenant_id;
      rows[table_name] = (
        await c.query(`SELECT to_jsonb(x) row FROM "${table_name}" x WHERE ${key}=$1 ORDER BY 1`, [
          target,
        ])
      ).rows;
      snapshot[table_name] = { count: rows[table_name].length, sha256: fp(rows[table_name]) };
    }
    await c.query('COMMIT');
    return { rows, snapshot };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
const allowedTables = new Set([
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
function unaffected(before: any, after: any) {
  assert.deepEqual(Object.keys(after.snapshot), Object.keys(before.snapshot));
  for (const name of Object.keys(before.snapshot))
    if (!allowedTables.has(name))
      assert.deepEqual(
        after.snapshot[name],
        before.snapshot[name],
        'Unchanged own business table ' + name,
      );
}
async function allMessages() {
  const all: any[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const r = await get('/email-inbound/messages?limit=50' + (cursor ? '&cursor=' + cursor : ''));
    assert(Array.isArray(r.data));
    all.push(...r.data);
    assert(all.length <= 3);
    cursor = r.next_cursor;
    if (cursor) {
      uuid(cursor);
      assert(!seen.has(cursor));
      seen.add(cursor);
    }
  } while (cursor);
  return all;
}
async function prepare() {
  const a = state.actor;
  await post(
    'signup',
    '/auth/signup',
    {
      name: 'QA156 Own Email Operator',
      email: a.email,
      password: a.password,
      organization: { name: 'QA156 Own Inbound ' + state.suffix, currency: 'PLN', locale: 'pl-PL' },
    },
    201,
    (d, r) => {
      a.user_id = uuid(d.user.id);
      a.tenant_id = uuid(d.user.tenant_id);
      a.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
      assert(a.cookie.startsWith('dyna_session='));
    },
  );
  const wh = await get('/warehouses');
  assert.equal(wh.data.length, 1);
  a.warehouse_id = uuid(wh.data[0].id);
  await save();
  const b = await get('/workspaces/billing');
  assert.equal(b.mode, 'local_estimate');
  assert.equal(b.current_plan, 'starter');
  assert.equal(b.account, null);
  await post(
    'local-entitlement-preview',
    '/workspaces/billing/preview',
    { kind: 'activate', plan: 'enterprise' },
    200,
    (d) => {
      assert.equal(d.mode, 'local_estimate');
      assert.equal(d.can_commit, true);
      assert.deepEqual(d.blockers, []);
      a.billing_preview = d;
      uuid(d.id);
    },
  );
  await post(
    'local-entitlement-commit',
    '/workspaces/billing/previews/' + a.billing_preview.id + '/commit',
    {},
    200,
    (d) => {
      assert.equal(d.mode, 'local_estimate');
      assert.equal(d.plan, 'enterprise');
      a.billing_commit = d;
    },
  );
  await post(
    'own-product',
    '/products',
    {
      name: 'QA156 Own Email Product',
      sku: 'QA156-' + state.suffix,
      kind: 'simple',
      price: 1000,
      vat: 23,
      quantity: 10,
      warehouse_id: a.warehouse_id,
      location: 'QA156-01',
    },
    201,
    (d) => {
      a.product_id = uuid(d.id);
    },
  );
  await post(
    'own-order',
    '/orders',
    {
      source: 'manual',
      customer_name: 'QA156 Own Local Customer',
      email: 'qa156-order@example.test',
      warehouse_id: a.warehouse_id,
      payment_mode: 'prepaid',
      currency: 'PLN',
      shipping_cost: 0,
      items: [{ product_id: a.product_id, quantity: 1 }],
      note: 'QA156 own inbound binding, no financial or fulfillment action',
    },
    201,
    (d) => {
      a.order_id = uuid(d.id);
    },
    { 'Idempotency-Key': randomUUID() },
  );
  a.order = await get('/orders/' + a.order_id);
  assert.equal(a.order.total, 1000);
  assert.equal(a.order.status, 'new');
  await post('local-smtp-example', '/integrations/smtp-example', {}, 200, (d) => {
    assert.equal(d.delivery, 'local_sink');
    a.smtp_channel_id = uuid(d.channel_id);
  });
  await post(
    'own-imap-account',
    '/email-inbound/accounts',
    {
      client_key: randomUUID(),
      name: 'QA156 Own TLS Mailbox ' + state.suffix,
      host: '127.0.0.1',
      port: 4112,
      transport: 'local_fixture',
      folder: 'INBOX',
      smtp_channel_id: a.smtp_channel_id,
      enabled: true,
      credentials: { username: fixture.username, password: fixture.password },
    },
    201,
    (d) => {
      a.account = d.account;
      uuid(d.operation_id);
      assert.equal(d.reused, false);
      assert.equal(d.account.has_credentials, true);
      assert(!('credentials_encrypted' in d.account));
    },
  );
  a.born = await capture();
  assert.equal(a.born.rows.email_inbound_acquisitions.length, 0);
  assert.equal(a.born.rows.email_inbound_messages.length, 0);
  a.born_order = await get('/orders/' + a.order_id);
}
async function receive() {
  const a = state.actor;
  const r = await post(
    'explicit-imap-read',
    '/email-inbound/accounts/' + a.account.id + '/previews',
    {
      client_key: randomUUID(),
      account_version: String(a.account.version),
      after_uid: null,
      expected_uidvalidity: null,
      limit: 50,
      confirmed_read: true,
    },
    201,
    (d) => {
      a.acquisition = d.acquisition;
      a.preview = d.preview;
      uuid(d.acquisition.id);
      uuid(d.preview.id);
    },
  );
  assert.equal(r.acquisition.state, 'ready');
  assert.equal(r.preview.uidvalidity, '156');
  assert.equal(r.preview.uidnext, '5');
  assert.equal(r.preview.scanned_through_uid, '4');
  assert.deepEqual(
    r.preview.rows.map((v: any) => v.uid),
    ['1', '2', '4'],
  );
  assert.equal(r.preview.summary.new, 3);
  for (const row of r.preview.rows) {
    const source = fixture.messages.find((x: any) => String(x.uid) === row.uid);
    assert(source);
    assert.equal(row.raw_sha256, source.sha256);
    assert.equal(row.raw_bytes, source.byte_count);
  }
  assert.equal(r.preview.rows[1].attachments.length, 2);
  assert.equal(
    r.preview.rows[1].attachments[0].filename,
    r.preview.rows[1].attachments[1].filename,
  );
  assert.notEqual(r.preview.rows[1].attachments[0].sha256, r.preview.rows[1].attachments[1].sha256);
  assert.match(r.preview.rows[2].text, /Zwrot HTML żółty/);
  assert.deepEqual(await allMessages(), []);
}
async function imported() {
  const a = state.actor;
  await post(
    'explicit-full-import',
    '/email-inbound/previews/' + a.preview.id + '/import',
    { client_key: randomUUID(), scope_hash: a.preview.scope_hash, confirmed: true },
    201,
    (d) => {
      a.import = d.import;
      uuid(d.operation_id);
      assert.equal(d.import.new_count, 3);
      assert.equal(d.import.duplicate_count, 0);
      assert.equal(d.import.message_ids.length, 3);
    },
  );
  a.messages = await allMessages();
  assert.equal(a.messages.length, 3);
  assert(a.messages.every((m: any) => m.state === 'unassigned'));
  const target = a.messages.find((m: any) => m.uid === '2');
  assert(target);
  a.message_id = uuid(target.id);
  a.message = await get('/email-inbound/messages/' + a.message_id);
  const files = [];
  for (const attachment of a.message.message.attachments) {
    const c = await get(
      '/email-inbound/messages/' +
        a.message_id +
        '/attachments/' +
        attachment.index +
        '/content?workspace_id=' +
        a.tenant_id,
    );
    const bytes = Buffer.from(c.content_base64, 'base64');
    assert.equal(bytes.toString('base64'), c.content_base64);
    assert.equal(bytes.length, attachment.bytes);
    assert.equal(sha(bytes), attachment.sha256);
    files.push({ index: attachment.index, sha256: sha(bytes), bytes: bytes.length });
  }
  assert.equal(files.length, 2);
  a.attachment_proof = files;
}
async function bind() {
  const a = state.actor,
    m = (await get('/email-inbound/messages/' + a.message_id)).message,
    o = await get('/orders/' + a.order_id);
  await post(
    'explicit-order-binding',
    '/email-inbound/messages/' + m.id + '/bind',
    {
      client_key: randomUUID(),
      version: m.version,
      order_id: o.id,
      order_version: String(o.version),
      confirmed: true,
    },
    201,
    (d) => {
      a.binding = d.binding;
      a.message = d.message;
      assert.equal(d.message.state, 'bound');
      assert.equal(d.binding.order_id, a.order_id);
      uuid(d.binding.core_message_id);
    },
  );
  const cm = (await get('/customer-messages/' + a.binding.thread_id)).data;
  assert(Array.isArray(cm));
  const email = cm.find((r: any) => r.id === a.binding.core_message_id);
  assert(email);
  assert.equal(email.kind, 'email');
  assert.equal(email.body, m.text);
  assert.equal(email.email.message_id, m.id);
  assert.equal(email.email.from.address, m.headers.from.address);
}
async function replyPreview() {
  const a = state.actor,
    m = (await get('/email-inbound/messages/' + a.message_id)).message,
    o = await get('/orders/' + a.order_id),
    recipient = (m.headers.reply_to ?? m.headers.from).address.toLowerCase();
  await post(
    'explicit-free-reply-preview',
    '/email-inbound/messages/' + m.id + '/reply-previews',
    {
      client_key: randomUUID(),
      version: m.version,
      order_version: String(o.version),
      smtp_channel_id: a.smtp_channel_id,
      recipient,
      subject: 'QA156 Odpowiedź do rzeczywistego źródła',
      text: 'QA156 jawna lokalna odpowiedź SMTP po świadomym przypisaniu.',
    },
    201,
    (d) => {
      a.reply_preview = d.reply_preview;
      uuid(d.reply_preview.id);
      assert.equal(d.reply_preview.snapshot.payload.recipient, recipient);
      assert.equal(d.reply_preview.snapshot.payload.in_reply_to, m.headers.message_id);
      assert.equal(d.reply_preview.snapshot.sender.local_sink, true);
      assert.equal(d.reply_preview.can_queue, true);
    },
  );
}
async function queue() {
  const a = state.actor;
  await post(
    'explicit-smtp-queue',
    '/email-inbound/reply-previews/' + a.reply_preview.id + '/queue',
    {
      client_key: randomUUID(),
      scope_hash: a.reply_preview.scope_hash,
      confirmed: true,
      confirm_external: false,
    },
    201,
    (d) => {
      a.reply = d.reply;
      uuid(d.reply.id);
      uuid(d.reply.batch_id);
      uuid(d.reply.email_message_id);
      uuid(d.reply.job_id);
      assert.equal(d.reply.state, 'queued');
      assert.equal(d.reply.delivered, false);
    },
  );
}
async function verify() {
  const a = state.actor,
    expected = process.env.QA156_EXPECTED_SMTP_STATE ?? 'queued';
  assert(['queued', 'smtp_accepted', 'uncertain', 'failed'].includes(expected));
  const before = await capture();
  const r = await get('/email-inbound/replies/' + a.reply.id);
  assert.equal(r.reply.id, a.reply.id);
  assert.equal(r.reply.state, expected);
  assert.equal(r.reply.delivered, false);
  assert.equal(r.reply.snapshot.id, a.reply_preview.id);
  assert.deepEqual(r.reply.snapshot.snapshot, a.reply_preview.snapshot);
  if (expected === 'smtp_accepted') {
    assert.equal(r.reply.result.accepted_by_smtp, true);
    assert.equal(r.reply.result.local_sink, true);
    assert.equal(r.reply.result.delivered, false);
  }
  const after = await capture();
  assert.deepEqual(after.snapshot, before.snapshot, 'Effect-free verification GET');
  const { decrypt } = await import('../server/security');
  const { parseInboundMime } = await import('../server/email-inbound-mime');
  assert.equal(after.rows.email_inbound_sources.length, 3);
  for (const wrapper of after.rows.email_inbound_sources) {
    const source = wrapper.row,
      original = fixture.messages.find((m: any) => String(m.uid) === source.uid);
    assert(original);
    const decoded = decrypt(source.content_encrypted) as any,
      raw = Buffer.from(decoded.raw_base64, 'base64');
    assert.equal(raw.toString('base64'), decoded.raw_base64);
    assert.equal(raw.length, source.raw_bytes);
    assert.equal(sha(raw), source.raw_sha256);
    assert(
      raw.equals(await privateRead(resolve(root, 'data/imap-fixture156', original.file), 4194304)),
    );
    const parsed = await parseInboundMime(raw);
    assert.deepEqual(parsed.headers, source.headers);
    assert.equal(parsed.text, source.text_body);
    assert.equal(parsed.attachments.length, decoded.attachments.length);
    for (const [index, file] of parsed.attachments.entries()) {
      const metadata = source.attachments[index],
        frozen = decoded.attachments[index];
      assert.equal(metadata.index, index);
      assert.equal(metadata.sha256, file.sha256);
      assert.equal(metadata.bytes, file.bytes.length);
      assert.equal(frozen.content_base64, file.bytes.toString('base64'));
    }
  }
  const one = (name: string, id: string) => {
    const rows = after.rows[name].map((v: any) => v.row).filter((v: any) => v.id === id);
    assert.equal(rows.length, 1);
    return rows[0];
  };
  const native = one('email_inbound_replies', a.reply.id),
    em = one('email_messages', native.email_message_id),
    batch = one('email_batches', native.batch_id),
    job = one('jobs', native.job_id);
  assert.equal(em.job_id, job.id);
  assert.equal(em.batch_id, batch.id);
  assert.equal(job.kind, 'email.send');
  assert.deepEqual(job.payload, { message_id: em.id });
  assert.equal(job.max_attempts, 1);
  assert.equal(batch.inbound_reply_preview_id, a.reply_preview.id);
  assert.equal(batch.template_id, null);
  assert.deepEqual(em.payload, a.reply_preview.snapshot.payload);
  a.verified_reply = r.reply;
  a.verify_checkpoint = after;
}
async function main() {
  assert.equal(resolve(process.cwd()), root);
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert(phases.includes(phase as (typeof phases)[number]));
  assert.equal(process.argv.length, 3);
  assert.match(revision, /^[a-f0-9]{40}$/);
  for (const d of ['data', 'docs']) {
    const s = await lstat(resolve(root, d));
    assert(s.isDirectory() && !s.isSymbolicLink());
  }
  const configStat = await lstat(resolve(root, '.local.json'));
  assert(configStat.isFile() && !configStat.isSymbolicLink());
  assert.equal(configStat.mode & 0o777, 0o600);
  configBytes = await privateRead(configPath, 32768);
  fixture = JSON.parse(configBytes.toString());
  assert.equal(fixture.stage, 156);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.host, '127.0.0.1');
  assert.equal(fixture.port, 4112);
  assert.equal(fixture.folder, 'INBOX');
  assert.equal(fixture.uidvalidity, '156');
  assert.deepEqual(
    fixture.messages.map((m: any) => m.uid),
    [1, 2, 4],
  );
  for (const m of fixture.messages) {
    assert.equal(m.file, 'message-' + m.uid + '.eml');
    const raw = await privateRead(resolve(root, 'data/imap-fixture156', m.file), 4194304);
    assert.equal(raw.length, m.byte_count);
    assert.equal(sha(raw), m.sha256);
  }
  const fixtureDirectory = await lstat(dirname(configPath));
  assert(fixtureDirectory.isDirectory() && !fixtureDirectory.isSymbolicLink());
  assert.equal(fixtureDirectory.mode & 0o777, 0o700);
  const output = resolve(root, 'docs/email-inbound-native156-' + phase + '.json');
  await absent(output);
  await health();
  pool = (await import('../server/db')).pool;
  const u = new URL(pool.options.connectionString!);
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.port, '55432');
  assert.equal(u.pathname, '/dynaminds');
  const native = await pool.query(
    'SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port',
  );
  assert.deepEqual(native.rows[0], {
    role: 'postgres',
    db: 'dynaminds',
    host: '127.0.0.1',
    port: 55432,
  });
  if (phase === 'prepare') {
    assert.equal(process.env.QA156_FLOW_CONFIRM, 'PREPARE_NEW_OWN_EMAIL_FIXTURE');
    await absent(path);
    const suffix = randomUUID().slice(0, 8);
    state = {
      stage: 156,
      runtime_revision: revision,
      schema_revision: schema,
      suffix,
      fixture_config_sha256: sha(configBytes),
      status: 'PREPARED',
      phase: null,
      pending: null,
      completed: [],
      phase_checkpoints: {},
      actor: {
        email: 'qa156-' + suffix + '@demo.local',
        password: 'QA156-' + randomBytes(24).toString('hex'),
        cookie: '',
      },
      provider_verified: false,
      synthetic_mailbox: true,
      full_goal_complete: false,
    };
    await wx(path, state);
  } else {
    const bytes = await privateRead(path, 64 * 1024 * 1024);
    assert.equal(sha(bytes), process.env.QA156_JOURNAL_SHA256, 'Preserved known journal SHA');
    state = JSON.parse(bytes.toString());
    assert.equal(state.stage, 156);
    assert.equal(state.schema_revision, schema);
    assert.equal(state.fixture_config_sha256, sha(configBytes));
    assert.equal(state.pending, null);
    assert.equal(state.status, 'PHASE_COMPLETE');
    const previous = phases[phases.indexOf(phase as (typeof phases)[number]) - 1];
    assert.equal(state.phase, previous, 'Strict known phase continuation');
    await identity();
    if (phase !== 'verify')
      assert.equal(
        process.env.QA156_FLOW_CONFIRM,
        'CONFIRM_OWN_EMAIL_' + phase!.toUpperCase().replace('-', '_'),
      );
  }
  const before = phase === 'prepare' ? null : await capture();
  await (
    {
      prepare,
      receive,
      import: imported,
      bind,
      'reply-preview': replyPreview,
      queue,
      verify,
    } as Record<string, () => Promise<void>>
  )[phase!]();
  const after = await capture();
  if (before) unaffected(before, after);
  if (state.actor.born) unaffected(state.actor.born, after);
  assert((await readFile(configPath)).equals(configBytes));
  assert.equal(state.pending, null);
  await health();
  state.phase = phase;
  state.status = 'PHASE_COMPLETE';
  state.runtime_revision = revision;
  state.phase_checkpoints[phase!] = after;
  await save();
  const report = {
    stage: 156,
    phase,
    status: 'OWN_LOCAL_EMAIL_PHASE_PASS',
    revision,
    schema_revision: schema,
    tenant_id: state.actor.tenant_id,
    user_id: state.actor.user_id,
    order_id: state.actor.order_id,
    account_id: state.actor.account.id,
    acquisition_id: state.actor.acquisition?.id ?? null,
    preview_id: state.actor.preview?.id ?? null,
    message_id: state.actor.message_id ?? null,
    reply_preview_id: state.actor.reply_preview?.id ?? null,
    reply_id: state.actor.reply?.id ?? null,
    own_tables: Object.keys(after.snapshot).length,
    own_snapshot_sha256: fp(after.snapshot),
    phase_successful_writes: state.completed.filter((x: any) => x.phase === phase).length,
    total_successful_writes: state.completed.length,
    fixture_config_unchanged: true,
    synthetic_mailbox: true,
    provider_verified: false,
    smtp_state: phase === 'verify' ? state.actor.verified_reply.state : null,
    delivered: false,
    financial_and_fulfillment_unchanged: phase !== 'prepare',
    no_worker_invocation: true,
    chrome_verified: false,
    full_goal_complete: false,
    journal_sha256: sha(await readFile(path)),
  };
  await wx(output, report, 0o644);
  process.stdout.write(
    JSON.stringify({ stage: 156, phase, status: report.status, provider_verified: false }) + '\n',
  );
}
main()
  .catch(async () => {
    if (state && state.pending) {
      state.status = 'UNKNOWN_OR_UNCONFIRMED_DO_NOT_RETRY';
      await save().catch(() => {});
    }
    process.stderr.write(
      'QA156_NATIVE_FAILED_PHASE_' + String(phase) + '_STEP_' + step + '_NO_PRIVATE_OUTPUT\n',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool?.end();
  });
