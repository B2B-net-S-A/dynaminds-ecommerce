/** Source-only controlled tests. No database, runtime seal or Native admission. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210CreditSuccessor as derive,ORDER_SPLIT210_CREDIT_SOURCE as pins} from '../tools/parity/order-split210-credit-successor.mjs';
import {deriveOrderSplit210TriggerRoster} from '../tools/parity/order-split210-external-triggers.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
const source210=readFileSync(new URL('../tools/parity/order-split210-business.sql',import.meta.url),'utf8'),r=derive({source210});
const source189=readFileSync(new URL('../server/189_packing_required_order_fields.sql',import.meta.url),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const executable=s=>spans(s).map(p=>p.executable?p.text:p.text.replace(/[^\n]/g,' ')).join('');
const omitBody=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));

test('complete24 fixed BEFORE equals the unique literal189 declaration and explicit181 private ACL',()=>{
 assert.equal(Buffer.byteLength(source189),pins.source189_bytes);assert.equal(sha(source189),pins.source189_sha256);
 const marker='CREATE OR REPLACE FUNCTION '+pins.key+'\n',at=source189.indexOf(marker);assert(at>=0);assert.equal(source189.indexOf(marker,at+1),-1);
 const open=source189.indexOf('AS $function$',at)+'AS $function$'.length,end=source189.indexOf('$function$;',open);
 assert.equal(r.change.before.source,source189.slice(open,end));assert.equal(r.change.before.definition,source189.slice(at,end)+'$function$\n');
 assert.equal(Object.keys(r.change.before).length,24);assert.equal(digest(r.change.before),pins.before_full24_value_sha256);assert.equal(digest({kind:'function',key:pins.key,value:r.change.before}),pins.before_full24_record_sha256);
 const sql181=readFileSync(new URL('../server/181_same_root_guard_observations.sql',import.meta.url),'utf8');assert.equal(sha(sql181),pins.source181_sha256);assert(sql181.includes('REVOKE ALL ON FUNCTION public.ordinary181_credit_calculate(boolean) FROM PUBLIC,dyna_app;'));
 assert.deepEqual(r.change.before.acl,[{grantee:'postgres',grantor:'postgres',privilege:'EXECUTE',grantable:false}]);assert.deepEqual(omitBody(r.change.after),omitBody(r.change.before));
});

test('three disjoint executable edits reverse the entire definition including all literal packing history',()=>{
 assert.equal(r.edits.length,3);let inverse=r.change.after.source,last=-1;const code=executable(r.change.before.source);
 for(const e of r.edits){assert(e.beforeStart>=last);last=e.beforeStart+e.before.length;assert.equal(r.change.before.source.slice(e.beforeStart,last),e.before);assert.notEqual(code[e.beforeStart],' ');}
 for(const e of [...r.edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}
 assert.equal(inverse,r.change.before.source);assert.equal(r.change.after.definition.replace(r.change.after.source,()=>inverse),r.change.before.definition);assert.equal(r.whole_source_inverse_verified,true);
});

test('one separate initial conditional statement authenticates TRUE before any bound-row collection',()=>{
 const source=r.change.after.source,first=source.slice(0,source.indexOf(';')+1);
 assert.equal(first,'\nSELECT CASE WHEN projection_ok THEN public.order_split210_require() END;');
 assert.equal((executable(source).match(/public\.order_split210_require\(\)/g)||[]).length,1);
 assert(source.indexOf(';')<source.indexOf('WITH split210_credit_bound AS MATERIALIZED'));
 assert(!source.includes('is_added_trigger('));assert(!source.includes('is_added_trigger_function('));
 assert.deepEqual(r.strict_bound_classifications,{fresh_whole210_guard_per_true_invocation:1,per_statement_candidates:5,cross_statement_cache:false});
});

test('five exact source-derived bound targets cover table rows, while only orders/items enter function membership',()=>{
 const bound=deriveOrderSplit210TriggerRoster({source210}).groups.external_bound.map(k=>k.split('.')[1]);assert.equal(bound.length,12);
 const tablePred=r.change.before.source.match(/FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND \(([^\n]+)\) AND c.relkind IN\('r','p'\)/)[1];
 const explicit=[...tablePred.matchAll(/c\.relname IN\(([^)]+)\)/g)].flatMap(m=>[...m[1].matchAll(/'([^']+)'/g)].map(m=>m[1]));
 const prefixes=[...tablePred.matchAll(/c\.relname LIKE '([^']+)'/g)].map(m=>m[1].replaceAll('\\_','_').slice(0,-1));
 assert.deepEqual(bound.filter(t=>explicit.includes(t)||prefixes.some(p=>t.startsWith(p))),r.statement_local_bound_targets.table_targets);
 assert.deepEqual(r.statement_local_bound_targets.table_targets,['order_items','orders','stock_location_movements','stock_movements','wms_layer_movements']);
 assert.deepEqual(r.statement_local_bound_targets.function_targets,['order_items','orders']);
 const values=[...r.edits[0].after.matchAll(/\('([a-z_]+)','order_split210_bound'\)/g)].map(m=>m[1]);assert.deepEqual(values,r.statement_local_bound_targets.table_targets);
 assert(r.edits[0].after.includes("n.nspname='public'"));assert(r.edits[0].after.includes('WHERE projection_ok'));
});

test('selectors exclude only matching verified source OIDs; unrelated references keep a shared function visible',()=>{
 const selectors=r.edits.slice(1);for(const e of selectors)assert.equal(e.after,e.before+' AND NOT EXISTS(SELECT FROM split210_credit_bound verified WHERE verified.oid=tr.oid)');
 // Controlled relational model of the emitted OID anti-join (not a PG test).
 const targets=new Set(r.statement_local_bound_targets.table_targets),rows=[{oid:1,schema:'public',table:'orders',name:'order_split210_bound',fn:'shared'},{oid:2,schema:'public',table:'orders',name:'foreign_trigger',fn:'shared'},{oid:3,schema:'foreign',table:'orders',name:'order_split210_bound',fn:'shared'},{oid:4,schema:'public',table:'documents',name:'order_split210_bound',fn:'other'}];
 const excluded=new Set(rows.filter(t=>t.schema==='public'&&targets.has(t.table)&&t.name==='order_split210_bound').map(t=>t.oid));assert.deepEqual([...excluded],[1]);
 const visible=rows.filter(t=>!excluded.has(t.oid));assert.deepEqual(visible.map(t=>t.oid),[2,3,4]);assert(visible.some(t=>t.fn==='shared'),'remaining unrelated reference retains shared function membership');
});

test('controlled entry truth table skips fresh210 work for false/NULL and propagates tamper refusal before collection',()=>{
 // Execute the only accepted generated initial statement as a bounded protocol
 // model. This proves wiring/order only; full DB tamper proof remains Native.
 const first=r.change.after.source.slice(0,r.change.after.source.indexOf(';')+1);assert.equal(first,'\nSELECT CASE WHEN projection_ok THEN public.order_split210_require() END;');
 const calls=[];const fold=(projection,require,collect)=>{if(projection===true)require();collect();return null;};
 for(const projection of [false,null])assert.equal(fold(projection,()=>{throw Error('must not access210');},()=>calls.push('old packing query')),null);
 assert.deepEqual(calls,['old packing query','old packing query']);
 for(const violation of ['owned bound-trigger definition drift','owned bound-guard body/ACL drift','missing owned trigger','extra owned overload']){const trace=[];assert.throws(()=>fold(true,()=>{trace.push('fresh whole210 require');throw Error(violation);},()=>trace.push('collection')),new RegExp(violation.replace('/','\\/')));assert.deepEqual(trace,['fresh whole210 require']);}
 const trace=[];fold(true,()=>trace.push('fresh whole210 require'),()=>trace.push('collection'));assert.deepEqual(trace,['fresh whole210 require','collection']);
});

test('entire packing189 inverse/gates and NULL result stay literal; all original legacy definition folds remain untouched',()=>{
 const old=r.change.before.source,after=r.change.after.source,tail='), projected AS MATERIALIZED (';
 assert.equal(after.slice(after.indexOf(tail)),old.slice(old.indexOf(tail)));assert(after.endsWith('ELSE NULL END FROM projected CROSS JOIN packing_gate\n'));
 assert.equal((after.match(/public\.manual_inventory_off_projected_definition\(p\.oid\)/g)||[]).length,1);assert.equal((old.match(/public\.manual_inventory_off_projected_definition\(p\.oid\)/g)||[]).length,1);
 assert(!after.includes('wms_row_guard'));assert(!after.includes('IS DISTINCT FROM')||old.includes('IS DISTINCT FROM'));
 assert(!/fingerprint\s*:=|certificate\s*UPDATE|expected_credit/i.test(after));
});

test('historical family definitions retain complete189 identity, with no guessed181 replacement',()=>{
 assert.deepEqual(Object.keys(r.families.partial204),[pins.key]);assert.equal(r.families.partial204[pins.key],r.change.before.definition);assert.equal(r.families.manual169[pins.key],r.change.before.definition);
 assert(r.change.after.definition.startsWith('CREATE OR REPLACE FUNCTION '+pins.key+'\n RETURNS text\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO \'pg_catalog\', \'public\''));
 assert(!r.change.after.config.some(c=>c.startsWith('TimeZone=')),'unchanged header does not invent UTC');
});

test('closed data-only inputs, literal210 source drift and mutation attempts fail closed; no acceptance is minted',()=>{
 assert.throws(()=>derive({source210:source210+'\n'}));assert.throws(()=>derive({source210,before:r.change.before}));
 let called=false;assert.throws(()=>derive({get source210(){called=true;return source210;}}));assert.equal(called,false);assert.throws(()=>derive(Object.create({source210})));
 assert(Object.isFrozen(r)&&Object.isFrozen(r.edits)&&Object.isFrozen(r.change.before.acl));assert.throws(()=>{r.change.after.source='poison';});
 for(const f of ['target_metadata_adopted','assembled','source_compilation_performed','native_certification','application_activation'])assert.equal(r[f],false);
});
