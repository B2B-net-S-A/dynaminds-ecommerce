/** Actual pinned134 JSON contracts; all normalization is FILE/source-only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {
  normalizeBaseApiJsonContracts,restoreBaseApiNormalizedContract,
  BASE_API_NORMALIZATION_PROPOSAL_REF as REF,
} from './base-api-contract-normalization.mjs';

import {readRetainedRevision} from './base-api-retained-revisions.mjs';

const D=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const proposalBytes=await fs.readFile(D+REF.path),proposal=JSON.parse(proposalBytes);
const declared=[...Object.values(proposal.source_refs).filter(value=>!Array.isArray(value)),...proposal.source_refs.bundles,...proposal.source_refs.contracts,REF];
const names=[...new Set(declared.map(ref=>ref.path))];
// Dated registry pins name exact FILE revisions; superseded ones come from their retained copy.
const files=Object.fromEntries(names.map(name=>[name,readRetainedRevision(D,name)]));
const before=new Map(Object.entries(files).map(([name,bytes])=>[name,sha(bytes)]));
const normalized=normalizeBaseApiJsonContracts({files});
const get=method=>normalized.methods.find(row=>row.method===method);
function original(row) {
  let node=JSON.parse(files[row.contract.document]);
  for(const token of row.contract.json_pointer.slice(1).split('/'))node=node[token.replaceAll('~1','/').replaceAll('~0','~')];
  return node;
}
function input(method,name) {
  const row=get(method),collection=row.collections.find(collection=>collection.role==='INPUT');
  const field=collection.fields.find(field=>field.view.identity.value===name);assert(field,method+':'+name);return field;
}

test('actual134 JSON/11 schemas normalize losslessly,70 Markdown methods stay UNKNOWN and parentv5 remains byteexact',async()=>{
  assert.deepEqual(normalized.summary,{index_methods:204,structured_methods:134,source_schemas:11,markdown_methods_unknown:70,
    structured_detail_observation_dates:{'2026-10-17':111,'2026-10-18':23}});
  assert.equal(normalized.methods.length,204);
  assert.deepEqual(normalized.methods.map(row=>row.id),proposal.rows.map(row=>row.id));
  assert.equal(normalized.parent_scope.requirements,2589);assert.equal(normalized.parent_scope.open_gaps,33);
  assert.deepEqual(normalized.parent_scope,proposal.parent_scope);
  const structured=normalized.methods.filter(row=>row.normalization_status==='STRUCTURED_FACTS_NORMALIZED_SEMANTICS_OPEN');
  assert.equal(structured.length,134);
  for(const row of structured) {
    assert.deepEqual(restoreBaseApiNormalizedContract(row),original(row),'whole retained method inverse:'+row.method);
    assert.deepEqual(row.source,proposal.rows.find(source=>source.id===row.id).source);
    assert.equal(row.operational_contract_fully_resolved,'UNKNOWN');assert.equal(row.idempotency_resolution,'UNKNOWN');
  }
  for(const row of normalized.methods.filter(row=>row.normalization_status==='UNKNOWN_MARKDOWN_NOT_NORMALIZED')) {
    assert.equal(row.collections,null);assert.equal(row.facts,null);assert(!Object.hasOwn(row,'source_remainder'));
    assert.equal(row.operational_contract_fully_resolved,'UNKNOWN');
  }
  for(const key of ['full_contract_inventory_complete','coverage_complete','scope_mutated','scope_complete','acceptance_granted','full_goal_complete'])assert.equal(normalized[key],false);
  assert(normalized.methods.every(row=>!row.implementation_verified&&!row.wire_verified&&!row.provider_account_verified&&!row.acceptance_granted));
  for(const [name,digest]of before)assert.equal(sha(files[name]),digest,'input buffer unchanged');
  const parent=normalized.parent_scope.reference;
  assert.equal(sha(await fs.readFile(D+parent.path)),parent.sha256);
  assert(Buffer.byteLength(JSON.stringify(normalized))<=8*1024*1024);
});

test('literal vendor types, unknown requiredness and null placeholders never become runtime validators/defaults',()=>{
  const currency=input('addOrder','currency');
  assert.deepEqual(currency.view.types.map(fact=>fact.value),['char(3)']);
  assert.equal(currency.view.type_resolution,'RAW_DOCUMENTED_TYPES_ONLY');
  assert.equal(currency.view.required.status,'UNKNOWN');assert.equal(currency.view.required.value,null);
  const email=input('addCrmClient','email');assert.equal(email.view.types[0].value,'varchar(220)');
  const client=input('addCrmClient','crm_client_id');
  assert.equal(client.view.default.value_fact.present,true);assert.equal(client.view.default.value_fact.value,null);
  assert.equal(client.view.default.status_fact.present,false);assert.equal(client.view.default.status,'UNKNOWN');
  assert.equal(client.source_facts.omission,'create');assert.equal(client.source_facts.zero,'create');
  const missing=input('addOrder','date_add');
  assert.equal(missing.view.default.value_fact.present,false);assert(!Object.hasOwn(missing.view.default.value_fact,'value'));
  assert.equal(missing.view.default.status,'UNKNOWN');
  assert(!JSON.stringify(currency.view).includes('json_type'));
});

test('documentedfalse/zero retain their distinct values and conditionalrequiredness is not collapsed',()=>{
  const falseDefault=input('getOrders','get_unconfirmed_orders').view.default;
  assert.equal(falseDefault.status,'DOCUMENTED_VALUE');assert.equal(falseDefault.value_fact.value,false);
  const zeroDefault=input('addOrderStatus','type').view.default;
  assert.equal(zeroDefault.status,'DOCUMENTED_VALUE');assert.equal(zeroDefault.value_fact.value,0);
  const name=input('addPickPackCart','name');
  assert.equal(name.view.required.value,false);assert.equal(name.view.required_when.value.operation,'create');
  assert.equal(name.view.required_when.pointer,name.source_pointer+'/required_when');
  assert.deepEqual(name.source_facts.required_when,original(get('addPickPackCart')).input.parameters.find(field=>field.name==='name').required_when);
});

test('allfour explicitly_documented courier defaults are recognized without promoting unknownnull placeholders',()=>{
  const found=[];
  for(const row of normalized.methods.filter(row=>row.normalization_status==='STRUCTURED_FACTS_NORMALIZED_SEMANTICS_OPEN')) {
    const native=original(row);
    for(const parameter of native.input?.parameters??native.input_fields??[]) if(parameter.default_status==='explicitly_documented') {
      const normalizedField=input(row.method,parameter.name);
      assert.equal(normalizedField.view.default.status,'DOCUMENTED_VALUE');
      assert.deepEqual(normalizedField.view.default.value_fact.value,parameter.default);
      found.push([row.method,parameter.name,parameter.default]);
    }
  }
  assert.equal(found.length,4);
  assert(found.some(([, , value])=>value===false));
  assert(found.some(([, , value])=>value==='first_available_account'));
  assert.equal(input('addCrmClient','crm_client_id').view.default.status,'UNKNOWN');
});

test('returns use their realalternate shape; shared error/transport and missingidempotency remain exact sourcefacts',()=>{
  const returns=get('addOrderReturn'),native=original(returns);
  assert.deepEqual(returns.collections.find(collection=>collection.role==='INPUT').source_path,['input_fields']);
  assert.equal(returns.collections.find(collection=>collection.role==='INPUT').fields[0].view.types[0].value,native.input_fields[0].type_documented);
  assert.deepEqual(returns.facts.error_contract.value,native.error_contract);
  assert.equal(returns.facts.mutation_idempotency.status,'UNKNOWN');assert.equal(returns.idempotency_resolution,'UNKNOWN');
  assert.deepEqual(returns.source_remainder.documentation_inconsistencies,native.documentation_inconsistencies);
  const orders=get('getOrders');
  assert.equal(orders.facts.pagination.value.same_second_100plus_tie_breaker,'not_documented');
  assert.equal(orders.facts.pagination.value.recommendation_not_unconditional_lossless_tie_guarantee,true);
  assert.deepEqual(orders.shared.common_error.value,JSON.parse(files[orders.contract.document]).common_error);
  const pick=get('addPickPackCart');
  assert.deepEqual(pick.shared.transport.reference,{path:'docs/parity/base-api-inventory-configuration-contracts.v1.json',pointer:'/shared_transport'});
  assert.deepEqual(pick.shared.transport.value,JSON.parse(files[pick.shared.transport.reference.path]).shared_transport);
  assert.equal(pick.source.capture_date,'2026-10-18');assert.equal(pick.source.relation_to_20261017_index,'later_supplement_not_retroactive_proof');
  assert.equal(get('addCrmClient').source.http_status,null);assert.equal(get('addCrmClient').source.http_status_recorded,false);
});

test('wholeinverse refuses alterednormalized views, originalfacts, missingcollections and residual collisions',()=>{
  const current=get('addOrderStatus');
  const mutations=[
    row=>{row.collections[0].fields[0].view.required.value=true;},
    row=>{row.collections[0].fields[0].source_facts.name='fabricated';},
    row=>{row.collections[0].source_pointer='/methods/999/input/parameters';},
    row=>{row.collections[0].fields[0].source_pointer='/methods/999/input/parameters/0';},
    row=>{row.collections.pop();},
    row=>{row.source_remainder.input.parameters=[];},
    row=>{row.source_remainder.fictional_future_field={accepted:true};},
  ];
  for(const mutate of mutations){const row=structuredClone(current);mutate(row);assert.throws(()=>restoreBaseApiNormalizedContract(row));}
  const nested=get('getOrders').collections.find(collection=>collection.role==='OUTPUT_EMBEDDED');
  assert(nested.fields.length>0);assert(nested.fields.every(field=>field.source_pointer.includes('/output/embedded_documented_fields/')));
});

test('literalproposal/sourcepins reject selfauthenticatedchanges, spoofedrefs, accessors and8MiB/16MiB inputoverflow',()=>{
  const forged=structuredClone(proposal);forged.rows[0].source.http_status=299;
  assert.throws(()=>normalizeBaseApiJsonContracts({files:{...files,[REF.path]:Buffer.from(JSON.stringify(forged))}}));
  assert.throws(()=>normalizeBaseApiJsonContracts({files,refs:{...REF,sha256:'0'.repeat(64)}}),/only pinned FILE inputs/);
  const changed=Buffer.from(files[proposal.source_refs.contracts[0].path]);changed[0]^=1;
  assert.throws(()=>normalizeBaseApiJsonContracts({files:{...files,[proposal.source_refs.contracts[0].path]:changed}}),/source digest/);
  const missing={...files};delete missing[proposal.source_refs.contracts[0].path];assert.throws(()=>normalizeBaseApiJsonContracts({files:missing}));
  const accessor={...files};Object.defineProperty(accessor,REF.path,{enumerable:true,get(){assert.fail('getter must not run');}});
  assert.throws(()=>normalizeBaseApiJsonContracts({files:accessor}),/owned data bytes/);
  assert.throws(()=>normalizeBaseApiJsonContracts({files:{...files,oversized:Buffer.alloc(8*1024*1024+1)}}),/8MiB member/);
  assert.throws(()=>normalizeBaseApiJsonContracts({files:{a:Buffer.alloc(8*1024*1024),b:Buffer.alloc(8*1024*1024),c:Buffer.from('x')}}),/16MiB total/);
});
