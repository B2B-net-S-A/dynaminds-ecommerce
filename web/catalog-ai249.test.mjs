/** S8 (migration 249, prepared as 255) UI with controlled HTTP: DOM-AI-001 style selects travel in the draft request (catalog only);
 * DOM-AI-003 batch panel (create from the list selection, per-item result, approval gated by consent, cancel);
 * DOM-AI-002 PIM parameter proposals (current vs proposed per parameter, refused values with reasons, per-value
 * acceptance gated by consent, missing PIM category message). */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000255`;
const models={available:true,generation_allowed:true,read_only:false,local_only:true,notice:null,models:[{name:'qa-local:small',digest:'a'.repeat(64),size:100}]};

test('Catalog AI 249 panels',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 if(!globalThis.crypto?.randomUUID)Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:()=>id(999)}});
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client');
 const {CatalogAi}=await vite.ssrLoadModule(path.resolve('web/catalog-ai.tsx')),{CatalogAiBatches}=await vite.ssrLoadModule(path.resolve('web/catalog-ai-batches.tsx')),{CatalogAiAttributes}=await vite.ssrLoadModule(path.resolve('web/catalog-ai-attributes.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn,label='expected UI'){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),label);}
 let s;
 function setup(routes){
  s={calls:[]};
  globalThis.fetch=async(url,init={})=>{
   const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname.slice(4)+u.search,method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;s.calls.push({route,method,body});
   if(route==='/ai/catalog/runtime')return Response.json(models);
   const r=routes(route,method,body);if(r!==undefined)return r instanceof Response?r:Response.json(r);
   if(method==='GET')return Response.json({available:false,data:[],translations:[],history_limit:30});
   throw new Error('unexpected '+method+' '+route);
  };
 }
 async function mount(Component,props){api.setWorkspace(id(1));const el=document.createElement('div');document.body.append(el);const root=createRoot(el);await React.act(async()=>root.render(React.createElement(Component,props)));
  const h={el,button:(label)=>[...el.querySelectorAll('button')].find(b=>b.textContent.trim()===label),async click(label){const b=h.button(label);assert(b,'button '+label);assert(!b.disabled,'enabled '+label);await React.act(async()=>b.click());},
   async check(label){const i=[...el.querySelectorAll('input[type=checkbox]')].find(x=>x.getAttribute('aria-label')===label||x.parentElement.textContent.trim()===label);assert(i,'checkbox '+label);await React.act(async()=>i.click());},
   async type(label,value){const i=el.querySelector(`[aria-label="${label}"]`);assert(i,'field '+label);await React.act(async()=>{const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i),'value').set;set.call(i,value);i.dispatchEvent(new dom.window.Event(i.tagName==='SELECT'?'change':'input',{bubbles:true}));});},
   async close(){await React.act(async()=>root.unmount());el.remove();}};
  return h;}
 const product={id:id(10),version:3,name:'Kubek',description:'Opis',attributes:{}};
 try{
  await t.test('style selects are sent with a catalog draft and hidden for a translation',async()=>{
   setup((route,method)=>{if(route==='/products/'+id(10)+'/ai'&&method==='GET')return{data:[],translations:[],history_limit:30};if(route==='/products/'+id(10)+'/ai'&&method==='POST')return{id:id(20),state:'queued',source:{style:{tone:'marketing',length:'short'}}};});
   const h=await mount(CatalogAi,{product,saved(){}});await until(()=>h.el.querySelector('[aria-label="Ton treści AI"]'),'style select');
   await h.type('Ton treści AI','marketing');await h.type('Długość opisu AI','short');await h.click('Przygotuj szkic AI');
   await until(()=>s.calls.some(c=>c.method==='POST'));assert.deepEqual(s.calls.find(c=>c.method==='POST').body.style,{tone:'marketing',length:'short'});
   await h.type('Proces AI','translation');assert.equal(h.el.querySelector('[aria-label="Ton treści AI"]'),null,'translation keeps the source style');
   await h.close();
  });
  await t.test('batch panel: creates from the selection, shows per-item results, approval needs consent, cancel',async()=>{
   let batch={id:id(30),state:'open',destination:'catalog',locale:'pl',model:'qa-local:small',style:{tone:'factual',length:'medium'},item_count:2,created_at:'2026-10-27T12:00:00Z',items:[
    {product_id:id(11),position:1,state:'drafted',product_name:'Kubek A',draft:{id:id(41),state:'ready',output:{name:'Kubek A nowy',description:'Opis A'},source_version:1}},
    {product_id:id(12),position:2,state:'conflict',product_name:'Kubek B',error:'Produkt zmieniono po utworzeniu partii; pozycję pominięto',draft:null}]};
   setup((route,method,body)=>{
    if(route==='/ai/catalog/batches'&&method==='GET')return{available:true,data:[]};
    if(route==='/ai/catalog/batches'&&method==='POST'){const{items,...row}=batch;return row;}
    if(route==='/ai/catalog/batches/'+id(30)&&method==='GET')return batch;
    if(route==='/ai/catalog/batches/'+id(30)+'/apply'){batch={...batch,items:[{...batch.items[0],outcome:'applied',draft:{...batch.items[0].draft,state:'applied'}},batch.items[1]]};return{results:[{product_id:id(11),outcome:'applied',error:null}]};}
    if(route==='/ai/catalog/batches/'+id(30)+'/cancel'){batch={...batch,state:'cancelled'};return{cancelled:true};}
   });
   let savedCount=0;
   const h=await mount(CatalogAiBatches,{selection:[{id:id(11),version:1,sku:'A'},{id:id(12),version:1,sku:'B'}],saved(){savedCount++;}});
   await until(()=>h.button('Utwórz partię AI'),'create button');
   await h.click('Utwórz partię AI');
   const post=s.calls.find(c=>c.method==='POST'&&c.route==='/ai/catalog/batches');assert.deepEqual(post.body.products,[{id:id(11),version:1},{id:id(12),version:1}]);assert.equal(post.body.model,'qa-local:small');
   await until(()=>h.el.textContent.includes('Kubek A nowy'),'batch view');
   assert(h.el.textContent.includes('Produkt zmieniono po utworzeniu partii'),'item error shown');
   assert(h.button('Zatwierdź zaznaczone').disabled,'consent required');
   await h.check('Zatwierdź Kubek A');assert(h.button('Zatwierdź zaznaczone').disabled,'consent still required');
   await h.check('Sprawdziłem treści zaznaczonych pozycji');await h.click('Zatwierdź zaznaczone');
   await until(()=>s.calls.some(c=>c.route.endsWith('/apply')));assert.deepEqual(s.calls.find(c=>c.route.endsWith('/apply')).body,{approve:true,item_ids:[id(11)]});
   await until(()=>h.el.textContent.includes('Zastosowano'),'item applied');assert.equal(savedCount,1);
   await h.click('Anuluj partię');await until(()=>h.el.textContent.includes('Anulowana'));
   await h.close();
  });
  await t.test('parameter proposals: per-value acceptance through consent; refused values listed; no category message',async()=>{
   const defs=[{id:id(51),name:'Materiał',required:false,shape:{kind:'text',max_length:40}},{id:id(52),name:'Kolor',required:false,shape:{kind:'enum',options:[{id:id(61),label:'Czarny',active:true}]}},{id:id(53),name:'Pojemność',required:false,shape:{kind:'decimal',scale:2,unit:'l',minimum:'0.00',maximum:'5.00'}}];
   let proposal={id:id(50),state:'ready',model:'qa-local:small',locale:'pl',definitions:defs,pim_source:{values:[{definition_id:id(51),kind:'text',value:'plastik'}]},output:[{definition_id:id(51),kind:'text',value:'stal'},{definition_id:id(52),kind:'enum',option_id:id(61)}],refused:[{definition_id:id(53),name:'Pojemność',reason:'Wartość poza zakresem 0.00–5.00'}],created_at:'2026-10-27T12:00:00Z',expires_at:'2026-10-27T13:00:00Z'};
   let fail=false;
   setup((route,method,body)=>{
    if(route==='/products/'+id(10)+'/ai/attributes'&&method==='GET')return{available:true,pim_available:true,data:[proposal],history_limit:30};
    if(route==='/products/'+id(10)+'/ai/attributes'&&method==='POST')return fail?new Response(JSON.stringify({detail:'Przypisz produktowi kategorię PIM, aby AI zaproponowało parametry'}),{status:422,headers:{'content-type':'application/json'}}):proposal;
    if(route==='/ai/catalog/attributes/'+id(50)+'/apply'){proposal={...proposal,state:'applied',accepted:[proposal.output[1]]};return{proposal,reused:false};}
   });
   const h=await mount(CatalogAiAttributes,{product,saved(){}});
   await until(()=>h.el.textContent.includes('Materiał'),'proposal table');
   assert(h.el.textContent.includes('plastik')&&h.el.textContent.includes('stal')&&h.el.textContent.includes('Czarny'),'current and proposed values');
   assert(h.el.textContent.includes('Wartość poza zakresem 0.00–5.00'),'refused with reason');
   await h.check('Przyjmij Kolor');
   assert(h.button('Zatwierdź parametry').disabled,'consent required');
   await h.check('Sprawdziłem wartości; zapisz zaznaczone parametry');await h.click('Zatwierdź parametry');
   await until(()=>s.calls.some(c=>c.route.endsWith('/apply')));assert.deepEqual(s.calls.find(c=>c.route.endsWith('/apply')).body,{approve:true,definition_ids:[id(52)]});
   await until(()=>h.el.textContent.includes('Zastosowano'));
   fail=true;await h.click('Zaproponuj parametry');await until(()=>h.el.textContent.includes('Przypisz produktowi kategorię PIM'),'422 shown');
   await h.close();
  });
 }finally{
  globalThis.fetch=oldFetch;await vite.close();
  for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
 }
});
