import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import React, { act, StrictMode } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { PDFDocument } from 'pdf-lib';

// Real ReactDOM batch/manual components, API helper, shared registry and SHA validation.
// Only the PDF canvas renderer is replaced with an explicit bounded four-page stub.
// This is neither PDF.js rendering/visual evidence nor a database/queue integration test.
const id = n => `${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`;
const tenant=id(1), user=id(2), context=`${tenant}:${user}:admin:false`;
const station={id:id(3),version:'1',code:'QA149',label:'QA149 station',enabled:true};
const printer={id:id(4),version:'1',station_id:station.id,name:'QA149 file printer',format:'pdf',output_mode:'file',cups_queue:null,enabled:true};
const flags={available:true,read_only:false,current_role:'admin',can_read:true,can_write:true,can_manage:true};
const options={...flags,batch_available:true,stations:[station],printers:[printer],limits:{}};
const orders=[id(10),id(11)], shipments=[id(20),id(21)];
const digest=v=>createHash('sha256').update(v).digest('hex');
const prefix='/api/print-jobs/label-batches';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const rendererStub=`
import React,{useEffect,useRef,useState} from 'react';
export function PrintLabelPdfPreview(p) {
 const identity=p.contextKey+':'+p.previewId+':'+p.contentSha256;
 const seen=useRef(new Set());const [count,setCount]=useState(0);
 globalThis.__qaBatchCanvas={previewId:p.previewId,hash:p.contentSha256,data:p.data,maxBytes:p.maxBytes,maxPages:p.maxPages};
 useEffect(()=>{seen.current.clear();setCount(0);p.onReady({previewId:p.previewId,contentSha256:p.contentSha256,ready:false,pageCount:4,viewedPages:0});},[identity,p.data]);
 return React.createElement('section',{'data-qa-canvas':'bounded-render-stub'},
  React.createElement('p',null,'Kontrolowany stub canvas: '+count+' z 4 stron'),
  ...[1,2,3,4].map(page=>React.createElement('button',{key:page,onClick:()=>{seen.current.add(page);setCount(seen.current.size);p.onReady({previewId:p.previewId,contentSha256:p.contentSha256,ready:seen.current.size===4,pageCount:4,viewedPages:seen.current.size});}},'Wyrenderuj stronę '+page)));
}
`;
async function pdf(pages,label) {
  const doc=await PDFDocument.create();
  for(let i=0;i<pages;i++)doc.addPage([297.64,419.53]).drawText(`${label} ${i+1}`);
  return Buffer.from(await doc.save({useObjectStreams:false}));
}
async function fixture() {
  const source=[await pdf(2,'source one'),await pdf(2,'source two')], combined=await pdf(4,'combined review');
  const rows=orders.map((order,i)=>({index:i,shipment_id:shipments[i],order_id:order,order_number:`QA149-${i+1}`,order_version:String(3+i),cache_asset_id:id(30+i),child_preview_id:id(40+i),child_scope_hash:digest('child'+i),tracking_number:`QA149-TRACK-${i+1}`,provider:'inpost',mode:'sandbox',layout:'A6',source_hash:digest('source'+i),content_sha256:digest(source[i]),content_bytes:source[i].length,pages:2,page_from:i*2+1,page_to:i*2+2}));
  const preview={id:id(50),kind:'preview',scope_hash:digest('batch scope'),created_at:new Date().toISOString(),expires_at:new Date(Date.now()+900000).toISOString(),station_snapshot:station,printer_snapshot:printer,copies:1,summary:{shipments:2,orders:2,source_pages:4,combined_pages:4,copies:1,expected_label_copies:2},combined_pdf:{format:'pdf',content_sha256:digest(combined),content_bytes:combined.length,pages:4,layout:'A6'},rows,queued_execution_id:null,can_queue:true};
  const execution={id:id(60),kind:'execution',preview_id:preview.id,scope_hash:preview.scope_hash,summary:preview.summary,created_at:new Date().toISOString(),rows:rows.map((r,i)=>({...r,job_id:id(70+i),job_create_event_id:id(80+i)})),progress:rows.map((r,i)=>({index:i,job_id:id(70+i),state:'queued',version:'1'}))};
  return {preview,execution,combined,rows,requests:[],currentContext:context,corruptContent:false,dropQueueOnce:false,commits:0,queueBody:null,holdOrder:null,holdOptions:null,
    async fetch(url,init={}) {
      const method=init.method??'GET', body=init.body===undefined?null:JSON.parse(init.body);
      this.requests.push({url,method,body,serialized:init.body,workspace:init.headers?.['X-Workspace-ID']});
      const actor=this.currentContext.split(':');
      if(url==='/api/auth/me')return Response.json({user:{tenant_id:actor[0],id:actor[1],role:actor[2]}});
      if(url===prefix+'/options') { if(this.holdOptions){const h=this.holdOptions;this.holdOptions=null;await h.promise;}return Response.json(options); }
      if(url==='/api/print-jobs/options')return Response.json({...flags,stations:[station],limits:{}});
      if(url==='/api/print-jobs/printers')return Response.json({...flags,printers:[printer],next_cursor:null});
      for(const [i,order] of orders.entries()) {
        if(url==='/api/orders/'+order) { if(this.holdOrder){const h=this.holdOrder;this.holdOrder=null;await h.promise;}return Response.json({id:order,number:`QA149-${i+1}`,version:String(3+i),shipments:[{id:shipments[i],tracking_number:rows[i].tracking_number,carrier:'InPost ShipX'}]}); }
        if(url==='/api/print-jobs/shipments/'+shipments[i]+'/label-cache')return Response.json({...flags,cache:{id:rows[i].cache_asset_id,shipment_id:shipments[i],order_id:order,provider:'inpost',mode:'sandbox',tracking_number:rows[i].tracking_number,format:'pdf',layout:'A6',content_sha256:rows[i].content_sha256,content_bytes:rows[i].content_bytes,source_hash:rows[i].source_hash},order_version:String(3+i),source_hash:rows[i].source_hash,can_queue:true,unavailable_reason:null});
      }
      if(url===prefix+'/previews' && method==='POST')return Response.json({...flags,preview,reused:false},{status:201});
      if(url===prefix+'/previews/'+preview.id+'/content') {
        const bytes=this.corruptContent?Buffer.from(combined):combined;if(this.corruptContent)bytes[bytes.length-2]^=1;
        return Response.json({...flags,preview_id:preview.id,format:'pdf',content_base64:bytes.toString('base64'),content_sha256:preview.combined_pdf.content_sha256,content_bytes:combined.length,pages:4});
      }
      if(url===prefix+'/previews/'+preview.id+'/queue' && method==='POST') {
        if(this.queueBody)assert.equal(init.body,this.queueBody,'Exact retry must retain the serialized body AND client key.');
        else {this.queueBody=init.body;this.commits++;}
        if(this.dropQueueOnce){this.dropQueueOnce=false;throw new TypeError('Controlled lost ACK after committed mock receipt');}
        const reused=this.requests.filter(r=>r.method==='POST' && r.url.endsWith('/queue')).length>1;
        return Response.json({...flags,execution,reused},{status:reused?200:201});
      }
      if(url===prefix+'/executions/'+execution.id)return Response.json({...flags,execution});
      if(url===prefix+'/previews/'+preview.id)return Response.json({...flags,preview:{...preview,queued_execution_id:this.commits?execution.id:null,can_queue:!this.commits}});
      if(url.startsWith(prefix+'/history?'))return Response.json({...flags,data:this.commits?[{id:execution.id,kind:'execution',preview_id:preview.id,scope_hash:preview.scope_hash,summary:preview.summary,created_at:execution.created_at}]:[],next_cursor:null});
      throw Error('Unexpected controlled component request: '+method+' '+url);
    }};
}
async function tick() {await act(async()=>{await new Promise(r=>setTimeout(r,0));});}
async function until(predicate,message) {for(let i=0;i<60;i++){if(predicate())return;await tick();}assert.ok(predicate(),message);}
function button(container,label){const found=[...container.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(found,`Missing button: ${label}`);return found;}
async function click(element){assert.equal(element.disabled,false,'The intended real DOM control must be enabled.');await act(async()=>{element.dispatchEvent(new MouseEvent('click',{bubbles:true}));});}
async function select(element,value){await act(async()=>{element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));});}
function checkbox(container,label){const found=[...container.querySelectorAll('label')].find(l=>l.textContent.includes(label))?.querySelector('input[type=checkbox]');assert.ok(found,`Missing checkbox: ${label}`);return found;}
async function prepare(h,f) {
  await until(()=>button(h.container,'Odczytaj dostęp do partii').disabled===false,'Initial current options must load.');
  await click(button(h.container,'Odczytaj przesyłki wybranych zamówień'));
  await until(()=>h.container.querySelectorAll('input[aria-label^="Wybierz przesyłkę"]').length===2,'Both cached source choices must be complete.');
  for(const choice of h.container.querySelectorAll('input[aria-label^="Wybierz przesyłkę"]'))await click(choice);
  const selectors=h.container.querySelectorAll('.slb-grid select');await select(selectors[0],station.id);await select(selectors[1],printer.id);
  await click(button(h.container,'Przygotuj pełny podgląd partii'));
  await until(()=>h.container.querySelector('.slb-review') && button(h.container,'Odczytaj cały wspólny PDF').disabled===false,'Saved preview must load without hidden queue.');
  const request=f.requests.find(r=>r.method==='POST' && r.url===prefix+'/previews');
  assert.deepEqual(request.body.shipments,f.rows.map(r=>({shipment_id:r.shipment_id,order_version:r.order_version,asset_id:r.cache_asset_id})));
  assert.equal(f.requests.filter(r=>r.method==='POST').length,1,'Preparing must not acquire labels or queue jobs.');
}
async function review(h) {
  await click(button(h.container,'Odczytaj cały wspólny PDF'));
  await until(()=>h.container.querySelector('[data-qa-canvas]'),'Verified bytes must reach the explicitly stubbed renderer.');
  for(let page=1;page<=4;page++)await click(button(h.container,'Wyrenderuj stronę '+page));
  await click(checkbox(h.container,'Sprawdziłem wszystkie źródła'));
  await click(checkbox(h.container,'Potwierdzam zapis wszystkich zadań'));
}

test('real batch component: complete consent, exact uncertain retry, actor fences',async t=>{
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1/'}), descriptors=new Map();
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true,__qaBatchCanvas:null})) {
    descriptors.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const originalFetch=globalThis.fetch;
  const vite=await createServer({server:{middlewareMode:true,hmr:false,watch:null},appType:'custom',logLevel:'error',plugins:[{name:'qa149-bounded-canvas-stub',enforce:'pre',transform(code,file){if(file.split('?')[0].endsWith('/web/print-label-pdf-preview.tsx'))return {code:rendererStub,map:null};}}]});
  const {createRoot}=await import('react-dom/client');
  const mod=await vite.ssrLoadModule(path.resolve('web/shipment-label-batches.tsx'));
  const shared=await vite.ssrLoadModule(path.resolve('web/print-jobs.tsx'));
  const apiModule=await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounted=[];
  function mount(f,{selectedOrderIds=orders,contextKey=context,sibling=false,strict=false}={}) {
    globalThis.fetch=f.fetch.bind(f);apiModule.setWorkspace(contextKey.split(':')[0]);
    const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
    const h={container,root,async render(next={}){const props={selectedOrderIds,contextKey,readOnly:false,onOpenOrder(){throw Error('No browser navigation in component harness.');},...next};const children=React.createElement(React.Fragment,null,React.createElement(mod.ShipmentLabelBatchPanel,props),sibling?React.createElement(shared.PrintJobsPanel,{contextKey:props.contextKey,readOnly:props.readOnly}):null);await act(async()=>{root.render(strict?React.createElement(StrictMode,null,children):children);});},async close(){await act(async()=>root.unmount());container.remove();}};
    mounted.push(h);return h;
  }
  try {
    await t.test('cached source SHA and all four pages plus manifest are required before one explicit queue',async()=>{
      const f=await fixture(),h=mount(f,{strict:true});await h.render();
      try {
        await prepare(h,f);f.corruptContent=true;
        await click(button(h.container,'Odczytaj cały wspólny PDF'));
        await until(()=>h.container.querySelector('.error')?.textContent.includes('Suma kontrolna wspólnego PDF nie jest zgodna') && !button(h.container,'Odczytaj cały wspólny PDF').disabled,'Corrupt bytes must be rejected by actual component hash check.');
        assert.equal(h.container.querySelector('[data-qa-canvas]'),null);
        assert.equal(button(h.container,'Zapisz całą partię w kolejce').disabled,true);
        f.corruptContent=false;await click(button(h.container,'Odczytaj cały wspólny PDF'));
        await until(()=>h.container.querySelector('[data-qa-canvas]'),'Verified renderer data not received.');
        assert.equal(digest(globalThis.__qaBatchCanvas.data),f.preview.combined_pdf.content_sha256);
        assert.equal(globalThis.__qaBatchCanvas.maxBytes,16777216);assert.equal(globalThis.__qaBatchCanvas.maxPages,500);
        for(let page=1;page<=3;page++)await click(button(h.container,'Wyrenderuj stronę '+page));
        assert.equal(checkbox(h.container,'Sprawdziłem wszystkie źródła').disabled,true);
        assert.equal(checkbox(h.container,'Potwierdzam zapis wszystkich zadań').disabled,true);
        await click(button(h.container,'Wyrenderuj stronę 4'));
        assert.equal(checkbox(h.container,'Sprawdziłem wszystkie źródła').disabled,false);
        assert.equal(checkbox(h.container,'Potwierdzam zapis wszystkich zadań').disabled,true,'Full pages alone are insufficient.');
        await click(checkbox(h.container,'Sprawdziłem wszystkie źródła'));
        assert.equal(button(h.container,'Zapisz całą partię w kolejce').disabled,true,'Manifest alone still requires separate queue consent.');
        await click(checkbox(h.container,'Potwierdzam zapis wszystkich zadań'));
        await click(button(h.container,'Zapisz całą partię w kolejce'));
        await until(()=>h.container.textContent.includes('Zapisana partia'),'Actual component must accept complete receipt.');
        assert.equal(f.commits,1);assert.equal(f.requests.filter(r=>r.url.endsWith('/queue') && r.method==='POST').length,1);
      } finally {await h.close();}
    });
    await t.test('lost queue ACK survives navigation and history read; only exact manual retry releases shared lock',async()=>{
      const f=await fixture(),h=mount(f,{sibling:true});await h.render();let h2;
      try {
        await prepare(h,f);await review(h);f.dropQueueOnce=true;
        await click(button(h.container,'Zapisz całą partię w kolejce'));
        await until(()=>h.container.textContent.includes('Wynik zachowanej próby jest nieznany'),'Lost ACK must retain real registry attempt.');
        const pending=shared.getPrintJobsMutationState(context).pending,serialized=pending.body;
        assert.equal(shared.getPrintJobsMutationState(context).locked,true);assert.equal(f.commits,1);
        assert.ok([...h.container.querySelectorAll('.print-jobs-panel fieldset')].every(e=>e.disabled),'Sibling manual forms must be blocked.');
        await h.close();
        h2=mount(f,{selectedOrderIds:[],sibling:true});await h2.render();
        await until(()=>h2.container.textContent.includes('Wynik zachowanej próby jest nieznany') && !button(h2.container,'Odczytaj zapisane partie').disabled,'Same actor remount must retain attempt.');
        await click(button(h2.container,'Odczytaj zapisane partie'));
        await until(()=>h2.container.querySelector('.slb-history-row'),'Committed mock history receipt must be readable.');
        await click(button(h2.container,'Odczytaj pełne szczegóły'));
        await until(()=>h2.container.textContent.includes('Zapisana partia'),'Exact existing receipt must be readable without releasing uncertainty.');
        assert.equal(shared.getPrintJobsMutationState(context).pending,pending);
        assert.equal(shared.getPrintJobsMutationState(context).locked,true);
        assert.equal(shared.getPrintJobsMutationState(context).pending.body,serialized);
        await click(checkbox(h2.container,'Potwierdzam ręczne ponowienie'));
        await click(button(h2.container,'Ponów dokładnie zachowaną próbę'));
        await until(()=>!shared.getPrintJobsMutationState(context).locked,'Exact validated retry must release lock.');
        const writes=f.requests.filter(r=>r.url.endsWith('/queue') && r.method==='POST');assert.equal(writes.length,2);assert.equal(writes[0].serialized,writes[1].serialized);assert.equal(f.commits,1);
        assert.ok([...h2.container.querySelectorAll('.print-jobs-panel fieldset')].some(e=>!e.disabled),'Known receipt must release sibling fresh-write lock.');
      } finally {if(h.container.isConnected)await h.close();if(h2)await h2.close();shared.resetPrintJobsContext('');}
    });
    await t.test('actor replacement purges state and old read cannot release a newer held read',async()=>{
      const f=await fixture(),h=mount(f);await h.render();
      try {
        await until(()=>!button(h.container,'Odczytaj dostęp do partii').disabled,'Initial access read must finish.');
        const old=deferred(),fresh=deferred();f.holdOrder=old;
        await click(button(h.container,'Odczytaj przesyłki wybranych zamówień'));
        const other=`${id(101)}:${id(102)}:admin:false`;
        f.currentContext=other;f.holdOptions=fresh;apiModule.setWorkspace(id(101));
        await h.render({contextKey:other,selectedOrderIds:[]});
        assert.equal(shared.getPrintJobsMutationState(context).active,false);
        await act(async()=>old.resolve());await tick();
        assert.equal(button(h.container,'Odczytaj dostęp do partii').disabled,true,'Old actor completion must not release new actor read.');
        assert.equal(h.container.querySelector('input[aria-label^="Wybierz przesyłkę"]'),null,'Old actor source/cache choices must not appear.');
        assert.equal(h.container.textContent.includes('QA149-TRACK-'),false);
        await act(async()=>fresh.resolve());await until(()=>!button(h.container,'Odczytaj dostęp do partii').disabled,'New actor explicit scope must complete.');
        assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
      } finally {await h.close();shared.resetPrintJobsContext('');}
    });
  } finally {
    for(const h of mounted)if(h.container.isConnected)await h.close();
    await vite.close();globalThis.fetch=originalFetch;dom.window.close();
    for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  }
});
