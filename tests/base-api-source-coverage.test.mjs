/** Stored official-document integrity only; no network/account or implementation acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {baseCaptureSkip} from '../tools/parity/base-captures.mjs';
const root=new URL('../docs/parity/',import.meta.url),read=n=>fs.readFileSync(new URL(n,root)),sha=b=>createHash('sha256').update(b).digest('hex');
const coverage=JSON.parse(read('base-api-source-coverage-20261018.json')),index=JSON.parse(read(coverage.index.path));
const skip=baseCaptureSkip(coverage.bundles.map(b=>'docs/parity/'+b.path));
function archived(){
 const names=fs.readdirSync(root).filter(n=>/^base-api-.*-sources-\d{8}\.json\.gz$/.test(n)).sort(),documents=new Map(),bundles=[];
 for(const name of names){const b=read(name);assert(b.length<1024*1024);const v=JSON.parse(gunzipSync(b,{maxOutputLength:4*1024*1024}));assert(Array.isArray(v.documents));let count=0;
  for(const d of v.documents){if(!Object.hasOwn(d,'method'))continue;assert(!documents.has(d.method),'duplicate method archive');documents.set(d.method,{bundle:name,document:d});count++;}
  bundles.push({path:name,bytes:b.length,sha256:sha(b),individual_html_methods:count});
 }return{documents,bundles};
}
test('current coverage is recomputed from every actual stored bundle and the frozen index, not mirrored counts',{skip},()=>{
 const {documents,bundles}=archived();assert.equal(sha(read(coverage.index.path)),coverage.index.sha256);assert.equal(read(coverage.index.path).length,coverage.index.bytes);
 assert.deepEqual([...documents.keys()].sort(),index.methods.map(m=>m.method).sort());assert.equal(documents.size,index.methods.length);assert.equal(coverage.index.methods,index.methods.length);
 assert.deepEqual(coverage.bundles,bundles);assert.equal(coverage.individual_html_methods,documents.size);assert.equal(coverage.missing_individual_html_methods,index.methods.filter(m=>!documents.has(m.method)).length);assert.deepEqual(coverage.remaining,[]);
 const expected=[...documents].sort(([a],[b])=>a.localeCompare(b,'en')).map(([method,{bundle,document:d}])=>({method,bundle,html_sha256:d.sha256,html_bytes:d.bytes,retrieved_at:d.retrieved_at}));
 // Existing Python/JS binary ASCII order agrees for the fixed Base method names.
 expected.sort((a,b)=>a.method<b.method?-1:a.method>b.method?1:0);assert.deepEqual(coverage.covered,expected);
});
test('all individual HTML payloads have genuine byte/hash, official source URLs, recorded redirect/status facts and capture dates',{skip},()=>{
 const {documents}=archived();let checked=0;
 for(const row of index.methods){const {bundle,document:d}=documents.get(row.method);assert.equal(d.method,row.method);
  // The frozen Returns21 archive predates the html_utf8 field name.
  const legacy=bundle==='base-api-return-sources-20261017.json.gz';assert.equal(Object.hasOwn(d,'html_utf8'),!legacy);assert.equal(Object.hasOwn(d,'html'),legacy);const text=legacy?d.html:d.html_utf8;assert.equal(typeof text,'string');const html=Buffer.from(text,'utf8');assert.equal(html.length,d.bytes);assert.equal(sha(html),d.sha256);
  assert.equal(d.url,row.source_url);const clientArchive=bundle==='base-api-client-sources-20261017.json.gz';assert.equal(Object.hasOwn(d,'final_url'),!clientArchive);assert.equal(Object.hasOwn(d,'http_status'),!clientArchive);for(const value of[d.url,...(clientArchive?[]:[d.final_url])]){const u=new URL(value);assert.equal(u.protocol,'https:');assert.equal(u.hostname,'api.baselinker.com');assert.equal(u.pathname,'/index.php');assert.equal(u.searchParams.get('method'),row.method);assert(!u.username&&!u.password&&!u.hash);}
  if(!clientArchive)assert.equal(d.http_status,200);assert(Number.isFinite(Date.parse(d.retrieved_at)));assert(text.includes(row.method));checked++;
 }assert.equal(checked,index.methods.length);
 const gaps={final_url_not_recorded:[],http_status_not_recorded:[]};for(const[method,{document:d}]of documents)for(const[key,name]of[['final_url','final_url_not_recorded'],['http_status','http_status_not_recorded']])if(!Object.hasOwn(d,key))gaps[name].push(method);for(const rows of Object.values(gaps))rows.sort();assert.deepEqual(coverage.source_metadata_gaps,gaps);

});
test('the exact historical145/59 artifact and every prior bundle/page fact remain intact; acceptance stays false',()=>{
 const ref=coverage.historical_snapshot,b=read(ref.path),old=JSON.parse(b);assert.equal(b.length,ref.bytes);assert.equal(sha(b),ref.sha256);assert.equal(old.individual_html_methods,145);assert.equal(old.missing_individual_html_methods,59);assert.equal(ref.status,'HISTORICAL_SOURCE_PROJECTION_NOT_CURRENT');
 assert.deepEqual(coverage.index,old.index);for(const r of old.bundles)assert.deepEqual(coverage.bundles.find(x=>x.path===r.path),r);for(const r of old.covered)assert.deepEqual(coverage.covered.find(x=>x.method===r.method),r);
 for(const key of['documentation_only','implementation_coverage_measured','wire_acceptance','provider_account_acceptance','acceptance_granted'])assert.equal(coverage[key],old[key]);assert.equal(coverage.documentation_only,true);for(const k of['implementation_coverage_measured','wire_acceptance','provider_account_acceptance','acceptance_granted'])assert.equal(coverage[k],false);
});
