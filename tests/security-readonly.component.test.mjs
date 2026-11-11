/** Real React security panels, closed fetch only. No server, provider or database. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
const tenant = "10000000-1000-4000-8000-000000000001",
  actor = "20000000-1000-4000-8000-000000000001";
const user = {
    id: actor,
    tenant_id: tenant,
    tenant_name: "Firma A",
    role: "admin",
  },
  scope = tenant + ":" + actor + ":admin";
const props = (e) =>
  e[Object.keys(e).find((k) => k.startsWith("__reactProps"))];
const button = (h, text) =>
  [...h.el.querySelectorAll("button")].find(
    (e) => e.textContent.trim() === text,
  );
const account = (enabled) => ({
  enabled,
  recovery_remaining: 8,
  required_by_organizations: [],
  sessions: [
    {
      id: "old-session",
      tenant_name: "Firma A",
      created_at: "2026-10-01T00:00:00Z",
      expires_at: "2027-01-01T00:00:00Z",
      current: false,
    },
    {
      id: "now",
      tenant_name: "Firma A",
      created_at: "2026-10-01T00:00:00Z",
      expires_at: "2027-01-01T00:00:00Z",
      current: true,
    },
  ],
});
const policy = {
  require_mfa: false,
  version: 3,
  members: [
    {
      id: actor,
      name: "Administrator A",
      email: "a@example.test",
      role: "admin",
      mfa_enabled: true,
    },
  ],
};
async function click(e) {
  assert(e);
  await act(async () => {
    await props(e).onClick();
  });
}
async function submit(form, handler = props(form).onSubmit) {
  await act(async () => {
    await handler({ preventDefault() {}, currentTarget: form });
  });
}
function fill(form) {
  for (const e of form.elements) {
    if (e.name === "password") e.value = "current-test-password";
    if (e.name === "new_password") e.value = "new-test-password";
    if (e.name === "code") e.value = "123456";
  }
}
test("security read-only custody preserves reads and normal writes while rejecting stale mutations", async (t) => {
  const dom = new JSDOM("<body/>", { url: "http://127.0.0.1:4106" }),
    saved = new Map(),
    oldFetch = globalThis.fetch,
    roots = new Set();
  for (const [k, v] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    FormData: dom.window.FormData,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, {
      configurable: true,
      writable: true,
      value: v,
    });
  }
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom",
    logLevel: "error",
  });
  let requests = [],
    changed = [],
    notices = [],
    enabled = false,
    handler;
  try {
    const { AccountSecurity } = await vite.ssrLoadModule(
        path.resolve("web/account-security.tsx"),
      ),
      { WorkspaceSecurityPolicy, MfaGate } = await vite.ssrLoadModule(
        path.resolve("web/workspace-security.tsx"),
      ),
      { setWorkspace } = await vite.ssrLoadModule(path.resolve("web/api.ts")),
      { createRoot } = await import("react-dom/client");
    setWorkspace(tenant);
    globalThis.fetch = async (url, options = {}) => {
      const r = {
        url,
        method: options.method ?? "GET",
        body: options.body ? JSON.parse(options.body) : null,
      };
      requests.push(r);
      return handler(r);
    };
    function reset() {
      requests = [];
      changed = [];
      notices = [];
      enabled = false;
      handler = (r) => {
        if (r.method === "GET" && r.url === "/api/auth/security")
          return Response.json(account(enabled));
        if (r.method === "GET" && r.url === "/api/workspaces/security")
          return Response.json(policy);
        if (r.method === "GET" && r.url === "/api/workspaces")
          return Response.json({ data: [] });
        // 237 login history of the account and of the members (empty here).
        if (r.method === "GET" && /^\/api\/(?:auth|workspaces)\/security\/logins$/.test(r.url))
          return Response.json({ data: [], retention_days: 90 });
        if (r.method === "POST" && r.url === "/api/auth/security/enroll")
          return Response.json({
            qr: "data:image/png;base64,AA==",
            secret: "TESTONLY",
            expires_at: "2027-01-01T00:00:00Z",
          });
        if (r.method === "PATCH" && r.url === "/api/workspaces/security")
          return Response.json({
            user,
            policy: { require_mfa: r.body.require_mfa },
          });
        if (r.method === "POST" || r.method === "DELETE")
          return Response.json({ user });
        throw Error("Unexpected closed request " + r.method + " " + r.url);
      };
    }
    async function mount(Component, initial) {
      const el = document.createElement("div");
      document.body.append(el);
      const root = createRoot(el);
      roots.add(root);
      let p = initial;
      const h = {
        el,
        async render(next = {}) {
          p = { ...p, ...next };
          await act(async () => root.render(React.createElement(Component, p)));
        },
        async close() {
          await act(async () => root.unmount());
          roots.delete(root);
          el.remove();
        },
      };
      await h.render();
      return h;
    }
    const common = {
      readOnly: false,
      changed: (...v) => changed.push(v),
      notify: (...v) => notices.push(v),
      refresh: 0,
    };
    const mutations = () => requests.filter((r) => r.method !== "GET");
    await t.test(
      "read-only account shows current protection and all sessions; every mutable action refuses forced handlers",
      async () => {
        for (const state of [false, true]) {
          reset();
          enabled = state;
          const h = await mount(AccountSecurity, {
            ...common,
            contextKey: scope,
            readOnly: true,
          });
          assert.match(h.el.textContent, /MFA włączone|MFA wyłączone/);
          assert.match(h.el.textContent, /Firma A/);
          assert.match(h.el.textContent, /Bieżąca/);
          const texts = state
            ? [
                "Nowe kody odzyskiwania",
                "Wyłącz MFA",
                "Zmień hasło",
                "Zakończ sesję",
              ]
            : ["Włącz MFA", "Zmień hasło", "Zakończ sesję"];
          for (const text of texts) {
            assert(button(h, text).disabled, text);
            await click(button(h, text));
          }
          assert.equal(h.el.querySelector("form"), null);
          assert.equal(mutations().length, 0);
          assert.equal(changed.length, 0);
          await h.close();
        }
      },
    );
    await t.test(
      "retained account forms and session revoke refuse read-only, changed principal and unmount",
      async () => {
        for (const mode of ["readonly", "principal", "unmount"]) {
          reset();
          const h = await mount(AccountSecurity, {
            ...common,
            contextKey: scope,
          });
          await click(button(h, "Zmień hasło"));
          const form = h.el.querySelector("form");
          fill(form);
          const oldSubmit = props(form).onSubmit,
            oldRevoke = props(button(h, "Zakończ sesję")).onClick;
          if (mode === "readonly") await h.render({ readOnly: true });
          else if (mode === "principal")
            await h.render({ contextKey: scope + ":different-user" });
          else await h.close();
          await submit(form, oldSubmit);
          await act(async () => oldRevoke());
          assert.equal(mutations().length, 0);
          assert.equal(changed.length, 0);
          if (mode !== "unmount") await h.close();
        }
      },
    );
    await t.test(
      "normal enrollment, confirmation, password, recovery, disable and revoke remain functional",
      async () => {
        reset();
        const h = await mount(AccountSecurity, {
          ...common,
          contextKey: scope,
        });
        await click(button(h, "Włącz MFA"));
        let form = h.el.querySelector("form");
        fill(form);
        await submit(form);
        assert.match(h.el.textContent, /Potwierdź konfigurację MFA/);
        fill(h.el.querySelector("form"));
        await submit(h.el.querySelector("form"));
        assert.equal(changed.length, 1);
        await click(button(h, "Zmień hasło"));
        form = h.el.querySelector("form");
        fill(form);
        await submit(form);
        assert.equal(changed.length, 2);
        await click(button(h, "Zakończ sesję"));
        assert.equal(mutations().at(-1).method, "DELETE");
        await h.close();
        reset();
        enabled = true;
        const second = await mount(AccountSecurity, {
          ...common,
          contextKey: scope,
        });
        for (const text of ["Nowe kody odzyskiwania", "Wyłącz MFA"]) {
          await click(button(second, text));
          fill(second.el.querySelector("form"));
          await submit(second.el.querySelector("form"));
        }
        assert.equal(changed.length, 2);
        assert.deepEqual(
          mutations().map((r) => r.url),
          ["/api/auth/security/recovery", "/api/auth/security/disable"],
        );
        await second.close();
      },
    );
    await t.test(
      "pending enroll DELETE and all retained enabled-MFA submits refuse read-only",
      async () => {
        reset();
        const h = await mount(AccountSecurity, {
          ...common,
          contextKey: scope,
        });
        await click(button(h, "Włącz MFA"));
        fill(h.el.querySelector("form"));
        await submit(h.el.querySelector("form"));
        const cancel = props(button(h, "Anuluj")).onClick,
          form = h.el.querySelector("form"),
          old = props(form).onSubmit,
          before = mutations().length;
        await h.render({ readOnly: true });
        await act(async () => cancel());
        await submit(form, old);
        assert.equal(mutations().length, before);
        await h.close();
        for (const action of ["Nowe kody odzyskiwania", "Wyłącz MFA"]) {
          reset();
          enabled = true;
          const p = await mount(AccountSecurity, {
            ...common,
            contextKey: scope,
          });
          await click(button(p, action));
          const f = p.el.querySelector("form"),
            cb = props(f).onSubmit;
          fill(f);
          await p.render({ readOnly: true });
          await submit(f, cb);
          assert.equal(mutations().length, 0);
          await p.close();
        }
      },
    );
    await t.test(
      "late password ACK cannot update current identity, recovery codes or notices after read-only/context transition",
      async () => {
        for (const change of [
          { readOnly: true },
          { contextKey: scope + ":changed" },
        ]) {
          reset();
          let release;
          const base = handler;
          handler = (r) =>
            r.url === "/api/auth/security/password"
              ? new Promise(
                  (resolve) =>
                    (release = () =>
                      resolve(
                        Response.json({
                          user: { ...user, id: "foreign" },
                          recovery_codes: ["secret-test-code"],
                        }),
                      )),
                )
              : base(r);
          const h = await mount(AccountSecurity, {
            ...common,
            contextKey: scope,
          });
          await click(button(h, "Zmień hasło"));
          fill(h.el.querySelector("form"));
          await submit(h.el.querySelector("form"));
          assert(release);
          await h.render(change);
          await act(async () => release());
          assert.equal(changed.length, 0);
          assert.equal(notices.length, 0);
          assert(!h.el.textContent.includes("secret-test-code"));
          await h.close();
        }
      },
    );
    await t.test(
      "read-only policy keeps team protection GET/table and blocks forced editor; stale submit also refuses new principal/role",
      async () => {
        reset();
        enabled = true;
        const h = await mount(WorkspaceSecurityPolicy, {
          ...common,
          user,
          readOnly: true,
        });
        assert.match(h.el.textContent, /Administrator A/);
        assert.match(h.el.textContent, /MFA dobrowolne/);
        assert(button(h, "Zmień wymóg MFA").disabled);
        await click(button(h, "Zmień wymóg MFA"));
        assert.equal(h.el.querySelector("form"), null);
        assert.equal(mutations().length, 0);
        await h.close();
        for (const change of [
          { readOnly: true },
          { user: { ...user, id: "another" } },
          { user: { ...user, role: "viewer" } },
        ]) {
          reset();
          enabled = true;
          const p = await mount(WorkspaceSecurityPolicy, { ...common, user });
          await click(button(p, "Zmień wymóg MFA"));
          const f = p.el.querySelector("form"),
            old = props(f).onSubmit;
          fill(f);
          await p.render(change);
          await submit(f, old);
          assert.equal(mutations().length, 0);
          assert.equal(changed.length, 0);
          await p.close();
        }
      },
    );
    await t.test(
      "normal policy PATCH works; late ACK after readonly cannot replace user or show successful policy notice",
      async () => {
        reset();
        enabled = true;
        const h = await mount(WorkspaceSecurityPolicy, { ...common, user });
        await click(button(h, "Zmień wymóg MFA"));
        let f = h.el.querySelector("form");
        fill(f);
        f.elements.require_mfa.value = "required";
        await submit(f);
        assert.equal(changed.length, 1);
        assert.deepEqual(mutations()[0].body, {
          require_mfa: true,
          version: 3,
          password: "current-test-password",
          code: "123456",
        });
        await h.close();
        reset();
        enabled = true;
        let release;
        const base = handler;
        handler = (r) =>
          r.method === "PATCH"
            ? new Promise(
                (resolve) =>
                  (release = () =>
                    resolve(
                      Response.json({ user, policy: { require_mfa: true } }),
                    )),
              )
            : base(r);
        const p = await mount(WorkspaceSecurityPolicy, { ...common, user });
        await click(button(p, "Zmień wymóg MFA"));
        f = p.el.querySelector("form");
        fill(f);
        const cb = props(f).onSubmit;
        await act(async () => {
          void cb({ preventDefault() {}, currentTarget: f });
        });
        assert(release);
        await p.render({ readOnly: true });
        await act(async () => release());
        assert.equal(changed.length, 0);
        assert.equal(notices.length, 0);
        await p.close();
      },
    );
    await t.test(
      "ordinary MFA verification remains available; preview preserves its existing explanatory limitation",
      async () => {
        reset();
        const h = await mount(MfaGate, {
          ...common,
          user: { ...user, mfa_enrollment_required: false },
        });
        const f = h.el.querySelector(".mfa-verify-form");
        assert(f);
        fill(f);
        await submit(f);
        assert.equal(mutations()[0].url, "/api/auth/security/verify");
        assert.equal(changed.length, 1);
        await h.render({ readOnly: true });
        assert.equal(h.el.querySelector(".mfa-verify-form"), null);
        assert.match(h.el.textContent, /zaloguj ponownie z kodem MFA/);
        assert(!button(h, "Wyloguj").disabled);
        await h.close();
      },
    );
    await t.test(
      "main passes actual preview flag and principal scope to both security panels",
      () => {
        const source = fs.readFileSync("web/main.tsx", "utf8"),
          start = source.indexOf(
            "<AccountSecurity",
            source.indexOf("function App()"),
          ),
          end = source.indexOf("</>", start),
          slice = source.slice(start, end);
        assert.match(
          slice,
          /<AccountSecurity[\s\S]*?contextKey=\{user\.tenant_id \+ ':' \+ user\.id \+ ':' \+ user\.role\}/,
        );
        assert.match(
          slice,
          /<AccountSecurity[\s\S]*?readOnly=\{restorePreview\}/,
        );
        assert.match(
          slice,
          /<WorkspaceSecurityPolicy[\s\S]*?readOnly=\{restorePreview\}/,
        );
      },
    );
  } finally {
    for (const r of roots) await act(async () => r.unmount());
    await vite.close();
    globalThis.fetch = oldFetch;
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
    dom.window.close();
  }
});
