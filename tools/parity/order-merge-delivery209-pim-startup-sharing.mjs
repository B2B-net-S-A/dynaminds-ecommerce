/** Source-only PIM invocation sharing. No SQL execution, session cache or admission.
 * The parent must still apply its generic live-source/hash projection with
 * frame=entries to the private leaves and frame=merge_delivery209_local_frame
 * to PIM, authenticate final AFTER records, and seal every private helper.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveOrderMergeDelivery209StartupClosure} from './order-merge-delivery209-startup-capability-closure.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const mask=s=>spans(s).map(x=>x.executable?x.text:x.text.replace(/[^\n]/g,' ')).join('');
const prefix='public.order_merge_delivery209_pim_';
const frame='merge_delivery209_local_frame';
const args='entries jsonb, wave_ok boolean';
const leaves=[['operative_delivery_valid','operative_valid'],['packed_label_print_guards','packed_guards'],['parcel_physical_wz_valid','parcel_valid']];
const issuerKey='public.warehouse_wz_issuer_guards()';
const projectionRoster=freeze([
 {name:'operative_valid',source_reads:1,source_hash_sites:1},
 {name:'packed_guards',source_reads:1,source_hash_sites:1},
 {name:'parcel_valid',source_reads:11,source_hash_sites:11},
 {name:'issuer_guards',source_reads:0,source_hash_sites:0},
]);
export const ORDER_MERGE_DELIVERY209_PIM_ISSUER_SOURCE=freeze({
 source168_sha256:'1ccedd12d27cf4a3fb2f54775fb1e3d413249487d0ad6ea0f27f694b191e6304',
 source151_sha256:'0568417df09db4821a342f166e089076d79058b9b83759d36efd02a30dadd5db',
 source_sha256:'4ddf9eddeaf10271fe6d874da8865983512600a7710601811303864e9580a438',
 definition_sha256:'26136db7d481fbc7aabbe3e30f52ad5be312e41398fcea99b9149ffb0eaccaf1',
 complete_record_sha256:'137385ee76a0222c5efa29b452ae2914b45ff373d181448cbc61eae0bcbddbd8',
 compiled208_archive_sha256:'320ba526496c79605630b7b1c98128bd3039251d72365ceedc75798e2650987d',
 compiled208_serialized_sha256:'c59a648f054433ae469126b4cf47b824572f8813fbdf3b2a7aca515c69d7867d',
});

function replaceExecutable(source,pattern,replacement,count){
 let sites=0;const result=spans(source).map(x=>!x.executable?x.text:x.text.replace(pattern,()=>{sites++;return replacement;})).join('');
 assert.equal(sites,count,'exact source-owned executable replacement');return result;
}
function successor(value,source){
 assert.equal(value.definition.split(value.source).length,2);
 return {...structuredClone(value),source,definition:value.definition.replace(value.source,()=>source)};
}
function privateClone(record,name,source){
 const key=prefix+name+'('+args+')',value=successor(record.value,source);
 assert.equal(value.owner,'postgres');assert.equal(value.volatility,'s');assert.equal(value.security_definer,true);
 value.arguments=args;value.argument_names=['entries','wave_ok'];
 assert.equal(value.definition.split('FUNCTION '+record.key).length,2);
 value.definition=value.definition.replace('FUNCTION '+record.key,()=> 'FUNCTION '+key);
 // Original public EXECUTE grants do not become permissions on private ports.
 value.acl_null=false;value.acl=[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}];
 return {kind:'function',key,value};
}

function projectionCounts(helpers){
 assert(helpers.length===3||helpers.length===4,'fixed partial/complete helper roster');
 return helpers.map((helper,i)=>{
  const expected=projectionRoster[i];assert.equal(helper.key,prefix+expected.name+'('+args+')');
  const pieces=spans(helper.value.source),code=mask(helper.value.source);
  const visible=pieces.map(p=>p.executable||["'UTF8'","'hex'"].includes(p.text)?p.text:p.text.replace(/[^\n]/g,' ')).join('');
  const counts={source_reads:[...code.matchAll(/\b(?:(\w+)\.)?prosrc\b/g)].length,
   definition_reads:[...code.matchAll(/\b(?:public\.)?pg_get_functiondef\s*\(\s*(p\.oid|fn)\s*\)/g)].length,
   metadata_reads:[...code.matchAll(/\b(?:public\.)?(large_import173_metadata|large_import173_predecessor_map)\s*\(\s*\)/g)].length};
  const hashes=[...visible.matchAll(/\bencode\s*\(\s*sha256\s*\(\s*convert_to\s*\(\s*(?:\w+\.)?prosrc\s*,\s*'UTF8'\s*\)\s*\)\s*,\s*'hex'\s*\)/g)].length;
  assert.deepEqual(counts,{source_reads:expected.source_reads,definition_reads:0,metadata_reads:0},'fixed raw source/definition/metadata sites');
  assert.equal(hashes,expected.source_hash_sites,'fixed raw source-SHA sites');
  const identity=expected.name==='issuer_guards';
  if(identity)assert(!/\bprosrc\b|\bpg_get_functiondef\s*\(|\b(?:large_import173_metadata|large_import173_predecessor_map)\s*\(/.test(code),'issuer identity requires zero selected reads of ANY argument shape');
  return {key:helper.key,counts,source_hash_sites:hashes,identity};
 });
}

/** Three complete independently compiled E204 predecessors. The only changed
 * predicate is the nested actual wave evaluation; its existing presence/hash
 * checks and every remaining refusal stay literal. The caller already ran the
 * genuine wave in this same invocation, never a persisted/caller verdict.
 */
export function deriveOrderMergeDelivery209PimSharingLeaves({source204}){
 const closure=deriveOrderMergeDelivery209StartupClosure({source204});
 const before=leaves.map(([name])=>closure.historical_predecessors.find(r=>r.key==='public.'+name+'()'));
 assert(before.every(Boolean));
 const helpers=before.map((record,i)=>privateClone(record,leaves[i][1],replaceExecutable(record.value.source,
  /\bpublic\.wave_print177_valid\(\)/g,'wave_ok',1)));
 return {before,helpers,expected_projection_counts:projectionCounts(helpers)};
}

/** Issuer acceptance requires an independently source-compiled full24 anchor.
 * Its concrete pin is intentionally required by the complete producer; no
 * record from a running database or an unverified caller can be adopted.
 */
export function deriveOrderMergeDelivery209PimStartupSharing({source204,source168}={}){
 const derived=deriveOrderMergeDelivery209PimSharingLeaves({source204});
 if(source168===undefined)return freeze({
  schema:'order-merge-delivery209-pim-startup-sharing/v1',...derived,changes:[],
  missing_source_anchors:[issuerKey],complete_source_derivation:false,
  source_compilation_performed:false,native_certification:false,application_activation:false});
 const issuer=issuerPredecessor(source168),issuerSource=replaceExecutable(issuer.value.source,
  /\bpublic\.parcel_physical_wz_valid\(\)/g,prefix+'parcel_valid(entries,wave_ok)',1);
 const issuerHelper=privateClone(issuer,'issuer_guards',issuerSource);
 const closure=deriveOrderMergeDelivery209StartupClosure({source204});
 const pim=closure.historical_predecessors.find(r=>r.key==='public.pim_dictionary_valid()');assert(pim);
 const targeted=projectOrderMergeDelivery209PimSharingSource(pim.value.source);
 const helpers=[...derived.helpers,issuerHelper];
 return freeze({schema:'order-merge-delivery209-pim-startup-sharing/v1',
  before:[...derived.before,issuer],helpers,expected_projection_counts:projectionCounts(helpers),
  changes:[{kind:'function',key:pim.key,before:pim.value,after:successor(pim.value,targeted.source)}],
  pim_edits:targeted.edits,issuer_source:ORDER_MERGE_DELIVERY209_PIM_ISSUER_SOURCE,
  sql:helpers.map(r=>r.value.definition.trimEnd()+';\nREVOKE ALL ON FUNCTION '+r.key.replace(args,'jsonb,boolean')+' FROM PUBLIC,dyna_app;').join('\n'),
  shared_wave_evaluations:1,all_original_dispatch_names_preserved:true,
  complete_source_derivation:true,preprojection_only:true,
  parent_requirements:{private_generic_source_projection_frame:'entries',pim_generic_source_projection_frame:frame,
   genuine_pim_entry_frame_required:true,private_generic_hash_projection:true,final_after_records_before_data:true,
   private_acl_seal_required:true,invocation_only:true},
  source_compilation_performed:false,native_certification:false,application_activation:false});
}

function issuerPredecessor(source168){
 const pins=ORDER_MERGE_DELIVERY209_PIM_ISSUER_SOURCE;
 assert.equal(typeof source168,'string');assert(Buffer.byteLength(source168)<=1048576);assert.equal(sha(source168),pins.source168_sha256);
 const marker='CREATE OR REPLACE FUNCTION warehouse_wz_issuer_guards() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$';
 assert.equal(source168.split(marker).length,2);const start=source168.indexOf(marker)+marker.length,end=source168.indexOf('$$;',start);assert(end>start);
 const source=source168.slice(start,end);assert.equal(Buffer.byteLength(source),1908);assert.equal(sha(source),pins.source_sha256);
 const definition="CREATE OR REPLACE FUNCTION public.warehouse_wz_issuer_guards()\n RETURNS boolean\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$"+source+'$function$\n';
 assert.equal(sha(definition),pins.definition_sha256);
 const value={owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,
  leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,
  argument_names:null,argument_modes:null,arguments:'',result:'boolean',defaults:null,source,binary:null,
  config:['search_path=pg_catalog, public'],definition,acl_null:false,
  acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
 const record={kind:'function',key:issuerKey,value};assert.equal(Object.keys(value).length,24);
 assert.equal(digest(record),pins.complete_record_sha256,'literal Source168/full24 equals independently compiled Source208 anchor');
 return record;
}

/** Pure targeted PIM stage, kept separate from generic source/frame projection.
 * Only the first (177) dispatcher changes; older fallback bodies remain literal.
 */
export function projectOrderMergeDelivery209PimSharingSource(source){
 assert.equal(typeof source,'string');const executable=mask(source);
 const declaration=[...executable.matchAll(/\bDECLARE\b/g)];assert.equal(declaration.length,1);
 assert(!/\bwave_ok\b/.test(executable),'no preexisting invocation verdict');
 const oldWave='OR public.wave_print177_valid() IS DISTINCT FROM true THEN RETURN false;END IF;';
 const waveCalls=[...executable.matchAll(/\bpublic\.wave_print177_valid\(\)/g)];assert.equal(waveCalls.length,1);
 const waveAt=waveCalls[0].index-3;assert.equal(source.slice(waveAt,waveAt+oldWave.length),oldWave);
 const command="EXECUTE format('SELECT public.%I()',guard_name) INTO guard_ok;";
 const first=source.indexOf(command);assert(first>waveAt);assert.equal(executable.slice(first,first+7),'EXECUTE');
 assert.equal(source.split(command).length-1,4,'all four original dispatcher branches');
 const dispatch=[...leaves.map(([name,own])=>[name,own]),['warehouse_wz_issuer_guards','issuer_guards']]
  .map(([name,own],i)=>(i?'ELSIF':'IF')+" guard_name='"+name+"' THEN guard_ok:="+prefix+own+'('+frame+',wave_ok);').join('')
  +'ELSE '+command+'END IF;';
 const edits=[
  {start:declaration[0].index+7,before:'',after:' wave_ok boolean;'},
  {start:waveAt,before:oldWave,after:'THEN RETURN false;END IF;\n wave_ok:=public.wave_print177_valid();\n IF wave_ok IS DISTINCT FROM true THEN RETURN false;END IF;'},
  {start:first,before:command,after:dispatch},
 ].sort((a,b)=>a.start-b.start);
 let result=source;for(const e of [...edits].reverse()){assert.equal(result.slice(e.start,e.start+e.before.length),e.before);result=result.slice(0,e.start)+e.after+result.slice(e.start+e.before.length);}
 let shift=0;for(const e of edits){e.output_start=e.start+shift;shift+=e.after.length-e.before.length;}
 let inverse=result;for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.output_start,e.output_start+e.after.length),e.after);inverse=inverse.slice(0,e.output_start)+e.before+inverse.slice(e.output_start+e.after.length);}
 assert.equal(inverse,source,'complete PIM targeted inverse');
 return {source:result,edits,source_before_sha256:sha(source),source_after_sha256:sha(result),
  all_original_dispatch_names_preserved:true,shared_wave_evaluations:1};
}
