import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act, StrictMode } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Real ReactDOM component, api helper and retained RAM registry. Transport is controlled.
// This does not prove actual SQL stock movement, WMS custody, a provider or physical parcels.
const id=n=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const tenant=id(1),user=id(2),order=id(3),a=id(4),b=id(5),warehouse=id(6);
const context=`${tenant}:${user}:admin:false`;
const prefix='/api/order-parcels';
const flags={available:true,read_only:false,current_role:'admin',can_read:true,can_write:true};
const receiver={name:'QA151 customer',address:{street:'Test 1',postal_code:'00-001',city:'Test',country:'PL'}};
const now=new Date().toISOString(),later=new Date(Date.now()+900000).toISOString();
const copy=x=>JSON.parse(JSON.stringify(x));
const hold=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
  const original={order:{id:order,number:'QA151-ORDER',version:'1',status:'packed',warehouse_id:warehouse,payment_mode:'prepaid',currency:'PLN'},receiver,products:[
    {product_id:a,sku:'QA151-A',name:'Physical A',quantity:3,consumed_quantity:0,remaining:3,scanned:3,locations:[{location:'A-01',quantity:3,scanned:3,consumed_quantity:0}],layers:[]},
    {product_id:b,sku:'QA151-B',name:'Physical B',quantity:2,consumed_quantity:0,remaining:2,scanned:2,locations:[{location:'A-01',quantity:2,scanned:2,consumed_quantity:0}],layers:[]},
  ],shipments:[],cod_due:0,active_plan_id:null,can_preview:true,unavailable_reason:null,wms_enabled:false};
  return {actor:context,source:copy(original),preview:null,plan:null,requests:[],dispatches:0,drop:false,heldSource:null,
    async fetch(url,opts={}){
      const method=opts.method??'GET',body=opts.body?JSON.parse(opts.body):null;
      this.requests.push({url,method,body,serialized:opts.body,workspace:opts.headers?.['X-Workspace-ID']});
      if(url==='/api/auth/me'){const [tenant_id,id,role]=this.actor.split(':');return Response.json({user:{tenant_id,id,role}});}
      if(url===`${prefix}/orders/${order}/source`){if(this.heldSource){const wait=this.heldSource;this.heldSource=null;return await wait.promise;}return Response.json({...flags,current_role:this.actor.split(':')[2],source:copy(this.source)});}
      if(url===`${prefix}/orders/${order}/previews` && method==='POST'){
        const parcels=body.parcels.map((p,index)=>({...p,index,shipment_id:id(20+index),carrier:'DEMO',mode:'demo',tracking_number:`QA151-PARCEL-${index+1}`,products:p.products.map(v=>({...v,warehouse_id:warehouse,locations:[{location:'A-01',quantity:v.quantity}],lot_holds:[]}))}));
        this.preview={id:id(10),kind:'preview',order_id:order,order_version:body.order_version,scope_hash:'a'.repeat(64),source:copy(original),parcels,summary:{parcels:2,products:4,physical_quantity:5,cod_minor:0},created_at:now,expires_at:later,applied_plan_id:null,can_apply:true};
        return Response.json({...flags,preview:copy(this.preview),reused:false},{status:201});
      }
      if(url===`${prefix}/previews/${id(10)}/apply` && method==='POST'){
        const {expires_at,applied_plan_id,can_apply,...p}=this.preview;
        this.plan={...copy(p),id:id(11),kind:'plan',preview_id:this.preview.id,order_status:'packed',current_order_version:'2',complete:false,progress:p.parcels.map(v=>({index:v.index,shipment_id:v.shipment_id,state:'pending',dispatch_id:null}))};
        this.source.active_plan_id=this.plan.id;this.source.can_preview=false;this.source.order.version='2';
        return Response.json({...flags,plan:copy(this.plan),reused:false},{status:201});
      }
      if(url===`${prefix}/plans/${id(11)}`)return Response.json({...flags,plan:copy(this.plan)});
      if(url.startsWith(`${prefix}/orders/${order}/history?`))return Response.json({...flags,data:this.plan?[{kind:'plan',id:this.plan.id,order_id:order,scope_hash:this.plan.scope_hash,summary:this.plan.summary,created_at:now}]:[],next_cursor:null});
      const match=url.match(/\/plans\/[^/]+\/parcels\/(\d+)\/dispatch$/);
      if(match && method==='POST'){
        const index=Number(match[1]),progress=this.plan.progress[index],reused=progress.state==='dispatched';
        if(!reused){this.dispatches++;progress.state='dispatched';progress.dispatch_id=id(30+index);for(const p of this.plan.parcels[index].products){const current=this.source.products.find(v=>v.product_id===p.product_id);current.consumed_quantity+=p.quantity;current.remaining-=p.quantity;}this.plan.complete=this.plan.progress.every(p=>p.state==='dispatched');this.plan.order_status=this.plan.complete?'shipped':'packed';this.plan.current_order_version=String(2+this.dispatches);this.source.order.status=this.plan.order_status;this.source.order.version=this.plan.current_order_version;}
        this.source.unavailable_reason=this.plan.complete?'ORDER_NOT_PACKED':'PLAN_EXISTS';
        if(this.drop){this.drop=false;throw Error('Controlled lost response after model commit');}
        return Response.json({...flags,plan:copy(this.plan),dispatch:{id:progress.dispatch_id,plan_id:this.plan.id,parcel_index:index,shipment_id:progress.shipment_id,scope_hash:this.plan.scope_hash,created_at:now},reused},{status:reused?200:201});
      }
      throw Error(`Unexpected controlled request: ${method} ${url}`);
    },
  };
}
async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(fn,message){for(let i=0;i<80;i++){if(fn())return;await tick();}assert.ok(fn(),message);}
function button(h,label){const b=[...h.container.querySelectorAll('button')].find(v=>v.textContent===label);assert.ok(b,`Missing button ${label}`);return b;}
function check(h,text){const input=[...h.container.querySelectorAll('label')].find(v=>v.textContent.includes(text))?.querySelector('input[type=checkbox]');assert.ok(input,`Missing consent ${text}`);return input;}
async function click(el){assert.equal(el.disabled,false);await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
async function input(h,label,value){const el=h.container.querySelector(`input[aria-label="${label}"]`);assert.ok(el);await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});}
async function prepare(h,f){
  await until(()=>!button(h,'Odczytaj realizację paczek').disabled && h.container.textContent.includes('fizyczny zakres realizacji'),'Source must load');
  await click(button(h,'Rozdziel ilości na paczki'));
  assert.equal(button(h,'Przygotuj pełny podgląd podziału').disabled,true,'No automatic allocation');
  await input(h,'Paczka 1 QA151-A','1');await input(h,'Paczka 1 QA151-B','1');await input(h,'Paczka 2 QA151-A','2');
  assert.equal(button(h,'Przygotuj pełny podgląd podziału').disabled,true,'Incomplete product B must block the whole preview');
  await input(h,'Paczka 2 QA151-B','1');await click(button(h,'Przygotuj pełny podgląd podziału'));
  await until(()=>h.container.textContent.includes('Podgląd całego podziału'),'Full durable preview must render');
  assert.deepEqual(f.requests.find(r=>r.method==='POST').body.parcels,[{source_kind:'demo',products:[{product_id:a,quantity:1},{product_id:b,quantity:1}],cod_minor:0},{source_kind:'demo',products:[{product_id:a,quantity:2},{product_id:b,quantity:1}],cod_minor:0}]);
  assert.equal(button(h,'Zapisz cały plan paczek').disabled,true,'Preview alone is not plan consent');
  await click(check(h,'Sprawdziłem wszystkie ilości'));
  await click(button(h,'Zapisz cały plan paczek'));
  await until(()=>h.container.textContent.includes('Realizacja zapisanego planu'),'Plan must render');
  assert.equal(f.dispatches,0,'Applying plan must not dispatch any parcel');
}

test('order parcels: real component complete allocation, partial dispatch and retained exact attempt',async t=>{
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
  for(const [k,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
  const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
  const {createRoot}=await import('react-dom/client'),mod=await vite.ssrLoadModule(path.resolve('web/order-parcels.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts=[];
  function mount(f){globalThis.fetch=f.fetch.bind(f);api.setWorkspace(tenant);const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const h={container,async render(p={}){await act(async()=>root.render(React.createElement(StrictMode,null,React.createElement(mod.OrderParcelsPanel,{orderId:order,contextKey:context,readOnly:false,...p}))));},async close(){await act(async()=>root.unmount());container.remove();}};mounts.push(h);return h;}
  try{
    await t.test('full coverage and separate plan/parcel consents; first issue keeps packed',async()=>{
      const f=fixture(),h=mount(f);await h.render();try{await prepare(h,f);
        assert.equal(button(h,'Wydaj paczkę 1').disabled,true);await click(check(h,'Potwierdzam rzeczywiste wydanie paczki 1'));await click(button(h,'Wydaj paczkę 1'));
        await until(()=>f.dispatches===1 && !button(h,'Odczytaj aktualny postęp planu').disabled,'First dispatch must finish');
        assert.equal(f.plan.order_status,'packed');assert.equal(f.source.products.find(v=>v.product_id===a).remaining,2);assert.equal(f.source.products.find(v=>v.product_id===b).remaining,1);assert.ok(h.container.textContent.includes('wydano 1 z 2 paczek'));assert.equal(button(h,'Wydaj paczkę 2').disabled,true);
        await click(check(h,'Potwierdzam rzeczywiste wydanie paczki 2'));await click(button(h,'Wydaj paczkę 2'));
        await until(()=>h.container.textContent.includes('Wszystkie paczki wydane'),'Final order status should display shipped');assert.equal(f.dispatches,2);assert.equal(f.source.products.reduce((n,p)=>n+p.remaining,0),0);
        assert.equal(f.source.unavailable_reason,'ORDER_NOT_PACKED','Current source is no longer eligible for a new preview');
        assert.ok(!h.container.textContent.includes('Najpierw zakończ kompletację i spakuj zamówienie.'),'Completed plan must not show preparation instructions for a new preview');
        assert.ok(h.container.textContent.includes('wydano 2 z 2 paczek'),'Actual completed plan progress remains visible');
      }finally{await h.close();mod.resetOrderParcelsContext('');}
    });
    await t.test('lost dispatch ACK survives remount/history; exact retry alone releases lock',async()=>{
      const f=fixture(),h=mount(f);await h.render();let next;try{await prepare(h,f);f.drop=true;await click(check(h,'Potwierdzam rzeczywiste wydanie paczki 1'));await click(button(h,'Wydaj paczkę 1'));
        await until(()=>mod.getOrderParcelsLocked(context) && h.container.textContent.includes('Wynik próby może być nieznany'),'Uncertain write retained');const first=f.requests.find(r=>r.url.endsWith('/0/dispatch'));
        await h.close();next=mount(f);await next.render({externalWriteBlocked:true});await until(()=>!button(next,'Odczytaj realizację paczek').disabled && next.container.textContent.includes('Wynik próby może być nieznany'),'Retained attempt survives navigation');
        await click(button(next,'Odczytaj zapisane plany'));await until(()=>next.container.querySelector('.op-history-row'),'Committed history readable');await click(button(next,'Odczytaj pełny podział'));await until(()=>!button(next,'Odczytaj realizację paczek').disabled,'Read finished');assert.equal(mod.getOrderParcelsLocked(context),true);assert.equal(f.dispatches,1);
        await click(check(next,'Potwierdzam ręczne ponowienie tej samej próby'));await click(button(next,'Ponów dokładnie zachowaną próbę'));await until(()=>!mod.getOrderParcelsLocked(context),'Exact retry resolves retained write even sibling block');const writes=f.requests.filter(r=>r.url.endsWith('/0/dispatch'));assert.equal(writes.length,2);assert.equal(writes[1].serialized,first.serialized);assert.equal(f.dispatches,1);
      }finally{if(h.container.isConnected)await h.close();if(next)await next.close();mod.resetOrderParcelsContext('');}
    });
    await t.test('actor change rejects old held source; read-only context has no fresh writes',async()=>{
      const f=fixture(),held=hold();f.heldSource=held;const h=mount(f);await h.render();try{
        await until(()=>f.requests.some(r=>r.url.endsWith('/source')),'Original read held');const other=`${id(101)}:${id(102)}:viewer:true`;f.actor=other;api.setWorkspace(id(101));await h.render({contextKey:other,readOnly:true});
        held.resolve(Response.json({...flags,source:copy(f.source)}));await until(()=>!button(h,'Odczytaj realizację paczek').disabled,'Current read should settle');assert.equal(mod.getOrderParcelsLocked(context),false);assert.equal(f.requests.filter(r=>r.method==='POST').length,0);assert.ok(!h.container.querySelector('button') || [...h.container.querySelectorAll('button')].filter(v=>v.textContent==='Rozdziel ilości na paczki').every(v=>v.disabled));
      }finally{await h.close();mod.resetOrderParcelsContext('');}
    });
  }finally{for(const h of mounts)if(h.container.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const [k,d] of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
