/** JPK_FA (4) for a date range of issue dates, built from the same FA(3) facts as the FA(3) XML.
 * Pure. Faktura per invoice/correction, FakturaWiersz per line (corrections: one difference row per
 * changed position), FakturaCtrl and FakturaWierszCtrl sums. Element names and order as in the MF
 * schema Schemat_JPK_FA(4)_v1-0.xsd (schemas/mf/JPK_FA/4). Amounts in the invoice currency, VAT in PLN
 * in P_14_xW. JPK_FA(4) has fewer sale fields than FA(3): the three 0% kinds share P_13_6, NP I, NP II
 * and OSS share P_13_5 (sale outside the country; OSS VAT in P_14_5), `oo` is P_13_4 with P_14_4 = 0
 * (art. 17 ust. 1 pkt 7 i 8). */
import { createHash } from 'node:crypto';
import { FA3_UNTAXED, type Fa3Line, type Fa3RateCode } from './fa3-render';
import {
  JPK_MAX_BYTES, JpkError, jpkGenerationTime, jpkMoney, xmlTag,
  type JpkAddress, type JpkDocument, type JpkTaxpayer,
} from './jpk-model';

export const JPK_FA_NAMESPACE = 'http://jpk.mf.gov.pl/wzor/2022/02/17/02171/';
export const JPK_FA_ETD_NAMESPACE = 'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2018/08/24/eD/DefinicjeTypy/';
/** FA(3) rate code → JPK_FA(4) sale group and the P_12 value of a line. */
const FIELDS: readonly { code: Fa3RateCode; group: number; p12: string }[] = [
  { code: '23', group: 1, p12: '23' }, { code: '8', group: 2, p12: '8' }, { code: '5', group: 3, p12: '5' }, { code: 'oo', group: 4, p12: 'oo' },
  { code: 'np I', group: 5, p12: 'np' }, { code: 'np II', group: 5, p12: 'np' }, { code: 'oss', group: 5, p12: 'oss' },
  { code: '0 KR', group: 6, p12: '0' }, { code: '0 WDT', group: 6, p12: '0' }, { code: '0 EX', group: 6, p12: '0' }, { code: 'zw', group: 7, p12: 'zw' },
];
/** Sale groups in schema order: net field, VAT field (required in the group), PLN VAT field of a foreign-currency invoice. */
const GROUPS: readonly { n: number; net: string; vat: string | null; pln: string | null }[] = [
  { n: 1, net: 'P_13_1', vat: 'P_14_1', pln: 'P_14_1W' }, { n: 2, net: 'P_13_2', vat: 'P_14_2', pln: 'P_14_2W' }, { n: 3, net: 'P_13_3', vat: 'P_14_3', pln: 'P_14_3W' },
  { n: 4, net: 'P_13_4', vat: 'P_14_4', pln: 'P_14_4W' }, { n: 5, net: 'P_13_5', vat: null, pln: null }, { n: 6, net: 'P_13_6', vat: null, pln: null }, { n: 7, net: 'P_13_7', vat: null, pln: null },
];

/** Net of a gross line amount by the app's gross-line method (VAT rounded half up per line). */
export function lineNet(gross: bigint, code: Fa3RateCode, ossRate: string | null): bigint {
  if (FA3_UNTAXED.has(code)) return gross;
  const rate = code === 'oss' ? ossRate : code;
  if (rate === null || !/^(0|[1-9][0-9]?)(\.[0-9]{1,2})?$/.test(rate)) throw new JpkError(422, 'Nieznana stawka pozycji');
  const [w, f = ''] = rate.split('.'), r = BigInt(w!) * 100n + BigInt(f.padEnd(2, '0')), den = 10000n + r;
  const abs = gross < 0n ? -gross : gross, vat = (2n * abs * r + den) / (2n * den);
  return gross < 0n ? -(abs - vat) : abs - vat;
}

type FaLine = { name: string; unit: string; quantity: string; unit_gross: bigint | null; discount: bigint | null; net: bigint; gross: bigint; code: Fa3RateCode; oss_rate: string | null };
/** Invoice lines as they are; a correction gives one row per changed position: after − before. */
function faLines(d: JpkDocument): FaLine[] {
  const m = d.model, plain = (l: Fa3Line): FaLine => ({ name: l.name, unit: l.unit, quantity: l.quantity, unit_gross: l.unit_gross_minor, discount: l.discount_gross_minor,
    net: lineNet(l.gross_minor, l.code, l.oss_rate), gross: l.gross_minor, code: l.code, oss_rate: l.oss_rate });
  if (m.kind === 'VAT') return m.lines.map(plain);
  const out: FaLine[] = [];
  for (let i = 0; i < m.lines.length; i += 2) {
    const before = m.lines[i]!, after = m.lines[i + 1];
    if (!before.before || !after || after.before || after.code !== before.code) throw new JpkError(422, 'Niespójne wiersze korekty');
    const q = BigInt(after.quantity) - BigInt(before.quantity);
    out.push({ name: after.name, unit: after.unit, quantity: q.toString(), unit_gross: null, discount: null,
      net: lineNet(after.gross_minor, after.code, after.oss_rate) - lineNet(before.gross_minor, before.code, before.oss_rate),
      gross: after.gross_minor - before.gross_minor, code: after.code, oss_rate: after.oss_rate });
  }
  return out;
}
const address = (a: { line1: string; line2: string | null }) => a.line2 ? `${a.line1}, ${a.line2}` : a.line1;
const bool = (v: boolean) => (v ? 'true' : 'false');

export type FaInput = { from: string; to: string; taxpayer: JpkTaxpayer; address: JpkAddress; generated_at: string; documents: readonly JpkDocument[] };
export type FaRendered = { xml: string; xml_sha256: string; xml_bytes: number; invoices: number; lines: number;
  invoices_total_minor: bigint; lines_net_total_minor: bigint; filename: string };

export function renderJpkFa(input: FaInput): FaRendered {
  const generated = jpkGenerationTime(input.generated_at), tp = input.taxpayer, a = input.address;
  if (input.from > input.to) throw new JpkError(400, 'Data początkowa jest późniejsza niż końcowa');
  const docs = [...input.documents].sort((x, y) => (`${x.model.issue_date}\u0000${x.model.number}\u0000${x.id}` < `${y.model.issue_date}\u0000${y.model.number}\u0000${y.id}` ? -1 : 1));
  for (const d of docs) if (d.model.issue_date < input.from || d.model.issue_date > input.to) throw new JpkError(422, 'Dokument spoza zakresu pliku');
  let invoicesTotal = 0n, linesNet = 0n, lineCount = 0;
  const invoices: string[] = [], rows: string[] = [];
  for (const d of docs) {
    const m = d.model, lines = faLines(d);
    // The line nets recomputed by the gross-line method must give the stored bucket nets.
    for (const f of FIELDS) {
      const b = m.buckets.find(x => x.code === f.code), sum = lines.filter(l => l.code === f.code).reduce((n, l) => n + l.net, 0n);
      if ((b?.net_minor ?? 0n) !== sum) throw new JpkError(422, `Netto pozycji dokumentu ${m.number} nie sumuje się do stawki ${f.code}`);
    }
    let tax = '';
    for (const g of GROUPS) {
      const buckets = m.buckets.filter(b => FIELDS.find(f => f.code === b.code)!.group === g.n);
      if (!buckets.length) continue;
      const net = buckets.reduce((n, b) => n + b.net_minor, 0n), vat = buckets.reduce((n, b) => n + b.vat_minor, 0n);
      tax += xmlTag(g.net, jpkMoney(net));
      if (g.vat) tax += xmlTag(g.vat, jpkMoney(vat));
      // oo (group 4) has no VAT: P_14_4W is 0 like P_14_4.
      if (g.pln && m.currency !== 'PLN') tax += xmlTag(g.pln, jpkMoney(g.n === 4 ? 0n : buckets[0]!.vat_pln_minor ?? fail(m.number)));
      // VAT of the special OSS procedure (art. 130a ff.) in the invoice currency.
      const oss = buckets.find(b => b.code === 'oss');
      if (g.n === 5 && oss) tax += xmlTag('P_14_5', jpkMoney(oss.vat_minor));
    }
    const exemption = m.exemption
      ? `<P_19>true</P_19>${xmlTag(m.exemption.kind, m.exemption.text)}` : '<P_19>false</P_19>';
    const correction = m.kind === 'KOR'
      ? xmlTag('PrzyczynaKorekty', m.correction!.reason) + xmlTag('NrFaKorygowanej', m.correction!.original.number) : '';
    invoices.push('<Faktura>' + xmlTag('KodWaluty', m.currency) + xmlTag('P_1', m.issue_date) + xmlTag('P_2A', m.number) +
      xmlTag('P_3A', m.buyer.name) + xmlTag('P_3B', address(m.buyer.address)) + xmlTag('P_3C', m.seller.name) + xmlTag('P_3D', address(m.seller.address)) +
      xmlTag('P_4A', m.seller.address.country) + xmlTag('P_4B', m.seller.nip!) +
      (m.buyer.nip ? xmlTag('P_5A', m.buyer.address.country) + xmlTag('P_5B', m.buyer.nip) : m.buyer.vat_ue ? xmlTag('P_5A', m.buyer.vat_ue.code) + xmlTag('P_5B', m.buyer.vat_ue.number) : '') +
      (m.sale_date !== null && m.sale_date !== m.issue_date ? xmlTag('P_6', m.sale_date) : '') + tax + xmlTag('P_15', jpkMoney(m.total_gross_minor)) +
      `<P_16>false</P_16><P_17>false</P_17><P_18>${bool(m.reverse_charge)}</P_18><P_18A>${bool(m.split_payment)}</P_18A>` + exemption +
      '<P_20>false</P_20><P_21>false</P_21><P_22>false</P_22><P_23>false</P_23><P_106E_2>false</P_106E_2><P_106E_3>false</P_106E_3>' +
      xmlTag('RodzajFaktury', m.kind === 'KOR' ? 'KOREKTA' : 'VAT') + correction + '</Faktura>');
    invoicesTotal += m.total_gross_minor;
    for (const l of lines) {
      const p12 = FIELDS.find(f => f.code === l.code)!;
      rows.push('<FakturaWiersz>' + xmlTag('P_2B', m.number) + xmlTag('P_7', l.name) + xmlTag('P_8A', l.unit) + xmlTag('P_8B', l.quantity) +
        (l.unit_gross === null ? '' : xmlTag('P_9B', jpkMoney(l.unit_gross))) + (l.discount === null || l.discount === 0n ? '' : xmlTag('P_10', jpkMoney(l.discount))) +
        xmlTag('P_11', jpkMoney(l.net)) + xmlTag('P_11A', jpkMoney(l.gross)) + (l.code === 'oss' ? xmlTag('P_12_XII', l.oss_rate!) : xmlTag('P_12', p12.p12)) + '</FakturaWiersz>');
      linesNet += l.net; lineCount++;
    }
  }
  // The schema requires at least one Faktura and one FakturaWiersz.
  if (!invoices.length) throw new JpkError(409, 'W wybranym zakresie nie ma faktur — JPK_FA(4) wymaga co najmniej jednej faktury');
  if (!lineCount) throw new JpkError(409, 'JPK_FA(4) wymaga co najmniej jednego wiersza faktury — w zakresie są tylko korekty bez zmienionych pozycji');
  const adres = '<AdresPodmiotu>' + xmlTag('etd:KodKraju', 'PL') + xmlTag('etd:Wojewodztwo', a.wojewodztwo) + xmlTag('etd:Powiat', a.powiat) + xmlTag('etd:Gmina', a.gmina) +
    (a.ulica ? xmlTag('etd:Ulica', a.ulica) : '') + xmlTag('etd:NrDomu', a.nr_domu) + (a.nr_lokalu ? xmlTag('etd:NrLokalu', a.nr_lokalu) : '') +
    xmlTag('etd:Miejscowosc', a.miejscowosc) + xmlTag('etd:KodPocztowy', a.kod_pocztowy) + '</AdresPodmiotu>';
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<JPK xmlns="${JPK_FA_NAMESPACE}" xmlns:etd="${JPK_FA_ETD_NAMESPACE}"><Naglowek>` +
    '<KodFormularza kodSystemowy="JPK_FA (4)" wersjaSchemy="1-0">JPK_FA</KodFormularza><WariantFormularza>4</WariantFormularza>' +
    xmlTag('CelZlozenia', String(tp.purpose)) + xmlTag('DataWytworzeniaJPK', generated) + xmlTag('DataOd', input.from) + xmlTag('DataDo', input.to) +
    xmlTag('KodUrzedu', tp.office) + '</Naglowek>' +
    `<Podmiot1><IdentyfikatorPodmiotu>${xmlTag('NIP', tp.nip)}${xmlTag('PelnaNazwa', tp.name)}</IdentyfikatorPodmiotu>${adres}</Podmiot1>` +
    invoices.join('') + `<FakturaCtrl>${xmlTag('LiczbaFaktur', String(invoices.length))}${xmlTag('WartoscFaktur', jpkMoney(invoicesTotal))}</FakturaCtrl>` +
    rows.join('') + `<FakturaWierszCtrl>${xmlTag('LiczbaWierszyFaktur', String(lineCount))}${xmlTag('WartoscWierszyFaktur', jpkMoney(linesNet))}</FakturaWierszCtrl></JPK>\n`;
  const bytes = Buffer.byteLength(xml, 'utf8');
  if (bytes > JPK_MAX_BYTES) throw new JpkError(413, 'Plik JPK przekracza dopuszczalny rozmiar');
  return { xml, xml_sha256: createHash('sha256').update(xml, 'utf8').digest('hex'), xml_bytes: bytes, invoices: invoices.length, lines: lineCount,
    invoices_total_minor: invoicesTotal, lines_net_total_minor: linesNet, filename: `JPK_FA-${input.from}_${input.to}.xml` };
}
function fail(number: string): never { throw new JpkError(409, 'Brak kwoty VAT w PLN (kurs NBP)', [{ number, reason: 'Faktura w walucie obcej bez kwoty VAT w PLN' }]); }
