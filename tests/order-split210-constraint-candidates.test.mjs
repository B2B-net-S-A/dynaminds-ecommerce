import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {deriveOrderSplit210ConstraintCandidates as derive,ORDER_SPLIT210_CONSTRAINT_CANDIDATES_SOURCE as SOURCE} from '../tools/parity/order-split210-constraint-candidates.mjs';
import {ORDER_SPLIT210_PREFIX_NAME_RANGES_SOURCE as PREFIX} from '../tools/parity/order-split210-prefix-name-ranges.mjs';

// Whole authored Source33 CREATE, extracted from the pinned emitted program,
// not an observed catalogue/target result. No private file needed by this test.
const packed=Buffer.from('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','base64');
const sha=value=>createHash('sha256').update(value).digest('hex');
assert.equal(packed.length,7554);
assert.equal(sha(packed),'d1604bf61ddaf2ca0c2398dda1cdd856ac33a12b84a6aa4e8fb3414dc4e13a51');
const original=gunzipSync(packed,{maxOutputLength:53744}).toString('utf8');
const head='CREATE FUNCTION public.order_split210_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $closure210$';
const tail='$closure210$;\n';
const capture=' WITH live_changed AS MATERIALIZED(',into=' INTO actual,live_external,live_fingerprint;';
const start=original.indexOf(capture),end=original.indexOf(into,start);
const oldQuery=original.slice(start,end)+';',oldBody=original.slice(head.length,-tail.length);
function inverse(value,edits){for(let i=edits.length-1;i>=0;i--){const edit=edits[i];assert.equal(value.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);value=value.slice(0,edit.afterStart)+edit.before+value.slice(edit.afterStart+edit.after.length);}return value;}
function assertFrozen(value){if(value&&typeof value==='object'){assert(Object.isFrozen(value));for(const child of Object.values(value))assertFrozen(child);}}

const own='k.conrelid IN(SELECT oid FROM rels)';
const prefix="n.nspname='public' AND (k.conname COLLATE \"C\">='order_split210_'::name AND k.conname COLLATE \"C\"<'order_split210`'::name AND starts_with(k.conname,'order_split210_'))";
const joins='JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace LEFT JOIN pg_catalog.pg_class c ON c.oid=k.conrelid';
const oldFrom='FROM pg_catalog.pg_constraint k '+joins+' WHERE '+own+' OR('+prefix+')';
const newFrom='FROM source33_constraints k '+joins;
const insertion='), entries(kind,key,value)AS(';
const newInsertion='), source33_constraint_oids AS MATERIALIZED(SELECT k.oid FROM pg_catalog.pg_constraint k WHERE '+own+' UNION SELECT k.oid FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace WHERE '+prefix+'), source33_constraints AS MATERIALIZED(SELECT k.* FROM source33_constraint_oids source33_pick JOIN pg_catalog.pg_constraint k ON k.oid=source33_pick.oid), entries(kind,key,value)AS(';

test('portable whole Source33 declaration agrees with independently authored predecessor pins',()=>{
 assert.equal(Buffer.byteLength(original),53744);assert.equal(sha(original),'73e000ed23e1714056ba808181d93f3e76437c553a03ef967b7a4792f61a7f2c');
 assert.equal(Buffer.byteLength(oldBody),53578);assert.equal(sha(oldBody),SOURCE.body.sha256);
 assert.equal(Buffer.byteLength(oldQuery),18811);assert.equal(sha(oldQuery),SOURCE.query.sha256);
 assert.deepEqual(SOURCE.valid,PREFIX.output_valid);assert.deepEqual(SOURCE.query,PREFIX.measured_query);
 assert.equal(SOURCE.authored_program.sha256,'23cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d');
 assert(original.startsWith(head)&&original.endsWith(tail));assertFrozen(SOURCE);
});

test('exactly two closed query changes preserve every other byte and all three full inverses',()=>{
 const candidate=derive(original);assert.deepEqual(candidate,derive(original));assertFrozen(candidate);
 assert.equal(candidate.query_sql,oldQuery.replace(insertion,newInsertion).replace(oldFrom,newFrom));
 assert.equal(candidate.query_edits.length,2);assert.equal(candidate.edits.length,2);assert.equal(candidate.body_edits.length,2);
 assert.equal(inverse(candidate.query_sql,candidate.query_edits),oldQuery);
 assert.equal(inverse(candidate.sql,candidate.edits),original);
 assert.equal(inverse(candidate.sql.slice(head.length,-tail.length),candidate.body_edits),oldBody);
 assert.equal(candidate.sql.slice(0,start),original.slice(0,start));
 assert.equal(candidate.sql.slice(start+candidate.query_sql.length-1),original.slice(end));
 assert.equal(candidate.bytes,Buffer.byteLength(candidate.sql));assert.equal(candidate.sha256,sha(candidate.sql));
 assert.equal(candidate.query.bytes,Buffer.byteLength(candidate.query_sql));assert.equal(candidate.query.sha256,sha(candidate.query_sql));
 assert(candidate.sql.startsWith(head)&&candidate.sql.endsWith(tail));
});

test('the original full constraint record and its namespace/LEFT JOIN/domain expression are literal',()=>{
 const candidate=derive(original),cstart=oldQuery.indexOf("SELECT 'constraint'"),cend=oldQuery.indexOf("UNION ALL SELECT 'index'",cstart);
 assert(cstart>0&&cend>cstart);
 const before=oldQuery.slice(cstart,cend);
 const nowStart=candidate.query_sql.indexOf("SELECT 'constraint'"),nowEnd=candidate.query_sql.indexOf("UNION ALL SELECT 'index'",nowStart);
 const after=candidate.query_sql.slice(nowStart,nowEnd);
 assert.equal(after,before.replace(oldFrom,newFrom));
 assert(after.includes('k.conrelid=0'));assert(after.includes('k.contypid::regtype::text'));
 assert(after.includes(joins));assert(!after.includes('k.connamespace='));
 // All descriptor expressions in all eight own arms, all trigger selection,
 // external full24 projection, two aggregates and ordered fingerprint remain.
 const restored=candidate.query_sql.replace(newInsertion,insertion).replace(newFrom,oldFrom);
 assert.equal(restored,oldQuery);
 const kinds=[...oldQuery.matchAll(/SELECT '([^']+)'/g)].map(match=>match[1]);
 assert.deepEqual(kinds,['function','relation','column','constraint','index','policy','trigger','function','type']);
 assert.equal((candidate.query_sql.match(/starts_with\(/g)||[]).length,(oldQuery.match(/starts_with\(/g)||[]).length);
 assert.equal(candidate.invariants.other_own_arms_unchanged,7);
});

test('scope selection is exactly own relation OR public constraint-name prefix with OID-only UNION',()=>{
 const query=derive(original).query_sql;
 assert(query.includes('SELECT k.oid FROM pg_catalog.pg_constraint k WHERE '+own+' UNION SELECT k.oid FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace WHERE '+prefix));
 assert(query.includes('SELECT k.* FROM source33_constraint_oids source33_pick JOIN pg_catalog.pg_constraint k ON k.oid=source33_pick.oid'));
 const selector=query.slice(query.indexOf('source33_constraint_oids AS'),query.indexOf(', source33_constraints AS'));
 assert(!selector.includes('UNION ALL'));assert(!selector.includes('jsonb'));assert(!selector.includes('contypid'));assert(!selector.includes('contype'));
 assert(!selector.includes('regnamespace'));assert(!selector.includes('pg_class'));assert(!selector.includes('DISTINCT conname'));
});

test('independent finite set controls cover overlap, foreign namespaces, domain and distinct same-value OIDs',()=>{
 // Boolean-set identity controls only; this is not a SQL/collation interpreter
 // and cannot establish a PG execution plan, snapshot freshness or timing.
 const rows=[
  {oid:1,own:true,namespace:'public',prefix:true,conrelid:10,value:'equal'},
  {oid:2,own:true,namespace:'foreign',prefix:false,conrelid:11,value:'equal'},
  {oid:3,own:false,namespace:'public',prefix:true,conrelid:0,value:'domain'},
  {oid:4,own:false,namespace:'public',prefix:true,conrelid:12,relationNamespace:'foreign'},
  {oid:5,own:false,namespace:'foreign',prefix:true,conrelid:13},
  {oid:6,own:false,namespace:'public',prefix:false,conrelid:14},
  {oid:7,own:true,namespace:'foreign',prefix:true,conrelid:15},
  {oid:8,own:null,namespace:'public',prefix:false,conrelid:16},
 ];
 const publicScope=row=>row.namespace==='public'&&row.prefix===true;
 const before=rows.filter(row=>row.own===true||publicScope(row)).map(row=>row.oid);
 const selected=new Set([...rows.filter(row=>row.own===true),...rows.filter(publicScope)].map(row=>row.oid));
 assert.deepEqual([...selected].sort((a,b)=>a-b),before);assert.deepEqual(before,[1,2,3,4,7]);
 assert.equal([...selected].filter(oid=>oid===1).length,1);
 assert(selected.has(1)&&selected.has(2),'equal descriptor values retain separate catalogue identities');
 assert(selected.has(3),'public prefixed domain has no pg_class relation');
 assert(selected.has(4),'constraint namespace rather than relation namespace');
 assert(selected.has(2)&&selected.has(7),'own-relation branch is not restricted to public constraint namespace');
});

test('malformed, modified, partial or extra inputs cannot select different scopes or descriptors',()=>{
 for(const value of [undefined,null,{},new String(original),42,original.slice(1),original+'\n',original.replace('STABLE','VOLATILE'),original.replace('k.connamespace','k.conrelid'),original.replace("n.nspname='public'","n.nspname='foreign'"),original.replace("'constraint'","'omitted'"),original.replace('k.contypid','k.conrelid')])assert.throws(()=>derive(value));
 assert.throws(()=>derive());assert.throws(()=>derive(original,{}));assert.throws(()=>derive(original,()=>''));
});

test('candidate is unwired source only and makes no PG or performance acceptance claim',()=>{
 const candidate=derive(original);
 for(const key of ['source_data_changed','cross_invocation_cache','sql_executed','source_compilation_performed','native_certification','application_activation','business_acceptance','performance_acceptance'])assert.equal(candidate[key],false,key);
 assert.equal(candidate.new_runtime_functions,0);
 assert.equal(candidate.invariants.deduplication,'catalogue_oid_only');
 assert.equal(candidate.invariants.all_guard_checks_unchanged,true);assert.equal(candidate.invariants.all_require_calls_unchanged,true);
 assert.equal(candidate.invariants.statement_snapshot_and_SPI_boundary_unchanged,true);
 assert(!candidate.sql.includes('set_config('));
});
