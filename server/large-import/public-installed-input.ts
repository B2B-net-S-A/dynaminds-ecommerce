import {openLegacyQuarantine,type LegacyRef}from'./legacy-quarantine';
import {createSourceOriginalJournal}from'./source-original-journal';
import {createOwnedAllocationCustody}from'./owned-allocation-custody';
/** Source-owned ordinary CLI intake. Import performs no I/O, DB or application start. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {watchDbClient} from '../db-connection-errors';
import type {ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
// closed-proof is imported only AFTER the Root-selected local configuration is bound below.
import type {SourceBinding,Ref} from '../../shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/registry';
import type {OrdinaryLocalConfiguration,createOrdinaryLocalApplication} from '../ordinary-local-runtime';
type Installed=NonNullable<NonNullable<Parameters<typeof createOrdinaryLocalApplication>[1]>['installedLargeImport']>;
export type PublicInstalledSelection={schema:'ordinary-public-installed-selection/v1'|'ordinary-public-installed-selection/v2'|'ordinary-public-installed-selection/v3';legacy_quarantine?:{baseline:LegacyRef};source_originals?:{root:string;initial:Ref};manifest_sha256:string;source:SourceBinding;evidence:Ref;inventory:Ref;root:string;custody:Installed['custody'];ceilings:Installed['ceilings']};
const sha=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');
/** Exact finite profiles only. Existing custody/reservations retain their original ceilings. */
export function assertReviewedPublicCeilings(value:unknown){
 assert(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,'public-reviewed-finite-allocation-profile');
 for(const key of ['upload','job','review']){const part:unknown=(value as Record<string,unknown>)[key];assert(part&&typeof part==='object'&&Object.getPrototypeOf(part)===Object.prototype,'public-reviewed-finite-allocation-profile');}
 const original={upload:{metadata:524288,objects:128},job:{raw:0,metadata:16777216,objects:256},review:{raw:0,metadata:8388608,objects:384}};
 const publicTwoBatch={...original,job:{...original.job,objects:1024}};
 assert(isDeepStrictEqual(value,original)||isDeepStrictEqual(value,publicTwoBatch),'public-reviewed-finite-allocation-profile');
}

async function read(ref:Ref,privateMode:boolean,max=32*1024*1024){
 assert(ref&&ref.path===path.resolve(ref.path)&&/^[a-f0-9]{64}$/.test(ref.sha256));assert.equal(await realpath(ref.path),ref.path);
 const before=await lstat(ref.path,{bigint:true});assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid!())&&before.size<=BigInt(max));if(privateMode)assert((before.mode&511n)===384n);
 const id=(s:typeof before)=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
 const fd=await open(ref.path,constants.O_RDONLY|constants.O_NOFOLLOW);let first:unknown;
 try{assert.equal(id(await fd.stat({bigint:true})),id(before));const bytes=await fd.readFile();assert.equal(sha(bytes),ref.sha256);assert.equal(id(await fd.stat({bigint:true})),id(before));assert.equal(id(await lstat(ref.path,{bigint:true})),id(before));assert.equal(await realpath(ref.path),ref.path);return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}catch(e){first=e;throw e;}finally{try{await fd.close();}catch(e){if(!first)throw e;}}
}
/** Reads only metadata selection; existing registry still validates all18/nine witnesses and fresh16area inventory. */
export async function createPublicInstalledInput(configuration:OrdinaryLocalConfiguration,selectionRef:Ref,startup:ReviewedStartup,cleanupFailure:(error:unknown)=>void):Promise<Installed>{
 const cfg=structuredClone(configuration),selected=structuredClone(selectionRef),s:PublicInstalledSelection=await read(selected,true,65536);
 assert(['ordinary-public-installed-selection/v1','ordinary-public-installed-selection/v2','ordinary-public-installed-selection/v3'].includes(s.schema));assert.deepEqual(Object.keys(s).sort(),['ceilings','custody','evidence','inventory',...(s.schema==='ordinary-public-installed-selection/v3'?['legacy_quarantine']:[]),'manifest_sha256','root','schema','source',...(s.schema!=='ordinary-public-installed-selection/v1'?['source_originals']:[])]);assertReviewedPublicCeilings(s.ceilings);assert.equal(s.manifest_sha256,cfg.manifestSha);assert.equal(typeof cleanupFailure,'function');
 for(const root of [s.root,s.custody.root]){assert(root===path.resolve(root)&&await realpath(root)===root);const st=await lstat(root);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid!()&&(st.mode&511)===448);}
 assert(s.root!==s.custody.root&&!s.root.startsWith(s.custody.root+'/')&&!s.custody.root.startsWith(s.root+'/'));
 // Same reviewed bounds as the accepted ordinary fixture; never increase them via the selection.
 assert.deepEqual(Object.keys(s.custody).sort(),['lockWaitMs','maxEntries','maxRecordBytes','maxTotalBytes','root']);assert.equal(s.custody.maxEntries,64);assert.equal(s.custody.maxRecordBytes,32768);assert.equal(s.custody.maxTotalBytes,2097152);assert.equal(s.custody.lockWaitMs,5000);
 const report=await read(s.evidence,true),result=await read(report.result,true),inventory=await read(s.inventory,true);
 assert.equal(report.status,'SAVED_WRITE_HOOK_WIRING_VERIFIED');assert.deepEqual(report.inventory,s.inventory);assert.deepEqual(report.checker_source,s.source);assert.deepEqual(result.checker_source,s.source);assert.equal(result.release_manifest_sha256,cfg.manifestSha);assert.deepEqual(result.inventory,s.inventory);
 const packet=await read(s.source.manifest,false),peer=await read(s.source.source_peer,false);assert.equal(peer.status,'SOURCE_ACK_NOT_RUN');assert.equal(peer.pins_sha256,s.source.manifest.sha256);assert.deepEqual(peer.blockers,[]);assert.deepEqual(packet.files,s.source.sources);assert.equal(packet.package.sha256,cfg.manifestSha);
 assert(process.env.DATABASE_URL===cfg.databaseUrl&&process.env.DYNA_LOCAL_CONFIG_PATH===cfg.localConfigurationPath&&process.env.APP_REVISION===cfg.revision,'public-same-configured-factory');
 const {createInstalledInventoryContinuation}=await import('../../shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/closed-proof');
 const url=new URL(cfg.databaseUrl);assert(url.protocol==='postgres:'&&url.username==='postgres'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.search&&!url.hash);
 const deadline=async<T>(work:Promise<T>):Promise<T>=>{let t:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<T>((_,reject)=>{t=setTimeout(()=>reject(Error('public-installed-client-end-unconfirmed')),5000);})]);}finally{clearTimeout(t);}};
 const connectOwner=async()=>{const c=watchDbClient(new pg.Client({connectionString:cfg.databaseUrl,connectionTimeoutMillis:5000,statement_timeout:8000,query_timeout:9000,lock_timeout:1000}),'large-import-installed-input');try{const originalEnd=c.end.bind(c);c.end=async()=>{try{await deadline(originalEnd());}catch(e){(c as any).connection?.stream?.destroy();throw e;}};await c.connect();return c;}catch(first){try{await c.end();}catch(e){cleanupFailure(e);}throw first;}};
 let journal:ReturnType<typeof createSourceOriginalJournal>|undefined,partialContinuation:Parameters<typeof createInstalledInventoryContinuation>[0]['census']['partialContinuation'];
 if(s.schema!=='ordinary-public-installed-selection/v1'){const selected=s.source_originals!;assert(selected&&Object.keys(selected).sort().join(',')==='initial,root');for(const protectedRoot of [s.root,s.custody.root])assert(selected.root!==protectedRoot&&!selected.root.startsWith(protectedRoot+'/')&&!protectedRoot.startsWith(selected.root+'/'),'public-source-journal-separate-roots');const seed=await read(selected.initial,true);assert(seed.schema==='large-import-source-originals/v1'&&Object.keys(seed).sort().join(',')==='originals,schema'&&Array.isArray(seed.originals));journal=createSourceOriginalJournal({root:selected.root,initial:seed.originals});const custody=await createOwnedAllocationCustody({...s.custody,authorize:async()=>{throw Error('public-checkpoint-custody-read-only');},cleanupFailure});partialContinuation={custody,sourceLineage:()=>journal!.snapshot()};}
 if(s.schema==='ordinary-public-installed-selection/v3')assert(s.legacy_quarantine&&Object.keys(s.legacy_quarantine).sort().join(',')==='baseline');
 const legacyQuarantine=s.schema==='ordinary-public-installed-selection/v3'?await openLegacyQuarantine({startup,connectOwner,database:url.pathname.slice(1),currentRoots:{raw:s.root,controlPlane:s.custody.root},baselineRef:s.legacy_quarantine!.baseline,signal:new AbortController().signal,cleanupFailure}):undefined;
 const reinspect=createInstalledInventoryContinuation({startup,census:{connectOwner,rawRoot:s.root,controlPlaneRoot:s.custody.root,expectedOwner:cfg.expectedOwner,...(partialContinuation?{partialContinuation}:{}),...(legacyQuarantine?{legacyQuarantine}:{})},inventory:s.inventory,certificateCensus:result.closure});
 return {...(journal?{coreCheckpoint:'known-partial203' as const,releasedHistoryAudit:original=>{journal!.capture(original);return undefined;}}:{}),root:s.root,custody:structuredClone(s.custody),ceilings:structuredClone(s.ceilings),cleanupFailure,installed:{...(s.legacy_quarantine?{legacyQuarantine:structuredClone(s.legacy_quarantine)}:{}),registryInput:{source:structuredClone(s.source),evidence:structuredClone(s.evidence)},inventoryWithControlPlane:async cut=>{
  assert(cut.complete&&cut.quiescent&&!cut.pending);const files=[...cut.records.map(r=>({path:sha(JSON.stringify(r.key))+'.json',sha256:r.sha256,byte_count:r.byte_count,tenant:null})),...cut.retirements.map(r=>({path:sha(JSON.stringify(r.key))+'.retired.json',sha256:r.sha256,byte_count:r.byte_count,tenant:null}))].sort((a,b)=>a.path.localeCompare(b.path));
  // Two complete current native/FS/control cuts admit closed growth; Ref remains immutable certificate baseline.
  return await reinspect(sha(JSON.stringify(files)));
 }}};
}
