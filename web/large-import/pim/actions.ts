/** Durable PIM only: every mutation uses the owned job endpoint, never a direct native write. */
import type {LargeImportHttp} from '../../../shared/large-import-dependencies/pim-large-import-http-binding-ui/browser';
import type {Job} from '../../../shared/large-import-dependencies/pim-large-import-http-binding-ui/contracts';
import type {PimContext,PimTransport} from '../../pim/editor';
import {largeImportCustody,type Actions,type Attempt} from '../../../shared/large-import-dependencies/pim-large-import-job-flow-ui2/model';
import {need,same} from '../../pim/legacy-files/handoff';
import {decodeDictionary,decodeProduct,toRow,decodePreview} from '../../pim/batch/model';
import {committedCustody,stageRead,previewRead} from './model';
export type Latest={job:Job;context:PimContext;catalogId:string;nestedAvailable:boolean;blocked:boolean;active:boolean;generation:number};
const created=new WeakMap<Attempt,{number:number;mapping:unknown}>();
const principal=(c:PimContext)=>({tenantId:c.tenant_id,userId:c.user_id,apiKeyId:null});
export function createPimJobActions(http:LargeImportHttp,transport:PimTransport,latest:()=>Latest,onAccessLost:()=>void=()=>{}):Actions{
 async function access<T>(p:Promise<T>):Promise<T>{const captured=latest(),g=captured.generation,context=structuredClone(captured.context),id=captured.job.id;try{return await p;}catch(e){const current=latest();if(current.active&&current.generation===g&&current.job.id===id&&same(current.context,context)&&[401,403,404].includes((e as {status?:number})?.status??0))onAccessLost();throw e;}}
 const fence=(start:Latest)=>{const n=latest();need(n.active&&n.generation===start.generation&&n.job.id===start.job.id&&same(n.context,start.context)&&n.catalogId===start.catalogId&&n.nestedAvailable===start.nestedAvailable&&!n.blocked&&!n.context.restore_preview&&n.context.role==='admin','Zakres lub dostęp do parametrów uległy zmianie');};
 async function identity(start:Latest){const raw:any=await access(transport('/auth/me'));fence(start);if(raw?.user?.id!==start.context.user_id||raw?.user?.tenant_id!==start.context.tenant_id||raw?.user?.role!==start.context.role||raw?.restore_preview!==start.context.restore_preview){onAccessLost();throw Error('Tożsamość lub uprawnienia uległy zmianie');}}
 async function before(id:string,n:number,kind:'stage'|'preview'|'apply'){
  const start={...latest(),context:structuredClone(latest().context)};fence(start);need(start.job.id===id,'Inne bieżące zadanie');const c=committedCustody(start.job,principal(start.context),n,start.catalogId),a=start.job.pim[n]?.at(-1);need(a,'Brak trwałej próby mapowania');if((a.mapping as any)?.schema==='legacy-pim-mapping/v2')need(start.nestedAvailable,'Obsługa struktur uległa zmianie');await identity(start);if(kind==='stage')return;
  const d=decodeDictionary(await access(transport('/product-catalogs/'+start.catalogId+'/pim/dictionary')),start.catalogId);fence(start);const s=stageRead(start.job,n,c,d);need(s?.request,'Cała mapa musi przejść sprawdzenie');
  const pending=largeImportCustody.get(principal(start.context));const exactReplay=!!pending&&pending.sent&&pending.jobId===id&&((kind==='preview'&&pending.command.kind==='preview_pim'&&a.previewAttempted)||(kind==='apply'&&pending.command.kind==='apply_pim'&&a.applyAttempted));
  if(!exactReplay){for(const original of s.sources){const fresh=decodeProduct(await access(transport('/product-catalogs/'+start.catalogId+'/pim/products/'+original.product_id)),d,original.product_id);fence(start);need(same(toRow(fresh),toRow(original)),'Produkt zmienił się. Przygotuj nowe mapowanie i osobny podgląd.');}
   if(kind==='apply'){const preview=previewRead(start.job,n,s);need(preview,'Brak trwałego pełnego podglądu');const fresh=decodePreview(await access(transport('/product-catalogs/'+start.catalogId+'/pim/previews/'+preview.id)),s.request,start.catalogId,start.context.user_id);fence(start);need(fresh.ready&&fresh.can_apply&&!fresh.operation_id&&fresh.scope_hash===preview.scope_hash,'Podgląd jest historyczny lub niedostępny');}}
  await identity(start);
 }
 const unused=async()=>{throw Error('Ten formularz nie wykonuje zapisów Core ani zgody na plik');};
 return {inspect:async id=>{const start=latest();const j=await access(http.inspect(id));fence(start);return j;},approve:unused,previewCore:unused,consentCore:unused,executeCore:unused,
 async newPimAttempt(id,n,mapping){const start={...latest(),context:structuredClone(latest().context)};fence(start);committedCustody(start.job,principal(start.context),n,start.catalogId);if((mapping as any)?.schema==='legacy-pim-mapping/v2')need(start.nestedAvailable,'Obsługa struktur uległa zmianie');await identity(start);const owned=largeImportCustody.get(principal(start.context));need(owned?.jobId===id&&owned.command.kind==='new_pim'&&same(owned.command.mapping,mapping),'Brak oryginalnej próby mapowania');const previous=created.get(owned);
  if(previous){const rows=start.job.pim[n]??[];const saved=rows[previous.number];need(rows.length===previous.number+1&&saved?.number===previous.number&&same(saved.mapping,previous.mapping),'Niepotwierdzona próba nie ma trwałego potwierdzenia. Odczytaj ponownie; nie tworzymy nowej próby.');return structuredClone(saved);}
  created.set(owned,{number:(start.job.pim[n]??[]).length,mapping:structuredClone(mapping)});return access(http.newPimAttempt(id,n,mapping));
 },stagePim:async(id,n)=>{await before(id,n,'stage');return access(http.stagePim(id,n));},previewPim:async(id,n)=>{await before(id,n,'preview');return access(http.previewPim(id,n));},consentPim:async(id,n,p,h)=>{await before(id,n,'apply');return access(http.consentPim(id,n,p,h,true));},applyPim:async(id,n)=>{await before(id,n,'apply');return access(http.applyPim(id,n,true));}};
}
