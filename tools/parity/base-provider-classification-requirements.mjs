/** Exact archived identity/product/operation bindings. No fuzzy provider join,
 * region entitlement, implementation result or new execution-backlog status. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';

export const CLASSIFICATION_LIMITS=Object.freeze({member_bytes:8*1024*1024,input_bytes:16*1024*1024,decoded_archive_bytes:1169789,output_bytes:128*1024});
export const CLASSIFICATION_SOURCES=Object.freeze(Object.fromEntries(Object.entries({
 roster:['docs/parity/base-provider-roster.json',3675917,'94abe5aa81772434f34809edf6ffaa2ea511a0e08f95dacd90a8bc72c1985853'],
 dimensions:['docs/parity/base-provider-catalog-dimensions.v1.json',6022208,'ac79273c343bab1cdcc36f0be86f2c25d1810320d50118a7a2b716c065ae36bc'],
 integrations:['docs/parity/integrations.json',1252573,'e4e9af5ce54685c122d335116184e36eda146aebb04d22488e34d99195133df0'],
 scope:['docs/parity/scope.v2.json',1925550,'49d078d47a53438818bc375ea4489c0334eaafa3b57ba8d0ae7a0015969fecea'],
 index:['docs/parity/base-api-methods.v1.json',85076,'7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992'],
 trace:['docs/parity/base-api-contract-traceability-20261018.json',721919,'7dea2ac8274f87888a70cdf8c77f03cf0ac97759f8eb0d177b88704371bd0cb9'],
 archive:['docs/parity/base-api-other-connect-external-sources-20261018.json.gz',204296,'2f5eda1e2b538cfbea97f87c5a230aba8f89352b4fabdc092a25b51fa2e4f943'],
 contracts:['docs/parity/base-api-other-connect-external-contracts-20261018.md',33623,'7df3cc95fa54ffecaf5c63e7ad7a9cf33fdf3e055ead0a40ec6d6e830fe0d7b8'],
}).map(([k,[source,bytes,sha256]])=>[k,Object.freeze({path:source,bytes,sha256})])));
export const BASE_CONNECT_METHODS=Object.freeze(['getConnectIntegrationContractors','getConnectIntegrations','addConnectContractorCreditSettlement','getConnectContractorCreditHistory','setConnectContractorCreditLimit']);
const OUTPUT='docs/parity/base-provider-classification-requirements.v1.json';
const IDS=['allegro','amazon','ebay','woocommerce','shopify','prestashop','inpost','dpd','fakturownia','smsapi','odoo','bigbuy'];
const sha=b=>createHash('sha256').update(b).digest('hex');
const norm=s=>s.replace(/\s+/g,' ').trim();
const clone=v=>JSON.parse(JSON.stringify(v));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
function section(text,ref){
 const start=text.indexOf('### '+ref.heading+'\n');assert(start>=0);assert.equal(text.slice(0,start).split('\n').length,ref.line);
 const tail=text.slice(start),next=[...tail.matchAll(/^#{2,3} /gm)].find(m=>m.index>0)?.index;
 const content=next===undefined?tail:tail.slice(0,next);assert.equal(sha(content),ref.section_sha256);return content;
}
function archivedFields(JSDOM,source){
 const dom=new JSDOM(source.html_utf8); // no runScripts/resources: archived code is never executed or fetched
 try{
  const doc=dom.window.document,headers=[...doc.querySelectorAll('div.header')];
  const header=name=>{const h=headers.filter(n=>norm(n.textContent)===name);assert.equal(h.length,1);return h[0];};
  const range=doc.createRange();range.setStartAfter(header(source.method));range.setEndBefore(header('Input parameters'));
  const table=name=>{const element=header(name).nextElementSibling;assert.equal(element.tagName,'TABLE');return [...element.querySelectorAll('tr')].map((row,index)=>{
   const cells=[...row.children].map(c=>norm(c.textContent));assert.equal(cells.length,3);
   return {row:index+1,name:cells[0],documented_type:cells[1],description:cells[2],required:null,requiredness:'NOT_NORMALIZED_HERE; consult the pinned contract section and source prose'};
  });};
  return {documented_intro:norm(range.toString()),input_table:table('Input parameters'),output_table:table('Output data')};
 }finally{dom.window.close();}
}

/** Plain exact pinned Buffer inputs only. The output references existing entry
 * and plan identities; it does not copy the 6MB dimensions or invent backlog. */
export function deriveBaseProviderClassificationRequirements(sources){
 assert(sources&&Object.getPrototypeOf(sources)===Object.prototype);
 const keys=Object.keys(CLASSIFICATION_SOURCES),descriptors=Object.getOwnPropertyDescriptors(sources);
 assert.deepEqual(Reflect.ownKeys(sources).sort(),keys.slice().sort(),'exact source keys');let total=0;
 for(const key of keys){const d=descriptors[key],ref=CLASSIFICATION_SOURCES[key];assert(Object.hasOwn(d,'value')&&d.enumerable,'source data property');const b=d.value;
  assert(Buffer.isBuffer(b)&&b.length<=CLASSIFICATION_LIMITS.member_bytes,'bounded source Buffer');total+=b.length;assert(total<=CLASSIFICATION_LIMITS.input_bytes);
  assert.equal(b.length,ref.bytes,'source bytes: '+key);assert.equal(sha(b),ref.sha256,'source SHA: '+key);
 }
 const parse=key=>JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(sources[key]));
 const roster=parse('roster'),dimensions=parse('dimensions'),integrations=parse('integrations'),scope=parse('scope'),index=parse('index'),trace=parse('trace');
 const decoded=gunzipSync(sources.archive,{maxOutputLength:CLASSIFICATION_LIMITS.decoded_archive_bytes});assert.equal(decoded.length,1169789);
 const archive=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(decoded)),contracts=new TextDecoder('utf8',{fatal:true}).decode(sources.contracts);
 assert.equal(scope.scope_complete,false);assert.equal(scope.acceptance_granted,false);assert.equal(roster.entries.length,2060);assert.equal(dimensions.entries.length,2060);assert.equal(dimensions.occurrences.length,2056);
 assert.deepEqual(dimensions.entries.map(e=>e.entry_id),roster.entries.map(e=>e.id));assert.equal(dimensions.source_refs.roster.sha256,CLASSIFICATION_SOURCES.roster.sha256);
 const allPlans=trace.methods.flatMap(m=>m.acceptance_requirements.plans);assert.equal(allPlans.length,612);assert(allPlans.every(p=>p.status==='NOT_RUN'));assert.equal(new Set(allPlans.map(p=>p.id)).size,612);
 const identities=roster.entries.flatMap((entry,i)=>{
  const rel=entry.registry_relationship;if(rel.kind!=='name_and_primary_Base_detail_match')return [];
  const providerIndex=integrations.providers.findIndex(p=>p.id===rel.provider_id);assert(providerIndex>=0);
  return [{entry_id:entry.id,entry_pointer:'/entries/'+i,classification:'registry_identity_match',registry_id:rel.provider_id,registry_name:integrations.providers[providerIndex].name,
   evidence:{roster_pointer:'/entries/'+i+'/registry_relationship',registry_pointer:'/providers/'+providerIndex,base_detail_url:entry.canonical_base_url,source_capture_id:entry.observation.source_capture_id},
   legal_operator:'unknown',product_edition:'unknown',api_regions:'unknown',api_version:'unknown',base_operation_support:'unknown',operation_inheritance:false,acceptance_granted:false}];
 });
 assert.deepEqual(identities.map(x=>x.registry_id),IDS);
 const productIndex=roster.entries.findIndex(e=>e.id==='base.platform.base-connect');assert(productIndex>=0);
 const entry=roster.entries[productIndex];assert.equal(entry.name,'Base Connect');assert.equal(entry.observation.detail_title,'Base Connect - Base.com');
 const indexed=index.methods.filter(m=>m.family==='Base Connect');assert.deepEqual(indexed.map(m=>m.method),BASE_CONNECT_METHODS);
 const {JSDOM}=createRequire(import.meta.url)('jsdom');
 const bindings=BASE_CONNECT_METHODS.map(method=>{
  const rowIndex=trace.methods.findIndex(r=>r.method===method),row=trace.methods[rowIndex];assert(rowIndex>=0&&row.index_family==='Base Connect');
  assert.equal(row.acceptance_granted,false);assert.equal(row.contract.document,CLASSIFICATION_SOURCES.contracts.path);assert.equal(row.contract.document_sha256,CLASSIFICATION_SOURCES.contracts.sha256);
  assert.equal(row.source.bundle_sha256,CLASSIFICATION_SOURCES.archive.sha256);
  const documentIndex=Number(row.source.bundle_document_pointer.split('/').at(-1)),source=archive.documents[documentIndex];assert.equal(source.method,method);assert.equal(source.family,'Base Connect');
  const b=Buffer.from(source.html_utf8);assert.equal(b.length,source.bytes);assert.equal(sha(b),source.sha256);assert.equal(source.sha256,row.source.html_sha256);assert.equal(source.http_status,200);
  assert.equal(source.url,'https://api.baselinker.com/index.php?method='+method);assert.equal(source.final_url,source.url);assert.equal(row.source.html_bytes,source.bytes);
  assert.equal(source.group,row.index_group);section(contracts,row.contract);
  assert.deepEqual(row.acceptance_requirements.plans.map(p=>p.id),['CONTRACT','SAFETY','WIRE-ACCOUNT'].map(s=>row.id+'-'+s));
  const fields=archivedFields(JSDOM,source);
  return {entry_id:entry.id,product:'Base Connect',method_id:row.id,method,group:row.index_group,binding_kind:'documented_platform_method_to_existing_execution_plans',
   evidence:{index_pointer:'/methods/'+index.methods.findIndex(m=>m.method===method),trace_pointer:'/methods/'+rowIndex,source_pointer:row.source.bundle_document_pointer,source_html_sha256:source.sha256,source_html_bytes:source.bytes,source_url:source.url,retrieved_at:source.retrieved_at,contract:clone(row.contract)},
   ...fields,
   existing_acceptance_bindings:row.acceptance_requirements.plans.map((p,i)=>({existing_plan_id:p.id,existing_plan_pointer:'/methods/'+rowIndex+'/acceptance_requirements/plans/'+i,status:p.status,
    binding:i===0?{source_input_rows:fields.input_table.map(f=>f.row),source_output_rows:fields.output_table.map(f=>f.row),whole_prose_contract_section_sha256:row.contract.section_sha256,requirement:'Verify exact documented fields AND whole pinned prose, including unresolved/example differences. No inferred requiredness or account-wide authorization.'}:i===1?{entry_id:entry.id,requirement:'Exercise the existing tenant/account/actor safety and before/after or lost-response plan in an owned local fixture; no automatic mutation retry.'}:{entry_id:entry.id,requirement:'Execute existing wire plan separately from authorized official-account verification. Local simulation does not grant an account result.'}})),
   implementation_status:clone(row.implementation),wire_status:clone(row.wire),account_status:clone(row.provider_account),local_route_mapping:row.local_route_mapping,
   api_version:'unknown',api_regions:'unknown',legal_operator:'unknown',operational_contract_fully_resolved:row.operational_contract_fully_resolved,acceptance_granted:false};
 });
 const result={schema:'dynaminds-base-provider-classification-requirements/v1',as_of:'2026-10-18',status:'PARTIAL_SOURCE_CLASSIFICATION_AND_EXISTING_PLAN_BINDINGS_ONLY',source_refs:clone(CLASSIFICATION_SOURCES),
  entry_basis:{document:CLASSIFICATION_SOURCES.dimensions.path,sha256:CLASSIFICATION_SOURCES.dimensions.sha256,pointer:'/entries',entries:2060,occurrences_pointer:'/occurrences',occurrences:2056,
   default_status:'UNKNOWN_SEMANTICS_FROM_EXISTING_DIMENSIONS',rule:'All existing entry IDs, unknown semantic fields, raw occurrence filters, duplicate identities and conflicts remain referenced unchanged. Only explicit facts below are added; no alias/name/URL/family propagation.'},
  registry_identity_matches:identities,
  documented_products:[{entry_id:entry.id,entry_pointer:'/entries/'+productIndex,entity_kind:'documented_Base_platform_product',product:'Base Connect',evidence:{roster_title:entry.observation.detail_title,index_family:'Base Connect',method_ids:bindings.map(b=>b.method_id)},legal_operator:'unknown',edition:'unknown',api_version:'unknown',api_regions:'unknown',entitlement:'unknown',acceptance_granted:false}],
  operation_bindings:bindings,
  existing_backlog:{document:CLASSIFICATION_SOURCES.trace.path,sha256:CLASSIFICATION_SOURCES.trace.sha256,existing_plans:612,whole_existing_plans_canonical_sha256:digest(allPlans),statuses_modified:false,new_requirement_ids_created:0},
  preserved_scope:{document:CLASSIFICATION_SOURCES.scope.path,sha256:CLASSIFICATION_SOURCES.scope.sha256,scope_complete:false,acceptance_granted:false},
  preserved_integrations:{document:CLASSIFICATION_SOURCES.integrations.path,sha256:CLASSIFICATION_SOURCES.integrations.sha256,rows:integrations.rows.length,whole_rows_canonical_sha256:digest(integrations.rows),statuses_modified:false},
  summary:{referenced_entries:2060,referenced_occurrences:2056,registry_identity_matches:identities.length,documented_platform_products:1,existing_operation_bindings:bindings.length,existing_acceptance_bindings:bindings.reduce((n,b)=>n+b.existing_acceptance_bindings.length,0),new_requirement_ids_created:0,fully_resolved_provider_classifications:0,semantic_provider_count:null,acceptance_granted:false},
  open_boundaries:['This bounded slice adds five existing Base Connect method/product/plan bindings, not five newly discovered API methods or fifteen new requirements.','Local registry identity is not a legal provider/operator classification. Other documented provider operation bodies were not persisted in old marketing reader captures; do not reconstruct them from a title.','Base Connect methods belong to the Base platform. No other catalogue entry, shared URL, category, country filter or Mirakl search tag inherits them.','Regions, editions, actual upstream versions, legal operators and account eligibility remain unknown unless a future exact source establishes them.','All existing612 plans stay NOT_RUN; local, official-account, business/UI and recovery execution remain separate future gates.'],
  inventory_complete:false,classification_complete:false,implementation_acceptance:false,wire_acceptance:false,external_acceptance:false,business_acceptance:false};
 assert(Buffer.byteLength(JSON.stringify(result,null,2)+'\n')<=CLASSIFICATION_LIMITS.output_bytes);return freeze(result);
}
export function serializeBaseProviderClassificationRequirements(value){const b=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(b.length<=CLASSIFICATION_LIMITS.output_bytes);return b;}
async function bounded(file,limit){
 const s=await fs.lstat(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=limit);const h=await fs.open(file,'r');
 const same=t=>t.isFile()&&t.dev===s.dev&&t.ino===s.ino&&t.size===s.size&&t.mtimeMs===s.mtimeMs&&t.ctimeMs===s.ctimeMs;
 try{assert(same(await h.stat()));const b=Buffer.alloc(s.size+1);let n=0;while(n<b.length){const r=await h.read(b,n,b.length-n,null);if(!r.bytesRead)break;n+=r.bytesRead;}assert.equal(n,s.size);assert(same(await h.stat())&&same(await fs.lstat(file)));return b.subarray(0,n);}finally{await h.close();}
}
/** Explicit fixed-path, file-only CLI; --write refuses an existing publication. */
export async function main(args){
 assert(args.length===1&&['--check','--write'].includes(args[0]));const root=fileURLToPath(new URL('../../',import.meta.url)),sources={};
 for(const[k,ref]of Object.entries(CLASSIFICATION_SOURCES))sources[k]=await bounded(path.join(root,ref.path),CLASSIFICATION_LIMITS.member_bytes);
 const bytes=serializeBaseProviderClassificationRequirements(deriveBaseProviderClassificationRequirements(sources)),file=path.join(root,OUTPUT);
 if(args[0]==='--write')await fs.writeFile(file,bytes,{flag:'wx',mode:0o644});else assert.deepEqual(await bounded(file,CLASSIFICATION_LIMITS.output_bytes),bytes);
 return {status:'PARTIAL_SOURCE_CLASSIFICATION_AND_EXISTING_PLAN_BINDINGS_ONLY',bytes:bytes.length,sha256:sha(bytes),entry_refs:2060,registry_identity_matches:12,existing_operation_bindings:5,existing_plan_bindings:15,new_requirement_ids_created:0,acceptance_granted:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
