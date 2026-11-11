import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual production component with supplied read-only DTOs. These controlled
// DOM cases do not prove SQL receipts, API authority or native Chrome intake.
const id = n => `${String(n).padStart(8, '0')}-1690-4169-8169-169169169169`;
const returnId = id(3), orderId = id(4);
const context = `${id(1)}:${id(2)}:admin:false`;
function savedHead(n, extra = {}) {
  const warehouse = { id: id(10 + n), name: n === 1 ? 'Przyjęcie sprzedażowe' : 'Kontrola zwrotów', code: n === 1 ? 'SALE' : 'HOLD' };
  const series = { id: id(20 + n), warehouse_id: warehouse.id, kind: 'PZ', name: 'Przyjęcia zwrotów', prefix: n === 1 ? 'PZ-SALE' : 'PZ-HOLD' };
  return {
    id: id(30 + n), receipt_id: id(40), return_id: returnId, order_id: orderId,
    warehouse_id: warehouse.id, kind: 'PZ', number: `${series.prefix}/2026/000001`,
    year: 2026, sequence: '1', series_id: series.id, row_count: n === 1 ? 2 : 1,
    quantity: n === 1 ? '9007199254740993' : '3', wms_enabled: n === 1,
    created_at: '2026-10-07T12:34:56.123456+00:00', warehouse, series, ...extra,
  };
}
const receiptSection = h => h.container.querySelector('section[aria-label="Dokumenty przyjęcia zwrotu"]');
const cells = row => [...row.querySelectorAll('td')].map(cell => cell.textContent);

test('return PZ heads — actual mounted read-only component, controlled DTOs', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1' });
  const previous = new Map(), oldFetch = globalThis.fetch, calls = [], mounts = [];
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  globalThis.fetch = async (...args) => { calls.push(args); throw Error('Receipt display must not fetch or mutate'); };
  let vite;
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
    const { createRoot } = await import('react-dom/client');
    const ui = await vite.ssrLoadModule(path.resolve('web/return-stock-receipts.tsx'));
    async function mount(receipts, extra = {}) {
      const container = document.createElement('div'); document.body.append(container);
      const root = createRoot(container);
      const h = { container, props: { receipts, returnId, orderId, contextKey: context, ...extra },
        async render(next = {}) { h.props = { ...h.props, ...next }; await act(async () => root.render(React.createElement(ui.ReturnStockReceipts, h.props))); },
        async close() { await act(async () => root.unmount()); container.remove(); } };
      mounts.push(h); await h.render(); return h;
    }

    await t.test('saved PZ numbers, warehouses and exact physical quantities render without costs or requests', async () => {
      const a = savedHead(1), b = savedHead(2);
      // Unknown extra response fields must never be surfaced by this quantity view.
      a.unit_cost_minor = '9988776655'; a.private_note = 'PRIVATE_COST_SENTINEL';
      const h = await mount([a, b]);
      const section = receiptSection(h); assert.ok(section);
      const rows = [...section.querySelectorAll('tbody tr')]; assert.equal(rows.length, 2);
      assert.deepEqual(cells(rows[0]).slice(0, 4), ['PZ-SALE/2026/000001', 'Przyjęcie sprzedażowe SALE', '9\u00a0007\u00a0199\u00a0254\u00a0740\u00a0993', '2']);
      assert.deepEqual(cells(rows[1]).slice(0, 4), ['PZ-HOLD/2026/000001', 'Kontrola zwrotów HOLD', '3', '1']);
      assert.ok(cells(rows[0])[4].length > 0, 'Actual issued timestamp is presented');
      assert.ok(section.textContent.includes('Rozliczenie klienta pozostaje osobne'));
      assert.ok(!section.textContent.includes('9988776655')); assert.ok(!section.textContent.includes('PRIVATE_COST_SENTINEL'));
      assert.equal(h.container.querySelectorAll('button,input,form').length, 0);
      assert.equal(calls.length, 0); await h.close();
    });

    await t.test('old response without stock_receipts and genuine empty list stay neutral', async () => {
      const h = await mount(undefined);
      assert.equal(h.container.textContent, ''); assert.equal(receiptSection(h), null);
      await h.render({ receipts: [] }); assert.equal(h.container.textContent, '');
      assert.equal(h.container.querySelector('[role="alert"]'), null); assert.equal(calls.length, 0);
      await h.close();
    });

    await t.test('one foreign or malformed head hides the whole list, including a valid first document', async () => {
      const changes = [
        head => { head.return_id = id(90); },
        head => { head.order_id = id(91); },
        head => { head.series.id = id(92); },
        head => { head.series.warehouse_id = id(93); },
        head => { head.warehouse.id = id(94); },
        head => { head.number = 'PZ-HOLD/2026/1'; },
        head => { head.quantity = '0'; },
        head => { head.row_count = 10001; },
        head => { head.receipt_id = id(95); },
      ];
      const h = await mount([]);
      for (const alter of changes) {
        const bad = savedHead(2); alter(bad);
        await h.render({ receipts: [savedHead(1), bad] });
        assert.ok(h.container.querySelector('[role="alert"]')?.textContent.includes('Nie można potwierdzić dokumentów'));
        assert.equal(receiptSection(h), null); assert.equal(h.container.querySelectorAll('tbody tr').length, 0);
        assert.ok(!h.container.textContent.includes('PZ-SALE/2026/000001'));
        assert.ok(!h.container.textContent.includes('PZ-HOLD/2026/000001'));
      }
      assert.equal(calls.length, 0); await h.close();
    });

    await t.test('actor replacement synchronously hides retained heads until a fresh own response arrives', async () => {
      const retained = [savedHead(1)], h = await mount(retained);
      assert.ok(receiptSection(h));
      const nextReturn = id(60), nextOrder = id(61);
      await h.render({ contextKey: `${id(50)}:${id(51)}:operator:false`, returnId: nextReturn, orderId: nextOrder });
      assert.equal(h.container.textContent, '', 'Previous actor heads disappear in the context-change render');
      await h.render(); assert.equal(h.container.textContent, '', 'Rerendering the same retained array does not revive it');
      const fresh = savedHead(2, { return_id: nextReturn, order_id: nextOrder, quantity: '7' });
      await h.render({ receipts: [fresh] });
      const rows = [...receiptSection(h).querySelectorAll('tbody tr')]; assert.equal(rows.length, 1);
      assert.deepEqual(cells(rows[0]).slice(0, 4), ['PZ-HOLD/2026/000001', 'Kontrola zwrotów HOLD', '7', '1']);
      assert.ok(!h.container.textContent.includes('PZ-SALE/2026/000001'));
      assert.equal(calls.length, 0); await h.close();
    });

    await t.test('restore-context change requires new heads but permits read-only historical display', async () => {
      const retained = [savedHead(1)], h = await mount(retained);
      await h.render({ contextKey: `${id(1)}:${id(2)}:admin:true` });
      assert.equal(receiptSection(h), null); assert.equal(h.container.textContent, '');
      await h.render({ receipts: structuredClone(retained) });
      assert.ok(receiptSection(h)?.textContent.includes('PZ-SALE/2026/000001'));
      assert.equal(h.container.querySelectorAll('button,input,form').length, 0);
      await h.render({ contextKey: `${id(1)}:${id(2)}:viewer:true` });
      assert.equal(receiptSection(h), null, 'Role change also purges the retained response');
      await h.render({ receipts: structuredClone(retained) }); assert.ok(receiptSection(h));
      assert.equal(calls.length, 0); await h.close();
    });
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    await vite?.close(); dom.window.close(); globalThis.fetch = oldFetch;
    for (const [name, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }
});
