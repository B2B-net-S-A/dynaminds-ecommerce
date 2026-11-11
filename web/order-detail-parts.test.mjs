/** Actual order card pieces (stepper, payment pill, notes, buyer edit, add product, line quantity)
 * with a recording `action` port and a controlled product search; no app/server/PG. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
const id = (n) => n.toString(16).padStart(8, '0') + '-1000-4000-8000-000000000001';
const base = {
  id: id(1), version: '7', status: 'paid', currency: 'PLN', number: 'DE-1', payment_mode: 'prepaid', total: 16889, shipping_cost: 1699,
  customer_name: 'Monika Kozłowska', email: 'monika@example.test', source: 'woocommerce', created_at: '2026-11-05T12:26:00Z',
  address: { street: 'Wojska Polskiego 11', postal_code: '70-470', city: 'Szczecin', country: 'PL', phone: '600100200' },
  note: 'Pakować osobno młynek\nKlient prosi o telefon', payment: { amount_due: 0, net: 16889, received: 16889 },
  items: [{ id: id(2), product_id: id(3), sku: 'PS-AKC-001', name: 'Młynek', quantity: 1, price: 12900, line_total: 12900 }],
  events: [
    { id: id(10), kind: 'order.created', detail: {}, created_at: '2026-11-05T12:26:00Z' },
    { id: id(11), kind: 'order.item_added', detail: { sku: 'PS-MIO-003', quantity: 2 }, created_at: '2026-11-05T12:30:00Z' },
    { id: id(12), kind: 'order.customer_updated', detail: { fields: ['email', 'phone'] }, created_at: '2026-11-05T12:31:00Z' },
  ],
};
test('order card pieces: flow, payment state, notes, buyer edit, add product and quantity', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/' }), prior = new Map(), oldFetch = globalThis.fetch;
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const parts = await vite.ssrLoadModule(path.resolve('web/order-detail-parts.tsx'));
  const { createRoot } = await import('react-dom/client');
  api.setWorkspace(id(9));
  const roots = new Set();
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/products\?limit=50&search=/);
    return Response.json({ data: [{ id: id(4), sku: 'PS-MIO-003', name: 'Miód', active: true, kind: 'simple' }, { id: id(3), sku: 'PS-AKC-001', name: 'Młynek', active: true, kind: 'simple' }], meta: { cursor: null } });
  };
  async function mount(Component, props) {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    roots.add(root);
    await act(async () => root.render(React.createElement(Component, props)));
    return { el, async close() { await act(async () => root.unmount()); roots.delete(root); el.remove(); } };
  }
  const recorder = (result = true) => { const calls = []; const action = async (...args) => { calls.push(args); return result; }; return { calls, action }; };
  const type = async (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    await act(async () => el.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
  };
  const submit = (form) => act(async () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  const labelled = (h, text) => [...h.el.querySelectorAll('label')].find((l) => l.textContent.includes(text)).querySelector('input,textarea');
  try {
    await t.test('stepper: seven fulfilment steps, payment is not a step, ready_to_ship and dates', async () => {
      const path7 = ['paid', 'picking', 'packed', 'ready_to_ship', 'shipped', 'delivered', 'completed'];
      assert.deepEqual(parts.orderFlowSteps(), path7);
      const lis = (h) => [...h.el.querySelectorAll('li')];
      // Created directly as paid: Nowe is current with the order's creation date; payment events are not steps.
      const fresh = await mount(parts.OrderFlowStepper, { order: base });
      assert.equal(lis(fresh).length, 7);
      assert.equal(lis(fresh)[0].className, 'order-stage-paid now');
      assert.match(lis(fresh)[0].textContent, /Nowe/);
      assert.equal(lis(fresh)[0].querySelector('small').textContent, api.date(base.created_at),'created_at stands in for the missing order.paid event');
      await fresh.close();
      const h = await mount(parts.OrderFlowStepper, { order: { ...base, status: 'picking', events: [{ id: id(20), kind: 'order.picking', created_at: '2026-11-05T13:00:00Z' }] } });
      const steps = lis(h);
      assert.equal(steps.length, 7);
      assert.equal(steps[1].getAttribute('aria-current'), 'step');
      assert.equal(steps[0].className, 'order-stage-paid done');
      assert.equal(steps[1].className, 'order-stage-picking now');
      assert.equal(steps[2].className, 'order-stage-packed');
      assert.match(steps[1].textContent, /W kompletacji/);
      assert.equal(steps[1].querySelector('small').textContent, api.date('2026-11-05T13:00:00Z'));
      await h.close();
      // Derived stage: a packed order with a bought label is current at Gotowe do nadania, dated by its shipment.
      const ready = await mount(parts.OrderFlowStepper, { order: { ...base, status: 'packed', fulfilment_stage: 'ready_to_ship',
        shipments: [{ id: id(30), created_at: '2026-11-06T09:15:00Z' }],
        events: [{ id: id(23), kind: 'order.packed', created_at: '2026-11-06T08:00:00Z' }] } });
      const r = lis(ready);
      assert.equal(r[3].className, 'order-stage-ready_to_ship now');
      assert.match(r[3].textContent, /Gotowe do nadania/);
      assert.equal(r[3].querySelector('small').textContent, api.date('2026-11-06T09:15:00Z'));
      assert.equal(r[2].className, 'order-stage-packed done');
      assert.equal(r[2].querySelector('small').textContent, api.date('2026-11-06T08:00:00Z'));
      assert.equal(r[4].className, 'order-stage-shipped');
      await ready.close();
      // Waiting for payment: nothing is reached, no dates, even with order.paid in the history (sent back to new).
      const back = await mount(parts.OrderFlowStepper, { order: { ...base, status: 'new', events: [
        { id: id(21), kind: 'order.paid', detail: { from: 'new' }, created_at: '2026-11-05T13:00:00Z' },
        { id: id(22), kind: 'order.payment_reopened', detail: { from: 'paid', to: 'new' }, created_at: '2026-11-05T14:00:00Z' },
      ] } });
      const again = lis(back);
      assert.equal(again.length, 7);
      assert.equal(back.el.querySelector('[aria-current]'), null);
      assert.equal(again[0].className, 'order-stage-paid', 'Nowe is not marked done after the order went back to payment');
      assert(again.every((li) => li.querySelector('small').textContent.trim() === ''));
      await back.close();
      // A cancelled order shows how far it got from its history.
      const gone = await mount(parts.OrderFlowStepper, { order: { ...base, status: 'cancelled', events: [
        { id: id(24), kind: 'order.picking', created_at: '2026-11-05T13:00:00Z' },
        { id: id(25), kind: 'order.cancelled', created_at: '2026-11-05T15:00:00Z' },
      ] } });
      assert.deepEqual(lis(gone).map((li) => li.className.split(' ')[1] ?? ''), ['done', 'done', '', '', '', '', '']);
      await gone.close();
      // A replacement order is "ready to pick" rather than "Nowe".
      const swap = await mount(parts.OrderFlowStepper, { order: { ...base, fulfillment_kind: 'replacement' } });
      assert.match(lis(swap)[0].textContent, /Gotowe do kompletacji/);
      await swap.close();
    });
    await t.test('payment pill distinguishes paid, cash on delivery and unpaid with the amount due', async () => {
      assert.equal(parts.orderPaymentState(base).tone, 'ok');
      assert.equal(parts.orderPaymentState({ ...base, payment_mode: 'cod', payment: { amount_due: 16889 } }).tone, 'cod');
      const due = parts.orderPaymentState({ ...base, status: 'new', payment: { amount_due: 2290, net: 14599 } });
      assert.equal(due.tone, 'due');
      assert.match(due.label, /^Nieopłacone · do zapłaty 22,90/);
      assert.equal(parts.orderPaymentState({ ...base, fulfillment_kind: 'replacement' }).tone, 'none');
    });
    await t.test('notes: lines and history render; empty or too long notes are refused before any write', async () => {
      const r = recorder();
      const h = await mount(parts.OrderNotesPanel, { order: base, write: true, busy: false, action: r.action });
      assert.equal(h.el.querySelectorAll('.note').length, 2);
      assert.match(h.el.textContent, /Dodano produkt.*PS-MIO-003 · 2 szt\./);
      assert.match(h.el.textContent, /Zmieniono dane klienta.*e-mail, telefon/);
      const box = h.el.querySelector('textarea'), form = h.el.querySelector('form');
      await submit(form);
      assert.match(h.el.textContent, /Wpisz treść notatki/);
      await type(box, 'x'.repeat(501));
      await submit(form);
      assert.match(h.el.textContent, /najwyżej 500 znaków/);
      assert.equal(r.calls.length, 0);
      await type(box, '  Zadzwonić przed wysyłką  ');
      await submit(form);
      assert.deepEqual(r.calls, [['/orders/' + base.id + '/operations', { type: 'add_note', note: 'Zadzwonić przed wysyłką' }]]);
      assert.equal(box.value, '', 'a saved note clears the box');
      await h.close();
      const ro = await mount(parts.OrderNotesPanel, { order: base, write: false, busy: false, action: r.action });
      assert.equal(ro.el.querySelector('form'), null);
      assert.equal(ro.el.querySelectorAll('.note').length, 2);
      await ro.close();
    });
    await t.test('buyer edit validates in Polish, sends trimmed fields with the order version and closes on success', async () => {
      const r = recorder();
      let closed = 0;
      const h = await mount(parts.OrderCustomerModal, { order: base, busy: false, action: r.action, onClose: () => closed++ });
      const form = h.el.querySelector('form');
      await type(labelled(h, 'E-mail'), 'brak-maila');
      await type(labelled(h, 'Telefon'), 'abc');
      await type(labelled(h, 'Imię i nazwisko'), 'X');
      await submit(form);
      assert.match(h.el.textContent, /Nieprawidłowy adres e-mail/);
      assert.match(h.el.textContent, /Telefon może zawierać tylko cyfry/);
      assert.match(h.el.textContent, /co najmniej 2 znaki/);
      assert.equal(r.calls.length, 0);
      await type(labelled(h, 'E-mail'), ' monika.nowak@example.test ');
      await type(labelled(h, 'Telefon'), '+48 600 100 300');
      await type(labelled(h, 'Imię i nazwisko'), 'Monika Nowak');
      await type(labelled(h, 'Ulica'), 'Kolorowa 5');
      await submit(form);
      assert.deepEqual(r.calls, [['/orders/' + base.id + '/customer', { expected_version: '7', customer_name: 'Monika Nowak', email: 'monika.nowak@example.test',
        phone: '+48 600 100 300', street: 'Kolorowa 5', postal_code: '70-470', city: 'Szczecin' }, 'PATCH']]);
      assert.equal(closed, 1);
      await h.close();
      const failing = recorder(false);
      const f = await mount(parts.OrderCustomerModal, { order: base, busy: false, action: failing.action, onClose: () => closed++ });
      await submit(f.el.querySelector('form'));
      assert.equal(failing.calls.length, 1);
      assert.equal(closed, 1, 'a refused save keeps the form open');
      await f.close();
    });
    await t.test('add product requires a product not yet in the order and a positive whole quantity', async () => {
      const r = recorder();
      let closed = 0;
      const h = await mount(parts.OrderAddItemForm, { order: base, busy: false, action: r.action, onClose: () => closed++ });
      const form = h.el.querySelector('form');
      await submit(form);
      assert.match(h.el.textContent, /Wybierz produkt/);
      const select = h.el.querySelector('select');
      const choose = async (value) => { select.value = value; await act(async () => select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))); };
      await choose(id(3));
      await submit(form);
      assert.match(h.el.textContent, /Produkt jest już w zamówieniu/);
      await choose(id(4));
      await type(labelled(h, 'Ilość'), '0');
      await submit(form);
      assert.match(h.el.textContent, /większą od zera/);
      await type(labelled(h, 'Ilość'), '1.5');
      await submit(form);
      assert.match(h.el.textContent, /liczbą całkowitą/);
      assert.equal(r.calls.length, 0);
      await type(labelled(h, 'Ilość'), '2');
      await submit(form);
      assert.deepEqual(r.calls, [['/orders/' + base.id + '/items', { expected_version: '7', product_id: id(4), quantity: 2 }, 'POST']]);
      assert.equal(closed, 1);
      await h.close();
    });
    await t.test('line quantity saves only a changed positive whole number', async () => {
      const r = recorder();
      const item = base.items[0];
      const h = await mount(parts.OrderLineQuantity, { order: base, item, busy: false, action: r.action });
      const input = h.el.querySelector('input'), form = h.el.querySelector('form');
      assert.equal(h.el.querySelector('button').disabled, true, 'unchanged quantity has nothing to save');
      await type(input, '0');
      await submit(form);
      assert.match(h.el.textContent, /większą od zera/);
      await type(input, '3');
      await submit(form);
      assert.deepEqual(r.calls, [['/orders/' + base.id + '/items/' + item.id, { expected_version: '7', quantity: 3 }, 'PATCH']]);
      await h.close();
    });
    await t.test('history speaks Polish for automation, tag, payment and document events (Uwagi v3 §0)', () => {
      const text = (kind, detail = {}) => parts.orderEventText({ kind, detail, created_at: '2026-11-10T00:50:00Z' });
      assert.equal(text('automation.rule_applied', { message: 'Reguła Wysoka wartość: Dodano tag Wysoka wartość' }).title, 'Reguła Wysoka wartość: Dodano tag Wysoka wartość');
      assert.equal(text('automation.rule_applied').title, 'Wykonano regułę automatyczną');
      assert.equal(text('automation.manual_run').title, 'Uruchomiono akcję ręcznie');
      assert.deepEqual(text('order.tags_changed', { tag: 'VIP', operation: 'add_tag' }), { title: 'Dodano tag', detail: 'VIP' });
      assert.equal(text('order.tags_changed', { tag: 'VIP', operation: 'remove_tag' }).title, 'Usunięto tag');
      assert.deepEqual(text('payment.changed', { from: 'unpaid', to: 'paid' }), { title: 'Zmieniono status płatności', detail: 'Nieopłacone → Opłacone' });
      assert.deepEqual(text('document.issued', { number: 'FV/1/2026' }), { title: 'Wystawiono dokument', detail: 'FV/1/2026' });
      for (const kind of ['automation.manual_run', 'automation.rule_applied', 'order.tags_changed', 'payment.changed', 'shipment.created', 'document.issued'])
        assert.doesNotMatch(text(kind).title, /^[a-z_.]+$/, kind + ' must not show its raw code');
    });
    await t.test('history speaks Polish for the automation events of lane J', () => {
      const text = (kind, detail = {}) => parts.orderEventText({ kind, detail, created_at: '2026-11-10T00:50:00Z' });
      assert.deepEqual(text('order.item_missing', { sku: 'SKU-1', quantity_missing: 2, actor: { name: 'Kamil' } }),
        { title: 'Zgłoszono brak produktu przy kompletacji', detail: 'SKU-1 · brakuje 2 szt. · Kamil' });
      assert.deepEqual(text('stock.changed', { sku: 'SKU-1', before: 0, after: 10 }), { title: 'Zmienił się stan magazynowy produktu', detail: 'SKU-1 · stan 0 → 10 szt.' });
      assert.deepEqual(text('shipment.cancelled', { carrier: 'Symulator lokalny', tracking_number: 'DEMO-1', scope: 'local' }),
        { title: 'Anulowano etykietę — zamówienie wróciło do Spakowane', detail: 'Symulator lokalny · DEMO-1' });
      assert.deepEqual(text('shipment.status_changed', { from: 'confirmed', to: 'out_for_delivery', status: 'in_transit' }),
        { title: 'Zmiana statusu przesyłki u przewoźnika', detail: 'W drodze' });
      assert.equal(text('shipment.status_changed', { to: 'weird_code', status: null }).detail, 'weird_code');
      assert.deepEqual(text('customer_message.received', { channel: 'email', excerpt: 'Gdzie paczka?' }),
        { title: 'Wiadomość od klienta (e-mail)', detail: 'Gdzie paczka?' });
      assert.equal(text('customer_message.received', { channel: 'allegro' }).title, 'Wiadomość od klienta (Allegro)');
    });
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    await vite.close();
    globalThis.fetch = oldFetch;
    for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    dom.window.close();
  }
});
