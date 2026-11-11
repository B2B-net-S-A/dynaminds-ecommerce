/** Pure rules of migration 243 (docs/parity/KSEF-PURCHASE243-20261027.md): retention end, the next run of the
 * fetch job, the settings / list / workflow inputs with their refusals, the parametrised list filter and cursor,
 * KOR re-linking when the original arrives after the correction, and the accountant's CSV. No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KSEF20_START, PURCHASE_PERIOD_MS, decodePurchaseCursor, encodePurchaseCursor, nextPurchaseRunDelayMs, purchaseCsv, purchaseInvoicePatch, purchaseListQuery,
  purchaseListWhere, purchaseRetainUntil, purchaseStatusChange, purchaseSyncInput, relinkPurchaseCorrections, storedPurchaseMeta, subjectNips,
} from '../server/ksef243-model';
import { parsePurchaseMetadata, parsePurchaseMetadataPage, parseReceivedFa3 } from '../server/ksef-purchase-model';
import { receivedFa3 } from './ksef-purchase-fixtures';

test('retention end is 31.12 of the issue year + 6, also for a December invoice', () => {
  assert.equal(purchaseRetainUntil('2026-02-01'), '2032-12-31');
  assert.equal(purchaseRetainUntil('2026-12-31'), '2032-12-31');
  assert.equal(purchaseRetainUntil('2027-01-01'), '2033-12-31');
  assert.throws(() => purchaseRetainUntil('2026-13-01'));
});

test('next run: 30 min after a complete run, immediately after a partial one, Retry-After when limited, capped backoff on failures, none when disabled', () => {
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'ok', failures: 0 }), PURCHASE_PERIOD_MS);
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'partial', failures: 0 }), 5_000);
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'rate_limited', retryAfterMs: 120_000, failures: 0 }), 120_000);
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'rate_limited', retryAfterMs: null, failures: 0 }), 60_000);
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'rate_limited', retryAfterMs: 10, failures: 0 }), 10_000, 'never a tight loop');
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'unavailable', failures: 0 }), 60_000);
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'unavailable', failures: 3 }), 480_000);
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'error', failures: 40 }), PURCHASE_PERIOD_MS, 'backoff capped at the period');
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'busy', failures: 0 }), 60_000);
  assert.equal(nextPurchaseRunDelayMs({ outcome: 'disabled', failures: 0 }), null);
});

test('settings input: a date type, a start not before KSeF 2.0 and not in the future; nothing else', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  assert.deepEqual(purchaseSyncInput(now).parse({ enabled: true, date_type: 'PermanentStorage', start_from: '2026-10-01T00:00:00Z' }),
    { enabled: true, date_type: 'PermanentStorage', start_from: '2026-10-01T00:00:00.000Z' });
  for (const bad of [
    { enabled: true, date_type: 'Acquisition', start_from: '2026-10-01T00:00:00Z' },
    { enabled: true, date_type: 'Issue', start_from: '2025-12-31T00:00:00Z' },
    { enabled: true, date_type: 'Issue', start_from: '2026-10-28T00:00:00Z' },
    { enabled: true, date_type: 'Issue', start_from: '2026-10-01' },
    { enabled: true, date_type: 'Issue', start_from: '2026-10-01T00:00:00Z', token: 'x' },
    { enabled: 'yes', date_type: 'Issue', start_from: '2026-10-01T00:00:00Z' },
  ]) assert.equal(purchaseSyncInput(now).safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(KSEF20_START, '2026-02-01T00:00:00.000Z');
});

test('workflow: a booked invoice is reopened only by an administrator, the legal hold too; a stale or empty patch is refused', () => {
  assert.equal(purchaseStatusChange('new', 'accepted', 'operator'), null);
  assert.equal(purchaseStatusChange('accepted', 'booked', 'operator'), null);
  assert.match(purchaseStatusChange('booked', 'accepted', 'operator')!, /administrator/);
  assert.equal(purchaseStatusChange('booked', 'accepted', 'admin'), null);
  assert.match(purchaseStatusChange('new', 'new', 'admin')!, /już/);
  assert.equal(purchaseInvoicePatch.safeParse({ version: 1 }).success, false, 'nothing to change');
  assert.equal(purchaseInvoicePatch.safeParse({ version: 0, status: 'booked' }).success, false);
  assert.equal(purchaseInvoicePatch.safeParse({ version: 1, status: 'paid' }).success, false);
  assert.equal(purchaseInvoicePatch.safeParse({ version: 1, note: 'x'.repeat(2001) }).success, false);
  assert.equal(purchaseInvoicePatch.safeParse({ version: 1, xml: '<x/>' }).success, false, 'KSeF data is not editable');
  assert.deepEqual(purchaseInvoicePatch.parse({ version: 2, status: 'booked', accounting_ref: ' KS/10/2026/17 ', note: null }), { version: 2, status: 'booked', accounting_ref: 'KS/10/2026/17', note: null });
});

test('list filter: every value is a parameter, the cursor is the (issue date, id) keyset; bad filters are refused', () => {
  const q = purchaseListQuery.parse({ nip: '1234563218', seller: "Hurtownia'; DROP TABLE x;--", status: 'new', kind: 'KOR', from: '2026-10-01', to: '2026-10-31', q: 'FZ/1', limit: '20' });
  const w = purchaseListWhere(q);
  assert.doesNotMatch(w.sql, /Hurtownia|DROP|FZ\/1|1234563218|2026-10/, 'no value is spliced into the SQL');
  assert.equal(w.params.length, 7);
  assert.ok(w.params.includes('%Hurtownia\'; DROP TABLE x;--%'));
  const cursor = encodePurchaseCursor('2026-10-20', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  const p = purchaseListWhere(purchaseListQuery.parse({ before: cursor }));
  assert.match(p.sql, /\(issue_date,id\)<\(\$1::date,\$2::uuid\)/);
  assert.deepEqual(decodePurchaseCursor(cursor), { issueDate: '2026-10-20', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  for (const bad of [{ q: 'a\u0000b' }, { seller: '\u0000' }, { limit: '0' }, { limit: '201' }, { from: '2026-10-31', to: '2026-10-01' }, { nip: '123' }, { before: 'x' }, { kind: 'FOO' }, { extra: '1' }, { seller: 'x'.repeat(101) }])
    assert.equal(purchaseListQuery.safeParse(bad).success, false, JSON.stringify(bad));
  assert.match(purchaseListWhere(purchaseListQuery.parse({ seller: '50%_\\' })).params[0] as string, /^%50\\%\\_\\\\%$/, 'LIKE wildcards escaped');
});

test('KOR re-linking: an open reference resolves when the original arrives later; another seller never; two candidates are ambiguous', () => {
  const kor = { id: 'k1', sellerNip: '5260250995', refs: [
    { ordinal: 1, invoiceNumber: 'FZ/1/10/2026', issueDate: '2026-10-20', ksefNumber: null },
    { ordinal: 2, invoiceNumber: 'FZ/2/10/2026', issueDate: '2026-10-21', ksefNumber: '5260250995-20261021-0123456789AB-00' },
    { ordinal: 3, invoiceNumber: 'FZ/3/10/2026', issueDate: '2026-10-22', ksefNumber: null },
  ] };
  const known = [
    { id: 'o1', ksefNumber: '5260250995-20261020-AAAAAAAAAAAA-00', sellerNip: '5260250995', invoiceNumber: 'FZ/1/10/2026', issueDate: '2026-10-20' },
    { id: 'o2', ksefNumber: '5260250995-20261021-0123456789AB-00', sellerNip: '7740001454', invoiceNumber: 'FZ/2/10/2026', issueDate: '2026-10-21' },
    { id: 'o3', ksefNumber: '5260250995-20261022-BBBBBBBBBBBB-00', sellerNip: '5260250995', invoiceNumber: 'FZ/3/10/2026', issueDate: '2026-10-22' },
    { id: 'o4', ksefNumber: '5260250995-20261022-CCCCCCCCCCCC-00', sellerNip: '5260250995', invoiceNumber: 'FZ/3/10/2026', issueDate: '2026-10-22' },
  ];
  assert.deepEqual(relinkPurchaseCorrections([kor], known), [
    { correctionId: 'k1', ordinal: 1, resolvedInvoiceId: 'o1', by: 'invoice_number', problem: null },
    { correctionId: 'k1', ordinal: 2, resolvedInvoiceId: null, by: null, problem: 'seller_mismatch' },
    { correctionId: 'k1', ordinal: 3, resolvedInvoiceId: null, by: null, problem: 'ambiguous' },
  ]);
  assert.deepEqual(relinkPurchaseCorrections([kor], []), [], 'nothing found: nothing to write');
});

test('CSV for the accountant: BOM, ";" separators, decimal comma, formula cells neutralised but negative amounts kept', () => {
  const csv = purchaseCsv([{ ksef_number: '5260250995-20261020-AAAAAAAAAAAA-00', invoice_number: '=HYPERLINK("x")', fa3_kind: 'KOR', issue_date: '2026-10-20', sale_date: null,
    seller_nip: '5260250995', seller_name: 'Hurtownia; "Test"', buyer_nip: '1234563218', currency: 'PLN', net_total: -100050, vat_total: -23012, gross_total: -123062,
    payment_due_date: '2026-11-03', split_payment: true, status: 'booked', accounting_ref: null, retain_until: '2032-12-31' }]);
  assert.ok(csv.startsWith('﻿Numer KSeF;Numer faktury;Rodzaj;'));
  const line = csv.split('\r\n')[1]!;
  assert.match(line, /;"'=HYPERLINK\(""x""\)";/);
  assert.match(line, /;"Hurtownia; ""Test""";/);
  assert.match(line, /;-1000,50;-230,12;-1230,62;/);
  assert.match(line, /;tak;Zaksięgowana;;2032-12-31$/);
});

test('RODO subject NIPs: only valid 10-digit NIPs from the CRM invoice data, with or without PL and separators', () => {
  assert.deepEqual(subjectNips([{ profile: { invoice_tax_id: 'PL 526-025-09-95' } }, { profile: { invoice_tax_id: '1234567890' } }, { profile: {} }, { profile: { invoice_tax_id: '5260250995' } }]), ['5260250995']);
});

test('a refused file keeps its listing entry in KSeF form, read back unchanged for "Pobierz ponownie"; long texts are cut', () => {
  const wire = { ksefNumber: '5260250995-20261022-1049F4535AD2-B8', invoiceNumber: 'FZ/1', issueDate: '2026-10-20', invoicingDate: '2026-10-20T10:00:00Z', permanentStorageDate: '2026-10-20T10:00:01Z',
    seller: { nip: '5260250995', name: 'Hurtownia' }, buyer: { identifier: { type: 'Nip', value: '1234563218' }, name: 'Sklep' }, grossAmount: 12.3, currency: 'PLN', invoiceType: 'Vat', invoiceHash: 'A'.repeat(43) + '=' };
  const m = parsePurchaseMetadata(wire);
  assert.deepEqual(parsePurchaseMetadata(JSON.parse(JSON.stringify(storedPurchaseMeta(m)))), m);
  const long = storedPurchaseMeta(parsePurchaseMetadata({ ...wire, buyer: { identifier: { type: 'Other', value: 'x'.repeat(5000) }, name: 'y'.repeat(500) } }));
  assert.ok(JSON.stringify(long).length < 2000);
});

const WIRE = { ksefNumber: '5260250995-20261022-1049F4535AD2-B8', invoiceNumber: 'FZ/1', issueDate: '2026-10-20', invoicingDate: '2026-10-20T10:00:00Z', permanentStorageDate: '2026-10-20T10:00:01Z',
  seller: { nip: '5260250995', name: 'Hurtownia' }, buyer: { identifier: { type: 'Nip', value: '1234563218' } }, grossAmount: 12.3, currency: 'PLN', invoiceType: 'Vat', invoiceHash: 'A'.repeat(43) + '=' };
test('listing entries (review M1): FA(3)-legal 16-digit amounts and texts counted in characters pass; another bad entry is marked, not fatal for the page', () => {
  const page = (...e: object[]) => parsePurchaseMetadataPage({ hasMore: false, invoices: e });
  const big = page({ ...WIRE, grossAmount: 5e15, netAmount: 8e15 }).invoices[0]!;
  assert.equal(big.problem, undefined); assert.equal(big.grossAmount, null, 'an amount beyond a safe double is not kept'); assert.equal(big.netAmount, null);
  assert.equal(page({ ...WIRE, grossAmount: 1e15 }).invoices[0]!.problem, undefined);
  const emoji = page({ ...WIRE, invoiceNumber: '😀'.repeat(200), seller: { nip: '5260250995', name: '😀'.repeat(300) } }).invoices[0]!;
  assert.equal(emoji.problem, undefined); assert.equal([...emoji.invoiceNumber].length, 200); assert.equal([...emoji.sellerName!].length, 300);
  const bad = page(WIRE, { ...WIRE, ksefNumber: '5260250995-20261012-24A63947DEB6-BB', currency: 'pln' }).invoices;
  assert.equal(bad[0]!.problem, undefined);
  assert.equal(bad[1]!.problem?.code, 'metadata'); assert.match(bad[1]!.problem!.reason, /waluta/);
  assert.equal(bad[1]!.ksefNumber, '5260250995-20261012-24A63947DEB6-BB'); assert.equal(bad[1]!.permanentStorageDate, WIRE.permanentStorageDate, 'its date still places the checkpoint');
  assert.throws(() => page({ ...WIRE, ksefNumber: 'zły' }), /numer KSeF/, 'an entry that cannot be identified still refuses the page');
  assert.throws(() => page({ ...WIRE, invoicingDate: 'wczoraj' }), /data przyjęcia/, 'nor one that cannot be placed');
  const feb30 = page({ ...WIRE, issueDate: '2026-02-30' }).invoices[0]!;
  assert.equal(feb30.problem?.code, 'metadata'); assert.equal(feb30.issueDate, '2026-10-20', 'placed by its acceptance day');
  assert.equal(parsePurchaseMetadata({ ...WIRE, seller: { nip: '5260250995', name: 'N'.repeat(513) } }).problem?.code, 'metadata');
});
test('a 200-character emoji invoice number is a valid FA(3) value; NUL never reaches the stored listing entry or a workflow text', () => {
  assert.equal([...parseReceivedFa3(receivedFa3({ number: '😀'.repeat(200) })).invoiceNumber].length, 200);
  assert.equal(JSON.stringify(storedPurchaseMeta(parsePurchaseMetadata({ ...WIRE, seller: { nip: '5260250995', name: 'Hurt\u0000ownia' } }))).includes('\\u0000'), false);
  assert.equal(purchaseInvoicePatch.safeParse({ version: 1, note: 'a\u0000b' }).success, false);
  assert.equal(purchaseInvoicePatch.safeParse({ version: 1, accounting_ref: 'a\u0000b' }).success, false);
  assert.equal(purchaseInvoicePatch.safeParse({ version: 1, note: 'a\ud800' }).success, false, 'a lone surrogate');
});
