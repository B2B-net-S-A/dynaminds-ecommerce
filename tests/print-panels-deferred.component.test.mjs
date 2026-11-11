// Screens must not pay for print options until the print panel is opened; each read runs the sealed guard chain.
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
const printOptions = /^\/print-jobs\/(?:label-batches\/)?options$/;
const flags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_write: true, can_manage: true };
const reads = [];
let listOrders = false; // the order list answers only once the menu walk is done (other screens read /orders too)
const recoveryKey = actor => 'dyna:original-recovery:v1:' + actor;
const order = { id: id(10), number: 'ZAM-1', created_at: '2026-11-01T10:00:00Z', customer_name: 'Klient', source: 'manual', status: 'paid', total: '10.00', currency: 'PLN' };
async function appFetch(url) {
  const p = new URL(String(url), 'http://127.0.0.1').pathname.replace(/^\/api/, '');
  reads.push(p);
  if (p === '/auth/me') return Response.json({ user });
  if (p === '/health') return Response.json({ schema_revision: 'test', restore_preview: false });
  if (p === '/workspaces') return Response.json({ data: [{ id: tenant, name: 'Firma' }] });
  if (p === '/orders' && listOrders) return Response.json({ data: [order], meta: { has_more: false, cursor: null } });
  if (p === '/print-jobs/options') return Response.json({ ...flags, stations: [], limits: {} });
  if (p === '/print-jobs/label-batches/options') return Response.json({ ...flags, batch_available: true, stations: [], printers: [], limits: {} });
  return Response.json({ detail: 'Kontrolowany brak modułu' }, { status: 503 });
}
const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }

test('screens read print options only after the print panel is opened', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const saved = new Map(), oldFetch = globalThis.fetch;
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
    globalThis.fetch = appFetch; api.setWorkspace(tenant);
    const container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(main.AppUnderTest))));
    await until(() => container.querySelector('.sidebar nav'), 'App is signed in');
    const click = async el => { await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); await tick(); await tick(); };
    const go = async (label, module) => navigateApp(container, label, click, module ?? undefined);
    const screens = await menuScreens(container, click);
    assert.ok(screens.some(e => e.label === 'Moduł magazyniera') && screens.length > 20, screens.map(e => e.label).join(', '));
    for (const { label, module } of screens) { await go(label, module); await returnToOffice(container, click); }
    assert.deepEqual(reads.filter(p => printOptions.test(p)), [], 'No screen reads print options on its own');

    // Uwagi v3 §3: the label batch panel lives in the bulk action bar, shown after selecting orders.
    listOrders = true;
    await go('Zamówienia');
    await until(() => container.querySelector('input.order-select[aria-label="Zaznacz ZAM-1"]'), 'The order list shows its row');
    assert.equal(container.querySelector('.ob-bar'), null, 'No bulk bar without a selection');
    await click(container.querySelector('input.order-select[aria-label="Zaznacz ZAM-1"]'));
    await until(() => container.querySelector('.ob-bar .ob-count')?.textContent === 'Zaznaczono 1', 'Selecting an order shows the bulk bar');
    assert.equal(container.querySelector('.shipment-label-batches'), null);
    assert.deepEqual(reads.filter(p => printOptions.test(p)), [], 'Selecting orders reads no print options');
    const button = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text));
    const print = button(container.querySelector('.ob-bar'), 'Drukuj');
    assert.ok(print && !print.disabled, 'Drukuj is available for the selection');
    await click(print);
    const labels = button(container.querySelector('.ob-menu'), 'Etykiety');
    assert.ok(labels && !labels.disabled, 'Drukuj ▾ offers Etykiety');
    await click(labels);
    await until(() => reads.includes('/print-jobs/label-batches/options'), 'Opening the panel reads its options');
    assert.ok(container.querySelector('.shipment-label-batches'));

    // An unreadable kept attempt locks printing; the only way out is inside the panel, so the panel opens itself.
    await act(async () => root.unmount()); container.replaceChildren();
    user.id = id(3);
    window.localStorage.setItem(recoveryKey(tenant + ':' + user.id), '{not json');
    reads.length = 0;
    root = createRoot(container);
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(main.AppUnderTest))));
    await until(() => container.querySelector('.sidebar nav'), 'App is signed in again');
    await go('Zamówienia');
    await until(() => container.querySelector('.shipment-label-batches'), 'A locked attempt opens the batch panel');
    assert.equal(container.querySelectorAll('input.order-select:checked').length, 0, 'The panel opens without a selection');
    assert.ok(reads.includes('/print-jobs/label-batches/options'), 'The opened panel reads its options');
  } finally {
    if (root) await act(async () => root.unmount());
    globalThis.fetch = oldFetch;
    if (vite) await vite.close();
    dom.window.close();
    for (const [key, d] of saved) if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key];
  }
});
