import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Actual OrderDetail and ReturnsPanel, controlled HTTP. No SQL/native proof.
const id = n => `${String(n).padStart(8, '0')}-1690-4169-8169-169169169169`;
const tenant=id(1), user=id(2), orderId=id(3), rma=id(4), warehouse=id(5);
const context=`${tenant}:${user}:operator`, scope=context+':false';
const clone=v=>structuredClone(v);
function returnCase(extra={}) { return { id:rma,order_id:orderId,warehouse_id:warehouse,number:'RMA-ON-169',
  version:'1',kind:'return',state:'requested',legacy:true,can_exchange:false,exchange:null,
  reason:'Pełny zwrot oryginalnych pozycji',created_at:'2026-10-07T12:00:00Z',requested_shipping:0,refund_amount:0,
  items:[{item_id:id(10),sku:'SAME',name:'Produkt oryginalnej pozycji',requested:1,accepted:0,restocked:0,refund_amount:0,components:[{product_id:id(20),quantity:1}]},
    {item_id:id(11),sku:'SAME',name:'Oryginalny zestaw',requested:1,accepted:0,restocked:0,refund_amount:0,components:[{product_id:id(21),quantity:1},{product_id:id(22),quantity:1}]}],...extra }; }
function order(on=true) { return { id:orderId,number:'OWN-ORDER-169',version:'2',status:'return_initiated',fulfillment_kind:'local',source:'manual',
  created_at:'2026-10-07T11:00:00Z',currency:'PLN',total:2700,payment_mode:'prepaid',payment:{},customer_name:'Własny klient',email:'own@example.test',
  address:{street:'Testowa',postal_code:'00-000',city:'Test',country:'PL'},shipping_cost:0,events:[],tags:[],picking_items:[],shipments:[],documents:[],
  ...(on?{wms_lots_enabled:true}:{}), items:[{id:id(10),sku:'SAME',name:'Produkt oryginalnej pozycji',quantity:1,line_total:1000,price:1000,vat:23},
    {id:id(11),sku:'SAME',name:'Oryginalny zestaw',quantity:1,line_total:1700,price:1700,vat:23}],
  returns:{cases:[returnCase()],items:[],refund_total:0,settled_total:0,shipping_available:0,meta:{cursor:null},has_partial:false} }; }
function fixture(o=order()) {
  const f={order:o,reads:[],writes:[],local:true,missing:false,page:null,held:null,returnLost:false};
  f.fetch=async(url,init={})=>{
    const u=new URL(String(url),'http://127.0.0.1'),p=u.pathname.replace(/^\/api/,''),method=init.method??'GET';
    if(method!=='GET') { f.writes.push({path:p,method,body:JSON.parse(init.body),raw:init.body});
      if(f.returnLost){assert.equal(p,'/returns/'+rma+'/receive');assert.equal(method,'POST');throw TypeError('Controlled retained return ACK loss');}
      assert.equal(p,'/orders/'+orderId+'/status');assert.equal(method,'PATCH');return Response.json({}); }
    f.reads.push(p+u.search);
    if(p==='/orders/'+orderId)return Response.json(clone(f.order));
    if(p==='/orders/'+orderId+'/returns')return f.held??Response.json(clone(f.page));
    if(p.startsWith('/b2b/dropshipping-returns/returns/')&&p.endsWith('/context'))return Response.json({available:true,read_only:false,current_role:'operator',can_read:true,can_manage:false,can_read_value:false,can_preview:false,can_submit:false,
      context:{side:null,fulfillment_origin:'ordinary',can_receive_locally:f.local,local_origin:null,retail_items:[],case_refs:[]}});
    const flags={available:true,read_only:false,current_role:'operator',can_read:true,can_write:true,can_admin:false,can_read_value:true};
    if(p==='/wms-lots')return f.missing?Response.json({detail:'Moduł partii jest niedostępny'},{status:503}):Response.json({...flags,policy:{enabled:true,version:'1',method:'FIFO',currency:'PLN',exponent:2},warehouses:[{id:warehouse,name:'Własny magazyn',code:'OWN'}],limits:{},can_return:true,can_receive:true,can_issue:true,can_adjust:false,can_transfer:false,can_activate:false});
    if(p===`/wms-lots/orders/${orderId}/return-fragments`)return Response.json({...flags,data:[0,1,2].map((n)=>({id:id(30+n),product_id:id(20+n),lot_id:id(40+n),layer_id:id(50+n),lot_code:['ZERO','KNOWN','UNKNOWN'][n],quantity:1,returned_quantity:0,remaining:1,unit_cost_minor:['0','1000',null][n],value_minor:['0','1000',null][n],currency:'PLN',location:'ORIGINAL'})),meta:{cursor:null}});
    if(p==='/inventory/snapshot')return Response.json({data:u.searchParams.get('product_ids').split(',').map(product_id=>({product_id,version:'1'}))});
    return Response.json({detail:'Unrelated controlled reader unavailable'},{status:503});
  };return f;
}
const button=(h,label)=>[...h.container.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
const article=(h,n='RMA-ON-169')=>[...h.container.querySelectorAll('.return-case')].find(a=>a.querySelector('strong')?.textContent.includes(n));
let flushControlled=null;
async function tick(){if(flushControlled)await flushControlled();else await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(fn,note){for(let i=0;i<80;i++){if(fn())return;await tick();}assert.ok(fn(),note);}
async function click(b){assert.ok(b);assert.equal(b.matches(':disabled'),false);await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));}

test('real ON order-return bridge and legacy OFF status — controlled DOM',async t=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
  for(const [k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,location:dom.window.location,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,CustomEvent:dom.window.CustomEvent,FormData:dom.window.FormData,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){
    saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});}
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  let vite;const mounts=[];const mainPath=path.resolve('web/main.tsx');
  try{
    vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error',plugins:[{name:'actual-order-detail-no-browser-bootstrap',enforce:'pre',transform(code,file){
      if(file.split('?')[0]!==mainPath)return;const start=code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)");assert.ok(start>0);return{code:code.slice(0,start)+'\nexport { OrderDetail as OrderDetailUnderTest };\n',map:null};}}]});
    const {createRoot}=await import('react-dom/client'),main=await vite.ssrLoadModule(mainPath),returns=await vite.ssrLoadModule(path.resolve('web/returns.tsx')),
      api=await vite.ssrLoadModule(path.resolve('web/api.ts')),shared=await vite.ssrLoadModule(path.resolve('web/b2b-dropshipping-returns.tsx')),
      parcels=await vite.ssrLoadModule(path.resolve('web/order-parcels.tsx')),intake=await vite.ssrLoadModule(path.resolve('web/return-destinations-intake.tsx')),
      statuses=await vite.ssrLoadModule(path.resolve('web/return-destination-statuses.tsx')),policies=await vite.ssrLoadModule(path.resolve('web/warehouse-inventory-policies.tsx'));
    async function mount(f,parent=false){
      for(const previous of mounts)if(previous.container.isConnected)await previous.close();
      const replies=[];
      globalThis.fetch=(...args)=>new Promise((resolve,reject)=>replies.push({args,resolve,reject}));
      await act(async()=>{api.setWorkspace(tenant);shared.resetDropshipReturnContext(context,false);parcels.resetOrderParcelsContext(scope);intake.resetReturnDestinationsIntakeContext(scope);statuses.resetReturnDestinationStatusesContext(scope);policies.resetWarehouseInventoryPoliciesContext(scope);});
      const container=document.createElement('div');document.body.append(container);const root=createRoot(container),h={container,changed:0,notices:[],props:parent?{admin:false,workspaceId:tenant,packingContextKey:context,warehousePolicyWriteBlocked:false,readOnly:false,id:orderId,refresh:0,write:true,notify:(...m)=>h.notices.push(m),reload:()=>{h.changed++;},onBack:()=>{},onOpenOrder:()=>{}}:{order:f.order,write:true,contextKey:context,readOnly:false,onChanged:()=>{h.changed++;}},
        async flush(){for(let turn=0;turn<8;turn++)await act(async()=>{
            for(const reply of replies.splice(0)){
              // Held reads are started inside act too, but deliberately not
              // awaited until the test releases their actual controlled ACK.
              Promise.resolve(f.fetch(...reply.args)).then(reply.resolve,reply.reject);
            }
            await new Promise(r=>setTimeout(r,0));
        });assert.equal(replies.length,0,'Controlled nested requests settled');},
        async render(patch={}){h.props={...h.props,...patch};await act(async()=>root.render(React.createElement(parent?main.OrderDetailUnderTest:returns.ReturnsPanel,h.props)));await h.flush();},
        async close(){await h.flush();await act(async()=>{root.unmount();await new Promise(r=>setTimeout(r,0));});container.remove();}};
      mounts.push(h);flushControlled=()=>h.flush();
      try{await h.render();return h;}catch(e){await h.close();throw e;}
    }
    const focus=()=>({contextKey:scope,orderId,orderVersion:'2',token:crypto.randomUUID()});
    await t.test('actual OrderDetail ON opens original RMA and real fragment selector without status PATCH or automatic intake',async()=>{
      const f=fixture(),h=await mount(f,true);await until(()=>button(h,'Rozpatrz zwrot i wybierz partie'),'Actual order shortcut');
      assert.equal(button(h,'Przyjmij cały zwrot'),undefined);await click(button(h,'Rozpatrz zwrot i wybierz partie'));
      await until(()=>article(h)?.querySelector('[aria-label="Pierwotne partie przyjmowanego zwrotu"]'),'Actual ReturnCase WMS form');
      assert.equal(button(h,'Zapisz przyjęcie').matches(':disabled'),true);assert.deepEqual(f.writes,[]);
      await until(()=>button(h,'Wczytaj wszystkie fragmenty i wersje stanów zwrotu'),'Actual WMS policy read exposes its fragment selector');
      await click(button(h,'Wczytaj wszystkie fragmenty i wersje stanów zwrotu'));
      await until(()=>article(h).textContent.includes('Odczytano cały zakres: 3 fragmentów'),'All genuine fragment pages');
      assert.ok(article(h).textContent.includes('Oryginalny zestaw'));assert.ok(article(h).textContent.includes('ZERO'));assert.ok(article(h).textContent.includes('UNKNOWN'));
      assert.equal(article(h).querySelectorAll('.wms-table tbody tr').length,3);assert.equal(button(h,'Zapisz przyjęcie').matches(':disabled'),true,'Reading fragments never chooses quantities or confirms intake');
      assert.deepEqual(f.writes,[]);assert.equal(h.changed,0);await h.close();
    });
    await t.test('actual OFF order with omitted ON field preserves one legacy status PATCH',async()=>{
      const f=fixture(order(false)),h=await mount(f,true);await until(()=>button(h,'Przyjmij cały zwrot'),'Actual OFF shortcut');await click(button(h,'Przyjmij cały zwrot'));
      await until(()=>h.changed===1,'Legacy status ACK');assert.deepEqual(f.writes.map(({raw,...w})=>w),[{path:'/orders/'+orderId+'/status',method:'PATCH',body:{status:'return_received',expected_version:'2'}}]); // web/main.tsx status actions carry the read order version (orderStatusInput)
      assert.equal(h.container.querySelector('[aria-label="Pierwotne partie przyjmowanego zwrotu"]'),null);await h.close();
    });
    await t.test('full actual cases wrapper resolves a legacy RMA on an older page instead of selecting by SKU',async()=>{
      const f=fixture();f.order.returns.cases=[returnCase({id:id(70),number:'RMA-OTHER',state:'closed'})];f.order.returns.meta.cursor=id(71);f.page={cases:[returnCase()],meta:{cursor:null}};
      const h=await mount(f);await h.render({receiveFocus:focus()});await until(()=>article(h)?.querySelector('form'),'Requested older RMA opens');
      assert.equal(article(h,'RMA-OTHER').querySelector('form'),null);assert.ok(f.reads.includes('/orders/'+orderId+'/returns?after='+id(71)));assert.deepEqual(f.writes,[]);await h.close();
    });
    await t.test('ambiguous and foreign case pages refuse automatic focus without any write',async()=>{
      for(const foreign of [false,true]){const f=fixture();f.order.returns.meta.cursor=id(71);f.page={cases:[returnCase({id:id(72),order_id:foreign?id(99):orderId,number:'RMA-SECOND'})],meta:{cursor:null}};
        const h=await mount(f);await h.render({receiveFocus:focus()});assert.ok(h.container.querySelector('[role="alert"]')?.textContent.includes(foreign?'nie odpowiada':'Więcej niż jedna'));
        assert.equal(h.container.querySelector('form'),null);assert.deepEqual(f.writes,[]);await h.close();}
    });
    await t.test('held page after actor change cannot open stale RMA; restore cannot open a fresh form',async()=>{
      const f=fixture();f.order.returns.cases=[];f.order.returns.meta.cursor=id(71);let release;f.held=new Promise(r=>{release=r;});const h=await mount(f);await h.render({receiveFocus:focus()});
      await until(()=>f.reads.some(p=>p.startsWith('/orders/'+orderId+'/returns?')),'Held true page read');await h.render({contextKey:`${tenant}:${id(90)}:operator`});
      await act(async()=>release(Response.json({cases:[returnCase()],meta:{cursor:null}})));for(let i=0;i<8;i++)await tick();assert.equal(article(h),undefined);assert.equal(h.container.querySelector('form'),null);
      await h.render({order:order(),contextKey:context,readOnly:true,receiveFocus:{...focus(),contextKey:context+':true'}});assert.equal(h.container.querySelector('form'),null);assert.ok(h.container.textContent.includes('Nie można teraz otworzyć przyjęcia'));assert.deepEqual(f.writes,[]);await h.close();
    });
    await t.test('actual unavailable WMS and partner authority refusal remain readable with no fresh intake',async()=>{
      for(const local of [true,false]){const f=fixture();f.missing=true;f.local=local;const h=await mount(f);await h.render({receiveFocus:focus()});
        if(local){await until(()=>article(h)?.querySelector('[aria-label="Pierwotne partie przyjmowanego zwrotu"]'),'Actual unavailable WMS form');assert.ok(article(h).textContent.includes('Moduł partii jest niedostępny'));assert.equal(button(h,'Zapisz przyjęcie').matches(':disabled'),true);}
        else{assert.equal(article(h).querySelector('form'),null);assert.ok(article(h).textContent.includes('Przyjęcie wymaga potwierdzenia lokalnej realizacji'));}
        assert.deepEqual(f.writes,[]);await h.close();}
    });
    await t.test('focus never acknowledges or purges a retained real ordinary-return registry attempt',async()=>{
      const f=fixture(),h=await mount(f),path='/returns/'+rma+'/receive',body=JSON.stringify({version:1,shipping_refund:0,note:'Controlled retained attempt',items:[{item_id:id(10),accepted:1,restocked:0},{item_id:id(11),accepted:1,restocked:0}]});
      f.returnLost=true;
      await act(async()=>{
        const refused=assert.rejects(shared.performDropshipReturnWrite(context,false,scope+':ordinary-return:'+orderId+':'+path,{action:'zapis sprawy zwrotu',path,method:'POST',body}),/Controlled retained return ACK loss/);
        await h.flush();await refused;
      });
      await h.render({receiveFocus:focus()});
      assert.ok(h.container.textContent.includes('Nie można teraz otworzyć przyjęcia'));
      assert.equal(h.container.querySelector('form'),null);assert.equal(f.writes.length,1);assert.equal(f.writes[0].raw,body);assert.equal(h.changed,0);
      const retry=button(h,'Ponów dokładną próbę sprawy');
      assert.ok(retry,'Actual parent ordinary-return exact retry remains visible');assert.equal(retry.matches(':disabled'),false);
      await h.close();await act(async()=>shared.resetDropshipReturnContext('',false));
    });
  }finally{for(const h of mounts)if(h.container.isConnected)await h.close();flushControlled=null;if(vite)await vite.close();globalThis.fetch=oldFetch;for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
