/** Actual Base inventory family service + registry on CLOSED native ports.
 * The real SQL/RLS/native writer is covered by base-wire-inventory.database.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createBaseWireInventoryService, createBaseWireInventoryFamily, BASE_WIRE_INVENTORY_METHODS, BASE_WIRE_BASE_PRICE_GROUP_ID as BASE, type BaseWireInventoryNative, type BaseWireInventoryProduct, type BaseWireInventoryListQuery } from '../server/base-wire-inventory';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireCrmFamily } from '../server/base-wire-crm-routes';
import { baseWireRequiredScopes } from '../server/developer-api';
import { Problem, ensure } from '../server/errors';
import type { Actor } from '../server/domain';

const uid=(n:number)=>`72000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=(t:number):Actor=>({tenantId:uid(t),userId:uid(10+t),role:'admin',apiKeyId:uid(20+t),source:'api'});
type Product=Omit<BaseWireInventoryProduct,'stock'|'parent_public_id'|'bundle'|'category_public_id'|'translations'>&{tenant:string;catalog:string;parent:string|null;components?:{id:string;quantity:number}[];category?:number;translations?:BaseWireInventoryProduct['translations']};
function fixture(caps:{categories?:boolean;allocateOnRead?:boolean}={}) {
  const s={
    warehouses:[{tenant:uid(1),id:uid(31),public_id:7,name:'Główny',code:'MAG'},{tenant:uid(1),id:uid(32),public_id:9,name:'Drugi',code:'M2'},{tenant:uid(2),id:uid(33),public_id:8,name:'Obcy',code:'X'}],
    catalogs:[{tenant:uid(1),id:uid(41),public_id:3,name:'Domyślny',is_default:true,languages:['en','pl'],default_language:'pl',warehouses:[uid(31)],groups:[12,11]},
      {tenant:uid(1),id:uid(42),public_id:4,name:'Drugi',is_default:false,languages:['pl'],default_language:'pl',warehouses:[uid(31)],groups:[]},
      {tenant:uid(2),id:uid(43),public_id:5,name:'Obcy',is_default:true,languages:['pl'],default_language:'pl',warehouses:[uid(33)],groups:[13]}],
    products:[
      {tenant:uid(1),catalog:uid(41),id:uid(51),public_id:101,kind:'simple',parent:null,sku:'A-1',ean:null,vat:23,tags:['nowy'],name:'Kubek',description:'Opis',images:['https://x/1.jpg']},
      {tenant:uid(1),catalog:uid(41),id:uid(52),public_id:102,kind:'group',parent:null,sku:'G-1',ean:'590',vat:8,tags:[],name:'Koszulka',description:'',images:[]},
      {tenant:uid(1),catalog:uid(41),id:uid(53),public_id:103,kind:'variant',parent:uid(52),sku:'G-1-M',ean:'591',vat:8,tags:[],name:'Koszulka M',description:'',images:[]},
      {tenant:uid(1),catalog:uid(41),id:uid(54),public_id:104,kind:'bundle',parent:null,sku:'B-1',ean:null,vat:23,tags:[],name:'Zestaw',description:'',images:[],components:[{id:uid(51),quantity:2}]},
      {tenant:uid(1),catalog:uid(42),id:uid(55),public_id:105,kind:'simple',parent:null,sku:'C-1',ean:null,vat:23,tags:[],name:'Inny katalog',description:'',images:[]},
      {tenant:uid(2),catalog:uid(43),id:uid(56),public_id:106,kind:'simple',parent:null,sku:'F-1',ean:null,vat:23,tags:[],name:'Obca firma',description:'',images:[]},
    ] as Product[],
    stock:[
      {tenant:uid(1),product:uid(51),warehouse:uid(31),on_hand:10,reserved:2,location:'A-01'},
      {tenant:uid(1),product:uid(53),warehouse:uid(31),on_hand:4,reserved:0,location:'B-02'},
      {tenant:uid(2),product:uid(56),warehouse:uid(33),on_hand:5,reserved:0,location:'A-01'},
    ],
    // Native PIM categories with their 224 ID (null = created after the last allocation).
    categories:[{tenant:uid(1),catalog:uid(41),public_id:5 as number|null,parent:null as number|null,name:'Kuchnia'},{tenant:uid(1),catalog:uid(41),public_id:7 as number|null,parent:5 as number|null,name:'Kubki'},
      {tenant:uid(1),catalog:uid(42),public_id:6 as number|null,parent:null as number|null,name:'Inny katalog'},{tenant:uid(2),catalog:uid(43),public_id:8 as number|null,parent:null as number|null,name:'Obca'}],
    allocations:[] as string[],
    idempotency:[] as {tenant:string;key:string;hash:string;response:any}[],
    listQueries:[] as BaseWireInventoryListQuery[],adjustments:[] as any[],enlisted:[] as string[],credentials:[] as (string|undefined)[],wms:false,strict:false,
  };
  let state=structuredClone(s);
  const publicOf=(tenant:string,id:string)=>state.products.find(p=>p.tenant===tenant&&p.id===id)!.public_id;
  const dto=(p:Product):BaseWireInventoryProduct=>({id:p.id,public_id:p.public_id,kind:p.kind,parent_public_id:p.parent?publicOf(p.tenant,p.parent):null,sku:p.sku,ean:p.ean,vat:p.vat,tags:p.tags,name:p.name,description:p.description,images:p.images,
    stock:state.stock.filter(x=>x.tenant===p.tenant&&x.product===p.id).map(x=>({warehouse_public_id:state.warehouses.find(w=>w.id===x.warehouse)!.public_id,on_hand:x.on_hand,reserved:x.reserved,location:x.location})),
    bundle:(p.components??[]).map(c=>({public_id:publicOf(p.tenant,c.id),quantity:c.quantity})),category_public_id:p.category??null,translations:p.translations??[]});
  const native=(_c:unknown,a:Actor,credential?:string):BaseWireInventoryNative=>{
    const t=a.tenantId;state.credentials.push(credential);
    return {
      warehouses:async()=>state.warehouses.filter(w=>w.tenant===t).sort((x,y)=>x.public_id-y.public_id).map(({tenant:_t,...w})=>w),
      stockEditable:async()=>!state.wms,
      catalogs:async()=>state.catalogs.filter(c=>c.tenant===t).map(c=>({public_id:c.public_id,name:c.name,is_default:c.is_default,languages:c.languages,default_language:c.default_language,
        warehouse_public_ids:c.warehouses.map(w=>state.warehouses.find(x=>x.id===w)!.public_id).sort((x,y)=>x-y),price_group_public_ids:[...c.groups].sort((x,y)=>x-y)})),
      productList:async(catalog,q)=>{
        const total=(p:Product)=>state.stock.filter(x=>x.tenant===t&&x.product===p.id).reduce((n,x)=>n+x.on_hand,0);
        const rows=state.products.filter(p=>p.tenant===t&&p.catalog===catalog&&(q.id===null||p.public_id===q.id)&&(q.ean===null||p.ean===q.ean)&&(q.sku===null||p.sku===q.sku)
          &&(q.name===null||p.name.toLowerCase().includes(q.name.toLowerCase()))&&(q.include_variants||p.kind!=='variant')&&(q.category===null||p.category===q.category)&&(q.stock_from===null||total(p)>=q.stock_from)&&(q.stock_to===null||total(p)<=q.stock_to))
          .sort((x,y)=>q.descending?y.public_id-x.public_id:x.public_id-y.public_id).slice((q.page-1)*q.page_size,q.page*q.page_size).map(dto);
        state.listQueries.push(q);
        return rows.map(p=>({public_id:p.public_id,parent_public_id:p.parent_public_id,sku:p.sku,ean:p.ean,name:p.name,stock:p.stock.map(x=>({warehouse_public_id:x.warehouse_public_id,on_hand:x.on_hand}))}));
      },
      catalog:async n=>state.catalogs.find(c=>c.tenant===t&&c.public_id===n)?.id??null,
      products:async(catalog,ids)=>state.products.filter(p=>p.tenant===t&&p.catalog===catalog&&ids.includes(p.public_id)).map(dto),
      allocateCategories:async()=>{state.allocations.push(t);let next=Math.max(0,...state.categories.map(c=>c.public_id??0));for(const c of state.categories)if(c.tenant===t&&c.public_id===null)c.public_id=++next;},
      categories:async catalog=>state.categories.filter(c=>c.tenant===t&&c.catalog===catalog&&c.public_id!==null).sort((x,y)=>x.public_id!-y.public_id!)
        .map(c=>({public_id:c.public_id!,parent_public_id:c.parent,name:c.name})),
      variants:async(catalog,parents)=>state.products.filter(p=>p.tenant===t&&p.catalog===catalog&&p.kind==='variant'&&parents.includes(p.parent!)).map(dto),
      replay:async(key,hash)=>{let row=state.idempotency.find(x=>x.tenant===t&&x.key===key);if(!row)state.idempotency.push(row={tenant:t,key,hash,response:null});
        ensure(row.hash===hash,409,'Klucz polecenia wskazuje inną treść');return structuredClone(row.response);},
      remember:async(key,response)=>{state.idempotency.find(x=>x.tenant===t&&x.key===key)!.response=structuredClone(response);},
      writableCatalog:async catalog=>{ensure(!state.wms,409,'WMS jest aktywny');ensure(!state.strict,409,'Ścisła korekta');return {warehouseIds:state.catalogs.find(c=>c.tenant===t&&c.id===catalog)!.warehouses};},
      lockStock:async cells=>new Map(state.stock.filter(x=>x.tenant===t&&cells.some(c=>c.product_id===x.product&&c.warehouse_id===x.warehouse)).map(x=>[x.product+':'+x.warehouse,{on_hand:x.on_hand,reserved:x.reserved}])),
      enlist:async id=>{state.enlisted.push(id);},
      adjust:async cell=>{const x=state.stock.find(r=>r.tenant===t&&r.product===cell.product_id&&r.warehouse===cell.warehouse_id)!;ensure(x.on_hand+cell.delta>=x.reserved,409,'rezerwacje');x.on_hand+=cell.delta;state.adjustments.push({tenant:t,...cell});},
    };
  };
  let loseAck=false;
  // Closed transaction port: all-or-nothing state, optionally losing the COMMIT acknowledgement.
  const service=createBaseWireInventoryService({...caps,native:native as any,transaction:async(_a,_w,work)=>{
    const before=structuredClone(state);
    try{const r=await work({} as any);if(loseAck){loseAck=false;throw new Problem(500,'lost ack');}return r;}catch(e){if(!(e instanceof Problem&&e.message==='lost ack'))state=before;throw e;}
  }});
  return {service,get state(){return state;},set state(v){state=v;},loseAck:()=>{loseAck=true;}};
}
const opts={credential:'dyna_api_'+'a'.repeat(64)};

test('write scopes require the family read scope; reads and single scopes stay single',()=>{
  assert.deepEqual(baseWireRequiredScopes('inventory:write'),['inventory:read','inventory:write']);
  assert.deepEqual(baseWireRequiredScopes('inventory:read'),['inventory:read']);
  assert.deepEqual(baseWireRequiredScopes('crm:write'),['crm:read','crm:write']);
  assert.deepEqual(baseWireRequiredScopes('order-fields:admin'),['order-fields:admin']);
  assert.deepEqual(baseWireRequiredScopes('returns:configure'),['returns:configure']);
  assert.throws(()=>baseWireRequiredScopes('inventory:delete' as any),(e:any)=>e.status===403);
});
test('getInventoryWarehouses returns own Base-native warehouses with numeric IDs only',async()=>{
  const f=fixture();
  const r=await f.service.execute(actor(1),'getInventoryWarehouses',{});
  assert.deepEqual(r,{warehouses:[
    {warehouse_type:'bl',warehouse_id:7,internal_warehouse_id:7,name:'Główny',description:'',stock_edition:true,is_default:false,address:'',postcode:'',city:'',country:''},
    {warehouse_type:'bl',warehouse_id:9,internal_warehouse_id:9,name:'Drugi',description:'',stock_edition:true,is_default:false,address:'',postcode:'',city:'',country:''}]});
  f.state.wms=true;assert.equal(((await f.service.execute(actor(1),'getInventoryWarehouses',{})).warehouses as any)[0].stock_edition,false);
  await assert.rejects(f.service.execute(actor(1),'getInventoryWarehouses',{inventory_id:3}),(e:any)=>e.name==='ZodError');
});
test('getInventories lists own catalogs with numeric IDs, bl_ warehouses and price groups (base group default)',async()=>{
  const f=fixture();
  assert.deepEqual(await f.service.execute(actor(1),'getInventories',{}),{inventories:[
    {inventory_id:3,name:'Domyślny',description:'',languages:['en','pl'],default_language:'pl',price_groups:[11,12,BASE],default_price_group:BASE,warehouses:['bl_7'],default_warehouse:'',reservations:true,is_default:true},
    {inventory_id:4,name:'Drugi',description:'',languages:['pl'],default_language:'pl',price_groups:[BASE],default_price_group:BASE,warehouses:['bl_7'],default_warehouse:'',reservations:true,is_default:false}]});
  assert.deepEqual(((await f.service.execute(actor(2),'getInventories',{})).inventories as any[]).map(x=>x.inventory_id),[5]);
  await assert.rejects(f.service.execute(actor(1),'getInventories',{inventory_id:3}),(e:any)=>e.name==='ZodError');
});
test('getInventoryProductsList returns basic rows of one own catalog with supported filters',async()=>{
  const f=fixture();
  const r:any=await f.service.execute(actor(1),'getInventoryProductsList',{inventory_id:3});
  // Variants only with include_variants; 105 (other own catalog) and 106 (other tenant) never.
  assert.deepEqual(r,{products:{
    '101':{id:101,parent_id:0,ean:'',sku:'A-1',name:'Kubek',stock:{bl_7:10}},
    '102':{id:102,parent_id:0,ean:'590',sku:'G-1',name:'Koszulka',stock:{}},
    '104':{id:104,parent_id:0,ean:'',sku:'B-1',name:'Zestaw',stock:{}}}});
  const keys=async(p:Record<string,unknown>,a=actor(1))=>Object.keys(((await f.service.execute(a,'getInventoryProductsList',{inventory_id:3,...p})) as any).products);
  assert.deepEqual((await f.service.execute(actor(1),'getInventoryProductsList',{inventory_id:3,include_variants:true}) as any).products['103'],{id:103,parent_id:102,ean:'591',sku:'G-1-M',name:'Koszulka M',stock:{bl_7:4}});
  assert.deepEqual(await keys({filter_id:101}),['101']);assert.deepEqual(await keys({filter_id:105}),[]);
  assert.deepEqual(await keys({filter_ean:'591',include_variants:true}),['103']);assert.deepEqual(await keys({filter_sku:'B-1'}),['104']);
  assert.deepEqual(await keys({filter_sku:'b-1'}),[]);assert.deepEqual(await keys({filter_name:'KOSZ',include_variants:true}),['102','103']);
  assert.deepEqual(await keys({filter_stock_from:4,include_variants:true}),['101','103']);assert.deepEqual(await keys({filter_stock_to:4,filter_stock_from:1,include_variants:true}),['103']);
  // Empty values mean "no filter", also for unsupported filters.
  assert.deepEqual(await keys({filter_name:'',filter_ean:null,filter_category_id:'',filter_tag:null,filter_price_from:null,filter_locations:''}),['101','102','104']);
  assert.deepEqual(await keys({},actor(2)).catch((e:any)=>e.status),404);
  assert.deepEqual(f.state.listQueries[0],{id:null,ean:null,sku:null,name:null,stock_from:null,stock_to:null,category:null,include_variants:false,descending:false,page:1,page_size:1000});
});
test('getInventoryProductsList pages by 1000 with id ASC/DESC and refuses unsupported filters',async()=>{
  const f=fixture();
  for(let n=0;n<1000;n++)f.state.products.push({tenant:uid(1),catalog:uid(41),id:uid(1000+n),public_id:2000+n,kind:'simple',parent:null,sku:'P-'+n,ean:null,vat:23,tags:[],name:'Masowy '+n,description:'',images:[]});
  const page=async(p:Record<string,unknown>)=>Object.keys(((await f.service.execute(actor(1),'getInventoryProductsList',{inventory_id:3,...p})) as any).products).map(Number);
  const first=await page({page:1}),second=await page({page:2}),third=await page({page:3});
  assert.equal(first.length,1000);assert.deepEqual(first.slice(0,3),[101,102,104]);assert.equal(first.at(-1),2996);
  assert.deepEqual(second,[2997,2998,2999]);assert.deepEqual(third,[]);assert.deepEqual(await page({}),first);
  const desc=await page({filter_sort:'id DESC'}),desc2=await page({filter_sort:'id DESC',page:2});
  // id DESC selects the page from the top; integer-like JSON keys still serialize ascending.
  assert.equal(desc.length,1000);assert.equal(Math.min(...desc),2000);assert.deepEqual(desc2,[101,102,104]);
  for(const filter of ['filter_category_id','filter_tag','filter_price_from','filter_price_to','filter_locations'])
    await assert.rejects(f.service.execute(actor(1),'getInventoryProductsList',{inventory_id:3,[filter]:filter==='filter_locations'?'A-01':1}),(e:any)=>e.status===422&&e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FILTER');
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsList',{inventory_id:3,filter_category_id:0}),(e:any)=>e.status===422);
  for(const parameters of [{},{inventory_id:3,page:0},{inventory_id:3,page:1.5},{inventory_id:3,filter_sort:'name ASC'},{inventory_id:3,filter_sort:'id asc'},{inventory_id:3,filter_id:'101'},
    {inventory_id:3,filter_sku:'x'.repeat(51)},{inventory_id:3,filter_ean:'1'.repeat(33)},{inventory_id:3,include_variants:'1'},{inventory_id:3,filter_stock_from:1.5},{inventory_id:3,extra:1}])
    await assert.rejects(f.service.execute(actor(1),'getInventoryProductsList',parameters as any),(e:any)=>e.name==='ZodError',JSON.stringify(parameters));
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsList',{inventory_id:5}),(e:any)=>e.status===404);
});
test('getInventoryProductsData keys products by numeric ID with variants, bundles and bl_ stock maps',async()=>{
  const f=fixture();
  const r:any=await f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:[101,102,103,104,105,106,999]});
  // 105 is in another own catalog, 106 belongs to another tenant, 999 does not exist: all absent.
  assert.deepEqual(Object.keys(r.products),['101','102','103','104']);
  assert.deepEqual(r.products['101'],{is_bundle:false,parent_id:0,sku:'A-1',ean:'',tags:['nowy'],tax_rate:23,text_fields:{name:'Kubek',description:'Opis'},
    stock:{bl_7:10},reservations:{bl_7:2},locations:{bl_7:'A-01'},images:{'1':'https://x/1.jpg'},variants:{}});
  assert.deepEqual(r.products['102'].variants,{'103':{name:'Koszulka M',sku:'G-1-M',ean:'591',stock:{bl_7:4},locations:{bl_7:'B-02'}}});
  assert.equal(r.products['103'].parent_id,102);assert.deepEqual(r.products['103'].variants,{});
  assert.equal(r.products['104'].is_bundle,true);assert.deepEqual(r.products['104'].bundle_products,{'101':2});
  assert.equal(Object.hasOwn(r.products['101'],'bundle_products'),false);
  assert.deepEqual(await f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:[]}),{products:{}});
});
test('getInventoryProductsData returns native translations as name|xx/description|xx (two-letter, not the default language)',async()=>{
  const f=fixture();
  f.state.products[0].translations=[{locale:'pl',name:'Kubek PL',description:'Opis PL'},{locale:'en',name:'Mug',description:'A mug'},{locale:'en-gb',name:'Mug GB',description:''},{locale:'de',name:'Becher',description:''}];
  f.state.products[2].translations=[{locale:'en',name:'T-shirt M',description:''}];
  const r:any=await f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:[101,103]});
  // Unqualified keys stay the native product (catalog default pl); a pl row and en-gb are not returned.
  assert.deepEqual(r.products['101'].text_fields,{name:'Kubek',description:'Opis','name|de':'Becher','description|de':'','name|en':'Mug','description|en':'A mug'});
  assert.deepEqual(r.products['103'].text_fields,{name:'Koszulka M',description:'','name|en':'T-shirt M','description|en':''});
  // Another catalog default language: its own rows are the unqualified keys.
  f.state.catalogs[0].default_language='en';
  assert.deepEqual(((await f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:[101]})) as any).products['101'].text_fields,
    {name:'Kubek',description:'Opis','name|de':'Becher','description|de':'','name|pl':'Kubek PL','description|pl':'Opis PL'});
});
test('getInventoryProductsData refuses foreign catalogs, unsupported flags and oversized input',async()=>{
  const f=fixture();
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:5,products:[106]}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(2),'getInventoryProductsData',{inventory_id:3,products:[101]}),(e:any)=>e.status===404);
  assert.deepEqual(await f.service.execute(actor(2),'getInventoryProductsData',{inventory_id:5,products:[101,106]}).then((r:any)=>Object.keys(r.products)),['106']);
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:[101],include_suppliers:true}),(e:any)=>e.status===422&&e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FLAG');
  assert.ok(await f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:[101],include_suppliers:false}));
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:Array.from({length:1001},(_,n)=>n+1)}),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsData',{products:[101]}),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:[101],extra:1}),(e:any)=>e.name==='ZodError');
});
test('224 categories: getInventoryCategories per catalog, category_id in product data, filter_category_id; allocation before reads',async()=>{
  const f=fixture({categories:true,allocateOnRead:true});
  f.state.products.find(p=>p.public_id===101)!.category=7;f.state.products.find(p=>p.public_id===103)!.category=5;
  f.state.categories.push({tenant:uid(1),catalog:uid(41),public_id:null,parent:7,name:'Nowa'});
  assert.deepEqual(await f.service.execute(actor(1),'getInventoryCategories',{inventory_id:3}),{categories:[
    {category_id:5,name:'Kuchnia',parent_id:0},{category_id:7,name:'Kubki',parent_id:5},{category_id:9,name:'Nowa',parent_id:7}]});
  assert.deepEqual(f.state.allocations,[uid(1)]);
  // Shared categories (no inventory_id) do not exist natively; foreign catalog 404; strict input.
  assert.deepEqual(await f.service.execute(actor(1),'getInventoryCategories',{}),{categories:[]});
  assert.deepEqual(await f.service.execute(actor(1),'getInventoryCategories',{inventory_id:null}),{categories:[]});
  assert.deepEqual(await f.service.execute(actor(2),'getInventoryCategories',{inventory_id:5}),{categories:[{category_id:8,name:'Obca',parent_id:0}]});
  await assert.rejects(f.service.execute(actor(2),'getInventoryCategories',{inventory_id:3}),(e:any)=>e.status===404);
  for(const parameters of [{inventory_id:0},{inventory_id:'3'},{inventory_id:3,extra:1}])
    await assert.rejects(f.service.execute(actor(1),'getInventoryCategories',parameters as any),(e:any)=>e.name==='ZodError');
  const data:any=await f.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:[101,102,103]});
  assert.deepEqual([data.products['101'].category_id,data.products['102'].category_id,data.products['103'].category_id],[7,0,5]);
  const keys=async(p:Record<string,unknown>)=>Object.keys(((await f.service.execute(actor(1),'getInventoryProductsList',{inventory_id:3,...p})) as any).products);
  assert.deepEqual(await keys({filter_category_id:7}),['101']);assert.deepEqual(await keys({filter_category_id:5}),[]);
  assert.deepEqual(await keys({filter_category_id:5,include_variants:true}),['103']);assert.deepEqual(await keys({filter_category_id:8}),[]);
  assert.deepEqual(await keys({filter_category_id:''}),['101','102','104']);
  for(const value of [0,-1,'7',1.5])
    await assert.rejects(f.service.execute(actor(1),'getInventoryProductsList',{inventory_id:3,filter_category_id:value}),(e:any)=>e.name==='ZodError');
  // List rows keep the Base shape (no category_id field); allocation only before category reads.
  assert.equal(f.state.allocations.length,8);
  // A read-only copy never allocates: an unallocated category stays invisible.
  const ro=fixture({categories:true,allocateOnRead:false});
  ro.state.categories.push({tenant:uid(1),catalog:uid(41),public_id:null,parent:null,name:'Bez ID'});
  assert.deepEqual(((await ro.service.execute(actor(1),'getInventoryCategories',{inventory_id:3})) as any).categories.map((c:any)=>c.category_id),[5,7]);
  assert.deepEqual(ro.state.allocations,[]);
  // Without 224: getInventoryCategories 503, no category_id, filter refused like before.
  const off=fixture();
  await assert.rejects(off.service.execute(actor(1),'getInventoryCategories',{inventory_id:3}),(e:any)=>e.status===503);
  assert.equal(Object.hasOwn(((await off.service.execute(actor(1),'getInventoryProductsData',{inventory_id:3,products:[101]})) as any).products['101'],'category_id'),false);
  await assert.rejects(off.service.execute(actor(1),'getInventoryProductsList',{inventory_id:3,filter_category_id:7}),(e:any)=>e.status===422&&e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FILTER');
  assert.deepEqual(off.state.allocations,[]);
});
test('updateInventoryProductsStock sets absolute stock per product with Base counter and warnings',async()=>{
  const f=fixture();
  const r=await f.service.execute(actor(1),'updateInventoryProductsStock',{inventory_id:3,products:{
    '101':{bl_7:15},'103':{bl_7:4},'102':{bl_7:1},'104':{bl_7:1},'105':{bl_7:1},'106':{bl_8:1},'999':{bl_7:1}}},opts);
  assert.deepEqual(r,{counter:2,warnings:{'102':'Grupa i zestaw nie mają własnego stanu','104':'Grupa i zestaw nie mają własnego stanu',
    '105':'Nie znaleziono produktu w katalogu','106':'Nie znaleziono produktu w katalogu','999':'Nie znaleziono produktu w katalogu'}});
  // 103 already had 4: counted, but no movement. One native correction duty per transaction.
  assert.deepEqual(f.state.adjustments,[{tenant:uid(1),product_id:uid(51),warehouse_id:uid(31),delta:5,note:'Base API updateInventoryProductsStock'}]);
  assert.deepEqual(f.state.enlisted,[uid(51)]);assert.equal(f.state.credentials.at(-1),opts.credential);
  assert.equal(f.state.stock.find(x=>x.tenant===uid(2))!.on_hand,5);
});
test('updateInventoryProductsStock refuses foreign/unassigned/invalid warehouses and reservations per product',async()=>{
  const f=fixture();
  f.state.stock.push({tenant:uid(1),product:uid(51),warehouse:uid(32),on_hand:1,reserved:0,location:'A-01'});
  const r=await f.service.execute(actor(1),'updateInventoryProductsStock',{inventory_id:3,products:{
    '101':{bl_8:3},'103':{shop_7:3}}},opts);
  assert.deepEqual(r,{counter:0,warnings:{'101':'Nie znaleziono własnego magazynu Base','103':'Nie znaleziono własnego magazynu Base'}});
  assert.deepEqual((await f.service.execute(actor(1),'updateInventoryProductsStock',{inventory_id:3,products:{'101':{bl_9:3}}},opts) as any).warnings,{'101':'Magazyn nie jest przypisany do katalogu'});
  assert.deepEqual((await f.service.execute(actor(1),'updateInventoryProductsStock',{inventory_id:3,products:{'101':{bl_7:1}}},opts) as any).warnings,{'101':'Stan nie może być niższy niż rezerwacje'});
  f.state.stock=f.state.stock.filter(x=>x.product!==uid(53));
  assert.deepEqual((await f.service.execute(actor(1),'updateInventoryProductsStock',{inventory_id:3,products:{'103':{bl_7:1}}},opts) as any).warnings,{'103':'Brak stanu produktu w magazynie'});
  assert.deepEqual(f.state.adjustments,[]);assert.deepEqual(f.state.enlisted,[]);
  await assert.rejects(f.service.execute(actor(2),'updateInventoryProductsStock',{inventory_id:3,products:{'101':{bl_7:1}}},opts),(e:any)=>e.status===404);
  f.state.wms=true;
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsStock',{inventory_id:3,products:{'101':{bl_7:20}}},opts),(e:any)=>e.status===409);
  f.state.wms=false;f.state.strict=true;
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsStock',{inventory_id:3,products:{'101':{bl_7:20}}},opts),(e:any)=>e.status===409);
  assert.deepEqual(f.state.adjustments,[]);
});
test('updateInventoryProductsStock validates input and requires native credential custody',async()=>{
  const f=fixture();
  for(const parameters of [{inventory_id:3,products:{'101':{bl_7:-1}}},{inventory_id:3,products:{'101':{bl_7:1.5}}},{inventory_id:3,products:{'0':{bl_7:1}}},{products:{}},
    {inventory_id:3,products:Object.fromEntries(Array.from({length:1001},(_,n)=>[String(n+1),{bl_7:1}]))}])
    await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsStock',parameters as any,opts),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsStock',{inventory_id:3,products:{'101':{bl_7:11}}},{}),(e:any)=>e.status===503);
  await assert.rejects(f.service.execute({...actor(1),source:'manual',apiKeyId:undefined},'updateInventoryProductsStock',{inventory_id:3,products:{'101':{bl_7:11}}},opts),(e:any)=>e.status===503);
  // PIM methods belong to the family but not to this service (base-wire-inventory-pim.ts).
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsStock',{}),(e:any)=>e.status===400);
  await assert.rejects(f.service.execute(actor(1),'deleteInventoryProduct',{product_id:101}),(e:any)=>e.status===400);
  assert.deepEqual(f.state.adjustments,[]);
});
test('Idempotency-Key replays the committed result after a lost ACK without a second stock effect',async()=>{
  const f=fixture(),clientKey=uid(90),parameters={inventory_id:3,products:{'101':{bl_7:12}}};
  f.loseAck();
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsStock',parameters,{...opts,clientKey}),(e:any)=>e.status===500);
  assert.equal(f.state.adjustments.length,1);
  // Concurrent operator change after the lost ACK: a replay must not re-apply 12.
  f.state.stock.find(x=>x.product===uid(51))!.on_hand=30;
  assert.deepEqual(await f.service.execute(actor(1),'updateInventoryProductsStock',parameters,{...opts,clientKey}),{counter:1,warnings:{}});
  assert.equal(f.state.adjustments.length,1);assert.equal(f.state.stock.find(x=>x.product===uid(51))!.on_hand,30);
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsStock',{inventory_id:3,products:{'101':{bl_7:13}}},{...opts,clientKey}),(e:any)=>e.status===409);
  // Same key in another tenant is a separate command; a rolled-back attempt leaves no record.
  f.state.wms=true;
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsStock',parameters,{...opts,clientKey:uid(91)}),(e:any)=>e.status===409);
  f.state.wms=false;
  assert.deepEqual(await f.service.execute(actor(1),'updateInventoryProductsStock',parameters,{...opts,clientKey:uid(91)}),{counter:1,warnings:{}});
  assert.equal(f.state.stock.find(x=>x.product===uid(51))!.on_hand,12);
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsStock',parameters,{...opts,clientKey:'not-a-uuid'}),(e:any)=>e.name==='ZodError');
});

async function routes(scopes:Record<number,string[]>) {
  const app=Fastify(),calls:any[]=[],authenticated:string[]=[];await app.register(rateLimit,{max:600,timeWindow:60000});
  const inventory=createBaseWireInventoryFamily({available:true,service:{execute:async(a,method,parameters,options)=>{calls.push({family:'inventory',method,parameters,options,actor:a});return (method==='updateInventoryProductsStock'?{counter:0,warnings:{}}:{warehouses:[]}) as Record<string,any>;}}});
  const crm=createBaseWireCrmFamily({available:true,service:{execute:async(_a,method,_p,options)=>{calls.push({family:'crm',method,options});return {clients:[]};},file:async()=>assert.fail()}});
  registerBaseWireRoutes(app,{readOnly:false,families:[crm,inventory],authenticate:async(token,scope)=>{
    authenticated.push(scope);const m=/^dyna_api_([1-9])0+$/.exec(token);if(!m)throw new Problem(401,'x');const n=Number(m[1]);
    // Same rule as authenticateBaseWireApiKey.
    ensure(baseWireRequiredScopes(scope).every(s=>scopes[n].includes(s)),403,'Klucz API nie ma wymaganego zakresu');
    return {id:uid(10+n),tenant_id:uid(n),role:'admin',api_key_id:uid(20+n),scopes:scopes[n]};
  }});
  const request=(method:string,n:number,parameters:Record<string,unknown>,headers:Record<string,string>={})=>app.inject({method:'POST',url:'/connector.php',
    headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'dyna_api_'+n+'0'.repeat(63),...headers},payload:new URLSearchParams({method,parameters:JSON.stringify(parameters)}).toString()});
  return {app,calls,authenticated,request};
}
test('connector.php routes inventory methods with inventory scopes; only this family receives credential custody',async()=>{
  const h=await routes({1:['inventory:read','inventory:write'],2:['inventory:write'],3:['inventory:read']});
  const ok=await h.request('updateInventoryProductsStock',1,{inventory_id:3,products:{}},{'idempotency-key':uid(90)});
  assert.equal(ok.statusCode,200,ok.body);assert.deepEqual(ok.json(),{status:'SUCCESS',counter:0,warnings:{}});
  assert.deepEqual(h.calls.at(-1).options,{clientKey:uid(90),credential:'dyna_api_1'+'0'.repeat(63)});
  assert.deepEqual(h.calls.at(-1).actor,actor(1));
  // write-only key and read-only key are both refused for the write; read-only key may read.
  for(const n of [2,3]){const r=await h.request('updateInventoryProductsStock',n,{inventory_id:3,products:{}});assert.equal(r.statusCode,403);assert.equal(r.json().status,'ERROR');assert(!r.body.includes('dyna_api_'));}
  assert.equal((await h.request('getInventoryWarehouses',3,{})).statusCode,200);
  assert.equal((await h.request('getInventories',3,{})).statusCode,200);assert.equal((await h.request('getInventoryProductsList',3,{inventory_id:3})).statusCode,200);
  assert.equal((await h.request('getInventoryProductsList',2,{inventory_id:3})).statusCode,403);
  assert.deepEqual(h.authenticated,['inventory:write','inventory:write','inventory:write','inventory:read','inventory:read','inventory:read','inventory:read']);
  assert.equal((await h.request('getCrmClients',1,{page:1})).statusCode,403);
  const crm=await routes({1:['crm:read']});assert.equal((await crm.request('getCrmClients',1,{page:1})).statusCode,200);
  assert.deepEqual(crm.calls.at(-1).options,{clientKey:undefined});
  assert.deepEqual([...BASE_WIRE_INVENTORY_METHODS],['getInventoryWarehouses','getInventories','getInventoryProductsList','getInventoryProductsData','updateInventoryProductsStock','getInventoryCategories',
    'getInventoryPriceGroups','getInventoryProductsStock','getInventoryProductsPrices','updateInventoryProductsPrices','addInventoryProduct','deleteInventoryProduct']);
  await h.app.close();await crm.app.close();
});
test('unavailable inventory family refuses before authentication',async()=>{
  const app=Fastify();let authenticated=0;
  registerBaseWireRoutes(app,{readOnly:false,families:[createBaseWireInventoryFamily({available:false,service:{execute:async()=>assert.fail()}})],authenticate:async()=>{authenticated++;return assert.fail();}});
  const r=await app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'dyna_api_'+'1'.repeat(64)},payload:'method=getInventoryWarehouses&parameters=%7B%7D'});
  assert.equal(r.statusCode,503);assert.equal(authenticated,0);
  const ro=Fastify();registerBaseWireRoutes(ro,{readOnly:true,families:[createBaseWireInventoryFamily({available:true,service:{execute:async()=>assert.fail()}})],authenticate:async()=>assert.fail()});
  assert.equal((await ro.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded'},payload:'method=updateInventoryProductsStock&parameters=%7B%7D'})).statusCode,423);
  await app.close();await ro.close();
});
