import {ensure} from './errors';
import {htmlEscape} from './portal-view';
import {validateB2bInvoiceDocument,b2bInvoiceVatBuckets,type B2bInvoiceDocument} from './b2b-invoice-values';
const e=(v:Parameters<typeof htmlEscape>[0])=>htmlEscape(v).replace(/\r/g,'&#13;');
/** Pure full immutable print. Local document; no KSeF identifier/UPO or fiscal receipt. */
export function b2bInvoicePrintHtml(input:B2bInvoiceDocument):string{
 const doc=validateB2bInvoiceDocument(input),s=doc.data,d=s.fiscal_snapshot;
 const money=(v:string)=>{const n=BigInt(v);return e((n/100n).toString()+','+(n%100n).toString().padStart(2,'0')+' PLN');};
 const party=(p:typeof d.seller)=>`<strong>${e(p.name)}</strong><br>${e(p.address.line1)}${p.address.line2?'<br>'+e(p.address.line2):''}<br>${e(p.address.country)}<br>NIP: ${e(p.tax_id)}`;
 const html=`<!doctype html><html lang="pl"><meta charset="utf-8"><title>${e(doc.number)}</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;color:#17213a}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #ccd;text-align:left}@media print{button{display:none}}</style>
 <h1>Faktura ${e(doc.number)}</h1><p>Dokument lokalny B2B. Nie przesłano do KSeF; brak numeru KSeF/UPO. Nie jest paragonem fiskalnym.</p>
 <p>Sprzedawca: ${party(d.seller)}</p><p>Nabywca: ${party(d.buyer)}</p>
 <p>Zamówienie: ${e(s.order_number)} · wystawiono: ${e(s.issue_date)} · data sprzedaży: ${e(s.sale_date)} · termin płatności: ${e(s.due_date)}</p>
 <p>Projekt źródłowy: ${e(s.project_id)} · receipt zatwierdzenia projektu: ${e(s.project_receipt_id)} · tryb płatności: ${e(s.payment_mode)}</p>
 <table><thead><tr><th>Pozycja</th><th>Ilość/j.m.</th><th>Cena jedn. brutto</th><th>Rabat brutto</th><th>Różnica zaokrąglenia pozycji</th><th>VAT</th><th>Netto</th><th>VAT kwota</th><th>Brutto</th></tr></thead><tbody>${d.lines.map(r=>`<tr><td>${e(r.name)}${r.zero_domestic_basis?'<br>Podstawa stawki0: '+e(r.zero_domestic_basis):''}</td><td>${e(r.quantity)} ${e(r.unit)}</td><td>${money(r.unit_gross_minor)}</td><td>${money(r.discount_gross_minor)}</td><td>${money(r.rounding_gross_minor)}</td><td>${e(r.vat_code)}</td><td>${money(r.net_minor)}</td><td>${money(r.vat_minor)}</td><td>${money(r.gross_minor)}</td></tr>`).join('')}</tbody></table>
 <h2>Podział według stawek VAT</h2><table><thead><tr><th>VAT</th><th>Netto</th><th>VAT kwota</th><th>Brutto</th></tr></thead><tbody>${b2bInvoiceVatBuckets(d).map(r=>`<tr><td>${e(r.vat_code)}</td><td>${money(r.net_minor)}</td><td>${money(r.vat_minor)}</td><td>${money(r.gross_minor)}</td></tr>`).join('')}</tbody></table>
 <p>Netto: ${money(d.totals.net_minor)} · VAT: ${money(d.totals.vat_minor)} · Brutto: ${money(d.totals.gross_minor)}</p><p>${e(s.series_definition.payment_instructions)}</p><p>${e(s.series_definition.notes)}</p><button onclick="window.print()">Drukuj</button></html>`;
 ensure(Buffer.byteLength(html,'utf8')<=2097152,413,'Pełny wydruk przekracza2MiB; brak obcięcia');return html;
}
