/** STAGED169. Import-safe private owner bridge; no app/db/config effects. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {ensure,Problem} from './errors';
import type {BuyerAddressRequest} from './buyer-address';
type Actor=BuyerAddressRequest['actor'];
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const manualOffPreviewInput=z.strictObject({client_key:uuid,revision:z.string().regex(/^[a-f0-9]{64}$/),product_id:uuid,warehouse_id:uuid,
 location:z.string().min(1).max(80).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f]/.test(v)),delta:z.number().int().min(-1000000).max(1000000).refine(v=>v!==0),note:z.string().min(3).max(500).refine(v=>!/[\u0000-\u001f\u007f]/.test(v))});
export const manualOffApplyInput=z.strictObject({client_key:uuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
export const manualOffSourceQuery=z.strictObject({product_id:uuid,warehouse_id:uuid});
export const manualOffHistoryQuery=z.strictObject({limit:z.literal('50').optional(),after:z.string().min(1).max(4096).optional(),product_id:uuid.optional(),warehouse_id:uuid.optional()});
const principals=new WeakMap<Actor,{digest:string}>();
export function captureManualOffAuthority(req:BuyerAddressRequest,sessionName:string):Actor{
 ensure(req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId,401,'Manual OFF identity changed');
 const bearer=/^Bearer (.+)$/.exec(req.headers.authorization??'')?.[1],raw=req.actor.apiKeyId?bearer:(req.cookies[sessionName]??bearer);
 ensure(typeof raw==='string'&&raw.length>0&&raw.length<=4096,401,'Missing manual OFF credential');
 const a=Object.freeze({...req.actor});principals.set(a,{digest:createHash('sha256').update(raw).digest('hex')});return a;
}
/** Owner RR READ ONLY restoration validator. Frozen evidence and native journals,
 * not current stock/counter/XID, define historical receipt validity. */
export async function validateRecoveredManualOff(c:Pick<PoolClient,'query'>){
 if(!await manualOffAvailable(c))return{previews:0,receipts:0};
 const totals={previews:0,receipts:0};
 for(const table of ['manual_inventory_off_previews','manual_inventory_off_receipts'] as const){let last:string|null=null;
  for(;;){const page:Array<{id:string;tenant_id:string}>=(await c.query(`SELECT id,tenant_id FROM ${table} WHERE($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 50`,[last])).rows;if(!page.length)break;
   for(const row of page){await c.query("SELECT set_config('app.tenant_id',$1,true)",[row.tenant_id]);
    if(table==='manual_inventory_off_receipts'){await c.query('SELECT manual_inventory_off_validate($1,false)',[row.id]);totals.receipts++;}
    else{ensure((await c.query(`SELECT scope_hash=manual_inventory_off_hash(jsonb_build_object('request',request,'frame',frame,'projection',projection))
     AND projection=manual_inventory_off_projection(frame,request)
     AND frame#>>'{source,revision}'=manual_inventory_off_hash(frame->'raw')
     AND frame#>>'{raw,product,id}'=request->>'product_id' AND frame#>>'{raw,product,tenant_id}'=tenant_id::text
     AND frame#>>'{raw,warehouse,id}'=request->>'warehouse_id' AND frame#>>'{raw,warehouse,tenant_id}'=tenant_id::text
     AND frame#>>'{raw,stock,product_id}'=request->>'product_id' AND frame#>>'{raw,stock,warehouse_id}'=request->>'warehouse_id'
     AND frame#>>'{raw,stock,tenant_id}'=tenant_id::text ok FROM manual_inventory_off_previews WHERE(tenant_id,id)=($1,$2)`,[row.tenant_id,row.id])).rows[0]?.ok===true,503,'Restored manual OFF preview evidence differs');totals.previews++;}
   }last=page.at(-1)!.id;
  }
 }return totals;
}
export type ManualOffHooks={begin(c:PoolClient):void;admit(c:PoolClient,a:Actor,writing:boolean):Promise<void>;finalize(c:PoolClient,a:Actor):Promise<void>;end(c:PoolClient):void};
// 281: when the whole manual_off_verdict_ family (and the 248/255 functions it calls) is installed, its owner-only copies of the sealed functions (the same bodies whose
// guard is manual_off_verdict_valid(): the 248 verdict of the pinned catalog_stock_control_guards(), whose only true exit is
// manual_inventory_off_valid(), in READ COMMITTED; the full manual_inventory_off_valid() otherwise); before 281, the sealed ones.
const VERDICT281=`to_regprocedure('public.manual_off_verdict_valid()') IS NOT NULL AND to_regprocedure('public.manual_off_verdict_require()') IS NOT NULL
 AND to_regprocedure('public.manual_off_verdict_frame(uuid,uuid,boolean)') IS NOT NULL AND to_regprocedure('public.manual_off_verdict_preview(uuid,uuid,jsonb)') IS NOT NULL
 AND to_regprocedure('public.manual_off_verdict_preview_can_apply(uuid)') IS NOT NULL AND to_regprocedure('public.manual_off_verdict_apply(uuid,uuid,uuid,jsonb)') IS NOT NULL
 AND to_regprocedure('public.guard_verdict(text)') IS NOT NULL AND to_regprocedure('public.stock_verdict_effect_prepare(uuid,uuid,jsonb)') IS NOT NULL
 AND to_regprocedure('public.stock_verdict_effect_finish(uuid,uuid,uuid,jsonb)') IS NOT NULL`;
export async function manualOffAvailable(owner:Pick<Pool,'query'>):Promise<boolean>{
 const p=(await owner.query(`SELECT current_user role,to_regprocedure('public.manual_inventory_off_valid()') guard,${VERDICT281} v281,
 EXISTS(SELECT FROM migrations WHERE name='169_manual_inventory_off') installed,
 EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'manual_inventory_off_')) OR
 EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'manual_inventory_off_')) partial`)).rows[0];
 ensure(p.role!=='dyna_app',500,'Manual OFF preflight requires owner');if(!p.partial&&!p.installed)return false;
 ensure(p.guard&&p.installed&&p.partial&&(await owner.query(p.v281?'SELECT manual_off_verdict_valid() ok':'SELECT manual_inventory_off_valid() ok')).rows[0].ok,503,'Incomplete manual OFF module');return true;
}
function controlled(e:unknown):never{if(e instanceof Problem)throw e;const code=(e as{code?:string})?.code,status=code==='28000'?401:code==='42501'?403:code==='P0002'?404:code==='54000'?413:['55000','42P01','42703','42883'].includes(code??'')?503:['23514','23503','23505','40001'].includes(code??'')?409:null;if(status)throw new Problem(status,'Manual OFF native source or authority refused');throw e;}
type Ref={at:string;id:string};
export function createManualOffService(deps:{pool:Pool;hooks:ManualOffHooks;cursorKey:string;readOnly:boolean}){
 ensure(deps.cursorKey.length>=32,500,'Manual OFF cursor key unavailable');
 async function identity(c:PoolClient,a:Actor,writing:boolean,pin:boolean){const p=principals.get(a);ensure(p,401,'Uncaptured manual OFF actor');return(await c.query('SELECT manual_inventory_off_identity($1,$2,$3,$4,$5,$6,$7) g',[a.tenantId,a.userId,a.apiKeyId??null,p.digest,a.role,writing,pin])).rows[0].g as{role:string;deadline:string};}
 async function tx<T extends Record<string,unknown>>(a:Actor,writing:boolean,body:(c:PoolClient,v281:boolean)=>Promise<{value:T;deadline?:string;liveId?:string;year?:number}>){
 ensure(!writing||!deps.readOnly,423,'Kopia jest tylko do odczytu');ensure(await manualOffAvailable(deps.pool),503,'Manual OFF unavailable');
 const c=await deps.pool.connect();deps.hooks.begin(c);let open=false;
 try{
  await c.query(writing?'BEGIN ISOLATION LEVEL READ COMMITTED':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');open=true;
  await c.query('RESET ROLE');await c.query("SET LOCAL TimeZone='UTC'");await c.query("SET LOCAL statement_timeout='8s'");
  await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);
  // Actual fresh IAM before any stock/policy source lock. Lifecycle gates then precede all source locks.
  await identity(c,a,writing,false);await deps.hooks.admit(c,a,writing);
  const v281=(await c.query(`SELECT ${VERDICT281} v281`)).rows[0].v281===true;
  ensure((await c.query(v281?'SELECT manual_off_verdict_valid() ok':'SELECT manual_inventory_off_valid() ok')).rows[0].ok,503,'Manual OFF guard changed');
  const r=await body(c,v281);ensure(Buffer.byteLength(JSON.stringify(r.value))<=4194304,413,'Manual OFF response budget');
  if(writing){await c.query('SET CONSTRAINTS ALL IMMEDIATE');await deps.hooks.finalize(c,a);}
  else{await c.query('COMMIT');open=false;await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');open=true;await c.query('RESET ROLE');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenantId]);}
  ensure((await c.query(v281?'SELECT manual_off_verdict_valid() ok':'SELECT manual_inventory_off_valid() ok')).rows[0].ok,503,'Manual OFF metadata changed');
  if(r.liveId)await c.query('SELECT manual_inventory_off_validate($1,true)',[r.liveId]);
  const g=await identity(c,a,writing,true); // after every sibling wait, pins actual IAM until COMMIT
  const flags={available:true,read_only:deps.readOnly,current_role:g.role,can_read:true};
  const result={...r.value,...flags};
  // LAST clock-only statement. No hydration, row locks, audit or deferred trigger after this.
  ensure((await c.query(`SELECT clock_timestamp()<$1::timestamptz AND ($2::timestamptz IS NULL OR clock_timestamp()<$2::timestamptz) AND ($3::integer IS NULL OR extract(year FROM clock_timestamp() AT TIME ZONE 'UTC')=$3) ok`,[g.deadline,r.deadline??null,r.year??null])).rows[0].ok,409,'Manual OFF authority or preview expired');
  await c.query('COMMIT');open=false;return result;
 }catch(e){if(open)await c.query('ROLLBACK').catch(()=>{});return controlled(e);}finally{deps.hooks.end(c);c.release();}
 }
 const binding=(a:Actor,q:Record<string,unknown>)=>({v:1,tenant:a.tenantId,user:a.userId,role:a.role,key:a.apiKeyId??null,read_only:deps.readOnly,filters:{product_id:q.product_id??null,warehouse_id:q.warehouse_id??null}});
 function encodeCursor(a:Actor,q:Record<string,unknown>,ref:Ref){const payload=Buffer.from(JSON.stringify({...binding(a,q),ref})).toString('base64url');return payload+'.'+createHmac('sha256',deps.cursorKey).update(payload).digest('hex');}
 function decodeCursor(a:Actor,q:Record<string,unknown>,raw:string):Ref{const [payload,mac,...rest]=raw.split('.');ensure(rest.length===0&&/^[a-f0-9]{64}$/.test(mac??'')&&/^[A-Za-z0-9_-]+$/.test(payload??''),422,'Invalid manual cursor');const expected=createHmac('sha256',deps.cursorKey).update(payload).digest();ensure(timingSafeEqual(expected,Buffer.from(mac,'hex')),422,'Invalid manual cursor');let v:any;try{v=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{throw new Problem(422,'Invalid manual cursor');}ensure(v&&typeof v==='object'&&!Array.isArray(v),422,'Invalid manual cursor');const{ref,...bound}=v;ensure(JSON.stringify(bound)===JSON.stringify(binding(a,q))&&ref&&typeof ref==='object'&&!Array.isArray(ref)&&Object.keys(ref).sort().join(',')==='at,id'&&uuid.safeParse(ref.id).success&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(ref.at),422,'Manual cursor scope changed');return ref;}
 return{
  source(a:Actor,raw:unknown){const q=manualOffSourceQuery.parse(raw);return tx(a,false,async(c,v281)=>({value:{source:(await c.query(v281?'SELECT manual_off_verdict_frame($1,$2,false) f':'SELECT manual_inventory_off_frame($1,$2,false) f',[q.product_id,q.warehouse_id])).rows[0].f.source,can_preview:!deps.readOnly&&a.role==='admin'}}));},
  preview(a:Actor,raw:unknown){const b=manualOffPreviewInput.parse(raw);return tx(a,true,async(c,v281)=>{const r=(await c.query(v281?'SELECT manual_off_verdict_preview($1,$2,$3::jsonb) r':'SELECT manual_inventory_off_preview($1,$2,$3::jsonb) r',[a.userId,a.apiKeyId??null,JSON.stringify(b)])).rows[0].r;return{value:{...r,can_apply:(await c.query(v281?'SELECT manual_off_verdict_preview_can_apply($1) ok':'SELECT manual_inventory_off_preview_can_apply($1) ok',[r.preview.id])).rows[0].ok},deadline:r.reused?undefined:r.preview.expires_at,year:r.reused?undefined:(await c.query('SELECT year FROM manual_inventory_off_previews WHERE(tenant_id,id)=($1,$2)',[a.tenantId,r.preview.id])).rows[0].year};});},
  previewDetail(a:Actor,id:string){uuid.parse(id);return tx(a,false,async(c,v281)=>{const p=(await c.query('SELECT manual_inventory_off_preview_view($1) p',[id])).rows[0].p;ensure(p,404,'Own manual preview missing');return{value:{preview:p,can_apply:!deps.readOnly&&a.role==='admin'&&(await c.query(v281?'SELECT manual_off_verdict_preview_can_apply($1) ok':'SELECT manual_inventory_off_preview_can_apply($1) ok',[p.id])).rows[0].ok}};});},
  apply(a:Actor,id:string,raw:unknown){uuid.parse(id);const b=manualOffApplyInput.parse(raw);return tx(a,true,async(c,v281)=>{const r=(await c.query(v281?'SELECT manual_off_verdict_apply($1,$2,$3,$4::jsonb) r':'SELECT manual_inventory_off_apply($1,$2,$3,$4::jsonb) r',[a.userId,a.apiKeyId??null,id,JSON.stringify(b)])).rows[0].r;
   const p=(await c.query('SELECT expires_at,year FROM manual_inventory_off_previews WHERE(tenant_id,id)=($1,$2)',[a.tenantId,id])).rows[0];return{value:r,liveId:r.reused?undefined:r.receipt.id,deadline:r.reused?undefined:p.expires_at,year:r.reused?undefined:p.year};});},
  receiptDetail(a:Actor,id:string){uuid.parse(id);return tx(a,false,async c=>{const r=(await c.query('SELECT payload FROM manual_inventory_off_receipts WHERE(tenant_id,id)=($1,$2)',[a.tenantId,id])).rows[0];ensure(r,404,'Own manual receipt missing');await c.query('SELECT manual_inventory_off_validate($1,false)',[id]);return{value:{receipt:r.payload}};});},
  history(a:Actor,raw:unknown){const q=manualOffHistoryQuery.parse(raw),ref=q.after?decodeCursor(a,q,q.after):null;return tx(a,false,async c=>{
   if(ref)ensure((await c.query(`SELECT 1 FROM manual_inventory_off_receipts WHERE tenant_id=$1 AND id=$2 AND created_at=$3::timestamptz AND ($4::uuid IS NULL OR payload#>>'{request,product_id}'=$4::text) AND ($5::uuid IS NULL OR payload#>>'{request,warehouse_id}'=$5::text)`,[a.tenantId,ref.id,ref.at,q.product_id??null,q.warehouse_id??null])).rowCount===1,422,'Manual cursor anchor changed');
   const rows=(await c.query(`SELECT payload,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,id FROM manual_inventory_off_receipts WHERE tenant_id=$1 AND ($2::uuid IS NULL OR payload#>>'{request,product_id}'=$2::text) AND ($3::uuid IS NULL OR payload#>>'{request,warehouse_id}'=$3::text) AND ($4::timestamptz IS NULL OR(created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,[a.tenantId,q.product_id??null,q.warehouse_id??null,ref?.at??null,ref?.id??null])).rows;
   const page=rows.slice(0,50);return{value:{data:page.map(r=>r.payload),next_cursor:rows.length>50?encodeCursor(a,q,{at:page[49].at,id:page[49].id}):null}};});}
 };
}
