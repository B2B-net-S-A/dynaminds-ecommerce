import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { ensure } from "../server/errors";
const source = readFileSync(
    new URL("../server/crm-bootstrap.ts", import.meta.url),
    "utf8",
  ),
  m = { exports: {} as any };
new Function(
  "require",
  "module",
  "exports",
  transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code,
)(
  (n: string) => {
    assert.equal(n, "./errors");
    return { ensure };
  },
  m,
  m.exports,
);
const tables = [
    "crm_clients",
    "crm_commands",
    "crm_extra_fields",
    "crm_files",
    "crm_order_links",
    "crm_status_groups",
    "crm_statuses",
    "crm_values",
  ],
  functions = ["crm215_protected()", "crm215_seed(uuid)"],
  id = "00000000-0000-4000-8000-000000000001";
async function invoke(state: any) {
  const calls: any[] = [];
  const result = await m.exports.bootstrapCrmTenantInOwnerTx(
    {
      query: async (text: string, args: any[]) => {
        calls.push({ text, args });
        return calls.length === 1 ? { rows: [state] } : { rows: [] };
      },
    },
    id,
  );
  return { result, calls };
}
test("fully absent legacy skips without executing a seed or changing any rows", async () => {
  const x = await invoke({
    actor: "postgres",
    installed: false,
    tables: [],
    functions: [],
    unexpected_trigger: false,
  });
  assert.equal(x.result.initialized, false);
  assert.equal(x.calls.length, 1);
});
test("full215 seeds through the same supplied owner client and exact tenant ID", async () => {
  const x = await invoke({
    actor: "postgres",
    installed: true,
    tables,
    functions,
    unexpected_trigger: false,
  });
  assert.equal(x.result.initialized, true);
  assert.deepEqual(x.calls[1], {
    text: "SELECT public.crm215_seed($1::uuid)",
    args: [id],
  });
});
test("every partial footprint, missing function/marker, overload and nonowner fails before seed", async () => {
  const complete = {
    actor: "postgres",
    installed: true,
    tables,
    functions,
    unexpected_trigger: false,
  };
  for (const patch of [
    { installed: false },
    { tables: tables.slice(1) },
    { functions: functions.slice(0, 1) },
    { functions: [...functions, "crm215_seed(text)"] },
    { unexpected_trigger: true },
    { actor: "dyna_app" },
    { installed: false, tables: [], functions: ["crm215_seed(uuid)"] },
    { installed: false, tables: ["crm_clients"], functions: [] },
  ]) {
    const calls: any[] = [];
    await assert.rejects(
      m.exports.bootstrapCrmTenantInOwnerTx(
        {
          query: async (text: string) => {
            calls.push(text);
            return { rows: [{ ...complete, ...patch }] };
          },
        },
        id,
      ),
      (e: any) => e.status === 503,
    );
    assert.equal(calls.length, 1);
  }
});
test("SQL does not alter predecessor tenants triggers; authoritative onboarding and fixture seed invoke explicit bootstrap", () => {
  const sql = readFileSync(
    new URL("../server/215_crm.sql", import.meta.url),
    "utf8",
  );
  assert(!sql.includes("crm215_seed_tenant"));
  assert(!/TRIGGER[^;]+ON tenants/.test(sql));
  assert(
    sql.includes("FOR t IN SELECT id FROM tenants LOOP PERFORM crm215_seed(t)"),
  );
  assert(sql.includes("REVOKE ALL ON FUNCTION crm215_seed(uuid) FROM PUBLIC"));
  const workspace = readFileSync(
      new URL("../server/workspace-routes.ts", import.meta.url),
      "utf8",
    ),
    seed = readFileSync(new URL("../server/seed.ts", import.meta.url), "utf8");
  assert(
    workspace.indexOf("await bootstrapCrmTenantInOwnerTx(c, id)") >
      workspace.indexOf("async function createOrganization"),
  );
  assert(workspace.includes("await c.query('BEGIN')"));
  assert(seed.includes("await bootstrapCrmTenantInOwnerTx(c, DEMO_TENANT)"));
  assert(seed.includes("await bootstrapCrmTenantInOwnerTx(c, SECOND_TENANT)"));
});
