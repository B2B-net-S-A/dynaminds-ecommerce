import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
const uuid = (n) =>
    `${n.toString(16).padStart(8, "0")}-1000-4000-8000-000000000001`,
  tenant = uuid(1),
  user = uuid(2),
  customer = uuid(3),
  mainGroup = uuid(4),
  customGroup = uuid(5),
  primary = uuid(6),
  customStatus = uuid(7),
  targetStatus = uuid(8),
  order = uuid(9),
  ctx = (p = {}) => ({
    tenantId: tenant,
    userId: user,
    admin: true,
    readOnly: false,
    externalWriteBlocked: false,
    ...p,
  });
const initialClient = (p = {}) =>
  Object.assign(
    Object.fromEntries(
      [
        "login",
        "phone",
        "email",
        "notes",
        "invoice_company",
        "invoice_fullname",
        "invoice_address",
        "invoice_postcode",
        "invoice_city",
        "invoice_state",
        "invoice_country_code",
        "invoice_tax_id",
        "delivery_company",
        "delivery_fullname",
        "delivery_address",
        "delivery_postcode",
        "delivery_city",
        "delivery_state",
        "delivery_country_code",
      ].map((k) => [k, ""]),
    ),
    {
      id: customer,
      version: 1,
      status_id: customStatus,
      star: 2,
      contractor_id: 0,
      login: "Buyer",
      email: "old@example.test",
      notes: "Private note retained",
      invoice_fullname: "Jan Klient",
      created_at: "2026-10-19T00:00:00.000Z",
      updated_at: "2026-10-19T00:00:00.000Z",
    },
    p,
  );
const fieldTypes = [
    "text",
    "number",
    "select",
    "checkbox",
    "radio",
    "date",
    "file",
  ],
  names = ["Opis", "Obrót", "Segment", "Zgody", "Kontakt", "Rocznica", "Umowa"];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const memory = () => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
};
test("CRM actual React profile, dictionaries, typed values, private files and durable command flows", async (t) => {
  const dom = new JSDOM("<html><body></body></html>", {
      url: "http://localhost:4105",
    }),
    prior = {};
  for (const k of [
    "window",
    "document",
    "navigator",
    "localStorage",
    "sessionStorage",
    "HTMLElement",
    "HTMLFormElement",
    "HTMLInputElement",
    "FormData",
    "Event",
    "CustomEvent",
    "StorageEvent",
  ]) {
    prior[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, {
      configurable: true,
      value: dom.window[k],
      writable: true,
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let tails = new Map();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (key, _o, fn) => {
        const next = (tails.get(key) ?? Promise.resolve())
          .catch(() => {})
          .then(fn);
        tails.set(
          key,
          next.catch(() => {}),
        );
        return next;
      },
    },
  });
  const vite = await createServer({
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
      logLevel: "error",
    }),
    { createRoot } = await import("react-dom/client"),
    { CrmWorkspace } = await vite.ssrLoadModule(path.resolve("web/crm.tsx")),
    custody = await vite.ssrLoadModule(path.resolve("web/crm-commands.ts")),
    schema = await vite.ssrLoadModule(path.resolve("server/crm-schema.ts")),
    fieldsSchema = await vite.ssrLoadModule(
      path.resolve("server/crm-field-definitions.ts"),
    ),
    api = await vite.ssrLoadModule(path.resolve("web/api.ts"));
  let f;
  const originalFetch = globalThis.fetch;
  function reset() {
    f = {
      actor: ctx(),
      calls: [],
      clients: [initialClient()],
      groups: [
        { id: mainGroup, name: "Główna", is_main_group: 1, version: 1 },
        { id: customGroup, name: "VIP", is_main_group: 0, version: 1 },
      ],
      statuses: [
        {
          id: primary,
          name: "Nowy",
          color: "#112233",
          group_id: mainGroup,
          is_primary: 1,
          position: 0,
          version: 1,
        },
        {
          id: customStatus,
          name: "Stały",
          color: "#334455",
          group_id: customGroup,
          is_primary: 0,
          position: 0,
          version: 1,
        },
        {
          id: targetStatus,
          name: "Aktywny",
          color: "#556677",
          group_id: mainGroup,
          is_primary: 0,
          position: 1,
          version: 1,
        },
      ],
      fields: fieldTypes.map((editor_type, i) => ({
        extra_field_id: uuid(30 + i),
        name: names[i],
        position: i,
        version: 1,
        archived: false,
        editor_type,
        options: ["select", "checkbox", "radio"].includes(editor_type)
          ? ["A", "B"]
          : [],
      })),
      definitionEditor: false,
      values: {},
      journal: new Map(),
      orders: [
        {
          id: order,
          number: "ZAM/44",
          status: "paid",
          total: 12345,
          currency: "PLN",
          created_at: "2026-10-19T00:00:00.000Z",
          customer_name: "Jan Klient",
        },
      ],
      links: new Map(),
      lost: false,
      dropBeforeWrite: false,
      lostCancel: false,
      hold: null,
      observeHold: null,
      badAck: null,
      deny: null,
    };
    sessionStorage.clear();
    localStorage.clear();
    tails = new Map();
    api.setWorkspace(tenant);
  }
  const detail = (c, include = false) => ({
      ...structuredClone(c),
      ...(include
        ? { custom_extra_fields: structuredClone(f.values[c.id] ?? {}) }
        : {}),
    }),
    listClient = (c) =>
      Object.fromEntries(
        Object.entries(c).filter(
          ([k]) => !["notes", "custom_extra_fields"].includes(k),
        ),
      );
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url), "http://localhost:4105"),
      method = init.method ?? "GET",
      body = init.body ? JSON.parse(init.body) : null;
    f.calls.push({
      path: u.pathname,
      search: u.search,
      method,
      body,
      workspace: init.headers?.["X-Workspace-ID"],
    });
    assert(u.origin === "http://localhost:4105", "closed local component IO");
    if (u.pathname === "/api/auth/me")
      return Response.json({
        restore_preview: false,
        user: {
          tenant_id: f.actor.tenantId,
          id: f.actor.userId,
          role: f.actor.admin ? "admin" : "viewer",
        },
      });
    if (u.pathname === "/api/orders") {
      assert.equal(method, "GET");
      return Response.json({
        data: structuredClone(f.orders),
        meta: { cursor: null },
      });
    }
    assert(u.pathname.startsWith("/api/crm/"), "only CRM routes");
    const flags = { can_write: f.actor.admin, read_only: false };
    if (method === "GET") {
      if (u.pathname === "/api/crm/clients") {
        const q = schema.crmList.parse(Object.fromEntries(u.searchParams));
        let data = f.clients.filter(
          (c) =>
            (!q.status_id || c.status_id === q.status_id) &&
            (!q.search || Object.values(c).join(" ").includes(q.search)),
        );
        return Response.json({
          data: data.map(listClient),
          meta: {
            page: q.page,
            limit: q.limit,
            has_more: !!f.hasMore && q.page === 1,
          },
          ...flags,
        });
      }
      if (u.pathname === "/api/crm/status-groups")
        return Response.json({ data: structuredClone(f.groups), ...flags });
      if (u.pathname === "/api/crm/statuses")
        return Response.json({ data: structuredClone(f.statuses), ...flags });
      if (u.pathname === "/api/crm/extra-fields")
        return Response.json({
          data: structuredClone(f.fields),
          policy: {
            file_max_bytes: 2000000,
            definition_editor_available: f.definitionEditor,
          },
          ...flags,
        });
      const id = u.pathname.split("/")[4];
      if (u.pathname.endsWith("/orders")) {
        const q = schema.crmOrderPage.parse(Object.fromEntries(u.searchParams));
        const links = f.links.get(id) ?? [];
        return Response.json({
          data: links.map((id) =>
            Object.fromEntries(
              Object.entries(f.orders.find((o) => o.id === id)).filter(
                ([k]) => k !== "customer_name",
              ),
            ),
          ),
          meta: {
            cursor: f.historyMore && !q.after ? "firstpagecursor" : null,
            has_more: !!f.historyMore && !q.after,
          },
          read_only: false,
        });
      }
      if (u.pathname.includes("/files/"))
        return new Response(Buffer.from("%PDF-private"), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": "attachment",
          },
        });
      schema.crmDetail.parse(Object.fromEntries(u.searchParams));
      if (f.detailHold) return f.detailHold.promise;
      const c = f.clients.find((c) => c.id === id);
      return c
        ? Response.json({
            data: detail(
              c,
              u.searchParams.get("include_custom_extra_fields") === "true",
            ),
            ...flags,
          })
        : Response.json({ detail: "Nie znaleziono klienta" }, { status: 404 });
    }
    const observed = u.pathname === "/api/crm/commands/observe";
    if (observed) {
      schema.crmObserve.parse(body);
      const ack = f.journal.get(body.body.client_key);
      if (f.observeHold) return f.observeHold.promise;
      return Response.json(
        ack
          ? { status: "ACKNOWLEDGED", ack }
          : { status: "NOT_OBSERVED", automatic_retry: false },
      );
    }
    if (u.pathname === "/api/crm/commands/cancel") {
      schema.crmObserve.parse(body);
      const original = custody.readCrmCommand(
        sessionStorage,
        localStorage,
        ctx(),
      );
      assert.deepEqual(body, {
        method: original.method,
        path: original.path,
        body: original.body,
      });
      const ack = f.journal.get(body.body.client_key) ?? {
        status: "CRM_COMMAND_CANCELLED",
        client_key: body.body.client_key,
        method: body.method,
        path: body.path,
        automatic_retry: false,
      };
      f.journal.set(body.body.client_key, ack);
      if (f.lostCancel) throw Error("Lost original cancellation response");
      return Response.json(ack);
    }
    assert(["POST", "PATCH", "DELETE"].includes(method));
    const m = custody.readCrmCommand(sessionStorage, localStorage, ctx());
    assert(m, "original durable intent before request");
    assert.deepEqual(m.body, body);
    assert.equal(m.path, u.pathname);
    assert.equal(m.method, method);
    assert.equal(m.phase, "sent");
    if (f.dropBeforeWrite) throw Error("Request did not reach the service");
    const resource = u.pathname.split("/")[3],
      id = u.pathname.split("/")[4],
      isLink = u.pathname.endsWith("/orders"),
      parser =
        resource === "field-definitions"
          ? method === "POST"
            ? fieldsSchema.crmFieldCreate
            : fieldsSchema.crmFieldPatch
          : isLink
            ? schema.crmLink
            : resource === "clients"
              ? method === "POST"
                ? schema.crmCreate
                : method === "PATCH"
                  ? schema.crmPatch
                  : schema.crmDelete
              : resource === "statuses"
                ? method === "POST"
                  ? schema.crmStatusCreate
                  : method === "PATCH"
                    ? schema.crmStatusPatch
                    : schema.crmStatusDelete
                : method === "POST"
                  ? schema.crmGroupCreate
                  : method === "PATCH"
                    ? schema.crmGroupPatch
                    : schema.crmDelete;
    parser.parse(body);
    if (f.deny)
      return Response.json({ detail: "Zmiana odrzucona" }, { status: f.deny });
    let data;
    if (resource === "clients") {
      if (method === "POST" && !isLink) {
        data = initialClient({
          ...Object.fromEntries(
            Object.entries(body).filter(([k]) => k !== "client_key"),
          ),
          id: uuid(100 + f.clients.length),
          version: 1,
        });
        f.clients.push(data);
      } else {
        const c = f.clients.find((c) => c.id === id);
        assert(c);
        assert.equal(c.version, body.version);
        if (method === "DELETE") {
          f.clients = f.clients.filter((c) => c.id !== id);
          data = { id, deleted: true };
        } else {
          if (isLink) {
            const ids = f.links.get(id) ?? [];
            if (!ids.includes(body.order_id)) ids.push(body.order_id);
            f.links.set(id, ids);
          } else
            for (const [k, v] of Object.entries(body))
              if (!["client_key", "version", "custom_extra_fields"].includes(k))
                c[k] = v;
          if (body.custom_extra_fields) {
            const values = (f.values[id] ??= {});
            for (const [k, v] of Object.entries(body.custom_extra_fields)) {
              if (v === "") delete values[k];
              else
                values[k] = v?.file
                  ? { title: v.title, url: `/api/crm/clients/${id}/files/${k}` }
                  : structuredClone(v);
            }
          }
          c.version++;
          data = detail(c);
        }
      }
    } else if (resource === "field-definitions") {
      const parsed = parser.parse(body);
      if (method === "POST") {
        const row = {
          extra_field_id: uuid(200 + f.fields.length),
          name: parsed.name,
          editor_type: parsed.editor_type,
          options: parsed.options,
          position: parsed.position ?? f.fields.length,
          version: 1,
          archived: false,
        };
        f.fields.push(row);
        const { extra_field_id, ...rest } = row;
        data = { id: extra_field_id, ...rest };
      } else {
        const row = f.fields.find((r) => r.extra_field_id === id);
        assert(row);
        assert.equal(row.version, parsed.version);
        for (const key of ["name", "options", "position", "archived"])
          if (Object.hasOwn(parsed, key)) row[key] = parsed[key];
        row.version++;
        const { extra_field_id, ...rest } = row;
        data = { id: extra_field_id, ...rest };
      }
    } else if (resource === "status-groups") {
      if (method === "POST") {
        data = {
          id: uuid(120 + f.groups.length),
          name: body.name,
          is_main_group: 0,
          version: 1,
        };
        f.groups.push(data);
      } else {
        const g = f.groups.find((g) => g.id === id);
        assert((g && !g.is_main_group) || method === "PATCH");
        if (method === "DELETE") {
          f.groups = f.groups.filter((g) => g.id !== id);
          for (const s of f.statuses)
            if (s.group_id === id) {
              s.group_id = mainGroup;
              s.version++;
            }
          data = { id, deleted: true };
        } else {
          g.name = body.name;
          g.version++;
          data = g;
        }
      }
    } else {
      if (method === "POST") {
        data = {
          id: uuid(150 + f.statuses.length),
          name: body.name,
          color: body.color,
          group_id: body.group_id ?? mainGroup,
          is_primary: 0,
          position: 99,
          version: 1,
        };
        f.statuses.push(data);
      } else {
        const s = f.statuses.find((s) => s.id === id);
        assert(s);
        if (method === "DELETE") {
          assert(!s.is_primary && body.target_status_id !== id);
          f.statuses = f.statuses.filter((s) => s.id !== id);
          for (const c of f.clients)
            if (c.status_id === id) {
              c.status_id = body.target_status_id;
              c.version++;
            }
          data = { id, deleted: true };
        } else {
          for (const k of ["name", "color", "group_id"])
            if (Object.hasOwn(body, k)) s[k] = body[k];
          s.version++;
          data = s;
        }
      }
    }
    const ack = { data: structuredClone(data) };
    f.journal.set(body.client_key, ack);
    if (f.hold) return f.hold.promise;
    if (f.lost) throw Error("Lost ACK after commit");
    return Response.json(f.badAck ?? ack, {
      status: method === "POST" ? 201 : 200,
    });
  };
  const tick = async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    until = async (predicate) => {
      for (let n = 0; n < 100; n++) {
        if (predicate()) return;
        await tick();
      }
      assert(predicate(), "controlled UI condition");
    },
    button = (h, name) =>
      [...h.el.querySelectorAll("button")].find((b) => b.textContent === name),
    label = (h, text) =>
      [...h.el.querySelectorAll("label")]
        .find(
          (l) =>
            [...l.childNodes]
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent)
              .join("")
              .trim() === text,
        )
        ?.querySelector("input,select,textarea");
  async function mount(context = ctx()) {
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el),
      h = { el, root };
    h.render = async (c) => {
      await act(async () =>
        root.render(React.createElement(CrmWorkspace, { context: c })),
      );
    };
    h.close = async () => {
      await act(async () => root.unmount());
      el.remove();
    };
    await h.render(context);
    await until(
      () => !!button(h, "Nowy klient") || !!h.el.querySelector("[role=alert]"),
    );
    return h;
  }
  async function click(h, name) {
    const b = button(h, name);
    assert(b, name);
    assert.equal(b.disabled, false, name + " enabled");
    await act(async () => b.click());
  }
  async function submit(form) {
    assert(form);
    await act(async () =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
  }
  const writeCalls = () =>
      f.calls.filter((x) => x.method !== "GET" && !x.path.endsWith("/observe")),
    journal = () => custody.readCrmCommand(sessionStorage, localStorage, ctx()),
    profileForm = (h) =>
      [...h.el.querySelectorAll("form")].find((f) =>
        f.querySelector("input[name=email]"),
      );
  async function open(h, extra = false) {
    await click(h, "Otwórz klienta");
    await until(() => !!profileForm(h));
    if (extra) {
      await click(h, "Wczytaj dodatkowe pola klienta");
      await until(() => !!button(h, "Zapisz pole Opis"));
    }
  }
  async function select(input, value) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        input.tagName === "SELECT"
          ? dom.window.HTMLSelectElement.prototype
          : dom.window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, value);
      input.dispatchEvent(
        new Event(input.tagName === "SELECT" ? "change" : "input", {
          bubbles: true,
        }),
      );
    });
  }
  try {
    await t.test(
      "217 full definition editor creates select, edits name/options/order, archives and restores without losing client values",
      async () => {
        reset();
        f.definitionEditor = true;
        f.values[customer] = { [uuid(32)]: "A" };
        const values = structuredClone(f.values),
          h = await mount();
        await click(h, "Pola dodatkowe");
        const form = [...h.el.querySelectorAll("form")].find((f) =>
          f.querySelector('input[aria-label="Nazwa nowej definicji"]'),
        );
        assert(form);
        form.querySelector("input[name=definition_name]").value = "Własne pole";
        await select(
          form.querySelector("select[name=definition_type]"),
          "select",
        );
        form.querySelector("textarea").value = "Pierwsza\nDruga";
        await submit(form);
        await until(() => !!button(h, "Zapisz definicję Własne pole"));
        let row = f.fields.find((r) => r.name === "Własne pole");
        assert.deepEqual(row.options, ["Pierwsza", "Druga"]);
        assert.equal(journal().phase, "acknowledged");
        let edit = [...h.el.querySelectorAll("form")].find((f) =>
          f.querySelector('input[aria-label="Nazwa definicji Własne pole"]'),
        );
        assert.equal(edit.querySelector("select").disabled, true);
        edit.querySelector("input[name=definition_name]").value =
          "Zmienione pole";
        edit.querySelector("input[name=definition_position]").value = "0";
        edit.querySelector("textarea").value = "Druga\nPierwsza\nTrzecia";
        await submit(edit);
        await until(() => !!button(h, "Zapisz definicję Zmienione pole"));
        row = f.fields.find((r) => r.name === "Zmienione pole");
        assert.equal(row.position, 0);
        await click(h, "Archiwizuj pole Zmienione pole");
        await until(() => !!button(h, "Przywróć pole Zmienione pole"));
        assert.equal(row.archived, true);
        assert.deepEqual(f.values, values);
        await click(h, "Przywróć pole Zmienione pole");
        await until(() => !!button(h, "Archiwizuj pole Zmienione pole"));
        assert.equal(row.archived, false);
        assert.deepEqual(f.values, values);
        await h.close();
      },
    );
    await t.test(
      "217 lost definition ACK is retained across remount and explicit observe uses the same original command",
      async () => {
        reset();
        f.definitionEditor = true;
        const h = await mount();
        await click(h, "Pola dodatkowe");
        const form = [...h.el.querySelectorAll("form")].find((f) =>
          f.querySelector('input[aria-label="Nazwa nowej definicji"]'),
        );
        form.querySelector("input[name=definition_name]").value =
          "Niepewne pole";
        f.lost = true;
        await submit(form);
        await until(() => journal()?.phase === "unknown");
        const original = structuredClone(journal()),
          creates = f.calls.filter(
            (c) =>
              c.path === "/api/crm/field-definitions" && c.method === "POST",
          ).length;
        await h.close();
        f.lost = false;
        const remount = await mount();
        await click(remount, "Odczytaj oryginalny wynik CRM");
        await until(() => journal()?.phase === "acknowledged");
        assert.equal(journal().body.client_key, original.body.client_key);
        assert.equal(
          f.calls.filter(
            (c) =>
              c.path === "/api/crm/field-definitions" && c.method === "POST",
          ).length,
          creates,
        );
        assert.equal(
          f.fields.filter((r) => r.name === "Niepewne pole").length,
          1,
        );
        await remount.close();
      },
    );
    await t.test(
      "217 archived file remains visible with download and no writable value controls",
      async () => {
        reset();
        f.definitionEditor = true;
        const field = f.fields.find((r) => r.editor_type === "file");
        field.archived = true;
        f.values[customer] = {
          [field.extra_field_id]: {
            title: "kept.csv",
            url:
              "/api/crm/clients/" + customer + "/files/" + field.extra_field_id,
          },
        };
        const h = await mount();
        await open(h, true);
        assert.equal(
          button(h, "Zapisz pole Umowa").closest("fieldset").disabled,
          true,
        );
        assert.equal(button(h, "Pobierz kept.csv").disabled, false);
        assert(h.el.textContent.includes("archiwalne"));
        assert.equal(writeCalls().length, 0);
        await h.close();
      },
    );
    await t.test(
      "217 explicit cancellation of an undelivered definition clears UNKNOWN without resending create",
      async () => {
        reset();
        f.definitionEditor = true;
        f.dropBeforeWrite = true;
        const h = await mount();
        await click(h, "Pola dodatkowe");
        const form = [...h.el.querySelectorAll("form")].find((f) =>
          f.querySelector('input[aria-label="Nazwa nowej definicji"]'),
        );
        form.querySelector("input[name=definition_name]").value =
          "Cancelled field";
        await submit(form);
        await until(() => journal()?.phase === "unknown");
        const original = structuredClone(journal()),
          before = f.fields.length;
        const consent = label(
          h,
          "Potwierdzam anulowanie niewykonanego polecenia. Wcześniejszy zapis pozostanie zachowany.",
        );
        assert(consent);
        await act(async () => consent.click());
        await click(h, "Anuluj niewykonane polecenie CRM");
        await until(() => journal()?.phase === "acknowledged");
        assert.equal(journal().ack.status, "CRM_COMMAND_CANCELLED");
        assert.equal(journal().body.client_key, original.body.client_key);
        assert.equal(f.fields.length, before);
        assert.equal(
          f.calls.filter(
            (c) =>
              c.path === "/api/crm/field-definitions" && c.method === "POST",
          ).length,
          1,
        );
        await h.close();
      },
    );
    await t.test(
      "215 legacy definition list stays available and217 writes are absent without editor capability",
      async () => {
        reset();
        const h = await mount();
        await click(h, "Pola dodatkowe");
        assert(h.el.textContent.includes("Opis"));
        assert(h.el.textContent.includes("Umowa"));
        assert(!button(h, "Dodaj definicję pola"));
        assert.equal(writeCalls().length, 0);
        await h.close();
      },
    );
    await t.test(
      "first load uses explicit page50 without empty status and detail excludes custom fields until requested",
      async () => {
        reset();
        const h = await mount();
        assert(!h.el.textContent.includes("Private note retained"));
        const first = f.calls.find((c) => c.path === "/api/crm/clients");
        assert.equal(new URLSearchParams(first.search).get("page"), "1");
        assert.equal(new URLSearchParams(first.search).has("status_id"), false);
        await open(h);
        assert.equal(
          profileForm(h).querySelector("textarea").value,
          "Private note retained",
        );
        assert(
          f.calls.some(
            (c) =>
              c.path.endsWith("/" + customer) &&
              c.search.includes("include_custom_extra_fields=false"),
          ),
        );
        assert(!button(h, "Zapisz pole Opis"));
        await h.close();
      },
    );
    await t.test(
      "create then patch only supplied fields; notes and identity survive",
      async () => {
        reset();
        const h = await mount();
        await click(h, "Nowy klient");
        const form = profileForm(h);
        form.querySelector("[name=email]").value = "new@example.test";
        form.querySelector("[name=invoice_fullname]").value = "Nowa Osoba";
        await submit(form);
        await until(
          () =>
            writeCalls().length === 1 &&
            journal().phase === "acknowledged" &&
            f.clients.length === 2,
        );
        assert.equal(writeCalls()[0].method, "POST");
        assert.equal(writeCalls()[0].body.email, "new@example.test");
        await until(
          () =>
            !!profileForm(h) &&
            profileForm(h).querySelector("[name=email]").value ===
              "new@example.test",
        );
        const id = f.clients[1].id;
        profileForm(h).querySelector("[name=phone]").value = "123456789";
        await submit(profileForm(h));
        await until(
          () => writeCalls().length === 2 && journal().phase === "acknowledged",
        );
        assert.deepEqual(Object.keys(writeCalls()[1].body).sort(), [
          "client_key",
          "phone",
          "version",
        ]);
        assert.equal(f.clients[1].id, id);
        assert.equal(f.clients[1].email, "new@example.test");
        await h.close();
      },
    );
    await t.test(
      "delete profile requires explicit confirmation and makes no order mutation",
      async () => {
        reset();
        f.links.set(customer, [order]);
        const old = structuredClone(f.orders),
          h = await mount();
        await open(h);
        assert.equal(button(h, "Usuń profil klienta").disabled, true);
        await act(async () => {
          label(h, "Potwierdzam usunięcie tego profilu").click();
        });
        await click(h, "Usuń profil klienta");
        await until(() => writeCalls().length === 1 && f.clients.length === 0);
        assert.deepEqual(f.orders, old);
        assert.deepEqual(f.links.get(customer), [order]);
        await h.close();
      },
    );
    await t.test(
      "group CRUD, primary protections and status deletion send explicit different target",
      async () => {
        reset();
        const h = await mount();
        await click(h, "Statusy i grupy");
        assert.equal(button(h, "Usuń grupę Główna").disabled, true);
        assert.equal(button(h, "Usuń status Nowy").disabled, true);
        const add = button(h, "Dodaj grupę").closest("form");
        add.querySelector("input").value = "Partnerzy";
        await submit(add);
        await until(
          () => f.groups.length === 3 && journal().phase === "acknowledged",
        );
        const addStatus = button(h, "Dodaj status").closest("form");
        addStatus.querySelector("[name=name]").value = "Nowy etap";
        await submit(addStatus);
        await until(
          () => f.statuses.length === 4 && journal().phase === "acknowledged",
        );
        assert.equal(writeCalls()[1].body.group_id, undefined);
        const target = label(h, "Status docelowy dla status Stały");
        await select(target, targetStatus);
        await act(async () =>
          label(h, "Potwierdzam usunięcie: status Stały").click(),
        );
        await click(h, "Usuń status Stały");
        await until(
          () =>
            !f.statuses.some((s) => s.id === customStatus) &&
            journal().phase === "acknowledged",
        );
        assert.equal(writeCalls().at(-1).body.target_status_id, targetStatus);
        assert.equal(f.clients[0].status_id, targetStatus);
        await h.close();
      },
    );
    await t.test(
      "status partial edit retains omitted group and group removal transfers status IDs",
      async () => {
        reset();
        const h = await mount();
        await click(h, "Statusy i grupy");
        const form = [...h.el.querySelectorAll("form")].find(
          (f) => f.querySelector("[name=name]")?.value === "Stały",
        );
        form.querySelector("[name=name]").value = "Stały VIP";
        await submit(form);
        await until(
          () =>
            f.statuses.find((s) => s.id === customStatus).name ===
              "Stały VIP" && journal().phase === "acknowledged",
        );
        assert.deepEqual(Object.keys(writeCalls()[0].body).sort(), [
          "client_key",
          "name",
          "version",
        ]);
        await act(async () =>
          label(h, "Potwierdzam usunięcie: grupę VIP").click(),
        );
        await click(h, "Usuń grupę VIP");
        await until(
          () => f.groups.length === 1 && journal().phase === "acknowledged",
        );
        assert.equal(
          f.statuses.find((s) => s.id === customStatus).group_id,
          mainGroup,
        );
        assert.equal(f.clients[0].status_id, customStatus);
        await h.close();
      },
    );
    await t.test(
      "all seven editors use source typed values and clear only one field",
      async () => {
        reset();
        const h = await mount();
        await open(h, true);
        const cases = [
          ["Opis", "hello"],
          ["Obrót", "12.5"],
          ["Segment", "B"],
          ["Rocznica", "2026-10-19"],
        ];
        for (const [name, value] of cases) {
          const input = label(h, "Pole " + name);
          await select(input, value);
          await submit(button(h, "Zapisz pole " + name).closest("form"));
          await until(
            () =>
              journal().phase === "acknowledged" &&
              !button(h, "Zapisz pole " + name).closest("fieldset").disabled,
          );
        }
        assert.equal(f.values[customer][uuid(31)], 12.5);
        assert.equal(f.values[customer][uuid(32)], "B");
        const checkbox = [
          ...button(h, "Zapisz pole Zgody")
            .closest("form")
            .querySelectorAll("input[type=checkbox]"),
        ][0];
        await act(async () => checkbox.click());
        await submit(button(h, "Zapisz pole Zgody").closest("form"));
        await until(
          () =>
            journal().phase === "acknowledged" &&
            Array.isArray(f.values[customer][uuid(33)]),
        );
        assert.deepEqual(f.values[customer][uuid(33)], ["A"]);
        const radio = button(h, "Zapisz pole Kontakt")
          .closest("form")
          .querySelector("input[type=radio]");
        await act(async () => radio.click());
        await submit(button(h, "Zapisz pole Kontakt").closest("form"));
        await until(
          () =>
            journal().phase === "acknowledged" &&
            f.values[customer][uuid(34)] === "A",
        );
        await click(h, "Usuń wartość Opis");
        await until(
          () =>
            !Object.hasOwn(f.values[customer], uuid(30)) &&
            journal().phase === "acknowledged",
        );
        assert.equal(
          writeCalls().at(-1).body.custom_extra_fields[uuid(30)],
          "",
        );
        assert.equal(f.values[customer][uuid(31)], 12.5);
        await h.close();
      },
    );
    await t.test(
      "CSV attachment sends title/file payload without a format filter; oversized files refuse dispatch",
      async () => {
        reset();
        const h = await mount();
        await open(h, true);
        let input = label(h, "Pole Umowa");
        const bytes = new TextEncoder().encode(
          "name,email\nAla,ala@example.test\n",
        );
        assert.equal(input.hasAttribute("accept"), false);
        Object.defineProperty(input, "files", {
          configurable: true,
          value: [
            {
              name: "clients.csv",
              size: bytes.length,
              arrayBuffer: async () => bytes.buffer,
            },
          ],
        });
        await act(async () =>
          input.dispatchEvent(new Event("change", { bubbles: true })),
        );
        await submit(button(h, "Zapisz pole Umowa").closest("form"));
        await until(
          () =>
            journal().phase === "acknowledged" &&
            !!button(h, "Pobierz clients.csv"),
        );
        assert.deepEqual(
          writeCalls().at(-1).body.custom_extra_fields[uuid(36)],
          {
            title: "clients.csv",
            file: "data:" + Buffer.from(bytes).toString("base64"),
          },
        );
        assert(
          !h.el.textContent.includes(
            "data:" + Buffer.from(bytes).toString("base64"),
          ),
        );
        input = label(h, "Pole Umowa");
        Object.defineProperty(input, "files", {
          configurable: true,
          value: [
            {
              name: "too-big.pdf",
              size: 2000001,
              arrayBuffer: async () => {
                assert.fail("oversize read");
              },
            },
          ],
        });
        await act(async () =>
          input.dispatchEvent(new Event("change", { bubbles: true })),
        );
        const before = writeCalls().length;
        await submit(button(h, "Zapisz pole Umowa").closest("form"));
        await until(() =>
          h.el.textContent.includes("przekracza dopuszczalny rozmiar"),
        );
        assert.equal(writeCalls().length, before);
        await h.close();
      },
    );
    await t.test(
      "private file download stays authenticated, works for viewer and never renders file inline",
      async () => {
        reset();
        f.actor = ctx({ admin: false });
        f.values[customer] = {
          [uuid(36)]: {
            title: "private.pdf",
            url: `/api/crm/clients/${customer}/files/${uuid(36)}`,
          },
        };
        const h = await mount(f.actor);
        await open(h, true);
        const create = URL.createObjectURL,
          revoke = URL.revokeObjectURL,
          anchorClick = dom.window.HTMLAnchorElement.prototype.click;
        let blob, filename;
        URL.createObjectURL = (b) => {
          blob = b;
          return "blob:crm-private-file";
        };
        URL.revokeObjectURL = () => {};
        dom.window.HTMLAnchorElement.prototype.click = function () {
          filename = this.download;
        };
        try {
          await click(h, "Pobierz private.pdf");
          await until(() => !!filename);
          assert.equal(filename, "private.pdf");
          assert.equal(blob.type, "application/octet-stream");
          assert.equal(await blob.text(), "%PDF-private");
          const read = f.calls.find((c) => c.path.includes("/files/"));
          assert.equal(read.method, "GET");
          assert.equal(read.workspace, tenant);
          assert.equal(writeCalls().length, 0);
          assert.equal(
            h.el.querySelectorAll("iframe,object,embed,img").length,
            0,
          );
        } finally {
          URL.createObjectURL = create;
          URL.revokeObjectURL = revoke;
          dom.window.HTMLAnchorElement.prototype.click = anchorClick;
          await h.close();
        }
      },
    );
    await t.test(
      "client pages and linked-order cursors stay explicit and use current selection",
      async () => {
        reset();
        f.hasMore = true;
        f.links.set(customer, [order]);
        f.historyMore = true;
        const h = await mount();
        await click(h, "Następna strona");
        await until(() =>
          f.calls.some(
            (c) =>
              c.path === "/api/crm/clients" &&
              new URLSearchParams(c.search).get("page") === "2",
          ),
        );
        await until(() => !button(h, "Poprzednia strona").disabled);
        await open(h);
        await click(h, "Odczytaj zamówienia klienta");
        await until(() => !!button(h, "Kolejne zamówienia klienta"));
        await click(h, "Kolejne zamówienia klienta");
        await until(() =>
          f.calls.some(
            (c) =>
              c.path.endsWith("/orders") &&
              new URLSearchParams(c.search).get("after") === "firstpagecursor",
          ),
        );
        assert.equal(writeCalls().length, 0);
        await h.close();
      },
    );
    await t.test(
      "order selection creates ID link and changing email does not replace historical order linkage",
      async () => {
        reset();
        const h = await mount();
        await open(h);
        await submit(button(h, "Wyszukaj zamówienia").closest("form"));
        await until(() => !!label(h, "Zamówienie do powiązania"));
        await select(label(h, "Zamówienie do powiązania"), order);
        await click(h, "Powiąż wybrane zamówienie");
        await until(
          () =>
            f.links.get(customer)?.length === 1 &&
            journal().phase === "acknowledged",
        );
        assert.equal(
          writeCalls()[0].path,
          `/api/crm/clients/${customer}/orders`,
        );
        profileForm(h).querySelector("[name=email]").value =
          "changed@example.test";
        await submit(profileForm(h));
        await until(
          () =>
            f.clients[0].email === "changed@example.test" &&
            journal().phase === "acknowledged",
        );
        await click(h, "Odczytaj zamówienia klienta");
        await until(() => h.el.textContent.includes("ZAM/44"));
        assert.deepEqual(f.links.get(customer), [order]);
        await h.close();
      },
    );
    await t.test(
      "lost create ACK survives remount and shared tab without another mutation; original observe only",
      async () => {
        reset();
        f.lost = true;
        let h = await mount();
        await click(h, "Nowy klient");
        profileForm(h).querySelector("[name=email]").value =
          "uncertain@example.test";
        await submit(profileForm(h));
        await until(() => journal()?.phase === "unknown");
        const original = structuredClone(journal());
        await h.close();
        h = await mount();
        const second = await mount();
        assert.equal(button(second, "Nowy klient").disabled, true);
        await click(h, "Odczytaj oryginalny wynik CRM");
        await until(
          () =>
            journal().phase === "acknowledged" &&
            !button(second, "Nowy klient").disabled,
        );
        assert.equal(writeCalls().length, 1);
        const observe = f.calls.find((c) => c.path.endsWith("/observe"));
        assert.deepEqual(observe.body, {
          method: original.method,
          path: original.path,
          body: original.body,
        });
        assert.equal(f.clients.length, 2);
        await h.close();
        await second.close();
      },
    );
    await t.test(
      "explicit cancellation releases an undelivered original without creating a client or resending the mutation",
      async () => {
        reset();
        f.dropBeforeWrite = true;
        const h = await mount();
        await click(h, "Nowy klient");
        await submit(profileForm(h));
        await until(() => journal()?.phase === "unknown");
        const original = structuredClone(journal());
        assert.equal(
          button(h, "Anuluj niewykonane polecenie CRM").disabled,
          true,
        );
        await act(async () =>
          label(
            h,
            "Potwierdzam anulowanie niewykonanego polecenia. Wcześniejszy zapis pozostanie zachowany.",
          ).click(),
        );
        await click(h, "Anuluj niewykonane polecenie CRM");
        await until(
          () =>
            journal().phase === "acknowledged" &&
            !button(h, "Nowy klient").disabled,
        );
        assert.equal(journal().ack.status, "CRM_COMMAND_CANCELLED");
        assert.equal(f.clients.length, 1);
        const calls = f.calls.filter((c) => c.path.endsWith("/cancel"));
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].body, {
          method: original.method,
          path: original.path,
          body: original.body,
        });
        assert.equal(
          f.calls.filter(
            (c) => c.method === "POST" && c.path === "/api/crm/clients",
          ).length,
          1,
        );
        for (const patch of [
          { client_key: uuid(98) },
          { method: "DELETE" },
          { path: "/api/crm/statuses" },
          { automatic_retry: true },
        ])
          assert.throws(() =>
            custody.validateCrmAck(original, { ...journal().ack, ...patch }),
          );
        await h.close();
      },
    );
    await t.test(
      "lost cancellation response stays pending across remount and resolves through observation without a second cancel",
      async () => {
        reset();
        f.dropBeforeWrite = true;
        f.lostCancel = true;
        let h = await mount();
        await click(h, "Nowy klient");
        await submit(profileForm(h));
        await until(() => journal()?.phase === "unknown");
        await act(async () =>
          label(
            h,
            "Potwierdzam anulowanie niewykonanego polecenia. Wcześniejszy zapis pozostanie zachowany.",
          ).click(),
        );
        await click(h, "Anuluj niewykonane polecenie CRM");
        await until(() =>
          h.el.textContent.includes("Lost original cancellation response"),
        );
        assert.equal(journal().phase, "unknown");
        assert.equal(button(h, "Nowy klient").disabled, true);
        await h.close();
        h = await mount();
        await click(h, "Odczytaj oryginalny wynik CRM");
        await until(
          () =>
            journal().phase === "acknowledged" &&
            !button(h, "Nowy klient").disabled,
        );
        assert.equal(journal().ack.status, "CRM_COMMAND_CANCELLED");
        assert.equal(f.clients.length, 1);
        assert.equal(
          f.calls.filter((c) => c.path.endsWith("/cancel")).length,
          1,
        );
        assert.equal(
          f.calls.filter(
            (c) => c.method === "POST" && c.path === "/api/crm/clients",
          ).length,
          1,
        );
        await h.close();
      },
    );
    await t.test(
      "cancel after an applied original restores its original acknowledgement without undo or another profile write",
      async () => {
        reset();
        f.lost = true;
        const h = await mount();
        await click(h, "Nowy klient");
        await submit(profileForm(h));
        await until(() => journal()?.phase === "unknown");
        const original = structuredClone(
          f.journal.get(journal().body.client_key),
        );
        const before = structuredClone(f.clients);
        await act(async () =>
          label(
            h,
            "Potwierdzam anulowanie niewykonanego polecenia. Wcześniejszy zapis pozostanie zachowany.",
          ).click(),
        );
        await click(h, "Anuluj niewykonane polecenie CRM");
        await until(
          () =>
            journal().phase === "acknowledged" &&
            h.el.textContent.includes("Zapis nastąpił wcześniej"),
        );
        assert.deepEqual(journal().ack, original);
        assert.deepEqual(f.clients, before);
        assert.equal(
          f.calls.filter(
            (c) => c.method === "POST" && c.path === "/api/crm/clients",
          ).length,
          1,
        );
        await h.close();
      },
    );
    await t.test(
      "two mounted views serialize original observation and never send a second mutation",
      async () => {
        reset();
        f.lost = true;
        const h = await mount();
        await click(h, "Nowy klient");
        await submit(profileForm(h));
        await until(() => journal()?.phase === "unknown");
        const second = await mount();
        f.observeHold = deferred();
        await click(h, "Odczytaj oryginalny wynik CRM");
        await until(
          () => f.calls.filter((c) => c.path.endsWith("/observe")).length === 1,
        );
        await click(second, "Odczytaj oryginalny wynik CRM");
        await tick();
        assert.equal(
          f.calls.filter((c) => c.path.endsWith("/observe")).length,
          1,
        );
        const ack = f.journal.get(journal().body.client_key);
        await act(async () =>
          f.observeHold.resolve(Response.json({ status: "ACKNOWLEDGED", ack })),
        );
        await until(
          () =>
            journal().phase === "acknowledged" &&
            !button(second, "Nowy klient").disabled,
        );
        assert.equal(
          f.calls.filter((c) => c.path.endsWith("/observe")).length,
          1,
        );
        assert.equal(writeCalls().length, 1);
        await h.close();
        await second.close();
      },
    );
    await t.test(
      "delayed original acknowledgement stays with the original actor after principal switch",
      async () => {
        reset();
        f.hold = deferred();
        const h = await mount();
        await click(h, "Nowy klient");
        profileForm(h).querySelector("[name=email]").value =
          "old-actor@example.test";
        await submit(profileForm(h));
        await until(() => writeCalls().length === 1);
        const key = journal().body.client_key;
        f.actor = ctx({ userId: uuid(99) });
        await h.render(f.actor);
        const ack = f.journal.get(key);
        await act(async () =>
          f.hold.resolve(Response.json(ack, { status: 201 })),
        );
        await until(() => journal().phase === "acknowledged");
        assert.equal(
          custody.readCrmCommand(sessionStorage, localStorage, f.actor),
          null,
        );
        assert(!profileForm(h));
        assert.equal(writeCalls().length, 1);
        await h.close();
      },
    );
    await t.test(
      "NOT_OBSERVED never releases UNKNOWN; malformed ACK stays pending; explicit 422 is locally rejected",
      async () => {
        reset();
        f.lost = true;
        const h = await mount();
        await click(h, "Nowy klient");
        await submit(profileForm(h));
        await until(() => journal()?.phase === "unknown");
        f.journal.clear();
        await click(h, "Odczytaj oryginalny wynik CRM");
        await until(() =>
          h.el.textContent.includes("Nie znaleziono potwierdzenia"),
        );
        assert.equal(journal().phase, "unknown");
        assert.equal(button(h, "Nowy klient").disabled, true);
        await h.close();
        reset();
        f.deny = 422;
        const other = await mount();
        await click(other, "Nowy klient");
        await submit(profileForm(other));
        await until(
          () =>
            journal()?.phase === "rejected" &&
            !button(other, "Nowy klient").disabled,
        );
        assert.equal(f.clients.length, 1);
        assert.equal(writeCalls().length, 1);
        await other.close();
      },
    );
    await t.test(
      "malformed and stale/future CAS acknowledgements stay UNKNOWN until exact original observation",
      async () => {
        reset();
        f.badAck = { data: initialClient({ version: 99 }) };
        const h = await mount();
        await open(h);
        profileForm(h).querySelector("[name=phone]").value = "777";
        await submit(profileForm(h));
        await until(() => journal()?.phase === "unknown");
        assert.equal(button(h, "Nowy klient").disabled, true);
        await click(h, "Odczytaj oryginalny wynik CRM");
        await until(() => journal().phase === "acknowledged");
        assert.equal(writeCalls().length, 1);
        const done = journal();
        assert.throws(() =>
          custody.validateCrmAck(done, {
            data: { ...done.ack.data, version: done.body.version },
          }),
        );
        assert.throws(() =>
          custody.validateCrmAck(done, {
            data: { ...done.ack.data, version: done.body.version + 2 },
          }),
        );
        await h.close();
      },
    );
    await t.test(
      "viewer/read-only/globalblock and missing WebLocks refuse writes; actor switch hides old detail",
      async () => {
        for (const patch of [
          { admin: false },
          { readOnly: true },
          { externalWriteBlocked: true },
        ]) {
          reset();
          f.actor = ctx(patch);
          const h = await mount(ctx(patch));
          assert.equal(button(h, "Nowy klient").disabled, true);
          assert.equal(writeCalls().length, 0);
          await h.close();
        }
        reset();
        const h = await mount();
        await open(h);
        f.actor = ctx({ userId: uuid(90) });
        await h.render(f.actor);
        assert(!h.el.textContent.includes("Private note retained"));
        assert(!profileForm(h));
        await h.close();
        reset();
        const other = await mount();
        await click(other, "Nowy klient");
        const locks = navigator.locks;
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value: undefined,
        });
        await submit(profileForm(other));
        await until(() =>
          other.el.textContent.includes("bezpiecznie zablokować"),
        );
        assert.equal(writeCalls().length, 0);
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value: locks,
        });
        await other.close();
      },
    );
    await t.test(
      "fresh role revocation prevents configuration without relying on old props",
      async () => {
        reset();
        const h = await mount();
        await click(h, "Nowy klient");
        f.actor = ctx({ admin: false });
        await submit(profileForm(h));
        await until(() => h.el.textContent.includes("aktualna sesja"));
        assert.equal(writeCalls().length, 0);
        assert.equal(journal(), null);
        await h.close();
      },
    );
    await t.test(
      "pure custody preserves an old unresolved tab while a newer cross-tab command remains pending",
      () => {
        const one = memory(),
          two = memory(),
          shared = memory(),
          context = ctx(),
          a = {
            method: "POST",
            path: "/api/crm/clients",
            body: { client_key: uuid(300), email: "a@example.test" },
            tenant_id: tenant,
            user_id: user,
            created_at: "2026-10-19T00:00:00Z",
            phase: "sent",
          },
          ack = { data: initialClient({ email: "a@example.test" }) };
        custody.saveCrmCommand(one, shared, context, a);
        custody.saveCrmCommand(two, shared, context, {
          ...a,
          phase: "acknowledged",
          ack,
        });
        const b = {
          ...a,
          body: { client_key: uuid(301) },
          created_at: "2026-10-19T00:01:00Z",
        };
        custody.saveCrmCommand(two, shared, context, b);
        assert.equal(
          custody.readCrmCommand(one, shared, context).body.client_key,
          a.body.client_key,
        );
        custody.saveCrmCommand(one, shared, context, {
          ...a,
          phase: "acknowledged",
          ack,
        });
        assert.equal(
          custody.readCrmCommand(one, shared, context).body.client_key,
          b.body.client_key,
        );
        assert.equal(
          custody.readCrmCommand(two, shared, context).phase,
          "sent",
        );
        assert.throws(() =>
          custody.saveCrmCommand(one, shared, context, {
            ...a,
            body: { client_key: uuid(302) },
          }),
        );
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
    for (const [k, d] of Object.entries(prior))
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
