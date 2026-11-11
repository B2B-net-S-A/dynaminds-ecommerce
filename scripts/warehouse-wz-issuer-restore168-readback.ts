/** ROOT ONLY. Existing verified151 restore, BEFORE any login. Import-safe.
 * Only local health GET and owner UTC RR READ ONLY. Never migrate, repair,
 * rebase manifests, allocate numbers, authenticate, or replay dispatch.
 * Primary reference: data/warehouse-wz-issuer168-primary-reference.private.json
 * {stage:168,schema,runtime_revision,config_sha256,sql_sha256,
 *  capture:{rows,portable_metadata}}. Root captures this AFTER native WZ.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureStocktakeAdjustmentPreservation } from './stocktake-adjustments-native164-preservation';

type Row = Record<string, any>;
type Preservation = Awaited<ReturnType<typeof captureStocktakeAdjustmentPreservation>>;
export type IssuerRestoreCapture = {rows: Preservation['rows']; portable_metadata: Preservation['metadata']};
const ROOT = '<workspace>/app';
const SCHEMA = '151_warehouse_wz_issuer';
const TABLES = 476;
const REFERENCE = resolve(ROOT, 'data/warehouse-wz-issuer168-primary-reference.private.json');
const OUT = resolve(ROOT, 'data/warehouse-wz-issuer-restore168-readback.private.json');
const PUBLIC = resolve(ROOT, 'docs/warehouse-wz-issuer-restore168-readback.json');
const SHA = /^[a-f0-9]{64}$/, REV = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (b: Buffer|string) => createHash('sha256').update(b).digest('hex');
const one = (rows: Row[]) => {assert.equal(rows.length,1);return rows[0];};
const all = (cap: IssuerRestoreCapture, name: string): Row[] => {assert(Array.isArray(cap.rows[name]));return cap.rows[name].map(x=>x.row);};
const integer = (v: unknown): bigint => {assert(/^(0|[1-9][0-9]*)$/.test(String(v)));return BigInt(String(v));};

async function directory(p: string) {
  const s=await lstat(p);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);
}
async function bytes(p: string,max=512*1024*1024,privateFile=true) {
  assert.equal(await realpath(p),p);const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert(s.size>0&&s.size<=max);
  if(privateFile)assert.equal(s.mode&0o777,0o600);
  const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs'] as const)assert.equal(n[k],s[k]);};
    stable(await f.stat());const b=await f.readFile();stable(await f.stat());stable(await lstat(p));assert.equal(b.length,s.size);return b;
  } finally {await f.close();}
}
async function fileHash(p: string) {
  assert.equal(await realpath(p),p);const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());
  const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs'] as const)assert.equal(n[k],s[k]);};
    stable(await f.stat());const h=createHash('sha256');let size=0;
    for await(const b of createReadStream(p,{fd:f.fd,autoClose:false})){h.update(b);size+=b.length;}
    stable(await f.stat());stable(await lstat(p));assert.equal(size,s.size);
    return {sha256:h.digest('hex'),size,mode:s.mode&0o777};
  } finally {await f.close();}
}
async function absent(p: string) {
  try {await lstat(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  throw Error('Exclusive168 proof already exists');
}
async function wx(p: string,v: unknown,mode=0o600) {
  await directory(dirname(p));const b=JSON.stringify(v,null,2)+'\n';assert(Buffer.byteLength(b)<=512*1024*1024);
  const f=await open(p,'wx',mode);try {await f.writeFile(b);await f.sync();}finally {await f.close();}
  const d=await open(dirname(p),'r');try {await d.sync();}finally {await d.close();}return hash(b);
}

/** Historical graph verification, not current-transaction admission replay.
 * No writes. The immutable commercial allocator is evaluated from actual
 * saved journal/fragment identities; current stock balances are not rebased.
 */
export async function validateRestoredIssuerGraph(c: pg.Client,cap: IssuerRestoreCapture) {
  const admissions=all(cap,'warehouse_wz_issuer_admissions'),receipts=all(cap,'warehouse_wz_issuer_receipts');
  const documents=all(cap,'warehouse_wz_issuer_documents'),savedRows=all(cap,'warehouse_wz_issuer_rows');
  assert(receipts.length>0,'A post-native reference must contain actual WZ');
  assert.equal(admissions.length,receipts.length);assert(documents.length>0);
  const find=(table:string,t:string,id:string)=>one(all(cap,table).filter(x=>x.tenant_id===t&&x.id===id));
  let onRows=0,offRows=0,zeroRows=0,unknownRows=0;
  for(const receipt of receipts) {
    const t=receipt.tenant_id,a=find('warehouse_wz_issuer_admissions',t,receipt.id);
    assert.equal(a.sealed,true);assert(a.after_snapshot&&a.before_snapshot&&a.physical);
    for(const k of ['order_id','shipment_id','source','physical'])assert.deepEqual(receipt[k],a[k]);
    const shipment=find('shipments',t,a.shipment_id);assert.equal(shipment.order_id,a.order_id);assert(shipment.dispatched_at);
    const order=find('orders',t,a.order_id);assert.equal(a.source.order_id,order.id);assert.equal(a.source.shipment_id,shipment.id);
    assert(['demo','shipping_plan','parcel'].includes(a.source.kind));
    if(a.source.kind==='parcel') {
      const dispatch=find('order_parcel_dispatches',t,a.source.dispatch_id);
      for(const k of ['order_id','shipment_id','plan_id'])assert.equal(dispatch[k],a.source[k]);
      assert.equal(dispatch.parcel_index,a.source.parcel_index);
    } else if(a.source.kind==='shipping_plan') {
      const plan=find('shipping_plans',t,a.source.plan_id);assert.equal(plan.order_id,a.order_id);assert.equal(plan.shipment_id,a.shipment_id);
    }
    const sm:Row[]=receipt.physical.stock_movements,bm:Row[]=receipt.physical.location_movements;
    assert(Array.isArray(sm)&&Array.isArray(bm));assert.equal(new Set(sm.map(x=>x.id)).size,sm.length);assert.equal(new Set(bm.map(x=>x.id)).size,bm.length);
    assert.equal(sm.length,a.frame.products.length);
    for(const p of a.frame.products) {
      const proof=one(sm.filter(x=>x.product_id===p.product_id&&x.warehouse_id===p.warehouse_id));assert.equal(proof.quantity,p.quantity);
      const journal=find('stock_movements',t,proof.id);
      assert.deepEqual([journal.product_id,journal.warehouse_id,journal.order_id,journal.kind,journal.delta,journal.warehouse_document_id],
        [p.product_id,p.warehouse_id,a.order_id,'shipment',-p.quantity,null]);
      assert.equal(bm.filter(x=>x.product_id===p.product_id&&x.warehouse_id===p.warehouse_id).reduce((n,x)=>n+integer(x.quantity),0n),integer(p.quantity));
    }
    for(const proof of bm) {
      const journal=find('stock_location_movements',t,proof.id);
      assert.deepEqual([journal.product_id,journal.warehouse_id,journal.order_id,journal.location,journal.kind,journal.delta],
        [proof.product_id,proof.warehouse_id,a.order_id,proof.location,'shipment',-proof.quantity]);
    }
    const effects:Row[]=[];
    const on=a.frame.policy!==null;
    if(on) {
      assert(Array.isArray(receipt.physical.wms));const fragmentIds:string[]=[],layerIds:string[]=[];
      for(const operation of receipt.physical.wms) {
        const op=find('wms_operations',t,operation.operation_id);
        assert.equal(op.order_id,a.order_id);assert.equal(op.kind,'dispatch');
        for(const k of ['warehouse_document_id','purchase_receipt_id','return_id'])assert.equal(op[k],null);
        assert(Array.isArray(operation.fragment_ids)&&Array.isArray(operation.layer_movement_ids));
        fragmentIds.push(...operation.fragment_ids);layerIds.push(...operation.layer_movement_ids);
        for(const id of operation.fragment_ids) {
          const f=find('wms_issue_fragments',t,id);assert.equal(f.order_id,a.order_id);assert.equal(f.operation_id,op.id);
          const layer=find('wms_cost_layers',t,f.layer_id);assert.equal(layer.product_id,f.product_id);
          assert.equal(f.unit_cost_minor,layer.unit_cost_minor);assert.equal(f.currency,layer.currency);
          if(f.unit_cost_minor===null)assert.equal(f.value_minor,null);
          else assert.equal(String(f.value_minor),(integer(f.quantity)*integer(f.unit_cost_minor)).toString());
          const movement=one(all(cap,'wms_layer_movements').filter(x=>x.tenant_id===t&&operation.layer_movement_ids.includes(x.id)
            &&x.operation_id===f.operation_id&&x.product_id===f.product_id&&x.warehouse_id===f.warehouse_id&&x.location===f.location&&x.layer_id===f.layer_id&&x.delta===-f.quantity&&x.kind==='dispatch'));
          const stock=one(sm.filter(x=>x.product_id===f.product_id&&x.warehouse_id===f.warehouse_id));
          const bin=one(bm.filter(x=>x.product_id===f.product_id&&x.warehouse_id===f.warehouse_id&&x.location===f.location));
          effects.push({physical_id:f.id,product_id:f.product_id,warehouse_id:f.warehouse_id,quantity:f.quantity,
            stock_movement_id:stock.id,location_movement_id:bin.id,operation_id:f.operation_id,issue_fragment_id:f.id,
            layer_movement_id:movement.id,layer_id:f.layer_id,lot_id:layer.lot_id,location:f.location,
            unit_cost_minor:f.unit_cost_minor===null?null:String(f.unit_cost_minor),
            value_minor:f.value_minor===null?null:String(f.value_minor),currency:f.currency,exponent:layer.exponent});
        }
      }
      assert.equal(new Set(fragmentIds).size,fragmentIds.length);assert.equal(new Set(layerIds).size,layerIds.length);assert.equal(effects.length,layerIds.length);
    } else {
      assert.equal(receipt.physical.wms,null);
      for(const bin of bm) {
        const stock=one(sm.filter(x=>x.product_id===bin.product_id&&x.warehouse_id===bin.warehouse_id));
        effects.push({physical_id:bin.id,product_id:bin.product_id,warehouse_id:bin.warehouse_id,location:bin.location,quantity:bin.quantity,
          stock_movement_id:stock.id,location_movement_id:bin.id,operation_id:null,issue_fragment_id:null,layer_movement_id:null,layer_id:null,lot_id:null});
      }
    }
    for(const p of a.frame.products)assert.equal(effects.filter(x=>x.product_id===p.product_id&&x.warehouse_id===p.warehouse_id).reduce((n,x)=>n+integer(x.quantity),0n),integer(p.quantity));
    const commercial=(await c.query('SELECT public.warehouse_wz_issuer_commercial($1::jsonb,$2::jsonb) lines',
      [JSON.stringify(a.frame.commercial_lines),JSON.stringify(effects)])).rows[0].lines;
    assert.deepEqual(receipt.commercial_lines,commercial);
    for(const line of commercial) {
      const item=find('order_items',t,line.item_id);assert.equal(item.order_id,a.order_id);assert(integer(line.quantity)>0n&&integer(line.quantity)<=integer(item.quantity));
      for(const k of ['product_id','name','sku','line_total','vat'])assert.deepEqual(line[k],item[k]);
      assert.deepEqual(line.components,item.components.length?item.components:[{product_id:item.product_id,quantity:1}]);
    }
    const docs=documents.filter(x=>x.tenant_id===t&&x.receipt_id===receipt.id);assert.equal(docs.length,a.frame.configurations.length);
    for(const cfg of a.frame.configurations) {
      const d=one(docs.filter(x=>x.warehouse_id===cfg.warehouse.id));const revision=find('warehouse_automatic_wz_revisions',t,d.revision_id);
      assert.equal(revision.warehouse_id,d.warehouse_id);assert.equal(revision.series_id,d.series_id);assert.deepEqual(revision.settings,cfg.configuration.settings);
      assert.equal(revision.id,cfg.configuration.revision_id);assert.equal(d.year,a.frame.year);
      const prior=one(a.frame.counters_before.filter((x:Row)=>x.series_id===d.series_id));assert.equal(integer(d.sequence),integer(prior.sequence)+1n);
      const sequence=String(d.sequence);assert.equal(d.number,cfg.configuration.settings.prefix+'/'+d.year+'/'+sequence.padStart(6,'0'));
      const payload=d.payload;assert.deepEqual(payload.warehouse,cfg.warehouse);assert.deepEqual(payload.source,receipt.source);assert.deepEqual(payload.commercial_lines,commercial);
      for(const k of ['id','receipt_id','number','series_id','year','created_at'])assert.deepEqual(payload[k],d[k]);assert.equal(payload.sequence,sequence);
      assert.equal(d.created_at,receipt.created_at);assert.equal(d.shipment_id,receipt.shipment_id);
      const local=savedRows.filter(x=>x.tenant_id===t&&x.document_id===d.id).sort((x,y)=>x.ordinal-y.ordinal);
      const expected=effects.filter(x=>x.warehouse_id===d.warehouse_id).sort((x,y)=>x.physical_id.localeCompare(y.physical_id));assert.equal(local.length,expected.length);assert.equal(payload.row_count,local.length);
      let quantity=0n,value=0n,unknown=0n;
      for(const [i,row] of local.entries()) {
        assert.equal(row.ordinal,i);assert.equal(row.payload.ordinal,i);
        for(const [k,v] of Object.entries(expected[i]))assert.deepEqual(row.payload[k],v);
        for(const k of ['product_id','stock_movement_id','location_movement_id','operation_id','issue_fragment_id','layer_movement_id','layer_id','lot_id'])assert.deepEqual(row[k],row.payload[k]);
        quantity+=integer(row.payload.quantity);
        if(on) {onRows++;if(row.payload.unit_cost_minor===null){unknownRows++;unknown+=integer(row.payload.quantity);assert.equal(row.payload.value_minor,null);}else{value+=integer(row.payload.value_minor);if(integer(row.payload.unit_cost_minor)===0n)zeroRows++;}}
        else {offRows++;for(const k of ['unit_cost_minor','value_minor','currency','exponent'])assert.equal(Object.hasOwn(row.payload,k),false);}
      }
      assert.equal(integer(payload.summary.physical_quantity),quantity);
      if(on)assert.deepEqual(payload.summary,{physical_quantity:Number(quantity),known_value_minor:value.toString(),unknown_quantity:Number(unknown),currency:a.frame.policy.currency,exponent:a.frame.policy.exponent});
      else assert.deepEqual(payload.summary,{physical_quantity:Number(quantity)});
    }
  }
  assert.equal(savedRows.length,documents.reduce((n,d)=>n+d.payload.row_count,0));
  for(const counter of all(cap,'warehouse_wz_issuer_counters')) {
    const docs=documents.filter(x=>x.tenant_id===counter.tenant_id&&x.series_id===counter.series_id&&x.year===counter.year);
    const seq=docs.map(x=>integer(x.sequence)).sort((a,b)=>a<b?-1:a>b?1:0);
    assert.equal(integer(counter.sequence),BigInt(seq.length));for(const [i,n] of seq.entries())assert.equal(n,BigInt(i+1));
    assert(docs.every(x=>x.warehouse_id===counter.warehouse_id));
  }
  return {receipts:receipts.length,documents:documents.length,rows:savedRows.length,counters:all(cap,'warehouse_wz_issuer_counters').length,on_rows:onRows,off_rows:offRows,known_zero_rows:zeroRows,unknown_cost_rows:unknownRows};
}

async function main() {
  let c:pg.Client|undefined,step='preflight',gets=0;
  const pins=new Map<string,{sha:string;max:number;privateFile:boolean}>(),streams=new Map<string,Awaited<ReturnType<typeof fileHash>>>();
  try {
    assert.equal(process.cwd(),ROOT);assert.equal(process.argv.length,2);for(const p of [ROOT,resolve(ROOT,'data'),resolve(ROOT,'docs')])await directory(p);
    assert.equal(process.env.QA168_RESTORE_CONFIRM,'READ_ONLY_WZ151_COPY_BEFORE_LOGIN');assert.equal(process.env.DYNA_WORKER_DISABLED,'true');
    assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,resolve(ROOT,'.local.json'));for(const k of ['DATABASE_URL','DYNA_TEST'])assert.equal(process.env[k],undefined);
    const revision=process.env.QA_EXPECTED_REVISION??'',archiveRevision=process.env.QA168_ARCHIVE_REVISION??'';assert.match(revision,REV);assert.match(archiveRevision,REV);assert.equal(process.env.APP_REVISION,revision);
    const port=process.env.QA168_RESTORE_PORT??'';assert.match(port,/^41[0-9]{2}$/);assert(Number(port)>=4101&&Number(port)<=4199);assert.equal(process.env.DYNA_PREVIEW_PORT,port);
    for(const p of [OUT,PUBLIC,OUT+'.intent.json'])await absent(p);
    async function pin(p:string,expected:string|undefined,max=512*1024*1024,privateFile=true):Promise<Row> {
      assert.match(expected??'',SHA);const b=await bytes(p,max,privateFile);assert.equal(hash(b),expected);pins.set(p,{sha:expected!,max,privateFile});return JSON.parse(b.toString('utf8')) as Row;
    }
    const config=await pin(resolve(ROOT,'.local.json'),process.env.QA168_CONFIG_SHA256,65536);assert.deepEqual(Object.keys(config).sort(),['dbPassword','encryptionKey']);assert.match(config.encryptionKey,SHA);assert(typeof config.dbPassword==='string'&&config.dbPassword);
    const sqlPath=resolve(ROOT,'server/151_warehouse_wz_issuer.sql');assert.match(process.env.QA168_SQL_SHA256??'',SHA);const sql=await fileHash(sqlPath);assert.equal(sql.sha256,process.env.QA168_SQL_SHA256);streams.set(sqlPath,sql);
    assert.equal(process.env.QA168_PRIMARY_REFERENCE_PATH,REFERENCE);const reference=await pin(REFERENCE,process.env.QA168_PRIMARY_REFERENCE_SHA256);
    assert.equal(reference.stage,168);assert.equal(reference.schema,SCHEMA);assert.equal(reference.runtime_revision,archiveRevision);assert.equal(reference.config_sha256,process.env.QA168_CONFIG_SHA256);assert.equal(reference.sql_sha256,process.env.QA168_SQL_SHA256);
    assert.deepEqual(Object.keys(reference.capture).sort(),['portable_metadata','rows']);assert.equal(Object.keys(reference.capture.rows).length,TABLES);assert(Array.isArray(reference.capture.rows.sessions));
    const resultPath=process.env.QA168_RESTORE_RESULT_PATH??'';
    const match=/^\/Users\/arturtwardowski\/DYNA Ecomerce\/app\/data\/(warehouse-wz-issuer-backup168-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/restore\/([a-f0-9]{16})\/result\.json$/.exec(resultPath);assert(match);
    const base=resolve(ROOT,'data',match[1]);for(const p of [base,resolve(base,'restore'),dirname(resultPath),resolve(base,'backup')])await directory(p);
    const result=await pin(resultPath,process.env.QA168_RESTORE_RESULT_SHA256,65536),database='dynaminds_restore_'+match[2];
    assert.equal(result.id,match[2]);assert.equal(result.database,database);assert.equal(result.directory,dirname(resultPath));assert.equal(result.config,resolve(result.directory,'local-config.json'));assert.equal(result.images,resolve(result.directory,'images'));
    assert.equal(result.source,'dynaminds');assert.equal(result.status,'verified');assert.equal(result.preview_only,true);assert.equal(result.worker_enabled,false);assert.equal(result.row_fingerprints_match,true);assert.equal(result.schema_fingerprint_match,true);assert.equal(result.tables,TABLES);assert.equal(result.revision,archiveRevision);
    const recoveredBytes=await bytes(result.config,65536);pins.set(result.config,{sha:hash(recoveredBytes),max:65536,privateFile:true});const recovered=JSON.parse(recoveredBytes.toString()) as Row;
    assert.deepEqual(Object.keys(recovered).sort(),['dbPassword','encryptionKey']);assert.equal(recovered.encryptionKey,config.encryptionKey);assert(typeof recovered.dbPassword==='string'&&recovered.dbPassword);
    const manifestPath=resolve(result.directory,'manifest.json'),manifestBytes=await bytes(manifestPath,64*1024*1024);pins.set(manifestPath,{sha:hash(manifestBytes),max:64*1024*1024,privateFile:true});const manifest=JSON.parse(manifestBytes.toString()) as Row;
    assert.equal(manifest.format,1);assert.equal(manifest.database,'dynaminds');assert.equal(manifest.revision,archiveRevision);assert.equal(manifest.schema_fingerprint_version,4);assert.equal(Object.keys(manifest.tables).length,TABLES);assert.equal(manifest.config_sha256,hash(JSON.stringify({dbPassword:config.dbPassword,encryptionKey:config.encryptionKey})));
    const archivePath=process.env.QA168_ARCHIVE_PATH??'';assert.equal(dirname(archivePath),resolve(base,'backup'));assert.match(basename(archivePath),/^[a-z0-9]+-[a-f0-9]{16}\.dyna$/);assert.match(process.env.QA168_ARCHIVE_SHA256??'',SHA);
    const archive=await fileHash(archivePath);assert.equal(archive.mode,0o600);assert.equal(archive.sha256,process.env.QA168_ARCHIVE_SHA256);streams.set(archivePath,archive);
    const dumpPath=resolve(result.directory,'database.dump'),dump=await fileHash(dumpPath);assert.equal(dump.sha256,manifest.dump.sha256);assert.equal(dump.size,manifest.dump.size);streams.set(dumpPath,dump);
    async function custody(){for(const[p,v]of pins)assert.equal(hash(await bytes(p,v.max,v.privateFile)),v.sha);for(const[p,v]of streams)assert.deepEqual(await fileHash(p),v);}
    async function health(){gets++;const r=await fetch('http://127.0.0.1:'+port+'/api/health',{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null);const b=Buffer.from(await r.arrayBuffer());assert(b.length<=65536);const h=JSON.parse(b.toString()) as Row;assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.restore_preview,true);assert.equal(h.background_workers_enabled,false);assert.equal(h.warehouse_automatic_wz_configuration_available,true);assert.equal(h.warehouse_automatic_wz_issuer_available,true);}
    await custody();await health();await wx(OUT+'.intent.json',{stage:168,action:'READ_ONLY_WZ151_COPY_BEFORE_LOGIN',runtime_revision:revision,archive_revision:archiveRevision,primary_reference_sha256:process.env.QA168_PRIMARY_REFERENCE_SHA256,restore_result_sha256:process.env.QA168_RESTORE_RESULT_SHA256,archive_sha256:archive.sha256});
    step='copy-read-only';c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:recovered.dbPassword,database,connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});c.on('error',()=>{});await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
    assert.deepEqual((await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],{db:database,role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});
    assert.equal((await c.query('SELECT public.warehouse_automatic_wz_installed() AND public.warehouse_automatic_wz_guards() AND public.warehouse_wz_issuer_installed() AND public.warehouse_wz_issuer_guards() ok')).rows[0].ok,true);
    const preservation=await captureStocktakeAdjustmentPreservation(c);
    const capture:IssuerRestoreCapture={rows:preservation.rows,portable_metadata:preservation.metadata};assert.equal(Object.keys(capture.rows).length,TABLES);
    for(const name of ['150_warehouse_automatic_wz',SCHEMA])assert.equal(one(all(capture,'migrations').filter(x=>x.name===name)).name,name);
    assert.equal(all(capture,'migrations').map(x=>x.name).sort().at(-1),SCHEMA);
    assert.deepEqual(capture,reference.capture,'All rows including all sessions and portable metadata remain literal');
    step='historical-graph';const graph=await validateRestoredIssuerGraph(c,capture);await c.query('COMMIT');await health();await custody();
    step='exclusive-output';const status='WAREHOUSE_WZ_ISSUER_RESTORE168_READBACK_PASS';
    const privateSha=await wx(OUT,{stage:168,status,schema:SCHEMA,database,runtime_revision:revision,archive_revision:archiveRevision,config_sha256:process.env.QA168_CONFIG_SHA256,sql_sha256:sql.sha256,primary_reference_sha256:process.env.QA168_PRIMARY_REFERENCE_SHA256,restore_result_sha256:process.env.QA168_RESTORE_RESULT_SHA256,archive_sha256:archive.sha256,capture,copy_exact_metadata:preservation.exact_metadata,graph,created_at:new Date().toISOString(),gets,mutations:0,login_calls:0});
    const safe={stage:168,status,schema:SCHEMA,runtime_revision:revision,archive_revision:archiveRevision,tables:TABLES,all_rows_and_sessions_exact:true,portable_metadata_exact:true,guards150_and151:true,receipt_documents_rows_counters_sources_exact:true,graph_counts:graph,private_sha256:privateSha,primary_reference_sha256:process.env.QA168_PRIMARY_REFERENCE_SHA256,restore_result_sha256:process.env.QA168_RESTORE_RESULT_SHA256,archive_sha256:archive.sha256,gets,mutations:0,login_calls:0,worker_calls:0,providers_verified:false,chrome_verified:false,restore_executed_here:false,full_historical_files_verified:false,raw_principal_verified:false,full_goal_complete:false};
    await wx(PUBLIC,safe,0o644);console.log(JSON.stringify(safe));
  } catch(e) {
    const at=e instanceof Error?e.stack?.match(/warehouse-wz-issuer-restore168-readback\.ts:(\d+):(\d+)/):null;
    console.error(JSON.stringify({stage:168,status:'RESTORE168_READBACK_FAILED_NO_REPAIR',step,error_type:e instanceof Error?e.name:'Error',source_line:at?Number(at[1]):null,source_column:at?Number(at[2]):null,private_details_withheld:true,automatic_resume:false}));process.exitCode=1;
  } finally {await c?.query('ROLLBACK').catch(()=>undefined);await c?.end().catch(()=>undefined);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
