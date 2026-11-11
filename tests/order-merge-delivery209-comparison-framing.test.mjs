/** Comparison-only fixtures. Legacy descriptors/addition fillers are synthetic;
 * seven Source22 BEFOREs and the helper are derived from pinned authored204.
 * No live catalogue, Native acceptance, provider or HTTP execution is tested. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {frameOrderMergeDelivery209Comparison as frame} from '../tools/parity/order-merge-delivery209-comparison-framing.mjs';
import {ORDER_MERGE_DELIVERY209_CHANGED_FUNCTION_KEYS as legacyKeys} from '../tools/parity/order-merge-delivery209-inverse.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS as startupKeys} from '../tools/parity/order-merge-delivery209-startup-roster.mjs';
import {ORDER_MERGE_DELIVERY209_CHECK_EXPRESSIONS as expressions} from '../tools/parity/order-merge-delivery209-constraints.mjs';
import {deriveOrderMergeDelivery209StartupClosure as deriveStartup} from '../tools/parity/order-merge-delivery209-startup-capability-closure.mjs';

const clone=structuredClone,identity=r=>r.kind+'\0'+r.key;
const sorted=a=>a.sort((a,b)=>identity(a)<identity(b)?-1:identity(a)>identity(b)?1:0);
const fn=source=>({owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,
 leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,
 argument_names:null,argument_modes:null,arguments:'',result:'boolean',defaults:null,source,binary:null,
 config:['search_path=pg_catalog, public'],definition:'CREATE FUNCTION synthetic() RETURNS boolean AS $$'+source+'$$ LANGUAGE plpgsql',
 acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]});
const constraint=definition=>({kind:'c',deferrable:false,deferred:false,validated:true,local:true,
 inheritance_count:0,no_inherit:true,definition});
function legacy(){
 const changes=legacyKeys.map((key,i)=>({kind:'function',key,before:fn('BEGIN RETURN '+i+';END'),after:fn('BEGIN RETURN '+(i+10)+';END')}));
 for(const table of ['buyer_address_previews','buyer_address_receipts'])for(const role of ['kind','actor'])changes.push({
  kind:'constraint',key:'public.'+table+'.synthetic_'+role+'_check',
  before:constraint(expressions[role+'_before']),after:constraint(expressions[role+'_after'])});
 return {schema:'source209-order-merge-delivery-exact-inverse/v1',changes,removed:[],
  additions:[{kind:'relation',key:'public.order_merge_delivery209_synthetic',value:{synthetic:true}}]};
}
let startup;
function source22(){
 startup??=deriveStartup({source204:readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8')});
 const f=legacy();
 for(const r of startup.historical_predecessors){
  const before=clone(r.value),after=clone(before);after.source+='\n/* COMPARISON-ONLY SUCCESSOR */';
  after.definition=before.definition.replace(before.source,()=>after.source);
  f.changes.push({kind:r.kind,key:r.key,before,after});
 }
 // These filler records are only an exact framing-count exercise. They cannot
 // qualify as the independently compiled complete E209 addition expectation.
 f.additions=sorted([clone(startup.helpers[0]),...Array.from({length:258},(_,i)=>({
  kind:'relation',key:'public.order_merge_delivery209_synthetic_'+String(i).padStart(3,'0'),value:{synthetic:true}}))]);
 return f;
}

test('default14 retains complete comparison content and has no implicit22 or authority',()=>{
 const f=legacy(),before=JSON.stringify(f),r=frame(f);
 assert.deepEqual(r.expected,f);assert.equal(r.expected,r.inverseExpected);
 assert.equal(r.metadataOptions,undefined);assert.equal(r.inverseOptions,undefined);
 for(const flag of ['authority','native_acceptance','full_catalogue_checked','expected_provenance_authenticated'])assert.equal(r[flag],false);
 assert.equal(JSON.stringify(f),before);assert(!Object.isFrozen(f));assert(Object.isFrozen(r.expected.changes[0].before.acl));
 f.changes[0].before.source='POISON';assert(!JSON.stringify(r).includes('POISON'));
});

test('explicit22 splits the actual seven pinned source BEFOREs and exact helper, retaining all259 additions',()=>{
 const f=source22(),before=JSON.stringify(f),r=frame(f,{runtimeRevision:22});
 assert.equal(r.expected.changes.length,14);assert.equal(r.inverseExpected.changes.length,21);
 assert.equal(r.expected.additions.length,259);assert.equal(r.expected.additions,r.inverseExpected.additions);
 assert.deepEqual(r.metadataOptions.source22.changes.map(c=>c.key),startupKeys);
 assert.equal(r.metadataOptions.source22.additions.length,1);
 assert.equal(r.metadataOptions.source22.additions[0].key,'public.order_merge_delivery209_startup_operative_valid(entries jsonb)');
 assert.deepEqual(r.inverseOptions,{runtimeRevision:22});assert.equal(r.authority,false);
 assert.equal(JSON.stringify(f),before);assert(!Object.isFrozen(f));
 assert.throws(()=>frame(f));assert.throws(()=>frame(legacy(),{runtimeRevision:22}));
 // Source ordering may differ from the fixed startup stage; array values do not.
 const reversed=source22();reversed.changes.reverse();const rr=frame(reversed,{runtimeRevision:22});
 assert.deepEqual(rr.metadataOptions.source22.changes.map(c=>c.key),startupKeys);
 assert.deepEqual(rr.inverseExpected.changes,reversed.changes);
});

test('every independent BEFORE pin and exact startup helper header/body is required',()=>{
 const f=source22();
 for(const key of startupKeys){
  const bad=clone(f),c=bad.changes.find(c=>c.key===key);c.before.cost++;c.after.cost++;
  assert.throws(()=>frame(bad,{runtimeRevision:22}),key);
 }
 const h=f.additions.find(r=>r.key==='public.order_merge_delivery209_startup_operative_valid(entries jsonb)');
 for(const field of Object.keys(h.value)){
  const bad=clone(f),v=bad.additions.find(r=>r.key===h.key).value;
  v[field]=v[field]===null?'tamper':typeof v[field]==='boolean'?!v[field]:typeof v[field]==='number'?v[field]+1:typeof v[field]==='string'?v[field]+' ':[];
  assert.throws(()=>frame(bad,{runtimeRevision:22}),field);
 }
});

test('closed function/constraint/addition rosters refuse missing, duplicate, overload and old255 shape',()=>{
 const f=source22(),options={runtimeRevision:22};
 const mutations=[
  x=>x.changes.pop(),x=>{x.changes[0]=clone(x.changes[1]);},
  x=>{x.changes[0].key=x.changes[0].key.replace('()', '(extra text)');},
  x=>{x.changes[0].key='public.unreviewed_function()';},
  x=>{x.changes.find(c=>c.kind==='constraint').after.validated=false;},
  x=>{x.additions.splice(0,4);},x=>{x.additions[1]=clone(x.additions[0]);},
  x=>{x.additions.reverse();},
  x=>{x.additions.find(r=>r.key.includes('startup_operative_valid')).key='public.order_merge_delivery209_startup_operative_valid(extra text)';},
  x=>{x.removed.push({kind:'relation',key:'public.forbidden',value:{}});},
 ];
 for(const mutate of mutations){const bad=clone(f);mutate(bad);assert.throws(()=>frame(bad,options));}
 for(const options of [{runtimeRevision:21},{runtimeRevision:23},{runtimeRevision:22,valid:true},null])assert.throws(()=>frame(f,options));
});

test('complete legacy function headers/ACL and body-only definition equation remain enforced',()=>{
 const f=legacy();
 for(const mutate of [x=>{x.changes[0].after.cost++;},x=>{x.changes[0].after.acl=[];},
  x=>{x.changes[0].after.definition+=' ALTER';},x=>{delete x.changes[0].before.binary;},
  x=>{x.changes[0].after=clone(x.changes[0].before);}]){
  const bad=clone(f);mutate(bad);assert.throws(()=>frame(bad));
 }
});

test('plain bounded JSON refuses accessors without invoking them, sparse arrays and hidden input authority',()=>{
 let calls=0;const getter=legacy();Object.defineProperty(getter,'schema',{enumerable:true,get(){calls++;return 'secret';}});
 assert.throws(()=>frame(getter));assert.equal(calls,0);
 const sparse=legacy();delete sparse.changes[0];assert.throws(()=>frame(sparse));
 const hidden=legacy();Object.defineProperty(hidden,'secret',{value:true});assert.throws(()=>frame(hidden));
 const symbols=legacy();symbols[Symbol('proof')]=true;assert.throws(()=>frame(symbols));
 const malformed=legacy();malformed.additions[0].value.bad='\ud800';assert.throws(()=>frame(malformed));
 const huge=legacy();huge.additions[0].value.source='x'.repeat(8388609);assert.throws(()=>frame(huge));
 const extra=legacy();extra.source_compilation_proven=true;assert.throws(()=>frame(extra));
});

test('deep frozen expectations are reused, shallow frozen parents cannot retain mutable descendants',()=>{
 const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
 const immutable=freeze(legacy());assert.equal(frame(immutable).expected,immutable);
 const shallow=legacy();Object.freeze(shallow);const r=frame(shallow);
 shallow.changes[0].before.acl[0].grantee='POISON';assert(!JSON.stringify(r).includes('POISON'));
 assert(!Object.isFrozen(shallow.changes));assert.throws(()=>{r.expected.changes[0].before.acl[0].grantee='MUTATE';});
});
