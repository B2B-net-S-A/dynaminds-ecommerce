/** Actual PaymentsPanel + shared workspace api, controlled HTTP/React DOM.
 * No real payment, PG, browser or durable lost-ACK recovery acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>n.toString(16).padStart(8,'0')+'-1000-4000-8000-000000000001',tenant=id(1),order=id(2);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const entry=(n,reference)=>({id:id(n),kind:'receipt',amount:100,fee:0,method:'bank_transfer',reference,note:'',created_at:'2026-10-18T02:00:00Z',reversed:false});
const ledger=(reference,next=null)=>({data:[entry({NEW:20,OLD:21,BASE:22,OLDER:23,OLDER_NEW:24}[reference],reference)],next});
const source=version=>({id:order,tenant_id:tenant,version,currency:'PLN',payment_mode:'prepaid',shipments:[],payment:{received:0,amount_due:100,overpayment:0,refunded:0}});
test('payment history read lifetime follows current scope and acknowledged mutation',async t=>{
 const dom=new JSDOM('<body/>',{url:'http://127.0.0.1/'}),prior=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{PaymentsPanel}=await vite.ssrLoadModule(path.resolve('web/payments.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts')),{createRoot}=await import('react-dom/client');
 const roots=new Set();let requests=[],handler,changed=0;
 function reset(fn){requests=[];handler=fn;changed=0;api.setWorkspace(tenant);globalThis.fetch=async(url,init={})=>{const request={url,method:init.method,signal:init.signal,body:init.body?JSON.parse(init.body):null};requests.push(request);assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);return handler(request);};}
 async function mount(){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);roots.add(root);let props={order:source('7'),write:true,admin:true,onChanged:()=>changed++};const h={el,async render(patch={}){props={...props,...patch};await act(async()=>root.render(React.createElement(PaymentsPanel,props)));},async close(){await act(async()=>root.unmount());roots.delete(root);el.remove();}};await h.render();return h;}
 const button=(h,label)=>[...h.el.querySelectorAll('button')].find(b=>b.textContent.includes(label));
 const click=async(h,label)=>{const b=button(h,label);assert(b&&!b.disabled,label);await act(async()=>b.click());};
 async function submit(h){await click(h,'Dodaj potwierdzenie');h.el.querySelector('[name="reference"]').value='Original payment';h.el.querySelector('[name="confirmed"]').checked=true;await act(async()=>h.el.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}
 try{
  await t.test('readonly overrides write/admin while preserving local history and older-page GET',async()=>{
   reset(r=>{assert.equal(r.method,'GET');return Response.json(r.url.includes('?before=')?ledger('OLDER'):ledger('BASE',id(100)));});const h=await mount();await h.render({readOnly:true,write:true,admin:true});
   assert.match(h.el.textContent,/BASE/);assert.equal(button(h,'Dodaj potwierdzenie'),undefined);assert.equal(button(h,'Koryguj'),undefined);assert.equal(h.el.querySelector('form'),null);await click(h,'Starsze potwierdzenia');assert.match(h.el.textContent,/OLDER/);assert(requests.every(r=>r.method==='GET'));await h.close();
  });
  await t.test('switching to readonly hides an open mutation and ignores its late ACK',async()=>{
   const post=deferred();let reads=0;reset(r=>r.method==='POST'?post.promise:Response.json(ledger(++reads===1?'BASE':'NEW')));const h=await mount();await submit(h);await h.render({readOnly:true});assert.equal(h.el.querySelector('form'),null);assert.match(h.el.textContent,/NEW/);await act(async()=>post.resolve(Response.json({...ledger('OLD'),reused:false,payment_entry_id:id(21)})));assert.match(h.el.textContent,/NEW/);assert.doesNotMatch(h.el.textContent,/OLD/);assert.equal(changed,0);assert.equal(button(h,'Koryguj'),undefined);await h.close();
  });
  await t.test('slow initial GET cannot replace an acknowledged atomic POST before parent changes version',async()=>{
   const old=deferred();reset(r=>r.method==='POST'?Response.json({...ledger('NEW'),reused:false,payment_entry_id:id(20)}):old.promise);const h=await mount();await submit(h);assert.match(h.el.textContent,/NEW/);assert.equal(changed,1);await act(async()=>old.resolve(Response.json(ledger('OLD'))));assert.match(h.el.textContent,/NEW/);assert.doesNotMatch(h.el.textContent,/OLD/);await h.close();
  });
  await t.test('same-turn submit then older-page click cannot start a read during the write or overwrite its ACK',async()=>{
   const post=deferred(),older=deferred();reset(r=>r.method==='POST'?post.promise:r.url.includes('?before=')?older.promise:Response.json(ledger('BASE',id(100))));const h=await mount();await click(h,'Dodaj potwierdzenie');h.el.querySelector('[name="reference"]').value='Original payment';h.el.querySelector('[name="confirmed"]').checked=true;
   await act(async()=>{h.el.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));button(h,'Starsze potwierdzenia').click();});
   assert.equal(requests.filter(r=>r.method==='POST').length,1);assert.equal(requests.filter(r=>r.url.includes('?before=')).length,0,'synchronous write latch precedes React busy render');
   await act(async()=>post.resolve(Response.json({...ledger('NEW'),reused:false,payment_entry_id:id(20)})));await act(async()=>older.resolve(Response.json(ledger('OLD'))));assert.match(h.el.textContent,/NEW/);assert.doesNotMatch(h.el.textContent,/OLD/);assert.equal(changed,1);await h.close();
  });
  await t.test('old first page response cannot replace a new order version history',async()=>{
   const old=deferred();let reads=0;reset(()=>++reads===1?old.promise:Response.json(ledger('NEW')));const h=await mount();await h.render({order:source('8')});assert.match(h.el.textContent,/NEW/);await act(async()=>old.resolve(Response.json(ledger('OLD'))));assert.match(h.el.textContent,/NEW/);assert.doesNotMatch(h.el.textContent,/OLD/);await h.close();
  });
  await t.test('old pagination result/finally cannot replace refreshed history or unlock its new in-flight page',async()=>{
   const old=deferred(),fresh=deferred();let reads=0;reset(r=>r.url.includes('?before=')?(r.url.includes(id(100))?old.promise:fresh.promise):Response.json(++reads===1?ledger('BASE',id(100)):ledger('NEW',id(101))));const h=await mount();await click(h,'Starsze potwierdzenia');await h.render({order:source('8')});await click(h,'Starsze potwierdzenia');assert.equal(button(h,'Starsze potwierdzenia').disabled,true);await act(async()=>old.resolve(Response.json(ledger('OLD'))));assert.match(h.el.textContent,/NEW/);assert.doesNotMatch(h.el.textContent,/OLD/);assert.equal(button(h,'Starsze potwierdzenia').disabled,true);await act(async()=>fresh.resolve(Response.json(ledger('OLDER_NEW'))));assert.match(h.el.textContent,/NEW/);assert.match(h.el.textContent,/OLDER_NEW/);assert.equal(button(h,'Starsze potwierdzenia'),undefined);await h.close();
  });
  await t.test('same-turn repeated older-page clicks dispatch only one GET and append once',async()=>{
   const page=deferred();reset(r=>r.url.includes('?before=')?page.promise:Response.json(ledger('BASE',id(100))));const h=await mount();await act(async()=>{const b=button(h,'Starsze potwierdzenia');b.click();b.click();});assert.equal(requests.filter(r=>r.url.includes('?before=')).length,1);await act(async()=>page.resolve(Response.json(ledger('OLDER'))));assert.equal([...h.el.querySelectorAll('small')].filter(e=>e.textContent==='OLDER').length,1);await h.close();
  });
  await t.test('late old-scope error never paints an alert on current history; old requests are aborted',async()=>{
   const old=deferred();let reads=0;reset(()=>++reads===1?old.promise:Response.json(ledger('NEW')));const h=await mount();const previous=requests[0];await h.render({order:source('8')});assert.equal(previous.signal?.aborted,true);await act(async()=>old.reject(Error('OLD_SCOPE_ERROR')));assert.equal(h.el.querySelector('[role="alert"]'),null);assert.match(h.el.textContent,/NEW/);await h.close();
  });
  await t.test('late POST ACK cannot close the current-version form or notify its parent after a scope refresh',async()=>{
   const post=deferred();let reads=0;reset(r=>r.method==='POST'?post.promise:Response.json(ledger(++reads===1?'BASE':'NEW')));const h=await mount();try{await submit(h);assert.equal(requests.filter(r=>r.method==='POST').length,1);
   await h.render({order:source('8')});assert.match(h.el.textContent,/NEW/);assert(h.el.querySelector('form'));
   await act(async()=>post.resolve(Response.json({...ledger('OLD'),reused:false,payment_entry_id:id(21)})));
   assert(h.el.querySelector('form'),'previous-version ACK must not close the current form');assert.equal(changed,0,'previous-version ACK must not notify the current scope');assert.match(h.el.textContent,/NEW/);assert.doesNotMatch(h.el.textContent,/OLD/);}finally{await h.close();}
  });
  await t.test('late POST error cannot paint an alert after the mounted panel receives another order',async()=>{
   const post=deferred();let reads=0;reset(r=>r.method==='POST'?post.promise:Response.json(ledger(++reads===1?'BASE':'NEW')));const h=await mount();try{await submit(h);await h.render({order:{...source('1'),id:id(30)}});assert.match(h.el.textContent,/NEW/);
   await act(async()=>post.reject(Error('PREVIOUS_ORDER_WRITE_FAILURE')));assert.equal(Boolean(h.el.querySelector('[role="alert"]')),false,'previous-order error must not paint an alert');assert.equal(changed,0);assert.match(h.el.textContent,/NEW/);assert.equal(requests.filter(r=>r.method==='POST').length,1);}finally{await h.close();}
  });
  await t.test('ordinary older mutation DTO remains display-compatible without inventing freshness or retry',async()=>{
   reset(r=>Response.json(ledger(r.method==='POST'?'NEW':'BASE')));const h=await mount();await submit(h);assert.match(h.el.textContent,/NEW/);assert.equal(requests.filter(r=>r.method==='POST').length,1);assert.equal(changed,1);assert.equal(h.el.querySelector('form'),null);await h.close();
  });
 }finally{for(const root of roots)await act(async()=>root.unmount());await vite.close();globalThis.fetch=oldFetch;for(const[k,d]of prior){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
