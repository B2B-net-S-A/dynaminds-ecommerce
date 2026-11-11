/** Actual archived catalogue/source checks only; no network, account or operation acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {deriveBaseProviderCatalogDimensions as derive,serializeBaseProviderCatalogDimensions as serialize,BASE_PROVIDER_CATALOG_DIMENSION_SOURCES as pins,BASE_PROVIDER_CATALOG_DIMENSION_LIMITS as limits} from '../tools/parity/base-provider-catalog-dimensions.mjs';
import {baseCaptureSkip} from '../tools/parity/base-captures.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),read=p=>readFileSync(root+p),sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const skip=baseCaptureSkip(Object.values(pins).map(p=>p.path));
if(skip)test('Base catalogue listing dimensions are re-derived from the archived Base.com catalogue',{skip},()=>{});
else{
const digest=v=>sha(JSON.stringify(canonical(v))),sources=Object.fromEntries(Object.entries(pins).map(([key,p])=>[key,read(p.path)]));
const sourceHashes=Object.fromEntries(Object.entries(sources).map(([k,b])=>[k,sha(b)]));
const roster=JSON.parse(sources.roster),integrations=JSON.parse(sources.integrations),scope=JSON.parse(sources.scope),output=derive(sources);
const occurrence=n=>output.occurrences.find(c=>c.ordinal===n),entry=id=>output.entries.find(e=>e.entry_id===id);

test('all seven whole sources and frozen parent inputs produce the exact deterministic bounded supplement without mutation',()=>{
 const bytes=serialize(output);assert(bytes.length<=limits.output_bytes);assert.deepEqual(bytes,read('docs/parity/base-provider-catalog-dimensions.v1.json'));assert.deepEqual(bytes,serialize(derive(sources)));
 for(const[key,pin]of Object.entries(pins)){assert.equal(sources[key].length,pin.bytes);assert.equal(sha(sources[key]),pin.sha256);assert.equal(sha(sources[key]),sourceHashes[key]);}
 assert.equal(scope.inputs.providerRoster.sha256,pins.parentRoster.sha256);assert.equal(scope.inputs.integrations.sha256,pins.parentIntegrations.sha256);assert.equal(sha(sources.scope),'49d078d47a53438818bc375ea4489c0334eaafa3b57ba8d0ae7a0015969fecea');
 assert(Object.isFrozen(output)&&Object.isFrozen(output.occurrences[0].country_filter.tokens));assert.equal(output.summary.semantic_provider_count,null);
});

test('independent standard HTMLParser reproduces all2056 archived occurrences, exact attributes, nearest category and first link',()=>{
 const parser=String.raw`
import sys,json,gzip
from html.parser import HTMLParser
from urllib.parse import urljoin
class Cards(HTMLParser):
 def __init__(self):
  super().__init__(convert_charrefs=True);self.stack=[];self.cards=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs);parents=self.stack[:];card=None
  if 'data-name' in a and any('sort-integrations' in n['attrs'].get('class','').split() for n in parents):
   cat=next((n['attrs'].get('id') for n in reversed(parents) if 'sorting-part' in n['attrs'].get('class','').split()),None)
   card={'ordinal':len(self.cards)+1,'category':cat,'attrs':a,'urls':[]};self.cards.append(card)
  if tag=='a' and 'href' in a:
   for n in reversed(parents):
    if n['card'] is not None:
     if not n['card']['urls']:n['card']['urls']=[urljoin('https://base.com',a['href'])]
     break
  if tag not in {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}:self.stack.append({'tag':tag,'attrs':a,'card':card})
 def handle_startendtag(self,tag,attrs):
  self.handle_starttag(tag,attrs)
  if self.stack and self.stack[-1]['tag']==tag:self.stack.pop()
 def handle_endtag(self,tag):
  for i in range(len(self.stack)-1,-1,-1):
   if self.stack[i]['tag']==tag:self.stack=self.stack[:i];break
p=Cards();p.feed(gzip.decompress(sys.stdin.buffer.read()).decode('utf8'));print(json.dumps(p.cards,ensure_ascii=False))
`;
 const child=spawnSync('python3',['-c',parser],{input:sources.catalogHtmlGzip,maxBuffer:4*1024*1024,timeout:10000});assert.equal(child.status,0,child.stderr?.toString());const actual=JSON.parse(child.stdout);assert.equal(actual.length,2056);
 for(let i=0;i<actual.length;i++){const source=actual[i],row=output.occurrences[i];assert.equal(row.ordinal,source.ordinal);assert.equal(row.listing_category,source.category);assert.deepEqual(row.raw_attributes,source.attrs,'whole archived attribute map '+row.ordinal);assert.deepEqual(row.listing_urls,source.urls,'first actual href '+row.ordinal);}
});

test('entries, cards and autocomplete codes remain separate, exact joined dimensions with no orphan or invented provider denominator',()=>{
 assert.equal(output.entries.length,2060);assert.equal(output.occurrences.length,2056);assert.equal(new Set(output.entries.map(e=>e.entry_id)).size,2060);assert.equal(output.summary.additional_entries,1995);assert.equal(output.summary.preserved_prior_entries,65);assert.equal(output.summary.distinct_catalog_ids,2053);assert.equal(output.summary.distinct_listing_urls,2013);
 for(const e of output.entries){const source=roster.entries[Number(e.source_pointer.split('/').at(-1))];assert.equal(e.entry_id,source.id);assert.deepEqual(e.prior_registry_relationship,source.registry_relationship);assert.deepEqual(e.occurrence_ordinals,roster.catalog_cards.filter(c=>c.entry_id===source.id).map(c=>c.ordinal));assert.equal(e.cohort,source.observation.kind==='raw_html_catalog_card'?'additional_catalog_observation':'preserved_prior_observation');}
 for(const c of output.occurrences){assert(entry(c.entry_id));const match=roster.autocomplete_catalog.entries.find(a=>a.code===c.catalog_id);assert.equal(c.autocomplete_exact_code?.code??null,match?.code??null);if(match){assert.equal(c.autocomplete_exact_code.name,match.name);assert.equal(c.autocomplete_exact_code.logo,match.logo);}}
 assert.equal(entry('base.platform.base-analytics').occurrence_ordinals.length,0,'an observed detail without a main-listing card is retained');
});

test('archived country/category/search filters preserve missing, empty, case and all without inventing API entitlement',()=>{
 assert.deepEqual(output.summary.additional_country_filter_states,{observed:341,empty:1651,missing:3});
 for(const c of output.occurrences){const a=roster.catalog_cards[c.ordinal-1].attributes;assert.equal(c.country_filter.state,!Object.hasOwn(a,'data-countries')?'missing':a['data-countries']===''?'empty':'observed');assert.equal(c.country_filter.raw,a['data-countries']??null);assert.deepEqual(c.country_filter.tokens,a['data-countries']?a['data-countries'].split(',').map(s=>s.toUpperCase()):[]);assert.equal(c.availability_entitlement,'unknown');assert.equal(entry(c.entry_id).semantic.api_regions,'unknown');}
 assert.equal(occurrence(2054).country_filter.state,'missing');assert.equal(occurrence(906).country_filter.state,'empty');assert.deepEqual(occurrence(906).category_filter.tokens,['all']);assert.equal(occurrence(18).category_filter.raw,'fashion');assert(occurrence(18).country_filter.tokens.includes('UK'));assert(!occurrence(18).country_filter.tokens.includes('GB'));
 const script=gunzipSync(sources.catalogScriptGzip,{maxOutputLength:77696}).toString('utf8');assert(script.includes('getAttribute("data-countries").toUpperCase().split(",")'));assert(script.includes('getAttribute("data-categories").toLowerCase().split(",")'));assert(script.includes('getAttribute("data-tags").split(" ")'));
});

test('AmazonVendor22 observed filters do not inherit Seller operations, while Subiekt identical names and Centauro duplicate status remain unresolved',()=>{
 const vendor=occurrence(42);assert.equal(vendor.catalog_id,'amazon_vendor');assert.deepEqual(vendor.country_filter.tokens,['GB','DE','ES','FR','IT','NL','SE','PL','TR','BE','IN','AE','IE','EG','SA','US','CA','MX','BR','JP','AU','SG']);assert.equal(vendor.country_filter.tokens.length,22);assert.equal(entry(vendor.entry_id).semantic.operations,'unknown');assert.equal(entry(vendor.entry_id).prior_registry_relationship.provider_id,undefined);
 const a=occurrence(906),b=occurrence(1032);assert.equal(a.name,b.name);assert.notEqual(a.catalog_id,b.catalog_id);assert.notDeepEqual(a.listing_urls,b.listing_urls);assert.equal(entry(a.entry_id).semantic.operator,'unknown');assert.equal(entry(b.entry_id).semantic.api_version,'unknown');assert(output.conflicts.same_display_name_distinct_codes.some(g=>g.value==='Subiekt GT'&&g.members.some(m=>m.ordinal===906)&&g.members.some(m=>m.ordinal===1032)));
 assert.deepEqual(output.conflicts.repeated_catalog_ids.map(g=>g.value),['centauro2','meta','tallysolutions']);const centauro=output.conflicts.cross_category_same_catalog_id.find(g=>g.value==='centauro2');assert.deepEqual(centauro.members.map(c=>c.ordinal),[426,2054]);assert.equal(occurrence(426).availability_observation,'listed_in_category');assert.equal(occurrence(2054).availability_observation,'listed_in_comingsoon');assert(occurrence(426).listing_urls[0]===occurrence(2054).listing_urls[0]);
});

test('all182 Mirakl search-tag cards and the existing family registry link create no operator, operation or acceptance propagation',()=>{
 const tagged=output.occurrences.filter(c=>(c.search_terms.raw??'').toLowerCase().split(/\s+/).includes('mirakl'));assert.equal(tagged.length,182);const mirakl=entry('base.catalog.marketplace.mirakl');assert.equal(mirakl.prior_registry_relationship.provider_id,'mirakl');assert.equal(mirakl.prior_registry_relationship.scope,'family_only');assert.equal(mirakl.semantic.provider_identity,'unknown');
 for(const e of output.entries){assert(Object.values(e.semantic).every(v=>v==='unknown'));assert.equal(e.operation_rows_created,0);assert.equal(e.acceptance_granted,false);}for(const flag of ['inventory_complete','coverage_complete','implementation_acceptance','external_acceptance','business_acceptance'])assert.equal(output[flag],false);
});

test('all324 current integration rows, provider evidence and frozen statuses remain source-exact rather than being relabelled by listing dimensions',()=>{
 const p=output.preserved_integrations;assert.equal(p.rows,324);assert.equal(p.providers,15);assert.equal(p.whole_rows_canonical_sha256,digest(integrations.rows));assert.equal(p.whole_provider_rows_canonical_sha256,digest(integrations.providers));assert.equal(p.frozen_parent_rows_canonical_sha256,digest(JSON.parse(sources.parentIntegrations).rows));assert.equal(p.statuses_modified,false);assert.equal(p.operation_rows_created,0);assert.equal(p.external_sandbox_accepted_rows,0);assert.equal(p.external_account_accepted_rows,0);assert.equal(sha(sources.integrations),pins.integrations.sha256);assert.equal(sha(sources.parentIntegrations),pins.parentIntegrations.sha256);assert.equal(scope.acceptance_granted,false);
});

test('source API refuses missing/extra/tampered/oversized sources and accessor inputs without invoking getters',()=>{
 assert.throws(()=>derive({}),/exact source keys/);assert.throws(()=>derive({...sources,apiRegions:['all']}),/exact source keys/);const bad=Buffer.from(sources.roster);bad[10]^=1;assert.throws(()=>derive({...sources,roster:bad}),/source SHA/);assert.throws(()=>derive({...sources,roster:Buffer.alloc(limits.member_bytes+1)}),/bounded source/);assert.throws(()=>derive({...sources,roster:sources.roster.toString()}),/bounded source/);
 let called=false;const getter={...sources};Object.defineProperty(getter,'roster',{enumerable:true,get(){called=true;throw Error('getter');}});assert.throws(()=>derive(getter),/source data property/);assert.equal(called,false);
});

test('module import is inert and explicit file-only check validates the committed publication',()=>{
 const url=new URL('../tools/parity/base-provider-catalog-dimensions.mjs',import.meta.url).href;const child=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(url)});`],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
 const check=spawnSync(process.execPath,['tools/parity/base-provider-catalog-dimensions.mjs','--check'],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(check.status,0,check.stderr);const r=JSON.parse(check.stdout);assert.equal(r.status,'SOURCE_LISTING_DIMENSIONS_ONLY');assert.equal(r.acceptance_granted,false);assert.equal(r.operation_rows_created,0);assert.equal(r.sha256,sha(read('docs/parity/base-provider-catalog-dimensions.v1.json')));
});
}
