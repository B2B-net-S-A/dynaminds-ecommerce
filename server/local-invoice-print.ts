import {parseCommercialSaleScope} from './commercial-sale-scope';
import { ensure } from './errors';
import type {LocalInvoiceDocument} from './local-invoices';
import {localInvoiceLineAmounts,localInvoiceTotals} from './local-invoice-values';
import {htmlEscape as e} from './portal-view';
/** Pure frozen-document renderer. No provider, PIM, current prices or auth lookup. */
export function localInvoicePrintHtml(d:LocalInvoiceDocument):string {
 const s=d.data;ensure(d.kind==='invoice'&&d.mode==='local_invoice'&&s.local_only===true&&s.ksef_state==='not_submitted'&&s.fiscalized===false,409,'Niepoprawne pochodzenie lokalnej FV');
 ensure(s.currency==='PLN'&&s.lines.length>=2&&s.lines.length<=101,409,'Niepełny manifest FV');
 const ids=new Set<string>();for(let n=0;n<s.lines.length;n++){
  const r=s.lines[n];ensure(r.kind===(n===s.lines.length-1?'shipping':'item')&&Number.isSafeInteger(r.quantity)&&r.quantity>0,409,'Niepoprawna pozycja FV');
  if(r.kind==='item'){ensure(r.item_id&&!ids.has(r.item_id),409,'Powtórzona pozycja FV');ids.add(r.item_id);}else ensure(r.item_id===null&&r.product_id===null&&r.quantity===1,409,'Niepoprawna dostawa FV');
  ensure(r.unit===(r.kind==='item'?'szt.':'usł.')&&/^(0|[1-9][0-9]*)$/.test(r.unit_gross_minor)&&/^(0|[1-9][0-9]*)$/.test(r.discount_gross_minor)&&/^(0|[1-9][0-9]*)$/.test(r.rounding_gross_minor)&&!(BigInt(r.discount_gross_minor)>0n&&BigInt(r.rounding_gross_minor)>0n)&&BigInt(r.rounding_gross_minor)<BigInt(r.quantity)&&BigInt(r.unit_gross_minor)*BigInt(r.quantity)-BigInt(r.discount_gross_minor)+BigInt(r.rounding_gross_minor)===BigInt(r.gross_minor),409,'Niespójna jednostka lub rabat FV');
  const amount=localInvoiceLineAmounts(r.gross_minor,r.vat_rate);ensure(amount.net_minor===r.net_minor&&amount.vat_minor===r.vat_minor,409,'Niespójne pieniądze FV');
 }
 const commercial=s.commercial_scope?parseCommercialSaleScope(s.commercial_scope,s.order.id):null;
 if(commercial){
  ensure(commercial.closed&&commercial.original_total_minor===s.order.total_minor&&commercial.shipping_minor===s.order.shipping_cost_minor,409,'Niespójne historyczne źródło częściowej FV');
  const issued=commercial.lines.filter(l=>l.issued_quantity>0);
  ensure(issued.length===ids.size&&issued.every(l=>s.lines.some(r=>r.kind==='item'&&r.item_id===l.item_id&&r.quantity===l.issued_quantity&&r.gross_minor===l.issued_gross_minor)),409,'FV nie pokrywa dokładnie wydanych pozycji');
 }
 const total=localInvoiceTotals(s.lines,commercial?.commercial_total_minor??s.order.total_minor);ensure(total.gross_minor===s.totals.gross_minor&&total.net_minor===s.totals.net_minor&&total.vat_minor===s.totals.vat_minor,409,'Niepełne sumy FV');
 const buckets=new Map<number,{gross:bigint;net:bigint;vat:bigint}>();for(const r of s.lines){const b=buckets.get(r.vat_rate)??{gross:0n,net:0n,vat:0n};b.gross+=BigInt(r.gross_minor);b.net+=BigInt(r.net_minor);b.vat+=BigInt(r.vat_minor);buckets.set(r.vat_rate,b);}
 ensure(s.rounding_method==='gross_line_half_up'&&s.tax_regime==='ordinary_domestic'&&s.buyer.kind==='consumer'&&s.buyer.tax_id===''&&s.consumer_sale_confirmed===true&&s.no_special_tax_procedure_confirmed===true&&s.not_fiscal_receipt_confirmed===true&&s.vat_totals.length===buckets.size,409,'Nieobsługiwany zakres lokalnej FV');
 const rates=[...buckets.keys()].sort((a,b)=>a-b);s.vat_totals.forEach((r,n)=>{const b=buckets.get(r.vat_rate);ensure(r.vat_rate===rates[n]&&b&&r.gross_minor===b.gross.toString()&&r.net_minor===b.net.toString()&&r.vat_minor===b.vat.toString(),409,'Niepełne zestawienie VAT');});
 const money=(v:string)=>{const n=BigInt(v);return e((n/100n).toString()+','+(n%100n).toString().padStart(2,'0')+' PLN');};
 const address=(a:{street:string;postal_code:string;city:string;country:string})=>e(a.street)+'<br>'+e(a.postal_code)+' '+e(a.city)+'<br>'+e(a.country);
 const content=`<!doctype html><html lang="pl"><meta charset="utf-8"><title>${e(d.number)}</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;color:#17213a}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #ccd;text-align:left}@media print{button{display:none}}</style>
 <h1>Faktura ${e(d.number)}</h1><p>Dokument lokalny. Nie przesłano do KSeF; brak numeru KSeF/UPO. Nie jest paragonem fiskalnym.</p>
 <p>Sprzedawca: <strong>${e(s.seller.name)}</strong><br>${address(s.seller)}<br>NIP: ${e(s.seller.tax_id)}</p>
 <p>Nabywca: <strong>${e(s.buyer.name)}</strong><br>${address(s.buyer.address)}${s.buyer.tax_id?'<br>NIP: '+e(s.buyer.tax_id):''}</p>
 <p>Zamówienie: ${e(s.order.number)} · wystawiono: ${e(s.issue_date)} · data sprzedaży: ${e(s.sell_date)} · termin płatności: ${e(s.due_date)}</p>
 <table><thead><tr><th>Pozycja</th><th>Ilość/j.m.</th><th>Cena jedn. brutto</th><th>Rabat brutto</th><th>Różnica zaokrąglenia pozycji</th><th>VAT</th><th>Netto</th><th>VAT kwota</th><th>Brutto</th></tr></thead><tbody>${s.lines.map(r=>`<tr><td>${e(r.name)}${r.sku?'<br>'+e(r.sku):''}</td><td>${e(r.quantity)} ${e(r.unit)}</td><td>${money(r.unit_gross_minor)}</td><td>${money(r.discount_gross_minor)}</td><td>${money(r.rounding_gross_minor)}</td><td>${e(r.vat_rate)}%</td><td>${money(r.net_minor)}</td><td>${money(r.vat_minor)}</td><td>${money(r.gross_minor)}</td></tr>`).join('')}</tbody></table>
 <h2>Podział według stawek VAT</h2><table><thead><tr><th>VAT</th><th>Netto</th><th>VAT kwota</th><th>Brutto</th></tr></thead><tbody>${s.vat_totals.map(r=>`<tr><td>${e(r.vat_rate)}%</td><td>${money(r.net_minor)}</td><td>${money(r.vat_minor)}</td><td>${money(r.gross_minor)}</td></tr>`).join('')}</tbody></table>
 <p>Netto: ${money(total.net_minor)} · VAT: ${money(total.vat_minor)} · Brutto: ${money(total.gross_minor)}</p><p>${e(s.series.payment_instructions)}</p><p>${e(s.series.notes)}</p><button onclick="window.print()">Drukuj</button></html>`;
 ensure(Buffer.byteLength(content,'utf8')<=2097152,413,'Pełny wydruk FV przekracza limit2MiB');return content;
}
