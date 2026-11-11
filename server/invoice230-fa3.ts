/** Pure mapping of a 230 invoice onto the normalized FA(3) model (and, through it, the JPK files):
 * Podmiot2 with NIP, KodUE + NrVatUE or BrakID; P_12 per line from the stored category; P_13_x/P_14_x
 * per FA(3) code; P_18 (oo, np II), P_18A (MPP), P_19 + basis; for EUR KodWaluty, KursWaluty on every
 * line and P_14_xW from the stored PLN amounts. Sums are cross-checked against the stored record. */
import type { Invoice230Document, Invoice230Header } from './invoice230';
import { FA3_SYSTEM_INFO, type Fa3DocumentRate } from './fa3-adapters';
import { fa3Buckets, fa3Invalid, fa3Minor, fa3Refuse, type Fa3Document, type Fa3Line, type Fa3Party, type Fa3RateCode } from './fa3-render';
import { EU_VAT_PREFIX } from './invoice230-model';

const CODES: readonly string[] = ['23', '8', '5', '0 KR', 'zw', 'np I', 'np II', 'oo', 'oss'];
const party = (name: string, a: { street: string; postal_code: string; city: string; country: string }, nip: string | null, vat_ue: Fa3Party['vat_ue'] = null): Fa3Party =>
  ({ nip, name, address: { country: a.country, line1: a.street, line2: `${a.postal_code} ${a.city}` }, vat_ue });

/** The 227-shaped rate of the document for the JPK conversion: taxed categories with their stored PLN amounts. */
export function invoice230Rate(doc: Invoice230Document, record: Invoice230Header): Fa3DocumentRate | null {
  const n = doc.data.nbp;
  if (!n) return null;
  if (record.mid !== n.mid || record.currency !== doc.data.currency) fa3Invalid('Kurs zapisany z fakturą nie odpowiada jej migawce');
  return { currency: doc.data.currency, mid: n.mid, vat: n.categories.filter(c => ['23', '8', '5', '0 KR'].includes(c.rate_code)).map(c => ({
    vat_rate: c.rate_code === '0 KR' ? 0 : Number(c.rate_code), net_minor: BigInt(c.net_minor), vat_minor: BigInt(c.vat_minor),
    vat_pln_minor: BigInt(c.vat_pln_minor), net_pln_minor: BigInt(c.net_pln_minor) })) };
}

export function invoice230Fa3Model(doc: Invoice230Document, record: Invoice230Header): Fa3Document {
  const s = doc?.data;
  if (!s || doc.kind !== 'invoice' || doc.mode !== 'invoice230' || s.format !== 'invoice230/v1' || s.number !== doc.number || !Array.isArray(s.lines) || !s.lines.length)
    fa3Invalid('Niepełna migawka faktury 230');
  if ((s.currency !== 'PLN') !== (s.nbp !== null)) fa3Refuse(`Faktura w walucie ${s.currency} wymaga zapisanego kursu NBP`);
  if (s.procedure === 'oss' && s.currency !== 'PLN') fa3Refuse('Faktura OSS w walucie obcej nie jest obsługiwana');
  const b = s.buyer;
  const buyer = b.tax_id_kind === 'nip' ? party(b.name, b.address, b.tax_id)
    : b.tax_id_kind === 'eu_vat' ? party(b.name, b.address, null, { code: EU_VAT_PREFIX[b.address.country] ?? fa3Invalid('Numer VAT UE spoza UE'), number: b.tax_id.slice(2) })
      : party(b.name, b.address, null);
  if (b.tax_id_kind === 'eu_vat' && !b.tax_id.startsWith(EU_VAT_PREFIX[b.address.country]!)) fa3Invalid('Prefiks numeru VAT UE nie odpowiada krajowi nabywcy');
  let gross = 0n, net = 0n, vat = 0n;
  const rows = s.lines.map(l => {
    if (!CODES.includes(l.rate_code)) fa3Invalid('Nieznany kod stawki pozycji');
    const code = l.rate_code as Fa3RateCode, g = fa3Minor(l.gross_minor, 'brutto'), n = fa3Minor(l.net_minor, 'netto'), v = fa3Minor(l.vat_minor, 'VAT');
    if (n + v !== g) fa3Invalid('Kwoty pozycji nie sumują się');
    if (['0 KR', 'zw', 'np I', 'np II', 'oo'].includes(code) && v !== 0n) fa3Invalid(`Pozycja ${code} ma naliczony VAT`);
    gross += g; net += n; vat += v;
    const unit = fa3Minor(l.unit_gross_minor, 'cena'), discount = fa3Minor(l.discount_gross_minor, 'rabat'), exact = unit * BigInt(l.quantity) - discount === g;
    const line: Fa3Line = { name: l.name, unit: l.unit, quantity: String(l.quantity), gross_minor: g, code, oss_rate: code === 'oss' ? l.rate! : null,
      uu_id: null, gtu: l.gtu, annex15: l.annex15, fx_rate: s.nbp ? s.nbp.mid : null, before: false, note: null,
      unit_gross_minor: exact ? unit : null, discount_gross_minor: exact ? discount : null };
    return { line, code, net_minor: n, vat_minor: v };
  });
  if (gross !== fa3Minor(s.totals.gross_minor, 'suma') || net !== fa3Minor(s.totals.net_minor, 'suma') || vat !== fa3Minor(s.totals.vat_minor, 'suma'))
    fa3Invalid('Pozycje nie sumują się do zapisanych sum faktury');
  const stored = new Map(record.categories.map(c => [c.key, c]));
  for (const c of s.categories) {
    const r = stored.get(c.key);
    if (!r || r.net_minor !== c.net_minor || r.vat_minor !== c.vat_minor) fa3Invalid('Podsumowanie kategorii nie odpowiada zapisowi 230');
  }
  const rate = invoice230Rate(doc, record);
  const buckets = fa3Buckets(rows).map(bk => {
    if (!rate || !['23', '8', '5'].includes(bk.code)) return bk;
    const r = rate.vat.find(x => String(x.vat_rate) === bk.code);
    if (!r || r.net_minor !== bk.net_minor || r.vat_minor !== bk.vat_minor) fa3Invalid('Kwoty w PLN nie odpowiadają stawce ' + bk.code);
    return { ...bk, vat_pln_minor: r!.vat_pln_minor };
  });
  const footer = [s.series.notes, s.series.payment_instructions].filter(v => typeof v === 'string' && v.length > 0);
  return { kind: 'VAT', number: doc.number, issue_date: s.issue_date, sale_date: s.sell_date, currency: s.currency,
    seller: party(s.seller.name, s.seller, s.seller.tax_id), buyer, buckets, total_gross_minor: gross,
    reverse_charge: s.reverse_charge, split_payment: s.mpp.required, exemption: s.exemption ? { kind: s.exemption.kind, text: s.exemption.basis } : null,
    correction: null, lines: rows.map(r => r.line), due_date: s.due_date, footer, system_info: FA3_SYSTEM_INFO };
}
