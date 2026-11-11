import type{FastifyInstance}from'fastify';
import type{PoolClient}from'pg';
import{randomUUID,createHash}from'node:crypto';
import{z}from'zod';
import{DeliveryRefusal,newSmsApiCallbackToken}from'./sms-delivery';
import{decrypt}from'./security';
import{smsLiveRequestAuthority,requireSmsLiveAuthority}from'./sms-live-authority';
import{registerSmsDeliveryCallbacks}from'./sms-delivery-routes';
import{reconcileSmsSubmissionCallback}from'./sms-submission-store';
const setup=z.object({name:z.string().trim().min(2).max(120),sender:z.string().regex(/^[A-Za-z0-9 ._-]{1,11}$/),
 access_token:z.string().min(1).max(4096),account_username:z.string().min(1).max(200).regex(/^[^,\r\n]+$/),
 callback_origin:z.string().url(),confirm_external:z.literal(true)}).strict();
export function registerSmsSubmissionRoutes(app:FastifyInstance,d:{readOnly:boolean;sessionName:string;
 auth:Pick<PoolClient,'query'>;tenantTx:<T>(tenant:string,work:(c:PoolClient)=>Promise<T>)=>Promise<T>;encrypt:(value:unknown)=>string}){
 registerSmsDeliveryCallbacks(app,{readOnly:d.readOnly,resolveEndpoint:async id=>{
  const e=(await d.auth.query(`SELECT e.id,e.tenant_id,e.channel_id,e.account_username,e.enabled,ch.credentials FROM sms_delivery_endpoints e
   JOIN channels ch ON(ch.tenant_id,ch.id)=(e.tenant_id,e.channel_id) WHERE e.id=$1 AND ch.provider='smsapi' AND ch.mode='live'`,[id])).rows[0];
  if(!e)return null;
  let callbackToken:string|null=null;try{const t=decrypt(e.credentials).callback_token;callbackToken=typeof t==='string'?t:null;}catch{callbackToken=null;}
  return{id:e.id,tenantId:e.tenant_id,channelId:e.channel_id,account:e.account_username,enabled:e.enabled,callbackToken};
 },reconcile:(e,reports)=>d.tenantTx(e.tenantId,c=>reconcileSmsSubmissionCallback(c,e,reports))});
 // Existing app onRequest authenticates /api and tenant/read-only policy; this route also fails closed standalone.
 app.post('/api/sms/live-endpoints',{logLevel:'silent'},async req=>{
  if(d.readOnly)throw new DeliveryRefusal(423);
  const a=smsLiveRequestAuthority(req,d.sessionName);await requireSmsLiveAuthority(d.auth,a);
  const b=setup.parse(req.body),origin=new URL(b.callback_origin);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')throw new DeliveryRefusal(422);
  const id=randomUUID(),channelId=randomUUID(),credentials=d.encrypt({access_token:b.access_token,callback_token:newSmsApiCallbackToken()}),settings={sender:b.sender};
  const hash=createHash('sha256').update(JSON.stringify({provider:'smsapi',mode:'live',settings,credentials})).digest('hex');
  const callbackUrl=origin.origin+'/callbacks/smsapi/'+id;
  return d.tenantTx(a.tenantId,async c=>{
   await c.query("INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'smsapi',$3,'live',$4,$5)",[channelId,a.tenantId,b.name,credentials,JSON.stringify(settings)]);
   await c.query('INSERT INTO sms_delivery_endpoints(id,tenant_id,channel_id,account_username,callback_url,channel_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,a.tenantId,channelId,b.account_username,callbackUrl,hash,a.userId]);
   // callback_url is the base; each send appends the secret segment from encrypted credentials (smsApiNotifyUrl).
   return{id,channel_id:channelId,callback_url:callbackUrl,callback_token:'configured'};
  });
 });
 app.get('/api/sms/live-endpoints',{logLevel:'silent'},async req=>{
  const a=smsLiveRequestAuthority(req,d.sessionName);await requireSmsLiveAuthority(d.auth,a);
  return d.tenantTx(a.tenantId,async c=>({data:(await c.query('SELECT id,channel_id,callback_url,enabled FROM sms_delivery_endpoints ORDER BY id LIMIT 100')).rows}));
 });
}
