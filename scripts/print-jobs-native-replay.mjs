/** Own QA145 exact committed ACK replay; never dispatches bytes or creates a job. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, open, rename } from 'node:fs/promises';
const root='<workspace>/app';
const s=JSON.parse(await readFile(root+'/data/print-jobs-stage145.json','utf8'));
assert.equal(s.stage,145);assert.equal(s.complete,true);assert.equal(s.pending,null);
const baseline=JSON.parse(await readFile(root+'/data/print-jobs-stage145-after-files.json','utf8'));
const health=await (await fetch('http://127.0.0.1:4100/api/health')).json();
assert.equal(health.revision,process.env.QA_EXPECTED_REVISION);assert.equal(health.schema_revision,'129_print_jobs');assert.equal(health.background_workers_enabled,false);
const path=root+'/data/print-jobs-stage145-replay-attempt.json';
const attempt={stage:145,pending:null,results:[]};
await writeFile(path,JSON.stringify(attempt),{flag:'wx',mode:0o600});
async function save(){const temp=path+'.'+randomUUID()+'.tmp';const h=await open(temp,'wx',0o600);try{await h.writeFile(JSON.stringify(attempt));await h.sync();}finally{await h.close();}await rename(temp,path);const d=await open(root+'/data','r');try{await d.sync();}finally{await d.close();}}
async function request(name,url,method,body,status,extra={}){
 attempt.pending={name,url,method,body};await save();
 const r=await fetch('http://127.0.0.1:4100/api'+url,{method,headers:{cookie:s.cookie,'X-Workspace-ID':s.tenant_id,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});
 assert.equal(r.status,status,name+' unexpected status; no automatic retry');
 const v=await r.json();attempt.results.push({name,status,reused:v.reused??null});attempt.pending=null;await save();return v;
}
for(const job of baseline.rows.print_jobs){
 const journal=JSON.parse(await readFile(`${root}/data/print-bridge/${s.tenant_id}/${job.printer_id}/current.json`,'utf8'));
 assert.equal(journal.state,'complete');assert.equal(journal.job_id,job.id);
 const r=await request(job.format+' exact committed ACK',`/print-jobs/jobs/${job.id}/ack`,'POST',journal.ack,200);
 assert.equal(r.reused,true);assert.equal(r.job.id,job.id);assert.equal(r.job.state,'file_saved');assert.equal(r.job.version,'3');
 await request(job.format+' changed ACK conflict',`/print-jobs/jobs/${job.id}/ack`,'POST',{...journal.ack,artifact_name:'changed-demo.pdf'},409);
 await request(job.format+' wrong lease content',`/print-jobs/jobs/${job.id}/content`,'GET',undefined,409,{'X-Print-Lease':randomUUID()});
}
await writeFile(root+'/docs/print-jobs-native-replay.json',JSON.stringify({stage:145,status:'OWNED_ACK_REPLAY_AND_CONFLICT_PASS_LIMITED',runtime_revision:health.revision,results:attempt.results,no_bridge_dispatch:true,physical_paper_verified:false,full_rows_comparison:'print-jobs-native-after-denied.json'},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:'OWNED_ACK_REPLAY_AND_CONFLICT_PASS_LIMITED',requests:attempt.results.length,physical_output_attempts:0}));
