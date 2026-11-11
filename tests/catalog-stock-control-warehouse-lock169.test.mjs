import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Mounted production WarehouseDocuments + BO panel, controlled HTTP only.
// No warehouse/BO server mutation or native document evidence is claimed here.
const id = n => `${String(n).padStart(8, '0')}-1690-4169-8169-169169169169`;
const tenant = id(1), user = id(2), scope = `${tenant}:${user}:admin:false`;
const boFlags = { available: true, activation_available: true, writers_available: true, can_read: true, can_manage: true, can_read_value: true, current_role: 'admin', read_only: false };
const prepareLabel = 'Przygotuj podgląd aktywacji i BO';
function fixture() {
  const f = { reads: [], writes: [], reloads: 0, notices: [] };
  f.warehouse = { id: id(20), name: 'Własny magazyn BO169', code: 'SALE' };
  f.product = { id: id(50), sku: 'QA169-OWN', name: 'Własny produkt', kind: 'simple' };
  f.document = { id: id(40), number: 'PZ169/2026/000001', kind: 'receipt', status: 'draft', version: 2, warehouse_id: id(20), warehouse_name: f.warehouse.name, destination_id: null, destination_name: null, reference: 'Własna dostawa', note: 'Szkic własnego przyjęcia', created_at: '2026-10-07T12:00:00Z', lines: [{ product_id: id(50), sku: f.product.sku, name: f.product.name, quantity: 1, location: 'A-01', expected_on_hand: 0, expected_reserved: 0, expected_version: 0, current_on_hand: 0, current_version: 0 }] };
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: { tenant_id: tenant, id: user, role: 'admin' } });
      if (p === '/warehouses') return Response.json({ data: [f.warehouse] });
      if (p === '/products') return Response.json({ data: [f.product], meta: { cursor: null } });
      if (p === '/warehouse-documents') return Response.json({ data: [f.document], meta: { cursor: null } });
      if (p === '/warehouse-documents/' + id(40)) return Response.json(f.document);
      if (p === '/product-catalogs/options') return Response.json({ available: true, can_read: true, catalogs: [{ id: id(10), name: 'Własny katalog BO169', active: true }] });
      if (p === '/catalog-stock-control/history') return Response.json({ ...boFlags, data: [], meta: { cursor: null, limit: Number(u.searchParams.get('limit')) } });
      if (p === '/catalog-stock-control/catalogs/' + id(10) + '/source') return Response.json({ ...boFlags, source: { snapshot: { catalog: { id: id(10), name: 'Własny katalog BO169', version: '1' }, policy: { catalog_id: id(10), version: '0', strict: false, operation_id: null }, warehouses: [{ ...f.warehouse, policy: { usage: 'sale', enabled: true, version: '0' }, series: { id: null, version: '0', name: 'Bilans otwarcia', prefix: 'BO' } }], wms_enabled: false, row_count: 0, summary: { physical_quantity: '0', reserved_quantity: '0' } }, blockers: [], ready: true, can_preview: true } });
      throw Error('Unexpected warehouse169 GET ' + p);
    }
    f.writes.push({ path: p, method, raw: init.body, body: JSON.parse(init.body) });
    if (p === '/catalog-stock-control/catalogs/' + id(10) + '/previews') throw TypeError('Controlled BO lost ACK');
    if (p === '/warehouse-documents' || p === '/warehouse-documents/' + id(40)) return Response.json(f.document, { status: p === '/warehouse-documents' ? 201 : 200 });
    if (p === '/warehouse-documents/' + id(40) + '/post' || p === '/warehouse-documents/' + id(40) + '/cancel') return Response.json({ ...f.document, status: p.endsWith('/post') ? 'posted' : 'cancelled', version: 3 });
    throw Error('Unexpected warehouse169 write ' + p);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(fn, label) { for (let i = 0; i < 120; i++) { if (fn()) return; await tick(); } assert.ok(fn(), label); }
function button(h, text) { const b = [...h.container.querySelectorAll('button')].find(e => e.textContent.trim() === text); assert.ok(b, text); return b; }
async function click(e) { assert.equal(e.matches(':disabled'), false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function select(e, value) { assert.equal(e.matches(':disabled'), false); await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function submit(form) { await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

test('warehouse documents synchronous BO169 guard — actual mounted production controls', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' }), descriptors = new Map(), oldFetch = globalThis.fetch, mounts = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), warehouse = await vite.ssrLoadModule(path.resolve('web/warehouse.tsx')), bo = await vite.ssrLoadModule(path.resolve('web/catalog-stock-control-panel.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(tenant); bo.resetCatalogStockControlContext(''); bo.resetCatalogStockControlContext(scope); }
  async function mount(Component, props) { const container = document.createElement('div'); document.body.append(container); const root = createRoot(container), h = { container, props, async render(p = {}) { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(Component, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h); await h.render(); return h; }
  async function documents(f) { const h = await mount(warehouse.WarehouseDocuments, { contextKey: scope, admin: true, readOnly: false, externalWriteBlocked: false, refresh: 0, reload: () => { f.reloads++; }, notify: v => f.notices.push(v) }); await until(() => [...h.container.querySelectorAll('button')].some(b => b.textContent === f.document.number), 'Actual warehouse document list'); return h; }
  async function detail(h, f) { await click(button(h, f.document.number)); await until(() => h.container.querySelector('.warehouse-detail') && h.container.textContent.includes(f.product.sku), 'Saved draft detail'); }
  async function boReady() { const h = await mount(bo.CatalogStockControlPanel, { contextKey: scope, available: true, readOnly: false, catalogId: id(10), externalWriteBlocked: false }); await until(() => h.container.querySelector('select')?.value === id(10) && !button(h, 'Odczytaj pełny stan katalogu do BO').disabled, 'BO current grants'); await click(button(h, 'Odczytaj pełny stan katalogu do BO')); await until(() => [...h.container.querySelectorAll('button')].some(b => b.textContent === prepareLabel && !b.disabled), 'BO source'); return h; }
  async function unknown(h) { await click(button(h, prepareLabel)); await until(() => h.container.textContent.includes('Controlled BO lost ACK'), 'BO pending retained'); assert.ok(bo.catalogStockControlLocked(scope)); }
  async function newForm(h, f) { await click(button(h, 'Nowy dokument')); await until(() => h.container.querySelector('select[aria-label="Produkt 1"] option[value="' + f.product.id + '"]') && h.container.querySelector('label select') && h.container.querySelector('form.warehouse-form'), 'Complete warehouses and actual ProductPicker options'); await select(h.container.querySelector('select[aria-label="Produkt 1"]'), f.product.id); await until(() => [...h.container.querySelectorAll('label')].some(l => l.textContent.startsWith('Magazyn źródłowy') && l.querySelector('select')?.value === f.warehouse.id), 'Actual assigned warehouse'); return h.container.querySelector('form.warehouse-form'); }
  try {
    await t.test('already-enabled post and cancel deny a same-turn BO lock before a foreign prop update', async () => {
      const f = fixture(); reset(f); const h = await documents(f); await detail(h, f); await click(button(h, 'Zatwierdź dokument')); const post = button(h, 'Potwierdzam zatwierdzenie'), cancel = button(h, 'Anuluj szkic'), b = await boReady();
      await act(async () => { button(b, prepareLabel).dispatchEvent(new MouseEvent('click', { bubbles: true })); assert.ok(bo.catalogStockControlLocked(scope)); assert.equal(post.disabled, false); assert.equal(cancel.disabled, false); post.dispatchEvent(new MouseEvent('click', { bubbles: true })); cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
      await until(() => b.container.textContent.includes('Controlled BO lost ACK'), 'BO lost response'); assert.equal(f.writes.length, 1); assert.ok(f.writes.every(w => w.path.startsWith('/catalog-stock-control'))); assert.equal(f.reloads, 0); assert.equal(f.document.status, 'draft'); await h.close(); await b.close();
    });
    await t.test('create/edit/confirmation openers check the same canonical actor getter while document reads stay available', async () => {
      const f = fixture(); reset(f); const h = await documents(f); await detail(h, f); const b = await boReady(); await unknown(b); await click(button(h, 'Nowy dokument')); await click(button(h, 'Edytuj szkic')); await click(button(h, 'Zatwierdź dokument')); assert.equal(h.container.querySelector('[role="dialog"]'), null); assert.equal(h.container.querySelector('.warehouse-confirm'), null); await h.render({ externalWriteBlocked: true }); await click(button(h, 'Lista dokumentów')); const before = f.reads.length; await detail(h, f); assert.ok(f.reads.slice(before).includes('/warehouse-documents/' + id(40))); assert.ok(h.container.textContent.includes(f.document.reference)); assert.equal(f.writes.length, 1); assert.equal(f.reloads, 0); assert.ok(bo.catalogStockControlLocked(scope)); await h.close(); await b.close();
    });
    await t.test('complete preopened create and update forms refuse POST/PATCH while a BO attempt is retained', async () => {
      for (const update of [false, true]) { const f = fixture(); reset(f); const h = await documents(f); let form;
        if (update) { await detail(h, f); await click(button(h, 'Edytuj szkic')); await until(() => h.container.querySelector('form.warehouse-form') && h.container.querySelector('select[aria-label="Produkt 1"]')?.value === f.product.id, 'Real selected edit product'); form = h.container.querySelector('form.warehouse-form'); }
        else form = await newForm(h, f);
        assert.equal(form.querySelector('input[aria-label="Ilość 1"]').value, '1'); assert.equal(button(h, 'Zapisz szkic').matches(':disabled'), false); const b = await boReady(); await unknown(b); await submit(form); await tick(); assert.equal(f.writes.length, 1); assert.equal(f.reloads, 0); assert.equal(f.notices.length, 0); assert.ok(h.container.querySelector('[role="dialog"]')); assert.ok(bo.catalogStockControlLocked(scope)); await h.close(); await b.close();
      }
    });
    await t.test('latest external prop denies a preopened form, while the same valid form writes normally without any lock', async () => {
      const f = fixture(); reset(f); const h = await documents(f), form = await newForm(h, f); const buttonBefore = button(h, 'Zapisz szkic'); assert.equal(buttonBefore.matches(':disabled'), false); await h.render({ externalWriteBlocked: true }); assert.equal(buttonBefore.matches(':disabled'), true); await submit(form); await tick(); assert.equal(f.writes.length, 0); assert.equal(f.reloads, 0); await h.render({ externalWriteBlocked: false }); await submit(form); await until(() => f.reloads === 1 && h.container.querySelector('[role="dialog"]') === null, 'Same complete form succeeds when actual locks are absent'); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].path, '/warehouse-documents'); assert.equal(f.writes[0].method, 'POST'); assert.equal(f.writes[0].body.lines[0].product_id, f.product.id); assert.equal(f.writes[0].body.lines[0].quantity, 1); assert.equal(f.writes[0].body.warehouse_id, f.warehouse.id); await h.close();
    });
  } finally { for (const h of mounts) if (h.container.isConnected) await h.close(); bo.resetCatalogStockControlContext(''); await vite.close(); globalThis.fetch = oldFetch; dom.window.close(); for (const [key, d] of descriptors) if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key]; }
});
