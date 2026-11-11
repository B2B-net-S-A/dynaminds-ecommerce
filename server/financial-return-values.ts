/** SOURCE_STAGE162 / NOT_INSTALLED / NOT_RUN.
 * Pure received projection only. Native typed admission, ancestry, physical
 * witness and final request identity are mandatory in the managed caller.
 */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';

const MAX=9223372036854775807n;
const id=z.uuid().transform(v=>v.toLowerCase());
const integer=z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)]).transform(v=>String(v)).refine(v=>BigInt(v)<=MAX);
const stamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.[0-9]{1,6})?(?:Z|\+00:00)$/);
const raw=z.record(z.string(),z.unknown());
const item=z.object({tenant_id:id,order_id:id,return_id:id,item_id:id,requested:integer,accepted:integer,restocked:integer,refund_amount:integer,components:z.array(raw)}).catchall(z.unknown());
const caseRow=z.object({id,tenant_id:id,order_id:id,version:integer,number:z.string(),kind:z.enum(['return','complaint']),state:z.string(),remedy:z.string(),legacy:z.boolean(),
 receipt:raw.nullable(),received_at:stamp.nullable(),receipt_sequence:z.number().int().nonnegative(),requested_shipping:integer,refunded_shipping:integer,refund_amount:integer}).catchall(z.unknown());
const receive=z.strictObject({version:z.number().int().positive(),shipping_refund:z.number().int().min(0).max(1000000),note:z.string().min(3).max(2000),
 items:z.array(z.strictObject({item_id:id,accepted:z.number().int().min(0).max(100000),restocked:z.literal(0)})).min(1).max(100)});
export const financialReturn162CaptureSchema=z.strictObject({
 schema:z.literal('financial-return-capture/v1'),original:raw,return_case:caseRow,items:z.array(item).min(1).max(100),
 commercial:z.array(z.strictObject({id,quantity:integer,line_total:integer})).min(1).max(100),
 prior:z.array(z.strictObject({return_case:caseRow,items:z.array(item).min(1).max(100)})).max(1000),
 physical:raw,request:receive,
});
export type FinancialReturn162Capture=z.infer<typeof financialReturn162CaptureSchema>;
const omit=(v:Record<string,unknown>,keys:readonly string[])=>Object.fromEntries(Object.entries(v).filter(([k])=>!keys.includes(k)));
const normalize=(v:unknown):unknown=>Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,normalize(x)])):v;
export function financialReturn162Hash(v:unknown){return createHash('sha256').update(JSON.stringify(normalize(v))).digest('hex');}
function check(v:unknown,message:string):asserts v{if(!v)throw new Error(message);}
export function validateFinancialReturn162Received(captured:unknown,received:unknown,physical:unknown){
 check(Buffer.byteLength(JSON.stringify({captured,received,physical}),'utf8')<=33554432,'Financial return graph exceeds32MiB');
 const f=financialReturn162CaptureSchema.parse(captured);
 const after=z.strictObject({return_case:caseRow,items:z.array(item).min(1).max(100),original:raw}).parse(received);
 check(Buffer.byteLength(JSON.stringify({f,after,physical}),'utf8')<=33554432,'Financial return graph exceeds32MiB');
 const before=f.return_case,r=after.return_case,q=f.request;
 check(before.state==='requested'&&before.remedy==='refund'&&!before.legacy&&before.received_at===null&&before.receipt===null&&before.receipt_sequence===0,'Not a genuine ordinary requested refund');
 check(BigInt(before.version)===BigInt(q.version)&&BigInt(r.version)===BigInt(before.version)+1n&&r.state==='refund_pending'&&r.received_at!==null,'Invalid actual receive transition/version');
 check(isDeepStrictEqual(f.original,after.original),'Original issued invoice ancestry changed');
 check(isDeepStrictEqual(f.physical,physical),'No-restock receive changed physical stock graph');
 check(isDeepStrictEqual(r.receipt,q),'Received request differs');
 check(r.decision_note===q.note,'Actual decision note differs from received request');
 const changed=['state','version','updated_at','receipt','decision_note','received_at','receipt_sequence','refunded_shipping','refund_amount'];
 check(isDeepStrictEqual(omit(before,changed),omit(r,changed)),'Received case changed immutable source');
 check(after.items.length===f.items.length&&new Set(q.items.map(i=>i.item_id)).size===f.items.length&&q.items.length===f.items.length,'Incomplete received item set');
 const priorIds=new Set<string>();let maxSequence=0;
 for(const prior of f.prior){
  check(prior.return_case.tenant_id===before.tenant_id&&prior.return_case.order_id===before.order_id&&prior.return_case.id!==before.id&&!priorIds.has(prior.return_case.id),'Foreign/duplicate prior case');
  priorIds.add(prior.return_case.id);maxSequence=Math.max(maxSequence,prior.return_case.receipt_sequence);
 }
 check(r.receipt_sequence===maxSequence+1,'Received sequence differs from native complete prior history');
 let total=BigInt(q.shipping_refund),units=0n;
 check(total<=BigInt(before.requested_shipping)&&r.refunded_shipping===String(q.shipping_refund),'Shipping refund differs');
 const receivedIds=new Set<string>();
 for(const old of f.items){
  const wanted=q.items.find(x=>x.item_id===old.item_id),saved=after.items.find(x=>x.item_id===old.item_id),commercial=f.commercial.find(x=>x.id===old.item_id);
  check(wanted&&saved&&commercial&&!receivedIds.has(old.item_id),'Missing/duplicate requested commercial item');
  receivedIds.add(old.item_id);
  check(old.tenant_id===before.tenant_id&&old.order_id===before.order_id&&old.return_id===before.id,'Foreign native item source');
  check(isDeepStrictEqual(omit(old,['accepted','restocked','refund_amount']),omit(saved,['accepted','restocked','refund_amount'])),'Commercial item/recipe changed');
  const accepted=BigInt(wanted.accepted),quantity=BigInt(commercial.quantity),gross=BigInt(commercial.line_total);
  const prior=f.prior.filter(p=>['refund_pending','closed'].includes(p.return_case.state)).reduce((n,p)=>n+p.items.filter(i=>i.item_id===old.item_id).reduce((s,i)=>s+BigInt(i.accepted),0n),0n);
  check(quantity>0n&&accepted<=BigInt(old.requested)&&prior+accepted<=quantity&&saved.accepted===String(wanted.accepted)&&saved.restocked==='0','Invalid complete no-restock quantities');
  const refund=gross*(prior+accepted)/quantity-gross*prior/quantity;
  check(saved.refund_amount===refund.toString(),'Refund differs from genuine cumulative native allocation');
  total+=refund;units+=accepted;
 }
 check(units>0n&&total<=2147483647n&&r.refund_amount===total.toString(),'No accepted units or invalid full refund total');
 const financial={tenant_id:r.tenant_id,order_id:r.order_id,return_id:r.id,number:r.number,receipt_sequence:r.receipt_sequence,
  kind:r.kind,received_state:'refund_pending' as const,remedy:'refund' as const,legacy:false as const,acceptance_kind:'financial_no_restock' as const,
  received_at:r.received_at,refund_amount_minor:r.refund_amount,refunded_shipping_minor:r.refunded_shipping,
  items:after.items.map(i=>({item_id:i.item_id,accepted:i.accepted,restocked:i.restocked,refund_amount_minor:i.refund_amount})).sort((a,b)=>a.item_id.localeCompare(b.item_id))};
 return {financial,financial_hash:financialReturn162Hash(financial),snapshot:structuredClone(received),physical_hash:financialReturn162Hash(physical)};
}
/** A later genuine native refund settlement may close the case. This validates
 * frozen received fields; it is not bank/provider payment confirmation. */
export function validateFinancialReturn162Historical(snapshot:unknown,current:unknown){
 const saved=z.strictObject({return_case:caseRow,items:z.array(item).min(1).max(100),original:raw}).parse(snapshot);
 const now=z.strictObject({return_case:caseRow,items:z.array(item).min(1).max(100),original:raw}).parse(current);
 const ignored=['state','version','updated_at','refunded_at','settlement'];
 check(saved.return_case.state==='refund_pending'&&['refund_pending','closed'].includes(now.return_case.state),'Unsupported received lifecycle');
 check(BigInt(now.return_case.version)>=BigInt(saved.return_case.version)&&isDeepStrictEqual(omit(saved.return_case,ignored),omit(now.return_case,ignored))&&isDeepStrictEqual(saved.items,now.items)&&isDeepStrictEqual(saved.original,now.original),'Historical received financial evidence changed');
 return saved;
}
