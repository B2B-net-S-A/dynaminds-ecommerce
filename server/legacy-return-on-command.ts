// Trusted direct legacy ON command. The route owns one managed transaction.
// Explicit approved policy: restore all original unreturned issue fragments to ZWROT.
// Native receiveReturn remains the only physical/financial writer.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { ensure, Problem } from './errors';
import { receiveInput } from './returns';
import { wmsLotsPolicyInTx } from './wms-lots';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { prepareReturnCompletionInTx, type ReturnCompletion } from './return-completion';

export type LegacyOnReturnCommand = Readonly<{id:string;order_id:string;return_id:string}>;
type Input = z.infer<typeof receiveInput>;
type Row = Record<string, any>;
type Frame = {context:Row;order:Row;return_case:Row;items:Row[];commercial_items:Row[];policy:Row;warehouse_policy:Row|null;
  fragments:Row[];stocks:Row[];case_count:number;excluded:boolean};
type State = {client:PoolClient;actor:string;identity:string;frame:Frame;input:Input;
  completion:ReturnCompletion;phase:'prepared'|'claimed'};
const custody=new WeakMap<LegacyOnReturnCommand,State>();
const source=z.strictObject({order_id:z.uuid(),return_id:z.uuid()});
const actorKey=(a:Actor)=>JSON.stringify([a.tenantId,a.userId,a.apiKeyId??null,a.source??'manual']);
const integer=(n:unknown,min=0,max=1000000)=>{const v=Number(n);ensure(Number.isSafeInteger(v)&&v>=min&&v<=max,409,'Źródło ON ma ilość poza zakresem natywnego przyjęcia');return v;};
function freeze<T>(v:T):T {if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}

async function owner<T>(c:PoolClient,a:Actor,fn:()=>Promise<T>):Promise<T>{
 const p=(await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant,current_setting('TimeZone') zone")).rows[0];
 ensure(p.owner==='postgres'&&['postgres','dyna_app'].includes(p.role)&&p.tenant===a.tenantId&&p.zone==='UTC',403,'Command ON wymaga własnego managed UTC tenant TX');
 ensure(!a.apiKeyId,403,'Pełny automatyczny command ON wymaga bieżącego administratora bez klucza API');
 if(p.role==='dyna_app')await c.query('RESET ROLE');let failed=false;
 try{return await fn();}catch(e){failed=true;if(e instanceof Problem)throw e;
  const code=(e as {code?:string}).code;
  if(['55000','42P01','42883','42703'].includes(code??''))throw new Problem(503,'Niekompletna authority natywnego zwrotu ON');
  if(code==='42501')throw new Problem(403,'Cofnięto authority autora zwrotu ON');
  if(code==='28000')throw new Problem(401,'Wygasła authority zwrotu ON');
  throw e;
 }finally{if(p.role==='dyna_app'){if(failed)await c.query('SET LOCAL ROLE dyna_app').catch(()=>{});else await c.query('SET LOCAL ROLE dyna_app');}}
}
async function frame(c:PoolClient,a:Actor,ids:{order_id:string;return_id:string}):Promise<Frame>{
 return owner(c,a,async()=>{
  await c.query('SELECT public.catalog_stock_return_require()');
  await c.query('SELECT public.catalog_stock_return_access($1,NULL,$2,$3)',[a.userId,ids.return_id,'legacy_status']);
  ensure((await c.query('SELECT public.b2b_dropship_current_role($1,false) role',[a.userId])).rows[0].role==='admin',403,'Pełny command ON wymaga bieżącego administratora');
  const r=(await c.query(`SELECT jsonb_build_object(
   'context',jsonb_build_object('root',pg_current_xact_id()::text,'started_at',transaction_timestamp()::text,'pid',pg_backend_pid(),'tenant',$1::uuid),
   'order',(SELECT to_jsonb(o) FROM public.orders o WHERE(o.tenant_id,o.id)=($1,$2)),
   'return_case',(SELECT to_jsonb(r) FROM public.return_cases r WHERE(r.tenant_id,r.id,r.order_id)=($1,$3,$2)),
   'items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.item_id) FROM public.return_items i WHERE(i.tenant_id,i.return_id,i.order_id)=($1,$3,$2)),'[]'),
   'commercial_items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.order_items i WHERE(i.tenant_id,i.order_id)=($1,$2)),'[]'),
   'policy',(SELECT to_jsonb(p) FROM public.wms_policies p WHERE p.tenant_id=$1),
   'warehouse_policy',(SELECT to_jsonb(p) FROM public.warehouse_inventory_policies p JOIN public.return_cases r ON(r.tenant_id,r.warehouse_id)=(p.tenant_id,p.warehouse_id) WHERE(r.tenant_id,r.id)=($1,$3)),
   'fragments',coalesce((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('returned_quantity',(SELECT coalesce(sum(x.quantity),0) FROM public.wms_return_fragments x WHERE(x.tenant_id,x.issue_fragment_id)=(f.tenant_id,f.id))) ORDER BY f.product_id,f.id)
    FROM public.wms_issue_fragments f WHERE(f.tenant_id,f.order_id)=($1,$2)),'[]'),
   'stocks',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.product_id) FROM public.stock s JOIN public.return_cases r ON(r.tenant_id,r.warehouse_id)=(s.tenant_id,s.warehouse_id)
    WHERE(r.tenant_id,r.id)=($1,$3) AND s.product_id IN(SELECT (p->>'product_id')::uuid FROM public.return_items i CROSS JOIN LATERAL jsonb_array_elements(i.components)p WHERE(i.tenant_id,i.return_id)=($1,$3))),'[]'),
   'case_count',(SELECT count(*)::int FROM public.return_cases r WHERE(r.tenant_id,r.order_id)=($1,$2)),
   'excluded',EXISTS(SELECT FROM public.order_parcel_plans p WHERE(p.tenant_id,p.order_id)=($1,$2))
    OR EXISTS(SELECT FROM public.b2b_return_local_origins p WHERE(p.tenant_id,p.return_id)=($1,$3))
    OR EXISTS(SELECT FROM public.b2b_dropship_return_cases p WHERE(p.tenant_id,p.return_id)=($1,$3))
    OR EXISTS(SELECT FROM public.b2b_dropship_return_supplier_cases p WHERE(p.tenant_id,p.return_id)=($1,$3))
  ) frame`,[a.tenantId,ids.order_id,ids.return_id])).rows[0].frame as Frame;
  ensure(r.order&&r.return_case,404,'Brak własnego zamówienia i legacy RMA');return r;
 });
}
function command(f:Frame):Input {
 const r=f.return_case;
 ensure(r.legacy===true&&r.state==='requested'&&r.receipt===null&&r.remedy!=='exchange'&&f.case_count===1&&!f.excluded,409,'Pierwszy command ON obejmuje jedną zwykłą zgłoszoną legacy RMA');
 ensure(f.order.status==='return_initiated'&&f.order.warehouse_id===r.warehouse_id,409,'Zmienił się pełny legacy zakres zamówienia');
 ensure(f.policy?.enabled===true,409,'Najpierw aktywuj własną politykę WMS');
 ensure(!f.warehouse_policy||f.warehouse_policy.enabled===true&&f.warehouse_policy.usage==='sale',409,'Zwrot ZWROT wymaga aktywnego magazynu sprzedażowego');
 ensure(f.items.length>0&&f.items.length<=100&&f.fragments.length>0&&f.fragments.length<=500,409,'Pełny zwrot ON wymaga istniejących oryginalnych fragmentów w limitach natywnych');
 const physical=new Map<string,number>();
 ensure(f.commercial_items.length===f.items.length,409,'Pełne RMA nie pokrywa wszystkich oryginalnych commercial item UUID');
 for(const item of f.items){const qty=integer(item.requested,1,100000);const original=f.commercial_items.find(x=>x.id===item.item_id);
  ensure(original&&integer(original.quantity,1,100000)===qty,409,'Pierwszy command obejmuje pełne oryginalne pozycje');
  ensure(item.accepted===0&&item.restocked===0,409,'RMA ma już decyzję fizyczną');
  for(const comp of item.components){const n=(physical.get(comp.product_id)??0)+qty*integer(comp.quantity,1,100000);
   ensure(Number.isSafeInteger(n)&&n<=1000000,409,'Pełna receptura przekracza natywne limity');physical.set(comp.product_id,n);}}
 const picked=new Map<string,number>();
 const picks=f.fragments.map(issue=>{const issued=integer(issue.quantity,1),returned=integer(issue.returned_quantity);
  ensure(returned===0,409,'Pierwszy command ON nie wybiera ponownie wcześniej zwróconych fragmentów');
  ensure(physical.has(issue.product_id)&&issue.order_id===f.order.id,409,'Fragment nie pokrywa własnej receptury tego RMA');
  picked.set(issue.product_id,(picked.get(issue.product_id)??0)+issued);
  return {issue_fragment_id:issue.id,quantity:issued,location:'ZWROT'};});
 ensure(picked.size===physical.size&&[...physical].every(([p,n])=>picked.get(p)===n),409,'Oryginalne fragmenty nie pokrywają dokładnie pełnego restock; potrzebny jawny częściowy proces');
 ensure(new Set(f.fragments.map(x=>x.id)).size===f.fragments.length,409,'Powtórzony oryginalny fragment');
 const input=receiveInput.parse({version:integer(r.version,1,Number.MAX_SAFE_INTEGER),shipping_refund:integer(r.requested_shipping,0,1000000),
  note:'Pełny zwrot ON oryginalnych fragmentów do ZWROT',items:f.items.map(i=>({item_id:i.item_id,accepted:integer(i.requested,1,100000),restocked:integer(i.requested,1,100000)})),
  wms_lots:{client_key:randomUUID(),policy_version:String(f.policy.version),stock_versions:[...physical.keys()].sort().map(product_id=>{
   const stock=f.stocks.find(x=>x.product_id===product_id);ensure(stock,409,'Oryginalny produkt nie ma własnego zapasu; odśwież źródło');
   return {product_id,warehouse_id:r.warehouse_id,version:String(stock.version)};
  }),picks}});
 return freeze(input);
}
/** BEFORE any job/run/rule/order/RMA/stock source lock. Managed lifecycle/admissions
 * must already exist. Real native169 prepare allocates actual PZ authority once. */
export async function prepareLegacyOnReturnCommandInTx(c:PoolClient,a:Actor,raw:{order_id:string;return_id:string}):Promise<LegacyOnReturnCommand>{
 const ids=source.parse(raw),f=await frame(c,a,ids),input=command(f);
 // Preserve the command's administrator restriction through the last managed PIN.
 enlistWmsActorInTx(c,a,{orders:true,adminOnly:true});
 const completion=await prepareReturnCompletionInTx(c,a,{return_id:ids.return_id,protocol:'legacy_status',request:input});
 // Admission can wait; pin the full original source again before handing out custody.
 ensure(isDeepStrictEqual(await frame(c,a,ids),f),409,'Źródło ON zmieniło się podczas admisji; ponów cały command');
 const token=Object.freeze({id:randomUUID(),...ids});custody.set(token,{client:c,actor:actorKey(a),identity:JSON.stringify(token),frame:f,input,completion,phase:'prepared'});return token;
}
/** AFTER source waits and BEFORE native receive, once. No plain body or token UUID
 * substitutes this same-client/root/actor binding. Native stock CAS still follows. */
export async function claimLegacyOnReturnCommandInTx(c:PoolClient,a:Actor,t:LegacyOnReturnCommand):Promise<{input:Input;completion:ReturnCompletion}>{
 const s=custody.get(t);ensure(s&&s.client===c&&s.actor===actorKey(a)&&s.identity===JSON.stringify(t)&&s.phase==='prepared',403,'Obcy lub wykorzystany command ON');
 ensure(isDeepStrictEqual(await frame(c,a,t),s.frame),409,'Pełny command ON zmienił się po oczekiwaniu na źródło');
 s.phase='claimed';return {input:s.input,completion:s.completion};
}
/** Whole-TX rollback/terminal finally only. Never reuse or repair SQL authority. */
export function discardLegacyOnReturnCommandInTx(c:PoolClient,a:Actor,t:LegacyOnReturnCommand|null){
 if(!t)return;const s=custody.get(t);if(!s)return;ensure(s.client===c&&s.actor===actorKey(a),403,'Obca custody cleanup ON');custody.delete(t);
}

/** Only the ordinary status HTTP registrar uses this command. General actions,
 * workflows and automation groups retain their existing native paths. */
export async function transitionDirectLegacyOnReturnInTx(
 c:PoolClient,a:Actor,orderId:string,status:string,expectedVersion:string,
){
 // Load before any source lock and before final PIN. Avoid a static domain cycle.
 const {transition}=await import('./domain');
 if(status!=='return_received'||!(await wmsLotsPolicyInTx(c)).enabled)
  return transition(c,a,orderId,status,undefined,undefined,undefined,undefined,expectedVersion);
 await c.query("SET LOCAL TimeZone='UTC'");
 const requested=(await c.query(
  "SELECT id FROM return_cases WHERE order_id=$1 AND legacy AND state='requested' ORDER BY id",
  [orderId],
 )).rows;
 ensure(requested.length===1,409,'Pełny zwrot ON wymaga jednej zgłoszonej legacy RMA; użyj rejestru zwrotów dla zakresu częściowego');
 let token:LegacyOnReturnCommand|null=null;
 try{
  token=await prepareLegacyOnReturnCommandInTx(c,a,{order_id:orderId,return_id:requested[0].id});
  return await transition(c,a,orderId,status,undefined,undefined,undefined,token,expectedVersion);
 }finally{
  // Pure custody revocation only: no SQL or permission check after final PIN.
  discardLegacyOnReturnCommandInTx(c,a,token);
 }
}
