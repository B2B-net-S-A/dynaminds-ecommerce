import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomInt,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chmod,lstat,mkdir,mkdtemp,open,readFile,realpath,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import pg from 'pg';
import {buildApp} from '../server/app';
import {pool} from '../server/db';
import {tableFingerprints,schemaFingerprint} from '../server/recovery';
import {captureStocktakeAdjustmentPreservation} from '../scripts/stocktake-adjustments-native164-preservation';
import {seed} from './fixtures';
import {sourceCatalogStockControl,previewCatalogStockControl,commitCatalogStockControl} from '../server/catalog-stock-control';
import {assertNumericDatabase169,bootstrap151169,install152169,fixture169,facts169,consent169,own169,physicalExact169,
  type Fixture169,type Row} from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Root invokes only in a fresh own numeric55432 DB.
// Public BO remains writers_available:false. Real fixture APIs/private consent,
// one exported-snapshot custom dump, one new sibling restore. No provisioning,
// provider calls, manifest rebasing, synthetic journal parents, or copy login.
type Capture=Awaited<ReturnType<typeof captureStocktakeAdjustmentPreservation>>;
let app:Awaited<ReturnType<typeof buildApp>>,source:pg.Client,copy:pg.Client,admin:pg.Client;
let sourceCapture:Capture,copyCapture:Capture,directory='',copyName='',created=false,providers=0;
let password='',sourceName='',dumpTool='',restoreTool='';
const graphs:{f:Fixture169;order:Row;rma:Row;request:Row;documentId:string;receiptId:string}[]=[];
const one=(rows:Row[])=>{assert.equal(rows.length,1);return rows[0];};
const identifier=(name:string)=>{assert.match(name,/^dynaminds_test_\d+$/);return '"'+name+'"';};
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function tool(kind:'DUMP'|'RESTORE'){
  const path=process.env['DYNA_ACL169_PG_'+kind+'_PATH']??resolve(homedir(),'.local/share/dynaminds/pg-tools/18/bin',kind==='DUMP'?'pg_dump':'pg_restore');
  const expected=process.env['DYNA_ACL169_PG_'+kind+'_SHA256'];assert.match(expected??'',/^[a-f0-9]{64}$/);
  assert.equal(await realpath(path),path);const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.nlink,1);
  assert.equal(hash(await readFile(path)),expected,'Existing host-native tool pin');return path;
}
async function child(path:string,args:string[]){await new Promise<void>((resolveDone,reject)=>{
  const p=spawn(path,args,{stdio:['ignore','ignore','pipe'],env:{PATH:'/usr/bin:/bin',LC_ALL:'C',PGOPTIONS:'-c timezone=UTC',PGCONNECT_TIMEOUT:'5',PGPASSWORD:password}});
  p.stderr.resume();p.once('error',()=>reject(Error('ACL169 host-native child failed')));
  p.once('close',code=>code===0?resolveDone():reject(Error('ACL169 host-native child exit '+code)));});}
async function rr<T>(c:pg.Client,work:()=>Promise<T>){await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TIME ZONE 'UTC'");
  try{const value=await work();await c.query('COMMIT');return value;}catch(error){await c.query('ROLLBACK');throw error;}}
async function sequences(c:pg.Client){const out:Record<string,Row>={};
  for(const{relname}of(await c.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S' ORDER BY relname")).rows){
    assert.match(relname,/^[a-z][a-z0-9_]*$/);out[relname]=(await c.query(`SELECT last_value::text,is_called FROM public."${relname}"`)).rows[0];}return out;}
async function guards(c:pg.Client){return(await c.query(`SELECT public.catalog_stock_control_installed() installed,
  public.catalog_stock_control_guards() core,public.catalog_stock_count_guards() count,public.catalog_stock_return_guards() returns,
  public.stocktake_adjustment_guards() adjustments,public.warehouse_automatic_wz_guards() configuration,public.warehouse_wz_issuer_guards() issuer`)).rows[0] as Record<string,boolean>;}
async function fingerprints(c:pg.Client){return(await c.query(`SELECT
  (SELECT fingerprint FROM public.catalog_stock_control_manifest WHERE id) core_stored,public.catalog_stock_control_fingerprint() core_actual,
  (SELECT fingerprint FROM public.catalog_stock_count_manifest WHERE id) count_stored,public.catalog_stock_count_fingerprint() count_actual,
  (SELECT fingerprint FROM public.catalog_stock_return_manifest WHERE id) return_stored,public.catalog_stock_return_fingerprint() return_actual`)).rows[0] as Record<string,string>;}
async function healthy(c:pg.Client){const g=await guards(c);for(const v of Object.values(g))assert.equal(v,true);
  const f=await fingerprints(c);for(const name of ['core','count','return'])assert.equal(f[name+'_actual'],f[name+'_stored']);return{guards:g,fingerprints:f};}
async function rawAcl(c:pg.Client){return(await c.query(`SELECT relname,relacl::text raw,pg_get_userbyid(relowner) owner,
  (SELECT jsonb_agg(jsonb_build_array(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
    pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable)
   FROM aclexplode(coalesce(relacl,acldefault('r',relowner))) a) effective
  FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND
   (relname LIKE 'catalog_stock_control_%' OR relname LIKE 'catalog_stock_count_%' OR relname LIKE 'catalog_stock_return_%') ORDER BY relname`)).rows as Row[];}

async function activate(f:Fixture169){const publicSource=await f.ok('/catalog-stock-control/catalogs/'+f.primary.id+'/source');
  assert.equal(publicSource.writers_available,false);assert.equal(publicSource.activation_available,false);
  const beforeRows=await facts169(),ctx={writersAvailable:true};const{source:s}=await sourceCatalogStockControl(f.actor,f.primary.id,ctx);
  assert.equal(s.ready,true,JSON.stringify(s.blockers));const{preview}=await previewCatalogStockControl(f.actor,f.primary.id,{
    client_key:randomUUID(),catalog_version:s.snapshot.catalog.version,policy_version:s.snapshot.policy.version,
    warehouse_policy_versions:s.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:s.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.series.version})),},ctx);
  assert.equal(preview.ready,true);assert.equal((await commitCatalogStockControl(f.actor,preview.id,consent169(preview),ctx)).operation.after.strict,true);
  physicalExact169(beforeRows,await facts169());}

async function returnedFixture(on:boolean){const f=await fixture169(app,on);
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
  const beforeRows=await facts169();let request:Row;
  if(on){const fragments=own169(beforeRows,'wms_issue_fragments',f.tenant).filter(x=>x.order_id===order.id);assert.equal(fragments.length,3);
    assert(fragments.every(x=>x.quantity===3));const policy=one(own169(beforeRows,'wms_policies',f.tenant));
    request={version:Number(rma.version),note:'Explicit own restore legacy WMS receipt',shipping_refund:0,
      items:rma.items.map((i:Row)=>({item_id:i.item_id,accepted:i.requested,restocked:i.requested})),wms_lots:{client_key:randomUUID(),policy_version:String(policy.version),
        stock_versions:f.products.map(p=>({product_id:p.id,warehouse_id:f.warehouse.id,version:String(one(own169(beforeRows,'stock',f.tenant)
          .filter(s=>s.product_id===p.id&&s.warehouse_id===f.warehouse.id)).version)})),picks:fragments.map(x=>({issue_fragment_id:x.id,quantity:3,location:'A-01'}))}};
    const receipt=await f.ok('/returns/'+rma.id+'/receive','POST',request);assert.equal(receipt.refund_amount,4401);
    const accepted=await facts169();await f.ok('/returns/'+rma.id+'/receive','POST',request);assert.deepEqual(await facts169(),accepted,'ON exact body replay has no second graph');
  }else{request={status:'return_received'};await f.ok('/orders/'+order.id+'/status','PATCH',request);
    const accepted=await facts169();await f.ok('/orders/'+order.id+'/status','PATCH',request,409);
    assert.deepEqual(await facts169(),accepted,'OFF repeated terminal status is refused without a second graph');}
  const accepted=await facts169(),doc=one(own169(accepted,'catalog_stock_return_documents',f.tenant)),receipt=one(own169(accepted,'catalog_stock_return_receipts',f.tenant));
  const admission=one(own169(accepted,'catalog_stock_return_admissions',f.tenant));
  assert.equal(admission.sealed,true);assert.equal(admission.id,receipt.id);assert.equal(admission.actor_id,f.user);
  assert.equal(admission.protocol,on?'rma':'legacy_status');assert.equal(admission.return_id,rma.id);assert.equal(admission.order_id,order.id);
  assert.equal(doc.return_id,rma.id);assert.equal(doc.receipt_id,receipt.id);assert.equal(doc.payload.kind,'PZ');assert.equal(doc.payload.quantity,on?'9':'3');
  assert.equal(doc.payload.row_count,on?3:1);assert.equal(doc.payload.wms_enabled,on);
  const rows=own169(accepted,'catalog_stock_return_rows',f.tenant);assert.equal(rows.length,on?3:1);
  assert(rows.every(r=>r.document_id===doc.id&&r.warehouse_id===f.warehouse.id&&r.quantity===3));
  for(const table of ['order_items','payment_entries','wms_issue_fragments','wms_cost_layers'])
    assert.deepEqual(accepted[table],beforeRows[table],'Return preserves original commercial/issue/cost truth: '+table);
  const maps=own169(accepted,'catalog_stock_return_item_maps',f.tenant);assert.equal(maps.length,on?6:2);
  for(const item of rma.items){const selected=maps.filter(m=>m.item_id===item.item_id);assert.equal(selected.length,on?3:1);
    assert(selected.every(m=>m.quantity===item.requested));}
  const layers=own169(accepted,'catalog_stock_return_layer_maps',f.tenant);assert.equal(layers.length,on?3:0);
  if(on){assert.deepEqual(layers.map(x=>x.payload.unit_cost_minor).sort(),['0','1000',null].sort());
    assert.deepEqual(layers.map(x=>x.payload.value_minor).sort(),['0','3000',null].sort());}
  graphs.push({f,order,rma,request,documentId:doc.id,receiptId:receipt.id});}

before(async()=>{assertNumericDatabase169();const u=new URL(process.env.DATABASE_URL!);assert.equal(u.port,'55432');assert.equal(u.username,'postgres');
  sourceName=u.pathname.slice(1);password=decodeURIComponent(u.password);assert(password);
  dumpTool=await tool('DUMP');restoreTool=await tool('RESTORE');await bootstrap151169();await seed();await install152169();
  app=await buildApp({backgroundWorkersEnabled:false,integrationTransport:async()=>{providers++;throw Error('No providers in own ACL restore regression');}});
  await returnedFixture(false);await returnedFixture(true);
  const base=resolve('data/test-catalog-stock-control-acl169');await mkdir(base,{recursive:true,mode:0o700});assert.equal(await realpath(base),base);
  const baseStat=await lstat(base);assert(baseStat.isDirectory()&&!baseStat.isSymbolicLink());assert.equal(baseStat.mode&0o777,0o700);
  directory=await mkdtemp(resolve(base,'case-'));await chmod(directory,0o700);
  const connection=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password,database,connectionTimeoutMillis:5000});
  source=connection(sourceName);admin=connection('postgres');await source.connect();await admin.connect();
  assert.deepEqual((await source.query('SELECT current_database() db,current_user role,session_user owner,inet_server_port() port')).rows[0],
    {db:sourceName,role:'postgres',owner:'postgres',port:55432});
  assert.equal((await admin.query("SELECT rolsuper OR rolbypassrls OR rolcanlogin unsafe FROM pg_roles WHERE rolname='dyna_app'")).rows[0].unsafe,false);
  copyName='dynaminds_test_'+String(Date.now()+randomInt(1,100000));assert.notEqual(copyName,sourceName);
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[copyName])).rowCount,0);
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await source.query("SET LOCAL TIME ZONE 'UTC'");
  try{sourceCapture=await captureStocktakeAdjustmentPreservation(source);assert.equal(Object.keys(sourceCapture.rows).length,507);await healthy(source);
    const token=(await source.query('SELECT pg_export_snapshot() token')).rows[0].token;assert.match(token,/^[a-fA-F0-9]+-[a-fA-F0-9]+-\d+$/);
    const dump=resolve(directory,'database.dump');await child(dumpTool,['--host=127.0.0.1','--port=55432','--username=postgres','--no-password',
      '--dbname='+sourceName,'--format=custom','--snapshot='+token,'--file='+dump]);await chmod(dump,0o600);
    const fd=await open(dump,'r');try{const header=Buffer.alloc(5);await fd.read(header,0,5,0);assert.equal(header.toString(),'PGDMP');}finally{await fd.close();}
    await admin.query('CREATE DATABASE '+identifier(copyName)+' OWNER postgres');created=true;
    await child(restoreTool,['--host=127.0.0.1','--port=55432','--username=postgres','--no-password','--dbname='+copyName,
      '--single-transaction','--exit-on-error','--no-owner',dump]);
    await source.query('COMMIT');
  }catch(error){await source.query('ROLLBACK');throw error;}
  copy=connection(copyName);await copy.connect();copyCapture=await rr(copy,()=>captureStocktakeAdjustmentPreservation(copy));
});
after(async()=>{try{assert.equal(providers,0);await app?.close();await copy?.end();await source?.end();
    if(created){assert.match(copyName,/^dynaminds_test_\d+$/);assert.notEqual(copyName,sourceName);await admin.query('DROP DATABASE '+identifier(copyName));}
    await admin?.end();if(directory)await rm(directory,{recursive:true,force:true});}finally{await pool.end();}});

test('real507 dump/restore keeps nonempty BO and duplicate-item OFF/ON PZ graphs while raw31 owner-default ACLs become NULL and effective manifests remain sealed',async()=>{
  assert.equal(graphs.length,2);assert.deepEqual(copyCapture.rows,sourceCapture.rows);assert.deepEqual(copyCapture.metadata,sourceCapture.metadata);
  const a=await rr(source,async()=>({health:await healthy(source),acl:await rawAcl(source),sequences:await sequences(source),tables:await tableFingerprints(source),schema:await schemaFingerprint(source,4)}));
  const b=await rr(copy,async()=>({health:await healthy(copy),acl:await rawAcl(copy),sequences:await sequences(copy),tables:await tableFingerprints(copy),schema:await schemaFingerprint(copy,4)}));
  assert.deepEqual(b.health,a.health);assert.deepEqual(b.sequences,a.sequences);assert.deepEqual(b.tables,a.tables);assert.equal(b.schema,a.schema);
  assert.equal(a.acl.length,31);assert.equal(b.acl.length,31);
  assert(a.acl.every(r=>r.raw!==null),'Observe actual explicit source owner defaults');assert(b.acl.every(r=>r.raw===null),'Observe real pg_restore default NULL conversion');
  assert.deepEqual(b.acl.map(({raw,...r})=>r),a.acl.map(({raw,...r})=>r));
  for(const g of graphs){const docs=copyCapture.rows.catalog_stock_return_documents.map(x=>x.row).filter(d=>d.id===g.documentId);
    assert.equal(docs.length,1);assert.equal(docs[0].receipt_id,g.receiptId);assert.equal(docs[0].return_id,g.rma.id);
    assert(copyCapture.rows.catalog_stock_control_documents.some(x=>x.row.tenant_id===g.f.tenant&&x.row.payload.kind==='BO'));
    for(const table of ['order_items','payment_entries','wms_issue_fragments','wms_cost_layers','catalog_stock_return_item_maps','catalog_stock_return_layer_maps'])
      assert.deepEqual(copyCapture.rows[table],sourceCapture.rows[table],table);}
  assert.deepEqual(await rr(source,()=>captureStocktakeAdjustmentPreservation(source)),sourceCapture,'Source all507 sessions/rows/metadata unchanged after copy');
});

async function tamper(sql:string,family:'core'|'count'|'returns',effectiveCheck?:string){const prior=await rr(copy,()=>captureStocktakeAdjustmentPreservation(copy));
  await copy.query('BEGIN');try{await copy.query(sql);if(effectiveCheck)assert.equal((await copy.query(effectiveCheck)).rows[0].allowed,true);
    const g=await guards(copy);assert.equal(g[family],false);assert.equal(g.core,false);
    for(const table of ['catalog_stock_control_manifest','catalog_stock_count_manifest','catalog_stock_return_manifest']){
      const persisted=(await copy.query('SELECT to_jsonb(r) row FROM public.'+table+' r ORDER BY 1')).rows;
      assert.deepEqual(persisted,copyCapture.rows[table],'Stored manifest never rebased');}
  }finally{await copy.query('ROLLBACK');}
  assert.deepEqual(await rr(copy,()=>captureStocktakeAdjustmentPreservation(copy)),prior,'Transactional tamper rollback preserves all507 rows and exact copied metadata');
  await rr(copy,()=>healthy(copy));assert.deepEqual(await rr(source,()=>captureStocktakeAdjustmentPreservation(source)),sourceCapture);
}
test('copied core rejects actual PUBLIC table SELECT grant and exact rollback restores sealed state',async()=>tamper(
  'GRANT SELECT ON public.catalog_stock_control_documents TO PUBLIC','core',
  "SELECT has_table_privilege('dyna_app','public.catalog_stock_control_documents','SELECT') allowed"));
test('copied return family rejects actual dyna_app table SELECT grant',async()=>tamper(
  'GRANT SELECT ON public.catalog_stock_return_rows TO dyna_app','returns',
  "SELECT has_table_privilege('dyna_app','public.catalog_stock_return_rows','SELECT') allowed"));
test('copied count family rejects actual PUBLIC column SELECT without needing table ACL mutation',async()=>tamper(
  'GRANT SELECT(delta) ON public.catalog_stock_count_rows TO PUBLIC','count',
  "SELECT has_column_privilege('dyna_app','public.catalog_stock_count_rows','delta','SELECT') allowed"));
test('copied return family rejects real application EXECUTE on its owner-only function',async()=>tamper(
  'GRANT EXECUTE ON FUNCTION public.catalog_stock_return_guards() TO dyna_app','returns',
  "SELECT has_function_privilege('dyna_app','public.catalog_stock_return_guards()','EXECUTE') allowed"));
test('copied core rejects actual hash function body substitution without any manifest overwrite',async()=>tamper(
  "CREATE OR REPLACE FUNCTION public.catalog_stock_control_hash(j jsonb) RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT repeat('f',64) $$",'core'));
test('copied count family rejects disabled FORCERLS and returns healthy only after rollback',async()=>tamper(
  'ALTER TABLE public.catalog_stock_count_rows NO FORCE ROW LEVEL SECURITY','count'));
