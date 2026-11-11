/** Pure rules of the KSeF 2.0 purchase side (invoices received by the company's NIP, subject type
 * Subject2 = buyer). No network, no DB. Prepared for a later migration (see
 * docs/parity/KSEF-PURCHASE-20261026.md); nothing here is wired to routes or the worker yet.
 * - Metadata page of POST /invoices/query/metadata, checked field by field.
 * - Strict FA(3) reader of a received invoice: UTF-8 only, no DTD (so no entity declarations and no
 *   XXE), no processing instructions, bounded size/depth/element count/text (the approach of
 *   server/carrier-dhl-xml.ts, with attributes kept for KodFormularza). Extracts seller, buyer,
 *   numbers, dates, currency, totals per VAT rate (minor units), annotations and correction data.
 * - Checkpoint of an incremental download that survives restarts (JSON, validated on read). Paging is
 *   keyset-like: the next query starts at the date of the last invoice of a page (inclusive), and the
 *   invoices already seen at that date are kept in `boundary`, so a page boundary that splits invoices
 *   of the same date, or a page that shifted under us, re-reads instead of skipping. The KSeF number is
 *   the dedup key.
 * - Read backoff (429/5xx, Retry-After), a bounded ZIP reader for export packages, KOR linking. */
import { SaxesParser } from 'saxes';
import { crc32, inflateRawSync } from 'node:zlib';
import { isKsefNumber, sha256Base64 } from './ksef229-crypto';
import { KSEF229_FA3_NAMESPACE, validNip } from './ksef229-model';

/** Why a received file or answer was refused; the message is Polish and safe to show. */
export class KsefPurchaseDataError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'KsefPurchaseDataError'; }
}
const refuse = (code: string, message: string): never => { throw new KsefPurchaseDataError(code, message); };

// ---------------------------------------------------------------------------------------------
// Metadata (POST /invoices/query/metadata, also _metadata.json of an export package)
// ---------------------------------------------------------------------------------------------
export type PurchaseDateType = 'PermanentStorage' | 'Invoicing' | 'Issue';
export const PURCHASE_DATE_TYPES: readonly PurchaseDateType[] = ['PermanentStorage', 'Invoicing', 'Issue'];
export type PurchaseInvoiceType = 'Vat' | 'Zal' | 'Kor' | 'Roz' | 'Upr' | 'KorZal' | 'KorRoz';
const INVOICE_TYPES: readonly PurchaseInvoiceType[] = ['Vat', 'Zal', 'Kor', 'Roz', 'Upr', 'KorZal', 'KorRoz'];
export type PurchaseMetadata = {
  ksefNumber: string; invoiceNumber: string; issueDate: string;
  invoicingDate: string; acquisitionDate: string | null; permanentStorageDate: string | null;
  sellerNip: string; sellerName: string | null; buyerIdentifier: { type: string; value: string } | null; buyerName: string | null;
  netAmount: number | null; vatAmount: number | null; grossAmount: number | null; currency: string;
  invoiceType: PurchaseInvoiceType; invoicingMode: 'Online' | 'Offline' | null; hasAttachment: boolean; isSelfInvoicing: boolean;
  /** base64 SHA-256 of the invoice file */ invoiceHash: string;
  /** Set when the entry itself is malformed but identifiable and placeable: it becomes a reject, never a fetch. */
  problem?: { code: string; reason: string };
};
export type PurchaseMetadataPage = { hasMore: boolean; isTruncated: boolean; permanentStorageHwmDate: string | null; invoices: PurchaseMetadata[] };

const badMeta = (what: string) => refuse('metadata', `KSeF zwrócił nieprawidłowe metadane faktury (${what})`);
const isoDateTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
const isoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const B64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;
/** Length in characters (code points), as FA(3) and Postgres count them, not UTF-16 units. */
const chars = (v: string) => [...v].length;
const optText = (v: unknown, max = 512): string | null => v === undefined || v === null ? null : typeof v === 'string' && chars(v) <= max ? v : badMeta('tekst');
/** Listing amounts are informative (the file is the source); FA(3) allows 16 integer digits, beyond a safe double they are dropped. */
const optAmount = (v: unknown): number | null => v === undefined || v === null ? null : typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) < 2 ** 53 / 100 ? v : null) : badMeta('kwota');

/** One invoice of a metadata listing. An entry that fails the checks but whose KSeF number, file hash and dates are
 * readable comes back marked with `problem` (with neutral values elsewhere): the caller stores it as a reject and the
 * checkpoint still moves past it. An entry that cannot be identified or placed refuses the page. */
export function parsePurchaseMetadata(v: unknown): PurchaseMetadata {
  try { return parseStrictMetadata(v); }
  catch (e) {
    if (!(e instanceof KsefPurchaseDataError) || !v || typeof v !== 'object' || Array.isArray(v)) throw e;
    const o = v as Record<string, unknown>;
    const placeable = typeof o.ksefNumber === 'string' && isKsefNumber(o.ksefNumber) && typeof o.invoiceHash === 'string' && B64_SHA256.test(o.invoiceHash)
      && isoDateTime(o.invoicingDate) && (o.permanentStorageDate === undefined || o.permanentStorageDate === null || isoDateTime(o.permanentStorageDate));
    if (!placeable) throw e;
    const seller = o.seller as Record<string, unknown> | undefined, text = (x: unknown, max: number) => (typeof x === 'string' && x ? [...x].slice(0, max).join('') : null);
    return {
      // An unreadable issue date takes the acceptance day: only the Issue axis orders by it, and there it is the nearest bound.
      ksefNumber: o.ksefNumber as string, invoiceNumber: text(o.invoiceNumber, 256) ?? '—', issueDate: isoDate(o.issueDate) ? o.issueDate : (o.invoicingDate as string).slice(0, 10), invoicingDate: o.invoicingDate as string,
      acquisitionDate: isoDateTime(o.acquisitionDate) ? o.acquisitionDate : null, permanentStorageDate: (o.permanentStorageDate as string | undefined) ?? null,
      sellerNip: typeof seller?.nip === 'string' && /^\d{10}$/.test(seller.nip) ? seller.nip : '0000000000', sellerName: text(seller?.name, 512), buyerIdentifier: null, buyerName: null,
      netAmount: null, vatAmount: null, grossAmount: null, currency: typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency) ? o.currency : 'XXX',
      invoiceType: INVOICE_TYPES.includes(o.invoiceType as PurchaseInvoiceType) ? o.invoiceType as PurchaseInvoiceType : 'Vat', invoicingMode: null, hasAttachment: false, isSelfInvoicing: false,
      invoiceHash: o.invoiceHash as string, problem: { code: e.code, reason: e.message },
    };
  }
}
function parseStrictMetadata(v: unknown): PurchaseMetadata {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return badMeta('obiekt');
  const o = v as Record<string, unknown>, seller = o.seller as Record<string, unknown> | undefined, buyer = o.buyer as Record<string, unknown> | undefined;
  if (typeof o.ksefNumber !== 'string' || !isKsefNumber(o.ksefNumber)) return badMeta('numer KSeF');
  if (typeof o.invoiceNumber !== 'string' || !o.invoiceNumber || chars(o.invoiceNumber) > 256) return badMeta('numer faktury');
  if (!isoDate(o.issueDate)) return badMeta('data wystawienia');
  if (!isoDateTime(o.invoicingDate)) return badMeta('data przyjęcia');
  for (const k of ['acquisitionDate', 'permanentStorageDate'] as const) if (o[k] !== undefined && o[k] !== null && !isoDateTime(o[k])) return badMeta(k);
  if (!seller || typeof seller.nip !== 'string' || !/^\d{10}$/.test(seller.nip)) return badMeta('NIP sprzedawcy');
  let buyerIdentifier: PurchaseMetadata['buyerIdentifier'] = null;
  const id = buyer?.identifier as Record<string, unknown> | undefined;
  if (id !== undefined && id !== null) {
    if (typeof id.type !== 'string' || (id.value !== undefined && typeof id.value !== 'string')) return badMeta('nabywca');
    buyerIdentifier = { type: id.type, value: typeof id.value === 'string' ? id.value : '' };
  }
  if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) return badMeta('waluta');
  if (typeof o.invoiceType !== 'string' || !INVOICE_TYPES.includes(o.invoiceType as PurchaseInvoiceType)) return badMeta('rodzaj faktury');
  if (o.invoicingMode !== undefined && o.invoicingMode !== null && o.invoicingMode !== 'Online' && o.invoicingMode !== 'Offline') return badMeta('tryb');
  if (typeof o.invoiceHash !== 'string' || !B64_SHA256.test(o.invoiceHash)) return badMeta('skrót pliku');
  return {
    ksefNumber: o.ksefNumber, invoiceNumber: o.invoiceNumber, issueDate: o.issueDate, invoicingDate: o.invoicingDate,
    acquisitionDate: (o.acquisitionDate as string | undefined) ?? null, permanentStorageDate: (o.permanentStorageDate as string | undefined) ?? null,
    sellerNip: seller.nip, sellerName: optText(seller.name), buyerIdentifier, buyerName: optText(buyer?.name),
    netAmount: optAmount(o.netAmount), vatAmount: optAmount(o.vatAmount), grossAmount: optAmount(o.grossAmount), currency: o.currency,
    invoiceType: o.invoiceType as PurchaseInvoiceType, invoicingMode: (o.invoicingMode as PurchaseMetadata['invoicingMode'] | undefined) ?? null,
    hasAttachment: o.hasAttachment === true, isSelfInvoicing: o.isSelfInvoicing === true, invoiceHash: o.invoiceHash,
  };
}
export const KSEF_PURCHASE_MAX_PAGE_INVOICES = 250;
/** A whole page of POST /invoices/query/metadata. */
export function parsePurchaseMetadataPage(v: unknown): PurchaseMetadataPage {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return badMeta('strona');
  const o = v as Record<string, unknown>;
  if (typeof o.hasMore !== 'boolean' || !Array.isArray(o.invoices) || o.invoices.length > KSEF_PURCHASE_MAX_PAGE_INVOICES) return badMeta('strona');
  if (o.isTruncated !== undefined && typeof o.isTruncated !== 'boolean') return badMeta('isTruncated');
  if (o.permanentStorageHwmDate !== undefined && o.permanentStorageHwmDate !== null && !isoDateTime(o.permanentStorageHwmDate)) return badMeta('HWM');
  return { hasMore: o.hasMore, isTruncated: o.isTruncated === true, permanentStorageHwmDate: (o.permanentStorageHwmDate as string | undefined) ?? null, invoices: o.invoices.map(parsePurchaseMetadata) };
}
/** The date a listing is ordered and filtered by, in ms. */
export function purchaseDateMs(m: PurchaseMetadata, t: PurchaseDateType): number {
  const v = t === 'Issue' ? `${m.issueDate}T00:00:00Z` : t === 'Invoicing' ? m.invoicingDate : m.permanentStorageDate;
  const ms = v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? badMeta(`brak daty ${t}`) : ms;
}

// ---------------------------------------------------------------------------------------------
// Strict XML reader
// ---------------------------------------------------------------------------------------------
export type FaNode = { name: string; uri: string; attrs: Record<string, string>; text: string; children: FaNode[] };
/** FA(3) files are at most 1 MB, 3 MB with attachments (MF); depth/elements/text keep a hostile file bounded. */
export const KSEF_PURCHASE_XML_LIMITS = { maxBytes: 3 * 1024 * 1024, maxDepth: 24, maxElements: 100_000, maxTextChars: 1024 * 1024 } as const;

/** Parses the bytes of one received file. Refuses non-UTF-8, DTD, PI, entities, oversize, depth. */
export function parsePurchaseXml(input: Buffer | string, limits: Partial<typeof KSEF_PURCHASE_XML_LIMITS> = {}): FaNode {
  const L = { ...KSEF_PURCHASE_XML_LIMITS, ...limits };
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (!bytes.length) refuse('xml_empty', 'Plik faktury jest pusty');
  if (bytes.length > L.maxBytes) refuse('xml_size', `Plik faktury jest za duży (${bytes.length} B, limit ${L.maxBytes} B)`);
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return refuse('xml_encoding', 'Plik faktury nie jest zapisany w UTF-8'); }
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  const parser = new SaxesParser({ xmlns: true });
  const stack: FaNode[] = [];
  let root: FaNode | undefined, count = 0, reason: KsefPurchaseDataError | null = null;
  const fail = (code: string, message: string) => { reason ??= new KsefPurchaseDataError(code, message); throw reason; };
  parser.on('xmldecl', d => { if (d.encoding && !/^utf-8$/i.test(d.encoding)) fail('xml_encoding', 'Plik faktury deklaruje kodowanie inne niż UTF-8'); });
  parser.on('doctype', () => fail('xml_dtd', 'Plik faktury zawiera deklarację DOCTYPE (niedozwolona)'));
  parser.on('processinginstruction', () => fail('xml_pi', 'Plik faktury zawiera instrukcję przetwarzania (niedozwolona)'));
  parser.on('error', () => fail('xml_syntax', 'Plik faktury nie jest poprawnym dokumentem XML'));
  parser.on('opentag', tag => {
    if (++count > L.maxElements) fail('xml_limits', 'Plik faktury ma za dużo elementów');
    if (stack.length >= L.maxDepth) fail('xml_limits', 'Plik faktury jest zbyt głęboko zagnieżdżony');
    const attrs: Record<string, string> = {};
    for (const a of Object.values(tag.attributes)) if (a.uri !== 'http://www.w3.org/2000/xmlns/' && a.prefix !== 'xmlns') attrs[a.local] = a.value;
    const node: FaNode = { name: tag.local, uri: tag.uri, attrs, text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else if (root) fail('xml_syntax', 'Plik faktury ma więcej niż jeden element główny');
    else root = node;
    stack.push(node);
  });
  const text = (v: string) => {
    const node = stack.at(-1);
    if (!node) { if (v.trim()) fail('xml_syntax', 'Tekst poza elementem głównym'); return; }
    node.text += v;
    if (node.text.length > L.maxTextChars) fail('xml_limits', 'Element pliku faktury zawiera za długi tekst');
  };
  parser.on('text', text); parser.on('cdata', text);
  parser.on('closetag', () => { stack.pop(); });
  try { parser.write(xml).close(); } catch { /* reason holds the cause */ }
  if (reason) throw reason;
  if (!root) return refuse('xml_syntax', 'Plik faktury nie ma elementu głównego');
  return root;
}

// ---------------------------------------------------------------------------------------------
// FA(3) of a received invoice
// ---------------------------------------------------------------------------------------------
export type PurchaseRateCode = '23' | '8' | '5' | '4' | 'oss' | '0_kr' | '0_wdt' | '0_ex' | 'zw' | 'np_i' | 'np_ii' | 'oo' | 'marza';
/** P_13_x (net) / P_14_x (VAT) / P_14_xW (VAT in PLN for a foreign currency). 23 = 23 or 22 %, 8 = 8 or 7 %. */
export const PURCHASE_RATE_FIELDS: readonly { code: PurchaseRateCode; net: string; vat?: string; vatPln?: string }[] = [
  { code: '23', net: 'P_13_1', vat: 'P_14_1', vatPln: 'P_14_1W' },
  { code: '8', net: 'P_13_2', vat: 'P_14_2', vatPln: 'P_14_2W' },
  { code: '5', net: 'P_13_3', vat: 'P_14_3', vatPln: 'P_14_3W' },
  { code: '4', net: 'P_13_4', vat: 'P_14_4', vatPln: 'P_14_4W' },
  { code: 'oss', net: 'P_13_5', vat: 'P_14_5' },
  { code: '0_kr', net: 'P_13_6_1' }, { code: '0_wdt', net: 'P_13_6_2' }, { code: '0_ex', net: 'P_13_6_3' },
  { code: 'zw', net: 'P_13_7' }, { code: 'np_i', net: 'P_13_8' }, { code: 'np_ii', net: 'P_13_9' }, { code: 'oo', net: 'P_13_10' }, { code: 'marza', net: 'P_13_11' },
];
/** Amounts in minor units (grosze / cents); VAT null when the rate has none. */
export type PurchaseRateTotal = { code: PurchaseRateCode; net: number; vat: number | null; vatPln: number | null };
export type Fa3InvoiceKind = 'VAT' | 'KOR' | 'ZAL' | 'ROZ' | 'UPR' | 'KOR_ZAL' | 'KOR_ROZ';
const FA3_KINDS: readonly Fa3InvoiceKind[] = ['VAT', 'KOR', 'ZAL', 'ROZ', 'UPR', 'KOR_ZAL', 'KOR_ROZ'];
export const isCorrectionKind = (k: Fa3InvoiceKind) => k === 'KOR' || k === 'KOR_ZAL' || k === 'KOR_ROZ';
export type CorrectedInvoiceRef = { invoiceNumber: string; issueDate: string; ksefNumber: string | null };
export type ParsedPurchaseInvoice = {
  formCode: { systemCode: string; schemaVersion: string; value: string };
  seller: { nip: string; name: string };
  buyer: { nip: string | null; euVat: string | null; otherId: string | null; name: string | null };
  invoiceNumber: string; issueDate: string; saleDate: string | null; salePeriod: { from: string; to: string } | null;
  currency: string; kind: Fa3InvoiceKind; rates: PurchaseRateTotal[]; netTotal: number; vatTotal: number; grossTotal: number;
  cashMethod: boolean; selfInvoicing: boolean; reverseCharge: boolean; splitPayment: boolean; paymentDueDate: string | null;
  correction: { reason: string | null; type: 1 | 2 | 3 | null; corrected: CorrectedInvoiceRef[] } | null;
};

const kids = (n: FaNode, name: string) => n.children.filter(c => c.name === name && c.uri === KSEF229_FA3_NAMESPACE);
function child(n: FaNode, name: string, required: true): FaNode;
function child(n: FaNode, name: string, required?: false): FaNode | null;
function child(n: FaNode, name: string, required = false): FaNode | null {
  const k = kids(n, name);
  if (k.length > 1) refuse('fa3_structure', `Element ${name} występuje w pliku faktury więcej niż raz`);
  if (!k.length && required) refuse('fa3_structure', `Brak wymaganego elementu ${name} w pliku faktury`);
  return k[0] ?? null;
}
const leaf = (n: FaNode | null) => {
  if (!n) return null;
  if (n.children.length) refuse('fa3_structure', `Element ${n.name} ma nieoczekiwaną zawartość`);
  return n.text.trim();
};
const val = (n: FaNode, name: string, required = false): string | null => {
  const v = leaf(child(n, name, required as false));
  if (required && !v) refuse('fa3_structure', `Element ${name} jest pusty`);
  return v || null;
};
const dateVal = (n: FaNode, name: string, required = false): string | null => {
  const v = val(n, name, required);
  if (v !== null && !isoDate(v)) refuse('fa3_value', `Element ${name} nie jest datą RRRR-MM-DD`);
  return v;
};
/** Decimal with at most 2 fraction digits (TKwotowy) → minor units. */
export function amountMinor(v: string, field = 'kwota'): number {
  const m = /^(-)?(\d{1,16})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return refuse('fa3_value', `${field}: nieprawidłowa kwota „${v.slice(0, 32)}”`);
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) return refuse('fa3_value', `${field}: kwota poza zakresem`);
  return m[1] ? -minor : minor;
}
const flag = (n: FaNode | null, name: string) => (n ? val(n, name) : null) === '1';

/** FA(3) of a received invoice → the data the purchase ledger needs. Refuses anything that is not FA(3). */
export function parseReceivedFa3(input: Buffer | string): ParsedPurchaseInvoice {
  const root = parsePurchaseXml(input);
  if (root.name !== 'Faktura' || root.uri !== KSEF229_FA3_NAMESPACE) refuse('not_fa3', 'Plik nie jest fakturą FA(3)');
  const head = child(root, 'Naglowek', true), kod = child(head, 'KodFormularza', true);
  const formCode = { systemCode: kod.attrs.kodSystemowy ?? '', schemaVersion: kod.attrs.wersjaSchemy ?? '', value: leaf(kod) ?? '' };
  if (formCode.systemCode !== 'FA (3)' || formCode.value !== 'FA') refuse('not_fa3', 'Plik nie jest fakturą FA(3)');
  const p1 = child(root, 'Podmiot1', true), p1id = child(p1, 'DaneIdentyfikacyjne', true);
  const sellerNip = val(p1id, 'NIP', true)!;
  if (!validNip(sellerNip)) refuse('fa3_value', 'NIP sprzedawcy w pliku faktury jest nieprawidłowy');
  const p2 = child(root, 'Podmiot2', true), p2id = child(p2, 'DaneIdentyfikacyjne', true);
  const buyerNip = val(p2id, 'NIP'), ue = val(p2id, 'NrVatUE'), other = val(p2id, 'NrID');
  if (buyerNip !== null && !/^\d{10}$/.test(buyerNip)) refuse('fa3_value', 'NIP nabywcy w pliku faktury jest nieprawidłowy');
  const fa = child(root, 'Fa', true);
  const currency = val(fa, 'KodWaluty', true)!;
  if (!/^[A-Z]{3}$/.test(currency)) refuse('fa3_value', 'Kod waluty faktury jest nieprawidłowy');
  const invoiceNumber = val(fa, 'P_2', true)!;
  if (chars(invoiceNumber) > 256) refuse('fa3_value', 'Numer faktury (P_2) jest za długi');
  const kind = val(fa, 'RodzajFaktury', true) as Fa3InvoiceKind;
  if (!FA3_KINDS.includes(kind)) refuse('fa3_value', 'Nieznany rodzaj faktury (RodzajFaktury)');
  const rates: PurchaseRateTotal[] = [];
  for (const f of PURCHASE_RATE_FIELDS) {
    const net = val(fa, f.net), vat = f.vat ? val(fa, f.vat) : null, vatPln = f.vatPln ? val(fa, f.vatPln) : null;
    if (net === null && vat === null && vatPln === null) continue;
    rates.push({ code: f.code, net: net === null ? 0 : amountMinor(net, f.net), vat: vat === null ? (f.vat ? 0 : null) : amountMinor(vat, f.vat!), vatPln: vatPln === null ? null : amountMinor(vatPln, f.vatPln!) });
  }
  const grossTotal = amountMinor(val(fa, 'P_15', true)!, 'P_15');
  const okres = child(fa, 'OkresFa');
  const ad = child(fa, 'Adnotacje');
  const termin = kids(child(fa, 'Platnosc') ?? { children: [] } as unknown as FaNode, 'TerminPlatnosci')[0];
  const paymentDueDate = termin ? dateVal(termin, 'Termin') : null;
  let correction: ParsedPurchaseInvoice['correction'] = null;
  if (isCorrectionKind(kind)) {
    const refs = kids(fa, 'DaneFaKorygowanej');
    if (!refs.length) refuse('fa3_structure', 'Faktura korygująca nie wskazuje faktury korygowanej (DaneFaKorygowanej)');
    const corrected = refs.map(r => {
      const nr = val(r, 'NrKSeFFaKorygowanej'), withNr = val(r, 'NrKSeF') === '1', without = val(r, 'NrKSeFN') === '1';
      if (withNr === without) refuse('fa3_structure', 'Dane faktury korygowanej: wymagane dokładnie jedno z NrKSeF i NrKSeFN');
      if (withNr && (!nr || !isKsefNumber(nr))) refuse('fa3_value', 'Numer KSeF faktury korygowanej jest nieprawidłowy');
      return { invoiceNumber: val(r, 'NrFaKorygowanej', true)!, issueDate: dateVal(r, 'DataWystFaKorygowanej', true)!, ksefNumber: withNr ? nr : null };
    });
    const t = val(fa, 'TypKorekty');
    if (t !== null && !['1', '2', '3'].includes(t)) refuse('fa3_value', 'Nieznany typ korekty (TypKorekty)');
    correction = { reason: val(fa, 'PrzyczynaKorekty'), type: t === null ? null : Number(t) as 1 | 2 | 3, corrected };
  }
  return {
    formCode, seller: { nip: sellerNip, name: val(p1id, 'Nazwa', true)! },
    buyer: { nip: buyerNip, euVat: ue, otherId: other, name: val(p2id, 'Nazwa') },
    invoiceNumber, issueDate: dateVal(fa, 'P_1', true)!, saleDate: dateVal(fa, 'P_6'),
    salePeriod: okres ? { from: dateVal(okres, 'P_6_Od', true)!, to: dateVal(okres, 'P_6_Do', true)! } : null,
    currency, kind, rates, netTotal: rates.reduce((s, r) => s + r.net, 0), vatTotal: rates.reduce((s, r) => s + (r.vat ?? 0), 0), grossTotal,
    cashMethod: flag(ad, 'P_16'), selfInvoicing: flag(ad, 'P_17'), reverseCharge: flag(ad, 'P_18'), splitPayment: flag(ad, 'P_18A'),
    paymentDueDate, correction,
  };
}

/** The file of a listed invoice must be that invoice: same hash, seller, number, date, and bought by `nip`. */
export function checkReceivedAgainstMetadata(nip: string, meta: PurchaseMetadata, xml: Buffer, parsed: ParsedPurchaseInvoice): void {
  if (sha256Base64(xml) !== meta.invoiceHash) refuse('hash_mismatch', `Skrót pobranego pliku faktury ${meta.ksefNumber} nie zgadza się z metadanymi KSeF`);
  if (parsed.seller.nip !== meta.sellerNip) refuse('metadata_mismatch', `NIP sprzedawcy w pliku faktury ${meta.ksefNumber} różni się od metadanych KSeF`);
  if (parsed.invoiceNumber !== meta.invoiceNumber || parsed.issueDate !== meta.issueDate) refuse('metadata_mismatch', `Numer albo data faktury ${meta.ksefNumber} różnią się od metadanych KSeF`);
  if (parsed.buyer.nip !== nip) refuse('buyer_mismatch', `Faktura ${meta.ksefNumber} nie jest wystawiona na NIP ${nip}`);
}

// ---------------------------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------------------------
export type KnownPurchaseInvoice = { ksefNumber: string; sellerNip: string; invoiceNumber: string; issueDate: string };
export type CorrectionLink = CorrectedInvoiceRef & { resolvedKsefNumber: string | null; by: 'ksef_number' | 'invoice_number' | null; problem: 'seller_mismatch' | 'ambiguous' | null };
/** Links each reference of a KOR to a known purchase invoice: by the KSeF number of the reference when it
 * has one (NrKSeF=1), otherwise by seller NIP + invoice number + issue date. A reference to another
 * seller's invoice is never linked. Unresolved references stay (the original may arrive later or predate KSeF). */
export function linkCorrection(kor: { sellerNip: string; parsed: ParsedPurchaseInvoice }, known: readonly KnownPurchaseInvoice[]): CorrectionLink[] {
  if (!kor.parsed.correction) return [];
  return kor.parsed.correction.corrected.map(ref => {
    if (ref.ksefNumber) {
      const k = known.find(x => x.ksefNumber === ref.ksefNumber);
      if (!k) return { ...ref, resolvedKsefNumber: null, by: null, problem: null };
      if (k.sellerNip !== kor.sellerNip) return { ...ref, resolvedKsefNumber: null, by: null, problem: 'seller_mismatch' };
      return { ...ref, resolvedKsefNumber: k.ksefNumber, by: 'ksef_number', problem: null };
    }
    const m = known.filter(x => x.sellerNip === kor.sellerNip && x.invoiceNumber === ref.invoiceNumber && x.issueDate === ref.issueDate);
    if (m.length > 1) return { ...ref, resolvedKsefNumber: null, by: null, problem: 'ambiguous' };
    return { ...ref, resolvedKsefNumber: m[0]?.ksefNumber ?? null, by: m[0] ? 'invoice_number' : null, problem: null };
  });
}

// ---------------------------------------------------------------------------------------------
// Checkpoint (incremental download, survives restarts)
// ---------------------------------------------------------------------------------------------
const DAY = 24 * 3600_000;
/** Longest date range of one query window (sandbox question: the real KSeF limit). */
export const KSEF_PURCHASE_MAX_WINDOW_MS = 90 * DAY;
/** How far a new window re-reads before the completed point. PermanentStorage is bounded by the KSeF
 * high-water mark, so nothing appears behind it; Invoicing and Issue need a margin for late arrivals
 * (offline invoices are sent up to 7 business days after issue in the emergency mode). */
export const KSEF_PURCHASE_LOOKBACK_MS: Record<PurchaseDateType, number> = { PermanentStorage: 0, Invoicing: DAY, Issue: 14 * DAY };
export const KSEF_PURCHASE_PAGE_SIZE = 100;
const MAX_BOUNDARY = 10_000;
export type PurchaseWindow = { from: string; to: string; cursorFrom: string; cursorOffset: number; boundary: string[]; hwm: string | null };
export type PurchaseCheckpoint = { version: 1; nip: string; dateType: PurchaseDateType; completedUpTo: string; window: PurchaseWindow | null };
export type PurchaseQuery = {
  subjectType: 'Subject2'; dateRange: { dateType: PurchaseDateType; from: string; to: string; restrictToPermanentStorageHwmDate?: boolean };
  pageOffset: number; pageSize: number; sortOrder: 'Asc';
};
const iso = (ms: number) => new Date(ms).toISOString();
const badCp = (what: string): never => refuse('checkpoint', `Zapisany punkt kontrolny pobierania faktur kosztowych jest nieprawidłowy (${what})`);

export function initialPurchaseCheckpoint(nip: string, startFrom: string, dateType: PurchaseDateType = 'PermanentStorage'): PurchaseCheckpoint {
  if (!validNip(nip)) refuse('checkpoint', 'Nieprawidłowy NIP');
  if (!isoDateTime(startFrom)) refuse('checkpoint', 'Data początkowa musi być datą i czasem ISO 8601');
  if (!PURCHASE_DATE_TYPES.includes(dateType)) refuse('checkpoint', 'Nieznany rodzaj daty');
  return { version: 1, nip, dateType, completedUpTo: iso(Date.parse(startFrom)), window: null };
}
/** Reads a stored checkpoint (JSON value); refuses a corrupted one instead of silently starting over. */
export function parsePurchaseCheckpoint(v: unknown): PurchaseCheckpoint {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return badCp('obiekt');
  const o = v as Record<string, unknown>;
  if (o.version !== 1) badCp('wersja');
  if (typeof o.nip !== 'string' || !validNip(o.nip)) badCp('NIP');
  if (!PURCHASE_DATE_TYPES.includes(o.dateType as PurchaseDateType)) badCp('rodzaj daty');
  if (!isoDateTime(o.completedUpTo)) badCp('completedUpTo');
  let window: PurchaseWindow | null = null;
  if (o.window !== null) {
    const w = o.window as Record<string, unknown>;
    if (!w || typeof w !== 'object') return badCp('okno');
    for (const k of ['from', 'to', 'cursorFrom'] as const) if (!isoDateTime(w[k])) badCp(k);
    if (w.hwm !== null && !isoDateTime(w.hwm)) badCp('hwm');
    if (!Number.isSafeInteger(w.cursorOffset) || (w.cursorOffset as number) < 0) badCp('cursorOffset');
    if (!Array.isArray(w.boundary) || w.boundary.length > MAX_BOUNDARY || !w.boundary.every(b => typeof b === 'string' && isKsefNumber(b))) badCp('boundary');
    const from = Date.parse(w.from as string), to = Date.parse(w.to as string), cur = Date.parse(w.cursorFrom as string);
    if (!(from <= cur && cur <= to)) badCp('zakres okna');
    window = { from: w.from as string, to: w.to as string, cursorFrom: w.cursorFrom as string, cursorOffset: w.cursorOffset as number, boundary: [...w.boundary as string[]], hwm: (w.hwm as string | null) };
  }
  return { version: 1, nip: o.nip as string, dateType: o.dateType as PurchaseDateType, completedUpTo: o.completedUpTo as string, window };
}

/** Opens the next window (or keeps an unfinished one, which is how a restart resumes). Null when there is
 * nothing after the completed point yet. `settleMs` keeps the window end behind `now`. */
export function startPurchaseWindow(cp: PurchaseCheckpoint, now: string, o: { lookbackMs?: number; maxWindowMs?: number; settleMs?: number } = {}): PurchaseCheckpoint | null {
  if (cp.window) return cp;
  const done = Date.parse(cp.completedUpTo), from = done - (o.lookbackMs ?? KSEF_PURCHASE_LOOKBACK_MS[cp.dateType]);
  const to = Math.min(Date.parse(now) - (o.settleMs ?? 0), from + (o.maxWindowMs ?? KSEF_PURCHASE_MAX_WINDOW_MS));
  if (!(to > done)) return null;
  return { ...cp, window: { from: iso(from), to: iso(to), cursorFrom: iso(from), cursorOffset: 0, boundary: [], hwm: null } };
}
/** The query of the current cursor. */
export function purchaseQuery(cp: PurchaseCheckpoint, pageSize = KSEF_PURCHASE_PAGE_SIZE): PurchaseQuery {
  const w = cp.window ?? badCp('brak otwartego okna');
  if (!Number.isSafeInteger(pageSize) || pageSize < 10 || pageSize > KSEF_PURCHASE_MAX_PAGE_INVOICES) refuse('checkpoint', 'Rozmiar strony musi mieć 10–250');
  return { subjectType: 'Subject2', dateRange: { dateType: cp.dateType, from: w.cursorFrom, to: w.to, ...(cp.dateType === 'PermanentStorage' ? { restrictToPermanentStorageHwmDate: true } : {}) }, pageOffset: w.cursorOffset, pageSize, sortOrder: 'Asc' };
}
export type PurchaseAdvance = { checkpoint: PurchaseCheckpoint; fresh: PurchaseMetadata[]; overlap: number; windowDone: boolean };
/** Applies one page answered for `query` (from purchaseQuery of this checkpoint). Never advances past an
 * invoice it has not returned in `fresh` or seen before; the caller stores `fresh` and the new checkpoint
 * together, so a crash in between re-reads the page (dedup by KSeF number) instead of skipping it. */
export function advancePurchaseCheckpoint(cp: PurchaseCheckpoint, query: PurchaseQuery, page: PurchaseMetadataPage): PurchaseAdvance {
  const w = cp.window ?? badCp('brak otwartego okna');
  if (query.dateRange.from !== w.cursorFrom || query.dateRange.to !== w.to || query.pageOffset !== w.cursorOffset || query.dateRange.dateType !== cp.dateType)
    refuse('stale_page', 'Strona nie odpowiada bieżącemu punktowi kontrolnemu');
  const from = Date.parse(w.cursorFrom), to = Date.parse(w.to);
  let prev = from;
  for (const m of page.invoices) {
    const d = purchaseDateMs(m, cp.dateType);
    if (d < from || d > to) refuse('contract', `KSeF zwrócił fakturę ${m.ksefNumber} spoza zakresu zapytania`);
    if (d < prev) refuse('contract', 'KSeF zwrócił faktury w nierosnącej kolejności dat');
    prev = d;
  }
  const seen = new Set(w.boundary), fresh: PurchaseMetadata[] = [];
  let overlap = 0;
  for (const m of page.invoices) { if (seen.has(m.ksefNumber)) overlap++; else { seen.add(m.ksefNumber); fresh.push(m); } }
  const hwm = page.permanentStorageHwmDate ?? w.hwm;
  if (!page.hasMore && !page.isTruncated) {
    let done = to;
    if (cp.dateType === 'PermanentStorage' && hwm) done = Math.min(done, Date.parse(hwm));
    done = Math.max(done, Date.parse(cp.completedUpTo));
    return { checkpoint: { ...cp, completedUpTo: iso(done), window: null }, fresh, overlap, windowDone: true };
  }
  if (!page.invoices.length) refuse('contract', 'KSeF zgłosił kolejne strony, ale zwrócił pustą stronę');
  const last = purchaseDateMs(page.invoices.at(-1)!, cp.dateType);
  const atLast = page.invoices.filter(m => purchaseDateMs(m, cp.dateType) === last).map(m => m.ksefNumber);
  let next: PurchaseWindow;
  if (last === from) {
    // The whole page has the cursor date: only the offset can move (and the boundary keeps every number seen).
    if (!page.hasMore) refuse('stuck', 'Ponad limit KSeF faktur ma tę samą datę; nie da się przesunąć punktu kontrolnego');
    const boundary = [...new Set([...w.boundary, ...atLast])];
    if (boundary.length > MAX_BOUNDARY) refuse('stuck', 'Za dużo faktur z tą samą datą');
    next = { ...w, cursorOffset: w.cursorOffset + page.invoices.length, boundary, hwm };
  } else next = { ...w, cursorFrom: iso(last), cursorOffset: 0, boundary: atLast, hwm };
  if (fresh.length === 0 && next.cursorFrom === w.cursorFrom && next.cursorOffset === w.cursorOffset) refuse('stuck', 'Punkt kontrolny nie przesunął się');
  return { checkpoint: { ...cp, window: next }, fresh, overlap, windowDone: false };
}

/** Next query window after an export package (no offsets there): the package's last date, inclusive. */
export function advanceAfterExport(cp: PurchaseCheckpoint, pkg: { isTruncated: boolean; lastDate: string | null; hwm: string | null; invoices: PurchaseMetadata[] }): PurchaseAdvance {
  const w = cp.window ?? badCp('brak otwartego okna');
  const seen = new Set(w.boundary), fresh: PurchaseMetadata[] = [];
  let overlap = 0;
  for (const m of pkg.invoices) { if (seen.has(m.ksefNumber)) overlap++; else { seen.add(m.ksefNumber); fresh.push(m); } }
  if (!pkg.isTruncated) {
    const closed = advancePurchaseCheckpoint(cp, purchaseQuery(cp), { hasMore: false, isTruncated: false, permanentStorageHwmDate: pkg.hwm ?? w.hwm, invoices: [] });
    return { ...closed, fresh, overlap };
  }
  const lastMs = pkg.lastDate ? Date.parse(pkg.lastDate) : pkg.invoices.length ? Math.max(...pkg.invoices.map(m => purchaseDateMs(m, cp.dateType))) : NaN;
  if (Number.isNaN(lastMs) || lastMs <= Date.parse(w.cursorFrom)) refuse('stuck', 'Paczka eksportu jest obcięta, ale nie przesuwa daty');
  const atLast = pkg.invoices.filter(m => purchaseDateMs(m, cp.dateType) === lastMs).map(m => m.ksefNumber);
  return { checkpoint: { ...cp, window: { ...w, cursorFrom: iso(lastMs), cursorOffset: 0, boundary: atLast, hwm: pkg.hwm ?? w.hwm } }, fresh, overlap, windowDone: false };
}

// ---------------------------------------------------------------------------------------------
// Read backoff
// ---------------------------------------------------------------------------------------------
export type PurchaseRetryPolicy = { maxAttempts: number; baseMs: number; maxDelayMs: number; /** a longer Retry-After ends the attempt: the job is rescheduled */ maxWaitMs: number };
export const KSEF_PURCHASE_RETRY: PurchaseRetryPolicy = { maxAttempts: 5, baseMs: 500, maxDelayMs: 30_000, maxWaitMs: 60_000 };
/** Delay before retry number `attempt` (1-based) of an idempotent read: Retry-After (seconds or HTTP date)
 * when given, else exponential with jitter. */
export function purchaseRetryDelayMs(attempt: number, retryAfter: string | null, nowMs: number, policy: PurchaseRetryPolicy = KSEF_PURCHASE_RETRY, random: () => number = Math.random): number {
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const s = retryAfter.trim();
    if (/^\d{1,7}$/.test(s)) return Number(s) * 1000;
    const at = Date.parse(s);
    if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  }
  const exp = Math.min(policy.maxDelayMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + random() / 2));
}

// ---------------------------------------------------------------------------------------------
// Export package (ZIP of invoice files + _metadata.json), read with limits
// ---------------------------------------------------------------------------------------------
export const KSEF_PURCHASE_ZIP_LIMITS = { maxEntries: 10_001, maxEntryBytes: KSEF_PURCHASE_XML_LIMITS.maxBytes, maxMetadataBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 } as const;
const badZip = (what: string): never => refuse('zip', `Paczka eksportu KSeF jest nieprawidłowa (${what})`);
/** Stored or deflated entries only; no encryption, no ZIP64, flat safe names, CRC and sizes checked,
 * declared sizes bounded before inflating (zip bomb). */
export function readPurchaseZip(zip: Buffer, limits: Partial<typeof KSEF_PURCHASE_ZIP_LIMITS> = {}): { name: string; data: Buffer }[] {
  const L = { ...KSEF_PURCHASE_ZIP_LIMITS, ...limits };
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return badZip('brak katalogu');
  const count = zip.readUInt16LE(eocd + 10), dirSize = zip.readUInt32LE(eocd + 12), dirOff = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOff === 0xffffffff) badZip('ZIP64');
  if (count > L.maxEntries) badZip('za dużo plików');
  if (dirOff + dirSize > eocd) badZip('katalog poza plikiem');
  const out: { name: string; data: Buffer }[] = [], names = new Set<string>();
  let p = dirOff, total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== 0x02014b50) badZip('wpis katalogu');
    const flags = zip.readUInt16LE(p + 8), method = zip.readUInt16LE(p + 10), crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24), nlen = zip.readUInt16LE(p + 28), elen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32), loc = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (flags & 0x1) badZip('plik zaszyfrowany');
    if (method !== 0 && method !== 8) badZip('metoda kompresji');
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(name) || name.includes('..')) badZip('nazwa pliku');
    if (names.has(name)) badZip('powtórzona nazwa pliku');
    names.add(name);
    const max = name === '_metadata.json' ? L.maxMetadataBytes : L.maxEntryBytes;
    if (usize > max) badZip(`plik ${name} za duży`);
    total += usize;
    if (total > L.maxTotalBytes) badZip('za duża łączna wielkość');
    if (loc + 30 > zip.length || zip.readUInt32LE(loc) !== 0x04034b50) badZip('nagłówek pliku');
    const start = loc + 30 + zip.readUInt16LE(loc + 26) + zip.readUInt16LE(loc + 28);
    if (start + csize > dirOff) badZip('dane poza plikiem');
    const raw = zip.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) { if (csize !== usize) badZip('rozmiar'); data = Buffer.from(raw); }
    else { try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) }); } catch { return badZip(`dekompresja ${name}`); } }
    if (data.length !== usize || crc32(data) !== crc) badZip(`suma kontrolna ${name}`);
    out.push({ name, data });
  }
  return out;
}
export type PurchasePackageEntry = { meta: PurchaseMetadata; xml: Buffer };
/** Pairs every `_metadata.json` invoice with its `{ksefNumber}.xml`; a file without metadata or metadata
 * without a file refuses the package (sandbox question: the exact file names). */
export function parsePurchasePackage(entries: { name: string; data: Buffer }[]): PurchasePackageEntry[] {
  const metaFile = entries.find(e => e.name === '_metadata.json') ?? badZip('brak _metadata.json');
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metaFile.data)); } catch { return badZip('_metadata.json nie jest JSON'); }
  const list = (json as { invoices?: unknown })?.invoices;
  if (!Array.isArray(list)) return badZip('_metadata.json bez listy faktur');
  const files = new Map(entries.filter(e => e !== metaFile).map(e => [e.name, e.data]));
  const metas = list.map(parsePurchaseMetadata);
  if (new Set(metas.map(m => m.ksefNumber)).size !== metas.length) badZip('powtórzony numer KSeF w metadanych');
  const out = metas.map(meta => ({ meta, xml: files.get(`${meta.ksefNumber}.xml`) ?? badZip(`brak pliku ${meta.ksefNumber}.xml`) }));
  if (out.length !== files.size) badZip('plik bez metadanych');
  return out;
}
