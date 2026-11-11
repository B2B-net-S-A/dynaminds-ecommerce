import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

// Actual component + api helper with controlled fetch, no server/PG/provider.
const dir = await mkdtemp(path.resolve('tests/.integration-history-'));
await writeFile(path.join(dir, 'entry.ts'), "export {IntegrationVerificationHistory} from '../../web/integration-workspace'; export {setWorkspace} from '../../web/api';");
await build({entryPoints:[path.join(dir,'entry.ts')],outdir:dir,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',logLevel:'silent'});
const ui = await import(pathToFileURL(path.join(dir,'entry.js')).href);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url:'http://localhost/' });
for (const name of ['window','document','navigator','HTMLElement','MouseEvent','Event'])
  Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true,writable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {createRoot}=await import('react-dom/client');
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000000`;
const tenant=id(1),user=id(2),a=id(3),b=id(4),channel=i=>({id:i,name:i===a?'Kanał A':'Kanał B',provider:'woocommerce'});
const row=(i,operation='verify')=>({id:id(i),operation,status:'success',created_at:'2026-10-11T10:00:00.123Z',scope:'read_only'});
const page=(ch,rows=[row(10)],next=null)=>({channel:channel(ch),data:rows,next});
const props={tenantId:tenant,userId:user,contextKey:tenant+':'+user,refresh:0,recentRuns:[]};
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(f){for(let i=0;i<40;i++){if(f())return;await tick();}assert(f(),'expected component state');}
function button(h,label){const el=[...h.container.querySelectorAll('button')].find(x=>x.textContent===label);assert(el,label);return el;}
async function click(el){assert(!el.disabled,el.textContent);await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
async function choose(h,value){await act(async()=>{const s=h.container.querySelector('select');s.value=value;s.dispatchEvent(new Event('change',{bubbles:true}));});}
async function mount(answer,p=props){
 const reads=[];globalThis.fetch=async(url,init={})=>{const u=new URL(url,'http://localhost');assert.equal(init.method,'GET');reads.push({u,init});return answer(u,init);};
 ui.setWorkspace(p.tenantId);const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 const h={container,root,reads,async render(next){ui.setWorkspace(next.tenantId);await act(async()=>root.render(React.createElement(ui.IntegrationVerificationHistory,next)));},async close(){await act(async()=>root.unmount());container.remove();}};
 await h.render(p);await tick();return h;
}
const connections=(rows=[channel(a),channel(b)],next=null)=>Response.json({data:rows,total:rows.length,next});
try {
 await test('actual pager requests bounded older page, returns newer, refreshes first and never writes',async()=>{
  const opaque='older/+==',h=await mount(u=>u.pathname.endsWith('/connections')?connections():Response.json(page(a,[row(u.searchParams.has('after')?12:11,u.searchParams.has('after')?'sync':'preview')],u.searchParams.has('after')?null:opaque)));
  try{await choose(h,a);await until(()=>h.container.textContent.includes('Podgląd'));const next=button(h,'Starsze sprawdzenia');
   await act(async()=>{next.dispatchEvent(new MouseEvent('click',{bubbles:true}));next.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
   await until(()=>h.container.textContent.includes('Synchronizacja'));assert(button(h,'Starsze sprawdzenia').disabled);
   const reads=h.reads.filter(x=>x.u.pathname.includes('/verification-history'));assert.equal(reads.length,2);assert.equal(reads[1].u.searchParams.get('after'),opaque);assert(reads.every(x=>x.u.searchParams.get('limit')==='25'));
   await click(button(h,'Nowsze sprawdzenia'));await until(()=>h.container.textContent.includes('Podgląd'));
   await click(button(h,'Odśwież historię'));await until(()=>!button(h,'Odśwież historię').disabled);assert.equal(h.reads.at(-1).u.searchParams.get('after'),null);
  }finally{await h.close();}
 });
 await test('delayed channel response cannot replace new selected channel and is aborted',async()=>{
  const late=defer();let oldSignal;const h=await mount((u,init)=>u.pathname.endsWith('/connections')?connections():u.pathname.includes(a)?(oldSignal=init.signal,late.promise):Response.json(page(b,[row(20,'sync')])));
  try{await choose(h,a);await choose(h,b);await until(()=>h.container.textContent.includes('Synchronizacja'));assert(oldSignal.aborted);late.resolve(Response.json(page(a,[row(21,'preview')])));await tick();assert(!h.container.textContent.includes('Podgląd'));}
  finally{await h.close();}
 });
 await test('principal and tenant changes reset own selection; old replies never render',async()=>{
  const late=defer(),h=await mount(u=>u.pathname.endsWith('/connections')?connections():late.promise);
  try{await choose(h,a);await h.render({...props,userId:id(5),contextKey:tenant+':'+id(5)});late.resolve(Response.json(page(a,[row(22,'preview')])));await tick();assert.equal(h.container.querySelector('select').value,'');assert(!h.container.textContent.includes('Podgląd'));
   await h.render({...props,tenantId:id(6),contextKey:id(6)+':'+user});await until(()=>h.container.querySelector('select').options.length===3);assert.equal(new Headers(h.reads.at(-1).init.headers).get('X-Workspace-ID'),id(6));
  }finally{await h.close();}
 });
 await test('server error is generic with no raw secret; refresh only retries GET',async()=>{
  let fails=true;const h=await mount(u=>u.pathname.endsWith('/connections')?connections():fails?Response.json({detail:'PASSWORD-SECRET'},{status:500}):Response.json(page(a)));
  try{await choose(h,a);await until(()=>h.container.querySelector('[role=alert]'));assert(!h.container.textContent.includes('PASSWORD-SECRET'));assert(button(h,'Starsze sprawdzenia').disabled);fails=false;await click(button(h,'Odśwież historię'));await until(()=>h.container.textContent.includes('Weryfikacja połączenia'));}
  finally{await h.close();}
 });
 await test('foreign channel DTO refuses; valid empty page stays factual and disables older',async()=>{
  let foreign=true;const h=await mount(u=>u.pathname.endsWith('/connections')?connections():Response.json(page(foreign?b:a,[])));
  try{await choose(h,a);await until(()=>h.container.querySelector('[role=alert]'));assert(!h.container.textContent.includes('Kanał BStrona'));foreign=false;await click(button(h,'Odśwież historię'));await until(()=>h.container.textContent.includes('Brak sprawdzeń na tej stronie.'));assert(button(h,'Starsze sprawdzenia').disabled);}
  finally{await h.close();}
 });
 await test('older own channel can be selected from bounded manual connection pagination',async()=>{
  const h=await mount(u=>u.pathname.endsWith('/connections')?connections([channel(u.searchParams.has('after')?b:a)],u.searchParams.has('after')?null:'connections-next'):Response.json(page(b)));
  try{await click(button(h,'Pokaż więcej połączeń'));await until(()=>h.container.querySelector('select').options.length===3);await choose(h,b);await until(()=>h.container.textContent.includes('Weryfikacja połączenia'));assert.equal(h.reads[1].u.searchParams.get('after'),'connections-next');}
  finally{await h.close();}
 });
 await test('overview drops raw detail and opaque operation; cursor loop refuses without auto-poll',async()=>{
  const h=await mount(u=>u.pathname.endsWith('/connections')?connections():Response.json(page(a,[row(30)],'same')),{...props,recentRuns:[{...row(31,'SECRET-OPERATION'),detail:{error:'PASSWORD-SECRET',scope:'read_only'}}]});
  try{assert(!h.container.textContent.includes('SECRET'));assert(h.container.textContent.includes('Sprawdzenie integracji'));await choose(h,a);await until(()=>!button(h,'Starsze sprawdzenia').disabled);await click(button(h,'Starsze sprawdzenia'));await until(()=>h.container.querySelector('[role=alert]'));const n=h.reads.length;await tick();assert.equal(h.reads.length,n);assert(button(h,'Starsze sprawdzenia').disabled);}
  finally{await h.close();}
 });
} finally {dom.window.close();await rm(dir,{recursive:true,force:true});}
