import type{PoolClient}from'pg';
import{createHash}from'node:crypto';
import{DeliveryRefusal,reconcileDelivery,type DeliveryEvent,type SmsDeliveryCode}from'./sms-delivery';
import type{SmsLiveReceipt}from'./sms-live-transport';
export type SmsEndpoint={id:string;tenantId:string;channelId:string;account:string;enabled:boolean};
type Client=Pick<PoolClient,'query'>;
export async function pinSmsSubmissionIntent(c:Client,m:{id:string;tenant_id:string;channel_id:string;batch_id:string},endpointId:string){
  const e=(await c.query('SELECT id,channel_id,account_username,callback_url,channel_hash FROM sms_delivery_endpoints WHERE tenant_id=$1 AND id=$2 AND enabled FOR SHARE',[m.tenant_id,endpointId])).rows[0];
  if(!e||e.channel_id!==m.channel_id)throw new DeliveryRefusal(409);
  await c.query(`INSERT INTO sms_delivery_submissions(tenant_id,message_id,channel_id,endpoint_id,idx)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,message_id) DO NOTHING`,[m.tenant_id,m.id,m.channel_id,e.id,m.id.replaceAll('-','')]);
  const s=(await c.query('SELECT * FROM sms_delivery_submissions WHERE tenant_id=$1 AND message_id=$2 FOR UPDATE',[m.tenant_id,m.id])).rows[0];
  if(!s||s.channel_id!==m.channel_id||s.endpoint_id!==e.id||s.idx!==m.id.replaceAll('-',''))throw new DeliveryRefusal(409);
  return e;
}
async function applyAcceptedEvents(c:Client,s:any){
  const events=(await c.query(`SELECT * FROM sms_delivery_events WHERE tenant_id=$1 AND message_id=$2
    ORDER BY provider_done_at,event_hash`,[s.tenant_id,s.message_id])).rows;
  let state={code:s.status_code as SmsDeliveryCode|null,doneAt:Number(s.provider_done_at),needsReconciliation:s.needs_reconciliation as boolean};
  for(const e of events){
    if(e.provider_id!==s.provider_id||Number(e.provider_sent_at)!==Number(s.provider_sent_at)){state={...state,needsReconciliation:true};continue;}
    state=reconcileDelivery(state,{providerId:e.provider_id,code:e.status_code,sentAt:Number(e.provider_sent_at),doneAt:Number(e.provider_done_at),account:'',recipient:'',idx:s.idx}).state;
  }
  await c.query(`UPDATE sms_delivery_submissions SET status_code=$3,provider_done_at=$4,needs_reconciliation=$5,updated_at=now()
    WHERE tenant_id=$1 AND message_id=$2`,[s.tenant_id,s.message_id,state.code,state.doneAt,state.needsReconciliation]);
}
// Caller uses ONE tenantTx. Receipt linkage + all early callbacks commit together.
export async function registerSmsAcceptedReceipt(c:Client,tenantId:string,messageId:string,receipt:SmsLiveReceipt){
  const s=(await c.query(`SELECT s.*,m.recipient,b.mode,b.channel_id AS batch_channel_id FROM sms_delivery_submissions s
    JOIN sms_messages m ON(m.tenant_id,m.id)=(s.tenant_id,s.message_id)
    JOIN sms_batches b ON(b.tenant_id,b.id)=(m.tenant_id,m.batch_id)
    WHERE s.tenant_id=$1 AND s.message_id=$2 FOR UPDATE OF s`,[tenantId,messageId])).rows[0];
  if(!s||s.tenant_id!==tenantId||s.message_id!==messageId||s.mode!=='provider_live'||s.channel_id!==s.batch_channel_id||s.idx!==receipt.idx||s.recipient!==receipt.recipient)throw new DeliveryRefusal(409);
  if(s.provider_id!==null&&(s.provider_id!==receipt.providerId||Number(s.provider_sent_at)!==receipt.providerSentAt))throw new DeliveryRefusal(409);
  await c.query(`UPDATE sms_delivery_submissions SET provider_id=$3,provider_sent_at=$4,accepted_at=coalesce(accepted_at,now()),updated_at=now()
    WHERE tenant_id=$1 AND message_id=$2`,[tenantId,messageId,receipt.providerId,receipt.providerSentAt]);
  s.provider_id=receipt.providerId;s.provider_sent_at=receipt.providerSentAt;
  await applyAcceptedEvents(c,s);
  await c.query(`UPDATE sms_messages SET state='submitted',error=NULL,result=$3,updated_at=now()
    WHERE tenant_id=$1 AND id=$2 AND state IN('queued','uncertain')`,[tenantId,messageId,JSON.stringify({provider_id:receipt.providerId,idx:receipt.idx,date_sent:receipt.providerSentAt,status:receipt.status,delivered:false,submission_accepted:true})]);
}
export async function reconcileSmsSubmissionCallback(c:Client,endpoint:SmsEndpoint,events:DeliveryEvent[]){
  if(!endpoint.enabled)throw new DeliveryRefusal(404);
  for(const event of events){
    const s=(await c.query(`SELECT s.*,m.recipient,m.attempted_at,b.mode,b.channel_id AS batch_channel_id,ch.provider
      FROM sms_delivery_submissions s JOIN sms_messages m ON(m.tenant_id,m.id)=(s.tenant_id,s.message_id)
      JOIN sms_batches b ON(b.tenant_id,b.id)=(m.tenant_id,m.batch_id)
      JOIN channels ch ON(ch.tenant_id,ch.id)=(s.tenant_id,s.channel_id)
      WHERE s.tenant_id=$1 AND s.channel_id=$2 AND (s.provider_id=$3 OR(s.provider_id IS NULL AND s.idx=$4)) FOR UPDATE OF s`,[endpoint.tenantId,endpoint.channelId,event.providerId,event.idx])).rows[0];
    if(!s||s.tenant_id!==endpoint.tenantId||s.channel_id!==endpoint.channelId||s.endpoint_id!==endpoint.id||!s.attempted_at||s.mode!=='provider_live'||s.provider!=='smsapi'||s.batch_channel_id!==endpoint.channelId||event.account!==endpoint.account||event.recipient!==s.recipient||event.idx!==s.idx)throw new DeliveryRefusal(404);
    const key=createHash('sha256').update(JSON.stringify([event.providerId,event.code,event.sentAt,event.doneAt])).digest('hex');
    await c.query(`INSERT INTO sms_delivery_events(tenant_id,message_id,event_hash,provider_id,provider_sent_at,status_code,provider_done_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,message_id,event_hash) DO NOTHING`,[endpoint.tenantId,s.message_id,key,event.providerId,event.sentAt,event.code,event.doneAt]);
    // Race: keep authenticated receipt before API ACK, but do not label delivered until accepted ID/time match.
    if(s.provider_id!==null)await applyAcceptedEvents(c,s);
  }
}
