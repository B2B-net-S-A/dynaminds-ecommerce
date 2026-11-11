/** Pure native159-shaped fixtures + independent, pinned, network-disabled XSD.
 * No app/database/provider/credential imports or runtime configuration changes. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { renderNativeB2bInvoiceFa3 } from '../server/fa3-xml';
import { fa3XsdValidator } from '../server/fa3-xsd';
import type { B2bInvoiceDocument } from '../server/b2b-invoice-values';

const options = { generated_at: '2026-10-08T12:30:00.123456Z' };
function canonical(value: any): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => [k, canonical(v)])) : value;
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function fixture(): B2bInvoiceDocument {
  const seller = { name: 'Sprzedawca & PL', street: 'Ulica 1', postal_code: '00-001', city: 'Warszawa', country: 'PL' as const, tax_id: '8567346215' };
  const rates = [ ['23', '12300', '10000', '2300'], ['8', '10800', '10000', '800'], ['5', '10500', '10000', '500'], ['0 KR', '10000', '10000', '0'] ];
  const lines: any[] = rates.map(([vat_code, gross_minor, net_minor, vat_minor], i) => ({
    ordinal: i + 1, line_id: randomUUID(), kind: 'item', source_item_id: randomUUID(), name: 'Produkt ' + (i + 1), unit: 'szt.', quantity: '1',
    unit_gross_minor: gross_minor, discount_gross_minor: '0', rounding_gross_minor: '0', gross_minor, net_minor, vat_minor, vat_code,
    zero_domestic_basis: vat_code === '0 KR' ? 'Jawna krajowa podstawa źródłowa' : null,
  }));
  lines.push({ ordinal: 5, line_id: randomUUID(), kind: 'shipping', source_item_id: null, name: 'Dostawa', unit: 'usł.', quantity: '1',
    unit_gross_minor: '1230', discount_gross_minor: '0', rounding_gross_minor: '0', gross_minor: '1230', net_minor: '1000', vat_minor: '230', vat_code: '23', zero_domestic_basis: null });
  const order_id = randomUUID();
  const fiscal: any = { schema: 'b2b-fa3-draft/v1', state: 'draft', currency: 'PLN', invoice_kind: 'VAT', tax_method: 'gross_line_half_up',
    seller: { kind: 'business', name: seller.name, tax_id: seller.tax_id, address: { country: 'PL', line1: seller.street, line2: seller.postal_code + ' ' + seller.city } },
    buyer: { kind: 'business', name: 'Nabywca <B2B>', tax_id: '5260250274', address: { country: 'PL', line1: 'Ulica 2', line2: '00-002 Warszawa' } },
    source: { tenant_id: randomUUID(), order_id, order_version: '19', item_ids: lines.filter(r => r.kind === 'item').map(r => r.source_item_id),
      order_total_minor: '44830', shipping_gross_minor: '1230', buyer_basis: { kind: 'ordinary_explicit', confirmed_bill_to_hash: 'a'.repeat(64) } },
    sale_date: '2026-10-07', ordinary_scope: { cash_method: false, self_billing: false, reverse_charge: false, split_payment: false, exemption: false,
      new_transport: false, triangular: false, margin: false, jst: false, vat_group: false, advance: false }, lines,
    totals: { gross_minor: '44830', net_minor: '41000', vat_minor: '3830' } };
  const number = 'FV-B2B/NATIVE/2026/000017';
  return { id: randomUUID(), order_id, kind: 'invoice', mode: 'b2b_invoice', number, created_at: '2026-10-08T10:00:00.123456Z', data: {
    schema: 'b2b-local-invoice/v1', project_id: randomUUID(), project_receipt_id: randomUUID(), project_hash: hash(fiscal), project_scope_hash: 'b'.repeat(64),
    fiscal_snapshot: fiscal, order_number: '17', series_id: randomUUID(), series_definition: { name: 'Native FV', prefix: 'NATIVE', seller,
      payment_terms_days: 7, payment_instructions: 'Kontakt w sprawie zapłaty: biuro', notes: 'Historyczna uwaga', seller_vat_status: 'active_domestic' },
    series_command_hash: 'c'.repeat(64), issue_date: '2026-10-08', sale_date: '2026-10-07', due_date: '2026-10-15', payment_mode: 'prepaid',
    local_only: true, ksef_state: 'not_submitted', fiscalized: false, number, year: 2026, sequence: 17, preview_id: randomUUID(), scope_hash: 'd'.repeat(64),
  } };
}
function values(xml: string) {
  const result: Record<string, string[]> = {}, stack: string[] = [], text: string[] = [];
  const p = new SaxesParser({ xmlns: true });
  p.on('doctype', () => { throw new Error('DTD forbidden in test parser'); });
  p.on('opentag', async t => { stack.push(t.local); text.push(''); });
  p.on('text', async t => { text[text.length - 1] += t; });
  p.on('closetag', () => { const n = stack.pop()!, v = text.pop()!; (result[n] ??= []).push(v); });
  p.write(xml).close(); return result;
}
/** Offline official FA(3) XSD vendored in schemas/mf (server/mf-xsd.ts). */
const XSD = fa3XsdValidator();
async function xsd(t: TestContext, xml: string, expected = true) {
  assert.equal(XSD.available, true, XSD.reason);
  const r = await XSD.validate(xml);
  assert.equal(r.status, expected ? 'valid' : 'invalid', 'Offline official XSD: ' + JSON.stringify(r).slice(0, 400));
}
function rehash(d: B2bInvoiceDocument) { d.data.project_hash = hash(d.data.fiscal_snapshot); }
function amounts(d: B2bInvoiceDocument) {
  const f = d.data.fiscal_snapshot; let net = 0n, vat = 0n, gross = 0n;
  for (const r of f.lines) { const g = BigInt(r.gross_minor), rate = r.vat_code === '0 KR' ? 0n : BigInt(r.vat_code), den = 100n + rate;
    const v = (g * rate + den / 2n) / den; r.vat_minor = String(v); r.net_minor = String(g - v); gross += g; vat += v; net += g - v; }
  f.source.order_total_minor = String(gross); f.source.shipping_gross_minor = f.lines.at(-1)!.gross_minor;
  f.totals = { gross_minor: String(gross), net_minor: String(net), vat_minor: String(vat) }; rehash(d);
}

test('complete native159 FV: frozen number, four VAT buckets, shipping, terms, source hash and deterministic XSD-valid bytes', async t => {
  const d = fixture(), before = structuredClone(d), r = renderNativeB2bInvoiceFa3(d, options), v = values(r.xml);
  assert.deepEqual(v.P_2, [d.number]); assert.deepEqual(v.P_1, ['2026-10-08']); assert.deepEqual(v.P_6, ['2026-10-07']);
  assert.deepEqual(v.NIP, ['8567346215', '5260250274']); assert.deepEqual(v.P_13_1, ['110.00']); assert.deepEqual(v.P_14_1, ['25.30']);
  assert.deepEqual(v.P_13_2, ['100.00']); assert.deepEqual(v.P_14_2, ['8.00']); assert.deepEqual(v.P_13_3, ['100.00']); assert.deepEqual(v.P_14_3, ['5.00']);
  assert.deepEqual(v.P_13_6_1, ['100.00']); assert.deepEqual(v.P_15, ['448.30']); assert.deepEqual(v.P_12, ['23', '8', '5', '0 KR', '23']);
  assert.deepEqual(v.UU_ID, d.data.fiscal_snapshot.lines.map(r => r.line_id)); assert.deepEqual(v.Termin, ['2026-10-15']);
  assert.deepEqual(v.StopkaFaktury, ['Historyczna uwaga', 'Kontakt w sprawie zapłaty: biuro']); assert.deepEqual(v.Wartosc, ['Jawna krajowa podstawa źródłowa']);
  assert.equal(r.document_id, d.id); assert.equal(r.fiscal_snapshot_hash, d.data.project_hash); assert.equal(r.ksef_state, 'not_submitted');
  assert.equal(r.xml_sha256, createHash('sha256').update(r.xml).digest('hex')); assert.equal(r.xml_bytes, Buffer.byteLength(r.xml));
  assert.equal(r.xml, renderNativeB2bInvoiceFa3(structuredClone(d), options).xml); assert.deepEqual(d, before); await xsd(t, r.xml);
});
test('100 genuine-shaped item identities and a zero-price shipping row are all retained, no invented rows or truncation', async t => {
  const d = fixture(), f = d.data.fiscal_snapshot, base = f.lines[0], shipping = f.lines.at(-1)!;
  f.lines = Array.from({ length: 100 }, (_, i) => ({ ...base, ordinal: i + 1, line_id: randomUUID(), source_item_id: randomUUID() }));
  f.lines.push({ ...shipping, ordinal: 101, unit_gross_minor: '0', gross_minor: '0', net_minor: '0', vat_minor: '0' });
  f.source.item_ids = f.lines.filter(r => r.kind === 'item').map(r => r.source_item_id!); amounts(d);
  const r = renderNativeB2bInvoiceFa3(d, options), v = values(r.xml);
  assert.equal(v.NrWierszaFa.length, 101); assert.deepEqual(v.UU_ID, f.lines.map(l => l.line_id)); assert.equal(v.P_11A.at(-1), '0.00'); await xsd(t, r.xml);
});
test('gross-price discount and values above Number.MAX_SAFE_INTEGER preserve exact historical cents and VAT', async t => {
  const d = fixture(), f = d.data.fiscal_snapshot;
  Object.assign(f.lines[0], { quantity: '2', unit_gross_minor: '6150000000000000', discount_gross_minor: '1', gross_minor: '12299999999999999' });
  amounts(d); const r = renderNativeB2bInvoiceFa3(d, options), v = values(r.xml);
  assert.deepEqual(v.P_9B.slice(0, 1), ['61500000000000.00']); assert.deepEqual(v.P_10, ['0.01']);
  assert.equal(v.P_11A[0], '122999999999999.99'); assert.equal(v.P_15[0], '123000000000325.29');
  assert.equal(v.P_13_1[0], '100000000000009.99'); assert.equal(v.P_14_1[0], '23000000000002.30'); await xsd(t, r.xml);
});
test('Unicode, metacharacters, CR and LF round-trip without entities, payload injection or source mutation', async t => {
  const d = fixture(); d.data.fiscal_snapshot.lines[0].name = 'Łódź & <tag>\r\n\"test\"\rśrodek';
  d.data.fiscal_snapshot.buyer.name = 'Firma & druga <strona>'; rehash(d);
  const r = renderNativeB2bInvoiceFa3(d, options), v = values(r.xml);
  assert.equal(v.P_7[0], d.data.fiscal_snapshot.lines[0].name); assert.equal(v.Nazwa[1], d.data.fiscal_snapshot.buyer.name);
  assert.ok(r.xml.includes('&lt;tag&gt;')); assert.ok(r.xml.includes('&#13;')); await xsd(t, r.xml);
});
test('unnumbered/project/correction/foreign currency/special tax procedure/stale native hashes and forged numbering all fail closed', () => {
  const mutations: Array<(d: any) => void> = [d => d.mode = 'demo', d => d.kind = 'correction', d => d.data.fiscal_snapshot.currency = 'EUR',
    d => d.data.fiscal_snapshot.buyer.kind = 'consumer', d => d.data.fiscal_snapshot.ordinary_scope.exemption = true,
    d => d.data.fiscal_snapshot.ordinary_scope.reverse_charge = true, d => d.data.number = 'FV-B2B/NATIVE/2026/000018',
    d => { d.number = 'FV-B2B/NATIVE/2026/000018'; d.data.number = d.number; }, d => d.order_id = randomUUID(),
    d => d.data.project_hash = 'e'.repeat(64), d => d.data.series_definition.seller.tax_id = '5260250274', d => d.data.due_date = '2026-10-16',
    d => d.data.fiscal_snapshot.lines[0].vat_code = null, d => d.data.fiscal_snapshot.lines[0].unit_gross_minor = '1e4',
    d => d.data.fiscal_snapshot.lines[0].unit_gross_minor = 12300, d => d.data.fiscal_snapshot.totals.gross_minor = '44831', d => d.private_payload = 'secret',
    d => delete d.data.series_definition.notes, d => delete d.data.series_definition.payment_instructions];
  for (const mutate of mutations) { const d = fixture(); mutate(d); assert.throws(() => renderNativeB2bInvoiceFa3(d, options), { code: 'INVALID_NATIVE_INVOICE' }); }
  assert.throws(() => renderNativeB2bInvoiceFa3(fixture().data.fiscal_snapshot, options), { code: 'INVALID_NATIVE_INVOICE' });
  assert.throws(() => renderNativeB2bInvoiceFa3(fixture(), { ...options, number: 'caller-number' }), { code: 'INVALID_EXPORT_TIME' });
});
test('valid fiscal draft with a one-cent native remainder is never silently reallocated in issued export', () => {
  const d = fixture(), r = d.data.fiscal_snapshot.lines[0];
  Object.assign(r, { quantity: '2', unit_gross_minor: '6150', gross_minor: '12301', rounding_gross_minor: '1' }); amounts(d);
  assert.throws(() => renderNativeB2bInvoiceFa3(d, options), { code: 'INVALID_NATIVE_INVOICE' });
});
test('explicit UTC generation timestamp bounds retain microseconds and reject beyond-XSD fractional upper endpoint', async t => {
  const d = fixture(); const allowed = ['2026-10-08T00:00:00Z', '2050-01-01T23:59:59.000000Z'];
  for (const generated_at of allowed) { const r = renderNativeB2bInvoiceFa3(d, { generated_at }); assert.deepEqual(values(r.xml).DataWytworzeniaFa, [generated_at]); await xsd(t, r.xml); }
  for (const generated_at of ['2026-10-07T23:59:59Z', '2050-01-01T23:59:59.0000001Z', '2050-01-02T00:00:00Z', '2026-02-30T12:00:00Z', '2026-10-08T12:00:00+02:00'])
    assert.throws(() => renderNativeB2bInvoiceFa3(d, { generated_at }), { code: 'INVALID_EXPORT_TIME' });
});
test('native older payment-term and oversized zero-basis mappings refuse, no chopping or undocumented omission', () => {
  const d = fixture(); d.data.fiscal_snapshot.lines[3].zero_domestic_basis = 'X'.repeat(257); rehash(d);
  assert.throws(() => renderNativeB2bInvoiceFa3(d, options), { code: 'UNSUPPORTED_SCOPE' });
  const old = fixture(); old.data.issue_date = '2016-06-20'; old.data.sale_date = '2016-06-19'; old.data.fiscal_snapshot.sale_date = old.data.sale_date;
  old.data.due_date = '2016-06-27'; old.data.year = 2016; old.number = old.data.number = 'FV-B2B/NATIVE/2016/000017'; rehash(old);
  assert.throws(() => renderNativeB2bInvoiceFa3(old, options), { code: 'UNSUPPORTED_SCOPE' });
});
test('independent official XSD and safe parser reject wrong FA variant, missing tax identity, broken order, DTD, PI and BOM', async t => {
  const xml = renderNativeB2bInvoiceFa3(fixture(), options).xml;
  await xsd(t, xml.replace('<WariantFormularza>3</WariantFormularza>', '<WariantFormularza>2</WariantFormularza>'), false);
  await xsd(t, xml.replace('<NIP>5260250274</NIP>', ''), false);
  await xsd(t, xml.replace('<KodWaluty>PLN</KodWaluty>', '').replace('</Fa>', '<KodWaluty>PLN</KodWaluty></Fa>'), false);
  await xsd(t, xml.replace('<Faktura ', '<!DOCTYPE Faktura [<!ENTITY ex SYSTEM "file:///etc/passwd">]><Faktura '), false);
  await xsd(t, xml.replace('<Faktura ', '<?instruction test?><Faktura '), false); await xsd(t, '\uFEFF' + xml, false);
});
test('oversized/cyclic input and illegal Unicode refuse without including caller text in diagnostics', () => {
  const d = fixture(); (d as any).self = d;
  assert.throws(() => renderNativeB2bInvoiceFa3(d, options), { code: 'INVALID_NATIVE_INVOICE' });
  assert.throws(() => renderNativeB2bInvoiceFa3({ value: 'X'.repeat(1_048_577) }, options), { code: 'INVALID_NATIVE_INVOICE' });
  for (const value of ['X\u0000', 'X\u0085', 'X\uFFFF', 'X\uD800']) { const d = fixture(); d.data.fiscal_snapshot.lines[0].name = value;
    assert.throws(() => renderNativeB2bInvoiceFa3(d, options), e => { assert.equal((e as any).code, 'INVALID_NATIVE_INVOICE'); assert.ok(!(e as Error).message.includes(value)); return true; }); }
});

test('actual native to_jsonb timestamptz with UTC offset is accepted without losing microseconds', async t => {
  const d = fixture(); d.created_at = '2026-10-08T10:00:00.123456+00:00';
  const before = structuredClone(d), r = renderNativeB2bInvoiceFa3(d, {generated_at: '2026-10-08T10:00:00.123456Z'});
  assert.deepEqual(values(r.xml).DataWytworzeniaFa, ['2026-10-08T10:00:00.123456Z']);
  assert.deepEqual(d, before); await xsd(t, r.xml);
});

test('checksum-valid native NIP outside official lexical format refuses export without changing native validators', () => {
  for (const tax_id of ['0123456789', '1000000006']) {
    const d=fixture(); d.data.fiscal_snapshot.buyer.tax_id=tax_id; rehash(d);
    assert.throws(() => renderNativeB2bInvoiceFa3(d,options), {code:'UNSUPPORTED_SCOPE'});
  }
});
