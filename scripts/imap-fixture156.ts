// Root-run synthetic mailbox. This is a narrow real TLS protocol fixture, not an
// IMAP implementation used by the application or evidence of a public provider.
import { createServer, type TLSSocket } from 'node:tls';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { EMAIL_INBOUND_LIMITS as L, inboundSha256 } from '../server/email-inbound-mime';

const PRIMARY = '<workspace>/app';
const DIRECTORY = join(PRIMARY, 'data/imap-fixture156');
type FixtureConfig = {
  stage: 156;
  synthetic: true;
  host: '127.0.0.1';
  port: 4112;
  folder: 'INBOX';
  uidvalidity: '156';
  username: string;
  password: string;
  messages: { uid: number; file: string; byte_count: number; sha256: string }[];
};
function guard(value: unknown): asserts value {
  if (!value) throw new Error('IMAP fixture precondition failed');
}
async function primary() {
  guard(resolve(process.cwd()) === PRIMARY);
  const s = await lstat(join(PRIMARY, 'data'));
  guard(s.isDirectory() && !s.isSymbolicLink());
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw new Error('IMAP fixture output already exists');
}
async function privateRead(name: string, max = L.message_bytes) {
  guard(/^[a-z0-9.-]+$/.test(name));
  const s = await lstat(join(DIRECTORY, name));
  guard(
    s.isFile() && !s.isSymbolicLink() && (s.mode & 0o777) === 0o600 && s.size > 0 && s.size <= max,
  );
  return readFile(join(DIRECTORY, name));
}
async function openssl(args: string[]) {
  // Arguments and paths are fixed; neither shell nor arbitrary user command is accepted.
  await new Promise<void>((done, reject) => {
    const p = spawn('openssl', args, { cwd: DIRECTORY, stdio: 'ignore', shell: false });
    p.once('error', () => reject(new Error('IMAP fixture certificate generation failed')));
    p.once('exit', (code) =>
      code === 0 ? done() : reject(new Error('IMAP fixture certificate generation failed')),
    );
  });
}
function message(id: number, body: string) {
  return Buffer.from(
    `From: =?UTF-8?Q?Klient_=C5=BC=C3=B3=C5=82ty?= <customer-${id}@example.test>\r\nTo: inbound156@example.test\r\nMessage-ID: <fixture-${id}@example.test>\r\nSubject: =?UTF-8?Q?Zwrot_${id}_=C5=82=C4=85czony?=\r\nDate: Tue, 06 Oct 2026 12:00:00 +0200\r\nMIME-Version: 1.0\r\n${body}`,
  );
}
export async function prepareImapFixture156() {
  await primary();
  await absent(DIRECTORY);
  await mkdir(DIRECTORY, { mode: 0o700 });
  const oldMask = process.umask(0o077);
  try {
    await writeFile(
      join(DIRECTORY, 'server-ext.cnf'),
      'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n',
      { flag: 'wx', mode: 0o600 },
    );
    await openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '30',
      '-subj',
      '/CN=DYNA IMAP QA156 CA',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
    ]);
    await openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      '/CN=127.0.0.1',
      '-keyout',
      'server.key',
      '-out',
      'server.csr',
    ]);
    await openssl([
      'x509',
      '-req',
      '-in',
      'server.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-set_serial',
      '156',
      '-days',
      '30',
      '-sha256',
      '-extfile',
      'server-ext.cnf',
      '-out',
      'server.pem',
    ]);
    for (const name of ['ca.key', 'ca.pem', 'server.key', 'server.csr', 'server.pem'])
      await chmod(join(DIRECTORY, name), 0o600);
    const attachment = Buffer.from('Synthetic attachment QA156 — żółty\n');
    const messages = [
      {
        uid: 1,
        bytes: message(
          1,
          'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nProsz=C4=99 o przyj=C4=99cie zwrotu.\r\n',
        ),
      },
      {
        uid: 2,
        bytes: message(
          2,
          `Content-Type: multipart/mixed; boundary="qa156-mixed"\r\n\r\n--qa156-mixed\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nDwa załączniki o tej samej nazwie.\r\n${[attachment, Buffer.from('Second distinct QA156 attachment\n')].map((bytes) => `--qa156-mixed\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="proof.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n${bytes.toString('base64')}\r\n`).join('')}--qa156-mixed--\r\n`,
        ),
      },
      {
        uid: 4,
        bytes: message(
          4,
          'Content-Type: text/html; charset=utf-8\r\n\r\n<p>Zwrot HTML żółty — tylko tekst.</p><img src="https://invalid.example/not-loaded">\r\n',
        ),
      },
    ];
    const config: FixtureConfig = {
      stage: 156,
      synthetic: true,
      host: '127.0.0.1',
      port: 4112,
      folder: 'INBOX',
      uidvalidity: '156',
      username: 'inbound156@example.test',
      password: randomBytes(24).toString('hex'),
      messages: [],
    };
    for (const m of messages) {
      const file = `message-${m.uid}.eml`;
      await writeFile(join(DIRECTORY, file), m.bytes, { flag: 'wx', mode: 0o600 });
      config.messages.push({
        uid: m.uid,
        file,
        byte_count: m.bytes.length,
        sha256: inboundSha256(m.bytes),
      });
    }
    await writeFile(join(DIRECTORY, 'config.json'), JSON.stringify(config, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    // Safe summary only; credentials stay exclusively in the private config.
    console.log(
      JSON.stringify({
        status: 'SYNTHETIC_IMAP_TLS_FIXTURE_PREPARED',
        stage: 156,
        host: config.host,
        port: config.port,
        message_count: messages.length,
        provider_proof: false,
      }),
    );
  } finally {
    process.umask(oldMask);
  }
}
function equalSecret(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function stringArgs(source: string): string[] | null {
  // Narrow quoted/atom grammar for this fixture's fixed ASCII login and INBOX.
  // Client literals, command continuation and arbitrary mailboxes are refused.
  const values: string[] = [];
  let rest = source.trim();
  while (rest.length) {
    const quoted = /^"((?:[^"\\\r\n]|\\["\\])*)"(?:\s+|$)/.exec(rest);
    const atom = /^([^\s"{}()\r\n]+)(?:\s+|$)/.exec(rest);
    const match = quoted ?? atom;
    if (!match) return null;
    values.push(quoted ? match[1].replace(/\\(["\\])/g, '$1') : match[1]);
    rest = rest.slice(match[0].length);
  }
  return values;
}
export async function serveImapFixture156() {
  await primary();
  const directory = await lstat(DIRECTORY);
  guard(
    directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o777) === 0o700,
  );
  const config = JSON.parse((await privateRead('config.json', 32768)).toString()) as FixtureConfig;
  guard(
    config.stage === 156 &&
      config.synthetic === true &&
      config.host === '127.0.0.1' &&
      config.port === 4112 &&
      config.folder === 'INBOX' &&
      config.uidvalidity === '156' &&
      config.username === 'inbound156@example.test' &&
      /^[a-f0-9]{48}$/.test(config.password),
  );
  guard(config.messages.length === 3 && config.messages.map((m) => m.uid).join(',') === '1,2,4');
  const messages: { uid: number; bytes: Buffer }[] = [];
  for (const m of config.messages) {
    guard(m.file === `message-${m.uid}.eml`);
    const bytes = await privateRead(m.file);
    guard(bytes.length === m.byte_count && inboundSha256(bytes) === m.sha256);
    messages.push({ uid: m.uid, bytes });
  }
  const cert = await privateRead('server.pem', 32768),
    key = await privateRead('server.key', 32768);
  const sockets = new Set<TLSSocket>();
  const counts: Record<string, number> = {};
  let connections = 0,
    authenticated = 0,
    rejected_mutations = 0,
    fetched_bytes = 0;
  const server = createServer({ key, cert, minVersion: 'TLSv1.2' }, (socket) => {
    connections++;
    sockets.add(socket);
    let loggedIn = false,
      selected = false,
      pending = Buffer.alloc(0),
      sequence = Promise.resolve();
    socket.setTimeout(60000, () => socket.destroy());
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    const send = async (bytes: string | Buffer) => {
      if (socket.destroyed) return;
      if (!socket.write(bytes)) await once(socket, 'drain');
    };
    const reply = (tag: string, status: 'OK' | 'NO' | 'BAD', text: string) =>
      send(`${tag} ${status} ${text}\r\n`);
    const handle = async (line: string) => {
      const parsed = /^([A-Za-z0-9]{1,32}) ([A-Za-z]+)(?: (.*))?$/.exec(line);
      if (!parsed) {
        await send('* BAD Unsupported command\r\n');
        return;
      }
      const [, tag, word, args = ''] = parsed,
        command = word.toUpperCase();
      counts[command] = (counts[command] ?? 0) + 1;
      if (command === 'CAPABILITY') {
        await send('* CAPABILITY IMAP4rev1\r\n');
        await reply(tag, 'OK', 'CAPABILITY completed');
        return;
      }
      if (command === 'LOGIN' && !loggedIn) {
        const values = stringArgs(args);
        if (
          values?.length === 2 &&
          equalSecret(values[0], config.username) &&
          equalSecret(values[1], config.password)
        ) {
          loggedIn = true;
          authenticated++;
          await reply(tag, 'OK', 'Authenticated');
        } else await reply(tag, 'NO', 'Authentication failed');
        return;
      }
      if (command === 'LOGOUT') {
        await send('* BYE Closing\r\n');
        await reply(tag, 'OK', 'LOGOUT completed');
        socket.end();
        return;
      }
      if (!loggedIn) {
        await reply(tag, 'NO', 'Authenticate first');
        return;
      }
      if (command === 'LIST') {
        const values = stringArgs(args);
        if (values?.length !== 2 || values[0] !== '' || !['', 'INBOX'].includes(values[1])) {
          await reply(tag, 'BAD', 'Unsupported mailbox');
          return;
        }
        await send(
          `* LIST (${values[1] ? '\\HasNoChildren' : '\\Noselect'}) "/" "${values[1]}"\r\n`,
        );
        await reply(tag, 'OK', 'LIST completed');
        return;
      }
      if (command === 'EXAMINE') {
        const values = stringArgs(args);
        if (values?.length !== 1 || values[0] !== 'INBOX') {
          await reply(tag, 'NO', 'Unknown mailbox');
          return;
        }
        selected = true;
        await send(
          `* FLAGS ()\r\n* ${messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 156] Namespace\r\n* OK [UIDNEXT 5] Next UID\r\n* OK [PERMANENTFLAGS ()] Read only\r\n`,
        );
        await reply(tag, 'OK', '[READ-ONLY] EXAMINE completed');
        return;
      }
      if (command === 'NOOP') {
        await reply(tag, 'OK', 'NOOP completed');
        return;
      }
      if (command === 'UID' && selected) {
        const fetch = /^FETCH ([0-9]+(?::[0-9]+)?) \(([^\r\n]+)\)$/i.exec(args);
        if (!fetch) {
          rejected_mutations++;
          await reply(tag, 'BAD', 'Only bounded UID FETCH is supported');
          return;
        }
        const [start, finish = start] = fetch[1].split(':').map(Number);
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(finish) ||
          start < 1 ||
          finish < start ||
          finish - start >= 50
        ) {
          await reply(tag, 'BAD', 'UID window limit');
          return;
        }
        const fields = fetch[2].toUpperCase();
        const body = /BODY\.PEEK\[\]<([0-9]+)\.([0-9]+)>/.exec(fields);
        const remaining = fields
          .replace(/BODY\.PEEK\[\]<[0-9]+\.[0-9]+>/, '')
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (
          !remaining.length ||
          remaining.some((f) => !['UID', 'RFC822.SIZE'].includes(f)) ||
          (body &&
            (start !== finish ||
              Number(body[2]) < 1 ||
              Number(body[2]) > 65536 ||
              Number(body[1]) > L.message_bytes))
        ) {
          await reply(tag, 'BAD', 'Only PEEK source and metadata are supported');
          return;
        }
        counts[body ? 'BODY_PEEK' : 'UID_METADATA'] =
          (counts[body ? 'BODY_PEEK' : 'UID_METADATA'] ?? 0) + 1;
        for (const [index, m] of messages.entries())
          if (m.uid >= start && m.uid <= finish) {
            if (!body)
              await send(`* ${index + 1} FETCH (UID ${m.uid} RFC822.SIZE ${m.bytes.length})\r\n`);
            else {
              const offset = Number(body[1]),
                chunk = m.bytes.subarray(offset, offset + Number(body[2]));
              fetched_bytes += chunk.length;
              await send(
                `* ${index + 1} FETCH (UID ${m.uid} RFC822.SIZE ${m.bytes.length} BODY[]<${offset}> {${chunk.length}}\r\n`,
              );
              await send(chunk);
              await send(')\r\n');
            }
          }
        await reply(tag, 'OK', 'FETCH completed');
        return;
      }
      rejected_mutations++;
      await reply(tag, 'BAD', 'Fixture is read only');
    };
    socket.on('data', (bytes) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
      if (pending.length > 32768) {
        socket.destroy();
        return;
      }
      let at: number;
      while ((at = pending.indexOf('\r\n')) >= 0) {
        const line = pending.subarray(0, at).toString('utf8');
        pending = pending.subarray(at + 2);
        sequence = sequence
          .then(() => handle(line))
          .catch(() => {
            socket.destroy();
          });
      }
    });
    void send('* OK Synthetic QA156 TLS IMAP fixture\r\n').catch(() => socket.destroy());
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((done, reject) => {
    server.once('error', () => reject(new Error('IMAP fixture listen failed')));
    server.listen(4112, '127.0.0.1', done);
  });
  console.log(
    JSON.stringify({
      status: 'SYNTHETIC_IMAP_TLS_FIXTURE_LISTENING',
      stage: 156,
      host: '127.0.0.1',
      port: 4112,
      provider_proof: false,
    }),
  );
  await new Promise<void>((done) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  const report = join(PRIMARY, 'docs', `email-inbound-imap-fixture156-${randomUUID()}.json`);
  await writeFile(
    report,
    JSON.stringify(
      {
        stage: 156,
        status: 'SYNTHETIC_IMAP_TLS_FIXTURE_STOPPED',
        provider_proof: false,
        host: '127.0.0.1',
        port: 4112,
        connections,
        authenticated,
        command_counts: counts,
        rejected_mutations,
        fetched_bytes,
        message_flags_unchanged: true,
        messages: config.messages.map(({ uid, byte_count, sha256 }) => ({
          uid: String(uid),
          byte_count,
          sha256,
        })),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: 'SYNTHETIC_IMAP_TLS_FIXTURE_STOPPED',
      report: basename(report),
      provider_proof: false,
    }),
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const mode = process.argv.slice(2);
  void (async () => {
    guard(mode.length === 1);
    if (mode[0] === '--prepare') await prepareImapFixture156();
    else if (mode[0] === '--serve') await serveImapFixture156();
    else guard(false);
  })().catch(() => {
    console.error('IMAP fixture failed; no credentials or message bytes printed.');
    process.exitCode = 1;
  });
}
