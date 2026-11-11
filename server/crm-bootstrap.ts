/** Authoritative organization creation only. Never called from a read or from dyna_app. */
import type { PoolClient } from "pg";
import { ensure } from "./errors";
const tables = [
  "crm_clients",
  "crm_commands",
  "crm_extra_fields",
  "crm_files",
  "crm_order_links",
  "crm_status_groups",
  "crm_statuses",
  "crm_values",
];
const functions = ["crm215_protected()", "crm215_seed(uuid)"];
export async function bootstrapCrmTenantInOwnerTx(
  c: PoolClient,
  tenantId: string,
) {
  const state = (
    await c.query(`SELECT current_user AS actor,
 EXISTS(SELECT 1 FROM migrations WHERE name='215_crm') AS installed,
 ARRAY(SELECT name FROM unnest(ARRAY['crm_clients','crm_commands','crm_extra_fields','crm_files','crm_order_links','crm_status_groups','crm_statuses','crm_values']) name WHERE to_regclass('public.'||name) IS NOT NULL ORDER BY name) AS tables,
 ARRAY(SELECT p.proname||'('||pg_catalog.oidvectortypes(p.proargtypes)||')' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'crm215_') ORDER BY 1) AS functions,
 EXISTS(SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND starts_with(t.tgname,'crm215_')) AS unexpected_trigger`)
  ).rows[0];
  ensure(
    state &&
      Array.isArray(state.tables) &&
      Array.isArray(state.functions) &&
      typeof state.installed === "boolean" &&
      typeof state.unexpected_trigger === "boolean",
    503,
    "Nieprawidłowy stan inicjalizacji CRM",
  );
  if (
    !state.installed &&
    !state.tables.length &&
    !state.functions.length &&
    !state.unexpected_trigger
  )
    return {
      initialized: false as const,
      reason: "LEGACY_WITHOUT_CRM215" as const,
    };
  ensure(
    state.installed &&
      JSON.stringify(state.tables) === JSON.stringify(tables) &&
      JSON.stringify(state.functions) === JSON.stringify(functions) &&
      !state.unexpected_trigger,
    503,
    "Niepełna migracja kartoteki CRM",
  );
  ensure(
    state.actor === "postgres",
    503,
    "Inicjalizacja CRM wymaga transakcji właściciela",
  );
  await c.query("SELECT public.crm215_seed($1::uuid)", [tenantId]);
  return { initialized: true as const };
}
