import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {buildApp} from '../server/app';
import {pool} from '../server/db';
import {seed} from './fixtures';
import {catalogStockControlAdmissionInTx} from '../server/catalog-stock-control-transaction';
import {bootstrap151169,install152169,fixture169,prepare169,facts169,physicalExact169,prefix169,wait169,type Row,type Fixture169} from './catalog-stock-control169-fixture';

// Authored genuine PG boundaries. No executions by the source author.
let app:Awaited<ReturnType<typeof buildApp>>,providers=0;
const transport=async()=>{providers++;throw Error('Providers forbidden in disposable safety proof');};
before(async()=>{await bootstrap151169();await seed();await install152169();app=await buildApp({integrationTransport:transport});});
after(async()=>{try{assert.equal(providers,0);await app?.close();}finally{await pool.end();}});
async function active(on=false) {
  const f=await fixture169(app,on),p=await prepare169(f),r=await f.ok(prefix169+'/previews/'+p.preview.id+'/commit','POST',p.commit,201);
  assert.equal(r.operation.after.strict,true);return {...f,p,operation:r.operation};
}
async function rawDenied(f:Fixture169,sql:string,values:unknown[],code:string) {
  const before=await facts169(),c=await pool.connect();
  try {
    await c.query('BEGIN');await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
    await assert.rejects(async()=>{await c.query(sql,values);await c.query('SET CONSTRAINTS ALL IMMEDIATE');},{code});
  }finally{await c.query('ROLLBACK');c.release();}
  assert.deepEqual(await facts169(),before,'Rejected raw authority/effect leaves ALL global rows and sessions exact');
}
test('raw shared dyna_app cannot read/write private BO authority or EXECUTE private commit/effect issuer',async()=>{
  const f=await active(),before=await facts169();
  for(const [sql,args] of [
    ['SELECT * FROM public.catalog_stock_control_admissions',[]],
    ['UPDATE public.catalog_stock_control_policies SET version=version',[]],
    ['DELETE FROM public.catalog_stock_control_documents WHERE id=$1',[f.operation.documents[0].id]],
    ['SELECT public.catalog_stock_control_commit($1,NULL,$2,$3::jsonb)',[f.user,f.p.preview.id,JSON.stringify(f.p.commit)]],
    ['SELECT public.catalog_stock_control_effect_prepare($1,NULL,$2::jsonb)',[f.user,JSON.stringify({source_kind:'warehouse_document',source_id:randomUUID(),warehouse_ids:[f.warehouse.id],product_ids:[f.products[0].id]})]],
  ] as [string,unknown[]][])await rawDenied(f,sql,args,'42501');
  assert.deepEqual(await facts169(),before);
});
test('strict source effect prepare without physical finish cannot COMMIT even with a genuine own draft source',async()=>{
  const f=await active(),draft=await f.ok('/warehouse-documents','POST',{kind:'receipt',warehouse_id:f.warehouse.id,lines:[{product_id:f.products[0].id,quantity:1,location:'A-01'}],reference:'Genuine orphan prepare source169',note:''},201),before=await facts169(),c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query("SET LOCAL TimeZone='UTC'");await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
    const source={source_kind:'warehouse_document',source_id:draft.id,warehouse_ids:[f.warehouse.id],product_ids:[f.products[0].id]};
    const token=(await c.query('SELECT public.catalog_stock_control_effect_prepare($1,NULL,$2::jsonb) token',[f.user,JSON.stringify(source)])).rows[0].token;
    assert(token);assert.equal(token.tenant_id,f.tenant);assert.deepEqual(token.strict_catalog_ids,[f.primary.id]);assert.equal(token.number.kind,'PZ');
    await assert.rejects(c.query('COMMIT'),{code:'23514'},'Real deferred completeness must refuse an orphan, not just missing FK identity');
  }finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
  assert.deepEqual(await facts169(),before,'Tentative PZ system counter/admission rolls back with no document or physical writes');
});
test('unmanaged same-client caller cannot acquire lifecycle admission by guessing GUC/tenant alone',async()=>{
  const f=await fixture169(app),before=await facts169(),c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
    await assert.rejects(catalogStockControlAdmissionInTx(c,{tenantId:f.tenant}), (e:any)=>e.status===500&&e.message==='Brak zarządzanej transakcji katalogu');
  }finally{await c.query('ROLLBACK');c.release();}
  assert.deepEqual(await facts169(),before);
});
for(const on of [false,true])test(`${on?'ON':'OFF'} strict raw manual aggregate/bin/version changes require actual typed current-TX admission`,async()=>{
  const f=await active(on);
  for(const [sql,args] of [
    ['UPDATE public.stock SET on_hand=on_hand+1 WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',[f.tenant,f.products[0].id,f.warehouse.id]],
    ['UPDATE public.stock_locations SET quantity=quantity+1 WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',[f.tenant,f.products[0].id,f.warehouse.id]],
  ] as [string,unknown[]][])await rawDenied(f,sql,args,'23514');
  const before=await facts169();
  assert.equal((await f.request('/inventory/adjust','POST',{product_id:f.products[0].id,warehouse_id:f.warehouse.id,delta:1,note:'Genuine forbidden manual169'})).statusCode,409,'Public manual quantity is blocked, not only rawSQL');
  assert.deepEqual(await facts169(),before);
});
for(const afterFlush of [false,true])test(`BO ${afterFlush?'after seal':'before final flush'} source mutation rejects and rolls back BO numbers/fullgraph`,async()=>{
  const f=await fixture169(app),p=await prepare169(f),before=await facts169(),c=await pool.connect();
  try {
    await c.query('BEGIN');await c.query("SET LOCAL TimeZone='UTC'");await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
    const result=(await c.query('SELECT public.catalog_stock_control_commit($1,NULL,$2,$3::jsonb) r',[f.user,p.preview.id,JSON.stringify(p.commit)])).rows[0].r;
    assert.equal(result.operation.after.strict,true);assert.equal(result.operation.documents.length,2);
    if(afterFlush)await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await assert.rejects(async()=>{await c.query("UPDATE public.products SET name=name||' forbidden late BO change' WHERE(tenant_id,id)=($1,$2)",[f.tenant,f.products[0].id]);await c.query('SET CONSTRAINTS ALL IMMEDIATE');},{code:'23514'});
  }finally{await c.query('ROLLBACK');c.release();}
  assert.deepEqual(await facts169(),before);physicalExact169(before,await facts169());
});
for(const on of [false,true])test(`${on?'ON':'OFF'} actual terminal membership wait then downgrade rejects BO and every counter/effect`,async()=>{
  const f=await fixture169(app,on),p=await prepare169(f),before=await facts169(),block=await pool.connect();let request:ReturnType<typeof f.request>|undefined;
  try{
    await block.query('BEGIN');const pid=(await block.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await block.query('SELECT role FROM public.memberships WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',[f.tenant,f.user]);
    request=f.request(prefix169+'/previews/'+p.preview.id+'/commit','POST',p.commit);
    await wait169(pid,/catalog_stock_control_access|memberships/i);
    await block.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",[f.tenant,f.user]);await block.query('COMMIT');
    assert.equal((await request).statusCode,403);
  }finally{
    await block.query('ROLLBACK').catch(()=>{});block.release();if(request)await request;
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2",[f.tenant,f.user]);
  }
  assert.deepEqual(await facts169(),before,'Late IAM cannot publish BO strictpolicy/numbers or physical effects');
});
for(const mode of ['scopes','revoke','expire'] as const)test(`actual BO final key wait then ${mode} rejects and restores original key/fullgraph`,async()=>{
  const f=await fixture169(app),key=await f.ok('/developer/keys','POST',{name:'Own BO key169',scopes:['inventory:read','inventory:write','purchasing:read']},201);
  // Preview must be born under the same real key principal that gives consent.
  const source=(await f.ok(prefix169+'/catalogs/'+f.primary.id+'/source','GET',undefined,200,key)).source;
  const body={client_key:randomUUID(),catalog_version:source.snapshot.catalog.version,policy_version:source.snapshot.policy.version,warehouse_policy_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.policy.version})),series_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.series.version}))};
  const p=(await f.ok(prefix169+'/catalogs/'+f.primary.id+'/previews','POST',body,201,key)).preview,commit={client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true};
  const original=(await pool.query('SELECT * FROM api_keys WHERE tenant_id=$1 AND id=$2',[f.tenant,key.id])).rows[0];assert(original);
  const before=await facts169(),block=await pool.connect();let request:ReturnType<typeof f.request>|undefined;
  try{
    await block.query('BEGIN');const pid=(await block.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await block.query('SELECT id FROM public.api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[f.tenant,key.id]);
    request=f.request(prefix169+'/previews/'+p.id+'/commit','POST',commit,key);await wait169(pid,/catalog_stock_control_access|api_keys/i);
    if(mode==='scopes')await block.query("UPDATE api_keys SET scopes=ARRAY['inventory:read'] WHERE tenant_id=$1 AND id=$2",[f.tenant,key.id]);
    if(mode==='revoke')await block.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[f.tenant,key.id]);
    if(mode==='expire')await block.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.tenant,key.id]);
    await block.query('COMMIT');assert.equal((await request).statusCode,mode==='scopes'?403:401);
  }finally{
    await block.query('ROLLBACK').catch(()=>{});block.release();if(request)await request;
    await pool.query('UPDATE api_keys SET scopes=$3,revoked_at=$4,expires_at=$5 WHERE tenant_id=$1 AND id=$2',[f.tenant,key.id,original.scopes,original.revoked_at,original.expires_at]);
  }
  assert.deepEqual(await facts169(),before);
});
test('concurrent exact BO consents visibly wait lifecycle lock and yield one operation/series increment, two identical replies',async()=>{
  const f=await fixture169(app),p=await prepare169(f),before=await facts169(),block=await pool.connect();let a:ReturnType<typeof f.request>|undefined,b:ReturnType<typeof f.request>|undefined;
  try{
    await block.query('BEGIN');const pid=(await block.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await block.query("SELECT pg_advisory_xact_lock(hashtextextended('catalog.strict.lifecycle:'||$1,0))",[f.tenant]);
    a=f.request(prefix169+'/previews/'+p.preview.id+'/commit','POST',p.commit);const apid=await wait169(pid,/catalog.strict.lifecycle/);
    b=f.request(prefix169+'/previews/'+p.preview.id+'/commit','POST',p.commit);
    const end=Date.now()+5000;let simultaneous=false;
    while(Date.now()<end){const waiting=(await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[pid])).rows;simultaneous=waiting.some(r=>r.pid===apid)&&waiting.some(r=>r.pid!==apid);if(simultaneous)break;await new Promise(r=>setTimeout(r,10));}
    assert(simultaneous,'Both actual API requests must be blocked before release');await block.query('COMMIT');
    const replies=await Promise.all([a,b]);assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,201]);assert.deepEqual(replies[0].json().operation,replies[1].json().operation);
  }finally{await block.query('ROLLBACK').catch(()=>{});block.release();await Promise.allSettled([a,b].filter(Boolean));}
  const after=await facts169();physicalExact169(before,after);
  assert.equal(after.catalog_stock_control_operations.length-before.catalog_stock_control_operations.length,1);
  assert.equal(after.catalog_stock_control_documents.length-before.catalog_stock_control_documents.length,2);
  assert.equal(after.catalog_stock_control_counters.length-before.catalog_stock_control_counters.length,2);
});

test('foreign effective ACL, extra RLS policy and function grant fail guards in real rollback subtransactions',async()=>{
  const f=await fixture169(app),before=await facts169();
  for(const ddl of [
    'GRANT SELECT ON public.catalog_stock_control_documents TO pg_read_all_data',
    'GRANT SELECT(payload) ON public.catalog_stock_control_documents TO pg_read_all_data',
    'GRANT EXECUTE ON FUNCTION public.catalog_stock_control_commit(uuid,uuid,uuid,jsonb) TO pg_read_all_data',
    'CREATE POLICY extra169 ON public.catalog_stock_control_documents USING(true)',
  ]){
    const c=await pool.connect();try{await c.query('BEGIN');await c.query(ddl);assert.equal((await c.query('SELECT public.catalog_stock_control_guards() ok')).rows[0].ok,false);await assert.rejects(c.query('SELECT public.catalog_stock_control_require()'),{code:'55000'});}finally{await c.query('ROLLBACK');c.release();}
    assert.deepEqual(await facts169(),before);
  }
  assert.equal((await f.ok(prefix169+'/catalogs/'+f.primary.id+'/source')).available,true,'Rolled back metadata intrusion restores genuine module availability');
});
test('fresh-connection pg_temp stock/catalog/private-policy shadows cannot spoof qualified actual BO snapshot or guard',async()=>{
  const f=await fixture169(app),before=await facts169(),c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
  try{
    await c.query('BEGIN');await c.query("SET LOCAL TimeZone='UTC'");await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
    // All shadows exist before this connection's first PL/pgSQL frame/guard call.
    for(const name of ['products','stock','stock_locations','product_catalogs','product_catalog_warehouses','catalog_stock_control_policies','catalog_stock_control_series','catalog_stock_control_rows']){
      assert.match(name,/^[a-z_]+$/);await c.query(`CREATE TEMP TABLE "${name}" AS TABLE public."${name}"`);
    }
    await c.query('UPDATE pg_temp.stock SET on_hand=999999 WHERE tenant_id=$1',[f.tenant]);await c.query('UPDATE pg_temp.stock_locations SET quantity=999999 WHERE tenant_id=$1',[f.tenant]);
    await c.query("UPDATE pg_temp.products SET name='forged shadow' WHERE tenant_id=$1",[f.tenant]);
    await c.query('INSERT INTO pg_temp.catalog_stock_control_policies(tenant_id,catalog_id,version,operation_id) VALUES($1,$2,1,$3)',[f.tenant,f.primary.id,randomUUID()]);
    await c.query('SET LOCAL ROLE dyna_app');assert.equal((await c.query('SELECT public.catalog_stock_control_guards() ok')).rows[0].ok,true);
    await c.query('RESET ROLE');const frame=(await c.query('SELECT public.catalog_stock_control_frame($1) frame',[f.primary.id])).rows[0].frame;
    assert.equal(frame.snapshot.summary.physical_quantity,'5');assert.equal(frame.snapshot.policy.strict,false);assert.equal(frame.rows.length,1);assert.equal(frame.rows[0].name,f.products[0].name);assert.equal(frame.rows[0].quantity,5);
  }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
  assert.deepEqual(await facts169(),before);
});
test('disabling actual activation trigger is torn startup/read/fresh ordinary writer503, then exact metadata restoration',async()=>{
  const f=await fixture169(app),before=await facts169();
  const trigger=(await pool.query("SELECT to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t WHERE tgrelid='public.catalog_stock_control_admissions'::regclass AND tgname='catalog_stock_control_activation_complete'")).rows[0];assert(trigger);assert.equal(trigger.meta.tgenabled,'O');
  try{
    await pool.query('ALTER TABLE public.catalog_stock_control_admissions DISABLE TRIGGER catalog_stock_control_activation_complete');
    await assert.rejects(buildApp({integrationTransport:transport}),(e:any)=>e.status===503||e.statusCode===503);
    assert.equal((await f.request(prefix169+'/catalogs/'+f.primary.id+'/source')).statusCode,503);
    assert.equal((await f.request('/inventory/adjust','POST',{product_id:f.products[0].id,warehouse_id:f.warehouse.id,delta:1,note:'Torn current module rejects before write'})).statusCode,503);
  }finally{await pool.query('ALTER TABLE public.catalog_stock_control_admissions ENABLE TRIGGER catalog_stock_control_activation_complete');}
  assert.deepEqual((await pool.query("SELECT to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t WHERE tgrelid='public.catalog_stock_control_admissions'::regclass AND tgname='catalog_stock_control_activation_complete'")).rows[0],trigger);
  assert.deepEqual(await facts169(),before);
});
test('missing installed152 ledger produces startup503 and existing normal/v1 fresh mutation503; restore exact global rows',async()=>{
  const f=await fixture169(app),key=await f.ok('/developer/keys','POST',{name:'Own torn169probe',scopes:['inventory:read','inventory:write']},201),before=await facts169(),ledger=(await pool.query("SELECT * FROM migrations WHERE name='152_catalog_stock_control'")).rows[0];assert(ledger);
  try{
    await pool.query("DELETE FROM migrations WHERE name='152_catalog_stock_control'");
    await assert.rejects(buildApp({integrationTransport:transport}),(e:any)=>e.status===503||e.statusCode===503);
    for(const ns of ['/api','/api/v1']) {
      const r=await app.inject({method:'POST',url:ns+prefix169+'/catalogs/'+f.primary.id+'/previews',headers:{'content-type':'application/json',...(ns==='/api/v1'?{authorization:'Bearer '+key.token}:{cookie:f.cookie})},payload:'{'});assert.equal(r.statusCode,503);
    }
    assert.equal((await f.request(prefix169+'/catalogs/'+f.primary.id+'/source')).statusCode,503);
  }finally{await pool.query('INSERT INTO migrations(name,applied_at) VALUES($1,$2)',[ledger.name,ledger.applied_at]);}
  assert.deepEqual(await facts169(),before);
});
