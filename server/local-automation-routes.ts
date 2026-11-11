import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {tenantTx} from './db';
import {audit, type Actor} from './domain';
import {ensure, Problem} from './errors';
import {ruleInput, normalizedRule} from './operation-schema';
import {dispatchAutomation, processAutomation, failAutomation} from './automations';

const marker='owned-local-automation/v1';
const params=z.strictObject({id:z.uuid(), request:z.uuid().optional()});
const body=z.strictObject({request_id:z.uuid()});
type Receipt={source:string;request_id:string;order_id:string;rule_id:string;rule_version:string;workflow_id:string;workflow_version:string;note:string;source_value:string};
function requireSession(actor:Actor, apiScopes:unknown, readOnly:boolean) {
  ensure(!readOnly,423,'Kopia jest tylko do odczytu');
  ensure(actor.role==='admin' && !actor.apiKeyId && !apiScopes,403,'Wymagana sesja administratora');
}
async function currentAdmin(c:PoolClient,a:Actor) {
  ensure((await c.query('SELECT offer_sync_is_admin($1) ok',[a.userId])).rows[0]?.ok===true,403,'Wymagany aktualny administrator');
}
function fixedRule(r:Receipt) {
  return ruleInput.parse({name:'DEMO lokalna automatyzacja '+r.request_id,trigger:'order.paid',enabled:true,priority:0,delay_seconds:0,match:'all',
    conditions:[{field:'source',op:'eq',value:r.source_value},{field:'status',op:'eq',value:'paid'}],
    actions:[{type:'set_workflow',status_id:r.workflow_id,status_version:r.workflow_version},{type:'add_note',note:r.note}]});
}
// Pure guards are also used by the exact production claim. They do not mint a job/Actor.
export function assertOwnPendingJob(job:any, tenant:string, kind:string) {
  ensure(job?.tenant_id===tenant && job.kind===kind && job.state==='pending' && Number(job.attempts)===0
    && job.lease_token===null && job.locked_at===null,409,'Wyłącznie nowe nieuruchomione zadanie');
}
export function assertOwnedDispatcher(job:any, r:Receipt, actor:Actor, eventId:string) {
  assertOwnPendingJob(job,actor.tenantId,'automation');
  ensure(job.payload?.orderId===r.order_id && job.payload.eventId===eventId && job.payload.trigger==='order.paid'
    && job.payload.snapshot?.id===r.order_id && job.payload.snapshot?.status==='paid'
    && job.payload.snapshot?.source===r.source_value && Array.isArray(job.payload.rules) && job.payload.rules.length===1,
    409,'Zdarzenie nie zawiera wyłącznie własnej nowej reguły');
  const rule=job.payload.rules[0];
  ensure(rule.id===r.rule_id && String(rule.version)===r.rule_version && rule.actor_id===actor.userId
    && rule.tenant_id===actor.tenantId && isDeepStrictEqual(normalizedRule(rule),fixedRule(r)),409,'Zmieniła się zamrożona własna reguła');
  ensure(job.payload.context?.depth===0 && Array.isArray(job.payload.context.trace) && job.payload.context.trace.length===0,
    409,'Dozwolone jest tylko nowe źródłowe zdarzenie');
}
export function assertOwnedRun(run:any,job:any,r:Receipt,actor:Actor,eventId:string) {
  assertOwnPendingJob(job,actor.tenantId,'automation.run');
  ensure(run?.tenant_id===actor.tenantId && run.order_id===r.order_id && run.rule_id===r.rule_id
    && String(run.rule_version)===r.rule_version && run.event_id===eventId && run.job_id===job.id && run.state==='queued'
    && job.payload?.run_id===run.id && Object.keys(job.payload).join(',')==='run_id'
    && run.definition?.actor_id===actor.userId && isDeepStrictEqual(ruleInput.parse(run.definition),fixedRule(r)),
    409,'Dozwolone jest tylko wykonanie własnej nowej definicji');
}
async function receipt(c:PoolClient,a:Actor,orderId:string,requestId:string):Promise<Receipt> {
  const rows=(await c.query(`SELECT detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3
    AND action='local.automation.prepare'`,[a.tenantId,a.userId,requestId])).rows;
  ensure(rows.length===1 && rows[0].detail?.source===marker && rows[0].detail.order_id===orderId,404,'Brak własnego przygotowania');
  return rows[0].detail;
}
async function lease(c:PoolClient,a:Actor,id:string) {
  const claimed=(await c.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=1,locked_at=now(),lease_token=$3
    WHERE tenant_id=$1 AND id=$2 AND state='pending' AND attempts=0 AND lease_token IS NULL AND run_at<=now() RETURNING *`,
    [a.tenantId,id,randomUUID()])).rows[0];
  ensure(claimed,409,'Nowe własne zadanie nie jest gotowe do dzierżawy'); return claimed;
}
async function readback(c:PoolClient,a:Actor,r:Receipt) {
  const order=(await c.query('SELECT id,status,workflow_status_id,note,version FROM orders WHERE tenant_id=$1 AND id=$2',[a.tenantId,r.order_id])).rows[0];
  const runs=(await c.query(`SELECT id,event_id,job_id,rule_id,rule_version,order_id,state,result,error FROM automation_runs
    WHERE tenant_id=$1 AND rule_id=$2 AND order_id=$3 ORDER BY created_at,id`,[a.tenantId,r.rule_id,r.order_id])).rows;
  const jobs=(await c.query(`SELECT id,kind,state,attempts,max_attempts,lease_token IS NULL AS lease_released,locked_at IS NULL AS lock_released,payload->>'eventId' AS event_id FROM jobs WHERE tenant_id=$1 AND
    (kind='automation' AND payload->>'orderId'=$2 AND payload->'rules' @> $3::jsonb
    OR kind='automation.run' AND payload->>'run_id'=ANY($4::text[])) ORDER BY created_at,id`,
    [a.tenantId,r.order_id,JSON.stringify([{id:r.rule_id}]),runs.map((x:any)=>x.id)])).rows;
  const rule=(await c.query('SELECT * FROM automation_rules WHERE tenant_id=$1 AND id=$2',[a.tenantId,r.rule_id])).rows[0];
  const startedRows=(await c.query("SELECT id,detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3 AND action='local.automation.dispatch-started'",[a.tenantId,a.userId,r.request_id])).rows;
  const started=startedRows.length!==0;
  const finished=(await c.query("SELECT id,detail FROM audit_events WHERE tenant_id=$1 AND user_id=$2 AND entity_id=$3 AND action='local.automation.finished'",[a.tenantId,a.userId,r.request_id])).rows;
  const run=runs[0],dispatcher=jobs.find((j:any)=>j.kind==='automation'),execution=jobs.find((j:any)=>j.kind==='automation.run');
  const confirmed=startedRows.length===1&&finished.length===1&&runs.length===1&&jobs.length===2
    &&startedRows[0].detail?.source===marker
    &&startedRows[0].detail?.order_id===r.order_id&&startedRows[0].detail?.event_id===run.event_id&&startedRows[0].detail?.job_id===dispatcher?.id
    &&finished[0].detail?.source===marker&&finished[0].detail?.order_id===r.order_id&&finished[0].detail?.event_id===run.event_id&&finished[0].detail?.run_id===run.id
    &&run.rule_id===r.rule_id&&String(run.rule_version)===r.rule_version&&run.order_id===r.order_id&&run.job_id===execution?.id
    &&run.state==='done'&&run.error===null&&run.result?.matched===true&&run.result?.reason===null&&run.result?.actions?.length===2
    &&dispatcher?.event_id===run.event_id&&jobs.every((j:any)=>j.state==='done'&&Number(j.attempts)===1&&Number(j.max_attempts)===1&&j.lease_released&&j.lock_released)
    &&rule?.actor_id===a.userId&&rule.enabled===false&&String(rule.version)===String(BigInt(r.rule_version)+1n)
    &&order?.id===r.order_id&&order.status==='paid'&&order.workflow_status_id===r.workflow_id&&order.note===r.note;
  const prepared=!started && rule?.actor_id===a.userId && String(rule.version)===r.rule_version && isDeepStrictEqual(normalizedRule(rule),fixedRule(r));
  const ruleSummary=rule?{id:rule.id,enabled:rule.enabled,version:rule.version}:null;
  return {scope:'local_demo',request_id:r.request_id,order_id:r.order_id,rule_id:r.rule_id,workflow_id:r.workflow_id,
    order,runs,jobs,expected_note:r.note,confirmed_receipt_verified:confirmed,finished_audit_id:confirmed?finished[0].id:null,event_id:runs[0]?.event_id??jobs.find((j:any)=>j.kind==='automation')?.event_id??null,run_id:runs[0]?.id??null,rule:ruleSummary,dispatch_started:started,prepared_receipt_confirmed:prepared,external_message_sent:false,provider_verified:false,automatic_retry:false};
}
export function registerLocalAutomationRoutes(app:FastifyInstance,options:{readOnly:boolean}) {
  const readOnly=options.readOnly;
  app.post('/api/orders/:id/local-automation/prepare',async(req,reply)=>{
    const a=req.actor; requireSession(a,req.apiScopes,readOnly);
    const orderId=params.parse(req.params).id, requestId=body.parse(req.body).request_id;
    const result=await tenantTx(a.tenantId,async c=>{
      await currentAdmin(c,a);
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[a.tenantId]);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['rules:'+a.tenantId]);
      ensure(!(await c.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND action='local.automation.prepare' AND entity_id=$2",[a.tenantId,requestId])).rowCount,
        409,'Ten request już istnieje; użyj odczytu, nie ponawiaj');
      const order=(await c.query(`SELECT o.id,o.status,o.source,o.note FROM orders o WHERE o.tenant_id=$1 AND o.id=$2
        AND o.created_at>clock_timestamp()-interval '15 minutes' AND EXISTS(SELECT 1 FROM audit_events x
        WHERE x.tenant_id=o.tenant_id AND x.entity_id=o.id AND x.action='order.create' AND x.user_id=$3) FOR UPDATE OF o`,
        [a.tenantId,orderId,a.userId])).rows[0];
      ensure(order?.status==='new' && order.note==='' && typeof order.source==='string',409,'Wymagane świeże własne zamówienie NEW bez notatki');
      // Do not disable, rewrite, filter or execute other people's definitions.
      ensure(!(await c.query("SELECT id FROM automation_rules WHERE tenant_id=$1 AND enabled AND trigger='order.paid'",[a.tenantId])).rowCount,
        409,'Lokalne DEMO wymaga braku innych aktywnych reguł order.paid; nie zmieniamy istniejących reguł');
      const counts=(await c.query('SELECT (SELECT count(*) FROM workflow_statuses) workflows,(SELECT count(*) FROM automation_rules) rules')).rows[0];
      ensure(Number(counts.workflows)<100 && Number(counts.rules)<100,422,'Limit statusów lub reguł');
      const workflow=(await c.query(`INSERT INTO workflow_statuses(id,tenant_id,name,color,stage,active)
        VALUES($1,$2,$3,'#2563eb','paid',true) RETURNING id,version`,[randomUUID(),a.tenantId,'DEMO opłacone '+requestId])).rows[0];
      const r:Receipt={source:marker,request_id:requestId,order_id:orderId,rule_id:randomUUID(),rule_version:'1',
        workflow_id:workflow.id,workflow_version:String(workflow.version),note:'Lokalna automatyzacja DEMO '+requestId,source_value:order.source};
      const rule=fixedRule(r);
      const saved=(await c.query(`INSERT INTO automation_rules(id,tenant_id,name,trigger,action,config,enabled,priority,delay_seconds,actor_id)
        VALUES($1,$2,$3,'order.paid','actions',$4,true,0,0,$5) RETURNING version`,
        [r.rule_id,a.tenantId,rule.name,JSON.stringify({match:rule.match,conditions:rule.conditions,actions:rule.actions}),a.userId])).rows[0];
      r.rule_version=String(saved.version);
      await audit(c,a,'workflow.create',r.workflow_id); await audit(c,a,'automation.create',r.rule_id);
      await audit(c,a,'local.automation.prepare',requestId,r);
      return {...r,scope:'local_demo',status:'PREPARED',automatic_retry:false,external_message_sent:false};
    });return reply.code(201).send(result);
  });
  app.get('/api/orders/:id/local-automation/:request',async req=>{
    const a=req.actor;requireSession(a,req.apiScopes,false);const p=params.parse(req.params);ensure(p.request,400,'Brak request');
    return tenantTx(a.tenantId,async c=>{await currentAdmin(c,a);return readback(c,a,await receipt(c,a,p.id,p.request!));});
  });
  app.post('/api/orders/:id/local-automation/:request/dispatch',async(req,reply)=>{
    const a=req.actor;requireSession(a,req.apiScopes,readOnly);const p=params.parse(req.params);ensure(p.request,400,'Brak request');
    z.strictObject({}).parse(req.body??{});
    let r:Receipt|undefined,claimed:any=null,eventId:string|null=null,runId:string|null=null,phase='claim-own-new-event';
    let primary:unknown=null,started=false;const cleanup:string[]=[],ownedJobIds:string[]=[];
    try {
      claimed=await tenantTx(a.tenantId,async c=>{
        await currentAdmin(c,a);await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[a.tenantId]);
        r=await receipt(c,a,p.id,p.request!);
        ensure(!(await c.query("SELECT id FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='local.automation.dispatch-started'",[a.tenantId,p.request])).rowCount,
          409,'Próba została już rozpoczęta; użyj odczytu, nie ponawiaj');
        const jobs=(await c.query(`SELECT j.* FROM order_events e CROSS JOIN LATERAL(SELECT 'event:'||e.id::text dedup_key OFFSET 0)x JOIN jobs j ON (j.tenant_id,j.dedup_key)=(e.tenant_id,x.dedup_key)
          WHERE j.tenant_id=$1 AND j.kind='automation' AND j.payload->>'orderId'=$2 AND (j.payload->>'eventId')::uuid=e.id AND e.tenant_id=$1 AND e.order_id=$2::uuid
          AND e.kind='order.paid' AND j.payload->'rules' @> $3::jsonb FOR UPDATE OF j`,[a.tenantId,p.id,JSON.stringify([{id:r!.rule_id}])])).rows;
        ensure(jobs.length===1,409,'Brak jednoznacznego nowego zdarzenia płatności');eventId=jobs[0].payload.eventId;
        assertOwnedDispatcher(jobs[0],r!,a,eventId!);
        await audit(c,a,'local.automation.dispatch-started',p.request!,{source:marker,order_id:p.id,event_id:eventId,job_id:jobs[0].id});
        return lease(c,a,jobs[0].id);
      });
      ownedJobIds.push(claimed.id);started=true;phase='existing-dispatchAutomation';await dispatchAutomation(claimed);claimed=null;
      phase='claim-own-new-run';
      claimed=await tenantTx(a.tenantId,async c=>{
        await currentAdmin(c,a);
        const runs=(await c.query('SELECT * FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND order_id=$3 AND event_id=$4',
          [a.tenantId,r!.rule_id,p.id,eventId])).rows;ensure(runs.length===1,409,'Brak jednego własnego wykonania');runId=runs[0].id;
        const job=(await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,runs[0].job_id])).rows[0];
        const locked=(await c.query('SELECT * FROM automation_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,runId])).rows[0];
        assertOwnedRun(locked,job,r!,a,eventId!);return lease(c,a,job.id);
      });
      ownedJobIds.push(claimed.id);phase='existing-processAutomation';await processAutomation(claimed);claimed=null;
      phase='actual-owned-readback';
      const result=await tenantTx(a.tenantId,async c=>{await currentAdmin(c,a);return readback(c,a,r!);});
      ensure(result.runs.length===1 && result.runs[0].state==='done' && result.runs[0].result?.actions?.length===2
        && result.jobs.length===2 && result.jobs.every((j:any)=>j.state==='done'&&Number(j.attempts)===1)
        && result.order?.status==='paid' && result.order.workflow_status_id===r!.workflow_id && result.order.note===r!.note,
        409,'Automatyzacja nie potwierdziła oczekiwanych lokalnych skutków');
      await tenantTx(a.tenantId,async c=>{
        await currentAdmin(c,a);const disabled=await c.query('UPDATE automation_rules SET enabled=false,version=version+1 WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 AND version=$4 AND enabled RETURNING id',
          [a.tenantId,r!.rule_id,a.userId,r!.rule_version]);ensure(disabled.rowCount===1,409,'Własna reguła zmieniła się przed zakończeniem');
        await audit(c,a,'local.automation.finished',p.request!,{source:marker,order_id:p.id,event_id:eventId,run_id:runId});
      });
      phase='finished-own-readback';const final=await tenantTx(a.tenantId,async c=>{await currentAdmin(c,a);return readback(c,a,r!);});
      ensure(final.confirmed_receipt_verified,409,'Zakończenie własnej reguły nie jest potwierdzone');
      return reply.code(201).send({...final,status:'OWNED_LOCAL_AUTOMATION_DONE',event_id:eventId,run_id:runId,
        rule_disabled_after_run:true,preexisting_jobs_executed:false});
    }catch(error){
      primary=error;
      if(claimed)try{await failAutomation(claimed,error);}catch{cleanup.push('owned-job-failure-cleanup');}
      if(r&&started)try{await tenantTx(a.tenantId,async c=>{await currentAdmin(c,a);return c.query('UPDATE automation_rules SET enabled=false,version=version+1 WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 AND version=$4 AND enabled',
        [a.tenantId,r!.rule_id,a.userId,r!.rule_version]);});}catch{cleanup.push('owned-rule-disable');}
      // Preserve known identities. Rejection/HTTP response is not a rollback certificate.
      return reply.code(primary instanceof Problem?primary.status:500).send({status:'LOCAL_AUTOMATION_NOT_CONFIRMED',scope:'local_demo',
        request_id:p.request,order_id:p.id,rule_id:r?.rule_id??null,workflow_id:r?.workflow_id??null,event_id:eventId,run_id:runId,
        claimed_job_id:claimed?.id??null,job_ids:ownedJobIds,failed_phase:phase,error_code:typeof (primary as any)?.code==='string'&&/^[A-Z0-9_]{1,40}$/.test((primary as any).code)?(primary as any).code:null,
        effects_unknown:true,automatic_retry:false,external_message_sent:false,cleanup});
    }
  });
}
