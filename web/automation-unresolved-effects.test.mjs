/** Actual React parent + shared scoped API with controlled GET responses only.
 * No real HTTP, PG, worker, provider reconciliation or retry acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,tenant=id(1),user=id(2),rule=id(3);
const row=(n,patch={})=>({type:'sync_local_woo_stock',run_id:id(4000+n),job_id:id(n),created_at:new Date(Date.UTC(2026,9,18,10)-n*1000).toISOString(),outcome:'UNKNOWN_WRITE_OR_ACK',parent_acknowledged:false,reconciliation_required:true,effect_plan_id:id(5000+n),effect_job_id:id(6000+n),message_id:null,batch_id:null,...patch});
const page=(data,has_more=false)=>({scope:'ALL_OWN_RULE_RUNS',data,has_more,next_cursor:has_more?(data.at(-1).type==='email'?'email:'+data.at(-1).message_id:'stock:'+data.at(-1).job_id):null});
const first=()=>page(Array.from({length:25},(_,n)=>row(1501+n)),true);
const older=()=>page([row(1700,{type:'email',job_id:null,effect_plan_id:null,effect_job_id:null,message_id:id(8000),batch_id:id(9000),outcome:'ATTEMPTED_RECONCILIATION_REQUIRED'})]);
const status=unresolved_effects=>({rule_id:rule,version:'1',processor_running:true,state:'ENABLED',jobs:[],activation:{enabled:true},reconciliation_required:true,child_effects:[],unresolved_effects});
const props=(patch={})=>({contextKey:tenant+':'+user,rule:{id:rule,actor_id:user,version:'1',enabled:true,trigger:'order.created',definition:{actions:[{type:'add_note',note:'Own'}]}},admin:true,readOnly:false,onChanged(){assert.fail('Read-only navigation must not notify a mutation');},...patch});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('older unresolved effects use explicit authorized GETs and preserve original identities',async t=>{
 const dom=new JSDOM('<body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name,_options,work)=>work()}});
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client'),ui=await vite.ssrLoadModule(path.resolve('web/automation-unresolved-effects.tsx')),{LocalAutomationWorkerControl}=await vite.ssrLoadModule(path.resolve('web/local-automation-worker-control.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const handles=[];let f;
 function reset(){localStorage.clear();api.setWorkspace(tenant);f={calls:[],me:0,demoteAt:0,first:status(first()),older:status(older()),hold:null};globalThis.fetch=async(url,init={})=>{
  assert.equal(init.method,'GET','No POST/retry is permitted');assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);const p=new URL(url,'http://127.0.0.1');f.calls.push(p.pathname+p.search);
  if(p.pathname==='/api/auth/me'){f.me++;return Response.json({restore_preview:false,user:{tenant_id:tenant,id:user,role:f.demoteAt&&f.me>=f.demoteAt?'viewer':'admin'}});}
  assert.equal(p.pathname,'/api/automations/'+rule+'/local-worker');if(p.search){assert.equal([...p.searchParams].length,1);assert.equal(p.searchParams.get('reconciliation_after'),first().next_cursor);return f.hold?f.hold.promise:Response.json(f.older);}return Response.json(f.first);
 };}
 async function mount(Component=LocalAutomationWorkerControl,p=props()){const el=document.createElement('div');document.body.append(el);const root=createRoot(el),h={el,async render(next){await act(async()=>root.render(React.createElement(Component,next)));},async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);await h.render(p);return h;}
 const list=h=>h.el.querySelector('section[aria-label="Pierwotne próby do uzgodnienia"]');
 const button=(h,text)=>[...h.el.querySelectorAll('button')].find(b=>b.textContent===text);
 async function click(h,label){const b=button(h,label);assert(b&&!b.disabled,label);await act(async()=>b.click());}
 async function until(check){for(let n=0;n<50;n++){if(check())return;await act(async()=>{await new Promise(r=>setTimeout(r,0));});}assert(check(),'Controlled DOM did not settle');}
 try{
  await t.test('first status shows original jobs beyond recent details; older click is one GET and never replaces configuration',async()=>{
   reset();f.older={...f.older,version:'999',state:'DISABLED_OR_RULE_CHANGED',activation:{enabled:false}};const h=await mount();assert.equal(f.calls.length,0);await click(h,'Odczytaj status');await until(()=>!!list(h));assert.match(list(h).textContent,new RegExp(id(1501)));assert.match(h.el.textContent,/Niepewne rozpoczęte zadania wymagają uzgodnienia/);assert.deepEqual(f.first.child_effects,[]);assert.equal(f.calls.length,3);
   await click(h,'Starsze próby do uzgodnienia');await until(()=>list(h)?.textContent.includes(id(8000)));assert.equal(f.calls.length,6);assert.match(list(h).textContent,/Nie potwierdzono powiązanego zadania/);assert.match(list(h).textContent,new RegExp(id(9000)));assert.doesNotMatch(list(h).textContent,new RegExp(id(1501)));assert.match(h.el.textContent,/wersja 1/);assert.doesNotMatch(h.el.textContent,/wersja 999/);assert.equal(button(h,'Starsze próby do uzgodnienia'),undefined);await h.close();
  });
  await t.test('same-turn repeated page clicks share one in-flight read; there is no automatic continuation',async()=>{
   reset();f.hold=deferred();const h=await mount();await click(h,'Odczytaj status');await until(()=>!!list(h));await act(async()=>{const b=button(h,'Starsze próby do uzgodnienia');b.click();b.click();});await until(()=>f.calls.some(p=>p.includes('?')));assert.equal(f.calls.filter(p=>p.includes('?')).length,1);assert(button(h,'Starsze próby do uzgodnienia').disabled);await act(async()=>f.hold.resolve(Response.json(status(older()))));await until(()=>list(h)?.textContent.includes(id(8000)));assert.equal(f.calls.length,6);await h.close();
  });
  await t.test('late page and fresh IAM refusal hide the earlier principal list without a POST',async()=>{
   reset();f.hold=deferred();const h=await mount();await click(h,'Odczytaj status');await until(()=>!!list(h));await click(h,'Starsze próby do uzgodnienia');await until(()=>f.calls.some(p=>p.includes('?')));api.setWorkspace(id(20));await h.render(props({contextKey:id(20)+':'+user}));assert.equal(Boolean(list(h)),false);await act(async()=>f.hold.resolve(Response.json(status(older()))));assert.equal(Boolean(list(h)),false);assert.doesNotMatch(h.el.textContent,new RegExp(id(8000)));await h.close();
   reset();const revoked=await mount();await click(revoked,'Odczytaj status');await until(()=>!!list(revoked));f.demoteAt=f.me+2;await click(revoked,'Starsze próby do uzgodnienia');await until(()=>!!revoked.el.querySelector('[role="alert"]'));assert.equal(Boolean(list(revoked)),false);assert.equal(f.calls.length,6);await revoked.close();
  });
  await t.test('foreign rule, malformed page and repeated cursor refuse readback and keep configuration unreadable',async()=>{
   for(const modify of [v=>v.rule_id=id(30),v=>v.unresolved_effects.scope='RECENT_OWN_RULE_RUNS',v=>{v.unresolved_effects=first();}]){
    reset();modify(f.older);const h=await mount();await click(h,'Odczytaj status');await until(()=>!!list(h));await click(h,'Starsze próby do uzgodnienia');await until(()=>!!h.el.querySelector('[role="alert"]'));assert.equal(Boolean(list(h)),false);assert.equal(f.calls.length,6);await h.close();
   }
  });
  await t.test('row/page validation rejects malformed or private fields, but preserves nullable email job and microsecond ties',async()=>{
   reset();const bad=[p=>p.data.push(row(1800)),p=>p.scope='RECENT_OWN_RULE_RUNS',p=>p.next_cursor='stock:'+id(999),p=>p.data[0].job_id=null,p=>p.data[0].lease_token='PRIVATE_SECRET',p=>p.data[0].outcome='VERIFIED',p=>p.data[0].reconciliation_required=false,p=>p.data[0].created_at='2026-02-30T10:00:00.000Z',p=>p.data[0].effect_plan_id='PRIVATE_SECRET',p=>p.data[1]=structuredClone(p.data[0])];
   for(const change of bad){const value=first();change(value);const h=await mount(ui.AutomationUnresolvedEffects,{value,busy:false,onOlder(){assert.fail('No implicit read');}});assert(h.el.querySelector('[role="alert"]'));assert.equal(Boolean(list(h)),false);assert.doesNotMatch(h.el.textContent,/PRIVATE_SECRET/);await h.close();}
   const ties=first();ties.data=ties.data.map((r,n)=>({...r,job_id:id(1900+n),created_at:ties.data[0].created_at}));ties.next_cursor='stock:'+ties.data.at(-1).job_id;const h=await mount(ui.AutomationUnresolvedEffects,{value:ties,busy:false,onOlder(){assert.fail('No implicit read');}});assert(list(h));await h.close();assert.equal(f.calls.length,0);
  });
  await t.test('old server is compatible without inventing an empty confirmed list or a read action',async()=>{
   reset();delete f.first.unresolved_effects;const h=await mount();await click(h,'Odczytaj status');await until(()=>h.el.textContent.includes('Ten odczyt nie udostępnia listy'));assert.equal(Boolean(list(h)),false);assert.equal(button(h,'Starsze próby do uzgodnienia'),undefined);assert.match(h.el.textContent,/Niepewne rozpoczęte zadania wymagają uzgodnienia/);assert.equal(f.calls.length,3);await h.close();
  });
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
