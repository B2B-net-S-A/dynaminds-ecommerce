/** "Zmień magazyn" (order card menu, migration 269): offered only before picking for a sale, lists the other
 * warehouses by name, sends the chosen one and closes only after a saved move. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('order warehouse change', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/' }), prior = new Map();
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { OrderWarehouseChange, canChangeOrderWarehouse, warehouseChoices } = await vite.ssrLoadModule(path.resolve('web/order-warehouse-change.tsx'));
  const { createRoot } = await import('react-dom/client');
  const W = [
    { id: 'w1', name: 'Warszawa' },
    { id: 'w3', name: 'Łódź' },
    { id: 'w2', name: 'Poznań' },
  ];
  const order = { id: 'o1', status: 'paid', fulfillment_kind: 'sale', source: 'manual', warehouse_id: 'w1', version: 3 };
  async function mount(props) {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(React.createElement(OrderWarehouseChange, props)));
    return { el, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
  }
  const click = (el) => act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  try {
    await t.test('offered before picking for a sale only', () => {
      assert.equal(canChangeOrderWarehouse(order), true);
      assert.equal(canChangeOrderWarehouse({ ...order, status: 'new' }), true);
      for (const status of ['picking', 'packed', 'shipped', 'cancelled']) assert.equal(canChangeOrderWarehouse({ ...order, status }), false, status);
      assert.equal(canChangeOrderWarehouse({ ...order, fulfillment_kind: 'replacement' }), false);
      assert.equal(canChangeOrderWarehouse({ ...order, source: 'order_merge' }), false);
      assert.equal(canChangeOrderWarehouse({ ...order, merge_claim: { target_order_id: 'x' } }), false);
    });
    await t.test('choices are the other warehouses, by Polish name', () => {
      assert.deepEqual(warehouseChoices(W, 'w1').map((w) => w.name), ['Łódź', 'Poznań']);
      assert.deepEqual(warehouseChoices([W[0]], 'w1'), []);
    });
    await t.test('nothing rendered for an order in picking', async () => {
      const m = await mount({ order: { ...order, status: 'picking' }, busy: false, loadWarehouses: async () => W, onMove: async () => true });
      assert.equal(m.el.innerHTML, '');
      await m.unmount();
    });
    await t.test('opens, shows the current warehouse, sends the chosen one, closes after a saved move', async () => {
      const sent = [];
      let saved = false;
      const m = await mount({ order, busy: false, loadWarehouses: async () => W, onMove: async (id) => { sent.push(id); return saved; } });
      const button = m.el.querySelector('button');
      assert.match(button.textContent, /Zmień magazyn/);
      assert.ok(button.hasAttribute('data-keep-open'), 'opening the form keeps the ⋯ Więcej menu open (useMoreMenu)');
      await click(button);
      assert.match(m.el.textContent, /Obecny magazyn: Warszawa/);
      const select = m.el.querySelector('select');
      assert.deepEqual([...select.options].map((x) => x.textContent), ['Łódź', 'Poznań']);
      await act(async () => {
        select.value = 'w2';
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
      const submit = () => act(async () => m.el.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
      await submit();
      assert.deepEqual(sent, ['w2']);
      assert.ok(m.el.querySelector('form'), 'a refused move keeps the form open');
      saved = true;
      await submit();
      assert.deepEqual(sent, ['w2', 'w2']);
      assert.equal(m.el.querySelector('form'), null);
      await m.unmount();
    });
    await t.test('a failed request shows an error and keeps the form open', async () => {
      const m = await mount({ order, busy: false, loadWarehouses: async () => W, onMove: async () => { throw new Error('network'); } });
      await click(m.el.querySelector('button'));
      await act(async () => m.el.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
      assert.match(m.el.querySelector('[role="alert"]')?.textContent ?? '', /Nie udało się zmienić magazynu/);
      assert.ok(m.el.querySelector('form'), 'the form stays open after a failed request');
      await m.unmount();
    });
    await t.test('a company with one warehouse says so and cannot send', async () => {
      const m = await mount({ order, busy: false, loadWarehouses: async () => [W[0]], onMove: async () => true });
      await click(m.el.querySelector('button'));
      assert.match(m.el.textContent, /Firma nie ma innego magazynu/);
      assert.equal(m.el.querySelector('button.primary').disabled, true);
      await m.unmount();
    });
  } finally {
    await vite.close();
    for (const [k, d] of prior) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
