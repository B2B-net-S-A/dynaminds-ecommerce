/** Migration 262_revoke_public_temporary (prepared as 278, registered after 261_stocktake_evidence_usage;
 * docs/parity/SECDEF-PGTEMP-P278-20261029.md "Integracja jako 262") and the start check it needs: the database ACL is not
 * kept by CREATE DATABASE … TEMPLATE or a logical restore, so a ledger that includes 262 does not prove that dyna_app has
 * no TEMPORARY. No database here; tests/revoke-public-temporary262.database.test.ts runs it on a clone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
import { assertDatabaseTempPrivilege, DatabaseTempPrivilegeError, reapplyRevokePublicTemporary, REVOKE_PUBLIC_TEMPORARY, REVOKE_PUBLIC_TEMPORARY_STATEMENT } from '../server/database-temp-privilege';

const file = new URL('../server/262_revoke_public_temporary.sql', import.meta.url);
const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '');

test('262 follows 261 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 262), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file);
  assert(row, 'manifest row 262');
  assert.equal(row.name, REVOKE_PUBLIC_TEMPORARY);
  assert.equal(row.file, '262_revoke_public_temporary.sql');
  assert.equal(row.native_id, 'revoke_public_temporary262');
  assert.equal(row.cold.contract, 'revoke-public-temporary262');
  assert.equal(row.cold.project, 'projectCompiledRevokePublicTemporary262Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 3091);
  assert.equal(row.sha256, 'f5887c27b423b27aa1df7ce5fa37cbfe03af65c9b2f8d6108dfeda372a43f85a');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '261_stocktake_evidence_usage');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '263_manual_off_verdict', '263 follows 262');
  assert.equal(RELEASE_MIGRATIONS.some((m) => m.number === 278 || /^278_/.test(m.file)), false, 'the placeholder number is gone');
  assert.doesNotMatch(read('server/db.ts'), /revoke_public_temporary/, 'db.ts takes 262 from the manifest, not a literal pair');
});

test('262: one DO block that revokes TEMPORARY from PUBLIC and grants it to the database owner, nothing else', () => {
  assert.match(readFileSync(file, 'utf8').split('\n')[0], /^-- Migration 262_revoke_public_temporary \(prepared as 278, registered after 261_stocktake_evidence_usage;/);
  const s = code();
  assert.equal(s.match(/\bDO \$\$/g)?.length, 1);
  assert(s.includes("EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', db);"));
  assert(s.includes("EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', db, owner);"));
  assert(s.includes("USING ERRCODE = '42501'"), 'refuses to run as anyone but the owner or a superuser');
  assert.doesNotMatch(s, /\b(?:CREATE|ALTER|DROP)\b/i, 'no schema object');
  // The restore path re-applies the very same statement (the resource reader binds the file to server/db.ts).
  const sql = readFileSync(file, 'utf8');
  assert.equal(REVOKE_PUBLIC_TEMPORARY_STATEMENT, sql.slice(sql.indexOf('DO $$')));
});

test('the start refuses right after migrate(), before seed and the app; the restore re-applies 262 before it verifies', () => {
  const index = read('server/index.ts');
  const at = index.indexOf('await migrate();\n'), check = index.indexOf('await assertDatabaseTempPrivilege(pool);\n');
  assert(at >= 0 && check > at, 'index.ts checks after migrate()');
  assert(check < index.indexOf('await seed();') && check < index.indexOf('await buildApp('), 'before seed and buildApp');
  assert.equal(index.slice(at, check).replace(/\/\/[^\n]*\n/g, ''), 'await migrate();\n', 'nothing runs in between');
  const recovery = read('server/recovery.ts');
  const reapply = recovery.indexOf('await reapplyRevokePublicTemporary(c);');
  assert(reapply > recovery.indexOf("'--use-list=' + deferredList"), 'after the last pg_restore step');
  assert(reapply < recovery.indexOf('const restoredTables = await tableFingerprints(c);'), 'before the verification of the restored copy');
});

// The release start (ordinary-local-cli → createOrdinaryLocalApplication) runs its own migrate(); a release built from
// a70e164 started on a plain pg_restore copy where dyna_app still had TEMPORARY (docs/parity/CRM-N25B-LOCAL-20261023.md).
test('the release start refuses right after its migrate(), before the cold validation, the startup and the app', () => {
  const runtime = read('server/ordinary-local-runtime.ts');
  assert.match(runtime, /^import \{assertDatabaseTempPrivilege\} from '\.\/database-temp-privilege';$/m);
  const at = runtime.indexOf('await db.migrate();'), check = runtime.indexOf('await assertDatabaseTempPrivilege(db.pool);');
  assert(at >= 0 && check > at, 'the check follows the release migrate()');
  assert.equal(runtime.indexOf('await assertDatabaseTempPrivilege(', check + 1), -1, 'one check');
  assert.doesNotMatch(runtime.slice(at, check), /await (?!db\.migrate\(\))/, 'nothing else is awaited in between');
  for (const later of ['createPortableReviewedStartup(', 'normalizeOrdinaryLegacyOwnerAcls(owner)', "await import('./app')", 'module.buildApp('])
    assert(check < runtime.indexOf(later), 'before ' + later);
});

test('the release CLI prints the Polish refusal and its code, like the migrate() refusals', async () => {
  const { ordinaryLocalStartFailure } = await import('../server/ordinary-local-cli');
  const d = ordinaryLocalStartFailure(new DatabaseTempPrivilegeError('dynaminds_x'));
  assert.deepEqual([d.status, d.name, d.code], ['ORDINARY_LOCAL_START_FAILED', 'DatabaseTempPrivilegeError', 'DATABASE_TEMP_PRIVILEGE']);
  assert.match(String(d.message), /^Baza dynaminds_x pozwala roli aplikacji tworzyć tabele tymczasowe \(TEMPORARY\).*Aplikacja się nie uruchomi/);
});

/** A fake owner session: the ledger row of 262, the effective TEMPORARY of dyna_app, and the statements it ran. */
function session(applied: boolean, appTemp: boolean) {
  const ran: string[] = [];
  const c = {
    state: { applied, appTemp },
    async query(sql: string) {
      ran.push(sql);
      if (sql === REVOKE_PUBLIC_TEMPORARY_STATEMENT) { c.state.appTemp = false; return { rows: [] }; }
      return { rows: [{ database: 'dynaminds_x', applied: c.state.applied, app_temp: c.state.appTemp }] };
    },
  };
  return { c, ran };
}

test('start check: refuses with a Polish message only when the ledger has 262 and dyna_app holds TEMPORARY', async () => {
  for (const [applied, appTemp] of [[false, true], [false, false], [true, false]] as const)
    assert.deepEqual(await assertDatabaseTempPrivilege(session(applied, appTemp).c), { database: 'dynaminds_x', applied, appTemp });
  await assert.rejects(assertDatabaseTempPrivilege(session(true, true).c), (e: any) => e instanceof DatabaseTempPrivilegeError
    && e.code === 'DATABASE_TEMP_PRIVILEGE' && /^Baza dynaminds_x pozwala roli aplikacji tworzyć tabele tymczasowe \(TEMPORARY\)/.test(e.message)
    && e.message.includes('262_revoke_public_temporary') && e.message.includes('Aplikacja się nie uruchomi'));
  await assert.rejects(assertDatabaseTempPrivilege({ query: async () => ({ rows: [{ database: 'x', applied: 'yes', app_temp: true }] }) }), /Nie można odczytać uprawnienia TEMPORARY bazy/);
});

test('restore: re-applies the 262 statement only for a ledger with 262, then requires the start condition', async () => {
  const before = session(false, true);
  assert.deepEqual(await reapplyRevokePublicTemporary(before.c), { database: 'dynaminds_x', applied: false, appTemp: true, reapplied: false });
  assert(!before.ran.includes(REVOKE_PUBLIC_TEMPORARY_STATEMENT), 'a pre-262 copy (MIG-4 rollback) is left as it was');
  const restored = session(true, true);
  assert.deepEqual(await reapplyRevokePublicTemporary(restored.c), { database: 'dynaminds_x', applied: true, appTemp: false, reapplied: true });
  assert.equal(restored.ran.filter((s) => s === REVOKE_PUBLIC_TEMPORARY_STATEMENT).length, 1);
  // An explicit GRANT TEMPORARY TO dyna_app survives REVOKE … FROM PUBLIC: the restore refuses instead of hiding it.
  const granted = session(true, true);
  granted.c.query = async (sql: string) => { granted.ran.push(sql); return { rows: sql === REVOKE_PUBLIC_TEMPORARY_STATEMENT ? [] : [{ database: 'dynaminds_x', applied: true, app_temp: true }] }; };
  await assert.rejects(reapplyRevokePublicTemporary(granted.c), DatabaseTempPrivilegeError);
});
