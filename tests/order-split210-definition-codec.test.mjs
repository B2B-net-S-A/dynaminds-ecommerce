/** Pure codec mutations against the complete source-authored22 descriptor set. */
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {gunzipSync} from 'node:zlib';import {createHash} from 'node:crypto';
import {deriveOrderSplit210Closure,orderSplit210TaggedDescriptor} from '../tools/parity/order-split210-closure.mjs';
import {deriveOrderSplit210MetadataFreshMap} from '../tools/parity/order-split210-metadata-fresh-map.mjs';
import {ORDER_SPLIT210_DEFINITION_CODEC,orderSplit210DefinitionCodecSql,encodeOrderSplit210DefinitionData,decodeOrderSplit210DefinitionData,decodeOrderSplit210DefinitionEntry,deriveOrderSplit210DefinitionCodec} from '../tools/parity/order-split210-definition-codec.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8'),sha=s=>createHash('sha256').update(s).digest('hex');
const fixture=/gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:131072\}\)/.exec(read('tests/order-split210-layer.test.mjs'));assert(fixture);
const sourceBundle=JSON.parse(gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:131072}));
const names={source104:'104_order_merge_custody.sql',source108:'108_b2b_dropshipping.sql',source160:'160_b2b_credit.sql',source169:'169_manual_inventory_off.sql',source204:'204_partial_commercial_sale_scope.sql'};
const inputs={businessInputs:Object.fromEntries(Object.entries(names).map(([k,p])=>[k,read('server/'+p)])),sourceBundle,source158:read('server/158_fa3_draft_native.sql'),source159:read('server/159_b2b_invoice.sql'),source210:read('tools/parity/order-split210-business.sql'),sourceSchema:read('server/schema.sql')};
const currentClosure=deriveOrderSplit210Closure(inputs),logical=currentClosure.logical_data,codec=deriveOrderSplit210DefinitionCodec(logical),physical=codec.physicalData,copy=v=>structuredClone(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const serialized=v=>JSON.stringify(canonical(v));
test('Source31 logical metadata inverse preserves the entire historical Source30 DATA witness',()=>{
 const fixture=/const before=JSON\.parse\(gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:32768\}\)/.exec(read('tests/order-split210-metadata-fresh-map.test.mjs'));assert(fixture);const previous=JSON.parse(gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:32768})),fresh=deriveOrderSplit210MetadataFreshMap(previous.source),old=copy(logical),entry=old.changes.find(c=>c.key==='public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)');
 entry.after={...entry.after,source:fresh.source,definition:fresh.definition};entry.after_check=orderSplit210TaggedDescriptor(entry.after);const codec=deriveOrderSplit210DefinitionCodec(old);
 assert.equal(codec.logical_data.bytes,4192445);assert.equal(codec.logical_data.sha256,'fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45');
 assert.deepEqual(decodeOrderSplit210DefinitionData(codec.physicalData),old);assert.equal(serialized(old),serialized(decodeOrderSplit210DefinitionData(codec.physicalData)));
});

test('fixed ordered roster matches all22 source-authored changes, complete24 descriptors and immutable API',()=>{
 assert.deepEqual(ORDER_SPLIT210_DEFINITION_CODEC.keys,logical.changes.map(c=>c.key));assert.equal(new Set(ORDER_SPLIT210_DEFINITION_CODEC.keys).size,22);
 assert(logical.changes.every(c=>Object.keys(c.before).length===24&&Object.keys(c.after).length===24));
 assert(Object.isFrozen(codec)&&Object.isFrozen(physical.changes[0].after.definition));assert.throws(()=>physical.changes[0].after.definition.push('wrong'));
});
test('lossless entire canonical DATA inverse preserves all22 rawBEFORE, rawAFTERsource and every other field',()=>{
 const decoded=decodeOrderSplit210DefinitionData(physical);assert.deepEqual(decoded,logical);assert.equal(serialized(decoded),serialized(logical));
 assert.equal(codec.logical_data.bytes,4235679);assert.equal(codec.logical_data.sha256,'01ab182b9b1ee0f35a3e7fd9505aeafd9415b516c843d6265c20017139008b9e');
 assert.deepEqual(physical,currentClosure.data);assert.deepEqual(codec.physical_data,{bytes:3590688,sha256:'db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3'});
 for(let i=0;i<22;i++){assert.deepEqual(physical.changes[i].before,logical.changes[i].before);assert.equal(physical.changes[i].after.source,logical.changes[i].after.source);assert.deepEqual(physical.changes[i].after_check,logical.changes[i].after_check);assert.deepEqual(decodeOrderSplit210DefinitionEntry(physical.changes[i]),logical.changes[i]);}
 assert.equal(codec.saved_bytes,codec.logical_data.bytes-codec.physical_data.bytes);assert(codec.saved_bytes>620000);assert(codec.physical_data.bytes<3600000);assert.equal(codec.physical_data.sha256,sha(serialized(physical)));
});
test('encoding and decoding do not mutate callers and do not accept double encoding or decoding',()=>{
 const caller=copy(logical),before=serialized(caller),encoded=encodeOrderSplit210DefinitionData(caller);assert.equal(serialized(caller),before);assert.deepEqual(encoded,physical);
 assert.throws(()=>encodeOrderSplit210DefinitionData(encoded));assert.throws(()=>decodeOrderSplit210DefinitionData(logical));
});
test('NULL, primitives, wrong physical version, missing/scalar/short/extra changes fail closed',()=>{
 for(const v of [null,undefined,false,0,'x',[],{}])assert.throws(()=>decodeOrderSplit210DefinitionData(v));
 for(const mutate of [v=>v.schema='wrong',v=>delete v.changes,v=>v.changes={},v=>v.changes.pop(),v=>v.changes.push(copy(v.changes[0]))]){const v=copy(physical);mutate(v);assert.throws(()=>decodeOrderSplit210DefinitionData(v));}
});
test('exact ordered22-key roster rejects changed kind, unknown, duplicate and swapped keys',()=>{
 for(const mutate of [v=>v.changes[0].kind='trigger',v=>v.changes[0].key='public.unknown()',v=>v.changes[1].key=v.changes[0].key,v=>[v.changes[0],v.changes[1]]=[v.changes[1],v.changes[0]]]){const v=copy(physical);mutate(v);assert.throws(()=>decodeOrderSplit210DefinitionData(v));}
 assert.throws(()=>decodeOrderSplit210DefinitionEntry({...physical.changes[0],key:'public.unknown()'}));
});
test('strict marker rejects null/string/object/version/length/rawdefinition and typed source fields',()=>{
 for(const bad of [null,'order-split210-after-definition/v1',{},[],['wrong'],['order-split210-after-definition/v1','extra'],logical.changes[0].after.definition]){const e=copy(physical.changes[0]);e.after.definition=bad;assert.throws(()=>decodeOrderSplit210DefinitionEntry(e));}
 for(const bad of [null,0,[],{}]){const e=copy(physical.changes[0]);e.after.source=bad;assert.throws(()=>decodeOrderSplit210DefinitionEntry(e));}
});
test('complete24-field descriptors preserve header/ACL types, rejecting omissions, extras and drift',()=>{
 for(const mutate of [e=>delete e.before.cost,e=>e.after.extra=true,e=>e.after.owner='other',e=>e.after.acl=[],e=>e.before=null,e=>e.after=[]]){const e=copy(physical.changes[0]);mutate(e);assert.throws(()=>decodeOrderSplit210DefinitionEntry(e));}
});
test('header/body/suffix and fixeddelimiter faults cannot turn into reconstructed authority',()=>{
 for(const mutate of [e=>e.before.definition+='x',e=>e.before.source+='x',e=>e.before.definition=e.before.definition.replace('AS $function$','AS $other$'),e=>e.before.definition='AS $function$'+e.before.definition,e=>e.after.source+='$function$',e=>e.before.definition=e.before.definition.replace('public.fa3_draft_fingerprint','public.other')]){const e=copy(physical.changes[0]);mutate(e);assert.throws(()=>decodeOrderSplit210DefinitionEntry(e));}
 const l=copy(logical);l.changes[0].after.definition+='x';assert.throws(()=>encodeOrderSplit210DefinitionData(l));
});
test('non JSON, cycles, prototype and accessor objects fail rather than lose data during cloning',()=>{
 for(const extra of [undefined,NaN,Infinity,1n,()=>{}]){const l=copy(logical);l.extra=extra;assert.throws(()=>encodeOrderSplit210DefinitionData(l));}
 const cyclic=copy(logical);cyclic.extra=cyclic;assert.throws(()=>encodeOrderSplit210DefinitionData(cyclic));
 const inherited=Object.create(logical);assert.throws(()=>encodeOrderSplit210DefinitionData(inherited));
 const accessor=copy(logical);Object.defineProperty(accessor,'extra',{enumerable:true,get(){throw Error('getter executed');}});assert.throws(()=>encodeOrderSplit210DefinitionData(accessor),/accessors/);
});
test('unrelated valid JSON payload fields survive exact roundtrip, including Unicode and special keys',()=>{
 const l=copy(logical);l.unrelated=JSON.parse('{"żółć":[null,true,0,"A\\nB"],"__proto__":{"keep":true}}');const decoded=decodeOrderSplit210DefinitionData(encodeOrderSplit210DefinitionData(l));assert.deepEqual(decoded,l);
});
test('SQL contracts are inline guarded assignments, no new locals/functions/IO, per-entry remains scoped',()=>{
 assert(codec.decodeAssignmentSql.includes("ERRCODE='55000'"));assert(codec.decodeEntrySql.includes("ERRCODE='55000'"));assert(codec.decodeAssignmentSql.includes('jsonb_array_length(entries->\'changes\')=22'));
 assert(codec.decodeAssignmentSql.includes('WITH ORDINALITY'));assert(codec.decodeAssignmentSql.includes('ORDER BY c31_codec.ordinal'));
 assert(codec.decodeEntrySql.includes('entry:=jsonb_set(entry'));assert(!codec.decodeEntrySql.includes('jsonb_array_elements(entries'));
 for(const block of [codec.decodeAssignmentSql,codec.decodeEntrySql]){assert(!/CREATE|DECLARE|pg_get_functiondef|pg_proc|EXECUTE|COMMIT|ROLLBACK/.test(block.replaceAll('CREATE OR REPLACE FUNCTION ','')));assert(block.includes('IS DISTINCT FROM true THEN RAISE'));assert(block.includes('before,definition'));assert(block.includes('after,source'));assert(block.includes('jsonb_object_keys'));assert(block.includes('AS c31_codec_fields(c31_field)'));assert(!/jsonb_agg\(k\b/.test(block));assert(block.includes('order-split210-after-definition/v1'));assert(!block.includes('\\n'));}
 assert.equal(codec.source_compilation_performed,false);assert.equal(codec.native_certification,false);assert.equal(codec.performance_acceptance,false);
});

test('zeroargument SQL export preserves exact probed SQL and returns immutable blocks',()=>{
 const fixed=orderSplit210DefinitionCodecSql();assert(Object.isFrozen(fixed));assert.equal(fixed.decodeEntrySql,codec.decodeEntrySql);assert.equal(fixed.decodeAssignmentSql,codec.decodeAssignmentSql);assert.equal(Buffer.byteLength(fixed.decodeEntrySql),3877);assert.equal(sha(fixed.decodeEntrySql),'00d7a85bfd5ede2d184bfa460cf8f7d8c4335cf2524b1a180ba582ec47dd4ec2');assert.throws(()=>orderSplit210DefinitionCodecSql(undefined));assert.throws(()=>orderSplit210DefinitionCodecSql({}));
});
