/** Faithful own209 history/wave clones from literal Source204.
 * No historical replacement, certificate update, SQL dispatch or acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ORDER_MERGE_DELIVERY209_HISTORY_SOURCE,orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const args='manual_basis jsonb';
const specs=[
 {name:'ordinary181_history_operative_valid',own:'order_merge_delivery209_history_operative_valid',source_bytes:74071,
  source_sha256:'3d16231fb72cf54888f133a0a1a7b3e84ef587653049a44b0310863d824f66ed',
  definition_sha256:'d9a780ddad7843067f68378c7dc24b69b934ebca810e2a0f8dea53b66244de0a',
  record_sha256:'38053c4d8211c68145f808c8975858baa5d70ba8a4e30af709dadaaafa6e70ba'},
 {name:'ordinary181_wave_valid',own:'order_merge_delivery209_wave_valid',source_bytes:91296,
  source_sha256:'e7ea5579a511c9ed770927d15826f0865a6e3117c9392f8217797bafd33dee51',
  definition_sha256:'ffa5a08025977c1edf2cf2a5d06b4ab856deea25e7982979d0c0740c8c287cf2',
  record_sha256:'5fd91a000152e0503881c98c61199bb6125019f25f1e9db6f766d86862088ac4'},
];
export const ORDER_MERGE_DELIVERY209_WAVE_SOURCE=freeze({
 source204_sha256:ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.source204_sha256,
 source204_decoded_contract_sha256:ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.source204_decoded_contract_sha256,
 predecessors:specs.map(spec=>({key:'public.'+spec.name+'('+args+')',...spec})),
});
const definition=(name,source)=>`CREATE OR REPLACE FUNCTION public.${name}(${args})\n RETURNS boolean\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\n SET "TimeZone" TO 'UTC'\nAS $function$${source}$function$\n`;

function predecessor(source204,spec){
 const marker='CREATE OR REPLACE FUNCTION public.'+spec.name+'('+args+')';
 const matches=[...source204.matchAll(new RegExp('^'+marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gm'))];assert.equal(matches.length,1,'one authored declaration '+spec.name);
 const start=matches[0].index,tag='$function$',open=source204.indexOf(tag,start),end=source204.indexOf(tag,open+tag.length);
 assert(open>start&&end>open,'complete authored function bounds');
 assert.equal(source204.slice(start,open),definition(spec.name,'').split(tag)[0],'entire authored header');
 assert.equal(source204.slice(end+tag.length,end+tag.length+1),';','complete declaration');
 const source=source204.slice(open+tag.length,end);
 const value={owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,leakproof:false,
  strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,argument_names:['manual_basis'],
  argument_modes:null,arguments:args,result:'boolean',defaults:null,source,binary:null,
  config:['search_path=pg_catalog, public','TimeZone=UTC'],definition:definition(spec.name,source),acl_null:false,
  acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
 const record={kind:'function',key:'public.'+spec.name+'('+args+')',value};
 assert.equal(Buffer.byteLength(source),spec.source_bytes,'source bytes');assert.equal(sha(source),spec.source_sha256,'source SHA');
 assert.equal(sha(value.definition),spec.definition_sha256,'complete definition SHA');
 assert.equal(sha(JSON.stringify(canonical(record))),spec.record_sha256,'source-derived full24 record equals independent E204 pin');
 return record;
}

/** This alias uniquely identifies the buyer319 constraint arm in the pinned
 * source. Financial/document constraints use k.oid or bare oid and stay raw.
 * Existing209 constraint projection freshly authenticates each changed CHECK;
 * every unchanged constraint is identity, preserving drift in the fingerprint. */
export function projectOrderMergeDelivery209OperativeSource(source){
 let count=0;
 const projected=spans(source).map(span=>!span.executable?span.text:span.text.replace(/\bpg_get_constraintdef\(c\.oid,true\)/g,()=>{
  count++;return 'public.order_merge_delivery209_constraint_definition(c.oid)';
 })).join('');
 assert.equal(count,1,'exact one buyer319 raw constraint arm');
 return {source:projected,sites:{buyer319_constraint_definitions:count}};
}

export function projectOrderMergeDelivery209WaveSource(source){
 let count=0;
 const projected=spans(source).map(span=>!span.executable?span.text:span.text.replace(/\bpublic\.ordinary181_history_operative_valid\(manual_basis\)/g,()=>{
  count++;return 'public.order_merge_delivery209_history_operative_valid(manual_basis)';
 })).join('');
 assert.equal(count,1,'exact one executable operative call in current wave');
 return {source:projected,sites:{operative_calls:count}};
}

export function deriveOrderMergeDelivery209WaveClosure({source204}){
 assert.equal(typeof source204,'string');assert(Buffer.byteLength(source204)<=16*1024*1024,'bounded Source204');
 assert.equal(sha(source204),ORDER_MERGE_DELIVERY209_WAVE_SOURCE.source204_sha256,'literal Source204 input');
 const historical_predecessors=specs.map(spec=>predecessor(source204,spec));
 const projected=[projectOrderMergeDelivery209OperativeSource(historical_predecessors[0].value.source),projectOrderMergeDelivery209WaveSource(historical_predecessors[1].value.source)];
 const helpers=historical_predecessors.map((record,index)=>{
  const spec=specs[index],source=projected[index].source;
  return {kind:'function',key:'public.'+spec.own+'('+args+')',value:{...record.value,source,definition:definition(spec.own,source)}};
 });
 return freeze({schema:'order-merge-delivery209-wave-closure/v1',source_inputs:ORDER_MERGE_DELIVERY209_WAVE_SOURCE,
  historical_predecessors,helpers,sql:helpers.map((record,index)=>record.value.definition.trimEnd()+';\nREVOKE ALL ON FUNCTION public.'+specs[index].own+'(jsonb) FROM PUBLIC,dyna_app;\n').join(''),
  replacement:{key:'public.ordinary187_valid()',before:'public.ordinary181_wave_valid(manual_basis)',after:'public.order_merge_delivery209_wave_valid(manual_basis)',expected_executable_occurrences:1},
  projection_sites:projected.map(result=>result.sites),
  call_graph:{ordinary187_wave_assignment:'public.order_merge_delivery209_wave_valid',wave_terminal:'public.order_merge_delivery209_history_operative_valid',
   unchanged_parent:'public.ordinary181_history_parents_valid',unchanged_pim:'public.ordinary181_history_pim_valid',
   retained_wave_consumers:['public.ordinary181_nested_valid','public.ordinary181_packed_guards','public.ordinary181_parcel_valid','public.ordinary181_warehouse_issuer_guards']},
  unchanged_historical_functions:true,unchanged_legacy_change_roster:14,requires_own_fingerprint_and_all_nonowner_acl_seal:true,
  source_compilation_performed:false,native_certification:false,application_activation:false});
}
