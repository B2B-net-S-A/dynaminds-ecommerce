import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,tenant=id(1),user=id(2),context=tenant+':'+user;
const payload=()=>({name:' Nowa reguła ',trigger:'order.created',enabled:true,priority:10,delay_seconds:0,match:'all',conditions:[{field:'source',op:'eq',value:'manual'}],actions:[{type:'add_note',note:' gotowe '}]});
test('Actual CRUD guard with controlled normal API port, no HTTP/DB/services',async t=>{
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createAutomationCrudGuard,automationCrudKey,parseRuleWriteAttempt}=await vite.ssrLoadModule(path.resolve('web/automation-crud-guard.ts')),{ApiError}=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 function setup(){
  const storage=new Map(),calls=[],rows=[];let n=30,current=true,behavior='normal',me={restore_preview:false,user:{tenant_id:tenant,id:user,role:'admin'}},pendingResolve;
  const state={storage,calls,rows,setCurrent:v=>current=v,setMe:v=>me=v,setBehavior:v=>behavior=v,resolve:()=>pendingResolve?.(),writes:()=>calls.filter(x=>x.method!=='GET')};
  const guard=createAutomationCrudGuard({context,read:k=>storage.get(k)??null,write:(k,v)=>storage.set(k,v),newId:()=>id(n++),current:()=>current,lock:async(k,fn)=>fn(),request:async(p,method='GET',body)=>{
   calls.push({path:p,method,body:structuredClone(body)});
   if(p==='/auth/me')return structuredClone(me);
   if(method==='GET'){if(behavior==='get-fails'&&state.writes().length)throw Error('connection failed');return{data:structuredClone(rows)};}
   if(behavior==='refused')throw new ApiError('Walidacja',422);
   const old=rows.find(x=>p.endsWith('/'+x.id));const row={id:old?.id??id(n++),tenant_id:tenant,actor_id:user,...(old?.definition??{}),...body,version:old?String(BigInt(old.version)+1n):'1'};
   const def={...row};for(const k of ['id','tenant_id','actor_id','version'])delete def[k];
   if(old)rows.splice(rows.indexOf(old),1);rows.push({...row,definition:def});
   if(behavior==='defer')await new Promise(r=>pendingResolve=r);
   if(behavior==='lost-ack')throw TypeError('Lost response');return structuredClone(row);
  }});return{...state,guard};
 }
 try{
  await t.test('one create, known ID, exact GET confirmation and normal trim',async()=>{const s=setup(),r=await s.guard.submit(payload());assert(r.confirmed);assert.equal(s.writes().length,1);assert.equal(s.writes()[0].body.name,'Nowa reguła');assert.equal(s.writes()[0].body.actions[0].note,'gotowe');assert.equal(s.guard.blocked(),false);assert.equal(r.attempt.ack_id,s.rows[0].id);});
  await t.test('lost committed create ACK blocks all retry after GET/remount; exact new match is candidate only',async()=>{const s=setup();s.setBehavior('lost-ack');await assert.rejects(s.guard.submit(payload()),/Lost/);assert.equal(s.rows.length,1);s.setBehavior('normal');const r=await s.guard.reconcile();assert.equal(r.confirmed,false);assert.deepEqual(r.candidate_ids,[s.rows[0].id]);await assert.rejects(s.guard.submit(payload()),/niepewny/);assert.equal(s.writes().length,1);assert.equal(parseRuleWriteAttempt(s.storage.get(automationCrudKey(context)),context).phase,'unknown');});
  await t.test('same name alone, foreign actor or changed actions never match',async()=>{const s=setup();s.setBehavior('lost-ack');await assert.rejects(s.guard.submit(payload()));s.rows[0].actor_id=id(99);s.rows.push({...structuredClone(s.rows[0]),id:id(98),actor_id:user,definition:{...s.rows[0].definition,actions:[{type:'add_note',note:'inna treść'}]}});s.setBehavior('normal');assert.deepEqual((await s.guard.reconcile()).candidate_ids,[]);assert.equal(s.writes().length,1);});
  await t.test('lost PATCH ACK resolves exact known ID/version+1/actor/full payload from GET without PATCH retry',async()=>{const s=setup();await s.guard.submit(payload());const r=s.rows[0];s.setBehavior('lost-ack');await assert.rejects(s.guard.submit({...r.definition,id:r.id,version:r.version,name:'Zmieniona'}));s.setBehavior('normal');assert.equal((await s.guard.reconcile()).confirmed,true);assert.deepEqual(s.writes().map(x=>x.method),['POST','PATCH']);});
  await t.test('other current PATCH version remains unknown and blocks every subsequent write',async()=>{const s=setup();await s.guard.submit(payload());const r=s.rows[0];s.setBehavior('lost-ack');await assert.rejects(s.guard.submit({...r.definition,id:r.id,version:r.version,name:'Zmieniona'}));s.rows[0].version='3';s.setBehavior('normal');assert.equal((await s.guard.reconcile()).confirmed,false);await assert.rejects(s.guard.submit(payload()));assert.equal(s.writes().length,2);});
  await t.test('known ACK plus failed GET retains original ID, explicit GET later completes with no new write',async()=>{const s=setup();s.setBehavior('get-fails');await assert.rejects(s.guard.submit(payload()));assert.equal(s.guard.inspect().phase,'acknowledged');s.setBehavior('normal');assert.equal((await s.guard.reconcile()).confirmed,true);assert.equal(s.writes().length,1);});
  await t.test('organization change before dispatch or wrong actor has zero controlled writes',async()=>{const s=setup();s.setCurrent(false);await assert.rejects(s.guard.submit(payload()));assert.equal(s.writes().length,0);const z=setup();z.setMe({user:{tenant_id:id(100),id:user,role:'admin'}});await assert.rejects(z.guard.submit(payload()));assert.equal(z.writes().length,0);});
  await t.test('second click and org switch after dispatch cannot create a second write',async()=>{const s=setup();s.setBehavior('defer');const first=s.guard.submit(payload());for(let i=0;i<20&&!s.writes().length;i++)await new Promise(r=>setTimeout(r,0));assert.equal(s.writes().length,1);await assert.rejects(s.guard.submit(payload()),/w toku/);s.setCurrent(false);s.resolve();await assert.rejects(first,/Widok/);assert.equal(s.writes().length,1);assert(s.guard.blocked());});
  await t.test('malformed or foreign persisted journal refuses before any write',async()=>{const s=setup();s.storage.set(automationCrudKey(context),'{}');await assert.rejects(s.guard.submit(payload()));assert.equal(s.writes().length,0);const z=setup();z.storage.set(automationCrudKey(context),'null');await assert.rejects(z.guard.submit(payload()));assert.equal(z.writes().length,0);assert.throws(()=>parseRuleWriteAttempt(JSON.stringify({context:tenant+':'+id(8)}),context));});
  await t.test('normal known422 remains explicit refusal; corrected save is new deliberate action',async()=>{const s=setup();s.setBehavior('refused');await assert.rejects(s.guard.submit(payload()),/Walidacja/);assert.equal(s.guard.inspect().phase,'refused');assert.equal(s.guard.blocked(),false);s.setBehavior('normal');assert((await s.guard.submit({...payload(),name:'Poprawiona'})).confirmed);assert.equal(s.writes().length,2);});
  await t.test('two tabs starting before either marker serialize but cannot send duplicate create after first confirmed ACK',async()=>{
   const storage=new Map(),rows=[];let n=120,writes=0,tail=Promise.resolve();
   const ports={context,read:k=>storage.get(k)??null,write:(k,v)=>storage.set(k,v),newId:()=>id(n++),current:()=>true,
    lock:(key,fn)=>{const result=tail.then(fn);tail=result.catch(()=>{});return result;},
    request:async(p,method='GET',body)=>{if(p==='/auth/me')return{user:{tenant_id:tenant,id:user,role:'admin'}};if(method==='GET')return{data:structuredClone(rows)};writes++;const row={id:id(n++),tenant_id:tenant,actor_id:user,version:'1',...body};rows.push({...row,definition:body});return row;}};
   const a=createAutomationCrudGuard(ports),b=createAutomationCrudGuard(ports);
   const one=a.submit(payload()),two=b.submit(payload());const result=await Promise.allSettled([one,two]);assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');assert.match(result[1].reason.message,/Inna karta/);assert.equal(writes,1);assert.equal(rows.length,1);
  });
  await t.test('toggle uses only original CAS body; readback confirms same full definition',async()=>{const s=setup();await s.guard.submit(payload());const r=s.rows[0];assert((await s.guard.submit({id:r.id,version:r.version,enabled:false})).confirmed);assert.deepEqual(s.writes()[1].body,{enabled:false,version:'1'});assert.equal(s.rows[0].name,'Nowa reguła');});
 }finally{await vite.close();}
});

test('Actual AutomationStudio React: lost create ACK persists guard across org switch/remount, controlled POST count stays1',async()=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(k,opts,fn)=>fn()}});
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client'),{LegacyAutomationStudio:AutomationStudio}=await vite.ssrLoadModule(path.resolve('web/operations.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 let activeTenant=tenant,activeUser=user,writes=0,rows=[];const el=document.createElement('div');document.body.append(el);let root=createRoot(el);
 globalThis.fetch=async(url,init={})=>{
  const p=String(url).slice(4),method=init.method??'GET';
  if(p==='/auth/me')return Response.json({user:{tenant_id:activeTenant,id:activeUser,role:'admin'},restore_preview:false});
  if(p==='/automations'&&method==='POST'){
   writes++;const b=JSON.parse(init.body);rows.push({id:id(80),tenant_id:activeTenant,actor_id:activeUser,version:'1',...b,definition:b});throw TypeError('Response lost after commit');
  }
  assert.equal(method,'GET','unexpected mutation '+p);
  if(p==='/automations')return Response.json({data:rows.filter(r=>r.tenant_id===activeTenant),jobs:[]});
  if(p==='/settings')return Response.json({warehouses:[]});
  if(p==='/automations/local-effects/options')return Response.json({channels:[],smtp_channels:[],warehouses:[],listings_truncated:false,processor_running:true});
  return Response.json({data:[],meta:{has_more:false,cursor:null}});
 };
 const props=()=>({workerContextKey:activeTenant+':'+activeUser,admin:true,readOnly:false,refresh:0,reload(){},notify(){}});
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<50&&!fn();i++)await tick();assert(fn());}
 const button=text=>[...el.querySelectorAll('button')].find(x=>x.textContent.trim()===text);
 // Invoke actual React input handler with its normal target value, without HTTP/listener.
 async function change(input,value){const key=Object.keys(input).find(k=>k.startsWith('__reactProps$'));assert(key);await React.act(async()=>input[key].onChange({target:{value}}));}
 try{
  api.setWorkspace(tenant);await React.act(async()=>root.render(React.createElement(AutomationStudio,props())));await until(()=>button('Nowa reguła')&&!button('Nowa reguła').disabled);
  await React.act(async()=>button('Nowa reguła').click());await change(el.querySelector('input[minlength="2"]'),'Unikalna reguła');await change(el.querySelector('input[aria-label="Treść notatki"]'),'Gotowe');
  await React.act(async()=>el.querySelector('form.rule-editor').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await until(()=>el.textContent.includes('Brak potwierdzonego ID'));
  assert.equal(writes,1);assert(button('Nowa reguła').disabled);assert(button('Zapisz regułę').disabled);
  await React.act(async()=>button('Odczytaj wynik zapisu reguły').click());await until(()=>el.textContent.includes('kandydatury'));assert.equal(writes,1);assert(button('Zapisz regułę').disabled);
  activeTenant=id(3);activeUser=id(4);api.setWorkspace(activeTenant);await React.act(async()=>root.render(React.createElement(AutomationStudio,props())));await until(()=>button('Nowa reguła')&&!button('Nowa reguła').disabled);assert(!el.textContent.includes('Brak potwierdzonego ID'));assert.equal(el.querySelectorAll('form.rule-editor').length,0);assert.equal(writes,1);
  activeTenant=tenant;activeUser=user;api.setWorkspace(tenant);await React.act(async()=>root.render(React.createElement(AutomationStudio,props())));await until(()=>el.textContent.includes('Brak potwierdzonego ID'));assert(button('Nowa reguła').disabled);assert.equal(writes,1);
  await React.act(async()=>root.unmount());root=createRoot(el);await React.act(async()=>root.render(React.createElement(AutomationStudio,props())));await until(()=>el.textContent.includes('Brak potwierdzonego ID'));assert(button('Nowa reguła').disabled);assert.equal(writes,1);
 }finally{await React.act(async()=>root.unmount());el.remove();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
