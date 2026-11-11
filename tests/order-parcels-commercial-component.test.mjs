import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act, StrictMode } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual ReactDOM + repository API + retained attempt registry. The transport supplies
// fixed commercial manifests; this is not SQL/WMS/provider acceptance evidence.
const id=n=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const tenant=id(1),user=id(2),order=id(3),a=id(4),b=id(5),warehouse=id(6);
const cheap=id(7),expensive=id(8),bundle=id(9),bundleProduct=id(12);
const context=`${tenant}:${user}:admin:false`,prefix='/api/order-parcels';
const flags={available:true,read_only:false,current_role:'admin',can_read:true,can_write:true};
const copy=v=>JSON.parse(JSON.stringify(v));
const now=new Date().toISOString(),later=new Date(Date.now()+900000).toISOString();
const lines=[
  {item_id:cheap,product_id:a,sku:'SAME-SKU',name:'Same original name',quantity:2,line_total:2000,vat:23,currency:'PLN',components:[{product_id:a,quantity:1}]},
  {item_id:expensive,product_id:a,sku:'SAME-SKU',name:'Same original name',quantity:1,line_total:1700,vat:23,currency:'PLN',components:[{product_id:a,quantity:1}]},
  {item_id:bundle,product_id:bundleProduct,sku:'BUNDLE',name:'Frozen A1 B2',quantity:1,line_total:2500,vat:8,currency:'PLN',components:[{product_id:a,quantity:1},{product_id:b,quantity:2}]},
];
const location=quantity=>[{location:'A-01',quantity}];
const physical=(product_id,quantity)=>({product_id,warehouse_id:warehouse,quantity,locations:location(quantity),lot_holds:[]});
const frozenItem=(line,quantity)=>({...copy(line),original_quantity:line.quantity,quantity});
function fixture(){
  const original={order:{id:order,number:'QA153-COMMERCIAL',version:'1',status:'packed',warehouse_id:warehouse,payment_mode:'prepaid',currency:'PLN'},receiver:{name:'Test customer',address:{street:'Test 1',postal_code:'00-001',city:'Test',country:'PL'}},products:[
    {product_id:a,sku:'SAME-SKU',name:'Physical A',quantity:4,consumed_quantity:0,released_quantity:0,remaining:4,scanned:4,locations:location(4),layers:[]},
    {product_id:b,sku:'B',name:'Physical B',quantity:2,consumed_quantity:0,released_quantity:0,remaining:2,scanned:2,locations:location(2),layers:[]},
  ],commercial_available:true,commercial_lines:copy(lines),shipments:[],cod_due:0,active_plan_id:null,can_preview:true,unavailable_reason:null,wms_enabled:false};
  const parcels=[
    {index:0,source_kind:'demo',shipment_id:id(20),carrier:'DEMO',mode:'demo',tracking_number:'TEST-PARCEL-1',cod_minor:0,items:[frozenItem(lines[0],1),frozenItem(lines[2],1)],products:[physical(a,2),physical(b,2)]},
    {index:1,source_kind:'demo',shipment_id:id(21),carrier:'DEMO',mode:'demo',tracking_number:'TEST-PARCEL-2',cod_minor:0,items:[frozenItem(lines[0],1),frozenItem(lines[1],1)],products:[physical(a,2)]},
  ];
  const preview={id:id(10),kind:'preview',protocol:'commercial_v1',order_id:order,order_version:'1',scope_hash:'a'.repeat(64),source:copy(original),parcels,summary:{parcels:2,products:3,physical_quantity:6,cod_minor:0},created_at:now,expires_at:later,applied_plan_id:null,can_apply:true};
  return {source:copy(original),preview,plan:null,releasePreview:null,release:null,requests:[],corrupt:false,dropRelease:false,
    async fetch(url,options={}){
      const method=options.method??'GET';this.requests.push({url,method,serialized:options.body,body:options.body?JSON.parse(options.body):null});
      if(url==='/api/auth/me')return Response.json({user:{tenant_id:tenant,id:user,role:'admin'}});
      if(url===`${prefix}/orders/${order}/source`)return Response.json({...flags,source:copy(this.source)});
      if(url===`${prefix}/orders/${order}/previews` && method==='POST'){
        const reply=copy(this.preview);
        if(this.corrupt)reply.parcels[0].items[0].item_id=expensive;
        return Response.json({...flags,preview:reply,reused:this.requests.filter(r=>r.url===url && r.method==='POST').length>1},{status:201});
      }
      if(url===`${prefix}/previews/${preview.id}/apply` && method==='POST'){
        const {expires_at,applied_plan_id,can_apply,...head}=preview;
        this.plan={...copy(head),kind:'plan',id:id(11),preview_id:preview.id,current_order_version:'2',order_status:'packed',complete:false,progress:parcels.map(p=>({index:p.index,shipment_id:p.shipment_id,state:'pending',dispatch_id:null,release_id:null})),origins:[
          {origin_id:id(40),parcel_index:0,shipment_id:id(20),item_id:cheap,quantity:1,issued_quantity:0,cancelled_quantity:0,components:copy(lines[0].components),dispatch_id:null},
          {origin_id:id(41),parcel_index:0,shipment_id:id(20),item_id:bundle,quantity:1,issued_quantity:0,cancelled_quantity:0,components:copy(lines[2].components),dispatch_id:null},
          {origin_id:id(42),parcel_index:1,shipment_id:id(21),item_id:cheap,quantity:1,issued_quantity:0,cancelled_quantity:0,components:copy(lines[0].components),dispatch_id:null},
          {origin_id:id(43),parcel_index:1,shipment_id:id(21),item_id:expensive,quantity:1,issued_quantity:0,cancelled_quantity:0,components:copy(lines[1].components),dispatch_id:null},
        ]};
        this.source.active_plan_id=this.plan.id;this.source.can_preview=false;this.source.order.version='2';
        return Response.json({...flags,plan:copy(this.plan),reused:false},{status:201});
      }
      if(url===`${prefix}/plans/${id(11)}`)return Response.json({...flags,plan:copy(this.plan)});
      if(url.includes('/history?'))return Response.json({...flags,data:[],next_cursor:null});
      if(url===`${prefix}/plans/${id(11)}/parcels/0/dispatch` && method==='POST'){
        this.plan.progress[0]={index:0,shipment_id:id(20),state:'dispatched',dispatch_id:id(30),release_id:null};
        this.plan.origins.filter(o=>o.parcel_index===0).forEach(o=>{o.issued_quantity=o.quantity;o.dispatch_id=id(30);});
        this.source.products[0].consumed_quantity=2;this.source.products[0].remaining=2;
        this.source.products[1].consumed_quantity=2;this.source.products[1].remaining=0;
        this.plan.current_order_version='3';this.source.order.version='3';
        return Response.json({...flags,plan:copy(this.plan),dispatch:{id:id(30),plan_id:id(11),parcel_index:0,shipment_id:id(20),scope_hash:preview.scope_hash,created_at:now},reused:false},{status:201});
      }
      const remainder={plan_id:id(11),order_id:order,order_version:'3',pending:[{index:1,shipment_id:id(21),items:copy(parcels[1].items)}],products:[physical(a,2)],wms_enabled:false,summary:{pending_parcels:1,commercial_quantity:2,physical_quantity:2,issued_parcels:1},released_id:null,can_release:true};
      if(url===`/api/order-parcel-releases/plans/${id(11)}/source`)return Response.json({...flags,source:copy(remainder)});
      if(url===`/api/order-parcel-releases/plans/${id(11)}/previews` && method==='POST'){
        this.releasePreview={...copy(remainder),id:id(50),scope_hash:'b'.repeat(64),created_at:now,expires_at:later};
        return Response.json({...flags,preview:copy(this.releasePreview),reused:false},{status:201});
      }
      if(url===`/api/order-parcel-releases/previews/${id(50)}/release` && method==='POST'){
        const reused=this.release!==null;
        if(!reused){
          this.release={id:id(51),preview_id:id(50),plan_id:id(11),order_id:order,scope_hash:'b'.repeat(64),created_at:now,order_status:'shipped',receipt:{operation_id:id(51),cancelled:copy(remainder.pending),products:copy(remainder.products),summary:copy(remainder.summary),physical_movement:false}};
          this.plan.progress[1]={index:1,shipment_id:id(21),state:'cancelled',dispatch_id:null,release_id:id(51)};
          this.plan.origins.filter(o=>o.parcel_index===1).forEach(o=>{o.cancelled_quantity=o.quantity;});
          this.plan.complete=true;this.plan.order_status='shipped';this.plan.current_order_version='4';
          this.source.order.version='4';this.source.order.status='shipped';this.source.products[0].released_quantity=2;this.source.products[0].remaining=0;
        }
        if(this.dropRelease){this.dropRelease=false;throw Error('Controlled lost release ACK after committed model');}
        return Response.json({...flags,release:copy(this.release),reused},{status:reused?200:201});
      }
      throw Error(`Unexpected component transport ${method} ${url}`);
    },
  };
}
async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(fn,label){for(let i=0;i<100;i++){if(fn())return;await tick();}assert.ok(fn(),label);}
function button(h,label){const b=[...h.container.querySelectorAll('button')].find(v=>v.textContent===label);assert.ok(b,label);return b;}
function consent(h,label){const input=[...h.container.querySelectorAll('label')].find(v=>v.textContent.includes(label))?.querySelector('input[type=checkbox]');assert.ok(input,label);return input;}
async function click(el){assert.equal(el.disabled,false);await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
async function input(h,label,value){const el=h.container.querySelector(`input[aria-label="${label}"]`);assert.ok(el,label);await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});}
async function draft(h){
  await until(()=>h.container.textContent.includes('zakres pozycji sprzedaży') && !button(h,'Odczytaj realizację paczek').disabled,'Own source');
  await click(button(h,'Rozdziel ilości na paczki'));
  await input(h,'Paczka 1 pozycja 1 SAME-SKU','1');
  await input(h,'Paczka 1 pozycja 3 BUNDLE','1');
  await input(h,'Paczka 2 pozycja 1 SAME-SKU','1');
  assert.equal(button(h,'Przygotuj pełny podgląd podziału').disabled,true,'Physical A total cannot substitute for the omitted expensive commercial UUID');
  await input(h,'Paczka 2 pozycja 2 SAME-SKU','1');
}
test('commercial parcels: actual component exact line identity, whole bundle and retained invalid-response retry',async t=>{
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
  const {createRoot}=await import('react-dom/client'),mod=await vite.ssrLoadModule(path.resolve('web/order-parcels.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts=[];
  function mount(f){globalThis.fetch=f.fetch.bind(f);api.setWorkspace(tenant);const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const h={container,async render(props={}){await act(async()=>root.render(React.createElement(StrictMode,null,React.createElement(mod.OrderParcelsPanel,{orderId:order,contextKey:context,readOnly:false,...props}))));},async close(){await act(async()=>root.unmount());container.remove();}};mounts.push(h);return h;}
  try{
    await t.test('duplicate SKU prices keep distinct source UUIDs; bundle is a complete unit',async()=>{
      const f=fixture(),h=mount(f);await h.render();try{
        await draft(h);assert.ok(h.container.textContent.includes('20,00 PLN'));assert.ok(h.container.textContent.includes('17,00 PLN'));
        await click(button(h,'Przygotuj pełny podgląd podziału'));
        await until(()=>h.container.textContent.includes('Podgląd całego podziału'),'Full frozen preview');
        const request=f.requests.find(r=>r.method==='POST').body;
        assert.equal(request.protocol,'commercial_v1');
        assert.deepEqual(request.parcels,[{source_kind:'demo',items:[{item_id:cheap,quantity:1},{item_id:bundle,quantity:1}],cod_minor:0},{source_kind:'demo',items:[{item_id:cheap,quantity:1},{item_id:expensive,quantity:1}],cod_minor:0}]);
        assert.ok(request.parcels.every(p=>!('products' in p)),'The client cannot choose physical components');
        assert.equal(button(h,'Zapisz cały plan paczek').disabled,true);
        await click(consent(h,'Sprawdziłem wszystkie ilości'));await click(button(h,'Zapisz cały plan paczek'));
        await until(()=>h.container.textContent.includes('Realizacja zapisanego planu'),'Plan');
        assert.equal(button(h,'Wydaj paczkę 1').disabled,true);
        await click(consent(h,'Potwierdzam rzeczywiste wydanie paczki 1'));await click(button(h,'Wydaj paczkę 1'));
        await until(()=>f.plan.origins[0].issued_quantity===1 && !button(h,'Odczytaj aktualny postęp planu').disabled,'First complete-unit dispatch');
        assert.equal(f.plan.order_status,'packed');assert.equal(f.source.products[0].remaining,2);assert.equal(f.source.products[1].remaining,0);
        assert.equal(button(h,'Wydaj paczkę 2').disabled,true,'A second parcel still needs its own consent');
      }finally{await h.close();mod.resetOrderParcelsContext('');}
    });
    await t.test('same SKU wrong commercial line response never releases exact pending; navigation/read are not retry',async()=>{
      const f=fixture(),h=mount(f);f.corrupt=true;await h.render();let next;try{
        await draft(h);await click(button(h,'Przygotuj pełny podgląd podziału'));
        await until(()=>mod.getOrderParcelsLocked(context) && h.container.textContent.includes('Wynik próby może być nieznany'),'Wrong frozen origin must retain unknown attempt');
        const first=f.requests.find(r=>r.method==='POST');await h.close();next=mount(f);await next.render({externalWriteBlocked:true});
        await until(()=>!button(next,'Odczytaj realizację paczek').disabled,'Same actor remount');
        await click(button(next,'Odczytaj zapisane plany'));await until(()=>!button(next,'Odczytaj realizację paczek').disabled,'Read settled');
        assert.equal(mod.getOrderParcelsLocked(context),true);assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
        f.corrupt=false;await click(consent(next,'Potwierdzam ręczne ponowienie tej samej próby'));await click(button(next,'Ponów dokładnie zachowaną próbę'));
        await until(()=>!mod.getOrderParcelsLocked(context),'Exact valid replay');
        const writes=f.requests.filter(r=>r.method==='POST');assert.equal(writes.length,2);assert.equal(writes[1].serialized,first.serialized);
        assert.equal(button(next,'Zapisz cały plan paczek').disabled,true,'Replay never implies apply consent');
      }finally{if(h.container.isConnected)await h.close();if(next)await next.close();mod.resetOrderParcelsContext('');}
    });
    await t.test('cancel remainder needs its own full preview and consent; lost ACK never enables a second dispatch',async()=>{
      const f=fixture(),h=mount(f);await h.render();let next;try{
        await draft(h);await click(button(h,'Przygotuj pełny podgląd podziału'));await until(()=>h.container.textContent.includes('Podgląd całego podziału'),'Preview');
        await click(consent(h,'Sprawdziłem wszystkie ilości'));await click(button(h,'Zapisz cały plan paczek'));await until(()=>h.container.textContent.includes('Realizacja zapisanego planu'),'Plan');
        await click(consent(h,'Potwierdzam rzeczywiste wydanie paczki 1'));await click(button(h,'Wydaj paczkę 1'));await until(()=>!button(h,'Odczytaj aktualny postęp planu').disabled,'Dispatch');
        await click(button(h,'Odczytaj niewydaną resztę'));await until(()=>h.container.textContent.includes('Niewydane paczki: 1'),'Remainder');
        await click(button(h,'Przygotuj podgląd anulowania reszty'));await until(()=>h.container.textContent.includes('Pełny podgląd anulowania niewydanej reszty'),'Complete cancellation preview');
        assert.equal(f.release,null);assert.equal(button(h,'Anuluj niewydaną resztę').disabled,true,'Reading or previewing cannot cancel');
        await click(consent(h,'Sprawdziłem wszystkie niewydane pozycje'));f.dropRelease=true;await click(button(h,'Anuluj niewydaną resztę'));
        await until(()=>mod.getOrderParcelsLocked(context) && h.container.textContent.includes('Wynik próby może być nieznany'),'Unknown release');
        const first=f.requests.find(r=>r.url.endsWith(`/${id(50)}/release`));await h.close();next=mount(f);await next.render();
        await until(()=>next.container.textContent.includes('Niewydany zakres anulowany') && !button(next,'Odczytaj realizację paczek').disabled,'Durable current progress after remount');
        assert.equal(mod.getOrderParcelsLocked(context),true,'A GET confirming cancellation must not clear unresolved write');
        assert.ok(![...next.container.querySelectorAll('button')].some(b=>b.textContent==='Wydaj paczkę 2'),'Cancelled quantities cannot dispatch');
        await click(consent(next,'Potwierdzam ręczne ponowienie tej samej próby'));await click(button(next,'Ponów dokładnie zachowaną próbę'));
        await until(()=>!mod.getOrderParcelsLocked(context) && next.container.textContent.includes('Zapisane anulowanie niewydanej reszty'),'Exact release replay');
        const writes=f.requests.filter(r=>r.url.endsWith(`/${id(50)}/release`));assert.equal(writes.length,2);assert.equal(writes[1].serialized,first.serialized);
        assert.equal(f.plan.origins.find(o=>o.item_id===expensive).issued_quantity,0);assert.equal(f.plan.origins.find(o=>o.item_id===expensive).cancelled_quantity,1);
        assert.equal(f.source.products[0].consumed_quantity,2);assert.equal(f.source.products[0].released_quantity,2);
      }finally{if(h.container.isConnected)await h.close();if(next)await next.close();mod.resetOrderParcelsContext('');}
    });
  }finally{for(const h of mounts)if(h.container.isConnected)await h.close();await vite.close();globalThis.fetch=oldFetch;for(const [k,d] of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
