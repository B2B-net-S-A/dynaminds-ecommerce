/** Controlled source/equality proof only; no PG or runtime budget acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210MetadataCandidateFilter as derive,ORDER_SPLIT210_METADATA_CANDIDATE_FILTER_SOURCE as pins} from '../tools/parity/order-split210-metadata-candidate-filter.mjs';
import {deriveOrderSplit210Closure} from '../tools/parity/order-split210-closure.mjs';
import {projectOrderSplit210FinancialMetadataShape as financial} from '../tools/parity/order-split210-metadata-shapes.mjs';
import {projectOrderSplit210BuyerMetadataShape as buyer} from '../tools/parity/order-split210-buyer-metadata-shapes.mjs';
import {projectOrderSplit210OrdinaryMetadataShape as ordinary} from '../tools/parity/order-split210-ordinary-metadata-shapes.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
// Independent fixed Source26 CREATE; current closure output is not its authority.
const source26=gunzipSync(Buffer.from('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','base64'),{maxOutputLength:18638}).toString('utf8');
const result=derive(source26),read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const fixture=/gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:131072\}\)/.exec(read('tests/order-split210-layer.test.mjs'));assert(fixture);
const sourceBundle=JSON.parse(gunzipSync(Buffer.from(fixture[1],'base64'),{maxOutputLength:131072}));
const names={source104:'104_order_merge_custody.sql',source108:'108_b2b_dropshipping.sql',source160:'160_b2b_credit.sql',source169:'169_manual_inventory_off.sql',source204:'204_partial_commercial_sale_scope.sql'};
const inputs={sourceBundle,businessInputs:Object.fromEntries(Object.entries(names).map(([k,v])=>[k,read('server/'+v)])),source158:read('server/158_fa3_draft_native.sql'),source159:read('server/159_b2b_invoice.sql'),source210:read('tools/parity/order-split210-business.sql'),sourceSchema:read('server/schema.sql')};
// Genuine source-only descriptors/refs, never a captured target catalogue.
const closure=deriveOrderSplit210Closure(inputs),data=closure.logical_data;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const eq=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const fields=[['definition','definition'],['owner','owner'],['language','language'],['volatility','volatility'],['strict','strict'],['leakproof','leakproof'],['security_definer','security_definer'],['parallel','parallel'],['kind','kind'],['returns_set','returns_set'],['arguments','arguments'],['result','result'],['argument_modes','argument_modes'],['argument_names','argument_names'],['defaults','defaults'],['configuration','config'],['cost','cost'],['rows','rows']];
const SQL_NULL=Symbol('SQL NULL/no projection');
const shape=(v,ref)=>({signature:ref.signature,...Object.fromEntries(fields.map(([to,from])=>[to,v[from]])),acl:v.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]),...(ref.body_sha256?{body_sha256:sha(v.source)}:{})});
const groups=result.candidate_filter.keys.map(key=>{const raw=data.changes.find(c=>c.key===key);assert(raw);return{key,change:Object.fromEntries(['kind','key','before','after'].map(k=>[k,raw[k]])),refs:data.metadata_compact_shapes.filter(r=>r.key===key)};});
const ancestor=data.metadata_ancestor_records.find(r=>r.key==='public.buyer_address_guards()'&&typeof r.value.source==='string').value;
function forms(g,ref){return [shape(g.change.before,ref),shape(g.change.after,ref),...(g.key==='public.buyer_address_guards()'?[shape(ancestor,ref)]:[])];}
const selected=(refs,value)=>refs.filter(r=>r.signature===value.signature&&r.body_sha256===Object.hasOwn(value,'body_sha256'));
function project(g,value,filtered){
 if(value===SQL_NULL||!value||typeof value!=='object'||Array.isArray(value)||!g.refs.some(r=>r.signature===value.signature))return SQL_NULL;
 const refs=filtered?selected(g.refs,value):g.refs;
 for(const ref of refs){const [before,after,old]=forms(g,ref);if(eq(value,after)||eq(value,before))return before;if(old&&eq(value,old))return value;}
 throw Object.assign(new Error('strict complete shape refusal'),{code:'55000'});
}
function both(g,value){const before=project(g,value,false),after=project(g,value,true);assert(eq(before,after));return after;}

test('three ref-loop edits invert the whole independently pinned Source26 SQL',()=>{
 assert.equal(Buffer.byteLength(source26),18638);assert.equal(sha(source26),pins.sha256);assert.equal(result.edits.length,3);let restored=result.sql;
 for(const e of [...result.edits].reverse()){assert.equal(restored.slice(e.afterStart,e.afterStart+e.after.length),e.after);restored=restored.slice(0,e.afterStart)+e.before+restored.slice(e.afterStart+e.after.length);}
 assert.equal(restored,source26);assert.equal(result.bytes,Buffer.byteLength(result.sql));assert.equal(result.sha256,sha(result.sql));
 assert.equal((source26.match(/jsonb_build_object\('signature',item->'signature',/g)||[]).length,7);assert.equal((result.sql.match(/jsonb_build_object\('signature',item->'signature',/g)||[]).length,7);
});

test('all seven current form expressions, seventeen terminal results, fresh guard and DFS stay byteexact',()=>{
 const terminals=s=>[...s.matchAll(/walk_projection:=\(([^\n]*?)\);EXIT metadata_node;/g)].map(m=>m[1]);assert.equal(terminals(source26).length,17);assert.deepEqual(terminals(result.sql),terminals(source26));
 for(const needle of ['PERFORM public.order_split210_require();','SELECT payload_jsonb INTO STRICT entries FROM public.order_split210_projection_basis WHERE id;','WHILE cardinality(walk_nodes)>0 LOOP','ORDER BY e.ord DESC','walk_changed:=true;',"USING ERRCODE='55000'"]){assert(source26.includes(needle));assert.equal(source26.split(needle).length,result.sql.split(needle).length);}
 for(const e of result.edits){assert(e.before.startsWith('   FOR item IN SELECT v'));assert(e.after.includes("v->>'signature'=order_split210_try_metadata_projection.value->>'signature'"));assert(e.after.includes("v->'body_sha256'=to_jsonb(order_split210_try_metadata_projection.value ? 'body_sha256')"));}
 // Historical Source26 basis pin; the current basis is the later definition-codec physical DATA.
 assert.equal(result.source_proofs.unchanged_basis_bytes,4193843);assert.equal(result.source_proofs.unchanged_basis_sha256,'0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7');
 assert.deepEqual({bytes:closure.projection_basis.bytes,sha256:closure.projection_basis.sha256},closure.definition_codec.physical_data);
});

test('actual source refs are closed2signature×2keyset variants and each excluded form is structurally unequal',()=>{
 for(const g of groups){assert(g.change);assert.equal(g.refs.length,4);assert.deepEqual(g.refs.map(r=>r.body_sha256),[false,true,false,true]);assert.equal(new Set(g.refs.map(r=>r.signature)).size,2);
  for(const ref of g.refs)for(const value of forms(g,ref)){
   const candidates=selected(g.refs,value);assert.equal(candidates.length,1);assert.strictEqual(candidates[0],ref);
   assert.deepEqual(candidates,g.refs.filter(r=>r===ref),'ordered original subset');assert.equal(Object.keys(value).length,ref.body_sha256?21:20);
   for(const excluded of g.refs.filter(r=>!candidates.includes(r)))for(const other of forms(g,excluded)){
    assert(!eq(value,other));assert(other.signature!==value.signature||Object.hasOwn(other,'body_sha256')!==Object.hasOwn(value,'body_sha256'));
   }
  }
 }
});

test('all28 actual source before/after/buyer208 shapes agree with the original ordered classifier and independent models',()=>{
 let count=0;for(const g of groups)for(const ref of g.refs)for(const value of forms(g,ref)){
  const output=both(g,value);const expected=g.key.includes('financial_return')?financial({change:g.change,value}):g.key.includes('ordinary181')?ordinary({change:g.change,value}):buyer({change:g.change,ancestor208:ancestor,value});
  assert(eq(output,expected));if(g.key==='public.buyer_address_guards()'&&eq(value,shape(ancestor,ref)))assert.strictEqual(output,value,'buyer208 identity marker preserved');count++;
 }
 assert.equal(count,28);
});

test('NULL/JSONnull/unknown containers/signatures/full24 records remain outside these three compact branches',()=>{
 for(const g of groups)for(const value of [SQL_NULL,null,false,0,'financial_return_upgrade_valid()',[],{}, {signature:'public.foreign()'}, {signature:null},{signature:0},{signature:g.refs[0].signature+' '},g.change.before,g.change.after])assert.strictEqual(both(g,value),SQL_NULL);
 // This is ONLY the compact branch scope. Earlier full24 canonical classifiers
 // remain literally unchanged in SQL; no runtime metadata admission is inferred.
});

test('wrong/null/nonstring body hashes and every header/ACL/definition/extra-field drift retain strict refusal',()=>{
 for(const g of groups)for(const ref of g.refs){
  const base=shape(g.change.after,ref);for(const mutate of [v=>v.owner='foreign',v=>v.definition+=' ',v=>v.acl=[],v=>v.configuration=null,v=>v.extra='unknown',v=>v.body_sha256=null,v=>v.body_sha256=false,v=>v.body_sha256=1,v=>v.body_sha256='0'.repeat(64),v=>delete v.arguments]){
   const value=structuredClone(base);mutate(value);for(const filtered of [false,true])assert.throws(()=>project(g,value,filtered),e=>e.code==='55000');
  }
 }
});

test('scope is never widened by signature choice and representation filtering never normalizes foreign metadata',()=>{
 for(const g of groups){const value=shape(g.change.after,g.refs[0]);value.signature='public.foreign()';assert.strictEqual(both(g,value),SQL_NULL);
  const poison=shape(g.change.after,g.refs[0]);poison.signature=g.refs.at(-1).signature;poison.definition='foreign body';for(const filtered of [false,true])assert.throws(()=>project(g,poison,filtered),e=>e.code==='55000');
 }
 // The source input API invokes neither accessors nor caller coercion.
 let called=false;const poison={get sql(){called=true;throw Error('getter');},toString(){called=true;throw Error('coercion');}};assert.throws(()=>derive(poison),/SQL string/);assert.equal(called,false);
});

test('source-bound candidate enumeration removes only impossible comparisons without eager caching',()=>{
 for(const g of groups){const poison={signature:g.refs[0].signature};assert.equal(g.refs.length,4);assert.equal(selected(g.refs,poison).length,1);
  const oldForms=g.refs.flatMap(r=>forms(g,r)),newForms=selected(g.refs,poison).flatMap(r=>forms(g,r));assert.equal(oldForms.length,4*newForms.length);
  for(const omitted of oldForms.filter(f=>!newForms.some(v=>eq(v,f))))assert(!eq(poison,omitted));
 }
 assert.equal(result.candidate_filter.eager_form_cache,false);assert.equal(result.cross_invocation_cache,false);assert.equal(result.new_runtime_functions,0);
});

test('fixed primitive-only source refuses tampering, extra authority args and unchanged historical input sizes',()=>{
 for(const value of [undefined,null,{},[],new String(source26),source26+'\n',source26.replace('STABLE','VOLATILE'),source26.replace("ERRCODE='55000'","ERRCODE='00000'")])assert.throws(()=>derive(value));
 assert.throws(()=>derive(source26,{}),/exactly one/);assert.throws(()=>derive(),/exactly one/);assert(Object.isFrozen(result)&&Object.isFrozen(result.edits)&&Object.isFrozen(result.candidate_filter.keys));
 for(const flag of ['source_data_changed','source_compilation_performed','native_certification','application_activation','business_acceptance'])assert.equal(result[flag],false);
});
