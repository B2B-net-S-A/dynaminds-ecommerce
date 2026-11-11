/** Actual React DOM + shared api/custody with controlled HTTP responses only.
 * No browser, real API, database, Native210 execution or feature activation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
import path from 'node:path';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,tenant=id(1),user=id(2),order=id(3),line=id(4),actor=tenant+':'+user;
const basis=()=>({order_id:order,version:'7',currency:'PLN',shipping_cost:7,items:[{id:line,name:'Towar A',sku:'SKU-A',quantity:3,price:123,line_total:369}]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('ordinary split panel: real DOM intent/review/recovery, controlled HTTP only',async t=>{
 const dom=new JSDOM('<body/>',{url:'http://127.0.0.1/'}),prior=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){prior.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {OrderSplitPanel}=await vite.ssrLoadModule(path.resolve('web/order-split-panel.tsx'));
 const C=await vite.ssrLoadModule(path.resolve('web/order-split-custody.ts')),A=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const {createRoot}=await import('react-dom/client');const roots=new Set(),activeLocks=new Set();let f;
 Object.defineProperty(navigator,'locks',{configurable:true,value:{async request(name,opts,fn){assert.deepEqual(opts,{mode:'exclusive',ifAvailable:true});if(activeLocks.has(name))return fn(null);activeLocks.add(name);try{return await fn({name});}finally{activeLocks.delete(name);}}}});
 function reset(source=basis()){
  assert.equal(activeLocks.size,0);localStorage.clear();A.setWorkspace(tenant);f={source,calls:[],commands:new Map(),resources:new Map(),posts:[],me:0,lost:'',quota:false,commercialHold:null,healthHold:null,meDemote:0};
  globalThis.fetch=async(url,init={})=>{
   const u=new URL(url,'http://127.0.0.1'),body=init.body?JSON.parse(init.body):null;f.calls.push({path:u.pathname,query:u.search,method:init.method,body,signal:init.signal});
   if(u.pathname==='/api/health'){if(f.healthHold)await f.healthHold.promise;return Response.json({order_splits_available:true,restore_preview:!!f.restore});}
   assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);
   if(u.pathname==='/api/auth/me'){f.me++;return Response.json({user:{tenant_id:tenant,id:user,role:f.me===f.meDemote?'viewer':'operator'},restore_preview:!!f.restore});}
   if(init.method==='POST'){
    const held=C.readSplitIntent(localStorage,actor);assert(held);assert.deepEqual(JSON.parse(held.serialized),body);const execution=u.pathname.endsWith('/executions');f.posts.push({kind:execution?'execute':'preview',body});
    let preview,head;
    if(!execution){head={id:id(40),source_order_id:order,source_version:'7',source_result_version:'7',scope_hash:'a'.repeat(64),children:body.children.map((c,i)=>({slot_id:c.slot_id,order_id:id(30+i)})),ready:!f.blocked};preview={request:body,head};}
    else{preview=f.resources.get(body.preview_id).preview;head={id:id(41),source_order_id:order,source_version:'7',source_result_version:'8',scope_hash:body.scope_hash,children:preview.head.children,preview_id:body.preview_id,state:'done'};}
    const operation=execution?'execute':'preview',r={operation,head,preview,command:{tenant_id:tenant,actor_id:user,api_key_id:null,operation,client_key:body.client_key,request:body,[execution?'execution':'preview']:head}};f.commands.set(body.client_key,r);f.resources.set(head.id,r);
    if(f.lost===operation){f.lost='';throw Error('controlled lost ACK');}return Response.json(head,{status:201});
   }
   if(u.pathname.includes('/commands/')){const key=u.pathname.split('/').at(-1),r=f.commands.get(key);if(!r)return Response.json({code:'NOT_FOUND'},{status:404});const dto=structuredClone(r.command);f.commandPatch?.(dto);return Response.json(dto);}
   const parts=u.pathname.split('/'),resource=f.resources.get(parts[4]);assert(resource,'known resource '+u.pathname);const p=resource.preview,remaining=f.source.items[0].quantity-p.request.children.reduce((n,c)=>n+c.items.reduce((s,i)=>s+i.quantity,0),0),delivery=f.source.shipping_cost-p.request.children.reduce((n,c)=>n+c.delivery_minor,0);
   if(u.pathname.endsWith('/source'))return Response.json({order_id:order,version:resource.head.source_result_version,item_count:1,shipping_cost:delivery});
   if(u.pathname.endsWith('/source-items'))return Response.json({data:[{source_item_id:line,before_quantity:f.source.items[0].quantity,remaining_quantity:remaining}],meta:{total:1,cursor:null}});
   if(u.pathname.endsWith('/children'))return Response.json({data:p.request.children.map((c,i)=>({...p.head.children[i],delivery_minor:c.delivery_minor,items:c.items})),meta:{total:p.request.children.length,cursor:null}});
   if(u.pathname.endsWith('/commercial')){if(f.commercialHold)await f.commercialHold.promise;const dto=commercial(p);f.commercialPatch?.(dto);return Response.json(dto);}
   throw Error('Unexpected request '+u.pathname);
  };
 }
 function commercial(p){
  const s=f.source.items[0],tiny=s.price===1,oldN=tiny?2:300,oldV=tiny?1:69;let used=0,serial=60;
  const row=(q,retained)=>{const start=used;used+=q;const G=BigInt(s.line_total),Q=BigInt(s.quantity),g0=G*BigInt(start)/Q,g1=G*BigInt(used)/Q,n=G===0n?0n:BigInt(oldN)*g1/G-BigInt(oldN)*g0/G;return{source_item_id:line,target_item_id:retained?line:id(serial++),product_id:id(5),name:s.name,sku:s.sku,quantity:q,price:s.price,vat:23,gross_minor:Number(g1-g0),net_minor:Number(n),vat_minor:Number(g1-g0-n),price_adjustment_minor:Number(g1-g0)-s.price*q,original_quantity:s.quantity,original_gross_minor:s.line_total,original_net_minor:oldN,original_vat_minor:oldV};};
  const result=(slot,oid,name,delivery,items)=>{const g=items.reduce((n,i)=>n+i.gross_minor,0),net=items.reduce((n,i)=>n+i.net_minor,0),v=items.reduce((n,i)=>n+i.vat_minor,0);return{kind:slot===null?'retained_source':'child',slot_id:slot,order_id:oid,name,items,items_gross_minor:g,items_net_minor:net,items_vat_minor:v,delivery_minor:delivery,total_minor:g+delivery};};
  const results=p.request.children.map((c,i)=>result(c.slot_id,p.head.children[i].order_id,c.name,c.delivery_minor,[row(c.items[0].quantity,false)]));results.push(result(null,order,null,f.source.shipping_cost-p.request.children.reduce((n,c)=>n+c.delivery_minor,0),[row(s.quantity-used,true)]));
  return{schema:'order-split-commercial-review/v1',currency:'PLN',ready:p.head.ready,shipping_tax:'not_allocated',conflicts:p.head.ready?[]:[{code:'VAT_ROUNDING_CONFLICT',source_item_id:line,slot_id:p.request.children[0].slot_id}],original:{items_gross_minor:s.line_total,items_net_minor:oldN,items_vat_minor:oldV,delivery_minor:f.source.shipping_cost,total_minor:s.line_total+f.source.shipping_cost},results};
 }
 const proto=Object.getPrototypeOf(localStorage),originalSet=proto.setItem;proto.setItem=function(k,v){if(f?.quota&&k.startsWith('dyna:order-split-panel-reference:'))throw Error('quota');return originalSet.call(this,k,v);};
 async function mount(overrides={}){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);roots.add(root);const opened=[];let props={source:f.source,contextKey:actor+':operator',readOnly:false,onOpenOrder:id=>opened.push(id),...overrides};const render=async(change={})=>{props={...props,...change};await act(async()=>root.render(React.createElement(OrderSplitPanel,props)));};await render();return{el,opened,render,async close(){await act(async()=>root.unmount());roots.delete(root);el.remove();}};}
 const button=(h,label)=>[...h.el.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);
 const click=async(h,label)=>{const b=button(h,label);assert(b,label);assert(!b.disabled,'disabled '+label);await act(async()=>{b.click();});};
 const confirm=async h=>{const box=h.el.querySelector('[aria-label="Potwierdzam przydział i kwoty podziału"]');assert(box&&!box.disabled);await act(async()=>box.click());};
 const allocate=async h=>{await click(h,'Dodaj pozycję 1 do wybranego wyniku');await click(h,'Przygotuj podgląd podziału');};
 const references=()=>Object.keys(localStorage).filter(k=>k.startsWith('dyna:order-split-panel-reference:'));
 try{
  await t.test('mount is inert; genuine DOM preview shows server G/N/VAT and requires explicit confirm before execution',async()=>{
   reset();const h=await mount();assert.equal(f.calls.length,0);assert.equal(button(h,'Przygotuj podgląd podziału').disabled,true);await allocate(h);assert.equal(f.posts.length,1);assert.match(h.el.textContent,/Podgląd podziału/);assert.match(h.el.textContent,/3,00.*0,69.*3,69/);assert.match(h.el.textContent,/VAT dostawy nie jest tu rozliczony/);assert.equal(button(h,'Wykonaj podział').disabled,true);assert.equal(C.readSplitIntent(localStorage,actor),null);
   await confirm(h);await click(h,'Wykonaj podział');assert.deepEqual(f.posts.map(p=>p.kind),['preview','execute']);const reference=JSON.parse(localStorage.getItem(references()[0]));assert.equal(reference.phase,'done');assert.equal(reference.execute_serialized,JSON.stringify(f.posts[1].body));assert.equal(C.readSplitIntent(localStorage,actor),null);assert.match(h.el.textContent,/Podział został potwierdzony/);await click(h,'Otwórz nowe zamówienie 1');assert.deepEqual(h.opened,[id(30)]);await h.close();
  });
  await t.test('known preview and terminal survive refresh via explicit original GET, never POST replay',async()=>{
   reset();let h=await mount();await allocate(h);const executionKey=JSON.parse(JSON.parse(localStorage.getItem(references()[0])).execute_serialized).client_key;await h.close();const before=f.calls.length;h=await mount();assert.equal(f.calls.length,before);await click(h,'Odczytaj zapisany podgląd');assert.equal(f.posts.length,1);await confirm(h);await click(h,'Wykonaj podział');assert.equal(f.posts[1].body.client_key,executionKey);await h.close();h=await mount();const count=f.calls.length;await click(h,'Odczytaj wynik podziału');assert.ok(f.calls.slice(count).every(c=>c.method==='GET'));assert.equal(f.posts.length,2);assert.match(h.el.textContent,/Podział został potwierdzony/);await h.close();
  });
  await t.test('lost preview ACK blocks editor across refresh and recovery is original GET-only',async()=>{
   reset();f.lost='preview';let h=await mount();await allocate(h);const held=C.readSplitIntent(localStorage,actor);assert(held);assert.match(h.el.textContent,/Wynik wcześniejszej próby/);assert.equal(button(h,'Przygotuj podgląd podziału').disabled,true);assert.equal(references().length,0);await h.close();h=await mount();const before=f.calls.length;await click(h,'Sprawdź oryginalny wynik');assert.ok(f.calls.slice(before).every(c=>c.method==='GET'));assert.equal(f.posts.length,1);assert.equal(C.readSplitIntent(localStorage,actor),null);assert.match(h.el.textContent,/Podgląd podziału/);await h.close();
  });
  await t.test('lost execute ACK preserves exact execute body/key; refresh reconciles to terminal without retry',async()=>{
   reset();let h=await mount();await allocate(h);await confirm(h);f.lost='execute';await click(h,'Wykonaj podział');const pending=C.readSplitIntent(localStorage,actor);assert.equal(pending.kind,'execute');assert.equal(pending.serialized,JSON.stringify(f.posts[1].body));await h.close();h=await mount();await click(h,'Sprawdź oryginalny wynik');assert.equal(f.posts.length,2);assert.equal(C.readSplitIntent(localStorage,actor),null);assert.match(h.el.textContent,/Podział został potwierdzony/);await h.close();
  });
  await t.test('404 and confirmed-reference storage quota cannot clear pending or unlock a new attempt',async()=>{
   reset();f.quota=true;let h=await mount();await allocate(h);assert(C.readSplitIntent(localStorage,actor));assert.equal(references().length,0);assert.equal(button(h,'Przygotuj podgląd podziału').disabled,true);f.commands.clear();await click(h,'Sprawdź oryginalny wynik');assert(C.readSplitIntent(localStorage,actor));assert.equal(f.posts.length,1);await h.close();
   reset();f.quota=true;h=await mount();await allocate(h);f.quota=false;await click(h,'Sprawdź oryginalny wynik');assert.equal(C.readSplitIntent(localStorage,actor),null);assert.equal(f.posts.length,1);assert.equal(references().length,1);await h.close();
  });
  await t.test('late role loss after reference persistence keeps actual pending authoritative',async()=>{
   reset();f.meDemote=2;const h=await mount();await allocate(h);assert(C.readSplitIntent(localStorage,actor));assert.equal(references().length,1);assert.match(h.el.textContent,/Wynik wcześniejszej próby/);assert.equal(button(h,'Wykonaj podział'),undefined);assert.equal(f.posts.length,1);await h.close();
  });
  await t.test('principal/source changes abort pending reads and remove old financial results immediately',async()=>{
   reset();f.commercialHold=deferred();const h=await mount();await click(h,'Dodaj pozycję 1 do wybranego wyniku');const b=button(h,'Przygotuj podgląd podziału');await act(async()=>{b.click();await new Promise(resolve=>setTimeout(resolve,0));});assert.equal(f.posts.length,1);const old=f.calls.find(c=>c.path.endsWith('/commercial')).signal;await h.render({contextKey:tenant+':'+id(99)+':operator'});assert.equal(old.aborted,true);assert.equal(h.el.querySelector('[aria-label="Kwoty podziału"]'),null);await act(async()=>f.commercialHold.resolve());assert.equal(h.el.querySelector('[aria-label="Kwoty podziału"]'),null);assert.equal(f.posts.length,1);await h.close();
   reset();f.healthHold=deferred();const k=await mount();await click(k,'Dodaj pozycję 1 do wybranego wyniku');await act(async()=>{button(k,'Przygotuj podgląd podziału').click();await new Promise(resolve=>setTimeout(resolve,0));});const signal=f.calls[0].signal;await k.render({source:{...f.source,version:'8'}});assert.equal(signal.aborted,true);await act(async()=>f.healthHold.resolve());assert.equal(f.posts.length,0);await k.close();
  });
  await t.test('readonly permits confirmed historical preview reads, blocks execute and never releases unresolved custody',async()=>{
   reset();let h=await mount();await allocate(h);await h.render({readOnly:true});assert.equal(h.el.querySelector('[aria-label="Kwoty podziału"]'),null);await click(h,'Odczytaj zapisany podgląd');assert.equal(button(h,'Wykonaj podział').disabled,true);assert.equal(h.el.querySelector('[aria-label="Potwierdzam przydział i kwoty podziału"]').disabled,true);assert.equal(f.posts.length,1);await h.close();
   reset();f.lost='preview';h=await mount();await allocate(h);await h.render({readOnly:true});assert.equal(button(h,'Sprawdź oryginalny wynik').disabled,true);assert(C.readSplitIntent(localStorage,actor));assert.equal(f.posts.length,1);await h.close();
  });
  await t.test('actual no-ready commercial conflict is readable and cannot be confirmed/executed',async()=>{
   const s=basis();s.items[0].price=1;s.items[0].line_total=3;reset(s);f.blocked=true;const h=await mount();await allocate(h);assert.match(h.el.textContent,/Różnica zaokrąglenia VAT/);assert.equal(button(h,'Wykonaj podział').disabled,true);assert.equal(f.posts.length,1);await h.close();
  });
  await t.test('same-turn double clicks cannot dispatch a second preview or execution',async()=>{
   reset();const h=await mount();await click(h,'Dodaj pozycję 1 do wybranego wyniku');await act(async()=>{const b=button(h,'Przygotuj podgląd podziału');b.click();b.click();});assert.equal(f.posts.length,1);await confirm(h);await act(async()=>{const b=button(h,'Wykonaj podział');b.click();b.click();});assert.equal(f.posts.length,2);await h.close();
  });
  await t.test('refresh accepts reordered JSON object members in original preview and completed head without replay',async()=>{
   reset();let h=await mount();await allocate(h);const originalKey=JSON.parse(JSON.parse(localStorage.getItem(references()[0])).execute_serialized).client_key;await h.close();
   f.commandPatch=dto=>{const key=dto.operation==='preview'?'preview':'execution',head=dto[key];dto[key]=Object.fromEntries(Object.entries(head).reverse());dto[key].children=head.children.map(child=>Object.fromEntries(Object.entries(child).reverse()));};
   h=await mount();const before=f.calls.length;await click(h,'Odczytaj zapisany podgląd');assert.ok(f.calls.slice(before).every(c=>c.method==='GET'));assert(h.el.querySelector('[aria-label="Kwoty podziału"]'));assert.equal(button(h,'Wykonaj podział').disabled,true);assert.equal(f.posts.length,1);
   await confirm(h);await click(h,'Wykonaj podział');assert.equal(f.posts[1].body.client_key,originalKey);assert.equal(f.posts.length,2);assert.equal(C.readSplitIntent(localStorage,actor),null);await h.close();
   // The verified done reference was saved in the reversed wire member order.
   // Returning to the ordinary member order is the same immutable command.
   f.commandPatch=null;h=await mount();const doneBefore=f.calls.length;await click(h,'Odczytaj wynik podziału');assert.ok(f.calls.slice(doneBefore).every(c=>c.method==='GET'));assert.match(h.el.textContent,/Podział został potwierdzony/);await click(h,'Otwórz nowe zamówienie 1');assert.deepEqual(h.opened,[id(30)]);assert.equal(f.posts.length,2);await h.close();
  });
  await t.test('reordered-object recovery still refuses changed command ID, scope and source identity',async()=>{
   for(const phase of ['preview','done'])for(const field of ['id','scope_hash','source_order_id']){
    reset();let h=await mount();await allocate(h);if(phase==='done'){await confirm(h);await click(h,'Wykonaj podział');}const original=localStorage.getItem(references()[0]),writes=f.posts.length;await h.close();
    f.commandPatch=dto=>{const key=dto.operation==='preview'?'preview':'execution';dto[key]=Object.fromEntries(Object.entries(dto[key]).reverse());dto[key][field]=field==='scope_hash'?'b'.repeat(64):id(99);};
    h=await mount();const before=f.calls.length;await click(h,phase==='done'?'Odczytaj wynik podziału':'Odczytaj zapisany podgląd');assert.ok(f.calls.slice(before).every(c=>c.method==='GET'));assert(h.el.querySelector('[role="alert"]'));assert.equal(h.el.querySelector('[aria-label="Kwoty podziału"]'),null);assert.doesNotMatch(h.el.textContent,/Podział został potwierdzony/);assert.equal(localStorage.getItem(references()[0]),original);assert.equal(C.readSplitIntent(localStorage,actor),null);assert.equal(f.posts.length,writes);await h.close();
   }
  });
  await t.test('malformed commercial/private fields never render and actual restore authority disables execution independently of props',async()=>{
   reset();f.commercialPatch=v=>v.results[0].items[0].portal_token='PRIVATE_NOT_RENDERED';let h=await mount();await allocate(h);assert.equal(h.el.textContent.includes('PRIVATE_NOT_RENDERED'),false);assert.equal(h.el.querySelector('[aria-label="Kwoty podziału"]'),null);assert.equal(button(h,'Wykonaj podział'),undefined);assert.equal(f.posts.length,1);await h.close();
   reset();h=await mount();await allocate(h);await h.close();f.restore=true;h=await mount();await click(h,'Odczytaj zapisany podgląd');assert.equal(button(h,'Wykonaj podział').disabled,true);assert.equal(h.el.querySelector('[aria-label="Potwierdzam przydział i kwoty podziału"]').disabled,true);assert.equal(f.posts.length,1);await h.close();
  });
 }finally{for(const r of roots)await act(async()=>r.unmount());proto.setItem=originalSet;await vite.close();globalThis.fetch=oldFetch;for(const[k,d]of prior){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
