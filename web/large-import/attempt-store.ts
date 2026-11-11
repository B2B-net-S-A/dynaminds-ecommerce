import {compileCoreMapping} from './core-mapping';
/** Browser control-plane custody only. No auth credentials, source bytes, automatic network writes or native authority. */
import type {Context} from '../../shared/large-import-dependencies/pim-large-import-complete-file-review-ui2/model';
import type {Spec} from '../../shared/large-import-dependencies/pim-large-import-stream-foundation-ui2/stream';
import type {CoreConfig} from '../../shared/large-import-dependencies/pim-large-import-job-coordinator-backend5/native-batches';
export type Scope={context:Context;catalogId:string};
export type NativeConfirmation={revision:number;rawSha256:string;planHash:string;approved:boolean};
export type SavedAttempt={native?:NativeConfirmation;key:string;jobId:string;fileName:string;fileSize:number;spec:Spec;config:CoreConfig;phase:'retaining'|'retained'|'preparing'|'prepared'|'approving';sent:boolean;revision:number;createdAt:number;updatedAt:number};
export type HistoryEntry={key:string;jobId:string;fileName:string;archivedAt:number};
type Envelope={schema:'large-import-browser-attempt/v1';scope:Scope;pending:SavedAttempt|null;history:HistoryEntry[]};
export type RecordEntry={key:string;raw:string};
export type AtomicPort={load(key:string):Promise<string|null>;scan():Promise<RecordEntry[]>;atomic<T>(key:string,work:(raw:string|null,records:RecordEntry[])=>{raw:string;value:T}):Promise<T>};
const PREFIX='dyna:large-import-attempt:v1:',MAX_BYTES=16384,MAX_RECORDS=64,STALE_MS=7*86400000;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
function need(v:unknown,msg:string):asserts v{if(!v)throw Error(msg);}
function shape(x:unknown,keys:string[]):asserts x is Record<string,unknown>{need(x!==null&&typeof x==='object'&&!Array.isArray(x),'Nieprawidłowy zapis próby');need(Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k)),'Nieprawidłowy zakres zapisu próby');}
const bytes=(s:string)=>new TextEncoder().encode(s).byteLength;
export const scopeIdentity=(s:Scope)=>{need(uuid(s.context.tenantId)&&uuid(s.context.userId)&&(s.context.apiKeyId===null||uuid(s.context.apiKeyId))&&uuid(s.catalogId),'Nieprawidłowy zakres próby');return JSON.stringify([s.context.tenantId,s.context.userId,s.context.apiKeyId,s.catalogId]);};
export const storageKey=(s:Scope)=>PREFIX+scopeIdentity(s);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const immutable=(a:SavedAttempt)=>JSON.stringify([a.key,a.jobId,a.fileName,a.fileSize,a.spec,a.config,a.createdAt]);
function stamp(x:unknown,now:number){need(Number.isSafeInteger(x)&&Number(x)>0&&Number(x)<=now+60000,'Nieprawidłowy czas próby');}
export function validateSavedAttempt(x:unknown,s:Scope,now:number):SavedAttempt{
 shape(x,[...(x!==null&&typeof x==='object'&&Object.hasOwn(x,'native')?['native']:[]),'key','jobId','fileName','fileSize','spec','config','phase','sent','revision','createdAt','updatedAt']);
 need(uuid(x.key)&&uuid(x.jobId)&&typeof x.fileName==='string'&&x.fileName.length>0&&x.fileName.length<=120&&Number.isSafeInteger(x.fileSize)&&Number(x.fileSize)>0&&Number(x.fileSize)<=30000000,'Nieprawidłowe metadane pliku');
 need(Number.isSafeInteger(x.revision)&&Number(x.revision)>=0,'Nieprawidłowa rewizja próby');stamp(x.createdAt,now);stamp(x.updatedAt,now);need(Number(x.updatedAt)>=Number(x.createdAt)&&typeof x.sent==='boolean'&&['retaining','retained','preparing','prepared','approving'].includes(String(x.phase)),'Nieprawidłowy stan próby');
 const spec=x.spec;need(spec!==null&&typeof spec==='object'&&!Array.isArray(spec),'Nieprawidłowy format próby');
 if((spec as any).format==='csv'){shape(spec,['format','delimiter']);need([',',';','\t','|'].includes(String(spec.delimiter))&&Number(x.fileSize)<=5000000,'Nieprawidłowy format CSV');}
 else{shape(spec,['format','recordPath']);need(spec.format==='xml'&&typeof spec.recordPath==='string'&&spec.recordPath.length<=2048&&/^\/[A-Za-z_][\w.:-]*(?:\/[A-Za-z_][\w.:-]*)*$/.test(spec.recordPath),'Nieprawidłowa ścieżka XML');}
 const c=x.config;shape(c,['catalog_id','warehouse_id','currency','mode','identity','empty_policy','delimiter','mapping','ignore_readonly_fields','file_name']);
 need(c.catalog_id===s.catalogId&&uuid(c.warehouse_id)&&['PLN','EUR','USD','GBP','CZK'].includes(String(c.currency))&&['update','create','upsert'].includes(String(c.mode))&&c.identity==='sku'&&['skip','clear'].includes(String(c.empty_policy))&&[',',';','\t','|'].includes(String(c.delimiter))&&c.ignore_readonly_fields===false&&c.file_name===x.fileName,'Nieprawidłowa konfiguracja próby');
 if(spec.format==='csv')need(same(c.mapping,compileCoreMapping(c.mapping as Record<string,string>)),'Nieprawidłowe mapowanie zachowanej próby');else shape(c.mapping,[]);need(x.sent===true||x.phase==='retaining','Niewysłana próba ma inny stan');
 if(Object.hasOwn(x,'native')){const n=x.native;shape(n,['revision','rawSha256','planHash','approved']);need(x.sent===true&&Number.isSafeInteger(n.revision)&&Number(n.revision)>=0&&typeof n.rawSha256==='string'&&/^[a-f0-9]{64}$/.test(n.rawSha256)&&typeof n.planHash==='string'&&/^[a-f0-9]{64}$/.test(n.planHash)&&typeof n.approved==='boolean','Nieprawidłowe potwierdzenie oryginalnego zadania');}
 return structuredClone(x) as unknown as SavedAttempt;
}
function decode(raw:string,s:Scope,now:number):Envelope{
 need(bytes(raw)<=MAX_BYTES,'Zapis próby przekracza limit');let v:unknown;try{v=JSON.parse(raw);}catch{throw Error('Uszkodzony zapis próby; nie usunięto oryginalnego klucza');}
 shape(v,['schema','scope','pending','history']);need(v.schema==='large-import-browser-attempt/v1','Inna wersja zapisu próby');shape(v.scope,['context','catalogId']);shape(v.scope.context,['tenantId','userId','apiKeyId']);need(scopeIdentity(v.scope as Scope)===scopeIdentity(s),'Zapis należy do innego użytkownika lub katalogu');
 need(Array.isArray(v.history)&&v.history.length<=20,'Historia próby przekracza limit');for(const h of v.history){shape(h,['key','jobId','fileName','archivedAt']);need(uuid(h.key)&&uuid(h.jobId)&&typeof h.fileName==='string'&&h.fileName.length>0&&h.fileName.length<=120,'Nieprawidłowa historia próby');stamp(h.archivedAt,now);}
 const pending=v.pending===null?null:validateSavedAttempt(v.pending,s,now);return{schema:v.schema,scope:structuredClone(s),pending,history:structuredClone(v.history) as HistoryEntry[]};
}
/** Exact scopes survive logout but stay invisible to other principals; unknown attempts are never auto-evicted. */
export function createAttemptStore(port:AtomicPort,clock:()=>number=Date.now){
 const cache=new Map<string,Envelope|Error>();
 const unpack=(raw:string|null,s:Scope):Envelope=>raw===null?{schema:'large-import-browser-attempt/v1',scope:structuredClone(s),pending:null,history:[]}:decode(raw,s,clock());
 const packed=(s:Scope,e:Envelope)=>{const raw=JSON.stringify(e);decode(raw,s,clock());need(bytes(raw)<=MAX_BYTES,'Zapis próby przekracza limit');return raw;};
 const edit=async<T>(s0:Scope,f:(e:Envelope,s:Scope,records:RecordEntry[],exists:boolean)=>T):Promise<T>=>{const s=structuredClone(s0),k=storageKey(s);let e!:Envelope;const result=await port.atomic(k,(raw,records)=>{e=unpack(raw,s);const value=f(e,s,records,raw!==null);return{raw:packed(s,e),value};});cache.set(k,structuredClone(e));return result;};
 const forPrincipal=(records:RecordEntry[],context:Context)=>{need(records.length<=MAX_RECORDS,'Limit zakresów pamięci prób');return records.flatMap(({key:k,raw})=>{need(k.startsWith(PREFIX),'Inny klucz pamięci prób');let tuple:unknown;try{tuple=JSON.parse(k.slice(PREFIX.length));}catch{throw Error('Uszkodzony klucz pamięci prób');}need(Array.isArray(tuple)&&tuple.length===4,'Uszkodzony zakres pamięci prób');if(!same(tuple.slice(0,3),[context.tenantId,context.userId,context.apiKeyId]))return[];const s={context,catalogId:tuple[3]};return[[k,unpack(raw,s)] as const];});};
 const unresolved=(e:Envelope)=>!!e.pending&&(!e.pending.sent||['retaining','preparing','approving'].includes(e.pending.phase));
 return{
  async loadContext(context0:Context){const context=structuredClone(context0),records=await port.scan();try{const entries=forPrincipal(records,context);for(const[k,e]of entries)cache.set(k,e);}catch(error){for(const r of records){let tuple:unknown;try{tuple=JSON.parse(r.key.slice(PREFIX.length));}catch{continue;}if(Array.isArray(tuple)&&same(tuple.slice(0,3),[context.tenantId,context.userId,context.apiKeyId]))cache.set(r.key,error instanceof Error?error:Error('Nie można odczytać próby'));}throw error;}},
  async read(s0:Scope){const s=structuredClone(s0),k=storageKey(s);try{const e=unpack(await port.load(k),s);cache.set(k,e);return{...structuredClone(e),stale:!!e.pending&&clock()-e.pending.createdAt>STALE_MS};}catch(error){cache.set(k,error instanceof Error?error:Error('Nie można odczytać próby'));throw error;}},
  async claim(s:Scope,a0:SavedAttempt){const a=validateSavedAttempt(a0,s,clock());need(!a.sent&&a.revision===0&&a.phase==='retaining','Nowa próba musi być niewysłana');return edit(s,(e,s,records,exists)=>{need(!forPrincipal(records,s.context).some(([,entry])=>unresolved(entry)),'Inna nierozstrzygnięta próba tego użytkownika wymaga odczytu');need(e.pending===null,'Oryginalna próba wymaga odczytu przed nowym plikiem');need(records.length<MAX_RECORDS||exists,'Limit zachowanych zakresów prób; nie usunięto żadnego klucza');e.pending=a;return structuredClone(a);});},
  async update(s:Scope,a0:SavedAttempt){const a=validateSavedAttempt(a0,s,clock());return edit(s,e=>{need(e.pending&&immutable(e.pending)===immutable(a),'Zmieniono oryginalną próbę');need(e.pending.revision===a.revision,'Próba została zmieniona w innej karcie; odczytaj oryginalny stan');need(!e.pending.sent||a.sent,'Nie można cofnąć informacji o wysłaniu');if(e.pending.native){const old=e.pending.native,n=a.native;need(n&&n.rawSha256===old.rawSha256&&n.planHash===old.planHash&&n.revision>=old.revision&&(!old.approved||n.approved),'Nie można cofnąć lub zmienić natywnego potwierdzenia');}need(a.revision<Number.MAX_SAFE_INTEGER,'Limit rewizji próby');e.pending={...a,revision:a.revision+1};return structuredClone(e.pending);});},
  /** Caller separately reads the exact native job and unresolved attempts; Core/PIM completion is not required to queue another file. */
  async archive(s:Scope,key:string,jobId:string,revision:number){return edit(s,e=>{need(e.pending?.revision===revision&&e.pending.key===key&&e.pending.jobId===jobId&&e.pending.sent&&e.pending.phase==='prepared','Niepotwierdzona próba nie może rozpocząć nowego pliku');e.history=[{key,jobId,fileName:e.pending.fileName,archivedAt:clock()},...e.history].slice(0,20);e.pending=null;return structuredClone(e.history);});},
  async discardUnsent(s:Scope,key:string,revision:number){return edit(s,e=>{need(e.pending?.revision===revision&&e.pending.key===key&&!e.pending.sent&&e.pending.phase==='retaining','Brak potwierdzenia, że próba nie została wysłana');e.pending=null;});},
  hasUnresolved(context:Context){for(const[k,e]of cache){const tuple=JSON.parse(k.slice(PREFIX.length));if(!same(tuple.slice(0,3),[context.tenantId,context.userId,context.apiKeyId]))continue;if(e instanceof Error)return true;if(e.pending&&(!e.pending.sent||['retaining','preparing','approving'].includes(e.pending.phase)))return true;}return false;},
 };
}
function indexedDbPort():AtomicPort{
 need(typeof indexedDB!=='undefined','Trwałe próby wymagają pamięci IndexedDB; nic nie zostało wysłane');
 const open=()=>new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('dyna-large-import-attempts',1);let failed=false;r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('attempts'))r.result.createObjectStore('attempts');};r.onerror=()=>reject(r.error??Error('Nie można otworzyć pamięci prób'));r.onblocked=()=>{failed=true;reject(Error('Inna karta blokuje pamięć prób'));};r.onsuccess=()=>{if(failed)r.result.close();else resolve(r.result);};});
 const requested=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error??Error('Nie można odczytać pamięci prób'));});
 const complete=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('Nie potwierdzono trwałej próby'));tx.onerror=()=>reject(tx.error??Error('Błąd pamięci prób'));});
  const readRecords=async(store:IDBObjectStore):Promise<RecordEntry[]>=>{const count=await requested(store.count());need(count<=MAX_RECORDS,'Limit zakresów pamięci prób');const [keys,values]=await Promise.all([requested(store.getAllKeys()),requested(store.getAll())]);need(keys.length===values.length,'Niepełny odczyt zakresów prób');return keys.map((key,n)=>{need(typeof key==='string'&&typeof values[n]==='string'&&bytes(values[n])<=MAX_BYTES,'Nieprawidłowy zapis pamięci prób');return{key,raw:values[n]};});};
 return{
  async scan(){const db=await open();try{const tx=db.transaction('attempts','readonly'),done=complete(tx);try{const records=await readRecords(tx.objectStore('attempts'));await done;return records;}catch(error){await done.catch(()=>{});throw error;}}finally{db.close();}},
  async load(key){const db=await open();try{const tx=db.transaction('attempts','readonly'),done=complete(tx);try{const value=await requested(tx.objectStore('attempts').get(key));await done;need(value===undefined||typeof value==='string','Nieprawidłowy typ zapisu próby');return value??null;}catch(error){await done.catch(()=>{});throw error;}}finally{db.close();}},
  async atomic<T>(key:string,work:(raw:string|null,records:RecordEntry[])=>{raw:string;value:T}){const db=await open();try{const tx=db.transaction('attempts','readwrite',{durability:'strict'}),done=complete(tx),store=tx.objectStore('attempts');try{const [raw,records]=await Promise.all([requested(store.get(key)),readRecords(store)]);need(raw===undefined||typeof raw==='string','Nieprawidłowy typ zapisu próby');const result=work(raw??null,records);store.put(result.raw,key);await done;notifyAttemptChange();return result.value;}catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}}finally{db.close();}},
 };
}
let channel:BroadcastChannel|undefined,defaultStore:ReturnType<typeof createAttemptStore>|undefined;
function notifyAttemptChange(){if(typeof window==='undefined')return;window.dispatchEvent(new Event('dyna:large-import-attempt-change'));channel?.postMessage('changed');}
export function browserAttemptStore(){
 need(typeof window!=='undefined'&&typeof indexedDB!=='undefined','Trwałe próby wymagają pamięci przeglądarki; nic nie zostało wysłane');
 if(!defaultStore){const store=createAttemptStore(indexedDbPort());if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel('dyna-large-import-attempt-notice-v1');channel.onmessage=()=>{if(typeof window!=='undefined')window.dispatchEvent(new Event('dyna:large-import-attempt-change'));};}defaultStore=store;}
 return defaultStore;
}
