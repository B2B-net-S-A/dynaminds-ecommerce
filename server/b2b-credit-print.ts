import {ensure} from './errors';
import {htmlEscape} from './portal-view';
import {validateB2bCreditDocument,type B2bCreditDocument} from './b2b-credit-values';
const e=(v:Parameters<typeof htmlEscape>[0])=>htmlEscape(v).replace(/\r/g,'&#13;');
/** Pure full immutable print. Native correction; local unsent, no bank/KSeF proof. */
export function b2bCreditPrintHtml(input:B2bCreditDocument):string{
 const doc=validateB2bCreditDocument(input),s=doc.data,c=s.calculation,f=c.fiscal_snapshot;
 const money=(v:string)=>{const n=BigInt(v),a=n<0n?-n:n;return e((n<0n?'-':'')+(a/100n).toString()+','+(a%100n).toString().padStart(2,'0')+' PLN');};
 const party=(p:typeof f.seller)=>`<strong>${e(p.name)}</strong><br>${e(p.address.line1)}${p.address.line2?'<br>'+e(p.address.line2):''}<br>${e(p.address.country)}<br>NIP: ${e(p.tax_id)}`;
 const cells=(r:typeof c.totals)=>['net_minor','vat_minor','gross_minor'].flatMap(k=>['before','after','delta'].map(state=>`<td>${money(r[state as 'before'][k as 'net_minor'])}</td>`)).join('');
 const html=`<!doctype html><html lang="pl"><meta charset="utf-8"><title>${e(doc.number)}</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;color:#17213a}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #ccd;text-align:left}@media print{button{display:none}}</style>
 <h1>Faktura korygująca ${e(doc.number)}</h1><p>Dokument lokalny B2B. Nie przesłano do KSeF; brak numeru KSeF/UPO. Nie jest paragonem fiskalnym.</p>
 <p>Sprzedawca: ${party(f.seller)}</p><p>Nabywca: ${party(f.buyer)}</p>
 <p>Faktura pierwotna: ${e(c.original.number)} · dokument: ${e(s.original_document_id)} · receipt wystawienia: ${e(s.original_receipt_id)}</p>
 <p>Przyjęcie zwrotu: ${e(c.acceptance.number)} · RMA: ${e(s.return_id)} · receipt przyjęcia: ${e(s.return_receipt_id)} · kolejność: ${e(s.receipt_sequence)}</p>
 <p>Data wystawienia korekty: ${e(s.issue_date)} · przyjęto: ${e(c.acceptance.received_at)}</p><p>Przyczyna korekty: ${e(s.reason)}</p>
 <p>Łańcuch poprzednich korekt: ${e(c.previous_chain_hash)}</p>
 <table><thead><tr><th>Pozycja</th><th>Ilość przed</th><th>Ilość po</th><th>Zmiana ilości</th><th>VAT</th><th>Netto przed</th><th>Netto po</th><th>Zmiana netto</th><th>VAT przed</th><th>VAT po</th><th>Zmiana VAT</th><th>Brutto przed</th><th>Brutto po</th><th>Zmiana brutto</th></tr></thead><tbody>${c.rows.map(r=>`<tr><td>${e(r.name)}${r.kind==='shipping'?'<br>Dostawa: korekta wyłącznie wartości, bez zmiany ilości':''}${r.zero_domestic_basis?'<br>Podstawa stawki0: '+e(r.zero_domestic_basis):''}</td><td>${e(r.before.quantity)} ${e(r.unit)}</td><td>${e(r.after.quantity)} ${e(r.unit)}</td><td>${e(r.delta.quantity)} ${e(r.unit)}</td><td>${e(r.vat_code)}</td>${cells(r)}</tr>`).join('')}</tbody></table>
 <h2>Podział według stawek VAT</h2><table><thead><tr><th>VAT</th><th>Netto przed</th><th>Netto po</th><th>Zmiana netto</th><th>VAT przed</th><th>VAT po</th><th>Zmiana VAT</th><th>Brutto przed</th><th>Brutto po</th><th>Zmiana brutto</th></tr></thead><tbody>${c.vat_buckets.map(r=>`<tr><td>${e(r.vat_code)}</td>${cells(r)}</tr>`).join('')}</tbody></table>
 <h2>Pełne sumy</h2><table><thead><tr><th>Netto przed</th><th>Netto po</th><th>Zmiana netto</th><th>VAT przed</th><th>VAT po</th><th>Zmiana VAT</th><th>Brutto przed</th><th>Brutto po</th><th>Zmiana brutto</th></tr></thead><tbody><tr>${cells(c.totals)}</tr></tbody></table>
 <p>Korekta dokumentuje zmianę należności wynikającą z przyjęcia zwrotu. Nie potwierdza przelewu ani rozliczenia bankowego.</p><p>${e(s.series_definition.payment_instructions)}</p><p>${e(s.series_definition.notes)}</p><button onclick="window.print()">Drukuj</button></html>`;
 ensure(Buffer.byteLength(html,'utf8')<=4194304,413,'Pełny wydruk korekty przekracza4MiB; brak obcięcia');return html;
}
