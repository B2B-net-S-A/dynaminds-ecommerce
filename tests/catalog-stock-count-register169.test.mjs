import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

// Actual ReactDOM component and api(), controlled HTTP only. These tests do not
// establish SQL provenance, cursor encryption, Chrome acceptance or file export.
const id=n=>`${String(n).padStart(8,'0')}-1690-4169-8169-169169169169`;
const tenant=id(1),user=id(2),context=`${tenant}:${user}:admin:false`;
const at='2026-10-07T12:34:56.123456Z',warehouse={id:id(10),name:'Magazyn zapisany',code:'OLD'};
function savedHead(n,{on=false,kind='RW',rows=101,quantity=String(rows)}={}){
  return{id:id(1000+n),receipt_id:id(20+n),source_id:id(100+n),execution_id:id(200+n),protocol:on?'stock_file':'inventory_bulk',
    warehouse_id:warehouse.id,warehouse:structuredClone(warehouse),kind,number:`${kind}/2026/${String(n+1).padStart(6,'0')}`,
    year:2026,sequence:String(n+1),series_id:id(kind==='RW'?11:12),row_count:rows,quantity,wms_enabled:on,
    created_at:new Date(Date.parse(at)-n*1000).toISOString()};
}
function savedRows(head){return Array.from({length:head.row_count},(_,ordinal)=>({id:id(3000+ordinal),ordinal,document_id:head.id,
  warehouse_id:head.warehouse_id,product_id:id(13),sku:'SAME-SKU',name:'Zapisana pozycja '+ordinal,location:'BIN-'+ordinal,
  delta:head.kind==='RW'?-1:1,quantity:'1',bin_movement_id:head.wms_enabled?null:id(4000+ordinal),
  layer_movement_id:head.wms_enabled?id(5000+ordinal):null,source_index:head.wms_enabled?ordinal:null,
  stocktake_line_id:head.wms_enabled?id(6000+ordinal):null,stocktake_posting_id:head.wms_enabled?id(14):null,
  lot_id:head.wms_enabled?id(7000+ordinal):null,layer_id:head.wms_enabled?id(8000+ordinal):null}));}
function fixture({headers=51,rows=101,on=false,kind='RW'}={}){
  const f={calls:[],user,tenant,role:'admin',readOnly:false,available:true,headers:[],rows:new Map(),hold:null};
  f.headers=Array.from({length:headers},(_,n)=>savedHead(n,{rows,on,kind}));
  for(const h of f.headers)f.rows.set(h.id,savedRows(h));
  const flags=()=>({available:f.available,read_only:f.readOnly,current_role:f.role,can_read:true,can_read_value:false,value_state:'not_projected',snapshot_at:at});
  f.fetch=async(url,init={})=>{
    const u=new URL(String(url),'http://127.0.0.1'),method=init.method??'GET',p=u.pathname;
    f.calls.push({method,path:p,query:u.search,workspace:init.headers?.['X-Workspace-ID']});
    assert.equal(method,'GET','Read-only register must never mutate, retry or acknowledge');
    if(p==='/api/auth/me')return Response.json({user:{id:f.user,tenant_id:f.tenant,role:f.role}});
    assert(p==='/api/catalog-stock-control/count-documents'||/^\/api\/catalog-stock-control\/count-documents\/[a-f0-9-]+$/.test(p),'Only genuine register paths');
    if(f.status)return Response.json({detail:f.status===503?'Uszkodzony moduł COUNT':'Utracono prawo odczytu'},{status:f.status});
    const q=u.searchParams;assert.equal(q.get('limit'),'50');
    let body;
    if(p==='/api/catalog-stock-control/count-documents'){
      const filtered=f.headers.filter(h=>(!q.get('warehouse_id')||h.warehouse_id===q.get('warehouse_id'))&&
        (!q.get('kind')||h.kind===q.get('kind'))&&(!q.get('protocol')||h.protocol===q.get('protocol')));
      const offset=q.get('cursor')?50:0,data=f.available?structuredClone(filtered.slice(offset,offset+50)):[];
      if(f.duplicateList&&offset&&data.length)data[0]=structuredClone(filtered[0]);
      body={...flags(),data,meta:{limit:50,cursor:f.badCursor?'':f.available&&offset+data.length<filtered.length?'opaque_headers_2':null}};
    }else{
      const docId=p.split('/').at(-1),head=f.headers.find(h=>h.id===docId);assert(head,'Own selected document');
      const all=f.rows.get(docId),token=q.get('cursor'),offset=token==='opaque_rows_3'?100:token?50:0;
      const data=structuredClone(all.slice(offset,offset+50));
      if(f.badSign&&data.length)data[0].delta=-data[0].delta;
      if(f.foreignRow&&data.length)data[0].document_id=id(999);
      if(f.duplicateRows&&offset&&data.length)data[0]=structuredClone(all[0]);
      if(f.badQuantity&&offset===100&&data.length){data[0].quantity='2';data[0].delta=head.kind==='RW'?-2:2;}
      if(f.costLeak&&data.length)data[0].unit_cost_minor='PRIVATE_COST_DO_NOT_SHOW';
      body={...flags(),document:structuredClone(head),data,meta:{limit:50,total:head.row_count,
        cursor:offset+data.length<all.length?(offset===0?'opaque_rows_2':'opaque_rows_3'):null}};
    }
    const reply=Response.json(body);
    if(f.hold?.match(p,u)){const held=f.hold;await new Promise(resolve=>{held.release=resolve;});}
    return reply;
  };
  return f;
}
const tick=()=>act(async()=>{await new Promise(r=>setTimeout(r,0));});
async function until(predicate,label){for(let i=0;i<120;i++){let done;await act(async()=>{await new Promise(r=>setTimeout(r,0));done=predicate();});if(done)return;}assert(predicate(),label);}
function button(h,label){const b=[...h.container.querySelectorAll('button')].find(b=>b.textContent.trim()===label);assert(b,'Actual button '+label);return b;}
async function click(b){assert.equal(b.disabled,false);await act(async()=>{b.click();await new Promise(r=>setTimeout(r,0));});}
function field(h,label){const wrapper=[...h.container.querySelectorAll('label')].find(l=>[...l.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()===label);
  const input=wrapper?.querySelector('input,select');assert(input,label);return input;}
async function value(input,v){const p=input.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;
  await act(async()=>{Object.getOwnPropertyDescriptor(p,'value').set.call(input,v);input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
const detail=h=>h.container.querySelector('section[aria-label^="Wiersze "]');
const listRows=h=>[...h.container.querySelectorAll('section[aria-label="Rejestr dokumentów COUNT"] > table > tbody > tr')];

test('saved COUNT quantity register — actual mounted component, controlled GET only',async t=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1'}),saved=new Map(),oldFetch=globalThis.fetch,mounts=[];
  for(const [k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,
    MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true})){
    saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
  let vite;
  try{
    vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
    const {createRoot}=await import('react-dom/client'),ui=await vite.ssrLoadModule(path.resolve('web/catalog-stock-count-register.tsx')),
      api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
    async function mount(f,props={}){
      globalThis.fetch=f.fetch;api.setWorkspace(f.tenant);
      const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
      const h={container,f,props:{contextKey:context,available:true,readOnly:false,...props},async render(next={}){
        h.props={...h.props,...next};api.setWorkspace(f.tenant);await act(async()=>{root.render(React.createElement(ui.CatalogStockCountRegister,h.props));await new Promise(r=>setTimeout(r,0));});},
        async close(){if(h.closed)return;h.closed=true;if(f.hold?.release){await act(async()=>{f.hold.release();await new Promise(r=>setTimeout(r,0));});}
          await act(async()=>{root.unmount();await new Promise(r=>setTimeout(r,0));});container.remove();}};
      mounts.push(h);await h.render();return h;
    }
    const ready=h=>until(()=>!button(h,'Odśwież').disabled&&h.container.textContent.includes('Wczytano '),'Complete current header page');
    const open=async(h,head)=>{await ready(h);await click(button(h,'Wiersze '+head.number));await until(()=>detail(h)&&!button(h,'Odśwież').disabled,'Current detail page settled');};
    const allGet=f=>assert(f.calls.every(c=>c.method==='GET'&&(c.path==='/api/auth/me'||c.path.startsWith('/api/catalog-stock-control/count-documents'))));

    await t.test('51 headers and all101 rows use distinct opaque pages; saved quantity/sign and native IDs remain complete',async()=>{
      const f=fixture(),h=await mount(f);await ready(h);assert.equal(listRows(h).length,50);
      assert(h.container.textContent.includes('Dostępna jest następna strona.'));await click(button(h,'Więcej dokumentów (do 50)'));
      await until(()=>listRows(h).length===51&&!button(h,'Odśwież').disabled,'Full header list');
      assert(f.calls.some(c=>c.query.includes('cursor=opaque_headers_2')));assert(h.container.textContent.includes('Koniec listy.'));
      await open(h,f.headers[0]);assert.equal(detail(h).querySelectorAll('tbody tr').length,50);assert(detail(h).textContent.includes('Manifest jest jeszcze niepełny.'));
      await click(button(h,'Więcej wierszy (do 50)'));await until(()=>detail(h)?.querySelectorAll('tbody tr').length===100&&!button(h,'Odśwież').disabled,'Second detail page');
      await click(button(h,'Więcej wierszy (do 50)'));await until(()=>detail(h)?.querySelectorAll('tbody tr').length===101&&!button(h,'Odśwież').disabled,'Detail EOF');
      assert(detail(h).textContent.includes('Pełny manifest: −101.'));assert(detail(h).textContent.includes(id(4000)));assert(detail(h).textContent.includes(id(4100)));
      assert.equal(f.calls.filter(c=>c.path===`/api/catalog-stock-control/count-documents/${f.headers[0].id}`).length,3);
      assert(f.calls.some(c=>c.query.includes('cursor=opaque_rows_3')));assert.equal(button(h,'Odśwież').disabled,false);
      assert.equal(h.container.querySelectorAll('a[download],input[type="checkbox"]').length,0);allGet(f);await h.close();
    });
    await t.test('read-only copy preserves exact int64 headings and ON layer/lot identity, with no cost or export request',async()=>{
      const f=fixture({headers:2,rows:3,on:true,kind:'PW'});f.readOnly=true;f.role='viewer';
      f.headers[1].quantity='9007199254740993';const h=await mount(f,{contextKey:`${tenant}:${user}:viewer:true`,readOnly:true});await ready(h);
      assert(h.container.textContent.includes('+9\u00a0007\u00a0199\u00a0254\u00a0740\u00a0993'));assert(h.container.textContent.includes('Środowisko działa w trybie tylko do odczytu.'));
      await open(h,f.headers[0]);assert(detail(h).textContent.includes('Pełny manifest: +3.'));assert(detail(h).textContent.includes('Pomiar partii WMS'));
      assert(detail(h).textContent.includes(id(5000)));assert(detail(h).textContent.includes(id(7000)));assert(!detail(h).textContent.includes(id(4000)));
      assert(!f.calls.some(c=>c.path.includes('/export')||c.query.includes('include_values')));allGet(f);await h.close();
    });
    await t.test('explicit filters issue server query and discard prior page/detail only on apply',async()=>{
      const f=fixture({headers:2,rows:3});f.headers[1]=savedHead(1,{kind:'PW',on:true,rows:3});f.rows.set(f.headers[1].id,savedRows(f.headers[1]));
      const h=await mount(f);await open(h,f.headers[0]);const calls=f.calls.length;
      await value(field(h,'Magazyn (UUID)'),warehouse.id);await value(field(h,'Rodzaj'),'PW');await value(field(h,'Źródło'),'stock_file');
      assert.equal(f.calls.length,calls,'Draft filters do not silently reload');assert(detail(h));await click(button(h,'Pokaż'));await ready(h);
      assert.equal(detail(h),null);assert.equal(listRows(h).length,1);assert(listRows(h)[0].textContent.includes('PW/2026/000002'));
      const request=f.calls.filter(c=>c.path==='/api/catalog-stock-control/count-documents').at(-1);
      assert(request.query.includes('warehouse_id='+warehouse.id));assert(request.query.includes('kind=PW'));assert(request.query.includes('protocol=stock_file'));
      assert(!request.query.includes('cursor='));allGet(f);await h.close();
    });
    await t.test('duplicate headers and malformed cursor fail closed without false empty-list or EOF claims',async()=>{
      const f=fixture(),h=await mount(f);await ready(h);f.duplicateList=true;await click(button(h,'Więcej dokumentów (do 50)'));
      await until(()=>h.container.querySelector('[role="alert"]')&&!button(h,'Odśwież').disabled,'Duplicate page denied');assert.equal(listRows(h).length,0);
      assert(!h.container.textContent.includes('Koniec listy.'));f.duplicateList=false;f.badCursor=true;await click(button(h,'Odśwież'));
      await until(()=>h.container.querySelector('[role="alert"]')&&!button(h,'Odśwież').disabled,'Invalid cursor denied');assert.equal(listRows(h).length,0);
      assert(!h.container.textContent.includes('Brak dokumentów COUNT dla wybranych filtrów.'));allGet(f);await h.close();
    });
    await t.test('foreign row, wrong sign, duplicate page and incorrect EOF quantity reject complete detail rather than truncating',async()=>{
      for(const fault of['foreignRow','badSign','duplicateRows','badQuantity','costLeak']){
        const f=fixture({headers:1}),h=await mount(f);await ready(h);f[fault]=true;await click(button(h,'Wiersze '+f.headers[0].number));
        if(['duplicateRows','badQuantity'].includes(fault)){
          await until(()=>detail(h)&&!button(h,'Odśwież').disabled,'First valid detail page');await click(button(h,'Więcej wierszy (do 50)'));
          if(fault==='badQuantity'){await until(()=>detail(h)?.querySelectorAll('tbody tr').length===100&&!button(h,'Odśwież').disabled,'Second valid detail page');await click(button(h,'Więcej wierszy (do 50)'));}}
        await until(()=>h.container.querySelector('[role="alert"]')&&!button(h,'Odśwież').disabled,'Bad whole manifest refused');
        assert.equal(detail(h),null);assert.equal(listRows(h).length,0);assert(!h.container.textContent.includes('Pełny manifest:'));
        assert(!h.container.textContent.includes('PRIVATE_COST_DO_NOT_SHOW'));allGet(f);await h.close();}
    });
    await t.test('actor and restore transitions hide a held old detail; late actual grant mismatch purges saved heads',async()=>{
      const f=fixture({headers:1,rows:3}),h=await mount(f);await ready(h);
      f.hold={match:p=>p.endsWith('/'+f.headers[0].id)};await click(button(h,'Wiersze '+f.headers[0].number));await until(()=>!!f.hold.release,'Old own detail held');
      const release=f.hold.release;f.hold=null;f.user=id(9);f.role='operator';f.headers[0].warehouse.name='Nowe własne konto';
      await h.render({contextKey:`${tenant}:${f.user}:operator:false`});assert.equal(detail(h),null);await ready(h);
      await act(async()=>{release();await new Promise(r=>setTimeout(r,0));});assert.equal(detail(h),null);assert(!h.container.textContent.includes('Magazyn zapisany'));
      await open(h,f.headers[0]);assert(detail(h));f.readOnly=true;await h.render({contextKey:`${tenant}:${f.user}:operator:true`,readOnly:true});assert.equal(detail(h),null);await ready(h);
      await open(h,f.headers[0]);f.role='viewer';await click(button(h,'Odśwież'));
      await until(()=>h.container.querySelector('[role="alert"]')&&!button(h,'Odśwież').disabled,'Fresh auth role loss denied');assert.equal(detail(h),null);assert.equal(listRows(h).length,0);
      allGet(f);await h.close();
    });
    await t.test('absent module, genuine empty list,503 and403 remain distinct and cannot trigger writes or cached fallback',async()=>{
      const absent=fixture({headers:0}),hAbsent=await mount(absent,{available:false});await tick();assert(hAbsent.container.textContent.includes('nie jest dostępny w tym środowisku'));assert.equal(absent.calls.length,0);await hAbsent.close();
      const legacy=fixture({headers:0});legacy.available=false;const hLegacy=await mount(legacy);await until(()=>hLegacy.container.textContent.includes('nie jest zainstalowany'),'Actual absent schema reply');
      assert(!hLegacy.container.textContent.includes('Brak dokumentów COUNT dla wybranych filtrów.'));allGet(legacy);await hLegacy.close();
      const empty=fixture({headers:0}),hEmpty=await mount(empty);await until(()=>hEmpty.container.textContent.includes('Same przesunięcia lokalizacji nie tworzą PW/RW.'),'Genuine empty count result');allGet(empty);await hEmpty.close();
      for(const status of[503,403]){const f=fixture({headers:1,rows:3}),h=await mount(f);await open(h,f.headers[0]);f.status=status;await click(button(h,'Odśwież'));
        await until(()=>h.container.querySelector('[role="alert"]')&&!button(h,'Odśwież').disabled,'Actual HTTP denial');assert.equal(detail(h),null);assert.equal(listRows(h).length,0);
        assert(!h.container.textContent.includes('Brak dokumentów COUNT dla wybranych filtrów.'));allGet(f);await h.close();}
    });
  }finally{
    for(const h of mounts)await h.close();await vite?.close();globalThis.fetch=oldFetch;
    for(const [k,d]of saved)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];dom.window.close();
  }
});
