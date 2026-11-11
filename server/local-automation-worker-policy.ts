import {isDeepStrictEqual} from 'node:util';
import {normalizedRule} from './operation-schema';
import {ensure} from './errors';
export const WORKER_SCHEMA='owned-automatic-rule/v1';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supported=new Set(['add_note','add_tag','remove_tag','set_workflow','set_status','sync_local_woo_stock']);
export type Activation={schema:typeof WORKER_SCHEMA;enabled:boolean;owner_id:string;rule_version:string;enabled_at:string;client_key:string};
export function supportedAutomaticRule(rule:any){
 const d=normalizedRule(rule);return d.trigger!=='customer_message.received'&&d.actions.length>0&&d.actions.every(a=>supported.has(a.type)||a.type==='email'&&a.mode==='smtp'&&a.confirm_external===false);
}
export function activationForRule(rule:any):Activation|null{
 const x=rule?.config?.local_worker;if(x===undefined)return null;
 ensure(x&&Object.keys(x).sort().join(',')==='client_key,enabled,enabled_at,owner_id,rule_version,schema'&&x.schema===WORKER_SCHEMA
  &&typeof x.enabled==='boolean'&&typeof x.owner_id==='string'&&uuid.test(x.owner_id)&&typeof x.client_key==='string'&&uuid.test(x.client_key)&&typeof x.rule_version==='string'&&/^[1-9]\d*$/.test(x.rule_version)
  &&typeof x.enabled_at==='string'&&Number.isFinite(Date.parse(x.enabled_at)),409,'Niepoprawna konfiguracja lokalnego workera');
 if(!x.enabled||!rule.enabled||rule.actor_id!==x.owner_id||String(rule.version)!==x.rule_version)return null;
 ensure(supportedAutomaticRule(rule),422,'Reguła wymaga nieobsługiwanej lokalnie akcji');return {...x};
}
export function assertUnattempted(job:any,tenant:string,kind:string){
 ensure(job&&job.tenant_id===tenant&&job.kind===kind&&job.state==='pending'&&Number(job.attempts)===0&&job.lease_token===null&&job.locked_at===null,409,'Wyłącznie nieuruchomione własne zadanie');
}
export function sameDefinition(current:any,frozen:any){
 const a=normalizedRule(current),b=normalizedRule(frozen);
 // Existing event() freezes workflow versions separately; the original action path verifies them.
 const strip=(d:any)=>({...d,actions:d.actions.map((x:any,index:number)=>{
  const frozen=x.type==='set_workflow'?['status_version']:x.type==='email'?['template_version','channel_hash']:x.type==='sync_local_woo_stock'?['channel_hash']:[];
  // Source-frozen versions are checked by the existing action processor. An
  // explicitly configured version/hash is still part of the rule definition.
  return Object.fromEntries(Object.entries(x).filter(([k])=>!frozen.includes(k)||(a.actions[index] as any)?.[k]!==undefined));
 })});
 return isDeepStrictEqual(strip(a),strip(b));
}
export function assertFrozenEntry(rule:any,frozen:any){
 ensure(frozen&&frozen.id===rule.id&&frozen.tenant_id===rule.tenant_id&&frozen.actor_id===rule.actor_id&&String(frozen.version)===String(rule.version)
  &&sameDefinition(rule,frozen),409,'Definicja zdarzenia nie odpowiada włączonej regule');
}
