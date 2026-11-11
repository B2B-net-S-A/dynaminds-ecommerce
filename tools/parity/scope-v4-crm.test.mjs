/** File-only regression of the actual retained CRM scope successor; no app or evidence execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {createScopeSnapshot} from './scope-freeze.mjs';
import {checkInventories} from './check.mjs';
import {baseCaptureSkip} from './base-captures.mjs';
const D=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,''),root=path.resolve(D,'../..');
const read=async p=>JSON.parse(await fs.readFile(p));
const sha=b=>createHash('sha256').update(b).digest('hex');
const parent=await read(D+'/docs/parity/scope.v3.json'),currentBytes=await fs.readFile(D+'/docs/parity/scope.v4.json'),current=JSON.parse(currentBytes);
const request={goal:current.goal,version:4,snapshot_kind:'partial',inputs:current.inputs,parent:current.parent,catalogue_inventory_version:1,evidence_archive:current.evidence_archive};
const successor=await read(D+'/docs/parity/scope.v5.json');
// V4 remains pinned history. Only FILE storage resolution is borrowed from its
// append-only successor; no v5 requirement, status or acceptance substitutes v4.
// Files that drifted after v5 are retained by the archive named in revalidation.json
// (docs/parity/scope-inputs/v6/README.md), which keeps every v5 row verbatim.
const revalidation=(await read(D+'/docs/parity/evidence-archives/revalidation.json')).archive;
const revalidationWithSuccessorStorage={...request,evidence_archive:revalidation};
// The v4 archive plus only the rows retained after v5: the historical refusal list stays exact.
async function v4StorageWithLaterDrift(work){
 const old=await read(current.evidence_archive.path),v5=await read(successor.evidence_archive.path),next=await read(revalidation.path);
 const later=next.entries.filter(row=>!v5.entries.some(x=>JSON.stringify(x)===JSON.stringify(row)));
 const dir=await fs.mkdtemp(root+'/local-builds/full-base-preview-20261017/scope-v4-crm-test-');
 try{const bytes=Buffer.from(JSON.stringify({...old,entries:[...old.entries,...later]},null,2)+'\n'),p=dir+'/archive.json';await fs.writeFile(p,bytes,{flag:'wx',mode:0o600});await work({path:p,bytes:bytes.length,sha256:sha(bytes)});}
 finally{await fs.rm(dir,{recursive:true,force:true});}
}
const frozen=await read(D+'/docs/parity/scope-inputs/v2/domains.json'),domains=await read(current.inputs.domains.path);
const ids=['DOM-CRM-001','DOM-CRM-002','DOM-CRM-003','DOM-CRM-004'];
async function changedInput(name,mutate,work){
 const dir=await fs.mkdtemp(root+'/local-builds/full-base-preview-20261017/scope-v4-crm-test-');
 try{const doc=await read(current.inputs[name].path);mutate(doc);const bytes=Buffer.from(JSON.stringify(doc)+'\n'),p=dir+'/input.json';await fs.writeFile(p,bytes,{flag:'wx',mode:0o600});await work({...revalidationWithSuccessorStorage,inputs:{...request.inputs,[name]:{path:p,sha256:sha(bytes),bytes:bytes.length}}});}
 finally{await fs.rm(dir,{recursive:true,force:true});}
}
test('v4 retains all2585 complete prior records and all135 frozen domain rows; only four CRM rows are added OPEN',async()=>{
 assert.equal(currentBytes.length,2305362);assert.equal(sha(currentBytes),'e8ff03993638cc96afe5eebbababf89454392e524c0b93e9addb07899093e5dd');
 assert.equal(parent.requirements.length,2585);assert.equal(current.requirements.length,2589);assert.equal(domains.rows.length,139);
 const byKey=new Map(current.requirements.map(r=>[r.key,r]));for(const old of parent.requirements)assert.deepEqual(byKey.get(old.key),old);
 assert.deepEqual(current.changes,{added:ids.map(id=>'domains:operation:'+id),removed:[]});
 assert.deepEqual(domains.rows.slice(0,135),frozen.rows);assert.deepEqual(domains.coverage_gaps,frozen.coverage_gaps);
 assert.deepEqual(Object.keys(current.required_ids),Object.keys(parent.required_ids));
 assert.deepEqual(current.catalogue_inventory,parent.catalogue_inventory);
 for(const id of ids){const r=domains.rows.find(r=>r.id===id);assert.equal(r.status,'unverified');assert.equal(r.acceptance_state,'OPEN');assert.equal(r.required_evidence_level,'local');for(const refs of Object.values(r.evidence))assert.deepEqual(refs,[]);}
 assert.equal(sha(await fs.readFile(D+'/docs/parity/scope-inputs/v4/crm-client-profile.addition.v1.json')),'8ada912bb747113c7dfd8be293db4535d5eb3c9283c803965b712f2b06acbf68');
});
test('pinned v4 contract revalidates through explicit append-only successor storage without rewriting history',async()=>{
 assert.deepEqual(successor.parent,{path:D+'/docs/parity/scope.v4.json',bytes:currentBytes.length,sha256:sha(currentBytes)});
 assert.deepEqual(successor.requirements,current.requirements);assert.deepEqual(successor.inputs,current.inputs);
 const oldArchive=await read(current.evidence_archive.path),nextArchive=await read(successor.evidence_archive.path);
 assert.equal(oldArchive.entries.length,9);assert.equal(nextArchive.entries.length,10);
 for(const row of oldArchive.entries)assert(nextArchive.entries.some(next=>JSON.stringify(next)===JSON.stringify(row)));
 const storage=await read(revalidation.path);for(const row of nextArchive.entries)assert(storage.entries.some(next=>JSON.stringify(next)===JSON.stringify(row)));
 await assert.rejects(createScopeSnapshot(request,{root}),e=>e.code==='INVENTORY_INVALID','The old archive does not resolve current CODE drift');
 assert.deepEqual(await createScopeSnapshot(revalidationWithSuccessorStorage,{root}),{...current,evidence_archive:revalidation});
 assert.deepEqual(await fs.readFile(D+'/docs/parity/scope.v4.json'),currentBytes);
 assert.equal(current.snapshot_kind,'partial');assert.equal(current.scope_complete,false);assert.equal(current.acceptance_granted,false);assert.equal(current.inventory_mutated,false);
});
test('inventories pass file checking while complete/acceptance remains refused',async()=>{
 const inputs=[{name:'domains',document:domains},{name:'integrations',document:await read(current.inputs.integrations.path)}];
 assert.equal((await checkInventories(inputs,{root,evidenceArchive:current.evidence_archive})).valid,false);
 await v4StorageWithLaterDrift(async storage=>{const historical=await checkInventories(inputs,{root,evidenceArchive:storage});assert.equal(historical.valid,false);
 assert.deepEqual(historical.errors.map(e=>e.where).sort(),['integration.mirakl.orders.stage','integration.mirakl.orders.import','integration.mirakl.products.link.sku'].map(id=>'integrations:'+id+':code').sort());});
 const checked=await checkInventories(inputs,{root,evidenceArchive:revalidation});assert.equal(checked.valid,true);assert.equal(checked.acceptance_granted_by_checker,false);assert.equal(checked.completion_review_candidate,false);
 const complete=await checkInventories(inputs,{root,evidenceArchive:revalidation,requireComplete:true});assert.equal(complete.valid,false);
 await assert.rejects(createScopeSnapshot({...revalidationWithSuccessorStorage,snapshot_kind:'complete'},{root}),e=>e.code==='SCOPE_STILL_PARTIAL');
});
test('all11 genuine retained HTML bodies map to CRM requirements with exact source pins; ambiguities remain visible',{skip:baseCaptureSkip(['docs/parity/base-api-client-sources-20261017.json.gz'])},async()=>{
 const contract=await read(D+'/docs/parity/base-api-client-contracts.v1.json');
 const bundle=JSON.parse(gunzipSync(await fs.readFile(D+'/docs/parity/base-api-client-sources-20261017.json.gz')));
 const rows=domains.rows.slice(135),seen=new Set();assert.equal(contract.methods.length,11);
 for(const m of contract.methods){const doc=bundle.documents.find(d=>d.method===m.method);const b=Buffer.from(doc.html_utf8);assert.equal(b.length,m.source.bytes);assert.equal(sha(b),m.source.sha256);assert(doc.retrieved_at.startsWith('2026-10-17'));
  const links=rows.flatMap(r=>r.base_sources).filter(s=>s.method===m.method);assert(links.length>0);for(const s of links){assert.equal(s.html_utf8_bytes,b.length);assert.equal(s.html_utf8_sha256,sha(b));}seen.add(m.method);
 }
 assert.equal(seen.size,11);const status=rows.find(r=>r.id==='DOM-CRM-002');assert(status.operations.some(s=>s.includes('na końcu listy statusów we własnej grupie')));assert(bundle.documents.find(d=>d.method==='addCrmClientStatus').html_utf8.includes('A new status is appended at the end of the status list within its group.'));const fields=rows.find(r=>r.id==='DOM-CRM-004');assert(fields.acceptance.some(a=>a.includes('serializacja')));
 const extra=contract.methods.find(m=>m.method==='getCrmClientExtraFields');assert.deepEqual(extra.output.fields.find(f=>f.path.endsWith('editor_type')).documented_values,['text','number','select','checkbox','radio','date','file']);
 const proposal=await read(D+'/docs/parity/scope-inputs/v4/crm-extra-fields.addition.v1.json');assert.equal(proposal.scope_complete,false);assert.equal(proposal.acceptance_granted,false);assert.equal(proposal.unresolved_wire_contracts.length,4);
});
test('retained archive preserves all eight old mappings and adds only the exact historical runtime blob',async()=>{
 const old=await read(parent.evidence_archive.path),next=await read(current.evidence_archive.path);assert.equal(next.entries.length,old.entries.length+1);
 for(const r of old.entries)assert(next.entries.some(x=>JSON.stringify(x)===JSON.stringify(r)));
 const added=next.entries.filter(x=>!old.entries.some(y=>JSON.stringify(x)===JSON.stringify(y)));assert.equal(added.length,1);const r=added[0];assert.equal(r.source.object,'103108883e4787c25187ec3c22b03944b939d81d');
 assert.equal(sha(await fs.readFile(r.retained_ref.path)),'9f900fe402966df6d6864d2840a1f7ca6bc002e0ef64d8fc2e1a6ef105c43ce9');assert.equal(r.original_ref.bytes,20676);
});
test('real successor path refuses old requirement edits, missing rows and acceptance-level downgrades',async()=>{
 await changedInput('domains',d=>{d.rows[0].requirement+=' changed normative contract';},async q=>assert.rejects(createScopeSnapshot(q,{root}),e=>e.code==='REQUIRED_REDEFINED'));
 await changedInput('domains',d=>{d.rows.shift();},async q=>assert.rejects(createScopeSnapshot(q,{root}),e=>e.code==='REQUIRED_REMOVED'));
 const target=parent.requirements.find(r=>r.source==='integrations'&&r.kind==='operation'&&r.required_evidence_level==='account');assert(target);
 await changedInput('integrations',d=>{d.rows.find(r=>r.id===target.id).required_evidence_level='local';},async q=>assert.rejects(createScopeSnapshot(q,{root}),e=>e.code==='REQUIRED_LEVEL_DOWNGRADE'));
});
