/** Real small control-DB tests only with explicit local private locator. No OMS migrations,
 * account calls, role creation or edits to the database named by that locator. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createMiraklReadPostgresRepository,initializeMiraklReadPostgres,verifyMiraklReadPostgres,MIRAKL_CONTROL_DATABASE} from '../server/mirakl-read-postgres';
import {createMiraklChannelReader,MiraklReadDeferred,type MiraklAccountCache} from '../server/mirakl-channel';
import {Problem} from '../server/errors';
const locator=process.env.DYNA_MIRAKL_CONTROL_TEST_PRIVATE;
const options={skip:!locator};
const dbName='dynaminds_connector_state_test_'+Date.now();
let admin:Pool,pool:Pool,config:string;
const pools:Pool[]=[];
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const key=(v:string)=>digest(dbName+v);
const account={shop_id:2000,shop_name:'Controlled account',currency_iso_code:'PLN',shop_state:'OPEN',model:'MARKETPLACE'};
const entry=(accountKey:string):MiraklAccountCache=>({schema:'mirakl-a01-cache/v1',accountKey,observedAt:1,expiresAt:2,account});
const now=()=>Date.now();
const reserve=(operation:'A01'|'OR11'|'OF21',budgetKey:string,accountKey=key('account'))=>{
 const time=now();return {operation,budgetKey,accountKey,now:time,notBefore:time+(operation==='A01'?86400000:operation==='OR11'?900000:0)};
};
before(async()=>{
 if(!locator)return;
 const value=JSON.parse(await readFile(locator,'utf8'));const u=new URL(value.databaseUrl);
 assert(['postgres:','postgresql:'].includes(u.protocol));assert(['127.0.0.1','localhost'].includes(u.hostname));
 assert.equal(u.port,'57081');assert.equal(u.username,'postgres');assert.equal(u.search,'');assert.equal(u.hash,'');
 assert(MIRAKL_CONTROL_DATABASE.test(dbName));
 u.pathname='/postgres';admin=new Pool({connectionString:u.href,max:2});
 const role=(await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='dyna_app'")).rows[0];
 assert(role&&!role.rolsuper&&!role.rolbypassrls,'Existing restricted dyna_app role required; no role mutation allowed');
 await admin.query(`CREATE DATABASE "${dbName}"`);
 u.pathname='/'+dbName;config=u.href;pool=new Pool({connectionString:config,max:6});
 await initializeMiraklReadPostgres(pool);
});
after(async()=>{
 for(const p of pools)await p.end();if(pool)await pool.end();
 if(admin){if(MIRAKL_CONTROL_DATABASE.test(dbName))await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);await admin.end();}
});

test('inert factory and actual database boundary; fresh owner initialization never replaces schema',options,async()=>{
 const inert=createMiraklReadPostgresRepository({connect:async()=>{throw new Error('private-secret');}} as any);
 await assert.rejects(inert.readAccount(key('x')),e=>e instanceof Problem&&!e.message.includes('private-secret'));
 await assert.rejects(createMiraklReadPostgresRepository(admin).readAccount(key('x')),e=>e instanceof Problem&&e.status===422);
 await assert.rejects(initializeMiraklReadPostgres(admin),e=>e instanceof Problem&&e.status===422);
 assert.equal((await admin.query("SELECT to_regnamespace('mirakl_control') schema")).rows[0].schema,null);
 await assert.rejects(initializeMiraklReadPostgres(pool));
 assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='mirakl_control'")).rows[0].n,3);
});

test('real dyna_app runtime has explicit read/insert/update, no DELETE or schema CREATE and no PUBLIC grants',options,async()=>{
 const p=await pool.connect();try{await p.query('BEGIN');await p.query('SET LOCAL ROLE dyna_app');
  assert.equal((await p.query('SELECT current_user name')).rows[0].name,'dyna_app');
  const r=(await p.query(`SELECT has_table_privilege(current_user,'mirakl_control.budgets','SELECT') s,
    has_table_privilege(current_user,'mirakl_control.budgets','INSERT') i,
    has_table_privilege(current_user,'mirakl_control.budgets','UPDATE') u,
    has_table_privilege(current_user,'mirakl_control.budgets','DELETE') d,
    has_schema_privilege(current_user,'mirakl_control','CREATE') c`)).rows[0];
  assert.deepEqual(r,{s:true,i:true,u:true,d:false,c:false});
  await assert.rejects(p.query('DELETE FROM mirakl_control.budgets'),(e:any)=>e.code==='42501');
 }finally{await p.query('ROLLBACK');p.release();}
 const grants=(await pool.query(`SELECT count(*)::int n FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace,
   LATERAL aclexplode(t.relacl) a WHERE n.nspname='mirakl_control' AND a.grantee=0`)).rows[0];assert.equal(grants.n,0);
});

test('readiness is read-only, requires existing exact tables and refuses widened runtime ACLs',options,async()=>{
 await verifyMiraklReadPostgres(pool);
 const before=(await pool.query('SELECT count(*)::int n FROM mirakl_control.claims')).rows[0].n;
 await assert.rejects(verifyMiraklReadPostgres(admin),e=>e instanceof Problem&&e.status===422);
 await pool.query('GRANT DELETE ON mirakl_control.budgets TO dyna_app');
 try{await assert.rejects(verifyMiraklReadPostgres(pool),e=>e instanceof Problem&&e.status===503);}
 finally{await pool.query('REVOKE DELETE ON mirakl_control.budgets FROM dyna_app');}
 await pool.query('GRANT MAINTAIN ON mirakl_control.budgets TO dyna_app');
 try{await assert.rejects(verifyMiraklReadPostgres(pool),e=>e instanceof Problem&&e.status===503);}
 finally{await pool.query('REVOKE MAINTAIN ON mirakl_control.budgets FROM dyna_app');}
 await verifyMiraklReadPostgres(pool);
 assert.equal((await pool.query('SELECT count(*)::int n FROM mirakl_control.claims')).rows[0].n,before);
});

test('readiness refuses missing atomic budget, claim and cache identity keys despite unchanged ACL/projection',options,async()=>{
 // Only this freshly created disposable control DB is altered, never the locator DB.
 const cases=[
  {drop:[
   'ALTER TABLE mirakl_control.claims DROP CONSTRAINT claims_budget_key_operation_fkey',
   'ALTER TABLE mirakl_control.budgets DROP CONSTRAINT budgets_pkey',
   'ALTER TABLE mirakl_control.budgets DROP CONSTRAINT budgets_budget_key_operation_key'],
   restore:[
    'ALTER TABLE mirakl_control.budgets ADD PRIMARY KEY(budget_key)',
    'ALTER TABLE mirakl_control.budgets ADD UNIQUE(budget_key,operation)',
    'ALTER TABLE mirakl_control.claims ADD FOREIGN KEY(budget_key,operation) REFERENCES mirakl_control.budgets(budget_key,operation)']},
  {drop:[
   'ALTER TABLE mirakl_control.account_cache DROP CONSTRAINT account_cache_claim_id_fkey',
   'ALTER TABLE mirakl_control.claims DROP CONSTRAINT claims_pkey'],
   restore:[
    'ALTER TABLE mirakl_control.claims ADD PRIMARY KEY(id)',
    'ALTER TABLE mirakl_control.account_cache ADD FOREIGN KEY(claim_id) REFERENCES mirakl_control.claims(id)']},
  {drop:['ALTER TABLE mirakl_control.account_cache DROP CONSTRAINT account_cache_pkey'],
   restore:['ALTER TABLE mirakl_control.account_cache ADD PRIMARY KEY(account_key)']},
 ];
 for(const scenario of cases){
  await pool.query('BEGIN;'+scenario.drop.join(';')+';COMMIT');
  try{await assert.rejects(verifyMiraklReadPostgres(pool),e=>e instanceof Problem&&e.status===503);}
  finally{await pool.query('BEGIN;'+scenario.restore.join(';')+';COMMIT');}
  await verifyMiraklReadPostgres(pool);
 }
});

test('atomic global reservation across separate pools/restarts admits exactly one A01 and keeps failed-attempt fence',options,async()=>{
 const other=new Pool({connectionString:config,max:4});pools.push(other);
 const sqlStates:string[]=[];
 const observed=(actual:Pool)=>({connect:async()=>{const c=await actual.connect();return new Proxy(c,{get(target,property){
   if(property==='query')return async(...args:any[])=>{try{return await (target.query as any)(...args);}catch(e:any){sqlStates.push(/^[0-9A-Z]{5}$/.test(e.code)?e.code:'REDACTED');throw e;}};
   const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
 }});}});
 const repos=[createMiraklReadPostgresRepository(observed(pool)),createMiraklReadPostgresRepository(observed(other))];
 const q=reserve('A01',key('race'));
 const settled=await Promise.allSettled(Array.from({length:12},(_,i)=>repos[i%2].reserveRead({...q,accountKey:key('tenant-'+i)})));
 assert.equal(settled.filter(x=>x.status==='rejected').length,0,'Controlled SQLSTATEs: '+sqlStates.join(','));
 const results=settled.map(x=>{assert(x.status==='fulfilled');return x.value;});
 assert.equal(results.filter(r=>'claimId'in r).length,1);assert.equal(results.filter(r=>'retryAt'in r).length,11);
 const again=await createMiraklReadPostgresRepository(other).reserveRead(q);assert('retryAt'in again);
 if('retryAt'in again)assert(again.retryAt-q.now>=86390000);
 assert.equal((await pool.query('SELECT count(*)::int n FROM mirakl_control.claims WHERE budget_key=$1',[q.budgetKey])).rows[0].n,1);
});

test('DB clock ignores caller absolute time; operation/duration mismatches cannot mutate a budget',options,async()=>{
 const repo=createMiraklReadPostgresRepository(pool),q=reserve('OR11',key('clock'));
 const before=Date.now();await repo.reserveRead({...q,now:1,notBefore:900001});
 const row=(await pool.query('SELECT extract(epoch FROM not_before)*1000 until FROM mirakl_control.budgets WHERE budget_key=$1',[q.budgetKey])).rows[0];
 assert(Number(row.until)>=before+899000&&Number(row.until)<Date.now()+901000);
 await assert.rejects(repo.reserveRead({...q,notBefore:q.now+899999}),e=>e instanceof Problem&&e.status===422);
 await assert.rejects(repo.reserveRead({...q,operation:'A01',notBefore:q.now+86400000}),e=>e instanceof Problem&&e.status===409);
});

test('late old-claim Retry-After extends the current slot and shorter/deceptive cooldown never reduces it',options,async()=>{
 const repo=createMiraklReadPostgresRepository(pool),q=reserve('OF21',key('defer'));
 const a=await repo.reserveRead(q),b=await repo.reserveRead(q);assert('claimId'in a&&'claimId'in b);
 if(!('claimId'in a&&'claimId'in b))return;
 const t=now();await repo.deferRead({claimId:b.claimId,budgetKey:q.budgetKey,operation:'OF21',now:t,notBefore:t+2000});
 await repo.deferRead({claimId:a.claimId,budgetKey:q.budgetKey,operation:'OF21',now:1,notBefore:1800001});
 const until=Number((await pool.query('SELECT extract(epoch FROM not_before)*1000 until FROM mirakl_control.budgets WHERE budget_key=$1',[q.budgetKey])).rows[0].until);
 assert(until>=Date.now()+1799000);
 await repo.deferRead({claimId:b.claimId,budgetKey:q.budgetKey,operation:'OF21',now:1,notBefore:1001});
 assert.equal(Number((await pool.query('SELECT extract(epoch FROM not_before)*1000 until FROM mirakl_control.budgets WHERE budget_key=$1',[q.budgetKey])).rows[0].until),until);
 for(const patch of [{claimId:randomUUID()},{budgetKey:key('foreign')},{operation:'A01' as const}])
  await assert.rejects(repo.deferRead({claimId:a.claimId,budgetKey:q.budgetKey,operation:'OF21',now:t,notBefore:t+1000,...patch}));
});

test('only matching A01 claim writes cache; DB claim time fixes TTL, repeated/older writes cannot extend or replace',options,async()=>{
 const repo=createMiraklReadPostgresRepository(pool),accountKey=key('cache'),q=reserve('A01',key('cache-budget'),accountKey);
 const first=await repo.reserveRead(q);assert('claimId'in first);if(!('claimId'in first))return;
 // Owner-only simulation of an earlier reservation time in this disposable control DB.
 await pool.query("UPDATE mirakl_control.claims SET created_at=date_trunc('milliseconds',clock_timestamp())-interval '2 hours' WHERE id=$1",[first.claimId]);
 await repo.storeAccount({claimId:first.claimId,entry:entry(accountKey)});
 const old=await repo.readAccount(accountKey);assert(old);assert(old.observedAt>Date.now()-7201000&&old.observedAt<Date.now()-7199000);
 assert.equal(old.expiresAt-old.observedAt,86400000);
 await repo.storeAccount({claimId:first.claimId,entry:{...entry(accountKey),observedAt:Date.now(),expiresAt:Date.now()+86400000}});
 assert.deepEqual(await repo.readAccount(accountKey),old);
 await assert.rejects(repo.storeAccount({claimId:first.claimId,entry:{...entry(accountKey),account:{...account,shop_name:'different'}}}));
 await assert.rejects(repo.storeAccount({claimId:first.claimId,entry:entry(key('foreign-account'))}));
 const of=await repo.reserveRead(reserve('OF21',key('not-a01'),accountKey));assert('claimId'in of);
 if('claimId'in of)await assert.rejects(repo.storeAccount({claimId:of.claimId,entry:entry(accountKey)}));
 // A second real A01 slot is permitted only after owner advances the disposable budget.
 await pool.query("UPDATE mirakl_control.budgets SET not_before='epoch' WHERE budget_key=$1",[q.budgetKey]);
 const second=await repo.reserveRead(q);assert('claimId'in second);if(!('claimId'in second))return;
 await repo.storeAccount({claimId:second.claimId,entry:{...entry(accountKey),account:{...account,shop_name:'New result'}}});
 const latest=await repo.readAccount(accountKey);assert.equal(latest?.account.shop_name,'New result');
 await repo.storeAccount({claimId:first.claimId,entry:entry(accountKey)});assert.deepEqual(await repo.readAccount(accountKey),latest);
});

test('real repository and channel reader persist A01 identity across reconstruction without account calls or extra A01 HTTP',options,async()=>{
 let calls=0;const selected={instance_url:'https://pg-controlled.mirakl.net',shop_id:'2000',currency:'PLN'};
 const make=()=>createMiraklChannelReader({channel:{id:'c',tenant_id:'t',provider:'mirakl',mode:'live',settings:selected,credentials:'encrypted'},
  credentials:{api_key:'CONTROLLED_NOT_REAL'},repository:createMiraklReadPostgresRepository(pool),guard:async()=>{},
  transport:async()=>{calls++;return new Response(JSON.stringify(account),{headers:{'content-type':'application/json'}});}});
 await make().account();await make().account();assert.equal(calls,1);
 const other=createMiraklChannelReader({channel:{id:'c2',tenant_id:'t2',provider:'mirakl',mode:'live',settings:{...selected,shop_id:'2001'},credentials:'encrypted2'},
  credentials:{api_key:'CONTROLLED_NOT_REAL_2'},repository:createMiraklReadPostgresRepository(pool),guard:async()=>{},
  transport:async()=>{assert.fail('Global instance budget must deny a second account');}});
 await assert.rejects(other.account(),e=>e instanceof MiraklReadDeferred);
});
