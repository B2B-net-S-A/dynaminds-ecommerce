/** ANALYTICS-002 (migration 247): the delivery and payment dimension recorded at import.
 * Pure: classification of the channel's own delivery/payment names into fixed groups, per provider,
 * and the period comparison of grouped sales. No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDelivery,
  classifyPayment,
  orderSalesDimensions,
  DELIVERY_METHODS,
  PAYMENT_METHODS,
} from '../server/sales-dimensions';
import { compareGroups, groupQuery } from '../server/reports-groups-model';

test('delivery names fall into fixed groups; unknown text is "other", nothing is "unknown"', () => {
  const cases: [string, string][] = [
    ['InPost Paczkomaty 24/7', 'parcel_locker'],
    ['Allegro One Box, DPD', 'parcel_locker'],
    ['Allegro Kurier DPD', 'courier'],
    ['Kurier InPost pobranie', 'courier'],
    ['DHL Parcel', 'courier'],
    ['Odbiór osobisty w sklepie', 'personal_pickup'],
    ['Local pickup', 'personal_pickup'],
    ['Orlen Paczka', 'pickup_point'],
    ['Allegro Odbiór w Punkcie DPD Pickup', 'pickup_point'],
    ['Poczta Polska list polecony', 'post'],
    ['Wysyłka elektroniczna (e-mail)', 'digital'],
    ['Dostawa gratis', 'other'],
  ];
  for (const [label, key] of cases) assert.equal(classifyDelivery(label), key, label);
  assert.equal(classifyDelivery(''), 'unknown');
  assert.equal(classifyDelivery(null), 'unknown');
  assert.equal(classifyDelivery('Dostawa gratis', { pickupPoint: true }), 'pickup_point');
  for (const k of ['parcel_locker', 'courier', 'unknown', 'other']) assert(DELIVERY_METHODS.includes(k as any));
});

test('payment names: cash on delivery wins, then transfer, card, online wallets; marketplaces stay marketplace', () => {
  assert.equal(classifyPayment('Przelew bankowy', { cod: false }), 'transfer');
  assert.equal(classifyPayment('bacs Direct bank transfer', { cod: false }), 'transfer');
  assert.equal(classifyPayment('Płatność przy odbiorze', { cod: false }), 'cod');
  assert.equal(classifyPayment('PayU', { cod: true }), 'cod');
  assert.equal(classifyPayment('Stripe credit card', { cod: false }), 'card');
  assert.equal(classifyPayment('BLIK', { cod: false }), 'online');
  assert.equal(classifyPayment('Przelewy24', { cod: false }), 'online');
  assert.equal(classifyPayment('Gotówka', { cod: false }), 'cash');
  assert.equal(classifyPayment('Bon podarunkowy', { cod: false }), 'other');
  assert.equal(classifyPayment('', { cod: false }), 'unknown');
  assert.equal(classifyPayment('', { cod: true }), 'cod');
  for (const k of ['cod', 'online', 'marketplace', 'unknown']) assert(PAYMENT_METHODS.includes(k as any));
});

test('each importer reads its own documented fields; labels are trimmed, single-line and at most 120 characters', () => {
  const woo = orderSalesDimensions('woocommerce', {
    payment_method: 'bacs', payment_method_title: 'Przelew bankowy',
    shipping_lines: [{ method_id: 'flexible_shipping_single', method_title: '  InPost\nPaczkomaty  ' }],
  }, { payment_mode: 'prepaid' });
  assert.deepEqual(woo, { delivery_method: 'parcel_locker', delivery_label: 'InPost Paczkomaty', payment_method: 'transfer', payment_label: 'Przelew bankowy' });
  assert.equal(orderSalesDimensions('woocommerce', { payment_method: 'cod', payment_method_title: 'Za pobraniem', shipping_lines: [{ method_id: 'local_pickup', method_title: 'Odbiór' }] }, { payment_mode: 'cod' }).delivery_method, 'personal_pickup');
  const allegro = orderSalesDimensions('allegro', {
    delivery: { method: { id: 'x', name: 'Allegro Paczkomaty InPost' }, pickupPoint: { id: 'KRA01M' } },
    payment: { type: 'ONLINE', provider: 'P24' },
  }, { payment_mode: 'prepaid' });
  assert.deepEqual(allegro, { delivery_method: 'parcel_locker', delivery_label: 'Allegro Paczkomaty InPost', payment_method: 'online', payment_label: 'Allegro online (P24)' });
  assert.equal(orderSalesDimensions('allegro', { delivery: { method: { name: 'Allegro Kurier DPD pobranie' } }, payment: { type: 'CASH_ON_DELIVERY' } }, { payment_mode: 'cod' }).payment_method, 'cod');
  const shopify = orderSalesDimensions('shopify', { shipping_lines: [{ title: 'DHL Express', code: 'dhl' }], payment_gateway_names: ['shopify_payments'] }, { payment_mode: 'prepaid' });
  assert.equal(shopify.delivery_method, 'courier');
  assert.equal(shopify.payment_method, 'card');
  const presta = orderSalesDimensions('prestashop', { module: 'ps_wirepayment', payment: 'Przelew bankowy' }, { payment_mode: 'prepaid' });
  assert.equal(presta.payment_method, 'transfer');
  assert.equal(presta.delivery_method, 'unknown');
  for (const p of ['amazon', 'ebay', 'mirakl']) assert.equal(orderSalesDimensions(p, {}, { payment_mode: 'prepaid' }).payment_method, 'marketplace', p);
  assert.equal(orderSalesDimensions('ebay', { fulfillmentStartInstructions: [{ shippingStep: { shippingServiceCode: 'PL_InPostPaczkomaty' } }] }, { payment_mode: 'prepaid' }).delivery_method, 'parcel_locker');
  assert.equal(orderSalesDimensions('mirakl', { shipping_type_label: 'Kurier standard' }, { payment_mode: 'prepaid' }).delivery_method, 'courier');
  const long = orderSalesDimensions('woocommerce', { shipping_lines: [{ method_title: 'K'.repeat(400) + '\u0000' }] }, { payment_mode: 'prepaid' });
  assert.equal(long.delivery_label.length, 120);
  assert.doesNotMatch(long.delivery_label, /[\u0000-\u001f\u007f]/);
  // Unknown provider and garbage raw never throw: the dimension is unknown, not a refused import.
  assert.deepEqual(orderSalesDimensions('odoo', null, { payment_mode: 'prepaid' }), { delivery_method: 'unknown', delivery_label: '', payment_method: 'unknown', payment_label: '' });
  assert.equal(orderSalesDimensions('woocommerce', { shipping_lines: 'x', payment_method_title: 42 }, { payment_mode: 'cod' }).payment_method, 'cod');
});

test('group query: one dimension, two periods of 1–366 days each, Polish 422 for a missing or crossed comparison', () => {
  const ok = groupQuery.parse({ from: '2026-10-01', to: '2026-10-31', compare_from: '2026-09-01', compare_to: '2026-09-30', group_by: 'delivery' });
  assert.equal(ok.group_by, 'delivery');
  assert.equal(groupQuery.parse({ from: '2026-10-01', to: '2026-10-31' }).group_by, 'source');
  assert.equal(groupQuery.safeParse({ from: '2026-10-01', to: '2026-10-31', compare_from: '2026-09-01' }).success, false);
  assert.equal(groupQuery.safeParse({ from: '2026-10-01', to: '2026-10-31', compare_from: '2026-09-30', compare_to: '2026-09-01' }).success, false);
  assert.equal(groupQuery.safeParse({ from: '2026-10-01', to: '2026-10-31', group_by: 'warehouse' }).success, false);
  assert.equal(groupQuery.safeParse({ from: '2025-01-01', to: '2026-10-31' }).success, false);
});

test('comparison joins both periods per currency and group: missing side is zero, deltas exact, sums equal the inputs', () => {
  const current = [
    { currency: 'PLN', group: 'courier', orders: 3, total_gross_minor: '30000', delivery_gross_minor: '3000' },
    { currency: 'PLN', group: 'parcel_locker', orders: 2, total_gross_minor: '9999', delivery_gross_minor: '1000' },
    { currency: 'EUR', group: 'courier', orders: 1, total_gross_minor: '5000', delivery_gross_minor: '0' },
  ];
  const previous = [
    { currency: 'PLN', group: 'courier', orders: 1, total_gross_minor: '10000', delivery_gross_minor: '1000' },
    { currency: 'PLN', group: 'post', orders: 4, total_gross_minor: '4000', delivery_gross_minor: '400' },
  ];
  const rows = compareGroups(current, previous);
  const pick = (c: string, g: string) => rows.find((r) => r.currency === c && r.group === g)!;
  assert.deepEqual(pick('PLN', 'courier'), {
    currency: 'PLN', group: 'courier', orders: 3, compare_orders: 1, orders_delta: 2,
    total_gross_minor: '30000', compare_total_gross_minor: '10000', total_delta_minor: '20000', total_change_bps: 20000,
    delivery_gross_minor: '3000', compare_delivery_gross_minor: '1000',
    share_bps: 7500,
  });
  assert.equal(pick('PLN', 'post').orders, 0);
  assert.equal(pick('PLN', 'post').total_delta_minor, '-4000');
  assert.equal(pick('PLN', 'post').total_change_bps, -10000);
  assert.equal(pick('PLN', 'parcel_locker').total_change_bps, null, 'no base: no percentage');
  assert.equal(pick('EUR', 'courier').share_bps, 10000);
  // Rows ordered by currency, then current value descending.
  assert.deepEqual(rows.map((r) => r.currency + ':' + r.group), ['EUR:courier', 'PLN:courier', 'PLN:parcel_locker', 'PLN:post']);
  for (const c of ['PLN', 'EUR']) {
    const sum = (k: 'total_gross_minor' | 'compare_total_gross_minor') => rows.filter((r) => r.currency === c).reduce((s, r) => s + BigInt(r[k] ?? '0'), 0n);
    assert.equal(sum('total_gross_minor'), current.filter((r) => r.currency === c).reduce((s, r) => s + BigInt(r.total_gross_minor), 0n));
    assert.equal(sum('compare_total_gross_minor'), previous.filter((r) => r.currency === c).reduce((s, r) => s + BigInt(r.total_gross_minor), 0n));
  }
  assert.deepEqual(compareGroups(current, null).map((r) => r.compare_orders), [null, null, null]);
});
