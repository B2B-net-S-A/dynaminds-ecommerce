/** Source representation tests only; no package registration, PG, or admission. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {RESOURCE_DEFINITIONS} from '../tools/build/resource-definitions.mjs';
import {RESOURCE209_DEFINITION as D209,RESOURCE209_SQL as S209,RESOURCE209_ALIASES,storage209,RESOURCES209_SCHEMA,assertStorage209Partition} from '../tools/build/resource-format209.mjs';
import {RESOURCE210_DEFINITION as D,RESOURCE210_SQL as S,RESOURCE210_NATIVE_ALIASES,RESOURCE210_ALIASES,RESOURCE210_LIMITS,RESOURCE210_ORIGIN,EMITTED210_SCHEMA,RESOURCES210_SCHEMA,definitions210,storage210,assertStorage210Partition,assertStorage210PhysicalMembers,encodeResource210,decodeResource210} from '../tools/build/resource-format210.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex'),copy=v=>structuredClone(v);
const aliasRow=a=>({id:a.id,path:a.path,bytes:a.bytes,sha256:a.sha256,role:'runtime-resource',storage:{path:a.native_path,bytes:a.bytes,sha256:a.sha256,encoding:'identity'}});
const sqlRow=(d,s,encoding)=>({id:d.id,path:d.path,bytes:s.bytes,sha256:s.sha256,role:'runtime-resource',storage:{path:s.path,bytes:s.stored_bytes,sha256:s.stored_sha256,encoding}});
function fixture(){
 const members=[sqlRow(D209,S209,'gzip209'),...RESOURCE210_ALIASES.map(aliasRow),sqlRow(D,S,'gzip210')];
 const contract={schema:RESOURCES210_SCHEMA,definitions:definitions210(RESOURCE_DEFINITIONS),members,missing:[]};
 const native={sql_graph:RESOURCE210_ALIASES.map(a=>({id:a.native_id,path:a.native_path,sha256:a.sha256}))};
 const files=members.map(r=>{const s=storage210(r);return{path:s.path,bytes:s.bytes,sha256:s.sha256,role:s.role};});
 return{contract,native,files};
}

test('new v3 code-owned seven-row partition preserves old v2 and exact mirrors',()=>{
 assert.equal(EMITTED210_SCHEMA,'dynaminds-emitted-local-release/v3');assert.equal(RESOURCES210_SCHEMA,'dynaminds-fixed-runtime-resources/v3');
 const f=fixture();assertStorage210Partition(f.contract,f.native);assert.equal(f.contract.members.length,7);assert.equal(RESOURCE210_ALIASES.length,5);
 const old={schema:RESOURCES209_SCHEMA,members:f.contract.members.filter(r=>r.id===D209.id||RESOURCE209_ALIASES.some(a=>a.id===r.id)),missing:[]};
 assertStorage209Partition(old,f.native);assert.throws(()=>assertStorage209Partition(f.contract,f.native));assert.throws(()=>storage209(aliasRow(RESOURCE210_NATIVE_ALIASES[0])));
 for(const a of RESOURCE209_ALIASES)assert.deepEqual(storage210(aliasRow(a)),storage209(aliasRow(a)));
 const defs=definitions210(RESOURCE_DEFINITIONS);assert.deepEqual(defs.slice(0,-2),RESOURCE_DEFINITIONS);assert.deepEqual(defs.slice(-2),[D209,D]);
 assert.deepEqual(read('tools/build/resource-format210.mjs'),read('shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-format210.mjs'));
 assert.equal(RESOURCE210_ORIGIN.native_acceptance,false);assert.equal(RESOURCE210_ORIGIN.application_activation,false);assert.equal(RESOURCE210_ORIGIN.installed_admission,false);
 assert(Object.isFrozen(defs)&&Object.isFrozen(D)&&Object.isFrozen(S)&&Object.isFrozen(RESOURCE210_NATIVE_ALIASES[0]));
});

test('five aliases bind actual complete source bytes and native identity, not an alternate logical copy',()=>{
 const f=fixture();
 for(const a of RESOURCE210_ALIASES){const bytes=read('server/'+a.path.split('/').at(-1));assert.equal(bytes.length,a.bytes);assert.equal(sha(bytes),a.sha256);assert.equal(storage210(aliasRow(a)).role,'native-sql');}
 assert.deepEqual(RESOURCE210_NATIVE_ALIASES.map(a=>a.native_id),['wave177_predecessor','ordinary182_cold_runtime_admission']);
 assert.equal(assertStorage210PhysicalMembers(f.contract,f.native,f.files).native_acceptance,false);
 assert.equal(storage210(f.contract.members.at(-1)).role,'runtime-resource-gzip210');
 for(const id of [D.id,D209.id,...RESOURCE210_ALIASES.map(a=>a.id)]){
  const index=f.contract.members.findIndex(r=>r.id===id);
  for(const mutate of [r=>r.id='sql:server/other.sql',r=>r.path+='x',r=>r.bytes++,r=>r.sha256='f'.repeat(64),r=>r.role='native-sql',r=>r.extra=true,r=>r.storage.path+='x',r=>r.storage.bytes++,r=>r.storage.sha256='f'.repeat(64),r=>r.storage.encoding='other',r=>r.storage.extra=true]){const bad=copy(f.contract);mutate(bad.members[index]);assert.throws(()=>assertStorage210Partition(bad,f.native));}
 }
});

test('missing, duplicate, unrelated storage and aliased native edge ambiguity refuse',()=>{
 const f=fixture();
 for(const mutate of [c=>c.members.pop(),c=>c.members.push(copy(c.members[0])),c=>c.missing.push(D.id),c=>c.members.push({...copy(c.members[0]),id:'sql:server/unknown.sql'}),c=>c.schema=RESOURCES209_SCHEMA]){const bad=copy(f.contract);mutate(bad);assert.throws(()=>assertStorage210Partition(bad,f.native));}
 for(let i=0;i<5;i++)for(const mutate of [n=>n.sql_graph.splice(i,1),n=>n.sql_graph.push(copy(n.sql_graph[i])),n=>n.sql_graph[i].id='foreign',n=>n.sql_graph[i].path+='x',n=>n.sql_graph[i].sha256='a'.repeat(64),n=>n.sql_graph.push({...n.sql_graph[i],id:'second-id'})]){const bad=copy(f.native);mutate(bad);assert.throws(()=>assertStorage210Partition(f.contract,bad));}
 assert.throws(()=>definitions210([...RESOURCE_DEFINITIONS,D]));assert.throws(()=>definitions210([...RESOURCE_DEFINITIONS,D209]));assert.throws(()=>definitions210([...RESOURCE_DEFINITIONS,RESOURCE_DEFINITIONS[0]]));
 assert.throws(()=>definitions210(RESOURCE_DEFINITIONS.filter(d=>d.id!==RESOURCE210_NATIVE_ALIASES[0].id)));
});

test('physical roles and the 16MiB member and 128MiB total limits stay exact, release manifest excluded',()=>{
 const f=fixture(),report=assertStorage210PhysicalMembers(f.contract,f.native,f.files);
 assert.equal(report.bytes,f.files.reduce((n,f)=>n+f.bytes,0));assert.equal(report.manifest_included,false);assert.deepEqual(RESOURCE210_LIMITS,{member_bytes:16777216,total_bytes:134217728,manifest_included:false});
 for(const mutate of [fs=>fs.pop(),fs=>fs[0].role='runtime-resource',fs=>fs[0].bytes++,fs=>fs[0].sha256='e'.repeat(64),fs=>fs.push(copy(fs[0])),fs=>fs.push({path:D.path,bytes:S.bytes,sha256:S.sha256,role:'runtime-resource'}),fs=>fs.push({path:'release.json',bytes:1,sha256:'a'.repeat(64),role:'manifest'}),fs=>fs.push({path:'oversized',bytes:16777217,sha256:'a'.repeat(64),role:'emitted-runtime'})]){const bad=copy(f.files);mutate(bad);assert.throws(()=>assertStorage210PhysicalMembers(f.contract,f.native,bad));}
 const full=copy(f.files);let remaining=134217728-report.bytes;
 while(remaining){const bytes=Math.min(remaining,16777216);full.push({path:'runtime/padding'+full.length,bytes,sha256:'a'.repeat(64),role:'emitted-runtime'});remaining-=bytes;}
 assert.equal(assertStorage210PhysicalMembers(f.contract,f.native,full).bytes,134217728);
 full.push({path:'runtime/one-byte-too-many',bytes:1,sha256:'a'.repeat(64),role:'emitted-runtime'});assert.throws(()=>assertStorage210PhysicalMembers(f.contract,f.native,full),/resource210-total-128MiB/);
 for(const path of ['/absolute','../escape','runtime/../escape','runtime//file','runtime\\file','file:other'])assert.throws(()=>assertStorage210PhysicalMembers(f.contract,f.native,[...f.files,{path,bytes:1,sha256:'a'.repeat(64),role:'emitted-runtime'}]),/canonical-relative/);
});

test('actual source-only assembled candidate deterministically encodes and decodes fixed gzip',async()=>{
 const {assembleOrderSplit210Source}=await import('../tools/parity/order-split210-source.mjs');
 const match=/gunzipSync\(Buffer\.from\('([^']+)','base64'\),\{maxOutputLength:131072\}\)/.exec(read('tests/order-split210-layer.test.mjs').toString('utf8'));assert(match);
 const sourceBundle=JSON.parse(gunzipSync(Buffer.from(match[1],'base64'),{maxOutputLength:131072}).toString('utf8'));
 const text=p=>read(p).toString('utf8'),paths={source104:'104_order_merge_custody.sql',source108:'108_b2b_dropshipping.sql',source160:'160_b2b_credit.sql',source169:'169_manual_inventory_off.sql',source204:'204_partial_commercial_sale_scope.sql'};
 const result=assembleOrderSplit210Source({businessInputs:Object.fromEntries(Object.entries(paths).map(([k,v])=>[k,text('server/'+v)])),sourceBundle,source158:text('server/158_fa3_draft_native.sql'),source159:text('server/159_b2b_invoice.sql'),source210:text('tools/parity/order-split210-business.sql'),sourceTerminal:text('tools/parity/order-split210-terminal.sql'),sourceSchema:text('server/schema.sql')});
 const raw=Buffer.from(result.sql);assert.equal(result.sha256,S.sha256);assert.equal(raw.length,S.bytes);assert.equal(result.sealed,false);
 const packed=encodeResource210(raw);assert.equal(packed.length,531426);assert.equal(sha(packed),'488c2e2836f4e2c2fad8c6ce3dec4cf7f55cd5a7eddef182a1dc9212836eb0f2');assert.deepEqual(encodeResource210(raw),packed);assert.deepEqual(decodeResource210(packed),raw);
 const previous=sqlRow(D,{...S,bytes:3568271,sha256:'139e2da7a404202ba7398f9c25040c675ed6dd26caecbedd24ef0069c13376f5',stored_bytes:397334,stored_sha256:'c16f6693170e49ffc5d5d0c79c58d0650c47c60100af07bd3ada8d1d9e8c9c0d'},'gzip210');
 assert.throws(()=>storage210(previous),'previous15-change candidate cannot fall back inside the new finite resource row');
 const previous16=sqlRow(D,{...S,bytes:4639523,sha256:'69b366874e24053852339bd192762f7878c9c2bb57a9f2b0beabd3af3ed216fe',stored_bytes:532928,stored_sha256:'a10e5ab32685177932167cefce9b12e2d9d13bcf17f0184df4879290524a9901'},'gzip210');
 assert.throws(()=>storage210(previous16),'historical16-change candidate is not the current20 source');
 const previous20=sqlRow(D,{...S,bytes:4673025,sha256:'442556de0fb012ac9d63a464b1bfca1b4fa37483a32c8250993acc7a9310e5b8',stored_bytes:545609,stored_sha256:'9f0ead77451bdb30a41bb90dbf9f5ec644aa45a0d138bee3d02ac831f1842d7f'},'gzip210');
 assert.throws(()=>storage210(previous20),'same20-key historical candidate cannot replace the Source21 byte commitment');
 const previous21=sqlRow(D,{...S,bytes:4674391,sha256:'d6fa6a3d7cf6fbeb0333e2e16d8d59a28cf87249151293a533fab28ef597c951',stored_bytes:546223,stored_sha256:'e3cb7c07e705e502f841113c4bad7ef1672e349753b10190e7608a64da57d720'},'gzip210');assert.throws(()=>storage210(previous21),'historical20-replacement Source21 cannot replace Source22');
 const previous22=sqlRow(D,{...S,bytes:4761964,sha256:'9e3ba852a350877d4d2106c7d794a29f236dd4794b4ef00d41fd15a6a0e5fe52',stored_bytes:551782,stored_sha256:'6b82330856575dfdd2ba35b5b10ca6fc8406504b505b5974eaaeddc977d9775c'},'gzip210');assert.throws(()=>storage210(previous22),'historical Source22 with21 replacements cannot substitute current Source23');
 const previous23=sqlRow(D,{...S,bytes:5090619,sha256:'0d461821282c632455e573a7a277c1ecbf05da24c8e0fe214308d16d9efab9f1',stored_bytes:591695,stored_sha256:'38e418544454fe315434898bc8e444398af77dbbf4df05343f98d2d2234c6240'},'gzip210');assert.throws(()=>storage210(previous23),'same22-key Source23 cannot substitute current Source24');
 const previous24=sqlRow(D,{...S,bytes:5093221,sha256:'59bafbea5dabb4e8ccd65139d9075f5433be252545971c04a9f0d0cc226ba2d7',stored_bytes:592117,stored_sha256:'5e86c3e5c5a4fcd8135b0a0a4f00a8d1127ae83021af9cfb657da71a8aaf9cbe'},'gzip210');assert.throws(()=>storage210(previous24),'same22-key Source24 cannot substitute current Source25');
 const previous25=sqlRow(D,{...S,bytes:5095544,sha256:'d9498e231ea31c10c2182c94de442ac4e5edd94525ab8db8fcfee314582de4d3',stored_bytes:592532,stored_sha256:'d9465a23f040e5570db2c8f078663741177e518e0981964371db0ecdbc8299a9'},'gzip210');assert.throws(()=>storage210(previous25),'same22-key Source25 cannot substitute current Source26');
 const previous26=sqlRow(D,{...S,bytes:5095667,sha256:'082e4bed0cf507ceb12c9e351f97fe54c051bf9e332da50546e71f124bcc621a',stored_bytes:592554,stored_sha256:'8d66c1fda0262a45558338c5267c4633484b80f023b0f85e868aba43680572eb'},'gzip210');assert.throws(()=>storage210(previous26),'same22-key Source26 cannot substitute current Source27');
 const previous27=sqlRow(D,{...S,bytes:5096180,sha256:'eeb5034d0d26766f4548a895e3a23b9ae2ab9ad7854215583e8995d9a218c6e3',stored_bytes:592595,stored_sha256:'827c16deeb3640815ea151e29a61391686652f3558f2b76a845cff9448e97d24'},'gzip210');assert.throws(()=>storage210(previous27),'same22-key Source27 cannot substitute current Source28');
 const previous28=sqlRow(D,{...S,bytes:5096765,sha256:'0efeb7fab0521edd3e4130930750482722548e52c32dc553b3787c4774673766',stored_bytes:590882,stored_sha256:'88cb0d063a89c88c15c64b2cf7467d22cd15a5434d0b94fdfe0d3af5fad89646'},'gzip210');assert.throws(()=>storage210(previous28),'same22-key Source28 cannot substitute current Source29');
 const previous29=sqlRow(D,{...S,bytes:5094543,sha256:'bd61089c06f26c9195f5fd002b22424dab8e36dad37580b4cc9c9e259d200bb7',stored_bytes:592271,stored_sha256:'ef2d290a6997f0a28be9e05ed97eb9b335ba74a904d37d02455230a61e75a179'},'gzip210');assert.throws(()=>storage210(previous29),'same22-key Source29 cannot substitute current Source30');
 const previous30=sqlRow(D,{...S,bytes:5094845,sha256:'f2f3d9cf78724bc173a3fca1afee4c8b887c1b5bf7b7d5041eeb720c77530c3a',stored_bytes:592358,stored_sha256:'f2cc4610ea80906f3969d32a23e135e5756ab7835aae7862b50fefa742a0399b'},'gzip210');assert.throws(()=>storage210(previous30),'complete Source30 representation cannot authorize Source31');
 const previous31=sqlRow(D,{...S,bytes:4524547,sha256:'3e99139ded0b97012846f5d1bb023e60bb289b307a0647d3302419c3f60414ab',stored_bytes:531238,stored_sha256:'ee237ea1961e6feb355ba9c4ea40d483f62a415fbdb75183c62b3b9d67cbb0ad'},'gzip210');assert.throws(()=>storage210(previous31),'complete Source31 representation cannot authorize Source32');
 const previous32=sqlRow(D,{...S,bytes:4524613,sha256:'a737148ee97845de656b38d5a92dea341c6040c2ae8b39557d2e248c26c6fc8b',stored_bytes:531254,stored_sha256:'4f2ba3cc8be00d1746b41c81e88c24cdbafaaa7cd12bd3f7694d3b7d0ba7b450'},'gzip210');assert.throws(()=>storage210(previous32),'complete Source32 representation cannot authorize Source33');
 const previous33=sqlRow(D,{...S,bytes:4525227,sha256:'23cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d',stored_bytes:531367,stored_sha256:'2cf81c97acb0461f07937e392549c594db1d28831dbacde590fc5c7f670d13b4'},'gzip210');assert.throws(()=>storage210(previous33),'complete Source33 representation cannot authorize Source34');
 const changed=Buffer.from(raw);changed[0]^=1;assert.throws(()=>encodeResource210(changed),/source-sha/);
 const changedPacked=Buffer.from(packed);changedPacked[20]^=1;assert.throws(()=>decodeResource210(changedPacked),/gzip-sha/);
 for(const bad of [packed.subarray(0,-1),Buffer.concat([packed,Buffer.from([0])]),Buffer.concat([packed,packed]),gzipSync(Buffer.alloc(S.bytes+1)),gzipSync(Buffer.from([0xc3,0x28]))])assert.throws(()=>decodeResource210(bad));
 assert.throws(()=>encodeResource210(Buffer.alloc(S.bytes-1)),/exact-length/);
});
