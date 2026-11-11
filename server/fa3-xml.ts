/** Pure export of an already numbered native159 FV. No issuance, database,
 * authorization, current product lookup or KSeF submission occurs here. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateB2bInvoiceDocument, type B2bInvoiceDocument } from './b2b-invoice-values';
import { b2bFa3DraftHash, b2bFa3XmlTextValid } from './fa3-draft-model';

export const FA3_XML_NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13775/';
export const FA3_XML_MAX_BYTES = 1_000_000;
export class Fa3XmlError extends Error {
  constructor(public readonly code: 'INVALID_NATIVE_INVOICE' | 'INVALID_EXPORT_TIME' | 'UNSUPPORTED_SCOPE' | 'XML_BYTES_EXCEEDED', message: string) {
    super(message); this.name = 'Fa3XmlError';
  }
}
const documentHead = z.strictObject({
  id: z.uuid(), order_id: z.uuid(), kind: z.literal('invoice'), mode: z.literal('b2b_invoice'),
  number: z.string().max(256), data: z.unknown(), created_at: z.iso.datetime({ offset: true }),
});
const exportOptions = z.strictObject({ generated_at: z.iso.datetime().max(64).refine(value => {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.([0-9]+))?Z$/.exec(value);
  if (!m) return false;
  return m[1] >= '2025-09-01T00:00:00' && m[1] <= '2050-01-01T23:59:59' &&
    (m[1] !== '2050-01-01T23:59:59' || !/[1-9]/.test(m[2] ?? ''));
}) });
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const tag = (name: string, value: string) => `<${name}>${escape(value)}</${name}>`;
/** Integer minor units only; neither float conversion nor a new rounding rule. */
const money = (value: string | bigint) => {
  const n = BigInt(value); return `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
};

export function renderNativeB2bInvoiceFa3(input: unknown, options: unknown) {
  let document: B2bInvoiceDocument;
  try {
    // Reject oversized/cyclic/non-JSON inputs before the nested native schema.
    const json = JSON.stringify(input);
    if (!json || Buffer.byteLength(json) > 1_048_576) throw new Error();
    const head = documentHead.parse(JSON.parse(json));
    document = validateB2bInvoiceDocument(head as B2bInvoiceDocument);
    // Native159 stores both normalized optional-default fields in its frozen series.
    // An incomplete caller object is not an accepted native snapshot.
    if (typeof document.data.series_definition.notes !== 'string' ||
        typeof document.data.series_definition.payment_instructions !== 'string') throw new Error();
  } catch {
    throw new Fa3XmlError('INVALID_NATIVE_INVOICE', 'A complete supported numbered native159 invoice is required');
  }
  const parsed = exportOptions.safeParse(options);
  if (!parsed.success) throw new Fa3XmlError('INVALID_EXPORT_TIME', 'Explicit canonical UTC export time is required');
  const generatedAt = parsed.data.generated_at, data = document.data, d = data.fiscal_snapshot;
  if (generatedAt.slice(0, 10) < data.issue_date) throw new Fa3XmlError('INVALID_EXPORT_TIME', 'Export time precedes the immutable issue date');
  // Official ETD TNrNIP has an additional lexical constraint beyond checksum.
  if (![d.seller.tax_id, d.buyer.tax_id].every(nip => /^[1-9](?:[0-9][1-9]|[1-9][0-9])[0-9]{7}$/.test(nip)))
    throw new Fa3XmlError('UNSUPPORTED_SCOPE', 'Tax identity is outside the official FA3 NIP format');
  // FA3 Termin uses TData (2016..2050), unlike issue/sale TDataT (2006..2050).
  if (data.due_date < '2016-07-01' || data.due_date > '2050-01-01') throw new Fa3XmlError('UNSUPPORTED_SCOPE', 'Due date is outside the FA3 payment term range');
  const footerTexts = [data.series_definition.notes, data.series_definition.payment_instructions];
  if (footerTexts.some(value => !b2bFa3XmlTextValid(value))) throw new Fa3XmlError('UNSUPPORTED_SCOPE', 'Unsupported XML characters in frozen series text');
  if (d.lines.some(line => (line.zero_domestic_basis?.length ?? 0) > 256)) throw new Fa3XmlError('UNSUPPORTED_SCOPE', 'Domestic zero basis exceeds the FA3 description field');
  const party = (which: 'Podmiot1' | 'Podmiot2', value: typeof d.seller) =>
    `<${which}><DaneIdentyfikacyjne>${tag('NIP', value.tax_id)}${tag('Nazwa', value.name)}</DaneIdentyfikacyjne>` +
    `<Adres>${tag('KodKraju', value.address.country)}${tag('AdresL1', value.address.line1)}` +
    (value.address.line2 === undefined ? '' : tag('AdresL2', value.address.line2)) +
    `</Adres>${which === 'Podmiot2' ? '<JST>2</JST><GV>2</GV>' : ''}</${which}>`;
  const buckets = new Map<string, { net: bigint; vat: bigint }>();
  for (const line of d.lines) {
    const bucket = buckets.get(line.vat_code) ?? { net: 0n, vat: 0n };
    bucket.net += BigInt(line.net_minor); bucket.vat += BigInt(line.vat_minor); buckets.set(line.vat_code, bucket);
  }
  let tax = '';
  for (const [code, index] of [['23', '1'], ['8', '2'], ['5', '3']] as const) {
    const bucket = buckets.get(code);
    if (bucket) tax += tag(`P_13_${index}`, money(bucket.net)) + tag(`P_14_${index}`, money(bucket.vat));
  }
  const domesticZero = buckets.get('0 KR');
  if (domesticZero) tax += tag('P_13_6_1', money(domesticZero.net));
  const zeroBasis = d.lines.filter(line => line.zero_domestic_basis !== null).map(line =>
    '<DodatkowyOpis>' + tag('NrWiersza', String(line.ordinal)) + tag('Klucz', 'Podstawa krajowej stawki 0%') +
    tag('Wartosc', line.zero_domestic_basis!) + '</DodatkowyOpis>').join('');
  const annotations = '<Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A>' +
    '<Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu>' +
    '<P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>';
  const rows = d.lines.map(line => '<FaWiersz>' + tag('NrWierszaFa', String(line.ordinal)) +
    tag('UU_ID', line.line_id) + tag('P_7', line.name) + tag('P_8A', line.unit) + tag('P_8B', line.quantity) +
    tag('P_9B', money(line.unit_gross_minor)) + (line.discount_gross_minor === '0' ? '' : tag('P_10', money(line.discount_gross_minor))) +
    tag('P_11A', money(line.gross_minor)) + tag('P_12', line.vat_code) + '</FaWiersz>').join('');
  const footer = footerTexts.filter(Boolean).map(value => `<Informacje>${tag('StopkaFaktury', value)}</Informacje>`).join('');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Faktura xmlns="${FA3_XML_NAMESPACE}"><Naglowek><KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>` +
    '<WariantFormularza>3</WariantFormularza>' + tag('DataWytworzeniaFa', generatedAt) + '<SystemInfo>DYNAMINDS native159 export</SystemInfo></Naglowek>' +
    party('Podmiot1', d.seller) + party('Podmiot2', d.buyer) + '<Fa><KodWaluty>PLN</KodWaluty>' +
    tag('P_1', data.issue_date) + tag('P_2', document.number) + (data.sale_date === data.issue_date ? '' : tag('P_6', data.sale_date)) +
    tax + tag('P_15', money(d.totals.gross_minor)) + annotations + '<RodzajFaktury>VAT</RodzajFaktury>' + zeroBasis + rows +
    `<Platnosc><TerminPlatnosci>${tag('Termin', data.due_date)}</TerminPlatnosci></Platnosc></Fa>` +
    (footer ? `<Stopka>${footer}</Stopka>` : '') + '</Faktura>\n';
  const bytes = Buffer.byteLength(xml, 'utf8');
  if (bytes > FA3_XML_MAX_BYTES) throw new Fa3XmlError('XML_BYTES_EXCEEDED', 'FA3 XML exceeds 1000000 UTF8 bytes');
  return { format: 'FA (3)/1-0E' as const, namespace: FA3_XML_NAMESPACE, document_id: document.id,
    number: document.number, fiscal_snapshot_hash: b2bFa3DraftHash(d), generated_at: generatedAt,
    xml, xml_sha256: createHash('sha256').update(xml, 'utf8').digest('hex'), xml_bytes: bytes,
    ksef_state: 'not_submitted' as const };
}
