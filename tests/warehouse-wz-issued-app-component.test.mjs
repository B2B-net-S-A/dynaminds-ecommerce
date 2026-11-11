import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { navigateApp } from './app-nav-helper.mjs';

// Real App -> mounted panel -> real api.ts reader, controlled HTTP only.
// Blob handoff is not an actual filesystem download or dispatch proof.
const id = n => `${String(n).padStart(8, '0')}-1680-4168-8168-168168168168`;
const tenant = id(1), user = id(2), clone = v => structuredClone(v);
const valueKeys = new Set(['unit_cost_minor','value_minor','known_value_minor','unknown_quantity','currency','exponent','line_total','vat','rows_sha256']);
function redact(v) { if (Array.isArray(v)) return v.map(redact); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !valueKeys.has(k)).map(([k,x]) => [k, k === 'value_available' ? false : redact(x)])); return v; }
function fixture({ count = 1, rows = 3, capability = true } = {}) {
  const actors = new Map([[tenant,{ id:user,tenant_id:tenant,role:'admin',restore:false,capability }],[id(3),{ id:id(4),tenant_id:id(3),role:'admin',restore:false,capability:false }],[id(6),{ id:user,tenant_id:id(6),role:'viewer',restore:true,capability:true }]]);
  const f = { current:tenant, canValue:true, reads:[], writes:[], authWrites:[], unexpected:[], exports:[], heldDetail:null, heldHealth:null, onExport:null };
  f.actor = () => actors.get(f.current);
  f.user = () => { const { restore,capability,...u } = f.actor(); return { ...u,name:'Własny użytkownik App WZ168',tenant_name:'Własna firma App WZ168',plan:'pro',mfa_required:false }; };
  f.flags = () => ({ available:f.actor().capability,read_only:f.actor().restore,current_role:f.actor().role,can_read:true,can_read_value:f.actor().role === 'admin' && f.canValue });
  f.health = () => ({ schema_revision:'151_warehouse_wz_issuer',restore_preview:f.actor().restore,warehouse_automatic_wz_issuer_available:f.actor().capability,warehouse_automatic_wz_configuration_available:false,warehouse_inventory_policies_available:true,stocktake_adjustments_available:false });
  f.warehouse = { id:id(20),name:'Historyczny magazyn WZ168',code:'SALE' };
  f.heads = Array.from({ length:count },(_,i) => { const n = 100 + count - i; return { id:id(n),kind:'WZ',receipt_id:id(10000+n),number:'WZ168/2026/'+String(n).padStart(6,'0'),series_id:id(30),year:2026,sequence:String(n),warehouse:clone(f.warehouse),source:{ kind:'parcel',order_id:id(40),shipment_id:id(41),plan_id:id(42),parcel_index:0,dispatch_id:id(43) },created_at:'2026-10-07T12:00:00.000001+00:00',row_count:rows,summary:{ physical_quantity:rows,known_value_minor:rows > 1 ? '1000':'0',unknown_quantity:rows > 2 ? 1:0,currency:'PLN',exponent:2 },value_available:true,commercial_lines:[{ item_id:id(80),product_id:id(500),name:'Oryginalna tańsza pozycja',sku:'SAME-SKU',quantity:1,original_quantity:1,line_total:1000,vat:23,currency:'PLN',components:[{product_id:id(500),quantity:1}],allocations:[{physical_id:id(4000),product_id:id(500),warehouse_id:id(20),quantity:1}] },...(rows > 1 ? [{item_id:id(81),product_id:id(82),name:'Oryginalny droższy zestaw',sku:'SAME-SKU',quantity:1,original_quantity:2,line_total:3401,vat:23,currency:'PLN',components:Array.from({length:rows-1},(_,j)=>({ product_id:id(501+j),quantity:1 })),allocations:Array.from({length:rows-1},(_,j)=>({ physical_id:id(4001+j),product_id:id(501+j),warehouse_id:id(20),quantity:1 })) }] : [])] }; });
  f.physical = Array.from({ length:rows },(_,i)=>({ ordinal:i,product_id:id(500+i),sku:'COMP-'+i,name:'Zapisany składnik '+i,quantity:1,location:'RD-'+i,stock_movement_id:id(1000+i),location_movement_id:id(2000+i),operation_id:id(3000),issue_fragment_id:id(4000+i),layer_movement_id:id(5000+i),layer_id:id(6000+i),lot_id:id(7000+i),unit_cost_minor:i===2?null:i===1?'1000':'0',value_minor:i===2?null:i===1?'1000':'0',currency:'PLN',exponent:2 }));
  const project = v => f.flags().can_read_value ? clone(v) : redact(v);
  f.fetch = async (url,init={}) => {
    const u = new URL(String(url),'http://127.0.0.1'),p = u.pathname.replace(/^\/api/,''),method=init.method ?? 'GET';
    if (p !== '/health') assert.equal(new Headers(init.headers).get('X-Workspace-ID'),f.current,'Real api.ts workspace header');
    // Topbar bell of the v2 automation notifications (Uwagi v3 lane M, web/automation-v2-notifications.tsx)
    // polls on mount and every minute; it is outside this scenario, so it is answered and not recorded.
    if (method === 'GET' && p === '/automations/v2/notifications') return Response.json({ unread: 0, data: [] });
    if (method === 'GET') {
      f.reads.push({path:p+u.search,tenant:f.current});
      if (p === '/auth/me') return Response.json({user:f.user()});
      if (p === '/health') return f.heldHealth ?? Response.json(f.health());
      if (p === '/workspaces') return Response.json({data:[...actors].map(([id,a])=>({id,name:a.restore?'Własna kopia WZ168':a.capability?'Własna firma WZ168':'Firma bez WZ168'}))});
      if (p === '/warehouses') return Response.json({data:[f.warehouse]});
      if (p === '/warehouse-wz-issued/options') { if (f.torn) return Response.json({detail:'Niepełna instalacja WZ168'},{status:503}); return Response.json({...f.flags(),warehouses:[f.warehouse],limits:{page:50,rows:10000,file_bytes:8*1024*1024}}); }
      if (p === '/warehouse-wz-issued/documents') {
        assert.equal(u.searchParams.get('limit'),'50'); const cursor=u.searchParams.get('cursor'); assert.ok(cursor===null || cursor==='opaque-real-reader-page-50'); const start=cursor?50:0;
        const rows=f.heads.slice(start,start+50).filter(h=>(!u.searchParams.has('warehouse_id')||h.warehouse.id===u.searchParams.get('warehouse_id'))&&(!u.searchParams.has('order_id')||h.source.order_id===u.searchParams.get('order_id')));
        return Response.json({...f.flags(),data:project(rows),meta:{cursor:start+50<f.heads.length?'opaque-real-reader-page-50':null,limit:50}});
      }
      if (p.startsWith('/warehouse-wz-issued/documents/')) {
        const key=p.split('/')[3],head=f.heads.find(h=>h.id===key); assert.ok(head,'Actual saved document id in request');
        if (p.endsWith('/export')) { const format=u.searchParams.get('format'),include=u.searchParams.get('include_values'); assert.ok(['csv','xml'].includes(format)); assert.ok(['false','true'].includes(include)); f.exports.push({id:key,format,include,tenant:f.current}); const withValues=include==='true'; const d={...f.flags(),document:withValues?clone(head):redact(head),format,values_included:withValues,row_count:rows,filename:`WZ-${key}.${format}`,content_type:format==='csv'?'text/csv; charset=utf-8':'application/xml; charset=utf-8',content:format==='csv'?'number,quantity\nWZ168,1\n':'<wz><row quantity="1"/></wz>',snapshot_at:'2026-10-07T12:00:02Z'}; if(f.onExport)await f.onExport(); return Response.json(d); }
        const d={...f.flags(),...project({document:head,rows:f.physical}),snapshot_at:'2026-10-07T12:00:01Z'}; return f.heldDetail ?? Response.json(d);
      }
      if (p === '/warehouse-inventory-policies/options') return Response.json({available:true,can_read:true,can_manage:f.actor().role==='admin'&&!f.actor().restore,current_role:f.actor().role,read_only:f.actor().restore,warehouses:[{...f.warehouse,policy:{usage:'sale',enabled:true,version:'0'}}],next_cursor:null});
      if (p === '/inventory' || p === '/inventory/movements') return Response.json({data:[],meta:{has_more:false,cursor:null}});
      if (['/dashboard','/orders/status-counts','/stocktakes','/wms-lots','/stock-file-imports/options','/stock-locations','/warehouse-documents'].includes(p)) return Response.json({detail:'Controlled unrelated editor unavailable'},{status:503});
    } else if (method==='POST' && p==='/workspaces/switch') { const b=JSON.parse(init.body);assert.ok(actors.has(b.tenant_id));f.authWrites.push({path:p,tenant:f.current});f.current=b.tenant_id;return Response.json({user:f.user()}); }
    if(method!=='GET')f.writes.push({path:p,method});f.unexpected.push({path:p,method});throw Error('Unexpected actual App WZ168 request '+method+' '+p);
  };
  return f;
}
async function tick(){await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(fn,note){for(let i=0;i<100;i++){if(fn())return;await tick();}assert.ok(fn(),note);}
function button(h,text){const e=[...h.container.querySelectorAll('button')].find(e=>e.textContent.trim()===text);assert.ok(e,text);return e;}
function field(h,text){const e=[...h.container.querySelectorAll('label')].find(e=>e.firstChild?.textContent===text||e.textContent.trim()===text)?.querySelector('select,input');assert.ok(e,text);return e;}
async function click(e){assert.ok(e);assert.equal(e.matches(':disabled'),false);await act(async()=>e.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
async function select(e,v){assert.equal(e.matches(':disabled'),false);await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('change',{bubbles:true}));});}
async function navigate(h,name){await navigateApp(h.container,name,click);}

test('actual App saved WZ168 mount and real read adapter — controlled HTTP',async t=>{
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1/'}),descriptors=new Map(),oldFetch=globalThis.fetch,mounts=[],downloads=[];
  for(const[key,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,location:dom.window.location,localStorage:dom.window.localStorage,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,FormData:dom.window.FormData,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){descriptors.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:v});}
  const oldScroll=dom.window.HTMLElement.prototype.scrollIntoView,oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL,oldClick=dom.window.HTMLAnchorElement.prototype.click;dom.window.HTMLElement.prototype.scrollIntoView=()=>{};URL.createObjectURL=()=> 'blob:controlled-app168';URL.revokeObjectURL=()=>{};dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push(this.download);};
  let vite;const mainPath=path.resolve('web/main.tsx');
  try{
    vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error',plugins:[{name:'actual-app-without-final-bootstrap',enforce:'pre',transform(code,file){if(file.split('?')[0]!==mainPath)return;const start=code.lastIndexOf("\ncreateRoot(document.getElementById('root')!)");assert.ok(start>0,'Only final browser bootstrap removed');return{code:code.slice(0,start)+'\nexport { App as AppUnderTest };\n',map:null};}}]});
    const{createRoot}=await import('react-dom/client'),main=await vite.ssrLoadModule(mainPath),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
    async function mount(f){globalThis.fetch=f.fetch;api.setWorkspace(f.current);const container=document.createElement('div');document.body.append(container);const root=createRoot(container),h={container,async close(){await act(async()=>root.unmount());container.remove();}};mounts.push(h);await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(main.AppUnderTest))));await until(()=>container.querySelector('.sidebar nav'),'Actual authenticated App');return h;}
    async function inventory(h){await navigate(h,'Magazyny');await until(()=>h.container.querySelector('.warehouse-wz-issued'),'Actual saved WZ panel mount');}
    async function ready(h,n=1){await until(()=>h.container.querySelector('.warehouse-wz-issued')?.textContent.includes('Wystawione WZ — odczytano '+n)&&!button(h,'Odśwież wystawione WZ').matches(':disabled'),'Real reader list complete');}
    async function open(h,f,n=1){await ready(h,n);await click(button(h,'Otwórz WZ '+f.heads[0].number));await until(()=>h.container.querySelector('.wwi-detail')&&!button(h,'Pobierz pełny zapisany WZ').matches(':disabled'),'Real adapter full detail validated');}
    async function switchWorkspace(h,f,next){const start=f.reads.length;await select(h.container.querySelector('select[aria-label="Aktywna organizacja"]'),next);await until(()=>f.current===next&&h.container.querySelector('select[aria-label="Aktywna organizacja"]')?.value===next&&f.reads.slice(start).some(r=>r.path==='/health'&&r.tenant===next),'Canonical App switch and new health request');await tick();}

    await t.test('health151 mounts real reader: 51 headers, 103 full physical rows, commercial UUIDs and exact GET export query',async()=>{
      const f=fixture({count:51,rows:103}),h=await mount(f);try{await inventory(h);await ready(h,50);await click(button(h,'Wczytaj kolejne WZ (do 50)'));await ready(h,51);assert.ok(f.reads.some(r=>r.path==='/warehouse-wz-issued/documents?limit=50&cursor=opaque-real-reader-page-50'));
        await click(button(h,'Otwórz WZ '+f.heads[0].number));await until(()=>h.container.querySelector('.wwi-detail')&&!button(h,'Pobierz pełny zapisany WZ').matches(':disabled'),'Full real adapter detail');const detail=h.container.querySelector('.wwi-detail');assert.ok(detail.textContent.includes('Pełny odczyt 103 zapisanych pozycji'));assert.ok(detail.textContent.includes(id(80)));assert.ok(detail.textContent.includes(id(81)));assert.ok(detail.textContent.includes('34,01 PLN'));assert.ok(detail.textContent.includes('Koszt nieznany'));await click(button(h,'Następne pozycje WZ'));const physical=[...detail.querySelectorAll('table')].find(e=>e.caption.textContent.startsWith('Pełne zapisane pozycje WZ'));assert.equal(physical.querySelectorAll('tbody tr').length,3);assert.ok(physical.textContent.includes('Pozycja 103'));
        await select(field(h,'Format eksportu WZ'),'xml');await click(field(h,'Dołącz historyczną wycenę WZ'));const start=downloads.length;await click(button(h,'Pobierz pełny zapisany WZ'));await until(()=>downloads.length===start+1&&!button(h,'Pobierz pełny zapisany WZ').matches(':disabled'),'Real adapter export handoff');assert.deepEqual(f.exports.at(-1),{id:f.heads[0].id,format:'xml',include:'true',tenant});assert.ok(f.reads.some(r=>r.path===`/warehouse-wz-issued/documents/${f.heads[0].id}/export?format=xml&include_values=true`));assert.ok(f.reads.some(r=>r.path===`/warehouse-wz-issued/documents/${f.heads[0].id}`));assert.ok(f.reads.some(r=>r.path==='/warehouse-wz-issued/options'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.unexpected,[]);
      }finally{await h.close();}
    });
    await t.test('fresh actual options value loss redacts held full detail and refuses valued export Blob',async()=>{
      const f=fixture(),h=await mount(f);try{await inventory(h);await ready(h);let resolve;f.heldDetail=new Promise(r=>{resolve=r;});const stale={...f.flags(),document:clone(f.heads[0]),rows:clone(f.physical),snapshot_at:'2026-10-07T12:00:01Z'};await click(button(h,'Otwórz WZ '+f.heads[0].number));await until(()=>f.reads.some(r=>r.path===`/warehouse-wz-issued/documents/${f.heads[0].id}`),'Held real detail route');f.canValue=false;await act(async()=>resolve(Response.json(stale)));await until(()=>h.container.querySelector('.wwi-detail')&&!button(h,'Pobierz pełny zapisany WZ').matches(':disabled'),'Actual final options redacts old detail');assert.ok(!h.container.querySelector('.wwi-detail').textContent.includes('34,01 PLN'));assert.ok(h.container.textContent.includes('Wartość pozycji niedostępna'));assert.equal(field(h,'Dołącz historyczną wycenę WZ').matches(':disabled'),true);
        f.heldDetail=null;f.canValue=true;await click(button(h,'Odśwież wystawione WZ'));await open(h,f);await click(field(h,'Dołącz historyczną wycenę WZ'));const start=downloads.length;f.onExport=async()=>{f.canValue=false;};await click(button(h,'Pobierz pełny zapisany WZ'));await until(()=>h.container.querySelector('.warehouse-wz-issued [role="alert"]'),'Final fresh options refuses file');assert.equal(downloads.length,start);assert.equal(h.container.querySelector('.wwi-detail'),null);assert.ok(!h.container.querySelector('.warehouse-wz-issued').textContent.includes('34,01 PLN'));assert.deepEqual(f.writes,[]);assert.deepEqual(f.unexpected,[]);
      }finally{await h.close();}
    });
    await t.test('actual actor switch purges old detail immediately and resets capability while new health is unresolved',async()=>{
      const f=fixture(),h=await mount(f);try{await inventory(h);await open(h,f);assert.ok(h.container.querySelector('.wwi-detail').textContent.includes('34,01 PLN'));let resolve;f.heldHealth=new Promise(r=>{resolve=r;});await switchWorkspace(h,f,id(3));assert.equal(h.container.querySelector('.wwi-detail'),null);await inventory(h);await until(()=>h.container.querySelector('.warehouse-wz-issued')?.textContent.includes('Odczyt zapisanych automatycznych WZ nie jest dostępny.'),'Health reset no previous issuer capability');assert.equal(h.container.querySelector('.wwi-detail'),null);assert.ok(!h.container.querySelector('.warehouse-wz-issued').textContent.includes('34,01 PLN'));assert.equal(f.reads.filter(r=>r.tenant===id(3)&&r.path.startsWith('/warehouse-wz-issued')).length,0);f.heldHealth=null;await act(async()=>resolve(Response.json(f.health())));await tick();assert.deepEqual(f.writes,[]);assert.deepEqual(f.unexpected,[]);
      }finally{await h.close();}
    });
    await t.test('restored viewer can read full saved quantities and export false without any document POST or prices',async()=>{
      const f=fixture();f.current=id(6);const h=await mount(f);try{await until(()=>h.container.textContent.includes('Kopia odtworzona · tylko odczyt'),'Actual restore banner');await inventory(h);await open(h,f);assert.ok(h.container.querySelector('.warehouse-wz-issued').textContent.includes('Kopia odtworzona — tylko odczyt i eksport.'));assert.ok(h.container.textContent.includes(id(80)));assert.ok(!h.container.querySelector('.wwi-detail').textContent.includes('34,01 PLN'));assert.equal(field(h,'Dołącz historyczną wycenę WZ').matches(':disabled'),true);const start=downloads.length;await click(button(h,'Pobierz pełny zapisany WZ'));await until(()=>downloads.length===start+1&&!button(h,'Pobierz pełny zapisany WZ').matches(':disabled'),'Copy readonly file handoff');assert.equal(f.exports.at(-1).include,'false');assert.equal(f.exports.at(-1).tenant,id(6));assert.ok(f.reads.filter(r=>r.path.startsWith('/warehouse-wz-issued')).every(r=>r.tenant===id(6)));assert.deepEqual(f.writes,[]);assert.deepEqual(f.authWrites,[]);assert.deepEqual(f.unexpected,[]);
      }finally{await h.close();}
    });
    await t.test('missing issuer makes no issued GET; installed but torn options503 stays an error without legacy fallback',async()=>{
      const absent=fixture({capability:false}),a=await mount(absent);try{await inventory(a);assert.ok(a.container.querySelector('.warehouse-wz-issued').textContent.includes('Odczyt zapisanych automatycznych WZ nie jest dostępny.'));await tick();assert.equal(absent.reads.filter(r=>r.path.startsWith('/warehouse-wz-issued')).length,0);assert.deepEqual(absent.writes,[]);assert.deepEqual(absent.unexpected,[]);}finally{await a.close();}
      const f=fixture();f.torn=true;const h=await mount(f);try{await inventory(h);await until(()=>h.container.querySelector('.warehouse-wz-issued [role="alert"]')?.textContent.includes('Niepełna instalacja WZ168'),'Actual ApiError503 visible');assert.equal(h.container.querySelector('.wwi-detail'),null);assert.equal(f.reads.filter(r=>r.path.startsWith('/warehouse-wz-issued/documents')).length,0);assert.deepEqual(f.writes,[]);assert.deepEqual(f.unexpected,[]);}finally{await h.close();}
    });
  }finally{try{for(const h of mounts)if(h.container.isConnected)await h.close();}finally{if(vite)await vite.close();dom.window.HTMLElement.prototype.scrollIntoView=oldScroll;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;dom.window.HTMLAnchorElement.prototype.click=oldClick;globalThis.fetch=oldFetch;dom.window.close();for(const[key,d]of descriptors)if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}}
});
