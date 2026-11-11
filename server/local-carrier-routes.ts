import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {tenantTx} from './db';
import {audit,type Actor} from './domain';
import {ensure,Problem} from './errors';
import {packingShippingActor} from './packing-shipping-binding';
import {trackingConnection} from './tracking-connection';
import {lockedShipping,queueShipping,processShipping,failShipping,shippingCloseFailure} from './shipping';
import {localCarrierParams,localCarrierBind,localCarrierRun,localCarrierMarker,
 assertLocalCarrierSession,assertLocalCarrierChannel,assertLocalCarrierPlan,assertFreshLocalCarrierJob,type LocalCarrierReceipt} from './local-carrier-values';

// Code-owned refusal transport: an unexpected channel edit cannot turn this route
// into a paid or externally contacted shipment. This is not a positive simulator.
const localTransport=async(_url:string,_init:RequestInit):Promise<Response>=>{throw new Problem(423,'Lokalny proces odmawia zewnętrznego połączenia przewoźnika');};
async function currentRole(c:PoolClient,a:Actor){
 const m=(await c.query('SELECT public.packing_current_role($1,true) AS role',[a.userId])).rows[0];
 ensure(m&&m.role===a.role&&['admin','operator'].includes(m.role),403,'Zmieniło się uprawnienie realizacji przesyłek');
}
async function originalReceipt(c:PoolClient,a:Actor,order:string,request:string):Promise<LocalCarrierReceipt>{
 const rows=(await c.query("SELECT detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3 AND action='local.carrier.bind'",
 [a.tenantId,a.userId,request])).rows;
 ensure(rows.length===1&&rows[0].detail?.source===localCarrierMarker&&rows[0].detail.order_id===order&&rows[0].detail.request_id===request,
  404,'Brak własnej trwałej próby przewoźnika');return rows[0].detail;
}
async function sameChannel(c:PoolClient,r:LocalCarrierReceipt){
 const ch=(await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE',[r.channel_id])).rows[0];assertLocalCarrierChannel(ch);
 ensure(trackingConnection(ch)===r.channel_hash,409,'Lokalny kanał zmienił się od powiązania próby');return ch;
}
async function readback(c:PoolClient,a:Actor,r:LocalCarrierReceipt){
 const p=(await c.query('SELECT * FROM shipping_plans WHERE id=$1',[r.plan_id])).rows[0];assertLocalCarrierPlan(p,r,a);
 const jobs=(await c.query(`SELECT id,kind,state,attempts,max_attempts,error,payload->>'action' action FROM jobs
 WHERE tenant_id=$1 AND kind='shipping' AND payload->>'plan_id'=$2 ORDER BY created_at,id`,[a.tenantId,r.plan_id])).rows;
 const stages=(await c.query(`SELECT action,detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3
 AND action IN ('local.carrier.quote-started','local.carrier.buy-started','local.carrier.quote-finished','local.carrier.buy-finished') ORDER BY created_at,id`,
 [a.tenantId,a.userId,r.request_id])).rows;
 const shipment=p.shipment_id?(await c.query(`SELECT id,order_id,carrier,mode,tracking_number,status,dispatched_at,tracking_data,tracking_revision
 FROM shipments WHERE tenant_id=$1 AND id=$2`,[a.tenantId,p.shipment_id])).rows[0]:null;
 const order=(await c.query('SELECT id,status,version FROM orders WHERE tenant_id=$1 AND id=$2',[a.tenantId,r.order_id])).rows[0];
 return {scope:'local_simulation',request_id:r.request_id,order_id:r.order_id,plan_id:r.plan_id,channel_id:r.channel_id,
  plan:{id:p.id,state:p.state,phase:p.phase,job_id:p.job_id,shipment_id:p.shipment_id,offers:p.offers,selected_offer:p.selected_offer,result:p.result,error:p.error},
  jobs,stages,shipment,order,automatic_retry:false,paid_shipment:false,provider_verified:false};
}
export function registerLocalCarrierRoutes(app:FastifyInstance,options:{readOnly:boolean}){
 const root='/api/orders/:id/local-carrier/:request';
 app.post(root+'/bind',async(req,reply)=>{
  const a=packingShippingActor(req);assertLocalCarrierSession(a,req.apiScopes,options.readOnly);
  const p=localCarrierParams.parse(req.params),b=localCarrierBind.parse(req.body);
  const result=await tenantTx(a.tenantId,async c=>{
   await currentRole(c,a);await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[a.tenantId]);
   ensure(!(await c.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND action='local.carrier.bind' AND entity_id=$2",[a.tenantId,p.request])).rowCount,
    409,'Próba już istnieje; odczytaj tę samą tożsamość, nie ponawiaj');
   const {p:plan,o}=await lockedShipping(c,b.plan_id);
   ensure(plan.order_id===p.id&&plan.actor_id===a.userId&&plan.state==='preview'&&plan.phase==='ready'&&!plan.job_id&&!plan.shipment_id,
    409,'Wymagany własny nieuruchomiony podgląd');
   ensure(o.status==='packed'&&new Date(plan.created_at).getTime()>Date.now()-15*60000,
    409,'Wymagany aktualny podgląd spakowanego zamówienia');
   ensure((await c.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3 AND action='order.create'",[a.tenantId,a.userId,p.id])).rowCount,
    403,'Wymagane własne zamówienie');
   ensure(!(await c.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND action='local.carrier.bind' AND detail->>'plan_id'=$2",[a.tenantId,b.plan_id])).rowCount,
    409,'Plan przypisano już do próby');
   const ch=(await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE',[plan.channel_id])).rows[0];assertLocalCarrierChannel(ch);
   const r:LocalCarrierReceipt={source:localCarrierMarker,request_id:p.request,order_id:p.id,plan_id:plan.id,channel_id:ch.id,channel_hash:trackingConnection(ch)};
   assertLocalCarrierPlan(plan,r,a);await audit(c,a,'local.carrier.bind',p.request,r);
   return {...r,status:'BOUND',scope:'local_simulation',automatic_retry:false,paid_shipment:false};
  });return reply.code(201).send(result);
 });
 app.get(root,async req=>{
  const a=req.actor;assertLocalCarrierSession(a,req.apiScopes,false);const p=localCarrierParams.parse(req.params);z.strictObject({}).parse(req.query);
  return tenantTx(a.tenantId,async c=>{await currentRole(c,a);return readback(c,a,await originalReceipt(c,a,p.id,p.request));});
 });
 app.post(root+'/run',async(req,reply)=>{
  const a=packingShippingActor(req);assertLocalCarrierSession(a,req.apiScopes,options.readOnly);
  const p=localCarrierParams.parse(req.params),b=localCarrierRun.parse(req.body);
  let claimed:any=null,r:LocalCarrierReceipt|undefined,first:unknown,phase='claim-own-new-job';const cleanup:string[]=[];
  try{
   claimed=await tenantTx(a.tenantId,async c=>{
    await currentRole(c,a);await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[a.tenantId]);
    r=await originalReceipt(c,a,p.id,p.request);
    ensure(!(await c.query('SELECT id FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action=$3',
      [a.tenantId,p.request,'local.carrier.'+b.action+'-started'])).rowCount,409,'Etap już rozpoczęto; nie ponawiaj niepewnego wyniku');
    const {p:plan}=await lockedShipping(c,r.plan_id);assertLocalCarrierPlan(plan,r,a);await sameChannel(c,r);
    if(b.action==='quote'){
     ensure(plan.state==='preview'&&plan.phase==='ready'&&!plan.job_id,409,'Wycena już zlecona; użyj odczytu');
     await queueShipping(c,a,plan.id,false);
    }
    const current=(await c.query('SELECT * FROM shipping_plans WHERE id=$1',[r.plan_id])).rows[0];
    const j=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,current.job_id])).rows[0];
    assertFreshLocalCarrierJob(j,current,r,a,b.action);
    await audit(c,a,'local.carrier.'+b.action+'-started',p.request,{source:localCarrierMarker,order_id:p.id,plan_id:r.plan_id,job_id:j.id});
    const held=(await c.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=1,locked_at=now(),lease_token=$3
     WHERE tenant_id=$1 AND id=$2 AND state='pending' AND attempts=0 AND lease_token IS NULL AND locked_at IS NULL AND run_at<=now() RETURNING *`,
     [a.tenantId,j.id,randomUUID()])).rows[0];ensure(held,409,'Nie udało się przejąć nowego własnego zadania');return held;
   });
   phase='existing-processShipping';await processShipping(claimed,{transport:localTransport});const completedJob=claimed;claimed=null;
   phase='actual-owned-readback';
   const result=await tenantTx(a.tenantId,async c=>{
    await currentRole(c,a);await sameChannel(c,r!);const facts=await readback(c,a,r!);
    const done=facts.jobs.find((j:any)=>j.id===completedJob.id);
    ensure(done?.state==='done'&&Number(done.attempts)===1,409,'Zadanie nie potwierdziło lokalnego zakończenia');
    ensure(b.action==='quote'?facts.plan.state==='quoted'&&facts.plan.offers.length>0:
     facts.plan.state==='ready'&&facts.shipment?.mode==='demo'&&facts.shipment.order_id===r!.order_id,
     409,'Nie potwierdzono oczekiwanego etapu symulatora');
    await audit(c,a,'local.carrier.'+b.action+'-finished',p.request,{source:localCarrierMarker,plan_id:r!.plan_id,job_id:completedJob.id});
    return facts;
   });return reply.code(201).send({...result,status:'OWNED_LOCAL_CARRIER_STAGE_DONE',stage:b.action,job_id:completedJob.id});
  }catch(error){
   first=error;if(claimed)try{await failShipping(claimed,error);}catch{cleanup.push('owned-shipping-failure-cleanup');}
   const secondary=shippingCloseFailure(first);if(secondary)cleanup.push('owned-shipping-client-close');
   return reply.code(first instanceof Problem?first.status:500).send({status:'LOCAL_CARRIER_STAGE_NOT_CONFIRMED',scope:'local_simulation',
    request_id:p.request,order_id:p.id,plan_id:r?.plan_id??null,job_id:claimed?.id??null,failed_phase:phase,
    error_code:first instanceof Problem?first.code??null:null,cleanup,effects_unknown:true,automatic_retry:false,paid_shipment:false,provider_verified:false});
  }
 });
}
