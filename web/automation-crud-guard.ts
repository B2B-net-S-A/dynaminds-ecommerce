import {ApiError} from './api';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const version=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d*$/.test(v);
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const equal=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export type RuleWriteAttempt={schema:'automation-crud-attempt/v1';context:string;attempt_id:string;kind:'create'|'edit'|'toggle';rule_id:string|null;version:string|null;expected:any;baseline_ids:string[];ack_id:string|null;phase:'sent'|'unknown'|'acknowledged'|'confirmed'|'refused'};
const pending=(a:RuleWriteAttempt|null)=>!!a&&!['confirmed','refused'].includes(a.phase);
export const automationCrudKey=(context:string)=>'dyna:automation-crud:v1:'+context;
const leaf=(c:any)=>({...c,...(typeof c.value==='string'?{value:c.value.trim()}:{})});
/** This is UI normalization, not validation authority; the normal server still parses every write. */
function definition(v:any){
 if(!v||typeof v.name!=='string'||typeof v.trigger!=='string'||!Array.isArray(v.actions)||!Array.isArray(v.conditions))throw Error('Niepełna definicja reguły.');
 const clean=JSON.parse(JSON.stringify(v));
 const actions=clean.actions.map((a:any)=>{
  if(['add_note','add_tag','remove_tag'].includes(a.type))return{...a,...(typeof a.note==='string'?{note:a.note.trim()}:{}),...(typeof a.tag==='string'?{tag:a.tag.trim()}:{} )};
  return {...a,...(['email','sms'].includes(a.type)?{mode:a.mode??'local'}:{}),...(a.type==='email'?{confirm_external:a.confirm_external??false}:{})};
 });
 return{name:clean.name.trim(),trigger:clean.trigger,enabled:clean.enabled??true,priority:clean.priority??50,delay_seconds:clean.delay_seconds??0,match:clean.match??'all',conditions:clean.conditions.map((c:any)=>c?.group?{group:{...c.group,conditions:Array.isArray(c.group.conditions)?c.group.conditions.map(leaf):c.group.conditions}}:leaf(c)),actions};
}
export function parseRuleWriteAttempt(raw:string|null,context:string):RuleWriteAttempt|null{
 if(raw===null)return null;if(raw.length>131072)throw Error('Niepełny zapis próby reguły; zapis zablokowany.');const a=JSON.parse(raw);
 if(!a||!equal(Object.keys(a).sort(),['schema','context','attempt_id','kind','rule_id','version','expected','baseline_ids','ack_id','phase'].sort())||a.schema!=='automation-crud-attempt/v1'||a.context!==context||!uuid(a.attempt_id)||!['create','edit','toggle'].includes(a.kind)||!['sent','unknown','acknowledged','confirmed','refused'].includes(a.phase)||!Array.isArray(a.baseline_ids)||a.baseline_ids.length>100||a.baseline_ids.some((x:unknown)=>!uuid(x))||new Set(a.baseline_ids).size!==a.baseline_ids.length||!(a.ack_id===null||uuid(a.ack_id))||!(a.kind==='create'?a.rule_id===null&&a.version===null:uuid(a.rule_id)&&version(a.version))||!equal(definition(a.expected),a.expected))throw Error('Niepełny zapis próby reguły; zapis zablokowany.');
 if((a.phase==='acknowledged'||a.phase==='confirmed'&&a.kind==='create')&&!uuid(a.ack_id)||a.kind!=='create'&&!a.baseline_ids.includes(a.rule_id)||a.ack_id&&(a.kind==='create'?a.baseline_ids.includes(a.ack_id):a.ack_id!==a.rule_id))throw Error('Niespójna tożsamość zapisanej próby reguły.');return a;
}
type Ports={context:string;request:(path:string,method?:string,body?:unknown)=>Promise<any>;read:(key:string)=>string|null;write:(key:string,value:string)=>void;lock:<T>(key:string,fn:()=>Promise<T>)=>Promise<T>;current:()=>boolean;newId:()=>string};
export function createAutomationCrudGuard(p:Ports){
 const parts=p.context.split(':');if(parts.length!==2||!parts.every(uuid))throw Error('Brak kontekstu administratora.');const[tenant,user]=parts,key=automationCrudKey(p.context);
 let submitting=false;
 const load=()=>parseRuleWriteAttempt(p.read(key),p.context);
 const save=(a:RuleWriteAttempt)=>{if(JSON.stringify(a).length>131072)throw Error('Próba reguły przekracza limit zapisu.');p.write(key,JSON.stringify(a));};
 const current=()=>{if(!p.current())throw Error('Widok lub uprawnienia zmieniły się. Odczytaj właściwą organizację.');};
 async function actor(){current();const me=await p.request('/auth/me');current();if(me.restore_preview||me.user?.tenant_id!==tenant||me.user?.id!==user||me.user?.role!=='admin')throw Error('Wymagana bieżąca sesja administratora tej firmy.');}
 async function list(){current();const v=await p.request('/automations');current();if(!Array.isArray(v?.data)||v.data.length>100||v.data.some((r:any)=>!uuid(r.id)||r.tenant_id!==tenant||!version(r.version))||new Set(v.data.map((r:any)=>r.id)).size!==v.data.length)throw Error('Niepotwierdzona lista reguł tej firmy.');return v.data as any[];}
 const matches=(r:any,a:RuleWriteAttempt)=>r?.tenant_id===tenant&&r.actor_id===user&&equal(definition(r.definition??{...r,...r.config}),a.expected);
 async function readback(a:RuleWriteAttempt){
  await actor();const rows=await list();await actor();const remembered=load();if(!remembered||remembered.attempt_id!==a.attempt_id)throw Error('Próba zmieniła się w innej karcie.');
  const expectedVersion=a.kind==='create'?'1':String(BigInt(a.version!)+1n);
  const id=a.ack_id??a.rule_id;
  const known=id?rows.find(r=>r.id===id):null;
  const confirmed=!!known&&known.version===expectedVersion&&matches(known,a);
  const next={...remembered,phase:confirmed?'confirmed' as const:remembered.phase};save(next);
  // A create without ACK has no server request key. Even a unique new exact match
  // is only a candidate, never permission to retry or a causal identity claim.
  const candidates=a.kind==='create'&&!a.ack_id?rows.filter(r=>!a.baseline_ids.includes(r.id)&&r.version==='1'&&matches(r,a)).map(r=>r.id):[];
  return{attempt:next,confirmed,candidate_ids:candidates};
 }
 return{
  inspect:load,
  blocked:()=>pending(load()),
  async reconcile(){return p.lock(key,async()=>{const a=load();if(!a)throw Error('Brak zapisanej próby reguły.');return readback(a);});},
  async submit(raw:any){if(submitting)throw Error('Zapis reguły jest już w toku.');submitting=true;try{const observed=load();if(pending(observed))throw Error('Poprzedni zapis reguły jest niepewny. Użyj odczytu bez ponawiania.');const generation=observed?.attempt_id??null;return await p.lock(key,async()=>{
   current();const previous=load();if((previous?.attempt_id??null)!==generation)throw Error('Inna karta zapisała regułę podczas oczekiwania. Odczytaj wynik; nie ponawiaj tego kliknięcia.');if(pending(previous))throw Error('Poprzedni zapis reguły jest niepewny. Użyj odczytu bez ponawiania.');
   await actor();const baseline=await list();const isEdit=raw.id!==undefined;if(isEdit&&(!uuid(raw.id)||!version(raw.version)))throw Error('Odczytaj bieżącą wersję reguły.');
   const before=isEdit?baseline.find(r=>r.id===raw.id):null;if(isEdit&&before?.version!==raw.version)throw Error('Reguła zmieniła się. Odczytaj ją ponownie.');
   const toggle=isEdit&&Object.keys(raw).every(k=>['id','version','enabled'].includes(k));
   const expected=definition(toggle?{...before.definition,enabled:raw.enabled}:raw);
   await actor();current();if(pending(load()))throw Error('Inna karta zapisała niepewną próbę.');
   if(previous)p.write(key+':archive:'+previous.attempt_id,JSON.stringify(previous));
   let a:RuleWriteAttempt={schema:'automation-crud-attempt/v1',context:p.context,attempt_id:p.newId(),kind:!isEdit?'create':toggle?'toggle':'edit',rule_id:isEdit?raw.id:null,version:isEdit?raw.version:null,expected,baseline_ids:baseline.map(r=>r.id).sort(),ack_id:null,phase:'sent'};
   if(!uuid(a.attempt_id))throw Error('Brak identyfikatora próby.');save(a); // Durable marker before the single mutation.
   try{
    const body=toggle?{enabled:raw.enabled,version:raw.version}:{...expected,...(isEdit?{version:raw.version}:{})};
    const ack=await p.request('/automations'+(isEdit?'/'+raw.id:''),isEdit?'PATCH':'POST',body);
    const expectedVersion=isEdit?String(BigInt(raw.version)+1n):'1';
    if(!uuid(ack?.id)||ack.tenant_id!==tenant||ack.actor_id!==user||ack.version!==expectedVersion||isEdit&&ack.id!==raw.id||!isEdit&&a.baseline_ids.includes(ack.id)||!matches(ack,a))throw Error('Niepotwierdzony zapis reguły. Użyj odczytu bez ponawiania.');
    a={...a,ack_id:ack.id,phase:'acknowledged'};save(a);current();return await readback(a);
   }catch(e){
    const saved=load();if(saved?.attempt_id===a.attempt_id&&saved.phase!=='confirmed'){
     const refused=saved.phase==='sent'&&e instanceof ApiError&&[400,401,403,404,409,422,423,429].includes(e.status);
     save({...saved,phase:refused?'refused':saved.phase==='acknowledged'?'acknowledged':'unknown'});
    }
    throw e;
   }
  });}finally{submitting=false;}}
 };
}
