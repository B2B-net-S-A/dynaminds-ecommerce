/** Pure Source29 query-local candidate. No SQL execution or generator integration. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{
 if(value&&typeof value==='object'){
  for(const item of Object.values(value))freeze(item);
  Object.freeze(value);
 }
 return value;
};

export const ORDER_SPLIT210_TRIGGER_CONSTRAINT_MAP_SOURCE=freeze({
 schema:'order-split210-source29-valid-capture-select/v1',
 bytes:17895,
 sha256:'a165c4a5299326669925818f6745d96ad56f0228903ac8332dbf63ff44ea587b',
 expected_vector:{bytes:332708,sha256:'8f2ba2f66a4c0bc4ff389ad1602836e4112e36ba8b962fbf979e4714ac61d1cc'},
 source_function:{key:'public.order_split210_valid()',bytes:52655,sha256:'157e71a219025141d44d61314fdab57230156119e989cd042959b1a2f432bdd8'},
 capture_line:{bytes:17938,sha256:'0a5894c965c532e6f90b5e473d1885e54760136fa7c97f58affbb7e2c9014802'},
 source_kind:'independently authored V29 expected vector; not an observed catalogue',
});

const rels="WITH rels AS MATERIALIZED(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'order_split210_'))";
const selection="t.tgrelid IN(SELECT oid FROM rels) OR starts_with(t.tgname,'order_split210_') OR t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))";
const originalTail='FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_constraint k ON k.oid=t.tgconstraint WHERE '+selection;
const candidateTail='FROM selected_triggers t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN trigger_constraint_names k ON k.oid=t.tgconstraint';
const localCtes=', selected_triggers AS MATERIALIZED(SELECT t.* FROM pg_catalog.pg_trigger t WHERE '+selection+')'
 +', trigger_constraint_names AS MATERIALIZED(SELECT needed.tgconstraint oid,(SELECT k.conname FROM pg_catalog.pg_constraint k WHERE k.oid=needed.tgconstraint) conname FROM(SELECT DISTINCT tgconstraint FROM selected_triggers) needed)';

/** Accept one finite authored SELECT, never caller-provided rows or predicates.
 * The original global trigger selection is moved unchanged into a local CTE.
 * Constraint names are looked up by every selected reference, including zero,
 * missing references and constraints outside the own relation/namespace scope.
 * PostgreSQL's planner determines the lookup plan; this source helper makes no
 * performance claim. Complete record expressions and other seven arms survive.
 */
export function deriveOrderSplit210TriggerConstraintMap(sourceSql){
 assert.equal(arguments.length,1,'one fixed authored SELECT argument');
 assert.equal(typeof sourceSql,'string','authored SELECT string required');
 const pin=ORDER_SPLIT210_TRIGGER_CONSTRAINT_MAP_SOURCE;
 assert.equal(Buffer.byteLength(sourceSql),pin.bytes,'exact finite Source29 SELECT bytes');
 assert.equal(sha(sourceSql),pin.sha256,'exact finite Source29 SELECT SHA');
 assert(sourceSql.startsWith(' WITH live_changed AS MATERIALIZED(')&&sourceSql.endsWith(';'),'complete authored capture SELECT');
 assert(!/\b(?:selected_triggers|trigger_constraint_names)\b/.test(sourceSql),'fresh invocation-local CTE names');

 const edits=[];
 function add(before,after,kind){
  const beforeStart=sourceSql.indexOf(before);
  assert(beforeStart>=0&&sourceSql.indexOf(before,beforeStart+1)<0,'one exact '+kind);
  edits.push({kind,beforeStart,before,after});
 }
 add(rels,rels+localCtes,'invocation_local_selected_trigger_constraint_names');
 add(originalTail,candidateTail,'reuse_selected_triggers_and_oid_constraint_names');
 edits.sort((a,b)=>a.beforeStart-b.beforeStart);
 let sql='',cursor=0;
 for(const edit of edits){
  assert(edit.beforeStart>=cursor,'disjoint complete source edits');
  sql+=sourceSql.slice(cursor,edit.beforeStart);
  edit.afterStart=sql.length;
  sql+=edit.after;
  cursor=edit.beforeStart+edit.before.length;
 }
 sql+=sourceSql.slice(cursor);
 let inverse=sql;
 for(const edit of [...edits].reverse()){
  assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);
  inverse=inverse.slice(0,edit.afterStart)+edit.before+inverse.slice(edit.afterStart+edit.after.length);
 }
 assert.equal(inverse,sourceSql,'whole finite authored SELECT inverse');
 assert.equal(sql.split(selection).length,2,'original global three-branch selector occurs once');
 assert.equal(sql.split('FROM pg_catalog.pg_trigger t').length,2,'one selected-trigger catalogue read');
 assert.equal(sql.split('FROM selected_triggers t').length,2,'one descriptor read of selected triggers');

 return freeze({
  schema:'order-split210-query-local-trigger-constraint-map/v1',
  sql,bytes:Buffer.byteLength(sql),sha256:sha(sql),edits,source_proofs:pin,
  scope:'one SQL statement',
  invariants:{original_selection_branches:3,other_catalogue_arms_unchanged:7,trigger_record_expression_unchanged:true,constraint_lookup:'every distinct selected tgconstraint OID; no namespace or own-scope filter',missing_constraint_name:null,empty_constraint_name_preserved:true,trigger_rows_not_deduplicated:true},
  whole_source_inverse_verified:true,cross_invocation_cache:false,new_runtime_functions:0,
  source_compilation_performed:false,sql_executed:false,performance_measured:false,
  native_certification:false,application_activation:false,business_acceptance:false,
 });
}
