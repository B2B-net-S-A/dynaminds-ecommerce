import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {OrderAction} from './operation-schema';
import {ensure} from './errors';
import {isLocalWooOrigin} from '../shared/local-woo-origins';

// Core domain events freeze facts here without loading db, domain or offers.
export type LocalStockAction=Extract<OrderAction,{type:'sync_local_woo_stock'}>;
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const automaticChannelHash=(ch:any)=>createHash('sha256').update(JSON.stringify(canonical({id:ch.id,tenant_id:ch.tenant_id,provider:ch.provider,mode:ch.mode,settings:ch.settings,credentials:ch.credentials}))).digest('hex');

export async function automaticStockChannel(c:PoolClient,tenant:string,owner:string,action:LocalStockAction){
 const ch=(await c.query('SELECT * FROM channels WHERE tenant_id=$1 AND id=$2 FOR SHARE',[tenant,action.channel_id])).rows[0];
 const setting=ch?.settings,fixture=setting?.local_http_fixture;
 ensure(ch?.id===action.channel_id&&ch.tenant_id===tenant&&ch.provider==='woocommerce'&&ch.mode==='sandbox'&&ch.sync_enabled===false&&setting?.simulation===false
  &&fixture?.schema==='local-woo-http-fixture/v1'&&fixture.owner_id===owner
  &&typeof fixture.fixture_id==='string'&&isLocalWooOrigin(setting.store_url),422,'Wymagany własny skonfigurowany lokalny sklep Woo');
 ensure(!action.channel_hash||action.channel_hash===automaticChannelHash(ch),409,'Lokalny kanał Woo zmienił się od zdarzenia');
 return ch;
}

export async function freezeAutomaticStockActions(c:PoolClient,tenant:string,owner:string,actions:OrderAction[],strict=false):Promise<OrderAction[]>{
 const frozen:OrderAction[]=[];
 for(const action of actions){
  if(action.type!=='sync_local_woo_stock'){frozen.push(action);continue;}
  try{const ch=await automaticStockChannel(c,tenant,owner,action);frozen.push({...action,channel_hash:action.channel_hash??automaticChannelHash(ch)});}
  catch(error){if(strict)throw error;frozen.push({...action,channel_hash:'0'.repeat(64)});}
 }
 return frozen;
}
