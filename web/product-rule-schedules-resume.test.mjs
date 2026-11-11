import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';
const tenant='00000001-1000-4000-8000-000000000001',user='00000002-1000-4000-8000-000000000002',sid='00000003-1000-4000-8000-000000000003';
const settings={name:'Co godzinę',interval_minutes:60,event:'product.updated',product_ids:['p1'],rule_ids:['r1']};
test('ProductRuleSchedules: a paused schedule resumes through a fresh preview and an explicit approval',async()=>{
 const React=await import('react'),{JSDOM}=await import('jsdom'),dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'}),{createRoot}=await import('react-dom/client');
 const {ProductRuleSchedules}=await vite.ssrLoadModule(path.resolve('web/product-rule-schedules.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const calls=[];let enabled=false,version=2;
 globalThis.fetch=async(url,init={})=>{const p=String(url).slice(4),method=init.method??'GET';calls.push([method,p,init.body?JSON.parse(init.body):null]);
  if(p==='/auth/me')return Response.json({user:{id:user,tenant_id:tenant,role:'admin'},restore_preview:false});
  if(p==='/product-rule-schedules')return Response.json({available:true,read_only:false,data:[{id:sid,version,enabled,next_at:enabled?new Date(Date.now()+3600_000).toISOString():null,error:null,settings}],meta:{cursor:null}});
  if(p.startsWith('/product-rules'))return Response.json({data:[{id:'r1',name:'Reguła',event:'product.updated',enabled:true}],meta:{cursor:null}});
  if(p.startsWith('/products'))return Response.json({data:[],meta:{cursor:null}});
  if(p===`/product-rule-schedules/${sid}/resume-preview`)return Response.json({id:'pv1',scope_hash:'a'.repeat(64),schedule_id:sid,expected_version:version,settings,run:{items:[]}});
  if(p==='/product-rule-schedules/previews/pv1/commit'){enabled=true;version=3;return Response.json({id:sid,version,enabled:true});}
  throw Error('Unexpected '+method+' '+p);};
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let i=0;i<50&&!fn();i++)await tick();assert(fn(),el.textContent);}
 const button=text=>[...el.querySelectorAll('button')].find(x=>x.textContent.trim()===text);
 try{
  api.setWorkspace(tenant);
  await React.act(async()=>root.render(React.createElement(ProductRuleSchedules,{readOnly:false})));
  await until(()=>el.textContent.includes('Wstrzymany'));
  assert(button('Wznów'),'paused row offers resume');
  assert.equal(button('Wznów').disabled,false);
  await React.act(async()=>button('Wznów').click());
  await until(()=>!!button('Wznów harmonogram'));
  assert.deepEqual(calls.find(c=>c[1].endsWith('/resume-preview'))?.[2]?.version,2);
  assert.match(el.textContent,/Wznowienie wymaga nowej zgody/);
  assert.equal(button('Wznów harmonogram').disabled,true,'needs the confirmation checkbox');
  const box=[...el.querySelectorAll('article input[type="checkbox"]')][0];
  await React.act(async()=>box.click());
  await React.act(async()=>button('Wznów harmonogram').click());
  await until(()=>el.textContent.includes('Włączony'));
  assert(calls.some(c=>c[0]==='POST'&&c[1]==='/product-rule-schedules/previews/pv1/commit'&&c[2].confirmed===true));
  assert.equal(button('Wznów'),undefined,'enabled schedule has no resume');
 }finally{await React.act(async()=>root.unmount());el.remove();await vite.close();globalThis.fetch=oldFetch;for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}dom.window.close();}
});
