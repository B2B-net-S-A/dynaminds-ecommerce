/** Metadata representation only; never Native, IAM, installation or readiness.
 * `expected` is REQUIRED and must be separately source-compiled, pinned and
 * reviewed by the caller. This wrapper does not authenticate that argument.
 * The trusted comparison phase must never come from a runtime request.
 * No giant source contracts, verdict cache, database calls or archive IO.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateRecoverySchema} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {projectOrderMergeDelivery209RecordSet} from './order-merge-delivery209-inverse.mjs';

const counters=Object.freeze({relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',function:'functions',type:'types'});
const identity=r=>r.kind+'\0'+r.key;
const zeros=()=>Object.fromEntries(Object.values(counters).map(k=>[k,0]));

// Match the reader's canonical JSON exactly without constructing a second full
// metadata tree just for hashing. Both input and inverse output have already
// passed bounded plain-JSON validation. The reader below normalizes/freeze-cuts
// the final representation, including every nested object's property order.
function canonicalDigest(body){
 const hash=createHash('sha256');
 const visit=value=>{
  if(Array.isArray(value)){
   hash.update('[');for(let i=0;i<value.length;i++){if(i)hash.update(',');visit(value[i]);}hash.update(']');return;
  }
  if(value!==null&&typeof value==='object'){
   // JSON.stringify orders array-index object keys numerically even when a
   // canonicalizer inserts them in lexical order. Reproduce that rule too.
   hash.update('{');const keys=Object.keys(Object.fromEntries(Object.keys(value).sort().map(key=>[key,null])));for(let i=0;i<keys.length;i++){if(i)hash.update(',');const key=keys[i];hash.update(JSON.stringify(key));hash.update(':');visit(value[key]);}hash.update('}');return;
  }
  hash.update(JSON.stringify(value));
 };
 visit(body);return hash.digest('hex');
}

/** Compose a REQUIRED exact209 inverse with the existing full catalogue schema.
 * Fresh foreign input is normalized and integrity-checked by the real reader;
 * a reader-owned immutable snapshot is reused by that reader's normal rules.
 * Inactive results are unchanged identity, not proof of an installed successor.
 */
export function projectOrderMergeDelivery209Catalogue(value,expected,options){
 const input=validateRecoverySchema(value);
 const inverse=projectOrderMergeDelivery209RecordSet(input.records,expected,options);
 const removedCounts=zeros();
 if(!inverse.active)return Object.freeze({catalogue:input,mode:inverse.mode,active:false,removed_records:0,changed_records:0,removed_counts:Object.freeze(removedCounts),authority:false});

 const surviving=new Set(inverse.records.map(identity));
 for(const row of input.records)if(!surviving.has(identity(row))){
  assert(Object.hasOwn(counters,row.kind),'209 inverse removes only the eight declared catalogue kinds');removedCounts[counters[row.kind]]++;
 }
 assert.equal(Object.values(removedCounts).reduce((a,b)=>a+b,0),inverse.removed_records,'209 exact removal accounting');
 assert.equal(input.records.length-inverse.records.length,inverse.removed_records,'209 exact record count delta');
 const counts={...input.counts};
 for(const [key,n]of Object.entries(removedCounts)){
  assert(counts[key]>=n,'209 bounded count subtraction');counts[key]-=n;
 }
 const body={schema:input.schema,postgres_major:input.postgres_major,scope:input.scope,sql_sha256:input.sql_sha256,counts,records:inverse.records};
 const catalogue=validateRecoverySchema({...body,sha256:canonicalDigest(body)});
 return Object.freeze({catalogue,mode:inverse.mode,active:true,removed_records:inverse.removed_records,changed_records:inverse.changed_records,removed_counts:Object.freeze(removedCounts),authority:false});
}
