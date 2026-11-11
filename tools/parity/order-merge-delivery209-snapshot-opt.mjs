/** Unintegrated query experiment. No SQL dispatch, stored result or admission.
 * Hash both complete CURRENT text leaves; avoid reading compressed prosrc a
 * second time only when the deparser's entire byte framing is source-known. */
import assert from 'node:assert/strict';
import {deriveOrderMergeDelivery209ValidationSnapshot} from './order-merge-delivery209-validation-snapshot.mjs';

const fields=['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl'];
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const hex=s=>"pg_catalog.decode('"+Buffer.from(s,'utf8').toString('hex')+"','hex')";
const once=(s,a,b)=>{assert.equal(s.split(a).length,2,'one closed query edit');return s.replace(a,()=>b);};
const utf8=s=>assert.equal(Buffer.from(s,'utf8').toString('utf8'),s,'exact UTF8 source text');

function framing(change){
 const value=change.after;
 assert(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Object.keys(value).sort(),[...fields].sort(),'full source-derived24-field AFTER descriptor');
 for(const field of ['source','definition'])assert(value[field]===null||typeof value[field]==='string');
 // NULL/empty or a different deparser format is identity, never a guessed body.
 if(value.source===null||value.definition===null||value.source.length===0)return{key:change.key,prefix:null,suffix:null};
 utf8(value.source);utf8(value.definition);
 const position=value.definition.indexOf(value.source);
 assert(position>=0&&value.definition.indexOf(value.source,position+value.source.length)<0,'one complete source in authored definition');
 const prefix=value.definition.slice(0,position),suffix=value.definition.slice(position+value.source.length);
 const tag=/\bAS (\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)$/.exec(prefix);
 assert(tag&&suffix===tag[1]+'\n','entire source-derived deparser framing');
 return{key:change.key,prefix,suffix};
}

/** changes may be the accepted E18 basis or another explicit source assembly.
 * Their headers select an optimization, not a runtime verdict: every mismatch
 * reads/hashes the original actual prosrc. No authored hash replaces live data.
 * The original fresh own8/constraints/fingerprint and all CURRENT24 stay intact.
 */
export function deriveOrderMergeDelivery209SnapshotOpt({changes}={}){
 const original=deriveOrderMergeDelivery209ValidationSnapshot({changes});
 const bounds=changes.map(framing);
 const scope=original.legacy_query.slice(original.legacy_query.lastIndexOf(' WHERE ')+1);
 assert(scope.startsWith("WHERE n.nspname='public' AND p.proname=ANY(ARRAY["));
 const identity="n.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')'";
 const boundsSql=bounds.map(b=>'('+quote(b.key)+','+(b.prefix===null?'NULL::bytea':hex(b.prefix))+','+(b.suffix===null?'NULL::bytea':hex(b.suffix))+')').join(',\n');
 const cte=`definition209_bounds(key,prefix,suffix) AS (VALUES ${boundsSql}),
definition209_bytes(oid,definition_bytes,prefix,suffix) AS MATERIALIZED (
 SELECT p.oid,pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),b.prefix,b.suffix
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 LEFT JOIN definition209_bounds b ON b.key=${identity}
 ${scope}
), `;
 const sourceBytes=`CASE WHEN p.prosrc IS NOT NULL AND d209.definition_bytes IS NOT NULL
 AND d209.prefix IS NOT NULL AND d209.suffix IS NOT NULL
 AND pg_catalog.octet_length(d209.definition_bytes)=pg_catalog.octet_length(d209.prefix)+pg_catalog.octet_length(p.prosrc)+pg_catalog.octet_length(d209.suffix)
 AND pg_catalog.substring(d209.definition_bytes,1,pg_catalog.octet_length(d209.prefix))=d209.prefix
 AND pg_catalog.substring(d209.definition_bytes,pg_catalog.octet_length(d209.definition_bytes)-pg_catalog.octet_length(d209.suffix)+1)=d209.suffix
 THEN pg_catalog.substring(d209.definition_bytes,pg_catalog.octet_length(d209.prefix)+1,pg_catalog.octet_length(p.prosrc))
 ELSE convert_to(p.prosrc,'UTF8') END`;
 let legacy=once(original.legacy_query,"convert_to(p.prosrc,'UTF8')",sourceBytes);
 legacy=once(legacy,"convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')",'d209.definition_bytes');
 const join=' JOIN definition209_bytes d209 ON d209.oid=p.oid';
 legacy=once(legacy,' '+scope,join+' '+scope);
 let query=once(original.query,original.legacy_query,legacy);
 query=once(query,'WITH legacy209_current','WITH '+cte+'legacy209_current');
 return Object.freeze({schema:'order-merge-delivery209-definition-bytes-prototype/v1',query,legacy_query:legacy,
  original_query:original.query,original_legacy_query:original.legacy_query,keys:original.keys,
  framing:Object.freeze(bounds.map(b=>Object.freeze(b))),definition_cte:cte,source_bytes_expression:sourceBytes,join,
  current_descriptor_fields:24,current_complete_text_digests:Object.freeze(['source','definition']),
  fallback:'original actual prosrc UTF8 bytes on every framing, length, identity, NULL or deparser mismatch',
  materialization_scope:'one fresh SQL invocation; memory/spill and latency require actual measurement',
  integrated:false,performance_measured:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}
