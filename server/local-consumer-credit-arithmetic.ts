import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {localInvoiceLineAmounts} from './local-invoice-values';
import {creditUuid,LOCAL_CONSUMER_CREDIT_LIMITS as L,type ConsumerCreditSource,type ConsumerCreditCalculation,type CreditMoney,type ConsumerCreditRow} from './local-consumer-credit-values';
export class ConsumerCreditError extends Error{constructor(readonly code:string){super('Niepełne lub zmienione źródło korekty konsumenckiej');}}
function check(v:unknown,code:string):asserts v{if(!v)throw new ConsumerCreditError(code);}
function canonical(v:unknown):unknown{if(v===null||typeof v==='string'||typeof v==='boolean')return v;if(typeof v==='number'){check(Number.isSafeInteger(v),'NON_INTEGER');return v;}if(Array.isArray(v))return v.map(canonical);check(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)),'INVALID_JSON');return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)]));}
export const consumerCreditHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const MAX=9223372036854775807n;
function natural(v:unknown):bigint{const s=String(v);check(/^(0|[1-9][0-9]*)$/.test(s)&&s.length<=19,'NATURAL');const n=BigInt(s);check(n<=MAX,'OVERFLOW');return n;}
function minus(a:CreditMoney,b:CreditMoney):CreditMoney{return{gross_minor:(BigInt(a.gross_minor)-BigInt(b.gross_minor)).toString(),net_minor:(BigInt(a.net_minor)-BigInt(b.net_minor)).toString(),vat_minor:(BigInt(a.vat_minor)-BigInt(b.vat_minor)).toString()};}
function sum(rows:CreditMoney[]):CreditMoney{const t={gross_minor:0n,net_minor:0n,vat_minor:0n};for(const r of rows)for(const k of Object.keys(t)as(keyof CreditMoney)[])t[k]+=BigInt(r[k]);return Object.fromEntries(Object.entries(t).map(([k,v])=>[k,v.toString()])) as CreditMoney;}
/** Pure parity checker, never a receipt/IAM authority. Callers supply ONLY native188 source. */
export function calculateLocalConsumerCredit(value:ConsumerCreditSource):ConsumerCreditCalculation{
 check(Buffer.byteLength(JSON.stringify(value))<=L.input_bytes,'INPUT_BOUND');canonical(value);
 const {original,acceptances,previous_credits:selected,selected_return_id}=value,d=original.document,r=original.receipt,f=d.data;
 check(creditUuid.safeParse(d.id).success&&d.kind==='invoice'&&d.mode==='local_invoice'&&d.order_id===f.order.id&&r.document_id===d.id&&r.preview_id===f.preview_id&&r.number===d.number&&f.number===d.number&&r.scope_hash===f.scope_hash,'ORIGINAL_LINEAGE');
 const{number,preview_id,scope_hash,local_only,ksef_state,fiscalized,...snapshot}=f;
 check(isDeepStrictEqual(snapshot,r.snapshot)&&local_only===true&&ksef_state==='not_submitted'&&fiscalized===false,'ORIGINAL_RECEIPT');
 check(f.currency==='PLN'&&f.buyer.kind==='consumer'&&f.buyer.address.country==='PL'&&f.tax_regime==='ordinary_domestic'&&f.rounding_method==='gross_line_half_up'&&f.consumer_sale_confirmed===true&&f.no_special_tax_procedure_confirmed===true&&f.not_fiscal_receipt_confirmed===true,'UNSUPPORTED_ORIGINAL');
 check(f.lines.length>0&&f.lines.length<=L.lines&&acceptances.length>0&&acceptances.length<=L.returns&&selected.length<acceptances.length,'HISTORY_BOUND');
 const items=new Map(f.lines.filter(l=>l.kind==='item').map(l=>[l.item_id,l]));check(items.size===f.lines.filter(l=>l.kind==='item').length,'DUPLICATE_ORIGINAL_ITEM');
 check(f.lines.filter(l=>l.kind==='shipping').length===1,'FULL_SHIPPING_LINE');
 for(const line of f.lines){check(Number.isSafeInteger(line.quantity)&&line.quantity>0,'ORIGINAL_QUANTITY');const m=localInvoiceLineAmounts(natural(line.gross_minor),line.vat_rate);check(isDeepStrictEqual(m,{gross_minor:line.gross_minor,net_minor:line.net_minor,vat_minor:line.vat_minor}),'ORIGINAL_VAT');}
 check(isDeepStrictEqual(sum(f.lines),f.totals)&&f.totals.gross_minor===f.order.total_minor,'ORIGINAL_TOTALS');
 let accepted=new Map<string,bigint>(),shipping=0n,chain=consumerCreditHash({original_document_id:d.id,original_receipt_id:r.id}),result:ConsumerCreditCalculation|undefined;
 const seen=new Set<string>(),priorIds=new Set<string>();const selectedIndex=selected.length;
 check(acceptances[selectedIndex].return_id===selected_return_id,'EARLIEST_UNCREDITED');
 for(const [i,a]of acceptances.entries()){
  check(a.receipt_sequence===i+1&&creditUuid.safeParse(a.return_id).success&&creditUuid.safeParse(a.receipt_id).success&&!seen.has(a.return_id)&&!seen.has(a.receipt_id),'ACCEPTANCE_SEQUENCE');seen.add(a.return_id);seen.add(a.receipt_id);
  check(Number.isFinite(Date.parse(a.received_at))&&a.received_at.slice(0,10)>=f.issue_date,'RETURN_BEFORE_INVOICE');
  const {financial_hash,...financial}=a;check(consumerCreditHash(financial)===financial_hash,'FINANCIAL_HASH');
  const before=new Map(accepted),oldShipping=shipping;let refund=0n,units=0n;const unique=new Set<string>();
  for(const x of a.items){const line=items.get(x.item_id);check(line&&!unique.has(x.item_id),'FOREIGN_RETURN_ITEM');unique.add(x.item_id);const q=BigInt(line.quantity),n=natural(x.accepted),old=accepted.get(x.item_id)??0n;check(natural(x.restocked)<=n&&old+n<=q,'OVER_RETURN');const gross=natural(line.gross_minor),allocated=gross*(old+n)/q-gross*old/q;check(natural(x.refund_amount_minor)===allocated,'CUMULATIVE_GROSS');accepted.set(x.item_id,old+n);refund+=allocated;units+=n;}
  shipping+=natural(a.refunded_shipping_minor);refund+=natural(a.refunded_shipping_minor);check(units>0n&&shipping<=natural(f.order.shipping_cost_minor)&&refund===natural(a.refund_amount_minor),'REFUND_TOTAL');
  // FULL later native history is validated, even when only earliest uncredited is selected.
  if(i>selectedIndex)continue;
  const rows:ConsumerCreditRow[]=f.lines.map((line,ordinal)=>{const q=BigInt(line.quantity),g=natural(line.gross_minor),p=line.kind==='shipping'?oldShipping:(before.get(line.item_id!)??0n),n=line.kind==='shipping'?shipping:(accepted.get(line.item_id!)??0n);
   const bg=line.kind==='shipping'?g-p:g-g*p/q,ag=line.kind==='shipping'?g-n:g-g*n/q,bm=localInvoiceLineAmounts(bg,line.vat_rate),am=localInvoiceLineAmounts(ag,line.vat_rate),bq=line.kind==='shipping'?1n:q-p,aq=line.kind==='shipping'?1n:q-n;
   return{ordinal,kind:line.kind,item_id:line.item_id,product_id:line.product_id,name:line.name,sku:line.sku,unit:line.unit,vat_rate:line.vat_rate,before:{quantity:bq.toString(),...bm},after:{quantity:aq.toString(),...am},delta:{quantity:(aq-bq).toString(),...minus(am,bm)},affected:p!==n};});
  const bt=sum(rows.map(x=>x.before)),at=sum(rows.map(x=>x.after));const c:ConsumerCreditCalculation={schema:'local-consumer-credit-calculation/v1',currency:'PLN',tax_method:'gross_line_half_up',original_document_id:d.id,original_receipt_id:r.id,original_number:d.number,original_scope_hash:r.scope_hash,return_id:a.return_id,return_receipt_id:a.receipt_id,receipt_sequence:a.receipt_sequence,financial_hash,previous_chain_hash:chain,rows,totals:{before:bt,after:at,delta:minus(at,bt)},vat_totals:[...new Set(rows.map(x=>x.vat_rate))].sort((a,b)=>a-b).map(vat_rate=>{const xs=rows.filter(x=>x.vat_rate===vat_rate),b=sum(xs.map(x=>x.before)),a=sum(xs.map(x=>x.after));return{vat_rate,before:b,after:a,delta:minus(a,b)};})};
  if(i<selectedIndex){const pc=selected[i];check(pc&&pc.return_id===a.return_id&&pc.return_receipt_id===a.receipt_id&&pc.receipt_sequence===a.receipt_sequence&&creditUuid.safeParse(pc.document_id).success&&creditUuid.safeParse(pc.receipt_id).success&&!priorIds.has(pc.document_id)&&!priorIds.has(pc.receipt_id),'CREDIT_CHAIN');priorIds.add(pc.document_id);priorIds.add(pc.receipt_id);check(isDeepStrictEqual(pc.calculation,c)&&pc.calculation_hash===consumerCreditHash(c),'PREVIOUS_CREDIT_CALCULATION');chain=consumerCreditHash(pc);}
  else result=c;
 }
 check(result,'NO_SELECTED_CALCULATION');check(Buffer.byteLength(JSON.stringify(result))<=L.output_bytes,'OUTPUT_BOUND');return result;
}
