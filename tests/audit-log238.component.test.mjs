/** Actual AuditLog (SEC-009) and the members' LoginHistory paging/filter (238) with a closed local fetch. No API
 * server, database or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const tenant = '10000000-1000-4000-8000-000000000238';
const reactProps = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactProps'))];
const button = (el, text) => [...el.querySelectorAll('button')].find((e) => e.textContent.trim() === text);
const author = (o) => ({ kind: 'user', user_id: 'u1', name: 'Anna Nowak', api_key_id: null, api_key_name: null, api_key_prefix: null, ...o });
const page1 = [
  { id: 'a1', created_at: '2026-10-27T08:00:00Z', action: 'order.status', entity_id: '11111111-2222-4333-8444-555555555555', detail: { from: 'new', to: 'paid' }, author: author() },
  { id: 'a2', created_at: '2026-10-27T07:00:00Z', action: 'product.create', entity_id: null, detail: { kind: 'simple' },
    author: author({ kind: 'api_key', api_key_id: 'k1', api_key_name: 'Sklep', api_key_prefix: 'dyna_api_ab12' }) },
];
const page2 = [{ id: 'a3', created_at: '2026-10-26T07:00:00Z', action: 'qa.unknown_action', entity_id: null, detail: {}, author: author({ kind: 'system', user_id: null, name: null }) }];

test('238 UI: readable audit log with filters and cursor; members login list filters and pages', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4105' });
  const saved = new Map(), oldFetch = globalThis.fetch, roots = new Set();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    location: dom.window.location, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, FormData: dom.window.FormData, CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let vite;
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
    const { AuditLog } = await vite.ssrLoadModule(path.resolve('web/audit-log.tsx'));
    const { LoginHistory } = await vite.ssrLoadModule(path.resolve('web/login-history.tsx'));
    const { auditActionLabel, auditChanges } = await vite.ssrLoadModule(path.resolve('server/audit-labels.ts'));
    const { setWorkspace } = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    const { createRoot } = await import('react-dom/client');
    setWorkspace(tenant);
    const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
    const mount = async (element) => {
      const el = document.createElement('div');
      document.body.append(el);
      const root = createRoot(el);
      roots.add(root);
      await act(async () => root.render(element));
      await settle();
      return el;
    };

    await t.test('labels and before/after changes are plain Polish text', () => {
      assert.equal(auditActionLabel('order.status'), 'Zmiana statusu zamówienia');
      assert.equal(auditActionLabel('api_key.rotated'), 'Rotacja klucza API');
      assert.equal(auditActionLabel('order.something_new'), 'Zamówienie: something_new');
      assert.equal(auditActionLabel('qa.unknown_action'), 'qa.unknown_action');
      assert.deepEqual(auditChanges({ from: 'new', to: 'paid' }), ['new → paid']);
      assert.deepEqual(auditChanges({ before: { price: 100, name: 'A' }, after: { price: 120, name: 'A' } }), ['price: 100 → 120']);
      assert.deepEqual(auditChanges({ kind: 'simple' }), []);
    });

    await t.test('rows name the author, the key and the change; filters and "older" use the server cursor', async () => {
      const requests = [];
      globalThis.fetch = async (url, options = {}) => {
        requests.push(url);
        assert.equal(options.headers['X-Workspace-ID'], tenant);
        if (url === '/api/audit/authors') return Response.json({ members: [{ id: 'u1', name: 'Anna Nowak', email: 'anna@example.test' }], api_keys: [{ id: 'k1', name: 'Sklep', prefix: 'dyna_api_ab12', revoked_at: null }] });
        if (url === '/api/audit?limit=50') return Response.json({ data: page1, meta: { cursor: 'CUR1' } });
        if (url === '/api/audit?limit=50&after=CUR1') return Response.json({ data: page2, meta: { cursor: null } });
        if (url === '/api/audit?limit=50&user_id=u1&action=order&from=2026-10-01')
          return Response.json({ data: [page1[0]], meta: { cursor: null } });
        assert.fail('unexpected ' + url);
      };
      const el = await mount(React.createElement(AuditLog, { refresh: 0 }));
      const cells = () => [...el.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent));
      let rows = cells();
      assert.equal(rows.length, 2);
      assert.match(rows[0][1], /^Anna Nowak$/);
      assert.match(rows[0][2], /Zmiana statusu zamówienia/);
      assert.match(rows[0][2], /order\.status/);
      assert.match(rows[0][4], /new → paid/);
      assert.match(rows[1][1], /Klucz API: Sklep \(dyna_api_ab12…\)/);
      assert.match(rows[1][1], /właściciel: Anna Nowak/);
      assert(!el.textContent.includes('{"from"'), 'no raw JSON in the main columns');
      await act(async () => button(el, 'Pokaż starsze').click());
      await settle();
      rows = cells();
      assert.equal(rows.length, 3);
      assert.match(rows[2][1], /System/);
      assert.equal(button(el, 'Pokaż starsze'), undefined, 'no more pages');
      const form = el.querySelector('form[aria-label="Filtry dziennika"]');
      form.elements.namedItem('user_id').value = 'u1';
      form.elements.namedItem('action').value = 'order';
      form.elements.namedItem('from').value = '2026-10-01';
      await act(async () => reactProps(form).onSubmit({ preventDefault() {}, currentTarget: form }));
      await settle();
      assert.equal(cells().length, 1);
      assert.equal(requests.at(-1), '/api/audit?limit=50&user_id=u1&action=order&from=2026-10-01');
    });

    await t.test('CSV export asks the server with the current filters in this workspace', async () => {
      const requests = [];
      const created = [];
      globalThis.URL.createObjectURL = (b) => { created.push(b); return 'blob:audit'; };
      globalThis.URL.revokeObjectURL = () => {};
      globalThis.fetch = async (url, options = {}) => {
        requests.push([url, options.headers?.['X-Workspace-ID']]);
        if (url === '/api/audit/authors') return Response.json({ members: [], api_keys: [] });
        if (url === '/api/audit?limit=50') return Response.json({ data: page1, meta: { cursor: null } });
        if (url === '/api/audit/export') return new Response('﻿Czas (UTC);Autor\r\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="dziennik-audytu-20261027.csv"' } });
        assert.fail('unexpected ' + url);
      };
      const el = await mount(React.createElement(AuditLog, { refresh: 0 }));
      await act(async () => button(el, 'Eksport CSV').click());
      await settle();
      assert.deepEqual(requests.at(-1), ['/api/audit/export', tenant]);
      assert.equal(created.length, 1);
    });

    await t.test('an error is shown in Polish, not swallowed', async () => {
      globalThis.fetch = async (url) => url === '/api/audit/authors'
        ? Response.json({ members: [], api_keys: [] })
        : Response.json({ status: 422, detail: 'Niepoprawny kursor historii' }, { status: 422 });
      const el = await mount(React.createElement(AuditLog, { refresh: 0 }));
      assert.match(el.querySelector('[role=alert]').textContent, /Niepoprawny kursor historii/);
    });

    await t.test('members list: person filter and "older" page with the cursor', async () => {
      const requests = [];
      const ev = (id, outcome, name) => ({ id, created_at: '2026-10-27T08:00:00Z', outcome, status: 429, ip: '10.0.0.9', user_agent: null, user_name: name, user_email: name + '@example.test' });
      globalThis.fetch = async (url) => {
        requests.push(url);
        const members = [{ id: 'm1', name: 'Zalewany', email: 'z@example.test' }, { id: 'm2', name: 'Cichy', email: 'c@example.test' }];
        if (url === '/api/workspaces/security/logins') return Response.json({ data: [ev('e1', 'password_locked', 'Zalewany')], members, retention_days: 90, meta: { cursor: 'L1' } });
        if (url === '/api/workspaces/security/logins?after=L1') return Response.json({ data: [ev('e2', 'password_locked', 'Zalewany')], members, retention_days: 90, meta: { cursor: null } });
        if (url === '/api/workspaces/security/logins?user_id=m2') return Response.json({ data: [ev('e3', 'password_failed', 'Cichy')], members, retention_days: 90, meta: { cursor: null } });
        assert.fail('unexpected ' + url);
      };
      const el = await mount(React.createElement(LoginHistory, { url: '/workspaces/security/logins', refresh: 0, members: true }));
      assert.equal(el.querySelectorAll('tbody tr').length, 1);
      await act(async () => button(el, 'Pokaż starsze').click());
      await settle();
      assert.equal(el.querySelectorAll('tbody tr').length, 2);
      const select = el.querySelector('select[aria-label="Osoba"]');
      assert.deepEqual([...select.options].map((o) => o.textContent), ['Wszystkie osoby', 'Zalewany (z@example.test)', 'Cichy (c@example.test)']);
      select.value = 'm2';
      await act(async () => reactProps(select).onChange({ target: select, currentTarget: select }));
      await settle();
      assert.deepEqual([...el.querySelectorAll('tbody tr')].map((r) => r.querySelector('td:nth-child(2)').textContent), ['CichyCichy@example.test']);
      assert.equal(requests.at(-1), '/api/workspaces/security/logins?user_id=m2');
    });
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    if (vite) await vite.close();
    globalThis.fetch = oldFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
