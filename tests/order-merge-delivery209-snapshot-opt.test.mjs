import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {deriveOrderMergeDelivery209SnapshotOpt as derive} from '../tools/parity/order-merge-delivery209-snapshot-opt.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';

const keys=['buyer_address_preview_guard()','buyer_address_state_guard()','buyer_address_guards()','buyer_address_fingerprint()',
 'manual_inventory_off_valid()','manual_inventory_off_projection_valid()','partial_sale204_predecessor_definition(fn oid)',
 'ordinary187_valid()','partial_sale204_valid()','catalog_header205_valid()'].map(x=>'public.'+x);
function descriptor(key,index){
 const source='\nBEGIN\n -- '+index+' Żółć 🧪 \\\n RETURN true;\nEND\n',tag=index===2?'$different_delimiter$':'$function$';
 return{owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,leakproof:false,strict:false,
  returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,argument_names:null,argument_modes:null,
  arguments:'',result:'boolean',defaults:null,source,binary:null,config:['search_path=pg_catalog, public'],
  definition:'CREATE OR REPLACE FUNCTION '+key+'\n RETURNS boolean\n LANGUAGE plpgsql\nAS '+tag+source+tag+'\n',
  acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
}
const changes=keys.map((key,i)=>({kind:'function',key,before:descriptor(key,i),after:descriptor(key,i)}));
const result=derive({changes}),sha=x=>createHash('sha256').update(x).digest('hex');
const once=(s,a,b)=>{assert.equal(s.split(a).length,2);return s.replace(a,()=>b);};

// Independent byte oracle for the proposed SQL CASE. This is not a PG proof.
function extract({definition,source,bounds}){
 const bytes=definition===null?null:Buffer.from(definition),prefix=bounds.prefix===null?null:Buffer.from(bounds.prefix),suffix=bounds.suffix===null?null:Buffer.from(bounds.suffix);
 const size=source===null?null:Buffer.byteLength(source);
 const fast=bytes!==null&&size!==null&&prefix!==null&&suffix!==null&&bytes.length===prefix.length+size+suffix.length
  &&bytes.subarray(0,prefix.length).equals(prefix)&&bytes.subarray(bytes.length-suffix.length).equals(suffix);
 return {fast,bytes:fast?bytes.subarray(prefix.length,prefix.length+size):source===null?null:Buffer.from(source)};
}

test('all original query bytes except the two text-byte expressions and fixed join are independently recoverable',()=>{
 let restored=once(result.query,'WITH '+result.definition_cte+'legacy209_current','WITH legacy209_current');
 restored=once(restored,result.source_bytes_expression,"convert_to(p.prosrc,'UTF8')");
 restored=once(restored,"'definition',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(d209.definition_bytes),'hex'))",
  "'definition',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'))");
 restored=once(restored,result.join,'');assert.equal(restored,result.original_query);
 for(const field of Object.keys(changes[0].after))assert(result.legacy_query.includes("'"+field+"',"),field);
 assert.equal(result.current_descriptor_fields,24);assert.deepEqual(result.current_complete_text_digests,['source','definition']);
});

test('one fresh definition producer preserves every same-name overload and does not embed authored hashes or bodies',()=>{
 const executable=spans(result.query).filter(x=>x.executable).map(x=>x.text).join('');
 assert.equal((result.definition_cte.match(/pg_catalog\.pg_get_functiondef\(p\.oid\)/g)||[]).length,1);
 assert.equal((result.legacy_query.match(/pg_catalog\.pg_get_functiondef\(p\.oid\)/g)||[]).length,0);
 assert.equal((executable.match(/pg_catalog\.pg_get_functiondef\(p\.oid\)/g)||[]).length,2,'one legacy producer plus unchanged own-function arm');
 assert(result.definition_cte.includes('AS MATERIALIZED'));assert(result.definition_cte.includes('LEFT JOIN definition209_bounds'));
 assert(result.definition_cte.includes('b.key=n.nspname'));assert(!/\bDISTINCT\b|\bLIMIT\b|jsonb_object_agg/.test(result.query));
 assert(!result.query.includes(changes[0].after.source));
 assert(!result.query.includes(sha(changes[0].after.source)),'no source-authored SHA as runtime authority');
 assert(!/\bINSERT\b|\bUPDATE\b|\bset_config\b|\bcurrent_setting\b|\bEXECUTE\b/i.test(executable));
 assert.equal(result.query.split('legacy209_current legacy209(kind,key,value)').length-1,1);
 assert(result.query.includes('FROM legacy209_current)'),'original two consumers retained');
});

test('UTF8, custom delimiters and embedded footer-like body text keep both complete live hashes',()=>{
 for(let i=0;i<changes.length;i++){
  const b=result.framing[i],original=changes[i].after;
  for(const source of [original.source,'\n💶 złoty\n',original.source+b.suffix+'SELECT 2;'+b.suffix,'',"\\\\'\\x00"]){
   const definition=b.prefix+source+b.suffix,current=extract({source,definition,bounds:b});
   assert(current.fast);assert.equal(sha(current.bytes),sha(Buffer.from(source)));
   assert.equal(sha(Buffer.from(definition)),sha(Buffer.concat([Buffer.from(b.prefix),current.bytes,Buffer.from(b.suffix)])));
  }
 }
 assert(result.source_bytes_expression.includes('pg_catalog.octet_length(p.prosrc)'));
 assert(!/char_length\(|position\(|strpos\(/.test(result.source_bytes_expression));
});

test('every header/footer, NULL, byte-length, current delimiter and body mismatch falls back to actual source',()=>{
 const b=result.framing[0],source=changes[0].after.source,def=b.prefix+source+b.suffix;
 for(const [s,d]of [[source,'X'+def],[source,def+'X'],[source,def.slice(0,-1)],[source+'💶',def],[source,null],[null,def],
  [source,def.replaceAll('$function$','$another$')],[source,def.replace('Żółć','Zolc')]]){
  const current=extract({source:s,definition:d,bounds:b});assert.equal(current.fast,false);
  assert.deepEqual(current.bytes,s===null?null:Buffer.from(s));
 }
 // Same-byte CURRENT body tampering still changes both complete digest leaves.
 const changed=source.replace('RETURN true','RETURN TRUE'),next=extract({source:changed,definition:b.prefix+changed+b.suffix,bounds:b});
 assert(next.fast);assert.notEqual(sha(next.bytes),sha(source));
 assert.notEqual(sha(b.prefix+changed+b.suffix),sha(def));
});

test('ineligible authored NULL framing stays identity and malformed partial descriptors/rosters refuse',()=>{
 const nulls=structuredClone(changes);nulls[0].after.source=null;nulls[0].after.definition=null;
 const r=derive({changes:nulls});assert.deepEqual(r.framing[0],{key:keys[0],prefix:null,suffix:null});
 const cur=extract({source:'actual',definition:'anything',bounds:r.framing[0]});assert.equal(cur.fast,false);assert.equal(cur.bytes.toString(),'actual');
 for(const mutate of [x=>x.slice(1),x=>x.reverse(),x=>{x[0]=x[1];return x;},x=>{delete x[0].after.acl;return x;},
  x=>{x[0].after.definition+='unexpected';return x;},x=>{x[0].after.source='\ud800';return x;}])assert.throws(()=>derive({changes:mutate(structuredClone(changes))}));
});

test('prototype neither seals nor changes the ordinary reader or grants acceptance',()=>{
 for(const key of ['integrated','performance_measured','source_compilation_performed','native_certification','application_activation'])assert.equal(result[key],false);
 assert(!result.query.includes('CREATE FUNCTION'));assert(!result.query.includes('209_valid()'));
 assert(Object.isFrozen(result)&&Object.isFrozen(result.framing)&&result.framing.every(Object.isFrozen));
});
