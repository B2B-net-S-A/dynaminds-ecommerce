/** Real pure-module lifecycles + actual source-isolated presence getters/guard.
 * Controlled private maps for db-importing modules are NOT IAM, SQL or Native
 * admission evidence. No database pool, app factory or PG is imported here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer,transformWithOxc} from 'vite';
import path from 'node:path';
const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const R=await vite.ssrLoadModule(path.resolve('server/order-split-transaction.ts'));
const P=await vite.ssrLoadModule(path.resolve('server/pim-dictionaries/runtime.ts'));
const W=await vite.ssrLoadModule(path.resolve('server/wms-lots-transaction.ts'));
const D=await vite.ssrLoadModule(path.resolve('server/dispatch-transaction.ts'));
const M=await vite.ssrLoadModule(path.resolve('server/mirakl-session-authority.ts'));
const {ensure}=await vite.ssrLoadModule(path.resolve('server/errors.ts'));
await vite.close();
const text=file=>readFileSync(new URL('../server/'+file,import.meta.url),'utf8');
const map=()=>new Map([['controlled',{}]]),set=()=>new Set([{}]),array=()=>[{}];
// Independent exhaustive duty shapes: lifecycle/availability/lock-only fields
// are deliberately not used to mark business participation.
const modules=[
 ['pim-dictionaries/runtime.ts','hasPimTransactionDuty','transactions',()=>({available:true,started:false,prepared:true}),[['started',()=>true]]],
 ['mirakl-session-authority.ts','hasMiraklSessionTransactionDuty','transactions',()=>({frames:[],prepared:true,completed:true}),[['frames',array]]],
 ['physical-parcel-wz.ts','hasPhysicalParcelWzTransactionDuty','transactions',()=>({available:true,duty:false,prepared:true}),[['duty',()=>true]]],
 ['inventory-correction.ts','hasInventoryCorrectionTransactionDuty','managed',()=>({duties:[],prepared:true}),[['duties',array]]],
 ['financial-return-completion.ts','hasFinancialReturn162TransactionDuty','transactions',()=>({duties:[],claimed:false}),[['claimed',()=>true],['duties',array]]],
 ['buyer-address.ts','hasBuyerAddressTransactionDuty','txs',()=>({root:'1',start:'now',pid:1,duties:[],createInstallations:new Set()}),[['duties',array],['createInstallations',set]]],
 ['operational-delivery-consumers.ts','hasOperationalDeliveryTransactionDuty','transactions',()=>({duties:[],available:true}),[['duties',array]]],
 ['competitor-observations.ts','hasCompetitorObservationTransactionDuty','transactions',()=>({duties:new Map(),rankings:new Map(),workers:new Map()}),[['duties',map],['rankings',map],['workers',map]]],
 ['allegro-oauth-authority.ts','hasAllegroAuthorityTransactionDuty','registry',()=>({authorities:new Set(),jobPins:new Set(),frozen:true,completed:true}),[['authorities',set],['jobPins',set]]],
 ['wms-lots-transaction.ts','hasWmsTransactionDuty','grants',()=>new Map(),[['map',map]]],
 ['dispatch-transaction.ts','hasDispatchTransactionDuty','grants',()=>new Map(),[['map',map]]],
 ['catalog-stock-control-transaction.ts','hasCatalogStockControlTransactionDuty','contexts',()=>({admissions:map(),actors:new Map(),countTerminals:new Map(),terminalFrozen:true}),[['actors',map],['countTerminals',map]]],
];
const isolated=[];
for(const [file,name,store,empty,participations]of modules){
 const source=text(file),match=source.match(new RegExp('export function '+name+'\\(c:PoolClient\\)\\{return [^;]+;\\}'));
 assert(match,'actual named getter '+file);
 const code=(await transformWithOxc(match[0],'actual-presence-getter.ts')).code.replace(/^export /,'');
 const states=new WeakMap(),get=new Function(store,code+';return '+name+';')(states);
 isolated.push({file,name,states,get,empty,participations});
}
const guardText=text('order-split-composition.ts');
const guardCode=(await transformWithOxc(guardText.replace(/^import .*;$/gm,''),'actual-composition.ts')).code.replace(/^export /gm,'');
function guardWith(overrides={}){
 const ports={ensure,hasOrderSplitTransactionDuty:R.hasOrderSplitTransactionDuty,...Object.fromEntries(isolated.map(r=>[r.name,r.get])),...overrides};
 return new Function(...Object.keys(ports),guardCode+';return assertOrderSplitCompositionInTx;')(...Object.values(ports));
}
const guard=guardWith(),client=()=>({query(){assert.fail('Presence inspection must not query DB');}});
function split(c){R.beginOrderSplitTransaction(c);R.enlistOrderSplitTransaction(c,Object.freeze({controlled_ledger_only:true}),'preview','00000001-1000-4000-8000-000000000001');}

test('all12 actual getters distinguish empty/finished setup from every pending field, isolate clients and survive until real map removal',()=>{
 for(const row of isolated){
  const c=client(),foreign=client();assert.equal(row.get(c),false);
  row.states.set(c,row.empty());assert.equal(row.get(c),false,row.name+' empty setup');
  for(const [field,value]of row.participations){
   const state=row.empty();if(field==='map')row.states.set(c,value());else{state[field]=value();row.states.set(c,state);}
   assert.equal(row.get(c),true,row.name+' '+field);assert.equal(row.get(foreign),false);
   assert.equal(row.get(c),true,'Presence reads neither clear nor consume duties');
   row.states.delete(c);assert.equal(row.get(c),false,'Only owner lifecycle removal clears presence');
  }
 }
});
test('fixed guard refuses every foreign duty before any query, including claimed162, buyer installations and jobPins alone',()=>{
 for(const row of isolated)for(const [field,value]of row.participations){
  const c=client();split(c);const state=row.empty();if(field==='map')row.states.set(c,value());else{state[field]=value();row.states.set(c,state);}
  try{assert.throws(()=>guard(c),e=>e.status===409&&e.message==='Podział i inne operacje biznesowe wymagają odrębnych transakcji',row.name+' '+field);
   assert.equal(R.hasOrderSplitTransactionDuty(c),true,'Refusal does not discard original split custody');assert.equal(row.get(c),true);
  }finally{row.states.delete(c);R.endOrderSplitTransaction(c);}
 }
});
test('guard is neutral without split and allows only empty sibling ledgers with split, never exposing readiness or clearing either duty',()=>{
 const c=client();for(const row of isolated){const [field,value]=row.participations[0],s=row.empty();if(field==='map')row.states.set(c,value());else{s[field]=value();row.states.set(c,s);}}
 assert.equal(guard(c),undefined,'Unrelated old transactions keep their established finalizers');
 for(const row of isolated)row.states.set(c,row.empty());split(c);
 try{assert.equal(guard(c),undefined);assert.equal(R.hasOrderSplitTransactionDuty(c),true);assert.equal(guard(client()),undefined);}
 finally{for(const row of isolated)row.states.delete(c);R.endOrderSplitTransaction(c);}
});
test('real PIM begin/require/end produces refusal and keeps a started duty despite preparation flags',()=>{
 const c=client(),actualGuard=guardWith({hasPimTransactionDuty:P.hasPimTransactionDuty});split(c);P.beginPimTransaction(c,true);
 try{assert.equal(P.hasPimTransactionDuty(c),false);actualGuard(c);P.requirePimTransaction(c);
  assert.equal(P.hasPimTransactionDuty(c),true);assert.throws(()=>actualGuard(c),e=>e.status===409);
 }finally{P.endPimTransaction(c);R.endOrderSplitTransaction(c);}assert.equal(P.hasPimTransactionDuty(c),false);
});
test('real OFF WMS admission is legal lock setup; actual actor enlistment is a foreign business duty until end',async()=>{
 let queries=0;const c={async query(sql){queries++;assert(sql.includes("to_regclass('public.wms_policies')"));return{rows:[{available:false}]};}};
 const actualGuard=guardWith({hasWmsTransactionDuty:W.hasWmsTransactionDuty});split(c);W.beginWmsTransaction(c);
 try{await W.wmsLotsAdmissionInTx(c,{tenantId:'controlled'},'shared');assert.equal(W.hasWmsTransactionDuty(c),false);actualGuard(c);
  W.enlistWmsActorInTx(c,{tenantId:'controlled',userId:'controlled'},{orders:true});assert.equal(W.hasWmsTransactionDuty(c),true);
  assert.throws(()=>actualGuard(c),e=>e.status===409);assert.equal(queries,1,'Presence guard never reacquires locks or queries IAM');
 }finally{W.endWmsTransaction(c);R.endOrderSplitTransaction(c);}assert.equal(W.hasWmsTransactionDuty(c),false);
});
test('real dispatch lifecycle detects frozen grants and real Mirakl enlistment detects a session-duty without external calls',()=>{
 const c=client(),actualGuard=guardWith({hasDispatchTransactionDuty:D.hasDispatchTransactionDuty,hasMiraklSessionTransactionDuty:M.hasMiraklSessionTransactionDuty});
 split(c);D.beginDispatchTransaction(c);M.beginMiraklSessionAuthorityTransaction(c);
 try{actualGuard(c);D.enlistDispatchActorInTx(c,{tenantId:'controlled',userId:'controlled'});D.freezeDispatchActorsForCountInTx(c);
  assert.throws(()=>actualGuard(c),e=>e.status===409);D.endDispatchTransaction(c);actualGuard(c);
  M.enlistMiraklSessionAuthorityInTx(c,{tenantId:'00000001-1000-4000-8000-000000000001',userId:'00000002-1000-4000-8000-000000000001',sessionHash:'a'.repeat(64)},
   {accountSecurityAvailable:false,workspaceMfaPolicyAvailable:false,readOnly:false});
  assert.throws(()=>actualGuard(c),e=>e.status===409);
 }finally{D.endDispatchTransaction(c);M.endMiraklSessionAuthorityTransaction(c);R.endOrderSplitTransaction(c);}
 assert.equal(D.hasDispatchTransactionDuty(c),false);assert.equal(M.hasMiraklSessionTransactionDuty(c),false);
});
test('production guard has only fixed imports and a client argument; no callback list, SQL, credential or readiness result',()=>{
 for(const row of isolated)assert(guardText.includes('import {'+row.name+"} from './"+row.file.replace(/\.ts$/,'')+"';"));
 assert.equal(guard.length,1);assert(!/await |c\.query|valid\s*[:=]|nativeReady\s*[:=]|callbacks?\s*[:=]/.test(guardText));
 assert(guardText.includes('BEFORE any prepare/finalize'));assert(guardText.includes('future coordinated prepare/clock'));
});
