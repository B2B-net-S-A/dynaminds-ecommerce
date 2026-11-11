/** Source-only buyer251 history closure. No historical function/certificate edits,
 * SQL execution, sealing, or runtime authority is supplied by this module. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ORDER_MERGE_DELIVERY209_HISTORY_SOURCE,orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const specs=[
 {name:'ordinary181_buyer_guards',own:'order_merge_delivery209_buyer_guards',origin:204,args:'manual_basis jsonb',
  bytes:72927,source_sha256:'4db54e5cb5d159c8804fb1e03153ff61f5b21187a6c26a400e20bcd3002c7c38',
  definition_sha256:'0efa9aa09296c167d2c1e852a4ec08101b092ca54b55f679ba07ecdc98bb9c24',
  record_sha256:'7ad6cdef8701defb8d01e5ff40bca350e7ba7fa6b9288f1b4ec4a8401498efa9'},
 {name:'ordinary181_history_pim_valid',own:'order_merge_delivery209_history_pim_valid',origin:181,args:'manual_basis jsonb, wave_ok boolean',
  bytes:9737,source_sha256:'f8c745d4b5fdcec89a5669f6f12a8709892866d13b1fa56c0b34e8f79c74281f',
  definition_sha256:'be0d6a0ae3dd8f3c625782914b7a2e81bea1a5d053af2bf339c4fc07d99278c7',
  record_sha256:'8e3ac7c0e9c64fd8354a65fbc5d6b37a2c0d055141b10d8a21fd0792e631f29e'},
 {name:'ordinary181_history_parents_valid',own:'order_merge_delivery209_history_parents_valid',origin:181,args:'manual_basis jsonb, wave_ok boolean',
  bytes:4844,source_sha256:'1e82bba4ef1d1df7e3ba3422ea4445d8206aed5787be42799163d0f22a31f1f3',
  definition_sha256:'406615900ef77b06dbd5871233bf49db6a42ac7216b3fd96d3bb3b40cc699235',
  record_sha256:'06d54b7261559315df349e3cb5b0a121592142042cac8856860adb29069dbed1'},
];
export const ORDER_MERGE_DELIVERY209_BUYER_SOURCE=freeze({
 source204_sha256:ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.source204_sha256,
 source204_decoded_contract_sha256:ORDER_MERGE_DELIVERY209_HISTORY_SOURCE.source204_decoded_contract_sha256,
 source181_sha256:'e35834b01ef3f31fb63552d32b38e438db44ec4179e5b30a37e8465a43444e6a',
 predecessors:specs.map(spec=>({key:'public.'+spec.name+'('+spec.args+')',...spec})),
});
const definition=(name,args,source)=>`CREATE OR REPLACE FUNCTION public.${name}(${args})\n RETURNS boolean\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\n SET "TimeZone" TO 'UTC'\nAS $function$${source}$function$\n`;
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function predecessor(input,spec){
 const marker=(spec.origin===204?'CREATE OR REPLACE':'CREATE')+' FUNCTION public.'+spec.name+'('+spec.args+')';
 const matches=[...input.matchAll(new RegExp('^'+escape(marker),'gm'))];assert.equal(matches.length,1,'one authored declaration '+spec.name);
 const start=matches[0].index,tag=spec.origin===204?'$function$':'$ordinary181$',open=input.indexOf(tag,start),end=input.indexOf(tag,open+tag.length);
 assert(open>start&&end>open,'complete authored body');
 const header=spec.origin===204?definition(spec.name,spec.args,'').split(tag)[0]
  :marker+" RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS ";
 assert.equal(input.slice(start,open),header,'entire authored header');assert.equal(input[end+tag.length],';','complete authored declaration');
 const source=input.slice(open+tag.length,end),value={owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,
  security_definer:true,leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,
  argument_names:spec.origin===204?['manual_basis']:['manual_basis','wave_ok'],argument_modes:null,arguments:spec.args,
  result:'boolean',defaults:null,source,binary:null,config:['search_path=pg_catalog, public','TimeZone=UTC'],
  definition:definition(spec.name,spec.args,source),acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
 const record={kind:'function',key:'public.'+spec.name+'('+spec.args+')',value};
 assert.equal(Buffer.byteLength(source),spec.bytes,'authored source bytes');assert.equal(sha(source),spec.source_sha256,'authored source SHA');
 assert.equal(sha(value.definition),spec.definition_sha256,'complete definition SHA');
 assert.equal(sha(JSON.stringify(canonical(record))),spec.record_sha256,'complete source-derived record');
 return record;
}

function replace(source,pattern,after,count,label){
 let actual=0;const projected=spans(source).map(span=>!span.executable?span.text:span.text.replace(pattern,()=>{actual++;return after;})).join('');
 assert.equal(actual,count,'exact executable '+label);return {source:projected,sites:{[label]:actual}};
}
/** Only the raw buyer251 constraint arm changes. Existing live full metadata,
 * original166 definition normalization, predecessor/certificate equality,
 * transaction-scoped bootstrap and every refusal remain byte-identical. */
export const projectOrderMergeDelivery209BuyerSource=source=>replace(source,/\bpg_get_constraintdef\(c\.oid,true\)/g,
 'public.order_merge_delivery209_constraint_definition(c.oid)',1,'buyer251_constraint_definitions');
export const projectOrderMergeDelivery209BuyerPimSource=source=>replace(source,/\bpublic\.ordinary181_buyer_guards\(manual_basis\)/g,
 'public.order_merge_delivery209_buyer_guards(manual_basis)',3,'buyer_calls');
export const projectOrderMergeDelivery209BuyerParentsSource=source=>replace(source,/\bpublic\.ordinary181_history_pim_valid\(manual_basis,wave_ok\)/g,
 'public.order_merge_delivery209_history_pim_valid(manual_basis,wave_ok)',1,'pim_calls');

/** Integration: append three own/private helpers before the derived187 body;
 * replace its sole executable terminal edge before authenticating map.after.
 * The own209 fingerprint and all-nonowner ACL seal must include these helpers.
 * No original181 function/header/ACL/certificate or14-key delta is replaced. */
export function deriveOrderMergeDelivery209BuyerClosure({source204,source181}){
 for(const [name,input,limit] of [['source204',source204,16*1024*1024],['source181',source181,2*1024*1024]]){
  assert.equal(typeof input,'string');assert(Buffer.byteLength(input)<=limit,'bounded '+name);
  assert.equal(sha(input),ORDER_MERGE_DELIVERY209_BUYER_SOURCE[name+'_sha256'],'literal '+name+' input');
 }
 const historical_predecessors=specs.map(spec=>predecessor(spec.origin===204?source204:source181,spec));
 // Independent literal Source204 admission clauses retain the181 PIM/parent
 // source hashes AND entire executable header/owner/ACL checks. No runtime
 // catalogue is used as expected data. These two deparser templates have not
 // independently been compiled here; the eventual source compiler must do so.
 for(const spec of specs.slice(1)){
  const clause=source204.split('\n').filter(line=>line.includes("p.oid=to_regprocedure('public."+spec.name+'(jsonb,boolean)\')')&&line.includes("'"+spec.source_sha256+"'"));
  assert(clause.length>0,'Source204 retains source181 admission '+spec.name);
  for(const token of ["p.proargmodes IS NULL","p.pronargdefaults=0","pg_get_userbyid(p.proowner)='postgres'","p.prosecdef","NOT p.proisstrict","NOT p.proleakproof","p.proparallel='u'","p.prokind='f'","NOT p.proretset","p.procost=100","p.prorows=0","p.provolatile='s'","l.lanname='plpgsql'","p.proargdefaults IS NULL",'[["postgres","postgres","EXECUTE",false]]'])
   assert(clause.every(line=>line.includes(token)),'complete Source204 admission '+token);
  assert(source181.includes('REVOKE ALL ON FUNCTION public.'+spec.name+'(jsonb,boolean) FROM PUBLIC,dyna_app;'),'literal181 ACL seal');
 }
 const projected=[projectOrderMergeDelivery209BuyerSource,projectOrderMergeDelivery209BuyerPimSource,projectOrderMergeDelivery209BuyerParentsSource]
  .map((transform,index)=>transform(historical_predecessors[index].value.source));
 const helpers=historical_predecessors.map((record,index)=>({kind:'function',key:'public.'+specs[index].own+'('+specs[index].args+')',
  value:{...record.value,source:projected[index].source,definition:definition(specs[index].own,specs[index].args,projected[index].source)}}));
 return freeze({schema:'order-merge-delivery209-buyer-closure/v1',source_inputs:ORDER_MERGE_DELIVERY209_BUYER_SOURCE,
  historical_predecessors,helpers,sql:helpers.map((record,index)=>record.value.definition.trimEnd()+';\nREVOKE ALL ON FUNCTION public.'+specs[index].own+(index?'(jsonb,boolean)':'(jsonb)')+' FROM PUBLIC,dyna_app;\n').join(''),
  replacement:{key:'public.ordinary187_valid()',before:'public.ordinary181_history_parents_valid(manual_basis,wave_ok)',
   after:'public.order_merge_delivery209_history_parents_valid(manual_basis,wave_ok)',expected_executable_occurrences:1},
  projection_sites:projected.map(result=>result.sites),unchanged_historical_functions:true,unchanged_legacy_change_roster:14,
  requires_own_fingerprint_and_all_nonowner_acl_seal:true,source_compilation_performed:false,
  full_before_descriptors_compiler_verified:false,native_certification:false,application_activation:false});
}
