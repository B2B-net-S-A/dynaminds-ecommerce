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
    Object.assign(m,refs,{job_id:job.id});
    await writeEnvelope(c,actor,ch.id,e);
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
      const {ch,listing}=await cohort(c,actor,channelId,false,true),e=envelope(ch,listing,actor);
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
        jobs:jobs.map(({lease_token,...j})=>({...j,lease_active:lease_token!==null}))};
    });
  }
  async function complete(actor:Actor,input:Input) {
    await tenantTx(actor.tenantId,async c=>{
      const {ch,listing}=await cohort(c,actor,input.channel_id,true),e=envelope(ch,listing,actor),m=e.steps[input.step];
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
    run:(actor:Actor,raw:unknown)=>owned(async()=>{
      const input=inputSchema.parse(raw);ensure(actor.role==='admin',403,'Wymagana sesja administratora');
      let begun=false;
      try {
        const {listing,marker}=await begin(actor,input);begun=true;
        const h=await queue(actor,input,listing,marker);await execute(h);await complete(actor,input);
        return await read(actor,input.channel_id);
      } catch(first) {
        if(begun)try {await tenantTx(actor.tenantId,async c=>{
          const {ch,listing}=await cohort(c,actor,input.channel_id,true),e=envelope(ch,listing,actor),m=e.steps[input.step];
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
