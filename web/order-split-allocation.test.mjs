import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, {act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

const id = n => `${String(n).padStart(8, '0')}-1000-4000-8000-000000000001`;
const basis = () => ({order_id: id(1), version: '9223372036854775807', currency: 'PLN', shipping_cost: 501,
  items: [{id: id(2), name: 'Towar A', sku: 'SKU-A', quantity: 3, price: 1701, line_total: 3401},
    {id: id(3), name: 'Towar B', sku: 'SKU-B', quantity: 1, price: 123, line_total: 123}]});

test('split allocation editor: genuine React intent, bounded source view and no transport', async t => {
  const dom = new JSDOM('<body/>', {url: 'http://127.0.0.1/'}), prior = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true})) {
    prior.set(k, Object.getOwnPropertyDescriptor(globalThis, k)); Object.defineProperty(globalThis, k, {configurable: true, writable: true, value: v});
  }
  let network = 0;
  globalThis.fetch = async () => {network++; throw Error('The editor must not use transport');};
  const vite = await createServer({server: {middlewareMode: true, hmr: false, ws: false, watch: null}, appType: 'custom', logLevel: 'error'});
  const roots = new Set();
  try {
    const {OrderSplitAllocationEditor: Editor} = await vite.ssrLoadModule(path.resolve('web/order-split-allocation.tsx'));
    const {orderSplitPreviewInput} = await vite.ssrLoadModule(path.resolve('server/order-splits-schema.ts'));
    const {createRoot} = await import('react-dom/client');
    async function mount(overrides = {}) {
      const el = document.createElement('div'); document.body.append(el); const root = createRoot(el); roots.add(root);
      const requests = []; let props = {source: basis(), readOnly: false, busy: false, contextKey: 'tenant:actor', onPreview: r => {requests.push(r);}, ...overrides};
      async function render(p = {}) {props = {...props, ...p}; await act(async () => root.render(React.createElement(Editor, props)));}
      await render(); return {el, requests, render, async close() {await act(async () => root.unmount()); roots.delete(root); el.remove();}};
    }
    const byLabel = (h, label) => [...h.el.querySelectorAll('[aria-label]')].find(x => x.getAttribute('aria-label') === label);
    const button = (h, label) => [...h.el.querySelectorAll('button')].find(x => x.textContent === label || x.getAttribute('aria-label') === label);
    const preview = h => button(h, 'Przygotuj podgląd podziału');
    async function click(h, label) {const b = button(h, label); assert(b, label); assert(!b.matches(':disabled'), 'disabled: ' + label); await act(async () => b.click());}
    async function input(h, label, value) {
      const el = byLabel(h, label); assert(el && !el.matches(':disabled'), label);
      await act(async () => {Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', {bubbles: true}));});
    }
    async function select(h, label, value) {const el = byLabel(h, label); await act(async () => {el.value = value; el.dispatchEvent(new Event('change', {bubbles: true}));});}
    const remaining = (h, item = id(2)) => h.el.querySelector(`[data-remaining-line="${item}"]`).textContent;
    const allocate = h => click(h, 'Dodaj pozycję 1 do wybranego wyniku');

    await t.test('mount is inert and historical source amounts remain visibly unchanged', async () => {
      const h = await mount(); assert(preview(h).disabled); assert.equal(h.requests.length, 0); assert.equal(network, 0);
      assert.match(h.el.textContent, /17,01/); assert.match(h.el.textContent, /34,01/); assert.equal(remaining(h), '3');
      assert.match(h.el.textContent, /Kwoty wyników i VAT zobaczysz w podglądzie/); await h.close();
    });
    await t.test('exact typed request preserves version, source line identity and explicit decimal delivery', async () => {
      const h = await mount(); await allocate(h); await input(h, 'Dostawa wyniku 1', '1,23');
      assert.equal(remaining(h), '2'); assert.match(byLabel(h, 'Bilans kosztu dostawy').textContent, /5,01.*1,23.*3,78/);
      await click(h, 'Przygotuj podgląd podziału'); assert.equal(h.requests.length, 1);
      const r = h.requests[0]; assert.deepEqual(orderSplitPreviewInput.parse(r), r);
      assert.deepEqual(Object.keys(r).sort(), ['children', 'client_key', 'expected_source_version', 'source_order_id']);
      assert.equal(r.source_order_id, id(1)); assert.equal(r.expected_source_version, '9223372036854775807');
      assert.deepEqual(r.children[0].items, [{source_item_id: id(2), quantity: 1}]); assert.equal(r.children[0].delivery_minor, 123);
      assert.match(r.client_key, /^[a-f0-9-]{36}$/); assert.notEqual(r.client_key, r.children[0].slot_id); await h.close();
    });
    await t.test('same-turn item clicks remain unique and result creation cannot exceed the shared result budget', async () => {
      const h = await mount(), addItem = button(h, 'Dodaj pozycję 1 do wybranego wyniku');
      await act(async () => {addItem.click(); addItem.click();});
      assert.equal(h.el.querySelectorAll('[aria-label="Ilość: Towar A, wynik 1"]').length, 1);
      await click(h, 'Przygotuj podgląd podziału'); assert.equal(h.requests[0].children[0].items.length, 1);
      const addChild = button(h, 'Dodaj wynikowe zamówienie'); await act(async () => {for (let n = 0; n < 110; n++) addChild.click();});
      assert.equal(h.el.querySelectorAll('section[aria-label^="Wynik podziału "]').length, 99); assert(addChild.disabled); assert(preview(h).disabled);
      assert.equal(h.requests.length, 1); await h.close();
    });
    await t.test('multiple children keep identity through edits; only a changed dispatched intent rotates command key', async () => {
      const h = await mount(); await allocate(h); await click(h, 'Dodaj wynikowe zamówienie'); await allocate(h);
      await input(h, 'Dostawa wyniku 2', '2.00'); await click(h, 'Przygotuj podgląd podziału');
      const first = structuredClone(h.requests[0]); assert.equal(first.children.length, 2); assert.equal(remaining(h), '1');
      await h.render({source: structuredClone(basis())}); await click(h, 'Przygotuj podgląd podziału'); assert.deepEqual(h.requests[1], first);
      await input(h, 'Nazwa wyniku 1', 'Sklep północ'); await input(h, 'Dostawa wyniku 1', '1');
      await click(h, 'Przygotuj podgląd podziału'); const changed = h.requests[2]; assert.notEqual(changed.client_key, first.client_key);
      assert.deepEqual(changed.children.map(x => x.slot_id), first.children.map(x => x.slot_id));
      await click(h, 'Przygotuj podgląd podziału'); assert.deepEqual(h.requests[3], changed); await h.close();
    });
    await t.test('quantity, retained source, names and shipping violations never dispatch', async () => {
      const h = await mount(); await allocate(h);
      for (const raw of ['0', '-1', '1.5', '1e1', '100001', '4']) {
        await input(h, 'Ilość: Towar A, wynik 1', raw); assert(preview(h).disabled, raw); assert.equal(h.requests.length, 0);
      }
      await input(h, 'Ilość: Towar A, wynik 1', '3'); await click(h, 'Dodaj pozycję 2 do wybranego wyniku');
      assert(preview(h).disabled); assert.match(h.el.textContent, /musi pozostać co najmniej jedna sztuka/);
      await click(h, 'Usuń pozycję Towar B z wyniku 1'); await input(h, 'Ilość: Towar A, wynik 1', '1');
      for (const raw of ['5.02', '-1', '0.001', '1e1', '']) {await input(h, 'Dostawa wyniku 1', raw); assert(preview(h).disabled, raw);}
      await input(h, 'Dostawa wyniku 1', '5.01'); assert(!preview(h).disabled);
      for (const raw of ['   ', 'A\u0001B']) {await input(h, 'Nazwa wyniku 1', raw); assert(preview(h).disabled);}
      assert.equal(h.requests.length, 0); await h.close();
    });
    await t.test('slot/line removal restores exact remaining budgets without changing surviving slot identity', async () => {
      const h = await mount(); await allocate(h); await click(h, 'Przygotuj podgląd podziału'); const slot = h.requests[0].children[0].slot_id;
      await click(h, 'Dodaj wynikowe zamówienie'); await allocate(h); await input(h, 'Dostawa wyniku 2', '3');
      await click(h, 'Usuń wynikowe zamówienie 2'); assert.equal(remaining(h), '2'); assert.match(byLabel(h, 'Bilans kosztu dostawy').textContent, /Przydzielono: 0,00/);
      await click(h, 'Przygotuj podgląd podziału'); assert.equal(h.requests[1].children[0].slot_id, slot);
      await click(h, 'Usuń pozycję Towar A z wyniku 1'); assert.equal(remaining(h), '3'); assert(preview(h).disabled); await h.close();
    });
    await t.test('two different same-turn removals retain one usable result', async () => {
      const h = await mount(); await click(h, 'Dodaj wynikowe zamówienie');
      const first = button(h, 'Usuń wynikowe zamówienie 1'), second = button(h, 'Usuń wynikowe zamówienie 2');
      await act(async () => {first.click(); second.click();});
      assert.equal(h.el.querySelectorAll('section[aria-label^="Wynik podziału "]').length, 1);
      await allocate(h); await click(h, 'Przygotuj podgląd podziału');
      assert.equal(h.requests[0].children.length, 1); assert.equal(h.requests[0].children[0].items[0].quantity, 1); await h.close();
    });
    await t.test('different source lines are not rejected by a guessed aggregate per-product limit', async () => {
      const source = basis(); source.items = Array.from({length: 101}, (_, n) => ({id: id(n + 100), name: 'Produkt ' + n, sku: 'SKU-' + n, quantity: 100000, price: 1, line_total: 100000}));
      const h = await mount({source}); assert.doesNotMatch(h.el.textContent, /Brak kompletnych danych/);
      await allocate(h); await click(h, 'Przygotuj podgląd podziału');
      assert.equal(h.requests[0].children[0].items[0].source_item_id, id(100)); assert.equal(remaining(h, id(100)), '99999'); await h.close();
    });
    await t.test('local promise latch rejects same-turn double click and edits, with no automatic retry on rejection', async () => {
      let reject, calls = 0; const pending = new Promise((_, r) => {reject = r;});
      const h = await mount({onPreview() {calls++; return pending;}}); await allocate(h); const b = preview(h);
      await act(async () => {b.click(); b.click();}); assert.equal(calls, 1); assert(byLabel(h, 'Nazwa wyniku 1').matches(':disabled'));
      await h.render({busy: true}); await act(async () => reject(Error('secret diagnostic not for this child')));
      assert.equal(calls, 1); assert.match(h.el.textContent, /Nie potwierdzono podglądu/); assert.doesNotMatch(h.el.textContent, /secret diagnostic/);
      assert(preview(h).disabled); await h.close();
    });
    await t.test('parent read-only and custody busy remain authoritative before and after dispatch', async () => {
      const h = await mount(); await allocate(h);
      for (const p of [{readOnly: true}, {readOnly: false, busy: true}]) {await h.render(p); assert(preview(h).disabled); assert(byLabel(h, 'Dostawa wyniku 1').matches(':disabled')); preview(h).click(); assert.equal(h.requests.length, 0);}
      await h.render({busy: false}); await click(h, 'Przygotuj podgląd podziału'); assert.equal(h.requests.length, 1); await h.close();
    });
    await t.test('a source version or actor context change discards local draft without reconciling or dispatching', async () => {
      const h = await mount(); await allocate(h); await click(h, 'Przygotuj podgląd podziału'); const first = h.requests[0];
      const next = basis(); next.version = '2'; await h.render({source: next}); assert(preview(h).disabled); assert.equal(remaining(h), '3');
      await allocate(h); await click(h, 'Przygotuj podgląd podziału'); assert.equal(h.requests[1].expected_source_version, '2'); assert.notEqual(h.requests[1].client_key, first.client_key);
      await h.render({contextKey: 'other-tenant:other-actor'}); assert(preview(h).disabled); assert.equal(remaining(h), '3'); assert.equal(h.requests.length, 2); await h.close();
    });
    await t.test('paginated/searchable source rows retain original IDs, including equal SKU/name rows', async () => {
      const source = basis(); source.items = Array.from({length: 60}, (_, n) => ({...source.items[0], id: id(n + 100), sku: 'SKU-' + n, name: n < 2 ? 'Ta sama nazwa' : 'Towar ' + n}));
      const h = await mount({source}); assert.equal(h.el.querySelectorAll('tbody tr').length, 25);
      await click(h, 'Następne pozycje'); assert.match(h.el.textContent, /Pozycje 26–50 z 60/);
      await input(h, 'Szukaj pozycji źródłowej', 'SKU-59'); assert.equal(h.el.querySelectorAll('tbody tr').length, 1);
      await click(h, 'Dodaj pozycję 60 do wybranego wyniku'); await input(h, 'Szukaj pozycji źródłowej', 'Ta sama nazwa');
      await click(h, 'Dodaj pozycję 1 do wybranego wyniku'); await click(h, 'Dodaj pozycję 2 do wybranego wyniku');
      await click(h, 'Przygotuj podgląd podziału'); assert.deepEqual(h.requests[0].children[0].items.map(x => x.source_item_id), [id(159), id(100), id(101)]); await h.close();
    });
    await t.test('malformed source frames fail closed, including null item, duplicate UUID and unsafe version', async () => {
      const cases = [null, {...basis(), items: [null]}, {...basis(), items: [{...basis().items[0], id: null}]},
        {...basis(), items: [basis().items[0], {...basis().items[0], id: id(2).toUpperCase()}]}, {...basis(), version: '9223372036854775808'},
        {...basis(), shipping_cost: -1}, {...basis(), currency: 'INVALID'}, {...basis(), items: [{...basis().items[0], quantity: 1.5}]}];
      for (const source of cases) {const h = await mount({source}); assert.match(h.el.textContent, /Brak kompletnych danych/); assert.equal(h.el.querySelectorAll('button').length, 0); assert.equal(h.requests.length, 0); await h.close();}
      const oversized = basis(); oversized.items = Array.from({length: 1100}, (_, i) => ({...basis().items[0], id: id(i + 100), name: 'ą'.repeat(4096)}));
      const h = await mount({source: oversized}); assert.match(h.el.textContent, /Brak kompletnych danych/); assert.equal(h.el.querySelectorAll('button').length, 0); await h.close();
    });
    await t.test('remount retains parent busy and never interprets unresolved command as recovered', async () => {
      const h = await mount({busy: true}); assert(preview(h).disabled); await h.close(); const next = await mount({busy: true});
      assert(preview(next).disabled); assert.equal(next.requests.length, 0); assert.match(next.el.textContent, /wynik wymaga sprawdzenia/); await next.close();
    });
    assert.equal(network, 0, 'mount, edits and callback dispatch never use fetch');
  } finally {
    await act(async () => {for (const root of roots) root.unmount();}); await vite.close(); globalThis.fetch = oldFetch;
    for (const [k, value] of prior) {if (value) Object.defineProperty(globalThis, k, value); else delete globalThis[k];} dom.window.close();
  }
});
