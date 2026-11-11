import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React, {act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant=id(1),user=id(2),job=id(3),channel=id(4),plan=id(5),orderId=id(6);
const context={tenantId:tenant,userId:user,admin:true,readOnly:false};
const order={id:orderId,status:'packed',total:10000,customer_name:'Buyer Test',email:'buyer@example.test',address:{},shipments:[]};
const cases=[['offer.write','OffersPanel','offers.tsx'],['shipping','ShippingPanel','shipping.tsx'],['shipping.dpd','DpdShippingPanel','dpd-shipping.tsx'],['dpd.collection','DpdCollections','dpd-collections.tsx']];
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const cut=(kind,state='pending',once=false,attempts=0)=>({scope:'sandbox_manual_once',job:{id:job,kind,state,attempts,max_attempts:1,lease_active:state==='running'},plan:{id:plan,state:state==='pending'?'queued':'done',phase:state==='pending'?'ready':'confirmed'},once_intent_recorded:once,completed:state==='done',continuation_required:state==='pending'&&once,automatic_retry:false,provider_acceptance:false});

test('actual business panels expose the four existing exact-job controls without automatic provider dispatch',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),originalFetch=globalThis.fetch;
 for(const [k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,CustomEvent:dom.window.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true})){
  saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});
 }
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_key,_options,fn)=>fn()}});
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),api=await vite.ssrLoadModule(path.resolve('web/api.ts')),components={};
 for(const [,name,file]of cases)components[name]=(await vite.ssrLoadModule(path.resolve('web/'+file)))[name];
 const handles=[];let f;
 const tick=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<100;i++){if(fn())return;await tick();}assert(fn(),'expected controlled panel state');}
 const button=(h,label)=>[...h.container.querySelectorAll('button')].find(b=>b.textContent===label);
 const readButton=h=>button(h,'Odczytaj zadanie i dostęp do sandboxa');
 const runButton=h=>button(h,'Wykonaj raz w sandboxie');
 async function click(el){assert(el&&!el.disabled,el?.textContent);await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 function reset(kind){
  window.localStorage.clear();api.setWorkspace(tenant);
  f={kind,cut:cut(kind),reads:[],posts:[],simulation:false,available:true,lost:false,keepFresh:false,holdJob:null,principal:user,changed:0,state:'queued',phase:'ready'};
  globalThis.fetch=async(url,init={})=>{
   const parsed=new URL(String(url),'http://127.0.0.1'),p=parsed.pathname.replace(/^\/api/,''),method=init.method??'GET';
   assert.equal(parsed.origin,'http://127.0.0.1','only a controlled application endpoint is allowed');
   if(p!=='/health')assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);
   if(method!=='GET'){
    assert.equal(method,'POST');assert.equal(p,'/local-operator/connector-jobs/'+job+'/run-once','no legacy retry or unrelated write is allowed');
    assert.deepEqual(JSON.parse(init.body),{});f.posts.push(p);if(!f.keepFresh)f.cut=cut(kind,'done',true,1);
    if(f.lost)throw TypeError('CONTROLLED_RESPONSE_LOST');return Response.json(f.cut);
   }
   f.reads.push(p);
   if(p==='/health')return Response.json({ordinary_connector_jobs_available:f.available});
   if(p==='/auth/me')return Response.json({restore_preview:false,user:{id:f.principal,tenant_id:tenant,role:'admin',api_key_id:null}});
   if(p==='/local-operator/connector-jobs/'+job){if(f.holdJob){const h=f.holdJob;f.holdJob=null;return h.promise;}return Response.json(f.cut);}
   const provider=kind==='offer.write'?'allegro':kind==='shipping'?'inpost':'dpd';
   const ch={id:channel,name:'Controlled channel',provider,mode:f.mode??'sandbox',settings:{simulation:f.simulation}};
   const row={id:plan,job_id:job,provider,channel_name:ch.name,mode:'sandbox',simulation:String(f.simulation),state:f.state,phase:f.phase,job_state:'pending',created_at:'2026-10-17T00:00:00Z',sku:'TEST-SKU',operation:'sync',payload:{},input:{service:'inpost_locker_standard',receiver:{first_name:'Buyer',last_name:'Test'},weight:1,cod:0,count:1,sender:{city:'Test',address:'Test 1'}},kind:'protocol'};
   if(p==='/integrations/'+channel+'/offers')return Response.json({channel:ch,data:[row],meta:{}});
   if(p==='/orders/'+orderId+'/shipping')return Response.json({data:[row],meta:{}});
   if(p==='/shipping/channels')return Response.json({data:[ch]});
   // Match the real DPD-only GET projection: id,name,mode,settings, with no provider field.
   if(p==='/integrations/'+channel+'/dpd-collections')return Response.json({channel:{id:f.collectionChannelId??ch.id,name:ch.name,mode:ch.mode,settings:ch.settings},data:[row],next:null});
   if(p==='/integrations/'+channel+'/dpd-parcels')return Response.json({data:[],next:null});
   return Response.json({channel:ch,data:[],jobs:[],meta:{},schedule:null});
  };
 }
 function panelProps(name,patch={}){return name==='OffersPanel'?{channelId:channel,connectorContext:context,...patch}:name==='DpdCollections'?{channelId:channel,admin:true,connectorContext:context,...patch}:{order,write:true,admin:true,onChanged:()=>f.changed++,connectorContext:context,...patch};}
 async function mount(name,patch={}){
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  const h={container,root,async render(patch0){await act(async()=>root.render(React.createElement(components[name],panelProps(name,patch0))));},async close(){await act(async()=>root.unmount());container.remove();}};
  handles.push(h);await h.render(patch);await until(()=>container.textContent.includes('Controlled channel')||container.textContent.includes('Paczkomat ·')||!!readButton(h));return h;
 }
 async function prepare(h){await click(readButton(h));await until(()=>!!runButton(h));const checkbox=[...h.container.querySelectorAll('input[type=checkbox]')].find(el=>el.parentElement.textContent.includes('Potwierdzam jedną rzeczywistą próbę'));await click(checkbox);assert(!runButton(h).disabled);}
 try{
  for(const [kind,name]of cases){
   await t.test(kind+': visible row control, explicit exact GET/one POST/GET readback',async()=>{
    reset(kind);const h=await mount(name);assert(readButton(h));assert.equal(f.posts.length,0);assert(!f.reads.some(p=>p.startsWith('/local-operator/connector-jobs/')));
    await prepare(h);await click(runButton(h));await until(()=>h.container.textContent.includes('Zakończone · próby 1/1'));
    assert.equal(f.posts.length,1);assert(f.reads.filter(p=>p==='/local-operator/connector-jobs/'+job).length>=3);assert.equal(runButton(h),undefined);await h.close();
   });
   await t.test(kind+': lost reply stays fenced through parent rerender and remount, only GET can repeat',async()=>{
    reset(kind);f.lost=true;f.keepFresh=true;let h=await mount(name);await prepare(h);await click(runButton(h));await until(()=>h.container.textContent.includes('Nie potwierdzono wyniku próby'));assert.equal(f.posts.length,1);
    await h.render({connectorContext:{...context,externalWriteBlocked:true}});await h.render({connectorContext:context});await click(readButton(h));await until(()=>!readButton(h).disabled);assert.equal(runButton(h),undefined);await h.close();
    h=await mount(name);await click(readButton(h));await until(()=>!readButton(h).disabled);assert.equal(runButton(h),undefined);assert.equal(f.posts.length,1);await h.close();
   });
   await t.test(kind+': read-only, nonadmin, blocked and local simulation do not acquire dispatch',async()=>{
    for(const patch of [{readOnly:true},{admin:false},{externalWriteBlocked:true}]){
     reset(kind);const h=await mount(name,{connectorContext:{...context,...patch}});
     if(patch.externalWriteBlocked){await click(readButton(h));await until(()=>!!runButton(h));assert(runButton(h).disabled);}else assert.equal(readButton(h),undefined);
     assert.equal(f.posts.length,0);await h.close();
    }
    reset(kind);f.simulation=true;const local=await mount(name);assert.equal(readButton(local),undefined);assert.equal(f.posts.length,0);await local.close();
   });
   await t.test(kind+': stale principal response cannot re-enable an execution control',async()=>{
    reset(kind);const h=await mount(name),held=deferred();f.holdJob=held;await click(readButton(h));await until(()=>f.reads.some(p=>p==='/local-operator/connector-jobs/'+job));
    await h.render({connectorContext:{...context,userId:id(99)}});await act(async()=>held.resolve(Response.json(cut(kind))));await tick();assert.equal(runButton(h),undefined);assert.equal(f.posts.length,0);await h.close();
   });
  }
  await t.test('InPost buy and refresh jobs use the same original-job one-shot action',async()=>{
   for(const [state,phase]of [['buy_queued','buy_ready'],['queued','refresh_ready']]){
    reset('shipping');f.state=state;f.phase=phase;f.cut.plan={id:plan,state,phase};
    const h=await mount('ShippingPanel');await prepare(h);await click(runButton(h));await until(()=>f.posts.length===1&&!runButton(h));assert.equal(f.posts.length,1);await h.close();
   }
  });
  await t.test('missing explicit actor context cannot expose an ordinary job action in any panel',async()=>{
   for(const [kind,name]of cases){reset(kind);const h=await mount(name,{connectorContext:undefined});assert.equal(readButton(h),undefined);assert.equal(f.posts.length,0);await h.close();}
  });
  await t.test('shipping write=false keeps exact-job readback but disables execution',async()=>{
   for(const [kind,name]of cases.filter(([k])=>k==='shipping'||k==='shipping.dpd')){
    reset(kind);const h=await mount(name,{write:false});await click(readButton(h));await until(()=>!!runButton(h));assert(runButton(h).disabled);assert.equal(f.posts.length,0);await h.close();
   }
  });
  await t.test('local DPD protocol retains its existing retry path outside ordinary connector mode',async()=>{
   reset('dpd.collection');f.simulation=true;f.state='failed';const h=await mount('DpdCollections');assert(button(h,'Ponów protokół DPD'));assert.equal(readButton(h),undefined);assert.equal(f.posts.length,0);await h.close();
  });
  await t.test('DPD protocol in manual path cannot expose the legacy retry control',async()=>{
   reset('dpd.collection');f.state='failed';f.phase='ready';f.cut=cut(f.kind,'failed',true,1);const h=await mount('DpdCollections');assert(readButton(h));assert.equal(button(h,'Ponów protokół DPD'),undefined);assert.equal(f.posts.length,0);await h.close();
  });
  await t.test('DPD collection manual control requires its exact channel DTO and sandbox mode',async()=>{
   for(const mismatch of [{collectionChannelId:id(99)},{mode:'live'}]){
    reset('dpd.collection');Object.assign(f,mismatch);const h=await mount('DpdCollections');
    assert.equal(readButton(h),undefined);assert.equal(f.posts.length,0);await h.close();
   }
  });
  await t.test('DPD failed protocol outside ordinary connector context retains legacy retry with genuine DTO',async()=>{
   reset('dpd.collection');f.state='failed';const h=await mount('DpdCollections',{connectorContext:undefined});
   assert(button(h,'Ponów protokół DPD'));assert.equal(readButton(h),undefined);assert.equal(f.posts.length,0);await h.close();
  });
 }finally{
  for(const h of handles)try{await h.close();}catch{}
  await vite.close();globalThis.fetch=originalFetch;dom.window.close();for(const [k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
 }
});
