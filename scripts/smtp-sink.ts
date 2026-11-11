// Local protocol receiver only: no forwarding, no external network, no HTTP mailbox.
import { SMTPServer } from 'smtp-server';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { encrypt } from '../server/security';
import { localSmtpPassword } from '../server/smtp';
import { pool } from '../server/db';
const server = new SMTPServer({
  name: 'dynaminds.local',
  secure: false,
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  authMethods: ['PLAIN', 'LOGIN'],
  size: 4 * 1024 * 1024,
  logger: false,
  hidePIPELINING: true,
  onAuth(auth, _session, callback) {
    const a = Buffer.from(auth.password ?? ''),
      b = Buffer.from(localSmtpPassword());
    callback(
      auth.username === 'dyna-local' && a.length === b.length && timingSafeEqual(a, b)
        ? null
        : new Error('Authentication refused'),
      { user: 'local-operator' },
    );
  },
  onMailFrom(address, _session, callback) {
    callback(
      address.address.toLowerCase().endsWith('.test') ? undefined : new Error('Only .test senders'),
    );
  },
  onRcptTo(address, _session, callback) {
    callback(
      address.address.toLowerCase().endsWith('.test')
        ? undefined
        : new Error('Only .test recipients'),
    );
  },
  onData(stream, session, callback) {
    const parts: Buffer[] = [];
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) parts.push(chunk);
    });
    stream.on('error', callback);
    stream.on('end', async () => {
      try {
        if (bytes > 4 * 1024 * 1024 || stream.sizeExceeded) throw new Error('Message too large');
        await mkdir('data/smtp-mailbox', { recursive: true, mode: 0o700 });
        const id = randomUUID();
        await writeFile(
          'data/smtp-mailbox/' + id + '.json',
          encrypt({
            raw_base64: Buffer.concat(parts).toString('base64'),
            recipient: session.envelope.rcptTo.map((v) => v.address).join(','),
            accepted_at: new Date().toISOString(),
          }),
          { flag: 'wx', mode: 0o600 },
        );
        callback(undefined, 'DYNAMINDS local stored ' + id);
      } catch {
        callback(new Error('Local storage failed'));
      }
    });
  },
});
server.on('error', () => {
  console.error('Local SMTP unavailable');
  process.exitCode = 1;
});
server.listen(1025, '127.0.0.1', () =>
  console.log('DYNAMINDS local SMTP receiver: 127.0.0.1:1025; no forwarding'),
);
async function stop() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
