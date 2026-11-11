import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant=id(1),user=id(2),rule=id(3),context=tenant+':'+user;
const cycle=(patch={})=>({started_at:'2026-10-17T10:00:00.000Z',finished_at:'2026-10-17T10:00:01.000Z',outcome:'PROCESSOR_RETURNED_REQUIRES_HISTORY_READBACK',error_code:null,...patch});
const runtime=(patch={})=>({state:'RUNNING',started:true,draining:false,current_busy:false,last_cycle:null,ram_only:true,paused:false,pause_scope:'RULE_CONFIGURATION_ONLY_NOT_DRAIN_ACK',last_cycle_scope:'RECENT_OWN_RULE_VISIT_NOT_DURABLE_HISTORY',...patch});
const status=(patch={})=>({rule_id:rule,version:'1',processor_running:true,state:'ENABLED',jobs:[],activation:{enabled:true},child_effects:[],reconciliation_required:false,runtime:runtime(),...patch});
const coverage=(patch={})=>({scope:'RECENT_OWN_RULE_RUNS',run_limit:25,runs_truncated:false,per_kind_limit:500,stock_truncated:false,email_truncated:false,reconciliation_scope:'ALL_OWN_RULE_RUNS',...patch});
const props=(patch={})=>({contextKey:context,rule:{id:rule,version:'1',enabled:true,actor_id:user,trigger:'order.created',definition:{actions:[{type:'add_note',note:'Own rule'}]}},admin:true,readOnly:false,onChanged(){},...patch});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('worker diagnostics use actual React and only the parent authorized read; no real APIs/DB/providers/listener',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_key,_opts,work)=>work()}});
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),ui=await vite.ssrLoadModule(path.resolve('web/local-automation-worker-diagnostics.tsx')),worker=await vite.ssrLoadModule(path.resolve('web/local-automation-worker-control.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const handles=[];let f;
 function reset(){window.localStorage.clear();api.setWorkspace(tenant);f={calls:[],value:status(),me:0,demoteAt:0,hold:null};globalThis.fetch=async(url,init={})=>{
  const p=new URL(String(url),'http://127.0.0.1');assert.equal(p.origin,'http://127.0.0.1');assert.equal(init.method,'GET','diagnostics must not add mutations');assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);
  f.calls.push(p.pathname);if(p.pathname==='/api/auth/me'){f.me++;return Response.json({restore_preview:false,user:{id:user,tenant_id:tenant,role:f.demoteAt&&f.me>=f.demoteAt?'viewer':'admin'}});}
  assert.equal(p.pathname,'/api/automations/'+rule+'/local-worker','no new diagnostic/options endpoint');if(f.hold)return f.hold.promise;return Response.json(f.value);
 };}
 async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
 async function until(fn){for(let i=0;i<60;i++){if(fn())return;await tick();}assert(fn(),'controlled React state did not settle');}
 async function mount(Component,p){const el=document.createElement('div');document.body.append(el);const root=createRoot(el),h={el,async render(next){await act(async()=>root.render(React.createElement(Component,next)));},async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);await h.render(p);return h;}
 const diag=h=>h.el.querySelector('section[aria-label="Praca procesora tej reguły"]');
 async function read(h){const b=[...h.el.querySelectorAll('button')].find(b=>b.textContent==='Odczytaj status');assert(b&&!b.disabled);await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 const hideInternals=h=>{for(const raw of [tenant,user,rule,'RUNNING','NOT_STARTED','DRAINING','AMBIGUOUS_RUNTIME','PROCESSOR_RETURNED_REQUIRES_HISTORY_READBACK','RULE_CONFIGURATION_ONLY_NOT_DRAIN_ACK','57014','PRIVATE_SQL_TEXT'])assert(!diag(h).textContent.includes(raw),raw);};
 try{
  await t.test('four runtime states have Polish labels; observation never promises completion or global idle',async()=>{
   reset();const cases=[
    [status(), 'Procesor działa.'],
    [status({processor_running:false,state:'PROCESSOR_STOPPED',runtime:runtime({state:'NOT_STARTED',started:false,draining:false,current_busy:false,paused:null})}),'Procesor nie został uruchomiony w tym odczycie.'],
    [status({runtime:runtime({state:'DRAINING',draining:true,current_busy:true,paused:null})}),'Procesor kończy pracę.'],
    [status({runtime:runtime({state:'AMBIGUOUS_RUNTIME',started:null,draining:null,current_busy:null,paused:null})}),'Nie można potwierdzić jednego procesora.'],
   ];
   for(const[value,label]of cases){const h=await mount(ui.LocalAutomationWorkerDiagnostics,{status:value,ruleId:rule});assert(diag(h).textContent.includes(label));hideInternals(h);assert.equal(h.el.querySelectorAll('button,input').length,0);await h.close();}
   assert.equal(f.calls.length,0);
  });
  await t.test('paused configuration can still be busy; draining with own busy=false does not confirm full drain',async()=>{
   reset();const h=await mount(ui.LocalAutomationWorkerDiagnostics,{status:status({state:'DISABLED_OR_RULE_CHANGED',runtime:runtime({paused:true,current_busy:true,last_cycle:cycle()})}),ruleId:rule});
   assert(diag(h).textContent.includes('nowych zdarzeń tej reguły jest wyłączona'));assert(diag(h).textContent.includes('nadal obsługuje tę regułę'));assert(diag(h).textContent.includes('nie potwierdza zakończenia rozpoczętej pracy'));assert(diag(h).textContent.includes('Wynik sprawdź w historii reguły'));hideInternals(h);
   await h.render({status:status({runtime:runtime({state:'DRAINING',draining:true,current_busy:false,paused:null})}),ruleId:rule});assert(diag(h).textContent.includes('w tej chwili nie obsługuje tej reguły'));assert(diag(h).textContent.includes('nie potwierdza jeszcze zakończenia wszystkich'));await h.close();assert.equal(f.calls.length,0);
  });
  await t.test('nullable recent memory and each recognized outcome stay separate from durable execution history',async()=>{
   reset();const h=await mount(ui.LocalAutomationWorkerDiagnostics,{status:status(),ruleId:rule});assert(diag(h).textContent.includes('Brak zapamiętanej kontroli'));assert(diag(h).textContent.includes('po restarcie lub usunięciu starszych wpisów nie dowodzi'));
   for(const[outcome,error_code,text]of [['NO_UNATTEMPTED_JOB',null,'nie znaleziono nowego zadania'],['PROCESSOR_RETURNED_REQUIRES_HISTORY_READBACK',null,'Wynik sprawdź w historii'],['ATTEMPT_FAILED_NO_RETRY','57014','nie jest ponawiana automatycznie'],['CLAIM_NOT_CONFIRMED',null,'Nie potwierdzono rozpoczęcia'],['DISCOVERY_REFUSED','55P03','Nie udało się sprawdzić kolejki']]){await h.render({status:status({runtime:runtime({last_cycle:cycle({outcome,error_code})})}),ruleId:rule});assert(diag(h).textContent.includes(text));hideInternals(h);}
   await h.close();assert.equal(f.calls.length,0);
  });
  await t.test('old server and malformed/contradictory DTOs show unconfirmed information with no raw values',async()=>{
   reset();const old=status();delete old.runtime;const h=await mount(ui.LocalAutomationWorkerDiagnostics,{status:old,ruleId:rule});assert(diag(h).textContent.includes('serwer nie udostępnia diagnostyki'));
   const mutations=[v=>v.rule_id=id(9),v=>v.runtime=null,v=>v.runtime.current_busy='false',v=>v.runtime.started=false,v=>v.runtime.ram_only=false,v=>v.runtime.pause_scope='DRAIN_CONFIRMED',v=>v.runtime.paused=true,v=>v.processor_running=false,v=>v.runtime.state='PRIVATE_SQL_TEXT',v=>v.runtime.last_cycle=cycle({outcome:'PRIVATE_SQL_TEXT'}),v=>v.runtime.last_cycle=cycle({error_code:'PRIVATE_SQL_TEXT'}),v=>v.runtime.last_cycle=cycle({started_at:'wrong'}),v=>v.runtime.last_cycle=cycle({started_at:'2026-02-30T10:00:00Z',finished_at:'2026-03-02T10:00:01Z'}),v=>v.runtime.last_cycle=cycle({finished_at:'2026-10-17T09:00:00Z'}),v=>v.runtime.last_cycle=cycle({error_code:'57014'}),v=>v.runtime.extra='PRIVATE_SQL_TEXT'];
   for(const mutate of mutations){const bad=status();mutate(bad);await h.render({status:bad,ruleId:rule});assert(diag(h).textContent.includes('Nie można potwierdzić diagnostyki'));assert(!diag(h).textContent.includes('Procesor działa.'));hideInternals(h);}
   await h.close();assert.equal(f.calls.length,0);
  });
  await t.test('parent reuses its one explicit status GET with existing IAM checks, adds no poller or mutation',async()=>{
   reset();f.value=status({runtime:runtime({current_busy:true})});const h=await mount(worker.LocalAutomationWorkerControl,props());assert.equal(f.calls.length,0);await read(h);await until(()=>diag(h).textContent.includes('Procesor działa.'));
   assert.deepEqual(f.calls,['/api/auth/me','/api/automations/'+rule+'/local-worker','/api/auth/me']);for(let i=0;i<4;i++)await tick();assert.equal(f.calls.length,3);assert(diag(h).textContent.includes('nadal obsługuje tę regułę'));hideInternals(h);await h.close();
  });
  await t.test('truncated effects explain the complete reconciliation scope even with no recent effect rows',async()=>{
   for(const flag of ['runs_truncated','stock_truncated','email_truncated']){
    reset();f.value=status({child_effects_coverage:coverage({[flag]:true}),reconciliation_required:true});const h=await mount(worker.LocalAutomationWorkerControl,props());await read(h);await until(()=>!!h.el.querySelector('[aria-label="Zakres historii efektów"]'));
    const marker=h.el.querySelector('[aria-label="Zakres historii efektów"]');assert.match(marker.textContent,/Lista efektów jest skrócona/);assert.match(marker.textContent,/Status uzgodnienia obejmuje całą historię tej reguły/);assert.match(h.el.textContent,/Niepewne rozpoczęte zadania wymagają uzgodnienia skutków/);assert.deepEqual(f.value.child_effects,[]);
    assert.deepEqual(f.calls,['/api/auth/me','/api/automations/'+rule+'/local-worker','/api/auth/me']);await h.close();
   }
  });
  await t.test('old or malformed coverage never claims complete history; a full recent page has no truncation warning',async()=>{
   const values=[undefined,null,coverage({scope:'ALL_RUNS'}),coverage({run_limit:26}),coverage({per_kind_limit:501}),coverage({runs_truncated:'false'}),coverage({stock_truncated:true,reconciliation_scope:'RECENT_OWN_RULE_RUNS'}),{...coverage(),extra:true}];
   for(const value of values){reset();f.value=status({...(value===undefined?{}:{child_effects_coverage:value}),reconciliation_required:true});const h=await mount(worker.LocalAutomationWorkerControl,props());await read(h);await until(()=>!!h.el.querySelector('[aria-label="Zakres historii efektów"]'));const text=h.el.querySelector('[aria-label="Zakres historii efektów"]').textContent;assert.match(text,/Zakres historii efektów nie został potwierdzony/);assert.doesNotMatch(text,/obejmuje całą historię/);assert.match(h.el.textContent,/Niepewne rozpoczęte zadania wymagają uzgodnienia skutków/);if(value?.stock_truncated===true)assert.match(text,/Lista efektów jest skrócona/);assert.equal(f.calls.length,3);await h.close();}
   for(const required of [undefined,null,'false']){reset();f.value=status({child_effects_coverage:coverage({runs_truncated:true}),reconciliation_required:required});const h=await mount(worker.LocalAutomationWorkerControl,props());await read(h);await until(()=>!!h.el.querySelector('[aria-label="Zakres historii efektów"]'));assert.doesNotMatch(h.el.querySelector('[aria-label="Zakres historii efektów"]').textContent,/obejmuje całą historię/);assert.equal(f.calls.length,3);await h.close();}
   reset();f.value=status({child_effects_coverage:coverage()});const h=await mount(worker.LocalAutomationWorkerControl,props());await read(h);await until(()=>diag(h).textContent.includes('Procesor działa.'));assert.equal(Boolean(h.el.querySelector('[aria-label="Zakres historii efektów"]')),false);assert.equal(f.calls.length,3);await h.close();
  });
  await t.test('parent immediately hides prior diagnostics across user, tenant, rule, role and read-only contexts',async()=>{
   for(const patch of [{contextKey:tenant+':'+id(20)},{contextKey:id(21)+':'+user},{rule:{...props().rule,id:id(22)}},{admin:false},{readOnly:true}]){
    reset();f.value=status({child_effects_coverage:coverage({runs_truncated:true})});const h=await mount(worker.LocalAutomationWorkerControl,props());await read(h);await until(()=>diag(h).textContent.includes('Procesor działa.'));assert(h.el.querySelector('[aria-label="Zakres historii efektów"]'));await h.render(props(patch));assert(!diag(h).textContent.includes('Procesor działa.'));assert(diag(h).textContent.includes('Odczytaj status'));assert.equal(Boolean(h.el.querySelector('[aria-label="Zakres historii efektów"]')),false);assert.equal(f.calls.length,3);await h.close();
   }
  });
  await t.test('late old-context response and late IAM downgrade cannot expose runtime of the earlier principal',async()=>{
   reset();const held=deferred();f.hold=held;const h=await mount(worker.LocalAutomationWorkerControl,props());await read(h);await until(()=>f.calls.some(p=>p.includes('/local-worker')));await h.render(props({contextKey:tenant+':'+id(23)}));await act(async()=>held.resolve(Response.json(status({runtime:runtime({last_cycle:cycle()})}))));await tick();assert(!diag(h).textContent.includes('Procesor działa.'));assert(!diag(h).textContent.includes('Ostatnia zapamiętana kontrola'));await h.close();
   reset();f.demoteAt=2;const downgraded=await mount(worker.LocalAutomationWorkerControl,props());await read(downgraded);await until(()=>!!downgraded.el.querySelector('[role=alert]'));assert(!diag(downgraded).textContent.includes('Procesor działa.'));assert.equal(f.calls.length,3);await downgraded.close();
   reset();f.value=status({child_effects_coverage:coverage({runs_truncated:true})});const revoked=await mount(worker.LocalAutomationWorkerControl,props());await read(revoked);await until(()=>diag(revoked).textContent.includes('Procesor działa.'));assert(revoked.el.querySelector('[aria-label="Zakres historii efektów"]'));f.demoteAt=f.me+1;await read(revoked);await until(()=>!!revoked.el.querySelector('[role=alert]'));assert(!diag(revoked).textContent.includes('Procesor działa.'));assert(diag(revoked).textContent.includes('Odczytaj status'));assert.equal(Boolean(revoked.el.querySelector('[aria-label="Zakres historii efektów"]')),false);await revoked.close();
  });
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
