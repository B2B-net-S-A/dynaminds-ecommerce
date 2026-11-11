/** FV-S (230) panel and register: form, calculation view, preview and issue bodies, retry, viewer and
 * the issued document; controlled fetch only, no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const NB=' ';
const order={id:id(1),version:'7',status:'shipped',currency:'EUR',customer_name:'Hans Kunde',address:{street:'Hauptstr. 1',postal_code:'10115',city:'Berlin',country:'DE'}};
const series={id:id(8),version:1,name:'Główna',prefix:'FV',created_at:'2026-10-16T10:00:00.000Z'};
const seller={name:'Sprzedawca',street:'Testowa 1',postal_code:'00-001',city:'Warszawa',country:'PL',tax_id:'5260250274'};
const buyerIn={kind:'business',name:'Muster GmbH',address:{street:'Ring 5',postal_code:'20095',city:'Hamburg',country:'DE'},tax_id:'DE123456789',pl_vat_payer:false};
const line=(no,kind,name,sku,gross,extra={})=>({line_no:no,kind,sku,name,category:'np',rate:null,rate_code:'np II',exemption_basis_kind:null,exemption_basis:null,np_kind:'np_ii',gtu:null,annex15:false,profile_version:null,
 gross_minor:gross,net_minor:gross,vat_minor:'0',item_id:kind==='item'?id(4):null,product_id:kind==='item'?id(14):null,quantity:1,unit:kind==='item'?'szt.':'usł.',unit_gross_minor:gross,discount_gross_minor:'0',rounding_gross_minor:'0',vat_rate:23,...extra});
function euSnapshot(){
 return{format:'invoice230/v1',order:{id:order.id,number:'ZAM-7',version:'7',status:'shipped',currency:'EUR',total_minor:'400000',shipping_cost_minor:'0',payment_mode:'prepaid'},seller,
  buyer:{kind:'business',name:buyerIn.name,address:buyerIn.address,tax_id:'DE123456789',tax_id_kind:'eu_vat',pl_vat_payer:false,email:'b@example.test'},
  series:{id:series.id,name:series.name,prefix:'FV',payment_terms_days:14,payment_instructions:'',notes:''},currency:'EUR',
  lines:[line(1,'item','Usługa wdrożenia','SRV-1','400000')],
  categories:[{key:'np II',rate_code:'np II',rate:null,fa3_net:'P_13_9',fa3_vat:null,label:'NP II — art. 100 ust. 1 pkt 4',net_minor:'400000',vat_minor:'0',gross_minor:'400000'}],
  totals:{net_minor:'400000',vat_minor:'0',gross_minor:'400000'},annex15_gross_minor:'400000',procedure:'domestic',reverse_charge:true,exemption:null,
  mpp:{required:true,reason:'Kwota należności powyżej 15 000 zł i towary z załącznika nr 15',gross_pln_minor:'1700000'},
  nbp:{currency:'EUR',tax_point:'2026-10-20',tax_point_basis:'sell_date',rate_date:'2026-10-19',table_no:'203/A/NBP/2026',mid:'4.2500',source:'fetched',
   categories:[{key:'np II',rate_code:'np II',rate:null,fa3_net:'P_13_9',fa3_vat:null,label:'NP II — art. 100 ust. 1 pkt 4',net_minor:'400000',vat_minor:'0',gross_minor:'400000',net_pln_minor:'1700000',vat_pln_minor:'0',gross_pln_minor:'1700000'}],
   totals:{net_pln_minor:'1700000',vat_pln_minor:'0',gross_pln_minor:'1700000'},line:'Kurs NBP z dnia 2026-10-19, tabela 203/A/NBP/2026: 1 EUR = 4,2500 PLN'},
  rounding_method:'gross_line_half_up',sell_date:'2026-10-20',issue_date:'2026-10-23',due_date:'2026-11-06',year:2026,local_only:true,ksef_state:'not_submitted',fiscalized:false};
}
const scopeHash='b'.repeat(64),previewId=id(20),documentId=id(30),number='FV-S/FV/2026/000001';
const doc=(data=euSnapshot())=>({id:documentId,order_id:order.id,number,kind:'invoice',mode:'invoice230',data:{...data,number,preview_id:previewId,scope_hash:scopeHash},created_at:'2026-10-23T10:00:00.000Z'});
const zwDoc=()=>{const s=euSnapshot();return doc({...s,currency:'PLN',nbp:null,reverse_charge:false,mpp:{required:false,reason:'Brak towarów z załącznika nr 15',gross_pln_minor:'123456'},
 exemption:{kind:'P_19A',basis:'art. 43 ust. 1 pkt 18 ustawy o VAT'},lines:[line(1,'item','Usługa medyczna','MED-1','123456',{category:'zw',rate_code:'zw',np_kind:null,exemption_basis_kind:'P_19A',exemption_basis:'art. 43 ust. 1 pkt 18 ustawy o VAT'})],
 categories:[{key:'zw',rate_code:'zw',rate:null,fa3_net:'P_13_7',fa3_vat:null,label:'zwolnione (zw)',net_minor:'123456',vat_minor:'0',gross_minor:'123456'}],totals:{net_minor:'123456',vat_minor:'0',gross_minor:'123456'}});};
const blockers=['Zamówienie ma zwrot — faktura 230 przed zwrotem nie jest obsługiwana','SRV-1: pozycja ma niespójne kwoty'];

test('invoice230 panel and register',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom');
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,DOMParser:dom.window.DOMParser,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),m=await vite.ssrLoadModule(path.resolve('web/invoice230.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn,note){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),note);}
 let handles=[],fx;
 function reset(opts={}){fx={role:'admin',canWrite:true,docs:[],calc:'ok',issue:'ok',posts:[],...opts};globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname,method=init.method??'GET',flags={available:true,read_only:false,current_role:fx.role,can_read:true,can_write:fx.canWrite,can_create_series:false};
  if(route==='/api/invoice230/documents'&&method==='GET'){if(fx.unavailable)return Response.json({detail:'Faktury szczególne (migracja 230) są niedostępne w tej kopii'},{status:503});return Response.json({...flags,data:fx.docs});}
  if(route==='/api/local-invoices/series')return Response.json({...flags,data:[series],next_cursor:null});
  if(route.startsWith('/api/invoice232/')&&method==='GET')return Response.json({detail:'Korekty faktur FV-S (migracja 232) są niedostępne w tej kopii'},{status:503});
  if(route===`/api/ksef229/documents/${documentId}`&&method==='GET')return Response.json({document_id:documentId,submission:fx.ksef??null,rejected:[]});
  if(route===`/api/ksef229/documents/${documentId}/send`&&method==='POST'){fx.posts.push([route,null]);fx.ksef={id:id(40),document_id:documentId,document_kind:'invoice230',document_number:number,nip:'5260250274',environment:'local_fake',state:'accepted',state_label:'Przyjęta w KSeF',
   ksef_number:'5260250274-20261023-0123456789AB-0C',acquisition_at:'2026-10-23T10:05:00.000Z',reference_number:'REF-1',status:{code:200,description:'Sukces',details:[]},upo_available:true,attempts:1,last_error:null,offline:null};
   return Response.json({document_id:documentId,submission:fx.ksef,rejected:[],replayed:false});}
  assert.equal(method,'POST',route);const body=JSON.parse(init.body);fx.posts.push([route,body]);
  if(route===`/api/invoice230/orders/${order.id}/calculate`){const b=fx.calc==='blocked'?blockers:[];return Response.json({...flags,order_id:order.id,order_version:'7',snapshot:euSnapshot(),blockers:b,issuable:!b.length});}
  if(route===`/api/invoice230/orders/${order.id}/previews`){if(!fx.canWrite)return Response.json({detail:'Brak aktualnych uprawnień do faktury'},{status:403});
   return Response.json({...flags,preview:{id:previewId,order_id:order.id,series_id:series.id,order_version:'7',scope_hash:scopeHash,snapshot:euSnapshot(),expires_at:'2099-01-01T00:00:00.000Z',created_at:'2026-10-23T10:00:00.000Z'},issue_path:`/local-invoices/previews/${previewId}/tax-issue`,reused:false},{status:201});}
  assert.equal(route,`/api/local-invoices/previews/${previewId}/tax-issue`);
  if(fx.issue==='network'){fx.issue='ok';throw new TypeError('fetch failed');}
  return Response.json({...flags,document:doc(),record:{series_id:series.id,year:2026,sequence:1,currency:'EUR',mid:'4.2500',rate_date:'2026-10-19',table_no:'203/A/NBP/2026',categories:[]},invoice230:true,reused:false},{status:201});
 };api.setWorkspace(id(1));}
 const buttons=(el,text)=>[...el.querySelectorAll('button')].filter(b=>b.textContent===text);
 const field=(el,label)=>[...el.querySelectorAll('label')].find(l=>l.textContent.startsWith(label))?.querySelector('input,select');
 async function set(input,value){await React.act(async()=>{const proto=input.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
 async function click(e){assert(e&&!e.disabled,'clickable');await React.act(async()=>e.click());}
 async function mount(Component,props){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);handles.push({el,root});await React.act(async()=>root.render(React.createElement(Component,props)));return el;}
 let changed=0;
 const panel=(role='admin',extra={})=>mount(m.Invoice230Panel,{order,contextKey:`${id(1)}:${id(2)}:${role}:false:false`,readOnly:false,refresh:0,onChanged:()=>changed++,...extra});
 async function fillEu(el){
  await until(()=>field(el,'Seria')?.querySelector(`option[value="${series.id}"]`),'form with series');
  await set(field(el,'Seria'),series.id);await set(field(el,'Rodzaj nabywcy'),'eu');
  assert(field(el,'Numer VAT UE'),'EU VAT field');assert(!field(el,'NIP'),'no NIP field for EU');assert(!field(el,'Czynny podatnik'),'no PL VAT payer checkbox for EU');
  for(const[label,value]of [['Nazwa',buyerIn.name],['Ulica i numer',buyerIn.address.street],['Kod pocztowy',buyerIn.address.postal_code],['Miejscowość',buyerIn.address.city],['Kraj','de'],['Data sprzedaży','2026-10-20']])await set(field(el,label),value);
  await set(field(el,'Numer VAT UE'),'FR123');
  assert(el.querySelector('.invoice230-problems').textContent.includes('zaczyna się od DE'),'prefix hint');assert(buttons(el,'Przelicz')[0].disabled);
  await set(field(el,'Numer VAT UE'),'DE123456789');assert(!el.querySelector('.invoice230-problems'),'no problems');
 }
 const calcBody={series_id:series.id,order_version:'7',shipping_vat:23,buyer:buyerIn,sell_date:'2026-10-20'};
 try{
  await t.test('money and rate labels use minor units and FA(3) codes',()=>{
   assert.equal(m.invoice230Money('123456789','PLN'),`1${NB}234${NB}567,89${NB}PLN`);assert.equal(m.invoice230Money('5','EUR'),`0,05${NB}EUR`);assert.equal(m.invoice230Money('-100','PLN'),`-1,00${NB}PLN`);
   assert.deepEqual([{rate_code:'23',rate:'23.00'},{rate_code:'zw',rate:null},{rate_code:'np I',rate:null},{rate_code:'oo',rate:null},{rate_code:'0 KR',rate:'0.00'},{rate_code:'oss',rate:'19.00'},{rate_code:'oss',rate:'5.50'}].map(m.invoice230RateLabel),['23%','zw','np','oo','0%','19% (OSS)','5,50% (OSS)']);
  });
  await t.test('client checks: NIP checksum, country per buyer type, required fields',()=>{
   const f={seriesId:series.id,type:'pl',name:'Firma',street:'Ul 1',postal_code:'00-001',city:'Wwa',country:'PL',taxId:'526-025-02-74',plVatPayer:true,shippingVat:23,sellDate:'2026-10-20'};
   assert.deepEqual(m.invoice230FormProblems(f,[series]),[]);
   assert.deepEqual(m.invoice230BuyerBody(f),{kind:'business',name:'Firma',address:{street:'Ul 1',postal_code:'00-001',city:'Wwa',country:'PL'},tax_id:'526-025-02-74',pl_vat_payer:true});
   assert(m.invoice230FormProblems({...f,taxId:'5260250275'},[series]).some(p=>p.includes('Niepoprawny NIP')));
   assert(m.invoice230FormProblems({...f,type:'eu',country:'US',taxId:'X'},[series]).some(p=>p.includes('nie jest państwem UE')));
   assert.deepEqual(m.invoice230FormProblems({...f,type:'eu',country:'GR',taxId:'EL123456789'},[series]),[]);
   assert(m.invoice230FormProblems({...f,type:'non_eu',country:'DE'},[series]).some(p=>p.includes('należy do UE')));
   assert.equal(m.invoice230BuyerBody({...f,type:'non_eu',country:'US',taxId:'123'}).tax_id,'');
   assert.deepEqual(m.invoice230BuyerBody({...f,type:'consumer',country:'DE'}),{kind:'consumer',name:'Firma',address:{street:'Ul 1',postal_code:'00-001',city:'Wwa',country:'DE'}});
   const missing=m.invoice230FormProblems({...f,seriesId:'',name:' ',street:'',sellDate:''},[series]);for(const p of ['Wybierz serię faktur','Podaj nazwę firmy','Podaj ulicę i numer','Podaj datę sprzedaży'])assert(missing.includes(p),p);
  });
  await t.test('EU firm: calculate shows categories, NBP line, MPP; preview and issue send exact bodies; retry repeats the same request',async()=>{
   reset({issue:'network'});changed=0;const el=await panel();
   await until(()=>field(el,'Kraj'),'form');assert.equal(field(el,'Imię i nazwisko').value,'Hans Kunde','prefilled from order');assert.equal(field(el,'Stawka VAT dostawy').value,'23');assert.match(field(el,'Data sprzedaży').value,/^\d{4}-\d{2}-\d{2}$/);
   await fillEu(el);await click(buttons(el,'Przelicz')[0]);await until(()=>el.querySelector('.invoice230-calculation'),'calculation');
   assert.deepEqual(fx.posts[0],[`/api/invoice230/orders/${order.id}/calculate`,calcBody]);
   const summary=el.querySelector('table[aria-label="Podsumowanie według kategorii"]');const heads=[...summary.querySelectorAll('th')].map(h=>h.textContent);
   assert.deepEqual(heads,['Kategoria','Pole FA(3)','Netto','VAT','Brutto','VAT w PLN']);
   assert.deepEqual([...summary.querySelectorAll('tbody td')].map(c=>c.textContent),['NP II — art. 100 ust. 1 pkt 4','P_13_9',`4${NB}000,00${NB}EUR`,'—',`4${NB}000,00${NB}EUR`,`0,00${NB}PLN`]);
   assert.deepEqual([...el.querySelectorAll('table[aria-label="Pozycje faktury"] tbody td')].map(c=>c.textContent).slice(1,3),['1 szt.','np']);
   const text=el.querySelector('.invoice230-calculation').textContent;
   assert(text.includes('Kurs NBP z dnia 2026-10-19, tabela 203/A/NBP/2026'));assert(text.includes(`Kwoty w PLN: netto 17${NB}000,00${NB}PLN`));assert(text.includes('Numer VAT UE: DE123456789'));
   assert.deepEqual([...el.querySelectorAll('.invoice230-badge')].map(b=>b.textContent),['MPP — mechanizm podzielonej płatności','Odwrotne obciążenie']);
   assert(!el.querySelector('.invoice230-blockers'));
   await click(buttons(el,'Przygotuj podgląd')[0]);await until(()=>el.textContent.includes('Podgląd ważny do'),'preview');
   const [pRoute,pBody]=fx.posts[1];assert.equal(pRoute,`/api/invoice230/orders/${order.id}/previews`);const {client_key:pk,...rest}=pBody;assert.match(pk,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.deepEqual(rest,calcBody);
   assert(buttons(el,'Wystaw fakturę')[0].disabled,'issue needs confirmation');await click(field(el,'Sprawdziłem dane'));await click(buttons(el,'Wystaw fakturę')[0]);
   await until(()=>buttons(el,'Ponów to samo żądanie').length,'pending after network failure');assert(el.querySelector('[role="alert"]').textContent.includes('fetch failed'));
   assert(el.querySelector('.invoice230-fields').disabled,'form locked while the outcome is unknown');assert(buttons(el,'Wystaw fakturę')[0].disabled);
   await click(buttons(el,'Ponów to samo żądanie')[0]);await until(()=>el.querySelector('.invoice230-document'),'issued document');
   const [first,second]=fx.posts.slice(2);assert.equal(fx.posts.length,4);assert.equal(first[0],`/api/local-invoices/previews/${previewId}/tax-issue`);
   assert.deepEqual(Object.keys(first[1]).sort(),['client_key','confirmed','local_only','scope_hash']);assert.equal(first[1].scope_hash,scopeHash);assert.equal(first[1].confirmed,true);assert.equal(first[1].local_only,true);assert.notEqual(first[1].client_key,pk);
   assert.deepEqual(second,first,'retry repeats the exact request');
   assert(el.querySelector('.invoice230-document h4').textContent===`Faktura ${number}`);assert.equal(changed,1);assert(!buttons(el,'Ponów to samo żądanie').length);assert(!el.querySelector('.invoice230-fields'),'no form after issue');
  });
  await t.test('blockers are listed, preview stays disabled; any edit drops the calculation',async()=>{
   reset({calc:'blocked'});const el=await panel();await fillEu(el);await click(buttons(el,'Przelicz')[0]);await until(()=>el.querySelector('.invoice230-blockers'),'blockers');
   const b=el.querySelector('.invoice230-blockers');assert(b.textContent.startsWith('Faktury nie można wystawić:'));assert.deepEqual([...b.querySelectorAll('li')].map(l=>l.textContent),blockers);
   assert(buttons(el,'Przygotuj podgląd')[0].disabled);
   await set(field(el,'Miejscowość'),'Bremen');assert(!el.querySelector('.invoice230-calculation'),'edit invalidates');assert.equal(fx.posts.length,1);
  });
  await t.test('viewer may calculate but cannot prepare or issue',async()=>{
   reset({role:'viewer',canWrite:false});const el=await panel('viewer');await fillEu(el);await click(buttons(el,'Przelicz')[0]);await until(()=>el.querySelector('.invoice230-calculation'),'calculation');
   assert(buttons(el,'Przygotuj podgląd')[0].disabled);assert(el.querySelector('.invoice230-write-reason').textContent.includes('Rola viewer pozwala tylko przeliczyć fakturę'));
   assert.deepEqual(fx.posts.map(p=>p[0]),[`/api/invoice230/orders/${order.id}/calculate`]);
  });
  await t.test('read-only copy: calculation works, writes are disabled with a reason',async()=>{
   reset();const el=await panel('admin',{readOnly:true});await fillEu(el);await click(buttons(el,'Przelicz')[0]);await until(()=>el.querySelector('.invoice230-calculation'),'calculation');
   assert(buttons(el,'Przygotuj podgląd')[0].disabled);assert(el.textContent.includes('Kopia tylko do odczytu'));
  });
  await t.test('an existing document is shown with print link and FA(3) button, no form',async()=>{
   reset({docs:[zwDoc()]});const el=await panel();await until(()=>el.querySelector('.invoice230-document'),'document');
   const a=[...el.querySelectorAll('a')].find(x=>x.textContent==='Drukuj');assert.equal(a.getAttribute('href'),`/api/invoice230/documents/${documentId}/print`);assert.equal(a.getAttribute('target'),'_blank');
   assert(buttons(el,'Pobierz XML FA(3)').length===1);assert(!el.querySelector('.invoice230-fields'));assert(!buttons(el,'Przelicz').length);
   const text=el.querySelector('.invoice230-document').textContent;assert(text.includes(`Faktura ${number}`));assert(text.includes('Wystawiona 2026-10-23'));assert(text.includes('Muster GmbH'));assert(text.includes('P_13_7'));assert(!text.includes('VAT w PLN'));assert(text.includes(`1${NB}234,56${NB}PLN`));
   assert.deepEqual([...el.querySelectorAll('.invoice230-badge')].map(b=>b.textContent),['Zwolnienie: art. 43 ust. 1 pkt 18 ustawy o VAT']);
   // 231: the issued FV-S invoice has its KSeF section; an administrator sends it.
   await until(()=>el.querySelector('.invoice230-document .ksef-document')?.textContent.includes('Nie wysłano do KSeF.'),'KSeF section');
   await click(buttons(el,'Wyślij do KSeF')[0]);
   await until(()=>el.querySelector('.ksef-document').textContent.includes('5260250274-20261023-0123456789AB-0C'),'KSeF number shown');
   assert.deepEqual(fx.posts.map(p=>p[0]),[`/api/ksef229/documents/${documentId}/send`]);assert(buttons(el,'Pobierz UPO').length===1);
   assert(!el.querySelector('.invoice230-document').textContent.includes('nie przesłany do KSeF'));
  });
  await t.test('viewer sees the KSeF state of a FV-S invoice without the send button',async()=>{
   reset({role:'viewer',canWrite:false,docs:[zwDoc()]});const el=await panel('viewer');await until(()=>el.querySelector('.ksef-document')?.textContent.includes('Nie wysłano do KSeF.'),'KSeF section');
   assert(!buttons(el,'Wyślij do KSeF').length);
  });
  await t.test('not shipped or another currency: one-line explanation; missing migration: notice',async()=>{
   reset();const el=await mount(m.Invoice230Panel,{order:{...order,status:'paid'},contextKey:`${id(1)}:${id(2)}:admin:false:false`,readOnly:false});
   await until(()=>el.textContent.includes('Fakturę wystawisz po wysłaniu lub dostarczeniu zamówienia.'),'status line');assert(!el.querySelector('.invoice230-fields'));
   const usd=await mount(m.Invoice230Panel,{order:{...order,id:id(3),currency:'USD'},contextKey:`${id(1)}:${id(2)}:admin:false:false`,readOnly:false});
   await until(()=>usd.textContent.includes('Waluta USD nie jest obsługiwana'),'currency line');
   reset({unavailable:true});const off=await mount(m.Invoice230Panel,{order:{...order,id:id(5)},contextKey:`${id(1)}:${id(2)}:admin:false:false`,readOnly:false});
   await until(()=>off.textContent.includes('Faktury szczególne (migracja 230) są niedostępne w tej kopii'),'503 notice');assert(!off.querySelector('.invoice230-fields'));
  });
  await t.test('register lists FV-S documents with print link and FA(3)',async()=>{
   reset({docs:[doc()]});const el=await mount(m.Invoice230Register,{contextKey:`${id(1)}:${id(2)}:admin:false`,readOnly:false,refresh:0});
   await until(()=>el.querySelector('tbody tr'),'row');const cells=[...el.querySelectorAll('tbody td')].map(c=>c.textContent);
   assert.equal(cells[0],`${number}Zamówienie ZAM-7`);assert.equal(cells[1],'2026-10-23');assert.equal(cells[2],'Muster GmbHDE · DE123456789');assert.equal(cells[3],`4${NB}000,00${NB}EUR`);
   assert.equal(el.querySelector('tbody a').getAttribute('href'),`/api/invoice230/documents/${documentId}/print`);assert(buttons(el,'Pobierz XML FA(3)').length===1);
  });
 }finally{for(const h of handles){await React.act(async()=>h.root.unmount());h.el.remove();}globalThis.fetch=oldFetch;await vite.close();dom.window.close();for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
});
