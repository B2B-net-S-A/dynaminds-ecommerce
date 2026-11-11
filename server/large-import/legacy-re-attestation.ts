/** Private authenticated operator. Preserves an existing unusable legacy cut across one reviewed Source successor.
 * No route, Native DML, synthetic custody, outcome resolution or reservation-ceiling update.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {recheckReviewedStartupEvidence} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import {inspectLegacyQuarantineForSuccessor,openLegacyQuarantine,type LegacyRef} from './legacy-quarantine';

const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
const PREVIOUS='d25eda98c05593bc433f03031aca7f7a046356b0921330b4b664db3f63eee5f5';
export const LEGACY_SUCCESSOR_SOURCE_PATHS=Object.freeze(['server/large-import/public-installed-input.ts','server/large-import/legacy-quarantine.ts','server/large-import/legacy-re-attestation.ts','server/large-import/local-quota-enrollment.ts','server/large-import/charged-unknown-inspection.ts','server/large-import/quota-renewal-inspection.ts','server/large-import/local-quota.ts','shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/installed-census.ts','shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/registry.ts','shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/closed-proof.ts']as const);
type Source={path:string;sha256:string;bytes:number};
export type LegacyReviewedSourceChange={path:typeof LEGACY_SUCCESSOR_SOURCE_PATHS[number];before:Source|null;after:Source};
type Release={directory:string;manifest:LegacyRef};
type Inspection=Parameters<typeof inspectLegacyQuarantineForSuccessor>[0];
export type LegacyReattestationInput=Omit<Inspection,'authorization'|'expectedPreviousRelease'>&{authorization:'ROOT_REATTEST_EXACT_UNUSABLE_LEGACY_BASELINE_ON_REVIEWED_SUCCESSOR_RELEASE';previousRelease:Release;currentRelease:Release;reviewedSourceChanges:LegacyReviewedSourceChange[];outputRefPath:string};
const stat=(s:any)=>['dev','ino','uid','mode','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
function member(x:any){assert(x&&typeof x==='object'&&!Array.isArray(x)&&typeof x.path==='string'&&x.path.length>0&&!x.path.startsWith('/')&&!x.path.includes('\\')&&x.path.split('/').every((p:string)=>p!==''&&p!=='.'&&p!=='..')&&/^[a-f0-9]{64}$/.test(x.sha256)&&Number.isSafeInteger(x.bytes)&&x.bytes>=0);}
async function bytes(file:string,max:number,privateMode=false){
 assert(file===resolve(file)&&await realpath(file)===file);const s=await lstat(file,{bigint:true});assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.uid===BigInt(process.getuid!())&&s.size<=BigInt(max)&&(!privateMode||(s.mode&511n)===384n));
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW),buf=Buffer.alloc(65536),parts:Buffer[]=[];let n=0;
 try{assert.equal(stat(await fd.stat({bigint:true})),stat(s));for(;;){const r=await fd.read(buf,0,buf.length,n);if(!r.bytesRead)break;n+=r.bytesRead;assert(n<=max&&BigInt(n)<=s.size);parts.push(Buffer.from(buf.subarray(0,r.bytesRead)));}assert(BigInt(n)===s.size);assert.equal(stat(await fd.stat({bigint:true})),stat(s));assert.equal(stat(await lstat(file,{bigint:true})),stat(s));return Buffer.concat(parts);}
 finally{buf.fill(0);for(const p of parts)p.fill(0);await fd.close();}
}
async function readManifest(r:Release){assert(Object.keys(r).sort().join(',')==='directory,manifest'&&r.directory===resolve(r.directory)&&await realpath(r.directory)===r.directory);assert(r.manifest.path===join(r.directory,'release.json')&&Object.keys(r.manifest).sort().join(',')==='bytes,path,sha256'&&Number.isSafeInteger(r.manifest.bytes)&&r.manifest.bytes>0&&r.manifest.bytes<=4194304);const b=await bytes(r.manifest.path,4194304);assert(b.length===r.manifest.bytes&&sha(b)===r.manifest.sha256);return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(b));}

/** Pure compatibility comparison; actual operator also checks both manifest refs and all payload file bytes. */
export function compareLegacyReattestationManifests(previous:any,current:any,changes:LegacyReviewedSourceChange[],contracts:{previous:any;current:any;previousSha256:string;currentSha256:string}){
 assert(previous?.schema==='dynaminds-emitted-local-release/v1'&&current?.schema===previous.schema);
 assert.deepEqual(Object.keys(previous).sort(),Object.keys(current).sort());
 for(const key of Object.keys(previous))if(!['emitted_sources','files','emitted_output_closure','source_contract_manifest_sha256'].includes(key))assert.deepEqual(current[key],previous[key],'legacy-successor-package-field-'+key);
 assert.deepEqual(current.emitted_output_closure.roots,previous.emitted_output_closure.roots,'legacy-successor-entry-roots');
 assert(Array.isArray(changes)&&changes.length===LEGACY_SUCCESSOR_SOURCE_PATHS.length&&new Set(changes.map(c=>c.path)).size===changes.length);
 const oldSources=new Map<string,Source>(),newSources=new Map<string,Source>();
 for(const [manifest,map]of [[previous,oldSources],[current,newSources]]as const){assert(Array.isArray(manifest.emitted_sources)&&manifest.emitted_sources.length<=10000);for(const s of manifest.emitted_sources){member(s);assert(Object.keys(s).sort().join(',')==='bytes,path,sha256'&&!map.has(s.path));map.set(s.path,s);}}
 const admitted=new Map<string,LegacyReviewedSourceChange>();
 for(const c of changes){assert(Object.keys(c).sort().join(',')==='after,before,path'&&LEGACY_SUCCESSOR_SOURCE_PATHS.includes(c.path));member(c.after);assert(c.after.path===c.path);assert.deepEqual(newSources.get(c.path),c.after);if(c.before===null){assert(['server/large-import/legacy-re-attestation.ts','server/large-import/charged-unknown-inspection.ts'].includes(c.path)&&!oldSources.has(c.path));}else{member(c.before);assert(c.before.path===c.path);assert.deepEqual(oldSources.get(c.path),c.before);assert.notDeepEqual(c.before,c.after);}admitted.set(c.path,c);}
 for(const [p,s]of oldSources){assert(newSources.has(p),'legacy-successor-source-removed');if(!admitted.has(p))assert.deepEqual(newSources.get(p),s,'legacy-successor-unreviewed-source-change');}
 for(const p of newSources.keys())assert(oldSources.has(p)||admitted.has(p),'legacy-successor-unreviewed-source-added');
 function stableFiles(m:any){assert(Array.isArray(m.files)&&m.files.length<=10000);const paths=new Set();return m.files.filter((f:any)=>{member(f);assert(!paths.has(f.path));paths.add(f.path);return !f.path.startsWith('runtime/')&&f.path!=='contract/source-release-manifest.json';}).sort((a:any,b:any)=>a.path.localeCompare(b.path));}
 assert.deepEqual(stableFiles(current),stableFiles(previous),'legacy-successor-Native-Source59-resource-static-payload-drift');
 assert(contracts&&contracts.previousSha256===previous.source_contract_manifest_sha256&&contracts.currentSha256===current.source_contract_manifest_sha256,'legacy-successor-Source59-actual-hash');
 const oldContract=contracts.previous,newContract=contracts.current;
 assert(oldContract?.schema==='dynaminds-importer-source-release/v1'&&newContract?.schema===oldContract.schema);assert.deepEqual(Object.keys(newContract).sort(),Object.keys(oldContract).sort());
 for(const key of Object.keys(oldContract))if(key!=='files')assert.deepEqual(newContract[key],oldContract[key],'legacy-successor-Source59-field-'+key);
 assert(Array.isArray(oldContract.files)&&oldContract.files.length===59&&Array.isArray(newContract.files)&&newContract.files.length===59);
 const oldMembers=new Map<string,any>(),newMembers=new Map<string,any>();for(const [contract,map]of [[oldContract,oldMembers],[newContract,newMembers]]as const)for(const f of contract.files){member(f);assert(!map.has(f.path));map.set(f.path,f);}
 for(const [p,old]of oldMembers){const next=newMembers.get(p);assert(next,'legacy-successor-Source59-member-removed');const c=admitted.get(p);if(['server/large-import/quota-renewal-inspection.ts','server/large-import/local-quota.ts'].includes(p)){assert(c&&c.before&&c.before.sha256===old.sha256&&c.before.bytes===old.bytes);assert.deepEqual(next,{...old,sha256:c.after.sha256,bytes:c.after.bytes},'legacy-successor-Source59-reviewed-tuple');}else assert.deepEqual(next,old,'legacy-successor-Source59-unreviewed-member');}
 for(const [manifest,digest]of [[previous,contracts.previousSha256],[current,contracts.currentSha256]]as const){const f=manifest.files.filter((f:any)=>f.path==='contract/source-release-manifest.json');assert(f.length===1&&f[0].sha256===digest);const old=previous.files.find((f:any)=>f.path==='contract/source-release-manifest.json');assert.deepEqual(f[0],{...old,sha256:f[0].sha256,bytes:f[0].bytes},'legacy-successor-Source59-payload-metadata');}
 return {schema:'legacy-reviewed-release-compatibility/v1' as const,changed_sources:changes.map(c=>c.path).sort(),Native_resources_static_dependencies_and_other57_Source_members_literal:true as const};
}
async function verifyPayloads(release:Release,manifest:any){
 let total=0;for(const f of manifest.files){member(f);total+=f.bytes;assert(total<=268435456);const b=await bytes(join(release.directory,f.path),134217728);assert(b.length===f.bytes&&sha(b)===f.sha256,'legacy-successor-actual-payload-hash');}
}

export async function reattestLegacyQuarantine(input:LegacyReattestationInput){
 const x={...input,currentRoots:structuredClone(input.currentRoots),baselineRef:structuredClone(input.baselineRef),previousRelease:structuredClone(input.previousRelease),currentRelease:structuredClone(input.currentRelease),reviewedSourceChanges:structuredClone(input.reviewedSourceChanges)};
 assert(x.authorization==='ROOT_REATTEST_EXACT_UNUSABLE_LEGACY_BASELINE_ON_REVIEWED_SUCCESSOR_RELEASE'&&x.original.method==='POST');
 assert(x.previousRelease.manifest.sha256===PREVIOUS&&x.currentRelease.manifest.sha256!==PREVIOUS);
 const expected={expected_previous_baseline_sha256:x.baselineRef.sha256,expected_previous_release_sha256:x.previousRelease.manifest.sha256,expected_current_release_sha256:x.currentRelease.manifest.sha256,confirmed:true};
 assert.deepEqual(x.original.body,expected,'legacy-successor-exact-original-confirmation');
 const release=await recheckReviewedStartupEvidence(x.startup);assert('release_manifest_sha256'in release&&release.release_manifest_sha256===x.currentRelease.manifest.sha256,'legacy-successor-current-genuine-Startup');
 const previous=await readManifest(x.previousRelease),current=await readManifest(x.currentRelease);
 await verifyPayloads(x.previousRelease,previous);await verifyPayloads(x.currentRelease,current);
 const contractBytes=await Promise.all([x.previousRelease,x.currentRelease].map(r=>bytes(join(r.directory,'contract/source-release-manifest.json'),4194304)));
 const contracts={previous:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(contractBytes[0])),current:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(contractBytes[1])),previousSha256:sha(contractBytes[0]),currentSha256:sha(contractBytes[1])};
 const compatibility=compareLegacyReattestationManifests(previous,current,x.reviewedSourceChanges,contracts);
 const inspected=await inspectLegacyQuarantineForSuccessor({...x,authorization:'ROOT_INSPECT_EXACT_LEGACY_SUCCESSOR_WITHOUT_PUBLICATION',expectedPreviousRelease:x.previousRelease.manifest.sha256});
 assert(inspected.previous.release_sha256===PREVIOUS&&inspected.candidate.release_sha256===x.currentRelease.manifest.sha256);assert.deepEqual({...inspected.candidate,release_sha256:PREVIOUS},inspected.previous);
 assert(x.outputRefPath===resolve(x.outputRefPath)&&x.outputRefPath!==x.baselineRef.path);const parentPath=dirname(x.outputRefPath);assert(await realpath(parentPath)===parentPath);const p=await lstat(parentPath,{bigint:true});assert(p.isDirectory()&&!p.isSymbolicLink()&&p.uid===BigInt(process.getuid!())&&(p.mode&511n)===448n);
 for(const root of Object.keys(inspected.previous.root_identities))assert(x.outputRefPath!==root&&!x.outputRefPath.startsWith(root+'/'),'legacy-successor-artifact-outside-roots');
 // Inspector returns only after its owner transaction, schema lease, Root lock and connection close.
 x.signal.throwIfAborted();assert.deepEqual(x.original.body,expected);
 const packed=Buffer.from(JSON.stringify(inspected.candidate)+'\n');assert(packed.length>0&&packed.length<=33554432);
 const fd=await open(x.outputRefPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(packed);await fd.sync();}finally{await fd.close();}
 const parent=await open(parentPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
 const ref=Object.freeze({path:x.outputRefPath,sha256:sha(packed),bytes:packed.length});
 // Current ordinary validation remains exact and runs again; no serialized capability is returned.
 await openLegacyQuarantine({...x,baselineRef:ref});x.signal.throwIfAborted();
 return {schema:'legacy-quarantine-release-reattestation/v1' as const,baseline:ref,predecessor:x.baselineRef,previous_release_sha256:PREVIOUS,current_release_sha256:x.currentRelease.manifest.sha256,compatibility,legacy_membership_rows_policies_files_and_charges_preserved:true as const,usable:false as const,outcomes_resolved:false as const,requires_fresh_public_proof:true as const};
}
