import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { buildApp } from '../server/app';
import { pool, migrate, localConfig } from '../server/db';
import { seed } from './fixtures';
import { emailInboundFixture, normalizedInboundPreview } from './email-inbound-fixture';
import { encrypt } from '../server/security';
import { validateRecoveredInboundEmail } from '../server/email-inbound-recovery';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
} from '../server/recovery';

// Root-run host-native gate only. Never use the active application database.
assert.equal(process.env.DYNA_TEST, 'true');
const connection = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost'].includes(connection.hostname));
assert.equal(connection.port, '55432');
assert.match(connection.pathname, /^\/dynaminds_test_\d+$/);
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
type QueryClient = Pick<pg.Client, 'query'>;
async function rows(c: QueryClient, tenants: string[]) {
  const result: Record<string, unknown[]> = {};
  for (const table of tables)
    result[table] = (
      await c.query(
        `SELECT to_jsonb(x) row FROM ${table} x WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [tenants],
      )
    ).rows;
  return result;
}
async function snapshot(c: QueryClient, tenants: string[]) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    const value = await rows(c, tenants);
    await c.query('COMMIT');
    return value;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
  }
}
const consent = (scope_hash: string) => ({ client_key: randomUUID(), scope_hash, confirmed: true });
function same(actual: unknown, expected: unknown, label: string) {
  assert(isDeepStrictEqual(actual, expected), label); // Never print MIME, credentials or ciphertext.
}
async function databases() {
  return (await pool.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
    (r) => r.datname as string,
  );
}

test('real encrypted backup restores all ten inbound tables and rejects a validly encrypted substituted raw MIME', async () => {
  const firms = [];
  for (let index = 0; index < 3; index++) {
    const f = await emailInboundFixture(app);
    const raw = Buffer.from(
      [
        'From: Source <source@example.test>',
        'Reply-To: reply@example.test',
        'To: owner@example.test',
        `Message-ID: <backup-${index}@example.test>`,
        'Subject: Backup source',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="backup156"',
        '',
        '--backup156',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Frozen source ' + index,
        '--backup156',
        'Content-Type: application/octet-stream',
        'Content-Disposition: attachment; filename="same.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        'AAECAwQ=',
        '--backup156',
        'Content-Type: application/octet-stream',
        'Content-Disposition: attachment; filename="same.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        'BQYHCAk=',
        '--backup156--',
        '',
      ].join('\r\n'),
    );
    const preview = await normalizedInboundPreview(f, '', { raw });
    assert.equal(preview.rows[0].attachments.length, 2);
    const imported = await f.ok(
      '/email-inbound/previews/' + preview.id + '/import',
      'POST',
      consent(preview.scope_hash),
      201,
    );
    assert.equal(imported.import.new_count, 1);
    firms.push({ f, message_id: imported.import.message_ids[0] as string });
  }
  const { f, message_id } = firms[0];
  const message = (await f.ok('/email-inbound/messages/' + message_id)).message;
  const bound = await f.ok(
    '/email-inbound/messages/' + message_id + '/bind',
    'POST',
    {
      client_key: randomUUID(),
      version: message.version,
      order_id: f.order.id,
      order_version: f.order.version,
      confirmed: true,
    },
    201,
  );
  const preview = (
    await f.ok(
      '/email-inbound/messages/' + message_id + '/reply-previews',
      'POST',
      {
        client_key: randomUUID(),
        version: bound.message.version,
        order_version: f.order.version,
        smtp_channel_id: f.channel,
        recipient: 'reply@example.test',
        subject: 'Own backup reply',
        text: 'No SMTP execution.',
      },
      201,
    )
  ).reply_preview;
  const reply = (
    await f.ok(
      '/email-inbound/reply-previews/' + preview.id + '/queue',
      'POST',
      {
        ...consent(preview.scope_hash),
        confirm_external: false,
      },
      201,
    )
  ).reply;
  assert.equal(reply.state, 'queued');
  const tenants = firms.map(({ f }) => f.tenant);
  const originalClient = await pool.connect();
  let original: Awaited<ReturnType<typeof snapshot>>;
  try {
    original = await snapshot(originalClient, tenants);
  } finally {
    originalClient.release();
  }
  assert.equal(original.email_inbound_accounts.length, 3);
  assert.equal(original.email_inbound_sources.length, 3);
  assert.equal(original.email_inbound_bindings.length, 1);
  assert.equal(original.email_inbound_replies.length, 1);
  const directory = await mkdtemp(resolve('data/test-email-inbound-backup-'));
  const recoveryKey = resolve(directory, 'recovery-key');
  let ownedDatabase: string | undefined;
  const beforeDatabases = await databases();
  try {
    const backup = await createBackup({ directory, keyFile: recoveryKey });
    const restored = await restoreBackup(backup.file, {
      directory: resolve(directory, 'good'),
      keyFile: recoveryKey,
    });
    const candidate = restoreDatabaseName(restored.database);
    assert(!beforeDatabases.includes(candidate), 'Restore must own a newly created database');
    ownedDatabase = candidate;
    assert.equal(restored.row_fingerprints_match, true);
    assert.equal(restored.schema_fingerprint_match, true);
    assert(restored.encrypted_records_verified >= 6);
    const copy = new pg.Client({ ...localDatabase(), database: ownedDatabase });
    await copy.connect();
    try {
      same(await snapshot(copy, tenants), original, 'All ten inbound tables must restore exactly');
      assert((await validateRecoveredInboundEmail(copy, localConfig.encryptionKey)) >= 6);
      const queued = (
        await copy.query(
          'SELECT state,attempted_at FROM email_messages WHERE tenant_id=$1 AND id=$2',
          [f.tenant, reply.email_message_id],
        )
      ).rows[0];
      same(
        queued,
        { state: 'queued', attempted_at: null },
        'Restoration must not submit queued SMTP',
      );
    } finally {
      await copy.end();
    }

    const old = (
      await pool.query(
        'SELECT id,tenant_id,content_encrypted FROM email_inbound_sources WHERE tenant_id=$1 ORDER BY id LIMIT 1',
        [f.tenant],
      )
    ).rows[0];
    async function replaceCipher(value: string) {
      // Deliberate postgres-only corruption fixture. Disable exactly the own immutable
      // trigger in one transaction and restore its enabled state before COMMIT.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        assert.equal((await c.query('SELECT current_user role')).rows[0].role, 'postgres');
        await c.query('ALTER TABLE email_inbound_sources DISABLE TRIGGER email_inbound_immutable');
        const changed = await c.query(
          'UPDATE email_inbound_sources SET content_encrypted=$3 WHERE tenant_id=$1 AND id=$2',
          [old.tenant_id, old.id, value],
        );
        assert.equal(changed.rowCount, 1);
        await c.query('ALTER TABLE email_inbound_sources ENABLE TRIGGER email_inbound_immutable');
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    }
    try {
      await replaceCipher(
        encrypt({
          raw_base64: Buffer.from('From: other@example.test\r\n\r\nChanged').toString('base64'),
          attachments: [],
        }),
      );
      const beforeBadRestore = await databases();
      const bad = await createBackup({ directory, keyFile: recoveryKey });
      let unexpectedDatabase: string | undefined;
      try {
        await assert.rejects(
          async () => {
            const unexpected = await restoreBackup(bad.file, {
              directory: resolve(directory, 'bad'),
              keyFile: recoveryKey,
            });
            const candidate = restoreDatabaseName(unexpected.database);
            assert(
              !beforeBadRestore.includes(candidate),
              'Unexpected restore must also own a new database',
            );
            unexpectedDatabase = candidate;
          },
          (error: unknown) => {
            assert(error instanceof Error);
            assert.equal(
              error.message,
              'Poczta przychodząca w kopii nie odpowiada szyfrowanej treści',
            );
            return true;
          },
        );
      } finally {
        if (unexpectedDatabase)
          await pool.query(
            'DROP DATABASE ' + restoreDatabaseName(unexpectedDatabase) + ' WITH (FORCE)',
          );
      }
      same(await databases(), beforeBadRestore, 'Failed restore must remove its own new database');
    } finally {
      await replaceCipher(old.content_encrypted);
    }
    const c = await pool.connect();
    try {
      same(
        await snapshot(c, tenants),
        original,
        'Original three firms remain byte-exact after restore and corruption fixture cleanup',
      );
    } finally {
      c.release();
    }
  } finally {
    if (ownedDatabase) {
      const checked = restoreDatabaseName(ownedDatabase);
      assert(!beforeDatabases.includes(checked));
      await pool.query('DROP DATABASE ' + checked + ' WITH (FORCE)');
    }
    await rm(directory, { recursive: true, force: true });
  }
});
