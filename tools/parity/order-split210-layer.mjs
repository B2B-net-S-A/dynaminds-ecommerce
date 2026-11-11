/** Accepted Source22b → ten authored210 layer deltas. No SQL execution/activation.
 * Small selected literal routines only; no full catalogue/E204 import. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {deriveOrderSplit210MetadataFreshMap} from './order-split210-metadata-fresh-map.mjs';
import {deriveOrderSplit210MetadataComposite} from './order-split210-metadata-composite.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const prefix='public.order_merge_delivery209_';
const specs=[
 ["validation_snapshot","","jsonb","sql","fccf501dfdf9b530a173abc15505e9e3c0dd4d9c77a915c0837a0c3368ef771c"],
 ["predecessor_descriptor","fn oid","jsonb","plpgsql","ebff2cd5a189559708f9cb32b4e841cfe3f6cc5589cc2b1670ce04792886425a"],
 ["predecessor_definition","fn oid","text","plpgsql","a298799d7566e50151d8f9817b60bac2f58634aca6e6180838fa3fa93664e874"],
 ["predecessor_source","fn oid","text","plpgsql","7d9909cf98a376af87d5fa893421f539c2c2d679b518370cff8dabc80c567b8d"],
 ["predecessor_metadata","value jsonb","jsonb","plpgsql","73c070cbffdbc71b55b82ac9e3c7195c1ae2a57875110a76bae9975a36414056"],
 ["predecessor_descriptor","fn oid, entries jsonb","jsonb","plpgsql","a739ec1464d8ebf1b5aed0ee273763fe9db378a9f15d9fc3902982936d121d78"],
 ["predecessor_definition","fn oid, entries jsonb","text","plpgsql","ebba21019493fba33e04d472a1d112b19691ab3293e5ba93d214b6944f0b3702"],
 ["predecessor_source","fn oid, entries jsonb","text","plpgsql","c6f2357ef981abf1c6282db4248a4e2a34737823956d67b16ef3c3c7afeb9289"],
 ["predecessor_metadata","value jsonb, entries jsonb","jsonb","plpgsql","6b9cb7db2d94bb318d03c1d1e70f7c7a060f68ad791e073e5298c7e913c071eb"],
 ["predecessor_source_sha","fn oid, entries jsonb","text","plpgsql","eea1406fd45a2e3719e4e4c93a03a09365590a37025dbc3ebc11b3395a047c1b"],
].map(([name,args,result,language,sql_sha256])=>({name,args,result,language,sql_sha256,key:prefix+name+'('+args+')'}));
export const ORDER_SPLIT210_LAYER_PARENT=freeze({
 source_sha256:'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a',source_bytes:28449419,
 source_contract_sha256:'121abfe5df79f03f9d3acd38e566bbcf53c18ec0b4bf418c316632138cd37070',
 native_receipt_sha256:'9942cd0f31631af320c535b424a0c41ee7a3ad912faba64a964b44da8d0f5989',
 native_review_sha256:'c3083fdf081056ef7085cae2423ecfa7233d37722769a9dfe32b37e2326737c1',
 legacy_function_count:17,source_addition_count:259,
 seal_sha256:'2811b1d9f543a411ea56af236b1772b69d4ab53fcadda38bda1e9dd673fb803f',
 routines:specs,source_native_acceptance:true,
});
const target=/^CREATE FUNCTION public\.order_merge_delivery209_(?:predecessor_(?:descriptor|definition|source|metadata|source_sha)|validation_snapshot)\(/;

/** Full source bytes are hashed, never retained. Unselected DATA lines are
 * discarded after4KiB; selected routines have a finite8MiB bound. This reader
 * is ONLY for the exact pinned generated program, not arbitrary SQL parsing. */
export async function readOrderSplit210LayerSource({sourcePath}){
 const hash=createHash('sha256'),decoder=new StringDecoder('utf8'),routines=[],seals=[];
 let bytes=0,line='',skip=false,active=null;
 function emit(value){
  if(active){
   active.parts.push(value+'\n');active.bytes+=Buffer.byteLength(value)+1;
   assert(active.bytes<=8388608,'selected routine byte cap');
   if(value.includes(active.tag)){const text=active.parts.join('');(active.seal?seals:routines).push(text);active=null;assert(routines.length<=10&&seals.length<=1,'closed selected declaration roster');}
   return;
  }
  if(target.test(value)||value.startsWith('DO $sealacl209$')){
   const tag=value.match(/\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/);assert(tag,'authored function dollar header');
   active={parts:[value+'\n'],bytes:Buffer.byteLength(value)+1,tag:tag[0],seal:value.startsWith('DO ')};
  }
 }
 for await(const chunk of createReadStream(sourcePath,{highWaterMark:32768})){
  hash.update(chunk);bytes+=chunk.length;assert(bytes<=ORDER_SPLIT210_LAYER_PARENT.source_bytes,'source byte cap');
  const pieces=decoder.write(chunk).split('\n');
  for(let i=0;i<pieces.length;i++){
   if(!skip){line+=pieces[i];if(!active&&line.length>4096){line='';skip=true;}else if(active)assert(Buffer.byteLength(line)+active.bytes<=8388608,'selected line byte cap');}
   if(i<pieces.length-1){if(!skip)emit(line);line='';skip=false;}
  }
 }
 assert.equal(decoder.end(),'','complete UTF8 chunk');assert(!line&&!skip&&!active,'complete source trailing newline/declarations');
 assert.equal(bytes,ORDER_SPLIT210_LAYER_PARENT.source_bytes);assert.equal(hash.digest('hex'),ORDER_SPLIT210_LAYER_PARENT.source_sha256,'exact accepted Source22b program');
 assert.equal(routines.length,10);assert.equal(seals.length,1);
 const bundle={schema:'order-split210-layer-source/v1',source_sha256:ORDER_SPLIT210_LAYER_PARENT.source_sha256,source_bytes:bytes,routines,seal:seals[0]};
 verify(bundle);return freeze(bundle);
}
function parse(sql){
 assert.equal(typeof sql,'string');assert(Buffer.byteLength(sql)<=8388608);
 const h=/^CREATE FUNCTION public\.order_merge_delivery209_(\w+)\(([^()]*)\) RETURNS (text|jsonb) LANGUAGE (plpgsql|sql) STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS (\$[A-Za-z_0-9]*\$)/.exec(sql);
 assert(h,'entire selected literal function header, no unrecognized attributes');
 const [,name,rawArgs,result,language,tag]=h,args=rawArgs.split(',').map(x=>x.trim()).join(', '),key=prefix+name+'('+args+')';
 const spec=specs.find(s=>s.key===key);assert(spec,'exact selected routine identity');
 assert.equal(result,spec.result);assert.equal(language,spec.language);assert.equal(sha(sql),spec.sql_sha256,'literal source routine pin');
 const end=sql.indexOf(tag,h[0].length);assert(end>h[0].length);assert.equal(sql.slice(end+tag.length),';\n','complete selected source terminator');
 const source=sql.slice(h[0].length,end);
 return{spec,source};
}
function verify(bundle){
 assert(bundle&&bundle.schema==='order-split210-layer-source/v1');
 assert.equal(bundle.source_sha256,ORDER_SPLIT210_LAYER_PARENT.source_sha256);assert.equal(bundle.source_bytes,ORDER_SPLIT210_LAYER_PARENT.source_bytes);
 assert.equal(typeof bundle.seal,'string');assert.equal(sha(bundle.seal),ORDER_SPLIT210_LAYER_PARENT.seal_sha256,'entire source ACL seal');
 assert(bundle.seal.includes("FOR o IN SELECT p.proowner owner,p.proacl acl,p.oid::regprocedure::text identity FROM pg_proc p"));
 assert(bundle.seal.includes("EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',o.identity"));
 assert(Array.isArray(bundle.routines)&&bundle.routines.length===10,'all ten selected literal routines');
 const parsed=bundle.routines.map(parse);assert.equal(new Set(parsed.map(p=>p.spec.key)).size,10,'no duplicate/overload/substitute');return parsed;
}
function definition(spec,source){return 'CREATE OR REPLACE FUNCTION '+spec.key+'\n RETURNS '+spec.result+'\n LANGUAGE '+spec.language+'\n STABLE SECURITY DEFINER\n SET search_path TO \'pg_catalog\', \'public\'\nAS $function$'+source+'$function$\n';}
function descriptor(spec,source){return{owner:'postgres',language:spec.language,kind:'f',cost:100,rows:0,security_definer:true,
 leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,
 argument_names:spec.args?spec.args.split(', ').map(a=>a.split(' ')[0]):null,argument_modes:null,arguments:spec.args,
 result:spec.result,defaults:null,source,binary:null,config:['search_path=pg_catalog, public'],definition:definition(spec,source),
 acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};}
function replaceOnce(source,before,after){
 assert.equal(source.split(before).length-1,1,'one exact accepted source composition site');
 return source.replace(before,after);
}
const projectLive="live:=public.order_split210_project209_record(jsonb_build_object('kind','function','key',actual_key,'value',live))->'value';";
const snapshotKeys=Object.freeze([...specs.map(spec=>spec.key),'public.buyer_address_guards()','public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)','public.order_merge_delivery209_buyer_guards(manual_basis jsonb)','public.order_merge_delivery209_startup_operative_valid(entries jsonb)']);
const snapshotKeySql='ARRAY['+snapshotKeys.map(key=>"'"+key+"'").join(',')+']::text[]';
function snapshotProjection(alias){
 const record=alias+'.record';
 // The complete source DATA is authenticated by the entry require(). This
 // expression is private to that same snapshot invocation, never a new port.
 // An unexpected scoped record still takes the unchanged strict fresh helper.
 return `CASE WHEN ${record}->>'kind' IS DISTINCT FROM 'function' OR NOT(${record}->>'key'=ANY(${snapshotKeySql})) THEN ${record}
 WHEN ${record} IS NOT DISTINCT FROM snapshot210_binding.after_record THEN snapshot210_binding.before_record
 ELSE public.order_split210_project209_record(${record}) END`;
}
const snapshotMap=`
 WITH split210_snapshot_map(split210_key,after_record,before_record) AS MATERIALIZED (
  SELECT change->>'key',jsonb_build_object('kind','function','key',change->>'key','value',change->'after_check'),jsonb_build_object('kind','function','key',change->>'key','value',change->'before_check')
  FROM public.order_split210_projection_basis basis210 CROSS JOIN LATERAL jsonb_array_elements(basis210.payload_jsonb->'changes') source210(change)
  WHERE basis210.id AND change->>'key'=ANY(${snapshotKeySql})
 )
 SELECT split210_snapshot_result.snapshot FROM(`;
const snapshotJoin=alias=>' LEFT JOIN split210_snapshot_map snapshot210_binding ON snapshot210_binding.split210_key='+alias+".record->>'key'";
function changePort(spec,source){
 assert(!source.includes('split210_projection'),'new local cannot shadow the parent');
 assert.equal(source.split('DECLARE ').length,2,'one top-level declaration');
 const at=source.indexOf('BEGIN\n');assert(at>=0,'literal outer BEGIN');
 const metadata=spec.name==='predecessor_metadata';
 const port=metadata
  ?'\n split210_projection:=public.order_split210_try_metadata_projection(value);\n IF split210_projection IS NOT NULL THEN value:=split210_projection;result:=value::text;END IF;\n'
  :'\n split210_projection:=public.order_split210_try_function_projection(fn);\n IF split210_projection IS NOT NULL THEN RETURN '+
   (spec.name==='predecessor_descriptor'?'split210_projection':spec.name==='predecessor_source_sha'?"encode(sha256(convert_to(split210_projection->>'source','UTF8')),'hex')":"split210_projection->>'"+(spec.name==='predecessor_source'?'source':'definition')+"'")+';END IF;\n';
 let result=source.slice(0,at+'BEGIN'.length)+port+source.slice(at+'BEGIN'.length);
 // The four unbound business ports above return their complete209 BEFORE.
 // Buyer is a legacy209 member: its live210 descriptor must first project to
 //209 AFTER, then pass every original209 frame/roster/source check to reach208.
 if((spec.name==='predecessor_descriptor'&&spec.args==='fn oid')||metadata){
  const check="  IF actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'";
  result=replaceOnce(result,check,'  '+projectLive+'\n'+check);
 }else if((spec.name==='predecessor_descriptor'||spec.name==='predecessor_source_sha')&&spec.args==='fn oid, entries jsonb'){
  const check=" IF total<>1 OR entry IS NULL OR entry->>'key' IS DISTINCT FROM actual_key OR live IS DISTINCT FROM entry->'after_check'";
  result=replaceOnce(result,check,' '+projectLive+'\n'+check);
 }
 return{source:result.replace('DECLARE ','DECLARE split210_projection jsonb;'),inserted_body:port};
}
function changeSnapshot(source){
 // This representation already tags source/definition with SHA256 of UTF8,
 // before any JSONB::text. Project that FULL representation, never raw-source
 // assumptions or a bare source hash dropping other descriptor fields.
 const own=source.indexOf("'own',");assert(own>=0&&source.indexOf("'own',",own+1)<0);
 const open=source.indexOf(' FROM(',own),close=source.indexOf(') own209',open);
 assert(open>own&&close>open&&source.indexOf(') own209',close+1)<0,'one exact own209 recordset');
 const query=source.slice(open+' FROM('.length,close);
 assert(query.includes("SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries"),'current complete canonical record arm');
 assert(query.includes("'source',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))")
  &&query.includes("'definition',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'))"),'exact source+definition tagged SHA representation');
 let result=source.slice(0,open)+' FROM(SELECT '+snapshotProjection('raw209')+' AS record FROM('+query+') raw209'+snapshotJoin('raw209')+source.slice(close);
 // Keep the whole current17 MATERIALIZED producer literal. Both consumers
 // require the same complete tagged-record inverse, including buyer's header
 // and ACL. The map is read once, AFTER the fresh whole210 guard; it contains
 // no observed descriptors or stored verdict. Keeping it outside the original
 // query preserves even the entire WITH legacy209_current producer literally.
 const legacy=" FROM(SELECT jsonb_build_object('kind',kind,'key',key,'value',value) AS record FROM legacy209_current) raw_legacy209"+snapshotJoin('raw_legacy209')+' CROSS JOIN LATERAL jsonb_to_record('+snapshotProjection('raw_legacy209')+') AS legacy209(kind text,key text,value jsonb)';
 result=replaceOnce(result,' FROM legacy209_current legacy209(kind,key,value)',legacy);
 result=replaceOnce(result,' FROM legacy209_current)\n) AS snapshot',legacy+')\n) AS snapshot');
 return{source:'\n SELECT public.order_split210_require();'+snapshotMap+result+'\n ) split210_snapshot_result\n',original_query:query};
}
export function deriveOrderSplit210Layer({sourceBundle}){
 const parsed=verify(sourceBundle),changes=[];let metadataFreshMap,metadataComposite;
 for(const spec of specs){
  const original=parsed.find(p=>p.spec.key===spec.key),before=descriptor(spec,original.source);
  let projected=spec.name==='validation_snapshot'?changeSnapshot(original.source):changePort(spec,original.source);
  if(spec.name==='predecessor_metadata'&&spec.args==='value jsonb, entries jsonb'){
   metadataFreshMap=deriveOrderSplit210MetadataFreshMap(projected.source);
   projected={...projected,source:metadataFreshMap.source};
   assert.equal(definition(spec,projected.source),metadataFreshMap.definition,'fixed metadata header is unchanged');
   const compositeSnapshot=changes.find(change=>change.key==='public.order_merge_delivery209_validation_snapshot()');assert(compositeSnapshot,'earlier source-authored snapshot');
   metadataComposite=deriveOrderSplit210MetadataComposite(metadataFreshMap.source,compositeSnapshot.after.source);
   projected={...projected,source:metadataComposite.source};assert.equal(definition(spec,projected.source),metadataComposite.definition,'complete composite header/body binding');
  }
  changes.push({kind:'function',key:spec.key,before,after:descriptor(spec,projected.source)});
 }
 assert(metadataFreshMap&&metadataComposite,'one exact two-argument metadata successor and finite composite');
 return freeze({schema:'order-split210-ten-layer-deltas/v1',parent:ORDER_SPLIT210_LAYER_PARENT,changes,source_proofs:{metadataFreshMap209:metadataFreshMap.source_proofs,metadataComposite209:metadataComposite.source_proofs},
  required_private_ports:[
   {key:'public.order_split210_try_function_projection(fn oid)',contract:'cheap exact public/name gate for four business routines; SQL NULL outside scope; any matching name/overload requires fresh whole210+full current AFTER before returning complete parent209 descriptor value'},
   {key:'public.order_split210_try_metadata_projection(value jsonb)',contract:'SQL NULL without relevant four full target metadata; before any transformation validate exact complete current AFTER and fresh whole210; no substring/prefix normalization; preserve all other metadata'},
   {key:'public.order_split210_project209_record(record jsonb)',contract:'validate whole current tagged-leaf canonical record; inverse exactly ten own209 changed routines and the legacy buyer successor to full parent209 tagged representation; preserve all17 current producer rows and all other records; no raw-text/tagged mismatch or omitted metadata'},
   {key:'public.order_split210_require()',contract:'RAISE on partial/drift/extra/missing/changed parent manifest; own210 fingerprint reads metadata only, NEVER executes209_valid/fingerprint; no verdict/session cache'},
  ],
  source_compilation_performed:false,full_before_descriptors_compiler_verified:false,private_ports_implemented:false,
  complete_fourteen_change_closure:false,native_certification:false,application_activation:false});
}
