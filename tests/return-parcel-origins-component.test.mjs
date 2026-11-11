import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual ReturnsPanel form and shared exact-attempt registry, controlled HTTP.
// It does not prove SQL issue ceilings, stock restoration or WMS fragment allocation.
const id=n=>`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const tenant=id(1),user=id(2),orderId=id(3),cheap=id(4),expensive=id(5),dispatch=id(6),origin=id(7);
const context=`${tenant}:${user}:admin:false`;
const order={id:orderId,status:'packed',version:3,currency:'PLN',documents:[],wms_lots_enabled:false,
  items:[{id:cheap,sku:'SAME',name:'Same line',price:1000,vat:23},{id:expensive,sku:'SAME',name:'Same line',price:1700,vat:23}],
  returns:{items:[{id:cheap,sku:'SAME',name:'Same line',quantity:2,returned:0,available:1},{id:expensive,sku:'SAME',name:'Same line',quantity:1,returned:0,available:0}],cases:[],refund_total:0,settled_total:0,shipping_available:0,meta:{cursor:null},parcel_origins_required:true,
    parcel_origins:[{origin_id:origin,item_id:cheap,dispatch_id:dispatch,parcel_index:0,shipment_id:id(8),quantity:1,available:1,components:[{product_id:id(9),quantity:1}],fragments:[]}]},
};
async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(fn,label){for(let i=0;i<80;i++){if(fn())return;await tick();}assert.ok(fn(),label);}
function button(h,label){const b=[...h.container.querySelectorAll('button')].find(v=>v.textContent===label);assert.ok(b,label);return b;}
async function click(el){assert.equal(el.disabled,false);await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
async function value(el,v){assert.ok(el);await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));});}
async function submit(h){const form=h.container.querySelector('.return-form');assert.ok(form);await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}

test('early RMA actual component only chooses issued commercial origins and retains exact unknown request',async()=>{
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,FormData:dom.window.FormData,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
  const {createRoot}=await import('react-dom/client'),mod=await vite.ssrLoadModule(path.resolve('web/returns.tsx')),registry=await vite.ssrLoadModule(path.resolve('web/b2b-dropshipping-returns.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const writes=[];let drop=true,changes=0;
  globalThis.fetch=async(url,options={})=>{
    assert.equal(url,`/api/orders/${orderId}/returns`);assert.equal(options.method,'POST');writes.push({body:JSON.parse(options.body),serialized:options.body});
    if(drop){drop=false;throw Error('Controlled lost RMA ACK');}
    return Response.json({id:id(10),reused:true});
  };
  api.setWorkspace(tenant);registry.resetDropshipReturnContext(context,false);
  const mounts=[];
  function mount(){const container=document.createElement('div');document.body.append(container);const root=createRoot(container);const h={container,async render(){await act(async()=>root.render(React.createElement(mod.ReturnsPanel,{order,write:true,contextKey:context,readOnly:false,onChanged:()=>{changes++;}})));},async close(){await act(async()=>root.unmount());container.remove();}};mounts.push(h);return h;}
  const h=mount();let next;
  try{
    await h.render();await click(button(h,'Nowa sprawa zwrotowa'));
    assert.equal(h.container.querySelectorAll('input[name^="origin-"]').length,1,'Unissued same-SKU line has no eligible source selector');
    assert.ok(h.container.textContent.includes('Brak dostępnego wydania'));
    const reason=h.container.querySelector('textarea[name=reason]');reason.value='Zwrot wydanej jednostki';
    await value(h.container.querySelector(`input[name="origin-${origin}"]`),'2');await submit(h);
    assert.equal(writes.length,0,'Sold quantity is not the issued return ceiling');
    await value(h.container.querySelector(`input[name="origin-${origin}"]`),'1');await submit(h);
    await until(()=>h.container.textContent.includes('Controlled lost RMA ACK'),'Unknown stored');
    assert.deepEqual(writes[0].body.items,[{item_id:cheap,quantity:1}]);
    assert.deepEqual(writes[0].body.parcel_origins,[{item_id:cheap,dispatch_id:dispatch,quantity:1}]);
    assert.equal(changes,0);await h.close();next=mount();await next.render();
    assert.equal(button(next,'Nowa sprawa zwrotowa').disabled,true,'Fresh RMA blocked by retained write');
    assert.equal(writes.length,1,'Remount must not POST');
    await click(button(next,'Ponów dokładną próbę sprawy'));await until(()=>changes===1,'Manual exact replay');
    assert.equal(writes.length,2);assert.equal(writes[1].serialized,writes[0].serialized);
    assert.equal(button(next,'Nowa sprawa zwrotowa').disabled,false);
  }finally{for(const m of mounts)if(m.container.isConnected)await m.close();registry.resetDropshipReturnContext('',false);await vite.close();globalThis.fetch=oldFetch;for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}dom.window.close();}
});

test('receipt distinguishes same-SKU historical lines and submits different decisions by immutable item UUID',async()=>{
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,FormData:dom.window.FormData,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
  const {createRoot}=await import('react-dom/client'),mod=await vite.ssrLoadModule(path.resolve('web/returns.tsx')),registry=await vite.ssrLoadModule(path.resolve('web/b2b-dropshipping-returns.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const returnId=id(12),physical=id(9),writes=[];let changes=0;
  // Return rows deliberately differ from the order row sequence: prices must join by UUID.
  const r={id:returnId,number:'QA-RETURN',version:1,kind:'return',state:'requested',warehouse_id:id(13),requested_shipping:0,reason:'Issued parcel return',legacy:false,exchange:null,can_exchange:false,documents:[],
    items:[{item_id:expensive,sku:'SAME',name:'Same line',requested:1,accepted:0,restocked:0,refund_amount:0,components:[{product_id:physical,quantity:1}]},{item_id:cheap,sku:'SAME',name:'Same line',requested:1,accepted:0,restocked:0,refund_amount:0,components:[{product_id:physical,quantity:1}]}],
    parcel_origins_required:true,parcel_origins:[{origin_id:id(14),item_id:expensive,dispatch_id:dispatch,parcel_index:0,shipment_id:id(8),requested:1,components:[{product_id:physical,quantity:1}],fragments:[]},{origin_id:origin,item_id:cheap,dispatch_id:dispatch,parcel_index:0,shipment_id:id(8),requested:1,components:[{product_id:physical,quantity:1}],fragments:[]}],
  };
  const currentOrder={...order,items:[{...order.items[0],quantity:2,line_total:2000},{...order.items[1],quantity:1,line_total:1700}],returns:{...order.returns,cases:[r]}};
  globalThis.fetch=async(url,options={})=>{
    assert.equal(options.headers['X-Workspace-ID'],tenant);
    if(url===`/api/b2b/dropshipping-returns/returns/${returnId}/context`){assert.equal(options.method,'GET');return Response.json({available:true,read_only:false,current_role:'admin',can_read:true,can_manage:true,can_read_value:true,can_preview:false,can_submit:false,context:{side:null,fulfillment_origin:'ordinary',can_receive_locally:true,local_origin:null,retail_items:[],case_refs:[]}});}
    assert.equal(url,`/api/returns/${returnId}/receive`);assert.equal(options.method,'POST');writes.push(JSON.parse(options.body));return Response.json({id:returnId,state:'refund_pending'});
  };
  api.setWorkspace(tenant);registry.resetDropshipReturnContext(context,false);
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container),h={container};
  try{
    await act(async()=>root.render(React.createElement(mod.ReturnsPanel,{order:currentOrder,write:true,contextKey:context,readOnly:false,onChanged:()=>{changes++;}})));
    await until(()=>[...container.querySelectorAll('button')].some(el=>el.textContent==='Rozpatrz i przyjmij'),'Authoritative ordinary receipt access');
    await click(button(h,'Rozpatrz i przyjmij'));
    const receiveForm=container.querySelector('.return-form');assert.ok(receiveForm);
    const rows=[...receiveForm.querySelectorAll('tbody tr')];assert.equal(rows.length,2);
    assert.ok(rows[0].textContent.includes('Pozycja 1 · SAME'));assert.match(rows[0].textContent,/1 szt\. \/ 17,00\s*zł za całą pozycję/);
    assert.ok(rows[1].textContent.includes('Pozycja 2 · SAME'));assert.match(rows[1].textContent,/2 szt\. \/ 20,00\s*zł za całą pozycję/);
    const decisionInputs=[...receiveForm.querySelectorAll('input[name^="accept-"],input[name^="restock-"]')];
    assert.equal(new Set(decisionInputs.map(el=>el.getAttribute('aria-label'))).size,4,'Same SKU has four distinct accessible decision labels');
    const byLabel=label=>receiveForm.querySelector(`input[aria-label="${label}"]`);
    assert.equal(byLabel('Przyjęte pozycji 1 SAME').name,`accept-${expensive}`);
    assert.equal(byLabel('Przyjęte pozycji 2 SAME').name,`accept-${cheap}`);
    await value(byLabel('Przyjęte pozycji 1 SAME'),'1');await value(byLabel('Do sprzedaży pozycji 1 SAME'),'0');
    await value(byLabel('Przyjęte pozycji 2 SAME'),'0');await value(byLabel('Do sprzedaży pozycji 2 SAME'),'0');
    receiveForm.querySelector('textarea[name=note]').value='Droższa pozycja uszkodzona; tańsza nieprzyjęta.';
    await submit(h);await until(()=>changes===1,'Distinct receipt decisions submitted');
    assert.equal(writes.length,1);assert.deepEqual(writes[0].items,[{item_id:expensive,accepted:1,restocked:0},{item_id:cheap,accepted:0,restocked:0}]);
    assert.equal(writes[0].version,1);assert.equal(writes[0].shipping_refund,0);assert.equal(writes[0].wms_lots,undefined,'Damaged/rejected decisions never invent stock restoration');
  }finally{await act(async()=>root.unmount());container.remove();registry.resetDropshipReturnContext('',false);await vite.close();globalThis.fetch=oldFetch;for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}dom.window.close();}
});
