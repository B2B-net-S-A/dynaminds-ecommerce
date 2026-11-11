/** New local Woo inbound imports only. No provider writes, old queue adoption,
 * job reclaim, retry, customer-by-email matching or replacement of importOrder.
 * A source ticket is construction-owned and exists only for the exact read.
 */
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {tenantTx,tenantReadTx} from './db';
import {audit,type Actor} from './domain';
import {ensure} from './errors';
import {importOrder,canAutomaticallyImportNewWooOrderInTx,type CreatedInboundObservation} from './imports';
import {localWooRegistryFixture,type LocalWooHttpRegistry} from './local-woo-http-registry';
import {readConfiguredLocalWooHttpChannel} from './local-woo-http-fixture';
import {LOCAL_WOO_ORIGINS} from '../shared/local-woo-origins';
const uuid=z.uuid(),version=z.string().regex(/^(0|[1-9]\d{0,14})$/),digest=z.string().regex(/^[a-f0-9]{64}$/);
const selected=z.strictObject({tenantId:uuid,userId:uuid,channelId:uuid,fixtureId:uuid,origin:z.enum(LOCAL_WOO_ORIGINS)});
export type LocalWooOrderImportSelection=z.infer<typeof selected>;
export const localWooOrderImportCommand=z.strictObject({client_key:uuid,expected_version:version,enabled:z.boolean(),warehouse_id:uuid,confirm_import:z.boolean()}).refine(v=>!v.enabled||v.confirm_import,'Potwierdź automatyczne tworzenie nowych zamówień i rezerwacji');
type Command=z.infer<typeof localWooOrderImportCommand>;
export type LocalWooReadImportAnchor={occurrence_id:string;dispatch_id:string;read_job_id:string;lease_token:string};
const canonical=(v:any):any=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const actor=(s:LocalWooOrderImportSelection):Actor=>({tenantId:s.tenantId,userId:s.userId,role:'admin'});
const sourceHash=(ch:any)=>createHash('sha256').update(JSON.stringify({id:ch.id,tenant_id:ch.tenant_id,provider:ch.provider,mode:ch.mode,settings:ch.settings,credentials:ch.credentials,sync_enabled:ch.sync_enabled})).digest('hex');
const wire=(v:any)=>JSON.parse(JSON.stringify(v));
type Ticket={s:LocalWooOrderImportSelection;version:string;warehouse:string;source:string;occurrence_id:string};
const acknowledged=z.strictObject({status:z.literal('LOCAL_WOO_ORDER_IMPORT_CONFIGURED'),client_key:uuid,channel_id:uuid,version:version,enabled:z.boolean(),warehouse_id:uuid,automatic_retry:z.literal(false)});
const cancelled=z.strictObject({status:z.literal('LOCAL_WOO_ORDER_IMPORT_CANCELLED'),client_key:uuid,channel_id:uuid,version,automatic_retry:z.literal(false)});
const ackSchema=z.discriminatedUnion('status',[acknowledged,cancelled]);
const resultSchema=z.strictObject({status:z.literal('LOCAL_WOO_ORDER_IMPORTED'),receipt_id:uuid,inbound_id:uuid,order_id:uuid,source_hash:digest,occurrence_id:uuid,dispatch_id:uuid,read_job_id:uuid,control_version:version,warehouse_id:uuid,automatic_retry:z.literal(false)});
export function createLocalWooOrderImport(registry:LocalWooHttpRegistry,input:readonly LocalWooOrderImportSelection[]){
 const scopes=z.array(selected).min(1).max(5).parse(structuredClone(input));
 for(const k of ['channelId','fixtureId','origin'] as const)ensure(new Set(scopes.map(s=>s[k])).size===scopes.length,422,'Powtórzony własny sklep');
 for(const s of scopes)localWooRegistryFixture(registry,actor(s),s.channelId);
 const tickets=new WeakMap<object,Ticket>(),stopped=new Set<string>();let closed=false,active:Promise<void>|undefined;
 function own(a:Actor,id:string){ensure(a.role==='admin'&&!a.apiKeyId&&a.source!=='api',403,'Wymagana zwykła sesja administratora');const s=scopes.find(s=>s.tenantId===a.tenantId&&s.userId===a.userId&&s.channelId===uuid.parse(id));ensure(s,404,'Brak własnego wybranego sklepu');return s;}
 async function admin(c:PoolClient,s:LocalWooOrderImportSelection,read=false){ensure(read?(await c.query('SELECT public.customer_message_role($1) AS role',[s.userId])).rows[0]?.role==='admin':(await c.query('SELECT public.offer_sync_is_admin($1) AS ok',[s.userId])).rows[0]?.ok===true,403,'Wymagany aktualny administrator tej firmy');}
 async function channel(c:PoolClient,s:LocalWooOrderImportSelection,lock=true){const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[s.tenantId,s.channelId])).rows[0];ensure(ch&&ch.provider==='woocommerce'&&ch.mode==='sandbox'&&ch.sync_enabled===false&&isDeepStrictEqual(ch.settings,{store_url:s.origin,simulation:false,local_http_fixture:{schema:'local-woo-http-fixture/v1',fixture_id:s.fixtureId,owner_id:s.userId}}),409,'Zmieniony własny kanał Woo');return ch;}
 async function control(c:PoolClient,s:LocalWooOrderImportSelection,lock=true){return(await c.query('SELECT * FROM local_woo_order_import_controls WHERE tenant_id=$1 AND channel_id=$2'+(lock?' FOR UPDATE':''),[s.tenantId,s.channelId])).rows[0];}
 async function configured(s:LocalWooOrderImportSelection){const f=await readConfiguredLocalWooHttpChannel(localWooRegistryFixture(registry,actor(s),s.channelId),actor(s));ensure(f.enrolled===true&&f.fixture_id===s.fixtureId&&f.origin===s.origin,409,'Sklep nie został podłączony');}
 function requestHash(s:LocalWooOrderImportSelection,b:Command){return hash(['local-woo-order-import-command/v1',s,b]);}
 function validateAck(v:unknown,s:LocalWooOrderImportSelection,b:Command){const ack=ackSchema.parse(v);ensure(ack.channel_id===s.channelId&&ack.client_key===b.client_key&&ack.automatic_retry===false,409,'Niepotwierdzony wynik polecenia');if(ack.status==='LOCAL_WOO_ORDER_IMPORT_CANCELLED')ensure(ack.version===b.expected_version,409,'Inne anulowane polecenie');else ensure(ack.version===String(BigInt(b.expected_version)+1n)&&ack.enabled===b.enabled&&ack.warehouse_id===b.warehouse_id,409,'Wynik nie odpowiada oryginalnej zgodzie');return ack;}
 async function prior(c:PoolClient,s:LocalWooOrderImportSelection,b:Command){const r=(await c.query('SELECT * FROM local_woo_order_import_commands WHERE tenant_id=$1 AND client_key=$2',[s.tenantId,b.client_key])).rows[0];if(!r)return null;ensure(r.actor_id===s.userId&&r.channel_id===s.channelId&&r.request_hash===requestHash(s,b)&&isDeepStrictEqual(r.request_body,b),409,'Klucz polecenia ma inną tożsamość lub treść');return validateAck(r.response,s,b);}
 async function store(c:PoolClient,s:LocalWooOrderImportSelection,b:Command,ack:unknown){await c.query('INSERT INTO local_woo_order_import_commands(tenant_id,client_key,channel_id,actor_id,request_hash,request_body,response) VALUES($1,$2,$3,$4,$5,$6,$7)',[s.tenantId,b.client_key,s.channelId,s.userId,requestHash(s,b),JSON.stringify(b),JSON.stringify(ack)]);}
 async function configure(a:Actor,id:string,raw:unknown,cancel=false){ensure(!closed,503,'Procesor zamknięty');const s=own(a,id),b=localWooOrderImportCommand.parse(raw);await configured(s);return tenantTx(s.tenantId,async c=>{
  const ch=await channel(c,s);await admin(c,s);const known=await prior(c,s,b);if(known)return known;
  const old=await control(c,s);ensure(String(old?.version??0)===b.expected_version,409,'Zmieniona wersja zgody');
  if(cancel){const ack=validateAck({status:'LOCAL_WOO_ORDER_IMPORT_CANCELLED',client_key:b.client_key,channel_id:id,version:b.expected_version,automatic_retry:false},s,b);await store(c,s,b,ack);return ack;}
  ensure((await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2',[s.tenantId,b.warehouse_id])).rows.length===1,404,'Brak własnego magazynu');
  const updated=await c.query(`INSERT INTO local_woo_order_import_controls(tenant_id,channel_id,owner_id,fixture_id,version,enabled,warehouse_id,connection_hash,enabled_at)
   VALUES($1,$2,$3,$4,1,$5,$6,$7,CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END)
   ON CONFLICT(tenant_id,channel_id) DO UPDATE SET version=local_woo_order_import_controls.version+1,enabled=EXCLUDED.enabled,warehouse_id=EXCLUDED.warehouse_id,connection_hash=EXCLUDED.connection_hash,enabled_at=EXCLUDED.enabled_at,updated_at=clock_timestamp()
   WHERE local_woo_order_import_controls.version=$8::bigint`,[s.tenantId,id,s.userId,s.fixtureId,b.enabled,b.warehouse_id,sourceHash(ch),b.expected_version]);ensure(updated.rowCount===1,409,'Konflikt aktualnej zgody importu');
  const ack=validateAck({status:'LOCAL_WOO_ORDER_IMPORT_CONFIGURED',client_key:b.client_key,channel_id:id,version:String(BigInt(b.expected_version)+1n),enabled:b.enabled,warehouse_id:b.warehouse_id,automatic_retry:false},s,b);await store(c,s,b,ack);await audit(c,a,'local_woo.order_import.configure',id,{version:ack.version,enabled:b.enabled,warehouse_id:b.warehouse_id,client_key:b.client_key});return ack;
 });}
 async function observe(a:Actor,id:string,raw:unknown){const s=own(a,id),b=localWooOrderImportCommand.parse(raw);return tenantReadTx(s.tenantId,async c=>{await admin(c,s,true);const ack=await prior(c,s,b);return ack?{status:'ACKNOWLEDGED' as const,ack}:{status:'NOT_OBSERVED' as const,automatic_retry:false as const};});}
 async function read(a:Actor,id:string){const s=own(a,id);return tenantReadTx(s.tenantId,async c=>{await admin(c,s,true);const cfg=await control(c,s,false);const rows=(await c.query('SELECT id,inbound_id,source_hash,occurrence_id,dispatch_id,read_job_id,control_version,warehouse_id,state,order_id,response,created_at,completed_at FROM local_woo_order_import_receipts WHERE tenant_id=$1 AND channel_id=$2 AND owner_id=$3 ORDER BY created_at DESC,id DESC LIMIT 25',[s.tenantId,id,s.userId])).rows;return{channel_id:id,config:cfg?{version:String(cfg.version),enabled:cfg.enabled,warehouse_id:cfg.warehouse_id}:null,receipts:wire(rows),automatic_retry:false,policy:'NEW_MAPPED_INBOUND_ONLY'};});}
 async function capture(s0:LocalWooOrderImportSelection,occurrenceId:string):Promise<object|null>{
  const s=scopes.find(s=>isDeepStrictEqual(s,s0));ensure(s,403,'Obcy czytnik');
  return tenantReadTx(s.tenantId,async c=>{
   const cfg=await control(c,s,false);if(!cfg?.enabled)return null;await admin(c,s,true);const ch=await channel(c,s,false);
   const o=(await c.query("SELECT * FROM local_woo_read_occurrences WHERE tenant_id=$1 AND id=$2 AND created_at>=$3::timestamptz",[s.tenantId,occurrenceId,cfg.enabled_at])).rows[0];
   if(!o||o.kind!=='orders.sync'||o.state!=='running'||o.channel_id!==s.channelId||o.owner_id!==s.userId||o.connection_hash!==cfg.connection_hash||cfg.owner_id!==s.userId||cfg.fixture_id!==s.fixtureId||cfg.connection_hash!==sourceHash(ch))return null;
   const token=Object.freeze({});tickets.set(token,{s,version:String(cfg.version),warehouse:cfg.warehouse_id,source:cfg.connection_hash,occurrence_id:occurrenceId});return token;
  });
 }
 async function stage(c:PoolClient,token:object|null,anchor:LocalWooReadImportAnchor,created:readonly CreatedInboundObservation[]){
  if(!token)return;const t=tickets.get(token);ensure(t&&t.occurrence_id===anchor.occurrence_id,403,'Obca zgoda stagingu');const s=t.s;
  const ch=await channel(c,s),cfg=await control(c,s);await admin(c,s);
  // A changed/paused consent never promotes the rows just read. They stay for manual review.
  if(!cfg?.enabled||String(cfg.version)!==t.version||cfg.warehouse_id!==t.warehouse||cfg.connection_hash!==t.source||sourceHash(ch)!==t.source)return;
  const o=(await c.query('SELECT * FROM local_woo_read_occurrences WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,anchor.occurrence_id])).rows[0];
  const d=(await c.query('SELECT * FROM local_woo_read_dispatches WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,anchor.dispatch_id])).rows[0];
  ensure(o?.state==='running'&&o.kind==='orders.sync'&&o.channel_id===s.channelId&&o.owner_id===s.userId&&o.connection_hash===t.source&&o.job_id===anchor.read_job_id&&d?.state==='started'&&d.occurrence_id===o.id&&d.lease_token===anchor.lease_token,409,'Zmieniony odczyt automatycznego importu');
  const job=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,anchor.read_job_id])).rows[0];
  ensure(job?.kind==='orders.sync'&&job.state==='running'&&job.lease_token===anchor.lease_token&&job.payload?.actor_id===s.userId&&job.payload.channel_id===s.channelId,409,'Obce zadanie nowego stagingu');
  ensure(created.length<=50&&new Set(created.map(r=>r.id)).size===created.length,409,'Nieprawidłowa strona nowych zamówień');
  for(const r of created){
   // A newly observed validation/mapping error is manual staging, never an import intent.
   if(r.state!=='staged')continue;uuid.parse(r.id);digest.parse(r.source_hash);
   const inbound=(await c.query('SELECT *,created_at >= (SELECT created_at FROM local_woo_read_occurrences WHERE tenant_id=$2 AND id=$3) AS import216_new FROM inbound_orders WHERE id=$1 FOR UPDATE',[r.id,s.tenantId,o.id])).rows[0];
   ensure(inbound?.tenant_id===s.tenantId&&inbound.channel_id===s.channelId&&inbound.source_hash===r.source_hash&&inbound.import216_new===true&&inbound.state==='staged'&&inbound.normalized&&!inbound.order_id,409,'Zmieniony nowy inbound');
   if(!await canAutomaticallyImportNewWooOrderInTx(c,inbound))continue;
   await c.query(`INSERT INTO local_woo_order_import_receipts(id,tenant_id,channel_id,owner_id,control_version,warehouse_id,connection_hash,occurrence_id,dispatch_id,read_job_id,inbound_id,source_hash)
    VALUES($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11,$12)`,[randomUUID(),s.tenantId,s.channelId,s.userId,t.version,t.warehouse,t.source,o.id,d.id,o.job_id,r.id,r.source_hash]);
  }
 }
 async function ready(c:PoolClient,s:LocalWooOrderImportSelection,r:any){
  const o=(await c.query('SELECT * FROM local_woo_read_occurrences WHERE tenant_id=$1 AND id=$2',[s.tenantId,r.occurrence_id])).rows[0];
  const d=(await c.query('SELECT * FROM local_woo_read_dispatches WHERE tenant_id=$1 AND id=$2',[s.tenantId,r.dispatch_id])).rows[0];
  ensure(o?.channel_id===s.channelId&&o.kind==='orders.sync'&&o.owner_id===s.userId&&o.connection_hash===r.connection_hash&&o.job_id===r.read_job_id&&d?.occurrence_id===o.id,409,'Obca linia odczytu');const j=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2',[s.tenantId,r.read_job_id])).rows[0];return o.state==='done'&&d.state==='acknowledged'&&j?.kind==='orders.sync'&&j.state==='done'&&j.lease_token===null&&j.payload?.actor_id===s.userId&&j.payload.channel_id===s.channelId;
 }
 function bound(s:LocalWooOrderImportSelection,cfg:any,ch:any,r:any){ensure(r&&r.tenant_id===s.tenantId&&r.channel_id===s.channelId&&r.owner_id===s.userId&&cfg?.enabled===true&&cfg.owner_id===s.userId&&cfg.fixture_id===s.fixtureId&&String(cfg.version)===String(r.control_version)&&cfg.warehouse_id===r.warehouse_id&&cfg.connection_hash===r.connection_hash&&sourceHash(ch)===r.connection_hash,409,'Zmieniona zgoda, magazyn lub źródło importu');}
 async function claim(s:LocalWooOrderImportSelection){return tenantTx(s.tenantId,async c=>{
  if(closed)return null;const ch=await channel(c,s),cfg=await control(c,s);if(!cfg?.enabled)return null;await admin(c,s);
  ensure(!(await c.query("SELECT id FROM local_woo_order_import_receipts WHERE tenant_id=$1 AND channel_id=$2 AND state='started' LIMIT 1",[s.tenantId,s.channelId])).rows.length,409,'Niepotwierdzony import wymaga odczytu wyniku');
  const rows=(await c.query("SELECT * FROM local_woo_order_import_receipts WHERE tenant_id=$1 AND channel_id=$2 AND control_version=$3::bigint AND state='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE",[s.tenantId,s.channelId,String(cfg.version)])).rows;
  const r=rows[0];if(!r)return null;bound(s,cfg,ch,r);if(!await ready(c,s,r))return null;
  const token=randomUUID();const updated=(await c.query("UPDATE local_woo_order_import_receipts SET state='started',lease_token=$3 WHERE tenant_id=$1 AND id=$2 AND state='queued' RETURNING *",[s.tenantId,r.id,token])).rows[0];ensure(updated,409,'Inny wykonawca przejął import');
  await audit(c,actor(s),'local_woo.order_import.claim',r.id,{inbound_id:r.inbound_id,source_hash:r.source_hash,occurrence_id:r.occurrence_id,dispatch_id:r.dispatch_id,read_job_id:r.read_job_id,automatic_retry:false});return updated;
 });}
 async function execute(s:LocalWooOrderImportSelection,r:any){
  const authority=async(c:PoolClient)=>{
   // Match genuine createOrder's catalogue-before-channel lock order.
   await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['catalog:'+s.tenantId]);
   const ch=await channel(c,s),cfg=await control(c,s);await admin(c,s);bound(s,cfg,ch,r);
   const current=(await c.query('SELECT * FROM local_woo_order_import_receipts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenantId,r.id])).rows[0];
   ensure(current?.state==='started'&&current.lease_token===r.lease_token&&isDeepStrictEqual(canonical(current),canonical(r)),409,'Zmieniona intencja importu');ensure(await ready(c,s,r),409,'Odczyt nie został potwierdzony');
   const inbound=(await c.query('SELECT * FROM inbound_orders WHERE id=$1 FOR UPDATE',[r.inbound_id])).rows[0];
   ensure(inbound?.tenant_id===s.tenantId&&inbound.channel_id===s.channelId&&inbound.source_hash===r.source_hash&&(!inbound.order_id||inbound.imported_hash===r.source_hash),409,'Zmienione nowe zamówienie');
  };
  await importOrder(actor(s),r.inbound_id,r.warehouse_id,r.source_hash,undefined,{localWooOrderImport:{before:authority,complete:async(c,orderId)=>{
   // Locks from before() are held until the real import/receipt COMMIT.
   const i=(await c.query('SELECT * FROM inbound_orders WHERE id=$1',[r.inbound_id])).rows[0];ensure(i?.order_id===orderId&&i.source_hash===r.source_hash&&i.imported_hash===r.source_hash,409,'Import nie potwierdził dokładnego źródła');
   const response=resultSchema.parse({status:'LOCAL_WOO_ORDER_IMPORTED',receipt_id:r.id,inbound_id:r.inbound_id,order_id:orderId,source_hash:r.source_hash,occurrence_id:r.occurrence_id,dispatch_id:r.dispatch_id,read_job_id:r.read_job_id,control_version:String(r.control_version),warehouse_id:r.warehouse_id,automatic_retry:false});
   const done=await c.query("UPDATE local_woo_order_import_receipts SET state='done',order_id=$4,response=$5,completed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='started' AND lease_token=$3 RETURNING id",[s.tenantId,r.id,r.lease_token,orderId,JSON.stringify(response)]);ensure(done.rows.length===1,409,'Utracono intencję importu');await audit(c,actor(s),'local_woo.order_import.done',r.id,response);
  }}});
 }
 async function cycle(){if(closed)return;if(active)return active;active=(async()=>{for(const s of scopes){if(closed)break;if(stopped.has(s.channelId))continue;try{
  const eligible=await tenantReadTx(s.tenantId,async c=>(await c.query('SELECT enabled FROM local_woo_order_import_controls WHERE tenant_id=$1 AND channel_id=$2',[s.tenantId,s.channelId])).rows[0]?.enabled===true);if(!eligible)continue;
  await configured(s);const r=await claim(s);if(r)await execute(s,r);
 }catch{stopped.add(s.channelId);/* Never rerun an import after an unknown COMMIT. Read receipts explicitly. */}}})().finally(()=>{active=undefined;});return active;}
 return Object.freeze({configure:(a:Actor,id:string,b:unknown)=>configure(a,id,b),cancel:(a:Actor,id:string,b:unknown)=>configure(a,id,b,true),observe,read,capture,stage,cycle,close:async()=>{closed=true;await active;},inspect:()=>({closed,blocked:stopped.size})});
}
