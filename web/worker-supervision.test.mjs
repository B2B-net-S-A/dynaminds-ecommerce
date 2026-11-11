import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';
const tenant='00000001-1000-4000-8000-000000000001';
const step=(name,patch={})=>({name,label:'Etykieta '+name,state:'ok',paused:false,runs:3,failures:0,consecutive_failures:0,last_started_at:new Date().toISOString(),
 last_finished_at:new Date().toISOString(),last_success_at:new Date().toISOString(),last_duration_ms:4,last_error:null,next_run_at:new Date(Date.now()+1000).toISOString(),...patch});
const lane=(name,patch={})=>({lane:name,cycles:7,cycle_running:false,heartbeat_at:new Date().toISOString(),last_cycle_started_at:null,last_cycle_finished_at:null,...patch});
const runtime=(patch={})=>({state:'RUNNING',started_at:new Date().toISOString(),interval_ms:1000,cycles:7,cycle_running:false,heartbeat_at:new Date().toISOString(),
 last_cycle_started_at:null,last_cycle_finished_at:null,pause_scope:'RUNTIME_ONLY_RESET_ON_RESTART',lanes:[lane('main'),lane('jobs',{cycles:2})],
 steps:[step('ebay.fulfillment',{state:'backoff',failures:2,consecutive_failures:2,last_error:{message:'Błąd bazy danych (kod 42P01); szczegóły w logu serwera',code:'42P01',at:new Date().toISOString()}}),step('jobs.tick')],...patch});
test('WorkerSupervision: runtime table, stale heartbeat, pause POST, not-started reason, queue metrics',async()=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client');
 const {WorkerSupervision}=await vite.ssrLoadModule(path.resolve('web/operations.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const calls=[],notes=[];let value;
 globalThis.fetch=async(url,init={})=>{const p=String(url).slice(4),method=init.method??'GET';calls.push(method+' '+p);
  if(method==='POST'){const name=p.split('/')[4];return Response.json({scheduler:step(name,{paused:p.endsWith('/pause'),state:p.endsWith('/pause')?'paused':'ok'})});}
  assert.equal(p,'/operations/workers');return Response.json(value);};
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<50&&!fn();i++)await tick();assert(fn(),el.textContent);}
 const button=(row,text)=>[...el.querySelectorAll(`tr[data-scheduler="${row}"] button`)].find(x=>x.textContent.trim()===text);
 const render=props=>React.act(async()=>root.render(React.createElement(WorkerSupervision,{refresh:0,readOnly:false,notify:(s,e)=>notes.push([s,!!e]),...props})));
 try{
  api.setWorkspace(tenant);
  value={runtime:runtime(),runtime_state:'RUNNING',not_started_reason:null,installation_operator:true,scheduler_control:true,scheduler_control_rule:'Tylko operator instalacji.',scoped_processor:{enabled:false,message:'Procesor reguł automatycznych nie działa w tym uruchomieniu.'},
   replay_rule:'Zasada X',queue:{generated_at:new Date().toISOString(),kinds:[{kind:'orders.sync',pending:4,due:3,oldest_due_at:new Date().toISOString(),oldest_due_age_s:95,retrying:1,running:2,stale_running:1,failed:5,max_attempts_used:3,provider_wait_until:null,last_error:'Błąd przetwarzania integracji'},{kind:'automation',pending:42,due:42,oldest_due_at:null,oldest_due_age_s:1547012,retrying:0,running:1,stale_running:0,failed:0,max_attempts_used:1,provider_wait_until:null,last_error:null}]}};
  await render({});
  await until(()=>el.textContent.includes('Pętla działa'));
  assert.match(el.textContent,/Harmonogramy: heartbeat .* · cykli 7/);
  assert.match(el.textContent,/Kolejka zadań: heartbeat .* · cykli 2/);
  assert.match(el.textContent,/Błąd · ponowienie z opóźnieniem/);
  assert.match(el.textContent,/2 pod rząd · 2 łącznie/);
  assert.match(el.textContent,/kod 42P01/);
  assert.match(el.textContent,/Procesor reguł automatycznych nie działa/);
  assert.match(el.textContent,/95 s/);
  assert.match(el.textContent,/18 d/,'long backlog age is shown in days');
  assert.match(el.textContent,/1 z wygasłą dzierżawą/);
  assert.match(el.textContent,/Zasada ponowień: Zasada X/);
  assert.equal(el.querySelector('[role="alert"]'),null,'fresh heartbeat has no alert');
  await React.act(async()=>button('jobs.tick','Wstrzymaj').click());
  await until(()=>notes.length===1);
  assert(calls.includes('POST /operations/workers/schedulers/jobs.tick/pause'));
  assert.deepEqual(notes[0],['Scheduler wstrzymany do restartu procesu',false]);
  value={...value,runtime:runtime({lanes:[lane('main'),lane('jobs',{cycle_running:true,heartbeat_at:new Date(Date.now()-120_000).toISOString(),last_cycle_started_at:new Date(Date.now()-120_000).toISOString()})],
   steps:[step('jobs.tick',{paused:true,state:'paused'}),step('b2b.network',{state:'running',last_started_at:new Date(Date.now()-45_000).toISOString()}),
   step('odoo.catalog',{state:'timeout',timeout_ms:120_000,last_started_at:new Date(Date.now()-150_000).toISOString(),failures:1,consecutive_failures:1,last_error:{message:'Krok przekroczył limit czasu 120 s; działa dalej i nie ruszy ponownie, dopóki się nie zakończy',code:'TIMEOUT',at:new Date().toISOString()}})]})};
  await render({refresh:1});
  await until(()=>el.textContent.includes('brak heartbeat'));
  assert.equal(el.querySelectorAll('[role="alert"]').length,1,'only the stale lane alerts');
  assert.match(el.querySelector('[role="alert"]').textContent,/^Kolejka zadań: brak heartbeat od 1[12][0-9] s/);
  assert.match(el.textContent,/cykl w toku od 1[12][0-9] s/);
  assert.match(el.querySelector('tr[data-scheduler="b2b.network"]').textContent,/W tokuod 4[5-9] s/);
  assert.match(el.textContent,/Wstrzymany/);
  assert.match(el.querySelector('tr[data-scheduler="odoo.catalog"]').textContent,/Przekroczony limit czasu · nadal działaod 1[45][0-9] slimit 120 s/);
  assert.match(el.querySelector('tr[data-scheduler="odoo.catalog"]').textContent,/Krok przekroczył limit czasu 120 s/);
  assert.match(el.textContent,/po wznowieniu/);
  assert(button('jobs.tick','Wznów'));
  await render({refresh:2,readOnly:true});
  await until(()=>button('jobs.tick','Wznów')?.disabled===true);
  value={runtime:null,runtime_state:'NOT_STARTED',not_started_reason:'Worker w tle jest wyłączony w tym uruchomieniu.',scoped_processor:{enabled:false,message:'m'},replay_rule:'r',queue:{generated_at:'',kinds:[]}};
  await render({refresh:3});
  await until(()=>el.textContent.includes('Worker w tle jest wyłączony'));
  assert.equal(el.querySelector('tr[data-scheduler]'),null);
  assert.match(el.textContent,/Brak oczekujących, trwających i nieudanych zadań/);
  // SR4-H1: an admin who is not the installation operator sees the loop, but no pause/resume and no errors.
  value={runtime:runtime({steps:[step('ebay.fulfillment',{state:'backoff',failures:2,consecutive_failures:2,last_error:null}),step('jobs.tick')]}),runtime_state:'RUNNING',not_started_reason:null,
   installation_operator:false,scheduler_control:false,scheduler_control_rule:'Wstrzymanie i wznowienie schedulera obejmuje wszystkie firmy tej instalacji, więc może je wykonać tylko operator instalacji.',
   scoped_processor:{enabled:false,message:'m'},replay_rule:'r',queue:{generated_at:'',kinds:[]}};
  await render({refresh:4});
  await until(()=>!!el.querySelector('tr[data-scheduler="jobs.tick"]'));
  assert.equal(el.querySelectorAll('tr[data-scheduler] button').length,0,'no pause/resume for a non-operator');
  assert.match(el.textContent,/może je wykonać tylko operator instalacji/);
  assert.match(el.textContent,/Szczegóły błędów widzi operator instalacji/);
  assert.doesNotMatch(el.textContent,/Akcja/);
 }finally{await React.act(async()=>root.unmount());el.remove();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
test('WorkerSupervision: workspace admin starts and stops the scoped rule processor; other modes have no button',async()=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client');
 const {WorkerSupervision}=await vite.ssrLoadModule(path.resolve('web/operations.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const calls=[],notes=[];let scoped={mode:'WORKSPACE',running:false,enabled:false,can_control:true,scope:'THIS_WORKSPACE_RUNTIME_ONLY',message:'Procesor reguł automatycznych nie działa dla tej firmy.'};
 globalThis.fetch=async(url,init={})=>{const p=String(url).slice(4),method=init.method??'GET';calls.push(method+' '+p);
  if(method==='POST'){scoped={...scoped,running:p.endsWith('/start'),message:p.endsWith('/start')?'Procesor działa dla tej firmy do restartu procesu.':'Procesor reguł automatycznych nie działa dla tej firmy.'};return Response.json({scoped_processor:scoped});}
  return Response.json({runtime:null,runtime_state:'NOT_STARTED',not_started_reason:'Worker w tle jest wyłączony.',scoped_processor:scoped,replay_rule:'r',queue:{generated_at:'',kinds:[]}});};
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<50&&!fn();i++)await tick();assert(fn(),el.textContent);}
 const button=text=>[...el.querySelectorAll('[aria-label="Procesor reguł automatycznych"] button')].find(x=>x.textContent.trim()===text);
 const render=props=>React.act(async()=>root.render(React.createElement(WorkerSupervision,{refresh:0,readOnly:false,notify:(s,e)=>notes.push([s,!!e]),...props})));
 try{
  api.setWorkspace(tenant);
  await render({});
  await until(()=>!!button('Uruchom procesor dla tej firmy'));
  assert.match(el.textContent,/Stan: zatrzymany/);
  await React.act(async()=>button('Uruchom procesor dla tej firmy').click());
  await until(()=>!!button('Zatrzymaj procesor'));
  assert(calls.includes('POST /operations/workers/scoped-processor/start'));
  assert.match(el.textContent,/Stan: działa/);
  assert.deepEqual(notes.at(-1),['Procesor reguł uruchomiony dla tej firmy do restartu procesu',false]);
  await React.act(async()=>button('Zatrzymaj procesor').click());
  await until(()=>!!button('Uruchom procesor dla tej firmy'));
  assert(calls.includes('POST /operations/workers/scoped-processor/stop'));
  await render({refresh:1,readOnly:true});
  await until(()=>button('Uruchom procesor dla tej firmy')?.disabled===true);
  scoped={mode:'INSTALLATION',running:true,enabled:true,can_control:false,scope:'ALL_WORKSPACES_CLI_OPTION',message:'Procesor działa dla całej instalacji.'};
  await render({refresh:2});
  await until(()=>el.textContent.includes('Procesor działa dla całej instalacji.'));
  assert.equal(button('Zatrzymaj procesor'),undefined);
  assert.equal(button('Uruchom procesor dla tej firmy'),undefined);
 }finally{await React.act(async()=>root.unmount());el.remove();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
