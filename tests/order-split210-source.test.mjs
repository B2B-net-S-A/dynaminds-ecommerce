/** Unsealed source assembly only; no PG parsing, deployment or Native proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {assembleOrderSplit210Source,inspectOrderSplit210Declarations,assertOrderSplit210SuccessorHeaders,ORDER_SPLIT210_ASSEMBLY_INPUTS} from '../tools/parity/order-split210-source.mjs';
import {deriveOrderSplit210Closure,orderSplit210TaggedDescriptor} from '../tools/parity/order-split210-closure.mjs';
import {orderSplit210ObserverSpans} from '../tools/parity/order-split210-predecessor.mjs';
import {deriveOrderSplit210FinancialSuccessor} from '../tools/parity/order-split210-financial-successor.mjs';
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

import {deriveOrderSplit210HistoryBuyerSuccessor} from '../tools/parity/order-split210-history-buyer-successor.mjs';
import {deriveOrderSplit210StartupOperativeSuccessor} from '../tools/parity/order-split210-startup-operative-successor.mjs';
import {deriveOrderSplit210OrdinaryFinancialSuccessor} from '../tools/parity/order-split210-ordinary-financial-successor.mjs';
import {deriveOrderSplit210CreditSuccessor} from '../tools/parity/order-split210-credit-successor.mjs';
import {deriveOrderSplit210ManualProjectionSuccessor} from '../tools/parity/order-split210-manual-projection-successor.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8'),sha=s=>createHash('sha256').update(s).digest('hex');
const fixture=/gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:131072\}\)/.exec(read('tests/order-split210-layer.test.mjs'));
assert(fixture);const sourceBundle=JSON.parse(gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:131072}).toString('utf8'));
const paths={source104:'104_order_merge_custody.sql',source108:'108_b2b_dropshipping.sql',source160:'160_b2b_credit.sql',source169:'169_manual_inventory_off.sql',source204:'204_partial_commercial_sale_scope.sql'};
const businessInputs=Object.fromEntries(Object.entries(paths).map(([k,v])=>[k,read('server/'+v)]));
const inputs={businessInputs,sourceBundle,source158:read('server/158_fa3_draft_native.sql'),source159:read('server/159_b2b_invoice.sql'),source210:read('tools/parity/order-split210-business.sql'),sourceTerminal:read('tools/parity/order-split210-terminal.sql'),sourceSchema:read('server/schema.sql')};
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
const source34Program=assembleOrderSplit210Source(inputs),copy=v=>structuredClone(v);

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;


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

const source34Closure=deriveOrderSplit210Closure(inputs),source33Closure=restoreSource33Closure(source34Closure),source32Closure=restoreSource32Closure(source33Closure),source31Closure=restoreSource31Closure(source32Closure),historicalClosure=restoreSource30Closure(source31Closure);
const source33ProgramSql=replace31Once(source34Program.sql,source34Closure.sql,source33Closure.sql);
assert.equal(Buffer.byteLength(source33ProgramSql),4525227);assert.equal(sha(source33ProgramSql),'23cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d');
const source33Stages=source34Program.stages.map(s=>{let sql=Buffer.from(source34Program.sql).subarray(s.offset,s.offset+s.bytes).toString('utf8');if(s.id==='closure-ports')sql=source33Closure.sql;const offset=Buffer.byteLength(source33ProgramSql.slice(0,source33ProgramSql.indexOf(sql)));assert(source33ProgramSql.includes(sql));return{...s,offset,bytes:Buffer.byteLength(sql),sha256:sha(sql)};});
const source33Inputs={...source34Program.source_inputs,derivations:source33Closure.source_inputs};
const source33Program={...source34Program,sql:source33ProgramSql,bytes:Buffer.byteLength(source33ProgramSql),sha256:sha(source33ProgramSql),stages:source33Stages,source_inputs:source33Inputs,boundary_sha256:sha(JSON.stringify(canonical(source33Stages))),input_sha256:sha(JSON.stringify(canonical(source33Inputs)))};
const source32ProgramSql=replace31Once(source33Program.sql,source33Closure.sql,source32Closure.sql);
assert.equal(Buffer.byteLength(source32ProgramSql),4524613);assert.equal(sha(source32ProgramSql),'a737148ee97845de656b38d5a92dea341c6040c2ae8b39557d2e248c26c6fc8b');
const source32Stages=source33Program.stages.map(s=>{let sql=Buffer.from(source33Program.sql).subarray(s.offset,s.offset+s.bytes).toString('utf8');if(s.id==='closure-ports')sql=source32Closure.sql;const offset=Buffer.byteLength(source32ProgramSql.slice(0,source32ProgramSql.indexOf(sql)));assert(source32ProgramSql.includes(sql));return{...s,offset,bytes:Buffer.byteLength(sql),sha256:sha(sql)};});
const source32Inputs={...source33Program.source_inputs,derivations:source32Closure.source_inputs};
const source32Program={...source33Program,sql:source32ProgramSql,bytes:Buffer.byteLength(source32ProgramSql),sha256:sha(source32ProgramSql),stages:source32Stages,source_inputs:source32Inputs,boundary_sha256:sha(JSON.stringify(canonical(source32Stages))),input_sha256:sha(JSON.stringify(canonical(source32Inputs)))};
let source31ProgramSql=replace31Once(source32Program.sql,source32Closure.preambleSql,source31Closure.preambleSql);source31ProgramSql=replace31Once(source31ProgramSql,source32Closure.sql,source31Closure.sql);
assert.equal(Buffer.byteLength(source31ProgramSql),4524547);assert.equal(sha(source31ProgramSql),'3e99139ded0b97012846f5d1bb023e60bb289b307a0647d3302419c3f60414ab');
const source31Stages=source32Program.stages.map(s=>{let sql=Buffer.from(source32Program.sql).subarray(s.offset,s.offset+s.bytes).toString('utf8');if(s.id==='closure-data')sql=source31Closure.preambleSql;if(s.id==='closure-ports')sql=source31Closure.sql;const offset=Buffer.byteLength(source31ProgramSql.slice(0,source31ProgramSql.indexOf(sql)));assert(source31ProgramSql.includes(sql));return{...s,offset,bytes:Buffer.byteLength(sql),sha256:sha(sql)};});
const source31Inputs={...source32Program.source_inputs,derivations:source31Closure.source_inputs};
const source31Program={...source32Program,sql:source31ProgramSql,bytes:Buffer.byteLength(source31ProgramSql),sha256:sha(source31ProgramSql),stages:source31Stages,source_inputs:source31Inputs,boundary_sha256:sha(JSON.stringify(canonical(source31Stages))),input_sha256:sha(JSON.stringify(canonical(source31Inputs)))};

let source30ProgramSql=replace31Once(source31Program.sql,source31Closure.preambleSql,historicalClosure.preambleSql);source30ProgramSql=replace31Once(source30ProgramSql,source31Closure.sql,historicalClosure.sql);
const metadata31=source31Program.changed_functions.find(c=>c.key===metadataKey),metadata30=historicalClosure.changes.find(c=>c.key===metadataKey);
source30ProgramSql=replace31Once(source30ProgramSql,metadata31.after.definition,metadata30.after.definition);assert.equal(Buffer.byteLength(source30ProgramSql),5094845);assert.equal(sha(source30ProgramSql),'f2f3d9cf78724bc173a3fca1afee4c8b887c1b5bf7b7d5041eeb720c77530c3a');
const source30Stages=source31Program.stages.map(s=>{let sql=Buffer.from(source31Program.sql).subarray(s.offset,s.offset+s.bytes).toString('utf8');if(s.id==='closure-data')sql=historicalClosure.preambleSql;if(s.id==='closure-ports')sql=historicalClosure.sql;if(s.id==='replace:'+metadataKey)sql=metadata30.after.definition+';\n';const offset=Buffer.byteLength(source30ProgramSql.slice(0,source30ProgramSql.indexOf(sql)));assert(source30ProgramSql.includes(sql));return{...s,offset,bytes:Buffer.byteLength(sql),sha256:sha(sql)};});
const historicalInputs={...source31Program.source_inputs,derivations:historicalClosure.source_inputs};
const result={...source31Program,sql:source30ProgramSql,bytes:Buffer.byteLength(source30ProgramSql),sha256:sha(source30ProgramSql),stages:source30Stages,changed_functions:historicalClosure.changes,projection_basis:historicalClosure.projection_basis,source_inputs:historicalInputs,boundary_sha256:sha(JSON.stringify(canonical(source30Stages))),input_sha256:sha(JSON.stringify(canonical(historicalInputs)))};Object.freeze(result);Object.freeze(result.stages[0]);
const buffer=Buffer.from(result.sql),stage=s=>buffer.subarray(s.offset,s.offset+s.bytes).toString('utf8');
test('Source34 full program uses the constraint selector and has an exact full Source33 inverse',()=>{
 assert.equal(source34Program.bytes,4525572);assert.equal(source34Program.sha256,'685c16fbf6fdf35f1b95752e7672e6df484ec865d0fa2cf5a20da5801da3dc73');assert.equal(source34Program.stages.length,27);
 assert.equal(replace31Once(source34Program.sql,source34Closure.constraint_candidates.sql,source33Closure.prefix_name_ranges.sql),source33Program.sql);
 assert.deepEqual(source34Program.changed_functions,source33Program.changed_functions);assert.equal(source34Program.changed_functions.length,22);
 assert.deepEqual(source34Program.projection_basis,source33Program.projection_basis);
 const changed=source34Program.stages.filter((s,i)=>s.sha256!==source33Program.stages[i].sha256).map(s=>s.id);assert.deepEqual(changed,['closure-ports']);
 assert.equal(Buffer.byteLength(source33Program.sql),4525227);assert.equal(sha(source33Program.sql),'23cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d');
 assert.deepEqual(source34Program.source_inputs.derivations.constraintCandidates210,source34Closure.constraint_candidates.source_proofs);
 for(const k of ['sealed','seal_sql_emitted','source_compilation_performed','native_certification','application_activation','migration_registered'])assert.equal(source34Program[k],false,k);
});

test('Source33 whole program differs only in the six-atom valid capture and reverses every Source32 byte',()=>{
 assert.equal(source33Program.bytes,4525227);assert.equal(source33Program.bytes-source32Program.bytes,614);assert.equal(source33Program.sha256,'23cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d');assert.equal(source33Program.sha256,sha(source33Program.sql));
 assert.equal(source33Program.stages.length,27);assert.deepEqual(source33Program.changed_functions,source32Program.changed_functions);assert.equal(source33Program.changed_functions.length,22);
 assert.deepEqual(source33Program.projection_basis,source32Program.projection_basis);
 const changed=[];for(let i=0;i<27;i++){const next=source33Program.stages[i],prior=source32Program.stages[i];assert.equal(next.id,prior.id);if(next.sha256!==prior.sha256)changed.push(next.id);else assert.equal(next.bytes,prior.bytes);}
 assert.deepEqual(changed,['closure-ports']);
 const bytes=Buffer.from(source33Program.sql);for(const stage of source33Program.stages){const body=bytes.subarray(stage.offset,stage.offset+stage.bytes);assert.equal(body.length,stage.bytes);assert.equal(sha(body),stage.sha256);}
 assert.equal(replace31Once(source33Program.sql,source33Closure.prefix_name_ranges.sql,source32Closure.frame_schema_column.validSql),source32Program.sql);
 const before=inspectOrderSplit210Declarations(source32Program.sql),after=inspectOrderSplit210Declarations(source33Program.sql);assert.deepEqual(after,before);assert.equal(after.functions.length,49);assert.equal(after.tables.length,8);
 assert.deepEqual(source33Program.source_inputs.derivations.prefixNameRanges210,source33Closure.prefix_name_ranges.source_proofs);
 for(const k of ['sealed','seal_sql_emitted','source_compilation_performed','native_certification','application_activation','migration_registered'])assert.equal(source33Program[k],false,k);
});

test('Source32 whole program has only two changed stages and an exact whole Source31 inverse',()=>{
 assert.equal(source32Program.bytes,4524613);assert.equal(source32Program.sha256,'a737148ee97845de656b38d5a92dea341c6040c2ae8b39557d2e248c26c6fc8b');assert.equal(source32Program.stages.length,27);
 assert.deepEqual(source32Program.projection_basis,source31Program.projection_basis);assert.deepEqual(source32Program.changed_functions,source31Program.changed_functions);
 const changed=[];for(let i=0;i<27;i++){const next=source32Program.stages[i],prior=source31Program.stages[i];assert.equal(next.id,prior.id);if(next.sha256!==prior.sha256)changed.push(next.id);else assert.equal(next.bytes,prior.bytes);}
 assert.deepEqual(changed,['closure-data','closure-ports']);
 const bytes=Buffer.from(source32Program.sql);for(const stage of source32Program.stages){const body=bytes.subarray(stage.offset,stage.offset+stage.bytes);assert.equal(body.length,stage.bytes);assert.equal(sha(body),stage.sha256);}
 assert.equal(source31Program.bytes,4524547);assert.equal(source31Program.sha256,'3e99139ded0b97012846f5d1bb023e60bb289b307a0647d3302419c3f60414ab');
 for(const k of ['sealed','seal_sql_emitted','source_compilation_performed','native_certification','application_activation','migration_registered'])assert.equal(source32Program[k],false,k);
});

test('Source31 whole program and physical DATA have a complete source-authored Source30 inverse before older witnesses',()=>{
 assert.equal(source31Program.bytes,4524547);assert.equal(source31Program.sha256,'3e99139ded0b97012846f5d1bb023e60bb289b307a0647d3302419c3f60414ab');assert.equal(source31Program.stages.length,27);assert.equal(source31Program.changed_functions.length,22);
 const currentBuffer=Buffer.from(source31Program.sql),inventory=inspectOrderSplit210Declarations(source31Program.sql);assert.equal(inventory.functions.length,49);assert.equal(inventory.tables.length,8);
 for(const stage of source31Program.stages){const bytes=currentBuffer.subarray(stage.offset,stage.offset+stage.bytes);assert.equal(sha(bytes),stage.sha256);assert.equal(bytes.length,stage.bytes);}
 for(let i=0;i<22;i++){const stage=source31Program.stages[i+4];assert.equal(currentBuffer.subarray(stage.offset,stage.offset+stage.bytes).toString('utf8'),source31Program.changed_functions[i].after.definition+';\n');}
 assert.deepEqual(source31Program.projection_basis,{bytes:3590688,sha256:'db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3'});assert.deepEqual(source31Program.source_inputs.derivations.validSnapshot210,valid31.source_proofs);
 assert.equal(result.bytes,5094845);assert.equal(result.sha256,'f2f3d9cf78724bc173a3fca1afee4c8b887c1b5bf7b7d5041eeb720c77530c3a');
 for(let i=0;i<22;i++){assert.deepEqual(source31Program.changed_functions[i].before,result.changed_functions[i].before);if(source31Program.changed_functions[i].key!==metadataKey)assert.deepEqual(source31Program.changed_functions[i].after,result.changed_functions[i].after);}
});

test('exact27 stages bind UTF8 byte boundaries and independent whole/input/boundary digests',()=>{
 assert.equal(result.stages.length,27);assert.equal(result.bytes,buffer.length);assert.equal(result.sha256,sha(buffer));
 for(let i=0;i<result.stages.length;i++){
  const s=result.stages[i];assert.equal(s.index,i+1);assert.equal(sha(buffer.subarray(s.offset,s.offset+s.bytes)),s.sha256);
  assert.equal(Buffer.byteLength(stage(s)),s.bytes);if(i)assert(s.offset>result.stages[i-1].offset+result.stages[i-1].bytes);
 }
 assert.equal(stage(result.stages[0]),inputs.source210);assert.equal(stage(result.stages[1]),inputs.sourceTerminal);
 assert.equal(result.stages[0].sha256,ORDER_SPLIT210_ASSEMBLY_INPUTS.core.sha256);
 assert.equal(result.stages[1].sha256,ORDER_SPLIT210_ASSEMBLY_INPUTS.terminal.sha256);
 assert.equal(result.boundary_sha256,sha(JSON.stringify(canonical(result.stages))));
 assert.equal(result.input_sha256,sha(JSON.stringify(canonical(result.source_inputs))));
 assert(Object.isFrozen(result)&&Object.isFrozen(result.stages[0]));
});

test('Source30 trigger lookup has exact whole Source29/28/27/26/25/24 inverses without changing any BEFORE or other21 AFTER',t=>{
 const ports=stage(result.stages[3]);assert.equal(ports.split(metadataCandidateFilter.sql).length,2);assert(!ports.includes(metadataSource24));
 assert.equal(ports.split(validSnapshot.sql).length,2);
  let valid29=validSnapshot.sql;
  for(const edit of [...validSnapshot.trigger_constraint_map.body_edits].reverse()){
   assert.equal(valid29.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);
   valid29=valid29.slice(0,edit.afterStart)+edit.before+valid29.slice(edit.afterStart+edit.after.length);
  }
  assert.equal(Buffer.byteLength(valid29),52821);assert.equal(sha(valid29),'8265baf087e1a1d5b3290c17cd0018a153dc766e341399774285481d510eab24');
  const source29=result.sql.replace(validSnapshot.sql,()=>valid29);
  assert.equal(Buffer.byteLength(source29),5094543);assert.equal(sha(source29),'bd61089c06f26c9195f5fd002b22424dab8e36dad37580b4cc9c9e259d200bb7','entire independently published Source29 program restored');
 const closure=historicalClosure,oldData=copy(closure.data),at=oldData.changes.findIndex(c=>c.key===metadataKey);assert(at>=0);
 oldData.changes[at].after=copy(source28Metadata);oldData.changes[at].after_check=orderSplit210TaggedDescriptor(source28Metadata);
 const payload=JSON.stringify(canonical(closure.data)),oldPayload=JSON.stringify(canonical(oldData)),quote=s=>"'"+s.replaceAll("'","''")+"'";
 assert.equal(Buffer.byteLength(oldPayload),4193843);assert.equal(sha(oldPayload),'0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7');
 const metadata=result.changed_functions.find(c=>c.key===metadataKey);assert(metadata);
 let source28=result.sql;for(const [before,after] of [[validSnapshot.sql,validSnapshot28.sql],[metadata.after.definition,source28Metadata.definition],[quote(payload),quote(oldPayload)],[`CHECK(octet_length(payload)=${result.projection_basis.bytes})`,'CHECK(octet_length(payload)=4193843)'],[`CHECK(payload_sha256=${quote(result.projection_basis.sha256)})`,"CHECK(payload_sha256='0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7')"]]){assert.equal(source28.split(before).length,2,'one source-auth inverse port');source28=source28.replace(before,()=>after);}
 assert.equal(Buffer.byteLength(source28),5096765);assert.equal(sha(source28),'0efeb7fab0521edd3e4130930750482722548e52c32dc553b3787c4774673766','entire authored Source28 inverse including both DATA constraints');
 const source27=source28.replace(validSnapshot28.sql,()=>validSource27);
 assert.equal(Buffer.byteLength(source27),5096180);assert.equal(sha(source27),'eeb5034d0d26766f4548a895e3a23b9ae2ab9ad7854215583e8995d9a218c6e3','whole independently published Source27 program inverse');
 let function26=metadataCandidateFilter.sql;
 for(const edit of [...metadataCandidateFilter.edits].reverse()){assert.equal(function26.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);function26=function26.slice(0,edit.afterStart)+edit.before+function26.slice(edit.afterStart+edit.after.length);}
 assert.equal(function26,metadataText.sql);
 const source26=source27.replace(metadataCandidateFilter.sql,()=>function26);
 assert.equal(Buffer.byteLength(source26),5095667);assert.equal(sha(source26),'082e4bed0cf507ceb12c9e351f97fe54c051bf9e332da50546e71f124bcc621a','whole Source26 program inverse, not only a body or catalogue');
 const source25=source26.replace(metadataText.sql,()=>metadataTraversal.sql);assert.equal(Buffer.byteLength(source25),5095544);assert.equal(sha(source25),'d9498e231ea31c10c2182c94de442ac4e5edd94525ab8db8fcfee314582de4d3','entire published Source25 program, not only the function');
 const restored=source26.replace(metadataText.sql,()=>metadataSource24);assert.equal(Buffer.byteLength(restored),5093221);assert.equal(sha(restored),'59bafbea5dabb4e8ccd65139d9075f5433be252545971c04a9f0d0cc226ba2d7','exact whole authored Source24 program inverse, not observed catalogue');
  assert.equal(result.bytes,5096765+Buffer.byteLength(quote(payload))-Buffer.byteLength(quote(oldPayload))+Buffer.byteLength(metadata.after.definition)-Buffer.byteLength(source28Metadata.definition)+validSnapshot.bytes-validSnapshot28.bytes);
 assert.deepEqual(result.source_inputs.derivations.metadataCandidateFilter210,metadataCandidateFilter.source_proofs);
 assert.deepEqual(result.source_inputs.derivations.validSnapshot210,validSnapshot.source_proofs);
 assert.equal(result.projection_basis.bytes,4192445);assert.equal(result.projection_basis.sha256,'fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45');
  t.diagnostic(JSON.stringify({source30_sha256:result.sha256,bytes:result.bytes,basis:result.projection_basis,sql_delta_bytes:validSnapshot.bytes-Buffer.byteLength(validSource27),whole_source29_inverse_sha256:sha(source29),whole_source27_inverse_sha256:sha(source27)}));
 assert.equal(sha(JSON.stringify(canonical(historicalChanges(result.changed_functions)))),'c17e750ff090d52f1c3260bf7536a9349a98746ca9826f588a8c9bc3cf4a9684','all22 full Source24/25 changes unchanged');
 assert.equal(metadataTraversal.source_data_changed,false);assert.equal(metadataTraversal.traversal.new_runtime_functions,0);assert.equal(metadataText.source_data_changed,false);assert.equal(metadataText.native_certification,false);
});

test('compiler transaction sees real core and terminal, then DATA, new ports,22 successors, and final ACL seal',()=>{
 assert.deepEqual(result.stages.slice(0,4).map(s=>s.id),['core210','terminal210','closure-data','closure-ports']);
 assert.equal(result.stages.at(-1).id,'closure-acl');
 assert(stage(result.stages[0]).includes('public.order_merge_delivery209_valid() IS DISTINCT FROM true'));
 assert(stage(result.stages[1]).includes('CREATE FUNCTION public.order_split210_finalize('));
 assert(stage(result.stages[2]).includes('CREATE TABLE public.order_split210_projection_basis('));
 assert(stage(result.stages[3]).includes('CREATE FUNCTION public.order_split210_require()'));
 assert(stage(result.stages.at(-1)).includes('REVOKE ALL ON FUNCTION'));
 for(let i=0;i<22;i++)assert.equal(stage(result.stages[i+4]),result.changed_functions[i].after.definition+';\n','literal full deparser definition retained');
 assert.deepEqual(result.changed_functions.slice(0,4).map(c=>c.key),['public.fa3_draft_fingerprint()','public.b2b_invoice_fingerprint()','public.b2b_credit_fingerprint()','public.wms_row_guard()']);
 assert.deepEqual(result.changed_functions.slice(4,14).map(c=>c.key),sourceBundle.routines.map(sql=>{
  const m=/^CREATE FUNCTION ([^(]+)\(([^)]*)\)/.exec(sql);assert(m);return m[1]+'('+m[2].split(',').map(v=>v.trim()).join(', ')+')';
 }));
 assert.deepEqual(result.changed_functions.slice(14).map(c=>c.key),['public.buyer_address_guards()','public.financial_return_upgrade_valid()','public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)','public.order_merge_delivery209_buyer_guards(manual_basis jsonb)','public.order_merge_delivery209_startup_operative_valid(entries jsonb)','public.ordinary181_financial_valid(manual_basis jsonb)','public.ordinary181_credit_calculate(projection_ok boolean)','public.ordinary180_projection_valid(b jsonb)']);
 assert.equal(result.stages.at(-9).id,'replace:public.buyer_address_guards()');
 assert.equal(result.stages.at(-8).id,'replace:public.financial_return_upgrade_valid()');
 assert.equal(result.stages.at(-7).id,'replace:public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)');
 assert.equal(result.stages.at(-6).id,'replace:public.order_merge_delivery209_buyer_guards(manual_basis jsonb)');
 assert.equal(result.stages.at(-5).id,'replace:public.order_merge_delivery209_startup_operative_valid(entries jsonb)');
 assert.equal(result.stages.at(-4).id,'replace:public.ordinary181_financial_valid(manual_basis jsonb)');
 assert.equal(result.stages.at(-3).id,'replace:public.ordinary181_credit_calculate(projection_ok boolean)');
 assert.equal(result.stages.at(-2).id,'replace:public.ordinary180_projection_valid(b jsonb)');
 assert(result.stages[3].offset<result.stages[4].offset,'SQL-language successors resolve existing private ports');
});

test('all49 routines and8 own tables have unique actual type identities; named209 overloads remain distinct',()=>{
 const inventory=inspectOrderSplit210Declarations(result.sql);
 assert.equal(inventory.functions.length,49);assert.equal(inventory.tables.length,8);
 assert.equal(new Set(inventory.functions.map(f=>f.type_key)).size,49);
 assert.equal(result.new_functions.length,27);assert.equal(result.new_tables.length,8);
 const own=inventory.functions.filter(f=>f.name.startsWith('public.order_split210_'));assert.equal(own.length,27);
 const descriptors=inventory.functions.filter(f=>f.name==='public.order_merge_delivery209_predecessor_descriptor');
 assert.deepEqual(descriptors.map(f=>f.type_key),['public.order_merge_delivery209_predecessor_descriptor(oid)','public.order_merge_delivery209_predecessor_descriptor(oid, jsonb)']);
 assert.deepEqual(result.expected_counts,{stages:27,replacements:22,new_functions:27,new_tables:8,authored_triggers:31,trigger_constraint_pairs:3,foreign_keys:18,ri_triggers:72});
});

test('final ACL binds EXACT27new type identities and8tables, every nonowner default and column grantee; old22 stay outside',()=>{
 const acl=stage(result.stages.at(-1)),final=acl.slice(acl.indexOf('DO $split210_private_acl$'));
 const f=/fn_ids oid\[\]:=ARRAY\[([^;]+)\];/.exec(final),t=/table_ids oid\[\]:=ARRAY\[([^;]+)\];/.exec(final);assert(f&&t);
 const functions=[...f[1].matchAll(/'([^']+)'::regprocedure::oid/g)].map(m=>m[1]);
 const tables=[...t[1].matchAll(/'([^']+)'::regclass::oid/g)].map(m=>m[1]);
 assert.deepEqual(functions,result.new_functions.map(f=>f.type_key));assert.deepEqual(tables,result.new_tables);
 assert.equal(functions.length,27);assert.equal(tables.length,8);
 assert(!final.includes('starts_with('),'no prefix-wide old identity revocation');
 for(const c of result.changed_functions)assert(!functions.some(f=>f.slice(0,f.indexOf('('))===c.key.slice(0,c.key.indexOf('('))));
 assert(final.includes("p.proowner<>'postgres'::regrole"));assert(final.includes("c.relowner<>'postgres'::regrole"));
 assert(final.includes('x.grantee<>o.proowner'));assert.equal(final.split('x.grantee<>o.relowner').length-1,2,'relation+column ACL exclude only genuine owner');
 assert(final.includes('pg_catalog.acldefault(\'f\',o.proowner)'));
 assert(final.includes('pg_catalog.acldefault(\'r\',o.relowner)'));
 assert(final.includes('attribute.attrelid=o.oid AND attribute.attnum>0 AND NOT attribute.attisdropped'));
 assert(final.includes('pg_catalog.aclexplode(attribute.attacl)'),'strict NULL column ACL yields zero rows');
 assert(!final.includes('coalesce(attribute.attacl'),'no zero-dimensional empty ACL array passed to aclexplode');
 assert(final.includes("format('REVOKE ALL (%I) ON TABLE %s FROM %s',a.attname,o.oid::regclass"));
 assert(final.includes("format('REVOKE ALL ON FUNCTION %s FROM %s',o.oid::regprocedure"));
 assert.equal(final.split("CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END").length-1,3,'PUBLIC or safely quoted arbitrary role, including escaped inherited grantees');
 assert(!final.includes('FROM PUBLIC,dyna_app'),'role allowlist cannot leave an inherited third grantee');
});

test('twenty-two successors preserve every literal original header/ACL and exact BEFORE/AFTER body binding',()=>{
 assert.strictEqual(assertOrderSplit210SuccessorHeaders(result.changed_functions),result.changed_functions);
 const head=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));
 for(const c of result.changed_functions)assert.deepEqual(head(c.before),head(c.after));
 const wms=result.changed_functions.find(c=>c.key==='public.wms_row_guard()');
 assert.equal(wms.after.security_definer,false);assert.equal(wms.after.acl_null,true);
 assert(wms.after.definition.includes('\n LANGUAGE plpgsql\nAS $function$'));
 const fp=result.changed_functions.find(c=>c.key==='public.order_merge_delivery209_validation_snapshot()');
 assert.equal(fp.after.volatility,'s');assert.equal(fp.after.security_definer,true);
 assert.deepEqual(fp.after.config,['search_path=pg_catalog, public']);
});

test('financial stage is the actual source-derived sixteenth change after buyer, with its full24 header and whole eight-edit inverse',()=>{
 const financial=deriveOrderSplit210FinancialSuccessor({source204:businessInputs.source204,source210:inputs.source210});
 assert.deepEqual(result.changed_functions[15],financial.change,'no captured AFTER descriptor supplies the stage expectation');
 assert.equal(stage(result.stages[19]),financial.sql);assert.equal(sha(financial.change.before.source),'88144ddbcac918c40b0c2ea8ad5997461388b484a5a740ae220c370477ee38a7');
 assert.equal(Object.keys(financial.change.after).length,24);assert.equal(financial.change.after.volatility,'v');assert.equal(financial.change.after.security_definer,true);
 assert.deepEqual(financial.change.after.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.equal(financial.change.after.acl_null,false);
 let reversed=result.changed_functions[15].after.source;assert.equal(financial.edits.length,8);
 for(const edit of [...financial.edits].reverse()){assert.equal(reversed.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);reversed=reversed.slice(0,edit.afterStart)+edit.before+reversed.slice(edit.afterStart+edit.after.length);}
 assert.equal(reversed,financial.change.before.source);assert.equal(financial.change.after.definition.replace(financial.change.after.source,()=>reversed),financial.change.before.definition);
 assert.equal(financial.native_certification,false);assert.equal(financial.source_compilation_performed,false);
});

test('Source24 shares only two financial statements in operative17 and preserves original209 BEFORE/full24/inverse',()=>{
 const operative=deriveOrderSplit210HistoryFinancialSharing({source210:inputs.source210});
 assert.deepEqual(result.changed_functions[16],operative.change,'fixed literal209 witness supplies the expectation without an extra assembly input');
 assert.equal(stage(result.stages[20]),operative.sql);assert.equal(result.stages[20].id,'replace:public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)');
 assert.equal(sha(operative.change.before.source),'77829cd0bc0a36c9ed55e7bf8c16771dee116a6132410a16b37ef0d4db24a05a');
 assert.equal(Object.keys(operative.change.after).length,24);assert.equal(operative.change.after.volatility,'s');assert.equal(operative.change.after.security_definer,true);assert.equal(operative.change.after.result,'boolean');assert.equal(operative.change.after.arguments,'manual_basis jsonb');
 assert.deepEqual(operative.change.after.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.equal(operative.change.after.acl_null,false);assert.deepEqual(operative.change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
 let reversed=result.changed_functions[16].after.source;assert.equal(operative.edits.length,2);
 for(const edit of [...operative.edits].reverse()){assert.equal(reversed.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);reversed=reversed.slice(0,edit.afterStart)+edit.before+reversed.slice(edit.afterStart+edit.after.length);}
 assert.equal(reversed,operative.source23_change.after.source);
 assert.equal(operative.change.after.definition.replace(operative.change.after.source,()=>reversed),operative.source23_change.after.definition);
 for(const edit of [...operative.original209_edits].reverse()){assert.equal(reversed.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);reversed=reversed.slice(0,edit.afterStart)+edit.before+reversed.slice(edit.afterStart+edit.after.length);}
 assert.equal(reversed,operative.change.before.source);
 assert.deepEqual(operative.sharing,{statements:2,fresh_whole_guards:2,per_statement_bound_oids:2,per_statement_family_keys:2,cross_statement_cache:false,unknown_fallback_preserved:true});
 assert.equal(sha(JSON.stringify(canonical(historicalChanges(result.changed_functions).filter(c=>c.key!==operative.change.key)))),'8c4a8389d48051f7abeb7f75f75682ca9547041ac13b683119d690fd2c17eaae','all other21 full changes equal independently published Source23 VECTOR23');
 assert.equal(sha(JSON.stringify(canonical(operative.change.after))),'194fcd8e5fe06fdb4765d7ec89e92e0d0a2f6fd7757d4d1cc19b1244e83b4687');
 assert.equal(operative.native_certification,false);assert.equal(operative.source_compilation_performed,false);assert.equal(result.complete_seventeen_change_closure,false);
});

test('ownbuyer18 and startupoperative19 are appended as actual source-derived stages, preserving full24 and complete byte inverses',()=>{
 const successors=[deriveOrderSplit210HistoryBuyerSuccessor({source210:inputs.source210}),deriveOrderSplit210StartupOperativeSuccessor({source210:inputs.source210})];
 assert.deepEqual(successors.map(s=>s.change.key),['public.order_merge_delivery209_buyer_guards(manual_basis jsonb)','public.order_merge_delivery209_startup_operative_valid(entries jsonb)']);
 for(const [i,successor]of successors.entries()){
  const change=result.changed_functions[17+i];assert.deepEqual(change,successor.change,'fixed source-authored BEFORE supplies the expectation');assert.equal(stage(result.stages[21+i]),successor.sql);assert.equal(result.stages[21+i].id,'replace:'+change.key);
  assert.equal(Object.keys(change.after).length,24);assert.equal(change.after.volatility,'s');assert.equal(change.after.security_definer,true);assert.equal(change.after.result,'boolean');assert.equal(change.after.owner,'postgres');
  assert.deepEqual(change.after.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.equal(change.after.acl_null,false);assert.deepEqual(change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
  assert.equal(change.after.arguments,i===0?'manual_basis jsonb':'entries jsonb');let reversed=change.after.source;assert.equal(successor.edits.length,i===0?14:16);
  for(const edit of [...successor.edits].reverse()){assert.equal(reversed.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);reversed=reversed.slice(0,edit.afterStart)+edit.before+reversed.slice(edit.afterStart+edit.after.length);}
  assert.equal(reversed,change.before.source);assert.equal(change.after.definition.replace(change.after.source,()=>reversed),change.before.definition);assert.equal(successor.native_certification,false);assert.equal(successor.source_compilation_performed,false);
 }
 assert.deepEqual(successors[0].strict_bound_classifications,{per_statement:[2,2],two_statement_total:4,maximum_per_statement:2,cross_statement_cache:false});
 assert.deepEqual(successors[1].strict_bound_classifications,{per_family:[2,2,5],three_statement_total:9,maximum_per_statement:5,cross_statement_cache:false});
 assert.equal(result.complete_nineteen_change_closure,false);assert.equal(result.complete_seventeen_change_closure,false);assert.equal(result.complete_sixteen_change_closure,false);
});

test('ordinaryfinancial20 remains the twentieth literalSource204 successor with exact family definitions and full24 byte inverse',()=>{
 const ordinary=deriveOrderSplit210OrdinaryFinancialSuccessor({source204:businessInputs.source204,source210:inputs.source210}),change=result.changed_functions[19];
 assert.deepEqual(change,ordinary.change);assert.equal(change.key,'public.ordinary181_financial_valid(manual_basis jsonb)');assert.equal(stage(result.stages[23]),ordinary.sql);assert.equal(result.stages[23].id,'replace:'+change.key);
 assert.equal(Object.keys(change.after).length,24);assert.equal(change.after.volatility,'s');assert.equal(change.after.security_definer,true);assert.equal(change.after.arguments,'manual_basis jsonb');assert.equal(change.after.result,'boolean');assert.deepEqual(change.after.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.equal(change.after.acl_null,false);assert.deepEqual(change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
 assert.equal(sha(change.before.source),'984dd5ab7e4a0312c55c32db348f05f272330f38eec5bf71df41d24eb04917c6');let reversed=change.after.source;assert.equal(ordinary.edits.length,8);
 for(const edit of [...ordinary.edits].reverse()){assert.equal(reversed.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);reversed=reversed.slice(0,edit.afterStart)+edit.before+reversed.slice(edit.afterStart+edit.after.length);}
 assert.equal(reversed,change.before.source);assert.equal(change.after.definition.replace(change.after.source,()=>reversed),change.before.definition);
 assert.equal(ordinary.families.partial204[change.key],ordinary.before204.definition);assert.equal(sha(ordinary.before204.source),'fd006bb71a55d60fcc83feb0fa2e86f4d68064660c3f48e4b44b1d6d7e4f7bc4');assert.equal(ordinary.families.manual169[change.key],change.before.definition);assert.notEqual(ordinary.families.partial204[change.key],ordinary.families.manual169[change.key]);
 assert.deepEqual(ordinary.source_proofs.metadata_signatures,['public.ordinary181_financial_valid(jsonb)','ordinary181_financial_valid(jsonb)']);assert.equal(result.source_inputs.parent209.legacy_function_count,17,'the legacy209 producer roster is independent from21 changed210 routines');
 assert.equal(ordinary.source_compilation_performed,false);assert.equal(ordinary.native_certification,false);assert.equal(result.complete_twenty_change_closure,false);assert.equal(result.complete_nineteen_change_closure,false);
});

test('credit21 is independently authenticated Source189, preserves full24 headers and reverses only its three source-bound edits',()=>{
 const credit=deriveOrderSplit210CreditSuccessor({source210:inputs.source210}),change=result.changed_functions[20];
 assert.deepEqual(change,credit.change);assert.equal(change.key,'public.ordinary181_credit_calculate(projection_ok boolean)');
 assert.equal(stage(result.stages[24]),credit.sql);assert.equal(result.stages[24].id,'replace:'+change.key);
 // The expected BEFORE comes from the authored189 declaration, not the new
 // helper's own constants, a captured catalogue, or a matching current value.
 const literal=read('server/189_packing_required_order_fields.sql');assert.equal(sha(literal),'6f0c071852c68a40c545e3d08fbcb60578bb7b43616439f1d1e8585fb150cbc2');
 const marker='CREATE OR REPLACE FUNCTION '+change.key+'\n',start=literal.indexOf(marker);assert(start>=0);assert.equal(literal.indexOf(marker,start+1),-1);
 const open=literal.indexOf('AS $function$',start)+'AS $function$'.length,end=literal.indexOf('$function$;',open);assert(end>open);
 assert.equal(change.before.source,literal.slice(open,end));assert.equal(change.before.definition,literal.slice(start,end)+'$function$\n');
 assert.equal(Buffer.byteLength(change.before.source),10976);assert.equal(sha(change.before.source),'cd01cc819ad82f1049d7ab3d601eff67d99d5cfce631b4dcb268267c1108176e');
 assert.equal(sha(JSON.stringify(canonical(change.before))),'ee435112e587dc13f430bd6d46f819e21e5a92f33b7a9e59d664b91bd116fef1');
 const original181=read('server/181_same_root_guard_observations.sql');assert(original181.includes('REVOKE ALL ON FUNCTION public.ordinary181_credit_calculate(boolean) FROM PUBLIC,dyna_app;'));
 assert.equal(Object.keys(change.after).length,24);assert.equal(change.after.language,'sql');assert.equal(change.after.result,'text');assert.equal(change.after.arguments,'projection_ok boolean');assert.deepEqual(change.after.argument_names,['projection_ok']);assert.equal(change.after.volatility,'s');assert.equal(change.after.security_definer,true);assert.deepEqual(change.after.config,['search_path=pg_catalog, public']);assert.equal(change.after.acl_null,false);assert.deepEqual(change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
 let reversed=change.after.source;assert.equal(credit.edits.length,3);
 for(const edit of [...credit.edits].reverse()){assert.equal(reversed.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);reversed=reversed.slice(0,edit.afterStart)+edit.before+reversed.slice(edit.afterStart+edit.after.length);}
 assert.equal(reversed,change.before.source);assert.equal(change.after.definition.replace(change.after.source,()=>reversed),change.before.definition);
 const packingTail=change.before.source.slice(change.before.source.indexOf('), projected AS MATERIALIZED ('));assert(change.after.source.endsWith(packingTail),'the whole packing189 inverse, guard and FALSE/NULL result remain literal');
 assert.equal(credit.families.partial204[change.key],change.before.definition);assert.equal(credit.families.manual169[change.key],change.before.definition);
 assert.equal(credit.native_certification,false);assert.equal(credit.source_compilation_performed,false);assert.equal(result.complete_twenty_one_change_closure,false);assert.equal(result.source_inputs.parent209.legacy_function_count,17);
});

test('manualprojection22 stays literal; historical previous21 are preserved through the exact Source24 operative inverse',()=>{
 const manual=deriveOrderSplit210ManualProjectionSuccessor(),change=result.changed_functions[21];
 assert.deepEqual(change,manual.change);assert.equal(change.key,'public.ordinary180_projection_valid(b jsonb)');assert.equal(stage(result.stages[25]),manual.sql);assert.equal(result.stages[25].id,'replace:'+change.key);
 // Independent published VECTOR22 source expectation (gzip9ef39ca6). No
 // catalogue/target metadata supplies this historical full21 regression pin.
 assert.equal(sha(JSON.stringify(canonical(historicalChanges(result.changed_functions).slice(0,21).map((c,i)=>i===16?deriveOrderSplit210HistoryOperativeSuccessor({source210:inputs.source210}).change:c)))),'9baa16dd6c2f94f69c1d2f29bc28a5f67def22aa86e39d33673efa49485883bb');
 assert.equal(Object.keys(change.before).length,24);assert.equal(Object.keys(change.after).length,24);assert.equal(sha(JSON.stringify(canonical(change.before))),'8d586129ef7525342d0a6d2fd208a64b0d024e2634aeeb5613e997f4f8d57b71');
 assert.equal(change.after.language,'plpgsql');assert.equal(change.after.volatility,'s');assert.equal(change.after.security_definer,true);assert.equal(change.after.arguments,'b jsonb');assert.deepEqual(change.after.argument_names,['b']);assert.equal(change.after.result,'boolean');
 assert.deepEqual(change.after.config,['search_path=pg_catalog, public','TimeZone=UTC']);assert.equal(change.after.acl_null,false);assert.deepEqual(change.after.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
 assert.equal(manual.edits.length,1);const e=manual.edits[0],inverse=change.after.source.slice(0,e.afterStart)+e.before+change.after.source.slice(e.afterStart+e.after.length);
 assert.equal(inverse,change.before.source);assert.equal(change.after.definition.replace(change.after.source,()=>inverse),change.before.definition);
 assert(e.after.includes("CASE n WHEN 'b2b_credit_fingerprint' THEN public.order_split210_try_function_projection(oid)->>'source' ELSE prosrc END"));assert(!/coalesce/i.test(e.after));
 assert.equal(manual.source_compilation_performed,false);assert.equal(manual.native_certification,false);assert.equal(result.complete_twenty_two_change_closure,false);assert.equal(result.source_inputs.parent209.legacy_function_count,17);
});

test('duplicate typed identities, table collisions, unsupported schemas and argument grammar refuse',()=>{
 assert.throws(()=>inspectOrderSplit210Declarations('CREATE FUNCTION public.x(a oid) RETURNS text AS $$a$$ LANGUAGE sql; CREATE FUNCTION public.x(b oid) RETURNS text AS $$b$$ LANGUAGE sql;'),/duplicate\/overlapping/);
 assert.throws(()=>inspectOrderSplit210Declarations('CREATE TABLE public.x(id uuid); CREATE TABLE public.x(id uuid);'),/duplicate persistent/);
 assert.throws(()=>inspectOrderSplit210Declarations('CREATE FUNCTION evil.x(a oid) RETURNS text AS $$x$$ LANGUAGE sql;'),/accounted for/);
 assert.throws(()=>inspectOrderSplit210Declarations('CREATE FUNCTION public.x(IN a oid) RETURNS text AS $$x$$ LANGUAGE sql;'),/supported named argument/);
 const distinct=inspectOrderSplit210Declarations('CREATE FUNCTION public.x(a oid) RETURNS text AS $$a$$ LANGUAGE sql; CREATE FUNCTION public.x(b jsonb) RETURNS text AS $$b$$ LANGUAGE sql;');
 assert.equal(distinct.functions.length,2);
});

test('quoted/comment/nested historical SQL never supplies namespace declarations or collisions',()=>{
 const literal="-- CREATE TABLE public.fake(id uuid);\n/* CREATE FUNCTION public.fake() RETURNS text; */\nCREATE FUNCTION public.real(v text) RETURNS text AS $body$BEGIN RETURN 'CREATE FUNCTION public.real(x oid) RETURNS text';END$body$ LANGUAGE plpgsql;\nSELECT 'CREATE TABLE public.real(id uuid)';";
 assert.deepEqual(inspectOrderSplit210Declarations(literal),{functions:[{name:'public.real',key:'public.real(v text)',type_key:'public.real(text)'}],tables:[]});
 assert(result.sql.includes('CREATE TABLE public.order_split210_manifest('));
 assert(!result.new_tables.includes('public.order_merge_delivery209_manifest'),'historical metadata quoted in DATA is not a new relation');
});

test('header,ACL,body,identity,delimiter and incomplete roster tampering cannot masquerade as22 replacement stages',()=>{
 for(const mutate of [c=>c.after.owner='dyna_app',c=>c.after.acl=[],c=>c.after.config=['search_path=public'],c=>c.after.security_definer=false,c=>c.after.arguments='spoof text']){
  const changes=copy(result.changed_functions);mutate(changes[0]);assert.throws(()=>assertOrderSplit210SuccessorHeaders(changes),/header\/ACL/);
 }
 const body=copy(result.changed_functions);body[0].after.source+=' ';assert.throws(()=>assertOrderSplit210SuccessorHeaders(body),/AFTER literal header\/body/);
 const delimiter=copy(result.changed_functions);delimiter[0].after.source+='$function$';assert.throws(()=>assertOrderSplit210SuccessorHeaders(delimiter),/delimiter/);
 const identity=copy(result.changed_functions);identity[0].key='public.spoof()';assert.throws(()=>assertOrderSplit210SuccessorHeaders(identity),/ordered twenty-two/);
 const duplicate=copy(result.changed_functions);duplicate[1]=duplicate[0];assert.throws(()=>assertOrderSplit210SuccessorHeaders(duplicate),/ordered twenty-two/);
 assert.throws(()=>assertOrderSplit210SuccessorHeaders(result.changed_functions.slice(1)),/exact twenty-two/);
 assert.throws(()=>assertOrderSplit210SuccessorHeaders(result.changed_functions.slice(0,15)),/exact twenty-two/,'old15 cannot omit the financial closure');
 assert.throws(()=>assertOrderSplit210SuccessorHeaders(result.changed_functions.slice(0,16)),/exact twenty-two/,'old16 cannot omit the operative closure');
 assert.throws(()=>assertOrderSplit210SuccessorHeaders(result.changed_functions.slice(0,17)),/exact twenty-two/,'old17 cannot omit the ownbuyer and startup closure');
 assert.throws(()=>assertOrderSplit210SuccessorHeaders(result.changed_functions.slice(0,18)),/exact twenty-two/,'old18 cannot omit the startup closure');
 assert.throws(()=>assertOrderSplit210SuccessorHeaders(result.changed_functions.slice(0,19)),/exact twenty-two/,'old19 cannot omit the ordinary financial closure');
 assert.throws(()=>assertOrderSplit210SuccessorHeaders(result.changed_functions.slice(0,20)),/exact twenty-two/,'historical Source21 twenty-change roster cannot omit the credit calculator');
 assert.throws(()=>assertOrderSplit210SuccessorHeaders(result.changed_functions.slice(0,21)),/exact twenty-two/,'historical Source22 cannot omit manual projection22');
 const reversedTail=copy(result.changed_functions);[reversedTail[14],reversedTail[15]]=[reversedTail[15],reversedTail[14]];assert.throws(()=>assertOrderSplit210SuccessorHeaders(reversedTail),/ordered twenty-two/,'buyer precedes financial explicitly');
 const operativeBeforeFinancial=copy(result.changed_functions);[operativeBeforeFinancial[15],operativeBeforeFinancial[16]]=[operativeBeforeFinancial[16],operativeBeforeFinancial[15]];assert.throws(()=>assertOrderSplit210SuccessorHeaders(operativeBeforeFinancial),/ordered twenty-two/,'operative explicitly follows financial');
 const mixedBuyer=copy(result.changed_functions);mixedBuyer[14].after.acl=[...mixedBuyer[14].after.acl,{grantor:'postgres',grantee:'PUBLIC',privilege:'EXECUTE',grantable:false}];
 assert.throws(()=>assertOrderSplit210SuccessorHeaders(mixedBuyer),/header\/ACL/,'fifteenth buyer cannot inherit the four business header policy');
 for(const mutate of [c=>c.after.acl=[],c=>c.after.config=['search_path=public'],c=>c.after.security_definer=false,c=>c.after.volatility='s']){const changes=copy(result.changed_functions);mutate(changes[15]);assert.throws(()=>assertOrderSplit210SuccessorHeaders(changes),/header\/ACL/,'sixteenth financial header and ACL remain independently protected');}
 const financialBody=copy(result.changed_functions);financialBody[15].after.source+=' ';assert.throws(()=>assertOrderSplit210SuccessorHeaders(financialBody),/AFTER literal header\/body/);
 for(const mutate of [c=>c.after.owner='dyna_app',c=>c.after.acl=[],c=>c.after.config=['search_path=public'],c=>c.after.security_definer=false,c=>c.after.volatility='v',c=>c.after.arguments='spoof jsonb']){const changes=copy(result.changed_functions);mutate(changes[16]);assert.throws(()=>assertOrderSplit210SuccessorHeaders(changes),/header\/ACL/,'seventeenth operative header and ACL remain independently protected');}
 const operativeBody=copy(result.changed_functions);operativeBody[16].after.source+=' ';assert.throws(()=>assertOrderSplit210SuccessorHeaders(operativeBody),/AFTER literal header\/body/);
 const swappedLast=copy(result.changed_functions);[swappedLast[17],swappedLast[18]]=[swappedLast[18],swappedLast[17]];assert.throws(()=>assertOrderSplit210SuccessorHeaders(swappedLast),/ordered twenty-two/,'ownbuyer18 must precede startup19');
 for(const index of [17,18]){
  for(const mutate of [c=>c.after.owner='dyna_app',c=>c.after.acl=[],c=>c.after.config=['search_path=public'],c=>c.after.security_definer=false,c=>c.after.volatility='v',c=>c.after.arguments='spoof jsonb']){const changes=copy(result.changed_functions);mutate(changes[index]);assert.throws(()=>assertOrderSplit210SuccessorHeaders(changes),/header\/ACL/,'new own successor preserves every complete header/ACL field');}
  const changes=copy(result.changed_functions);changes[index].after.source+=' ';assert.throws(()=>assertOrderSplit210SuccessorHeaders(changes),/AFTER literal header\/body/);
 }
 const ordinaryBeforeStartup=copy(result.changed_functions);[ordinaryBeforeStartup[18],ordinaryBeforeStartup[19]]=[ordinaryBeforeStartup[19],ordinaryBeforeStartup[18]];assert.throws(()=>assertOrderSplit210SuccessorHeaders(ordinaryBeforeStartup),/ordered twenty-two/,'ordinary financial explicitly follows startup');
 for(const mutate of [c=>c.after.owner='dyna_app',c=>c.after.acl=[],c=>c.after.config=['search_path=public'],c=>c.after.security_definer=false,c=>c.after.volatility='v',c=>c.after.arguments='spoof jsonb']){const changes=copy(result.changed_functions);mutate(changes[19]);assert.throws(()=>assertOrderSplit210SuccessorHeaders(changes),/header\/ACL/,'twentieth public ordinary successor preserves all complete header/ACL fields');}
 const ordinaryBody=copy(result.changed_functions);ordinaryBody[19].after.source+=' ';assert.throws(()=>assertOrderSplit210SuccessorHeaders(ordinaryBody),/AFTER literal header\/body/);
 const creditBeforeOrdinary=copy(result.changed_functions);[creditBeforeOrdinary[19],creditBeforeOrdinary[20]]=[creditBeforeOrdinary[20],creditBeforeOrdinary[19]];assert.throws(()=>assertOrderSplit210SuccessorHeaders(creditBeforeOrdinary),/ordered twenty-two/,'credit21 explicitly follows the retained ordinary20 stage');
 for(const mutate of [c=>c.after.owner='dyna_app',c=>c.after.acl=[],c=>c.after.config=['search_path=public'],c=>c.after.security_definer=false,c=>c.after.volatility='v',c=>c.after.arguments='spoof boolean',c=>c.after.language='plpgsql',c=>c.after.result='boolean']){const changes=copy(result.changed_functions);mutate(changes[20]);assert.throws(()=>assertOrderSplit210SuccessorHeaders(changes),/header\/ACL/,'credit21 preserves the independently authenticated SQL/text/boolean-input header');}
 const creditBody=copy(result.changed_functions);creditBody[20].after.source+=' ';assert.throws(()=>assertOrderSplit210SuccessorHeaders(creditBody),/AFTER literal header\/body/);
 for(const mutate of [c=>c.after.owner='dyna_app',c=>c.after.acl=[],c=>c.after.config=['search_path=pg_catalog, public'],c=>c.after.security_definer=false,c=>c.after.volatility='v',c=>c.after.arguments='b text',c=>c.after.argument_names=['spoof']]){const changes=copy(result.changed_functions);mutate(changes[21]);assert.throws(()=>assertOrderSplit210SuccessorHeaders(changes),/header\/ACL/,'manual22 retains complete UTC/jsonb/owner header');}
 const manualBody=copy(result.changed_functions);manualBody[21].after.source+=' ';assert.throws(()=>assertOrderSplit210SuccessorHeaders(manualBody),/AFTER literal header\/body/);
});

test('any pinned source drift refuses; caller acceptance flags or prebuilt closure cannot authorize assembly',()=>{
 for(const key of ['source210','sourceTerminal','source158','source159','sourceSchema'])assert.throws(()=>assembleOrderSplit210Source({...inputs,[key]:inputs[key]+'\n'}),/literal|source pin/);
 const bundle=copy(sourceBundle);bundle.routines[0]+=' ';assert.throws(()=>assembleOrderSplit210Source({...inputs,sourceBundle:bundle}),/literal source routine pin/);
 const other=assembleOrderSplit210Source({...inputs,closure:{sealed:true},sealed:true,native_certification:true,parent_native_acceptance:true});
 assert.equal(other.sha256,source34Program.sha256);assert.equal(other.parent_native_acceptance,true);assert.equal(other.sealed,false);
 assert.equal(result.source_inputs.parent209.sha256,'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a');
});

test('unsealed program cannot register migration, emit a seal or own transaction; no completion is inferred',()=>{
 const executable=orderSplit210ObserverSpans(result.sql).filter(s=>s.executable).map(s=>s.text).join('');
 assert(!/INSERT\s+INTO\s+public\.order_split210_manifest/i.test(executable));
 assert(!/INSERT\s+INTO\s+(?:public\.)?migrations/i.test(executable));
 assert(!/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i.test(executable));
 assert(!('sealSql' in result));
 for(const key of ['sealed','seal_sql_emitted','source_compilation_performed','full_before_descriptors_compiler_verified','complete_twenty_two_change_closure','complete_twenty_one_change_closure','complete_twenty_change_closure','complete_nineteen_change_closure','complete_seventeen_change_closure','complete_sixteen_change_closure','complete_fifteen_change_closure','native_certification','application_activation','migration_registered'])assert.equal(result[key],false,key);
 assert(result.required_fixed_seal.fields.includes('original209'));assert(result.unresolved_pg_fields.includes('trigger.definition'));
});
