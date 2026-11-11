// SOURCE_AUTHORED_NOT_RUN. Root executes only in its fresh numeric scratch DB.
// Intrusion/terminal authority gates, not a replacement for the unchanged101 suite.
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {buildApp} from '../server/app';
import {pool} from '../server/db';
import {seed} from './fixtures';
import {stocktakeAdjustmentFixture} from './stocktake-adjustments-fixture';
import {sourceCatalogStockControl,previewCatalogStockControl,commitCatalogStockControl} from '../server/catalog-stock-control';
import {bootstrap151169,install152169,facts169,own169,consent169,wait169,type Row} from './catalog-stock-control169-fixture';

let app:Awaited<ReturnType<typeof buildApp>>,providerCalls=0;
before(async()=>{await bootstrap151169();await seed();await install152169();
  const functions=(await pool.query("SELECT to_regprocedure('public.catalog_stock_count_statement_guard()') statement,to_regprocedure('public.catalog_stock_count_terminal_require()') terminal")).rows[0];
  assert(functions.statement&&functions.terminal,'Requires real capacity SQL and managed terminal hook');
  app=await buildApp({integrationTransport:async()=>{providerCalls++;throw Error('Capacity intrusion fixture forbids providers');}});});
after(async()=>{try{await app?.close();assert.equal(providerCalls,0);}finally{await pool.end();}});
const one=(rows:Row[])=>{assert.equal(rows.length,1);return rows[0];};
const helper='public.catalog_stock_count_statement_guard()';
async function helperAcl(){return one((await pool.query('SELECT to_jsonb(p) metadata FROM pg_proc p WHERE p.oid=$1::regprocedure',[helper])).rows).metadata;}
async function fixture(){
  const f=await stocktakeAdjustmentFixture(app,false),catalog=one((await pool.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1',[f.tenant])).rows).catalog_id as string;
  const publicSource=await f.ok('/catalog-stock-control/catalogs/'+catalog+'/source');
  assert.equal(publicSource.writers_available,false);assert.equal(publicSource.activation_available,false);
  const ctx={writersAvailable:true},{source}=await sourceCatalogStockControl(f.actor,catalog,ctx);assert.equal(source.ready,true);
  const {preview}=await previewCatalogStockControl(f.actor,catalog,{client_key:randomUUID(),catalog_version:source.snapshot.catalog.version,
    policy_version:source.snapshot.policy.version,warehouse_policy_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.series.version}))},ctx);
  assert.equal((await commitCatalogStockControl(f.actor,preview.id,consent169(preview),ctx)).operation.after.strict,true);
  return f;
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function prepare(f:Fixture,key?:Row){
  const facts=await facts169(),stocks=own169(facts,'stock',f.tenant),products=own169(facts,'products',f.tenant);
  const rows=f.products.flatMap(p=>['A-01','B-02'].map(location=>({product_id:p.id,
    product_version:one(products.filter(r=>r.id===p.id)).version,
    stock_version:String(one(stocks.filter(r=>r.product_id===p.id&&r.warehouse_id===f.warehouse.id)).version),
    location,operation:'count',quantity:location==='A-01'?1:3})));
  const {preview}=await f.ok('/inventory-bulk-edit/previews','POST',{client_key:randomUUID(),warehouse_id:f.warehouse.id,note:'Six true native086 counts for terminal intrusion',rows},201,key);
  assert.equal(preview.ready,true);assert.equal(preview.changed,6);assert.equal(preview.total,6);
  return{preview,body:consent169(preview),path:'/inventory-bulk-edit/previews/'+preview.id+'/execute'};
}
async function zeroInsert(tenant:string){
  const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
    // Real INSERT statement with zero tuples: no fake native parent or physical journal.
    await assert.rejects(c.query('INSERT INTO public.catalog_stock_count_rows SELECT * FROM public.catalog_stock_count_rows WHERE false'),
      (e:unknown)=>(e as {code?:string}).code==='55000','Fresh statement metadata gate must run even for an empty INSERT');
  }finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
}

test('zero-row COUNT INSERT rejects fresh torn function ACL at statement entry with every global row unchanged',async()=>{
  const f=await fixture(),baseline=await facts169(),acl=await helperAcl();
  try{await pool.query('GRANT EXECUTE ON FUNCTION '+helper+' TO dyna_app');assert.notDeepEqual(await helperAcl(),acl);
    await zeroInsert(f.tenant);assert.deepEqual(await facts169(),baseline,'No row/counter/session was created by the rejected zero-row statement');
  }finally{await pool.query('REVOKE EXECUTE ON FUNCTION '+helper+' FROM dyna_app');}
  assert.deepEqual(await helperAcl(),acl,'Restore the literal original ACL; never rebase the manifest');assert.deepEqual(await facts169(),baseline);
});

test('disabling either actual BEFORE or AFTER statement guard fails an empty statement through the remaining fresh gate',async()=>{
  const f=await fixture(),baseline=await facts169();
  const triggers=(await pool.query("SELECT to_jsonb(t) metadata FROM pg_trigger t WHERE tgrelid='public.catalog_stock_count_rows'::regclass AND tgname IN('count_statement_before','count_statement_after') ORDER BY tgname")).rows;
  assert.equal(triggers.length,2);assert(triggers.every(r=>r.metadata.tgenabled==='O'));
  for(const name of['count_statement_before','count_statement_after']){
    try{await pool.query('ALTER TABLE public.catalog_stock_count_rows DISABLE TRIGGER '+name);await zeroInsert(f.tenant);
      assert.deepEqual(await facts169(),baseline,'No publisher effect despite a deliberately missing statement guard');
    }finally{await pool.query('ALTER TABLE public.catalog_stock_count_rows ENABLE TRIGGER '+name);}
  }
  assert.deepEqual((await pool.query("SELECT to_jsonb(t) metadata FROM pg_trigger t WHERE tgrelid='public.catalog_stock_count_rows'::regclass AND tgname IN('count_statement_before','count_statement_after') ORDER BY tgname")).rows,triggers);
  assert.deepEqual(await facts169(),baseline);
});

test('an observed real SQL tail wait after native086 COUNT finish then committed metadata damage returns503 and rolls back the full tentative graph',async()=>{
  const f=await fixture(),d=await prepare(f),baseline=await facts169(),acl=await helperAcl(),blocker=await pool.connect();
  const gate='count.capacity169.tail:'+randomUUID();
  let pending:ReturnType<Fixture['request']>|undefined,finished=false;
  const original=Client.prototype.query;
  Client.prototype.query=function(this:Client,...args:any[]){
    const reply=(original as any).apply(this,args),sql=typeof args[0]==='string'?args[0]:args[0]?.text;
    if(typeof sql==='string'&&sql.startsWith('SELECT public.catalog_stock_count_finish')&&reply?.then)
      return reply.then(async(r:Row)=>{assert.equal(r.rows[0].receipt.documents.length,2);finished=true;
        // Native086 already pins its own membership at entry. Do not pretend
        // a later same-actor membership wait is possible. This observer adds a
        // real, isolated SQL tail wait after the actual native receipt exists;
        // it leaves every native/schema/permission result untouched.
        await(original as any).call(this,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[gate]);return r;});
    return reply;
  } as typeof Client.prototype.query;
  try{await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[gate]);
    const pid=one((await blocker.query('SELECT pg_backend_pid() pid')).rows).pid;
    pending=f.request(d.path,'POST',d.body);
    await wait169(pid,/SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)/i);
    assert.equal(finished,true,'The genuine parent, six native rows and PW/RW precede the observed injected SQL tail wait');
    assert.deepEqual(await facts169(),baseline,'Tentative publisher graph remains uncommitted during the observed real SQL wait');
    await pool.query('GRANT EXECUTE ON FUNCTION '+helper+' TO dyna_app');assert.notDeepEqual(await helperAcl(),acl);
    await blocker.query('COMMIT');const response=await pending;assert.equal(response.statusCode,503,response.body);
    assert.deepEqual(await facts169(),baseline,'Terminal metadata refusal rolls back stock/bins/parents/rows/maps/audit/numbers/session changes');
  }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();if(pending)await pending.catch(()=>{});
    Client.prototype.query=original;await pool.query('REVOKE EXECUTE ON FUNCTION '+helper+' FROM dyna_app');}
  assert.deepEqual(await helperAcl(),acl);assert.deepEqual(await facts169(),baseline);
});

test('a genuine API key expiring after successful terminal metadata and native grant SQL is refused by the actual final clock batch with complete rollback',async()=>{
  const f=await fixture(),key=await f.ok('/developer/keys','POST',{name:'Own COUNT terminal database-clock expiry',scopes:['products:read','inventory:read','inventory:write']},201),d=await prepare(f,key);
  const keyBefore=one((await pool.query('SELECT expires_at FROM public.api_keys WHERE(tenant_id,id)=($1,$2)',[f.tenant,key.id])).rows);
  // Set the real stored deadline before the writer pins it. No permission result
  // or SQL response is fabricated; the observer only delays returning real SQL.
  await pool.query("UPDATE public.api_keys SET expires_at=clock_timestamp()+interval '15 seconds' WHERE(tenant_id,id)=($1,$2)",[f.tenant,key.id]);
  const baseline=await facts169(),deadline=one(own169(baseline,'api_keys',f.tenant).filter(r=>r.id===key.id)).expires_at;
  const clock=await pool.connect(),original=Client.prototype.query;let terminalObserved=false,nativeObserved=false,expiredObserved=false,batchObserved=false;
  Client.prototype.query=function(this:Client,...args:any[]){
    const reply=(original as any).apply(this,args),sql=typeof args[0]==='string'?args[0]:args[0]?.text;
    if(typeof sql==='string'&&sql.trim()==='SELECT public.catalog_stock_count_terminal_require()'&&reply?.then)
      return reply.then((r:Row)=>{assert.equal(terminalObserved,false,'Exactly one terminal metadata SQL for this managed COUNT transaction');terminalObserved=true;return r;});
    if(terminalObserved&&typeof sql==='string'&&sql.startsWith('SELECT public.catalog_stock_count_access(')&&reply?.then)
      return reply.then(async(r:Row)=>{assert.equal(nativeObserved,false,'One actual terminal native COUNT grant for this source');nativeObserved=true;
        assert.equal(r.rows[0].requirements.admin_only,true);
        assert(r.rows[0].requirements.scopes.includes('inventory:write'),'Real native current grant succeeded, not a fabricated permission');
        const end=Date.now()+20000;while(Date.now()<end){const actual=one((await clock.query('SELECT clock_timestamp()>=$1::timestamptz expired',[deadline])).rows);
          if(actual.expired){expiredObserved=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
        assert.equal(expiredObserved,true,'Database clock, not transaction now() or a fake grant, crossed the pinned real deadline');return r;});
    if(terminalObserved&&typeof sql==='string'&&sql.includes('FROM jsonb_to_recordset($1::jsonb)')&&reply?.then)
      return reply.then((r:Row)=>{batchObserved=true;const own=one(r.rows.filter((a:Row)=>a.actual_key_id===key.id));
        assert.equal(own.alive,false,'The real final DB-clock batch itself, after successful native access, observes key expiry');return r;});
    return reply;
  } as typeof Client.prototype.query;
  try{const response=await f.request(d.path,'POST',d.body,key);assert.equal(terminalObserved,true,'Metadata SQL must actually succeed before the controlled delay');
    assert.equal(nativeObserved,true);assert.equal(expiredObserved,true);assert.equal(batchObserved,true,'An earlier native refusal cannot substitute for the final batch proof');assert.equal(response.statusCode,401,response.body);
    assert.deepEqual(await facts169(),baseline,'Every business/global/session row unchanged; only the predeclared real key deadline exists');
  }finally{Client.prototype.query=original;clock.release();await pool.query('UPDATE public.api_keys SET expires_at=$3::timestamptz WHERE(tenant_id,id)=($1,$2)',[f.tenant,key.id,keyBefore.expires_at]);}
});
