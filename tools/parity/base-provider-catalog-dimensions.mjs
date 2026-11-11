/** Offline listing dimensions only. Cards, search terms and filter countries
 * never establish semantic providers, API regions, versions or operations. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

export const BASE_PROVIDER_CATALOG_DIMENSION_LIMITS=Object.freeze({member_bytes:8*1024*1024,input_bytes:16*1024*1024,output_bytes:8*1024*1024});
export const BASE_PROVIDER_CATALOG_DIMENSION_SOURCES=Object.freeze(Object.fromEntries(Object.entries({
 roster:['docs/parity/base-provider-roster.json',3675917,'94abe5aa81772434f34809edf6ffaa2ea511a0e08f95dacd90a8bc72c1985853'],
 integrations:['docs/parity/integrations.json',1252573,'e4e9af5ce54685c122d335116184e36eda146aebb04d22488e34d99195133df0'],
 scope:['docs/parity/scope.v2.json',1925550,'49d078d47a53438818bc375ea4489c0334eaafa3b57ba8d0ae7a0015969fecea'],
 parentRoster:['docs/parity/scope-inputs/v2/base-provider-roster.json',3672322,'b4c1ea152a16bdd2186c56d46d706299ad77ac3007798487b66fa16177e3915a'],
 parentIntegrations:['docs/parity/scope-inputs/v2/integrations.json',1252573,'029ddaf33b2195b5404a40c959e1f4ec711a83bcfd83aed7a62eb361798397a1'],
 catalogHtmlGzip:['docs/parity/base-catalog-20261017.html.gz',133260,'0ec107bad9187a05f22d4e0b0593ccfcb6d3ecfe2635804fbd310d45c7334132'],
 catalogScriptGzip:['docs/parity/base-catalog-20261017.integrations.js.gz',19836,'72d1640ed44f68e48443f6a4b80f4f383aa81e4f133edb4a7804896f755af89c'],
}).map(([key,[source,bytes,sha256]])=>[key,Object.freeze({path:source,bytes,sha256})])));
const OUTPUT='docs/parity/base-provider-catalog-dimensions.v1.json';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const clone=v=>JSON.parse(JSON.stringify(v));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const sorted=xs=>[...new Set(xs)].sort((a,b)=>a<b?-1:a>b?1:0);
function filterFact(attributes,key,upper=false){
 const present=Object.hasOwn(attributes,key);const raw=present?attributes[key]:null;
 assert(raw===null||typeof raw==='string');
 return {state:!present?'missing':raw===''?'empty':'observed',raw,tokens:raw===null||raw===''?[]:raw.split(',').map(x=>upper?x.toUpperCase():x.toLowerCase()),meaning:'catalog_ui_filter_only'};
}
function groups(rows,key,member){
 const by=new Map();for(const row of rows){const value=key(row);if(!by.has(value))by.set(value,[]);by.get(value).push(member(row));}
 return [...by].filter(([,v])=>v.length>1).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([value,members])=>({value,members}));
}
const unknown=()=>({entity_kind:'unknown',provider_identity:'unknown',operator:'unknown',edition:'unknown',api_version:'unknown',api_regions:'unknown',operations:'unknown'});

/** Exact pinned source bytes only; no caller metadata, adapters or network IO. */
export function deriveBaseProviderCatalogDimensions(sources){
 assert(sources&&Object.getPrototypeOf(sources)===Object.prototype,'plain source byte map');
 const descriptors=Object.getOwnPropertyDescriptors(sources),keys=Object.keys(BASE_PROVIDER_CATALOG_DIMENSION_SOURCES);
 assert.deepEqual(Reflect.ownKeys(sources).sort(),keys.slice().sort(),'exact source keys');
 const parsed={};let total=0;
 for(const key of keys){
  assert(Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable,'source data property');
  const b=descriptors[key].value,ref=BASE_PROVIDER_CATALOG_DIMENSION_SOURCES[key];
  assert(Buffer.isBuffer(b)&&b.length<=BASE_PROVIDER_CATALOG_DIMENSION_LIMITS.member_bytes,'bounded source Buffer');
  total+=b.length;assert(total<=BASE_PROVIDER_CATALOG_DIMENSION_LIMITS.input_bytes,'aggregate source bound');
  assert.equal(b.length,ref.bytes,'source byte length: '+key);assert.equal(sha(b),ref.sha256,'source SHA: '+key);
  if(!key.endsWith('Gzip'))parsed[key]=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(b));
 }
 const html=gunzipSync(sources.catalogHtmlGzip,{maxOutputLength:3170081}),script=gunzipSync(sources.catalogScriptGzip,{maxOutputLength:77696});
 assert.equal(html.length,3170081);assert.equal(sha(html),'7847860f87270aaebcd41e89f82e62a11135226ea8b6ade6f798bc9921531d1c');
 assert.equal(script.length,77696);assert.equal(sha(script),'d3ab7587f6f27c15540d557300d743830eefb170c22d6c8a39335b20fd588f39');
 const {roster,integrations,scope,parentRoster,parentIntegrations}=parsed;
 assert.equal(roster.entries.length,2060);assert.equal(roster.catalog_cards.length,2056);assert.equal(integrations.rows.length,324);
 assert.equal(scope.inputs.providerRoster.sha256,BASE_PROVIDER_CATALOG_DIMENSION_SOURCES.parentRoster.sha256);
 assert.equal(scope.inputs.integrations.sha256,BASE_PROVIDER_CATALOG_DIMENSION_SOURCES.parentIntegrations.sha256);
 assert.equal(scope.scope_complete,false);assert.equal(scope.acceptance_granted,false);
 assert.equal(parentRoster.entries.length,2060);assert.equal(parentIntegrations.rows.length,324);
 const entriesById=new Map(roster.entries.map((e,index)=>[e.id,{entry:e,index}]));assert.equal(entriesById.size,2060);
 const autocomplete=roster.autocomplete_catalog.entries,autoByCode=new Map(autocomplete.map((a,index)=>[a.code,{...a,source_pointer:'/autocomplete_catalog/entries/'+index}]));assert.equal(autoByCode.size,2052);
 const occurrences=roster.catalog_cards.map((card,index)=>{
  assert.equal(card.ordinal,index+1);assert(entriesById.has(card.entry_id),'orphan card');assert.equal(card.catalog_id,card.attributes.id);assert.equal(card.name,card.attributes['data-name']);
  const auto=autoByCode.get(card.catalog_id),tags=Object.hasOwn(card.attributes,'data-tags')?card.attributes['data-tags']:null;
  return {ordinal:card.ordinal,entry_id:card.entry_id,source_pointer:'/catalog_cards/'+index,catalog_id:card.catalog_id,name:card.name,listing_category:card.category_id,listing_urls:clone(card.urls),raw_attributes:clone(card.attributes),
   country_filter:filterFact(card.attributes,'data-countries',true),category_filter:filterFact(card.attributes,'data-categories'),
   search_terms:{state:tags===null?'missing':tags===''?'empty':'observed',raw:tags,tokens:tags===null?[]:tags.split(' '),meaning:'catalog_search_terms_only'},
   autocomplete_exact_code:auto?clone(auto):null,availability_observation:card.category_id==='comingsoon'?'listed_in_comingsoon':'listed_in_category',availability_entitlement:'unknown'};
 });
 const entries=roster.entries.map((e,index)=>({entry_id:e.id,name:e.name,source_pointer:'/entries/'+index,cohort:e.observation.kind==='raw_html_catalog_card'?'additional_catalog_observation':'preserved_prior_observation',
  prior_identifier_kind:e.id.startsWith('base.platform.')?'platform_label':e.id.startsWith('base.provider.')?'provider_label':'catalog_label',listing_category:e.category,listing_url:e.canonical_base_url,
  source_observation:clone(e.observation),prior_registry_relationship:clone(e.registry_relationship),occurrence_ordinals:occurrences.filter(c=>c.entry_id===e.id).map(c=>c.ordinal),
  semantic:unknown(),semantic_boundary:'not_assessed_here; existing source classifications and registry evidence are not replaced',operation_rows_created:0,acceptance_granted:false}));
 const newIds=new Set(entries.filter(e=>e.cohort==='additional_catalog_observation').map(e=>e.entry_id));assert.equal(newIds.size,1995);
 const newlyObserved=occurrences.filter(c=>newIds.has(c.entry_id));
 const repeatedIds=groups(occurrences,c=>c.catalog_id,c=>({ordinal:c.ordinal,entry_id:c.entry_id,listing_category:c.listing_category}));
 const urls=occurrences.flatMap(c=>c.listing_urls.map(url=>({url,ordinal:c.ordinal,entry_id:c.entry_id,catalog_id:c.catalog_id})));
 const codes=sorted(occurrences.map(c=>c.catalog_id));
 const result={schema:'dynaminds-base-provider-catalog-dimensions/v1',as_of:'2026-10-18',status:'SOURCE_LISTING_DIMENSIONS_ONLY',
  source_refs:clone(BASE_PROVIDER_CATALOG_DIMENSION_SOURCES),parent_scope:{schema:scope.schema,version:scope.version,sha256:BASE_PROVIDER_CATALOG_DIMENSION_SOURCES.scope.sha256,scope_complete:false,acceptance_granted:false},
  interpretation:{country:'Uppercase CSV tokens are archived UI filter observations, never an API-region entitlement; empty/missing remain unknown; UK is not silently rewritten to GB.',category:'Listing bucket and lowercase data-categories are distinct UI dimensions. all means the archived category filter, never worldwide availability.',search:'Space-split archived search tags are not provider, operator or API family authority.',identity:'Occurrence, entry, catalogue code, display name and URL are separate. Repeated IDs, shared URLs and comingsoon observations are never collapsed into a semantic provider.',semantic:'No provider/operator/edition/API-version/operation classification or acceptance is added. Prior registry relationships are provenance only.'},
  summary:{entries:entries.length,occurrences:occurrences.length,preserved_prior_entries:entries.length-newIds.size,additional_entries:newIds.size,additional_occurrences:newlyObserved.length,distinct_catalog_ids:codes.length,distinct_listing_urls:sorted(urls.map(r=>r.url)).length,autocomplete_codes:autoByCode.size,
   additional_country_filter_states:Object.fromEntries(['observed','empty','missing'].map(state=>[state,newlyObserved.filter(c=>c.country_filter.state===state).length])),semantic_provider_count:null,operation_rows_created:0,acceptance_granted:false},
  entries,occurrences,
  conflicts:{repeated_catalog_ids:repeatedIds,shared_listing_urls:groups(urls,c=>c.url,c=>({ordinal:c.ordinal,entry_id:c.entry_id,catalog_id:c.catalog_id})),
   same_display_name_distinct_codes:groups(occurrences,c=>c.name,c=>({ordinal:c.ordinal,catalog_id:c.catalog_id,entry_id:c.entry_id})).filter(g=>new Set(g.members.map(m=>m.catalog_id)).size>1),
   cross_category_same_catalog_id:repeatedIds.filter(g=>new Set(g.members.map(m=>m.listing_category)).size>1),
   html_only_codes:codes.filter(code=>!autoByCode.has(code)),autocomplete_only_codes:sorted([...autoByCode.keys()].filter(code=>!codes.includes(code)))},
  preserved_integrations:{source_sha256:BASE_PROVIDER_CATALOG_DIMENSION_SOURCES.integrations.sha256,providers:integrations.providers.length,rows:integrations.rows.length,whole_rows_canonical_sha256:digest(integrations.rows),whole_provider_rows_canonical_sha256:digest(integrations.providers),frozen_parent_rows_canonical_sha256:digest(parentIntegrations.rows),local_scoped_rows:integrations.summary.local_scoped_rows,external_sandbox_accepted_rows:integrations.summary.external_sandbox_accepted_rows,external_account_accepted_rows:integrations.summary.external_account_accepted_rows,operation_rows_created:0,statuses_modified:false},
  inventory_complete:false,coverage_complete:false,implementation_acceptance:false,external_acceptance:false,business_acceptance:false};
 assert(Buffer.byteLength(JSON.stringify(result,null,2)+'\n')<=BASE_PROVIDER_CATALOG_DIMENSION_LIMITS.output_bytes,'output byte bound');
 return freeze(result);
}
export function serializeBaseProviderCatalogDimensions(value){const b=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(b.length<=BASE_PROVIDER_CATALOG_DIMENSION_LIMITS.output_bytes);return b;}

/** Explicit file-only CLI. Import does not read, generate or write anything. */
export async function main(args){
 assert(args.length===1&&['--check','--write'].includes(args[0]),'usage: node tools/parity/base-provider-catalog-dimensions.mjs --check|--write');
 const root=fileURLToPath(new URL('../../',import.meta.url)),sources={};
 for(const [key,ref]of Object.entries(BASE_PROVIDER_CATALOG_DIMENSION_SOURCES)){
  const file=path.join(root,ref.path),s=await fs.lstat(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.size===ref.bytes&&s.size<=BASE_PROVIDER_CATALOG_DIMENSION_LIMITS.member_bytes);
  const h=await fs.open(file,'r');try{
   const same=t=>t.isFile()&&t.dev===s.dev&&t.ino===s.ino&&t.size===s.size&&t.mtimeMs===s.mtimeMs&&t.ctimeMs===s.ctimeMs;
   assert(same(await h.stat()),'source file identity');const b=Buffer.alloc(ref.bytes+1);let size=0;
   while(size<b.length){const r=await h.read(b,size,b.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}
   assert.equal(size,ref.bytes,'bounded exact source file');assert(same(await h.stat())&&same(await fs.lstat(file)),'source file changed');sources[key]=b.subarray(0,size);
  }finally{await h.close();}
 }
 const bytes=serializeBaseProviderCatalogDimensions(deriveBaseProviderCatalogDimensions(sources)),file=path.join(root,OUTPUT);
 if(args[0]==='--write')await fs.writeFile(file,bytes,{flag:'wx',mode:0o644});else {
  const s=await fs.lstat(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.size===bytes.length&&s.size<=BASE_PROVIDER_CATALOG_DIMENSION_LIMITS.output_bytes,'bounded publication');
  const h=await fs.open(file,'r');try{
   const same=t=>t.isFile()&&t.dev===s.dev&&t.ino===s.ino&&t.size===s.size&&t.mtimeMs===s.mtimeMs&&t.ctimeMs===s.ctimeMs;
   assert(same(await h.stat()));const b=Buffer.alloc(bytes.length+1);let size=0;
   while(size<b.length){const r=await h.read(b,size,b.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}
   assert(same(await h.stat())&&same(await fs.lstat(file)),'publication changed');assert.deepEqual(b.subarray(0,size),bytes,'committed dimensions must equal the deterministic source derivation');
  }finally{await h.close();}
 }
 return {status:'SOURCE_LISTING_DIMENSIONS_ONLY',bytes:bytes.length,sha256:sha(bytes),entries:2060,occurrences:2056,operation_rows_created:0,acceptance_granted:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
