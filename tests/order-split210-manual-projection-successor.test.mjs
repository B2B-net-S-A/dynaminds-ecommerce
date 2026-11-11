/** Pure source equations/control model only; no PG or Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210ManualProjectionSuccessor as derive,ORDER_SPLIT210_MANUAL_PROJECTION_SOURCE as pins} from '../tools/parity/order-split210-manual-projection-successor.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8'),sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v))),r=derive(),before=r.change.before,after=r.change.after;
const sql180=read('server/180_consistent_history_guard_dag.sql'),sql169=read('server/169_manual_inventory_off.sql');
const omitBody=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));
const unquoted=s=>spans(s).map(p=>p.executable?p.text:p.text.replace(/[^\n]/g,' ')).join('');

test('complete fixed24 BEFORE is the unique authored180 body/header and its explicit owner-only ACL',()=>{
 assert.equal(Buffer.byteLength(sql180),pins.source180_bytes);assert.equal(sha(sql180),pins.source180_sha256);
 const head="CREATE FUNCTION "+pins.key+" RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $ordinary180$";
 const at=sql180.indexOf(head);assert(at>=0&&sql180.indexOf(head,at+1)===-1);const start=at+head.length,end=sql180.indexOf('$ordinary180$;',start);
 assert.equal(before.source,sql180.slice(start,end));assert.equal(Buffer.byteLength(before.source),62761);assert.equal(sha(before.source),pins.before_source_sha256);
 assert(sql180.includes('REVOKE ALL ON FUNCTION public.ordinary180_projection_valid(jsonb) FROM PUBLIC,dyna_app;'));
 assert.equal(Object.keys(before).length,24);assert.equal(digest(before),pins.before_full24_value_sha256);assert.equal(digest({kind:'function',key:pins.key,value:before}),pins.before_full24_record_sha256);
 assert.equal(sha(before.definition),pins.before_definition_sha256);assert.deepEqual(before.acl,[{grantee:'postgres',grantor:'postgres',privilege:'EXECUTE',grantable:false}]);
 assert.deepEqual(before.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.deepEqual(omitBody(after),omitBody(before));
});

test('one executable SELECT port reverses the entire source and every quoted certificate byte',()=>{
 assert.equal(r.edits.length,1);const e=r.edits[0];assert.equal(before.source.slice(e.beforeStart,e.beforeStart+e.before.length),e.before);assert.equal(after.source.slice(e.afterStart,e.afterStart+e.after.length),e.after);
 assert(unquoted(before.source).slice(e.beforeStart).startsWith('SELECT prosrc INTO actual FROM pg_proc WHERE oid='));
 assert.equal(after.source.slice(0,e.afterStart)+e.before+after.source.slice(e.afterStart+e.after.length),before.source);
 assert.equal(after.source.slice(0,e.afterStart),before.source.slice(0,e.beforeStart));assert.equal(after.source.slice(e.afterStart+e.after.length),before.source.slice(e.beforeStart+e.before.length));
 assert.deepEqual(spans(after.source).filter(p=>!p.executable).map(p=>p.text).filter(s=>s.startsWith('$projection')),spans(before.source).filter(p=>!p.executable).map(p=>p.text).filter(s=>s.startsWith('$projection')));
 assert.equal(after.definition.replace(after.source,before.source),before.definition);assert.equal(r.sql,after.definition+';\n');
});

test('the original four-key certificate and credit source are literal169, not the older manual169 family',()=>{
 const successors=JSON.parse(before.source.split('$projectionnew$')[1]),names=Object.keys(successors).sort();assert.deepEqual(names,['b2b_credit_fingerprint','catalog_stock_control_effect_prepare','catalog_stock_control_effect_validate','catalog_stock_control_guards']);
 const marker='CREATE OR REPLACE FUNCTION public.b2b_credit_fingerprint() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$';
 const at=sql169.indexOf(marker);assert(at>=0&&sql169.indexOf(marker,at+1)===-1);const body=sql169.slice(at+marker.length,sql169.indexOf('$$;',at+marker.length));
 assert.equal(successors.b2b_credit_fingerprint.body,body);assert.equal(Buffer.byteLength(body),5802);assert.equal(sha(body),pins.selected_before_source_sha256);assert.equal(successors.b2b_credit_fingerprint.sha256,sha(body));
 assert(after.source.includes('FOR n IN SELECT jsonb_object_keys(cert->\'successor_functions\') LOOP'));
 assert(after.source.includes("IF actual IS DISTINCT FROM cert#>>ARRAY['successor_functions',n,'body'] THEN RETURN false;END IF;"));
 assert(!Object.hasOwn(r,'families'),'no unneeded/wrong historical family is fabricated');
});

test('only selected credit calls strict typed projection; other three raw bodies and NULL refusal remain',()=>{
 const e=r.edits[0];assert.equal(e.after,e.before.replace('SELECT prosrc INTO actual',"SELECT CASE n WHEN 'b2b_credit_fingerprint' THEN public.order_split210_try_function_projection(oid)->>'source' ELSE prosrc END INTO actual"));
 assert.equal((after.source.match(/public\.order_split210_try_function_projection\(oid\)/g)||[]).length,1);
 assert(!/coalesce|manual_inventory_off_projected_definition|partial_sale204_predecessor_definition/i.test(e.after));
 assert.deepEqual(r.projection_counts,{selected_credit_source_projection:1,raw_other_successors:3,successor_roster:4});
});

test('actual existing typed port requires fresh full210 BEFORE complete AFTER comparison and returns bound BEFORE',()=>{
 const closure=read('tools/parity/order-split210-closure.mjs'),a=closure.indexOf("functionSql('try_function_projection'"),b=closure.indexOf("functionSql('project209_record'",a);assert(a>=0&&b>a);const port=closure.slice(a,b);
 const fresh=port.indexOf('PERFORM public.order_split210_require()'),compare=port.indexOf("actual->'value' IS DISTINCT FROM entry->'after'"),returned=port.indexOf("RETURN entry->'before'");assert(fresh>=0&&compare>fresh&&returned>compare);
 assert(port.includes("entries->'nonlegacy_projection_keys'"));assert(port.includes("IF entry IS NULL"));assert(!port.includes('coalesce('));
});

test('controlled full-descriptor port refuses foreign/mixed/header/ACL/body drift and cannot replace guard failures',()=>{
 // Wiring model, tied to the exact emitted CASE above and the actual port
 // ordering in the preceding test. This is not an executed PostgreSQL proof.
 const successors=JSON.parse(before.source.split('$projectionnew$')[1]),oldCredit={source:successors.b2b_credit_fingerprint.body,owner:'postgres',acl:['owner-execute'],key:pins.selected_key},current={...oldCredit,source:'CONTROLLED current210 credit body'};
 const choose=(name,actual,require)=>{if(name!=='b2b_credit_fingerprint')return actual.source;require();if(digest(actual)!==digest(current))throw Error('exact current AFTER required');return oldCredit.source;};
 let calls=0;assert.equal(choose('b2b_credit_fingerprint',current,()=>calls++),oldCredit.source);assert.equal(calls,1);
 for(const name of ['catalog_stock_control_effect_prepare','catalog_stock_control_effect_validate','catalog_stock_control_guards'])assert.equal(choose(name,{source:successors[name].body},()=>assert.fail('raw others must not project')),successors[name].body);
 for(const altered of [{...current,key:'foreign.credit()'},{...current,owner:'foreign'},{...current,acl:[]},{...current,source:oldCredit.source},{...current,extra:true}])assert.throws(()=>choose('b2b_credit_fingerprint',altered,()=>{}),/exact current/);
 assert.throws(()=>choose('b2b_credit_fingerprint',current,()=>{throw Error('fresh whole210 drift');}),/fresh whole210 drift/);
 assert.notEqual(null,oldCredit.source,'NULL selected projection cannot match the nonnull original body');
});

test('zero-input derivation, frozen results and unchanged original exception/installation tail confer no authority',()=>{
 for(const v of [null,{},before,{before,after},{schemaValid:true},{source180:sql180}])assert.throws(()=>derive(v),/no caller input/);
 assert(Object.isFrozen(r)&&Object.isFrozen(r.edits)&&Object.isFrozen(before.acl));assert.throws(()=>{r.change.after.owner='foreign';});
 assert(after.source.endsWith('EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN RETURN false;END'));
 assert(after.source.includes("IF EXISTS(SELECT FROM migrations WHERE name='169_manual_inventory_off') THEN RETURN true;END IF;"));
 assert.equal(r.whole_source_inverse_verified,true);for(const flag of ['target_metadata_adopted','assembled','source_compilation_performed','native_certification','application_activation'])assert.equal(r[flag],false);
 assert(!/\b(?:UPDATE|INSERT|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i.test(unquoted(after.source)));
});
