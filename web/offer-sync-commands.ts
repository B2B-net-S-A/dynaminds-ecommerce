export type OfferSyncContext={tenantId:string;userId:string;admin:boolean;readOnly:boolean;externalWriteBlocked:boolean};
export type OfferSyncCommand={client_key:string;version:number;enabled:boolean;warehouse_id:string;price_list_id:string|null;stock:boolean;price:boolean;interval_seconds:number;verify_seconds:number;confirm_external:boolean};
export type OfferSyncMarker={v:1;tenant_id:string;user_id:string;channel_id:string;simulation:boolean;created_at:string;body:OfferSyncCommand;phase:'sent'|'unknown'|'acknowledged'|'cancelled';ack?:any};
type Store=Pick<Storage,'getItem'|'setItem'>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const refuse=()=>{throw Error('Nie potwierdzono oryginalnego polecenia synchronizacji. Zachowaj jego dane i odczytaj wynik.');};
const exact=(v:any,keys:string[])=>{if(!v||Array.isArray(v)||typeof v!=='object'||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))refuse();};
const integer=(v:any,min:number,max:number)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const stamp=(v:any)=>typeof v==='string'&&v.length<=64&&Number.isFinite(Date.parse(v));
export function offerSyncCommandKey(c:OfferSyncContext,channel:string){if(!uuid(c.tenantId)||!uuid(c.userId)||!uuid(channel))refuse();return'dyna:offer-sync-commands:v1:'+c.tenantId+':'+c.userId+':'+channel;}
export function readOfferSyncCommand(v:any):OfferSyncCommand{
 exact(v,['client_key','version','enabled','warehouse_id','price_list_id','stock','price','interval_seconds','verify_seconds','confirm_external']);
 if(!uuid(v.client_key)||!integer(v.version,0,2147483646)||!uuid(v.warehouse_id)||!(v.price_list_id===null||uuid(v.price_list_id))||!['enabled','stock','price','confirm_external'].every(k=>typeof v[k]==='boolean')||!integer(v.interval_seconds,30,86400)||!integer(v.verify_seconds,60,86400)||!v.stock&&!v.price||!v.price&&v.price_list_id!==null)refuse();return structuredClone(v);
}
export function readOfferSyncConfig(v:any,c:OfferSyncContext,channel:string){
 exact(v,['tenant_id','channel_id','actor_id','enabled','version','warehouse_id','price_list_id','stock','price','interval_seconds','verify_seconds','external_authorized','connection_hash','next_run_at','last_run_at','last_job_id','error','updated_at']);
 if(v.tenant_id!==c.tenantId||v.channel_id!==channel||!uuid(v.actor_id)||!integer(v.version,1,2147483647)||!uuid(v.warehouse_id)||!(v.price_list_id===null||uuid(v.price_list_id))||!['enabled','stock','price','external_authorized'].every(k=>typeof v[k]==='boolean')||!integer(v.interval_seconds,30,86400)||!integer(v.verify_seconds,60,86400)||!v.stock&&!v.price||!v.price&&v.price_list_id!==null||!/^[a-f0-9]{64}$/.test(v.connection_hash)||![v.next_run_at,v.last_run_at].every(x=>x===null||stamp(x))||!(v.last_job_id===null||uuid(v.last_job_id))||!(v.error===null||typeof v.error==='string'&&v.error.length<=8192)||!stamp(v.updated_at))refuse();return structuredClone(v);
}
export function readOfferSyncAck(v:any,m:OfferSyncMarker){
 if(v?.status==='OFFER_SYNC_CONFIGURATION_CANCELLED'){
  exact(v,['status','client_key','channel_id','version']);if(v.client_key!==m.body.client_key||v.channel_id!==m.channel_id||v.version!==m.body.version)refuse();return structuredClone(v);
 }
 exact(v,['status','client_key','channel_id','config']);if(v.status!=='OFFER_SYNC_CONFIGURATION_ACKNOWLEDGED'||v.client_key!==m.body.client_key||v.channel_id!==m.channel_id)refuse();
 const cfg=readOfferSyncConfig(v.config,{tenantId:m.tenant_id,userId:m.user_id,admin:true,readOnly:false,externalWriteBlocked:false},m.channel_id),b=m.body;
 if(cfg.actor_id!==m.user_id||cfg.version!==b.version+1||['enabled','warehouse_id','price_list_id','stock','price','interval_seconds','verify_seconds'].some(k=>cfg[k]!==b[k as keyof OfferSyncCommand])||cfg.external_authorized!==(b.enabled&&!m.simulation&&b.confirm_external))refuse();return structuredClone(v);
}
function marker(v:any,c:OfferSyncContext,channel:string):OfferSyncMarker{
 exact(v,['v','tenant_id','user_id','channel_id','simulation','created_at','body','phase',...(v?.ack===undefined?[]:['ack'])]);
 if(v.v!==1||v.tenant_id!==c.tenantId||v.user_id!==c.userId||v.channel_id!==channel||typeof v.simulation!=='boolean'||!stamp(v.created_at)||!['sent','unknown','acknowledged','cancelled'].includes(v.phase))refuse();readOfferSyncCommand(v.body);
 if(v.phase==='acknowledged'||v.phase==='cancelled'){const ack=readOfferSyncAck(v.ack,v);if((ack.status==='OFFER_SYNC_CONFIGURATION_CANCELLED')!==(v.phase==='cancelled'))refuse();}else if(v.ack!==undefined)refuse();return structuredClone(v);
}
export const offerSyncCommandPending=(m:OfferSyncMarker)=>m.phase==='sent'||m.phase==='unknown';
function parse(raw:string|null,c:OfferSyncContext,ch:string):OfferSyncMarker[]{if(raw===null)return[];if(raw.length>16384)refuse();let v:any;try{v=JSON.parse(raw);}catch{refuse();}exact(v,['v','records']);if(v.v!==1||!Array.isArray(v.records)||v.records.length>8)refuse();const rows=v.records.map((m:any)=>marker(m,c,ch));if(new Set(rows.map((m:OfferSyncMarker)=>m.body.client_key)).size!==rows.length)refuse();return rows;}
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function merge(rows:OfferSyncMarker[]){const byKey=new Map<string,OfferSyncMarker>();for(const r of rows){const old=byKey.get(r.body.client_key);if(old){if(!same(old.body,r.body)||old.tenant_id!==r.tenant_id||old.user_id!==r.user_id||old.channel_id!==r.channel_id||old.simulation!==r.simulation||old.created_at!==r.created_at)refuse();if(!offerSyncCommandPending(old)&&!offerSyncCommandPending(r)&&!same(old.ack,r.ack))refuse();if(!offerSyncCommandPending(old))continue;if(offerSyncCommandPending(r)&&old.phase==='unknown')continue;}byKey.set(r.body.client_key,r);}const all=[...byKey.values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.body.client_key.localeCompare(b.body.client_key)),unsettled=all.filter(offerSyncCommandPending),terminal=all.filter(m=>!offerSyncCommandPending(m)).slice(-4);const kept=[...unsettled,...terminal].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.body.client_key.localeCompare(b.body.client_key));if(kept.length>8)refuse();return kept;}
/** sessionStorage retains this tab's exact intent; the shared mirror and same WebLock serialize tabs. */
export function readOfferSyncCommands(session:Store,shared:Store,c:OfferSyncContext,ch:string){const key=offerSyncCommandKey(c,ch);return merge([...parse(session.getItem(key),c,ch),...parse(shared.getItem(key),c,ch)]);}
export function saveOfferSyncCommand(session:Store,shared:Store,c:OfferSyncContext,ch:string,m:OfferSyncMarker){
 const valid=marker(m,c,ch),rows=readOfferSyncCommands(session,shared,c,ch),old=rows.find(r=>r.body.client_key===valid.body.client_key);
 if(old&&!offerSyncCommandPending(old)&&!same(old,valid))refuse();if(!old&&rows.some(offerSyncCommandPending))throw Error('Wcześniejsze polecenie ma niepewny wynik. Najpierw odczytaj lub anuluj jego oryginał.');
 const next=merge([...rows,valid]),raw=JSON.stringify({v:1,records:next});if(raw.length>16384)refuse();parse(raw,c,ch);const key=offerSyncCommandKey(c,ch);shared.setItem(key,raw);if(shared.getItem(key)!==raw)throw Error('Nie potwierdzono zapisu próby. Nie wysyłaj polecenia.');session.setItem(key,raw);if(session.getItem(key)!==raw)throw Error('Nie potwierdzono zapisu próby. Nie wysyłaj polecenia.');return next;
}
export function acknowledgeOfferSyncCommand(m:OfferSyncMarker,ack:any):OfferSyncMarker{const confirmed=readOfferSyncAck(ack,m);return{...m,phase:confirmed.status==='OFFER_SYNC_CONFIGURATION_CANCELLED'?'cancelled':'acknowledged',ack:confirmed};}
export function observeOfferSyncCommand(m:OfferSyncMarker,v:any):OfferSyncMarker|null{
 if(v?.status==='NOT_OBSERVED'){exact(v,['status','automatic_retry']);if(v.automatic_retry!==false)refuse();return null;}
 exact(v,['status','ack']);if(v.status!=='ACKNOWLEDGED')refuse();return acknowledgeOfferSyncCommand(m,v.ack);
}
