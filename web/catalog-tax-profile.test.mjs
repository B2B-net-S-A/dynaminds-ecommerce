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
const blank={version:null,category:'standard',exemption_basis_kind:null,exemption_basis:null,np_kind:null,gtu:null,annex15:false,oss_rate_class:'standard'};
const view=(profile=blank,extra={})=>({product_id:productId,sku:'SKU-1',product_vat:23,profile,updated_at:profile.version===null?null:'2026-10-23T10:00:00.000Z',read_only:false,...extra});
test('CatalogPanel "Podatek": profile view, admin edit form with controlled HTTP; no DB/listener',async t=>{
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),{CatalogPanel}=await vite.ssrLoadModule(path.resolve('web/catalog.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts')),m=await vite.ssrLoadModule(path.resolve('web/catalog-tax-profile.tsx'));
 let fixture,handles=[];
 async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
 async function until(fn,note){for(let n=0;n<80;n++){if(fn())return;await tick();}assert(fn(),note);}
 const buttons=(h,text)=>[...h.el.querySelectorAll('button')].filter(x=>x.textContent.trim()===text);
 function button(h,text){const e=buttons(h,text).at(-1);assert(e,text);return e;}
 async function click(e){assert(e&&!e.matches(':disabled'));await act(async()=>e.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
 const section=h=>h.el.querySelector('[aria-label="Podatek"]');
 const control=(h,label)=>[...section(h).querySelectorAll('label')].find(l=>l.textContent.startsWith(label)).querySelector('input,select');
 async function set(e,v){await act(async()=>{const proto=e.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,v);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
 async function submit(h){await act(async()=>section(h).querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}
 function reset(profile=view()){fixture={profile,puts:[],answers:[]};globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname.replace(/^\/api/,''),method=init.method??'GET';
  if(method!=='GET'){assert.equal(method,'PUT');assert.equal(route,'/products/'+productId+'/tax-profile','only the tax profile may write');fixture.puts.push(JSON.parse(init.body));const [status,body]=fixture.answers.shift();return Response.json(body,{status});}
  if(route==='/product-catalogs/options')return Response.json({available:true,can_read:true,catalogs:[{id:catalog,name:'Własny katalog',active:true,is_default:true,settings:{warehouse_ids:[warehouse],price_list_ids:[]}}]});
  if(route==='/warehouses')return Response.json({data:[{id:warehouse,name:'Główny'}]});
  if(route==='/products')return Response.json({data:[row(1),row(2)],meta:{has_more:false,cursor:null}});
  if(route==='/products/'+productId)return Response.json(card());
  if(route==='/products/'+productId+'/tax-profile'){const p=fixture.profile;return typeof p==='function'?p():Response.json(p);}
  return Response.json({detail:'Niedostępne w teście'},{status:404});
 };api.setWorkspace(tenant);}
 function Host(props){const [search,setSearch]=useState('');return React.createElement(CatalogPanel,{workspaceId:tenant,actorId:actor,contextKey:tenant+':'+actor+':admin',readOnly:false,admin:true,refresh:0,reload(){},notify(){},...props,search,setSearch});}
 async function openCard(props={}){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);const h={el,root,async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);
  await act(async()=>root.render(React.createElement(Host,props)));await until(()=>el.textContent.includes('Produkt 1'),'list');
  await click([...el.querySelectorAll('button')].find(x=>x.textContent.includes('Produkt 1')));await until(()=>section(h)?.querySelector('dl'),'tax section');return h;}
 try{
  await t.test('model: response must be the product\'s consistent profile; body nulls other categories and refuses incomplete ZW/NP',()=>{
   assert.equal(m.readProductTaxProfile(view(),productId).profile.category,'standard');
   const zw={...blank,version:3,category:'zw',exemption_basis_kind:'P_19A',exemption_basis:'art. 43 ust. 1 pkt 18'};assert.equal(m.readProductTaxProfile(view(zw),productId).profile.version,3);
   for(const bad of [null,view(blank,{product_id:id(102)}),view({...blank,category:'zw'}),view({...blank,exemption_basis_kind:'P_19A'}),view({...blank,category:'np'}),view({...blank,np_kind:'np_i'}),view({...blank,gtu:'GTU_14'}),view({...blank,oss_rate_class:'x'}),view({...blank,version:0}),view({...blank,version:2},{updated_at:null}),view(blank,{read_only:'nie'}),view({...zw,exemption_basis:'x'.repeat(257)})])
    assert.throws(()=>m.readProductTaxProfile(bad,productId),/obce dane podatkowe/);
   const d={category:'standard',exemption_basis_kind:'P_19B',exemption_basis:'stare',np_kind:'np_i',gtu:'GTU_01',annex15:true,oss_rate_class:'reduced_1'};
   assert.deepEqual(m.taxProfileBody(null,d),{version:null,category:'standard',exemption_basis_kind:null,exemption_basis:null,np_kind:null,gtu:'GTU_01',annex15:true,oss_rate_class:'reduced_1'});
   assert.deepEqual(m.taxProfileBody(2,{...d,category:'zw',exemption_basis:'  art. 43  '}),{version:2,category:'zw',exemption_basis_kind:'P_19B',exemption_basis:'art. 43',np_kind:null,gtu:'GTU_01',annex15:true,oss_rate_class:'reduced_1'});
   assert.equal(m.taxProfileBody(2,{...d,category:'np'}).np_kind,'np_i');
   assert.throws(()=>m.taxProfileBody(2,{...d,category:'zw',exemption_basis_kind:null}),/rodzaj podstawy/);assert.throws(()=>m.taxProfileBody(2,{...d,category:'zw',exemption_basis:'  '}),/podstawę prawną/);
   assert.throws(()=>m.taxProfileBody(2,{...d,category:'zw',exemption_basis:'x'.repeat(257)}),/256/);assert.throws(()=>m.taxProfileBody(2,{...d,category:'np',np_kind:null}),/NP I albo NP II/);
   for(const v of [0,1.5,NaN])assert.throws(()=>m.taxProfileBody(v,d),/wersji/);
  });
  await t.test('non-admin and read-only cards show the profile without a usable edit',async()=>{
   reset(view({...blank,version:2,gtu:'GTU_06',annex15:true}));let h=await openCard({admin:false});
   const text=section(h).textContent;for(const part of ['Zwykła stawka VAT 23%','GTU_06','Załącznik 15 (MPP)tak','Klasa stawki OSSPodstawowa'])assert(text.includes(part),part);
   assert.equal(buttons(h,'Zmień dane podatkowe').length,0);await h.close();
   h=await openCard({readOnly:true});assert(button(h,'Zmień dane podatkowe').disabled);await h.close();
   reset(view(blank,{read_only:true}));h=await openCard();assert(button(h,'Zmień dane podatkowe').disabled);assert(section(h).textContent.includes('Brak zapisanego profilu'));await h.close();
  });
  await t.test('admin sets ZW with basis: PUT carries version null and the basis; success shows the saved profile',async()=>{
   reset();const h=await openCard();await click(button(h,'Zmień dane podatkowe'));
   await set(control(h,'Kategoria'),'zw');await submit(h);await until(()=>section(h).querySelector('[role="alert"]'),'client refusal');assert.match(section(h).querySelector('[role="alert"]').textContent,/rodzaj podstawy/);assert.equal(fixture.puts.length,0);
   const kinds=[...control(h,'Rodzaj podstawy').options].map(o=>o.textContent);assert.deepEqual(kinds.slice(1),['P_19A — przepis ustawy/rozporządzenia','P_19B — przepis dyrektywy 2006/112/WE','P_19C — inna podstawa']);
   await set(control(h,'Rodzaj podstawy'),'P_19A');await set(control(h,'Podstawa prawna'),' art. 43 ust. 1 pkt 18 ');await set(control(h,'GTU'),'GTU_12');
   const stored={...blank,version:1,category:'zw',exemption_basis_kind:'P_19A',exemption_basis:'art. 43 ust. 1 pkt 18',gtu:'GTU_12'};fixture.answers.push([200,view(stored)]);await submit(h);
   await until(()=>section(h).querySelector('dl')&&!section(h).querySelector('form'),'saved view');
   assert.deepEqual(fixture.puts,[{version:null,category:'zw',exemption_basis_kind:'P_19A',exemption_basis:'art. 43 ust. 1 pkt 18',np_kind:null,gtu:'GTU_12',annex15:false,oss_rate_class:'standard'}]);
   const text=section(h).textContent;assert(text.includes('Zwolnienie ZW'));assert(text.includes('P_19A — przepis ustawy/rozporządzenia: art. 43 ust. 1 pkt 18'));assert(text.includes('GTU_12'));await h.close();
  });
  await t.test('server 422 stays inline in the form; 409 reloads the current profile into the form',async()=>{
   reset(view({...blank,version:5}));const h=await openCard();await click(button(h,'Zmień dane podatkowe'));
   const npLabels={};await set(control(h,'Kategoria'),'np');for(const o of control(h,'Rodzaj NP').options)npLabels[o.value]=o.textContent;assert.equal(npLabels.np_i,'NP I: poza krajem, bez art. 100 ust. 1 pkt 4 i OSS');assert.equal(npLabels.np_ii,'NP II: usługi z art. 100 ust. 1 pkt 4 (art. 28b) dla podatnika z UE');
   await set(control(h,'Rodzaj NP'),'np_ii');fixture.answers.push([422,{detail:'np_kind: Rodzaj NP podaje się tylko dla kategorii NP'}]);await submit(h);
   await until(()=>section(h).querySelector('[role="alert"]')?.textContent.includes('Rodzaj NP podaje'),'server reason');assert(section(h).querySelector('form'),'form stays');assert.equal(fixture.puts[0].version,5);
   fixture.profile=view({...blank,version:6,gtu:'GTU_01'});fixture.answers.push([409,{detail:'Profil podatkowy zmieniono w innym oknie. Odśwież kartę.'}]);await submit(h);
   await until(()=>section(h).querySelector('[role="alert"]')?.textContent.includes('w innym oknie')&&control(h,'GTU').value==='GTU_01','reloaded');assert.equal(control(h,'Kategoria').value,'standard');
   fixture.answers.push([200,view({...blank,version:7,gtu:'GTU_01'})]);await submit(h);await until(()=>!section(h).querySelector('form'),'saved');assert.equal(fixture.puts.at(-1).version,6,'next save uses the reloaded version');await h.close();
  });
  await t.test('missing migration 226 shows a notice and the rest of the card stays',async()=>{
   reset(()=>Response.json({detail:'Model podatkowy (migracja 226) jest niedostępny w tej kopii'},{status:503}));
   const el=document.createElement('div');document.body.append(el);const root=createRoot(el);const h={el,root,async close(){await act(async()=>root.unmount());el.remove();}};handles.push(h);
   await act(async()=>root.render(React.createElement(Host)));await until(()=>el.textContent.includes('Produkt 1'),'list');await click([...el.querySelectorAll('button')].find(x=>x.textContent.includes('Produkt 1')));
   await until(()=>section(h)?.textContent.includes('Model podatkowy niedostępny w tej kopii'),'notice');assert(button(h,'Edytuj produkt'));await h.close();
  });
 }finally{for(const h of handles)if(h.el.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
