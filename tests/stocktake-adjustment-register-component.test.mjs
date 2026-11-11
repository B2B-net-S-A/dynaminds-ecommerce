import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
// Actual ReactDOM register, controlled HTTP only. No database, native download,
// stock movements, cursor cryptography, providers or actual permission proof.
const id = n => `${String(n).padStart(8, '0')}-1650-4165-8165-165165165165`;
const tenant=id(1),user=id(2),scope=`${tenant}:${user}:admin:false`,digest='a'.repeat(64),at='2026-10-07T10:00:00.000Z';
const privateKeys=new Set(['unit_cost_minor','value_minor','currency','exponent','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','rows_sha256']);
const redact=v=>Array.isArray(v)?v.map(redact):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!privateKeys.has(k)).map(([k,x])=>[k,redact(x)])):v;
function fixture({count=101,headers=51,on=true}={}) {
  const f={reads:[],writes:[],tenant,user,flags:{available:true,read_only:false,current_role:'admin',can_read:true,can_write:true,can_read_value:true},hold:null,optionsCalls:0,exported:[]};
  const warehouse={id:id(20),code:'ORIGINAL',name:'Magazyn historyczny',policy:{usage:'sale',enabled:true,version:'0'}};
  const total={pw_quantity:'0',rw_quantity:String(count),...(on?{currency:'KWD',exponent:3,known_pw_minor:'0',known_rw_minor:String(Math.max(0,count-2)*1234),unknown_pw_quantity:'0',unknown_rw_quantity:count>1?'1':'0'}:{})};
  f.document={id:id(1000),receipt_id:id(70),kind:'RW',number:'RW/2026/000001',series_id:id(40),year:2026,sequence:'1',source_kind:on?'wms':'quantity',stocktake_id:id(30),warehouse,row_count:count,summary:total,created_at:at};
  f.heads=Array.from({length:headers},(_,n)=>({...structuredClone(f.document),id:id(1000+n),number:`RW/2026/${String(n+1).padStart(6,'0')}`,sequence:String(n+1),created_at:new Date(Date.parse(at)-n*60000).toISOString()}));
  f.rows=Array.from({length:count},(_,ordinal)=>({ordinal,source_ordinal:ordinal,line_id:id(2000+ordinal),product_id:id(50),sku:'SAME-SKU',name:'Historyczna nazwa',warehouse_id:warehouse.id,location:'BIN-'+ordinal,kind:'RW',quantity:1,delta:-1,lot_id:on?id(55):null,lot_code:on?'ORIGINAL-LOT':null,expiry_date:null,layer_id:on?id(56):null,movement_id:id(3000+ordinal),stock_movement_id:on?null:id(4000+ordinal),...(on?{unit_cost_minor:ordinal===0?'0':ordinal===1?null:'1234',value_minor:ordinal===0?'0':ordinal===1?null:'1234',currency:'KWD'}:{})}));
  const source={source_kind:f.document.source_kind,stocktake_id:id(30),version:'3',state:'review',name:'Spis źródłowy',warehouse,review_hash:on?null:digest,review_id:on?id(31):null,scope_hash:on?digest:null,line_count:count,row_count:count,summary:total,can_preview:true};
  f.receipt={id:id(70),preview_id:id(71),client_key:id(72),scope_hash:digest,request:{client_key:id(72),scope_hash:digest,confirmed:true},snapshot:{source,year:2026,series:{PW:null,RW:{id:id(40),kind:'RW',name:'Oryginalna seria',prefix:'RW',version:'1',created_at:at}},row_count:count,rows_sha256:digest,summary:total},source:{source_kind:f.document.source_kind,stocktake_id:id(30),posting_id:on?id(74):null,operation_id:on?id(75):null,version:'4',state:'posted'},documents:[structuredClone(f.document)],created_at:at};
  f.fetch=async(url,init={})=>{
    const u=new URL(String(url),'http://127.0.0.1'),p=u.pathname.replace(/^\/api/,''),method=init.method??'GET';
    if(method!=='GET'){f.writes.push({p,method,body:init.body});throw Error('Register must never mutate');}
    f.reads.push(p+u.search);
    if(p==='/auth/me')return Response.json({user:{id:f.user,tenant_id:f.tenant,role:f.flags.current_role}});
    if(p==='/warehouses')return Response.json({data:[{id:warehouse.id,name:'Aktualna nazwa magazynu',code:'NOW'}]});
    if(p==='/stocktake-adjustments/options'){
      f.optionsCalls++;if(f.dropAt&&f.optionsCalls>=f.dropAt)f.flags.can_read_value=false;
      if(f.torn)return Response.json({detail:'Niepełna migracja149'},{status:503});return Response.json({...f.flags,series:[],limits:{fragments:10000,header_page:50,row_page:100}});
    }
    const reply=v=>Response.json({...f.flags,...(f.flags.can_read_value||f.maliciousValues?v:redact(v))});
    if(p==='/stocktake-adjustments/register'){
      if(f.hold)return f.hold;
      const start=u.searchParams.get('cursor')?50:0,q=u.searchParams;
      let all=f.heads.filter(d=>(!q.get('kind')||d.kind===q.get('kind'))&&(!q.get('source_kind')||d.source_kind===q.get('source_kind'))&&(!q.get('warehouse_id')||d.warehouse.id===q.get('warehouse_id'))&&(!q.get('number_prefix')||d.number.startsWith(q.get('number_prefix'))));
      const data=structuredClone(all.slice(start,start+50));if(f.duplicate&&start&&data.length)data[0]=structuredClone(all[0]);
      return reply({data,meta:{limit:50,cursor:f.badCursor?'':start+data.length<all.length?'opaque-filter-bound-page-2':null}});
    }
    if(p==='/stocktake-adjustments/documents/'+id(1000))return reply({document:structuredClone(f.document)});
    if(p.endsWith('/rows')){
      const offset=Number(u.searchParams.get('cursor')??0),data=structuredClone(f.rows.slice(offset,offset+100));
      if(f.badOrdinal&&data.length)data[0].source_ordinal=99999;
      return reply({document_id:f.document.id,data,meta:{total:f.rows.length,cursor:offset+data.length<f.rows.length?String(offset+data.length):null}});
    }
    if(p==='/stocktake-adjustments/receipts/'+id(70)){
      const r=structuredClone(f.receipt);if(f.forgedReceipt)r.documents[0].number='FORGED/2026/000001';return reply({receipt:r,documents:r.documents});
    }
    if(p.endsWith('/export')){
      f.exported.push(u.search);const format=u.searchParams.get('format'),values=u.searchParams.get('include_values')==='true';
      return reply({document:values?structuredClone(f.document):redact(f.document),filename:'RW-2026-000001.'+format,content_type:format==='csv'?'text/csv; charset=utf-8':'application/xml; charset=utf-8',content:format==='csv'?'record_type,sku\r\ndocument,RW\r\nrow,"\'=FORMULA"\r\n':'<?xml version="1.0"?><stocktake_adjustment><document/><rows><row><name>A&amp;B</name></row></rows></stocktake_adjustment>',format,values_included:values&&on,row_count:f.rows.length});
    }
    throw Error('Unexpected GET '+p);
  };return f;
}
async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(fn,note){for(let i=0;i<120;i++){if(fn())return;await tick();}assert.ok(fn(),note);}
const button=(h,text)=>{const b=[...h.container.querySelectorAll('button')].find(x=>x.textContent===text);assert.ok(b,text);return b;};
const field=(h,text)=>{const l=[...h.container.querySelectorAll('label')].find(x=>[...x.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()===text);const e=l?.querySelector('input,select');assert.ok(e,text);return e;};
async function click(e){assert.equal(e.disabled,false);await act(async()=>e.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
async function value(e,v){const proto=e.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;await act(async()=>{Object.getOwnPropertyDescriptor(proto,'value').set.call(e,v);e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));});}

test('global PW/RW register actual ReactDOM controlled HTTP',async t=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1'}),saved=new Map(),oldFetch=globalThis.fetch;
  for(const [k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL,oldAnchor=dom.window.HTMLAnchorElement.prototype.click,downloads=[];
  URL.createObjectURL=b=>{downloads.push({blob:b});return'blob:controlled165';};URL.revokeObjectURL=()=>{};dom.window.HTMLAnchorElement.prototype.click=function(){downloads.at(-1).filename=this.download;};
  const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
  const {createRoot}=await import('react-dom/client'),ui=await vite.ssrLoadModule(path.resolve('web/stocktake-adjustment-register.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts')),legacy=await vite.ssrLoadModule(path.resolve('web/stocktake-adjustments.tsx'));
  const mounts=[];
  function reset(f){globalThis.fetch=f.fetch;api.setWorkspace(f.tenant);downloads.length=0;}
  async function mount(p={}){const container=document.createElement('div');document.body.append(container);const root=createRoot(container),h={container,props:{contextKey:scope,available:true,readOnly:false,refresh:0,...p},async render(p={}){h.props={...h.props,...p};await act(async()=>root.render(React.createElement(ui.StocktakeAdjustmentRegister,h.props)));},async close(){if(h.closed)return;h.closed=true;await act(async()=>root.unmount());container.remove();}};mounts.push(h);await h.render();return h;}
  const ready=h=>until(()=>h.container.querySelector('.sar-scroll')&&!button(h,'Odśwież rejestr PW/RW').disabled,'register/options settled');
  const open=async h=>{await ready(h);await click(button(h,'Otwórz dokument RW/2026/000001'));await until(()=>h.container.textContent.includes('Odczytano wszystkie')&&!button(h,'Odśwież rejestr PW/RW').disabled,'complete detail settled');};
  try{
    await t.test('global51 headers append opaquecursor; full101 rows bind receipt and use frozen WH/cost0/NULL/exponent3',async()=>{
      const f=fixture();reset(f);let source;const h=await mount({onOpenStocktake:(kind,id)=>{source=[kind,id];}});await ready(h);assert.equal(h.container.querySelectorAll('.sar-scroll tbody tr').length,50);assert(!f.reads.find(p=>p.includes('/register?')).includes('stocktake_id'));
      await click(button(h,'Wczytaj kolejne dokumenty PW/RW (do 50)'));await until(()=>h.container.querySelectorAll('.sar-scroll tbody tr').length===51&&!button(h,'Odśwież rejestr PW/RW').disabled,'second header page');assert.ok(f.reads.some(p=>p.includes('cursor=opaque-filter-bound-page-2')));
      await open(h);assert.ok(h.container.textContent.includes('Magazyn historyczny'));assert.ok(h.container.querySelector('.sar-detail').textContent.includes('0,000 KWD'));assert.ok(h.container.querySelector('.sar-detail').textContent.includes('Koszt nieznany (NULL)'));assert.ok(h.container.querySelector('.sar-detail').textContent.includes('1,234 KWD'));assert.equal(f.reads.filter(p=>p.includes('/rows?')).length,2);await click(button(h,'Następne fragmenty'));assert.equal(h.container.querySelectorAll('.sar-detail tbody tr').length,1);await click(button(h,'Otwórz źródłowy spis'));assert.deepEqual(source,['wms',id(30)]);assert.equal(f.writes.length,0);await h.close();
    });
    await t.test('explicit filters reset opaquecursor/selection; no client first-page-only search',async()=>{
      const f=fixture();reset(f);const h=await mount();await ready(h);await click(button(h,'Wczytaj kolejne dokumenty PW/RW (do 50)'));await until(()=>!button(h,'Odśwież rejestr PW/RW').disabled,'page done');await value(field(h,'Początek numeru'),'RW/2026/000002');assert.equal(f.reads.filter(p=>p.includes('/register?')).length,2);await click(button(h,'Zastosuj filtry PW/RW'));await until(()=>h.container.querySelectorAll('.sar-scroll tbody tr').length===1&&!button(h,'Odśwież rejestr PW/RW').disabled,'filtered server reply');const q=f.reads.filter(p=>p.includes('/register?')).at(-1);assert.ok(q.includes('number_prefix=RW%2F2026%2F000002'));assert.ok(!q.includes('cursor='));assert.ok(!h.container.querySelector('.sar-detail'));await h.close();
    });
    await t.test('duplicate header or malformed cursor fails closed without claiming EOF',async()=>{
      const f=fixture();reset(f);const h=await mount();await ready(h);f.duplicate=true;await click(button(h,'Wczytaj kolejne dokumenty PW/RW (do 50)'));await until(()=>h.container.querySelector('[role="alert"]'),'duplicate refused');assert.ok(!h.container.querySelector('.sar-scroll'));f.duplicate=false;f.badCursor=true;await click(button(h,'Odśwież rejestr PW/RW'));await until(()=>h.container.textContent.includes('Nieprawidłowy kursor'),'cursor refused');assert.ok(!h.container.textContent.includes('Brak dokumentów odpowiadających'));await h.close();
    });
    await t.test('full rows beyond100 and forged receipt cannot produce ready detail/export',async()=>{
      const f=fixture();reset(f);const h=await mount();await ready(h);f.badOrdinal=true;await click(button(h,'Otwórz dokument RW/2026/000001'));await until(()=>h.container.querySelector('[role="alert"]'),'source ordinal rejected');assert.ok(!h.container.querySelector('.sar-detail'));assert.equal(f.exported.length,0);await h.close();
      const g=fixture({count:3,headers:1});g.forgedReceipt=true;reset(g);const second=await mount();await ready(second);await click(button(second,'Otwórz dokument RW/2026/000001'));await until(()=>second.container.querySelector('[role="alert"]'),'forged frozen number refused');assert.ok(!second.container.querySelector('.sar-detail'));await second.close();
    });
    await t.test('late value grant loss redacts earlier details and blocks valued file before Blob handoff',async()=>{
      const f=fixture({count:3,headers:1});reset(f);const h=await mount();await open(h);await click(field(h,'Dołącz historyczną wycenę'));f.dropAt=f.optionsCalls+2;await click(button(h,'Pobierz pełny dokument PW/RW'));await until(()=>h.container.querySelector('[role="alert"]')&&!button(h,'Odśwież rejestr PW/RW').disabled,'postexport pin rejects loss');assert.equal(f.exported.length,1);assert.equal(downloads.length,0);assert.ok(!h.container.textContent.includes('1,234 KWD'));assert.ok(!h.container.querySelector('.sar-detail'));await h.close();
    });
    await t.test('CSV/XML whole-file envelope and explicit no-value download; restore reads allowed',async()=>{
      const f=fixture({count:3,headers:1});f.flags.read_only=true;f.flags.can_write=false;reset(f);const h=await mount({contextKey:`${tenant}:${user}:admin:true`,readOnly:true});await open(h);await click(button(h,'Pobierz pełny dokument PW/RW'));await until(()=>downloads.length===1&&!button(h,'Odśwież rejestr PW/RW').disabled,'CSV Blob handoff');assert.equal(downloads[0].filename,'RW-2026-000001.csv');assert.equal(downloads[0].blob.type,'text/csv; charset=utf-8');assert.ok((await downloads[0].blob.text()).includes("'=FORMULA"));assert.ok(f.exported[0].includes('include_values=false'));await value(field(h,'Format eksportu'),'xml');await click(button(h,'Pobierz pełny dokument PW/RW'));await until(()=>downloads.length===2&&!button(h,'Odśwież rejestr PW/RW').disabled,'XML handoff');assert.ok((await downloads[1].blob.text()).includes('A&amp;B'));assert.equal(f.writes.length,0);await h.close();
    });
    await t.test('OFF is unvalued; malformed/absent503 never implies empty register',async()=>{
      const f=fixture({on:false,count:3,headers:1});reset(f);let source;const h=await mount({onOpenStocktake:(kind,id)=>{source=[kind,id];}});await open(h);assert.ok(h.container.querySelector('.sar-detail').textContent.includes('Wycena niedostępna'));assert.equal(field(h,'Dołącz historyczną wycenę').disabled,true);await click(button(h,'Otwórz źródłowy spis'));assert.deepEqual(source,['quantity',f.document.stocktake_id]);assert.equal(f.writes.length,0);await h.close();
      const g=fixture();g.torn=true;reset(g);const next=await mount();await until(()=>next.container.textContent.includes('Niepełna migracja149'),'torn module503');assert.ok(!next.container.textContent.includes('Brak dokumentów odpowiadających'));assert.equal(g.reads.filter(p=>p.includes('/register?')).length,0);await next.close();
    });
    await t.test('same-tenant actor switch fences held old GET and denies fresh identity mismatch',async()=>{
      const f=fixture({headers:1,count:3});let release;f.hold=new Promise(r=>{release=r;});reset(f);const h=await mount();await until(()=>f.reads.some(p=>p.includes('/register?')),'old GET held');f.user=id(9);f.hold=null;await h.render({contextKey:`${tenant}:${f.user}:admin:false`});await ready(h);await act(async()=>{release(Response.json({...f.flags,data:[{...f.document,number:'OLD-ACTOR-SECRET'}],meta:{limit:50,cursor:null}}));});await tick();assert.ok(!h.container.textContent.includes('OLD-ACTOR-SECRET'));f.user=id(10);await click(button(h,'Odśwież rejestr PW/RW'));await until(()=>h.container.textContent.includes('Zmieniła się firma lub użytkownik'),'auth mismatch');assert.ok(!h.container.querySelector('.sar-scroll'));await h.close();
    });
    await t.test('pure register GET never acknowledges legacy164 retained unknown',async()=>{
      const f=fixture({headers:1,count:3});reset(f);legacy.resetStocktakeAdjustmentsContext('');legacy.resetStocktakeAdjustmentsContext(scope);
      // The actual legacy panel creates its own retained attempt through a real
      // mounted command; register has no registry reset/import/action shortcut.
      const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
      const legacyFetch=f.fetch;globalThis.fetch=async(url,init={})=>{const p=new URL(String(url),'http://127.0.0.1').pathname;if((init.method??'GET')==='POST')throw TypeError('Controlled unknown series ACK');if(p.includes('/sources/'))return Response.json({...f.flags,source:f.receipt.snapshot.source});return legacyFetch(url,init);};
      await act(async()=>root.render(React.createElement(legacy.StocktakeAdjustmentsPanel,{contextKey:scope,readOnly:false,sourceKind:'wms',stocktakeId:id(30)})));
      const hLegacy={container};await until(()=>container.querySelector('details')&&!button(hLegacy,'Odczytaj źródło i serie PW/RW').disabled,'legacy options');await value(field(hLegacy,'Nazwa serii'),'Unknown series');await value(field(hLegacy,'Prefiks numeracji'),'QA165');await click(button(hLegacy,'Zapisz nową serię PW/RW'));await until(()=>legacy.stocktakeAdjustmentsLocked(scope)&&container.textContent.includes('Controlled unknown series ACK'),'legacy unknown ACK exact attempt retained');
      await act(async()=>root.unmount());container.remove();globalThis.fetch=f.fetch;const h=await mount();await open(h);assert.equal(legacy.stocktakeAdjustmentsLocked(scope),true);assert.equal(f.writes.length,0);await h.close();legacy.resetStocktakeAdjustmentsContext('');
    });
  }finally{for(const h of mounts)await h.close();legacy.resetStocktakeAdjustmentsContext('');await vite.close();globalThis.fetch=oldFetch;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;dom.window.HTMLAnchorElement.prototype.click=oldAnchor;for(const [k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
