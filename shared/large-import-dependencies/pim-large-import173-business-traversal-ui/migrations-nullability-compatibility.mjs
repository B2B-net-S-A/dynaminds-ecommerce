import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PACKING189_CONTRACT} from './packing189-cold-contract.mjs';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(x).digest('hex');
// schema.sql declares NOT NULL; db.ts historically bootstrapped this one
// administrative column as nullable before applying CREATE IF NOT EXISTS.
// Accept the exact stronger schema without changing its actual constraint.
const legacy={kind:'column',key:'public.migrations.applied_at',value:{acl:[],acl_null:true,collation:null,compression:'',default:'now()',foreign_options:null,generated:'',identity:'',not_null:false,options:null,position:2,statistics:null,storage:'p',type:'timestamp with time zone'}};
const stronger={...legacy,value:{...legacy.value,not_null:true}};
const constraint={kind:'constraint',key:'public.migrations.migrations_applied_at_not_null',value:{deferrable:false,deferred:false,definition:'NOT NULL applied_at',inheritance_count:0,kind:'n',local:true,no_inherit:false,validated:true}};
const expected=new Map(PACKING189_CONTRACT.dependency_compilation.object_hashes);
assert.equal(hash(JSON.stringify(canonical(legacy))),expected.get(hash(legacy.kind+'\0'+legacy.key)),'migration-nullability-source-predecessor');
export function projectMigrationsNullability(records){
 const columns=records.filter(r=>r.kind===legacy.kind&&r.key===legacy.key),constraints=records.filter(r=>r.kind===constraint.kind&&r.key===constraint.key);
 assert.equal(columns.length,1,'migration-nullability-one-column');assert(constraints.length<=1,'migration-nullability-one-constraint');
 if(!constraints.length){assert.deepEqual(canonical(columns[0]),canonical(legacy),'migration-nullability-exact-legacy-column');return{records,removed_constraints:0};}
 assert.deepEqual(canonical(columns[0]),canonical(stronger),'migration-nullability-exact-stronger-column');
 assert.deepEqual(canonical(constraints[0]),canonical(constraint),'migration-nullability-exact-stronger-constraint');
 return{records:records.filter(r=>r!==constraints[0]).map(r=>r===columns[0]?structuredClone(legacy):r),removed_constraints:1};
}
