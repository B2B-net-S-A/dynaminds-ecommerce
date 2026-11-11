/** Source-only candidate checks. No SQL parser, PG, seal or Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210Closure,orderSplit210TaggedDescriptor,projectOrderSplit210ChangedFunctions} from '../tools/parity/order-split210-closure.mjs';
import {orderSplit210ObserverSpans} from '../tools/parity/order-split210-predecessor.mjs';
import {deriveOrderSplit210Layer} from '../tools/parity/order-split210-layer.mjs';
import {deriveOrderSplit210ManualProjectionSuccessor} from '../tools/parity/order-split210-manual-projection-successor.mjs';
import {deriveOrderSplit210HistoryOperativeSuccessor} from '../tools/parity/order-split210-history-operative-successor.mjs';
import {deriveOrderSplit210HistoryFinancialSharing} from '../tools/parity/order-split210-history-financial-sharing.mjs';
import {deriveOrderSplit210MetadataTraversal} from '../tools/parity/order-split210-metadata-traversal.mjs';
import {deriveOrderSplit210MetadataText} from '../tools/parity/order-split210-metadata-text.mjs';
import {deriveOrderSplit210MetadataCandidateFilter} from '../tools/parity/order-split210-metadata-candidate-filter.mjs';
import {deriveOrderSplit210ValidSnapshot} from '../tools/parity/order-split210-valid-snapshot.mjs';
import {deriveOrderSplit210MetadataComposite} from '../tools/parity/order-split210-metadata-composite.mjs';
import {deriveOrderSplit210MetadataFreshMap} from '../tools/parity/order-split210-metadata-fresh-map.mjs';
import {decodeOrderSplit210DefinitionData} from '../tools/parity/order-split210-definition-codec.mjs';
import {deriveOrderSplit210ValidSnapshot31} from '../tools/parity/order-split210-valid-snapshot31.mjs';

import {deriveOrderSplit210FinancialMetadataShapes,projectOrderSplit210FinancialMetadataShape} from '../tools/parity/order-split210-metadata-shapes.mjs';
import {deriveOrderSplit210BuyerMetadataShapes,projectOrderSplit210BuyerMetadataShape} from '../tools/parity/order-split210-buyer-metadata-shapes.mjs';
import {deriveOrderSplit210OrdinaryMetadataShapes,projectOrderSplit210OrdinaryMetadataShape} from '../tools/parity/order-split210-ordinary-metadata-shapes.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
// Reuse the existing SMALL, pinned literal routine fixture; do not import its
// tests or read/inflate a full catalogue/generated27MB program in this test.
const layerTest=read('tests/order-split210-layer.test.mjs');
const fixture=/gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:131072\}\)/.exec(layerTest);
assert(fixture,'existing selected accepted22b fixture');
const sourceBundle=JSON.parse(gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:131072}).toString('utf8'));
const paths={source104:'104_order_merge_custody.sql',source108:'108_b2b_dropshipping.sql',source160:'160_b2b_credit.sql',source169:'169_manual_inventory_off.sql',source204:'204_partial_commercial_sale_scope.sql'};
const businessInputs=Object.fromEntries(Object.entries(paths).map(([k,v])=>[k,read('server/'+v)]));
const inputs={businessInputs,sourceBundle,source158:read('server/158_fa3_draft_native.sql'),source159:read('server/159_b2b_invoice.sql'),source210:read('tools/parity/order-split210-business.sql'),sourceSchema:read('server/schema.sql')};
const metadataFixture=/const source24=gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:16192\}\)/.exec(read('tests/order-split210-metadata-traversal.test.mjs'));assert(metadataFixture);
const metadataSource24=gunzipSync(Buffer.from(metadataFixture[1],'base64'),{maxOutputLength:16192}).toString('utf8'),metadataTraversal=deriveOrderSplit210MetadataTraversal(metadataSource24);
const metadataText=deriveOrderSplit210MetadataText(metadataTraversal.sql);
const metadataCandidateFilter=deriveOrderSplit210MetadataCandidateFilter(metadataText.sql);
const validFixture=/const source27=gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:65536\}\)/.exec(read('tests/order-split210-valid-snapshot.test.mjs'));assert(validFixture);
const validSource27=gunzipSync(Buffer.from(validFixture[1],'base64'),{maxOutputLength:65536}).toString('utf8'),validSnapshot28=deriveOrderSplit210ValidSnapshot(validSource27);
const valid29Fixture=/const source29=gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:65536\}\)/.exec(read('tests/order-split210-valid-snapshot.test.mjs'));assert(valid29Fixture);
const validSource29=gunzipSync(Buffer.from(valid29Fixture[1],'base64'),{maxOutputLength:65536}).toString('utf8'),validSnapshot=deriveOrderSplit210ValidSnapshot(validSource29);
const freshFixture=/const before=JSON\.parse\(gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:32768\}\)/.exec(read('tests/order-split210-metadata-fresh-map.test.mjs'));assert(freshFixture);
const source28Metadata=JSON.parse(gunzipSync(Buffer.from(freshFixture[1],'base64'),{maxOutputLength:32768})),metadataKey='public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)';
const historicalChanges=changes=>changes.map(c=>c.key===metadataKey?{...c,after:copy(source28Metadata)}:copy(c));
const source34Closure=deriveOrderSplit210Closure(inputs),copy=v=>structuredClone(v),sha=s=>createHash('sha256').update(s).digest('hex');
const source33Closure=restoreSource33Closure(source34Closure);
const source32Closure=restoreSource32Closure(source33Closure);
const current=()=>result.changes.map(c=>({kind:'function',key:c.key,value:copy(c.after)}));
function body(name){const marker='CREATE FUNCTION public.order_split210_'+name+'(';const start=result.sql.indexOf(marker);assert(start>=0);const a=result.sql.indexOf('$closure210$',start),b=result.sql.indexOf('$closure210$',a+12);assert(b>a);return result.sql.slice(a+12,b);}


const canonical31=v=>Array.isArray(v)?v.map(canonical31):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical31(v[k])])):v;
const serialize31=v=>JSON.stringify(canonical31(v)),quote31=s=>"'"+s.replaceAll("'","''")+"'";
const fixture31=/Buffer\.from\('([^']+)','base64'\)/.exec(read('tests/order-split210-valid-snapshot31.test.mjs'));assert(fixture31);
const raw31=JSON.parse(gunzipSync(Buffer.from(fixture31[1],'base64'),{maxOutputLength:131072})).raw31,valid31=deriveOrderSplit210ValidSnapshot31(raw31);
const fresh31=deriveOrderSplit210MetadataFreshMap(source28Metadata.source);
function replace31Once(sql,before,after){assert.equal(sql.split(before).length,2,'one complete Source31 inverse site');return sql.replace(before,()=>after);}
function undo31(sql,edits){for(const e of [...edits].reverse()){assert.equal(sql.slice(e.afterStart,e.afterStart+e.after.length),e.after);sql=sql.slice(0,e.afterStart)+e.before+sql.slice(e.afterStart+e.after.length);}return sql;}
function restoreSource33Closure(source34){
 const restored=copy(source34),candidate=source34.constraint_candidates;
 assert(candidate.whole_source_inverse_verified&&candidate.whole_capture_inverse_verified&&candidate.edits.length===2);
 const previous=undo31(candidate.sql,candidate.edits);assert.equal(Buffer.byteLength(previous),53744);assert.equal(sha(previous),'73e000ed23e1714056ba808181d93f3e76437c553a03ef967b7a4792f61a7f2c');
 restored.sql=replace31Once(restored.sql,candidate.sql,previous);delete restored.constraint_candidates;delete restored.source_inputs.constraintCandidates210;
 return restored;
}
function restoreSource32Closure(source33){
 const restored=copy(source33),prefix=source33.prefix_name_ranges;
 assert(prefix.whole_source_inverse_verified&&prefix.whole_capture_inverse_verified&&prefix.edits.length===6);
 const previous=undo31(prefix.sql,prefix.edits);assert.equal(Buffer.byteLength(previous),53130);assert.equal(sha(previous),'19558e1f578684cf667275c1f0afa81f458e4f5e4db118a1c56f522bfe0c6c29');
 restored.sql=replace31Once(restored.sql,prefix.sql,previous);delete restored.prefix_name_ranges;delete restored.source_inputs.prefixNameRanges210;
 return restored;
}
function restoreSource31Closure(source32){
 const restored=copy(source32),frame=source32.frame_schema_column;
 assert(frame&&frame.whole_table_inverse_verified&&frame.whole_valid_inverse_verified);
 const table=undo31(frame.projectionBasisSql,frame.edits.filter(e=>e.target==='projectionBasisSql'));
 const valid=undo31(frame.validSql,frame.edits.filter(e=>e.target==='validSql'));
 assert.equal(Buffer.byteLength(table),627);assert.equal(sha(table),'e1b1c0cbd44ffe0a69597b8129901ad171fcc2487adb3db962ff32496443c42f');
 assert.equal(Buffer.byteLength(valid),53140);assert.equal(sha(valid),'2b8023561f6456783d30a4d19a1211736f80b936f81c6fbb6388f5f5786154a5');
 restored.preambleSql=replace31Once(restored.preambleSql,frame.projectionBasisSql,table);
 restored.sql=replace31Once(restored.sql,frame.validSql,valid);
 delete restored.source_inputs.frameSchemaColumn210;delete restored.frame_schema_column;
 const freeze31=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze31(child);Object.freeze(value);}return value;};return freeze31(restored);
}
function restoreSource30Closure(currentClosure){
 const restored=copy(currentClosure),logical=copy(decodeOrderSplit210DefinitionData(currentClosure.data));assert.deepEqual(logical,currentClosure.logical_data);
 const currentMetadata=currentClosure.changes.find(c=>c.key===metadataKey),snapshot=currentClosure.changes.find(c=>c.key==='public.order_merge_delivery209_validation_snapshot()');
 const composite=deriveOrderSplit210MetadataComposite(fresh31.source,snapshot.after.source);assert.equal(currentMetadata.after.source,composite.source);assert.equal(currentMetadata.after.definition,composite.definition);
 assert.equal(undo31(currentMetadata.after.source,composite.edits),fresh31.source);
 const oldAfter={...copy(currentMetadata.after),source:fresh31.source,definition:fresh31.definition};
 restored.changes.find(c=>c.key===metadataKey).after=copy(oldAfter);const dataMetadata=logical.changes.find(c=>c.key===metadataKey);dataMetadata.after=copy(oldAfter);dataMetadata.after_check=orderSplit210TaggedDescriptor(oldAfter);
 const payload=serialize31(logical);assert.equal(Buffer.byteLength(payload),4192445);assert.equal(sha(payload),'fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45');
 restored.data=logical;restored.projection_basis={bytes:4192445,sha256:sha(payload)};
 const mapped30=undo31(valid31.sql,valid31.source30_mapped_inverse.edits);assert.equal(mapped30,validSnapshot.sql);
 restored.sql=replace31Once(currentClosure.sql,valid31.sql,mapped30);
 const ports=currentClosure.definition_codec_ports;assert.equal(ports.sites,6);const oldFunction=undo31(ports.functionSql,ports.targets[0].edits),oldMetadata=undo31(ports.metadataSql,ports.targets[1].edits);assert.equal(oldMetadata,metadataCandidateFilter.sql);
 restored.sql=replace31Once(restored.sql,ports.functionSql,oldFunction);restored.sql=replace31Once(restored.sql,ports.metadataSql,oldMetadata);
 assert.equal(Buffer.byteLength(restored.sql),97283);assert.equal(sha(restored.sql),'e66169d62242d0fbab77362c941faf50f9c50cfc8cbd17460df5d609270dcb75');
 restored.preambleSql=replace31Once(currentClosure.preambleSql,quote31(serialize31(currentClosure.data)),quote31(payload));
 restored.preambleSql=replace31Once(restored.preambleSql,'CHECK(octet_length(payload)=3590688)','CHECK(octet_length(payload)=4192445)');
 restored.preambleSql=replace31Once(restored.preambleSql,"CHECK(payload_sha256='db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3')","CHECK(payload_sha256='fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45')");
 for(const key of ['metadataComposite209','definitionCodec210','definitionCodecPorts210'])delete restored.source_inputs[key];restored.source_inputs.validSnapshot210=validSnapshot.source_proofs;
 delete restored.logical_data;delete restored.definition_codec;delete restored.definition_codec_ports;
 const freezeHistorical=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeHistorical(child);Object.freeze(value);}return value;};return freezeHistorical(restored);
}

const source31Closure=restoreSource31Closure(source32Closure);
const result=restoreSource30Closure(source31Closure);
test('Source34 production closure selects constraints through two OID branches without changing any guard or predecessor',()=>{
 const candidate=source34Closure.constraint_candidates;
 assert.equal(candidate.bytes,54089);assert.equal(candidate.sha256,'55bd1c1d73803c8ee186e0d0f423a09d52082b89140d6cac449e1dc0ddc32ef0');
 assert.equal(candidate.query.bytes,19156);assert.equal(candidate.query.sha256,'63f24d0e44d09f2a5123324ef6de148b557deab55d2e8083f7b7ac133ec714e0');
 assert.equal(Buffer.byteLength(source34Closure.sql)-Buffer.byteLength(source33Closure.sql),345);
 assert.equal(source34Closure.sql.split(candidate.sql).length,2,'the actual emitted closure uses the complete new function');
 assert.equal(undo31(candidate.sql,candidate.edits),source33Closure.prefix_name_ranges.sql);
 for(const key of Object.keys(source33Closure).filter(k=>!['sql','source_inputs'].includes(k)))assert.deepEqual(source34Closure[key],source33Closure[key],key);
 const inputs=copy(source34Closure.source_inputs);delete inputs.constraintCandidates210;assert.deepEqual(inputs,source33Closure.source_inputs);
 assert.deepEqual(source34Closure.source_inputs.constraintCandidates210,candidate.source_proofs);
 assert.deepEqual(source34Closure.changes,source33Closure.changes);assert.equal(source34Closure.changes.length,22);
 assert.equal((source34Closure.sql.match(/PERFORM public\.order_split210_require\(\)/g)||[]).length,(source33Closure.sql.match(/PERFORM public\.order_split210_require\(\)/g)||[]).length);
 assert.equal(candidate.invariants.deduplication,'catalogue_oid_only');assert.equal(candidate.invariants.domain_constraints_included,true);assert.equal(candidate.invariants.own_relation_namespace_unrestricted,true);
 for(const key of ['sql_executed','source_compilation_performed','native_certification','application_activation','business_acceptance','performance_acceptance','cross_invocation_cache'])assert.equal(candidate[key],false,key);
});

test('Source33 changes only six measured capture atoms and preserves the entire Source32 closure and22changes',()=>{
 const ranges=source33Closure.prefix_name_ranges;
 assert.equal(ranges.bytes,53744);assert.equal(ranges.sha256,'73e000ed23e1714056ba808181d93f3e76437c553a03ef967b7a4792f61a7f2c');
 assert.equal(ranges.query.bytes,18811);assert.equal(ranges.query.sha256,'7a5547d3cebe9d9071180ccf97a06318ccdc1dc48a2800e4c5a6c2f923f38955');
 assert.equal(Buffer.byteLength(source33Closure.sql)-Buffer.byteLength(source32Closure.sql),614);
 assert.equal(undo31(ranges.sql,ranges.edits),source32Closure.frame_schema_column.validSql);
 for(const key of Object.keys(source32Closure).filter(k=>!['sql','source_inputs'].includes(k)))assert.deepEqual(source33Closure[key],source32Closure[key],key);
 const inputs=copy(source33Closure.source_inputs);delete inputs.prefixNameRanges210;assert.deepEqual(inputs,source32Closure.source_inputs);
 assert.deepEqual(source33Closure.changes,source32Closure.changes);assert.equal(source33Closure.changes.length,22);
 assert.deepEqual(source33Closure.source_inputs.prefixNameRanges210,ranges.source_proofs);
 for(const key of ['source_compilation_performed','native_certification','application_activation','business_acceptance','performance_acceptance'])assert.equal(ranges[key],false,key);
});

test('Source32 appends only the generated scalar and restores the complete Source31 closure',()=>{
 const frame=source32Closure.frame_schema_column;
 assert.equal(frame.projection_basis.bytes,703);assert.equal(frame.projection_basis.sha256,'fa01b4866b0f694d55e61950cac43be65cdc76516ba30d2e53c6acebcbd3b71b');
 assert.equal(frame.valid.bytes,53130);assert.equal(frame.valid.sha256,'19558e1f578684cf667275c1f0afa81f458e4f5e4db118a1c56f522bfe0c6c29');
 assert.equal(Buffer.byteLength(source32Closure.preambleSql)-Buffer.byteLength(source31Closure.preambleSql),76);
 assert.equal(Buffer.byteLength(source32Closure.sql)-Buffer.byteLength(source31Closure.sql),-10);
 assert.equal(source32Closure.preambleSql.split(frame.projectionBasisSql).length,2);assert.equal(source32Closure.sql.split(frame.validSql).length,2);
 assert.deepEqual(source32Closure.data,source31Closure.data);assert.deepEqual(source32Closure.logical_data,source31Closure.logical_data);assert.deepEqual(source32Closure.changes,source31Closure.changes);
 assert.deepEqual(source32Closure.projection_basis,source31Closure.projection_basis);assert.equal(sha(serialize31(source32Closure.data)),'db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3');
 assert.deepEqual(source32Closure.authored_basis,source31Closure.authored_basis);assert.equal(source32Closure.aclSql,source31Closure.aclSql);assert.deepEqual(source32Closure.required_fixed_seal,source31Closure.required_fixed_seal);
 assert.deepEqual(source32Closure.source_inputs.frameSchemaColumn210,frame.source_proofs);assert.equal(frame.existing_column_declaration_sequence_preserved,true);
 assert.equal(source32Closure.sealed,false);assert.equal(source32Closure.source_compilation_performed,false);assert.equal(source32Closure.native_certification,false);assert.equal(source32Closure.application_activation,false);
});

test('Source31 physical DATA and six decode ports restore the entire Source30 closure before historical witnesses',()=>{
 assert.equal(source31Closure.data.schema,'order-split210-projection-basis/definition-codec-v1');assert.equal(source31Closure.logical_data.schema,'order-split210-projection-basis/v1');
 assert.deepEqual(source31Closure.projection_basis,{bytes:3590688,sha256:'db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3'});assert.equal(4194304-source31Closure.projection_basis.bytes,603616);
 assert.equal(sha(serialize31(source31Closure.logical_data)),'01ab182b9b1ee0f35a3e7fd9505aeafd9415b516c843d6265c20017139008b9e');assert.deepEqual(decodeOrderSplit210DefinitionData(source31Closure.data),source31Closure.logical_data);
 assert.equal(source31Closure.sql.split(valid31.sql).length,2);assert.equal(source31Closure.sql.split(source31Closure.definition_codec_ports.metadataSql).length,2);assert.equal(source31Closure.definition_codec_ports.targets.reduce((n,t)=>n+t.edits.length,0),6);
 assert.deepEqual(source31Closure.source_inputs.validSnapshot210,valid31.source_proofs);assert(source31Closure.source_inputs.metadataComposite209&&source31Closure.source_inputs.definitionCodec210&&source31Closure.source_inputs.definitionCodecPorts210);
 for(let i=0;i<22;i++){assert.deepEqual(source31Closure.changes[i].before,result.changes[i].before);if(source31Closure.changes[i].key!==metadataKey)assert.deepEqual(source31Closure.changes[i].after,result.changes[i].after);}
 for(let i=0;i<22;i++){const raw=source31Closure.changes[i],physical=source31Closure.data.changes[i],logical=source31Closure.logical_data.changes[i];assert.deepEqual(physical.before,raw.before);assert.equal(physical.after.source,raw.after.source);assert.deepEqual(physical.after.definition,['order-split210-after-definition/v1']);assert.deepEqual(logical.after,raw.after);assert.deepEqual(logical.after_check,orderSplit210TaggedDescriptor(raw.after));}
 assert.equal(sha(result.sql),'e66169d62242d0fbab77362c941faf50f9c50cfc8cbd17460df5d609270dcb75');
});

test('twenty-two full source-derived deltas, bounded immutable DATA, and empty manifest remain explicitly unsealed',()=>{
 assert.equal(result.changes.length,22);assert.equal(new Set(result.changes.map(c=>c.key)).size,22);
 assert.equal(result.data.business_keys.length,4);assert.equal(result.data.layer_keys.length,14);
 assert.deepEqual(result.data.nonlegacy_projection_keys,[...result.data.business_keys,'public.financial_return_upgrade_valid()','public.ordinary181_financial_valid(manual_basis jsonb)','public.ordinary181_credit_calculate(projection_ok boolean)','public.ordinary180_projection_valid(b jsonb)']);
 assert(body('try_function_projection').includes("entries->'nonlegacy_projection_keys' @>"));
 assert(body('try_function_projection').includes("'financial_return_upgrade_valid'"));
 assert(!result.data.layer_keys.includes('public.financial_return_upgrade_valid()'));
 assert(!result.data.business_keys.includes('public.buyer_address_guards()'),'buyer must execute209 to208 instead of the unbound four-function early return');
 assert.deepEqual(result.data.layer_keys.slice(-3),['public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)','public.order_merge_delivery209_buyer_guards(manual_basis jsonb)','public.order_merge_delivery209_startup_operative_valid(entries jsonb)']);
 assert(!result.data.layer_keys.includes('public.ordinary181_financial_valid(manual_basis jsonb)'));
 assert(body('try_function_projection').includes("'ordinary181_financial_valid'"));
 assert(!result.data.layer_keys.includes('public.ordinary181_credit_calculate(projection_ok boolean)'));
 assert(body('try_function_projection').includes("'ordinary181_credit_calculate'"));
 assert(result.projection_basis.bytes<4194304);assert.equal(result.projection_basis.sha256.length,64);
 assert(result.preambleSql.includes('payload_jsonb jsonb GENERATED ALWAYS AS(payload::jsonb) STORED NOT NULL'));
 assert(result.preambleSql.includes('payload_octets integer GENERATED ALWAYS AS(pg_catalog.octet_length(payload)) STORED NOT NULL'));
 assert(result.preambleSql.includes('payload_sha256 text GENERATED ALWAYS AS('));
 assert(result.preambleSql.includes('CREATE TABLE public.order_split210_manifest('));
 assert(!result.preambleSql.includes('INSERT INTO public.order_split210_manifest'));
 assert(!result.sql.includes('INSERT INTO public.order_split210_manifest'));
 for(const k of ['sealed','seal_sql_emitted','source_compilation_performed','complete_fifteen_change_closure','complete_sixteen_change_closure','complete_seventeen_change_closure','complete_twenty_change_closure','complete_twenty_two_change_closure','complete_twenty_one_change_closure','native_certification','application_activation'])assert.equal(result[k],false,k);
 assert(Object.isFrozen(result)&&Object.isFrozen(result.data)&&Object.isFrozen(result.changes[0].after));
 assert(result.unresolved_pg_fields.includes('trigger.definition'));
 assert.equal(result.parent.source_native_acceptance,true);assert.equal(result.full_before_descriptors_compiler_verified,false);
 assert(result.installer_order.findIndex(s=>s.startsWith('closure ports'))<result.installer_order.indexOf('twenty-two exact predecessor replacements'),'new ports exist before SQL-language CREATE successors resolve them');
});

test('independent metadata-only guard binds all8kinds, full22AFTER, parent DATA, and exact external semantic basis',()=>{
 const fp=body('fingerprint'),valid=body('valid');
 for(const kind of ['relation','column','constraint','index','policy','trigger','function','type'])assert(result.metadata_queries.own.includes("SELECT '"+kind+"',"),kind);
 for(const field of ['generated','default','options','acl_null','argument_names','argument_modes','security_definer','definition','source'])assert(result.metadata_queries.own.includes("'"+field+"'"),field);
 assert(fp.includes('payload_octets')&&fp.includes('payload_sha256'));
 assert(!fp.includes('public.order_merge_delivery209_valid(')&&!fp.includes('public.order_merge_delivery209_fingerprint('));
 const executable=orderSplit210ObserverSpans(valid).filter(s=>s.executable).map(s=>s.text).join('');
 assert(!executable.includes('public.order_merge_delivery209_valid(')&&!executable.includes('public.order_merge_delivery209_fingerprint('),'quoted historical bodies are data, no old guard is executed');
 assert(valid.includes('m.original209 IS DISTINCT FROM(SELECT to_jsonb(p)'));
 assert(valid.includes('m.original166 IS DISTINCT FROM(SELECT to_jsonb(p)'));
 assert(valid.includes('count(*) FROM public.order_split210_manifest)<>1'));
 assert(valid.includes('actual IS DISTINCT FROM'));
 assert.equal(result.authored_basis.triggers.counts.triggers,27);
 assert.equal(result.authored_basis.triggers.counts.constraints,3);
 assert.equal(result.authored_basis.fks.counts.foreign_keys,18);
 assert.equal(result.authored_basis.fks.counts.ri_triggers,72);
 assert.equal(result.required_fixed_seal.external_keys.length,36,'12 explicit bound+24 FK-linked external RI');
 assert(!body('require').includes('RETURN true'));assert(body('require').includes("ERRCODE='55000'"));
});

test('Source29 guard maps trigger constraint names only inside its capture, preserving the standalone fingerprint and all22/DATA',()=>{
 assert.equal(result.sql.split(validSnapshot.sql).length,2,'actual emitted guard is exactly the pinned transformation');
 assert.equal(validSnapshot.queries.changed_functions,result.metadata_queries.changed_functions);
 assert.equal(validSnapshot.queries.own,result.metadata_queries.own);
 const fp=body('fingerprint').trim(),expanded=validSnapshot.queries.fingerprint_expression.replace('FROM live_all','FROM('+result.metadata_queries.own+' UNION ALL '+result.metadata_queries.changed_functions+') fp');
 assert.equal('SELECT '+expanded+';',fp,'actual standalone fingerprint ordered expression is unchanged');
 const external=[...validSnapshot.queries.external_predicate.matchAll(/'(public\.[^']+)'/g)].map(m=>m[1]);assert.deepEqual(external,result.required_fixed_seal.external_keys);
 assert.equal(result.changes.length,22);assert.equal(result.projection_basis.bytes,4192445);assert.equal(result.projection_basis.sha256,'fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45');
 assert.deepEqual(result.source_inputs.validSnapshot210,validSnapshot.source_proofs);
 assert.deepEqual(result.source_inputs.triggerConstraintMap210,validSnapshot.trigger_constraint_map.source_proofs);
 assert.notDeepEqual(result.source_inputs.triggerConstraintMap210,result.source_inputs.validSnapshot210,'separate provenance for the exact query-local map');
 assert.equal(validSnapshot.trigger_constraint_map.source_proofs.sha256,'a165c4a5299326669925818f6745d96ad56f0228903ac8332dbf63ff44ea587b');
 assert.equal(result.sql.split(validSnapshot.trigger_constraint_map.effective_own_query).length,2,'mapped own query is emitted once');
 assert(!result.metadata_queries.own.includes('selected_triggers'),'fixed-seal and standalone readers remain the original full own query');
 let previous=validSnapshot.sql;
 for(const edit of [...validSnapshot.trigger_constraint_map.body_edits].reverse())previous=previous.slice(0,edit.afterStart)+edit.before+previous.slice(edit.afterStart+edit.after.length);
 const source29Closure=result.sql.replace(validSnapshot.sql,()=>previous);
 assert.equal(Buffer.byteLength(result.sql)-Buffer.byteLength(source29Closure),302,'only the reviewed guard SQL grows');
 assert.equal(body('fingerprint').trim(),'SELECT '+expanded+';');
 const sql27=result.sql.replace(validSnapshot.sql,()=>validSource27);
 assert.equal(Buffer.byteLength(sql27),96396);assert.equal(sha(sql27),'3c9bbef7fda409eb68f3fc3428b857a9faebf2038057bb8db5f103877d682e75');
 assert.equal(validSnapshot.source_data_changed,false);assert.equal(validSnapshot.snapshot.standalone_fingerprint_changed,false);assert.equal(validSnapshot.cross_invocation_cache,false);
});

test('private ACL seal revokes inherited defaults and tables retain FORCE RLS plus immutable writes/truncate',()=>{
 assert(result.aclSql.includes('pg_catalog.aclexplode'));
 assert(result.aclSql.includes('x.grantee<>o.proowner'));
 assert(result.aclSql.includes('x.grantee<>c.relowner'));
 assert(!/GRANT\s+EXECUTE/i.test(result.sql+result.aclSql));
 for(const t of ['order_split210_projection_basis','order_split210_manifest']){
  assert(result.preambleSql.includes('ALTER TABLE public.'+t+' FORCE ROW LEVEL SECURITY'));
  assert(result.preambleSql.includes('BEFORE UPDATE OR DELETE ON public.'+t));
  assert(result.preambleSql.includes('BEFORE TRUNCATE ON public.'+t));
 }
});

test('scope fast paths keep outside data literal, matching names retain full fresh closure before any inverse',()=>{
 const fn=body('try_function_projection'),metadata=body('try_metadata_projection'),record=body('project209_record');
 assert(fn.indexOf('THEN RETURN NULL')<fn.indexOf('PERFORM public.order_split210_require()'));
 assert(fn.includes("n.nspname='public'"));assert(fn.includes("actual->'value' IS DISTINCT FROM entry->'after'"));
 assert(metadata.indexOf('THEN RETURN NULL')<metadata.indexOf('PERFORM public.order_split210_require()'));
 assert(metadata.includes("v->'after'=order_split210_try_metadata_projection.value"));assert(metadata.includes('jsonb_each(order_split210_try_metadata_projection.value) WITH ORDINALITY'));
 assert(!metadata.includes('replace('),'no substring rewriting SQL/definitions/customer text');
 assert(record.indexOf('THEN RETURN record')<record.indexOf('PERFORM public.order_split210_require()'));
 assert(record.includes("record IS DISTINCT FROM jsonb_build_object('kind','function'"));
 assert(record.includes("entry->'after_check'"));assert(record.includes("entry->'before_check'"));
});

test('Source27 retains every source-exact seven-key209/208 classifier after the full22 guard and exact Source24 inverse',()=>{
 // Controlled evaluation of the emitted equality branches, using the actual
 // source-derived full-current inverse for every relevant invocation. No PG or
 // predicate callback claims are made by this test.
 // The ACTUAL emitted Source27 function must be the exact chained transforms.
 // Legacy classifier equations use its entire verified inverse, while the new
 // DFS engine is independently checked below and in the dedicated helper suite.
 assert(result.sql.includes(metadataCandidateFilter.sql));let original=metadataCandidateFilter.sql;
 for(const edit of [...metadataCandidateFilter.edits].reverse()){assert.equal(original.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);original=original.slice(0,edit.afterStart)+edit.before+original.slice(edit.afterStart+edit.after.length);}
 assert.equal(original,metadataText.sql,'three exact filters invert the full Source26 declaration/header/body/suffix');
 for(const edit of [...metadataText.edits].reverse()){assert.equal(original.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);original=original.slice(0,edit.afterStart)+edit.before+original.slice(edit.afterStart+edit.after.length);}
 assert.equal(original,metadataTraversal.sql);
 for(const edit of [...metadataTraversal.edits].reverse()){assert.equal(original.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);original=original.slice(0,edit.afterStart)+edit.before+original.slice(edit.afterStart+edit.after.length);}
 assert.equal(original,metadataSource24);
 const source=original.slice(original.indexOf('$closure210$')+12,original.lastIndexOf('$closure210$')),guard=source.indexOf('PERFORM public.order_split210_require()');
 const sites=[...source.matchAll(/IF value=jsonb_build_object\('kind','function','key',entry->>'key','value',entry->'(before|before_check|after|after_check)'\) THEN RETURN (value|jsonb_build_object\('kind','function','key',entry->>'key','value',entry->'(before|before_check)'\));END IF;/g)];
 assert.deepEqual(sites.map(m=>m[1]),['before','before_check','after','after_check']);
 assert(guard>=0&&sites.every(m=>m.index>guard),'fresh full22 AFTER guard precedes every identity/projection branch');
 for(const bucket of ['metadata_ancestor_records','metadata_ancestor_shapes','metadata_literals'])assert(source.indexOf("entries->'"+bucket+"'")>guard);
 const metadataWhere=/SELECT v INTO entry FROM jsonb_array_elements\(entries->'metadata'\) v WHERE ([^;]+);/.exec(source);assert(metadataWhere);
 const metadataFields=[...metadataWhere[1].matchAll(/v->'(before|after)'=order_split210_try_metadata_projection\.value/g)].map(m=>m[1]);assert.deepEqual(metadataFields,['after','before']);
 assert(source.includes("WHERE v->'after'=order_split210_try_metadata_projection.value"),'scalar source/definition mapping uses whole JSON string equality');
 assert.deepEqual(result.data.metadata_literal_keys,['public.financial_return_upgrade_valid()','public.ordinary181_financial_valid(manual_basis jsonb)']);
 assert(source.includes("WHERE (entries->'metadata_literal_keys') ? (v->>'key')"));
 assert(source.includes("IF value=entry->'after'->field THEN RETURN entry->'before'->field;END IF;"));
 assert(source.includes("IF value=entry->'before'->field THEN RETURN value;END IF;"));
 assert.equal(result.data.metadata_keys.length,7);assert.equal(result.data.metadata_keys.at(-1),'public.ordinary181_financial_valid(manual_basis jsonb)');
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
 const buyer=result.data.changes.find(c=>c.key==='public.buyer_address_guards()'),tagged208=result.data.metadata_ancestor_records.find(r=>Array.isArray(r.value.source));
 assert.equal(buyer.key,'public.buyer_address_guards()');assert(tagged208);
 const special=source.indexOf("IF entry->>'key'='public.buyer_address_guards()' AND(value=jsonb_build_object('kind','function','key',entry->>'key','value',entry->'before_check')");
 assert(special>guard&&special<sites.find(m=>m[1]==='before_check').index);
 assert(source.includes("OR value=jsonb_build_object('kind','function','key',entry->>'key','value',entry->'after_check')) THEN"));
 assert(source.includes("jsonb_typeof(v->'value'->'source')='array' AND jsonb_typeof(v->'value'->'definition')='array'"));
 const financialChange=result.changes.find(c=>c.key==='public.financial_return_upgrade_valid()');
 const compact=deriveOrderSplit210FinancialMetadataShapes({change:financialChange});
 const ancestor208=result.data.metadata_ancestor_records.find(r=>typeof r.value.source==='string').value;
 const buyerChange=result.changes.find(c=>c.key===buyer.key);
 const compactBuyer=deriveOrderSplit210BuyerMetadataShapes({change:buyerChange,ancestor208});
 const ordinary=result.changes.find(c=>c.key==='public.ordinary181_financial_valid(manual_basis jsonb)');
 const compactOrdinary=deriveOrderSplit210OrdinaryMetadataShapes({change:ordinary});
 const compactPrograms=[compact,compactBuyer,compactOrdinary];
 const allRefs=compactPrograms.flatMap(c=>c.refs);
 assert.deepEqual(result.data.metadata_compact_shapes,allRefs);assert.equal(allRefs.length,12);
 assert.deepEqual(result.data.metadata.map(e=>e.key),result.data.business_keys.flatMap(key=>[key,key,key,key]));
 for(const key of [financialChange.key,buyer.key,ordinary.key])assert(!result.data.metadata.some(e=>e.key===key));
 assert.deepEqual(compactOrdinary.refs.map(r=>r.signature),['public.ordinary181_financial_valid(jsonb)','public.ordinary181_financial_valid(jsonb)','ordinary181_financial_valid(jsonb)','ordinary181_financial_valid(jsonb)']);
 for(const program of compactPrograms){assert(source.includes(program.sql));assert(source.indexOf(program.sql)>guard);assert(source.indexOf(program.sql)<source.indexOf("IF EXISTS(SELECT FROM jsonb_array_elements(entries->'metadata')"));}
 assert(!result.data.metadata.some(e=>e.key===financialChange.key),'large financial definitions stored only in complete bound descriptors');
 assert(source.includes(compact.sql));assert(source.indexOf(compact.sql)>guard);
 assert.deepEqual(compact.projection_counts,{signatures:2,variants:4,whole_before_shapes:4,whole_after_shapes:4,acl_order:'source array ordinality'});
 assert(source.indexOf(compact.sql)<source.indexOf("IF EXISTS(SELECT FROM jsonb_array_elements(entries->'metadata')"));
 const evaluate=(value,records=current())=>{
  if(value===null||!result.data.metadata_keys.some(k=>JSON.stringify(value).includes(k.slice(7,k.indexOf('('))+'(')))return undefined;
  projectOrderSplit210ChangedFunctions(records,result);
  if(value&&typeof value==='object'&&!Array.isArray(value)){
   if(value.kind==='function'&&result.data.metadata_keys.includes(value.key)){
    const entry=result.data.changes.find(c=>c.key===value.key);assert(entry);
    if(entry.key===buyer.key&&['before_check','after_check'].some(field=>same(value,{kind:'function',key:entry.key,value:entry[field]})))return tagged208;
    for(const site of sites)if(same(value,{kind:'function',key:entry.key,value:entry[site[1]]}))return site[2]==='value'?value:{kind:'function',key:entry.key,value:entry[site[3]]};
    if(result.data.metadata_ancestor_records.some(v=>same(v,value)))return value;
    throw Error('exact metadata leaf required');
   }
   if(result.data.metadata_compact_shapes.some(e=>e.signature===value.signature)){
    try{const ref=result.data.metadata_compact_shapes.find(e=>e.signature===value.signature);if(ref.key===buyer.key)return projectOrderSplit210BuyerMetadataShape({change:buyerChange,ancestor208,value});if(ref.key===ordinary.key)return projectOrderSplit210OrdinaryMetadataShape({change:ordinary,value});assert.equal(ref.key,financialChange.key);return projectOrderSplit210FinancialMetadataShape({change:financialChange,value});}catch{throw Error('exact metadata leaf required');}
   }
   if(result.data.metadata.some(e=>e.after.signature===value.signature)){
    const entry=result.data.metadata.find(e=>metadataFields.some(field=>same(e[field],value)));if(entry)return entry.before;
    if(result.data.metadata_ancestor_shapes.some(v=>same(v,value)))return value;
    throw Error('exact metadata leaf required');
   }
   let changed=false;const output={};for(const [key,item]of Object.entries(value)){const projected=evaluate(item,records);output[key]=projected===undefined?item:projected;changed||=projected!==undefined;}return changed?output:undefined;
  }
  if(Array.isArray(value)){let changed=false;const output=value.map(item=>{const projected=evaluate(item,records);changed||=projected!==undefined;return projected===undefined?item:projected;});return changed?output:undefined;}
  if(typeof value==='string'){for(const entry of result.data.changes.filter(c=>result.data.metadata_literal_keys.includes(c.key)))for(const field of ['source','definition']){if(value===entry.after[field])return entry.before[field];if(value===entry.before[field])return value;}const entry=result.data.metadata_literals.find(e=>e.after===value);return entry?.before;}
  return undefined;
 };
 for(const c of result.data.changes.filter(c=>result.data.metadata_keys.includes(c.key))){
  for(const [after,before]of [['after','before'],['after_check','before_check']]){
   const input={kind:'function',key:c.key,value:c[after]},expected=c.key===buyer.key&&after==='after_check'?tagged208:{kind:'function',key:c.key,value:c[before]};
   assert.deepEqual(evaluate(input),expected);assert.deepEqual(evaluate(evaluate(input)),expected);assert.strictEqual(evaluate(expected),expected);
   for(const poison of [v=>v.value.owner='foreign',v=>v.value.acl=[],v=>v.spoof=true]){const bad=copy(expected);poison(bad);assert.throws(()=>evaluate(bad),/exact metadata leaf/);}
   const mixed=copy(expected);mixed.value.source=c[after].source;assert.throws(()=>evaluate(mixed),/exact metadata leaf/);
  }
 }
 for(const ref of allRefs){
  const shape=value=>({signature:ref.signature,definition:value.definition,owner:value.owner,language:value.language,volatility:value.volatility,strict:value.strict,leakproof:value.leakproof,security_definer:value.security_definer,parallel:value.parallel,kind:value.kind,returns_set:value.returns_set,arguments:value.arguments,result:value.result,argument_modes:value.argument_modes,argument_names:value.argument_names,defaults:value.defaults,configuration:value.config,cost:value.cost,rows:value.rows,acl:value.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]),...(ref.body_sha256?{body_sha256:sha(value.source)}:{})});
  const change=result.changes.find(c=>c.key===ref.key);assert(change);
  const before=shape(change.before),after=shape(change.after);
  if(ref.key===buyer.key){const ancestor=shape(ancestor208);assert.deepEqual(evaluate(ancestor),ancestor);assert.deepEqual(evaluate(evaluate(ancestor)),ancestor);}
  assert.deepEqual(evaluate(after),before);assert.deepEqual(evaluate(before),before);assert.deepEqual(evaluate(evaluate(after)),before);
  for(const poison of [v=>v.acl=[],v=>v.definition+=' ',v=>v.extra=true,v=>v.configuration=['search_path=public']]){const bad=copy(after);poison(bad);assert.throws(()=>evaluate(bad),/exact metadata leaf/);}
  assert.throws(()=>evaluate(after,current().slice(1)),/all twenty-two/,'compact shape cannot bypass full current guard');
 }
 for(const e of result.data.metadata){assert.deepEqual(evaluate(e.after),e.before);assert.deepEqual(evaluate(evaluate(e.after)),e.before);const bad=copy(e.before);bad.owner='foreign';assert.throws(()=>evaluate(bad),/exact metadata leaf/);}
 assert.equal(result.data.metadata_ancestor_records.length,2);assert.equal(result.data.metadata_ancestor_shapes.length,0);
 for(const ancestor of [...result.data.metadata_ancestor_records,...result.data.metadata_ancestor_shapes]){
  assert.strictEqual(evaluate(ancestor),ancestor,'exact source208 is already the historical side, not forced to209');
  const bad=copy(ancestor);if(bad.kind==='function')bad.value.acl.push({grantor:'postgres',grantee:'PUBLIC',privilege:'EXECUTE',grantable:false});else bad.acl.push(['postgres','PUBLIC','EXECUTE',false]);
  assert.throws(()=>evaluate(bad),/exact metadata leaf/);
 }
 for(const financial of [financialChange,ordinary])for(const field of ['source','definition']){
  assert.equal(evaluate(financial.after[field]),financial.before[field]);
  assert.equal(evaluate(financial.before[field]),financial.before[field]);
  assert.equal(evaluate(financial.after[field]+' '),undefined);
  assert.equal(evaluate(buyer.after[field]),buyer.before[field]);assert.equal(evaluate(evaluate(buyer.after[field])),buyer.before[field]);
  assert.equal(evaluate(buyer.after[field]+' '),undefined,'substring/whitespace resemblance never authorizes source projection');
  assert.equal(evaluate(sha(buyer.after[field])),undefined,'bare digest is not an authenticated full string');
 }
 const ancestor=result.data.metadata_ancestor_records.find(r=>typeof r.value.source==='string');
 for(const field of ['source','definition'])assert.equal(evaluate(ancestor.value[field]),ancestor.value[field]);
 const buyerPimShape=(value,ref)=>({signature:ref.signature,definition:value.definition,owner:value.owner,language:value.language,volatility:value.volatility,strict:value.strict,leakproof:value.leakproof,security_definer:value.security_definer,parallel:value.parallel,kind:value.kind,returns_set:value.returns_set,arguments:value.arguments,result:value.result,argument_modes:value.argument_modes,argument_names:value.argument_names,defaults:value.defaults,configuration:value.config,cost:value.cost,rows:value.rows,acl:value.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]),...(ref.body_sha256?{body_sha256:sha(value.source)}:{})});
 const nested={unselected:{same:'literal'},raw:{kind:'function',key:buyer.key,value:buyer.after},tagged:[{kind:'function',key:buyer.key,value:buyer.after_check}],pim:buyerPimShape(buyer.after,compactBuyer.refs[0]),source:buyer.after.source};
 const projected=evaluate(nested);assert.deepEqual(projected.raw.value,buyer.before);assert.deepEqual(projected.tagged[0],tagged208);assert.equal(projected.source,buyer.before.source);assert.deepEqual(projected.unselected,nested.unselected);assert.deepEqual(evaluate(projected),projected);
 for(const identity of [{kind:'function',key:buyer.key,value:buyer.before},...result.data.metadata_ancestor_records,...result.data.metadata_ancestor_shapes,buyer.before.source]){
  assert.throws(()=>evaluate(identity,current().slice(1)),/all twenty-two/,'identity ancestor cannot bypass a missing current binding');
  const drift=current();drift[4].value.source+=' ';assert.throws(()=>evaluate(identity,drift),/complete current AFTER/,'identity ancestor cannot bypass own209 current-source drift');
 }
 // Apply the ACTUAL accepted209 metadata tail after the210 helper. The tail
 // is independently taken from both pinned predecessor bodies, and its
 // complete executable text is fixed below. It replaces full raw texts and
 // source hashes, deliberately not the deparser-definition hash.
 const parent=deriveOrderSplit210Layer({sourceBundle}),tails=parent.changes.filter(c=>c.key.includes('predecessor_metadata(')).map(c=>c.before.source.slice(c.before.source.indexOf(' FOR entry IN SELECT v FROM jsonb_array_elements(entries)')));
 const expectedTail=" FOR entry IN SELECT v FROM jsonb_array_elements(entries) a(v) LOOP\n  FOREACH field IN ARRAY ARRAY['source','definition'] LOOP\n   after_value:=entry->'after'->>field;before_value:=entry->'before'->>field;\n   result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);\n  END LOOP;\n  after_value:=encode(sha256(convert_to(entry->'after'->>'source','UTF8')),'hex');\n  before_value:=encode(sha256(convert_to(entry->'before'->>'source','UTF8')),'hex');\n  result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);\n END LOOP;\n RETURN result::jsonb;\nEND";
 assert.equal(tails.length,2);for(const tail of tails)assert.equal(tail,expectedTail,'both true209 tails have the same exact authenticated operations');
 const before208=result.data.metadata_ancestor_records.find(r=>typeof r.value.source==='string').value;
 const outer209Tail=value=>{
  let text=JSON.stringify(value);const entry={after:buyer.before,before:before208};
  for(const field of ['source','definition'])text=text.replaceAll(JSON.stringify(entry.after[field]),JSON.stringify(entry.before[field]));
  text=text.replaceAll(JSON.stringify(sha(entry.after.source)),JSON.stringify(sha(entry.before.source)));
  return JSON.parse(text);
 };
 assert.deepEqual(outer209Tail(evaluate({kind:'function',key:buyer.key,value:buyer.after})),{kind:'function',key:buyer.key,value:before208});
 for(const value of [buyer.after_check,buyer.before_check]){
  const first=outer209Tail(evaluate({kind:'function',key:buyer.key,value}));
  assert.deepEqual(first,tagged208);assert.deepEqual(first.value.source,['sha256-utf8-text/v1',sha(before208.source)]);assert.deepEqual(first.value.definition,['sha256-utf8-text/v1',sha(before208.definition)]);
  assert.deepEqual(outer209Tail(evaluate(first)),tagged208,'second parent invocation remains wholly208 on both tagged leaves');
 }
 for(const ref of compactBuyer.refs){
  const after=buyerPimShape(buyer.after,ref),expected=buyerPimShape(before208,ref);
  assert.deepEqual(outer209Tail(evaluate(after)),expected,'PIM exact compact shape reaches208 via actual209 raw-text/source-SHA tail');
 }
 for(const field of ['source','definition'])assert.equal(outer209Tail(evaluate(buyer.after[field])),before208[field]);
 const half=copy(tagged208);half.value.definition=buyer.before_check.definition;assert.throws(()=>evaluate(half),/exact metadata leaf/,'mixed208 source/209 definition must not become an accepted ancestor');
 const record=body('project209_record');assert(record.includes("entry->'after_check'"));assert(!record.includes('metadata_ancestor_records'),'live current tagged projector never normalizes an already historical ancestor');
});

test('both fixed families preserve real predecessor composition, with old projectors only outside four',()=>{
 const c=Object.fromEntries(result.changes.map(c=>[c.key,c])),families=result.data.families;
 assert(families.partial204['public.fa3_draft_fingerprint()'].includes('AS $function$'));
 assert(!families.partial204['public.fa3_draft_fingerprint()'].includes('partial_sale204_predecessor_definition('));
 assert.equal(families.manual169['public.fa3_draft_fingerprint()'],families.partial204['public.fa3_draft_fingerprint()']);
 assert.equal(families.manual169['public.b2b_invoice_fingerprint()'],families.partial204['public.b2b_invoice_fingerprint()']);
 assert(families.manual169['public.b2b_credit_fingerprint()']!==c['public.b2b_credit_fingerprint()'].before.definition);
 assert.equal(families.partial204['public.b2b_credit_fingerprint()'],c['public.b2b_credit_fingerprint()'].before.definition);
 for(const family of ['partial204','manual169'])assert.equal(families[family]['public.wms_row_guard()'],c['public.wms_row_guard()'].before.definition);
 const fk='public.financial_return_upgrade_valid()';
 assert.equal(families.manual169[fk],c[fk].before.definition);
 assert.notEqual(families.partial204[fk],families.manual169[fk]);
 const literal189=read('server/189_packing_required_order_fields.sql');
 const financialAt=literal189.search(/^CREATE OR REPLACE FUNCTION public\.financial_return_upgrade_valid\(\)/m);
 const financialOpen=literal189.indexOf('AS $function$',financialAt)+'AS $function$'.length;
 const financialClose=literal189.indexOf('$function$;',financialOpen);
 assert(financialAt>=0&&financialClose>financialOpen);
 assert.equal(families.partial204[fk],literal189.slice(financialAt,financialClose)+'$function$\n','entire independent literal189 definition');
 const b=body('predecessor_definition');assert(b.includes("IF family IS NULL OR family NOT IN('partial204','manual169')"));
 assert(b.indexOf('try_function_projection(fn)')<b.indexOf('partial_sale204_predecessor_definition(fn)'));
 assert(b.includes('IF projected IS NULL THEN'));
});

test('credit21 uses exact Source189 identity in both families, remains outside strict204 and cannot bypass full-current validation',()=>{
 const key='public.ordinary181_credit_calculate(projection_ok boolean)',change=result.changes[20];assert.equal(change.key,key);
 const literal=read('server/189_packing_required_order_fields.sql'),marker='CREATE OR REPLACE FUNCTION '+key+'\n',start=literal.indexOf(marker);assert(start>=0);assert.equal(literal.indexOf(marker,start+1),-1);
 const open=literal.indexOf('AS $function$',start)+'AS $function$'.length,end=literal.indexOf('$function$;',open);assert(end>open);const expected=literal.slice(start,end)+'$function$\n';
 assert.equal(sha(expected),'1e9379ccf1f6a63133701adf1bd36c8f811e052b85961a18f05173a2519a63a4');assert.equal(change.before.definition,expected);
 for(const family of ['partial204','manual169']){assert.equal(Object.keys(result.data.families[family]).length,7);assert.equal(result.data.families[family][key],expected);}
 // Neither actual old dispatch has a special credit-calculator CASE. Before
 // Source210 they return its raw189 definition, unlike the older160 credit
 // fingerprint. The finite210 port restores precisely that same value.
 const source204=businessInputs.source204,partialAt=source204.indexOf('CREATE FUNCTION public.partial_sale204_predecessor_definition(fn oid)\n');assert(partialAt>=0);
 const partialOpen=source204.indexOf('AS $function$',partialAt)+'AS $function$'.length,partialEnd=source204.indexOf('$function$;',partialOpen),partial=source204.slice(partialOpen,partialEnd);assert(!partial.includes('ordinary181_credit_calculate'));assert(partial.includes('THEN RETURN pg_get_functiondef(fn);END IF;'));
 const manualAt=source204.indexOf('CREATE OR REPLACE FUNCTION public.manual_inventory_off_projected_definition(fn oid)\n');assert(manualAt>=0);const manualOpen=source204.indexOf('AS $function$',manualAt)+'AS $function$'.length,manualEnd=source204.indexOf('$function$;',manualOpen),manual=source204.slice(manualOpen,manualEnd);assert(!manual.includes('ordinary181_credit_calculate'));assert(manual.includes('ELSE pg_get_functiondef(p.oid) END'));
 assert.equal(result.data.nonlegacy_projection_keys.length,8);assert(result.data.nonlegacy_projection_keys.includes(key));assert(!result.data.layer_keys.includes(key));
 assert.equal(result.data.metadata_keys.length,7);assert(!result.data.metadata_keys.includes(key),'no new PIM/raw-string normalization without a source-authored consumer path');
 const port=body('try_function_projection');assert(port.includes("'ordinary181_credit_calculate'"));assert(port.indexOf('PERFORM public.order_split210_require()')<port.indexOf("actual->'value' IS DISTINCT FROM entry->'after'"));
 const oldTwenty=current().slice(0,20);assert.throws(()=>projectOrderSplit210ChangedFunctions(oldTwenty,result),/all twenty-two/,'the historical twenty-record frame cannot authorize21');
 const poisoned=current();poisoned[20].value.acl.push({grantor:'postgres',grantee:'PUBLIC',privilege:'EXECUTE',grantable:false});assert.throws(()=>projectOrderSplit210ChangedFunctions(poisoned,result),/complete current AFTER/);
 const tagged=current().map(r=>({...r,value:orderSplit210TaggedDescriptor(r.value)}));assert.deepEqual(projectOrderSplit210ChangedFunctions(tagged,result,{representation:'tagged'})[20].value,orderSplit210TaggedDescriptor(change.before));
 assert.equal(result.data.business_keys.length,4);assert.equal(result.data.layer_keys.length,14);assert.equal(result.parent.legacy_function_count,17);assert.equal(result.required_fixed_seal.external_keys.length,36);
});

test('partial204 family fast path preserves the source strict CASE intersection and exact descriptor refusals',()=>{
 const original=businessInputs.source204,start=original.indexOf('CREATE FUNCTION public.partial_sale204_predecessor_definition(fn oid)\n');assert(start>=0);
 const open=original.indexOf('AS $function$',start)+'AS $function$'.length,prefix=original.slice(open,open+4096);
 const oldScope=/IF fn NOT IN\(([^\n]+)\) THEN RETURN pg_get_functiondef\(fn\);END IF;/.exec(prefix);assert(oldScope);
 const strictTypes=[...oldScope[1].matchAll(/'([^']+)'::regprocedure/g)].map(m=>m[1]);assert.equal(strictTypes.length,23);
 const typeKey=key=>key.replace('(manual_basis jsonb)','(jsonb)');
 const expected=result.data.nonlegacy_projection_keys.filter(key=>strictTypes.includes(typeKey(key)));
 assert.deepEqual(expected,['public.fa3_draft_fingerprint()','public.b2b_invoice_fingerprint()','public.financial_return_upgrade_valid()','public.ordinary181_financial_valid(manual_basis jsonb)']);
 const source=body('predecessor_definition'),gate=/IF family='partial204' AND k=ANY\(ARRAY\[([^\]]+)\]::text\[\]\)\n AND EXISTS\(SELECT FROM pg_catalog.pg_proc p WHERE p.oid=fn AND\(([^\n]+)\)\) THEN (RAISE EXCEPTION [^\n]+;)END IF;/.exec(source);assert(gate,'exact local catalog guard and source-equivalent error');
 assert.deepEqual([...gate[1].matchAll(/'([^']+)'/g)].map(m=>m[1]),expected);
 assert(prefix.includes(' IF '+gate[2]+' THEN '+gate[3]+'END IF;'),'the complete predicate and refusal come from actual204, including the overload count');
 assert.equal(gate[3],"RAISE EXCEPTION '204 exact scoped descriptor required' USING ERRCODE='55000';");
 assert(source.indexOf('try_function_projection(fn)')<gate.index);
 assert(source.indexOf('IF projected IS NULL THEN')<gate.index,'unknown/legacy functions retain their literal fallback before these extra checks');
 assert(source.indexOf("IF family='partial204' THEN RETURN public.partial_sale204_predecessor_definition(fn);END IF;")<gate.index);
 assert(source.indexOf("SELECT payload_jsonb INTO STRICT entries")<gate.index);
 assert(source.indexOf("INTO STRICT k FROM pg_catalog.pg_proc")<gate.index);
 assert(gate.index<source.indexOf("IF entries->'families'->family->>k IS NULL"),'no family return before strict descriptor validation');
 const extractedScope=[...gate[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
 // This models only the added local predicate. The mandatory full current guard
 // separately rejects overload/drift; false here never denotes admission.
 const refuses=(key,family,flags)=>family==='partial204'&&extractedScope.includes(key)&&(flags.proallargtypes!==null||flags.protrftypes!==null||flags.prosqlbody!==null||flags.nameCount!==1);
 const clean={proallargtypes:null,protrftypes:null,prosqlbody:null,nameCount:1};
 for(const key of result.data.nonlegacy_projection_keys){
  assert.equal(refuses(key,'partial204',clean),false);
  for(const field of ['proallargtypes','protrftypes','prosqlbody','nameCount']){
   const bad={...clean,[field]:field==='nameCount'?2:['unexpected']};
   assert.equal(refuses(key,'partial204',bad),strictTypes.includes(typeKey(key)),key+' preserves the actual204 local guard boundary');
   assert.equal(refuses(key,'manual169',bad),false,'do not add these partial204-only checks to manual169');
  }
 }
 for(const key of ['public.buyer_address_guards()','public.unrelated()'])assert(!extractedScope.includes(key),'legacy/unknown fallback is not captured by the new local gate');
});

test('manual169 source equation follows actual204 delegation to158/159 and preserves the genuine160 credit body',()=>{
 const source204=businessInputs.source204;
 assert.equal(sha(source204),'410fe04993d1e5c714319146bae29370ef8e2bda445d5ccac38e6c626bdcbc82');
 const declaration='CREATE OR REPLACE FUNCTION public.manual_inventory_off_projected_definition(fn oid)\n',start=source204.indexOf(declaration);assert(start>=0);assert.equal(source204.indexOf(declaration,start+1),-1);
 const open=source204.indexOf('AS $function$',start)+'AS $function$'.length,end=source204.indexOf('$function$;',open),manual=source204.slice(open,end);
 assert.equal(sha(manual),'3f9350c6420b07f033f9adc35eed9bab1c9ea5d493fdebb5664cd71725bdd949');
 const branch=/SELECT CASE WHEN p\.oid IN\(([^\n]+)\) THEN public\.partial_sale204_predecessor_definition\(p\.oid\)/.exec(manual);assert(branch);
 assert.deepEqual([...branch[1].matchAll(/'([^']+)'::regprocedure/g)].map(m=>m[1]),['public.local_invoice_frame(uuid,uuid,integer,jsonb,text)','public.local_invoice_fingerprint()','public.fa3_draft_fingerprint()','public.b2b_invoice_fingerprint()']);
 // Independently read each literal original from204's actual CASE arm. This
 // does not use the closure's partial204 map as the expected manual169 value.
 const partialStart=source204.indexOf('CREATE FUNCTION public.partial_sale204_predecessor_definition(fn oid)\n');assert(partialStart>=0);
 const partialOpen=source204.indexOf('AS $function$',partialStart)+'AS $function$'.length,partialEnd=source204.indexOf('$function$;',partialOpen),partial=source204.slice(partialOpen,partialEnd);
 const mask=orderSplit210ObserverSpans(partial).map(s=>s.executable?s.text:s.text.replace(/[^\n]/g,' ')).join('');
 for(const [key,source,pin]of [
  ['public.fa3_draft_fingerprint()',inputs.source158,'b8945d716cd3f02bba6bd3339fcd6f21b67941a0ef053706f82913c042c939c6'],
  ['public.b2b_invoice_fingerprint()',inputs.source159,'5905b532e58c66984e45df1b9c0b83e330e64569bd3ce5c274946e83cac9b9fd'],
 ]){
  const marker="WHEN '"+key+"'::regprocedure THEN",at=partial.indexOf(marker);assert(at>=0);assert.equal(mask.slice(at,at+4),'WHEN','an executable current CASE, not quoted history');
  const oldStart=partial.indexOf('original:=$old204$',at)+'original:=$old204$'.length,oldEnd=partial.indexOf('$old204$;',oldStart),original=partial.slice(oldStart,oldEnd);assert(oldEnd>oldStart);
  const c=result.changes.find(c=>c.key===key);assert(c);assert.equal(c.before.definition.split(c.before.source).length,2);
  const independent=c.before.definition.replace(c.before.source,()=>original);assert.equal(sha(independent),pin);assert.equal(result.data.families.manual169[key],independent);
  const nativeDeclaration='CREATE FUNCTION '+key,nativeAt=source.indexOf(nativeDeclaration);assert(nativeAt>=0);assert.equal(source.indexOf(nativeDeclaration,nativeAt+1),-1);const bodyAt=source.indexOf('$$',nativeAt)+2,bodyEnd=source.indexOf('$$',bodyAt);
  assert.equal(source.slice(bodyAt,bodyEnd),original,'204 literal really is the independently authored158/159 body');
  assert.notEqual(independent,c.before.definition,'current204 text is the source-level counterexample that broke family160');
 }
 const credit=result.changes.find(c=>c.key==='public.b2b_credit_fingerprint()'),source160=businessInputs.source160,creditAt=source160.indexOf('CREATE FUNCTION public.b2b_credit_fingerprint()');assert(creditAt>=0);
 const creditOpen=source160.indexOf('$$',creditAt)+2,creditEnd=source160.indexOf('$$',creditOpen),original160=source160.slice(creditOpen,creditEnd);
 assert.equal(sha(original160),'eb63a87e7d4dd426474f7f9a4cc08c3acb5a482247f1fdf40dcc21f21015c948');
 assert.equal(result.data.families.manual169[credit.key],credit.before.definition.replace(credit.before.source,()=>original160));
 assert.equal(sha(result.data.families.manual169[credit.key]),'f109b15f866adc952924d4bd99df4bbae984a1f2385895fcaef5bfed0a3f699c');
 // The credit observer contains both families, so both delegated definitions
 // enter the JSON fingerprint. Preserve the old projector for every other fn.
 assert(credit.before.source.includes("p.proname LIKE 'fa3\\_draft\\_%'"));assert(credit.before.source.includes("p.proname LIKE 'b2b\\_invoice\\_%'"));
 assert(body('predecessor_definition').includes("IF family='partial204' THEN RETURN public.partial_sale204_predecessor_definition(fn);END IF;\n  RETURN public.manual_inventory_off_projected_definition(fn);"));
 assert.equal(result.native_certification,false);
});

test('manualprojection22 keeps fresh nonlegacy admission and historical21 after the Source24 operative inverse, without new family/PIM shapes',()=>{
 const manual=deriveOrderSplit210ManualProjectionSuccessor(),key=manual.change.key,change=result.changes[21],entry=result.data.changes[21];assert.deepEqual(change,manual.change);assert.equal(key,'public.ordinary180_projection_valid(b jsonb)');
 assert.deepEqual(entry.before,change.before);assert.deepEqual(entry.after,change.after);assert.deepEqual(entry.before_check,orderSplit210TaggedDescriptor(change.before));assert.deepEqual(entry.after_check,orderSplit210TaggedDescriptor(change.after));
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 assert.equal(sha(JSON.stringify(canonical(historicalChanges(result.changes).slice(0,21).map((c,i)=>i===16?deriveOrderSplit210HistoryOperativeSuccessor({source210:inputs.source210}).change:c)))),'9baa16dd6c2f94f69c1d2f29bc28a5f67def22aa86e39d33673efa49485883bb','exact source-only historical21 full descriptors');
 assert.equal(result.data.nonlegacy_projection_keys.length,8);assert.equal(result.data.nonlegacy_projection_keys.at(-1),key);assert(!result.data.business_keys.includes(key));assert(!result.data.layer_keys.includes(key));
 for(const family of ['partial204','manual169']){assert.equal(Object.keys(result.data.families[family]).length,7);assert(!Object.hasOwn(result.data.families[family],key),'no wrong historical family or unconsumed62KiB duplication');}
 for(const bucket of ['metadata_keys','metadata_literal_keys'])assert(!result.data[bucket].includes(key));assert.equal(result.data.metadata_keys.length,7);assert.equal(result.data.layer_keys.length,14);assert(!result.data.metadata.some(v=>v.key===key));assert(!result.data.metadata_compact_shapes.some(v=>v.key===key));
 assert.deepEqual(change.after.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.equal(change.after.arguments,'b jsonb');assert.deepEqual(change.after.argument_names,['b']);assert.equal(Object.keys(change.after).length,24);
 assert.equal(result.projection_basis.bytes,4192445);assert.equal(result.projection_basis.sha256,'fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45');assert.equal(4194304-result.projection_basis.bytes,1859,'unchanged4MiB cap with source-derived smaller DATA');
 assert.throws(()=>projectOrderSplit210ChangedFunctions(current().slice(0,21),result),/all twenty-two/,'historical complete21 cannot authorize the new frame');
 for(const representation of ['raw','tagged']){const rows=current().map(r=>representation==='tagged'?{...r,value:orderSplit210TaggedDescriptor(r.value)}:r),projected=projectOrderSplit210ChangedFunctions(rows,result,{representation});assert.deepEqual(projected[21].value,representation==='tagged'?entry.before_check:entry.before);}
 const port=body('try_function_projection');assert(port.includes("'ordinary180_projection_valid'"));assert(port.indexOf('PERFORM public.order_split210_require()')<port.indexOf("actual->'value' IS DISTINCT FROM entry->'after'"));assert(port.indexOf("actual->'value' IS DISTINCT FROM entry->'after'")<port.indexOf("RETURN entry->'before'"));
});

test('Source24 current22 frame binds the shared operative source, preserves other21 and rejects the whole historical Source23 frame',()=>{
 const sharing=deriveOrderSplit210HistoryFinancialSharing({source210:inputs.source210}),key=sharing.change.key;
 const change=result.changes.find(c=>c.key===key),entry=result.data.changes.find(c=>c.key===key);
 assert.deepEqual(change,sharing.change);assert.deepEqual(entry.after,change.after);assert.deepEqual(entry.after_check,orderSplit210TaggedDescriptor(change.after));
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 assert.equal(sha(JSON.stringify(canonical(historicalChanges(result.changes).filter(c=>c.key!==key)))),'8c4a8389d48051f7abeb7f75f75682ca9547041ac13b683119d690fd2c17eaae');
 assert.equal(sharing.budget.previous_data_bytes,4192139);assert.equal(sharing.budget.canonical_change_delta_bytes,1704);
 assert.equal(sharing.budget.predicted_data_bytes,4193843);assert.equal(sharing.budget.remaining_bytes,461);
 for(const representation of ['raw','tagged']){
  const rows=current().map(r=>representation==='tagged'?{...r,value:orderSplit210TaggedDescriptor(r.value)}:r);
  const projected=projectOrderSplit210ChangedFunctions(rows,result,{representation});
  assert.deepEqual(projected.find(r=>r.key===key).value,representation==='tagged'?entry.before_check:entry.before);
  const old=copy(rows),at=old.findIndex(r=>r.key===key);old[at].value=representation==='tagged'?orderSplit210TaggedDescriptor(sharing.source23_change.after):sharing.source23_change.after;
  assert.throws(()=>projectOrderSplit210ChangedFunctions(old,result,{representation}),/complete current AFTER/,'historical Source23 complete22 is not current admission');
 }
 assert.equal(result.data.nonlegacy_projection_keys.length,8);assert.equal(result.data.layer_keys.length,14);assert.equal(result.data.metadata_keys.length,7);
 assert.equal(Object.keys(result.data.families.partial204).length,7);assert.equal(Object.keys(result.data.families.manual169).length,7);
});

test('Source27 candidate filters, local text and traversal preserve all22/DATA and owns exactly one fresh guard without a trusted-frame API',()=>{
 const source=body('try_metadata_projection'),canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 assert.equal(sha(JSON.stringify(canonical(historicalChanges(result.changes)))),'c17e750ff090d52f1c3260bf7536a9349a98746ca9826f588a8c9bc3cf4a9684');
 assert.equal(result.projection_basis.bytes,4192445);assert.equal(result.projection_basis.sha256,'fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45');
 assert.equal(result.sql.split(metadataCandidateFilter.sql).length,2);assert.equal((source.match(/PERFORM public\.order_split210_require\(\)/g)||[]).length,1);assert.equal((source.match(/SELECT payload_jsonb INTO STRICT entries/g)||[]).length,1);
 assert(!source.includes('public.order_split210_try_metadata_projection('));assert(source.indexOf('PERFORM public.order_split210_require()')<source.indexOf('WHILE cardinality(walk_nodes)'));
 assert(source.includes('IF walk_projection IS NOT NULL THEN\n   walk_changed:=true;\n   IF walk_projection IS DISTINCT FROM value THEN'));
 assert(source.includes('jsonb_set(walk_root,walk_text_path,walk_projection,false)'));assert(source.includes('IF jsonb_array_length(walk_path)=0 THEN walk_root:=walk_projection;'));
 assert.equal((source.match(/ORDER BY e\.ord DESC/g)||[]).length,2);assert.equal(metadataTraversal.traversal.terminal_returns,17);assert.equal(metadataTraversal.traversal.new_runtime_functions,0);
 assert.deepEqual(result.source_inputs.metadataTraversal210,metadataTraversal.source_proofs);
 assert.deepEqual(result.source_inputs.metadataText210,metadataText.source_proofs);
 assert.deepEqual(result.source_inputs.metadataCandidateFilter210,metadataCandidateFilter.source_proofs);
 assert.equal(metadataCandidateFilter.edits.length,3);assert.equal(metadataCandidateFilter.source_data_changed,false);
 for(const edit of metadataCandidateFilter.edits){
  assert.equal(result.sql.split(edit.after).length,2,'each finite filter appears once in the actual emitted function');
  assert(edit.after.includes("v->>'signature'=order_split210_try_metadata_projection.value->>'signature'"));
  assert(edit.after.includes("v->'body_sha256'=to_jsonb(order_split210_try_metadata_projection.value ? 'body_sha256')"));
 }
 assert.equal(metadataCandidateFilter.new_runtime_functions,0);assert.equal(metadataCandidateFilter.cross_invocation_cache,false);
 assert.equal((source.match(/value::text/g)||[]).length,2);assert.equal((source.match(/walk_text:=CASE WHEN value IS NULL THEN NULL ELSE value::text END/g)||[]).length,2);
 assert.equal(metadataText.serialization.old_cast_sites,14);assert.equal(metadataText.serialization.new_cast_sites,2);
 assert(source.indexOf('walk_text:=CASE')<source.indexOf('PERFORM public.order_split210_require()'),'cheap unknown/SQLNULL return still precedes fresh guard');
});

test('file-only22function inverse authenticates entire raw/tagged records and preserves unrelated aliases',()=>{
 const outside={kind:'relation',key:'public.orders',value:{untrusted:'unchanged'}};
 for(const representation of ['raw','tagged']){
  const records=current().map(r=>representation==='tagged'?{...r,value:orderSplit210TaggedDescriptor(r.value)}:r);records.push(outside);
  const output=projectOrderSplit210ChangedFunctions(records,result,{representation});assert.strictEqual(output.at(-1),outside);
  for(let i=0;i<22;i++)assert.deepEqual(output[i].value,representation==='tagged'?orderSplit210TaggedDescriptor(result.changes[i].before):result.changes[i].before);
 }
 const v=orderSplit210TaggedDescriptor(result.changes[0].after);
 assert.deepEqual(v.source,['sha256-utf8-text/v1',sha(result.changes[0].after.source)]);
 assert.deepEqual(v.definition,['sha256-utf8-text/v1',sha(result.changes[0].after.definition)]);
 assert.equal(v.security_definer,result.changes[0].after.security_definer);
});

test('missing/extra/duplicate/overload and source, definition, owner, ACL, argument/header drift refuse',()=>{
 assert.throws(()=>projectOrderSplit210ChangedFunctions(current().slice(1),result),/all twenty-two/);
 const duplicate=current();duplicate.push(duplicate[0]);assert.throws(()=>projectOrderSplit210ChangedFunctions(duplicate,result),/duplicate/);
 const overload=current();overload.push({...copy(overload[0]),key:overload[0].key.replace('()','(spoof text)')});assert.throws(()=>projectOrderSplit210ChangedFunctions(overload,result),/overload/);
 const mutations=[v=>v.source+=' ',v=>v.definition+=' ',v=>v.owner='dyna_app',v=>v.acl.push({grantor:'postgres',grantee:'PUBLIC',privilege:'EXECUTE',grantable:false}),v=>v.argument_names=['spoof'],v=>v.config=['search_path=public'],v=>v.result='jsonb',v=>v.security_definer=false];
 for(const mutate of mutations)for(const i of [0,14,15,16,17,18,19,20,21]){const rs=current();mutate(rs[i].value);assert.throws(()=>projectOrderSplit210ChangedFunctions(rs,result),/complete current AFTER/);}
 const extraField=current();extraField[0].spoof=true;assert.throws(()=>projectOrderSplit210ChangedFunctions(extraField,result),/complete current AFTER/);
 const tagged=current().map(r=>({...r,value:orderSplit210TaggedDescriptor(r.value)}));tagged[0].value.source.push('extra');assert.throws(()=>projectOrderSplit210ChangedFunctions(tagged,result,{representation:'tagged'}),/complete current AFTER/);
});

test('all source inputs remain pinned independently of candidate/data, no catalogue or callback authority',()=>{
 assert.throws(()=>deriveOrderSplit210Closure({...inputs,source158:inputs.source158+'\n'}),/literal family source pin/);
 assert.throws(()=>deriveOrderSplit210Closure({...inputs,source210:inputs.source210+'\n'}),/literal frozen Native210 source/);
 const changed=copy(sourceBundle);changed.routines[0]+=' ';assert.throws(()=>deriveOrderSplit210Closure({...inputs,sourceBundle:changed}),/literal source routine pin/);
 assert.equal(result.source_inputs.parent209,'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a');
 assert(!('sealSql' in result));assert(!('schemaValid' in result));
});
