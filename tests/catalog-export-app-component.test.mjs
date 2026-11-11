import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { navigateApp } from './app-nav-helper.mjs';

// The real App, navigation, Products siblings and export editors are mounted.
// Only its final browser bootstrap is removed. HTTP is controlled; this is not
// native browser, database, download or provider evidence.
const id = n => `${n.toString(16).padStart(8, '0')}-1580-4158-8158-158158158158`;
const tenant = id(1), user = id(2), context = `${tenant}:${user}:admin:false`;
const catalog = {
  id: id(10), name: 'Katalog testowy App', active: true, is_default: true,
  version: '2', product_count: 1, created_at: '2026-10-07T00:00:00Z',
  updated_at: '2026-10-07T00:00:00Z', warehouse_ids: [id(20)], price_list_ids: [],
  settings: { name: 'Katalog testowy App', active: true, languages: ['pl'],
    default_language: 'pl', warehouse_ids: [id(20)], price_list_ids: [] },
};
function fixture() {
  const f = { reads: [], posts: [], unexpected: [], malformed: true };
  const flags = { available: true, can_read: true, can_manage: true,
    current_role: 'admin', read_only: false };
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1');
    const p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (p !== '/health') assert.equal(new Headers(init.headers).get('X-Workspace-ID'), tenant);
    // Topbar bell of the v2 automation notifications (Uwagi v3 lane M, web/automation-v2-notifications.tsx)
    // polls on mount and every minute; it is outside this scenario, so it is answered and not recorded.
    if (method === 'GET' && p === '/automations/v2/notifications') return Response.json({ unread: 0, data: [] });
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: {
        id: user, tenant_id: tenant, role: 'admin', name: 'QA App',
        tenant_name: 'Own App fixture', plan: 'pro', mfa_required: false,
      } });
      if (p === '/health') return Response.json({ restore_preview: false });
      if (p === '/workspaces') return Response.json({ data: [{ id: tenant, name: 'Own App fixture' }] });
      // Dashboard data is outside this regression. Its ordinary error branch
      // leaves the actual App navigation available; no dashboard is mocked.
      if (p === '/dashboard' || p === '/orders/status-counts') return Response.json({ detail: 'Controlled dashboard unavailable' }, { status: 503 });
      if (p === '/product-catalogs/options') return Response.json({ ...flags,
        catalogs: [catalog], warehouses: [{ id: id(20), name: 'MAIN', code: 'MAIN' }],
        price_lists: [], languages: ['pl'], capabilities: {}, limits: {},
      });
      if (p === '/language-file-imports/options') return Response.json({
        available: false, can_read: false, can_write: false, read_only: false, current_role: 'admin',
        locales: [], can_use_custom_locale: false, modes: ['columns', 'translations_json'],
        meta: { cursor: null }, limits: { products: 500, locales: 6, pairs: 3000,
          page: 50, file_bytes: 2097152, request_bytes: 3145728,
          profiles: 100, history_per_tenant: 2000 },
      });
      if (p === '/products') return Response.json({
        data: [{ id: id(40), sku: 'OWN-APP', name: 'Własny produkt App', catalog_id: catalog.id,
          images: [], kind: 'simple', active: true, price: 1501, category: '',
          available: 3, reserved: 0, version: 1 }],
        meta: { has_more: false, cursor: null },
      });
      // Products loads its warehouse selector (web/catalog.tsx readCatalogWarehouses); same MAIN as the options.
      if (p === '/warehouses') return Response.json({ data: [{ id: id(20), name: 'MAIN', code: 'MAIN' }] });
      if (p === '/catalog/export-profiles') return Response.json({ ...flags, data: [], limit: 200 });
      if (p === '/catalog/exports/options') return Response.json({ ...flags,
        catalog_available: true, catalogs: [catalog], catalog: u.searchParams.has('catalog_id') ? catalog : null,
        catalog_currency: 'PLN', price_source: 'catalog', formats: ['csv', 'xml'],
        columns: [{ key: 'sku', label: 'SKU', type: 'text' }], default_columns: ['sku'],
        defaults: { format: 'csv', selection: 'filtered', active: 'all', spreadsheet_safe: true },
        product_logistics_available: false, product_translations_available: false,
        count: { matched_products: 1, capped: false },
        limits: { products: 100000, selected_products: 5000, batch_products: 500,
          request_bytes: 1048576, file_bytes: 67108864 },
        sources: { allow_inventory: false,
          warehouses: { available: true, capped: false, data: [{ id: id(20), name: 'MAIN', code: 'MAIN' }] },
          price_lists: { available: true, capped: false, data: [] } },
      });
    } else if (method === 'POST' && p === '/catalog/exports/preview') {
      f.posts.push({ path: p, method, raw: init.body, body: JSON.parse(init.body) });
      return Response.json({ count: { matched_products: 1, capped: false }, sample: [],
        catalog, catalog_version: catalog.version,
        ...(f.malformed ? {} : { scope_hash: 'a'.repeat(64) }) });
    }
    f.unexpected.push({ path: p, method });
    throw Error(`Unexpected controlled App request: ${method} ${p}`);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.ok(check(), label);
}
function button(container, text) {
  const found = [...container.querySelectorAll('button')].find(e => e.textContent.trim() === text);
  assert.ok(found, text); return found;
}
async function click(el) {
  assert.ok(el); assert.equal(el.matches(':disabled'), false);
  await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
async function navigate(h, text) {
  await navigateApp(h.container, text, click);
}

test('actual App Products keys and canonical export RAM across navigation', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const saved = new Map(), originalFetch = globalThis.fetch, originalError = console.error;
  const keyWarnings = [];
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    location: dom.window.location, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData,
    crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  console.error = (...args) => {
    if (/same key|unique.*key/i.test(args.map(String).join(' '))) keyWarnings.push(args.map(String).join(' '));
    else originalError(...args);
  };
  const oldScroll = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const mainPath = path.resolve('web/main.tsx');
  let vite;
  const mounts = [];
  try {
    vite = await createServer({
      server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error',
      plugins: [{ name: 'actual-app-without-browser-bootstrap', enforce: 'pre', transform(code, file) {
        if (file.split('?')[0] !== mainPath) return;
        const start = code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)");
        assert.ok(start > 0, 'Only the actual final App bootstrap is removed');
        return { code: code.slice(0, start) + '\nexport { App as AppUnderTest };\n', map: null };
      } }],
    });
    const { createRoot } = await import('react-dom/client');
    const main = await vite.ssrLoadModule(mainPath);
    const ui = await vite.ssrLoadModule(path.resolve('web/catalog-export.tsx'));
    const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    async function mount(f) {
      globalThis.fetch = f.fetch; api.setWorkspace(tenant); ui.resetCatalogExportContext('');
      const container = document.createElement('div'); document.body.append(container);
      const root = createRoot(container);
      const h = { container, async close() { await act(async () => root.unmount()); container.remove(); } };
      mounts.push(h);
      await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(main.AppUnderTest))));
      await until(() => container.querySelector('.sidebar nav'), 'Authenticated actual App navigation');
      return h;
    }
    async function products(h) {
      await navigate(h, 'Produkty');
      await until(() => h.container.textContent.includes('Własny produkt App')
        && h.container.querySelector('section.product-catalogs')
        && h.container.querySelector('section.language-file-import'), 'All actual Products siblings mounted');
    }
    await t.test('real Products siblings have no duplicate key on first render or remount', async () => {
      const f = fixture(), h = await mount(f), warningStart = keyWarnings.length;
      try {
        await products(h);
        assert.equal(h.container.querySelectorAll('section.product-catalogs').length, 1);
        assert.equal(h.container.querySelectorAll('section.language-file-import').length, 1);
        await navigate(h, 'Przegląd');
        assert.equal(h.container.querySelector('section.product-catalogs'), null);
        await products(h);
        assert.deepEqual(keyWarnings.slice(warningStart), [], 'Actual main sibling composition must not emit React key warnings');
        assert.deepEqual(f.posts, []); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('unknown preview retains canonical actor lock and exact body across real navigation', async () => {
      const f = fixture(), h = await mount(f), warningStart = keyWarnings.length;
      try {
        await products(h); await click(button(h.container, 'Eksport CSV / XML'));
        await until(() => h.container.querySelector('select[aria-label="Katalog do eksportu"]')?.options.length === 2, 'Export options');
        const select = h.container.querySelector('select[aria-label="Katalog do eksportu"]');
        await act(async () => { select.value = catalog.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
        await until(() => !button(h.container, 'Sprawdź zakres eksportu').disabled, 'Fresh catalog binding');
        await click(button(h.container, 'Sprawdź zakres eksportu'));
        await until(() => h.container.textContent.includes('Ponów dokładny odczyt eksportu'), 'Malformed successful response retained');
        assert.equal(f.posts.length, 1); assert.equal(f.posts[0].body.catalog_id, catalog.id);
        assert.equal(ui.catalogExportLocked(context), true, 'RAM identity is the canonical actor, without React key prefixes');
        assert.equal(ui.catalogExportLocked('product-catalogs:' + context), false);
        assert.equal(button(h.container, 'Dodaj produkt').disabled, true, 'Actual App subscribes to the canonical lock');
        await navigate(h, 'Przegląd');
        assert.equal(h.container.querySelector('section.product-catalogs'), null);
        assert.equal(ui.catalogExportLocked(context), true, 'Unmount does not erase the unresolved read');
        await products(h);
        assert.equal(button(h.container, 'Dodaj produkt').disabled, true);
        await click(button(h.container, 'Eksport CSV / XML'));
        await until(() => h.container.textContent.includes('Ponów dokładny odczyt eksportu')
          && !button(h.container, 'Ponów dokładny odczyt eksportu').disabled, 'Remounted actual caller restores the exact retry');
        assert.equal(f.posts.length, 1, 'Navigation, remount and metadata GET never retry automatically');
        f.malformed = false;
        await click(button(h.container, 'Ponów dokładny odczyt eksportu'));
        await until(() => !ui.catalogExportLocked(context) && !button(h.container, 'Dodaj produkt').disabled, 'Validated retry unlocks the actual App');
        assert.equal(f.posts.length, 2);
        assert.equal(f.posts[1].raw, f.posts[0].raw); assert.equal(f.posts[1].path, f.posts[0].path);
        assert.deepEqual(keyWarnings.slice(warningStart), []);
        assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
  } finally {
    try {
      for (const h of mounts) if (h.container.isConnected) await h.close();
    } finally {
      try { if (vite) await vite.close(); }
      finally {
        dom.window.HTMLElement.prototype.scrollIntoView = oldScroll;
        console.error = originalError; globalThis.fetch = originalFetch; dom.window.close();
        for (const [key, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
      }
    }
  }
});
