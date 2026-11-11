// Real App: "Zmień konto" must end the server session. Clearing only the client showed the login form while the
// session cookie stayed valid, so a refresh or a new tab signed the previous person back in.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const id = n => `${String(n).padStart(8, '0')}-2026-4111-8111-111111111111`;
const tenant = id(1), user = { id: id(2), tenant_id: tenant, role: 'admin', name: 'Test', tenant_name: 'Firma', plan: 'pro', mfa_required: false };
const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }

async function withApp(logoutResponse, run) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const saved = new Map(), oldFetch = globalThis.fetch, logouts = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let vite, root;
  const mainPath = path.resolve('web/main.tsx');
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error', plugins: [{ name: 'app-without-bootstrap', enforce: 'pre', transform(code, file) { if (file.split('?')[0] !== mainPath) return; const start = code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)"); assert.ok(start > 0); return { code: code.slice(0, start) + '\nexport { App as AppUnderTest };\n', map: null }; } }] });
    const { createRoot } = await import('react-dom/client');
    const main = await vite.ssrLoadModule(mainPath), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    globalThis.fetch = async (url, init) => {
      const p = new URL(String(url), 'http://127.0.0.1').pathname.replace(/^\/api/, '');
      if (p === '/auth/logout') { logouts.push(init?.method); return logoutResponse(); }
      if (p === '/auth/me') return Response.json({ user });
      if (p === '/health') return Response.json({ schema_revision: 'test', restore_preview: false, workspace_mfa_available: true });
      if (p === '/workspaces') return Response.json({ data: [{ id: tenant, name: 'Firma' }] });
      return Response.json({ detail: 'Kontrolowany brak modułu' }, { status: 503 });
    };
    api.setWorkspace(tenant);
    const container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(main.AppUnderTest)));
    await until(() => container.querySelector('.sidebar nav'), 'App is signed in');
    const chooser = [...container.querySelectorAll('.sidebar-bottom button')].find(b => b.textContent.trim() === 'Zmień konto');
    assert.ok(chooser, 'Zmień konto button');
    await act(async () => chooser.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await tick();
    await run(container, logouts);
  } finally {
    if (root) await act(async () => root.unmount());
    globalThis.fetch = oldFetch;
    if (vite) await vite.close();
    dom.window.close();
    for (const [key, d] of saved) if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key];
  }
}

test('Zmień konto ends the server session before showing the login form', async () => {
  await withApp(() => Response.json({ ok: true }), async (container, logouts) => {
    assert.deepEqual(logouts, ['POST']);
    await until(() => container.querySelector('input[type="password"]'), 'Login form');
    assert.equal(container.querySelector('.sidebar nav'), null);
  });
});

test('a failed logout keeps the person signed in and says so', async () => {
  await withApp(() => Response.json({ detail: 'Błąd serwera' }, { status: 500 }), async (container, logouts) => {
    assert.deepEqual(logouts, ['POST']);
    assert.ok(container.querySelector('.sidebar nav'), 'Still signed in');
    assert.equal(container.querySelector('input[type="password"]'), null);
    await until(() => container.textContent.includes('Błąd serwera'), 'Error is shown');
  });
});
