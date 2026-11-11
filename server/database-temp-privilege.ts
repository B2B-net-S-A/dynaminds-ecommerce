/** Migration 262 (prepared as 278; docs/parity/SECDEF-PGTEMP-P278-20261029.md "Integracja jako 262") revokes TEMPORARY on
 * the database from PUBLIC, so a role-confined dyna_app session cannot create a temporary table that shadows a relation
 * a SECURITY DEFINER function reads. The change lives only in pg_database.datacl, which the migration ledger cannot
 * keep: CREATE DATABASE … TEMPLATE and a logical restore (pg_dump/pg_restore) start the copy with the default ACL, in
 * which PUBLIC has TEMPORARY again, while the ledger still says 262 ran. The start therefore re-checks the privilege
 * itself, and the restore path re-applies the exact 262 statement. */
export const REVOKE_PUBLIC_TEMPORARY = '262_revoke_public_temporary';
/** The statement of server/262_revoke_public_temporary.sql, byte for byte (tests/revoke-public-temporary262.test.mjs pins
 * it against the file; the runtime resource reader binds that file to server/db.ts, its only consumer). */
export const REVOKE_PUBLIC_TEMPORARY_STATEMENT = `DO $$
DECLARE
  db    text := current_database();
  owner text := (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = current_database());
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'pg_database_owner', 'USAGE')
     AND (SELECT datdba FROM pg_catalog.pg_database WHERE datname = db) <> current_user::regrole::oid
     AND NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'Migration 278 must run as the owner of database %, got %', db, current_user
      USING ERRCODE = '42501';
  END IF;
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', db);
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', db, owner);
END $$;
`;
type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export class DatabaseTempPrivilegeError extends Error {
  readonly code = 'DATABASE_TEMP_PRIVILEGE';
  constructor(readonly database: string) {
    super(`Baza ${database} pozwala roli aplikacji tworzyć tabele tymczasowe (TEMPORARY), choć migracja ${REVOKE_PUBLIC_TEMPORARY} jest zapisana jako zastosowana. `
      + 'Uprawnienie bazy ginie przy klonowaniu (CREATE DATABASE … TEMPLATE) i odtworzeniu z kopii logicznej. '
      + `Aplikacja się nie uruchomi: właściciel bazy musi ponownie wykonać blok DO z server/${REVOKE_PUBLIC_TEMPORARY}.sql `
      + '(narzędzie odtwarzania robi to samo) i usunąć każde jawne nadanie TEMPORARY dla dyna_app.');
    this.name = 'DatabaseTempPrivilegeError';
  }
}

/** The ledger row of 262 and whether dyna_app (directly or through PUBLIC) may create temporary tables here. */
export async function databaseTempPrivilege(c: Queryable) {
  const row = (await c.query(`SELECT current_database() database,
      EXISTS(SELECT FROM public.migrations WHERE name=$1) applied,
      pg_catalog.has_database_privilege('dyna_app', current_database(), 'TEMPORARY') app_temp`, [REVOKE_PUBLIC_TEMPORARY])).rows[0];
  if (!row || typeof row.applied !== 'boolean' || typeof row.app_temp !== 'boolean' || typeof row.database !== 'string')
    throw new Error('Nie można odczytać uprawnienia TEMPORARY bazy');
  return { database: row.database as string, applied: row.applied as boolean, appTemp: row.app_temp as boolean };
}

/** Start check: once the ledger includes 262, dyna_app must not hold TEMPORARY on the database. */
export async function assertDatabaseTempPrivilege(c: Queryable) {
  const state = await databaseTempPrivilege(c);
  if (state.applied && state.appTemp) throw new DatabaseTempPrivilegeError(state.database);
  return state;
}

/** Restore path: when the restored ledger includes 262, run the exact 262 statement again (the database ACL is not part
 * of a logical dump), then require the start condition. The caller is the owner of the restored database. */
export async function reapplyRevokePublicTemporary(c: Queryable) {
  const state = await databaseTempPrivilege(c);
  if (!state.applied) return { ...state, reapplied: false };
  await c.query(REVOKE_PUBLIC_TEMPORARY_STATEMENT);
  return { ...(await assertDatabaseTempPrivilege(c)), reapplied: true };
}
