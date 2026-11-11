/** Joint representation only. No builder, migration, PostgreSQL or activation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {RESOURCE_DEFINITIONS} from '../tools/build/resource-definitions.mjs';
import {RESOURCE209_DEFINITION as D209,RESOURCE209_SQL as S209,RESOURCE209_ALIASES,RESOURCE211_DEFINITION as D211,RESOURCE211_ALIAS,RESOURCES209_SCHEMA,definitions209,storage209,assertStorage209Partition} from '../tools/build/resource-format209.mjs';
import {RESOURCE210_DEFINITION as D210,RESOURCE210_SQL as S210,RESOURCE210_ALIASES,RESOURCE210_NATIVE_ALIASES,RESOURCES210_SCHEMA,definitions210,storage210,assertStorage210Partition,encodeResource210 as legacyEncode,decodeResource210 as legacyDecode} from '../tools/build/resource-format210.mjs';
import {EMITTED210_211_SCHEMA,RESOURCES210_211_SCHEMA,RESOURCE210_211_LIMITS,RESOURCE210_211_ORIGIN,RESOURCE210_211_ALIASES,RESOURCE210_211_STORAGE_IDS,definitions210211,storage210211,assertStorage210211Partition,assertStorage210211PhysicalMembers,encodeResource210,decodeResource210} from '../tools/build/resource-format210-211.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url)),copy=v=>structuredClone(v),sha=b=>createHash('sha256').update(b).digest('hex');
const aliasRow=a=>({id:a.id,path:a.path,bytes:a.bytes,sha256:a.sha256,role:'runtime-resource',storage:{path:a.native_path,bytes:a.bytes,sha256:a.sha256,encoding:'identity'}});
const sqlRow=(d,s,encoding)=>({id:d.id,path:d.path,bytes:s.bytes,sha256:s.sha256,role:'runtime-resource',storage:{path:s.path,bytes:s.stored_bytes,sha256:s.stored_sha256,encoding}});
function fixture(){
 const members=[sqlRow(D209,S209,'gzip209'),...RESOURCE210_ALIASES.map(aliasRow),aliasRow(RESOURCE211_ALIAS),sqlRow(D210,S210,'gzip210')];
 const contract={schema:RESOURCES210_211_SCHEMA,definitions:definitions210211(RESOURCE_DEFINITIONS),members,missing:[]};
 const native={sql_graph:RESOURCE210_211_ALIASES.map(a=>({id:a.native_id,path:a.native_path,sha256:a.sha256}))};
 const files=members.map(row=>{const s=storage210211(row);return {path:s.path,bytes:s.bytes,sha256:s.sha256,role:s.role};});
 return {contract,native,files};
}

test('joint v5 is explicit, exact209→211→210 and leaves both legacy formats untouched',()=>{
 assert.equal(EMITTED210_211_SCHEMA,'dynaminds-emitted-local-release/v5');assert.equal(RESOURCES210_211_SCHEMA,'dynaminds-fixed-runtime-resources/v5');
 const f=fixture();assertStorage210211Partition(f.contract,f.native);assert.equal(f.contract.members.length,8);assert.equal(RESOURCE210_211_STORAGE_IDS.length,8);assert.equal(RESOURCE210_ALIASES.length,5);assert.equal(RESOURCE210_211_ALIASES.length,6);
 const defs=definitions210211(RESOURCE_DEFINITIONS);assert.deepEqual(defs.slice(0,-3),RESOURCE_DEFINITIONS);assert.deepEqual(defs.slice(-3),[D209,D211,D210]);assert(Object.isFrozen(defs));
 assert.deepEqual(definitions210(RESOURCE_DEFINITIONS).slice(-2),[D209,D210]);assert.deepEqual(definitions209(RESOURCE_DEFINITIONS,{include211:true}).slice(-2),[D209,D211]);
 const old210={schema:RESOURCES210_SCHEMA,definitions:definitions210(RESOURCE_DEFINITIONS),members:f.contract.members.filter(r=>r.id!==D211.id),missing:[]};assertStorage210Partition(old210,f.native);
 const old209={schema:RESOURCES209_SCHEMA,definitions:definitions209(RESOURCE_DEFINITIONS,{include211:true}),members:f.contract.members.filter(r=>r.id===D209.id||r.id===D211.id||RESOURCE209_ALIASES.some(a=>a.id===r.id)),missing:[]};assertStorage209Partition(old209,f.native);
 assert.throws(()=>assertStorage209Partition(f.contract,f.native));assert.throws(()=>assertStorage210Partition(f.contract,f.native));assert.throws(()=>assertStorage210211Partition(old209,f.native));assert.throws(()=>assertStorage210211Partition(old210,f.native));
 assert.deepEqual(read('tools/build/resource-format210-211.mjs'),read('shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-format210-211.mjs'));
 for(const key of ['native_acceptance','application_activation','installed_admission'])assert.equal(RESOURCE210_211_ORIGIN[key],false);assert(Object.isFrozen(RESOURCE210_211_ORIGIN));
});

test('all actual alias source bytes are fixed; raw719328B211 and existing encoders are delegated',()=>{
 const f=fixture();
 for(const a of RESOURCE210_211_ALIASES){const bytes=read(a.id.slice(4));assert.equal(bytes.length,a.bytes);assert.equal(sha(bytes),a.sha256);assert.equal(storage210211(aliasRow(a)).role,'native-sql');}
 assert.equal(RESOURCE211_ALIAS.bytes,719328);assert.equal(RESOURCE211_ALIAS.sha256,'08a7f80a919ffb5e8bc24675d2ca39ac48e633586cafc15ff5f31c46a459cc65');
 assert.deepEqual(storage210211(aliasRow(RESOURCE211_ALIAS)),storage209(aliasRow(RESOURCE211_ALIAS)));
 for(const r of f.contract.members.filter(r=>r.id!==D211.id))assert.deepEqual(storage210211(r),storage210(r));
 assert.equal(encodeResource210,legacyEncode);assert.equal(decodeResource210,legacyDecode);
 assert.deepEqual(S210,{bytes:4525572,sha256:'685c16fbf6fdf35f1b95752e7672e6df484ec865d0fa2cf5a20da5801da3dc73',path:D210.path+'.gz',stored_bytes:531426,stored_sha256:'488c2e2836f4e2c2fad8c6ce3dec4cf7f55cd5a7eddef182a1dc9212836eb0f2'});
});

test('every one of8 storage rows refuses metadata, encoding or alternate physical authority drift',()=>{
 const f=fixture();
 for(const id of RESOURCE210_211_STORAGE_IDS){const index=f.contract.members.findIndex(r=>r.id===id);for(const mutate of [r=>r.id='sql:server/foreign.sql',r=>r.path+='x',r=>r.bytes++,r=>r.sha256='f'.repeat(64),r=>r.role='native-sql',r=>r.extra=true,r=>r.storage.path+='x',r=>r.storage.bytes++,r=>r.storage.sha256='0'.repeat(64),r=>r.storage.encoding='gzip211',r=>r.storage.extra=true]){const bad=copy(f.contract);mutate(bad.members[index]);assert.throws(()=>assertStorage210211Partition(bad,f.native));}}
 const unknown={...copy(f.contract.members[0]),id:'sql:server/arbitrary.sql'};assert.throws(()=>storage210211(unknown));
 assert.throws(()=>storage210211(f.contract.members[0],{}));assert.throws(()=>definitions210211(RESOURCE_DEFINITIONS,{include211:false}));
});

test('211 cannot disappear from definitions, members, native edges or become a legacy fallback',()=>{
 const f=fixture();
 for(const mutate of [c=>c.definitions=c.definitions.filter(d=>d.id!==D211.id),c=>c.definitions=[...c.definitions.slice(0,-3),D209,D210,D211],c=>c.members=c.members.filter(r=>r.id!==D211.id),c=>c.members.push(copy(c.members.find(r=>r.id===D211.id))),c=>c.missing.push(D211.id),c=>c.members.push({...copy(c.members[0]),id:'sql:server/unknown.sql'}),c=>c.schema=RESOURCES210_SCHEMA,c=>c.extra=true]){const bad=copy(f.contract);mutate(bad);assert.throws(()=>assertStorage210211Partition(bad,f.native));}
 const i=f.native.sql_graph.findIndex(e=>e.id===RESOURCE211_ALIAS.native_id);
 for(const mutate of [n=>n.sql_graph.splice(i,1),n=>n.sql_graph.push(copy(n.sql_graph[i])),n=>n.sql_graph[i].id='foreign',n=>n.sql_graph[i].path+='x',n=>n.sql_graph[i].sha256='a'.repeat(64),n=>n.sql_graph.push({...copy(n.sql_graph[i]),id:'second-name'})]){const bad=copy(f.native);mutate(bad);assert.throws(()=>assertStorage210211Partition(f.contract,bad));}
});

test('each of5 legacy aliases and each definition retains exact source/consumer and edge cardinality',()=>{
 const f=fixture();
 for(const a of RESOURCE210_ALIASES){const di=f.contract.definitions.findIndex(d=>d.id===a.id),ei=f.native.sql_graph.findIndex(e=>e.id===a.native_id);for(const mutate of [d=>d.definitions.splice(di,1),d=>d.definitions[di].source+='x',d=>d.definitions[di].consumer='server/app.ts',d=>d.definitions.push(copy(d.definitions[di]))]){const bad=copy(f.contract);mutate(bad);assert.throws(()=>assertStorage210211Partition(bad,f.native));}for(const mutate of [n=>n.sql_graph.splice(ei,1),n=>n.sql_graph.push(copy(n.sql_graph[ei])),n=>n.sql_graph[ei].sha256='f'.repeat(64)]){const bad=copy(f.native);mutate(bad);assert.throws(()=>assertStorage210211Partition(f.contract,bad));}}
 for(const extra of [D209,D211,D210,RESOURCE_DEFINITIONS[0]])assert.throws(()=>definitions210211([...RESOURCE_DEFINITIONS,extra]));
});

test('177/182 and211 occupy single Native physical members; logical duplicate copies refuse',()=>{
 const f=fixture(),report=assertStorage210211PhysicalMembers(f.contract,f.native,f.files);assert.equal(report.closed_storage_rows,8);assert.equal(report.joint_native_acceptance,false);assert.equal(report.application_activation,false);assert.equal(report.native_acceptance,false);
 for(const a of [...RESOURCE210_NATIVE_ALIASES,RESOURCE211_ALIAS]){assert.equal(f.files.filter(x=>x.path===a.native_path).length,1);assert(!f.files.some(x=>x.path===a.path));const duplicate={path:a.path,bytes:a.bytes,sha256:a.sha256,role:'runtime-resource'};assert.throws(()=>assertStorage210211PhysicalMembers(f.contract,f.native,[...f.files,duplicate]));}
 for(const mutate of [v=>v.pop(),v=>v[0].role='runtime-resource',v=>v[0].bytes++,v=>v[0].sha256='e'.repeat(64),v=>v.push(copy(v[0]))]){const bad=copy(f.files);mutate(bad);assert.throws(()=>assertStorage210211PhysicalMembers(f.contract,f.native,bad));}
 const i=f.files.findIndex(r=>r.path===RESOURCE211_ALIAS.native_path);for(const mutate of [v=>v.splice(i,1),v=>v[i].role='emitted-runtime',v=>v[i].bytes++,v=>v[i].sha256='f'.repeat(64)]){const bad=copy(f.files);mutate(bad);assert.throws(()=>assertStorage210211PhysicalMembers(f.contract,f.native,bad));}
 const bytesSaved=RESOURCE210_NATIVE_ALIASES.reduce((n,a)=>n+a.bytes,0);assert.equal(bytesSaved,1633681);assert.equal(RESOURCE210_211_LIMITS.total_bytes-(100274037-bytesSaved+S210.stored_bytes),35045946,'representation-only budget before unmeasured new JS/seal; not actual release acceptance');
});

test('ALL physical bytes count once at exact16MiB member/128MiB total bounds; no manifest or path escape',()=>{
 const f=fixture(),report=assertStorage210211PhysicalMembers(f.contract,f.native,f.files);assert.deepEqual(RESOURCE210_211_LIMITS,{member_bytes:16777216,total_bytes:134217728,manifest_included:false});assert.equal(report.bytes,f.files.reduce((n,r)=>n+r.bytes,0));assert.equal(report.manifest_included,false);
 for(const row of [{path:'release.json',bytes:1,sha256:'a'.repeat(64),role:'manifest'},{path:'runtime/too-big',bytes:16777217,sha256:'a'.repeat(64),role:'emitted-runtime'}])assert.throws(()=>assertStorage210211PhysicalMembers(f.contract,f.native,[...f.files,row]));
 const full=copy(f.files);let remaining=134217728-report.bytes;while(remaining){const bytes=Math.min(remaining,16777216);full.push({path:'runtime/padding'+full.length,bytes,sha256:'a'.repeat(64),role:'emitted-runtime'});remaining-=bytes;}
 assert.equal(assertStorage210211PhysicalMembers(f.contract,f.native,full).bytes,134217728);full.push({path:'runtime/one-extra-byte',bytes:1,sha256:'a'.repeat(64),role:'emitted-runtime'});assert.throws(()=>assertStorage210211PhysicalMembers(f.contract,f.native,full),/resource210-total-128MiB/);
 for(const p of ['/absolute','../escape','runtime/../escape','runtime//file','runtime\\file','file:other'])assert.throws(()=>assertStorage210211PhysicalMembers(f.contract,f.native,[...f.files,{path:p,bytes:1,sha256:'a'.repeat(64),role:'emitted-runtime'}]),/canonical-relative/);
});
