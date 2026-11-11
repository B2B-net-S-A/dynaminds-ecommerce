/** ROOT ONLY. Readback of ONE already acknowledged Chrome demo dispatch.
 * No write/login/worker/provider/dispatch/retry. Fixed primary4100, owner UTC
 * RR READ ONLY, strict packed476 baseline and fresh all476 post-dispatch rows.
 * The initial root inline read-only attempt passed the issuer graph but rejected
 * the legitimate automation job; it wrote no reference and retried no action.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureStocktakeAdjustmentPreservation } from './stocktake-adjustments-native164-preservation';
import { validateRestoredIssuerGraph, type IssuerRestoreCapture } from './warehouse-wz-issuer-restore168-readback';

type Row=Record<string,any>;
const ROOT='<workspace>/app',API='http://127.0.0.1:4100/api';
const SCHEMA='151_warehouse_wz_issuer',TABLES=476;
const SETUP=resolve(ROOT,'data/warehouse-wz-issued-native168-setup.json');
const PREPARED=resolve(ROOT,'data/warehouse-wz-issued-native168-setup-prepared.json');
const OUT=resolve(ROOT,'data/warehouse-wz-issuer168-primary-reference.private.json');
const PUBLIC=resolve(ROOT,'docs/warehouse-wz-issued-native168-readback.json');
const SHA=/^[a-f0-9]{64}$/,REV=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const one=(rows:Row[])=>{assert.equal(rows.length,1);return rows[0];};
const rows=(cap:IssuerRestoreCapture,n:string):Row[]=>{assert(Array.isArray(cap.rows[n]));return cap.rows[n].map(x=>x.row);};
const omit=(r:Row,keys:string[])=>Object.fromEntries(Object.entries(r).filter(([k])=>!keys.includes(k)));
const sorted=(rs:Row[])=>[...rs].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const integer=(v:unknown)=>{assert(/^(0|[1-9][0-9]*)$/.test(String(v)));return BigInt(String(v));};

async function directory(p:string){const s=await lstat(p);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);}
async function bytes(p:string,max=512*1024*1024,privateFile=true){
  assert.equal(await realpath(p),p);const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert(s.size>0&&s.size<=max);if(privateFile)assert.equal(s.mode&0o777,0o600);
  const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs']as const)assert.equal(n[k],s[k]);};stable(await f.stat());const b=await f.readFile();stable(await f.stat());stable(await lstat(p));assert.equal(b.length,s.size);return b;}finally{await f.close();}
}
async function absent(p:string){try{await lstat(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive168 reference already exists');}
async function wx(p:string,v:unknown,mode=0o600){await directory(dirname(p));const b=JSON.stringify(v,null,2)+'\n';assert(Buffer.byteLength(b)<=512*1024*1024);const f=await open(p,'wx',mode);try{await f.writeFile(b);await f.sync();}finally{await f.close();}const d=await open(dirname(p),'r');try{await d.sync();}finally{await d.close();}return hash(b);}

/** No tenant-wide exemption: only this order and its THREE allocated cells may
 * mutate. Every original row elsewhere (including all sessions) stays exact.
 */
export function validateSingleDemoDispatchDelta(before:IssuerRestoreCapture,after:IssuerRestoreCapture,a:Row,ids:{shipment:string;document:string;receipt:string}) {
  const t=a.tenant_id,oid=a.order_id,wh=a.warehouse.id;
  assert.equal(a.on,false);assert.equal(a.products.length,3);assert.equal(new Set(a.products.map((p:Row)=>p.id)).size,3);
  const products=new Set<string>(a.products.map((p:Row)=>p.id));
  assert.deepEqual(Object.keys(after.rows),Object.keys(before.rows));assert.equal(Object.keys(after.rows).length,TABLES);
  assert.deepEqual(after.portable_metadata,before.portable_metadata);
  const mutable=(n:string,r:Row)=>r.tenant_id===t&&(
    n==='orders'&&r.id===oid||n==='reservations'&&r.order_id===oid||
    n==='stock'&&r.warehouse_id===wh&&products.has(r.product_id)||
    n==='stock_locations'&&r.warehouse_id===wh&&a.reservations.some((p:Row)=>p.product_id===r.product_id&&p.locations.some((b:Row)=>b.location===r.location)));
  const oldMutationKeys:Record<string,string[]>={orders:['status','version','updated_at'],reservations:['state'],stock:['on_hand','reserved','version'],stock_locations:['quantity']};
  const newRows:Record<string,Row[]>={};
  for(const n of Object.keys(before.rows)) {
    const previous=rows(before,n),current=rows(after,n),oldMutable=previous.filter(r=>mutable(n,r)),newMutable=current.filter(r=>mutable(n,r));
    assert.equal(oldMutable.length,newMutable.length,'No source rows born/deleted: '+n);
    for(const old of oldMutable) {
      const identity=n==='orders'?(r:Row)=>r.id===old.id:n==='reservations'?(r:Row)=>r.order_id===old.order_id&&r.product_id===old.product_id&&r.warehouse_id===old.warehouse_id:
        n==='stock'?(r:Row)=>r.product_id===old.product_id&&r.warehouse_id===old.warehouse_id:(r:Row)=>r.product_id===old.product_id&&r.warehouse_id===old.warehouse_id&&r.location===old.location;
      const now=one(newMutable.filter(identity));assert.deepEqual(omit(now,oldMutationKeys[n]),omit(old,oldMutationKeys[n]),'Exact source columns: '+n);
      if(n==='orders'){assert.equal(old.status,'packed');assert.equal(now.status,'shipped');assert.equal(integer(now.version),integer(old.version)+1n);assert(Number.isFinite(Date.parse(now.updated_at))&&Date.parse(now.updated_at)>=Date.parse(old.updated_at));}
      else if(n==='reservations'){assert.equal(old.state,'active');assert.equal(now.state,'consumed');assert.equal(old.quantity,1);}
      else if(n==='stock'){assert.equal(now.on_hand,old.on_hand-1);assert.equal(now.reserved,old.reserved-1);assert.equal(integer(now.version),integer(old.version)+1n);}
      else {assert.equal(now.quantity,old.quantity-1);}
    }
    const oldStable=previous.filter(r=>!mutable(n,r)),newStable=current.filter(r=>!mutable(n,r));
    const remaining=[...newStable];
    for(const old of oldStable){const index=remaining.findIndex(r=>JSON.stringify(r)===JSON.stringify(old));assert(index>=0,'Original row changed/deleted: '+n);remaining.splice(index,1);}
    newRows[n]=remaining;
  }
  for(const [n,count] of [['orders',1],['reservations',3],['stock',3],['stock_locations',3]]as const)assert.equal(rows(before,n).filter(r=>mutable(n,r)).length,count);
  const counts:Record<string,number>={shipments:1,stock_movements:3,stock_location_movements:3,order_events:1,audit_events:1,jobs:1,
    purchasing_stock_changes:6,shopify_dispatch_evidence:1,warehouse_wz_issuer_admissions:1,warehouse_wz_issuer_receipts:1,warehouse_wz_issuer_counters:1,warehouse_wz_issuer_documents:1,warehouse_wz_issuer_rows:3};
  for(const [n,delta]of Object.entries(newRows))assert.equal(delta.length,counts[n]??0,'Exact append manifest: '+n);
  for(const n of Object.keys(counts))assert(newRows[n]);
  for(const [n,delta]of Object.entries(newRows))for(const r of delta){assert.equal(r.tenant_id,t);if('id'in r&&n!=='purchasing_stock_changes')assert.match(r.id,UUID);}
  const shipment=one(newRows.shipments);assert.equal(shipment.id,ids.shipment);assert.equal(shipment.order_id,oid);assert.equal(shipment.mode,'demo');assert.equal(shipment.carrier,'Symulator lokalny');assert.match(shipment.tracking_number,/^DEMO-[A-F0-9]{12}$/);assert(shipment.dispatched_at);assert.equal(shipment.cod_expected,0);
  const event=one(newRows.order_events);assert.equal(event.order_id,oid);assert.equal(event.kind,'order.shipped');assert.deepEqual(event.detail,{mode:'demo',shipmentId:ids.shipment});
  const audit=one(newRows.audit_events);assert.equal(audit.user_id,a.user_id);assert.equal(audit.entity_id,oid);assert.equal(audit.action,'shipment.demo');assert.deepEqual(audit.detail,{});
  const job=one(newRows.jobs);assert.equal(job.kind,'automation');assert.equal(job.state,'pending');assert.equal(job.attempts,0);assert.equal(job.max_attempts,5);assert.equal(job.locked_at,null);assert.equal(job.error,null);assert.equal(job.dedup_key,'event:'+event.id);
  assert.deepEqual(Object.keys(job.payload).sort(),['context','eventId','orderId','rules','snapshot','trigger']);assert.equal(job.payload.eventId,event.id);assert.equal(job.payload.orderId,oid);assert.equal(job.payload.trigger,'order.shipped');assert.deepEqual(job.payload.rules,[]);
  assert.deepEqual(Object.keys(job.payload.context).sort(),['chain_id','depth','trace']);assert.match(job.payload.context.chain_id,UUID);assert.equal(job.payload.context.depth,0);assert.deepEqual(job.payload.context.trace,[]);
  const currentOrder=one(rows(after,'orders').filter(r=>r.tenant_id===t&&r.id===oid));
  const originalItems=rows(after,'order_items').filter(r=>r.tenant_id===t&&r.order_id===oid);assert.equal(originalItems.length,3);
  // SQL107 trigger, replaced by108: every real local dispatch captures evidence;
  // it makes no remote fulfillment call. This fixture has no external remainder.
  assert.equal(rows(after,'shipping_plans').filter(r=>r.tenant_id===t&&r.shipment_id===ids.shipment&&['ready','dispatched'].includes(r.state)).length,0);
  assert.equal(rows(after,'b2b_dropship_lines').filter(r=>r.tenant_id===t&&r.customer_order_id===oid).length,0);
  const evidence=one(newRows.shopify_dispatch_evidence);
  assert.deepEqual(evidence,{tenant_id:t,shipment_id:ids.shipment,order_id:oid,
    receiver:{customer_name:currentOrder.customer_name,email:currentOrder.email,address:currentOrder.address},
    items:[...originalItems].sort((x,y)=>x.id.localeCompare(y.id)),dispatched_at:shipment.dispatched_at,created_at:shipment.created_at});
  const snapshot={...Object.fromEntries(['id','status','source','total','currency','warehouse_id','workflow_status_id','tags','version'].map(k=>[k,currentOrder[k]])),country:currentOrder.address.country,item_count:3,
    // events.orderSnapshot SELECT exposes pg int8 as text; owner to_jsonb row
    // capture exposes the same version as a JSON number. Normalize only this
    // declared field; every other snapshot value remains deeply exact.
    version:String(currentOrder.version),skus:[...originalItems].sort((x,y)=>x.sku.localeCompare(y.sku)).map(x=>x.sku)};
  assert.deepEqual(job.payload.snapshot,snapshot);
  const markers=rows(before,'purchasing_stock_changes');const maximum=markers.reduce((n,r)=>integer(r.id)>n?integer(r.id):n,0n);
  for(const r of newRows.purchasing_stock_changes){assert.deepEqual(Object.keys(r).sort(),['id','tenant_id']);assert(integer(r.id)>maximum);}
  for(const p of a.products) {
    const sm=one(newRows.stock_movements.filter(r=>r.product_id===p.id)),bm=one(newRows.stock_location_movements.filter(r=>r.product_id===p.id));
    assert.deepEqual([sm.warehouse_id,sm.order_id,sm.delta,sm.kind,sm.warehouse_document_id,sm.note],[wh,oid,-1,'shipment',null,'']);
    const location=one(a.reservations.filter((r:Row)=>r.product_id===p.id)).locations[0];
    assert.deepEqual([bm.warehouse_id,bm.order_id,bm.location,bm.delta,bm.kind,bm.operation_id,bm.stocktake_id,bm.note],[wh,oid,location.location,-1,'shipment',null,null,'']);
  }
  const admission=one(newRows.warehouse_wz_issuer_admissions),receipt=one(newRows.warehouse_wz_issuer_receipts),document=one(newRows.warehouse_wz_issuer_documents),counter=one(newRows.warehouse_wz_issuer_counters);
  assert.equal(admission.id,ids.receipt);assert.equal(receipt.id,ids.receipt);assert.equal(document.id,ids.document);assert.equal(document.receipt_id,receipt.id);assert.equal(admission.actor_id,a.user_id);assert.equal(admission.api_key_id,null);assert.equal(admission.sealed,true);
  assert.deepEqual(admission.source,{kind:'demo',order_id:oid,shipment_id:ids.shipment});assert.deepEqual(receipt.source,admission.source);assert.equal(receipt.physical.wms,null);assert.equal(admission.frame.policy,null);
  assert.equal(counter.warehouse_id,wh);assert.equal(counter.series_id,a.configuration.series_id);assert.equal(integer(counter.sequence),1n);assert.equal(integer(document.sequence),1n);assert.equal(document.warehouse_id,wh);assert.equal(document.shipment_id,ids.shipment);assert.equal(document.series_id,counter.series_id);assert.equal(document.year,counter.year);
  assert.equal(document.payload.row_count,3);assert.equal(document.payload.summary.physical_quantity,3);assert.deepEqual(document.payload.summary,{physical_quantity:3});
  assert.deepEqual(document.payload.commercial_lines.map((l:Row)=>l.item_id).sort(),originalItems.map(r=>r.id).sort());
  assert.equal(newRows.warehouse_wz_issuer_rows.every(r=>r.document_id===document.id),true);
  for(const r of newRows.warehouse_wz_issuer_rows)for(const k of ['unit_cost_minor','value_minor','currency','exponent'])assert.equal(Object.hasOwn(r.payload,k),false);
  return {shipment_id:ids.shipment,document_id:ids.document,receipt_id:ids.receipt,order_id:oid,event_id:event.id,automation_job_id:job.id,counts,
    changed_rows:{orders:1,reservations:3,stock:3,stock_locations:3},off_value_available:false,second_physical_writer:false};
}

async function main(){
  let c:pg.Client|undefined,step='preflight',gets=0;
  const pins=new Map<string,{sha:string;max:number;privateFile:boolean}>();
  try{
    assert.equal(process.cwd(),ROOT);assert.equal(process.argv.length,2);for(const p of [ROOT,resolve(ROOT,'data'),resolve(ROOT,'docs')])await directory(p);
    assert.equal(process.env.QA168_READBACK_CONFIRM,'READ_ONLY_ONE_ACKNOWLEDGED_OFF_DEMO_DISPATCH');assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,resolve(ROOT,'.local.json'));assert.equal(process.env.DYNA_WORKER_DISABLED,'true');for(const k of ['DYNA_PREVIEW_PORT','DYNA_TEST','DATABASE_URL'])assert.equal(process.env[k],undefined);
    const revision=process.env.QA_EXPECTED_REVISION??'';assert.match(revision,REV);assert.equal(process.env.APP_REVISION,revision);
    const ids={shipment:process.env.QA168_SHIPMENT_ID??'',document:process.env.QA168_DOCUMENT_ID??'',receipt:process.env.QA168_RECEIPT_ID??''};for(const id of Object.values(ids))assert.match(id,UUID);
    const attempt=process.env.QA168_READBACK_ATTEMPT??'';assert(/^([4-9]|1[0-9]|20)$/.test(attempt));
    const intent=OUT+'.attempt-'+attempt+'.intent.json';
    // Earlier failed readback intent remains immutable. This is another read,
    // never another dispatch, and every attempt owns a distinct exclusive file.
    for(const p of [OUT,PUBLIC,intent])await absent(p);
    async function pin(p:string,expected:string|undefined,max=512*1024*1024,privateFile=true):Promise<Row>{assert.match(expected??'',SHA);const b=await bytes(p,max,privateFile);assert.equal(hash(b),expected);pins.set(p,{sha:expected!,max,privateFile});return JSON.parse(b.toString())as Row;}
    const config=await pin(resolve(ROOT,'.local.json'),process.env.QA168_CONFIG_SHA256,65536);assert.deepEqual(Object.keys(config).sort(),['dbPassword','encryptionKey']);assert.match(config.encryptionKey,SHA);assert(typeof config.dbPassword==='string'&&config.dbPassword);
    const sqlPath=resolve(ROOT,'server/151_warehouse_wz_issuer.sql');assert.match(process.env.QA168_SQL_SHA256??'',SHA);const sb=await bytes(sqlPath,4*1024*1024,false);assert.equal(hash(sb),process.env.QA168_SQL_SHA256);pins.set(sqlPath,{sha:hash(sb),max:4*1024*1024,privateFile:false});
    const setup=await pin(SETUP,process.env.QA168_SETUP_SHA256,32*1024*1024);assert.equal(setup.stage,168);assert.equal(setup.schema,SCHEMA);assert.equal(setup.runtime_revision,revision);assert.equal(setup.config_sha256,process.env.QA168_CONFIG_SHA256);assert.equal(setup.status,'EXISTING_OFF_ORDER_PACKED_FOR_CHROME_NOT_DISPATCHED');assert.equal(setup.complete,true);assert.equal(setup.pending,null);assert.equal(setup.completed.length,7);
    const a=setup.actor;assert.equal(a.on,false);for(const id of [a.tenant_id,a.user_id,a.order_id,a.warehouse.id])assert.match(id,UUID);assert.equal(a.order_id,'0c6c84b5-81f1-4cb8-8568-c1a701763e27');assert.match(a.cookie,/^dyna_session=[A-Za-z0-9_.-]+$/);
    const prepared=await pin(PREPARED,process.env.QA168_PREPARED_SHA256);assert.equal(setup.prepared_sha256,process.env.QA168_PREPARED_SHA256);assert.equal(prepared.stage,168);assert.equal(prepared.phase,'prepared-before-chrome-dispatch');assert.equal(prepared.schema,SCHEMA);assert.equal(prepared.runtime_revision,revision);assert.equal(prepared.config_sha256,process.env.QA168_CONFIG_SHA256);assert.equal(prepared.before_sha256,setup.before_sha256);assert.equal(prepared.source164_sha256,setup.source164_sha256);
    const before:IssuerRestoreCapture={rows:prepared.capture.rows,portable_metadata:prepared.capture.metadata};assert.equal(Object.keys(before.rows).length,TABLES);assert(before.rows.sessions);assert(prepared.capture.exact_metadata);
    async function custody(){for(const[p,v]of pins)assert.equal(hash(await bytes(p,v.max,v.privateFile)),v.sha);}
    async function get(path:string,actor=false){assert(path==='/health'||actor&&['/auth/me','/orders/'+a.order_id,'/warehouse-wz-issued/documents?order_id='+a.order_id+'&limit=50','/warehouse-wz-issued/documents/'+ids.document].includes(path));gets++;const r=await fetch(API+path,{method:'GET',headers:actor?{cookie:a.cookie,'X-Workspace-ID':a.tenant_id}:{},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null);const b=Buffer.from(await r.arrayBuffer());assert(b.length<=8*1024*1024);return JSON.parse(b.toString())as Row;}
    async function health(){const h=await get('/health');assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.background_workers_enabled,false);assert.equal(h.restore_preview,false);assert.equal(h.warehouse_automatic_wz_configuration_available,true);assert.equal(h.warehouse_automatic_wz_issuer_available,true);}
    const prior_readbacks=[{attempt:1,graph_passed:true,failed_check:'APPEND_ALLOWLIST_MISSING_LEGITIMATE_AUTOMATION_JOB',reference_written:false,dispatch_retries:0},{attempt:2,failed_check:'APPEND_ALLOWLIST_MISSING_LOCAL_SHOPIFY_DISPATCH_EVIDENCE',reference_written:false,dispatch_retries:0},{attempt:3,failed_check:'EVENT_SNAPSHOT_PG_INT8_VERSION_TYPE',reference_written:false,dispatch_retries:0}];
    await health();await custody();await wx(intent,{stage:168,readback_attempt:Number(attempt),action:'READ_ONLY_AFTER_ONE_ACKNOWLEDGED_CHROME_DEMO',runtime_revision:revision,setup_sha256:process.env.QA168_SETUP_SHA256,prepared_sha256:process.env.QA168_PREPARED_SHA256,ids,prior_readbacks});
    step='primary-capture';c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:config.dbPassword,database:'dynaminds',connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});c.on('error',()=>{});await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");assert.deepEqual((await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],{db:'dynaminds',role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});
    assert.equal((await c.query('SELECT public.warehouse_automatic_wz_guards() AND public.warehouse_wz_issuer_installed() AND public.warehouse_wz_issuer_guards() ok')).rows[0].ok,true);
    const preserved=await captureStocktakeAdjustmentPreservation(c),capture:IssuerRestoreCapture={rows:preserved.rows,portable_metadata:preserved.metadata};
    assert.deepEqual(preserved.exact_metadata,prepared.capture.exact_metadata);assert.equal(one(rows(capture,'migrations').filter(r=>r.name===SCHEMA)).name,SCHEMA);
    step='exact-delta';const delta=validateSingleDemoDispatchDelta(before,capture,a,ids);const graph=await validateRestoredIssuerGraph(c,capture);await c.query('COMMIT');
    step='get-proof';const me=await get('/auth/me',true);assert.equal(me.user.id,a.user_id);assert.equal(me.user.tenant_id,a.tenant_id);assert.equal(me.user.role,'admin');
    const order=await get('/orders/'+a.order_id,true);assert.equal(order.status,'shipped');assert.equal(order.id,a.order_id);assert.equal(order.shipments.length,1);assert.equal(order.shipments[0].id,ids.shipment);
    const list=await get('/warehouse-wz-issued/documents?order_id='+a.order_id+'&limit=50',true);assert.equal(list.available,true);assert.equal(list.read_only,false);assert.equal(list.can_read,true);assert.equal(list.can_read_value,true);assert.equal(list.current_role,'admin');assert.equal(list.meta.cursor,null);assert.equal(list.data.length,1);assert.equal(list.data[0].id,ids.document);
    const detail=await get('/warehouse-wz-issued/documents/'+ids.document,true);assert.equal(detail.available,true);assert.equal(detail.can_read,true);assert.equal(detail.can_read_value,true);assert.equal(detail.current_role,'admin');assert.equal(detail.read_only,false);
    const document=one(rows(capture,'warehouse_wz_issuer_documents').filter(r=>r.id===ids.document&&r.tenant_id===a.tenant_id));assert.deepEqual(detail.document,{...document.payload,value_available:false});assert.deepEqual(list.data,[detail.document]);
    assert.deepEqual(detail.rows,rows(capture,'warehouse_wz_issuer_rows').filter(r=>r.tenant_id===a.tenant_id&&r.document_id===ids.document).sort((x,y)=>x.ordinal-y.ordinal).map(r=>r.payload));assert.equal(detail.rows.length,3);
    // A second full capture after all GETs rejects session creation or any other
    // read side effect; no login additions are allowed in this proof.
    step='get-purity';await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");const final=await captureStocktakeAdjustmentPreservation(c);assert.deepEqual(final,preserved);await c.query('COMMIT');await health();await custody();
    step='exclusive-output';const status='WAREHOUSE_WZ_ISSUER_PRIMARY_READBACK_PASS';
    const privateSha=await wx(OUT,{stage:168,status,readback_attempt:Number(attempt),schema:SCHEMA,runtime_revision:revision,config_sha256:process.env.QA168_CONFIG_SHA256,sql_sha256:process.env.QA168_SQL_SHA256,setup_sha256:process.env.QA168_SETUP_SHA256,prepared_sha256:process.env.QA168_PREPARED_SHA256,capture,exact_metadata:preserved.exact_metadata,delta,graph,api_proof:{order,document:detail.document,rows:detail.rows},prior_readbacks,gets,mutations:0,login_calls:0,created_at:new Date().toISOString()});
    const safe={stage:168,status,schema:SCHEMA,runtime_revision:revision,private_reference_sha256:privateSha,setup_sha256:process.env.QA168_SETUP_SHA256,prepared_sha256:process.env.QA168_PREPARED_SHA256,tables:TABLES,all_other_rows_exact:true,all_old_sessions_exact:true,all_portable_and_oid_metadata_exact:true,own_delta:{order:1,shipment:1,wz_documents:1,wz_rows:3,stock_journals:3,bin_journals:3,counter:1,order_events:1,audit_events:1,pending_automation_jobs:1,purchasing_markers:6},order_id:a.order_id,document_id:ids.document,receipt_id:ids.receipt,shipment_id:ids.shipment,physical_quantity:3,value_available:false,no_wms_writes:true,no_second_physical_writer:true,prior_inline_attempt1_failed:true,prior_failure:'AUTOMATION_JOB_ALLOWLIST_OMISSION',dispatch_retries:0,gets,mutations:0,login_calls:0,worker_calls:0,providers_verified:false,chrome_verified_here:false,restart_verified:false,restore_verified:false,raw_principal_verified:false,full_goal_complete:false};
    Object.assign(safe,{readback_attempt:Number(attempt),local_shopify_dispatch_evidence:1,remote_fulfillment_calls:0,prior_attempt2_failed:true,prior_attempt2_failure:'LOCAL_SHOPIFY_DISPATCH_EVIDENCE_ALLOWLIST_OMISSION',prior_attempt3_failed:true,prior_attempt3_failure:'EVENT_SNAPSHOT_PG_INT8_VERSION_TYPE'});
    await wx(PUBLIC,safe,0o644);console.log(JSON.stringify(safe));
  }catch(e){const at=e instanceof Error?e.stack?.match(/warehouse-wz-issued-native168-readback\.ts:(\d+):(\d+)/):null;console.error(JSON.stringify({stage:168,status:'PRIMARY168_READBACK_FAILED_NO_ACTION_RETRY',step,error_type:e instanceof Error?e.name:'Error',source_line:at?Number(at[1]):null,source_column:at?Number(at[2]):null,private_details_withheld:true,automatic_resume:false}));process.exitCode=1;}
  finally{await c?.query('ROLLBACK').catch(()=>undefined);await c?.end().catch(()=>undefined);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
