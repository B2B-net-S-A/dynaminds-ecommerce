import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,tenant=id(1),user=id(2),catalog=id(3),warehouse=id(4),scope=tenant+':'+user+':admin:false';
const flags={available:true,read_only:false,current_role:'admin',can_read:true,can_manage:true};
const settings={name:'Katalog własny',active:true,languages:['pl'],default_language:'pl',warehouse_ids:[warehouse],price_list_ids:[]};
const row=()=>({id:catalog,name:settings.name,active:true,is_default:false,version:'1',settings:structuredClone(settings),product_count:0,created_at:'2026-10-16T10:00:00Z',updated_at:'2026-10-16T10:00:00Z'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
const source=fs.readFileSync(new URL('./product-catalogs.tsx',import.meta.url),'utf8').replace("import './product-catalogs.css';",'');
const code=transformSync(source,{loader:'tsx',format:'cjs',jsx:'automatic'}).code,require=createRequire(import.meta.url);
function compile(api){const module={exports:{}};new Function('module','exports','require',code)(module,module.exports,p=>p==='./api'?{api,ApiError,date:x=>x}:require(p));return module.exports;}

test('actual catalogue React: fresh postACK baseline, parent product count, drafts/context/unknown guards',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map();
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const{createRoot}=await import('react-dom/client');const handles=[];
 const tick=async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});};
 async function until(fn,note){for(let n=0;n<80;n++){if(fn())return;await tick();}assert(fn(),note);}
 const button=(h,text)=>{const b=[...h.el.querySelectorAll('button')].find(x=>x.textContent.trim()===text);assert(b,text);return b;};
 async function click(e){assert(e&&!e.matches(':disabled'));await act(async()=>e.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 async function select(e,v){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('change',{bubbles:true}));});}
 async function input(e,v){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));});}
 function fixture(){return{catalog:row(),requests:[],preview:null,operation:null,unknown:false,holdOptions:null,holdDetail:null,foreignDetail:false,actor:{id:user,tenant_id:tenant,role:'admin'}};}
 function port(f){return async(path,method='GET',body)=>{
  f.requests.push({path,method,body:body===undefined?null:structuredClone(body)});
  if(path==='/auth/me')return{user:structuredClone(f.actor)};
  if(path==='/product-catalogs/options'){if(f.holdOptions){const h=f.holdOptions;f.holdOptions=null;return h.promise;}return options(f);}
  if(path==='/product-catalogs/'+catalog){if(f.operation&&f.holdDetail){const h=f.holdDetail;f.holdDetail=null;return h.promise;}return{...flags,catalog:{...structuredClone(f.catalog),...(f.operation&&f.foreignDetail?{id:id(99)}:{})}};}
  if(path==='/product-catalogs/previews'&&method==='POST'){
   assert.equal(body.kind,'update');assert.equal(body.catalog_id,catalog);assert.equal(body.version,f.catalog.version,'next edit must use genuinely fresh version');
   f.preview={id:id(10),kind:'update',catalog_id:catalog,version:f.catalog.version,client_key:body.client_key,scope_hash:'a'.repeat(64),before:structuredClone(f.catalog),after:structuredClone(body.settings),resources:{warehouses:[{id:warehouse,name:'Główny'}],price_lists:[],languages:['pl']},blockers:[],ready:true,created_at:'2026-10-16T10:00:00Z',expires_at:'2099-10-16T10:00:00Z',can_commit:true,operation_id:null};return{...flags,preview:structuredClone(f.preview),reused:false};
  }
  if(path==='/product-catalogs/previews/'+id(10)+'/commit'&&method==='POST'){
   if(!f.operation){const before=structuredClone(f.catalog);f.catalog={...f.catalog,name:f.preview.after.name,version:String(BigInt(f.catalog.version)+1n),settings:structuredClone(f.preview.after)};f.operation={id:id(11),preview_id:f.preview.id,catalog_id:catalog,kind:'update',client_key:body.client_key,request:structuredClone(body),before,after:structuredClone(f.catalog),scope_hash:body.scope_hash,created_at:'2026-10-16T10:00:00Z'};}
   if(f.unknown)throw new ApiError('Controlled unknown ACK',500);
   return{...flags,operation:structuredClone(f.operation),catalog:structuredClone(f.catalog),reused:false};
  }
  throw Error('Unexpected controlled API '+method+' '+path);
 };}
 const options=f=>({...flags,catalogs:[structuredClone(f.catalog)],warehouses:[{id:warehouse,name:'Główny'}],price_lists:[],languages:['pl'],capabilities:{},limits:{}});
 async function mount(){const f=fixture(),m=compile(port(f)),el=document.createElement('div');document.body.append(el);const root=createRoot(el);const h={el,root,f,m,props:{contextKey:scope,readOnly:false,refresh:0},async render(p={}){h.props={...h.props,...p};await act(async()=>root.render(React.createElement(m.ProductCatalogsPanel,h.props)));},async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);await h.render();await until(()=>el.querySelector('select option[value="'+catalog+'"]'),'options');await select(el.querySelector('select'),catalog);await until(()=>el.querySelector('legend')?.textContent.includes('wersja 1'),'initial detail');return h;}
 async function preview(h){await click(button(h,'Przygotuj podgląd katalogu'));await until(()=>h.el.textContent.includes('Pełny zapisany podgląd konfiguracji'),'preview');}
 async function commit(h){const consent=[...h.el.querySelectorAll('input[type="checkbox"]')].find(x=>x.closest('label')?.textContent.includes('Sprawdziłem pełną'));await click(consent);await click(button(h,'Zapisz zatwierdzony katalog'));}
 try{
  await t.test('commit ACK1→2 uses GETdetail baseline2, next explicit preview sends2, no commit replay',async()=>{const h=await mount();await preview(h);await commit(h);await until(()=>h.el.querySelector('legend')?.textContent.includes('wersja 2'),'fresh baseline2');assert(h.el.textContent.includes('zapisana wersja 2'));assert.equal(h.f.requests.filter(x=>x.method==='POST').length,2);const posts=h.f.requests.filter(x=>x.method==='POST');const commitAt=h.f.requests.findIndex(x=>x===posts[1]);assert(h.f.requests.slice(commitAt+1).some(x=>x.method==='GET'&&x.path==='/product-catalogs/'+catalog));await input(h.el.querySelector('input[maxlength="120"]'),'Druga konfiguracja');await preview(h);assert.equal(h.f.requests.filter(x=>x.method==='POST').at(-1).body.version,'2');await h.close();});
  await t.test('parent refresh updates live product count but preserves current user draft',async()=>{const h=await mount();await input(h.el.querySelector('input[maxlength="120"]'),'Niezapisany szkic');h.f.catalog.product_count=1;await h.render({refresh:1});await until(()=>h.el.querySelector('option[value="'+catalog+'"]').textContent.includes('1 produktów'),'count1');assert.equal(h.el.querySelector('input[maxlength="120"]').value,'Niezapisany szkic');assert(h.el.querySelector('legend').textContent.includes('wersja 1'));assert.equal(h.f.requests.filter(x=>x.method==='POST').length,0);await h.close();});
  await t.test('late earlier options response cannot overwrite newer parent refresh or draft',async()=>{const h=await mount(),old=options(h.f),held=deferred();old.catalogs[0].product_count=99;h.f.holdOptions=held;await h.render({refresh:1});await until(()=>h.f.holdOptions===null,'held options started');h.f.catalog.product_count=2;await h.render({refresh:2});await until(()=>h.el.querySelector('option[value="'+catalog+'"]').textContent.includes('2 produktów'),'new count2');await act(async()=>held.resolve(old));await tick();assert(h.el.querySelector('option[value="'+catalog+'"]').textContent.includes('2 produktów'));await h.close();});
  await t.test('unknown commit remains locked after parent options GET and never rePOSTs itself',async()=>{const h=await mount();await preview(h);h.f.unknown=true;await commit(h);await until(()=>h.el.textContent.includes('Wynik zapisu jest niepewny'),'unknown held');assert(h.m.productCatalogsWriteLocked(scope));const posts=h.f.requests.filter(x=>x.method==='POST').length;h.f.catalog.product_count=1;await h.render({refresh:1});await until(()=>h.el.querySelector('option[value="'+catalog+'"]').textContent.includes('1 produktów'),'refreshed options only');assert(h.m.productCatalogsWriteLocked(scope));assert.equal(h.f.requests.filter(x=>x.method==='POST').length,posts);await h.close();});
  await t.test('late postACK detail from old actor cannot populate the next context',async()=>{const h=await mount(),held=deferred();await preview(h);h.f.holdDetail=held;await commit(h);await until(()=>h.f.holdDetail===null,'postACK detail held');h.f.actor={id:id(22),tenant_id:id(21),role:'admin'};const next=h.f.actor.tenant_id+':'+h.f.actor.id+':admin:false';await h.render({contextKey:next});await act(async()=>held.resolve({...flags,catalog:{...row(),version:'2',name:'CUDZY STARY ODCZYT'}}));await tick();assert(!h.el.textContent.includes('CUDZY STARY ODCZYT'));assert(!h.el.querySelector('legend'));await h.close();});
  await t.test('newer own detail keeps receipt2 but advances next baseline3; regressing detail1 refuses',async()=>{
   for(const v of ['3','1']){const h=await mount(),held=deferred();await preview(h);h.f.holdDetail=held;await commit(h);await until(()=>h.f.holdDetail===null,'detail held');const detail={...structuredClone(h.f.catalog),version:v};if(v==='3')h.f.catalog=structuredClone(detail);await act(async()=>held.resolve({...flags,catalog:detail}));if(v==='3'){await until(()=>h.el.querySelector('legend')?.textContent.includes('wersja 3'),'current own version3');assert(h.el.textContent.includes('zapisana wersja 2'));}else{await until(()=>h.el.textContent.includes('Nieaktualny lub obcy odczyt'),'regression refused');assert(!h.el.querySelector('legend')?.textContent.includes('wersja 1'));}assert.equal(h.f.requests.filter(x=>x.method==='POST').length,2);await h.close();}
  });
  await t.test('foreign postACK detail is refused; durable receipt stays known without anotherPOST',async()=>{const h=await mount();await preview(h);h.f.foreignDetail=true;await commit(h);await until(()=>h.el.textContent.includes('Nieaktualny lub obcy odczyt'),'foreign detail rejected');assert(h.el.textContent.includes('zapisana wersja 2'));assert(!h.m.productCatalogsWriteLocked(scope));assert.equal(h.f.requests.filter(x=>x.method==='POST').length,2);await h.close();});
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});


test('main integration is exactly one parent refresh prop; catalogue reset scope stays unchanged',()=>{
 // History: at integration (16.10) this was an exact whole-file inverse of web/main.tsx against the
 // one-off stock-file-import worktree draft product-catalog-ui-refresh-source/before/main.tsx
 // (226405 B, sha256 98ae14218021b5839c1be968a14e6b419b2e3cb6141147a618f155be1e323288), outside
 // this repo and superseded by later main.tsx work. The one-prop integration itself is pinned here.
 const after=fs.readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
 const old="<ProductCatalogsPanel key={'product-catalogs:' + stocktakeActorScope} contextKey={stocktakeActorScope} readOnly={restorePreview}";
 assert.equal(after.split('<ProductCatalogsPanel ').length,2,'exactly one catalogue panel mount');
 assert.equal(after.split(old+' refresh={refresh}').length,2,'the mount carries the one parent refresh prop');
 assert(source.includes('}, [scope, props.readOnly]);'));
});
