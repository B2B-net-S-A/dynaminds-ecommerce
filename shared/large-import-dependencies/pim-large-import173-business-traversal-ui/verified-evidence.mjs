/** Source-only proposal. No activation, DB, network, default filesystem work, or skipped native profile/IAM checks. */
import assert from 'node:assert/strict';
import {lstat,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const identityKeys=['dev','ino','size','mode','nlink','uid','gid'];const fingerprint=s=>[...identityKeys,...(typeof s.mtimeNs==='bigint'&&typeof s.ctimeNs==='bigint'?['mtimeNs','ctimeNs']:['mtimeMs','ctimeMs'])].map(k=>{assert.equal(typeof s[k],'bigint','BigInt filesystem identity required');return String(s[k]);}).join(':');
const eligible=s=>typeof s.mtimeNs==='bigint'&&typeof s.ctimeNs==='bigint'&&s.ctimeNs%1000n!==0n;
function regular(s,privateFile){assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n,'regular singly-linked evidence required');if(privateFile)assert.equal(s.mode&0o777n,0o600n,'private evidence permissions');}
/** Per-private-startup handle cache. Stores fingerprints/digests, never file contents or serialized authority. */
export function createVerifiedEvidenceCache(options={}){
 const clockPolicy=options.clockPolicy??'rehash-always';assert(['submicrosecond-ctime-required','rehash-always'].includes(clockPolicy),'explicit supported clock policy required');
 const entries=new Map();const counters={hashed_files:0,hashed_bytes:0,cache_hits:0,stat_calls:0,canonical_checks:0,coarse_or_forced_rehashes:0};
 async function stat(path){counters.stat_calls++;return lstat(path,{bigint:true});}
 async function one(ref,forceFullHash){
  const path=ref.path,sha256=ref.sha256,privateFile=ref.privateFile===true;
  assert.equal(path,resolve(path));assert.match(sha256,/^[a-f0-9]{64}$/);assert(ref.privateFile===undefined||typeof ref.privateFile==='boolean');
  const key=path+'\0'+sha256+'\0'+privateFile;
  try{
   const before=await stat(path);regular(before,privateFile);counters.canonical_checks++;assert.equal(await realpath(path),path,'evidence path must be canonical; parent aliases refuse');const stamp=fingerprint(before),cacheAllowed=!forceFullHash&&clockPolicy!=='rehash-always'&&eligible(before);if(!cacheAllowed)counters.coarse_or_forced_rehashes++;
   if(cacheAllowed&&entries.get(key)===stamp){const after=await stat(path);counters.canonical_checks++;assert.equal(await realpath(path),path,'evidence cached path alias changed');regular(after,privateFile);assert.equal(fingerprint(after),stamp,'evidence changed during cached check');counters.cache_hits++;return;}
   const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    const opened=await fd.stat({bigint:true});regular(opened,privateFile);assert.equal(fingerprint(opened),stamp,'evidence identity changed before open');
    assert(before.size<=536870912n,'bounded reviewed evidence512MiB');const digest=createHash('sha256'),chunk=Buffer.alloc(1048576);let total=0;for(;;){const{bytesRead}=await fd.read(chunk,0,chunk.length,null);if(bytesRead===0)break;total+=bytesRead;assert(BigInt(total)<=before.size,'evidence grew during hashing');digest.update(chunk.subarray(0,bytesRead));}counters.hashed_files++;counters.hashed_bytes+=total;assert.equal(BigInt(total),before.size,'evidence complete read');assert.equal(digest.digest('hex'),sha256,'reviewed evidence bytes');
    const readAfter=await fd.stat({bigint:true});regular(readAfter,privateFile);assert.equal(fingerprint(readAfter),stamp,'evidence changed while hashing');
   }finally{await fd.close();}
   const after=await stat(path);regular(after,privateFile);counters.canonical_checks++;assert.equal(await realpath(path),path,'evidence hashed path alias changed');assert.equal(fingerprint(after),stamp,'evidence path changed while hashing');entries.set(key,stamp);
  }catch(e){entries.delete(key);throw e;}
 }
 return Object.freeze({async verify(refs,settings={}){const copied=structuredClone(refs);assert(Array.isArray(copied));assert(settings.forceFullHash===undefined||typeof settings.forceFullHash==='boolean');const force=settings.forceFullHash===true;for(const ref of copied)await one(ref,force);},metrics(){return Object.freeze({...counters,cached_entries:entries.size});}});
}
