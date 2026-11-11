import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant=id(1),user=id(2),channel=id(3),warehouse=id(4),listing=id(5),context=tenant+':'+user;
const metadata=()=>({channels:[{id:channel,name:'Sklep A',fixture_id:id(6),owner_id:user,enrolled:true,listings:[{id:listing,product_id:id(7),sku:'FIZ-1',warehouse_id:warehouse}]}],smtp_channels:[{id:id(8),name:'Odbiornik .test'}],warehouses:[{id:warehouse,name:'Główny'}],processor_running:true,listings_truncated:false});
const effect=(extra={})=>({type:'sync_local_woo_stock',state:'done',channel_id:channel,listing_id:listing,job_id:id(9),verified_stock:0,created_at:'2026-10-16T10:00:00Z',outcome:'VERIFIED',parent_acknowledged:true,reconciliation_required:false,automatic_retry:false,...extra});
test('Automation local effects: actual React with controlled API, no provider/DB/listener',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client'),ui=await vite.ssrLoadModule(path.resolve('web/automation-local-effects.tsx')),ops=await vite.ssrLoadModule(path.resolve('web/operations.tsx')),worker=await vite.ssrLoadModule(path.resolve('web/local-automation-worker-control.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 let handles=[],calls=[],response=metadata(),pending;
 function reset(){api.setWorkspace(tenant);calls=[];response=metadata();pending=null;globalThis.fetch=async(url,init={})=>{assert.equal(init.method,'GET');const p=String(url);calls.push(p);if(p.endsWith('/email/templates'))return Response.json({data:[{id:id(10),name:'Test email',active:true,version:'1'}]});assert(p.endsWith('/automations/local-effects/options'));if(pending)return pending;return Response.json(response);};}
 async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
 async function until(fn,note){for(let n=0;n<60;n++){if(fn())return;await tick();}assert(fn(),note);}
 async function mount(Component,props){const el=document.createElement('div');document.body.append(el);const root=createRoot(el),h={el,async render(next){await act(async()=>root.render(React.createElement(Component,next)));},async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);await h.render(props);return h;}
 async function choose(h,label,v){const e=h.el.querySelector(`select[aria-label="${label}"]`);assert(e&&!e.disabled,label);await act(async()=>{e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));});}
 try{
  await t.test('automatic stock selects owned store/warehouse/all items, removes stale channel hash and listing',async()=>{
   reset();let value={type:'sync_local_woo_stock',channel_id:channel,warehouse_id:warehouse,listing_id:listing,channel_hash:'a'.repeat(64)},h;const props=()=>({contextKey:context,value,onChange(next){value=next;}});h=await mount(ui.LocalWooStockActionFields,props());await until(()=>h.el.textContent.includes('FIZ-1'),'metadata');await choose(h,'Oferta akcji stanu','');assert.equal(value.listing_id,undefined);assert(!Object.hasOwn(value,'channel_hash'));assert.equal(value.channel_id,channel);assert.equal(value.warehouse_id,warehouse);assert(h.el.textContent.includes('bez ceny'));assert.deepEqual(calls,['/api/automations/local-effects/options']);await h.close();
  });
  await t.test('context switch immediately hides prior options and ignores late old response',async()=>{
   reset();let resolve;pending=new Promise(r=>resolve=r);const h=await mount(ui.LocalWooStockActionFields,{contextKey:context,value:{type:'sync_local_woo_stock'},onChange(){}});await until(()=>calls.length===1,'first request');pending=null;response={...metadata(),channels:[],smtp_channels:[],warehouses:[]};await h.render({contextKey:tenant+':'+id(20),value:{type:'sync_local_woo_stock'},onChange(){}});resolve(Response.json(metadata()));await until(()=>h.el.textContent.includes('Brak podłączonego'),'new scope');assert(!h.el.textContent.includes('Sklep A'));await h.close();
  });
  await t.test('real ActionEditor exposes stock only for automations; email defaults local SMTP options',async()=>{
   reset();let value={type:'add_note',note:''};const h=await mount(ops.ActionEditor,{value,statuses:[],onChange:v=>value=v});assert(!h.el.textContent.includes('Synchronizuj stan lokalnego Woo'));await h.render({value,statuses:[],localEffectsContext:context,onChange:v=>value=v});await choose(h,'Rodzaj akcji','email');assert.equal(value.mode,'smtp');assert.equal(value.confirm_external,false);await h.render({value,statuses:[],localEffectsContext:context,onChange:v=>value=v});await until(()=>h.el.textContent.includes('Odbiornik .test'),'safe SMTP metadata');assert(!calls.includes('/api/integrations'));assert(!h.el.textContent.includes('wysyłka zewnętrzna'));await h.close();
  });
  await t.test('verified zero stock remains separate from unacknowledged parent, unknown never shows success or retry',async()=>{
   reset();const h=await mount(ui.AutomaticEffects,{effects:[effect({parent_acknowledged:false}),effect({job_id:id(11),outcome:'UNKNOWN_WRITE_OR_ACK',verified_stock:null,reconciliation_required:true}),effect({type:'email',state:'smtp_accepted',listing_id:null,job_id:id(12),verified_stock:null,outcome:'SMTP_ACCEPTED_NOT_DELIVERED'})]});assert(h.el.textContent.includes('Potwierdzony stan: 0'));assert(h.el.textContent.includes('Brak potwierdzenia zadania nadrzędnego'));assert(h.el.textContent.includes('doręczenie nie jest potwierdzone'));assert(h.el.textContent.includes('niepewny'));assert.equal(h.el.querySelectorAll('button').length,0);assert.equal(calls.length,0);await h.close();
  });
  await t.test('malformed effect is read-only warning; metadata rejects foreign owner, duplicate, foreign warehouse and excess listings',async()=>{
   reset();const h=await mount(ui.AutomaticEffects,{effects:[effect({automatic_retry:true})]});assert(h.el.textContent.includes('Nie można potwierdzić'));assert.equal(h.el.querySelectorAll('button').length,0);await h.close();
   assert.equal(ui.readLocalEffectOptions(metadata(),context).channels.length,1);
   for(const mutate of [m=>m.channels[0].owner_id=id(20),m=>m.channels.push(m.channels[0]),m=>m.channels[0].listings[0].warehouse_id=id(21),m=>m.channels[0].listings.push(m.channels[0].listings[0]),m=>m.processor_running='true']){const m=metadata();mutate(m);assert.throws(()=>ui.readLocalEffectOptions(m,context));}
   for(const bad of [effect({verified_stock:-1}),effect({verified_stock:null}),effect({type:'email'}),effect({outcome:'DELIVERED'})])assert.throws(()=>ui.readAutomaticEffects([bad]));
  });
  await t.test('contradictory email outcome is refused; safe fixed error cause is shown without raw backend text',async()=>{
   reset();const email=effect({type:'email',state:'uncertain',listing_id:null,verified_stock:null,outcome:'SMTP_ACCEPTED_NOT_DELIVERED',reconciliation_required:true,parent_acknowledged:false,error_code:'AUTOMATION_EMAIL_FAILED',error_message:'SYNTHETIC_PRIVATE_BACKEND_TEXT'});
   assert.throws(()=>ui.readAutomaticEffects([email]));const h=await mount(ui.AutomaticEffects,{effects:[email]});assert(h.el.textContent.includes('Nie można potwierdzić'));assert(!h.el.textContent.includes('SMTP przyjął'));assert(!h.el.textContent.includes('SYNTHETIC_PRIVATE_BACKEND_TEXT'));
   await h.render({effects:[{...email,outcome:'UNKNOWN_WRITE_OR_ACK'}]});assert(h.el.textContent.includes('Sprawdź odbiornik i źródłową regułę'));assert(!h.el.textContent.includes('SYNTHETIC_PRIVATE_BACKEND_TEXT'));assert.equal(h.el.querySelectorAll('button').length,0);
   for(const [state,outcome]of [['smtp_accepted','SMTP_ACCEPTED_NOT_DELIVERED'],['uncertain','UNKNOWN_WRITE_OR_ACK'],['failed','FAILED_BEFORE_DISPATCH'],['queued','ATTEMPTED_RECONCILIATION_REQUIRED'],['queued','PENDING'],['simulated','PENDING'],['cancelled','PENDING']])assert.equal(ui.readAutomaticEffects([{...email,state,outcome}]).length,1);
   for(const bad of [{...email,state:'smtp_accepted',outcome:'UNKNOWN_WRITE_OR_ACK'},{...email,state:'failed',outcome:'SMTP_ACCEPTED_NOT_DELIVERED'},{...email,state:'queued',outcome:'VERIFIED'},{...email,state:'smtp_accepted',listing_id:listing},{...email,state:'arbitrary',outcome:'PENDING'},effect({outcome:'UNKNOWN_WRITE_OR_ACK',verified_stock:5}),effect({error_code:'UNTRUSTED_PRIVATE_CODE'})])assert.throws(()=>ui.readAutomaticEffects([bad]));
   // Child verification can succeed even if the parent acknowledgement failed.
   await h.render({effects:[effect({state:'failed',parent_acknowledged:false,error_code:'AUTOMATION_STOCK_CHANGED',error_message:'RAW_SQL_PRIVATE'})]});assert(h.el.textContent.includes('Potwierdzony stan: 0'));assert(h.el.textContent.includes('Stan lub dane produktu zmieniły się'));assert(!h.el.textContent.includes('RAW_SQL_PRIVATE'));await h.close();
  });
  await t.test('worker supported predicate matches stage/local stock/local SMTP; external opt-in and SMS stay unsupported',()=>{
   const rule=actions=>({trigger:'order.created',definition:{actions}});for(const a of [{type:'set_status',status:'picking'},{type:'sync_local_woo_stock',channel_id:channel,warehouse_id:warehouse},{type:'email',mode:'smtp',confirm_external:false}])assert(worker.supportsLocalAutomaticRule(rule([a])));
   for(const a of [{type:'email',mode:'smtp',confirm_external:true},{type:'email',mode:'local'},{type:'sms',mode:'local'}])assert(!worker.supportsLocalAutomaticRule(rule([a])));assert(!worker.supportsLocalAutomaticRule({...rule([{type:'add_note'}]),trigger:'customer_message.received'}));
  });
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
