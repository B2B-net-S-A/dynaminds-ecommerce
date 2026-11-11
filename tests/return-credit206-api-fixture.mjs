/** Explicit disposable-DB fixture. Physical, return and native history is created
 * exclusively by ordinary business HTTP; SQL creates only isolated tenant/IAM metadata. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

export const HISTORY206_PREVIEW_DATABASE='dynaminds_full_base_preview_20261017';
export const HISTORY206_PREVIEW_REVISION='f73f57c3655bf9aeecba2de6a406ba328f3a9ef3d4140d6f93088dcf95c750dc';
export const HISTORY206_PREVIEW06_REVISION='1e9044ee6cb59fda0013b8fb64059b74917cab0a9ea8831433c666633e63bc97';
const previewRevision=profile=>{assert(['preview05','preview06'].includes(profile),'Only explicitly approved preview05 or preview06 is admitted');return profile==='preview06'?HISTORY206_PREVIEW06_REVISION:HISTORY206_PREVIEW_REVISION;};
const previewAdmissions=new WeakMap();
const keys=(value,expected)=>{assert(value&&typeof value==='object'&&!Array.isArray(value),'Expected private locator object');assert.deepEqual(Object.keys(value).sort(),[...expected].sort(),'Unexpected private locator fields');};
export function validateHistory206PreviewLocator(input,previewProfile='preview05'){
 keys(input,['schema','databaseUrl','baseUrl','expectedRevision','casesFile','login']);
 assert.equal(input.schema,'dynaminds-return-credit206-preview-locator/v1');
 assert.equal(input.baseUrl,'http://127.0.0.1:4103');
 assert.equal(input.expectedRevision,previewRevision(previewProfile));
 assert(typeof input.databaseUrl==='string'&&input.databaseUrl.length<4096);
 let u;try{u=new URL(input.databaseUrl);}catch{throw new Error('Invalid private database URL');}assert(['postgres:','postgresql:'].includes(u.protocol));
 assert.equal(u.hostname,'127.0.0.1');assert.equal(u.pathname,'/'+HISTORY206_PREVIEW_DATABASE);
 assert.equal(u.username,'postgres');assert(!u.search&&!u.hash&&u.password&&u.port,'Explicit local owner URL required');
 assert(typeof input.casesFile==='string'&&path.isAbsolute(input.casesFile)&&path.resolve(input.casesFile)===input.casesFile&&input.casesFile.length<4096&&!/[\x00-\x1f\x7f]/.test(input.casesFile));
 keys(input.login,['email','password']);assert(typeof input.login.email==='string'&&input.login.email.length<=254&&input.login.email.includes('@'));
 assert(typeof input.login.password==='string'&&input.login.password.length>=8&&input.login.password.length<=1024);
 return Object.freeze({...input,login:Object.freeze({...input.login})});
}
const inodeCut=s=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const canonical=file=>{assert(typeof file==='string'&&path.isAbsolute(file)&&path.resolve(file)===file&&!/[\x00-\x1f\x7f]/.test(file),'Canonical absolute private path required');return file;};
export async function readHistory206PreviewLocator(file,previewProfile='preview05'){
 canonical(file);assert.equal(await fs.realpath(file),file,'Canonical locator without aliases required');
 const initial=await fs.lstat(file,{bigint:true});
 assert(initial.isFile()&&!initial.isSymbolicLink()&&initial.uid===BigInt(process.getuid())&&initial.nlink===1n&&(initial.mode&0o777n)===0o600n&&initial.size>0n&&initial.size<=16384n,'Private single-link 0600 locator required');
 const fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
 try{const before=await fd.stat({bigint:true});assert.equal(inodeCut(before),inodeCut(initial),'Locator changed before read');
  bytes=Buffer.alloc(Number(before.size)+1);let count=0;
  while(count<bytes.length){const result=await fd.read(bytes,count,bytes.length-count,count);if(result.bytesRead===0)break;count+=result.bytesRead;}
  const after=await fd.stat({bigint:true});
  assert(count===Number(before.size)&&inodeCut(before)===inodeCut(after)&&inodeCut(before)===inodeCut(await fs.lstat(file,{bigint:true})),'Locator changed during read');
  assert.equal(await fs.realpath(file),file,'Locator alias changed during read');
  let value;try{value=JSON.parse(bytes.subarray(0,count).toString('utf8'));}catch{throw new Error('Invalid private locator JSON');}
  return validateHistory206PreviewLocator(value,previewProfile);
 }finally{bytes?.fill(0);await fd.close();}
}
const directoryCut=s=>[s.dev,s.ino,s.uid,s.mode].join(':');
async function casesParent(file){
 canonical(file);const parent=path.dirname(file);assert.equal(await fs.realpath(parent),parent,'Canonical cases parent without aliases required');
 const stat=await fs.lstat(parent,{bigint:true});assert(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===BigInt(process.getuid())&&(stat.mode&0o777n)===0o700n,'Private owner 0700 cases parent required');
 return{parent,cut:directoryCut(stat)};
}
/** Must finish before HTTP or DB access. A later exclusive write still refuses a race. */
export async function assertHistory206CasesFileFresh(file){
 const parent=await casesParent(file);
 try{await fs.lstat(file);throw new Error('Fresh cases file required; existing file or symlink refused');}
 catch(e){if(e?.code!=='ENOENT')throw e;}
 const after=await casesParent(file);assert.deepEqual(after,parent,'Cases parent changed during preflight');return Object.freeze(parent);
}
async function assertCasesParentUnchanged(file,expected){assert.deepEqual(await casesParent(file),expected,'Cases parent changed during fixture work');}

async function boundedJson(response){
 const reader=response.body?.getReader();assert(reader,'Expected JSON body');let size=0;const chunks=[];
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;assert(size<=4*1024*1024,'Fixture response exceeds limit');chunks.push(next.value);}}
 finally{try{await reader.cancel();}catch{}reader.releaseLock();}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
 catch{throw new Error('Invalid fixture JSON response');}
}
/** A native HTTP app.inject-shaped adapter; does not forward remoteAddress or caller authority. */
export function createHistory206PreviewTransport(input,fetcher=fetch,previewProfile='preview05'){
 const locator=validateHistory206PreviewLocator(input,previewProfile);assert.equal(typeof fetcher,'function');
 return Object.freeze({async inject(request){
  assert(request&&typeof request==='object');assert(['GET','POST','PATCH'].includes(request.method??'GET'),'Unexpected fixture method');
  assert(typeof request.url==='string'&&/^\/api(?:\/|$)/.test(request.url)&&!/[\\\x00-\x20\x7f]/.test(request.url),'Expected local API path');
  const target=new URL(request.url,locator.baseUrl);assert.equal(target.origin,locator.baseUrl);
  assert(!target.username&&!target.password&&!target.hash&&target.pathname.startsWith('/api/'),'Unexpected API target');
  const headers={};if(request.headers){keys(request.headers,['cookie']);assert(typeof request.headers.cookie==='string'&&!/[\r\n]/.test(request.headers.cookie));headers.cookie=request.headers.cookie;}
  const method=request.method??'GET';assert(method!=='GET'||request.payload===undefined,'GET payload refused');
  if(request.payload!==undefined)headers['content-type']='application/json';
  let response;try{response=await fetcher(target.href,{method,headers,body:request.payload===undefined?undefined:JSON.stringify(request.payload),redirect:'error',signal:AbortSignal.timeout(30000)});}
  catch{throw new Error('Local fixture HTTP result unconfirmed; inspect own tenant before retry');}
  assert(response.url===''||new URL(response.url).origin===locator.baseUrl,'Unexpected response origin');
  const body=await boundedJson(response),cookies=response.headers.getSetCookie?.()??[];
  return Object.freeze({statusCode:response.status,headers:Object.freeze({'set-cookie':cookies.length?cookies.join(', '):undefined}),json:()=>body});
 }});
}
export async function assertHistory206PreviewReady(app,locator,previewProfile='preview05'){
 validateHistory206PreviewLocator(locator,previewProfile);const result=await app.inject({url:'/api/health',method:'GET'});
 assert.equal(result.statusCode,200,'Preview is not ready');const health=result.json();
 assert(health.status==='ok'&&health.revision===previewRevision(previewProfile)&&health.restore_preview===false,'Exact approved revision and writable synthetic copy required');
}
/** Only this driver admits the one named synthetic copy; numeric scratch database admission is unchanged. */
export async function prepareHistory206CasesFromPreview(locatorFile,{previewProfile='preview05',beforeReturn,includeRejectedHistory=false,modes=[false,true],httpReceiptIdsOnly=false,onReceived}={}){
 const locator=await readHistory206PreviewLocator(locatorFile,previewProfile);await assertHistory206CasesFileFresh(locator.casesFile);
 const app=createHistory206PreviewTransport(locator,fetch,previewProfile);
 await assertHistory206PreviewReady(app,locator,previewProfile);
 const admission=Object.freeze({});previewAdmissions.set(admission,locator);
 return prepareHistory206Cases({app,databaseUrl:locator.databaseUrl,casesFile:locator.casesFile,login:locator.login,previewAdmission:admission,beforeReturn,includeRejectedHistory,modes,httpReceiptIdsOnly,onReceived});
}

export async function prepareHistory206Cases({app,databaseUrl,casesFile,login={email:'admin@demo.local',password:'DynaDemo!2026'},previewAdmission,beforeReturn,includeRejectedHistory=false,modes=[false,true],httpReceiptIdsOnly=false,onReceived}){
 assert(beforeReturn===undefined||typeof beforeReturn==='function');assert.equal(typeof includeRejectedHistory,'boolean');assert.equal(typeof httpReceiptIdsOnly,'boolean');assert(Array.isArray(modes)&&modes.length>=1&&modes.length<=2&&modes.every(x=>typeof x==='boolean')&&new Set(modes).size===modes.length);assert(onReceived===undefined||typeof onReceived==='function');
 const u=new URL(databaseUrl);assert(['127.0.0.1','localhost','[::1]'].includes(u.hostname));const selected=previewAdmissions.get(previewAdmission);
 if(selected){assert.equal(databaseUrl,selected.databaseUrl);assert.equal(casesFile,selected.casesFile);previewAdmissions.delete(previewAdmission);}
 else assert.match(u.pathname,/^\/dynaminds_test_\d+$/);
 const casesDirectory=await assertHistory206CasesFileFresh(casesFile);
 const pg=await import('pg'),pool=new pg.default.Pool({connectionString:databaseUrl,options:'-c timezone=UTC -c jit=off -c statement_timeout=120000 -c lock_timeout=8000',max:1});
 const consent=p=>({client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true});const cases=[];
 try{const identity=(await pool.query('SELECT current_database() name,current_user,session_user')).rows[0];assert.equal(identity.name,decodeURIComponent(u.pathname.slice(1)),'Selected fixture database differs');assert.equal(identity.current_user,'postgres');assert.equal(identity.session_user,'postgres');
 for(const on of modes){
  const tenant=randomUUID(),remoteAddress=on?'127.165.0.2':'127.165.0.1';
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own actual return credit206','enterprise')",[tenant]);
  const user=(await pool.query("SELECT id FROM users WHERE email=$1",[login.email])).rows[0];assert(user,'Existing real fixture login required');
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')",[tenant,user.id]);
  const loginResponse=await app.inject({method:'POST',url:'/api/auth/login',payload:login,remoteAddress});assert.equal(loginResponse.statusCode,200,'Existing fixture login');
  const switched=await app.inject({method:'POST',url:'/api/workspaces/switch',payload:{tenant_id:tenant},headers:{cookie:String(loginResponse.headers['set-cookie']).split(';')[0]},remoteAddress});assert.equal(switched.statusCode,200);
  const cookie=String(switched.headers['set-cookie']).split(';')[0];
  const ok=async(path,method='GET',payload=undefined,status=200)=>{const r=await app.inject({url:'/api'+path,method,payload,headers:{cookie},remoteAddress});assert.equal(r.statusCode,status,`${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g,'[own-id]')}: HTTP ${r.statusCode} ${JSON.stringify(r.json()).slice(0,500)}`);return r.json();};
  const wh=[];for(const label of ['A','B'])wh.push(await ok('/warehouses','POST',{name:'Own credit206 '+label,code:'RC'+label+'-'+randomUUID().slice(0,8)}));
  const primary=(await pool.query('SELECT * FROM product_catalogs WHERE tenant_id=$1 AND is_default',[tenant])).rows[0];assert(primary);
  const products=[];for(const cost of(on?['0','1000',null]:[null]))products.push({...await ok('/products','POST',{catalog_id:primary.id,name:'Actual return206 '+String(cost),sku:'RC206-'+randomUUID(),price:1501,vat:23,warehouse_id:wh[0].id,quantity:5,location:'A-01'},201),cost});
  if(on){const lines=[];for(const p of products){const stock=(await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',[tenant,wh[0].id,p.id])).rows[0];lines.push({product_id:p.id,warehouse_id:wh[0].id,location:'A-01',quantity:5,stock_version:String(stock.version),lot_code:'RC206-'+randomUUID(),unit_cost_minor:p.cost});}
   const opening=(await ok('/wms-lots/opening-previews','POST',{client_key:randomUUID(),policy_version:'0',currency:'PLN',note:'Genuine zero known unknown opening206',lines},201)).preview;assert.equal(opening.ready,true);await ok('/wms-lots/opening-previews/'+opening.id+'/activate','POST',{...consent(opening),ack_unknown_costs:true},201);}
  const cp=(await ok('/warehouse-inventory-policies/warehouses/'+wh[1].id+'/previews','POST',{client_key:randomUUID(),version:'0',usage:'custody',enabled:true},201)).preview;
  const custody=(await ok('/warehouse-inventory-policies/previews/'+cp.id+'/commit','POST',consent(cp),201)).operation.after;
  const product=on?await ok('/products','POST',{catalog_id:primary.id,name:'Actual native return206 bundle',sku:'BRC206-'+randomUUID(),kind:'bundle',price:1000,vat:23,warehouse_id:wh[0].id,quantity:0,components:products.map(p=>({product_id:p.id,quantity:1}))},201):products[0];
  let order=await ok('/orders','POST',{source:'manual',customer_name:'Own return206 buyer',email:'return206@example.test',address:{street:'Own return206',city:'Warszawa',postal_code:'00-206',country:'PL',phone:'500000206'},warehouse_id:wh[0].id,payment_mode:'prepaid',currency:'PLN',shipping_cost:0,items:[{product_id:product.id,quantity:3}],manual_lines:[{product_id:product.id,quantity:1,line_total:1000},{product_id:product.id,quantity:2,line_total:3401}]},201);
  order=await ok('/orders/'+order.id);assert.equal(order.items.length,2);
  await ok('/orders/'+order.id+'/payments','POST',{client_key:randomUUID(),version:Number(order.version),kind:'receipt',amount:4401,currency:'PLN',method:'other',reference:'Own local declaration206',confirmed:true});
  const status=async(value)=>{const current=await ok('/orders/'+order.id);await ok('/orders/'+order.id+'/status','PATCH',{status:value,expected_version:String(current.version),client_key:randomUUID()});};
  await status('picking');
  if(on){const allocations=await ok('/wms-lots/orders/'+order.id+'/allocations');assert.equal(allocations.meta.cursor,null);assert.equal(allocations.data.length,3);for(const a of allocations.data){const component=products.find(p=>p.id===a.product_id);assert(component);for(let n=0;n<a.quantity;n++)await ok('/orders/'+order.id+'/scan','POST',{client_key:randomUUID(),code:component.sku,location:a.location,layer_id:a.layer_id});}}
  else for(let n=0;n<3;n++)await ok('/orders/'+order.id+'/scan','POST',{client_key:randomUUID(),code:product.sku,location:'A-01'});
  await status('packed');await ok('/orders/'+order.id+'/ship-demo','POST',{});order=await ok('/orders/'+order.id);
  const sourceReply=await ok('/catalog-stock-control/catalogs/'+primary.id+'/source');assert.equal(sourceReply.writers_available,true);assert.equal(sourceReply.activation_available,true);const src=sourceReply.source;assert.equal(src.ready,true,JSON.stringify(src.blockers));
  const activation=(await ok('/catalog-stock-control/catalogs/'+primary.id+'/previews','POST',{client_key:randomUUID(),catalog_version:src.snapshot.catalog.version,policy_version:src.snapshot.policy.version,warehouse_policy_versions:src.snapshot.warehouses.map(w=>({warehouse_id:w.id,version:w.policy.version})),series_versions:src.snapshot.warehouses.map(w=>({warehouse_id:w.id,version:w.series.version}))},201)).preview;assert.equal(activation.ready,true);await ok('/catalog-stock-control/previews/'+activation.id+'/commit','POST',consent(activation),201);
  const extension=beforeReturn?await beforeReturn({ok,tenantId:tenant,order,wms:on}):undefined;
  const requestedItems=extension?.return_items??order.items.map(i=>({item_id:i.id,quantity:i.quantity}));assert(Array.isArray(requestedItems)&&requestedItems.length>0&&requestedItems.length<=100&&new Set(requestedItems.map(i=>i.item_id)).size===requestedItems.length);for(const item of requestedItems){const original=order.items.find(i=>i.id===item.item_id);assert(original&&Number.isSafeInteger(item.quantity)&&item.quantity>0&&item.quantity<=original.quantity);}
  for(const rejectedOnly of (includeRejectedHistory&&!on?[true,false]:[false])){
  let rma=await ok('/orders/'+order.id+'/returns','POST',{client_key:randomUUID(),reason:'Actual native return206',shipping_refund:0,items:requestedItems},201);rma=await ok('/returns/'+rma.id);
  const station=(await ok('/packing/stations','POST',{client_key:randomUUID(),code:'RC206-'+randomUUID().slice(0,8),label:'Own return206 inspection',enabled:true},201)).station;
  const statuses={};for(const effect of ['sale','custody','reject']){const reject=effect==='reject';const p=(await ok('/return-assistant/statuses/previews','POST',{client_key:randomUUID(),kind:'create',settings:{name:'Own credit206 '+effect,color:'#aabbcc',active:true,decision:reject?'reject':'accept',inventory_effect:reject?'none':effect,warehouse_id:reject?null:effect==='sale'?wh[0].id:wh[1].id,warehouse_policy_version:reject?null:effect==='sale'?'0':custody.version,default_location:reject?null:'RETURN-'+effect}},201)).preview;statuses[effect]=(await ok('/return-assistant/statuses/previews/'+p.id+'/commit','POST',consent(p),201)).status;}
  const lease=randomUUID();let session=(await ok('/return-assistant/sessions','POST',{client_key:randomUUID(),return_number:rma.number,station_id:station.id,station_version:String(station.version),lease_token:lease},201)).session;
  for(const line of session.lines)for(let n=0;n<line.requested;n++)session=(await ok('/return-assistant/sessions/'+session.id+'/scans','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease,code:product.sku,item_id:line.item_id})).session;
  const source=(await ok('/return-destinations/returns/'+rma.id+'/source?session_id='+session.id)).source;
  const cheap=source.planner_source.lines.find(i=>i.line_total_minor===1000&&requestedItems.some(r=>r.item_id===i.item_id)),expensive=source.planner_source.lines.find(i=>i.line_total_minor===3401&&requestedItems.some(r=>r.item_id===i.item_id));assert(expensive);if(extension?.expected_commercial_minor===undefined)assert(cheap);
  const parts=[...(cheap?[{part_id:randomUUID(),item_id:cheap.item_id,quantity:1,effect:'sale'}]:[]),{part_id:randomUUID(),item_id:expensive.item_id,quantity:1,effect:'custody'},{part_id:randomUUID(),item_id:expensive.item_id,quantity:1,effect:'reject'}];
  if(rejectedOnly)for(const part of parts)part.effect='reject';
  const arrivals=parts.filter(p=>p.effect!=='reject').flatMap(part=>products.map(p=>({part,product_id:p.id,warehouse_id:statuses[part.effect].settings.warehouse_id})));
  const cells=[...new Map(arrivals.map(a=>[a.warehouse_id+'/'+a.product_id,{warehouse_id:a.warehouse_id,product_id:a.product_id}])).values()];
  const body={protocol:'destinations_v1',client_key:randomUUID(),return_version:source.return_version,session_id:source.session.id,session_version:source.session.version,lease_token:lease,note:'Actual native sale custody reject206',shipping_refund:0,parts:parts.map(p=>({part_id:p.part_id,item_id:p.item_id,quantity:p.quantity,status_id:statuses[p.effect].id,status_version:statuses[p.effect].version})),locations:arrivals.map(a=>({part_id:a.part.part_id,product_id:a.product_id,location:'RETURN-'+a.part.effect,confirmed:true})),stock_versions:cells.map(cell=>{const s=source.planner_source.stocks.find(s=>s.product_id===cell.product_id&&s.warehouse_id===cell.warehouse_id);assert(s);return{...cell,version:s.version};}),...(on?{wms_lots:{policy_version:source.planner_source.wms.policy_version,picks:arrivals.map(a=>{const fragment=source.planner_source.wms.issue_fragments.find(f=>f.product_id===a.product_id&&f.eligible_item_ids.includes(a.part.item_id));assert(fragment);return{part_id:a.part.part_id,issue_fragment_id:fragment.id,quantity:1,location:'RETURN-'+a.part.effect};})}}:{})};
  const preview=(await ok('/return-destinations/returns/'+rma.id+'/previews','POST',body,201)).preview;
  assert.equal(preview.summary.commercial_credit_minor,rejectedOnly?0:(extension?.expected_commercial_minor??2700));const received=await ok('/return-destinations/previews/'+preview.id+'/receive','POST',{...consent(preview),lease_token:lease},201);
  let receipts;if(httpReceiptIdsOnly){if(rejectedOnly){assert.equal(received.return_case.state,'rejected');assert.equal(received.return_case.received_at,null);assert.equal(received.return_case.receipt_sequence,0);assert.deepEqual(received.return_case.stock_receipts,[]);assert.equal(received.operation.action,'reject');receipts=[{id:received.operation.id}];}else{assert(Array.isArray(received.return_case.stock_receipts)&&received.return_case.stock_receipts.length>0);const ids=[...new Set(received.return_case.stock_receipts.map(r=>r.receipt_id))];assert.equal(ids.length,1);receipts=[{id:ids[0]}];}}else receipts=(await pool.query(rejectedOnly?"SELECT ar.id FROM return_assistant_receipts ar JOIN return_destination_admissions d ON(d.tenant_id,d.receipt_id)=(ar.tenant_id,ar.id) WHERE ar.tenant_id=$1 AND ar.return_id=$2 AND d.after_snapshot IS NOT NULL AND d.payload->>'action'='reject'":"SELECT r.id FROM catalog_stock_return_receipts r JOIN catalog_stock_return_admissions a ON(a.tenant_id,a.id)=(r.tenant_id,r.id) WHERE r.tenant_id=$1 AND r.return_id=$2 AND a.protocol='destinations_v1' AND a.sealed",[tenant,rma.id])).rows;assert.equal(receipts.length,1);if(onReceived)await onReceived({tenantId:tenant,order,rma,received,rejectedOnly,receiptId:receipts[0].id,wms:on});
  cases.push({tenant_id:tenant,receipt_id:receipts[0].id,wms:on,...(rejectedOnly?{inspection_only:true}:{})});console.log(JSON.stringify({status:'GENUINE_HISTORY206_CASE_READY',wms:on,rejected_only:rejectedOnly}));
  }
 }
 await assertCasesParentUnchanged(casesFile,casesDirectory);
 await fs.writeFile(casesFile,JSON.stringify({schema:includeRejectedHistory?'dynaminds-native-return-credit207-physical-cases/v1':'dynaminds-native-return-credit206-cases/v1',cases},null,2)+'\n',{mode:0o600,flag:'wx'});
 return cases;
 }finally{await pool.end();}
}
