-- Migration 262_revoke_public_temporary (prepared as 278, registered after 261_stocktake_evidence_usage;
-- docs/parity/SECDEF-PGTEMP-P278-20261029.md). Defence-in-depth against SECURITY DEFINER pg_temp relation
-- shadowing.
--
-- 1 130 SECURITY DEFINER functions in schema public have a search_path of pg_catalog, public (or
-- pg_catalog, public, ordinary187_private) that does not list pg_temp. PostgreSQL resolves an UNQUALIFIED
-- relation name in pg_temp before any schema on the path, so a session that can CREATE a temporary table of
-- the same name shadows the table such a function reads or writes. Demonstrated on a PG04 clone as dyna_app
-- in a rolled-back transaction: the 235 WMS evidence counter stayed unchanged while the increment landed in a
-- temp shadow, and the sealed guard b2b_dropship_wms_change_allowed() returned true for a change it must
-- forbid. Reachable only by a session that can both run DML as dyna_app and create a temporary table, i.e. a
-- multi-statement SQL-injection foothold; sealed functions (manifest 149, 235, …) cannot be edited in place.
--
-- Removing PUBLIC's implicit TEMPORARY on this database stops a role-confined dyna_app session from creating
-- temporary tables at all, which closes the shadowing surface for every such function at once without touching
-- any sealed object or any guard. The database owner keeps TEMPORARY, so the owner-run SECURITY DEFINER
-- functions that legitimately create ON COMMIT DROP temp tables (167 operative_delivery_*, 168
-- parcel_physical_wz_*) keep working: those temp tables are created while current_user is the function owner,
-- never dyna_app. Verified on the clone: an owner-owned SECURITY DEFINER function still creates a temp table
-- after the revoke, while a direct dyna_app CREATE TEMP TABLE raises 42501.
--
-- Transactional, idempotent, owner-agnostic: it uses current_database() so it is correct on every clone, and
-- grants TEMPORARY to the actual database owner (datdba) so a non-superuser owner also keeps the privilege.
-- The migration runner connects as the database owner (server/db.ts: postgres, = datdba), which may REVOKE and
-- GRANT on the database. The change alters only pg_database.datacl; cold inspection
-- (packing189-catalogue-sql.mjs) snapshots relation/function/default ACLs, never the database ACL, so it is
-- unaffected.
DO $$
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
