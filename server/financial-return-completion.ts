/** SOURCE_AUTHORED_NOT_RUN. Trusted financial producer and final managed
 * terminal; install only with the complete certified162 package. */
import type {PoolClient} from 'pg';
import type {Actor} from './domain';
import {ensure,Problem} from './errors';
import {isDeepStrictEqual} from 'node:util';
import {financialReturn162CaptureSchema,validateFinancialReturn162Received} from './financial-return-values';
type Row=Record<string,any>;
type Context={tenant:string;root:string;started:string;pid:number};
type Duty={actor:Actor;hash:string;receipt:string;return_id:string};
type Transaction={duties:Duty[];claimed:boolean};
const transactions=new WeakMap<PoolClient,Transaction>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasFinancialReturn162TransactionDuty(c:PoolClient){return Boolean(transactions.get(c)?.claimed || transactions.get(c)?.duties.length);}
const principals=new WeakMap<Actor,string>();
export function beginFinancialReturn162Transaction(c:PoolClient){ensure(!transactions.has(c),409,'Powtórny kontekst finansowego przyjęcia');transactions.set(c,{duties:[],claimed:false});}
export function endFinancialReturn162Transaction(c:PoolClient){transactions.delete(c);}
/** Reciprocal single last-clock boundary. Called before COUNT/OAuth native
 * admission/DML, not at COMMIT after competing obligations already exist. */
export function assertNoFinancialReturn162AdmissionInTx(c:PoolClient){
 ensure(!transactions.get(c)?.claimed,409,'Financial receive, COUNT and OAuth need separate managed transactions');
}
async function reserveTerminal(c:PoolClient){
 const count=await import('./catalog-stock-control-transaction');
 const oauth=await import('./allegro-oauth-authority');
 count.assertNoCatalogStockCountTerminalInTx(c);oauth.assertNoAllegroAuthorityInTx(c);
 const tx=transactions.get(c);ensure(tx,403,'No managed financial context');tx.claimed=true;
}

export async function financialReturn162RequestActor(req:Parameters<typeof import('./fa3-draft-source').b2bFa3NativeRequestActor>[0],sessionName:string):Promise<Actor>{
 const native=await import('./fa3-draft-source');
 const a=native.b2bFa3NativeRequestActor(req,sessionName);
 principals.set(a,native.b2bFa3NativeIdentityHash(a));return a;
}
async function context(c:PoolClient,a:Actor):Promise<Context>{
 const x=(await c.query("SELECT current_setting('app.tenant_id',true) tenant,pg_current_xact_id()::text root,transaction_timestamp()::text started,pg_backend_pid() pid,current_user role,session_user owner,pg_get_userbyid(relowner) relation_owner FROM pg_class WHERE oid='public.orders'::regclass")).rows[0];
 ensure(x&&x.tenant===a.tenantId&&x.role==='dyna_app'&&x.owner===x.relation_owner&&x.owner!=='dyna_app',403,'Obcy kontekst przyjęcia');
 ensure(transactions.has(c),403,'Finansowe przyjęcie wymaga rzeczywistej zarządzanej transakcji');
 return {tenant:x.tenant,root:x.root,started:x.started,pid:x.pid};
}
function mapError(e:unknown):never{if(e instanceof Problem)throw e;const code=(e as{code?:string}).code;
 if(['55000','42P01','42703','42883'].includes(code??''))throw new Problem(503,'Niepełny certyfikowany protokół finansowego przyjęcia');
 if(code==='28000')throw new Problem(401,'Sesja lub klucz finansowego przyjęcia wygasł');
 if(code==='42501')throw new Problem(403,'Cofnięto uprawnienie finansowego przyjęcia');
 if(code==='P0002')throw new Problem(404,'Brak własnego finansowego źródła');
 if(code==='54000')throw new Problem(413,'Pełne źródło przekracza budżet');
 if(code==='22023')throw new Problem(422,'Niepełne ilości rzeczywistego przyjęcia finansowego');
 if(['23514','23503','23505','40001','40P01'].includes(code??''))throw new Problem(409,'Zmienił się kompletny dowód finansowego przyjęcia');throw e;
}
async function owner<T>(c:PoolClient,fn:()=>Promise<T>):Promise<T>{
 const bridge=await import('./fa3-draft-access');
 try{return await bridge.fa3DraftOwnerInTx(c,fn);}catch(e){return mapError(e);}
}
async function available(c:PoolClient){return owner(c,async()=>{
 const p=(await c.query("SELECT EXISTS(SELECT FROM migrations WHERE name='162_financial_return') installed,to_regprocedure('public.financial_return_guards()') IS NOT NULL helper,(EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'financial\\_return\\_%' ESCAPE '\\') OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'financial\\_return\\_%' ESCAPE '\\') OR EXISTS(SELECT FROM pg_trigger WHERE tgname LIKE 'financial\\_return\\_%' ESCAPE '\\')) artifacts,to_regprocedure('public.guard_verdict(text)') verdict")).rows[0];
 if(!p.installed&&!p.helper&&!p.artifacts)return false;
 ensure(p.installed&&p.helper,503,'Niepełny protokół162');
 // 248: the same verdict, reused while the cold-approved schema and the guard's basis are unchanged.
 ensure((await c.query(p.verdict?"SELECT public.guard_verdict('financial_return_guards') ok":'SELECT public.financial_return_guards() ok')).rows[0].ok===true,503,'Uszkodzone metadane162');return true;
 });}
/** True absence is neutral; a partial or damaged installation still fails503. */
export {available as financialReturn162AvailableInTx};
declare const brand:unique symbol;
export type FinancialReturn162Handle=Readonly<{[brand]:true}>;
type State={client:PoolClient;actor:Actor;hash:string;context:Context;return_id:string;request:Row;frame:Row;phase:'captured'|'claimed'|'complete'|'replay';admission?:string};
const custody=new WeakMap<FinancialReturn162Handle,State>();
function state(c:PoolClient,a:Actor,h:FinancialReturn162Handle){const s=custody.get(h);ensure(s&&s.client===c&&s.actor===a&&principals.get(a)===s.hash,403,'Obcy token/client/actor finansowego przyjęcia');return s;}
async function current(c:PoolClient,a:Actor,s:State){ensure(isDeepStrictEqual(await context(c,a),s.context),409,'Inny root/start/backend finansowego przyjęcia');}
/** Native WMS enlist always returns a clone. Only this actual trusted call may
 * transfer the principal to its returned actor; a caller-supplied clone cannot
 * rebind an opaque handle. Original actor/token/client/context must match first. */
export async function enlistFinancialReturn162ActorInTx(c:PoolClient,a:Actor,h:FinancialReturn162Handle|null):Promise<Actor>{
 const s=h?state(c,a,h):undefined;
 if(s){await current(c,a,s);ensure(s.phase==='captured'||s.phase==='replay',409,'Native enlist after financial admission');}
 const {enlistWmsActorInTx}=await import('./wms-lots-transaction');
 const next=enlistWmsActorInTx(c,a,{orders:true});
 if(s){principals.set(next,s.hash);s.actor=next;}
 return next;
}
/** Existing completion calls once BEFORE source waits. No row admission/order
 * SHARE or counter is acquired here. Unsupported adapters are neutral. */
export async function prepareFinancialReturn162InTx(c:PoolClient,a:Actor,source:{protocol:string;return_id:string;request:Row}):Promise<FinancialReturn162Handle|null>{
 if(source.protocol!=='rma'||!await available(c))return null;
 const hash=principals.get(a);
 // Nonordinary/internal protocols do not borrow the HTTP request identity.
 if(!hash)return null;
 const ctx=await context(c,a);
 // 272: the ordinary-receipt front door answers NULL only where the sealed capture would, and is the sealed capture otherwise.
 const saved=await owner(c,async()=>{const front=(await c.query("SELECT to_regprocedure('public.return_receipt272_financial_capture(uuid,uuid,text,uuid,jsonb)') IS NOT NULL f")).rows[0].f===true;
  return (await c.query(front?'SELECT public.return_receipt272_financial_capture($1,$2,$3,$4,$5::jsonb) frame':'SELECT public.financial_return_capture($1,$2,$3,$4,$5::jsonb) frame',[a.userId,a.apiKeyId??null,hash,source.return_id,JSON.stringify(source.request)])).rows[0].frame;});
 if(saved===null)return null;
 ensure(saved&&['captured','replay'].includes(saved.phase),503,'Niepełna faza rzeczywistego protokołu162');
 const frame=saved.frame;
 if(saved.phase==='captured')financialReturn162CaptureSchema.parse(frame); // Validate without rewriting native JSON numbers or timestamp bytes.
 const h=Object.freeze({}) as FinancialReturn162Handle;
 custody.set(h,{client:c,actor:a,hash,context:ctx,return_id:source.return_id,request:structuredClone(source.request),frame,
  phase:saved.phase, ...(saved.phase==='replay'?{admission:saved.receipt_id}:{})});
 return h;
}
/** Called only after actual lockedReturn+state/version check and BEFORE the
 * first UPDATE return_items. It cannot substitute for canonical receiveReturn. */
export async function claimFinancialReturn162InTx(c:PoolClient,a:Actor,h:FinancialReturn162Handle|null){
 if(!h)return;const s=state(c,a,h);await current(c,a,s);ensure(s.phase==='captured',409,'Powtórne finansowe dopuszczenie');
 await reserveTerminal(c);
 s.admission=await owner(c,async()=>(await c.query('SELECT public.financial_return_claim($1,$2,$3,$4,$5::jsonb,$6::jsonb) id',
 [a.userId,a.apiKeyId??null,s.hash,s.return_id,JSON.stringify(s.request),JSON.stringify(s.frame)])).rows[0].id);
 ensure(typeof s.admission==='string',503,'Brak rzeczywistego dopuszczenia162');s.phase='claimed';
}
/** Native receive replay can be discovered only AFTER the canonical source
 * wait. A prewait captured handle must rebind to the existing receipt without
 * inserting an admission or recertifying the later closed head. */
export async function replayFinancialReturn162InTx(c:PoolClient,a:Actor,h:FinancialReturn162Handle|null){
 if(!h)return;const s=state(c,a,h);await current(c,a,s);
 ensure(s.phase==='captured'||s.phase==='replay',409,'Nie można porzucić zmienionego financial przyjęcia');
 const saved=await owner(c,async()=>(await c.query('SELECT public.financial_return_capture($1,$2,$3,$4,$5::jsonb) frame',
 [a.userId,a.apiKeyId??null,s.hash,s.return_id,JSON.stringify(s.request)])).rows[0].frame);
 ensure(saved?.phase==='replay'&&saved.receipt_id,409,'Brak właściwego historical financial replay');
 await reserveTerminal(c);s.admission=saved.receipt_id;s.phase='replay';
}
/** After native112/138 and every actual receive write; before ALLIMMEDIATE. */
export async function completeFinancialReturn162InTx(c:PoolClient,a:Actor,h:FinancialReturn162Handle|null){
 if(!h)return;const s=state(c,a,h);await current(c,a,s);
 if(s.phase==='replay'){
  await reserveTerminal(c);
  await owner(c,()=>c.query('SELECT public.financial_return_replay($1,$2,$3,$4,$5::jsonb)',[a.userId,a.apiKeyId??null,s.hash,s.admission,JSON.stringify(s.request)]));
 }else{
  ensure(s.phase==='claimed'&&s.admission,409,'Přijetí nemá skutečné dopuszczenie');
  const received=await owner(c,async()=>(await c.query('SELECT public.financial_return_received($1) graph',[s.admission])).rows[0].graph);
  ensure(Buffer.byteLength(JSON.stringify({captured:s.frame,received:received.received,physical:received.physical}),'utf8')<=33554432,413,'Pełny graf finansowego przyjęcia przekracza32MiB');
  const expected=validateFinancialReturn162Received(s.frame,received.received,received.physical);
  const receipt=await owner(c,async()=>(await c.query('SELECT public.financial_return_finish($1,$2,$3,$4) receipt',[a.userId,a.apiKeyId??null,s.hash,s.admission])).rows[0].receipt);
  ensure(isDeepStrictEqual(receipt.financial,expected.financial),503,'Native i pure financial projection różnią się');s.phase='complete';
 }
 const tx=transactions.get(c)!;
 ensure(tx.duties.every(d=>d.actor===a&&d.hash===s.hash&&d.receipt===s.admission),409,'162 ordinary receive wymaga jednej rzeczywistej tożsamości; grupowy terminal jest osobnym etapem');
 if(!tx.duties.some(d=>d.receipt===s.admission))tx.duties.push({actor:a,hash:s.hash,receipt:s.admission!,return_id:s.return_id});
}
/** RAM-only after result hydration. The actual terminal is managed by db.ts,
 * after ALLIMMEDIATE and every sibling finalizer, never this local callback. */
export function discardFinancialReturn162Handle(c:PoolClient,a:Actor,h:FinancialReturn162Handle|null){if(h){state(c,a,h);custody.delete(h);}}
export function hasFinancialReturn162Duty(c:PoolClient){return Boolean(transactions.get(c)?.duties.length);}
/** Must be the actual LAST managed SQL before COMMIT. Both metadata and fresh
 * native request DBclock are enforced after real user/session/member waits.
 * No owner bridge/restoration, response hydration or DML follows this query. */
export async function finalizeFinancialReturn162InTx(c:PoolClient){
 const tx=transactions.get(c);if(!tx?.duties.length)return;
 const first=tx.duties[0];
 try{await c.query('SELECT public.financial_return_terminal($1,$2,$3,$4::uuid[])',
 [first.actor.userId,first.actor.apiKeyId??null,first.hash,tx.duties.map(d=>d.receipt)]);}catch(e){return mapError(e);}
}
