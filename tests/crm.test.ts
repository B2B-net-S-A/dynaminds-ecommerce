/** Actual CRM SQL orchestration on controlled transaction/storage ports; no PostgreSQL/network. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { transformSync } from "esbuild";
import { z } from "zod";
import { ensure, Problem } from "../server/errors";
const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = (n: string) =>
  readFileSync(new URL("../server/" + n, import.meta.url), "utf8");
function load(s: string, ports: Record<string, any>) {
  const m = { exports: {} as any };
  new Function(
    "require",
    "module",
    "exports",
    transformSync(s, { loader: "ts", format: "cjs", target: "es2022" }).code,
  )(
    (n: string) => {
      assert(Object.hasOwn(ports, n), "Unexpected import " + n);
      return ports[n];
    },
    m,
    m.exports,
  );
  return m.exports;
}
const schemas = load(source("crm-schema.ts"), { zod: { z } });
function fixture() {
  const actor = { tenantId: uid(1), userId: uid(2), role: "admin" as const },
    main = uid(3),
    primary = uid(4),
    state: any = {
      role: "admin",
      definitionsInstalled: true,
      groups: [
        {
          id: main,
          tenant_id: actor.tenantId,
          name: "Główna",
          is_main_group: true,
          version: 1,
        },
      ],
      statuses: [
        {
          id: primary,
          tenant_id: actor.tenantId,
          group_id: main,
          name: "Nowy",
          color: "#64748b",
          is_primary: true,
          position: 0,
          version: 1,
        },
      ],
      clients: [],
      commands: [],
      values: [],
      files: [],
      links: [],
      orders: [
        {
          id: uid(8),
          tenant_id: actor.tenantId,
          number: "O-1",
          total: 1230,
          items: [{ quantity: 1 }],
          events: ["created"],
          address: { city: "Łódź" },
        },
      ],
      audits: [],
      fields: [],
    };
  let next = 100,
    reader = false,
    tenant = actor.tenantId,
    journalFail = false,
    unknown = false;
  const statements: any[] = [],
    txKinds: string[] = [];
  const out = (rows: any[]) => ({
      rows: structuredClone(rows),
      rowCount: rows.length,
    }),
    one = (x: any) => out(x ? [x] : []),
    own = (r: any) => r.tenant_id === tenant;
  const c = {
    query: async (text: string, args: any[] = []) => {
      statements.push({ text, args: structuredClone(args) });
      if (reader)
        assert(
          text.startsWith("SELECT") &&
            !/FOR UPDATE|FOR SHARE|advisory|order_field_role/.test(text),
          "RO must not lock or mutate",
        );
      if (/\b(?:FROM|JOIN)\s+(?:public\.)?migrations\b/i.test(text))
        throw Object.assign(Error("permission denied for table migrations"), {
          code: "42501",
        });
      if (
        text.includes("FROM pg_catalog.pg_attribute") &&
        text.includes("AS archive_valid")
      )
        return one(
          state.definitionsMetadata ?? {
            version_present: state.definitionsInstalled,
            archive_present: state.definitionsInstalled,
            version_valid: state.definitionsInstalled,
            archive_valid: state.definitionsInstalled,
          },
        );
      if (
        text ===
        "SELECT * FROM crm_extra_fields ORDER BY position,id LIMIT 1001 FOR UPDATE"
      )
        return out(
          state.fields
            .filter(own)
            .toSorted(
              (a: any, b: any) =>
                a.position - b.position || a.id.localeCompare(b.id),
            ),
        );
      if (text.startsWith("SELECT id AS extra_field_id"))
        return out(
          state.fields.filter(own).map((r: any) => ({
            extra_field_id: r.id,
            name: r.name,
            editor_type: r.editor_type,
            options: r.options,
            ...(text.includes("version")
              ? {
                  position: r.position,
                  version: r.version,
                  archived: Boolean(r.archived_at),
                }
              : {}),
          })),
        );
      if (
        text.startsWith(
          "SELECT EXISTS(SELECT 1 FROM crm_values WHERE field_id=",
        )
      ) {
        const allowed = JSON.parse(args[1]);
        return one({
          incompatible: state.values
            .filter((r: any) => own(r) && r.field_id === args[0])
            .some((r: any) =>
              args[2] === "checkbox"
                ? !Array.isArray(r.value) ||
                  r.value.some((v: any) => !allowed.includes(v))
                : typeof r.value !== "string" || !allowed.includes(r.value),
            ),
        });
      }
      if (
        text ===
        "UPDATE crm_extra_fields SET position=$2,version=version+1 WHERE id=$1"
      ) {
        const r = state.fields.find((r: any) => own(r) && r.id === args[0]);
        r.position = args[1];
        r.version++;
        return out([]);
      }
      if (text.startsWith("INSERT INTO crm_extra_fields")) {
        const r = {
          id: uid(next++),
          tenant_id: args[0],
          name: args[1],
          editor_type: args[2],
          options: JSON.parse(args[3]),
          position: args[4],
          version: 1,
          archived_at: null,
        };
        state.fields.push(r);
        return one(r);
      }
      if (text.startsWith("UPDATE crm_extra_fields SET name=")) {
        const r = state.fields.find((r: any) => own(r) && r.id === args[0]);
        Object.assign(r, {
          name: args[1],
          options: JSON.parse(args[2]),
          position: args[3],
          version: r.version + 1,
          archived_at:
            args[4] === null
              ? r.archived_at
              : args[4]
                ? (r.archived_at ?? "2026-10-19T00:00:00.000Z")
                : null,
        });
        return one(r);
      }
      if (text.startsWith("SELECT pg_advisory")) return out([]);
      if (
        text.includes("public.order_field_role") ||
        text.includes("public.customer_message_role")
      )
        return one({ role: state.role });
      if (text.startsWith("SELECT * FROM crm_commands"))
        return one(
          state.commands.find(
            (r: any) =>
              own(r) && r.client_key.toLowerCase() === args[0].toLowerCase(),
          ),
        );
      if (text.startsWith("INSERT INTO crm_commands")) {
        if (journalFail) throw Error("journal unavailable");
        if (state.commands.some((r: any) => own(r) && r.client_key === args[1]))
          return out([]);
        state.commands.push({
          tenant_id: args[0],
          client_key: args[1],
          actor_id: args[2],
          request_hash: args[3],
          request: JSON.parse(args[4]),
          response: JSON.parse(args[5]),
        });
        return one({ client_key: args[1] });
      }
      if (text === "SELECT id FROM crm_statuses WHERE is_primary")
        return one(state.statuses.find((r: any) => own(r) && r.is_primary));
      if (text.startsWith("SELECT id FROM crm_statuses WHERE id="))
        return one(state.statuses.find((r: any) => own(r) && r.id === args[0]));
      if (text.startsWith("SELECT * FROM crm_clients WHERE id="))
        return one(
          state.clients.find(
            (r: any) => own(r) && r.id === args[0] && !r.deleted_at,
          ),
        );
      if (text.startsWith("INSERT INTO crm_clients")) {
        const r = {
          id: uid(next++),
          tenant_id: args[0],
          status_id: args[1],
          profile: JSON.parse(args[2]),
          version: 1,
          created_at: "2026-10-19T00:00:00.000Z",
          updated_at: "2026-10-19T00:00:00.000Z",
          deleted_at: null,
        };
        state.clients.push(r);
        return one(r);
      }
      if (text.startsWith("UPDATE crm_clients SET profile=")) {
        const r = state.clients.find((x: any) => own(x) && x.id === args[0]);
        Object.assign(r, {
          profile: JSON.parse(args[1]),
          status_id: args[2],
          version: r.version + 1,
          updated_at: "2026-10-19T01:00:00.000Z",
        });
        return one(r);
      }
      if (text.startsWith("UPDATE crm_clients SET deleted_at=")) {
        const r = state.clients.find((x: any) => own(x) && x.id === args[0]);
        r.deleted_at = "deleted";
        r.version++;
        return one(r);
      }
      if (text.startsWith("UPDATE crm_clients SET status_id=")) {
        for (const r of state.clients.filter(
          (r: any) => own(r) && r.status_id === args[0],
        )) {
          r.status_id = args[1];
          r.version++;
        }
        return out([]);
      }
      if (text.startsWith("UPDATE crm_clients SET version=")) {
        const r = state.clients.find((r: any) => own(r) && r.id === args[0]);
        r.version++;
        return one(r);
      }
      if (text === "SELECT id FROM crm_status_groups WHERE is_main_group")
        return one(state.groups.find((r: any) => own(r) && r.is_main_group));
      if (text === "SELECT id FROM crm_status_groups WHERE id=$1 FOR SHARE")
        return one(state.groups.find((r: any) => own(r) && r.id === args[0]));
      if (text.startsWith("INSERT INTO crm_status_groups")) {
        const r = {
          id: uid(next++),
          tenant_id: args[0],
          name: args[1],
          is_main_group: false,
          version: 1,
        };
        state.groups.push(r);
        return one(r);
      }
      if (text.startsWith("UPDATE crm_status_groups SET name=")) {
        const r = state.groups.find((r: any) => own(r) && r.id === args[0]);
        r.name = args[1];
        r.version++;
        return one(r);
      }
      if (text.startsWith("INSERT INTO crm_statuses")) {
        const position =
            Math.max(
              -1,
              ...state.statuses
                .filter((r: any) => own(r) && r.group_id === args[1])
                .map((r: any) => r.position),
            ) + 1,
          r = {
            id: uid(next++),
            tenant_id: args[0],
            group_id: args[1],
            name: args[2],
            color: args[3],
            position,
            is_primary: false,
            version: 1,
          };
        state.statuses.push(r);
        return one(r);
      }
      if (text.startsWith("SELECT coalesce(max(position),-1)+1 AS position"))
        return one({
          position:
            Math.max(
              -1,
              ...state.statuses
                .filter((r: any) => own(r) && r.group_id === args[0])
                .map((r: any) => r.position),
            ) + 1,
        });
      if (text.startsWith("UPDATE crm_statuses SET name=")) {
        const r = state.statuses.find((r: any) => own(r) && r.id === args[0]);
        Object.assign(r, {
          name: args[1],
          color: args[2],
          group_id: args[3],
          position: args[4],
          version: r.version + 1,
        });
        return one(r);
      }
      if (text === "SELECT * FROM crm_statuses WHERE id=$1 FOR UPDATE")
        return one(state.statuses.find((r: any) => own(r) && r.id === args[0]));
      if (text === "DELETE FROM crm_statuses WHERE id=$1") {
        state.statuses = state.statuses.filter(
          (r: any) => !own(r) || r.id !== args[0],
        );
        return out([]);
      }
      if (text === "SELECT * FROM crm_status_groups WHERE id=$1 FOR UPDATE")
        return one(state.groups.find((r: any) => own(r) && r.id === args[0]));
      if (
        text ===
        "SELECT * FROM crm_status_groups WHERE is_main_group FOR UPDATE"
      )
        return one(state.groups.find((r: any) => own(r) && r.is_main_group));
      if (text.startsWith("WITH moved AS")) {
        let p = Math.max(
          -1,
          ...state.statuses
            .filter((r: any) => own(r) && r.group_id === args[1])
            .map((r: any) => r.position),
        );
        for (const s of state.statuses
          .filter((r: any) => own(r) && r.group_id === args[0])
          .sort((a: any, b: any) => a.position - b.position)) {
          s.group_id = args[1];
          s.position = ++p;
          s.version++;
        }
        return out([]);
      }
      if (text === "DELETE FROM crm_status_groups WHERE id=$1") {
        state.groups = state.groups.filter(
          (r: any) => !own(r) || r.id !== args[0],
        );
        return out([]);
      }
      if (text === "SELECT id FROM orders WHERE id=$1 FOR SHARE")
        return one(state.orders.find((r: any) => own(r) && r.id === args[0]));
      if (text === "SELECT client_id FROM crm_order_links WHERE order_id=$1")
        return one(
          state.links.find((r: any) => own(r) && r.order_id === args[0]),
        );
      if (text.startsWith("INSERT INTO crm_order_links")) {
        if (!state.links.some((r: any) => own(r) && r.order_id === args[2]))
          state.links.push({
            tenant_id: args[0],
            client_id: args[1],
            order_id: args[2],
          });
        return out([]);
      }
      if (text.startsWith("SELECT * FROM crm_extra_fields WHERE id="))
        return out(
          state.fields.filter((r: any) => own(r) && args[0].includes(r.id)),
        );
      if (text.startsWith("INSERT INTO crm_files")) {
        state.files.push({
          id: args[0],
          tenant_id: args[1],
          client_id: args[2],
          field_id: args[3],
          actor_id: args[4],
          title: args[5],
          mime_type: args[6],
          byte_count: args[7],
          content_sha256: args[8],
          encrypted_bytes: args[9],
        });
        return out([]);
      }
      if (text.startsWith("INSERT INTO crm_values")) {
        const r = {
            tenant_id: args[0],
            client_id: args[1],
            field_id: args[2],
            editor_type: args[3],
            value: JSON.parse(args[4]),
            file_id: args[5],
          },
          old = state.values.find(
            (x: any) =>
              own(x) &&
              x.client_id === r.client_id &&
              x.field_id === r.field_id,
          );
        if (old) Object.assign(old, r);
        else state.values.push(r);
        return out([]);
      }
      if (
        text === "DELETE FROM crm_values WHERE client_id=$1 AND field_id=$2"
      ) {
        state.values = state.values.filter(
          (r: any) =>
            !own(r) || r.client_id !== args[0] || r.field_id !== args[1],
        );
        return out([]);
      }
      if (text.startsWith("SELECT v.field_id,v.value"))
        return out(
          state.values
            .filter((r: any) => own(r) && r.client_id === args[0])
            .map((r: any) => ({
              ...r,
              title: state.files.find((f: any) => own(f) && f.id === r.file_id)
                ?.title,
            })),
        );
      if (text.startsWith("SELECT f.* FROM crm_files"))
        return one(
          state.files.find(
            (f: any) =>
              own(f) &&
              f.client_id === args[0] &&
              f.field_id === args[1] &&
              state.values.some((v: any) => own(v) && v.file_id === f.id),
          ),
        );
      if (
        text.startsWith("SELECT * FROM crm_clients WHERE deleted_at IS NULL")
      ) {
        const limit = args.at(-2),
          offset = args.at(-1);
        return out(
          state.clients
            .filter((r: any) => own(r) && !r.deleted_at)
            .slice(offset, offset + limit),
        );
      }
      throw Error("Unhandled controlled SQL " + text);
    },
  };
  let queue = Promise.resolve();
  const write = async (t: string, work: any) => {
    const previous = queue;
    let done!: () => void;
    queue = new Promise<void>((r) => (done = r));
    await previous;
    const saved = structuredClone(state);
    tenant = t;
    reader = false;
    txKinds.push("writer");
    let value;
    try {
      value = await work(c);
    } catch (e) {
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, saved);
      done();
      throw e;
    }
    done();
    if (unknown) {
      unknown = false;
      throw Error("commit response lost");
    }
    return value;
  };
  const read = async (t: string, work: any) => {
    tenant = t;
    reader = true;
    txKinds.push("reader");
    try {
      return await work(c);
    } finally {
      reader = false;
    }
  };
  const security = load(source("security.ts"), {
    "node:crypto": crypto,
    "./db": { localConfig: { encryptionKey: "11".repeat(32) } },
  });
  const service = load(source("crm.ts"), {
    "./base-wire-crm-authority": load(source("base-wire-crm-authority.ts"), {"./errors": {ensure}}),
    "node:crypto": crypto,
    zod: { z },
    "./db": { tenantTx: write, tenantReadTx: read },
    "./domain": {
      audit: async (
        _c: any,
        a: any,
        action: string,
        id: string,
        detail: any,
      ) => {
        state.audits.push({ tenant_id: a.tenantId, action, id, detail });
      },
    },
    "./security": security,
    "./errors": { ensure },
    "./crm-schema": schemas,
    "./crm-field-definitions": load(source("crm-field-definitions.ts"), {
      zod: { z },
      "./errors": { ensure },
    }),
  });
  const body = (extra: any = {}) => ({ client_key: uid(next++), ...extra }),
    exec = (method: string, path: string, b: any) =>
      service.executeCrmCommand(actor, method, "/api/crm/" + path, b);
  return {
    service,
    state,
    actor,
    main,
    primary,
    body,
    exec,
    statements,
    txKinds,
    unknown: () => (unknown = true),
    journalFail: () => (journalFail = true),
  };
}
const dml = (xs: any[]) =>
  xs.filter((x) => /^(INSERT|UPDATE|DELETE)/.test(x.text));
test("profile create and partial patch preserve omitted values, zero, clear, identity and full old order snapshots", async () => {
  const f = fixture(),
    orders = structuredClone(f.state.orders),
    created = await f.exec(
      "POST",
      "clients",
      f.body({
        login: "ala",
        star: 4,
        phone: "123",
        notes: "retained",
        invoice_tax_id: "PL 123-45",
      }),
    ),
    id = created.data.id;
  assert.equal(created.data.invoice_tax_id, "PL12345");
  const changed = await f.exec(
    "PATCH",
    "clients/" + id,
    f.body({ version: 1, star: 0, phone: "" }),
  );
  assert.equal(changed.data.id, id);
  assert.equal(changed.data.star, 0);
  assert.equal(changed.data.phone, "");
  assert.equal(changed.data.notes, "retained");
  assert.equal(changed.data.login, "ala");
  assert.deepEqual(f.state.orders, orders);
});
test("lost create ACK reconciles exact immutable original via readonly transaction without recreation", async () => {
  const f = fixture(),
    b = f.body({ login: "once" });
  f.unknown();
  await assert.rejects(f.exec("POST", "clients", b), /commit response lost/);
  assert.equal(f.state.clients.length, 1);
  const at = f.statements.length,
    result = await f.service.observeCrmCommand(f.actor, {
      method: "POST",
      path: "/api/crm/clients",
      body: b,
    });
  assert.equal(result.status, "ACKNOWLEDGED");
  assert.equal(result.ack.data.id, f.state.clients[0].id);
  assert.equal(dml(f.statements.slice(at)).length, 0);
  assert.equal(f.txKinds.at(-1), "reader");
  assert.deepEqual(await f.exec("POST", "clients", b), result.ack);
  assert.equal(f.state.clients.length, 1);
});
test("journal refusal rolls back profile, field changes and audit together", async () => {
  const f = fixture(),
    saved = structuredClone(f.state);
  f.journalFail();
  await assert.rejects(
    f.exec("POST", "clients", f.body({ login: "rollback" })),
    /journal unavailable/,
  );
  assert.deepEqual(f.state, saved);
});
test("fresh role, API principal and foreign tenant cannot reuse a command or mutate", async () => {
  const f = fixture(),
    b = f.body({ login: "own" });
  await f.exec("POST", "clients", b);
  const saved = structuredClone(f.state);
  await assert.rejects(
    f.service.observeCrmCommand(
      { ...f.actor, userId: uid(999) },
      { method: "POST", path: "/api/crm/clients", body: b },
    ),
    (e: any) => e.status === 409,
  );
  await assert.rejects(
    f.service.executeCrmCommand(
      { ...f.actor, tenantId: uid(999) },
      "PATCH",
      "/api/crm/clients/" + f.state.clients[0].id,
      f.body({ version: 1, notes: "foreign" }),
    ),
    (e: any) => e.status === 404,
  );
  for (const a of [
    { ...f.actor, apiKeyId: uid(55) },
    { ...f.actor, source: "api" },
  ])
    await assert.rejects(
      f.service.executeCrmCommand(a, "POST", "/api/crm/clients", f.body()),
      (e: any) => e.status === 403,
    );
  assert.deepEqual(f.state, saved);
  f.state.role = "viewer";
  await assert.rejects(
    f.exec("POST", "clients", f.body()),
    (e: any) => e.status === 403,
  );
});
test("exact key mismatch, stale version and concurrent same original do not produce duplicate clients", async () => {
  const f = fixture(),
    b = f.body({ login: "first" }),
    [a, c] = await Promise.all([
      f.exec("POST", "clients", b),
      f.exec("POST", "clients", b),
    ]);
  assert.deepEqual(a, c);
  assert.equal(f.state.clients.length, 1);
  await assert.rejects(
    f.exec("POST", "clients", { ...b, login: "different" }),
    (e: any) => e.status === 409,
  );
  await assert.rejects(
    f.exec(
      "PATCH",
      "clients/" + a.data.id,
      f.body({ version: 2, notes: "stale" }),
    ),
    (e: any) => e.status === 409,
  );
  assert.equal(f.state.clients[0].profile.notes, "");
});
test("status deletion reassigns all and only its clients; journal failure restores entire dictionary and profiles", async () => {
  for (const failing of [false, true]) {
    const f = fixture(),
      source = uid(40),
      target = uid(41);
    for (const id of [source, target])
      f.state.statuses.push({
        id,
        tenant_id: f.actor.tenantId,
        group_id: f.main,
        name: "S",
        color: "#123456",
        version: 1,
        is_primary: false,
        position: 1,
      });
    for (const status_id of [source, source, target])
      await f.exec(
        "POST",
        "clients",
        f.body({ status_id, notes: "unchanged" }),
      );
    const before = structuredClone(f.state);
    if (failing) f.journalFail();
    const command = f.exec(
      "DELETE",
      "statuses/" + source,
      f.body({ version: 1, target_status_id: target }),
    );
    if (failing) {
      await assert.rejects(command);
      assert.deepEqual(f.state, before);
    } else {
      await command;
      assert(f.state.clients.every((r: any) => r.status_id === target));
      assert(
        f.state.clients.every((r: any) => r.profile.notes === "unchanged"),
      );
      assert.equal(f.state.clients[2].version, 1);
      assert.deepEqual(f.state.orders, before.orders);
    }
  }
});
test("primary, main, self-target and foreign target refusals have zero DML and preserve all state", async () => {
  const f = fixture(),
    source = uid(40);
  f.state.statuses.push({
    id: source,
    tenant_id: f.actor.tenantId,
    group_id: f.main,
    name: "S",
    color: "#123456",
    version: 1,
    is_primary: false,
    position: 1,
  });
  const saved = structuredClone(f.state),
    at = f.statements.length;
  for (const [path, b] of [
    ["statuses/" + f.primary, { version: 1, target_status_id: source }],
    ["status-groups/" + f.main, { version: 1 }],
    ["statuses/" + source, { version: 1, target_status_id: source }],
    ["statuses/" + source, { version: 1, target_status_id: uid(99) }],
  ] as any[])
    await assert.rejects(f.exec("DELETE", path, f.body(b)));
  assert.deepEqual(f.state, saved);
  assert.equal(dml(f.statements.slice(at)).length, 0);
});
test("group deletion moves every status to main preserving IDs, colors, profiles and order snapshots", async () => {
  const f = fixture(),
    g = uid(40);
  f.state.groups.push({
    id: g,
    tenant_id: f.actor.tenantId,
    name: "Extra",
    is_main_group: false,
    version: 1,
  });
  for (const id of [uid(41), uid(42)])
    f.state.statuses.push({
      id,
      tenant_id: f.actor.tenantId,
      group_id: g,
      name: "Owned",
      color: "#123456",
      version: 1,
      is_primary: false,
      position: 0,
    });
  const old = structuredClone(f.state.orders);
  await f.exec("DELETE", "status-groups/" + g, f.body({ version: 1 }));
  assert(f.state.statuses.every((r: any) => r.group_id === f.main));
  assert.deepEqual(
    f.state.statuses.slice(1).map((r: any) => [r.id, r.name, r.color]),
    [
      [uid(41), "Owned", "#123456"],
      [uid(42), "Owned", "#123456"],
    ],
  );
  assert.deepEqual(f.state.orders, old);
});
test("link and archive preserve whole historical order and hide archived profile", async () => {
  const f = fixture(),
    created = await f.exec("POST", "clients", f.body({ login: "profile" })),
    id = created.data.id,
    orders = structuredClone(f.state.orders);
  await f.exec(
    "POST",
    "clients/" + id + "/orders",
    f.body({ version: 1, order_id: uid(8) }),
  );
  await f.exec("DELETE", "clients/" + id, f.body({ version: 2 }));
  assert.deepEqual(f.state.orders, orders);
  assert.equal(f.state.links[0].order_id, uid(8));
  await assert.rejects(
    f.service.getCrmClient(f.actor, id, {}),
    (e: any) => e.status === 404,
  );
});
test("typed file is encrypted, journal contains exact digest rather than plaintext bytes, detail opt-in and clear revoke download", async () => {
  const f = fixture(),
    field = uid(60),
    text = uid(61);
  f.state.fields.push(
    {
      id: field,
      tenant_id: f.actor.tenantId,
      editor_type: "file",
      options: [],
    },
    { id: text, tenant_id: f.actor.tenantId, editor_type: "text", options: [] },
  );
  const base64 = Buffer.from("%PDF-1.7\nprivate-document").toString("base64"),
    b = f.body({
      custom_extra_fields: {
        [field]: { title: "umowa.pdf", file: "data:" + base64 },
        [text]: "retained",
      },
    }),
    created = await f.exec("POST", "clients", b),
    id = created.data.id;
  assert(!JSON.stringify(f.state.files).includes(base64));
  assert(!JSON.stringify(f.state.commands).includes(base64));
  assert.equal(
    f.state.commands[0].request.body.custom_extra_fields[field].file.sha256
      .length,
    64,
  );
  const ordinary = await f.service.getCrmClient(f.actor, id, {});
  assert(!Object.hasOwn(ordinary.data, "custom_extra_fields"));
  const detail = await f.service.getCrmClient(f.actor, id, {
    include_custom_extra_fields: "true",
  });
  assert.deepEqual(detail.data.custom_extra_fields[field], {
    title: "umowa.pdf",
    url: `/api/crm/clients/${id}/files/${field}`,
  });
  const file = await f.service.getCrmFile(f.actor, id, field);
  assert.equal(file.bytes.toString(), "%PDF-1.7\nprivate-document");
  await f.exec(
    "PATCH",
    "clients/" + id,
    f.body({ version: 1, custom_extra_fields: { [field]: "" } }),
  );
  await assert.rejects(
    f.service.getCrmFile(f.actor, id, field),
    (e: any) => e.status === 404,
  );
  assert.equal(
    f.state.values.find((r: any) => r.field_id === text).value,
    "retained",
  );
});
test("list never includes notes/custom values and unknown observation is read only", async () => {
  const f = fixture();
  await f.exec("POST", "clients", f.body({ notes: "private" }));
  const result = await f.service.listCrmClients(f.actor, {});
  assert(!Object.hasOwn(result.data[0], "notes"));
  assert(!Object.hasOwn(result.data[0], "custom_extra_fields"));
  const at = f.statements.length;
  assert.deepEqual(
    await f.service.observeCrmCommand(f.actor, {
      method: "POST",
      path: "/api/crm/clients",
      body: f.body(),
    }),
    { status: "NOT_OBSERVED", automatic_retry: false },
  );
  assert.equal(dml(f.statements.slice(at)).length, 0);
});

test("normal group/status create, patch omissions and append ordering preserve identities and group assignment", async () => {
  const f = fixture(),
    g = (await f.exec("POST", "status-groups", f.body({ name: "Sprzedaż" })))
      .data;
  const edited = (
    await f.exec(
      "PATCH",
      "status-groups/" + g.id,
      f.body({ version: 1, name: "Aktywni" }),
    )
  ).data;
  assert.equal(edited.id, g.id);
  assert.equal(edited.name, "Aktywni");
  const a = (
      await f.exec(
        "POST",
        "statuses",
        f.body({ name: "Pierwszy", color: "#123456", group_id: g.id }),
      )
    ).data,
    b = (
      await f.exec(
        "POST",
        "statuses",
        f.body({ name: "Drugi", color: "#654321", group_id: g.id }),
      )
    ).data;
  assert.equal(b.position, a.position + 1);
  const changed = (
    await f.exec(
      "PATCH",
      "statuses/" + a.id,
      f.body({ version: 1, name: "Nowa nazwa" }),
    )
  ).data;
  assert.equal(changed.group_id, g.id);
  assert.equal(changed.color, a.color);
  assert.equal(changed.id, a.id);
  const main = (
    await f.exec(
      "POST",
      "statuses",
      f.body({ name: "Domyślny", color: "#123456" }),
    )
  ).data;
  assert.equal(main.group_id, f.main);
});
test("mixed-case UUID self-target is refused before DML and command lookup hashes exact original body", async () => {
  const f = fixture(),
    id = "aa000000-0000-4000-8000-000000000040";
  f.state.statuses.push({
    id,
    tenant_id: f.actor.tenantId,
    group_id: f.main,
    name: "S",
    color: "#123456",
    version: 1,
    is_primary: false,
    position: 1,
  });
  const saved = structuredClone(f.state),
    at = f.statements.length;
  await assert.rejects(
    f.exec(
      "DELETE",
      "statuses/" + id.toUpperCase(),
      f.body({ version: 1, target_status_id: id }),
    ),
    (e: any) => e.status === 422,
  );
  assert.deepEqual(f.state, saved);
  assert.equal(dml(f.statements.slice(at)).length, 0);
});
test("foreign or unknown field rejects entire profile mutation and no archived or foreign file is disclosed", async () => {
  const f = fixture(),
    saved = structuredClone(f.state);
  await assert.rejects(
    f.exec(
      "POST",
      "clients",
      f.body({ custom_extra_fields: { [uid(909)]: "foreign" } }),
    ),
    (e: any) => e.status === 422,
  );
  assert.deepEqual(f.state, saved);
  const created = await f.exec("POST", "clients", f.body());
  await assert.rejects(
    f.service.getCrmFile(
      { ...f.actor, tenantId: uid(888) },
      created.data.id,
      uid(909),
    ),
    (e: any) => e.status === 404,
  );
});

test("PostgreSQL NUL and oversized UTF-8 profile inputs are controlled refusals with full rollback", async () => {
  const f = fixture(),
    saved = structuredClone(f.state);
  await assert.rejects(
    f.exec("POST", "clients", f.body({ notes: "bad\0input" })),
  );
  assert.deepEqual(f.state, saved);
  await assert.rejects(
    f.exec(
      "POST",
      "clients",
      f.body({ notes: "漢".repeat(20000), invoice_company: "漢".repeat(500) }),
    ),
    (e: any) => e.status === 422,
  );
  assert.deepEqual(f.state, saved);
});

test("historical receipt integrity, resource identity, version and original content are checked without reading mutable current rows", async () => {
  for (const corrupt of [
    (r: any) => (r.response.data.id = uid(800)),
    (r: any) => (r.response.data.version = 99),
    (r: any) => (r.response.data.notes = "corrupt"),
  ]) {
    const f = fixture(),
      b = f.body({ notes: "original" }),
      created = await f.exec("POST", "clients", b);
    const patch = f.body({ version: 1, notes: "exact" });
    await f.exec("PATCH", "clients/" + created.data.id, patch);
    const row = f.state.commands[1];
    corrupt(row);
    const at = f.statements.length;
    await assert.rejects(
      f.service.observeCrmCommand(f.actor, {
        method: "PATCH",
        path: "/api/crm/clients/" + created.data.id,
        body: patch,
      }),
      (e: any) => e.status === 503,
    );
    assert.equal(dml(f.statements.slice(at)).length, 0);
  }
  const f = fixture(),
    b = f.body({ notes: "creation" }),
    ack = await f.exec("POST", "clients", b),
    id = ack.data.id;
  await f.exec(
    "PATCH",
    "clients/" + id,
    f.body({ version: 1, notes: "new current value" }),
  );
  await f.exec("DELETE", "clients/" + id, f.body({ version: 2 }));
  const at = f.statements.length;
  const observed = await f.service.observeCrmCommand(f.actor, {
    method: "POST",
    path: "/api/crm/clients",
    body: b,
  });
  assert.deepEqual(observed.ack, ack);
  assert(
    f.statements
      .slice(at)
      .every((q: any) => !q.text.includes("FROM crm_clients")),
  );
});
test("semantic receipt validation rejects a rehashed ACK bound to another resource, stale CAS version or wrong provided field", async () => {
  const stable = (x: any): any =>
    Array.isArray(x)
      ? x.map(stable)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, stable(x[k])]),
          )
        : x;
  for (const corrupt of [
    (r: any) => (r.response.data.id = uid(900)),
    (r: any) => (r.response.data.version = 42),
    (r: any) => (r.response.data.notes = "not requested"),
  ]) {
    const f = fixture(),
      created = await f.exec("POST", "clients", f.body()),
      body = f.body({ version: 1, notes: "requested" });
    await f.exec("PATCH", "clients/" + created.data.id, body);
    const row = f.state.commands[1];
    corrupt(row);
    row.request.response_sha256 = crypto
      .createHash("sha256")
      .update(JSON.stringify(stable(row.response)))
      .digest("hex");
    await assert.rejects(
      f.service.observeCrmCommand(f.actor, {
        method: "PATCH",
        path: "/api/crm/clients/" + created.data.id,
        body,
      }),
      (e: any) => e.status === 503,
    );
  }
});

test("arbitrary private CSV and ZIP attachments roundtrip encrypted bytes with octet-stream fallback", async () => {
  for (const [title, bytes] of [
    ["dane.csv", Buffer.from("id,nazwa\n1,Łódź\n")],
    ["archiwum.zip", Buffer.from([80, 75, 3, 4, 0, 1, 2, 3])],
  ] as const) {
    const f = fixture(),
      field = uid(60);
    f.state.fields.push({
      id: field,
      tenant_id: f.actor.tenantId,
      editor_type: "file",
      options: [],
    });
    const c = (
      await f.exec(
        "POST",
        "clients",
        f.body({
          custom_extra_fields: {
            [field]: { title, file: "data:" + bytes.toString("base64") },
          },
        }),
      )
    ).data;
    const download = await f.service.getCrmFile(f.actor, c.id, field);
    assert.equal(download.mime_type, "application/octet-stream");
    assert.deepEqual(download.bytes, bytes);
    assert(
      !f.state.files[0].encrypted_bytes.includes(bytes.toString("base64")),
    );
  }
});

test("durable cancellation before original prevents late creation and observe returns same immutable tombstone", async () => {
  const f = fixture(),
    body = f.body({ login: "must not create" }),
    request = { method: "POST", path: "/api/crm/clients", body },
    cancel = await f.service.cancelCrmCommand(f.actor, request);
  assert.deepEqual(cancel, {
    status: "CRM_COMMAND_CANCELLED",
    client_key: body.client_key,
    method: "POST",
    path: "/api/crm/clients",
    automatic_retry: false,
  });
  assert.deepEqual(await f.exec("POST", "clients", body), cancel);
  assert.deepEqual(
    (await f.service.observeCrmCommand(f.actor, request)).ack,
    cancel,
  );
  assert.equal(f.state.clients.length, 0);
  assert.equal(f.state.commands.length, 1);
  assert.equal(f.state.audits.length, 1);
});
test("original before cancel returns historical original ACK and never undoes healthy current profile", async () => {
  const f = fixture(),
    body = f.body({ notes: "original" }),
    ack = await f.exec("POST", "clients", body);
  await f.exec(
    "PATCH",
    "clients/" + ack.data.id,
    f.body({ version: 1, notes: "healthy new value" }),
  );
  const before = structuredClone(f.state),
    at = f.statements.length;
  assert.deepEqual(
    await f.service.cancelCrmCommand(f.actor, {
      method: "POST",
      path: "/api/crm/clients",
      body,
    }),
    ack,
  );
  assert.deepEqual(f.state, before);
  assert.equal(dml(f.statements.slice(at)).length, 0);
});
test("cancel journal refusal rolls back and rejects current IAM or different original/actor/tenant binding", async () => {
  const f = fixture(),
    body = f.body({ notes: "unknown" }),
    request = { method: "POST", path: "/api/crm/clients", body };
  f.journalFail();
  const before = structuredClone(f.state);
  await assert.rejects(
    f.service.cancelCrmCommand(f.actor, request),
    /journal unavailable/,
  );
  assert.deepEqual(f.state, before);
  const g = fixture(),
    b = g.body(),
    req = { method: "POST", path: "/api/crm/clients", body: b };
  await g.service.cancelCrmCommand(g.actor, req);
  for (const [actor, request] of [
    [{ ...g.actor, userId: uid(90) }, req],
    [g.actor, { ...req, body: { ...b, notes: "tamper" } }],
  ])
    await assert.rejects(
      g.service.cancelCrmCommand(actor, request),
      (e: any) => e.status === 409,
    );
  g.state.role = "viewer";
  await assert.rejects(
    g.service.cancelCrmCommand(g.actor, { ...req, body: g.body() }),
    (e: any) => e.status === 403,
  );
  assert.equal(g.state.clients.length, 0);
});
test("controlled concurrent cancellation/execute ordering yields one immutable result and no duplicate effect", async () => {
  for (const first of ["cancel", "execute"]) {
    const f = fixture(),
      body = f.body({ login: "race" }),
      request = { method: "POST", path: "/api/crm/clients", body };
    const cancel = () => f.service.cancelCrmCommand(f.actor, request),
      execute = () => f.exec("POST", "clients", body),
      results = await Promise.all(
        first === "cancel" ? [cancel(), execute()] : [execute(), cancel()],
      );
    assert.deepEqual(results[0], results[1]);
    assert.equal(f.state.commands.length, 1);
    assert.equal(f.state.clients.length, first === "cancel" ? 0 : 1);
  }
});
test("cancellation has tenant-local custody and lost commit ACK is observed without replay", async () => {
  const f = fixture(),
    body = f.body({ notes: "private original" }),
    request = { method: "POST", path: "/api/crm/clients", body };
  const foreign = { ...f.actor, tenantId: uid(999), userId: uid(998) };
  await f.exec("POST", "clients", body);
  assert.deepEqual(await f.service.observeCrmCommand(foreign, request), {
    status: "NOT_OBSERVED",
    automatic_retry: false,
  });
  const oldClient = structuredClone(f.state.clients);
  const cancelled = await f.service.cancelCrmCommand(foreign, request);
  assert.equal(cancelled.status, "CRM_COMMAND_CANCELLED");
  assert.deepEqual(f.state.clients, oldClient);
  assert.equal(f.state.commands.length, 2);
  assert.equal(
    (await f.service.observeCrmCommand(f.actor, request)).ack.data.id,
    oldClient[0].id,
  );
  const g = fixture(),
    original = { method: "POST", path: "/api/crm/clients", body: g.body() };
  g.unknown();
  await assert.rejects(
    g.service.cancelCrmCommand(g.actor, original),
    /commit response lost/,
  );
  const saved = structuredClone(g.state),
    at = g.statements.length;
  const observed = await g.service.observeCrmCommand(g.actor, original);
  assert.equal(observed.status, "ACKNOWLEDGED");
  assert.equal(observed.ack.status, "CRM_COMMAND_CANCELLED");
  assert.deepEqual(g.state, saved);
  assert.equal(dml(g.statements.slice(at)).length, 0);
});

test("217 creates all seven definition types, normalizes options, and older215 remains usable with editor absent", async () => {
  const f = fixture();
  for (const type of [
    "text",
    "number",
    "select",
    "checkbox",
    "radio",
    "date",
    "file",
  ]) {
    const ack = await f.exec(
      "POST",
      "field-definitions",
      f.body({
        name: " " + type + " ",
        editor_type: type,
        options: ["select", "checkbox", "radio"].includes(type)
          ? [" A ", "B"]
          : [],
      }),
    );
    assert.equal(ack.data.editor_type, type);
    assert.equal(ack.data.version, 1);
    assert.equal(ack.data.archived, false);
    assert.equal(ack.data.position, f.state.fields.length - 1);
  }
  const defs = await f.service.getCrmDictionaries(f.actor, "fields");
  assert.equal(defs.policy.definition_editor_available, true);
  assert.equal(defs.data.length, 7);
  f.state.definitionsInstalled = false;
  const legacy = await f.service.getCrmDictionaries(f.actor, "fields");
  assert.equal(legacy.policy.definition_editor_available, false);
  assert(!Object.hasOwn(legacy.data[0], "version"));
  const before = structuredClone(f.state),
    at = f.statements.length;
  await assert.rejects(
    f.exec(
      "POST",
      "field-definitions",
      f.body({ name: "No schema", editor_type: "text" }),
    ),
    (e: any) => e.status === 503,
  );
  assert.deepEqual(f.state, before);
  assert.equal(dml(f.statements.slice(at)).length, 0);
  assert(
    (await f.exec("POST", "clients", f.body({ login: "legacy215" }))).data.id,
  );
});
test("217 definition CAS, rename and atomic reordering preserve all customer values and unrelated historical rows", async () => {
  const f = fixture(),
    one = (
      await f.exec(
        "POST",
        "field-definitions",
        f.body({ name: "One", editor_type: "text" }),
      )
    ).data,
    two = (
      await f.exec(
        "POST",
        "field-definitions",
        f.body({ name: "Two", editor_type: "text" }),
      )
    ).data,
    three = (
      await f.exec(
        "POST",
        "field-definitions",
        f.body({ name: "Three", editor_type: "text" }),
      )
    ).data;
  const client = (
      await f.exec(
        "POST",
        "clients",
        f.body({ custom_extra_fields: { [one.id]: "old" } }),
      )
    ).data,
    values = structuredClone(f.state.values),
    orders = structuredClone(f.state.orders);
  const renamed = (
    await f.exec(
      "PATCH",
      "field-definitions/" + one.id,
      f.body({ version: 1, name: "Renamed" }),
    )
  ).data;
  assert.equal(renamed.id, one.id);
  assert.equal(renamed.position, 0);
  const moved = (
    await f.exec(
      "PATCH",
      "field-definitions/" + three.id,
      f.body({ version: 1, position: 0 }),
    )
  ).data;
  assert.equal(moved.position, 0);
  assert.deepEqual(
    f.state.fields
      .toSorted((a: any, b: any) => a.position - b.position)
      .map((r: any) => r.id),
    [three.id, one.id, two.id],
  );
  assert.equal(f.state.fields.find((r: any) => r.id === one.id).version, 3);
  assert.deepEqual(f.state.values, values);
  assert.deepEqual(f.state.orders, orders);
  assert.equal(
    (
      await f.service.getCrmClient(f.actor, client.id, {
        include_custom_extra_fields: "true",
      })
    ).data.custom_extra_fields[one.id],
    "old",
  );
  const before = structuredClone(f.state);
  await assert.rejects(
    f.exec(
      "PATCH",
      "field-definitions/" + one.id,
      f.body({ version: 2, name: "stale" }),
    ),
    (e: any) => e.status === 409,
  );
  assert.deepEqual(f.state, before);
  await assert.rejects(
    f.exec(
      "PATCH",
      "field-definitions/" + one.id,
      f.body({ version: 3, editor_type: "number" }),
    ),
  );
  assert.deepEqual(f.state, before);
});
test("217 cannot remove options already used by any own client and rejects duplicate or incompatible options", async () => {
  const f = fixture();
  for (const type of ["select", "radio", "checkbox"]) {
    const field = (
      await f.exec(
        "POST",
        "field-definitions",
        f.body({ name: type, editor_type: type, options: ["A", "B"] }),
      )
    ).data;
    await f.exec(
      "POST",
      "clients",
      f.body({
        custom_extra_fields: { [field.id]: type === "checkbox" ? ["B"] : "B" },
      }),
    );
    const before = structuredClone(f.state);
    await assert.rejects(
      f.exec(
        "PATCH",
        "field-definitions/" + field.id,
        f.body({ version: 1, options: ["A"] }),
      ),
      (e: any) => e.status === 422,
    );
    assert.deepEqual(f.state, before);
    const ack = await f.exec(
      "PATCH",
      "field-definitions/" + field.id,
      f.body({ version: 1, options: ["B", "A", "C"] }),
    );
    assert.deepEqual(ack.data.options, ["B", "A", "C"]);
  }
  for (const b of [
    { name: "Duplicate", editor_type: "select", options: ["A", " A "] },
    { name: "Text", editor_type: "text", options: ["A"] },
    { name: "Empty", editor_type: "radio", options: [] },
  ])
    await assert.rejects(f.exec("POST", "field-definitions", f.body(b)));
});
test("217 archive and restore keep whole encrypted file/value/customer/order state; archived values refuse writes but download still works", async () => {
  const f = fixture(),
    field = (
      await f.exec(
        "POST",
        "field-definitions",
        f.body({ name: "Archive file", editor_type: "file" }),
      )
    ).data,
    bytes = Buffer.from("archive,preserve\n1,Łódź"),
    client = (
      await f.exec(
        "POST",
        "clients",
        f.body({
          custom_extra_fields: {
            [field.id]: {
              title: "keep.csv",
              file: "data:" + bytes.toString("base64"),
            },
          },
        }),
      )
    ).data;
  const preserved = structuredClone({
    clients: f.state.clients,
    values: f.state.values,
    files: f.state.files,
    orders: f.state.orders,
  });
  const archived = (
    await f.exec(
      "PATCH",
      "field-definitions/" + field.id,
      f.body({ version: 1, archived: true }),
    )
  ).data;
  assert.equal(archived.archived, true);
  assert.deepEqual(
    {
      clients: f.state.clients,
      values: f.state.values,
      files: f.state.files,
      orders: f.state.orders,
    },
    preserved,
  );
  assert.deepEqual(
    (await f.service.getCrmFile(f.actor, client.id, field.id)).bytes,
    bytes,
  );
  const before = structuredClone(f.state);
  await assert.rejects(
    f.exec(
      "PATCH",
      "clients/" + client.id,
      f.body({
        version: client.version,
        custom_extra_fields: { [field.id]: "" },
      }),
    ),
    (e: any) => e.status === 409,
  );
  assert.deepEqual(f.state, before);
  await assert.rejects(
    f.service.getCrmFile(
      { ...f.actor, tenantId: uid(987) },
      client.id,
      field.id,
    ),
    (e: any) => e.status === 404,
  );
  const restored = (
    await f.exec(
      "PATCH",
      "field-definitions/" + field.id,
      f.body({ version: 2, archived: false }),
    )
  ).data;
  assert.equal(restored.archived, false);
  assert.deepEqual(
    {
      clients: f.state.clients,
      values: f.state.values,
      files: f.state.files,
      orders: f.state.orders,
    },
    preserved,
  );
});
test("217 original command custody handles lost ACK, cancelled-before-create and historical replay after later edit", async () => {
  const f = fixture(),
    body = f.body({ name: "Unknown", editor_type: "text" }),
    request = { method: "POST", path: "/api/crm/field-definitions", body };
  f.unknown();
  await assert.rejects(
    f.exec("POST", "field-definitions", body),
    /commit response lost/,
  );
  const observed = await f.service.observeCrmCommand(f.actor, request);
  assert.equal(observed.status, "ACKNOWLEDGED");
  const ack = observed.ack;
  assert.equal(ack.data.version, 1);
  await f.exec(
    "PATCH",
    "field-definitions/" + ack.data.id,
    f.body({ version: 1, name: "Current" }),
  );
  assert.deepEqual(await f.exec("POST", "field-definitions", body), ack);
  assert.deepEqual(await f.service.cancelCrmCommand(f.actor, request), ack);
  assert.equal(f.state.fields[0].name, "Current");
  const cancelBody = f.body({ name: "Not delivered", editor_type: "file" }),
    cancelRequest = { method: "POST", path: request.path, body: cancelBody },
    cancel = await f.service.cancelCrmCommand(f.actor, cancelRequest),
    before = structuredClone(f.state);
  assert.equal(cancel.status, "CRM_COMMAND_CANCELLED");
  assert.deepEqual(
    await f.exec("POST", "field-definitions", cancelBody),
    cancel,
  );
  assert.deepEqual(f.state, before);
});
test("217 late journal failure restores all shifted definitions and revocation or foreign tenant cannot mutate them", async () => {
  const f = fixture(),
    one = (
      await f.exec(
        "POST",
        "field-definitions",
        f.body({ name: "One", editor_type: "text" }),
      )
    ).data;
  await f.exec(
    "POST",
    "field-definitions",
    f.body({ name: "Two", editor_type: "number" }),
  );
  const before = structuredClone(f.state);
  f.journalFail();
  await assert.rejects(
    f.exec(
      "POST",
      "field-definitions",
      f.body({ name: "Rollback", editor_type: "file", position: 0 }),
    ),
    /journal unavailable/,
  );
  assert.deepEqual(f.state, before);
  await assert.rejects(
    f.service.executeCrmCommand(
      { ...f.actor, tenantId: uid(999) },
      "PATCH",
      "/api/crm/field-definitions/" + one.id,
      f.body({ version: 1, name: "foreign" }),
    ),
    (e: any) => e.status === 404,
  );
  assert.deepEqual(f.state, before);
  f.state.role = "viewer";
  await assert.rejects(
    f.exec(
      "PATCH",
      "field-definitions/" + one.id,
      f.body({ version: 1, name: "revoked" }),
    ),
    (e: any) => e.status === 403,
  );
});

test("217 same-version concurrent edits have one winner and rehashed forged field ACK is refused", async () => {
  const f = fixture(),
    body = f.body({
      name: "Bound type",
      editor_type: "select",
      options: ["A", "B"],
    }),
    request = { method: "POST", path: "/api/crm/field-definitions", body },
    created = (await f.exec("POST", "field-definitions", body)).data;
  const raced = await Promise.allSettled([
    f.exec(
      "PATCH",
      "field-definitions/" + created.id,
      f.body({ version: 1, name: "First" }),
    ),
    f.exec(
      "PATCH",
      "field-definitions/" + created.id,
      f.body({ version: 1, name: "Second" }),
    ),
  ]);
  assert.equal(raced.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    (raced.find((x) => x.status === "rejected") as PromiseRejectedResult).reason
      .status,
    409,
  );
  assert.equal(f.state.fields[0].version, 2);
  const canonical = (x: any): any =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, canonical(x[k])]),
          )
        : x;
  for (const change of [
    (r: any) => (r.data.id = "invalid-uuid"),
    (r: any) => (r.data.editor_type = "text"),
    (r: any) => (r.data.version = 4),
    (r: any) => (r.data.options = ["A"]),
  ]) {
    const command = f.state.commands[0],
      saved = structuredClone(command.response);
    change(command.response);
    command.request.response_sha256 = crypto
      .createHash("sha256")
      .update(JSON.stringify(canonical(command.response)))
      .digest("hex");
    await assert.rejects(
      f.service.observeCrmCommand(f.actor, request),
      (e: any) => e.status === 503,
    );
    command.response = saved;
    command.request.response_sha256 = crypto
      .createHash("sha256")
      .update(JSON.stringify(canonical(saved)))
      .digest("hex");
  }
  assert.equal(
    (await f.service.observeCrmCommand(f.actor, request)).ack.data.version,
    1,
  );
  const patch = f.state.commands.find((r: any) => r.request.method === "PATCH"),
    patchOriginal = {
      method: patch.request.method,
      path: patch.request.path,
      body: patch.request.body,
    };
  patch.response.data.id = uid(999);
  patch.request.response_sha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(patch.response)))
    .digest("hex");
  await assert.rejects(
    f.service.observeCrmCommand(f.actor, patchOriginal),
    (e: any) => e.status === 503,
  );
});

test("definition reads and writes use same-snapshot catalog capability while dyna_app cannot read migrations", async () => {
  const f = fixture();
  const created = await f.exec(
    "POST",
    "field-definitions",
    f.body({ name: "Nowe pole", editor_type: "text", options: [] }),
  );
  const read = await f.service.getCrmDictionaries(f.actor, "fields");
  assert.equal(read.policy.definition_editor_available, true);
  assert.equal(read.data[0].extra_field_id, created.data.id);
  const detection = f.statements.filter((q) =>
    q.text.includes("FROM pg_catalog.pg_attribute"),
  );
  assert(detection.length >= 2);
  for (const q of detection) {
    assert(q.text.includes("public.crm_extra_fields"));
    assert(
      q.text.includes("'pg_catalog.int4'::pg_catalog.regtype AND attnotnull"),
    );
    assert(
      q.text.includes(
        "'pg_catalog.timestamptz'::pg_catalog.regtype AND NOT attnotnull",
      ),
    );
    assert(q.text.includes("attnum>0 AND NOT attisdropped"));
  }
  assert(
    !f.statements.some((q) =>
      /\b(?:FROM|JOIN)\s+(?:public\.)?migrations\b/i.test(q.text),
    ),
  );
});
test("partial, malformed or wrong-type217 capability refuses read and mutation without journal effects", async () => {
  for (const metadata of [
    {
      version_present: true,
      archive_present: false,
      version_valid: true,
      archive_valid: false,
    },
    {
      version_present: false,
      archive_present: true,
      version_valid: false,
      archive_valid: true,
    },
    {
      version_present: true,
      archive_present: true,
      version_valid: false,
      archive_valid: true,
    },
    {
      version_present: true,
      archive_present: true,
      version_valid: true,
      archive_valid: false,
    },
    {
      version_present: true,
      archive_present: true,
      version_valid: "true",
      archive_valid: true,
    },
    {
      version_present: true,
      archive_present: true,
      version_valid: true,
      archive_valid: true,
      extra: true,
    },
    {
      version_present: false,
      archive_present: false,
      version_valid: true,
      archive_valid: false,
    },
  ]) {
    const f = fixture();
    f.state.definitionsMetadata = metadata;
    const before = structuredClone(f.state);
    await assert.rejects(
      f.service.getCrmDictionaries(f.actor, "fields"),
      (e: any) => e.status === 503,
    );
    await assert.rejects(
      f.exec(
        "POST",
        "field-definitions",
        f.body({ name: "Nie zapisuj", editor_type: "text", options: [] }),
      ),
      (e: any) => e.status === 503,
    );
    assert.deepEqual(f.state, before);
    assert.equal(f.state.commands.length, 0);
    assert.equal(f.state.audits.length, 0);
  }
});
