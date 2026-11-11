/** Real configured mapper and readable native review, using durable per-job PIM endpoints. */
import React,{useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {Job} from '../../../shared/large-import-dependencies/pim-large-import-http-binding-ui/contracts';
import type {LargeImportHttp} from '../../../shared/large-import-dependencies/pim-large-import-http-binding-ui/browser';
import {JobFlowController,largeImportCustody,type Context} from '../../../shared/large-import-dependencies/pim-large-import-job-flow-ui2/model';
import type {PimContext,PimTransport} from '../../pim/editor';
import {LegacyPimMapForm} from '../../pim/legacy-files/map-form';
import {NestedMapForm} from '../../pim/legacy-files/v2/map-form';
import {NestedUnmappedReview} from '../../pim/legacy-files/v2/unmapped-review';
import {ReadableStageTable} from '../../pim/legacy-files/panel';
import {fieldErrorLabel} from '../../pim/readable-preview';
import {PimReadablePreview} from '../../pim/readable-preview-view';
import type {MappingTemplate} from '../../pim/legacy-files/session';
import {same,need} from '../../pim/legacy-files/handoff';
import {committedCustody,stageRead,previewRead,operationRead,type StageRead} from './model';
import {createPimJobActions} from './actions';
export type Props={job:Job;http:LargeImportHttp;context:PimContext;catalogId:string;transport:PimTransport;blocked:boolean;nestedAvailable:boolean;onChanged?():Promise<void>|void};
const principal=(c:PimContext):Context=>({tenantId:c.tenant_id,userId:c.user_id,apiKeyId:null});
export function hasCompleteCoreForPim(j:Job):boolean{
 try{
  if(!j.approved||j.core.length===0||j.core.length!==j.manifest.total_batches||j.core.length!==j.manifest.batches.length)return false;
  return j.core.every((c,n)=>{
   const p=c.preview,e=c.execution;if(!p||!e||p.ack.head.ready!==true||e.ack.head.state!=='done'||e.ack.head.preview_id!==p.ack.head.id||e.ack.head.scope_hash!==p.ack.head.scope_hash||e.ack.head.actor_id!==j.principal.userId||p.ack.head.actor_id!==j.principal.userId||e.ack.head.total!==c.identities.length||e.ack.head.total!==j.manifest.batches[n].rows||p.ack.head.total!==e.ack.head.total||e.pages.length<1||e.pages.length>5)return false;
   let offset=0;for(const page of e.pages){
    if(!same(page.head,e.ack.head)||page.rows.length<1||page.rows.length>100)return false;
    for(const row of page.rows){if(row.index!==offset||row.identity_value!==c.identities[offset]||!Array.isArray(row.errors)||row.errors.length!==0||typeof row.product_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.product_id))return false;offset++;}
    if(page.next!==(offset<e.ack.head.total?String(offset):null))return false;
   }return offset===e.ack.head.total;
  });
 }catch{return false;}
}
/** Native latest-attempt flags survive reload; no browser-memory receipt or retry authority is inferred. */
export function unresolvedPimAttempts(j:Job):{batch:number;attempt:number;phase:'preview'|'apply'}[]{
 return j.core.flatMap<{batch:number;attempt:number;phase:'preview'|'apply'}>((_,batch)=>{const a=j.pim[batch]?.at(-1);if(!a)return[];
  if(a.applyAttempted&&!a.applied)return[{batch,attempt:a.number,phase:'apply' as const}];
  if(a.previewAttempted&&!a.preview)return[{batch,attempt:a.number,phase:'preview' as const}];
  return[];
 });
}
export function LargeImportPimRenderer(props:Props){
 const latest=useRef(props);latest.current=props;const active=useRef(false),generation=useRef(0),flowRef=useRef<JobFlowController|null>(null);
 const key=JSON.stringify([props.context,props.job.id,props.catalogId]),context=principal(props.context);
 const actions=useMemo(()=>createPimJobActions(props.http,props.transport,()=>{const p=latest.current;return{job:flowRef.current?.snapshot().job??p.job,context:p.context,catalogId:p.catalogId,nestedAvailable:p.nestedAvailable,blocked:p.blocked,active:active.current,generation:generation.current};},()=>accessLost()),[props.http,props.transport,key]);
 const flow=useMemo(()=>new JobFlowController(()=>{const p=latest.current;return{actions,context:principal(p.context),jobId:p.job.id,canManage:p.context.role==='admin'&&!p.context.restore_preview,externalWriteBlocked:p.blocked||!hasCompleteCoreForPim(flowRef.current?.snapshot().job??p.job)};}),[actions]);flowRef.current=flow;
 const v=useSyncExternalStore(flow.subscribe.bind(flow),flow.snapshot.bind(flow));useSyncExternalStore(largeImportCustody.subscribe,()=>largeImportCustody.get(context),()=>undefined);
 const [batch,setBatch]=useState(0),[nested,setNested]=useState(false),[editing,setEditing]=useState(!props.job.pim[0]?.at(-1)?.stage),[consent,setConsent]=useState(false),[lost,setLost]=useState(false),[error,setError]=useState(''),[read,setRead]=useState<{key:string;stage:StageRead|null;error:string}>({key:'',stage:null,error:''});
 const pending=largeImportCustody.get(context),ownPending=pending?.jobId===props.job.id?pending:null;
 const job=v.job??props.job;let custody:ReturnType<typeof committedCustody>|null=null,sourceError='';try{custody=committedCustody(job,context,batch,props.catalogId);}catch(e){sourceError=(e as Error).message;}
 const a=job.pim[batch]?.at(-1),stageKey=JSON.stringify([key,batch,a?.number,a?.stage]);const stage=read.key===stageKey?read.stage:null;
 let preview:ReturnType<typeof previewRead>=null,operation:ReturnType<typeof operationRead>=null,presentationError='';try{if(stage){preview=previewRead(job,batch,stage);if(preview)operation=operationRead(job,batch,preview);}}catch(e){presentationError=(e as Error).message;}
 const completeCore=hasCompleteCoreForPim(job),nativePending=unresolvedPimAttempts(job);
 const blocked=!completeCore||nativePending.length>0||props.blocked||lost||props.context.role!=='admin'||props.context.restore_preview||v.busy||!!pending;
 useLayoutEffect(()=>{active.current=true;generation.current++;flow.activate();setBatch(0);setRead({key:'',stage:null,error:''});setConsent(false);setLost(false);setError('');void flow.refresh();return()=>{active.current=false;generation.current++;flow.deactivate();};},[flow]);
 useEffect(()=>{setEditing(!a?.stage);setConsent(false);},[stageKey]);
 useEffect(()=>{setConsent(false);},[preview?.id,preview?.scope_hash,props.blocked,props.context.role,props.context.restore_preview,completeCore,nativePending.length]);
 const accessLost=()=>{active.current=false;generation.current++;flow.deactivate();setLost(true);setConsent(false);setRead({key:'',stage:null,error:''});setError('Tożsamość lub dostęp uległy zmianie. Oryginalna próba pozostaje zachowana.');};
 useEffect(()=>{let live=true;const g=generation.current,p=latest.current,c=custody;setRead({key:stageKey,stage:null,error:''});if(!c||!a?.stage||lost)return()=>{live=false;};
  void(async()=>{try{const me:any=await p.transport('/auth/me');if(!live||!active.current||g!==generation.current)return;if(me?.user?.id!==p.context.user_id||me?.user?.tenant_id!==p.context.tenant_id||me?.user?.role!==p.context.role||me?.restore_preview!==p.context.restore_preview){accessLost();return;}const raw=await p.transport('/product-catalogs/'+p.catalogId+'/pim/dictionary');if(!live||!active.current||g!==generation.current)return;const complete=stageRead(job,batch,c,raw);setRead({key:stageKey,stage:complete,error:''});}catch(e){if(!live||!active.current||g!==generation.current)return;if([401,403,404].includes((e as{status?:number}).status??0))accessLost();setRead({key:stageKey,stage:null,error:(e as Error).message});}})();return()=>{live=false;};
 },[stageKey,props.transport,lost]);
 async function mapping(m:MappingTemplate){if(blocked)return;setConsent(false);setError('');await flow.send({kind:'new_pim',batch,mapping:structuredClone(m)});if(largeImportCustody.get(context))return;const saved=flow.snapshot().job?.pim[batch]?.at(-1);if(!saved||!same(saved.mapping,m))return;await flow.send({kind:'stage_pim',batch,attempt:saved.number});await latest.current.onChanged?.();}
 const refresh=async()=>{setConsent(false);if(lost){active.current=true;generation.current++;flow.activate();setLost(false);}await flow.refresh();};
 const act=(f:()=>Promise<unknown>)=>{setError('');void f().catch(e=>setError(e instanceof Error?e.message:'Nie można potwierdzić próby'));};
 return <section aria-label="Parametry PIM zapisanych partii dużego importu"><h3>Oddzielne parametry po zapisie katalogu</h3><p>Produkty pochodzą wyłącznie z pełnych trwałych wierszy zapisanych partii. Wybory mapy nie zapisują parametrów. Core i PIM mają osobne zgody.</p>
 {!completeCore&&<p role="status">Parametry PIM można zapisać po potwierdzeniu zapisu wszystkich partii CORE. Niepotwierdzone próby pozostają zachowane.</p>}
 {nativePending.length>0&&<div role="status"><p>Wynik oryginalnej operacji parametrów pozostaje niepotwierdzony.</p><ul>{nativePending.map(p=><li key={p.batch}>Partia {p.batch+1}: {p.phase==='apply'?'zapis parametrów':'podgląd parametrów'} bez trwałego potwierdzenia.</li>)}</ul><p>Nowe mapowanie i nowe zapisy są wyłączone. Odczytaj trwałe potwierdzenia parametrów; nie rozpoczynaj nowej próby.</p></div>}
 <label>Zapisana partia<select value={batch} disabled={blocked} onChange={e=>{setBatch(Number(e.target.value));setConsent(false);setNested(false);setEditing(!job.pim[Number(e.target.value)]?.at(-1)?.stage);}}>{job.core.map((c,n)=>c.execution?<option key={n} value={n}>Partia {n+1} · {job.manifest.batches[n].rows} wierszy</option>:null)}</select></label>
 {(error||v.error||sourceError||read.error||presentationError)&&<p role="alert">{error||v.error||sourceError||read.error||presentationError}</p>}
 {v.busy&&<p role="status">Potwierdzanie trwałej próby parametrów…</p>}
 <button disabled={v.busy||props.blocked||props.context.role!=='admin'||props.context.restore_preview} onClick={()=>act(refresh)}>Odczytaj trwałe potwierdzenia parametrów</button>
 {ownPending&&<div role="status"><p>Wynik oryginalnej próby jest niepotwierdzony. Zachowano dokładne zadanie, partię, mapę i zakres.</p><button disabled={!completeCore||ownPending.flight||props.blocked||props.context.role!=='admin'||props.context.restore_preview} onClick={()=>act(()=>flow.send(ownPending.command,true))}>{ownPending.command.kind==='new_pim'?'Rozstrzygnij oryginalną mapę bez nowego zapisu':'Ponów dokładną trwałą próbę parametrów'}</button></div>}
 {custody&&!lost&&!operation&&a?.stage&&!editing&&<button disabled={blocked} onClick={()=>{setEditing(true);setConsent(false);}}>Zmień mapowanie tej partii</button>}
 {editing&&a?.stage&&<p role="status">Zmiana mapy wymaga nowego pełnego sprawdzenia i osobnego podglądu. Poprzednia zgoda nie obejmuje nowych wyborów.</p>}
 {custody&&!lost&&!operation&&editing&&<><label><input type="checkbox" checked={nested} disabled={blocked||!props.nestedAvailable} onChange={e=>{setNested(e.target.checked);setConsent(false);}}/>Mapuj zagnieżdżone dane JSON</label>
 {nested?<NestedMapForm context={props.context} custody={custody} transport={props.transport} available={props.nestedAvailable} blocked={blocked} onEdit={()=>setConsent(false)} onAccessLost={accessLost} onMapping={mapping}/>:<LegacyPimMapForm context={props.context} custody={custody} transport={props.transport} blocked={blocked} onEdit={()=>setConsent(false)} onAccessLost={accessLost} onMapping={mapping}/>}</>}
 {a&&!a.stage&&!ownPending&&<button disabled={blocked} onClick={()=>act(()=>flow.send({kind:'stage_pim',batch,attempt:a.number}))}>Sprawdź pełny odczyt zapisanej mapy</button>}
 {stage&&!lost&&!editing&&<><ReadableStageTable rows={stage.intake.rows} sources={stage.sources} dictionary={stage.dictionary} unmapped={stage.nested?undefined:stage.intake.rows.map((r:any)=>({index:r.index,fields:r.unmapped_fields}))} label="Pełna mapa parametrów zapisanej partii"/>{stage.nested&&stage.nested.rows.map(r=><NestedUnmappedReview key={r.product_id} original={r.original} descriptors={r.unmapped_fields}/>)}{stage.errors.length>0&&<ul role="alert">{stage.errors.map((e:any,i)=><li key={i}>Wiersz {e.row+1}: {fieldErrorLabel(e,stage.dictionary)}</li>)}</ul>}{stage.request&&!preview&&!operation&&<button disabled={blocked} onClick={()=>act(()=>flow.send({kind:'preview_pim',batch,attempt:a!.number}))}>Sprawdź osobny podgląd PIM partii</button>}</>}
 {preview&&stage&&!lost&&!editing&&<><PimReadablePreview preview={preview} dictionary={stage.dictionary}/><label><input type="checkbox" checked={consent} disabled={blocked||!!operation||!preview.ready||!preview.can_apply||!!preview.operation_id} onChange={e=>setConsent(e.target.checked)}/>Sprawdziłem pełny podgląd i osobno potwierdzam parametry tej partii</label><button disabled={blocked||!consent||!!operation||!preview.ready||!preview.can_apply||!!preview.operation_id} onClick={()=>{if(!consent)return;setConsent(false);act(async()=>{await flow.send({kind:'apply_pim',batch,attempt:a!.number,previewId:preview!.id,scopeHash:preview!.scope_hash});await latest.current.onChanged?.();});}}>Zapisz osobno zatwierdzone parametry partii</button></>}
 {operation&&!lost&&<p role="status">Parametry partii zapisane · zmieniono {operation.changed_count} produktów. To historyczne potwierdzenie; odczyt bieżących danych jest osobnym działaniem.</p>}
 </section>;
}
