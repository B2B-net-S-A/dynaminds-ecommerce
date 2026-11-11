import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = resolve(homedir(), '.local/share/dynaminds/pg-tools/18');
const version = '18.6';
const sha = '555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f';
await mkdir(root, { recursive: true, mode: 0o700 });
const log = resolve(root, 'build.log');
async function run(executable: string, args: string[], cwd = root) {
  const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (b) => (output += b.toString()));
  child.stderr.on('data', (b) => (output += b.toString()));
  const status = await new Promise<number>((done, reject) => {
    child.on('error', reject);
    child.on('exit', (n) => done(n ?? 1));
  });
  await writeFile(log, output, { mode: 0o600 });
  if (status !== 0) throw new Error(`Budowa narzędzi przerwana. Diagnostyka: ${log}`);
  return output;
}
try {
  await access(resolve(root, 'bin/pg_dump'));
  await access(resolve(root, 'bin/pg_restore'));
  if (!(await run(resolve(root, 'bin/pg_dump'), ['--version'])).includes(' ' + version))
    throw new Error('Wymagana aktualizacja narzędzi');
} catch {
  const archive = resolve(root, `postgresql-${version}.tar.bz2`);
  let bytes: Buffer;
  try {
    bytes = await readFile(archive);
  } catch {
    const r = await fetch(
      `https://ftp.postgresql.org/pub/source/v${version}/postgresql-${version}.tar.bz2`,
    );
    if (!r.ok) throw new Error('Nie można pobrać oficjalnych źródeł PostgreSQL');
    bytes = Buffer.from(await r.arrayBuffer());
    await writeFile(archive, bytes, { mode: 0o600 });
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha)
    throw new Error('Nieprawidłowa suma SHA-256 źródeł PostgreSQL');
  await run('tar', ['-xjf', archive, '-C', root]);
  const source = resolve(root, `postgresql-${version}`);
  console.log('Konfiguracja i budowa wyłącznie narzędzi klienckich PostgreSQL 18…');
  await run(
    './configure',
    [
      `--prefix=${root}`,
      '--without-readline',
      '--without-icu',
      '--without-gssapi',
      '--without-ldap',
      '--without-lz4',
      '--without-zstd',
    ],
    source,
  );
  await run('make', ['-j2', '-C', 'src/backend', 'generated-headers'], source);
  await run('make', ['-j2', '-C', 'src/bin/pg_dump'], source);
  await run('make', ['-C', 'src/interfaces/libpq', 'install'], source);
  await run('make', ['-C', 'src/bin/pg_dump', 'install'], source);
}
await run(resolve(root, 'bin/pg_dump'), ['--version']);
console.log(`pg_dump / pg_restore gotowe: ${resolve(root, 'bin')}`);
