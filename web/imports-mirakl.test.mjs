import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,tenant=id(1),user=id(2),channel=id(3),warehouse=id(4),inbound=id(5);
const props=(patch={})=>({channelId:channel,contextKey:tenant+':'+user+':admin',readOnly:false,onImported:()=>assert.fail('staging must not import an order'),...patch});
const stage=()=>({channel_id:channel,scope:'external_read_local_stage',stages_orders:true,imports_orders:false,offset:2,total_count:4,has_more:true,data:[{id:inbound,state:'staged',source_hash:'a'.repeat(64)}]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('Mirakl ordinary import queue uses trusted explicit staging, then existing review only',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const{createRoot}=await import('react-dom/client'),{ImportQueue}=await vite.ssrLoadModule(path.resolve('web/imports.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const handles=[];let f;
 function queue(){return{channel:{id:channel,provider:f.provider,mode:'live',simulation:false},mappings:[],data:f.rows};}
 function reset(){localStorage.clear();api.setWorkspace(tenant);f={calls:[],provider:'mirakl',rows:[],available:true,demoteAt:0,me:0,mePatch:{},failed:false,held:null,value:stage()};globalThis.fetch=async(url,init={})=>{
  const p=new URL(String(url),'http://127.0.0.1');assert.equal(p.origin,'http://127.0.0.1');f.calls.push({path:p.pathname+p.search,method:init.method,body:init.body});
  if(p.pathname==='/api/health'){assert.equal(init.method,'GET');return Response.json({mirakl_reads_available:f.available});}
  assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);
  if(p.pathname==='/api/auth/me'){assert.equal(init.method,'GET');f.me++;return Response.json({restore_preview:false,user:{id:user,tenant_id:tenant,role:f.demoteAt&&f.me>=f.demoteAt?'viewer':'admin'},...f.mePatch});}
  if(p.pathname==='/api/integrations/'+channel+'/imports'){assert.equal(init.method,'GET');return Response.json(queue());}
  if(p.pathname==='/api/warehouses'){assert.equal(init.method,'GET');return Response.json({data:[{id:warehouse,name:'Własny magazyn'}]});}
  assert.equal(p.pathname,'/api/integrations/'+channel+'/mirakl/orders-stage','no generic fetch, raw staging, commit or fulfillment');assert.equal(init.method,'POST');
  if(f.held)return f.held.promise;if(f.failed)throw Error('unknown response');return Response.json(f.value);
 };}
 const tick=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<60;i++){if(fn())return;await tick();}assert(fn(),'controlled queue did not settle');}
 async function mount(p=props()){const el=document.createElement('div');document.body.append(el);const root=createRoot(el),h={el,async render(next){await act(async()=>root.render(React.createElement(ImportQueue,next)));},async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);await h.render(p);await until(()=>h.el.textContent.includes('Pobierz Mirakl do kolejki'));return h;}
 const button=(h,label)=>[...h.el.querySelectorAll('button')].find(b=>b.textContent===label);
 async function click(h,label){const b=button(h,label);assert(b&&!b.matches(':disabled'),label);await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 async function input(h,label,value){const el=h.el.querySelector(`[aria-label="${label}"]`);assert(el);await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});}
 async function windowFields(h){await input(h,'Mirakl zamówienia od','2026-10-01T00:00:00Z');await input(h,'Mirakl zamówienia do','2026-10-02T00:00:00Z');await input(h,'Mirakl limit','1');await input(h,'Mirakl pozycja','2');}
 const posts=()=>f.calls.filter(c=>c.method==='POST');
 try{
  await t.test('mount only reads local metadata and deliberate click posts the exact trusted window, no auto pagination or order commit',async()=>{
   reset();const h=await mount();assert.deepEqual(f.calls.map(c=>c.path).sort(),['/api/integrations/'+channel+'/imports?page=1','/api/warehouses'].sort());assert.equal(posts().length,0);assert(!button(h,'Pobierz zamówienia'));
   await windowFields(h);await click(h,'Pobierz Mirakl do kolejki');await until(()=>h.el.textContent.includes('Zapisano do przeglądu 1'));
   assert.equal(posts().length,1);assert.deepEqual(JSON.parse(posts()[0].body),{start_update_date:'2026-10-01T00:00:00Z',end_update_date:'2026-10-02T00:00:00Z',max:1,offset:2});assert.equal(f.me,2);assert(h.el.textContent.includes('podaj kolejną pozycję'));for(let i=0;i<4;i++)await tick();assert.equal(posts().length,1);assert.equal(h.el.querySelector('[aria-label="Mirakl pozycja"]').value,'2');await h.close();
  });
  await t.test('invalid window, read-only, non-admin, wrong principal or unavailable old server never send staging',async()=>{
   reset();const invalid=await mount();await click(invalid,'Pobierz Mirakl do kolejki');await until(()=>!!invalid.el.querySelector('[role=alert]'));assert.equal(posts().length,0);assert.equal(f.me,0);await invalid.close();
   for(const patch of [{readOnly:true},{contextKey:tenant+':'+user+':viewer'}]){reset();const h=await mount(props(patch));assert(button(h,'Pobierz Mirakl do kolejki').matches(':disabled'));assert.equal(posts().length,0);await h.close();}
   for(const patch of [{available:false},{demoteAt:1},{mePatch:{restore_preview:true}},{mePatch:{read_only:true}},{mePatch:{user:{id:id(9),tenant_id:tenant,role:'admin'}}}]){reset();Object.assign(f,patch);const h=await mount();await windowFields(h);await click(h,'Pobierz Mirakl do kolejki');await until(()=>!!h.el.querySelector('[role=alert]'));assert.equal(posts().length,0);await h.close();}
  });
  await t.test('unknown acknowledgement, malformed DTO or post-response role loss never replay; explicit GET review is required before another click',async()=>{
   for(const patch of [{failed:true},{value:{...stage(),channel_id:id(9)}},{value:{...stage(),data:[{id:inbound,state:'ready',source_hash:'a'.repeat(64)}]}},{demoteAt:2}]){
    reset();Object.assign(f,patch);const h=await mount();await windowFields(h);await click(h,'Pobierz Mirakl do kolejki');await until(()=>h.el.textContent.includes('nie jest potwierdzony'));assert.equal(posts().length,1);assert(button(h,'Pobierz Mirakl do kolejki').disabled);assert(!h.el.textContent.includes('Zapisano do przeglądu'));await input(h,'Mirakl limit','2');assert(h.el.textContent.includes('pozostaje niepewny'));assert(button(h,'Pobierz Mirakl do kolejki').disabled);for(let i=0;i<4;i++)await tick();assert.equal(posts().length,1);
    await click(h,'Odśwież kolejkę Mirakl');await until(()=>h.el.textContent.includes('Odczytano aktualną kolejkę'));assert(!button(h,'Pobierz Mirakl do kolejki').disabled);assert.equal(posts().length,1);await h.close();
   }
  });
  await t.test('pending stage is single-flight and late old-context data stays hidden',async()=>{
   reset();const held=deferred();f.held=held;const h=await mount();await windowFields(h);await click(h,'Pobierz Mirakl do kolejki');await until(()=>posts().length===1);assert(button(h,'Pobierz Mirakl do kolejki').matches(':disabled'));
   await act(async()=>button(h,'Pobierz Mirakl do kolejki').dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal(posts().length,1);await h.render(props({readOnly:true}));await act(async()=>held.resolve(Response.json(stage())));await tick();assert(!h.el.textContent.includes('Zapisano do przeglądu'));assert.equal(posts().length,1);await h.close();
  });
  await t.test('Mirakl staged rows keep ordinary mapping/import controls and suppress unsupported B2B split flow',async()=>{
   reset();f.rows=[{id:inbound,external_id:'ORDER-17',state:'staged',source_hash:'a'.repeat(64),source_changed:false,imported_hash:null,order_id:null,issues:[],updated_at:'2026-10-17T00:00:00Z',normalized:{customer_name:'Kupujący',currency:'PLN',total:1234,shipping_cost:0,paid:false,blockers:[],items:[{external_id:'17',sku:'SOURCE',name:'Produkt',quantity:1,line_total:1234}]}}];const h=await mount();assert(h.el.textContent.includes('Importuj #ORDER-17'));assert(h.el.querySelector('[aria-label="Powiąż ofertę 17"]'));assert(!h.el.textContent.includes('Import z podziałem realizacji'));assert(!h.el.textContent.includes('Podział realizacji i historia'));assert.equal(posts().length,0);await h.close();
  });
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
