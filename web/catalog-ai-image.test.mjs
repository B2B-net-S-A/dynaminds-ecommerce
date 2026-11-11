/** DOM-AI-004 panel „Usuń tło” (web/catalog-ai-image.tsx) with controlled HTTP: per-image request with one key,
 * side-by-side compare of original and result, apply only after „Sprawdziłem wynik”, reject, error display, history,
 * read-only and missing module. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000255`;
const P=id(1),IMG=id(2),RES=id(3),JOB=id(4);
const job=(extra={})=>({id:JOB,product_id:P,source_image_id:IMG,source_url:'/api/product-images/'+IMG,result_image_id:null,result_url:null,operation:'background_removed',state:'queued',error:null,created_at:'2026-10-27T12:00:00Z',...extra});

test('Catalog AI images panel',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client'),{CatalogAiImages}=await vite.ssrLoadModule(path.resolve('web/catalog-ai-image.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn,label='expected UI'){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),label);}
 let s;
 function setup(state={}){
  s={calls:[],jobs:[],available:true,read_only:false,applyStatus:200,...state};
  globalThis.fetch=async(url,init={})=>{
   const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname.slice(4),method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;s.calls.push({route,method,body});
   if(route==='/products/'+P+'/ai/images'&&method==='GET')return Response.json(s.available?{available:true,read_only:s.read_only,images:[{id:IMG,url:'/api/product-images/'+IMG}],data:s.jobs,history_limit:30}:{available:false,read_only:false,images:[],data:[]});
   if(route==='/products/'+P+'/ai/images'&&method==='POST'){s.jobs=[job(),...s.jobs];return Response.json({job:s.jobs[0],replayed:false},{status:201});}
   if(route==='/ai/catalog/images/'+JOB+'/apply'){if(s.applyStatus!==200)return Response.json({status:409,detail:'Produkt zmieniono; nie zmieniono zdjęć'},{status:409});s.jobs=[job({state:'applied',result_image_id:RES,result_url:'/api/product-images/'+RES})];return Response.json({job:s.jobs[0],reused:false});}
   if(route==='/ai/catalog/images/'+JOB+'/reject'){s.jobs=[job({...s.jobs[0],state:s.jobs[0].state==='queued'?'cancelled':'rejected'})];return Response.json({job:s.jobs[0]});}
   throw new Error('unexpected '+method+' '+route);
  };
 }
 async function mount(props={}){api.setWorkspace(id(9));const el=document.createElement('div');document.body.append(el);const root=createRoot(el);let savedCalls=0;await React.act(async()=>root.render(React.createElement(CatalogAiImages,{product:{id:P,version:3,images:['/api/product-images/'+IMG]},saved(){savedCalls++;},...props})));
  const h={el,saved:()=>savedCalls,button:(label)=>[...el.querySelectorAll('button')].find(b=>b.textContent.trim()===label),async click(label){const b=h.button(label);assert(b,'button '+label);assert(!b.disabled,'enabled '+label);await React.act(async()=>b.click());},
   async check(label){const i=el.querySelector(`input[aria-label="${label}"]`);assert(i,'checkbox '+label);await React.act(async()=>i.click());},
   async close(){await React.act(async()=>root.unmount());el.remove();}};
  return h;}
 try{
  await t.test('requests background removal for one image with a key, the product version and the image id',async()=>{
   setup();const h=await mount();await until(()=>h.button('Usuń tło'),'image list');
   await h.click('Usuń tło');await until(()=>h.el.textContent.includes('W kolejce'));
   const post=s.calls.find(c=>c.method==='POST');assert.equal(post.body.image_id,IMG);assert.equal(post.body.version,3);assert.match(post.body.client_key,/^[0-9a-f-]{36}$/);
   assert.equal(h.button('Usuń tło').disabled,true,'one open request per image');
   await h.click('Anuluj zlecenie');await until(()=>h.el.textContent.includes('Anulowano'));await h.close();
  });
  await t.test('ready result is compared side by side and applied only after review',async()=>{
   setup({jobs:[job({state:'ready',result_image_id:RES,result_url:'/api/product-images/'+RES})]});const h=await mount();
   await until(()=>h.el.querySelector('img[alt="Wynik bez tła"]'),'compare');
   assert.equal(h.el.querySelector('img[alt="Oryginał"]').getAttribute('src'),'/api/product-images/'+IMG);
   assert.equal(h.el.querySelector('img[alt="Wynik bez tła"]').getAttribute('src'),'/api/product-images/'+RES);
   assert.equal(h.button('Zastosuj nowe zdjęcie').disabled,true,'apply needs review');
   await h.check('Sprawdziłem wynik');await h.click('Zastosuj nowe zdjęcie');
   await until(()=>h.el.textContent.includes('Zastosowano'));
   assert.deepEqual(s.calls.find(c=>c.route.endsWith('/apply')).body,{approve:true,version:3});assert.equal(h.saved(),1);await h.close();
  });
  await t.test('reject keeps the product; a refused apply shows the server message',async()=>{
   setup({jobs:[job({state:'ready',result_image_id:RES,result_url:'/api/product-images/'+RES})],applyStatus:409});const h=await mount();
   await until(()=>h.button('Odrzuć'));await h.check('Sprawdziłem wynik');await h.click('Zastosuj nowe zdjęcie');
   await until(()=>h.el.querySelector('[role="alert"]')?.textContent.includes('Produkt zmieniono'));assert.equal(h.saved(),0);
   await h.click('Odrzuć');await until(()=>h.el.textContent.includes('Odrzucono'));
   assert.equal(h.button('Zastosuj nowe zdjęcie'),undefined);await h.close();
  });
  await t.test('failed request shows the safe message; history lists requests',async()=>{
   setup({jobs:[job({state:'failed',error:'Procesor tła nie zwrócił obrazu PNG'})]});const h=await mount();
   await until(()=>h.el.textContent.includes('Procesor tła nie zwrócił obrazu PNG'));assert(h.el.textContent.includes('Historia'));await h.close();
  });
  await t.test('read-only copy has no write buttons; a missing module renders nothing',async()=>{
   setup({read_only:true,jobs:[job({state:'ready',result_image_id:RES,result_url:'/api/product-images/'+RES})]});const h=await mount();
   await until(()=>h.el.querySelector('img[alt="Wynik bez tła"]'));assert.equal(h.button('Usuń tło'),undefined);assert.equal(h.button('Zastosuj nowe zdjęcie'),undefined);assert.equal(h.button('Odrzuć'),undefined);await h.close();
   setup({available:false});const m=await mount();await until(()=>s.calls.length>0);await tick();assert.equal(m.el.textContent,'');await m.close();
  });
 }finally{
  globalThis.fetch=oldFetch;await vite.close();
  for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
 }
});
