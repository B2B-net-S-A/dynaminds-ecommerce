/** AUTO-07 panel „Zdarzenia własne” (web/custom-events.tsx) with controlled HTTP: list, create, raise for an order
 * with one idempotency key per attempt (a retry after a lost answer reuses it), history with rule runs, read-only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000251`;
const def=(n,extra={})=>({id:id(n),key:'vip_'+n,name:'Zdarzenie '+n,description:'',active:true,version:'1',...extra});

test('Custom events panel',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client'),{CustomEventsPanel}=await vite.ssrLoadModule(path.resolve('web/custom-events.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn,label='expected UI'){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),label);}
 let s;
 function setup(defs=[def(1)]){
  s={calls:[],defs,fail:0};
  globalThis.fetch=async(url,init={})=>{
   const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname.slice(4)+u.search,method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;s.calls.push({route,method,body});
   if(route==='/custom-events'&&method==='GET')return Response.json({available:true,data:s.defs});
   if(route==='/custom-events'&&method==='POST'){const d=def(s.defs.length+1,{key:body.key,name:body.name});s.defs=[...s.defs,d];return Response.json(d);}
   if(route==='/orders?limit=50')return Response.json({data:[{id:id(90),number:'ZAM-90'}]});
   if(route.startsWith('/custom-events/vip_1/raise')){if(s.fail-->0)throw new TypeError('Failed to fetch');return Response.json({replayed:false,call:{id:id(70),source:'ui'}});}
   if(route==='/custom-events/'+id(1)+'/calls')return Response.json({data:[{id:id(70),source:'ui',order_number:'ZAM-90',created_at:'2026-10-27T12:00:00Z',runs:[{rule_id:id(80),rule_name:'Reguła VIP',state:'done'}]}],meta:{cursor:null}});
   throw new Error('unexpected '+method+' '+route);
  };
 }
 async function mount(props={}){api.setWorkspace(id(1));const el=document.createElement('div');document.body.append(el);const root=createRoot(el);await React.act(async()=>root.render(React.createElement(CustomEventsPanel,{admin:true,readOnly:false,refresh:0,notify(){},...props})));
  const h={el,button:(label)=>[...el.querySelectorAll('button')].find(b=>b.textContent.trim()===label),async click(label){const b=h.button(label);assert(b,'button '+label);assert(!b.disabled,'enabled '+label);await React.act(async()=>b.click());},
   async type(label,value){const i=el.querySelector(`[aria-label="${label}"]`);assert(i,'field '+label);await React.act(async()=>{const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i),'value').set;set.call(i,value);i.dispatchEvent(new dom.window.Event(i.tagName==='SELECT'?'change':'input',{bubbles:true}));});},
   async close(){await React.act(async()=>root.unmount());el.remove();}};
  await until(()=>el.textContent.includes('Zdarzenie 1'),'list');return h;}
 try{
  await t.test('lists definitions and creates one with key and name',async()=>{
   setup();const h=await mount();
   await h.click('Nowe zdarzenie');await h.type('Klucz zdarzenia','vip_new');await h.type('Nazwa zdarzenia','Nowe VIP');await h.click('Zapisz zdarzenie');
   await until(()=>h.el.textContent.includes('Nowe VIP'));
   assert.deepEqual(s.calls.find(c=>c.method==='POST').body,{key:'vip_new',name:'Nowe VIP',description:'',active:true});
   assert(h.el.textContent.includes('custom.vip_1'),'the rule trigger is shown');await h.close();
  });
  await t.test('raise keeps one key across a retry after a lost answer',async()=>{
   setup();s.fail=1;const h=await mount();
   await h.click('Wywołaj');await until(()=>h.el.querySelector('[aria-label="Zamówienie zdarzenia"] option[value="'+id(90)+'"]'));await h.type('Zamówienie zdarzenia',id(90));
   await h.click('Wywołaj dla zamówienia');await until(()=>h.el.textContent.includes('Nie wiadomo, czy zdarzenie zostało wywołane'));
   await h.click('Ponów z tym samym kluczem');await until(()=>h.el.textContent.includes('Zdarzenie wywołane'));
   const raises=s.calls.filter(c=>c.route.endsWith('/raise'));assert.equal(raises.length,2);assert.equal(raises[0].body.client_key,raises[1].body.client_key);assert.equal(raises[0].body.order_id,id(90));
   await h.close();
  });
  await t.test('history shows the call and the rule runs it started',async()=>{
   setup();const h=await mount();await h.click('Historia');await until(()=>h.el.textContent.includes('ZAM-90'));
   assert(h.el.textContent.includes('Reguła VIP'));assert(h.el.textContent.includes('Wykonano'));await h.close();
  });
  await t.test('read-only and non-admin views have no write buttons',async()=>{
   setup();const h=await mount({readOnly:true});assert.equal(h.button('Nowe zdarzenie'),undefined);assert.equal(h.button('Wywołaj'),undefined);assert(h.button('Historia'));await h.close();
   const v=await mount({admin:false});assert.equal(v.button('Nowe zdarzenie'),undefined);assert(v.button('Wywołaj'),'an operator may raise');await v.close();
  });
 }finally{
  globalThis.fetch=oldFetch;await vite.close();
  for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
 }
});
