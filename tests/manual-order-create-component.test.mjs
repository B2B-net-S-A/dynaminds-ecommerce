import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual CreateModal, product/price selectors, fields and API with controlled HTTP.
// Only the application's final bootstrap is omitted; no form implementation is mocked.
// This does not prove stock reservation, SQL or a native browser interaction.
const id = n => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const tenant = id(1), product = id(2), otherProduct = id(3);
const products = [
  { id: product, sku: 'SAME', name: 'Produkt katalogowy', kind: 'simple', active: true, price: 799 },
  { id: otherProduct, sku: 'OTHER', name: 'Drugi produkt', kind: 'simple', active: true, price: 2000 },
];
async function tick() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function until(check, label) {
  for (let i = 0; i < 80; i++) { if (check()) return; await tick(); }
  assert.ok(check(), label);
}
async function click(el) {
  assert.ok(el); assert.equal(el.disabled, false);
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
async function input(el, value) {
  assert.ok(el);
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(el, value) {
  assert.ok(el);
  await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
}
function button(h, text) {
  const result = [...h.container.querySelectorAll('button')].find(el => el.textContent.trim() === text);
  assert.ok(result, text); return result;
}
const amount = (h, n) => h.container.querySelector(`input[aria-label="Kwota brutto pozycji ${n}"]`);
const quantity = (h, n) => h.container.querySelector(`input[aria-label="Ilość ${n}"]`);
async function submit(h) {
  await act(async () => { h.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

test('manual order commercial rows: actual component regressions', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const saved = new Map(), oldFetch = globalThis.fetch;
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    location: dom.window.location, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData, crypto: webcrypto,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const mainPath = path.resolve('web/main.tsx');
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error',
    plugins: [{
      name: 'manual-create-component-without-app-bootstrap', enforce: 'pre',
      transform(code, file) {
        if (file.split('?')[0] !== mainPath) return;
        const start = code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)");
        assert.ok(start > 0, 'Exactly the app bootstrap must be found');
        return { code: code.slice(0, start), map: null };
      },
    }],
  });
  const mounts = [];
  try {
    const { createRoot } = await import('react-dom/client');
    const mod = await vite.ssrLoadModule(mainPath), api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
    api.setWorkspace(tenant);
    async function mount({ health = () => ({ manual_order_lines_available: true }), orderReply } = {}) {
      const writes = [], requests = [], unexpected = []; let savedCount = 0;
      globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, method: options.method });
        if (url === '/api/health') return Response.json(await health());
        assert.equal(options.headers['X-Workspace-ID'], tenant, 'All own data requests use the active workspace');
        if (url === '/api/warehouses') return Response.json({ data: [{ id: id(4), name: 'MAIN' }] });
        if (url === '/api/integrations/workspace') return Response.json({ registry: [] });
        if (url === '/api/settings' && options.method === 'GET') return Response.json({ tenant: { currency: 'PLN' }, warehouses: [{ id: id(4), name: 'MAIN' }] });
        if (url === '/api/order-fields') return Response.json({ available: false, data: [], current_role: 'admin', read_only: false });
        if (url.startsWith('/api/products?')) return Response.json({ data: products, meta: { cursor: null } });
        if (url.startsWith('/api/price-lists?')) return Response.json({ data: [], meta: { cursor: null } });
        if (url === '/api/pricing/quote') {
          const body = JSON.parse(options.body);
          return Response.json({ currency: 'PLN', list: null, items: body.product_ids.map(product_id => ({ product_id, price: products.find(p => p.id === product_id).price, source: 'catalog' })) });
        }
        if (url === '/api/orders' && options.method === 'POST') {
          const body = JSON.parse(options.body);
          writes.push({ body, serialized: options.body, key: options.headers['Idempotency-Key'] });
          if (orderReply) return orderReply(body, writes.length);
          return Response.json({ id: id(5), currency: body.currency, total: body.manual_lines.reduce((sum, row) => sum + row.line_total, 0) + body.shipping_cost,
            items: body.manual_lines.map((row, index) => ({ ...row, id: id(10 + index), price: Math.floor(row.line_total / row.quantity) })).reverse() });
        }
        unexpected.push(url); throw Error(`Unexpected controlled route: ${url}`);
      };
      const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
      const h = { container, writes, requests, unexpected, get savedCount() { return savedCount; },
        async render(readOnly = false) { await act(async () => root.render(React.createElement(mod.CreateModal, { kind: 'order', readOnly, onClose() {}, onSaved() { savedCount++; } }))); },
        async close() { await act(async () => root.unmount()); container.remove(); },
      };
      mounts.push(h); await h.render();
      await until(() => container.querySelector('input[name=customer_name]'), 'Order form loaded');
      await until(() => !container.textContent.includes('Sprawdzanie obsługi'), 'Capability read finished');
      for (const [field, value] of Object.entries({ customer_name: 'Klient DEMO', email: 'demo@example.invalid', street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', shipping_cost: '0' })) await input(container.querySelector(`[name=${field}]`), value);
      return h;
    }
    async function enable(h) { await click(h.container.querySelector('input[type=checkbox]')); await tick(); }
    async function choose(h, n, productId = product) {
      await select(h.container.querySelector(`select[aria-label="Produkt ${n}"]`), productId);
      await until(() => amount(h, n)?.value === (productId === product ? '7.99' : '20.00'), 'Current catalogue price loaded');
    }

    await t.test('same product 10/17 stays two commercial rows with aggregate reservation and unordered response', async () => {
      const h = await mount();
      try {
        await enable(h); await choose(h, 1); await input(amount(h, 1), '10,00');
        await click(button(h, 'Dodaj pozycję')); await choose(h, 2); await input(amount(h, 2), '17.00');
        await submit(h); await until(() => h.savedCount === 1, 'Confirmed separate returned rows');
        assert.deepEqual(h.writes[0].body.manual_lines, [{ product_id: product, quantity: 1, line_total: 1000 }, { product_id: product, quantity: 1, line_total: 1700 }]);
        assert.deepEqual(h.writes[0].body.items, [{ product_id: product, quantity: 2 }]);
        assert.equal(h.writes[0].body.price_list_id, undefined);
        assert.equal(h.writes[0].body.manual_lines.some(row => 'draftKey' in row || 'id' in row), false);
        assert.equal(h.writes[0].body.shipping_cost, 0);
      } finally { await h.close(); }
    });

    await t.test('catalogue quantity recalculates until edited; new product resets the whole-row amount', async () => {
      const h = await mount();
      try {
        await enable(h); await choose(h, 1); await input(quantity(h, 1), '3');
        assert.equal(amount(h, 1).value, '23.97');
        await input(amount(h, 1), '17.01'); await input(quantity(h, 1), '2');
        assert.equal(amount(h, 1).value, '17.01', 'Edited total is not changed by quantity');
        await select(h.container.querySelector('select[aria-label="Produkt 1"]'), otherProduct);
        await until(() => amount(h, 1).value === '40.00', 'Product change resets to current catalogue price');
        await input(quantity(h, 1), '1e2');
        assert.equal(amount(h, 1).value, '2000.00', 'Valid integer numeric spelling does not throw BigInt syntax error');
        await click(h.container.querySelector('input[type=checkbox]'));
        const priceSummary = [...h.container.querySelectorAll('summary')].find(s => s.textContent.includes('Opcjonalny cennik'));
        assert.ok(priceSummary); await act(async () => priceSummary.click());
        await until(() => h.container.querySelector('.price-picker'), 'Optional price-list panel expanded');
        assert.equal(amount(h, 1), null); assert.ok(h.container.querySelector('.price-picker'), 'Original price-list flow restored');
      } finally { await h.close(); }
    });

    await t.test('missing initial or fresh manual capability prevents custom-lines POST', async () => {
      let h = await mount({ health: () => ({}) });
      try {
        assert.equal(h.container.querySelector('input[type=checkbox]').disabled, true);
        assert.equal(h.writes.length, 0);
      } finally { await h.close(); }
      let reads = 0; h = await mount({ health: () => ++reads === 1 ? { manual_order_lines_available: true } : {} });
      try {
        await enable(h); await choose(h, 1); await submit(h);
        await until(() => h.container.textContent.includes('Zamówienia nie wysłano'), 'Fresh server no longer supports the body');
        assert.equal(reads, 2); assert.equal(h.writes.length, 0); assert.equal(h.savedCount, 0);
        assert.equal(h.container.querySelector('input[type=checkbox]').disabled, true);
      } finally { await h.close(); }
    });

    await t.test('lost response retains exactly the same commercial body and idempotency key for manual retry', async () => {
      const h = await mount({ orderReply(body, attempt) {
        if (attempt === 1) throw Error('Controlled lost order ACK');
        return Response.json({ id: id(5), currency: body.currency, total: 1701, items: [{ ...body.manual_lines[0], id: id(10), price: 850 }], reused: true });
      } });
      try {
        await enable(h); await choose(h, 1); await input(quantity(h, 1), '2'); await input(amount(h, 1), '17.01');
        await submit(h); await until(() => h.container.textContent.includes('Controlled lost order ACK'), 'Unknown response retained');
        assert.equal(h.savedCount, 0); assert.equal(h.container.querySelector('fieldset').disabled, true);
        assert.equal(h.writes.length, 1); const healthReads = h.requests.filter(r => r.url === '/api/health').length;
        await submit(h); await until(() => h.savedCount === 1, 'Explicit exact retry confirmed');
        assert.equal(h.writes.length, 2); assert.equal(h.writes[1].serialized, h.writes[0].serialized); assert.equal(h.writes[1].key, h.writes[0].key);
        assert.equal(h.requests.filter(r => r.url === '/api/health').length, healthReads + 1, 'Exact retry still verifies current server support');
        assert.equal(h.container.querySelector('fieldset').disabled, false);
      } finally { await h.close(); }
    });

    await t.test('retained manual retry refuses a restored older server and preserves the exact attempt until support returns', async () => {
      let supported = true;
      const h = await mount({ health: () => supported ? { manual_order_lines_available: true } : {}, orderReply(body, attempt) {
        if (attempt === 1) throw Error('Controlled lost ACK before server restore');
        return Response.json({ id: id(5), currency: body.currency, total: 1000, items: [{ ...body.manual_lines[0], id: id(10), price: 1000 }], reused: true });
      } });
      try {
        await enable(h); await choose(h, 1); await input(amount(h, 1), '10.00');
        await submit(h); await until(() => h.container.textContent.includes('Controlled lost ACK before server restore'), 'Initial unknown attempt retained');
        assert.equal(h.writes.length, 1); assert.equal(h.savedCount, 0);
        supported = false;
        await submit(h); await until(() => h.container.textContent.includes('Zamówienia nie wysłano'), 'Older server refuses before retry POST');
        assert.equal(h.writes.length, 1, 'Retained manual_lines must not reach a parser without support');
        assert.equal(h.container.querySelector('fieldset').disabled, true, 'Capability loss does not discard or unlock unknown attempt');
        assert.equal(h.savedCount, 0);
        supported = true;
        await submit(h); await until(() => h.savedCount === 1, 'Support restored permits explicit exact retry');
        assert.equal(h.writes.length, 2);
        assert.equal(h.writes[1].serialized, h.writes[0].serialized); assert.equal(h.writes[1].key, h.writes[0].key);
        assert.equal(h.container.querySelector('fieldset').disabled, false);
      } finally { await h.close(); }
    });

    await t.test('restore change during held preflight prevents the later custom-lines write', async () => {
      let reads = 0, release;
      const h = await mount({ health: () => ++reads === 2 ? new Promise(resolve => { release = resolve; }) : { manual_order_lines_available: true } });
      try {
        await enable(h); await choose(h, 1);
        await act(async () => { h.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await until(() => release, 'Fresh preflight held'); await h.render(true);
        await act(async () => release({ manual_order_lines_available: true }));
        await until(() => h.container.textContent.includes('Kontekst tworzenia zamówienia zmienił się'), 'Old permission result rejected');
        assert.equal(h.writes.length, 0); assert.equal(h.savedCount, 0);
      } finally { await h.close(); }
    });
    for (const h of mounts) assert.deepEqual(h.unexpected, [], 'All component HTTP routes were explicitly controlled');
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    await vite.close(); globalThis.fetch = oldFetch;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    dom.window.close();
  }
});
