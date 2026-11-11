import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant=id(1),user=id(2),channel=id(3),fixtureId=id(4),channel2=id(5),fixture2=id(6),job=id(7);
const summary=(second=false)=>({scope:'local_https_fixture',provider_verified:false,fixture_id:second?fixture2:fixtureId,channel_id:second?channel2:channel,origin:second?'https://localhost:8444':'https://localhost:8443',provider:'woocommerce',mode:'sandbox',status:'not_connected'});
const cut=(jobId=job,state='pending',once=false)=>({scope:'local_https_fixture',channel_id:channel,job:{id:jobId,kind:'orders.sync',state,attempts:0,max_attempts:1,lease_active:false},plan:null,once_intent_recorded:once});
const context={tenantId:tenant,userId:user,admin:true,readOnly:false};
test('Configured local Woo: real React/controlled API; no provider, listener or DB',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 Object.defineProperty(dom.window.navigator,'locks',{configurable:true,value:{request:async(_key,_options,fn)=>fn()}});
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client'),ui=await vite.ssrLoadModule(path.resolve('web/configured-woo.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 let f,handles=[];
 function reset(){window.localStorage.clear();f={posts:[],reads:[],enrolled:false,enrollUnknown:false,runUnknown:false,queueUnknown:false,role:'admin',unavailable:false,job:cut(),queueCount:0,demoteBeforeRun:false};api.setWorkspace(tenant);globalThis.fetch=async(url,init={})=>{
  const p=new URL(String(url),'http://127.0.0.1').pathname.replace(/^\/api/,''),method=init.method??'GET';assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);
  if(method==='GET'){
   f.reads.push(p);if(p==='/auth/me')return Response.json({user:{id:user,tenant_id:tenant,role:f.role,api_key_id:null},restore_preview:false});
   if(p==='/local-fixtures/woocommerce/channels')return f.unavailable?Response.json({detail:'Not found'},{status:404}):Response.json({scope:'local_https_fixture',provider_verified:false,data:f.stores??[{...summary(),name:'Sklep A',enrolled:true},{...summary(true),name:f.enrolled?'Sklep B':null,enrolled:f.enrolled}]});
   if(p.endsWith('/jobs/'+job)||p.endsWith('/jobs/'+id(20))||p.endsWith('/jobs/'+id(21))){if(f.demoteBeforeRun)f.role='viewer';return Response.json(f.job);}
   throw Error('Unexpected GET '+p);
  }
  const body=JSON.parse(init.body);f.posts.push({path:p,body});
  if(p==='/local-fixtures/woocommerce/channels/'+channel2){assert.deepEqual(body,{name:'Sklep B'});f.enrolled=true;if(f.enrollUnknown)throw Error('CONTROLLED_ACK_LOSS');return Response.json(summary(true),{status:201});}
  if(p.endsWith('/jobs/'+job+'/run-once')){assert.deepEqual(body,{});f.job=cut(job,'done',true);if(f.runUnknown)throw Error('CONTROLLED_ACK_LOSS');return Response.json(f.job);}
  if(p==='/integrations/'+channel+'/sync'){f.queueCount++;if(f.queueUnknown)throw Error('CONTROLLED_QUEUE_LOSS');const next=id(19+f.queueCount);f.job=cut(next);return Response.json({id:next,reused:false});}
  throw Error('Unexpected write '+p);
 };}
 async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
 async function until(fn,note){for(let n=0;n<80;n++){if(fn())return;await tick();}assert(fn(),note);}
 function button(h,label){const b=[...h.el.querySelectorAll('button')].find(x=>x.textContent.trim()===label);assert(b,label);return b;}
 async function click(b){assert(b&&!b.matches(':disabled'));await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 async function input(el,value){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});}
 async function mount(Component,props={}){const el=document.createElement('div');document.body.append(el);const root=createRoot(el),h={el,async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);await act(async()=>root.render(React.createElement(Component,{...context,...props})));return h;}
 const storeProps={refresh:0,onChanged(){},onOpenOffers(){},onOpenOrders(){},onOpenSync(){}};
 try{
  await t.test('two exact local stores; enrollment unknown is reconciled by read with no second POST',async()=>{
   reset();f.enrollUnknown=true;let opened='';const h=await mount(ui.ConfiguredWooStores,{...storeProps,onOpenOffers:id=>opened=id});await until(()=>h.el.textContent.includes('https://localhost:8444'),'two stores');
   await input(h.el.querySelector('input[aria-label="Nazwa sklepu https://localhost:8444"]'),'Sklep B');await click(button(h,'Podłącz sklep'));await until(()=>h.el.textContent.includes('CONTROLLED_ACK_LOSS'),'unknown enrollment');assert.equal(f.posts.length,1);assert(button(h,'Podłącz sklep').disabled);
   await click(button(h,'Odśwież sklepy'));await until(()=>h.el.textContent.includes('Sklep B'),'fresh observed enrollment');assert.equal(f.posts.length,1);const cards=h.el.querySelectorAll('article');await click([...cards[1].querySelectorAll('button')].find(x=>x.textContent==='Oferty, ceny i stany'));assert.equal(opened,channel2);await h.close();
  });
  await t.test('missing registry is unavailable, never a fabricated DEMO store',async()=>{
   reset();f.unavailable=true;const h=await mount(ui.ConfiguredWooStores,storeProps);await until(()=>h.el.textContent.includes('nie są dostępne w tym uruchomieniu'),'registry absent');assert.equal(h.el.querySelectorAll('article').length,0);assert.equal(f.posts.length,0);await h.close();
  });
  await t.test('five finite configured stores render and decode without claiming provider verification',async()=>{
   reset();f.stores=Array.from({length:5},(_,i)=>({...summary(),channel_id:id(100+i),fixture_id:id(200+i),origin:'https://localhost:'+(18443+i),name:'Scale '+i,enrolled:true}));
   const h=await mount(ui.ConfiguredWooStores,storeProps);await until(()=>h.el.querySelectorAll('article').length===5,'all five own configured stores render');
   for(const row of f.stores)assert(h.el.textContent.includes(row.origin));assert.equal(f.posts.length,0);
   const data={scope:'local_https_fixture',provider_verified:false,data:f.stores};assert.equal(ui.readConfiguredWooList(data).length,5);
   assert.throws(()=>ui.readConfiguredWooList({...data,data:[...f.stores,{...summary(),name:'Legacy',enrolled:true}]}));
   for(const origin of ['https://localhost:18448','https://localhost:18443/','https://localhost:18443?q=1','https://user:secret@localhost:18443',' https://localhost:18443'])assert.throws(()=>ui.readConfiguredWooList({...data,data:[{...f.stores[0],origin}]}));
   await h.close();
  });
  await t.test('normal orders.sync DONE attempts0 after one execution is accepted',async()=>{
   reset();const h=await mount(ui.LocalWooJobControl,{channelId:channel,jobId:job});await click(button(h,'Odczytaj zadanie lokalnego Woo'));await click(button(h,'Wykonaj nowe zadanie raz'));await until(()=>h.el.textContent.includes('Zakończone'),'done0');assert(h.el.textContent.includes('próby 0/1'));assert.equal(f.posts.length,1);assert(button(h,'Wykonaj nowe zadanie raz').disabled);await h.close();
  });
  await t.test('lost run ACK persists across remount; GET DONE does not resend execution',async()=>{
   reset();f.runUnknown=true;let h=await mount(ui.LocalWooJobControl,{channelId:channel,jobId:job});await click(button(h,'Odczytaj zadanie lokalnego Woo'));await click(button(h,'Wykonaj nowe zadanie raz'));await until(()=>h.el.textContent.includes('CONTROLLED_ACK_LOSS'),'lost ACK');await h.close();
   h=await mount(ui.LocalWooJobControl,{channelId:channel,jobId:job});assert(button(h,'Wykonaj nowe zadanie raz').disabled);await click(button(h,'Odczytaj zadanie lokalnego Woo'));await until(()=>h.el.textContent.includes('Zakończone'),'durable done read');assert.equal(f.posts.length,1);assert(button(h,'Wykonaj nowe zadanie raz').disabled);await h.close();
  });
  await t.test('current role loss before dispatch and readonly mode never send POST',async()=>{
   reset();const h=await mount(ui.LocalWooJobControl,{channelId:channel,jobId:job});await click(button(h,'Odczytaj zadanie lokalnego Woo'));f.demoteBeforeRun=true;await click(button(h,'Wykonaj nowe zadanie raz'));await until(()=>h.el.textContent.includes('sesja administratora'),'fresh role refused');assert.equal(f.posts.length,0);await h.close();
   reset();const ro=await mount(ui.LocalWooJobControl,{channelId:channel,jobId:job,readOnly:true});await click(button(ro,'Odczytaj zadanie lokalnego Woo'));assert(button(ro,'Wykonaj nowe zadanie raz').disabled);assert.equal(f.posts.length,0);await ro.close();
  });
  await t.test('new queue requires known prior completion; unknown queue blocks fresh write after remount',async()=>{
   reset();let h=await mount(ui.LocalWooOrderQueueButton,{channelId:channel,onChanged(){}});await click(button(h,'Zleć pobranie zamówień lokalnego Woo'));await until(()=>f.posts.length===1,'first queue');await click(button(h,'Zleć pobranie zamówień lokalnego Woo'));assert.equal(f.posts.length,1);assert(h.el.textContent.includes('Poprzedni odczyt nie został zakończony'));
   f.job=cut(id(20),'done',true);await click(button(h,'Zleć pobranie zamówień lokalnego Woo'));assert.equal(f.posts.length,2);await h.close();
   reset();f.queueUnknown=true;h=await mount(ui.LocalWooOrderQueueButton,{channelId:channel,onChanged(){}});await click(button(h,'Zleć pobranie zamówień lokalnego Woo'));await until(()=>h.el.textContent.includes('CONTROLLED_QUEUE_LOSS'),'queue loss');await h.close();h=await mount(ui.LocalWooOrderQueueButton,{channelId:channel,onChanged(){}});assert(button(h,'Zleć pobranie zamówień lokalnego Woo').disabled);assert.equal(f.posts.length,1);await h.close();
  });
  await t.test('only explicit server observational capability allows verify GET task; no original write retry',async()=>{
   reset();f.job={...cut(),observational_only:true,job:{...cut().job,kind:'offer.write'},plan:{id:id(30),state:'queued',phase:'verify'}};
   const h=await mount(ui.LocalWooJobControl,{channelId:channel,jobId:job});await click(button(h,'Odczytaj zadanie lokalnego Woo'));assert(button(h,'Wykonaj nowe zadanie raz').disabled);assert(!button(h,'Uzgodnij wynik samym odczytem raz').disabled);
   // Controlled ACK loses its capability: UI treats it as unknown and still never resends.
   await click(button(h,'Uzgodnij wynik samym odczytem raz'));assert.equal(f.posts.length,1);assert(button(h,'Uzgodnij wynik samym odczytem raz').disabled);await h.close();
   assert(!ui.freshLocalWooObservation({...f.job,observational_only:false}));assert(!ui.freshLocalWooObservation({...f.job,observational_only:undefined}));
  });
  await t.test('foreign/duplicate/store URL/job scope and malformed saved marker refuse',()=>{
   const good={scope:'local_https_fixture',provider_verified:false,data:[{...summary(),name:'Sklep A',enrolled:true}]};assert.equal(ui.readConfiguredWooList(good).length,1);
   for(const bad of [{...good,data:[good.data[0],good.data[0]]},{...good,data:[{...good.data[0],origin:'https://example.test'}]},{...good,provider_verified:true}])assert.throws(()=>ui.readConfiguredWooList(bad));
   assert.throws(()=>ui.readLocalWooJob(cut(),channel2,job));assert.throws(()=>ui.readLocalWooJob(cut(),channel,id(8)));assert.throws(()=>ui.readWooMarker('{"v":1}',tenant+':'+user,job));assert(!ui.freshLocalWooJob(cut(job,'done',true)));assert(!ui.freshLocalWooJob({...cut(),once_intent_recorded:true}));
  });
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
