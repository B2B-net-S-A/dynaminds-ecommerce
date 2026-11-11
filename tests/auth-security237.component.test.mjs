/** Actual LoginHistory and DeveloperPanel rotation with closed local fetch (migration 237). No API server,
 * database or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const tenant = '10000000-1000-4000-8000-000000000237';
const reactProps = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactProps'))];
const button = (el, text) => [...el.querySelectorAll('button')].find((e) => e.textContent.trim() === text);
const events = [
  { id: 'e1', created_at: '2026-10-27T08:00:00Z', outcome: 'success', status: 200, ip: '10.0.0.1', user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', tenant_name: 'Firma A' },
  { id: 'e2', created_at: '2026-10-27T07:59:00Z', outcome: 'password_failed', status: 401, ip: '10.0.0.9', user_agent: 'curl/8.4', tenant_name: null },
  { id: 'e3', created_at: '2026-10-27T07:58:00Z', outcome: 'password_locked', status: 429, ip: '10.0.0.9', user_agent: null, tenant_name: null },
];

test('237 UI: login history and API key rotation', async (t) => {
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
    const { LoginHistory, agentName } = await vite.ssrLoadModule(path.resolve('web/login-history.tsx'));
    const { DeveloperPanel } = await vite.ssrLoadModule(path.resolve('web/developer.tsx'));
    const { setWorkspace } = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    const { createRoot } = await import('react-dom/client');
    setWorkspace(tenant);
    const mount = async (element) => {
      const el = document.createElement('div');
      document.body.append(el);
      const root = createRoot(el);
      roots.add(root);
      await act(async () => root.render(element));
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      return el;
    };

    await t.test('own history lists failures with labels, IP and a short device name', async () => {
      const requests = [];
      globalThis.fetch = async (url) => {
        requests.push(url);
        if (url === '/api/auth/security/logins') return Response.json({ data: events, retention_days: 90 });
        assert.fail('unexpected ' + url);
      };
      const el = await mount(React.createElement(LoginHistory, { url: '/auth/security/logins', refresh: 0 }));
      const rows = [...el.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent));
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((r) => r[1]), ['Zalogowano', 'Błędne hasło', 'Odrzucono: blokada po błędnych hasłach']);
      assert.deepEqual(rows.map((r) => r[2]), ['10.0.0.1', '10.0.0.9', '10.0.0.9']);
      assert.equal(rows[0][3], 'Safari, macOS');
      assert.equal(rows[2][3], '—');
      assert.match(el.textContent, /Przechowujemy je 90 dni\. Nieudane próby na liście: 2\./);
      assert.equal(el.querySelectorAll('.badge.status-error').length, 2);
      assert.equal(agentName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge, Windows');
      assert.equal(agentName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1'), 'Safari, iOS');
      assert.equal(agentName('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), 'Chrome, Android');
    });

    await t.test('an older database without 237 (404) hides the section; another error is shown', async () => {
      globalThis.fetch = async () => Response.json({ status: 404, detail: 'Not Found' }, { status: 404 });
      const hidden = await mount(React.createElement(LoginHistory, { url: '/workspaces/security/logins', refresh: 0, members: true }));
      assert.equal(hidden.textContent, '');
      globalThis.fetch = async () => Response.json({ status: 403, detail: 'Wymagana rola administratora' }, { status: 403 });
      const shown = await mount(React.createElement(LoginHistory, { url: '/workspaces/security/logins', refresh: 0, members: true }));
      assert.match(shown.querySelector('[role=alert]').textContent, /Wymagana rola administratora/);
    });

    await t.test('Rotuj sends the chosen overlap, shows the new secret once and the last use', async () => {
      const requests = [], notices = [];
      const keys = [{ id: 'k-old', name: 'Sklep', prefix: 'dyna_api_oldpref', scopes: ['orders:read'], expires_at: '2099-01-01T00:00:00Z', revoked_at: null }];
      const state = [{ key_id: 'k-old', rotated_from_id: null, last_used_at: '2026-10-27T08:00:00Z', last_used_ip: '10.0.0.5' }];
      globalThis.fetch = async (url, options = {}) => {
        const r = { url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null };
        requests.push(r);
        if (r.method === 'GET' && url === '/api/developer/keys') return Response.json({ data: keys });
        if (r.method === 'GET' && url === '/api/developer/keys/state') return Response.json({ data: state });
        if (r.method === 'GET' && url === '/api/developer/webhooks') return Response.json({ subscriptions: [], deliveries: [], inbox: [] });
        if (r.method === 'POST' && url === '/api/developer/keys/k-old/rotate') {
          keys[0] = { ...keys[0], revoked_at: '2026-10-27T08:01:00Z' };
          keys.unshift({ id: 'k-new', name: 'Sklep', prefix: 'dyna_api_newpref', scopes: ['orders:read'], expires_at: '2099-01-01T00:00:00Z', revoked_at: null });
          state.push({ key_id: 'k-new', rotated_from_id: 'k-old', last_used_at: null, last_used_ip: null });
          return Response.json({ ...keys[0], token: 'TEST_ONLY_ROTATED_TOKEN', rotated_from_id: 'k-old' }, { status: 201 });
        }
        assert.fail('unexpected ' + r.method + ' ' + url);
      };
      const el = await mount(React.createElement(DeveloperPanel, { admin: true, refresh: 0, readOnly: false, contextKey: 'a', notify: (...a) => notices.push(a) }));
      assert.match(el.textContent, /Ostatnie użycie: .* z 10\.0\.0\.5/);
      await act(async () => el.querySelector('[aria-label="Rotuj klucz Sklep"]').click());
      const form = el.querySelector('form[aria-label="Rotacja klucza Sklep"]');
      assert(form);
      form.elements.namedItem('overlap_seconds').value = '300';
      await act(async () => reactProps(form).onSubmit({ preventDefault() {}, currentTarget: form }));
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      const post = requests.filter((r) => r.method === 'POST');
      assert.deepEqual(post.map((r) => [r.url, r.body]), [['/api/developer/keys/k-old/rotate', { overlap_seconds: 300 }]]);
      assert.equal(notices.length, 1);
      assert.notEqual(notices[0][1], true);
      assert.equal(el.querySelector('[aria-label="Nowy klucz API"]').value, 'TEST_ONLY_ROTATED_TOKEN');
      assert.match(el.textContent, /Jeszcze nie użyty · następca klucza dyna_api_oldpref…/);
      assert.equal(el.querySelector('[aria-label="Rotuj klucz Sklep"]')?.disabled ?? true, true, 'no second rotation while a secret is shown');
    });

    await t.test('read-only preview and a database without 237 offer no rotation', async () => {
      const keys = [{ id: 'k1', name: 'Sklep', prefix: 'p', scopes: ['orders:read'], expires_at: '2099-01-01T00:00:00Z', revoked_at: null }];
      globalThis.fetch = async (url) => {
        if (url === '/api/developer/keys') return Response.json({ data: keys });
        if (url === '/api/developer/webhooks') return Response.json({ subscriptions: [], deliveries: [], inbox: [] });
        if (url === '/api/developer/keys/state') return Response.json({ status: 404, detail: 'Not Found' }, { status: 404 });
        assert.fail('unexpected ' + url);
      };
      const without = await mount(React.createElement(DeveloperPanel, { admin: true, refresh: 0, readOnly: false, contextKey: 'b', notify: () => {} }));
      assert.equal(without.querySelector('[aria-label="Rotuj klucz Sklep"]'), null);
      assert(!/Ostatnie użycie|Jeszcze nie użyty/.test(without.textContent));
      assert(!without.querySelector('[role=alert]'));
      globalThis.fetch = async (url) => {
        if (url === '/api/developer/keys') return Response.json({ data: keys });
        if (url === '/api/developer/webhooks') return Response.json({ subscriptions: [], deliveries: [], inbox: [] });
        if (url === '/api/developer/keys/state') return Response.json({ data: [] });
        assert.fail('unexpected ' + url);
      };
      const preview = await mount(React.createElement(DeveloperPanel, { admin: true, refresh: 0, readOnly: true, contextKey: 'c', notify: () => {} }));
      assert.equal(preview.querySelector('[aria-label="Rotuj klucz Sklep"]').disabled, true);
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
