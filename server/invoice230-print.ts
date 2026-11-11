/** Print of a 230 invoice from its frozen snapshot (pure): buyer NIP / EU VAT ID, the category of
 * every line, the summary per FA(3) category, the mandatory annotations (zwolnienie with its basis,
 * odwrotne obciążenie, mechanizm podzielonej płatności, OSS) and, for EUR, the NBP rate line with
 * the VAT in PLN. No lookups. */
import { ensure } from './errors';
import { htmlEscape as e } from './portal-view';
import { FA3_SUMMARY_FIELD } from './invoice230-model';
import type { Invoice230Document } from './invoice230';

const RATE_LABEL: Record<string, string> = { zw: 'zw', 'np I': 'np', 'np II': 'np', oo: 'oo', '0 KR': '0%' };
export function invoice230Money(minor: string, currency: string): string {
  const v = BigInt(minor), abs = v < 0n ? -v : v, whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${v < 0n ? '-' : ''}${whole},${(abs % 100n).toString().padStart(2, '0')} ${currency}`;
}
export const invoice230RateLabel = (l: { rate_code: string; rate: string | null }) =>
  RATE_LABEL[l.rate_code] ?? (l.rate_code === 'oss' ? `${l.rate!.replace(/\.00$/, '').replace('.', ',')}% (OSS)` : `${l.rate_code}%`);
/** The annotations the invoice must carry (art. 106e ust. 1 pkt 18, 18a, 19 ustawy o VAT) and the procedure notes. */
export function invoice230Annotations(s: Invoice230Document['data']): string[] {
  const out: string[] = [], codes = new Set(s.lines.map(l => l.rate_code));
  if (s.mpp.required) out.push('mechanizm podzielonej płatności');
  if (codes.has('oo') || codes.has('np II')) out.push('odwrotne obciążenie');
  if (codes.has('np II')) out.push('Usługa, do której stosuje się art. 28b ustawy o VAT — VAT rozlicza nabywca (art. 100 ust. 1 pkt 4).');
  if (codes.has('np I')) out.push('Sprzedaż poza terytorium kraju — nie podlega opodatkowaniu VAT w Polsce.');
  if (s.exemption) out.push(`Zwolnienie z VAT: ${s.exemption.basis}`);
  if (s.procedure === 'oss') out.push(`Procedura szczególna OSS — VAT według stawek państwa konsumpcji (${s.buyer.address.country}).`);
  return out;
}
export function invoice230BuyerTaxLine(b: Invoice230Document['data']['buyer']): string | null {
  return b.tax_id_kind === 'nip' ? `NIP: ${b.tax_id}` : b.tax_id_kind === 'eu_vat' ? `Numer VAT UE: ${b.tax_id}` : null;
}

/** `receipt`: the fiscal receipt the invoice was issued to (233), printed as "Faktura do paragonu …". */
export function invoice230PrintHtml(d: Invoice230Document, receipt: { number: string; fiscal_date: string; printer_unique_number: string } | null = null): string {
  const s = d.data;
  ensure(d.kind === 'invoice' && d.mode === 'invoice230' && s.format === 'invoice230/v1' && s.number === d.number && s.local_only === true && s.lines.length >= 1, 409, 'Niepoprawne pochodzenie faktury 230');
  ensure((s.currency === 'PLN') === (s.nbp === null), 409, 'Faktura w walucie obcej wymaga zapisanego kursu NBP');
  const money = (v: string) => e(invoice230Money(v, s.currency)), pln = (v: string) => e(invoice230Money(v, 'PLN'));
  const address = (a: { street: string; postal_code: string; city: string; country: string }) => `${e(a.street)}<br>${e(a.postal_code)} ${e(a.city)}<br>${e(a.country)}`;
  const tax = invoice230BuyerTaxLine(s.buyer), notes = invoice230Annotations(s), n = s.nbp;
  const catRows = s.categories.map(c => {
    const p = n?.categories.find(x => x.key === c.key);
    return `<tr><td>${e(c.label)}</td><td>${money(c.net_minor)}</td><td>${FA3_SUMMARY_FIELD[c.rate_code]?.vat ? money(c.vat_minor) : '—'}</td><td>${money(c.gross_minor)}</td>${n ? `<td>${p ? pln(p.vat_pln_minor) : '—'}</td>` : ''}</tr>`;
  }).join('');
  const content = `<!doctype html><html lang="pl"><meta charset="utf-8"><title>${e(d.number)}</title><style>body{font:15px system-ui;max-width:980px;margin:32px auto;color:#17213a}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{padding:8px;border-bottom:1px solid #ccd;text-align:left}.lines td:nth-child(n+3),.lines th:nth-child(n+3),.sum td:nth-child(n+2),.sum th:nth-child(n+2){text-align:right}.lines td:nth-child(4),.lines th:nth-child(4){text-align:left}.mark{display:inline-block;border:2px solid #17213a;padding:4px 10px;font-weight:700;margin:4px 8px 4px 0}@media print{button{display:none}}</style>
 <h1>Faktura ${e(d.number)}</h1><p>Dokument lokalny. Nie przesłano do KSeF; brak numeru KSeF/UPO.</p>
 ${receipt ? `<p><span class="mark">Faktura do paragonu fiskalnego</span> nr ${e(receipt.number)} z dnia ${e(receipt.fiscal_date)}, kasa ${e(receipt.printer_unique_number)}</p>` : ''}
 ${notes.length ? `<p>${notes.map(t => `<span class="mark">${e(t)}</span>`).join('')}</p>` : ''}
 <p>Sprzedawca: <strong>${e(s.seller.name)}</strong><br>${address(s.seller)}<br>NIP: ${e(s.seller.tax_id)}</p>
 <p>Nabywca: <strong>${e(s.buyer.name)}</strong><br>${address(s.buyer.address)}${tax ? '<br>' + e(tax) : ''}</p>
 <p>Zamówienie: ${e(s.order.number)} · data wystawienia: ${e(s.issue_date)} · data sprzedaży: ${e(s.sell_date)} · termin płatności: ${e(s.due_date)} · waluta: ${e(s.currency)}</p>
 <table class="lines"><thead><tr><th>Pozycja</th><th>Ilość</th><th>Cena jedn. brutto</th><th>Stawka</th><th>Netto</th><th>VAT</th><th>Brutto</th></tr></thead><tbody>${s.lines.map(l =>
    `<tr><td>${e(l.name)}${l.sku ? '<br>' + e(l.sku) : ''}${l.gtu ? '<br>' + e(l.gtu) : ''}</td><td>${e(l.quantity)} ${e(l.unit)}</td><td>${money(l.unit_gross_minor)}</td><td>${e(invoice230RateLabel(l))}</td><td>${money(l.net_minor)}</td><td>${money(l.vat_minor)}</td><td>${money(l.gross_minor)}</td></tr>`).join('')}</tbody></table>
 <h2>Podsumowanie według stawek i kategorii</h2><table class="sum"><thead><tr><th>Kategoria</th><th>Netto</th><th>VAT</th><th>Brutto</th>${n ? '<th>VAT w PLN</th>' : ''}</tr></thead><tbody>${catRows}</tbody></table>
 <p>Razem netto: ${money(s.totals.net_minor)} · VAT: ${money(s.totals.vat_minor)} · <strong>Do zapłaty: ${money(s.totals.gross_minor)}</strong></p>
 ${n ? `<p>${e(n.line)}</p><p>Kwoty w PLN: netto ${pln(n.totals.net_pln_minor)} · VAT ${pln(n.totals.vat_pln_minor)} · brutto ${pln(n.totals.gross_pln_minor)}</p>` : ''}
 ${s.series.payment_instructions ? `<p>${e(s.series.payment_instructions)}</p>` : ''}${s.series.notes ? `<p>${e(s.series.notes)}</p>` : ''}<button onclick="window.print()">Drukuj</button></html>`;
  ensure(Buffer.byteLength(content, 'utf8') <= 2_097_152, 413, 'Wydruk faktury przekracza 2 MiB');
  return content;
}
