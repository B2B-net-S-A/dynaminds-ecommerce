/** Migration 262_revoke_public_temporary and its start check on a real clone (docs/parity/SECDEF-PGTEMP-P278-20261029.md
 * "Integracja jako 262"). Runs on a fresh PG04 clone dynaminds_m262_YYYYMMDD_NN of the restored template that has not been
 * migrated yet: CREATE DATABASE … TEMPLATE gives it the default database ACL, in which PUBLIC (so dyna_app) has
 * TEMPORARY. The real migrate() applies 262; then the test re-grants TEMPORARY the way a clone or a logical restore
 * does, and the start must refuse until the restore path re-applies 262. Rerun = NEW clone. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { migrate, pool } from '../server/db';
import { assertDatabaseTempPrivilege, DatabaseTempPrivilegeError, reapplyRevokePublicTemporary } from '../server/database-temp-privilege';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_m262_2026[0-9]{4}_[0-9]{2}$/, 'fresh clone dynaminds_m262_YYYYMMDD_NN of the restored template required');
const name = database.pathname.slice(1);
const acl = async () => (await pool.query(`SELECT datacl::text acl,has_database_privilege('dyna_app',current_database(),'TEMPORARY') app,
  has_database_privilege('public',current_database(),'TEMPORARY') pub,EXISTS(SELECT FROM migrations WHERE name='262_revoke_public_temporary') ledger
  FROM pg_database WHERE datname=current_database()`)).rows[0];
/** CREATE TEMP TABLE as dyna_app (role-confined like a tenant transaction), rolled back; the SQLSTATE or 'created'. */
const appTemp = async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app');
    try { await c.query('CREATE TEMP TABLE p262_probe(x int) ON COMMIT DROP'); return 'created'; } catch (e: any) { return e.code; }
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
};
/** server/index.ts against this database: exit code and stderr (it must stop right after migrate()). */
const start = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
  const env = { ...process.env, PORT: '47262', DYNA_WORKER_DISABLED: 'true', DYNA_TEST_ALLOWED_PORTS: '57084' } as NodeJS.ProcessEnv;
  const child = spawn(process.execPath, ['--import', './tests/loopback-only-network.mjs', 'node_modules/tsx/dist/cli.mjs', 'server/index.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += String(d)));
  const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
});

before(async () => {
  const fresh = await acl();
  assert.deepEqual(fresh, { acl: null, app: true, pub: true, ledger: false }, 'fresh clone: default database ACL (TEMPORARY for PUBLIC), 262 not applied');
  assert.equal(await appTemp(), 'created', 'before 262 dyna_app can create a temporary table');
  assert.equal((await assertDatabaseTempPrivilege(pool)).applied, false, 'the start check is silent while the ledger lacks 262');
  await migrate();
});
after(async () => { await pool.end(); });

test('migrate() applies 262: PUBLIC loses TEMPORARY, the owner keeps it, dyna_app CREATE TEMP TABLE is 42501', async () => {
  assert.deepEqual(await acl(), { acl: '{=c/postgres,postgres=CTc/postgres}', app: false, pub: false, ledger: true });
  assert.equal(await appTemp(), '42501');
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('CREATE TEMP TABLE p262_owner(x int) ON COMMIT DROP'); } finally { await c.query('ROLLBACK'); c.release(); }
  assert.deepEqual(await assertDatabaseTempPrivilege(pool), { database: name, applied: true, appTemp: false });
});

test('a clone or restore brings TEMPORARY back for PUBLIC: the start refuses (red), the restore path re-applies 262 (green)', async () => {
  await pool.query(`GRANT TEMPORARY ON DATABASE "${name}" TO PUBLIC`);
  assert.equal((await acl()).app, true);
  await assert.rejects(assertDatabaseTempPrivilege(pool), (e: any) => e instanceof DatabaseTempPrivilegeError && e.message.startsWith(`Baza ${name} pozwala roli aplikacji tworzyć tabele tymczasowe`));
  const refused = await start();
  assert.notEqual(refused.code, 0, 'server/index.ts must not start');
  assert.match(refused.stderr, /pozwala roli aplikacji tworzyć tabele tymczasowe \(TEMPORARY\)/, refused.stderr.slice(-2000));
  assert.deepEqual(await reapplyRevokePublicTemporary(pool), { database: name, applied: true, appTemp: false, reapplied: true });
  assert.equal(await appTemp(), '42501');
});

test('an explicit GRANT TEMPORARY TO dyna_app survives the re-applied 262 and keeps the start refused', async () => {
  await pool.query(`GRANT TEMPORARY ON DATABASE "${name}" TO dyna_app`);
  try {
    await assert.rejects(reapplyRevokePublicTemporary(pool), DatabaseTempPrivilegeError);
    await assert.rejects(assertDatabaseTempPrivilege(pool), DatabaseTempPrivilegeError);
  } finally { await pool.query(`REVOKE TEMPORARY ON DATABASE "${name}" FROM dyna_app`); }
  assert.deepEqual(await assertDatabaseTempPrivilege(pool), { database: name, applied: true, appTemp: false });
});
