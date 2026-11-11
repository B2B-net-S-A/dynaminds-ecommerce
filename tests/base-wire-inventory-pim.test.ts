/** Base inventory family PIM methods on CLOSED native ports (price groups,
 * prices, stock read, product create/update). The real SQL/native writers are
 * covered by base-wire-inventory-pim.database.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createBaseWireInventoryPimService, type BaseWireInventoryPimNative, type BaseWireInventoryProductWrite } from '../server/base-wire-inventory-pim';
import { createBaseWireInventoryFamily, BASE_WIRE_BASE_PRICE_GROUP_ID as BASE, type BaseWireInventoryProduct } from '../server/base-wire-inventory';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { baseWireRequiredScopes } from '../server/developer-api';
import { Problem, ensure } from '../server/errors';
import type { Actor } from '../server/domain';

const uid=(n:number)=>`73000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=(t:number,role:Actor['role']='admin'):Actor=>({tenantId:uid(t),userId:uid(10+t),role,apiKeyId:uid(20+t),source:'api'});
const opts={credential:'dyna_api_'+'a'.repeat(64)};
type Product=Omit<BaseWireInventoryProduct,'stock'|'parent_public_id'|'bundle'|'category_public_id'|'translations'>&{tenant:string;catalog:string;parent:string|null;price:number;version:number;components:{id:string;quantity:number}[]};
function fixture(o:{deletions?:boolean}={deletions:true}) {
  const s={
    warehouses:[{tenant:uid(1),id:uid(31),public_id:7,name:'Główny',code:'MAG'},{tenant:uid(1),id:uid(32),public_id:9,name:'Drugi',code:'M2'},{tenant:uid(2),id:uid(33),public_id:8,name:'Obcy',code:'X'}],
    catalogs:[{tenant:uid(1),id:uid(41),public_id:3,name:'Domyślny',is_default:true,languages:['pl'],default_language:'pl',warehouses:[uid(31)],groups:[11,12]},
      {tenant:uid(1),id:uid(42),public_id:4,name:'Drugi',is_default:false,languages:['pl'],default_language:'pl',warehouses:[uid(31),uid(32)],groups:[]},
      {tenant:uid(2),id:uid(43),public_id:5,name:'Obcy',is_default:true,languages:['pl'],default_language:'pl',warehouses:[uid(33)],groups:[]}],
    groups:[{tenant:uid(1),public_id:11,name:'Hurt',currency:'PLN',active:true,fallback:true,adjustment_bps:-1000,adjustment_amount:50},
      {tenant:uid(1),public_id:12,name:'EUR',currency:'EUR',active:true,fallback:false,adjustment_bps:0,adjustment_amount:0},
      {tenant:uid(1),public_id:13,name:'Nieprzypisany',currency:'PLN',active:false,fallback:true,adjustment_bps:500,adjustment_amount:0},
      {tenant:uid(2),public_id:14,name:'Obcy',currency:'PLN',active:true,fallback:false,adjustment_bps:0,adjustment_amount:0}],
    items:[{tenant:uid(1),group:12,product:uid(51),price:450}] as {tenant:string;group:number;product:string;price:number}[],
    products:[
      {tenant:uid(1),catalog:uid(41),id:uid(51),public_id:101,kind:'simple',parent:null,sku:'A-1',ean:null,vat:23,tags:['nowy'],name:'Kubek',description:'Opis',images:['https://x/1.jpg'],price:1999,version:1,components:[]},
      {tenant:uid(1),catalog:uid(41),id:uid(52),public_id:102,kind:'group',parent:null,sku:'G-1',ean:null,vat:8,tags:[],name:'Koszulka',description:'',images:[],price:0,version:1,components:[]},
      {tenant:uid(1),catalog:uid(41),id:uid(53),public_id:103,kind:'variant',parent:uid(52),sku:'G-1-M',ean:'591',vat:8,tags:[],name:'Koszulka M',description:'',images:[],price:3000,version:1,components:[]},
      {tenant:uid(1),catalog:uid(42),id:uid(55),public_id:105,kind:'simple',parent:null,sku:'C-1',ean:null,vat:23,tags:[],name:'Inny katalog',description:'',images:[],price:100,version:1,components:[]},
      {tenant:uid(2),catalog:uid(43),id:uid(56),public_id:106,kind:'simple',parent:null,sku:'F-1',ean:null,vat:23,tags:[],name:'Obca firma',description:'',images:[],price:100,version:1,components:[]},
    ] as Product[],
    stock:[
      {tenant:uid(1),product:uid(51),warehouse:uid(31),on_hand:10,reserved:2,location:'A-01'},
      {tenant:uid(1),product:uid(53),warehouse:uid(31),on_hand:4,reserved:1,location:'B-02'},
    ],
    idempotency:[] as {tenant:string;key:string;hash:string;response:any}[],saves:[] as {id:string|null;write:BaseWireInventoryProductWrite}[],listWrites:[] as {group:number;items:any[]}[],next:200,deleted:[] as string[],
  };
  let state=structuredClone(s);
  const publicOf=(tenant:string,id:string)=>state.products.find(p=>p.tenant===tenant&&p.id===id)!.public_id;
  const dto=(p:Product):BaseWireInventoryProduct=>({id:p.id,public_id:p.public_id,kind:p.kind,parent_public_id:p.parent?publicOf(p.tenant,p.parent):null,sku:p.sku,ean:p.ean,vat:p.vat,tags:p.tags,name:p.name,description:p.description,images:p.images,
    stock:state.stock.filter(x=>x.tenant===p.tenant&&x.product===p.id).map(x=>({warehouse_public_id:state.warehouses.find(w=>w.id===x.warehouse)!.public_id,on_hand:x.on_hand,reserved:x.reserved,location:x.location})),
    bundle:p.components.map(c=>({public_id:publicOf(p.tenant,c.id),quantity:c.quantity})),category_public_id:null,translations:[]});
  const native=(_c:unknown,a:Actor):BaseWireInventoryPimNative=>{
    const t=a.tenantId;
    const own=()=>state.products.filter(p=>p.tenant===t&&!state.deleted.includes(p.id));
    return {
      warehouses:async()=>state.warehouses.filter(w=>w.tenant===t).map(({tenant:_t,...w})=>w),
      stockEditable:async()=>true,
      catalogs:async()=>state.catalogs.filter(c=>c.tenant===t).map(c=>({public_id:c.public_id,name:c.name,is_default:c.is_default,languages:c.languages,default_language:c.default_language,
        warehouse_public_ids:c.warehouses.map(w=>state.warehouses.find(x=>x.id===w)!.public_id).sort((x,y)=>x-y),price_group_public_ids:[...c.groups]})),
      allocateCategories:async()=>assert.fail('PIM methods never allocate categories'),
      categories:async()=>assert.fail('PIM methods never read categories'),
      productList:async(catalog,q)=>{
        assert.equal(q.category,null);
        const total=(p:Product)=>state.stock.filter(x=>x.tenant===t&&x.product===p.id).reduce((n,x)=>n+x.on_hand,0);
        return own().filter(p=>p.catalog===catalog&&(q.id===null||p.public_id===q.id)&&(q.sku===null||p.sku===q.sku)&&(q.include_variants||p.kind!=='variant')&&(q.stock_from===null||total(p)>=q.stock_from))
          .sort((x,y)=>q.descending?y.public_id-x.public_id:x.public_id-y.public_id).slice((q.page-1)*q.page_size,q.page*q.page_size)
          .map(p=>({public_id:p.public_id,parent_public_id:null,sku:p.sku,ean:p.ean,name:p.name,stock:[]}));
      },
      catalog:async n=>state.catalogs.find(c=>c.tenant===t&&c.public_id===n)?.id??null,
      products:async(catalog,ids)=>own().filter(p=>p.catalog===catalog&&ids.includes(p.public_id)).sort((x,y)=>x.public_id-y.public_id).map(dto),
      variants:async(catalog,parents)=>own().filter(p=>p.catalog===catalog&&p.kind==='variant'&&parents.includes(p.parent!)).map(dto),
      replay:async(key,hash)=>{let row=state.idempotency.find(x=>x.tenant===t&&x.key===key);if(!row)state.idempotency.push(row={tenant:t,key,hash,response:null});
        ensure(row.hash===hash,409,'Klucz polecenia wskazuje inną treść');return structuredClone(row.response);},
      remember:async(key,response)=>{state.idempotency.find(x=>x.tenant===t&&x.key===key)!.response=structuredClone(response);},
      writableCatalog:async()=>assert.fail(),lockStock:async()=>assert.fail(),enlist:async()=>assert.fail(),adjust:async()=>assert.fail(),
      currency:async()=>'PLN',
      priceGroups:async()=>state.groups.filter(g=>g.tenant===t).map(({tenant:_t,...g})=>g),
      prices:async ids=>own().filter(p=>ids.includes(p.id)).map(p=>({product_id:p.id,price:p.price,overrides:state.items.filter(i=>i.tenant===t&&i.product===p.id).map(i=>({group_public_id:i.group,price:i.price}))})),
      writePrices:async(group,items)=>{
        ensure(state.groups.some(g=>g.tenant===t&&g.public_id===group),404,'cennik');
        for(const i of items){ensure(own().find(p=>p.id===i.product_id)?.kind!=='group',422,'Grupa');
          const row=state.items.find(x=>x.tenant===t&&x.group===group&&x.product===i.product_id);if(row)row.price=i.price;else state.items.push({tenant:t,group,product:i.product_id,price:i.price});}
        state.listWrites.push({group,items});
      },
      saveProduct:async(catalog,id,w)=>{
        state.saves.push({id,write:structuredClone(w)});
        if(id===null){
          // Native productSchema/createProduct rules that matter here.
          ensure(typeof w.name==='string'&&w.name.length>=2&&typeof w.sku==='string'&&w.price!==undefined,422,'productSchema');
          ensure(w.kind!=='variant'||own().find(p=>p.id===w.parent_id)?.kind==='group',422,'Rodzicem wariantu musi być grupa');
          ensure(w.kind==='bundle'?!!w.components?.length:!w.components?.length,422,'Składniki');
          const local=uid(state.next),public_id=state.next++;
          state.products.push({tenant:t,catalog,id:local,public_id,kind:w.kind??'simple',parent:w.parent_id??null,sku:w.sku,ean:w.ean??'',vat:w.vat??23,tags:w.tags??[],name:w.name,description:w.description??'',images:w.images??[],price:w.price,version:1,
            components:(w.components??[]).map(c=>({id:c.product_id,quantity:c.quantity}))});
          if(w.kind!=='bundle')state.stock.push({tenant:t,product:local,warehouse:w.warehouse_id!,on_hand:w.quantity??0,reserved:0,location:'A-01'});
          return local;
        }
        const p=own().find(x=>x.id===id&&x.catalog===catalog)!;
        Object.assign(p,{...(w.name===undefined?{}:{name:w.name}),...(w.sku===undefined?{}:{sku:w.sku}),...(w.ean===undefined?{}:{ean:w.ean}),...(w.tags===undefined?{}:{tags:w.tags}),
          ...(w.vat===undefined?{}:{vat:w.vat}),...(w.description===undefined?{}:{description:w.description}),...(w.price===undefined?{}:{price:w.price}),...(w.images===undefined?{}:{images:w.images}),
          ...(w.components===undefined?{}:{components:w.components.map(c=>({id:c.product_id,quantity:c.quantity}))}),version:p.version+1});
        return id;
      },
      productPublicId:async local=>own().find(p=>p.id===local)!.public_id,
      // Native refusals are covered by product-deletions225.database.test.ts.
      deleteProduct:async n=>{const p=own().find(x=>x.public_id===n);if(!p)return false;ensure(!state.stock.some(x=>x.product===p.id&&x.on_hand>0),409,'Produkt ma stan magazynowy');state.deleted.push(p.id);return true;},
    };
  };
  let loseAck=false;
  const service=createBaseWireInventoryPimService({native:native as any,deletions:o.deletions,transaction:async(_a,_w,work)=>{
    const before=structuredClone(state);
    try{const r=await work({} as any);if(loseAck){loseAck=false;throw new Problem(500,'lost ack');}return r;}catch(e){if(!(e instanceof Problem&&e.message==='lost ack'))state=before;throw e;}
  }});
  return {service,get state(){return state;},loseAck:()=>{loseAck=true;}};
}
const product=(f:ReturnType<typeof fixture>,n:number)=>f.state.products.find(p=>p.public_id===n)!;

test('getInventoryPriceGroups maps native price lists exactly and adds the derived base group',async()=>{
  const f=fixture();
  const r:any=await f.service.execute(actor(1),'getInventoryPriceGroups',{});
  assert.deepEqual(r.price_groups.map((g:any)=>g.price_group_id),[11,12,13,BASE]);
  assert.deepEqual(r.price_groups[0],{price_group_id:11,name:'Hurt',description:'',currency:'PLN',is_default:false,price_group_type:'dependent_on_price_group',source_price_group_id:BASE,
    price_multiplier:0.9,price_addition:0.5,is_bundle_price_calculated:false,bundle_price_multiplier:1,bundle_price_addition:0});
  assert.equal(r.price_groups[1].price_group_type,'standard');assert.equal(r.price_groups[1].currency,'EUR');assert.equal(r.price_groups[1].source_price_group_id,0);
  assert.deepEqual(r.price_groups[3],{price_group_id:BASE,name:'Cena podstawowa',description:'',currency:'PLN',is_default:true,price_group_type:'standard',source_price_group_id:0,
    price_multiplier:1,price_addition:0,is_bundle_price_calculated:false,bundle_price_multiplier:1,bundle_price_addition:0});
  assert.deepEqual(((await f.service.execute(actor(2),'getInventoryPriceGroups',{})) as any).price_groups.map((g:any)=>g.price_group_id),[14,BASE]);
  await assert.rejects(f.service.execute(actor(1),'getInventoryPriceGroups',{inventory_id:3}),(e:any)=>e.name==='ZodError');
});
test('getInventoryProductsPrices returns native gross prices per assigned group; variants in their own map',async()=>{
  const f=fixture();
  const r:any=await f.service.execute(actor(1),'getInventoryProductsPrices',{inventory_id:3});
  assert.deepEqual(Object.keys(r.products),['101','102']);
  // 11: rule 1999*0.9=1799.1 -> 1799 + 50 = 18.49; 12: stored SKU price 4.50 EUR; 13 is not assigned to catalog 3.
  assert.deepEqual(r.products['101'],{product_id:101,prices:{'11':18.49,'12':4.5,[BASE]:19.99},variants:{}});
  // Group has no sale price; variant 103 has only the rule price (no SKU price in 12, which has no fallback).
  assert.deepEqual(r.products['102'],{product_id:102,prices:{},variants:{'103':{'11':27.5,[BASE]:30}}});
  // An inactive fallback list gives no rule price (native quote refuses it), SKU prices remain.
  f.state.groups[0].active=false;f.state.items.push({tenant:uid(1),group:11,product:uid(53),price:2500});
  assert.deepEqual(((await f.service.execute(actor(1),'getInventoryProductsPrices',{inventory_id:3})) as any).products['102'].variants['103'],{'11':25,[BASE]:30});
  assert.deepEqual(((await f.service.execute(actor(1),'getInventoryProductsPrices',{inventory_id:3,page:2})) as any).products,{});
  await assert.rejects(f.service.execute(actor(2),'getInventoryProductsPrices',{inventory_id:3}),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsPrices',{inventory_id:3,page:0}),(e:any)=>e.name==='ZodError');
});
test('getInventoryProductsStock returns stock and reservations with variant maps; unsupported filters refused',async()=>{
  const f=fixture();
  const r:any=await f.service.execute(actor(1),'getInventoryProductsStock',{inventory_id:3});
  assert.deepEqual(r.products,{
    '101':{product_id:101,stock:{bl_7:10},reservations:{bl_7:2},variants:{}},
    '102':{product_id:102,stock:{},reservations:{},variants:{'103':{bl_7:4}},variant_reservations:{'103':{bl_7:1}}}});
  f.state.stock[1].reserved=0;
  assert.deepEqual(((await f.service.execute(actor(1),'getInventoryProductsStock',{inventory_id:3})) as any).products['102'].variant_reservations,{});
  assert.deepEqual(Object.keys(((await f.service.execute(actor(1),'getInventoryProductsStock',{inventory_id:3,filter_sku:'A-1',filter_category_id:'',filter_asin:null})) as any).products),['101']);
  for(const filter of ['filter_category_id','filter_asin','filter_locations'])
    await assert.rejects(f.service.execute(actor(1),'getInventoryProductsStock',{inventory_id:3,[filter]:filter==='filter_category_id'?1:'X'}),(e:any)=>e.status===422&&e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FILTER');
  await assert.rejects(f.service.execute(actor(1),'getInventoryProductsStock',{inventory_id:3,include_variants:true}),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(2),'getInventoryProductsStock',{inventory_id:3}),(e:any)=>e.status===404);
});
test('updateInventoryProductsPrices writes SKU prices and the base price per product with Base counter/warnings',async()=>{
  const f=fixture();
  const r=await f.service.execute(actor(1),'updateInventoryProductsPrices',{inventory_id:3,products:{
    '101':{'12':5.25,[BASE]:21},'103':{'11':27.5},'102':{'11':1},'105':{'11':1},'106':{'11':1},'999':{'11':1},'1':{'13':1}}},opts);
  assert.deepEqual(r,{counter:2,warnings:{'1':'Nie znaleziono produktu w katalogu','102':'Grupa wariantów nie ma ceny sprzedaży','105':'Nie znaleziono produktu w katalogu',
    '106':'Nie znaleziono produktu w katalogu','999':'Nie znaleziono produktu w katalogu'}});
  assert.equal(product(f,101).price,2100);assert.deepEqual(f.state.saves,[{id:uid(51),write:{price:2100}}]);
  assert.deepEqual(f.state.listWrites,[{group:11,items:[{product_id:uid(53),price:2750}]},{group:12,items:[{product_id:uid(51),price:525}]}]);
  // Unchanged prices cause no native write; an unassigned group refuses that product only.
  f.state.saves=[];f.state.listWrites=[];
  assert.deepEqual(await f.service.execute(actor(1),'updateInventoryProductsPrices',{inventory_id:3,products:{'101':{'12':5.25,[BASE]:21},'103':{'13':1}}},opts),
    {counter:1,warnings:{'103':'Nie znaleziono grupy cenowej katalogu'}});
  assert.deepEqual(f.state.saves,[]);assert.deepEqual(f.state.listWrites,[]);
});
test('updateInventoryProductsPrices refuses inexact prices, read-only roles and replays a lost ACK',async()=>{
  const f=fixture();
  for(const price of [1.234,-1,1000000.01,'5'])
    await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsPrices',{inventory_id:3,products:{'101':{'12':price as any}}},opts),(e:any)=>e.name==='ZodError',String(price));
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsPrices',{inventory_id:3,products:Object.fromEntries(Array.from({length:1001},(_,n)=>[String(n+1),{'12':1}]))},opts),(e:any)=>e.name==='ZodError');
  await assert.rejects(f.service.execute(actor(1,'viewer'),'updateInventoryProductsPrices',{inventory_id:3,products:{'101':{'12':1}}},opts),(e:any)=>e.status===403);
  await assert.rejects(f.service.execute(actor(1,'operator'),'updateInventoryProductsPrices',{inventory_id:3,products:{'101':{[BASE]:1}}},opts),(e:any)=>e.status===403);
  assert.equal(((await f.service.execute(actor(1,'operator'),'updateInventoryProductsPrices',{inventory_id:3,products:{'101':{'12':1}}},opts)) as any).counter,1);
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsPrices',{inventory_id:3,products:{'101':{'12':1}}},{}),(e:any)=>e.status===503);
  const clientKey=uid(90),parameters={inventory_id:3,products:{'101':{[BASE]:30}}};
  f.loseAck();
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsPrices',parameters,{...opts,clientKey}),(e:any)=>e.status===500);
  product(f,101).price=4000; // operator change after the lost ACK
  assert.deepEqual(await f.service.execute(actor(1),'updateInventoryProductsPrices',parameters,{...opts,clientKey}),{counter:1,warnings:{}});
  assert.equal(product(f,101).price,4000);
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsPrices',{inventory_id:3,products:{'101':{[BASE]:31}}},{...opts,clientKey}),(e:any)=>e.status===409);
});
test('addInventoryProduct creates a native product with base and group prices and returns its numeric ID',async()=>{
  const f=fixture();
  const r:any=await f.service.execute(actor(1),'addInventoryProduct',{inventory_id:3,product_id:'',parent_id:0,is_bundle:false,sku:'N-1',ean:'5901',tags:['b','a'],tax_rate:8,
    text_fields:{name:'Nowy',description:'Opis nowy'},prices:{[BASE]:12.34,'11':10},stock:{bl_7:5},images:{'0':'url:https://x/n.jpg'},
    asin:'',weight:0,category_id:0,manufacturer_id:null,suppliers:[],relations:[],thresholds:{}},opts);
  assert.deepEqual(r,{product_id:200,warnings:{}});
  assert.deepEqual(f.state.saves[0],{id:null,write:{kind:'simple',name:'Nowy',description:'Opis nowy',sku:'N-1',ean:'5901',tags:['b','a'],vat:8,warehouse_id:uid(31),quantity:5,images:['https://x/n.jpg'],price:1234}});
  assert.deepEqual(f.state.listWrites,[{group:11,items:[{product_id:uid(200),price:1000}]}]);
  // Variant under a native group; catalogue with one warehouse needs no stock key; name|<default language>.
  assert.deepEqual(await f.service.execute(actor(1),'addInventoryProduct',{inventory_id:3,parent_id:102,sku:'G-1-L',text_fields:{'name|pl':'Koszulka L'},prices:{[BASE]:30}},opts),{product_id:201,warnings:{}});
  assert.equal(product(f,201).parent,uid(52));assert.equal(product(f,201).kind,'variant');
  assert.deepEqual(await f.service.execute(actor(1),'addInventoryProduct',{inventory_id:3,is_bundle:true,sku:'B-2',text_fields:{name:'Zestaw'},prices:{[BASE]:40},bundle_products:{'101':2}},opts),{product_id:202,warnings:{}});
  assert.deepEqual(product(f,202).components,[{id:uid(51),quantity:2}]);
});
test('addInventoryProduct without stock in a catalogue with 2 warehouses: zero stock in the lowest Base warehouse ID',async()=>{
  const f=fixture(),create=(p:Record<string,unknown>)=>f.service.execute(actor(1),'addInventoryProduct',{inventory_id:4,text_fields:{name:'Dwa magazyny'},prices:{[BASE]:1},...p} as any,opts);
  // Catalogue 4 has bl_7 and bl_9: no stock (absent, null or {}) → bl_7 (lowest ID), quantity 0.
  for(const [n,stock] of [[1,undefined],[2,null],[3,{}]] as const){
    const r:any=await create({sku:'W-'+n,...(stock===undefined?{}:{stock})});
    assert.deepEqual(r,{product_id:199+n,warnings:{}});
    assert.deepEqual([f.state.saves.at(-1)!.write.warehouse_id,f.state.saves.at(-1)!.write.quantity],[uid(31),0]);
  }
  // An explicit single warehouse is still honoured.
  await create({sku:'W-4',stock:{bl_9:3}});
  assert.deepEqual([f.state.saves.at(-1)!.write.warehouse_id,f.state.saves.at(-1)!.write.quantity],[uid(32),3]);
});
test('addInventoryProduct refuses what the native model cannot represent, before any effect',async()=>{
  const f=fixture(),create=(p:Record<string,unknown>,a=actor(1))=>f.service.execute(a,'addInventoryProduct',{inventory_id:3,sku:'R-1',text_fields:{name:'Odmowa'},prices:{[BASE]:1},...p} as any,opts);
  for(const field of ['asin','weight','category_id','manufacturer_id','star','average_cost','locations','videos','links','suppliers','relations','shipping_template','ean_additional','thresholds','media_options'])
    await assert.rejects(create({[field]:field==='weight'||field==='star'||field==='average_cost'||field==='category_id'||field==='manufacturer_id'?2:field==='asin'?'X':['x']}),(e:any)=>e.status===422&&e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD',field);
  await assert.rejects(create({text_fields:{name:'X',features:'a'}}),(e:any)=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  // A native translation needs provenance (AI/DeepL draft or bulk-edit receipt): never written from Base.
  await assert.rejects(create({text_fields:{'name|en':'X'}}),(e:any)=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD'&&/natywna edycja tłumaczeń/.test(e.message));
  await assert.rejects(create({images:{'0':'data:image/png;base64,AAAA'}}),(e:any)=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await assert.rejects(create({images:{'1':'url:https://x/1.jpg'}}),(e:any)=>e.status===422);
  await assert.rejects(create({prices:{'11':1}}),(e:any)=>e.status===422&&/podstawowej/.test(e.message));
  await assert.rejects(create({prices:{[BASE]:1,'13':1}}),(e:any)=>e.status===422);
  await assert.rejects(create({tax_rate:-1}),(e:any)=>e.status===422);await assert.rejects(create({tax_rate:7}),(e:any)=>e.status===422);
  await assert.rejects(create({stock:{bl_9:1}}),(e:any)=>e.status===422&&e.message==='Magazyn nie jest przypisany do katalogu');
  await assert.rejects(create({stock:{bl_7:1,bl_9:1}}),(e:any)=>e.status===422&&e.message==='Podaj stan najwyżej w jednym magazynie katalogu');
  await assert.rejects(create({parent_id:101}),(e:any)=>e.status===422); // native: parent must be a group
  await assert.rejects(create({parent_id:105}),(e:any)=>e.status===422); // other catalogue
  await assert.rejects(create({parent_id:102,is_bundle:true}),(e:any)=>e.status===422);
  await assert.rejects(create({bundle_products:{'101':1}}),(e:any)=>e.status===422);
  await assert.rejects(create({is_bundle:true,bundle_products:{'105':1}}),(e:any)=>e.status===422);
  await assert.rejects(create({prices:{[BASE]:1.001}}),(e:any)=>e.name==='ZodError');
  await assert.rejects(create({extra:1}),(e:any)=>e.name==='ZodError');
  await assert.rejects(create({},actor(1,'operator')),(e:any)=>e.status===403);
  await assert.rejects(create({},actor(2)),(e:any)=>e.status===404);
  assert.equal(f.state.products.length,5);assert.deepEqual(f.state.listWrites,[]);
});
test('addInventoryProduct with product_id changes only the given fields; kind, parent and stock stay native',async()=>{
  const f=fixture(),before=structuredClone(product(f,101));
  assert.deepEqual(await f.service.execute(actor(1),'addInventoryProduct',{inventory_id:3,product_id:101,text_fields:{name:'Kubek duży'},images:{'1':'url:https://x/2.jpg'}},opts),{product_id:101,warnings:{}});
  assert.deepEqual(f.state.saves,[{id:uid(51),write:{name:'Kubek duży',images:['https://x/1.jpg','https://x/2.jpg']}}]);
  assert.deepEqual({...product(f,101),name:before.name,images:before.images,version:before.version},before);
  await f.service.execute(actor(1),'addInventoryProduct',{inventory_id:3,product_id:101,prices:{'12':6},tags:[]},opts);
  assert.deepEqual(product(f,101).tags,[]);assert.equal(product(f,101).price,1999);assert.equal(f.state.items.find(i=>i.product===uid(51))!.price,600);
  // Nothing given: no native write at all.
  f.state.saves=[];await f.service.execute(actor(1),'addInventoryProduct',{inventory_id:3,product_id:101,stock:{}},opts);assert.deepEqual(f.state.saves,[]);
  const update=(p:Record<string,unknown>)=>f.service.execute(actor(1),'addInventoryProduct',{inventory_id:3,product_id:101,...p} as any,opts);
  await assert.rejects(update({stock:{bl_7:1}}),(e:any)=>e.code==='LOCAL_BASE_WIRE_UNSUPPORTED_FIELD');
  await assert.rejects(update({parent_id:102}),(e:any)=>e.status===422);await assert.rejects(update({is_bundle:true}),(e:any)=>e.status===422);
  assert.ok(await update({parent_id:0,is_bundle:false}));
  await assert.rejects(update({images:{'3':'url:https://x/4.jpg'}}),(e:any)=>e.status===422);
  await assert.rejects(f.service.execute(actor(1),'addInventoryProduct',{inventory_id:3,product_id:105,sku:'X'},opts),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1),'addInventoryProduct',{inventory_id:3,product_id:102,prices:{[BASE]:1}},opts),(e:any)=>e.status===422);
});
test('addInventoryProduct Idempotency-Key replays the created ID after a lost ACK without a second product',async()=>{
  const f=fixture(),clientKey=uid(91),parameters={inventory_id:3,sku:'I-1',text_fields:{name:'Idempotentny'},prices:{[BASE]:1}};
  f.loseAck();
  await assert.rejects(f.service.execute(actor(1),'addInventoryProduct',parameters,{...opts,clientKey}),(e:any)=>e.status===500);
  assert.deepEqual(await f.service.execute(actor(1),'addInventoryProduct',parameters,{...opts,clientKey}),{product_id:200,warnings:{}});
  assert.equal(f.state.products.filter(p=>p.sku==='I-1').length,1);
  await assert.rejects(f.service.execute(actor(1),'addInventoryProduct',{...parameters,sku:'I-2'},{...opts,clientKey}),(e:any)=>e.status===409);
  // A key is never shared across methods.
  await assert.rejects(f.service.execute(actor(1),'updateInventoryProductsPrices',{inventory_id:3,products:{}},{...opts,clientKey}),(e:any)=>e.status===409);
});
test('connector.php: PIM writes need products:read+write, reads inventory:read; read-only keys are refused',async()=>{
  assert.deepEqual(baseWireRequiredScopes('products:write'),['products:read','products:write']);
  const scopes:Record<number,string[]>={1:['inventory:read','products:read','products:write'],2:['products:write'],3:['inventory:read','products:read']};
  const app=Fastify(),calls:string[]=[];
  registerBaseWireRoutes(app,{readOnly:false,families:[createBaseWireInventoryFamily({available:true,service:{execute:async(_a,method)=>{calls.push(method);return {};}}})],authenticate:async(token,scope)=>{
    const n=Number(/^dyna_api_([1-9])0+$/.exec(token)![1]);
    ensure(baseWireRequiredScopes(scope).every(s=>scopes[n].includes(s)),403,'Klucz API nie ma wymaganego zakresu');
    return {id:uid(10+n),tenant_id:uid(n),role:'admin',api_key_id:uid(20+n),scopes:scopes[n]};
  }});
  const request=(method:string,n:number)=>app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':'dyna_api_'+n+'0'.repeat(63)},
    payload:new URLSearchParams({method,parameters:'{}'}).toString()});
  for(const m of ['addInventoryProduct','updateInventoryProductsPrices']){assert.equal((await request(m,1)).statusCode,200);assert.equal((await request(m,2)).statusCode,403);assert.equal((await request(m,3)).statusCode,403);}
  for(const m of ['getInventoryPriceGroups','getInventoryProductsPrices','getInventoryProductsStock']){assert.equal((await request(m,3)).statusCode,200);assert.equal((await request(m,2)).statusCode,403);}
  for(const m of ['deleteInventoryProduct']){assert.equal((await request(m,1)).statusCode,200);assert.equal((await request(m,2)).statusCode,403);assert.equal((await request(m,3)).statusCode,403);}
  for(const m of ['addInventoryCategory','deleteInventoryCategory'])assert.equal((await request(m,1)).statusCode,400,m);
  assert.deepEqual(calls,['addInventoryProduct','updateInventoryProductsPrices','getInventoryPriceGroups','getInventoryProductsPrices','getInventoryProductsStock','deleteInventoryProduct']);
  await app.close();
});

test('deleteInventoryProduct: native 225 deleted state, admin, own tenant, replay by Idempotency-Key',async()=>{
  const f=fixture(),clientKey='6f0e1c2a-1111-4aaa-8bbb-000000000225';
  // Refused natively (stock on hand), nothing changes.
  await assert.rejects(f.service.execute(actor(1),'deleteInventoryProduct',{product_id:101},opts),(e:any)=>e.status===409);
  assert.deepEqual(f.state.deleted,[]);
  await assert.rejects(f.service.execute(actor(1,'operator'),'deleteInventoryProduct',{product_id:105},opts),(e:any)=>e.status===403);
  await assert.rejects(f.service.execute(actor(1),'deleteInventoryProduct',{product_id:105}),(e:any)=>e.status===503);
  await assert.rejects(f.service.execute(actor(1),'deleteInventoryProduct',{product_id:105,inventory_id:4},opts),(e:any)=>e.status===400||e.name==='ZodError');
  // Foreign tenant's product is absent.
  await assert.rejects(f.service.execute(actor(1),'deleteInventoryProduct',{product_id:106},opts),(e:any)=>e.status===404);
  assert.deepEqual(await f.service.execute(actor(1),'deleteInventoryProduct',{product_id:105},{...opts,clientKey}),{});
  assert.deepEqual(f.state.deleted,[uid(55)]);
  // Same key + same body = stored response; a fresh call finds nothing; key reuse with another body is refused.
  assert.deepEqual(await f.service.execute(actor(1),'deleteInventoryProduct',{product_id:105},{...opts,clientKey}),{});
  await assert.rejects(f.service.execute(actor(1),'deleteInventoryProduct',{product_id:105},opts),(e:any)=>e.status===404);
  await assert.rejects(f.service.execute(actor(1),'deleteInventoryProduct',{product_id:103},{...opts,clientKey}),(e:any)=>e.status===409);
  assert.deepEqual(f.state.deleted,[uid(55)]);
  // Deleted products are absent from the PIM reads.
  const prices:any=await f.service.execute(actor(1),'getInventoryProductsPrices',{inventory_id:4});
  assert.deepEqual(Object.keys(prices.products),[]);
  const g=fixture({});
  await assert.rejects(g.service.execute(actor(1),'deleteInventoryProduct',{product_id:105},opts),(e:any)=>e.status===503);
});
