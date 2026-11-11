/** Order card logic (Uwagi v3 §4, §6): stage/payment fallbacks, section values, drafts, changes,
 * locks, one-section editing, scan progress, neighbours, history filter and the section HTTP port. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';

const id = (n) => n.toString(16).padStart(8, '0') + '-1000-4000-8000-000000000001';
const base = {
  id: id(1), version: '7', status: 'paid', currency: 'PLN', number: 'DE-1', payment_mode: 'prepaid', total: 16889, shipping_cost: 1699,
  customer_name: 'Monika Kozłowska', email: 'monika@example.test', source: 'woocommerce', created_at: '2026-11-05T12:26:00Z', note: 'Pakować osobno',
  address: { street: 'Wojska Polskiego 11', postal_code: '70-470', city: 'Szczecin', country: 'PL', phone: '' },
  payment: { amount_due: 0, net: 16889, received: 16889 }, shipments: [], documents: [], events: [],
  items: [{ id: id(2), product_id: id(3), sku: 'PS-1', name: 'Młynek', quantity: 2, price: 100, line_total: 200 },
    { id: id(4), product_id: id(5), sku: 'SET-1', name: 'Zestaw', quantity: 1, price: 100, line_total: 100 }],
  picking_items: [{ id: id(6), product_id: id(3), sku: 'PS-1', quantity: 2, scanned: 1, locations: [{ location: 'A-01' }, { location: 'B-02' }] },
    { id: id(7), product_id: id(8), sku: 'KOMP', quantity: 2, scanned: 2, locations: [] }],
};

const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
const m = await vite.ssrLoadModule(path.resolve('web/order-card-model.ts'));
const sectionApi = await vite.ssrLoadModule(path.resolve('web/order-section-api.ts'));
const { ApiError } = await vite.ssrLoadModule(path.resolve('web/api.ts'));
test.after(() => vite.close());

test('stage: lane B field wins; packed with an undispatched label reads ready_to_ship; unknown field is ignored', () => {
  assert.equal(m.cardStage({ ...base, fulfilment_stage: 'picking' }), 'picking');
  assert.equal(m.cardStage({ ...base, fulfilment_stage: 'bogus' }), 'paid');
  assert.equal(m.cardStage({ ...base, status: 'packed' }), 'packed');
  assert.equal(m.cardStage({ ...base, status: 'packed', shipping_active: true }), 'ready_to_ship');
  assert.equal(m.cardStage({ ...base, status: 'packed', shipments: [{ dispatched_at: null }] }), 'ready_to_ship');
  assert.equal(m.cardStage({ ...base, status: 'shipped', shipments: [{ dispatched_at: null }] }), 'shipped');
});

test('payment state mirrors the server rule; replacement has none; lane B field wins', () => {
  assert.equal(m.cardPaymentState(base), 'paid');
  assert.equal(m.cardPaymentState({ ...base, payment: { net: 0 } }), 'unpaid');
  assert.equal(m.cardPaymentState({ ...base, payment: { net: 100 } }), 'partial');
  assert.equal(m.cardPaymentState({ ...base, payment: { net: 0 }, payment_mode: 'cod' }), 'cod');
  assert.equal(m.cardPaymentState({ ...base, payment: { net: 20000 } }), 'overpaid');
  assert.equal(m.cardPaymentState({ ...base, payment: { net: 0 }, status: 'cancelled' }), 'paid');
  assert.equal(m.cardPaymentState({ ...base, payment_state: 'partial' }), 'partial');
  assert.equal(m.cardPaymentState({ ...base, fulfillment_kind: 'replacement' }), null);
});

test('section values come from section_values when present, else from the order', () => {
  assert.deepEqual(m.sectionValuesOf(base, 'customer'), { name: 'Monika Kozłowska', company: '', email: 'monika@example.test', phone: '' });
  assert.equal(m.sectionValuesOf(base, 'delivery_address').recipient, 'Monika Kozłowska');
  assert.equal(m.sectionValuesOf(base, 'delivery_method').cost, 1699);
  assert.deepEqual(m.sectionValuesOf(base, 'payment'), { state: 'paid', amount: 16889, paid_at: '', reference: '', method: 'transfer' });
  assert.equal(m.sectionValuesOf(base, 'extra').note, 'Pakować osobno');
  const given = { name: 'X', company: 'ACME', email: 'x@y.pl', phone: '1' };
  assert.deepEqual(m.sectionValuesOf({ ...base, section_values: { customer: given } }, 'customer'), given);
});

test('drafts round-trip money as grosze and reject bad input with Polish messages', () => {
  const draft = m.toDraft('delivery_method', m.sectionValuesOf(base, 'delivery_method'));
  assert.equal(draft.cost, '16,99');
  assert.deepEqual(m.fromDraft('delivery_method', { ...draft, cost: '20,5' }).values.cost, 2050);
  assert.match(m.fromDraft('delivery_method', { ...draft, cost: 'abc' }).errors.join(), /Koszt dostawy: podaj kwotę/);
  const c = m.toDraft('customer', m.sectionValuesOf(base, 'customer'));
  assert.deepEqual(m.fromDraft('customer', c, base).errors, []);
  assert.match(m.fromDraft('customer', { ...c, email: 'zly' }, base).errors.join(), /Nieprawidłowy adres e-mail/);
  assert.match(m.fromDraft('customer', { ...c, email: '' }, base).errors.join(), /Podaj adres e-mail/);
  assert.deepEqual(m.fromDraft('customer', { ...c, email: '' }, { ...base, source: 'amazon' }).errors, []);
  assert.match(m.fromDraft('customer', { ...c, phone: 'abc' }, base).errors.join(), /Telefon/);
  const inv = { ...m.toDraft('invoice', m.sectionValuesOf(base, 'invoice')), wants_invoice: true, nip: '123' };
  assert.match(m.fromDraft('invoice', inv).errors.join(), /NIP: 10 cyfr/);
  assert.deepEqual(m.fromDraft('invoice', { ...inv, nip: '526-104-08-28' }).errors, []);
  const pay = m.toDraft('payment', m.sectionValuesOf(base, 'payment'));
  assert.match(m.fromDraft('payment', { ...pay, state: 'partial', amount: '0' }).errors.join(), /częściowej płatności/);
  assert.equal(m.fromDraft('delivery_address', { ...m.toDraft('delivery_address', m.sectionValuesOf(base, 'delivery_address')), country: 'de' }).values.country, 'DE');
});

test('changes list only this section\'s changed fields as "było → jest"', () => {
  const before = m.sectionValuesOf(base, 'payment');
  const after = { ...before, state: 'partial', amount: 5000 };
  const changes = m.sectionChanges('payment', before, after, 'PLN');
  assert.deepEqual(changes.map((c) => c.field), ['state', 'amount']);
  assert.equal(changes[0].before, 'Opłacone');
  assert.equal(changes[0].after, 'Częściowo');
  assert.match(changes[1].after, /50,00/);
  assert.deepEqual(m.sectionChanges('customer', m.sectionValuesOf(base, 'customer'), { ...m.sectionValuesOf(base, 'customer'), name: ' Monika Kozłowska ' }), []);
  assert.equal(m.sectionChanges('customer', { phone: '' }, { phone: '600' })[0]?.before, '—');
});

test('one section at a time: a clean section switches, a dirty one asks first, products are never dirty', () => {
  assert.equal(m.requestEdit(null, 'customer'), 'open');
  const edit = m.startEdit(base, 'customer');
  assert.equal(m.isDirty(edit), false);
  assert.equal(m.requestEdit(edit, 'customer'), 'same');
  assert.equal(m.requestEdit(edit, 'payment'), 'open');
  const dirty = { ...edit, draft: { ...edit.draft, phone: '600100200' } };
  assert.equal(m.isDirty(dirty), true);
  assert.equal(m.requestEdit(dirty, 'payment'), 'ask');
  assert.equal(m.requestEdit(dirty, 'products'), 'ask');
  assert.equal(m.requestEdit(m.startEdit(base, 'products'), 'customer'), 'open');
});

test('locks: server locks win; fallback keeps the card rules and the correction path for an issued invoice', () => {
  const free = m.sectionLocks(base);
  assert.equal(free.customer.locked, false);
  assert.equal(free.products.locked, false);
  assert.equal(free.invoice.locked, false);
  const labelled = m.sectionLocks({ ...base, status: 'packed', shipping_active: true });
  assert.deepEqual(labelled.delivery_address, { locked: true, reason: 'Najpierw anuluj etykietę u przewoźnika', action: 'cancel_label' });
  assert.equal(labelled.products.locked, true);
  assert.equal(m.sectionLocks({ ...base, status: 'picking' }).products.locked, true);
  assert.equal(m.sectionLocks({ ...base, status: 'shipped' }).customer.locked, true);
  assert.deepEqual(m.sectionLocks({ ...base, documents: [{ id: id(9), kind: 'invoice' }] }).invoice, { locked: true, reason: 'Zmiana tylko przez korektę', action: 'correction' });
  assert.equal(m.sectionLocks({ ...base, fulfillment_kind: 'replacement' }).payment.locked, true);
  const server = m.sectionLocks({ ...base, section_locks: { payment: { locked: true, reason: 'Rozliczone' }, customer: 'zly' } });
  assert.equal(server.payment.reason, 'Rozliczone');
  assert.equal(server.customer.locked, false, 'malformed server entry falls back');
});

test('scan progress, per-line scan and locations; Polish plural; list neighbours', () => {
  assert.deepEqual(m.scanProgress(base), { scanned: 3, total: 4, percent: 75 });
  assert.deepEqual(m.scanProgress({ picking_items: [] }), { scanned: 0, total: 0, percent: 0 });
  assert.deepEqual(m.lineScan(base, base.items[0]), { scanned: 1, quantity: 2, locations: ['A-01', 'B-02'] });
  assert.equal(m.lineScan(base, base.items[1]), null);
  assert.deepEqual([1, 2, 5, 12, 22, 25].map(m.positionsLabel), ['1 POZYCJA', '2 POZYCJE', '5 POZYCJI', '12 POZYCJI', '22 POZYCJE', '25 POZYCJI']);
  assert.deepEqual(m.neighbours(['a', 'b', 'c'], 'b'), { prev: 'a', next: 'c' });
  assert.deepEqual(m.neighbours(['a', 'b'], 'a'), { prev: undefined, next: 'b' });
  assert.deepEqual(m.neighbours(undefined, 'a'), {});
  assert.deepEqual(m.neighbours(['x'], 'a'), {});
});

test('history: newest first, section filter keeps only that section\'s edits; marketplace note', () => {
  const events = [
    { id: '1', kind: 'order.created' },
    { id: '2', kind: 'order.section_edited', detail: { section: 'payment' } },
    { id: '3', kind: 'order.section_edited', detail: { section: 'customer' } },
  ];
  assert.deepEqual(m.historyEvents(events, 'all').map((e) => e.id), ['3', '2', '1']);
  assert.deepEqual(m.historyEvents(events, 'payment').map((e) => e.id), ['2']);
  assert.deepEqual(m.editedSections(events), ['payment', 'customer']);
  assert.match(m.channelNote(base), /tylko w tym systemie.*WooCommerce/);
  assert.equal(m.channelNote({ ...base, source: 'manual' }), null);
});

test('section port: PATCH with numeric version; 423 carries the lock; 409 is a re-read message; legacy fallback', async () => {
  const calls = [];
  const ok = async (...args) => { calls.push(args); return {}; };
  const o = { ...base, section_values: {} };
  await sectionApi.saveOrderSection(o, 'payment', { state: 'paid' }, ok);
  assert.deepEqual(calls[0].slice(0, 3), [`/orders/${id(1)}/sections/payment`, 'PATCH', { expected_version: 7, values: { state: 'paid' } }]);
  const locked = async (p, mth, b, onResponse) => { onResponse({ detail: 'Zablokowane', lock: { locked: true, reason: 'Wystawiono fakturę', action: 'correction' } }, 423); throw new ApiError('Zablokowane', 423); };
  await assert.rejects(sectionApi.saveOrderSection(o, 'invoice', {}, locked), (e) => e.status === 423 && e.lock.action === 'correction' && e.message === 'Wystawiono fakturę');
  const stale = async () => { throw new ApiError('Konflikt', 409); };
  await assert.rejects(sectionApi.saveOrderSection(o, 'payment', {}, stale), /Odczytaj je ponownie/);
  await assert.rejects(sectionApi.saveOrderSection(o, 'products', {}, ok), /pozycja po pozycji/);
  const lost = async () => { throw new ApiError('Bad gateway', 502); };
  await assert.rejects(sectionApi.saveOrderSection(o, 'payment', {}, lost), (e) => e instanceof ApiError && !(e instanceof sectionApi.SectionSaveError) && e.status === 502, 'unknown outcome reaches the card reconciliation');
  await assert.rejects(sectionApi.saveOrderSection(base, 'customer', m.sectionValuesOf(base, 'customer'), lost), (e) => !(e instanceof sectionApi.SectionSaveError));
  calls.length = 0;
  await sectionApi.saveOrderSection(base, 'customer', { ...m.sectionValuesOf(base, 'customer'), phone: '600100200' }, ok);
  assert.deepEqual(calls[0].slice(0, 3), [`/orders/${id(1)}/customer`, 'PATCH',
    { expected_version: '7', customer_name: 'Monika Kozłowska', email: 'monika@example.test', phone: '600100200', street: 'Wojska Polskiego 11', postal_code: '70-470', city: 'Szczecin' }]);
  await assert.rejects(sectionApi.saveOrderSection(base, 'customer', { ...m.sectionValuesOf(base, 'customer'), company: 'ACME' }, ok), (e) => e.status === 501 && /Firma/.test(e.message));
  await assert.rejects(sectionApi.saveOrderSection(base, 'payment', {}, ok), (e) => e.status === 501);
});
