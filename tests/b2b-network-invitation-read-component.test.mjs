/** Actual mounted B2bNetwork/React history UI with controlled GET responses.
 * No browser account, PostgreSQL, live provider or product acceptance claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {webcrypto} from 'node:crypto';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000001`;
const tenant=id(1),actor=id(2),account=id(3),otherAccount=id(4),otherTenant=id(5),otherActor=id(6),stamp='2026-10-18T12:00:00.000123Z';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const row=(n,state='pending',expired=false)=>({id:id(n),state,expired,account_version:1,created_at:'2026-10-18T10:00:00.000123Z',expires_at:'2026-10-19T10:00:00.000123Z'});
const page=(a,rows,next=null)=>({account:{id:a,version:2},expiry_evaluated_at:stamp,data:rows,next});
function fixture(){
 const f={calls:[],held:null,error:false,empty:false,malformed:false};
 f.fetch=async(url,init={})=>{
  const u=new URL(String(url),'http://127.0.0.1'),p=u.pathname.replace(/^\/api/,''),method=init.method??'GET',workspace=new Headers(init.headers).get('X-Workspace-ID');
  f.calls.push({path:p,query:u.search,method,workspace});assert.equal(method,'GET','history never sends a mutation or repeats an invite');
  if(p==='/b2b/network/links')return Response.json({data:[],next:null,currency:'PLN'});
  if(p==='/b2b/accounts')return Response.json({data:[{id:account,name:workspace===otherTenant?'Nowa firma konto':'Pierwszy kontrahent',active:true},{id:otherAccount,name:'Drugie konto nieaktywne',active:false}],next:null});
  if(p==='/warehouses')return Response.json({data:[]});
  const m=p.match(/^\/b2b\/accounts\/([^/]+)\/network-invitations$/);
  if(m){assert.equal(u.searchParams.get('limit'),'25');
   if(f.held&&m[1]===account)return f.held.promise;
   if(f.error)return Response.json({detail:'Historia chwilowo niedostępna.'},{status:503});
   let value=f.empty?page(m[1],[]):m[1]===otherAccount?page(m[1],[row(77,'accepted')]):u.searchParams.has('after')?page(account,[row(80,'revoked')]):page(account,[row(70,'pending',true),row(71,'accepted')],'opaque-next-page');
   if(f.malformed)value={...value,data:[{...row(90),token_hash:'PRIVATE-NOT-FOR-UI'}]};
   return Response.json(value);
  }
  throw Error('Unexpected controlled GET '+p);
 };
 return f;
}
async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(fn,note){for(let i=0;i<100;i++){if(fn())return;await tick();}assert(fn(),note);}
async function choose(el,value){assert(el);await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true}));});}
async function click(el){assert(el);assert.equal(el.disabled,false);await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
const panel=h=>h.container.querySelector('[aria-label="Historia zaproszeń sieci B2B"]');
const select=h=>panel(h)?.querySelector('[aria-label="Konto kontrahenta do historii"]');
const button=(h,text)=>[...panel(h).querySelectorAll('button')].find(b=>b.textContent.trim()===text);

test('actual normal B2B screen invitation read history',async t=>{
 const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,FormData:dom.window.FormData,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value});}
 let vite;const mounts=[];
 try{
  vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
  const{createRoot}=await import('react-dom/client'),{B2bNetwork}=await vite.ssrLoadModule(path.resolve('web/b2b-network.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
  async function mount(f,props={}){globalThis.fetch=f.fetch;api.setWorkspace(tenant);const container=document.createElement('div');document.body.append(container);const root=createRoot(container),h={container,props:{admin:true,readOnly:false,contextKey:`${tenant}:${actor}:admin`,...props},async render(patch={}){h.props={...h.props,...patch};await act(async()=>root.render(React.createElement(B2bNetwork,h.props)));},async close(){await act(async()=>root.unmount());container.remove();}};mounts.push(h);await h.render();return h;}
  async function ready(h){await until(()=>select(h)?.options.length===3,'Actual parent accounts wired to the history selector');}
  await t.test('select, manual refresh and older/latest navigation show persisted states using GET only',async()=>{
   const f=fixture(),h=await mount(f);try{await ready(h);assert.equal(f.calls.filter(c=>c.path.endsWith('/network-invitations')).length,0);
    await choose(select(h),account);await until(()=>panel(h).textContent.includes('Wygasłe'),'Derived expired pending');assert(panel(h).textContent.includes('Przyjęte'));assert(!panel(h).textContent.includes('PRIVATE'));
    await click(button(h,'Starsze zaproszenia'));await until(()=>panel(h).textContent.includes('Cofnięte'),'Older page');assert(f.calls.some(c=>c.query.includes('after=opaque-next-page')));
    await click(button(h,'Najnowsze zaproszenia'));await until(()=>panel(h).textContent.includes('Wygasłe'),'Latest page');const count=f.calls.length;await click(button(h,'Odśwież historię zaproszeń'));await until(()=>panel(h).textContent.includes('Wygasłe'),'Explicit read refresh');assert(f.calls.length>count);assert(f.calls.every(c=>c.method==='GET'));
   }finally{await h.close();}
  });
  await t.test('account switch rejects a delayed old response and loading is visible',async()=>{
   const f=fixture();f.held=deferred();const h=await mount(f);try{await ready(h);await choose(select(h),account);await until(()=>panel(h).textContent.includes('Odczytywanie'),'Loading state');
    await choose(select(h),otherAccount);await until(()=>panel(h).textContent.includes(id(77)),'New selected account read');
    await act(async()=>f.held.resolve(Response.json(page(account,[row(999,'revoked')]))));await tick();assert(panel(h).textContent.includes(id(77)));assert(!panel(h).textContent.includes(id(999)));
   }finally{await h.close();}
  });
  await t.test('actor/tenant change clears selection and rejects old-context data before another user selects an account',async()=>{
   const f=fixture();f.held=deferred();const h=await mount(f);try{await ready(h);await choose(select(h),account);await until(()=>panel(h).textContent.includes('Odczytywanie'),'First context request');
    api.setWorkspace(otherTenant);await h.render({contextKey:`${otherTenant}:${otherActor}:admin`});await until(()=>select(h)?.options[1]?.textContent==='Nowa firma konto','New context accounts');assert.equal(select(h).value,'');assert(!panel(h).textContent.includes('Pierwszy kontrahent'));
    await act(async()=>f.held.resolve(Response.json(page(account,[row(999,'accepted')]))));await tick();assert(!panel(h).textContent.includes(id(999)));assert(!panel(h).textContent.includes('Przyjęte'));
   }finally{await h.close();}
  });
  await t.test('errors, empty history and malformed private fields refuse then recover by explicit refresh without POST',async()=>{
   const f=fixture();f.error=true;const h=await mount(f);try{await ready(h);await choose(select(h),account);await until(()=>panel(h).querySelector('[role="alert"]'),'Visible read failure');assert(!panel(h).querySelector('li'));
    f.error=false;f.empty=true;await click(button(h,'Odśwież historię zaproszeń'));await until(()=>panel(h).textContent.includes('Brak zaproszeń na tej stronie.'),'Empty successful read');
    f.empty=false;f.malformed=true;await click(button(h,'Odśwież historię zaproszeń'));await until(()=>panel(h).textContent.includes('Niepełny odczyt historii'),'Malformed DTO refused');assert(!panel(h).textContent.includes('PRIVATE-NOT-FOR-UI'));assert(!panel(h).querySelector('li'));assert(f.calls.every(c=>c.method==='GET'));
   }finally{await h.close();}
  });
  await t.test('non-admin has no invitation-history surface while admin read-only mode still permits reads',async()=>{
   let f=fixture(),h=await mount(f,{admin:false,contextKey:`${tenant}:${actor}:viewer`});try{await tick();assert.equal(panel(h),null);assert(!f.calls.some(c=>c.path.endsWith('/network-invitations')));}finally{await h.close();}
   f=fixture();h=await mount(f,{readOnly:true});try{await ready(h);await choose(select(h),otherAccount);await until(()=>panel(h).textContent.includes('Przyjęte'),'Inactive account history remains readable');assert(f.calls.every(c=>c.method==='GET'));}finally{await h.close();}
  });
 }finally{for(const h of mounts)if(h.container.isConnected)await h.close();await vite?.close();globalThis.fetch=oldFetch;for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
