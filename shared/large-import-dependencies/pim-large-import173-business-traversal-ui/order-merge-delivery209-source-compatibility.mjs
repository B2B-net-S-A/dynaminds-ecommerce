/** Pure exact209→208 representation inverse. Explicit source expectation required.
 * No default contract, Native certification, installation, IAM or runtime admission. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateRecoverySchema,LIMITS} from './packing189-catalogue-reader.mjs';

const PREFIX='order_merge_delivery209_';
const functionKeys=Object.freeze([
 'public.buyer_address_preview_guard()', 'public.buyer_address_state_guard()',
 'public.buyer_address_guards()', 'public.buyer_address_fingerprint()',
 'public.manual_inventory_off_valid()', 'public.manual_inventory_off_projection_valid()',
 'public.partial_sale204_predecessor_definition(fn oid)', 'public.ordinary187_valid()',
 'public.partial_sale204_valid()', 'public.catalog_header205_valid()',
]);
const countKinds=Object.freeze({relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types'});
const identity=r=>r.kind+'\0'+r.key;
function exact(v,keys){assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),keys.slice().sort());}
function canonical(v,depth=0,budget={nodes:0}){
 assert(++budget.nodes<=LIMITS.json_nodes&&depth<=LIMITS.json_depth,'209-json-bounds');
 if(v===null||typeof v==='string'||typeof v==='boolean')return v;
 if(typeof v==='number'){assert(Number.isFinite(v),'209-json-number');return v;}
 if(Array.isArray(v)){assert(v.length<=LIMITS.records,'209-array-bound');const out=[];for(let i=0;i<v.length;i++){assert(Object.hasOwn(v,i),'209-dense-array');out.push(canonical(v[i],depth+1,budget));}return out;}
 assert(v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)),'209-plain-json');
 const out=Object.create(null);for(const k of Object.keys(v).sort())out[k]=canonical(v[k],depth+1,budget);return out;
}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function equal(a,b){
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const ak=Object.keys(a),bk=Object.keys(b);if(ak.length!==bk.length)return false;
 return ak.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
}
function recordShape(r){
 exact(r,['kind','key','value']);assert(typeof r.kind==='string'&&typeof r.key==='string'&&r.key.length>0&&!r.key.includes('\0'));
 assert(r.value&&typeof r.value==='object'&&!Array.isArray(r.value));
}
function normalizeRecords(input){
 assert(Array.isArray(input)&&input.length<=LIMITS.records,'209-record-count');const rows=canonical(input),seen=new Set();let previous='';
 let bytes=0;for(const r of rows){recordShape(r);const n=Buffer.byteLength(JSON.stringify(r));assert(n<=LIMITS.record_bytes,'209-per-record-bound');bytes+=n;assert(bytes<=LIMITS.encoded_bytes,'209-recordset-byte-bound');const id=identity(r);assert(!seen.has(id),'209-duplicate-record');assert(id>previous,'209-record-order');previous=id;seen.add(id);}
 return freeze(rows);
}
function isRelated(r){
 return r.key.includes(PREFIX)||(r.kind==='trigger'&&['constraint','constraint_relation','function'].some(k=>typeof r.value[k]==='string'&&r.value[k].includes(PREFIX)));
}
function authoredForeignKeys(additions){
 const keys=new Map(),identifiers='[a-z_][a-z_0-9]*(?:, [a-z_][a-z_0-9]*)*';
 const reference=new RegExp('^FOREIGN KEY \\('+identifiers+'\\) REFERENCES (?:public\\.)?(orders|users|api_keys|order_merge_executions|order_merge_previews|buyer_address_previews|buyer_address_receipts)\\('+identifiers+'\\)(?: DEFERRABLE(?: INITIALLY DEFERRED)?)?$');
 for(const r of additions){
  if(r.kind!=='constraint'||r.value.kind!=='f')continue;
  const own=/^public\.order_merge_delivery209_receipts\.([a-z_][a-z_0-9]{0,62})$/.exec(r.key);if(!own)continue;
  const target=typeof r.value.definition==='string'&&reference.exec(r.value.definition);
  assert(target,'209-authored-FK-target');assert(!keys.has(own[1]),'209-distinct-authored-FK');
  keys.set(own[1],{constraint:r,target:target[1],actions:new Set()});
 }
 return keys;
}
function allowedAddition(r,foreignKeys){
 if(!Object.hasOwn(countKinds,r.kind))return false;
 if(r.key.startsWith('public.'+PREFIX)||r.key.startsWith('public._'+PREFIX))return true;
 if(r.kind==='constraint'&&r.key==='public.order_merge_executions.order_merge_delivery209_complete')return true;
 if(r.kind!=='trigger')return false;
 if(['public.order_merge_previews.order_merge_delivery209_source_preview','public.order_merge_executions.order_merge_delivery209_complete'].includes(r.key))return true;
 // PG may truncate the generated FK name. Its complete authored constraint
 // record, not a shortened prefix, binds the external RI relation and action.
 const fk=foreignKeys.get(r.value.constraint),action=typeof r.value.function==='string'&&/^(?:pg_catalog\.)?"RI_FKey_noaction_(del|upd)"\(\)$/.exec(r.value.function);
 if(!fk||!action||r.value.internal!==true||!['order_merge_delivery209_receipts','public.order_merge_delivery209_receipts'].includes(r.value.constraint_relation))return false;
 const type=action[1]==='del'?9:17;
 if(r.key!=='public.'+fk.target+'.internal:'+r.value.constraint+':'+r.value.function+':'+type+':'||r.value.type!==type||r.value.enabled!=='O'||r.value.deferrable!==fk.constraint.value.deferrable||r.value.deferred!==fk.constraint.value.deferred||r.value.name!==null||r.value.definition!==null||r.value.arguments!==''||!equal(r.value.attributes,[])||r.value.has_when!==false||r.value.old_table!==null||r.value.new_table!==null)return false;
 assert(!fk.actions.has(action[1]),'209-distinct-linked-RI-action');fk.actions.add(action[1]);return true;
}
function expectation(input){
 const e=canonical(input);exact(e,['schema','additions','changes','removed']);assert.equal(e.schema,'source209-order-merge-delivery-exact-inverse/v1');
 assert(Array.isArray(e.removed)&&e.removed.length===0,'209-no-removals');assert(Array.isArray(e.changes)&&e.changes.length===14,'209-exact14-changes');
 const seen=new Set(),functions=new Set(),tables=new Map();
 for(const c of e.changes){
  exact(c,['kind','key','before','after']);assert(!seen.has(identity(c)),'209-duplicate-change');seen.add(identity(c));
  assert(c.before&&c.after&&typeof c.before==='object'&&typeof c.after==='object'&&!Array.isArray(c.before)&&!Array.isArray(c.after)&&!equal(c.before,c.after),'209-real-descriptor-change');
  if(c.kind==='function'){
   assert(functionKeys.includes(c.key),'209-exact-function-scope');functions.add(c.key);
   assert(typeof c.before.source==='string'&&typeof c.after.source==='string'&&c.before.source!==c.after.source,'209-source-derived-body-change');
  }else{
   assert.equal(c.kind,'constraint');assert.equal(c.before.kind,'c');assert.equal(c.after.kind,'c');
   const match=/^public\.(buyer_address_previews|buyer_address_receipts)\.[a-z_][a-z_0-9]*$/.exec(c.key);assert(match,'209-exact-CHECK-table-scope');
   assert(typeof c.before.definition==='string'&&typeof c.after.definition==='string'&&c.before.definition!==c.after.definition,'209-authored-CHECK-change');
   tables.set(match[1],(tables.get(match[1])??0)+1);
  }
 }
 assert.equal(functions.size,10,'209-exact10-function-changes');assert.equal(tables.size,2);for(const n of tables.values())assert.equal(n,2,'209-exact2-CHECKs-per-table');
 const additions=normalizeRecords(e.additions),foreignKeys=authoredForeignKeys(additions);
 assert(additions.length>0&&additions.every(r=>allowedAddition(r,foreignKeys)),'209-authored-addition-scope');
 for(const fk of foreignKeys.values())assert(fk.actions.has('del')&&fk.actions.has('upd'),'209-complete-linked-RI-actions');
 for(const r of additions)assert(!seen.has(identity(r)),'209-added-changed-overlap');
 for(const table of ['receipts','manifest','projection_basis'])assert(additions.some(r=>r.kind==='relation'&&r.key==='public.'+PREFIX+table),'209-complete-own-table-roster');
 for(const key of ['public.order_merge_previews.order_merge_delivery209_source_preview','public.order_merge_executions.order_merge_delivery209_complete'])
  assert(additions.some(r=>r.kind==='trigger'&&r.key===key),'209-complete-external-guard-roster');
 assert(additions.some(r=>r.kind==='constraint'&&r.key==='public.order_merge_executions.order_merge_delivery209_complete'),'209-complete-deferred-constraint');
 const completion=additions.find(r=>r.kind==='constraint'&&r.key==='public.order_merge_executions.order_merge_delivery209_complete');
 assert(equal(completion.value,{kind:'t',local:true,deferred:true,validated:true,deferrable:true,definition:'TRIGGER DEFERRABLE INITIALLY DEFERRED',no_inherit:true,inheritance_count:0}),'209-source-authored-deferred-constraint');
 assert(additions.some(r=>r.kind==='trigger'&&r.value.internal===true&&!r.key.startsWith('public.'+PREFIX)),'209-complete-external-FK-roster');
 return freeze({...e,additions});
}
function projectOwned(rows,e){
 const byId=new Map(rows.map(r=>[identity(r),r])),byFunction=new Map();
 for(const r of rows)if(r.kind==='function'){const key=r.key.slice(0,r.key.indexOf('('));const values=byFunction.get(key)??[];values.push(r);byFunction.set(key,values);}
 for(const c of e.changes)if(c.kind==='function'){
  const values=byFunction.get(c.key.slice(0,c.key.indexOf('(')))??[];
  assert(values.length===1&&values[0].key===c.key,'209-no-overload-missing-or-duplicate');
 }
 const selected=rows.filter(isRelated);
 if(!selected.length){
  for(const c of e.changes){const r=byId.get(identity(c));assert(r&&equal(r.value,c.before),'209-absent-requires-exact208-before');}
  return Object.freeze({records:rows,active:false,removed_records:0,changed_records:0,authority:false});
 }
 assert(equal(selected.map(identity),e.additions.map(identity)),'209-complete-exact-addition-roster');
 for(let i=0;i<selected.length;i++)assert(equal(selected[i],e.additions[i]),'209-complete-source-addition-descriptors');
 for(const c of e.changes){const r=byId.get(identity(c));assert(r&&equal(r.value,c.after),'209-complete-current-changed-descriptor');}
 const removed=new Set(e.additions.map(identity)),changes=new Map(e.changes.map(c=>[identity(c),c]));
 const output=[];for(const r of rows)if(!removed.has(identity(r))){const c=changes.get(identity(r));output.push(c?freeze({kind:r.kind,key:r.key,value:c.before}):r);}
 return Object.freeze({records:Object.freeze(output),active:true,removed_records:e.additions.length,changed_records:14,authority:false});
}
export function projectOrderMergeDelivery209RecordSet(input,expected){return projectOwned(normalizeRecords(input),expectation(expected));}

// Stream canonical JSON to the hash without cloning/stringifying another complete60MB catalogue.
function digest(value){
 const h=createHash('sha256');function write(v){
  if(v===null||typeof v!=='object'){h.update(JSON.stringify(v));return;}
  if(Array.isArray(v)){h.update('[');for(let i=0;i<v.length;i++){if(i)h.update(',');write(v[i]);}h.update(']');return;}
  h.update('{');const keys=Object.keys(v).sort();for(let i=0;i<keys.length;i++){if(i)h.update(',');h.update(JSON.stringify(keys[i]));h.update(':');write(v[keys[i]]);}h.update('}');
 }write(value);return h.digest('hex');
}
/** Reader normalization is mandatory. Foreign frozen/raw/digest-equal objects
 * acquire no custody; unchanged validator-owned records are reused, never cloned. */
export function projectOrderMergeDelivery209Catalogue(value,expected){
 const owned=validateRecoverySchema(value),e=expectation(expected),p=projectOwned(owned.records,e);
 const removedCounts=Object.fromEntries(Object.values(countKinds).map(k=>[k,0]));
 if(!p.active)return Object.freeze({...p,catalogue:owned,removed_counts:Object.freeze(removedCounts)});
 for(const r of e.additions)removedCounts[countKinds[r.kind]]++;
 const counts={...owned.counts};for(const[k,n]of Object.entries(removedCounts)){assert(Number.isInteger(counts[k])&&counts[k]>=n,'209-count-subtraction');counts[k]-=n;}
 const body={schema:owned.schema,postgres_major:owned.postgres_major,scope:[...owned.scope],sql_sha256:owned.sql_sha256,counts,records:p.records};
 const catalogue=validateRecoverySchema({...body,sha256:digest(body)});
 return Object.freeze({...p,catalogue,removed_counts:Object.freeze(removedCounts)});
}
