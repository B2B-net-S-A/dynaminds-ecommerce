/** Root-only private acceptance orchestration. No app, database or readiness at import. */
import assert from 'node:assert/strict';
import {openSync,writeFileSync,fsyncSync,closeSync,constants,mkdirSync,realpathSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {installAuthenticatedBootstrap} from './private-acceptance-bootstrap';
import type {createOrdinaryInstalledProducer} from './ordinary-producer';
import {createInstalledAcceptanceChecker,inspectOwnedInstalledLosses,type InstalledCandidate,type InstalledCommand,type CandidateRegistration} from '../../shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/installed-checker';
import {reconcileInstalledLoss,writeInstalledClosedProof,type ReconciledInstalledLoss} from '../../shared/large-import-dependencies/pim-large-import-write-hook-registry-backend/closed-proof';

type Producer=Awaited<ReturnType<typeof createOrdinaryInstalledProducer>>;
type CloseInput=Parameters<typeof writeInstalledClosedProof>[0];
export type ClosedAcceptanceInput={producer:Producer;source:CloseInput['source'];census:CloseInput['census'];tenantId:string;userId:string;collectorDirectory:string;finalJournalDirectory:string;proofDirectory:string;onOriginalCommandError?:(error:unknown)=>void|Promise<void>};
const originalJob=(r:CandidateRegistration)=>{const p=r.original.params as {catalog_id:string;id?:string},b=r.original.body as {job_id?:string};return p.id??(r.original.method==='POST'&&!Object.hasOwn(r.original.query as object,'upload_key')?b?.job_id:undefined);};
function journal(dir:string){assert(dir===resolve(dir));mkdirSync(dir,{mode:0o700});const st=lstatSync(dir);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid!()&&(st.mode&511)===448&&realpathSync(dir)===dir);const syncDir=(d:string)=>{const fd=openSync(d,constants.O_RDONLY);let first:unknown;try{fsyncSync(fd);}catch(e){first=e;}try{closeSync(fd);}catch(e){first??=e;}if(first)throw first;};syncDir(dirname(dir));let n=0;return (kind:string,value:unknown)=>{const file=join(dir,String(++n).padStart(4,'0')+'-'+kind+'.private.json'),bytes=Buffer.from(JSON.stringify(value));assert(bytes.length<=65536);const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let first:unknown;try{writeFileSync(fd,bytes);fsyncSync(fd);}catch(e){first=e;}try{closeSync(fd);}catch(e){first??=e;}if(first)throw first;syncDir(dir);return{path:file,sha256:createHash('sha256').update(bytes).digest('hex')};};}
/** Every mutation result is withheld and immediately read through its exact original before the next revision.
 * These are controlled result losses, not evidence of lost transport ACKs. Public unavailable stays literal. */
export async function installPrivateClosedAcceptance(app:FastifyInstance,input0:ClosedAcceptanceInput){
 const producer=input0.producer,startup=producer.startup,source=structuredClone(input0.source),census={...input0.census},tenantId=z.uuid().parse(input0.tenantId),userId=z.uuid().parse(input0.userId),collectorDirectory=input0.collectorDirectory,proofDirectory=input0.proofDirectory,save=journal(input0.finalJournalDirectory);
 assert(typeof census.connectOwner==='function');const checker=await createInstalledAcceptanceChecker(startup,input0.onOriginalCommandError?{onOriginalCommandError:input0.onOriginalCommandError}:undefined),handles:InstalledCandidate[]=[],pairs:ReconciledInstalledLoss[]=[],registrations=new Map<InstalledCandidate,CandidateRegistration>(),jobs=new Map<string,FastifyRequest>();let failed=false,finishing=false,finished=false;
 const collector=await installAuthenticatedBootstrap(app,{candidate:producer.candidate,tenantId,userId,outputDirectory:collectorDirectory,checker:{
  async registerCandidate(registration){assert(!failed&&!finishing&&!finished,'closed-acceptance-fenced');const handle=await checker.registerCandidate(registration);handles.push(handle);registrations.set(handle,registration);const id=originalJob(registration);if(id){z.uuid().parse(id);jobs.set((registration.original.params as {catalog_id:string}).catalog_id+':'+id,registration.original);}return handle;},
  async command(handle,input){assert(!failed&&!finishing&&!finished&&registrations.has(handle),'closed-acceptance-fenced');try{
   if(input.method==='inspect'||input.method==='inspectCoreReview')return await checker.command(handle,input as InstalledCommand);
   const loss=await checker.withholdResult(handle,input as InstalledCommand),facts=inspectOwnedInstalledLosses(checker,[loss],startup)[0];
   const paired=await reconcileInstalledLoss({checker,startup,loss,census});pairs.push(paired.handle);
   if(!facts.original_completed){assert(facts.first_error&&typeof paired.readback==='object'&&paired.readback!==null&&(paired.readback as {classification?:string}).classification==='ATTRIBUTED_TERMINAL_QUARANTINE_ORIGINAL_DENIED','closed-original-failure-not-terminal');return{scope:'controlled_original_denial',original_error:facts.first_error,original_result_received:false,original_no_repeat:true,readback:paired.readback};}
   return paired.readback;
  }catch(first){failed=true;throw first;}}
 }});
 app.post('/api/local-acceptance/large-import/closed-proof',{bodyLimit:1024},async(req,reply)=>{
  reply.header('Cache-Control','no-store');z.strictObject({}).parse(req.body);z.strictObject({}).parse(req.query);
  assert(req.currentUser&&req.actor&&req.actor.role==='admin'&&req.currentUser.role===req.actor.role&&req.currentUser.id===userId&&req.currentUser.tenant_id===tenantId&&req.actor.userId===userId&&req.actor.tenantId===tenantId,'closed-final-normal-admin');assert(!req.apiScopes&&!req.actor.apiKeyId&&!req.currentUser.api_key_id,'closed-final-cookie-only');
  const state=collector.inspect();assert(!failed&&!finishing&&!finished&&!state.busy&&!state.blocked,'closed-final-original-unknown');assert(jobs.size>=2,'closed-final-independent-jobs');
  const intent=save('intent',{method:req.method,route:req.routeOptions.url,tenant_id:tenantId,user_id:userId,job_ids:[...jobs.keys()],handle_count:handles.length,paired_loss_count:pairs.length,public_available:false});finishing=true;
  try{for(const original of jobs.values())await producer.candidate.closeKnownAcceptance(original);
   const proof=await writeInstalledClosedProof({startup,checker,handles,losses:pairs,producer:producer.candidate,source,census,outputDirectory:proofDirectory});
   const value={scope:'private_closed_acceptance',result:proof.result,inventory:proof.inventory,artifacts:proof.artifacts,public_available:false,transport_loss_proved:false};const ack=save('ack',{intent,...value});finished=true;return{...value,ack};
  }catch(first){failed=true;try{save('unknown',{intent,original_no_repeat:true,first_error:{name:(first as Error)?.name??'UnknownError',code:typeof(first as {code?:unknown})?.code==='string'?(first as {code:string}).code:null}});}catch{/* Preserve original failure. */}throw first;}finally{finishing=false;}
 });
 return Object.freeze({inspect:()=>({failed,finishing,finished,handles:handles.length,paired_losses:pairs.length,independent_jobs:jobs.size,public_available:false as const,collector:collector.inspect()})});
}
