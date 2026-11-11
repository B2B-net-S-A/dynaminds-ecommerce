/** Explicit local CLI. Import performs no IO/app/pool/listen. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {constants} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {validateOrdinaryConnectorAccess,type OrdinaryConnectorAccessConfiguration} from './ordinary-connector-policy';
import {createOrdinaryLocalApplication,type OrdinaryLocalConfiguration} from './ordinary-local-runtime';
import type {LocalWooFixtureConfiguration} from './local-woo-http-fixture';
import {MIRAKL_CONTROL_DATABASE} from './mirakl-read-postgres';
import {readRateLimitSetting} from './rate-limit-config';
import {isDbConnectionLoss,recordDbConnectionError} from './db-connection-errors';
async function selected<T=OrdinaryLocalConfiguration>(file:string,digest:string):Promise<T>{
 assert(path.isAbsolute(file)&&path.resolve(file)===file&&/^[a-f0-9]{64}$/.test(digest));assert.equal(await realpath(file),file);
 const before=await lstat(file,{bigint:true});assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid!())&&(before.mode&0o777n)===0o600n&&before.size<=16384n);
 const identity=(s:typeof before)=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let failed=false;
 try{assert.equal(identity(await fd.stat({bigint:true})),identity(before));const bytes=await fd.readFile();assert.equal(BigInt(bytes.length),before.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);assert.equal(identity(await fd.stat({bigint:true})),identity(before));assert.equal(identity(await lstat(file,{bigint:true})),identity(before));assert.equal(await realpath(file),file);return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)) as T;}
 catch(first){failed=true;throw first;}finally{try{await fd.close();}catch(close){if(!failed)throw close;}}
}
export async function readOrdinaryConnectorAccessSelection(file:string,digest:string){return validateOrdinaryConnectorAccess(await selected<OrdinaryConnectorAccessConfiguration>(file,digest));}
export function parseOrdinaryLocalCliArgs(args:readonly string[]){
 assert(args.length>=3&&(args.length<=18||args.length===19&&args.includes('--local-woo-stock')),'ordinary-cli-needs-private-selection-path-sha-port-and-optional-local-flags');
 const [file,digest,portText,...rest]=args;const flags:string[]=[];let connectorAccessSelection:{file:string;digest:string}|undefined,localWooSelection:{file:string;digest:string}|undefined;
 for(let i=0;i<rest.length;i++){
  const flag=rest[i]!;
  if(flag==='--connector-access'||flag==='--local-woo-stores'){
   assert(flag==='--connector-access'?connectorAccessSelection===undefined:localWooSelection===undefined,'ordinary-cli-duplicate-private-selection');
   const accessFile=rest[++i],accessDigest=rest[++i];assert(typeof accessFile==='string'&&path.isAbsolute(accessFile)&&path.resolve(accessFile)===accessFile&&typeof accessDigest==='string'&&/^[a-f0-9]{64}$/.test(accessDigest),'ordinary-cli-private-path-sha-required');
   if(flag==='--connector-access')connectorAccessSelection={file:accessFile,digest:accessDigest};else localWooSelection={file:accessFile,digest:accessDigest};
  }else flags.push(flag);
 }
 // Both private selections may coexist; the constructor keeps their origins disjoint.
 assert(/^[1-9][0-9]{3,4}$/.test(portText!), 'ordinary-cli-strict-decimal-port-required');
 const port=Number(portText);assert(port>=1024&&port<=65535,'ordinary-cli-unprivileged-loopback-port-required');
 assert(flags.every(flag=>flag==='--connector-jobs-sandbox'||flag==='--scoped-automation'||flag==='--local-woo-reads'||flag==='--local-woo-stock'||flag==='--verified-stock-writers'||flag==='--nbp-eur'||flag==='--amazon-mcf-sandbox-eu'||flag.startsWith('--mirakl-read-state=')&&MIRAKL_CONTROL_DATABASE.test(flag.slice('--mirakl-read-state='.length))||/^--installed-importer-selection=[a-f0-9]{64}:\/.+$/.test(flag)),'ordinary-cli-unknown-option');
 assert(new Set(flags).size===flags.length,'ordinary-cli-duplicate-option');
 const scopedAutomationEnabled=flags.includes('--scoped-automation'),verifiedStockWriters=flags.includes('--verified-stock-writers'),nbpEur=flags.includes('--nbp-eur'),amazonMcfSandboxEu=flags.includes('--amazon-mcf-sandbox-eu');
 const installedFlags=flags.filter(f=>f.startsWith('--installed-importer-selection='));assert(installedFlags.length<=1,'ordinary-cli-one-importer-selection');const selected=installedFlags[0]?.slice('--installed-importer-selection='.length);const installedLargeImportSelection=selected?{sha256:selected.slice(0,64),path:selected.slice(65)}:undefined;if(installedLargeImportSelection)assert(path.resolve(installedLargeImportSelection.path)===installedLargeImportSelection.path,'ordinary-cli-canonical-importer-selection');
 assert(!flags.includes('--connector-jobs-sandbox')||connectorAccessSelection!==undefined,'ordinary-cli-manual-jobs-require-connector-access');
 const miraklFlags=flags.filter(f=>f.startsWith('--mirakl-read-state='));assert(miraklFlags.length<=1,'ordinary-cli-one-mirakl-read-state');assert(!miraklFlags.length||connectorAccessSelection!==undefined,'ordinary-cli-mirakl-read-state-requires-connector-access');
 assert(!flags.includes('--local-woo-stock')||localWooSelection!==undefined,'ordinary-cli-local-Woo-stock-requires-selection');
 assert(!flags.includes('--local-woo-reads')||localWooSelection!==undefined,'ordinary-cli-local-Woo-reads-require-selection');
 const options={...(flags.includes('--local-woo-stock')?{localWooStockEnabled:true}:{}),...(flags.includes('--local-woo-reads')?{localWooReadEnabled:true}:{}),...(miraklFlags.length?{miraklReadState:{database:miraklFlags[0]!.slice('--mirakl-read-state='.length)}}:{}),...(flags.includes('--connector-jobs-sandbox')?{connectorJobExecution:{mode:'sandbox_manual_once' as const}}:{}),...(installedLargeImportSelection?{installedLargeImportSelection}:{}),trustedLocalUiOrigin:'http://127.0.0.1:'+port,scopedAutomationEnabled,
  ...(verifiedStockWriters?{stockWriterActivation:{mode:'verified_local_physical_writers' as const}}:{}),
  ...(amazonMcfSandboxEu?{amazonMcfReads:{mode:'sandbox' as const,region:'eu' as const}}:{}),
  ...(nbpEur?{providerReads:{routes:[{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/eur/',methods:['GET'] as const,queryKeys:['format']},{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/eur/:date/',methods:['GET'] as const,queryKeys:['format']},{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/eur/:start/:end/',methods:['GET'] as const,queryKeys:['format']}]},nbpRates:{currencies:['EUR'],maxAgeDays:7}}:{})};
 return {file,digest,port,scopedAutomationEnabled,verifiedStockWriters,nbpEur,amazonMcfSandboxEu,options,...(connectorAccessSelection?{connectorAccessSelection}:{}),...(localWooSelection?{localWooSelection}:{})};
}
export async function main(args:string[]){
 const {file,digest,port,scopedAutomationEnabled,options,connectorAccessSelection,localWooSelection}=parseOrdinaryLocalCliArgs(args);
 // Invalid DYNA_RATE_LIMIT_PER_MIN refuses before any selection, migrate() or listen; buildApp reads the same setting.
 readRateLimitSetting();
 let runtime:Awaited<ReturnType<typeof createOrdinaryLocalApplication>>|undefined,stopping:Promise<void>|undefined,stopRequested=false,failed=false,first:unknown;
 const remember=(error:unknown)=>{if(!failed){failed=true;first=error;}};
 const removeSignals=()=>{process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);process.stdout.removeListener('error',onOutputError);process.stderr.removeListener('error',onOutputError);process.removeListener('unhandledRejection',onLateRejection);process.removeListener('uncaughtException',onLateException);};
 // Last resort once listening: one request's late failure (load run full-20261029-02 died on an unhandled
 // ERR_HTTP_HEADERS_SENT) is logged by name and code only and the server keeps serving. Before listening
 // the Node default stays, so a genuine startup failure still ends the process.
 const onLateRejection=(reason:unknown)=>{const code=(reason as {code?:unknown}|null)?.code;
  try{process.stderr.write(JSON.stringify({status:'ORDINARY_LOCAL_UNHANDLED_REJECTION',name:reason instanceof Error?reason.name:typeof reason,...(typeof code==='string'&&/^[A-Z][A-Z0-9_]{2,63}$/.test(code)?{code}:{})})+'\n');}catch{}};
 // Same boundary for an EventEmitter 'error' nobody listened to (thrown synchronously, so an uncaughtException,
 // not a rejection): dry run -68 lost both release processes to a pg Client 'error' while the database restarted.
 // Every pg Pool/Client has its own listener (db-connection-errors.ts); this catches one that was missed. A lost
 // database connection is logged by code and counted (/api/health db_connection_errors) and the server keeps
 // serving; any other uncaught exception still ends the process as before (rethrown: Node prints it, exit 7).
 const onLateException=(error:unknown)=>{if(isDbConnectionLoss(error)){recordDbConnectionError(error,'uncaught');return;}process.removeListener('uncaughtException',onLateException);throw error;};
 const stop=()=>{stopRequested=true;if(!runtime)return Promise.resolve();return stopping??=(async()=>{try{await runtime.close();}finally{removeSignals();}})();};
 const onSignal=()=>{void stop().catch(()=>{process.exitCode=1;});};
 const onOutputError=(error:unknown)=>{remember(error);process.exitCode=1;void stop().catch(remember);};
 process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);process.stdout.on('error',onOutputError);process.stderr.on('error',onOutputError);
 try{
  const connectorAccess=connectorAccessSelection?await readOrdinaryConnectorAccessSelection(connectorAccessSelection.file,connectorAccessSelection.digest):undefined;
  const localWooFixtures=localWooSelection?await selected<LocalWooFixtureConfiguration[]>(localWooSelection.file,localWooSelection.digest):undefined;
  const configuration=await selected(file,digest);
  if(stopRequested){removeSignals();if(failed)throw first;return;}
  runtime=await createOrdinaryLocalApplication(configuration,{...options,...(connectorAccess===undefined?{}:{connectorAccess}),...(localWooFixtures===undefined?{}:{localWooFixtures})});
  if(stopRequested){await stop();if(failed)throw first;return;}
  await runtime.app.listen({host:'127.0.0.1',port});
  if(stopRequested){await stop();if(failed)throw first;return;}
  process.on('unhandledRejection',onLateRejection);process.on('uncaughtException',onLateException);
  process.stdout.write(JSON.stringify({status:'ORDINARY_LOCAL_APP_LISTENING',port,scoped_automation_enabled:scopedAutomationEnabled,importer_available:runtime.importer.available})+'\n');
 }catch(error){remember(error);try{await stop();}catch{}if(!runtime)removeSignals();throw first;}
}
/** Start failure line: only the error name, except the refusals of migrate() (MIG-3 backup, MIG-1 failed migration
 * and fence timeout, MIG-6 newer ledger, MIG-2 checksum), of the 262 TEMPORARY check after migrate(), of a release without the XSD check and of an invalid DYNA_RATE_LIMIT_PER_MIN, whose Polish message (cause included) and code are what
 * the operator must act on during an upgrade or a rollback; database URL credentials are masked. */
const OPERATOR_CODES=new Set(['MIGRATION_BACKUP_FAILED','MIGRATION_FAILED','MIGRATION_LOCK_TIMEOUT','MIGRATION_LEDGER_NEWER_THAN_RELEASE','MIGRATION_CHECKSUM_MISMATCH','RATE_LIMIT_CONFIG_INVALID','DATABASE_TEMP_PRIVILEGE','MF_XSD_RELEASE_INCOMPLETE']);
export function ordinaryLocalStartFailure(e:unknown):Record<string,string>{
 const line={status:'ORDINARY_LOCAL_START_FAILED',name:e instanceof Error?e.name:typeof e},code=(e as {code?:unknown}|undefined)?.code;
 if(!(e instanceof Error)||typeof code!=='string'||!OPERATOR_CODES.has(code))return line;
 return {...line,code,message:e.message.replace(/(postgres(?:ql)?:\/\/)[^@\s/]*@/g,'$1***@').slice(0,4000)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const outputFailed=()=>{process.exitCode=1;};process.stdout.on('error',outputFailed);process.stderr.on('error',outputFailed);
 void main(process.argv.slice(2)).catch(e=>{process.stderr.write(JSON.stringify(ordinaryLocalStartFailure(e))+'\n');process.exitCode=1;});
}
