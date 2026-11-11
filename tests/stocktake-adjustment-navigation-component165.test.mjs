import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

// Actual bundled quantity Stocktakes + StocktakeScans, controlled HTTP only.
// This proves the receiver's deferred focus and navigation-lock callback, not
// App routing, durable scan admission, stock changes or native acceptance.
const id=n=>`${String(n).padStart(8,'0')}-1650-4165-8165-165165165165`;
const tenant=id(1),user=id(2),scope=`${tenant}:${user}:admin:false`,first=id(30),requested=id(31),line=id(40);
const flag={available:true,read_only:false,current_role:'admin',can_resolve:true,can_scan:true,can_replay:true};
const at='2026-10-07T10:00:00.000Z';
function fixture(){
  const f={reads:[],writes:[],counted:1,countHold:null,scanHold:null};
  const candidate={line_id:line,product_id:id(50),sku:'SKU165',name:'Produkt w źródłowym spisie',current_sku:'SKU165',current_ean:null,location:'BIN165',lot:null,matched_by:['frozen_sku'],line_version:'1',counted:1,needs_recount:false,generation_id:id(60),can_continue:true,basis_token:'basis165',resolution_token:'resolution165',expires_at:new Date(Date.now()+600000).toISOString()};
  const detail=s=>({id:s,name:s===first?'Pierwszy spis — zachowaj szkic':'Źródłowy spis PW/RW',warehouse_id:id(20),warehouse_name:'Własny magazyn',version:'1',state:'counting',blind:false,lines:[{id:line,version:'1',current_stock_version:'1',product_id:id(50),sku:'SKU165',name:'Produkt',location:'BIN165',basis_quantity:1,counted:f.counted,difference:0,conflict:false,reserved:0}],summary:{total:1,counted:1,changed:0,delta:0,conflicts:0,below_reserved:0},meta:{cursor:null}});
  f.fetch=async(url,init={})=>{
    const u=new URL(String(url),'http://127.0.0.1'),p=u.pathname.replace(/^\/api/,''),method=init.method??'GET';
    if(method==='GET'){
      f.reads.push(p+u.search);
      if(p==='/stocktakes')return Response.json({data:[{id:first,name:'Pierwszy spis',warehouse_name:'Własny magazyn',state:'counting',created_at:at}],meta:{cursor:null}});
      if(p==='/warehouses')return Response.json({data:[{id:id(20),name:'Własny magazyn',code:'MAIN'}]});
      if(p==='/wms-lots')return Response.json({policy:{enabled:false}});
      if(p===`/stocktakes/${first}`||p===`/stocktakes/${requested}`)return Response.json(detail(p.endsWith(first)?first:requested));
      if(p.endsWith('/scan-metadata'))return Response.json({...flag,engine:'quantity',limits:{page:100,request_bytes:16384},stocktake:{id:p.includes(first)?first:requested,state:'counting',version:'1',warehouse_id:id(20),blind:false}});
      if(p.endsWith('/scan-candidates'))return Response.json({...flag,data:[candidate],meta:{cursor:null,total:1}});
      throw Error('Unexpected controlled GET '+p);
    }
    assert.equal(method,'POST');f.writes.push({path:p,raw:init.body,body:JSON.parse(init.body)});
    if(p===`/stocktakes/${first}/counts`){if(f.countHold)await f.countHold;f.counted=f.writes.at(-1).body.lines[0].quantity;return Response.json({version:'2'});}
    if(p===`/stocktakes/${first}/scans`){
      if(f.scanHold)await f.scanHold;
      const b=f.writes.at(-1).body;
      return Response.json({...flag,reused:f.writes.length>1,current_line:{...candidate,line_version:'2',counted:2},scan:{id:id(80),stocktake_id:first,engine:'quantity',line_id:b.line_id,product_id:id(50),location:'BIN165',lot:null,kind:'increment',generation_id:id(60),code:b.code,matched_by:['frozen_sku'],previous_count:1,counted:2,increment:1,before_line_version:'1',after_line_version:'2',measurement_id:id(81),stocktake_version:'2',created_at:at}});
    }
    throw Error('Unexpected controlled mutation '+p);
  };return f;
}
async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(fn,note){for(let i=0;i<100;i++){if(fn())return;await tick();}assert.ok(fn(),note);}
function button(h,text){const b=[...h.container.querySelectorAll('button')].find(b=>b.textContent.trim()===text);assert.ok(b,text);return b;}
function input(h,label){const x=h.container.querySelector(`[aria-label="${label}"]`);assert.ok(x,label);return x;}
async function click(e){assert.equal(e.disabled,false);await act(async()=>e.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
async function value(e,v){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));});}

test('quantity PW/RW source focus guards actual dirty and unknown scan state',async t=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1'}),saved=new Map(),oldFetch=globalThis.fetch;
  for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
  const cwd=process.cwd(),compiled=await build({stdin:{contents:"export { Stocktakes } from './web/stocktakes'; export { setWorkspace } from './web/api';",resolveDir:cwd,sourcefile:'controlled-navigation165.ts'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent'});
  // In-memory CommonJS bundle shares the real installed React instance and
  // production imports; no file artifacts, server or production mocks.
  const module={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(path.join(cwd,'package.json')),module,module.exports);
  const ui=module.exports,{createRoot}=await import('react-dom/client'),mounts=[];
  async function mount(f){globalThis.fetch=f.fetch;ui.setWorkspace(tenant);const container=document.createElement('div');document.body.append(container);const root=createRoot(container),locks=[];
    const h={container,locks,props:{admin:true,write:true,refresh:0,reload(){},contextKey:scope,readOnly:false,adjustmentsAvailable:false,adjustmentsContextKey:scope,onNavigationLockedChange:locked=>locks.push(locked)},async render(p={}){h.props={...h.props,...p};await act(async()=>root.render(React.createElement(ui.Stocktakes,h.props)));},async close(){if(h.closed)return;h.closed=true;await act(async()=>root.unmount());container.remove();}};
    mounts.push(h);await h.render();await until(()=>container.textContent.includes('Otwórz spis'),'actual saved source list');await click(button(h,'Otwórz spis'));await until(()=>container.querySelector('[aria-label="Pomiar SKU165 BIN165"]')&&container.textContent.includes('Włącz skanowanie'),'actual detail and scan metadata');return h;
  }
  const requestedReads=f=>f.reads.filter(p=>p.split('?')[0]==='/stocktakes/'+requested);
  try{
    await t.test('dirty measured quantity defers requested focus through held count ACK, then opens exact source',async()=>{
      const f=fixture(),h=await mount(f);await value(input(h,'Pomiar SKU165 BIN165'),'7');assert.equal(h.locks.at(-1),true);
      await h.render({focusStocktakeId:requested,focusToken:1});await tick();assert.equal(input(h,'Pomiar SKU165 BIN165').value,'7');assert.ok(h.container.textContent.includes('Pierwszy spis — zachowaj szkic'));assert.equal(requestedReads(f).length,0);assert.equal(f.writes.length,0);
      let release;f.countHold=new Promise(r=>{release=r;});await click(button(h,'Zapisz pomiary z tej strony'));await until(()=>f.writes.length===1,'count request held');assert.equal(f.writes[0].path,'/stocktakes/'+first+'/counts');assert.equal(f.writes[0].body.lines[0].id,line);assert.equal(f.writes[0].body.lines[0].quantity,7);assert.equal(requestedReads(f).length,0);
      await act(async()=>{release();await new Promise(r=>setTimeout(r,0));});await until(()=>h.container.textContent.includes('Źródłowy spis PW/RW'),'same pending focus applied after acknowledged save');assert.equal(requestedReads(f).length,1);assert.equal(f.writes.length,1);assert.equal(h.locks.at(-1),false);await h.close();
    });
    await t.test('held then unknown real scan retains exact attempt and focus until manual retry plus scan-mode exit',async()=>{
      const f=fixture(),h=await mount(f);await click(button(h,'Włącz skanowanie'));await value(input(h,'Lokalizacja skanowania'),'BIN165');await value(input(h,'Kod EAN lub SKU do skanowania'),'SKU165');await click(button(h,'Rozpoznaj / odczytaj pozycję'));await until(()=>h.container.querySelector('[aria-label="Wybierz SKU165, BIN165"]'),'actual resolved candidate');await click(input(h,'Wybierz SKU165, BIN165'));
      let reject;f.scanHold=new Promise((_,r)=>{reject=r;});await click(button(h,'Zapisz jedną sztukę (+1)'));await until(()=>f.writes.length===1,'actual scan sent');const original=f.writes[0];await h.render({focusStocktakeId:requested,focusToken:2});assert.equal(h.locks.at(-1),true);assert.equal(requestedReads(f).length,0);
      await act(async()=>{reject(TypeError('Controlled unknown scan ACK'));await new Promise(r=>setTimeout(r,0));});await until(()=>h.container.textContent.includes('Controlled unknown scan ACK'),'retained unknown scan');assert.equal(requestedReads(f).length,0);assert.ok(h.container.textContent.includes('wynik niepotwierdzony'));assert.equal(f.writes.length,1);
      f.scanHold=null;await click(button(h,'Ponów dokładnie tę samą próbę skanu'));await until(()=>h.container.textContent.includes('potwierdzono tę samą próbę'),'explicit retry ACK');assert.equal(f.writes[1].path,original.path);assert.equal(f.writes[1].raw,original.raw);assert.equal(requestedReads(f).length,0);assert.equal(h.locks.at(-1),true);
      await click(button(h,'Wyłącz skanowanie'));await until(()=>h.container.textContent.includes('Źródłowy spis PW/RW'),'focus after exact ACK and scanner exit');assert.equal(requestedReads(f).length,1);assert.equal(f.writes.length,2);assert.equal(h.locks.at(-1),false);await h.close();
    });
  }finally{for(const h of mounts)await h.close();globalThis.fetch=oldFetch;for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
