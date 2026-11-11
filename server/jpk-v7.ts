/** JPK_V7M / JPK_V7K (wariant 3): ewidencja sprzedaży built from the app's issued documents and the
 * cash-register daily reports (233: one `RO` row per report), and the deklaracja part computed from the
 * same rows. An invoice issued to a receipt is listed with `FP` and left out of SprzedazCtrl and the
 * declaration (art. 109 ust. 3d: its sale is already in RO). Pure: the caller gives the documents of the period
 * (and of the quarter for the V7K declaration) and the generation time. ZakupWiersz is empty —
 * the app has no purchase register. Element names, order and pairs as in the MF schemas JPK_V7M(3)
 * crd.gov.pl 2025/12/19/14090 and JPK_V7K(3) 2025/12/19/14089 (schemas/mf, validated in tests and
 * before every download). */
import { createHash } from 'node:crypto';
import type { Fa3RateCode } from './fa3-render';
import {
  JPK_MAX_BYTES, JPK_SYSTEM_NAME, JpkError, jpkGenerationTime, jpkMoney, jpkWholeZloty, plnBuckets, xmlTag,
  type JpkDocument, type JpkTaxpayer,
} from './jpk-model';
import { NO_RECEIPT_SALES, RO_K_OF, checkedReceiptSales, roNumber, type JpkDailyReport, type JpkReceiptSales } from './jpk-receipts';

export const JPK_V7M_NAMESPACE = 'http://crd.gov.pl/wzor/2025/12/19/14090/';
export const JPK_V7K_NAMESPACE = 'http://crd.gov.pl/wzor/2025/12/19/14089/';
export const JPK_ETD_NAMESPACE = 'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/09/13/eD/DefinicjeTypy/';
export type JpkV7Variant = 'M' | 'K';
/** JPK_V7(3) applies from the February 2026 period (yyyymm). */
export const JPK_V7_FIRST_PERIOD = 202602;
const FORM = {
  M: { ns: JPK_V7M_NAMESPACE, code: 'JPK_V7M (3)', decl: 'VAT-7', declCode: 'VAT-7 (23)', declVariant: '23' },
  K: { ns: JPK_V7K_NAMESPACE, code: 'JPK_V7K (3)', decl: 'VAT-7K', declCode: 'VAT-7K (17)', declVariant: '17' },
} as const;

/** K_ fields a document of this app can fill, in schema order. */
export const V7_K_FIELDS = ['K_10', 'K_11', 'K_12', 'K_13', 'K_14', 'K_15', 'K_16', 'K_17', 'K_18', 'K_19', 'K_20', 'K_21', 'K_22', 'K_23', 'K_24', 'K_25', 'K_26',
  'K_27', 'K_28', 'K_29', 'K_30', 'K_31', 'K_32', 'K_33', 'K_34', 'K_35', 'K_36'] as const;
export type V7KField = typeof V7_K_FIELDS[number];
/** FA(3) rate code → K_ net field, K_ VAT field and the "w tym" field K_12 (art. 100 ust. 1 pkt 4).
 * `oo` (domestic reverse charge, FA(3) P_13_10) has no field in JPK_V7(3): its K_31/K_32 are the buyer's
 * art. 17 ust. 1 pkt 5 (the seller fields of art. 17 ust. 1 pkt 7 i 8 of JPK_V7(2) are gone). Its amount is
 * therefore in no K_ field; the invoice still has its row (number, buyer, KSeF marker) so that every
 * issued invoice is in the ewidencja, also one with `oo` lines only. */
const K_OF: Record<Exclude<Fa3RateCode, 'oo'>, { net: V7KField; vat: V7KField | null; also: V7KField | null }> = {
  'zw': { net: 'K_10', vat: null, also: null },
  'np I': { net: 'K_11', vat: null, also: null },
  'np II': { net: 'K_11', vat: null, also: 'K_12' },
  'oss': { net: 'K_11', vat: null, also: null },
  '0 KR': { net: 'K_13', vat: null, also: null },
  '5': { net: 'K_15', vat: 'K_16', also: null },
  '8': { net: 'K_17', vat: 'K_18', also: null },
  '23': { net: 'K_19', vat: 'K_20', also: null },
  '0 WDT': { net: 'K_21', vat: null, also: null },
  '0 EX': { net: 'K_22', vat: null, also: null },
};
/** K_ fields the schema requires together (net and VAT of one rate). */
const K_PAIRS: readonly [V7KField, V7KField][] = [['K_15', 'K_16'], ['K_17', 'K_18'], ['K_19', 'K_20'], ['K_23', 'K_24'], ['K_25', 'K_26'], ['K_27', 'K_28'], ['K_29', 'K_30'], ['K_31', 'K_32']];
/** Zero K_ fields are left out, except the partner of a non-zero field of a pair. */
function compact(k: Partial<Record<V7KField, bigint>>): Partial<Record<V7KField, bigint>> {
  for (const f of V7_K_FIELDS) if (k[f] === 0n) delete k[f];
  for (const [a, b] of K_PAIRS) if (k[a] !== undefined || k[b] !== undefined) { k[a] ??= 0n; k[b] ??= 0n; }
  return k;
}
/** SprzedazCtrl/PodatekNalezny and P_38: VAT fields added, K_35/K_36 subtracted. */
const VAT_PLUS: readonly V7KField[] = ['K_16', 'K_18', 'K_20', 'K_24', 'K_26', 'K_28', 'K_30', 'K_32', 'K_33', 'K_34'];
const VAT_MINUS: readonly V7KField[] = ['K_35', 'K_36'];
/** P_37: sum of the net fields. */
const NET_FIELDS: readonly V7KField[] = ['K_10', 'K_11', 'K_13', 'K_15', 'K_17', 'K_19', 'K_21', 'K_22', 'K_23', 'K_25', 'K_27', 'K_29', 'K_31'];

export type V7Row = {
  /** KodKrajuNadaniaTIN: country of a buyer identified by an EU VAT number (ISO code, GR for Greece). */
  buyer_tin_country?: string | null;
  number: string; buyer_nip: string | null; buyer_name: string; issue_date: string; sale_date: string | null;
  /** No MPP: JPK_V7(3) has no split-payment marker in the ewidencja sprzedaży. */
  gtu: string[]; wsto_ee: boolean; k: Partial<Record<V7KField, bigint>>;
  /** NrKSeF of the document, OFF (offline, not yet numbered), BFK (invoice issued outside KSeF) or DI (a sales document other than an invoice: RO). */
  ksef: { number: string } | 'OFF' | 'BFK' | 'DI';
  /** TypDokumentu: RO = summary of a daily fiscal report; FP = invoice to a receipt (in the ewidencja, not in the sums). */
  document_type?: 'RO' | 'FP';
};
/** One SprzedazWiersz per invoice or correction (corrections with their signed difference, in the
 * period of the correction). A document whose every K_ amount is zero has no row, unless it has an
 * `oo` amount (no K_ field in JPK_V7(3)): that row is kept without K_ fields. */
export function v7Row(d: JpkDocument): V7Row | null {
  const m = d.model, k: Partial<Record<V7KField, bigint>> = {};
  const add = (f: V7KField, v: bigint) => { k[f] = (k[f] ?? 0n) + v; };
  let pln;
  try { pln = plnBuckets(d); } catch (e) { if (e instanceof JpkError) throw new JpkError(409, e.message, [{ number: m.number, reason: e.message }]); throw e; }
  let reverseCharge = false;
  for (const b of pln) {
    if (b.code === 'oo') { reverseCharge ||= b.net !== 0n; continue; }
    const f = K_OF[b.code];
    add(f.net, b.net);
    if (f.vat) add(f.vat, b.vat);
    if (f.also) add(f.also, b.net);
  }
  if (!Object.keys(compact(k)).length && !reverseCharge) return null;
  const gtu = [...new Set(m.lines.map(l => l.gtu).filter((g): g is string => g !== null))].sort();
  const eu = m.buyer.nip === null && m.buyer.vat_ue ? m.buyer.vat_ue : null;
  return { number: m.number, buyer_nip: eu ? eu.number : m.buyer.nip, ...(eu ? { buyer_tin_country: m.buyer.address.country } : {}), buyer_name: m.buyer.name, issue_date: m.issue_date,
    sale_date: m.sale_date !== null && m.sale_date !== m.issue_date ? m.sale_date : null, gtu,
    wsto_ee: m.buckets.some(b => b.code === 'oss'), k,
    ksef: d.ksef?.number ? { number: d.ksef.number } : d.ksef?.offline ? 'OFF' : 'BFK', ...(m.receipt ? { document_type: 'FP' as const } : {}) };
}
/** RO row of a daily report (checked by `checkedReceiptSales`): K_ per PTU total, net = gross − VAT of the register. */
export function roRow(r: JpkDailyReport): V7Row | null {
  const k: Partial<Record<V7KField, bigint>> = {};
  for (const t of r.totals) {
    const f = RO_K_OF[t.value!];
    k[f.net] = (k[f.net] ?? 0n) + t.gross_minor - t.vat_minor;
    if (f.vat) k[f.vat] = (k[f.vat] ?? 0n) + t.vat_minor;
  }
  if (!Object.keys(compact(k)).length) return null;
  return { number: roNumber(r), buyer_nip: null, buyer_name: 'brak', issue_date: r.fiscal_date, sale_date: null, gtu: [], wsto_ee: false, k, ksef: 'DI', document_type: 'RO' };
}

export type V7Totals = Record<V7KField, bigint>;
/** Sums of the K_ fields without the FP rows (their sale is in RO). */
export function v7Totals(rows: readonly V7Row[]): V7Totals {
  const t = Object.fromEntries(V7_K_FIELDS.map(f => [f, 0n])) as V7Totals;
  for (const r of rows) if (r.document_type !== 'FP') for (const f of V7_K_FIELDS) t[f] += r.k[f] ?? 0n;
  return t;
}
/** SprzedazCtrl/PodatekNalezny in grosze. */
export const v7OutputVat = (t: V7Totals) => VAT_PLUS.reduce((n, f) => n + t[f], 0n) - VAT_MINUS.reduce((n, f) => n + t[f], 0n);

export type V7Declaration = Record<string, bigint>;
/** Deklaracja in whole złoty. P_10…P_36 = rounded sums of K_10…K_36; P_37/P_38 sums of rounded
 * fields; no purchases, so P_48 = P_39 (surplus carried from the previous declaration). */
export function v7Declaration(t: V7Totals, surplus: bigint): V7Declaration {
  const p: V7Declaration = {};
  for (const f of V7_K_FIELDS) p['P_' + f.slice(2)] = jpkWholeZloty(t[f]);
  const P = (f: V7KField) => p['P_' + f.slice(2)]!;
  p.P_37 = NET_FIELDS.reduce((n, f) => n + P(f), 0n);
  p.P_38 = VAT_PLUS.reduce((n, f) => n + P(f), 0n) - VAT_MINUS.reduce((n, f) => n + P(f), 0n);
  p.P_39 = surplus;
  p.P_48 = surplus;
  p.P_51 = p.P_38 > p.P_48 ? p.P_38 - p.P_48 : 0n;
  p.P_53 = p.P_48 > p.P_38 ? p.P_48 - p.P_38 : 0n;
  p.P_62 = p.P_53;
  return p;
}
const DECLARATION_ORDER = [...V7_K_FIELDS.map(f => 'P_' + f.slice(2)), 'P_37', 'P_38', 'P_39', 'P_48', 'P_51', 'P_53', 'P_62'];
/** Always present: P_37, P_38, P_48, P_51; the rest only when not zero, or as the partner of a non-zero
 * field of a pair the schema requires together (P_11 before P_12, net and VAT of one rate). */
const DECLARATION_REQUIRED = new Set(['P_37', 'P_38', 'P_48', 'P_51']);
const DECLARATION_PAIRS: readonly [string, string][] = [['P_11', 'P_12'], ['P_13', 'P_14'], ...K_PAIRS.map(([a, b]) => ['P_' + a.slice(2), 'P_' + b.slice(2)] as [string, string])];
const declared = (p: V7Declaration, k: string) => DECLARATION_REQUIRED.has(k) || p[k] !== 0n ||
  DECLARATION_PAIRS.some(([a, b]) => (k === a && p[b] !== 0n) || (k === b && p[a] !== 0n && a !== 'P_11' && a !== 'P_13'));

export type V7Input = {
  variant: JpkV7Variant; year: number; month: number; taxpayer: JpkTaxpayer; generated_at: string;
  /** Documents whose tax date is in the month (ewidencja). */
  documents: readonly JpkDocument[];
  /** V7K last month of a quarter: documents of the whole quarter (deklaracja). V7M: ignored. */
  quarter_documents?: readonly JpkDocument[];
  /** 233 daily reports and unreported days of the loaded range; the month (and, for the V7K declaration, the quarter) is taken from it. */
  receipt_sales?: JpkReceiptSales;
  surplus_zloty: bigint;
};
export type V7Rendered = { xml: string; xml_sha256: string; xml_bytes: number; rows: number; output_vat_minor: bigint;
  declaration: V7Declaration | null; filename: string };

const isQuarterEnd = (month: number) => month % 3 === 0;
const sortKey = (r: JpkDocument) => `${r.tax_date}\u0000${r.model.issue_date}\u0000${r.model.number}\u0000${r.id}`;
const roKey = (r: JpkDailyReport) => `${r.fiscal_date}\u0000${r.fiscal_date}\u0000${roNumber(r)}\u0000${r.id}`;
const monthsOf = (year: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${year}-${String(from + i).padStart(2, '0')}`);

export function renderJpkV7(input: V7Input): V7Rendered {
  const f = FORM[input.variant], generated = jpkGenerationTime(input.generated_at), tp = input.taxpayer;
  if (!Number.isInteger(input.year) || input.year > 2050 || !Number.isInteger(input.month) || input.month < 1 || input.month > 12 || input.year * 100 + input.month < JPK_V7_FIRST_PERIOD)
    throw new JpkError(400, 'Okres JPK_V7(3) poza zakresem: od 2026-02 do 2050-12');
  if (!tp.email) throw new JpkError(400, 'JPK_V7 wymaga adresu e-mail podatnika');
  if (input.surplus_zloty < 0n) throw new JpkError(400, 'Nadwyżka z poprzedniej deklaracji nie może być ujemna');
  const period = `${input.year}-${String(input.month).padStart(2, '0')}`;
  for (const d of input.documents) if (d.tax_date.slice(0, 7) !== period) throw new JpkError(422, 'Dokument spoza okresu pliku');
  const receiptSales = input.receipt_sales ?? NO_RECEIPT_SALES;
  // Documents and RO rows in date order (an RO is dated by its fiscal date).
  const rowsOf = (docs: readonly JpkDocument[], months: readonly string[]) => {
    const refusals: { number: string; reason: string }[] = [], keyed: [string, V7Row][] = [];
    for (const d of docs) {
      try { const r = v7Row(d); if (r) keyed.push([sortKey(d), r]); } catch (e) { if (e instanceof JpkError && e.documents.length) refusals.push(...e.documents); else throw e; }
    }
    if (refusals.length) throw new JpkError(409, 'Części dokumentów okresu nie da się ująć w JPK_V7', refusals);
    for (const rep of checkedReceiptSales(receiptSales, months)) { const r = roRow(rep); if (r) keyed.push([roKey(rep), r]); }
    return keyed.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(x => x[1]);
  };
  const rows = rowsOf(input.documents, [period]);
  const totals = v7Totals(rows), outputVat = v7OutputVat(totals);
  const withDeclaration = input.variant === 'M' || isQuarterEnd(input.month);
  let declaration: V7Declaration | null = null;
  if (withDeclaration) {
    let quarter = rows;
    if (input.variant === 'K') {
      const q = input.quarter_documents ?? fail(), first = input.month - 2;
      if (q.some(d => d.tax_date.slice(0, 4) !== String(input.year) || Number(d.tax_date.slice(5, 7)) < first || Number(d.tax_date.slice(5, 7)) > input.month))
        throw new JpkError(422, 'Dokument spoza kwartału deklaracji');
      quarter = rowsOf(q, monthsOf(input.year, first, input.month));
    }
    declaration = v7Declaration(v7Totals(quarter), input.surplus_zloty);
  }
  const podmiot = tp.person
    ? `<OsobaFizyczna>${xmlTag('etd:NIP', tp.nip)}${xmlTag('etd:ImiePierwsze', tp.person.first_name)}${xmlTag('etd:Nazwisko', tp.person.last_name)}` +
      `${xmlTag('etd:DataUrodzenia', tp.person.birth_date)}${xmlTag('Email', tp.email)}${tp.phone ? xmlTag('Telefon', tp.phone) : ''}</OsobaFizyczna>`
    : `<OsobaNiefizyczna>${xmlTag('NIP', tp.nip)}${xmlTag('PelnaNazwa', tp.name)}${xmlTag('Email', tp.email)}${tp.phone ? xmlTag('Telefon', tp.phone) : ''}</OsobaNiefizyczna>`;
  const decl = declaration
    ? '<Deklaracja><Naglowek>' +
      `<KodFormularzaDekl kodSystemowy="${f.declCode}" kodPodatku="VAT" rodzajZobowiazania="Z" wersjaSchemy="1-0E">${f.decl}</KodFormularzaDekl>` +
      xmlTag('WariantFormularzaDekl', f.declVariant) + (input.variant === 'K' ? xmlTag('Kwartal', String(input.month / 3)) : '') + '</Naglowek><PozycjeSzczegolowe>' +
      DECLARATION_ORDER.filter(k => declared(declaration!, k)).map(k => xmlTag(k, declaration![k]!.toString())).join('') +
      '</PozycjeSzczegolowe><Pouczenia>1</Pouczenia></Deklaracja>'
    : '';
  const sales = rows.map((r, i) => '<SprzedazWiersz>' + xmlTag('LpSprzedazy', String(i + 1)) +
    (r.buyer_tin_country ? xmlTag('KodKrajuNadaniaTIN', r.buyer_tin_country) : '') + xmlTag('NrKontrahenta', r.buyer_nip ?? 'brak') + xmlTag('NazwaKontrahenta', r.buyer_name) + xmlTag('DowodSprzedazy', r.number) +
    xmlTag('DataWystawienia', r.issue_date) + (r.sale_date ? xmlTag('DataSprzedazy', r.sale_date) : '') +
    // NrKSeF when 229 stored a number, OFF for an offline invoice still to be sent, else BFK (issued outside KSeF).
    (r.ksef === 'BFK' ? '<BFK>1</BFK>' : r.ksef === 'OFF' ? '<OFF>1</OFF>' : r.ksef === 'DI' ? '<DI>1</DI>' : xmlTag('NrKSeF', r.ksef.number)) +
    (r.document_type ? xmlTag('TypDokumentu', r.document_type) : '') + r.gtu.map(g => `<${g}>1</${g}>`).join('') + (r.wsto_ee ? '<WSTO_EE>1</WSTO_EE>' : '') +
    V7_K_FIELDS.filter(k => r.k[k] !== undefined).map(k => xmlTag(k, jpkMoney(r.k[k]!))).join('') + '</SprzedazWiersz>').join('');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<JPK xmlns="${f.ns}" xmlns:etd="${JPK_ETD_NAMESPACE}"><Naglowek>` +
    `<KodFormularza kodSystemowy="${f.code}" wersjaSchemy="1-0E">JPK_VAT</KodFormularza><WariantFormularza>3</WariantFormularza>` +
    xmlTag('DataWytworzeniaJPK', generated) + xmlTag('NazwaSystemu', JPK_SYSTEM_NAME) + `<CelZlozenia poz="P_7">${tp.purpose}</CelZlozenia>` +
    xmlTag('KodUrzedu', tp.office) + xmlTag('Rok', String(input.year)) + xmlTag('Miesiac', String(input.month)) + '</Naglowek>' +
    `<Podmiot1 rola="Podatnik">${podmiot}</Podmiot1>` + decl + '<Ewidencja>' + sales +
    `<SprzedazCtrl>${xmlTag('LiczbaWierszySprzedazy', String(rows.length))}${xmlTag('PodatekNalezny', jpkMoney(outputVat))}</SprzedazCtrl>` +
    '<ZakupCtrl><LiczbaWierszyZakupow>0</LiczbaWierszyZakupow><PodatekNaliczony>0.00</PodatekNaliczony></ZakupCtrl></Ewidencja></JPK>\n';
  const bytes = Buffer.byteLength(xml, 'utf8');
  if (bytes > JPK_MAX_BYTES) throw new JpkError(413, 'Plik JPK przekracza dopuszczalny rozmiar');
  return { xml, xml_sha256: createHash('sha256').update(xml, 'utf8').digest('hex'), xml_bytes: bytes, rows: rows.length, output_vat_minor: outputVat,
    declaration, filename: `JPK_V7${input.variant}-${period}.xml` };
}
function fail(): never { throw new JpkError(422, 'Deklaracja VAT-7K wymaga dokumentów całego kwartału'); }
