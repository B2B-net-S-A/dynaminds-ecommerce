// Migration 262 and the start check on the RELEASE start path (ordinary-local-cli → createOrdinaryLocalApplication), which
// runs its own migrate() and never went through server/index.ts: a release built from a70e164 started on a plain
// pg_restore copy where dyna_app still had TEMPORARY (docs/parity/CRM-N25B-LOCAL-20261023.md, "Odtworzenie z dumpa").
// Runs on a fresh PG04 clone dynaminds_rel262_YYYYMMDD_NN of the restored template; the real migrate() applies 262 first,
// then TEMPORARY is re-granted to PUBLIC the way a clone or a logical restore leaves it. Rerun = NEW clone.
//
//   REL262_RELEASE_BUILD=<dir with release-build.json and release-canonical/>  (node tools/scale/release-build.mjs)
//   DATABASE_URL=postgres://postgres:…@127.0.0.1:57084/dynaminds_rel262_YYYYMMDD_NN  DYNA_LOCAL_CONFIG_PATH=<pg04 test config>
//   DYNA_TEST=true node node_modules/tsx/dist/cli.mjs --test tests/revoke-public-temporary262-release.database.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const build = process.env.REL262_RELEASE_BUILD, url = process.env.DATABASE_URL, config = process.env.DYNA_LOCAL_CONFIG_PATH;
const skip = !build || !url || !config ? 'needs REL262_RELEASE_BUILD, DATABASE_URL, DYNA_LOCAL_CONFIG_PATH' : false;
const name = url ? new URL(url).pathname.slice(1) : '';
if (!skip) {
  assert.equal(process.env.DYNA_TEST, 'true');
  const u = new URL(url!);
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.port, '57084');
  assert.match(name, /^dynaminds_rel262_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_rel262_YYYYMMDD_NN of the restored template required');
}
let db: typeof import('../server/db') | undefined;
let root = '';

/** Starts the release CLI from the release directory; resolves on LISTENING (then stops it) or on exit. */
function start(release: string, selection: string, sha: string, imageDirectory: string) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'pl_PL.UTF-8',
    DYNA_KSEF_FAKE: 'local', DYNA_PAYU_FAKE: 'local', DYNA_IMAGE_DIR: imageDirectory };
  const c = spawn(process.execPath, [join(release, 'runtime/server/ordinary-local-cli.mjs'), selection, sha, '18762'],
    { cwd: release, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stderr.on('data', (b) => { err += b; });
  const timer = setTimeout(() => c.kill('SIGTERM'), 600_000);
  return new Promise<{ listening: boolean; code: number | null; stderr: string }>((ok) => {
    let listening = false;
    c.stdout.on('data', (b) => { out += b; if (!listening && out.includes('ORDINARY_LOCAL_APP_LISTENING')) { listening = true; c.kill('SIGTERM'); } });
    c.on('exit', (code) => { clearTimeout(timer); ok({ listening, code, stderr: err }); });
  });
}
const temp = async () => (await db!.pool.query(`SELECT has_database_privilege('dyna_app',current_database(),'TEMPORARY') app,
  EXISTS(SELECT FROM migrations WHERE name='262_revoke_public_temporary') ledger, (SELECT count(*)::int FROM migrations) rows`)).rows[0];

before(async () => {
  if (skip) return;
  db = await import('../server/db');
  await db.migrate();
});
after(async () => { await db?.pool.end(); if (root) rmSync(root, { recursive: true, force: true }); });

test('release start: refuses with TEMPORARY re-granted to PUBLIC under a ledger with 262, starts after 262 is re-applied', { skip, timeout: 1_500_000 }, async () => {
  const { reapplyRevokePublicTemporary } = await import('../server/database-temp-privilege');
  const release = realpathSync(join(build!, 'release-canonical'));
  const manifest = JSON.parse(readFileSync(join(build!, 'release-build.json'), 'utf8')).release_manifest_sha256 as string;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'rel262-')));
  chmodSync(root, 0o700);
  const data = join(root, 'installation'), images = join(root, 'images');
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(images, { mode: 0o700 });
  const localConfig = join(data, 'local-config.json');
  copyFileSync(config!, localConfig);
  chmodSync(localConfig, 0o600);
  const selection = join(root, 'selection.json'), bytes = Buffer.from(JSON.stringify({ releaseDirectory: release, manifestSha: manifest,
    expectedOwner: 'postgres', databaseUrl: url!.replace(/^postgresql:/, 'postgres:'), localConfigurationPath: localConfig, revision: manifest }));
  writeFileSync(selection, bytes, { mode: 0o600 });
  const sha = createHash('sha256').update(bytes).digest('hex');

  const migrated = await temp();
  assert.equal(migrated.ledger, true, 'the real migrate() applied 262');
  assert.equal(migrated.app, false);

  // 1. TEMPORARY back for PUBLIC (what CREATE DATABASE … TEMPLATE and pg_restore leave): the release must not start.
  await db!.pool.query(`GRANT TEMPORARY ON DATABASE "${name}" TO PUBLIC`);
  assert.equal((await temp()).app, true);
  const refused = await start(release, selection, sha, images);
  assert.equal(refused.listening, false, 'the release must not start');
  assert.equal(refused.code, 1);
  const line = JSON.parse(refused.stderr.trim().split('\n').at(-1)!);
  assert.equal(line.status, 'ORDINARY_LOCAL_START_FAILED');
  assert.equal(line.name, 'DatabaseTempPrivilegeError');
  assert.equal(line.code, 'DATABASE_TEMP_PRIVILEGE');
  assert.match(line.message, new RegExp(`^Baza ${name} pozwala roli aplikacji tworzyć tabele tymczasowe \\(TEMPORARY\\).*Aplikacja się nie uruchomi`));
  assert(!refused.stderr.includes(JSON.parse(readFileSync(config!, 'utf8')).dbPassword), 'no database password in the output');
  assert.equal((await temp()).rows, migrated.rows, 'ledger unchanged');

  // 2. The restore path re-applies the exact 262 statement: the same release starts.
  assert.deepEqual(await reapplyRevokePublicTemporary(db!.pool), { database: name, applied: true, appTemp: false, reapplied: true });
  const started = await start(release, selection, sha, images);
  assert.equal(started.listening, true, started.stderr.slice(-2000));
  assert.equal((await temp()).app, false);
});
