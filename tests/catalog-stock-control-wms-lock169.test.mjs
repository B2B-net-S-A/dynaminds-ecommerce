import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual WmsOrderLotsPanel + actual BO panel. Parent props deliberately remain
// false to exercise the synchronous getter, rather than subscription rerenders.
const id = n => `${String(n).padStart(8, '0')}-1690-4169-8169-169169169169`;
const tenant = id(1), user = id(2), scope3 = `${tenant}:${user}:admin`, scope4 = scope3 + ':false';
const wflags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_write: true, can_admin: true, can_read_value: true };
const bflags = { available: true, activation_available: true, writers_available: true, read_only: false, current_role: 'admin', can_read: true, can_manage: true, can_read_value: true };
const scanLabel = 'Skanuj jedną sztukę wybranej partii', prepareLabel = 'Przygotuj podgląd aktywacji i BO';
function fixture() {
  const f = { reads: [], writes: [], scanLost: false, heldAllocations: null };
  f.warehouse = { id: id(20), name: 'Własny magazyn WMS169', code: 'SALE' };
  f.allocation = { order_id: id(40), product_id: id(50), warehouse_id: id(20), location: 'A-01', layer_id: id(60), lot_id: id(70), lot_code: 'QA169-LOT', quantity: 2, scanned: 0, state: 'active', fifo_sequence: '1' };
  f.allocations = () => ({ ...wflags, data: [f.allocation], meta: { cursor: null }, order: { id: id(40), number: 'ORDER169', status: 'picking', version: '3' }, can_scan: true, blockers: [] });
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''), method = init.method ?? 'GET';
    if (method === 'GET') {
      f.reads.push(p + u.search);
      if (p === '/auth/me') return Response.json({ user: { tenant_id: tenant, id: user, role: 'admin' } });
      if (p === '/product-catalogs/options') return Response.json({ available: true, can_read: true, catalogs: [{ id: id(10), name: 'Własny katalog BO169', active: true }] });
      if (p === '/catalog-stock-control/history') return Response.json({ ...bflags, data: [], meta: { cursor: null, limit: Number(u.searchParams.get('limit')) } });
      if (p === '/catalog-stock-control/catalogs/' + id(10) + '/source') return Response.json({ ...bflags, source: { snapshot: { catalog: { id: id(10), name: 'Własny katalog BO169', version: '1' }, policy: { catalog_id: id(10), version: '0', strict: false, operation_id: null }, warehouses: [{ ...f.warehouse, policy: { usage: 'sale', enabled: true, version: '0' }, series: { id: null, version: '0', name: 'Bilans otwarcia', prefix: 'BO' } }], wms_enabled: true, row_count: 0, summary: { physical_quantity: '0', reserved_quantity: '0', known_quantity: '0', zero_cost_quantity: '0', unknown_quantity: '0', known_value_minor: '0', currency: 'PLN', exponent: 2 }, rows_sha256: 'a'.repeat(64) }, ready: true, can_preview: true, blockers: [] } });
      if (p === '/wms-lots') return Response.json({ ...wflags, policy: { enabled: true, version: '1', method: 'FIFO', currency: 'PLN', exponent: 2 }, warehouses: [f.warehouse], limits: { page: 50 }, can_receive: true, can_issue: true, can_adjust: true, can_transfer: true, can_activate: false });
      if (p === '/orders/' + id(40)) return Response.json({ id: id(40), number: 'ORDER169', status: 'picking', picking_items: [{ product_id: id(50), sku: 'QA169-SKU', name: 'Własny produkt' }] });
      if (p === '/wms-lots/orders/' + id(40) + '/allocations') return f.heldAllocations ?? Response.json(f.allocations());
      throw Error('Unexpected controlled WMS169 GET ' + p);
    }
    assert.equal(method, 'POST'); f.writes.push({ path: p, raw: init.body, body: JSON.parse(init.body) });
    if (p === '/catalog-stock-control/catalogs/' + id(10) + '/previews') throw TypeError('Controlled BO preview lost ACK');
    if (p === '/orders/' + id(40) + '/scan') { if (f.scanLost) throw TypeError('Controlled WMS scan lost ACK'); return Response.json({ ...wflags, id: id(40), status: 'picking' }); }
    throw Error('Unexpected controlled WMS169 POST ' + p);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function until(fn, label) { for (let i = 0; i < 120; i++) { if (fn()) return; await tick(); } assert.ok(fn(), label); }
function button(h, text) { const b = [...h.container.querySelectorAll('button')].find(e => e.textContent.trim() === text); assert.ok(b, text); return b; }
function field(h, text) { const e = [...h.container.querySelectorAll('label')].find(l => l.textContent.trim().startsWith(text))?.querySelector('input,select'); assert.ok(e, text); return e; }
async function click(e) { assert.equal(e.matches(':disabled'), false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(e, v) { const prototype = e.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(e, v); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }

test('actual WMS physical writes respect synchronous BO169 lock without blocking recovery', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' }), descriptors = new Map(), oldFetch = globalThis.fetch, mounts = [];
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), wms = await vite.ssrLoadModule(path.resolve('web/wms-lots.tsx')), bo = await vite.ssrLoadModule(path.resolve('web/catalog-stock-control-panel.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  function reset(f) { globalThis.fetch = f.fetch; api.setWorkspace(tenant); bo.resetCatalogStockControlContext(''); bo.resetCatalogStockControlContext(scope4); }
  async function mount(Component, props) { const container = document.createElement('div'); document.body.append(container); const root = createRoot(container), h = { container, props, async render(p = {}) { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(Component, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h); await h.render(); return h; }
  async function order(f) { const h = await mount(wms.WmsOrderLotsPanel, { contextKey: scope3, readOnly: false, orderId: id(40), externalWriteBlocked: false }); if (!f.heldAllocations) await choose(h); return h; }
  async function choose(h) { await until(() => h.container.querySelector('select option[value]:not([value=""])') && !field(h, 'Jawnie wybierz przypisaną partię i lokalizację').disabled, 'Actual allocation complete'); const s = field(h, 'Jawnie wybierz przypisaną partię i lokalizację'); await value(s, s.options[1].value); await value(field(h, 'Odczytany kod SKU lub EAN'), 'QA169-SKU'); assert.equal(button(h, scanLabel).disabled, false); }
  async function boReady() { const h = await mount(bo.CatalogStockControlPanel, { contextKey: scope4, available: true, readOnly: false, catalogId: id(10), externalWriteBlocked: false }); await until(() => h.container.querySelector('select')?.value === id(10) && !button(h, 'Odczytaj pełny stan katalogu do BO').disabled, 'Fresh BO grants'); await click(button(h, 'Odczytaj pełny stan katalogu do BO')); await until(() => [...h.container.querySelectorAll('button')].some(b => b.textContent === prepareLabel && !b.disabled), 'BO source prepared'); return h; }
  async function unknown(h) { await click(button(h, prepareLabel)); await until(() => h.container.textContent.includes('Controlled BO preview lost ACK'), 'Retained BO attempt'); assert.ok(bo.catalogStockControlLocked(scope4)); }
  try {
    await t.test('same-turn BO publication blocks an already-enabled real WMS scan before parent rerender', async () => {
      const f = fixture(); reset(f); const h = await order(f), b = await boReady(), scan = button(h, scanLabel);
      await act(async () => { button(b, prepareLabel).dispatchEvent(new MouseEvent('click', { bubbles: true })); assert.ok(bo.catalogStockControlLocked(scope4)); assert.equal(scan.disabled, false, 'Original DOM has not rerendered'); scan.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
      await until(() => b.container.textContent.includes('Controlled BO preview lost ACK'), 'BO unknown'); assert.equal(f.writes.filter(w => w.path.endsWith('/scan')).length, 0); assert.equal(f.writes.length, 1); const reads = f.reads.length; await click(button(h, 'Odśwież przypisania i dostęp')); await until(() => !button(h, 'Odśwież przypisania i dostęp').disabled, 'Reads remain available under BO lock'); assert.ok(f.reads.slice(reads).some(p => p.endsWith('/allocations'))); assert.ok(bo.catalogStockControlLocked(scope4)); await h.close(); await b.close();
    });
    await t.test('BO started while allocations were awaiting response is checked again at the fresh scan submission', async () => {
      const f = fixture(); reset(f); let release; f.heldAllocations = new Promise(r => { release = r; }); const h = await order(f); await until(() => f.reads.some(p => p.endsWith('/allocations')), 'Actual pending allocation GET'); const b = await boReady(); await unknown(b); f.heldAllocations = null; await act(async () => release(Response.json(f.allocations()))); await choose(h); await click(button(h, scanLabel)); await tick(); assert.equal(f.writes.filter(w => w.path.endsWith('/scan')).length, 0); assert.equal(f.writes.length, 1); assert.ok(bo.catalogStockControlLocked(scope4)); await h.close(); await b.close();
    });
    await t.test('existing WMS unknown keeps exact manual replay available during a later BO foreign lock', async () => {
      const f = fixture(); reset(f); const h = await order(f); f.scanLost = true; await click(button(h, scanLabel)); await until(() => h.container.textContent.includes('Controlled WMS scan lost ACK') && !button(h, 'Ponów tę samą próbę').disabled, 'Own WMS pending retained'); const original = f.writes[0]; const b = await boReady(); await unknown(b); await h.render({ externalWriteBlocked: true }); f.scanLost = false; await click(button(h, 'Ponów tę samą próbę')); await until(() => h.container.textContent.includes('Przyjęto lokalny skan kodu QA169-SKU') && !h.container.textContent.includes('wynik nie został potwierdzony'), 'Own exact recovery accepted'); const replay = f.writes.at(-1); assert.equal(replay.path, original.path); assert.equal(replay.raw, original.raw); assert.equal(f.writes.filter(w => w.path.endsWith('/scan')).length, 2); assert.ok(bo.catalogStockControlLocked(scope4), 'WMS recovery does not acknowledge BO'); await h.close(); await b.close();
    });
  } finally { for (const h of mounts) if (h.container.isConnected) await h.close(); bo.resetCatalogStockControlContext(''); await vite.close(); globalThis.fetch = oldFetch; dom.window.close(); for (const [key, d] of descriptors) if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key]; }
});
