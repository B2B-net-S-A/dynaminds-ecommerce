import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React,{act,useState} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant=id(1),actor=id(2),catalog=id(3),warehouse=id(5),productId=id(101);
const row=n=>({id:id(n+100),version:1,sku:'SKU-'+n,name:'Produkt '+n,catalog_id:catalog,kind:'simple',images:[],price:1000,available:7,reserved:2,active:true,category:'',ean:null});
const card=()=>({...row(1),version:4,vat:23,description:'',attributes:{},variants:[],components:[],stock:[]});
test('CatalogPanel product deletion: admin-only confirm dialog with controlled HTTP; no DB/listener',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),{CatalogPanel}=await vite.ssrLoadModule(path.resolve('web/catalog.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts')),m=await vite.ssrLoadModule(path.resolve('web/catalog-list-model.ts'));
 let fixture,handles=[];
 async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
 async function until(fn,note){for(let n=0;n<80;n++){if(fn())return;await tick();}assert(fn(),note);}
 const buttons=(h,text)=>[...h.el.querySelectorAll('button')].filter(x=>x.textContent.trim()===text);
 function button(h,text){const e=buttons(h,text).at(-1);assert(e,text);return e;}
 async function click(e){assert(e&&!e.matches(':disabled'));await act(async()=>e.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 async function type(e,v){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));});}
 async function submit(h){await act(async()=>h.el.querySelector('[role="dialog"] form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}
 function reset(){fixture={requests:[],deletions:[],answers:[],hold:null,notes:[],reloads:0};globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname.replace(/^\/api/,''),method=init.method??'GET';fixture.requests.push(method+' '+route);
  if(method!=='GET'){assert.equal(method,'POST');assert.equal(route,'/products/'+productId+'/deletion','only the deletion command may write');fixture.deletions.push(JSON.parse(init.body));
   const held=fixture.hold;fixture.hold=null;if(held)await held;const [status,body]=fixture.answers.shift();return Response.json(body,{status});}
  if(route==='/product-catalogs/options')return Response.json({available:true,can_read:true,catalogs:[{id:catalog,name:'Własny katalog',active:true,is_default:true,settings:{warehouse_ids:[warehouse],price_list_ids:[]}}]});
  if(route==='/warehouses')return Response.json({data:[{id:warehouse,name:'Główny'}]});
  if(route==='/products')return Response.json({data:[row(1),row(2)],meta:{has_more:false,cursor:null}});
  if(route==='/products/'+productId)return Response.json(card());
  return Response.json({detail:'Niedostępne w teście'},{status:404});
 };api.setWorkspace(tenant);}
 function Host(props){const [search,setSearch]=useState('');return React.createElement(CatalogPanel,{workspaceId:tenant,actorId:actor,contextKey:tenant+':'+actor+':admin',readOnly:false,admin:true,refresh:0,reload(){fixture.reloads++;},notify(s,error){fixture.notes.push([s,!!error]);},...props,search,setSearch});}
 async function openCard(props={}){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);const h={el,root,async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);
  await act(async()=>root.render(React.createElement(Host,props)));await until(()=>el.textContent.includes('Produkt 1'),'list');
  await click(buttons(h,'Produkt 1')[0]??[...el.querySelectorAll('button')].find(x=>x.textContent.includes('Produkt 1')));await until(()=>el.querySelector('[aria-label="Karta produktu"]'),'card');return h;}
 try{
  await t.test('non-admin and read-only cards do not offer a usable deletion',async()=>{
   reset();let h=await openCard({admin:false});assert.equal(buttons(h,'Usuń produkt').length,0);await h.close();
   h=await openCard({readOnly:true});assert(button(h,'Usuń produkt').disabled);await h.close();
  });
  await t.test('409 keeps the dialog with the server reason; cancel returns to the card without writing',async()=>{
   reset();const h=await openCard();await click(button(h,'Usuń produkt'));await until(()=>h.el.querySelector('[aria-label="Usuń produkt"]'),'confirm dialog');
   const text=h.el.querySelector('[role="dialog"]').textContent;for(const part of ['SKU-1','Base API','zachowają','pozostanie zarezerwowane','nie można cofnąć'])assert(text.includes(part),part);
   assert.equal(fixture.deletions.length,0);
   fixture.answers.push([409,{detail:'Produkt ma stan magazynowy lub rezerwacje. Wyzeruj stan przed usunięciem.'}]);await submit(h);
   await until(()=>h.el.querySelector('[role="alert"]')?.textContent.includes('Wyzeruj stan'),'server reason');assert(h.el.querySelector('[aria-label="Usuń produkt"]'),'dialog stays open');
   assert.deepEqual(fixture.deletions,[{version:4}]);assert.equal(button(h,'Usuń produkt').disabled,false,'409 may be retried after fixing stock');assert.equal(fixture.reloads,0);
   await click(button(h,'Anuluj'));await until(()=>h.el.querySelector('[aria-label="Karta produktu"]'),'back to card');assert.equal(fixture.deletions.length,1);await h.close();
  });
  await t.test('success sends version and trimmed reason once, disables while sending, closes the card and refreshes',async()=>{
   reset();const h=await openCard();await click(button(h,'Usuń produkt'));await until(()=>h.el.querySelector('[aria-label="Usuń produkt"] textarea'),'reason');
   await type(h.el.querySelector('[aria-label="Usuń produkt"] textarea'),'  Wycofany z oferty  ');
   let release;fixture.hold=new Promise(r=>release=r);fixture.answers.push([200,{id:productId,sku:'SKU-1',deleted:true,deleted_at:'2026-10-23T10:00:00.000Z'}]);
   await submit(h);await until(()=>buttons(h,'Usuwanie…').length===1,'busy');assert(button(h,'Usuwanie…').disabled);assert(button(h,'Anuluj').disabled);
   await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape'})));await act(async()=>window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape'})));assert(h.el.querySelector('[aria-label="Usuń produkt"]'),'cannot close while sending');
   await submit(h);await act(async()=>release());await until(()=>!h.el.querySelector('[role="dialog"]'),'card closed');
   assert.deepEqual(fixture.deletions,[{version:4,reason:'Wycofany z oferty'}]);assert.equal(fixture.reloads,1);assert.deepEqual(fixture.notes.at(-1),['Usunięto produkt SKU-1. SKU pozostaje zarezerwowane.',false]);await h.close();
  });
  await t.test('503 missing migration is shown and blocks a retry',async()=>{
   reset();const h=await openCard();await click(button(h,'Usuń produkt'));await until(()=>h.el.querySelector('[aria-label="Usuń produkt"]'),'confirm dialog');
   fixture.answers.push([503,{detail:'Kopia nie obsługuje usuwania produktów (migracja 225)'}]);await submit(h);
   await until(()=>h.el.querySelector('[role="alert"]')?.textContent.includes('migracja 225'),'503 reason');assert(button(h,'Usuń produkt').disabled);await h.close();
  });
  await t.test('deletion model: body trims/omits the reason and refuses bad input; response must match the product',()=>{
   assert.deepEqual(m.productDeletionBody(3,'   '),{version:3});assert.deepEqual(m.productDeletionBody(3,' powód '),{version:3,reason:'powód'});
   assert.deepEqual(m.productDeletionBody(3,' '+'x'.repeat(500)+' '),{version:3,reason:'x'.repeat(500)});assert.throws(()=>m.productDeletionBody(3,'x'.repeat(501)),/500 znaków/);
   for(const v of [0,NaN,1.5,undefined])assert.throws(()=>m.productDeletionBody(v,''),/wersji/);
   const ok={id:productId,sku:'SKU-1',deleted:true,deleted_at:'2026-10-23T10:00:00.000Z'};assert.equal(m.readProductDeletion(ok,productId),ok);
   for(const bad of [null,{...ok,id:id(102)},{...ok,deleted:false},{...ok,sku:''},{...ok,deleted_at:null}])assert.throws(()=>m.readProductDeletion(bad,productId),/Niepełne potwierdzenie/);
  });
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
