import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture, adjustmentActor } from './stocktake-adjustments-fixture';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import { bootstrap151169, install152169, facts169, own169, physicalExact169, consent169, wait169, type Row } from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Real native API sources, genuine internal BO,
// observed native advisory wait and exact global rollback including sessions.
// Owner SQL is used solely for the deliberate lock/IAM adversary, not parents,
// stock, journals, receipt fabrication or fake successful callbacks.
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
const options = { integrationTransport: async () => { providerCalls++; throw Error('No external count authority transport'); } };
const one = (rows: Row[]) => { assert.equal(rows.length,1); return rows[0]; };
type Protocol = 'inventory_bulk'|'stock_file';
type Loss = 'revoke'|'expiry'|'scope'|'viewer';
type CountFixture = Awaited<ReturnType<typeof fixture>>;
type Prepared = Awaited<ReturnType<typeof prepare>>;
let historical: CountFixture, historicalSource: Prepared, historicalResult: Row, historicalExecution: Row;

before(async () => {
  await bootstrap151169(); await seed(); app = await buildApp(options);
  historical = await fixture('inventory_bulk',false,false);
  historicalSource = await prepare(historical);
  historicalResult = await historical.ok(historicalSource.path,'POST',historicalSource.body,201,historical.key);
  historicalExecution = one(own169(await facts169(),'inventory_bulk_edit_executions',historical.tenant));
  assert.equal((await pool.query("SELECT to_regclass('public.catalog_stock_count_receipts') r")).rows[0].r,null);
  await app.close(); await install152169(); app = await buildApp(options);
});
after(async () => { try { assert.equal(providerCalls,0); await app?.close(); } finally { await pool.end(); } });

async function activate(f: Awaited<ReturnType<typeof stocktakeAdjustmentFixture>>) {
  const catalog = one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1',[f.tenant])).rows).catalog_id as string;
  const publicSource = await f.ok('/catalog-stock-control/catalogs/'+catalog+'/source');
  assert.equal(publicSource.writers_available,false); assert.equal(publicSource.activation_available,false);
  const beforeRows = await facts169(), context = { writersAvailable:true };
  const { source } = await sourceCatalogStockControl(f.actor,catalog,context);
  assert.equal(source.ready,true,JSON.stringify(source.blockers));
  const { preview } = await previewCatalogStockControl(f.actor,catalog,{
    client_key:randomUUID(),catalog_version:source.snapshot.catalog.version,policy_version:source.snapshot.policy.version,
    warehouse_policy_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:source.snapshot.warehouses.map((w:CatalogStockControlWarehouse)=>({warehouse_id:w.id,version:w.series.version})),
  },context);
  assert.equal((await commitCatalogStockControl(f.actor,preview.id,consent169(preview),context)).operation.after.strict,true);
  physicalExact169(beforeRows,await facts169());
}
async function fixture(protocol: Protocol,on=false,strict=true) {
  const f = await stocktakeAdjustmentFixture(app,on);
  if (strict) await activate(f);
  const scopes = ['products:read','inventory:read','inventory:write',...(on?['purchasing:read','purchasing:write']:[])];
  const key = await f.ok('/developer/keys','POST',{name:'Actual native count authority '+protocol,scopes},201);
  const saved = one(own169(await facts169(),'api_keys',f.tenant).filter(k=>k.id===key.id));
  assert.deepEqual(saved.scopes,scopes); assert.equal(saved.user_id,f.user);
  return {...f,protocol,key};
}
async function prepare(f: CountFixture) {
  const beforeRows = await facts169(), product = f.products[0];
  if (f.protocol==='inventory_bulk') {
    const live = one(own169(beforeRows,'products',f.tenant).filter(p=>p.id===product.id));
    const stock = one(own169(beforeRows,'stock',f.tenant).filter(s=>s.product_id===product.id && s.warehouse_id===f.warehouse.id));
    const { preview } = await f.ok('/inventory-bulk-edit/previews','POST',{
      client_key:randomUUID(),warehouse_id:f.warehouse.id,note:'Actual authority two-bin net0 count',
      rows:[{location:'A-01',quantity:1},{location:'B-02',quantity:3}].map(r=>({
        ...r,product_id:product.id,product_version:live.version,stock_version:String(stock.version),operation:'count',
      })),
    },201,f.key);
    assert.equal(preview.ready,true); assert.equal(preview.changed,2);
    physicalExact169(beforeRows,await facts169());
    return {preview,body:consent169(preview),path:'/inventory-bulk-edit/previews/'+preview.id+'/execute'};
  }
  const lot = f.on ? one(own169(beforeRows,'wms_cost_layers',f.tenant).filter(l=>
    own169(beforeRows,'wms_layer_positions',f.tenant).some(p=>p.layer_id===l.id && p.product_id===product.id && p.warehouse_id===f.warehouse.id && p.location==='A-01'))).lot_id : null;
  const { preview } = await f.ok('/stock-file-imports/previews','POST',{
    client_key:randomUUID(),file_name:'actual-count-authority169.csv',note:'Actual source authority shortage',
    content:f.on?`SKU;Q;LOT\n${product.sku};1;${lot}`:`SKU;Q\n${product.sku};1`,
    definition:{format:'csv',xml_mode:'positions',delimiter:';',identity:'sku',identity_field:'SKU',spreadsheet_safe:false,empty_policy:'skip'},
    targets:[{warehouse_id:f.warehouse.id,quantity_scope:'position',default_location:'A-01',mapping:{quantity:'Q',...(f.on?{lot_id:'LOT'}:{})}}],resolutions:[],
  },201,f.key);
  assert.equal(preview.summary.changed,1); assert.equal(preview.summary.invalid,0); assert.equal(preview.summary.conflicts,0);
  physicalExact169(beforeRows,await facts169());
  return {preview,body:{...consent169(preview),ack_unknown_loss_warehouse_ids:[],ack_surplus_warehouse_ids:[]},path:'/stock-file-imports/previews/'+preview.id+'/execute'};
}
async function saved(protocol: Protocol,on=false) {
  const f = await fixture(protocol,on), source = await prepare(f);
  const result = await f.ok(source.path,'POST',source.body,201,f.key);
  const facts = await facts169(), receipt = one(own169(facts,'catalog_stock_count_receipts',f.tenant));
  const admission = one(own169(facts,'catalog_stock_count_admissions',f.tenant));
  assert.equal(admission.actor_id,f.user); assert.equal(admission.api_key_id,f.key.id); assert.equal(admission.protocol,protocol);
  assert.equal(admission.source_id,source.preview.id); assert.deepEqual(admission.request,source.body); assert.equal(admission.sealed,true);
  assert.equal(receipt.admission_id,admission.id);
  assert.equal(receipt[protocol==='inventory_bulk'?'inventory_execution_id':'stock_file_execution_id'],result.execution.id);
  assert.equal(result.execution.stock_count_documents.length,protocol==='inventory_bulk'?2:1);
  return {f,source,result};
}

for (const protocol of ['inventory_bulk','stock_file'] as const) test(`${protocol} strict native API-key exact replay is pure and a different actual key cannot claim the count receipt`,async()=>{
  const {f,source,result} = await saved(protocol);
  const other = await f.ok('/developer/keys','POST',{name:'Other real source key',scopes:['products:read','inventory:read','inventory:write']},201);
  const accepted = await facts169();
  const replay = await f.ok(source.path,'POST',source.body,200,f.key);
  assert.equal(replay.reused,true); assert.equal(replay.execution.id,result.execution.id);
  assert.deepEqual(replay.execution.stock_count_documents,result.execution.stock_count_documents);
  assert.deepEqual(await facts169(),accepted,'No journal, number, parent, marker, audit or session append on exact replay');
  assert.equal((await f.request(source.path,'POST',source.body,other)).statusCode,409);
  assert.deepEqual(await facts169(),accepted,'Actual other-key source identity is denied without business changes');
});

async function held(f: CountFixture,source: Prepared,loss: Loss,replay: boolean) {
  const beforeRows = await facts169(), originalKey = one(own169(beforeRows,'api_keys',f.tenant).filter(k=>k.id===f.key.id));
  const originalMember = one(own169(beforeRows,'memberships',f.tenant).filter(m=>m.user_id===f.user));
  assert.equal(originalMember.role,'admin'); assert.equal(originalKey.revoked_at,null);
  assert.equal(typeof originalKey.expires_at,'string'); assert(Date.parse(originalKey.expires_at)>Date.now());
  const blocker = await pool.connect(), authority = await pool.connect();
  let pending: ReturnType<CountFixture['request']>|undefined;
  try {
    await blocker.query('BEGIN');
    const lock = f.protocol==='inventory_bulk'?'inventory.bulk:':'stock-file:';
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock+f.tenant]);
    const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = f.request(source.path,'POST',source.body,f.key);
    const waiter = await wait169(pid,/SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)/i);
    assert.notEqual(waiter,pid,'Actual authenticated native count reached its own source serialization lock');
    if (loss==='viewer') await authority.query("UPDATE public.memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",[f.tenant,f.user]);
    else if (loss==='revoke') await authority.query('UPDATE public.api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[f.tenant,f.key.id]);
    else if (loss==='expiry') await authority.query("UPDATE public.api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.tenant,f.key.id]);
    else await authority.query('UPDATE public.api_keys SET scopes=$3::text[] WHERE tenant_id=$1 AND id=$2',[f.tenant,f.key.id,
      f.on?['products:read','inventory:read','inventory:write','purchasing:read']:['products:read','inventory:read']]);
    const withdrawn = await facts169(), changed = one(own169(withdrawn,'api_keys',f.tenant).filter(k=>k.id===f.key.id));
    if (loss==='viewer') {
      assert.deepEqual(one(own169(withdrawn,'memberships',f.tenant).filter(m=>m.user_id===f.user)),{...originalMember,role:'viewer'});
      assert.equal(typeof changed.revoked_at,'string'); assert.deepEqual(changed,{...originalKey,revoked_at:changed.revoked_at});
    } else if (loss==='scope') assert.deepEqual(changed,{...originalKey,scopes:f.on?['products:read','inventory:read','inventory:write','purchasing:read']:['products:read','inventory:read']});
    else {
      const field = loss==='expiry'?'expires_at':'revoked_at'; assert.equal(typeof changed[field],'string');
      assert.deepEqual(changed,{...originalKey,[field]:changed[field]});
    }
    assert.deepEqual(withdrawn.api_keys.filter(k=>k.row.id!==f.key.id),beforeRows.api_keys.filter(k=>k.row.id!==f.key.id));
    assert.deepEqual(withdrawn,{...beforeRows,api_keys:withdrawn.api_keys,...(loss==='viewer'?{memberships:withdrawn.memberships}:{})},
      'Only deliberate exact committed IAM change is visible during the native wait');
    await blocker.query('COMMIT');
    const response = await pending;
    const expected = loss==='scope' || (loss==='viewer' && f.protocol==='inventory_bulk') ? 403 : 401;
    assert.equal(response.statusCode,expected,response.body);
    assert.deepEqual(await facts169(),withdrawn,`${replay?'Saved replay':'Fresh count'} must roll back ALL native/strict rows, counters, sessions and physical writes after late IAM loss`);
  } finally {
    await blocker.query('ROLLBACK').catch(()=>{}); blocker.release();
    if (pending) await pending.catch(()=>{});
    if (loss==='viewer') await authority.query('UPDATE public.memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2',[f.tenant,f.user,originalMember.role]);
    await authority.query('UPDATE public.api_keys SET revoked_at=$3::timestamptz,expires_at=$4::timestamptz,scopes=$5::text[] WHERE tenant_id=$1 AND id=$2',
      [f.tenant,f.key.id,originalKey.revoked_at,originalKey.expires_at,originalKey.scopes]);
    authority.release();
  }
  assert.deepEqual(await facts169(),beforeRows,'Exact timestamp text and role/scopes repair restores complete original global rows');
}

for (const protocol of ['inventory_bulk','stock_file'] as const)
  for (const replay of [false,true])
    for (const loss of ['revoke','expiry','scope','viewer'] as const)
      test(`${protocol} ${replay?'saved replay':'fresh count'} actual native wait then ${loss} rejects with full global rollback`,async()=>{
        if (replay) { const {f,source} = await saved(protocol); await held(f,source,loss,true); }
        else { const f = await fixture(protocol), source = await prepare(f); await held(f,source,loss,false); }
      });

for (const replay of [false,true]) test(`ON115 ${replay?'replay':'fresh'} native wait then purchasing-write withdrawal rejects complete known-zero physical count`,async()=>{
  if (replay) { const {f,source} = await saved('stock_file',true); await held(f,source,'scope',true); }
  else { const f = await fixture('stock_file',true), source = await prepare(f); await held(f,source,'scope',false); }
});

test('genuine151-born API-key bulk execution remains exact after152 and BO, with no COUNT169 backfill or counter allocation',async()=>{
  const actor = await adjustmentActor(app,historical.tenant), f = {...historical,...actor};
  assert.equal(f.user,historical.user); await activate(f);
  const baseline = await facts169();
  assert.deepEqual(one(own169(baseline,'inventory_bulk_edit_executions',f.tenant)),historicalExecution);
  const reply = await f.ok(historicalSource.path,'POST',historicalSource.body,200,f.key);
  assert.equal(reply.execution.id,historicalResult.execution.id); assert.equal(reply.reused,true);
  assert.deepEqual(reply.execution.stock_count_documents,[]);
  assert.deepEqual(await facts169(),baseline,'Historical151 replay cannot issue PW/RW, alter old native rows or create new physical/number/auth history');
  for (const name of ['admissions','receipts','documents','rows','stock_maps','layer_maps','native_maps'])
    assert.deepEqual(own169(await facts169(),'catalog_stock_count_'+name,f.tenant),[]);
});

for (const protocol of ['inventory_bulk','stock_file'] as const)
  test(`${protocol} two identical real HTTP executes overlap at native/quota locks and publish one graph, one201 and one200 replay`,async()=>{
    const f = await fixture(protocol), source = await prepare(f), baseline = await facts169();
    const blocker = await pool.connect();
    let first: ReturnType<CountFixture['request']>|undefined, second: ReturnType<CountFixture['request']>|undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
        (protocol==='inventory_bulk'?'inventory.bulk:':'stock-file:')+f.tenant,
      ]);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      first = f.request(source.path,'POST',source.body,f.key);
      const firstPid = await wait169(blockerPid,/SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)/i);
      second = f.request(source.path,'POST',source.body,f.key);
      //115 chooses genuine purchasingSourceAdmission at tenantTx entry,
      // before COUNTprepare;086 uses shared purchase admission and reaches
      // the strict quota instead. Observe each real serialization boundary.
      const secondPid = await wait169(firstPid,protocol==='stock_file'
        ? /^SELECT purchasing_source_admit\(\)$/i
        : /SELECT public\.catalog_stock_count_prepare\(/i);
      assert.notEqual(firstPid,secondPid);
      assert.deepEqual(await facts169(),baseline,'Neither blocked real request has committed a partial parent/number/physical graph');
      await blocker.query('COMMIT');
      const responses = await Promise.all([first,second]);
      assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,201]);
      const fresh = responses.find(r=>r.statusCode===201)!.json(), replay = responses.find(r=>r.statusCode===200)!.json();
      assert.equal(fresh.reused,false); assert.equal(replay.reused,true);
      assert.equal(replay.execution.id,fresh.execution.id);
      assert.equal(replay.execution.preview_id,fresh.execution.preview_id);
      assert.equal(replay.execution.scope_hash,fresh.execution.scope_hash);
      assert.deepEqual(replay.execution.stock_count_documents,fresh.execution.stock_count_documents,
        'Both actual responses bind the one native execution and immutable saved PW/RW heads');
      const accepted = await facts169();
      const append = (name:string) => {
        const old = baseline[name], now = accepted[name]; assert(old && now,name);
        const serialized = new Set(old.map(x=>JSON.stringify(x)));
        assert.deepEqual(now.filter(x=>serialized.has(JSON.stringify(x))),old,'Every literal old row retained: '+name);
        const rows = now.filter(x=>!serialized.has(JSON.stringify(x))).map(x=>x.row);
        assert(rows.every(r=>r.tenant_id===f.tenant),'Only exact own source may append: '+name);
        return rows;
      };
      const count = protocol==='inventory_bulk'?2:1;
      const counts: Record<string,number> = {
        catalog_stock_count_admissions:1,catalog_stock_count_receipts:1,catalog_stock_count_documents:count,
        catalog_stock_count_rows:count,catalog_stock_count_stock_maps:count,catalog_stock_count_native_maps:count,
        catalog_stock_count_layer_maps:0,catalog_stock_control_effect_admissions:1,catalog_stock_control_effects:1,
        catalog_stock_control_effect_journals:count*2,catalog_stock_control_series:count,catalog_stock_control_counters:count,
        stock_location_operations:count,stock_movements:count,stock_location_movements:count,purchasing_stock_changes:count*2,
        inventory_bulk_edit_executions:1,inventory_bulk_edit_execution_rows:count,
        ...(protocol==='stock_file'?{inventory_bulk_edit_previews:1,inventory_bulk_edit_rows:count,
          stock_file_import_executions:1,stock_file_import_admissions:1,stock_file_import_core_witnesses:2}:{}),
      };
      for (const [name,n] of Object.entries(counts)) assert.equal(append(name).length,n,'Exactly one native dispatch of count publisher: '+name);
      const receipt = one(append('catalog_stock_count_receipts')), admission = one(append('catalog_stock_count_admissions'));
      assert.equal(receipt.admission_id,admission.id); assert.equal(admission.count_receipt_id,receipt.id); assert.equal(admission.sealed,true);
      assert.equal(admission.protocol,protocol); assert.equal(admission.source_id,source.preview.id); assert.equal(admission.api_key_id,f.key.id);
      assert.deepEqual(admission.request,source.body);
      assert.equal(receipt[protocol==='inventory_bulk'?'inventory_execution_id':'stock_file_execution_id'],fresh.execution.id);
      const docs = append('catalog_stock_count_documents');
      assert.deepEqual(docs.map(d=>d.id).sort(),fresh.execution.stock_count_documents.map((d:Row)=>d.id).sort());
      for (const d of docs) {
        assert.equal(d.receipt_id,receipt.id); assert.equal(String(d.sequence),'1');
        const counter = one(append('catalog_stock_control_counters').filter(c=>c.series_id===d.series_id && c.year===d.year));
        assert.equal(String(counter.value),'1','Waiting exact replay must not consume an extra PW/RW number');
      }
      const product = f.products[0], changes = protocol==='inventory_bulk'
        ? [{location:'A-01',delta:-1},{location:'B-02',delta:1}]:[{location:'A-01',delta:-1}];
      const movements = append('stock_location_movements');
      assert.deepEqual(movements.map(m=>[m.location,m.delta]).sort(),changes.map(m=>[m.location,m.delta]).sort());
      assert(movements.every(m=>m.warehouse_id===f.warehouse.id && m.product_id===product.id && m.kind==='count'));
      const stockMoves = append('stock_movements');
      assert.deepEqual(stockMoves.map(m=>m.delta).sort(),changes.map(m=>m.delta).sort());
      assert(stockMoves.every(m=>m.warehouse_id===f.warehouse.id && m.product_id===product.id && m.kind==='location_count'));
      const omit = (r:Row,fields:string[]) => Object.fromEntries(Object.entries(r).filter(([k])=>!fields.includes(k)));
      for (const old of own169(baseline,'stock',f.tenant)) {
        const now = one(own169(accepted,'stock',f.tenant).filter(s=>s.product_id===old.product_id && s.warehouse_id===old.warehouse_id));
        const selected = old.product_id===product.id && old.warehouse_id===f.warehouse.id;
        assert.deepEqual(omit(now,['on_hand','available','version']),omit(old,['on_hand','available','version']));
        assert.equal(now.on_hand,old.on_hand+(selected?changes.reduce((sum,x)=>sum+x.delta,0):0));
        assert.equal(now.available,now.on_hand-now.reserved);
        assert.equal(BigInt(now.version),BigInt(old.version)+BigInt(selected?count:0));
      }
      for (const old of own169(baseline,'stock_locations',f.tenant)) {
        const now = one(own169(accepted,'stock_locations',f.tenant).filter(s=>s.product_id===old.product_id && s.warehouse_id===old.warehouse_id && s.location===old.location));
        const delta = old.product_id===product.id && old.warehouse_id===f.warehouse.id ? changes.find(x=>x.location===old.location)?.delta??0 : 0;
        assert.deepEqual(now,{...old,quantity:old.quantity+delta});
      }
      for (const name of Object.keys(baseline)) {
        assert.deepEqual(accepted[name].filter(x=>x.row.tenant_id!==f.tenant),baseline[name].filter(x=>x.row.tenant_id!==f.tenant),'All foreign/global rows and sessions exact: '+name);
        if (name in counts || name==='stock' || name==='stock_locations') continue;
        if (name==='audit_events') {
          const audit = append(name);
          assert(audit.every(r=>r.user_id===f.user));
          assert.deepEqual(audit.map(r=>r.action).sort(),(protocol==='inventory_bulk'
            ? ['stock.location.count','stock.location.count','inventory.bulk.execute']
            : ['stock.location.count','inventory.bulk.preview','inventory.bulk.execute','stock.file.execute']).sort());
        } else assert.deepEqual(accepted[name],baseline[name],'No second hidden parent/source or WMS/financial/auth write: '+name);
      }
      assert.equal((await f.ok(source.path,'POST',source.body,200,f.key)).reused,true);
      assert.deepEqual(await facts169(),accepted,'Terminal repeated exact command remains wholly pure after the concurrent pair');
    } finally {
      await blocker.query('ROLLBACK').catch(()=>{}); blocker.release();
      await Promise.all([first,second].filter((p):p is NonNullable<typeof p>=>!!p).map(p=>p.catch(()=>{})));
    }
  });
