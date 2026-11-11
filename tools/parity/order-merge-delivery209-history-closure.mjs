/** Source-authored Native209 history adapter. Import-inert; no SQL execution.
 * The historical177 function and every original certificate remain literal. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const legacyName='ordinary177_predecessor_project';
const ownName='order_merge_delivery209_history_predecessor_project';
const definition=(name,args,source)=>`CREATE OR REPLACE FUNCTION public.${name}(${args})\n RETURNS jsonb\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\n SET "TimeZone" TO 'UTC'\nAS $functionx$${source}$functionx$\n`;

export const ORDER_MERGE_DELIVERY209_HISTORY_SOURCE=freeze({
 source204_sha256:'410fe04993d1e5c714319146bae29370ef8e2bda445d5ccac38e6c626bdcbc82',
 source204_decoded_contract_sha256:'65004e2ccd59799b0bc55db9a3c4debdfec1ffe564856a9c06fd9b05600be771',
 predecessor_key:'public.ordinary177_predecessor_project(v jsonb)',
 predecessor_source_bytes:265761,
 predecessor_source_sha256:'897f6874fa3ed7face5929c894ca68fe6e4285867695ef702f31161412e3f20c',
 predecessor_definition_sha256:'7f9d0257659f737da4d080e6fd081058ccdf81269be3c0bc386e653d94e816ad',
 predecessor_record_sha256:'fb2f3bbea5fb6a16d5e933e0cb4824396d1d74bbb5fb27e73186b727ded782ee',
});

/** Preserve quoted historical SQL, dollar strings and comments byte for byte. */
export function orderMergeDelivery209HistorySqlSpans(source){
 assert.equal(typeof source,'string');assert(Buffer.byteLength(source)<=8388608,'bounded function source');
 const spans=[];let cursor=0,start=0;
 const emit=(end,executable)=>{if(end>start)spans.push({text:source.slice(start,end),executable});start=end;};
 while(cursor<source.length){let end;
  if(source.startsWith('--',cursor)){end=source.indexOf('\n',cursor+2);if(end<0)end=source.length;}
  else if(source.startsWith('/*',cursor)){let depth=1;end=cursor+2;while(depth&&end<source.length){if(source.startsWith('/*',end)){depth++;end+=2;}else if(source.startsWith('*/',end)){depth--;end+=2;}else end++;}assert.equal(depth,0,'closed SQL comment');}
  else if(source[cursor]==="'"||source[cursor]==='"'){
   const quote=source[cursor],escaped=quote==="'"&&/[Ee]/.test(source[cursor-1]??'')&&!/[A-Za-z_0-9]/.test(source[cursor-2]??'');end=cursor+1;let closed=false;
   while(end<source.length){if(escaped&&source[end]==='\\'){end+=2;continue;}if(source[end]===quote){if(source[end+1]===quote){end+=2;continue;}end++;closed=true;break;}end++;}assert(closed,'closed SQL quoted token');
  }else{const dollar=/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(cursor));if(dollar){const close=source.indexOf(dollar[0],cursor+dollar[0].length);assert(close>=0,'closed SQL dollar string');end=close+dollar[0].length;}}
  if(end!==undefined){emit(cursor,true);emit(end,false);cursor=end;}else cursor++;
 }
 emit(source.length,true);assert.equal(spans.map(span=>span.text).join(''),source);return spans;
}

/** The only three live349 reads are buyer/manual/financial-return. The existing
 * private209 descriptor authenticates all24 current fields before projecting
 * source/definition for either changed routine; unchanged routines are identity.
 * No caller JSON is used as an expected live descriptor. */
export function projectOrderMergeDelivery209HistorySource(source,{runtimeRevision=21}={}){
 assert([18,19,20,21,22].includes(runtimeRevision),'explicit supported history source revision');
 const counts={source_reads:0,definition_reads:0};
 let projected=orderMergeDelivery209HistorySqlSpans(source).map(span=>{
  if(!span.executable)return span.text;
  return span.text.replace(/\bp\.prosrc\b/g,()=>{counts.source_reads++;return 'public.order_merge_delivery209_predecessor_source(p.oid, entries)';})
   .replace(/\bpg_catalog\.pg_get_functiondef\(p\.oid\)/g,()=>{counts.definition_reads++;return 'public.order_merge_delivery209_predecessor_definition(p.oid, entries)';});
 }).join('');
 assert.deepEqual(counts,{source_reads:3,definition_reads:3},'exact three complete live349 source/definition pairs');
 assert(!orderMergeDelivery209HistorySqlSpans(projected).some(span=>span.executable&&/\bprosrc\b|\bpg_get_functiondef\s*\(/.test(span.text)),'no unprojected live definition/source edge');
 if(runtimeRevision===22){
  // The map argument has already been projected BEFORE209. Since22 changes
  // these six public roots, the independent live metadata must be projected to
  // the SAME side before the unchanged full-metadata equality and204 inverse.
  // This private port validates the current full roster; entries is no verdict.
  const raw='public.pim_dictionary_function_metadata(to_regprocedure(entry204.sig))';
  counts.metadata_reads=0;
  projected=orderMergeDelivery209HistorySqlSpans(projected).map(span=>{
   if(!span.executable)return span.text;
   counts.metadata_reads+=span.text.split(raw).length-1;
   return span.text.replaceAll(raw,'public.order_merge_delivery209_predecessor_metadata('+raw+', entries)');
  }).join('');
  assert.equal(counts.metadata_reads,1,'exact one executable six-root metadata producer');
 }
 return {source:projected,sites:counts};
}

function predecessor(source204){
 assert.equal(typeof source204,'string');assert(Buffer.byteLength(source204)<=16*1024*1024,'finite Source204 bytes');
 assert.equal(sha(source204),ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.source204_sha256,'literal Source204 input');
 const marker='CREATE OR REPLACE FUNCTION public.'+legacyName+'(v jsonb)';
 const matches=[...source204.matchAll(new RegExp('^'+marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gm'))];assert.equal(matches.length,1,'one authored177 declaration');
 const start=matches[0].index,open=source204.indexOf('$functionx$',start),end=source204.indexOf('$functionx$',open+11);
 assert(open>start&&end>open,'authored full body dollar bounds');
 assert.equal(source204.slice(start,open),definition(legacyName,'v jsonb','').split('$functionx$')[0],'entire authored177 header');
 assert.equal(source204.slice(end+11,end+12),';','complete authored declaration');
 const source=source204.slice(open+11,end),value={owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,
  leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,
  argument_names:['v'],argument_modes:null,arguments:'v jsonb',result:'jsonb',defaults:null,source,binary:null,
  config:['search_path=pg_catalog, public','TimeZone=UTC'],definition:definition(legacyName,'v jsonb',source),acl_null:false,
  acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
 const record={kind:'function',key:ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.predecessor_key,value};
 assert.equal(Buffer.byteLength(source),ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.predecessor_source_bytes);
 assert.equal(sha(source),ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.predecessor_source_sha256);
 assert.equal(sha(value.definition),ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.predecessor_definition_sha256);
 assert.equal(sha(JSON.stringify(canonical(record))),ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.predecessor_record_sha256,'source-derived complete record equals independent Source204 contract pin');
 return record;
}

/** Installer integration: add this private function to the209 own fingerprint
 * and ACL seal, then replace ONLY the executable187 map-projection call below.
 * This generator never seals, updates old records or claims Native acceptance. */
export function deriveOrderMergeDelivery209HistoryClosure({source204,runtimeRevision=21}){
 const before=predecessor(source204),projected=projectOrderMergeDelivery209HistorySource(before.value.source,{runtimeRevision});
 const args='v jsonb, entries jsonb',value={...before.value,argument_names:['v','entries'],arguments:args,
  source:projected.source,definition:definition(ownName,args,projected.source)};
 const helper={kind:'function',key:'public.'+ownName+'('+args+')',value};
 const beforeCall='public.ordinary177_predecessor_project(public.order_merge_delivery209_predecessor_metadata(public.large_import173_predecessor_map(), merge_delivery209_local_frame))';
 const afterCall='public.'+ownName+'(public.order_merge_delivery209_predecessor_metadata(public.large_import173_predecessor_map(), merge_delivery209_local_frame), merge_delivery209_local_frame)';
 return freeze({schema:'order-merge-delivery209-history-closure/v1',source_inputs:ORDER_MERGE_DELIVERY209_HISTORY_SOURCE,
  historical_predecessor:before,helper,sql:value.definition.trimEnd()+';\nREVOKE ALL ON FUNCTION public.'+ownName+'(jsonb,jsonb) FROM PUBLIC,dyna_app;\n',
  replacement:{key:'public.ordinary187_valid()',before:beforeCall,after:afterCall,expected_executable_occurrences:1},
  projection_sites:projected.sites,unchanged_historical_function:true,unchanged_legacy_change_roster:14,
  requires_own_fingerprint_and_all_nonowner_acl_seal:true,source_compilation_performed:false,native_certification:false,application_activation:false});
}
