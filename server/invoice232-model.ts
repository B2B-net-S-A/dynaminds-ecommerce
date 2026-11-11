/** Pure rules of the value corrections (KOR-S) of FV-S invoices (230), no IO. A correction moves the
 * state of the invoice lines (quantity and value) from the current state (the invoice, or the state
 * after the last correction) to a new one. Line amounts are recomputed with the 230 rule (per line,
 * from the gross amount, half up; ZW/NP/OO VAT 0; OSS at the destination rate stored on the line),
 * categories are sums of lines in P_13 order, and the correction is the signed difference after − before.
 * An EUR correction uses the NBP rate of the corrected invoice: PLN of a state = 230 conversion of its
 * category totals, and the PLN difference = PLN(after) − PLN(before), so the invoice plus all its
 * corrections give the PLN of the final state to the grosz. Design: docs/parity/CORRECTIONS232-20261025.md. */
import { z } from 'zod';
import { midScaled, toPlnMinor } from './nbp227-model';
import { FA3_SUMMARY_FIELD, grossLineAmounts } from './invoice230-model';
import type { Invoice230Snapshot } from './invoice230';

/** Polish reasons (PrzyczynaKorekty) and the direction each one allows. An increase is accepted only for a
 * cause that arose after the sale (art. 29a ust. 17: settled in the period of the correction). */
export const CORRECTION_REASONS = Object.freeze({
  zwrot: { label: 'Zwrot towaru', direction: 'decrease' },
  rabat: { label: 'Rabat udzielony po sprzedaży', direction: 'decrease' },
  obnizka_ceny: { label: 'Obniżka ceny', direction: 'decrease' },
  blad_ilosci: { label: 'Pomyłka w ilości (zawyżona ilość)', direction: 'decrease' },
  blad_ceny: { label: 'Pomyłka w cenie (zawyżona cena)', direction: 'decrease' },
  anulowanie: { label: 'Anulowanie transakcji — korekta do zera', direction: 'decrease' },
  podwyzka_ceny: { label: 'Podwyższenie ceny uzgodnione po sprzedaży', direction: 'increase' },
  cofniecie_korekty: { label: 'Cofnięcie wcześniejszej korekty — towar nie wrócił', direction: 'increase' },
  inna: { label: 'Inna przyczyna', direction: 'decrease' },
} as const);
export type CorrectionReason = keyof typeof CORRECTION_REASONS;
export const CORRECTION_REASON_CODES = Object.keys(CORRECTION_REASONS) as [CorrectionReason, ...CorrectionReason[]];

const lineEdit = z.strictObject({
  line_no: z.number().int().min(1).max(101),
  quantity: z.number({ error: 'Ilość po korekcie musi być liczbą całkowitą' }).int('Ilość po korekcie musi być liczbą całkowitą').min(0, 'Ilość po korekcie nie może być ujemna').max(100000),
  /** Line value after the correction (gross, in grosze/cents); omitted = proportional to the quantity. */
  gross_minor: z.string().regex(/^(0|[1-9][0-9]{0,11})$/, 'Wartość pozycji po korekcie: nieujemna kwota w groszach').optional(),
});
export type LineEdit = z.infer<typeof lineEdit>;
const reasonNote = z.string().trim().max(200, 'Opis przyczyny: najwyżej 200 znaków').default('');
const reasonCode = z.enum(CORRECTION_REASON_CODES, 'Wybierz przyczynę korekty z listy');
export const correctionRequest = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('manual'), reason_code: reasonCode, reason_note: reasonNote, lines: z.array(lineEdit).min(1, 'Wskaż co najmniej jedną pozycję').max(101) }),
  z.strictObject({ mode: z.literal('cancellation'), reason_code: z.literal('anulowanie').default('anulowanie'), reason_note: reasonNote }),
  z.strictObject({ mode: z.literal('return'), return_id: z.uuid().transform(v => v.toLowerCase()), reason_code: z.literal('zwrot').default('zwrot'), reason_note: reasonNote }),
]).superRefine((r, ctx) => {
  if (r.reason_code === 'inna' && r.reason_note.length < 5) ctx.addIssue({ code: 'custom', path: ['reason_note'], message: 'Przy przyczynie „Inna” opisz ją (co najmniej 5 znaków)' });
});
export type CorrectionRequest = z.infer<typeof correctionRequest>;
export const reasonText = (code: CorrectionReason, note: string): string => CORRECTION_REASONS[code].label + (note ? ` — ${note}` : '');

/** One line of the invoice in a given state. Facts that never change (category, rate, GTU…) come from the FV-S line. */
export type StateLine = { line_no: number; quantity: number; gross_minor: string; net_minor: string; vat_minor: string };
export type OriginalLine = {
  line_no: number; kind: 'item' | 'shipping'; sku: string; name: string; item_id: string | null; unit: string; quantity: number;
  gross_minor: string; net_minor: string; vat_minor: string; rate_code: string; rate: string | null; gtu: string | null; annex15: boolean;
};
export type OriginalCategory = { key: string; rate_code: string; rate: string | null; net_minor: string; vat_minor: string; gross_minor: string };
export type CorrectionOriginal = { currency: 'PLN' | 'EUR'; mid: string | null; country: string; lines: readonly OriginalLine[]; categories: readonly OriginalCategory[] };

type Amounts = { net_minor: string; vat_minor: string; gross_minor: string };
export type CorrectionRow = {
  line_no: number; kind: OriginalLine['kind']; sku: string; name: string; item_id: string | null; unit: string; rate_code: string; rate: string | null; gtu: string | null; annex15: boolean;
  before: { quantity: number } & Amounts; after: { quantity: number } & Amounts; delta: { quantity: number } & Amounts;
};
type Pln = { net_pln_minor: string; vat_pln_minor: string; gross_pln_minor: string };
export type CorrectionCategory = {
  key: string; rate_code: string; rate: string | null; fa3_net: string; fa3_vat: string | null; label: string;
  before: Amounts; after: Amounts; delta: Amounts; pln: { before: Pln; after: Pln; delta: Pln } | null;
};
export type CorrectionKind = 'return' | 'quantity' | 'price' | 'mixed' | 'cancellation';
export type CorrectionMath = {
  kind: CorrectionKind; direction: 'decrease' | 'increase'; rows: CorrectionRow[]; categories: CorrectionCategory[]; state_after: StateLine[];
  totals: { before: Amounts; after: Amounts; delta: Amounts }; pln_totals: { before: Pln; after: Pln; delta: Pln } | null;
};
export type CorrectionDecision = { math: CorrectionMath; blockers: string[] };

const UNTAXED = new Set(['zw', 'np I', 'np II', 'oo']);
const FA3_ORDER = ['23', '8', '5', 'oss', '0 KR', 'zw', 'np I', 'np II', 'oo'];
const keyOf = (l: { rate_code: string; rate: string | null }) => (l.rate_code === 'oss' ? `oss ${l.rate}` : l.rate_code);
/** 230 line amounts of a gross value at the line's category. */
export function lineAmounts(l: Pick<OriginalLine, 'rate_code' | 'rate'>, gross: bigint): Amounts {
  const a = grossLineAmounts(gross, UNTAXED.has(l.rate_code) ? null : l.rate);
  return { net_minor: String(a.net), vat_minor: String(a.vat), gross_minor: String(gross) };
}
/** Value of `q` units, proportional to the current state (or the invoice when the line is at zero), half up. */
export function proportionalGross(current: StateLine, original: OriginalLine, q: number): bigint {
  const base = current.quantity > 0 ? current : original;
  if (base.quantity === 0) return 0n;
  const g = BigInt(base.gross_minor), n = BigInt(base.quantity);
  return (2n * g * BigInt(q) + n) / (2n * n);
}
/** The corrected FV-S invoice as the correction rules need it (from its stored snapshot). */
export function correctionOriginalOf(s: Pick<Invoice230Snapshot, 'currency' | 'nbp' | 'buyer' | 'lines' | 'categories'>): CorrectionOriginal {
  return { currency: s.currency, mid: s.nbp?.mid ?? null, country: s.buyer.address.country,
    lines: s.lines.map(l => ({ line_no: l.line_no, kind: l.kind, sku: l.sku, name: l.name, item_id: l.item_id, unit: l.unit, quantity: l.quantity,
      gross_minor: l.gross_minor, net_minor: l.net_minor, vat_minor: l.vat_minor, rate_code: l.rate_code, rate: l.rate, gtu: l.gtu, annex15: l.annex15 })),
    categories: s.categories.map(c => ({ key: c.key, rate_code: c.rate_code, rate: c.rate, net_minor: c.net_minor, vat_minor: c.vat_minor, gross_minor: c.gross_minor })) };
}
/** State of the invoice itself (before its first correction). */
export const originalState = (o: CorrectionOriginal): StateLine[] =>
  o.lines.map(l => ({ line_no: l.line_no, quantity: l.quantity, gross_minor: l.gross_minor, net_minor: l.net_minor, vat_minor: l.vat_minor }));

const add = (a: Amounts, b: Amounts): Amounts => ({ net_minor: String(BigInt(a.net_minor) + BigInt(b.net_minor)), vat_minor: String(BigInt(a.vat_minor) + BigInt(b.vat_minor)), gross_minor: String(BigInt(a.gross_minor) + BigInt(b.gross_minor)) });
const sub = (a: Amounts, b: Amounts): Amounts => ({ net_minor: String(BigInt(a.net_minor) - BigInt(b.net_minor)), vat_minor: String(BigInt(a.vat_minor) - BigInt(b.vat_minor)), gross_minor: String(BigInt(a.gross_minor) - BigInt(b.gross_minor)) });
const ZERO: Amounts = { net_minor: '0', vat_minor: '0', gross_minor: '0' };
const plnOf = (a: Amounts, mid: bigint): Pln => {
  const n = toPlnMinor(BigInt(a.net_minor), mid), v = toPlnMinor(BigInt(a.vat_minor), mid);
  return { net_pln_minor: String(n), vat_pln_minor: String(v), gross_pln_minor: String(n + v) };
};
const plnSub = (a: Pln, b: Pln): Pln => ({ net_pln_minor: String(BigInt(a.net_pln_minor) - BigInt(b.net_pln_minor)), vat_pln_minor: String(BigInt(a.vat_pln_minor) - BigInt(b.vat_pln_minor)), gross_pln_minor: String(BigInt(a.gross_pln_minor) - BigInt(b.gross_pln_minor)) });
const plnAdd = (a: Pln, b: Pln): Pln => ({ net_pln_minor: String(BigInt(a.net_pln_minor) + BigInt(b.net_pln_minor)), vat_pln_minor: String(BigInt(a.vat_pln_minor) + BigInt(b.vat_pln_minor)), gross_pln_minor: String(BigInt(a.gross_pln_minor) + BigInt(b.gross_pln_minor)) });
const PLN_ZERO: Pln = { net_pln_minor: '0', vat_pln_minor: '0', gross_pln_minor: '0' };

/** Category totals of a state, every category of the invoice (also those at zero), in P_13 order. */
export function stateCategories(o: CorrectionOriginal, state: readonly StateLine[]): Map<string, Amounts> {
  const out = new Map<string, Amounts>(o.categories.map(c => [c.key, ZERO]));
  for (const s of state) {
    const l = o.lines.find(x => x.line_no === s.line_no)!, k = keyOf(l);
    out.set(k, add(out.get(k) ?? ZERO, s));
  }
  return out;
}

/** The correction from the current state with the requested edits. Every refusal is a Polish sentence. */
export function correctionMath(o: CorrectionOriginal, current: readonly StateLine[], mode: CorrectionRequest['mode'], reason: CorrectionReason, edits: readonly LineEdit[]): CorrectionDecision {
  const blockers: string[] = [], seen = new Set<number>();
  const byNo = new Map(current.map(s => [s.line_no, s]));
  const next = new Map(current.map(s => [s.line_no, s]));
  if (current.length !== o.lines.length || o.lines.some(l => !byNo.has(l.line_no))) blockers.push('Stan pozycji faktury jest niepełny');
  for (const e of edits) {
    const l = o.lines.find(x => x.line_no === e.line_no), cur = byNo.get(e.line_no);
    if (!l || !cur) { blockers.push(`Pozycja ${e.line_no} nie istnieje na fakturze`); continue; }
    if (seen.has(e.line_no)) { blockers.push(`Pozycja ${e.line_no} występuje w korekcie więcej niż raz`); continue; }
    seen.add(e.line_no);
    const label = l.sku || l.name;
    if (e.quantity > l.quantity) { blockers.push(`${label}: ilość po korekcie (${e.quantity}) przekracza ilość zafakturowaną (${l.quantity})`); continue; }
    const gross = e.gross_minor === undefined ? proportionalGross(cur, l, e.quantity) : BigInt(e.gross_minor);
    if (e.quantity === 0 && gross !== 0n) { blockers.push(`${label}: pozycja z ilością 0 nie może mieć wartości`); continue; }
    next.set(e.line_no, { line_no: e.line_no, quantity: e.quantity, ...lineAmounts(l, gross) });
  }
  const rows: CorrectionRow[] = [];
  for (const l of o.lines) {
    const b = byNo.get(l.line_no), a = next.get(l.line_no);
    if (!b || !a || (b.quantity === a.quantity && b.gross_minor === a.gross_minor)) continue;
    rows.push({ line_no: l.line_no, kind: l.kind, sku: l.sku, name: l.name, item_id: l.item_id, unit: l.unit, rate_code: l.rate_code, rate: l.rate, gtu: l.gtu, annex15: l.annex15,
      before: { quantity: b.quantity, net_minor: b.net_minor, vat_minor: b.vat_minor, gross_minor: b.gross_minor },
      after: { quantity: a.quantity, net_minor: a.net_minor, vat_minor: a.vat_minor, gross_minor: a.gross_minor },
      delta: { quantity: a.quantity - b.quantity, ...sub(a, b) } });
  }
  const before = stateCategories(o, current), stateAfter = o.lines.map(l => next.get(l.line_no)!).filter(Boolean), after = stateCategories(o, stateAfter);
  const totalBefore = [...before.values()].reduce(add, ZERO);
  if (mode === 'cancellation' && BigInt(totalBefore.gross_minor) === 0n) blockers.push('Faktura jest już skorygowana do zera — kolejna korekta anulująca nie jest możliwa');
  else if (!rows.length && !blockers.length) blockers.push('Korekta nie zmienia żadnej pozycji faktury');
  const up = rows.some(r => BigInt(r.delta.gross_minor) > 0n || r.delta.quantity > 0), down = rows.some(r => BigInt(r.delta.gross_minor) < 0n || r.delta.quantity < 0);
  if (up && down) blockers.push('Korekta nie może jednocześnie zwiększać i zmniejszać pozycji — wystaw dwie osobne korekty');
  const direction = up && !down ? 'increase' as const : 'decrease' as const;
  const allowed = CORRECTION_REASONS[reason].direction;
  if (rows.length && !(up && down) && allowed !== direction)
    blockers.push(direction === 'increase'
      ? `Przyczyna „${CORRECTION_REASONS[reason].label}” dotyczy korekty zmniejszającej; korekta zwiększająca wymaga przyczyny powstałej po sprzedaży (podwyższenie ceny, cofnięcie korekty)`
      : `Przyczyna „${CORRECTION_REASONS[reason].label}” dotyczy korekty zwiększającej`);
  if (mode === 'cancellation' && stateAfter.some(s => s.quantity !== 0 || BigInt(s.gross_minor) !== 0n)) blockers.push('Korekta anulująca musi zerować wszystkie pozycje');
  if (o.currency === 'EUR' && o.mid === null) blockers.push('Faktura w EUR nie ma zapisanego kursu NBP — korekty nie można przeliczyć');
  const mid = o.mid === null ? null : midScaled(o.mid);
  const touched = new Set(rows.map(r => keyOf(r)));
  const categories: CorrectionCategory[] = [...before.keys()].filter(k => touched.has(k)).map(k => {
    const c = o.categories.find(x => x.key === k)!, f = FA3_SUMMARY_FIELD[c.rate_code]!, b = before.get(k)!, a = after.get(k)!;
    const pb = mid === null ? null : plnOf(b, mid), pa = mid === null ? null : plnOf(a, mid);
    return { key: k, rate_code: c.rate_code, rate: c.rate, fa3_net: f.net, fa3_vat: f.vat,
      label: c.rate_code === 'oss' ? `OSS ${o.country} ${c.rate!.replace('.', ',')}%` : f.label, before: b, after: a, delta: sub(a, b),
      pln: pb && pa ? { before: pb, after: pa, delta: plnSub(pa, pb) } : null };
  }).sort((x, y) => FA3_ORDER.indexOf(x.rate_code) - FA3_ORDER.indexOf(y.rate_code) || x.key.localeCompare(y.key));
  const totals = { before: totalBefore, after: [...after.values()].reduce(add, ZERO), delta: ZERO };
  totals.delta = sub(totals.after, totals.before);
  const sumDelta = categories.reduce((s, c) => add(s, c.delta), ZERO);
  if (sumDelta.gross_minor !== totals.delta.gross_minor || sumDelta.net_minor !== totals.delta.net_minor) blockers.push('Różnice kategorii nie sumują się do różnicy korekty');
  let plnTotals: CorrectionMath['pln_totals'] = null;
  if (mid !== null) {
    const pb = [...before.values()].map(x => plnOf(x, mid)).reduce(plnAdd, PLN_ZERO), pa = [...after.values()].map(x => plnOf(x, mid)).reduce(plnAdd, PLN_ZERO);
    plnTotals = { before: pb, after: pa, delta: plnSub(pa, pb) };
  }
  const kind: CorrectionKind = mode === 'return' ? 'return' : mode === 'cancellation' ? 'cancellation'
    : rows.every(r => r.delta.quantity !== 0) ? 'quantity' : rows.every(r => r.delta.quantity === 0) ? 'price' : 'mixed';
  return { blockers, math: { kind, direction, rows, categories, state_after: stateAfter, totals, pln_totals: plnTotals } };
}

/** Edits of a full cancellation: every line to quantity 0 and value 0. */
export const cancellationEdits = (current: readonly StateLine[]): LineEdit[] => current.map(s => ({ line_no: s.line_no, quantity: 0, gross_minor: '0' }));

export type ReturnItem = { item_id: string; sku: string; accepted: number; refund_amount: number };
/** Edits of a return case: each accepted item lowers its line by the accepted quantity and the refund
 * the return computed for it; the shipping refund lowers the shipping line. */
export function returnEdits(o: CorrectionOriginal, current: readonly StateLine[], items: readonly ReturnItem[], shippingRefund: number): { edits: LineEdit[]; blockers: string[] } {
  const edits: LineEdit[] = [], blockers: string[] = [];
  for (const i of items) {
    if (i.accepted <= 0 && i.refund_amount <= 0) continue;
    const l = o.lines.find(x => x.kind === 'item' && x.item_id === i.item_id), cur = l && current.find(s => s.line_no === l.line_no);
    if (!l || !cur) { blockers.push(`${i.sku}: pozycji zwrotu nie ma na fakturze`); continue; }
    if (i.accepted > cur.quantity) { blockers.push(`${i.sku}: zwrot (${i.accepted}) przekracza ilość na fakturze po korektach (${cur.quantity})`); continue; }
    if (BigInt(i.refund_amount) > BigInt(cur.gross_minor)) { blockers.push(`${i.sku}: kwota zwrotu przekracza wartość pozycji po korektach`); continue; }
    edits.push({ line_no: l.line_no, quantity: cur.quantity - i.accepted, gross_minor: String(BigInt(cur.gross_minor) - BigInt(i.refund_amount)) });
  }
  if (shippingRefund > 0) {
    const l = o.lines.find(x => x.kind === 'shipping'), cur = l && current.find(s => s.line_no === l.line_no);
    if (!l || !cur) blockers.push('Zwrot kosztu dostawy: faktura nie ma pozycji dostawy');
    else if (BigInt(shippingRefund) > BigInt(cur.gross_minor)) blockers.push('Zwrot kosztu dostawy przekracza wartość dostawy po korektach');
    else { const g = BigInt(cur.gross_minor) - BigInt(shippingRefund); edits.push({ line_no: l.line_no, quantity: g === 0n ? 0 : cur.quantity, gross_minor: String(g) }); }
  }
  if (!edits.length && !blockers.length) blockers.push('Zwrot nie ma przyjętych pozycji ani kwoty do skorygowania');
  return { edits, blockers };
}
