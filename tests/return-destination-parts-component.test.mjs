import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act, useState } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual controlled production widget. No simulated stock movements or API implementation.
const id = n => `${String(n).padStart(8, '0')}-1610-4161-8161-161161161161`;
const sale = { id: id(10), version: '1', revision_id: id(110), settings: { name: 'Do sprzedaży', color: '#22aa44', active: true, decision: 'accept', inventory_effect: 'sale', warehouse_id: id(20), warehouse_policy_version: '0', default_location: 'RETURN-01' } };
const custody = { id: id(11), version: '2', revision_id: id(111), settings: { name: 'Do kontroli', color: '#ffaa00', active: true, decision: 'accept', inventory_effect: 'custody', warehouse_id: id(21), warehouse_policy_version: '2', default_location: 'CHECK-01' } };
const reject = { id: id(12), version: '1', revision_id: id(112), settings: { name: 'Odrzucone', color: '#aa2222', active: true, decision: 'reject', inventory_effect: 'none', warehouse_id: null, warehouse_policy_version: null, default_location: null } };
const warehouses = [{ id: id(20), name: 'Główny', code: 'MAIN' }, { id: id(21), name: 'Kontrola', code: 'HOLD' }];
const lines = [
  { item_id: id(30), ordinal: 0, sku: 'SAME-A', name: 'A cena pierwsza', requested: 3, ordered_quantity: 3, line_total_minor: 1000, components: [{ product_id: id(40), sku: 'A', quantity: 1 }] },
  { item_id: id(31), ordinal: 1, sku: 'SAME-A', name: 'A cena druga', requested: 2, ordered_quantity: 2, line_total_minor: 3401, components: [{ product_id: id(40), sku: 'A', quantity: 1 }] },
  { item_id: id(32), ordinal: 2, sku: 'BUNDLE', name: 'Zestaw historyczny', requested: 2, ordered_quantity: 3, line_total_minor: 6000, components: [{ product_id: id(40), sku: 'A', quantity: 1 }, { product_id: id(41), sku: 'B', quantity: 2 }] },
];
const part = (n, item, quantity, status = sale) => ({ part_id: id(n), item_id: item, quantity, status_id: status.id, status_version: status.version });
const full = () => lines.map((l, i) => part(50 + i, l.item_id, l.requested));
function button(h, text) { const e = [...h.container.querySelectorAll('button')].find(e => e.textContent === text); assert.ok(e, text); return e; }
async function click(e) { assert.equal(e.disabled, false); assert.equal(e.closest('fieldset')?.disabled ?? false, false); await act(async () => e.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
async function value(e, v) { const proto = e.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }
test('return destinations controlled split/merge component', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' }), saved = new Map(), oldFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v }); }
  globalThis.fetch = () => { throw Error('This widget must never request an API'); };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client'), ui = await vite.ssrLoadModule(path.resolve('web/return-destination-parts.tsx')); const mounts = [];
  async function mount(initial = full(), extra = {}) {
    const h = { container: document.createElement('div'), changes: [], validities: [], current: null, props: { returnId: id(1), currency: 'PLN', lines: structuredClone(lines), statuses: structuredClone([sale, custody, reject]), warehouses: structuredClone(warehouses), readOnly: false, ...extra } };
    document.body.append(h.container); const root = createRoot(h.container);
    function Harness() {
      const [parts, setParts] = useState(initial); h.current = parts; h.replace = setParts;
      return React.createElement(ui.ReturnDestinationPartsEditor, { ...h.props, value: parts, onChange: (next, change) => { h.changes.push({ next: structuredClone(next), change: structuredClone(change) }); setParts(next); }, onValidityChange: v => h.validities.push(v) });
    }
    h.render = async p => { h.props = { ...h.props, ...p }; await act(async () => root.render(React.createElement(Harness))); };
    h.close = async () => { await act(async () => root.unmount()); h.container.remove(); }; mounts.push(h); await h.render({}); return h;
  }
  try {
    await t.test('explicit initialization covers each original UUID separately, sameSKU prices and frozen bundle visible', async () => {
      const h = await mount([]); assert.equal(h.changes.length, 0); assert.equal(h.validities.at(-1).valid, false);
      const select = h.container.querySelector('select'); await value(select, sale.id + ':1'); await click(button(h, 'Utwórz części wszystkich pozycji'));
      assert.deepEqual(h.current.map(p => [p.item_id, p.quantity]), lines.map(l => [l.item_id, l.requested])); assert.equal(new Set(h.current.map(p => p.part_id)).size, 3); assert.equal(h.validities.at(-1).valid, true);
      const articles = [...h.container.querySelectorAll('article')]; assert.ok(articles[0].textContent.includes('10,00')); assert.ok(articles[1].textContent.includes('34,01')); assert.ok(articles[0].textContent.includes(id(30))); assert.ok(articles[1].textContent.includes(id(31))); assert.ok(articles[2].textContent.includes('A × 1; B × 2')); assert.ok(h.container.textContent.includes('Główny (MAIN)')); await h.close();
    });
    await t.test('split keeps original UUID and quantity; merge retires newID; subsequent split never resurrects it', async () => {
      const h = await mount(); const original = h.current[0].part_id; await value(h.container.querySelector('[aria-label="Podział pozycji 1 części 1"]'), '2'); await click(button(h, 'Podziel pozycję 1, część 1'));
      const retired = h.current[1].part_id; assert.equal(h.current[0].part_id, original); assert.notEqual(retired, original); assert.deepEqual(h.current.slice(0, 2).map(p => [p.item_id, p.quantity]), [[id(30), 2], [id(30), 1]]); assert.equal(h.changes.at(-1).change.created_part_ids[0], retired);
      await click(button(h, 'Połącz z następną częścią pozycji 1, część 1')); assert.equal(h.current[0].part_id, original); assert.equal(h.current[0].quantity, 3); assert.deepEqual(h.changes.at(-1).change.retired_part_ids, [retired]);
      await click(button(h, 'Podziel pozycję 1, część 1')); assert.notEqual(h.current[1].part_id, retired); assert.equal(h.validities.at(-1).valid, true);
      await act(async () => h.replace(h.current.map((p, i) => i === 1 ? { ...p, part_id: retired } : p))); assert.equal(h.validities.at(-1).valid, false); assert.ok(h.container.textContent.includes('Usunięty UUID części nie może zostać użyty ponownie.')); await h.close();
    });
    await t.test('different status cannot merge; explicit consistent revision permits merge without moving other sameSKU line', async () => {
      const h = await mount([part(50, id(30), 1), part(51, id(30), 2, custody), part(52, id(31), 2), part(53, id(32), 2)]);
      await click(button(h, 'Połącz z następną częścią pozycji 1, część 1')); assert.equal(h.changes.length, 0); assert.ok(h.container.textContent.includes('Najpierw wybierz ten sam status i tę samą rewizję'));
      assert.ok(h.container.textContent.includes('Kontrola (HOLD)')); await value(h.container.querySelector('[aria-label="Status pozycji 1 części 2"]'), sale.id + ':1'); await click(button(h, 'Połącz z następną częścią pozycji 1, część 1'));
      assert.deepEqual(h.current.map(p => [p.item_id, p.quantity]), [[id(30), 3], [id(31), 2], [id(32), 2]]); assert.equal(button(h, 'Połącz z następną częścią pozycji 1, część 1').disabled, true); await h.close();
    });
    await t.test('foreign item, changing identity of sameSKU original and incomplete/overclaimed coverage fail closed', async () => {
      const foreign = full(); foreign[0].item_id = id(999); const h = await mount(foreign); assert.equal(h.validities.at(-1).valid, false); assert.ok(h.container.textContent.includes('Część nie należy do oryginalnej pozycji')); assert.equal(h.container.querySelector('fieldset').disabled, true); await h.close();
      const next = await mount(); await act(async () => next.replace(next.current.map((p, i) => i === 0 ? { ...p, item_id: id(31) } : p))); assert.equal(next.validities.at(-1).valid, false); assert.ok(next.container.textContent.includes('Część zmieniła UUID oryginalnej pozycji')); assert.ok(next.container.textContent.includes('dokładnie 3 zgłoszonych sztuk')); await next.close();
      const tooMany = full(); tooMany[0].quantity = 4; const q = await mount(tooMany); assert.equal(q.validities.at(-1).valid, false); assert.equal(q.container.querySelector('fieldset').disabled, true); assert.equal(q.changes.length, 0); await q.close();
    });
    await t.test('200-part limit blocks split without weakening full coverage', async () => {
      const oneLine = { ...lines[0], requested: 201, ordered_quantity: 201 }, parts = Array.from({ length: 200 }, (_, i) => part(1000 + i, oneLine.item_id, i === 0 ? 2 : 1));
      const h = await mount(parts, { lines: [oneLine] }); assert.equal(h.validities.at(-1).valid, true); assert.equal(button(h, 'Podziel pozycję 1, część 1').disabled, true); assert.ok(h.container.textContent.includes('Osiągnięto limit 200 części.')); assert.equal(h.changes.length, 0);
      await click(button(h, 'Połącz z następną częścią pozycji 1, część 1')); assert.equal(h.current.length, 199); assert.equal(button(h, 'Podziel pozycję 1, część 1').disabled, false); assert.equal(h.current.reduce((n, p) => n + p.quantity, 0), 201); await h.close();
    });
    await t.test('updated active status requires explicit version2 choice and onChange even quantity unchanged; inactive excluded', async () => {
      const h = await mount(); const revised = { ...sale, version: '2', revision_id: id(210), settings: { ...sale.settings, name: 'Nowa rewizja sprzedaży' } }; await h.render({ statuses: [revised, custody, { ...reject, settings: { ...reject.settings, active: false } }] });
      assert.equal(h.validities.at(-1).valid, false); assert.equal(h.current[0].status_version, '1'); const select = h.container.querySelector('[aria-label="Status pozycji 1 części 1"]'); assert.ok(![...select.options].some(o => o.value === reject.id + ':1'));
      const before = h.current.map(p => [p.part_id, p.item_id, p.quantity]); await value(select, sale.id + ':2'); assert.equal(h.changes.at(-1).change.reason, 'status'); assert.equal(h.current[0].status_version, '2'); assert.deepEqual(h.current.map(p => [p.part_id, p.item_id, p.quantity]), before); assert.ok(h.container.textContent.includes('Poprzedni podgląd przyjęcia wymaga ponownego przygotowania.')); await h.close();
    });
    await t.test('readonly shows actual frozen status and names, rejects synthetic events and never fetches', async () => {
      const h = await mount(full(), { readOnly: true }); assert.ok(h.container.textContent.includes('Podział jest dostępny tylko do odczytu.')); assert.ok(h.container.textContent.includes('Główny (MAIN)')); assert.ok(h.container.textContent.includes('Rewizja 1'));
      assert.ok([...h.container.querySelectorAll('fieldset')].every(e => e.disabled)); await value(h.container.querySelector('[aria-label="Status pozycji 1 części 1"]'), custody.id + ':2'); await act(async () => button(h, 'Podziel pozycję 1, część 1').dispatchEvent(new MouseEvent('click', { bubbles: true }))); assert.equal(h.changes.length, 0); assert.deepEqual(h.current, full()); await h.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close(); await vite.close(); dom.window.close(); globalThis.fetch = oldFetch;
    for (const [key, d] of saved) if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key];
  }
});
