/** Actual private startup bodies with controlled read-only ports. The eight209
 * descriptors are compiled source facts; the other20 entries are controlled
 * metadata. This is composition coverage, not PG, startup or business acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as E209,ORDER_MERGE_DELIVERY209_SOURCE_ORIGIN as ORIGIN} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {projectOrderMergeDelivery209Predecessors} from '../tools/parity/order-merge-delivery209-metadata.mjs';
import {frameOrderMergeDelivery209Comparison} from '../tools/parity/order-merge-delivery209-comparison-framing.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS} from '../tools/parity/order-merge-delivery209-startup-roster.mjs';
import {EMITTED209_SCHEMA} from '../tools/build/resource-format209.mjs';

const root=new URL('../',import.meta.url),sha=v=>createHash('sha256').update(v).digest('hex');
const historicalBytes=readFileSync(new URL('tests/fixtures/order-merge-delivery209-source21-contract.json.gz',root));
assert.equal(historicalBytes.length,2957592);assert.equal(sha(historicalBytes),'9188cfb3d23dabe095fa2af2cd4d91e805aff969f0565518d495169858f6497c');
const historicalDecoded=gunzipSync(historicalBytes,{maxOutputLength:22468966});
assert.equal(historicalDecoded.length,22468966);assert.equal(sha(historicalDecoded),'45c383e6af47e7f3d7ee35e92e91c147094c4bb6b60cd35cbc4a5ab506777bb6');
const E21=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(historicalDecoded));
const source=readFileSync(new URL('shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs',root),'utf8');
const sql170=readFileSync(new URL('server/170_pim_dictionaries.sql',root),'utf8');
const sql173=readFileSync(new URL('server/173_large_catalog_import_birth.sql',root),'utf8');
const names=[...sql170.split('CREATE FUNCTION pim_dictionary_predecessor_metadata()')[1].split('$$;')[0].match(/ARRAY\[([^\]]+)\]/)[1].matchAll(/'([a-z_0-9]+)'/g)].map(m=>m[1]);
const extra=[...sql173.split('CREATE FUNCTION public.large_import173_predecessor_map()')[1].split('$parents173$;')[0].matchAll(/'([a-z_0-9]+)',public.pim_dictionary_function_metadata/g)].map(m=>m[1]);
const roster=[...names,...extra].sort();assert.equal(roster.length,28);
const selectedFor=contract=>['buyer_address_guards','manual_inventory_off_valid',...(contract.changes.length===21?ORDER_MERGE_DELIVERY209_STARTUP_KEYS.map(k=>k.slice(7,k.indexOf('('))).filter(k=>roster.includes(k)):[])];
// Source170's actual JSON keys determine which fields its live map returns.
const metadataSql=sql170.split('CREATE FUNCTION pim_dictionary_function_metadata(function_oid oid)')[1].split('$$;')[0];
const build=metadataSql.slice(metadataSql.indexOf('SELECT jsonb_build_object(')+'SELECT jsonb_build_object('.length,metadataSql.indexOf(' FROM pg_proc'));
const parts=[];let depth=0,quoted=false,start=0;
for(let i=0;i<build.length;i++){
 const c=build[i];if(c==="'"){if(quoted&&build[i+1]==="'"){i++;continue;}quoted=!quoted;}
 if(quoted)continue;if(c==='(')depth++;if(c===')'){if(depth===0){parts.push(build.slice(start,i));break;}depth--;}
 if(c===','&&depth===0){parts.push(build.slice(start,i));start=i+1;}
}
const fields=parts.filter((_,i)=>i%2===0).map(s=>{const m=/^\s*'([a-z_0-9]+)'\s*$/.exec(s);assert(m);return m[1];});
assert.equal(fields.length,20);assert.equal(new Set(fields).size,20);
function metadata(name,side,contract=E209){
 const descriptor=contract.changes.find(c=>c.kind==='function'&&c.key==='public.'+name+'()')[side];
 return Object.fromEntries(fields.map(k=>[k,k==='signature'?name+'()':k==='configuration'?structuredClone(descriptor.config):k==='acl'?descriptor.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]):structuredClone(descriptor[k])]));
}
function frame(side='after',contract=E209){
 const selected=selectedFor(contract),template=metadata(selected[0],'before',contract);
 return Object.fromEntries(roster.map(name=>[name,selected.includes(name)?metadata(name,side,contract):{...structuredClone(template),signature:name+'()',definition:'CONTROLLED UNSELECTED '+name}]));
}
function actualBody(startToken,endToken,ports,name){
 const a=source.indexOf(startToken),b=source.indexOf(endToken,a);assert(a>=0&&b>a);
 return new Function(...Object.keys(ports),source.slice(a,b).replace(/^export /,'')+'\nreturn '+name+';')(...Object.values(ports));
}
function harness(current=frame(),contract=E209,runtimeRevision=22){
 const comparison209=frameOrderMergeDelivery209Comparison(contract,runtimeRevision===22?{runtimeRevision:22}:undefined);
 const profile={controlled:'external173'},original={controlled:'original173'};
 const originalText=JSON.stringify(original),historicalMap=JSON.stringify({controlled:'historical predecessor archive'});
 const certificate={profile_sha256:sha(originalText),predecessor_map:JSON.parse(historicalMap),predecessor_sha256:sha(historicalMap)};
 const expected={original_certificate:certificate,original_profile:original,successor_predecessors:frame('before',contract)};
 const cert={count:'1',certificate,original_native_text:originalText,predecessor_native_text:historicalMap,current_predecessors:current,valid:true};
 const input={owner:'postgres',catalog_sql:'SELECT controlled_profile',profile,profile_sha256:sha(JSON.stringify(profile)),compatibility:{controlled:'contract'}};
 const events=[],queries=[];
 const owner={async query(sql){queries.push(sql);assert(!/\b(?:UPDATE|INSERT|DELETE|ALTER|COMMIT|BEGIN)\b/.test(sql));
  if(sql.startsWith('SELECT current_user'))return{rows:[{current_role:'postgres',session_role:'postgres',role_setting:'none'}]};
  if(sql.startsWith('WITH external173'))return{rows:[{profile,native_text:JSON.stringify(profile),native_sha256:sha(JSON.stringify(profile))}]};
  assert(sql.includes('public.large_import173_predecessor_map()'));return{rows:[cert]};
 }};
 const ports={assert,sha,comparison209,assertOrdinary177Contract:(contract,actual)=>{assert.deepEqual(contract,input.compatibility);assert.deepEqual(actual,profile);return expected;},
  projectOrderMergeDelivery209Predecessors:(value,expectation,options)=>{events.push('209');assert.equal(expectation,comparison209.expected);assert.equal(options,comparison209.metadataOptions);return projectOrderMergeDelivery209Predecessors(value,expectation,options);},
  projectPackingOriginal173Predecessors:value=>{events.push('parent');assert.deepEqual(value,frame('before',contract));return value;}};
 const inspect=actualBody('async function inspectComparedProfile(','async function verifyEvidence',ports,'inspectComparedProfile');
 return{input,cert,expected,events,queries,run:()=>inspect(owner,input,'portable',()=>events.push('source'))};
}

test('actual startup projects all eight current209 map descriptors before the existing full28 comparison; old208 identity remains accepted',async()=>{
 for(const side of ['before','after']){
  const h=harness(frame(side)),saved=structuredClone(h.cert.current_predecessors),result=await h.run();
  assert.deepEqual(h.events,['source','209','parent']);assert.equal(h.queries.length,3);assert.deepEqual(h.cert.current_predecessors,saved);
  assert.equal(result.certified_graph,true);assert.equal(result.application_activation,false);
 }
});
test('actual startup keeps the independently pinned Source21 default14/two-descriptor path unchanged',async()=>{
 assert.equal(E21.changes.length,14);assert.equal(E21.additions.length,240);
 for(const side of ['before','after']){
  const h=harness(frame(side,E21),E21,21),result=await h.run();
  assert.deepEqual(h.events,['source','209','parent']);assert.equal(result.certified_graph,true);assert.equal(result.application_activation,false);
 }
});
test('actual source-owned initializer selects22 only from the imported origin, never observed map data',()=>{
 const declaration=source.match(/^const comparison209=frameOrderMergeDelivery209Comparison\([^\n]+;$/m)?.[0];assert(declaration);
 const initialize=new Function('frameOrderMergeDelivery209Comparison','E209','E209_ORIGIN',declaration+'\nreturn comparison209;');
 const current=initialize(frameOrderMergeDelivery209Comparison,E209,ORIGIN);assert.equal(current.inverseExpected.changes.length,21);assert.deepEqual(current.inverseOptions,{runtimeRevision:22});
 const historical=initialize(frameOrderMergeDelivery209Comparison,E21,{runtime_revision:21});assert.equal(historical.expected.changes.length,14);assert.equal(historical.inverseOptions,undefined);
 assert.throws(()=>initialize(frameOrderMergeDelivery209Comparison,E209,{runtime_revision:21}));
 assert.throws(()=>initialize(frameOrderMergeDelivery209Comparison,E21,{runtime_revision:22}));
});
test('actual startup refuses mixed209 descriptors and altered selected definition or ACL before parent projection',async()=>{
 for(const change of [v=>v.manual_inventory_off_valid=metadata('manual_inventory_off_valid','before'),v=>v.buyer_address_guards.definition+=' ',v=>v.manual_inventory_off_valid.acl.push(['postgres','PUBLIC','EXECUTE',false]),
  ...selectedFor(E209).slice(2).map(name=>v=>{v[name]=metadata(name,'before');}),
  v=>{v.parcel_physical_wz_valid.definition+=' ';}]){
  const current=frame();change(current);const h=harness(current);await assert.rejects(h.run());assert.deepEqual(h.events,['source','209']);
 }
});
test('the entire28 comparison retains unknown unselected drift and rejects missing or extra map entries',async()=>{
 const h=harness();h.expected.successor_predecessors.b2b_invoice_guards.definition+=' expected drift';
 await assert.rejects(h.run());assert.deepEqual(h.events,['source','209','parent']);
 const current=frame();current.b2b_invoice_guards.definition+=' observed drift';const drift=harness(current);
 await assert.rejects(drift.run());assert.deepEqual(drift.events,['source','209','parent']);
 for(const mutate of [v=>delete v.b2b_invoice_guards,v=>v.extra=structuredClone(v.b2b_invoice_guards)]){
  const value=frame();mutate(value);const invalid=harness(value);await assert.rejects(invalid.run());assert.deepEqual(invalid.events,['source','209']);
 }
});
test('native validity and literal historical certificate checks still reject after the209 integration',async()=>{
 for(const mutate of [h=>h.cert.valid=false,h=>h.cert.predecessor_native_text+=' ',h=>h.cert.original_native_text+=' ',h=>h.cert.count='2']){
  const h=harness();mutate(h);await assert.rejects(h.run());assert.equal(h.queries.length,3);
 }
});
test('actual portable constructor dispatches both emitted versions through the same validated loader and closing cut',async()=>{
 for(const schema of ['dynaminds-emitted-local-release/v1',EMITTED209_SCHEMA]){
  const events=[],raw=Buffer.from(JSON.stringify({schema})),profile={functions:[{owner:'postgres'}],relations:[{name:'large_import173_certificate',owner:'postgres'}]};
  const release={expectedProfile:profile,nativeContract:{functions:1,relations:1},catalogueSql:'SELECT controlled_profile',catalogueSha256:sha('SELECT controlled_profile'),compatibilityContract:{controlled:true}};
  const ports={assert,sha,EMITTED209_SCHEMA,exactKeys:(v,keys)=>assert.deepEqual(Object.keys(v).sort(),keys.slice().sort()),packageBytes:async(r,n)=>{assert.equal(r,'/controlled');assert.equal(n,'release.json');return raw;},loadValidatedEmittedRelease:async selection=>{events.push('validated-loader');assert.deepEqual(selection,{releaseDirectory:'/controlled',manifestSha:sha(raw)});return release;},closePortable:async state=>{events.push('closing-cut');assert.equal(state.packageKind,'emitted');assert.deepEqual(state.releaseCut,release);},mint:state=>state};
  const create=actualBody('export async function createPortableReviewedStartup(','/** Genuine injected owner reader',ports,'createPortableReviewedStartup');
  const state=await create({releaseDirectory:'/controlled',manifestSha:sha(raw),expectedOwner:'postgres'});
  assert.deepEqual(events,['validated-loader','closing-cut']);assert.equal(state.kind,'portable');state.assertSourceExpectation();
 }
});
