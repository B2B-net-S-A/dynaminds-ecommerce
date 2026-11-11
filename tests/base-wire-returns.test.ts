/** Actual Base returns family service + registry on CLOSED native ports.
 * The real SQL/RLS/native RMA is covered by base-wire-returns.database.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createBaseWireReturnsService, createBaseWireReturnsFamily, BASE_WIRE_RETURNS_METHODS, BASE_WIRE_RETURN_STATUSES, BASE_WIRE_RETURN_REASON,
  BASE_WIRE_RETURN_DECISION_NOTE, baseWireReturnsScope, isBaseWireReturnsWrite, baseWireReturnId, baseWireReturnKey,
  type BaseWireReturnsNative, type BaseWireReturn, type BaseWireReturnOrder, type BaseWireNativeReturnInput } from '../server/base-wire-returns';
import { BASE_WIRE_RESERVED_STATUS_IDS, BASE_WIRE_STAGE_STATUSES } from '../server/base-wire-orders';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { baseWireRequiredScopes } from '../server/developer-api';
import { Problem, ensure } from '../server/errors';
import type { Actor } from '../server/domain';

const uid=(n:number)=>`74000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const caseId=(n:number)=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
const actor=(t:number,role:Actor['role']='admin'):Actor=>({tenantId:uid(t),userId:uid(10+t),role,apiKeyId:uid(20+t),source:'api'});
const sid=(state:string)=>BASE_WIRE_RETURN_STATUSES.find(s=>s.state===state)!.id;
type Case={tenant:string;id:string;order:string;state:string;version:number;settlement:{amount:number;reference:string}|null;refund_amount:number;payout:number;
  input:BaseWireNativeReturnInput;payments:{amount:number;currency:string;reference:string;date:number}[]};
function fixture(opts:{allocateOnRead?:boolean;collide?:boolean;reasons?:boolean}={}) {
  const orderA:BaseWireReturnOrder&{tenant:string;public_id:number}={tenant:uid(1),public_id:500,id:uid(90),currency:'PLN',email:'Jan@Example.com',customer_name:'Jan Kowalski',warehouse_id:uid(31),
    address:{street:'Prosta 1',city:'Warszawa',postal_code:'00-001',country:'PL',phone:'500600700'},lines:[
      {item_id:uid(61),product_public_id:101,parent_public_id:null,catalog_public_id:3,sku:'A-1',ean:'5901',quantity:2,line_total:5100,vat:23},
      {item_id:uid(62),product_public_id:103,parent_public_id:102,catalog_public_id:3,sku:'G-1-M',ean:null,quantity:1,line_total:1999,vat:8},
      {item_id:uid(63),product_public_id:104,parent_public_id:null,catalog_public_id:3,sku:'B-1',ean:null,quantity:1,line_total:1000,vat:23},
      {item_id:uid(64),product_public_id:104,parent_public_id:null,catalog_public_id:3,sku:'B-1',ean:null,quantity:3,line_total:2400,vat:23}]};
  const orderB={...structuredClone(orderA),tenant:uid(2),public_id:600,id:uid(91),lines:[]};
  const s={orders:[orderA,orderB],warehouses:[{tenant:uid(1),id:uid(31),public_id:11},{tenant:uid(1),id:uid(32),public_id:12},{tenant:uid(2),id:uid(33),public_id:13}],
    cases:[] as Case[],decisions:[] as [string,any][],refunds:[] as [string,any][],idempotency:[] as {tenant:string;key:string;hash:string;response:any}[],
    allocations:[] as string[],next:1};
  let state=structuredClone(s);
  const native=(_c:unknown,a:Actor):BaseWireReturnsNative=>{
    const t=a.tenantId,mine=()=>state.cases.filter(x=>x.tenant===t);
    const dto=(x:Case):BaseWireReturn=>{const o=state.orders.find(y=>y.id===x.order)!;return {id:x.id,order_public_id:o.public_id,external_id:null,number:'RMA-'+x.id.slice(0,8),
      state:x.state,created:1760000000,in_status:1760000100,currency:o.currency,refunded:x.settlement?.amount??0,email:o.email,customer_name:o.customer_name,address:o.address,
      shipping:x.input.shipping_refund,reason:x.input.reason,reason_public_id:x.input.reason_public_id??null,warehouse_public_id:state.warehouses.find(w=>w.id===x.input.warehouse_id)!.public_id,
      lines:x.input.items.map(i=>({...o.lines.find(l=>l.item_id===i.item_id)!,name:'Linia',requested:i.quantity}))};};
    return {
      allocate:async()=>{state.allocations.push(t);},
      order:async n=>state.orders.find(o=>o.tenant===t&&o.public_id===n)?.id??null,
      snapshot:async id=>{const {tenant:_t,public_id:_p,...o}=state.orders.find(x=>x.tenant===t&&x.id===id)!;return structuredClone(o);},
      warehouses:async()=>state.warehouses.filter(w=>w.tenant===t).map(({tenant:_t,...w})=>w),
      find:async n=>mine().filter(x=>baseWireReturnId(x.id)===n).map(x=>x.id),
      taken:async(id,key)=>opts.collide===true||mine().some(x=>x.id!==id&&baseWireReturnKey(x.id)===key),
      returns:async f=>mine().filter(x=>(f.return_ids===undefined||f.return_ids.includes(x.id))&&(f.state===undefined||x.state===f.state)
        &&(f.order_public_id===undefined||state.orders.find(o=>o.id===x.order)!.public_id===f.order_public_id)&&(f.id_from===undefined||baseWireReturnId(x.id)>=f.id_from))
        .sort((p,q)=>baseWireReturnId(p.id)-baseWireReturnId(q.id)).slice(0,f.limit).map(dto),
      state:async id=>{const x=mine().find(y=>y.id===id);ensure(x,404,'Nie znaleziono zwrotu');return {id:x.id,state:x.state,version:x.version,settlement:x.settlement};},
      payments:async id=>{const x=mine().find(y=>y.id===id)!;return {total:x.refund_amount,entries:structuredClone(x.payments)};},
      replay:async(key,hash)=>{let row=state.idempotency.find(x=>x.tenant===t&&x.key===key);if(!row)state.idempotency.push(row={tenant:t,key,hash,response:null});
        ensure(row.hash===hash,409,'Klucz polecenia wskazuje inną treść');return structuredClone(row.response);},
      remember:async(key,response)=>{state.idempotency.find(x=>x.tenant===t&&x.key===key)!.response=structuredClone(response);},
      reasons:async()=>[{public_id:7,name:'Uszkodzony towar'},{public_id:9,name:'Za mały rozmiar'}],
      request:async(order,input)=>{ensure(input.reason_public_id===undefined||[7,9].includes(input.reason_public_id),404,'Nie znaleziono powodu zwrotu');const id=caseId(state.next++);state.cases.push({tenant:t,id,order,state:'requested',version:1,settlement:null,refund_amount:0,payout:0,input:structuredClone(input),payments:[]});return id;},
      decide:async(id,input)=>{const x=mine().find(y=>y.id===id)!;ensure(x.state==='requested'&&x.version===input.version,409,'Sprawa została już rozpatrzona');
        state.decisions.push([id,structuredClone(input)]);x.state=input.decision==='reject'?'rejected':'cancelled';x.version++;},
      refund:async(id,input)=>{const x=mine().find(y=>y.id===id)!;ensure(x.state==='refund_pending'&&x.version===input.version,409,'Zwrot nie jest gotowy do rozliczenia');
        ensure(input.amount===x.payout,422,'Kwota potwierdzenia musi odpowiadać środkom');state.refunds.push([id,structuredClone(input)]);
        if(x.payout>0)x.payments.push({amount:x.payout,currency:'PLN',reference:input.reference,date:1760000200});
        x.state='closed';x.version++;x.settlement={amount:input.amount,reference:input.reference};},
    };
  };
  let loseAck=false;
  const service=createBaseWireReturnsService({allocateOnRead:opts.allocateOnRead??true,reasons:opts.reasons??true,native:native as any,transaction:async(_a,_w,work)=>{
    const before=structuredClone(state);
    try{const r=await work({} as any);if(loseAck&&_w){loseAck=false;throw new Problem(500,'lost ack');}return r;}catch(e){if(!(e instanceof Problem&&e.message==='lost ack'))state=before;throw e;}
  }});
  return {service,get state(){return state;},loseAck:()=>{loseAck=true;}};
}
const ret={order_id:500,admin_comments:'Za mały rozmiar',delivery_price:5,email:'jan@example.com ',phone:'500600700',delivery_fullname:'Jan Kowalski',
  delivery_country_code:'pl',currency:'PLN',date_add:1760000000,reference_number:'',refunded:0,
  products:[{storage:'db',storage_id:0,product_id:'101',variant_id:0,name:'Kubek',sku:'A-1',warehouse_id:0,price_brutto:25.5,tax_rate:23,quantity:1,status_id:0,return_reason_id:0}]};

test('returns scopes: reads orders:read, writes orders:write which also requires orders:read',()=>{
  assert.deepEqual(BASE_WIRE_RETURNS_METHODS.map(m=>[m,baseWireReturnsScope(m),isBaseWireReturnsWrite(m)]),
    [['getOrderReturnStatusList','orders:read',false],['addOrderReturn','orders:write',true],['getOrderReturns','orders:read',false],
      ['setOrderReturnStatus','orders:write',true],['setOrderReturnRefund','orders:write',true],['getOrderReturnPaymentsHistory','orders:read',false],['getOrderReturnReasonsList','orders:read',false]]);
  assert.deepEqual(baseWireRequiredScopes('orders:write'),['orders:read','orders:write']);
  // No sound native mapping: not offered by this family (registry answers 400).
  for(const m of ['getOrderReturnExtraFields','setOrderReturnFields'])assert.throws(()=>baseWireReturnsScope(m),(e:any)=>e.status===400);
  const family=createBaseWireReturnsFamily({service:{execute:async()=>({})},available:true});
  assert.equal(family.label,'zwrotów');assert.equal(family.nativeCredentialCustody,undefined);
});
test('return statuses: fixed native states inside the reserved range, disjoint from the order stages',async()=>{
  assert.deepEqual(BASE_WIRE_RETURN_STATUSES.map(s=>[s.state,s.id]),[['requested',2147483101],['refund_pending',2147483102],['closed',2147483103],['rejected',2147483104],['cancelled',2147483105]]);
  for(const s of BASE_WIRE_RETURN_STATUSES){assert(s.id>=BASE_WIRE_RESERVED_STATUS_IDS.from&&s.id<=BASE_WIRE_RESERVED_STATUS_IDS.to);assert(!BASE_WIRE_STAGE_STATUSES.some(x=>x.id===s.id));}
  const f=fixture();
  assert.deepEqual(await f.service.execute(actor(1),'getOrderReturnStatusList',{}),{statuses:BASE_WIRE_RETURN_STATUSES.map(s=>({id:s.id,name:s.name,color:'#3455db',group_id:0,is_primary:0,name_for_customer:s.name}))});
  await assert.rejects(f.service.execute(actor(1),'getOrderReturnStatusList',{x:1}),(e:any)=>e.name==='ZodError');
});
test('derived return_id: 52 random bits of the v4 UUID + 1, stable and positive',()=>{
  assert.equal(baseWireReturnId('00000000-0000-4000-8000-000000000000'),1);
  assert.equal(baseWireReturnId('ffffffff-ffff-4fff-bfff-ffffffffffff'),2**52);
  assert.equal(baseWireReturnKey('12345678-9abc-4def-8000-000000000000'),'123456789abcd');
  assert.throws(()=>baseWireReturnId('nope'),(e:any)=>e.name==='ZodError');
});
test('addOrderReturn maps Base lines to the native order items and creates one native case',async()=>{
  const f=fixture();
  const r=await f.service.execute(actor(1),'addOrderReturn',{...ret,status_id:sid('requested')});
  assert.deepEqual(r,{return_id:baseWireReturnId(caseId(1))});
  assert.deepEqual(f.state.cases[0].input,{kind:'return',reason:'Za mały rozmiar',warehouse_id:uid(31),shipping_refund:500,items:[{item_id:uid(61),quantity:1}]});
  // Variant (product_id = parent), SKU, a second warehouse, the default reason; price_brutto picks one of two lines of one product.
  await f.service.execute(actor(1),'addOrderReturn',{order_id:500,products:[{product_id:102,variant_id:103,quantity:1,warehouse_id:12},{sku:'B-1',price_brutto:'8.00',quantity:2,warehouse_id:12}]});
  assert.deepEqual(f.state.cases[1].input,{kind:'return',reason:BASE_WIRE_RETURN_REASON,warehouse_id:uid(32),shipping_refund:0,items:[{item_id:uid(62),quantity:1},{item_id:uid(64),quantity:2}]});
});
test('addOrderReturn refuses foreign/unknown data, mismatched buyer and unmapped fields without effect',async()=>{
  const f=fixture();const reject=async(parameters:any,check:(e:any)=>boolean,a=actor(1))=>{
    await assert.rejects(f.service.execute(a,'addOrderReturn',parameters),check);assert.equal(f.state.cases.length,0);};
  const line=(x:any)=>({...ret,products:[{...ret.products[0],...x}]});
  await reject({...ret,order_id:600},e=>e.status===404);                 // other tenant's order
  await reject(ret,e=>e.status===404,actor(2));
  await reject(line({product_id:'999'}),e=>e.status===404);
  await reject(line({product_id:'102',variant_id:0}),e=>e.status===404);  // a group is not an order line
  await reject(line({warehouse_id:13}),e=>e.status===404);               // foreign warehouse
  await reject(line({tax_rate:8}),e=>e.status===404);
  await reject(line({storage_id:4}),e=>e.status===404);
  await reject(line({price_brutto:1.001}),e=>e.code==='LOCAL_BASE_WIRE_AMOUNT');
  await reject({...ret,products:[{sku:'B-1',quantity:1}]},e=>e.status===422);       // two lines of B-1: ambiguous
  await reject({...ret,products:[ret.products[0],ret.products[0]]},e=>e.status===422);
  await reject({...ret,products:[ret.products[0],{sku:'G-1-M',quantity:1,warehouse_id:12},{sku:'B-1',price_brutto:10,quantity:1,warehouse_id:11}]},e=>e.status===422);
  await reject({...ret,currency:'EUR'},e=>e.status===422);
  await reject({...ret,email:'inny@example.com'},e=>e.status===422);
  await reject({...ret,delivery_address:'Krzywa 2'},e=>e.status===422);
  for(const field of ['reference_number','user_login','delivery_company','delivery_state','extra_field_1','refund_iban','refund_account_number'])
    await reject({...ret,[field]:'x'},e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({...ret,refunded:1},e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({...ret,custom_source_id:2},e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  for(const field of ['order_product_id','status_id'])await reject(line({[field]:5}),e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject(line({location:'A-1'}),e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({...ret,status_id:sid('closed')},e=>e.status===422&&e.code==='LOCAL_BASE_WIRE_RETURN_STATUS');
  await reject({...ret,status_id:7},e=>e.status===404);
  await reject({...ret,custom_extra_fields:{'1':'x'}},e=>e.name==='ZodError');
  await reject({...ret,order_id:undefined},e=>e.name==='ZodError');
  await reject({...ret,products:[]},e=>e.name==='ZodError');
  await reject({...ret,unknown:1},e=>e.name==='ZodError');
  await reject(line({storage:'shop'}),e=>e.name==='ZodError');
  await reject(ret,e=>e.status===403,actor(1,'viewer'));
  // A derived-ID collision with another own case fails the whole call.
  const c=fixture({collide:true});
  await assert.rejects(c.service.execute(actor(1),'addOrderReturn',ret),(e:any)=>e.status===503&&e.code==='LOCAL_BASE_WIRE_RETURN_ID');
  assert.equal(c.state.cases.length,0);
});
test('addOrderReturn Idempotency-Key replays one case after a lost ACK; another body under the key is 409',async()=>{
  const f=fixture(),key=uid(77);
  f.loseAck();
  await assert.rejects(f.service.execute(actor(1),'addOrderReturn',ret,{clientKey:key}),(e:any)=>e.message==='lost ack');
  const first={return_id:baseWireReturnId(caseId(1))};
  assert.deepEqual(await f.service.execute(actor(1),'addOrderReturn',ret,{clientKey:key}),first);
  assert.deepEqual(await f.service.execute(actor(1),'addOrderReturn',ret,{clientKey:key}),first);
  assert.equal(f.state.cases.length,1);
  await assert.rejects(f.service.execute(actor(1),'addOrderReturn',{...ret,delivery_price:1},{clientKey:key}),(e:any)=>e.status===409);
  await assert.rejects(f.service.execute(actor(1),'addOrderReturn',ret,{clientKey:'nope'}),(e:any)=>e.name==='ZodError');
});
test('setOrderReturnStatus: reject/cancel via the native decision, receive/close refused, own cases only',async()=>{
  const f=fixture();
  const a=(await f.service.execute(actor(1),'addOrderReturn',ret)).return_id as number;
  const b=(await f.service.execute(actor(1),'addOrderReturn',{...ret,products:[{sku:'G-1-M',quantity:1}],delivery_price:0})).return_id as number;
  assert.deepEqual(await f.service.execute(actor(1),'setOrderReturnStatus',{return_id:a,status_id:sid('requested')}),{},'same status: no change');
  for(const target of ['refund_pending','closed'])
    await assert.rejects(f.service.execute(actor(1),'setOrderReturnStatus',{return_id:a,status_id:sid(target)}),(e:any)=>e.status===409&&e.code==='LOCAL_BASE_WIRE_RETURN_TRANSITION');
  await assert.rejects(f.service.execute(actor(2),'setOrderReturnStatus',{return_id:a,status_id:sid('rejected')}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1),'setOrderReturnStatus',{return_id:a,status_id:5}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1,'viewer'),'setOrderReturnStatus',{return_id:a,status_id:sid('rejected')}),(e:any)=>e.status===403);
  assert.equal(f.state.decisions.length,0);
  assert.deepEqual(await f.service.execute(actor(1),'setOrderReturnStatus',{return_id:a,status_id:sid('rejected')}),{});
  assert.deepEqual(await f.service.execute(actor(1),'setOrderReturnStatus',{return_id:b,status_id:sid('cancelled')}),{});
  assert.deepEqual(f.state.decisions,[[caseId(1),{version:1,decision:'reject',note:BASE_WIRE_RETURN_DECISION_NOTE}],[caseId(2),{version:1,decision:'cancel',note:BASE_WIRE_RETURN_DECISION_NOTE}]]);
  // Already decided: same status is a no-op, another decision is the native 409.
  assert.deepEqual(await f.service.execute(actor(1),'setOrderReturnStatus',{return_id:a,status_id:sid('rejected')}),{});
  await assert.rejects(f.service.execute(actor(1),'setOrderReturnStatus',{return_id:a,status_id:sid('cancelled')}),(e:any)=>e.status===409);
  assert.equal(f.state.decisions.length,2);
});
test('setOrderReturnRefund records the native refund exactly once (replay, lost ACK); other amounts refused',async()=>{
  const f=fixture();
  const id=(await f.service.execute(actor(1),'addOrderReturn',ret)).return_id as number;
  const refund={return_id:id,order_refund_done:30.5,refund_date:1760000300,refund_comment:'Przelew',external_refund_id:'TX-1'};
  await assert.rejects(f.service.execute(actor(1),'setOrderReturnRefund',refund),(e:any)=>e.status===409,'not received yet: native 409');
  // Native receive (outside Base) moves the case to refund_pending.
  Object.assign(f.state.cases[0],{state:'refund_pending',version:2,refund_amount:3050,payout:3050});
  await assert.rejects(f.service.execute(actor(1),'setOrderReturnRefund',{...refund,order_refund_done:10}),(e:any)=>e.status===422,'native exact-amount rule');
  await assert.rejects(f.service.execute(actor(1),'setOrderReturnRefund',{return_id:id,order_refund_done:30.5}),(e:any)=>e.status===422,'reference required');
  await assert.rejects(f.service.execute(actor(1),'setOrderReturnRefund',{...refund,external_refund_id:'',refund_comment:'ok'}),(e:any)=>e.status===422);
  await assert.rejects(f.service.execute(actor(2),'setOrderReturnRefund',refund),(e:any)=>e.status===404);
  // Lost ACK with a key: the retry returns {} and pays nothing again.
  const key=uid(79);f.loseAck();
  await assert.rejects(f.service.execute(actor(1),'setOrderReturnRefund',refund,{clientKey:key}),(e:any)=>e.message==='lost ack');
  assert.deepEqual(await f.service.execute(actor(1),'setOrderReturnRefund',refund,{clientKey:key}),{});
  // Replay without a key (same amount/reference): no-op; another amount or reference: 409, Base "replace" is refused.
  assert.deepEqual(await f.service.execute(actor(1),'setOrderReturnRefund',{...refund,refund_date:1760009999}),{});
  for(const other of [{order_refund_done:20},{external_refund_id:'TX-2'}])
    await assert.rejects(f.service.execute(actor(1),'setOrderReturnRefund',{...refund,...other}),(e:any)=>e.status===409&&e.code==='LOCAL_BASE_WIRE_RETURN_REFUNDED');
  assert.deepEqual(f.state.refunds,[[caseId(1),{version:2,amount:3050,reference:'TX-1 · Przelew',confirmed:true}]]);
  assert.equal(f.state.cases[0].payments.length,1);
  // Payments history: one native refund entry.
  assert.deepEqual(await f.service.execute(actor(1),'getOrderReturnPaymentsHistory',{return_id:id}),{payments:[
    {paid_before:0,paid_after:30.5,total_price:30.5,currency:'PLN',external_payment_id:'TX-1 · Przelew',date:1760000200}]});
  assert.deepEqual(await f.service.execute(actor(1),'getOrderReturnPaymentsHistory',{return_id:id,show_full_history:true}),
    await f.service.execute(actor(1),'getOrderReturnPaymentsHistory',{return_id:id}));
  await assert.rejects(f.service.execute(actor(2),'getOrderReturnPaymentsHistory',{return_id:id}),(e:any)=>e.status===404);
});
test('getOrderReturns allocates order IDs first, returns the Base DTO, filters and refuses unsupported flags',async()=>{
  const f=fixture();
  const id=(await f.service.execute(actor(1),'addOrderReturn',ret)).return_id as number;
  const r:any=await f.service.execute(actor(1),'getOrderReturns',{});
  assert.deepEqual(f.state.allocations,[uid(1)]);
  assert.deepEqual(r.returns,[{return_id:id,order_id:500,shop_order_id:0,external_order_id:'',reference_number:'RMA-00000001',order_return_source:'personal',
    order_return_source_id:0,status_id:sid('requested'),date_add:1760000000,date_in_status:1760000100,user_login:'',currency:'PLN',refunded:0,email:'Jan@Example.com',
    phone:'500600700',delivery_price:5,delivery_fullname:'Jan Kowalski',delivery_company:'',delivery_address:'Prosta 1',delivery_postcode:'00-001',delivery_city:'Warszawa',
    delivery_state:'',delivery_country:'',delivery_country_code:'PL',extra_field_1:'',extra_field_2:'',admin_comments:'Za mały rozmiar',delivery_package_module:'',
    delivery_package_nr:'',order_return_account_number:'',order_return_iban:'',order_return_swift:'',refund_account_number:'',refund_iban:'',refund_swift:'',fulfillment_status:0,
    products:[{storage:'db',storage_id:3,order_return_product_id:0,order_product_id:0,product_id:'101',variant_id:'0',name:'Linia',sku:'A-1',ean:'5901',location:'',
      warehouse_id:11,auction_id:'',attributes:'',price_brutto:25.5,tax_rate:23,quantity:1,weight:0,bundle_id:0,status_id:0,return_reason_id:0,return_reason_comment:''}]}]);
  assert.equal(JSON.stringify(r).match(/74000000/g),null,'numeric identities only');
  const ids=async(p:any,a=actor(1))=>((await f.service.execute(a,'getOrderReturns',p)).returns as any[]).map(x=>x.return_id);
  assert.deepEqual(await ids({return_id:id}),[id]);assert.deepEqual(await ids({return_id:id+1}),[]);
  assert.deepEqual(await ids({order_id:500}),[id]);assert.deepEqual(await ids({order_id:501}),[]);
  assert.deepEqual(await ids({status_id:sid('requested')}),[id]);assert.deepEqual(await ids({status_id:sid('closed')}),[]);assert.deepEqual(await ids({status_id:5}),[]);
  assert.deepEqual(await ids({id_from:id}),[id]);assert.deepEqual(await ids({id_from:id+1}),[]);
  assert.deepEqual(await ids({filter_order_return_source:'personal'}),[id]);assert.deepEqual(await ids({filter_order_return_source:'allegro'}),[]);
  assert.deepEqual(await ids({filter_order_return_source:'personal',filter_order_return_source_id:3}),[]);
  assert.deepEqual(await ids({},actor(2)),[],'second tenant isolated');
  await assert.rejects(f.service.execute(actor(1),'getOrderReturns',{include_connect_data:true}),(e:any)=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FLAG');
  await assert.rejects(f.service.execute(actor(1),'getOrderReturns',{filter_order_return_source_id:3}),(e:any)=>e.name==='ZodError');
  const ro=fixture({allocateOnRead:false});await ro.service.execute(actor(1),'getOrderReturns',{});assert.deepEqual(ro.state.allocations,[]);
});
test('connector.php: a read-only copy refuses return writes but serves reads',async t=>{
  const f=fixture({allocateOnRead:false}),app=Fastify();t.after(()=>app.close());
  const scopes:string[]=[];
  registerBaseWireRoutes(app,{readOnly:true,families:[createBaseWireReturnsFamily({service:f.service,available:true})],
    authenticate:async(_token,scope)=>{scopes.push(scope);return {id:uid(11),tenant_id:uid(1),role:'admin',api_key_id:uid(21),scopes:[scope]};}});
  const call=(method:string,parameters:unknown)=>app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'dyna_api_closed'},
    payload:new URLSearchParams({method,parameters:JSON.stringify(parameters)}).toString()});
  for(const m of ['addOrderReturn','setOrderReturnStatus','setOrderReturnRefund']){const w=await call(m,{});assert.equal(w.statusCode,423);assert.equal(w.json().status,'ERROR');}
  assert.equal(f.state.cases.length,0);
  const r=await call('getOrderReturnStatusList',{});assert.equal(r.statusCode,200);assert.equal(r.json().status,'SUCCESS');
  const reasons=await call('getOrderReturnReasonsList',{});assert.equal(reasons.statusCode,200);assert.equal(reasons.json().return_reasons.length,2);
  assert.deepEqual(scopes,['orders:read','orders:read']);
});

test('getOrderReturnReasonsList and return_reason_id map the native 223 dictionary; one reason per case',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.execute(actor(1),'getOrderReturnReasonsList',{}),{return_reasons:[{return_reason_id:7,name:'Uszkodzony towar'},{return_reason_id:9,name:'Za mały rozmiar'}]});
  await assert.rejects(f.service.execute(actor(1),'getOrderReturnReasonsList',{x:1}),(e:any)=>e.name==='ZodError');
  const line=(x:Record<string,unknown>)=>({...ret,products:[{...ret.products[0],...x}]});
  // Lines disagree, or the dictionary is not installed: no case.
  await assert.rejects(f.service.execute(actor(1),'addOrderReturn',{...ret,products:[{...ret.products[0],return_reason_id:7},{sku:'G-1-M',quantity:1,return_reason_id:9}]}),(e:any)=>e.status===422);
  await assert.rejects(f.service.execute(actor(1),'addOrderReturn',line({return_reason_id:5})),(e:any)=>e.status===404);
  const off=fixture({reasons:false});
  await assert.rejects(off.service.execute(actor(1),'addOrderReturn',line({return_reason_id:7})),(e:any)=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await assert.rejects(off.service.execute(actor(1),'getOrderReturnReasonsList',{}),(e:any)=>e.status===503&&e.code==='LOCAL_BASE_WIRE_RETURN_REASONS');
  assert.equal(f.state.cases.length+off.state.cases.length,0);
  // A string ID, 0 on other lines (= other) and the same ID on the case.
  const created=await f.service.execute(actor(1),'addOrderReturn',{...ret,products:[{...ret.products[0],return_reason_id:'9'},{sku:'G-1-M',quantity:1,return_reason_id:0}]});
  assert.equal(f.state.cases[0].input.reason_public_id,9);
  const read=await f.service.execute(actor(1),'getOrderReturns',{return_id:created.return_id as number}) as any;
  assert.deepEqual(read.returns[0].products.map((p:any)=>p.return_reason_id),[9,9]);
  await f.service.execute(actor(1),'addOrderReturn',line({quantity:1}));
  assert.equal(f.state.cases[1].input.reason_public_id,undefined);
});
