/** Pure rules of the KSeF purchase side: strict FA(3) reader (DTD/XXE, PI, encoding, limits refused),
 * extraction (seller, numbers, dates, totals per rate, KOR references), metadata checks, KOR linking,
 * checkpoint paging with overlaps/duplicates/same-date groups and restart, backoff, ZIP limits. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { makeKsefNumber, sha256Base64 } from '../server/ksef229-crypto';
import { zipStore } from '../server/rodo228-model';
import {
  KsefPurchaseDataError, advanceAfterExport, advancePurchaseCheckpoint, amountMinor, checkReceivedAgainstMetadata, initialPurchaseCheckpoint, linkCorrection,
  parsePurchaseCheckpoint, parsePurchaseMetadataPage, parsePurchasePackage, parsePurchaseXml, parseReceivedFa3, purchaseQuery, purchaseRetryDelayMs, readPurchaseZip,
  startPurchaseWindow, type PurchaseCheckpoint, type PurchaseMetadata, type PurchaseMetadataPage,
} from '../server/ksef-purchase-model';
import { BUYER, OTHER_SELLER, SELLER, receivedFa3 } from './ksef-purchase-fixtures';

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { assert.ok(e instanceof KsefPurchaseDataError, String(e)); return e.code; } return assert.fail('expected a refusal'); };
let seq = 0;
const nr = (seller = SELLER, day = '20261020') => makeKsefNumber(seller, day, (++seq).toString(16).padStart(12, '0'));
const meta = (at: string, o: Partial<PurchaseMetadata> = {}): PurchaseMetadata => ({
  ksefNumber: nr(), invoiceNumber: `FZ/${seq}`, issueDate: at.slice(0, 10), invoicingDate: at, acquisitionDate: at, permanentStorageDate: at, sellerNip: SELLER, sellerName: 'S',
  buyerIdentifier: { type: 'Nip', value: BUYER }, buyerName: 'B', netAmount: 1, vatAmount: 0, grossAmount: 1, currency: 'PLN', invoiceType: 'Vat', invoicingMode: 'Online',
  hasAttachment: false, isSelfInvoicing: false, invoiceHash: sha256Base64(Buffer.from(String(seq))), ...o });
const page = (invoices: PurchaseMetadata[], hasMore: boolean, o: Partial<PurchaseMetadataPage> = {}): PurchaseMetadataPage => ({ hasMore, isTruncated: false, permanentStorageHwmDate: null, invoices, ...o });

test('FA(3) of a received invoice: seller, buyer, numbers, dates, currency, totals per rate in minor units, annotations', () => {
  const p = parseReceivedFa3(receivedFa3());
  assert.deepEqual(p.formCode, { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' });
  assert.deepEqual(p.seller, { nip: SELLER, name: 'Hurtownia Testowa sp. z o.o.' });
  assert.equal(p.buyer.nip, BUYER);
  assert.equal(p.invoiceNumber, 'FZ/1/10/2026'); assert.equal(p.issueDate, '2026-10-20'); assert.equal(p.saleDate, '2026-10-19'); assert.equal(p.currency, 'PLN'); assert.equal(p.kind, 'VAT');
  assert.deepEqual(p.rates, [{ code: '23', net: 100000, vat: 23000, vatPln: null }, { code: '8', net: 10050, vat: 804, vatPln: null }, { code: 'zw', net: 5000, vat: null, vatPln: null }]);
  assert.equal(p.netTotal, 115050); assert.equal(p.vatTotal, 23804); assert.equal(p.grossTotal, 138854);
  assert.equal(p.splitPayment, true); assert.equal(p.cashMethod, false); assert.equal(p.reverseCharge, false); assert.equal(p.paymentDueDate, '2026-11-03'); assert.equal(p.correction, null);
  assert.equal(amountMinor('-12.5'), -1250); assert.equal(code(() => amountMinor('1.234')), 'fa3_value'); assert.equal(code(() => amountMinor('1e3')), 'fa3_value');
  const eur = parseReceivedFa3(receivedFa3({ currency: 'EUR', extraFa: '' }).toString().replace('<P_14_1>230.00</P_14_1>', '<P_14_1>230.00</P_14_1><P_14_1W>975.20</P_14_1W>'));
  assert.equal(eur.currency, 'EUR'); assert.deepEqual(eur.rates[0], { code: '23', net: 100000, vat: 23000, vatPln: 97520 });
});

test('malformed or hostile XML is refused: DTD/XXE, entities, PI, non-UTF-8, size, depth, not FA(3), duplicates, bad values', () => {
  const good = receivedFa3().toString();
  assert.equal(code(() => parsePurchaseXml(`<!DOCTYPE Faktura [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${good.replace('<?xml version="1.0" encoding="UTF-8"?>', '').replace('FZ/1/10/2026', '&xxe;')}`)), 'xml_dtd');
  assert.equal(code(() => parsePurchaseXml(good.replace('FZ/1/10/2026', '&xxe;'))), 'xml_syntax');
  assert.equal(code(() => parsePurchaseXml(good.replace('<Naglowek>', '<?php echo 1?><Naglowek>'))), 'xml_pi');
  assert.equal(code(() => parsePurchaseXml(good.replace('encoding="UTF-8"', 'encoding="ISO-8859-2"'))), 'xml_encoding');
  assert.equal(code(() => parsePurchaseXml(Buffer.from([0x3c, 0x61, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x61, 0x3e]))), 'xml_encoding');
  assert.equal(code(() => parsePurchaseXml(good, { maxBytes: 100 })), 'xml_size');
  assert.equal(code(() => parsePurchaseXml(`${'<a>'.repeat(30)}${'</a>'.repeat(30)}`)), 'xml_limits');
  assert.equal(code(() => parsePurchaseXml(good.slice(0, -20))), 'xml_syntax');
  assert.equal(code(() => parsePurchaseXml('')), 'xml_empty');
  assert.equal(code(() => parseReceivedFa3(good.replace('http://crd.gov.pl/wzor/2025/06/25/13775/', 'http://crd.gov.pl/wzor/2023/06/29/12648/'))), 'not_fa3');
  assert.equal(code(() => parseReceivedFa3(good.replace('kodSystemowy="FA (3)"', 'kodSystemowy="FA (2)"'))), 'not_fa3');
  assert.equal(code(() => parseReceivedFa3(good.replace('<P_15>', '<P_2>X</P_2><P_15>'))), 'fa3_structure');
  assert.equal(code(() => parseReceivedFa3(receivedFa3({ seller: '1234567890' }))), 'fa3_value');
  assert.equal(code(() => parseReceivedFa3(receivedFa3({ date: '2026-02-30' }))), 'fa3_value');
  assert.equal(code(() => parseReceivedFa3(receivedFa3({ kind: 'XYZ' }))), 'fa3_value');
  assert.equal(code(() => parseReceivedFa3(good.replace('<P_15>1388.54</P_15>', ''))), 'fa3_structure');
  assert.ok(parseReceivedFa3(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), receivedFa3()])), 'a UTF-8 BOM is accepted');
});

test('KOR: references with and without KSeF number; linking by KSeF number or seller + number + date, never across sellers', () => {
  const orig = nr(), other = nr(OTHER_SELLER);
  const kor = parseReceivedFa3(receivedFa3({ kind: 'KOR', number: 'FZK/1', korRefs: [{ number: 'FZ/1/10/2026', date: '2026-10-20', ksef: orig }, { number: 'FZ/0/09/2026', date: '2026-09-30' }] }));
  assert.equal(kor.kind, 'KOR'); assert.equal(kor.correction?.reason, 'Rabat posprzedażowy'); assert.equal(kor.correction?.type, 1);
  assert.deepEqual(kor.correction?.corrected, [{ invoiceNumber: 'FZ/1/10/2026', issueDate: '2026-10-20', ksefNumber: orig }, { invoiceNumber: 'FZ/0/09/2026', issueDate: '2026-09-30', ksefNumber: null }]);
  const known = [{ ksefNumber: orig, sellerNip: SELLER, invoiceNumber: 'FZ/1/10/2026', issueDate: '2026-10-20' }, { ksefNumber: nr(), sellerNip: SELLER, invoiceNumber: 'FZ/0/09/2026', issueDate: '2026-09-30' }];
  const links = linkCorrection({ sellerNip: SELLER, parsed: kor }, known);
  assert.deepEqual(links.map(l => [l.resolvedKsefNumber, l.by, l.problem]), [[orig, 'ksef_number', null], [known[1]!.ksefNumber, 'invoice_number', null]]);
  assert.deepEqual(linkCorrection({ sellerNip: SELLER, parsed: kor }, []).map(l => [l.resolvedKsefNumber, l.by]), [[null, null], [null, null]], 'the original may arrive later');
  const foreign = parseReceivedFa3(receivedFa3({ kind: 'KOR', korRefs: [{ number: 'X/1', date: '2026-10-01', ksef: other }] }));
  assert.equal(linkCorrection({ sellerNip: SELLER, parsed: foreign }, [{ ksefNumber: other, sellerNip: OTHER_SELLER, invoiceNumber: 'X/1', issueDate: '2026-10-01' }])[0]!.problem, 'seller_mismatch');
  const twice = [{ ...known[1]!, ksefNumber: nr() }, known[1]!];
  assert.equal(linkCorrection({ sellerNip: SELLER, parsed: kor }, twice)[1]!.problem, 'ambiguous');
  assert.equal(code(() => parseReceivedFa3(receivedFa3({ kind: 'KOR' }))), 'fa3_structure');
  assert.equal(code(() => parseReceivedFa3(receivedFa3({ kind: 'KOR', korRefs: [{ number: 'A', date: '2026-10-01', ksef: `${SELLER}-20261020-000000000001-00` }] }))), 'fa3_value');
});

test('metadata page checks and file-vs-metadata checks (hash, seller, number, buyer)', () => {
  const xml = receivedFa3(), parsed = parseReceivedFa3(xml), m = meta('2026-10-20T10:00:00.000Z', { invoiceNumber: 'FZ/1/10/2026', issueDate: '2026-10-20', invoiceHash: sha256Base64(xml) });
  checkReceivedAgainstMetadata(BUYER, m, xml, parsed);
  assert.equal(code(() => checkReceivedAgainstMetadata(BUYER, { ...m, invoiceHash: sha256Base64(Buffer.from('x')) }, xml, parsed)), 'hash_mismatch');
  assert.equal(code(() => checkReceivedAgainstMetadata(BUYER, { ...m, sellerNip: OTHER_SELLER }, xml, parsed)), 'metadata_mismatch');
  assert.equal(code(() => checkReceivedAgainstMetadata(OTHER_SELLER, m, xml, parsed)), 'buyer_mismatch');
  const raw = { hasMore: false, invoices: [{ ...m, seller: { nip: SELLER, name: 'S' }, buyer: { identifier: { type: 'Nip', value: BUYER } } }] };
  assert.equal(parsePurchaseMetadataPage(raw).invoices[0]!.ksefNumber, m.ksefNumber);
  // An entry that cannot be identified or placed refuses the page; an identifiable one is marked (243 review M1).
  for (const broken of [{ ksefNumber: 'X' }, { invoiceHash: 'abc' }, { invoicingDate: '2026-10-20' }])
    assert.equal(code(() => parsePurchaseMetadataPage({ ...raw, invoices: [{ ...raw.invoices[0], ...broken }] })), 'metadata');
  for (const broken of [{ currency: 'zł' }, { invoiceType: 'Faktura' }])
    assert.equal(parsePurchaseMetadataPage({ ...raw, invoices: [{ ...raw.invoices[0], ...broken }] }).invoices[0]!.problem?.code, 'metadata');
  assert.equal(code(() => parsePurchaseMetadataPage({ invoices: [] })), 'metadata');
});

test('checkpoint: page boundary splitting a same-date group re-reads, never skips; duplicates and overlaps filtered; HWM bounds the window', () => {
  let cp: PurchaseCheckpoint = startPurchaseWindow(initialPurchaseCheckpoint(BUYER, '2026-10-01T00:00:00.000Z'), '2026-10-26T12:00:00.000Z')!;
  assert.deepEqual(purchaseQuery(cp, 10), { subjectType: 'Subject2', dateRange: { dateType: 'PermanentStorage', from: '2026-10-01T00:00:00.000Z', to: '2026-10-26T12:00:00.000Z', restrictToPermanentStorageHwmDate: true }, pageOffset: 0, pageSize: 10, sortOrder: 'Asc' });
  const t1 = '2026-10-05T08:00:00.000Z', t2 = '2026-10-06T08:00:00.000Z';
  const a = [meta(t1), meta(t1), meta(t2), meta(t2)], b = [meta(t2), meta('2026-10-07T08:00:00.000Z')];
  let q = purchaseQuery(cp, 10), r = advancePurchaseCheckpoint(cp, q, page(a, true));
  assert.equal(r.fresh.length, 4); assert.equal(r.windowDone, false);
  assert.deepEqual([r.checkpoint.window!.cursorFrom, r.checkpoint.window!.cursorOffset, r.checkpoint.window!.boundary], [t2, 0, [a[2]!.ksefNumber, a[3]!.ksefNumber]]);
  cp = r.checkpoint; q = purchaseQuery(cp, 10);
  assert.equal(q.dateRange.from, t2, 'the next query starts at the last date, inclusive');
  // KSeF answers the two at t2 again plus a third at t2 that sorted between them, and one later.
  r = advancePurchaseCheckpoint(cp, q, page([a[2]!, b[0]!, a[3]!, b[1]!], false, { permanentStorageHwmDate: '2026-10-26T11:00:00.000Z' }));
  assert.deepEqual(r.fresh.map(m => m.ksefNumber), [b[0]!.ksefNumber, b[1]!.ksefNumber]); assert.equal(r.overlap, 2);
  assert.equal(r.windowDone, true); assert.equal(r.checkpoint.window, null);
  assert.equal(r.checkpoint.completedUpTo, '2026-10-26T11:00:00.000Z', 'completed only up to the KSeF high-water mark');
  const next = startPurchaseWindow(r.checkpoint, '2026-10-26T12:30:00.000Z')!;
  assert.equal(next.window!.from, '2026-10-26T11:00:00.000Z', 'the next window starts at the HWM (inclusive)');
  assert.equal(startPurchaseWindow({ ...r.checkpoint, completedUpTo: '2026-10-26T12:30:00.000Z' }, '2026-10-26T12:30:00.000Z'), null);
});

test('checkpoint: a whole page of the same date moves the offset; restart from JSON resumes the same query; a stale or out-of-range page is refused', () => {
  const t = '2026-10-10T10:00:00.000Z';
  let cp = startPurchaseWindow(initialPurchaseCheckpoint(BUYER, t), '2026-10-20T00:00:00.000Z')!;
  const group = Array.from({ length: 10 }, () => meta(t));
  const q = purchaseQuery(cp, 10), r = advancePurchaseCheckpoint(cp, q, page(group, true));
  assert.deepEqual([r.checkpoint.window!.cursorFrom, r.checkpoint.window!.cursorOffset, r.checkpoint.window!.boundary.length], [t, 10, 10]);
  const restored = parsePurchaseCheckpoint(JSON.parse(JSON.stringify(r.checkpoint)));
  assert.deepEqual(restored, r.checkpoint); assert.deepEqual(purchaseQuery(restored, 10), purchaseQuery(r.checkpoint, 10));
  assert.equal(code(() => advancePurchaseCheckpoint(restored, q, page([], false))), 'stale_page', 'a page of an older query is never applied');
  assert.equal(code(() => advancePurchaseCheckpoint(restored, purchaseQuery(restored, 10), page([meta('2026-10-01T00:00:00.000Z')], false))), 'contract');
  assert.equal(code(() => advancePurchaseCheckpoint(restored, purchaseQuery(restored, 10), page([meta('2026-10-12T00:00:00.000Z'), meta('2026-10-11T00:00:00.000Z')], false))), 'contract');
  assert.equal(code(() => advancePurchaseCheckpoint(restored, purchaseQuery(restored, 10), page([], true))), 'contract');
  assert.equal(code(() => advancePurchaseCheckpoint(restored, purchaseQuery(restored, 10), page(group.slice(0, 10), false, { isTruncated: true }))), 'stuck');
  for (const broken of [{ ...restored, version: 2 }, { ...restored, nip: '1234567890' }, { ...restored, window: { ...restored.window!, cursorOffset: -1 } }, { ...restored, window: { ...restored.window!, boundary: ['x'] } }, { ...restored, window: { ...restored.window!, cursorFrom: '2026-11-01T00:00:00.000Z' } }])
    assert.equal(code(() => parsePurchaseCheckpoint(broken)), 'checkpoint');
  cp = startPurchaseWindow(initialPurchaseCheckpoint(BUYER, '2026-01-01T00:00:00.000Z', 'Issue'), '2026-10-26T00:00:00.000Z')!;
  assert.equal(cp.window!.from, '2025-12-18T00:00:00.000Z', 'Issue date windows look back 14 days for late offline invoices');
  assert.equal(Date.parse(cp.window!.to) - Date.parse(cp.window!.from), 90 * 24 * 3600_000, 'a window is at most 90 days');
  assert.equal(purchaseQuery(cp).dateRange.restrictToPermanentStorageHwmDate, undefined);
});

test('export package: truncated package moves the window to its last date; a complete one closes it', () => {
  const cp = startPurchaseWindow(initialPurchaseCheckpoint(BUYER, '2026-10-01T00:00:00.000Z'), '2026-10-26T00:00:00.000Z')!;
  const items = [meta('2026-10-02T00:00:00.000Z'), meta('2026-10-03T00:00:00.000Z')];
  const t = advanceAfterExport(cp, { isTruncated: true, lastDate: '2026-10-03T00:00:00.000Z', hwm: null, invoices: items });
  assert.deepEqual([t.checkpoint.window!.cursorFrom, t.checkpoint.window!.boundary, t.fresh.length], ['2026-10-03T00:00:00.000Z', [items[1]!.ksefNumber], 2]);
  const done = advanceAfterExport(t.checkpoint, { isTruncated: false, lastDate: null, hwm: '2026-10-25T00:00:00.000Z', invoices: [items[1]!] });
  assert.deepEqual([done.windowDone, done.checkpoint.completedUpTo, done.overlap, done.fresh.length], [true, '2026-10-25T00:00:00.000Z', 1, 0]);
});

test('read backoff: Retry-After seconds or HTTP date, else exponential with jitter, capped', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  assert.equal(purchaseRetryDelayMs(1, '7', now), 7000);
  assert.equal(purchaseRetryDelayMs(1, new Date(now + 3000).toUTCString(), now), 3000);
  assert.deepEqual([1, 2, 3, 10].map(a => purchaseRetryDelayMs(a, null, now, undefined, () => 1)), [500, 1000, 2000, 30000]);
  assert.equal(purchaseRetryDelayMs(2, 'soon', now, undefined, () => 0), 500);
});

test('ZIP reader: stored and deflated entries, CRC, traversal names, encryption, size bombs; package pairing', () => {
  const xml = receivedFa3(), m = meta('2026-10-20T00:00:00.000Z');
  const ok = zipStore([{ name: `${m.ksefNumber}.xml`, data: xml }, { name: '_metadata.json', data: Buffer.from(JSON.stringify({ invoices: [{ ...m, seller: { nip: SELLER }, buyer: null }] })) }]);
  const pkg = parsePurchasePackage(readPurchaseZip(ok));
  assert.equal(pkg.length, 1); assert.ok(pkg[0]!.xml.equals(xml));
  // deflate: rewrite the stored entry as method 8
  const one = zipStore([{ name: 'a.xml', data: xml }]), def = deflateRawSync(xml);
  const local = Buffer.from(one.subarray(0, 30)), name = one.subarray(30, 35), cen = Buffer.from(one.subarray(30 + 5 + xml.length, 30 + 5 + xml.length + 46 + 5)), end = Buffer.from(one.subarray(one.length - 22));
  local.writeUInt16LE(8, 8); local.writeUInt32LE(def.length, 18); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(def.length, 20);
  end.writeUInt32LE(30 + 5 + def.length, 16);
  assert.ok(readPurchaseZip(Buffer.concat([local, name, def, cen, end]))[0]!.data.equals(xml));
  const bomb = Buffer.from(cen); bomb.writeUInt32LE(50 * 1024 * 1024, 24);
  assert.equal(code(() => readPurchaseZip(Buffer.concat([local, name, def, bomb, end]))), 'zip');
  const crc = Buffer.from(ok), at = 30 + `${m.ksefNumber}.xml`.length; crc[at] = (crc[at]! + 1) & 0xff; // first data byte
  assert.equal(code(() => readPurchaseZip(crc)), 'zip');
  for (const bad of ['../x.xml', 'a/b.xml', '.hidden']) assert.equal(code(() => readPurchaseZip(zipStore([{ name: bad, data: xml }]))), 'zip', bad);
  const enc = Buffer.from(one); enc.writeUInt16LE(1, 30 + 5 + xml.length + 8);
  assert.equal(code(() => readPurchaseZip(enc)), 'zip');
  assert.equal(code(() => readPurchaseZip(Buffer.from('not a zip at all, definitely not'))), 'zip');
  assert.equal(code(() => parsePurchasePackage(readPurchaseZip(zipStore([{ name: 'x.xml', data: xml }])))), 'zip', 'no _metadata.json');
  assert.equal(code(() => parsePurchasePackage(readPurchaseZip(zipStore([{ name: 'x.xml', data: xml }, { name: '_metadata.json', data: Buffer.from('{"invoices":[]}') }])))), 'zip', 'file without metadata');
});
