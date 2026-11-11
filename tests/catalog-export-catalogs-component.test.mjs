import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual mounted export/profile components with controlled HTTP and browser download sink.
// Export preview/file are separate read-only snapshots, NOT durable exactly-once executions.
const id = (n) => `${n.toString(16).padStart(8, '0')}-1580-4158-8158-158158158158`;
const tenant = id(1), user = id(2), context = `${tenant}:${user}:admin:false`, hash = 'a'.repeat(64);
const catalogs = () => [
  { id: id(10), name: 'Główny katalog', active: true, is_default: true, version: '2', warehouse_ids: [id(20)], price_list_ids: [id(30)] },
  { id: id(11), name: 'Drugi katalog', active: true, is_default: false, version: '4', warehouse_ids: [id(21)], price_list_ids: [id(31)] },
  { id: id(12), name: 'Archiwalny katalog', active: false, is_default: false, version: '1', warehouse_ids: [id(20)], price_list_ids: [] },
];
const warehouses = [{ id: id(20), name: 'MAIN', code: 'MAIN' }, { id: id(21), name: 'SECOND', code: 'SECOND' }];
const priceLists = [{ id: id(30), name: 'Detal', currency: 'PLN', active: true, version: 1, fallback: false }, { id: id(31), name: 'Europa', currency: 'EUR', active: true, version: 2, fallback: false }];
const definition = (cat = id(11)) => ({ format: 'csv', columns: ['sku', 'inventory_json', 'prices_json'], headers: {}, spreadsheet_safe: true, catalog_id: cat, warehouse_ids: [cat === id(10) ? id(20) : id(21)], price_list_ids: [cat === id(10) ? id(30) : id(31)] });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const f = { tenant, user, role: 'admin', available: true, catalogs: catalogs(), defaultColumns: ['sku', 'inventory_json', 'prices_json'], reads: [], posts: [], profiles: [], profileDetail: null, profileReceipts: new Map(), malformedProfile: false, malformedPreview: false, lostFile: false, heldCatalog: null, heldOptions: null };
  f.flags = () => ({ available: true, can_read: true, can_manage: f.role === 'admin', current_role: f.role, read_only: false });
  f.options = (cat = null) => {
    const selected = f.catalogs.find((c) => c.id === cat) ?? null;
    return { ...f.flags(), catalog_available: f.available, catalogs: f.available ? structuredClone(f.catalogs) : [], catalog: selected ? structuredClone(selected) : null, catalog_currency: 'PLN', price_source: 'catalog', formats: ['csv', 'xml'], columns: [{ key: 'sku', label: 'SKU', type: 'text' }, { key: 'inventory_json', label: 'Stany magazynowe', type: 'json' }, { key: 'prices_json', label: 'Ceny z cenników', type: 'json' }], default_columns: f.defaultColumns, defaults: { format: 'csv', selection: 'filtered', active: 'all', spreadsheet_safe: true }, product_logistics_available: true, product_translations_available: true, count: { matched_products: 1, capped: false }, limits: { products: 100000, selected_products: 5000, batch_products: 500, request_bytes: 1048576, file_bytes: 67108864 }, sources: { allow_inventory: true, warehouses: { available: true, capped: false, data: structuredClone(warehouses.filter((w) => !selected || selected.warehouse_ids.includes(w.id))) }, price_lists: { available: true, capped: false, data: structuredClone(priceLists.filter((p) => !selected || selected.price_list_ids.includes(p.id))) } } };
  };
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    assert.equal(new Headers(init.headers).get('X-Workspace-ID'), f.tenant);
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: { id: f.user, tenant_id: f.tenant, role: f.role } });
      if (p === '/catalog/exports/options') {
        const cat = u.searchParams.get('catalog_id');
        if (f.heldOptions) return f.heldOptions.promise;
        if (f.heldCatalog?.catalog === cat) return f.heldCatalog.promise;
        if (cat && !f.catalogs.find((c) => c.id === cat)?.active) return Response.json({ detail: 'Katalog eksportu jest nieaktywny' }, { status: 409 });
        return Response.json(f.options(cat));
      }
      if (p === '/catalog/export-profiles') return Response.json({ ...f.flags(), data: structuredClone(f.profiles), limit: 200 });
      if (p.startsWith('/catalog/export-profiles/')) return Response.json({ ...f.flags(), profile: structuredClone(f.profileDetail ?? f.profiles.find((v) => v.id === p.split('/').at(-1))) });
      throw Error('Unexpected controlled GET ' + p);
    }
    const body = JSON.parse(init.body); f.posts.push({ path: p, method, raw: init.body, body });
    if (p === '/catalog/exports/preview') {
      const catalog = f.catalogs.find((c) => c.id === body.catalog_id);
      return Response.json({ count: { matched_products: 1, capped: false }, sample: [{ product_id: id(40), sku: 'OWN-SECOND', name: 'Własny produkt', inventory_json: [{ warehouse_id: id(21), warehouse_name: 'SECOND', on_hand: 5, reserved: 2, available: 3, source: 'stock', status: 'available' }], prices_json: [{ price_list_id: id(31), price_list_name: 'Europa', own_price_minor: 0, effective_price_minor: 0, currency: 'EUR', source: 'override', status: 'available' }] }], ...(catalog ? { catalog: structuredClone(catalog), catalog_version: catalog.version, scope_hash: f.malformedPreview ? undefined : hash } : {}) });
    }
    if (p === '/catalog/exports/file') {
      if (f.lostFile) throw TypeError('Controlled interrupted file read');
      const cat = f.catalogs.find((c) => c.id === body.catalog_id);
      if (cat && body.catalog_version !== cat.version) return Response.json({ detail: 'Konfiguracja katalogu zmieniła się; odczytaj nowy podgląd' }, { status: 409 });
      const bytes = 'sku\r\nOWN-SECOND\r\n';
      return new Response(bytes, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': String(new TextEncoder().encode(bytes).byteLength), ...(cat ? { 'X-Product-Catalog-ID': cat.id, 'X-Product-Catalog-Version': cat.version, 'X-Catalog-Export-Scope-Hash': hash } : {}) } });
    }
    if (p === '/catalog/export-profiles' && method === 'POST') {
      let profile = f.profileReceipts.get(body.client_key), reused = Boolean(profile);
      if (!profile) { profile = { id: id(50), name: body.name, version: 1, definition: structuredClone(body.definition), archived: false }; f.profileReceipts.set(body.client_key, profile); f.profiles.push(profile); }
      const reply = structuredClone(profile);
      if (f.malformedProfile) reply.definition.catalog_id = id(10);
      return Response.json({ ...f.flags(), profile: reply, reused });
    }
    throw Error('Unexpected controlled mutation ' + p);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function until(predicate, note) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.ok(predicate(), note); }
function button(h, text) { const b = [...h.container.querySelectorAll('button')].find((v) => v.textContent.trim() === text); assert.ok(b, text); return b; }
function field(h, text) { const l = [...h.container.querySelectorAll('label')].find((v) => [...v.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim() === text); const control = l?.querySelector('input,select'); assert.ok(control, text); return control; }
function check(h, text) { const l = [...h.container.querySelectorAll('label')].find((v) => v.textContent.trim().startsWith(text)); const input = l?.querySelector('input[type=checkbox]'); assert.ok(input, text); return input; }
async function click(el) { assert.equal(el.disabled, false); assert.equal(el.closest('fieldset')?.disabled ?? false, false); await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(el, v) { const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }

test('catalog-scoped export actual mounted components', async (t) => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), saved = new Map(), originalFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const urls = new Map(), downloads = [], oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL, anchorClick = dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => { const url = 'blob:controlled-' + urls.size; urls.set(url, blob); return url; }; URL.revokeObjectURL = (url) => urls.delete(url);
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ filename: this.download, blob: urls.get(this.href) }); };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/catalog-export.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(f.tenant); ui.resetCatalogExportContext(''); ui.resetCatalogExportContext(context); downloads.length = 0; }
  async function mount(props = {}) { const container = document.createElement('div'); document.body.append(container); const root = createRoot(container); const h = { container, props: { workspaceId: tenant, contextKey: context, selectedIds: [id(40)], initialFilter: { search: '', active: 'all' }, readOnly: false, ...props }, async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(ui.CatalogExportPanel, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h); await h.render(); return h; }
  async function ready(h) { await until(() => h.container.querySelector('select[aria-label="Katalog do eksportu"]')?.options.length === 4, 'own catalogue choices'); }
  async function choose(h, cat = id(11)) { await ready(h); await value(h.container.querySelector('select[aria-label="Katalog do eksportu"]'), cat); await until(() => !h.container.textContent.includes('Odczytywanie przypisań wybranego katalogu…') && !button(h, 'Sprawdź zakres eksportu').disabled, 'catalog assigned metadata ready'); }
  async function sources(h) { await click(check(h, 'SECOND')); await click(check(h, 'Europa')); }
  async function preview(h) { await click(button(h, 'Sprawdź zakres eksportu')); await until(() => h.container.textContent.includes('Zakres do pobrania'), 'full explicit review'); }
  try {
    await t.test('selected catalog assigned sources, zero price, preview scope and separate download consent', async () => {
      const f = fixture(); reset(f); const h = await mount(); await ready(h); assert.equal(button(h, 'Sprawdź zakres eksportu').disabled, true); await choose(h); await sources(h);
      assert.ok(!h.container.querySelector('.catalog-export-sources').textContent.includes('MAIN')); assert.ok(!h.container.querySelector('.catalog-export-sources').textContent.includes('Detal'));
      await preview(h); assert.equal(f.posts.length, 1); assert.equal(f.posts[0].body.catalog_id, id(11)); assert.deepEqual(f.posts[0].body.warehouse_ids, [id(21)]); assert.deepEqual(f.posts[0].body.price_list_ids, [id(31)]); assert.ok(h.container.textContent.includes('Drugi katalog · sprawdzona wersja 4')); assert.equal(button(h, 'Pobierz plik').disabled, true);
      await click(check(h, 'Potwierdzam eksport wskazanego zakresu')); await click(button(h, 'Pobierz plik')); await until(() => downloads.length === 1, 'complete browser download');
      assert.equal(f.posts[1].body.catalog_version, '4'); assert.equal(f.posts[1].body.scope_hash, hash); assert.equal(f.posts[1].body.catalog_id, id(11)); assert.equal(await downloads[0].blob.text(), 'sku\r\nOWN-SECOND\r\n'); assert.equal(ui.catalogExportLocked(context), false); await h.close();
    });
    await t.test('inactive catalogue refuses export and genuine old-schema mode remains explicit all-firm read', async () => {
      const f = fixture(); reset(f); const h = await mount(); await ready(h); await value(h.container.querySelector('select[aria-label="Katalog do eksportu"]'), id(12)); assert.equal(button(h, 'Sprawdź zakres eksportu').disabled, true); assert.ok(h.container.textContent.includes('Katalog jest nieaktywny')); assert.equal(f.posts.length, 0); await h.close();
      const old = fixture(); old.available = false; old.defaultColumns = ['sku']; reset(old); const legacy = await mount(); await until(() => legacy.container.textContent.includes('Ta kopia nie obsługuje eksportu osobnego katalogu'), 'neutral legacy mode'); await preview(legacy); await click(check(legacy, 'Potwierdzam eksport wskazanego zakresu')); await click(button(legacy, 'Pobierz plik')); await until(() => downloads.length === 1, 'legacy export'); assert.equal(old.posts.length, 1); assert.ok(!('catalog_id' in old.posts[0].body)); assert.ok(!('scope_hash' in old.posts[0].body)); await legacy.close();
    });
    await t.test('late catalogue assignment read cannot overwrite the newly selected scope', async () => {
      const f = fixture(); reset(f); const held = deferred(); f.heldCatalog = { catalog: id(10), ...held }; const h = await mount(); await ready(h); await value(h.container.querySelector('select[aria-label="Katalog do eksportu"]'), id(10)); await until(() => f.reads.some((v) => v.includes('catalog_id=' + id(10))), 'old read held'); await value(h.container.querySelector('select[aria-label="Katalog do eksportu"]'), id(11)); await until(() => !button(h, 'Sprawdź zakres eksportu').disabled, 'new scope ready');
      await act(async () => { const reply = f.options(id(10)); reply.sources.warehouses.data[0].name = 'LATE FOREIGN METADATA'; held.resolve(Response.json(reply)); await Promise.resolve(); }); await tick(); assert.equal(h.container.querySelector('select[aria-label="Katalog do eksportu"]').value, id(11)); assert.ok(!h.container.textContent.includes('LATE FOREIGN METADATA')); assert.ok(h.container.querySelector('.catalog-export-sources').textContent.includes('SECOND')); assert.equal(f.posts.length, 0); await h.close();
    });
    await t.test('malformed preview retains exact body through same-actor remount and manual retry', async () => {
      const f = fixture(); f.malformedPreview = true; reset(f); const h = await mount(); await choose(h); await sources(h); await click(button(h, 'Sprawdź zakres eksportu')); await until(() => h.container.textContent.includes('Ponów dokładny odczyt eksportu'), 'invalid preview retained'); assert.ok(ui.catalogExportLocked(context)); const first = f.posts[0]; await h.close(); f.malformedPreview = false;
      const next = await mount({ externalWriteBlocked: true }); await until(() => next.container.querySelector('select[aria-label="Katalog do eksportu"]')?.value === id(11) && !next.container.textContent.includes('Odczytywanie przypisań wybranego katalogu…'), 'retained scope hydrated'); await click(button(next, 'Ponów dokładny odczyt eksportu')); await until(() => next.container.textContent.includes('Zakres do pobrania'), 'validated new read of same body'); assert.equal(f.posts.length, 2); assert.equal(f.posts[1].raw, first.raw); assert.equal(ui.catalogExportLocked(context), false); assert.equal(downloads.length, 0); await next.close();
    });
    await t.test('interrupted file read retains exact version/hash across remount, blocks fresh profiles, permits own retry', async () => {
      const f = fixture(); reset(f); const h = await mount(); await choose(h); await sources(h); await preview(h); await click(check(h, 'Potwierdzam eksport wskazanego zakresu')); f.lostFile = true; await click(button(h, 'Pobierz plik')); await until(() => ui.catalogExportLocked(context) && h.container.textContent.includes('Ponów dokładny odczyt eksportu'), 'file read retained'); const first = f.posts[1]; assert.equal(downloads.length, 0); await h.close(); f.lostFile = false;
      const next = await mount({ externalWriteBlocked: true }); await until(() => next.container.querySelector('select[aria-label="Katalog do eksportu"]')?.value === id(11) && !next.container.textContent.includes('Odczytywanie przypisań wybranego katalogu…'), 'scope recovered'); assert.equal(button(next, 'Zapisz bieżące ustawienia jako nowy profil').disabled, true); await click(button(next, 'Odczytaj listę profili')); assert.ok(ui.catalogExportLocked(context)); await click(button(next, 'Ponów dokładny odczyt eksportu')); await until(() => downloads.length === 1, 'full read retry downloaded'); assert.equal(f.posts.length, 3); assert.equal(f.posts[2].raw, first.raw); assert.equal(ui.catalogExportLocked(context), false); await next.close();
    });
    await t.test('catalog version conflict clears consent and requires a fresh preview', async () => {
      const f = fixture(); reset(f); const h = await mount(); await choose(h); await sources(h); await preview(h); await click(check(h, 'Potwierdzam eksport wskazanego zakresu')); f.catalogs[1].version = '5'; await click(button(h, 'Pobierz plik')); await until(() => h.container.textContent.includes('Konfiguracja katalogu zmieniła się'), 'authoritative version rejection'); assert.equal(downloads.length, 0); assert.ok(!h.container.textContent.includes('Zakres do pobrania')); assert.ok(!h.container.textContent.includes('Ponów dokładny odczyt eksportu')); assert.equal(ui.catalogExportLocked(context), false); assert.equal(f.posts.length, 2); await h.close();
    });
    await t.test('profile is freshly read and copied with catalogue assignments, without auto export', async () => {
      const f = fixture(); f.profiles = [{ id: id(50), name: 'Profil', version: 1, archived: false, definition: definition(id(10)) }]; f.profileDetail = { ...f.profiles[0], version: 2, definition: definition(id(11)) }; reset(f); const h = await mount(); await choose(h, id(10)); await until(() => field(h, 'Wybierz profil').options.length === 2, 'profile list'); await value(field(h, 'Wybierz profil'), id(50)); await click(button(h, 'Użyj profilu')); await until(() => h.container.querySelector('select[aria-label="Katalog do eksportu"]')?.value === id(11) && !h.container.textContent.includes('Odczytywanie przypisań wybranego katalogu…'), 'fresh scoped profile copied'); assert.ok(f.reads.includes('/catalog/export-profiles/' + id(50))); assert.ok(h.container.textContent.includes('Profil · wersja 2')); assert.equal(f.posts.length, 0); await preview(h); assert.equal(f.posts[0].body.catalog_id, id(11)); assert.deepEqual(f.posts[0].body.warehouse_ids, [id(21)]); await h.close();
    });
    await t.test('malformed create profile result retains actor RAM and exact client key across unmount', async () => {
      const f = fixture(); reset(f); const h = await mount(); await choose(h); await sources(h); await value(field(h, 'Nazwa nowego profilu'), 'Własny eksport'); f.malformedProfile = true; await click(button(h, 'Zapisz bieżące ustawienia jako nowy profil')); await until(() => h.container.textContent.includes('Niepewna próba:'), 'profile result cannot confirm another catalogue'); const first = f.posts[0]; assert.equal(first.body.definition.catalog_id, id(11)); assert.ok(ui.catalogExportLocked(context)); await h.close(); f.malformedProfile = false;
      const next = await mount(); await until(() => next.container.textContent.includes('Niepewna próba:') && !button(next, 'Ponów dokładnie tę samą próbę').disabled, 'pending profile restored'); assert.equal(button(next, 'Sprawdź zakres eksportu').disabled, true); await click(button(next, 'Odczytaj listę profili')); assert.ok(ui.catalogExportLocked(context)); await click(button(next, 'Ponów dokładnie tę samą próbę')); await until(() => !ui.catalogExportLocked(context), 'valid create replay confirmed'); assert.equal(f.posts.length, 2); assert.equal(f.posts[1].raw, first.raw); assert.equal(f.profileReceipts.size, 1); await next.close();
    });
    await t.test('actor replacement rejects a late read and cannot restore prior private scope', async () => {
      const f = fixture(); reset(f); const held = deferred(); f.heldOptions = held; const h = await mount(); await until(() => f.reads.includes('/catalog/exports/options'), 'old actor read held'); f.heldOptions = null; f.tenant = id(90); f.role = 'viewer'; const nextContext = `${f.tenant}:${user}:viewer:true`; api.setWorkspace(f.tenant); await h.render({ workspaceId: f.tenant, contextKey: nextContext, readOnly: true }); await until(() => h.container.textContent.includes('Tryb tylko do odczytu'), 'new actor options');
      await act(async () => { const old = f.options(); old.catalogs[0].name = 'OLD PRIVATE CATALOG'; held.resolve(Response.json(old)); await Promise.resolve(); }); await tick(); assert.ok(!h.container.textContent.includes('OLD PRIVATE CATALOG')); assert.equal(ui.catalogExportLocked(context), false); assert.equal(f.posts.length, 0); await h.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    await vite.close(); dom.window.close(); globalThis.fetch = originalFetch; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; dom.window.HTMLAnchorElement.prototype.click = anchorClick;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
