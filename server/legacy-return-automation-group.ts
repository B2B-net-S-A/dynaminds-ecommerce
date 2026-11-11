// SUCCESSOR AUTHORED_ONLY. Companion to exact native63234 receive→close phase.
// AUTHORED_ONLY. Future server/legacy-return-automation-group.ts.
// Exactly one worker group, no per-item savepoint/catch-and-continue path.
import { pool } from './db';
import { ensure } from './errors';
import { audit, lockedOrder, transition, type Actor } from './domain';
import { normalizedRule, matchesRule } from './operation-schema';
import { isLocalFinancialVersion } from './local-financial-policy';
import type { EventContext } from './events';
import { beginWmsTransaction,endWmsTransaction,wmsLotsAdmissionInTx,finalizeWmsActorsInTx } from './wms-lots-transaction';
import { beginPurchasingTransaction,endPurchasingTransaction,purchasingStockAdmissionInTx } from './purchasing-transaction';
import { beginDispatchTransaction,endDispatchTransaction,finalizeDispatchActorsInTx } from './dispatch-transaction';
import { beginCatalogStockControlTransaction,endCatalogStockControlTransaction,catalogStockControlAdmissionInTx,
  enlistCatalogStockControlActorInTx,finalizeCatalogStockControlActorsInTx,finalizeCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import { beginAllegroAuthorityTransaction,endAllegroAuthorityTransaction,finalizeAllegroAuthoritiesInTx } from './allegro-oauth-authority';
import { prepareLegacyReturnGroupInTx,legacyReturnGroupAvailableInTx,groupOwnerInTx,
  captureLegacyReturnGroupInTx,finishLegacyReturnGroupInTx,pinLegacyReturnGroupNativeInTx,
  discardLegacyReturnGroupInTx,type LegacyReturnGroup } from './legacy-return-group';

export function isMinimalLegacyReturnRule(run: any): boolean {
  const actions=run?.definition?.actions;
  return typeof run?.definition?.actor_id==='string' && run.definition?.trigger==='order.return_initiated'
    && Array.isArray(actions)&&actions.length===2&&actions.every((a:any,i:number)=>
      a&&Object.keys(a).length===2&&a.type==='set_status'
      &&a.status===(i===0?'return_received':'return_completed'));
}
// Exact action values are checked again by SQL using jsonb equality. This JS
// test selects a server branch; object key ordering cannot create authority.
class OrdinaryWorkerFallback extends Error {}
type NativeJob = { id:string;tenant_id:string;lease_token:string;payload:{run_id:string} };

/** Custom managed transaction is necessary: no work may follow its last native
 * schema/role check, even if a sibling finalizer waits. The normal tenantTx
 * callback cannot express that terminal order. It is not an HTTP runner option.
 * false means entire read/pre-admission TX rolled back; ordinary worker handles
 * native skip/absence/unsupported cases afresh. Errors never become success. */
export async function processMinimalLegacyReturnRule(job: NativeJob, initial: any): Promise<boolean> {
  if(!isMinimalLegacyReturnRule(initial))return false;
  const c=await pool.connect();let group:LegacyReturnGroup|null=null;
  const actor:Actor={tenantId:job.tenant_id,userId:initial.definition.actor_id,role:'admin'};
  try {
    await c.query('BEGIN');await c.query("SET LOCAL TimeZone='UTC'");
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)",[actor.tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'");
    beginWmsTransaction(c);beginPurchasingTransaction(c);beginDispatchTransaction(c);
    beginCatalogStockControlTransaction(c);beginAllegroAuthorityTransaction(c);
    await wmsLotsAdmissionInTx(c,{tenantId:actor.tenantId},'shared');
    await purchasingStockAdmissionInTx(c,{tenantId:actor.tenantId});
    await catalogStockControlAdmissionInTx(c,{tenantId:actor.tenantId},'shared');
    if(!await legacyReturnGroupAvailableInTx(c,actor))throw new OrdinaryWorkerFallback();
    const run=(await c.query('SELECT * FROM automation_runs WHERE id=$1',[initial.id])).rows[0];
    if(!run||!isMinimalLegacyReturnRule(run)||run.job_id!==job.id||run.state!=='queued')throw new OrdinaryWorkerFallback();
    const rule=normalizedRule({...run.definition,action:'actions',config:run.definition});
    const context:EventContext=run.context;
    // New runs carry native frozen context. Pre-migration missing-context jobs
    // retain the ordinary path, rather than manufacturing a new chain UUID.
    if(!context||context.depth>=8||context.trace.includes(run.rule_id)||!matchesRule(rule,run.snapshot)
      ||await isLocalFinancialVersion(c,run.order_id))throw new OrdinaryWorkerFallback();
    const memberRole=await groupOwnerInTx(c,actor,async()=>
      (await c.query('SELECT public.b2b_dropship_current_role($1,false) role',[actor.userId])).rows[0].role);
    if(memberRole!=='admin')throw new OrdinaryWorkerFallback();
    group=await prepareLegacyReturnGroupInTx(c,actor,run.id,job.lease_token);
    if(!group)throw new OrdinaryWorkerFallback();
    // Both group frame and native169 receive admission exist BEFORE these locks.
    const held=(await c.query("SELECT * FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",[job.id,job.lease_token])).rows[0];
    if(!held)throw new OrdinaryWorkerFallback();
    const current=(await c.query('SELECT * FROM automation_runs WHERE id=$1 FOR UPDATE',[run.id])).rows[0];
    ensure(current?.state==='queued'&&current.job_id===job.id,409,'Nieaktualne wykonanie reguły');
    const currentRule=(await c.query('SELECT * FROM automation_rules WHERE id=$1 FOR SHARE',[run.rule_id])).rows[0];
    const order=await lockedOrder(c,run.order_id);
    // Preserve native condition/rule/version/context skip checks after waits.
    if(!currentRule?.enabled||currentRule.version!==run.rule_version
      ||order.status!==run.snapshot.status||order.workflow_status_id!==run.snapshot.workflow_status_id
      ||await isLocalFinancialVersion(c,order.id))throw new OrdinaryWorkerFallback();
    await groupOwnerInTx(c,actor,async()=>{await c.query('SELECT public.catalog_stock_legacy_group_lock_validate($1,$2)',[actor.userId,group!.id]);});
    enlistCatalogStockControlActorInTx(c,actor,{adminOnly:true,scopes:['orders:write']});
    const results: {changed:true;status:string;workflow_status_id:string|null;tags:string[];version:string}[]=[];
    for(const [index,status] of ['return_received','return_completed'].entries()){
      await transition(c,actor,order.id,status,{
        ...context,operation:{kind:'rule',id:run.id,action_index:index},
        depth:context.depth+1,trace:[...context.trace,run.rule_id],
      },undefined,group);
      const after=await lockedOrder(c,order.id);
      results.push({changed:true,status:after.status,workflow_status_id:after.workflow_status_id,tags:after.tags,version:after.version});
      if(index===0)await captureLegacyReturnGroupInTx(c,actor,group);
    }
    await c.query('UPDATE automation_runs SET state=$2,result=$3,error=$4,finished_at=now() WHERE id=$1',
      [run.id,'done',JSON.stringify({matched:true,reason:null,actions:results}),null]);
    await c.query("UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1",[job.id]);
    await audit(c,actor,'automation.executed',run.rule_id,{eventId:run.event_id,orderId:order.id,runId:run.id,version:run.rule_version,reason:null,error:null});
    // All real native parent/result/audit writes precede immutable final seal.
    await finishLegacyReturnGroupInTx(c,actor,group);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await pinLegacyReturnGroupNativeInTx(c,actor,group);
    await finalizeWmsActorsInTx(c);await finalizeCatalogStockControlActorsInTx(c);
    await finalizeDispatchActorsInTx(c);await finalizeCatalogStockCountTerminalInTx(c);
    await finalizeAllegroAuthoritiesInTx(c); // empty in this exact group
    // One source actor, no key/session/provider: job's true native authority.
    // Pin AFTER all sibling waits, then costly schema/graph, then fresh native
    // role again. There is no response hydration/DML after this last gate.
    await groupOwnerInTx(c,actor,async()=>{
      const role=(await c.query('SELECT public.b2b_dropship_current_role($1,true) role',[actor.userId])).rows[0].role;
      ensure(role==='admin',403,'Autor reguły nie ma bieżącej roli administratora');
      await c.query('SELECT public.catalog_stock_legacy_group_require()');
      await c.query('SELECT public.catalog_stock_legacy_group_validate($1)',[group!.id]);
      const currentRole=(await c.query('SELECT public.b2b_dropship_current_role($1,false) role',[actor.userId])).rows[0].role;
      ensure(currentRole==='admin',403,'Cofnięto autora przed zatwierdzeniem grupy');
      await c.query('SELECT public.catalog_stock_return_access($1,NULL,$2,$3)',[actor.userId,group!.return_id,'legacy_status']);
    });
    await c.query('COMMIT');return true;
  }catch(e){
    // Entire TX, including every counter/event/job/audit/parent, is reverted.
    // No JS-only savepoint restore or reused consumed return token is attempted.
    try{await c.query('ROLLBACK');}catch(cleanup){throw new AggregateError([e,cleanup],'Nie można potwierdzić rollback grupy');}
    if(e instanceof OrdinaryWorkerFallback)return false;throw e;
  }finally{
    try{discardLegacyReturnGroupInTx(c,actor,group);}finally{
      endWmsTransaction(c);endPurchasingTransaction(c);endDispatchTransaction(c);
      endCatalogStockControlTransaction(c);endAllegroAuthorityTransaction(c);c.release();
    }
  }
}
