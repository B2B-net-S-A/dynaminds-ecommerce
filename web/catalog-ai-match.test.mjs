/** DOM-AI-005 panel „Dopasowanie kategorii i parametrów” (web/catalog-ai-match.tsx) with controlled HTTP: proposal
 * for a chosen Allegro integration and local model, preview of candidates (AI choice marked), parameter table
 * current/proposed/accept, rejected entries with reasons, explicit consent before accept, reject, read-only copy. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000255`;
const product={id:id(1),version:3,name:'Kubek QA'};
const proposal=(extra={})=>({id:id(50),state:'ready',integration_id:id(10),model:'qa-local:small',phrase:'Kubek QA',source_version:3,created_at:'2026-10-27T12:00:00Z',expires_at:'2026-10-28T12:00:00Z',
 snapshot:{scope:'local_simulation',candidates:[{id:id(60),name:'Kubek stalowy',category_id:'123'},{id:id(61),name:'Termos',category_id:'124'}]},
 proposal:{candidate:{id:id(60),name:'Kubek stalowy',category_id:'123'},category_id:'123',reason:'Kubek ze stali',
  parameters:[{id:'11323',name:'Stan',value:{valuesIds:['11323_1']},display:'Nowy',current:'Nowy'},{id:'200',name:'Kolor',value:{valuesIds:['200_1']},display:'czarny',current:'czarny'}],
  rejected:[{kind:'parameter',id:'999',name:null,reason:'Parametr nie należy do kategorii'}],missing_required:[{id:'600',name:'Marka'}]},...extra});

test('Catalog AI match panel',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client'),{CatalogAiMatch}=await vite.ssrLoadModule(path.resolve('web/catalog-ai-match.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn,label='expected UI'){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),label);}
 let s;
 function setup({rows=[],readOnly=false}={}){
  s={calls:[],rows,accepted:null};
  globalThis.fetch=async(url,init={})=>{
   const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname.slice(4)+u.search,method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;s.calls.push({route,method,body});
   if(route==='/ai/catalog/runtime')return Response.json({available:true,generation_allowed:!readOnly,read_only:readOnly,models:readOnly?[]:[{name:'qa-local:small',digest:'a'.repeat(64)}]});
   if(route==='/integrations')return Response.json({channels:[{id:id(10),provider:'allegro',name:'Allegro QA'},{id:id(11),provider:'woocommerce',name:'Sklep'}],registry:[],runs:[]});
   if(route.startsWith('/products/'+id(1)+'/ai/matches')&&method==='GET')return Response.json({available:true,data:s.rows,accepted:s.accepted});
   if(route==='/products/'+id(1)+'/ai/matches'&&method==='POST'){const r=proposal({state:'queued',proposal:null,phrase:body.phrase??'Kubek QA'});s.rows=[r,...s.rows];return Response.json(r,{status:201});}
   if(route==='/ai/catalog/matches/'+id(50)+'/accept'){const r={...s.rows[0],state:'accepted',accepted:{provider:'allegro',candidate_id:body.candidate_id,catalog_product_id:body.candidate_id,category_id:body.category_id,parameters:[{id:'11323',valuesIds:['11323_1']}]}};s.rows=[r];s.accepted=r;return Response.json({match:r,reused:false});}
   if(route==='/ai/catalog/matches/'+id(50)+'/reject'){const r={...s.rows[0],state:'rejected'};s.rows=[r];return Response.json({match:r});}
   throw new Error('unexpected '+method+' '+route);
  };
 }
 let savedCalls=0;
 async function mount(){api.setWorkspace(id(2));const el=document.createElement('div');document.body.append(el);const root=createRoot(el);await React.act(async()=>root.render(React.createElement(CatalogAiMatch,{product,saved(){savedCalls++;}})));
  const h={el,button:(label)=>[...el.querySelectorAll('button')].find(b=>b.textContent.trim()===label),field:(label)=>el.querySelector(`[aria-label="${label}"]`),
   async click(label){const b=h.button(label);assert(b,'button '+label);assert(!b.disabled,'enabled '+label);await React.act(async()=>b.click());},
   async check(label){const i=h.field(label);assert(i,'field '+label);await React.act(async()=>i.click());},
   async type(label,value){const i=h.field(label);assert(i,'field '+label);await React.act(async()=>{const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i),'value').set;set.call(i,value);i.dispatchEvent(new dom.window.Event(i.tagName==='SELECT'?'change':'input',{bubbles:true}));});},
   async close(){await React.act(async()=>root.unmount());el.remove();}};
  await until(()=>el.textContent.includes('Dopasowanie kategorii i parametrów'),'panel');return h;}
 try{
  await t.test('proposes for the chosen Allegro integration, model and phrase',async()=>{
   setup();const h=await mount();
   await until(()=>h.field('Integracja dopasowania')?.querySelector('option[value="'+id(10)+'"]'),'allegro channel');
   assert.equal(h.field('Integracja dopasowania').querySelector('option[value="'+id(11)+'"]'),null,'only channels with a category source');
   await h.type('Fraza katalogu','kubek stalowy');
   await h.click('Zaproponuj kategorię i parametry');
   await until(()=>h.el.textContent.includes('W kolejce'),'queued');
   const post=s.calls.find(c=>c.method==='POST');
   assert.equal(post.route,'/products/'+id(1)+'/ai/matches');
   assert.match(post.body.client_key,/^[0-9a-f-]{36}$/);
   assert.deepEqual({...post.body,client_key:undefined},{version:3,model:'qa-local:small',integration_id:id(10),phrase:'kubek stalowy',client_key:undefined});
   await h.close();
  });
  await t.test('preview: candidates, parameter table, rejected reasons; consent required; accept body',async()=>{
   setup({rows:[proposal()]});savedCalls=0;const h=await mount();
   await until(()=>h.el.textContent.includes('Kubek stalowy'),'candidates');
   assert(h.el.textContent.includes('wybór AI'));assert(h.el.textContent.includes('Termos'));
   assert(h.el.textContent.includes('Parametr nie należy do kategorii'),'rejected reason');
   assert(h.el.textContent.includes('Marka'),'missing required parameter');
   const rows=[...h.el.querySelectorAll('tbody tr')].map(r=>r.textContent);assert(rows.some(r=>r.includes('Stan')&&r.includes('Nowy')));
   assert(h.button('Zatwierdź dopasowanie').disabled,'consent first');
   await h.check('Akceptuj Kolor');
   await h.check('Zgoda na dopasowanie');
   await h.click('Zatwierdź dopasowanie');
   await until(()=>h.el.textContent.includes('Zatwierdzone dopasowanie'),'accepted');
   const acc=s.calls.find(c=>c.route.endsWith('/accept'));
   assert.deepEqual(acc.body,{approve:true,version:3,candidate_id:id(60),category_id:'123',parameters:['11323']});
   assert.equal(savedCalls,1);
   await h.close();
  });
  await t.test('another candidate category drops the proposed parameters; reject',async()=>{
   setup({rows:[proposal()]});const h=await mount();
   await until(()=>h.field('Kandydat Termos'),'candidate radio');
   await h.check('Kandydat Termos');
   assert(h.field('Akceptuj Stan').disabled,'parameters belong to the AI category');
   await h.check('Kandydat Kubek stalowy');
   assert(!h.field('Akceptuj Stan').disabled);
   await h.click('Odrzuć');
   await until(()=>h.el.textContent.includes('Odrzucono'),'rejected');
   assert(s.calls.some(c=>c.route.endsWith('/reject')&&c.method==='POST'));
   await h.close();
  });
  await t.test('read-only copy has no write buttons',async()=>{
   setup({rows:[proposal()],readOnly:true});const h=await mount();
   await until(()=>h.el.textContent.includes('Kubek stalowy'));
   assert.equal(h.button('Zaproponuj kategorię i parametry')?.disabled??true,true);
   assert.equal(h.button('Zatwierdź dopasowanie'),undefined);assert.equal(h.button('Odrzuć'),undefined);
   await h.close();
  });
 }finally{
  globalThis.fetch=oldFetch;await vite.close();
  for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
 }
});
