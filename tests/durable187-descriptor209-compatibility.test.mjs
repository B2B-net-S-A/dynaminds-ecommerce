/** Real descriptor projector and source-compiled204/205/209 descriptors.
 * Controlled owner port only: no PG, Native dispatch, startup or acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as E209} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {HEADER205_SOURCE_CONTRACT as E205} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/header205-source-contract.mjs';
import {PACKING204_SOURCE_CONTRACT as E204} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs';
import {DURABLE187_DESCRIPTOR204_SQL,projectDurable187Descriptor204Sql,prepareDurable187Descriptor204Sql} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/durable187-descriptor204-compatibility.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),key='public.ordinary187_valid()';
const target=e=>{const matches=e.changes.filter(c=>c.kind==='function'&&c.key===key);assert.equal(matches.length,1);return matches[0];};
const t204=target(E204),t205=target(E205),t209=target(E209);
const whole=JSON.parse(readFileSync(new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/ordinary177-contract.json',import.meta.url),'utf8'));
const extension=whole.durable_writer_epoch_extension,anchor=extension.independent_descriptor_sql;
assert.equal(sha(anchor),'cf6cd0842767e01717a84efe8b4d5c7611b687f11d6f110f10dd93c9e0c46d5f');
const prefix="p.oid=to_regprocedure('public.ordinary187_valid()') AND (SELECT count(*) FROM pg_proc sibling WHERE sibling.pronamespace=p.pronamespace AND sibling.proname=p.proname)=1 AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='";
const needle=prefix+sha(t204.before.source)+"'";
const observation=descriptor=>({descriptor,overloads:1,supported:true});

test('literal209 full descriptor is inverted through205/204, while the final anchor binds actual209 source',()=>{
 assert.deepEqual(t209.before,t205.after);assert.deepEqual(t205.before,t204.after);
 assert.notEqual(sha(t209.after.source),sha(t205.after.source));assert.notEqual(sha(t205.after.source),sha(t204.after.source));
 const saved=JSON.stringify(t209.after),sql=projectDurable187Descriptor204Sql(extension,observation(t209.after));
 assert.equal(anchor.split(needle).length,2);const replacement=prefix+sha(t209.after.source)+"'";
 assert.equal(sql,anchor.replace(needle,replacement));assert.equal(sql.split(replacement).length,2);
 assert.equal(sql.replace(replacement,needle),anchor,'Every other anchor, roster, header, ACL and query byte remains literal');
 assert.equal(JSON.stringify(t209.after),saved);assert.equal(sha(extension.independent_descriptor_sql),'cf6cd0842767e01717a84efe8b4d5c7611b687f11d6f110f10dd93c9e0c46d5f');
});
test('historical204-before/after and205 retain their exact original anchor behavior',()=>{
 for(const descriptor of[t204.before,t204.after,t205.after,t209.before]){
  const sql=projectDurable187Descriptor204Sql(extension,observation(descriptor));
  assert.equal(sql,anchor.replace(needle,prefix+sha(descriptor.source)+"'"));
 }
});
test('mixed209 source/definition and every full-header/ACL drift refuse instead of using a projected hash',()=>{
 const mutations=[v=>v.source+=' ',v=>v.definition+=' ',v=>v.source=t209.before.source,v=>v.definition=t209.before.definition,
  v=>v.owner='dyna_app',v=>v.security_definer=!v.security_definer,v=>v.volatility='v',v=>v.config=['search_path=public'],
  v=>v.acl.push({grantor:'postgres',grantee:'PUBLIC',privilege:'EXECUTE',grantable:false}),v=>v.acl_null=true,
  v=>v.arguments='unexpected integer',v=>v.support='some_support(internal)',v=>v.extra=true];
 for(const mutate of mutations){const descriptor=structuredClone(t209.after);mutate(descriptor);assert.throws(()=>projectDurable187Descriptor204Sql(extension,observation(descriptor)));}
 for(const patch of[{overloads:0},{overloads:2},{overloads:'1'},{supported:false},{supported:1},{extra:true}])assert.throws(()=>projectDurable187Descriptor204Sql(extension,{...observation(t209.after),...patch}));
});
test('historical source anchor, helper roster and original helper descriptor cannot be substituted',()=>{
 for(const change of[e=>e.independent_descriptor_sql+=' ',e=>e.public_helper_roster.pop(),e=>e.helpers.find(h=>h.name==='ordinary187_valid').body_sha256=sha(t209.after.source),e=>e.helpers.find(h=>h.name==='ordinary187_valid').acl.push(['postgres','PUBLIC','EXECUTE',false]),e=>e.native_admission_cache=true]){
  const e=structuredClone(extension);change(e);assert.throws(()=>projectDurable187Descriptor204Sql(e,observation(t209.after)));
 }
});
test('same owner reads one exact supported209 descriptor before returning anchor SQL and never invokes a Native helper',async()=>{
 const calls=[],owner={async query(sql){calls.push(sql);assert.equal(sql,DURABLE187_DESCRIPTOR204_SQL);assert(!/SELECT\s+(?:public\.)?ordinary187_valid\(/.test(sql));return{rows:[observation(t209.after)]};}};
 const projected=await prepareDurable187Descriptor204Sql(owner,extension);assert.equal(calls.length,1);assert.equal(projected,projectDurable187Descriptor204Sql(extension,observation(t209.after)));
 for(const rows of[[],[observation(t209.after),observation(t209.after)]])await assert.rejects(prepareDurable187Descriptor204Sql({query:async()=>({rows})},extension),/one-fresh-descriptor/);
 const primary=Error('original owner read failed');await assert.rejects(prepareDurable187Descriptor204Sql({query:async()=>{throw primary;}},extension),e=>e===primary);
});
