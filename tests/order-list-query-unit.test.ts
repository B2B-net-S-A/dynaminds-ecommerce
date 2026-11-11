/** Order list filters without a database: parameter schema, SQL builder and the browser-side model. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OrderListParams,
  OrderListUnavailable,
  likeFragment,
  orderListConditions,
  orderListPaging,
  orderListQuerySchema,
  withPaymentFields,
} from '../server/order-list-query';
import {
  activeFilterCount,
  addTemplate,
  emptyFilters,
  filterProblems,
  filtersFromQuery,
  filtersToApiParams,
  filtersToQuery,
  ordersStorageKey,
  parseMoney,
  parseTemplates,
  readStored,
  removeTemplate,
  writeStored,
} from '../web/order-filters';
import { csvAmount, csvCell, ordersCsv } from '../web/orders-list-csv';

const all = { salesDimensions: true, receipts: true };
const build = (query: Record<string, string>, available = all) => {
  const p = new OrderListParams();
  const sql = orderListConditions(orderListQuerySchema.parse(query), p, available);
  return { sql, params: p.values };
};

test('schema: blanks are no filter, lists are deduplicated, ranges must be ordered', () => {
  const q = orderListQuerySchema.parse({ number: '  ', status: 'paid,,paid,ready_to_ship', total_from: '' });
  assert.equal(q.number, undefined);
  assert.equal(q.total_from, undefined);
  assert.deepEqual(q.status, ['paid', 'ready_to_ship']);
  assert.equal(orderListQuerySchema.safeParse({ created_from: '2026-10-02', created_to: '2026-10-01' }).success, false);
  assert.equal(orderListQuerySchema.safeParse({ created_from: '2026-10-01', created_to: '2026-10-01' }).success, true);
  assert.equal(orderListQuerySchema.safeParse({ status: 'paid,shipping' }).success, false);
  assert.equal(orderListQuerySchema.safeParse({ channel: 'allegro;drop' }).success, false);
  assert.equal(orderListQuerySchema.safeParse({ channel: Array(21).fill('a').map((x, i) => x + i).join(',') }).success, false);
  assert.equal(orderListQuerySchema.safeParse({ shipping_from: '12.5' }).success, false);
  assert.equal(orderListQuerySchema.safeParse({ customer: 'x'.repeat(101) }).success, false);
});

test('builder: no filter is TRUE and values never reach the SQL text', () => {
  assert.deepEqual(build({}), { sql: 'TRUE', params: [] });
  const evil = "x' OR 1=1 --";
  const { sql, params } = build({ number: evil, customer: evil, allegro_login: evil, sku: evil });
  assert.ok(!sql.includes('OR 1=1'));
  assert.deepEqual(params, [likeFragment(evil), likeFragment(evil), likeFragment(evil), likeFragment(evil)]);
});

test('builder: LIKE wildcards are escaped and placeholders are numbered in order', () => {
  assert.equal(likeFragment('10%_\\'), '%10\\%\\_\\\\%');
  const { sql, params } = build({ number: 'A', total_from: '100', total_to: '200', status: 'packed' });
  assert.match(sql, /=ANY\(\$1::text\[\]\)/);
  assert.match(sql, /o\.number ILIKE \$2 ESCAPE/);
  assert.match(sql, /o\.total>=\$3::integer AND o\.total<=\$4::integer/);
  assert.deepEqual(params, [['packed'], '%A%', 100, 200]);
  const p = new OrderListParams();
  orderListConditions(orderListQuerySchema.parse({ number: 'A' }), p, all);
  const paging = orderListPaging(p, { date: '2026-10-01T00:00:00.000000Z', id: '00000000-0000-4000-8000-000000000001' }, 50);
  assert.equal(paging.limit, '$4');
  assert.deepEqual(p.values.slice(1), ['2026-10-01T00:00:00.000000Z', '00000000-0000-4000-8000-000000000001', 51]);
});

test('builder: phone adds a digits-only match only when digits were typed', () => {
  assert.equal(build({ phone: '+48 600' }).params.length, 2);
  assert.deepEqual(build({ phone: '+48 600' }).params[1], '%48600%');
  assert.equal(build({ phone: 'brak' }).params.length, 1);
});

test('builder: missing prepared tables', () => {
  assert.throws(() => build({ delivery: 'courier' }, { salesDimensions: false, receipts: true }), OrderListUnavailable);
  assert.match(build({ sale_document: 'receipt' }, { salesDimensions: true, receipts: false }).sql, /FALSE/);
  assert.doesNotMatch(build({ sale_document: 'none' }, { salesDimensions: true, receipts: false }).sql, /receipt233/);
});

test('rows: payment fields follow paymentState()', () => {
  const row = (extra: Record<string, unknown>) =>
    withPaymentFields({ status: 'paid', total: 1000, payment_mode: 'prepaid', item_count: 2, payment_summary: { net: 0, credit: 0 }, ...extra });
  assert.equal(row({}).payment_state, 'unpaid');
  assert.equal(row({ payment_summary: { net: 400, credit: 0 } }).payment_state, 'partial');
  assert.equal(row({ payment_summary: { net: 1000, credit: 0 } }).payment_state, 'paid');
  assert.equal(row({ payment_summary: { net: 1200, credit: 0 } }).payment_state, 'overpaid');
  assert.equal(row({ payment_mode: 'cod' }).payment_state, 'cod');
  assert.equal(row({ payment_summary: { net: 600, credit: 400 } }).payment_state, 'paid', 'return credit lowers what is owed');
  assert.equal(row({ status: 'cancelled' }).payment_state, 'paid');
  assert.equal(row({ payment_summary: { net: 400, credit: 0 } }).amount_due, 600);
  assert.equal('payment_summary' in row({}), false);
});

test('web model: money parsing, problems and API parameters', () => {
  assert.equal(parseMoney('12,50'), 1250);
  assert.equal(parseMoney('1 200'), 120000);
  assert.equal(parseMoney('0.5'), 50);
  assert.equal(parseMoney(''), undefined);
  assert.equal(parseMoney('12,505'), null);
  assert.equal(parseMoney('-1'), null);
  const f = { ...emptyFilters, number: ' ZAM ', total_from: '10', total_to: '5', created_from: '2026-10-02', created_to: '2026-10-01' };
  assert.deepEqual(filterProblems(f), ['Dodane: wartość „od” jest większa niż „do”', 'Kwota: wartość „od” jest większa niż „do”']);
  assert.deepEqual(filterProblems({ ...emptyFilters, shipping_from: 'abc' }), ['Koszt wysyłki: wpisz kwotę, np. 12,50']);
  assert.deepEqual(
    filtersToApiParams({ ...emptyFilters, number: ' ZAM ', total_from: '10,5', channel: ['allegro', 'manual'], status: ['paid'], has_note: 'no' }),
    { number: 'ZAM', channel: 'allegro,manual', total_from: '1050', has_note: 'no' },
    'status comes from the status panel',
  );
  assert.equal(activeFilterCount({ ...emptyFilters, city: 'a', status: ['paid'], payment: ['cod'] }), 3);
});

test('web model: URL round trip keeps other keys and drops malformed values', () => {
  const f = { ...emptyFilters, city: 'Kraków', status: ['paid' as const, 'ready_to_ship' as const], total_to: '99,99', has_return: 'yes' as const };
  const q = filtersToQuery(f, new URLSearchParams('integration=ok&city=old'));
  assert.equal(q.get('integration'), 'ok');
  assert.deepEqual(filtersFromQuery(q), f);
  const bad = filtersFromQuery(new URLSearchParams('status=paid,hacked&payment=free,cod&has_note=maybe&sale_document=receipt&delivery=courier,drone'));
  assert.deepEqual(bad.status, ['paid']);
  assert.deepEqual(bad.payment, ['cod']);
  assert.deepEqual(bad.delivery, ['courier']);
  const methods = filtersFromQuery(new URLSearchParams('delivery=parcel_locker_cod,allegro:allegro-paczkomaty-inpost-pobranie,unknown_cod,allegro:Zla'));
  assert.deepEqual(methods.delivery, ['parcel_locker_cod', 'allegro:allegro-paczkomaty-inpost-pobranie'], 'channel methods and COD variants survive the URL');
  assert.deepEqual(orderListQuerySchema.parse({ delivery: 'courier_cod,allegro:allegro-one-box' }).delivery, ['courier_cod', 'allegro:allegro-one-box']);
  assert.throws(() => orderListQuerySchema.parse({ delivery: 'allegro:Zła nazwa' }));
  assert.equal(bad.has_note, '');
  assert.equal(bad.sale_document, 'receipt');
});

test('web model: per-user storage keys, templates and a refusing browser', () => {
  assert.equal(ordersStorageKey('t1:u1:admin', 'filterTemplates'), 'dyna.orders.t1.u1.filterTemplates');
  let list = addTemplate([], ' Allegro do wysyłki ', { ...emptyFilters, channel: ['allegro'] }, 'a');
  list = addTemplate(list, 'Zwroty', { ...emptyFilters, has_return: 'yes' }, 'b');
  list = addTemplate(list, 'allegro DO wysyłki', { ...emptyFilters, channel: ['manual'] }, 'c');
  assert.deepEqual(list.map((t) => [t.id, t.name]), [['b', 'Zwroty'], ['c', 'allegro DO wysyłki']], 'same name replaces');
  assert.deepEqual(parseTemplates(JSON.stringify(list)), list);
  assert.deepEqual(removeTemplate(list, 'b').map((t) => t.id), ['c']);
  assert.deepEqual(parseTemplates('{not json'), []);
  assert.deepEqual(parseTemplates(JSON.stringify([{ id: 1 }, { id: 'x', name: 'Ok', filters: { city: 'A', has_note: 'x' } }])), [
    { id: 'x', name: 'Ok', filters: { ...emptyFilters, city: 'A' } },
  ]);
  const refusing = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(readStored('k', refusing), null);
  assert.equal(writeStored('k', 'v', refusing), false);
  const map = new Map<string, string>();
  const working = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  assert.equal(writeStored('k', 'false', working), true);
  assert.equal(readStored('k', working), 'false');
});

test('CSV: BOM, Polish headers, semicolons, quoting and formula guard', () => {
  assert.equal(csvAmount(123450), '1234,50');
  assert.equal(csvAmount(5), '0,05');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('say "hi"\nok'), '"say ""hi""\nok"');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+48 600'), "'+48 600");
  const csv = ordersCsv(
    [
      {
        number: 'ZAM-1',
        created_at: '2026-10-10T21:30:00.000Z',
        source: 'allegro',
        external_id: 'A-1',
        customer_name: 'Łucja Żak; Sp. z o.o.',
        email: 'l@example.test',
        address: { phone: '600100200', city: 'Kraków', postal_code: '30-001', country: 'PL', street: 'Długa 1' },
        first_item_name: 'Kubek',
        line_count: 2,
        quantity_total: 3,
        status: 'packed',
        fulfilment_stage: 'ready_to_ship',
        payment_state: 'partial',
        total: 12345,
        shipping_cost: 1500,
        currency: 'PLN',
        note: '',
      },
    ],
    (s) => (s === 'allegro' ? 'Allegro' : s),
  );
  assert.ok(csv.startsWith('﻿Numer zamówienia;Data dodania;Kanał sprzedaży;'));
  const [, row] = csv.slice(1).split('\r\n');
  assert.equal(
    row,
    'ZAM-1;2026-10-10 23:30;Allegro;A-1;"Łucja Żak; Sp. z o.o.";l@example.test;600100200;Długa 1;30-001;Kraków;PL;Kubek;2;3;Gotowe do nadania;Częściowo;123,45;15,00;PLN;',
  );
  assert.ok(csv.endsWith('\r\n'));
});
