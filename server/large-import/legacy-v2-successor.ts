/** Private, quiescent Root operator. It preserves legacy membership; it cannot publish an importer. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {recheckReviewedStartupEvidence} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import {inspectLegacyV2Successor,inspectLegacyV2Journal,openLegacyQuarantine,type LegacyRef} from './legacy-quarantine';

export const LEGACY_V1_MAIN_RELEASE='5b681adb34201a7a9ed3ef625b93f935daacabb99f8fcf35aeac2f1cf291468a';
const PREVIOUS_SOURCE='1bcfbaa09db15d2a023e047fb1964699842c4a0e9bfdbc2ad8b81c4cae952813',CURRENT_SOURCE='7d8b695a742657ed5679ad54d171f20f8c1ea551b91a0499d9c9ccb8935e39ff';
const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
type Json=null|boolean|number|string|Json[]|{[k:string]:Json};
type Side={present:false}|{present:true;value:Json};
type Change={path:string;before:Side;after:Side};
type Release={directory:string;manifest:LegacyRef};
export type LegacyV2ReviewedDiff={manifest_fields:Change[];emitted_sources:Change[];payload_files:Change[];source_contract_fields:Change[];source_contract_files:Change[]};
type Transition={schema:'legacy-main-v1-v2-reviewed-transition/v1';previous:Release;current:Release;reviewed_diff:LegacyV2ReviewedDiff};
type Inspection=Parameters<typeof inspectLegacyV2Successor>[0];
export type LegacyV2SuccessorInput=Omit<Inspection,'authorization'|'expectedPreviousRelease'|'expectedCurrentRelease'>&{authorization:'ROOT_PRESERVE_MAIN_V1_LEGACY_ON_REVIEWED_V2_204';transitionRef:LegacyRef;quiescenceRef:LegacyRef;outputRefPath:string};
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const keys=(x:any,wanted:string)=>assert(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===wanted);
function member(x:any){assert(x&&typeof x==='object'&&!Array.isArray(x)&&typeof x.path==='string'&&x.path.length>0&&x.path.length<=1024&&!x.path.startsWith('/')&&!x.path.includes('\\')&&x.path.split('/').every((p:string)=>p!==''&&p!=='.'&&p!=='..')&&/^[a-f0-9]{64}$/.test(x.sha256)&&Number.isSafeInteger(x.bytes)&&x.bytes>=0,'legacy-v2-safe-member');}
function mapped(items:any[],source=false){assert(Array.isArray(items)&&items.length>0&&items.length<=10000);const out=new Map<string,Json>();for(const x of items){member(x);if(source)keys(x,'bytes,path,sha256');assert(!out.has(x.path),'legacy-v2-duplicate-member');out.set(x.path,x);}return out;}
function changes(a:Map<string,Json>,b:Map<string,Json>):Change[]{return [...new Set([...a.keys(),...b.keys()])].sort().filter(k=>canonical(a.get(k))!==canonical(b.get(k))).map(path=>({path,before:a.has(path)?{present:true,value:a.get(path)!}:{present:false},after:b.has(path)?{present:true,value:b.get(path)!}:{present:false}}));}
function fields(x:any,omit:string[]){assert(x&&typeof x==='object'&&!Array.isArray(x));return new Map<string,Json>(Object.keys(x).filter(k=>!omit.includes(k)).sort().map(k=>[k,x[k]]));}

/** Full exact delta, not a wildcard exclusion. The pinned private profile is reviewed by Root before use. */
export function compareReviewedV2Transition(previous:any,current:any,contracts:{previous:any;current:any;previousSha256:string;currentSha256:string},reviewed:LegacyV2ReviewedDiff){
 assert(previous?.schema==='dynaminds-emitted-local-release/v1'&&current?.schema===previous.schema);
 assert(contracts.previous?.schema==='dynaminds-importer-source-release/v1'&&contracts.current?.schema===contracts.previous.schema);
 assert(contracts.previousSha256===previous.source_contract_manifest_sha256&&contracts.currentSha256===current.source_contract_manifest_sha256,'legacy-v2-contract-manifest-binding');
 const oldFiles=mapped(previous.files),newFiles=mapped(current.files),oldSource=mapped(previous.emitted_sources,true),newSource=mapped(current.emitted_sources,true);
 for(const [m,digest]of [[oldFiles,contracts.previousSha256],[newFiles,contracts.currentSha256]]as const){const c=m.get('contract/source-release-manifest.json')as any;assert(c&&c.sha256===digest,'legacy-v2-contract-payload-binding');}
 // Historical SQL resources are immutable. SQL204 keeps its reviewed transition semantics.
 const sql='resources/server/204_partial_commercial_sale_scope.sql';assert(!oldFiles.has(sql)&&newFiles.has(sql),'legacy-v2-exact-new-SQL204');
 const sql205='resources/server/205_header_metadata_projection.sql';
 if(newFiles.has(sql205)){const f=newFiles.get(sql205)as any;assert(!oldFiles.has(sql205)&&f.sha256==='922549d60acaa646ea8fe01ffe17e2e3f394b3c333138b730f840109f72b769d'&&f.bytes===77878,'legacy-v2-exact-audited-SQL205');}
 for(const[p,f]of oldFiles)if(p.endsWith('.sql'))assert.deepEqual(newFiles.get(p),f,'legacy-v2-historical-SQL-literal');
 for(const[p]of newFiles)if(p.endsWith('.sql'))assert(oldFiles.has(p)||p===sql||p===sql205,'legacy-v2-unreviewed-new-SQL');
 // Full structural fields include the original arrays too: no member-order drift is silently ignored.
 // The per-path sections additionally make every tuple addition/removal/change independently explicit.
 const actual:LegacyV2ReviewedDiff={manifest_fields:changes(fields(previous,[]),fields(current,[])),emitted_sources:changes(oldSource,newSource),payload_files:changes(oldFiles,newFiles),source_contract_fields:changes(fields(contracts.previous,[]),fields(contracts.current,[])),source_contract_files:changes(mapped(contracts.previous.files),mapped(contracts.current.files))};
 keys(reviewed,'emitted_sources,manifest_fields,payload_files,source_contract_fields,source_contract_files');
 assert.deepEqual(reviewed,actual,'legacy-v2-full-reviewed-delta-mismatch');
 assert(actual.emitted_sources.length>0&&actual.payload_files.length>0,'legacy-v2-not-a-release-repin');
 return {schema:'legacy-main-v1-v2-exact-compatibility/v1' as const,reviewed_diff_sha256:sha(canonical(actual)),changed_sources:actual.emitted_sources.map(c=>c.path),changed_payloads:actual.payload_files.map(c=>c.path),historical_SQL_resources_literal:true as const};
}
const stat=(s:any)=>['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
async function privateDirectory(path:string){assert(path===resolve(path)&&await realpath(path)===path);const s=await lstat(path,{bigint:true});assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid!())&&(s.mode&4095n)===448n);}
async function bytes(path:string,max:number,privateMode=false){
 assert(path===resolve(path)&&await realpath(path)===path);const before=await lstat(path,{bigint:true});assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid!())&&before.size>=0n&&before.size<=BigInt(max)&&(!privateMode||(before.mode&4095n)===384n));
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW),parts:Buffer[]=[],buffer=Buffer.alloc(65536);let n=0;
 try{assert.equal(stat(await fd.stat({bigint:true})),stat(before));for(;;){const r=await fd.read(buffer,0,buffer.length,n);if(!r.bytesRead)break;n+=r.bytesRead;assert(n<=max&&BigInt(n)<=before.size,'legacy-v2-file-growth');parts.push(Buffer.from(buffer.subarray(0,r.bytesRead)));}assert(BigInt(n)===before.size);assert.equal(stat(await fd.stat({bigint:true})),stat(before));assert.equal(stat(await lstat(path,{bigint:true})),stat(before));return Buffer.concat(parts);}finally{buffer.fill(0);for(const p of parts)p.fill(0);await fd.close();}
}
async function pinned(ref:LegacyRef,privateMode=false){keys(ref,'bytes,path,sha256');assert(Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=33554432&&/^[a-f0-9]{64}$/.test(ref.sha256));if(privateMode)await privateDirectory(dirname(ref.path));const b=await bytes(ref.path,33554432,privateMode);assert(b.length===ref.bytes&&sha(b)===ref.sha256,'legacy-v2-pin-mismatch');return b;}
function json(b:Uint8Array){return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(b));}
async function readRelease(r:Release){keys(r,'directory,manifest');assert(r.directory===resolve(r.directory)&&await realpath(r.directory)===r.directory&&r.manifest.path===join(r.directory,'release.json'));return json(await pinned(r.manifest));}
async function payloads(r:Release,m:any){let n=0;for(const f of m.files){member(f);n+=f.bytes;assert(n<=268435456,'legacy-v2-total-payload-bound');const b=await bytes(join(r.directory,f.path),134217728);assert(b.length===f.bytes&&sha(b)===f.sha256,'legacy-v2-payload-hash');}}
async function transition(ref:LegacyRef){const p=json(await pinned(ref,true))as Transition;keys(p,'current,previous,reviewed_diff,schema');assert(p.schema==='legacy-main-v1-v2-reviewed-transition/v1'&&p.previous.manifest.sha256===LEGACY_V1_MAIN_RELEASE&&p.current.manifest.sha256!==LEGACY_V1_MAIN_RELEASE);const previous=await readRelease(p.previous),current=await readRelease(p.current);
 assert(previous.source_contract_manifest_sha256===PREVIOUS_SOURCE&&current.source_contract_manifest_sha256===CURRENT_SOURCE,'legacy-v2-fixed-reviewed-Source59-transition');
 // Parse and hash the SAME bounded bytes, never a caller digest or a second mutable read.
 const oldContract=await bytes(join(p.previous.directory,'contract/source-release-manifest.json'),33554432),newContract=await bytes(join(p.current.directory,'contract/source-release-manifest.json'),33554432);
 const contracts={previous:json(oldContract),current:json(newContract),previousSha256:sha(oldContract),currentSha256:sha(newContract)};
 const compatibility=compareReviewedV2Transition(previous,current,contracts,p.reviewed_diff);await payloads(p.previous,previous);await payloads(p.current,current);return{profile:p,compatibility};}

export async function reattestLegacyV1ToV2(input:LegacyV2SuccessorInput){
 const x={...input,currentRoots:structuredClone(input.currentRoots),baselineRef:structuredClone(input.baselineRef),transitionRef:structuredClone(input.transitionRef),quiescenceRef:structuredClone(input.quiescenceRef),sourceJournalRoot:structuredClone(input.sourceJournalRoot)},original=input.original;
 assert(x.authorization==='ROOT_PRESERVE_MAIN_V1_LEGACY_ON_REVIEWED_V2_204'&&original.method==='POST'&&input.sessionName==='dyna_session');
 // This pins Root's actual lifecycle record. It does NOT prove quiescence or grant a capability.
 await pinned(x.quiescenceRef,true);const selected=await transition(x.transitionRef),p=selected.profile;
 const expected={expected_previous_baseline_sha256:x.baselineRef.sha256,expected_transition_sha256:x.transitionRef.sha256,expected_quiescence_ref_sha256:x.quiescenceRef.sha256,expected_previous_release_sha256:p.previous.manifest.sha256,expected_current_release_sha256:p.current.manifest.sha256,source_journal_root:x.sourceJournalRoot.path,confirmed:true};
 const check=()=>{x.signal.throwIfAborted();assert.deepEqual(original.body,expected,'legacy-v2-exact-authenticated-confirmation');};check();
 const release=await recheckReviewedStartupEvidence(x.startup);assert('release_manifest_sha256'in release&&release.release_manifest_sha256===p.current.manifest.sha256,'legacy-v2-genuine-current-Startup');
 assert(x.outputRefPath===resolve(x.outputRefPath)&&x.outputRefPath!==x.baselineRef.path&&x.outputRefPath!==x.transitionRef.path&&x.outputRefPath!==x.quiescenceRef.path);await privateDirectory(dirname(x.outputRefPath));
 const inspected=await inspectLegacyV2Successor({...x,authorization:'ROOT_INSPECT_MAIN_V1_BASELINE_ON_STRICT_V2_204',expectedPreviousRelease:LEGACY_V1_MAIN_RELEASE,expectedCurrentRelease:p.current.manifest.sha256});
 check();assert.deepEqual({...inspected.candidate,release_sha256:LEGACY_V1_MAIN_RELEASE},inspected.previous,'legacy-v2-only-release-changed');
 for(const root of [...Object.keys(inspected.previous.root_identities),x.sourceJournalRoot.path,p.previous.directory,p.current.directory])assert(x.outputRefPath!==root&&!x.outputRefPath.startsWith(root+'/'),'legacy-v2-output-outside-protected-roots');
 // Owner/schema/Root locks are now closed. Journal is detached evidence, not a claim of old-writer fencing.
 assert.deepEqual(await inspectLegacyV2Journal(x.sourceJournalRoot),inspected.journal,'legacy-v2-journal-after-owner-drift');
 assert.deepEqual(await transition(x.transitionRef),selected,'legacy-v2-reviewed-input-after-owner-drift');await pinned(x.quiescenceRef,true);check();
 const packed=Buffer.from(JSON.stringify(inspected.candidate)+'\n');assert(packed.length>0&&packed.length<=33554432);
 const fd=await open(x.outputRefPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(packed);await fd.sync();}finally{await fd.close();}
 const dir=await open(dirname(x.outputRefPath),constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}
 const ref={path:x.outputRefPath,sha256:sha(packed),bytes:packed.length};
 await openLegacyQuarantine({...x,baselineRef:ref});check();
 assert.deepEqual(await inspectLegacyV2Journal(x.sourceJournalRoot),inspected.journal,'legacy-v2-journal-after-reopen-drift');
 return{schema:'legacy-main-v1-v2-successor-receipt/v1' as const,baseline:ref,predecessor:x.baselineRef,transition:x.transitionRef,quiescence_ref:x.quiescenceRef,quiescence_lifecycle_verified_by_this_module:false as const,previous_release_sha256:LEGACY_V1_MAIN_RELEASE,current_release_sha256:p.current.manifest.sha256,compatibility:selected.compatibility,source_journal:inspected.journal,strict204_cold:inspected.cold,legacy_packet_except_release_literal:true as const,requires_quiescent_Root_operation:true as const,requires_fresh_public_proof:true as const,usable:false as const,outcomes_resolved:false as const,authority:false as const};
}
