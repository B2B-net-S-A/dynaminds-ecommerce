/** Pure mapping of a KOR-S correction onto the normalized FA(3) model (and, through it, the JPK files):
 * RodzajFaktury KOR, PrzyczynaKorekty, TypKorekty=2, DaneFaKorygowanej with NrKSeFFaKorygowanej when the
 * corrected FV-S has a KSeF number, one StanPrzed=1 row and one row after for every changed line,
 * P_13_x/P_14_x and P_15 as signed differences, P_18/P_18A/P_19 of the corrected invoice and, for EUR,
 * KodWaluty, KursWaluty (the corrected invoice's mid) on every row and P_14_xW from the stored PLN
 * differences. Sums are cross-checked against the stored record. */
import type { Invoice232Document, Invoice232Record } from './invoice232';
import { FA3_SYSTEM_INFO, type Fa3DocumentRate } from './fa3-adapters';
import { fa3Buckets, fa3Invalid, fa3Minor, fa3Refuse, type Fa3Document, type Fa3Line, type Fa3Party, type Fa3RateCode } from './fa3-render';
import { EU_VAT_PREFIX } from './invoice230-model';

/** Corrections of the value of the original transaction lower (or raise) the base in the period of the correction (art. 29a ust. 13/17). */
export const INVOICE232_CORRECTION_TYPE = 2;
const CODES: readonly string[] = ['23', '8', '5', '0 KR', 'zw', 'np I', 'np II', 'oo', 'oss'];
const TAXED = ['23', '8', '5', '0 KR'];
const party = (name: string, a: { street: string; postal_code: string; city: string; country: string }, nip: string | null, vat_ue: Fa3Party['vat_ue'] = null): Fa3Party =>
  ({ nip, name, address: { country: a.country, line1: a.street, line2: `${a.postal_code} ${a.city}` }, vat_ue });

/** Rate of the correction for the JPK conversion: the corrected invoice's mid with the stored signed PLN differences. */
export function invoice232Rate(doc: Invoice232Document, record: Invoice232Record): Fa3DocumentRate | null {
  const n = doc.data.nbp;
  if (!n) return null;
  if (record.mid !== n.mid || record.currency !== doc.data.currency) fa3Invalid('Kurs zapisany z korektą nie odpowiada jej danym');
  const pln = (c: Invoice232Document['data']['categories'][number]) => c.pln ?? fa3Invalid('Korekta w EUR bez kwot w PLN');
  return { currency: doc.data.currency, mid: n.mid,
    vat: doc.data.categories.filter(c => TAXED.includes(c.rate_code)).map(c => ({ vat_rate: c.rate_code === '0 KR' ? 0 : Number(c.rate_code),
      net_minor: BigInt(c.delta.net_minor), vat_minor: BigInt(c.delta.vat_minor), vat_pln_minor: BigInt(pln(c).delta.vat_pln_minor), net_pln_minor: BigInt(pln(c).delta.net_pln_minor) })),
    untaxed_pln: doc.data.categories.filter(c => !TAXED.includes(c.rate_code)).reduce<{ code: string; net_pln_minor: bigint }[]>((out, c) => {
      const code = c.rate_code, hit = out.find(x => x.code === code), v = BigInt(pln(c).delta.net_pln_minor);
      if (hit) hit.net_pln_minor += v; else out.push({ code, net_pln_minor: v });
      return out;
    }, []) };
}

export function invoice232Fa3Model(doc: Invoice232Document, record: Invoice232Record): Fa3Document {
  const s = doc?.data;
  if (!s || doc.kind !== 'correction' || doc.mode !== 'invoice232_correction' || s.format !== 'invoice232/v1' || s.number !== doc.number || !Array.isArray(s.rows) || !s.rows.length
    || s.original.document_id !== doc.original_document_id)
    fa3Invalid('Niepełne dane korekty KOR-S');
  if ((s.currency !== 'PLN') !== (s.nbp !== null)) fa3Refuse(`Korekta w walucie ${s.currency} wymaga kursu NBP faktury korygowanej`);
  const b = s.buyer;
  const buyer = b.tax_id_kind === 'nip' ? party(b.name, b.address, b.tax_id)
    : b.tax_id_kind === 'eu_vat' ? party(b.name, b.address, null, { code: EU_VAT_PREFIX[b.address.country] ?? fa3Invalid('Numer VAT UE spoza UE'), number: b.tax_id.slice(2) })
      : party(b.name, b.address, null);
  const fx = s.nbp ? s.nbp.mid : null;
  let net = 0n, vat = 0n, gross = 0n;
  const lines: Fa3Line[] = [], deltas: { code: Fa3RateCode; net_minor: bigint; vat_minor: bigint }[] = [];
  for (const r of s.rows) {
    if (!CODES.includes(r.rate_code)) fa3Invalid('Nieznany kod stawki pozycji korekty');
    const code = r.rate_code as Fa3RateCode;
    const d = { net: fa3Minor(r.delta.net_minor, 'różnica'), vat: fa3Minor(r.delta.vat_minor, 'różnica'), gross: fa3Minor(r.delta.gross_minor, 'różnica') };
    const before = fa3Minor(r.before.gross_minor, 'przed'), after = fa3Minor(r.after.gross_minor, 'po');
    if (d.net + d.vat !== d.gross || after - before !== d.gross) fa3Invalid('Różnica pozycji korekty nie sumuje się');
    if (!TAXED.slice(0, 3).includes(code) && code !== 'oss' && (d.vat !== 0n || fa3Minor(r.after.vat_minor, 'VAT') !== 0n)) fa3Invalid(`Pozycja ${code} ma naliczony VAT`);
    net += d.net; vat += d.vat; gross += d.gross;
    const common = { name: r.name, unit: r.unit, code, oss_rate: code === 'oss' ? r.rate : null, uu_id: null, gtu: r.gtu, annex15: r.annex15, fx_rate: fx, note: null,
      unit_gross_minor: null, discount_gross_minor: null } as const;
    lines.push({ ...common, quantity: String(r.before.quantity), gross_minor: before, before: true }, { ...common, quantity: String(r.after.quantity), gross_minor: after, before: false });
    deltas.push({ code, net_minor: d.net, vat_minor: d.vat });
  }
  const t = s.totals.delta;
  if (gross !== fa3Minor(t.gross_minor, 'suma') || net !== fa3Minor(t.net_minor, 'suma') || vat !== fa3Minor(t.vat_minor, 'suma'))
    fa3Invalid('Pozycje korekty nie sumują się do różnicy korekty');
  const stored = new Map(record.categories.map(c => [c.key, c]));
  for (const c of s.categories) {
    const r = stored.get(c.key);
    if (!r || r.net_delta_minor !== c.delta.net_minor || r.vat_delta_minor !== c.delta.vat_minor) fa3Invalid('Podsumowanie kategorii nie odpowiada zapisowi 232');
  }
  const rate = invoice232Rate(doc, record);
  const buckets = fa3Buckets(deltas).map(bk => {
    if (!rate || !['23', '8', '5'].includes(bk.code)) return bk;
    const r = rate.vat.find(x => String(x.vat_rate) === bk.code);
    if (!r || r.net_minor !== bk.net_minor || r.vat_minor !== bk.vat_minor) fa3Invalid('Kwoty w PLN nie odpowiadają stawce ' + bk.code);
    return { ...bk, vat_pln_minor: r!.vat_pln_minor };
  });
  return { kind: 'KOR', number: doc.number, issue_date: s.issue_date, sale_date: null, currency: s.currency,
    seller: party(s.seller.name, s.seller, s.seller.tax_id), buyer, buckets, total_gross_minor: gross,
    reverse_charge: s.reverse_charge, split_payment: s.mpp.required, exemption: s.exemption ? { kind: s.exemption.kind, text: s.exemption.basis } : null,
    correction: { reason: s.reason, type: INVOICE232_CORRECTION_TYPE, original: { number: s.original.number, issue_date: s.original.issue_date, ksef_number: s.original.ksef_number } },
    lines, due_date: null, footer: [], system_info: FA3_SYSTEM_INFO };
}
