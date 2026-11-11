// Real App, every menu screen (module or option of its panel, Uwagi v3 §2): leaving a screen must remove its panels, and no screen may render
// two siblings with one React key. React drops one of them from reconciliation, so its DOM outlives
// the screen until the page reloads, and the production build reports nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { menuScreens, navigateApp, returnToOffice } from './app-nav-helper.mjs';

const id = n => `${String(n).padStart(8, '0')}-2026-4111-8111-111111111111`;
const tenant = id(1), user = { id: id(2), tenant_id: tenant, role: 'admin', name: 'Test', tenant_name: 'Firma', plan: 'pro', mfa_required: false };

async function appFetch(url) {
  const p = new URL(String(url), 'http://127.0.0.1').pathname.replace(/^\/api/, '');
  if (p === '/auth/me') return Response.json({ user });
  if (p === '/health') return Response.json({ schema_revision: 'test', restore_preview: false, workspace_mfa_available: true });
  if (p === '/workspaces') return Response.json({ data: [{ id: tenant, name: 'Firma' }] });
  return Response.json({ detail: 'Kontrolowany brak modułu' }, { status: 503 });
}
const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }

test('leaving any screen removes its panels and no screen repeats a sibling key', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const saved = new Map(), oldFetch = globalThis.fetch, oldError = console.error, duplicates = new Set();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  console.error = (...args) => { if (String(args[0]).includes('same key')) duplicates.add(String(args[1]) + ' · ' + screen); };
  let screen = 'start', vite, root;
  const mainPath = path.resolve('web/main.tsx');
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error', plugins: [{ name: 'app-without-bootstrap', enforce: 'pre', transform(code, file) { if (file.split('?')[0] !== mainPath) return; const start = code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)"); assert.ok(start > 0); return { code: code.slice(0, start) + '\nexport { App as AppUnderTest };\n', map: null }; } }] });
    const { createRoot } = await import('react-dom/client');
    const main = await vite.ssrLoadModule(mainPath), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    globalThis.fetch = appFetch; api.setWorkspace(tenant);
    const container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(main.AppUnderTest))));
    await until(() => container.querySelector('.sidebar nav'), 'App is signed in');
    const click = async el => { await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); await tick(); };
    const screens = await menuScreens(container, click);
    const labels = screens.map(e => e.label);
    const targets = ['Reguły i statusy własne', 'Organizacja i konto', 'Wiadomości klientów'];
    assert.ok(targets.every(n => labels.includes(n)) && labels.length > 20, labels.join(', '));
    const go = async ({ label, module }) => { screen = label; await navigateApp(container, label, click, module ?? undefined); await tick(); };
    const stale = [], own = () => [...container.querySelector('main').children].filter(e => e.tagName !== 'FOOTER' && !e.classList.contains('page-heading'));
    for (const from of screens) for (const to of targets.filter(n => n !== from.label).map(n => screens.find(e => e.label === n))) {
      await go(from);
      // The packer app replaces the whole shell (no <main> to keep panels in); come back and skip it.
      if (await returnToOffice(container, click)) break;
      const panels = own();
      await go(to);
      for (const panel of panels) if (panel.isConnected) stale.push(from.label + ' → ' + to.label + ': ' + panel.tagName + '.' + panel.className);
    }
    assert.deepEqual(stale, [], 'Screens that kept a panel of the previous screen');
    assert.deepEqual([...duplicates], [], 'React key collisions');
  } finally {
    if (root) await act(async () => root.unmount());
    console.error = oldError; globalThis.fetch = oldFetch;
    if (vite) await vite.close();
    dom.window.close();
    for (const [key, d] of saved) if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key];
  }
});
