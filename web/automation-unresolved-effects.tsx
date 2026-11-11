import {date,api} from './api';
import {useEffect,useRef,useState} from 'react';

type Effect={type:'sync_local_woo_stock'|'email';run_id:string;job_id:string|null;created_at:string;outcome:string;parent_acknowledged:boolean;reconciliation_required:true;effect_plan_id:string|null;effect_job_id:string|null;message_id:string|null;batch_id:string|null};
export type UnresolvedEffectsPage={scope:'ALL_OWN_RULE_RUNS';data:Effect[];has_more:boolean;next_cursor:string|null};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const nullableUuid=(v:unknown)=>v===null||uuid(v);
const labels:Record<string,string>={FAILED_BEFORE_DISPATCH:'Błąd przed wysłaniem',ATTEMPTED_RECONCILIATION_REQUIRED:'Rozpoczęta próba wymaga uzgodnienia',UNKNOWN_WRITE_OR_ACK:'Wynik wysłania lub potwierdzenia jest niepewny',SMTP_ACCEPTED_NOT_DELIVERED:'SMTP przyjął wiadomość; doręczenie nie jest potwierdzone'};
const fields=['type','run_id','job_id','created_at','outcome','parent_acknowledged','reconciliation_required','effect_plan_id','effect_job_id','message_id','batch_id'];
const exact=(v:any,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function unresolvedEffectCursor(row:Effect){return(row.type==='email'?'email:':'stock:')+(row.type==='email'?row.message_id:row.job_id);}
/** Public readback validation only. The parent owns actual current IAM and GETs. */
export function readUnresolvedEffectsPage(value:any):UnresolvedEffectsPage{
 const fail=()=>{throw Error('Nie można potwierdzić listy pierwotnych prób do uzgodnienia. Odczytaj status ponownie.');};
 if(!exact(value,['scope','data','has_more','next_cursor'])||value.scope!=='ALL_OWN_RULE_RUNS'||!Array.isArray(value.data)||value.data.length>25||typeof value.has_more!=='boolean')fail();
 const seen=new Set<string>();let previousTime=Infinity;
 for(const row of value.data){
  if(!exact(row,fields)||!['sync_local_woo_stock','email'].includes(row.type)||!uuid(row.run_id)||!nullableUuid(row.job_id)||typeof row.parent_acknowledged!=='boolean'||row.reconciliation_required!==true||!Object.hasOwn(labels,row.outcome))fail();
  if(typeof row.created_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.created_at))fail();
  const time=Date.parse(row.created_at);if(!Number.isFinite(time)||new Date(time).toISOString()!==row.created_at||time>previousTime)fail();previousTime=time;
  if(row.type==='sync_local_woo_stock'){
   if(!uuid(row.job_id)||!nullableUuid(row.effect_plan_id)||!nullableUuid(row.effect_job_id)||row.message_id!==null||row.batch_id!==null||row.outcome==='SMTP_ACCEPTED_NOT_DELIVERED')fail();
  }else if(!uuid(row.message_id)||!uuid(row.batch_id)||row.effect_plan_id!==null||row.effect_job_id!==null)fail();
  const key=unresolvedEffectCursor(row);if(seen.has(key))fail();seen.add(key);
 }
 // Actual keyset ordering uses PG microseconds. Published millisecond ties do
 // not justify reordering by UUID or reconstructing a cursor timestamp here.
 if(value.has_more){if(value.data.length!==25||value.next_cursor!==unresolvedEffectCursor(value.data.at(-1)))fail();}
 else if(value.next_cursor!==null)fail();
 return value;
}
type EmailDetail={batch_id:string;message_id:string;job_id:string|null;run_id:string;channel_id:string;batch_state:string;message_state:string;attempted_at:string|null;delivery_confirmed:false};
const emailStates:Record<string,string>={draft:'Nie wysłano',invalid:'Nieprawidłowa wiadomość',queued:'W kolejce',simulated:'Symulacja',smtp_accepted:'SMTP przyjął wiadomość; doręczenie nie jest potwierdzone',uncertain:'Wynik wysłania jest niepewny',failed:'Błąd wykonania',cancelled:'Anulowano'};
/** Project only the original local batch/message identity and state. Never expose payload, recipient or SMTP error. */
export function readOriginalAutomationEmail(value:any,row:Effect,contextKey:string):EmailDetail{
 const fail=()=>{throw Error('Nie potwierdzono oryginalnej wiadomości tej firmy.');};
 const parts=contextKey.split(':');if(parts.length!==2||!parts.every(uuid)||row.type!=='email'||!uuid(row.batch_id)||!uuid(row.message_id))fail();
 const[tenant,user]=parts;
 if(!value||typeof value!=='object'||Array.isArray(value)||value.id!==row.batch_id||value.tenant_id!==tenant||value.actor_id!==user||value.automation_run_id!==row.run_id||value.automation_schedule_run_id!==null||value.order_batch_id!==null||value.mode!=='smtp'||!uuid(value.channel_id)||typeof value.channel_hash!=='string'||!/^[a-f0-9]{64}$/.test(value.channel_hash)||value.external_allowed!==false||!['preview','queued','done','cancelled'].includes(value.state)||!Array.isArray(value.items)||value.items.length<1||value.items.length>200)fail();
 const ids=new Set<string>();for(const item of value.items){if(!item||typeof item!=='object'||Array.isArray(item)||!uuid(item.id)||item.tenant_id!==tenant||item.batch_id!==row.batch_id||!nullableUuid(item.job_id)||ids.has(item.id))fail();ids.add(item.id);}
 const message=value.items.find((item:any)=>item.id===row.message_id);
 if(!message||message.job_id!==row.job_id||!Object.hasOwn(emailStates,message.state)||message.sender?.local_sink!==true)fail();
 if(message.attempted_at!==null&&(typeof message.attempted_at!=='string'||!Number.isFinite(Date.parse(message.attempted_at))||new Date(message.attempted_at).toISOString()!==message.attempted_at))fail();
 return{batch_id:value.id,message_id:message.id,job_id:message.job_id,run_id:value.automation_run_id,channel_id:value.channel_id,batch_state:value.state,message_state:message.state,attempted_at:message.attempted_at,delivery_confirmed:false};
}
export function AutomationUnresolvedEffects(p:{value:unknown;busy:boolean;contextKey?:string;onOlder:(cursor:string)=>void}){
 const live=useRef({context:p.contextKey,value:p.value}),alive=useRef(true);live.current={context:p.contextKey,value:p.value};
 const flight=useRef<{context:string;value:unknown;controller:AbortController}|null>(null);
 const[detail,setDetail]=useState<{context:string;value:unknown;key:string;loading:boolean;result:EmailDetail|null;error:string}|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;flight.current?.controller.abort();flight.current=null;};},[]);
 useEffect(()=>{const old=flight.current;if(old&&(old.context!==p.contextKey||old.value!==p.value)){old.controller.abort();flight.current=null;}setDetail(null);},[p.contextKey,p.value]);
 const visibleDetail=detail&&detail.context===p.contextKey&&detail.value===p.value?detail:null;
 const contextParts=p.contextKey?.split(':')??[],canRead=contextParts.length===2&&contextParts.every(uuid);
 async function readEmail(row:Effect){
  if(p.busy||flight.current||!canRead||!p.contextKey||row.type!=='email')return;
  const original={...row},context=p.contextKey,value=p.value,key=unresolvedEffectCursor(original),ticket={context,value,controller:new AbortController()};flight.current=ticket;
  const current=()=>alive.current&&flight.current===ticket&&live.current.context===context&&live.current.value===value;
  setDetail({context,value,key,loading:true,result:null,error:''});
  const sameActor=async()=>{if(!current())throw Error('Stale read');const me=await api('/auth/me','GET',undefined,{},ticket.controller.signal);const[tenant,user]=context.split(':');if(!current()||me.restore_preview!==false||me.user?.tenant_id!==tenant||me.user?.id!==user||me.user?.role!=='admin'||me.user?.api_key_id)throw Error('Actor refused');};
  try{await sameActor();const batch=await api('/email/batches/'+original.batch_id,'GET',undefined,{},ticket.controller.signal);await sameActor();const result=readOriginalAutomationEmail(batch,original,context);if(current())setDetail({context,value,key,loading:false,result,error:''});}
  catch{if(current())setDetail({context,value,key,loading:false,result:null,error:'Nie potwierdzono odczytu oryginalnej wiadomości. Odczytaj status ponownie; nie wysyłaj jej ponownie.'});}
  finally{if(flight.current===ticket)flight.current=null;}
 }

 if(p.value===undefined)return <p>Ten odczyt nie udostępnia listy pierwotnych prób do uzgodnienia.</p>;
 let page:UnresolvedEffectsPage;try{page=readUnresolvedEffectsPage(p.value);}catch{return <p role="alert">Nie można potwierdzić listy pierwotnych prób do uzgodnienia. Odczytaj status ponownie.</p>;}
 return <section aria-label="Pierwotne próby do uzgodnienia"><h5>Pierwotne próby do uzgodnienia</h5>
  <p>Lista jest niezależna od ostatnich wykonań reguły. Identyfikatory wskazują oryginalne zapisy; odczyt nie ponawia wysyłania.</p>
  {!page.data.length&&<p>Na tej stronie nie ma prób do uzgodnienia. Aby wrócić do najnowszej listy, odczytaj status.</p>}
  {page.data.map(row=><article key={unresolvedEffectCursor(row)}><strong>{row.type==='email'?'Email':'Stan lokalnego Woo'} · {labels[row.outcome]}</strong>
   <p>{date(row.created_at)} · {row.parent_acknowledged?'Zadanie nadrzędne potwierdzone':'Brak potwierdzenia zadania nadrzędnego'}</p>
   <dl><dt>Wykonanie reguły</dt><dd><code>{row.run_id}</code></dd><dt>Oryginalne zadanie</dt><dd>{row.job_id?<code>{row.job_id}</code>:'Nie potwierdzono powiązanego zadania'}</dd>
    {row.effect_plan_id&&<><dt>Oryginalny plan oferty</dt><dd><code>{row.effect_plan_id}</code></dd></>}
    {row.effect_job_id&&<><dt>Zadanie oferty</dt><dd><code>{row.effect_job_id}</code></dd></>}
    {row.message_id&&<><dt>Wiadomość</dt><dd><code>{row.message_id}</code></dd></>}
    {row.batch_id&&<><dt>Partia email</dt><dd><code>{row.batch_id}</code></dd></>}
   </dl>
   {row.type==='sync_local_woo_stock'?<p>Odczyt szczegółów planu jest niedostępny: nie potwierdzono jego pierwotnego kanału. Nie ponawiaj synchronizacji.</p>:<>
    <button type="button" className="button small-btn" disabled={p.busy||!!visibleDetail?.loading||!canRead} onClick={()=>void readEmail(row)}>Sprawdź stan oryginalnej wiadomości</button>
    {visibleDetail?.key===unresolvedEffectCursor(row)&&<div aria-label="Stan oryginalnego emaila">
     {visibleDetail.loading&&<p role="status">Odczytywanie zapisanej partii…</p>}
     {visibleDetail.error&&<p role="alert">{visibleDetail.error}</p>}
     {visibleDetail.result&&<><p>{emailStates[visibleDetail.result.message_state]}</p><p>Odczyt lokalnego zapisu nie wysyła wiadomości i nie potwierdza doręczenia.</p><dl><dt>Kanał oryginalnej partii</dt><dd><code>{visibleDetail.result.channel_id}</code></dd><dt>Stan partii</dt><dd>{visibleDetail.result.batch_state}</dd><dt>Oryginalne zadanie</dt><dd>{visibleDetail.result.job_id?<code>{visibleDetail.result.job_id}</code>:'Brak potwierdzonego zadania'}</dd></dl></>}
    </div>}
   </>}
   </article>)}
  {page.has_more&&<button type="button" className="button small-btn" disabled={p.busy} onClick={()=>p.onOlder(page.next_cursor!)}>Starsze próby do uzgodnienia</button>}
 </section>;
}
