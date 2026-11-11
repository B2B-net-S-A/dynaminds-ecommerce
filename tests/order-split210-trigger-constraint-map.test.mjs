/** Portable authored V29 query fixture; no database, private path or catalogue capture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {
 ORDER_SPLIT210_TRIGGER_CONSTRAINT_MAP_SOURCE,
 deriveOrderSplit210TriggerConstraintMap,
} from '../tools/parity/order-split210-trigger-constraint-map.mjs';

// V29 expected vector8f2ba2..., ownvalid source157e71..., one terminal INTO removed.
const SOURCE_QUERY=gunzipSync(Buffer.from('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','base64'),{maxOutputLength:17895}).toString('utf8');
const SOURCE_SHA='a165c4a5299326669925818f6745d96ad56f0228903ac8332dbf63ff44ea587b';
const sha=value=>createHash('sha256').update(value).digest('hex');
const selection="t.tgrelid IN(SELECT oid FROM rels) OR starts_with(t.tgname,'order_split210_') OR t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))";
const source=()=>deriveOrderSplit210TriggerConstraintMap(SOURCE_QUERY);
function own(sql){const start=sql.indexOf(',live_own AS MATERIALIZED('),end=sql.indexOf('),live_all AS MATERIALIZED(',start);assert(start>=0&&end>start);return sql.slice(start,end);}
function arm(sql,kind){const scope=own(sql),start=scope.indexOf("SELECT '"+kind+"',");assert(start>=0);let end=scope.indexOf(" UNION ALL SELECT '",start+1);if(end<0)end=scope.lastIndexOf(") SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries");assert(end>start);return scope.slice(start,end);}
function inverse(result){let text=result.sql;for(const edit of [...result.edits].reverse()){assert.equal(text.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);text=text.slice(0,edit.afterStart)+edit.before+text.slice(edit.afterStart+edit.after.length);}return text;}

// Independent modeled selection/LEFT JOIN controls explain equivalence. These
// do not claim PostgreSQL execution; NULL/dangling catalog references below are
// deliberately synthetic negative models, not manufactured real catalog rows.
const rels=new Set([10,11]);
const constraints=[{oid:101,conrelid:10,conname:'ordinary_own_fk',namespace:'public'},
 {oid:102,conrelid:11,conname:'second_own_fk',namespace:'other'},
 {oid:201,conrelid:30,conname:'outside_fk',namespace:'public'},
 {oid:202,conrelid:40,conname:'other_schema_fk',namespace:'other'},
 {oid:203,conrelid:30,conname:'',namespace:'public'}];
const triggers=[
 {id:1,tgrelid:10,tgconstraint:0,tgname:'ordinary',namespace:'public'},
 {id:2,tgrelid:30,tgconstraint:201,tgname:'order_split210_external',namespace:'public'},
 {id:3,tgrelid:30,tgconstraint:101,tgname:'ordinary',namespace:'public'},
 {id:4,tgrelid:30,tgconstraint:201,tgname:'ordinary',namespace:'public'},
 {id:5,tgrelid:30,tgconstraint:0,tgname:'order_split210X_near_miss',namespace:'public'},
 {id:6,tgrelid:40,tgconstraint:202,tgname:'order_split210_other_schema',namespace:'other'},
 {id:7,tgrelid:11,tgconstraint:102,tgname:'internal',namespace:'public',tgisinternal:true},
 {id:8,tgrelid:30,tgconstraint:201,tgname:'order_split210_same_fk',namespace:'public'},
 {id:9,tgrelid:30,tgconstraint:203,tgname:'order_split210_empty_name',namespace:'public'},
];
function selected(rows,allConstraints){return rows.filter(t=>rels.has(t.tgrelid)||t.tgname.startsWith('order_split210_')||allConstraints.some(k=>k.oid===t.tgconstraint&&rels.has(k.conrelid)));}
function reference(rows,allConstraints){return selected(rows,allConstraints).map(t=>{const k=allConstraints.find(k=>k.oid===t.tgconstraint);return {id:t.id,constraint:k?.conname??null,internal_constraint_key:t.tgisinternal?(k?.conname??''):null};});}
function mapped(rows,allConstraints){const chosen=selected(rows,allConstraints),names=new Map([...new Set(chosen.map(t=>t.tgconstraint))].map(oid=>[oid,allConstraints.find(k=>k.oid===oid)?.conname??null]));return chosen.map(t=>({id:t.id,constraint:names.get(t.tgconstraint),internal_constraint_key:t.tgisinternal?(names.get(t.tgconstraint)??''):null}));}

test('portable authored fixture has independent complete finite source proof',()=>{
 assert.equal(Buffer.byteLength(SOURCE_QUERY),17895);assert.equal(sha(SOURCE_QUERY),SOURCE_SHA);
 const r=source();assert.equal(r.source_proofs,ORDER_SPLIT210_TRIGGER_CONSTRAINT_MAP_SOURCE);assert.equal(r.source_proofs.sha256,SOURCE_SHA);
 assert.equal(r.source_proofs.expected_vector.sha256,'8f2ba2f66a4c0bc4ff389ad1602836e4112e36ba8b962fbf979e4714ac61d1cc');
 assert.equal(r.source_proofs.source_function.sha256,'157e71a219025141d44d61314fdab57230156119e989cd042959b1a2f432bdd8');
 assert.equal(r.bytes,Buffer.byteLength(r.sql));assert.equal(r.sha256,sha(r.sql));assert.equal(r.edits.length,2);
});

test('two disjoint complete edits invert to every byte of the authored SELECT',()=>{
 const r=source();assert.equal(inverse(r),SOURCE_QUERY);assert.equal(r.whole_source_inverse_verified,true);
 assert(r.edits[0].beforeStart+r.edits[0].before.length<=r.edits[1].beforeStart);
 for(const edit of r.edits){assert.equal(SOURCE_QUERY.slice(edit.beforeStart,edit.beforeStart+edit.before.length),edit.before);assert.equal(r.sql.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);}
});

test('other seven descriptor arms and changed22 capture remain literal',()=>{
 const r=source();for(const kind of ['relation','column','constraint','index','policy','function','type'])assert.equal(arm(r.sql,kind),arm(SOURCE_QUERY,kind),kind);
 const firstEdit=r.edits[0];assert.equal(r.sql.slice(0,firstEdit.afterStart),SOURCE_QUERY.slice(0,firstEdit.beforeStart));
 const last=r.edits.at(-1);assert.equal(r.sql.slice(last.afterStart+last.after.length),SOURCE_QUERY.slice(last.beforeStart+last.before.length));
});

test('trigger record expression keeps all fields, internal keys and ordered duplicate attributes',()=>{
 const before=arm(SOURCE_QUERY,'trigger'),after=arm(source().sql,'trigger');
 const descriptor=before.slice(0,before.indexOf(' FROM pg_catalog.pg_trigger t'));
 assert.equal(after.slice(0,after.indexOf(' FROM selected_triggers t')),descriptor);
 assert.equal((descriptor.match(/k\.conname/g)||[]).length,2);
 assert(descriptor.includes("coalesce(k.conname,'')"));assert(descriptor.includes("'constraint',k.conname"));
 assert(descriptor.includes('WITH ORDINALITY u(num,ord)'));assert(descriptor.includes('jsonb_agg(a.attname ORDER BY u.ord)'));
 assert(!descriptor.includes('DISTINCT'));assert(!descriptor.includes('jsonb_strip_nulls'));
});

test('the exact global three-branch selector occurs once before name lookup',()=>{
 const r=source();assert.equal(r.sql.split(selection).length,2);
 assert(r.sql.includes('selected_triggers AS MATERIALIZED(SELECT t.* FROM pg_catalog.pg_trigger t WHERE '+selection+')'));
 assert.equal(r.sql.split('FROM pg_catalog.pg_trigger t').length,2);
 assert(r.sql.includes('SELECT needed.tgconstraint oid,(SELECT k.conname FROM pg_catalog.pg_constraint k WHERE k.oid=needed.tgconstraint) conname FROM(SELECT DISTINCT tgconstraint FROM selected_triggers) needed'));
 assert(!r.sql.includes('WHERE needed.tgconstraint'));assert(!r.sql.includes('LEFT JOIN pg_catalog.pg_constraint k ON k.oid=t.tgconstraint'));
});

test('modeled selection includes own relation, global prefix and referenced own FK branches',()=>{
 assert.deepEqual(selected(triggers,constraints).map(t=>t.id),[1,2,3,6,7,8,9]);
 assert.deepEqual(mapped(triggers,constraints),reference(triggers,constraints));
 assert.deepEqual(mapped(triggers,constraints).filter(t=>[2,6,8].includes(t.id)).map(t=>t.constraint),['outside_fk','other_schema_fk','outside_fk']);
});

test('distinct reference map preserves trigger multiplicity and empty constraint name',()=>{
 const result=mapped(triggers,constraints);assert.equal(result.filter(t=>t.constraint==='outside_fk').length,2);
 assert.equal(result.find(t=>t.id===9).constraint,'');assert.equal(result.find(t=>t.id===1).constraint,null);
 assert.equal(result.find(t=>t.id===7).internal_constraint_key,'second_own_fk');
});

test('synthetic dangling and NULL-name reference models retain original left-join NULL/coalesce behavior',()=>{
 const rows=[{id:20,tgrelid:10,tgconstraint:999,tgname:'internal',tgisinternal:true},{id:21,tgrelid:10,tgconstraint:301,tgname:'internal',tgisinternal:true}];
 const artificial=[...constraints,{oid:301,conrelid:40,conname:null}];assert.deepEqual(mapped(rows,artificial),reference(rows,artificial));
 assert.deepEqual(mapped(rows,artificial),[{id:20,constraint:null,internal_constraint_key:''},{id:21,constraint:null,internal_constraint_key:''}]);
});

test('source matcher rejects wrong types, additional inputs and authored byte drift',()=>{
 for(const value of [undefined,null,42,{},Buffer.from(SOURCE_QUERY),'',SOURCE_QUERY+'\n',' '+SOURCE_QUERY,SOURCE_QUERY.replace('k.oid=t.tgconstraint','k.oid<>t.tgconstraint')])assert.throws(()=>deriveOrderSplit210TriggerConstraintMap(value));
 assert.throws(()=>deriveOrderSplit210TriggerConstraintMap(SOURCE_QUERY,{}));
 let coercions=0;assert.throws(()=>deriveOrderSplit210TriggerConstraintMap({toString(){coercions++;return SOURCE_QUERY;}}));assert.equal(coercions,0);
});

test('candidate, multiple edits and near-match selectors are not accepted source witnesses',()=>{
 for(const value of [source().sql,SOURCE_QUERY.replace("starts_with(t.tgname,'order_split210_')","starts_with(t.tgname,'order_split209_')"),SOURCE_QUERY.replace('conrelid IN(SELECT oid FROM rels)','conrelid NOT IN(SELECT oid FROM rels)').replace('LEFT JOIN pg_catalog.pg_constraint','JOIN pg_catalog.pg_constraint')])assert.throws(()=>deriveOrderSplit210TriggerConstraintMap(value));
});

test('candidate is frozen, deterministic, invocation-local and unexecuted',()=>{
 const r=source();assert.deepEqual(r,source());assert(Object.isFrozen(r)&&Object.isFrozen(r.edits)&&Object.isFrozen(r.edits[0])&&Object.isFrozen(r.source_proofs));
 assert.equal(r.scope,'one SQL statement');assert.equal(r.cross_invocation_cache,false);assert.equal(r.new_runtime_functions,0);
 for(const field of ['source_compilation_performed','sql_executed','performance_measured','native_certification','application_activation','business_acceptance'])assert.equal(r[field],false);
 assert(!/\bCREATE\s+(?:FUNCTION|TABLE|INDEX)\b|\b(?:SET|COMMIT|INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(r.sql));
});
