/** Actual tax-facts decoders and the local invoice panel with tax facts; controlled fetch only, no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const amounts=(g,r)=>{const d=100n+BigInt(r),v=(2n*BigInt(g)*BigInt(r)+d)/(2n*d);return{gross_minor:String(g),net_minor:String(BigInt(g)-v),vat_minor:String(v)};};
const address={street:'Testowa 1',postal_code:'00-001',city:'Warszawa',country:'PL'};
const seller={name:'Sprzedawca',...address,tax_id:'5260250274'};
const series={id:id(8),version:1,created_at:'2026-10-16T10:00:00.000Z',name:'Lokalna',prefix:'FV',seller,payment_terms_days:14,payment_instructions:'Przelew',notes:'Uwagi',seller_vat_status:'active_domestic'};
const order={id:id(1),version:'6',status:'shipped',currency:'PLN'};
const buyer={name:'Jan Klient',street:'Kliencka 2',postal_code:'00-002',city:'Kraków'};
function snapshot(){
 const lines=[{kind:'item',item_id:id(4),product_id:id(14),name:'Produkt 4',sku:'SKU-4',quantity:2,unit:'szt.',unit_gross_minor:'1000',discount_gross_minor:'0',rounding_gross_minor:'0',vat_rate:23,...amounts(2000,23)},
  {kind:'shipping',item_id:null,product_id:null,name:'Dostawa',sku:'',quantity:1,unit:'usł.',unit_gross_minor:'1500',discount_gross_minor:'0',rounding_gross_minor:'0',vat_rate:23,...amounts(1500,23)}];
 const totals=lines.reduce((a,l)=>({gross_minor:String(BigInt(a.gross_minor)+BigInt(l.gross_minor)),net_minor:String(BigInt(a.net_minor)+BigInt(l.net_minor)),vat_minor:String(BigInt(a.vat_minor)+BigInt(l.vat_minor))}),{gross_minor:'0',net_minor:'0',vat_minor:'0'});
 return{order:{id:order.id,version:'6',number:'ZAM-1',status:'shipped',currency:'PLN',total_minor:'3500',shipping_cost_minor:'1500',payment_mode:'prepaid'},seller,
  buyer:{kind:'consumer',tax_id:'',name:buyer.name,email:'jan@example.test',address:{street:buyer.street,postal_code:buyer.postal_code,city:buyer.city,country:'PL'}},
  series:{id:series.id,name:series.name,prefix:series.prefix,payment_terms_days:14,payment_instructions:'Przelew',notes:'Uwagi'},currency:'PLN',lines,totals,vat_totals:[{vat_rate:23,...totals}],
  rounding_method:'gross_line_half_up',tax_regime:'ordinary_domestic',consumer_sale_confirmed:true,no_special_tax_procedure_confirmed:true,not_fiscal_receipt_confirmed:true,sell_date:'2026-10-16',issue_date:'2026-10-16',due_date:'2026-10-30',year:2026};
}
const scopeHash='a'.repeat(64),previewId=id(20),documentId=id(30);
const preview=()=>({id:previewId,order_id:order.id,order_version:'6',series_id:series.id,scope_hash:scopeHash,expires_at:'2099-01-01T00:00:00.000Z',created_at:'2026-10-16T10:00:00.000Z',can_issue:true,issued_document_id:null,snapshot:snapshot()});
const base={exemption_basis_kind:null,exemption_basis:null,np_kind:null,gtu:null,annex15:false,profile_version:null};
const itemLine=(extra={})=>({line_no:1,kind:'item',item_id:id(4),product_id:id(14),sku:'SKU-4',name:'Produkt 4',category:'standard',rate:'23.00',rate_code:'23',...base,gtu:'GTU_06',profile_version:2,...extra});
const shipLine={line_no:2,kind:'shipping',item_id:null,product_id:null,sku:'',name:'Dostawa',category:'standard',rate:'23.00',rate_code:'23',...base};
const facts=(lines=[itemLine(),shipLine],extra={})=>({buyer_kind:'consumer',buyer_country:'PL',procedure:'domestic',oss_country:null,gross_minor:'3500',annex15_gross_minor:'0',mpp_required:false,mpp_reason:'Brak towarów i usług z załącznika nr 15',lines,...extra});
const zwLine=itemLine({category:'zw',rate:null,rate_code:'zw',exemption_basis_kind:'P_19A',exemption_basis:'art. 43 ust. 1 pkt 18 ustawy o VAT'});
const zwBlocker='SKU-4: zwolnienie ZW — lokalna FV liczy dziś tylko zwykłe stawki 0/5/8/23%, wystawienie wstrzymane';
const flags={available:true,read_only:false,current_role:'admin',can_read:true,can_write:true,can_create_series:true};
const access={readOnly:false,role:'admin'};

test('local invoice tax facts: decoders, preview gate and issue through tax-issue',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom');
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),{LocalInvoicePanel}=await vite.ssrLoadModule(path.resolve('web/local-invoices.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const m=await vite.ssrLoadModule(path.resolve('web/local-invoice-tax.tsx'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn,note){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),note);}
 let handles=[],fx;
 function reset(mode){fx={mode,posts:[],gets:[],documentTax:null};globalThis.fetch=async(url,init={})=>{
  const route=new URL(String(url),'http://127.0.0.1').pathname,method=init.method??'GET';
  if(route==='/api/auth/me')return Response.json({user:{id:id(2),tenant_id:id(1),role:'admin'},restore_preview:false});
  if(route==='/api/local-invoices/options')return Response.json({...flags,scope:{countries:['PL'],currencies:['PLN'],vat_rates:[0,5,8,23],buyer_kinds:['consumer'],source_statuses:['shipped','delivered'],b2b_state:'not_supported',ksef_state:'not_submitted',fiscalized:false}});
  if(route==='/api/local-invoices/series'&&method==='GET')return Response.json({...flags,data:[series],next_cursor:null});
  if(route==='/api/local-invoices/documents'&&method==='GET')return Response.json({...flags,data:[],next_cursor:null});
  if(method==='GET')fx.gets.push(route);
  if(route===`/api/local-invoices/previews/${previewId}/tax`){
   if(fx.mode==='missing')return Response.json({detail:'Model podatkowy (migracja 226) jest niedostępny w tej kopii'},{status:503});
   if(fx.mode==='zw')return Response.json({...flags,preview_id:previewId,facts:facts([zwLine,shipLine]),blockers:[zwBlocker]});
   if(fx.mode==='foreign')return Response.json({...flags,preview_id:previewId,facts:facts([itemLine({sku:'OBCY'}),shipLine]),blockers:[]});
   return Response.json({...flags,preview_id:previewId,facts:facts(),blockers:[]});
  }
  if(route===`/api/local-invoices/documents/${documentId}/tax`)return Response.json({...flags,document_id:documentId,...(fx.mode==='missing'?{tax:null,note:'Faktura wystawiona bez migawki podatkowej 226 (inna ścieżka wystawienia lub przed migracją).'}:{tax:{...facts(),captured_with_issue:true,captured_at:'2026-10-16T10:05:00.000Z'},note:null})});
  assert.equal(method,'POST',route);const body=JSON.parse(init.body);fx.posts.push([route,body]);
  if(route===`/api/local-invoices/orders/${order.id}/previews`)return Response.json({...flags,preview:preview()},{status:201});
  assert(route===`/api/local-invoices/previews/${previewId}/tax-issue`||route===`/api/local-invoices/previews/${previewId}/issue`,route);
  const data={...snapshot(),number:'FV/2026/000001',preview_id:previewId,scope_hash:scopeHash,local_only:true,ksef_state:'not_submitted',fiscalized:false};
  const document={id:documentId,order_id:order.id,number:'FV/2026/000001',kind:'invoice',mode:'local_invoice',data,created_at:'2026-10-16T10:05:00.000Z'};
  const receipt={id:id(31),document_id:documentId,preview_id:previewId,series_id:series.id,year:2026,sequence:1,number:'FV/2026/000001',scope_hash:scopeHash,created_at:'2026-10-16T10:05:00.000Z'};
  return Response.json({...flags,document,receipt,reused:false,...(route.endsWith('/tax-issue')?{tax:fx.mode==='bad-issue-tax'?null:{...facts(),captured_with_issue:true,captured_at:'2026-10-16T10:05:00.000Z'}}:{})},{status:201});
 };api.setWorkspace(id(1));}
 const buttons=(el,text)=>[...el.querySelectorAll('button')].filter(b=>b.textContent===text);
 const field=(el,label)=>[...el.querySelectorAll('label')].find(l=>l.textContent.startsWith(label)).querySelector('input,select');
 async function set(input,value){await React.act(async()=>{const proto=input.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
 async function click(e){assert(e&&!e.disabled);await React.act(async()=>e.click());}
 async function prepare(){
  const el=document.createElement('div');document.body.append(el);const root=createRoot(el);handles.push({el,root});
  await React.act(async()=>root.render(React.createElement(LocalInvoicePanel,{order,contextKey:`${id(1)}:${id(2)}:admin:false`,readOnly:false,refresh:0})));
  await until(()=>el.querySelector('.local-invoices-fields')&&!el.querySelector('.local-invoices-fields').disabled&&el.querySelector('.local-invoices-fields option[value="'+series.id+'"]'),'preview form');
  await set(field(el,'Seria'),series.id);
  for(const[label,value]of [['Nabywca — imię i nazwisko',buyer.name],['Ulica i numer',buyer.street],['Kod pocztowy',buyer.postal_code],['Miejscowość',buyer.city],['Data sprzedaży','2026-10-16']])await set(field(el,label),value);
  for(const label of ['Potwierdzam sprzedaż','Sprzedaż podlega','Ta faktura nie jest'])await click(field(el,label));
  await click(buttons(el,'Sprawdź pełną fakturę')[0]);await until(()=>el.querySelector('.local-invoices-review'),'preview shown');return el;
 }
 const issue=el=>buttons(el,'Wystaw lokalną fakturę')[0],consent=el=>field(el,'Sprawdziłem pełne dane');
 try{
  await t.test('decoders accept exact facts and refuse foreign, inconsistent or silent-blocker data',()=>{
   const p=preview();assert.deepEqual(m.readLocalInvoiceTaxFacts({...flags,preview_id:previewId,facts:facts(),blockers:[]},p,access).blockers,[]);
   const zw=m.readLocalInvoiceTaxFacts({...flags,preview_id:previewId,facts:facts([zwLine,shipLine]),blockers:[zwBlocker]},p,access);assert.equal(zw.facts.lines[0].rate_code,'zw');
   const refused=m.readLocalInvoiceTaxFacts({...flags,preview_id:previewId,facts:facts([shipLine]),blockers:['SKU-4: odmowa']},p,access);assert.equal(refused.facts.lines.length,1);
   const bad=[
    v=>v.preview_id=id(99),v=>v.read_only=true,v=>v.current_role='operator',v=>v.available=false,v=>v.blockers=[''],v=>v.blockers='x',
    v=>v.facts.lines=[shipLine],v=>v.facts.lines=[zwLine,shipLine],v=>v.facts.mpp_required=true,
    v=>v.facts.lines[0].sku='OBCY',v=>v.facts.lines[0].item_id=id(98),v=>v.facts.lines[0].rate='8.00',v=>v.facts.lines[0].rate_code='8',v=>v.facts.lines[0].gtu='GTU_14',
    v=>v.facts.lines[0].exemption_basis='art. 43',v=>v.facts.lines[1].annex15=true,v=>v.facts.lines[1].gtu='GTU_01',v=>v.facts.lines[0].line_no=2,v=>v.facts.lines.reverse(),
    v=>v.facts.gross_minor='3501',v=>v.facts.buyer_country='DE',v=>v.facts.procedure='oss',v=>v.facts.annex15_gross_minor='2000',v=>v.facts.mpp_reason='',
    v=>v.facts.lines[0]={...zwLine,exemption_basis:'  '},v=>v.facts.lines[0]={...zwLine,exemption_basis_kind:'P_19D'},
   ];
   for(const mutate of bad){const v=structuredClone({...flags,preview_id:previewId,facts:facts(),blockers:[]});mutate(v);assert.throws(()=>m.readLocalInvoiceTaxFacts(v,p,access),/obce dane podatkowe/,String(mutate));}
   const annex={...flags,preview_id:previewId,facts:facts([itemLine({annex15:true}),shipLine],{annex15_gross_minor:'2000'}),blockers:[]};assert.equal(m.readLocalInvoiceTaxFacts(annex,p,access).facts.annex15_gross_minor,'2000');
   const oss={...flags,preview_id:previewId,facts:facts([itemLine({rate:'19.00',rate_code:'oss'}),{...shipLine,rate:'19.00',rate_code:'oss'}],{procedure:'oss',oss_country:'PL'}),blockers:[]};assert.equal(m.readLocalInvoiceTaxFacts(oss,p,access).facts.procedure,'oss');
   const doc={id:documentId,data:snapshot()},snap={...facts(),captured_with_issue:true,captured_at:'2026-10-16T10:05:00.000Z'};
   assert.equal(m.readLocalInvoiceDocumentTax({...flags,document_id:documentId,tax:snap,note:null},doc,access).tax.lines.length,2);
   assert.equal(m.readLocalInvoiceDocumentTax({...flags,document_id:documentId,tax:null,note:'Bez migawki'},doc,access).note,'Bez migawki');
   for(const v of [{...flags,document_id:id(99),tax:snap,note:null},{...flags,document_id:documentId,tax:null,note:null},{...flags,document_id:documentId,tax:snap,note:'x'},{...flags,document_id:documentId,tax:{...snap,lines:[snap.lines[0]]},note:null},{...flags,document_id:documentId,tax:{...snap,captured_at:'wczoraj'},note:null}])
    assert.throws(()=>m.readLocalInvoiceDocumentTax(v,doc,access),/obce dane podatkowe/);
   assert.equal(m.taxRateLabel({rate:'19.00',rate_code:'oss'}),'OSS 19,00%');assert.equal(m.taxRateLabel({rate:'0.00',rate_code:'0 KR'}),'0% (KR)');assert.equal(m.taxRateLabel({rate:null,rate_code:'np I'}),'np I');
  });
  await t.test('ZW line: facts table and blocker alert; consent and issue stay disabled, nothing is issued',async()=>{
   reset('zw');const el=await prepare();await until(()=>el.querySelector('.local-invoice-tax [role="alert"]'),'blocker');
   const tax=el.querySelector('[aria-label="Dane podatkowe podglądu"]').textContent;for(const part of ['Zwolnienie ZW','P_19A — przepis ustawy/rozporządzenia: art. 43 ust. 1 pkt 18','GTU_06','MPP: nie dotyczy','Procedura: krajowa','wystawienie wstrzymane'])assert(tax.includes(part),part);
   assert(consent(el).disabled);assert(issue(el).disabled);assert.equal(fx.posts.length,1);
  });
  await t.test('standard lines: issue goes through tax-issue with the native body and the detail shows the stored snapshot',async()=>{
   reset('ok');const el=await prepare();await until(()=>el.querySelector('[aria-label="Dane podatkowe podglądu"] table'),'facts');
   assert(!el.querySelector('.local-invoice-tax [role="alert"]'));await click(consent(el));await click(issue(el));
   await until(()=>el.querySelector('.local-invoices-detail [aria-label="Dane podatkowe faktury"] table'),'document tax');
   const [route,body]=fx.posts.at(-1);assert.equal(route,`/api/local-invoices/previews/${previewId}/tax-issue`);assert.deepEqual(Object.keys(body).sort(),['client_key','confirmed','local_only','scope_hash']);assert.equal(body.scope_hash,scopeHash);
   const text=el.querySelector('.local-invoices-detail').textContent;assert(text.includes('Faktura FV/2026/000001'));assert(text.includes('migawka z wystawienia'));assert(text.includes('przy wystawieniu'));assert(fx.gets.includes(`/api/local-invoices/documents/${documentId}/tax`));
   assert(!el.querySelector('.local-invoices-pending'),'attempt acknowledged');
  });
  await t.test('a tax-issue answer without the snapshot is not acknowledged; the attempt stays pending',async()=>{
   reset('bad-issue-tax');const el=await prepare();await until(()=>el.querySelector('[aria-label="Dane podatkowe podglądu"] table'),'facts');
   await click(consent(el));await click(issue(el));await until(()=>el.querySelector('.local-invoices-pending'),'pending');assert(!el.querySelector('.local-invoices-detail'));
   const pending=buttons(el,'Sprawdź ten sam zapis faktury')[0];fx.mode='ok';await click(pending);await until(()=>el.querySelector('.local-invoices-detail'),'retry acknowledged');
   const [first,second]=fx.posts.slice(-2);assert.equal(fx.posts.length,3);assert.equal(first[0],`/api/local-invoices/previews/${previewId}/tax-issue`);assert.deepEqual(second,first,'retry repeats the exact attempt');
  });
  await t.test('foreign facts are refused with an alert and keep the issue disabled',async()=>{
   reset('foreign');const el=await prepare();await until(()=>el.querySelector('.local-invoice-tax [role="alert"]'),'refusal');
   assert.match(el.querySelector('.local-invoice-tax [role="alert"]').textContent,/obce dane podatkowe/);assert(issue(el).disabled);assert(buttons(el,'Odśwież dane podatkowe').length===1);
  });
  await t.test('without migration 226 the screen keeps working: notice, native issue path, document note',async()=>{
   reset('missing');const el=await prepare();await until(()=>el.textContent.includes('Model podatkowy niedostępny w tej kopii'),'notice');
   await click(consent(el));await click(issue(el));await until(()=>el.querySelector('.local-invoices-detail'),'issued');
   assert.equal(fx.posts.at(-1)[0],`/api/local-invoices/previews/${previewId}/issue`);await until(()=>el.querySelector('.local-invoices-detail').textContent.includes('bez migawki podatkowej'),'note');
  });
 }finally{for(const h of handles){await React.act(async()=>h.root.unmount());h.el.remove();}globalThis.fetch=oldFetch;await vite.close();dom.window.close();for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
});
