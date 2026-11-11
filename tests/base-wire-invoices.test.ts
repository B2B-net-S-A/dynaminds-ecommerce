/** Actual Base invoices family service + registry on CLOSED native ports.
 * The real SQL/RLS/native local invoices are covered by base-wire-invoices.database.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createBaseWireInvoicesService, createBaseWireInvoicesFamily, BASE_WIRE_INVOICES_METHODS, baseWireInvoicesScope, isBaseWireInvoicesWrite, baseWireShippingVat,
  type BaseWireInvoicesNative, type BaseWireInvoice, type BaseWireNativeInvoiceInput } from '../server/base-wire-invoices';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { baseWireRequiredScopes } from '../server/developer-api';
import { Problem, ensure } from '../server/errors';
import type { Actor } from '../server/domain';

const uid=(n:number)=>`74000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=(t:number,role:Actor['role']='admin'):Actor=>({tenantId:uid(t),userId:uid(10+t),role,apiKeyId:uid(20+t),source:'api'});
const CRED={credential:'dyna_api_closed'};
const address={street:'Prosta 1',postal_code:'00-001',city:'Warszawa',country:'PL'};
function fixture(opts:{allocateOnRead?:boolean}={}) {
  const s={
    series:[{tenant:uid(1),id:uid(41),public_id:7,name:'Sklep',prefix:'FV'},{tenant:uid(2),id:uid(42),public_id:8,name:'Obca',prefix:'OB'}],
    orders:[{tenant:uid(1),id:uid(51),public:301,facts:{version:'4',customer_name:' Jan Base ',address,shipping_cost:1000,vats:[23],shipped_on:'2026-10-20'}},
      {tenant:uid(1),id:uid(52),public:302,facts:{version:'2',customer_name:'Anna',address:{...address,country:'DE'},shipping_cost:0,vats:[23],shipped_on:'2026-10-20'}},
      {tenant:uid(1),id:uid(53),public:303,facts:{version:'2',customer_name:'Ewa',address,shipping_cost:0,vats:[23],shipped_on:null}},
      {tenant:uid(1),id:uid(54),public:304,facts:{version:'2',customer_name:'Ola',address,shipping_cost:500,vats:[8,23],shipped_on:'2026-10-21'}},
      {tenant:uid(1),id:uid(56),public:306,facts:{version:'3',customer_name:'Iza',address,shipping_cost:0,vats:[5,8],shipped_on:'2026-10-22'}},
      {tenant:uid(2),id:uid(55),public:305,facts:{version:'1',customer_name:'Obcy',address,shipping_cost:0,vats:[23],shipped_on:'2026-10-21'}}],
    issued:[] as {tenant:string;order:string;input:BaseWireNativeInvoiceInput;doc:string;public?:number}[],
    idempotency:[] as {tenant:string;key:string;hash:string;response:any}[],allocations:[] as {tenant:string;kind:string;writing:boolean}[],
    frames:[] as {tenant:string;mode:string;credential:string}[],nextPublic:900,
  };
  let state=structuredClone(s),writing=false;
  const invoice=(i:typeof s.issued[number]):BaseWireInvoice=>({public_id:i.public!,order_public_id:state.orders.find(o=>o.id===i.order)!.public,series_public_id:7,number:'FV/2026/00000'+i.public!%10,
    year:2026,sequence:1,created:1761000000,sell_date:i.input.sell_date,due_date:'2026-11-05',currency:'PLN',gross_minor:'6100',net_minor:'4960',notes:'Uwagi',
    seller:{name:'Sprzedawca',street:'Rynek 2',postal_code:'30-001',city:'Kraków',tax_id:'5260250274'},buyer:{name:i.input.buyer.name,street:'Prosta 1',postal_code:'00-001',city:'Warszawa',country:'PL'},
    lines:[{kind:'item',name:'Kubek',sku:'K-1',quantity:3,vat_rate:23,gross_minor:'5100',net_minor:'4146'},{kind:'shipping',name:'Dostawa',sku:'',quantity:1,vat_rate:23,gross_minor:'1000',net_minor:'813'}]});
  const native=(_c:unknown,a:Actor):BaseWireInvoicesNative=>{
    const t=a.tenantId;
    return {
      allocate:async kind=>{state.allocations.push({tenant:t,kind,writing});if(kind==='invoice')for(const i of state.issued)if(i.tenant===t&&i.public===undefined)i.public=state.nextPublic++;},
      series:async()=>state.series.filter(x=>x.tenant===t).map(({tenant:_t,...x})=>x),
      order:async n=>state.orders.find(o=>o.tenant===t&&o.public===n)?.id??null,
      orderFacts:async id=>structuredClone(state.orders.find(o=>o.tenant===t&&o.id===id)!.facts),
      issue:async(order,input)=>{ensure(!state.issued.some(i=>i.order===order),409,'Zamówienie ma już fakturę');const doc=uid(800+state.issued.length);state.issued.push({tenant:t,order,input:structuredClone(input),doc});return doc;},
      invoicePublicId:async doc=>state.issued.find(i=>i.tenant===t&&i.doc===doc)!.public!,
      invoices:async f=>state.issued.filter(i=>i.tenant===t&&i.public!==undefined&&(f.public_id===undefined||i.public===f.public_id)&&(f.id_from===undefined||i.public>=f.id_from)).slice(0,f.limit).map(invoice),
      file:async n=>{const i=state.issued.find(x=>x.tenant===t&&x.public===n);return i?{number:invoice(i).number,content:'<h1>Faktura ąę</h1>'}:null;},
      replay:async(key,hash)=>{let row=state.idempotency.find(x=>x.tenant===t&&x.key===key);if(!row)state.idempotency.push(row={tenant:t,key,hash,response:null});
        ensure(row.hash===hash,409,'Klucz polecenia wskazuje inną treść');return structuredClone(row.response);},
      remember:async(key,response)=>{state.idempotency.find(x=>x.tenant===t&&x.key===key)!.response=structuredClone(response);},
    };
  };
  let loseAck=false;
  const service=createBaseWireInvoicesService({allocateOnRead:opts.allocateOnRead??true,native:native as any,transaction:async(a,mode,credential,work)=>{
    const before=structuredClone(state),w=mode!=='read';writing=w;state.frames.push({tenant:a.tenantId,mode,credential});
    try{const r=await work({} as any);if(loseAck&&w){loseAck=false;throw new Problem(500,'lost ack');}return r;}catch(e){if(!(e instanceof Problem&&e.message==='lost ack'))state=before;throw e;}
  }});
  return {service,get state(){return state;},loseAck(){loseAck=true;}};
}
const status=(n:number)=>(e:any)=>e.status===n||(n===422&&e.name==='ZodError');

test('family registration: four methods, documents scopes, write requires read, credential custody', () => {
  const family=createBaseWireInvoicesFamily({available:true,service:{execute:async()=>({})}});
  assert.deepEqual([...family.methods],[...BASE_WIRE_INVOICES_METHODS]);assert.equal(family.nativeCredentialCustody,true);assert.equal(family.label,'faktur');
  assert.deepEqual(BASE_WIRE_INVOICES_METHODS.map(m=>[baseWireInvoicesScope(m),isBaseWireInvoicesWrite(m)]),[['documents:read',false],['documents:write',true],['documents:read',false],['documents:read',false]]);
  assert.deepEqual(baseWireRequiredScopes('documents:write'),['documents:read','documents:write']);
  assert.throws(()=>isBaseWireInvoicesWrite('addInvoiceCorrection'),status(400));
  assert.equal(createBaseWireInvoicesFamily({available:'yes' as any,service:{execute:async()=>({})}}).available,false);
});

test('addInvoice maps the own order to the native preview body and returns the allocated invoice_id; replay issues nothing', async () => {
  const f=fixture(),key='74000000-0000-4000-8000-000000000999';
  const r=await f.service.execute(actor(1),'addInvoice',{order_id:301,series_id:7},{clientKey:key,...CRED});
  assert.deepEqual(r,{invoice_id:900});
  assert.deepEqual(f.state.issued[0].input,{series_id:uid(41),order_version:'4',shipping_vat:23,sell_date:'2026-10-20',
    buyer:{kind:'consumer',name:'Jan Base',street:'Prosta 1',postal_code:'00-001',city:'Warszawa',country:'PL'}});
  assert.deepEqual(f.state.frames.at(-1),{tenant:uid(1),mode:'write',credential:CRED.credential});
  // Lost ACK: the retry with the same key returns the retained answer, no second issue.
  f.loseAck();await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:306,series_id:7,vat_rate:'ITEM'},{clientKey:'74000000-0000-4000-8000-000000000998',...CRED}),status(500));
  assert.equal(f.state.issued[1].input.shipping_vat,8,'free delivery takes the highest item rate');
  assert.deepEqual(await f.service.execute(actor(1),'addInvoice',{order_id:301,series_id:7},{clientKey:key,...CRED}),r);
  assert.equal(f.state.issued.length,2,'the lost-ack write committed once, the replay added none');
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:301,series_id:7,vat_rate:'DEFAULT'},{clientKey:key,...CRED}),status(409));
  // Without a key the native one-invoice-per-order rule refuses a duplicate.
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:301,series_id:7},CRED),status(409));
  assert.equal(f.state.issued.length,2);
});

test('addInvoice refusals: foreign order/series, scope of the native invoice, VAT policy, role, custody, unmapped fields', async () => {
  const f=fixture();
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:305,series_id:7},CRED),status(404));
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:301,series_id:8},CRED),status(404));
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:302,series_id:7},CRED),status(422));
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:303,series_id:7},CRED),status(409));
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:304,series_id:7},CRED),(e:any)=>e.status===422&&e.code==='LOCAL_BASE_WIRE_SHIPPING_VAT');
  for(const vat_rate of ['EXPT','ZW','NP','OO',23,'23'])
    await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:301,series_id:7,vat_rate},CRED),(e:any)=>e.status===422&&e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:301,series_id:7,sell_date:'2026-10-20'},CRED),status(422));
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:'301',series_id:7},CRED),status(422));
  await assert.rejects(f.service.execute(actor(1,'viewer'),'addInvoice',{order_id:301,series_id:7},CRED),status(403));
  await assert.rejects(f.service.execute(actor(1),'addInvoice',{order_id:301,series_id:7}),status(503));
  assert.equal(f.state.issued.length,0);
});

test('LOCAL delivery VAT: single item rate, highest rate for free delivery, refusal for paid mixed delivery', () => {
  assert.equal(baseWireShippingVat([8,8],500),8);assert.equal(baseWireShippingVat([5,23],0),23);
  assert.throws(()=>baseWireShippingVat([5,23],1),(e:any)=>e.status===422);assert.throws(()=>baseWireShippingVat([],0),status(409));assert.throws(()=>baseWireShippingVat([7],0),status(409));
});

test('getSeries, getInvoices and getInvoiceFile: own data only, allocation before the read snapshot, local flags', async () => {
  const f=fixture();
  assert.deepEqual(await f.service.execute(actor(1),'getSeries',{},CRED),{series:[{id:7,type:'INVOICE',name:'Sklep',format:'FV/%Y/%N'}]});
  assert.deepEqual(f.state.allocations.at(-1),{tenant:uid(1),kind:'invoice_series',writing:true});
  // Allocation before a read uses the READ gate of the key (a read-only key may list).
  assert.deepEqual(f.state.frames.slice(-2).map(x=>x.mode),['allocate','read']);
  await assert.rejects(f.service.execute(actor(1),'getSeries',{type:'INVOICE'},CRED),status(422));
  const {invoice_id}=await f.service.execute(actor(1),'addInvoice',{order_id:301,series_id:7},CRED);
  // A natively issued invoice without an ID yet gets one at the next read.
  f.state.issued.push({tenant:uid(1),order:uid(54),input:{...f.state.issued[0].input,sell_date:'2026-10-21'},doc:uid(899)});
  const listed=(await f.service.execute(actor(1),'getInvoices',{id_from:invoice_id},CRED)).invoices as any[];
  assert.deepEqual(listed.map(i=>i.invoice_id),[900,901]);
  assert.deepEqual(f.state.allocations.slice(-3).map(x=>x.kind),['order','invoice_series','invoice']);
  const dto=listed[0];
  assert.deepEqual({...dto,items:undefined},{invoice_id:900,order_id:301,series_id:7,type:'normal',number:'FV/2026/000000',sub_id:1,month:0,year:2026,postfix:'',
    date_add:1761000000,date_sell:Date.UTC(2026,9,20)/1000,date_pay_to:Date.UTC(2026,10,5)/1000,currency:'PLN',total_price_brutto:61,total_price_netto:49.6,payment:'',additional_info:'Uwagi',
    invoice_fullname:'Jan Base',invoice_company:'',invoice_nip:'',invoice_address:'Prosta 1',invoice_postcode:'00-001',invoice_city:'Warszawa',invoice_country:'',invoice_country_code:'PL',
    seller:'Sprzedawca\r\nRynek 2\r\n30-001 Kraków\r\nNIP 5260250274',issuer:'',correcting_to_invoice_id:0,correcting_reason:'',correcting_items:false,correcting_data:false,
    external_invoice_number:'',exchange_currency:'',exchange_rate:0,exchange_date:'',exchange_info:'',external_id:0,items:undefined});
  assert.deepEqual(dto.items,[{name:'Kubek',sku:'K-1',ean:'',price_brutto:17,price_netto:13.82,tax_rate:23,quantity:3,is_shipment:0,order_product_id:0},
    {name:'Dostawa',sku:'',ean:'',price_brutto:10,price_netto:8.13,tax_rate:23,quantity:1,is_shipment:1,order_product_id:0}]);
  assert.deepEqual(((await f.service.execute(actor(1),'getInvoices',{get_external_invoices:false,invoice_id:901},CRED)).invoices as any[]).map((i:any)=>i.invoice_id),[901]);
  await assert.rejects(f.service.execute(actor(1),'getInvoices',{get_government_data:true},CRED),(e:any)=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FLAG');
  await assert.rejects(f.service.execute(actor(1),'getInvoices',{date_to:1},CRED),status(422));
  assert.deepEqual((await f.service.execute(actor(2),'getInvoices',{},CRED)).invoices,[]);
  const file=await f.service.execute(actor(1),'getInvoiceFile',{invoice_id:900,get_external:true},CRED);
  assert.deepEqual(file,{invoice:'data:'+Buffer.from('<h1>Faktura ąę</h1>').toString('base64'),invoice_number:'FV/2026/000000'});
  await assert.rejects(f.service.execute(actor(2),'getInvoiceFile',{invoice_id:900},CRED),status(404));
  await assert.rejects(f.service.execute(actor(1),'getInvoiceFile',{invoice_id:900}),status(503));
  // A read-only copy never allocates on read.
  const ro=fixture({allocateOnRead:false});await ro.service.execute(actor(1),'getInvoices',{},CRED);await ro.service.execute(actor(1),'getSeries',{},CRED);
  assert.deepEqual(ro.state.allocations,[]);assert(ro.state.frames.every(x=>x.mode==='read'));
});

test('connector.php hands the authenticated credential to the invoices family only and refuses writes on a read-only copy', async () => {
  const seen:any[]=[];
  const family=createBaseWireInvoicesFamily({available:true,service:{execute:async(_a,m,p,o)=>{seen.push([m,p,o]);return {series:[]};}}});
  for(const readOnly of [false,true]){
    const app=Fastify();
    registerBaseWireRoutes(app,{readOnly,families:[family],authenticate:async(_t,scope)=>{assert(scope.startsWith('documents:'));return {id:uid(11),tenant_id:uid(1),role:'admin',api_key_id:uid(21),scopes:['documents:read','documents:write']};}});
    const send=(method:string)=>app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'tok-1'},
      payload:new URLSearchParams({method,parameters:'{}'}).toString()});
    assert.equal((await send('getSeries')).statusCode,200);
    assert.equal((await send('addInvoice')).statusCode,readOnly?423:200);
    await app.close();
  }
  assert.deepEqual(seen.map(x=>[x[0],x[2].credential]),[['getSeries','tok-1'],['addInvoice','tok-1'],['getSeries','tok-1']]);
});
