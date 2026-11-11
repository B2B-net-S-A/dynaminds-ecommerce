import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { buildApp } from '../server/app';
import { pool, migrate, localConfig } from '../server/db';
import { seed } from './fixtures';
import { emailInboundFixture, inboundBusiness } from './email-inbound-fixture';
import { processEmail } from '../server/email';
import { localSmtpPassword } from '../server/smtp';
import { validateRecoveredInboundEmail } from '../server/email-inbound-recovery';

// Explicit root gate: real loopback protocols and disposable SQL, never provider proof.
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL ?? '').pathname, /^\/dynaminds_test_\d+$/);
assert.equal(process.env.DYNA_ALLOW_IMAP_FIXTURE, 'true');
assert.equal(process.env.DYNA_NATIVE_EMAIL_PROTOCOL156, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
let authenticated = 0;
const received: Buffer[] = [];
const smtp = new SMTPServer({
  secure: false,
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  logger: false,
  onAuth(auth, _session, cb) {
    if (auth.username === 'dyna-local' && auth.password === localSmtpPassword()) {
      authenticated++;
      cb(null, { user: 'own-qa156' });
    } else cb(new Error('Authentication refused'));
  },
  onMailFrom(a, _s, cb) {
    cb(a.address.endsWith('.test') ? undefined : new Error('Only .test'));
  },
  onRcptTo(a, _s, cb) {
    cb(a.address.endsWith('.test') ? undefined : new Error('Only .test'));
  },
  onData(stream, _s, cb) {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 4 * 1024 * 1024) chunks.push(chunk);
    });
    stream.on('error', cb);
    stream.on('end', () => {
      if (size > 4 * 1024 * 1024) return cb(new Error('Too large'));
      received.push(Buffer.concat(chunks));
      cb();
    });
  },
});
let listening = false;
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  await new Promise<void>((resolve, reject) => {
    smtp.once('error', reject);
    smtp.listen(1025, '127.0.0.1', () => {
      listening = true;
      resolve();
    });
  });
});
after(async () => {
  if (listening) await new Promise<void>((resolve) => smtp.close(() => resolve()));
  await app?.close();
  await pool.end();
});
test('actual IMAP TLS → guarded preview/import → own order → real SMTP AUTH/DATA and RFC reply chain', async () => {
  const path = process.env.DYNA_EMAIL_FIXTURE_CONFIG_PATH;
  assert(typeof path === 'string' && path.startsWith('/'));
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.stage, 156);
  assert.equal(config.synthetic, true);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4112);
  const f = await emailInboundFixture(app),
    foreign = await emailInboundFixture(app);
  const business = await inboundBusiness(f);
  const updated = await f.ok('/email-inbound/accounts/' + f.account.id, 'PATCH', {
    ...f.accountBody,
    client_key: randomUUID(),
    version: f.account.version,
    credentials: { action: 'replace', username: config.username, password: config.password },
  });
  const account = updated.account;
  assert(!JSON.stringify(account).includes(config.password));
  const fetchBody = {
    client_key: randomUUID(),
    account_version: account.version,
    after_uid: null,
    expected_uidvalidity: null,
    limit: 50,
    confirmed_read: true,
  };
  const prepared = await f.ok(
    '/email-inbound/accounts/' + account.id + '/previews',
    'POST',
    fetchBody,
    201,
  );
  const p = prepared.preview;
  assert.equal(prepared.acquisition.state, 'ready');
  assert.equal(p.rows.length, 3);
  assert.deepEqual(
    p.rows.map((r: any) => r.uid),
    ['1', '2', '4'],
  );
  for (const row of p.rows) {
    const original = config.messages.find((m: any) => String(m.uid) === row.uid);
    assert.equal(row.raw_sha256, original.sha256);
    assert.equal(row.raw_bytes, original.byte_count);
  }
  assert.equal(p.rows[1].attachments.length, 2);
  assert.equal(p.rows[1].attachments[0].filename, p.rows[1].attachments[1].filename);
  assert.notEqual(p.rows[1].attachments[0].sha256, p.rows[1].attachments[1].sha256);
  const replay = await f.ok(
    '/email-inbound/accounts/' + account.id + '/previews',
    'POST',
    fetchBody,
  );
  assert.equal(replay.reused, true);
  assert.equal(replay.preview.id, p.id);
  assert.equal((await f.ok('/email-inbound/messages')).data.length, 0);
  const consent = { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true };
  const imported = await f.ok('/email-inbound/previews/' + p.id + '/import', 'POST', consent, 201);
  assert.equal(imported.import.new_count, 3);
  assert.equal(
    (await f.ok('/email-inbound/previews/' + p.id + '/import', 'POST', consent)).reused,
    true,
  );
  const messages = (await f.ok('/email-inbound/messages')).data;
  assert.equal(messages.length, 3);
  const firstHead = messages.find((m: any) => m.uid === '1'),
    binaryHead = messages.find((m: any) => m.uid === '2');
  assert(firstHead && binaryHead);
  const first = (await f.ok('/email-inbound/messages/' + firstHead.id)).message;
  const binary = (await f.ok('/email-inbound/messages/' + binaryHead.id)).message;
  assert.equal(first.text, p.rows[0].text);
  assert.deepEqual(first.headers, p.rows[0].headers);
  assert.deepEqual(binary.attachments, p.rows[1].attachments);
  for (let index = 0; index < 2; index++) {
    const attachment = await f.ok(
      '/email-inbound/messages/' +
        binary.id +
        '/attachments/' +
        index +
        '/content?workspace_id=' +
        f.tenant,
    );
    assert.equal(
      createHash('sha256').update(Buffer.from(attachment.content_base64, 'base64')).digest('hex'),
      binary.attachments[index].sha256,
    );
    assert.equal(
      (
        await foreign.request(
          '/email-inbound/messages/' +
            binary.id +
            '/attachments/' +
            index +
            '/content?workspace_id=' +
            foreign.tenant,
        )
      ).statusCode,
      404,
    );
  }
  const bound = await f.ok(
    '/email-inbound/messages/' + first.id + '/bind',
    'POST',
    {
      client_key: randomUUID(),
      version: first.version,
      order_id: f.order.id,
      order_version: f.order.version,
      confirmed: true,
    },
    201,
  );
  const core = (
    await pool.query('SELECT thread_id FROM customer_messages WHERE id=$1', [
      bound.binding.core_message_id,
    ])
  ).rows[0];
  const thread = await f.ok('/customer-messages/' + core.thread_id);
  const shown = thread.data.find((m: any) => m.id === bound.binding.core_message_id);
  assert(shown);
  assert.equal(shown.kind, 'email');
  assert.equal(shown.body, first.text);
  assert.equal(shown.received_by, f.user);
  assert.equal(shown.author_id, f.user);
  assert.deepEqual(shown.email.from, first.headers.from);
  assert.equal(shown.email.subject, first.headers.subject);
  assert.deepEqual((await f.ok('/public/orders/' + f.order.portal_token + '/messages')).data, []);
  const recipient = (first.headers.reply_to ?? first.headers.from).address;
  const replyBody = {
    client_key: randomUUID(),
    version: bound.message.version,
    order_version: f.order.version,
    smtp_channel_id: f.channel,
    recipient,
    subject: 'Re: ' + first.headers.subject,
    text: 'Odpowiedź QA156: dziękujemy za wiadomość.',
  };
  const rp = (
    await f.ok('/email-inbound/messages/' + first.id + '/reply-previews', 'POST', replyBody, 201)
  ).reply_preview;
  assert.equal(received.length, 0);
  const queueBody = {
    client_key: randomUUID(),
    scope_hash: rp.scope_hash,
    confirmed: true,
    confirm_external: false,
  };
  const reply = (
    await f.ok('/email-inbound/reply-previews/' + rp.id + '/queue', 'POST', queueBody, 201)
  ).reply;
  assert.equal(
    (await f.ok('/email-inbound/reply-previews/' + rp.id + '/queue', 'POST', queueBody)).reply.id,
    reply.id,
  );
  assert.equal(received.length, 0);
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 AND tenant_id=$3 AND state='pending' RETURNING *",
      [reply.job_id, randomUUID(), f.tenant],
    )
  ).rows[0];
  assert(job);
  await processEmail(job);
  const actual = (await f.ok('/email-inbound/replies/' + reply.id)).reply;
  assert.equal(actual.state, 'smtp_accepted');
  assert.equal(actual.delivered, false);
  assert.equal(authenticated, 1);
  assert.equal(received.length, 1);
  const parsed = await simpleParser(received[0]);
  assert.equal(parsed.messageId, `<${reply.email_message_id}@dynaminds.local>`);
  assert.equal(parsed.inReplyTo, first.headers.message_id);
  assert.deepEqual(
    Array.isArray(parsed.references) ? parsed.references : [parsed.references],
    rp.snapshot.payload.references,
  );
  assert.equal((parsed.to as any).value[0].address, recipient);
  assert.equal(parsed.subject, replyBody.subject);
  assert.equal(parsed.text?.trim(), replyBody.text);
  await processEmail(job);
  assert.equal(received.length, 1);
  const current = (await f.ok('/email-inbound/accounts')).data[0];
  assert.equal(current.last_uid, '4');
  const empty = await f.ok(
    '/email-inbound/accounts/' + current.id + '/previews',
    'POST',
    {
      client_key: randomUUID(),
      account_version: current.version,
      after_uid: '4',
      expected_uidvalidity: '156',
      limit: 50,
      confirmed_read: true,
    },
    201,
  );
  assert.equal(empty.preview.rows.length, 0);
  assert.equal(empty.preview.scanned_through_uid, '4');
  assert.deepEqual(await inboundBusiness(f), business);
  const c = await pool.connect();
  let recovered = 0;
  try {
    recovered = await validateRecoveredInboundEmail(c, localConfig.encryptionKey);
  } finally {
    c.release();
  }
  assert(recovered >= 5);
  const report = {
    stage: 156,
    status: 'PASS',
    synthetic_mailboxes: true,
    real_loopback_imap_tls: true,
    real_loopback_smtp_auth_data: true,
    provider_proof: false,
    native_app_accepted: false,
    chrome_accepted: false,
    disposable_database: true,
    imported_messages: 3,
    authenticated_smtp: authenticated,
    smtp_received: received.length,
    smtp_sha256: createHash('sha256').update(received[0]).digest('hex'),
    delivered: false,
    exact_replay: true,
    duplicate_filenames_preserved: true,
    foreign_attachment_denied: true,
    portal_staff_email_hidden: true,
    staff_from_and_binding_actor_verified: true,
    smtp_reply_target_tested: 'fallback_from',
    smtp_reference_chain_tested: 'single_source_message_id',
    distinct_reply_to_real_protocol_verified: false,
    long_reference_chain_real_protocol_verified: false,
    empty_cursor_window: true,
    commerce_unchanged: true,
    commerce_snapshot_tables: ['orders', 'order_items', 'stock', 'stock_locations', 'stock_movements', 'payment_entries', 'documents', 'shipments'],
    exact_replay_proof: 'same_durable_acquisition_import_and_reply_identity',
    per_request_imap_command_count_proven: false,
    encrypted_sources_validated: recovered,
    goal_complete: false,
  };
  await writeFile('docs/email-inbound-protocol156-' + randomUUID() + '.json', JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
});
