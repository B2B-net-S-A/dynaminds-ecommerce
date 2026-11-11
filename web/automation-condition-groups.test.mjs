import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,tenant=id(1),user=id(2),context=tenant+':'+user;
const grouped=(country=' DE ')=>({name:'Grupy',trigger:'order.paid',enabled:true,priority:10,delay_seconds:30,match:'all',
 conditions:[{field:'currency',op:'eq',value:'PLN'},{group:{match:'any',conditions:[{field:'country',op:'eq',value:country},{field:'tag',op:'contains',value:'VIP'}]}}],actions:[{type:'add_tag',tag:'Łańcuch'}]});
const chain={trigger:'order.paid',match:'all',matched:true,delay_seconds:30,depth_limit:8,
 conditions:[{field:'currency',op:'eq',value:'PLN',matched:true},{group:{match:'any',matched:true,conditions:[{field:'country',op:'eq',value:'DE',matched:false},{field:'tag',op:'contains',value:'VIP',matched:true}]}}],
 actions:[{type:'add_tag',emits:[{trigger:'order.tags_changed',skips_self:true,rules:[{id:id(70),name:'Notatka po tagu',priority:5,delay_seconds:120,self:false,estimate:false}]}]}]};
test('CRUD guard normalizes leaves inside condition groups for readback equality',async()=>{
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 try{
  const {createAutomationCrudGuard}=await vite.ssrLoadModule(path.resolve('web/automation-crud-guard.ts'));
  const rows=[],writes=[],storage=new Map();let n=10;
  const guard=createAutomationCrudGuard({context,read:k=>storage.get(k)??null,write:(k,v)=>storage.set(k,v),newId:()=>id(n++),current:()=>true,lock:async(k,fn)=>fn(),request:async(p,method='GET',body)=>{
   if(p==='/auth/me')return{user:{tenant_id:tenant,id:user,role:'admin'}};if(method==='GET')return{data:structuredClone(rows)};
   writes.push(body);const row={id:id(n++),tenant_id:tenant,actor_id:user,version:'1',...body};rows.push({...row,definition:structuredClone(body)});return row;}});
  const r=await guard.submit(grouped());
  assert(r.confirmed);assert.equal(writes.length,1);assert.equal(writes[0].conditions[1].group.conditions[0].value,'DE');assert.equal(writes[0].conditions[1].group.match,'any');
 }finally{await vite.close();}
});
test('AutomationStudio: group editor, readable group card and preview chain',async()=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(k,opts,fn)=>fn()}});
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client');
 let AutomationStudio,api;
 const order=id(60),existing={id:id(50),tenant_id:tenant,actor_id:user,version:'1',...grouped('DE'),definition:grouped('DE')},rows=[existing],posts=[],previews=[];
 globalThis.fetch=async(url,init={})=>{
  const p=String(url).slice(4),method=init.method??'GET';
  if(p==='/auth/me')return Response.json({user:{tenant_id:tenant,id:user,role:'admin'},restore_preview:false});
  if(p==='/automations'&&method==='POST'){const b=JSON.parse(init.body);posts.push(b);const row={id:id(51),tenant_id:tenant,actor_id:user,version:'1',...b,definition:b};rows.push(row);return Response.json(row);}
  if(p.endsWith('/preview')&&method==='POST'){previews.push(p);return Response.json({snapshot:{},matched:true,allowed:true,result:[],chain});}
  assert.equal(method,'GET','unexpected mutation '+p);
  if(p==='/automations')return Response.json({data:structuredClone(rows),jobs:[]});
  if(p==='/settings')return Response.json({warehouses:[]});
  if(p.startsWith('/orders'))return Response.json({data:[{id:order,number:'ZAM-1',customer_name:'QA',status:'paid'}]});
  if(p==='/automations/local-effects/options')return Response.json({channels:[],smtp_channels:[],warehouses:[],listings_truncated:false,processor_running:true});
  return Response.json({data:[],meta:{has_more:false,cursor:null}});
 };
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<50&&!fn();i++)await tick();assert(fn(),el.textContent);}
 const button=text=>[...el.querySelectorAll('button')].find(x=>x.textContent.trim()===text);
 async function change(input,value){const key=Object.keys(input).find(k=>k.startsWith('__reactProps$'));assert(key);await React.act(async()=>input[key].onChange({target:{value}}));}
 try{
  ({LegacyAutomationStudio:AutomationStudio}=await vite.ssrLoadModule(path.resolve('web/operations.tsx')));api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
  api.setWorkspace(tenant);
  await React.act(async()=>root.render(React.createElement(AutomationStudio,{workerContextKey:context,admin:true,readOnly:false,refresh:0,reload(){},notify(){}})));
  await until(()=>button('Nowa reguła')&&!button('Nowa reguła').disabled&&el.textContent.includes('Dowolny z:'));
  assert.match(el.textContent,/Dowolny z: Kraj jest równe DE \/ Tag zawiera VIP/);
  await React.act(async()=>button('Nowa reguła').click());
  await change(el.querySelector('input[minlength="2"]'),'Reguła z grupą');await change(el.querySelector('input[aria-label="Treść notatki"]'),'Gotowe');
  await React.act(async()=>button('Dodaj grupę warunków').click());
  await change(el.querySelector('select[aria-label="Łączenie warunków w grupie 1"]'),'all');
  await React.act(async()=>button('Dodaj warunek do grupy').click());
  assert.equal(el.querySelectorAll('fieldset.ops-condition-group .ops-condition').length,2);
  await React.act(async()=>el.querySelector('form.rule-editor').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await until(()=>posts.length===1&&!el.querySelector('form.rule-editor'));
  assert.deepEqual(posts[0].conditions,[{group:{match:'all',conditions:[{field:'source',op:'eq',value:'manual'},{field:'source',op:'eq',value:'manual'}]}}]);
  await React.act(async()=>[...el.querySelectorAll('button')].filter(x=>x.textContent.trim()==='Sprawdź na zamówieniu')[0].click());
  await until(()=>el.querySelector('select[aria-label="Zamówienie do sprawdzenia reguły"] option[value="'+order+'"]'));
  await change(el.querySelector('select[aria-label="Zamówienie do sprawdzenia reguły"]'),order);
  await React.act(async()=>button('Sprawdź regułę bez zmian').click());
  await until(()=>el.textContent.includes('Łańcuch reguły'));
  assert.deepEqual(previews,['/automations/'+existing.id+'/preview']);
  const text=el.querySelector('[aria-label="Łańcuch reguły"]').textContent;
  assert.match(text,/Zdarzenie: Etap: .* · opóźnienie 30 s/);
  assert.match(text,/✓ Waluta jest równe PLN/);
  assert.match(text,/✓ Dowolny z:.*✗ Kraj jest równe DE.*✓ Tag zawiera VIP/);
  assert.match(text,/→ Zmieniono tagi: ✗ Notatka po tagu \(priorytet 5, opóźnienie 120 s\)/);
  assert.match(text,/nie uruchomi się ponownie/);
  assert.match(text,/po 8 zdarzeniach/);
 }finally{await React.act(async()=>root.unmount());el.remove();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
