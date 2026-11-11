/** Import-inert query producer. No SQL dispatch, stored verdict or activation.
 * One fresh CURRENT descriptor set supplies two consumers in the same SQL
 * invocation: the original fingerprint and an independent expected-map check.
 * All24 fields and both complete-text digests remain in every function row. */
import assert from 'node:assert/strict';
import {deriveOrderMergeDelivery209Manifest} from './order-merge-delivery209-source.mjs';
import {HEADER205_SOURCE_CONTRACT as E205} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/header205-source-contract.mjs';
import {RECORDS_SQL} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS} from './order-merge-delivery209-startup-roster.mjs';

const keys=Object.freeze([
 ...['buyer_address_preview_guard','buyer_address_state_guard','buyer_address_guards','buyer_address_fingerprint'].map(name=>'public.'+name+'()'),
 ...E205.changes.map(change=>change.key),...E205.additions.map(row=>row.key),
]);
const quote=value=>"'"+value.replaceAll("'","''")+"'";
function replaceOnce(text,before,after){assert.equal(text.split(before).length,2,'exact closed source expression');return text.replace(before,()=>after);}

export function deriveOrderMergeDelivery209ValidationSnapshot({changes,runtimeRevision=21}={}){
 assert([21,22].includes(runtimeRevision),'explicit source snapshot revision');
 const sourceKeys=runtimeRevision===22?[...keys,...ORDER_MERGE_DELIVERY209_STARTUP_KEYS]:keys;
 assert(Array.isArray(changes)&&changes.length===sourceKeys.length,'complete fixed source function roster');
 assert(changes.every(change=>change.kind==='function'),'only function source changes');
 assert.deepEqual(changes.map(change=>change.key),sourceKeys,'exact ordered source function identities');
 const arms=RECORDS_SQL.split('\n').filter(line=>line.startsWith(" UNION ALL SELECT 'function',"));assert.equal(arms.length,1);
 let legacy=replaceOnce(arms[0].replace(/^ UNION ALL /,''),"WHERE n.nspname IN ('public','ordinary187_private')",
  "WHERE n.nspname='public' AND p.proname=ANY(ARRAY["+sourceKeys.map(key=>quote(key.slice(7,key.indexOf('(')))).join(',')+"]::text[])");
 for(const[field,expression]of [['source','p.prosrc'],['definition','pg_catalog.pg_get_functiondef(p.oid)']]){
  legacy=replaceOnce(legacy,"'"+field+"',"+expression,"'"+field+"',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to("+expression+",'UTF8')),'hex'))");
 }
 const original=deriveOrderMergeDelivery209Manifest(changes).split('$fp209$');assert.equal(original.length,3);
 const fingerprint=replaceOnce(original[1], 'FROM('+legacy+') legacy209(kind,key,value)', 'FROM legacy209_current legacy209(kind,key,value)');
 // The array retains every row and full identity. A missing function, unexpected
 // overload or duplicate must stay visible to the caller's strict roster check.
 // Do not replace this with an object keyed by name: it could hide duplicates.
 const query=`WITH legacy209_current(kind,key,value) AS MATERIALIZED (${legacy})
SELECT jsonb_build_object(
 'fingerprint',(${fingerprint}),
 'legacy',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'key',key,'value',value) ORDER BY key COLLATE "C"),'[]'::jsonb) FROM legacy209_current)
) AS snapshot`;
 const name='public.order_merge_delivery209_validation_snapshot';
 const sql=`CREATE FUNCTION ${name}() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $snapshot209$
${query}
$snapshot209$;
REVOKE ALL ON FUNCTION ${name}() FROM PUBLIC,dyna_app;
`;
 return Object.freeze({schema:'order-merge-delivery209-validation-snapshot-prototype/v1',query,sql,
  function_key:name+'()',fingerprint_source:'\n SELECT '+name+"()->>'fingerprint'\n",
  legacy_query:legacy,original_fingerprint_source:original[1],keys:sourceKeys,
  current_descriptor_fields:24,current_complete_text_digests:['source','definition'],
  materialization_scope:'one SQL invocation; fresh catalogue reads on every call',
  requires_independent_complete_ten_expected_checks:true,
  integrated:false,performance_measured:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}
