import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { navigateApp } from './app-nav-helper.mjs';

// Real App, WorkspaceSwitcher, navigation, B2bPanel and Products are mounted.
// Only the final browser bootstrap is removed. Controlled HTTP does not prove
// routing, migrations, native Chrome, database writes or commercial publication.
const id = n => `${n.toString(16).padStart(8, '0')}-1590-4159-8159-159159159159`;
const tenant = id(1), user = id(2), entityId = id(5);
const context = `${tenant}:${user}:admin:false`, digest = 'a'.repeat(64);
const stamp = '2026-10-07T09:00:00.000Z';
const catalog = {
  id: id(10), name: 'Katalog App B2B', active: true, is_default: true,
  version: '1', product_count: 1, created_at: stamp, updated_at: stamp,
  languages: ['pl', 'en'], default_language: 'pl',
  warehouse_ids: [id(20)], price_list_ids: [id(30)],
  settings: { name: 'Katalog App B2B', active: true, languages: ['pl', 'en'],
    default_language: 'pl', warehouse_ids: [id(20)], price_list_ids: [id(30)] },
};
const sourcePath = `/b2b/accounts/${entityId}/catalog-scope`;
function fixture() {
  const f = { reads: [], writes: [], switches: [], unexpected: [], receipts: new Map(), lost: true, current: tenant };
  const actors = new Map([
    [tenant, { id: user, tenant_id: tenant, role: 'admin', restore: false }],
    [id(3), { id: id(4), tenant_id: id(3), role: 'viewer', restore: false }],
    [id(6), { id: user, tenant_id: id(6), role: 'admin', restore: true }],
  ]);
  f.actor = () => actors.get(f.current);
  f.user = () => {
    const { restore, ...a } = f.actor();
    return { ...a, name: 'Kontrolowany operator App', tenant_name: 'Własna firma App', plan: 'pro', mfa_required: false };
  };
  f.flags = () => ({ available: true, read_only: f.actor().restore,
    current_role: f.actor().role, can_read: true,
    can_manage: f.actor().role === 'admin' && !f.actor().restore, can_read_inventory: true });
  f.entity = () => ({ id: entityId, name: 'Własne konto App B2B', version: '1', active: true,
    warehouse_id: id(20), price_list_id: id(30) });
  f.source = () => ({ ...f.flags(), source: { kind: 'supplier', entity_id: entityId,
    account: f.entity(), scope: null }, scope: null,
    resources: { catalogs: [catalog], warehouses: [{ id: id(20), name: 'MAIN', code: 'MAIN' }],
      price_lists: [{ id: id(30), name: 'Oferta PLN', currency: 'PLN', version: '1', active: true }],
      languages: ['pl', 'en'] },
    capabilities: { protocol: 'catalog_scope_v1', first_configuration_only: true,
      publication_available: false, import_available: false }, can_preview: f.flags().can_manage });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1');
    const p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (p !== '/health') assert.equal(new Headers(init.headers).get('X-Workspace-ID'), f.current, 'Actual api.ts workspace header');
    // Topbar bell of the v2 automation notifications (Uwagi v3 lane M, web/automation-v2-notifications.tsx)
    // polls on mount and every minute; it is outside this scenario, so it is answered and not recorded.
    if (method === 'GET' && p === '/automations/v2/notifications') return Response.json({ unread: 0, data: [] });
    if (method === 'GET') {
      f.reads.push({ path: p + u.search, tenant: f.current });
      if (p === '/auth/me') return Response.json({ user: f.user() });
      if (p === '/health') return Response.json({ restore_preview: f.actor().restore, b2b_catalog_scope_available: true });
      if (p === '/workspaces') return Response.json({ data: [
        { id: tenant, name: 'Własna firma App' },
        { id: id(3), name: 'Drugi aktor tylko do odczytu' },
        { id: id(6), name: 'Własna kopia odtworzona' },
      ] });
      // Ordinary controlled dashboard failure keeps actual App navigation.
      if (p === '/dashboard' || p === '/orders/status-counts') return Response.json({ detail: 'Controlled dashboard unavailable' }, { status: 503 });
      if (p === '/b2b/accounts') return Response.json({ data: [{ ...f.entity(),
        email: 'own@example.invalid', min_quantity: 1, quantity_step: 1 }], next: null });
      // 251 (B2B-004-X): the B2B panel reads the supplier decision inbox on mount; none is pending here.
      if (p === '/b2b/network/decisions') return Response.json({ data: [] });
      if (p === '/warehouses') return Response.json({ data: [{ id: id(20), name: 'MAIN', code: 'MAIN' }] });
      if (p === sourcePath) return Response.json(f.source());
      if (p === sourcePath + '/history') return Response.json({ ...f.flags(), data: [], next_cursor: null });
      if (p === '/product-catalogs/options') return Response.json({ ...f.flags(), catalogs: [catalog],
        warehouses: [{ id: id(20), name: 'MAIN', code: 'MAIN' }],
        price_lists: [{ id: id(30), name: 'Oferta PLN', currency: 'PLN', version: '1', active: true }],
        languages: ['pl', 'en'], capabilities: {}, limits: {} });
      if (p === '/language-file-imports/options') return Response.json({
        available: false, can_read: false, can_write: false, read_only: f.actor().restore,
        current_role: f.actor().role, locales: [], can_use_custom_locale: false,
        modes: ['columns', 'translations_json'], meta: { cursor: null },
        limits: { products: 500, locales: 6, pairs: 3000, page: 50, file_bytes: 2097152,
          request_bytes: 3145728, profiles: 100, history_per_tenant: 2000 },
      });
      if (p === '/products') return Response.json({ data: [{ id: id(40), sku: 'OWN-APP-B2B',
        name: 'Własny produkt App B2B', catalog_id: catalog.id, images: [], kind: 'simple',
        active: true, price: 1501, category: '', available: 3, reserved: 0, version: 1 }],
        meta: { has_more: false, cursor: null } });
    } else if (method === 'POST' && p === '/workspaces/switch') {
      const body = JSON.parse(init.body); assert.ok(actors.has(body.tenant_id));
      f.switches.push({ body, previous: f.current }); f.current = body.tenant_id;
      return Response.json({ user: f.user() });
    } else if (method === 'POST' && p === sourcePath + '/previews') {
      assert.equal(f.actor().restore, false); assert.equal(f.actor().role, 'admin');
      const body = JSON.parse(init.body);
      f.writes.push({ path: p, raw: init.body, body, tenant: f.current });
      let reply = f.receipts.get(body.client_key);
      if (reply) reply = { ...structuredClone(reply), reused: true };
      else {
        assert.equal(body.catalog_id, catalog.id); assert.equal(body.catalog_version, '1');
        assert.equal(body.account_version, '1'); assert.equal(body.warehouse_id, id(20));
        assert.equal(body.price_list_id, id(30)); assert.equal(body.language, 'en');
        reply = { ...f.flags(), reused: false, preview: {
          id: id(50), kind: 'supplier', entity_id: entityId, catalog_id: catalog.id,
          request: structuredClone(body), scope_hash: digest,
          snapshot: { protocol: 'catalog_scope_v1', kind: 'supplier', entity_id: entityId,
            scope_before: null, before: { id: entityId, version: '1', active: true,
              warehouse_id: id(20), price_list_id: id(30) }, catalog: structuredClone(catalog),
            resources: { warehouse: { id: id(20), name: 'MAIN', code: 'MAIN' },
              price_list: { id: id(30), version: '1', currency: 'PLN', active: true }, language: 'en' } },
          ready: true, can_commit: true, committed_operation_id: null,
          created_at: stamp, expires_at: new Date(Date.now() + 900000).toISOString(),
        } };
        f.receipts.set(body.client_key, structuredClone(reply));
      }
      if (f.lost) throw TypeError('Controlled lost preview ACK after stored receipt');
      return Response.json(reply, { status: 201 });
    }
    f.unexpected.push({ path: p, method });
    throw Error(`Unexpected controlled App request: ${method} ${p}`);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(check, note) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.ok(check(), note); }
function findButton(h, text) { const b = [...h.container.querySelectorAll('button')].find(b => b.textContent.trim() === text); assert.ok(b, text); return b; }
async function click(el) { assert.ok(el); assert.equal(el.matches(':disabled'), false); await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function select(el, selected) {
  assert.ok(el); assert.equal(el.matches(':disabled'), false);
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, selected); el.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function navigate(h, text) { await navigateApp(h.container, text, click); }

test('actual App B2B catalog actor lock and workspace navigation — controlled HTTP only', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const saved = new Map(), savedFetch = globalThis.fetch, savedError = console.error, keyWarnings = [];
  for (const [k, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, location: dom.window.location, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData, crypto: webcrypto,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value });
  }
  console.error = (...args) => {
    if (/same key|unique.*key/i.test(args.map(String).join(' '))) keyWarnings.push(args.map(String).join(' '));
    else savedError(...args);
  };
  const savedScroll = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const mainPath = path.resolve('web/main.tsx'), mounts = []; let vite;
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: 'custom', logLevel: 'error', plugins: [{ name: 'actual-app-without-browser-bootstrap', enforce: 'pre',
        transform(code, file) {
          if (file.split('?')[0] !== mainPath) return;
          const start = code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)");
          assert.ok(start > 0, 'Only the final App bootstrap is removed');
          return { code: code.slice(0, start) + '\nexport { App as AppUnderTest };\n', map: null };
        } }] });
    const { createRoot } = await import('react-dom/client');
    const main = await vite.ssrLoadModule(mainPath);
    const ui = await vite.ssrLoadModule(path.resolve('web/b2b-catalog-scope.tsx'));
    const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    async function mount(f) {
      globalThis.fetch = f.fetch; api.setWorkspace(tenant); ui.resetB2bCatalogScopeContext('');
      const container = document.createElement('div'); document.body.append(container);
      const root = createRoot(container), h = { container, async close() { await act(async () => root.unmount()); container.remove(); } };
      mounts.push(h);
      await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(main.AppUnderTest))));
      await until(() => container.querySelector('.sidebar nav'), 'Actual authenticated App'); return h;
    }
    async function scope(h) {
      await navigate(h, 'Kontrahenci B2B');
      await until(() => h.container.textContent.includes('Własne konto App B2B'), 'Actual account list');
      await click(findButton(h, 'Zakres katalogu B2B'));
      await until(() => h.container.querySelector('select[aria-label="Katalog dostawcy"]'), 'Actual scope caller');
      await until(() => !findButton(h, 'Odczytaj konfigurację B2B').matches(':disabled'), 'Scope read complete');
    }
    async function unknown(h, f) {
      await scope(h);
      for (const [label, val] of [['Katalog dostawcy', catalog.id], ['Magazyn dostępności', id(20)], ['Cennik oferty', id(30)], ['Język oferty', 'en']]) {
        await select(h.container.querySelector(`select[aria-label="${label}"]`), val);
      }
      await click(findButton(h, 'Przygotuj podgląd zakresu B2B'));
      await until(() => h.container.textContent.includes('Ponów dokładną próbę zakresu B2B')
        && !findButton(h, 'Ponów dokładną próbę zakresu B2B').matches(':disabled'), 'Unknown saved request');
      assert.equal(f.writes.length, 1); assert.equal(f.receipts.size, 1);
      assert.equal(ui.b2bCatalogScopeWriteLocked(context), true);
      assert.equal(ui.b2bCatalogScopeWriteLocked(`${tenant}:${user}:admin`), false, 'Legacy three-field context is not registry identity');
      assert.equal(ui.b2bCatalogScopeWriteLocked('supplier-scope:' + context), false, 'React key namespace is not actor identity');
    }
    async function products(h) {
      await navigate(h, 'Produkty'); await until(() => h.container.textContent.includes('Własny produkt App B2B')
        && h.container.querySelector('section.product-catalogs'), 'Actual Products mounted');
    }
    async function switchWorkspace(h, f, next) {
      const readStart = f.reads.length;
      await select(h.container.querySelector('select[aria-label="Aktywna organizacja"]'), next);
      await until(() => f.current === next && h.container.querySelector('select[aria-label="Aktywna organizacja"]')?.value === next
        && f.reads.slice(readStart).some(r => r.path === '/health' && r.tenant === next), 'Actual WorkspaceSwitcher and fresh health');
      await tick();
    }
    await t.test('navigation preserves unknown scope, disables fresh PIM after remount and permits own exact replay', async () => {
      const f = fixture(), h = await mount(f), warnings = keyWarnings.length;
      try {
        await unknown(h, f); const first = f.writes[0];
        await products(h); assert.equal(h.container.querySelector('select[aria-label="Katalog dostawcy"]'), null);
        assert.equal(findButton(h, 'Dodaj produkt').matches(':disabled'), true, 'App independently subscribes while B2B is unmounted');
        await navigate(h, 'Przegląd'); await products(h);
        assert.equal(findButton(h, 'Dodaj produkt').matches(':disabled'), true, 'Fresh PIM remains blocked after Products remount');
        assert.equal(ui.b2bCatalogScopeWriteLocked(context), true);
        await scope(h); await click(findButton(h, 'Odczytaj historię zakresu B2B'));
        await until(() => !findButton(h, 'Ponów dokładną próbę zakresu B2B').matches(':disabled'), 'History read completed');
        assert.equal(ui.b2bCatalogScopeWriteLocked(context), true, 'History GET cannot resolve unknown mutation');
        assert.equal(f.writes.length, 1, 'Navigation, mount and history cannot replay automatically');
        f.lost = false; await click(findButton(h, 'Ponów dokładną próbę zakresu B2B'));
        await until(() => !ui.b2bCatalogScopeWriteLocked(context) && h.container.textContent.includes('Podgląd zakresu do zapisania'), 'Own retry validates the frozen preview');
        assert.equal(f.writes.length, 2); assert.equal(f.writes[1].raw, first.raw); assert.equal(f.writes[1].path, first.path);
        assert.equal(f.receipts.size, 1, 'Replayed client key creates no second fixture preview');
        await products(h); assert.equal(findButton(h, 'Dodaj produkt').matches(':disabled'), false, 'Validated own retry releases the actual PIM control');
        assert.deepEqual(keyWarnings.slice(warnings), []); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('global reset purges unknown scope on actual actor/role switch while its panel is unmounted', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await unknown(h, f); await navigate(h, 'Przegląd');
        await switchWorkspace(h, f, id(3));
        assert.equal(ui.b2bCatalogScopeWriteLocked(context), false, 'Global App reset acts without B2B mounted');
        assert.equal(ui.b2bCatalogScopeWriteLocked(`${id(3)}:${id(4)}:viewer:false`), false);
        assert.equal(f.writes.length, 1);
        await scope(h); assert.equal(h.container.textContent.includes('Ponów dokładną próbę zakresu B2B'), false);
        assert.equal(findButton(h, 'Przygotuj podgląd zakresu B2B').matches(':disabled'), true, 'Viewer retains inspection only');
        await switchWorkspace(h, f, tenant); await scope(h);
        assert.equal(h.container.textContent.includes('Ponów dokładną próbę zakresu B2B'), false, 'Returning to actor does not resurrect purged request');
        assert.equal(f.writes.length, 1); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
    await t.test('actual restored-workspace health adds canonical readonly identity and purges pending without POST', async () => {
      const f = fixture(), h = await mount(f);
      try {
        await unknown(h, f); await navigate(h, 'Przegląd'); await switchWorkspace(h, f, id(6));
        await until(() => h.container.textContent.includes('Kopia odtworzona · tylko odczyt'), 'Actual App restore banner');
        assert.equal(ui.b2bCatalogScopeWriteLocked(context), false);
        assert.equal(ui.b2bCatalogScopeWriteLocked(`${id(6)}:${user}:admin:true`), false);
        await scope(h);
        assert.equal(h.container.textContent.includes('Ponów dokładną próbę zakresu B2B'), false);
        assert.equal(findButton(h, 'Przygotuj podgląd zakresu B2B').matches(':disabled'), true);
        assert.ok(f.reads.some(r => r.path === sourcePath && r.tenant === id(6)), 'Readonly scope still reads under the new workspace');
        assert.equal(f.writes.length, 1, 'Health, readonly mount and GET never issue mutations');
        await switchWorkspace(h, f, tenant); await scope(h);
        assert.equal(h.container.textContent.includes('Ponów dokładną próbę zakresu B2B'), false);
        assert.equal(f.writes.length, 1); assert.deepEqual(f.unexpected, []);
      } finally { await h.close(); }
    });
  } finally {
    try { for (const h of mounts) if (h.container.isConnected) await h.close(); }
    finally {
      try { if (vite) await vite.close(); }
      finally {
        dom.window.HTMLElement.prototype.scrollIntoView = savedScroll;
        globalThis.fetch = savedFetch; console.error = savedError; dom.window.close();
        for (const [k, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k]; }
      }
    }
  }
});
