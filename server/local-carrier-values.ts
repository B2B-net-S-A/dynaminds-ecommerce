import {z} from 'zod';
import {ensure} from './errors';
import type {Actor} from './domain';
export const localCarrierParams=z.strictObject({id:z.uuid(),request:z.uuid()});
export const localCarrierBind=z.strictObject({plan_id:z.uuid()});
export const localCarrierRun=z.strictObject({action:z.enum(['quote','buy'])});
export const localCarrierMarker='owned-local-carrier/v1';
export type LocalCarrierReceipt={source:typeof localCarrierMarker;request_id:string;order_id:string;plan_id:string;channel_id:string;channel_hash:string};
export function assertLocalCarrierSession(actor:Actor,apiScopes:unknown,readOnly:boolean){
 ensure(!readOnly,423,'Kopia jest tylko do odczytu');
 ensure(['admin','operator'].includes(actor.role)&&!actor.apiKeyId&&!apiScopes,403,'Wymagana sesja realizacji przesyłek');
}
export function assertLocalCarrierChannel(ch:any){
 ensure(ch?.provider==='inpost'&&ch.mode==='sandbox'&&ch.settings?.simulation===true&&ch.status==='local_simulation',
  409,'Wyłącznie istniejący lokalny symulator InPost; brak zewnętrznego zakupu');
}
export function assertLocalCarrierPlan(p:any,r:LocalCarrierReceipt,a:Actor){
 ensure(p?.tenant_id===a.tenantId&&p.actor_id===a.userId&&p.id===r.plan_id&&p.order_id===r.order_id&&p.channel_id===r.channel_id,
  409,'Plan nie należy do tej firmy, autora i własnej próby');
 ensure(!p.input?.provider||p.input.provider==='inpost',422,'Wymagany własny plan InPost');
 ensure(p.input?.channel_id===r.channel_id&&p.payload?.reference==='DYNA-'+p.id,409,'Zmieniła się tożsamość planu');
}
export function assertFreshLocalCarrierJob(j:any,p:any,r:LocalCarrierReceipt,a:Actor,action:'quote'|'buy'){
 const kind=action==='quote'?'create':'buy';
 ensure(j?.tenant_id===a.tenantId&&j.id===p.job_id&&j.kind==='shipping'&&j.state==='pending'&&Number(j.attempts)===0
  &&j.lease_token===null&&j.locked_at===null,409,'Wyłącznie nowe nieuruchomione własne zadanie');
 ensure(j.payload?.plan_id===r.plan_id&&j.payload.actor_id===a.userId&&j.payload.channel_id===r.channel_id&&j.payload.action===kind,
  409,'Zadanie nie odpowiada własnemu planowi i etapowi');
 ensure(action==='quote'?p.state==='queued'&&p.phase==='ready':p.state==='buy_queued'&&p.phase==='buy_ready',
  409,'Etap przesyłki został już rozpoczęty; użyj odczytu, nie ponawiaj');
}
