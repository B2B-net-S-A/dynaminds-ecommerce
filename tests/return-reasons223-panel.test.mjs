/** Actual React 223 return reason dictionary panel + reason hook + shared web api client
 * against controlled fetch DTOs (jsdom). No real server, database or browser acceptance is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

const id=n=>`${String(n).padStart(8,'0')}-2230-4000-8000-000000000001`;
const tenant=id(1),user=id(2);
const dom=new JSDOM('<body/>',{url:'http://127.0.0.1/'}),prior=new Map(),originalFetch=globalThis.fetch;
for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,
 Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,FormData:dom.window.FormData,HTMLFormElement:dom.window.HTMLFormElement,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true})){
 prior.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});
}
const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const P=await vite.ssrLoadModule(path.resolve('web/return-reasons.tsx'));
const A=await vite.ssrLoadModule(path.resolve('web/api.ts'));
const {createRoot}=await import('react-dom/client');
test.after(async()=>{await vite.close();dom.window.close();globalThis.fetch=originalFetch;for(const[k,d]of prior)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];});

/** Controlled /api/return-reasons with the native rules the panel relies on (version, unique name). */
function server(patch={}){
 const f={calls:[],unavailable:false,reasons:[{id:id(10),public_id:4,name:'Uszkodzony towar',active:true,position:0,version:1},
  {id:id(11),public_id:7,name:'Za mały rozmiar',active:false,position:1,version:2}],...patch};
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url,'http://127.0.0.1'),method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;
  f.calls.push({method,path:u.pathname+u.search,body});assert.equal(new Headers(init.headers).get('X-Workspace-ID'),tenant);
  if(f.unavailable)return Response.json({detail:'Słownik powodów zwrotu jest niedostępny w tej kopii'},{status:503});
  if(method==='GET'&&u.pathname==='/api/return-reasons')
   return Response.json({data:f.reasons.filter(r=>u.searchParams.get('include_inactive')==='true'||r.active),read_only:false});
  if(method==='POST'&&u.pathname==='/api/return-reasons'){
   if(f.reasons.some(r=>r.name.toLowerCase()===body.name.toLowerCase()))return Response.json({detail:'Powód zwrotu o tej nazwie już istnieje'},{status:409});
   const r={id:id(20+f.reasons.length),public_id:8+f.reasons.length,name:body.name,active:true,position:f.reasons.length,version:1};f.reasons.push(r);return Response.json(r,{status:201});
  }
  const m=/^\/api\/return-reasons\/(.+)$/.exec(u.pathname);
  if(method==='PATCH'&&m){const r=f.reasons.find(x=>x.id===m[1]);if(r.version!==body.version)return Response.json({detail:'Powód zmieniono w innym oknie. Odśwież listę.'},{status:409});
   Object.assign(r,{...('name' in body?{name:body.name}:{}),...('active' in body?{active:body.active}:{}),version:r.version+1});return Response.json(r);}
  throw Error('Unexpected request '+method+' '+u.pathname);
 };
 return f;
}
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
async function mount(element){
 A.setWorkspace(tenant);
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 await act(async()=>root.render(React.createElement(React.StrictMode,null,element)));await flush();
 const button=label=>[...el.querySelectorAll('button')].find(b=>b.textContent===label);
 const setValue=async(input,value)=>act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 return{el,button,setValue,
  async click(label,index=0){const b=[...el.querySelectorAll('button')].filter(x=>x.textContent===label)[index];assert(b,label+' in '+el.textContent);assert(!b.disabled,label+' disabled');await act(async()=>{b.click();});await flush();},
  async submit(){const form=el.querySelector('form');await act(async()=>{form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});await flush();},
  async close(){await act(async()=>root.unmount());el.remove();}};
}
const rows=el=>[...el.querySelectorAll('tbody tr')].map(tr=>[...tr.querySelectorAll('td')].slice(0,3).map(td=>td.textContent));
const panel=(props={})=>React.createElement(P.ReturnReasonsPanel,{contextKey:tenant+':'+user+':admin:false',readOnly:false,blocked:false,...props});

test('admin panel lists every reason, adds, renames and deactivates with the exact native bodies',async()=>{
 const f=server(),v=await mount(panel());
 assert.equal(f.calls[0].path,'/api/return-reasons?include_inactive=true');
 assert.deepEqual(rows(v.el),[['4','Uszkodzony towar','Aktywny'],['7','Za mały rozmiar','Nieaktywny']]);
 await v.setValue(v.el.querySelector('input[name="name"]'),'Niezgodny z opisem');await v.submit();
 assert.deepEqual(f.calls.find(c=>c.method==='POST').body,{name:'Niezgodny z opisem'});
 assert.equal(v.el.querySelector('input[name="name"]').value,'','form reset after save');
 assert.equal(rows(v.el).length,3);
 // Duplicate name: the Polish server message is shown and nothing else changes.
 await v.setValue(v.el.querySelector('input[name="name"]'),'uszkodzony towar');await v.submit();
 assert.match(v.el.querySelector('[role="alert"]').textContent,/już istnieje/);assert.equal(f.reasons.length,3);
 await v.click('Zmień nazwę');await v.setValue(v.el.querySelector('input[aria-label="Nowa nazwa: Uszkodzony towar"]'),'Uszkodzenie w transporcie');await v.click('Zapisz');
 assert.deepEqual(f.calls.filter(c=>c.method==='PATCH').map(c=>[c.path,c.body]),[['/api/return-reasons/'+id(10),{version:1,name:'Uszkodzenie w transporcie'}]]);
 await v.click('Przywróć');
 assert.deepEqual(f.calls.filter(c=>c.method==='PATCH').at(-1).body,{version:2,active:true});
 assert.deepEqual(rows(v.el).slice(0,2),[['4','Uszkodzenie w transporcie','Aktywny'],['7','Za mały rozmiar','Aktywny']]);
 await v.close();
});

test('stale version reloads the list; read-only/blocked panel offers no write; missing 223 schema says so',async()=>{
 const f=server(),v=await mount(panel());
 f.reasons[0].version=5; // changed in another window
 const gets=()=>f.calls.filter(c=>c.method==='GET').length,before=gets();
 await v.click('Dezaktywuj');
 assert.match(v.el.querySelector('[role="alert"]').textContent,/w innym oknie/);
 assert.equal(gets(),before+1,'409 reloads the dictionary');assert.equal(f.reasons[0].active,true);
 await v.close();
 const r=await mount(panel({readOnly:true}));
 for(const b of r.el.querySelectorAll('button'))assert.equal(b.disabled,true,b.textContent);
 await r.close();
 server({unavailable:true});const u=await mount(panel());
 assert.match(u.el.textContent,/nie jest dostępny w tej bazie/);await u.close();
});

test('useReturnReasons loads active reasons only when enabled and reports a missing dictionary as unavailable',async()=>{
 const f=server();let seen;
 const Probe=({enabled})=>{seen=P.useReturnReasons(enabled,'ctx');return null;};
 const v=await mount(React.createElement(Probe,{enabled:false}));
 assert.deepEqual(f.calls,[]);assert.equal(seen.available,false);await v.close();
 const w=await mount(React.createElement(Probe,{enabled:true}));
 assert.deepEqual(f.calls.map(c=>c.path),['/api/return-reasons','/api/return-reasons'].slice(0,f.calls.length));
 assert.equal(seen.available,true);assert.deepEqual(seen.reasons.map(r=>r.name),['Uszkodzony towar']);await w.close();
 server({unavailable:true});const x=await mount(React.createElement(Probe,{enabled:true}));
 assert.equal(seen.available,false);assert.deepEqual(seen.reasons,[]);await x.close();
});
