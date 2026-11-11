/** Actual source, controlled transaction/catalogue ports. No PG/app/HTTP.
 * The test-only fixture seeds private cold state; it is not a native cold proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {transformSync} from 'esbuild';

const root=new URL('../',import.meta.url),read=p=>fs.readFileSync(new URL(p,root),'utf8');
const startup=read('shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs');
const from=startup.indexOf('// Installation-only facts:'),to=startup.indexOf('const ordinarySchemaGates=new WeakSet();',from);
assert(from>0&&to>from);
const context=()=>({database:'owned',pid:17,start:'2026-10-18 16:00:00.123456+00',read_only:'on',isolation:'repeatable read',role:'postgres',owner:'postgres',role_setting:'none',tenant:'own',replication:'origin',timezone:'UTC',timeout:'8s'});
function model({credit211=false}={}){
 const api=new Function('assert',`const schemaGenerations=new WeakMap(),activationFailures=new WeakSet(),activationBusy=new WeakSet();
 ${startup.slice(from,to)}
 return {prepareOrderReadInstallation,consumeOrderReadInstallation,recordOrderReadInstallation,clearOrderReadInstallation,
  installationSealSql,ORDER_READ_CONTEXT_SQL,seals:ORDER_READ_INSTALLATION_SEALS,markers:INSTALLATION_MARKERS,
  seed(gate,generation,cold){const state={};ordinaryInstallationGates.set(gate,{state,generation});schemaGenerations.set(state,generation);if(cold)ordinaryOrderReadCuts.set(state,{generation,installation:cold});return state;},
  mutateGeneration(state,generation){schemaGenerations.set(state,generation);},busy(state){activationBusy.add(state);}};`)(assert);
 const generation={generation:'1703',dirty:false,release_sha256:'r'.repeat(64)};
 const seals=credit211?[...api.seals,'return_credit211_metadata']:api.seals;
 const cut={seals:Object.fromEntries(seals.map(n=>[n,{count:1,hashes:['a'.repeat(64)]}])),markers:[...api.markers,...(credit211?['211_return_credit148_acceptance']:[])].sort()};
 const metadata={roles:[['dyna_app',false,true,false,false,false,false,false],['postgres',true,true,true,true,true,true,true]],memberships:[['1','2','3',false,true,true]]};
 const cold={cut:structuredClone(cut),metadata:structuredClone(metadata)},calls=[],ctx=context(),gate={},identity={};
 const state=api.seed(gate,generation,cold);
 const client={async query(sql){calls.push(sql);
  if(sql===api.ORDER_READ_CONTEXT_SQL)return{rows:[structuredClone(ctx)]};
  if(sql==='SET LOCAL ROLE NONE'){ctx.role='postgres';ctx.role_setting='none';return{rows:[]};}
  if(sql==='SET LOCAL ROLE dyna_app'){ctx.role='dyna_app';ctx.role_setting='dyna_app';return{rows:[]};}
  if(sql.startsWith('WITH s0 AS MATERIALIZED')){assert(!sql.includes('FOR SHARE'));return{rows:[{cut:structuredClone(cut)}]};}
  if(sql.startsWith("SELECT jsonb_build_object('roles'"))return{rows:[{metadata:structuredClone(metadata)}]};
  assert.fail('Unexpected controlled SQL');}};
 const enter=async()=>{ctx.role='postgres';ctx.role_setting='none';await api.recordOrderReadInstallation(client,gate);ctx.role='dyna_app';ctx.role_setting='dyna_app';};
 return{api,generation,cut,metadata,cold,calls,ctx,gate,identity,state,client,enter,
  prepare:()=>api.prepareOrderReadInstallation(client,gate,'own',identity),
  consume:p=>api.consumeOrderReadInstallation(client,gate,'own',identity,p)};
}

test('cold admission surrounds the original full buyer guard and commits before publishing the separate cut',()=>{
 const a=startup.indexOf('readInstallation=await readInstallationCut(owner,true,ORDER_READ_INSTALLATION_SEALS);');
 const b=startup.indexOf("SELECT public.buyer_address_available() AS valid",a);
 const c=startup.indexOf("ordinary-order-read-closing-cold-cut",b),commit=startup.indexOf("await owner.query('COMMIT');committed=true;",c);
 const published=startup.indexOf('ordinaryOrderReadCuts.set(state',commit);
 assert(a>0&&b>a&&c>b&&commit>c&&published>commit);
 const m=model(),sql=m.api.installationSealSql(false,m.api.seals);
 assert.equal(m.api.seals.length,15);assert.equal(new Set(m.api.seals).size,15);
 assert.deepEqual(m.api.seals.slice(-2),['order_merge_delivery209_manifest','order_merge_delivery209_projection_basis']);
 assert.equal(m.api.markers.length,3);assert(sql.includes("sha256(convert_to(to_jsonb(t)::text,'UTF8'))"));
 for(const n of m.api.seals)assert(sql.includes(`FROM public.${n} t`));
 assert(!m.api.ORDER_READ_CONTEXT_SQL.includes('pg_current_xact_id'));assert(!sql.includes('FOR SHARE'));
 assert(m.api.installationSealSql(true,m.api.seals).includes('FOR SHARE'));
});

test('one RRRO fact compares all full rows and roles and is consumed once in the same native context',async()=>{
 const m=model();await m.enter();const p=await m.prepare();assert(p&&Object.isFrozen(p));
 assert.equal(m.calls.filter(s=>s.startsWith('WITH s0')).length,1);assert.equal(m.ctx.role,'dyna_app');
 await m.consume(p);await assert.rejects(()=>m.consume(p),/private-one-use-fact/);
 assert(m.calls.every(s=>!s.includes('pg_current_xact_id')));
});

test('foreign facts, clients, tenants, identities and gate objects cannot consume a proof',async()=>{
 for(const kind of ['fake','client','tenant','identity','gate']){
  const m=model();await m.enter();const p=await m.prepare();
  await assert.rejects(()=>m.api.consumeOrderReadInstallation(kind==='client'?{}:m.client,kind==='gate'?{}:m.gate,
   kind==='tenant'?'foreign':'own',kind==='identity'?{}:m.identity,kind==='fake'?{}:p),/private-one-use-fact/);
  await m.consume(p);
 }
});

test('each seal including owner-replica-mutated209 data, all markers, roles and memberships must match the cold source',async()=>{
 const names=model().api.seals;
 for(const mutate of [
  ...names.map(n=>m=>{m.cut.seals[n].hashes[0]='b'.repeat(64);}),
  m=>{m.cut.seals[names[0]].count=2;},m=>{m.cut.markers.pop();},m=>{m.cut.markers.push('unexpected');},
  m=>{m.metadata.roles[0][2]=false;},m=>{m.metadata.memberships[0][3]=true;},m=>{m.metadata.memberships=[];},
 ]){const m=model();await m.enter();mutate(m);await assert.rejects(()=>m.prepare());assert.equal(m.ctx.role,'dyna_app');}
});

test('the full generation and committed cold proof are mandatory rather than a caller readiness flag',async()=>{
 const m=model();await m.enter();m.api.mutateGeneration(m.state,{...m.generation,dirty:true});await assert.rejects(()=>m.prepare(),/approved-generation/);
 const n=model();n.api.seed(n.gate,n.generation,undefined);await n.enter();await assert.rejects(()=>n.prepare(),/committed-cold-fact/);
 const b=model();await b.enter();b.api.busy(b.state);await assert.rejects(()=>b.prepare(),/startup-unavailable/);
});

test('a cold211 installation keeps its full seal and migration marker fresh in ordinary order reads',async()=>{
 const good=model({credit211:true});await good.enter();await good.consume(await good.prepare());
 const sql=good.calls.find(s=>s.startsWith('WITH s0'));
 assert(sql.includes('FROM public.return_credit211_metadata t'));
 assert(sql.includes("'211_return_credit148_acceptance'"));assert(!sql.includes('FOR SHARE'));
 for(const change of [m=>{m.cut.seals.return_credit211_metadata.hashes[0]='b'.repeat(64);},
  m=>{delete m.cut.seals.return_credit211_metadata;},m=>{m.cut.markers.pop();}]){
  const m=model({credit211:true});await m.enter();change(m);await assert.rejects(()=>m.prepare());
  assert.equal(m.ctx.role,'dyna_app');
 }
});

test('proof consumption rejects changed PID, exact transaction start, role, tenant, isolation and safety settings; failure consumes it',async()=>{
 for(const [key,value]of Object.entries({pid:18,start:'2026-10-18 16:00:00.123457+00',read_only:'off',isolation:'read committed',role:'postgres',owner:'other',role_setting:'none',tenant:'other',replication:'replica',timezone:'Europe/Warsaw',timeout:'9s'})){
  const m=model();await m.enter();const p=await m.prepare();m.ctx[key]=value;await assert.rejects(()=>m.consume(p));
  Object.assign(m.ctx,context(),{role:'dyna_app',role_setting:'dyna_app'});await assert.rejects(()=>m.consume(p),/private-one-use-fact/);
 }
});

test('reentry and end-of-lease clear unused authority; RW and unrelated RO contexts keep the legacy path',async()=>{
 const m=model();await m.enter();const p=await m.prepare();await m.enter();await assert.rejects(()=>m.consume(p),/private-one-use-fact/);
 const q=await m.prepare();m.api.clearOrderReadInstallation(m.client);await assert.rejects(()=>m.consume(q),/private-one-use-fact/);
 assert.equal(await m.prepare(),undefined);
 for(const change of [{read_only:'off'},{isolation:'read committed'}]){
  const n=model();Object.assign(n.ctx,change);await n.enter();assert.equal(await n.prepare(),undefined);
 }
});

function databaseModel(){
 const source=read('server/db.ts'),a=source.indexOf('export async function tenantReadTx<'),b=source.indexOf('/** Lookup-only source provenance.',a);
 assert(a>0&&b>a);const code=transformSync(source.slice(a,b),{loader:'ts',format:'cjs',target:'node22'}).code;
 const statements=[],calls=[],client={async query(s){statements.push(s);return{rows:[]};},release(){calls.push('release');}};
 const proofs=new WeakSet();const gate={async reserve(c){assert.equal(c,client);calls.push('reserve');return{async enter(){calls.push('enter');},async close(){calls.push('close');}};},
  async prepareReadInstallation(c,t,i){assert.equal(c,client);assert.equal(t,'own');assert(i&&typeof i==='object');const p={};proofs.add(p);return p;},
  async consumeReadInstallation(c,t,i,p){assert.equal(c,client);assert.equal(t,'own');assert(proofs.has(p));proofs.delete(p);calls.push('consume');}};
 const module={exports:{}};new Function('module','exports','pool','ordinarySchemaGate','assertOwnedOrdinarySchemaTransactionGate','assert',code)(module,module.exports,{connect:async()=>client},gate,g=>assert.equal(g,gate),assert);
 return{...module.exports,client,calls,statements};
}

test('actual tenantReadTx alone registers the pool client, and COMMIT/ROLLBACK/finally revoke every unused proof',async()=>{
 for(const fail of [false,true]){
  const m=databaseModel();assert.equal(await m.prepareOrderReadInstallationInTx(m.client,'own'),undefined);let held;
  const work=m.tenantReadTx('own',async c=>{
   assert.equal(c,m.client);assert.equal(await m.prepareOrderReadInstallationInTx({},'own'),undefined);
   assert.equal(await m.prepareOrderReadInstallationInTx(c,'foreign'),undefined);held=await m.prepareOrderReadInstallationInTx(c,'own');
   if(fail)throw Error('controlled business failure');return 'same result';
  });
  if(fail)await assert.rejects(()=>work,/business failure/);else assert.equal(await work,'same result');
  await assert.rejects(()=>m.consumeOrderReadInstallationInTx(m.client,'own',held),/current-private-proof/);
  assert(m.statements.includes(fail?'ROLLBACK':'COMMIT'));assert.deepEqual(m.calls,['reserve','enter','close','release']);
  assert(m.statements.includes('BEGIN ISOLATION LEVEL REPEATABLE READ'));assert(m.statements.includes('SET TRANSACTION READ ONLY'));
 }
});

test('actual db proof rejects replay within a transaction and cannot be reused on the next pooled transaction',async()=>{
 const m=databaseModel();let prior;
 await m.tenantReadTx('own',async c=>{prior=await m.prepareOrderReadInstallationInTx(c,'own');await m.consumeOrderReadInstallationInTx(c,'own',prior);await assert.rejects(()=>m.consumeOrderReadInstallationInTx(c,'own',prior));});
 await m.tenantReadTx('own',async c=>{await assert.rejects(()=>m.consumeOrderReadInstallationInTx(c,'own',prior));});
 assert.equal(m.calls.filter(s=>s==='consume').length,1);
});

test('dedicated buyer adapter uses the same frame reader, while missing managed proof invokes the complete original fallback',async()=>{
 const source=read('server/buyer-address.ts'),a=source.indexOf('export async function effectiveDeliveryForOrderReadInTx('),b=source.indexOf('/** Only the private createOrder',a);
 assert(a>0&&b>a);const code=transformSync(source.slice(a,b),{loader:'ts',format:'cjs',target:'node22'}).code;
 for(const present of [false,true]){
  const calls=[],proof={},module={exports:{}};
  new Function('module','exports','prepareOrderReadInstallationInTx','consumeOrderReadInstallationInTx','effectiveDeliveryInTx','readEffectiveDeliveryInTx',code)(module,module.exports,
   async()=>{calls.push('prepare');return present?proof:undefined;},async(_c,_t,p)=>{assert.equal(p,proof);calls.push('consume');},
   async()=>{calls.push('full guard + frame');return{delivery:'same'};},async()=>{calls.push('frame');return{delivery:'same'};});
  assert.deepEqual(await module.exports.effectiveDeliveryForOrderReadInTx({},'own','order','key'),{delivery:'same'});
  assert.deepEqual(calls,present?['prepare','consume','frame']:['prepare','full guard + frame']);
 }
 const domain=read('server/domain.ts');assert(domain.includes('getOrder(c:PoolClient,id:string){return hydrateOrder(c,id,undefined,true);}'));
 // The createOrder proof still explicitly rejects RO; no weakened RW authority.
 assert(source.includes("if(ro==='on')return undefined;"));assert(source.includes("transaction_read_only;\n ensure(ro==='on'||ro==='off'"));
});
