// MIG-3 on a packaged release (Stage 3 rehearsal 27.10 finding): the start runs from the release directory,
// takes the pre-migration backup into the installation's data directory (next to the selected local
// configuration), never into the package, and a failed start leaves no partial files.
//
//   MIG3_RELEASE_BUILD=<dir with release-build.json and release-canonical/>  (node tools/scale/release-build.mjs)
//   DATABASE_URL=postgres://postgres:…@127.0.0.1:<port>/<disposable clone with pending migrations>
//   DYNA_LOCAL_CONFIG_PATH=<test config whose dbPassword matches>  MIG3_IMAGES=<image directory of that clone>
//   node node_modules/tsx/dist/cli.mjs --test tests/migration-backup-release.database.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import pg from 'pg';

const build = process.env.MIG3_RELEASE_BUILD, url = process.env.DATABASE_URL, config = process.env.DYNA_LOCAL_CONFIG_PATH, images = process.env.MIG3_IMAGES;
const skip = !build || !url || !config || !images ? 'needs MIG3_RELEASE_BUILD, DATABASE_URL, DYNA_LOCAL_CONFIG_PATH, MIG3_IMAGES' : false;

const files = (root: string, dir = root): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(root, join(dir, e.name)) : [relative(root, join(dir, e.name))]).sort();
async function ledger() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return Number((await c.query('SELECT count(*) FROM migrations')).rows[0].count); } finally { await c.end(); }
}
/** Starts the release CLI from the release directory; resolves on LISTENING (then stops it) or on exit. */
function start(release: string, selection: string, sha: string, imageDirectory: string) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'pl_PL.UTF-8',
    DYNA_KSEF_FAKE: 'local', DYNA_PAYU_FAKE: 'local', DYNA_IMAGE_DIR: imageDirectory };
  const c = spawn(process.execPath, [join(release, 'runtime/server/ordinary-local-cli.mjs'), selection, sha, '18744', '--verified-stock-writers'],
    { cwd: release, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stderr.on('data', (b) => { err += b; });
  return new Promise<{ listening: boolean; code: number | null; stderr: string }>((ok) => {
    let listening = false;
    c.stdout.on('data', (b) => { out += b; if (!listening && out.includes('ORDINARY_LOCAL_APP_LISTENING')) { listening = true; c.kill('SIGTERM'); } });
    c.on('exit', (code) => ok({ listening, code, stderr: err }));
  });
}

test('release start: backup into the data directory, migrate, restart passes the inventory check; a failed start leaves nothing', { skip, timeout: 900000 }, async (t) => {
  const release = realpathSync(join(build!, 'release-canonical'));
  const manifest = JSON.parse(readFileSync(join(build!, 'release-build.json'), 'utf8')).release_manifest_sha256 as string;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mig3-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const data = join(root, 'installation');
  mkdirSync(data, { mode: 0o700 });
  const localConfig = join(data, 'local-config.json');
  copyFileSync(config!, localConfig);
  chmodSync(localConfig, 0o600);
  const selection = join(root, 'selection.json'), bytes = Buffer.from(JSON.stringify({ releaseDirectory: release, manifestSha: manifest,
    expectedOwner: 'postgres', databaseUrl: url!.replace(/^postgresql:/, 'postgres:'), localConfigurationPath: localConfig, revision: manifest }));
  writeFileSync(selection, bytes, { mode: 0o600 });
  const sha = createHash('sha256').update(bytes).digest('hex');
  const inventory = files(release), before = await ledger();
  const noImages = join(root, 'no-images');
  mkdirSync(noImages, { mode: 0o700 });

  // 1. The clone has a product image the image directory lacks: refused with the cause printed, nothing written.
  const failed = await start(release, selection, sha, noImages);
  assert.equal(failed.listening, false);
  assert.equal(failed.code, 1);
  const line = JSON.parse(failed.stderr.trim().split('\n').at(-1)!);
  assert.equal(line.status, 'ORDINARY_LOCAL_START_FAILED');
  assert.equal(line.code, 'MIGRATION_BACKUP_FAILED');
  assert.match(line.message, /Przyczyna: Brak lub nieprawidłowe zdjęcie w kopii: brak pliku zdjęcia [0-9a-f-]{36} w katalogu .*DYNA_IMAGE_DIR/);
  assert(!failed.stderr.includes(JSON.parse(readFileSync(config!, 'utf8')).dbPassword), 'no database password in the output');
  assert.deepEqual(readdirSync(data), ['local-config.json'], 'no key, no backup directory after a failed start');
  assert.deepEqual(files(release), inventory, 'release package untouched');
  assert.equal(await ledger(), before, 'no migration applied');

  // 2. With the images: one backup in <data>/backups/pre-migration, key in <data>, migrations applied.
  const first = await start(release, selection, sha, images!);
  assert.equal(first.listening, true, first.stderr.slice(-2000));
  assert.deepEqual(readdirSync(data).sort(), ['.recovery-key', 'backups', 'local-config.json']);
  assert.equal(statSync(join(data, '.recovery-key')).mode & 0o777, 0o600);
  const backups = readdirSync(join(data, 'backups/pre-migration'));
  assert.equal(backups.filter((f) => f.endsWith('.dyna')).length, 1);
  assert.equal(backups.length, 2, 'the .dyna archive and its report, no partial or snapshot left');
  const report = JSON.parse(readFileSync(join(data, 'backups/pre-migration', backups.find((f) => f.endsWith('.dyna.json'))!), 'utf8'));
  assert.equal(report.status, 'created');
  assert.equal(report.images, 1);
  const after = await ledger();
  assert(after > before, `ledger ${before} -> ${after}`);
  assert.deepEqual(files(release), inventory, 'release package untouched');

  // 3. Restart: no pending migration, no new backup, and the release inventory check passes.
  const second = await start(release, selection, sha, images!);
  assert.equal(second.listening, true, second.stderr.slice(-2000));
  assert.deepEqual(readdirSync(join(data, 'backups/pre-migration')).sort(), backups.sort());
  assert.equal(await ledger(), after);
  assert.deepEqual(files(release), inventory);
});
