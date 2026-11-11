/** Actual strategy function and React selector, controlled ports only; no SQL/HTTP execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {transformSync} from 'esbuild';
import {createServer} from 'vite';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor={tenantId:id(1),userId:id(2)},order=id(3);
const source=fs.readFileSync(new URL('../server/return-credit206-service.ts',import.meta.url),'utf8');
const actual=source.slice(source.indexOf('export async function returnCredit206Strategy('));
const code=transformSync(actual,{loader:'ts',format:'cjs',target:'es2022'}).code;
function harness({history={destination:false,catalog_receipt_missing:false},available=true,own=true,authenticated=true,queryError=null,oldDestination=false}={}){
 const calls=[],frames=new WeakMap();if(authenticated)frames.set(actor,'own-session-hash');
 const ensure=(ok,status,message)=>{if(!ok)throw Object.assign(new Error(message),{status});};
 const c={async query(sql,args){calls.push({sql,args});assert.match(sql,/^\s*SELECT\b/);if(sql.includes('set_config'))return{rows:[{}]};if(sql.includes('local_consumer_credit_terminal'))return{rows:[{}]};if(sql.includes("to_regprocedure('public.return_credit211_metadata_valid()')"))return{rows:[{partial:false,metadata_fn:null,acceptance_fn:null,history_fn:null,source_fn:null,parent_fn:null,metadata_table:null,parent_table:null}]};if(sql==='SELECT id FROM orders WHERE id=$1'){assert.deepEqual(args,[order]);return{rowCount:own?1:0,rows:own?[{id:order}]:[]};}
  assert.deepEqual(args,[actor.tenantId,order]);if(queryError)throw queryError;
  // Include the old selector's result column: genuine nonstrict148 was missed
  // by that implementation, and mixed strict+nonstrict used to appear ready.
  return{rows:[{value:oldDestination,...history}]};}};
 // esbuild's CJS export initialization uses module, so supply an isolated module
 // through a wrapper rather than importing the service's DB/config graph.
 const module={exports:{}};
 const build=new Function('module','exports','creditUuid','frames','ensure','returnCredit206Available','tenantTx','owner',code+';return module.exports.returnCredit206Strategy;');
 const run=build(module,module.exports,{parse(v){assert.equal(v,order);return v;}},frames,ensure,async()=>available,async(t,work)=>{assert.equal(t,actor.tenantId);return work(c);},async(client,a,work)=>{assert.equal(client,c);assert.equal(a,actor);return work();});
 return{calls,run:()=>run(actor,order)};
}
test('actual strategy refuses completed148 without its sealed169 and retains other branches',async t=>{
 for(const[name,history,available,expected,oldDestination=false]of [
  ['nonstrict receive',{destination:true,catalog_receipt_missing:true},true,{strategy:'destinations',available:false,unavailable_reason:'catalog_receipt_required'}],
  ['mixed strict and missing receive',{destination:true,catalog_receipt_missing:true},true,{strategy:'destinations',available:false,unavailable_reason:'catalog_receipt_required'},true],
  ['all strict receives bound to their own receipt',{destination:true,catalog_receipt_missing:false},true,{strategy:'destinations',available:true}],
  ['completed reject needs no numbered receipt',{destination:true,catalog_receipt_missing:false},true,{strategy:'destinations',available:true}],
  ['true legacy has no completed destinations history',{destination:false,catalog_receipt_missing:false},true,{strategy:'legacy',available:true}],
  ['successor unavailable never falls back to legacy',{destination:true,catalog_receipt_missing:false},false,{strategy:'destinations',available:false}],
 ])await t.test(name,async()=>{const h=harness({history,available,oldDestination});assert.deepEqual(await h.run(),{order_id:order,...expected});assert.equal(h.calls.filter(x=>x.sql.includes('local_consumer_credit_terminal')).length,2);});
 await t.test('SQL correlates each missing receive to its exact tenant/order/return/assistant receipt',async()=>{
  const h=harness({history:{destination:true,catalog_receipt_missing:true}});await h.run();const sql=h.calls.find(x=>x.sql.includes('catalog_receipt_missing')).sql.replace(/\s+/g,' ');
  assert.match(sql,/FROM return_destination_admissions da WHERE\(da.tenant_id,da.order_id\)=\(\$1,\$2\) AND da.after_snapshot IS NOT NULL AND da.payload->>'action'='receive'/);
  assert.match(sql,/AND NOT EXISTS\(SELECT FROM catalog_stock_return_receipts r JOIN catalog_stock_return_admissions ca ON\(ca.tenant_id,ca.id\)=\(r.tenant_id,r.id\)/);
  assert.match(sql,/WHERE\(r.tenant_id,r.order_id,r.return_id,r.assistant_receipt_id\)= \(da.tenant_id,da.order_id,da.return_id,da.receipt_id\) AND ca.protocol='destinations_v1' AND ca.sealed/);
  const migration148=fs.readFileSync(new URL('../server/148_return_destinations.sql',import.meta.url),'utf8'),fragment169=fs.readFileSync(new URL('../server/catalog-stock-return-schema-fragment169.sql',import.meta.url),'utf8');
  assert(migration148.includes('PRIMARY KEY(tenant_id,receipt_id)'));assert(migration148.includes('UNIQUE(tenant_id,return_id)'));assert(fragment169.includes('FOREIGN KEY(tenant_id,assistant_receipt_id) REFERENCES public.return_assistant_receipts(tenant_id,id)'));
 });
 await t.test('no identity, absent own order, malformed history and query failure stay closed',async()=>{
  const unauth=harness({authenticated:false});await assert.rejects(unauth.run(),e=>e.status===401);assert.equal(unauth.calls.length,0);
  await assert.rejects(harness({own:false}).run(),e=>e.status===404);await assert.rejects(harness({history:{destination:true}}).run(),e=>e.status===503);
  const failure=new Error('controlled read failed');await assert.rejects(harness({queryError:failure}).run(),e=>e===failure);
 });
});
test('actual React selector explains missing catalog receipt without mounting a financial panel',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client'),{ConsumerCreditStrategyPanel}=await vite.ssrLoadModule(path.resolve('web/consumer-return-credits.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const handles=[],tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),'expected controlled selector state');}
 async function mount(value){const calls=[];let legacyMounts=0;globalThis.fetch=async(url,init={})=>{const route=new URL(String(url),'http://127.0.0.1').pathname;calls.push({route,method:init.method??'GET'});assert.equal(init.method??'GET','GET');if(route==='/api/auth/me')return Response.json({user:{id:actor.userId,tenant_id:actor.tenantId,role:'admin'},restore_preview:false});assert.equal(route,'/api/consumer-return-credits/orders/'+order+'/strategy','blocked selector must not request either financial source');return Response.json({order_id:order,read_only:false,...value});};api.setWorkspace(actor.tenantId);const el=document.createElement('div');document.body.append(el);const root=createRoot(el);handles.push({root,el});const Legacy=()=>{legacyMounts++;return React.createElement('p',null,'LEGACY MOUNTED');};await React.act(async()=>root.render(React.createElement(ConsumerCreditStrategyPanel,{orderId:order,returnId:id(4),contextKey:actor.tenantId+':'+actor.userId+':admin',readOnly:false,legacy:Legacy})));return{el,calls,legacy:()=>legacyMounts};}
 try{
  await t.test('known missing receipt shows future-only guidance and creates no write control',async()=>{const h=await mount({strategy:'destinations',available:false,unavailable_reason:'catalog_receipt_required'});await until(()=>h.el.textContent.includes('nie uzupełni to obecnego zwrotu'));assert(h.el.textContent.includes('bilansem otwarcia przed przyjęciem'));assert(h.el.querySelector('[role="alert"]'));assert.equal(h.legacy(),0);assert.equal(h.el.querySelectorAll('button,input,form').length,0);assert(h.calls.every(c=>c.method==='GET'));});
  for(const value of [{strategy:'destinations',available:false,unavailable_reason:'unknown'},{strategy:'legacy',available:false,unavailable_reason:'catalog_receipt_required'},{strategy:'destinations',available:true,unavailable_reason:'catalog_receipt_required'}])await t.test('unknown or inconsistent unavailability never dispatches a fallback',async()=>{const h=await mount(value);await until(()=>h.el.textContent.includes('Korekta jest obecnie niedostępna'));assert.equal(h.legacy(),0);assert.equal(h.el.querySelectorAll('button,input,form').length,0);assert(!h.el.textContent.includes('bilansem otwarcia'));});
  await t.test('genuine legacy selection remains available',async()=>{const h=await mount({strategy:'legacy',available:true});await until(()=>h.el.textContent.includes('LEGACY MOUNTED'));assert(h.legacy()>0);});
 }finally{for(const{root,el}of handles){await React.act(async()=>root.unmount());el.remove();}globalThis.fetch=oldFetch;await vite.close();dom.window.close();for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
});
