import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,tenant=id(1),user=id(2),channel=id(3);
const props=(patch={})=>({channelId:channel,tenantId:tenant,userId:user,admin:true,readOnly:false,...patch});
const account={shop_id:17,shop_name:'Własny sklep',currency_iso_code:'PLN',shop_state:'OPEN',model:'MARKETPLACE'};
const offer={offer_id:19,shop_sku:'SKU WŁASNE',product_sku:'PRODUCT-1',product_title:'Własny produkt',currency_iso_code:'PLN',price:12.34,quantity:4,active:true,state_code:'11'};
const order={order_id:'OWN-ORDER-1',currency_iso_code:'PLN',order_state:'SHIPPED',last_updated_date:'2026-10-17T10:00:00Z',total_price:14.34};
const page=data=>({data,offset:0,total_count:data.length,has_more:false});
const connectionHash='a'.repeat(64);
const envelope=(result,patch={})=>({channel_id:channel,connection_hash:connectionHash,mode:'live',scope:'external_read',read_only:true,account_verified:false,provider_acceptance:false,status:'CODE_NOT_CONNECTED_NOT_ACCOUNT_ACCEPTED',stages_orders:false,imports_orders:false,result,...patch});
const readbackRow=id=>({...order,order_id:id,id});
// Groups are explicit test-oracle inputs, not calculated by the production planner.
const readback=(ids,groups,index,data=[])=>({data,total_count:data.length,requested_order_ids:ids,group_index:index,group_count:groups.length,group_order_ids:groups[index],group_missing_order_ids:groups[index].filter(id=>!data.some(row=>row.order_id===id)),has_more_groups:index+1<groups.length,next_group:index+1<groups.length?index+1:null,readback_scope:'single_group',readback_complete:groups.length===1&&groups[index].every(id=>data.some(row=>row.order_id===id))});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('Mirakl ordinary read panel: actual React, controlled GET only, no DB/providers/listener',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),{MiraklReadsPanel}=await vite.ssrLoadModule(path.resolve('web/mirakl-reads.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const handles=[];let f;
 function reset(){api.setWorkspace(tenant);f={calls:[],me:0,demoteAt:0,expireAt:0,mePatch:{},available:true,healthHeld:null,held:null,error:null,value:null};globalThis.fetch=async(url,init={})=>{
  const p=new URL(String(url),'http://127.0.0.1');assert.equal(p.origin,'http://127.0.0.1');assert.equal(init.method,'GET','no mutations or automatic sync');assert.equal(init.body,undefined);
  f.calls.push(p.pathname+p.search);
  if(p.pathname==='/api/health')return f.healthHeld?f.healthHeld.promise:Response.json({mirakl_reads_available:f.available});
  assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);
  if(p.pathname==='/api/auth/me'){f.me++;if(f.expireAt&&f.me>=f.expireAt)return Response.json({detail:'PRIVATE_SQL_SOURCE'},{status:401});return Response.json({restore_preview:false,user:{id:user,tenant_id:tenant,role:f.demoteAt&&f.me>=f.demoteAt?'viewer':'admin'},...f.mePatch});}
  assert(p.pathname.startsWith('/api/integrations/'+channel+'/mirakl/'));
  if(f.held)return f.held.promise;if(f.error)return Response.json({detail:'PRIVATE_SQL_SOURCE',code:'MIRAKL_READ_DEFERRED'},{status:f.error});
  return Response.json(f.value??envelope(p.pathname.endsWith('/account')?account:p.pathname.endsWith('/offers-preview')?page([offer]):page([order])));
 };}
 const tick=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<60;i++){if(fn())return;await tick();}assert(fn(),'controlled React did not settle');}
 async function mount(p=props()){const el=document.createElement('div');document.body.append(el);const root=createRoot(el),h={el,async render(next){await act(async()=>root.render(React.createElement(MiraklReadsPanel,next)));},async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);await h.render(p);return h;}
 const button=(h,label)=>[...h.el.querySelectorAll('button')].find(b=>b.textContent===label);
 async function click(h,label){const b=button(h,label);assert(b&&!b.disabled,label);await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 async function input(h,label,value){const el=h.el.querySelector(`[aria-label="${label}"]`);assert(el);await act(async()=>{const prototype=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:el.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,value);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
 const clean=h=>{for(const hidden of [tenant,user,channel,'CODE_NOT_CONNECTED_NOT_ACCOUNT_ACCEPTED','external_read','PRIVATE_SQL_SOURCE','MIRAKL_READ_DEFERRED','MARKETPLACE','SHIPPED'])assert(!h.el.textContent.includes(hidden),hidden);};
 try{
  await t.test('mount stays idle; account is an explicit GET bracketed by IAM, with health before provider call',async()=>{
   reset();const h=await mount();assert.equal(f.calls.length,0);await click(h,'Odczytaj konto');await until(()=>h.el.textContent.includes('Własny sklep'));
   assert.deepEqual(f.calls,['/api/auth/me','/api/health','/api/integrations/'+channel+'/mirakl/account','/api/auth/me']);assert(h.el.textContent.includes('Otwarty'));clean(h);for(let n=0;n<3;n++)await tick();assert.equal(f.calls.length,4);await h.close();
  });
  await t.test('offers first-page max/SKU and explicit order ISO window/offset render safe tables; no automatic continuation',async()=>{
   reset();const h=await mount();await input(h,'Limit ofert','1');await input(h,'SKU oferty','SKU WŁASNE');f.value=envelope({data:[offer],offset:0,total_count:2,has_more:true});await click(h,'Odczytaj oferty');await until(()=>h.el.querySelector('caption')?.textContent==='Podgląd ofert');
   const offerUrl=new URL(f.calls[2],'http://local');assert.equal(offerUrl.searchParams.get('max'),'1');assert.equal(offerUrl.searchParams.get('sku'),'SKU WŁASNE');assert.equal(offerUrl.searchParams.has('offset'),false);assert(h.el.textContent.includes('Własny produkt'));assert(h.el.textContent.includes('nie jest pobierana automatycznie'));for(let n=0;n<3;n++)await tick();assert.equal(f.calls.length,4);
   await input(h,'Zamówienia od','2026-10-01T00:00:00Z');assert(!h.el.textContent.includes('Własny produkt'));await input(h,'Zamówienia do','2026-10-02T00:00:00Z');assert.equal(h.el.querySelector('[aria-label="Pozycja początkowa"]').value,'0');await input(h,'Pozycja początkowa','2');f.value=envelope({data:[order],offset:2,total_count:3,has_more:false});await click(h,'Odczytaj zamówienia');await until(()=>h.el.textContent.includes('OWN-ORDER-1'));
   const orderUrl=new URL(f.calls[6],'http://local');assert.equal(orderUrl.searchParams.get('offset'),'2');assert.equal(orderUrl.searchParams.get('start_update_date'),'2026-10-01T00:00:00Z');assert(h.el.textContent.includes('Wysłane'));clean(h);await h.close();
  });
  await t.test('explicit offer next/previous pages preserve observed offsets, including short pages, with no automatic fetch',async()=>{
   reset();const h=await mount();await input(h,'Limit ofert','2');f.value=envelope({data:[offer],offset:0,total_count:4,has_more:true});await click(h,'Odczytaj oferty');await until(()=>!!h.el.querySelector('table'));
   assert(button(h,'Poprzednia strona ofert').disabled);assert(!button(h,'Następna strona ofert').disabled);
   f.value=envelope({data:[{...offer,offer_id:20}],offset:1,total_count:4,has_more:true});await click(h,'Następna strona ofert');await until(()=>h.el.textContent.includes('początek: 1'));
   assert.equal(new URL(f.calls[6],'http://local').searchParams.get('offset'),'1');assert.equal(new URL(f.calls[6],'http://local').searchParams.get('connection_hash'),connectionHash);assert(!button(h,'Poprzednia strona ofert').disabled);
   f.value=envelope({data:[{...offer,offer_id:21},{...offer,offer_id:22}],offset:2,total_count:4,has_more:false});await click(h,'Następna strona ofert');await until(()=>h.el.textContent.includes('początek: 2'));
   assert.equal(new URL(f.calls[10],'http://local').searchParams.get('offset'),'2');assert(button(h,'Następna strona ofert').disabled);
   f.value=envelope({data:[{...offer,offer_id:20}],offset:1,total_count:4,has_more:true});await click(h,'Poprzednia strona ofert');await until(()=>h.el.textContent.includes('początek: 1'));
   assert.equal(new URL(f.calls[14],'http://local').searchParams.get('offset'),'1','previous is observed offset, not offset minus requested max');
   for(let n=0;n<3;n++)await tick();assert.equal(f.calls.length,16);clean(h);await h.close();
  });
  await t.test('offer pagination resets after SKU, max or principal changes and rejects a response for another page',async()=>{
   for(const action of ['sku','max','principal']){
    reset();const h=await mount();await input(h,'Limit ofert','1');f.value=envelope({data:[offer],offset:0,total_count:3,has_more:true});await click(h,'Odczytaj oferty');await until(()=>!!h.el.querySelector('table'));
    f.value=envelope({data:[{...offer,offer_id:20}],offset:1,total_count:3,has_more:true});await click(h,'Następna strona ofert');await until(()=>h.el.textContent.includes('początek: 1'));
    if(action==='sku')await input(h,'SKU oferty','NEW');else if(action==='max')await input(h,'Limit ofert','2');else{await h.render(props({channelId:id(9)}));assert(!h.el.querySelector('table'));await h.render(props());}
    assert(!h.el.querySelector('table'));f.value=envelope(page([offer]));await click(h,'Odczytaj oferty');await until(()=>!!h.el.querySelector('table'));
    assert.equal(new URL(f.calls[10],'http://local').searchParams.has('offset'),false);assert(button(h,'Poprzednia strona ofert').disabled);await h.close();
   }
   reset();const h=await mount();f.value=envelope({data:[offer],offset:0,total_count:2,has_more:true});await click(h,'Odczytaj oferty');await until(()=>!!h.el.querySelector('table'));
   f.value=envelope({data:[{...offer,offer_id:20}],offset:0,total_count:2,has_more:true});await click(h,'Następna strona ofert');await until(()=>!!h.el.querySelector('[role=alert]'));assert(!h.el.querySelector('table'));assert.equal(f.calls.length,8);await h.close();
  });
  await t.test('pending next-page click is single-flight and a filter change hides the late response without following it',async()=>{
   reset();const h=await mount();f.value=envelope({data:[offer],offset:0,total_count:2,has_more:true});await click(h,'Odczytaj oferty');await until(()=>!!h.el.querySelector('table'));
   const held=deferred();f.held=held;const next=button(h,'Następna strona ofert');await act(async()=>{next.dispatchEvent(new MouseEvent('click',{bubbles:true}));next.dispatchEvent(new MouseEvent('click',{bubbles:true}));});await until(()=>f.calls.length===7);
   await input(h,'SKU oferty','NEW');await act(async()=>held.resolve(Response.json(envelope({data:[{...offer,offer_id:20}],offset:1,total_count:2,has_more:false}))));await tick();assert.equal(f.calls.length,7);assert(!h.el.querySelector('table'));assert(!h.el.querySelector('[role=alert]'));await h.close();
  });
  await t.test('old server cannot page without a generation; changed configuration clears history and requires a fresh first page',async()=>{
   reset();const old=await mount();f.value=envelope({data:[offer],offset:0,total_count:2,has_more:true},{connection_hash:undefined});await click(old,'Odczytaj oferty');await until(()=>!!old.el.querySelector('table'));assert(button(old,'Następna strona ofert').disabled);assert(old.el.textContent.includes('Kolejne strony są niedostępne'));assert.equal(f.calls.length,4);await old.close();
   for(const failure of ['conflict','changed_hash']){
    reset();const h=await mount();f.value=envelope({data:[offer],offset:0,total_count:2,has_more:true});await click(h,'Odczytaj oferty');await until(()=>!!h.el.querySelector('table'));
    if(failure==='conflict')f.error=409;else f.value=envelope({data:[{...offer,offer_id:20}],offset:1,total_count:2,has_more:false},{connection_hash:'b'.repeat(64)});
    await click(h,'Następna strona ofert');await until(()=>!!h.el.querySelector('[role=alert]'));assert(!h.el.querySelector('table'));for(let n=0;n<3;n++)await tick();assert.equal(f.calls.length,failure==='conflict'?7:8);
    f.error=null;f.value=envelope(page([offer]),{connection_hash:'b'.repeat(64)});await click(h,'Odczytaj oferty');await until(()=>!!h.el.querySelector('table'));assert.equal(new URL(f.calls.at(-2),'http://local').searchParams.has('offset'),false);assert(button(h,'Poprzednia strona ofert').disabled);await h.close();
   }
  });
  await t.test('old server, role and read-only context refuse external reads; malformed local window does not call API',async()=>{
   reset();f.available=false;const old=await mount();await click(old,'Odczytaj konto');await until(()=>old.el.textContent.includes('niedostępne'));assert.deepEqual(f.calls,['/api/auth/me','/api/health']);assert([...old.el.querySelectorAll('button')].filter(b=>b.textContent!=='Sprawdź ponownie dostępność').every(b=>b.disabled));assert(!button(old,'Sprawdź ponownie dostępność').disabled);await old.close();
   for(const patch of [{admin:false},{readOnly:true},{tenantId:'invalid'}]){reset();const h=await mount(props(patch));assert([...h.el.querySelectorAll('button')].every(b=>b.disabled));assert.equal(f.calls.length,0);await h.close();}
   reset();const h=await mount();await click(h,'Odczytaj zamówienia');await until(()=>!!h.el.querySelector('[role=alert]'));assert.equal(f.calls.length,0);await input(h,'Zamówienia od','2026-02-30T00:00:00Z');await input(h,'Zamówienia do','2026-03-03T00:00:00Z');await click(h,'Odczytaj zamówienia');assert.equal(f.calls.length,0);await h.close();
  });
  await t.test('availability can be explicitly rechecked after a local runtime change without reading the provider or losing filters',async()=>{
   reset();f.available=false;const h=await mount();await input(h,'Limit ofert','2');await input(h,'SKU oferty','SKU ŻÓŁĆ');await click(h,'Odczytaj oferty');await until(()=>!!button(h,'Sprawdź ponownie dostępność'));
   f.available=true;await click(h,'Sprawdź ponownie dostępność');await until(()=>!button(h,'Sprawdź ponownie dostępność'));
   assert.deepEqual(f.calls,['/api/auth/me','/api/health','/api/auth/me','/api/health']);assert(!h.el.querySelector('table'));assert(!h.el.querySelector('[role=alert]'));assert(!button(h,'Odczytaj oferty').disabled);
   assert.equal(h.el.querySelector('[aria-label="Limit ofert"]').value,'2');assert.equal(h.el.querySelector('[aria-label="SKU oferty"]').value,'SKU ŻÓŁĆ');for(let n=0;n<3;n++)await tick();assert.equal(f.calls.length,4);
   await click(h,'Odczytaj oferty');await until(()=>!!h.el.querySelector('table'));const url=new URL(f.calls[6],'http://local');assert.equal(url.searchParams.get('max'),'2');assert.equal(url.searchParams.get('sku'),'SKU ŻÓŁĆ');assert.equal(url.searchParams.has('offset'),false);assert.equal(f.calls.length,8);clean(h);await h.close();
  });
  await t.test('an unavailable recheck stays local and manual; concurrent clicks and an edited view cannot apply late health',async()=>{
   reset();f.available=false;const h=await mount();await click(h,'Odczytaj konto');await until(()=>!!button(h,'Sprawdź ponownie dostępność'));
   await click(h,'Sprawdź ponownie dostępność');await until(()=>f.calls.length===4&&!button(h,'Sprawdź ponownie dostępność').disabled);assert(button(h,'Odczytaj konto').disabled);for(let n=0;n<3;n++)await tick();assert.equal(f.calls.length,4);
   const held=deferred();f.healthHeld=held;const retry=button(h,'Sprawdź ponownie dostępność');await act(async()=>{retry.dispatchEvent(new MouseEvent('click',{bubbles:true}));retry.dispatchEvent(new MouseEvent('click',{bubbles:true}));});await until(()=>f.calls.length===6);assert([...h.el.querySelectorAll('button')].every(b=>b.disabled));
   await input(h,'SKU oferty','changed');await act(async()=>held.resolve(Response.json({mirakl_reads_available:true})));await tick();assert.equal(f.calls.length,6);assert(!!button(h,'Sprawdź ponownie dostępność'));assert(button(h,'Odczytaj konto').disabled);assert(!h.el.querySelector('table'));assert(!h.el.querySelector('[role=alert]'));await h.close();
  });
  await t.test('availability recheck requires current administrator IAM and cannot revive health after a principal round trip',async()=>{
   reset();f.available=false;const denied=await mount();await click(denied,'Odczytaj konto');await until(()=>!!button(denied,'Sprawdź ponownie dostępność'));f.demoteAt=2;await click(denied,'Sprawdź ponownie dostępność');await until(()=>denied.el.textContent.includes('bieżącej sesji administratora'));assert.deepEqual(f.calls,['/api/auth/me','/api/health','/api/auth/me']);assert(button(denied,'Odczytaj konto').disabled);assert(!denied.el.querySelector('table'));clean(denied);await denied.close();
   reset();f.available=false;const h=await mount();await click(h,'Odczytaj konto');await until(()=>!!button(h,'Sprawdź ponownie dostępność'));const held=deferred();f.healthHeld=held;await click(h,'Sprawdź ponownie dostępność');await until(()=>f.calls.length===4);await h.render(props({userId:id(9)}));await h.render(props());
   await act(async()=>held.resolve(Response.json({mirakl_reads_available:false})));await tick();assert.equal(f.calls.length,4);assert(!button(h,'Sprawdź ponownie dostępność'));assert(!h.el.textContent.includes('niedostępne'));assert(!h.el.querySelector('table'));assert(!h.el.querySelector('[role=alert]'));await h.close();
  });
  await t.test('wrong channel and malformed envelope/page never render a successful result',async()=>{
   for(const value of [envelope(account,{channel_id:id(9)}),envelope(account,{provider_acceptance:true}),envelope({...account,shop_name:42}),envelope({...account,model:'OTHER'}),envelope({data:[offer],offset:3,total_count:4,has_more:false})]){
    reset();f.value=value;const h=await mount();await click(h,Array.isArray(value.result?.data)?'Odczytaj oferty':'Odczytaj konto');await until(()=>!!h.el.querySelector('[role=alert]'));assert(!h.el.querySelector('table'));clean(h);await h.close();
   }
  });
  await t.test('malformed provider rows and pagination cannot become user-visible observations',async()=>{
   const values=[
    page([{...offer,price:12.345}]),page([{...offer,quantity:-1}]),page([{...offer,currency_iso_code:'BAD'}]),
    page([offer,{...offer,shop_sku:'different'}]),{...page([offer]),total_count:1000001,has_more:true},
    {...page([offer]),has_more:true},{data:[],offset:0,total_count:1,has_more:true},
   ];
   for(const value of values){reset();f.value=envelope(value);const h=await mount();await click(h,'Odczytaj oferty');await until(()=>!!h.el.querySelector('[role=alert]'));assert(!h.el.querySelector('table'));clean(h);await h.close();}
   reset();f.available=undefined;const h=await mount();await click(h,'Odczytaj konto');await until(()=>!!h.el.querySelector('[role=alert]'));assert.deepEqual(f.calls,['/api/auth/me','/api/health']);assert(!h.el.querySelector('table'));await h.close();
  });
  await t.test('a pending explicit read is single-flight and expired IAM before or after hides all provider data',async()=>{
   reset();const held=deferred();f.held=held;const h=await mount();await click(h,'Odczytaj konto');await until(()=>f.calls.length===3);
   assert([...h.el.querySelectorAll('button')].every(b=>b.disabled));
   await act(async()=>{button(h,'Odczytaj konto').dispatchEvent(new MouseEvent('click',{bubbles:true}));button(h,'Odczytaj oferty').dispatchEvent(new MouseEvent('click',{bubbles:true}));});
   assert.equal(f.calls.length,3);await act(async()=>held.resolve(Response.json(envelope(account))));await until(()=>h.el.textContent.includes('Własny sklep'));assert.equal(f.calls.length,4);await h.close();
   for(const expireAt of [1,2]){reset();f.expireAt=expireAt;const denied=await mount();await click(denied,'Odczytaj konto');await until(()=>!!denied.el.querySelector('[role=alert]'));assert.equal(f.calls.length,expireAt===1?1:4);assert(!denied.el.querySelector('table'));clean(denied);await denied.close();}
   reset();f.mePatch={read_only:true};const readonly=await mount();await click(readonly,'Odczytaj konto');await until(()=>!!readonly.el.querySelector('[role=alert]'));assert.equal(f.calls.length,1);assert(!readonly.el.querySelector('table'));await readonly.close();
  });
  await t.test('all own results/errors disappear immediately on context, role, read-only or field changes',async()=>{
   for(const patch of [{channelId:id(9)},{tenantId:id(9)},{userId:id(9)},{admin:false},{readOnly:true}]){reset();const h=await mount();await click(h,'Odczytaj konto');await until(()=>h.el.textContent.includes('Własny sklep'));await h.render(props(patch));assert(!h.el.textContent.includes('Własny sklep'));assert(!h.el.querySelector('[role=alert]'));await h.render(props());assert(!h.el.textContent.includes('Własny sklep'),'returning to former context cannot revive old data');assert.equal(f.calls.length,4);await h.close();}
   reset();f.value=envelope(account,{channel_id:id(9)});const h=await mount();await click(h,'Odczytaj konto');await until(()=>!!h.el.querySelector('[role=alert]'));await h.render(props({admin:false}));await h.render(props());assert(!h.el.querySelector('[role=alert]'),'role restoration cannot revive prior error');await input(h,'SKU oferty','nowe');assert(!h.el.querySelector('[role=alert]'));await h.close();
  });
  await t.test('late response, field edit, unmount and IAM downgrade cannot expose old data',async()=>{
   for(const action of ['context','field','unmount']){reset();const held=deferred();f.held=held;const h=await mount();await click(h,'Odczytaj konto');await until(()=>f.calls.length===3);if(action==='context')await h.render(props({userId:id(9)}));else if(action==='field')await input(h,'SKU oferty','changed');else await h.close();await act(async()=>held.resolve(Response.json(envelope(account))));await tick();assert(!h.el.textContent.includes('Własny sklep'));assert.equal(f.calls.length,3);if(h.el.isConnected)await h.close();}
   reset();f.demoteAt=2;const h=await mount();await click(h,'Odczytaj konto');await until(()=>!!h.el.querySelector('[role=alert]'));assert(!h.el.querySelector('table'));assert.equal(f.calls.length,4);await h.close();
   reset();f.demoteAt=1;const denied=await mount();await click(denied,'Odczytaj konto');await until(()=>!!denied.el.querySelector('[role=alert]'));assert.equal(f.calls.length,1);await denied.close();
   for(const mePatch of [{restore_preview:true},{user:{id:id(9),tenant_id:tenant,role:'admin'}},{user:{id:user,tenant_id:id(9),role:'admin'}}]){reset();f.mePatch=mePatch;const mismatch=await mount();await click(mismatch,'Odczytaj konto');await until(()=>!!mismatch.el.querySelector('[role=alert]'));assert.equal(f.calls.length,1);assert(!mismatch.el.querySelector('table'));await mismatch.close();}
  });
  await t.test('provider cooldown is shown safely and never schedules an automatic retry',async()=>{
   reset();f.error=429;const h=await mount();await click(h,'Odczytaj konto');await until(()=>h.el.textContent.includes('Odczekaj'));clean(h);for(let n=0;n<4;n++)await tick();assert.equal(f.calls.length,3);await click(h,'Odczytaj konto');await until(()=>f.calls.length===6);assert(!h.el.querySelector('table'));await h.close();
  });
  await t.test('exact-ID readback preserves literal whitespace/UTF8 IDs and marks missing as unreturned, with one explicit GET',async()=>{
   reset();const ids=[' A 01 ','B/zażółć'];f.value=envelope(readback(ids,[ids],0,[readbackRow(ids[0])]));const h=await mount();assert.equal(f.calls.length,0);
   await input(h,'Identyfikatory zamówień',ids.join('\n'));await click(h,'Odczytaj wybraną grupę');await until(()=>h.el.querySelector('caption')?.textContent==='Odczyt wskazanych zamówień');
   assert.deepEqual(f.calls.slice(0,2),['/api/auth/me','/api/health']);const url=new URL(f.calls[2],'http://local');assert.equal(url.pathname,'/api/integrations/'+channel+'/mirakl/orders-readback');assert.equal(url.searchParams.get('order_ids'),' A 01 ,B/zażółć');assert.equal(url.searchParams.get('group'),'0');assert.deepEqual([...url.searchParams.keys()],['order_ids','group']);assert.equal(f.calls[3],'/api/auth/me');
   assert.equal(h.el.querySelector('[aria-label="Niezwrócone identyfikatory"] li').textContent,'B/zażółć — niezwrócone');assert(h.el.textContent.includes('nie oznacza usunięcia'));assert(h.el.textContent.includes('nie potwierdza wszystkich'));clean(h);for(let i=0;i<3;i++)await tick();assert.equal(f.calls.length,4);await h.close();
  });
  await t.test('greedy UTF8 byte boundaries and explicit 1-based group choice bind the 0-based request; last group never claims full multi-group completion',async()=>{
   reset();const ids=['ż'.repeat(50),'B','C'.repeat(98),'D'],groups=[[ids[0]],[ids[1],ids[2]],[ids[3]]];const h=await mount();await input(h,'Identyfikatory zamówień',ids.join('\n'));
   assert.equal(h.el.querySelector('[aria-label="Grupa identyfikatorów"]').options.length,3);assert(h.el.textContent.includes('4 identyfikatorów w 3 grupach'));
   await input(h,'Grupa identyfikatorów','2');f.value=envelope(readback(ids,groups,1,[readbackRow(ids[2]),readbackRow(ids[1])]));await click(h,'Odczytaj wybraną grupę');await until(()=>!!h.el.querySelector('table'));
   const url=new URL(f.calls[2],'http://local');assert.equal(url.searchParams.get('group'),'1');assert.equal(url.searchParams.get('order_ids'),ids.join(','));assert(h.el.textContent.includes('Następna grupa: 3'));assert(h.el.textContent.includes('Nie potwierdza kompletności całego odczytu'));for(let i=0;i<3;i++)await tick();assert.equal(f.calls.length,4);
   await input(h,'Grupa identyfikatorów','3');assert(!h.el.querySelector('table'));f.value=envelope(readback(ids,groups,2,[readbackRow('D')]));await click(h,'Odczytaj wybraną grupę');await until(()=>!!h.el.querySelector('table'));assert.equal(new URL(f.calls[6],'http://local').searchParams.get('group'),'2');assert(h.el.textContent.includes('Nie potwierdza kompletności całego odczytu'));assert(!h.el.textContent.includes('Następna grupa:'));assert(!h.el.textContent.includes('Dostawca zwrócił wszystkie'));
   await input(h,'Identyfikatory zamówień','NEW');assert(!h.el.querySelector('table'));assert.equal(h.el.querySelector('[aria-label="Grupa identyfikatorów"]').value,'1');assert.equal(f.calls.length,8);await h.close();
  });
  await t.test('100 exact IDs retain original roster; invalid duplicates, commas, control, UTF8, overlong IDs and blank rows refuse before IAM or provider HTTP',async()=>{
   for(const raw of ['', 'A\nA','A,B','A\tB','A\x7fB','A\n','A\n\nB','A'.repeat(101),'ą'.repeat(51),'\ud800',Array.from({length:101},(_,i)=>'ID-'+i).join('\n')]){
    reset();const h=await mount();await input(h,'Identyfikatory zamówień',raw);await click(h,'Odczytaj wybraną grupę');await until(()=>!!h.el.querySelector('[role=alert]'));assert.equal(f.calls.length,0,JSON.stringify(raw));assert(!h.el.querySelector('table'));await h.close();
   }
   reset();const ids=Array.from({length:100},(_,i)=>String(i+1)),groups=[ids.slice(0,36),ids.slice(36,69),ids.slice(69)];f.value=envelope(readback(ids,groups,0));const h=await mount();await input(h,'Identyfikatory zamówień',ids.join('\n'));assert.equal(h.el.querySelector('[aria-label="Grupa identyfikatorów"]').options.length,3);await click(h,'Odczytaj wybraną grupę');await until(()=>!!h.el.querySelector('[aria-label="Niezwrócone identyfikatory"]'));assert.equal(h.el.querySelectorAll('[aria-label="Niezwrócone identyfikatory"] li').length,36);assert.equal(new URL(f.calls[2],'http://local').searchParams.get('order_ids'),ids.join(','));assert.equal(f.calls.length,4);await h.close();
  });
  await t.test('foreign/reordered requested scope, group drift, malformed rows/totals/missing/continuation or false complete claims never render a readback',async()=>{
   const ids=['A','B','C'],base=readback(ids,[ids],0,[readbackRow('A'),readbackRow('B')]);
   const variants=[
    {...base,requested_order_ids:['B','A','C']},{...base,group_index:1},{...base,group_count:2},{...base,group_order_ids:['B','A','C']},
    {...base,data:[readbackRow('FOREIGN')]},{...base,data:[readbackRow('A'),readbackRow('A')]},{...base,data:[{...readbackRow('A'),id:'B'},readbackRow('B')]},
    {...base,data:[{...readbackRow('A'),total_price:1.234},readbackRow('B')]},{...base,data:[{...readbackRow('A'),last_updated_date:'2026-02-30T00:00:00Z'},readbackRow('B')]},
    {...base,total_count:3},{...base,group_missing_order_ids:[]},{...base,group_missing_order_ids:['B','C']},{...base,group_missing_order_ids:['C','C']},
    {...base,has_more_groups:true},{...base,next_group:1},{...base,readback_scope:'all_groups'},{...base,readback_complete:true},
   ];
   for(const value of [...variants.map(r=>envelope(r)),envelope(base,{channel_id:id(9)}),envelope(base,{stages_orders:true})]){
    reset();f.value=value;const h=await mount();await input(h,'Identyfikatory zamówień',ids.join('\n'));await click(h,'Odczytaj wybraną grupę');await until(()=>!!h.el.querySelector('[role=alert]'));assert(!h.el.querySelector('table'));assert(!h.el.querySelector('[aria-label="Niezwrócone identyfikatory"]'));assert.equal(f.calls.length,4);clean(h);await h.close();
   }
   reset();const many=['x'.repeat(100),'Y'];f.value=envelope({...readback(many,[[many[0]],['Y']],1,[readbackRow('Y')]),readback_complete:true});const h=await mount();await input(h,'Identyfikatory zamówień',many.join('\n'));await input(h,'Grupa identyfikatorów','2');await click(h,'Odczytaj wybraną grupę');await until(()=>!!h.el.querySelector('[role=alert]'));assert(!h.el.querySelector('table'));await h.close();
  });
  await t.test('readback complete is restricted to one exact group without missing IDs; empty observation is explicitly unreturned',async()=>{
   reset();const ids=['A','B'];f.value=envelope(readback(ids,[ids],0,[readbackRow('B'),readbackRow('A')]));const h=await mount();await input(h,'Identyfikatory zamówień',ids.join('\n'));await click(h,'Odczytaj wybraną grupę');await until(()=>!!h.el.querySelector('table'));assert(h.el.textContent.includes('Dostawca zwrócił wszystkie wskazane identyfikatory w tej jednej grupie'));assert.equal(h.el.querySelectorAll('tbody tr').length,2);
   await input(h,'Identyfikatory zamówień','NONE');f.value=envelope(readback(['NONE'],[['NONE']],0));await click(h,'Odczytaj wybraną grupę');await until(()=>!!h.el.querySelector('[aria-label="Niezwrócone identyfikatory"]'));assert(!h.el.querySelector('table'));assert.equal(h.el.querySelector('li').textContent,'NONE — niezwrócone');assert(!h.el.textContent.includes('Dostawca zwrócił wszystkie'));await h.close();
  });
  await t.test('readback lost/late response, edited IDs/group, switched principal, read-only and revoked IAM hide observations without a followup GET',async()=>{
   const ids=['x'.repeat(100),'B'],groups=[[ids[0]],['B']];
   for(const action of ['ids','group','tenant','user','readOnly','unmount']){
    reset();const held=deferred();f.held=held;const h=await mount();await input(h,'Identyfikatory zamówień',ids.join('\n'));await click(h,'Odczytaj wybraną grupę');await until(()=>f.calls.length===3);assert([...h.el.querySelectorAll('button')].every(b=>b.disabled));
    if(action==='ids')await input(h,'Identyfikatory zamówień','NEW');else if(action==='group')await input(h,'Grupa identyfikatorów','2');else if(action==='tenant')await h.render(props({tenantId:id(9)}));else if(action==='user')await h.render(props({userId:id(9)}));else if(action==='readOnly')await h.render(props({readOnly:true}));else await h.close();
    await act(async()=>held.resolve(Response.json(envelope(readback(ids,groups,0,[readbackRow(ids[0])])))));await tick();assert(!h.el.querySelector('table'));assert(!h.el.querySelector('[aria-label="Niezwrócone identyfikatory"]'));assert.equal(f.calls.length,3);if(h.el.isConnected)await h.close();
   }
   reset();f.demoteAt=2;f.value=envelope(readback(['A'],[['A']],0,[readbackRow('A')]));const h=await mount();await input(h,'Identyfikatory zamówień','A');await click(h,'Odczytaj wybraną grupę');await until(()=>!!h.el.querySelector('[role=alert]'));assert(!h.el.querySelector('table'));assert.equal(f.calls.length,4);await h.close();
   for(const error of [404,429]){reset();f.error=error;const denied=await mount();await input(denied,'Identyfikatory zamówień','A');await click(denied,'Odczytaj wybraną grupę');await until(()=>!!denied.el.querySelector('[role=alert]'));for(let i=0;i<3;i++)await tick();assert.equal(f.calls.length,3);assert(!denied.el.querySelector('table'));clean(denied);await denied.close();}
  });
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
