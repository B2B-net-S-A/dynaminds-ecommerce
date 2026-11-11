/** SOURCE_AUTHOR / NOT_RUN. Import-safe root-owned compatibility acceptance.
 * Genuine newly-created HTTP fixtures; no app/db import, SQL/migration, provider
 * transport, cookie fabrication or strict-catalog activation. Root supplies an
 * already isolated application, complete capture and WX0600 artifact writer.
 * Root remains responsible for process/client/source-pin/provider closure. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createPhysicalWzNativeFixture } from './physical-parcel-wz-native-fixture';

type Artifact = { path:string;sha256:string };
type Entry = { pk?:unknown;row:Record<string,any> };
export type CompatibilityCapture = { graph:{ rows:Record<string,Entry[]>;[key:string]:unknown };[key:string]:unknown };
type Fixture = Awaited<ReturnType<typeof createPhysicalWzNativeFixture>>;
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v)??'undefined';
const omit=(v:Record<string,any>,keys:readonly string[])=>Object.fromEntries(Object.entries(v).filter(([k])=>!keys.includes(k)));
const rows=(s:CompatibilityCapture,table:string):Entry[]=>{assert(Array.isArray(s.graph.rows[table]),'Full capture includes '+table);return s.graph.rows[table];};
const own=(s:CompatibilityCapture,table:string,tenant:string)=>rows(s,table).filter(x=>x.row.tenant_id===tenant);
const oldTables=['parcel_physical_wz_previews','parcel_physical_wz_mappings','parcel_physical_wz_bindings','parcel_physical_wz_certificate'];
const issuerTables=['warehouse_wz_issuer_admissions','warehouse_wz_issuer_receipts','warehouse_wz_issuer_documents','warehouse_wz_issuer_rows','warehouse_wz_issuer_counters'];

/** Prove every preexisting row outside the declared native dispatch changes
 * literal (including PK fields inside each native row). In particular this retains historical 151/134/136/167/168 receipts
 * from other tenants/plans instead of replacing entire tables as an oracle. */
function preserveOld(before:CompatibilityCapture,after:CompatibilityCapture,f:Fixture){
 assert.deepEqual(Object.keys(after.graph.rows).sort(),Object.keys(before.graph.rows).sort());
 assert.deepEqual(omit(after.graph,['rows']),omit(before.graph,['rows']),'All captured schema/metadata literal');
 const changes:Record<string,string[]>={stock:['on_hand','reserved','version'],stock_locations:['quantity'],reservations:['consumed_quantity','state'],reservation_locations:['consumed_quantity'],orders:['status','version','updated_at'],shipments:['status','dispatched_at'],warehouse_wz_issuer_counters:['sequence']};
 for(const [table,original] of Object.entries(before.graph.rows)){
  const current=rows(after,table),literal=new Set(current.map(canonical));
  for(const entry of original){const r=entry.row;
   const declared=r.tenant_id===f.tenant&&((['stock','stock_locations'].includes(table)&&r.warehouse_id===f.warehouse.id&&f.products.some(p=>p.id===r.product_id))||(table==='warehouse_wz_issuer_counters'&&r.warehouse_id===f.warehouse.id)||r.order_id===f.order.id||(table==='orders'&&r.id===f.order.id));
   if(declared&&changes[table]){const fixed=omit(r,changes[table]);const matching=current.filter(x=>canonical(omit(x.row,changes[table]))===canonical(fixed));assert.equal(matching.length,1,'Exactly one original native identity, only declared columns '+table);if(entry.pk!==undefined)assert.deepEqual(matching[0].pk,entry.pk);}
   else assert(literal.has(canonical(entry)),'All other preexisting row bytes '+table);
  }
 }
}
function assertPhysical(before:CompatibilityCapture,after:CompatibilityCapture,f:Fixture,dispatches:any[]){
 for(const [product,total,touches] of [[f.products[0],3,2],[f.products[1],1,1]] as const){
  const find=(s:CompatibilityCapture,table:string)=>own(s,table,f.tenant).find(x=>x.row.product_id===product.id&&(table.startsWith('reservation')?x.row.order_id===f.order.id:x.row.warehouse_id===f.warehouse.id))?.row;
  const b=find(before,'stock'),a=find(after,'stock');assert(b&&a);assert.equal(a.on_hand,b.on_hand-total);assert.equal(a.reserved,b.reserved-total);assert.equal(BigInt(a.version),BigInt(b.version)+BigInt(touches));
  const rb=find(before,'reservations'),ra=find(after,'reservations');assert(rb&&ra);assert.equal(ra.quantity,total);assert.equal(ra.consumed_quantity,total);assert.equal(ra.state,'consumed');assert.equal(rb.consumed_quantity,0);
  const bb=find(before,'stock_locations'),ba=find(after,'stock_locations');assert(bb&&ba);assert.equal(ba.quantity,bb.quantity-total);assert.equal(ba.location,'A-01');
  const hb=find(before,'reservation_locations'),ha=find(after,'reservation_locations');assert(hb&&ha);assert.equal(ha.consumed_quantity,total);assert.equal(ha.scanned,total);assert.equal(hb.consumed_quantity,0);
 }
 for(const table of ['stock_movements','stock_location_movements']){
  const original=rows(before,table),current=rows(after,table),oldIds=new Set(original.map(x=>x.row.id));const added=current.filter(x=>!oldIds.has(x.row.id)).map(x=>x.row);
  assert.equal(added.length,3,'Exactly native three physical movement rows');
  const receiptKey=table==='stock_movements'?'stock_movements':'location_movements';
  assert.deepEqual(new Set(added.map(x=>x.id)),new Set(dispatches.flatMap(d=>d.receipt[receiptKey].map((x:any)=>x.id))));
  for(const d of dispatches)for(const receipt of d.receipt[receiptKey]){const movement=added.find(x=>x.id===receipt.id);assert(movement);assert.equal(movement.tenant_id,f.tenant);assert.equal(movement.order_id,f.order.id);assert.equal(movement.product_id,receipt.product_id);assert.equal(movement.warehouse_id,f.warehouse.id);assert.equal(movement.delta,-receipt.quantity);assert.equal(movement.kind,'shipment');
   if(table==='stock_movements'){assert.equal(movement.note,'parcel:'+d.id);assert.equal(movement.warehouse_document_id,null);}else{assert.equal(movement.operation_id,d.id);assert.equal(movement.location,'A-01');}}
 }
 for(const table of ['wms_operations','wms_issue_fragments','wms_layer_movements','wms_layer_positions','wms_reservation_layers'])assert.deepEqual(rows(after,table),rows(before,table),'No WMS writer in genuine WMS-OFF compatibility fixture');
 const order=own(after,'orders',f.tenant).find(x=>x.row.id===f.order.id)?.row,oldOrder=own(before,'orders',f.tenant).find(x=>x.row.id===f.order.id)?.row;assert(order&&oldOrder);assert.equal(order.status,'shipped');assert.equal(BigInt(order.version),BigInt(oldOrder.version)+1n);assert(Number.isFinite(Date.parse(order.updated_at))&&Date.parse(order.updated_at)>=Date.parse(oldOrder.updated_at));
}

export async function runPhysicalParcelWzCompatibilityNative(args:{
 app:FastifyInstance;capture:()=>Promise<CompatibilityCapture>;
 save:(name:string,value:unknown)=>Promise<Artifact>;
 remoteAddresses:readonly[string,string];tag:string;
}){
 const {app,capture,save}=args;
 assert.notEqual(args.remoteAddresses[0],args.remoteAddresses[1]);
 const start=await capture(),startArtifact=await save('compatibility-start.private.json',start);
 const requests:Array<{path:string;method:string;status:number;artifact:Artifact}>=[];
 async function client(cookie:string,remote:string,path:string,method:InjectOptions['method']='GET',payload?:InjectOptions['payload'],expected=200):Promise<any>{
  const r=await app.inject({url:'/api'+path,method,payload,headers:{cookie},remoteAddress:remote});let body:unknown;
  try{body=r.json();}catch{body={bytes:Buffer.byteLength(r.body,'utf8')};}
  const artifact=await save('compatibility-request-'+String(requests.length).padStart(3,'0')+'.private.json',{path,method,payload:payload??null,status:r.statusCode,body});requests.push({path,method:String(method),status:r.statusCode,artifact});
  assert.equal(r.statusCode,expected,'Actual compatibility endpoint '+method+' '+path);return body;
 }
 async function zero<T>(label:string,fn:()=>Promise<T>):Promise<T>{const before=await capture();const result=await fn();assert.deepEqual(await capture(),before,'Whole database rows/schema/sequences/guards zero: '+label);return result;}

 // Existing import-safe builder performs a genuine ordinary signup and native
 // products/payment/scans/packing/physical preview+apply; it never enables BO.
 const physical=await createPhysicalWzNativeFixture({app,strictCatalog:false,automaticWz:false,remoteAddress:args.remoteAddresses[0],tag:args.tag+'-OFF'});
 assert.equal(physical.strict,null);assert.equal(physical.wz,null);assert.equal(physical.plan.protocol,undefined);
 await zero('actual OFF configuration',async()=>{const o=await client(physical.credentials.cookie,args.remoteAddresses[0],'/warehouse-automatic-wz/options');assert.equal(o.issuer_available,true);const c=o.warehouses.find((w:any)=>w.id===physical.warehouse.id)?.configuration;assert(c);assert(c.settings===null||c.settings.enabled===false,'Actual native configuration is absent or explicitly OFF');});
 const offBefore=await capture(),offBeforeArtifact=await save('compatibility-off-before.private.json',offBefore);for(const t of oldTables.slice(0,3))assert.equal(own(offBefore,t,physical.tenant).length,0);
 const offDispatches:any[]=[],offRequests:any[]=[];
 for(const index of [0,1]){
  const body={client_key:randomUUID(),scope_hash:physical.plan.scope_hash,confirmed:true};offRequests.push(body);
  const result=await client(physical.credentials.cookie,args.remoteAddresses[0],'/order-parcels/plans/'+physical.plan.id+'/parcels/'+index+'/dispatch','POST',body);
  assert.equal(result.reused,false);assert.equal(result.dispatch.parcel_index,index);assert.equal(result.dispatch.shipment_id,physical.plan.parcels[index].shipment_id);offDispatches.push(result.dispatch);
  await zero('OFF exact dispatch replay '+index,async()=>{const r=await client(physical.credentials.cookie,args.remoteAddresses[0],'/order-parcels/plans/'+physical.plan.id+'/parcels/'+index+'/dispatch','POST',body);assert.equal(r.reused,true);assert.deepEqual(r.dispatch,result.dispatch);});
 }
 const offAfter=await capture(),offAfterArtifact=await save('compatibility-off-after.private.json',offAfter);preserveOld(offBefore,offAfter,physical);assertPhysical(offBefore,offAfter,physical,offDispatches);
 for(const t of oldTables)assert.deepEqual(rows(offAfter,t),rows(offBefore,t),'OFF creates no physical map/preview/binding or changes certificate');
 for(const t of issuerTables)assert.deepEqual(rows(offAfter,t),rows(offBefore,t),'OFF does not create automatic WZ');
 await zero('OFF completed normal/v1 source and plan',async()=>{
  for(const prefix of ['', '/v1']){const d=await client(physical.credentials.cookie,args.remoteAddresses[0],prefix+'/order-parcels/plans/'+physical.plan.id);assert.equal(d.plan.complete,true);assert.equal(d.plan.order_status,'shipped');assert.deepEqual(d.dispatches,offDispatches);
   const s=await client(physical.credentials.cookie,args.remoteAddresses[0],prefix+'/order-parcels/plans/'+physical.plan.id+'/physical-wz/source');assert.equal(s.source.approved_mapping_id,null);assert.equal(s.source.approved_at,null);assert(s.source.progress.every((p:any)=>p.state==='dispatched'));}
 });

 // Separate genuine tenant/order. Whole kit quantity1 is parcel0; the simple
 // historical order item quantity1 is parcel1. No component map endpoint used.
 const credentials={email:'wz-commercial-'+randomUUID()+'@example.test',password:'WzCommercial!'+randomUUID()};
 const signup=await app.inject({method:'POST',url:'/api/auth/signup',remoteAddress:args.remoteAddresses[1],payload:{...credentials,name:'WZ commercial local QA',organization:{name:args.tag+' commercial '+randomUUID()}}});assert.equal(signup.statusCode,201);
 const set=signup.headers['set-cookie'];assert(set);const cookie=String(Array.isArray(set)?set[0]:set).split(';')[0];assert(cookie.startsWith('dyna_session='));
 const call=(p:string,m:InjectOptions['method']='GET',b?:InjectOptions['payload'],status=200)=>client(cookie,args.remoteAddresses[1],p,m,b,status);
 const me=await call('/auth/me');assert.equal(me.user.role,'admin');const tenant=me.user.tenant_id,user=me.user.id;
 const warehouse=(await call('/warehouses')).data[0];assert(warehouse?.id);
 const products:any[]=[];for(const suffix of ['A','B'])products.push(await call('/products','POST',{sku:'WZ-C-'+suffix+'-'+randomUUID(),name:'WZ component '+suffix,price:501,vat:23,warehouse_id:warehouse.id,quantity:10,location:'A-01'},201));
 const [a,b]=products,kit=await call('/products','POST',{sku:'WZ-C-KIT-'+randomUUID(),name:'WZ whole kit A2 B1',kind:'bundle',price:1001,vat:23,warehouse_id:warehouse.id,quantity:0,components:[{product_id:a.id,quantity:2},{product_id:b.id,quantity:1}]},201);
 const options=await call('/warehouse-automatic-wz/options');assert.equal(options.issuer_available,true);const cfg=options.warehouses.find((w:any)=>w.id===warehouse.id)?.configuration;assert(cfg);
 const settings={enabled:true,moment:'physical_dispatch',series_name:'Commercial compatibility '+args.tag,prefix:'C168'};
 const wp=await call('/warehouse-automatic-wz/warehouses/'+warehouse.id+'/previews','POST',{client_key:randomUUID(),expected_version:cfg.version,settings},201);assert.equal(wp.preview.ready,true);assert.equal(wp.preview.can_commit,true);
 const wz=await call('/warehouse-automatic-wz/previews/'+wp.preview.id+'/commit','POST',{client_key:randomUUID(),scope_hash:wp.preview.scope_hash,confirmed:true},201);assert.equal(wz.reused,false);assert.deepEqual(wz.operation.after.settings,settings);
 let order=await call('/orders','POST',{customer_name:'Commercial WZ local recipient',email:'commercial-wz-buyer@example.test',address:{street:'Local QA 168',city:'Warszawa',postal_code:'00-168',country:'PL',phone:'+48123456789'},warehouse_id:warehouse.id,currency:'PLN',payment_mode:'prepaid',shipping_cost:0,items:[{product_id:kit.id,quantity:1},{product_id:a.id,quantity:1}]},201);
 order=await call('/orders/'+order.id);assert.equal(order.total,1502);
 await call('/orders/'+order.id+'/payments','POST',{client_key:randomUUID(),version:Number(order.version),kind:'receipt',amount:1502,currency:'PLN',method:'other',reference:'Local declared QA payment',confirmed:true});
 await call('/orders/'+order.id+'/status','PATCH',{status:'picking'});for(const p of [a,a,a,b])await call('/orders/'+order.id+'/scan','POST',{client_key:randomUUID(),code:p.sku,location:'A-01'});
 await call('/orders/'+order.id+'/status','PATCH',{status:'packed'});order=await call('/orders/'+order.id);assert.equal(order.status,'packed');
 const kitItem=order.items.find((i:any)=>i.product_id===kit.id),simple=order.items.find((i:any)=>i.product_id===a.id);assert(kitItem&&simple);assert.notEqual(kitItem.id,simple.id);
 const source=(await call('/order-parcels/orders/'+order.id+'/source')).source;assert.equal(source.can_preview,true);assert.equal(source.cod_due,0);
 const planRequest={client_key:randomUUID(),order_version:source.order.version,protocol:'commercial_v1',parcels:[{source_kind:'demo',cod_minor:0,items:[{item_id:kitItem.id,quantity:1}]},{source_kind:'demo',cod_minor:0,items:[{item_id:simple.id,quantity:1}]}]};
 const preview=(await call('/order-parcels/orders/'+order.id+'/previews','POST',planRequest,201)).preview;
 const consent={client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true};const applied=await call('/order-parcels/previews/'+preview.id+'/apply','POST',consent,201);assert.equal(applied.reused,false);const plan=applied.plan;assert.equal(plan.protocol,'commercial_v1');assert.equal(plan.origins.length,2);
 const commercial={credentials:{...credentials,cookie,user_id:user,tenant_id:tenant},tenant,user,warehouse,products,kit,order,kit_item:kitItem,simple_item:simple,strict:null,wz,parcel_request:planRequest,parcel_preview:preview,parcel_consent:consent,plan,allocation:[]} as unknown as Fixture;
 const onBefore=await capture(),onBeforeArtifact=await save('compatibility-commercial-before.private.json',onBefore),dispatches:any[]=[],dispatchRequests:any[]=[],documents:any[]=[];
 for(const index of [0,1]){
  const body={client_key:randomUUID(),scope_hash:plan.scope_hash,confirmed:true};dispatchRequests.push(body);
  const r=await call('/order-parcels/plans/'+plan.id+'/parcels/'+index+'/dispatch','POST',body);assert.equal(r.reused,false);assert.equal(r.dispatch.parcel_index,index);dispatches.push(r.dispatch);
  await zero('commercial exact replay '+index,async()=>{const q=await call('/order-parcels/plans/'+plan.id+'/parcels/'+index+'/dispatch','POST',body);assert.equal(q.reused,true);assert.deepEqual(q.dispatch,r.dispatch);});
  const snap=await capture(),stored=own(snap,'warehouse_wz_issuer_documents',tenant).filter(x=>x.row.payload.source.plan_id===plan.id&&x.row.payload.source.parcel_index===index);assert.equal(stored.length,1);const head=stored[0].row.payload;
  assert.equal(head.source.dispatch_id,r.dispatch.id);assert.equal(String(head.sequence),String(index+1));assert.equal(head.summary.physical_quantity,index===0?3:1);assert.equal(head.commercial_lines.length,1);
  const line=head.commercial_lines[0],item=index===0?kitItem:simple;assert.equal(line.item_id,item.id);assert.equal(line.product_id,item.product_id);assert.equal(line.quantity,1);assert.equal(line.original_quantity,1);assert.equal(Object.hasOwn(line,'lineage_kind'),false);assert.equal(Object.hasOwn(line,'component_quantities'),false);
  for(const key of ['name','sku','line_total','vat'])assert.deepEqual(line[key],item[key]);assert.equal(line.currency,'PLN');
  assert.deepEqual(new Map(line.components.map((c:any)=>[c.product_id,c.quantity])),new Map(index===0?[[a.id,2],[b.id,1]]:[[a.id,1]]));
  for(const c of line.components)assert.equal(line.allocations.filter((x:any)=>x.product_id===c.product_id).reduce((n:number,x:any)=>n+x.quantity,0),c.quantity);
  await zero('commercial normal/v1 issued detail and exports '+index,async()=>{for(const prefix of ['', '/v1']){const detail=await call(prefix+'/warehouse-wz-issued/documents/'+head.id);assert.deepEqual(detail.document.commercial_lines,head.commercial_lines);assert.equal(detail.rows.reduce((n:number,x:any)=>n+x.quantity,0),index===0?3:1);
    for(const format of ['csv','xml']){const exportReply=await app.inject({method:'GET',url:'/api'+prefix+'/warehouse-wz-issued/documents/'+head.id+'/export?format='+format,headers:{cookie},remoteAddress:args.remoteAddresses[1]});const artifact=await save('compatibility-export-'+index+'-'+(prefix?'v1':'normal')+'-'+format+'.private.json',{status:exportReply.statusCode,content_type:exportReply.headers['content-type'],body:exportReply.body});assert.equal(exportReply.statusCode,200);assert.equal(exportReply.headers['cache-control'],'no-store');const exported=exportReply.json();assert.equal(exported.format,format);assert.equal(exported.document.id,head.id);assert.equal(exported.row_count,detail.rows.length);assert.equal(exported.filename,'WZ-'+head.id+'.'+format);assert.equal(exported.content_type,format==='csv'?'text/csv; charset=utf-8':'application/xml; charset=utf-8');assert.equal(exported.values_included,false);assert.equal(typeof exported.content,'string');assert(exported.content.length>0);assert.deepEqual(exported.document.commercial_lines,head.commercial_lines.map((l:any)=>omit(l,['line_total','vat','currency'])));documents.push({detail,format,artifact});}}
  });
 }
 await zero('commercial original first dispatch replay after complete',async()=>{const r=await call('/order-parcels/plans/'+plan.id+'/parcels/0/dispatch','POST',dispatchRequests[0]);assert.equal(r.reused,true);assert.deepEqual(r.dispatch,dispatches[0]);});
 await zero('commercial plan/consent replay after complete',async()=>{for(const prefix of ['', '/v1']){const detail=await call(prefix+'/order-parcels/plans/'+plan.id);assert.equal(detail.plan.complete,true);assert.equal(detail.plan.order_status,'shipped');assert.deepEqual(detail.dispatches,dispatches);assert.equal(detail.plan.origins.length,2);assert(detail.plan.origins.every((x:any)=>x.quantity===1&&x.issued_quantity===1));}
  const q=await call('/order-parcels/previews/'+preview.id+'/apply','POST',consent);assert.equal(q.reused,true);assert.equal(q.plan.id,plan.id);assert.deepEqual(q.plan.parcels,plan.parcels);});
 const onAfter=await capture(),onAfterArtifact=await save('compatibility-commercial-after.private.json',onAfter);preserveOld(onBefore,onAfter,commercial);assertPhysical(onBefore,onAfter,commercial,dispatches);
 for(const t of oldTables)assert.deepEqual(rows(onAfter,t),rows(onBefore,t),'commercial_v1 never creates physical mapping evidence');
 for(const t of ['warehouse_wz_issuer_admissions','warehouse_wz_issuer_receipts','warehouse_wz_issuer_documents'])assert.equal(own(onAfter,t,tenant).length,own(onBefore,t,tenant).length+2,'Two real native whole-unit WZ parents');
 const final=await capture();for(const [table,old] of Object.entries(start.graph.rows)){const literal=new Set(rows(final,table).map(canonical));for(const entry of old)assert(literal.has(canonical(entry)),'Every row preceding both fresh fixture tenants is literal '+table);}
 assert.deepEqual(omit(final.graph,['rows']),omit(start.graph,['rows']));
 const finalArtifact=await save('compatibility-final.private.json',final);
 const fixtureArtifact=await save('compatibility-fixtures.private.json',{physical,commercial});
 const evidence=await save('compatibility-result.private.json',{status:'ACTUAL_PHYSICAL_WZ_OFF_COMMERCIAL_V1_ON_COMPATIBILITY_PASS',start:startArtifact,final:finalArtifact,fixture:fixtureArtifact,positive_captures:{off_before:offBeforeArtifact,off_after:offAfterArtifact,commercial_before:onBeforeArtifact,commercial_after:onAfterArtifact},requests,physical:{plan_id:physical.plan.id,dispatches:offDispatches,dispatch_requests:offRequests},commercial:{plan_id:plan.id,dispatches,dispatch_requests:dispatchRequests,documents},strict_catalog_public_activation:'NOT_ATTEMPTED',all_gets_and_exact_replays_full_capture_zero:true,all_preexisting_rows_except_declared_native_dispatch_literal:true,new_physical_mapping_rows:0,provider_and_process_closure:'ROOT_REQUIRED'});
 return {status:'ACTUAL_PHYSICAL_WZ_OFF_COMMERCIAL_V1_ON_COMPATIBILITY_PASS',artifact:evidence,physical_wz_off_without_mapping:true,commercial_v1_real_whole_units:true,all_reads_replays_full_capture_zero:true,root_resources_and_provider_closure_required:true};
}
