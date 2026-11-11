import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {NbpRates} from '../web/nbp-rates';
import type {api} from '../web/api';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const key='TENANT1:USER1:operator:false',me={user:{tenant_id:'TENANT1',id:'USER1',role:'operator'},restore_preview:false};
const capability={available:true,read_only:false,currencies:['EUR'],max_age_days:7};
const quote=()=>({provider:'NBP',table:'A',table_number:'199/A/NBP/2026',currency_code:'EUR',currency_name:'euro',publication_date:'2026-10-13',effective_date:'2026-10-13',publication_date_source:'NBP effectiveDate',source_decimal:'4.38060000',mid_decimal:'4.38060000',mid_scaled:'438060000',scale:8,source_age_days:1,max_age_days:7,observed_at:'2026-10-14T12:00:00.000Z',mode:'public_read_only'});
async function fixture(handler:(path:string,signal?:AbortSignal)=>Promise<any>){
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'}),old=new Map<string,PropertyDescriptor|undefined>();
 for(const [name,value]of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,IS_REACT_ACT_ENVIRONMENT:true})){old.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});}
 const root=createRoot(dom.window.document.getElementById('root')),calls:Array<{path:string;signal?:AbortSignal}>=[];
 const read=((path:string,_method:string,_body:unknown,_headers:unknown,signal?:AbortSignal)=>{calls.push({path,signal});return handler(path,signal);}) as typeof api;
 const render=async(context=key,readOnly=false)=>{await act(async()=>{root.render(createElement(NbpRates,{contextKey:context,readOnly,read}));});};
 const click=async()=>{await act(async()=>{dom.window.document.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));});};
 await render();
 return{dom,root,calls,render,click,text:()=>dom.window.document.body.textContent as string,close:async()=>{await act(async()=>root.unmount());dom.window.close();for(const [n,d]of old){if(d)Object.defineProperty(globalThis,n,d);else Reflect.deleteProperty(globalThis,n);}}};
}
test('mount never reads; one manual click renders source decimal unchanged and informational-only notice',async()=>{
 const f=await fixture(async path=>path==='/auth/me'?me:path==='/nbp'?capability:quote());
 try{assert.equal(f.calls.length,0);await f.click();assert.deepEqual(f.calls.map(x=>x.path),['/auth/me','/nbp','/nbp/rate?currency=EUR','/auth/me']);assert(f.text().includes('1 EUR = 4,38060000 PLN'));assert(f.text().includes('2026-10-13'));assert(f.text().includes('nie przelicza cen'));assert(!f.text().includes('Zastosuj'));}finally{await f.close();}
});
test('restore and disabled capability never call rate endpoint; no automatic retry',async()=>{
 const f=await fixture(async path=>path==='/auth/me'?me:{...capability,available:false});
 try{await f.render('TENANT1:USER1:operator:true',true);assert(f.dom.window.document.querySelector('button').disabled);assert.equal(f.calls.length,0);await f.render();await f.click();assert(f.text().includes('nie został włączony'));assert(!f.calls.some(x=>x.path.startsWith('/nbp/rate')));}finally{await f.close();}
});
test('late reply after workspace change or unmount is canceled and never displayed',async()=>{
 let finish!:(value:any)=>void;const pending=new Promise<any>(resolve=>{finish=resolve;});
 const f=await fixture(async path=>path==='/auth/me'?me:path==='/nbp'?capability:pending);
 try{await f.click();assert.equal(f.calls.length,3);const signal=f.calls[2]!.signal;await f.render('TENANT2:USER2:admin:false');assert(signal?.aborted);await act(async()=>finish(quote()));assert(!f.text().includes('4,38060000'));assert.equal(f.calls.length,3);}finally{await f.close();}
 let after!:(value:any)=>void;const p=new Promise<any>(resolve=>{after=resolve;}),g=await fixture(async path=>path==='/auth/me'?me:path==='/nbp'?capability:p);await g.click();const signal=g.calls[2]!.signal;await g.close();assert(signal?.aborted);await act(async()=>after(quote()));assert.equal(g.calls.length,3);
});
test('re-read errors and corrupted quote clear prior result; post-read identity change refuses',async()=>{
 let reads=0;const f=await fixture(async path=>{if(path==='/auth/me')return me;if(path==='/nbp')return capability;if(++reads===1)return quote();throw Error('Limit odczytów NBP. Spróbuj później');});
 try{await f.click();assert(f.text().includes('4,38060000'));await f.click();assert(!f.text().includes('4,38060000'));assert(f.text().includes('Limit odczytów'));assert.equal(reads,2);}finally{await f.close();}
 for(const bad of [{...quote(),source_decimal:4.3806,mid_decimal:4.3806},{...quote(),table_number:199},{...quote(),mid_scaled:'43806'},{...quote(),source_age_days:0},{...quote(),publication_date:'2026-02-30',effective_date:'2026-02-30'},{...quote(),currency_code:'USD'}]){const g=await fixture(async path=>path==='/auth/me'?me:path==='/nbp'?capability:bad);try{await g.click();assert(!g.text().includes('1 EUR ='));assert(g.dom.window.document.querySelector('[role="alert"]'));}finally{await g.close();}}
 let auths=0;const g=await fixture(async path=>path==='/auth/me'?(++auths===1?me:{...me,user:{...me.user,role:'admin'}}):path==='/nbp'?capability:quote());try{await g.click();assert(!g.text().includes('1 EUR ='));assert(g.text().includes('Kontekst użytkownika'));}finally{await g.close();}
});
