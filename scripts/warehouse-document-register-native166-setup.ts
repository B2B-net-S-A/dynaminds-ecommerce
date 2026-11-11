/** ROOT ONLY / SOURCE AUTHORED. One fresh QA166 OFF organization; ordinary
 * HTTP writes only. No migration, SQL business writes, provider, worker,149
 * series/preview/post or automatic retry/resume. Owner DB is UTC RR READ ONLY.
 * Import-safe: helpers below do not read files/connect/run on import.
 * QA166_CONFIRM=PREPARE_LOCAL_DOCS_166; APP_REVISION=QA_EXPECTED_REVISION;
 * QA166_BEFORE_PATH/SHA256 pin root's immutable primary adoption-before.
 * Full all464 after-capture is a separate WX0600 checkpoint, not actionjournal.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureStocktakeAdjustmentReadback, type StocktakeAdjustmentCapture } from './stocktake-adjustments-native164-readback';
import { captureStocktakeAdjustmentPreservation } from './stocktake-adjustments-native164-preservation';

type Row=Record<string,any>;
const ROOT='<workspace>/app',BASE='http://127.0.0.1:4100/api',SCHEMA='149_stocktake_adjustments';
const CONFIG=resolve(ROOT,'.local.json'),SQL=resolve(ROOT,'server/149_stocktake_adjustments.sql');
const CONFIG_SHA='9a2c81811d1ffdb6c52aabdd77dddf3ac1975bd8cc2c2d2957882b338dd7b660';
const SQL_SHA='a4ec349804e0bddddbe595669b3a87f432a72cc9f1b19af2eb80aabf6b902264';
const BEFORE=resolve(ROOT,'data/warehouse-document-register-native166-primary-adoption-before.json');
const BEFORE_SHA='5e7828426f7c952753b6d7e693c5047774419278283c0e586d3c9b7ec65b57df';
const JOURNAL=resolve(ROOT,'data/warehouse-document-register-native166-setup.json');
const AFTER=resolve(ROOT,'data/warehouse-document-register-native166-setup-after.json');
const REPORT=resolve(ROOT,'docs/warehouse-document-register-native166-setup.json');
const HEX=/^[a-f0-9]{64}$/,REV=/^[a-f0-9]{40}$/;
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const one=(v:Row[])=>{assert.equal(v.length,1);return v[0];};
const omit=(v:Row,keys:string[])=>Object.fromEntries(Object.entries(v).filter(([k])=>!keys.includes(k)));
const tick=(v:unknown)=>{assert.equal(typeof v,'string');const n=Date.parse(v as string);assert(Number.isFinite(n));return n;};
function uuid(v:unknown):string{assert.equal(typeof v,'string');assert.match(v as string,/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);return v as string;}
function owns(cap:StocktakeAdjustmentCapture,a:Row,name:string){return cap.rows[name].map(x=>x.row).filter(x=>name==='users'?x.id===a.user_id:name==='tenants'?x.id===a.tenant_id:x.tenant_id===a.tenant_id);}

/** Pure fullgraph assertion. Exactly5 actualdocuments/5document movements;
 * createProduct(0) additionally preserves one legitimate initial delta0 row.
 */
export function validateWarehouseDocumentSetup(cap:StocktakeAdjustmentCapture,a:Row){
  uuid(a.tenant_id);uuid(a.user_id);uuid(a.product.id);assert.equal(a.on,false);assert.equal(a.label,'QA166');
  const A=uuid(a.warehouses.A.id),B=uuid(a.warehouses.B.id);assert.notEqual(A,B);
  assert.deepEqual(a.documents.map((d:Row)=>d.label),['PZ','MM','WZ','COUNT','CANCELLED_PZ']);
  assert.equal(new Set(a.documents.map((d:Row)=>d.id)).size,5);
  const docs=owns(cap,a,'warehouse_documents'),lines=owns(cap,a,'warehouse_document_lines'),moves=owns(cap,a,'stock_movements');
  assert.equal(docs.length,5);assert.equal(lines.length,5);assert.equal(moves.length,6);
  const initial=one(moves.filter(m=>m.warehouse_document_id===null));assert.equal(initial.product_id,a.product.id);assert.equal(initial.warehouse_id,A);assert.equal(initial.delta,0);assert.equal(initial.kind,'initial');assert.equal(initial.order_id,null);assert.equal(initial.note,'Stan początkowy');
  const specs=[{label:'PZ',kind:'receipt',quantity:4,basis:0,version:'0',status:'posted',deltas:[[A,4,'receipt']]},
    {label:'MM',kind:'transfer',quantity:1,basis:4,version:'1',status:'posted',deltas:[[A,-1,'transfer_out'],[B,1,'transfer_in']]},
    {label:'WZ',kind:'issue',quantity:1,basis:3,version:'2',status:'posted',deltas:[[A,-1,'issue']]},
    {label:'COUNT',kind:'count',quantity:0,basis:2,version:'3',status:'posted',deltas:[[A,-2,'count']]},
    {label:'CANCELLED_PZ',kind:'receipt',quantity:1,basis:0,version:'4',status:'cancelled',deltas:[]}];
  for(const s of specs){const saved=one(a.documents.filter((x:Row)=>x.label===s.label)),d=one(docs.filter(x=>x.id===saved.id)),l=one(lines.filter(x=>x.document_id===d.id));
    assert.equal(d.tenant_id,a.tenant_id);assert.equal(d.warehouse_id,A);assert.equal(d.destination_id,s.label==='MM'?B:null);assert.equal(d.kind,s.kind);assert.equal(d.status,s.status);assert.equal(d.number,saved.number);assert.equal(d.reference,saved.reference);assert.equal(d.note,saved.note);assert.equal(d.created_by,a.user_id);assert.equal(d.version,2);
    assert.equal(tick(d.created_at),tick(saved.created_at));assert.equal(d.status==='posted',d.posted_at!==null);if(d.posted_at!==null)assert.equal(tick(d.posted_at),tick(saved.posted_at));
    assert.equal(l.product_id,a.product.id);assert.equal(l.sku,a.product.sku);assert.equal(l.name,a.product.name);assert.equal(l.quantity,s.quantity);assert.equal(l.expected_on_hand,s.basis);assert.equal(l.expected_reserved,0);assert.equal(l.location,'A-01');assert.equal(String(l.expected_version),s.version);
    assert.equal(saved.lines.length,1);for(const k of ['product_id','sku','name','quantity','expected_on_hand','expected_reserved','location'])assert.deepEqual(l[k],saved.lines[0][k]);assert.equal(String(l.expected_version),String(saved.lines[0].expected_version));
    const found=moves.filter(m=>m.warehouse_document_id===d.id);assert.equal(found.length,s.deltas.length);
    for(const [wh,delta,kind] of s.deltas){const m=one(found.filter(x=>x.warehouse_id===wh));uuid(m.id);assert.equal(m.tenant_id,a.tenant_id);assert.equal(m.product_id,a.product.id);assert.equal(m.delta,delta);assert.equal(m.kind,kind);assert.equal(m.order_id,null);assert.equal(m.note,d.number);tick(m.created_at);}
  }
  const stock=owns(cap,a,'stock'),bins=owns(cap,a,'stock_locations');assert.equal(stock.length,2);assert.equal(bins.length,2);
  for(const [wh,qty,version] of [[A,0,'4'],[B,1,'1']] as const){const s=one(stock.filter(x=>x.warehouse_id===wh)),b=one(bins.filter(x=>x.warehouse_id===wh));
    assert.equal(s.product_id,a.product.id);assert.equal(s.on_hand,qty);assert.equal(s.reserved,0);assert.equal(s.available,qty);assert.equal(s.location,'A-01');assert.equal(String(s.version),version);assert.equal(b.product_id,a.product.id);assert.equal(b.quantity,qty);assert.equal(b.location,'A-01');
    const epoch=one(owns(cap,a,'stock_file_import_epochs').filter(x=>x.warehouse_id===wh));assert.equal(epoch.product_id,a.product.id);assert.equal(String(epoch.version),'1');
  }
  const binMoves=owns(cap,a,'stock_location_movements');assert.equal(binMoves.length,5);
  const actualBin=binMoves.map(m=>{assert.equal(m.product_id,a.product.id);assert.equal(m.location,'A-01');assert.equal(m.order_id,null);assert.equal(m.operation_id,null);uuid(m.id);tick(m.created_at);return JSON.stringify([m.warehouse_id,m.delta,m.kind]);}).sort();
  assert.deepEqual(actualBin,[[A,4,'stock_in'],[A,-1,'stock_out'],[B,1,'stock_in'],[A,-1,'stock_out'],[A,-2,'stock_out']].map(x=>JSON.stringify(x)).sort());
  // 099 appends for 2 stock births + 5 stock updates; 100 additionally appends
  // for all 6 real aggregate journals, including the legitimate initial zero.
  assert.equal(owns(cap,a,'purchasing_stock_changes').length,13);for(const m of owns(cap,a,'purchasing_stock_changes')){assert(Number.isSafeInteger(Number(m.id))&&Number(m.id)>0);assert.deepEqual(Object.keys(m).sort(),['id','tenant_id']);}
  const catalog=one(owns(cap,a,'product_catalogs'));assert.equal(catalog.id,a.catalog.id);assert.equal(catalog.is_default,true);assert.equal(catalog.active,true);assert.equal(String(catalog.version),'3');assert.equal(catalog.default_language,'pl-pl');
  assert.deepEqual(owns(cap,a,'product_catalog_warehouses').map(x=>{assert.equal(x.catalog_id,catalog.id);return x.warehouse_id;}).sort(),[A,B].sort());
  assert.deepEqual(owns(cap,a,'product_catalog_languages').map(x=>{assert.equal(x.catalog_id,catalog.id);return x.locale;}).sort(),['pl','en','de','cs','fr','it','pl-pl'].sort());
  const p=one(owns(cap,a,'products'));assert.equal(p.id,a.product.id);assert.equal(p.catalog_id,catalog.id);assert.equal(p.sku,a.product.sku);assert.equal(p.name,a.product.name);assert.equal(p.kind,'simple');assert.equal(p.active,true);assert.equal(p.price,1000);assert.equal(p.vat,23);assert.equal(p.parent_id,null);
  const alias=one(owns(cap,a,'product_sku_aliases'));assert.deepEqual(Object.keys(alias).sort(),['created_at','product_id','sku','tenant_id']);assert.equal(alias.tenant_id,a.tenant_id);assert.equal(alias.product_id,p.id);assert.equal(alias.sku,p.sku);assert.equal(tick(alias.created_at),tick(p.created_at));
  assert.deepEqual(owns(cap,a,'memberships'),[{user_id:a.user_id,tenant_id:a.tenant_id,role:'admin'}]);
  const u=one(owns(cap,a,'users'));assert.equal(u.email,a.email);assert.equal(u.name,a.name);assert.equal(u.id,a.user_id);assert.equal(typeof u.password_hash,'string');assert(u.password_hash.includes(':'));
  const t=one(owns(cap,a,'tenants'));assert.equal(t.name,a.organization_name);assert.equal(t.plan,'enterprise');assert.equal(t.currency,'PLN');assert.equal(t.locale,'pl-PL');
  const ws=owns(cap,a,'warehouses');assert.equal(ws.length,2);for(const w of ws){const expected=w.id===A?a.warehouses.A:a.warehouses.B;assert.equal(w.id,expected.id);assert.equal(w.name,expected.name);assert.equal(w.code,expected.code);}
  const sessions=owns(cap,a,'sessions'),session=one(sessions);assert.equal(session.user_id,a.user_id);assert.equal(session.token_hash,sha(a.cookie.slice('dyna_session='.length)));assert.equal(session.account_version,0);assert.equal(session.mfa_verified_at,null);assert(tick(session.expires_at)>tick(session.created_at));
  assert.deepEqual(owns(cap,a,'workspace_usage').map(x=>{assert.equal(x.period,'2000-01-01');return [x.resource,String(x.used)];}).sort(),[['memberships','1'],['products','1'],['warehouses','2']].sort());
  const billing=one(owns(cap,a,'workspace_billing_previews'));assert.equal(billing.id,a.billing_preview.id);assert.equal(billing.actor_id,a.user_id);assert.equal(billing.state,'committed');assert.equal(billing.kind,'activate');assert.equal(billing.before_plan,'starter');assert.equal(billing.terms.plan,'enterprise');assert.equal(billing.result.mode,'local_estimate');assert.equal(billing.result.plan,'enterprise');
  const account=one(owns(cap,a,'workspace_billing_accounts'));assert.equal(account.plan,'enterprise');assert.equal(account.currency,'PLN');assert.equal(String(account.version),'1');
  const entry=one(owns(cap,a,'workspace_billing_entries'));assert.equal(entry.plan,'enterprise');assert.equal(entry.kind,'activate');assert.equal(entry.key,billing.id+':debit');assert.equal(entry.currency,'PLN');assert.equal(entry.amount,a.billing_preview.debit);assert.deepEqual(entry.terms,billing.terms);
  const audit=owns(cap,a,'audit_events');assert.equal(audit.length,14);
  const expectedAudit=[['workspace.created',a.tenant_id],['workspace.billing.activate',a.tenant_id],['warehouse.create',B],['product.create',a.product.id],...a.documents.map((d:Row)=>['warehouse.document.create',d.id]),...a.documents.filter((d:Row)=>d.status==='posted').map((d:Row)=>['warehouse.document.post',d.id]),['warehouse.document.cancel',one(a.documents.filter((d:Row)=>d.status==='cancelled')).id]];
  assert.deepEqual(audit.map(x=>{assert.equal(x.user_id,a.user_id);uuid(x.id);tick(x.created_at);return JSON.stringify([x.action,x.entity_id]);}).sort(),expectedAudit.map(x=>JSON.stringify(x)).sort());
  return {tenant_id:a.tenant_id,user_id:a.user_id,product_id:a.product.id,warehouse_ids:[A,B],document_ids:a.documents.map((d:Row)=>d.id),documents:5,lines:5,document_movements:5,initial_zero_movements:1,aggregate_movements:6,bin_movements:5,stock_A:0,stock_B:1,purchasing_stock_markers:13,sku_aliases:1,stock_birth_epochs:2};
}

/** Every historical row is subtracted literally, including old sessions. New
 * rows must match an enumerated table count and ONE exact new actor tuple.
 */
export function validateWarehouseDocumentSetupPreservation(before:StocktakeAdjustmentCapture,after:StocktakeAdjustmentCapture,a:Row){
  assert.equal(Object.keys(before.rows).length,464);assert.deepEqual(Object.keys(after.rows),Object.keys(before.rows));assert.deepEqual(after.portable_metadata,before.portable_metadata);assert.deepEqual(after.proof_hashes,before.proof_hashes);
  assert(!before.rows.tenants.some(x=>x.row.id===a.tenant_id));assert(!before.rows.users.some(x=>x.row.id===a.user_id));
  const counts:Record<string,number>={tenants:1,users:1,memberships:1,sessions:1,warehouses:2,products:1,product_sku_aliases:1,warehouse_documents:5,warehouse_document_lines:5,stock:2,stock_locations:2,stock_movements:6,stock_location_movements:5,purchasing_stock_changes:13,stock_file_import_epochs:2,product_catalogs:1,product_catalog_warehouses:2,product_catalog_languages:7,workspace_usage:3,workspace_billing_accounts:1,workspace_billing_previews:1,workspace_billing_entries:1,audit_events:14};
  for(const [name,previous]of Object.entries(before.rows)){const remaining=new Map<string,number>();for(const x of after.rows[name]){const key=JSON.stringify(x);remaining.set(key,(remaining.get(key)??0)+1);}
    for(const x of previous){const key=JSON.stringify(x),n=remaining.get(key)??0;assert(n>0,'Original row missing/changed: '+name);remaining.set(key,n-1);}
    let added=0;for(const [key,n]of remaining){if(!n)continue;const r=JSON.parse(key).row;assert(Object.hasOwn(counts,name),'Unplanned new table: '+name);assert.equal(name==='users'?r.id:name==='tenants'?r.id:r.tenant_id,name==='users'?a.user_id:a.tenant_id);for(const k of ['user_id','actor_id','created_by'])if(r[k]!=null)assert.equal(r[k],a.user_id);added+=n;}
    assert.equal(added,counts[name]??0,'Exact new table count: '+name);
  }
  return {all_original_tables:464,all_original_rows_exact:true,all_original_sessions_exact:true,metadata_exact:true,only_literal_new_graph:true,added_rows:counts,graph:validateWarehouseDocumentSetup(after,a)};
}

let state:Row|undefined,journalSha='',step='preflight',client:pg.Client|undefined,gets=0;
async function directory(path:string){const s=await lstat(path);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(path),path);}
async function bytes(path:string,max:number,privateFile=true){const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());if(privateFile)assert.equal(s.mode&0o777,0o600);assert(s.size>0&&s.size<=max);const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs'] as const)assert.equal(n[k],s[k]);};stable(await f.stat());const b=await f.readFile();stable(await f.stat());stable(await lstat(path));assert.equal(b.length,s.size);return b;}finally{await f.close();}}
async function absent(path:string){try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive166 custody exists; no automatic resume');}
async function wx(path:string,value:unknown,mode=0o600,max=32*1024*1024){await directory(dirname(path));const b=JSON.stringify(value,null,2)+'\n';assert(Buffer.byteLength(b)<=max);const f=await open(path,'wx',mode);try{await f.writeFile(b);await f.sync();}finally{await f.close();}const d=await open(dirname(path),'r');try{await d.sync();}finally{await d.close();}return sha(b);}
async function save(){assert(state);assert.equal(sha(await bytes(JOURNAL,32*1024*1024)),journalSha);const tmp=JOURNAL+'.'+randomUUID()+'.tmp';try{const next=await wx(tmp,state);await rename(tmp,JOURNAL);const d=await open(dirname(JOURNAL),'r');try{await d.sync();}finally{await d.close();}journalSha=next;}finally{await unlink(tmp).catch(()=>undefined);}}
const headers=(a?:Row)=>({'Content-Type':'application/json',Origin:'http://127.0.0.1:4100',...(a?.cookie?{cookie:a.cookie,'X-Workspace-ID':uuid(a.tenant_id)}:{})});
async function json(r:Response){const b=Buffer.from(await r.arrayBuffer());assert(b.length<=8*1024*1024);return JSON.parse(b.toString()) as Row;}
function allowedGet(a:Row|undefined,path:string){if(!a)return path==='/health';return ['/auth/me','/warehouses','/workspaces/billing','/product-catalogs/options','/wms-lots','/warehouse-inventory-policies/options'].includes(path)
  ||path==='/warehouse-documents?limit=100'||/^\/warehouse-documents\/[a-f0-9-]{36}$/.test(path)
  ||[a.warehouses?.A?.id,a.warehouses?.B?.id].filter(Boolean).some(wh=>path==='/inventory?warehouse_id='+wh+'&product_id='+a.product?.id||path==='/stock-locations?warehouse_id='+wh+'&product_id='+a.product?.id);}
async function get(a:Row|undefined,path:string){assert(allowedGet(a,path));gets++;const r=await fetch(BASE+path,{method:'GET',headers:headers(a),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);return json(r);}
async function health(revision:string){assert.equal(sha(await bytes(CONFIG,65536)),CONFIG_SHA);assert.equal(sha(await bytes(SQL,4*1024*1024,false)),SQL_SHA);const h=await get(undefined,'/health');assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.restore_preview,false);assert.equal(h.background_workers_enabled,false);assert.equal(h.stocktake_adjustments_available,true);assert.equal(h.warehouse_inventory_policies_available,true);}
async function identity(a:Row){const me=await get(a,'/auth/me');assert.equal(me.user.id,a.user_id);assert.equal(me.user.tenant_id,a.tenant_id);assert.equal(me.user.email,a.email);assert.equal(me.user.role,'admin');}
function allowedWrite(a:Row,path:string){return ['/auth/signup','/workspaces/billing/preview','/warehouses','/products','/warehouse-documents'].includes(path)||path==='/workspaces/billing/previews/'+a.billing_preview?.id+'/commit'||a.documents?.some((d:Row)=>path==='/warehouse-documents/'+d.id+'/post'||path==='/warehouse-documents/'+d.id+'/cancel');}
async function mutate(a:Row,label:string,path:string,body:Row,status:number,assign:(d:Row,r:Response)=>void){
  assert(state);assert.equal(state.pending,null);assert(!state.completed.some((x:Row)=>x.label===label));assert(allowedWrite(a,path));step=label;await health(state.runtime_revision);if(path!=='/auth/signup')await identity(a);
  state.pending={label,route:path,method:'POST',raw_body:JSON.stringify(body),expected_status:status,response:null};state.status='PENDING_WRITE';await save();
  let r:Response,d:Row;try{r=await fetch(BASE+path,{method:'POST',headers:headers(a),body:state.pending.raw_body,redirect:'error',signal:AbortSignal.timeout(90000)});d=await json(r);}catch{state.status='UNKNOWN_RESULT_DO_NOT_RETRY';await save();throw Error('Unconfirmed166 write');}
  state.pending.response={status:r.status,data:d};await save();assert.equal(r.status,status);assign(d,r);await save();state.completed.push({...state.pending,response_sha256:sha(JSON.stringify(d))});state.pending=null;state.status='CONFIRMED';await save();
}
async function inventory(a:Row,wh:string,quantity:number){const d=await get(a,'/inventory?warehouse_id='+wh+'&product_id='+a.product.id);assert.equal(d.meta.cursor,null);const s=one(d.data);assert.equal(s.warehouse_id,wh);assert.equal(s.product_id,a.product.id);assert.equal(s.on_hand,quantity);assert.equal(s.reserved,0);assert.equal(s.available,quantity);assert.equal(s.physical_available,quantity);assert.equal(s.sellable_available,quantity);assert.equal(s.inventory_usage,'sale');assert.equal(s.inventory_enabled,true);assert.equal(s.inventory_policy_version,'0');const b=await get(a,'/stock-locations?warehouse_id='+wh+'&product_id='+a.product.id);assert.equal(b.data.length,1);assert.equal(b.data[0].location,'A-01');assert.equal(b.data[0].quantity,quantity);return s;}
async function setup(a:Row){
  await mutate(a,'signup','/auth/signup',{email:a.email,name:a.name,password:a.password,organization:{name:a.organization_name,currency:'PLN',locale:'pl-PL'}},201,(d,r)=>{a.user_id=uuid(d.user.id);a.tenant_id=uuid(d.user.tenant_id);assert.equal(d.user.role,'admin');assert.equal(d.user.email,a.email);a.cookie=(r.headers.get('set-cookie')??'').split(';')[0];assert.match(a.cookie,/^dyna_session=[a-f0-9]{64}$/);});
  const ws=await get(a,'/warehouses');assert.equal(ws.data.length,1);a.warehouses.A=ws.data[0];uuid(a.warehouses.A.id);assert.equal(a.warehouses.A.code,'MAIN');assert.equal(a.warehouses.A.tenant_id,a.tenant_id);await save();
  const billing=await get(a,'/workspaces/billing');assert.equal(billing.mode,'local_estimate');assert.equal(billing.current_plan,'starter');
  await mutate(a,'enterprise-preview','/workspaces/billing/preview',{kind:'activate',plan:'enterprise'},200,d=>{assert.equal(d.mode,'local_estimate');assert.equal(d.can_commit,true);assert.deepEqual(d.blockers,[]);uuid(d.id);a.billing_preview=d;});
  await mutate(a,'enterprise-commit','/workspaces/billing/previews/'+a.billing_preview.id+'/commit',{},200,d=>{assert.equal(d.mode,'local_estimate');assert.equal(d.plan,'enterprise');a.billing_commit=d;});
  await mutate(a,'warehouse-B','/warehouses',{name:'QA166 Destination '+state!.suffix,code:'QA166B'},200,d=>{a.warehouses.B=d;uuid(d.id);assert.equal(d.tenant_id,a.tenant_id);assert.equal(d.code,'QA166B');});
  const policies=await get(a,'/warehouse-inventory-policies/options');assert.equal(policies.available,true);assert.equal(policies.warehouses.length,2);for(const w of policies.warehouses){assert([a.warehouses.A.id,a.warehouses.B.id].includes(w.id));assert.deepEqual(w.policy,{usage:'sale',enabled:true,version:'0'});}
  const options=await get(a,'/product-catalogs/options');assert.equal(options.available,true);assert.equal(options.can_manage,true);assert.equal(options.catalogs.length,1);a.catalog=one(options.catalogs);assert.equal(a.catalog.is_default,true);assert.equal(a.catalog.active,true);assert.deepEqual([...a.catalog.settings.warehouse_ids].sort(),[a.warehouses.A.id,a.warehouses.B.id].sort());await save();
  await mutate(a,'product-zero','/products',{catalog_id:a.catalog.id,sku:'QA166-'+state!.suffix,name:'QA166 Recorded physical product '+state!.suffix,kind:'simple',price:1000,vat:23,warehouse_id:a.warehouses.A.id,quantity:0,location:'A-01'},201,d=>{uuid(d.id);assert.equal(d.tenant_id,a.tenant_id);assert.equal(d.catalog_id,a.catalog.id);assert.equal(d.kind,'simple');a.product=d;});
  assert.equal((await get(a,'/wms-lots')).policy.enabled,false);await inventory(a,a.warehouses.A.id,0);
  const specs=[{label:'PZ',kind:'receipt',quantity:4,A:4,B:null,action:'post'}, {label:'MM',kind:'transfer',quantity:1,A:3,B:1,action:'post'}, {label:'WZ',kind:'issue',quantity:1,A:2,B:1,action:'post'}, {label:'COUNT',kind:'count',quantity:0,A:0,B:1,action:'post'}, {label:'CANCELLED_PZ',kind:'receipt',quantity:1,A:0,B:1,action:'cancel'}];
  for(const s of specs){let expected_version:string|undefined;if(s.kind==='count')expected_version=String((await inventory(a,a.warehouses.A.id,2)).version);
    await mutate(a,'create-'+s.label,'/warehouse-documents',{kind:s.kind,warehouse_id:a.warehouses.A.id,destination_id:s.kind==='transfer'?a.warehouses.B.id:null,reference:'QA166 '+s.label+' '+state!.suffix,note:'QA166 real ordinary '+s.label+'; no automatic provider or WMS calls',lines:[{product_id:a.product.id,quantity:s.quantity,location:'A-01',...(expected_version===undefined?{}:{expected_version})}]},201,d=>{uuid(d.id);assert.equal(d.tenant_id,a.tenant_id);assert.equal(d.kind,s.kind);assert.equal(d.status,'draft');assert.equal(d.version,1);assert.equal(d.lines.length,1);assert.equal(d.lines[0].quantity,s.quantity);a.documents.push({...d,label:s.label});});
    const d=one(a.documents.filter((x:Row)=>x.label===s.label));await mutate(a,s.action+'-'+s.label,'/warehouse-documents/'+d.id+'/'+s.action,{version:d.version},200,current=>{assert.equal(current.id,d.id);assert.equal(current.tenant_id,a.tenant_id);assert.equal(current.number,d.number);assert.equal(current.kind,s.kind);assert.equal(current.status,s.action==='post'?'posted':'cancelled');assert.equal(current.version,2);assert.equal(current.lines.length,1);assert.equal(current.lines[0].quantity,s.quantity);Object.assign(d,current);});
    await inventory(a,a.warehouses.A.id,s.A);if(s.B!==null)await inventory(a,a.warehouses.B.id,s.B);
  }
  a.final_inventory={A:await inventory(a,a.warehouses.A.id,0),B:await inventory(a,a.warehouses.B.id,1)};
  const list=await get(a,'/warehouse-documents?limit=100');assert.equal(list.meta.cursor,null);assert.equal(list.data.length,5);assert.deepEqual(list.data.map((d:Row)=>d.id).sort(),a.documents.map((d:Row)=>d.id).sort());
  for(const d of a.documents){const current=await get(a,'/warehouse-documents/'+d.id);assert.equal(current.id,d.id);assert.equal(current.status,d.status);assert.equal(current.version,d.version);assert.equal(current.lines.length,1);assert.deepEqual(omit(current,['lines']),omit(d,['lines','label']));}
  assert.equal((await get(a,'/wms-lots')).policy.enabled,false);a.status='OWN_FIVE_LEGACY_DOCUMENTS_READY';await save();
}
async function capture(){assert(client);await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL TimeZone='UTC'");try{assert.deepEqual((await client.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],{db:'dynaminds',role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});const cap=await captureStocktakeAdjustmentReadback(client),meta=await captureStocktakeAdjustmentPreservation(client);assert.deepEqual(cap.rows,meta.rows);assert.deepEqual(cap.portable_metadata,meta.metadata);await client.query('COMMIT');return {capture:cap,exact_metadata:meta.exact_metadata};}catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e;}}
async function main(){
  const revision=process.env.QA_EXPECTED_REVISION??'';assert.match(revision,REV);assert.equal(process.env.APP_REVISION,revision);assert.equal(process.env.QA166_CONFIRM,'PREPARE_LOCAL_DOCS_166');assert.equal(process.env.DYNA_WORKER_DISABLED,'true');assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,CONFIG);assert.equal(await realpath(process.cwd()),ROOT);assert.equal(process.cwd(),ROOT);
  for(const k of ['DYNA_TEST','DATABASE_URL','DYNA_PREVIEW_PORT'])assert.equal(process.env[k],undefined);assert.equal(process.env.QA166_BEFORE_PATH,BEFORE);assert.equal(process.env.QA166_BEFORE_SHA256,BEFORE_SHA);
  await directory(ROOT);await directory(resolve(ROOT,'data'));await directory(resolve(ROOT,'docs'));for(const p of [JOURNAL,JOURNAL+'.intent.json',AFTER,REPORT])await absent(p);
  const configBytes=await bytes(CONFIG,65536),beforeBytes=await bytes(BEFORE,512*1024*1024);assert.equal(sha(configBytes),CONFIG_SHA);assert.equal(sha(beforeBytes),BEFORE_SHA);const cfg=JSON.parse(configBytes.toString()) as Row,before=JSON.parse(beforeBytes.toString()) as Row;
  assert.equal(before.stage,166);assert.equal(before.scope,'primary');assert.equal(before.phase,'before');assert.equal(before.status,'ALL464_ADOPTION_EXACT_PASS');assert.equal(before.schema,SCHEMA);assert.match(before.runtime_revision,REV);assert.match(before.old165_sha256,HEX);assert.equal(before.mutations,0);assert.equal(before.login_calls,0);assert.equal(typeof cfg.dbPassword,'string');assert(cfg.dbPassword.length>0);
  await health(revision);client=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:'dynaminds',connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});client.on('error',()=>{});await client.connect();step='immutable-before';const first=await capture();assert.deepEqual(first.capture,before.capture,'Before first writer all464 inclsessions exact');assert.deepEqual(first.exact_metadata,before.exact_metadata);assert.equal(sha(await bytes(BEFORE,512*1024*1024)),BEFORE_SHA);
  const suffix=randomUUID().replaceAll('-','').slice(0,12);state={stage:166,status:'INITIALIZED',schema_revision:SCHEMA,runtime_revision:revision,config_sha256:CONFIG_SHA,sql_sha256:SQL_SHA,before_path:BEFORE,before_sha256:BEFORE_SHA,old165_sha256:before.old165_sha256,suffix,created_at:new Date().toISOString(),pending:null,completed:[],actor:{label:'QA166',on:false,name:'QA166 Warehouse Reader '+suffix,organization_name:'QA166 Register '+suffix,email:'qa166-'+suffix+'@example.test',password:'QA166-'+randomBytes(24).toString('base64url')+'!aA9',warehouses:{},documents:[]}};
  await wx(JOURNAL+'.intent.json',{stage:166,action:'EXPLICIT_ONE_NEW_OWN_OFF_SETUP_NO_RESUME',runtime_revision:revision,schema_revision:SCHEMA,config_sha256:CONFIG_SHA,sql_sha256:SQL_SHA,before_path:BEFORE,before_sha256:BEFORE_SHA,planned_http_writes:15});journalSha=await wx(JOURNAL,state);
  await setup(state.actor);assert.equal(state.completed.length,15);step='full-after-setup';await health(revision);const after=await capture();assert.deepEqual(after.exact_metadata,before.exact_metadata);const preservation=validateWarehouseDocumentSetupPreservation(before.capture,after.capture,state.actor);assert.equal(sha(await bytes(BEFORE,512*1024*1024)),BEFORE_SHA);
  const afterSha=await wx(AFTER,{stage:166,phase:'after-setup',status:'OWN_LEGACY_GRAPH_AND_OLD_ROWS_VERIFIED',schema:SCHEMA,runtime_revision:revision,config_sha256:CONFIG_SHA,sql_sha256:SQL_SHA,before_sha256:BEFORE_SHA,setup_journal_sha256:journalSha,actor:state.actor,capture:after.capture,exact_metadata:after.exact_metadata,preservation,created_at:new Date().toISOString()},0o600,512*1024*1024);
  state.after_capture={path:AFTER,sha256:afterSha};state.preservation=preservation;state.status='OWN_LEGACY_DOCUMENTS_READY';state.finished_at=new Date().toISOString();await save();await health(revision);
  const report={stage:166,status:state.status,schema:SCHEMA,runtime_revision:revision,config_sha256:CONFIG_SHA,sql_sha256:SQL_SHA,before_sha256:BEFORE_SHA,private_sha256:journalSha,after_capture_sha256:afterSha,confirmed_http_setup_writes:15,gets,mutations:15,old_tables:464,old_rows_exact:true,old_sessions_exact:true,metadata_exact:true,graph:preservation.graph,billing_mode:'local_estimate',login_calls:0,wms_enabled:false,worker_calls:0,provider_calls:0,register_gets:0,chrome_verified:false,backup_restore_verified:false,full_goal_complete:false};await wx(REPORT,report,0o644);console.log(JSON.stringify(report));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(async(error:unknown)=>{if(state){state.status=state.pending?'FAILED_OR_UNKNOWN_DO_NOT_RETRY':'FAILED_DO_NOT_RERUN';state.failed_at=new Date().toISOString();state.failed_step=step;await save().catch(()=>undefined);}const line=error instanceof Error?error.stack?.match(/warehouse-document-register-native166-setup\.ts:(\d+):(\d+)/):undefined;console.error(JSON.stringify({stage:166,status:'FAILED_NO_AUTOMATIC_RESUME',step,source_line:line?Number(line[1]):null,private_details_withheld:true,custody_written:!!state,automatic_resume:false}));process.exitCode=1;}).finally(async()=>{await client?.end().catch(()=>undefined);});
