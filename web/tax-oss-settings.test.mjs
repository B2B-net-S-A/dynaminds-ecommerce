/** Actual OSS settings decoder, body and React panel; controlled fetch only, no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const countries=['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PT','RO','SE','SI','SK'];
const classes=['standard','reduced_1','reduced_2','super_reduced','zero'];
const view=(settings={version:null,registered:false,registered_from:null,updated_at:null},rates=[],extra={})=>({settings,rates,countries,rate_classes:classes,read_only:false,...extra});
const registered={version:2,registered:true,registered_from:'2026-07-01',updated_at:'2026-10-23T10:00:00.000Z'};
test('OSS settings panel: decoder, body and admin table edit',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom');
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),m=await vite.ssrLoadModule(path.resolve('web/tax-oss-settings.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn,note){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),note);}
 let handles=[],fx;
 function reset(get){fx={get,puts:[],answers:[]};globalThis.fetch=async(url,init={})=>{
  const route=new URL(String(url),'http://127.0.0.1').pathname,method=init.method??'GET';assert.equal(route,'/api/tax/oss');
  if(method==='GET'){const g=fx.get;return typeof g==='function'?g():Response.json(g);}
  assert.equal(method,'PUT');fx.puts.push(JSON.parse(init.body));const[status,body]=fx.answers.shift();return Response.json(body,{status});
 };api.setWorkspace(id(1));}
 async function mount(props={}){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);handles.push({el,root});
  await React.act(async()=>root.render(React.createElement(m.TaxOssSettingsPanel,{contextKey:`${id(1)}:${id(2)}:admin:false`,readOnly:false,admin:true,...props})));await until(()=>!el.querySelector('[role="status"]'),'loaded');return el;}
 const buttons=(el,text)=>[...el.querySelectorAll('button')].filter(b=>b.textContent===text);
 async function click(e){assert(e&&!e.disabled);await React.act(async()=>e.click());}
 async function set(input,value){await React.act(async()=>{const proto=input.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
 async function submit(el){await React.act(async()=>el.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));}
 try{
  await t.test('decoder refuses foreign or inconsistent settings; body parses comma rates and refuses duplicates and out-of-range',()=>{
   assert.equal(m.readOssSettings(view(registered,[{country:'DE',rate_class:'standard',rate:'19.00'}])).rates.length,1);
   for(const bad of [null,view(undefined,[],{countries:countries.slice(1)}),view(undefined,[],{rate_classes:['standard']}),view({...registered,registered_from:null}),view({...registered,registered:false}),view({...registered,registered_from:'2026-02-30'}),view({version:null,registered:true,registered_from:'2026-07-01',updated_at:null}),
    view(registered,[{country:'PL',rate_class:'standard',rate:'23.00'}]),view(registered,[{country:'DE',rate_class:'x',rate:'19.00'}]),view(registered,[{country:'DE',rate_class:'standard',rate:'19'}]),view(registered,[{country:'DE',rate_class:'standard',rate:'31.00'}]),view(registered,[{country:'DE',rate_class:'standard',rate:'19.00'},{country:'DE',rate_class:'standard',rate:'7.00'}])])
    assert.throws(()=>m.readOssSettings(bad),/obce ustawienia OSS/);
   assert.deepEqual(m.ossSettingsBody(2,true,'2026-07-01',[{key:1,country:'DE',rate_class:'standard',rate:'19'},{key:2,country:'FR',rate_class:'reduced_1',rate:' 5,5 '}]),{version:2,registered:true,registered_from:'2026-07-01',rates:[{country:'DE',rate_class:'standard',rate:19},{country:'FR',rate_class:'reduced_1',rate:5.5}]});
   assert.deepEqual(m.ossSettingsBody(null,false,'2026-07-01',[]),{version:null,registered:false,registered_from:null,rates:[]});
   assert.throws(()=>m.ossSettingsBody(2,true,'',[]),/datę początku/);
   assert.throws(()=>m.ossSettingsBody(2,false,'',[{key:1,country:'DE',rate_class:'standard',rate:'19'},{key:2,country:'DE',rate_class:'standard',rate:'7'}]),/dwa razy/);
   for(const rate of ['','31','19.123','-1','abc','1e1'])assert.throws(()=>m.ossSettingsBody(2,false,'',[{key:1,country:'DE',rate_class:'standard',rate}]),/od 0 do 30/,rate);
   assert.throws(()=>m.ossSettingsBody(2,false,'',[{key:1,country:'PL',rate_class:'standard',rate:'23'}]),/z listy/);
  });
  await t.test('read-only users and copies see the table without edit controls',async()=>{
   reset(view(registered,[{country:'DE',rate_class:'standard',rate:'19.00'},{country:'FR',rate_class:'reduced_1',rate:'5.50'}]));
   let el=await mount({admin:false});assert(el.textContent.includes('Zarejestrowano w OSS od 2026-07-01'));assert(el.textContent.includes('DEPodstawowa19,00%'));assert(el.textContent.includes('FRObniżona 15,50%'));assert(!el.querySelector('form'));
   el=await mount({readOnly:true});assert(!el.querySelector('form'));assert(el.textContent.includes('Kopia tylko do odczytu'));
  });
  await t.test('admin registers, adds and removes rows, saves the whole table; server refusal stays inline',async()=>{
   reset(view());const el=await mount();assert(el.textContent.includes('Brak stawek'));
   await click(el.querySelector('input[type="checkbox"]'));await submit(el);await until(()=>el.querySelector('[role="alert"]'),'date required');assert.equal(fx.puts.length,0);
   await set(el.querySelector('input[type="date"]'),'2026-07-01');
   await click(buttons(el,'Dodaj stawkę')[0]);await click(buttons(el,'Dodaj stawkę')[0]);await click(buttons(el,'Dodaj stawkę')[0]);
   const rows=()=>[...el.querySelectorAll('tbody tr')].filter(r=>r.querySelector('select'));assert.equal(rows().length,3);
   assert.deepEqual(rows().map(r=>[...r.querySelectorAll('select')].map(s=>s.value)),[['AT','standard'],['AT','reduced_1'],['AT','reduced_2']],'new rows take free combinations');
   await set(rows()[0].querySelectorAll('select')[0],'DE');await set(rows()[0].querySelector('input'),'19');
   await set(rows()[1].querySelectorAll('select')[0],'FR');await set(rows()[1].querySelector('input'),'5,5');
   await click(rows()[2].querySelector('button'));assert.equal(rows().length,2);
   fx.answers.push([422,{detail:'rates.0: Stawka DE / standard występuje dwa razy'}]);await submit(el);await until(()=>el.querySelector('[role="alert"]')?.textContent.includes('występuje dwa razy'),'server reason');assert(el.querySelector('form'));
   const stored=view(registered,[{country:'DE',rate_class:'standard',rate:'19.00'},{country:'FR',rate_class:'reduced_1',rate:'5.50'}]);fx.answers.push([200,stored]);await submit(el);
   await until(()=>el.textContent.includes('Zapisano ustawienia OSS.'),'saved');
   assert.deepEqual(fx.puts.at(-1),{version:null,registered:true,registered_from:'2026-07-01',rates:[{country:'DE',rate_class:'standard',rate:19},{country:'FR',rate_class:'reduced_1',rate:5.5}]});
   assert.deepEqual(rows().map(r=>r.querySelector('input').value),['19.00','5.50']);
   fx.get=view({...registered,version:3},[]);fx.answers.push([409,{detail:'Ustawienia OSS zmieniono w innym oknie. Odśwież.'}]);await submit(el);
   await until(()=>el.querySelector('[role="alert"]')?.textContent.includes('w innym oknie')&&rows().length===0,'reloaded after 409');assert.equal(fx.puts.at(-1).version,2);
  });
  await t.test('missing migration 226 shows a notice',async()=>{
   reset(()=>Response.json({detail:'Model podatkowy (migracja 226) jest niedostępny w tej kopii'},{status:503}));const el=await mount();assert(el.textContent.includes('Model podatkowy niedostępny w tej kopii'));
  });
 }finally{for(const h of handles){await React.act(async()=>h.root.unmount());h.el.remove();}globalThis.fetch=oldFetch;await vite.close();dom.window.close();for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
});
