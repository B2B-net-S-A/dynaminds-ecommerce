// Actual carrier forms, synthetic same-origin API responses. No app/db/provider runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
// Plain-data server modules the web bundle imports at runtime (no Node builtin, no import): web/tracking.tsx labels (11c03dc).
const pureServer=/\/server\/shipment-status-labels(\.ts)?$/;
assert(!/^\s*import\b/m.test(fs.readFileSync('server/shipment-status-labels.ts','utf8')),'shipment-status-labels must stay import-free to be allowed');
const oid='11111111-1111-4111-8111-111111111111';
const address={recipient_name:'Nowy odbiorca',street:'Nowa aleja 12/3',city:'Łódź',postal_code:'90-001',country:'PL',phone:'+48123456789'};
const makeOrder=()=>({id:oid,status:'packed',customer_name:'Pierwotny nabywca',email:'buyer@example.test',address:{street:'Stara 5',city:'Warszawa',postal_code:'01-001',phone:'500600700',country:'PL'},shipments:[],shipping_active:false,total:1000,payment_mode:'prepaid',payment:{amount_due:0},effective_delivery:{available:true,kind:'address',origin:'override',delivery:address,delivery_version:'1',delivery_hash:'a'.repeat(64)}});
test('actual carriers use operational defaults without guessing street/building or altering stored plans',async t=>{
 const dom=new JSDOM('<body></body>',{url:'http://carrier-controlled.localhost'}),saved=new Map();let root,box,vite,order,Component,calls=[];
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(input,init)=>{
   const p=String(input),method=init?.method??'GET';calls.push({path:p,method,body:init?.body});
   assert(p.startsWith('/api/'),'Only synthetic same-origin API');
   let body;if(p.endsWith('/shipping/channels'))body={data:[{id:'22222222-2222-4222-8222-222222222222',provider:'inpost',name:'InPost test',mode:'sandbox',settings:{simulation:true}},{id:'33333333-3333-4333-8333-333333333333',provider:'dpd',name:'DPD test',mode:'sandbox',settings:{simulation:true}}]};
   else if(p.endsWith('/shipping'))body={data:[],meta:{}};
   else if(p.endsWith('/shipping/preview'))body={id:'44444444-4444-4444-8444-444444444444'};
   else assert.fail('Unexpected synthetic API '+p);
   return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
 }})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,writable:true,configurable:true});}
 const flush=()=>act(async()=>{await new Promise(r=>setImmediate(r));});
 const until=async f=>{for(let i=0;i<100;i++){if(f())return;await flush();}assert(f());};
 const button=name=>{const b=[...box.querySelectorAll('button')].find(b=>b.textContent.trim()===name);assert(b,name);return b;};
 const click=async el=>{assert(!el.disabled);await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));await flush();};
 const render=async()=>{await act(async()=>root.render(React.createElement(Component,{order,write:true,admin:false,onChanged:()=>{}})));await flush();};
 async function mount(c){Component=c;order=makeOrder();calls=[];box=document.createElement('div');document.body.append(box);root=(await import('react-dom/client')).createRoot(box);await render();await until(()=>!box.querySelector('.shipping-actions button')?.disabled);}
 async function unmount(){if(root){await act(async()=>root.unmount());box.remove();root=null;}}
 try{
  vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error',plugins:[{name:'deny-server-runtime',enforce:'pre',resolveId(s){if(s==='pg'||s==='fastify'||s.includes('/server/')&&!pureServer.test(s))assert.fail('Runtime import '+s);}}]});
  const inpost=await vite.ssrLoadModule(path.resolve('web/shipping.tsx')),dpd=await vite.ssrLoadModule(path.resolve('web/dpd-shipping.tsx'));
  await t.test('DPD full operational street/name/phone; explicit receiver survives unrelated rerender',async()=>{await mount(dpd.DpdShippingPanel);try{
   await click(button('Przygotuj przesyłkę DPD'));assert.equal(box.querySelector('[name=receiver_name]').value,address.recipient_name);assert.equal(box.querySelector('[name=receiver_address]').value,address.street);assert.equal(box.querySelector('[name=receiver_phone]').value,address.phone);
   box.querySelector('[name=receiver_address]').value='Jawny odbiorca operatora 8';order={...order,note:'Reread'};await render();assert.equal(box.querySelector('[name=receiver_address]').value,'Jawny odbiorca operatora 8');assert.equal(calls.filter(c=>c.method==='POST').length,0);
  }finally{await unmount();}});
  await t.test('InPost full reference, no guessed split; explicit street/building confirmation fences POST',async()=>{await mount(inpost.ShippingPanel);try{
   await click(button('Przygotuj przesyłkę'));const select=box.querySelector('[name=service]');await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(select,'inpost_courier_standard');select.dispatchEvent(new Event('change',{bubbles:true}));});await flush();
   assert(box.textContent.includes(address.street));assert.equal(box.querySelector('[name=street]').value,'');assert.equal(box.querySelector('[name=building_number]').value,'');assert.equal(box.querySelector('[name=city]').value,address.city);
   await act(async()=>box.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(calls.filter(c=>c.method==='POST').length,0);assert(box.querySelector('[role=alert]').textContent.includes('osobny numer'));
  }finally{await unmount();}});
  await t.test('new delivery basis closes only unaccepted draft; unknown canonical kind never autofills source buyer',async()=>{await mount(dpd.DpdShippingPanel);try{
   await click(button('Przygotuj przesyłkę DPD'));order={...order,effective_delivery:{...order.effective_delivery,delivery_version:'2',delivery_hash:'b'.repeat(64),delivery:{...address,street:'Najnowsza 7'}}};await render();assert.equal(box.querySelector('form'),null);await click(button('Przygotuj przesyłkę DPD'));assert.equal(box.querySelector('[name=receiver_address]').value,'Najnowsza 7');
   order={...order,effective_delivery:{...order.effective_delivery,kind:'unknown',origin:null,delivery:null,delivery_hash:'c'.repeat(64)}};await render();await click(button('Przygotuj przesyłkę DPD'));assert.equal(box.querySelector('[name=receiver_address]').value,'');assert.equal(box.querySelector('[name=receiver_name]').value,'');assert.equal(calls.filter(c=>c.method==='POST').length,0);
  }finally{await unmount();}});
 }finally{await unmount();if(vite)await vite.close();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
