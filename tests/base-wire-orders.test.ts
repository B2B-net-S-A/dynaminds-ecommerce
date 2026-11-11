/** Actual Base orders family service + registry on CLOSED native ports.
 * The real SQL/RLS/native OMS is covered by base-wire-orders.database.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createBaseWireOrdersService, createBaseWireOrdersFamily, BASE_WIRE_ORDERS_METHODS, baseWireOrdersScope, isBaseWireOrdersWrite,
  BASE_WIRE_STAGE_STATUSES, BASE_WIRE_RESERVED_STATUS_IDS, baseWireStageStatusId, baseWireExtraFieldId, baseWireOrderProductId,
  type BaseWireOrdersNative, type BaseWireOrder, type BaseWireOrderProduct, type BaseWireNativeOrderInput, type BaseWireExtraField,
  type BaseWireFieldChange, type BaseWirePaymentEntry, type BaseWireMergeInput, type BaseWireSplitInput } from '../server/base-wire-orders';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { baseWireRequiredScopes } from '../server/developer-api';
import { Problem, ensure } from '../server/errors';
import type { Actor } from '../server/domain';

const uid=(n:number)=>`73000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=(t:number,role:Actor['role']='admin'):Actor=>({tenantId:uid(t),userId:uid(10+t),role,apiKeyId:uid(20+t),source:'api'});
type Stored=BaseWireOrder&{tenant:string;id:string;public?:number};
function fixture(opts:{allocateOnRead?:boolean;warehouses?:number;merge?:boolean;split?:boolean}={}) {
  const s={
    statuses:[{tenant:uid(1),id:uid(41),public_id:5,name:'Nowe',color:'#111111',active:true},{tenant:uid(1),id:uid(42),public_id:6,name:'Wysłane',color:'#222222',active:false},
      {tenant:uid(2),id:uid(43),public_id:7,name:'Obce',color:'#333333',active:true}],
    warehouses:[{tenant:uid(1),id:uid(31),public_id:11},{tenant:uid(1),id:uid(32),public_id:12},{tenant:uid(2),id:uid(33),public_id:13}].slice(0,opts.warehouses??3),
    products:[
      {tenant:uid(1),id:uid(51),public_id:101,kind:'simple',parent_public_id:null,catalog_public_id:3,sku:'A-1',ean:'5901',vat:23},
      {tenant:uid(1),id:uid(52),public_id:102,kind:'group',parent_public_id:null,catalog_public_id:3,sku:'G-1',ean:null,vat:8},
      {tenant:uid(1),id:uid(53),public_id:103,kind:'variant',parent_public_id:102,catalog_public_id:3,sku:'G-1-M',ean:'5902',vat:8},
      {tenant:uid(2),id:uid(56),public_id:106,kind:'simple',parent_public_id:null,catalog_public_id:4,sku:'F-1',ean:null,vat:23},
    ] as (BaseWireOrderProduct&{tenant:string})[],
    orders:[] as Stored[],created:[] as BaseWireNativeOrderInput[],payments:[] as string[],statusChanges:[] as [string,string][],stageChanges:[] as [string,string][],
    idempotency:[] as {tenant:string;key:string;hash:string;response:any}[],allocations:[] as {tenant:string;writing:boolean}[],nextPublic:500,
    fields:[
      {tenant:uid(1),id:'5f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f0a12',key:'note',label:'Uwagi',type:'text',version:2,enabled:true,options:[]},
      {tenant:uid(1),id:'0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d',key:'gift',label:'Opakowanie',type:'select',version:1,enabled:true,
        options:[{id:uid(61),label:'Papier',enabled:true},{id:uid(62),label:'Folia',enabled:false}]},
      {tenant:uid(1),id:'99999999-8888-4777-8666-555555555555',key:'tags',label:'Etykiety',type:'multi_select',version:1,enabled:true,
        options:[{id:uid(63),label:'VIP',enabled:true},{id:uid(64),label:'B2B',enabled:true}]},
      {tenant:uid(1),id:'12345678-1234-4234-8234-123456789abc',key:'scan',label:'Skan',type:'file',version:1,enabled:true,options:[]},
      {tenant:uid(1),id:'abcdefab-cdef-4abc-9def-abcdefabcdef',key:'old',label:'Stare',type:'number',version:3,enabled:false,options:[]},
      {tenant:uid(2),id:'fedcba98-7654-4321-8fed-cba987654321',key:'foreign',label:'Obce',type:'text',version:1,enabled:true,options:[]},
    ] as (BaseWireExtraField&{tenant:string})[],
    fieldPatches:[] as [string,BaseWireFieldChange[]][],ledger:[] as (BaseWirePaymentEntry&{order:string})[],versions:{} as Record<string,number>,
    merges:[] as {actor:Actor;credential:string;input:BaseWireMergeInput}[],
    splits:[] as {actor:Actor;credential:string;input:BaseWireSplitInput}[],
  };
  let state=structuredClone(s),writing=false;
  const native=(_c:unknown,a:Actor):BaseWireOrdersNative=>{
    const t=a.tenantId;
    return {
      statuses:async()=>state.statuses.filter(x=>x.tenant===t).map(({tenant:_t,...x})=>x),
      warehouses:async()=>state.warehouses.filter(x=>x.tenant===t).map(({tenant:_t,...x})=>x),
      products:async by=>state.products.filter(p=>p.tenant===t&&(by.public_ids.includes(p.public_id)||by.skus.includes(p.sku)||(p.ean!==null&&by.eans.includes(p.ean)))).map(({tenant:_t,...p})=>p),
      allocate:async()=>{state.allocations.push({tenant:t,writing});for(const o of state.orders)if(o.tenant===t&&o.public===undefined)o.public=state.nextPublic++;},
      order:async n=>state.orders.find(o=>o.tenant===t&&o.public===n)?.id??null,
      publicId:async id=>state.orders.find(o=>o.tenant===t&&o.id===id)!.public!,
      orders:async f=>{const rows=state.orders.filter(o=>o.tenant===t&&o.public!==undefined&&(f.public_id===undefined||o.public===f.public_id)&&(f.status_public_id===undefined||o.status_public_id===f.status_public_id)&&(f.stage===undefined||(o.status_public_id===null&&o.status===f.stage))
          &&(f.email===undefined||o.email.toLowerCase()===f.email.toLowerCase())&&(f.phone===undefined||o.address.phone===f.phone));
        return (f.descending?rows.reverse():rows).slice(0,f.limit).map(({tenant:_t,id:_i,public:p,...o})=>({...o,public_id:p!}));},
      replay:async(key,hash)=>{let row=state.idempotency.find(x=>x.tenant===t&&x.key===key);if(!row)state.idempotency.push(row={tenant:t,key,hash,response:null});
        ensure(row.hash===hash,409,'Klucz polecenia wskazuje inną treść');return structuredClone(row.response);},
      remember:async(key,response)=>{state.idempotency.find(x=>x.tenant===t&&x.key===key)!.response=structuredClone(response);},
      create:async input=>{const id=uid(900+state.orders.length);state.created.push(structuredClone(input));
        state.orders.push({tenant:t,id,public_id:0,source:input.source,external_id:null,status_public_id:null,created:1760000000,in_status:1760000000,currency:input.currency,
          payment_mode:input.payment_mode,paid:0,note:input.note,email:input.email,customer_name:input.customer_name,address:input.address,shipping_cost:input.shipping_cost,
          carrier:null,tracking:null,picked:false,status:'new',warehouse_public_id:state.warehouses.find(w=>w.id===input.warehouse_id)!.public_id,lines:[]});return id;},
      payInFull:async id=>{state.payments.push(id);const o=state.orders.find(x=>x.id===id)!;o.status='paid';},
      setStatus:async(id,status)=>{const st=state.statuses.find(x=>x.id===status)!;ensure(st.active,422,'Własny status jest nieaktywny');state.statusChanges.push([id,status]);
        state.orders.find(x=>x.id===id)!.status_public_id=st.public_id;},
      // Closed subset of the native set_status rules: same stage is no change, otherwise transitions apply.
      setStage:async(id,stage)=>{const o=state.orders.find(x=>x.id===id)!;
        if(o.status===stage)return {kept_workflow:o.status_public_id!==null};
        ensure(({new:['paid','cancelled'],paid:['picking','cancelled']} as Record<string,string[]>)[o.status]?.includes(stage),409,`Niedozwolona zmiana statusu ${o.status} → ${stage}`);
        state.stageChanges.push([id,stage]);o.status=stage;o.status_public_id=null;return {kept_workflow:false};},
      extraFields:async()=>state.fields.filter(x=>x.tenant===t).map(({tenant:_t,...x})=>x),
      patchFields:async(id,changes)=>{state.fieldPatches.push([id,structuredClone(changes)]);},
      paymentState:async id=>{const o=state.orders.find(x=>x.id===id)!;
        return {net:state.ledger.filter(e=>e.order===id).reduce((n,e)=>n+(e.kind==='receipt'?e.amount:e.kind==='refund'?-e.amount:0),0),currency:o.currency,version:state.versions[id]??1};},
      receipt:async(id,e)=>{ensure(e.version===(state.versions[id]??1),409,'Zamówienie zmieniło się');state.versions[id]=e.version+1;
        state.ledger.push({order:id,kind:'receipt',reversal:false,amount:e.amount,method:'other',reference:e.reference,note:e.note,created:1760000100+state.ledger.length});},
      payments:async id=>({total:9248,currency:state.orders.find(x=>x.id===id)!.currency,entries:state.ledger.filter(e=>e.order===id).map(({order:_o,...e})=>e)}),
    };
  };
  let loseAck=false;
  // Closed transaction port: all-or-nothing state, optionally losing the COMMIT acknowledgement.
  // Closed native merge: preview + execute replay by their command keys; technical_merge creates a new order.
  const merge=async(a:Actor,credential:string,input:BaseWireMergeInput)=>{
    const prior=state.merges.find(m=>m.input.execute_key===input.execute_key);if(prior)return prior.input.merge_mode==='into_main_order'?prior.input.main_order_id:uid(990);
    state.merges.push({actor:a,credential,input:structuredClone(input)});
    if(input.merge_mode==='into_main_order')return input.main_order_id;
    const main=state.orders.find(o=>o.id===input.main_order_id)!;state.orders.push({...structuredClone(main),id:uid(990),public:undefined,source:'order_merge'});return uid(990);};
  // Closed native split: preview + execute replay by the execute key; every split creates one child order.
  const split=async(a:Actor,credential:string,input:BaseWireSplitInput)=>{
    const prior=state.splits.findIndex(m=>m.input.execute_key===input.execute_key);if(prior>=0)return uid(970+prior);
    ensure(input.items.every(i=>i.order_product_id===baseWireOrderProductId(uid(800))),404,'Nie znaleziono pozycji zamówienia');
    state.splits.push({actor:a,credential,input:structuredClone(input)});
    const parent=state.orders.find(o=>o.id===input.order_id)!,child=uid(970+state.splits.length-1);
    state.orders.push({...structuredClone(parent),id:child,public:undefined,source:'order_split'});return child;};
  const service=createBaseWireOrdersService({allocateOnRead:opts.allocateOnRead??true,native:native as any,...(opts.merge===false?{}:{merge}),...(opts.split===false?{}:{split}),transaction:async(_a,w,work)=>{
    const before=structuredClone(state);writing=w;
    try{const r=await work({} as any);if(loseAck&&w){loseAck=false;throw new Problem(500,'lost ack');}return r;}catch(e){if(!(e instanceof Problem&&e.message==='lost ack'))state=before;throw e;}
  }});
  return {service,get state(){return state;},loseAck:()=>{loseAck=true;}};
}
const order={delivery_fullname:'Jan Kowalski',email:'jan@example.com',phone:'500600700',delivery_address:'Prosta 1',delivery_postcode:'00-001',delivery_city:'Warszawa',
  delivery_country_code:'pl',currency:'PLN',payment_method_cod:0,paid:0,delivery_price:12.5,admin_comments:'Pilne',date_add:1760000000,
  products:[{storage:'db',storage_id:0,product_id:'101',variant_id:0,name:'Kubek',sku:'A-1',ean:'5901',warehouse_id:11,price_brutto:19.99,tax_rate:23,quantity:2,weight:0.3}]};

test('orders scopes: reads orders:read, writes orders:write which also requires orders:read',()=>{
  assert.deepEqual(BASE_WIRE_ORDERS_METHODS.map(m=>[baseWireOrdersScope(m),isBaseWireOrdersWrite(m)]),
    [['orders:read',false],['orders:write',true],['orders:read',false],['orders:write',true],['orders:read',false],['orders:read',false],
      ['order-fields:read',false],['order-fields:write',true],['orders:write',true],['orders:read',false],['orders:write',true],['orders:write',true]]);
  assert.deepEqual(baseWireRequiredScopes('order-fields:write'),['order-fields:read','order-fields:write']);
  assert.equal(BASE_WIRE_ORDERS_METHODS.includes('addOrderBySplit'),true,'native 222 split');
  assert.deepEqual(baseWireRequiredScopes('orders:write'),['orders:read','orders:write']);
  assert.deepEqual(baseWireRequiredScopes('orders:read'),['orders:read']);
  assert.throws(()=>baseWireOrdersScope('deleteOrders'),(e:any)=>e.status===400);
  const family=createBaseWireOrdersFamily({service:{execute:async()=>({})},available:true});
  assert.equal(family.label,'zamówień');assert.equal(family.nativeCredentialCustody,true);
});
const stageList=BASE_WIRE_STAGE_STATUSES.map(s=>({id:s.id,name:s.name,color:'#3455db',group_id:0,is_primary:0,name_for_customer:s.name}));
test('getOrderStatusList returns own workflow statuses, then the fixed native stages, numeric IDs only',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.execute(actor(1),'getOrderStatusList',{}),{statuses:[
    {id:5,name:'Nowe',color:'#111111',group_id:0,is_primary:0,name_for_customer:'Nowe'},
    {id:6,name:'Wysłane',color:'#222222',group_id:0,is_primary:0,name_for_customer:'Wysłane'},...stageList]});
  assert.deepEqual(((await f.service.execute(actor(2),'getOrderStatusList',{})).statuses as any[]).map(s=>s.id),[7,...BASE_WIRE_STAGE_STATUSES.map(s=>s.id)]);
  // A fresh company with no workflow status still gets the native stages.
  const fresh=fixture();fresh.state.statuses.length=0;
  assert.deepEqual(await fresh.service.execute(actor(1),'getOrderStatusList',{}),{statuses:stageList});
  await assert.rejects(f.service.execute(actor(1),'getOrderStatusList',{x:1}),(e:any)=>e.name==='ZodError');
});
test('addOrder maps Base fields to one native order, pays in full and sets the workflow status',async()=>{
  const f=fixture();
  const r=await f.service.execute(actor(1),'addOrder',{...order,paid:'1',order_status_id:5});
  assert.deepEqual(r,{order_id:500});
  assert.deepEqual(f.state.created,[{customer_name:'Jan Kowalski',email:'jan@example.com',warehouse_id:uid(31),source:'manual',currency:'PLN',payment_mode:'prepaid',
    address:{street:'Prosta 1',city:'Warszawa',postal_code:'00-001',country:'PL',phone:'500600700'},shipping_cost:1250,
    items:[{product_id:uid(51),quantity:2}],manual_lines:[{product_id:uid(51),quantity:2,line_total:3998}],note:'Pilne'}]);
  assert.deepEqual(f.state.payments,[uid(900)]);assert.deepEqual(f.state.statusChanges,[[uid(900),uid(41)]]);
  assert.deepEqual(f.state.allocations,[{tenant:uid(1),writing:true}]);
  // Variant by numeric ID (product_id = parent), SKU lookup, COD, pick-up point; two lines of one product stay distinct.
  await f.service.execute(actor(1),'addOrder',{...order,payment_method_cod:true,delivery_point_id:'WAW01M',products:[
    {product_id:102,variant_id:103,quantity:1,price_brutto:'10.00',warehouse_id:12},{sku:'A-1',quantity:1,price_brutto:5},{sku:'A-1',quantity:3,price_brutto:4.5}]});
  const second=f.state.created[1];
  assert.equal(second.payment_mode,'cod');assert.equal(second.warehouse_id,uid(32));assert.equal(second.address.locker_code,'WAW01M');
  assert.deepEqual(second.items,[{product_id:uid(53),quantity:1},{product_id:uid(51),quantity:4}]);
  assert.deepEqual(second.manual_lines,[{product_id:uid(53),quantity:1,line_total:1000},{product_id:uid(51),quantity:1,line_total:500},{product_id:uid(51),quantity:3,line_total:1350}]);
  assert.equal(f.state.payments.length,1,'paid omitted: no payment');
  // EAN lookup.
  await f.service.execute(actor(1),'addOrder',{...order,products:[{ean:'5902',quantity:1,price_brutto:1,warehouse_id:11}]});
  assert.deepEqual(f.state.created[2].items,[{product_id:uid(53),quantity:1}]);
});
test('addOrder refuses unknown/foreign IDs, unmapped data and contradictory lines without effect',async()=>{
  const f=fixture();const reject=async(parameters:any,check:(e:any)=>boolean,a=actor(1))=>{
    await assert.rejects(f.service.execute(a,'addOrder',parameters),check);assert.equal(f.state.created.length,0);};
  const line=(x:any)=>({...order,products:[{...order.products[0],...x}]});
  await reject(line({product_id:'106'}),e=>e.status===404);              // other tenant's product
  await reject(line({product_id:'999'}),e=>e.status===404);              // unknown: no free-text line
  await reject(line({product_id:'',sku:'NOPE'}),e=>e.status===404);
  await reject(line({product_id:'101',variant_id:103}),e=>e.status===404); // variant of another parent
  await reject(line({warehouse_id:13}),e=>e.status===404);               // foreign warehouse
  await reject({...order,order_status_id:7},e=>e.status===404);           // foreign status
  await reject(line({sku:'B-2'}),e=>e.status===422);
  await reject(line({tax_rate:8}),e=>e.status===422);
  await reject(line({storage_id:4}),e=>e.status===404);
  await reject(line({price_brutto:1.001}),e=>e.status===422&&e.code==='LOCAL_BASE_WIRE_AMOUNT');
  await reject({...order,products:[{product_id:'101',quantity:1,warehouse_id:11}]},e=>e.name==='ZodError'); // price required
  await reject(line({location:'A-1'}),e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject(line({storage:'shop'}),e=>e.name==='ZodError');
  for(const field of ['user_comments','invoice_nip','delivery_method','payment_method','extra_field_1'])
    await reject({...order,[field]:'x'},e=>e.status===422&&e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({...order,want_invoice:1},e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({...order,custom_source_id:3},e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({...order,custom_extra_fields:{'1':'x'}},e=>e.name==='ZodError');
  await reject({...order,unknown:1},e=>e.name==='ZodError');
  await reject({...order,products:[]},e=>e.name==='ZodError');
  await reject({...order,paid:'yes'},e=>e.name==='ZodError');
  await reject(order,e=>e.status===403,actor(1,'viewer'));
  await reject({...order,products:[order.products[0],{...order.products[0],warehouse_id:12}]},e=>e.status===422);
  // Without warehouse_id a multi-warehouse company is ambiguous; a single warehouse is used.
  await reject(line({warehouse_id:0}),e=>e.status===422);
  const single=fixture({warehouses:1});
  await single.service.execute(actor(1),'addOrder',line({warehouse_id:0}));assert.equal(single.state.created[0].warehouse_id,uid(31));
  // Empty unmapped values are accepted (Base clients send them).
  await f.service.execute(actor(1),'addOrder',{...order,user_comments:'',invoice_nip:'',want_invoice:0,custom_source_id:0,custom_extra_fields:[]});
  assert.equal(f.state.created.length,1);
});
test('addOrder Idempotency-Key replays one order; another body under the key is 409',async()=>{
  const f=fixture(),key=uid(77);
  f.loseAck();
  await assert.rejects(f.service.execute(actor(1),'addOrder',{...order,paid:1},{clientKey:key}),(e:any)=>e.message==='lost ack');
  assert.equal(f.state.created.length,1);
  assert.deepEqual(await f.service.execute(actor(1),'addOrder',{...order,paid:1},{clientKey:key}),{order_id:500});
  assert.deepEqual(await f.service.execute(actor(1),'addOrder',{...order,paid:1},{clientKey:key}),{order_id:500});
  assert.equal(f.state.created.length,1);assert.equal(f.state.payments.length,1);
  await assert.rejects(f.service.execute(actor(1),'addOrder',{...order,paid:0},{clientKey:key}),(e:any)=>e.status===409);
  // The key is per tenant; a malformed key is refused before any effect.
  assert.deepEqual(await f.service.execute(actor(2),'addOrder',{...order,products:[{product_id:'106',quantity:1,price_brutto:1,warehouse_id:13}]},{clientKey:key}),{order_id:501});
  await assert.rejects(f.service.execute(actor(1),'addOrder',order,{clientKey:'nope'}),(e:any)=>e.name==='ZodError');
  assert.equal(f.state.created.length,2);
});
test('getOrders allocates pending IDs first, returns the Base DTO and refuses unsupported flags',async()=>{
  const f=fixture();
  await f.service.execute(actor(1),'addOrder',{...order,order_status_id:5});
  f.state.orders[0].lines=[{item_id:uid(800),product_public_id:103,parent_public_id:102,catalog_public_id:3,name:'Koszulka M',sku:'G-1-M',ean:null,quantity:2,line_total:3998,vat:8}];
  f.state.orders[0].paid=1250;f.state.orders[0].carrier='inpost';f.state.orders[0].tracking='TRK1';
  const r:any=await f.service.execute(actor(1),'getOrders',{date_confirmed_from:0,get_unconfirmed_orders:false});
  assert.equal(f.state.allocations.at(-1)!.writing,true);
  assert.deepEqual(r.orders[0],{order_id:500,shop_order_id:0,external_order_id:'',order_source:'personal',order_source_id:0,order_source_info:'',order_status_id:5,
    date_add:1760000000,date_confirmed:1760000000,date_in_status:1760000000,confirmed:true,user_login:'',currency:'PLN',payment_method:'',payment_method_cod:'0',
    payment_done:12.5,user_comments:'',admin_comments:'Pilne',email:'jan@example.com',phone:'500600700',delivery_method_id:0,delivery_method:'',delivery_price:12.5,
    delivery_package_module:'inpost',delivery_package_nr:'TRK1',delivery_fullname:'Jan Kowalski',delivery_company:'',delivery_address:'Prosta 1',delivery_postcode:'00-001',
    delivery_city:'Warszawa',delivery_state:'',delivery_country:'',delivery_country_code:'PL',delivery_point_id:'',delivery_point_name:'',delivery_point_address:'',
    delivery_point_postcode:'',delivery_point_city:'',invoice_fullname:'',invoice_company:'',invoice_nip:'',invoice_address:'',invoice_postcode:'',invoice_city:'',
    invoice_state:'',invoice_country:'',invoice_country_code:'',want_invoice:'0',extra_field_1:'',extra_field_2:'',order_page:'',pick_state:0,pack_state:0,star:0,crm_client_id:0,
    products:[{storage:'db',storage_id:3,order_product_id:baseWireOrderProductId(uid(800)),product_id:'102',variant_id:'103',name:'Koszulka M',sku:'G-1-M',ean:'',location:'',warehouse_id:11,
      warehouse_type:'bl',warehouse_source_id:0,auction_id:'',attributes:'',price_brutto:19.99,tax_rate:8,quantity:2,weight:0,bundle_id:0,transaction_id:'',transaction2_id:''}]});
  assert.deepEqual(JSON.stringify(r).match(/7300000/g),null,'numeric identities only');
  assert.deepEqual(await f.service.execute(actor(2),'getOrders',{order_id:500}),{orders:[]},'foreign order invisible');
  assert.deepEqual((await f.service.execute(actor(1),'getOrders',{status_id:6})).orders,[]);
  assert.deepEqual((await f.service.execute(actor(1),'getOrders',{filter_order_source:'nieznane'})).orders,[]);
  assert.deepEqual((await f.service.execute(actor(1),'getOrders',{filter_order_source:'personal',filter_order_source_id:3})).orders,[]);
  assert.deepEqual((await f.service.execute(actor(1),'getOrders',{filter_shop_order_id:9})).orders,[]);
  await assert.rejects(f.service.execute(actor(1),'getOrders',{include_commissions:true}),(e:any)=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FLAG');
  assert.ok(await f.service.execute(actor(1),'getOrders',{include_commissions:false}));
  await assert.rejects(f.service.execute(actor(1),'getOrders',{filter_order_source_id:3}),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(1),'getOrders',{filter_external_order_id:'x',filter_shop_order_id:1}),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(1),'getOrders',{order_id:0}),(e:any)=>e.name==='ZodError');
  // A read-only copy never allocates; the read itself is a read transaction.
  const ro=fixture({allocateOnRead:false});
  await ro.service.execute(actor(1),'getOrders',{});assert.deepEqual(ro.state.allocations,[]);
});
test('setOrderStatus changes the native workflow status of an own order only',async()=>{
  const f=fixture();
  await f.service.execute(actor(1),'addOrder',order);
  assert.deepEqual(await f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:5}),{});
  assert.deepEqual(f.state.statusChanges,[[uid(900),uid(41)]]);
  await assert.rejects(f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:6}),(e:any)=>e.status===422); // inactive natively
  await assert.rejects(f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:7}),(e:any)=>e.status===404); // foreign status
  await assert.rejects(f.service.execute(actor(2),'setOrderStatus',{order_id:500,status_id:7}),(e:any)=>e.status===404); // foreign order
  await assert.rejects(f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:5,x:1}),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(1,'viewer'),'setOrderStatus',{order_id:500,status_id:5}),(e:any)=>e.status===403);
  const key=uid(78);
  await f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:5},{clientKey:key});
  await assert.rejects(f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:6},{clientKey:key}),(e:any)=>e.status===409);
  assert.equal(f.state.statusChanges.length,2);
});
test('stage statuses: fixed reserved IDs, getOrders falls back to the stage, setOrderStatus runs the native stage transition',async()=>{
  // Stable table: every native stage once, IDs inside the reserved range, never renumbered.
  assert.deepEqual(BASE_WIRE_STAGE_STATUSES.map(s=>[s.stage,s.id]),[['new',2147483001],['paid',2147483002],['picking',2147483003],['packed',2147483004],
    ['shipped',2147483005],['delivered',2147483006],['completed',2147483007],['cancelled',2147483008],['return_initiated',2147483009],['return_received',2147483010],['return_completed',2147483011]]);
  for(const s of BASE_WIRE_STAGE_STATUSES)assert(s.id>=BASE_WIRE_RESERVED_STATUS_IDS.from&&s.id<=BASE_WIRE_RESERVED_STATUS_IDS.to);
  assert.throws(()=>baseWireStageStatusId('lost'),(e:any)=>e.status===503);
  const f=fixture();
  await f.service.execute(actor(1),'addOrder',order);
  const get=async(p:any={})=>(await f.service.execute(actor(1),'getOrders',p)).orders as any[];
  assert.equal((await get())[0].order_status_id,2147483001,'no workflow status: the stage status');
  assert.deepEqual((await get({status_id:2147483001})).map(o=>o.order_id),[500]);
  assert.deepEqual(await get({status_id:2147483002}),[]);
  // Stage status: native set_status (transition rules), clears the workflow status.
  assert.deepEqual(await f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:2147483002}),{});
  assert.deepEqual(f.state.stageChanges,[[uid(900),'paid']]);assert.equal((await get())[0].order_status_id,2147483002);
  // Impossible transition: the native 409, no change.
  await assert.rejects(f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:2147483005}),(e:any)=>e.status===409&&/paid → shipped/.test(e.message));
  // Same stage without a workflow status: no change, {}.
  assert.deepEqual(await f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:2147483002}),{});
  assert.equal(f.state.stageChanges.length,1);
  // Workflow status set: it wins in getOrders; its own stage status cannot drop it (no native operation).
  await f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:5});
  assert.equal((await get())[0].order_status_id,5);assert.deepEqual(await get({status_id:2147483002}),[]);
  await assert.rejects(f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:2147483002}),(e:any)=>e.status===409&&e.code==='LOCAL_BASE_WIRE_STAGE_STATUS');
  // A stage status in addOrder is applied after the payment; an unknown reserved ID is 404.
  await f.service.execute(actor(1),'addOrder',{...order,paid:1,order_status_id:2147483003});
  assert.deepEqual(f.state.stageChanges.at(-1),[uid(901),'picking']);
  await assert.rejects(f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:2147483500}),(e:any)=>e.status===404);
  // A workflow status whose 220 ID reached the reserved range fails closed instead of colliding.
  f.state.statuses[0].public_id=2147483001;f.state.orders[0].status_public_id=2147483001;
  for(const call of [()=>f.service.execute(actor(1),'getOrderStatusList',{}),()=>f.service.execute(actor(1),'getOrders',{}),
    ()=>f.service.execute(actor(1),'setOrderStatus',{order_id:500,status_id:6})])
    await assert.rejects(call(),(e:any)=>e.status===503&&e.code==='LOCAL_BASE_WIRE_STATUS_ID_RANGE');
});
test('connector.php: a read-only copy refuses order writes but serves reads; unknown family method is 400',async t=>{
  const f=fixture({allocateOnRead:false}),app=Fastify();t.after(()=>app.close());
  const scopes:string[]=[];
  registerBaseWireRoutes(app,{readOnly:true,families:[createBaseWireOrdersFamily({service:f.service,available:true})],
    authenticate:async(_token,scope)=>{scopes.push(scope);return {id:uid(11),tenant_id:uid(1),role:'admin',api_key_id:uid(21),scopes:[scope]};}});
  const call=(method:string,parameters:unknown)=>app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'dyna_api_closed'},
    payload:new URLSearchParams({method,parameters:JSON.stringify(parameters)}).toString()});
  const w=await call('addOrder',order);assert.equal(w.statusCode,423);assert.equal(w.json().status,'ERROR');assert.equal(f.state.created.length,0);
  const r=await call('getOrderStatusList',{});assert.equal(r.statusCode,200);assert.equal(r.json().status,'SUCCESS');
  assert.equal((await call('deleteOrders',{order_ids:[1]})).statusCode,400);
  assert.deepEqual(scopes,['orders:read']);
});
test('getOrdersByEmail/Phone: exact own matches, newest first, Base lookup fields only',async()=>{
  const f=fixture();
  await f.service.execute(actor(1),'addOrder',order);
  await f.service.execute(actor(1),'addOrder',{...order,email:'JAN@example.com',phone:'+48500600700',order_status_id:5});
  await f.service.execute(actor(1),'addOrder',{...order,email:'inny@example.com'});
  assert.deepEqual(await f.service.execute(actor(1),'getOrdersByEmail',{email:' jan@EXAMPLE.com '}),{orders:[
    {order_id:501,order_status_id:5,date_in_status:1760000000,date_add:1760000000},{order_id:500,order_status_id:2147483001,date_in_status:1760000000,date_add:1760000000}]});
  assert.equal(f.state.allocations.at(-1)!.writing,true,'pending IDs allocated before the read');
  assert.deepEqual(await f.service.execute(actor(1),'getOrdersByPhone',{phone:'500600700'}),{orders:[
    {order_id:502,order_status_id:2147483001,delivery_fullname:'Jan Kowalski',delivery_company:'',date_in_status:1760000000,date_add:1760000000},
    {order_id:500,order_status_id:2147483001,delivery_fullname:'Jan Kowalski',delivery_company:'',date_in_status:1760000000,date_add:1760000000}]});
  assert.deepEqual(await f.service.execute(actor(2),'getOrdersByEmail',{email:'jan@example.com'}),{orders:[]},'foreign orders invisible');
  for(const [m,p] of [['getOrdersByEmail',{}],['getOrdersByEmail',{email:''}],['getOrdersByPhone',{phone:'1',x:1}],['getOrdersByPhone',{phone:'x'.repeat(51)}]] as const)
    await assert.rejects(f.service.execute(actor(1),m,p as any),(e:any)=>e.name==='ZodError');
});
test('getOrderExtraFields lists enabled native definitions with derived numeric IDs',async()=>{
  const f=fixture();
  assert.equal(baseWireExtraFieldId('5f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f0a12'),parseInt('5f3a9c1e2b4de',16)+1);
  assert.deepEqual(await f.service.execute(actor(1),'getOrderExtraFields',{}),{extra_fields:[
    {extra_field_id:baseWireExtraFieldId('5f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f0a12'),name:'Uwagi',editor_type:'text'},
    {extra_field_id:baseWireExtraFieldId('0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d'),name:'Opakowanie',editor_type:'select',options:['Papier']},
    {extra_field_id:baseWireExtraFieldId('99999999-8888-4777-8666-555555555555'),name:'Etykiety',editor_type:'checkbox',options:['VIP','B2B']},
    {extra_field_id:baseWireExtraFieldId('12345678-1234-4234-8234-123456789abc'),name:'Skan',editor_type:'file'}]});
  assert.deepEqual((await f.service.execute(actor(2),'getOrderExtraFields',{}) as any).extra_fields.map((x:any)=>x.name),['Obce']);
  await assert.rejects(f.service.execute(actor(1),'getOrderExtraFields',{x:1}),(e:any)=>e.name==='ZodError');
  // Two definitions with the same derived ID fail closed.
  f.state.fields.push({...f.state.fields[0],id:'5f3a9c1e-2b4d-4e6f-9a1b-3c5d7e9f0a99'});
  await assert.rejects(f.service.execute(actor(1),'getOrderExtraFields',{}),(e:any)=>e.status===503&&e.code==='LOCAL_BASE_WIRE_EXTRA_FIELD_ID');
});
test('setOrderFields writes only custom_extra_fields through native order fields; header fields are 422',async()=>{
  const f=fixture(),fid=(n:number)=>String(baseWireExtraFieldId(f.state.fields[n].id));
  await f.service.execute(actor(1),'addOrder',order);
  assert.deepEqual(await f.service.execute(actor(1),'setOrderFields',{order_id:500,custom_extra_fields:{[fid(0)]:'Zadzwonić',[fid(1)]:'Papier',[fid(2)]:['VIP','B2B']}}),{});
  assert.deepEqual(f.state.fieldPatches,[[uid(900),[
    {field_id:f.state.fields[0].id,definition_version:2,type:'text',value:'Zadzwonić'},
    {field_id:f.state.fields[1].id,definition_version:1,type:'select',value:uid(61)},
    {field_id:f.state.fields[2].id,definition_version:1,type:'multi_select',value:[uid(63),uid(64)]}]]]);
  // Empty string clears; nothing given is no native write.
  await f.service.execute(actor(1),'setOrderFields',{order_id:500,custom_extra_fields:{[fid(0)]:''}});
  assert.deepEqual(f.state.fieldPatches[1][1],[{field_id:f.state.fields[0].id,definition_version:2,operation:'clear'}]);
  assert.deepEqual(await f.service.execute(actor(1),'setOrderFields',{order_id:500}),{});
  assert.deepEqual(await f.service.execute(actor(1),'setOrderFields',{order_id:500,custom_extra_fields:[]}),{});
  assert.equal(f.state.fieldPatches.length,2);
  const reject=async(p:any,check:(e:any)=>boolean,a=actor(1))=>{await assert.rejects(f.service.execute(a,'setOrderFields',p),check);assert.equal(f.state.fieldPatches.length,2);};
  for(const field of ['admin_comments','email','delivery_address','invoice_nip','pick_state','star','currency','delivery_price'])
    await reject({order_id:500,[field]:''},e=>e.status===422&&e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({order_id:500,custom_extra_fields:{[fid(3)]:{title:'a.pdf',file:'data:AAAA'}}},e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({order_id:500,custom_extra_fields:{[fid(1)]:'Folia'}},e=>e.status===422);       // retired option
  await reject({order_id:500,custom_extra_fields:{[fid(2)]:'VIP'}},e=>e.status===422);         // multi choice needs a list
  await reject({order_id:500,custom_extra_fields:{[fid(3)]:'x'}},e=>e.status===422);           // file is not text
  await reject({order_id:500,custom_extra_fields:{'1':'x'}},e=>e.status===404);                 // unknown field
  await reject({order_id:500,custom_extra_fields:{[String(baseWireExtraFieldId(f.state.fields[5].id))]:'x'}},e=>e.status===404); // foreign field
  await reject({order_id:501,custom_extra_fields:{[fid(0)]:'x'}},e=>e.status===404);           // unknown order
  await reject({order_id:500,custom_extra_fields:{[fid(0)]:'x'}},e=>e.status===404,actor(2));  // foreign order
  await reject({order_id:500,custom_extra_fields:{[fid(0)]:'x'}},e=>e.status===403,actor(1,'viewer'));
  await reject({order_id:500,unknown:1},e=>e.name==='ZodError');
  await reject({order_id:500,custom_extra_fields:{x:'1'}},e=>e.name==='ZodError');
  const key=uid(79);
  await f.service.execute(actor(1),'setOrderFields',{order_id:500,custom_extra_fields:{[fid(0)]:'A'}},{clientKey:key});
  await f.service.execute(actor(1),'setOrderFields',{order_id:500,custom_extra_fields:{[fid(0)]:'A'}},{clientKey:key});
  assert.equal(f.state.fieldPatches.length,3,'replayed, not reapplied');
  await assert.rejects(f.service.execute(actor(1),'setOrderFields',{order_id:500,custom_extra_fields:{[fid(0)]:'B'}},{clientKey:key}),(e:any)=>e.status===409);
});
test('setOrderPayment sets the TOTAL paid: one receipt for the delta, the same total records nothing',async()=>{
  const f=fixture();
  await f.service.execute(actor(1),'addOrder',order);
  const pay=(p:any,o?:any)=>f.service.execute(actor(1),'setOrderPayment',{order_id:500,payment_date:1760000500,...p},o);
  assert.deepEqual(await pay({payment_done:30,payment_comment:'Przelew',external_payment_id:'PAY-1'}),{});
  assert.deepEqual(await pay({payment_done:'30.00',payment_comment:'Przelew',external_payment_id:'PAY-1'}),{});
  assert.deepEqual(f.state.ledger.map(e=>[e.amount,e.reference,e.note]),[[3000,'Base API setOrderPayment PAY-1','Przelew']]);
  await pay({payment_done:92.48});
  assert.deepEqual(f.state.ledger.map(e=>[e.amount,e.reference]),[[3000,'Base API setOrderPayment PAY-1'],[6248,'Base API setOrderPayment']]);
  // A lower total has no native mapping; more than two decimals is refused; nothing recorded.
  await assert.rejects(pay({payment_done:10}),(e:any)=>e.status===422&&e.code==='LOCAL_BASE_WIRE_PAYMENT_DECREASE');
  await assert.rejects(pay({payment_done:100.001}),(e:any)=>e.code==='LOCAL_BASE_WIRE_AMOUNT');
  await assert.rejects(pay({payment_done:100,x:1}),(e:any)=>e.name==='ZodError');
  await assert.rejects(pay({payment_done:100,external_payment_id:'x'.repeat(31)}),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(2),'setOrderPayment',{order_id:500,payment_done:100}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1,'viewer'),'setOrderPayment',{order_id:500,payment_done:100}),(e:any)=>e.status===403);
  assert.equal(f.state.ledger.length,2);
  // Idempotency-Key after a lost ACK: the stored response, no second receipt; another body is 409.
  const key=uid(80);f.loseAck();
  await assert.rejects(pay({payment_done:100},{clientKey:key}),(e:any)=>e.message==='lost ack');
  assert.deepEqual(await pay({payment_done:100},{clientKey:key}),{});
  assert.deepEqual(f.state.ledger.map(e=>e.amount),[3000,6248,752]);
  await assert.rejects(pay({payment_done:120},{clientKey:key}),(e:any)=>e.status===409);
});
test('getOrderPaymentsHistory: running totals; default only entries with external_payment_id',async()=>{
  const f=fixture();
  await f.service.execute(actor(1),'addOrder',order);
  await f.service.execute(actor(1),'setOrderPayment',{order_id:500,payment_done:30,payment_comment:'Zaliczka',external_payment_id:'PAY-1'});
  await f.service.execute(actor(1),'setOrderPayment',{order_id:500,payment_done:92.48});
  // Native entries: a courier remittance (no change of paid) and a reversal of the first receipt.
  f.state.ledger.push({order:uid(900),kind:'courier_remittance',reversal:false,amount:500,method:'courier_csv',reference:'R1',note:'',created:1760000200},
    {order:uid(900),kind:'receipt',reversal:true,amount:-3000,method:'correction',reference:'x',note:'Błąd',created:1760000300});
  const entry=(before:number,after:number,external:string,date:number,comment:string)=>({paid_before:before,paid_after:after,total_price:92.48,currency:'PLN',external_payment_id:external,date,comment});
  assert.deepEqual(await f.service.execute(actor(1),'getOrderPaymentsHistory',{order_id:500}),{payments:[entry(0,30,'PAY-1',1760000100,'Zaliczka')]});
  assert.deepEqual(await f.service.execute(actor(1),'getOrderPaymentsHistory',{order_id:500,show_full_history:true}),{payments:[
    entry(0,30,'PAY-1',1760000100,'Zaliczka'),entry(30,92.48,'',1760000101,''),entry(92.48,62.48,'',1760000300,'Błąd')]});
  await assert.rejects(f.service.execute(actor(2),'getOrderPaymentsHistory',{order_id:500}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1),'getOrderPaymentsHistory',{order_id:500,show_full_history:'yes'}),(e:any)=>e.name==='ZodError');
});
test('setOrdersMerge runs the native merge with credential custody and returns the merged numeric ID',async()=>{
  const f=fixture();
  for(let i=0;i<3;i++)await f.service.execute(actor(1),'addOrder',order);
  const opts={credential:'dyna_api_x'};
  assert.deepEqual(await f.service.execute(actor(1),'setOrdersMerge',{main_order_id:500,order_ids_to_merge:[501,502],merge_mode:'into_main_order',sum_delivery_costs:true},opts),{merged_order_id:500});
  assert.equal(f.state.merges[0].credential,'dyna_api_x');
  assert.deepEqual({...f.state.merges[0].input,preview_key:'',execute_key:''},{preview_key:'',execute_key:'',main_order_id:uid(900),order_ids:[uid(901),uid(902)],merge_mode:'into_main_order',sum_delivery_costs:true});
  // technical_merge: the new native order gets its numeric ID in the same call.
  assert.deepEqual(await f.service.execute(actor(1),'setOrdersMerge',{main_order_id:501,order_ids_to_merge:[502],merge_mode:'technical_merge',sum_delivery_costs:0},opts),{merged_order_id:503});
  // Idempotency-Key: deterministic native command keys, so a retry replays natively.
  const key=uid(81),m={main_order_id:500,order_ids_to_merge:[502],merge_mode:'technical_merge',sum_delivery_costs:false};
  const first=await f.service.execute(actor(1),'setOrdersMerge',m,{...opts,clientKey:key});
  assert.deepEqual(await f.service.execute(actor(1),'setOrdersMerge',m,{...opts,clientKey:key}),first);
  assert.equal(f.state.merges.length,3);
  const keys=f.state.merges[2].input;assert.notEqual(keys.preview_key,keys.execute_key);
  assert.match(keys.preview_key,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const reject=async(p:any,check:(e:any)=>boolean,a=actor(1),o:any=opts)=>{await assert.rejects(f.service.execute(a,'setOrdersMerge',p,o),check);assert.equal(f.state.merges.length,3);};
  await reject({...m,order_ids_to_merge:[500]},e=>e.name==='ZodError');
  await reject({...m,order_ids_to_merge:[502,502]},e=>e.name==='ZodError');
  await reject({...m,order_ids_to_merge:[]},e=>e.name==='ZodError');
  await reject({...m,merge_mode:'other'},e=>e.name==='ZodError');
  await reject({...m,order_ids_to_merge:[999]},e=>e.status===404);
  await reject(m,e=>e.status===404,actor(2));
  await reject(m,e=>e.status===403,actor(1,'viewer'));
  await reject(m,e=>e.status===503,actor(1),{});
  const none=fixture({merge:false});
  await assert.rejects(none.service.execute(actor(1),'setOrdersMerge',m,opts),(e:any)=>e.status===503);
});
test('order_product_id is derived from the immutable item UUID (52 random bits + 1)',()=>{
  assert.equal(baseWireOrderProductId(uid(800)),baseWireExtraFieldId(uid(800)));
  assert.equal(baseWireOrderProductId('ffffffff-ffff-4fff-bfff-ffffffffffff'),2**52);
  assert.equal(baseWireOrderProductId('00000000-0000-4000-8000-000000000000'),1);
  assert.throws(()=>baseWireOrderProductId('nope'));
});
test('addOrderBySplit runs the native split with credential custody and returns the new numeric order ID',async()=>{
  const f=fixture();
  await f.service.execute(actor(1),'addOrder',order);
  const line=baseWireOrderProductId(uid(800)),opts={credential:'dyna_api_x'};
  const p={order_id:500,items_to_split:[{order_product_id:line,quantity:1}],delivery_cost_to_split:2.5};
  assert.deepEqual(await f.service.execute(actor(1),'addOrderBySplit',p,opts),{new_order_id:501});
  assert.equal(f.state.splits[0].credential,'dyna_api_x');
  assert.deepEqual({...f.state.splits[0].input,preview_key:'',execute_key:''},{preview_key:'',execute_key:'',order_id:uid(900),
    items:[{order_product_id:line,quantity:1}],shipping_cost_to_child:250});
  // The child is a native order: its numeric ID is allocated in the same call; a digit string ID is accepted.
  assert.equal(f.state.orders.find(o=>o.id===uid(970))!.public,501);
  assert.deepEqual(await f.service.execute(actor(1),'addOrderBySplit',{...p,items_to_split:[{order_product_id:String(line),quantity:1}]},opts),{new_order_id:502});
  // Idempotency-Key: deterministic native command keys; a retry replays natively (same child, no new split).
  const key=uid(82),first=await f.service.execute(actor(1),'addOrderBySplit',p,{...opts,clientKey:key});
  assert.deepEqual(await f.service.execute(actor(1),'addOrderBySplit',p,{...opts,clientKey:key}),first);
  assert.equal(f.state.splits.length,3);
  const keys=f.state.splits[2].input;assert.notEqual(keys.preview_key,keys.execute_key);
  assert.match(keys.execute_key,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const reject=async(x:any,check:(e:any)=>boolean,a=actor(1),o:any=opts)=>{await assert.rejects(f.service.execute(a,'addOrderBySplit',x,o),check);assert.equal(f.state.splits.length,3);};
  await reject({...p,items_to_split:[]},e=>e.name==='ZodError');
  await reject({...p,items_to_split:[{order_product_id:line,quantity:1},{order_product_id:line,quantity:2}]},e=>e.name==='ZodError');
  await reject({...p,items_to_split:[{order_product_id:line,quantity:0}]},e=>e.name==='ZodError');
  await reject({...p,items_to_split:[{order_product_id:line,quantity:1,name:'x'}]},e=>e.name==='ZodError');
  await reject({...p,delivery_cost_to_split:1.005},e=>e.status===422);
  await reject({...p,delivery_cost_to_split:-1},e=>e.status===422||e.name==='ZodError');
  await reject({...p,order_id:999},e=>e.status===404);
  await reject({...p,items_to_split:[{order_product_id:line+1,quantity:1}]},e=>e.status===404);
  await reject(p,e=>e.status===404,actor(2));
  await reject(p,e=>e.status===403,actor(1,'viewer'));
  await reject(p,e=>e.status===503,actor(1),{});
  const none=fixture({split:false});
  await none.service.execute(actor(1),'addOrder',order);
  await assert.rejects(none.service.execute(actor(1),'addOrderBySplit',p,opts),(e:any)=>e.status===503);
});
