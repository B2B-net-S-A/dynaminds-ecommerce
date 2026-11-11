/** Browser RAM custody. No automatic POST, storage, credential or crypto imports. */
import * as M from './manual-inventory-off-model';
export type Transport=(path:string,method?:string,body?:unknown)=>Promise<any>;
type Attempt={kind:'preview'|'apply';path:string;body:string;source:M.Source;preview?:M.Preview};
export type View={busy:boolean;error:string;source:M.Source|null;preview:M.Preview|null;receipt:M.Receipt|null;consent:boolean;canApply:boolean;pending:Attempt|null;product:string;warehouse:string;historical:boolean;history:M.Receipt[];nextCursor:string|null};
const entries=new Map<string,View>(),contexts=new Map<string,M.Context>(),listeners=new Set<()=>void>();
const key=(c:M.Context)=>JSON.stringify(c);
const fresh=():View=>({busy:false,error:'',source:null,preview:null,receipt:null,consent:false,canApply:false,pending:null,product:'',warehouse:'',historical:false,history:[],nextCursor:null});
function emit(){for(const cb of listeners)cb();}
export function manualOffLocked(c:M.Context){return[...entries].some(([k,v])=>contexts.get(k)?.tenant_id===c.tenant_id&&(v.busy||v.pending!==null));}
export function subscribeManualOffLock(c:M.Context,cb:(locked:boolean)=>void){const run=()=>cb(manualOffLocked(c));listeners.add(run);run();return()=>{listeners.delete(run);};}
export function manualOffController(c:M.Context,api:Transport,newKey:()=>string){
 const k=key(c);contexts.set(k,{...c});if(!entries.has(k))entries.set(k,fresh());const v=entries.get(k)!;
 function purgeVisible(){v.source=null;v.preview=null;v.receipt=null;v.history=[];v.nextCursor=null;v.consent=false;v.canApply=false;v.historical=false;emit();}
 async function identity(){const me=await api('/auth/me');if(!(me?.user?.id===c.user_id&&me?.user?.tenant_id===c.tenant_id&&me?.user?.role===c.role&&me?.restore_preview===c.read_only)){purgeVisible();M.requireOk(false,'Konto, organizacja lub tryb kopii zmieniły się');}}
 async function sourceRead(product=v.product,warehouse=v.warehouse){await identity();const r=await api('/inventory/manual-corrections/source?'+new URLSearchParams({product_id:product,warehouse_id:warehouse}));await identity();M.flags(r,c);const s=M.source(r.source,product,warehouse);v.source=s;v.product=product;v.warehouse=warehouse;v.consent=false;v.canApply=false;if(v.preview)v.historical=!M.same(v.preview.source,s);emit();return s;}
 async function detail(p:M.Preview){await identity();const r=await api('/inventory/manual-corrections/previews/'+p.id);await identity();M.flags(r,c);M.requireOk(typeof r.can_apply==='boolean');const next=M.preview(r.preview,p.request,p.source);M.requireOk(M.same({...next,receipt_id:p.receipt_id},p));v.canApply=r.can_apply&&r.preview.receipt_id===null&&!c.read_only&&c.role==='admin'&&!!v.source&&M.same(v.source,p.source);v.consent=false;emit();return r;}
 async function run(work:()=>Promise<void>){M.requireOk(!v.busy,'Poprzednia próba nadal trwa');v.busy=true;v.error='';emit();try{await work();}catch(e){v.error=e instanceof Error?e.message:'Nie udało się potwierdzić wyniku';if((e as{status?:number})?.status===401||(e as{status?:number})?.status===403){purgeVisible();}throw e;}finally{v.busy=false;emit();}}
 async function send(a:Attempt){
  await identity();let r:any;try{r=await api(a.path,'POST',JSON.parse(a.body));}catch(e){if([400,401,403,404,409,413,422,423].includes((e as{status:number}).status)){v.pending=null;v.consent=false;v.canApply=false;emit();}throw e;}await identity();M.flags(r,c);M.requireOk(typeof r.reused==='boolean');
  if(a.kind==='preview'){const p=M.preview(r.preview,JSON.parse(a.body),a.source);M.requireOk(typeof r.can_apply==='boolean');v.preview=p;v.receipt=null;await sourceRead();await detail(p);v.historical=!M.same(v.source,p.source);}
  else{M.requireOk(a.preview);const receipt=M.receipt(r.receipt,a.preview,JSON.parse(a.body));v.receipt=receipt;v.preview=a.preview;await sourceRead();v.historical=true;v.canApply=false;}
  // A valid ACK is retained until the complete current source readback succeeds.
  v.pending=null;v.consent=false;emit();
 }
 return{view:()=>structuredClone(v),subscribe(cb:()=>void){listeners.add(cb);return()=>{listeners.delete(cb);};},
  select(product:string,warehouse:string){M.requireOk(!v.pending&&!v.busy,'Najpierw rozstrzygnij dokładną próbę');Object.assign(v,fresh(),{product,warehouse});emit();},
  read(){return run(async()=>{const s=await sourceRead();if(v.preview)await detail(v.preview);M.requireOk(s);});},
  preview(form:{location:string;delta:string;note:string}){return run(async()=>{M.requireOk(!v.pending&&!c.read_only&&c.role==='admin');const s=await sourceRead();const body=M.request(s,form,newKey());const a:Attempt={kind:'preview',path:'/inventory/manual-corrections/previews',body:JSON.stringify(body),source:s};v.pending=a;emit();await send(a);});},
  consent(value:boolean){M.requireOk(!v.busy&&!v.pending&&v.canApply);v.consent=value;emit();},
  apply(){return run(async()=>{M.requireOk(!v.pending&&v.consent&&v.canApply&&v.preview&&!c.read_only&&c.role==='admin');const p=structuredClone(v.preview);await sourceRead();await detail(p);M.requireOk(v.canApply,'Podgląd utracił aktualność — przygotuj nowy');const body={client_key:newKey(),scope_hash:p.scope_hash,confirmed:true};const a:Attempt={kind:'apply',path:'/inventory/manual-corrections/previews/'+p.id+'/apply',body:JSON.stringify(body),source:p.source,preview:p};v.pending=a;v.consent=false;emit();await send(a);});},
  retry(){return run(async()=>{M.requireOk(v.pending&&!c.read_only&&c.role==='admin');const a=structuredClone(v.pending);await sourceRead();await send(a);});},
  history(more=false){return run(async()=>{await identity();const q=new URLSearchParams({limit:'50'});if(v.product)q.set('product_id',v.product);if(v.warehouse)q.set('warehouse_id',v.warehouse);if(more){M.requireOk(v.nextCursor);q.set('after',v.nextCursor);}const r=await api('/inventory/manual-corrections/receipts?'+q);await identity();M.flags(r,c);M.requireOk(Array.isArray(r.data)&&r.data.length<=50&&(r.next_cursor===null||typeof r.next_cursor==='string'));const parsed=r.data.map(M.historyReceipt);for(const row of parsed)M.requireOk((!v.product||row.request.product_id===v.product)&&(!v.warehouse||row.request.warehouse_id===v.warehouse));const all=more?[...v.history,...parsed]:parsed;M.requireOk(new Set(all.map((x:M.Receipt)=>x.id)).size===all.length);v.history=all;v.nextCursor=r.next_cursor;emit();});},
  clearPreview(){M.requireOk(!v.pending&&!v.busy);v.preview=null;v.receipt=null;v.consent=false;v.canApply=false;emit();}
 };
}
