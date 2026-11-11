/** The emitted package total is bounded at 128 MiB (134217728 B) in both copies of the emitted-release
 * validator (tools/build and the shared mirror the source contract checks byte for byte); the per-member
 * bound is 32 MiB (tests/emitted-release-member-bound.test.mjs). A package of exactly 128 MiB passes the total check and is refused only later for
 * its missing contract member; one more byte is refused by the total check before that member is read.
 * Real files in a temporary directory; no emitter, PostgreSQL or app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MEMBER=16777216,BOUND=134217728; // 8 members of 16 MiB (under the 32 MiB member bound)
const sha=b=>createHash('sha256').update(b).digest('hex');
const copies=['../tools/build/emitted-release.mjs','../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/emitted-release.mjs'];

test('both emitted-release copies are byte-equal and name the 128 MiB total and 32 MiB member bounds',async()=>{
 const [a,b]=await Promise.all(copies.map(c=>fs.readFile(new URL(c,import.meta.url),'utf8')));
 assert.equal(a,b);
 assert.match(a,/assert\(total<=128\*1024\*1024,'emitted-total-128MiB'\)/);assert.match(a,/f\.bytes<=32\*1024\*1024/);
 assert(!/96\*1024\*1024/.test(a),'no stale 96 MiB package bound');
});

test('a package of exactly 128 MiB passes the total bound; one more byte is refused by it',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'emitted-total-bound-')));
 try{
  const pad=Buffer.alloc(MEMBER,0x61),files=[];
  await fs.mkdir(path.join(root,'runtime'));
  for(let i=0;i<BOUND/MEMBER;i++){const p='runtime/pad'+i;await fs.writeFile(path.join(root,p),pad);files.push({path:p,bytes:MEMBER,sha256:sha(pad),role:'emitted-runtime'});}
  const manifest=members=>Buffer.from(JSON.stringify({schema:'dynaminds-emitted-local-release/v1',scope:'EMITTED_LOCAL_PACKAGE_RESOURCE_REVIEW_PENDING',origin:'REAL_SOURCE_DERIVED_EXPECTATION_NOT_OBSERVED_NATIVE_AUTHORITY',application_activation:false,native_installation:'NOT_RUN',installed_adapter_acceptance:'NOT_AVAILABLE',static_resource_completeness:'NOT_PROVEN',files:members}));
  const one=Buffer.from('b');
  const over=[...files,{path:'runtime/one-more',bytes:1,sha256:sha(one),role:'emitted-runtime'}];
  for(const copy of copies){
   const {loadValidatedEmittedRelease}=await import(new URL(copy,import.meta.url));
   const load=async members=>{const raw=manifest(members);await fs.writeFile(path.join(root,'release.json'),raw);return loadValidatedEmittedRelease({releaseDirectory:root,manifestSha:sha(raw)});};
   assert.equal(files.reduce((n,f)=>n+f.bytes,0),BOUND);
   // Exactly at the bound: every member is read and hashed, then the absent contract member refuses.
   await assert.rejects(load(files),/emitted-linked-role/,copy);
   await fs.writeFile(path.join(root,'runtime/one-more'),one);
   await assert.rejects(load(over),/emitted-total-128MiB/,copy);
   await fs.rm(path.join(root,'runtime/one-more'));
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
