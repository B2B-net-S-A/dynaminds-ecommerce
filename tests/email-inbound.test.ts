import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import {
  emailInboundFixture,
  normalizedInboundPreview,
  inboundBusiness,
} from './email-inbound-fixture';
import { processEmail } from '../server/email';
import { smtpReplyHeaders } from '../server/smtp';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
});
after(async () => {
  await app?.close();
  await pool.end();
});
const consent = (scope_hash: string) => ({ client_key: randomUUID(), scope_hash, confirmed: true });
test('full source import → explicit own-order bind → immutable free reply SMTP graph, with zero commerce effects', async () => {
  const f = await emailInboundFixture(app),
    business = await inboundBusiness(f),
    p = await normalizedInboundPreview(f, 'x'.repeat(5001)),
    body = consent(p.scope_hash);
  const imported = await f.ok('/email-inbound/previews/' + p.id + '/import', 'POST', body, 201);
  assert.equal(imported.import.new_count, 1);
  const ledger = (
    await pool.query(
      'SELECT to_jsonb(x) r FROM email_inbound_operations x WHERE tenant_id=$1 ORDER BY id',
      [f.tenant],
    )
  ).rows;
  const replay = await f.ok('/email-inbound/previews/' + p.id + '/import', 'POST', body);
  assert(replay.reused);
  assert.deepEqual(replay.import, imported.import);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT to_jsonb(x) r FROM email_inbound_operations x WHERE tenant_id=$1 ORDER BY id',
        [f.tenant],
      )
    ).rows,
    ledger,
  );
  const mid = imported.import.message_ids[0],
    m = (await f.ok('/email-inbound/messages/' + mid)).message;
  assert.equal(m.state, 'unassigned');
  const bound = await f.ok(
    '/email-inbound/messages/' + mid + '/bind',
    'POST',
    {
      client_key: randomUUID(),
      version: m.version,
      order_id: f.order.id,
      order_version: f.order.version,
      confirmed: true,
    },
    201,
  );
  const core = (
    await pool.query('SELECT kind,body,actor_id FROM customer_messages WHERE id=$1', [
      bound.binding.core_message_id,
    ])
  ).rows[0];
  assert.equal(core.kind, 'email');
  assert.equal(core.body, p.rows[0].text);
  assert.equal(core.body.length, 5001);
  assert.equal(core.actor_id, f.user);
  const portal = await f.ok('/public/orders/' + f.order.portal_token + '/messages');
  assert.deepEqual(portal.data, []);
  const rp = (
    await f.ok(
      '/email-inbound/messages/' + mid + '/reply-previews',
      'POST',
      {
        client_key: randomUUID(),
        version: bound.message.version,
        order_version: f.order.version,
        smtp_channel_id: f.channel,
        recipient: 'reply@example.test',
        subject: 'Re: source',
        text: 'Own explicit answer',
      },
      201,
    )
  ).reply_preview;
  assert.equal(rp.snapshot.payload.in_reply_to, '<source-156@example.test>');
  assert.equal(rp.snapshot.payload.recipient, 'reply@example.test');
  const qb = { ...consent(rp.scope_hash), confirm_external: false },
    queued = await f.ok('/email-inbound/reply-previews/' + rp.id + '/queue', 'POST', qb, 201),
    requeued = await f.ok('/email-inbound/reply-previews/' + rp.id + '/queue', 'POST', qb);
  assert.equal(queued.reply.state, 'queued');
  assert.equal(queued.reply.delivered, false);
  assert.equal(requeued.reply.id, queued.reply.id);
  const b = (await pool.query('SELECT * FROM email_batches WHERE id=$1', [queued.reply.batch_id]))
    .rows[0];
  assert.equal(b.template_id, null);
  assert.equal(b.inbound_reply_preview_id, rp.id);
  const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [queued.reply.job_id])).rows[0];
  assert.equal(job.kind, 'email.send');
  assert.equal(job.max_attempts, 1);
  assert.deepEqual(await inboundBusiness(f), business);
});
test('empty imported mailbox keeps null cursor; later first UID imports without manual namespace reset', async () => {
  const f = await emailInboundFixture(app),
    empty = await normalizedInboundPreview(f, '', { empty: true, uidnext: '1' });
  assert.equal(empty.scanned_through_uid, '0');
  await f.ok(
    '/email-inbound/previews/' + empty.id + '/import',
    'POST',
    consent(empty.scope_hash),
    201,
  );
  f.account = (await f.ok('/email-inbound/accounts')).data[0];
  assert.equal(f.account.last_uid, null);
  assert.equal(f.account.uidvalidity, '156');
  const p = await normalizedInboundPreview(f);
  const r = await f.ok(
    '/email-inbound/previews/' + p.id + '/import',
    'POST',
    consent(p.scope_hash),
    201,
  );
  assert.equal(r.import.new_count, 1);
  assert.equal((await f.ok('/email-inbound/accounts')).data[0].last_uid, '1');
});
test('attachment-only empty text binds exactly and authenticated attachment bytes are preserved', async () => {
  const f = await emailInboundFixture(app),
    raw = Buffer.from(
      'From: Sender <sender@example.test>\r\nMessage-ID: <attachment@example.test>\r\nSubject: Attachment only\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="qa156"\r\n\r\n--qa156\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="empty.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n\r\n--qa156--\r\n',
    ),
    p = await normalizedInboundPreview(f, '', { raw });
  assert.equal(p.rows[0].text, '');
  assert.equal(p.rows[0].attachments[0].bytes, 0);
  const im = await f.ok(
      '/email-inbound/previews/' + p.id + '/import',
      'POST',
      consent(p.scope_hash),
      201,
    ),
    m = (await f.ok('/email-inbound/messages/' + im.import.message_ids[0])).message;
  const bound = await f.ok(
    '/email-inbound/messages/' + m.id + '/bind',
    'POST',
    {
      client_key: randomUUID(),
      version: m.version,
      order_id: f.order.id,
      order_version: f.order.version,
      confirmed: true,
    },
    201,
  );
  assert.equal(
    (
      await pool.query('SELECT body FROM customer_messages WHERE id=$1', [
        bound.binding.core_message_id,
      ])
    ).rows[0].body,
    '',
  );
  const content = await f.ok(
    '/email-inbound/messages/' + m.id + '/attachments/0/content?workspace_id=' + f.tenant,
  );
  assert.equal(content.content_base64, '');
  assert.equal(content.bytes, 0);
});
test('current worker principal withdrawal fails before SMTP attempt; no synthesized template or transport retry', async () => {
  const f = await emailInboundFixture(app),
    p = await normalizedInboundPreview(f),
    im = await f.ok(
      '/email-inbound/previews/' + p.id + '/import',
      'POST',
      consent(p.scope_hash),
      201,
    ),
    m = (await f.ok('/email-inbound/messages/' + im.import.message_ids[0])).message;
  const bound = await f.ok(
      '/email-inbound/messages/' + m.id + '/bind',
      'POST',
      {
        client_key: randomUUID(),
        version: m.version,
        order_id: f.order.id,
        order_version: f.order.version,
        confirmed: true,
      },
      201,
    ),
    rp = (
      await f.ok(
        '/email-inbound/messages/' + m.id + '/reply-previews',
        'POST',
        {
          client_key: randomUUID(),
          version: bound.message.version,
          order_version: f.order.version,
          smtp_channel_id: f.channel,
          recipient: 'reply@example.test',
          subject: 'Own reply',
          text: 'No automatic send',
        },
        201,
      )
    ).reply_preview;
  const r = await f.ok(
    '/email-inbound/reply-previews/' + rp.id + '/queue',
    'POST',
    { ...consent(rp.scope_hash), confirm_external: false },
    201,
  );
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    f.tenant,
    f.user,
  ]);
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [r.reply.job_id, randomUUID()],
    )
  ).rows[0];
  await assert.rejects(processEmail(job));
  assert.equal(
    (
      await pool.query('SELECT attempted_at FROM email_messages WHERE id=$1', [
        r.reply.email_message_id,
      ])
    ).rows[0].attempted_at,
    null,
  );
});
test('RFC reply headers deny injection while preserving long bounded chains and own generated message id policy', () => {
  assert(
    smtpReplyHeaders.safeParse({
      in_reply_to: '<in@example.test>',
      references: Array.from({ length: 100 }, (_, i) => `<ref${i}@example.test>`),
    }).success,
  );
  assert(
    !smtpReplyHeaders.safeParse({ in_reply_to: '<safe@example.test>\r\nBcc: stolen@example.test' })
      .success,
  );
  assert(!smtpReplyHeaders.safeParse({ references: ['not-an-rfc-id'] }).success);
  assert(
    !smtpReplyHeaders.safeParse({
      references: Array.from({ length: 102 }, () => '<x@example.test>'),
    }).success,
  );
});
