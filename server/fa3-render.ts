/** Pure FA(3) XML of one normalized document (FV or KOR). No IO, numbering,
 * authorization or KSeF submission. Element order follows the FA(3) structure
 * already encoded in fa3-xml.ts (Naglowek, Podmiot1, Podmiot2, Fa, Stopka). */
import { createHash } from 'node:crypto';
import { b2bFa3XmlTextValid } from './fa3-draft-model';
import { FA3_XML_NAMESPACE, FA3_XML_MAX_BYTES } from './fa3-xml';

export type Fa3RateCode = '23' | '8' | '5' | '0 KR' | '0 WDT' | '0 EX' | 'zw' | 'np I' | 'np II' | 'oo' | 'oss';
export const FA3_RATE_CODES: readonly Fa3RateCode[] = ['23', '8', '5', '0 KR', '0 WDT', '0 EX', 'zw', 'np I', 'np II', 'oo', 'oss'];
/** Bucket fields: P_13_x (net) and P_14_x (VAT, only taxed rates) per FA(3) code. */
const BUCKETS: readonly { code: Fa3RateCode; net: string; vat: string | null; pln: boolean }[] = [
  { code: '23', net: 'P_13_1', vat: 'P_14_1', pln: true }, { code: '8', net: 'P_13_2', vat: 'P_14_2', pln: true },
  { code: '5', net: 'P_13_3', vat: 'P_14_3', pln: true }, { code: 'oss', net: 'P_13_5', vat: 'P_14_5', pln: false },
  { code: '0 KR', net: 'P_13_6_1', vat: null, pln: false }, { code: '0 WDT', net: 'P_13_6_2', vat: null, pln: false },
  { code: '0 EX', net: 'P_13_6_3', vat: null, pln: false }, { code: 'zw', net: 'P_13_7', vat: null, pln: false },
  { code: 'np I', net: 'P_13_8', vat: null, pln: false }, { code: 'np II', net: 'P_13_9', vat: null, pln: false },
  { code: 'oo', net: 'P_13_10', vat: null, pln: false },
];
/** Codes whose line carries no Polish VAT amount. */
export const FA3_UNTAXED: ReadonlySet<Fa3RateCode> = new Set(['0 KR', '0 WDT', '0 EX', 'zw', 'np I', 'np II', 'oo']);

/** Refusal with the Polish reason shown to the user; status is the HTTP status of the route. */
export class Fa3DocumentError extends Error {
  constructor(public readonly status: 404 | 409 | 413 | 422 | 503, message: string) { super(message); this.name = 'Fa3DocumentError'; }
}
export const fa3Refuse = (message: string): never => { throw new Fa3DocumentError(409, message); };
export const fa3Invalid = (message: string): never => { throw new Fa3DocumentError(422, message); };

export type Fa3Address = { country: string; line1: string; line2: string | null };
/** `vat_ue`: buyer identified by an EU VAT number (KodUE + NrVatUE) instead of a NIP; used only when `nip` is null. */
export type Fa3Party = { nip: string | null; name: string; address: Fa3Address; vat_ue?: { code: string; number: string } | null };
export type Fa3Line = {
  name: string; unit: string; quantity: string;
  /** P_9B / P_10, given only when quantity × price − discount equals the line value. */
  unit_gross_minor: bigint | null; discount_gross_minor: bigint | null;
  gross_minor: bigint; code: Fa3RateCode; oss_rate: string | null;
  uu_id: string | null; gtu: string | null; annex15: boolean; fx_rate: string | null;
  /** KOR: the state before the correction (StanPrzed=1). */
  before: boolean;
  /** Free text for this row (DodatkowyOpis NrWiersza), e.g. the basis of a domestic 0%. */
  note: { key: string; value: string } | null;
};
export type Fa3Bucket = { code: Fa3RateCode; net_minor: bigint; vat_minor: bigint; vat_pln_minor: bigint | null };
export type Fa3Correction = { reason: string; type: 1 | 2 | 3; original: { number: string; issue_date: string; ksef_number: string | null } };
export type Fa3Document = {
  kind: 'VAT' | 'KOR'; number: string; issue_date: string; sale_date: string | null; currency: string;
  seller: Fa3Party; buyer: Fa3Party; buckets: Fa3Bucket[]; total_gross_minor: bigint;
  reverse_charge: boolean; split_payment: boolean;
  exemption: { kind: 'P_19A' | 'P_19B' | 'P_19C'; text: string } | null;
  correction: Fa3Correction | null; lines: Fa3Line[]; due_date: string | null; footer: string[]; system_info: string;
  /** 233: invoice issued to this fiscal receipt — Fa/FP = 1 (art. 109 ust. 3d) and a DodatkowyOpis with the receipt. */
  receipt?: { number: string; fiscal_date: string; printer_unique_number: string } | null;
};
export type Fa3Rendered = { format: 'FA (3)/1-0E'; namespace: string; kind: 'VAT' | 'KOR'; number: string; generated_at: string;
  xml: string; xml_sha256: string; xml_bytes: number; ksef_state: 'not_submitted' };

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const tag = (name: string, value: string) => `<${name}>${escape(value)}</${name}>`;
/** FA(3) TKwotowy: up to 16 integer digits and exactly 2 decimals; signed for corrections. */
const MONEY_LIMIT = 999999999999999999n;
export function fa3Money(value: bigint): string {
  const abs = value < 0n ? -value : value;
  if (abs > MONEY_LIMIT) fa3Refuse('Kwota przekracza zakres pola kwotowego FA(3)');
  return `${value < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
const day = (v: string, min: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T12:00:00Z').toISOString().slice(0, 10) === v && v >= min && v <= '2050-01-01';
const NIP = /^[1-9](?:[0-9][1-9]|[1-9][0-9])[0-9]{7}$/;
function text(value: string, max: number, label: string) {
  if (typeof value !== 'string' || !value.length || value.length > max || !b2bFa3XmlTextValid(value)) fa3Refuse(`${label}: tekst pusty, za długi (limit ${max}) lub z niedozwolonymi znakami XML`);
  return value;
}
/** Explicit canonical UTC generation time within the FA(3) DataWytworzeniaFa range. */
export function fa3GenerationTime(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.([0-9]+))?Z$/.exec(value);
  if (!m || Number.isNaN(Date.parse(value)) || m[1] < '2025-09-01T00:00:00' || m[1] > '2050-01-01T23:59:59' || (m[1] === '2050-01-01T23:59:59' && /[1-9]/.test(m[2] ?? '')))
    fa3Invalid('Czas wytworzenia XML FA(3) poza dopuszczalnym zakresem');
  return value;
}

/** Polish reason for a document kind/mode FA(3) does not cover in this app. */
export function fa3UnsupportedReason(kind: string, mode: string): string {
  if (kind === 'proforma') return 'Faktura pro forma nie jest fakturą VAT — struktura FA(3) jej nie obejmuje';
  if (['external', 'simulation', 'provider_test', 'provider_live'].includes(mode))
    return 'Dokument wystawił zewnętrzny system fakturowy — XML FA(3) przygotowuje system, który go wystawił';
  if (mode === 'demo') return 'Dokument demonstracyjny nie jest fakturą — FA(3) nie dotyczy';
  return `Dokument (${kind}/${mode}) nie ma odwzorowania w FA(3) w tej aplikacji`;
}

/** DataWytworzeniaFa = persisted issue time (deterministic bytes); FA(3) accepts it from 2025-09-01. */
export function fa3GenerationTimeOf(createdAt: unknown, now: Date = new Date()): string {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : typeof createdAt === 'string' ? createdAt.replace(/\+00:00$/, 'Z') : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.[0-9]+)?Z$/.test(iso)) fa3Invalid('Nieobsługiwany utrwalony czas dokumentu FA(3)');
  return iso >= '2025-09-01T00:00:00Z' ? iso : now.toISOString();
}

function party(which: 'Podmiot1' | 'Podmiot2', p: Fa3Party) {
  if (p.nip !== null && !NIP.test(p.nip)) fa3Refuse('NIP poza oficjalnym formatem FA(3)');
  if (which === 'Podmiot1' && p.nip === null) fa3Refuse('Sprzedawca bez NIP nie może wystawić faktury FA(3)');
  if (!/^[A-Z]{2}$/.test(p.address.country)) fa3Refuse('Kod kraju adresu poza formatem FA(3)');
  if (p.nip === null && p.vat_ue && (which === 'Podmiot1' || !/^[A-Z]{2}$/.test(p.vat_ue.code) || !/^[A-Z0-9+*]{2,14}$/.test(p.vat_ue.number))) fa3Refuse('Numer VAT UE nabywcy poza formatem FA(3)');
  const id = p.nip !== null ? tag('NIP', p.nip) : p.vat_ue ? tag('KodUE', p.vat_ue.code) + tag('NrVatUE', p.vat_ue.number) : '<BrakID>1</BrakID>';
  return `<${which}><DaneIdentyfikacyjne>${id}${tag('Nazwa', text(p.name, 512, 'Nazwa podmiotu'))}</DaneIdentyfikacyjne>` +
    `<Adres>${tag('KodKraju', p.address.country)}${tag('AdresL1', text(p.address.line1, 512, 'Adres'))}` +
    (p.address.line2 === null ? '' : tag('AdresL2', text(p.address.line2, 512, 'Adres'))) +
    `</Adres>${which === 'Podmiot2' ? '<JST>2</JST><GV>2</GV>' : ''}</${which}>`;
}

/** Renders the normalized document; equal input gives equal bytes. */
export function renderFa3Document(d: Fa3Document, generatedAt: string): Fa3Rendered {
  const generated = fa3GenerationTime(generatedAt);
  if (!day(d.issue_date, '2006-01-01')) fa3Refuse('Data wystawienia poza zakresem FA(3)');
  if (generated.slice(0, 10) < d.issue_date) fa3Invalid('Czas wytworzenia XML poprzedza datę wystawienia');
  if (d.sale_date !== null && !day(d.sale_date, '2006-01-01')) fa3Refuse('Data sprzedaży poza zakresem FA(3)');
  // FA(3) Termin uses TData (2016..2050), unlike issue/sale TDataT (2006..2050).
  if (d.due_date !== null && !day(d.due_date, '2016-07-01')) fa3Refuse('Termin płatności poza zakresem pola Termin FA(3)');
  if (!/^[A-Z]{3}$/.test(d.currency)) fa3Refuse('Kod waluty poza formatem FA(3)');
  text(d.number, 256, 'Numer faktury');
  const foreign = d.currency !== 'PLN';
  let tax = '';
  for (const b of BUCKETS) {
    const v = d.buckets.find(x => x.code === b.code);
    if (!v) continue;
    if (!b.vat && v.vat_minor !== 0n) fa3Refuse(`Stawka ${b.code} nie może mieć kwoty VAT`);
    tax += tag(b.net, fa3Money(v.net_minor)) + (b.vat ? tag(b.vat, fa3Money(v.vat_minor)) : '');
    if (b.vat && b.pln && foreign) {
      if (v.vat_pln_minor === null) fa3Refuse('Faktura w walucie obcej wymaga kwoty VAT w PLN (kurs NBP)');
      tax += tag(b.vat + 'W', fa3Money(v.vat_pln_minor!));
    }
  }
  if (d.buckets.length !== new Set(d.buckets.map(b => b.code)).size) fa3Invalid('Powtórzona stawka w podsumowaniu');
  const zwolnienie = d.exemption
    ? `<Zwolnienie><P_19>1</P_19>${tag(d.exemption.kind, text(d.exemption.text, 256, 'Podstawa zwolnienia'))}</Zwolnienie>`
    : '<Zwolnienie><P_19N>1</P_19N></Zwolnienie>';
  const annotations = `<Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>${d.reverse_charge ? 1 : 2}</P_18><P_18A>${d.split_payment ? 1 : 2}</P_18A>` +
    zwolnienie + '<NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>';
  if (d.receipt && d.kind !== 'VAT') fa3Invalid('Znacznik faktury do paragonu (FP) dotyczy faktury VAT');
  let correction = '';
  if (d.kind === 'KOR') {
    const c = d.correction ?? fa3Invalid('Korekta wymaga danych faktury korygowanej');
    if (!day(c.original.issue_date, '2006-01-01')) fa3Refuse('Data faktury korygowanej poza zakresem FA(3)');
    correction = tag('PrzyczynaKorekty', text(c.reason, 256, 'Przyczyna korekty')) + tag('TypKorekty', String(c.type)) +
      '<DaneFaKorygowanej>' + tag('DataWystFaKorygowanej', c.original.issue_date) + tag('NrFaKorygowanej', text(c.original.number, 256, 'Numer faktury korygowanej')) +
      (c.original.ksef_number ? '<NrKSeF>1</NrKSeF>' + tag('NrKSeFFaKorygowanej', c.original.ksef_number) : '<NrKSeFN>1</NrKSeFN>') + '</DaneFaKorygowanej>';
  } else if (d.correction) fa3Invalid('Faktura VAT nie ma danych korekty');
  const receiptMark = d.receipt ? '<FP>1</FP><DodatkowyOpis>' + tag('Klucz', 'Paragon fiskalny') +
    tag('Wartosc', text(`nr ${d.receipt.number} z dnia ${d.receipt.fiscal_date}, kasa ${d.receipt.printer_unique_number}`, 256, 'Paragon fiskalny')) + '</DodatkowyOpis>' : '';
  const notes = d.lines.map((l, i) => l.note ? '<DodatkowyOpis>' + tag('NrWiersza', String(i + 1)) + tag('Klucz', text(l.note.key, 256, 'Opis pozycji')) +
    tag('Wartosc', text(l.note.value, 256, 'Opis pozycji')) + '</DodatkowyOpis>' : '').join('');
  const rows = d.lines.map((l, i) => {
    if (!/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?$/.test(l.quantity)) fa3Refuse('Ilość pozycji poza formatem FA(3)');
    if (l.gtu !== null && !/^GTU_(0[1-9]|1[0-3])$/.test(l.gtu)) fa3Refuse('Nieznany kod GTU');
    if ((l.code === 'oss') !== (l.oss_rate !== null)) fa3Invalid('Stawka OSS wymaga stawki państwa konsumpcji');
    if (foreign !== (l.fx_rate !== null) || (l.fx_rate !== null && !/^(0|[1-9][0-9]{0,15})\.[0-9]{1,6}$/.test(l.fx_rate))) fa3Invalid('Kurs waluty pozycji niezgodny z walutą faktury');
    if (l.before && d.kind !== 'KOR') fa3Invalid('Stan przed korektą występuje tylko w korekcie');
    return '<FaWiersz>' + tag('NrWierszaFa', String(i + 1)) + (l.uu_id ? tag('UU_ID', l.uu_id) : '') + tag('P_7', text(l.name, 512, 'Nazwa pozycji')) +
      tag('P_8A', text(l.unit, 50, 'Jednostka miary')) + tag('P_8B', l.quantity) +
      (l.unit_gross_minor === null ? '' : tag('P_9B', fa3Money(l.unit_gross_minor))) +
      (l.discount_gross_minor === null || l.discount_gross_minor === 0n ? '' : tag('P_10', fa3Money(l.discount_gross_minor))) +
      tag('P_11A', fa3Money(l.gross_minor)) + (l.code === 'oss' ? tag('P_12_XII', l.oss_rate!) : tag('P_12', l.code)) +
      (l.annex15 ? '<P_12_Zal_15>1</P_12_Zal_15>' : '') + (l.gtu ? tag('GTU', l.gtu) : '') +
      (l.fx_rate ? tag('KursWaluty', l.fx_rate) : '') + (l.before ? '<StanPrzed>1</StanPrzed>' : '') + '</FaWiersz>';
  }).join('');
  const footer = d.footer.map(v => `<Informacje>${tag('StopkaFaktury', text(v, 3500, 'Stopka faktury'))}</Informacje>`).join('');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Faktura xmlns="${FA3_XML_NAMESPACE}"><Naglowek><KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>` +
    '<WariantFormularza>3</WariantFormularza>' + tag('DataWytworzeniaFa', generated) + tag('SystemInfo', d.system_info) + '</Naglowek>' +
    party('Podmiot1', d.seller) + party('Podmiot2', d.buyer) + '<Fa>' + tag('KodWaluty', d.currency) +
    tag('P_1', d.issue_date) + tag('P_2', d.number) + (d.sale_date === null || d.sale_date === d.issue_date ? '' : tag('P_6', d.sale_date)) +
    tax + tag('P_15', fa3Money(d.total_gross_minor)) + annotations + tag('RodzajFaktury', d.kind) + correction + receiptMark + notes + rows +
    (d.due_date ? `<Platnosc><TerminPlatnosci>${tag('Termin', d.due_date)}</TerminPlatnosci></Platnosc>` : '') + '</Fa>' +
    (footer ? `<Stopka>${footer}</Stopka>` : '') + '</Faktura>\n';
  const bytes = Buffer.byteLength(xml, 'utf8');
  if (bytes > FA3_XML_MAX_BYTES) throw new Fa3DocumentError(413, 'XML FA(3) przekracza 1 000 000 bajtów');
  return { format: 'FA (3)/1-0E', namespace: FA3_XML_NAMESPACE, kind: d.kind, number: d.number, generated_at: generated,
    xml, xml_sha256: createHash('sha256').update(xml, 'utf8').digest('hex'), xml_bytes: bytes, ksef_state: 'not_submitted' };
}

/** Sums net/VAT per code over lines; rejects an amount that is not an integer grosz count. */
export function fa3Buckets(rows: readonly { code: Fa3RateCode; net_minor: bigint; vat_minor: bigint }[]): Fa3Bucket[] {
  const map = new Map<Fa3RateCode, Fa3Bucket>();
  for (const r of rows) {
    const b = map.get(r.code) ?? { code: r.code, net_minor: 0n, vat_minor: 0n, vat_pln_minor: null };
    map.set(r.code, { ...b, net_minor: b.net_minor + r.net_minor, vat_minor: b.vat_minor + r.vat_minor });
  }
  return FA3_RATE_CODES.filter(c => map.has(c)).map(c => map.get(c)!);
}
/** Integer grosze from a stored decimal string. */
export function fa3Minor(value: unknown, label: string): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,18})$/.test(value)) fa3Invalid(`Niepoprawna kwota: ${label}`);
  return BigInt(value as string);
}
