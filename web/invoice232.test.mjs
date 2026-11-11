/** KOR-S (232) panel and register: line editor, return start, cancellation, calculation view, preview and
 * issue bodies, retry, viewer and the register; controlled fetch only, no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const NB='\u00a0';
const invoiceId=id(30),retId=id(50),previewId=id(60),correctionId=id(70),scopeHash='c'.repeat(64),number='KOR-S/FV/2026/000001';
const lines=[
 {line_no:1,kind:'item',sku:'SRV-1',name:'Usługa wdrożenia',item_id:id(4),unit:'szt.',quantity:3,gross_minor:'99999',net_minor:'99999',vat_minor:'0',rate_code:'np II',rate:null,gtu:null,annex15:false,current:{line_no:1,quantity:3,gross_minor:'99999',net_minor:'99999',vat_minor:'0'}},
 {line_no:2,kind:'shipping',sku:'',name:'Dostawa',item_id:null,unit:'usł.',quantity:1,gross_minor:'1500',net_minor:'1500',vat_minor:'0',rate_code:'np II',rate:null,gtu:null,annex15:false,current:{line_no:2,quantity:1,gross_minor:'1500',net_minor:'1500',vat_minor:'0'}},
];
const state=(extra={})=>({original:{id:invoiceId,number:'FV-S/FV/2026/000001',order_id:id(1),currency:'EUR',issue_date:'2026-10-23',mpp_required:false,nbp:{mid:'4.2737',rate_date:'2026-10-22',table_no:'205/A/NBP/2026'}},
 lines,current_gross_minor:'101499',next_position:1,corrections:[],returns:[{id:retId,number:'ZW/2026/0001',state:'refund_pending',received:true,refund_amount_minor:'33333',refunded_shipping_minor:'0',corrected_by:null}],...extra});
const amounts=(g)=>({net_minor:g,vat_minor:'0',gross_minor:g});
function snapshot({reason='Obniżka ceny — Uzgodnienie',kind='price',after='90000'}={}){
 const delta=String(BigInt(after)-99999n);
 return{format:'invoice232/v1',original:{document_id:invoiceId,number:'FV-S/FV/2026/000001',issue_date:'2026-10-23',sell_date:'2026-10-23',currency:'EUR',ksef_number:'5260250274-20261023-0123456789AB-0C',mpp_required:false,series:{id:id(8),name:'Główna',prefix:'FV'},scope_hash:'a'.repeat(64)},
  order:{id:id(1),number:'ZAM-7'},return:kind==='return'?{id:retId,number:'ZW/2026/0001'}:null,seller:{name:'Sprzedawca'},buyer:{kind:'business',name:'Muster GmbH',address:{street:'Ring 5',postal_code:'20095',city:'Hamburg',country:'DE'},tax_id:'DE123456789',tax_id_kind:'eu_vat',pl_vat_payer:false},
  currency:'EUR',nbp:{mid:'4.2737',rate_date:'2026-10-22',table_no:'205/A/NBP/2026',basis:'original_invoice'},reason_code:'obnizka_ceny',reason,kind,direction:'decrease',position:1,
  rows:[{line_no:1,kind:'item',sku:'SRV-1',name:'Usługa wdrożenia',item_id:id(4),unit:'szt.',rate_code:'np II',rate:null,gtu:null,annex15:false,before:{quantity:3,...amounts('99999')},after:{quantity:3,...amounts(after)},delta:{quantity:0,...amounts(delta)}},
   {line_no:2,kind:'shipping',sku:'',name:'Dostawa',item_id:null,unit:'usł.',rate_code:'np II',rate:null,gtu:null,annex15:false,before:{quantity:1,...amounts('1500')},after:{quantity:1,...amounts('1500')},delta:{quantity:0,...amounts('0')}}],
  categories:[{key:'np II',rate_code:'np II',rate:null,fa3_net:'P_13_9',fa3_vat:null,label:'NP II — art. 100 ust. 1 pkt 4',before:amounts('101499'),after:amounts(String(BigInt(after)+1500n)),delta:amounts(delta),
   pln:{before:{net_pln_minor:'433776',vat_pln_minor:'0',gross_pln_minor:'433776'},after:{net_pln_minor:'391044',vat_pln_minor:'0',gross_pln_minor:'391044'},delta:{net_pln_minor:'-42732',vat_pln_minor:'0',gross_pln_minor:'-42732'}}}],
  totals:{before:amounts('101499'),after:amounts(String(BigInt(after)+1500n)),delta:amounts(delta)},
  pln_totals:{before:{net_pln_minor:'433776',vat_pln_minor:'0',gross_pln_minor:'433776'},after:{net_pln_minor:'391044',vat_pln_minor:'0',gross_pln_minor:'391044'},delta:{net_pln_minor:'-42732',vat_pln_minor:'0',gross_pln_minor:'-42732'}},
  state_after:[],mpp:{required:false},reverse_charge:true,exemption:null,rounding_method:'gross_line_half_up',issue_date:'2026-10-25',year:2026,tax_period:'2026-10',period_basis:'Art. 29a ust. 13',local_only:true,ksef_state:'not_submitted',fiscalized:false};
}
const doc=(s=snapshot())=>({id:correctionId,order_id:id(1),original_document_id:invoiceId,return_id:null,number,kind:'correction',mode:'invoice232_correction',data:{...s,number,preview_id:previewId,scope_hash:scopeHash},created_at:'2026-10-25T10:00:00.000Z'});

test('invoice232 panel and register',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom');
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,DOMParser:dom.window.DOMParser,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),m=await vite.ssrLoadModule(path.resolve('web/invoice232.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn,note){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),note);}
 let handles=[],fx;
 function reset(opts={}){fx={role:'admin',canWrite:true,state:state(),docs:[],calc:'ok',issue:'ok',posts:[],...opts};globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname,method=init.method??'GET',flags={available:true,read_only:false,current_role:fx.role,can_read:true,can_write:fx.canWrite};
  if(route===`/api/invoice232/invoices/${invoiceId}`&&method==='GET'){if(fx.unavailable)return Response.json({detail:'Korekty faktur FV-S (migracja 232) są niedostępne w tej kopii'},{status:503});return Response.json({...flags,...fx.state});}
  if(route==='/api/invoice232/corrections'&&method==='GET'){if(fx.unavailable)return Response.json({detail:'x'},{status:503});return Response.json({...flags,data:fx.docs});}
  if(route.startsWith('/api/ksef229/documents/')&&method==='GET')return Response.json({document_id:route.split('/').at(-1),submission:null,rejected:[]});
  assert.equal(method,'POST',route);const body=JSON.parse(init.body);fx.posts.push([route,body]);
  if(route===`/api/invoice232/invoices/${invoiceId}/calculate`){const b=fx.calc==='blocked'?['Faktura korygowana czeka na numer KSeF']:[];
   return Response.json({...flags,original_document_id:invoiceId,snapshot:snapshot(body.mode==='return'?{reason:'Zwrot towaru',kind:'return',after:'66666'}:{}),blockers:b,issuable:!b.length});}
  if(route===`/api/invoice232/invoices/${invoiceId}/previews`){if(!fx.canWrite)return Response.json({detail:'Brak uprawnień'},{status:403});
   return Response.json({...flags,preview:{id:previewId,original_document_id:invoiceId,order_id:id(1),return_id:null,scope_hash:scopeHash,snapshot:snapshot(),expires_at:'2099-01-01T00:00:00.000Z',created_at:'2026-10-25T10:00:00.000Z'},reused:false},{status:201});}
  assert.equal(route,`/api/invoice232/previews/${previewId}/issue`);
  if(fx.issue==='network'){fx.issue='ok';throw new TypeError('fetch failed');}
  fx.docs=[doc()];fx.state=state({next_position:2,corrections:[{position:1,number,reason:'Obniżka ceny',delta_gross_minor:'-9999',issue_date:'2026-10-25'}]});
  return Response.json({...flags,document:doc(),record:{},reused:false},{status:201});
 };api.setWorkspace(id(1));}
 const buttons=(el,text)=>[...el.querySelectorAll('button')].filter(b=>b.textContent===text);
 const field=(el,label)=>[...el.querySelectorAll('label')].find(l=>l.textContent.startsWith(label))?.querySelector('input,select');
 const input=(el,label)=>el.querySelector(`input[aria-label="${label}"]`);
 async function set(node,value){await React.act(async()=>{const proto=node.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
 async function click(e){assert(e&&!e.disabled,'clickable');await React.act(async()=>e.click());}
 async function mount(Component,props){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);handles.push({el,root});await React.act(async()=>root.render(React.createElement(Component,props)));return el;}
 let changed=0;
 const panel=(role='admin',extra={})=>mount(m.Invoice232Panel,{documentId:invoiceId,contextKey:`${id(1)}:${id(2)}:${role}:false:false`,readOnly:false,onChanged:()=>changed++,...extra});
 try{
  await t.test('amounts parse to minor units; only changed lines are sent; client checks',()=>{
   assert.deepEqual(['123,45','1 234.5','0','12','1,234','-1','abc'].map(m.invoice232ParseAmount),['12345','123450','0','1200',null,null,null]);
   const draft={mode:'manual',reason:'obnizka_ceny',note:' Uzgodnienie ',returnId:'',lines:m.invoice232BlankLines(lines)};
   assert.deepEqual(draft.lines,[{line_no:1,quantity:'3',gross:'999,99'},{line_no:2,quantity:'1',gross:'15,00'}]);
   assert.deepEqual(m.invoice232DraftProblems(draft,lines),['Zmień ilość lub wartość co najmniej jednej pozycji']);
   const changedDraft={...draft,lines:[{line_no:1,quantity:'3',gross:'900'},draft.lines[1]]};
   assert.deepEqual(m.invoice232DraftProblems(changedDraft,lines),[]);
   assert.deepEqual(m.invoice232CorrectionBody(changedDraft,lines),{mode:'manual',reason_code:'obnizka_ceny',reason_note:'Uzgodnienie',lines:[{line_no:1,quantity:3,gross_minor:'90000'}]});
   assert.deepEqual(m.invoice232DraftProblems({...changedDraft,lines:[{line_no:1,quantity:'2.5',gross:'9,999'}]},lines),['SRV-1: ilość po korekcie musi być liczbą całkowitą','SRV-1: wartość brutto po korekcie, np. 123,45']);
   assert.deepEqual(m.invoice232DraftProblems({...changedDraft,reason:'inna',note:'abc'},lines),['Przy przyczynie „Inna” opisz ją (co najmniej 5 znaków)']);
   assert.deepEqual(m.invoice232CorrectionBody({...draft,mode:'cancellation'},lines),{mode:'cancellation',reason_note:'Uzgodnienie'});
   assert.deepEqual(m.invoice232DraftProblems({...draft,mode:'return'},lines),['Wybierz przyjęty zwrot']);
   assert.deepEqual(m.invoice232CorrectionBody({...draft,mode:'return',returnId:retId},lines),{mode:'return',return_id:retId,reason_note:'Uzgodnienie'});
   assert(!m.INVOICE232_MANUAL_REASONS.includes('zwrot')&&!m.INVOICE232_MANUAL_REASONS.includes('anulowanie')&&m.INVOICE232_MANUAL_REASONS.includes('podwyzka_ceny'));
  });
  await t.test('line editor: calculate shows before/after and PLN difference; preview and issue send exact bodies; retry repeats the same request',async()=>{
   reset({issue:'network'});changed=0;const el=await panel();
   await until(()=>buttons(el,'Wystaw korektę').length,'editor button');assert(el.textContent.includes('Faktura nie ma korekt.'));
   await click(buttons(el,'Wystaw korektę')[0]);
   assert.equal(field(el,'Rodzaj korekty').value,'manual');assert(buttons(el,'Przelicz korektę')[0].disabled,'no change yet');
   await set(field(el,'Przyczyna'),'obnizka_ceny');await set(field(el,'Opis przyczyny'),'Uzgodnienie');await set(input(el,'Brutto po korekcie: SRV-1'),'900,00');
   await click(buttons(el,'Przelicz korektę')[0]);await until(()=>el.querySelector('.invoice232-calculation'),'calculation');
   assert.deepEqual(fx.posts[0],[`/api/invoice232/invoices/${invoiceId}/calculate`,{mode:'manual',reason_code:'obnizka_ceny',reason_note:'Uzgodnienie',lines:[{line_no:1,quantity:3,gross_minor:'90000'}]}]);
   const rows=[...el.querySelectorAll('table[aria-label="Pozycje korekty"] tbody tr')];assert.equal(rows.length,1,'unchanged lines are hidden');
   assert.deepEqual([...rows[0].querySelectorAll('td')].map(c=>c.textContent).slice(2),[`3 szt. · 999,99${NB}EUR`,`3 szt. · 900,00${NB}EUR`,`-99,99${NB}EUR`]);
   const text=el.querySelector('.invoice232-calculation').textContent;
   assert(text.includes('numer KSeF 5260250274-20261023-0123456789AB-0C'));assert(text.includes('1 EUR = 4,2737 PLN'));assert(text.includes(`Różnica w PLN: netto -427,32${NB}PLN`));assert(text.includes('Korekta zmniejszająca, rozliczana w okresie 2026-10'));
   await click(buttons(el,'Przygotuj podgląd korekty')[0]);await until(()=>el.textContent.includes('Podgląd ważny do'),'preview');
   const [pRoute,pBody]=fx.posts[1];assert.equal(pRoute,`/api/invoice232/invoices/${invoiceId}/previews`);assert.deepEqual(pBody.correction,fx.posts[0][1]);assert.match(pBody.client_key,/^[0-9a-f-]{36}$/);
   assert(buttons(el,'Wystaw korektę KOR-S')[0].disabled,'issue needs confirmation');await click(field(el,'Sprawdziłem różnice'));await click(buttons(el,'Wystaw korektę KOR-S')[0]);
   await until(()=>buttons(el,'Ponów to samo żądanie').length,'pending after network failure');assert(el.querySelector('.invoice232-fields').disabled,'editor locked while the outcome is unknown');
   await click(buttons(el,'Ponów to samo żądanie')[0]);await until(()=>el.querySelector('.invoice232-list'),'issued correction listed');
   const [first,second]=fx.posts.slice(2);assert.equal(fx.posts.length,4);assert.equal(first[0],`/api/invoice232/previews/${previewId}/issue`);
   assert.deepEqual(Object.keys(first[1]).sort(),['client_key','confirmed','scope_hash']);assert.equal(first[1].scope_hash,scopeHash);assert.deepEqual(second,first,'retry repeats the exact request');
   assert(el.querySelector('.invoice232-list').textContent.includes(`${number} z 2026-10-25`));assert.equal(changed,1);assert(!el.querySelector('.invoice232-fields'),'editor closed after issue');
   const a=[...el.querySelectorAll('a')].find(x=>x.textContent==='Drukuj korektę');assert.equal(a.getAttribute('href'),`/api/invoice232/corrections/${correctionId}/print`);
   assert(buttons(el,'Pobierz XML FA(3)').length===1);await until(()=>el.querySelector('.ksef-document'),'KSeF section of the correction');
  });
  await t.test('"Koryguj ze zwrotu" starts from a received return and calculates at once',async()=>{
   reset();const el=await panel();await until(()=>buttons(el,'Koryguj ze zwrotu ZW/2026/0001').length,'return button');
   await click(buttons(el,'Koryguj ze zwrotu ZW/2026/0001')[0]);await until(()=>el.querySelector('.invoice232-calculation'),'calculation');
   assert.deepEqual(fx.posts[0],[`/api/invoice232/invoices/${invoiceId}/calculate`,{mode:'return',return_id:retId,reason_note:''}]);
   assert.equal(field(el,'Rodzaj korekty').value,'return');assert.equal(field(el,'Zwrot').value,retId);assert(el.querySelector('.invoice232-calculation').textContent.includes('Przyczyna: Zwrot towaru'));
  });
  await t.test('a corrected return and a not-received one are not offered; cancellation sends its mode',async()=>{
   reset({state:state({returns:[{id:retId,number:'ZW/2026/0001',state:'refund_pending',received:true,corrected_by:'KOR-S/FV/2026/000001'},{id:id(51),number:'ZW/2026/0002',state:'requested',received:false,corrected_by:null}]})});
   const el=await panel();await until(()=>buttons(el,'Wystaw korektę').length,'editor button');assert(!el.querySelector('.invoice232-returns'));
   await click(buttons(el,'Wystaw korektę')[0]);await set(field(el,'Rodzaj korekty'),'return');
   assert.deepEqual([...field(el,'Zwrot').querySelectorAll('option')].map(o=>[o.textContent,o.disabled]),[['Wybierz zwrot',false],['ZW/2026/0001 (korekta KOR-S/FV/2026/000001)',true],['ZW/2026/0002 (nieprzyjęty)',true]]);
   await set(field(el,'Rodzaj korekty'),'cancellation');assert(el.textContent.includes('Wszystkie pozycje zostaną skorygowane do zera'));
   await click(buttons(el,'Przelicz korektę')[0]);await until(()=>el.querySelector('.invoice232-calculation'),'calculation');assert.deepEqual(fx.posts[0][1],{mode:'cancellation',reason_note:''});
  });
  await t.test('blockers are listed and the preview stays disabled; viewer only calculates',async()=>{
   reset({calc:'blocked'});const el=await panel();await until(()=>buttons(el,'Wystaw korektę').length,'editor');await click(buttons(el,'Wystaw korektę')[0]);
   await set(field(el,'Rodzaj korekty'),'cancellation');await click(buttons(el,'Przelicz korektę')[0]);await until(()=>el.querySelector('.invoice232-blockers'),'blockers');
   assert(el.querySelector('.invoice232-blockers').textContent.includes('czeka na numer KSeF'));assert(buttons(el,'Przygotuj podgląd korekty')[0].disabled);
   reset({role:'viewer',canWrite:false});const v=await panel('viewer');await until(()=>buttons(v,'Wystaw korektę').length,'editor');await click(buttons(v,'Wystaw korektę')[0]);
   await set(field(v,'Rodzaj korekty'),'cancellation');await click(buttons(v,'Przelicz korektę')[0]);await until(()=>v.querySelector('.invoice232-calculation'),'calculation');
   assert(buttons(v,'Przygotuj podgląd korekty')[0].disabled);assert(v.querySelector('.invoice232-write-reason').textContent.includes('Rola viewer pozwala tylko przeliczyć korektę'));
  });
  await t.test('an invoice corrected to zero offers no editor; missing migration: notice',async()=>{
   reset({state:state({current_gross_minor:'0'})});const el=await panel();await until(()=>el.textContent.includes('skorygowana do zera'),'zero line');assert(!buttons(el,'Wystaw korektę').length);
   reset({unavailable:true});const off=await panel();await until(()=>off.textContent.includes('Korekty faktur FV-S (migracja 232) są niedostępne w tej kopii'),'503 notice');
  });
  await t.test('register lists KOR-S corrections with the corrected invoice, reason, difference, print and FA(3)',async()=>{
   reset({docs:[doc()]});const el=await mount(m.Invoice232Register,{contextKey:`${id(1)}:${id(2)}:admin:false`,readOnly:false,refresh:0});
   await until(()=>el.querySelector('tbody tr'),'row');const cells=[...el.querySelectorAll('tbody td')].map(c=>c.textContent);
   assert.deepEqual(cells.slice(0,5),[`${number}Zamówienie ZAM-7`,'2026-10-25','FV-S/FV/2026/000001Muster GmbH','Obniżka ceny — Uzgodnienie',`-99,99${NB}EUR`]);
   assert.equal(el.querySelector('tbody a').getAttribute('href'),`/api/invoice232/corrections/${correctionId}/print`);assert(buttons(el,'Pobierz XML FA(3)').length===1);
  });
 }finally{for(const h of handles){await React.act(async()=>h.root.unmount());h.el.remove();}globalThis.fetch=oldFetch;await vite.close();dom.window.close();for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
});
