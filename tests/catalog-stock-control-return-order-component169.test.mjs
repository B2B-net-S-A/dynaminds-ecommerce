import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Real ReturnsPanel -> ReturnCase -> ReturnStockReceipts, supplied embedded
// GET-order DTO and controlled ordinary B2B reads. Not SQL/native/API proof.
const id = n => `${String(n).padStart(8, '0')}-1690-4169-8169-169169169169`;
const tenant = id(1), user = id(2), orderId = id(3), returnId = id(4), otherReturn = id(5);
const initialContext = `${tenant}:${user}:admin`;
function savedHead(n) {
  const warehouse = { id: id(10 + n), tenant_id: tenant,
    name: n === 1 ? 'Magazyn sprzedaży' : 'Kontrola zwrotów', code: n === 1 ? 'SALE' : 'HOLD' };
  const series = { id: id(20 + n), tenant_id: tenant, warehouse_id: warehouse.id,
    kind: 'PZ', version: '1', name: 'PZ', prefix: n === 1 ? 'PZ-SALE' : 'PZ-HOLD' };
  return { id: id(30 + n), receipt_id: id(40), return_id: returnId, order_id: orderId,
    warehouse_id: warehouse.id, kind: 'PZ', number: `${series.prefix}/2026/000001`,
    year: 2026, sequence: '1', series_id: series.id, row_count: n === 1 ? 2 : 1,
    quantity: n === 1 ? '2' : '1', wms_enabled: false,
    created_at: '2026-10-07T12:34:56.123456+00:00', warehouse, series };
}
function savedCase(receipts, extra = {}) {
  return { id: returnId, order_id: orderId, number: 'RMA-OWN-169', version: '2',
    kind: 'return', state: 'refund_pending', reason: 'Przyjęcie do dwóch magazynów',
    created_at: '2026-10-07T11:00:00Z', received_at: '2026-10-07T12:34:56Z',
    accepted_at: '2026-10-07T12:34:56Z', requested_shipping: 0, refund_amount: 2700,
    legacy: false, can_exchange: false, exchange: null,
    items: [{ item_id: id(50), sku: 'SAME-SKU', name: 'Pierwsza oryginalna pozycja',
      requested: 1, accepted: 1, restocked: 1, refund_amount: 1000,
      components: [{ product_id: id(60), quantity: 2 }] },
    { item_id: id(51), sku: 'SAME-SKU', name: 'Druga oryginalna pozycja',
      requested: 2, accepted: 1, restocked: 0, refund_amount: 1700,
      components: [{ product_id: id(61), quantity: 1 }] }],
    ...(receipts === undefined ? {} : { stock_receipts: receipts }), ...extra };
}
function savedOrder(receipts, version = '1') {
  return { id: orderId, version, currency: 'PLN', status: 'return_received',
    fulfillment_kind: 'local', documents: [], wms_lots_enabled: false,
    items: [{ id: id(50), sku: 'SAME-SKU', name: 'Pierwsza oryginalna pozycja',
      quantity: 1, price: 1000, line_total: 1000, vat: 23 },
    { id: id(51), sku: 'SAME-SKU', name: 'Druga oryginalna pozycja',
      quantity: 2, price: 1700, line_total: 3400, vat: 23 }],
    returns: { cases: [savedCase(receipts), savedCase([], { id: otherReturn,
      number: 'RMA-OTHER-169', state: 'requested', received_at: null,
      accepted_at: null, refund_amount: 0, reason: 'Inna sprawa bez przyjęcia' })],
    items: [], refund_total: 2700, settled_total: 0, shipping_available: 0,
    meta: { cursor: null } } };
}
const article = (h, number) => [...h.container.querySelectorAll('article.return-case')]
  .find(el => el.querySelector('.return-heading strong')?.textContent.includes(number));
const receiptSection = (h, number = 'RMA-OWN-169') => article(h, number)
  ?.querySelector('section[aria-label="Dokumenty przyjęcia zwrotu"]') ?? null;
const cells = row => [...row.querySelectorAll('td')].map(el => el.textContent);

test('embedded order returns display saved PZ through the real ReturnsPanel route — controlled DOM', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/' });
  const previous = new Map(), originalFetch = globalThis.fetch, mounts = [];
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  let vite;
  try {
    vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
    const { createRoot } = await import('react-dom/client');
    const ui = await vite.ssrLoadModule(path.resolve('web/returns.tsx'));
    const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    const shared = await vite.ssrLoadModule(path.resolve('web/b2b-dropshipping-returns.tsx'));
    const intake = await vite.ssrLoadModule(path.resolve('web/return-destinations-intake.tsx'));
    const statuses = await vite.ssrLoadModule(path.resolve('web/return-destination-statuses.tsx'));
    const policies = await vite.ssrLoadModule(path.resolve('web/warehouse-inventory-policies.tsx'));
    async function mount(order) {
      const container = document.createElement('div'); document.body.append(container);
      const root = createRoot(container);
      const pendingReads = [];
      const h = { container, requests: [], changed: 0,
        props: { order, write: false, contextKey: initialContext, readOnly: false,
          onChanged: () => { h.changed++; } },
        async render(patch = {}) {
          await act(async () => {
            h.props = { ...h.props, ...patch };
            api.setWorkspace(h.props.contextKey.split(':')[0]);
            shared.resetDropshipReturnContext(h.props.contextKey, h.props.readOnly);
            const canonical = `${h.props.contextKey}:${h.props.readOnly}`;
            intake.resetReturnDestinationsIntakeContext(canonical);
            statuses.resetReturnDestinationStatusesContext(canonical);
            policies.resetWarehouseInventoryPoliciesContext(canonical);
            root.render(React.createElement(ui.ReturnsPanel, h.props));
          });
          await h.flushReads();
        },
        async flushReads() {
          // Resolve controlled fetches inside act, including response.json and
          // the production read's finally callbacks, before another render or unmount.
          await act(async () => {
            for (let turn = 0; turn < 20; turn++) {
              const batch = pendingReads.splice(0);
              for (const read of batch) read.resolve(Response.json(read.body));
              await new Promise(resolve => setTimeout(resolve, 0));
              if (!pendingReads.length) return;
            }
            assert.fail('Controlled return-context reads did not settle');
          });
        },
        async close() { if (!container.isConnected) return;
          await h.flushReads();
          await act(async () => {
            root.unmount();
            await new Promise(resolve => setTimeout(resolve, 0));
          });
          assert.equal(pendingReads.length, 0, 'No controlled read remains pending at unmount');
          container.remove(); },
      };
      globalThis.fetch = (url, init = {}) => {
        const scope = { contextKey: h.props.contextKey, readOnly: h.props.readOnly };
        h.requests.push({ path: String(url), method: init.method });
        assert.equal(init.method, 'GET', 'Displaying an embedded receipt must not write or acknowledge anything');
        assert.equal(init.headers['X-Workspace-ID'], tenant);
        assert.ok([returnId, otherReturn].some(rma => String(url) === `/api/b2b/dropshipping-returns/returns/${rma}/context`), 'Only real ordinary return-context reads are expected');
        const body = { available: true, read_only: scope.readOnly,
          current_role: scope.contextKey.split(':')[2], can_read: true, can_manage: false,
          can_read_value: false, can_preview: false, can_submit: false,
          context: { side: null, fulfillment_origin: 'ordinary', can_receive_locally: true,
            local_origin: null, retail_items: [], case_refs: [] } };
        return new Promise(resolve => pendingReads.push({ resolve, body }));
      };
      mounts.push(h); await h.render(); return h;
    }
    function assertReadOnly(h) {
      assert.ok(h.requests.length >= 2, 'Actual nested components perform the expected own-RMA context reads');
      assert.ok(h.requests.every(r => r.method === 'GET' && [returnId, otherReturn]
        .some(rma => r.path === `/api/b2b/dropshipping-returns/returns/${rma}/context`)));
      assert.equal(h.changed, 0, 'Reading PZ does not report a new completed intake');
      assert.equal(h.container.querySelectorAll('form').length, 0);
    }

    await t.test('embedded own RMA displays its issued PZ and original same-SKU items, while another case remains neutral', async () => {
      const heads = [savedHead(1), savedHead(2)];
      heads[0].unit_cost_minor = 'PRIVATE_COST_SENTINEL';
      const h = await mount(savedOrder(heads));
      assert.equal(h.container.querySelectorAll('article.return-case').length, 2);
      const own = article(h, 'RMA-OWN-169'); assert.ok(own);
      const originalRows = [...own.querySelector('table').querySelectorAll('tbody tr')];
      assert.equal(originalRows.length, 2);
      assert.deepEqual(originalRows.map(row => cells(row).slice(0, 5)), [
        ['SAME-SKUPierwsza oryginalna pozycja', '1', '1', '1', '0'],
        ['SAME-SKUDruga oryginalna pozycja', '2', '1', '0', '1'],
      ]);
      const rows = [...receiptSection(h).querySelectorAll('tbody tr')];
      assert.deepEqual(rows.map(row => cells(row).slice(0, 4)), [
        ['PZ-SALE/2026/000001', 'Magazyn sprzedaży SALE', '2', '2'],
        ['PZ-HOLD/2026/000001', 'Kontrola zwrotów HOLD', '1', '1'],
      ]);
      assert.equal(receiptSection(h, 'RMA-OTHER-169'), null);
      assert.ok(!h.container.textContent.includes('PRIVATE_COST_SENTINEL'));
      assertReadOnly(h); await h.close();
    });

    await t.test('a genuine order reload adds saved PZ to an already rendered RMA; absent and empty old-schema fields stay neutral', async () => {
      const h = await mount(savedOrder(undefined));
      assert.ok(article(h, 'RMA-OWN-169')); assert.equal(receiptSection(h), null);
      await h.render({ order: savedOrder([], '2') }); assert.equal(receiptSection(h), null);
      await h.render({ order: savedOrder([savedHead(2)], '3') });
      assert.ok(receiptSection(h)?.textContent.includes('PZ-HOLD/2026/000001'));
      assert.equal(receiptSection(h).querySelectorAll('tbody tr').length, 1);
      assert.ok(article(h, 'RMA-OWN-169').textContent.includes('Druga oryginalna pozycja'));
      assertReadOnly(h); await h.close();
    });

    await t.test('real parent context changes purge retained PZ until a fresh embedded response, including read-only restore history', async () => {
      const retained = savedOrder([savedHead(1)]), h = await mount(retained);
      assert.ok(receiptSection(h));
      await h.render({ contextKey: `${tenant}:${id(70)}:viewer` });
      assert.equal(receiptSection(h), null, 'Actor-change render cannot relabel a retained PZ response');
      assert.ok(!h.container.textContent.includes('PZ-SALE/2026/000001'));
      await h.render(); assert.equal(receiptSection(h), null);
      await h.render({ order: structuredClone(retained) }); assert.ok(receiptSection(h));
      await h.render({ readOnly: true });
      assert.equal(receiptSection(h), null, 'Canonical restore bit participates in the actual child scope');
      await h.render({ order: structuredClone(retained) });
      assert.ok(receiptSection(h)?.textContent.includes('PZ-SALE/2026/000001'));
      assert.ok(![...h.container.querySelectorAll('button')].some(button =>
        ['Rozpatrz i przyjmij', 'Potwierdź zwrot środków'].includes(button.textContent)));
      assertReadOnly(h); await h.close();
    });
  } finally {
    for (const h of mounts) await h.close();
    await vite?.close(); dom.window.close(); globalThis.fetch = originalFetch;
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});
