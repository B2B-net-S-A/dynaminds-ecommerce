/** SOURCE_AUTHOR / NOT_RUN. Root supplies isolated native applications, genuine
 * WMS-enabled HTTP fixtures, full owner RRRO capture and WX0600 saving. This
 * helper does not import app/db, manufacture sessions, enable strict policy,
 * migrate or call providers. It never relabels native PZ/WZ as PW/RW. */
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import type { FastifyInstance,InjectOptions } from 'fastify';
type Row=Record<string,any>;type Entry={row:Row;pk?:unknown};
export type InventoryOnCapture={graph:{rows:Record<string,Entry[]>;[key:string]:unknown};guards:Record<string,boolean>;sequences:Row[];[key:string]:unknown};
type Artifact={path:string;sha256:string};
export type InventoryOnFixture={tenantId:string;userId:string;ownerCookie:string;sessionName:string;apiToken:string;productId:string;warehouseId:string;location:string;strict:boolean;currency:'PLN'|'EUR'|'USD'|'GBP'|'CZK'};
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v)??'undefined';
const omit=(v:Row,ks:readonly string[])=>Object.fromEntries(Object.entries(v).filter(([k])=>!ks.includes(k)));
function rows(s:InventoryOnCapture,t:string):Row[]{assert(Array.isArray(s.graph.rows[t]),'Complete native table '+t);return s.graph.rows[t].map(e=>e.row);}
function delta(b:InventoryOnCapture,a:InventoryOnCapture,t:string):Row[]{const old=new Set(rows(b,t).map(canonical));return rows(a,t).filter(r=>!old.has(canonical(r)));}
function single(s:InventoryOnCapture,t:string,f:(r:Row)=>boolean):Row{const rs=rows(s,t).filter(f);assert.equal(rs.length,1,'Exactly one native '+t);return rs[0];}
function metadata(b:InventoryOnCapture,a:InventoryOnCapture){assert.deepEqual(omit(a.graph,['rows']),omit(b.graph,['rows']));assert.deepEqual(omit(a,['graph','sequences']),omit(b,['graph','sequences']));assert(Object.values(a.guards).every(v=>v===true));}
function preserve(b:InventoryOnCapture,a:InventoryOnCapture,f:InventoryOnFixture,q:number,layerId:string|null,counter:{series_id:string;year:number}|null){
 metadata(b,a);assert.deepEqual(Object.keys(a.graph.rows).sort(),Object.keys(b.graph.rows).sort());
 for(const[t,es]of Object.entries(b.graph.rows))for(const e of es){const r=e.row;let changes:string[]=[];
  if(r.tenant_id===f.tenantId&&r.product_id===f.productId&&r.warehouse_id===f.warehouseId){
   if(t==='stock')changes=['on_hand','available','version'];
   if(t==='stock_locations'&&r.location===f.location)changes=['quantity'];
   if(t==='wms_layer_positions'&&q<0&&r.location===f.location&&r.layer_id===layerId)changes=['quantity','version'];
  }
  if(t==='catalog_stock_control_counters'&&counter&&r.tenant_id===f.tenantId&&r.series_id===counter.series_id&&r.year===counter.year)changes=['value'];
  if(changes.length){const fixed=omit(r,changes),matching=a.graph.rows[t].filter(x=>canonical(omit(x.row,changes))===canonical(fixed));assert.equal(matching.length,1,'Original native identity '+t);if(e.pk!==undefined)assert.deepEqual(matching[0].pk,e.pk);
   if(t==='stock'){assert.equal(matching[0].row.on_hand,r.on_hand+q);assert.equal(matching[0].row.available,r.available+q);assert.equal(BigInt(matching[0].row.version),BigInt(r.version)+1n);}
   if(t==='stock_locations')assert.equal(matching[0].row.quantity,r.quantity+q);
   if(t==='wms_layer_positions'){assert.equal(matching[0].row.quantity,r.quantity+q);assert.equal(BigInt(matching[0].row.version),BigInt(r.version)+1n);}
   if(t==='catalog_stock_control_counters')assert.equal(BigInt(matching[0].row.value),BigInt(r.value)+1n);
  }else assert(a.graph.rows[t].some(x=>canonical(x)===canonical(e)),'All undeclared old row/PK literal '+t);
 }
 const allowed=new Set(['warehouse_documents','warehouse_document_lines','wms_operations','wms_lots','wms_cost_layers','wms_layer_positions','wms_layer_movements','wms_issue_fragments','stock_movements','stock_location_movements','purchasing_stock_changes','audit_events',...(f.strict?['catalog_stock_control_effect_admissions','catalog_stock_control_effects','catalog_stock_control_effect_journals','catalog_stock_control_counters']:[])]);
 for(const[t,es]of Object.entries(a.graph.rows)){const original=b.graph.rows[t],keyed=(r:Row)=>canonical(omit(r,t==='stock'?['on_hand','available','version']:t==='stock_locations'?['quantity']:t==='wms_layer_positions'?['quantity','version']:t==='catalog_stock_control_counters'?['value']:[]));
  const known=new Set(original.map(e=>keyed(e.row)));for(const e of es)if(!known.has(keyed(e.row))){assert(allowed.has(t),'Only native correction family appends '+t);assert.equal(e.row.tenant_id,f.tenantId);}
 }
 for(const seq of b.sequences){const next=a.sequences.find(x=>x.name===seq.name);assert(next);assert.deepEqual(next.options,seq.options);const inc=seq.name==='purchasing_stock_changes_id_seq'?1n:seq.name==='wms_cost_layers_fifo_sequence_seq'&&q>0?1n:0n;if(inc){assert.equal(BigInt(next.last_value),BigInt(seq.last_value)+(seq.is_called?inc:inc-1n));assert.equal(next.is_called,true);}else assert.deepEqual(next,seq);}
 assert.equal(a.sequences.length,b.sequences.length);
}
export async function runInventoryCorrectionOnNative(args:{app:FastifyInstance;readonlyApp:FastifyInstance;fixtures:InventoryOnFixture[];capture:()=>Promise<InventoryOnCapture>;save:(name:string,value:unknown)=>Promise<Artifact>}){
 const {app,readonlyApp,capture,save}=args;assert(args.fixtures.length>=1&&args.fixtures.length<=4,'At least one genuine WMS ON fixture, bounded to four');
 const requests:Row[]=[],proofs:Row[]=[];
 async function request(client:FastifyInstance,path:string,method:InjectOptions['method'],body:unknown,auth:{cookie?:string;token?:string},label:string){
  await save('inventory-on-intent-'+label+'.private.json',{path,method,body,authentication:auth.token?'native_api_key':'native_session',readonly_app:client===readonlyApp});
  const response=await client.inject({method,url:path,...(body===undefined?{}:{payload:body as Row}),headers:auth.token?{authorization:'Bearer '+auth.token}:{cookie:auth.cookie!}});
  const journal={path,method,status:response.statusCode,headers:response.headers,body:response.json()};requests.push(journal);await save('inventory-on-response-'+label+'.private.json',journal);return journal;
 }
 async function zero(label:string,work:()=>Promise<void>){const b=await capture(),ref=await save('inventory-on-zero-before-'+label+'.private.json',b);await work();const a=await capture();assert.deepEqual(a,b,'Full native rollback/GET/replay literal '+label);await save('inventory-on-zero-after-'+label+'.private.json',a);proofs.push({label,full_native_zero:true,before:ref});}
 for(let n=0;n<args.fixtures.length;n++){
  const f=args.fixtures[n],start=await capture(),cookiePair=f.ownerCookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(f.sessionName+'='));assert(cookiePair,'Real namespaced cookie');const token=decodeURIComponent(cookiePair.slice(f.sessionName.length+1));
  single(start,'sessions',r=>r.tenant_id===f.tenantId&&r.user_id===f.userId&&r.token_hash===createHash('sha256').update(token).digest('hex'));
  const k=single(start,'api_keys',r=>r.tenant_id===f.tenantId&&r.user_id===f.userId&&r.token_hash===createHash('sha256').update(f.apiToken).digest('hex'));assert.equal(k.revoked_at,null);assert(['inventory:read','inventory:write','purchasing:read','purchasing:write'].every(s=>k.scopes.includes(s)));
  assert.equal(single(start,'memberships',r=>r.tenant_id===f.tenantId&&r.user_id===f.userId).role,'admin');
  const policy=single(start,'wms_policies',r=>r.tenant_id===f.tenantId);assert.equal(policy.enabled,true);assert.equal(policy.currency,f.currency);
  const product=single(start,'products',r=>r.tenant_id===f.tenantId&&r.id===f.productId);const cp=rows(start,'catalog_stock_control_policies').find(r=>r.tenant_id===f.tenantId&&r.catalog_id===product.catalog_id);assert.equal(cp?.strict??false,f.strict);
  // Require an existing bin/stock: this gate proves exactly one coupled update,
  // not the separate absence-birth source/version scenario.
  single(start,'stock',r=>r.tenant_id===f.tenantId&&r.product_id===f.productId&&r.warehouse_id===f.warehouseId);
  single(start,'stock_locations',r=>r.tenant_id===f.tenantId&&r.product_id===f.productId&&r.warehouse_id===f.warehouseId&&r.location===f.location);
  let addedLayer:string|null=null;
  for(const q of [4,-2]){
   const source=await capture(),stock=single(source,'stock',r=>r.tenant_id===f.tenantId&&r.product_id===f.productId&&r.warehouse_id===f.warehouseId),version=single(source,'wms_policies',r=>r.tenant_id===f.tenantId).version;
   const body:Row={client_key:randomUUID(),policy_version:String(version),kind:'adjustment',product_id:f.productId,warehouse_id:f.warehouseId,location:f.location,quantity:q,stock_versions:[{product_id:f.productId,warehouse_id:f.warehouseId,version:String(stock.version)}],note:'Native public WMS correction'};
   if(q>0)Object.assign(body,{unit_cost_minor:'123',currency:f.currency,lot_code:'ON-'+randomUUID()});else{assert(addedLayer);body.layer_ids=[addedLayer];}
   const previewPath=(q>0?'/api':'/api/v1')+'/inventory/adjust/previews',auth=q>0?{cookie:f.ownerCookie}:{token:f.apiToken},label=n+'-'+(q>0?'plus':'minus');
   const p=await request(app,previewPath,'POST',body,auth,label+'-preview');assert.equal(p.status,201);assert.equal(p.body.reused,false);assert.equal(p.body.preview.kind,'adjustment');assert.equal(p.body.preview.ready,true);
   await zero(label+'-read',async()=>{const r=await request(app,previewPath+'/'+p.body.preview.id,'GET',undefined,auth,label+'-read');assert.equal(r.status,200);assert.equal(r.body.preview.id,p.body.preview.id);});
   const apply={protocol:'wms_adjustment090',preview_id:p.body.preview.id,client_key:randomUUID(),scope_hash:p.body.preview.scope_hash,confirmed:true};
   await zero(label+'-consent',async()=>{assert.equal((await request(app,(q>0?'/api':'/api/v1')+'/inventory/adjust','POST',{...apply,confirmed:false},auth,label+'-consent')).status,422);});
   await zero(label+'-readonly',async()=>{assert.equal((await request(readonlyApp,'/api/inventory/adjust','POST',{malformed:true},{cookie:f.ownerCookie},label+'-readonly')).status,423);});
   const before=await capture(),beforeRef=await save('inventory-on-before-'+label+'.private.json',before);
   const r=await request(app,(q>0?'/api':'/api/v1')+'/inventory/adjust','POST',apply,auth,label+'-execute');assert.equal(r.status,201);assert.equal(r.body.reused,false);assert.equal(r.body.operation.kind,'adjustment');assert.equal(r.body.correction_protocol,'wms_adjustment090');assert.equal(r.body.document_protocol,f.strict?'strict152_pw_rw':'native_wms090');
   const after=await capture(),afterRef=await save('inventory-on-after-'+label+'.private.json',after);preserve(before,after,f,q,q<0?addedLayer:null,f.strict?{series_id:r.body.correction_document.series_id,year:r.body.correction_document.year}:null);
   assert.equal(delta(before,after,'wms_operations').length,1);assert.equal(delta(before,after,'warehouse_documents').length,1);const op=single(after,'wms_operations',x=>x.id===r.body.operation.id);assert.equal(op.tenant_id,f.tenantId);assert.equal(op.actor_id,f.userId);assert.equal(op.source,q>0?'manual':'api');assert.deepEqual(op.request,{preview_id:apply.preview_id,client_key:apply.client_key,scope_hash:apply.scope_hash,confirmed:true});assert.equal(op.request_hash,createHash('sha256').update(canonical({actor_id:f.userId,source:op.source,kind:'adjustment',request:op.request})).digest('hex'));
   const doc=single(after,'warehouse_documents',x=>x.id===op.warehouse_document_id);assert.equal(doc.kind,q>0?'receipt':'issue');assert.equal(doc.status,'posted');assert.equal(doc.reference,'WMS/'+apply.preview_id);
   const lines=delta(before,after,'warehouse_document_lines');assert.equal(lines.length,1);assert.equal(lines[0].product_id,f.productId);assert.equal(lines[0].quantity,Math.abs(q));
   for(const t of ['stock_movements','stock_location_movements','wms_layer_movements']){const js=delta(before,after,t);assert.equal(js.length,1);assert.equal(js[0].delta,q);assert.equal(js[0].product_id,f.productId);assert.equal(js[0].warehouse_id,f.warehouseId);if(t==='wms_layer_movements')assert.equal(js[0].operation_id,op.id);else assert.equal(js[0].kind,'wms_adjustment');}
   const purchase=delta(before,after,'purchasing_stock_changes');assert.equal(purchase.length,1);assert.equal(purchase[0].tenant_id,f.tenantId);
   const audits=delta(before,after,'audit_events');assert.equal(audits.length,2);assert(audits.every(x=>x.user_id===f.userId));assert.deepEqual(audits.map(x=>x.action).sort(),['warehouse.document.create','wms.movement.execute']);
   if(q>0){const ls=delta(before,after,'wms_cost_layers');assert.equal(ls.length,1);assert.equal(ls[0].quantity_received,4);assert.equal(String(ls[0].unit_cost_minor),'123');assert.equal(ls[0].currency,f.currency);addedLayer=ls[0].id;assert.equal(delta(before,after,'wms_lots').length,1);const position=single(after,'wms_layer_positions',x=>x.tenant_id===f.tenantId&&x.layer_id===addedLayer);assert.equal(position.quantity,4);assert.equal(position.reserved,0);assert.equal(String(position.version),'1');}
   else{const fs=delta(before,after,'wms_issue_fragments');assert.equal(fs.length,1);assert.equal(fs[0].layer_id,addedLayer);assert.equal(fs[0].quantity,2);assert.equal(String(fs[0].unit_cost_minor),'123');assert.equal(String(fs[0].value_minor),'246');}
   if(f.strict){assert(r.body.correction_document);assert.equal(r.body.correction_document.kind,q>0?'PW':'RW');assert.equal(r.body.correction_document.operation_id,op.id);assert.equal(String(r.body.correction_document.quantity),String(Math.abs(q)));assert.equal(delta(before,after,'catalog_stock_control_effect_admissions').length,1);assert.equal(delta(before,after,'catalog_stock_control_effects').length,1);assert.equal(delta(before,after,'catalog_stock_control_effect_journals').length,3);}else assert.equal(r.body.correction_document,null);
   await zero(label+'-replay',async()=>{const again=await request(app,(q>0?'/api':'/api/v1')+'/inventory/adjust','POST',apply,auth,label+'-replay');assert.equal(again.status,200);assert.equal(again.body.reused,true);assert.deepEqual(again.body.operation,r.body.operation);assert.deepEqual(again.body.correction_document,r.body.correction_document);});
   await zero(label+'-changed-key-body',async()=>{assert.equal((await request(app,(q>0?'/api':'/api/v1')+'/inventory/adjust','POST',{...apply,scope_hash:(apply.scope_hash[0]==='0'?'1':'0')+apply.scope_hash.slice(1)},auth,label+'-changed-key-body')).status,409);});
   proofs.push({label,strict:f.strict,signed_delta:q,before:beforeRef,after:afterRef,operation_id:op.id,document_protocol:r.body.document_protocol,old_rows_except_exact_native_stock_bin_position_counter_delta_literal:true});
  }
 }
 const result={status:'ROOT_NATIVE_PUBLIC_WMS_CORRECTION_ON_PASS',strict_native_pw_rw_proved:args.fixtures.some(f=>f.strict),nonstrict_native_wms090_proved:args.fixtures.some(f=>!f.strict),proofs,requests:await save('inventory-on-requests.private.json',requests),off_manual_correction_proved:false,global_stock_control_activation_proved:false,late_held_iam_and_ttl_proved:false,root_resource_provider_source_closure_required:true};
 await save('inventory-on-result.private.json',result);return result;
}
