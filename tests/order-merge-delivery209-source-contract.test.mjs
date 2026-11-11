/** Compiled metadata DATA and independent source derivation; no application or DB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as E209,ORDER_MERGE_DELIVERY209_SOURCE_ORIGIN as origin,ORDER_MERGE_DELIVERY209_BUSINESS_SOURCE as business} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {deriveOrderMergeDelivery209Bodies} from '../tools/parity/order-merge-delivery209-source.mjs';
import {deriveOrderMergeDelivery209Predecessor} from '../tools/parity/order-merge-delivery209-predecessor.mjs';
import {assertOrderMergeDelivery209ConstraintChanges} from '../tools/parity/order-merge-delivery209-constraints.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const moduleUrl=new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs',import.meta.url);

test('fixed expectation binds actual SQL and complete independent seventeen-function Source22b derivation',async()=>{
 const source166=await fs.readFile(new URL('../server/166_buyer_address_sidecar.sql',import.meta.url),'utf8');
 const sql=await fs.readFile(new URL('../server/209_order_merge_delivery_inheritance.sql',import.meta.url));
 assert.equal(sha(sql),origin.sql_sha256);assert.equal(sql.length,origin.sql_bytes);
 assert.equal(business,await fs.readFile(new URL('../tools/parity/order-merge-delivery209-business.sql',import.meta.url),'utf8'));
 const changes=deriveOrderMergeDelivery209Bodies({source166});
 const source204=await fs.readFile(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
 const source181=await fs.readFile(new URL('../server/181_same_root_guard_observations.sql',import.meta.url),'utf8');
 const source168=await fs.readFile(new URL('../server/168_physical_parcel_wz.sql',import.meta.url),'utf8');
 const predecessor=deriveOrderMergeDelivery209Predecessor({changes,source166,source204,source181,source168,runtimeRevision:22});
 const byKey=rows=>Object.fromEntries(rows.map(r=>[r.key,r]));
 assert.deepEqual(byKey(E209.changes.filter(r=>r.kind==='function')),byKey([...changes,...predecessor.changes]));
 assert.equal(assertOrderMergeDelivery209ConstraintChanges(E209.changes.filter(r=>r.kind==='constraint')),true);
 assert.equal(E209.additions.length,259);assert.equal(E209.changes.length,21);assert.deepEqual(E209.removed,[]);
 assert.equal(sha(JSON.stringify(E209)),origin.decoded_sha256);
});

test('compiled data is immutable and has exactly nineteen raw-derived columns and checks',()=>{
 const names=['projection_keys','projection_checks',...Array.from({length:17},(_,i)=>'before_'+i)];
 for(const name of names){
  const column=E209.additions.find(r=>r.kind==='column'&&r.key==='public.order_merge_delivery209_projection_basis.'+name);
  assert(column);assert.equal(column.value.generated,'s');assert.equal(column.value.type,'jsonb');assert(Object.isFrozen(column.value));
  const suffix=name==='projection_keys'?'keys':name==='projection_checks'?'checks':name;
  const check=E209.additions.find(r=>r.kind==='constraint'&&r.key==='public.order_merge_delivery209_projection_basis.order_merge_delivery209_'+suffix+'_source');
  assert(check);assert.equal(check.value.validated,true);assert(check.value.definition.includes('payload::jsonb'));
 }
 assert(Object.isFrozen(E209)&&Object.isFrozen(E209.changes)&&Object.isFrozen(origin.native_qa));
 assert.throws(()=>{E209.changes[0].after.source='forged';},TypeError);
});

test('actual module rejects changed encoded DATA before publishing a contract',async()=>{
 const source=await fs.readFile(moduleUrl,'utf8');
 const changed=source.replace(/const encoded=Buffer.from\('([A-Za-z0-9+/=])/,(_m,c)=>"const encoded=Buffer.from('"+(c==='A'?'B':'A'));
 assert.notEqual(changed,source);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dyna-e209-contract-'));
 try{const file=path.join(dir,'corrupted.mjs');await fs.writeFile(file,changed);await assert.rejects(import(pathToFileURL(file)),e=>e.code==='ERR_ASSERTION');}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('actual decoder enforces its finite output bound before parsing metadata',async()=>{
 const source=await fs.readFile(moduleUrl,'utf8');
 const changed=source.replace('maxOutputLength:'+origin.decoded_bytes,'maxOutputLength:'+(origin.decoded_bytes-1));assert.notEqual(changed,source);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dyna-e209-bound-'));
 try{const file=path.join(dir,'bounded.mjs');await fs.writeFile(file,changed);await assert.rejects(import(pathToFileURL(file)),e=>e.code==='ERR_BUFFER_TOO_LARGE');}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});


test('reviewed Source22b scope binds Native54, cold capabilities and thirteen private helpers without product admission',()=>{
 assert.equal(origin.schema,'source209-native22b-metadata-expectation-origin/v1');assert.equal(origin.runtime_revision,22);
 assert.deepEqual(origin.native_qa,{tests:54,pass:54,fail:0,skipped:0,cancelled:0});
 assert.deepEqual(origin.full_runtime_preflight,{ordinary187_valid:true,large_import173_valid:true});
 assert.equal(origin.post_qa_exact_readback,true);assert.equal(origin.old_certificate_tables,28);
 assert.equal(origin.compiler_receipt_sha256,'9942cd0f31631af320c535b424a0c41ee7a3ad912faba64a964b44da8d0f5989');
 assert.equal(origin.root_review_sha256,'c3083fdf081056ef7085cae2423ecfa7233d37722769a9dfe32b37e2326737c1');
 const cold={pim_dictionary_valid:true,nested172_valid:true,parcel_physical_wz_valid:true,operative_delivery_valid:true};
 assert.deepEqual(origin.cold_capabilities_before_commit,cold);assert.deepEqual(origin.cold_capabilities_after_qa,cold);
 assert.equal(origin.decoded_sha256,'121abfe5df79f03f9d3acd38e566bbcf53c18ec0b4bf418c316632138cd37070');
 const helpers=['buyer_guards','history_operative_valid','history_parents_valid','history_pim_valid','history_predecessor_project','predecessor_source_sha','validation_snapshot','wave_valid','startup_operative_valid','pim_operative_valid','pim_packed_guards','pim_parcel_valid','pim_issuer_guards'];
 for(const name of helpers){
  const rows=E209.additions.filter(r=>r.kind==='function'&&r.key.startsWith('public.order_merge_delivery209_'+name+'('));
  assert.equal(rows.length,1,name);assert.equal(rows[0].value.owner,'postgres');
  assert.deepEqual(rows[0].value.acl,[{grantee:'postgres',grantor:'postgres',privilege:'EXECUTE',grantable:false}]);
 }
 assert.match(origin.boundary,/Existing-data upgrade, application READY, IAM and UI\/API business acceptance are separate/);
});
