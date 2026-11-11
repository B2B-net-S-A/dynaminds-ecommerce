import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React,{act,useState} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant=id(1),actor=id(2),catalog=id(3),foreignCatalog=id(4),warehouse=id(5),otherWarehouse=id(6);
const row=n=>({id:id(n+100),version:1,sku:'SKU-'+n,name:'Produkt '+n,catalog_id:catalog,kind:'simple',images:[],price:1000,available:7,reserved:2,active:true,category:'',ean:null});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('CatalogPanel daily list: actual React with controlled HTTP; no DB/listener/business writes',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),{CatalogPanel}=await vite.ssrLoadModule(path.resolve('web/catalog.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts')),m=await vite.ssrLoadModule(path.resolve('web/catalog-list-model.ts'));
 let fixture,handles=[];
 async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
 async function until(fn,note){for(let n=0;n<80;n++){if(fn())return;await tick();}assert(fn(),note);}
 function button(h,text){const e=[...h.el.querySelectorAll('button')].find(x=>x.textContent.trim()===text);assert(e,text);return e;}
 async function click(e){assert(e&&!e.matches(':disabled'));await act(async()=>e.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 async function select(e,v){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('change',{bubbles:true}));});}
 async function input(e,v){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));});}
 function reset(){fixture={requests:[],hold:null,fail:false,empty:false,foreign:false};globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname.replace(/^\/api/,'');assert.equal(init.method??'GET','GET','This list must not mutate business state');fixture.requests.push(u.pathname+u.search);
  if(route==='/product-catalogs/options')return Response.json({available:true,can_read:true,catalogs:[{id:catalog,name:'Własny katalog',active:true,is_default:true,settings:{warehouse_ids:[warehouse],price_list_ids:[]}}]});
  if(route==='/warehouses')return Response.json({data:[{id:warehouse,name:'Główny'},{id:otherWarehouse,name:'Rezerwowy'}]});
  assert.equal(route,'/products');const held=fixture.hold;fixture.hold=null;if(held)return held.promise;
  if(fixture.fail)return Response.json({detail:'Chwilowo niedostępne'},{status:503});
  const start=u.searchParams.has('after')?51:1,rows=fixture.empty?[]:Array.from({length:50},(_,i)=>({...row(start+i),...(fixture.foreign?{catalog_id:foreignCatalog}:{}),available:u.searchParams.has('warehouse_id')?3:7}));
  return Response.json({data:rows,meta:{has_more:!fixture.empty&&start===1,cursor:!fixture.empty&&start===1?rows.at(-1).id:null}});
 };api.setWorkspace(tenant);}
 function Host(props){const [search,setSearch]=useState('');return React.createElement(CatalogPanel,{workspaceId:tenant,actorId:actor,contextKey:tenant+':'+actor+':admin',readOnly:false,admin:true,refresh:0,reload(){},notify(){},...props,search,setSearch});}
 async function mount(props={}){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);const h={el,root,async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);await act(async()=>root.render(React.createElement(Host,props)));await until(()=>el.textContent.includes('Produkt 1'),'first page');return h;}
 try{
  await t.test('100 explicit selections across two pages, exact warehouse API query and filter reset',async()=>{
   reset();const h=await mount();await click(h.el.querySelector('input[aria-label="Wybierz produkty z tej strony"]'));await click(button(h,'Następna'));
   await until(()=>h.el.textContent.includes('Produkt 51'),'second page');assert(h.el.textContent.includes('Wybrano 50'));assert(h.el.textContent.includes('50 na pozostałych'));
   await click(h.el.querySelector('input[aria-label="Wybierz produkty z tej strony"]'));assert(h.el.textContent.includes('Wybrano 100'));assert.equal(button(h,'Edytuj w arkuszu · 100').disabled,false);
   await select(h.el.querySelector('select[aria-label="Stany w magazynie"]'),warehouse);await until(()=>fixture.requests.some(x=>x.includes('warehouse_id='+warehouse))&&h.el.textContent.includes('Produkt 1'),'warehouse query');
   assert(h.el.textContent.includes('Wybrano 0'));assert(h.el.textContent.includes('Stany: Główny'));assert(h.el.textContent.includes('3 szt.'));assert(!fixture.requests.at(-1).includes('after='));await h.close();
  });
  await t.test('late old-filter response cannot replace current stock or expose stale rows',async()=>{
   reset();const h=await mount(),hold=deferred();fixture.hold=hold;await select(h.el.querySelector('select[aria-label="Stany w magazynie"]'),warehouse);await until(()=>fixture.requests.some(x=>x.includes('warehouse_id=')),'held request started');
   assert(!h.el.textContent.includes('Produkt 1'));assert(button(h,'Następna').disabled);await select(h.el.querySelector('select[aria-label="Stany w magazynie"]'),'');await until(()=>h.el.textContent.includes('Produkt 1'),'current all-warehouse response');
   await act(async()=>hold.resolve(Response.json({data:[{...row(99),name:'STARY MAGAZYN',available:999}],meta:{has_more:false,cursor:null}})));await tick();assert(!h.el.textContent.includes('STARY MAGAZYN'));assert(h.el.textContent.includes('7 szt.'));await h.close();
  });
  await t.test('failed and malformed reads hide old rows, retry is explicit GET and empty state is useful',async()=>{
   reset();const h=await mount();fixture.fail=true;await click(button(h,'Odśwież listę'));await until(()=>h.el.textContent.includes('Lista nie została wczytana'),'failed read');assert(!h.el.textContent.includes('Produkt 1'));
   fixture.fail=false;fixture.foreign=true;await select(h.el.querySelector('select[aria-label="Katalog listy produktów"]'),catalog);await until(()=>h.el.textContent.includes('nie odpowiada wybranemu katalogowi'),'foreign DTO refused');assert(!h.el.textContent.includes('Produkt 1'));
   fixture.foreign=false;fixture.empty=true;await click(button(h,'Odśwież listę'));await until(()=>h.el.textContent.includes('Brak produktów dla tego wyszukiwania'),'empty state');assert(button(h,'Następna').disabled);await h.close();
  });
  await t.test('search clears explicit selection and resets pagination while read-only still allows scoped reads',async()=>{
   reset();const h=await mount({readOnly:true});await click(h.el.querySelector('input[aria-label="Wybierz produkty z tej strony"]'));await input(h.el.querySelector('input[aria-label="Szukaj produktów"]'),'szukane SKU');await until(()=>fixture.requests.some(x=>x.includes('search=szukane+SKU')),'normal search query');assert(h.el.textContent.includes('Wybrano 0'));await h.close();
  });
  await t.test('500-limit selection is atomic, preserves originals and excludes unknown identity',()=>{
   const rows=Array.from({length:500},(_,i)=>row(i+1)),all=m.toggleCatalogPage({},rows,true);assert.equal(Object.keys(all).length,500);assert.throws(()=>m.toggleCatalogPage(all,[row(501)],true),/Nie dodano żadnej/);assert.equal(Object.keys(all).length,500);
   assert.equal(Object.keys(m.toggleCatalogPage(all,rows.slice(0,50),false)).length,450);assert.throws(()=>m.toggleCatalogPage({},[{...row(1),version:NaN}],true));assert.deepEqual(m.catalogSelectionSummary(all,rows.slice(0,50)),{total:500,visible:50,otherPages:450});
  });
  await t.test('cursor/duplicates/catalog mismatch and malformed warehouse metadata refuse',()=>{
   const p={data:[row(1)],meta:{has_more:false,cursor:null}};assert.equal(m.readCatalogList(p,catalog,''),p);
   for(const bad of [{...p,data:[row(1),row(1)]},{...p,meta:{has_more:true,cursor:row(2).id}},{...p,data:[{...row(1),images:null}]}])assert.throws(()=>m.readCatalogList(bad,catalog,''));
   assert.throws(()=>m.readCatalogList(p,foreignCatalog,''));assert.throws(()=>m.readCatalogWarehouses({data:[{id:warehouse,name:'A'},{id:warehouse,name:'B'}]}));assert.throws(()=>m.catalogListQuery({search:'',catalogId:'../../foreign',warehouseId:'',page:''}));
  });
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
