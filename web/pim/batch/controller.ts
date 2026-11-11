/** Synthetic-testable intended controller. Transport is injected; no app/network imports. */
import type {Dictionary,ProductRow,ProductSource,Preview,Operation,Value} from '../dictionaries/contract2';
import {pimEditorCustody,pimEditorLocked,subscribePimEditorLock,type PimContext,type PimTransport,type PimAttempt} from '../editor';
import {buildRequest,decodeDictionary,decodeProduct,decodePreview,decodeOperation,need,selectedIds,same,toRow,setCategory,setValue,uuid} from './model';
export {pimEditorLocked,subscribePimEditorLock};
export type BatchView={dictionary:Dictionary|null;sources:ProductSource[];rows:ProductRow[];preview:Preview|null;receipt:Operation|null;consent:boolean;busy:boolean;error:string};
const empty=():BatchView=>({dictionary:null,sources:[],rows:[],preview:null,receipt:null,consent:false,busy:false,error:''});
export class PimBatchController{
 readonly ids:string[];readonly target:string;readonly base:string;
 view:BatchView=empty();private alive=true;private generation=0;private blocked=false;private changed:(()=>void)|undefined;private listeners=new Set<()=>void>();
 constructor(readonly context:PimContext,readonly catalogId:string,ids:readonly string[],readonly transport:PimTransport){need(uuid.test(catalogId)&&uuid.test(context.user_id)&&uuid.test(context.tenant_id)&&typeof context.restore_preview==='boolean');this.ids=selectedIds(ids);this.target='batch:'+this.ids.join(',');this.base='/product-catalogs/'+encodeURIComponent(catalogId)+'/pim';}
 configure(blocked:boolean,changed?:()=>void){this.blocked=blocked;this.changed=changed;}
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 snapshot=()=>this.view;
 private update(p:Partial<BatchView>){if(this.alive){this.view={...this.view,...p};this.listeners.forEach(f=>f());}}
 pending(){return pimEditorCustody.get(this.context,this.catalogId,this.target);}
 locked(){return pimEditorLocked(this.context);}
 private authority(){need(this.alive&&!this.blocked&&!this.context.restore_preview&&this.context.role==='admin','Zapis jest zablokowany lub zakres uległ zmianie');}
 private writable(d:Dictionary,s:ProductSource[]){this.authority();need(d.available&&!d.read_only&&d.can_manage&&s.every(x=>x.available&&!x.read_only&&x.can_manage),'Co najmniej jeden produkt jest niedostępny do zapisu');}
 private readFailure(e:unknown){if([401,403,404].includes((e as {status?:number}).status??0)){this.view=empty();}this.update({error:(e as Error).message});}
 private async identity(){const r:any=await this.transport('/auth/me');need(this.alive,'Zakres uległ zmianie');if(r?.user?.tenant_id!==this.context.tenant_id||r?.user?.id!==this.context.user_id||r?.user?.role!==this.context.role||r?.restore_preview!==this.context.restore_preview){this.view=empty();this.listeners.forEach(f=>f());throw new Error('Tożsamość uległa zmianie');}}
 private async fresh(){const generation=this.generation;await this.identity();const d=decodeDictionary(await this.transport(this.base+'/dictionary'),this.catalogId);const sources:ProductSource[]=[];
  // Bounded sequential reads; selecting 500 is explicit, never an implicit catalog-wide fetch.
  for(const id of this.ids){sources.push(decodeProduct(await this.transport(this.base+'/products/'+encodeURIComponent(id)),d,id));need(this.alive&&generation===this.generation,'Zakres odczytu uległ zmianie');}
  await this.identity();need(this.alive&&generation===this.generation,'Zakres odczytu uległ zmianie');this.update({dictionary:d,sources});return{d,sources};}
 async load(){if(this.view.busy)return;const generation=++this.generation;this.update({busy:true,error:'',preview:null,consent:false});try{const s=await this.fresh();this.update({rows:s.sources.map(toRow)});}catch(e){if(this.generation===generation)this.readFailure(e);}finally{if(this.generation===generation)this.update({busy:false});}}
 private editable(){this.authority();need(!this.view.busy&&!this.locked()&&this.view.dictionary,'Arkusz jest zablokowany');this.writable(this.view.dictionary,this.view.sources);}
 category(productId:string,categoryId:string|null){this.editable();this.update({rows:setCategory(this.view.rows,productId,categoryId),preview:null,consent:false,error:''});}
 value(productId:string,definitionId:string,value:Value|null){this.editable();this.update({rows:setValue(this.view.rows,productId,definitionId,value),preview:null,consent:false,error:''});}
 replaceRows(rows:ProductRow[]){this.editable();need(this.view.dictionary);const checked=buildRequest(this.view.dictionary,this.view.sources,rows,crypto.randomUUID());this.update({rows:checked.rows,preview:null,consent:false,error:''});}
 consent(value:boolean){need(!this.view.busy&&!this.locked()&&this.canApply(),'Podgląd wymaga ponownego sprawdzenia');this.update({consent:value});}
 canApply(){const p=this.view.preview,d=this.view.dictionary;if(!p||!d||!p.ready||!p.can_apply||p.operation_id||!same(p.revision,d.revision)||this.blocked||this.context.restore_preview||this.context.role!=='admin'||!d.available||d.read_only||!d.can_manage)return false;return p.product_rows.every(x=>{const current=this.view.sources.find(s=>s.product_id===x.before.product_id);return current&&current.available&&!current.read_only&&current.can_manage&&same(toRow(current),toRow(x.before));});}
 async preview(){try{this.editable();need(this.view.dictionary);const request=buildRequest(this.view.dictionary,this.view.sources,this.view.rows,crypto.randomUUID());const a=pimEditorCustody.claim(this.context,this.catalogId,this.target,{kind:'preview',path:this.base+'/previews',body:request,request});await this.send(a);}catch(e){this.update({error:(e as Error).message});}}
 async apply(){try{this.authority();need(!this.view.busy&&!this.locked()&&this.canApply()&&this.view.consent&&this.view.preview,'Sprawdź podgląd i zaznacz osobną zgodę');const p=this.view.preview;const a=pimEditorCustody.claim(this.context,this.catalogId,this.target,{kind:'apply',path:this.base+'/previews/'+p.id+'/apply',body:{client_key:crypto.randomUUID(),scope_hash:p.scope_hash,confirmed:true},request:p.request,preview:p});await this.send(a);}catch(e){this.update({error:(e as Error).message});}}
 async retry(){const a=this.pending();if(a)await this.send(a);}
 private async send(a:PimAttempt){if(!pimEditorCustody.begin(this.context,this.catalogId,this.target,a))return;this.update({busy:true,error:'',consent:false});try{
  this.authority();const s=await this.fresh();this.writable(s.d,s.sources);need(pimEditorCustody.owns(this.context,this.catalogId,this.target,a)&&a.request.kind==='product_values');
  if(!a.sent){need(same(a.request.revision,s.d.revision),'Słownik zmienił się; odśwież arkusz');for(let i=0;i<a.request.rows.length;i++){const original=a.kind==='apply'?a.preview?.product_rows[i]?.before:a.request.rows[i];const current=s.sources.find(x=>x.product_id===original?.product_id);need(current&&original&&original.product_version===current.product_version&&original.state_version===current.state_version&&original.source_hash===current.source_hash,'Produkt zmienił się; odśwież arkusz');}}
  this.authority();a.sent=true;const raw=await this.transport(a.path,'POST',a.body);await this.identity();
  if(a.kind==='preview')this.update({preview:decodePreview(raw,a.request,this.catalogId,this.context.user_id)});
  else{need(a.preview);const receipt=decodeOperation(raw,a.preview,this.catalogId,this.context.user_id);this.update({receipt,preview:null});const current=await this.fresh();this.update({rows:current.sources.map(toRow)});this.changed?.();}
  pimEditorCustody.release(this.context,this.catalogId,this.target,a);
 }catch(e){const status=(e as {status?:number}).status;if(!a.sent||[400,401,403,404,409,413,422,423].includes(status??0))pimEditorCustody.release(this.context,this.catalogId,this.target,a);if(this.alive&&[401,403,404].includes(status??0)){this.view=empty();}this.update({error:(e as Error).message});}finally{pimEditorCustody.end(a);this.update({busy:false});}}
 async detail(){const old=this.view.preview;if(!old||this.view.busy)return;this.update({busy:true,consent:false,error:''});try{const s=await this.fresh();const p=decodePreview(await this.transport(this.base+'/previews/'+old.id),old.request as Extract<typeof old.request,{kind:'product_values'}>,this.catalogId,this.context.user_id);await this.identity();need(same(p.request,old.request)&&p.scope_hash===old.scope_hash&&same(p.product_rows,old.product_rows));this.update({preview:same(s.d.revision,p.revision)?p:{...p,can_apply:false}});}catch(e){this.readFailure(e);}finally{this.update({busy:false});}}
 activate(){if(!this.alive)this.view=empty();this.alive=true;}
 destroy(){this.alive=false;this.generation++;this.listeners.clear();}
}
