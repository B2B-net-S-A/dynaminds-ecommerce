/** Pure KOR-S rules (232): correction math of every FV-S category, rounding, EUR with the rate of the
 * corrected invoice, cancellation to zero, increase, return edits and the refusals. No IO. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAX_PROFILE, type OssState, type TaxProfile } from '../server/tax226-model';
import { buyerInput, invoiceMath, normalizeBuyer, plnCategories, type Buyer, type SourceLine } from '../server/invoice230-model';
import {
  cancellationEdits, correctionMath, correctionRequest, originalState, proportionalGross, reasonText, returnEdits,
  type CorrectionOriginal, type LineEdit, type StateLine,
} from '../server/invoice232-model';

const addr = (country: string) => ({ street: 'ul. Prosta 1', postal_code: '00-001', city: 'Miasto', country });
const buyer = (b: unknown): Buyer => normalizeBuyer(buyerInput.parse(b));
const plB2B = buyer({ kind: 'business', name: 'Firma', address: addr('PL'), tax_id: '5260250274', pl_vat_payer: true });
const deB2B = buyer({ kind: 'business', name: 'GmbH', address: addr('DE'), tax_id: 'DE123456789' });
const deConsumer = buyer({ kind: 'consumer', name: 'Hans', address: addr('DE') });
const oss: OssState = { registered: true, registered_from: '2026-07-01', rates: [{ country: 'DE', rate_class: 'standard', rate: '19.00' }] };
const profile = (p: Partial<TaxProfile>): TaxProfile => ({ ...DEFAULT_TAX_PROFILE, version: 1, ...p });
const item = (gross: string, p: Partial<TaxProfile> | null = null, sku = 'SKU-' + gross): SourceLine => ({ kind: 'item', sku, name: sku, vat_rate: 23, gross_minor: gross, profile: p ? profile(p) : null });
const ship = (gross: string): SourceLine => ({ kind: 'shipping', sku: '', name: 'Dostawa', vat_rate: 23, gross_minor: gross, profile: null });
const zw = { category: 'zw' as const, exemption_basis_kind: 'P_19A' as const, exemption_basis: 'art. 43 ust. 1 pkt 29 ustawy o VAT' };

/** A FV-S invoice built by the 230 rules; quantities as given (item i has quantity qty[i]). */
function invoice(b: Buyer, lines: SourceLine[], qty: number[], currency: 'PLN' | 'EUR' = 'PLN', mid: string | null = null): CorrectionOriginal {
  const d = invoiceMath({ buyer: b, currency, sell_date: '2026-10-20', lines, oss });
  assert.deepEqual(d.blockers, []);
  return { currency, mid, country: b.address.country, categories: d.math.categories,
    lines: d.math.lines.map(l => ({ line_no: l.line_no, kind: l.kind, sku: l.sku, name: l.name, item_id: l.kind === 'item' ? 'item-' + l.line_no : null, unit: l.kind === 'item' ? 'szt.' : 'usł.',
      quantity: l.kind === 'item' ? qty[l.source_index]! : 1, gross_minor: l.gross_minor, net_minor: l.net_minor, vat_minor: l.vat_minor, rate_code: l.rate_code, rate: l.rate, gtu: l.gtu, annex15: l.annex15 })) };
}
const ok = (o: CorrectionOriginal, edits: LineEdit[], reason: Parameters<typeof correctionMath>[3] = 'zwrot', mode: 'manual' | 'cancellation' | 'return' = 'manual', current: StateLine[] = originalState(o)) => {
  const d = correctionMath(o, current, mode, reason, edits);
  assert.deepEqual(d.blockers, []);
  return d.math;
};
const refusal = (o: CorrectionOriginal, edits: LineEdit[], re: RegExp, reason: Parameters<typeof correctionMath>[3] = 'zwrot', mode: 'manual' | 'cancellation' = 'manual', current: StateLine[] = originalState(o)) =>
  assert.match(correctionMath(o, current, mode, reason, edits).blockers.join(' | '), re);

test('23% B2B PLN: quantity decrease recomputes the line from its gross (half up), negative differences', () => {
  const o = invoice(plB2B, [item('36900'), ship('1599')], [3]);
  const m = ok(o, [{ line_no: 1, quantity: 1 }]);
  // 3 × 123,00: 1 unit stays → 123,00 gross, VAT = 12300 × 23/123 = 2300.
  assert.deepEqual(m.rows.map(r => [r.before.quantity, r.after.quantity, r.after.gross_minor, r.after.vat_minor, r.delta.gross_minor, r.delta.net_minor, r.delta.vat_minor]),
    [[3, 1, '12300', '2300', '-24600', '-20000', '-4600']]);
  assert.equal(m.kind, 'quantity'); assert.equal(m.direction, 'decrease');
  assert.deepEqual(m.categories.map(c => [c.key, c.fa3_net, c.fa3_vat, c.delta.net_minor, c.delta.vat_minor]), [['23', 'P_13_1', 'P_14_1', '-20000', '-4600']]);
  assert.equal(m.totals.delta.gross_minor, '-24600');
  assert.equal(BigInt(m.totals.before.gross_minor) + BigInt(m.totals.delta.gross_minor), BigInt(m.totals.after.gross_minor));
  assert.equal(m.pln_totals, null);
});

test('rounding: odd grosze, proportional value of a quantity and half-up VAT of the new line value', () => {
  assert.equal(proportionalGross({ line_no: 1, quantity: 3, gross_minor: '1000', net_minor: '0', vat_minor: '0' },
    { line_no: 1, quantity: 3, gross_minor: '1000' } as never, 1), 333n);
  assert.equal(proportionalGross({ line_no: 1, quantity: 3, gross_minor: '1001', net_minor: '0', vat_minor: '0' }, { line_no: 1, quantity: 3, gross_minor: '1001' } as never, 2), 667n);
  const o = invoice(plB2B, [item('1001')], [3]);
  const m = ok(o, [{ line_no: 1, quantity: 2 }]);
  // 667 gross at 23%: VAT = 667×23/123 = 124.72… → 125, net 542 (the 230 rule).
  assert.deepEqual([m.rows[0]!.after.gross_minor, m.rows[0]!.after.vat_minor, m.rows[0]!.after.net_minor], ['667', '125', '542']);
  assert.equal(m.rows[0]!.before.vat_minor, o.lines[0]!.vat_minor, 'before = the stored FV-S line');
});

test('every category: ZW, NP II and OO have VAT 0 and net = gross; OSS uses the destination rate; 0% keeps VAT 0', () => {
  const cases: [Buyer, Partial<TaxProfile>, string, string | null][] = [
    [plB2B, zw, 'zw', 'P_13_7'], [deB2B, { category: 'np', np_kind: 'np_ii' }, 'np II', 'P_13_9'],
    [plB2B, { category: 'oo' }, 'oo', 'P_13_10'],
  ];
  for (const [b, p, key, field] of cases) {
    const o = invoice(b, [item('10000', p), ship('0')], [2]);
    const m = ok(o, [{ line_no: 1, quantity: 1 }]);
    assert.deepEqual(m.categories.map(c => [c.key, c.fa3_net, c.delta.net_minor, c.delta.vat_minor, c.delta.gross_minor]), [[key, field, '-5000', '0', '-5000']], key);
  }
  const zero = invoice(plB2B, [{ ...item('10000'), vat_rate: 0 }, ship('0')], [2]);
  assert.equal(zero.lines[0]!.rate_code, '0 KR');
  assert.deepEqual(ok(zero, [{ line_no: 1, quantity: 1 }]).categories.map(c => [c.key, c.fa3_net, c.delta.net_minor, c.delta.vat_minor]), [['0 KR', 'P_13_6_1', '-5000', '0']]);
  const ossInv = invoice(deConsumer, [item('11900'), ship('1190')], [1]);
  assert.equal(ossInv.lines[0]!.rate_code, 'oss');
  const m = ok(ossInv, [{ line_no: 1, quantity: 1, gross_minor: '5950' }], 'obnizka_ceny');
  // 59,50 at 19%: VAT = 5950×19/119 = 950.
  assert.deepEqual(m.categories.map(c => [c.key, c.fa3_net, c.fa3_vat, c.label, c.delta.net_minor, c.delta.vat_minor]), [['oss 19.00', 'P_13_5', 'P_14_5', 'OSS DE 19,00%', '-5000', '-950']]);
  assert.equal(m.kind, 'price');
});

test('EUR: PLN of each state at the mid of the corrected invoice; PLN difference = after − before, sums to the grosz', () => {
  const o = invoice(deB2B, [item('33333', { category: 'np', np_kind: 'np_ii' }), ship('0')], [3], 'EUR', '4.2737');
  const first = ok(o, [{ line_no: 1, quantity: 2 }]);
  const orig = plnCategories(o.categories as never, '4.2737');
  assert.equal(first.pln_totals!.before.gross_pln_minor, orig.totals.gross_pln_minor, 'before = the PLN of the FV-S invoice');
  assert.equal(first.rows[0]!.after.gross_minor, '22222');
  const after = plnCategories([{ ...o.categories[0]!, net_minor: '22222', vat_minor: '0', gross_minor: '22222' }] as never, '4.2737');
  assert.equal(first.pln_totals!.after.gross_pln_minor, after.totals.gross_pln_minor);
  assert.equal(BigInt(first.pln_totals!.delta.gross_pln_minor), BigInt(after.totals.gross_pln_minor) - BigInt(orig.totals.gross_pln_minor));
  // A chain of corrections keeps reconciling: invoice + Σ differences = PLN of the final state.
  const second = ok(o, [{ line_no: 1, quantity: 0 }], 'zwrot', 'manual', first.state_after);
  const sum = BigInt(orig.totals.gross_pln_minor) + BigInt(first.pln_totals!.delta.gross_pln_minor) + BigInt(second.pln_totals!.delta.gross_pln_minor);
  assert.equal(sum, 0n);
  assert.equal(second.categories[0]!.pln!.after.gross_pln_minor, '0');
  // 23% EUR: VAT in PLN per category, also signed.
  const t = invoice(plB2B, [item('12300'), ship('0')], [1], 'EUR', '4.3000');
  const m = ok(t, [{ line_no: 1, quantity: 1, gross_minor: '6150' }], 'rabat');
  assert.deepEqual([m.categories[0]!.pln!.delta.net_pln_minor, m.categories[0]!.pln!.delta.vat_pln_minor], ['-21500', '-4945']);
});

test('cancellation to zero: every line and category at zero; a second cancellation is refused', () => {
  const o = invoice(plB2B, [item('24600'), item('5000', zw, 'ZW'), ship('1230')], [2, 1]);
  const s = originalState(o);
  const m = ok(o, cancellationEdits(s), 'anulowanie', 'cancellation');
  assert.equal(m.kind, 'cancellation');
  assert.equal(m.totals.after.gross_minor, '0'); assert.equal(m.totals.delta.gross_minor, '-' + m.totals.before.gross_minor);
  assert(m.state_after.every(l => l.quantity === 0 && l.gross_minor === '0'));
  assert.deepEqual(m.categories.map(c => c.key), ['23', 'zw']);
  refusal(o, cancellationEdits(m.state_after), /już skorygowana do zera/, 'anulowanie', 'cancellation', m.state_after);
});

test('increase: price raised after the sale; error reasons and mixed directions refused', () => {
  const o = invoice(plB2B, [item('12300'), item('24600', null, 'B')], [1, 2]);
  const m = ok(o, [{ line_no: 1, quantity: 1, gross_minor: '24600' }], 'podwyzka_ceny');
  assert.deepEqual([m.direction, m.totals.delta.gross_minor, m.totals.delta.vat_minor], ['increase', '12300', '2300']);
  refusal(o, [{ line_no: 1, quantity: 1, gross_minor: '24600' }], /korekta zwiększająca wymaga przyczyny powstałej po sprzedaży/, 'blad_ceny');
  refusal(o, [{ line_no: 1, quantity: 1, gross_minor: '6150' }], /dotyczy korekty zwiększającej/, 'podwyzka_ceny');
  refusal(o, [{ line_no: 1, quantity: 1, gross_minor: '24600' }, { line_no: 2, quantity: 1 }], /jednocześnie zwiększać i zmniejszać/, 'podwyzka_ceny');
  // Undoing an earlier decrease back up to the invoiced quantity.
  const down = ok(o, [{ line_no: 2, quantity: 0 }]);
  const up = ok(o, [{ line_no: 2, quantity: 2 }], 'cofniecie_korekty', 'manual', down.state_after);
  assert.equal(up.rows[0]!.after.gross_minor, '24600', 'value from the invoice when the line is at zero');
});

test('refusals: beyond invoiced quantity, unknown or repeated line, value without quantity, shipping beyond 1, no change', () => {
  const o = invoice(plB2B, [item('12300'), ship('1000')], [1]);
  refusal(o, [{ line_no: 1, quantity: 2 }], /przekracza ilość zafakturowaną \(1\)/, 'podwyzka_ceny');
  refusal(o, [{ line_no: 9, quantity: 0 }], /Pozycja 9 nie istnieje/);
  refusal(o, [{ line_no: 1, quantity: 0 }, { line_no: 1, quantity: 0 }], /więcej niż raz/);
  refusal(o, [{ line_no: 1, quantity: 0, gross_minor: '100' }], /ilością 0 nie może mieć wartości/);
  refusal(o, [{ line_no: 2, quantity: 2 }], /Dostawa: ilość po korekcie \(2\) przekracza/, 'podwyzka_ceny');
  refusal(o, [{ line_no: 1, quantity: 1 }], /nie zmienia żadnej pozycji/);
  const eur = { ...invoice(plB2B, [item('12300')], [1], 'EUR', '4.3000'), mid: null };
  refusal(eur, [{ line_no: 1, quantity: 0 }], /nie ma zapisanego kursu NBP/);
});

test('request schema: invalid reason, negative or fractional quantity, "inna" needs a description; reason text', () => {
  assert.equal(correctionRequest.safeParse({ mode: 'manual', reason_code: 'kaprys', lines: [{ line_no: 1, quantity: 0 }] }).success, false);
  assert.equal(correctionRequest.safeParse({ mode: 'manual', reason_code: 'zwrot', lines: [{ line_no: 1, quantity: -1 }] }).success, false);
  assert.equal(correctionRequest.safeParse({ mode: 'manual', reason_code: 'zwrot', lines: [{ line_no: 1, quantity: 0.5 }] }).success, false);
  assert.equal(correctionRequest.safeParse({ mode: 'manual', reason_code: 'zwrot', lines: [] }).success, false);
  assert.equal(correctionRequest.safeParse({ mode: 'manual', reason_code: 'inna', lines: [{ line_no: 1, quantity: 0 }] }).success, false);
  assert.equal(correctionRequest.safeParse({ mode: 'manual', reason_code: 'inna', reason_note: 'Uszkodzenie w transporcie', lines: [{ line_no: 1, quantity: 0 }] }).success, true);
  assert.equal(correctionRequest.safeParse({ mode: 'cancellation', reason_code: 'rabat' }).success, false, 'cancellation is always "anulowanie"');
  assert.equal(correctionRequest.safeParse({ mode: 'return', return_id: 'x' }).success, false);
  assert.equal(correctionRequest.parse({ mode: 'cancellation' }).reason_code, 'anulowanie');
  assert.equal(reasonText('zwrot', 'RMA-1'), 'Zwrot towaru — RMA-1');
  assert(reasonText('anulowanie', '').length <= 256);
});

test('return edits: accepted quantity and the refund of each item, shipping refund; refusals beyond the state', () => {
  const o = invoice(plB2B, [item('30000'), ship('1500')], [3]);
  const s = originalState(o);
  const r = returnEdits(o, s, [{ item_id: 'item-1', sku: 'A', accepted: 1, refund_amount: 10000 }], 1500);
  assert.deepEqual(r, { edits: [{ line_no: 1, quantity: 2, gross_minor: '20000' }, { line_no: 2, quantity: 0, gross_minor: '0' }], blockers: [] });
  const m = ok(o, r.edits, 'zwrot', 'return');
  assert.equal(m.kind, 'return'); assert.equal(m.totals.delta.gross_minor, '-11500', 'the correction equals the return refund');
  assert.match(returnEdits(o, s, [{ item_id: 'item-1', sku: 'A', accepted: 4, refund_amount: 0 }], 0).blockers.join(), /przekracza ilość/);
  assert.match(returnEdits(o, s, [{ item_id: 'item-1', sku: 'A', accepted: 1, refund_amount: 40000 }], 0).blockers.join(), /kwota zwrotu przekracza/);
  assert.match(returnEdits(o, s, [{ item_id: 'other', sku: 'X', accepted: 1, refund_amount: 1 }], 0).blockers.join(), /nie ma na fakturze/);
  assert.match(returnEdits(o, s, [], 0).blockers.join(), /nie ma przyjętych pozycji/);
  assert.match(returnEdits(o, s, [], 2000).blockers.join(), /przekracza wartość dostawy/);
});
