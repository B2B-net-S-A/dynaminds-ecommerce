import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import type {Actor} from './domain';
import type {EventContext} from './events';
import type {OrderAction} from './operation-schema';
import type {IntegrationContext} from './channel-access';
import {tenantTx} from './db';
import {ensure} from './errors';
import {localSmtpPort} from './smtp';
import {offerInput,previewOffer,queueOffer,processOfferJob,failOffer} from './offers';

import {automaticStockChannel,type LocalStockAction} from './automation-local-channel';
export {automaticChannelHash,automaticStockChannel,freezeAutomaticStockActions} from './automation-local-channel';
export type {LocalStockAction} from './automation-local-channel';

export const AUTOMATIC_STOCK_JOB='automation.local_stock';
export type AutomaticEffectsContext=Pick<IntegrationContext,'transport'> & {localWooChannelIds?:readonly string[]};
function effectError(message:unknown){
 if(typeof message!=='string')return{error_code:null,error_message:null};
 if(['Autor nie jest aktualnym administratorem','Autor utracił rolę administratora','Aktywacja zmieniła się przed wykonaniem'].includes(message))return{error_code:'AUTOMATION_AUTHORITY_CHANGED',error_message:'Autor utracił uprawnienia albo reguła została wyłączona lub zmieniona. Nie ponawiaj starego zadania.'};
 if(['Lokalny kanał Woo zmienił się od zdarzenia','Kanał lokalnego sklepu zmienił się','Kanał lokalnego sklepu zmienił się podczas żądania','Połączenie zmieniło się od podglądu'].includes(message))return{error_code:'AUTOMATION_CHANNEL_CHANGED',error_message:'Połączenie sklepu zmieniło się od przygotowania. Odczytaj pierwotny plan i wynik.'};
 if(['Cena lub stan zmieniły się od podglądu. Przygotuj nowy plan','Dane lokalne zmieniły się podczas odczytu; przygotuj nowy plan lub uzgodnij wynik'].includes(message))return{error_code:'AUTOMATION_STOCK_CHANGED',error_message:'Stan lub dane produktu zmieniły się podczas przygotowania. Odczytaj pierwotny plan; nowa operacja wymaga nowego zdarzenia.'};
 return{error_code:'AUTOMATION_EFFECT_FAILED',error_message:'Efekt reguły nie został potwierdzony. Odczytaj stan pierwotnego zadania i planu; brak automatycznego ponowienia.'};
}

/** Database binding is checked in addition to the construction-owned transport.
 * The transport independently checks its enrolled channel/credentials on every call. */
export async function automaticLocalEmailChannel(c:PoolClient,tenant:string,channelId:string){
 const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2 FOR SHARE',[tenant,channelId])).rows[0];
 ensure(ch?.id===channelId&&ch.tenant_id===tenant&&ch.provider==='smtp'&&ch.mode==='sandbox'&&ch.settings?.delivery==='local_sink'
  &&ch.settings.host==='127.0.0.1'&&Number(ch.settings.port)===localSmtpPort()&&typeof ch.settings.from_email==='string'&&ch.settings.from_email.endsWith('.test'),422,'Automatyczny email wymaga lokalnego SMTP .test');
 return ch;
}
export async function validateAutomaticEffectsInTx(c:PoolClient,tenant:string,owner:string,actions:OrderAction[],allowedChannels?:readonly string[]){
 for(const action of actions){
  if(action.type==='email'){
   ensure(action.mode==='smtp'&&action.channel_id&&action.confirm_external===false,422,'Automatyczny email jest wyłącznie lokalnym SMTP');
   await automaticLocalEmailChannel(c,tenant,action.channel_id);
  }
  if(action.type==='sync_local_woo_stock'){
   if(allowedChannels!==undefined)ensure(allowedChannels.includes(action.channel_id),503,'Lokalny sklep nie jest wybrany w tej aplikacji');
   await automaticStockChannel(c,tenant,owner,action);
   ensure((await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2',[tenant,action.warehouse_id])).rowCount,422,'Magazyn jest spoza organizacji');
   if(action.listing_id)ensure((await c.query('SELECT id FROM listings WHERE tenant_id=$1 AND id=$2 AND channel_id=$3 AND warehouse_id=$4',[tenant,action.listing_id,action.channel_id,action.warehouse_id])).rowCount,422,'Oferta jest spoza wybranego kanału lub magazynu');
  }
 }
}
export async function queueAutomaticStockAction(c:PoolClient,actor:Actor,orderId:string,action:LocalStockAction,context?:EventContext){
 ensure(actor.role==='admin'&&actor.userId,403,'Synchronizacja stanu wymaga administratora');
 await automaticStockChannel(c,actor.tenantId,actor.userId,action);
 const rows=(await c.query(`SELECT DISTINCT l.id,l.product_id,l.warehouse_id FROM order_pick_items i
  JOIN orders o ON(o.tenant_id,o.id)=(i.tenant_id,i.order_id)
  JOIN listings l ON(l.tenant_id,l.product_id)=(i.tenant_id,i.product_id)
  JOIN products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
  WHERE i.tenant_id=$1 AND i.order_id=$2 AND o.warehouse_id=$3 AND l.warehouse_id=$3 AND l.channel_id=$4
   AND p.kind IN('simple','variant') AND l.external_id~'^[1-9][0-9]{0,14}$' AND($5::uuid IS NULL OR l.id=$5)
  ORDER BY l.id LIMIT 201`,[actor.tenantId,orderId,action.warehouse_id,action.channel_id,action.listing_id??null])).rows;
 ensure(rows.length<=200,422,'Limit 200 fizycznych ofert na akcję');
 ensure(!action.listing_id||rows.length===1,422,'Oferta nie jest fizycznym składnikiem tego zamówienia');
 if(context?.preview)return{changed:false,stock_sync:{state:'preview',listing_count:rows.length,channel_id:action.channel_id}};
 ensure(context?.operation?.kind==='rule',422,'Synchronizacja stanu jest akcją trwałej reguły');
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['automation-stock-queue:'+actor.tenantId]);
 ensure(Number((await c.query("SELECT count(*)::int n FROM jobs WHERE (state='pending' OR state='running')")).rows[0].n)+rows.length<=1000,429,'Kolejka synchronizacji reguł jest pełna');
 const jobs=[];
 for(const row of rows){
  const payload={run_id:context.operation.id,action_index:context.operation.action_index,order_id:orderId,owner_id:actor.userId,listing_id:row.id,product_id:row.product_id,action};
  const dedup=`automation-stock:${context.operation.id}:${context.operation.action_index}:${row.id}`;
  const inserted=(await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,$3,$4,$5,1)
   ON CONFLICT(tenant_id,dedup_key) DO NOTHING RETURNING id`,[randomUUID(),actor.tenantId,AUTOMATIC_STOCK_JOB,JSON.stringify(payload),dedup])).rows[0];
  if(inserted)jobs.push(inserted.id);
  else{const old=(await c.query('SELECT id,payload FROM jobs WHERE tenant_id=$1 AND dedup_key=$2',[actor.tenantId,dedup])).rows[0];ensure(old&&isDeepStrictEqual(old.payload,payload),409,'Klucz synchronizacji ma inne źródło');jobs.push(old.id);}
 }
 return{changed:false,stock_sync:{state:jobs.length?'queued':'no_linked_physical_products',job_ids:jobs,channel_id:action.channel_id}};
}

/** One newly claimed identity only. Unknown attempts remain held for readback,
 * never reclaimed by this worker after restart. Existing offer code owns all
 * source/stock fences, remote write and verified readback. */
export async function processAutomaticStock(job:any,context:AutomaticEffectsContext,guard:(c:PoolClient)=>Promise<void>){
 ensure(context.transport&&context.localWooChannelIds?.includes(job.payload.action.channel_id),503,'Brak transportu wybranego lokalnego sklepu');
 const actor:Actor={tenantId:job.tenant_id,userId:job.payload.owner_id,role:'admin'};
 const check=async(c:PoolClient)=>{
  await guard(c);
  ensure((await c.query("SELECT id FROM jobs WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_token=$3 FOR UPDATE",[job.tenant_id,job.id,job.lease_token])).rowCount,409,'Dzierżawa synchronizacji nie jest bieżąca');
  await automaticStockChannel(c,job.tenant_id,actor.userId!,job.payload.action);
 };
 await tenantTx(job.tenant_id,check);
 const transport:NonNullable<IntegrationContext['transport']>=async(url,init)=>{await tenantTx(job.tenant_id,check);return context.transport!(url,init);};
 const ctx={transport};let child:any;
 try{
  const input=offerInput.parse({operation:'sync',product_id:job.payload.product_id,listing_id:job.payload.listing_id,warehouse_id:job.payload.action.warehouse_id,stock:true,price:false});
  const preview=await previewOffer(actor,job.payload.action.channel_id,input,ctx);
  child=await tenantTx(job.tenant_id,async c=>{
   await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',['catalog:'+job.tenant_id]);
   await check(c);
   const plan=(await c.query('SELECT * FROM offer_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[job.tenant_id,preview.id])).rows[0];
   ensure(plan?.actor_id===actor.userId&&plan.channel_id===job.payload.action.channel_id&&plan.listing_id===job.payload.listing_id
    &&plan.product_id===job.payload.product_id&&plan.operation==='sync'&&plan.state==='preview'&&plan.input.stock===true&&plan.input.price===false
    &&Object.keys(plan.payload).sort().join(',')==='backorders,manage_stock,stock_quantity',409,'Plan nie jest własną synchronizacją samego stanu');
   const queued=await queueOffer(c,actor,plan.id,false);
   const claimed=(await c.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=1,locked_at=now(),lease_token=$3
    WHERE tenant_id=$1 AND id=$2 AND kind='offer.write' AND state='pending' AND attempts=0 AND lease_token IS NULL AND locked_at IS NULL RETURNING *`,[job.tenant_id,queued.job_id,randomUUID()])).rows[0];
   ensure(claimed,409,'Nie potwierdzono nowej własnej oferty');
   ensure(isDeepStrictEqual(claimed.payload,{plan_id:plan.id,actor_id:actor.userId,channel_id:job.payload.action.channel_id}),409,'Zadanie oferty ma inne źródło');
   await c.query("UPDATE jobs SET payload=payload||$3::jsonb WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_token=$4",[job.tenant_id,job.id,JSON.stringify({effect_plan_id:plan.id,effect_job_id:claimed.id}),job.lease_token]);return claimed;
  });
  await processOfferJob(child,ctx);
  await tenantTx(job.tenant_id,async c=>{
   await check(c);
   const p=(await c.query('SELECT p.*,j.state job_state FROM offer_plans p JOIN jobs j ON(j.tenant_id,j.id)=(p.tenant_id,p.job_id) WHERE p.tenant_id=$1 AND p.id=$2',[job.tenant_id,child.payload.plan_id])).rows[0];
   ensure(p?.job_id===child.id&&p.actor_id===actor.userId&&p.channel_id===job.payload.action.channel_id&&p.listing_id===job.payload.listing_id
    &&p.product_id===job.payload.product_id&&p.job_state==='done'&&p.state==='done'&&p.phase==='done'&&p.result?.desired_applied===true,409,'Synchronizacja wymaga odczytu oryginalnego wyniku');
   await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL,payload=payload||$4::jsonb WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND state='running'",[job.tenant_id,job.id,job.lease_token,JSON.stringify({verified_stock:p.payload.stock_quantity})]);
  });
 }catch(first){if(child)try{await failOffer(child,first);}catch{/* Preserve the first error; no replay. */}throw first;}
}

/** Readback never repairs or retries a job. Known remote ACKs and an unconfirmed
 * parent remain separate facts, including after a process restart. */
export async function readAutomaticEffectsPage(c:PoolClient,runIds:string[]){
 const grouped=new Map<string,any[]>();for(const id of runIds)grouped.set(id,[]);
 if(!runIds.length)return{effects:grouped,coverage:{per_kind_limit:500,stock_truncated:false,email_truncated:false}};
 const stock=(await c.query(`SELECT j.id,j.state,j.error,j.created_at,j.payload,p.state plan_state,p.phase,p.result,p.payload plan_payload,q.state effect_state
  FROM jobs j LEFT JOIN offer_plans p ON(p.tenant_id,p.id)=(j.tenant_id,(j.payload->>'effect_plan_id')::uuid)
   AND p.job_id::text=j.payload->>'effect_job_id' AND p.actor_id::text=j.payload->>'owner_id'
   AND p.channel_id::text=j.payload->'action'->>'channel_id' AND p.listing_id::text=j.payload->>'listing_id'
   AND p.product_id::text=j.payload->>'product_id' AND p.operation='sync' AND p.input->>'stock'='true' AND p.input->>'price'='false'
  LEFT JOIN jobs q ON(q.tenant_id,q.id)=(p.tenant_id,p.job_id)
  WHERE j.kind='automation.local_stock' AND j.payload->>'run_id'=ANY($1::text[]) ORDER BY j.created_at DESC,j.id DESC LIMIT 501`,[runIds])).rows;
 for(const j of stock.slice(0,500)){
  const verified=j.plan_state==='done'&&j.phase==='done'&&j.effect_state==='done'&&j.result?.desired_applied===true
   &&Number.isSafeInteger(j.plan_payload?.stock_quantity)&&j.plan_payload.stock_quantity>=0;
  const stock=verified?j.plan_payload?.stock_quantity:null;
  const beforeDispatch=!j.payload.effect_job_id||j.phase==='ready'&&['failed','conflict'].includes(j.plan_state)&&j.effect_state==='failed';
  grouped.get(j.payload.run_id)?.push({type:'sync_local_woo_stock',state:j.state,channel_id:j.payload.action?.channel_id,listing_id:j.payload.listing_id,
   job_id:j.id,effect_job_id:j.payload.effect_job_id??null,verified_stock:Number.isSafeInteger(stock)?stock:null,created_at:j.created_at,
   outcome:verified?'VERIFIED':j.state==='pending'?'PENDING':j.state==='failed'&&beforeDispatch?'FAILED_BEFORE_DISPATCH':beforeDispatch?'ATTEMPTED_RECONCILIATION_REQUIRED':'UNKNOWN_WRITE_OR_ACK',
   parent_acknowledged:j.state==='done',reconciliation_required:!verified&&j.state!=='pending',...effectError(j.error),automatic_retry:false});
 }
 const email=(await c.query(`SELECT m.id,m.state,m.error,m.job_id,m.created_at,b.automation_run_id,b.channel_id,j.state job_state
  FROM email_messages m JOIN email_batches b ON(b.tenant_id,b.id)=(m.tenant_id,m.batch_id)
  LEFT JOIN jobs j ON(j.tenant_id,j.id)=(m.tenant_id,m.job_id)
  WHERE b.automation_run_id=ANY($1::uuid[]) ORDER BY m.created_at DESC,m.id DESC LIMIT 501`,[runIds])).rows;
 for(const m of email.slice(0,500))grouped.get(m.automation_run_id)?.push({type:'email',state:m.state,channel_id:m.channel_id,listing_id:null,
  job_id:m.job_id,message_id:m.id,verified_stock:null,created_at:m.created_at,outcome:m.state==='smtp_accepted'?'SMTP_ACCEPTED_NOT_DELIVERED':m.state==='uncertain'?'UNKNOWN_WRITE_OR_ACK':m.state==='failed'?'FAILED_BEFORE_DISPATCH':m.job_state==='running'?'ATTEMPTED_RECONCILIATION_REQUIRED':'PENDING',
  parent_acknowledged:m.job_state==='done',reconciliation_required:m.state==='uncertain'||m.job_state==='running',
  error_code:m.error?'AUTOMATION_EMAIL_FAILED':null,error_message:m.error?'Lokalny email nie został potwierdzony. Sprawdź odbiornik i źródłową regułę; brak automatycznego ponowienia.':null,automatic_retry:false});
 return{effects:grouped,coverage:{per_kind_limit:500,stock_truncated:stock.length>500,email_truncated:email.length>500}};
}
export async function readAutomaticEffects(c:PoolClient,runIds:string[]){return(await readAutomaticEffectsPage(c,runIds)).effects;}

/** Complete own-rule warning, independent of the bounded recent-detail page.
 * This observes durable facts only; it never repairs, claims or retries work. */
export async function readAutomaticRuleReconciliation(c:PoolClient,tenant:string,ruleId:string){
 const row=(await c.query(`SELECT
  EXISTS(SELECT 1 FROM automation_runs r JOIN jobs j ON j.tenant_id=r.tenant_id AND j.payload->>'run_id'=r.id::text
   LEFT JOIN offer_plans p ON(p.tenant_id,p.id)=(j.tenant_id,(j.payload->>'effect_plan_id')::uuid)
    AND p.job_id::text=j.payload->>'effect_job_id' AND p.actor_id::text=j.payload->>'owner_id'
    AND p.channel_id::text=j.payload->'action'->>'channel_id' AND p.listing_id::text=j.payload->>'listing_id'
    AND p.product_id::text=j.payload->>'product_id' AND p.operation='sync' AND p.input->>'stock'='true' AND p.input->>'price'='false'
   LEFT JOIN jobs q ON(q.tenant_id,q.id)=(p.tenant_id,p.job_id)
   WHERE r.tenant_id=$1 AND r.rule_id=$2 AND j.kind='automation.local_stock' AND j.state<>'pending'
    AND (p.state='done' AND p.phase='done' AND q.state='done' AND p.result->'desired_applied'='true'::jsonb
     AND CASE WHEN jsonb_typeof(p.payload->'stock_quantity')='number'
      THEN (p.payload->>'stock_quantity')::numeric BETWEEN 0 AND 9007199254740991
       AND trunc((p.payload->>'stock_quantity')::numeric)=(p.payload->>'stock_quantity')::numeric ELSE false END) IS DISTINCT FROM true) AS stock_required,
  EXISTS(SELECT 1 FROM automation_runs r JOIN email_batches b ON(b.tenant_id,b.automation_run_id)=(r.tenant_id,r.id)
   JOIN email_messages m ON(m.tenant_id,m.batch_id)=(b.tenant_id,b.id)
   LEFT JOIN jobs j ON(j.tenant_id,j.id)=(m.tenant_id,m.job_id)
   WHERE r.tenant_id=$1 AND r.rule_id=$2 AND (m.state='uncertain' OR j.state='running')) AS email_required`,[tenant,ruleId])).rows[0];
 ensure(typeof row?.stock_required==='boolean'&&typeof row?.email_required==='boolean',503,'Niepotwierdzony pełny status skutków reguły');
 return{scope:'ALL_OWN_RULE_RUNS' as const,stock_required:row.stock_required as boolean,email_required:row.email_required as boolean,required:row.stock_required===true||row.email_required===true};
}
