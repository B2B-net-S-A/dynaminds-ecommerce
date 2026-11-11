/** Print of a KOR-S correction from its frozen data (pure): the corrected invoice (number, date, KSeF
 * number), the reason, every changed line before and after, the differences per FA(3) category and,
 * for EUR, the rate of the corrected invoice with the PLN differences. No lookups. */
import { ensure } from './errors';
import { htmlEscape as e } from './portal-view';
import { invoice230BuyerTaxLine, invoice230Money, invoice230RateLabel } from './invoice230-print';
import type { Invoice232Document } from './invoice232';

const KIND_LABEL: Record<string, string> = { return: 'korekta ze zwrotu', quantity: 'korekta ilości', price: 'korekta ceny', mixed: 'korekta ilości i ceny', cancellation: 'korekta do zera (anulowanie)' };
export const invoice232KindLabel = (k: string): string => KIND_LABEL[k] ?? k;

export function invoice232PrintHtml(d: Invoice232Document): string {
  const s = d.data;
  ensure(d.kind === 'correction' && d.mode === 'invoice232_correction' && s.format === 'invoice232/v1' && s.number === d.number && s.local_only === true && s.rows.length >= 1, 409, 'Niepoprawne pochodzenie korekty 232');
  ensure((s.currency === 'PLN') === (s.nbp === null), 409, 'Korekta w walucie obcej wymaga kursu NBP faktury korygowanej');
  const money = (v: string) => e(invoice230Money(v, s.currency)), pln = (v: string) => e(invoice230Money(v, 'PLN'));
  const address = (a: { street: string; postal_code: string; city: string; country: string }) => `${e(a.street)}<br>${e(a.postal_code)} ${e(a.city)}<br>${e(a.country)}`;
  const tax = invoice230BuyerTaxLine(s.buyer), n = s.nbp, notes: string[] = [];
  if (s.mpp.required) notes.push('mechanizm podzielonej płatności');
  if (s.reverse_charge) notes.push('odwrotne obciążenie');
  if (s.exemption) notes.push(`Zwolnienie z VAT: ${s.exemption.basis}`);
  const lineRow = (r: Invoice232Document['data']['rows'][number], when: 'before' | 'after') => {
    const v = r[when];
    return `<tr class="${when}"><td>${when === 'before' ? `${e(r.name)}${r.sku ? '<br>' + e(r.sku) : ''}` : ''}</td><td>${when === 'before' ? 'przed korektą' : 'po korekcie'}</td>` +
      `<td>${e(v.quantity)} ${e(r.unit)}</td><td>${e(invoice230RateLabel(r))}</td><td>${money(v.net_minor)}</td><td>${money(v.vat_minor)}</td><td>${money(v.gross_minor)}</td></tr>`;
  };
  const rows = s.rows.map(r => lineRow(r, 'before') + lineRow(r, 'after') +
    `<tr class="delta"><td></td><td>różnica</td><td>${e(r.delta.quantity)}</td><td></td><td>${money(r.delta.net_minor)}</td><td>${money(r.delta.vat_minor)}</td><td>${money(r.delta.gross_minor)}</td></tr>`).join('');
  const cats = s.categories.map(c => `<tr><td>${e(c.label)}</td><td>${money(c.delta.net_minor)}</td><td>${c.fa3_vat ? money(c.delta.vat_minor) : '—'}</td><td>${money(c.delta.gross_minor)}</td>` +
    `${n ? `<td>${c.pln ? pln(c.pln.delta.net_pln_minor) : '—'}</td><td>${c.pln && c.fa3_vat ? pln(c.pln.delta.vat_pln_minor) : '—'}</td>` : ''}</tr>`).join('');
  const t = s.totals;
  const content = `<!doctype html><html lang="pl"><meta charset="utf-8"><title>${e(d.number)}</title><style>body{font:15px system-ui;max-width:980px;margin:32px auto;color:#17213a}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{padding:8px;border-bottom:1px solid #ccd;text-align:left}.lines td:nth-child(n+5),.lines th:nth-child(n+5),.sum td:nth-child(n+2),.sum th:nth-child(n+2){text-align:right}tr.after td{border-bottom:0}tr.delta td{font-weight:600;border-bottom:2px solid #17213a}.mark{display:inline-block;border:2px solid #17213a;padding:4px 10px;font-weight:700;margin:4px 8px 4px 0}@media print{button{display:none}}</style>
 <h1>Faktura korygująca ${e(d.number)}</h1><p>Dokument lokalny. ${e(invoice232KindLabel(s.kind))}.</p>
 <p>Do faktury <strong>${e(s.original.number)}</strong> z dnia ${e(s.original.issue_date)}${s.original.ksef_number ? ` · numer KSeF faktury korygowanej: ${e(s.original.ksef_number)}` : ' · faktura korygowana bez numeru KSeF'}</p>
 <p>Przyczyna korekty: <strong>${e(s.reason)}</strong></p>
 ${notes.length ? `<p>${notes.map(x => `<span class="mark">${e(x)}</span>`).join('')}</p>` : ''}
 <p>Sprzedawca: <strong>${e(s.seller.name)}</strong><br>${address(s.seller)}<br>NIP: ${e(s.seller.tax_id)}</p>
 <p>Nabywca: <strong>${e(s.buyer.name)}</strong><br>${address(s.buyer.address)}${tax ? '<br>' + e(tax) : ''}</p>
 <p>Zamówienie: ${e(s.order.number)}${s.return ? ` · zwrot: ${e(s.return.number)}` : ''} · data wystawienia korekty: ${e(s.issue_date)} · waluta: ${e(s.currency)}</p>
 <table class="lines"><thead><tr><th>Pozycja</th><th>Stan</th><th>Ilość</th><th>Stawka</th><th>Netto</th><th>VAT</th><th>Brutto</th></tr></thead><tbody>${rows}</tbody></table>
 <h2>Różnice według stawek i kategorii</h2><table class="sum"><thead><tr><th>Kategoria</th><th>Netto</th><th>VAT</th><th>Brutto</th>${n ? '<th>Netto w PLN</th><th>VAT w PLN</th>' : ''}</tr></thead><tbody>${cats}</tbody></table>
 <p>Przed korektą: ${money(t.before.gross_minor)} · po korekcie: ${money(t.after.gross_minor)}</p>
 <p>Różnica netto: ${money(t.delta.net_minor)} · VAT: ${money(t.delta.vat_minor)} · <strong>${BigInt(t.delta.gross_minor) < 0n ? 'Do zwrotu' : 'Do dopłaty'}: ${money(t.delta.gross_minor.replace(/^-/, ''))}</strong></p>
 ${n && s.pln_totals ? `<p>Kurs NBP faktury korygowanej z dnia ${e(n.rate_date)}, tabela ${e(n.table_no)}, 1 EUR = ${e(n.mid.replace('.', ','))} PLN; różnica w PLN: netto ${pln(s.pln_totals.delta.net_pln_minor)} · VAT ${pln(s.pln_totals.delta.vat_pln_minor)} · brutto ${pln(s.pln_totals.delta.gross_pln_minor)}</p>` : ''}
 <p>${e(s.period_basis)}.</p><button onclick="window.print()">Drukuj</button></html>`;
  ensure(Buffer.byteLength(content, 'utf8') <= 2_097_152, 413, 'Wydruk korekty przekracza 2 MiB');
  return content;
}
