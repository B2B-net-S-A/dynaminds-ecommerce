// SOURCE_AUTHORED_NOT_RUN. Root alone executes this disposable real PG/buildApp suite.
// readOnly buildApp is an HTTP policy fixture, not evidence of an archive restore.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { publicApiDocument } from '../server/developer-api';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import { stocktakeAdjustmentFixture } from './stocktake-adjustments-fixture';
import { bootstrap151169, install152169, facts169, own169, consent169, type Row } from './catalog-stock-control169-fixture';
import { seed } from './fixtures';

const path='/catalog-stock-control/count-documents';
let primary:Awaited<ReturnType<typeof buildApp>>,copy:Awaited<ReturnType<typeof buildApp>>,providers=0;
const transport=async()=>{providers++;throw Error('COUNT restored reads forbid provider transport');};
const one=(xs:Row[])=>{assert.equal(xs.length,1);return xs[0];};
async function born(on:boolean) {
  const f=await stocktakeAdjustmentFixture(primary,on);
  const catalog=one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1',[f.tenant])).rows).catalog_id as string;
  const ctx={writersAvailable:true}; // Genuine internal BO consent; public activation remains false.
  const {source}=await sourceCatalogStockControl(f.actor,catalog,ctx);assert.equal(source.ready,true);
  const {preview}=await previewCatalogStockControl(f.actor,catalog,{client_key:randomUUID(),catalog_version:source.snapshot.catalog.version,
    policy_version:source.snapshot.policy.version,
    warehouse_policy_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.series.version}))},ctx);
  assert.equal((await commitCatalogStockControl(f.actor,preview.id,consent169(preview),ctx)).operation.after.strict,true);
  const facts=await facts169();let result:Row;
  if(!on) {
    const products=own169(facts,'products',f.tenant),stocks=own169(facts,'stock',f.tenant);
    const rows=f.products.flatMap(p=>['A-01','B-02'].map(location=>({product_id:p.id,
      product_version:one(products.filter(x=>x.id===p.id)).version,
      stock_version:String(one(stocks.filter(x=>x.product_id===p.id&&x.warehouse_id===f.warehouse.id)).version),
      location,operation:'count',quantity:location==='A-01'?1:3})));
    const p=(await f.ok('/inventory-bulk-edit/previews','POST',{client_key:randomUUID(),warehouse_id:f.warehouse.id,note:'Real restored quantity source',rows},201)).preview;
    assert.equal(p.ready,true);result=await f.ok('/inventory-bulk-edit/previews/'+p.id+'/execute','POST',consent169(p),201);
  } else {
    const positions=own169(facts,'wms_layer_positions',f.tenant),layers=own169(facts,'wms_cost_layers',f.tenant);
    const lot=(id:string,location:string)=>one(layers.filter(l=>l.id===one(positions.filter(x=>x.product_id===id&&x.location===location)).layer_id)).lot_id;
    const content='SKU;Q;LOT;LOC;COST;CUR\n'+f.products.flatMap(p=>[
      `${p.sku};1;${lot(p.id,'A-01')};A-01;;`,`${p.sku};3;${lot(p.id,'B-02')};B-02;${p.cost??'1000'};PLN`]).join('\n');
    const p=(await f.ok('/stock-file-imports/previews','POST',{client_key:randomUUID(),file_name:'restored-count-value.csv',note:'Real saved0/NULL layers',content,
      definition:{format:'csv',xml_mode:'positions',delimiter:';',identity:'sku',identity_field:'SKU',spreadsheet_safe:false,empty_policy:'skip'},
      targets:[{warehouse_id:f.warehouse.id,quantity_scope:'position',default_location:'A-01',mapping:{quantity:'Q',location:'LOC',lot_id:'LOT',unit_cost_minor:'COST',currency:'CUR'}}],resolutions:[]},201)).preview;
    assert.equal(p.summary.invalid,0);assert.equal(p.summary.conflicts,0);
    result=await f.ok('/stock-file-imports/previews/'+p.id+'/execute','POST',{...consent169(p),ack_unknown_loss_warehouse_ids:[f.warehouse.id],ack_surplus_warehouse_ids:[f.warehouse.id]},201);
  }
  const docs=result.execution.stock_count_documents as Row[];assert.equal(docs.length,2);
  const full=await f.ok('/developer/keys','POST',{name:'Restored COUNT value reader',scopes:['products:read','inventory:read','purchasing:read']},201);
  const quantity=await f.ok('/developer/keys','POST',{name:'Restored COUNT quantity reader',scopes:['products:read','inventory:read']},201);
  const incomplete=await f.ok('/developer/keys','POST',{name:'Restored COUNT no inventory',scopes:['products:read','purchasing:read']},201);
  return{...f,docs,full,quantity,incomplete,rw:one(docs.filter(d=>d.kind==='RW'))};
}
type Born=Awaited<ReturnType<typeof born>>;
type Fixture=Born&{copyCookie:string;remoteAddress:string};
let fixtures:Fixture[]=[];
before(async()=>{
  await bootstrap151169();await seed();await install152169();primary=await buildApp({integrationTransport:transport});
  const sources=[await born(false),await born(true)];copy=await buildApp({readOnly:true,previewPort:4198,integrationTransport:transport});
  for(const [i,f]of sources.entries()) {
    const remoteAddress='127.169.42.'+(i+1);
    const untouched=await facts169();assert.equal((await copy.inject({url:'/api'+path+'/'+f.rw.id+'/value',headers:{cookie:f.cookie},remoteAddress})).statusCode,401);
    assert.deepEqual(await facts169(),untouched,'Primary cookies cannot become copy sessions');
    const login=await copy.inject({method:'POST',url:'/api/auth/login',payload:{email:'admin@demo.local',password:'DynaDemo!2026'},remoteAddress});assert.equal(login.statusCode,200);
    const switched=await copy.inject({method:'POST',url:'/api/workspaces/switch',payload:{tenant_id:f.tenant},headers:{cookie:String(login.headers['set-cookie']).split(';')[0]},remoteAddress});assert.equal(switched.statusCode,200);
    fixtures.push({...f,copyCookie:String(switched.headers['set-cookie']).split(';')[0],remoteAddress});
  }
});
after(async()=>{try{await copy?.close();await primary?.close();assert.equal(providers,0);}finally{await pool.end();}});
async function get(f:Fixture,suffix:string,namespace:'/api'|'/api/v1'='/api',key?:Row,status=200) {
  const res=await copy.inject({url:namespace+path+'/'+f.rw.id+suffix,remoteAddress:f.remoteAddress,
    headers:key?{authorization:'Bearer '+key.token}:{cookie:f.copyCookie}});
  assert.equal(res.statusCode,status,namespace+suffix);assert.equal(res.headers['cache-control'],'no-store');assert.equal(res.headers['set-cookie'],undefined);
  return res.json() as Row;
}
function safe(v:unknown,hideValues=false) {
  if(Array.isArray(v)){for(const x of v)safe(x,hideValues);return;}
  if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){
    assert(!['nonce','proof','frame','request','snapshot','admission_id','actor_id','api_key_id','scope_hash','rows_sha256','input_hash'].includes(k),k);
    if(hideValues)assert(!['unit_cost_minor','value_minor','currency','exponent','cost_state','valuation'].includes(k),k);safe(x,hideValues);
  }
}

test('restored OpenAPI keeps both strict value/export GETs and declares current value authority',()=>{
  const normal=publicApiDocument().paths as Record<string,Row>,restored=publicApiDocument({readOnly:true,port:4198}).paths as Record<string,Row>;
  for(const suffix of ['/value','/export']){
    const p=path+'/{id}'+suffix;assert(normal[p]?.get);assert(restored[p]?.get);assert.equal(restored[p].post,undefined);
    assert.deepEqual(new Set(restored[p].get['x-required-scopes']),new Set(['products:read','inventory:read']));
    assert.deepEqual(restored[p].get['x-value-required-scopes'],['purchasing:read']);assert.equal(restored[p].get['x-value-required-role'],'admin');
    assert.equal(restored[p].get.parameters.find((p:Row)=>p.name==='id').schema.format,'uuid');
  }
});
test('readOnly normal/v1 value pages and both deterministic exports retain all frozen0/NULL rows and every global fact',async()=>{
  for(const f of fixtures){const before=await facts169(),frozen=own169(before,'catalog_stock_count_rows',f.tenant).filter(r=>r.document_id===f.rw.id).sort((a,b)=>a.ordinal-b.ordinal);
    let expected:Row|undefined;
    for(const ns of ['/api','/api/v1'] as const){const rows:Row[]=[];let cursor:string|null=null;
      do{const v=await get(f,'/value?'+new URLSearchParams({limit:'1',...(cursor?{cursor}:{})}),ns,ns==='/api/v1'?f.full:undefined);
        assert.equal(v.read_only,true);assert.equal(v.can_read_value,true);assert.equal(v.current_role,'admin');assert.equal(v.meta.total,3);safe(v);
        if(expected){assert.deepEqual(v.document,expected.document);assert.deepEqual(v.valuation,expected.valuation);}else expected=v;
        rows.push(...v.data);assert(rows.length<=3);cursor=v.meta.cursor;
      }while(cursor);assert.deepEqual(rows.map(r=>r.id),frozen.map(r=>r.id));assert.deepEqual(rows.map(r=>r.ordinal),[0,1,2]);
      if(f.on){assert.equal(expected!.value_state,'partial_unknown');assert.deepEqual(rows.map(r=>r.unit_cost_minor).sort(),[null,'0','1000'].sort());
        assert.deepEqual(expected!.valuation.buckets,[{currency:'PLN',exponent:2,known_quantity:'2',zero_cost_quantity:'1',unknown_quantity:'1',known_value_minor:'1000',signed_known_value_minor:'-1000'}]);}
      else{assert.deepEqual(expected!.valuation,{state:'unavailable_off',physical_quantity:'3',buckets:[]});safe(rows,true);}
      for(const format of ['csv','xml'])for(const include of ['true','false']){
        const e=await get(f,`/export?format=${format}&include_values=${include}`,ns,ns==='/api/v1'?f.full:undefined);
        assert.equal(e.read_only,true);assert.equal(e.values_included,f.on&&include==='true');assert.equal(e.row_count,3);safe(e,!e.values_included);
        const prior=await f.ok(path+'/'+f.rw.id+`/export?format=${format}&include_values=${include}`);
        assert.equal(e.content,prior.content,'Snapshot read time/restore flags never change immutable file bytes');
        assert(e.content.includes(f.rw.id));for(const r of frozen)assert(e.content.includes(r.product_id));
        if(!e.values_included)assert(!/unit_cost_minor|value_minor|currency|exponent|cost_state/.test(e.content));
      }
    }assert.deepEqual(await facts169(),before,'ALL global rows/sessions/documents/counters exact after restored and ordinary GETs');
  }
});
test('readOnly strict bad queries and foreign/restored cursor binding refuse without mutation',async()=>{
  for(const f of fixtures){const before=await facts169();
    for(const ns of ['/api','/api/v1'] as const){const key=ns==='/api/v1'?f.full:undefined;
      for(const q of ['limit=0','limit=51','cursor=!','cursor=unauthenticated','other=1'])await get(f,'/value?'+q,ns,key,422);
      for(const q of ['format=pdf','format=csv&include_values=1','format=xml&limit=1','include_values=false'])await get(f,'/export?'+q,ns,key,422);
      const foreign=await copy.inject({url:ns+path+'/'+fixtures.find(x=>x.tenant!==f.tenant)!.rw.id+'/value',headers:key?{authorization:'Bearer '+key.token}:{cookie:f.copyCookie},remoteAddress:f.remoteAddress});assert.equal(foreign.statusCode,404);
    }
    const ordinary=await f.ok(path+'/'+f.rw.id+'/value?limit=1');assert(ordinary.meta.cursor);
    await get(f,'/value?'+new URLSearchParams({limit:'1',cursor:ordinary.meta.cursor}),'/api',undefined,409);
    assert.deepEqual(await facts169(),before);
  }
});
test('readOnly malformed writes reject423 before JSON parse/authentication on both new paths',async()=>{
  const before=await facts169();for(const ns of ['/api','/api/v1'])for(const f of fixtures)for(const suffix of ['/value','/export?format=csv']){
    const r=await copy.inject({method:'POST',url:ns+path+'/'+f.rw.id+suffix,payload:'{',headers:{'content-type':'application/json'}});
    assert.equal(r.statusCode,423);assert.equal(r.headers['set-cookie'],undefined);assert(!r.body.includes('unit_cost_minor'));
  }assert.deepEqual(await facts169(),before,'No malformed refusal can allocate a document, session or journal');
});
test('restored current quantity scopes, purchasing grant and normal viewer remain authoritative',async()=>{
  for(const f of fixtures){const before=await facts169();
    await get(f,'/value','/api/v1',f.quantity,403);await get(f,'/export?format=csv&include_values=true','/api/v1',f.quantity,403);
    await get(f,'/value','/api/v1',f.incomplete,403);
    const e=await get(f,'/export?format=xml&include_values=false','/api/v1',f.quantity);assert.equal(e.can_read_value,false);assert.equal(e.read_only,true);safe(e,true);
    assert.deepEqual(await facts169(),before);
    await pool.query("UPDATE memberships SET role='viewer' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);
    try{const viewer=await facts169();await get(f,'/value','/api',undefined,403);await get(f,'/export?format=xml&include_values=true','/api',undefined,403);
      const quantity=await get(f,'/export?format=csv&include_values=false');assert.equal(quantity.current_role,'viewer');assert.equal(quantity.can_read_value,false);safe(quantity,true);
      // Native013 demotion revokes all admin-owned API keys; never revive them.
      await get(f,'/value','/api/v1',f.full,401);assert.deepEqual(await facts169(),viewer);
    }finally{await pool.query("UPDATE memberships SET role='admin' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);}
  }
});
