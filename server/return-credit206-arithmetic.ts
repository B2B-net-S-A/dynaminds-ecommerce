/** Pure business parity checker for the future native successor. No SQL/IAM/payment
 * authority, writes, counter allocation, fixture proofs or runtime activation. */
import {isDeepStrictEqual} from 'node:util';
import {localInvoiceLineAmounts} from './local-invoice-values';
import {calculateLocalConsumerCredit,consumerCreditHash,ConsumerCreditError} from './local-consumer-credit-arithmetic';
import {creditUuid,type CreditMoney,type ConsumerCreditRow,type ConsumerCreditCalculation,type ConsumerCreditSource} from './local-consumer-credit-values';
import {RETURN_CREDIT206_LIMITS as L,type ReturnCredit206Source,type ReturnCredit206Calculation,type ReturnCredit206Decision} from './return-credit206-values';
function check(v:unknown,code:string):asserts v{if(!v)throw new ConsumerCreditError(code);}
function natural(v:unknown){check(typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v),'NATURAL');const n=BigInt(v);check(n<=9223372036854775807n,'OVERFLOW');return n;}
const minus=(a:CreditMoney,b:CreditMoney):CreditMoney=>({gross_minor:(BigInt(a.gross_minor)-BigInt(b.gross_minor)).toString(),net_minor:(BigInt(a.net_minor)-BigInt(b.net_minor)).toString(),vat_minor:(BigInt(a.vat_minor)-BigInt(b.vat_minor)).toString()});
function sum(rows:CreditMoney[]):CreditMoney{const t={gross_minor:0n,net_minor:0n,vat_minor:0n};for(const r of rows)for(const k of Object.keys(t)as(keyof CreditMoney)[])t[k]+=BigInt(r[k]);return Object.fromEntries(Object.entries(t).map(([k,v])=>[k,v.toString()]))as CreditMoney;}
const time=(v:string)=>{check(typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v)&&Number.isFinite(Date.parse(v)),'TIME');return v.replace(/(?:\.(\d{1,6}))?Z$/,(_,fraction='')=>'.'+fraction.padEnd(6,'0')+'Z');};
export function calculateReturnCredit206(source:ReturnCredit206Source):ReturnCredit206Decision{
 check(Buffer.byteLength(JSON.stringify(source))<=L.input_bytes,'INPUT_BOUND');consumerCreditHash(source);
 check(source.schema==='consumer-return-credit-source/v2','SOURCE_VERSION');
 const {original,acceptances,rejected_inspections:inspections,previous_credits:previous,selected_return_id:selected}=source,d=original.document,r=original.receipt,f=d.data;
 check(creditUuid.safeParse(d.id).success&&d.kind==='invoice'&&d.mode==='local_invoice'&&d.order_id===f.order.id&&r.document_id===d.id&&r.preview_id===f.preview_id&&r.number===d.number&&f.number===d.number&&r.scope_hash===f.scope_hash,'ORIGINAL_LINEAGE');
 const {number,preview_id,scope_hash,local_only,ksef_state,fiscalized,...snapshot}=f;
 check(isDeepStrictEqual(snapshot,r.snapshot)&&local_only===true&&ksef_state==='not_submitted'&&fiscalized===false,'ORIGINAL_RECEIPT');
 check(f.currency==='PLN'&&f.buyer.kind==='consumer'&&f.buyer.address.country==='PL'&&f.tax_regime==='ordinary_domestic'&&f.rounding_method==='gross_line_half_up'&&f.consumer_sale_confirmed===true&&f.no_special_tax_procedure_confirmed===true&&f.not_fiscal_receipt_confirmed===true,'UNSUPPORTED_ORIGINAL');
 check(f.lines.length>0&&f.lines.length<=L.lines&&Array.isArray(inspections)&&acceptances.length+inspections.length>0&&acceptances.length+inspections.length<=L.returns&&previous.length<=acceptances.length,'HISTORY_BOUND');
 check(acceptances.some(a=>a.return_id===selected)||inspections.some(a=>a.return_id===selected),'SELECTED_RETURN');
 check(source.physical_protocols.length===acceptances.length&&source.credit_families.length===previous.length,'FULL_FAMILY_MAPPING');
 const firstDestination=source.physical_protocols.findIndex(x=>x.protocol==='destinations_v1');check(firstDestination>=0||inspections.length>0,'DESTINATION_HISTORY_REQUIRED');
 const firstDestinationTime=[...(firstDestination>=0?[time(acceptances[firstDestination].received_at)]:[]),...inspections.map(a=>time(a.completed_at))].sort()[0];
 const items=new Map(f.lines.filter(l=>l.kind==='item').map(l=>[l.item_id,l]));check(items.size===f.lines.filter(l=>l.kind==='item').length,'DUPLICATE_ORIGINAL_ITEM');check(f.lines.filter(l=>l.kind==='shipping').length===1,'FULL_SHIPPING_LINE');
 for(const line of f.lines){check(Number.isSafeInteger(line.quantity)&&line.quantity>0,'ORIGINAL_QUANTITY');const m=localInvoiceLineAmounts(natural(line.gross_minor),line.vat_rate);check(isDeepStrictEqual(m,{gross_minor:line.gross_minor,net_minor:line.net_minor,vat_minor:line.vat_minor}),'ORIGINAL_VAT');}
 check(isDeepStrictEqual(sum(f.lines),f.totals)&&f.totals.gross_minor===f.order.total_minor,'ORIGINAL_TOTALS');
 const seen=new Set<string>(),creditIds=new Set<string>(),accepted=new Map<string,bigint>();let shipping=0n,chain=consumerCreditHash({original_document_id:d.id,original_receipt_id:r.id}),physical=consumerCreditHash({original_document_id:d.id,original_receipt_id:r.id,physical_history:'all_native_acceptances/v1'}),creditIndex=0;
 let inspectionIndex=0;
 for(const [i,x]of inspections.entries()){check(Object.keys(x).sort().join(',')==='completed_at,evidence_hash,receipt_id,return_id'&&creditUuid.safeParse(x.return_id).success&&creditUuid.safeParse(x.receipt_id).success&&/^[a-f0-9]{64}$/.test(x.evidence_hash)&&!seen.has(x.return_id)&&!seen.has(x.receipt_id),'REJECTED_INSPECTION');check(time(x.completed_at).slice(0,10)>=f.issue_date&&(i===0||time(inspections[i-1].completed_at)<time(x.completed_at)||(time(inspections[i-1].completed_at)===time(x.completed_at)&&inspections[i-1].receipt_id<x.receipt_id)),'INSPECTION_ORDER');check(!previous.some(p=>p.return_id===x.return_id||p.return_receipt_id===x.receipt_id),'NO_CHANGE_CANNOT_HAVE_DOCUMENT');seen.add(x.return_id);seen.add(x.receipt_id);}
 let next:string|null=null,selectedNoChange=false,selectedIssued=false,selectedCalculation:ReturnCredit206Calculation|null=null,selectedPhysical='';
 const inspectUntil=(until:string,receiptId='ffffffff-ffff-ffff-ffff-ffffffffffff')=>{while(inspectionIndex<inspections.length&&(time(inspections[inspectionIndex].completed_at)<until||(time(inspections[inspectionIndex].completed_at)===until&&inspections[inspectionIndex].receipt_id<=receiptId))){const inspection=inspections[inspectionIndex++];physical=consumerCreditHash({previous_hash:physical,inspection});if(inspection.return_id===selected){selectedNoChange=true;selectedPhysical=physical;}}};
 for(const [i,a]of acceptances.entries()){
  inspectUntil(time(a.received_at),a.receipt_id);
  check(a.receipt_sequence===i+1&&creditUuid.safeParse(a.return_id).success&&creditUuid.safeParse(a.receipt_id).success&&!seen.has(a.return_id)&&!seen.has(a.receipt_id),'ACCEPTANCE_SEQUENCE');seen.add(a.return_id);seen.add(a.receipt_id);
  const protocol=source.physical_protocols[i];check(protocol.return_id===a.return_id&&protocol.receipt_id===a.receipt_id&&['rma','assistant_v1','destinations_v1'].includes(protocol.protocol),'PHYSICAL_FAMILY_MAPPING');
  check(time(a.received_at).slice(0,10)>=f.issue_date,'RETURN_BEFORE_INVOICE');
  const {financial_hash,...financial}=a;check(consumerCreditHash(financial)===financial_hash,'FINANCIAL_HASH');
  physical=consumerCreditHash({previous_hash:physical,return_id:a.return_id,receipt_id:a.receipt_id,receipt_sequence:a.receipt_sequence,financial_hash,protocol:protocol.protocol});
  const before=new Map(accepted),oldShipping=shipping;let refund=0n,units=0n;const unique=new Set<string>();
  check(Array.isArray(a.items)&&a.items.length>0&&a.items.length<=L.lines,'RETURN_ITEMS_BOUND');
  for(const x of a.items){const line=items.get(x.item_id);check(line&&!unique.has(x.item_id),'FOREIGN_RETURN_ITEM');unique.add(x.item_id);const q=BigInt(line.quantity),n=natural(x.accepted),old=accepted.get(x.item_id)??0n;check(natural(x.restocked)<=n&&old+n<=q,'OVER_RETURN');const gross=natural(line.gross_minor),allocated=gross*(old+n)/q-gross*old/q;check(natural(x.refund_amount_minor)===allocated,'CUMULATIVE_GROSS');accepted.set(x.item_id,old+n);refund+=allocated;units+=n;}
  const shippingDelta=natural(a.refunded_shipping_minor);shipping+=shippingDelta;refund+=shippingDelta;check(shipping<=natural(f.order.shipping_cost_minor)&&refund===natural(a.refund_amount_minor),'REFUND_TOTAL');
  const noChange=units===0n&&shippingDelta===0n,pc=previous[creditIndex];
  if(noChange){check(!previous.some(p=>p.return_id===a.return_id||p.return_receipt_id===a.receipt_id),'NO_CHANGE_CANNOT_HAVE_DOCUMENT');if(a.return_id===selected){selectedNoChange=true;selectedPhysical=physical;}continue;}
  const rows:ConsumerCreditRow[]=f.lines.map((line,ordinal)=>{const q=BigInt(line.quantity),g=natural(line.gross_minor),p=line.kind==='shipping'?oldShipping:(before.get(line.item_id!)??0n),n=line.kind==='shipping'?shipping:(accepted.get(line.item_id!)??0n),bg=line.kind==='shipping'?g-p:g-g*p/q,ag=line.kind==='shipping'?g-n:g-g*n/q,bm=localInvoiceLineAmounts(bg,line.vat_rate),am=localInvoiceLineAmounts(ag,line.vat_rate),bq=line.kind==='shipping'?1n:q-p,aq=line.kind==='shipping'?1n:q-n;return{ordinal,kind:line.kind,item_id:line.item_id,product_id:line.product_id,name:line.name,sku:line.sku,unit:line.unit,vat_rate:line.vat_rate,before:{quantity:bq.toString(),...bm},after:{quantity:aq.toString(),...am},delta:{quantity:(aq-bq).toString(),...minus(am,bm)},affected:p!==n};});
  const bt=sum(rows.map(x=>x.before)),at=sum(rows.map(x=>x.after));const calculation:ReturnCredit206Calculation={schema:'consumer-return-credit-calculation/v2',currency:'PLN',tax_method:'gross_line_half_up',original_document_id:d.id,original_receipt_id:r.id,original_number:d.number,original_scope_hash:r.scope_hash,return_id:a.return_id,return_receipt_id:a.receipt_id,receipt_sequence:a.receipt_sequence,financial_hash,previous_chain_hash:chain,physical_history_hash:physical,rows,totals:{before:bt,after:at,delta:minus(at,bt)},vat_totals:[...new Set(rows.map(x=>x.vat_rate))].sort((a,b)=>a-b).map(vat_rate=>{const xs=rows.filter(x=>x.vat_rate===vat_rate),b=sum(xs.map(x=>x.before)),a=sum(xs.map(x=>x.after));return{vat_rate,before:b,after:a,delta:minus(a,b)};})};
  if(pc){check(next===null&&pc.return_id===a.return_id&&pc.return_receipt_id===a.receipt_id&&pc.receipt_sequence===a.receipt_sequence,'EARLIEST_UNCREDITED');check(creditUuid.safeParse(pc.document_id).success&&creditUuid.safeParse(pc.receipt_id).success&&!creditIds.has(pc.document_id)&&!creditIds.has(pc.receipt_id),'CREDIT_CHAIN');creditIds.add(pc.document_id);creditIds.add(pc.receipt_id);const family=source.credit_families[creditIndex];check(family.document_id===pc.document_id&&family.receipt_id===pc.receipt_id&&['legacy','destinations'].includes(family.family),'CREDIT_FAMILY_MAPPING');
   check(time(family.created_at)>=time(a.received_at),'CREDIT_BEFORE_ACCEPTANCE');
   let expected:ConsumerCreditCalculation|ReturnCredit206Calculation=calculation;
   if(family.family==='legacy'){check(time(a.received_at)<firstDestinationTime&&time(family.created_at)<=firstDestinationTime,'LEGACY_AFTER_DESTINATION');const legacy=previous.slice(0,creditIndex);check(source.credit_families.slice(0,creditIndex).every(x=>x.family==='legacy'),'LEGACY_AFTER_SUCCESSOR');expected=calculateLocalConsumerCredit({original,acceptances:acceptances.slice(0,i+1),previous_credits:legacy,selected_return_id:a.return_id}as ConsumerCreditSource);}
   else check(time(family.created_at)>=firstDestinationTime,'SUCCESSOR_BEFORE_DESTINATION');
   check(isDeepStrictEqual(pc.calculation,expected)&&pc.calculation_hash===consumerCreditHash(expected),'PREVIOUS_CREDIT_CALCULATION');chain=consumerCreditHash(pc);creditIndex++;if(a.return_id===selected)selectedIssued=true;
  }else if(next===null)next=a.return_id;
  if(a.return_id===selected){selectedCalculation=calculation;selectedPhysical=physical;}
 }
 inspectUntil('9999-12-31T23:59:59.999999Z');
 check(creditIndex===previous.length,'EXTRA_CREDIT');
 const status=selectedNoChange?'no_commercial_change':selectedIssued?'already_credited':next===selected?'credit_required':'earlier_acceptance_required';
 const result:ReturnCredit206Decision={status,next_return_id:next,selected_return_id:selected,physical_history_hash:physical,calculation:status==='credit_required'?selectedCalculation:null};
 check(result.physical_history_hash&&Buffer.byteLength(JSON.stringify(result))<=L.output_bytes,'OUTPUT_BOUND');return result;
}
