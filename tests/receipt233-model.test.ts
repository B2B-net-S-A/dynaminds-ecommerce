/** Pure fiscal receipt rules (233): PTU mapping, rounding identical to the invoice math, the state
 * machine, the refusals, the NIP ≤ 450 zł simplified invoice and invoice to a receipt. No IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAX_PROFILE, type TaxProfile } from '../server/tax226-model';
import { grossLineAmounts, invoiceMath, normalizeBuyer, buyerInput } from '../server/invoice230-model';
import {
  DEFAULT_PTU_TABLE, buyerNipInput, canTransition, defaultPaymentForm, invoiceToReceiptRefusals, isSimplifiedInvoice, ptuLetterOf, ptuTableInput,
  receiptMath, receiptName, receiptRefusals, receiptRequest, samePtuTable, transition, type ReceiptOrderFacts, type ReceiptSourceLine,
} from '../server/receipt233-model';

const profile = (p: Partial<TaxProfile>): TaxProfile => ({ ...DEFAULT_TAX_PROFILE, version: 1, ...p });
const item = (gross: string, vat = 23, p: Partial<TaxProfile> | null = null, qty = 1, unit = gross): ReceiptSourceLine =>
  ({ kind: 'item', sku: 'SKU-' + gross, name: 'Towar ' + gross, vat_rate: vat, gross_minor: gross, profile: p ? profile(p) : null, quantity: qty, unit_gross_minor: unit });
const ship = (gross: string, vat = 23): ReceiptSourceLine => ({ kind: 'shipping', sku: '', name: 'Dostawa', vat_rate: vat, gross_minor: gross, profile: null, quantity: 1, unit_gross_minor: gross });
const zw = { category: 'zw' as const, exemption_basis_kind: 'P_19A' as const, exemption_basis: 'art. 43 ust. 1 pkt 29 ustawy o VAT' };

test('PTU mapping: 23→A, 8→B, 5→C, 0%→D, zw→E; NP/OO/OSS have no letter; a reprogrammed table is followed', () => {
  assert.deepEqual(['23', '8', '5', '0 KR', 'zw', 'np I', 'np II', 'oo', 'oss'].map(c => ptuLetterOf(DEFAULT_PTU_TABLE, c)), ['A', 'B', 'C', 'D', 'E', null, null, null, null]);
  const other = { ...DEFAULT_PTU_TABLE, A: '8' as const, B: '23' as const };
  assert.equal(ptuLetterOf(other, '23'), 'B');
  assert.equal(ptuLetterOf({ ...DEFAULT_PTU_TABLE, C: null }, '5'), null);
  assert.equal(samePtuTable(DEFAULT_PTU_TABLE, { ...DEFAULT_PTU_TABLE }), true);
  assert.equal(samePtuTable(DEFAULT_PTU_TABLE, other), false);
  assert.throws(() => ptuTableInput.parse({ ...DEFAULT_PTU_TABLE, F: '23' }), /dwóch liter/);
  assert.throws(() => ptuTableInput.parse({ A: null, B: null, C: null, D: null, E: null, F: null, G: null }), /żadnej stawki/);
});

test('rounding is the invoice math: per line from gross, half up, PTU totals are sums of lines', () => {
  const lines = [item('1001', 23, null, 3, '334'), item('999', 8), item('1999', 5), item('500', 0), item('2500', 23, zw), ship('1499')];
  const r = receiptMath(lines, DEFAULT_PTU_TABLE, '2026-10-25', null);
  assert.deepEqual(r.blockers, []);
  const inv = invoiceMath({ buyer: normalizeBuyer(buyerInput.parse({ kind: 'consumer', name: 'X', address: { street: 'a', postal_code: '00-001', city: 'b', country: 'PL' } })), currency: 'PLN', sell_date: '2026-10-25', lines, oss: null });
  assert.deepEqual(r.math.lines.map(l => [l.gross_minor, l.net_minor, l.vat_minor]), inv.math.lines.map(l => [l.gross_minor, l.net_minor, l.vat_minor]));
  assert.deepEqual(r.math.totals, inv.math.totals);
  const a = grossLineAmounts(1001n, '23'), s = grossLineAmounts(1499n, '23');
  assert.deepEqual(r.math.ptu_totals.map(t => [t.ptu, t.gross_minor, t.vat_minor]), [
    ['A', '2500', String(a.vat + s.vat)], ['B', '999', String(grossLineAmounts(999n, '8').vat)], ['C', '1999', String(grossLineAmounts(1999n, '5').vat)], ['D', '500', '0'], ['E', '2500', '0']]);
  // 3 × 3,34 = 10,02 sold for 10,01: the line carries a 1 grosz discount.
  assert.deepEqual([r.math.lines[0]!.quantity, r.math.lines[0]!.unit_gross_minor, r.math.lines[0]!.discount_gross_minor], [3, '334', '1']);
  // A shipping line of an all-exempt order follows the goods (E), as on the invoice.
  const allZw = receiptMath([item('1000', 23, zw), ship('500')], DEFAULT_PTU_TABLE, '2026-10-25', null);
  assert.deepEqual(allZw.math.lines.map(l => l.ptu), ['E', 'E']);
  const long = receiptName('  Bardzo   długa nazwa produktu, która nie mieści się na paragonie  ', 'X');
  assert.ok(long.length <= 40 && long.endsWith('…') && long.startsWith('Bardzo długa'));
});

test('lines without a PTU letter refuse the receipt', () => {
  const np = receiptMath([item('1000', 23, { category: 'np', np_kind: 'np_i' })], DEFAULT_PTU_TABLE, '2026-10-25', null);
  assert.ok(np.blockers.length >= 1);
  const missing = receiptMath([item('1000', 5)], { ...DEFAULT_PTU_TABLE, C: null }, '2026-10-25', null);
  assert.match(missing.blockers.join(), /nie ma litery PTU dla stawki 5%/);
  // Two different exemption bases are allowed on a receipt (no P_19), refused on an invoice.
  const two = receiptMath([item('1000', 23, zw), item('900', 23, { ...zw, exemption_basis: 'art. 43 ust. 1 pkt 18' })], DEFAULT_PTU_TABLE, '2026-10-25', null);
  assert.deepEqual(two.blockers, []);
});

test('state machine: queued → sent → printed | failed, failed → queued; printed is final', () => {
  assert.equal(transition('queued', 'sent'), 'sent');
  assert.equal(transition('sent', 'printed'), 'printed');
  assert.equal(transition('sent', 'failed'), 'failed');
  assert.equal(transition('failed', 'queued'), 'queued');
  for (const [a, b] of [['queued', 'printed'], ['queued', 'failed'], ['printed', 'queued'], ['printed', 'failed'], ['failed', 'printed'], ['failed', 'sent'], ['sent', 'queued']] as const) {
    assert.equal(canTransition(a, b), false, `${a}→${b}`);
    assert.throws(() => transition(a, b), /Niedozwolona zmiana stanu paragonu/);
  }
});

const facts = (f: Partial<ReceiptOrderFacts> = {}): ReceiptOrderFacts => ({ status: 'paid', currency: 'PLN', fulfillment_kind: 'sale', source: 'manual', b2b: false,
  merged_into_other: false, delivery_country: 'PL', invoices: [], total_minor: 10000n, ...f });
test('refusals: invoiced, B2B, unpaid, cancelled, returns, foreign currency or country, merged, zero', () => {
  assert.deepEqual(receiptRefusals(facts()), []);
  assert.deepEqual(receiptRefusals(facts({ status: 'shipped' })), []);
  const cases: [Partial<ReceiptOrderFacts>, RegExp][] = [
    [{ invoices: ['FV/1/2026/000001'] }, /ma już fakturę FV\/1\/2026\/000001/], [{ invoices: ['FV-S/X/2026/000001'] }, /udokumentowana fakturą/],
    [{ b2b: true }, /B2B dokumentuje się fakturą/], [{ status: 'new' }, /po otrzymaniu zapłaty/], [{ status: 'cancelled' }, /anulowane/],
    [{ status: 'return_initiated' }, /zwrot/], [{ currency: 'EUR' }, /w PLN/], [{ delivery_country: 'DE' }, /poza Polską \(DE\)/],
    [{ merged_into_other: true }, /scalone/], [{ fulfillment_kind: 'replacement' }, /nie jest sprzedażą/], [{ total_minor: 0n }, /kwoty do zapłaty/],
  ];
  for (const [f, re] of cases) assert.match(receiptRefusals(facts(f)).join(' · '), re);
});

test('NIP ≤ 450 zł is a simplified invoice; the NIP is validated; the request needs confirmation', () => {
  assert.equal(isSimplifiedInvoice('5260250274', 45_000n), true);
  assert.equal(isSimplifiedInvoice('5260250274', 45_001n), false);
  assert.equal(isSimplifiedInvoice(null, 100n), false);
  assert.equal(buyerNipInput.parse('PL 526-025-02-74'), '5260250274');
  assert.equal(buyerNipInput.parse(''), null);
  assert.equal(buyerNipInput.parse(null), null);
  assert.throws(() => buyerNipInput.parse('5260250275'), /Niepoprawny NIP nabywcy/);
  const key = '00000000-0000-4000-8000-000000000001';
  assert.equal(receiptRequest.parse({ client_key: key, payment_form: 'karta', confirmed: true }).buyer_nip, null);
  assert.throws(() => receiptRequest.parse({ client_key: key, payment_form: 'karta', confirmed: false }), /Potwierdź druk/);
  assert.throws(() => receiptRequest.parse({ client_key: key, payment_form: 'czek', confirmed: true }), /formę płatności/);
  assert.equal(defaultPaymentForm('cod'), 'pobranie');
  assert.equal(defaultPaymentForm('prepaid'), 'przelew');
});

test('invoice to a receipt: B2B needs the same NIP on the receipt, amounts must agree, a receipt in print blocks', () => {
  const printed = { state: 'printed' as const, number: '000017', buyer_nip: null, gross_minor: 12300n };
  const consumer = { buyer_kind: 'consumer' as const, buyer_tax_id_kind: 'none' as const, buyer_tax_id: '', gross_minor: 12300n };
  const firm = { buyer_kind: 'business' as const, buyer_tax_id_kind: 'nip' as const, buyer_tax_id: '5260250274', gross_minor: 12300n };
  assert.deepEqual(invoiceToReceiptRefusals(printed, consumer), []);
  assert.match(invoiceToReceiptRefusals(printed, firm).join(), /nie zawiera NIP nabywcy.*art\. 106b ust\. 5/);
  assert.deepEqual(invoiceToReceiptRefusals({ ...printed, buyer_nip: '5260250274' }, firm), []);
  assert.match(invoiceToReceiptRefusals({ ...printed, buyer_nip: '7740001454' }, firm).join(), /inny niż NIP na paragonie/);
  assert.match(invoiceToReceiptRefusals(printed, { ...consumer, gross_minor: 12301n }).join(), /różni się od kwoty paragonu/);
  assert.match(invoiceToReceiptRefusals({ ...printed, state: 'sent' }, consumer).join(), /w trakcie druku/);
  assert.deepEqual(invoiceToReceiptRefusals({ ...printed, state: 'failed', number: null }, firm), []);
});
