/** Actual React 222 split panel + shared web api client against controlled fetch
 * DTOs (jsdom). No real server, database or browser acceptance is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

const id=n=>`${String(n).padStart(8,'0')}-2220-4000-8000-000000000001`;
const tenant=id(1),user=id(2),parent=id(3),child=id(4),lineA=id(5),lineB=id(6),previewId=id(7),executionId=id(8);
const hash='a'.repeat(64);
const order={id:parent,version:'5',status:'new',currency:'PLN',shipping_cost:1500,total:6500,
 items:[{id:lineA,name:'Kubek',sku:'KUB-1',quantity:3,price:1000,line_total:3000},{id:lineB,name:'Talerz',sku:'TAL-1',quantity:2,price:1000,line_total:2000}]};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const flags=(role='operator')=>({available:true,current_role:role,can_split:role!=='viewer',read_only:false});
const previewDto={id:previewId,parent_order_id:parent,client_key:id(70),scope_hash:hash,parent_total_before:6500,parent_total_after:3833,child_total:2667,
 child_shipping_cost:667,parent_shipping_cost_after:833,currency:'PLN',expires_at:'2026-10-23T12:15:00.000Z',created_at:'2026-10-23T12:00:00.000Z',physical:[],
 lines:[{index:0,item_id:lineA,product_id:id(50),sku:'KUB-1',name:'Kubek',quantity_before:3,move_quantity:2,parent_quantity_after:1,line_total_before:3000,child_line_total:2000,parent_line_total_after:1000,child_price:1000,parent_price_after:1000}]};
const executionDto={id:executionId,preview_id:previewId,parent_order_id:parent,child_order_id:child,child_number:'ZAM-1-S1',client_key:id(71),scope_hash:hash,
 parent_total_before:6500,parent_total_after:3833,child_total:2667,child_shipping_cost:667,currency:'PLN',targets:[{index:0}],created_at:'2026-10-23T12:01:00.000Z'};

const dom=new JSDOM('<body/>',{url:'http://127.0.0.1/'}),prior=new Map(),originalFetch=globalThis.fetch;
for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,
 Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){
 prior.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});
}
const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const P=await vite.ssrLoadModule(path.resolve('web/order-split222-panel.tsx'));
const A=await vite.ssrLoadModule(path.resolve('web/api.ts'));
const {createRoot}=await import('react-dom/client');
test.after(async()=>{await vite.close();dom.window.close();globalThis.fetch=originalFetch;for(const[k,d]of prior)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];});

/** Controlled server: each route answers from a queue of responders (default: success). */
function server(patch={}){
 const f={calls:[],children:[],role:'operator',lineage:null,preview:[],execute:[],previewRead:null,...patch};
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url,'http://127.0.0.1'),method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;
  f.calls.push({method,path:u.pathname,body});assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);
  const reply=r=>typeof r==='function'?r():r;
  if(method==='GET'&&u.pathname===`/api/orders/${parent}/splits`)return reply(f.lineage??(()=>Response.json({...flags(f.role),order_id:parent,children:f.children,origin:null,read_only:false})));
  if(method==='POST'&&u.pathname===`/api/orders/${parent}/splits/previews`)return reply(f.preview.shift()??(()=>Response.json({...flags(),preview:previewDto,reused:false,read_only:false},{status:201})));
  if(method==='POST'&&u.pathname===`/api/order-splits/${previewId}/execute`)return reply(f.execute.shift()??(()=>{f.children=[executionDto];return Response.json({...flags(),execution:executionDto,reused:false,read_only:false},{status:201});}));
  if(method==='GET'&&u.pathname===`/api/order-splits/previews/${previewId}`)return Response.json({...flags(),preview:previewDto,execution_id:f.previewRead,read_only:false});
  if(method==='GET'&&u.pathname===`/api/order-splits/executions/${executionId}`)return Response.json({...flags(),execution:executionDto,read_only:false});
  throw Error('Unexpected request '+method+' '+u.pathname);
 };
 return f;
}
const refusal=(status,detail)=>()=>Response.json({detail},{status});
async function mount(patch={}){
 A.setWorkspace(tenant);sessionStorage.clear();
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el),opened=[],changed=[];
 const props={order,contextKey:tenant+':'+user+':operator',writeBlocked:false,onOpenOrder:v=>opened.push(v),onChanged:()=>changed.push(1),...patch};
 await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(P.OrderSplit222Panel,props))));
 const buttons=()=>[...el.querySelectorAll('button')];
 const button=label=>buttons().find(b=>b.textContent===label);
 return{el,opened,changed,button,buttons,
  async click(label){const b=button(label);assert(b,label+' in '+el.textContent);assert(!b.disabled,label+' disabled');await act(async()=>{b.click();await new Promise(r=>setTimeout(r,0));});},
  async type(label,value){const input=el.querySelector(`input[aria-label="${label}"]`)??[...el.querySelectorAll('label')].find(l=>l.textContent.includes(label))?.querySelector('input');assert(input,label);
   await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});},
  async check(){const c=el.querySelector('input[type="checkbox"]');assert(c);await act(async()=>c.click());},
  async close(){await act(async()=>root.unmount());el.remove();}};
}
const posts=(f,kind)=>f.calls.filter(c=>c.method==='POST'&&c.path.includes(kind));
const storageKey=()=>P.split222StorageKey(tenant+':'+user+':operator',parent);

test('selection validation: exact payload, line bounds, kept line, shipping grosze',()=>{
 const v=P.validateSplit222Selection;
 assert.deepEqual(v(order,{[lineA]:'2'},'6,67'),{items:[{item_id:lineA,quantity:2}],shipping_cost_to_child:667});
 assert.deepEqual(v(order,{[lineA]:'3',[lineB]:'1'},''),{items:[{item_id:lineA,quantity:3},{item_id:lineB,quantity:1}],shipping_cost_to_child:0});
 assert.match(v(order,{},'').error,/co najmniej jedną pozycję i ilość/);
 assert.match(v(order,{[lineA]:'0'},'').error,/co najmniej jedną pozycję i ilość/);
 assert.match(v(order,{[lineA]:'4'},'').error,/„Kubek” musi być liczbą całkowitą od 0 do 3/);
 for(const bad of ['1.5','-1','x','1e2'])assert.match(v(order,{[lineB]:bad},'').error,/„Talerz”/);
 assert.match(v(order,{[lineA]:'3',[lineB]:'2'},'').error,/musi zachować co najmniej jedną pozycję/);
 assert.match(v(order,{[lineA]:'1'},'15,01').error,/nie może przekroczyć kosztu dostawy/);
 assert.equal(v(order,{[lineA]:'1'},'15').shipping_cost_to_child,1500);
 for(const bad of ['1,234','abc','-1'])assert.match(v(order,{[lineA]:'1'},bad).error,/w złotych/);
 assert.equal(P.parseGrosze('0,5'),50);assert.equal(P.parseGrosze('12.05'),1205);assert.equal(P.parseGrosze(''),0);assert.equal(P.parseGrosze('1,999'),null);
});
test('refusal messages are Polish and classify definitive vs unknown outcomes',()=>{
 const E=(s,m)=>new A.ApiError(m,s);
 assert.match(P.split222ErrorMessage(E(403,'x')),/wymaga roli administratora lub operatora/);
 assert.match(P.split222ErrorMessage(E(423,'x')),/tylko do odczytu/);
 assert.match(P.split222ErrorMessage(E(503,'x')),/niedostępny w tej kopii/);
 assert.equal(P.split222ErrorMessage(E(409,'Podział zamówień nie jest dostępny przy włączonych partiach WMS')),'Podziału odmówiono: Podział zamówień nie jest dostępny przy włączonych partiach WMS. Nic nie zostało zmienione.');
 assert.equal(P.split222ErrorMessage(E(422,'Ilość do przeniesienia przekracza ilość pozycji')),'Ilość do przeniesienia przekracza ilość pozycji');
 for(const s of [400,401,403,404,409,422,423,503])assert.equal(P.isUncertainSplit222Error(E(s,'x')),false);
 for(const e of [E(500,'x'),E(502,'x'),new TypeError('fetch failed')])assert.equal(P.isUncertainSplit222Error(e),true);
});
test('preview → confirm → execute sends exact payloads and links the child order',async()=>{
 const f=server();const h=await mount();
 try{
  assert.match(h.el.textContent,/Przenieś do nowego/);
  await h.click('Przygotuj podgląd');assert.match(h.el.textContent,/Wybierz co najmniej jedną pozycję/);assert.equal(posts(f,'previews').length,0);
  await h.type('Ilość do przeniesienia: Kubek','2');await h.type('Koszt dostawy przenoszony','6,67');await h.click('Przygotuj podgląd');
  const [p]=posts(f,'previews');assert.match(p.body.client_key,UUID);assert.deepEqual({...p.body,client_key:'k'},{client_key:'k',items:[{item_id:lineA,quantity:2}],shipping_cost_to_child:667});
  const card=h.el.querySelector('[aria-label="Podgląd podziału"]');assert(card);
  for(const amount of ['65,00','38,33','8,33','26,67','6,67'])assert(card.textContent.replace(/\s/g,' ').includes(amount),amount+' in '+card.textContent);
  assert.equal(h.button('Podziel zamówienie').disabled,true);await h.check();await h.click('Podziel zamówienie');
  const [x]=posts(f,'execute');assert.deepEqual(Object.keys(x.body).sort(),['client_key','scope_hash']);assert.equal(x.body.scope_hash,hash);assert.match(x.body.client_key,UUID);assert.notEqual(x.body.client_key,p.body.client_key);
  assert.match(h.el.querySelector('[role="status"]').textContent,/Utworzono nowe zamówienie ZAM-1-S1/);assert.equal(h.changed.length,1);
  await h.click('Otwórz zamówienie ZAM-1-S1');assert.deepEqual(h.opened,[child]);
  assert(h.el.querySelector('[aria-label="Wykonane podziały"]'),'history reloaded');assert.equal(sessionStorage.getItem(storageKey()),null);
 }finally{await h.close();}
});
test('lost preview and execute responses retry with the same client_key; check reads the original result',async()=>{
 const f=server({preview:[()=>{throw new TypeError('fetch failed');}],execute:[refusal(502,'Bad gateway'),()=>{throw new TypeError('fetch failed');}]});
 const h=await mount();
 try{
  await h.type('Ilość do przeniesienia: Kubek','2');await h.click('Przygotuj podgląd');
  assert.match(h.el.textContent,/Brak potwierdzenia podglądu/);assert.equal(JSON.parse(sessionStorage.getItem(storageKey())).kind,'preview');
  await h.click('Ponów podgląd');const [p1,p2]=posts(f,'previews');assert.equal(p2.body.client_key,p1.body.client_key);assert.deepEqual(p2.body,p1.body);
  await h.check();await h.click('Podziel zamówienie');assert.match(h.el.textContent,/Brak potwierdzenia podziału/);
  const stored=JSON.parse(sessionStorage.getItem(storageKey()));assert.equal(stored.kind,'execute');
  assert.equal(h.el.querySelector('input[type="number"]'),null,'form locked while an execute attempt is unconfirmed');
  await h.click('Ponów podział');const [e1,e2]=posts(f,'execute');assert.deepEqual(e2.body,e1.body);assert.equal(stored.body.client_key,e1.body.client_key);
  f.previewRead=null;await h.click('Sprawdź wynik');assert.match(h.el.textContent,/nie został jeszcze wykonany/);
  f.previewRead=executionId;await h.click('Sprawdź wynik');assert.equal(posts(f,'execute').length,2,'check never re-posts');
  assert.match(h.el.textContent,/Utworzono nowe zamówienie ZAM-1-S1/);assert.equal(sessionStorage.getItem(storageKey()),null);
  await h.click('Podziel ponownie');await h.type('Ilość do przeniesienia: Talerz','1');await h.click('Przygotuj podgląd');
  assert.notEqual(posts(f,'previews')[2].body.client_key,p1.body.client_key,'new attempt, new key');
 }finally{await h.close();}
});
test('unconfirmed execute survives a remount from sessionStorage with the same key',async()=>{
 const f=server({execute:[()=>{throw new TypeError('fetch failed');}]});let h=await mount();
 await h.type('Ilość do przeniesienia: Kubek','2');await h.click('Przygotuj podgląd');await h.check();await h.click('Podziel zamówienie');await h.close();
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 assert.equal(P.hasPendingSplit222(tenant+':'+user+':operator',parent),true);
 await act(async()=>root.render(React.createElement(P.OrderSplit222Panel,{order,contextKey:tenant+':'+user+':operator',writeBlocked:false,onOpenOrder(){},onChanged(){}})));
 const b=[...el.querySelectorAll('button')].find(x=>x.textContent==='Ponów podział');assert(b);await act(async()=>{b.click();await new Promise(r=>setTimeout(r,0));});
 const [e1,e2]=posts(f,'execute');assert.deepEqual(e2.body,e1.body);assert.match(el.textContent,/Utworzono nowe zamówienie/);
 await act(async()=>root.unmount());el.remove();
});
test('409 refusals show the Polish server reason, clear the attempt; 403/423/503 are mapped',async()=>{
 const reasons=['Podział zamówień nie jest dostępny przy włączonych partiach WMS','Nie można podzielić zamówienia, które ma płatności',
  'Nie można podzielić zamówienia, które ma dokumenty','Nie można podzielić zamówienia, które ma plan paczek lub przesyłki',
  'Nie można podzielić zamówienia, które ma skany, kompletację lub ruchy magazynowe','Nie można podzielić zamówienia, które ma historię łączenia',
  'Nie można podzielić zamówienia, które ma zwroty lub reklamacje'];
 const f=server({preview:[...reasons.map(r=>refusal(409,r)),refusal(403,'Podział zamówienia wymaga roli administratora lub operatora'),refusal(423,'Ta kopia jest tylko do odczytu'),refusal(503,'Podział zamówień jest niedostępny w tej kopii')]});
 const h=await mount();
 try{
  await h.type('Ilość do przeniesienia: Kubek','1');
  for(const r of reasons){await h.click('Przygotuj podgląd');assert.equal(h.el.querySelector('[role="alert"]').textContent,'Podziału odmówiono: '+r+'. Nic nie zostało zmienione.');assert.equal(sessionStorage.getItem(storageKey()),null);}
  const keys=posts(f,'previews').map(c=>c.body.client_key);assert.equal(new Set(keys).size,keys.length,'definitive refusal → next attempt gets a fresh key');
  await h.click('Przygotuj podgląd');assert.match(h.el.textContent,/wymaga roli administratora lub operatora/);
  await h.click('Przygotuj podgląd');assert.match(h.el.textContent,/tylko do odczytu — podziału nie można wykonać/);
  await h.click('Przygotuj podgląd');assert.match(h.el.textContent,/niedostępny w tej kopii/);
 }finally{await h.close();}
 const g=server({execute:[refusal(409,'Zamówienie, pozycje lub rezerwacje zmieniły się; przygotuj nowy podgląd')]});const k=await mount();
 try{await k.type('Ilość do przeniesienia: Kubek','1');await k.click('Przygotuj podgląd');await k.check();await k.click('Podziel zamówienie');
  assert.match(k.el.textContent,/Podziału odmówiono: Zamówienie, pozycje lub rezerwacje zmieniły się/);assert.equal(k.el.querySelector('[aria-label="Podgląd podziału"]'),null);assert.equal(posts(g,'execute').length,1);
 }finally{await k.close();}
});
test('hidden when unavailable; viewer and write-blocked sessions get no split controls',async()=>{
 for(const lineage of [refusal(503,'Podział zamówień jest niedostępny w tej kopii'),()=>Response.json({available:false})]){
  server({lineage});const h=await mount();try{assert.equal(h.el.innerHTML,'');}finally{await h.close();}
 }
 const f=server({role:'viewer',children:[executionDto]});const v=await mount({contextKey:tenant+':'+user+':viewer'});
 try{assert.equal(v.el.querySelector('input'),null);assert.equal(v.button('Przygotuj podgląd'),undefined);assert.match(v.el.textContent,/administrator lub operator/);
  const past=v.buttons().find(b=>b.textContent.startsWith('ZAM-1-S1 · 26,67'));assert(past,v.el.textContent);await act(async()=>past.click());assert.deepEqual(v.opened,[child]);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 }finally{await v.close();}
 server();const w=await mount({writeBlocked:true});
 try{assert.equal(w.button('Przygotuj podgląd').disabled,true);assert(w.el.querySelector('input[type="number"]').disabled);}finally{await w.close();}
 server();const paid=await mount({order:{...order,status:'packed'}});
 try{assert.match(paid.el.textContent,/tylko dla zamówienia nowego lub opłaconego/);assert.equal(paid.button('Przygotuj podgląd').disabled,true);}finally{await paid.close();}
});
test('order detail mounts the 222 panel from order_split222_available and hides the 210 panel then',()=>{
 const main=readFileSync(new URL('../web/main.tsx',import.meta.url),'utf8');
 assert(main.includes("setOrderSplit222Capability({scope:currentActorScope,available:h.order_split222_available===true&&sameImportContext});"));
 assert(main.includes('splitAvailable={orderSplitCapability?.scope===currentActorScope&&orderSplitCapability.available===true&&!(orderSplit222Capability?.scope===currentActorScope&&orderSplit222Capability.available===true)}'));
 const card=readFileSync(new URL('../web/order-card.tsx',import.meta.url),'utf8');assert(card.includes('{split222Available && <DeferredOrderPanel'));assert(card.includes('<OrderSplit222Panel order={o} contextKey={packingContextKey}'));
 const lineage=readFileSync(new URL('../web/order-split-lineage.tsx',import.meta.url),'utf8');assert(lineage.includes("e.kind.startsWith('order.split.')"),'222 parent event order.split is not Source210 lineage');
});
