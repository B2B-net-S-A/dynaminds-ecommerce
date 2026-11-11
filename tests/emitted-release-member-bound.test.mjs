/** An emitted package member is bounded at 32 MiB (33554432 B) in the package builder (put), in both copies of the
 * emitted-release validator and in the bounded file reader both of them use (portable-release.mjs packageBytes,
 * MAX_FILE; tools/build and the shared mirror the source contract checks byte for byte). At
 * HEAD fcc7b89 (migrations through 258) esbuild's shared runtime chunk is 16821474 B, 44258 B over the former 16 MiB
 * member bound, so tools/scale/release-build.mjs failed in put(). A member of exactly 32 MiB passes the member check
 * and is refused only later for the missing contract member; one more byte is refused by the member check before
 * any member is read. The 128 MiB package total and the 64 MiB source-contract total are unchanged.
 * Real files in a temporary directory; no emitter, PostgreSQL or app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MEMBER=33554432;
const sha=b=>createHash('sha256').update(b).digest('hex');
const copies=['../tools/build/emitted-release.mjs','../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/emitted-release.mjs'];
const readers=['../tools/build/portable-release.mjs','../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/portable-release.mjs'];

test('the builder and both emitted-release copies name the 32 MiB member bound, the 128 MiB total stays',async()=>{
 const [a,b]=await Promise.all(copies.map(c=>fs.readFile(new URL(c,import.meta.url),'utf8')));
 assert.equal(a,b);
 assert.match(a,/f\.bytes<=32\*1024\*1024&&\/\^\[a-f0-9\]\{64\}\$\/\.test\(f\.sha256\),'emitted-member-32MiB'\)/);
 assert.match(a,/assert\(total<=128\*1024\*1024,'emitted-total-128MiB'\)/);
 assert(!/f\.bytes<=16\*1024\*1024/.test(a),'no stale 16 MiB member bound');
 const builder=await fs.readFile(new URL('../tools/build/package-builder.mjs',import.meta.url),'utf8');
 assert.match(builder,/assert\(bytes\.length<=32\*1024\*1024,'emitted-member-32MiB'\)/);
 assert(!/bytes\.length<=16\*1024\*1024/.test(builder),'no stale 16 MiB builder bound');
 const [r,q]=await Promise.all(readers.map(c=>fs.readFile(new URL(c,import.meta.url),'utf8')));
 assert.equal(r,q);
 assert.match(r,/const MAX_FILE=32\*1024\*1024,MAX_TOTAL=64\*1024\*1024;/);
});

test('a member of exactly 32 MiB passes the member bound; one more byte is refused by it',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'emitted-member-bound-')));
 try{
  const pad=Buffer.alloc(MEMBER,0x61);
  await fs.mkdir(path.join(root,'runtime'));
  await fs.writeFile(path.join(root,'runtime/pad'),pad);
  const at=[{path:'runtime/pad',bytes:MEMBER,sha256:sha(pad),role:'emitted-runtime'}];
  const over=[{path:'runtime/pad',bytes:MEMBER+1,sha256:sha(pad),role:'emitted-runtime'}];
  const manifest=members=>Buffer.from(JSON.stringify({schema:'dynaminds-emitted-local-release/v1',scope:'EMITTED_LOCAL_PACKAGE_RESOURCE_REVIEW_PENDING',origin:'REAL_SOURCE_DERIVED_EXPECTATION_NOT_OBSERVED_NATIVE_AUTHORITY',application_activation:false,native_installation:'NOT_RUN',installed_adapter_acceptance:'NOT_AVAILABLE',static_resource_completeness:'NOT_PROVEN',files:members}));
  for(const copy of copies){
   const {loadValidatedEmittedRelease}=await import(new URL(copy,import.meta.url));
   const load=async members=>{const raw=manifest(members);await fs.writeFile(path.join(root,'release.json'),raw);return loadValidatedEmittedRelease({releaseDirectory:root,manifestSha:sha(raw)});};
   // Exactly at the bound: the member is read and hashed, then the absent contract member refuses.
   await assert.rejects(load(at),/emitted-linked-role/,copy);
   await assert.rejects(load(over),/emitted-member-32MiB/,copy);
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
