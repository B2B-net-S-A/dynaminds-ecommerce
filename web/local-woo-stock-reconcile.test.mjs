/** Actual React and API client with controlled fetch, no listener/DB/Woo. */
import test from 'node:test';import assert from 'node:assert/strict';import React,{act} from 'react';import {JSDOM} from 'jsdom';import {createServer} from 'vite';import path from 'node:path';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,tenant=id(1),user=id(2),channel=id(3),dispatch=id(10),job=id(11),plan=id(12);
const props=(patch={})=>({tenantId:tenant,userId:user,channelId:channel,admin:true,readOnly:false,...patch});
const summary=(patch={})=>({channel_id:channel,dispatch_id:dispatch,job_id:job,kind:'offer.write',plan_id:plan,job_state:'running',plan_state:'queued',plan_phase:'write_started',remote_id:'42',parent_external_id:null,...patch});
const failure=(patch={})=>({status:'RETAINED_FAILURE',phase:'after_write',detected_at:'2026-10-30T10:00:00.000Z',dispatch_id:dispatch,job_id:job,kind:'offer.write',error_category:'ERROR',error_class:'TypeError',sqlstate:null,http_status:null,provider_http_status:null,error_fingerprint:'f'.repeat(64),plan_phase:'write_started',provider_requests:2,provider_writes:1,failure_handler_failed:false,automatic_retry:false,source:'audit',...patch});
const status=(patch={})=>({scope:'selected_local_stock',provider_verified:false,channel_id:channel,blocked:false,reconciliation_required:true,in_progress:false,dispatch:summary(),diagnostic:failure(),automatic_retry:false,processor_running:true,...patch});
const idle=(patch={})=>status({reconciliation_required:false,dispatch:null,diagnostic:null,...patch});
const preview=(patch={})=>({status:'LOCAL_WOO_STOCK_RECONCILIATION_PREVIEW',...summary(),planned:{manage_stock:true,stock_quantity:7,backorders:'no'},observed:{manage_stock:true,stock_quantity:7,backorders:'no'},observation_sha256:'a'.repeat(64),observation_error:null,matches_plan:true,allowed_outcomes:['EFFECT_CONFIRMED','FAILED'],expected_snapshot_sha256:'e'.repeat(64),diagnostic:failure(),original_outcome:'UNCONFIRMED',operation:'RECONCILE_WITHOUT_RETRY',automatic_retry:false,...patch});
const differs=(patch={})=>preview({observed:{manage_stock:true,stock_quantity:3,backorders:'no'},observation_sha256:'b'.repeat(64),matches_plan:false,allowed_outcomes:['SUPERSEDED','FAILED'],...patch});
const planState={EFFECT_CONFIRMED:'done',SUPERSEDED:'conflict',FAILED:'failed'};
const ack=(b,patch={})=>({status:'LOCAL_WOO_STOCK_DISPATCH_RECONCILED',channel_id:channel,dispatch_id:b.dispatch_id,job_id:job,plan_id:plan,kind:'offer.write',client_key:b.client_key,outcome:b.outcome,expected_snapshot_sha256:b.expected_snapshot_sha256,observation_sha256:b.observation_sha256,job_state:b.outcome==='FAILED'?'failed':'done',plan_state:planState[b.outcome],original_outcome:'UNCONFIRMED',automatic_retry:false,...patch});
const context=tenant+':'+user,key='dyna:local-woo-stock-reconcile:v1:'+context+':'+channel;
const body=(patch={})=>({client_key:id(50),dispatch_id:dispatch,expected_snapshot_sha256:'e'.repeat(64),observation_sha256:'a'.repeat(64),outcome:'EFFECT_CONFIRMED',confirmed:true,...patch});
const marker=(patch={})=>({v:1,context,channel,target:{dispatch_id:dispatch,job_id:job,plan_id:plan,kind:'offer.write'},body:body(),phase:'unknown',...patch});
test('local Woo stock reconciliation: validators and React UI with controlled API',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const lockTails=new Map();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:(k,_opts,fn)=>{const previous=lockTails.get(k)??Promise.resolve(),work=previous.catch(()=>{}).then(fn);lockTails.set(k,work.catch(()=>{}));return work;}}});
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client');
 const ui=await vite.ssrLoadModule(path.resolve('web/local-woo-stock-reconcile.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 let f;const handles=[];
 function reset(){localStorage.clear();api.setWorkspace(tenant);f={calls:[],role:'admin',status:status(),previews:[preview()],missing:false,reconcile:'ok',acks:new Map()};globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url),'http://127.0.0.1'),method=init.method??'GET',b=init.body?JSON.parse(init.body):null;assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);f.calls.push({path:u.pathname,method,body:b});
  if(u.pathname==='/api/auth/me')return Response.json({restore_preview:false,user:{id:user,tenant_id:tenant,role:f.role,api_key_id:null}});
  const base='/api/local-fixtures/woocommerce/channels/'+channel+'/stock-lane';assert(u.pathname.startsWith(base),u.pathname);
  if(f.missing)return Response.json({detail:'Not Found'},{status:404});
  if(method==='GET'&&u.pathname===base)return Response.json(f.status);
  if(method==='GET'&&u.pathname===base+'/reconciliation-preview')return Response.json(f.previews.length>1?f.previews.shift():f.previews[0]);
  if(method==='POST'&&u.pathname===base+'/reconcile/observe'){const a=f.acks.get(b.client_key)??null;return Response.json({status:a?'RECONCILE_RESULT_ACKNOWLEDGED':'RECONCILE_RESULT_UNKNOWN',channel_id:channel,client_key:b.client_key,ack:a,automatic_retry:false});}
  if(method==='POST'&&u.pathname===base+'/reconcile'){
   const m=JSON.parse(localStorage.getItem(key));assert.equal(m.phase,'sent');assert.deepEqual(m.body,b,'exact reconcile body durable BEFORE dispatch');
   if(f.reconcile==='lost')throw Error('response lost');if(f.reconcile===409)return Response.json({detail:'Zmieniony stan zapisu'},{status:409});
   const a=ack(b);f.acks.set(b.client_key,a);f.status=idle();if(f.reconcile==='lostCommitted')throw Error('ACK lost after commit');return Response.json(a);
  }
  throw Error('Unexpected '+method+' '+u.pathname);
 };}
 async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
 async function until(fn){for(let i=0;i<50;i++){if(fn())return;await tick();}assert(fn(),'React did not settle');}
 async function mount(p=props()){const el=document.createElement('div');document.body.append(el);const root=createRoot(el),h={el,async render(v){await act(async()=>root.render(React.createElement(ui.LocalWooStockReconcile,v)));},async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);await h.render(p);return h;}
 const button=(h,text)=>[...h.el.querySelectorAll('button')].find(b=>b.textContent===text);
 async function click(h,text){const b=button(h,text);assert(b&&!b.disabled,text);await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 const settled=h=>!h.el.textContent.includes('Trwa odczyt lub zapis uzgodnienia');
 async function load(h){await click(h,'Odczytaj stan synchronizacji stanów');await until(()=>settled(h));}
 async function open(h){await load(h);await click(h,'Odczytaj stan w WooCommerce');await until(()=>settled(h)&&h.el.querySelector('[aria-label="Podgląd uzgodnienia stanu"]'));}
 async function confirm(h){const cb=h.el.querySelector('[aria-label="Potwierdzam uzgodnienie bez ponawiania zapisu"]');assert(cb&&!cb.disabled);await act(async()=>cb.dispatchEvent(new MouseEvent('click',{bubbles:true})));assert(cb.checked);}
 const reconciles=()=>f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/reconcile'));
 const refuses=(fn,v,...args)=>assert.throws(()=>fn(v,...args));
 try{
  await t.test('status validator accepts own bound status and refuses foreign, retrying or extended DTOs',()=>{
   const s=ui.readLocalWooStockStatus(status(),channel);assert.equal(s.dispatch.dispatch_id,dispatch);assert(!('scope' in s));
   ui.readLocalWooStockStatus(idle(),channel);ui.readLocalWooStockStatus(idle({blocked:true,diagnostic:failure({dispatch_id:null,job_id:null,kind:null,source:'memory'})}),channel);
   ui.readLocalWooStockStatus(status({diagnostic:{status:'NO_RETAINED_CAUSE',dispatch_id:dispatch,automatic_retry:false}}),channel);
   ui.readLocalWooStockStatus(status({dispatch:summary({kind:'offer.sync',plan_id:null,plan_state:null,plan_phase:null,remote_id:null})}),channel);
   for(const bad of[status({channel_id:id(99)}),status({automatic_retry:true}),status({extra:1}),status({scope:'selected_local_reads'}),status({provider_verified:true}),status({dispatch:{...summary(),lease_token:id(77)}}),status({dispatch:summary({channel_id:id(99)})}),status({dispatch:null}),idle({in_progress:true}),status({diagnostic:null}),status({diagnostic:failure({dispatch_id:id(98)})}),status({diagnostic:failure({error_fingerprint:'F'.repeat(64)})}),status({diagnostic:failure({automatic_retry:true})}),status({diagnostic:failure({message:'x'})}),status({diagnostic:failure({error_category:'POSTGRES'})}),status({diagnostic:failure({provider_writes:3})}),idle({diagnostic:failure({source:'memory'})}),status({dispatch:summary({kind:'offer.sync'})})])refuses(ui.readLocalWooStockStatus,bad,channel);
  });
  await t.test('preview validator accepts every server variant and refuses mismatched channel/hash/outcome/extra keys',()=>{
   ui.readLocalWooStockPreview(preview(),channel);ui.readLocalWooStockPreview(differs(),channel);
   ui.readLocalWooStockPreview(preview({observed:null,observation_sha256:null,matches_plan:null,observation_error:{error_category:'HTTP',http_status:502,provider_http_status:503},allowed_outcomes:['FAILED']}),channel);
   ui.readLocalWooStockPreview(preview({plan_state:'done',plan_phase:'done',job_state:'done',allowed_outcomes:['EFFECT_CONFIRMED'],observed:{manage_stock:true,stock_quantity:3,backorders:'no'},matches_plan:false}),channel);
   ui.readLocalWooStockPreview({...preview({kind:'offer.sync',plan_id:null,plan_state:null,plan_phase:null,remote_id:null,planned:null,observed:null,observation_sha256:null,matches_plan:null,allowed_outcomes:['FAILED']})},channel);
   ui.readLocalWooStockPreview({status:'NO_UNACKNOWLEDGED_DISPATCH',channel_id:channel,blocked:false,automatic_retry:false},channel);
   ui.readLocalWooStockPreview({status:'DISPATCH_IN_PROGRESS',...summary(),automatic_retry:false},channel);
   for(const bad of[preview({channel_id:id(99)}),preview({automatic_retry:true}),preview({extra:1}),preview({expected_snapshot_sha256:'x'}),preview({observation_sha256:'A'.repeat(64)}),preview({observation_sha256:null}),preview({matches_plan:false}),preview({allowed_outcomes:['SUPERSEDED','FAILED']}),preview({allowed_outcomes:['FAILED','FAILED']}),preview({allowed_outcomes:['RETRY']}),differs({allowed_outcomes:['EFFECT_CONFIRMED']}),preview({planned:{manage_stock:true,stock_quantity:7,backorders:'notify'}}),preview({observed:{manage_stock:true,stock_quantity:7,backorders:'no',price:'1'}}),preview({kind:'offer.sync',plan_id:null,plan_state:null,plan_phase:null,remote_id:null}),preview({operation:'RETRY'}),preview({diagnostic:failure({dispatch_id:id(98)})}),preview({plan_state:'done',allowed_outcomes:['EFFECT_CONFIRMED','FAILED']}),{status:'NO_UNACKNOWLEDGED_DISPATCH',channel_id:id(99),blocked:false,automatic_retry:false},{status:'DISPATCH_IN_PROGRESS',...summary(),automatic_retry:false,lease_token:id(77)}])refuses(ui.readLocalWooStockPreview,bad,channel);
  });
  await t.test('changed observation or snapshot after the operator decided is refused before any send',()=>{
   const seen=ui.readLocalWooStockPreview(preview(),channel);ui.sameLocalWooStockPreview(seen,preview(),'EFFECT_CONFIRMED');
   for(const fresh of[preview({observation_sha256:'c'.repeat(64)}),preview({expected_snapshot_sha256:'d'.repeat(64)}),preview({dispatch_id:id(97)}),{status:'DISPATCH_IN_PROGRESS',...summary(),automatic_retry:false},preview({allowed_outcomes:['FAILED']})])assert.throws(()=>ui.sameLocalWooStockPreview(seen,fresh,'EFFECT_CONFIRMED'),/Stan zmienił się — odczytaj ponownie/);
   assert.throws(()=>ui.sameLocalWooStockPreview(seen,preview(),'SUPERSEDED'),/Stan zmienił się/);
  });
  await t.test('marker parse keeps only exact own uncertain bodies',()=>{
   assert.equal(ui.readLocalWooStockMarker(null,context,channel),null);assert.deepEqual(ui.readLocalWooStockMarker(JSON.stringify(marker()),context,channel),marker());
   ui.readLocalWooStockMarker(JSON.stringify(marker({body:body({outcome:'FAILED',observation_sha256:null})})),context,channel);
   for(const bad of[marker({context:tenant+':'+id(99)}),marker({channel:id(99)}),marker({phase:'acknowledged'}),marker({extra:1}),marker({body:body({outcome:'FAILED'})}),marker({body:body({observation_sha256:null})}),marker({body:body({confirmed:false})}),marker({body:{...body(),lease_token:id(77)}}),marker({target:{dispatch_id:id(97),job_id:job,plan_id:plan,kind:'offer.write'}}),marker({target:{dispatch_id:dispatch,job_id:job,plan_id:null,kind:'offer.sync'}})])refuses(ui.readLocalWooStockMarker,JSON.stringify(bad),context,channel);
   refuses(ui.readLocalWooStockMarker,'{not json',context,channel);refuses(ui.readLocalWooStockMarker,'x'.repeat(5000),context,channel);
  });
  await t.test('ACK and observation validators bind the exact command',()=>{
   const m=marker(),a=ack(m.body);assert.deepEqual(ui.readLocalWooStockReconcileAck(a,m),a);
   for(const bad of[ack(m.body,{client_key:id(96)}),ack(m.body,{dispatch_id:id(97)}),ack(m.body,{channel_id:id(99)}),ack(m.body,{automatic_retry:true}),ack(m.body,{extra:1}),ack(m.body,{plan_state:'conflict'}),ack(m.body,{job_state:'failed'}),ack(m.body,{observation_sha256:'c'.repeat(64)}),ack(m.body,{outcome:'FAILED'})])refuses(ui.readLocalWooStockReconcileAck,bad,m);
   const observation=(patch={})=>({status:'RECONCILE_RESULT_UNKNOWN',channel_id:channel,client_key:m.body.client_key,ack:null,automatic_retry:false,...patch});
   assert.equal(ui.readLocalWooStockObservation(observation(),m),null);assert.deepEqual(ui.readLocalWooStockObservation(observation({status:'RECONCILE_RESULT_ACKNOWLEDGED',ack:a}),m),a);
   for(const bad of[observation({client_key:id(96)}),observation({automatic_retry:true}),observation({extra:1}),observation({status:'RECONCILE_RESULT_ACKNOWLEDGED'}),observation({ack:a}),observation({status:'RECONCILE_RESULT_ACKNOWLEDGED',ack:ack(m.body,{client_key:id(96)})})])refuses(ui.readLocalWooStockObservation,bad,m);
  });
  await t.test('explicit read only; sanitized diagnostic without hashes, ids or class',async()=>{reset();const h=await mount();assert.equal(f.calls.length,0);await load(h);
   assert(h.el.textContent.includes('Wymaga uzgodnienia'));assert(h.el.textContent.includes('Faza: Po wysłaniu zapisu do WooCommerce.'));assert(h.el.textContent.includes('Wysłane zapisy do WooCommerce: 1.'));
   for(const hidden of['f'.repeat(64),dispatch,job,plan,'TypeError','write_started'])assert(!h.el.textContent.includes(hidden),hidden);assert(!f.calls.some(c=>c.path.endsWith('/reconciliation-preview')));for(let i=0;i<3;i++)await tick();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);await h.close();});
  await t.test('preview, confirm and reconcile: durable body before POST, marker cleared and status reloaded after ACK',async()=>{reset();const h=await mount();await open(h);
   assert(h.el.textContent.includes('Planowany stan: 7 szt.'));assert(h.el.textContent.includes('Stan w WooCommerce: 7 szt.'));assert(h.el.textContent.includes('Uzgodnienie nie ponawia zapisu'));assert(!button(h,'Zastąp aktualnym stanem WooCommerce'));assert(button(h,'Potwierdź skutek zapisu').disabled);
   await confirm(h);await click(h,'Potwierdź skutek zapisu');await until(()=>settled(h)&&h.el.textContent.includes('Uzgodniono'));
   assert.equal(reconciles().length,1);assert.deepEqual({...reconciles()[0].body,client_key:'k'},{client_key:'k',dispatch_id:dispatch,expected_snapshot_sha256:'e'.repeat(64),observation_sha256:'a'.repeat(64),outcome:'EFFECT_CONFIRMED',confirmed:true});
   assert.equal(localStorage.getItem(key),null);assert(h.el.textContent.includes('Brak zapisu wymagającego uzgodnienia.'));assert(!h.el.querySelector('[aria-label="Podgląd uzgodnienia stanu"]'));await h.close();});
  await t.test('FAILED sends a null observation; SUPERSEDED offered only when Woo differs',async()=>{reset();f.previews=[differs()];const h=await mount();await open(h);assert(h.el.textContent.includes('różni się od planu'));assert(!button(h,'Potwierdź skutek zapisu'));await confirm(h);await click(h,'Zakończ bez potwierdzenia');await until(()=>settled(h)&&h.el.textContent.includes('Uzgodniono'));assert.equal(reconciles()[0].body.observation_sha256,null);assert.equal(reconciles()[0].body.outcome,'FAILED');await h.close();});
  await t.test('observation changed since the operator saw it: no POST, clear message',async()=>{reset();f.previews=[preview(),preview({observation_sha256:'c'.repeat(64)})];const h=await mount();await open(h);await confirm(h);await click(h,'Potwierdź skutek zapisu');await until(()=>settled(h)&&h.el.querySelector('[role=alert]'));
   assert.equal(h.el.querySelector('[role=alert]').textContent,'Stan zmienił się — odczytaj ponownie.');assert.equal(reconciles().length,0);assert.equal(localStorage.getItem(key),null);assert(!h.el.querySelector('[aria-label="Podgląd uzgodnienia stanu"]'));await h.close();});
  await t.test('lost response keeps the exact marker across remount; observe recovers the stored ACK without re-sending',async()=>{reset();f.reconcile='lostCommitted';let h=await mount();await open(h);await confirm(h);await click(h,'Potwierdź skutek zapisu');await until(()=>settled(h)&&h.el.querySelector('[role=alert]'));
   const m=JSON.parse(localStorage.getItem(key));assert.equal(m.phase,'unknown');assert.deepEqual(m.body,reconciles()[0].body);await h.close();
   f.status=status();h=await mount();await load(h);assert(button(h,'Odczytaj wynik uzgodnienia'));assert(button(h,'Odczytaj stan w WooCommerce').disabled);
   f.status=idle();await click(h,'Odczytaj wynik uzgodnienia');await until(()=>settled(h)&&h.el.textContent.includes('Uzgodniono'));assert.equal(reconciles().length,1);assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/observe')).at(-1).body,m.body);assert.equal(localStorage.getItem(key),null);await h.close();});
  await t.test('unknown observation keeps marker, offers only explicit discard, never a re-send',async()=>{reset();f.reconcile='lost';const h=await mount();await open(h);await confirm(h);await click(h,'Potwierdź skutek zapisu');await until(()=>settled(h)&&button(h,'Odczytaj wynik uzgodnienia'));
   assert(!button(h,'Porzuć niepotwierdzoną próbę uzgodnienia'));await click(h,'Odczytaj wynik uzgodnienia');await until(()=>settled(h)&&button(h,'Porzuć niepotwierdzoną próbę uzgodnienia'));assert(h.el.querySelector('[role=alert]').textContent.includes('Wynik pozostaje nieznany'));assert.equal(JSON.parse(localStorage.getItem(key)).phase,'unknown');assert.equal(reconciles().length,1);
   const m=JSON.parse(localStorage.getItem(key));await click(h,'Porzuć niepotwierdzoną próbę uzgodnienia');await until(()=>settled(h)&&!button(h,'Odczytaj wynik uzgodnienia'));assert.equal(localStorage.getItem(key),null);assert.deepEqual(JSON.parse(localStorage.getItem(key+':archive:'+m.body.client_key)),m);assert.equal(reconciles().length,1);await h.close();});
  await t.test('server 409 refusal clears the marker and asks to re-read the preview',async()=>{reset();f.reconcile=409;const h=await mount();await open(h);await confirm(h);await click(h,'Potwierdź skutek zapisu');await until(()=>settled(h)&&h.el.querySelector('[role=alert]'));assert(h.el.querySelector('[role=alert]').textContent.includes('odczytaj ponownie podgląd'));assert.equal(localStorage.getItem(key),null);assert(!button(h,'Odczytaj wynik uzgodnienia'));assert.equal(reconciles().length,1);await h.close();});
  await t.test('readonly or revoked admin cannot reconcile; in-progress dispatch offers no preview',async()=>{reset();const h=await mount(props({readOnly:true}));await open(h);assert(h.el.querySelector('[aria-label="Potwierdzam uzgodnienie bez ponawiania zapisu"]').disabled);assert(button(h,'Potwierdź skutek zapisu').disabled);await h.close();
   reset();const r=await mount();await open(r);await confirm(r);f.role='viewer';await click(r,'Potwierdź skutek zapisu');await until(()=>settled(r)&&r.el.querySelector('[role=alert]'));assert.equal(reconciles().length,0);assert.equal(localStorage.getItem(key),null);await r.close();
   reset();f.status=status({in_progress:true});const busy=await mount();await load(busy);assert(busy.el.textContent.includes('Zapis w toku'));assert(!button(busy,'Odczytaj stan w WooCommerce'));await busy.close();});
  await t.test('missing route hides the panel; malformed DTO shows no actions',async()=>{reset();f.missing=true;const h=await mount();await load(h);assert(h.el.textContent.includes('nie jest dostępna w tym uruchomieniu'));assert(!h.el.querySelector('section'));await h.close();
   reset();f.status=status({automatic_retry:true});const bad=await mount();await load(bad);assert(bad.el.querySelector('[role=alert]'));assert(!button(bad,'Odczytaj stan w WooCommerce'));await bad.close();});
  await t.test('identity change hides prior status and preview',async()=>{reset();const h=await mount();await open(h);await h.render(props({userId:id(99)}));assert(!h.el.querySelector('[aria-label="Podgląd uzgodnienia stanu"]'));assert(!h.el.textContent.includes('Wymaga uzgodnienia'));await h.close();});
 }finally{for(const h of handles.splice(0))try{await h.close();}catch{}await vite.close();globalThis.fetch=oldFetch;for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
});
