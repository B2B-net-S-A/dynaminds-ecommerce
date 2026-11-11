/** Unintegrated source-only hash-leaf prototype. No SQL dispatch or verdict cache.
 * The original complete BEFORE records are authenticated Source18 source data;
 * CURRENT AFTER authority remains the producer's fresh checked frame and the
 * complete current24-field descriptor comparison, exactly as the local port. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RECORDS_SQL} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {orderMergeDelivery209HistorySqlSpans as sqlSpans} from './order-merge-delivery209-history-closure.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS,assertOrderMergeDelivery209StartupBeforeRecords} from './order-merge-delivery209-startup-roster.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const port='public.order_merge_delivery209_predecessor_source_sha';
// Actual pure producer order: four166 bodies, five E205 changes, E205 addition.
const orderedKeys=Object.freeze([
 'public.buyer_address_preview_guard()','public.buyer_address_state_guard()',
 'public.buyer_address_guards()','public.buyer_address_fingerprint()',
 'public.manual_inventory_off_valid()','public.manual_inventory_off_projection_valid()',
 'public.partial_sale204_predecessor_definition(fn oid)','public.ordinary187_valid()',
 'public.partial_sale204_valid()','public.catalog_header205_valid()',
]);
export const ORDER_MERGE_DELIVERY209_SOURCE_HASH_BASIS=Object.freeze({
 source18_sql_sha256:'9e25cb8442f85380eac367c26ba0d0c9fd0f7f6ac1588ed281cab153d9d8b50d',
 complete_before_records_sha256:'cd5e38c4b46b18097e86f15bef632399a1e6401f594e82f4f38d3d9686dcbc1c',
 keys:orderedKeys,
});

// Literal complete-source hashes from the independently compiled Source18
// BEFORE basis above. Tests independently compare all ten against E209. Keeping
// this tiny authored witness avoids decoding a second21MiB contract on every
// predecessor import. Integration also checks its genuine source-derived full24
// BEFORE records against the independent complete-record pin before using it.
const beforeSourceHashes=Object.freeze([
 '817e2208f8b50ee3001a8464abad94f08af9a04393f1725e049b6db7bf765bc5','62e9b023a3844b2ca9aec06d475ea613350eb6e237d73082d18fcbba87a42142',
 '75ab6f265b618add8a010604d481dc0288f32514fb263b300be9abc53cde212f','4b178b83cf59e8ee2a3dcbfb367e6a34c35606bb29d186ae3ed1d7a666847a40',
 '3637b07cf0264174a485e3d7d452eebd5ab4481e3cd20dc6a79793c083445edc','3f9ed52437f974554bd5c0325611b64720ee00d2ad8ef65e8cac776051ebd6a0',
 '92f745c369cd57e7e549b22610f8111fc71eea00f63977c17c2cc00a4f11d9bd','bdb7ec232f3ea92aaa9e04fe4cef5d19949f6fe4374aa0981d5ef1d0d7f5a1c5',
 '1d6d6f2c72c2d3b4f552a36868ce3dda568859f9b8593e414865b144a3f170a4','a5b50c0041d1e5063273df117f061c0565e3f33666125b59d2ed77c83ad94568',
]);
function sourceBeforeRecords(records,runtimeRevision=21){
 assert([21,22].includes(runtimeRevision),'explicit source hash-port revision');
 let startup=[];
 if(runtimeRevision===22){
  assert(Array.isArray(records)&&records.length===10+ORDER_MERGE_DELIVERY209_STARTUP_KEYS.length,'Source22 requires the complete fixed source BEFORE roster');
  assert.deepEqual(records.map(record=>record.key),[...orderedKeys,...ORDER_MERGE_DELIVERY209_STARTUP_KEYS]);
  startup=records.slice(10);assertOrderMergeDelivery209StartupBeforeRecords(startup);
  records=records.slice(0,10);
 }
 if(records!==undefined){
  assert(Array.isArray(records));assert.equal(records.length,10);assert.equal(new Set(records.map(record=>record.key)).size,10);
  assert.deepEqual([...orderedKeys].sort(),records.map(record=>record.key).sort());
  for(const record of records){assert.equal(record.kind,'function');assert.equal(Object.keys(record.value).length,24);assert.equal(typeof record.value.source,'string');}
  const sorted=records.slice().sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  assert.equal(sha(JSON.stringify(canonical(sorted))),ORDER_MERGE_DELIVERY209_SOURCE_HASH_BASIS.complete_before_records_sha256,'complete independently compiled source BEFORE basis');
  for(let index=0;index<10;index++)assert.equal(sha(records.find(record=>record.key===orderedKeys[index]).value.source),beforeSourceHashes[index]);
 }
 return [...orderedKeys.map((key,index)=>({key,source_sha256:beforeSourceHashes[index]})),
  ...startup.map(record=>({key:record.key,source_sha256:sha(record.value.source)}))];
}

function currentCheckQuery(){
 const arms=RECORDS_SQL.split('\n').filter(line=>line.startsWith(" UNION ALL SELECT 'function',"));assert.equal(arms.length,1);
 let query=arms[0].replace(/^ UNION ALL /,'');
 const scope="WHERE n.nspname IN ('public','ordinary187_private')";assert.equal(query.split(scope).length,2);query=query.replace(scope,'WHERE p.oid=fn');
 for(const[field,expression]of [['source','p.prosrc'],['definition','pg_catalog.pg_get_functiondef(p.oid)']]){
  const from="'"+field+"',"+expression;assert.equal(query.split(from).length,2);
  query=query.replace(from,"'"+field+"',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to("+expression+",'UTF8')),'hex'))");
 }
 return query;
}

/** projectionBasis is an explicit PURE assembler result, never an observed row
 * or runtime argument to the SQL function. Independent compilation and sealing
 * are still required before any installation. No AFTER descriptor is weakened. */
export function deriveOrderMergeDelivery209SourceHashPort({projectionBasis,beforeRecords,runtimeRevision=21}){
 assert(projectionBasis&&Object.keys(projectionBasis).sort().join(',')==='bytes,sha256','explicit pure source projection basis');
 assert(Number.isSafeInteger(projectionBasis.bytes)&&projectionBasis.bytes>0&&projectionBasis.bytes<=134217728);
 assert(typeof projectionBasis.sha256==='string'&&/^[a-f0-9]{64}$/.test(projectionBasis.sha256));
 const records=sourceBeforeRecords(beforeRecords,runtimeRevision),names=records.map(record=>record.key.slice(7,record.key.indexOf('(')));
 const selected='CASE actual_key '+records.map((record,index)=>'WHEN '+quote(record.key)+' THEN entries->'+index).join(' ')+' ELSE NULL END';
 const hashes='CASE actual_key '+records.map(record=>'WHEN '+quote(record.key)+' THEN '+quote(record.source_sha256)).join(' ')+' ELSE NULL END';
 const sql=`CREATE FUNCTION ${port}(fn oid,entries jsonb) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $source_sha209$
DECLARE live jsonb;actual_key text;entry jsonb;total integer;scoped boolean;actual_sha text;source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;BEGIN
 SELECT n.nspname='public' AND p.proname=ANY(ARRAY[${names.map(quote).join(',')}]::text[]) INTO scoped FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=fn;
 IF NOT FOUND THEN RAISE EXCEPTION '209 missing unchanged function' USING ERRCODE='55000';END IF;
 IF scoped IS DISTINCT FROM true THEN
  -- Identity hash only: no transformation or admission for an unchanged name.
  SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') INTO actual_sha FROM pg_catalog.pg_proc p WHERE p.oid=fn;
  RETURN actual_sha;
 END IF;
 SELECT key,value INTO actual_key,live FROM(${currentCheckQuery()}) projected(kind,key,value);
 IF live IS NULL THEN RAISE EXCEPTION '209 missing unchanged function' USING ERRCODE='55000';END IF;
 IF jsonb_typeof(entries) IS DISTINCT FROM 'array' OR jsonb_array_length(entries)<>${records.length} THEN RAISE EXCEPTION '209 invocation frame required' USING ERRCODE='55000';END IF;
 SELECT count(*) INTO total FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND 'public.'||p.proname=split_part(actual_key,'(',1);
 entry:=${selected};
 IF total<>1 OR entry IS NULL OR entry->>'key' IS DISTINCT FROM actual_key OR live IS DISTINCT FROM entry->'after_check' THEN RAISE EXCEPTION '209 exact current descriptor required' USING ERRCODE='55000';END IF;
 -- Same fresh source-row identity and digest checks; no large before_i value is
 -- needed for a hash that is already a literal authenticated source constant.
 SELECT count(*) OVER(),id,payload IS NOT NULL,payload_octets,payload_sha256 INTO total,source_id,payload_present,payload_bytes,payload_hash FROM public.order_merge_delivery209_projection_basis;
 IF total IS DISTINCT FROM 1 OR source_id IS DISTINCT FROM true OR payload_present IS DISTINCT FROM true
  OR payload_bytes IS DISTINCT FROM ${projectionBasis.bytes} OR payload_hash IS DISTINCT FROM ${quote(projectionBasis.sha256)}
  THEN RAISE EXCEPTION '209 exact selected source predecessor required' USING ERRCODE='55000';END IF;
 RETURN ${hashes};
END$source_sha209$;
REVOKE ALL ON FUNCTION ${port}(oid,jsonb) FROM PUBLIC,dyna_app;
`;
 return Object.freeze({schema:'order-merge-delivery209-source-hash-port-prototype/v1',sql,port_key:port+'(fn oid, entries jsonb)',
  before_hashes:Object.freeze(records.map(record=>Object.freeze({key:record.key,sha256:record.source_sha256}))),
  source_basis:ORDER_MERGE_DELIVERY209_SOURCE_HASH_BASIS,requires_fresh_full10_producer_frame:runtimeRevision===21,
  ...(runtimeRevision===22?{requires_fresh_startup_producer_frame:true,current_source_functions:records.length}:{}),
  preserves_selected_current_full24_validation:true,requires_own_fingerprint_and_all_nonowner_acl_seal:true,
  removed_work:'Selected BEFORE JSONB detoast/source extraction and UTF8 hashing. Current AFTER source/definition hashes, every other current descriptor field, overload/frame and fresh source-row digest checks remain.',
  integrated:false,performance_measured:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}

/** Closed literal-aware hash expression selector. It intentionally leaves all
 * plain text/length/NULL/equality reads alone, and rejects an unexpected count.
 * Comments embedded in the selected expression are refused, never discarded. */
export function rewriteOrderMergeDelivery209SourceHashes(source,{expectedSites,frameName='merge_delivery209_local_frame'}){
 assert(typeof frameName==='string'&&/^[a-z_][a-z_0-9]{0,62}$/.test(frameName),'fixed SQL frame identifier');
 assert(Number.isSafeInteger(expectedSites)&&expectedSites>=0&&expectedSites<=200);
 let offset=0;const parts=sqlSpans(source).map(span=>{const part={...span,start:offset,end:offset+span.text.length};offset=part.end;return part;});
 const allowed=part=>part.executable||part.text==="'UTF8'"||part.text==="'hex'";
 const visible=parts.map(part=>allowed(part)?part.text:part.text.replace(/[^\n]/g,' ')).join('');
 const expression=/(?<![A-Za-z_0-9.])encode\s*\(\s*sha256\s*\(\s*convert_to\s*\(\s*public\.order_merge_delivery209_predecessor_source\(\s*((?:[A-Za-z_][A-Za-z_0-9]*\.)?oid|fn)\s*,\s*merge_delivery209_local_frame\s*\)\s*,\s*'UTF8'\s*\)\s*\)\s*,\s*'hex'\s*\)/;
 const selectedExpression=new RegExp(expression.source.replace('merge_delivery209_local_frame',frameName),'g');
 const matches=[...visible.matchAll(selectedExpression)];assert.equal(matches.length,expectedSites,'exact closed hash-expression roster');
 const replacements=[];let cursor=0,result='';
 for(const match of matches){
  const start=match.index,end=start+match[0].length;
  assert(!parts.some(part=>part.start<end&&part.end>start&&!allowed(part)),'no historical/comment bytes inside a selected hash expression');
  result+=source.slice(cursor,start);const after=port+'('+match[1]+', '+frameName+')',rewritten_start=result.length;
  result+=after;replacements.push(Object.freeze({start,end,rewritten_start,rewritten_end:result.length,before:source.slice(start,end),after}));cursor=end;
 }
 result+=source.slice(cursor);
 return Object.freeze({source:result,count:replacements.length,replacements:Object.freeze(replacements),standalone_text_reads_preserved:true,integrated:false});
}
