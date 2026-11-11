/** Controlled source-equivalence tests. No PG or Native/performance proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210MetadataTraversal as derive,ORDER_SPLIT210_METADATA_TRAVERSAL_SOURCE as pins} from '../tools/parity/order-split210-metadata-traversal.mjs';
import {deriveOrderSplit210Closure,orderSplit210TaggedDescriptor as tagged,projectOrderSplit210ChangedFunctions} from '../tools/parity/order-split210-closure.mjs';
import {projectOrderSplit210FinancialMetadataShape as financial} from '../tools/parity/order-split210-metadata-shapes.mjs';
import {projectOrderSplit210BuyerMetadataShape as buyer} from '../tools/parity/order-split210-buyer-metadata-shapes.mjs';
import {projectOrderSplit210OrdinaryMetadataShape as ordinary} from '../tools/parity/order-split210-ordinary-metadata-shapes.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from '../tools/parity/order-merge-delivery209-history-closure.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
// Fixed independently authored Source24 full CREATE, not current closure output.
const source24=gunzipSync(Buffer.from('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','base64'),{maxOutputLength:16192}).toString('utf8');
assert.equal(Buffer.byteLength(source24),16192);assert.equal(sha(source24),pins.sha256);
const result=derive(source24),read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
// Current closure is used ONLY for real immutable source metadata fixtures.
// Its SQL output is never the BEFORE expectation; integration may wrap it.
const match=/gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:131072\}\)/.exec(read('tests/order-split210-layer.test.mjs'));assert(match);
const sourceBundle=JSON.parse(gunzipSync(Buffer.from(match[1],'base64'),{maxOutputLength:131072}));
const names={source104:'104_order_merge_custody.sql',source108:'108_b2b_dropshipping.sql',source160:'160_b2b_credit.sql',source169:'169_manual_inventory_off.sql',source204:'204_partial_commercial_sale_scope.sql'};
const inputs={sourceBundle,businessInputs:Object.fromEntries(Object.entries(names).map(([k,v])=>[k,read('server/'+v)])),source158:read('server/158_fa3_draft_native.sql'),source159:read('server/159_b2b_invoice.sql'),source210:read('tools/parity/order-split210-business.sql'),sourceSchema:read('server/schema.sql')};
const closure=deriveOrderSplit210Closure(inputs),entries=closure.logical_data;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const eq=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const SQL_NULL=Symbol('SQL NULL: no projection'),NOT_TERMINAL=Symbol('descend original container');
const buyerKey='public.buyer_address_guards()',financialKey='public.financial_return_upgrade_valid()',ordinaryKey='public.ordinary181_financial_valid(manual_basis jsonb)';
const changes=new Map(entries.changes.map(c=>[c.key,c]));
const prefixes=entries.metadata_keys.map(k=>k.slice(7,k.indexOf('('))+'(');
const relevant=v=>v!==SQL_NULL&&prefixes.some(p=>JSON.stringify(v).includes(p));
const fail=()=>{throw Object.assign(new Error('Split210 source closure is unsealed or changed'),{code:'55000'});};
function classify(v){
 if(v&&typeof v==='object'&&!Array.isArray(v)){
  if(v.kind==='function'&&entries.metadata_keys.includes(v.key)){
   const c=changes.get(v.key),record=value=>({kind:'function',key:c.key,value});
   if(eq(v,record(c.before)))return v;
   if(c.key===buyerKey&&(eq(v,record(c.before_check))||eq(v,record(c.after_check))))return entries.metadata_ancestor_records.find(x=>Array.isArray(x.value.source)&&Array.isArray(x.value.definition));
   if(eq(v,record(c.before_check)))return v;
   if(eq(v,record(c.after)))return record(c.before);
   if(eq(v,record(c.after_check)))return record(c.before_check);
   if(entries.metadata_ancestor_records.some(x=>eq(x,v)))return v;return fail();
  }
  for(const [key,project]of [[financialKey,financial],[buyerKey,buyer],[ordinaryKey,ordinary]]){
   if(entries.metadata_compact_shapes.some(x=>x.key===key&&x.signature===v.signature)){
    const row=changes.get(key),c={kind:row.kind,key:row.key,before:row.before,after:row.after};return project(key===buyerKey?{change:c,ancestor208:entries.metadata_ancestor_records.find(x=>!Array.isArray(x.value.source)).value,value:v}:{change:c,value:v});
   }
  }
  if(entries.metadata.some(x=>x.after.signature===v.signature)){
   const found=entries.metadata.find(x=>eq(x.after,v)||eq(x.before,v));if(found)return found.before;
   if(entries.metadata_ancestor_shapes.some(x=>eq(x,v)))return v;return fail();
  }
  return NOT_TERMINAL;
 }
 if(Array.isArray(v))return NOT_TERMINAL;
 if(typeof v==='string'){
  for(const c of entries.changes.filter(x=>entries.metadata_literal_keys.includes(x.key)))for(const f of ['source','definition']){if(v===c.after[f])return c.before[f];if(v===c.before[f])return v;}
  const found=entries.metadata_literals.find(x=>x.after===v);return found?found.before:SQL_NULL;
 }
 return SQL_NULL;
}
const children=v=>Array.isArray(v)?v.map((value,i)=>[String(i),value]):Object.entries(v);
function recursive(v,ctx,path=[]){
 if(!relevant(v))return SQL_NULL;ctx.guard();ctx.trace.push(path.join('/'));
 const terminal=classify(v);if(terminal!==NOT_TERMINAL)return terminal;
 let changed=false;const out=Array.isArray(v)?[]:Object.create(null);
 for(const[k,item]of children(v)){const projected=recursive(item,ctx,[...path,k]);if(projected!==SQL_NULL)changed=true;out[k]=projected===SQL_NULL?item:projected;}
 return changed?out:SQL_NULL;
}
function iterative(v,ctx){
 if(!relevant(v))return SQL_NULL;ctx.guard();let root=structuredClone(v),changed=false;const stack=[[[],v]];
 while(stack.length){const[path,node]=stack.pop();if(!relevant(node))continue;ctx.trace.push(path.join('/'));const projected=classify(node);
  if(projected!==NOT_TERMINAL){if(projected!==SQL_NULL){changed=true;if(!eq(projected,node)){if(!path.length)root=projected;else{let parent=root;for(const k of path.slice(0,-1))parent=parent[k];parent[path.at(-1)]=projected;}}}continue;}
  for(const[k,item]of children(node).reverse())stack.push([[...path,k],item]);
 }
 return changed?root:SQL_NULL;
}
const context=()=>{const c={calls:0,trace:[]};c.guard=()=>{c.calls++;};return c;};
function same(v){const before=context(),after=context(),a=recursive(v,before),b=iterative(v,after);assert(a===SQL_NULL?b===SQL_NULL:eq(a,b));assert.deepEqual(after.trace,before.trace);assert.equal(after.calls,relevant(v)?1:0);return{a,b,before,after};}
const pim=(c,side,ref)=>{const v=c[side];return{signature:ref.signature,definition:v.definition,owner:v.owner,language:v.language,volatility:v.volatility,strict:v.strict,leakproof:v.leakproof,security_definer:v.security_definer,parallel:v.parallel,kind:v.kind,returns_set:v.returns_set,arguments:v.arguments,result:v.result,argument_modes:v.argument_modes,argument_names:v.argument_names,defaults:v.defaults,configuration:v.config,cost:v.cost,rows:v.rows,acl:v.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]),...(ref.body_sha256?{body_sha256:sha(v.source)}:{})};};
const body=s=>s.slice(s.indexOf('$closure210$')+12,s.lastIndexOf('$closure210$'));
const executable=s=>spans(s).map(p=>p.executable?p.text:p.text.replace(/[^\n]/g,' ')).join('');

test('fixed authored full CREATE and22 disjoint edits reverse every byte including header and suffix',()=>{
 assert.equal(pins.bytes,16192);assert.equal(pins.sha256,'a06f8c1eaff7701be568309d312bd9ddfac375334c3557c04d5dc8cbdc623513');
 let inverse=result.sql;assert.equal(result.edits.length,22);let last=0;
 for(const e of result.edits){assert(e.beforeStart>=last);assert.equal(source24.slice(e.beforeStart,e.beforeStart+e.before.length),e.before);last=e.beforeStart+e.before.length;}
 for(const e of [...result.edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}
 assert.equal(inverse,source24);assert.equal(result.header_and_suffix_preserved,true);assert.equal(result.whole_source_inverse_verified,true);
 assert(result.sql.startsWith(source24.slice(0,source24.indexOf('$closure210$')+12)));assert(result.sql.endsWith('$closure210$;\n'));
 assert.equal(result.bytes,18515);assert.equal(result.sha256,'340a48e3fc8882323372a636d45631722e21f0bf22d5bad1f1e4617c3f58df0f');
});
test('all17 terminal expressions and original classifier order survive; only recursive container engines change',()=>{
 const returns=result.edits.filter(e=>e.kind==='exact_terminal_return');assert.equal(returns.length,17);
 for(const e of returns){const expression=e.before.slice('RETURN'.length,-1).trim();assert.equal(e.after,'walk_projection:=('+expression+');EXIT metadata_node;');}
 const branches=["IF value->>'kind'='function'",'-- Whole financial PIM','-- Whole buyer PIM','-- Whole ordinary PIM',"entries->'metadata')", "ELSIF jsonb_typeof(value)='array'", "ELSIF jsonb_typeof(value)='string'"];
 let before=-1,after=-1;for(const needle of branches){const a=source24.indexOf(needle),b=result.sql.indexOf(needle);assert(a>before&&b>after,needle);before=a;after=b;}
 const oldCode=executable(body(source24)),newCode=executable(body(result.sql));
 assert.equal((oldCode.match(/public\.order_split210_try_metadata_projection\(/g)||[]).length,2);
 assert.equal((newCode.match(/public\.order_split210_try_metadata_projection\(/g)||[]).length,0);
 assert.equal((newCode.match(/order_split210_require\(/g)||[]).length,1);
 assert.equal((newCode.match(/SELECT payload_jsonb INTO STRICT entries/g)||[]).length,1);
 assert(newCode.indexOf('order_split210_require(')<newCode.indexOf('WHILE cardinality(walk_nodes)'));
 assert(newCode.indexOf('SELECT payload_jsonb INTO STRICT entries')<newCode.indexOf('WHILE cardinality(walk_nodes)'));
 assert.equal((newCode.match(/RETURN/g)||[]).length,3,'only original root cheap NULL and final value/NULL leave the function');
});
test('actual source raw/tagged BEFORE/AFTER and fixed buyer208 ancestors are terminal whole-record cases',()=>{
 for(const key of entries.metadata_keys){const c=changes.get(key);for(const side of ['before','after','before_check','after_check']){
  const value={kind:'function',key,value:c[side]},run=same(value);assert.notEqual(run.b,SQL_NULL);assert.deepEqual(run.after.trace,[''],'terminal nodes never descend into projected BEFORE');
 }}
 for(const ancestor of entries.metadata_ancestor_records){const run=same(ancestor);assert(eq(run.b,ancestor));assert.deepEqual(run.after.trace,['']);}
 const c=changes.get(buyerKey),expected=entries.metadata_ancestor_records.find(x=>Array.isArray(x.value.source));
 for(const side of ['before_check','after_check'])assert(eq(same({kind:'function',key:buyerKey,value:c[side]}).b,expected),'buyer tagged path remains fixed208, not mixed source/definition hashes');
});
test('all real compact four-shape PIM variants and literal metadata/scalar leaves remain source-equivalent',()=>{
 for(const key of [financialKey,buyerKey,ordinaryKey]){const c=changes.get(key);for(const ref of entries.metadata_compact_shapes.filter(x=>x.key===key))for(const side of ['before','after']){
  const value=pim(c,side,ref),run=same(value);assert(eq(run.b,pim(c,'before',ref)));assert.deepEqual(run.after.trace,['']);
 }}
 for(const pair of entries.metadata)for(const side of ['before','after'])assert(eq(same(pair[side]).b,pair.before));
 for(const pair of entries.metadata_literals)assert.equal(same(pair.after).b,pair.before);
 for(const key of entries.metadata_literal_keys){const c=changes.get(key);for(const f of ['source','definition'])for(const side of ['before','after'])assert.equal(same(c[side][f]).b,c.before[f]);}
});
test('nested mixed arrays/objects preserve exact depth-first original enumeration and identity matches',()=>{
 const c=changes.get(financialKey),value={b:[null,{kind:'function',key:financialKey,value:c.after},false],aa:{unrelated:'kept',same:{kind:'function',key:financialKey,value:c.before}}};
 const run=same(value);assert(run.before.calls>run.after.calls);assert.equal(run.after.calls,1);assert.equal(run.b.b[0],null);assert.equal(run.b.b[2],false);assert.equal(run.b.aa.unrelated,'kept');
 assert.deepEqual(run.after.trace,['','b','b/1','aa','aa/same'],'do not sort keys lexically: b precedes aa in the original supplied enumeration');
 for(const kind of ['original_object_children_reverse_push','original_array_children_reverse_push']){
  const sql=result.edits.find(e=>e.kind===kind).after;assert(sql.includes('WITH ORDINALITY'));assert(sql.includes('ORDER BY e.ord DESC'));assert(!sql.includes('ORDER BY e.key'));
 }
 assert(result.sql.includes('walk_nodes:=array_append(walk_nodes,walk_child.value)'));
 assert(result.sql.includes('walk_path||jsonb_build_array(walk_child.key)'));
 assert(result.sql.includes('jsonb_set(walk_root,walk_text_path,walk_projection,false)'));
 assert(result.sql.includes('IF jsonb_array_length(walk_path)=0 THEN walk_root:=walk_projection;'));
});
test('recognized poisoned parent refuses before children; mixed descriptor/ACL/header/hash or PIM cannot be normalized',()=>{
 const c=changes.get(financialKey),ref=entries.metadata_compact_shapes.find(x=>x.key===financialKey),poison=[];
 for(const mutate of [v=>v.value.owner='foreign',v=>v.value.acl=[],v=>v.value.source+=' ']){const v={kind:'function',key:financialKey,value:structuredClone(c.after)};mutate(v);v.child={kind:'function',key:financialKey,value:c.before};poison.push(v);}
 const mixed={kind:'function',key:financialKey,value:{...c.after_check,definition:c.before_check.definition}};poison.push(mixed);
 const bad=pim(c,'after',ref);bad.configuration=['search_path=other'];poison.push(bad);
 for(const v of poison){for(const walk of [recursive,iterative]){const ctx=context();assert.throws(()=>walk(v,ctx));assert.deepEqual(ctx.trace,[''],'whole known parent must refuse before descending');}}
});
test('SQL NULL sentinel stays distinct from JSON null and exact unchanged BEFORE still returns nonNULL',()=>{
 for(const value of [SQL_NULL,null,false,0,'unrelated',{plain:[null,1,true]}]){const run=same(value);assert.equal(run.b,SQL_NULL);assert.equal(run.after.calls,0);}
 const c=changes.get(financialKey),identity={outer:{kind:'function',key:financialKey,value:c.before},nullable:null};
 const run=same(identity);assert.notEqual(run.b,SQL_NULL);assert(eq(run.b,identity));assert.equal(run.b.nullable,null);
 const noMatch='unmatched financial_return_upgrade_valid() source text';assert.equal(same(noMatch).b,SQL_NULL);
 assert(result.sql.includes('IF walk_projection IS NOT NULL THEN\n   walk_changed:=true;\n   IF walk_projection IS DISTINCT FROM value THEN'));
 assert(result.sql.includes('walk_projection:=(NULL);EXIT metadata_node;'));
 assert(!result.sql.includes("jsonb_typeof(walk_projection)='null'"));
});
test('fresh source-current validation precedes identity even with a historical or poisoned complete22 frame',()=>{
 const key=financialKey,c=changes.get(key),value={kind:'function',key,value:c.before};
 const current=closure.changes.map(c=>({kind:'function',key:c.key,value:structuredClone(c.after)}));
 for(const mutate of [rows=>rows.pop(),rows=>rows[0].value.owner='foreign',rows=>rows[16].value.source+=' ']){
  const rows=structuredClone(current);mutate(rows);const ctx=context();ctx.guard=()=>{ctx.calls++;projectOrderSplit210ChangedFunctions(rows,closure);};
  assert.throws(()=>iterative(value,ctx));assert.equal(ctx.calls,1);assert.deepEqual(ctx.trace,[],'refusal before first node classifier');
 }
 // Historical Source24 basis pin; the current basis is the later definition-codec physical DATA.
 assert.equal(pins.unchanged_basis_bytes,4193843);assert.equal(pins.unchanged_basis_sha256,'0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7');assert.equal(result.source_data_changed,false);
 assert.deepEqual({bytes:closure.projection_basis.bytes,sha256:closure.projection_basis.sha256},closure.definition_codec.physical_data);
 assert.equal(result.traversal.new_runtime_functions,0);assert.equal(result.traversal.cross_invocation_cache,false);
 const generated=executable(body(result.sql));assert(!/\bCREATE\b|\bALTER\b|\bDROP\b|\bCOMMIT\b|set_config|current_setting/.test(generated));
});
test('only the fixed primitive source SQL is accepted; no frame, callback, coercion or extra arguments',()=>{
 assert.throws(()=>derive(source24+'\n'),/bytes/);assert.throws(()=>derive(source24.replace('THEN RETURN NULL','THEN RETURN true')),/Source24 SQL/);
 let called=false;assert.throws(()=>derive({get sourceSql(){called=true;return source24;}}),/SQL string/);assert.equal(called,false);
 assert.throws(()=>derive(new String(source24)));assert.throws(()=>derive(source24,{entries:true}),/exactly one/);assert.throws(()=>derive(source24,()=>true),/exactly one/);
 assert(Object.isFrozen(result)&&Object.isFrozen(result.edits[0]));
 for(const key of ['target_metadata_adopted','source_compilation_performed','native_certification','application_activation','business_acceptance'])assert.equal(result[key],false);
});
