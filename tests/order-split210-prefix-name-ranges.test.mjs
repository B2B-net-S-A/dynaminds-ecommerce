import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210PrefixNameRanges as derive,ORDER_SPLIT210_PREFIX_NAME_RANGES_SOURCE as PIN} from '../tools/parity/order-split210-prefix-name-ranges.mjs';
import {deriveOrderSplit210FrameSchemaColumn} from '../tools/parity/order-split210-frame-schema-column.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
// Reuse the existing two authored declarations; do not persist another SQL fixture.
const fixtureText=readFileSync(new URL('./order-split210-frame-schema-column.test.mjs',import.meta.url),'utf8');
const packed=/const packed=Buffer\.from\('([^']+)','base64'\)/.exec(fixtureText);assert(packed,'existing finite declaration fixture');
const fixture=JSON.parse(gunzipSync(Buffer.from(packed[1],'base64'),{maxOutputLength:65536}));
const source32=deriveOrderSplit210FrameSchemaColumn(fixture).validSql;
const reverse=(sql,edits)=>{for(const e of [...edits].reverse()){assert.equal(sql.slice(e.afterStart,e.afterStart+e.after.length),e.after);sql=sql.slice(0,e.afterStart)+e.before+sql.slice(e.afterStart+e.after.length);}return sql;};

test('only exact Source32 declaration produces exact measured D37 query and Source33 declaration',()=>{
 const r=derive(source32);assert.equal(Buffer.byteLength(source32),53130);assert.equal(sha(source32),PIN.valid.sha256);
 assert.equal(r.bytes,53744);assert.equal(r.sha256,'73e000ed23e1714056ba808181d93f3e76437c553a03ef967b7a4792f61a7f2c');
 assert.equal(Buffer.byteLength(r.query_sql),18811);assert.equal(sha(r.query_sql),'7a5547d3cebe9d9071180ccf97a06318ccdc1dc48a2800e4c5a6c2f923f38955');
 assert.equal(r.bytes-Buffer.byteLength(source32),614);assert.equal(r.query.bytes,18811);
});
test('six edits independently reverse entire capture, raw body and complete CREATE',()=>{
 const r=derive(source32);assert.equal(r.edits.length,6);assert.equal(r.query_edits.length,6);assert.equal(r.body_edits.length,6);
 assert.equal(reverse(r.sql,r.edits),source32);
 const query=reverse(r.query_sql,r.query_edits);assert.equal(Buffer.byteLength(query),18197);assert.equal(sha(query),PIN.query.sha256);
 const beforeBody=source32.split('$closure210$')[1],afterBody=r.sql.split('$closure210$')[1];assert.equal(reverse(afterBody,r.body_edits),beforeBody);
 assert.equal(Buffer.byteLength(afterBody),53578);assert.equal(sha(afterBody),'5525a9adb76cbc72e07b907b8a5d5c6723d7df0ba41449f6d8f701cc702e3df2');
});
test('every original predicate remains inside its exact C/NAME conjunction with unchanged branch order',()=>{
 const r=derive(source32),expected=[['relname','order_split210_'],['t.tgname','order_split210_'],['k.conname','order_split210_'],['p.proname','order_split210_'],['t.typname','order_split210_'],['t.typname','_order_split210_']];
 assert.deepEqual(r.edits.map(e=>[e.column,e.lower]),expected);
 for(const e of r.edits){assert.equal(e.upper,e.lower.slice(0,-1)+'`');assert.equal(e.before,`starts_with(${e.column},'${e.lower}')`);assert.equal(e.after,`(${e.column} COLLATE "C">='${e.lower}'::name AND ${e.column} COLLATE "C"<'${e.upper}'::name AND ${e.before})`);}
 assert.equal((r.query_sql.match(/COLLATE "C">=/g)||[]).length,6);assert.equal((r.query_sql.match(/COLLATE "C"</g)||[]).length,6);
 assert.equal(r.original_prefix_predicates_preserved,6);assert.equal(r.name_ranges_added,6);
});
test('all prechecks, complete header, terminal INTO and postchecks remain byte identical',()=>{
 const r=derive(source32),capture=' WITH live_changed AS MATERIALIZED(',into=' INTO actual,live_external,live_fingerprint;';
 assert.equal(r.sql.slice(0,r.sql.indexOf(capture)),source32.slice(0,source32.indexOf(capture)));
 assert.equal(r.sql.slice(r.sql.indexOf(into)),source32.slice(source32.indexOf(into)));
 assert.equal(r.sql.split('$closure210$')[0],source32.split('$closure210$')[0]);assert.equal(r.sql.split('$closure210$')[2],source32.split('$closure210$')[2]);
 assert.equal(r.header_and_suffix_preserved,true);assert.equal(r.new_runtime_functions,0);assert.equal(r.cross_invocation_cache,false);
});
test('old Source31, repeated transformation and any changed scope or descriptor are refused',()=>{
 assert.throws(()=>derive(fixture.validSql));assert.throws(()=>derive(derive(source32).sql));
 for(const changed of [source32+' ',source32.replace("n.nspname='public'","n.nspname='otherx'"),source32.replace('p.proowner','p.proname'),source32.replace("starts_with(relname,'order_split210_')","starts_with(relname,'order_split209_')"),source32.replace('STABLE','VOLATILE')]){
  assert.notEqual(changed,source32);assert.throws(()=>derive(changed));
 }
});
test('no caller-selected atoms, casts, source object getters or extra options are admitted',()=>{
 for(const bad of [null,undefined,{},[],Buffer.from(source32),new String(source32),{toString:()=>source32}])assert.throws(()=>derive(bad));
 assert.throws(()=>derive(source32,{}));assert.throws(()=>derive());
});
test('source proof and all edit records are frozen; outputs confer no runtime or performance authority',()=>{
 const r=derive(source32);for(const v of [PIN,PIN.valid,PIN.measured_query,PIN.diagnostic37,r,r.edits,r.edits[0],r.body_edits[0],r.query_edits[0]])assert(Object.isFrozen(v));
 for(const k of ['source_compilation_performed','native_certification','application_activation','business_acceptance','performance_acceptance'])assert.equal(r[k],false,k);
 assert.equal(PIN.diagnostic37.same_function_SPI_measured,false);assert.equal(PIN.diagnostic37.full187_accepted,false);
 assert.equal(r.source_proofs.payload.bytes,3590688);assert.equal(r.source_proofs.payload.sha256,'db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3');
});
test('portable byte-C proof covers both finite prefixes at63bytes; this is not a PostgreSQL witness',()=>{
 for(const prefix of ['order_split210_','_order_split210_']){
  const lower=Buffer.from(prefix),upper=Buffer.from(prefix.slice(0,-1)+'`');
  for(const suffix of ['', 'a','_', '`','ż','東京','😀','x'.repeat(63-lower.length)]){
   const name=Buffer.from(prefix+suffix);assert(name.length<=63);assert(Buffer.compare(name,lower)>=0);assert(Buffer.compare(name,upper)<0);
  }
 }
});
