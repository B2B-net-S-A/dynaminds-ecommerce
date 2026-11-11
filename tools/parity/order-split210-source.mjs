/** Pure unsealed assembler. No filesystem, database, migration registration,
 * dynamic seal, or implicit acceptance of the accepted22b parent. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210Closure} from './order-split210-closure.mjs';
import {orderSplit210ObserverSpans} from './order-split210-predecessor.mjs';
import {ORDER_SPLIT210_LAYER_PARENT} from './order-split210-layer.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const ORDER_SPLIT210_ASSEMBLY_INPUTS=freeze({
 core:{sha256:'fb803220a91c2cefcc6953d1aebd69e173dbc079a94d161bf6bb2d326ed0f4a1'},
 terminal:{sha256:'cb9620410a63dc6225911ef507ff4423610e577c31f2f700d9e987c111943c60'},
 parent209:{sha256:ORDER_SPLIT210_LAYER_PARENT.source_sha256,bytes:ORDER_SPLIT210_LAYER_PARENT.source_bytes,
  source_contract_sha256:ORDER_SPLIT210_LAYER_PARENT.source_contract_sha256,
  native_receipt_sha256:ORDER_SPLIT210_LAYER_PARENT.native_receipt_sha256,native_review_sha256:ORDER_SPLIT210_LAYER_PARENT.native_review_sha256,
  legacy_function_count:17,source_addition_count:259,native_acceptance:ORDER_SPLIT210_LAYER_PARENT.source_native_acceptance},
});
const businessKeys=['public.fa3_draft_fingerprint()','public.b2b_invoice_fingerprint()','public.b2b_credit_fingerprint()','public.wms_row_guard()'];
const expectedKeys=[...businessKeys,...ORDER_SPLIT210_LAYER_PARENT.routines.map(r=>r.key),'public.buyer_address_guards()','public.financial_return_upgrade_valid()','public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)','public.order_merge_delivery209_buyer_guards(manual_basis jsonb)','public.order_merge_delivery209_startup_operative_valid(entries jsonb)','public.ordinary181_financial_valid(manual_basis jsonb)','public.ordinary181_credit_calculate(projection_ok boolean)','public.ordinary180_projection_valid(b jsonb)'];
const coreFunctions=['immutable','physical','no_effects','terminal','complete','bound_guard','hash','id','identity','replay_complete','preview','materialize','row_admission','plan','budget','capture','execute'];
const closureFunctions=['fingerprint','valid','require','try_function_projection','project209_record','try_metadata_projection','predecessor_definition','is_added_trigger','is_added_trigger_function'];
const coreTables=['previews','source_rows','executions','targets','allocations','replay_duties'];
const prefix='public.order_split210_';
const normalizeArgs=s=>s.split(',').map(v=>v.trim()).filter(Boolean).map(arg=>{
 assert(/^[a-z_][a-z_0-9]* [a-z_][a-z_0-9.]*(?:\[\])?$/.test(arg),'explicit supported named argument/type only');return arg;
});

/** Restricted source inventory. Comments, dollar bodies and string literals
 * cannot masquerade as declarations. It is NOT a PostgreSQL parser/proof. */
export function inspectOrderSplit210Declarations(sql){
 assert.equal(typeof sql,'string');
 const executable=orderSplit210ObserverSpans(sql).map(s=>s.executable?s.text:' '.repeat(s.text.length)).join('');
 const functions=[...executable.matchAll(/\bCREATE(?: OR REPLACE)? FUNCTION (public\.[a-z_][a-z_0-9]*)\(([^()]*)\)/g)].map(m=>{
  const args=normalizeArgs(m[2]);return {name:m[1],key:m[1]+'('+args.join(', ')+')',type_key:m[1]+'('+args.map(a=>a.slice(a.indexOf(' ')+1)).join(', ')+')'};
 });
 assert.equal(functions.length,(executable.match(/\bCREATE(?: OR REPLACE)? FUNCTION\b/g)||[]).length,'all top-level function declarations accounted for');
 const tables=[...executable.matchAll(/\bCREATE TABLE (public\.[a-z_][a-z_0-9]*)\(/g)].map(m=>m[1]);
 assert.equal(tables.length,(executable.match(/\bCREATE TABLE\b/g)||[]).length,'all top-level persistent table declarations accounted for');
 assert.equal(new Set(functions.map(f=>f.type_key)).size,functions.length,'no duplicate/overlapping routine identity');
 assert.equal(new Set(tables).size,tables.length,'no duplicate persistent relation');
 return freeze({functions,tables});
}

/** Header/ACL changes cannot be smuggled through a body-only successor stage.
 * The entire twenty-two-name/overload roster is fixed, not an arbitrary prefix. */
export function assertOrderSplit210SuccessorHeaders(changes){
 assert(Array.isArray(changes)&&changes.length===22,'exact twenty-two successor changes');
 assert.deepEqual(changes.map(c=>c.key),expectedKeys,'exact ordered twenty-two-key roster');
 const headers=v=>Object.fromEntries(Object.entries(v).filter(([k])=>k!=='source'&&k!=='definition'));
 for(const c of changes){
  assert.equal(c.kind,'function');assert.equal(digest(headers(c.before)),digest(headers(c.after)),'every original descriptor header/ACL field preserved');
  assert.equal(typeof c.before.source,'string');assert.equal(typeof c.after.source,'string');
  assert(!c.before.source.includes('$function$')&&!c.after.source.includes('$function$'),'literal deparser delimiter must not collide with body');
  const marker='AS $function$',a=c.before.definition.indexOf(marker);
  assert(a>=0&&c.before.definition.indexOf(marker,a+marker.length)<0,'single complete authored definition wrapper');
  const header=c.before.definition.slice(0,a+marker.length),tail='$function$\n';
  assert.equal(c.before.definition,header+c.before.source+tail,'entire BEFORE definition/body binding');
  assert.equal(c.after.definition,header+c.after.source+tail,'entire AFTER literal header/body binding');
  const parsed=inspectOrderSplit210Declarations(c.after.definition+';\n');
  assert.equal(parsed.tables.length,0);assert.equal(parsed.functions.length,1);assert.equal(parsed.functions[0].key,c.key,'exact named argument/signature');
 }
 return changes;
}

function exactNames(inventory,names,tables,label){
 assert.deepEqual(inventory.functions.map(f=>f.name),names.map(n=>prefix+n),label+' exact routine roster');
 assert.deepEqual(inventory.tables,tables.map(n=>prefix+n),label+' exact persistent relation roster');
}
function pinned(sql,pin,label){assert.equal(typeof sql,'string');assert.equal(sha(sql),pin.sha256,label+' exact literal source');return {sha256:pin.sha256,bytes:Buffer.byteLength(sql)};}
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function finalPrivateAclSql(functions,tables){
 assert.equal(functions.length,27);assert.equal(tables.length,8);
 assert(functions.every(f=>f.name.startsWith(prefix))&&tables.every(t=>t.startsWith(prefix)));
 // Fixed source-derived OIDs, not a prefix-wide runtime discovery. Named
 // argument differences cannot hide duplicate/overlapping SQL identities.
 return `-- Close inherited defaults on ALL newly authored objects only.
DO $split210_private_acl$ DECLARE
 fn_ids oid[]:=ARRAY[${functions.map(f=>quote(f.type_key)+'::regprocedure::oid').join(',')}];
 table_ids oid[]:=ARRAY[${tables.map(t=>quote(t)+'::regclass::oid').join(',')}];
 o record;a record;
BEGIN
 IF current_user IS DISTINCT FROM session_user OR current_user<>'postgres'
 OR(SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid=ANY(fn_ids))<>27
 OR(SELECT count(*) FROM pg_catalog.pg_class c WHERE c.oid=ANY(table_ids))<>8
 OR EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.oid=ANY(fn_ids) AND p.proowner<>'postgres'::regrole)
 OR EXISTS(SELECT FROM pg_catalog.pg_class c WHERE c.oid=ANY(table_ids) AND c.relowner<>'postgres'::regrole)
 THEN RAISE EXCEPTION 'Split210 private ACL target ownership changed' USING ERRCODE='55000';END IF;
 FOR o IN SELECT p.oid,p.proowner,p.proacl FROM pg_catalog.pg_proc p WHERE p.oid=ANY(fn_ids) LOOP
  FOR a IN SELECT DISTINCT x.grantee FROM pg_catalog.aclexplode(coalesce(o.proacl,pg_catalog.acldefault('f',o.proowner))) x WHERE x.grantee<>o.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',o.oid::regprocedure,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END);
  END LOOP;
 END LOOP;
 FOR o IN SELECT c.oid,c.relowner,c.relacl FROM pg_catalog.pg_class c WHERE c.oid=ANY(table_ids) LOOP
  FOR a IN SELECT DISTINCT x.grantee FROM pg_catalog.aclexplode(coalesce(o.relacl,pg_catalog.acldefault('r',o.relowner))) x WHERE x.grantee<>o.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %s FROM %s',o.oid::regclass,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END);
  END LOOP;
  FOR a IN SELECT DISTINCT attribute.attname,x.grantee FROM pg_catalog.pg_attribute attribute CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) x
   WHERE attribute.attrelid=o.oid AND attribute.attnum>0 AND NOT attribute.attisdropped AND x.grantee<>o.relowner LOOP
   EXECUTE format('REVOKE ALL (%I) ON TABLE %s FROM %s',a.attname,o.oid::regclass,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END);
  END LOOP;
 END LOOP;
END $split210_private_acl$;
`;
}

/** Takes only literal source inputs accepted by the underlying derivations;
 * no ready-made closure/expectation/predicate can bypass fresh derivation. */
export function assembleOrderSplit210Source(inputs){
 assert(inputs&&typeof inputs==='object');
 const core=pinned(inputs.source210,ORDER_SPLIT210_ASSEMBLY_INPUTS.core,'core210');
 const terminal=pinned(inputs.sourceTerminal,ORDER_SPLIT210_ASSEMBLY_INPUTS.terminal,'terminal210');
 const closure=deriveOrderSplit210Closure(inputs);
 assert.equal(closure.parent.source_sha256,ORDER_SPLIT210_ASSEMBLY_INPUTS.parent209.sha256);
 assert.equal(closure.parent.source_native_acceptance,true,'accepted22b source parent required');
 assert.equal(closure.sealed,false);assert.equal(closure.seal_sql_emitted,false);
 assertOrderSplit210SuccessorHeaders(closure.changes);
 const inventories={core:inspectOrderSplit210Declarations(inputs.source210),terminal:inspectOrderSplit210Declarations(inputs.sourceTerminal),preamble:inspectOrderSplit210Declarations(closure.preambleSql),ports:inspectOrderSplit210Declarations(closure.sql),acl:inspectOrderSplit210Declarations(closure.aclSql)};
 exactNames(inventories.core,coreFunctions,coreTables,'core');exactNames(inventories.terminal,['finalize'],[],'terminal');
 exactNames(inventories.preamble,[],['projection_basis','manifest'],'closure DATA');exactNames(inventories.ports,closureFunctions,[],'closure ports');exactNames(inventories.acl,[],[],'ACL');
 const newFunctions=Object.values(inventories).flatMap(i=>i.functions),newTables=Object.values(inventories).flatMap(i=>i.tables);
 assert.equal(newFunctions.length,27);assert.equal(new Set(newFunctions.map(f=>f.type_key)).size,27,'no cross-stage function collisions');
 assert.equal(newTables.length,8);assert.equal(new Set(newTables).size,8,'no cross-stage relation collisions');
 assert(closure.changes.every(c=>!c.key.startsWith(prefix)),'all twenty-two replacements are actual predecessor identities');
 const aclSql=closure.aclSql+finalPrivateAclSql(newFunctions,newTables);
 const chunks=[['core210',inputs.source210],['terminal210',inputs.sourceTerminal],['closure-data',closure.preambleSql],['closure-ports',closure.sql],
  ...closure.changes.map(c=>['replace:'+c.key,c.after.definition+';\n']),['closure-acl',aclSql]];
 assert.equal(chunks.length,27);
 const stages=[];let sql='',offset=0;
 for(const [id,body] of chunks){
  const marker='-- UNSEALED split210 candidate stage '+String(stages.length+1).padStart(2,'0')+': '+id+'\n';
  sql+=marker;offset+=Buffer.byteLength(marker);
  const bytes=Buffer.byteLength(body);stages.push({index:stages.length+1,id,offset,bytes,sha256:sha(body)});
  sql+=body;offset+=bytes;if(!body.endsWith('\n')){sql+='\n';offset++;}
 }
 assert.equal(offset,Buffer.byteLength(sql));
 const completeInventory=inspectOrderSplit210Declarations(sql);
 assert.equal(completeInventory.functions.length,49,'27 new routines plus22 exact replacements');assert.equal(completeInventory.tables.length,8);
 const executable=orderSplit210ObserverSpans(sql).filter(s=>s.executable).map(s=>s.text).join('');
 assert(!/\bINSERT\s+INTO\s+(?:public\.)?migrations\b/i.test(executable),'no migration registration');
 assert(!/\bINSERT\s+INTO\s+public\.order_split210_manifest\b/i.test(executable),'no automatic seal');
 assert(!/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i.test(executable),'assembler does not own the compiler transaction');
 const sourceInputs={core,terminal,parent209:ORDER_SPLIT210_ASSEMBLY_INPUTS.parent209,derivations:closure.source_inputs};
 return freeze({schema:'order-split210-unsealed-source-program/v1',sql,sha256:sha(sql),bytes:offset,stages,boundary_sha256:digest(stages),input_sha256:digest(sourceInputs),source_inputs:sourceInputs,
  changed_functions:closure.changes,new_functions:newFunctions,new_tables:newTables,projection_basis:closure.projection_basis,
  authored_basis:closure.authored_basis,required_fixed_seal:closure.required_fixed_seal,unresolved_pg_fields:closure.unresolved_pg_fields,
  expected_counts:{stages:27,replacements:22,new_functions:27,new_tables:8,authored_triggers:31,trigger_constraint_pairs:3,foreign_keys:18,ri_triggers:72},
  parent_native_acceptance:true,sealed:false,seal_sql_emitted:false,source_compilation_performed:false,full_before_descriptors_compiler_verified:false,
  complete_twenty_two_change_closure:false,complete_twenty_one_change_closure:false,complete_twenty_change_closure:false,complete_nineteen_change_closure:false,complete_seventeen_change_closure:false,complete_sixteen_change_closure:false,complete_fifteen_change_closure:false,native_certification:false,application_activation:false,migration_registered:false});
}
