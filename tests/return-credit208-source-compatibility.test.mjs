/** Synthetic record-set tests only. Fixture is NOT a compiled208 expectation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectReturnCredit208RecordSet as project} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit208-source-compatibility.mjs';
const sort=x=>x.sort((a,b)=>(a.kind+'\0'+a.key)<(b.kind+'\0'+b.key)?-1:1),clone=structuredClone;
function fixture(){
 const changes=['public.return_credit206_guards()','public.return_credit206_require(uid uuid, kid uuid, writing boolean, pin boolean)'].map(key=>({kind:'function',key,before:{source:'SYNTHETIC-BEFORE',acl:[{grantee:'postgres'}]},after:{source:'SYNTHETIC-AFTER',acl:[{grantee:'postgres'}]}}));
 const additions=sort([{kind:'relation',key:'public.return_credit208_manifest',value:{synthetic:true,row_security:true}},{kind:'function',key:'public.return_credit208_fingerprint()',value:{synthetic:true,acl:[{grantee:'postgres'}]}},{kind:'type',key:'public._return_credit208_manifest',value:{synthetic:true}}]);
 const expected={schema:'source208-consumer-return-exact-inverse/v1',changes,additions,removed:[]},unrelated={kind:'function',key:'public.other()',value:{source:'UNCHANGED',nested:{marker:7}}};
 const before=sort([clone(unrelated),...changes.map(c=>({kind:c.kind,key:c.key,value:clone(c.before)}))]),after=sort([clone(unrelated),...changes.map(c=>({kind:c.kind,key:c.key,value:clone(c.after)})),...clone(additions)]);
 return{expected,before,after,unrelated};
}
test('exact projection restores both full descriptors and preserves every unrelated record without authority or input mutation',()=>{
 const f=fixture(),saved=clone(f.after),p=project(f.after,f.expected);assert.deepEqual(p.records,f.before);assert.equal(p.active,true);assert.equal(p.removed_records,3);assert.equal(p.changed_records,2);assert.equal(p.authority,false);assert.deepEqual(f.after,saved);
 p.records.find(r=>r.key==='public.other()').value.nested.marker=9;assert.equal(f.after.find(r=>r.key==='public.other()').value.nested.marker,7);
});
test('absence requires both exact original207 descriptors; partial changed state cannot pass',()=>{
 const f=fixture();assert.equal(project(f.before,f.expected).active,false);
 for(const c of f.expected.changes){const mixed=clone(f.before);mixed.find(r=>r.key===c.key).value=clone(c.after);assert.throws(()=>project(mixed,f.expected),/exact207-before/);}
});
test('every missing or extra208 record refuses instead of removing a whole prefix',()=>{
 const f=fixture();for(const a of f.expected.additions)assert.throws(()=>project(f.after.filter(r=>r.key!==a.key),f.expected),/addition-roster/);
 for(const kind of ['relation','function','type','policy','trigger'])assert.throws(()=>project(sort([...clone(f.after),{kind,key:'public.return_credit208_extra',value:{extra:true}}]),f.expected),/addition-roster/);
});
test('full metadata drift refuses for every addition and either changed function',()=>{
 const f=fixture();for(const target of [...f.expected.additions,...f.expected.changes]){const x=clone(f.after);x.find(r=>r.kind===target.kind&&r.key===target.key).value.extra=true;assert.throws(()=>project(x,f.expected),/descriptors|descriptor/);}
});
test('missing functions, overloads, duplicate or unsorted identities cannot pass',()=>{
 const f=fixture();for(const c of f.expected.changes){
  assert.throws(()=>project(f.after.filter(r=>r.key!==c.key),f.expected),/overload/);
  assert.throws(()=>project(sort([...clone(f.after),{kind:'function',key:c.key.replace('(', '(extra integer, '),value:{extra:true}}]),f.expected),/overload/);
 }
 assert.throws(()=>project(sort([...clone(f.after),clone(f.after[0])]),f.expected),/duplicate/);
 assert.throws(()=>project(f.after.slice().reverse(),f.expected),/record-order/);
});
test('no uncompiled default, missing additions, foreign prefix or destructive contract is accepted',()=>{
 const f=fixture();for(const invalid of [undefined,{...f.expected,additions:null},{...f.expected,removed:['old']},{...f.expected,changes:[]},{...f.expected,additions:[{kind:'function',key:'public.foreign()',value:{}}]}])assert.throws(()=>project(f.after,invalid));
});
