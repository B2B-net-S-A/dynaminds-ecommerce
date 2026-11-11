/** Fiscal receipts (233) views: order panel (calculation, blockers, print body, failure, retry, the uncertain
 * write repeated with the same request, invoice note), printer settings (form checks, save body, test,
 * daily report), viewer and missing migration; controlled fetch only, no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const NB=' ',orderId=id(1),receiptId=id(40),printerId=id(9);
const ptu={A:'23',B:'8',C:'5',D:'0',E:'zw',F:null,G:null};
const printer={id:printerId,name:'Kasa sklepu',model_family:'posnet',model_label:'Posnet',host:'127.0.0.1',port:4339,unique_number:'DYN12345678',ptu,active:true,version:2,updated_at:'2026-10-25T10:00:00.000Z'};
const snap={format:'receipt233/v1',order_id:orderId,order:{id:orderId,number:'ZAM-1',version:'5',payment_mode:'prepaid',total_minor:'13800'},printer:{id:printerId,name:'Kasa sklepu',model_family:'posnet',unique_number:'DYN12345678'},
 ptu_table:ptu,payment_form:'przelew',payment_label:'Przelew',buyer_nip:null,simplified_invoice:false,shipping_vat:23,sell_date:'2026-10-25',rounding_method:'gross_line_half_up',
 lines:[{line_no:1,kind:'item',name:'Kubek',sku:'K-1',quantity:1,unit_gross_minor:'12300',discount_gross_minor:'0',gross_minor:'12300',net_minor:'10000',vat_minor:'2300',rate_code:'23',ptu:'A'},
  {line_no:2,kind:'shipping',name:'Dostawa',sku:'',quantity:1,unit_gross_minor:'1500',discount_gross_minor:'0',gross_minor:'1500',net_minor:'1220',vat_minor:'280',rate_code:'23',ptu:'A'}],
 ptu_totals:[{ptu:'A',value:'23',gross_minor:'13800',net_minor:'11220',vat_minor:'2580'}],totals:{net_minor:'11220',vat_minor:'2580',gross_minor:'13800'}};
const receipt=(o={})=>({id:receiptId,order_id:orderId,state:'printed',state_label:'Wydrukowany',attempts:1,payment_form:'karta',buyer_nip:null,simplified_invoice:false,gross_minor:'13800',
 printer_unique_number:'DYN12345678',number:'000017',fiscal_date:'2026-10-25',error:null,snapshot:snap,created_at:'2026-10-25T10:00:00.000Z',sent_at:'2026-10-25T10:00:01.000Z',printed_at:'2026-10-25T10:00:02.000Z',invoice:null,...o});
const failed=()=>receipt({state:'failed',state_label:'Błąd druku',number:null,fiscal_date:null,printed_at:null,error:{code:'PAPER_OUT',message:'Brak papieru w drukarce fiskalnej — włóż rolkę i ponów druk',retry:true}});

test('receipt233 order panel and printer settings',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom');
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,DOMParser:dom.window.DOMParser,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),m=await vite.ssrLoadModule(path.resolve('web/receipt233.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn,note){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),note);}
 let handles=[],fx;
 function reset(opts={}){fx={canWrite:true,configure:true,receipt:null,blockers:[],print:'ok',posts:[],reports:[],...opts};globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url),'http://127.0.0.1'),route=u.pathname,method=init.method??'GET',flags={available:true,read_only:false,current_role:fx.configure?'admin':'viewer',can_read:true,can_write:fx.canWrite,can_configure:fx.configure};
  if(fx.unavailable)return Response.json({detail:'Paragony fiskalne (migracja 233) są niedostępne w tej kopii'},{status:503});
  if(route===`/api/receipt233/orders/${orderId}`&&method==='GET')return Response.json({...flags,printer,receipt:fx.receipt,calculation:fx.receipt?null:{snapshot:snap,blockers:fx.blockers,printable:!fx.blockers.length}});
  if(route==='/api/receipt233/printer'&&method==='GET')return Response.json({...flags,printer:fx.noPrinter?null:printer,printers:[]});
  if(route==='/api/receipt233/daily-reports'&&method==='GET')return Response.json({...flags,data:fx.reports});
  const body=JSON.parse(init.body);fx.posts.push([method,route,body]);
  if(route===`/api/receipt233/orders/${orderId}/receipts`){if(fx.print==='network'){fx.print='ok';throw new TypeError('fetch failed');}
   if(fx.print==='paper')return Response.json({...flags,receipt:failed(),reused:false},{status:201});return Response.json({...flags,receipt:receipt({payment_form:body.payment_form,buyer_nip:body.buyer_nip}),reused:false},{status:201});}
  if(route===`/api/receipt233/receipts/${receiptId}/retry`)return Response.json({...flags,receipt:receipt({attempts:2})});
  if(route==='/api/receipt233/printer'&&method==='PUT')return Response.json({...flags,printer:{...printer,...body,version:3},printers:[]});
  if(route==='/api/receipt233/printer/test')return Response.json({ok:true,status:{unique_number:'DYN12345678',fiscal_date:'2026-10-25',ptu},problems:[]});
  if(route==='/api/receipt233/daily-reports'){const r={id:id(70),printer_unique_number:'DYN12345678',fiscal_date:'2026-10-25',report_number:'0001',printer_receipts:1,app_receipts:1,printer_totals:[{ptu:'A',gross_minor:'13800',vat_minor:'2580'}],app_totals:[],matches:true,created_at:'x'};fx.reports=[r];return Response.json({...flags,report:r,reused:false},{status:201});}
  throw new Error('unexpected '+method+' '+route);
 };api.setWorkspace(id(2));}
 const buttons=(el,text)=>[...el.querySelectorAll('button')].filter(b=>b.textContent===text);
 const field=(el,label)=>[...el.querySelectorAll('label')].find(l=>l.textContent.startsWith(label))?.querySelector('input,select');
 async function set(node,value){await React.act(async()=>{const proto=node.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
 async function click(e){assert(e&&!e.disabled,'clickable');await React.act(async()=>e.click());}
 async function mount(Component,props){const el=document.createElement('div');document.body.append(el);const root=createRoot(el);handles.push({el,root});await React.act(async()=>root.render(React.createElement(Component,props)));return el;}
 let changed=0;
 const panel=(extra={})=>mount(m.Receipt233Panel,{order:{id:orderId},contextKey:`${id(2)}:${id(3)}:admin:false`,readOnly:false,onChanged:()=>changed++,...extra});
 try{
  await t.test('money and form checks',()=>{
   assert.equal(m.receipt233Money('123456'),`1${NB}234,56${NB}zł`);
   const f={name:'Kasa',model_family:'posnet',host:'127.0.0.1',port:'4339',unique_number:'dyn12345678',ptu,active:true};
   assert.deepEqual(m.receipt233FormProblems(f),[]);
   assert.deepEqual(m.receipt233FormProblems({...f,port:'80',unique_number:'X1',ptu:{...ptu,F:'23'}}),['Port to liczba 1024–65535','Numer unikatowy kasy: 3 litery i 8 cyfr, np. ABC12345678','Ta sama stawka PTU jest przypisana do dwóch liter']);
  });
  await t.test('print: needs the confirmation, sends the exact body, shows the number; NIP ≤ 450 zł note',async()=>{
   reset();changed=0;const el=await panel();await until(()=>buttons(el,'Drukuj paragon').length,'print button');
   assert(el.textContent.includes(`Do zapłaty: 138,00${NB}zł`));assert(el.textContent.includes(`PTU A (23%): 138,00${NB}zł, VAT 25,80${NB}zł`));
   assert(buttons(el,'Drukuj paragon')[0].disabled,'needs confirmation');assert.equal(field(el,'Forma płatności').value,'przelew');
   await set(field(el,'Forma płatności'),'karta');await set(field(el,'NIP nabywcy'),'526-025-02-74');assert(el.textContent.includes('Paragon z NIP do 450 zł jest fakturą uproszczoną.'));
   await click(field(el,'Potwierdzam druk'));await click(buttons(el,'Drukuj paragon')[0]);await until(()=>el.textContent.includes('Paragon nr 000017 z 2026-10-25'),'printed');
   const [method,route,body]=fx.posts[0];assert.deepEqual([method,route],['POST',`/api/receipt233/orders/${orderId}/receipts`]);
   assert.deepEqual(Object.keys(body).sort(),['buyer_nip','client_key','confirmed','payment_form']);assert.deepEqual([body.payment_form,body.buyer_nip,body.confirmed],['karta','526-025-02-74',true]);
   assert.equal(changed,1);assert(el.textContent.includes('Fakturę do tego paragonu wystaw w panelu „Faktura VAT: B2B, EUR, ZW/NP/OO/OSS” (FV-S)'));
  });
  await t.test('an unconfirmed print is repeated with the same request; paper out shows the error and "Ponów druk"',async()=>{
   reset({print:'network'});const el=await panel();await until(()=>buttons(el,'Drukuj paragon').length,'print');
   await click(field(el,'Potwierdzam druk'));await click(buttons(el,'Drukuj paragon')[0]);await until(()=>buttons(el,'Ponów to samo żądanie').length,'pending');
   await click(buttons(el,'Ponów to samo żądanie')[0]);await until(()=>el.textContent.includes('Paragon nr 000017'),'printed after retry');
   assert.equal(fx.posts.length,2);assert.deepEqual(fx.posts[1],fx.posts[0],'the retry repeats the exact request (same client_key)');
   reset({print:'paper'});const p=await panel({contextKey:`${id(2)}:${id(3)}:admin:false:2`});await until(()=>buttons(p,'Drukuj paragon').length,'print');
   await click(field(p,'Potwierdzam druk'));await click(buttons(p,'Drukuj paragon')[0]);await until(()=>p.textContent.includes('Brak papieru w drukarce fiskalnej'),'failure shown');
   assert(p.textContent.includes('Błąd druku'));await click(buttons(p,'Ponów druk')[0]);await until(()=>p.textContent.includes('Paragon nr 000017'),'retry printed');
   assert.deepEqual(fx.posts.at(-1),['POST',`/api/receipt233/receipts/${receiptId}/retry`,{confirmed:true}]);assert(p.textContent.includes('próby druku: 2'));
  });
  await t.test('blockers, an invoice to the receipt, viewer and missing migration',async()=>{
   reset({blockers:['Zamówienie ma już fakturę FV/1/2026/000001 — sprzedaż jest udokumentowana fakturą']});const b=await panel();await until(()=>b.querySelector('.receipt233-blockers'),'blockers');
   assert(b.textContent.includes('Paragonu nie można wydrukować:'));assert(!buttons(b,'Drukuj paragon').length);
   reset({receipt:receipt({invoice:{document_id:id(80),number:'FV-S/A/2026/000001',mode:'invoice230'}})});const i=await panel();await until(()=>i.textContent.includes('Faktura do paragonu: FV-S/A/2026/000001'),'link');
   reset({canWrite:false,configure:false});const v=await panel();await until(()=>buttons(v,'Drukuj paragon').length,'viewer');assert(v.querySelector('.receipt233-fields').disabled);
   reset({receipt:failed(),canWrite:false,configure:false});const vf=await panel();await until(()=>buttons(vf,'Ponów druk').length,'retry button');assert(buttons(vf,'Ponów druk')[0].disabled);
   reset({unavailable:true});const off=await panel();await until(()=>off.textContent.includes('Paragony fiskalne (migracja 233) są niedostępne w tej kopii'),'503');
  });
  await t.test('settings: save body with the version, connection test, daily report; viewer sees no form',async()=>{
   reset();const el=await mount(m.FiscalPrinterSettingsPanel,{admin:true,readOnly:false});await until(()=>buttons(el,'Zapisz konfigurację').length,'form');
   assert(el.textContent.includes('Aktywna: Kasa sklepu · Posnet · 127.0.0.1:4339 · numer unikatowy DYN12345678 · wersja 2'));
   await set(field(el,'Port'),'4340');await set(el.querySelector('select[aria-label="Litera PTU F"]'),'23');
   assert(buttons(el,'Zapisz konfigurację')[0].disabled,'duplicate PTU blocks saving');assert(el.textContent.includes('Ta sama stawka PTU'));
   await set(el.querySelector('select[aria-label="Litera PTU F"]'),'');await click(buttons(el,'Zapisz konfigurację')[0]);await until(()=>el.textContent.includes('Zapisano konfigurację'),'saved');
   assert.deepEqual(fx.posts[0],['PUT','/api/receipt233/printer',{version:2,name:'Kasa sklepu',model_family:'posnet',host:'127.0.0.1',port:4340,unique_number:'DYN12345678',ptu,active:true}]);
   await set(field(el,'Numer unikatowy kasy'),'ABC00000001');assert(el.textContent.includes('Inny numer unikatowy to nowe urządzenie'));
   await click(buttons(el,'Sprawdź połączenie')[0]);await until(()=>el.textContent.includes('Drukarka odpowiada: numer unikatowy DYN12345678'),'test');
   assert.equal(fx.posts[1][2].version,null);
   await click(buttons(el,'Drukuj raport dobowy')[0]);await until(()=>el.textContent.includes('Wydrukowano raport dobowy nr 0001 za 2026-10-25'),'daily');
   assert(el.textContent.includes('Zgodny z paragonami aplikacji'));assert.deepEqual(fx.posts[2],['POST','/api/receipt233/daily-reports',{confirmed:true}]);
   reset({configure:false});const v=await mount(m.FiscalPrinterSettingsPanel,{admin:false,readOnly:false});await until(()=>v.textContent.includes('Konfigurację drukarki zmienia administrator.'),'viewer');
   assert(!buttons(v,'Zapisz konfigurację').length);await click(buttons(v,'Sprawdź połączenie')[0]);await until(()=>v.textContent.includes('Drukarka odpowiada'),'stored test');
   assert.deepEqual(fx.posts[0],['POST','/api/receipt233/printer/test',{}],'a viewer tests only the stored printer');
  });
 }finally{for(const h of handles){await React.act(async()=>h.root.unmount());h.el.remove();}globalThis.fetch=oldFetch;await vite.close();dom.window.close();for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
});
