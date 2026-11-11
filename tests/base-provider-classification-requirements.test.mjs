/** Offline archived-source classification and binding tests, never acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {deriveBaseProviderClassificationRequirements as derive,serializeBaseProviderClassificationRequirements as serialize,CLASSIFICATION_SOURCES as pins,CLASSIFICATION_LIMITS as limits,BASE_CONNECT_METHODS as methods} from '../tools/parity/base-provider-classification-requirements.mjs';
import {baseCaptureSkip} from '../tools/parity/base-captures.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),read=p=>fs.readFileSync(root+p),sha=b=>createHash('sha256').update(b).digest('hex');
const skip=baseCaptureSkip(Object.values(pins).map(r=>r.path));
if(skip)test('Base Connect classification is re-derived from the archived Base.com sources',{skip},()=>{});
else{
const sources=Object.fromEntries(Object.entries(pins).map(([k,r])=>[k,read(r.path)])),before=Object.fromEntries(Object.entries(sources).map(([k,b])=>[k,sha(b)]));
const output=derive(sources),roster=JSON.parse(sources.roster),dimensions=JSON.parse(sources.dimensions),trace=JSON.parse(sources.trace),integrations=JSON.parse(sources.integrations);
const archive=JSON.parse(gunzipSync(sources.archive,{maxOutputLength:limits.decoded_archive_bytes})),binding=m=>output.operation_bindings.find(b=>b.method===m);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v,digest=v=>sha(JSON.stringify(canonical(v)));

test('exact whole archived sources derive a compact deterministic publication without copying or mutating the2060-entry baseline',()=>{
 const published=read('docs/parity/base-provider-classification-requirements.v1.json');assert.deepEqual(serialize(output),published);assert.deepEqual(serialize(derive(sources)),published);assert(published.length<65536);assert(published.length<=limits.output_bytes);
 for(const[k,r]of Object.entries(pins)){assert.equal(sources[k].length,r.bytes);assert.equal(sha(sources[k]),r.sha256);assert.equal(sha(sources[k]),before[k]);}
 assert(Object.isFrozen(output)&&Object.isFrozen(output.operation_bindings[0].input_table));assert.equal(output.entries,undefined);assert.equal(output.occurrences,undefined);
 assert.equal(output.entry_basis.entries,2060);assert.equal(output.entry_basis.occurrences,2056);assert.equal(output.entry_basis.sha256,sha(sources.dimensions));assert.deepEqual(dimensions.entries.map(e=>e.entry_id),roster.entries.map(e=>e.id));
 assert.match(output.entry_basis.rule,/duplicate identities and conflicts/);assert.equal(output.summary.semantic_provider_count,null);assert.equal(output.summary.fully_resolved_provider_classifications,0);
});

test('exactly12 primary registry identity links preserve source identity, not a legal operator or catalogue-wide operation entitlement',()=>{
 assert.deepEqual(output.registry_identity_matches.map(r=>r.registry_id),['allegro','amazon','ebay','woocommerce','shopify','prestashop','inpost','dpd','fakturownia','smsapi','odoo','bigbuy']);
 for(const link of output.registry_identity_matches){const index=Number(link.entry_pointer.split('/').at(-1)),entry=roster.entries[index],provider=integrations.providers[Number(link.evidence.registry_pointer.split('/').at(-1))];assert.equal(link.entry_id,entry.id);assert.equal(link.registry_id,entry.registry_relationship.provider_id);assert.equal(entry.registry_relationship.kind,'name_and_primary_Base_detail_match');assert.equal(link.registry_id,provider.id);assert.equal(link.classification,'registry_identity_match');for(const k of ['legal_operator','product_edition','api_regions','api_version','base_operation_support'])assert.equal(link[k],'unknown');assert.equal(link.operation_inheritance,false);assert.equal(link.acceptance_granted,false);}
 assert(!output.registry_identity_matches.some(r=>r.registry_id==='mirakl'));assert(dimensions.entries.find(e=>e.entry_id==='base.catalog.marketplace.mirakl').prior_registry_relationship.scope==='family_only');
 assert(dimensions.conflicts.repeated_catalog_ids.some(x=>x.value==='centauro2'));assert.equal(dimensions.summary.additional_entries,1995);assert.equal(output.entry_basis.document,pins.dimensions.path);
});

test('Base Connect is a documented platform product with5 existing methods and15 existing plans, not a newly invented backlog',()=>{
 assert.equal(output.documented_products.length,1);const product=output.documented_products[0];assert.equal(product.entry_id,'base.platform.base-connect');assert.equal(product.entity_kind,'documented_Base_platform_product');assert.equal(product.product,'Base Connect');
 for(const k of ['legal_operator','edition','api_version','api_regions','entitlement'])assert.equal(product[k],'unknown');assert.equal(product.acceptance_granted,false);
 assert.deepEqual(output.operation_bindings.map(b=>b.method),methods);assert.equal(output.summary.existing_operation_bindings,5);assert.equal(output.summary.existing_acceptance_bindings,15);assert.equal(output.summary.new_requirement_ids_created,0);
 const all=trace.methods.flatMap(m=>m.acceptance_requirements.plans);assert.equal(all.length,612);assert(all.every(p=>p.status==='NOT_RUN'));assert.equal(output.existing_backlog.whole_existing_plans_canonical_sha256,digest(all));assert.equal(output.existing_backlog.statuses_modified,false);
 const linked=output.operation_bindings.flatMap(b=>b.existing_acceptance_bindings);assert.equal(new Set(linked.map(p=>p.existing_plan_id)).size,15);
 for(const p of linked){const parts=p.existing_plan_pointer.split('/'),row=trace.methods[Number(parts[2])],old=row.acceptance_requirements.plans[Number(parts.at(-1))];assert.equal(p.existing_plan_id,old.id);assert.equal(p.status,old.status);assert.equal(p.status,'NOT_RUN');assert.equal(p.id,undefined);}
});

test('independent Python HTMLParser reproduces every selected official input/output row without using the generated contracts',()=>{
 const parser=String.raw`
import sys,json,gzip,re
from html.parser import HTMLParser
norm=lambda s:re.sub(r'\s+',' ',s).strip()
class Rows(HTMLParser):
 def __init__(self,name):
  super().__init__(convert_charrefs=True);self.name=name;self.active=False;self.header=None;self.section=None;self.cell=None;self.row=None;self.rows={'input':[],'output':[]}
 def handle_starttag(self,tag,attrs):
  if tag=='div' and dict(attrs).get('class')=='header':self.header=[]
  if self.active and self.section and tag=='tr':self.row=[]
  if self.active and self.section and tag=='td':self.cell=[]
 def handle_data(self,data):
  if self.header is not None:self.header.append(data)
  if self.cell is not None:self.cell.append(data)
 def handle_endtag(self,tag):
  if tag=='div' and self.header is not None:
   text=norm(''.join(self.header));self.header=None
   if text==self.name:self.active=True
   if self.active:self.section={'Input parameters':'input','Output data':'output'}.get(text)
  if tag=='td' and self.cell is not None:self.row.append(norm(''.join(self.cell)));self.cell=None
  if tag=='tr' and self.row is not None:
   self.rows[self.section].append(self.row);self.row=None
raw=json.loads(gzip.decompress(sys.stdin.buffer.read()));out={}
for d in raw['documents']:
 if d.get('family')=='Base Connect':
  p=Rows(d['method']);p.feed(d['html_utf8']);out[d['method']]=p.rows
print(json.dumps(out))
`;
 const child=spawnSync('python3',['-c',parser],{input:sources.archive,maxBuffer:65536,timeout:10000});assert.equal(child.status,0,child.stderr?.toString());const actual=JSON.parse(child.stdout);assert.deepEqual(Object.keys(actual),methods);let inputs=0,outputs=0;
 for(const b of output.operation_bindings){for(const key of ['input','output']){const rows=b[key+'_table'];assert.deepEqual(rows.map(r=>[r.name,r.documented_type,r.description]),actual[b.method][key]);for(const[i,row]of rows.entries()){assert.equal(row.row,i+1);assert.equal(row.required,null);}if(key==='input')inputs+=rows.length;else outputs+=rows.length;}}
 assert.deepEqual([inputs,outputs],[9,26]);
});

test('exact existing Markdown sections, method family and archived body provenance bind all5 methods without external requests',()=>{
 const text=sources.contracts.toString('utf8'),index=JSON.parse(sources.index);
 for(const b of output.operation_bindings){const row=trace.methods[Number(b.evidence.trace_pointer.split('/').at(-1))],doc=archive.documents[Number(b.evidence.source_pointer.split('/').at(-1))];assert.equal(row.method,b.method);assert.equal(row.index_family,'Base Connect');assert.equal(doc.method,b.method);assert.equal(doc.family,'Base Connect');assert.equal(sha(Buffer.from(doc.html_utf8)),b.evidence.source_html_sha256);assert.equal(Buffer.byteLength(doc.html_utf8),b.evidence.source_html_bytes);assert.equal(doc.http_status,200);assert.equal(doc.final_url,b.evidence.source_url);assert.equal(index.methods[Number(b.evidence.index_pointer.split('/').at(-1))].method,b.method);assert.deepEqual(b.evidence.contract,row.contract);
  const start=text.indexOf('### '+b.method+'\n'),tail=text.slice(start),next=[...tail.matchAll(/^#{2,3} /gm)].find(m=>m.index>0)?.index;assert(start>=0);assert.equal(sha(next===undefined?tail:tail.slice(0,next)),b.evidence.contract.section_sha256);assert.equal(text.slice(0,start).split('\n').length,b.evidence.contract.line);
  assert.equal(b.entry_id,'base.platform.base-connect');assert.equal(b.local_route_mapping,null);assert.equal(b.operational_contract_fully_resolved,'UNKNOWN');for(const status of [b.implementation_status,b.wire_status,b.account_status]){assert.equal(status.verified,false);assert.deepEqual(status.evidence,[]);}assert.equal(b.acceptance_granted,false);
 }
});

test('operation-specific documented constraints remain actionable source facts while unresolved types/requiredness are not fabricated',()=>{
 const settlement=binding('addConnectContractorCreditSettlement');assert.match(settlement.documented_intro,/cannot exceed.*credit_to_pay/);
 const amount=settlement.input_table.find(f=>f.name==='amount');assert.equal(amount.documented_type,'float');assert.match(amount.description,/positive value/);assert.match(amount.description,/string or number/);
 assert.match(settlement.input_table.find(f=>f.name==='order_id').description,/Use 0 or omit/);assert.match(settlement.input_table.find(f=>f.name==='message').description,/Maximum 255 characters/);
 const list=binding('getConnectIntegrations');assert.equal(list.input_table.length,0);const integrationsField=list.output_table.find(f=>f.name==='integrations');assert.equal(integrationsField.documented_type,'array');assert.match(integrationsField.description,/own_integrations/);assert.match(integrationsField.description,/connected_integrations/);
 const limit=binding('setConnectContractorCreditLimit').output_table.find(f=>f.name==='new_limit_set');assert.equal(limit.documented_type,'text');assert.match(limit.description,/formatted with currency/);
 const history=binding('getConnectContractorCreditHistory');assert.match(history.output_table.find(f=>f.name==='| - type').description,/charge- payment/);assert.match(history.output_table.find(f=>f.name==='| - is_accepted').description,/0 - waiting- 1 - active/);
 for(const b of output.operation_bindings)for(const f of b.input_table)assert.equal(f.required,null,'no unmarked source field promoted to required');
});

test('all frozen inventory and integration statuses stay unchanged and no source binding grants acceptance',()=>{
 const scope=JSON.parse(sources.scope);assert.equal(scope.requirements.length,2585);assert.equal(scope.scope_complete,false);assert.equal(output.preserved_scope.sha256,sha(sources.scope));assert.equal(output.preserved_scope.acceptance_granted,false);
 assert.equal(output.preserved_integrations.rows,324);assert.equal(output.preserved_integrations.whole_rows_canonical_sha256,digest(integrations.rows));assert.equal(output.preserved_integrations.statuses_modified,false);
 for(const flag of ['inventory_complete','classification_complete','implementation_acceptance','wire_acceptance','external_acceptance','business_acceptance'])assert.equal(output[flag],false);
 assert.equal(output.summary.acceptance_granted,false);assert.equal(output.summary.new_requirement_ids_created,0);assert(output.open_boundaries.some(s=>s.includes('No other catalogue entry')&&s.includes('Mirakl')));
 for(const[k,b]of Object.entries(sources))assert.equal(sha(b),before[k]);
});

test('closed source API rejects mutation, missing/extra fields, accessors and output overflow',()=>{
 assert.throws(()=>derive({}),/exact source keys/);assert.throws(()=>derive({...sources,provider:'mirakl'}),/exact source keys/);const changed=Buffer.from(sources.archive);changed[10]^=1;assert.throws(()=>derive({...sources,archive:changed}),/source SHA/);
 assert.throws(()=>derive({...sources,roster:Buffer.alloc(limits.member_bytes+1)}),/bounded source Buffer/);assert.throws(()=>derive({...sources,index:sources.index.toString()}),/bounded source Buffer/);
 let getter=false;const bad={...sources};Object.defineProperty(bad,'roster',{enumerable:true,get(){getter=true;throw Error('getter');}});assert.throws(()=>derive(bad),/source data property/);assert.equal(getter,false);assert.throws(()=>serialize({x:'a'.repeat(limits.output_bytes)}));
});

test('import is inert and explicit offline check validates only the new publication',()=>{
 const url=new URL('../tools/parity/base-provider-classification-requirements.mjs',import.meta.url).href;
 const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(url)});`],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(imported.status,0,imported.stderr);assert.equal(imported.stdout,'');assert.equal(imported.stderr,'');
 const checked=spawnSync(process.execPath,['tools/parity/base-provider-classification-requirements.mjs','--check'],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(checked.status,0,checked.stderr);const value=JSON.parse(checked.stdout);assert.equal(value.sha256,sha(read('docs/parity/base-provider-classification-requirements.v1.json')));assert.equal(value.existing_operation_bindings,5);assert.equal(value.existing_plan_bindings,15);assert.equal(value.new_requirement_ids_created,0);assert.equal(value.acceptance_granted,false);
});
}
