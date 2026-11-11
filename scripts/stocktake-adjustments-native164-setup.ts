/** ROOT ONLY. One-shot, exclusively new QA164 OFF/ON firms. HTTP business API;
 * no SQL, provider, worker, migration or stocktake posting. Stops at real review;
 * series, PW/RW preview, separate consent and post belong to native Chrome.
 * Primary cwd. Requires workers OFF, pinned runtime/config and explicit setup
 * confirmation. Exclusive0600 intent and custody journal; every write is fsynced
 * before HTTP. Failed/unknown calls stop without automatic resume or replay.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type Row = Record<string, any>;
const ROOT = '<workspace>/app';
const BASE = 'http://127.0.0.1:4100/api';
const CONFIG = resolve(ROOT, '.local.json');
const JOURNAL = resolve(ROOT, 'data/stocktake-adjustments-native164-setup.json');
const REPORT = resolve(ROOT, 'docs/stocktake-adjustments-native164-setup.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
let state: Row | undefined, journalSha = '', step = 'preflight';
function uuid(v: unknown): string { assert.equal(typeof v, 'string'); assert.match(v as string, /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); return v as string; }
async function directory(path: string) { const s = await lstat(path); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(path), path); }
async function privateRead(path: string, max = 32 * 1024 * 1024) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600); assert(s.size > 0 && s.size <= max);
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stable = (n: typeof s) => { for (const k of ['dev','ino','mode','size','mtimeMs'] as const) assert.equal(n[k], s[k]); };
    stable(await f.stat()); const bytes = await f.readFile(); stable(await f.stat()); stable(await lstat(path)); return bytes;
  } finally { await f.close(); }
}
async function absent(path: string) { try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; } throw Error('Exclusive QA164 custody already exists; no automatic resume'); }
async function wx(path: string, value: unknown, mode = 0o600) {
  await directory(dirname(path)); const bytes = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(bytes) <= 32 * 1024 * 1024);
  const f = await open(path, 'wx', mode); try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); } return sha(bytes);
}
async function save() {
  assert(state); assert.equal(sha(await privateRead(JOURNAL)), journalSha); const temp = JOURNAL + '.' + randomUUID() + '.tmp';
  try { const next = await wx(temp, state); await rename(temp, JOURNAL); const d = await open(dirname(JOURNAL), 'r'); try { await d.sync(); } finally { await d.close(); } journalSha = next; }
  finally { await unlink(temp).catch(() => undefined); }
}
function headers(a?: Row) { return { 'Content-Type':'application/json', Origin:'http://127.0.0.1:4100', ...(a?.cookie ? { cookie:a.cookie, 'X-Workspace-ID':uuid(a.tenant_id) } : {}) }; }
async function json(r: Response): Promise<Row> { const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length <= 8 * 1024 * 1024); return JSON.parse(bytes.toString('utf8')); }
function allowedGet(a: Row|undefined, route: string) {
  if (!a) return route === '/health';
  return ['/auth/me','/warehouses','/workspaces/billing','/product-catalogs/options','/wms-lots','/wms-lots/opening-scope','/stocktake-adjustments/options'].includes(route)
    || /^\/stock-locations\?warehouse_id=[a-f0-9-]{36}&product_id=[a-f0-9-]{36}$/.test(route)
    || route === '/stocktake-adjustments/sources/'+(a.on?'wms':'quantity')+'/'+a.stocktake?.id
    || route === a.path + '/' + a.stocktake?.id || (a.on && route === a.path + '/' + a.stocktake?.id + '/lines');
}
async function get(a: Row|undefined, route: string) { assert(allowedGet(a,route)); const r = await fetch(BASE+route,{headers:headers(a),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)}); assert.equal(r.status,200); return json(r); }
async function health() {
  assert.equal(sha(await privateRead(CONFIG,65536)),process.env.QA164_CONFIG_SHA256);
  const h = await get(undefined,'/health'); assert.equal(h.status,'ok'); assert.equal(h.mode,'local'); assert.equal(h.revision,revision);
  assert.equal(h.schema_revision,'149_stocktake_adjustments'); assert.equal(h.restore_preview,false); assert.equal(h.background_workers_enabled,false);
  assert.equal(h.stocktake_adjustments_available,true); assert.equal(h.warehouse_inventory_policies_available,true);
}
async function identity(a: Row) { const me = await get(a,'/auth/me'); assert.equal(me.user.id,a.user_id); assert.equal(me.user.tenant_id,a.tenant_id); assert.equal(me.user.email,a.email); assert.equal(me.user.role,'admin'); }
function allowedWrite(a: Row, route: string) {
  return ['/auth/signup','/workspaces/billing/preview','/product-catalogs/previews','/products','/stock-location-moves'].includes(route)
    || route === '/workspaces/billing/previews/'+a.billing_preview?.id+'/commit'
    || route === '/product-catalogs/previews/'+a.catalog_preview?.id+'/commit'
    || route === a.path || route === a.path+'/'+a.stocktake?.id+'/counts'
    || route === a.path+'/'+a.stocktake?.id+(a.on?'/reviews':'/review')
    || (a.on && (route === '/wms-lots/opening-previews' || route === '/wms-lots/opening-previews/'+a.opening?.id+'/activate'));
}
async function mutate(a: Row,label: string,route: string,body: Row,expected: number,assign: (d: Row,r: Response)=>void=()=>undefined) {
  step = a.label+':'+label; assert(state && state.pending === null); assert(!state.completed.some((x: Row)=>x.actor===a.label && x.label===label));
  assert(allowedWrite(a,route)); await health(); if(route !== '/auth/signup') await identity(a);
  state.pending = {actor:a.label,label,method:'POST',route,raw_body:JSON.stringify(body),expected_status:expected,response:null}; state.status='PENDING_WRITE'; await save();
  let r: Response,d: Row; try { r=await fetch(BASE+route,{method:'POST',headers:headers(a),body:state.pending.raw_body,redirect:'error',signal:AbortSignal.timeout(90000)}); d=await json(r); }
  catch { state.status='UNKNOWN_RESULT_DO_NOT_RETRY'; await save(); throw Error('Unconfirmed QA164 write'); }
  state.pending.response={status:r.status,data:d}; await save(); assert.equal(r.status,expected); assign(d,r); await save();
  state.completed.push({...state.pending,response_sha256:sha(JSON.stringify(d))}); state.pending=null; state.status='CONFIRMED'; await save();
}
async function setup(a: Row) {
  await mutate(a,'signup','/auth/signup',{name:'QA164 '+a.label+' Operator',email:a.email,password:a.password,organization:{name:'QA164 Stocktake '+a.label+' '+state!.suffix,currency:'PLN',locale:'pl-PL'}},201,(d,r)=>{
    a.user_id=uuid(d.user.id); a.tenant_id=uuid(d.user.tenant_id); assert.equal(d.user.role,'admin'); a.cookie=(r.headers.get('set-cookie')??'').split(';')[0]; assert.match(a.cookie,/^dyna_session=[A-Za-z0-9_.-]+$/);
  });
  const warehouses=await get(a,'/warehouses'); assert.equal(warehouses.data.length,1); a.warehouse=warehouses.data[0]; uuid(a.warehouse.id); await save();
  const billing=await get(a,'/workspaces/billing'); assert.equal(billing.mode,'local_estimate'); assert.equal(billing.current_plan,'starter');
  await mutate(a,'enterprise-preview','/workspaces/billing/preview',{kind:'activate',plan:'enterprise'},200,d=>{assert.equal(d.mode,'local_estimate'); assert.equal(d.can_commit,true); assert.deepEqual(d.blockers,[]); a.billing_preview=d; uuid(d.id);});
  await mutate(a,'enterprise-commit','/workspaces/billing/previews/'+a.billing_preview.id+'/commit',{},200,d=>{assert.equal(d.mode,'local_estimate'); assert.equal(d.plan,'enterprise');});
  const options=await get(a,'/product-catalogs/options'); assert.equal(options.available,true); assert.equal(options.can_manage,true);
  const settings={name:'QA164 '+a.label+' Physical Pool',active:true,languages:['pl'],default_language:'pl',warehouse_ids:[a.warehouse.id],price_list_ids:[]};
  await mutate(a,'catalog-preview','/product-catalogs/previews',{client_key:randomUUID(),kind:'create',settings},201,d=>{assert.equal(d.preview.ready,true); assert.deepEqual(d.preview.after,settings); a.catalog_preview=d.preview;});
  await mutate(a,'catalog-commit','/product-catalogs/previews/'+a.catalog_preview.id+'/commit',{client_key:randomUUID(),scope_hash:a.catalog_preview.scope_hash,confirmed:true},201,d=>{assert.deepEqual(d.catalog.settings,settings); a.catalog=d.catalog; uuid(a.catalog.id);});
  for(const [i,cost] of ['0','1000',null].entries()) {
    await mutate(a,'product-'+i,'/products',{catalog_id:a.catalog.id,sku:'QA164-'+i+'-'+state!.suffix,name:'QA164 Counted '+i,kind:'simple',price:1501,vat:23,warehouse_id:a.warehouse.id,quantity:4,location:'A-01'},201,d=>{assert.equal(d.catalog_id,a.catalog.id); a.products.push({id:uuid(d.id),sku:d.sku,cost});});
    const p=a.products[i],bins=(await get(a,'/stock-locations?warehouse_id='+a.warehouse.id+'&product_id='+p.id)).data; assert.equal(bins.length,1); assert.equal(bins[0].quantity,4);
    await mutate(a,'two-bin-'+i,'/stock-location-moves',{warehouse_id:a.warehouse.id,product_id:p.id,location:'A-01',destination:'B-02',quantity:2,expected_version:String(bins[0].version),client_key:randomUUID(),note:'QA164 genuine two-bin stock'},200);
  }
  if(a.on) {
    const scope=await get(a,'/wms-lots/opening-scope'); assert.equal(scope.meta.cursor,null); assert.deepEqual(scope.active_blockers,[]); assert.equal(scope.data.length,6);
    const lines=scope.data.map((bin: Row)=>{const p=a.products.find((x: Row)=>x.id===bin.product_id); assert(p); assert.equal(bin.warehouse_id,a.warehouse.id); assert(['A-01','B-02'].includes(bin.location)); assert.equal(bin.quantity,2);
      return {warehouse_id:bin.warehouse_id,product_id:bin.product_id,location:bin.location,quantity:2,stock_version:String(bin.stock_version),lot_code:'QA164-'+p.id+'-'+bin.location,unit_cost_minor:p.cost};});
    await mutate(a,'opening-preview','/wms-lots/opening-previews',{client_key:randomUUID(),policy_version:'0',currency:'PLN',note:'Own genuine0/1000/NULL cost opening',lines},201,d=>{assert.equal(d.preview.ready,true);a.opening=d.preview;});
    await mutate(a,'opening-activate','/wms-lots/opening-previews/'+a.opening.id+'/activate',{client_key:randomUUID(),scope_hash:a.opening.scope_hash,confirmed:true,ack_unknown_costs:true},201);
  }
  assert.equal((await get(a,'/wms-lots')).policy.enabled,a.on);
  await mutate(a,'create-stocktake',a.path,{client_key:randomUUID(),warehouse_id:a.warehouse.id,name:'QA164 '+a.label+' Actual physical count',blind:true,...(a.on?{policy_version:'1'}:{})},a.on?201:200,d=>{a.stocktake=a.on?d.stocktake:d;uuid(a.stocktake.id);assert.equal(a.stocktake.state,'counting');});
  const detail=await get(a,a.path+'/'+a.stocktake.id+(a.on?'/lines':'')),lines:Row[]=a.on?detail.data:detail.lines; assert.equal(lines.length,6); if(a.on)assert.equal(detail.meta.cursor,null);
  const measured=lines.map(l=>{assert.equal(l.current_quantity,2);return {id:uuid(l.id),version:String(l.version),...(a.on?{basis_token:l.basis_token}:{expected_stock_version:String(l.current_stock_version)}),quantity:l.location==='A-01'?1:3};});
  a.count_basis=lines; a.measured=measured; await save();
  await mutate(a,'count-stocktake',a.path+'/'+a.stocktake.id+'/counts',{client_key:randomUUID(),note:'QA164 actual A1/B3 measured, no raw quantity writes',lines:measured},a.on?201:200);
  const current=await get(a,a.path+'/'+a.stocktake.id);
  if(a.on) {
    const surplus=lines.filter(l=>l.location==='B-02').map(l=>({line_id:l.id,unit_cost_minor:a.products.find((p:Row)=>p.id===l.product_id).cost??'1000',currency:'PLN'}));
    await mutate(a,'review-stocktake',a.path+'/'+a.stocktake.id+'/reviews',{client_key:randomUUID(),version:String(current.stocktake.version),note:'QA164 declared surplus costs; unknown shortage retained',surplus},201,d=>{a.review=d.review;});
  } else await mutate(a,'review-stocktake',a.path+'/'+a.stocktake.id+'/review',{version:String(current.version)},200,d=>{a.review=d;});
  const ready=await get(a,'/stocktake-adjustments/options'); assert.equal(ready.available,true); assert.equal(ready.can_write,true); assert.deepEqual(ready.series,[]);
  const source=await get(a,'/stocktake-adjustments/sources/'+(a.on?'wms':'quantity')+'/'+a.stocktake.id);
  assert.equal(source.available,true); assert.equal(source.source.state,'review'); assert.equal(source.source.can_preview,true);
  assert.equal(source.source.stocktake_id,a.stocktake.id); assert.equal(source.source.warehouse.id,a.warehouse.id); assert.equal(source.source.line_count,6); assert.equal(source.source.row_count,6);
  assert.equal(source.source.summary.pw_quantity,'3'); assert.equal(source.source.summary.rw_quantity,'3');
  assert.equal(source.source.version,String(a.on?a.review.stocktake_version:a.review.version)); a.adjustment_source=source.source;
  a.status='READY_FOR_NATIVE_SERIES_PREVIEW_AND_CONSENT'; await save();
}
try {
  assert.equal(await realpath(process.cwd()),ROOT); assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,CONFIG); assert.equal(process.env.DYNA_WORKER_DISABLED,'true');
  assert.equal(process.env.QA164_SETUP_CONFIRM,'CREATE_TWO_NEW_OWN_QA164_OFF_ON_COUNT_SOURCES'); assert.match(revision,/^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION,revision); assert.match(process.env.QA164_CONFIG_SHA256??'',/^[a-f0-9]{64}$/);
  await directory(ROOT); await directory(resolve(ROOT,'data')); await directory(resolve(ROOT,'docs')); for(const p of [JOURNAL,JOURNAL+'.intent.json',REPORT])await absent(p); await health();
  const suffix=randomUUID().slice(0,8); state={stage:164,status:'INITIALIZED',runtime_revision:revision,schema:'149_stocktake_adjustments',suffix,created_at:new Date().toISOString(),pending:null,completed:[],actors:['OFF','ON'].map(label=>({label,on:label==='ON',path:label==='ON'?'/wms-lots/stocktakes':'/stocktakes',email:'qa164-'+label.toLowerCase()+'-'+suffix+'@example.test',password:'QA164-'+randomBytes(24).toString('base64url')+'!aA9',products:[]}))};
  await wx(JOURNAL+'.intent.json',{stage:164,runtime_revision:revision,config_sha256:process.env.QA164_CONFIG_SHA256,suffix,actors:state.actors.map((a:Row)=>({label:a.label,email:a.email}))}); journalSha=await wx(JOURNAL,state);
  for(const a of state.actors)await setup(a); await health(); state.status='READY_FOR_NATIVE_CHROME_NOT_POSTED'; state.finished_at=new Date().toISOString(); await save();
  const report={stage:164,status:state.status,runtime_revision:revision,schema:state.schema,confirmed_http_setup_writes:state.completed.length,series_created:0,adjustment_previews_created:0,stocktakes_posted:0,provider_business_calls:0,actors:state.actors.map((a:Row)=>({mode:a.label,tenant_id:a.tenant_id,stocktake_id:a.stocktake.id,product_count:a.products.length,bin_count:a.count_basis.length,pw_quantity:3,rw_quantity:3,net_stock_quantity:0})),custody_sha256:journalSha,scope:'Actual local setup only. Chrome PW/RW actions, receipt graph, restart and backup/restore remain unverified.'};
  await wx(REPORT,report,0o644); console.log(JSON.stringify(report));
} catch(error) { if(state){state.status=state.pending?'FAILED_OR_UNKNOWN_DO_NOT_RETRY':'FAILED_DO_NOT_RERUN';state.failed_at=new Date().toISOString();state.failed_step=step;await save().catch(()=>undefined);} console.error(JSON.stringify({stage:164,status:'FAIL',step,error_kind:error instanceof Error?error.name:'Error',custody_written:!!state,automatic_resume:false}));process.exitCode=1; }
