/** Actual routes and actual global READ ONLY middleware with closed core ports. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { z } from "zod";
import { ensure, Problem } from "../server/errors";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(readOnly = false, available = true) {
  const routes = new Map<string, any>(),
    calls: any[] = [],
    original: any = { client_key: uuid(3), notes: "only requested" };
  const ports: any = {
    zod: { z },
    "./errors": { ensure },
    "./crm": Object.fromEntries(
      [
        "executeCrmCommand",
        "cancelCrmCommand",
        "observeCrmCommand",
        "listCrmClients",
        "getCrmClient",
        "getCrmDictionaries",
        "getCrmOrders",
        "getCrmFile",
      ].map((name) => [
        name,
        async (...args: any[]) => {
          calls.push([name, ...args]);
          return name === "getCrmFile"
            ? {
                bytes: Buffer.from("%PDF-"),
                title: "Załącznik.pdf",
                mime_type: "application/pdf",
              }
            : { data: { id: uuid(4) }, can_write: true };
        },
      ]),
    ),
  };
  const m = { exports: {} as any };
  new Function(
    "require",
    "module",
    "exports",
    transformSync(
      readFileSync(new URL("../server/crm-routes.ts", import.meta.url), "utf8"),
      { loader: "ts", format: "cjs", target: "es2022" },
    ).code,
  )(
    (n: string) => {
      assert(Object.hasOwn(ports, n), n);
      return ports[n];
    },
    m,
    m.exports,
  );
  const app = Object.fromEntries(
    ["get", "post", "patch", "delete"].map((method) => [
      method,
      (p: string, opt: any, fn?: any) =>
        routes.set(method.toUpperCase() + " " + p, fn ?? opt),
    ]),
  );
  m.exports.registerCrmRoutes(app, { available, readOnly });
  const req = () =>
    ({
      actor: { tenantId: uuid(1), userId: uuid(2), role: "admin" },
      params: { id: uuid(4), fieldId: uuid(5) },
      query: {},
      body: structuredClone(original),
    }) as any;
  async function invoke(key: string, r = req()) {
    const headers: any = {};
    let status = 200;
    const reply: any = {
      code: (s: number) => {
        status = s;
        return reply;
      },
      header: (k: string, v: string) => {
        headers[k] = v;
        return reply;
      },
      send: (b: any) => b,
    };
    return { value: await routes.get(key)(r, reply), headers, status };
  }
  return { routes, calls, req, invoke };
}
test("client create/partial/update/delete, dictionaries and link forward exact original body exactly once", async () => {
  for (const [method, p, path] of [
    ["POST", "/api/crm/clients", "/api/crm/clients"],
    ["PATCH", "/api/crm/clients/:id", "/api/crm/clients/" + uuid(4)],
    ["DELETE", "/api/crm/clients/:id", "/api/crm/clients/" + uuid(4)],
    ["POST", "/api/crm/statuses", "/api/crm/statuses"],
    ["POST", "/api/crm/status-groups", "/api/crm/status-groups"],
    ["POST", "/api/crm/field-definitions", "/api/crm/field-definitions"],
    [
      "PATCH",
      "/api/crm/field-definitions/:id",
      "/api/crm/field-definitions/" + uuid(4),
    ],
    [
      "POST",
      "/api/crm/clients/:id/orders",
      "/api/crm/clients/" + uuid(4) + "/orders",
    ],
  ]) {
    const f = fixture(),
      r = f.req(),
      body = structuredClone(r.body);
    await f.invoke(method + " " + p, r);
    assert.deepEqual(f.calls, [
      ["executeCrmCommand", r.actor, method, path, body],
    ]);
    assert.deepEqual(r.body, body);
  }
});
test("readonly route refuses all mutations but permits original-command observation with body unchanged", async () => {
  const f = fixture(true);
  for (const [method, p] of [
    ["POST", "/api/crm/clients"],
    ["POST", "/api/crm/field-definitions"],
    ["PATCH", "/api/crm/field-definitions/:id"],
    ["PATCH", "/api/crm/clients/:id"],
    ["DELETE", "/api/crm/statuses/:id"],
    ["POST", "/api/crm/clients/:id/orders"],
  ])
    await assert.rejects(
      f.invoke(method + " " + p),
      (e: any) => e.status === 423,
    );
  assert.equal(f.calls.length, 0);
  const r = f.req(),
    body = structuredClone(r.body);
  await f.invoke("POST /api/crm/commands/observe", r);
  assert.deepEqual(f.calls, [["observeCrmCommand", r.actor, body]]);
  const read = await f.invoke("GET /api/crm/clients");
  assert.equal(read.value.can_write, false);
  assert.equal(read.value.read_only, true);
});
test("unavailable CRM and API-key/source principals fail before any core access", async () => {
  const absent = fixture(false, false);
  await assert.rejects(
    absent.invoke("GET /api/crm/clients"),
    (e: any) => e.status === 503,
  );
  assert.equal(absent.calls.length, 0);
  for (const mutate of [
    (r: any) => (r.actor.apiKeyId = uuid(8)),
    (r: any) => (r.actor.source = "api"),
    (r: any) => (r.apiScopes = []),
  ]) {
    const f = fixture(),
      r = f.req();
    mutate(r);
    await assert.rejects(
      f.invoke("POST /api/crm/commands/observe", r),
      (e: any) => e.status === 403,
    );
    assert.equal(f.calls.length, 0);
  }
});
test("file download is authenticated core read with attachment/nosniff/private headers, never inline data in JSON", async () => {
  const f = fixture(),
    r = f.req(),
    result = await f.invoke("GET /api/crm/clients/:id/files/:fieldId", r);
  assert(Buffer.isBuffer(result.value));
  assert.equal(result.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(result.headers["Cache-Control"], "private, no-store");
  assert(
    result.headers["Content-Disposition"].startsWith(
      "attachment; filename*=UTF-8",
    ),
  );
  assert.deepEqual(f.calls, [["getCrmFile", r.actor, uuid(4), uuid(5)]]);
});
test("actual global readonly middleware admits only the exact observational CRM POST", () => {
  const s = readFileSync(new URL("../server/app.ts", import.meta.url), "utf8"),
    a = s.indexOf(
      "    if (readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))",
    ),
    b = s.indexOf(
      "    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin)",
      a,
    );
  assert(a > 0 && b > a);
  const guard = new Function(
    "readOnly",
    "req",
    "ensure",
    "Problem",
    s.slice(a, b),
  );
  assert.doesNotThrow(() =>
    guard(
      true,
      { method: "POST", url: "/api/crm/commands/observe" },
      ensure,
      Problem,
    ),
  );
  for (const url of [
    "/api/crm/clients",
    "/api/crm/commands/observe/",
    "/api/crm/commands/observe/dispatch",
    "/api/crm/commands",
    "/api/crm/commands/cancel",
    "/api/crm/clients/" + uuid(4) + "/orders",
  ])
    assert.throws(
      () => guard(true, { method: "POST", url }, ensure, Problem),
      (e: any) => e.status === 423,
    );
  for (const method of ["PATCH", "DELETE", "PUT"])
    assert.throws(
      () =>
        guard(
          true,
          { method, url: "/api/crm/commands/observe" },
          ensure,
          Problem,
        ),
      (e: any) => e.status === 423,
    );
});

test("cancel is explicit write-only, forwards exact original envelope and is blocked by global readonly guard", async () => {
  const f = fixture(),
    r = f.req(),
    body = structuredClone(r.body);
  await f.invoke("POST /api/crm/commands/cancel", r);
  assert.deepEqual(f.calls, [["cancelCrmCommand", r.actor, body]]);
  const ro = fixture(true);
  await assert.rejects(
    ro.invoke("POST /api/crm/commands/cancel"),
    (e: any) => e.status === 423,
  );
  assert.equal(ro.calls.length, 0);
});
