/** Source-derived209->205 metadata closure. Import-inert; never dispatches SQL or observes a DB. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {HEADER205_SOURCE_CONTRACT as E205} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/header205-source-contract.mjs';
import {RECORDS_SQL} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {deriveOrderMergeDelivery209Bodies} from './order-merge-delivery209-source.mjs';
import {deriveOrderMergeDelivery209HistoryClosure} from './order-merge-delivery209-history-closure.mjs';
import {deriveOrderMergeDelivery209WaveClosure} from './order-merge-delivery209-wave-closure.mjs';
import {deriveOrderMergeDelivery209BuyerClosure} from './order-merge-delivery209-buyer-closure.mjs';
import {deriveOrderMergeDelivery209SourceHashPort,rewriteOrderMergeDelivery209SourceHashes} from './order-merge-delivery209-source-hash-port.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS} from './order-merge-delivery209-startup-roster.mjs';
import {deriveOrderMergeDelivery209StartupClosure,projectOrderMergeDelivery209StartupMetadata} from './order-merge-delivery209-startup-capability-closure.mjs';
import {deriveOrderMergeDelivery209PimStartupSharing} from './order-merge-delivery209-pim-startup-sharing.mjs';

const prefix='public.order_merge_delivery209_',sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const quote=v=>"'"+v.replaceAll("'","''")+"'";
const buyerKeys=['buyer_address_preview_guard','buyer_address_state_guard','buyer_address_guards','buyer_address_fingerprint'].map(n=>'public.'+n+'()');
const helperNames=['projection_map','predecessor_descriptor','predecessor_definition','predecessor_source','predecessor_metadata'];

/** Split comments and SQL literals from executable text, preserving every byte and span. */
export function orderMergeDelivery209SqlSpans(source){
 assert.equal(typeof source,'string');const out=[];let i=0,start=0;
 const emit=(end,executable)=>{if(end>start)out.push({executable,text:source.slice(start,end)});start=end;};
 while(i<source.length){
  let end;
  if(source.startsWith('--',i)){end=source.indexOf('\n',i+2);if(end<0)end=source.length;}
  else if(source.startsWith('/*',i)){let depth=1;end=i+2;while(depth&&end<source.length){if(source.startsWith('/*',end)){depth++;end+=2;}else if(source.startsWith('*/',end)){depth--;end+=2;}else end++;}assert.equal(depth,0,'unterminated SQL comment');}
  else if(source[i]==="'"||source[i]==='"'){
   const q=source[i],escaped=q==="'"&&/[Ee]/.test(source[i-1]??'')&&!/[A-Za-z_0-9]/.test(source[i-2]??'');end=i+1;let closed=false;
   while(end<source.length){if(escaped&&source[end]==='\\'){end+=2;continue;}if(source[end]===q){if(source[end+1]===q){end+=2;continue;}end++;closed=true;break;}end++;}assert(closed,'unterminated SQL quoted token');
  }else{
   const dollar=/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(i));
   if(dollar){const closing=source.indexOf(dollar[0],i+dollar[0].length);assert(closing>=0,'unterminated SQL dollar literal');end=closing+dollar[0].length;}
  }
  if(end!==undefined){emit(i,true);emit(end,false);i=end;}else i++;
 }
 emit(source.length,true);assert.equal(out.map(s=>s.text).join(''),source);return out;
}

export function projectOrderMergeDelivery209Source(source,{frame}={}){
 if(frame!==undefined)assert(/^[a-z_][a-z_0-9]*$/.test(frame));
 const counts={source_reads:0,definition_reads:0,metadata_reads:0};
 const spans=orderMergeDelivery209SqlSpans(source);
 const projected=spans.map(s=>{
  if(!s.executable)return s.text;
  return s.text
   .replace(/\b(?:public\.)?pg_get_functiondef\s*\(\s*(p\.oid|fn)\s*\)/g,(_m,arg)=>{counts.definition_reads++;return prefix+'predecessor_definition('+arg+(frame?', '+frame:'')+')';})
   .replace(/\b(?:(\w+)\.)?prosrc\b/g,(_m,alias)=>{counts.source_reads++;return prefix+'predecessor_source('+(alias?alias+'.':'')+'oid'+(frame?', '+frame:'')+')';})
   .replace(/\b(?:public\.)?(large_import173_metadata|large_import173_predecessor_map)\s*\(\s*\)/g,(_m,name)=>{counts.metadata_reads++;return prefix+'predecessor_metadata(public.'+name+'()'+(frame?', '+frame:'')+')';});
 }).join('');
 assert(counts.source_reads>0,'closed source must actually read pg_proc source');
 assert(!orderMergeDelivery209SqlSpans(projected).some(s=>s.executable&&/\b(?:public\.)?pg_get_functiondef\s*\(/.test(s.text)),'unrecognized complete-definition read');
 return{source:projected,counts};
}

function successor(before,source){
 assert.equal(before.definition.split(before.source).length,2,'one complete source in full definition');
 return{...structuredClone(before),source,definition:before.definition.replace(before.source,()=>source)};
}
function exactChanges(changes,source166){
 const expected=deriveOrderMergeDelivery209Bodies({source166});
 assert.deepEqual(canonical(changes),canonical(expected),'four literal-source buyer changes, no caller/observed adoption');
 assert.deepEqual(changes.map(c=>c.key),buyerKeys);
}
function functionQuery({textDigests=false}={}){
 const rows=RECORDS_SQL.split('\n').filter(s=>s.startsWith(" UNION ALL SELECT 'function',"));assert.equal(rows.length,1);
 const q=rows[0].replace(/^ UNION ALL /,'');const needle="WHERE n.nspname IN ('public','ordinary187_private')";
 assert.equal(q.split(needle).length,2);let sql=q.replace(needle,'WHERE p.oid=fn');
 if(textDigests)for(const[field,expression]of [['source','p.prosrc'],['definition','pg_catalog.pg_get_functiondef(p.oid)']]){
  const before="'"+field+"',"+expression;assert.equal(sql.split(before).length,2,'one complete current text leaf');
  sql=sql.replace(before,"'"+field+"',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to("+expression+",'UTF8')),'hex'))");
 }
 return sql;
}

// Source-authored expected representation, not an observed catalogue or a
// cached verdict. SQL NULL text becomes a tagged JSON null, not empty text.
export function projectOrderMergeDelivery209FunctionCheck(value){
 assert(value&&typeof value==='object'&&!Array.isArray(value));
 const result=structuredClone(value);
 for(const field of ['source','definition']){
  assert(Object.hasOwn(value,field));assert(value[field]===null||typeof value[field]==='string');
  if(value[field]!==null)assert.equal(Buffer.from(value[field],'utf8').toString('utf8'),value[field],'valid UTF8 text leaf');
  result[field]=['sha256-utf8-text/v1',value[field]===null?null:sha(value[field])];
 }
 return result;
}

/** Pure independent JS oracle for the emitted descriptor projection, useful to reviewers.
 * Merely possessing this output does not confer any runtime admission. */
export function projectOrderMergeDelivery209Descriptor(records,changes,key){
 assert(Array.isArray(records)&&Array.isArray(changes));
 const name=key.slice(0,key.indexOf('('));
 if(!changes.some(c=>c.key.slice(0,c.key.indexOf('('))===name)){
  const actual=records.filter(r=>r.kind==='function'&&r.key===key);
  assert.equal(actual.length,1,'missing/duplicate unchanged function');
  return structuredClone(actual[0].value); // identity only: preserve every current field, including drift
 }
 for(const member of changes){const name=member.key.slice(0,member.key.indexOf('('));
  const selected=records.filter(r=>r.kind==='function'&&r.key.slice(0,r.key.indexOf('('))===name);
  assert.equal(selected.length,1,'missing/duplicate/overloaded projected function');assert.equal(selected[0].key,member.key);
  assert.deepEqual(canonical(selected[0].value),canonical(member.after),'only exact complete AFTER descriptor');
 }
 const change=changes.find(c=>c.key===key);assert(change,'unscoped descriptor request');
 return structuredClone(change.before);
}

export function deriveOrderMergeDelivery209Predecessor({changes,source166,source204,source181,source168,runtimeRevision=source204===undefined?18:19}){
 exactChanges(changes,source166);
 assert([18,19,20,21,22].includes(runtimeRevision),'explicit supported source revision');
 if(runtimeRevision===18)assert.equal(source204,undefined,'Source18 has no indirect history adapters');
 if(source181!==undefined)assert([20,21,22].includes(runtimeRevision),'Source181 closure requires explicit Source20 or21');
 if(runtimeRevision>=20)assert.equal(typeof source181,'string','Source20/21 needs literal Source181');
 if(source168!==undefined)assert.equal(runtimeRevision,22,'Source168 sharing requires explicit Source22');
 if(runtimeRevision===22)assert.equal(typeof source168,'string','Source22 requires literal Source168 for complete PIM sharing');
 // Absence reproduces the independently compiled historical Source18 exactly.
 // New compilation explicitly supplies the pinned Source204. These adapters
 // preserve the old177/181 routines and DATA while closing their indirect reads.
 const closures=runtimeRevision===18?[]:[
  deriveOrderMergeDelivery209HistoryClosure({source204,runtimeRevision}),
  deriveOrderMergeDelivery209WaveClosure({source204}),
  ...(runtimeRevision>=20?[deriveOrderMergeDelivery209BuyerClosure({source204,source181})]:[]),
 ];
 assert.equal(E205.changes.length,5);assert.equal(E205.additions.length,1);
 const frame='merge_delivery209_local_frame';
 const startup=runtimeRevision===22?deriveOrderMergeDelivery209StartupClosure({source204}):null;
 const sharing=runtimeRevision===22?deriveOrderMergeDelivery209PimStartupSharing({source204,source168}):null;
 if(sharing){assert.equal(sharing.complete_source_derivation,true);assert.equal(sharing.helpers.length,4);assert.deepEqual(sharing.changes.map(c=>c.key),['public.pim_dictionary_valid()']);}
 const rosterSize=runtimeRevision===22?10+ORDER_MERGE_DELIVERY209_STARTUP_KEYS.length:10;
 const inputs=[...E205.changes.map(c=>({kind:c.kind,key:c.key,value:c.after})),E205.additions[0],
  ...(startup?startup.changes.map(c=>({kind:c.kind,key:c.key,value:c.before})):[])];
 assert.equal(inputs[5].key,'public.catalog_header205_valid()');
 if(startup)assert.deepEqual(startup.changes.map(c=>c.key),ORDER_MERGE_DELIVERY209_STARTUP_KEYS);
 const signatures=[...changes.map(change=>change.key),...inputs.map(record=>record.key)]
  .map(key=>key==='public.partial_sale204_predecessor_definition(fn oid)'?'public.partial_sale204_predecessor_definition(oid)':key);
 assert.equal(signatures.length,rosterSize);assert.equal(new Set(signatures).size,rosterSize);
 for(const signature of signatures)assert(/^public\.[a-z_][a-z_0-9]*\((?:oid)?\)$/.test(signature),'fixed typed function identity');
 const typedOids='ARRAY['+signatures.map(signature=>quote(signature)+'::regprocedure').join(',')+']::oid[]';
 const hashSites={
  'public.manual_inventory_off_valid()':2,'public.manual_inventory_off_projection_valid()':0,
  'public.partial_sale204_predecessor_definition(fn oid)':23,'public.ordinary187_valid()':78,
  'public.partial_sale204_valid()':1,'public.catalog_header205_valid()':7,
  'public.pim_dictionary_valid()':11,'public.nested172_valid()':3,
  'public.parcel_physical_wz_valid()':11,'public.operative_delivery_valid()':1,
  'public.wave_print177_valid()':4,'public.cooperation171_valid()':11,'public.packed_label_print_guards()':1,
 };
 const enterFrame=(projectedSource,key)=>{
  const parts=orderMergeDelivery209SqlSpans(projectedSource);let declared=false,started=false;
  const source=parts.map(s=>{if(!s.executable)return s.text;let text=s.text;
   if(!declared&&!started&&/\bDECLARE\b/i.test(text)){text=text.replace(/\bDECLARE\b/i,m=>m+' '+frame+' jsonb;');declared=true;}
   if(!started&&/\bBEGIN\b/i.test(text)){
    const selected=key==='public.partial_sale204_predecessor_definition(fn oid)';
    const acquire=frame+':='+prefix+'checked_projection_map('+(selected?'fn':'')+');';
    const initialize=runtimeRevision>=20&&selected
     ?'IF fn=ANY('+typedOids+') THEN '+acquire+' ELSE '+frame+':=NULL;END IF;'
     :acquire;
    text=text.replace(/\bBEGIN\b/i,m=>(declared?'':'DECLARE '+frame+' jsonb;\n')+m+'\n '+initialize);started=true;
   }return text;
  }).join('');assert(started,'closed PLpgSQL entry required');return source;
 };
 const derived=inputs.map(r=>{
  assert.equal(r.value.language,'plpgsql');assert(!r.value.source.includes(frame));
  const targeted=startup?.changes.find(change=>change.key===r.key);
  if(targeted)assert.deepEqual(canonical(targeted.before),canonical(r.value),'literal startup BEFORE record');
  const shared=sharing?.changes.find(change=>change.key===r.key);
  if(shared){assert.deepEqual(canonical(shared.before),canonical(r.value),'literal PIM sharing BEFORE record');assert.equal(targeted.after.source,r.value.source,'PIM targeted stages must not overlap');}
  const p=projectOrderMergeDelivery209Source(shared?.after.source??targeted?.after.source??r.value.source,{frame});
  // A frame exists only within this invocation. The original exception block and
  // declaration initializers keep their order; no session/GUC/cache is involved.
  let projectedSource=p.source;
  for(const closure of closures){
   const edit=closure.replacement;if(edit.key!==r.key)continue;let sites=0;
   projectedSource=orderMergeDelivery209SqlSpans(projectedSource).map(span=>{
    if(!span.executable)return span.text;
    sites+=span.text.split(edit.before).length-1;
    return span.text.replaceAll(edit.before,edit.after);
   }).join('');
   assert.equal(sites,edit.expected_executable_occurrences,'exact source-authored runtime closure edge');
  }
  let source=enterFrame(projectedSource,r.key);
  if(runtimeRevision>=21)source=rewriteOrderMergeDelivery209SourceHashes(source,{expectedSites:hashSites[r.key]}).source;
  return{kind:'function',key:r.key,before:structuredClone(r.value),after:successor(r.value,source),projection_counts:p.counts};
 });
 const all=[...changes,...derived.map(({projection_counts,...c})=>c)];
 assert.equal(new Set(all.map(c=>c.key)).size,rosterSize);
 const map=all.map(c=>({key:c.key,before:c.before,after:c.after,after_check:projectOrderMergeDelivery209FunctionCheck(c.after)}));
 const mapText=JSON.stringify(map);assert(Buffer.byteLength(mapText)<=134217728,'finite source-derived projection budget');assert(!mapText.includes('$map209$'),'dollar delimiter cannot occur in complete source map');
 const basis={bytes:Buffer.byteLength(mapText),sha256:sha(mapText)};
 const hashPort=runtimeRevision>=21?deriveOrderMergeDelivery209SourceHashPort({projectionBasis:basis,beforeRecords:all.map(c=>({kind:c.kind,key:c.key,value:c.before})),runtimeRevision}):null;
 if(startup){
  // The existing private wave clone observes the same changed public roots.
  // Keep all its original checks, projecting both metadata and live source to
  // the same authenticated BEFORE side, with its own fresh invocation frame.
  const closure=closures.find(closure=>closure.helpers?.some(helper=>helper.key===startup.existing_helper_projection.key));
  assert(closure,'source-owned existing wave helper');
  const old=closure.helpers.find(helper=>helper.key===startup.existing_helper_projection.key);
  const targeted=projectOrderMergeDelivery209StartupMetadata(old.value.source,{frameName:frame});
  const projected=projectOrderMergeDelivery209Source(targeted.source,{frame});
  const source=rewriteOrderMergeDelivery209SourceHashes(enterFrame(projected.source,old.key),{expectedSites:4}).source;
  const updated={...old,value:successor(old.value,source)};
  const oldDdl=old.value.definition.trimEnd();
  assert.equal(closure.sql.split(oldDdl).length,2,'one complete existing wave definition');
  closures[closures.indexOf(closure)]={...closure,
   sql:closure.sql.replace(oldDdl,()=>updated.value.definition.trimEnd()),
   helpers:closure.helpers.map(helper=>helper===old?updated:helper)};
 }
 const sharingHelpers=sharing?sharing.helpers.map((helper,index)=>{
  const expected=sharing.expected_projection_counts[index];assert.equal(expected.key,helper.key);
  if(expected.identity){
   assert.equal(helper.key,'public.order_merge_delivery209_pim_issuer_guards(entries jsonb, wave_ok boolean)');
   const code=orderMergeDelivery209SqlSpans(helper.value.source).filter(span=>span.executable).map(span=>span.text).join(' ');
   assert(!/\bprosrc\b|\bpg_get_functiondef\s*\(|\b(?:large_import173_metadata|large_import173_predecessor_map)\s*\(/.test(code),'issuer has no live source or metadata read to project');
   assert.deepEqual(expected.counts,{source_reads:0,definition_reads:0,metadata_reads:0});assert.equal(expected.source_hash_sites,0);return helper;
  }
  const projected=projectOrderMergeDelivery209Source(helper.value.source,{frame:'entries'});
  assert.deepEqual(projected.counts,expected.counts,'closed private PIM source projection roster');
  const rewritten=rewriteOrderMergeDelivery209SourceHashes(projected.source,{expectedSites:expected.source_hash_sites,frameName:'entries'});
  return{...helper,value:successor(helper.value,rewritten.source)};
 }):[];
 const sharingSql=sharingHelpers.map(helper=>helper.value.definition.trimEnd()+';\nREVOKE ALL ON FUNCTION '+helper.key.replace('entries jsonb, wave_ok boolean','jsonb,boolean')+' FROM PUBLIC,dyna_app;').join('\n');
 const liveQuery=functionQuery();
 const liveCheckQuery=functionQuery({textDigests:true});
 const scopedNames=all.map(c=>c.key.slice('public.'.length,c.key.indexOf('(')));
 assert.equal(new Set(scopedNames).size,rosterSize);
 const namesSql='ARRAY['+scopedNames.map(quote).join(',')+']::text[]';
 // Keep the literal193 single-entry selection path: the isolated actual
 // descriptor comparison returned identical complete BEFORE values for both variants.
 const indexedEntry='CASE actual_key '+all.map((c,i)=>'WHEN '+quote(c.key)+' THEN entries->'+i).join(' ')+' ELSE NULL END';
 const keysSql='ARRAY['+all.map(c=>quote(c.key)).join(',')+']::text[]';
 // Most legacy reads concern unchanged functions. Read their actual text
 // directly; constructing a complete JSON descriptor would serialize source,
 // definition and every metadata field only to discard all but one text leaf.
 // Exact projected names (including unexpected overloads) still use the strict
 // descriptor path. Neither a caller frame nor an unchanged text grants trust.
 const textProjector=(field,local=false)=>{
  const tag=(local?'local_':'')+(field==='source'?'source209':'definition209');
  return `CREATE FUNCTION ${prefix}predecessor_${field}(fn oid${local?',entries jsonb':''}) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $${tag}$
DECLARE scoped boolean;actual text;BEGIN
 SELECT n.nspname='public' AND p.proname=ANY(${namesSql}) INTO scoped FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=fn;
 IF NOT FOUND THEN RAISE EXCEPTION '209 missing unchanged function' USING ERRCODE='55000';END IF;
 IF scoped IS DISTINCT FROM true THEN
  -- Identity text only: preserve current bytes, without JSON expansion or admission.
  SELECT ${field==='source'?'p.prosrc':'pg_catalog.pg_get_functiondef(p.oid)'} INTO actual FROM pg_catalog.pg_proc p WHERE p.oid=fn;
  IF NOT FOUND THEN RAISE EXCEPTION '209 missing unchanged function' USING ERRCODE='55000';END IF;
  RETURN actual;
 END IF;
 RETURN ${prefix}predecessor_descriptor(fn${local?',entries':''})->>'${field}';
END$${tag}$;`;
 };
 const validateBindings=(selected='')=>`-- Validate ALL${rosterSize} current bindings before returning any projected descriptor.
 IF jsonb_typeof(entries) IS DISTINCT FROM 'array' OR jsonb_array_length(entries)<>${rosterSize} THEN RAISE EXCEPTION '209 complete predecessor frame required' USING ERRCODE='55000';END IF;
 validated:=0;
 -- One current-catalogue query, no per-entry SPI and no wide JSONB tuple sort.
 FOR entry,total,member_oid,actual_key,live,binding_ordinal IN
  WITH wanted AS MATERIALIZED(
   SELECT a.ordinal::integer ordinal,jsonb_build_object('key',a.key,'after_check',a.after_check) entry
   FROM ROWS FROM(jsonb_to_recordset(entries) AS(key text,after_check jsonb)) WITH ORDINALITY AS a(key,after_check,ordinal)
  )
  SELECT wanted.entry,bindings.total,bindings.member_oid,projected.key,projected.value,wanted.ordinal
  FROM wanted
  CROSS JOIN LATERAL(
   SELECT count(*) total,min(p.oid::bigint)::oid member_oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND 'public.'||p.proname=split_part(wanted.entry->>'key','(',1)
  ) bindings
  LEFT JOIN LATERAL(${liveCheckQuery.replace('WHERE p.oid=fn','WHERE bindings.total=1 AND p.oid=bindings.member_oid')}) projected(kind,key,value) ON true
 LOOP
  validated:=validated+1;
  IF binding_ordinal NOT BETWEEN 1 AND ${rosterSize} OR entry->>'key' IS DISTINCT FROM (${keysSql})[binding_ordinal] THEN RAISE EXCEPTION '209 exact predecessor roster required' USING ERRCODE='55000';END IF;
  IF total IS DISTINCT FROM 1 THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;
  IF actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'
   THEN RAISE EXCEPTION '209 exact complete successor descriptor required' USING ERRCODE='55000';END IF;${selected?'\n  '+selected:''}
 END LOOP;
 IF validated<>${rosterSize} THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;`;
 // Inline this read only in sealed bodies AFTER their own fresh complete209
 // validation. No unchecked SQL helper or caller-supplied capability is exposed.
 const readProjectionBasis=target=>`SELECT count(*) OVER(),id,payload IS NOT NULL,payload_octets,payload_sha256,payload_jsonb INTO total,source_id,payload_present,payload_bytes,payload_hash,${target} FROM ${prefix}projection_basis;
 IF total IS DISTINCT FROM 1 OR source_id IS DISTINCT FROM true OR payload_present IS DISTINCT FROM true OR ${target} IS NULL
  OR payload_bytes IS DISTINCT FROM ${basis.bytes} OR payload_hash IS DISTINCT FROM ${quote(basis.sha256)}
  THEN RAISE EXCEPTION '209 exact source projection basis required' USING ERRCODE='55000';END IF;`;
 const keyProjection="jsonb_path_query_array(payload::jsonb,'strict $[*].key'::jsonpath)";
 const checkProjection="jsonb_path_query_array(payload::jsonb,'strict $[*].after_check'::jsonpath)";
 const derivatives=[
  {name:'projection_keys',expression:keyProjection,kind:'array',constraint:'order_merge_delivery209_keys_source'},
  {name:'projection_checks',expression:checkProjection,kind:'array',constraint:'order_merge_delivery209_checks_source'},
  ...all.map((_c,i)=>({name:'before_'+i,expression:"((payload::jsonb)->"+i+"->'before')",kind:'object',constraint:'order_merge_delivery209_before_'+i+'_source'})),
 ];
 // Builtin-only STORED expressions; no mutable user-authored helper can poison
 // a derivative and then restore its own function body. Independent raw CHECKs
 // enforce provenance also on writes, even if row triggers were disabled.
 const derivativeDdl=derivatives.map(d=>d.name+' jsonb GENERATED ALWAYS AS ('+d.expression+') STORED CONSTRAINT '+d.constraint+" CHECK("+d.name+" IS NOT NULL AND "+d.name+' IS NOT DISTINCT FROM '+d.expression+" AND jsonb_typeof("+d.name+")='"+d.kind+"'"+(d.kind==='array'?' AND jsonb_array_length('+d.name+')='+rosterSize:'')+')').join(',\n ');
 const readCompactBasis=`SELECT count(*) OVER(),id,payload IS NOT NULL,payload_octets,payload_sha256,projection_keys,projection_checks INTO total,source_id,payload_present,payload_bytes,payload_hash,source_keys,source_checks FROM ${prefix}projection_basis;
 IF total IS DISTINCT FROM 1 OR source_id IS DISTINCT FROM true OR payload_present IS DISTINCT FROM true
  OR payload_bytes IS DISTINCT FROM ${basis.bytes} OR payload_hash IS DISTINCT FROM ${quote(basis.sha256)}
  OR jsonb_typeof(source_keys) IS DISTINCT FROM 'array' OR jsonb_array_length(source_keys)<>${rosterSize}
  OR jsonb_typeof(source_checks) IS DISTINCT FROM 'array' OR jsonb_array_length(source_checks)<>${rosterSize}
  THEN RAISE EXCEPTION '209 exact compact source projection required' USING ERRCODE='55000';END IF;
 SELECT jsonb_agg(jsonb_build_object('key',source_keys->i,'after_check',source_checks->i) ORDER BY i) INTO entries FROM generate_series(0,${rosterSize-1}) item(i);`;
 const storedBeforeCase='CASE actual_key '+all.map((c,i)=>'WHEN '+quote(c.key)+' THEN before_'+i).join(' ')+' ELSE NULL END';
 const readSelectedBefore=`SELECT count(*) OVER(),id,payload IS NOT NULL,payload_octets,payload_sha256,${storedBeforeCase} INTO total,source_id,payload_present,payload_bytes,payload_hash,selected_before FROM ${prefix}projection_basis;
 IF total IS DISTINCT FROM 1 OR source_id IS DISTINCT FROM true OR payload_present IS DISTINCT FROM true
  OR payload_bytes IS DISTINCT FROM ${basis.bytes} OR payload_hash IS DISTINCT FROM ${quote(basis.sha256)}
  OR jsonb_typeof(selected_before) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION '209 exact selected source predecessor required' USING ERRCODE='55000';END IF;
 RETURN selected_before;`;
 // One fresh snapshot supplies BOTH the complete fingerprint and its actual
 // canonical10 descriptors. It is not a stored verdict or a caller argument.
 // Compare every returned name/key/value independently to source-authored DATA.
 const checkedSnapshotBody=`DECLARE entries jsonb;entry jsonb;total integer;actual_key text;live jsonb;scoped boolean;source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;binding_ordinal integer;validated integer;source_keys jsonb;source_checks jsonb;snapshot_value jsonb;current_rows jsonb;m public.order_merge_delivery209_manifest%ROWTYPE;BEGIN
 IF selected_fn IS NOT NULL THEN
  SELECT n.nspname='public' AND p.proname=ANY(${namesSql}) INTO scoped FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=selected_fn;
  IF scoped IS DISTINCT FROM true THEN RETURN NULL;END IF;
 END IF;
 IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;
 snapshot_value:=public.order_merge_delivery209_validation_snapshot();
 IF(SELECT count(*) FROM public.order_merge_delivery209_manifest)<>1 OR(SELECT count(*) FROM public.buyer_address_manifest)<>1 THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;
 SELECT * INTO m FROM public.order_merge_delivery209_manifest WHERE id;
 IF jsonb_typeof(snapshot_value) IS DISTINCT FROM 'object' OR m.profile IS DISTINCT FROM 'merge-delivery-inheritance/v1'
  OR m.original166 IS DISTINCT FROM(SELECT to_jsonb(b) FROM public.buyer_address_manifest b)
  OR m.fingerprint IS DISTINCT FROM(snapshot_value->>'fingerprint')
  THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;
 current_rows:=snapshot_value->'legacy';
 IF jsonb_typeof(current_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(current_rows)<>${rosterSize} THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;
 ${readCompactBasis}
 IF jsonb_typeof(entries) IS DISTINCT FROM 'array' OR jsonb_array_length(entries)<>${rosterSize} THEN RAISE EXCEPTION '209 complete predecessor frame required' USING ERRCODE='55000';END IF;
 validated:=0;
 FOR entry,binding_ordinal IN
  SELECT jsonb_build_object('key',a.key,'after_check',a.after_check),a.ordinal::integer
  FROM ROWS FROM(jsonb_to_recordset(entries) AS(key text,after_check jsonb)) WITH ORDINALITY AS a(key,after_check,ordinal)
 LOOP
  validated:=validated+1;
  IF binding_ordinal NOT BETWEEN 1 AND ${rosterSize} OR entry->>'key' IS DISTINCT FROM (${keysSql})[binding_ordinal] THEN RAISE EXCEPTION '209 exact predecessor roster required' USING ERRCODE='55000';END IF;
  SELECT count(*) INTO total FROM jsonb_array_elements(current_rows) r(value)
   WHERE r.value->>'kind'='function' AND split_part(r.value->>'key','(',1)=split_part(entry->>'key','(',1);
  IF total IS DISTINCT FROM 1 THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;
  SELECT r.value->>'key',r.value->'value' INTO actual_key,live FROM jsonb_array_elements(current_rows) r(value)
   WHERE r.value->>'kind'='function' AND split_part(r.value->>'key','(',1)=split_part(entry->>'key','(',1);
  IF actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'
   THEN RAISE EXCEPTION '209 exact complete successor descriptor required' USING ERRCODE='55000';END IF;
 END LOOP;
 IF validated<>${rosterSize} THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;
 RETURN entries;`;
 const preambleSql=`-- Source-authored immutable DATA, not a giant routine body or observed catalogue adoption.
-- decode(escape) copies server bytes; UTF8 makes them the exact source UTF8 bytes.
-- Doubling every backslash preserves JSON escapes, octal-looking text and Unicode.
DO $encoding209$ BEGIN
 IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' THEN RAISE EXCEPTION '209 UTF8 database required' USING ERRCODE='55000';END IF;
END$encoding209$;
CREATE TABLE ${prefix}projection_basis(
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 payload text NOT NULL CHECK(octet_length(payload)=${basis.bytes} AND encode(sha256(convert_to(payload,'UTF8')),'hex')=${quote(basis.sha256)}),
 payload_jsonb jsonb GENERATED ALWAYS AS (payload::jsonb) STORED NOT NULL,
 payload_octets integer GENERATED ALWAYS AS (pg_catalog.octet_length(payload)) STORED NOT NULL,
 payload_sha256 text GENERATED ALWAYS AS (pg_catalog.encode(pg_catalog.sha256(pg_catalog.decode(pg_catalog.replace(payload COLLATE "C",pg_catalog.chr(92),pg_catalog.repeat(pg_catalog.chr(92),2)),'escape')),'hex')) STORED NOT NULL,
 -- Source18 independently checked builtin derivatives.
 ${derivativeDdl}
);
ALTER TABLE ${prefix}projection_basis ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${prefix}projection_basis FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON ${prefix}projection_basis TO postgres USING(true) WITH CHECK(true);
REVOKE ALL ON ${prefix}projection_basis FROM PUBLIC,dyna_app;
CREATE TRIGGER order_merge_delivery209_projection_immutable BEFORE UPDATE OR DELETE ON ${prefix}projection_basis FOR EACH ROW EXECUTE FUNCTION ${prefix}immutable();
CREATE TRIGGER order_merge_delivery209_projection_no_truncate BEFORE TRUNCATE ON ${prefix}projection_basis FOR EACH STATEMENT EXECUTE FUNCTION ${prefix}immutable();
INSERT INTO ${prefix}projection_basis(id,payload) VALUES(true,${quote(mapText)});
`;
 const sql=`-- Source209 strict metadata inverse; old certificate rows remain literal.
CREATE FUNCTION ${prefix}projection_map() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $map209$
DECLARE total integer;source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;parsed_value jsonb;BEGIN
 -- Every call authenticates the complete CURRENT generated metadata before reading its row.
 -- Stored derivatives are recomputed by PostgreSQL on writes, never supplied by a caller.
 IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' OR public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 exact generated projection required' USING ERRCODE='55000';END IF;
 ${readProjectionBasis('parsed_value')}
 RETURN parsed_value;
END
$map209$;
CREATE FUNCTION ${prefix}predecessor_descriptor(fn oid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $descriptor209$
DECLARE live jsonb;actual_key text;entry jsonb;entries jsonb;member_oid oid;total integer;selected_before jsonb;scoped boolean;source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;binding_ordinal integer;validated integer;BEGIN
 SELECT n.nspname='public' AND p.proname=ANY(${namesSql}) INTO scoped FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=fn;
 IF scoped IS DISTINCT FROM true THEN
  -- Identity projection never hides metadata drift or confers209 admission.
  SELECT value INTO live FROM(${liveQuery}) projected(kind,key,value);
  IF live IS NULL THEN RAISE EXCEPTION '209 missing unchanged function' USING ERRCODE='55000';END IF;
  RETURN live;
 END IF;
 IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' OR public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;
 ${readProjectionBasis('entries')}
 ${validateBindings("IF member_oid=fn THEN selected_before:=jsonb_extract_path(entries,(binding_ordinal-1)::text,'before');END IF;")}
 IF selected_before IS NOT NULL THEN RETURN selected_before;END IF;
 SELECT value INTO live FROM(${liveQuery}) projected(kind,key,value);
 IF live IS NULL THEN RAISE EXCEPTION '209 missing projected function' USING ERRCODE='55000';END IF;
 RETURN live;
END$descriptor209$;
${textProjector('definition')}
${textProjector('source')}
CREATE FUNCTION ${prefix}predecessor_metadata(value jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $metadata209$
DECLARE entries jsonb;entry jsonb;member_oid oid;total integer;actual_key text;live jsonb;result text:=value::text;field text;before_value text;after_value text;source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;binding_ordinal integer;validated integer;BEGIN
 -- Conservative names test: false positives still take the complete strict path.
 -- Returning the original value cannot normalize or hide any current metadata drift.
 IF NOT EXISTS(SELECT FROM unnest(${namesSql}) scoped(name) WHERE strpos(result,name)>0) THEN RETURN value;END IF;
 IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' OR public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;
 ${readProjectionBasis('entries')}
 ${validateBindings()}
 -- to_jsonb(text)::text includes its JSON string delimiters. Only complete JSON string leaves match;
 -- escaped quotes inside a longer string cannot match these tokens. No substring source edits.
 FOR entry IN SELECT v FROM jsonb_array_elements(entries) a(v) LOOP
  FOREACH field IN ARRAY ARRAY['source','definition'] LOOP
   after_value:=entry->'after'->>field;before_value:=entry->'before'->>field;
   result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);
  END LOOP;
  after_value:=encode(sha256(convert_to(entry->'after'->>'source','UTF8')),'hex');
  before_value:=encode(sha256(convert_to(entry->'before'->>'source','UTF8')),'hex');
  result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);
 END LOOP;
 RETURN result::jsonb;
END$metadata209$;
${helperNames.map(n=>'REVOKE ALL ON FUNCTION '+prefix+n+(n==='projection_map'?'()':n==='predecessor_metadata'?'(jsonb)':'(oid)')+' FROM PUBLIC,dyna_app;').join('\n')}
-- Invocation-local representation helpers. These do not authorize a business
-- write. Every sealed caller constructs its own fresh checked frame; neither
-- application callers nor a session setting can supply that local variable.
CREATE FUNCTION ${prefix}checked_projection_map(selected_fn oid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $checked209$
${runtimeRevision>=21?checkedSnapshotBody:`DECLARE entries jsonb;entry jsonb;member_oid oid;total integer;actual_key text;live jsonb;scoped boolean;source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;binding_ordinal integer;validated integer;source_keys jsonb;source_checks jsonb;BEGIN
 IF selected_fn IS NOT NULL THEN
  SELECT n.nspname='public' AND p.proname=ANY(${namesSql}) INTO scoped FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=selected_fn;
  IF scoped IS DISTINCT FROM true THEN RETURN NULL;END IF;
 END IF;
 IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' OR public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;
 ${readCompactBasis}
 ${validateBindings()}
 RETURN entries;`}
END$checked209$;
CREATE FUNCTION ${prefix}predecessor_descriptor(fn oid,entries jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $local_descriptor209$
DECLARE live jsonb;actual_key text;entry jsonb;total integer;scoped boolean;source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;selected_before jsonb;BEGIN
 SELECT n.nspname='public' AND p.proname=ANY(${namesSql}) INTO scoped FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=fn;
 IF scoped IS DISTINCT FROM true THEN
  SELECT key,value INTO actual_key,live FROM(${liveQuery}) projected(kind,key,value);
  IF live IS NULL THEN RAISE EXCEPTION '209 missing unchanged function' USING ERRCODE='55000';END IF;
  RETURN live;
 END IF;
 SELECT key,value INTO actual_key,live FROM(${liveCheckQuery}) projected(kind,key,value);
 IF live IS NULL THEN RAISE EXCEPTION '209 missing unchanged function' USING ERRCODE='55000';END IF;
 IF jsonb_typeof(entries) IS DISTINCT FROM 'array' OR jsonb_array_length(entries)<>${rosterSize} THEN RAISE EXCEPTION '209 invocation frame required' USING ERRCODE='55000';END IF;
 SELECT count(*) INTO total FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND 'public.'||p.proname=split_part(actual_key,'(',1);
 entry:=${indexedEntry};
 IF total<>1 OR entry IS NULL OR entry->>'key' IS DISTINCT FROM actual_key OR live IS DISTINCT FROM entry->'after_check' THEN RAISE EXCEPTION '209 exact current descriptor required' USING ERRCODE='55000';END IF;
 ${readSelectedBefore}
END$local_descriptor209$;
${textProjector('definition',true)}
${textProjector('source',true)}
CREATE FUNCTION ${prefix}predecessor_metadata(value jsonb,entries jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $local_metadata209$
DECLARE entry jsonb;member_oid oid;total integer;actual_key text;live jsonb;result text:=value::text;field text;before_value text;after_value text;binding_ordinal integer;validated integer;source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;BEGIN
 IF NOT EXISTS(SELECT FROM unnest(${namesSql}) scoped(name) WHERE strpos(result,name)>0) THEN RETURN value;END IF;
 IF jsonb_typeof(entries) IS DISTINCT FROM 'array' OR jsonb_array_length(entries)<>${rosterSize} THEN RAISE EXCEPTION '209 invocation frame required' USING ERRCODE='55000';END IF;
 ${validateBindings()}
 -- Metadata rewriting alone requires full AFTER strings. Compact checks have
 -- already validated ALL10 current bindings; authenticate a fresh full basis.
 IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' OR public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 complete source installation required' USING ERRCODE='55000';END IF;
 ${readProjectionBasis('entries')}
 FOR entry IN SELECT v FROM jsonb_array_elements(entries) a(v) LOOP
  FOREACH field IN ARRAY ARRAY['source','definition'] LOOP
   after_value:=entry->'after'->>field;before_value:=entry->'before'->>field;
   result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);
  END LOOP;
  after_value:=encode(sha256(convert_to(entry->'after'->>'source','UTF8')),'hex');
  before_value:=encode(sha256(convert_to(entry->'before'->>'source','UTF8')),'hex');
  result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);
 END LOOP;
 RETURN result::jsonb;
END$local_metadata209$;
REVOKE ALL ON FUNCTION ${prefix}checked_projection_map(oid) FROM PUBLIC,dyna_app;
${['predecessor_descriptor','predecessor_definition','predecessor_source'].map(n=>'REVOKE ALL ON FUNCTION '+prefix+n+'(oid,jsonb) FROM PUBLIC,dyna_app;').join('\n')}
REVOKE ALL ON FUNCTION ${prefix}predecessor_metadata(jsonb,jsonb) FROM PUBLIC,dyna_app;
${hashPort?hashPort.sql+'\n':''}${closures.length?closures.map(closure=>closure.sql).join('\n')+'\n':''}${startup?startup.sql+'\n':''}${sharingSql?sharingSql+'\n':''}${derived.map(c=>c.after.definition.trimEnd()+';').join('\n')}
`;
 const ownHelpers=[...closures.flatMap(closure=>closure.helpers??[closure.helper]),...(startup?.helpers??[]),...sharingHelpers];
 return{preambleSql,sql,projection_basis:basis,changes:derived.map(({projection_counts,...c})=>c),projection_counts:derived.map(c=>({key:c.key,...c.projection_counts})),helper_keys:[...helperNames,'checked_projection_map'].map(n=>prefix+n).concat(ownHelpers.map(helper=>helper.key.slice(0,helper.key.indexOf('('))),runtimeRevision>=21?[prefix+'validation_snapshot',prefix+'predecessor_source_sha']:[]),runtime_closure_helpers:ownHelpers,runtime_revision:runtimeRevision,...(startup?{startup_function_count:ORDER_MERGE_DELIVERY209_STARTUP_KEYS.length}:{}),source_compilation_performed:false,application_activation:false,native_certification:false};
}
