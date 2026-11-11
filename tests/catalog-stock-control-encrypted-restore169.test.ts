import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {crc32,deflateSync} from 'node:zlib';
import pg from 'pg';
import type {Fixture169,Row} from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Server modules load only after isolated WX0600
// config/image settings. Genuine APIs/internal BO; real createBackup/restoreBackup.
// No provisioning, provider exchange, workers, copy login or manifest rebasing.
type Capture=Awaited<ReturnType<typeof import('../scripts/stocktake-adjustments-native164-preservation').captureStocktakeAdjustmentPreservation>>;
let fx:typeof import('./catalog-stock-control169-fixture'),bo:typeof import('../server/catalog-stock-control');
let db:typeof import('../server/db'),recovery:typeof import('../server/recovery'),security:typeof import('../server/security');
let capture:typeof import('../scripts/stocktake-adjustments-native164-preservation').captureStocktakeAdjustmentPreservation;
let app:Awaited<ReturnType<typeof import('../server/app').buildApp>>,source:pg.Client,copy:pg.Client;
let baseline:Capture,restoredCapture:Capture,beforeSequences:Record<string,Row>,directory='',images='',providers=0;
let archive:Awaited<ReturnType<typeof import('../server/recovery').createBackup>>;
let restored:Awaited<ReturnType<typeof import('../server/recovery').restoreBackup>>|undefined;
let imageId='',channelId='',oauthStateHash='',oauthVerifier='',channelCipher='',secret='';
let privateConfig:{dbPassword:string;encryptionKey:string},clusterRoles:Row[],clusterMembers:Row[];
const originalEnv=new Map<string,string|undefined>();
const graphs:{f:Fixture169;order:Row;rma:Row;request:Row;documentId:string;receiptId:string}[]=[];
const countGraphs:{tenant:string;previewId:string;executionId:string;protocol:'inventory_bulk'|'stock_file';documentIds:string[]}[]=[];
const one=(rows:Row[])=>{assert.equal(rows.length,1);return rows[0];};
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
function setEnv(name:string,value:string){originalEnv.set(name,process.env[name]);process.env[name]=value;}
async function rr<T>(c:pg.Client,fn:()=>Promise<T>){await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TIME ZONE 'UTC'");
  try{const value=await fn();await c.query('COMMIT');return value;}catch(error){await c.query('ROLLBACK');throw error;}}
async function sequences(c:pg.Client){const out:Record<string,Row>={};
  for(const{relname}of(await c.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S' ORDER BY 1")).rows){
    assert.match(relname,/^[a-z][a-z0-9_]*$/);out[relname]=(await c.query('SELECT last_value::text,is_called FROM public."'+relname+'"')).rows[0];}return out;}
async function guardPins(c:pg.Client){const g=(await c.query(`SELECT public.catalog_stock_control_installed() installed,
  public.catalog_stock_control_guards() core,public.catalog_stock_count_guards() count,public.catalog_stock_return_guards() returns,
  public.stocktake_adjustment_guards() adjustments,public.warehouse_automatic_wz_guards() configuration,public.warehouse_wz_issuer_guards() issuer`)).rows[0];
  for(const v of Object.values(g))assert.equal(v,true);
  const f=(await c.query(`SELECT
    (SELECT fingerprint FROM public.catalog_stock_control_manifest WHERE id) core_stored,public.catalog_stock_control_fingerprint() core_actual,
    (SELECT fingerprint FROM public.catalog_stock_count_manifest WHERE id) count_stored,public.catalog_stock_count_fingerprint() count_actual,
    (SELECT fingerprint FROM public.catalog_stock_return_manifest WHERE id) return_stored,public.catalog_stock_return_fingerprint() return_actual`)).rows[0] as Record<string,string>;
  for(const n of ['core','count','return'])assert.equal(f[n+'_actual'],f[n+'_stored']);return{guards:g,fingerprints:f};}
async function roleRows(c:pg.Client){return(await c.query('SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles ORDER BY rolname')).rows as Row[];}
async function memberRows(c:pg.Client){return(await c.query('SELECT to_jsonb(m) row FROM pg_auth_members m ORDER BY 1')).rows as Row[];}
async function sourceUnchanged(){assert.deepEqual(await rr(source,()=>capture(source)),baseline);
  assert.deepEqual(await rr(source,()=>sequences(source)),beforeSequences);assert.deepEqual(await roleRows(source),clusterRoles);
  assert.deepEqual(await memberRows(source),clusterMembers);}
async function privateToolDirectory(){
  const tools=resolve(process.env.DYNA_PG_TOOLS??resolve(homedir(),'.local/share/dynaminds/pg-tools/18/bin'));assert.equal(await realpath(tools),tools);
  for(const name of ['pg_dump','pg_restore'] as const){const p=resolve(tools,name),s=await lstat(p);
    assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.nlink,1);assert.equal(await realpath(p),p);
    const expected=process.env[name==='pg_dump'?'DYNA_ACL169_PG_DUMP_SHA256':'DYNA_ACL169_PG_RESTORE_SHA256'];
    assert.match(expected??'',/^[a-f0-9]{64}$/);assert.equal(hash(await readFile(p)),expected);}
  return tools;
}
function png(){const chunk=(name:string,body:Buffer)=>{const t=Buffer.from(name),len=Buffer.alloc(4),crc=Buffer.alloc(4);
  len.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(Buffer.concat([t,body])));return Buffer.concat([len,t,body,crc]);};
  const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(1,4);h[8]=8;h[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,50,100,150,255]))),chunk('IEND',Buffer.alloc(0))]);}
const imageBytes=png();

async function activate(f:Fixture169){const publicSource=await f.ok('/catalog-stock-control/catalogs/'+f.primary.id+'/source');
  assert.equal(publicSource.writers_available,false);assert.equal(publicSource.activation_available,false);
  const beforeRows=await fx.facts169(),ctx={writersAvailable:true};const{source:s}=await bo.sourceCatalogStockControl(f.actor,f.primary.id,ctx);
  assert.equal(s.ready,true,JSON.stringify(s.blockers));const{preview}=await bo.previewCatalogStockControl(f.actor,f.primary.id,{
    client_key:randomUUID(),catalog_version:s.snapshot.catalog.version,policy_version:s.snapshot.policy.version,
    warehouse_policy_versions:s.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:s.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.series.version})),},ctx);
  assert.equal(preview.ready,true);assert.equal((await bo.commitCatalogStockControl(f.actor,preview.id,fx.consent169(preview),ctx)).operation.after.strict,true);
  fx.physicalExact169(beforeRows,await fx.facts169());}

async function returnedFixture(on:boolean){const f=await fx.fixture169(app,on);
  if(!on){const p=f.products[0],bins=(await f.ok('/stock-locations?warehouse_id='+f.warehouse.id+'&product_id='+p.id)).data;
    const bin=one(bins.filter((b:Row)=>b.location==='A-01'));assert.equal(bin.quantity,5);
    await f.ok('/stock-location-moves','POST',{client_key:randomUUID(),warehouse_id:f.warehouse.id,product_id:p.id,
      location:'A-01',destination:'B-01',quantity:1,expected_version:String(bin.version),note:'Actual second count bin before fulfillment and BO'});
  }
  const product=on?await f.ok('/products','POST',{catalog_id:f.primary.id,name:'Actual restored duplicate bundle',sku:'RESTORE169-'+randomUUID(),
    kind:'bundle',price:1501,vat:23,warehouse_id:f.warehouse.id,quantity:0,components:f.products.map(p=>({product_id:p.id,quantity:1}))},201):f.products[0];
  let order=await f.ok('/orders','POST',{source:'manual',customer_name:'Own restore169 buyer',email:'restore169@example.test',
    address:{street:'Own restore169',city:'Warszawa',postal_code:'00-169',country:'PL',phone:'500000169'},warehouse_id:f.warehouse.id,
    payment_mode:'prepaid',currency:'PLN',shipping_cost:0,items:[{product_id:product.id,quantity:3}],
    manual_lines:[{product_id:product.id,quantity:1,line_total:1000},{product_id:product.id,quantity:2,line_total:3401}]},201);
  order=await f.ok('/orders/'+order.id);assert.equal(order.items.length,2);assert.notEqual(order.items[0].id,order.items[1].id);
  assert(order.items.every((i:Row)=>i.product_id===product.id));assert.deepEqual(order.items.map((i:Row)=>i.quantity).sort(),[1,2]);
  await f.ok('/orders/'+order.id+'/payments','POST',{client_key:randomUUID(),version:Number(order.version),kind:'receipt',amount:4401,
    currency:'PLN',method:'other',reference:'Own restore fixture declaration',confirmed:true});
  await f.ok('/orders/'+order.id+'/status','PATCH',{status:'picking'});
  if(on){const allocations=await f.ok('/wms-lots/orders/'+order.id+'/allocations');assert.equal(allocations.meta.cursor,null);assert.equal(allocations.data.length,3);
    for(const a of allocations.data){const p=f.products.find(p=>p.id===a.product_id);assert(p);assert.equal(a.quantity,3);
      for(let n=0;n<3;n++)await f.ok('/orders/'+order.id+'/scan','POST',{client_key:randomUUID(),code:p.sku,location:a.location,layer_id:a.layer_id});}}
  else for(let n=0;n<3;n++)await f.ok('/orders/'+order.id+'/scan','POST',{client_key:randomUUID(),code:product.sku,location:'A-01'});
  await f.ok('/orders/'+order.id+'/status','PATCH',{status:'packed'});await f.ok('/orders/'+order.id+'/ship-demo','POST',{});
  await activate(f);await f.ok('/orders/'+order.id+'/status','PATCH',{status:'return_initiated'});
  const rma=await f.ok('/returns/'+one((await f.ok('/orders/'+order.id+'/returns')).cases).id);
  assert.equal(rma.legacy,true);assert.equal(rma.state,'requested');assert.equal(rma.items.length,2);
  const beforeRows=await fx.facts169();let request:Row;
  if(on){const fragments=fx.own169(beforeRows,'wms_issue_fragments',f.tenant).filter(x=>x.order_id===order.id);assert.equal(fragments.length,3);
    assert(fragments.every(x=>x.quantity===3));const policy=one(fx.own169(beforeRows,'wms_policies',f.tenant));
    request={version:Number(rma.version),note:'Explicit own restore legacy WMS receipt',shipping_refund:0,
      items:rma.items.map((i:Row)=>({item_id:i.item_id,accepted:i.requested,restocked:i.requested})),wms_lots:{client_key:randomUUID(),policy_version:String(policy.version),
        stock_versions:f.products.map(p=>({product_id:p.id,warehouse_id:f.warehouse.id,version:String(one(fx.own169(beforeRows,'stock',f.tenant)
          .filter(s=>s.product_id===p.id&&s.warehouse_id===f.warehouse.id)).version)})),picks:fragments.map(x=>({issue_fragment_id:x.id,quantity:3,location:'A-01'}))}};
    const receipt=await f.ok('/returns/'+rma.id+'/receive','POST',request);assert.equal(receipt.refund_amount,4401);
    const accepted=await fx.facts169();await f.ok('/returns/'+rma.id+'/receive','POST',request);assert.deepEqual(await fx.facts169(),accepted,'ON exact body replay has no second graph');
  }else{request={status:'return_received'};await f.ok('/orders/'+order.id+'/status','PATCH',request);
    const accepted=await fx.facts169();await f.ok('/orders/'+order.id+'/status','PATCH',request,409);
    assert.deepEqual(await fx.facts169(),accepted,'OFF repeated terminal status is refused without a second graph');}
  const accepted=await fx.facts169(),doc=one(fx.own169(accepted,'catalog_stock_return_documents',f.tenant)),receipt=one(fx.own169(accepted,'catalog_stock_return_receipts',f.tenant));
  const admission=one(fx.own169(accepted,'catalog_stock_return_admissions',f.tenant));
  assert.equal(admission.sealed,true);assert.equal(admission.id,receipt.id);assert.equal(admission.actor_id,f.user);
  assert.equal(admission.protocol,on?'rma':'legacy_status');assert.equal(admission.return_id,rma.id);assert.equal(admission.order_id,order.id);
  assert.equal(doc.return_id,rma.id);assert.equal(doc.receipt_id,receipt.id);assert.equal(doc.payload.kind,'PZ');assert.equal(doc.payload.quantity,on?'9':'3');
  assert.equal(doc.payload.row_count,on?3:1);assert.equal(doc.payload.wms_enabled,on);
  const rows=fx.own169(accepted,'catalog_stock_return_rows',f.tenant);assert.equal(rows.length,on?3:1);
  assert(rows.every(r=>r.document_id===doc.id&&r.warehouse_id===f.warehouse.id&&r.quantity===3));
  if(!on)assert.equal(one(rows).location,'ZWROT','Genuine OFF return uses its native destination');
  for(const table of ['order_items','payment_entries','wms_issue_fragments','wms_cost_layers'])
    assert.deepEqual(accepted[table],beforeRows[table],'Return preserves original commercial/issue/cost truth: '+table);
  const maps=fx.own169(accepted,'catalog_stock_return_item_maps',f.tenant);assert.equal(maps.length,on?6:2);
  for(const item of rma.items){const selected=maps.filter(m=>m.item_id===item.item_id);assert.equal(selected.length,on?3:1);
    assert(selected.every(m=>m.quantity===item.requested));}
  const layers=fx.own169(accepted,'catalog_stock_return_layer_maps',f.tenant);assert.equal(layers.length,on?3:0);
  if(on){assert.deepEqual(layers.map(x=>x.payload.unit_cost_minor).sort(),['0','1000',null].sort());
    assert.deepEqual(layers.map(x=>x.payload.value_minor).sort(),['0','3000',null].sort());}
  graphs.push({f,order,rma,request,documentId:doc.id,receiptId:receipt.id});}

async function nativeCount(g:typeof graphs[number],on:boolean){
  const f=g.f,state=await fx.facts169(),stocks=fx.own169(state,'stock',f.tenant),products=fx.own169(state,'products',f.tenant);
  let preview:Row,body:Row,path:string,protocol:'inventory_bulk'|'stock_file';
  if(!on){const p=f.products[0];const bins=fx.own169(state,'stock_locations',f.tenant).filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id);
    assert.equal(one(bins.filter(x=>x.location==='A-01')).quantity,1);
    assert.equal(one(bins.filter(x=>x.location==='B-01')).quantity,1);
    assert.equal(one(bins.filter(x=>x.location==='ZWROT')).quantity,3);
    ({preview}=await f.ok('/inventory-bulk-edit/previews','POST',{client_key:randomUUID(),warehouse_id:f.warehouse.id,
    note:'Real strict zero net count after return before encrypted backup',rows:['A-01','B-01'].map(location=>({
      product_id:p.id,product_version:one(products.filter(x=>x.id===p.id)).version,
      stock_version:String(one(stocks.filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id)).version),
      location,operation:'count',quantity:location==='A-01'?2:0}))},201));
    const page=await f.ok('/inventory-bulk-edit/previews/'+preview.id+'/rows'),frozen=page.data as Row[];
    assert.equal(page.meta.cursor,null);assert.equal(frozen.length,2);
    assert.equal(preview.ready,true,JSON.stringify(frozen.map(r=>({index:r.index,location:r.location,errors:r.errors}))));
    assert.equal(preview.changed,2);body=fx.consent169(preview);
    path='/inventory-bulk-edit/previews/'+preview.id+'/execute';protocol='inventory_bulk';
  }else{
    const positions=fx.own169(state,'wms_layer_positions',f.tenant),layers=fx.own169(state,'wms_cost_layers',f.tenant);
    const content='SKU;Q;LOT;COST;CUR\n'+f.products.map((p,index)=>{
      const pos=one(positions.filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id&&x.location==='A-01'));
      assert.equal(pos.quantity,5);const layer=one(layers.filter(x=>x.id===pos.layer_id));
      return[p.sku,index===2?'4':'6',layer.lot_id,index===2?'':p.cost,index===2?'':'PLN'].join(';');}).join('\n');
    ({preview}=await f.ok('/stock-file-imports/previews','POST',{client_key:randomUUID(),file_name:'encrypted-return-count169.csv',
      note:'Actual strict known zero and known PW plus unknown-cost RW',content,
      definition:{format:'csv',xml_mode:'positions',delimiter:';',identity:'sku',identity_field:'SKU',spreadsheet_safe:false,empty_policy:'skip'},
      targets:[{warehouse_id:f.warehouse.id,quantity_scope:'position',default_location:'A-01',
        mapping:{quantity:'Q',lot_id:'LOT',unit_cost_minor:'COST',currency:'CUR'}}],resolutions:[]},201));
    const page=await f.ok('/stock-file-imports/previews/'+preview.id+'/rows'),frozen=page.rows as Row[];
    assert.equal(page.next_cursor,null);assert.equal(page.total,3);assert.equal(frozen.length,3);
    const diagnostics=JSON.stringify({summary:preview.summary,rows:frozen.map(r=>({index:r.index,errors:r.errors,status:r.status}))});
    assert.equal(preview.summary.invalid,0,diagnostics);assert.equal(preview.summary.conflicts,0,diagnostics);
    assert.equal(preview.summary.changed,3,diagnostics);
    body={...fx.consent169(preview),ack_unknown_loss_warehouse_ids:[f.warehouse.id],ack_surplus_warehouse_ids:[f.warehouse.id]};
    path='/stock-file-imports/previews/'+preview.id+'/execute';protocol='stock_file';
  }
  const result=await f.ok(path,'POST',body,201),accepted=await fx.facts169();
  const docs=fx.own169(accepted,'catalog_stock_count_documents',f.tenant);assert.equal(docs.length,2);
  assert.deepEqual(docs.map(x=>x.kind).sort(),['PW','RW']);
  const native=one(fx.own169(accepted,protocol==='inventory_bulk'?'inventory_bulk_edit_executions':'stock_file_import_executions',f.tenant));
  assert.equal(native.id,result.execution.id);assert.equal(native.preview_id,preview.id);
  const receipt=one(fx.own169(accepted,'catalog_stock_count_receipts',f.tenant));
  assert.equal(receipt[protocol==='inventory_bulk'?'inventory_execution_id':'stock_file_execution_id'],native.id);
  assert(docs.every(d=>d.receipt_id===receipt.id&&d.payload.source_id===preview.id&&d.payload.protocol===protocol));
  const rows=fx.own169(accepted,'catalog_stock_count_rows',f.tenant);assert.equal(rows.length,on?3:2);
  assert(rows.every(r=>docs.some(d=>d.id===r.document_id)));
  if(on){const maps=fx.own169(accepted,'catalog_stock_count_layer_maps',f.tenant);assert.equal(maps.length,3);
    assert.deepEqual(maps.map(x=>x.payload.unit_cost_minor).sort(),['0','1000',null].sort());
    assert(rows.every(r=>r.layer_movement_id!==null&&r.bin_movement_id===null));}
  else{assert(rows.every(r=>r.bin_movement_id!==null&&r.layer_movement_id===null));
    const p=f.products[0],beforeBins=fx.own169(state,'stock_locations',f.tenant).filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id),
      afterBins=fx.own169(accepted,'stock_locations',f.tenant).filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id);
    assert.equal(one(afterBins.filter(x=>x.location==='A-01')).quantity,2);
    assert.equal(one(afterBins.filter(x=>x.location==='B-01')).quantity,0);
    assert.deepEqual(one(afterBins.filter(x=>x.location==='ZWROT')),one(beforeBins.filter(x=>x.location==='ZWROT')));
    assert.equal(one(fx.own169(accepted,'stock',f.tenant).filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id)).on_hand,5);
    assert.deepEqual(accepted.catalog_stock_return_rows,state.catalog_stock_return_rows,'COUNT preserves actual return PZ rows');
  }
  await f.ok(path,'POST',body,200);assert.deepEqual(await fx.facts169(),accepted,'Native COUNT replay creates no second graph/number');
  countGraphs.push({tenant:f.tenant,previewId:preview.id,executionId:native.id,protocol,documentIds:docs.map(d=>d.id)});
}
before(async()=>{
  assert.equal(process.env.DYNA_TEST,'true');const u=new URL(process.env.DATABASE_URL??'');
  assert(['127.0.0.1','localhost','[::1]'].includes(u.hostname));assert.equal(u.port,'55432');assert.equal(u.username,'postgres');
  assert.match(u.pathname,/^\/dynaminds_test_\d+$/);assert(u.password);
  const base=resolve('data/test-catalog-stock-control-encrypted169');await mkdir(base,{recursive:true,mode:0o700});
  assert.equal(await realpath(base),base);const bs=await lstat(base);assert(bs.isDirectory()&&!bs.isSymbolicLink());assert.equal(bs.mode&0o777,0o700);
  directory=await mkdtemp(resolve(base,'case-'));await chmod(directory,0o700);images=resolve(directory,'source-images');await mkdir(images,{mode:0o700});
  privateConfig={dbPassword:decodeURIComponent(u.password),encryptionKey:randomBytes(32).toString('hex')};
  const config=resolve(directory,'source-config.json');await writeFile(config,JSON.stringify(privateConfig),{flag:'wx',mode:0o600});
  setEnv('DYNA_LOCAL_CONFIG_PATH',config);setEnv('DYNA_IMAGE_DIR',images);setEnv('DYNA_WORKER_DISABLED','true');
  setEnv('DYNA_PG_TOOLS',await privateToolDirectory());
  // No application/database/fixture runtime import may precede these settings.
  db=await import('../server/db');recovery=await import('../server/recovery');security=await import('../server/security');
  fx=await import('./catalog-stock-control169-fixture');bo=await import('../server/catalog-stock-control');
  ({captureStocktakeAdjustmentPreservation:capture}=await import('../scripts/stocktake-adjustments-native164-preservation'));
  assert.equal(db.localConfig.encryptionKey===privateConfig.encryptionKey,true,'Application reads the exclusively owned config');
  await fx.bootstrap151169();await(await import('./fixtures')).seed();await fx.install152169();
  app=await(await import('../server/app')).buildApp({backgroundWorkersEnabled:false,integrationTransport:async()=>{
    providers++;throw Error('External provider transport forbidden in encrypted restore169');}});
  await returnedFixture(false);await returnedFixture(true);
  await nativeCount(graphs[0],false);await nativeCount(graphs[1],true);
  const f=graphs[0].f,valid=await import('../server/return-assistant-photo');
  assert.equal(valid.validateReturnAssistantPhoto({mime:'image/png',content_base64:imageBytes.toString('base64')}).width,1);
  const image=await f.ok('/product-images','POST',{data:imageBytes.toString('base64')},201);imageId=image.id;
  assert.equal(image.mime,'image/png');assert.equal(image.size,imageBytes.length);
  const served=await f.request('/product-images/'+imageId);assert.equal(served.statusCode,200);assert.deepEqual(served.rawPayload,imageBytes);
  secret='SYNTHETIC-ENCRYPTED169-'+randomBytes(16).toString('hex');
  channelId=(await f.ok('/integrations','POST',{provider:'ebay',name:'Own encrypted restore169 pending channel',mode:'sandbox',
    credentials:{client_id:'RESTORE169',client_secret:secret,ru_name:'DYNAMINDS-QA-RUNAME'},settings:{price_mode:'gross'}})).id;
  const started=await f.ok('/integrations/'+channelId+'/oauth/start','POST',{});
  const oauthUrl=new URL(started.url),state=oauthUrl.searchParams.get('state');assert(state);oauthStateHash=security.tokenHash(state);
  source=new pg.Client(recovery.localDatabase());await source.connect();
  const channel=one((await source.query('SELECT * FROM channels WHERE id=$1',[channelId])).rows);
  const oauth=one((await source.query('SELECT * FROM oauth_states WHERE state_hash=$1',[oauthStateHash])).rows);
  channelCipher=channel.credentials;oauthVerifier=oauth.verifier;
  assert.equal(channelCipher.includes(secret),false);assert.equal(security.decrypt(channelCipher).client_secret===secret,true);
  assert.equal(security.decrypt(oauthVerifier).provider,'ebay');assert.equal(providers,0);
  clusterRoles=await roleRows(source);clusterMembers=await memberRows(source);
  const role=one(clusterRoles.filter(r=>r.rolname==='dyna_app'));assert.equal(role.rolcanlogin,false);assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  baseline=await rr(source,()=>capture(source));assert.equal(Object.keys(baseline.rows).length,507);
  beforeSequences=await rr(source,()=>sequences(source));await rr(source,()=>guardPins(source));
  archive=await recovery.createBackup({directory:resolve(directory,'backups'),keyFile:resolve(directory,'recovery-key'),imageDirectory:images});
  assert.equal(archive.source,u.pathname.slice(1));assert.equal(archive.tables,507);assert.equal(archive.images,1);
  assert.equal(archive.encryption,'AES-256-GCM');assert.equal(archive.status,'created');
  restored=await recovery.restoreBackup(archive.file,{directory:resolve(directory,'restores'),keyFile:resolve(directory,'recovery-key')});
  assert.equal(restored.database,recovery.restoreDatabaseName(restored.database));assert.notEqual(restored.database,u.pathname.slice(1));
  copy=new pg.Client({...recovery.localDatabase(),database:restored.database});await copy.connect();
  restoredCapture=await rr(copy,()=>capture(copy));await sourceUnchanged();
});
after(async()=>{try{assert.equal(providers,0);await app?.close();await copy?.end();await source?.end();
    if(restored){const c=new pg.Client({...recovery.localDatabase(),database:'postgres'});await c.connect();
      try{assert.notEqual(restored.database,recovery.localDatabase().database);await c.query('DROP DATABASE '+recovery.restoreDatabaseName(restored.database));}finally{await c.end();}}
    await db?.pool.end();if(directory)await rm(directory,{recursive:true,force:true});
  }finally{for(const[name,value]of originalEnv){if(value===undefined)delete process.env[name];else process.env[name]=value;}}});
test('real encrypted product backup restores all507 prelogin rows, portable schema, literal sealed manifests, sequence states and every family guard',async()=>{
  assert(restored);assert.equal(restored.status,'verified');assert.equal(restored.tables,507);assert.equal(restored.image_count,1);
  assert.equal(restored.preview_only,true);assert.equal(restored.worker_enabled,false);
  assert.equal(restored.row_fingerprints_match,true);assert.equal(restored.schema_fingerprint_match,true);
  assert.deepEqual(restoredCapture.rows,baseline.rows);assert.deepEqual(restoredCapture.metadata,baseline.metadata);
  assert.deepEqual(await rr(copy,()=>sequences(copy)),beforeSequences);
  const a=await rr(source,()=>guardPins(source)),b=await rr(copy,()=>guardPins(copy));assert.deepEqual(b,a);
  for(const t of ['catalog_stock_control_manifest','catalog_stock_count_manifest','catalog_stock_return_manifest'])
    assert.deepEqual(restoredCapture.rows[t],baseline.rows[t],'No copied manifest rebasing');
  assert.deepEqual(restoredCapture.rows.sessions,baseline.rows.sessions,'Prelogin: no new, removed or changed session');
  const manifest=recovery.manifestSchema.parse(JSON.parse(await readFile(resolve(restored.directory,'manifest.json'),'utf8')));
  assert.equal(manifest.schema_fingerprint_version,4);assert.equal(manifest.database,archive.source);
  assert.equal(manifest.images.length,1);assert.equal(manifest.images[0].sha256,hash(imageBytes));
  assert.equal(manifest.config_sha256,hash(JSON.stringify(privateConfig)));
  assert.equal((await lstat(restored.config)).mode&0o777,0o600);
  const recovered=JSON.parse(await readFile(restored.config,'utf8'));assert.equal(recovered.encryptionKey===privateConfig.encryptionKey,true);
  assert.equal(recovered.dbPassword===privateConfig.dbPassword,true);await sourceUnchanged();
});
test('copied nonempty BO/RETURN/COUNT graphs retain duplicate item identities and real native journal parents with costs0/known/NULL',async()=>{
  assert.equal(graphs.length,2);assert.equal(countGraphs.length,2);
  for(const g of graphs){const f=g.f,rows=restoredCapture.rows,doc=one(rows.catalog_stock_return_documents.map(x=>x.row).filter(d=>d.id===g.documentId));
    assert.equal(doc.receipt_id,g.receiptId);assert.equal(doc.return_id,g.rma.id);assert.equal(doc.payload.order_id,g.order.id);
    assert(rows.catalog_stock_control_documents.some(x=>x.row.tenant_id===f.tenant&&x.row.payload.kind==='BO'));
    const itemMaps=rows.catalog_stock_return_item_maps.map(x=>x.row).filter(r=>r.return_id===g.rma.id);
    assert.equal(new Set(itemMaps.map(r=>r.item_id)).size,2);assert.deepEqual([...new Set(itemMaps.map(r=>r.quantity))].sort(),[1,2]);}
  for(const g of countGraphs){const docs=restoredCapture.rows.catalog_stock_count_documents.map(x=>x.row).filter(d=>g.documentIds.includes(d.id));
    assert.equal(docs.length,2);assert.deepEqual(docs.map(d=>d.kind).sort(),['PW','RW']);
    assert(docs.every(d=>d.payload.source_id===g.previewId&&d.payload.protocol===g.protocol));
    const receipt=one(restoredCapture.rows.catalog_stock_count_receipts.map(x=>x.row).filter(r=>r.id===docs[0].receipt_id));
    assert.equal(receipt[g.protocol==='inventory_bulk'?'inventory_execution_id':'stock_file_execution_id'],g.executionId);}
  const on=graphs[1],maps=restoredCapture.rows.catalog_stock_return_layer_maps.map(x=>x.row).filter(r=>r.tenant_id===on.f.tenant);
  assert.deepEqual(maps.map(r=>r.payload.unit_cost_minor).sort(),['0','1000',null].sort());
  assert.deepEqual(maps.map(r=>r.payload.value_minor).sort(),['0','3000',null].sort());
  const countMaps=restoredCapture.rows.catalog_stock_count_layer_maps.map(x=>x.row).filter(r=>r.tenant_id===on.f.tenant);
  assert.deepEqual(countMaps.map(r=>r.payload.unit_cost_minor).sort(),['0','1000',null].sort());await sourceUnchanged();
});
test('real image and native OAuth/channel ciphertext recover from isolated encrypted archive without provider calls or plaintext secret bytes',async()=>{
  assert(restored);assert(restored.encrypted_records_verified>=2);
  assert.deepEqual(await readFile(resolve(restored.images,imageId)),imageBytes);assert.deepEqual(await readFile(resolve(images,imageId)),imageBytes);
  assert.equal((await lstat(resolve(restored.images,imageId))).mode&0o777,0o600);
  const restoredChannel=one((await copy.query('SELECT credentials FROM channels WHERE id=$1',[channelId])).rows);
  const restoredOauth=one((await copy.query('SELECT verifier FROM oauth_states WHERE state_hash=$1',[oauthStateHash])).rows);
  assert.equal(restoredChannel.credentials,channelCipher);assert.equal(restoredOauth.verifier,oauthVerifier);
  const recovered=JSON.parse(await readFile(restored.config,'utf8'));
  assert.equal(security.decrypt(restoredChannel.credentials,recovered.encryptionKey).client_secret===secret,true);
  assert.equal(security.decrypt(restoredOauth.verifier,recovered.encryptionKey).provider,'ebay');
  const bytes=await readFile(archive.file);assert.equal(bytes.subarray(0,8).toString(),'DYNAEC01');
  assert.equal(bytes.includes(Buffer.from(secret)),false);assert.equal(bytes.includes(imageBytes),false);
  assert.equal((await lstat(archive.file)).mode&0o777,0o600);
  const keyPath=resolve(directory,'recovery-key');assert.equal((await lstat(keyPath)).mode&0o777,0o600);
  assert.match((await readFile(keyPath,'utf8')).trim(),/^[a-f0-9]{64}$/);assert.equal(providers,0);await sourceUnchanged();
});
test('real encrypted restore rejects ciphertext/tag corruption and a wrong key before any CREATE DATABASE; every source row and role remains unchanged',async()=>{
  const bytes=await readFile(archive.file),databases=async()=>(await source.query('SELECT datname,oid,datdba FROM pg_database ORDER BY datname')).rows;
  const beforeDatabases=await databases(),originalQuery=pg.Client.prototype.query;let creates=0;
  pg.Client.prototype.query=function(this:pg.Client,...args:any[]){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
    if(typeof sql==='string'&&/^\s*CREATE\s+DATABASE\b/i.test(sql))creates++;
    return(originalQuery as any).apply(this,args);
  } as typeof pg.Client.prototype.query;
  try{
    const refusalDirectory=resolve(directory,'restore-refusals'),wrongKey=resolve(directory,'wrong-recovery-key');
    await writeFile(wrongKey,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});
    assert.equal((await lstat(wrongKey)).mode&0o777,0o600);
    for(const mode of ['ciphertext','tag','wrong-key'] as const){
      const damaged=Buffer.from(bytes);if(mode==='ciphertext')damaged[20]^=1;if(mode==='tag')damaged[damaged.length-1]^=1;
      const file=resolve(directory,'refused-'+mode+'.dyna');await writeFile(file,damaged,{flag:'wx',mode:0o600});
      await assert.rejects(recovery.restoreBackup(file,{directory:refusalDirectory,keyFile:mode==='wrong-key'?wrongKey:resolve(directory,'recovery-key')}),
        /Kopia nie przeszła weryfikacji podpisu szyfrowania/);
      assert.equal(creates,0,'Authentication refuses the archive before CREATE, including an attempted-and-cleaned target');
      assert.deepEqual(await databases(),beforeDatabases);assert.deepEqual(await readdir(refusalDirectory),[]);
      await sourceUnchanged();
    }
  }finally{pg.Client.prototype.query=originalQuery;}
  assert.equal(hash(await readFile(archive.file)),archive.sha256,'Original encrypted archive bytes remain unchanged');
});
