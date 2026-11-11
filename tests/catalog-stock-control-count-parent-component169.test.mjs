import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React,{act} from 'react';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';

// Actual native history screens with controlled read-only HTTP. This verifies
// parent integration; genuine086/115 journal and permission proof is separate.
const id=n=>`${String(n).padStart(8,'0')}-1690-4169-8169-169169169169`;
const context=`${id(1)}:${id(2)}:admin:false`,sourceId=id(3),executionId=id(4),warehouseId=id(5),productId=id(6);
const warehouse={id:warehouseId,name:'Magazyn odczytu',code:'RD'};
const created_at='2026-10-07T12:34:56.123Z',hash='a'.repeat(64);
function heads(protocol){return ['RW','PW'].map((kind,n)=>({id:id(20+n),receipt_id:id(22),source_id:sourceId,protocol,
  warehouse_id:warehouseId,kind,number:`${kind}/2026/000001`,year:2026,sequence:'1',series_id:id(23+n),
  row_count:1,quantity:n===0?'2':'3',wms_enabled:false,created_at}));}
const model=(quantity,version,location='A-01')=>({exists:true,present:true,stock_version:version,
  warehouse_on_hand:version==='4'?8:9,warehouse_reserved:0,location,quantity,reserved:0,available:quantity,
  bins:[{location:'A-01',quantity:version==='4'?4:2,reserved:0,available:version==='4'?4:2},
    {location:'B-02',quantity:version==='4'?4:7,reserved:0,available:version==='4'?4:7}]});
const bulkExecution={id:executionId,preview_id:sourceId,state:'done',scope_hash:hash,total:2,changed:2,unchanged:0,created_at,
  stock_count_documents:heads('inventory_bulk')};
const bulkPreview={id:sourceId,warehouse_id:warehouseId,note:'Zapisany pomiar obu lokalizacji',scope_hash:hash,
  total:2,changed:2,unchanged:0,invalid:0,conflicts:0,ready:true,created_at};
const bulkRows=['A-01','B-02'].map((location,index)=>({index,product_id:productId,sku:'SAME-SKU',location,
  operation:'count',status:'changed',before:model(4,'4',location),after:model(index===0?2:7,'6',location),
  before_stock_version:'4',after_stock_version:'6',operation_ids:[id(30+index)]}));
const summary={source_rows:2,products:1,positions:2,changed:2,unchanged:0,invalid:0,conflicts:0,skipped:0};
const definition={format:'csv',xml_mode:'positions',delimiter:';',identity:'sku',identity_field:'SKU',spreadsheet_safe:false,empty_policy:'skip'};
const fileExecution={id:executionId,preview_id:sourceId,client_key:id(7),file_name:'zapisany-pomiar.csv',source_hash:hash,scope_hash:hash,
  definition,note:'Historyczny wynik odczytu',summary,created_at,can_execute:false,policy:{enabled:false,version:'0',currency:null},
  targets:[{warehouse_id:warehouseId,warehouse_name:warehouse.name,quantity_scope:'position',mapping:{quantity:'Q',location:'LOC'},
    default_location:null,summary:{positions:2,changed:2,unchanged:0,invalid:0,conflicts:0},valuation:null}],
  links:[{warehouse_id:warehouseId,mode:'off',core_preview_id:id(8),core_execution_id:id(9)}],stock_count_documents:heads('stock_file')};
const fileRows=['A-01','B-02'].map((location,index)=>({index,source_index:index,raw_cells:null,
  resolution:{identity:'sku',value:'SAME-SKU',matched_historical_sku:null},product_id:productId,sku:'SAME-SKU',name:'Zapisany produkt',
  warehouse_id:warehouseId,warehouse_name:warehouse.name,location,lot:null,input:{operation:'count',quantity:index===0?2:7},
  before:model(4,'4',location),after:model(index===0?2:7,'6',location),fragments:null,valuation:null,status:'changed',errors:[]}));
const documentSection=h=>h.container.querySelector('section[aria-label="Dokumenty rozliczenia pomiaru"]');
const flags=s=>({available:true,read_only:s.readOnly,current_role:s.role,can_read:true,can_write:false,can_read_value:false});
const limits={file_bytes:1048576,request_bytes:1572864,source_rows:500,products:500,warehouses:8,positions:4000,
  expanded_layers:10000,quantity:1000000,page:50,profiles:100,history_per_tenant:2000};

test('genuine bulk/file history parents display saved count documents — controlled GET only',async t=>{
  const dom=new JSDOM('<!doctype html><body></body>',{url:'http://127.0.0.1'}),previous=new Map(),oldFetch=globalThis.fetch,mounts=[];
  for(const [name,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,
    HTMLElement:dom.window.HTMLElement,DOMException:dom.window.DOMException,IS_REACT_ACT_ENVIRONMENT:true})){
    previous.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});}
  let vite,current;
  globalThis.fetch=async(url,init={})=>{
    assert(current,'HTTP belongs to an active parent fixture');const u=new URL(String(url),'http://127.0.0.1');
    const method=init.method??'GET';current.calls.push({method,path:u.pathname,query:u.search});assert.equal(method,'GET','History never writes or acknowledges');
    const f=flags(current),p=u.pathname;let body;
    if(p==='/api/inventory-bulk-edit')body={...f,warehouses:[warehouse],limits:{products:500,rows:500,page:50,body_bytes:786432,selection_products:500}};
    else if(p==='/api/inventory-bulk-edit/executions')body={...f,data:current.empty?[]:[bulkExecution],meta:{cursor:null}};
    else if(p===`/api/inventory-bulk-edit/executions/${executionId}`)body={...f,execution:bulkExecution};
    else if(p===`/api/inventory-bulk-edit/executions/${executionId}/rows`)body={...f,data:bulkRows,meta:{cursor:null}};
    else if(p===`/api/inventory-bulk-edit/previews/${sourceId}`)body={...f,preview:bulkPreview};
    else if(p==='/api/stock-file-imports/options')body={...f,warehouses:[warehouse],limits,policy:{enabled:false,version:'0',currency:null},next_cursor:null};
    else if(p==='/api/stock-file-imports/executions')body={...f,data:current.empty?[]:[fileExecution],total:current.empty?0:1,next_cursor:null};
    else if(p===`/api/stock-file-imports/executions/${executionId}`)body={...f,execution:fileExecution};
    else if(p===`/api/stock-file-imports/executions/${executionId}/rows`)body={...f,rows:fileRows,total:2,next_cursor:null};
    else throw Error(`Unexpected history GET ${p}${u.search}`);
    if(current.holdOptions&&(p==='/api/inventory-bulk-edit'||p==='/api/stock-file-imports/options'))await new Promise(resolve=>current.release=resolve);
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
    const {createRoot}=await import('react-dom/client');
    const bulk=await vite.ssrLoadModule(path.resolve('web/inventory-bulk-edit.tsx'));
    const file=await vite.ssrLoadModule(path.resolve('web/stock-file-import.tsx'));
    async function wait(h,predicate,label){for(let i=0;i<100;i++){
      let ok=false;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));ok=predicate();});if(ok)return;
    }throw Error(`${label}: ${h.container.textContent}`);}
    function button(h,text){const b=[...h.container.querySelectorAll('button')].find(x=>x.textContent.trim()===text);assert(b,`Actual button ${text}`);assert(!b.disabled,`${text} enabled`);return b;}
    async function click(h,text){await act(async()=>{button(h,text).click();await new Promise(resolve=>setTimeout(resolve,0));});}
    async function mount(Component,props){const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
      const h={container,props,async render(next={}){h.props={...h.props,...next};await act(async()=>{root.render(React.createElement(Component,h.props));await new Promise(resolve=>setTimeout(resolve,0));});},
        async close(){await act(async()=>{root.unmount();await new Promise(resolve=>setTimeout(resolve,0));});container.remove();}};
      mounts.push(h);await h.render();return h;}
    const assertDocuments=h=>{const s=documentSection(h);assert(s,'Count heading section is rendered by actual native parent');
      const rows=[...s.querySelectorAll('tbody tr')];assert.equal(rows.length,2);assert(s.textContent.includes('PW/2026/000001'));
      assert(s.textContent.includes('RW/2026/000001'));assert(s.textContent.includes(warehouse.name));};

    await t.test('InventoryBulkEdit saved execution history opens actual PW/RW and purges on actor and restore transitions',async()=>{
      current={calls:[],role:'admin',readOnly:false,empty:false,holdOptions:false};let changed=0;
      const h=await mount(bulk.InventoryBulkEdit,{contextKey:context,productIds:[productId],readOnly:false,externalWriteBlocked:true,
        onClose(){},onChanged(){changed++;},initialTab:'history'});
      await wait(h,()=>!!h.container.querySelector('.ibe-history button:not(:disabled)'),'bulk history ready');
      await click(h,'Pokaż trwały wynik');await wait(h,()=>!!documentSection(h),'bulk saved documents');assertDocuments(h);
      assert(h.container.textContent.includes('Wczytano 2 z 2 wierszy.'));assert.equal(changed,0,'History is not a write receipt');
      for(const [nextContext,readOnly,role]of[[`${id(40)}:${id(41)}:operator:false`,false,'operator'],[`${id(40)}:${id(41)}:operator:true`,true,'operator']]){
        current.role=role;current.readOnly=readOnly;current.empty=true;current.holdOptions=true;
        await h.render({contextKey:nextContext,readOnly});assert.equal(documentSection(h),null);
        assert(!h.container.textContent.includes('PW/2026/000001'));assert(current.release,'Own current options request held');
        await act(async()=>{current.holdOptions=false;current.release();await new Promise(resolve=>setTimeout(resolve,0));});
        await wait(h,()=>h.container.textContent.includes('Brak wykonanych partii'),'new own bulk empty history');
        assert.equal(documentSection(h),null);current.empty=false;await click(h,'Odśwież historię');
        await wait(h,()=>!!h.container.querySelector('.ibe-history button:not(:disabled)'),'fresh own bulk history');
        await click(h,'Pokaż trwały wynik');await wait(h,()=>!!documentSection(h),'fresh own bulk documents');assertDocuments(h);
      }
      assert.equal(changed,0);assert(current.calls.some(c=>c.path===`/api/inventory-bulk-edit/previews/${sourceId}`));
      assert(current.calls.every(c=>c.method==='GET'&&c.path.startsWith('/api/inventory-bulk-edit')));await h.close();
    });

    await t.test('StockFileImportWorkspace history reads full native execution with documents and clears old actor/copy heads without writes',async()=>{
      current={calls:[],role:'admin',readOnly:false,empty:false,holdOptions:false};let applied=0;
      const h=await mount(file.StockFileImportWorkspace,{contextKey:context,readOnly:false,externalWriteBlocked:true,onApplied(){applied++;}});
      await wait(h,()=>[...h.container.querySelectorAll('button')].some(b=>b.textContent.trim()==='Historia'&&!b.disabled),'file options ready');
      await click(h,'Historia');await click(h,'Odczytaj historię');
      await wait(h,()=>!!h.container.querySelector('.sfi-history button:not(:disabled)'),'file saved history');
      await act(async()=>{h.container.querySelector('.sfi-history button').click();await new Promise(resolve=>setTimeout(resolve,0));});
      await wait(h,()=>h.container.textContent.includes('Odczytano 2 / 2 pozycji'),'complete native file rows');assertDocuments(h);
      assert.equal(applied,0,'Read history cannot acknowledge any retained import');
      for(const [nextContext,readOnly,role]of[[`${id(50)}:${id(51)}:operator:false`,false,'operator'],[`${id(50)}:${id(51)}:operator:true`,true,'operator']]){
        current.role=role;current.readOnly=readOnly;current.empty=true;current.holdOptions=true;
        await h.render({contextKey:nextContext,readOnly});assert.equal(documentSection(h),null);assert(!h.container.textContent.includes('RW/2026/000001'));
        assert(current.release);await act(async()=>{current.holdOptions=false;current.release();await new Promise(resolve=>setTimeout(resolve,0));});
        await wait(h,()=>[...h.container.querySelectorAll('button')].some(b=>b.textContent.trim()==='Odczytaj historię'&&!b.disabled),'new own file options ready');
        await click(h,'Odczytaj historię');await wait(h,()=>h.container.textContent.includes('Brak zapisanych pozycji tego rodzaju.'),'new own file empty history');
        assert.equal(documentSection(h),null);current.empty=false;await click(h,'Odczytaj historię');
        await wait(h,()=>!!h.container.querySelector('.sfi-history button:not(:disabled)'),'fresh own file history');
        await act(async()=>{h.container.querySelector('.sfi-history button').click();await new Promise(resolve=>setTimeout(resolve,0));});
        await wait(h,()=>h.container.textContent.includes('Odczytano 2 / 2 pozycji'),'fresh full file rows');assertDocuments(h);
      }
      assert.equal(applied,0);assert(current.calls.some(c=>c.path===`/api/stock-file-imports/executions/${executionId}/rows`));
      assert(current.calls.every(c=>c.method==='GET'&&c.path.startsWith('/api/stock-file-imports')));await h.close();
    });
  }finally{
    for(const h of mounts)if(h.container.isConnected)await h.close();await vite?.close();dom.window.close();globalThis.fetch=oldFetch;
    for(const[name,descriptor]of previous)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
  }
});
