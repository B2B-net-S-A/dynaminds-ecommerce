import assert from 'node:assert/strict';
import test from 'node:test';
import { documentBody } from '../server/portal-view';
import {
  proformaLineAmounts,
  proformaTotals,
  proformaPreviewInput,
  proformaRequestHash,
} from '../server/proforma-values';

test('gross historical lines and delivery round once to net and VAT', () => {
  const product = proformaLineAmounts('24690', 23);
  const shipping = proformaLineAmounts('999', 8);
  assert.deepEqual(product, { gross_minor: '24690', net_minor: '20073', vat_minor: '4617' });
  assert.deepEqual(shipping, { gross_minor: '999', net_minor: '925', vat_minor: '74' });
  assert.deepEqual(proformaTotals([product, shipping], '25689'), {
    gross_minor: '25689',
    net_minor: '20998',
    vat_minor: '4691',
  });
});
test('half pennies round up; zero VAT and large integers stay exact', () => {
  assert.deepEqual(proformaLineAmounts('1', 100), {
    gross_minor: '1',
    net_minor: '1',
    vat_minor: '0',
  });
  assert.deepEqual(proformaLineAmounts('9007199254740993', 0), {
    gross_minor: '9007199254740993',
    net_minor: '9007199254740993',
    vat_minor: '0',
  });
});
test('invalid money and inconsistent order totals are rejected', () => {
  for (const value of ['-1', '01', '1.2', 'abc', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => proformaLineAmounts(value, 23));
  for (const vat of [-1, 101, 1.5, NaN]) assert.throws(() => proformaLineAmounts('100', vat));
  assert.throws(() => proformaTotals([proformaLineAmounts('100', 23)], '101'));
  assert.throws(() =>
    proformaTotals([{ gross_minor: '100', net_minor: '99', vat_minor: '2' }], '100'),
  );
});
test('malformed version yields validation failure rather than throwing from BigInt', () => {
  const request = {
    client_key: 'fd2b1397-5cc4-4ea3-b11f-a0a364d33328',
    series_id: 'a6d47c6e-293f-424b-8b8c-d4295c77d64c',
    shipping_vat: 8,
  };
  for (const order_version of ['abc', '1.5', '0', '01', '9223372036854775808'])
    assert.equal(proformaPreviewInput.safeParse({ ...request, order_version }).success, false);
  assert.equal(
    proformaPreviewInput.safeParse({ ...request, order_version: '9223372036854775807' }).success,
    true,
  );
});
test('request hash is object-order stable and bound to principal and operation', () => {
  const a = proformaRequestHash('t', 'u', null, 'preview', 'o', { vat: 8, series: 's' });
  assert.equal(a, proformaRequestHash('t', 'u', null, 'preview', 'o', { series: 's', vat: 8 }));
  assert.notEqual(a, proformaRequestHash('t', 'v', null, 'preview', 'o', { vat: 8, series: 's' }));
  assert.notEqual(a, proformaRequestHash('t', 'u', 'key', 'preview', 'o', { vat: 8, series: 's' }));
  assert.notEqual(a, proformaRequestHash('t', 'u', null, 'issue', 'o', { vat: 8, series: 's' }));
});

test('native print escapes buyer and seller and preserves frozen cents', () => {
  const html = documentBody({
    kind: 'proforma',
    mode: 'local',
    number: 'PF/2026/000001',
    data: {
      currency: 'PLN',
      seller: {
        name: '<script>seller</script>',
        street: 'Test',
        city: 'City',
        postal_code: '00-000',
        country: 'PL',
      },
      buyer: {
        name: 'Buyer & company',
        email: 'qa@example.test',
        address: { street: 'Test', city: 'City', postal_code: '00-000', country: 'PL' },
      },
      order: { number: 'ORDER' },
      issue_date: '2026-10-06',
      due_date: '2026-10-20',
      lines: [
        {
          name: 'Frozen <item>',
          quantity: 1,
          vat_rate: 0,
          net_minor: '9007199254740993',
          vat_minor: '0',
          gross_minor: '9007199254740993',
        },
      ],
      totals: { net_minor: '9007199254740993', vat_minor: '0', gross_minor: '9007199254740993' },
    },
  });
  assert.match(html, /&lt;script&gt;seller&lt;\/script&gt;/);
  assert.match(html, /Buyer &amp; company/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /,93/);
  assert.match(html, /Pro forma PF\/2026\/000001/);
});

test('existing correction print keeps its negative historical amounts', () => {
  const html = documentBody({
    kind: 'correction',
    mode: 'demo',
    number: 'KOR',
    data: {
      currency: 'PLN',
      seller: 'Seller',
      customer: 'Buyer',
      items: [{ name: 'Item', quantity: 1, vat: 23, gross: 12345 }],
      shipping_cost: 0,
      total: -12345,
      original: { number: 'FV' },
    },
  });
  assert.match(html, /-123,45/);
  assert.match(html, /Korekta do: FV/);
});
