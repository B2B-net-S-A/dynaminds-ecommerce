import {randomBytes, randomInt, randomUUID, createHmac, createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {tenantTx, tenantReadTx} from './db';
import {audit, type Actor} from './domain';
import {ensure, Problem} from './errors';
import {decrypt, encrypt} from './security';
import {offerInput, previewOffer, queueOffer, processOfferJob, failOffer} from './offers';
import {receiveWooWebhookInTx} from './sync-routes';
import {processIntegrationJob} from './sync';
import {importSourceHash, normalizeOrder} from './imports';
import {previewStatus, queueStatusInTx, processStatusWrite, failStatusJob} from './order-status';
import type {IntegrationContext} from './channel-access';

const localOnly: IntegrationContext = Object.freeze({transport: async () => {
  throw new Problem(503, 'Zewnętrzny transport lokalnego przepływu Woo jest wyłączony');
}});
const inputSchema = z.strictObject({request_id: z.uuid(), channel_id: z.uuid(),
  step: z.enum(['order-stage', 'listing-sync', 'cancel-status'])});
type Input = z.infer<typeof inputSchema>;
type Step = Input['step'];
type Job = {id:string;tenant_id:string;kind:string;payload:any;state:string;attempts:number;
  max_attempts:number;lease_token:string|null;locked_at:unknown};
type Claim = Readonly<{id:string}>;
type Marker = {request_id:string;state:'sent'|'acknowledged'|'unknown';source_order_id?:number;
  plan_id?:string;job_id?:string;delivery_id?:string;body_hash?:string};
type Envelope = {schema:'scoped-woocommerce-flow/v1';owner_id:string;product_id:string;
  listing_id:string;warehouse_id:string;steps:Partial<Record<Step, Marker>>};

async function currentAdmin(c:PoolClient, actor:Actor) {
  ensure(actor.role === 'admin' && actor.userId,403,'Wymagana oryginalna sesja administratora');
  ensure((await c.query('SELECT offer_sync_is_admin($1) AS ok',[actor.userId])).rows[0]?.ok === true,
    403,'Wymagany aktualny administrator firmy');
}
async function cohort(c:PoolClient, actor:Actor, channelId:string, lock=false, readOnly=false) {
  if(readOnly) {
    ensure(!lock,500,'Odczyt nie może blokować kanału');
    ensure(actor.role === 'admin' && actor.userId,403,'Wymagana oryginalna sesja administratora');
    ensure((await c.query('SELECT public.customer_message_role($1) AS role',[actor.userId])).rows[0]?.role === 'admin',
      403,'Wymagany aktualny administrator firmy');
  } else await currentAdmin(c,actor);
  const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),
    [actor.tenantId,channelId])).rows[0];
  ensure(ch?.provider==='woocommerce' && ch.mode==='sandbox' && ch.settings?.simulation===true
    && ch.settings.local_offer_source==='scoped-woocommerce-offer/v1'
    && ch.settings.local_offer_actor_id===actor.userId && ch.sync_enabled===false,
    409,'Wymagany własny kanał utworzony przez lokalny zapis oferty');
  const rows=(await c.query(`SELECT l.*,p.sku,p.name AS product_name FROM listings l JOIN products p
    ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE l.tenant_id=$1 AND l.channel_id=$2 ORDER BY l.id LIMIT 2`,
    [actor.tenantId,channelId])).rows;
  const listing=rows[0];
  ensure(rows.length===1 && listing.status==='simulation' && listing.warehouse_id
    && listing.external_id?.startsWith('DEMO-') && listing.price_currency==='PLN',
    409,'Wymagana jedna rzeczywista lokalna oferta PLN');
  ensure((await c.query(`SELECT id FROM offer_plans WHERE tenant_id=$1 AND channel_id=$2
    AND listing_id=$3 AND actor_id=$4 AND operation='create_draft' AND state='done'
    AND phase='done' AND result->>'scope'='local_simulation' AND result->>'desired_applied'='true'`,
    [actor.tenantId,channelId,listing.id,actor.userId])).rowCount,
    409,'Brak potwierdzonego oryginalnego utworzenia lokalnej oferty');
  return {ch,listing};
}
function envelope(ch:any, listing:any, actor:Actor):Envelope {
  const saved=ch.settings.local_woo_flow as Envelope|undefined;
  const identity={schema:'scoped-woocommerce-flow/v1' as const,owner_id:actor.userId!,
    product_id:listing.product_id,listing_id:listing.id,warehouse_id:listing.warehouse_id};
  if(!saved)return {...identity,steps:{}};
  const {steps,...old}=saved;
  ensure(isDeepStrictEqual(old,identity) && steps && Object.keys(steps).every(k=>
    ['order-stage','listing-sync','cancel-status'].includes(k)),409,'Tożsamość przepływu zmieniła się');
  return structuredClone(saved);
}
// Attachment data must not alter the settings fingerprint while its real processor runs.
// Audit is a source-owned reference carrier, not a claim or permission to execute/retry.
const attachmentSchema=z.strictObject({request_id:z.uuid(),step:z.enum(['listing-sync','cancel-status']),
  job_id:z.uuid(),plan_id:z.uuid()});
async function attachedEnvelope(c:PoolClient,actor:Actor,ch:any,listing:any):Promise<Envelope> {
  const e=envelope(ch,listing,actor);
  for(const step of ['listing-sync','cancel-status'] as const) {
    const m=e.steps[step];if(!m)continue;
    const receipts=(await c.query(`SELECT detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2
      AND entity_id=$3 AND action='integration.woocommerce.local_flow.attached'
      AND detail->>'request_id'=$4 AND detail->>'step'=$5 ORDER BY id LIMIT 2`,
      [actor.tenantId,actor.userId,ch.id,m.request_id,step])).rows;
    ensure(receipts.length<=1,409,'Niejednoznaczne oryginalne powiązanie zadania');
    if(!receipts.length)continue; // Includes legacy markers; absence grants no retry or ACK.
    const parsed=attachmentSchema.safeParse(receipts[0].detail);
    ensure(parsed.success,409,'Nieprawidłowe oryginalne powiązanie zadania');
    const ref=parsed.data!;
    ensure(ref.request_id===m.request_id && ref.step===step
      && (!m.job_id || m.job_id===ref.job_id) && (!m.plan_id || m.plan_id===ref.plan_id),
      409,'Oryginalne identyfikatory zadania zmieniły się');
    const j=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId,ref.job_id])).rows[0];
    const table=step==='listing-sync'?'offer_plans':'order_status_plans';
    const p=(await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`,
      [actor.tenantId,ref.plan_id])).rows[0];
    const payload=step==='listing-sync'?{plan_id:ref.plan_id,actor_id:actor.userId,channel_id:ch.id}
      :{plan_id:ref.plan_id,actor_id:actor.userId};
    ensure(j?.tenant_id===actor.tenantId && j.id===ref.job_id
      && j.kind===(step==='listing-sync'?'offer.write':'order.status.write')
      && isDeepStrictEqual(j.payload,payload) && Number(j.attempts)===1 && Number(j.max_attempts)===1
      && p?.tenant_id===actor.tenantId && p.id===ref.plan_id && p.actor_id===actor.userId
      && p.channel_id===ch.id && p.job_id===j.id,409,'Obce powiązanie planu lub zadania');
    if(step==='listing-sync') {
      ensure(p.operation==='sync' && p.listing_id===listing.id && p.product_id===listing.product_id,
        409,'Plan nie należy do oryginalnej własnej oferty');
    } else {
      ensure(p.local_status==='cancelled',409,'Plan nie utrwalił oryginalnego anulowania');
      const source=e.steps['order-stage'];
      ensure(source?.state==='acknowledged' && Number.isSafeInteger(source.source_order_id)
        && source.source_order_id!>0,409,'Brak oryginalnego własnego źródła zamówienia');
      const orders=(await c.query(`SELECT o.id FROM inbound_orders i JOIN orders o
        ON (o.tenant_id,o.id)=(i.tenant_id,i.order_id)
        AND o.channel_id=i.channel_id AND o.external_id=i.external_id
        WHERE i.tenant_id=$1 AND i.channel_id=$2 AND i.external_id=$3 AND i.state='imported'
        AND o.id=$4 AND o.status='cancelled' LIMIT 2`,
        [actor.tenantId,ch.id,String(source.source_order_id),p.order_id])).rows;
      ensure(orders.length===1 && orders[0].id===p.order_id,409,'Plan nie należy do własnego anulowanego zamówienia');
    }
    Object.assign(m,{job_id:ref.job_id,plan_id:ref.plan_id});
  }
  return e;
}
type FailedBeforeWrite = Partial<Record<'listing-sync',{request_id:string;job_id:string;plan_id:string}>>;
// Fresh data only: no ACK, replay, cached authorization or assertion of zero DB effects.
async function failedBeforeWrite(c:PoolClient,actor:Actor,ch:any,listing:any,e:Envelope,lock=false):Promise<FailedBeforeWrite> {
  const m=e.steps['listing-sync'];
  if(m?.state!=='unknown' || !z.uuid().safeParse(m.request_id).success
    || !z.uuid().safeParse(m.job_id).success || !z.uuid().safeParse(m.plan_id).success)return {};
  const suffix=lock?' FOR SHARE':'';
  const j=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2'+suffix,
    [actor.tenantId,m.job_id])).rows[0];
  const p=(await c.query('SELECT * FROM offer_plans WHERE tenant_id=$1 AND id=$2'+suffix,
    [actor.tenantId,m.plan_id])).rows[0];
  if(j?.tenant_id!==actor.tenantId || j.id!==m.job_id || j.kind!=='offer.write'
    || j.state!=='failed' || Number(j.attempts)!==1 || Number(j.max_attempts)!==1
    || j.lease_token!==null || j.locked_at!==null
    || !isDeepStrictEqual(j.payload,{plan_id:m.plan_id,actor_id:actor.userId,channel_id:ch.id})
    || p?.tenant_id!==actor.tenantId || p.id!==m.plan_id || p.actor_id!==actor.userId
    || p.channel_id!==ch.id || p.job_id!==j.id || p.operation!=='sync'
    || p.product_id!==listing.product_id || p.listing_id!==listing.id
    || p.warehouse_id!==listing.warehouse_id || p.state!=='conflict' || p.phase!=='ready'
    || p.result!==null)return {};
  return {'listing-sync':{request_id:m.request_id,job_id:m.job_id!,plan_id:m.plan_id!}};
}
// A new deliberate sync has its own immutable audit carrier. Legacy settings are never rewritten.
const predecessorSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('initial')}),
 z.strictObject({kind:z.enum(['legacy','current']),request_id:z.uuid(),plan_id:z.uuid(),job_id:z.uuid()}),
]);
const desiredSchema=z.strictObject({price:z.number().int().nonnegative().safe(),currency:z.literal('PLN'),stock:z.number().int().nonnegative().safe()});
const currentPreviewSchema=z.strictObject({schema:z.literal('local-woo-current-sync/v1'),request_id:z.uuid(),plan_id:z.uuid(),product_id:z.uuid(),listing_id:z.uuid(),warehouse_id:z.uuid(),predecessor:predecessorSchema,desired:desiredSchema});
const currentQueuedSchema=currentPreviewSchema.extend({sequence:z.number().int().positive().safe(),job_id:z.uuid()});
const currentPreviewInput=z.strictObject({channel_id:z.uuid(),request_id:z.uuid()});
const currentQueueInput=currentPreviewInput.extend({plan_id:z.uuid(),predecessor:predecessorSchema});
type CurrentQueued=z.infer<typeof currentQueuedSchema>;
type CurrentPredecessor=z.infer<typeof predecessorSchema>;
const CURRENT_INTENT='integration.woocommerce.current_sync.preview_intent';
const CURRENT_FAILED='integration.woocommerce.current_sync.preview_failed_before_queue';
const intentSchema=z.strictObject({request_id:z.uuid(),product_id:z.uuid(),listing_id:z.uuid(),warehouse_id:z.uuid(),predecessor:predecessorSchema});
const CURRENT_PREVIEW='integration.woocommerce.current_sync.preview';
const CURRENT_QUEUED='integration.woocommerce.current_sync.queued';
async function syncFact(c:PoolClient,actor:Actor,ch:any,listing:any,ref:{request_id:string;plan_id:string;job_id:string},desired?:z.infer<typeof desiredSchema>) {
 const j=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2',[actor.tenantId,ref.job_id])).rows[0];
 const p=(await c.query('SELECT * FROM offer_plans WHERE tenant_id=$1 AND id=$2',[actor.tenantId,ref.plan_id])).rows[0];
 ensure(j?.tenant_id===actor.tenantId&&j.id===ref.job_id&&j.kind==='offer.write'
  &&isDeepStrictEqual(j.payload,{plan_id:ref.plan_id,actor_id:actor.userId,channel_id:ch.id})
  &&Number(j.max_attempts)===1&&Number(j.attempts)===1
  &&p?.tenant_id===actor.tenantId&&p.id===ref.plan_id&&p.actor_id===actor.userId
  &&p.channel_id===ch.id&&p.job_id===j.id&&p.operation==='sync'&&p.listing_id===listing.id
  &&p.product_id===listing.product_id&&p.warehouse_id===listing.warehouse_id
  &&p.input?.operation==='sync'&&p.input.stock===true&&p.input.price===true,
  409,'Oryginalne powiązanie synchronizacji zmieniło się');
 if(desired)ensure(isDeepStrictEqual(desired,desiredSchema.parse({price:Number(p.local_snapshot?.price),currency:p.local_snapshot?.currency,stock:Number(p.payload?.stock_quantity)})),409,'Podgląd ceny i stanu zmienił się');
 const released=j.lease_token===null&&j.locked_at===null;
 const done=released&&j.state==='done'&&p.state==='done'&&p.phase==='done'
  &&p.result?.scope==='local_simulation'&&p.result.desired_applied===true
  &&isDeepStrictEqual(p.result.requested_payload,p.payload)&&isDeepStrictEqual(p.result.verified_payload,p.payload);
 const beforeWrite=released&&j.state==='failed'&&['conflict','failed'].includes(p.state)
  &&p.phase==='ready'&&p.result===null;
 return {...ref,state:done?'acknowledged' as const:beforeWrite?'failed_before_write' as const:'unsettled' as const,
  job_state:String(j.state),plan_state:String(p.state),phase:String(p.phase),lease_active:!released,
  result:done?{scope:'local_simulation',desired_applied:true,requested_payload:p.result.requested_payload,verified_payload:p.result.verified_payload}:null};
}
async function currentSyncHead(c:PoolClient,actor:Actor,ch:any,listing:any) {
 const e=await attachedEnvelope(c,actor,ch,listing);
 const rows=(await c.query(`SELECT action,detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3
  AND action=ANY($4::text[]) ORDER BY created_at,id`,[actor.tenantId,actor.userId,ch.id,[CURRENT_INTENT,CURRENT_PREVIEW,CURRENT_FAILED,CURRENT_QUEUED]])).rows;
 const intents=new Map<string,z.infer<typeof intentSchema>>(),previews=new Map<string,z.infer<typeof currentPreviewSchema>>(),failed=new Set<string>();
 for(const row of rows.filter(r=>r.action===CURRENT_INTENT)){const i=intentSchema.parse(row.detail);ensure(!intents.has(i.request_id),409,'Powtórzona intencja');intents.set(i.request_id,i);}
 for(const row of rows.filter(r=>r.action===CURRENT_PREVIEW)){const p=currentPreviewSchema.parse(row.detail);ensure(!previews.has(p.request_id),409,'Powtórzony podgląd');previews.set(p.request_id,p);}
 for(const row of rows.filter(r=>r.action===CURRENT_FAILED)){const f=intentSchema.parse(row.detail);ensure(!failed.has(f.request_id)&&isDeepStrictEqual(intents.get(f.request_id),f),409,'Obcy wynik intencji');failed.add(f.request_id);}
 for(const i of intents.values())ensure(i.product_id===listing.product_id&&i.listing_id===listing.id&&i.warehouse_id===listing.warehouse_id,409,'Obca intencja synchronizacji');
 for(const p of previews.values()){const {schema,plan_id,desired,...i}=p;ensure(isDeepStrictEqual(intents.get(p.request_id),i)&&!failed.has(p.request_id),409,'Podgląd nie należy do intencji');}
 const pending=[...intents.values()].filter(i=>!previews.has(i.request_id)&&!failed.has(i.request_id));
 ensure(pending.length<=1,409,'Niejednoznaczna aktywna intencja podglądu');
 const records=rows.filter(r=>r.action===CURRENT_QUEUED).map(r=>currentQueuedSchema.parse(r.detail)).sort((a,b)=>a.sequence-b.sequence);
 let predecessor:CurrentPredecessor={kind:'initial'},allowed=true;
 const legacy=e.steps['listing-sync'];
 const otherUnsettled=Object.entries(e.steps).some(([step,m])=>step!=='listing-sync'&&m?.state!=='acknowledged');
 if(legacy){ensure(legacy.plan_id&&legacy.job_id,409,'Brak oryginalnego powiązania poprzedniej synchronizacji');
  predecessor={kind:'legacy',request_id:legacy.request_id,plan_id:legacy.plan_id,job_id:legacy.job_id};
  const fact=await syncFact(c,actor,ch,listing,predecessor);
  allowed=fact.state==='acknowledged'||Boolean((await failedBeforeWrite(c,actor,ch,listing,e))['listing-sync']);
 }
 const seen=new Set<string>();let current:Awaited<ReturnType<typeof syncFact>>|null=null;
 for(let i=0;i<records.length;i++){
  const r=records[i],{sequence,job_id,...preview}=r;
  ensure(allowed&&r.sequence===i+1&&r.product_id===listing.product_id&&r.listing_id===listing.id
   &&r.warehouse_id===listing.warehouse_id&&isDeepStrictEqual(r.predecessor,predecessor)
   &&isDeepStrictEqual(previews.get(r.request_id),preview)&&![r.request_id,r.plan_id,r.job_id].some(id=>seen.has(id)),409,'Niejednoznaczna historia bieżącej synchronizacji');
  for(const id of [r.request_id,r.plan_id,r.job_id])seen.add(id);
  current=await syncFact(c,actor,ch,listing,r,r.desired);allowed=current.state!=='unsettled';
  predecessor={kind:'current',request_id:r.request_id,plan_id:r.plan_id,job_id:r.job_id};
 }
 return {scope:'local_simulation' as const,provider_verified:false as const,channel_id:ch.id,product_id:listing.product_id,listing_id:listing.id,
  predecessor,can_preview:allowed&&!otherUnsettled&&pending.length===0,current,pending_preview:pending[0]?{request_id:pending[0].request_id}:null,
  history:records.map(r=>({request_id:r.request_id,plan_id:r.plan_id,job_id:r.job_id,sequence:r.sequence,desired:r.desired}))};
}
async function currentPreviewRecord(c:PoolClient,actor:Actor,ch:any,requestId:string) {
 const rows=(await c.query(`SELECT detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3
  AND action=$4 AND detail->>'request_id'=$5 ORDER BY id LIMIT 2`,[actor.tenantId,actor.userId,ch.id,CURRENT_PREVIEW,requestId])).rows;
 ensure(rows.length===1,404,'Brak dokładnego oryginalnego podglądu synchronizacji');return currentPreviewSchema.parse(rows[0].detail);
}

async function writeEnvelope(c:PoolClient, actor:Actor, channelId:string, e:Envelope) {
  await c.query(`UPDATE channels SET settings=jsonb_set(settings,'{local_woo_flow}',$3::jsonb,true)
    WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,channelId,JSON.stringify(e)]);
}

/** No route registration, global tick, arbitrary processor or serialized claim input.
 * The actual route must retain its original req.actor and its full lifetime/drain.
 */
export function createLocalWooFlow() {
  const claims=new WeakMap<object,{job:Job;actor:Actor;input:Input}>();
  const active=new Set<Promise<unknown>>();
  let closing=false;
  let closePromise:Promise<void>|undefined;
  function owned<T>(body:()=>Promise<T>):Promise<T> {
    ensure(!closing,503,'Lokalny procesor kończy pracę');
    ensure(active.size<8,503,'Osiągnięto limit aktywnych lokalnych operacji');
    // Invoke synchronously; capture the entire operation before the caller can await it.
    const p=body(); active.add(p);
    void p.then(()=>active.delete(p),()=>active.delete(p));
    return p;
  }
  async function readCurrent(actor:Actor,channelId:string,requestId?:string) {
   channelId=z.uuid().parse(channelId);if(requestId)z.uuid().parse(requestId);
   return tenantReadTx(actor.tenantId,async c=>{const {ch,listing}=await cohort(c,actor,channelId,false,true),head=await currentSyncHead(c,actor,ch,listing);
    if(!requestId)return head;
    const intentRows=(await c.query(`SELECT action,detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3 AND action=ANY($4::text[]) AND detail->>'request_id'=$5`,[actor.tenantId,actor.userId,ch.id,[CURRENT_INTENT,CURRENT_PREVIEW,CURRENT_FAILED],requestId])).rows;
    ensure(intentRows.filter(r=>r.action===CURRENT_INTENT).length===1,404,'Brak oryginalnej intencji');
    if(!intentRows.some(r=>r.action===CURRENT_PREVIEW))return {...head,request:{request_id:requestId,state:intentRows.some(r=>r.action===CURRENT_FAILED)?'failed_before_queue' as const:'preview_pending' as const,can_queue:false,plan_id:null,job_id:null,result:null}};
    const preview=await currentPreviewRecord(c,actor,ch,requestId);
    ensure(preview.product_id===listing.product_id&&preview.listing_id===listing.id&&preview.warehouse_id===listing.warehouse_id,409,'Podgląd nie należy do tej oferty');
    const queued=head.history.find(r=>r.request_id===requestId);
    const p=(await c.query('SELECT * FROM offer_plans WHERE tenant_id=$1 AND id=$2',[actor.tenantId,preview.plan_id])).rows[0];
    ensure(p?.actor_id===actor.userId&&p.channel_id===ch.id&&p.listing_id===listing.id&&p.product_id===listing.product_id
     &&p.warehouse_id===listing.warehouse_id&&p.operation==='sync',409,'Oryginalny plan zmienił się');
    const fact=queued?await syncFact(c,actor,ch,listing,queued,queued.desired):null;
    return {...head,request:{...preview,state:fact?.state??'preview' as const,
     can_queue:!queued&&head.can_preview&&isDeepStrictEqual(head.predecessor,preview.predecessor)&&p.state==='preview'&&p.job_id===null,
     job_id:queued?.job_id??null,result:fact?.result??null}};
   });
  }
  async function previewCurrent(actor:Actor,raw:unknown) {
   const input=currentPreviewInput.parse(raw);
   const seed=await tenantTx(actor.tenantId,async c=>{const {ch,listing}=await cohort(c,actor,input.channel_id,true),head=await currentSyncHead(c,actor,ch,listing);
    ensure(head.can_preview,409,'Poprzednia synchronizacja wymaga odczytu; nowy klucz nie odblokuje zapisu');
    ensure(!Object.values(envelope(ch,listing,actor).steps).some(m=>m?.request_id===input.request_id),409,'Oryginalny klucz poprzedniej próby jest zachowany');
    const old=await c.query(`SELECT id FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3 AND action=$4 AND detail->>'request_id'=$5`,[actor.tenantId,actor.userId,ch.id,CURRENT_INTENT,input.request_id]);
    ensure(old.rowCount===0,409,'Ten podgląd był już wysłany; odczytaj wynik');
    const intent=intentSchema.parse({request_id:input.request_id,product_id:listing.product_id,listing_id:listing.id,warehouse_id:listing.warehouse_id,predecessor:head.predecessor});
    await audit(c,actor,CURRENT_INTENT,ch.id,intent);return {listing,predecessor:head.predecessor,intent};
   });
   try{const p=await previewOffer(actor,input.channel_id,offerInput.parse({operation:'sync',product_id:seed.listing.product_id,
    listing_id:seed.listing.id,warehouse_id:seed.listing.warehouse_id,stock:true,price:true}),localOnly);
   await tenantTx(actor.tenantId,async c=>{const {ch,listing}=await cohort(c,actor,input.channel_id,true),head=await currentSyncHead(c,actor,ch,listing);
    ensure(head.pending_preview?.request_id===input.request_id&&isDeepStrictEqual(head.predecessor,seed.predecessor),409,'Poprzednik zmienił się podczas podglądu');
    const old=await c.query(`SELECT id FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3 AND action=$4 AND detail->>'request_id'=$5`,[actor.tenantId,actor.userId,ch.id,CURRENT_PREVIEW,input.request_id]);ensure(old.rowCount===0,409,'Podgląd już zapisany');
    const fresh=(await c.query('SELECT * FROM offer_plans WHERE tenant_id=$1 AND id=$2',[actor.tenantId,p.id])).rows[0];
    ensure(fresh?.state==='preview'&&fresh.job_id===null&&fresh.actor_id===actor.userId&&fresh.channel_id===ch.id
     &&fresh.listing_id===listing.id&&fresh.product_id===listing.product_id&&fresh.warehouse_id===listing.warehouse_id&&fresh.operation==='sync',409,'Brak nowego własnego planu');
    const carrier=currentPreviewSchema.parse({schema:'local-woo-current-sync/v1',request_id:input.request_id,plan_id:p.id,
     product_id:listing.product_id,listing_id:listing.id,warehouse_id:listing.warehouse_id,predecessor:seed.predecessor,
     desired:{price:Number(fresh.local_snapshot.price),currency:fresh.local_snapshot.currency,stock:Number(fresh.payload.stock_quantity)}});
    await audit(c,actor,CURRENT_PREVIEW,ch.id,carrier);
   });return readCurrent(actor,input.channel_id,input.request_id);
   }catch(first){try{await tenantTx(actor.tenantId,async c=>{const {ch}=await cohort(c,actor,input.channel_id,true);
    const rows=await c.query(`SELECT id FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3 AND action=ANY($4::text[]) AND detail->>'request_id'=$5`,[actor.tenantId,actor.userId,ch.id,[CURRENT_PREVIEW,CURRENT_FAILED],input.request_id]);
    if(rows.rowCount===0)await audit(c,actor,CURRENT_FAILED,ch.id,seed.intent);
   });}catch{}throw first;}
  }
  async function queueCurrent(actor:Actor,raw:unknown) {
   const input=currentQueueInput.parse(raw);let queued:CurrentQueued|undefined;
   try{
    const h=await tenantTx(actor.tenantId,async c=>{
     // Match queueOffer lock order: catalogue first, then plan, channel/listing.
     await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['catalog:'+actor.tenantId]);
     await currentAdmin(c,actor);
     const p=(await c.query('SELECT * FROM offer_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,input.plan_id])).rows[0];
     const {ch,listing}=await cohort(c,actor,input.channel_id,true),head=await currentSyncHead(c,actor,ch,listing),preview=await currentPreviewRecord(c,actor,ch,input.request_id);
     ensure(head.can_preview&&isDeepStrictEqual(head.predecessor,input.predecessor)&&isDeepStrictEqual(preview.predecessor,input.predecessor)
      &&!head.history.some(r=>r.request_id===input.request_id),409,'Aktualna lub niepewna próba blokuje nowy zapis; odczytaj oryginał');
     ensure(preview.plan_id===input.plan_id&&preview.product_id===listing.product_id&&preview.listing_id===listing.id&&preview.warehouse_id===listing.warehouse_id
      &&p?.state==='preview'&&p.job_id===null&&p.actor_id===actor.userId&&p.channel_id===ch.id&&p.listing_id===listing.id
      &&p.product_id===listing.product_id&&p.warehouse_id===listing.warehouse_id&&p.operation==='sync',409,'Wyłącznie dokładny nowy podgląd');
     ensure(isDeepStrictEqual(preview.desired,desiredSchema.parse({price:Number(p.local_snapshot?.price),currency:p.local_snapshot?.currency,stock:Number(p.payload?.stock_quantity)})),409,'Oryginalny podgląd ceny i stanu zmienił się');
     const job=await queueOffer(c,actor,p.id,false),original:Input={channel_id:ch.id,request_id:input.request_id,step:'listing-sync'};
     const held=await claim(c,actor,original,job.job_id,'offer.write',{plan_id:p.id,actor_id:actor.userId,channel_id:ch.id});
     queued=currentQueuedSchema.parse({...preview,sequence:head.history.length+1,job_id:held.id});await audit(c,actor,CURRENT_QUEUED,ch.id,queued);
     return {job:held,original};
    });
    const handle=Object.freeze({id:h.job.id});claims.set(handle,{job:h.job,actor,input:h.original});await execute(handle);
    await tenantTx(actor.tenantId,async c=>{const {ch,listing}=await cohort(c,actor,input.channel_id,true),head=await currentSyncHead(c,actor,ch,listing);
     ensure(head.current?.request_id===input.request_id&&head.current.state==='acknowledged',409,'Wynik własnego procesora wymaga odczytu');
     await audit(c,actor,'integration.woocommerce.current_sync.ack',ch.id,{request_id:input.request_id,plan_id:input.plan_id,job_id:queued!.job_id,scope:'local_simulation'});
    });return await readCurrent(actor,input.channel_id,input.request_id);
   }catch(first){if(queued)try{await tenantTx(actor.tenantId,async c=>{await currentAdmin(c,actor);await audit(c,actor,'integration.woocommerce.current_sync.unknown',input.channel_id,
    {request_id:input.request_id,plan_id:input.plan_id,job_id:queued!.job_id,original_no_retry:true});});}catch{}throw first;}
  }

  async function claim(c:PoolClient,actor:Actor,input:Input,id:string,kind:string,payload:unknown) {
    const j=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [actor.tenantId,id])).rows[0];
    ensure(j?.kind===kind && j.state==='pending' && Number(j.attempts)===0
      && j.lease_token===null && j.locked_at===null && isDeepStrictEqual(j.payload,payload),
      409,'Wyłącznie dokładne nowe zadanie bez wcześniejszej próby lub dzierżawy');
    const held=(await c.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=1,
      locked_at=now(),lease_token=$3 WHERE tenant_id=$1 AND id=$2 AND kind=$4
      AND state='pending' AND attempts=0 AND lease_token IS NULL AND locked_at IS NULL RETURNING *`,
      [actor.tenantId,id,randomUUID(),kind])).rows[0];
    ensure(held,409,'Nowa dzierżawa nie została przyznana');
    return held as Job;
  }
  async function begin(actor:Actor,input:Input) {
    return tenantTx(actor.tenantId,async c=>{
      const {ch,listing}=await cohort(c,actor,input.channel_id,true);
      const e=envelope(ch,listing,actor);
      ensure(!e.steps[input.step] && !Object.values(e.steps).some(s=>s?.request_id===input.request_id),
        409,'Ten etap był już wysłany; odczytaj wynik bez ponowienia');
      const unsettled=Object.entries(e.steps).filter(([,m])=>m?.state!=='acknowledged');
      if(unsettled.length) {
        const proof:FailedBeforeWrite=input.step==='cancel-status' && unsettled.length===1 && unsettled[0][0]==='listing-sync'
          ? await failedBeforeWrite(c,actor,ch,listing,e,true) : {};
        ensure(Boolean(proof['listing-sync']),409,'Niepewny etap blokuje nowe zapisy; odczytaj oryginalny wynik');
      }
      const marker:Marker={request_id:input.request_id,state:'sent'};
      if(input.step==='order-stage') {
        marker.source_order_id=randomInt(1,0xffffffffffff);
        const credentials=decrypt(ch.credentials);
        ensure(!ch.sync_actor_id || ch.sync_actor_id===actor.userId,409,'Webhook ma innego administratora');
        if(!credentials.webhook_secret)credentials.webhook_secret=randomBytes(32).toString('hex');
        await c.query('UPDATE channels SET credentials=$3,sync_actor_id=$4 WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId,ch.id,encrypt(credentials),actor.userId]);
      }
      e.steps[input.step]=marker;
      await writeEnvelope(c,actor,ch.id,e);
      await audit(c,actor,'integration.woocommerce.local_flow.sent',ch.id,
        {request_id:input.request_id,step:input.step,scope:'local_simulation'});
      return {listing,marker};
    });
  }
  async function attach(c:PoolClient,actor:Actor,input:Input,job:Job,refs:Partial<Marker>) {
    const {ch,listing}=await cohort(c,actor,input.channel_id,true);
    const e=envelope(ch,listing,actor),m=e.steps[input.step];
    ensure(m?.request_id===input.request_id && m.state==='sent' && !m.job_id,
      409,'Intencja etapu zmieniła się lub już otrzymała zadanie');
    if(input.step==='order-stage') {
      Object.assign(m,refs,{job_id:job.id});
      await writeEnvelope(c,actor,ch.id,e);
    } else {
      const ref=attachmentSchema.parse({request_id:m.request_id,step:input.step,
        job_id:job.id,plan_id:refs.plan_id});
      await audit(c,actor,'integration.woocommerce.local_flow.attached',ch.id,ref);
    }
    return job;
  }
  async function queue(actor:Actor,input:Input,listing:any,marker:Marker):Promise<Claim> {
    let job:Job;
    if(input.step==='order-stage') {
      job=await tenantTx(actor.tenantId,async c=>{
        const {ch,listing:now}=await cohort(c,actor,input.channel_id,true);
        ensure(now.id===listing.id,409,'Oferta zmieniła się');
        const price=Number(now.price);
        ensure(Number.isSafeInteger(price) && price>0 && price<=2147483647,422,'Wymagana dodatnia cena PLN');
        const money=(price/100).toFixed(2);
        const payload={id:marker.source_order_id,status:'on-hold',currency:'PLN',date_paid:null,
          payment_method:'bacs',shipping_total:'0.00',shipping_tax:'0.00',total:money,
          billing:{first_name:'Lokalny',last_name:'Woo',email:'local-woo@example.test',
            address_1:'Testowa 1',city:'Warszawa',postcode:'00-001',country:'PL',phone:''},
          customer_note:'Lokalna symulacja Woo: '+input.request_id,
          line_items:[{id:1,product_id:now.external_id,variation_id:0,name:now.product_name,
            sku:now.sku,quantity:1,total:money,total_tax:'0.00'}],fee_lines:[]};
        const body=Buffer.from(JSON.stringify(payload)),secret=decrypt(ch.credentials).webhook_secret;
        ensure(secret && ch.sync_actor_id===actor.userId,409,'Bieżąca konfiguracja webhooka zmieniła się');
        const admitted=await receiveWooWebhookInTx(c,ch.id,body,{
          'x-wc-webhook-signature':createHmac('sha256',secret).update(body).digest('base64'),
          'x-wc-webhook-topic':'order.created','x-wc-webhook-delivery-id':input.request_id});
        ensure(!admitted.duplicate,409,'Istniejąca dostawa wymaga wyłącznie odczytu');
        const delivery=(await c.query('SELECT id FROM webhook_deliveries WHERE tenant_id=$1 AND job_id=$2',
          [actor.tenantId,admitted.job_id])).rows;
        ensure(delivery.length===1,409,'Brak dokładnej własnej dostawy');
        const held=await claim(c,actor,input,admitted.job_id,'webhook.stage',
          {channel_id:ch.id,actor_id:actor.userId,delivery_id:delivery[0].id});
        return attach(c,actor,input,held,{delivery_id:delivery[0].id,body_hash:createHash('sha256').update(body).digest('hex')});
      });
    } else if(input.step==='listing-sync') {
      const p=await previewOffer(actor,input.channel_id,offerInput.parse({operation:'sync',
        product_id:listing.product_id,listing_id:listing.id,warehouse_id:listing.warehouse_id,
        stock:true,price:true}),localOnly);
      job=await tenantTx(actor.tenantId,async c=>{
        await currentAdmin(c,actor);
        await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['catalog:'+actor.tenantId]);
        const fresh=(await c.query('SELECT * FROM offer_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [actor.tenantId,p.id])).rows[0];
        ensure(fresh?.state==='preview' && fresh.job_id===null && fresh.actor_id===actor.userId
          && fresh.channel_id===input.channel_id && fresh.listing_id===listing.id && fresh.operation==='sync',
          409,'Wyłącznie nowy własny plan synchronizacji');
        await cohort(c,actor,input.channel_id,true);
        const queued=await queueOffer(c,actor,p.id,false);
        const held=await claim(c,actor,input,queued.job_id,'offer.write',
          {plan_id:p.id,actor_id:actor.userId,channel_id:input.channel_id});
        return attach(c,actor,input,held,{plan_id:p.id});
      });
    } else {
      const order=await tenantTx(actor.tenantId,async c=>{
        const {ch,listing:now}=await cohort(c,actor,input.channel_id);
        const e=envelope(ch,now,actor),source=e.steps['order-stage'];
        ensure(source?.state==='acknowledged',409,'Najpierw potwierdź własne źródłowe zamówienie');
        const rs=(await c.query(`SELECT o.id,o.status FROM inbound_orders i JOIN orders o
          ON (o.tenant_id,o.id)=(i.tenant_id,i.order_id) WHERE i.tenant_id=$1 AND i.channel_id=$2
          AND i.external_id=$3 AND i.state='imported'`,[actor.tenantId,ch.id,String(source.source_order_id)])).rows;
        ensure(rs.length===1 && rs[0].status==='cancelled',409,'Wymagane rzeczywiste anulowanie własnego zamówienia');
        return rs[0];
      });
      const p=await previewStatus(actor,order.id,localOnly);
      job=await tenantTx(actor.tenantId,async c=>{
        await currentAdmin(c,actor);
        const fresh=(await c.query('SELECT * FROM order_status_plans WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId,p.id])).rows[0];
        ensure(fresh?.state==='preview' && fresh.job_id===null && fresh.actor_id===actor.userId
          && fresh.channel_id===input.channel_id && fresh.order_id===order.id,
          409,'Wyłącznie nowy własny plan statusu');
        // Preserve original queue lock order: order -> channel -> plan. Do not lock channel first.
        const queued=await queueStatusInTx(c,actor,p.id,false);
        const held=await claim(c,actor,input,queued.job_id,'order.status.write',
          {plan_id:p.id,actor_id:actor.userId});
        return attach(c,actor,input,held,{plan_id:p.id});
      });
    }
    // A tenantTx COMMIT refusal reaches no mint. Never reconstruct this identity from saved JSON.
    const h=Object.freeze({id:job.id});claims.set(h,{job,actor,input});return h;
  }
  async function execute(h:Claim) {
    const held=claims.get(h);ensure(held,403,'Obca dzierżawa lokalnego zadania');claims.delete(h);
    const {job}=held;
    try {
      if(job.kind==='offer.write')await processOfferJob(job,localOnly);
      else if(job.kind==='webhook.stage')await processIntegrationJob(job,localOnly);
      else if(job.kind==='order.status.write')await processStatusWrite(job,localOnly);
      else throw new Problem(403,'Niedozwolony procesor');
    } catch(first) {
      try {
        if(job.kind==='offer.write')await failOffer(job,first);
        else if(job.kind==='order.status.write')await failStatusJob(job,first);
        else await tenantTx(job.tenant_id,c=>c.query(`UPDATE jobs SET state='failed',error=$3,
          lease_token=NULL,locked_at=NULL WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_token=$4`,
          [job.tenant_id,job.id,'Lokalny etap wymaga odczytu',job.lease_token]));
      } catch { /* The original processor refusal is primary; no write replay. */ }
      throw first;
    }
  }
  async function read(actor:Actor,channelId:string) {
    channelId=z.uuid().parse(channelId);
    return tenantReadTx(actor.tenantId,async c=>{
      const {ch,listing}=await cohort(c,actor,channelId,false,true),e=await attachedEnvelope(c,actor,ch,listing);
      const ids=Object.values(e.steps).flatMap(s=>s?.job_id?[s.job_id]:[]);
      const jobs=ids.length?(await c.query('SELECT id,kind,state,attempts,max_attempts,lease_token FROM jobs WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
        [actor.tenantId,ids])).rows:[];
      // Read only the original acknowledged stage's own committed import.
      let imported_order:{id:string;number:string;status:string}|null=null;
      const source=e.steps['order-stage'];
      if(source?.state==='acknowledged') {
        ensure(Number.isSafeInteger(source.source_order_id) && source.source_order_id!>0,
          409,'Nieprawidłowe oryginalne źródło zamówienia');
        const orders=(await c.query(`SELECT o.id,o.number,o.status FROM inbound_orders i JOIN orders o
          ON (o.tenant_id,o.id)=(i.tenant_id,i.order_id)
          AND o.channel_id=i.channel_id AND o.external_id=i.external_id
          WHERE i.tenant_id=$1 AND i.channel_id=$2 AND i.external_id=$3 AND i.state='imported'
          ORDER BY o.id LIMIT 2`,[actor.tenantId,ch.id,String(source.source_order_id)])).rows;
        ensure(orders.length<=1,409,'Niejednoznaczne własne importowane zamówienie');
        if(orders.length===1) {
          const {id,number,status}=orders[0];
          imported_order={id,number,status};
        }
      }
      return {scope:'local_simulation' as const,provider_verified:false as const,channel_id:ch.id,
        product_id:listing.product_id,listing_id:listing.id,steps:e.steps,imported_order,
        failed_before_write:await failedBeforeWrite(c,actor,ch,listing,e),
        jobs:jobs.map(({lease_token,...j})=>({...j,lease_active:lease_token!==null}))};
    });
  }
  async function complete(actor:Actor,input:Input) {
    await tenantTx(actor.tenantId,async c=>{
      const {ch,listing}=await cohort(c,actor,input.channel_id,true),e=await attachedEnvelope(c,actor,ch,listing),m=e.steps[input.step];
      ensure(m?.request_id===input.request_id && m.state==='sent' && m.job_id,409,'Brak oryginalnej intencji');
      const j=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2',[actor.tenantId,m.job_id])).rows[0];
      ensure(j?.state==='done' && Number(j.attempts)===1 && Number(j.max_attempts)===1
        && j.lease_token===null && j.locked_at===null,409,'Wynik procesora wymaga odczytu');
      if(input.step==='order-stage') {
        const delivery=(await c.query(`SELECT * FROM webhook_deliveries WHERE tenant_id=$1 AND id=$2
          AND channel_id=$3 AND job_id=$4`,[actor.tenantId,m.delivery_id,ch.id,j.id])).rows[0];
        ensure(j.kind==='webhook.stage' && j.payload.channel_id===ch.id && j.payload.actor_id===actor.userId
          && j.payload.delivery_id===m.delivery_id && delivery?.delivery_id===input.request_id && delivery.body_hash===m.body_hash
          && delivery.topic==='order.created' && delivery.payload?.id===m.source_order_id
          && delivery.payload.customer_note==='Lokalna symulacja Woo: '+input.request_id
          && Array.isArray(delivery.payload.line_items) && delivery.payload.line_items.length===1
          && delivery.payload.line_items[0].product_id===listing.external_id
          && delivery.payload.line_items[0].sku===listing.sku && delivery.payload.line_items[0].quantity===1,
          409,'Dostawa nie jest oryginalnym własnym źródłem');
        const rows=(await c.query(`SELECT id,state,raw,normalized,source_hash,issues FROM inbound_orders
          WHERE tenant_id=$1 AND channel_id=$2 AND external_id=$3`,
          [actor.tenantId,ch.id,String(m.source_order_id)])).rows;
        const inbound=rows[0],normalized=normalizeOrder('woocommerce',delivery.payload,ch.settings);
        ensure(rows.length===1 && inbound.state==='staged' && Array.isArray(inbound.issues)
          && inbound.issues.length===0 && inbound.normalized && normalized.blockers.length===0
          && isDeepStrictEqual(inbound.raw,delivery.payload)
          && inbound.source_hash===importSourceHash(delivery.payload)
          && isDeepStrictEqual(inbound.normalized,normalized),
          409,'Źródłowe zamówienie nie ma potwierdzonego użytecznego stagingu');
      } else {
        const table=input.step==='listing-sync'?'offer_plans':'order_status_plans';
        const p=(await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,m.plan_id])).rows[0];
        ensure(p?.state==='done' && p.phase==='done' && p.job_id===j.id && p.channel_id===ch.id,
          409,'Brak rzeczywistego zakończenia własnego planu');
        if(input.step==='listing-sync')ensure(p.result?.scope==='local_simulation'
          && p.result.desired_applied===true && p.listing_id===listing.id,409,'Brak wyniku własnej oferty');
      }
      m.state='acknowledged';await writeEnvelope(c,actor,ch.id,e);
      await audit(c,actor,'integration.woocommerce.local_flow.ack',ch.id,{request_id:input.request_id,step:input.step,job_id:j.id});
    });
  }
  return Object.freeze({
    read:(actor:Actor,channelId:string)=>owned(()=>read(actor,channelId)),
    readCurrent:(actor:Actor,channelId:string,requestId?:string)=>owned(()=>readCurrent(actor,channelId,requestId)),
    previewCurrent:(actor:Actor,input:unknown)=>owned(()=>previewCurrent(actor,input)),
    queueCurrent:(actor:Actor,input:unknown)=>owned(()=>queueCurrent(actor,input)),
    run:(actor:Actor,raw:unknown)=>owned(async()=>{
      const input=inputSchema.parse(raw);ensure(actor.role==='admin',403,'Wymagana sesja administratora');
      let begun=false;
      try {
        const {listing,marker}=await begin(actor,input);begun=true;
        const h=await queue(actor,input,listing,marker);await execute(h);await complete(actor,input);
        return await read(actor,input.channel_id);
      } catch(first) {
        if(begun)try {await tenantTx(actor.tenantId,async c=>{
          const {ch,listing}=await cohort(c,actor,input.channel_id,true),e=await attachedEnvelope(c,actor,ch,listing),m=e.steps[input.step];
          if(m?.request_id===input.request_id && m.state!=='acknowledged'){
            m.state='unknown';await writeEnvelope(c,actor,ch.id,e);
          }
        });}catch { /* No repair, resend or first-error substitution. */ }
        throw first;
      }
    }),
    close:()=>{
      closing=true;
      return closePromise??=Promise.allSettled([...active]).then(()=>{});
    },
  });
}
