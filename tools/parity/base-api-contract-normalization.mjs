/** Pure lossless source-fact normalization, not business validation or acceptance.
 * Literal proposal + retained source pins are rechecked through the atomic tool.
 * No filesystem/network/SQL, no prose-derived types/defaults/permissions/retry. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveBaseApiOperationProposal,BASE_API_OPERATION_LIMITS as LIMITS} from './base-api-operation-requirements.mjs';

export const BASE_API_NORMALIZATION_PROPOSAL_REF = Object.freeze({
  path:'docs/parity/base-api-operation-proposal-20261019.json',bytes:441717,
  sha256:'c398b819b9d04f80d0b7a7c040968c309035f5c814b639c4ebcaab93978275f9',
});
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const digest = value => sha(Buffer.from(JSON.stringify(canonical(value))));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value,key) => object(value) && Object.hasOwn(value,key);
const token = key => String(key).replaceAll('~','~0').replaceAll('/','~1');
const append = (base,key) => base+'/'+token(key);
function at(value,pointer) {
  assert(typeof pointer === 'string' && pointer.startsWith('/') && pointer.length <= 1024,'bounded own JSON pointer');
  for (const encoded of pointer.slice(1).split('/')) {
    assert(!/~(?![01])/.test(encoded),'JSON pointer escape');
    const key=encoded.replaceAll('~1','/').replaceAll('~0','~');
    assert(value !== null && typeof value === 'object' && Object.hasOwn(value,key),'existing own JSON pointer');
    value=value[key];
  }
  return value;
}
function fact(value,key,pointer) {
  return own(value,key) ? {status:'RECORDED_SOURCE_FACT',present:true,value:structuredClone(value[key]),pointer:append(pointer,key)}
    : {status:'UNKNOWN',present:false,pointer:null};
}
function field(value,pointer,depth=0) {
  assert(depth<=32,'bounded nested source fields');
  if (!object(value)) return {source_pointer:pointer,source_facts:structuredClone(value),view:{status:'UNKNOWN_SOURCE_SHAPE'},nested:[]};
  const typeKeys=['documented_type','type_documented'].filter(key=>own(value,key));
  const required=fact(value,'required',pointer);
  const requiredStatus=required.present && typeof required.value==='boolean' ? 'RECORDED_SOURCE_FACT' : 'UNKNOWN';
  const defaultValue=fact(value,'default',pointer), defaultStatus=fact(value,'default_status',pointer);
  // A bare `default:null` in CRM is a preserved placeholder, not proof of a
  // documented null default. Neither absent status nor prose is guessed.
  const explicitDefault=defaultValue.present && defaultStatus.present &&
    ['documented','explicitly_documented','explicit_false','explicit_zero'].includes(defaultStatus.value);
  const nested=[];
  for (const key of ['fields','element_fields']) if (Array.isArray(value[key])) nested.push({
    property:key,pointer:append(pointer,key),fields:value[key].map((child,index)=>field(child,append(append(pointer,key),index),depth+1)),
  });
  return {
    source_pointer:pointer,source_facts:structuredClone(value),
    view:{
      identity:own(value,'name') ? fact(value,'name',pointer) : fact(value,'path',pointer),
      types:typeKeys.map(key=>fact(value,key,pointer)),type_resolution:typeKeys.length ? 'RAW_DOCUMENTED_TYPES_ONLY' : 'UNKNOWN',
      required:{...required,status:requiredStatus},
      requiredness_source:own(value,'requiredness_source') ? fact(value,'requiredness_source',pointer) : fact(value,'required_basis',pointer),
      required_when:fact(value,'required_when',pointer),
      default:{status:explicitDefault ? 'DOCUMENTED_VALUE' : 'UNKNOWN',value_fact:defaultValue,status_fact:defaultStatus,
        documented_default:fact(value,'documented_default',pointer)},
    },nested,
  };
}
const collections=[
  {path:['input','parameters'],role:'INPUT'}, {path:['input_fields'],role:'INPUT'},
  {path:['output','fields'],role:'OUTPUT'}, {path:['output_fields'],role:'OUTPUT'},
  {path:['input','embedded_documented_fields'],role:'INPUT_EMBEDDED'},
  {path:['output','embedded_documented_fields'],role:'OUTPUT_EMBEDDED'},
];
function normalizeNode(node,pointer) {
  assert(object(node),'structured method object');
  const remainder=structuredClone(node),normalized=[];
  for (const spec of collections) {
    let parent=node,remaining=remainder,p=pointer;
    for (const key of spec.path.slice(0,-1)) {
      if (!own(parent,key)) { parent=null;break; }
      parent=parent[key];remaining=remaining[key];p=append(p,key);
    }
    const key=spec.path.at(-1);
    if (!own(parent,key)) continue;
    assert(Array.isArray(parent[key]),'known field collection must be an array');
    const location=append(p,key);
    normalized.push({role:spec.role,source_path:spec.path,source_pointer:location,
      fields:parent[key].map((value,index)=>field(value,append(location,index)))});
    delete remaining[key];
  }
  return {source_remainder:remainder,collections:normalized,source_node_sha256:digest(node)};
}

/** A source codec inverse only. Recomputed views and the whole original-node
 * digest refuse inconsistent/tampered normalized data; no runtime authority. */
export function restoreBaseApiNormalizedContract(normalized) {
  assert(normalized.normalization_status==='STRUCTURED_FACTS_NORMALIZED_SEMANTICS_OPEN');
  const node=structuredClone(normalized.source_remainder),seen=new Set();
  for (const collection of normalized.collections) {
    const spec=collections.find(spec=>JSON.stringify(spec.path)===JSON.stringify(collection.source_path));
    assert(spec && spec.role===collection.role,'known source collection');
    const expectedPointer=spec.path.reduce(append,normalized.contract.json_pointer);
    assert.equal(collection.source_pointer,expectedPointer,'exact collection source pointer');
    const key=JSON.stringify(spec.path);assert(!seen.has(key),'unique source collection');seen.add(key);
    let parent=node;
    for (const segment of spec.path.slice(0,-1)) { assert(own(parent,segment));parent=parent[segment]; }
    const leaf=spec.path.at(-1);assert(!own(parent,leaf),'source remainder cannot replace normalized fields');
    parent[leaf]=collection.fields.map((entry,index)=>{
      assert.equal(entry.source_pointer,append(expectedPointer,index),'exact field source pointer');
      assert.deepEqual(entry,field(entry.source_facts,entry.source_pointer),'normalized views match retained facts');
      return structuredClone(entry.source_facts);
    });
  }
  assert.equal(digest(node),normalized.source_node_sha256,'whole source-node inverse');return node;
}

export function normalizeBaseApiJsonContracts(input) {
  assert(object(input));assert.deepEqual(Object.keys(input),['files'],'only pinned FILE inputs');
  assert(object(input.files));const files={};let total=0;
  for (const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input.files))) {
    assert(Object.hasOwn(descriptor,'value') && descriptor.value instanceof Uint8Array,'owned data bytes only');
    const bytes=Buffer.from(descriptor.value);assert(bytes.length>0&&bytes.length<=LIMITS.member_bytes,'8MiB member bound');
    total+=bytes.length;assert(total<=LIMITS.input_bytes,'16MiB total input bound');files[name]=bytes;
  }
  const ref=BASE_API_NORMALIZATION_PROPOSAL_REF,raw=files[ref.path];assert(raw,'literal proposal required');
  assert.equal(raw.length,ref.bytes);assert.equal(sha(raw),ref.sha256,'literal atomic proposal pin');
  const proposal=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));delete files[ref.path];
  assert.deepEqual(deriveBaseApiOperationProposal({files}),proposal,'whole proposal rederived from literal retained references');
  const documents=new Map();
  for (const declared of proposal.source_refs.contracts) if (declared.path.endsWith('.json'))
    documents.set(declared.path,JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(files[declared.path])));
  function sharedFact(document,name,path) {
    if (own(document,name)) return {status:'RECORDED_SOURCE_FACT',reference:{path,pointer:'/'+name},value:structuredClone(document[name])};
    const indirect=document[name+'_ref'];
    if (object(indirect)) {
      const target='docs/parity/'+indirect.path;
      const pinned=proposal.source_refs.contracts.find(ref=>ref.path===target);
      assert(pinned && pinned.sha256===indirect.sha256 && documents.has(target),'declared shared contract reference');
      return {status:'RECORDED_SOURCE_FACT',reference:{path:target,pointer:indirect.pointer},
        via:{path,pointer:'/'+name+'_ref'},value:structuredClone(at(documents.get(target),indirect.pointer))};
    }
    return {status:'UNKNOWN',reference:null};
  }
  let structured=0,markdown=0;const schemas=new Set(),dates={'2026-10-17':0,'2026-10-18':0};
  const methods=proposal.rows.map(row=>{
    const base={id:row.id,method:row.method,family:row.family,group:row.group,source:structuredClone(row.source),contract:structuredClone(row.contract),
      operational_contract_fully_resolved:'UNKNOWN',implementation_verified:false,wire_verified:false,provider_account_verified:false,acceptance_granted:false};
    if (row.contract.format!=='structured_json') {markdown++;return {...base,normalization_status:'UNKNOWN_MARKDOWN_NOT_NORMALIZED',collections:null,facts:null};}
    structured++;dates[row.source.capture_date]++;
    const document=documents.get(row.contract.document);assert(document,'pinned structured contract');schemas.add(document.schema);
    const node=at(document,row.contract.json_pointer);assert.equal(node.method,row.method);
    const normalized=normalizeNode(node,row.contract.json_pointer),facts={};
    for (const key of ['pagination','errors','error_contract','mutation_idempotency','documented_rules','documentation_inconsistencies','unknowns','open_contract_issues'])
      facts[key]=fact(node,key,row.contract.json_pointer);
    const result={...base,normalization_status:'STRUCTURED_FACTS_NORMALIZED_SEMANTICS_OPEN',source_schema:document.schema,
      ...normalized,facts,idempotency_resolution:'UNKNOWN',
      shared:{common_error:sharedFact(document,'common_error',row.contract.document),transport:sharedFact(document,'shared_transport',row.contract.document)}};
    assert.deepEqual(restoreBaseApiNormalizedContract(result),node,'lossless whole source contract');return result;
  });
  assert.equal(structured,134);assert.equal(markdown,70);assert.equal(schemas.size,11);
  assert.deepEqual(dates,{'2026-10-17':111,'2026-10-18':23});
  const result={schema:'dynaminds-base-api-structured-contract-normalization/v1',mode:'SOURCE_FACTS_ONLY_NOT_RUNTIME_VALIDATORS',
    proposal_ref:ref,parent_scope:structuredClone(proposal.parent_scope),source_refs:structuredClone(proposal.source_refs),
    summary:{index_methods:204,structured_methods:134,source_schemas:11,markdown_methods_unknown:70,structured_detail_observation_dates:dates},
    full_contract_inventory_complete:false,coverage_complete:false,scope_mutated:false,scope_complete:false,
    acceptance_granted:false,full_goal_complete:false,
    boundary:'Lossless normalization preserves source literals and ambiguity. Required/default facts do not generate validation. Raw documented types are not JSON type guarantees. Missing idempotency/errors/pagination are UNKNOWN; later18.10 observations do not become17.10 evidence. No operation, provider, wire or product acceptance is granted.',methods};
  assert(Buffer.byteLength(JSON.stringify(result,null,2)+'\n')<=LIMITS.output_bytes,'8MiB normalization output bound');return result;
}
