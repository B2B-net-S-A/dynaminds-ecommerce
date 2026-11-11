/** Proposed complete-review capability only. Existing sequential coordinator3 is not this producer. */
export type {Job,Context} from '../pim-large-import-job-flow-ui2/model';
import {validateJob,largeImportLocked,type Job,type Context} from '../pim-large-import-job-flow-ui2/model';
export type Witness={id:string;sha256:string;byte_count:number};
import type {CoreReview,ReviewedBatch} from '../pim-large-import-job-coordinator-backend5/core-review';
export type NativeBatch=ReviewedBatch;
export type Scope=CoreReview;
export type State={schema:'large-import-complete-review/v1';job:Job;capability:{existing_updates:boolean;independent_creates:boolean;dependency_groups:false};
 phase:'unavailable'|'blocked'|'planning'|'reviewable'|'approved'|'partial'|'complete'|'unknown';reasons:string[];scope:Scope|null;
 unknown:null|{id:string;batch:number;preview_id:string;scope_hash:string;client_key:string};};
/** Proposed AUTHENTICATED ports; no current route or matching installed coordinator method exists. */
export type ResolutionAck={resolved:true;outcome:'committed'|'definitively-refused'|'prepared'|'approved';witness:Witness};
export type ContinuationFence=()=>void;
export type Ports={resolveExact(jobId:string,command:Command,current?:ContinuationFence):Promise<ResolutionAck>;inspect(jobId:string):Promise<State>;revalidateReview(jobId:string,scopeHash:string,current?:ContinuationFence):Promise<unknown>;prepare(jobId:string,sourcePlanHash:string,current?:ContinuationFence):Promise<unknown>;approve(jobId:string,scopeHash:string,confirmed:true,current?:ContinuationFence):Promise<unknown>;executeBatch(jobId:string,scopeHash:string,batch:number,previewId:string,nativeScope:string,confirmed:true,current?:ContinuationFence):Promise<unknown>;retryUnknown(jobId:string,attempt:NonNullable<State['unknown']>,current?:ContinuationFence):Promise<ResolutionAck>};
export type Command={kind:'revalidate';scopeHash:string}|{kind:'prepare';sourcePlanHash:string}|{kind:'approve';scopeHash:string}|{kind:'execute';scopeHash:string;batch:number;previewId:string;nativeScope:string}|{kind:'retry_durable';attempt:NonNullable<State['unknown']>};
type Attempt={context:Context;jobId:string;command:Command;flight:boolean;sent:boolean};
const slots=new Map<string,Attempt>(),listeners=new Set<()=>void>(),key=(c:Context)=>JSON.stringify([c.tenantId,c.userId,c.apiKeyId]);
const emit=()=>{for(const f of listeners)f();};
export const custody={subscribe(f:()=>void){listeners.add(f);return()=>{listeners.delete(f);};},get(c:Context){return slots.get(key(c));},claim(c:Context,id:string,command:Command){if(slots.has(key(c)))throw Error('Nierozstrzygnięta próba pełnego planu');const a={context:{...c},jobId:id,command:structuredClone(command),flight:true,sent:false};slots.set(key(c),a);emit();return a;},owns(a:Attempt){return slots.get(key(a.context))===a;},release(a:Attempt){if(this.owns(a)){slots.delete(key(a.context));emit();}},changed:emit};
export const completeReviewLocked=(c:Context)=>!!custody.get(c);
const need=(v:unknown,m:string):void=>{if(!v)throw Error(m);},hex=(v:string)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=(v:string)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const same=(a:unknown,b:unknown):boolean=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
function sorted(v:unknown):unknown{if(Array.isArray(v))return v.map(sorted);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted((v as Record<string,unknown>)[k])]));return v;}
function witness(r:Witness){need(r&&typeof r.id==='string'&&r.id.length>0&&hex(r.sha256)&&Number.isSafeInteger(r.byte_count)&&r.byte_count>=0,'Brak natywnego dowodu');}
/** Fresh read witnesses can differ; native body/keys/cursors are exact and every witness is validated separately. */
function previewBusiness(p:NativeBatch['preview']|undefined){return p?{ack:{head:p.ack.head,reused:p.ack.reused},pages:p.pages.map(page=>({head:page.head,rows:page.rows,next:page.next}))}:null;}
export function decodeState(s:State,c:Context,id:string):State{
 need(s?.schema==='large-import-complete-review/v1','Brak kontraktu pełnego przeglądu');validateJob(s.job,c,id);
 need(s.capability&&typeof s.capability.existing_updates==='boolean'&&typeof s.capability.independent_creates==='boolean'&&s.capability.dependency_groups===false,'Brak gwarantowanej funkcji planu');
 need(['unavailable','blocked','planning','reviewable','approved','partial','complete','unknown'].includes(s.phase)&&Array.isArray(s.reasons)&&s.reasons.every(r=>typeof r==='string'),'Nieprawidłowy stan przeglądu');
 if(['unavailable','blocked','planning'].includes(s.phase)){need(s.scope===null&&s.unknown===null,'Odmowa nie może sugerować zgody');return s;}
 need(s.job.approved&&s.capability.existing_updates&&s.scope,'Pełny natywny przegląd nie jest dostępny');const p=s.scope!;
 need(p.schema==='large-import-core-review/v1'&&Number.isSafeInteger(p.revision)&&p.revision>=0&&hex(p.aggregate_scope_hash)&&p.source_plan_hash===s.job.plan_hash&&same(p.raw,s.job.raw)&&same(p.parsing_spec,s.job.parsing_spec),'Plan jest inny niż zachowany plik');
 need(p.batches.length===s.job.manifest.total_batches,'Nie odczytano wszystkich partii');
 let ordinal=0;const productIds=new Set<string>(),previewIds=new Set<string>(),owners=new Map<string,number>(),links:{batch:number;target:string}[]=[];
 for(const[n,b]of p.batches.entries()){
  need(b.index===n&&uuid(b.preview_id)&&hex(b.scope_hash)&&uuid(b.preview_key)&&uuid(b.execute_key)&&!previewIds.has(b.preview_id),'Niepełna tożsamość podglądów');previewIds.add(b.preview_id);
  need(b.preview_key===s.job.core[n].previewKey&&b.execute_key===s.job.core[n].executeKey&&hex(b.request_hash)&&hex(b.rows_hash)&&same(previewBusiness(b.preview),previewBusiness(s.job.core[n].preview)),'Podgląd nie odpowiada trwałym kluczom i stronom zadania');
  need(b.eligibility&&typeof b.eligibility.eligible==='boolean'&&typeof b.eligibility.authority_revision==='string'&&b.eligibility.authority_revision.length>0&&hex(b.eligibility.source_hash)&&Array.isArray(b.eligibility.sources)&&b.eligibility.sources.length>0,'Brak rzeczywistego odczytu źródła i uprawnień');b.eligibility.sources.forEach(witness);witness(b.eligibility.quota_witness);
  const {content:_content,client_key:_key,...config}=s.job.core[n].request;const head=b.preview.ack.head;need(same(head.config,config),'Inna konfiguracja natywnego podglądu');need(head.id===b.preview_id&&head.scope_hash===b.scope_hash&&head.actor_id===c.userId&&head.total===s.job.manifest.batches[n].rows&&head.ready===true,'Inny lub odrzucony podgląd partii');witness(b.preview.ack.witness);
  need(Array.isArray(b.preview.pages)&&b.preview.pages.length>0&&b.preview.pages.length<=5,'Niepełne natywne strony');let count=0;const rows=b.preview.pages.flatMap((page,position)=>{witness(page.witness);need(same(page.head,head)&&page.rows.length>0&&page.rows.length<=100,'Niepełne natywne strony');count+=page.rows.length;need(position===b.preview.pages.length-1?page.next===null:page.next===String(count)&&count<head.total,'Nieprawidłowy pełny ciąg stron');return page.rows;});
  need(rows.length===head.total&&b.resolution.length===rows.length,'Niepełny zakres podglądu');
  for(const[r,row]of rows.entries()){
   const resolved=b.resolution[r];need(row.index===r&&row.identity_value===s.job.core[n].identities[r]&&Array.isArray(row.errors)&&row.errors.length===0&&resolved.ordinal===ordinal++&&['create','update','unchanged'].includes(resolved.operation)&&row.operation===resolved.operation&&uuid(resolved.product_id)&&row.product_id===resolved.product_id&&!productIds.has(resolved.product_id),'Nowy, zależny lub powtórzony produkt wymaga osobnego natywnego planu grupowego');productIds.add(resolved.product_id);owners.set(resolved.product_id,n);
   const before=row.before as {id?:unknown}|null,after=row.after as {id?:unknown}|null;need(after&&after.id===resolved.product_id,'Projekcja ma inny przydzielony produkt');
   const full=after as {id?:unknown;parent_id?:unknown;components?:{product_id?:unknown}[]};need(Array.isArray(full.components),'Niepełna projekcja zależności');if(full.parent_id!==null&&full.parent_id!==undefined){need(uuid(full.parent_id as string),'Nieprawidłowy rodzic');links.push({batch:n,target:full.parent_id as string});}for(const part of full.components!){need(part&&uuid(part.product_id as string),'Nieprawidłowy składnik');links.push({batch:n,target:part.product_id as string});}
   if(resolved.operation==='create')need(s.capability.independent_creates&&before===null&&row.resolved_product_id===null,'Nowy produkt nie ma gwarantowanego natywnego podglądu');
   else{need(before&&before.id===resolved.product_id&&row.resolved_product_id===resolved.product_id,'Brak rzeczywistego istniejącego produktu');}
  }
 }
 for(const link of links)need(!owners.has(link.target)||owners.get(link.target)===link.batch,'Zależność między partiami wymaga osobnego natywnego planu');
 need(ordinal===s.job.manifest.records,'Brak pełnego zakresu pliku');
 const prefix=s.job.core.findIndex(b=>!b.execution),committed=prefix<0?s.job.core.length:prefix;need(s.job.core.slice(committed).every(b=>!b.execution),'Zapisane partie nie tworzą trwałego prefiksu');
 if(s.phase==='partial')need(committed>0&&committed<s.job.core.length,'Nieprawidłowy częściowy postęp');if(s.phase==='complete')need(committed===s.job.core.length,'Nie potwierdzono zapisu całego zakresu');if(s.phase==='approved')need(committed===0,'Zapisany zakres wymaga jawnego częściowego stanu');
 need(p.approved_scope_hash===null||p.approved_scope_hash===p.aggregate_scope_hash,'Zgoda dotyczy innego pełnego planu');
 if(s.phase==='approved')need(p.approved_scope_hash===p.aggregate_scope_hash,'Brak zapisanej zgody na cały plan');
 if(s.phase==='reviewable')need(p.approved_scope_hash===null&&!s.unknown&&s.job.core.every(b=>!b.execution),'Podgląd przed zapisem zawiera zapis lub nierozstrzygniętą próbę');
 if(s.unknown)need(uuid(s.unknown.id)&&Number.isSafeInteger(s.unknown.batch)&&s.unknown.batch>=0&&s.unknown.batch<p.batches.length&&s.unknown.preview_id===p.batches[s.unknown.batch].preview_id&&s.unknown.scope_hash===p.batches[s.unknown.batch].scope_hash&&s.unknown.client_key===p.batches[s.unknown.batch].execute_key,'Nierozstrzygnięta próba ma inny klucz');
 need((s.phase==='unknown')===!!s.unknown,'Nierozstrzygnięty stan wymaga dokładnej próby');return s;
}
export function canApprove(s:State){return (s.phase==='reviewable'||s.phase==='partial'&&s.scope?.approved_scope_hash===null)&&s.capability.existing_updates&&!!s.scope&&s.scope.batches.every(b=>b.eligibility.eligible===true)&&!s.unknown;}
export function commandGuard(s:State,command:Command){
 if(command.kind==='retry_durable'){need(s.unknown&&JSON.stringify(s.unknown)===JSON.stringify(command.attempt),'Dokładne ponowienie jest inne');return;}
 need(!s.unknown,'Najpierw rozstrzygnij wcześniejszą próbę');
 if(command.kind==='revalidate'){need(s.scope?.aggregate_scope_hash===command.scopeHash,'Inny zachowany zakres');return;}
 if(command.kind==='prepare'){need(s.job.approved&&s.capability.existing_updates&&command.sourcePlanHash===s.job.plan_hash&&!s.job.core.some(b=>b.execution),'Nie można udawać przeglądu przed wcześniejszym zapisem');return;}
 need(s.scope?.aggregate_scope_hash===command.scopeHash&&s.scope.batches.every(b=>b.eligibility.eligible===true),'Natywny plan lub źródła są już nieaktualne');
 if(command.kind==='approve'){need(canApprove(s),'Nie można zatwierdzić niepełnego planu');return;}
 need(s.scope!.approved_scope_hash===command.scopeHash,'Brak zgody na pełny plan');const b=s.scope!.batches[command.batch];need(b&&b.preview_id===command.previewId&&b.scope_hash===command.nativeScope&&!s.job.core[command.batch].execution&&s.job.core.slice(0,command.batch).every(c=>c.execution),'Partia nie należy do zatwierdzonego zakresu');
}
export type Latest={context:Context;jobId:string;ports:Ports|null;canManage:boolean;externalWriteBlocked:boolean};
export type View={state:State|null;busy:boolean;error:string};
export class Controller{
 view:View={state:null,busy:false,error:''};private active=false;private generation=0;private listeners=new Set<()=>void>();
 constructor(private latest:()=>Latest){}snapshot=()=>this.view;subscribe(f:()=>void){this.listeners.add(f);return()=>{this.listeners.delete(f);};}activate(){if(!this.active){this.active=true;this.generation++;}}deactivate(){this.active=false;this.generation++;}
 private update(v:Partial<View>){this.view={...this.view,...v};for(const f of this.listeners)f();}
 private same(g:number,l:Latest){const c=this.latest();return this.active&&g===this.generation&&key(l.context)===key(c.context)&&l.jobId===c.jobId&&l.ports===c.ports;}
 private guard(g:number,l:Latest,a:Attempt){const c=this.latest();need(this.same(g,l)&&c.canManage&&!c.externalWriteBlocked&&!largeImportLocked(c.context)&&custody.owns(a),'Zakres lub uprawnienia do zapisu zostały zmienione');}
 async refresh(){const current=this.latest(),l={...current,context:{...current.context}},g=this.generation;if(!this.active||!l.ports)return;this.update({busy:true,error:''});try{const s=await l.ports.inspect(l.jobId);if(!this.active||g!==this.generation)return;need(this.same(g,l),'Inny zakres odczytu');decodeState(s,l.context,l.jobId);this.update({state:s,busy:false});}catch{if(this.active&&g===this.generation)this.update({state:null,busy:false,error:'Nie można odczytać całego planu. Sprawdź aktualne uprawnienia.'});}}
 async send(command:Command,retry=false){const current=this.latest(),l={...current,context:{...current.context}},g=this.generation;if(!this.active||!l.ports||!l.canManage||l.externalWriteBlocked||largeImportLocked(l.context))return;let a=custody.get(l.context);if(retry){if(!a||a.flight||a.jobId!==l.jobId)return;}else{if(a)return;a=custody.claim(l.context,l.jobId,command);}const own=a;own.flight=true;custody.changed();this.update({busy:true,error:''});try{this.guard(g,l,own);const s=decodeState(await l.ports.inspect(l.jobId),l.context,l.jobId);this.guard(g,l,own);if(!retry)commandGuard(s,own.command);this.update({state:s});this.guard(g,l,own);own.sent=true;if(retry){const resolved=await l.ports.resolveExact(l.jobId,structuredClone(own.command),()=>this.guard(g,l,own));need(resolved?.resolved===true&&['committed','definitively-refused','prepared','approved'].includes(resolved.outcome),'Próba nadal nierozstrzygnięta');witness(resolved.witness);}else switch(own.command.kind){case'revalidate':await l.ports.revalidateReview(l.jobId,own.command.scopeHash,()=>this.guard(g,l,own));break;case'prepare':await l.ports.prepare(l.jobId,own.command.sourcePlanHash,()=>this.guard(g,l,own));break;case'approve':await l.ports.approve(l.jobId,own.command.scopeHash,true,()=>this.guard(g,l,own));break;case'execute':await l.ports.executeBatch(l.jobId,own.command.scopeHash,own.command.batch,own.command.previewId,own.command.nativeScope,true,()=>this.guard(g,l,own));break;case'retry_durable':{const resolved=await l.ports.retryUnknown(l.jobId,structuredClone(own.command.attempt),()=>this.guard(g,l,own));need(resolved?.resolved===true,'Próba nadal nierozstrzygnięta');witness(resolved.witness);}}custody.release(own);if(this.active&&g===this.generation){this.update({busy:false});await this.refresh();}}catch{if(custody.owns(own)){own.flight=false;if(!own.sent)custody.release(own);else custody.changed();}if(this.active&&g===this.generation)this.update({state:null,busy:false,error:own.sent?'Wynik niepotwierdzony. Zachowaj dokładną próbę; nie uruchamiaj nowego zapisu.':'Plan lub uprawnienia nie pozwalają na zapis.'});}}
}
