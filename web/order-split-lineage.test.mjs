/** Actual React component/shared HTTP client, controlled GET DTOs only.
 * No installed210, real HTTP/PG/browser or business acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
import path from 'node:path';

const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant=id(1),user=id(2),source=id(3),child=id(4),sibling=id(5),execution=id(6),slot=id(7),slot2=id(8);
const event=(kind='child')=>({id:id(10),tenant_id:tenant,order_id:kind==='source'?source:child,kind:'order.split.'+kind,
  created_at:'2026-10-18T12:00:00.000Z',detail:{execution_id:execution,source_order_id:source,slot_id:kind==='source'?null:slot}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};

test('durable split lineage: actual component and order-scoped GET protocol, no writes/custody',async t=>{
  const dom=new JSDOM('<body/>',{url:'http://127.0.0.1/'}),prior=new Map(),originalFetch=globalThis.fetch;
  for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true,
    localStorage:{getItem(){throw Error('Lineage cannot depend on browser custody');},setItem(){throw Error('No custody writes');},removeItem(){throw Error('No custody writes');}}})){
    prior.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});
  }
  const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),roots=new Set();
  try{
    const {OrderSplitLineage}=await vite.ssrLoadModule(path.resolve('web/order-split-lineage.tsx'));
    const A=await vite.ssrLoadModule(path.resolve('web/api.ts'));const {createRoot}=await import('react-dom/client');let f;
    function reset(patch={}){
      A.setWorkspace(tenant);f={calls:[],fault:'',hold:null,authReads:0,actor:user,role:'operator',...patch};
      globalThis.fetch=async(url,init={})=>{
        const u=new URL(url,'http://127.0.0.1');f.calls.push({path:u.pathname,query:u.search,signal:init.signal});assert.equal(init.method,'GET');assert.equal(init.body,undefined);
        if(u.pathname==='/api/health')return Response.json({order_splits_available:f.fault!=='inactive',restore_preview:false});
        assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);
        if(u.pathname==='/api/auth/me'){f.authReads++;return Response.json({user:{tenant_id:f.fault==='foreign-tenant'?id(99):tenant,id:f.actor,role:f.fault==='late-IAM'&&f.authReads>1?'viewer':f.role},restore_preview:false});}
        assert.match(u.pathname,/^\/api\/order-splits\/orders\/[a-f0-9-]+\/lineage$/);assert.equal(u.search,'');
        const currentOrder=u.pathname.split('/').at(-2);
        if(['denied','missing','partial-server','unavailable'].includes(f.fault))return Response.json({detail:'Controlled refusal'},{status:{denied:403,missing:404,'partial-server':409,unavailable:503}[f.fault]});
        const dto={schema:'order-split-lineage/v1',order_id:currentOrder,lineage:{execution_id:execution,source_order_id:source,children:[{slot_id:slot,order_id:child},{slot_id:slot2,order_id:sibling}]}};
        if(f.fault==='foreign-source')dto.lineage.source_order_id=id(99);
        if(f.fault==='foreign-execution')dto.lineage.execution_id=id(99);
        if(f.fault==='foreign-order')dto.order_id=id(99);
        if(f.fault==='current-child')dto.lineage.children[0].order_id=id(99);
        if(f.fault==='current-slot')dto.lineage.children[0].slot_id=id(99);
        if(f.fault==='duplicate-child')dto.lineage.children[1].order_id=child;
        if(f.fault==='duplicate-slot')dto.lineage.children[1].slot_id=slot;
        if(f.fault==='schema')dto.schema='order-split-lineage/v0';
        if(f.fault==='child-bound')dto.lineage.children=Array.from({length:100},(_,i)=>({slot_id:id(1000+i),order_id:id(2000+i)}));
        if(f.fault==='missing-field')delete dto.lineage.source_order_id;
        if(f.fault==='partial-children')dto.lineage.children=[{slot_id:slot2,order_id:sibling}];
        if(f.fault==='empty-children')dto.lineage.children=[];
        if(f.fault==='private-extra')dto.lineage.credential_hash='NOT_PUBLIC';
        if(f.fault==='invalid-uuid')dto.lineage.children[1].order_id='not-a-uuid';
        if(f.fault==='oversize')dto.lineage.padding='x'.repeat(65536);
        if(f.fault==='none')dto.lineage=null;
        if(f.fault==='single-child')dto.lineage.children=[{slot_id:slot,order_id:child}];
        if(f.fault==='reverse')dto.lineage.children.reverse();
        if(f.hold)await f.hold.promise;
        return Response.json(dto);
      };
    }
    async function mount(patch={}){
      const el=document.createElement('div');document.body.append(el);const root=createRoot(el);roots.add(root);const opened=[];
      let props={orderId:child,contextKey:tenant+':'+f.actor+':'+f.role,events:[event()],readOnly:false,onOpenOrder:v=>opened.push(v),...patch};
      async function render(change={}){props={...props,...change};await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(OrderSplitLineage,props))));}
      await render();return{el,opened,render,async close(){await act(async()=>root.unmount());roots.delete(root);el.remove();}};
    }
    const buttons=h=>[...h.el.querySelectorAll('button')];
    async function click(h,label){const b=buttons(h).find(x=>x.textContent===label);assert(b,label);assert(!b.disabled);await act(async()=>b.click());}

    await t.test('fresh reopen without browser custody resolves all persisted siblings via GET and navigates normally',async()=>{
      reset();let h=await mount();assert.equal(f.calls.length,0);await click(h,'Otwórz zamówienie źródłowe');assert.deepEqual(h.opened,[source]);
      await click(h,'Odczytaj wszystkie wyniki podziału');assert(h.el.querySelector('[aria-label="Zapisane wyniki podziału"]'),JSON.stringify(f.calls));assert.match(h.el.textContent,/Bieżące zamówienie — wynik 1/);
      await click(h,'Otwórz wynik podziału 2');assert.deepEqual(h.opened,[source,sibling]);assert.equal(f.calls.filter(x=>x.path.endsWith('/lineage')).length,1);assert(f.calls.every(x=>!x.path.includes('/executions/')&&!x.path.includes('/commands/')));
      await h.close();h=await mount();assert.equal(h.el.querySelector('[aria-label="Zapisane wyniki podziału"]'),null);await click(h,'Odczytaj wszystkie wyniki podziału');await click(h,'Otwórz wynik podziału 2');assert.deepEqual(h.opened,[sibling]);await h.close();
    });
    await t.test('source and read-only copy can read existing results without self-links or writes',async()=>{
      reset();const h=await mount({orderId:source,events:[event('source')],readOnly:true});assert.equal(buttons(h).length,1);assert.match(h.el.textContent,/zachowuje pozostałe pozycje/);
      await click(h,'Odczytaj wszystkie wyniki podziału');assert.match(h.el.textContent,/Bieżące zamówienie — pozostałe pozycje/);await click(h,'Otwórz wynik podziału 1');assert.deepEqual(h.opened,[child]);await h.close();
    });
    await t.test('two distinct ordinary operators in one tenant read the same durable graph after fresh mounts',async()=>{
      for(const actor of [user,id(91)]){
        reset({actor});const h=await mount();assert.equal(f.calls.length,0);await click(h,'Odczytaj wszystkie wyniki podziału');
        assert(h.el.querySelector('[aria-label="Zapisane wyniki podziału"]'));await click(h,'Otwórz wynik podziału 2');assert.deepEqual(h.opened,[sibling]);
        assert.equal(f.calls.filter(x=>x.path.endsWith('/lineage')).length,1);assert.equal(f.authReads,2);await h.close();
      }
    });
    await t.test('viewer follows ordinary order-read permission without pretending to own the split command',async()=>{
      reset({actor:id(92),role:'viewer'});const h=await mount();await click(h,'Odczytaj wszystkie wyniki podziału');await click(h,'Otwórz wynik podziału 2');assert.deepEqual(h.opened,[sibling]);assert(f.calls.every(x=>!x.path.includes('/executions/')&&!x.path.includes('/commands/')));await h.close();
    });
    await t.test('rendering preserves server result order and does not invent the cardinality of a persisted graph',async()=>{
      reset({fault:'reverse'});let h=await mount();await click(h,'Odczytaj wszystkie wyniki podziału');await click(h,'Otwórz wynik podziału 1');assert.deepEqual(h.opened,[sibling]);assert.match(h.el.textContent,/Bieżące zamówienie — wynik 2/);await h.close();
      reset({fault:'single-child'});h=await mount();await click(h,'Odczytaj wszystkie wyniki podziału');assert(h.el.querySelector('[aria-label="Zapisane wyniki podziału"]'));assert.match(h.el.textContent,/Bieżące zamówienie — wynik 1/);assert(!buttons(h).some(x=>x.textContent==='Otwórz wynik podziału 2'));await h.close();
    });
    for(const fault of ['denied','missing','inactive','partial-server','unavailable','foreign-tenant','foreign-source','foreign-execution','foreign-order','current-child','current-slot','duplicate-child','duplicate-slot','schema','child-bound','missing-field','partial-children','empty-children','private-extra','invalid-uuid','oversize','none','late-IAM'])await t.test('unverified '+fault+' never yields sibling links or writes',async()=>{
      reset({fault});const h=await mount();await click(h,'Odczytaj wszystkie wyniki podziału');assert.equal(h.el.querySelector('[aria-label="Zapisane wyniki podziału"]'),null);assert.match(h.el.textContent,/Lista wyników jest niedostępna/);assert.equal(buttons(h).filter(b=>b.textContent.startsWith('Otwórz wynik podziału')).length,0);await click(h,'Otwórz zamówienie źródłowe');assert.deepEqual(h.opened,[source]);await h.close();
    });
    await t.test('malformed, ambiguous, foreign and bounded events never manufacture edges or fetch',async()=>{
      for(const mutate of [e=>e.tenant_id=id(99),e=>e.order_id=id(99),e=>e.detail.source_order_id=child,e=>e.detail.slot_id=null,e=>e.detail.extra='unknown',e=>e.detail.execution_id='not-a-uuid',e=>e.created_at='invalid']){
        reset();const e=event();mutate(e);const h=await mount({events:[e]});assert.match(h.el.textContent,/Nie można potwierdzić zapisanej historii/);assert.equal(buttons(h).length,0);assert.equal(f.calls.length,0);await h.close();
      }
      for(const events of [[event(),event()],Array.from({length:10001},()=>({kind:'order.note_added'})),[{...event(),detail:{...event().detail,padding:'x'.repeat(17000)}}]]){
        reset();const h=await mount({events});assert.equal(buttons(h).length,0);assert.equal(f.calls.length,0);await h.close();
      }
      reset();const h=await mount({events:[{kind:'order.note_added'}]});assert.equal(h.el.textContent,'');assert.equal(f.calls.length,0);await h.close();
    });
    await t.test('context/order change aborts old reads and ignores late old execution response',async()=>{
      reset({hold:deferred()});const hold=f.hold,h=await mount();const b=buttons(h).find(x=>x.textContent==='Odczytaj wszystkie wyniki podziału');
      await act(async()=>{b.click();await new Promise(r=>setTimeout(r,0));});const request=f.calls.find(x=>x.path.endsWith('/lineage'));assert(request);
      await h.render({contextKey:tenant+':'+id(99)+':operator',orderId:id(88),events:[]});assert.equal(request.signal.aborted,true);await act(async()=>hold.resolve());assert.equal(h.el.textContent,'');await h.close();
    });
    for(const changed of ['role','tenant'])await t.test(changed+' change removes old lineage and ignores old session response',async()=>{
      reset({hold:deferred()});const hold=f.hold,h=await mount();const b=buttons(h).find(x=>x.textContent==='Odczytaj wszystkie wyniki podziału');
      await act(async()=>{b.click();await new Promise(r=>setTimeout(r,0));});const request=f.calls.find(x=>x.path.endsWith('/lineage'));assert(request);
      const nextTenant=changed==='tenant'?id(90):tenant;A.setWorkspace(nextTenant);
      await h.render({contextKey:nextTenant+':'+user+':'+(changed==='role'?'viewer':'operator'),events:[{...event(),tenant_id:nextTenant}]});
      assert.equal(request.signal.aborted,true);await act(async()=>hold.resolve());
      assert.equal(h.el.querySelector('[aria-label="Zapisane wyniki podziału"]'),null);assert.equal(f.authReads,1);
      assert.equal(buttons(h).filter(x=>x.textContent.startsWith('Otwórz wynik podziału')).length,0);await h.close();
    });
  }finally{
    for(const root of roots)await act(async()=>root.unmount());await vite.close();dom.window.close();globalThis.fetch=originalFetch;
    for(const[k,d]of prior)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];
  }
});
