import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act, useEffect, useState } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual CatalogPanel + export children. Controlled HTTP and a small App-like
// subscription host prove caller identity/DOM blocking; no native or DB proof.
const id = n => `${n.toString(16).padStart(8, '0')}-1580-4158-8158-158158158158`;
const tenant = id(1), user = id(2), context = `${tenant}:${user}:admin:false`;
const hash = 'a'.repeat(64);
const cat = { id: id(10), name: 'Katalog własny', active: true, is_default: true, version: '2', warehouse_ids: [id(20)], price_list_ids: [] };
function fixture() {
  const f = { tenant, user, role: 'admin', reads: [], posts: [], profiles: [], malformed: true, profileAccessHold: null };
  f.flags = () => ({ available: true, can_read: true, can_manage: f.role === 'admin', read_only: false, current_role: f.role });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    assert.equal(new Headers(init.headers).get('X-Workspace-ID'), f.tenant);
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: { tenant_id: f.tenant, id: f.user, role: f.role } });
      if (p === '/product-catalogs/options') return Response.json({ ...f.flags(), catalogs: [{ ...cat, settings: { name: cat.name, active: true, languages: ['pl'], default_language: 'pl', warehouse_ids: cat.warehouse_ids, price_list_ids: [] } }] });
      if (p === '/products') return Response.json({ data: [{ id: id(40), sku: 'OWN-SKU', name: 'Własny produkt', catalog_id: cat.id, images: [], kind: 'simple', active: true, price: 1501, category: '', available: 3, reserved: 0, version: 1 }], meta: { has_more: false, cursor: null } });
      if (p === '/catalog/export-profiles') { if (f.profileAccessHold) return f.profileAccessHold.promise; return Response.json({ ...f.flags(), data: f.profiles, limit: 200 }); }
      if (p === '/catalog/exports/options') return Response.json({ ...f.flags(), catalog_available: true, catalogs: [cat], catalog: u.searchParams.has('catalog_id') ? cat : null, catalog_currency: 'PLN', price_source: 'catalog', formats: ['csv', 'xml'], columns: [{ key: 'sku', label: 'SKU', type: 'text' }], default_columns: ['sku'], defaults: { format: 'csv', selection: 'filtered', active: 'all', spreadsheet_safe: true }, product_logistics_available: false, product_translations_available: false, count: { matched_products: 1, capped: false }, limits: { products: 100000, selected_products: 5000, batch_products: 500, request_bytes: 1048576, file_bytes: 67108864 }, sources: { allow_inventory: false, warehouses: { available: true, capped: false, data: [{ id: id(20), name: 'MAIN', code: 'MAIN' }] }, price_lists: { available: true, capped: false, data: [] } } });
      throw Error('Unexpected controlled GET ' + p);
    }
    const body = JSON.parse(init.body);
    f.posts.push({ path: p, method, raw: init.body, body });
    if (p === '/catalog/export-profiles' && method === 'POST') {
      const profile = { id: id(50), version: 1, name: body.name, definition: body.definition, archived: false };
      f.profiles.push(profile); return Response.json({ ...f.flags(), profile, reused: false }, { status: 201 });
    }
    assert.equal(p, '/catalog/exports/preview', 'No sibling business write');
    return Response.json({ count: { matched_products: 1, capped: false }, sample: [], catalog: cat, catalog_version: cat.version, ...(f.malformed ? {} : { scope_hash: hash }) });
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }
function button(h, text) { const el = [...h.container.querySelectorAll('button')].find(e => e.textContent.trim() === text); assert.ok(el, text); return el; }
async function click(el) { assert.equal(el.disabled, false); assert.equal(el.matches(':disabled'), false, 'No disabled ancestor fieldset'); await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(el, val) { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, val); el.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function input(el, val) { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })); }); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('catalog export caller and independent pending subscription', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), saved = new Map(), originalFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const oldScroll = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client');
  const catalog = await vite.ssrLoadModule(path.resolve('web/catalog.tsx'));
  const ui = await vite.ssrLoadModule(path.resolve('web/catalog-export.tsx'));
  const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  function Host({ scope, workspaceId, actorId, show = true, external = false, readOnly = false }) {
    const [locked, setLocked] = useState(false);
    useEffect(() => { ui.resetCatalogExportContext(scope); return ui.subscribeCatalogExportLock(scope, setLocked); }, [scope]);
    return React.createElement(React.Fragment, null,
      React.createElement('output', { 'data-testid': 'global-export-lock' }, String(locked)),
      show && React.createElement(catalog.CatalogPanel, { key: scope, contextKey: scope, workspaceId, actorId, readOnly, admin: scope.split(':')[2] === 'admin', refresh: 0, search: '', setSearch() {}, reload() {}, notify() {}, externalWriteBlocked: external || locked, exportExternalWriteBlocked: external, onExportLockedChange: setLocked }),
    );
  }
  async function mount() {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { scope: context, workspaceId: tenant, actorId: user }, async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(Host, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } };
    mounts.push(h); await h.render(); return h;
  }
  async function prepare(h) {
    await until(() => h.container.textContent.includes('Własny produkt'), 'catalog list');
    await click(button(h, 'Eksport CSV / XML'));
    await until(() => h.container.querySelector('select[aria-label="Katalog do eksportu"]')?.options.length === 2, 'export options');
    await value(h.container.querySelector('select[aria-label="Katalog do eksportu"]'), cat.id);
    await until(() => !button(h, 'Sprawdź zakres eksportu').disabled, 'fresh catalog binding');
    await click(button(h, 'Sprawdź zakres eksportu'));
    await until(() => h.container.textContent.includes('Ponów dokładny odczyt eksportu'), 'malformed reply retained');
  }
  try {
    await t.test('a fresh profile write publishes the sibling lock without blocking its own POST after fresh access', async () => {
      const f = fixture(); globalThis.fetch = f.fetch; api.setWorkspace(tenant); ui.resetCatalogExportContext(''); ui.resetCatalogExportContext(context);
      const h = await mount(); await until(() => h.container.textContent.includes('Własny produkt'), 'catalog list'); await click(button(h, 'Eksport CSV / XML'));
      await until(() => h.container.querySelector('select[aria-label="Katalog do eksportu"]')?.options.length === 2, 'export options');
      await value(h.container.querySelector('select[aria-label="Katalog do eksportu"]'), cat.id);
      await until(() => !button(h, 'Sprawdź zakres eksportu').disabled, 'fresh catalog binding');
      const name = [...h.container.querySelectorAll('label')].find(e => e.textContent.trim().startsWith('Nazwa nowego profilu'))?.querySelector('input'); assert.ok(name); await input(name, 'Profil własnego katalogu');
      const held = deferred(); f.profileAccessHold = held;
      await click(button(h, 'Zapisz bieżące ustawienia jako nowy profil'));
      await until(() => h.container.querySelector('[data-testid="global-export-lock"]').textContent === 'true', 'fresh profile publishes lock during access read');
      assert.equal(f.posts.length, 0);
      assert.equal(h.container.querySelector('fieldset[aria-label="Pozostałe edytory katalogu"]').disabled, true);
      f.profileAccessHold = null;
      await act(async () => { held.resolve(Response.json({ ...f.flags(), data: [], limit: 200 })); await Promise.resolve(); });
      await until(() => f.posts.length === 1 && !ui.catalogExportLocked(context), 'initial profile POST confirmed despite its own shared lock');
      assert.equal(f.posts[0].path, '/catalog/export-profiles'); assert.equal(f.posts[0].body.definition.catalog_id, cat.id);
      assert.equal(f.profiles.length, 1); await h.close();
    });
    await t.test('a genuine sibling block arriving during profile preflight still prevents the first POST', async () => {
      const f = fixture(); globalThis.fetch = f.fetch; api.setWorkspace(tenant); ui.resetCatalogExportContext(''); ui.resetCatalogExportContext(context);
      const h = await mount(); await until(() => h.container.textContent.includes('Własny produkt'), 'catalog list'); await click(button(h, 'Eksport CSV / XML'));
      await until(() => h.container.querySelector('select[aria-label="Katalog do eksportu"]')?.options.length === 2, 'export options');
      await value(h.container.querySelector('select[aria-label="Katalog do eksportu"]'), cat.id);
      await until(() => !button(h, 'Sprawdź zakres eksportu').disabled, 'fresh catalog binding');
      const name = [...h.container.querySelectorAll('label')].find(e => e.textContent.trim().startsWith('Nazwa nowego profilu'))?.querySelector('input'); assert.ok(name); await input(name, 'Profil odroczony');
      const held = deferred(); f.profileAccessHold = held;
      await click(button(h, 'Zapisz bieżące ustawienia jako nowy profil'));
      await until(() => h.container.querySelector('[data-testid="global-export-lock"]').textContent === 'true', 'own profile admission');
      await h.render({ external: true }); f.profileAccessHold = null;
      await act(async () => { held.resolve(Response.json({ ...f.flags(), data: [], limit: 200 })); await Promise.resolve(); });
      await until(() => h.container.textContent.includes('Zapis profilu nie został wysłany.'), 'actual sibling block rechecked after reads');
      assert.equal(f.posts.length, 0); assert.equal(ui.catalogExportLocked(context), false, 'Known preflight refusal clears only the unsent attempt');
      assert.equal(h.container.querySelector('fieldset[aria-label="Pozostałe edytory katalogu"]').disabled, true); await h.close();
    });
    await t.test('canonical role permits preflight; pending survives close/navigation and own retry is outside disabled siblings', async () => {
      const f = fixture(); globalThis.fetch = f.fetch; api.setWorkspace(tenant); ui.resetCatalogExportContext(''); ui.resetCatalogExportContext(context);
      const h = await mount(); await prepare(h);
      assert.equal(f.posts.length, 1, 'Actual caller reached preview POST instead of boolean-role403');
      assert.equal(f.posts[0].body.catalog_id, cat.id);
      assert.equal(h.container.querySelector('[data-testid="global-export-lock"]').textContent, 'true');
      assert.equal(h.container.querySelector('fieldset[aria-label="Lista i pozostałe operacje katalogu"]').disabled, true);
      assert.equal(h.container.querySelector('fieldset[aria-label="Pozostałe edytory katalogu"]').disabled, true);
      assert.equal(button(h, 'Ponów dokładny odczyt eksportu').matches(':disabled'), false);
      await click(button(h, 'Zamknij eksport'));
      assert.equal(ui.catalogExportLocked(context), true);
      await click(button(h, 'Eksport CSV / XML'));
      await until(() => h.container.textContent.includes('Ponów dokładny odczyt eksportu'), 'reopened retained export');
      await h.render({ show: false }); assert.equal(h.container.querySelector('[data-testid="global-export-lock"]').textContent, 'true');
      await h.render({ show: true, external: true }); await click(button(h, 'Eksport CSV / XML'));
      await until(() => h.container.textContent.includes('Ponów dokładny odczyt eksportu') && !button(h, 'Ponów dokładny odczyt eksportu').disabled, 'retained attempt through CatalogPanel remount');
      assert.equal(f.posts.length, 1, 'Reads and remount never replay automatically'); f.malformed = false;
      await click(button(h, 'Ponów dokładny odczyt eksportu')); await until(() => !ui.catalogExportLocked(context), 'exact read resolved');
      assert.equal(f.posts.length, 2); assert.equal(f.posts[1].raw, f.posts[0].raw); assert.equal(f.posts[1].path, f.posts[0].path);
      assert.equal(h.container.querySelector('[data-testid="global-export-lock"]').textContent, 'false');
      assert.equal(h.container.querySelector('fieldset[aria-label="Pozostałe edytory katalogu"]').disabled, true, 'Unrelated block remains actual external flag');
      await h.render({ external: false }); assert.equal(h.container.querySelector('fieldset[aria-label="Pozostałe edytory katalogu"]').disabled, false); await h.close();
    });
    await t.test('actor replacement purges the old retry without making a business request', async () => {
      const f = fixture(); globalThis.fetch = f.fetch; api.setWorkspace(tenant); ui.resetCatalogExportContext(''); ui.resetCatalogExportContext(context);
      const h = await mount(); await prepare(h);
      f.tenant = id(90); f.user = id(91); f.role = 'viewer'; api.setWorkspace(f.tenant);
      const next = `${f.tenant}:${f.user}:viewer:true`; await h.render({ workspaceId: f.tenant, actorId: f.user, scope: next, readOnly: true });
      assert.equal(ui.catalogExportLocked(context), false); assert.equal(ui.catalogExportLocked(next), false);
      await click(button(h, 'Eksport CSV / XML')); await until(() => h.container.textContent.includes('Tryb tylko do odczytu'), 'fresh read-only actor');
      assert.ok(!h.container.textContent.includes('Ponów dokładny odczyt eksportu')); assert.equal(f.posts.length, 1); await h.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    await vite.close(); dom.window.HTMLElement.prototype.scrollIntoView = oldScroll; dom.window.close(); globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
