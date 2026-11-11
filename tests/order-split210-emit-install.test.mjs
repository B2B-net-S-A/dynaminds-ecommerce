/** Actual generated-module import, with SYNTHETIC parent birth DATA only.
 * No PG, genuine capture, installation, Native or application acceptance. */
import test from 'node:test';
import {deriveOrderSplit210HistoryOperativeSuccessor} from '../tools/parity/order-split210-history-operative-successor.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {emitOrderSplit210InstallModule as emit} from '../tools/parity/order-split210-emit-install.mjs';
import {deriveOrderSplit210FixedSeal} from '../tools/parity/order-split210-fixed-seal.mjs';
import {assembleOrderSplit210Source} from '../tools/parity/order-split210-source.mjs';
import {ORDER_SPLIT210_SOURCE_CONTRACT as expected,ORDER_SPLIT210_SOURCE_ORIGIN as sourceOrigin} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-split210-source-contract.mjs';
import {orderSplit210ObserverSpans} from '../tools/parity/order-split210-predecessor.mjs';
import {formatOrderSplit210FunctionDefinition} from '../tools/parity/order-split210-addition-oracle.mjs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8'),sha=value=>createHash('sha256').update(value).digest('hex');
const fixture=/gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:131072\}\)/.exec(read('tests/order-split210-layer.test.mjs'));assert(fixture);
const sourceBundle=JSON.parse(gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:131072}).toString('utf8'));
const names={source104:'104_order_merge_custody.sql',source108:'108_b2b_dropshipping.sql',source160:'160_b2b_credit.sql',source169:'169_manual_inventory_off.sql',source204:'204_partial_commercial_sale_scope.sql'};
const inputs={sourceBundle,businessInputs:Object.fromEntries(Object.entries(names).map(([key,name])=>[key,read('server/'+name)])),source158:read('server/158_fa3_draft_native.sql'),source159:read('server/159_b2b_invoice.sql'),source210:read('tools/parity/order-split210-business.sql'),sourceTerminal:read('tools/parity/order-split210-terminal.sql'),sourceSchema:read('server/schema.sql')};
const options={inputs,expectedAdditions:expected.additions,expectedChanges:assembleOrderSplit210Source(inputs).changed_functions};

// Complete historical H33 remains immutable bounded DATA before the constraint-candidates change.
const historicalSource33=(()=>{const fixture=/const historicalSource33Encoded=Buffer\.from\('([^']+)','base64'\);/.exec(read('tests/order-split210-catalogue.test.mjs'));assert(fixture);const packed=Buffer.from(fixture[1],'base64');assert.equal(packed.length,350082);assert.equal(sha(packed),'d7d2908b214c0fd87bcfbfd77346941af8dfaf40b57b17d68a9c7ad71b234536');const raw=gunzipSync(packed,{maxOutputLength:3273120});assert.equal(raw.length,3273120);assert.equal(sha(raw),'9e23c99c53bdc7d0dd58abac262b3b6971823d7dbafe8be8b82c878145d7f0d6');return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));})();

// Complete historical H32 remains immutable bounded DATA before the prefix-range change.
const historicalSource32=(()=>{const fixture=/const historicalSource32Encoded=Buffer\.from\('([^']+)','base64'\);/.exec(read('tests/order-split210-catalogue.test.mjs'));assert(fixture);const packed=Buffer.from(fixture[1],'base64');assert.equal(packed.length,348005);assert.equal(sha(packed),'b0d2e318b85e4977aa2c352662530be9d6dd731139995afe99ff566cedbccf89');const raw=gunzipSync(packed,{maxOutputLength:3271844});assert.equal(raw.length,3271844);assert.equal(sha(raw),'7c74163aebddca7cda4df9584cad55e0d2d6b977bf25cb546a5bbc4d12d5e5bf');return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));})();

// Entire historical H31 remains bounded source DATA; no test module is imported.
const historicalSource31=(()=>{const fixture=/const historicalSource31Encoded=Buffer\.from\('([^']+)','base64'\);/.exec(read('tests/order-split210-catalogue.test.mjs'));assert(fixture);const packed=Buffer.from(fixture[1],'base64');assert.equal(packed.length,349935);assert.equal(sha(packed),'cc9ebae024207908ac540a21cd3580139292f64e4f4f4846f29a8a5e7512c5fe');const raw=gunzipSync(packed,{maxOutputLength:3271512});assert.equal(raw.length,3271512);assert.equal(sha(raw),'23cb94e8a1b3aa59a0c7860b2bb4bcd769383d8103eae95d33294842066e1f0b');const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));assert.equal(value.schema,'source210-order-split-exact-inverse/v6');assert.equal(value.additions.length,493);assert.equal(value.changes.length,22);return value;})();

// Complete immutable H30 witness is read as bounded DATA, never imported.
const historicalSource30=(()=>{const fixture=/const historicalSource30Encoded=Buffer\.from\('([^']+)','base64'\);/.exec(read('tests/order-split210-catalogue.test.mjs'));assert(fixture);const packed=Buffer.from(fixture[1],'base64');assert.equal(packed.length,344027);assert.equal(sha(packed),'b6d512b7b8281d46b15e3f1e53f8f39e85c211db11227335551294737d0e8a4f');const raw=gunzipSync(packed,{maxOutputLength:3179904});assert.equal(raw.length,3179904);assert.equal(sha(raw),'da40c9bfd9278b8c47da59e7d562b089cc592567161e374b66ad97c84ebffdb1');return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));})();

// Complete immutable H29 source DATA is retained literally in catalogue tests.
// Read its bounded literal only; never import or execute that test module.
const historicalSource29=(()=>{
 const text=read('tests/order-split210-catalogue.test.mjs'),fixture=/const historicalSource29Encoded=Buffer\.from\('([^']+)','base64'\);/.exec(text);assert(fixture);
 const packed=Buffer.from(fixture[1],'base64');assert.equal(packed.length,343849);assert.equal(sha(packed),'dfc39309e709d8ccfcf11644d7fd0c76e9234b0fcac26cbcec8d349fd31e40ab');
 const raw=gunzipSync(packed,{maxOutputLength:3179300});assert.equal(raw.length,3179300);assert.equal(sha(raw),'9efb037662110aa10b5518ac9245aa0880b4833af9dfea02d0d7953277c0e3d3');
 const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));assert.equal(value.schema,'source210-order-split-exact-inverse/v6');assert.equal(value.additions.length,493);assert.equal(value.changes.length,22);return value;
})();

// Complete source-only H28 restoration. Shared bounded witness is retained in
// the catalogue tests; reading its literal does not import or execute those tests.
const historicalSource28=(()=>{
 const fixture=/const historicalSource28DeltaEncoded=Buffer\.from\('([^']+)','base64'\);/.exec(read('tests/order-split210-catalogue.test.mjs'));assert(fixture);
 const packed=Buffer.from(fixture[1],'base64');assert.equal(packed.length,18521);assert.equal(sha(packed),'e61ed957c0bffd6ae1383954d8368b32f4818e1704bdf51ff8c76681f3eab217');
 const raw=gunzipSync(packed,{maxOutputLength:147375});assert.equal(raw.length,147375);assert.equal(sha(raw),'6991a19381d946a967eecae698a0a40b3a2cbbe95bd1a0a15fba671a9412c3a8');
 const delta=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));assert.equal(delta.schema,'source28-h-whole-restore/v1');assert.equal(delta.additions.length,3);assert.equal(delta.changes.length,1);
 assert.equal(delta.changes[0].key,'public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)');
 const old=structuredClone(historicalSource29);for(const r of delta.additions){const index=old.additions.findIndex(a=>a.kind===r.kind&&a.key===r.key);assert(index>=0);old.additions[index]=structuredClone(r);}
 for(const r of delta.changes){const index=old.changes.findIndex(a=>a.kind===r.kind&&a.key===r.key);assert(index>=0);assert.deepEqual(old.changes[index].before,r.before);old.changes[index]=structuredClone(r);}
 const bytes=Buffer.from(JSON.stringify(old));assert.equal(bytes.length,3180698);assert.equal(bytes.length,delta.decoded_bytes);assert.equal(sha(bytes),'5011467ae5664a67f4a95ff68c8d21cea5c55ddc5bb688df3d88f6a05a5ae313');assert.equal(sha(bytes),delta.decoded_sha256);
 assert.equal(old.additions.length,493);assert.equal(old.changes.length,22);assert.equal(delta.origin.candidate_sha256,'0efeb7fab0521edd3e4130930750482722548e52c32dc553b3787c4774673766');
 return old;
})();
// Old complete records originate in restored H28. Isolated negatives overlay
// just that one historical row on today's frame; they are not historical releases.
function isolatedHistoricalRow(rows,key){const old=rows.find(r=>r.kind==='function'&&r.key===key);assert(old);return options.expectedAdditions.map(r=>r.kind===old.kind&&r.key===old.key?structuredClone(old):structuredClone(r));}

// Independently fixed Source24 CREATE witness, never derived from current closure.
function source24Additions(additions){
 const fixture=/const source24=gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:16192\}\)/.exec(read('tests/order-split210-metadata-traversal.test.mjs'));assert(fixture);
 const sql=gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:16192}).toString('utf8');
 assert.equal(Buffer.byteLength(sql),16192);assert.equal(sha(sql),'a06f8c1eaff7701be568309d312bd9ddfac375334c3557c04d5dc8cbdc623513');
 const records=structuredClone(additions),record=records.find(r=>r.kind==='function'&&r.key==='public.order_split210_try_metadata_projection(value jsonb)');assert(record);
 const tag='$closure210$',start=sql.indexOf(tag)+tag.length,end=sql.lastIndexOf(tag);assert(start>tag.length&&end>start);
 record.value.source=sql.slice(start,end);record.value.definition=formatOrderSplit210FunctionDefinition(record.key,record.value);
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 assert.equal(sha(JSON.stringify(canonical(record))),'b56d0575d53041a1ebc55288d9f963952ca190458c1cae502002c9d9bd5964cd','literal complete Source24 metadata record, including every header/ACL field');
 return records;
}
// Independently fixed full Source25 CREATE; only the metadata function changes.
function source25Additions(additions){
 const fixture=/const source25=gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:18515\}\)/.exec(read('tests/order-split210-metadata-text.test.mjs'));assert(fixture);
 const sql=gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:18515}).toString('utf8');
 assert.equal(Buffer.byteLength(sql),18515);assert.equal(sha(sql),'340a48e3fc8882323372a636d45631722e21f0bf22d5bad1f1e4617c3f58df0f');
 const records=structuredClone(additions),record=records.find(r=>r.kind==='function'&&r.key==='public.order_split210_try_metadata_projection(value jsonb)');assert(record);
 const tag='$closure210$',start=sql.indexOf(tag)+tag.length,end=sql.lastIndexOf(tag);assert(start>tag.length&&end>start);
 record.value.source=sql.slice(start,end);record.value.definition=formatOrderSplit210FunctionDefinition(record.key,record.value);
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 assert.equal(Object.keys(record.value).length,24);assert.equal(sha(JSON.stringify(canonical(record))),'95fab26e7bf1ff4081353333f5666a038213fc2e7fcf179fc3cd7e99d91df58c','literal complete Source25 metadata record, including every header/ACL field');
 return records;
}
// Independent complete Source26 CREATE retained before candidate filtering.
function source26Additions(additions){
 const fixture=/const source26=gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:18638\}\)/.exec(read('tests/order-split210-metadata-candidate-filter.test.mjs'));assert(fixture);
 const sql=gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:18638}).toString('utf8');
 assert.equal(Buffer.byteLength(sql),18638);assert.equal(sha(sql),'542aa2688ee98a42a89ac327822c619851288b4345f87744ecacbbcc69c9b9e8');
 const records=structuredClone(additions),record=records.find(r=>r.kind==='function'&&r.key==='public.order_split210_try_metadata_projection(value jsonb)');assert(record);
 const tag='$closure210$',start=sql.indexOf(tag)+tag.length,end=sql.lastIndexOf(tag);assert(start>tag.length&&end>start);
 record.value.source=sql.slice(start,end);record.value.definition=formatOrderSplit210FunctionDefinition(record.key,record.value);
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 assert.equal(Object.keys(record.value).length,24);assert.equal(sha(JSON.stringify(canonical(record))),'c3fcde131bbd83ba636c125d658ce47c20f5b8a9c7114b88fa55f021beaf21cb','literal complete Source26 metadata record, including every header/ACL field');
 return records;
}
// Independent complete Source27 valid CREATE, before same-statement snapshot sharing.
function source27Additions(additions){
 const fixture=/const source27=gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:65536\}\)/.exec(read('tests/order-split210-valid-snapshot.test.mjs'));assert(fixture);
 const sql=gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:65536}).toString('utf8');
 assert.equal(Buffer.byteLength(sql),52236);assert.equal(sha(sql),'67978756d8bf03a359d831d62f2e6a97ccecc32965260b37b326e4d051a5f78a');
 const records=structuredClone(additions),record=records.find(r=>r.kind==='function'&&r.key==='public.order_split210_valid()');assert(record);
 const tag='$closure210$',start=sql.indexOf(tag)+tag.length,end=sql.lastIndexOf(tag);assert(start>tag.length&&end>start);
 record.value.source=sql.slice(start,end);record.value.definition=formatOrderSplit210FunctionDefinition(record.key,record.value);
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 assert.equal(Object.keys(record.value).length,24);assert.equal(sha(JSON.stringify(canonical(record))),'ecb29ff6af00ee671ec0abb1a113782ddeca175669e72f494982614414139452','complete independently published Source27 valid record, including all header/ACL fields');
 return records;
}
// Actual Root V34 publication only, independent of synthetic parent DATA.
const publication={gzip:'0143a44ace2ff5eac97ccb39283e63879198c8092ef60b56b3c0561d6d14c9a9',canonical:'cbe9a4819d11454443422879b851636c51e7ae7108677b5d24a48b172a502b32',result:'d2331ae7670065ddad12e0c07fc59e9d738cd1d93556d3481ce9c6ca0225c575'};
const synthetic=(birth='2026-10-18T00:00:00+00:00',text='SYNTHETIC module test')=>{
 const parent166={singleton:true,profile:'delivery-sidecar-managed/v1',fingerprint:'a'.repeat(64),predecessor_certificates:{synthetic:text},installed_at:birth};
 return{parent166,parent209:{id:true,profile:'merge-delivery-inheritance/v1',original166:structuredClone(parent166),constraints:[{synthetic:1},{synthetic:2},{synthetic:3},{synthetic:4}],fingerprint:'b'.repeat(64)}};
};
const importCode=code=>import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
let emitted,loaded;
const actual=()=>emitted??=emit(options);
const runtime=()=>loaded??=importCode(actual().module);
const body=sql=>{const m=/\bDO (\$split210_fixed_sealx*\$)/.exec(sql);assert(m);return sql.slice(sql.indexOf(m[1])+m[1].length,sql.lastIndexOf(m[1]));};
const code=source=>orderSplit210ObserverSpans(source).map(s=>s.executable?s.text:' '.repeat(s.text.length)).join('');

test('build emits only a finite builtin-only module and pinned bounded gzip source template, with false acceptance flags',()=>{
 const result=actual();assert.equal(result.bytes,Buffer.byteLength(result.module));assert.equal(result.sha256,sha(result.module));assert(result.bytes<524288);
 assert.deepEqual([...result.module.matchAll(/^import .+ from '([^']+)';$/gm)].map(m=>m[1]),['node:assert/strict','node:crypto','node:zlib']);assert.deepEqual(result.runtime_imports,['node:assert/strict','node:crypto','node:zlib']);
 assert(!/from ['"].*(?:oracle|source204|fixed-seal|install-template|node:fs|pg|http)/.test(result.module));assert.equal(result.source_generator_shipped,false);
 assert(result.origin.gzip_bytes<=262144);assert(result.origin.decoded_bytes<=2097152);assert(result.module.includes('maxOutputLength:ORDER_SPLIT210_INSTALL_ORIGIN.decoded_bytes'));
 assert.deepEqual(result.origin.source.expected_counts,{source_additions:494,replacements:22,fingerprint_records:516,external_records:36,independent_expression_leaves:48});
 assert.equal(sourceOrigin.candidate_sha256,'685c16fbf6fdf35f1b95752e7672e6df484ec865d0fa2cf5a20da5801da3dc73');assert.equal(sourceOrigin.candidate_bytes,4525572);
 assert.equal(sourceOrigin.source_vector_gzip_sha256,publication.gzip);assert.equal(sourceOrigin.source_vector_canonical_sha256,publication.canonical);assert.equal(sourceOrigin.source_expectation_result_sha256,publication.result);
 assert.equal(sourceOrigin.source_proofs.independent_probe_receipt_sha256,'8670887ca7932ee7e39e94d1d6d2573607fa4c5d13599b62b50746c2f43a6ace');
 assert.equal(result.origin.source.candidate.sha256,sourceOrigin.candidate_sha256);assert.equal(result.origin.source.candidate.bytes,sourceOrigin.candidate_bytes);assert.equal(result.origin.source.source_vector_gzip_sha256,publication.gzip);assert.equal(result.origin.source.source_vector_canonical_sha256,publication.canonical);assert.equal(result.origin.source.source_expectation_result_sha256,publication.result);
 for(const flag of ['source_compilation_performed','native_certification','application_activation','business_acceptance']){assert.equal(result[flag],false);assert.equal(result.origin[flag],false);}
 assert(Object.isFrozen(result.origin.source)&&Object.isFrozen(result.runtime_imports));
});

test('actual imported runtime binds two different births byte-identically to the original real fixed-seal producer',async()=>{
 const m=await runtime();assert.deepEqual(Object.keys(m).sort(),['ORDER_SPLIT210_INSTALL_ORIGIN','bindOrderSplit210InstallParents'].sort());
 const one=m.bindOrderSplit210InstallParents(synthetic()),two=m.bindOrderSplit210InstallParents(synthetic('2026-10-19T05:06:07+02:00'));
 for(const [bound,parents]of [[one,synthetic()],[two,synthetic('2026-10-19T05:06:07+02:00')]]){
  const original=deriveOrderSplit210FixedSeal({...options,...parents});assert.equal(bound.sql,original.sql);assert.equal(bound.sha256,original.sha256);assert.equal(bound.bytes,original.bytes);assert.deepEqual(bound.parent_data_sha256,original.parent_data_sha256);assert.equal(bound.origin.fingerprint_input_sha256,original.fingerprint_input_sha256);
 }
 assert.notEqual(one.sha256,two.sha256);assert.equal(one.origin,two.origin);assert.equal(one.parent_capture_verified,false);assert.equal(one.seal_executed,false);assert.equal(m.ORDER_SPLIT210_INSTALL_ORIGIN.native_certification,false);
});

test('actual emitted parent serializer preserves quotes, Unicode and colliding dollar tags without executable DATA',async()=>{
 const p=synthetic('2026-10-19T00:00:00+00:00',`' \\ \n ą $split210_fixed$ $split210_fixedxx$ $split210_fixed_sealxxx$; DROP TABLE public.orders; --`),m=await runtime();
 const bound=m.bindOrderSplit210InstallParents(p),original=deriveOrderSplit210FixedSeal({...options,...p});assert.equal(bound.sql,original.sql);
 assert(!code(body(bound.sql)).includes('DROP TABLE'));assert.equal((code(body(bound.sql)).match(/INSERT INTO public\.order_split210_manifest/g)||[]).length,1);assert(/DO \$split210_fixed_sealxxxx\$/.test(bound.sql));
});

test('encoded gzip and standalone origin tampering fail at actual module import before an API can be obtained',async()=>{
 const result=actual(),match=/const encoded=Buffer.from\('([^']+)','base64'\);/.exec(result.module);assert(match);
 const gzip=Buffer.from(match[1],'base64');gzip[gzip.length-8]^=1;
 const changed=result.module.replace(match[0],()=>"const encoded=Buffer.from('"+gzip.toString('base64')+"','base64');");await assert.rejects(importCode(changed),/fixed install gzip changed/);
 const originLine=/export const ORDER_SPLIT210_INSTALL_ORIGIN=freeze\((\{[^\n]+\})\);/.exec(result.module);assert(originLine);const origin=JSON.parse(originLine[1]);origin.source.candidate.sha256='0'.repeat(64);
 const poisoned=result.module.replace(originLine[0],()=> 'export const ORDER_SPLIT210_INSTALL_ORIGIN=freeze('+JSON.stringify(origin)+');');await assert.rejects(importCode(poisoned),/fixed install origin changed/);
 assert.equal((await runtime()).ORDER_SPLIT210_INSTALL_ORIGIN.source.candidate.sha256,result.origin.source.candidate.sha256);
});

test('fixed decoded template tampering is refused even with a freshly valid gzip stream',async()=>{
 const result=actual(),encoded=/const encoded=Buffer.from\('([^']+)','base64'\);/.exec(result.module),data=JSON.parse(gunzipSync(Buffer.from(encoded[1],'base64'),{maxOutputLength:result.origin.decoded_bytes}));
 assert.equal(data.body_segments.length,3);assert.equal(data.origin.fingerprint_input_sha256,result.origin.source.fingerprint_input_sha256);
 // Published outer origin pins remain untouched; a changed template cannot be
 // adopted by re-encoding it. The generated module itself must also be pinned
 // by its future package; no self-hash can authenticate arbitrary edited code.
 const {gzipSync}=await import('node:zlib');data.body_segments[0]+='SELECT false;';const wrong=gzipSync(JSON.stringify(data),{level:9});
 const poisoned=result.module.replace(encoded[0],()=>"const encoded=Buffer.from('"+wrong.toString('base64')+"','base64');");await assert.rejects(importCode(poisoned));
});

test('unchanged emitted runtime refuses historical15/508 through Source31/515 origins even if representation hashes are recomputed',async()=>{
 const result=actual(),encoded=/const encoded=Buffer.from\('([^']+)','base64'\);/.exec(result.module),originLine=/export const ORDER_SPLIT210_INSTALL_ORIGIN=freeze\((\{[^\n]+\})\);/.exec(result.module);
 for(const [replacements,records] of [[15,508],[16,509],[20,513],[21,514],[22,515]]){
 const payload=JSON.parse(gunzipSync(Buffer.from(encoded[1],'base64'),{maxOutputLength:result.origin.decoded_bytes}));
 payload.origin.expected_counts.replacements=replacements;payload.origin.expected_counts.fingerprint_records=records;
 if(records===515){payload.origin.expected_counts.source_additions=493;payload.origin.expected_counts.independent_expression_leaves=47;}
 const {gzipSync}=await import('node:zlib'),decoded=Buffer.from(JSON.stringify(payload)),gzip=gzipSync(decoded,{level:9});
 const origin=JSON.parse(originLine[1]);origin.source=payload.origin;origin.gzip_bytes=gzip.length;origin.gzip_sha256=sha(gzip);origin.decoded_bytes=decoded.length;origin.decoded_sha256=sha(decoded);
 // This does not authenticate arbitrary edited module code: the future package
 // must pin that code. It verifies its unchanged finite494/22/516/48 runtime assertion.
 const changed=result.module.replace(encoded[0],()=>"const encoded=Buffer.from('"+gzip.toString('base64')+"','base64');")
  .replace(originLine[0],()=> 'export const ORDER_SPLIT210_INSTALL_ORIGIN=freeze('+JSON.stringify(origin)+');')
  .replace(/const ORIGIN_SHA256="[a-f0-9]{64}";/,()=> 'const ORIGIN_SHA256='+JSON.stringify(sha(JSON.stringify(origin)))+';');
 await assert.rejects(importCode(changed),error=>error.code==='ERR_ASSERTION'&&error.message.includes('fingerprint_records'));
 }
});

test('actual imported API accepts only bounded closed parent DATA and never arbitrary templates/SQL/callbacks',async()=>{
 const {bindOrderSplit210InstallParents:bind}=await runtime();
 for(const extra of ['sql','template','sourceSeal','expectedFingerprint','validate','ready'])assert.throws(()=>bind({...synthetic(),[extra]:()=>true}),/exact fields/);
 let called=false;const getter=synthetic();Object.defineProperty(getter.parent166,'installed_at',{enumerable:true,get(){called=true;return 'unsafe';}});assert.throws(()=>bind(getter),/data properties/);assert.equal(called,false);
 const bad=synthetic();bad.parent209.original166.fingerprint='c'.repeat(64);assert.throws(()=>bind(bad),/nested original166/);
 for(const value of ['\0','\ud800','x'.repeat(1048577),NaN,[,,]]){const p=synthetic();p.parent166.predecessor_certificates.bad=value;assert.throws(()=>bind(p));}
 const p=synthetic(),output=bind(p),saved=output.sql;p.parent209.constraints[0].synthetic='late mutation';assert.equal(output.sql,saved);assert(Object.isFrozen(output.parent_data_sha256));
});

test('build API authenticates actual source and rejects arbitrary module/template/seal injection',()=>{
 for(const extra of ['module','template','sourceSeal','sql','fingerprint','validate'])assert.throws(()=>emit({...options,[extra]:()=>true}),/exact fields/);
 const poisoned=structuredClone(options.expectedChanges);poisoned.at(-1).after.source+=' ';assert.throws(()=>emit({...options,expectedChanges:poisoned}),/twenty-two complete source/);
 assert.throws(()=>emit({...options,expectedChanges:options.expectedChanges.slice(0,15)}),/twenty-two complete source/,'historical15-source input cannot be emitted as current22/515');
 assert.throws(()=>emit({...options,expectedChanges:options.expectedChanges.slice(0,20)}),/twenty-two complete source/,'historical20 omits the source-authenticated credit calculator');
 assert.throws(()=>emit({...options,expectedChanges:options.expectedChanges.slice(0,21)}),/twenty-two complete source/,'historical21 omits the source-authenticated manual projection');
 const source23=structuredClone(options.expectedChanges);source23[16]=deriveOrderSplit210HistoryOperativeSuccessor({source210:options.inputs.source210}).change;assert.equal(source23.length,22);
 assert.throws(()=>emit({...options,expectedChanges:source23}),/twenty-two complete source/,'same22/515 Source23 source inputs cannot bypass the current full operative source binding');
});

test('Source32/48 leaves refuse isolated complete historical metadata records while retaining historical47-leaf witnesses',()=>{
 const key='public.order_split210_try_metadata_projection(value jsonb)',isMetadata=r=>r.kind==='function'&&r.key===key;
 for(const [version,old]of [[24,isolatedHistoricalRow(source24Additions(historicalSource28.additions),key)],[25,isolatedHistoricalRow(source25Additions(historicalSource28.additions),key)],[26,isolatedHistoricalRow(source26Additions(historicalSource28.additions),key)]]){
  assert.equal(old.length,494);assert.equal(options.expectedChanges.length,22);
  assert.deepEqual(old.filter(r=>!isMetadata(r)),options.expectedAdditions.filter(r=>!isMetadata(r)),'every other493 current source records remain exact');
  assert.notDeepEqual(old.find(isMetadata),options.expectedAdditions.find(isMetadata),'Source'+version+' witness differs only at the own complete metadata record');
  assert.throws(()=>emit({...options,expectedAdditions:old}),error=>error.code==='ERR_ASSERTION'&&error.message.includes(key+': source-derived'),'unchanged22 replacements/47 expression leaves cannot authorize Source'+version+' metadata');
 }
 const validKey='public.order_split210_valid()',oldValid=isolatedHistoricalRow(source27Additions(historicalSource28.additions),validKey),isValid=r=>r.kind==='function'&&r.key===validKey;
 assert.equal(oldValid.length,494);assert.equal(options.expectedChanges.length,22);assert.deepEqual(oldValid.filter(r=>!isValid(r)),options.expectedAdditions.filter(r=>!isValid(r)),'all493 other current source records remain exact');
 assert.notDeepEqual(oldValid.find(isValid),options.expectedAdditions.find(isValid));assert.throws(()=>emit({...options,expectedAdditions:oldValid}),error=>error.code==='ERR_ASSERTION'&&error.message.includes(validKey+': source-derived'),'same22 replacements and47 leaves cannot admit the historical Source27 full24 valid record');
});

test('same493/22/515 complete Source28 frame and each of its four stale source-bound rows are refused',()=>{
 const old=historicalSource28;assert.equal(old.additions.length,493);assert.equal(options.expectedAdditions.length,494);assert.equal(old.changes.length,options.expectedChanges.length);
 assert.throws(()=>emit({...options,expectedAdditions:old.additions,expectedChanges:old.changes}),error=>error.code==='ERR_ASSERTION','a coherent whole H28 frame is never current30 authority');
 const changedAdditions=old.additions.filter(r=>{const now=historicalSource30.additions.find(a=>a.kind===r.kind&&a.key===r.key);assert(now);return JSON.stringify(now)!==JSON.stringify(r);});assert.equal(changedAdditions.length,3);
 const changedReplacements=old.changes.filter((r,i)=>{assert.equal(r.key,options.expectedChanges[i].key);assert.deepEqual(r.before,options.expectedChanges[i].before);return JSON.stringify(r.after)!==JSON.stringify(options.expectedChanges[i].after);});assert.equal(changedReplacements.length,1);
 for(const row of changedAdditions){const additions=options.expectedAdditions.map(r=>r.kind===row.kind&&r.key===row.key?structuredClone(row):structuredClone(r));assert.throws(()=>emit({...options,expectedAdditions:additions}),error=>error.code==='ERR_ASSERTION',row.kind+':'+row.key+' must be authenticated independently');}
 const changes=structuredClone(options.expectedChanges),index=changes.findIndex(r=>r.key===changedReplacements[0].key);changes[index]=structuredClone(changedReplacements[0]);assert.throws(()=>emit({...options,expectedChanges:changes}),error=>error.code==='ERR_ASSERTION','complete old metadata AFTER cannot be accepted with current additions');
 assert.deepEqual(old.inactive_ancestors,expected.inactive_ancestors,'buyer208 ancestor is unchanged');
});


test('Source30 refuses the complete historical H29 frame and its full24 valid row while preserving the other492 and all22',()=>{
 const key='public.order_split210_valid()',isValid=r=>r.kind==='function'&&r.key===key,old=historicalSource29;
 assert.equal(old.additions.length,493);assert.equal(old.changes.length,22);assert.deepEqual(old.changes,historicalSource30.changes);assert.deepEqual(old.inactive_ancestors,expected.inactive_ancestors);
 assert.deepEqual(old.additions.filter(r=>!isValid(r)),historicalSource30.additions.filter(r=>!isValid(r)));
 const prior=old.additions.find(isValid),current=historicalSource30.additions.find(isValid),header=({source,definition,...rest})=>rest;
 assert.equal(Object.keys(prior.value).length,24);assert.equal(Object.keys(current.value).length,24);assert.deepEqual(header(prior.value),header(current.value));assert.notEqual(prior.value.source,current.value.source);assert.notEqual(prior.value.definition,current.value.definition);
 assert.throws(()=>emit({...options,expectedAdditions:old.additions,expectedChanges:old.changes}),error=>error.code==='ERR_ASSERTION','complete coherent H29 remains historical');
 const mixed=isolatedHistoricalRow(old.additions,key);assert.throws(()=>emit({...options,expectedAdditions:mixed}),error=>error.code==='ERR_ASSERTION'&&error.message.includes(key+': source-derived'),'all24 stale own-valid fields cannot bypass current source binding');
});


test('Source32 still refuses coherent H30 and each stale full source-bound addition and metadata replacement',()=>{
 const old=historicalSource30;assert.equal(old.additions.length,493);assert.equal(old.changes.length,22);assert.throws(()=>emit({...options,expectedAdditions:old.additions,expectedChanges:old.changes}));let changed=0;
 for(const row of old.additions){const now=options.expectedAdditions.find(r=>r.kind===row.kind&&r.key===row.key);assert(now);if(JSON.stringify(now)===JSON.stringify(row))continue;changed++;const additions=options.expectedAdditions.map(r=>r.kind===row.kind&&r.key===row.key?structuredClone(row):structuredClone(r));assert.throws(()=>emit({...options,expectedAdditions:additions}),row.key);}assert.equal(changed,5);
 let changedAfter=0;for(const row of old.changes){const now=options.expectedChanges.find(r=>r.key===row.key);assert.deepEqual(row.before,now.before);if(JSON.stringify(row.after)===JSON.stringify(now.after))continue;changedAfter++;const changes=options.expectedChanges.map(r=>r.key===row.key?structuredClone(row):structuredClone(r));assert.throws(()=>emit({...options,expectedChanges:changes}),row.key);}assert.equal(changedAfter,1);
});


test('Source32 full current frame preserves H31 and refuses its old valid source and nullable scalar drift',()=>{
 const current=historicalSource32;assert.equal(current.schema,'source210-order-split-exact-inverse/v7');assert.equal(current.additions.length,494);assert.equal(current.changes.length,22);
 assert.deepEqual(current.changes,historicalSource31.changes);assert.deepEqual(current.inactive_ancestors,historicalSource31.inactive_ancestors);
 const scalarKey='public.order_split210_projection_basis.payload_schema',validKey='public.order_split210_valid()',oldValid=historicalSource31.additions.find(r=>r.kind==='function'&&r.key===validKey);assert(oldValid);
 const restored=structuredClone(current);restored.schema=historicalSource31.schema;restored.additions=restored.additions.filter(r=>r.key!==scalarKey).map(r=>r.kind==='function'&&r.key===validKey?structuredClone(oldValid):r);
 assert.deepEqual(restored,historicalSource31);assert.equal(sha(JSON.stringify(restored)),'23cb94e8a1b3aa59a0c7860b2bb4bcd769383d8103eae95d33294842066e1f0b','entire historical H31 serialization retained');
 assert.throws(()=>emit({...options,expectedAdditions:historicalSource31.additions,expectedChanges:historicalSource31.changes}),'old coherent493/22/515/47 frame is not current Source32');
 for(const fields of [['source'],['definition'],['source','definition']]){
  const additions=structuredClone(options.expectedAdditions),row=additions.find(r=>r.kind==='function'&&r.key===validKey);for(const field of fields)row.value[field]=oldValid.value[field];
  assert.throws(()=>emit({...options,expectedAdditions:additions}),error=>error.code==='ERR_ASSERTION'&&error.message.includes(validKey+': source-derived'),'full Source31 valid '+fields.join('+'));
 }
 const scalar=options.expectedAdditions.find(r=>r.kind==='column'&&r.key===scalarKey);assert.equal(scalar.value.position,6);assert.equal(scalar.value.not_null,false);assert.equal(scalar.value.generated,'s');assert.equal(scalar.value.default,"((payload)::jsonb ->> 'schema'::text)");
 for(const[field,value]of [['position',5],['not_null',true],['generated',''],['default',"((payload)::jsonb ->> 'other'::text)"]]){
  const additions=structuredClone(options.expectedAdditions);additions.find(r=>r.kind==='column'&&r.key===scalarKey).value[field]=value;assert.throws(()=>emit({...options,expectedAdditions:additions}),field+' drift must not become expected source');
 }
 assert.throws(()=>emit({...options,expectedAdditions:options.expectedAdditions.filter(r=>r.key!==scalarKey)}),'new column may not be skipped');
});

test('Source33 preserves full H32 and refuses each stale valid source/definition combination',()=>{
 const key='public.order_split210_valid()',current=historicalSource33,old=historicalSource32.additions.find(r=>r.kind==='function'&&r.key===key);assert(old);
 assert.deepEqual(current.changes,historicalSource32.changes);assert.deepEqual(current.inactive_ancestors,historicalSource32.inactive_ancestors);
 const restored=structuredClone(current);restored.additions=restored.additions.map(r=>r.kind==='function'&&r.key===key?structuredClone(old):r);
 assert.equal(sha(JSON.stringify(restored)),'7c74163aebddca7cda4df9584cad55e0d2d6b977bf25cb546a5bbc4d12d5e5bf');assert.deepEqual(restored,historicalSource32);
 assert.throws(()=>emit({...options,expectedAdditions:historicalSource32.additions,expectedChanges:historicalSource32.changes}));
 for(const fields of [['source'],['definition'],['source','definition']]){const additions=structuredClone(options.expectedAdditions),row=additions.find(r=>r.kind==='function'&&r.key===key);for(const field of fields)row.value[field]=old.value[field];assert.throws(()=>emit({...options,expectedAdditions:additions}),key+' '+fields.join('+'));}
});

test('Source34 preserves full H33 and refuses each stale Source33 valid source/definition combination',()=>{
 const key='public.order_split210_valid()',current=expected,old=historicalSource33.additions.find(r=>r.kind==='function'&&r.key===key);assert(old);
 assert.deepEqual(current.changes,historicalSource33.changes);assert.deepEqual(current.inactive_ancestors,historicalSource33.inactive_ancestors);
 const restored=structuredClone(current);restored.additions=restored.additions.map(r=>r.kind==='function'&&r.key===key?structuredClone(old):r);
 assert.equal(sha(JSON.stringify(restored)),'9e23c99c53bdc7d0dd58abac262b3b6971823d7dbafe8be8b82c878145d7f0d6');assert.deepEqual(restored,historicalSource33);
 assert.throws(()=>emit({...options,expectedAdditions:historicalSource33.additions,expectedChanges:historicalSource33.changes}),'complete previous33 H is refused');
 for(const fields of [['source'],['definition'],['source','definition']]){const additions=structuredClone(options.expectedAdditions),row=additions.find(r=>r.kind==='function'&&r.key===key);for(const field of fields)row.value[field]=old.value[field];assert.throws(()=>emit({...options,expectedAdditions:additions}),key+' previous33 '+fields.join('+'));}
});
