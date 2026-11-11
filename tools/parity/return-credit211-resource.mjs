/** Pure Source211 install resource. No IO, PG, runtime activation or caller seal. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assembleReturnCredit211SourceCandidate} from './return-credit211-source.mjs';
import {RETURN_CREDIT211_SOURCE_CONTRACT as E211,RETURN_CREDIT211_SOURCE_ORIGIN as ORIGIN} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit211-source-contract.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const id=r=>r.kind+'\0'+r.key;
const order=(a,b)=>id(a)<id(b)?-1:id(a)>id(b)?1:0;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const literal=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
const digest=v=>assert(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'211 fixed independent Source digest required');

export const RETURN_CREDIT211_RESOURCE_DEFINITION=freeze({
 id:'sql:server/211_return_credit148_acceptance_install.sql',
 source:'server/211_return_credit148_acceptance_install.sql',
 path:'resources/server/211_return_credit148_acceptance_install.sql',consumer:'server/db.ts'
});
export const RETURN_CREDIT211_RESOURCE_MIGRATION=freeze({name:'211_return_credit148_acceptance',file:'211_return_credit148_acceptance_install.sql',parent:209,installs_split210:false});
export const RETURN_CREDIT211_NATIVE_RESOURCE=freeze({id:'return_credit211_native148_acceptance',path:'native/211_return_credit148_acceptance_install.sql'});

function sourceAuthority(candidate){
 assert.equal(ORIGIN.source_compilation_proven,true,'211 independently compiled fixed Source contract required');
 assert.equal(ORIGIN.independent_empty_source_database,true,'211 business-copy catalogue cannot authorize a seal');
 assert.equal(ORIGIN.sql_bytes,candidate.bytes);assert.equal(ORIGIN.sql_sha256,candidate.sha256);
 for(const key of ['compiler_sha256','compiler_receipt_sha256','root_review_sha256'])digest(ORIGIN[key]);
 assert.equal(E211.schema,'source211-return-credit148-exact-inverse/v1');
 assert.deepEqual(Object.keys(E211).sort(),['additions','changes','removed','schema']);
 assert(Array.isArray(E211.additions)&&E211.additions.length===140,'211 full source-compiled addition roster');
 assert.equal(new Set(E211.additions.map(id)).size,140);
 assert.deepEqual([...new Set(E211.additions.map(r=>r.kind))].sort(),['column','constraint','function','index','policy','relation','trigger','type']);
 assert.deepEqual(canonical([...E211.changes].sort(order)),canonical([...candidate.descriptor_changes].sort(order)),'211 all six complete AFTER records must equal authored ports');
 assert.deepEqual(canonical([...E211.removed].sort(order)),canonical([...candidate.removed_records].sort(order)),'211 exact two historical parent RI records');
}

/** Fixed Source authority is imported, never supplied by the caller. Native QA
 * follows installation and is not a prerequisite invented by this producer. */
export function buildReturnCredit211Resource(input){
 assert.equal(arguments.length,1);
 assert(input&&[Object.prototype,null].includes(Object.getPrototypeOf(input))&&!Array.isArray(input));
 const keys=['nativeSql','source148','source206','source207'];
 assert.deepEqual(Reflect.ownKeys(input).sort(),keys);
 const descriptors=Object.getOwnPropertyDescriptors(input);
 for(const key of keys)assert(Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable,'211 literal source inputs only');
 const candidate=assembleReturnCredit211SourceCandidate(input);sourceAuthority(candidate);
 const own=[...E211.additions].sort(order);
 // SQL JSONB arrays retain their order. The guard's closed source-plan order
 // differs from the compiler's catalogue order, so compare sets above and emit
 // exactly the authored order here. Retained old rows include real created_at.
 const changes=candidate.descriptor_changes,removed=candidate.removed_records;
 const sealSql=`
-- Expected new metadata is literal independent Source output. The three old
-- rows retain the already-authorized209 history; no current catalogue becomes expected.
DO $strings211$ BEGIN
 IF current_setting('standard_conforming_strings') IS DISTINCT FROM 'on' THEN
  RAISE EXCEPTION '211 standard SQL literal decoding required' USING ERRCODE='55000';END IF;
END $strings211$;
INSERT INTO public.return_credit211_metadata(id,profile,own_records,changes,removed,original206,original208,original209,source_compiler_sha256)
SELECT true,'209-to211-destinations148-credit/v1',
${literal(own)},
${literal(changes)},
${literal(removed)},
 (SELECT to_jsonb(m) FROM public.return_credit206_manifest m WHERE id),
 (SELECT to_jsonb(m) FROM public.return_credit208_manifest m WHERE id),
 (SELECT to_jsonb(m) FROM public.order_merge_delivery209_manifest m WHERE id),
 '${ORIGIN.compiler_sha256}';
DO $closing211$ BEGIN
 IF public.return_credit211_metadata_valid() IS DISTINCT FROM true THEN
  RAISE EXCEPTION '211 independently sourced complete install metadata differs' USING ERRCODE='55000';END IF;
END $closing211$;
`;
 const sql=candidate.sql+sealSql,bytes=Buffer.byteLength(sql),sha256=hash(sql);
 assert(bytes<=16777216,'211 existing16MiB resource limit');
 assert(!/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql),'211 transaction belongs to the normal migrator');
 return freeze({schema:'return-credit211-complete-install-resource/v1',sql,bytes,sha256,
  candidate:{bytes:candidate.bytes,sha256:candidate.sha256},seal:{sql:sealSql,bytes:Buffer.byteLength(sealSql),sha256:hash(sealSql)},
  definition:RETURN_CREDIT211_RESOURCE_DEFINITION,migration:RETURN_CREDIT211_RESOURCE_MIGRATION,
  native_edge:{...RETURN_CREDIT211_NATIVE_RESOURCE,sha256},
  storage:{path:RETURN_CREDIT211_NATIVE_RESOURCE.path,bytes,sha256,encoding:'identity'},
  source_authority:{compiler_sha256:ORIGIN.compiler_sha256,compiler_receipt_sha256:ORIGIN.compiler_receipt_sha256,root_review_sha256:ORIGIN.root_review_sha256},
  source_compilation_proven:true,source_compilation_performed:false,pg_calls:0,network_requests:0,
  native_certification:false,application_activation:false,business_acceptance:false});
}
