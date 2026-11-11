import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';
const tenant='00000001-1000-4000-8000-000000000001';
const at=new Date(Date.now()-3600_000).toISOString();
const item=(domain,resolve,patch={})=>({domain,resolve,id:domain+'-1',order_id:null,order_number:null,label:'Etykieta '+domain,error:null,at,...patch});
test('ReconciliationQueue: counts per kind, each row says where to resolve it, empty and error states',async()=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client');
 const {ReconciliationQueue}=await vite.ssrLoadModule(path.resolve('web/reconciliation-queue.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 let value,status=200;const calls=[];
 globalThis.fetch=async(url)=>{calls.push(String(url).slice(4));return status===200?Response.json(value):Response.json({status,detail:'Kolejkę do uzgodnienia widzi administrator lub operator'},{status});};
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<50&&!fn();i++)await tick();assert(fn(),el.textContent);}
 const render=refresh=>React.act(async()=>root.render(React.createElement(ReconciliationQueue,{refresh})));
 try{
  api.setWorkspace(tenant);
  value={generated_at:new Date().toISOString(),counts:{sms:1,email:0,dpd_collection:1,shipping:1,invoice:0,order_status:0,offer:1},truncated:false,fulfillment_note:'Realizacje Shopify, Amazon i eBay mają własną kolejkę: Integracje → Problemy operacji.',
   items:[item('sms','decide',{order_id:'o1',order_number:'ZAM-7',error:'Brak odpowiedzi SMSAPI'}),item('shipping','order_detail',{order_id:'o2',order_number:'ZAM-8',label:'Przesyłka dpd'}),item('dpd_collection','dpd_collections'),item('offer','offers')]};
  await render(0);
  await until(()=>el.textContent.includes('Do uzgodnienia'));
  assert.equal(calls[0],'/operations/reconciliation-queue');
  assert.match(el.textContent,/4 skutki o nieznanym wyniku/);
  assert.match(el.textContent,/SMS: 1/);
  assert.doesNotMatch(el.textContent,/Faktury: 0/,'empty kinds are not listed');
  const row=d=>el.querySelector(`tr[data-domain="${d}"]`).textContent;
  assert.match(row('sms'),/ZAM-7/);
  assert.match(row('sms'),/Brak odpowiedzi SMSAPI/);
  assert.match(row('sms'),/Sprawdź wynik u dostawcy/);
  assert.match(row('shipping'),/Karta zamówienia ZAM-8/);
  assert.match(row('dpd_collection'),/Integracje → DPD/);
  assert.match(row('offer'),/Integracje → Oferty/);
  assert.match(el.textContent,/Problemy operacji/);
  value={...value,counts:{},items:[]};
  await render(1);
  await until(()=>el.textContent.includes('Nic nie czeka na uzgodnienie'));
  status=403;await render(2);
  await until(()=>el.textContent.includes('Kolejkę do uzgodnienia widzi administrator lub operator'));
 }finally{await React.act(async()=>root.unmount());el.remove();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
test('ReconciliationQueue: an SMS decision "not sent", then one new send under its own approval',async()=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client');
 const {ReconciliationQueue}=await vite.ssrLoadModule(path.resolve('web/reconciliation-queue.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const queue={generated_at:at,counts:{sms:1,email:1},truncated:false,items:[item('sms','decide',{id:'s-1',order_number:'ZAM-7',label:'SMS 48500600700'}),item('email','decide',{id:'e-1',label:'Email ZAM-9'})]};
 const posts=[],reply={};
 globalThis.fetch=async(url,init={})=>{const p=String(url).slice(4);if(init.method==='POST'){const body=JSON.parse(init.body);posts.push([p,body]);const r=reply[p];return r?.status?Response.json(r,{status:r.status}):Response.json(r??{});}return Response.json(queue);};
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 const act=React.act,tick=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<50&&!fn();i++)await tick();assert(fn(),el.textContent);}
 const button=t=>[...el.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
 const click=b=>act(async()=>{b.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));});
 async function set(e,v){await act(async()=>{const proto=e.tagName==='SELECT'?window.HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,v);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
 async function submit(){const f=el.querySelector('section[aria-label="Wynik wiadomości"] form');assert.equal(button('Zapisz decyzję').disabled,true,'the consent box gates the decision');await click(f.querySelector('input[name=confirmed]'));assert.equal(button('Zapisz decyzję').disabled,false);await act(async()=>{f.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));});}
 try{
  api.setWorkspace(tenant);
  await act(async()=>root.render(React.createElement(ReconciliationQueue,{refresh:0})));
  await until(()=>el.querySelector('tr[data-domain="sms"]'));
  assert.equal(el.querySelectorAll('tr button').length,2,'each sms/email row has its decision button');
  // "sent" with the provider reference, then the panel closes.
  await click(el.querySelector('tr[data-domain="email"] button'));
  await until(()=>el.textContent.includes('Wynik sprawdzony u dostawcy: Email ZAM-9'));
  await set(el.querySelector('input[name=provider_ref]'),'<id-9@example.test>');
  await set(el.querySelector('textarea[name=evidence]'),'Log SMTP konta, 27.10 12:00');
  await submit();
  await until(()=>posts.length===1&&!el.textContent.includes('Wynik sprawdzony u dostawcy'));
  assert.deepEqual(posts[0],['/operations/reconciliation-queue/email/e-1/decision',{outcome:'sent',evidence:'Log SMTP konta, 27.10 12:00',confirmed:true,provider_ref:'<id-9@example.test>'}]);
  // "not sent": no provider reference, then a retry preview with one key, then its own approval.
  await click(el.querySelector('tr[data-domain="sms"] button'));
  await until(()=>el.textContent.includes('Wynik sprawdzony u dostawcy: SMS 48500600700'));
  await set(el.querySelector('select[name=outcome]'),'not_sent');
  assert.equal(el.querySelector('input[name=provider_ref]'),null,'no reference for "not sent"');
  await set(el.querySelector('textarea[name=evidence]'),'Panel SMSAPI: brak wiadomości');
  await submit();
  await until(()=>el.textContent.includes('Zapisano: nie wysłano'));
  assert.deepEqual(posts[1],['/operations/reconciliation-queue/sms/s-1/decision',{outcome:'not_sent',evidence:'Panel SMSAPI: brak wiadomości',confirmed:true}]);
  reply['/operations/reconciliation-queue/sms/s-1/retry']={status:409,detail:'Szablon zmienił się; przygotuj nowy podgląd'};
  await click(button('Przygotuj ponowną wysyłkę'));
  await until(()=>el.textContent.includes('Szablon zmienił się'));
  reply['/operations/reconciliation-queue/sms/s-1/retry']={id:'b-2',mode:'local',items:[{id:'s-2',state:'draft',recipient:'48500600700'}]};
  await click(button('Przygotuj ponowną wysyłkę'));
  await until(()=>el.textContent.includes('Podgląd nowej wysyłki do 48500600700'));
  assert.equal(posts[2][1].client_key,posts[3][1].client_key,'a repeated click reuses one idempotency key');
  assert.match(posts[2][1].client_key,/^[0-9a-f-]{36}$/);
  assert.equal(button('Wyślij ponownie').disabled,false);
  reply['/sms/batches/b-2/queue']={id:'b-2',state:'queued'};
  await click(button('Wyślij ponownie'));
  await until(()=>el.textContent.includes('Nowa wysyłka jest w kolejce'));
  assert.deepEqual(posts[4],['/sms/batches/b-2/queue',{confirmed:true}]);
  assert.equal(posts.length,5,'nothing else was sent');
 }finally{await React.act(async()=>root.unmount());el.remove();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
test('MessageOutcomeDecision: a live SMS retry needs the external-send consent',async()=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client');
 const {MessageOutcomeDecision}=await vite.ssrLoadModule(path.resolve('web/message-outcome.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const posts=[];
 globalThis.fetch=async(url,init={})=>{const p=String(url).slice(4),body=JSON.parse(init.body);posts.push([p,body]);return Response.json(p.endsWith('/retry')?{id:'b-3',mode:'provider_live',items:[{id:'s-3',state:'draft',recipient:'48500600700'}]}:{});};
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 const act=React.act,tick=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<50&&!fn();i++)await tick();assert(fn(),el.textContent);}
 const button=t=>[...el.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
 const click=b=>act(async()=>{b.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));});
 try{
  api.setWorkspace(tenant);
  await act(async()=>root.render(React.createElement(MessageOutcomeDecision,{item:{domain:'sms',id:'s-1',label:'SMS live'},onClose(){},onDecided(){}})));
  await act(async()=>{const s=el.querySelector('select[name=outcome]');Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(s,'not_sent');s.dispatchEvent(new Event('change',{bubbles:true}));const t=el.querySelector('textarea');Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(t,'Panel SMSAPI: brak wiadomości');t.dispatchEvent(new Event('input',{bubbles:true}));});
  await click(el.querySelector('input[name=confirmed]'));
  await act(async()=>{el.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));});
  await until(()=>button('Przygotuj ponowną wysyłkę'));
  await click(button('Przygotuj ponowną wysyłkę'));
  await until(()=>button('Wyślij ponownie'));
  assert.equal(button('Wyślij ponownie').disabled,true,'external send waits for its consent');
  await click(el.querySelector('section input[type=checkbox]'));
  await until(()=>!button('Wyślij ponownie').disabled);
  await click(button('Wyślij ponownie'));
  await until(()=>posts.length===3);
  assert.deepEqual(posts[2],['/sms/batches/b-3/queue',{confirmed:true,confirm_external:true}]);
 }finally{await React.act(async()=>root.unmount());el.remove();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
