import {isDeepStrictEqual} from 'node:util';
import {ensure} from './errors';
import type {Transport} from './integrations';
import type {LocalWooOrigin} from './local-woo-http-transport';

/** A second boundary refuses every write or other resource even if the processor regresses. */
export function observedOfferTransport(transport:Transport,target:{id:string;sku:string},origin:LocalWooOrigin):Transport{
 const id=target.id,url=origin+'/wp-json/wc/v3/products/'+id,sku=target.sku;let sent=false;
 return async(raw,init)=>{
  ensure(!sent&&raw===url&&(init.method??'GET')==='GET'&&init.body===undefined,409,'Uzgodnienie dopuszcza jeden odczyt oryginalnego produktu bez ponownego zapisu');
  const request={...init,method:'GET',headers:new Headers(init.headers)};sent=true;
  const response=await transport(raw,request);
  ensure(response.status===200,502,'Nie potwierdzono jedynego odczytu uzgodnienia; bez ponowienia');
  const product=await response.clone().json();ensure(String(product?.id)===id&&product?.sku===sku&&product?.type==='simple',409,'Odczyt nie potwierdził tożsamości oryginalnego produktu');
  return response;
 };
}

/** Read-only admission of an already attempted stock child. This predicate
 * grants neither a write nor a retry and does not change either job's state. */
export function automaticStockObservationMatches(config:{tenantId:string;userId:string;channelId:string},plan:any,original:any,parents:any[]){
 if(parents.length!==1)return false;
 const parent=parents[0],p=parent?.payload,r=parent?.source_run,index=p?.action_index,action=p?.action;
 if(!Number.isSafeInteger(index)||index<0||!action||action.type!=='sync_local_woo_stock')return false;
 if(!isDeepStrictEqual(action,{type:'sync_local_woo_stock',channel_id:config.channelId,warehouse_id:plan.warehouse_id,
  ...(action.listing_id===undefined?{}:{listing_id:plan.listing_id}),channel_hash:action.channel_hash}))return false;
 if(parent.tenant_id!==config.tenantId||parent.kind!=='automation.local_stock'||parent.state!=='failed'
  ||Number(parent.attempts)!==1||Number(parent.max_attempts)!==1||parent.lease_token!==null||parent.locked_at!==null
  ||parent.physical_source_matches!==true)return false;
 if(p.owner_id!==config.userId||p.listing_id!==plan.listing_id||p.product_id!==plan.product_id
  ||p.effect_plan_id!==plan.id||p.effect_job_id!==original.id
  ||parent.dedup_key!==`automation-stock:${p.run_id}:${index}:${plan.listing_id}`)return false;
 if(!isDeepStrictEqual(p,{run_id:p.run_id,action_index:index,order_id:p.order_id,owner_id:config.userId,
  listing_id:plan.listing_id,product_id:plan.product_id,action,effect_plan_id:plan.id,effect_job_id:original.id}))return false;
 if(action.channel_id!==config.channelId||action.warehouse_id!==plan.warehouse_id
  ||action.listing_id!==undefined&&action.listing_id!==plan.listing_id||!/^[a-f0-9]{64}$/.test(action.channel_hash??''))return false;
 if(!r||r.id!==p.run_id||r.tenant_id!==config.tenantId||r.state!=='done'||r.order_id!==p.order_id
  ||r.definition?.actor_id!==config.userId||!isDeepStrictEqual(r.definition?.actions?.[index],action))return false;
 const queued=r.result?.actions?.[index]?.stock_sync;
 return queued?.state==='queued'&&queued.channel_id===config.channelId&&Array.isArray(queued.job_ids)
  &&isDeepStrictEqual(queued,{state:'queued',channel_id:config.channelId,job_ids:queued.job_ids})
  &&queued.job_ids.length>=1&&queued.job_ids.length<=200&&queued.job_ids.every((id:unknown)=>typeof id==='string')
  &&new Set(queued.job_ids).size===queued.job_ids.length
  &&queued.job_ids.filter((id:unknown)=>id===parent.id).length===1;
}
