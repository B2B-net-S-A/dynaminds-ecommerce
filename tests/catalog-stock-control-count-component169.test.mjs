import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Controlled DTOs rendered by the actual read-only component. No SQL, native
// publisher, saved document rows or browser acceptance is claimed here.
const id = n => `${String(n).padStart(8,'0')}-1690-4169-8169-169169169169`;
const sourceId=id(3), contextKey=`${id(1)}:${id(2)}:admin:false`;
function savedHead(n, extra={}) {
  const kind=n===1?'RW':'PW';
  return { id:id(30+n),receipt_id:id(40),source_id:sourceId,protocol:'stock_file',
    warehouse_id:id(10+n),kind,number:`${kind}/2026/000001`,year:2026,
    sequence:'1',series_id:id(20+n),row_count:n===1?3:2,
    quantity:n===1?'9007199254740993':'3',wms_enabled:true,
    created_at:'2026-10-07T12:34:56.123456Z',...extra };
}
const warehouses=[{id:id(11),name:'Magazyn sprzedaży',code:'SALE'},
  {id:id(12),name:'Drugi magazyn',code:'B'}];
const section=h=>h.container.querySelector('section[aria-label="Dokumenty rozliczenia pomiaru"]');
const cells=row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent);

test('native count PW/RW headings — actual mounted component, controlled read-only DTOs',async t=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1'});
  const previous=new Map(),oldFetch=globalThis.fetch,calls=[],mounts=[];
  for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,
    navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})) {
    previous.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  }
  globalThis.fetch=async(...args)=>{calls.push(args);throw Error('Saved headings must not fetch, mutate or acknowledge');};
  let vite;
  try {
    vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
    const {createRoot}=await import('react-dom/client');
    const ui=await vite.ssrLoadModule(path.resolve('web/catalog-stock-count-documents.tsx'));
    async function mount(documents,extra={}) {
      const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
      const h={container,props:{documents,protocol:'stock_file',sourceId,contextKey,warehouses,...extra},
        async render(next={}){h.props={...h.props,...next};await act(async()=>root.render(React.createElement(ui.CatalogStockCountDocuments,h.props)));},
        async close(){await act(async()=>root.unmount());container.remove();}};
      mounts.push(h);await h.render();return h;
    }
    await t.test('real saved PW/RW numbers and exact int64 quantities render without costs, requests or retry controls',async()=>{
      const heads=[savedHead(1,{unit_cost_minor:'PRIVATE_COST_998877',private_note:'NOT_FOR_THIS_VIEW'}),savedHead(2)];
      const h=await mount(heads),rows=[...section(h).querySelectorAll('tbody tr')];assert.equal(rows.length,2);
      assert.deepEqual(cells(rows[0]).slice(0,4),['RW/2026/000001','Magazyn sprzedaży SALE','9\u00a0007\u00a0199\u00a0254\u00a0740\u00a0993','3']);
      assert.deepEqual(cells(rows[1]).slice(0,4),['PW/2026/000001','Drugi magazyn B','3','2']);
      assert(cells(rows[0])[4].length>0);assert(!h.container.textContent.includes('PRIVATE_COST_998877'));
      assert(!h.container.textContent.includes('NOT_FOR_THIS_VIEW'));
      assert.equal(h.container.querySelectorAll('button,input,form,a').length,0);assert.equal(calls.length,0);await h.close();
    });
    await t.test('old schema absent heads and empty executions stay neutral; genuine bulk OFF headings remain readable',async()=>{
      const h=await mount(undefined);assert.equal(h.container.textContent,'');
      await h.render({documents:[]});assert.equal(h.container.textContent,'');assert.equal(h.container.querySelector('[role="alert"]'),null);
      const bulkId=id(50),head=savedHead(1,{protocol:'inventory_bulk',source_id:bulkId,wms_enabled:false,quantity:'2'});
      await h.render({protocol:'inventory_bulk',sourceId:bulkId,documents:[head],warehouses:[]});
      assert(section(h)?.textContent.includes('RW/2026/000001'));assert.equal(cells(section(h).querySelector('tbody tr'))[1],id(11));
      assert.equal(calls.length,0);await h.close();
    });
    await t.test('foreign source/protocol or any malformed head rejects the whole list rather than showing a valid first document',async()=>{
      const changes=[head=>{head.source_id=id(90);},head=>{head.protocol='inventory_bulk';},head=>{head.warehouse_id='foreign';},
        head=>{head.series_id='not-a-series';},head=>{head.receipt_id=id(91);},head=>{head.wms_enabled=false;},
        head=>{head.number='PW/2026/1';},head=>{head.quantity='9223372036854775808';},head=>{head.quantity='0';},
        head=>{head.row_count=10001;},head=>{head.sequence='01';},head=>{head.created_at='not-a-date';},
        head=>{head.id=id(31);},head=>{head.warehouse_id=id(11);head.kind='RW';head.number='RW/2026/000001';}];
      const h=await mount([]);
      for(const change of changes){const bad=savedHead(2);change(bad);await h.render({documents:[savedHead(1),bad]});
        assert(h.container.querySelector('[role="alert"]')?.textContent.includes('Nie można potwierdzić dokumentów'));
        assert.equal(section(h),null);assert.equal(h.container.querySelectorAll('tbody tr').length,0);
        assert(!h.container.textContent.includes('RW/2026/000001'));assert(!h.container.textContent.includes('PW/2026/000001'));}
      await h.render({documents:Array.from({length:201},(_,n)=>savedHead(n+1))});assert.equal(section(h),null);
      assert(h.container.querySelector('[role="alert"]'));assert.equal(calls.length,0);await h.close();
    });
    await t.test('actor and restore changes purge the retained response synchronously; only a fresh own array restores read-only headings',async()=>{
      const retained=[savedHead(1)],h=await mount(retained);assert(section(h));
      const nextSource=id(60),nextContext=`${id(61)}:${id(62)}:operator:false`;
      await h.render({contextKey:nextContext,sourceId:nextSource});assert.equal(h.container.textContent,'');
      await h.render();assert.equal(h.container.textContent,'','Same retained array cannot revive the previous actor heads');
      await h.render({documents:[savedHead(2,{source_id:nextSource})]});assert(section(h)?.textContent.includes('PW/2026/000001'));
      await h.render({contextKey:`${id(61)}:${id(62)}:operator:true`});assert.equal(section(h),null);
      await h.render({documents:structuredClone(h.props.documents)});assert(section(h));
      assert.equal(h.container.querySelectorAll('button,input,form,a').length,0);assert.equal(calls.length,0);await h.close();
    });
  } finally {
    for(const h of mounts)if(h.container.isConnected)await h.close();await vite?.close();dom.window.close();globalThis.fetch=oldFetch;
    for(const [name,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
  }
});
