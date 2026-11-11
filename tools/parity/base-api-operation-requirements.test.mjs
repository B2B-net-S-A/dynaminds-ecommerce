/** Actual retained-source proposal and hostile FILE linkage cases; no IO beyond
 * reading the checked-in fixtures, no HTTP/SQL, no scope output or execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {deriveBaseApiOperationProposal,BASE_API_OPERATION_REFERENCES as REFS,BASE_API_OPERATION_LIMITS as LIMITS} from './base-api-operation-requirements.mjs';
import {readRetainedRevision} from './base-api-retained-revisions.mjs';
import {baseCaptureSkip} from './base-captures.mjs';

const D = fileURLToPath(new URL('../../',import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const traceBytes = await fs.readFile(D+REFS.traceability.path), trace = JSON.parse(traceBytes);
const paths = [...new Set([...Object.values(REFS),...trace.source_bundles,...trace.contract_documents].map(ref=>ref.path))];
const skip=baseCaptureSkip(paths);
if(skip)test('operation proposal is re-derived from the retained Base.com sources',{skip},()=>{});
else{
// Dated registry pins name exact FILE revisions; superseded ones come from their retained copy.
const files = Object.fromEntries(paths.map(name=>[name,readRetainedRevision(D,name)]));
const snapshot = new Map(Object.entries(files).map(([name,bytes])=>[name,sha(bytes)]));
const references = structuredClone(REFS);
function reauthoredTrace(mutate) {
  const changed = structuredClone(trace); mutate(changed);
  const bytes = Buffer.from(JSON.stringify(changed)+'\n');
  return {files:{...files,[REFS.traceability.path]:bytes},references:{...references,traceability:{path:REFS.traceability.path,bytes:bytes.length,sha256:sha(bytes)}}};
}

test('whole204 retained-index bijection preserves dates, contract representations and unchanged v5 denominator with no acceptance', async()=>{
  const parent = JSON.parse(files[REFS.parentScope.path]), index = JSON.parse(files[REFS.index.path]);
  const proposal = deriveBaseApiOperationProposal({files});
  assert.equal(proposal.rows.length,204); assert.equal(new Set(proposal.rows.map(row=>row.id)).size,204);
  assert.deepEqual(proposal.rows.map(row=>[row.id,row.method,row.family,row.group]),index.methods.map(row=>[row.id,row.method,row.family,row.group]));
  assert.equal(proposal.summary.groups,41); assert.equal(Object.keys(proposal.summary.families).length,7);
  assert.deepEqual(proposal.summary.detail_observation_dates,{'2026-10-17':111,'2026-10-18':93});
  assert.deepEqual(proposal.summary.contract_formats,{structured_json:134,markdown_tables_and_prose:70});
  assert.equal(proposal.parent_scope.requirements,2589); assert.equal(proposal.parent_scope.open_gaps,33);
  assert.deepEqual(proposal.parent_scope.inputs,parent.inputs);
  assert.equal(proposal.parent_scope.requirements_sha256,sha(Buffer.from(JSON.stringify(parent.requirements))));
  for(const key of ['scope_mutated','scope_complete','coverage_complete','full_contract_inventory_complete','implementation_coverage_measured','acceptance_granted','full_goal_complete'])assert.equal(proposal[key],false,key);
  for(const [i,row] of proposal.rows.entries()) {
    assert.equal(row.status,'unverified'); assert.equal(row.operational_contract_fully_resolved,'UNKNOWN');
    assert.equal(row.required_evidence_level,null); assert.equal(row.evidence_level_resolution,'REQUIRES_REVIEW_BEFORE_SCOPE_ADMISSION');
    assert.deepEqual(row.evidence,{code:[],local:[],sandbox:[],account:[]});
    assert.equal(row.implementation_verified,false); assert.equal(row.wire_verified,false); assert.equal(row.provider_account_verified,false); assert.equal(row.acceptance_granted,false);
    assert.equal(row.acceptance_requirements.status,'NOT_RUN');
    assert.deepEqual(row.source,trace.methods[i].source); assert.deepEqual(row.contract,trace.methods[i].contract);
  }
  const crm = proposal.rows.find(row=>row.method==='addCrmClient');
  assert.equal(crm.source.http_status,null); assert.equal(crm.source.http_status_recorded,false);
  assert.equal(crm.source.final_url,null); assert.equal(crm.source.final_url_recorded,false);
  assert(Buffer.byteLength(JSON.stringify(proposal,null,2)+'\n')<=LIMITS.output_bytes);
  for(const [name,digest] of snapshot)assert.equal(sha(files[name]),digest,'input bytes remain unchanged');
  assert.deepEqual(await fs.readFile(D+REFS.parentScope.path),files[REFS.parentScope.path]);
});

test('rehashed trace cannot omit, duplicate or substitute members of the independently retained204-method index',()=>{
  for(const mutate of [
    t=>t.methods.pop(),
    t=>{t.methods[203]=structuredClone(t.methods[0]);},
    t=>{t.methods[203].method='unknownInventedMethod';},
    t=>{t.methods[0].index_family='Clients (CRM)';},
    t=>{t.methods[0].index_group='Invented group';},
  ])assert.throws(()=>deriveBaseApiOperationProposal(reauthoredTrace(mutate)));
});

test('method contracts and source bodies need exact ownership pointers, whole bytes and declared source documents',()=>{
  const jsonRow=trace.methods.findIndex(row=>row.contract.format==='structured_json');
  const markdownRow=trace.methods.findIndex(row=>row.contract.format==='markdown_tables_and_prose');
  for(const mutate of [
    t=>{t.methods[jsonRow].contract.json_pointer='/methods/1';},
    t=>{t.methods[jsonRow].source.html_pointer='/documents/1/html_utf8';},
    t=>{t.methods[jsonRow].source.html_sha256='0'.repeat(64);},
    t=>{t.methods[markdownRow].contract.line++;},
    t=>{t.methods[markdownRow].contract.section_sha256='0'.repeat(64);},
    t=>{t.methods[jsonRow].source.bundle='docs/parity/not-declared.json.gz';},
    t=>{t.methods[jsonRow].contract.json_pointer='/__proto__/method';},
  ])assert.throws(()=>deriveBaseApiOperationProposal(reauthoredTrace(mutate)));
});

test('later18.10 detail observations never become historical17.10 evidence or inferredHTTP200',()=>{
  const later=trace.methods.findIndex(row=>row.source.capture_date==='2026-10-18');
  for(const mutate of [
    t=>{t.methods[later].source.capture_date='2026-10-17';},
    t=>{t.methods[later].source.retrieved_at='2026-10-17T00:00:00Z';t.methods[later].source.capture_date='2026-10-17';t.methods[later].source.relation_to_20261017_index='same_day_individual_capture';},
    t=>{t.methods[later].source.relation_to_20261017_index='same_day_individual_capture';},
  ])assert.throws(()=>deriveBaseApiOperationProposal(reauthoredTrace(mutate)));
  const reclassified=reauthoredTrace(t=>{for(const row of t.methods){row.implementation.verified=true;row.wire.verified=true;row.provider_account.verified=true;row.acceptance_granted=true;}});
  const proposal=deriveBaseApiOperationProposal(reclassified);
  assert(proposal.rows.every(row=>!row.implementation_verified&&!row.wire_verified&&!row.provider_account_verified&&!row.acceptance_granted));
  assert.equal(proposal.acceptance_granted,false,'A supplied trace cannot grant product acceptance');
});

test('pinned source digests, canonical paths, closed file roster and8MiB bounds fail closed',async()=>{
  // 1702ad9 rewrote the live orders contracts; the dated trace still pins (and refuses anything but) the 715f03c bytes.
  const orders='docs/parity/base-api-orders-contracts.v1.json',live=await fs.readFile(D+orders);
  assert.notDeepEqual(live,files[orders]);
  assert.throws(()=>deriveBaseApiOperationProposal({files:{...files,[orders]:live}}),/source size/);
  const changed=Buffer.from(files[REFS.index.path]);changed[0]^=1;
  assert.throws(()=>deriveBaseApiOperationProposal({files:{...files,[REFS.index.path]:changed}}),/source digest/);
  const missing={...files};delete missing[trace.source_bundles[0].path];
  assert.throws(()=>deriveBaseApiOperationProposal({files:missing}),/missing source/);
  assert.throws(()=>deriveBaseApiOperationProposal({files:{...files,'docs/parity/unrequested.json':Buffer.from('{}')}}),/closed input roster/);
  for(const name of ['../secret.json','/absolute.json','docs/parity/../scope.v5.json','docs/parity//alias.json'])
    assert.throws(()=>deriveBaseApiOperationProposal({files,references:{...references,traceability:{...references.traceability,path:name}}}),/canonical public source path/);
  assert.throws(()=>deriveBaseApiOperationProposal({files:{...files,'oversized':Buffer.alloc(LIMITS.member_bytes+1)}}),/8MiB member bound/);
  const accessors={...files};Object.defineProperty(accessors,REFS.index.path,{enumerable:true,get(){assert.fail('Accessor source bytes must not run');}});
  assert.throws(()=>deriveBaseApiOperationProposal({files:accessors}),/owned source data bytes/);
});

test('rehashed trace cannot invent missing CRM HTTP/finalURL observations or relabel retrieval as publication',()=>{
  const crm=trace.methods.findIndex(row=>row.method==='addCrmClient');
  const observed=trace.methods.findIndex(row=>row.source.http_status_recorded===true);
  for(const mutate of [
    t=>{t.methods[crm].source.http_status=200;t.methods[crm].source.http_status_recorded=true;},
    t=>{t.methods[crm].source.final_url=t.methods[crm].source.url;t.methods[crm].source.final_url_recorded=true;},
    t=>{t.methods[crm].source.http_status_recorded=true;},
    t=>{t.methods[observed].source.http_status_recorded=false;},
    t=>{t.methods[observed].source.http_status=201;},
    t=>{t.methods[crm].source.date_meaning='publication';},
  ])assert.throws(()=>deriveBaseApiOperationProposal(reauthoredTrace(mutate)));
});
}
