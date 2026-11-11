import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Real production InventoryPanel/StockPicker with controlled GETs, no native stock proof.
const id = n => `${String(n).padStart(8, '0')}-1610-4161-8161-161161161161`;
const warehouse = id(1);
function row(n, usage = 'sale', enabled = true, version = '2') {
  return { product_id: id(n), warehouse_id: warehouse, warehouse_name: 'Magazyn testowy', name: 'Towar ' + n, sku: 'SKU-' + n, location: 'A-01', on_hand: 7, reserved: 2, available: 5, physical_available: 5, sellable_available: usage === 'sale' && enabled ? 5 : 0, inventory_usage: usage, inventory_enabled: enabled, inventory_policy_version: version };
}
function fixture(rows) {
  const f = { rows, reads: [] };
  f.fetch = async (url, init = {}) => {
    assert.equal(init.method ?? 'GET', 'GET', 'component inspection must not mutate stock');
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, ''); f.reads.push(p + u.search);
    if (p === '/warehouses') return Response.json({ data: [{ id: warehouse, name: 'Magazyn testowy', code: 'MAIN' }] });
    if (p === '/inventory') return Response.json({ data: structuredClone(f.rows), meta: { has_more: false, cursor: null } });
    if (p === '/inventory/movements') return Response.json({ data: [], meta: { has_more: false, cursor: null } });
    throw Error('Unexpected GET ' + p);
  };
  return f;
}
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await act(async () => { await new Promise(r => setTimeout(r, 0)); }); } assert.ok(fn(), note); }
test('inventory sellability mounted controlled component', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/inventory.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  async function mount(component, props, f) {
    globalThis.fetch = f.fetch; api.setWorkspace(id(9)); const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, async close() { await act(async () => root.unmount()); container.remove(); } }; mounts.push(h); await act(async () => root.render(React.createElement(component, props))); return h;
  }
  try {
    await t.test('sale, custody, disabled and policy0 retain physical amounts distinct from sellable', async () => {
      const f = fixture([row(10), row(11, 'custody'), row(12, 'sale', false), row(13, 'sale', true, '0')]); const h = await mount(ui.InventoryPanel, { refresh: 0 }, f);
      await until(() => h.container.querySelectorAll('tbody tr').length === 4, 'stock rows');
      const headers = [...h.container.querySelectorAll('th')].map(e => e.textContent); assert.ok(headers.includes('Fizycznie dostępne')); assert.ok(headers.includes('Dostępne do sprzedaży')); assert.ok(headers.includes('Polityka magazynu'));
      const cells = [...h.container.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('td')].map(e => e.textContent));
      assert.deepEqual(cells.map(r => r.slice(3, 7)), [['7', '2', '5', '5'], ['7', '2', '5', '0'], ['7', '2', '5', '0'], ['7', '2', '5', '5']]);
      assert.equal(cells[1][7], 'Poza sprzedażą · aktywna · wersja 2'); assert.equal(cells[2][7], 'Sprzedażowy · nieaktywna · wersja 2'); assert.equal(cells[3][7], 'Sprzedażowy · aktywna · wersja 0 (domyślna)'); await h.close();
    });
    await t.test('legacy available default sale is qualified; partial fields do not invent custody or sellable amount', async () => {
      const legacy = row(20), partial = row(21);
      for (const key of ['physical_available', 'sellable_available', 'inventory_usage', 'inventory_enabled', 'inventory_policy_version']) { delete legacy[key]; delete partial[key]; }
      partial.inventory_usage = 'custody'; const f = fixture([legacy, partial]); const h = await mount(ui.InventoryPanel, { refresh: 0 }, f);
      await until(() => h.container.querySelectorAll('tbody tr').length === 2, 'old/partial rows'); const cells = [...h.container.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('td')].map(e => e.textContent));
      assert.deepEqual(cells[0].slice(5, 7), ['5', '5']); assert.equal(cells[0][7], 'Sprzedażowy · starszy odczyt, bez wersji polityki'); assert.ok(!cells[0][7].includes('wersja 0'));
      assert.deepEqual(cells[1].slice(5, 7), ['5', '—']); assert.equal(cells[1][7], 'Niepełny odczyt polityki — dostępność sprzedażowa niepotwierdzona'); assert.ok(!cells[1][7].includes('Poza sprzedażą')); await h.close();
    });
    await t.test('StockPicker uses physical available and returns unchanged selected custody row for stock operations', async () => {
      const expected = row(30, 'custody'), f = fixture([expected]); let selected;
      const h = await mount(ui.StockPicker, { label: 'Produkt przesunięcia', warehouse, value: '', select: value => { selected = value; } }, f);
      await until(() => [...h.container.querySelectorAll('option')].some(e => e.value === expected.product_id), 'picker stock'); const select = h.container.querySelector('select'), option = [...select.options].find(e => e.value === expected.product_id);
      assert.ok(option.textContent.includes('fizycznie dostępne 5')); assert.ok(!option.textContent.includes('dostępne 0'));
      await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, expected.product_id); select.dispatchEvent(new Event('change', { bubbles: true })); });
      assert.deepEqual(selected, expected); assert.equal(selected.available, 5); assert.equal(selected.sellable_available, 0); assert.equal(new URL('http://127.0.0.1' + f.reads.find(p => p.startsWith('/inventory?'))).searchParams.get('warehouse_id'), warehouse); await h.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close(); await vite.close(); dom.window.close(); globalThis.fetch = oldFetch;
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});
