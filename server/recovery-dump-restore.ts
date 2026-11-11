/** Plain logical restore: a `pg_dump --format=custom` file (no encrypted bundle, manifest or ACL snapshot of `npm run
 * backup`) into a NEW empty database of the local cluster of DATABASE_URL. pg_restore runs with the same flags as
 * restoreBackup (server/recovery.ts). A logical dump loses two catalog states the start checks require, and both are
 * re-established here before the database is reported restored:
 * - the database ACL of 262 (pg_dump never carries datacl): reapplyRevokePublicTemporary runs the exact 262 statement;
 * - explicit owner-only relation/schema ACLs equal to the default (pg_dump omits them, the restore leaves NULL): the
 *   startup normalizer (server/ordinary-legacy-schema.mjs) materializes them only after the complete proposed catalogue
 *   passes the source comparison; the release start runs the same normalizer again (then 0 changes).
 * Any failure drops the database this call created. docs: tools/recovery/README.md "Logical dump restore". */
import pg from 'pg';
import { watchDbClient } from './db-connection-errors';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { recoveryPostgresPort } from './test-postgres-port';
import { reapplyRevokePublicTemporary } from './database-temp-privilege';
import { normalizeOrdinaryLegacyOwnerAcls } from './ordinary-legacy-schema.mjs';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function cluster() {
  const port = recoveryPostgresPort();
  const url = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
  check(url.username === 'postgres', 'Odtworzenie dumpa wymaga lokalnego operatora postgres');
  return { host: '127.0.0.1', port, user: 'postgres', password: decodeURIComponent(url.password) };
}

function pgRestore(args: string[], password: string) {
  const tool = resolve(process.env.DYNA_PG_TOOLS ?? resolve(homedir(), '.local/share/dynaminds/pg-tools/18/bin'), 'pg_restore');
  return access(tool).then(() => new Promise<void>((ok, bad) => {
    const c = spawn(tool, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, PGPASSWORD: password, PGCONNECT_TIMEOUT: '5', LC_ALL: 'C' } });
    let stderr = '';
    c.stderr.on('data', (b) => { if (stderr.length < 4096) stderr += String(b); });
    c.on('error', () => bad(new Error('Nie można uruchomić pg_restore')));
    // The first error line names the failing TOC entry; it carries no row data (--exit-on-error, one transaction).
    c.on('exit', (code) => code === 0 ? ok() : bad(new Error(`pg_restore zakończył się błędem (${code}): ${stderr.split('\n').find((l) => l.includes('error')) ?? ''}`.trim())));
  }), () => { throw new Error('Brak pg_restore. Uruchom npm run pg:tools lub ustaw DYNA_PG_TOOLS na katalog narzędzi wersji 18+.'); });
}

export async function restorePlainDump(dump: string, database: string) {
  check(/^[a-z][a-z0-9_]{0,62}$/.test(database), 'Nieprawidłowa nazwa nowej bazy');
  const server = cluster(), started = performance.now();
  const admin = watchDbClient(new pg.Client({ ...server, database: 'postgres' }), 'recovery-dump-admin');
  await admin.connect();
  let created = false;
  try {
    check((await admin.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [database])).rows[0].n === 0, 'Baza docelowa już istnieje; odtworzenie dumpa wymaga nowej, pustej bazy');
    const role = (await admin.query("SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='dyna_app'")).rows[0];
    check(role && !role.rolsuper && !role.rolbypassrls && !role.rolcanlogin, 'Rola aplikacji dyna_app nie istnieje w klastrze albo ma nadmierne uprawnienia');
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    await pgRestore(['--host=127.0.0.1', `--port=${server.port}`, '--username=postgres', '--no-password', `--dbname=${database}`,
      '--single-transaction', '--exit-on-error', '--no-owner', resolve(dump)], server.password);
    const c = watchDbClient(new pg.Client({ ...server, database }), 'recovery-dump-restore');
    await c.connect();
    try {
      await c.query("SET SESSION statement_timeout='120s'");
      await c.query("SET SESSION lock_timeout='8s'");
      await c.query('SET SESSION jit=off');
      await c.query("SET SESSION timezone='UTC'");
      const temporary = await reapplyRevokePublicTemporary(c);
      const acl = await normalizeOrdinaryLegacyOwnerAcls(c);
      return { status: 'restored', database, temporary, ...acl, ms: Math.round(performance.now() - started) };
    } finally {
      await c.end();
    }
  } catch (e) {
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => {});
    throw e;
  } finally {
    await admin.end().catch(() => {});
  }
}
