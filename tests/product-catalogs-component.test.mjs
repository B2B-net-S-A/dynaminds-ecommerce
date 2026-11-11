import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual mounted React components with controlled HTTP. No native/SQL/provider proof.
const id = (n) => `${n.toString(16).padStart(8, '0')}-1570-4157-8157-157157157157`;
const tenant = id(1), user = id(2), context = `${tenant}:${user}:admin:false`, hash = 'a'.repeat(64);
const flags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_manage: true };
const settings = (name = 'Domyślny') => ({ name, active: true, languages: ['pl'], default_language: 'pl', warehouse_ids: [id(20)], price_list_ids: [id(30)] });
const catalog = (n, s = settings(), v = '1') => ({ id: id(n), name: s.name, active: s.active, is_default: n === 10, version: v, settings: structuredClone(s), product_count: 0, created_at: '2026-10-06T12:00:00Z', updated_at: '2026-10-06T12:00:00Z' });
function fixture() {
  const f = { flags: { ...flags }, writes: [], reads: [], receipts: new Map(), lost: false, malformed: false, status: 0, tenant, user, heldOptions: null, heldProducts: null };
  f.catalogs = [catalog(10), catalog(11, settings('Drugi'))];
  f.warehouses = [{ id: id(20), name: 'Główny', code: 'MAIN' }, { id: id(21), name: 'Drugi magazyn', code: 'SECOND' }];
  f.price_lists = [{ id: id(30), name: 'Detal', currency: 'PLN', active: true, version: '1' }, { id: id(31), name: 'Europa', currency: 'EUR', active: true, version: '2' }];
  f.options = () => ({ ...f.flags, catalogs: structuredClone(f.catalogs), warehouses: f.warehouses, price_lists: f.price_lists, languages: ['pl', 'en'], limits: { max_catalogs: 100 }, capabilities: { tenant_unique_sku: true, tenant_wms_policy: true, product_transfer: false } });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: { tenant_id: f.tenant, id: f.user, role: f.flags.current_role } });
      if (p === '/warehouses') return Response.json({ data: f.warehouses });
      if (p === '/health') return Response.json({ product_logistics_available: false, product_sku_edit_available: false, restore_preview: false });
      if (p === '/product-catalogs/options') { if (f.heldOptions) return f.heldOptions; return Response.json(f.options()); }
      if (p === '/product-catalogs/previews') return Response.json({ ...f.flags, data: f.operation ? [{ id: f.operation.id, kind: 'operation', name: f.operation.after.name, created_at: f.operation.created_at }] : [], next_cursor: null });
      if (p.startsWith('/product-catalogs/operations/')) return Response.json({ ...f.flags, operation: f.operation });
      if (p.startsWith('/product-catalogs/previews/')) return Response.json({ ...f.flags, preview: f.preview });
      if (p.startsWith('/product-catalogs/')) return Response.json({ ...f.flags, catalog: f.catalogs.find((c) => c.id === p.split('/')[2]) });
      if (p === '/products') {
        if (u.searchParams.has('after') && f.heldProducts) return f.heldProducts;
        const cat = u.searchParams.get('catalog_id');
        const n = cat === id(11) ? 51 : 50;
        return Response.json({ data: [{ id: id(n), catalog_id: cat, sku: 'SKU-' + n, name: 'Produkt ' + n, active: true, kind: 'simple' }], meta: { cursor: u.searchParams.has('after') ? null : id(90) } });
      }
      throw Error('Unexpected GET ' + p);
    }
    const body = JSON.parse(init.body);
    f.writes.push({ path: p, method, raw: init.body, body });
    if (p === '/products') { f.created = { ...body, id: id(80) }; return Response.json(f.created, { status: 201 }); }
    if (f.status) return Response.json({ detail: 'Controlled timeout/rate limit' }, { status: f.status });
    let d = f.receipts.get(body.client_key);
    if (d) d = { ...structuredClone(d), reused: true };
    else {
      if (p === '/product-catalogs/previews') {
        const before = body.kind === 'update' ? f.catalogs.find((c) => c.id === body.catalog_id) : null;
        f.preview = { id: id(40), kind: body.kind, catalog_id: body.catalog_id ?? null, version: body.version ?? null, client_key: body.client_key, scope_hash: hash, before: before ? structuredClone(before) : null, after: structuredClone(body.settings), resources: { warehouses: f.warehouses, price_lists: f.price_lists, languages: ['pl', 'en'] }, blockers: f.blocked ? ['Magazyn ma zachowany zapas.'] : [], ready: !f.blocked, created_at: '2026-10-06T12:00:00Z', expires_at: new Date(Date.now() + 900000).toISOString(), can_commit: !f.blocked, operation_id: null };
        d = { ...f.flags, preview: structuredClone(f.preview), reused: false };
      } else if (p === '/product-catalogs/previews/' + id(40) + '/commit') {
        const before = f.preview.before, after = catalog(before ? Number.parseInt(before.id.slice(0, 8), 16) : 12, f.preview.after, before ? String(BigInt(before.version) + 1n) : '1');
        f.operation = { id: id(41), preview_id: f.preview.id, catalog_id: after.id, kind: f.preview.kind, client_key: body.client_key, request: structuredClone(body), before, after, scope_hash: hash, created_at: '2026-10-06T12:00:00Z' };
        f.catalogs = [...f.catalogs.filter((c) => c.id !== after.id), after];
        d = { ...f.flags, operation: structuredClone(f.operation), catalog: structuredClone(after), reused: false };
      } else throw Error('Unexpected write ' + p);
      f.receipts.set(body.client_key, structuredClone(d));
    }
    if (f.lost) throw TypeError('Controlled lost response');
    if (f.malformed) { d = structuredClone(d); if (d.preview) delete d.preview.scope_hash; else delete d.operation; }
    return Response.json(d, { status: 201 });
  };
  return f;
}
async function tick() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }
function button(h, text) { const el = [...h.container.querySelectorAll('button')].find((el) => el.textContent === text); assert.ok(el, text); return el; }
function field(h, text) { const el = [...h.container.querySelectorAll('label')].find((el) => el.firstChild?.textContent === text)?.querySelector('input,select'); assert.ok(el, text); return el; }
function check(h, text) { const el = [...h.container.querySelectorAll('label')].find((el) => el.textContent.startsWith(text))?.querySelector('input[type=checkbox]'); assert.ok(el, text); return el; }
async function click(el) { assert.equal(el.disabled, false); assert.equal(el.closest('fieldset')?.disabled ?? false, false); await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(el, val) { const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }

test('product catalogs mounted components', async (t) => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), saved = new Map(), originalFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, FormData: dom.window.FormData, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/product-catalogs.tsx')), picker = await vite.ssrLoadModule(path.resolve('web/catalog.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(f.tenant); ui.resetProductCatalogsContext(''); ui.resetProductCatalogsContext(context); }
  async function mount(component = ui.ProductCatalogsPanel, props = {}) {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { contextKey: context, readOnly: false, ...props }, async render(patch = {}) { h.props = { ...h.props, ...patch }; await act(async () => root.render(React.createElement(component, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } };
    mounts.push(h); await h.render(); return h;
  }
  async function ready(h) { await until(() => h.container.textContent.includes('SKU i historyczne'), 'fresh options'); }
  async function newPreview(h, f) { await ready(h); await value(field(h, 'Katalog'), 'new'); await value(field(h, 'Nazwa katalogu'), 'Osobny'); await click(check(h, 'pl')); await value(field(h, 'Język domyślny'), 'pl'); await click(check(h, 'Główny')); await click(check(h, 'Europa')); await click(button(h, 'Przygotuj podgląd katalogu')); await until(() => f.writes.length > 0 && !ui.productCatalogsWriteLocked(context), 'preview confirmed'); }
  try {
    await t.test('explicit assignments, full review and independent consent; immutable receipt survives newer current catalog', async () => {
      const f = fixture(); reset(f); const h = await mount(); await newPreview(h, f);
      assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0].body.settings.warehouse_ids, [id(20)]); assert.deepEqual(f.writes[0].body.settings.price_list_ids, [id(31)]);
      assert.ok(h.container.textContent.includes('Europa (EUR)')); assert.equal(button(h, 'Zapisz zatwierdzony katalog').disabled, true);
      await click(check(h, 'Sprawdziłem pełną')); await click(button(h, 'Zapisz zatwierdzony katalog')); await until(() => h.container.textContent.includes('Konfiguracja zapisana'), 'saved receipt');
      assert.equal(f.writes.length, 2); assert.equal(f.writes[1].body.confirmed, true); assert.equal(f.operation.after.settings.name, 'Osobny');
      f.catalogs[f.catalogs.length - 1] = catalog(12, settings('Późniejsza nazwa'), '2');
      await click(button(h, 'Odczytaj historię katalogów')); await until(() => h.container.textContent.includes('Otwórz pełny zapis'), 'history header'); await click([...h.container.querySelectorAll('button')].find((el) => el.textContent.includes('Otwórz pełny zapis')));
      assert.ok(h.container.textContent.includes('Osobny · zapisana wersja 1')); assert.ok(!h.container.textContent.includes('Późniejsza nazwa · zapisana wersja')); await h.close();
    });
    await t.test('fresh version update, regional language choice and durable blockers prevent commit', async () => {
      const f = fixture(); reset(f); const h = await mount(); await ready(h); await value(field(h, 'Katalog'), id(11)); await until(() => field(h, 'Nazwa katalogu').value === 'Drugi', 'full current catalog');
      await value(field(h, 'Dodatkowy kod języka'), 'pt-br'); await click(button(h, 'Dodaj język do wyboru')); await value(field(h, 'Język domyślny'), 'pt-br'); f.blocked = true;
      await click(button(h, 'Przygotuj podgląd katalogu')); await until(() => h.container.textContent.includes('Magazyn ma zachowany zapas.'), 'all blockers visible');
      assert.equal(f.writes[0].body.version, '1'); assert.deepEqual(f.writes[0].body.settings.languages, ['pl', 'pt-br']); assert.equal(button(h, 'Zapisz zatwierdzony katalog').disabled, true); assert.equal(f.writes.length, 1); await h.close();
    });
    await t.test('malformed success retains exact preview across unmount and history read; one manual replay', async () => {
      const f = fixture(); reset(f); f.malformed = true; const h = await mount(); await ready(h); await value(field(h, 'Katalog'), 'new'); await value(field(h, 'Nazwa katalogu'), 'Osobny'); await click(check(h, 'pl')); await value(field(h, 'Język domyślny'), 'pl'); await click(check(h, 'Główny')); await click(button(h, 'Przygotuj podgląd katalogu'));
      await until(() => h.container.textContent.includes('Ponów dokładną próbę katalogu'), 'retained malformed success'); const first = f.writes[0]; await h.close(); f.malformed = false;
      const next = await mount(); await ready(next); assert.ok(ui.productCatalogsWriteLocked(context)); await click(button(next, 'Odczytaj historię katalogów')); assert.ok(ui.productCatalogsWriteLocked(context));
      await click(button(next, 'Ponów dokładną próbę katalogu')); await until(() => !ui.productCatalogsWriteLocked(context), 'exact replay resolves'); assert.equal(f.writes.length, 2); assert.equal(f.writes[1].raw, first.raw); assert.equal(f.writes[1].path, first.path); assert.equal(f.receipts.size, 1); await next.close();
    });
    await t.test('408 and 429 preserve exact commit; sibling lock does not prevent own replay', async () => {
      const f = fixture(); reset(f); const h = await mount(); await newPreview(h, f); await click(check(h, 'Sprawdziłem pełną')); f.status = 408; await click(button(h, 'Zapisz zatwierdzony katalog')); await until(() => h.container.textContent.includes('Ponów dokładną'), 'timeout retained'); const first = f.writes[1];
      await h.render({ externalWriteBlocked: true }); f.status = 429; await click(button(h, 'Ponów dokładną próbę katalogu')); assert.ok(ui.productCatalogsWriteLocked(context)); f.status = 0; await click(button(h, 'Ponów dokładną próbę katalogu')); await until(() => !ui.productCatalogsWriteLocked(context), 'confirmed'); assert.equal(f.writes[2].raw, first.raw); assert.equal(f.writes[3].raw, first.raw); assert.equal(f.operation.request.client_key, first.body.client_key); await h.close();
    });
    await t.test('late old actor options never publish; readonly new actor cannot start config', async () => {
      const f = fixture(); reset(f); let resolve; const held = new Promise((r) => { resolve = r; }); f.heldOptions = held; const h = await mount(); await until(() => f.reads.includes('/product-catalogs/options'), 'old read started');
      f.heldOptions = null; f.tenant = id(3); f.flags.current_role = 'viewer'; f.flags.can_manage = false; f.flags.read_only = true; const next = `${f.tenant}:${user}:viewer:true`; api.setWorkspace(f.tenant); await h.render({ contextKey: next, readOnly: true }); await until(() => h.container.textContent.includes('Konfiguracja jest dostępna tylko do odczytu.'), 'new readonly actor');
      await act(async () => { resolve(Response.json({ ...flags, catalogs: [catalog(99, settings('FOREIGN OLD ACTOR'))], warehouses: f.warehouses, price_lists: f.price_lists, languages: ['pl'] })); await Promise.resolve(); }); await tick(); assert.ok(!h.container.textContent.includes('FOREIGN OLD ACTOR')); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('actual ProductPicker scopes catalog pages and refuses late old page/foreign initial', async () => {
      const f = fixture(); reset(f); const selected = []; let resolve;
      const h = await mount(picker.ProductPicker, { catalogId: id(10), label: 'Składnik', value: '', select: (p) => selected.push(p), initial: { id: id(77), catalog_id: id(11), name: 'Foreign initial', sku: 'FOREIGN' } });
      await until(() => h.container.textContent.includes('Produkt 50'), 'catalog one page'); f.heldProducts = new Promise((r) => { resolve = r; }); await click(button(h, 'Więcej wyników')); await h.render({ catalogId: id(11), value: id(77) }); await until(() => h.container.textContent.includes('Produkt 51'), 'catalog two page');
      await act(async () => { resolve(Response.json({ data: [{ id: id(78), catalog_id: id(10), sku: 'OLD', name: 'Old late product' }], meta: { cursor: null } })); await Promise.resolve(); }); await tick();
      assert.ok(!h.container.textContent.includes('Old late product')); assert.ok(!h.container.textContent.includes('Produkt 50')); const choice = h.container.querySelector('select[aria-label="Składnik"]'); assert.ok(choice); await value(choice, id(51)); assert.equal(selected[0].catalog_id, id(11)); assert.ok(f.reads.some((r) => r.includes('catalog_id=' + id(11)))); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('actual create product form requires own catalog and submits explicit catalog with assigned warehouse', async () => {
      const f = fixture(); f.catalogs[1].settings.warehouse_ids = [id(21)]; reset(f); let savedProduct = false;
      const h = await mount(picker.NewProductModal, { close() {}, saved() { savedProduct = true; } });
      await until(() => h.container.querySelector('select[aria-label="Katalog produktu"]')?.options.length === 3, 'own catalog choices'); assert.equal(button(h, 'Zapisz produkt').disabled, true);
      await value(h.container.querySelector('select[aria-label="Katalog produktu"]'), id(11));
      await value(h.container.querySelector('input[name="sku"]'), 'OWN-SECOND'); await value(h.container.querySelector('input[name="name"]'), 'Własny drugi'); await value(h.container.querySelector('input[name="price"]'), '17.00');
      assert.deepEqual([...h.container.querySelector('select[name="warehouse_id"]').options].map((o) => o.value), [id(21)]);
      await act(async () => h.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      await until(() => savedProduct, 'actual create callback'); assert.equal(f.created.catalog_id, id(11)); assert.equal(f.created.warehouse_id, id(21)); assert.equal(f.created.price, 1700); assert.equal(f.writes.filter((w) => w.path === '/products').length, 1); await h.close();
    });
  } finally {
    for (const h of mounts) { if (h.container.isConnected) await h.close(); }
    await vite.close(); dom.window.close(); globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
