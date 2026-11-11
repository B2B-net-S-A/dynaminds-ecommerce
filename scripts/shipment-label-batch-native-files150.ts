/** QA150 one-shot READBACK ONLY. Never claims, acknowledges, prints or changes custody. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { printUuid } from '../server/print-job-values';
import { PRINT_BRIDGE_API_ORIGIN, printBridgeConfig, printBridgeFileName, verifyPrintBridgeBytes } from '../server/print-bridge-values';

const root='<workspace>/app';
const reportPath='<workspace>/worktrees/stock-file-import/docs/shipment-label-batch-native150-files.json';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
// Only fixed diagnostic names and bounded row indexes may reach the terminal.
let phase='PREFLIGHT_ARGUMENTS';
const bridgePrinter=(p:any)=>({id:p.id,version:String(p.version),name:p.name,station_id:p.station_id,format:p.format,output_mode:p.output_mode,cups_queue:p.cups_queue,enabled:p.enabled});
async function privateBytes(path:string,maximum:number) {
  const prior=await lstat(path);
  assert(prior.isFile()&&!prior.isSymbolicLink()&&prior.nlink===1);
  assert.equal(prior.uid,process.getuid!());assert.equal(prior.mode&0o777,0o600);
  assert(prior.size>0&&prior.size<=maximum);
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const current=await handle.stat();assert.equal(current.ino,prior.ino);assert.equal(current.dev,prior.dev);
    const bytes=await handle.readFile();assert.equal(bytes.length,prior.size);
    const end=await handle.stat();assert.equal(end.size,current.size);assert.equal(end.mtimeMs,current.mtimeMs);assert.equal(end.ctimeMs,current.ctimeMs);
    return bytes;
  } finally {await handle.close();}
}
async function directory(path:string) {
  const s=await lstat(path);assert(s.isDirectory()&&!s.isSymbolicLink());
  assert.equal(s.uid,process.getuid!());assert.equal(s.mode&0o777,0o700);assert.equal(await realpath(path),path);
}
async function main() {
  assert.equal(process.argv.length,2);assert.equal(process.cwd(),root);
  assert.notEqual(process.env.DYNA_TEST,'true');
  const revision=process.env.QA_EXPECTED_REVISION??'';assert.match(revision,/^[a-f0-9]{40}$/);
  const executionId=printUuid.parse(process.env.QA_BATCH_EXECUTION_ID);
  const configPath=process.env.DYNA_PRINT_BRIDGE_CONFIG??'';
  assert(configPath&&resolve(configPath)===configPath);
  phase='READ_PRIVATE_CONFIG';
  const configBytes=await privateBytes(configPath,16384);
  const config=printBridgeConfig.parse(JSON.parse(configBytes.toString('utf8')));
  const statePath=join(root,'data/shipment-label-batch-stage150.json');
  phase='READ_PRIVATE_SETUP';
  const stateBytes=await privateBytes(statePath,8*1024*1024);
  const s=JSON.parse(stateBytes.toString('utf8'));
  phase='SETUP_CONFIG_BINDINGS';
  assert.equal(s.stage,150);assert.equal(s.complete,true);assert.equal(s.pending,null);
  assert.equal(s.fixture_seeded_source,true);assert.equal(s.provider_verified,false);
  assert.equal(s.orders.length,2);assert.equal(s.shipments.length,3);assert.equal(s.controlled_pdfs.length,3);
  assert.equal(config.tenant_id,s.tenant_id);assert.equal(config.printer_id,s.printer.id);
  assert.equal(s.printer.output_mode,'file');assert.equal(s.printer.format,'pdf');assert.equal(s.printer.cups_queue,null);
  const headers:Record<string,string>={'X-Workspace-ID':config.tenant_id,'Cache-Control':'no-store'};
  if(config.api_token)headers.Authorization='Bearer '+config.api_token;else headers.Cookie=config.cookie!;
  async function get(path:string,authenticated=true) {
    assert(/^\/(?:health|print-jobs\/(?:label-batches\/(?:executions|previews)\/[a-f0-9-]+|jobs(?:\/[a-f0-9-]+|\?printer_id=[a-f0-9-]+&limit=50)))$/.test(path));
    const response=await fetch(PRINT_BRIDGE_API_ORIGIN+(authenticated&&config.api_token?'/api/v1':'/api')+path,{method:'GET',headers:authenticated?headers:undefined,redirect:'error',signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);assert(response.body);
    const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try {for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;assert(size<=1024*1024);chunks.push(x.value);}}
    finally{await reader.cancel().catch(()=>{});}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }
  phase='GET_HEALTH';const health=await get('/health',false);phase='HEALTH_BINDINGS';
  assert.equal(health.revision,revision);assert.equal(health.schema_revision,'133_order_shipments');
  assert.equal(health.mode,'local');assert.equal(health.restore_preview,false);assert.equal(health.background_workers_enabled,false);
  assert.equal(health.shipment_label_batches_available,true);
  phase='GET_EXECUTION';const reply=await get('/print-jobs/label-batches/executions/'+executionId);phase='EXECUTION_BINDINGS';
  assert.equal(reply.available,true);assert.equal(reply.read_only,false);assert.equal(reply.can_read,true);
  const e=reply.execution;assert.equal(e.id,executionId);assert.equal(e.kind,'execution');
  assert.equal(e.rows.length,3);assert.equal(e.progress.length,3);assert.equal(e.summary.orders,2);
  assert.equal(e.summary.shipments,3);assert.equal(e.summary.source_pages,4);assert.equal(e.summary.combined_pages,4);
  // Fetch the printer's complete page to disallow an unrelated fourth output.
  phase='GET_PRINTER_JOBS';const page=await get('/print-jobs/jobs?printer_id='+config.printer_id+'&limit=50');phase='PRINTER_JOB_SET';
  assert.equal(page.next_cursor,null);assert.equal(page.jobs.length,3);
  assert.deepEqual(page.jobs.map((j:any)=>j.id).sort(),e.rows.map((r:any)=>r.job_id).sort());
  const base=join(root,'data/print-bridge',config.tenant_id,config.printer_id);
  phase='BRIDGE_DIRECTORIES';
  for(const p of [join(root,'data/print-bridge'),join(root,'data/print-bridge',config.tenant_id),base])await directory(p);
  phase='BRIDGE_FILE_SET';const names=await readdir(base);assert.equal(names.length,6);
  const journalNames=names.filter(n=>n==='current.json'||/^completed-[a-f0-9-]{36}\.json$/.test(n));
  assert.equal(journalNames.length,3);assert(journalNames.includes('current.json'));
  const journals=new Map<string,{value:any;name:string;bytes:Buffer}>();
  phase='BRIDGE_COMPLETE_JOURNALS';
  for(const name of journalNames) {
    const bytes=await privateBytes(join(base,name),4*1024*1024);const value=JSON.parse(bytes.toString('utf8'));
    assert.equal(value.journal_version,1);assert.equal(value.state,'complete');assert.deepEqual(printBridgeConfig.parse(value.config),config);
    assert(!journals.has(value.job_id));journals.set(value.job_id,{value,name,bytes});
    if(name!=='current.json')assert.equal(name,'completed-'+printUuid.parse(value.claim.client_key)+'.json');
  }
  const files=[];const seenShipments=new Set<string>();
  for(const [index,r] of e.rows.entries()) {
    phase=`ROW_${index}_SOURCE_BINDINGS`;
    assert.equal(r.index,index);assert(!seenShipments.has(r.shipment_id));seenShipments.add(r.shipment_id);
    const original=s.controlled_pdfs.find((p:any)=>p.shipment_id===r.shipment_id);assert(original);
    const source=s.shipments.find((p:any)=>p.id===r.shipment_id);assert(source);assert.equal(r.order_id,source.order_id);assert.equal(r.cache_asset_id,source.asset_id);
    const expected=Buffer.from(original.content_base64,'base64');
    verifyPrintBridgeBytes(expected,'pdf',original.content_sha256,original.content_bytes);
    assert.equal(r.content_sha256,original.content_sha256);assert.equal(r.content_bytes,original.content_bytes);assert.equal(r.pages,original.pages);
    phase=`ROW_${index}_GET_JOB`;const detail=await get('/print-jobs/jobs/'+printUuid.parse(r.job_id));const j=detail.job;
    phase=`ROW_${index}_JOB_HEAD`;
    assert.equal(j.id,r.job_id);assert.equal(j.order_id,r.order_id);assert.equal(j.printer_id,config.printer_id);
    assert.equal(j.station_id,s.station.id);assert.equal(j.source_kind,'shipment_label');assert.equal(j.format,'pdf');
    assert.equal(j.state,'file_saved');assert.equal(String(j.version),'3');assert.equal(j.copies,e.summary.copies);
    assert.equal(j.content_sha256,original.content_sha256);assert.equal(j.content_bytes,expected.length);
    phase=`ROW_${index}_PRINTER_SNAPSHOT`;assert.deepEqual(j.printer_snapshot,s.printer);
    phase=`ROW_${index}_STATION_SNAPSHOT`;
    assert.deepEqual(j.station_snapshot,{id:s.station.id,code:s.station.code,label:s.station.label,enabled:s.station.enabled,version:String(s.station.version)});
    phase=`ROW_${index}_EVENTS`;assert.deepEqual(detail.events.map((event:any)=>event.operation),['job_create','claim','ack']);
    assert.equal(detail.events[0].id,r.job_create_event_id);
    phase=`ROW_${index}_PROGRESS`;const progress=e.progress.find((p:any)=>p.job_id===j.id);assert.equal(progress.index,index);assert.equal(progress.state,'file_saved');assert.equal(progress.version,'3');
    const name=printBridgeFileName(j.id,j.content_sha256,'pdf');assert(names.includes(name));
    phase=`ROW_${index}_FILE_BYTES`;const saved=await privateBytes(join(base,name),2*1024*1024);assert.deepEqual(saved,expected);
    phase=`ROW_${index}_JOURNAL_CONTENT`;
    const custody=journals.get(j.id);assert(custody);
    const journal=custody.value;assert.equal(journal.content.job_id,j.id);assert.equal(journal.content.content_base64,original.content_base64);
    assert.equal(journal.content.content_sha256,j.content_sha256);assert.equal(journal.content.content_bytes,j.content_bytes);
    assert.equal(journal.content.copies,j.copies);
    // print-bridge contentShape deliberately strips printer timestamps. Its
    // retained configuration must match that exact projection, while the full
    // API job snapshot was independently checked against the original fixture.
    phase=`ROW_${index}_JOURNAL_PRINTER`;assert.deepEqual(journal.content.printer_snapshot,bridgePrinter(j.printer_snapshot));
    phase=`ROW_${index}_JOURNAL_ACK`;
    assert.equal(journal.claim.version,'1');assert.equal(journal.job_version,'2');assert.equal(journal.ack.version,'2');
    assert.equal(journal.ack.lease_token,journal.claim.lease_token);assert.equal(journal.ack.result,'file_saved');
    assert.equal(journal.ack.content_sha256,j.content_sha256);assert.equal(journal.ack.artifact_name,name);assert.equal(journal.ack.spool_job_id,undefined);
    phase=`ROW_${index}_ACK_RECEIPT`;const ack=detail.events[2].result.receipt;assert.equal(ack.result,'file_saved');assert.equal(ack.artifact_name,name);assert.equal(ack.content_sha256,j.content_sha256);
    files.push({index,shipment_id:r.shipment_id,order_id:r.order_id,job_id:j.id,job_create_event_id:r.job_create_event_id,ack_event_id:detail.events[2].id,artifact_name:name,content_sha256:sha(saved),content_bytes:saved.length,pages:original.pages,mode:'0600',original_source_bytes_exact:true});
  }
  phase='FINAL_OUTPUT_SET';assert.equal(new Set(files.map(f=>f.job_id)).size,3);
  assert.equal(names.filter(n=>n.endsWith('.pdf')).length,3);assert.equal(names.filter(n=>n.endsWith('.zpl')).length,0);
  // Combined metadata is read from the immutable preview through the public
  // parent receipt's preview ID; never retrieve bytes with a stale claim lease.
  phase='GET_PREVIEW';const p=(await get('/print-jobs/label-batches/previews/'+printUuid.parse(e.preview_id))).preview;phase='COMBINED_NOT_OUTPUT';
  assert.equal(p.id,e.preview_id);assert.equal(p.queued_execution_id,e.id);assert.equal(p.scope_hash,e.scope_hash);
  assert.equal(p.combined_pdf.pages,4);assert.equal(p.combined_pdf.format,'pdf');
  for(const f of files)assert.notEqual(f.content_sha256,p.combined_pdf.content_sha256);
  assert(!names.some(n=>n.includes(p.combined_pdf.content_sha256)));
  phase='FINAL_PRIVATE_CUSTODY_UNCHANGED';assert.deepEqual(await privateBytes(statePath,8*1024*1024),stateBytes);
  assert.deepEqual(await privateBytes(configPath,16384),configBytes);
  for(const j of journals.values())assert.deepEqual(await privateBytes(join(base,j.name),4*1024*1024),j.bytes);
  assert.deepEqual((await readdir(base)).sort(),names.sort());
  const report={stage:150,status:'ORIGINAL_LABEL_FILES_PASS_LIMITED',runtime_revision:revision,schema_revision:health.schema_revision,tenant_id:s.tenant_id,execution_id:e.id,preview_id:p.id,configuration:{tenant_id:config.tenant_id,printer_id:config.printer_id,output_mode:'file',format:'pdf',credential_kind:config.api_token?'api_key':'local_fixture_cookie'},files,source_pages:4,combined_pdf:{content_sha256:p.combined_pdf.content_sha256,content_bytes:p.combined_pdf.content_bytes,pages:4},combined_pdf_not_job_or_output:true,private_setup_and_bridge_custody_unchanged:true,prior_readonly_attempt:{status:'FAILED_NO_PRIVATE_OUTPUT',count:1,observed_failure_phase:null,source_diagnosis:'BRIDGE_PRINTER_PROJECTION_COMPARED_TO_FULL_API_SNAPSHOT',diagnosis_basis:'SOURCE_REVIEW_INFERENCE_NOT_CAPTURED_RUNTIME_PHASE',mutating_requests:0,db_access:false},network_methods:['GET'],db_access:false,provider_requests:0,fixture_seeded_source:true,provider_verified:false,physical_paper_verified:false,physical_order_verified:false,full_goal_complete:false};
  phase='WRITE_EXCLUSIVE_PUBLIC_REPORT';
  const output=await open(reportPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.sync();}finally{await output.close();}
  console.log(JSON.stringify({stage:150,status:report.status,jobs:3,files:files.length,source_pages:4,physical_paper_verified:false}));
}
await main().catch(()=>{console.error(JSON.stringify({status:'QA150_FILES_READBACK_FAILED_NO_PRIVATE_OUTPUT',phase}));process.exitCode=1;});
