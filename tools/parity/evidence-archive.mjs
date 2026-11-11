/** Explicit byte-preserving evidence storage. Never changes claims or executes evidence. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),MAX=32*1024*1024,SCHEMA='dynaminds-parity-evidence-archive/v1';
const sha=b=>createHash('sha256').update(b).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,n)=>object(v)&&Object.keys(v).sort().join(',')===[...n].sort().join(',');
export class EvidenceArchiveError extends Error{constructor(code){super(code);this.name='EvidenceArchiveError';this.code=code;}}
const need=(v,c)=>{if(!v)throw new EvidenceArchiveError(c);};
const within=(p,root)=>path.isAbsolute(p)&&path.resolve(p)===p&&p.startsWith(root+path.sep);
const key=r=>JSON.stringify([r.path,r.bytes,r.sha256]);
const identity=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
function reference(ref,root){need(keys(ref,['path','sha256','bytes'])&&within(ref.path,root)&&/^[a-f0-9]{64}$/.test(ref.sha256)&&Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=MAX,'EVIDENCE_ARCHIVE_REF');}
async function rootCheck(root){need(path.isAbsolute(root)&&path.resolve(root)===root&&await fs.realpath(root)===root&&(await fs.lstat(root)).isDirectory(),'EVIDENCE_ARCHIVE_ROOT');}
async function bytes(ref,root){
 reference(ref,root);need(await fs.realpath(ref.path)===ref.path,'EVIDENCE_ARCHIVE_CANONICAL');
 let current=root;for(const component of path.relative(root,path.dirname(ref.path)).split(path.sep).filter(Boolean)){current=path.join(current,component);const s=await fs.lstat(current);need(s.isDirectory()&&!s.isSymbolicLink()&&await fs.realpath(current)===current,'EVIDENCE_ARCHIVE_PARENT');}
 const before=await fs.lstat(ref.path,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size===BigInt(ref.bytes),'EVIDENCE_ARCHIVE_FILE');
 const fd=await fs.open(ref.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{need(identity(await fd.stat({bigint:true}))===identity(before),'EVIDENCE_ARCHIVE_IDENTITY');const result=await fd.readFile();need(result.length===ref.bytes&&sha(result)===ref.sha256,'EVIDENCE_ARCHIVE_DIGEST');need(identity(await fd.stat({bigint:true}))===identity(before)&&identity(await fs.lstat(ref.path,{bigint:true}))===identity(before),'EVIDENCE_ARCHIVE_IDENTITY');return result;}finally{await fd.close();}
}
function provenance(value,root){
 if(value?.kind==='file'){need(keys(value,['kind','path'])&&within(value.path,root),'EVIDENCE_ARCHIVE_SOURCE');return;}
 need(keys(value,['kind','repository','object'])&&value.kind==='git_blob'&&within(value.repository,root)&&/^[a-f0-9]{40}$/.test(value.object),'EVIDENCE_ARCHIVE_SOURCE');
}
/** A pinned manifest is a storage map only: retained bytes MUST equal the original digest. */
export async function loadEvidenceArchive(ref,{root}={}){
 await rootCheck(root);const document=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await bytes(ref,root)));
 need(keys(document,['schema','entries','acceptance_granted'])&&document.schema===SCHEMA&&document.acceptance_granted===false&&Array.isArray(document.entries)&&document.entries.length>0&&document.entries.length<=4096,'EVIDENCE_ARCHIVE_SCHEMA');
 const seen=new Set(),retained=new Map();let total=0;
 for(const row of document.entries){need(keys(row,['original_ref','retained_ref','source']),'EVIDENCE_ARCHIVE_ENTRY');reference(row.original_ref,root);reference(row.retained_ref,root);provenance(row.source,root);const id=key(row.original_ref);need(!seen.has(id),'EVIDENCE_ARCHIVE_DUPLICATE');seen.add(id);need(row.original_ref.sha256===row.retained_ref.sha256&&row.original_ref.bytes===row.retained_ref.bytes,'EVIDENCE_ARCHIVE_NOT_IDENTICAL');
  if(!retained.has(row.retained_ref.path)){total+=row.retained_ref.bytes;need(total<=MAX,'EVIDENCE_ARCHIVE_TOTAL');await bytes(row.retained_ref,root);retained.set(row.retained_ref.path,row.retained_ref);}
  else need(key(retained.get(row.retained_ref.path))===key(row.retained_ref),'EVIDENCE_ARCHIVE_CONFLICT');
 }
 return Object.freeze({entries:Object.freeze(document.entries.map(row=>Object.freeze({original_ref:Object.freeze({...row.original_ref}),retained_ref:Object.freeze({...row.retained_ref})})))});
}
export function retainedEvidenceRef(archive,ref){if(!object(ref))return ref;return archive?.entries.find(row=>key(row.original_ref)===key(ref))?.retained_ref??ref;}
async function save(file,value){const fd=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(value);await fd.sync();}finally{await fd.close();}}
/** Root invokes explicitly. Git objects are named, never discovered or learned from current bytes. */
export async function preserveEvidenceArchive({root,outputDirectory,entries}){
 await rootCheck(root);need(within(outputDirectory,root)&&await fs.realpath(path.dirname(outputDirectory))===path.dirname(outputDirectory),'EVIDENCE_ARCHIVE_OUTPUT');need(Array.isArray(entries)&&entries.length>0&&entries.length<=4096,'EVIDENCE_ARCHIVE_ENTRIES');
 const seen=new Set(),payloads=new Map(),rows=[];let total=0;
 for(const entry of entries){need(keys(entry,['original_ref','source']),'EVIDENCE_ARCHIVE_INPUT');reference(entry.original_ref,root);provenance(entry.source,root);need(!seen.has(key(entry.original_ref)),'EVIDENCE_ARCHIVE_DUPLICATE');seen.add(key(entry.original_ref));let value;
  if(entry.source.kind==='file')value=await bytes({...entry.original_ref,path:entry.source.path},root);
  else{need(await fs.realpath(entry.source.repository)===entry.source.repository,'EVIDENCE_ARCHIVE_REPOSITORY');const result=await run('git',['-C',entry.source.repository,'cat-file','blob',entry.source.object],{encoding:'buffer',maxBuffer:MAX});value=result.stdout;need(value.length===entry.original_ref.bytes&&sha(value)===entry.original_ref.sha256,'EVIDENCE_ARCHIVE_DIGEST');need(createHash('sha1').update(Buffer.concat([Buffer.from('blob '+value.length+'\0'),value])).digest('hex')===entry.source.object,'EVIDENCE_ARCHIVE_GIT_OBJECT');}
  const name=entry.original_ref.sha256+'.bin';if(!payloads.has(name)){total+=value.length;need(total<=MAX,'EVIDENCE_ARCHIVE_TOTAL');payloads.set(name,value);}
  rows.push({original_ref:structuredClone(entry.original_ref),retained_ref:{path:outputDirectory+'/'+name,sha256:entry.original_ref.sha256,bytes:entry.original_ref.bytes},source:structuredClone(entry.source)});
 }
 await fs.mkdir(outputDirectory,{mode:0o700});for(const[name,value]of payloads)await save(outputDirectory+'/'+name,value);
 return manifest(root,outputDirectory,rows);
}
async function manifest(root,outputDirectory,rows){
 const document={schema:SCHEMA,entries:rows,acceptance_granted:false},raw=Buffer.from(JSON.stringify(document,null,2)+'\n'),ref={path:outputDirectory+'/archive.json',sha256:sha(raw),bytes:raw.length};need(raw.length<=8*1024*1024,'EVIDENCE_ARCHIVE_MANIFEST_CAP');await save(ref.path,raw);await loadEvidenceArchive(ref,{root});return Object.freeze(ref);
}
/** Successor storage after a further pinned file drifts: every parent row is copied verbatim
 * (retained location and provenance included, as createScopeSnapshot requires); only the new
 * historical pins are retained, under outputDirectory/new-retained. */
export async function extendEvidenceArchive({root,parent,outputDirectory,entries}){
 await rootCheck(root);need(within(outputDirectory,root)&&await fs.realpath(path.dirname(outputDirectory))===path.dirname(outputDirectory),'EVIDENCE_ARCHIVE_OUTPUT');
 await loadEvidenceArchive(parent,{root});const previous=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await bytes(parent,root)));
 need(Array.isArray(entries)&&entries.every(e=>object(e?.original_ref)&&!previous.entries.some(row=>key(row.original_ref)===key(e.original_ref))),'EVIDENCE_ARCHIVE_DUPLICATE');
 await fs.mkdir(outputDirectory,{mode:0o700});const added=await preserveEvidenceArchive({root,outputDirectory:outputDirectory+'/new-retained',entries});
 const fresh=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await bytes(added,root)));await fs.unlink(added.path);
 return manifest(root,outputDirectory,[...previous.entries,...fresh.entries]);
}
