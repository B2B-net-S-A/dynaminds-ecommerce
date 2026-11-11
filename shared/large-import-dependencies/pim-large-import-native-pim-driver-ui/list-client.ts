/** Cookie-only browser GET; no Actor/credential storage, polling or mount side effects. */
import type {DoneCorePage} from './list-contract';
import type {Scope,FetchPort} from '../pim-large-import-http-binding-ui/browser';
export function createDoneCoreJobListClient(latest:()=>Scope,fetchPort:FetchPort=(url,init)=>fetch(url,init)){
 let alive=true,generation=0;const active=new Set<AbortController>();
 const uuid=(v:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))throw Error('Nieprawidłowy identyfikator');return v;};
 const scopeKey=(s:Scope)=>JSON.stringify([s.context.tenantId,s.context.userId,s.context.apiKeyId,s.catalogId]);
 return {destroy(){alive=false;generation++;for(const c of active)c.abort();active.clear();},async list(limit=20,cursor?:string,signal?:AbortSignal):Promise<DoneCorePage>{
  const s=structuredClone(latest()),g=generation;let ownedSignal:AbortSignal|undefined;const check=()=>{const n=latest();if(signal?.aborted||ownedSignal?.aborted||!alive||g!==generation||scopeKey(s)!==scopeKey(n)||!n.available||!n.canManage)throw Error('Zakres listy został zmieniony');};check();if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw Error('Nieprawidłowy rozmiar strony');
  const c=new AbortController(),cancel=()=>c.abort();ownedSignal=c.signal;active.add(c);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)c.abort();
  try{const query=new URLSearchParams({limit:String(limit),...(cursor?{cursor}:{})}),r=await fetchPort('/api/product-catalogs/'+uuid(s.catalogId)+'/large-import/jobs?'+query,{method:'GET',credentials:'same-origin',headers:{'X-Workspace-ID':uuid(s.context.tenantId)},signal:c.signal});check();const raw=await r.text();check();if(new TextEncoder().encode(raw).length>1048576)throw Error('Strona listy przekracza limit');const value=JSON.parse(raw);if(!r.ok)throw Error(value.detail??'Nie można odczytać własnych zadań');
   if(value.schema!=='large-import-owned-done-core-list/v1'||value.catalog_id!==s.catalogId||!Array.isArray(value.items)||value.items.length>limit||(value.next!==null&&typeof value.next!=='string'))throw Error('Nieprawidłowa pełna lista');
   for(const item of value.items){uuid(item.id);if(item.catalog_id!==s.catalogId||!Number.isSafeInteger(item.revision)||item.revision<0||!/^[a-f0-9]{64}$/.test(item.state_sha256)||!/^[a-f0-9]{64}$/.test(item.plan_hash)||!Array.isArray(item.executions)||item.executions.length!==item.batches)throw Error('Niepełny opis zadania');}return value;
  }finally{active.delete(c);signal?.removeEventListener('abort',cancel);}
 }};
}
