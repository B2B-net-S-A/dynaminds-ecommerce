import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual Purchasing/SupplierCatalog components with controlled HTTP. No native/provider/DB proof.
const id = (n) => `${n.toString(16).padStart(8, '0')}-1580-4158-8158-158158158158`;
const tenant = id(1), user = id(2), context = `${tenant}:${user}:admin:false`;
const supplier = id(3), entry = id(4), product = id(5), catalog = id(6), warehouse = id(7);
const flags = { available: true, can_read: true, can_manage: true, read_only: false, current_role: 'admin' };
const options = () => ({ ...flags, catalogs: [{ id: catalog, name: 'Własny katalog', active: true, is_default: true, version: '1', settings: { warehouse_ids: [warehouse] } }], warehouses: [], price_lists: [], languages: ['pl'] });
const source = { id: supplier, kind: 'file', name: 'Własny plik', supplier_name: 'Dostawca', currency: 'PLN', max_handling_days: 3, version: 1, paused: false };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(linked = false) {
  const f = { reads: [], writes: [], holdAuth: null, holdOptions: null, linked };
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    assert.equal(new Headers(init.headers).get('X-Workspace-ID'), tenant);
    if (method === 'GET') {
      f.reads.push(p);
      if (p === '/auth/me') return f.holdAuth ? f.holdAuth.promise : Response.json({ user: { tenant_id: tenant, id: user, role: 'admin' } });
      if (p === '/product-catalogs/options') return f.holdOptions ? f.holdOptions.promise : Response.json(options());
      if (p === '/supplier-file-sources/options') return Response.json({ ...flags, available: false, can_write: false, limits: {} });
      if (p === '/purchase-orders') return Response.json({ data: [], meta: { cursor: null } });
      if (p === '/supplier-sources') return Response.json({ data: [source], meta: { cursor: null } });
      if (p === '/supplier-sources/' + supplier) return Response.json(source);
      if (p === '/warehouses') return Response.json({ data: [{ id: warehouse, name: 'MAIN', code: 'MAIN' }] });
      if (p === '/workspaces/settings') return Response.json({ tenant: { currency: 'PLN' } });
      if (p === '/supplier-catalog') return Response.json({ data: [{ id: entry, version: 1, sku: 'REMOTE', name: 'Produkt dostawcy', product_id: f.linked ? product : null, local_sku: 'OWN', currency: 'PLN', remote_product_id: 'EXT', snapshot: { unit_cost: 700, quantity: 900, tiers: [], active: true }, refreshed_at: '2026-10-06T12:00:00Z' }], meta: { cursor: null } });
      if (p === '/products') return Response.json({ data: [{ id: product, sku: 'OWN', name: 'Produkt lokalny', kind: 'simple', active: true, catalog_id: catalog }], meta: { cursor: null } });
      throw Error('Unexpected controlled GET ' + p);
    }
    f.writes.push({ path: p, method, body: JSON.parse(init.body) });
    if (p === '/supplier-catalog/' + entry + '/product' || p === '/supplier-catalog/' + entry + '/link') return Response.json({ id: product, catalog_id: catalog });
    throw Error('Unexpected controlled mutation ' + p);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function until(predicate, note) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.ok(predicate(), note); }
function button(h, label) { const b = [...h.container.querySelectorAll('button')].find((n) => n.textContent.trim() === label); assert.ok(b, label); return b; }
function named(h, label) { const n = h.container.querySelector(`[aria-label="${label}"]`); assert.ok(n, label); return n; }
function field(h, text) { const l = [...h.container.querySelectorAll('label')].find((n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim() === text); assert.ok(l, text); return l.querySelector('input'); }
async function click(el) { assert.equal(el.matches(':disabled'), false); await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(el, v) { const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }

test('supplier PIM export locking in mounted Purchasing', async (t) => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), saved = new Map(), originalFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), { Purchasing } = await vite.ssrLoadModule(path.resolve('web/purchasing.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts')), exports = await vite.ssrLoadModule(path.resolve('web/catalog-export.tsx')), profiles = await vite.ssrLoadModule(path.resolve('web/catalog-export-profiles.tsx')), catalogs = await vite.ssrLoadModule(path.resolve('web/product-catalogs.tsx'));
  const mounts = [];
  async function mount(f, props = {}) {
    globalThis.fetch = f.fetch; api.setWorkspace(tenant); exports.resetCatalogExportContext(''); exports.resetCatalogExportContext(context); catalogs.resetProductCatalogsContext(''); catalogs.resetProductCatalogsContext(context);
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { contextKey: context, readOnly: false, admin: true, refresh: 0, reload() {}, notify() {}, ...props }, async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(Purchasing, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } };
    mounts.push(h); await h.render();
    await until(() => named(h, 'Źródło hurtowni').options.length === 2, 'sources loaded'); await value(named(h, 'Źródło hurtowni'), supplier);
    await until(() => h.container.textContent.includes('Pozycja REMOTE'), 'supplier row'); await click(button(h, 'Pozycja REMOTE'));
    await until(() => h.container.textContent.includes('Własny katalog') || f.linked, 'catalog options');
    return h;
  }
  async function prepare(h) { await act(async () => h.container.querySelector('[role="dialog"] details').setAttribute('open', '')); await value(named(h, 'Katalog nowego produktu'), catalog); await value(named(h, 'Magazyn nowego produktu'), warehouse); await value(field(h, 'Cena sprzedaży (PLN)'), '17.00'); }
  try {
    await t.test('Purchasing forwards PIM-only block while preserving source reads and modal close', async () => {
      const f = fixture(), h = await mount(f, { productWriteBlocked: true }); await prepare(h);
      assert.equal(button(h, 'Utwórz produkt ze stanem zero').disabled, true); assert.equal(button(h, 'Powiąż produkt').disabled, true); assert.equal(named(h, 'Źródło hurtowni').disabled, false);
      await click(button(h, 'Odśwież katalog')); await click(button(h, 'Wróć')); assert.equal(h.container.querySelector('[role="dialog"]'), null); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('PIM-only block prevents unlink but keeps purchase control available', async () => {
      const f = fixture(true), h = await mount(f, { productWriteBlocked: true });
      assert.equal(button(h, 'Usuń powiązanie produktu').disabled, true); assert.equal(button(h, 'Utwórz zakup').matches(':disabled'), false); assert.equal(button(h, 'Wróć').disabled, false); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('new sibling lock during creation permission read prevents fresh product POST', async () => {
      const f = fixture(), h = await mount(f); await prepare(h); const held = deferred(); f.holdOptions = held; const reads = f.reads.filter((p) => p === '/product-catalogs/options').length;
      await click(button(h, 'Utwórz produkt ze stanem zero')); await until(() => f.reads.filter((p) => p === '/product-catalogs/options').length > reads, 'held creation options'); await h.render({ productWriteBlocked: true });
      await act(async () => { held.resolve(Response.json(options())); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Zapis nie został wysłany'), 'current lock refusal'); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('export registry lock arriving after auth read prevents link even before forwarded state', async () => {
      const f = fixture(), h = await mount(f); await until(() => named(h, 'Produkt lokalny').options.length === 2, 'own product choices'); await value(named(h, 'Produkt lokalny'), product); const held = deferred(); f.holdAuth = held;
      await click(button(h, 'Powiąż produkt')); await until(() => f.reads.includes('/auth/me'), 'held link actor read');
      await act(async () => profiles.setCatalogExportReadLocked(context, true));
      await act(async () => { held.resolve(Response.json({ user: { tenant_id: tenant, id: user, role: 'admin' } })); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Powiązanie nie zostało wysłane'), 'immediate module lock'); assert.equal(f.writes.length, 0);
      profiles.setCatalogExportReadLocked(context, false); await h.close();
    });
    await t.test('unblocked fresh link keeps original version/product payload and canonical auth identity', async () => {
      const f = fixture(), h = await mount(f); await until(() => named(h, 'Produkt lokalny').options.length === 2, 'own product choices'); await value(named(h, 'Produkt lokalny'), product); await click(button(h, 'Powiąż produkt'));
      await until(() => f.writes.length === 1 && !h.container.querySelector('[role="dialog"]'), 'link response'); assert.deepEqual(f.writes[0], { path: '/supplier-catalog/' + entry + '/link', method: 'PATCH', body: { version: 1, product_id: product } }); assert.ok(f.reads.includes('/auth/me')); await h.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    exports.resetCatalogExportContext(''); catalogs.resetProductCatalogsContext(''); await vite.close(); dom.window.close(); globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
