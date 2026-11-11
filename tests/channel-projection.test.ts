/** Lane L: the channel projection per channel and fallback, without a database, and rule conditions on it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOperator, parcelSizeOf, projectChannelData, type ProjectionInput } from '../server/channel-projection';
import {
  channelMethodCode,
  deliveryMethodOptions,
  isDeliveryFilterCode,
  methodSlug,
} from '../shared/channel-projection';
import { evaluate } from '../server/automation-v2-eval';
import { fieldMeta } from '../server/automation-v2-fields';
import type { ConditionGroup } from '../shared/automation-v2';

const base = (patch: Partial<ProjectionInput> = {}): ProjectionInput => ({
  provider: 'manual',
  raw: null,
  order: { note: '', address: {}, payment_mode: 'prepaid' },
  ...patch,
});
const allegro = (raw: Record<string, unknown>, patch: Partial<ProjectionInput> = {}) =>
  projectChannelData(base({ provider: 'allegro', raw, ...patch }));

test('Allegro: comment, site, Smart, business, ship-by, operator and the cash on delivery locker method', () => {
  const p = allegro(
    {
      messageToSeller: 'Proszę zapakować na prezent',
      marketplace: { id: 'allegro-cz' },
      buyer: { companyName: 'Smakosz s.r.o.' },
      invoice: { required: true },
      payment: { type: 'CASH_ON_DELIVERY' },
      delivery: {
        smart: true,
        method: { name: 'Allegro Paczkomaty InPost pobranie' },
        pickupPoint: { id: 'KRA01M' },
        time: { dispatch: { to: '2026-11-12T14:00:00Z' } },
      },
    },
    { order: { note: 'inna notatka', address: {}, payment_mode: 'cod' } },
  );
  assert.equal(p.customer_comment, 'Proszę zapakować na prezent');
  assert.equal(p.site, 'allegro.cz');
  assert.deepEqual(p.flags, ['smart', 'business', 'invoice']);
  assert.equal(p.ship_by, '2026-11-12T14:00:00.000Z');
  assert.equal(p.payment_operator, 'cod');
  assert.deepEqual(p.shipping_method, ['parcel_locker', 'parcel_locker_cod', 'allegro:allegro-paczkomaty-inpost-pobranie']);
  assert.equal(p.shipping_method_label, 'Allegro Paczkomaty InPost pobranie');
});

test('Allegro operators: PayU, Przelewy24, Allegro Finanse and an online payment without a provider', () => {
  const op = (provider?: string) => allegro({ payment: { type: 'ONLINE', ...(provider ? { provider } : {}) } }).payment_operator;
  assert.equal(op('PAYU'), 'payu');
  assert.equal(op('P24'), 'przelewy24');
  assert.equal(op('AF'), 'allegro_finance');
  assert.equal(op('AF_PAYU'), 'allegro_finance');
  assert.equal(op(), 'marketplace');
  assert.equal(allegro({ payment: { type: 'ONLINE', provider: 'NEWPAY' } }).payment_operator, 'other', 'unknown provider');
});

test('Allegro without marketplace is allegro.pl; Smart off, no comment and no ship-by stay empty', () => {
  const p = allegro({ delivery: { method: { name: 'Allegro Kurier DPD' } }, payment: { type: 'ONLINE', provider: 'PAYU' } });
  assert.equal(p.site, 'allegro.pl');
  assert.equal(p.customer_comment, '');
  assert.equal(p.ship_by, null);
  assert.deepEqual(p.flags, []);
  assert.deepEqual(p.shipping_method, ['courier', 'allegro:allegro-kurier-dpd']);
  assert.match(p.sources.ship_by, /nie przekazał/);
});

test('Allegro COD name without "pobranie" gets the cash on delivery variant code', () => {
  const p = allegro({ delivery: { method: { name: 'Allegro One Box' } }, payment: { type: 'CASH_ON_DELIVERY' } }, {
    order: { address: {}, payment_mode: 'cod' },
  });
  assert.deepEqual(p.shipping_method, ['parcel_locker', 'parcel_locker_cod', 'allegro:allegro-one-box-pobranie']);
  assert.equal(p.shipping_method_label, 'Allegro One Box pobranie');
});

test('WooCommerce: buyer note, shop site, operator from the gateway, express shipping line, unknown gateway', () => {
  const raw = {
    customer_note: 'Dzwonić przed dostawą',
    payment_method: 'payu',
    payment_method_title: 'PayU — szybkie płatności',
    shipping_lines: [{ method_id: 'flat_rate', method_title: 'Kurier ekspresowy DPD' }],
  };
  const p = projectChannelData(base({ provider: 'woocommerce', raw, channelSettings: { store_url: 'https://www.sklep-smakow.example/' } }));
  assert.equal(p.customer_comment, 'Dzwonić przed dostawą');
  assert.equal(p.site, 'sklep-smakow.example');
  assert.equal(p.payment_operator, 'payu');
  assert.ok(p.flags.includes('express'));
  assert.deepEqual(p.shipping_method, ['courier', 'woocommerce:kurier-ekspresowy-dpd']);
  const unknown = projectChannelData(base({ provider: 'woocommerce', raw: { payment_method: 'superpay', payment_method_title: 'SuperPay Bramka' } }));
  assert.equal(unknown.payment_operator, 'other');
  assert.match(unknown.sources.payment_operator, /SuperPay/);
  const bacs = projectChannelData(base({ provider: 'woocommerce', raw: { payment_method: 'bacs', payment_method_title: 'Przelew bankowy' } }));
  assert.equal(bacs.payment_operator, 'bank_transfer');
});

test('Shopify, PrestaShop: note and payment module', () => {
  const s = projectChannelData(base({ provider: 'shopify', raw: { note: 'Bez paragonu', payment_gateway_names: ['stripe'] } }));
  assert.equal(s.customer_comment, 'Bez paragonu');
  assert.equal(s.payment_operator, 'stripe');
  const ps = projectChannelData(base({ provider: 'prestashop', raw: { module: 'przelewy24', payment: 'Przelewy24', messages: [{ message: 'Proszę o fakturę' }] } }));
  assert.equal(ps.customer_comment, 'Proszę o fakturę');
  assert.equal(ps.payment_operator, 'przelewy24');
  const cod = projectChannelData(base({ provider: 'prestashop', raw: { module: 'ps_cashondelivery', payment: 'Płatność przy odbiorze' } }));
  assert.equal(cod.payment_operator, 'cod');
});

test('Amazon: marketplace, Prime, Business, FBA, express and latest ship date', () => {
  const p = projectChannelData(
    base({
      provider: 'amazon',
      raw: {
        salesChannel: { marketplaceId: 'A1PA6795UKMFR9' },
        programs: ['PRIME', 'AMAZON_BUSINESS'],
        fulfillment: { fulfilledBy: 'AMAZON', fulfillmentServiceLevel: 'Expedited' },
        LatestShipDate: '2026-11-13T23:59:59Z',
      },
    }),
  );
  assert.equal(p.site, 'amazon.de');
  assert.deepEqual(p.flags, ['express', 'business', 'prime', 'fba']);
  assert.equal(p.ship_by, '2026-11-13T23:59:59.000Z');
  assert.equal(p.payment_operator, 'amazon_pay');
  const unknown = projectChannelData(base({ provider: 'amazon', raw: { salesChannel: { marketplaceId: 'XYZ' } } }));
  assert.equal(unknown.site, 'amazon');
});

test('eBay and Mirakl: site, comment and the earliest ship-by date', () => {
  const e = projectChannelData(
    base({
      provider: 'ebay',
      raw: {
        buyerCheckoutNotes: 'Wysyłka do pracy',
        lineItems: [
          { purchaseMarketplaceId: 'EBAY_GB', lineItemFulfillmentInstructions: { shipByDate: '2026-11-15T10:00:00Z' } },
          { lineItemFulfillmentInstructions: { shipByDate: '2026-11-14T10:00:00Z' } },
        ],
      },
    }),
  );
  assert.equal(e.site, 'ebay.co.uk');
  assert.equal(e.customer_comment, 'Wysyłka do pracy');
  assert.equal(e.ship_by, '2026-11-14T10:00:00.000Z');
  assert.equal(e.payment_operator, 'ebay_payments');
  const m = projectChannelData(
    base({
      provider: 'mirakl',
      raw: { channel: { code: 'INIT' }, shipping_deadline: '2026-11-16T12:00:00Z', shipping_type_code: 'EXPRESS', shipping_type_label: 'Kurier ekspres' },
      channelSettings: { instance_url: 'https://empik-prod.mirakl.net' },
    }),
  );
  assert.equal(m.site, 'empik-prod.mirakl.net/init');
  assert.equal(m.ship_by, '2026-11-16T12:00:00.000Z');
  assert.ok(m.flags.includes('express'));
  assert.equal(m.payment_operator, 'marketplace');
});

test('manual order fallbacks: note, payment entry, payment form, card section method with COD, sizes', () => {
  const manual = (patch: Partial<ProjectionInput>) => projectChannelData(base(patch));
  const p = manual({
    order: { note: 'Odbiór po 16:00', address: { locker_code: 'LOD03M', nip: '5250001009' }, payment_mode: 'prepaid' },
    payments: [{ kind: 'receipt', method: 'other', reference: 'BLIK 123' }],
    lines: [{ quantity: 2, weight_grams: 500, length_mm: 200, width_mm: 150, height_mm: 30 }],
  });
  assert.equal(p.customer_comment, 'Odbiór po 16:00');
  assert.equal(p.site, '');
  assert.equal(p.payment_operator, 'blik');
  assert.deepEqual(p.shipping_method, ['parcel_locker']);
  assert.equal(p.parcel_size, 'A');
  assert.deepEqual(p.flags, ['business', 'invoice'], 'NIP in the order: business and invoice');

  const cod = manual({
    order: { note: '', address: {}, payment_mode: 'cod' },
    edited: { delivery_method: { method: 'courier', carrier: 'DPD', cost: 1699 } },
  });
  assert.deepEqual(cod.shipping_method, ['courier', 'courier_cod']);
  assert.equal(cod.shipping_method_label, 'Kurier — pobranie');
  assert.equal(cod.payment_operator, 'cod');
  assert.match(cod.sources.shipping_method, /Sekcja „Sposób dostawy”/);

  assert.equal(manual({ payments: [{ kind: 'receipt', method: 'bank_transfer', reference: 'Przelew ZAM-1' }] }).payment_operator, 'bank_transfer');
  assert.equal(manual({ payments: [{ kind: 'receipt', method: 'payu', reference: 'PayU SYMULACJA' }] }).payment_operator, 'payu');
  assert.equal(manual({ edited: { payment: { method: 'card' } } }).payment_operator, 'card', 'payment form');
  assert.equal(
    manual({ payments: [{ kind: 'receipt', method: 'status_confirmation', reference: '' }], edited: { payment: { method: 'transfer' } } }).payment_operator,
    'bank_transfer',
    'a status confirmation says nothing about the operator',
  );
});

test('no data at all: every field is empty or unknown with a reason', () => {
  const p = projectChannelData(base());
  assert.equal(p.customer_comment, '');
  assert.equal(p.site, '');
  assert.deepEqual(p.flags, []);
  assert.equal(p.ship_by, null);
  assert.equal(p.payment_operator, '');
  assert.deepEqual(p.shipping_method, ['unknown']);
  assert.equal(p.parcel_size, '');
  for (const s of Object.values(p.sources)) assert.ok(s.length > 5, s);
  const odd = projectChannelData(base({ provider: 'allegro', raw: { delivery: { time: { dispatch: { to: 'jutro' } } } } }));
  assert.equal(odd.ship_by, null, 'invalid date is no date');
});

test('parcel size: InPost A/B/C thresholds, weight limit, missing dimensions and the carrier template', () => {
  const l = (h: number, quantity = 1, weight = 1000) => ({ quantity, weight_grams: weight, length_mm: 600, width_mm: 350, height_mm: h });
  assert.equal(parcelSizeOf([l(80)]), 'A', 'exactly 8 cm');
  assert.equal(parcelSizeOf([l(81)]), 'B');
  assert.equal(parcelSizeOf([l(95, 2)]), 'B', 'stacked to 19 cm');
  assert.equal(parcelSizeOf([l(100, 2)]), 'C');
  assert.equal(parcelSizeOf([l(410)]), 'C');
  assert.equal(parcelSizeOf([{ quantity: 3, weight_grams: 300, length_mm: 200, width_mm: 150, height_mm: 90 }]), 'B', '20 × 15 × 27 cm lies on its side in B');
  assert.equal(parcelSizeOf([l(411)]), 'over');
  assert.equal(parcelSizeOf([{ quantity: 1, weight_grams: 1000, length_mm: 700, width_mm: 100, height_mm: 50 }]), 'over', '70 cm is longer than 64 cm');
  assert.equal(parcelSizeOf([l(50, 1, 26000)]), 'over', 'over 25 kg');
  assert.equal(parcelSizeOf([{ quantity: 1, weight_grams: 30000 }]), 'over', 'weight alone is enough to exceed');
  assert.equal(parcelSizeOf([{ quantity: 1, weight_grams: 300 }]), '', 'no dimensions');
  assert.equal(parcelSizeOf([]), '');
  const planned = projectChannelData(base({ planInput: { template: 'medium' }, lines: [l(80)] }));
  assert.equal(planned.parcel_size, 'B', 'carrier template wins');
});

test('operator detection, slugs and filter codes', () => {
  assert.equal(detectOperator('Przelewy24'), 'przelewy24');
  assert.equal(detectOperator('Allegro online (PAYU)'), 'payu');
  assert.equal(detectOperator('Allegro Finance'), 'allegro_finance');
  assert.equal(detectOperator('nieznane'), '');
  assert.equal(methodSlug('Allegro Odbiór w Punkcie ORLEN Paczka'), 'allegro-odbior-w-punkcie-orlen-paczka');
  assert.equal(methodSlug('Łódź – Żółć'), 'lodz-zolc');
  assert.deepEqual(channelMethodCode('allegro', 'Allegro Kurier DPD', true), { value: 'allegro:allegro-kurier-dpd-pobranie', label: 'Allegro Kurier DPD pobranie' });
  for (const ok of ['courier', 'parcel_locker_cod', 'allegro:allegro-one-box']) assert.ok(isDeliveryFilterCode(ok), ok);
  for (const bad of ['drone', 'unknown_cod', 'allegro:', 'allegro:Bad Name', "x:'--"]) assert.ok(!isDeliveryFilterCode(bad), bad);
  const options = deliveryMethodOptions([{ provider: 'woocommerce', label: 'Paczkomaty InPost' }]);
  const values = options.map((o) => o.value);
  for (const v of ['parcel_locker', 'parcel_locker_cod', 'allegro:allegro-paczkomaty-inpost', 'allegro:allegro-paczkomaty-inpost-pobranie', 'allegro:allegro-one-box', 'allegro:allegro-kurier-dpd-pobranie', 'woocommerce:paczkomaty-inpost', 'woocommerce:paczkomaty-inpost-pobranie'])
    assert.ok(values.includes(v), v);
  assert.equal(new Set(values).size, values.length, 'no duplicates');
  assert.ok(!values.includes('allegro:allegro-paczkomaty-inpost-pobranie-pobranie'));
});

test('rule conditions on the projected fields', () => {
  const p = allegro(
    {
      marketplace: { id: 'allegro-cz' },
      delivery: { smart: true, method: { name: 'Allegro Paczkomaty InPost pobranie' }, time: { dispatch: { to: '2026-11-11T08:00:00Z' } } },
      payment: { type: 'CASH_ON_DELIVERY' },
      messageToSeller: 'Proszę o FAKTURĘ',
    },
    { order: { address: {}, payment_mode: 'cod' }, lines: [{ quantity: 1, weight_grams: 400, length_mm: 300, width_mm: 200, height_mm: 100 }] },
  );
  const ctx = {
    order_id: 'o1',
    number: 'ZAM-1',
    lines: [],
    values: {
      'order.customer_comment': p.customer_comment,
      'source.site': p.site,
      'source.flags': p.flags,
      'source.ship_by': p.ship_by,
      'payment.operator': p.payment_operator,
      'shipping.method': p.shipping_method,
      'shipping.parcel_size': p.parcel_size,
    },
  };
  const now = Date.parse('2026-11-10T12:00:00Z');
  const check = (items: ConditionGroup['items'], match: 'all' | 'any' = 'all') => evaluate({ match, items }, ctx, fieldMeta, now).matched;
  assert.ok(check([{ field: 'order.customer_comment', op: 'contains', value: 'faktur' }]));
  assert.ok(check([{ field: 'order.customer_comment', op: 'not_empty' }]));
  assert.ok(check([{ field: 'source.site', op: 'in', value: ['allegro.cz'] }]));
  assert.ok(!check([{ field: 'source.site', op: 'in', value: ['allegro.pl'] }]));
  assert.ok(check([{ field: 'source.flags', op: 'in', value: ['smart'] }]));
  assert.ok(check([{ field: 'source.flags', op: 'not_in', value: ['business'] }]));
  assert.ok(check([{ field: 'source.ship_by', op: 'newer_than', value: '2026-11-10T00:00:00Z' }]));
  assert.ok(check([{ field: 'payment.operator', op: 'in', value: ['cod'] }]));
  assert.ok(check([{ field: 'shipping.method', op: 'in', value: ['allegro:allegro-paczkomaty-inpost-pobranie'] }]));
  assert.ok(check([{ field: 'shipping.method', op: 'in', value: ['parcel_locker'] }]), 'group still matches (old rules)');
  assert.ok(check([{ field: 'shipping.method', op: 'in', value: ['parcel_locker_cod'] }]));
  assert.ok(!check([{ field: 'shipping.method', op: 'in', value: ['allegro:allegro-paczkomaty-inpost'] }]), 'prepaid variant does not match');
  assert.ok(check([{ field: 'shipping.parcel_size', op: 'in', value: ['B'] }]), '10 cm high: gabaryt B');
  assert.ok(!check([{ field: 'shipping.parcel_size', op: 'in', value: ['A', 'C', 'over'] }]));
  assert.ok(check([{ field: 'payment.operator', op: 'eq', value: 'COD' }]), 'a rule saved with a text operator still works');
  for (const k of ['source.site', 'payment.operator', 'shipping.parcel_size', 'shipping.method', 'source.flags']) assert.equal(fieldMeta(k)?.type, 'list', k);
});
