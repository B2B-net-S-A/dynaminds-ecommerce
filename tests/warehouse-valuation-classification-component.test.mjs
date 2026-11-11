import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual WmsLotsWorkspace and valuation rendering, controlled HTTP only.
// These fixtures do not prove SQL valuation, IAM, stock writes or native UI.
const id = n => `${String(n).padStart(8, '0')}-1630-4163-8163-163163163163`;
const tenant = id(1), user = id(2), context = `${tenant}:${user}:admin:false`;
const flags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_write: false, can_admin: false, can_read_value: true };
const stats = (quantity, known, unknown, value, zero, reserved, sellable, sellableAvailable) => ({ quantity, totalquantity: quantity, physical_quantity: quantity, known_quantity: known, unknown_quantity: unknown, known_minor: value, zero_cost_quantity: zero, reserved_quantity: reserved, physical_available: (BigInt(quantity) - BigInt(reserved)).toString(), sellable_quantity: sellable, sellable_available: sellableAvailable, currency: 'PLN', exponent: 2 });
function valuation() {
  const sale = stats('3', '2', '1', '0', '2', '1', '3', '2');
  const custody = stats('4', '2', '2', '9007199254740993', '0', '0', '0', '0');
  const disabled = stats('2', '2', '0', '1700', '0', '0', '0', '0');
  return { ...stats('9', '6', '3', '9007199254742693', '2', '1', '3', '2'), warehouse_policy_available: true, snapshot_at: '2026-10-07T12:00:00Z', warehouses: [
    { warehouse_id: id(10), name: 'Sprzedaż własna', code: 'SALE', policy: { usage: 'sale', enabled: true, version: '0' }, valuation: sale },
    { warehouse_id: id(11), name: 'Kontrola własna', code: 'HOLD', policy: { usage: 'custody', enabled: true, version: '1' }, valuation: custody },
    { warehouse_id: id(12), name: 'Sprzedaż wstrzymana', code: 'STOP', policy: { usage: 'sale', enabled: false, version: '2' }, valuation: disabled },
  ], usage_buckets: [
    { usage: 'sale', valuation: stats('5', '4', '1', '1700', '2', '1', '3', '2') },
    { usage: 'custody', valuation: custody },
  ] };
}
function fixture() {
  const f = { flags: { ...flags }, value: valuation(), enabled: true, reads: [], writes: [], hold: null };
  f.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://127.0.0.1'), p = u.pathname.replace(/^\/api/, '');
    if ((init.method ?? 'GET') !== 'GET') { f.writes.push({ path: p, method: init.method }); throw Error('This read-only component case forbids mutations'); }
    f.reads.push(p + u.search);
    if (p === '/wms-lots') return Response.json({ ...f.flags, policy: { enabled: f.enabled, version: f.enabled ? '1' : '0', method: 'FIFO', currency: f.enabled ? 'PLN' : null, exponent: 2 }, warehouses: valuation().warehouses.map(w => ({ id: w.warehouse_id, name: w.name, code: w.code })), limits: {} });
    if (p === '/wms-lots/positions') return Response.json({ ...f.flags, data: [], meta: { cursor: null } });
    if (p === '/wms-lots/valuation') {
      const reply = { current_role: f.flags.current_role, can_read_value: f.flags.can_read_value, valuation: structuredClone(f.value) };
      if (f.hold) await f.hold;
      return Response.json(reply);
    }
    throw Error('Unexpected controlled GET ' + p);
  };
  return f;
}
async function tick() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function until(fn, note) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.ok(fn(), note); }
function button(h, name) { const e = [...h.container.querySelectorAll('button')].find(e => e.textContent.trim() === name); assert.ok(e, name); return e; }
async function click(e) { assert.equal(e.matches(':disabled'), false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(e, text) { await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(e, text); e.dispatchEvent(new Event('change', { bubbles: true })); }); }
function cells(h, name) { const row = [...h.container.querySelectorAll('tbody tr')].find(e => e.querySelector('th')?.textContent.startsWith(name)); assert.ok(row, name); return [...row.querySelectorAll('td')].map(e => e.textContent); }

test('warehouse valuation classification actual mounted WMS workspace — controlled HTTP', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' }), mounts = [];
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/wms-lots.tsx')), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  async function mount(f, extra = {}) {
    globalThis.fetch = f.fetch; api.setWorkspace(tenant);
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const h = { container, props: { contextKey: context, readOnly: false, ...extra }, async render(p = {}) { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(ui.WmsLotsWorkspace, h.props))); }, async close() { await act(async () => root.unmount()); container.remove(); } };
    mounts.push(h); await h.render(); await until(() => [...h.container.querySelectorAll('button')].some(e => e.textContent.trim() === 'Odczytaj zapas i wartość' && !e.matches(':disabled')), 'Actual metadata read'); return h;
  }
  async function read(h) { await click(button(h, 'Odczytaj zapas i wartość')); await until(() => !button(h, 'Odczytaj zapas i wartość').matches(':disabled'), 'Actual read completed'); }
  try {
    await t.test('same-snapshot SALE/CUSTODY and disabled SALE retain physical value, exact large money and zero versus NULL', async () => {
      const f = fixture(), h = await mount(f); await read(h);
      assert.deepEqual(cells(h, 'Cały odczytany zakres'), ['9', '1', '8', '3', '2', '6', '90 071 992 547 426,93 PLN', '2', '3']);
      assert.deepEqual(cells(h, 'SALE — magazyny sprzedaży'), ['5', '1', '4', '3', '2', '4', '17,00 PLN', '2', '1']);
      assert.deepEqual(cells(h, 'HOLD — Kontrola własna'), ['4', '0', '4', '0', '0', '2', '90 071 992 547 409,93 PLN', '0', '2']);
      assert.deepEqual(cells(h, 'STOP — Sprzedaż wstrzymana'), ['2', '0', '2', '0', '0', '2', '17,00 PLN', '0', '0']);
      assert.deepEqual(cells(h, 'SALE — Sprzedaż własna'), ['3', '1', '2', '3', '2', '2', '0,00 PLN', '2', '1']);
      assert.ok(h.container.textContent.includes('wersja 0')); assert.ok(h.container.textContent.includes('bez przypisania zapasu do konkretnych zwrotów')); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('old valuation DTO preserves the total and explicitly lacks classification; complete old policy absence shows default SALE', async () => {
      const f = fixture(); f.value = { quantity: '9', totalquantity: '9', known_quantity: '6', unknown_quantity: '3', known_minor: '1700', currency: 'PLN', exponent: 2 }; const h = await mount(f); await read(h);
      assert.ok(h.container.textContent.includes('Klasyfikacja SALE/CUSTODY nie jest dostępna')); assert.ok(h.container.textContent.includes('17,00 PLN')); assert.equal(h.container.querySelectorAll('.wms-table caption').length, 0); await h.close();
      const old = fixture(), v = stats('3', '2', '1', '0', '2', '1', '3', '2'); old.value = { ...v, warehouse_policy_available: false, snapshot_at: '2026-10-07T12:00:00Z', warehouses: [valuation().warehouses[0]], usage_buckets: [{ usage: 'sale', valuation: v }, { usage: 'custody', valuation: stats('0', '0', '0', '0', '0', '0', '0', '0') }] }; const next = await mount(old); await read(next);
      assert.ok(next.container.textContent.includes('dotychczasowej polityki domyślnej SALE')); assert.equal(cells(next, 'Cały odczytany zakres')[0], '3'); assert.equal(old.writes.length, 0); await next.close();
    });
    await t.test('inconsistent or partial classification never publishes misleading warehouse rows or invented zeros', async () => {
      for (const mutate of [v => { v.usage_buckets[0].valuation.known_minor = '0'; }, v => { delete v.warehouses[0].valuation.unknown_quantity; }, v => { v.warehouses[1].policy.version = '0'; }]) {
        const f = fixture(); mutate(f.value); const h = await mount(f); await read(h); assert.ok(h.container.querySelector('[role="alert"]')?.textContent.includes('Nie można potwierdzić pełnej klasyfikacji')); assert.equal(h.container.querySelectorAll('.wms-table caption').length, 0); assert.equal(f.writes.length, 0); await h.close();
      }
    });
    await t.test('value permission absent and WMS OFF avoid valuation requests, while read-only copy can read permitted value', async () => {
      for (const configure of [f => { f.flags.can_read_value = false; }, f => { f.enabled = false; }]) { const f = fixture(); configure(f); const h = await mount(f); await read(h); assert.equal(f.reads.some(p => p.startsWith('/wms-lots/valuation')), false); assert.equal(h.container.querySelectorAll('.wms-table caption').length, 0); assert.equal(f.writes.length, 0); await h.close(); }
      const f = fixture(); f.flags.read_only = true; const h = await mount(f, { readOnly: true }); await read(h); assert.ok(h.container.textContent.includes('Podgląd kopii')); assert.equal(cells(h, 'Cały odczytany zakres')[0], '9'); assert.equal(f.writes.length, 0); await h.close();
    });
    await t.test('warehouse change clears old classification and sends the exact warehouse filter', async () => {
      const f = fixture(), h = await mount(f); await read(h); const select = [...h.container.querySelectorAll('label')].find(e => e.firstChild?.textContent.trim() === 'Magazyn')?.querySelector('select'); assert.ok(select); await value(select, id(10));
      assert.equal(h.container.querySelectorAll('.wms-table caption').length, 0); const v = stats('3', '2', '1', '0', '2', '1', '3', '2'); f.value = { ...v, warehouse_policy_available: true, snapshot_at: '2026-10-07T12:00:00Z', warehouses: [valuation().warehouses[0]], usage_buckets: [{ usage: 'sale', valuation: v }, { usage: 'custody', valuation: stats('0', '0', '0', '0', '0', '0', '0', '0') }] }; await read(h);
      assert.ok(f.reads.includes('/wms-lots/valuation?warehouse_id=' + id(10))); assert.equal(cells(h, 'Cały odczytany zakres')[0], '3');
      const table = h.container.querySelector('section[aria-label="Bieżąca wycena fizyczna według przeznaczenia magazynów"] table'); assert.ok(table); assert.equal(table.tBodies[0].rows.length, 4, 'Total, two usage buckets and exactly the selected warehouse'); assert.ok(!table.textContent.includes('HOLD — Kontrola własna')); assert.ok(!table.textContent.includes('STOP — Sprzedaż wstrzymana')); await h.close();
    });
    await t.test('late former-actor valuation is ignored after scope and read-only replacement', async () => {
      const f = fixture(); let release; f.hold = new Promise(resolve => { release = resolve; }); const h = await mount(f); await click(button(h, 'Odczytaj zapas i wartość')); await until(() => f.reads.some(p => p.startsWith('/wms-lots/valuation')), 'Held value response');
      f.flags.current_role = 'viewer'; f.flags.can_read_value = false; f.flags.read_only = true; api.setWorkspace(id(90)); await h.render({ contextKey: `${id(90)}:${id(91)}:viewer:true`, readOnly: true });
      await act(async () => { release(); await Promise.resolve(); }); await until(() => h.container.textContent.includes('Koszty i wartość zapasu są ukryte'), 'New actor metadata'); assert.ok(!h.container.textContent.includes('90 071 992')); assert.equal(h.container.querySelectorAll('.wms-table caption').length, 0); assert.equal(f.writes.length, 0); await h.close();
    });
  } finally { for (const h of mounts) if (h.container.isConnected) await h.close(); await vite.close(); dom.window.close(); globalThis.fetch = oldFetch; for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
});
