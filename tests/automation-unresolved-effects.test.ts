import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';
import {ensure,Problem} from '../server/errors';
const require=createRequire(import.meta.url);
// Actual source, with no application/config/pool/worker/provider construction.
function load(name:string,ports:Record<string,any>={}){
 const code=transformSync(readFileSync(new URL('../server/'+name+'.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code,m={exports:{}};
 new Function('module','require',code)(m,(key:string)=>{if(key==='./smtp')return{localSmtpPort:()=>assert.fail('No SMTP policy or transport in read-only reconciliation controls')};if(key==='./errors')return{ensure,Problem};if(key in ports)return ports[key];if(key.startsWith('node:'))return require(key);throw Error('Forbidden module '+key);});return m.exports as any;
}
const actual=load('automation-unresolved-effects'),id=(n:number)=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`,tenant=id(1),rule=id(2);
function row(n:number,stock=true){return{page_id:id(n),type_rank:stock?0:1,created_at:'2026-10-18T01:00:00.123456+00:00',type:stock?'sync_local_woo_stock':'email',run_id:id(3),job_id:stock?id(n):null,outcome:'UNKNOWN_WRITE_OR_ACK',parent_acknowledged:false,unresolved:true,effect_plan_id:stock?id(4):null,effect_job_id:stock?id(5):null,message_id:stock?null:id(n),batch_id:stock?null:id(6)};}
function model(data:any[]=[],anchor=0){
 const queries:{sql:string;args:any[]}[]=[],c={query:async(sql:string,args:any[])=>{queries.push({sql,args});assert(sql.startsWith('WITH'),'One read-only statement');return{rows:[{anchor_count:anchor,data}]};}};
 return{queries,c,read:(query:any={})=>actual.readUnresolvedAutomaticEffects(c,tenant,rule,query)};
}
const status=(code:number)=>(error:any)=>error instanceof Problem&&error.status===code;
test('actual unresolved reader is import-inert, single bounded SQL read and safe eleven-field projection',async()=>{
 const q=model([row(20),row(19,false)]);assert.equal(q.queries.length,0);const result=await q.read();
 assert.equal(result.scope,'ALL_OWN_RULE_RUNS');assert.equal(result.has_more,false);assert.equal(result.next_cursor,null);assert.equal(q.queries.length,1);assert.deepEqual(q.queries[0].args,[tenant,rule,null,null]);
 for(const r of result.data){assert.equal(r.created_at,'2026-10-18T01:00:00.123Z');assert.equal(r.reconciliation_required,true);assert.equal(Object.keys(r).length,11);assert(!Object.hasOwn(r,'page_id'));assert(!Object.hasOwn(r,'unresolved'));}
 assert.equal(result.data[1].job_id,null);assert.equal((await model().read()).data.length,0);
});
test('actual page limit uses26sentinel, exact last returned kind/id cursor, no recycling or secret fields',async()=>{
 for(const stock of [true,false]){
  const rows=Array.from({length:26},(_,n)=>({...row(200-n,stock),payload:{credential:'never-expose'},error:'never-expose',lease_token:'never-expose'})),q=model(rows),result=await q.read();
  assert.equal(result.data.length,25);assert.equal(result.has_more,true);assert.equal(result.next_cursor,(stock?'stock:':'email:')+rows[24].page_id);assert(!JSON.stringify(result).includes('never-expose'));
  const exhausted=await model(rows.slice(0,25)).read();assert.equal(exhausted.has_more,false);assert.equal(exhausted.next_cursor,null);
 }
});
test('actual own resolved anchor is allowed, absent/foreign/ambiguous anchor refuses422 even for empty pages',async()=>{
 for(const kind of ['stock','email']){
  const q=model([],1),result=await q.read({reconciliation_after:kind+':'+id(30)});assert.equal(result.next_cursor,null);assert.deepEqual(q.queries[0].args,[tenant,rule,kind==='stock'?0:1,id(30)]);
  for(const count of [0,2])await assert.rejects(()=>model([],count).read({reconciliation_after:kind+':'+id(30)}),status(422));
 }
});
test('strict query rejects malformed/noncanonical/extra/accessor data before any SQL and never invokes getters',async()=>{
 let getters=0;const getter=Object.defineProperty({},'reconciliation_after',{enumerable:true,get(){getters++;return'stock:'+id(30);}});
 const hidden=Object.defineProperty({},'reconciliation_after',{value:'stock:'+id(30),enumerable:false});
 for(const query of [null,[],{extra:true},{reconciliation_after:undefined},{reconciliation_after:1},{reconciliation_after:'stock:'+id(30).toUpperCase()},{reconciliation_after:'STOCK:'+id(30)},{reconciliation_after:'email:bad'},{reconciliation_after:'stock:'+id(30),extra:true},getter,hidden,{[Symbol('unknown')]:true}]){
  const q=model();await assert.rejects(()=>q.read(query),status(422));assert.equal(q.queries.length,0);
 }
 assert.equal(getters,0);
});
test('actual protocol refuses duplicate/sentinel/foreign-shape rows, nullable flags, wrong effect kinds and malformed dates',async()=>{
 for(const mutate of [(r:any)=>r.run_id='bad',(r:any)=>r.job_id=null,(r:any)=>r.type_rank=1,(r:any)=>r.unresolved=false,(r:any)=>r.parent_acknowledged=null,(r:any)=>r.outcome='VERIFIED',(r:any)=>r.message_id=id(8),(r:any)=>r.created_at='invalid',(r:any)=>r.effect_plan_id='bad']){
  const r=row(20);mutate(r);await assert.rejects(()=>model([r]).read(),status(503));
 }
 for(const mutate of [(r:any)=>r.effect_job_id=id(8),(r:any)=>r.batch_id=null,(r:any)=>r.message_id=id(8),(r:any)=>r.job_id='bad']){
  const r=row(20,false);mutate(r);await assert.rejects(()=>model([r]).read(),status(503));
 }
 await assert.rejects(()=>model([row(20),row(20)]).read(),status(503));await assert.rejects(()=>model(Array.from({length:27},(_,n)=>row(100+n))).read(),status(503));
 const sentinel=Array.from({length:26},(_,n)=>row(100+n));sentinel[25].outcome='PENDING';await assert.rejects(()=>model(sentinel).read(),status(503));
});
test('page SQL retains complete existing global predicates/closed joins and actual-timestamp keyset without offset or watermark',async()=>{
 let full='';const effects=load('automation-local-effects',{'./db':{},'./offers':{},'./automation-local-channel':{}});
 await effects.readAutomaticRuleReconciliation({query:async(sql:string)=>{full=sql;return{rows:[{stock_required:false,email_required:false}]};}},tenant,rule);
 const q=model();await q.read();const sql=q.queries[0].sql,norm=(s:string)=>s.replace(/\s+/g,' ').trim();
 const start=full.indexOf("j.state<>'pending'"),end=full.indexOf(') AS stock_required');assert(start>0&&end>start);const predicate=full.slice(start,end);
 assert(norm(sql).includes('('+norm(predicate)+') AS unresolved'),'Complete unchanged stock predicate, including NULL/precise numeric conservative handling');
 const joinStart=full.indexOf('FROM automation_runs r JOIN jobs j'),joinEnd=full.indexOf(" AND j.state<>'pending'",joinStart);
 assert(norm(sql).includes(norm(full.slice(joinStart,joinEnd))),'Same full tenant/source/plan/child join clauses');
 assert(sql.includes("(m.state='uncertain' OR j.state='running') IS TRUE"));assert.equal((sql.match(/r.tenant_id=\$1 AND r.rule_id=\$2/g)||[]).length,2);
 assert(sql.includes('anchor AS MATERIALIZED (SELECT created_at,type_rank,page_id FROM own_effects WHERE type_rank=$3::int AND page_id=$4::uuid)'));
 assert(sql.includes('e.created_at<a.created_at OR e.created_at=a.created_at')&&sql.includes('e.type_rank>a.type_rank OR e.type_rank=a.type_rank AND e.page_id<a.page_id'));
 assert(sql.includes('ORDER BY e.created_at DESC,e.type_rank ASC,e.page_id DESC LIMIT 26'));assert(!/\bOFFSET\b|enabled_at|rule_version|date_trunc|to_char/.test(sql));
 assert.equal(sql.includes('created_at::text'),false,'Anchor never passes through JS date milliseconds');
});
