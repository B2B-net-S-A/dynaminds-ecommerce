/** Root-only, genuine loopback TLS/ImapFlow proof with synthetic mailbox content. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { ImapFlow } from 'imapflow';
import { fetchInboundMailbox, EmailInboundError } from '../server/email-inbound-transport';
const root = '<workspace>/app';
const directory = resolve(root, 'data/imap-fixture156');
const phase = process.argv[2] ?? 'first';
const output = resolve(
  '<workspace>/worktrees/stock-file-import/docs/email-inbound-transport-native156' +
    (phase === 'first' ? '' : '-' + phase) +
    '.json',
);
const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let step = 'preflight';
async function main() {
  assert(['first', 'after-sni-fix'].includes(phase));
  assert.equal(resolve(process.cwd()), root);
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_ALLOW_IMAP_FIXTURE, 'true');
  assert.equal(process.env.DYNA_IMAP_FIXTURE_CA_PATH, resolve(directory, 'ca.pem'));
  const stat = await lstat(resolve(directory, 'config.json'));
  assert(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  const original = await readFile(resolve(directory, 'config.json'));
  const config = JSON.parse(original.toString());
  assert.equal(config.stage, 156);
  assert.equal(config.synthetic, true);
  assert.deepEqual(
    config.messages.map((m: any) => m.uid),
    [1, 2, 4],
  );
  const account = {
    host: '127.0.0.1',
    port: 4112 as const,
    transport: 'local_fixture' as const,
    folder: 'INBOX',
    username: config.username,
    password: config.password,
  };
  let before = 0,
    after = 0;
  const hooks = {
    beforeAuth: async () => {
      before++;
    },
    afterFetch: async () => {
      after++;
    },
  };
  step = 'first_complete_read';
  const first = await fetchInboundMailbox(
    account,
    { after_uid: null, expected_uidvalidity: null, limit: 50 },
    hooks,
  );
  assert.equal(first.uidvalidity, '156');
  assert.equal(first.uidnext, '5');
  assert.equal(first.scanned_through_uid, '4');
  assert.deepEqual(
    first.messages.map((m) => m.uid),
    ['1', '2', '4'],
  );
  for (const m of first.messages) {
    const fixture = config.messages.find((f: any) => String(f.uid) === m.uid);
    assert(fixture);
    assert.equal(m.raw.length, fixture.byte_count);
    assert.equal(m.raw_sha256, fixture.sha256);
    assert(m.raw.equals(await readFile(resolve(directory, fixture.file))));
  }
  assert(first.messages[1].attachments.length === 2);
  assert.equal(
    first.messages[1].attachments[0].filename,
    first.messages[1].attachments[1].filename,
  );
  assert.notEqual(first.messages[1].attachments[0].sha256, first.messages[1].attachments[1].sha256);
  assert.match(first.messages[2].text, /Zwrot HTML żółty/);
  assert(!Object.hasOwn(first.messages[2], 'html'));
  step = 'sparse_uid_read';
  const later = await fetchInboundMailbox(
    account,
    { after_uid: '1', expected_uidvalidity: '156', limit: 3 },
    hooks,
  );
  assert.deepEqual(
    later.messages.map((m) => m.uid),
    ['2', '4'],
  );
  assert.equal(later.scanned_through_uid, '4');
  step = 'empty_following_window';
  const empty = await fetchInboundMailbox(
    account,
    { after_uid: '4', expected_uidvalidity: '156', limit: 50 },
    hooks,
  );
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.scanned_through_uid, '4');
  assert.equal(before, 3);
  assert.equal(after, 3);
  step = 'untrusted_certificate';
  await assert.rejects(
    fetchInboundMailbox(
      account,
      { after_uid: null, expected_uidvalidity: null, limit: 1 },
      {},
      {
        createClient: (options) =>
          new ImapFlow({ ...options, tls: { ...options.tls, ca: undefined } }),
      },
    ),
    (e) =>
      e instanceof EmailInboundError &&
      e.code === 'TRANSPORT_FAILED' &&
      !e.message.includes(config.password),
  );
  step = 'wrong_certificate_name';
  await assert.rejects(
    fetchInboundMailbox(
      account,
      { after_uid: null, expected_uidvalidity: null, limit: 1 },
      {},
      {
        createClient: (options) =>
          new ImapFlow({
            ...options,
            tls: {
              ...options.tls,
              checkServerIdentity: (_host, cert) => checkServerIdentity('wrong.example.test', cert),
            },
          }),
      },
    ),
    (e) => e instanceof EmailInboundError && e.code === 'TRANSPORT_FAILED',
  );
  assert((await readFile(resolve(directory, 'config.json'))).equals(original));
  const sourceFiles = [
    'server/email-inbound-transport.ts',
    'server/email-inbound-mime.ts',
    'scripts/imap-fixture156.ts',
    'scripts/email-inbound-transport-native156.ts',
  ];
  const source_sha256 = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        hash(
          await readFile(
            resolve('<workspace>/worktrees/stock-file-import', file),
          ),
        ),
      ]),
    ),
  );
  const report = {
    stage: 156,
    status: 'REAL_LOOPBACK_IMAP_TLS_PASS',
    provider_proof: false,
    synthetic_content: true,
    uidvalidity: '156',
    uidnext: '5',
    first_uids: ['1', '2', '4'],
    sparse_uids: ['2', '4'],
    empty_next_read: true,
    raw_bytes_and_hashes_exact: true,
    duplicate_files_retained: true,
    html_only_inert_text: true,
    actual_untrusted_certificate_rejected: true,
    actual_wrong_name_rejected: true,
    before_connect_hooks: before,
    after_fetch_hooks: after,
    fixture_config_unchanged: true,
    source_sha256,
    business_api_verified: false,
    smtp_verified: false,
    chrome_verified: false,
    full_goal_complete: false,
  };
  const f = await open(output, 'wx', 0o644);
  try {
    await f.writeFile(JSON.stringify(report, null, 2) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      messages: 3,
      certificate_negative_checks: 2,
      provider_proof: false,
    }) + '\n',
  );
}
main().catch(() => {
  process.stderr.write('QA156_IMAP_NATIVE_FAILED_STEP_' + step + '_NO_PRIVATE_OUTPUT\n');
  process.exitCode = 1;
});
