/** Actual component with controlled GET responses. No HTTP, database, worker or provider. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const schedule=n=>({id:id(n),name:'Harmonogram '+n,enabled:true,version:'1',definition_version:'1',definition:{frequency:{kind:'interval',seconds:3600},statuses:['new'],min_age_seconds:0,repetition:'once_per_version'}});
const row=(n,label)=>({id:id(n),state:'done',scheduled_for:'2026-10-18T12:00:00Z',scanned:1,done:1,skipped:0,failed:0,error:label});
const detail=(n,label,cursor=null)=>({id:id(n),state:'done',items:[{order_id:id(n+100),number:label,state:'done',result:{actions:[]}}],meta:{cursor}});
const history=(data,cursor=null)=>({data,meta:{cursor}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};

test('Schedule history pages stay scoped and recover through explicit GET only',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client'),{AutomationSchedules}=await vite.ssrLoadModule(path.resolve('web/automation-schedules.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const handles=[];let state;
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),'expected controlled UI observation');}
 function setup(){
  state={calls:[],once:new Map(),pages:new Map([
   ['/automation-schedules/'+id(10)+'/runs',history([row(20,'HISTORY-A')],'older')],
   ['/automation-schedules/'+id(10)+'/runs?after=older',history([row(21,'HISTORY-OLDER')])],
   ['/automation-schedules/'+id(11)+'/runs',history([row(22,'HISTORY-B')])],
   ['/automation-schedule-runs/'+id(20),detail(20,'ORDER-FIRST','next')],
   ['/automation-schedule-runs/'+id(20)+'?after=next',detail(20,'ORDER-NEXT')],
   ['/automation-schedule-runs/'+id(22),detail(22,'ORDER-B')],
  ])};
  globalThis.fetch=async(url,init={})=>{
   const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname.slice(4)+u.search,method=init.method??'GET';state.calls.push({route,method});assert.equal(method,'GET','history must never dispatch a write');
   if(route==='/automation-schedules')return Response.json({data:[schedule(10),schedule(11)]});
   if(route==='/workflow-statuses')return Response.json({data:[]});
   if(route==='/settings')return Response.json({warehouses:[]});
   const next=state.once.get(route);if(next){state.once.delete(route);return await next;}
   assert(state.pages.has(route),'unexpected controlled GET '+route);return Response.json(state.pages.get(route));
  };return state;
 }
 async function mount(extra={}){
  api.setWorkspace(id(1));const el=document.createElement('div');document.body.append(el);const root=createRoot(el);let props={admin:true,readOnly:false,refresh:0,reload(){},...extra};
  const h={el,async click(label,index=0){const button=[...el.querySelectorAll('button')].filter(b=>b.textContent.trim()===label)[index];assert(button,'button '+label);assert(!button.disabled,'enabled '+label);await React.act(async()=>button.click());},async render(next){props={...props,...next};await React.act(async()=>root.render(React.createElement(AutomationSchedules,props)));},async close(){if(el.isConnected){await React.act(async()=>root.unmount());el.remove();}}};handles.push(h);await h.render({});await until(()=>el.querySelectorAll('.rule-card').length===2);return h;
 }
 const panel=(h,prefix)=>[...h.el.querySelectorAll('.schedule-detail')].find(el=>el.querySelector('h3')?.textContent.startsWith(prefix));
 const contains=(el,text)=>!!el?.textContent.includes(text);
 try{
  await t.test('slow or failed older history never presents the preceding page; retry keeps the cursor',async()=>{
   const s=setup(),h=await mount();await h.click('Historia harmonogramu');await until(()=>contains(panel(h,'Historia:'),'HISTORY-A'));
   const route='/automation-schedules/'+id(10)+'/runs?after=older',held=deferred();s.once.set(route,held.promise);await h.click('Starsze wykonania');await until(()=>s.calls.some(c=>c.route===route));
   assert(!contains(panel(h,'Historia:'),'HISTORY-A'));assert(contains(panel(h,'Historia:'),'Wczytywanie strony historii'));assert(!contains(panel(h,'Historia:'),'Wyniki zamówień'));
   await React.act(async()=>held.resolve(Response.json({detail:'Lokalny błąd odczytu'},{status:503})));await until(()=>contains(panel(h,'Historia:'),'Ponów odczyt historii'));assert(!contains(panel(h,'Historia:'),'HISTORY-A'));
   await h.click('Ponów odczyt historii');await until(()=>contains(panel(h,'Historia:'),'HISTORY-OLDER'));assert.equal(s.calls.filter(c=>c.route===route).length,2);
   await h.click('Najnowsze wykonania');await until(()=>contains(panel(h,'Historia:'),'HISTORY-A'));await h.close();
  });
  await t.test('order-result pagination hides prior orders and retries the exact failed result page',async()=>{
   const s=setup(),h=await mount();await h.click('Historia harmonogramu');await until(()=>contains(panel(h,'Historia:'),'HISTORY-A'));await h.click('Wyniki zamówień');await until(()=>contains(panel(h,'Wyniki wykonania'),'ORDER-FIRST'));assert(!contains(panel(h,'Wyniki wykonania'),'HISTORY-A'),'fresh detail success supersedes the historical row error');
   const route='/automation-schedule-runs/'+id(20)+'?after=next',held=deferred();s.once.set(route,held.promise);await h.click('Dalsze wyniki');await until(()=>s.calls.some(c=>c.route===route));assert(!contains(panel(h,'Wyniki wykonania'),'ORDER-FIRST'));assert(contains(panel(h,'Wyniki wykonania'),'Wczytywanie strony wyników'));
   await React.act(async()=>held.resolve(Response.json({detail:'Lokalny błąd strony wyników'},{status:503})));await until(()=>contains(panel(h,'Wyniki wykonania'),'Ponów odczyt wyników'));assert(!contains(panel(h,'Wyniki wykonania'),'ORDER-FIRST'));
   await h.click('Ponów odczyt wyników');await until(()=>contains(panel(h,'Wyniki wykonania'),'ORDER-NEXT'));assert.equal(s.calls.filter(c=>c.route===route).length,2);
   await h.click('Pierwsza strona wyników');await until(()=>contains(panel(h,'Wyniki wykonania'),'ORDER-FIRST'));await h.close();
  });
  await t.test('switching schedules or runs ignores late history and result responses',async()=>{
   const s=setup(),h=await mount(),held=deferred();s.once.set('/automation-schedules/'+id(10)+'/runs',held.promise);await h.click('Historia harmonogramu');await h.click('Historia harmonogramu',1);await until(()=>contains(panel(h,'Historia:'),'HISTORY-B'));
   await React.act(async()=>held.resolve(Response.json(history([row(20,'LATE-HISTORY-A')]))));await tick();assert(!contains(h.el,'LATE-HISTORY-A'));assert(contains(panel(h,'Historia:'),'HISTORY-B'));
   await h.click('Historia harmonogramu');await until(()=>contains(panel(h,'Historia:'),'HISTORY-A'));const items=deferred();s.once.set('/automation-schedule-runs/'+id(20),items.promise);await h.click('Wyniki zamówień');await h.click('Historia harmonogramu',1);await until(()=>contains(panel(h,'Historia:'),'HISTORY-B'));await h.click('Wyniki zamówień');await until(()=>contains(panel(h,'Wyniki wykonania'),'ORDER-B'));
   await React.act(async()=>items.resolve(Response.json(detail(20,'LATE-ORDER-A'))));await tick();assert(!contains(h.el,'LATE-ORDER-A'));assert(contains(panel(h,'Wyniki wykonania'),'ORDER-B'));await h.close();
  });
  await t.test('closing history or results suppresses late successful and failed reads',async()=>{
   const s=setup(),h=await mount(),held=deferred();s.once.set('/automation-schedules/'+id(10)+'/runs',held.promise);await h.click('Historia harmonogramu');await h.click('Zamknij historię');await React.act(async()=>held.resolve(Response.json({detail:'Zamknięty stary odczyt'},{status:503})));await tick();assert(!panel(h,'Historia:'));assert(!contains(h.el,'Zamknięty stary odczyt'));
   await h.click('Historia harmonogramu');await until(()=>contains(panel(h,'Historia:'),'HISTORY-A'));const items=deferred();s.once.set('/automation-schedule-runs/'+id(20),items.promise);await h.click('Wyniki zamówień');await h.click('Zamknij wyniki');await React.act(async()=>items.resolve(Response.json(detail(20,'CLOSED-ORDER'))));await tick();assert(!panel(h,'Wyniki wykonania'));assert(!contains(h.el,'CLOSED-ORDER'));await h.close();
  });
  await t.test('reselecting the same schedule and run immediately requests fresh GETs',async()=>{
   const s=setup(),h=await mount(),historyRoute='/automation-schedules/'+id(10)+'/runs',detailRoute='/automation-schedule-runs/'+id(20);await h.click('Historia harmonogramu');await until(()=>contains(panel(h,'Historia:'),'HISTORY-A'));
   s.pages.set(historyRoute,history([row(20,'HISTORY-UPDATED')]));await h.click('Historia harmonogramu');await until(()=>contains(panel(h,'Historia:'),'HISTORY-UPDATED'));assert.equal(s.calls.filter(c=>c.route===historyRoute).length,2);
   await h.click('Wyniki zamówień');await until(()=>contains(panel(h,'Wyniki wykonania'),'ORDER-FIRST'));s.pages.set(detailRoute,detail(20,'ORDER-UPDATED'));await h.click('Wyniki zamówień');await until(()=>contains(panel(h,'Wyniki wykonania'),'ORDER-UPDATED'));assert.equal(s.calls.filter(c=>c.route===detailRoute).length,2);await h.close();
  });
  await t.test('read-only operator can read and recover history without enabling any write control',async()=>{
   const s=setup(),h=await mount({admin:false,readOnly:true}),route='/automation-schedules/'+id(10)+'/runs';s.once.set(route,Promise.resolve(Response.json({detail:'Ponowny lokalny odczyt'},{status:503})));await h.click('Historia harmonogramu');await until(()=>contains(panel(h,'Historia:'),'Ponów odczyt historii'));await h.click('Ponów odczyt historii');await until(()=>contains(panel(h,'Historia:'),'HISTORY-A'));assert(!contains(h.el,'Nowy harmonogram'));assert(s.calls.every(c=>c.method==='GET'));await h.close();
  });
  await t.test('background refresh updates the selected page and disables page navigation until its GET completes',async()=>{
   const s=setup(),h=await mount(),route='/automation-schedules/'+id(10)+'/runs';await h.click('Historia harmonogramu');await until(()=>contains(panel(h,'Historia:'),'HISTORY-A'));
   const held=deferred();s.once.set(route,held.promise);await h.render({refresh:1});await until(()=>s.calls.filter(c=>c.route===route).length===2);assert(contains(panel(h,'Historia:'),'HISTORY-A'));assert([...h.el.querySelectorAll('button')].find(b=>b.textContent==='Starsze wykonania').disabled);
   await React.act(async()=>held.resolve(Response.json(history([row(20,'HISTORY-REFRESHED')],'older'))));await until(()=>contains(panel(h,'Historia:'),'HISTORY-REFRESHED'));assert(!contains(panel(h,'Historia:'),'HISTORY-A'));assert(![...h.el.querySelectorAll('button')].find(b=>b.textContent==='Starsze wykonania').disabled);await h.close();
  });
  await t.test('the existing five-second poll refreshes open history and detail through GET only',async()=>{
   const oldInterval=globalThis.setInterval,oldClear=globalThis.clearInterval,callbacks=new Map();let serial=0,h;
   globalThis.setInterval=(fn,delay,...args)=>{if(delay!==5000)return oldInterval(fn,delay,...args);const handle={controlled:++serial};callbacks.set(handle,()=>fn(...args));return handle;};
   globalThis.clearInterval=handle=>{if(callbacks.has(handle))callbacks.delete(handle);else oldClear(handle);};
   try{
    const s=setup();h=await mount();await h.click('Historia harmonogramu');await until(()=>contains(panel(h,'Historia:'),'HISTORY-A'));await h.click('Wyniki zamówień');await until(()=>contains(panel(h,'Wyniki wykonania'),'ORDER-FIRST'));assert.equal(callbacks.size,1);
    const historyRoute='/automation-schedules/'+id(10)+'/runs',detailRoute='/automation-schedule-runs/'+id(20);s.pages.set(historyRoute,history([row(20,'HISTORY-POLLED')]));s.pages.set(detailRoute,detail(20,'ORDER-POLLED'));
    await React.act(async()=>{for(const fire of callbacks.values())fire();});await until(()=>contains(panel(h,'Historia:'),'HISTORY-POLLED')&&contains(panel(h,'Wyniki wykonania'),'ORDER-POLLED'));assert.equal(s.calls.filter(c=>c.route===historyRoute).length,2);assert.equal(s.calls.filter(c=>c.route===detailRoute).length,2);assert(s.calls.every(c=>c.method==='GET'));
   }finally{await h?.close();assert.equal(callbacks.size,0);globalThis.setInterval=oldInterval;globalThis.clearInterval=oldClear;}
  });
  await t.test('unmount cancels observation of pending GETs without scheduling another read',async()=>{
   const s=setup(),h=await mount(),route='/automation-schedules/'+id(10)+'/runs',held=deferred();s.once.set(route,held.promise);await h.click('Historia harmonogramu');await until(()=>s.calls.some(c=>c.route===route));await h.close();const calls=s.calls.length;
   await React.act(async()=>held.resolve(Response.json({detail:'Late closed failure'},{status:503})));await tick();assert.equal(s.calls.length,calls);assert(!h.el.isConnected);
  });
 }finally{for(const h of handles)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
