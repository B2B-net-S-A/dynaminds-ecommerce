/** Actual React panels and source-extracted OrderDetail; controlled ports, no app/server/PG. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React,{act} from 'react';
import {transformSync} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const id=n=>n.toString(16).padStart(8,'0')+'-1000-4000-8000-000000000001';
const order={id:id(1),tenant_id:id(2),channel_id:id(3),version:'7',source:'woocommerce',status:'paid',currency:'PLN',number:'TEST',payment_mode:'prepaid',total:1230,shipping_cost:0,customer_name:'Klient',address:{street:'Test',postal_code:'00-000',city:'Test',country:'PL'},events:[],items:[],picking_items:[],documents:[{id:id(4),number:'FV-test'}],shipments:[],portal_enabled:true,portal_token:'test-only',returns:{has_partial:false}};
test('restored order UI keeps local reads and refuses all exposed payment/status writes',async t=>{
 const dom=new JSDOM('<body/>',{url:'http://127.0.0.1:4106/'}),prior=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),api=await vite.ssrLoadModule(path.resolve('web/api.ts')),{OrderChannelStatus,OrderStatusConfig}=await vite.ssrLoadModule(path.resolve('web/order-status.tsx')),{EbayFulfillmentPanel}=await vite.ssrLoadModule(path.resolve('web/ebay-fulfillment.tsx')),{AmazonFulfillmentPanel}=await vite.ssrLoadModule(path.resolve('web/amazon-fulfillment.tsx')),{SourcePaymentsPanel}=await vite.ssrLoadModule(path.resolve('web/source-payments.tsx')),{PortalAccess}=await vite.ssrLoadModule(path.resolve('web/return-queue.tsx')),{createRoot}=await import('react-dom/client');
 const roots=new Set();let requests=[],handler;api.setWorkspace(order.tenant_id);globalThis.fetch=async(url,init={})=>{const r={url,method:init.method??'GET',body:init.body};requests.push(r);return handler(r);};
 async function mount(Component,initial){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);roots.add(root);let props=initial;const h={el,async render(patch={}){props={...props,...patch};await act(async()=>root.render(React.createElement(Component,props)));},async close(){await act(async()=>root.unmount());roots.delete(root);el.remove();}};await h.render();return h;}
 const button=(h,text)=>[...h.el.querySelectorAll('button')].find(b=>b.textContent.includes(text));
 const click=async(h,text)=>{const b=button(h,text);assert(b&&!b.disabled,text);await act(async()=>b.click());};
 try{
  await t.test('status retains its LOCAL GET/history/refresh while provider preview and plan actions disappear',async()=>{
   requests=[];handler=r=>{assert.equal(r.method,'GET');return Response.json({channel:{id:order.channel_id,name:'Lokalny sklep',provider:'woocommerce',settings:{}},config:{enabled:true},target:'processing',local_status:'paid',data:[{id:id(5),remote:{status:'processing'},state:'queued',phase:'ready',target:'processing'}]});};
   const h=await mount(OrderChannelStatus,{order,readOnly:true,localWooContext:{tenantId:order.tenant_id,userId:id(6),admin:true,readOnly:true}});assert.match(h.el.textContent,/Status w kanale/);assert.match(h.el.textContent,/W kolejce/);assert.equal(requests.length,1);assert.equal(button(h,'Podgląd zmiany statusu'),undefined);assert.equal(button(h,'Anuluj oczekujący zapis'),undefined);await click(h,'Odśwież status kanału');assert.equal(requests.length,2);assert(requests.every(r=>r.url.endsWith('/channel-status')&&r.method==='GET'));await h.close();
  });
  await t.test('a genuine local status500 remains visible and is not disguised as provider blocking',async()=>{
   requests=[];handler=()=>Response.json({detail:'Lokalny status niedostępny'},{status:500});const h=await mount(OrderChannelStatus,{order,readOnly:true});assert.match(h.el.textContent,/Lokalny status niedostępny/);assert.equal(requests.length,1);assert(requests[0].url.endsWith('/channel-status'));await h.close();
  });
  await t.test('ordinary writable channel preview remains available',async()=>{
   requests=[];handler=r=>Response.json(r.method==='POST'?{id:id(7),remote:{status:'processing'},target:'completed'}:{channel:{id:order.channel_id,name:'Sklep',provider:'woocommerce',settings:{simulation:true}},config:null,target:'completed',local_status:'paid',data:[]});const h=await mount(OrderChannelStatus,{order,readOnly:false});await click(h,'Podgląd zmiany statusu');assert.equal(requests.filter(r=>r.method==='POST').length,1);assert(requests.some(r=>r.url.endsWith('/channel-status/preview')));await h.close();
  });
  await t.test('source-payment read API/apply/configuration and forced submits refuse; local GET refresh remains enabled',async()=>{
   requests=[];handler=r=>{assert.equal(r.method,'GET');return Response.json(r.url.endsWith('/payment-sync')?{config:{version:1,enabled:true,interval_seconds:60}}:{channel:{name:'Sklep',simulation:true},totals:{amount:1230},data:[{id:id(8),state:'review',currency:'PLN',source_amount:1230,previous_amount:0,delta:1230,created_at:'2026-10-19T00:00:00Z'}]});};
   const h=await mount(SourcePaymentsPanel,{order,readOnly:true,onChanged:()=>assert.fail('no mutation')});assert.equal(button(h,'Odczytaj płatność').disabled,true);assert.equal(button(h,'Zapisz wpłatę ze źródła').disabled,true);await click(h,'Harmonogram płatności');for(const f of h.el.querySelectorAll('form'))await act(async()=>f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert(requests.every(r=>r.method==='GET'));const n=requests.length;await click(h,'Odśwież płatność kanału');assert.equal(requests.length,n+2);assert([...h.el.querySelectorAll('input')].every(e=>e.disabled));await h.close();
  });
  await t.test('retained status/source-payment writable callbacks cannot bypass a later readonly render',async()=>{
   requests=[];handler=r=>{assert.equal(r.method,'GET');return Response.json(r.url.endsWith('/channel-status')?{channel:{id:order.channel_id,name:'Sklep',provider:'woocommerce',settings:{simulation:true}},target:'completed',local_status:'paid',data:[]}:r.url.endsWith('/payment-sync')?{config:{version:1,enabled:true,interval_seconds:60}}:{channel:{name:'Sklep',simulation:true},totals:{amount:1230},data:[]});};
   for(const [Panel,label]of [[OrderChannelStatus,'Podgląd zmiany statusu'],[SourcePaymentsPanel,'Odczytaj płatność']]){const h=await mount(Panel,{order,readOnly:false,onChanged:()=>assert.fail('no writes')});const b=button(h,label),old=b[Object.keys(b).find(k=>k.startsWith('__reactProps'))].onClick;await h.render({readOnly:true});const n=requests.length;await act(async()=>old());assert.equal(requests.length,n);await h.close();}assert(requests.every(r=>r.method==='GET'));
  });
  await t.test('status configuration keeps GET, mappings and history but blocks PATCH, plans and previous writable submit',async()=>{
   requests=[];handler=r=>{assert.equal(r.method,'GET');return Response.json({channel:{id:order.channel_id,name:'Statusy sklepu',provider:'prestashop',settings:{simulation:false}},config:{version:2,enabled:true},mappings:{paid:'2'},jobs:[{state:'done',stats:{checked:1}}],data:[{id:id(11),remote:{status:'2'},state:'queued',phase:'ready',target:'2'}]});};
   const h=await mount(OrderStatusConfig,{channelId:order.channel_id,readOnly:false});const form=h.el.querySelector('form'),oldSubmit=form[Object.keys(form).find(k=>k.startsWith('__reactProps'))].onSubmit;const cancel=button(h,'Anuluj oczekujący zapis'),oldCancel=cancel[Object.keys(cancel).find(k=>k.startsWith('__reactProps'))].onClick;
   await h.render({readOnly:true});assert.match(h.el.textContent,/W kolejce/);assert.match(h.el.textContent,/Ostatni przegląd: done/);assert([...h.el.querySelectorAll('form input,form button')].every(e=>e.disabled));assert.equal(button(h,'Anuluj oczekujący zapis'),undefined);await act(async()=>{await oldSubmit({preventDefault(){},currentTarget:form});await oldCancel();h.el.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});assert.equal(requests.length,1);await click(h,'Odśwież konfigurację statusów');assert.equal(requests.length,2);assert(requests.every(r=>r.method==='GET'));await h.close();
  });
  for(const [provider,Panel]of [['ebay',EbayFulfillmentPanel],['amazon',AmazonFulfillmentPanel]])await t.test(provider+' keeps local shipment history/refresh and blocks all mutation phases plus stale callback',async()=>{
   const packageDetail={carrierCode:'DPD',trackingNumber:'TRACK-1',shipDate:'2026-10-19T00:00:00Z',packageReferenceId:'PACK-1',orderItems:[{orderItemId:'ITEM-1',quantity:1}]},payload=provider==='amazon'?{packageDetail}:{shippingCarrierCode:'DPD',trackingNumber:'TRACK-1',shippedDate:'2026-10-19T00:00:00Z',lineItems:[{lineItemId:'ITEM-1',quantity:1}]};
   const data={ready:true,channel:{settings:{simulation:false}},data:[['preview','ready'],['queued','ready'],['failed','write_started']].map(([state,phase],i)=>({id:id(20+i),state,phase,created_at:'2026-10-19T00:00:00Z',payload,remote:{existing:false},error:state==='failed'?'Zachowany niepewny wynik':null}))};
   requests=[];handler=r=>Response.json(r.method==='GET'?data:{});const h=await mount(Panel,{order,readOnly:false});await click(h,'Anuluj przekazanie');assert.equal(requests.filter(r=>r.method==='POST').length,1,'ordinary writable cancel remains available');const b=button(h,'Anuluj przekazanie'),oldClick=b[Object.keys(b).find(k=>k.startsWith('__reactProps'))].onClick;
   await h.render({readOnly:true});const n=requests.length;assert.match(h.el.textContent,/TRACK-1/);assert.match(h.el.textContent,/Zachowany niepewny wynik/);assert.equal(h.el.querySelectorAll('article').length,3);assert.equal(h.el.querySelectorAll('details').length,3);assert.equal(h.el.querySelectorAll('input').length,0);assert.equal(h.el.querySelectorAll('button').length,1,'only local refresh remains');await act(async()=>oldClick());assert.equal(requests.length,n,'prior writable callback refuses POST after readonly change');await click(h,'Odśwież wysyłkę');assert.equal(requests.length,n+1);assert.equal(requests.at(-1).method,'GET');assert(requests.at(-1).url.endsWith('/'+provider+'-fulfillment'));await h.close();
  });
  await t.test('actual OrderDetail passes readonly custody, hides fulfillment/portal/note writes and preserves navigation',async()=>{
   // The card module is compiled as is; its own pieces (header, aside, products, sections, parts, api) are the real
   // modules, every other panel is a stub that records its props.
   const source=fs.readFileSync(path.resolve('web/order-card.tsx'),'utf8');assert(source.length>20000);let back=0;const seen={};
   const own=/^(\.\/order-card-|\.\/order-detail-parts$|\.\/order-section-api$|\.\/order-stage$|\.\/api$|\.\.\/shared\/|react$|lucide-react$)/;
   const stub=name=>/^[A-Z]/.test(name)?p=>{seen[name]=p;return React.createElement('div',null,p.children);}:name.startsWith('subscribe')?()=>()=>{}:name==='getPrintJobsMutationState'?()=>({locked:false}):name.startsWith('create')?()=>({}):()=>false;
   const modules={};
   for(const [,spec] of source.matchAll(/from '([^']+)'/g)){if(modules[spec])continue;
    if(spec==='react'){modules[spec]=React;continue;}
    if(own.test(spec)){const real=await vite.ssrLoadModule(spec.startsWith('.')?path.resolve('web',spec+(spec.startsWith('../')?'.ts':(fs.existsSync(path.resolve('web',spec+'.tsx'))?'.tsx':'.ts'))):spec);modules[spec]=spec==='./order-detail-parts'?{...real,OrderNotesPanel:p=>{seen.OrderNotesPanel=p;return null;}}:real;continue;}
    modules[spec]=new Proxy({},{get:(_,k)=>k==='__esModule'?true:typeof k==='string'?stub(k):undefined,has:()=>true});}
   const compiled=transformSync(source,{loader:'tsx',format:'cjs',target:'es2022',jsx:'automatic'}).code,mod={exports:{}};
   const jsxRuntime=await import('react/jsx-runtime');
   new Function('require','module','exports',compiled)(spec=>spec==='react/jsx-runtime'?jsxRuntime:modules[spec],mod,mod.exports);
   const OrderDetail=mod.exports.OrderDetail;
   handler=r=>r.method==='GET'&&r.url.endsWith('/orders/'+order.id)?Response.json(order):Response.json({data:[]});requests=[];
   const writes=()=>requests.filter(r=>r.method!=='GET').length;
   const h=await mount(OrderDetail,{splitAvailable:false,admin:true,workspaceId:order.tenant_id,userId:id(6),packingContextKey:order.tenant_id+':'+id(6),warehousePolicyWriteBlocked:false,readOnly:false,id:order.id,refresh:0,write:true,notify:()=>{},reload:()=>{},onBack:()=>back++,onOpenOrder:()=>{}});
   for(let i=0;i<20&&!button(h,'Przekaż do kompletacji');i++)await act(async()=>new Promise(r=>setTimeout(r,10)));
   assert(button(h,'Przekaż do kompletacji'));assert(button(h,'Nowy link kupującego'));assert(h.el.querySelector('[aria-label="Edytuj: Dane klienta"]'));const priorAction=seen.OrderNotesPanel.action;
   await h.render({readOnly:true});for(let i=0;i<20&&button(h,'Przekaż do kompletacji');i++)await act(async()=>new Promise(r=>setTimeout(r,10)));
   assert.equal(button(h,'Przekaż do kompletacji'),undefined);assert.equal(button(h,'Anuluj zamówienie'),undefined);assert.equal(button(h,'Nowy link kupującego'),undefined);assert.equal(h.el.querySelector('[aria-label="Edytuj: Dane klienta"]'),null);assert.equal(button(h,'Wyślij e-mail'),undefined);
   assert.equal(seen.PaymentsPanel.write,false);assert.equal(seen.PaymentsPanel.admin,false);assert.equal(seen.PaymentsPanel.readOnly,true);assert.equal(seen.OrderOperationsPanel.write,false);assert.equal(seen.OrderChannelStatus.readOnly,true);assert.equal(seen.SourcePaymentsPanel.readOnly,true);assert.equal(seen.OrderNotesPanel.write,false);
   order.source='ebay';await h.render({refresh:1});for(let i=0;i<20&&!seen.EbayFulfillmentPanel;i++)await act(async()=>new Promise(r=>setTimeout(r,10)));assert.equal(seen.EbayFulfillmentPanel.readOnly,true);
   order.source='amazon';await h.render({refresh:2});for(let i=0;i<20&&!seen.AmazonFulfillmentPanel;i++)await act(async()=>new Promise(r=>setTimeout(r,10)));assert.equal(seen.AmazonFulfillmentPanel.readOnly,true);order.source='woocommerce';
   const n=writes();await priorAction('/orders/'+order.id+'/status',{status:'cancelled'});assert.equal(writes(),n,'previous writable callback cannot write after readonly scope change');
   const list=h.el.querySelector('button[title="Lista zamówień"]');assert(list);await act(async()=>list.click());assert.equal(back,1);assert(h.el.querySelector('a[href="/api/documents/'+id(4)+'/print"]'));await h.close();
  });
 }finally{for(const root of roots)await act(async()=>root.unmount());await vite.close();globalThis.fetch=oldFetch;for(const[k,d]of prior){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
