/** Actual Base fulfillment family service + registry on CLOSED native ports.
 * The real SQL/RLS/native WMS and shipping is covered by base-wire-fulfillment.database.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createBaseWireFulfillmentService, createBaseWireFulfillmentFamily, BASE_WIRE_FULFILLMENT_METHODS, baseWireFulfillmentScope,
  isBaseWireFulfillmentWrite, baseWirePickListId, baseWirePickListKey, baseWireTrackingStatus, BASE_WIRE_TRACKING_STATUS,
  type BaseWireFulfillmentNative, type BaseWireShipment, type BaseWirePackageRecord } from '../server/base-wire-fulfillment';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { baseWireRequiredScopes } from '../server/developer-api';
import { Problem, ensure } from '../server/errors';
import type { Actor } from '../server/domain';

const uid=(n:number)=>`74000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=(t:number,role:Actor['role']='admin'):Actor=>({tenantId:uid(t),userId:uid(10+t),role,apiKeyId:uid(20+t),source:'api'});
type Shipment=BaseWireShipment&{tenant:string;order:string};
type Record_=BaseWirePackageRecord&{tenant:string;order:string};
const rec=(tenant:number,order:number,public_id:number,x:Partial<BaseWirePackageRecord>):Record_=>({tenant:uid(tenant),order:uid(order),id:uid(public_id),public_id,
  tracking_number:'DEMO-'+public_id,mode:'demo',carrier:'Symulator lokalny',external_id:null,status:'created',status_at:'2026-10-20T10:00:00.000Z',
  cod_minor:0,currency:'PLN',events:[],plan:null,recorded:null,...x});
/** Native shipments as the port reads them: demo (createPackage / UI), InPost locker and courier, DPD, a foreign one. */
const records=():Record_[]=>[
  rec(1,32,900,{recorded:{weight:1.5,size_length:30,size_width:20,size_height:10}}),
  rec(1,32,901,{currency:'EUR',cod_minor:4999}),
  rec(1,31,950,{tracking_number:'INP1',mode:'live',carrier:'InPost ShipX',external_id:'123456789',status:'delivered',status_at:'2026-10-21T08:00:00.000Z',cod_minor:2550,
    plan:{provider:'inpost',service:'inpost_locker_standard',template:'small',weight:1,dimensions:null,insurance_minor:5000,cost:{minor:1299,currency:'PLN'}},
    events:[{at:'2026-10-21T08:00:00.000Z',status:'delivered',code:null},{at:'2026-10-20T08:00:00.000Z',status:'confirmed',code:null},{at:'2026-10-20T18:00:00.000Z',status:'nowy_status_inpost',code:null}]}),
  rec(1,31,951,{tracking_number:'0000123',mode:'sandbox',carrier:'DPD Polska',external_id:'0000123',status:'out_for_delivery',
    plan:{provider:'dpd',service:null,template:null,weight:2.5,dimensions:{length:30,width:20,height:10,unit:'cm'},insurance_minor:0,cost:null},
    events:[{at:'2026-10-20T09:00:00.000Z',status:'confirmed',code:'030103'},{at:'2026-10-20T09:30:00.000Z',status:null,code:'999999'},{at:'2026-10-21T07:00:00.000Z',status:'out_for_delivery',code:'170101'}]}),
  rec(1,33,952,{tracking_number:'INP2',mode:'demo',carrier:'InPost ShipX',external_id:'987',status:'confirmed',
    plan:{provider:'inpost',service:'inpost_courier_standard',template:null,weight:3,dimensions:{length:300,width:200,height:105,unit:'mm'},insurance_minor:0,cost:{minor:2100,currency:'PLN'}}}),
  rec(2,34,960,{}),
];
function fixture(opts:{collide?:boolean}={}) {
  const s={
    orders:[{tenant:uid(1),id:uid(31),public:501,status:'paid',warehouse:'W1'},{tenant:uid(1),id:uid(32),public:502,status:'packed',warehouse:'W1'},
      {tenant:uid(1),id:uid(33),public:503,status:'paid',warehouse:'W2'},{tenant:uid(2),id:uid(34),public:504,status:'packed',warehouse:'W3'}],
    channels:[{tenant:uid(1),code:'allegro',names:['Allegro A','Allegro B']},{tenant:uid(1),code:'woocommerce',names:['Sklep']},{tenant:uid(2),code:'ebay',names:['Obcy']}],
    waves:[] as {tenant:string;id:string;orders:string[]}[],shipments:[] as Shipment[],audits:[] as any[],
    idempotency:[] as {tenant:string;key:string;hash:string;response:any}[],nextShipment:900,writes:[] as boolean[],
    records:records(),merged:[{tenant:uid(1),id:uid(35),public:505}],couriers:{[uid(1)]:['dpd','inpost'],[uid(2)]:[] as string[]} as Record<string,string[]>,
  };
  let state=structuredClone(s);
  const native=(_c:unknown,a:Actor):BaseWireFulfillmentNative=>{
    const t=a.tenantId;
    return {
      order:async n=>state.orders.find(o=>o.tenant===t&&o.public===n)?.id??null,
      sources:async()=>state.channels.filter(x=>x.tenant===t).map(({tenant:_t,...x})=>x),
      createPickList:async ids=>{
        const orders=ids.map(id=>state.orders.find(o=>o.id===id)!);
        ensure(new Set(orders.map(o=>o.warehouse)).size===1,409,'Wybierz zamówienia z jednego magazynu');
        ensure(orders.every(o=>o.status==='paid'),409,'Partia wymaga opłaconych zamówień');
        for(const o of orders)o.status='picking';
        const id=uid(700+state.waves.length);state.waves.push({tenant:t,id,orders:ids});return id;},
      pickListTaken:async()=>opts.collide===true,
      shipDemo:async id=>{const o=state.orders.find(x=>x.id===id)!;ensure(o.status==='packed',409,'Najpierw skompletuj i spakuj zamówienie');
        o.status='shipped';const sh={tenant:t,order:id,id:uid(state.nextShipment),public_id:state.nextShipment++,tracking_number:'DEMO-'+state.nextShipment,mode:'demo',carrier:'Symulator lokalny'};
        state.shipments.push(sh);return {id:sh.id,public_id:sh.public_id,tracking_number:sh.tracking_number};},
      recordPackage:async(id,detail)=>{state.audits.push({id,detail});},
      shipments:async by=>state.shipments.filter(x=>x.tenant===t&&(by.public_id===undefined||x.public_id===by.public_id)&&(by.number===undefined||x.tracking_number===by.number))
        .map(({tenant:_t,order:_o,...x})=>x),
      demoLabel:async id=>'<html>'+state.shipments.find(x=>x.id===id)!.tracking_number+'</html>',
      operationalOrder:async n=>state.orders.find(o=>o.tenant===t&&o.public===n)?.id??null,   // merged 505 is not an operational order
      packages:async by=>state.records.filter(r=>r.tenant===t&&('order_id' in by?r.order===by.order_id:by.public_ids.includes(r.public_id)))
        .sort((x,y)=>x.public_id-y.public_id).map(({tenant:_t,order:_o,...x})=>structuredClone(x)),
      courierChannels:async()=>state.couriers[t],
      replay:async(key,hash)=>{let row=state.idempotency.find(x=>x.tenant===t&&x.key===key);if(!row)state.idempotency.push(row={tenant:t,key,hash,response:null});
        ensure(row.hash===hash,409,'Klucz polecenia wskazuje inną treść');return structuredClone(row.response);},
      remember:async(key,response)=>{state.idempotency.find(x=>x.tenant===t&&x.key===key)!.response=structuredClone(response);},
    };
  };
  let loseAck=false;
  // Closed transaction port: all-or-nothing state, optionally losing the COMMIT acknowledgement.
  const service=createBaseWireFulfillmentService({native:native as any,dpdLabel:async()=>Buffer.from('%PDF-1.4 dpd'),transaction:async(_a,w,work)=>{
    const before=structuredClone(state);state.writes.push(w);
    try{const r=await work({} as any);if(loseAck&&w){loseAck=false;throw new Problem(500,'lost ack');}return r;}catch(e){if(!(e instanceof Problem&&e.message==='lost ack'))state=before;throw e;}
  }});
  return {service,get state(){return state;},loseAck:()=>{loseAck=true;}};
}
const parcel={weight:1.5,size_length:30,size_width:20,size_height:'10'};

test('fulfillment scopes: reads orders:read, writes orders:write which also requires orders:read',()=>{
  assert.deepEqual(BASE_WIRE_FULFILLMENT_METHODS.map(m=>[baseWireFulfillmentScope(m),isBaseWireFulfillmentWrite(m)]),
    [['orders:read',false],['orders:write',true],['orders:write',true],['orders:read',false],['orders:read',false],['orders:read',false],['orders:read',false],['orders:read',false]]);
  assert.deepEqual(baseWireRequiredScopes('orders:write'),['orders:read','orders:write']);
  assert.throws(()=>baseWireFulfillmentScope('getCourierFields'),(e:any)=>e.status===400);
  const family=createBaseWireFulfillmentFamily({service:{execute:async()=>({})},available:true,pickListsAvailable:false});
  assert.equal(family.label,'realizacji');assert.equal(family.nativeCredentialCustody,undefined);
  assert.throws(()=>family.admit!('addOrderPickList'),(e:any)=>e.status===503);family.admit!('createPackage');
});
test('pick_list_id is derived from the 52 random bits of the wave UUID, stable and safe',()=>{
  assert.equal(baseWirePickListKey('0123abcd-ef01-4567-89ab-cdef01234567'),'0123abcdef015');
  assert.equal(baseWirePickListId('0123abcd-ef01-4567-89ab-cdef01234567'),0x0123abcdef015+1);
  assert.equal(baseWirePickListId('ffffffff-ffff-4fff-bfff-ffffffffffff'),2**52);
  assert.equal(baseWirePickListId('00000000-0000-4000-8000-000000000000'),1);
  assert(Number.isSafeInteger(2**52));
  assert.throws(()=>baseWirePickListId('nie-uuid'));
});
test('getOrderSources: personal key 0 plus own native order-source channels, numeric keys only',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.execute(actor(1),'getOrderSources',{}),{sources:{personal:{'0':'Osobiście / telefonicznie'},
    allegro:{'0':'Allegro A, Allegro B'},woocommerce:{'0':'Sklep'}}});
  assert.deepEqual(await f.service.execute(actor(2),'getOrderSources',{}),{sources:{personal:{'0':'Osobiście / telefonicznie'},ebay:{'0':'Obcy'}}});
  assert.deepEqual(f.state.writes,[false,false],'read transaction');
  await assert.rejects(f.service.execute(actor(1),'getOrderSources',{x:1}),(e:any)=>e.name==='ZodError');
});
test('addOrderPickList creates one native wave of own orders; replay returns the same list',async()=>{
  const f=fixture(),key=uid(77);
  const r=await f.service.execute(actor(1),'addOrderPickList',{order_ids:[501]},{clientKey:key});
  assert.deepEqual(r,{pick_list_id:baseWirePickListId(uid(700))});
  assert.deepEqual(f.state.waves,[{tenant:uid(1),id:uid(700),orders:[uid(31)]}]);
  assert.deepEqual(await f.service.execute(actor(1),'addOrderPickList',{order_ids:[501]},{clientKey:key}),r);
  assert.equal(f.state.waves.length,1);
  await assert.rejects(f.service.execute(actor(1),'addOrderPickList',{order_ids:[503]},{clientKey:key}),(e:any)=>e.status===409);
  // Lost ACK: the retained response is replayed, no second wave.
  const g=fixture(),k2=uid(78);g.loseAck();
  await assert.rejects(g.service.execute(actor(1),'addOrderPickList',{order_ids:[501]},{clientKey:k2}),(e:any)=>e.status===500);
  assert.deepEqual(await g.service.execute(actor(1),'addOrderPickList',{order_ids:[501]},{clientKey:k2}),{pick_list_id:baseWirePickListId(uid(700))});
  assert.equal(g.state.waves.length,1);
});
test('addOrderPickList refuses foreign/unknown orders, native rule failures and bad input without effect',async()=>{
  const f=fixture();const reject=async(p:any,check:(e:any)=>boolean,a=actor(1))=>{
    await assert.rejects(f.service.execute(a,'addOrderPickList',p),check);assert.equal(f.state.waves.length,0);assert.equal(f.state.orders[0].status,'paid');};
  await reject({order_ids:[501,504]},e=>e.status===404);     // other tenant's order
  await reject({order_ids:[999]},e=>e.status===404);
  await reject({order_ids:[501,503]},e=>e.status===409);     // two warehouses (native)
  await reject({order_ids:[501,502]},e=>e.status===409);     // packed order not eligible (native)
  await reject({order_ids:[501,501]},e=>e.name==='ZodError');
  await reject({order_ids:[]},e=>e.name==='ZodError');
  await reject({order_ids:Array.from({length:101},(_,i)=>i+1)},e=>e.name==='ZodError');
  await reject({order_ids:['501']},e=>e.name==='ZodError');
  await reject({order_ids:[501],name:'x'},e=>e.name==='ZodError');
  await reject({order_ids:[501]},e=>e.status===403,actor(1,'viewer'));
  const c=fixture({collide:true});
  await assert.rejects(c.service.execute(actor(1),'addOrderPickList',{order_ids:[501]}),(e:any)=>e.code==='LOCAL_BASE_WIRE_PICK_LIST_ID');
  assert.equal(c.state.waves.length,0);
});
test('createPackage (demo) creates one native shipment and returns its numeric package_id; replay adds nothing',async()=>{
  const f=fixture(),key=uid(79),p={order_id:502,courier_code:'demo',packages:[parcel]};
  const r=await f.service.execute(actor(1),'createPackage',p,{clientKey:key});
  const pkg={package_id:900,package_number:'DEMO-901',courier_inner_number:''};
  assert.deepEqual(r,{...pkg,packages:[pkg]});
  assert.deepEqual(f.state.audits,[{id:uid(900),detail:{courier_code:'demo',packages:[{weight:1.5,size_length:30,size_width:20,size_height:10}]}}]);
  assert.deepEqual(await f.service.execute(actor(1),'createPackage',p,{clientKey:key}),r);
  assert.equal(f.state.shipments.length,1);
  // Without a key the native rule refuses a second shipment (order already shipped).
  await assert.rejects(f.service.execute(actor(1),'createPackage',p),(e:any)=>e.status===409);
  assert.equal(f.state.shipments.length,1);
});
test('createPackage refuses async couriers, unmapped data and foreign orders without effect',async()=>{
  const f=fixture();const reject=async(p:any,check:(e:any)=>boolean,a=actor(1))=>{
    await assert.rejects(f.service.execute(a,'createPackage',{order_id:502,courier_code:'demo',packages:[parcel],...p}),check);
    assert.equal(f.state.shipments.length,0);assert.equal(f.state.orders[1].status,'packed');};
  for(const courier_code of ['inpost','dpd'])await reject({courier_code},e=>e.status===422&&e.code==='LOCAL_BASE_WIRE_COURIER_ASYNC');
  await reject({courier_code:'gls'},e=>e.status===404);
  await reject({account_id:5},e=>e.status===404);
  await reject({fields:[{id:'cod',value:'1'}]},e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({packages:[parcel,parcel]},e=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await reject({packages:[{...parcel,declared_content:'Kubki'}]},e=>e.name==='ZodError');
  await reject({packages:[{size_length:1}]},e=>e.name==='ZodError');    // weight required (Base contract)
  await reject({packages:[{weight:0}]},e=>e.name==='ZodError');
  await reject({packages:[]},e=>e.name==='ZodError');
  await reject({order_id:504},e=>e.status===404);                       // other tenant's order
  await reject({order_id:501},e=>e.status===409);                       // not packed (native)
  await reject({},e=>e.status===403,actor(1,'viewer'));
  await reject({extra:1},e=>e.name==='ZodError');
  assert.ok(await f.service.execute(actor(1),'createPackage',{order_id:502,courier_code:'demo',account_id:0,fields:[],packages:[{weight:'2'}]}));
});
test('getLabel returns the native label as base64 by package_id or number of the right courier only',async()=>{
  const f=fixture();
  const pkg=await f.service.execute(actor(1),'createPackage',{order_id:502,courier_code:'demo',packages:[parcel]}) as any;
  const html={extension:'html',label:Buffer.from('<html>DEMO-901</html>').toString('base64')};
  assert.deepEqual(await f.service.execute(actor(1),'getLabel',{courier_code:'demo',package_id:pkg.package_id}),html);
  assert.deepEqual(await f.service.execute(actor(1),'getLabel',{courier_code:'demo',package_number:'DEMO-901'}),html);
  assert.deepEqual(await f.service.execute(actor(1),'getLabel',{courier_code:'demo',package_id:900,package_number:'DEMO-901'}),html);
  await assert.rejects(f.service.execute(actor(1),'getLabel',{courier_code:'demo',package_id:900,package_number:'DEMO-X'}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1),'getLabel',{courier_code:'dpd',package_id:900}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(2),'getLabel',{courier_code:'demo',package_id:900}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1),'getLabel',{courier_code:'demo'}),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(1),'getLabel',{package_id:900}),(e:any)=>e.name==='ZodError');
  // Stored DPD PDF; InPost would be a provider request and is refused locally.
  f.state.shipments.push({tenant:uid(1),order:uid(31),id:uid(950),public_id:950,tracking_number:'DPD1',mode:'sandbox',carrier:'DPD Polska'},
    {tenant:uid(1),order:uid(33),id:uid(951),public_id:951,tracking_number:'INP1',mode:'live',carrier:'InPost ShipX'});
  assert.deepEqual(await f.service.execute(actor(1),'getLabel',{courier_code:'dpd',package_id:950}),{extension:'pdf',label:Buffer.from('%PDF-1.4 dpd').toString('base64')});
  await assert.rejects(f.service.execute(actor(1),'getLabel',{courier_code:'inpost',package_number:'INP1'}),(e:any)=>e.code==='LOCAL_BASE_WIRE_LABEL_PROVIDER');
});
test('connector.php: a read-only copy refuses fulfillment writes but serves reads',async t=>{
  const f=fixture(),app=Fastify();t.after(()=>app.close());
  const scopes:string[]=[];
  registerBaseWireRoutes(app,{readOnly:true,families:[createBaseWireFulfillmentFamily({service:f.service,available:true,pickListsAvailable:true})],
    authenticate:async(_token,scope)=>{scopes.push(scope);return {id:uid(11),tenant_id:uid(1),role:'admin',api_key_id:uid(21),scopes:[scope]};}});
  const call=(method:string,parameters:unknown)=>app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'dyna_api_closed'},
    payload:new URLSearchParams({method,parameters:JSON.stringify(parameters)}).toString()});
  for(const [method,p] of [['addOrderPickList',{order_ids:[501]}],['createPackage',{order_id:502,courier_code:'demo',packages:[parcel]}]] as const){
    const w=await call(method,p);assert.equal(w.statusCode,423);assert.equal(w.json().status,'ERROR');}
  assert.equal(f.state.waves.length+f.state.shipments.length,0);
  const r=await call('getOrderSources',{});assert.equal(r.statusCode,200);assert.equal(r.json().status,'SUCCESS');
  const a=await call('createPackage',{order_id:502,courier_code:'inpost',packages:[parcel]});assert.equal(a.statusCode,423);
  for(const [method,p] of [['getCouriersList',{}],['getOrderPackages',{order_id:501}],['getPackageDetails',{package_id:950}],['getCourierPackagesStatusHistory',{package_ids:[950]}]] as const){
    const w=await call(method,p);assert.equal(w.statusCode,200,w.body);assert.equal(w.json().status,'SUCCESS');}
  const bad=await call('getOrderPackages',{order_id:501,include:'all'});assert.equal(bad.statusCode,422);assert.equal(bad.json().status,'ERROR');
  assert.deepEqual(scopes,Array(6).fill('orders:read'));
});
const inpost={package_id:950,courier_package_nr:'INP1',courier_inner_number:'123456789',courier_code:'inpost',courier_other_name:'',account_id:0,
  tracking_status_date:Date.parse('2026-10-21T08:00:00Z')/1000,tracking_delivery_days:0,tracking_status:5,package_type:0,tracking_url:'',is_return:false};
test('tracking status table: native statuses map into Base 0..12, anything else is 0',()=>{
  for(const v of BASE_WIRE_TRACKING_STATUS.values())assert(Number.isInteger(v)&&v>=1&&v<=12);
  assert.deepEqual(['created','label_ready','confirmed','collected_from_sender','delivery_failed','out_for_delivery','delivered','returned_to_sender','return_in_transit','avizo','ready_to_pickup','lost','canceled','in_transit','redirected','claimed']
    .map(baseWireTrackingStatus),[1,1,1,2,3,4,5,6,6,7,8,9,10,11,11,12]);
  for(const unknown of [null,'','constructor','__proto__','toString','unknown','nowy_status'])assert.equal(baseWireTrackingStatus(unknown),0);
});
test('getOrderPackages lists the own operational order\'s native shipments by package_id',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.execute(actor(1),'getOrderPackages',{order_id:501}),{packages:[inpost,{package_id:951,courier_package_nr:'0000123',courier_inner_number:'',
    courier_code:'dpd',courier_other_name:'',account_id:0,tracking_status_date:Date.parse('2026-10-20T10:00:00Z')/1000,tracking_delivery_days:0,tracking_status:4,package_type:0,tracking_url:'',is_return:false}]});
  const demo=(await f.service.execute(actor(1),'getOrderPackages',{order_id:502}) as any).packages;
  assert.deepEqual(demo.map((p:any)=>[p.package_id,p.courier_code,p.courier_inner_number,p.tracking_status]),[[900,'demo','',1],[901,'demo','',1]]);
  // A simulated InPost shipment (mode demo) is the demo courier, as in getLabel.
  assert.equal((await f.service.execute(actor(1),'getOrderPackages',{order_id:503}) as any).packages[0].courier_code,'demo');
  // An unmapped native carrier keeps its name in courier_other_name.
  f.state.records.push(rec(1,33,953,{mode:'live',carrier:'Kurier zewnętrzny regionalny XL'}));
  const other=(await f.service.execute(actor(1),'getOrderPackages',{order_id:503}) as any).packages[1];
  assert.deepEqual([other.package_id,other.courier_code,other.courier_other_name],[953,'','Kurier zewnętrzny re']);
  assert.deepEqual(await f.service.execute(actor(2),'getOrderPackages',{order_id:504}),{packages:[{...inpost,package_id:960,courier_package_nr:'DEMO-960',courier_inner_number:'',
    courier_code:'demo',tracking_status_date:Date.parse('2026-10-20T10:00:00Z')/1000,tracking_status:1}]});
  for(const [a,p] of [[actor(1),{order_id:504}],[actor(2),{order_id:501}],[actor(1),{order_id:999}],[actor(1),{order_id:505}]] as const)
    await assert.rejects(f.service.execute(a,'getOrderPackages',p),(e:any)=>e.status===404,JSON.stringify(p));
  for(const p of [{},{order_id:0},{order_id:'501'},{order_id:501,extra:1},{order_id:1.5}] as any[])
    await assert.rejects(f.service.execute(actor(1),'getOrderPackages',p),(e:any)=>e.name==='ZodError',JSON.stringify(p));
  assert(f.state.writes.every(w=>w===false),'read transactions only');
});
test('getPackageDetails maps only native parcel data: plan (InPost/DPD), recorded createPackage parcel, COD',async()=>{
  const f=fixture();const details=async(id:number)=>(await f.service.execute(actor(1),'getPackageDetails',{package_id:id}) as any);
  const empty={weight:0,weight_unit:'',length:0,width:0,height:0,size_unit:'',size_template:'',is_custom:false,cod_value:0,cod_currency:'PLN',
    insurance_value:0,insurance_currency:'',cost_value:0,cost_currency:'',type:'',pickup_date:0,service:'',additional_services:[],courier_packaging_type:''};
  assert.deepEqual(await details(950),{package_details:[{...empty,weight:1,weight_unit:'kg',size_template:'small',cod_value:25.5,insurance_value:50,insurance_currency:'PLN',
    cost_value:12.99,cost_currency:'PLN',service:'inpost_locker_standard'}],additional_fields:[]});
  assert.deepEqual((await details(951)).package_details,[{...empty,weight:2.5,weight_unit:'kg',length:30,width:20,height:10,size_unit:'cm',is_custom:true,insurance_currency:'PLN'}]);
  // InPost courier dimensions are stored in mm and returned in cm.
  assert.deepEqual((await details(952)).package_details,[{...empty,weight:3,weight_unit:'kg',length:30,width:20,height:10.5,size_unit:'cm',is_custom:true,insurance_currency:'PLN',
    cost_value:21,cost_currency:'PLN',service:'inpost_courier_standard'}]);
  assert.deepEqual((await details(900)).package_details,[{...empty,weight:1.5,weight_unit:'kg',length:30,width:20,height:10,size_unit:'cm',is_custom:true}]);
  // A demo shipment made in the panel has no recorded parcel: units stay empty.
  assert.deepEqual((await details(901)).package_details,[{...empty,cod_value:49.99,cod_currency:'EUR'}]);
  f.state.records.push(rec(1,33,954,{recorded:{weight:2}}));
  assert.deepEqual((await details(954)).package_details,[{...empty,weight:2,weight_unit:'kg'}]);
  await assert.rejects(f.service.execute(actor(2),'getPackageDetails',{package_id:950}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1),'getPackageDetails',{package_id:960}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1),'getPackageDetails',{package_id:12345}),(e:any)=>e.status===404);
  for(const p of [{},{package_id:-1},{package_id:950,courier_code:'inpost'}] as any[])
    await assert.rejects(f.service.execute(actor(1),'getPackageDetails',p),(e:any)=>e.name==='ZodError',JSON.stringify(p));
});
test('getCourierPackagesStatusHistory returns stored native events per package, oldest first; all-or-nothing',async()=>{
  const f=fixture();const at=(s:string)=>Date.parse(s)/1000;
  assert.deepEqual(await f.service.execute(actor(1),'getCourierPackagesStatusHistory',{package_ids:[951,950,900]}),{packages_history:{
    '951':[{tracking_status_date:at('2026-10-20T09:00:00Z'),courier_status_code:'030103',tracking_status:1},
      {tracking_status_date:at('2026-10-20T09:30:00Z'),courier_status_code:'999999',tracking_status:0},
      {tracking_status_date:at('2026-10-21T07:00:00Z'),courier_status_code:'170101',tracking_status:4}],
    '950':[{tracking_status_date:at('2026-10-20T08:00:00Z'),courier_status_code:'confirmed',tracking_status:1},
      {tracking_status_date:at('2026-10-20T18:00:00Z'),courier_status_code:'nowy_status_inpost',tracking_status:0},
      {tracking_status_date:at('2026-10-21T08:00:00Z'),courier_status_code:'delivered',tracking_status:5}],
    '900':[]}});
  assert.deepEqual(Object.keys((await f.service.execute(actor(1),'getCourierPackagesStatusHistory',{package_ids:[951,950,900]}) as any).packages_history),['900','950','951'],
    'JSON object keys of integers are ordered numerically');
  for(const [a,p] of [[actor(1),[950,960]],[actor(2),[950]],[actor(1),[950,123456]]] as [Actor,number[]][])
    await assert.rejects(f.service.execute(a,'getCourierPackagesStatusHistory',{package_ids:p}),(e:any)=>e.status===404,JSON.stringify(p));
  for(const p of [{},{package_ids:[]},{package_ids:[950,950]},{package_ids:['950']},{package_ids:Array.from({length:101},(_,i)=>i+1)},{package_ids:[950],courier_code:'inpost'},{package_id:950}] as any[])
    await assert.rejects(f.service.execute(actor(1),'getCourierPackagesStatusHistory',p),(e:any)=>e.name==='ZodError',JSON.stringify(p).slice(0,80));
  // 100 ids is the batch limit, not a refusal (unknown ones then refuse as 404).
  await assert.rejects(f.service.execute(actor(1),'getCourierPackagesStatusHistory',{package_ids:Array.from({length:100},(_,i)=>i+1)}),(e:any)=>e.status===404);
  f.state.records[2].events.push({at:'nie-data',status:'delivered',code:null});
  await assert.rejects(f.service.execute(actor(1),'getCourierPackagesStatusHistory',{package_ids:[950]}),(e:any)=>e.status===503);
});
test('getCouriersList: the local simulator always, DPD/InPost only with a native shipping channel',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.execute(actor(1),'getCouriersList',{}),{couriers:[{code:'demo',name:'Symulator lokalny'},{code:'dpd',name:'DPD Polska'},{code:'inpost',name:'InPost ShipX'}]});
  assert.deepEqual(await f.service.execute(actor(2),'getCouriersList',{}),{couriers:[{code:'demo',name:'Symulator lokalny'}]});
  f.state.couriers[uid(2)]=['inpost'];
  assert.deepEqual(await f.service.execute(actor(2),'getCouriersList',{}),{couriers:[{code:'demo',name:'Symulator lokalny'},{code:'inpost',name:'InPost ShipX'}]});
  await assert.rejects(f.service.execute(actor(1),'getCouriersList',{courier:'dpd'}),(e:any)=>e.name==='ZodError');
  // Reads need no write role.
  assert.ok(await f.service.execute(actor(1,'viewer'),'getCouriersList',{}));
  assert.ok(await f.service.execute(actor(1,'viewer'),'getOrderPackages',{order_id:501}));
  assert.deepEqual(f.state.writes,[false,false,false,false,false]);
});
