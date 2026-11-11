/** Source22 targeted derivation. Import-inert: never observes or executes SQL.
 * These are PRE-projection public bodies. The parent producer must subsequently
 * project live source/definition reads, acquire its fresh checked17 frame, and
 * authenticate the resulting final AFTER records before building DATA/sealing.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PACKING204_SOURCE_CONTRACT as E204} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS,ORDER_MERGE_DELIVERY209_STARTUP_BEFORE_RECORD_SHA256,
 assertOrderMergeDelivery209StartupBeforeRecords} from './order-merge-delivery209-startup-roster.mjs';

export {ORDER_MERGE_DELIVERY209_STARTUP_KEYS};
const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const frame='merge_delivery209_local_frame';
const oldOperative='public.wave_print177_history_operative_delivery_valid()';
const ownOperative='public.order_merge_delivery209_startup_operative_valid';
const metadataCounts=Object.freeze({pim_dictionary_function_metadata:11,wave_print177_metadata:1,
 wave_print177_packed_metadata:2,wave_print177_operative_metadata:2});
export const ORDER_MERGE_DELIVERY209_STARTUP_SOURCE=freeze({
 source204_sha256:'410fe04993d1e5c714319146bae29370ef8e2bda445d5ccac38e6c626bdcbc82',
 source204_decoded_contract_sha256:'65004e2ccd59799b0bc55db9a3c4debdfec1ffe564856a9c06fd9b05600be771',
 public_before_record_sha256:ORDER_MERGE_DELIVERY209_STARTUP_BEFORE_RECORD_SHA256,
 operative_before_key:oldOperative,
 operative_before_record_sha256:'3ebdb74788d410e0d75c751fe3dff677127b4eb82bbe4d0cbadf347c60b2e0a4',
 operative_before_source_sha256:'8ef75ad4437644ebf671a9ad56b86443d97cc6b41207d977b45300df140833a2',
});
const executableMask=source=>spans(source).map(s=>s.executable?s.text:s.text.replace(/[^\n]/g,' ')).join('');
const validFrame=value=>assert(/^[a-z_][a-z_0-9]*$/.test(value),'fixed SQL identifier');
function applyEdits(source,edits){
 const ordered=[...edits].sort((a,b)=>a.start-b.start);
 for(let i=1;i<ordered.length;i++)assert(ordered[i-1].end<=ordered[i].start,'non-overlapping exact source edits');
 let result=source;for(const e of [...ordered].reverse())result=result.slice(0,e.start)+e.after+result.slice(e.end);
 return result;
}
function sourceRecord(source204,key){
 const found=E204.changes.filter(c=>c.kind==='function'&&c.key===key);assert.equal(found.length,1,'one independent Source204 AFTER record');
 const value=structuredClone(found[0].after),marker='CREATE OR REPLACE FUNCTION '+key;
 const matches=[...source204.matchAll(new RegExp('^'+marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gm'))];
 assert.equal(matches.length,1,'one literal authored function declaration '+key);
 const start=matches[0].index,as=source204.indexOf('AS $',start);assert(as>start);
 const tag=/^\$[a-z_0-9]*\$/i.exec(source204.slice(as+3))?.[0];assert(tag,'literal outer delimiter');
 const open=as+3+tag.length,end=source204.indexOf(tag,open);assert(end>open&&source204[end+tag.length]===';','closed authored body');
 assert.equal(source204.slice(open,end),value.source,'complete literal source equals independent compiled Source204 AFTER');
 assert.equal(source204.slice(start,end+tag.length)+'\n',value.definition,'complete authored header and deparser definition');
 assert.equal(Object.keys(value).length,24);return{kind:'function',key,value};
}
function successor(value,source){
 assert.equal(value.definition.split(value.source).length,2,'one full source in definition');
 return{...structuredClone(value),source,definition:value.definition.replace(value.source,()=>source)};
}

/** Wrap only known live metadata PRODUCERS, including all nested call arguments.
 * SQL literals/comments are masked with byte-position-preserving JS characters;
 * nested parentheses in string/dollar literals cannot truncate a call. The
 * parent live-source projection must also project current_source189/leaf_sha to
 * the same BEFORE side. Otherwise the original full-metadata equations refuse.
 * This reusable stage is required for the existing private209 wave clone too.
 */
export function projectOrderMergeDelivery209StartupMetadata(source,{frameName=frame}={}){
 assert.equal(typeof source,'string');validFrame(frameName);const mask=executableMask(source),edits=[],counts={};
 const pattern=/\bpublic\.(pim_dictionary_function_metadata|wave_print177_metadata|wave_print177_packed_metadata|wave_print177_operative_metadata)\s*\(/g;
 for(const match of mask.matchAll(pattern)){
  const open=match.index+match[0].lastIndexOf('(');let depth=1,end=open+1;
  while(depth&&end<mask.length){assert.notEqual(mask[end],';','complete live metadata call before statement end');if(mask[end]==='(')depth++;else if(mask[end]===')')depth--;end++;}
  assert.equal(depth,0,'complete live metadata call');const before=source.slice(match.index,end);
  edits.push({start:match.index,end,after:'public.order_merge_delivery209_predecessor_metadata('+before+', '+frameName+')'});
  counts[match[1]]=(counts[match[1]]??0)+1;
 }
 assert.deepEqual(counts,metadataCounts,'exact sixteen public-wave metadata producers');
 return{source:applyEdits(source,edits),counts};
}

/** Targeted public wave change only. Parent generic source/definition/frame pass
 * is deliberately separate; no caller frame or partial descriptor is trusted.
 */
export function projectOrderMergeDelivery209StartupWave(source,{frameName=frame}={}){
 validFrame(frameName);const before='public.wave_print177_history_operative_delivery_valid()';
 const mask=executableMask(source),matches=[...mask.matchAll(/\bpublic\.wave_print177_history_operative_delivery_valid\(\)/g)];
 assert.equal(matches.length,1,'one actual public-wave terminal operative call');
 const m=matches[0],targeted=applyEdits(source,[{start:m.index,end:m.index+before.length,after:ownOperative+'('+frameName+')'}]);
 const projected=projectOrderMergeDelivery209StartupMetadata(targeted,{frameName});
 return{source:projected.source,counts:{...projected.counts,operative_calls:1}};
}

/** Faithful private clone; its only executable body change is the one buyer251
 * CHECK deparser arm. The forwarded entries parameter does not grant authority:
 * the public parent has acquired its fresh checked frame and the strict209
 * constraint port itself freshly validates complete installation/current CHECK.
 */
export function projectOrderMergeDelivery209StartupOperative(source){
 let count=0;const projected=spans(source).map(s=>!s.executable?s.text:s.text.replace(/\bpg_get_constraintdef\(c\.oid,true\)/g,()=>{
  count++;return'public.order_merge_delivery209_constraint_definition(c.oid)';
 })).join('');assert.equal(count,1,'one exact buyer251 raw constraint arm');
 const line=source.split('\n').filter(l=>l.includes('pg_get_constraintdef(c.oid,true)'));
 assert.equal(line.length,1);assert(line[0].includes("starts_with(t.relname,'buyer_address_')"),'arm specifically belongs to buyer metadata');
 return{source:projected,counts:{buyer251_constraint_definitions:count}};
}

export function deriveOrderMergeDelivery209StartupClosure({source204}){
 assert.equal(typeof source204,'string');assert(Buffer.byteLength(source204)<=16*1024*1024,'bounded literal Source204');
 assert.equal(sha(source204),ORDER_MERGE_DELIVERY209_STARTUP_SOURCE.source204_sha256,'literal Source204 source pin');
 const historical_predecessors=ORDER_MERGE_DELIVERY209_STARTUP_KEYS.map(key=>sourceRecord(source204,key));
 assertOrderMergeDelivery209StartupBeforeRecords(historical_predecessors);
 const operative=sourceRecord(source204,oldOperative);
 assert.equal(sha(JSON.stringify(canonical(operative))),ORDER_MERGE_DELIVERY209_STARTUP_SOURCE.operative_before_record_sha256,'complete source-derived private-clone predecessor');
 assert.equal(sha(operative.value.source),ORDER_MERGE_DELIVERY209_STARTUP_SOURCE.operative_before_source_sha256);
 const privateProjection=projectOrderMergeDelivery209StartupOperative(operative.value.source);
 const privateValue=successor(operative.value,privateProjection.source);
 privateValue.arguments='entries jsonb';privateValue.argument_names=['entries'];
 privateValue.definition=privateValue.definition.replace('FUNCTION '+oldOperative,'FUNCTION '+ownOperative+'(entries jsonb)');
 assert(privateValue.acl.every(a=>a.grantee==='postgres'&&a.grantor==='postgres'&&a.privilege==='EXECUTE'&&!a.grantable),'private helper retains owner-only ACL');
 const helpers=[{kind:'function',key:ownOperative+'(entries jsonb)',value:privateValue}];
 const projection_counts={};
 const changes=historical_predecessors.map(({kind,key,value})=>{
  const projected=key==='public.wave_print177_valid()'?projectOrderMergeDelivery209StartupWave(value.source):{source:value.source,counts:{}};
  projection_counts[key]=projected.counts;return{kind,key,before:structuredClone(value),after:successor(value,projected.source)};
 });
 return freeze({schema:'order-merge-delivery209-startup-capability-closure/v1',source_inputs:ORDER_MERGE_DELIVERY209_STARTUP_SOURCE,
  historical_predecessors,historical_operative_predecessor:operative,changes,helpers,projection_counts,
  sql:privateValue.definition.trimEnd()+';\nREVOKE ALL ON FUNCTION '+ownOperative+'(jsonb) FROM PUBLIC,dyna_app;\n',
  existing_helper_projection:{key:'public.order_merge_delivery209_wave_valid(manual_basis jsonb)',projector:'projectOrderMergeDelivery209StartupMetadata',
   requires_fresh_entry_frame_injection:true,requires_generic_live_source_projection:true,expected_metadata_counts:metadataCounts},
  parent_stage:{preprojection_only:true,required_checked_frame:frame,required_final_scope:17,
   generic_live_source_and_definition_projection:true,entry_checked_frame_injection:true,source_hash_projection:true,
   final_after_authentication_before_data:true,independent_own_fingerprint_and_all_nonowner_acl_seal:true},
  unchanged_historical_certificate_rows:true,source_compilation_performed:false,native_certification:false,application_activation:false});
}
