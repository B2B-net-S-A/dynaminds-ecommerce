import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createScopeSnapshot, main} from './scope-freeze.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const execute = promisify(execFile);
const evidence = () => ({code:[],local:[],sandbox:[],account:[]});
const row = (id, patch = {}) => ({id,requirement:'Preserve the ordinary scoped operation.',operations:['create','cancel'],region:'PL',
  operation_contract:{family:'ordinary',upstream_endpoint_method:'POST /exact',positive_invariants:'One exact result.',discovery_status:'unmapped'},
  acceptance:['Read the exact result without duplicate effects.'],
  status:'unverified',evidence:evidence(),...patch});
async function fixture(run) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dyna scope freeze-')));
  let serial = 0;
  const write = async (name, doc) => {
    const file = path.join(root,`${++serial}-${name}.json`), bytes = Buffer.from(JSON.stringify(doc)+'\n');
    await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
    return {path:file,sha256:sha(bytes),bytes:bytes.length};
  };
  const docs = {
    domains:{schema:'dynaminds-base-functional-domain-inventory/v1',as_of:'2026-10-17',inventory_complete:false,inventory_coverage:{source_catalogue_exhaustive:false},rows:[row('DOM-one')],coverage_gaps:[{id:'gap.dom',description:'Remaining domain variants need discovery.'}]},
    integrations:{schema:'dynaminds-base-parity-integrations/v1',as_of:'2026-10-17',inventory_complete:false,summary:{full_base_roster_complete:false},
      providers:[{id:'woo',name:'Woo'}],rows:[row('INT-woo.order',{provider:'woo',operation:'orders.import'})],
      cross_cutting_gaps:[{id:'gap.worker',requirement:'Verify the ordinary worker lifecycle for every operation.',acceptance:['No duplicate effects after restart.'],missing_scope:'Queue and provider limits.'}],
      coverage_gaps:[{id:'gap.int',requirement:'Remaining API contracts need discovery.',acceptance:['Verify every region and operation.'],missing_scope:'Provider region and version matrix.'}]},
    providerRoster:{schema:'dynaminds-base-provider-roster/v1',inventory_complete:false,coverage_complete:false,
      entries:[{id:'base.provider.woo',name:'Woo',category:'stores',canonical_base_url:'https://base.com/pl-PL/integracje/woocommerce/'}],
      pages:[{id:'stores',label:'Stores',url:'https://base.com/pl-PL/integracje/'}],
      provenance:{main_catalog:{taxonomy_buckets:['Stores']}},coverage_gaps:[{id:'gap.roster',requirement:'Resolve hidden directory pagination.'}]},
  };
  const inputRefs = async (values = docs) => Object.fromEntries(await Promise.all(Object.entries(values).map(async([k,v])=>[k,await write(k,v)])));
  const request = async (patch = {}, values = docs) => ({goal:'FULL-BASE',version:1,snapshot_kind:'partial',inputs:await inputRefs(values),parent:null,...patch});
  try { await run({root,docs,write,request}); } finally { await fs.rm(root,{recursive:true,force:true}); }
}
const refuses = (work, code) => assert.rejects(work,e=>e?.code===code);
const autocomplete = () => ({source:{url:'https://base.com/ajax/getFullList.php',http_status:200,
  observed_on:'2026-10-17',sha256_response_bytes:'a'.repeat(64),response_bytes:277484,
  method:'GET',authenticated:false,business_operation:false,raw_response_persisted:false},entries:[
  {code:'shipping-br',name:'Shipping',logo:'/same.png'},
  {code:'Shipping',name:'Shipping',logo:'/same.png'},
  {code:'shipping',name:'Shipping',logo:'/same.png'},
]});

test('null and undefined requests keep the typed schema refusal',()=>fixture(async x=>{
  for(const request of [null,undefined])
    await refuses(createScopeSnapshot(request,{root:x.root}),'REQUEST_SCHEMA');
}));

test('catalogue opt-in preserves exact source codes separately without changing legacy bytes or business requirements',()=>fixture(async x=>{
  x.docs.providerRoster.autocomplete_catalog=autocomplete();
  const q=await x.request(),legacy=await createScopeSnapshot(q,{root:x.root});
  assert(!Object.hasOwn(legacy,'catalogue_inventory'));
  const current=await createScopeSnapshot({...q,catalogue_inventory_version:1},{root:x.root});
  const {catalogue_inventory:inventory,...unchanged}=current;
  assert.equal(JSON.stringify(unchanged),JSON.stringify(legacy));
  assert.equal(inventory.schema,'dynaminds-parity-catalogue-inventory/v1');
  assert.deepEqual(inventory.entries.map(e=>e.code),['Shipping','shipping','shipping-br']);
  assert.equal(inventory.entries.length,3);assert.equal(current.requirements.length,10);
  assert.deepEqual(inventory.recorded_source,x.docs.providerRoster.autocomplete_catalog.source);
  assert.deepEqual(inventory.source_ref,q.inputs.providerRoster);
  assert.equal(inventory.identity_resolution,'unresolved');assert.equal(inventory.provider_operations_inferred,false);
  assert.equal(inventory.raw_response_revalidated,false);assert.equal(inventory.recorded_source.raw_response_persisted,false);
  assert.equal(current.scope_complete,false);assert.equal(current.acceptance_granted,false);
  await refuses(createScopeSnapshot({...q,catalogue_inventory_version:2},{root:x.root}),'REQUEST_SCHEMA');
}));

test('catalogue rejects malformed records, duplicate exact codes and false source provenance',()=>fixture(async x=>{
  x.docs.providerRoster.autocomplete_catalog=autocomplete();
  for(const [change,code] of [
    [d=>d.entries.push({...d.entries[0]}),'CATALOGUE_DUPLICATE_CODE'],
    [d=>{d.entries[0].code='';},'CATALOGUE_ENTRY'],
    [d=>{d.entries[0].name=null;},'CATALOGUE_ENTRY'],
    [d=>{d.entries[0].logo='x\n.png';},'CATALOGUE_ENTRY'],
    [d=>{d.entries[0].provider='invented';},'CATALOGUE_ENTRY'],
    [d=>{d.source.business_operation=true;},'CATALOGUE_SOURCE'],
    [d=>{d.source.sha256_response_bytes='not-a-hash';},'CATALOGUE_SOURCE'],
  ]){
    const docs=structuredClone(x.docs);change(docs.providerRoster.autocomplete_catalog);
    await refuses(createScopeSnapshot(await x.request({catalogue_inventory_version:1},docs),{root:x.root}),code);
  }
  delete x.docs.providerRoster.autocomplete_catalog;
  await refuses(createScopeSnapshot(await x.request({catalogue_inventory_version:1}),{root:x.root}),'CATALOGUE_INVENTORY');
}));

test('catalogue migration and successors refuse code loss or disabling while legacy snapshots stay reproducible',()=>fixture(async x=>{
  x.docs.providerRoster.autocomplete_catalog=autocomplete();
  const q=await x.request(),legacy=await createScopeSnapshot(q,{root:x.root}),parent=await x.write('legacy',legacy);
  const fewer=structuredClone(x.docs);fewer.providerRoster.autocomplete_catalog.entries.pop();
  await refuses(createScopeSnapshot(await x.request({version:2,parent,catalogue_inventory_version:1},fewer),{root:x.root}),'CATALOGUE_CODE_REMOVED');
  await refuses(createScopeSnapshot(await x.request({version:2,parent},fewer),{root:x.root}),'CATALOGUE_CODE_REMOVED');
  const next=await createScopeSnapshot(await x.request({version:2,parent,catalogue_inventory_version:1}),{root:x.root});
  const nextRef=await x.write('catalogue-parent',next);
  await refuses(createScopeSnapshot(await x.request({version:3,parent:nextRef},fewer),{root:x.root}),'CATALOGUE_DISABLED');
  await refuses(createScopeSnapshot(await x.request({version:3,parent:nextRef,catalogue_inventory_version:1},fewer),{root:x.root}),'CATALOGUE_CODE_REMOVED');
  const missing=structuredClone(x.docs);delete missing.providerRoster.autocomplete_catalog;
  await refuses(createScopeSnapshot(await x.request({version:3,parent:nextRef,catalogue_inventory_version:1},missing),{root:x.root}),'CATALOGUE_INVENTORY');
  const stripped=structuredClone(next);delete stripped.catalogue_inventory;
  await refuses(createScopeSnapshot(await x.request({version:3,parent:await x.write('stripped-parent',stripped)},fewer),{root:x.root}),'CATALOGUE_CODE_REMOVED');
  assert.equal(JSON.stringify(await createScopeSnapshot(q,{root:x.root})),JSON.stringify(legacy));
  const legacyNext=await createScopeSnapshot(await x.request({version:2,parent}),{root:x.root});
  assert(!Object.hasOwn(legacyNext,'catalogue_inventory'));assert.deepEqual(legacyNext.requirements,legacy.requirements);
}));

test('catalogue parent metadata is rederived from its pinned inputs rather than trusting a forged list or provenance',()=>fixture(async x=>{
  x.docs.providerRoster.autocomplete_catalog=autocomplete();
  const original=await createScopeSnapshot(await x.request({catalogue_inventory_version:1}),{root:x.root});
  for(const change of [p=>p.catalogue_inventory.entries.pop(),
    p=>{p.catalogue_inventory.recorded_source.raw_response_persisted=true;},
    p=>{p.catalogue_inventory.source_ref.sha256='0'.repeat(64);},
    p=>{p.catalogue_inventory.identity_resolution='provider-confirmed';}]){
    const forged=structuredClone(original);change(forged);
    const parent=await x.write('forged-catalogue',forged);
    await refuses(createScopeSnapshot(await x.request({version:2,parent,catalogue_inventory_version:1}),{root:x.root}),'PARENT_DERIVED_CATALOGUE');
  }
}));

test('catalogue source metadata may evolve or add codes without creating provider operations or changing scope counts',()=>fixture(async x=>{
  // A legacy roster without autocomplete is still a valid migration parent.
  const old=await createScopeSnapshot(await x.request(),{root:x.root}),parent=await x.write('old',old);
  x.docs.providerRoster.autocomplete_catalog=autocomplete();
  const current=await createScopeSnapshot(await x.request({version:2,parent,catalogue_inventory_version:1}),{root:x.root});
  const ref=await x.write('current',current),docs=structuredClone(x.docs);
  docs.providerRoster.autocomplete_catalog.entries[0].name='Updated source label';
  docs.providerRoster.autocomplete_catalog.entries[0].logo='/new.png';
  docs.providerRoster.autocomplete_catalog.entries.push({code:'another',name:'Shipping',logo:'/same.png'});
  const next=await createScopeSnapshot(await x.request({version:3,parent:ref,catalogue_inventory_version:1},docs),{root:x.root});
  assert.equal(next.catalogue_inventory.entries.length,4);
  assert.deepEqual(next.requirements,old.requirements);assert.deepEqual(next.required_ids,old.required_ids);
  assert.deepEqual(next.changes,{added:[],removed:[]});assert.equal(next.scope_complete,false);
}));

test('partial snapshot freezes all operations, providers, categories and gaps without accepting or mutating inventories',()=>fixture(async x=>{
  const before=JSON.stringify(x.docs),q=await x.request(),a=await createScopeSnapshot(q,{root:x.root});
  assert.equal(a.schema,'dynaminds-parity-scope-snapshot/v1');assert.equal(a.snapshot_kind,'partial');
  assert.equal(a.scope_complete,false);assert.equal(a.acceptance_granted,false);assert.equal(a.inventory_mutated,false);
  assert.equal(JSON.stringify(x.docs),before);assert.equal(a.parent,null);assert(a.review_required);
  assert.equal(a.requirements.length,10);assert.equal(a.required_ids.domains.length,2);assert.equal(a.required_ids.integrations.length,4);
  assert.equal(a.required_ids.providerRoster.length,4);
}));

test('parent digest and version lineage are exact; a stale or edited parent cannot become the baseline',()=>fixture(async x=>{
  const first=await createScopeSnapshot(await x.request(),{root:x.root}),parent=await x.write('parent',first);
  await refuses(createScopeSnapshot(await x.request({version:2,parent:{...parent,sha256:'0'.repeat(64)}}),{root:x.root}),'INPUT_DIGEST');
  await refuses(createScopeSnapshot(await x.request({version:3,parent}),{root:x.root}),'PARENT_LINEAGE');
  await refuses(createScopeSnapshot(await x.request({goal:'OTHER-GOAL',version:2,parent}),{root:x.root}),'PARENT_LINEAGE');
  const malformed=structuredClone(first);malformed.required_ids.domains=[];
  await refuses(createScopeSnapshot(await x.request({version:2,parent:await x.write('bad-parent',malformed)}),{root:x.root}),'PARENT_REQUIRED_IDS');
  await fs.appendFile(parent.path,' ');
  await refuses(createScopeSnapshot(await x.request({version:2,parent}),{root:x.root}),'INPUT_FILE');
}));

test('removing or renaming an operation/provider/gap/category is refused instead of shrinking the denominator',()=>fixture(async x=>{
  const parent=await x.write('parent',await createScopeSnapshot(await x.request(),{root:x.root}));
  const changes=[d=>{d.domains.rows=[];},d=>{d.integrations.rows[0].id='INT-renamed';},d=>{d.providerRoster.entries=[];},
    d=>{d.integrations.providers=[];},d=>{d.domains.coverage_gaps=[];},d=>{d.integrations.coverage_gaps=[];},
    d=>{d.providerRoster.coverage_gaps=[];},d=>{d.integrations.cross_cutting_gaps=[];},d=>{d.providerRoster.pages=[];},d=>{d.providerRoster.provenance.main_catalog.taxonomy_buckets=[];}];
  for(const change of changes){const d=structuredClone(x.docs);change(d);
    await assert.rejects(createScopeSnapshot(await x.request({version:2,parent},d),{root:x.root}),e=>['REQUIRED_REMOVED','INVENTORY_INVALID','ROSTER_SCHEMA'].includes(e.code));}
}));

test('same-ID requirement, acceptance, provider target and roster identity cannot silently change',()=>fixture(async x=>{
  const parent=await x.write('parent',await createScopeSnapshot(await x.request(),{root:x.root}));
  for(const change of [d=>{d.domains.rows[0].requirement='A weaker completely different condition.';},
    d=>{d.integrations.rows[0].acceptance=['Check only a happy response.'];},d=>{d.integrations.rows[0].provider='another';},
    d=>{d.integrations.rows[0].operation='different';},d=>{d.providerRoster.entries[0].name='Renamed';},
    d=>{d.providerRoster.entries[0].canonical_base_url='https://base.com/pl-PL/integracje/other/';}]){
    const d=structuredClone(x.docs);change(d);await refuses(createScopeSnapshot(await x.request({version:2,parent},d),{root:x.root}),'REQUIRED_REDEFINED');}
}));

test('required level downgrade is refused; upgrade is additive and status changes alone are permitted',()=>fixture(async x=>{
  const parent=await x.write('parent',await createScopeSnapshot(await x.request(),{root:x.root}));
  for(const source of ['integrations','providerRoster']){const d=structuredClone(x.docs);
    (source==='integrations'?d.integrations.rows[0]:d.providerRoster.entries[0]).required_evidence_level='local';
    await refuses(createScopeSnapshot(await x.request({version:2,parent},d),{root:x.root}),'REQUIRED_LEVEL_DOWNGRADE');}
  const d=structuredClone(x.docs);d.domains.rows[0].required_evidence_level='sandbox';d.domains.rows[0].status='implementation_started';
  const next=await createScopeSnapshot(await x.request({version:2,parent},d),{root:x.root});
  assert.equal(next.requirements.find(r=>r.id==='DOM-one').required_evidence_level,'sandbox');assert.equal(next.changes.removed.length,0);
}));

test('normative operations, region and nested provider contracts cannot shrink under the same ID',()=>fixture(async x=>{
  x.docs.domains.rows[0].future_contract_field={required:['one','two']};
  const first=await createScopeSnapshot(await x.request(),{root:x.root}),parent=await x.write('parent',first);
  assert.deepEqual(first.requirements.find(r=>r.id==='DOM-one').definition.operations,['create','cancel']);
  for(const change of [d=>{d.domains.rows[0].operations=['read'];},d=>{delete d.domains.rows[0].operations;},
    d=>{d.domains.rows[0].region='DE';},d=>{d.domains.rows[0].future_contract_field.required=['one'];},
    d=>{d.integrations.rows[0].operation_contract.upstream_endpoint_method='GET /other';},
    d=>{d.integrations.rows[0].operation_contract.positive_invariants='Ignore duplicate effects.';}]){
    const d=structuredClone(x.docs);change(d);
    await refuses(createScopeSnapshot(await x.request({version:2,parent},d),{root:x.root}),'REQUIRED_REDEFINED');
  }
  const progress=structuredClone(x.docs);progress.domains.rows[0].status='implementation_started';
  progress.domains.rows[0].evidence.code.push('/synthetic/new-code-anchor');
  progress.domains.rows[0].verification={local:'pending'};
  progress.domains.rows[0].operation_contract.discovery_status='source_mapping_in_progress';
  const next=await createScopeSnapshot(await x.request({version:2,parent},progress),{root:x.root});
  assert.deepEqual(next.requirements,first.requirements);
  assert.equal(next.acceptance_granted,false);
}));

test('parent requirements and scope claims must match its own pinned inputs, not a self-declared weaker copy',()=>fixture(async x=>{
  const first=await createScopeSnapshot(await x.request(),{root:x.root});
  const weaker=structuredClone(first),d=structuredClone(x.docs);
  weaker.requirements.find(r=>r.id==='DOM-one').definition.requirement='Entirely different weaker read-only condition.';
  d.domains.rows[0].requirement='Entirely different weaker read-only condition.';
  await refuses(createScopeSnapshot(await x.request({version:2,parent:await x.write('weaker-parent',weaker)},d),{root:x.root}),'PARENT_DERIVED_SCOPE');
  // A rehashed parent and a matching child must not together erase the
  // operations, region, contract or evidence level in the parent's input pins.
  for(const [field,changeDefinition,changeInputs] of [
    ['operations',r=>{r.definition.operations=['read'];},v=>{v.domains.rows[0].operations=['read'];}],
    ['region',r=>{r.definition.region='DE';},v=>{v.domains.rows[0].region='DE';}],
    ['contract',r=>{r.definition.operation_contract.upstream_endpoint_method='GET /other';},v=>{v.domains.rows[0].operation_contract.upstream_endpoint_method='GET /other';}],
    ['level',r=>{r.required_evidence_level='local';},v=>{v.integrations.rows[0].required_evidence_level='local';}],
  ]){
    const forged=structuredClone(first),child=structuredClone(x.docs);
    changeDefinition(forged.requirements.find(r=>r.id===(field==='level'?'INT-woo.order':'DOM-one')));
    changeInputs(child);
    await refuses(createScopeSnapshot(await x.request({version:2,parent:await x.write('forged-parent-'+field,forged)},child),{root:x.root}),'PARENT_DERIVED_SCOPE');
  }
  const missing=structuredClone(first);missing.requirements=missing.requirements.filter(r=>r.id!=='gap.dom');
  missing.required_ids.domains=missing.required_ids.domains.filter(k=>k!=='domains:gap:gap.dom');
  const removed=structuredClone(x.docs);removed.domains.coverage_gaps=[];
  await refuses(createScopeSnapshot(await x.request({version:2,parent:await x.write('shrunk-parent',missing)},removed),{root:x.root}),'PARENT_DERIVED_SCOPE');
  const claimed=structuredClone(first);claimed.scope_complete=true;claimed.snapshot_kind='complete';
  await refuses(createScopeSnapshot(await x.request({version:2,parent:await x.write('false-complete',claimed)}),{root:x.root}),'PARENT_DERIVED_SCOPE');
  const version=structuredClone(first);version.version=2;
  await refuses(createScopeSnapshot(await x.request({version:3,parent:await x.write('non-genesis-version',version)}),{root:x.root}),'PARENT_ANCESTRY');
  const stale=structuredClone(first);stale.inputs.domains.sha256='0'.repeat(64);
  await refuses(createScopeSnapshot(await x.request({version:2,parent:await x.write('stale-parent-inputs',stale)}),{root:x.root}),'INPUT_DIGEST');
  const genuine=await x.write('genuine-parent',first);
  const second=await createScopeSnapshot(await x.request({version:2,parent:genuine}),{root:x.root});
  const secondRef=await x.write('genuine-second',second);
  const third=await createScopeSnapshot(await x.request({version:3,parent:secondRef}),{root:x.root});
  assert.equal(third.version,3);assert.deepEqual(third.requirements,first.requirements);
}));

test('all declared gap collections preserve complete normative contracts while progress may change',()=>fixture(async x=>{
  x.docs.integrations.cross_cutting_gaps[0].future_contract={must:['drain','readback']};
  x.docs.integrations.cross_cutting_gaps[0].required_evidence_level='account';
  x.docs.integrations.future_operational_gaps=[{id:'gap.future',requirement:'Future named gap collection remains part of the denominator.',acceptance:['Verify exact persisted results.']}];
  const first=await createScopeSnapshot(await x.request(),{root:x.root}),parent=await x.write('parent',first);
  assert(first.requirements.some(r=>r.id==='gap.future'));
  for(const change of [d=>{delete d.integrations.cross_cutting_gaps;},d=>{d.integrations.cross_cutting_gaps=[];},
    d=>{d.integrations.cross_cutting_gaps[0].acceptance=['Only a mock happy response.'];},
    d=>{d.integrations.coverage_gaps[0].acceptance=['Only a mock happy response.'];},
    d=>{delete d.integrations.coverage_gaps[0].missing_scope;},
    d=>{d.integrations.cross_cutting_gaps[0].future_contract.must=['readback'];},
    d=>{d.integrations.cross_cutting_gaps[0].required_evidence_level='local';},
    d=>{delete d.integrations.future_operational_gaps;}]){
    const d=structuredClone(x.docs);change(d);
    await assert.rejects(createScopeSnapshot(await x.request({version:2,parent},d),{root:x.root}),e=>['REQUIRED_REMOVED','REQUIRED_REDEFINED'].includes(e.code));
  }
  const progress=structuredClone(x.docs);progress.integrations.cross_cutting_gaps[0].status='work_started';
  progress.integrations.cross_cutting_gaps[0].evidence=[];
  const next=await createScopeSnapshot(await x.request({version:2,parent},progress),{root:x.root});
  assert.deepEqual(next.requirements,first.requirements);
  const forged=structuredClone(first),child=structuredClone(x.docs);
  forged.requirements.find(r=>r.id==='gap.worker').definition.contract.acceptance=['Only a mock happy response.'];
  child.integrations.cross_cutting_gaps[0].acceptance=['Only a mock happy response.'];
  await refuses(createScopeSnapshot(await x.request({version:2,parent:await x.write('forged-gap-parent',forged)},child),{root:x.root}),'PARENT_DERIVED_SCOPE');
}));

test('new provider, operation and gap are added under a new linked version, without deleting inherited IDs',()=>fixture(async x=>{
  const old=await createScopeSnapshot(await x.request(),{root:x.root}),parent=await x.write('parent',old),d=structuredClone(x.docs);
  d.integrations.providers.push({id:'new',name:'New'});d.integrations.rows.push(row('INT-new.read',{provider:'new',operation:'read'}));
  d.providerRoster.entries.push({id:'base.provider.new',name:'New',category:'stores',canonical_base_url:'https://base.com/pl-PL/integracje/new/'});
  d.providerRoster.coverage_gaps.push({id:'gap.new',requirement:'New public contract discovery remains open.'});
  const next=await createScopeSnapshot(await x.request({version:2,parent},d),{root:x.root});
  assert.equal(next.changes.added.length,4);assert.equal(next.requirements.length,old.requirements.length+4);
  assert.deepEqual(next.parent,parent);assert.equal(next.acceptance_granted,false);
}));

test('complete snapshot freezes complete scope before operation acceptance; existing checker is structural/evidence only',()=>fixture(async x=>{
  const old=await createScopeSnapshot(await x.request(),{root:x.root}),parent=await x.write('parent',old),d=structuredClone(x.docs);
  await refuses(createScopeSnapshot(await x.request({snapshot_kind:'complete',version:2,parent}),{root:x.root}),'SCOPE_STILL_PARTIAL');
  const resolution=await x.write('discovery-review',{review:'controlled scope review only, no business acceptance'});
  for(const source of ['domains','integrations','providerRoster']){const doc=d[source];
    for(const collection of Object.keys(doc).filter(k=>k.endsWith('_gaps')&&!k.startsWith('resolved_'))){
      doc['resolved_'+collection]=doc[collection].map(g=>({...g,closed:true,resolution:'Controlled discovery completed.',evidence:[resolution]}));
      doc[collection]=[];
    }
    doc.inventory_complete=true;}
  d.domains.inventory_coverage.source_catalogue_exhaustive=true;d.integrations.summary.full_base_roster_complete=true;d.providerRoster.coverage_complete=true;
  const complete=await createScopeSnapshot(await x.request({version:2,parent,snapshot_kind:'complete'},d),{root:x.root});
  assert.equal(complete.scope_complete,true);assert.equal(complete.snapshot_kind,'complete');assert.equal(complete.acceptance_granted,false);
  assert(complete.requirements.filter(r=>r.kind==='gap').every(r=>r.state==='resolved'));
  assert.equal(d.integrations.rows[0].status,'unverified');assert.deepEqual(d.integrations.rows[0].evidence.account,[]);
  const missing=structuredClone(d);delete missing.domains.resolved_coverage_gaps;
  await refuses(createScopeSnapshot(await x.request({version:2,parent},missing),{root:x.root}),'REQUIRED_REMOVED');
  const missingCross=structuredClone(d);delete missingCross.integrations.resolved_cross_cutting_gaps;
  await refuses(createScopeSnapshot(await x.request({version:2,parent},missingCross),{root:x.root}),'REQUIRED_REMOVED');
  const crossPin=structuredClone(d);crossPin.integrations.resolved_cross_cutting_gaps[0].evidence[0].sha256='0'.repeat(64);
  await refuses(createScopeSnapshot(await x.request({version:2,parent},crossPin),{root:x.root}),'INPUT_DIGEST');
  const forged=structuredClone(d);forged.domains.resolved_coverage_gaps[0].evidence[0].sha256='0'.repeat(64);
  await refuses(createScopeSnapshot(await x.request({version:2,parent},forged),{root:x.root}),'INPUT_DIGEST');
}));

test('canonical refs reject hash/size/path/root/symlink drift and duplicate scope identities',()=>fixture(async x=>{
  const q=await x.request();
  for(const patch of [{sha256:'0'.repeat(64)},{bytes:q.inputs.domains.bytes+1},{path:x.root+'/../'+path.basename(x.root)+'/'+path.basename(q.inputs.domains.path)}]){
    const request=structuredClone(q);Object.assign(request.inputs.domains,patch);await assert.rejects(createScopeSnapshot(request,{root:x.root}));}
  const link=path.join(x.root,'link.json');await fs.symlink(q.inputs.domains.path,link);
  await refuses(createScopeSnapshot({...q,inputs:{...q.inputs,domains:{...q.inputs.domains,path:link}}},{root:x.root}),'INPUT_CANONICAL');
  const d=structuredClone(x.docs);d.providerRoster.entries.push(structuredClone(d.providerRoster.entries[0]));
  await refuses(createScopeSnapshot(await x.request({},d),{root:x.root}),'DUPLICATE_REQUIRED_ID');
  await refuses(main([]),'CLI_ABI');
}));

test('real file-only CLI writes one fresh0600 snapshot and refuses overwrite without changing inputs',()=>fixture(async x=>{
  const directory=path.join(x.root,'local-app/tools/parity');await fs.mkdir(directory,{recursive:true});
  for(const name of ['scope-freeze.mjs','check.mjs','evidence-archive.mjs'])await fs.copyFile(new URL(name,import.meta.url),path.join(directory,name));
  const snapshot=await x.request(),output=path.join(x.root,'scope-manifest.json');
  const request=await x.write('request',{schema:'dynaminds-parity-scope-freeze-request/v1',snapshot,output});
  const args=[path.join(directory,'scope-freeze.mjs'),request.path,request.sha256];
  const first=await execute(process.execPath,args,{timeout:10000,maxBuffer:32768});
  const receipt=JSON.parse(first.stdout);assert.equal(receipt.status,'SCOPE_SNAPSHOT_WRITTEN_NOT_ACCEPTANCE');
  assert.equal(receipt.acceptance_granted,false);assert.equal(receipt.snapshot_kind,'partial');
  const bytes=await fs.readFile(output),manifest=JSON.parse(bytes);assert.equal(sha(bytes),receipt.ref.sha256);
  assert.equal((await fs.stat(output)).mode&0o777,0o600);assert.equal(manifest.acceptance_granted,false);
  await assert.rejects(execute(process.execPath,args,{timeout:10000,maxBuffer:32768}),e=>e.code===1&&JSON.parse(e.stderr).status==='SCOPE_FREEZE_REFUSED');
  assert.deepEqual(await fs.readFile(output),bytes);
  for(const r of Object.values(snapshot.inputs)){const b=await fs.readFile(r.path);assert.equal(sha(b),r.sha256);}
}));

test('actual nested scope CLI honors explicit canonical root with spaces, retains pinned inputs and exclusive output policy',()=>fixture(async x=>{
  const directory=path.join(x.root,'development','isolated checkout','tools/parity');await fs.mkdir(directory,{recursive:true});
  for(const name of ['scope-freeze.mjs','check.mjs','evidence-archive.mjs'])await fs.copyFile(new URL(name,import.meta.url),path.join(directory,name));
  const snapshot=await x.request(),output=path.join(x.root,'explicit root scope.json'),request=await x.write('root-request',{schema:'dynaminds-parity-scope-freeze-request/v1',snapshot,output});
  const entry=path.join(directory,'scope-freeze.mjs'),run=(...options)=>execute(process.execPath,[entry,...options,request.path,request.sha256],{timeout:10000,maxBuffer:32768});
  await assert.rejects(run(),e=>e.code===1&&JSON.parse(e.stderr).code==='INPUT_REF');await assert.rejects(fs.stat(output),{code:'ENOENT'});
  const alias=path.join(x.root,'aliased-workspace');await fs.symlink(x.root,alias);
  for(const options of [['--root=relative'],['--root='+x.root+'/.'],['--root='+alias],['--root='+request.path],['--root='+x.root,'--root='+x.root]]){
    await assert.rejects(run(...options),e=>e.code===1);await assert.rejects(fs.stat(output),{code:'ENOENT'});
  }
  const response=JSON.parse((await run('--root='+x.root)).stdout),bytes=await fs.readFile(output),manifest=JSON.parse(bytes);
  assert.equal(response.status,'SCOPE_SNAPSHOT_WRITTEN_NOT_ACCEPTANCE');assert.equal(response.ref.sha256,sha(bytes));assert.equal(manifest.acceptance_granted,false);assert.equal(manifest.scope_complete,false);assert.equal((await fs.stat(output)).mode&0o777,0o600);
  await assert.rejects(run('--root='+x.root),e=>e.code===1);assert.deepEqual(await fs.readFile(output),bytes);
  for(const ref of Object.values(snapshot.inputs))assert.equal(sha(await fs.readFile(ref.path)),ref.sha256);
}));
