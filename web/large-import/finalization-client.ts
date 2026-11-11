/** Browser-only exact completion routes. No replay, storage, token or provider transport. */
import {ImportHttpError,type FetchPort,type Scope} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/browser';
import {decodeFinalizationAck,type FinalizationInput} from './finalization-model';
const same=(a:Scope,b:Scope)=>a.catalogId===b.catalogId&&a.jobId===b.jobId&&a.context.tenantId===b.context.tenantId&&a.context.userId===b.context.userId&&a.context.apiKeyId===b.context.apiKeyId;
const uuid=(s:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s))throw Error('Nieprawidłowy identyfikator zakończenia importu.');return s;};
export function createFinalizationClient(latest:()=>Scope,fetchPort:FetchPort=(url,init)=>fetch(url,init)){
 let live=true,generation=0;const active=new Set<AbortController>();
 async function request(id:string,method:'GET'|'POST',body?:FinalizationInput){
  const s=structuredClone(latest()),g=generation,c=new AbortController();uuid(s.catalogId);uuid(id);uuid(s.context.tenantId);uuid(s.context.userId);
  const guard=()=>{const now=latest();if(!live||generation!==g||!same(now,s)||s.jobId!==id||!now.available||!now.canManage||now.context.apiKeyId!==null||method==='POST'&&now.externalWriteBlocked)throw Error('Zmienił się użytkownik, katalog lub dostęp do zakończenia importu.');};
  const value=body===undefined?undefined:structuredClone(body);guard();active.add(c);
  try{const response=await fetchPort('/api/product-catalogs/'+s.catalogId+'/large-import/jobs/'+id+(method==='GET'?'/finalization':'/finalize'),{method,credentials:'same-origin',headers:{'X-Workspace-ID':s.context.tenantId,...(value===undefined?{}:{'Content-Type':'application/json'})},signal:c.signal,...(value===undefined?{}:{body:JSON.stringify(value)})});guard();const text=await response.text();guard();if(new TextEncoder().encode(text).length>65536)throw Error('Odpowiedź zakończenia importu przekracza limit.');const raw=JSON.parse(text);
   if(!response.ok){if(raw?.code==='MFA_REQUIRED'&&typeof window!=='undefined')window.dispatchEvent(new CustomEvent('dyna:mfa-required',{detail:{workspace:s.context.tenantId}}));throw new ImportHttpError(response.status,typeof raw?.detail==='string'?raw.detail:'Nie można potwierdzić zakończenia importu.',raw?.code);}return raw;
  }finally{active.delete(c);}
 }
 return{inspect:(id:string)=>request(id,'GET'),finalize:async(id:string,input:FinalizationInput)=>{const expected=structuredClone(input);return decodeFinalizationAck(await request(id,'POST',expected),id,expected);},deactivate(){live=false;generation++;for(const c of active)c.abort();},activate(){if(!live){live=true;generation++;}}};
}
