/** Actual settings/billing/CreateModal with closed fetch; no app startup or provider IO. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import React,{act}from'react';import{JSDOM}from'jsdom';import{createServer}from'vite';import{webcrypto}from'node:crypto';
const id=n=>`${n.toString(16).padStart(8,'0')}-1000-4000-8000-000000000001`;
const tenant=id(1),actor=id(2),user={id:actor,tenant_id:tenant,tenant_name:'Firma A',plan:'starter',role:'admin'},scope=tenant+':'+actor+':admin';
const propsOf=e=>e[Object.keys(e).find(k=>k.startsWith('__reactProps'))];
const button=(h,text)=>[...h.el.querySelectorAll('button')].find(e=>e.textContent.trim()===text);
async function submit(form,handler=propsOf(form).onSubmit){await act(async()=>{await handler({preventDefault(){},currentTarget:form});});}
const workspace={tenant:{name:'Firma A',plan:'starter',plan_name:'Starter',currency:'PLN',locale:'pl-PL',limits:{products:100,orders:100,channels:5,warehouses:5,memberships:5}},usage:{products:1,orders:1,channels:1,warehouses:1,memberships:1},pending_invitations:1,billing_available:false,plans:[{code:'starter',name:'Starter'},{code:'business',name:'Business'}],members:[{id:actor,name:'Own',email:'own@example.test',role:'admin'}],invitations:[{id:id(3),email:'invite@example.test',role:'operator',expires_at:'2027-01-01T00:00:00Z'}]};
const billing={admin:true,plans:[{plan:'business',name:'Business',currency:'PLN',monthly_amount:1000,limits:{orders:1000}}],account:{version:1,current_terms:{name:'Starter'},period_start:'2026-10-01T00:00:00Z',period_end:'2027-10-01T00:00:00Z',monthly_amount:100,currency:'PLN',auto_renew:true,next_terms:{name:'Business',currency:'PLN',monthly_amount:1000}},entries:[{id:id(4),kind:'activate',terms:{name:'Starter'},amount:100,currency:'PLN',created_at:'2026-10-01T00:00:00Z',period_start:'2026-10-01T00:00:00Z',period_end:'2027-10-01T00:00:00Z'}],next_cursor:{id:id(4),created_at:'2026-10-01T00:00:00Z'}};
const preview={id:id(5),terms:{name:'Business',currency:'PLN'},kind:'change',effective_at:'2026-10-19T00:00:00Z',period_end:'2027-10-01T00:00:00Z',debit:1000,credit:100,total:900,blockers:[],can_commit:true};
test('restored global creation and organization settings preserve reads, refuse live and retained writes',async t=>{
 const dom=new JSDOM('<body/>',{url:'http://127.0.0.1:4106/'}),saved=new Map(),originalFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,location:dom.window.location,history:dom.window.history,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,FormData:dom.window.FormData,CustomEvent:dom.window.CustomEvent,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const main=path.resolve('web/main.tsx'),vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error',plugins:[{name:'settings-components-without-bootstrap',enforce:'pre',transform(code,file){if(file.split('?')[0]!==main)return;const at=code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)");assert(at>0);return{code:code.slice(0,at),map:null};}}]});
 const roots=new Set();let requests=[],changed=[],notices=[],saves=[],handler;
 try{
  const mod=await vite.ssrLoadModule(main),ws=await vite.ssrLoadModule(path.resolve('web/workspaces.tsx')),bill=await vite.ssrLoadModule(path.resolve('web/workspace-billing.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts')),{createRoot}=await import('react-dom/client');api.setWorkspace(tenant);
  globalThis.fetch=async(url,options={})=>{const r={url,method:options.method??'GET',body:options.body?JSON.parse(options.body):null};requests.push(r);return handler(r);};
  function reset(){requests=[];changed=[];notices=[];saves=[];handler=r=>{
   if(r.method==='GET'){
    if(r.url==='/api/workspaces/settings')return Response.json(workspace);
    if(r.url==='/api/auth/me')return Response.json({user});
    if(r.url==='/api/settings')return Response.json({tenant:{currency:'PLN'},warehouses:[{id:id(7),name:'MAIN'}]});
    if(r.url==='/api/health')return Response.json({manual_order_lines_available:false});
    if(r.url==='/api/order-fields')return Response.json({available:false,data:[],current_role:'admin'});
    if(r.url.startsWith('/api/products?'))return Response.json({data:[],meta:{}});
    if(r.url.startsWith('/api/workspaces/billing?'))return Response.json({entries:[{...billing.entries[0],id:id(6)}],next_cursor:null});
    if(r.url==='/api/workspaces/billing')return Response.json(billing);
   }
   if(r.method==='POST'&&r.url==='/api/warehouses')return Response.json({id:id(8)});
   if(r.method==='PATCH'&&r.url==='/api/workspaces/settings')return Response.json({});
   if(r.method==='POST'&&r.url==='/api/workspaces')return Response.json({user});
   if(r.method==='POST'&&r.url==='/api/workspaces/billing/preview')return Response.json(preview);
   if(r.method==='POST'&&r.url.endsWith('/commit'))return Response.json({});
   throw Error('Unexpected closed route '+r.method+' '+r.url);
  };}
  async function mount(Component,initial){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);roots.add(root);let p=initial;const h={el,async render(next={}){p={...p,...next};await act(async()=>root.render(React.createElement(Component,p)));},async close(){await act(async()=>root.unmount());roots.delete(root);el.remove();}};await h.render();return h;}
  const wsProps={user,readOnly:true,refresh:0,changed:u=>changed.push(u),notify:(...v)=>notices.push(v)};
  await t.test('actual global create action expression omits all creation kinds only in preview',()=>{
   const text=fs.readFileSync(main,'utf8'),a=text.indexOf('  const action =\n',text.indexOf('function App()')),b=text.indexOf('  const actionText:',a),choose=new Function('page','admin','write','restorePreview',text.slice(a,b)+'return action;');
   for(const[page,kind]of [['products','product'],['orders','order'],['inventory','adjust'],['integrations','integration'],['settings','warehouse']]){assert.equal(choose(page,true,true,true),null);assert.equal(choose(page,true,true,false),kind);}
  });
  await t.test('actual warehouse modal refuses readonly, forced submit and retained writable callback; normal save still works',async()=>{
   reset();const h=await mount(mod.CreateModal,{kind:'warehouse',readOnly:false,inventoryContextKey:scope,onClose(){},onSaved:(...v)=>saves.push(v)});
   const form=h.el.querySelector('form');form.elements.name.value='Nowy';form.elements.code.value='NEW';const old=propsOf(form).onSubmit;
   await h.render({readOnly:true});assert(button(h,'Zapisz').disabled);assert(h.el.querySelector('fieldset').disabled);
   await submit(h.el.querySelector('form'));await submit(form,old);assert.equal(requests.filter(r=>r.method!=='GET').length,0);assert.equal(saves.length,0);
   await h.render({readOnly:false});form.elements.name.value='Nowy';form.elements.code.value='NEW';await submit(form);assert.deepEqual(requests.filter(r=>r.method!=='GET').map(r=>[r.url,r.body]),[['/api/warehouses',{name:'Nowy',code:'NEW'}]]);assert.equal(saves.length,1);await h.close();
  });
  await t.test('actual order modal retained submit cannot dispatch after readonly transition',async()=>{
   reset();const h=await mount(mod.CreateModal,{kind:'order',readOnly:false,inventoryContextKey:scope,onClose(){},onSaved:(...v)=>saves.push(v)});
   const form=h.el.querySelector('form'),old=propsOf(form).onSubmit;assert(form);await h.render({readOnly:true});assert(button(h,'Utwórz i zarezerwuj').disabled);
   await submit(form,old);await submit(h.el.querySelector('form'));assert(requests.every(r=>r.method==='GET'));assert.equal(saves.length,0);assert.match(h.el.textContent,/tylko do odczytu/);await h.close();
  });
  await t.test('readonly workspace settings keep names/usage and disable every owned mutation, even forced form/role events',async()=>{
   reset();const h=await mount(ws.WorkspaceSettings,wsProps);assert.match(h.el.textContent,/Firma A|Nazwa organizacji/);assert(h.el.querySelectorAll('progress').length>0);
   for(const text of ['Zapisz organizację','Zmień plan lokalny','Odbierz dostęp','Utwórz zaproszenie','Unieważnij','Utwórz organizację','Przyjmij zaproszenie'])assert(button(h,text)?.disabled,text);
   for(const f of h.el.querySelectorAll('form'))await submit(f);
   const role=h.el.querySelector('select[aria-label^="Rola:"]');await act(async()=>propsOf(role).onChange({target:{value:'viewer'}}));
   for(const text of ['Odbierz dostęp','Unieważnij'])await act(async()=>propsOf(button(h,text)).onClick());
   assert(requests.every(r=>r.method==='GET'));assert.equal(changed.length,0);await h.close();
  });
  await t.test('all retained workspace mutations refuse readonly and principal change; writable organization update preserved',async()=>{
   reset();const h=await mount(ws.WorkspaceSettings,{...wsProps,readOnly:false});const forms=[...h.el.querySelectorAll('form')].map(f=>[f,propsOf(f).onSubmit]);const oldRole=propsOf(h.el.querySelector('select[aria-label^="Rola:"]')).onChange,oldButtons=['Odbierz dostęp','Unieważnij'].map(text=>propsOf(button(h,text)).onClick);
   await h.render({readOnly:true});for(const[f,cb]of forms)await submit(f,cb);await act(async()=>{await oldRole({target:{value:'viewer'}});for(const cb of oldButtons)await cb();});assert(requests.every(r=>r.method==='GET'));
   await h.render({readOnly:false,user:{...user,id:id(99)}});for(const[f,cb]of forms)await submit(f,cb);assert(requests.every(r=>r.method==='GET'));
   const currentForm=h.el.querySelector('form');await submit(currentForm);assert.deepEqual(requests.filter(r=>r.method!=='GET').map(r=>r.url),['/api/workspaces/settings']);assert.equal(changed.length,1);await h.close();
  });
  await t.test('non-admin can still create their own new organization in normal mode',async()=>{
   reset();const h=await mount(ws.WorkspaceSettings,{...wsProps,readOnly:false,user:{...user,role:'viewer'}});const f=button(h,'Utwórz organizację').closest('form');f.elements.name.value='Nowa';await submit(f);assert.deepEqual(requests.filter(r=>r.method!=='GET').map(r=>r.url),['/api/workspaces']);assert.equal(changed.length,1);await h.close();
  });
  await t.test('billing readonly keeps full history/pagination and blocks retained PATCH/preview/commit callbacks',async()=>{
   reset();const h=await mount(bill.WorkspaceBillingPanel,{readOnly:false,contextKey:scope,refresh:0,onChanged:async()=>changed.push(user)});
   const patch=propsOf(button(h,'Wyłącz automatyczne odnowienie')).onClick,cancel=propsOf(button(h,'Anuluj zmianę na kolejny okres')).onClick,form=h.el.querySelector('form'),oldSubmit=propsOf(form).onSubmit;
   await submit(form);assert(button(h,'Zatwierdź abonament lokalny'));const commit=propsOf(button(h,'Zatwierdź abonament lokalny')).onClick;const before=requests.filter(r=>r.method!=='GET').length;
   await h.render({readOnly:true});for(const text of ['Wyłącz automatyczne odnowienie','Anuluj zmianę na kolejny okres','Przygotuj podgląd abonamentu','Zatwierdź abonament lokalny'])assert(button(h,text).disabled,text);
   await act(async()=>{await patch();await cancel();await commit();});await submit(form,oldSubmit);await submit(h.el.querySelector('form'));assert.equal(requests.filter(r=>r.method!=='GET').length,before);
   assert(!button(h,'Starsze kalkulacje').disabled);await act(async()=>button(h,'Starsze kalkulacje').click());assert(requests.some(r=>r.method==='GET'&&r.url.startsWith('/api/workspaces/billing?')));assert.equal(changed.length,0);await h.close();
  });
  await t.test('WorkspaceSettings forwards readonly to its real billing child without losing history',async()=>{
   reset();const base=handler;handler=r=>r.method==='GET'&&r.url==='/api/workspaces/settings'?Response.json({...workspace,billing_available:true}):base(r);
   const h=await mount(ws.WorkspaceSettings,wsProps);assert.match(h.el.textContent,/Historia kalkulacji/);assert(button(h,'Przygotuj podgląd abonamentu').disabled);assert(!button(h,'Starsze kalkulacje').disabled);await act(async()=>button(h,'Starsze kalkulacje').click());assert(requests.every(r=>r.method==='GET'));await h.close();
  });
  await t.test('late organization-create ACK after readonly cannot replace the current principal',async()=>{
   reset();let release;const base=handler;handler=r=>r.method==='POST'&&r.url==='/api/workspaces'?new Promise(resolve=>release=()=>resolve(Response.json({user:{...user,tenant_id:id(98)}}))):base(r);
   const h=await mount(ws.WorkspaceSettings,{...wsProps,readOnly:false});const f=button(h,'Utwórz organizację').closest('form');f.elements.name.value='Nowa';await submit(f);assert(release);await h.render({readOnly:true});await act(async()=>release());assert.equal(changed.length,0);assert.equal(notices.length,0);await h.close();
  });
  await t.test('normal billing preview+commit preserved; late writable ACK after readonly cannot change active user',async()=>{
   reset();const h=await mount(bill.WorkspaceBillingPanel,{readOnly:false,contextKey:scope,refresh:0,onChanged:async()=>changed.push(user)});await submit(h.el.querySelector('form'));await act(async()=>button(h,'Zatwierdź abonament lokalny').click());assert.equal(changed.length,1);
   let release;const base=handler;handler=r=>r.url.endsWith('/commit')?new Promise(resolve=>release=()=>resolve(Response.json({}))):base(r);await submit(h.el.querySelector('form'));await act(async()=>button(h,'Zatwierdź abonament lokalny').click());assert(release);await h.render({readOnly:true});await act(async()=>release());assert.equal(changed.length,1);await h.close();
  });
 }finally{for(const root of roots)await act(async()=>root.unmount());await vite.close();globalThis.fetch=originalFetch;for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}dom.window.close();}
});
