/** Bounded file IO only; does not grant Startup, installed readiness, or resource capabilities. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {RESOURCE209_DEFINITION,RESOURCE209_SQL} from './resource-format209.mjs';
export const resourceSha=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=s=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
async function boundedResourceBytes(root,name,expected,maxBytes){
 assert(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root,'resource-root-canonical');
 assert(typeof name==='string'&&name.length<=500&&!/[\\\0:]/.test(name)&&!path.posix.isAbsolute(name)&&path.posix.normalize(name)===name&&name.split('/').every(s=>s&&s!=='.'&&s!=='..'),'resource-fixed-relative-name');
 const rs=await fs.lstat(root);assert(rs.isDirectory()&&!rs.isSymbolicLink());assert.equal(await fs.realpath(root),root);
 let parent=root;for(const component of name.split('/').slice(0,-1)){parent=path.join(parent,component);const s=await fs.lstat(parent);assert(s.isDirectory()&&!s.isSymbolicLink(),'resource-parent-directory');assert.equal(await fs.realpath(parent),parent);}
 const file=path.join(root,name),before=await fs.lstat(file,{bigint:true});assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=BigInt(maxBytes),'resource-regular-bounded');assert.equal(await fs.realpath(file),file);
 if(expected){assert(Number.isSafeInteger(expected.bytes)&&expected.bytes>=0&&expected.bytes<=maxBytes);assert(/^[a-f0-9]{64}$/.test(expected.sha256));assert.equal(Number(before.size),expected.bytes,'resource-size');}
 const fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{
  assert.equal(identity(await fd.stat({bigint:true})),identity(before));
  // The file may grow after lstat. Never let readFile allocate based on that growth.
  const size=Number(before.size),buffer=Buffer.alloc(size+1);let used=0;
  while(used<buffer.length){const remaining=buffer.length-used,{bytesRead}=await fd.read(buffer,used,remaining,null);assert(Number.isSafeInteger(bytesRead)&&bytesRead>=0&&bytesRead<=remaining,'resource-read-byte-count');if(bytesRead===0)break;used+=bytesRead;assert(used<=size,'resource-read-grew');}
  assert.equal(used,size,'resource-read-size-drift');const bytes=buffer.subarray(0,used);assert(bytes.length<=maxBytes);
  assert.equal(identity(await fd.stat({bigint:true})),identity(before));assert.equal(identity(await fs.lstat(file,{bigint:true})),identity(before));assert.equal(await fs.realpath(file),file);
  if(expected)assert.equal(resourceSha(bytes),expected.sha256,'resource-sha');return bytes;
 }finally{await fd.close();}
}

/** Generic limit remains exactly 16 MiB. No public limit override. */
export async function resourceBytes(root,name,expected){return boundedResourceBytes(root,name,expected,16777216);}
/** The sole larger source read is fixed to this exact authored SQL file and raw digest. */
export async function resource209SourceBytes(root){return boundedResourceBytes(root,RESOURCE209_DEFINITION.source,{bytes:RESOURCE209_SQL.bytes,sha256:RESOURCE209_SQL.sha256},RESOURCE209_SQL.bytes);}
function decoded209(bytes){assert(Buffer.isBuffer(bytes)&&bytes.length===RESOURCE209_SQL.bytes,'resource209-decoded-exact-length');assert.equal(resourceSha(bytes),RESOURCE209_SQL.sha256,'resource209-decoded-source-sha');new TextDecoder('utf-8',{fatal:true}).decode(bytes);return bytes;}
export function encodeResource209(bytes){decoded209(bytes);const packed=gzipSync(bytes,{level:9});assert.equal(packed.length,RESOURCE209_SQL.stored_bytes,'resource209-fixed-gzip-length');assert.equal(resourceSha(packed),RESOURCE209_SQL.stored_sha256,'resource209-fixed-gzip-sha');return packed;}
export function decodeResource209(packed){assert(Buffer.isBuffer(packed)&&packed.length===RESOURCE209_SQL.stored_bytes,'resource209-fixed-gzip-length');assert.equal(resourceSha(packed),RESOURCE209_SQL.stored_sha256,'resource209-fixed-gzip-sha');return decoded209(gunzipSync(packed,{maxOutputLength:RESOURCE209_SQL.bytes}));}
