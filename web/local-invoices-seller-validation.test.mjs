/** Actual React form and server-rule parity; controlled fetch only, no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {createServer} from 'vite';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('local invoice series checks NIP before dispatch and explains invalid input',async t=>{
 const React=await import('react'),{JSDOM}=await import('jsdom');
 const dom=new JSDOM('<!doctype html><body/>',{url:'http://127.0.0.1/'}),saved=new Map(),oldFetch=globalThis.fetch;
 for(const[k,v]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:v});}
 const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
 const {createRoot}=await import('react-dom/client'),{LocalInvoiceRegister}=await vite.ssrLoadModule(path.resolve('web/local-invoices.tsx')),api=await vite.ssrLoadModule(path.resolve('web/api.ts'));
 const {validLocalInvoiceSellerNip}=await vite.ssrLoadModule(path.resolve('web/local-invoice-seller-validation.ts')),{validLocalInvoiceNip}=await vite.ssrLoadModule(path.resolve('server/local-invoice-values.ts'));
 const tick=()=>React.act(async()=>{await new Promise(r=>setTimeout(r,0));});
 async function until(fn){for(let n=0;n<80&&!fn();n++)await tick();assert(fn(),'expected controlled form state');}
 let root,el,series=[],posts=[];
 const flags={available:true,read_only:false,current_role:'admin',can_read:true,can_write:true,can_create_series:true};
 const scope={countries:['PL'],currencies:['PLN'],vat_rates:[0,5,8,23],buyer_kinds:['consumer'],source_statuses:['shipped','delivered'],b2b_state:'not_supported',ksef_state:'not_submitted',fiscalized:false};
 try{
  await t.test('browser rule matches the existing server for checksum, zero and malformed cases',()=>{
   const values=['','0000000000','5260250274','5260250275','1234567890','123456789','12345678901','PL5260250274','526-025-02-74',' 5260250274','5260250274 ','526025027\n','abcdefghij'];
   for(const value of values)assert.equal(validLocalInvoiceSellerNip(value),validLocalInvoiceNip(value),value);
   assert.equal(validLocalInvoiceSellerNip('5260250274'),true);assert.equal(validLocalInvoiceSellerNip('0000000000'),false);
   for(const value of [null,undefined,5260250274,{},['5260250274']])assert.equal(validLocalInvoiceSellerNip(value),false);
  });
  await t.test('invalid checksum keeps Save disabled with an associated Polish hint; valid input sends exact NIP',async()=>{
   globalThis.fetch=async(url,init={})=>{
    const route=new URL(String(url),'http://127.0.0.1').pathname,method=init.method??'GET';
    if(route==='/api/auth/me')return Response.json({user:{id:id(2),tenant_id:id(1),role:'admin'},restore_preview:false});
    if(route==='/api/local-invoices/options')return Response.json({...flags,scope});
    if(route==='/api/local-invoices/series'&&method==='GET')return Response.json({...flags,data:series,next_cursor:null});
    if(route==='/api/local-invoices/documents'&&method==='GET')return Response.json({...flags,data:[],next_cursor:null});
    assert.equal(route,'/api/local-invoices/series');assert.equal(method,'POST');const body=JSON.parse(init.body);posts.push(body);assert.equal(body.seller.tax_id,'5260250274');
    const created={...body,id:id(3),version:1,created_at:'2026-10-18T18:00:00Z'};delete created.client_key;series=[created];return Response.json({...flags,series:created},{status:201});
   };
   api.setWorkspace(id(1));el=document.createElement('div');document.body.append(el);root=createRoot(el);
   await React.act(async()=>root.render(React.createElement(LocalInvoiceRegister,{contextKey:`${id(1)}:${id(2)}:admin:false`,readOnly:false,refresh:0})));
   await until(()=>el.querySelector('.local-invoices-series fieldset')&&!el.querySelector('.local-invoices-series fieldset').disabled);
   const field=label=>[...el.querySelectorAll('label')].find(l=>l.textContent.startsWith(label)).querySelector('input');
   async function change(label,value){const input=field(label);await React.act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});}
   for(const[label,value]of [['Nazwa serii','Własna seria'],['Pełna nazwa sprzedawcy','Własny sprzedawca'],['Adres sprzedawcy','Testowa 1'],['Kod pocztowy sprzedawcy','00-001'],['Miejscowość sprzedawcy','Warszawa']])await change(label,value);
   const consent=field('Potwierdzam dane sprzedawcy');await React.act(async()=>consent.click());
   const save=()=>[...el.querySelectorAll('button')].find(b=>b.textContent==='Zapisz serię');
   assert(save().disabled);assert(!field('NIP sprzedawcy').hasAttribute('aria-describedby'));
   for(const value of ['0000000000','5260250275','12345']){
    await change('NIP sprzedawcy',value);assert(save().disabled);const nip=field('NIP sprzedawcy');assert.equal(nip.getAttribute('aria-invalid'),'true');const hint=document.getElementById(nip.getAttribute('aria-describedby'));assert(hint);assert.match(hint.textContent,/Wpisz poprawny NIP: 10 cyfr z prawidłową sumą kontrolną/);await React.act(async()=>save().click());assert.equal(posts.length,0);
   }
   await change('NIP sprzedawcy','5260250274');assert.equal(save().disabled,false);assert.equal(field('NIP sprzedawcy').getAttribute('aria-invalid'),'false');assert(!field('NIP sprzedawcy').hasAttribute('aria-describedby'));assert(!el.textContent.includes('Wpisz poprawny NIP'));
   await React.act(async()=>save().click());await until(()=>posts.length===1&&field('Nazwa serii').value==='');
   assert.equal(posts.length,1);assert.equal(posts[0].seller.tax_id,'5260250274');
  });
 }finally{if(root)await React.act(async()=>root.unmount());el?.remove();globalThis.fetch=oldFetch;await vite.close();dom.window.close();for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
});
