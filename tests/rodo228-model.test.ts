/** 228 RODO rules without a database: retention dates (incl. the December rule), tax point,
 * field classification, refusal for open business, identifiers, JSON scrub, CSV and ZIP. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { Problem } from '../server/errors';
import {
  ANON_NAME, ORDER_FIELDS, addDays, anonEmail, assertAnonymisable, classifyOrderFields, documentTaxPoint, dueOn, evidenceRetentionEnd, exportCsv, isAnonEmail,
  needlesOf, normalPhone, scrubJson, subjectHash, subjectInput, taxRetentionEnd, zipStore,
} from '../server/rodo228-model';

test('tax retention: 5 years from the end of the year in which the VAT was due (25th of the next month)', () => {
  assert.equal(taxRetentionEnd('2026-01-01'), '2031-12-31');
  assert.equal(taxRetentionEnd('2026-06-15'), '2031-12-31');
  assert.equal(taxRetentionEnd('2026-11-30'), '2031-12-31');
  // December: VAT due on 25 January of the next year, so the retention runs a year longer.
  assert.equal(taxRetentionEnd('2026-12-01'), '2032-12-31');
  assert.equal(taxRetentionEnd('2026-12-31'), '2032-12-31');
  assert.equal(taxRetentionEnd('2020-02-29'), '2025-12-31');
  assert.equal(dueOn('2031-12-31'), '2032-01-01');
  assert.equal(dueOn('2032-12-31'), '2033-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.throws(() => taxRetentionEnd('31.12.2026'), Problem);
});
test('evidence retention: 6 years, end of the year (art. 118 KC)', () => {
  assert.equal(evidenceRetentionEnd('2026-10-23'), '2032-12-31');
  assert.equal(evidenceRetentionEnd('2026-01-01'), '2032-12-31');
});
test('tax point: sale date, the earlier issue date, otherwise the creation day in Warsaw', () => {
  assert.equal(documentTaxPoint({ sell_date: '2026-10-17', issue_date: '2026-10-17' }, '2026-10-17T10:00:00Z'), '2026-10-17');
  assert.equal(documentTaxPoint({ sell_date: '2026-12-31', issue_date: '2027-01-05' }, '2027-01-05T10:00:00Z'), '2026-12-31');
  assert.equal(documentTaxPoint({ sell_date: '2027-01-05', issue_date: '2026-12-30' }, '2026-12-30T10:00:00Z'), '2026-12-30');
  assert.equal(documentTaxPoint({ issue_date: '2026-10-08', sale_date: null }, '2026-10-08T05:00:00Z'), '2026-10-08');
  // Demo documents without dates: 31.12 at 23:30 UTC is already 1 January in Warsaw.
  assert.equal(documentTaxPoint({}, new Date('2026-12-31T23:30:00Z')), '2027-01-01');
  assert.equal(taxRetentionEnd(documentTaxPoint({}, new Date('2026-12-31T22:30:00Z'))), '2032-12-31');
});
test('order fields: invoiced order in retention keeps the invoice buyer, everything else is anonymised', () => {
  const kept = classifyOrderFields('2031-12-31', '2026-10-23');
  assert.equal(kept.retained, true);
  assert.deepEqual(kept.keep, [...ORDER_FIELDS.invoice_buyer]);
  assert.deepEqual(kept.anonymise, [...ORDER_FIELDS.contact]);
  assert(kept.anonymise.includes('email') && kept.anonymise.includes('address.phone') && kept.anonymise.includes('note'));
  for (const none of [null, '2025-12-31']) {
    const c = classifyOrderFields(none, '2026-10-23');
    assert.equal(c.retained, false); assert.deepEqual(c.keep, []);
    assert.deepEqual(c.anonymise, [...ORDER_FIELDS.invoice_buyer, ...ORDER_FIELDS.contact]);
  }
  // The last day of the retention still keeps the data; the due day does not.
  assert.equal(classifyOrderFields('2031-12-31', '2031-12-31').retained, true);
  assert.equal(classifyOrderFields('2031-12-31', '2032-01-01').retained, false);
});
test('refusal: open orders, open returns and unsettled payments give 409 with a Polish reason', () => {
  const none = { openOrders: [], openReturns: [], unsettled: [] };
  assert.doesNotThrow(() => assertAnonymisable(none));
  const refused = (b: Parameters<typeof assertAnonymisable>[0], re: RegExp) => assert.throws(() => assertAnonymisable(b), (e: any) => e instanceof Problem && e.status === 409 && re.test(e.message));
  refused({ ...none, openOrders: [{ number: 'ZAM-1', status: 'shipped' }] }, /otwarte zamówienia: ZAM-1 \(wysłane\)/);
  refused({ ...none, openReturns: [{ number: 'ZW-1', state: 'refund_pending' }] }, /otwarte zwroty: ZW-1 \(czeka na zwrot pieniędzy\)/);
  refused({ ...none, unsettled: [{ number: 'ZAM-2', amount_due: '100', overpayment: '0', courier_due: '0' }] }, /nierozliczone płatności w zamówieniach: ZAM-2/);
  refused({ ...none, openOrders: Array.from({ length: 7 }, (_, i) => ({ number: 'Z' + i, status: 'new' })) }, /i 2 więcej/);
});
test('customer identifiers: one of crm id, e-mail or phone; phones compare on 9 digits; keyed hash', () => {
  assert.deepEqual(subjectInput.parse({ email: ' Jan@Example.COM ' }), { email: 'jan@example.com' });
  assert.deepEqual(subjectInput.parse({ phone: '+48 500-600-700' }), { phone: '500600700' });
  assert.equal(normalPhone('0048500600700'), '500600700');
  for (const bad of [{}, { email: 'x' }, { phone: '12' }, { email: 'a@b.pl', phone: '500600700' }, { crm_client_id: 'nope' }]) assert.throws(() => subjectInput.parse(bad));
  const h = subjectHash('k', 't', 'email', 'jan@example.com');
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.notEqual(h, subjectHash('k2', 't', 'email', 'jan@example.com'));
  assert.notEqual(h, subjectHash('k', 't2', 'email', 'jan@example.com'));
  assert.equal(isAnonEmail(anonEmail('34ce6b82-075b-44d9-9bb8-175131ddfa37')), true);
});
test('scrub: known values removed from free JSON case-insensitively, short and anonymised values ignored', () => {
  const needles = needlesOf(['Jan Kowalski', 'jan@example.com', '500600700', 'ab', ANON_NAME, anonEmail('aaaaaaaa-0000')]);
  assert.deepEqual(needles, ['jan@example.com', 'Jan Kowalski', '500600700']);
  const v = scrubJson({ billing: { first_name: 'Jan', email: 'JAN@example.com', note: 'Dzwonić: 500600700, Jan Kowalski' }, total: 5, list: ['x', 'jan kowalski'] }, needles);
  assert.equal(v.changed, true);
  assert.deepEqual(v.value, { billing: { first_name: 'Jan', email: '[zanonimizowano]', note: 'Dzwonić: [zanonimizowano], [zanonimizowano]' }, total: 5, list: ['x', '[zanonimizowano]'] });
  assert.equal(scrubJson({ a: 'inne dane' }, needles).changed, false);
  assert.equal(scrubJson({ a: 'x' }, []).changed, false);
  assert.equal(scrubJson({ a: 'a.b' }, needlesOf(['a.b.c.d'])).changed, false);
});
test('CSV: one row per value, formula cells neutralised, BOM and semicolons', () => {
  const csv = exportCsv({ zamowienia: [{ id: 'o1', klient: '=HYPERLINK("x")', adres: { ulica: 'Długa 5; m. 2' }, pozycje: [{ sku: 'A' }] }], informacje: { podstawa: 'art. 15' } });
  assert(csv.startsWith('﻿sekcja;rekord;pole;wartosc\r\n'));
  assert(csv.includes('zamowienia;o1;klient;"\'=HYPERLINK(""x"")"'));
  assert(csv.includes('zamowienia;o1;adres.ulica;"Długa 5; m. 2"'));
  assert(csv.includes('zamowienia;o1;pozycje[0].sku;A'));
  assert(csv.includes('informacje;1;podstawa;art. 15'));
});
test('ZIP: stored entries with names, sizes and CRC readable from the central directory', () => {
  const a = Buffer.from('{"a":1}'), b = Buffer.from('ż;ó\r\n'), zip = zipStore([{ name: 'dane-klienta.json', data: a }, { name: 'dane-klienta.csv', data: b }], new Date('2026-10-23T10:00:00Z'));
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50); assert.equal(zip.readUInt16LE(end + 10), 2);
  let p = zip.readUInt32LE(end + 16);
  for (const [name, data] of [['dane-klienta.json', a], ['dane-klienta.csv', b]] as const) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50);
    const n = zip.readUInt16LE(p + 28), off = zip.readUInt32LE(p + 42);
    assert.equal(zip.subarray(p + 46, p + 46 + n).toString(), name);
    assert.equal(zip.readUInt32LE(p + 16), crc32(data)); assert.equal(zip.readUInt32LE(p + 24), data.length);
    assert.equal(zip.readUInt32LE(off), 0x04034b50);
    const ln = zip.readUInt16LE(off + 26);
    assert.deepEqual(zip.subarray(off + 30 + ln, off + 30 + ln + data.length), data);
    p += 46 + n;
  }
});
