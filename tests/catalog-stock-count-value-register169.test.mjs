import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Controlled real component/API; no claim about SQL authority or native downloaded bytes.
const id = n => `${String(n).padStart(8,'0')}-1690-4169-8169-169169169169`, tenant = id(1), user = id(2);
const base = '/api/catalog-stock-control/count-documents', context = `${tenant}:${user}:admin:false`;
const at = '2026-10-07T12:34:56.123456+00:00';
function fixture(count = 101, on = true) {
  const f = { calls: [], role: 'admin', tenant, user, readOnly: false, grant: true, blobs: [], hold: null };
  f.head = { id:id(3), receipt_id:id(4), source_id:id(5), execution_id:id(6), protocol:on?'stock_file':'inventory_bulk',
    warehouse_id:id(7), warehouse:{id:id(7),name:'Zapisany magazyn',code:'OLD'},kind:'RW',number:'RW/2026/000001',year:2026,
    sequence:'1',series_id:id(8),row_count:count,quantity:String(count),wms_enabled:on,created_at:at };
  f.rows = Array.from({length:count},(_,ordinal)=>({id:id(1000+ordinal),ordinal,document_id:f.head.id,warehouse_id:id(7),
    product_id:id(9),sku:'SAME',name:'Zapisana pozycja '+ordinal,location:'BIN-A',delta:-1,quantity:'1',
    bin_movement_id:on?null:id(2000+ordinal),layer_movement_id:on?id(3000+ordinal):null,source_index:on?ordinal:null,
    stocktake_line_id:on?id(4000+ordinal):null,stocktake_posting_id:on?id(10):null,lot_id:on?id(5000+ordinal):null,layer_id:on?id(6000+ordinal):null,
    ...(on?{cost_state:ordinal%3===1?'unknown':'known',unit_cost_minor:ordinal%3===1?null:ordinal%3===0?'0':'1000',
      value_minor:ordinal%3===1?null:ordinal%3===0?'0':'1000',currency:'PLN',exponent:2}:{})}));
  const costs=['cost_state','unit_cost_minor','value_minor','currency','exponent'];
  const quantityRow=r=>Object.fromEntries(Object.entries(r).filter(([k])=>!costs.includes(k)));
  const valuation=()=>{const buckets=new Map();for(const r of f.rows){if(!on)break;const key=r.currency+':'+r.exponent;
    const b=buckets.get(key)??{currency:r.currency,exponent:r.exponent,known_quantity:0n,zero_cost_quantity:0n,unknown_quantity:0n,known_value_minor:0n};
    if(r.cost_state==='unknown')b.unknown_quantity++;else{b.known_quantity++;if(r.unit_cost_minor==='0')b.zero_cost_quantity++;b.known_value_minor+=BigInt(r.value_minor);}buckets.set(key,b);}
    return{state:on?f.rows.some(r=>r.cost_state==='unknown')?'partial_unknown':'complete':'unavailable_off',physical_quantity:String(count),
      buckets:[...buckets.values()].map(b=>({...Object.fromEntries(Object.entries(b).map(([k,v])=>[k,typeof v==='bigint'?String(v):v])),signed_known_value_minor:String(-b.known_value_minor)}))};};
  const flags=value=>({available:true,read_only:f.readOnly,current_role:f.role,can_read:true,can_read_value:value,value_state:value?valuation().state:'not_projected',snapshot_at:at});
  f.file=(format,values)=>{
    const selected=values&&on, fields=['record_type','document_id','receipt_id','source_id','execution_id','protocol','number','kind','series_id','year','sequence',
      'created_at','warehouse_id','warehouse_name','warehouse_code','wms_enabled','row_count','quantity','value_state','ordinal','row_id','product_id','sku','name','location','delta',
      'bin_movement_id','layer_movement_id','source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id',
      ...(selected?['cost_state','unit_cost_minor','value_minor','currency','exponent','known_quantity','zero_cost_quantity','unknown_quantity','known_value_minor','signed_known_value_minor']:[])];
    const state=on?selected?valuation().state:'not_requested':'unavailable_off';
    const common={document_id:f.head.id,receipt_id:f.head.receipt_id,source_id:f.head.source_id,execution_id:f.head.execution_id,
      protocol:f.head.protocol,number:f.head.number,kind:'RW',series_id:f.head.series_id,year:2026,sequence:'1',created_at:at,
      warehouse_id:id(7),wms_enabled:on,value_state:state};
    let content;
    if(format==='csv'){
      const records=[{...common,record_type:'document',warehouse_name:f.head.warehouse.name,warehouse_code:f.head.warehouse.code,row_count:count,quantity:String(count)},
        ...(selected?valuation().buckets.map(b=>({...common,...b,record_type:'valuation',quantity:String(BigInt(b.known_quantity)+BigInt(b.unknown_quantity))})):[]),
        ...f.rows.map(r=>({...common,...(selected?r:quantityRow(r)),record_type:'row',row_id:r.id}))];
      if(f.badFile==='bucket'&&selected)records.find(r=>r.record_type==='valuation').known_value_minor='999';
      if(f.badFile==='rowname')records.find(r=>r.record_type==='row').name='FOREIGN RECORDED NAME';
      if(f.badFile==='private')fields.push('nonce');
      content=[fields,...records.map(r=>fields.map(k=>r[k]??''))].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
    }else{const escape=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;');const nodes=o=>Object.entries(o).map(([k,v])=>v===null?`<${k} nil="true"/>`:
      `<${k}>${Array.isArray(v)?v.map(b=>'<bucket>'+nodes(b)+'</bucket>').join(''):typeof v==='object'?nodes(v):escape(v)}</${k}>`).join('');
      content=`<?xml version="1.0"?><count_document version="1"><document>${nodes(f.head)}</document>${selected?'<valuation>'+nodes(valuation())+'</valuation>':''}<rows>`
        +f.rows.map(r=>'<row>'+nodes(selected?r:quantityRow(r))+'</row>').join('')+'</rows></count_document>';
      if(f.badFile==='bucket')content=content.replace(/<known_value_minor>[^<]*<\/known_value_minor>/,'<known_value_minor>999</known_value_minor>');
      if(f.badFile==='rowname')content=content.replace('Zapisana pozycja 0','FOREIGN RECORDED NAME');
      if(f.badFile==='private')content=content.replace('</row>','<nonce>private</nonce></row>');}
    return{document:structuredClone(f.head),format,filename:`RW-count-${f.head.id}.${format}`,content_type:format==='csv'?'text/csv; charset=utf-8':'application/xml; charset=utf-8',
      content,values_included:selected,row_count:count,value_state:on?selected?valuation().state:'not_requested':'unavailable_off',...(selected?{valuation:valuation()}:{}),
      available:true,read_only:f.readOnly,current_role:f.role,can_read:true,can_read_value:f.grant,snapshot_at:at};
  };
  f.fetch=async(url,init={})=>{const u=new URL(String(url),'http://local'),p=u.pathname,q=u.searchParams;f.calls.push({method:init.method??'GET',p,q:u.search});assert.equal(init.method??'GET','GET');
    if(p==='/api/auth/me')return Response.json({user:{id:f.user,tenant_id:f.tenant,role:f.role}});
    assert(p===base||p.startsWith(base+'/'+f.head.id),'Only actual COUNT paths');let reply;
    if(p.endsWith('/export')){if(q.get('include_values')==='true'&&!f.grant)return Response.json({detail:'Wycena niedostępna'},{status:403});reply=f.file(q.get('format'),q.get('include_values')==='true');if(f.badExport)reply[f.badExport]=f.badExport==='filename'?'foreign.csv':f.badExport==='row_count'?1:'text/plain';}
    else if(p===base)reply={...flags(false),data:[structuredClone(f.head)],meta:{limit:50,cursor:null}};
    else{const value=p.endsWith('/value');if(value&&(!f.grant||f.role!=='admin'))return Response.json({detail:'Wycena niedostępna'},{status:403});
      const limit=Number(q.get('limit')),offset=q.get('cursor')?Number(q.get('cursor').split('_').at(-1)):0;
      const rows=structuredClone(f.rows.slice(offset,offset+limit)).map(value?r=>r:quantityRow);
      if(f.badValue&&value&&rows.length)rows[0].value_minor='999';
      reply={...flags(value),document:structuredClone(f.head),...(value?{valuation:valuation()}:{}),data:rows,
        meta:{limit,total:count,cursor:offset+rows.length<count?`opaque_${offset+rows.length}`:null}};}
    const response=Response.json(reply);if(f.hold?.match(p,q)){const held=f.hold;await new Promise(resolve=>{held.release=resolve;});}return response;};
  return f;
}
async function until(check,label){for(let n=0;n<150;n++){let done;await act(async()=>{await new Promise(r=>setTimeout(r,0));done=check();});if(done)return;}assert(check(),label);}
const button=(h,label)=>{const b=[...h.container.querySelectorAll('button')].find(b=>b.textContent.trim()===label);assert(b,label);return b;};
async function click(b){assert.equal(b.disabled,false);await act(async()=>{b.click();await new Promise(r=>setTimeout(r,0));});}
async function change(input,value){await act(async()=>{if(input.type==='checkbox')input.click();else{Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('change',{bubbles:true}));}await new Promise(r=>setTimeout(r,0));});}

test('COUNT value register controlled actual DOM',async t=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://local'}),saved=new Map(),oldFetch=globalThis.fetch,mounts=[];
  for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,DOMParser:dom.window.DOMParser,IS_REACT_ACT_ENVIRONMENT:true})){
    saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL,oldClick=dom.window.HTMLAnchorElement.prototype.click;let current,vite;
  URL.createObjectURL=blob=>{current.blobs.push(blob);return'blob:controlled-count';};URL.revokeObjectURL=()=>{};dom.window.HTMLAnchorElement.prototype.click=function(){current.download={filename:this.download,href:this.href};};
  try{vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
    const ui=await vite.ssrLoadModule(path.resolve('web/catalog-stock-count-register.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts')),{createRoot}=await import('react-dom/client');
    async function mount(f,props={}){current=f;globalThis.fetch=f.fetch;api.setWorkspace(f.tenant);const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
      const h={container,props:{contextKey:context,available:true,readOnly:false,...props},async render(next={}){h.props={...h.props,...next};api.setWorkspace(f.tenant);await act(async()=>{root.render(React.createElement(ui.CatalogStockCountRegister,h.props));await new Promise(r=>setTimeout(r,0));});},
        async close(){if(h.closed)return;h.closed=true;if(f.hold?.release)await act(async()=>{f.hold.release();await new Promise(r=>setTimeout(r,0));});await act(async()=>{root.unmount();await new Promise(r=>setTimeout(r,0));});container.remove();}};mounts.push(h);await h.render();return h;}
    const ready=h=>until(()=>h.container.textContent.includes('Wczytano ')&&!button(h,'Odśwież').disabled,'Actual current quantity page');
    const open=async(h,f)=>{await ready(h);await click(button(h,'Wiersze '+f.head.number));await until(()=>h.container.querySelector('section[aria-label^="Wiersze "]')&&!button(h,'Odśwież').disabled,'Quantity detail');};
    const value=async h=>{await click(button(h,'Pokaż wycenę dokumentu'));await until(()=>h.container.querySelector('[aria-label="Historyczna wycena dokumentu"]')&&!button(h,'Odśwież').disabled,'Complete value manifest');};
    await t.test('explicit value opt-in fetches all101 rows and distinct opaque pages; quantities alone never fetch cost',async()=>{const f=fixture(),h=await mount(f);await open(h,f);assert(!f.calls.some(c=>c.p.endsWith('/value')));await value(h);
      assert.equal(f.calls.filter(c=>c.p.endsWith('/value')).length,3);assert(f.calls.some(c=>c.q.includes('cursor=opaque_100')));
      const section=h.container.querySelector('[aria-label="Historyczna wycena dokumentu"]');assert.equal(section.querySelectorAll('tbody tr').length,101);
      assert(section.textContent.includes('0,00 PLN'));assert(section.textContent.includes('Koszt nieznany'));assert(section.textContent.includes('−330,00 PLN'));
      assert.equal(h.container.querySelector('input[type="checkbox"]').checked,false);await h.close();});
    await t.test('full CSV/XML exports require selected identity and fresh before/after reads, with default no values',async()=>{const f=fixture(3),h=await mount(f);await open(h,f);
      for(const format of['csv','xml']){const select=[...h.container.querySelectorAll('label')].find(l=>l.textContent.startsWith('Format pliku')).querySelector('select');await change(select,format);
        await click(button(h,'Pobierz cały dokument'));await until(()=>f.blobs.length===(format==='csv'?1:2)&&!button(h,'Odśwież').disabled,'Whole-file controlled Blob');assert.equal(f.download.filename,`RW-count-${f.head.id}.${format}`);assert.equal(await f.blobs.at(-1).text(),f.file(format,false).content);}
      assert(f.calls.filter(c=>c.p.endsWith('/export')).every(c=>c.q.includes('include_values=false')));await value(h);await change(h.container.querySelector('input[type="checkbox"]'),true);
      await click(button(h,'Pobierz cały dokument'));await until(()=>f.blobs.length===3&&!button(h,'Odśwież').disabled,'Explicit value export');assert(f.calls.some(c=>c.p.endsWith('/export')&&c.q.includes('include_values=true')));await h.close();});
    await t.test('value grant lost after held export purges money and prevents Blob while quantity detail remains readable',async()=>{const f=fixture(3),h=await mount(f);await open(h,f);await value(h);await change(h.container.querySelector('input[type="checkbox"]'),true);
      f.hold={match:p=>p.endsWith('/export')};
      await click(button(h,'Pobierz cały dokument'));await until(()=>f.hold.release,'Actual export held');f.grant=false;await act(async()=>{f.hold.release();await new Promise(r=>setTimeout(r,0));});
      await until(()=>h.container.querySelector('[role="alert"]')&&!button(h,'Odśwież').disabled,'Fresh value grant refusal');assert.equal(f.blobs.length,0);assert.equal(h.container.querySelector('[aria-label="Historyczna wycena dokumentu"]'),null);assert.equal(h.container.querySelector('input[type="checkbox"]'),null);await h.close();});
    await t.test('actor/restore change during held value read prevents any cached financial publication',async()=>{const f=fixture(3),h=await mount(f);await open(h,f);f.hold={match:p=>p.endsWith('/value')};await click(button(h,'Pokaż wycenę dokumentu'));await until(()=>f.hold.release,'Value held');
      f.role='viewer';f.readOnly=true;await h.render({contextKey:`${tenant}:${user}:viewer:true`,readOnly:true});await act(async()=>{f.hold.release();await new Promise(r=>setTimeout(r,0));});await ready(h);
      assert.equal(h.container.querySelector('[aria-label="Historyczna wycena dokumentu"]'),null);assert(!h.container.textContent.includes('10,00 PLN'));assert.equal(f.blobs.length,0);await h.close();});
    await t.test('OFF truthful unavailable values and malformed/foreign download responses never produce partial files',async()=>{const f=fixture(3,false),h=await mount(f);await open(h,f);await value(h);assert(h.container.textContent.includes('pomiar wykonano bez partii WMS'));
      assert.equal(h.container.querySelector('input[type="checkbox"]').disabled,true);f.badExport='filename';await click(button(h,'Pobierz cały dokument'));await until(()=>h.container.querySelector('[role="alert"]')&&!button(h,'Odśwież').disabled,'Foreign filename denied');assert.equal(f.blobs.length,0);await h.close();
      const corrupt=fixture(3),other=await mount(corrupt);await open(other,corrupt);corrupt.badValue=true;await click(button(other,'Pokaż wycenę dokumentu'));await until(()=>other.container.querySelector('[role="alert"]')&&!button(other,'Odśwież').disabled,'Invalid monetary row denied');assert.equal(other.container.querySelector('[aria-label="Historyczna wycena dokumentu"]'),null);assert.equal(corrupt.blobs.length,0);await other.close();});
    await t.test('forged CSV/XML buckets, full recorded row identity or private fields refuse download despite a correct envelope',async()=>{
      for(const format of['csv','xml'])for(const fault of['bucket','rowname','private']){const f=fixture(3),h=await mount(f);await open(h,f);await value(h);
        await change([...h.container.querySelectorAll('label')].find(l=>l.textContent.startsWith('Format pliku')).querySelector('select'),format);
        await change(h.container.querySelector('input[type="checkbox"]'),true);f.badFile=fault;await click(button(h,'Pobierz cały dokument'));
        await until(()=>h.container.querySelector('[role="alert"]')&&!button(h,'Odśwież').disabled,'Whole-file forged frame refused');
        assert.equal(f.blobs.length,0);assert(!h.container.textContent.includes('Pobrano cały dokument'));await h.close();}});
    await t.test('restored admin reads saved value with actual JPY0/KWD3 precision; all interactions remain GET',async()=>{
      const f=fixture(3);f.readOnly=true;f.rows[0].currency='JPY';f.rows[0].exponent=0;
      for(const r of f.rows.slice(1)){r.currency='KWD';r.exponent=3;}
      const h=await mount(f,{contextKey:`${tenant}:${user}:admin:true`,readOnly:true});await open(h,f);await value(h);
      const section=h.container.querySelector('[aria-label="Historyczna wycena dokumentu"]');assert(section.textContent.includes('0 JPY'));assert(section.textContent.includes('−1,000 KWD'));
      await click(button(h,'Pobierz cały dokument'));await until(()=>f.blobs.length===1&&!button(h,'Odśwież').disabled,'Restored quantity export');assert(f.calls.every(c=>c.method==='GET'));await h.close();});
  }finally{for(const h of mounts)await h.close();await vite?.close();URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;dom.window.HTMLAnchorElement.prototype.click=oldClick;globalThis.fetch=oldFetch;for(const[k,v]of saved)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];dom.window.close();}
});
