/** Pure retained-file discovery proposal. No filesystem, network, executable
 * HTML, scope mutation, generated business validators or acceptance authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';
import {parseBaseApiIndex} from './base-api-index.mjs';

export const BASE_API_OPERATION_LIMITS = Object.freeze({
  member_bytes: 8 * 1024 * 1024, input_bytes: 16 * 1024 * 1024,
  decoded_bundle_bytes: 8 * 1024 * 1024, decoded_total_bytes: 32 * 1024 * 1024,
  output_bytes: 8 * 1024 * 1024,
});
export const BASE_API_OPERATION_REFERENCES = Object.freeze({
  indexHtml: Object.freeze({path:'docs/parity/base-api-index-20261017.html.gz',bytes:19521,sha256:'e393496b7277f06e5f49cb81b26acc7f0ea9c65c715f31c439ad2b72ae1a7f3d'}),
  index: Object.freeze({path:'docs/parity/base-api-methods.v1.json',bytes:85076,sha256:'7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992'}),
  traceability: Object.freeze({path:'docs/parity/base-api-contract-traceability-20261018.json',bytes:721919,sha256:'7dea2ac8274f87888a70cdf8c77f03cf0ac97759f8eb0d177b88704371bd0cb9'}),
  parentScope: Object.freeze({path:'docs/parity/scope.v5.json',bytes:2305202,sha256:'be41647bb854567524ef236166225961f52b5e028f7a98552a716b4750b6aca3'}),
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = bytes => new TextDecoder('utf8', {fatal:true}).decode(bytes);
const json = bytes => JSON.parse(decode(bytes));
const exact = (value, keys) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'exact field set required');
};
function reference(ref) {
  exact(ref, ['path','bytes','sha256']);
  assert(typeof ref.path === 'string' && /^docs\/parity\/[A-Za-z0-9_./-]+$/.test(ref.path)
    && !ref.path.split('/').includes('..') && path.posix.normalize(ref.path) === ref.path, 'canonical public source path');
  assert(Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= BASE_API_OPERATION_LIMITS.member_bytes, '8MiB source bound');
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  return structuredClone(ref);
}
function pointer(value, location) {
  assert(typeof location === 'string' && location.startsWith('/') && location.length <= 240, 'bounded JSON pointer');
  for (const token of location.slice(1).split('/')) {
    assert(!/~(?![01])/.test(token), 'JSON pointer escape');
    const key = token.replaceAll('~1','/').replaceAll('~0','~');
    assert(value !== null && typeof value === 'object' && Object.hasOwn(value,key), 'existing own JSON pointer');
    value = value[key];
  }
  return value;
}
function markdownSection(bytes, contract, method) {
  assert.equal(contract.heading, method);
  assert.equal(contract.anchor, '#' + method.toLowerCase());
  const lines = decode(bytes).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  assert(Number.isSafeInteger(contract.line) && contract.line >= 1 && contract.line <= lines.length, 'Markdown line');
  const start = contract.line - 1;
  const heading = /^(#{1,6}) (.*?)\r?\n?$/.exec(lines[start]);
  assert(heading && heading[2] === method, 'exact Markdown method heading');
  let end = start + 1;
  while (end < lines.length) {
    const next = /^(#{1,6}) /.exec(lines[end]);
    if (next && next[1].length <= heading[1].length) break;
    end++;
  }
  assert.equal(sha(Buffer.from(lines.slice(start,end).join(''))), contract.section_sha256, 'whole Markdown section pin');
}

/** `references` selects explicit FILE revisions, not authority. The index and
 * parent remain the literal frozen17.10/v5 cuts; a rehashed trace is still checked
 * against all actual index members, HTML bodies and contract locations. */
export function deriveBaseApiOperationProposal({files, references = BASE_API_OPERATION_REFERENCES}) {
  exact(references, ['indexHtml','index','traceability','parentScope']);
  assert(files && typeof files === 'object' && !Array.isArray(files), 'source byte map required');
  const descriptors = Object.getOwnPropertyDescriptors(files), owned = new Map();
  let inputBytes = 0, decodedBytes = 0;
  for (const [name, descriptor] of Object.entries(descriptors)) {
    assert(Object.hasOwn(descriptor,'value') && descriptor.value instanceof Uint8Array, 'owned source data bytes');
    const value = Buffer.from(descriptor.value);
    assert(value.length > 0 && value.length <= BASE_API_OPERATION_LIMITS.member_bytes, '8MiB member bound');
    inputBytes += value.length; assert(inputBytes <= BASE_API_OPERATION_LIMITS.input_bytes, 'aggregate input bound');
    owned.set(name,value);
  }
  const refs = Object.fromEntries(Object.entries(references).map(([name,ref]) => [name,reference(ref)]));
  for (const name of ['indexHtml','index','parentScope']) assert.deepEqual(refs[name], BASE_API_OPERATION_REFERENCES[name], 'frozen index/v5 reference');
  const used = new Set();
  function pinned(ref) {
    reference(ref); const bytes = owned.get(ref.path); assert(bytes, 'missing source ' + ref.path);
    assert.equal(bytes.length,ref.bytes,'source size'); assert.equal(sha(bytes),ref.sha256,'source digest');
    used.add(ref.path); return bytes;
  }
  const html = gunzipSync(pinned(refs.indexHtml), {maxOutputLength:2 * 1024 * 1024});
  const index = json(pinned(refs.index)), parsed = parseBaseApiIndex(html);
  assert.deepEqual(parsed,index,'whole frozen index rederivation');
  assert.equal(index.methods.length,204);
  const parent = json(pinned(refs.parentScope));
  assert.equal(parent.version,5); assert.equal(parent.requirements.length,2589);
  assert.equal(parent.scope_complete,false); assert.equal(parent.acceptance_granted,false);
  const gaps = parent.requirements.filter(row => row.kind === 'gap');
  assert.equal(gaps.length,33); assert(gaps.every(row => row.state === 'open'));
  const trace = json(pinned(refs.traceability));
  assert.equal(trace.schema,'dynaminds-base-api-contract-traceability/v1');
  assert.deepEqual(trace.index,refs.index); assert.equal(trace.index_methods,204);
  assert.equal(trace.methods.length,204);
  const bundles = new Map(), contracts = new Map(), sourceRefs = new Map();
  for (const ref of [...trace.source_bundles,...trace.contract_documents]) {
    reference(ref); assert(!sourceRefs.has(ref.path),'unique declared document');
    sourceRefs.set(ref.path,ref); pinned(ref);
  }
  assert.equal(trace.source_bundles.length,15);
  for (const ref of trace.source_bundles) {
    const bytes = gunzipSync(pinned(ref), {maxOutputLength:BASE_API_OPERATION_LIMITS.decoded_bundle_bytes});
    decodedBytes += bytes.length; assert(decodedBytes <= BASE_API_OPERATION_LIMITS.decoded_total_bytes,'decoded aggregate bound');
    bundles.set(ref.path,json(bytes));
  }
  for (const ref of trace.contract_documents) contracts.set(ref.path,ref.path.endsWith('.json') ? json(pinned(ref)) : pinned(ref));
  const methods = new Map(), dates = {'2026-10-17':0,'2026-10-18':0}, formats = {structured_json:0,markdown_tables_and_prose:0};
  for (let i = 0; i < trace.methods.length; i++) {
    const row = trace.methods[i]; assert(!methods.has(row.method),'duplicate trace method');
    methods.set(row.method,{row,position:i});
  }
  const rows = index.methods.map((entry,indexPosition) => {
    const found = methods.get(entry.method); assert(found,'missing index method');
    const {row,position} = found, source = row.source, contract = row.contract;
    assert.equal(row.id,entry.id); assert.equal(row.index_family,entry.family); assert.equal(row.index_group,entry.group);
    assert.equal(source.url,entry.source_url); assert.equal(source.capture_date,source.retrieved_at.slice(0,10));
    assert(Object.hasOwn(dates,source.capture_date),'recorded detail observation date'); dates[source.capture_date]++;
    assert.equal(source.relation_to_20261017_index,source.capture_date === '2026-10-17' ? 'same_day_individual_capture' : 'later_supplement_not_retroactive_proof');
    const bundleRef = sourceRefs.get(source.bundle); assert(bundleRef && bundles.has(source.bundle),'declared source bundle');
    assert.equal(bundleRef.sha256,source.bundle_sha256);
    const document = pointer(bundles.get(source.bundle),source.bundle_document_pointer);
    assert.equal(document.method,entry.method); assert.equal(document.retrieved_at,source.retrieved_at);
    assert.equal(document.url,source.url,'retained document URL');
    assert.equal(source.date_meaning,'retrieval_not_publication');
    for (const field of ['http_status','final_url']) {
      const recorded = Object.hasOwn(document,field);
      assert.equal(source[field+'_recorded'],recorded,'retained metadata presence');
      assert.equal(source[field],recorded ? document[field] : null,'retained metadata value');
    }
    assert([source.bundle_document_pointer+'/html_utf8',source.bundle_document_pointer+'/html'].includes(source.html_pointer),'HTML belongs to selected document');
    const raw = pointer(bundles.get(source.bundle),source.html_pointer);
    assert.equal(typeof raw,'string');
    const bytes = Buffer.from(raw); assert(bytes.length <= BASE_API_OPERATION_LIMITS.member_bytes);
    assert.equal(bytes.length,source.html_bytes); assert.equal(sha(bytes),source.html_sha256,'individual HTML pin');
    assert.equal(document.bytes,source.html_bytes); assert.equal(document.sha256,source.html_sha256);
    const contractRef = sourceRefs.get(contract.document); assert(contractRef && contracts.has(contract.document),'declared contract');
    assert.equal(contractRef.sha256,contract.document_sha256);
    assert(Object.hasOwn(formats,contract.format),'known contract representation'); formats[contract.format]++;
    if (contract.format === 'structured_json') assert.equal(pointer(contracts.get(contract.document),contract.json_pointer).method,entry.method,'JSON contract method');
    else markdownSection(contracts.get(contract.document),contract,entry.method);
    return {
      id:entry.id, method:entry.method, family:entry.family, group:entry.group,
      index_pointer:'/methods/'+indexPosition, traceability_pointer:'/methods/'+position,
      source:structuredClone(source), contract:structuredClone(contract),
      status:'unverified', operational_contract_fully_resolved:'UNKNOWN',
      required_evidence_level:null, evidence_level_resolution:'REQUIRES_REVIEW_BEFORE_SCOPE_ADMISSION',
      evidence:{code:[],local:[],sandbox:[],account:[]},
      implementation_verified:false, wire_verified:false, provider_account_verified:false, acceptance_granted:false,
      acceptance_requirements:{status:'NOT_RUN',traceability_pointer:'/methods/'+position+'/acceptance_requirements'},
    };
  });
  assert.equal(methods.size,rows.length,'exact method bijection');
  assert.deepEqual(dates,{'2026-10-17':111,'2026-10-18':93});
  assert.deepEqual(formats,{structured_json:134,markdown_tables_and_prose:70});
  assert.deepEqual([...owned.keys()].sort(),[...used].sort(),'closed input roster');
  const proposal = {
    schema:'dynaminds-base-api-atomic-operation-proposal/v1', as_of:'2026-10-19',
    mode:'RETAINED_FILE_DISCOVERY_ONLY_NOT_SCOPE',
    source_refs:{...refs,bundles:trace.source_bundles,contracts:trace.contract_documents},
    parent_scope:{reference:refs.parentScope,version:5,requirements:2589,requirements_sha256:sha(Buffer.from(JSON.stringify(parent.requirements))),
      inputs:parent.inputs,required_ids_sha256:sha(Buffer.from(JSON.stringify(parent.required_ids))),open_gaps:33},
    summary:{methods:204,groups:new Set(rows.map(row=>row.family+'\0'+row.group)).size,families:index.families,source_bundles:15,detail_observation_dates:dates,contract_formats:formats},
    index_snapshot_enumerated:true, full_contract_inventory_complete:false, coverage_complete:false,
    implementation_coverage_measured:false, scope_mutated:false, scope_complete:false,
    acceptance_granted:false, full_goal_complete:false,
    boundary:'The retained17.10 index fixes names only. Later18.10 pages are later observations. Source links do not resolve semantics, required evidence levels, implementation, wire, provider accounts or acceptance. Existing v5 and all2589 requirements/33 gaps remain unchanged; this proposal is not a scope-freeze input.',
    rows,
  };
  const encoded = Buffer.from(JSON.stringify(proposal,null,2)+'\n');
  assert(encoded.length <= BASE_API_OPERATION_LIMITS.output_bytes,'8MiB proposal bound');
  return structuredClone(proposal);
}
