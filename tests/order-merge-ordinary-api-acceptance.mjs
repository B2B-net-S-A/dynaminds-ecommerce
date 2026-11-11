/** Import-inert ordinary MERGE acceptance. Root supplies existing genuine orders; no SQL, fixture creation or retries. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {verifyOrderMergeDelivery209Readback} from './order-merge-delivery209-ordinary-readback.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/,root='/api/order-merges';
const LEGACY_SCHEMA='208_consumer_return_credit_guard_dedup',DELIVERY_SCHEMA='209_order_merge_delivery_inheritance',MAX_RESPONSE=5*1024*1024;
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...keys].sort());};
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const copy=v=>freeze(structuredClone(v)),sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const same=(a,b)=>assert.deepEqual(canonical(a),canonical(b));
export function validateOrderMergeOrdinaryProfile(v){
 exact(v,['baseUrl','expectedRevision',...(Object.hasOwn(v??{},'expectedSchema')?['expectedSchema']:[])]);
 assert.equal(v.baseUrl,'http://127.0.0.1:4103','Only isolated preview4103 is authorized');assert(SHA.test(v.expectedRevision));
 // Historical208 callers retain their exact profile. A209 run must explicitly
 // pin both its schema and revision; never derive either expectation from health.
 if(Object.hasOwn(v,'expectedSchema'))assert([LEGACY_SCHEMA,DELIVERY_SCHEMA].includes(v.expectedSchema),'Unsupported exact MERGE acceptance schema');
 return copy(v);
}
export function validateOrderMergeOrdinaryFixture(v){
 exact(v,['schema','evidence','tenant_id','actor_id','main_order_id','orders','merge_mode','sum_delivery_costs']);assert.equal(v.schema,'dynaminds-order-merge-ordinary-fixture/v1');assert.equal(v.evidence,'genuine_http_fresh_orders_no_merge');
 for(const k of ['tenant_id','actor_id','main_order_id'])assert(UUID.test(v[k]));assert(Array.isArray(v.orders)&&v.orders.length>=2&&v.orders.length<=100);for(const o of v.orders){exact(o,['id','version']);assert(UUID.test(o.id));assert(typeof o.version==='string'&&/^[1-9][0-9]{0,18}$/.test(o.version));}
 assert.equal(new Set(v.orders.map(o=>o.id)).size,v.orders.length);assert(v.orders.some(o=>o.id===v.main_order_id));assert(['technical_merge','into_main_order'].includes(v.merge_mode));assert.equal(typeof v.sum_delivery_costs,'boolean');return copy(v);
}
async function text(response){assert(response.body?.getReader,'Bounded HTTP body required');const r=response.body.getReader(),chunks=[];let size=0;try{for(;;){const n=await r.read();if(n.done)break;size+=n.value.length;assert(size<=MAX_RESPONSE,'HTTP response exceeded merge response budget');chunks.push(n.value);}}finally{try{await r.cancel();}catch{}r.releaseLock();}return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}
function cookieOf(r){const values=r.headers.getSetCookie?.()??[];assert(values.length,'Ordinary login/switch cookie required');const result=values.map(v=>v.split(';')[0]).join('; ');assert(result&&!/[\r\n]/.test(result));return result;}
function safeFailure(response,raw,secrets){let body;try{const input=JSON.parse(raw),out={};for(const key of ['detail','message','code','error','status','write_outcome','operation','client_key','tenant_id','actor_id'])if(Object.hasOwn(input,key)){
  let v=input[key];if(typeof v==='string'){for(const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length))v=v.split(secret).join('[REDACTED]');v=v.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi,'[REDACTED AUTH]').replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/gi,'[REDACTED URL]').replace(/\b(?:password|token|secret|cookie|authorization|api[_-]?key)\s*["']?\s*[:=]\s*["']?[^\s,;"']+/gi,'[REDACTED SECRET]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED TOKEN]');out[key]=v.slice(0,2048);}else if(v===null||['number','boolean'].includes(typeof v))out[key]=v;
 }body=out;}catch{body={format:'non_json',content:'[REDACTED]'};}return copy({http_status:response.status,body,body_sha256:sha(raw),body_bytes:Buffer.byteLength(raw)});}
/** Missing inputs produce PREPARED_NOT_RUN before touching transport. Sink must durably append each awaited event. */
export async function runOrderMergeOrdinaryAcceptance({profile:input,login,fixture:given,onProgress,fetcher}={}){
 const missing=[['profile',input],['credentials',login],['fixture',given],['durable_sink',onProgress]].filter(([,v])=>v===undefined||v===null).map(([k])=>k);
 if(missing.length)return copy({status:'PREPARED_NOT_RUN',missing,network_requests:0});
 const profile=validateOrderMergeOrdinaryProfile(input),SCHEMA=profile.expectedSchema??LEGACY_SCHEMA,f=validateOrderMergeOrdinaryFixture(given);exact(login,['email','password']);assert(typeof login.email==='string'&&login.email.includes('@')&&login.email.length<=254);assert(typeof login.password==='string'&&login.password.length>=8&&login.password.length<=1024);assert.equal(typeof onProgress,'function');assert(fetcher===undefined||typeof fetcher==='function');
 login=copy(login);
 const fetchPort=fetcher??globalThis.fetch,trace=[],commands=[],failures=[];let cookie,pending=null;
 const progress=()=>copy({schema:'dynaminds-order-merge-ordinary-progress/v1',revision:profile.expectedRevision,schema_revision:SCHEMA,tenant_id:f.tenant_id,actor_id:f.actor_id,pending,commands,failures,trace});
 const emit=async event=>onProgress(copy({revision:profile.expectedRevision,tenant_id:f.tenant_id,actor_id:f.actor_id,...event,progress:progress()}));
 const secrets=()=>[login.email,login.password,cookie,...(cookie??'').split(';').map(v=>v.trim().slice(v.indexOf('=')+1))].filter(Boolean);
 async function request(path,method='GET',body,expected=200,command){
  assert(/^\/api\/[A-Za-z0-9_/?=&%.,:-]+$/.test(path)&&!path.includes('..'));const url=new URL(path,profile.baseUrl);assert.equal(url.origin,profile.baseUrl);assert(method==='GET'||method==='POST');const headers=cookie?{cookie}:{};if(body!==undefined)headers['content-type']='application/json';
  let response;try{response=await fetchPort(url.href,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(120000)});}catch{throw Error('HTTP_RESULT_UNCONFIRMED_NO_RETRY');}
  assert(response.url===''||new URL(response.url).origin===profile.baseUrl);trace.push({method,path,status:response.status});if(command)command.acknowledged_http_status=response.status;
  const raw=await text(response);if(command)await emit({phase:'original_command_acknowledged',operation:command.operation,client_key:command.client_key,http_status:response.status});
  if(response.status!==expected){const failure=safeFailure(response,raw,secrets());failures.push({method,path,...failure});await emit({phase:'unexpected_http_response',method,path,expected_status:expected,...failure});throw Error('UNEXPECTED_HTTP_STATUS_'+response.status);}
  async function protocolFailure(reason,causeName){
   const failure={method,path,kind:'protocol_failure',reason,cause:{name:causeName,message:reason==='unexpected_content_type'?'HTTP_JSON_CONTENT_TYPE_REQUIRED':'HTTP_JSON_PARSE_FAILED'},...safeFailure(response,raw,secrets())};
   failures.push(failure);await emit({phase:'http_protocol_failure',expected_status:expected,...failure});
   const error=Error('HTTP_PROTOCOL_FAILURE');error.protocolFailure=copy({reason:failure.reason,cause:failure.cause});throw error;
  }
  if(!/^application\/(?:json|[A-Za-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type')??''))await protocolFailure('unexpected_content_type','Error');
  let value;try{value=JSON.parse(raw);}catch{await protocolFailure('invalid_json','SyntaxError');}return{value,response};
 }
 const get=async path=>(await request(path)).value;
 async function iam(){const me=await get('/api/auth/me');assert.equal(me.restore_preview,false);assert.notEqual(me.read_only,true);assert.equal(me.user?.tenant_id,f.tenant_id);assert.equal(me.user.id,f.actor_id);assert.equal(me.user.role,'admin');}
 function flags(v){assert.equal(v?.available,true);assert.equal(v.read_only,false);assert.equal(v.current_role,'admin');assert.equal(v.can_read,true);assert.equal(v.can_preview,true);assert.equal(v.can_execute,true);assert.equal(v.can_read_value,true);}
 const lineKeys=['product_id','sku','name','quantity','scanned','price','vat','line_total','components'];
 const line=v=>Object.fromEntries(lineKeys.map(k=>[k,v[k]]));
 // Compare operational business delivery, not sidecar revision/policy counters of a newly created order.
 function receiver(order){
  for(const k of ['customer_name','email','payment_mode'])assert.equal(typeof order[k],'string');assert(order.address&&typeof order.address==='object'&&!Array.isArray(order.address));
  const e=order.effective_delivery;assert(e&&typeof e==='object');for(const k of ['kind','origin','delivery','reason'])assert(Object.hasOwn(e,k));assert(['address','pickup_point','unknown'].includes(e.kind));
  if(e.kind==='address'){assert(['original','override'].includes(e.origin));assert.equal(e.reason,null);exact(e.delivery,['recipient_name','street','city','postal_code','country','phone']);for(const v of Object.values(e.delivery))assert.equal(typeof v,'string');}
  else{assert.equal(e.origin,null);assert.equal(e.delivery,null);assert.equal(e.reason,e.kind==='unknown'?'delivery_kind_unknown':'pickup_point_delivery');}
  return{customer_name:order.customer_name,email:order.email,address:order.address,payment_mode:order.payment_mode,b2b_account_id:order.b2b_account_id??null,effective_delivery:{kind:e.kind,delivery:e.delivery}};
 }
 async function write(operation,body){
  exact(body,operation==='preview'?['client_key','main_order_id','order_ids_to_merge','merge_mode','sum_delivery_costs']:['client_key','preview_id','scope_hash','confirmed',...(Object.hasOwn(body,'confirmed_receiver_selection')?['confirmed_receiver_selection']:[])]);assert(UUID.test(body.client_key));await iam();
  const command={operation,client_key:body.client_key,resource:root+(operation==='preview'?'/previews':'/execute'),request_body:copy(body),acknowledged_http_status:null,resolved:false};commands.push(command);pending={operation,client_key:body.client_key,resource:command.resource};
  await emit({phase:'before_original_command_dispatch',operation,client_key:body.client_key,request_body:body});
  return{value:(await request(command.resource,'POST',body,201,command)).value,command};
 }
 async function original(command,head){
  await iam();const v=await get(root+'/commands/'+command.client_key+'?operation='+command.operation);flags(v);assert.equal(v.operation,command.operation);assert.equal(v.client_key,command.client_key);assert.equal(v.actor_id,f.actor_id);assert.equal(v.api_key_id,null);same(v.request,command.request_body);const h=v[command.operation==='preview'?'preview':'execution'];same(h,head);await iam();return h;
 }
 async function evidence(kind,head){
  assert(UUID.test(head.id)&&UUID.test(head.target_order_id)&&SHA.test(head.scope_hash));assert.equal(head.source_count,f.orders.length);assert(Number.isSafeInteger(head.total)&&head.total>0&&head.total<=10000);assert(Number.isSafeInteger(head.physical_count)&&head.physical_count>=0&&head.physical_count<=10000);
  const base=root+'/'+(kind==='preview'?'previews':'executions')+'/'+head.id,d=await get(base);flags(d);same(d[kind],head);assert.equal(d.meta.total,head.total);const result={};
  for(const [suffix,total,keyOf]of [['sources',head.source_count,r=>r.id],['rows',head.total,r=>String(r.index)],['physical',head.physical_count,r=>JSON.stringify([r.source_order_id,r.product_id,r.warehouse_id,r.location,r.layer_id])]]){
   const all=[],seen=new Set(),cursors=new Set();let cursor=null;do{const query=new URLSearchParams({limit:'100',...(cursor?{cursor}:{})}),v=await get(base+'/'+suffix+'?'+query);flags(v);assert.equal(v.meta?.total,total);assert(Array.isArray(v.data)&&v.data.length<=100);for(const row of v.data){const key=keyOf(row);assert(typeof key==='string'&&key.length>0&&!seen.has(key));seen.add(key);all.push(row);}assert(all.length<=total);const next=v.meta.cursor;assert(next===null||typeof next==='string'&&next.length>0&&next.length<=2048);if(next){assert(v.data.length>0&&!cursors.has(next)&&cursors.size<100);cursors.add(next);}cursor=next;}while(cursor);assert.equal(all.length,total);result[suffix]=all;
  }
  same(result.sources.map(s=>s.id).sort(),f.orders.map(o=>o.id).sort());const ids=new Set(f.orders.map(o=>o.id));assert(result.rows.every(r=>ids.has(r.source_order_id)&&UUID.test(r.source_item_id)));assert(result.physical.every(r=>ids.has(r.source_order_id)));return result;
 }
 try{
  await emit({phase:'before_health'});const health=await get('/api/health');assert.equal(health.status,'ok');assert.equal(health.revision,profile.expectedRevision);assert.equal(health.schema_revision,SCHEMA);assert.equal(health.restore_preview,false);
  await emit({phase:'before_auth_login',method:'POST',path:'/api/auth/login'});cookie=cookieOf((await request('/api/auth/login','POST',login)).response);
  await emit({phase:'before_workspace_switch',method:'POST',path:'/api/workspaces/switch',request_body:{tenant_id:f.tenant_id}});cookie=cookieOf((await request('/api/workspaces/switch','POST',{tenant_id:f.tenant_id})).response);await iam();flags(await get(root+'/options'));
  const before=new Map();for(const o of f.orders){const v=await get('/api/orders/'+o.id);assert.equal(v.id,o.id);assert.equal(v.tenant_id,f.tenant_id);assert.equal(String(v.version),o.version);assert(!v.merge_claim);assert(Array.isArray(v.items)&&v.items.length>0);receiver(v);const l=await get(root+'/orders/'+o.id+'/lineage');flags(l);assert.equal(l.order_id,o.id);assert.equal(l.owner_order_id,o.id);assert.equal(l.closed_source,false);assert.equal(l.created_by,null);assert.deepEqual(l.claims,[]);assert.equal(l.origin,null);before.set(o.id,v);}
  const pb={client_key:randomUUID(),main_order_id:f.main_order_id,order_ids_to_merge:f.orders.map(o=>o.id).filter(id=>id!==f.main_order_id).sort(),merge_mode:f.merge_mode,sum_delivery_costs:f.sum_delivery_costs};const p=await write('preview',pb);flags(p.value);assert.equal(p.value.reused,false);const ph=p.value.preview;assert.equal(ph.main_order_id,f.main_order_id);assert.equal(ph.merge_mode,f.merge_mode);assert.equal(ph.sum_delivery_costs,f.sum_delivery_costs);assert.equal(ph.ready,true);assert.deepEqual(ph.conflicts,[]);if(f.merge_mode==='technical_merge')assert(!before.has(ph.target_order_id));else assert.equal(ph.target_order_id,f.main_order_id);await original(p.command,ph);const pe=await evidence('preview',ph);
  assert.equal(pe.rows.length,[...before.values()].reduce((n,v)=>n+v.items.length,0));assert.equal(new Set(pe.rows.map(r=>r.source_order_id+':'+r.source_item_id)).size,pe.rows.length);for(const row of pe.rows){const prior=before.get(row.source_order_id).items.find(i=>i.id===row.source_item_id);assert(prior);same(line(row),line(prior));}for(const s of pe.sources){assert.equal(String(s.version),before.get(s.id).version.toString());}const shipping=f.sum_delivery_costs?[...before.values()].reduce((n,o)=>n+o.shipping_cost,0):before.get(f.main_order_id).shipping_cost;assert.equal(ph.shipping_cost,shipping);assert.equal(ph.total_minor,pe.rows.reduce((n,r)=>n+r.line_total,shipping));
  await iam();p.command.resolved=true;pending=null;await emit({phase:'preview_original_verified',preview_id:ph.id,scope_hash:ph.scope_hash});
  const eb={client_key:randomUUID(),preview_id:ph.id,scope_hash:ph.scope_hash,confirmed:true,...(ph.receiver_conflict?{confirmed_receiver_selection:true}:{})};const e=await write('execute',eb);flags(e.value);assert.equal(e.value.reused,false);const eh=e.value.execution;assert.equal(eh.state,'done');assert.equal(eh.preview_id,ph.id);for(const k of ['scope_hash','target_order_id','main_order_id','merge_mode','sum_delivery_costs','total_minor','shipping_cost','currency','payment_mode','target_status','payment_balance'])same(eh[k],ph[k]);await original(e.command,eh);const ee=await evidence('execution',eh);same(ee.sources,pe.sources);same(ee.physical,pe.physical);same(ee.rows.map(({target_item_id,...row})=>row),pe.rows);
  const target=await get('/api/orders/'+eh.target_order_id);assert.equal(target.id,eh.target_order_id);assert.equal(target.tenant_id,f.tenant_id);assert.equal(target.total,eh.total_minor);assert.equal(target.shipping_cost,eh.shipping_cost);assert.equal(target.currency,eh.currency);assert.equal(target.status,eh.target_status);same(target.payment,eh.payment_balance);same(receiver(target),receiver(before.get(f.main_order_id)));assert.equal(target.items.length,ee.rows.length);assert.equal(new Set(ee.rows.map(r=>r.target_item_id)).size,ee.rows.length);for(const row of ee.rows){assert(UUID.test(row.target_item_id));const item=target.items.find(i=>i.id===row.target_item_id);assert(item);same(line(item),line(row));}
  const claimed=f.orders.filter(o=>o.id!==eh.target_order_id);assert.equal(claimed.length,f.merge_mode==='technical_merge'?f.orders.length:f.orders.length-1);
  const itemSet=items=>items.map(i=>[i.id,line(i)]).sort((a,b)=>a[0].localeCompare(b[0]));
  for(const o of claimed){const l=await get(root+'/orders/'+o.id+'/lineage');flags(l);assert.equal(l.order_id,o.id);assert.equal(l.owner_order_id,eh.target_order_id);assert.equal(l.closed_source,true);assert.deepEqual(l.claims,[{source_order_id:o.id,target_order_id:eh.target_order_id,execution_id:eh.id,merge_mode:f.merge_mode}]);assert.equal(l.origin?.header.id,o.id);same(itemSet(l.origin.items),itemSet(before.get(o.id).items));const reread=await get('/api/orders/'+o.id);assert.equal(reread.merge_claim?.target_order_id,eh.target_order_id);same(itemSet(reread.items),itemSet(before.get(o.id).items));}
  const targetLineage=await get(root+'/orders/'+eh.target_order_id+'/lineage');flags(targetLineage);assert.equal(targetLineage.closed_source,false);assert.equal(targetLineage.owner_order_id,eh.target_order_id);assert.deepEqual(targetLineage.claims,[]);if(f.merge_mode==='technical_merge'){assert.equal(targetLineage.created_by?.id,eh.id);same(targetLineage.created_by.sources.map(s=>s.id).sort(),f.orders.map(o=>o.id).sort());}else assert.equal(targetLineage.created_by,null);
  const deliveryReadback=SCHEMA===DELIVERY_SCHEMA?await verifyOrderMergeDelivery209Readback({expectedSchema:SCHEMA,mainBefore:before.get(f.main_order_id),targetAfter:target,executionId:eh.id,previewId:ph.id,scopeHash:eh.scope_hash,tenantId:f.tenant_id,actorId:f.actor_id,mergeMode:f.merge_mode,get}):null;
  if(deliveryReadback)await emit({phase:'delivery_public_readback_verified',delivery_readback:deliveryReadback});
  // Re-read only: no acceptance retry, historical POST replay or second target creation.
  await original(e.command,eh);const again=await evidence('execution',eh);same(again,ee);await iam();e.command.resolved=true;pending=null;await emit({phase:'merge_original_verified',execution_id:eh.id,target_order_id:eh.target_order_id});
  return copy({status:fetcher?'PASS_CONTROLLED':'PASS_ORDINARY_HTTP',revision:profile.expectedRevision,schema_revision:SCHEMA,tenant_id:f.tenant_id,actor_id:f.actor_id,preview_id:ph.id,execution_id:eh.id,target_order_id:eh.target_order_id,source_ids:f.orders.map(o=>o.id).sort(),scope_hash:eh.scope_hash,source_count:ee.sources.length,rows:ee.rows.length,physical_rows:ee.physical.length,physical_evidence:'source_snapshots_readback_only',target_stock_transfer_acceptance:false,delivery_readback:deliveryReadback,progress:progress(),ui_acceptance:false,native_acceptance:false,scale_acceptance:false});
 }catch(error){const failure=new Error(error?.message==='HTTP_RESULT_UNCONFIRMED_NO_RETRY'?'HTTP_RESULT_UNCONFIRMED_NO_RETRY':pending?'MERGE_ACCEPTANCE_UNCONFIRMED_OR_FAILED':'MERGE_ACCEPTANCE_FAILED');failure.acceptanceProgress=progress();if(error?.protocolFailure){failure.reason=error.protocolFailure.reason;failure.cause=copy(error.protocolFailure.cause);}try{await emit({phase:'acceptance_failed',status:'FAILED_OR_UNCERTAIN'});}catch{failure.progressSinkUnconfirmed=true;}throw failure;}
}
