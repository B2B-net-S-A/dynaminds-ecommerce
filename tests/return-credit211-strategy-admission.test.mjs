/** Actual strategy body, controlled SQL ports only; not PostgreSQL acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {transformSync} from 'esbuild';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor={tenantId:id(1),userId:id(2)},order=id(3),returns=[{return_id:id(4),receipt_id:id(5)},{return_id:id(6),receipt_id:id(7)}];
const source=fs.readFileSync(new URL('../server/return-credit206-service.ts',import.meta.url),'utf8');
const code=transformSync(source.slice(source.indexOf('export async function returnCredit206Strategy(')),{loader:'ts',format:'cjs',target:'es2022'}).code;
const names=['metadata_fn','acceptance_fn','history_fn','source_fn','parent_fn','metadata_table','parent_table'];
const footprint=present=>({partial:present,...Object.fromEntries(names.map(k=>[k,present?'installed':null]))});
const accepted=row=>({family:'destinations148',protocol:'destinations_v1',tenant_id:actor.tenantId,order_id:order,return_id:row.return_id,id:row.receipt_id,receipt_sequence:1,evidence_hash:'a'.repeat(64),financial:{financial_hash:'b'.repeat(64)}});

function harness({present=true,module=footprint(present),seals=[true,true],missing=[returns[0]],history={destination:true,catalog_receipt_missing:true},available=true,authenticated=true,own=true,resolve=accepted,metadataError=null}={}){
 const calls=[],frames=new WeakMap();if(authenticated)frames.set(actor,'actual-request-frame');let ownerActive=false,sealReads=0,availableReads=0;
 const ensure=(ok,status,message)=>{if(!ok)throw Object.assign(new Error(message),{status});};
 const c={async query(sql,args){
  calls.push({sql,args});assert.match(sql,/^\s*SELECT\b/,'Strategy never performs fixture, parent or financial writes');
  if(sql.includes('set_config')){assert.deepEqual(args,['actual-request-frame']);return{rows:[{}]};}
  if(sql.includes('local_consumer_credit_terminal')){assert.deepEqual(args,[actor.userId,null]);return{rows:[{}]};}
  if(sql==='SELECT id FROM orders WHERE id=$1'){assert.deepEqual(args,[order]);return{rows:own?[{id:order}]:[],rowCount:own?1:0};}
  assert(ownerActive,'All physical/module reads use the actual strategy owner port');
  if(sql.includes("to_regprocedure('public.return_credit211_metadata_valid()')")){assert.equal(args,undefined);return{rows:[module]};}
  if(sql==='SELECT public.return_credit211_metadata_valid() valid'){if(metadataError)throw metadataError;return{rows:[{valid:seals[sealReads++]}]};}
  if(sql.startsWith('SELECT da.return_id,da.receipt_id FROM return_destination_admissions')){assert.deepEqual(args,[actor.tenantId,order]);return{rows:missing};}
  if(sql==='SELECT public.return_credit211_acceptance($1,$2) acceptance'){
   assert.equal(args[0],order);const row=missing.find(x=>x.return_id===args[1]);assert(row);return{rows:[{acceptance:resolve(row)}]};
  }
  assert(sql.includes('AS catalog_receipt_missing'));assert.deepEqual(args,[actor.tenantId,order]);return{rows:[history]};
 }};
 const moduleBox={exports:{}};
 const build=new Function('module','exports','creditUuid','frames','ensure','returnCredit206Available','tenantTx','owner',code+';return module.exports.returnCredit206Strategy;');
 const run=build(moduleBox,moduleBox.exports,{parse(value){assert.equal(value,order);return value;}},frames,ensure,async()=>{availableReads++;return available;},async(tenant,work)=>{assert.equal(tenant,actor.tenantId);return work(c);},async(client,a,work)=>{assert.equal(client,c);assert.equal(a,actor);assert.equal(ownerActive,false);ownerActive=true;try{return await work();}finally{ownerActive=false;}});
 return{run:()=>run(actor,order),calls,get sealReads(){return sealReads;},get availableReads(){return availableReads;}};
}

test('actual211 strategy enables genuine native148 only after complete module, both seals and all real resolvers',async()=>{
 const h=harness({missing:returns});assert.deepEqual(await h.run(),{order_id:order,strategy:'destinations',available:true});
 assert.equal(h.availableReads,1);assert.equal(h.sealReads,2);assert.deepEqual(h.calls.filter(x=>x.sql.includes('return_credit211_acceptance($1,$2)')).map(x=>x.args),returns.map(x=>[order,x.return_id]));
 assert.equal(h.calls.filter(x=>x.sql.includes('local_consumer_credit_terminal')).length,2);
 assert.equal(h.calls.some(x=>/FROM return_credit211_acceptances\b/.test(x.sql)),false,'Issue-only parent rows cannot be used as prior business acceptance');
 const missing=h.calls.find(x=>x.sql.startsWith('SELECT da.return_id')).sql;
 assert.match(missing,/\(da.tenant_id,da.order_id\)=\(\$1,\$2\)/);assert.match(missing,/\(r.tenant_id,r.order_id,r.return_id,r.assistant_receipt_id\)=\s*\(da.tenant_id,da.order_id,da.return_id,da.receipt_id\)/);assert.match(missing,/LIMIT 1001/);
});

test('actual211 strategy preserves clean absence and existing strict169/legacy branches',async t=>{
 await t.test('absent211 retains missing catalog receipt explanation',async()=>{const h=harness({present:false});assert.deepEqual(await h.run(),{order_id:order,strategy:'destinations',available:false,unavailable_reason:'catalog_receipt_required'});assert.equal(h.sealReads,0);assert.equal(h.calls.some(x=>x.sql.includes('return_credit211_acceptance($1,$2)')),false);});
 for(const [name,destination,expected]of [['strict169',true,{strategy:'destinations',available:true}],['legacy',false,{strategy:'legacy',available:true}]])await t.test(name,async()=>{const h=harness({history:{destination,catalog_receipt_missing:false}});assert.deepEqual(await h.run(),{order_id:order,...expected});assert.equal(h.calls.some(x=>x.sql.includes('return_credit211')),false);});
});

test('actual211 strategy refuses partial footprint, parent unavailability and any missing or changed seal',async t=>{
 for(const [name,options]of [
  ['partial named object',{module:{...footprint(false),partial:true}}],
  ['wrong overload or missing resolver',{module:{...footprint(true),acceptance_fn:null}}],
  ['missing metadata relation',{module:{...footprint(true),metadata_table:null}}],
  ['malformed partial state',{module:{...footprint(false),partial:null}}],
  ['206 parent not available',{available:false}],
  ['unsealed metadata',{seals:[false]}],
  ['NULL metadata result',{seals:[null]}],
  ['seal regressed after all resolvers',{seals:[true,false]}],
  ['metadata error',{metadataError:Object.assign(new Error('controlled timeout'),{code:'57014'})}],
 ])await t.test(name,async()=>{const h=harness(options);await assert.rejects(h.run(),e=>e.status===503);});
});

test('actual211 strategy rejects forged identities and preserves partial169 resolver refusal',async t=>{
 const changes=[['wrong family',{family:'catalog169'}],['wrong protocol',{protocol:'rma'}],['foreign tenant',{tenant_id:id(90)}],['wrong order',{order_id:id(91)}],['wrong return',{return_id:id(92)}],['wrong receipt',{id:id(93)}],['missing evidence',{evidence_hash:null}],['missing financial hash',{financial:{}}],['invalid sequence',{receipt_sequence:0}]];
 for(const [name,change]of changes)await t.test(name,async()=>{await assert.rejects(harness({resolve:row=>({...accepted(row),...change})}).run(),e=>e.status===503);});
 await t.test('one partial169 in a mixed batch cannot use148 instead',async()=>{const h=harness({missing:returns,resolve:row=>{if(row===returns[1])throw Object.assign(new Error('211 partial or foreign169 cannot fall back to148'),{code:'23514'});return accepted(row);}});await assert.rejects(h.run(),e=>e.status===503);assert.equal(h.calls.filter(x=>x.sql.includes('return_credit211_acceptance($1,$2)')).length,2);});
});

test('actual211 strategy keeps identity/tenant gates and complete collection bounds',async t=>{
 await t.test('unauthenticated request performs no query',async()=>{const h=harness({authenticated:false});await assert.rejects(h.run(),e=>e.status===401);assert.equal(h.calls.length,0);assert.equal(h.availableReads,0);});
 await t.test('foreign order never inspects211',async()=>{const h=harness({own:false});await assert.rejects(h.run(),e=>e.status===404);assert.equal(h.calls.some(x=>x.sql.includes('return_credit211')),false);});
 for(const [name,missing]of [['empty collection',[]],['truncated collection',Array.from({length:1001},()=>returns[0])]])await t.test(name,async()=>{const h=harness({missing});await assert.rejects(h.run(),e=>e.status===503);assert.equal(h.calls.some(x=>x.sql.includes('return_credit211_acceptance($1,$2)')),false);});
 await t.test('inconsistent history cannot become legacy',async()=>{await assert.rejects(harness({history:{destination:false,catalog_receipt_missing:true}}).run(),e=>e.status===503);});
});
