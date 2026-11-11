/** Portable historical Source32/Source33 and current Source34 H witnesses. Source expectations only; no SQL or Native evidence. */
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ORDER_SPLIT210_SOURCE_CONTRACT as currentContract,ORDER_SPLIT210_SOURCE_ORIGIN as currentOrigin} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-split210-source-contract.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const clone=v=>structuredClone(v);
const historicalText=readFileSync(new URL('./order-split210-catalogue.test.mjs',import.meta.url),'utf8');
const origin=JSON.parse(historicalText.match(/const historicalSource32Origin=(.*);/)[1]);
const packed=Buffer.from(historicalText.match(/const historicalSource32Encoded=Buffer\.from\('([^']+)','base64'\);/)[1],'base64');assert.equal(sha(packed),origin.gzip_sha256);assert.equal(packed.length,origin.gzip_bytes);
const oldRaw=gunzipSync(packed,{maxOutputLength:origin.decoded_bytes});assert.equal(sha(oldRaw),origin.decoded_sha256);assert.equal(oldRaw.length,origin.decoded_bytes);
const deepFreeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))deepFreeze(x);Object.freeze(v);}return v;};
const contract=deepFreeze(JSON.parse(oldRaw));deepFreeze(origin);
// Complete historical H33 (V33 publication) retained as bounded DATA before the Source34 promotion.
const nextOrigin=deepFreeze(JSON.parse(historicalText.match(/const historicalSource33Origin=(.*);/)[1]));
const packed33=Buffer.from(historicalText.match(/const historicalSource33Encoded=Buffer\.from\('([^']+)','base64'\);/)[1],'base64');assert.equal(sha(packed33),nextOrigin.gzip_sha256);assert.equal(packed33.length,nextOrigin.gzip_bytes);
const raw33=gunzipSync(packed33,{maxOutputLength:nextOrigin.decoded_bytes});assert.equal(sha(raw33),nextOrigin.decoded_sha256);assert.equal(raw33.length,nextOrigin.decoded_bytes);
const nextContract=deepFreeze(JSON.parse(raw33));
const validKey='public.order_split210_valid()',columnKey='public.order_split210_projection_basis.payload_schema';
const priorPredicate=" AND payload_jsonb->>'schema'='order-split210-projection-basis/definition-codec-v1'";
const currentPredicate=" AND payload_schema='order-split210-projection-basis/definition-codec-v1'";
function once(source,before,after){const at=source.indexOf(before);assert(at>=0&&source.indexOf(before,at+1)<0);return source.slice(0,at)+after+source.slice(at+before.length);}
function reconstructSource31(value){const prior=clone(value);assert.equal(prior.schema,'source210-order-split-exact-inverse/v7');prior.schema='source210-order-split-exact-inverse/v6';assert.equal(prior.additions.filter(r=>r.kind==='column'&&r.key===columnKey).length,1);prior.additions=prior.additions.filter(r=>!(r.kind==='column'&&r.key===columnKey));const valid=prior.additions.find(r=>r.kind==='function'&&r.key===validKey);assert(valid);for(const field of ['source','definition'])valid.value[field]=once(valid.value[field],currentPredicate,priorPredicate);return prior;}
const prior= reconstructSource31(contract);

test('V32 H pins actual source-only publication, with all acceptance flags false',()=>{
 assert.equal(contract.schema,'source210-order-split-exact-inverse/v7');assert.equal(origin.schema,'order-split210-source-origin/v7');
 assert.equal(origin.candidate_bytes,4524613);assert.equal(origin.candidate_sha256,'a737148ee97845de656b38d5a92dea341c6040c2ae8b39557d2e248c26c6fc8b');
 assert.equal(origin.source_vector_gzip_sha256,'770000ca79bbab659efa37b754d990395024ee85e80359f0afefaec933316392');
 assert.equal(origin.source_vector_canonical_sha256,'ffd25373cad501603ea8bd08521a75a8c50d4693dc27bac305eea8902f27dc7e');
 assert.equal(origin.source_expectation_result_sha256,'949e51117690bbecf36793f2d2b97f03fe05550c6a78e7e1a0959f6e65e70b67');
 assert.equal(origin.status,'SOURCE_EXPECTATION_PREPARED_NOT_COMPILED');for(const field of ['source_compiled','full_source_inverse_proven','sealed','native_acceptance','application_activation','business_acceptance'])assert.equal(origin[field],false,field);
 assert.equal(origin.decoded_bytes,3271844);assert.equal(origin.decoded_sha256,'7c74163aebddca7cda4df9584cad55e0d2d6b977bf25cb546a5bbc4d12d5e5bf');
 assert.equal(sha(JSON.stringify(contract)),origin.decoded_sha256);
});
test('entire prior H31 byte serialization survives only new-column and accessor inverse',()=>{
 const raw=JSON.stringify(prior);assert.equal(Buffer.byteLength(raw),3271512);assert.equal(sha(raw),'23cb94e8a1b3aa59a0c7860b2bb4bcd769383d8103eae95d33294842066e1f0b');
 assert.equal(prior.additions.length,493);assert.equal(prior.changes.length,22);assert.deepEqual(prior.removed,[]);assert.equal(prior.inactive_ancestors.length,1);
 assert.deepEqual(contract.changes,prior.changes,'every full22 BEFORE/AFTER remains literal');
 const before=new Map(prior.additions.map(r=>[r.kind+'\0'+r.key,r]));let unchanged=0;
 for(const row of contract.additions){if(row.key===columnKey)continue;const old=before.get(row.kind+'\0'+row.key);assert(old);if(row.kind==='function'&&row.key===validKey){const fields=v=>Object.fromEntries(Object.entries(v).filter(([key])=>!['source','definition'].includes(key)));assert.deepEqual(fields(row.value),fields(old.value));assert.equal(Object.keys(row.value).length,24);}else{assert.deepEqual(row,old);unchanged++;}}
 assert.equal(unchanged,492);
});
test('all eight descriptor kinds and append-only nullable generated ordinal6 are fixed',()=>{
 assert.equal(contract.additions.length,494);assert.equal(new Set(contract.additions.map(r=>r.kind+'\0'+r.key)).size,494);
 const counts=Object.fromEntries(['relation','column','constraint','index','policy','trigger','function','type'].map(kind=>[kind,contract.additions.filter(r=>r.kind===kind).length]));
 assert.deepEqual(counts,{relation:24,column:132,constraint:168,index:16,policy:8,trigger:103,function:27,type:16});
 const column=contract.additions.find(r=>r.kind==='column'&&r.key===columnKey);assert.deepEqual(column.value,{position:6,type:'text',not_null:false,generated:'s',identity:'',storage:'x',compression:'',statistics:null,options:null,foreign_options:null,collation:'"default"',acl_null:true,acl:[],default:"((payload)::jsonb ->> 'schema'::text)"});
 const current=contract.additions.find(r=>r.key===validKey),old=prior.additions.find(r=>r.key===validKey);
 assert.equal(Buffer.byteLength('CREATE FUNCTION '+validKey+' RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $closure210$'+current.value.source+'$closure210$;\n'),53130);
 assert.equal(current.value.source.slice(current.value.source.indexOf(' WITH live_changed AS MATERIALIZED(')),old.value.source.slice(old.value.source.indexOf(' WITH live_changed AS MATERIALIZED(')),'whole catalogue capture, checks and SPI tail unchanged');
});
test('new independent P24 all48 leaves and source99 provenance are distinct from compilation',()=>{
 const p=origin.source_proofs;assert.equal(p.parent_source_vector_sha256,'58d86a31b14b4ff236d131331fc0370df1ac270d8f6fe186c30e9120de6ecb5e');
 assert.equal(p.source_pin_list_sha256,'e8fa3f2c061f4476d0eb136e9f3aa1f4d0be7db84b5231d84127ceecca936e9e');assert.equal(p.oracle_sha256,'debfecae01d8d1ba28edfa48941b06303f09add7f18c8d9c9b9fb3829e445949');
 assert.equal(p.independent_probe_receipt_sha256,'8670887ca7932ee7e39e94d1d6d2573607fa4c5d13599b62b50746c2f43a6ace');assert.equal(p.independent_leaves_sha256,'aa361e192fb32f9826c32281c5ec9afd9bf33cead66727aa3f603a11055cf3c3');
 assert.equal(p.p24_actual_expression_basis.actual_leaves,48);assert.equal(p.p24_actual_expression_basis.all47_historical_leaf_values_unchanged,true);assert.equal(p.p24_actual_expression_basis.p23_reused,false);assert.equal(p.p24_actual_expression_basis.pg_calls,0,'builder makes no PostgreSQL call');
 assert.equal(p.whole_program_inverse.whole_program_inverse_verified,true);assert.deepEqual(p.whole_program_inverse.parent,{bytes:4524547,sha256:'3e99139ded0b97012846f5d1bb023e60bb289b307a0647d3302419c3f60414ab'});assert.equal(p.whole_program_inverse.physical_DATA_unchanged,true);assert.equal(p.runtime_provenance_maps.length,3);assert.equal(p.runtime_equivalence_claimed,false);
});
test('complete historical witness detects unrelated old descriptor drift',()=>{
 for(const kind of ['relation','column','constraint','index','policy','trigger','function','type']){const bad=clone(contract),row=bad.additions.find(r=>r.kind===kind&&r.key!==columnKey&&r.key!==validKey);assert(row);row.value.unexpected='tampered';assert.notEqual(sha(JSON.stringify(reconstructSource31(bad))),'23cb94e8a1b3aa59a0c7860b2bb4bcd769383d8103eae95d33294842066e1f0b');}
});
test('published static contract and nested origin are immutable',()=>{
 const stack=[contract,origin];let objects=0;while(stack.length){const v=stack.pop();if(v&&typeof v==='object'){assert(Object.isFrozen(v));objects++;for(const child of Object.values(v))if(child&&typeof child==='object')stack.push(child);}}assert(objects>1000);
 assert.throws(()=>{contract.additions[0].value.changed=true;},TypeError);assert.throws(()=>{origin.source_compiled=true;},TypeError);
});

test('V33 source-only origin binds actual publication and measured static H bytes',()=>{
 assert.equal(nextOrigin.candidate_bytes,4525227);assert.equal(nextOrigin.candidate_sha256,'23cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d');
 assert.equal(nextOrigin.source_vector_gzip_sha256,'35d9eb87e6dd69562949312b93cc7a4b0400ac7f63d65b1e08979cc0a8950de1');assert.equal(nextOrigin.source_vector_canonical_sha256,'a46053d1f8a62dd0eaba255c617817475ac2d371df0fd473dd2e7475369a1d4a');assert.equal(nextOrigin.source_expectation_result_sha256,'55972fe5d5c97757e145c3523f00b76ceefb2cd4275f71cd6b7a0c6e73caa072');
 const raw=JSON.stringify(nextContract);assert.equal(Buffer.byteLength(raw),3273120);assert.equal(sha(raw),'9e23c99c53bdc7d0dd58abac262b3b6971823d7dbafe8be8b82c878145d7f0d6');assert.equal(nextOrigin.decoded_sha256,sha(raw));assert.equal(nextOrigin.gzip_bytes,350082);assert.equal(nextOrigin.gzip_sha256,'d7d2908b214c0fd87bcfbfd77346941af8dfaf40b57b17d68a9c7ad71b234536');
 for(const field of ['source_compiled','full_source_inverse_proven','sealed','native_acceptance','application_activation','business_acceptance'])assert.equal(nextOrigin[field],false,field);
});
test('V33 changes only valid source and definition and recovers entire H32 serialization',()=>{
 assert.equal(nextContract.schema,contract.schema);assert.equal(nextContract.additions.length,494);assert.deepEqual(nextContract.changes,contract.changes);assert.deepEqual(nextContract.removed,contract.removed);assert.deepEqual(nextContract.inactive_ancestors,contract.inactive_ancestors);
 const restored=clone(nextContract),old=contract.additions.find(r=>r.kind==='function'&&r.key===validKey);let untouched=0;
 for(const row of restored.additions){const before=contract.additions.find(r=>r.kind===row.kind&&r.key===row.key);assert(before);if(row.key!==validKey){assert.deepEqual(row,before);untouched++;continue;}assert.equal(Object.keys(row.value).length,24);for(const field of Object.keys(row.value)){if(['source','definition'].includes(field)){assert.notEqual(row.value[field],before.value[field]);row.value[field]=before.value[field];}else assert.deepEqual(row.value[field],before.value[field]);}}
 assert.equal(untouched,493);assert.deepEqual(restored,contract);assert.equal(sha(JSON.stringify(restored)),origin.decoded_sha256);
 const edits=nextOrigin.source_proofs.whole_program_inverse.edits;assert.equal(edits.length,6);for(const field of ['source','definition']){let value=nextContract.additions.find(r=>r.key===validKey).value[field];for(const edit of [...edits].reverse())value=once(value,edit.after,edit.before);assert.equal(value,old.value[field],'full valid '+field+' inverse');}
});
test('V33 explicitly reuses complete unchanged P24 expressions without claiming a new probe',()=>{
 const p=nextOrigin.source_proofs,reuse=p.p24_expression_source_reuse;assert.equal(p.parent_source_vector_sha256,origin.source_vector_gzip_sha256);assert.equal(p.parent_source_vector_canonical_sha256,origin.source_vector_canonical_sha256);assert.equal(p.source_vector_root_review_sha256,'13ef836aedfb66f22470204e4ae5ffd9c64a174cf09705c0ec37402cf30c04fc');
 assert.deepEqual(p.p24_actual_expression_basis,origin.source_proofs.p24_actual_expression_basis);assert.equal(p.p24_actual_expression_basis.actual_leaves,48);assert.equal(reuse.original_probe_id,'P24_SOURCE32');assert.equal(reuse.new_probe_performed,false);assert.equal(reuse.PG_calls,0);for(const field of ['all48_targets_equal','all8_original_and_stripped_DDL_equal','projection_basis_equal','only_probe_source_candidate_changed'])assert.equal(reuse[field],true);assert.equal(p.runtime_equivalence_claimed,false);
 assert.equal(p.whole_program_inverse.parent.sha256,origin.candidate_sha256);assert.equal(p.whole_program_inverse.whole_program_inverse_verified,true);assert.equal(p.whole_program_inverse.only_valid_source_changed,true);
 const stack=[nextContract,nextOrigin];while(stack.length){const value=stack.pop();if(value&&typeof value==='object'){assert(Object.isFrozen(value));stack.push(...Object.values(value).filter(v=>v&&typeof v==='object'));}}
});

test('V34 source-only origin binds actual publication and measured static H bytes',()=>{
 assert.equal(currentOrigin.candidate_bytes,4525572);assert.equal(currentOrigin.candidate_sha256,'685c16fbf6fdf35f1b95752e7672e6df484ec865d0fa2cf5a20da5801da3dc73');
 assert.equal(currentOrigin.source_vector_gzip_sha256,'0143a44ace2ff5eac97ccb39283e63879198c8092ef60b56b3c0561d6d14c9a9');assert.equal(currentOrigin.source_vector_canonical_sha256,'cbe9a4819d11454443422879b851636c51e7ae7108677b5d24a48b172a502b32');assert.equal(currentOrigin.source_expectation_result_sha256,'d2331ae7670065ddad12e0c07fc59e9d738cd1d93556d3481ce9c6ca0225c575');
 const raw=JSON.stringify(currentContract);assert.equal(Buffer.byteLength(raw),3273810);assert.equal(sha(raw),'06fb4f7711a29622a1395ead240ca3d676b812f0103d92febbbd9433688fed91');assert.equal(currentOrigin.decoded_sha256,sha(raw));assert.equal(currentOrigin.gzip_bytes,350173);assert.equal(currentOrigin.gzip_sha256,'c42927324b17458a4697244403f979764f7b91e7760d9a748b47efad1056d78c');
 for(const field of ['source_compiled','full_source_inverse_proven','sealed','native_acceptance','application_activation','business_acceptance'])assert.equal(currentOrigin[field],false,field);
 assert(!JSON.stringify(currentOrigin).includes('/Users/'),'portable origin carries no private path');
});
test('V34 changes only valid source and definition and recovers entire H33 serialization',()=>{
 assert.equal(currentContract.schema,nextContract.schema);assert.equal(currentContract.additions.length,494);assert.deepEqual(currentContract.changes,nextContract.changes);assert.deepEqual(currentContract.removed,nextContract.removed);assert.deepEqual(currentContract.inactive_ancestors,nextContract.inactive_ancestors);
 const restored=clone(currentContract),old=nextContract.additions.find(r=>r.kind==='function'&&r.key===validKey);let untouched=0;
 for(const row of restored.additions){const before=nextContract.additions.find(r=>r.kind===row.kind&&r.key===row.key);assert(before);if(row.key!==validKey){assert.deepEqual(row,before);untouched++;continue;}assert.equal(Object.keys(row.value).length,24);for(const field of Object.keys(row.value)){if(['source','definition'].includes(field)){assert.notEqual(row.value[field],before.value[field]);row.value[field]=before.value[field];}else assert.deepEqual(row.value[field],before.value[field]);}}
 assert.equal(untouched,493);assert.deepEqual(restored,nextContract);assert.equal(sha(JSON.stringify(restored)),nextOrigin.decoded_sha256);
 const edits=currentOrigin.source_proofs.whole_program_inverse.edits;assert.equal(edits.length,2);for(const field of ['source','definition']){let value=currentContract.additions.find(r=>r.key===validKey).value[field];for(const edit of [...edits].reverse())value=once(value,edit.after,edit.before);assert.equal(value,old.value[field],'full valid '+field+' inverse');}
});
test('V34 again reuses complete unchanged P24 expressions without claiming a new probe',()=>{
 const p=currentOrigin.source_proofs,reuse=p.p24_expression_source_reuse;assert.equal(p.parent_source_vector_sha256,nextOrigin.source_vector_gzip_sha256);assert.equal(p.parent_source_vector_canonical_sha256,nextOrigin.source_vector_canonical_sha256);assert.equal(p.source_vector_root_review_sha256,'f5b000f4cef1677b2bad377f679b3eb0ff3b4609138cc5624f6c77c5e88ac1d2');
 assert.deepEqual(p.p24_actual_expression_basis,nextOrigin.source_proofs.p24_actual_expression_basis);assert.equal(reuse.status,'SOURCE34_WHOLE_P24_PROBE_REUSE_EQUALITY_ONLY');assert.equal(reuse.original_probe_id,'P24_SOURCE32');assert.equal(reuse.new_probe_performed,false);assert.equal(reuse.PG_calls,0);
 for(const field of Object.keys(nextOrigin.source_proofs.p24_expression_source_reuse))if(field!=='status')assert.deepEqual(reuse[field],nextOrigin.source_proofs.p24_expression_source_reuse[field],field);
 assert.deepEqual(p.whole_program_inverse.parent,{bytes:nextOrigin.candidate_bytes,sha256:nextOrigin.candidate_sha256});assert.equal(p.whole_program_inverse.whole_program_inverse_verified,true);assert.equal(p.whole_program_inverse.only_valid_source_changed,true);assert.equal(p.runtime_equivalence_claimed,false);
 assert.deepEqual(p.source_parent_delta.changed_existing_additions,[{kind:'function',key:validKey,fields:['source','definition']}]);assert.equal(p.source_parent_delta.unchanged_existing_additions,493);
 const stack=[currentContract,currentOrigin];while(stack.length){const value=stack.pop();if(value&&typeof value==='object'){assert(Object.isFrozen(value));stack.push(...Object.values(value).filter(v=>v&&typeof v==='object'));}}
});
