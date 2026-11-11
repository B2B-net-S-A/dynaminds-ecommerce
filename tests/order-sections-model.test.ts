/** Uwagi v3 §6 without a database: section validation, NIP and postal codes, the history diff, the
 * order-state and role locks, and the RODO replacement of history values. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validPolishNip, validPostalCode, sectionBody, sectionChanges, checkMerged } from '../server/order-sections-model';
import { stateLocks, sectionLocksForActor } from '../server/order-sections';
import { anonymiseHistoryDetail, ANON_TEXT } from '../server/rodo228-model';

const facts = (tags: string[] = [], lineReasons: string[] = [], buyerChanged = false) => ({ tags: new Set(tags), lineReasons, buyerChanged });
const sale = (status: string, extra: Record<string, unknown> = {}) => ({ status, source: 'manual', fulfillment_kind: 'sale', ...extra });

test('NIP checksum and postal codes per country', () => {
  assert(validPolishNip('5260001246'));
  assert(!validPolishNip('5260001247'));
  assert(!validPolishNip('123456789'));
  assert(validPostalCode('70-470', 'PL') && !validPostalCode('70470', 'PL'));
  assert(validPostalCode('10115', 'DE') && validPostalCode('110 00', 'CZ') && validPostalCode('', 'PL'));
  assert(!validPostalCode('<script>', 'XX'));
});

test('a section body is partial, strict and takes the version as a number or a string', () => {
  assert.deepEqual(sectionBody('customer').parse({ expected_version: 7, values: { name: ' Anna ' } }), { expected_version: '7', values: { name: 'Anna' } });
  assert.equal(sectionBody('extra').parse({ expected_version: '8', values: {} }).expected_version, '8');
  assert.throws(() => sectionBody('customer').parse({ expected_version: 1, values: { role: 'admin' } }));
  assert.throws(() => sectionBody('delivery_method').parse({ expected_version: 1, values: { cost: -5 } }));
  assert.throws(() => sectionBody('payment').parse({ expected_version: 1, values: { state: 'overpaid' } }));
  assert.throws(() => checkMerged('invoice', { wants_invoice: false, buyer: '', nip: '12', street: '', postal_code: '', city: '', country: 'PL' }, { source: 'manual' }));
  assert.doesNotThrow(() => checkMerged('customer', { name: 'Jan', company: '', email: '', phone: '' }, { source: 'amazon' }));
});

test('the history diff lists changed fields with Polish labels and display values', () => {
  const before = { method: 'courier', carrier: '', cost: 1699 }, after = { method: 'parcel_locker', carrier: '', cost: 1299 };
  assert.deepEqual(sectionChanges('delivery_method', before, after, 'PLN'), [
    { field: 'method', label: 'Sposób dostawy', before: 'Kurier', after: 'Paczkomat / automat paczkowy' },
    { field: 'cost', label: 'Koszt dostawy', before: '16,99 PLN', after: '12,99 PLN' },
  ]);
  assert.deepEqual(sectionChanges('extra', { note: 'a' }, { note: 'a' }, 'PLN'), []);
});

test('locks: labels, shipping, invoices, cancellation, replacement orders, buyer portal and roles', () => {
  const open = stateLocks(sale('paid'), facts());
  assert(Object.values(open.section_locks).every((l) => !l.locked));
  const label = stateLocks(sale('packed'), facts(['label']));
  assert.equal(label.section_locks.delivery_address.action, 'cancel_label');
  assert.equal(label.section_locks.customer.locked, false, 'contact data editable at every stage');
  const shipped = stateLocks(sale('delivered'), facts(['label']));
  assert.match(shipped.section_locks.delivery_method.reason!, /nadana/);
  assert.equal(shipped.section_locks.customer.locked, false);
  const invoiced = stateLocks(sale('shipped'), facts(['invoice', 'label']));
  assert.equal(invoiced.section_locks.invoice.action, 'correction');
  assert.equal(invoiced.section_locks.products.action, 'correction');
  assert.equal(invoiced.payment_edit.method.action, 'correction');
  assert.equal(invoiced.payment_edit.state.locked, false);
  assert.equal(stateLocks(sale('picking'), facts()).section_locks.products.locked, true);
  assert.match(stateLocks(sale('new'), facts([], ['zwroty lub reklamacje'])).section_locks.products.reason!, /zwroty/);
  assert.match(stateLocks(sale('paid'), facts([], [], true)).section_locks.delivery_address.reason!, /portalu/);
  assert.equal(stateLocks(sale('paid'), facts(['parcel'])).section_locks.customer.action, 'cancel_label');
  const cancelled = stateLocks(sale('cancelled'), facts());
  assert.equal(cancelled.section_locks.payment.locked, true);
  assert.equal(cancelled.section_locks.extra.locked, false);
  const replacement = stateLocks(sale('paid', { fulfillment_kind: 'replacement' }), facts());
  assert(Object.values(replacement.section_locks).every((l) => l.locked));
  const viewer = sectionLocksForActor({ ...open }, { role: 'viewer' });
  assert(Object.values(viewer.section_locks).every((l) => l.locked));
  const key = sectionLocksForActor({ ...open }, { role: 'admin' }, ['orders:read']);
  assert(Object.values(key.section_locks).every((l) => l.locked));
  const op = sectionLocksForActor({ ...invoiced }, { role: 'operator' });
  assert.equal(op.payment_edit.state.locked, true);
  assert.equal(op.section_locks.payment.locked, true, 'neither part is editable for an operator after the invoice');
  assert.equal(sectionLocksForActor({ ...open }, { role: 'admin' }).payment_edit.state.locked, false);
});

test('RODO replaces personal history values and keeps the rest', () => {
  const d = { section: 'invoice', changes: [{ field: 'nip', label: 'NIP', before: '', after: '5260001246' }, { field: 'wants_invoice', label: 'Faktura', before: 'nie', after: 'tak' }],
    values: { nip: '5260001246', buyer: 'Jan', wants_invoice: true, country: 'PL' } };
  const r = anonymiseHistoryDetail('order.section_edited', d);
  assert(r.changed);
  assert.deepEqual((r.value as any).changes[0], { field: 'nip', label: 'NIP', before: '', after: ANON_TEXT });
  assert.equal((r.value as any).changes[1].after, 'tak');
  assert.deepEqual((r.value as any).values, { nip: ANON_TEXT, buyer: ANON_TEXT, wants_invoice: true, country: 'PL' });
  assert.equal(anonymiseHistoryDetail('order.section_edited', r.value).changed, false, 'idempotent');
  assert.equal(anonymiseHistoryDetail('order.item_added', { sku: 'X' }).changed, false);
  assert.equal(anonymiseHistoryDetail('order.section_edited', { section: 'delivery_method', changes: [] }).changed, false);
  const legacy = anonymiseHistoryDetail('order.customer_updated', { fields: ['email'], changes: [{ field: 'email', before: 'a@b.pl', after: 'c@d.pl' }] });
  assert.deepEqual((legacy.value as any).changes[0], { field: 'email', before: ANON_TEXT, after: ANON_TEXT });
});

test('a pickup point needs a parcel-locker or pickup-point delivery (labels refuse an address delivery with a point)', () => {
  const addr = { recipient: 'Jan', street: 'Testowa 3', postal_code: '00-001', city: 'Warszawa', country: 'PL', pickup_point: 'WAW01M' };
  assert.throws(() => checkMerged('delivery_address', addr, { source: 'manual', deliveryMethod: 'courier' }), /zmień sposób dostawy/);
  assert.doesNotThrow(() => checkMerged('delivery_address', addr, { source: 'manual', deliveryMethod: 'parcel_locker' }));
  assert.doesNotThrow(() => checkMerged('delivery_address', addr, { source: 'manual', deliveryMethod: 'pickup_point' }));
  assert.doesNotThrow(() => checkMerged('delivery_address', { ...addr, pickup_point: '' }, { source: 'manual', deliveryMethod: 'courier' }));
});
