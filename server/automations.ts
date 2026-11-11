import {requireAutomaticLeaseInTx,type AutomaticLease} from './local-automation-worker-control';
import { isCustomerWorkflowAction } from './customer-message-workflow-schema';
import { prepareCustomerMessageWorkflowActionsInTx } from './customer-message-workflows';
import { lockEmailQueue } from './email-actions';
import { randomUUID } from 'node:crypto';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, lockedOrder, type Actor } from './domain';
import { isLocalFinancialVersion } from './local-financial-policy';
import { type EventContext } from './events';
import { normalizedRule, matchesRule } from './operation-schema';
import { applyOrderAction } from './order-operations';
import { processMinimalLegacyReturnRule } from './legacy-return-automation-group';
export async function dispatchAutomation(job: any, automaticLease?: AutomaticLease) {
  return tenantTx(job.tenant_id, async (c) => {
    if(automaticLease!==undefined)await requireAutomaticLeaseInTx(c,automaticLease,job);
    if (
      !(
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rowCount
    )
      return;
    const event = (
      await c.query('SELECT * FROM order_events WHERE id=$1 AND order_id=$2', [
        job.payload.eventId,
        job.payload.orderId,
      ])
    ).rows[0];
    ensure(
      event && event.kind === job.payload.trigger,
      409,
      'Zadanie nie zgadza się ze zdarzeniem',
    );
    if (event.kind === 'customer_message.received') {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'customer-message-dispatch:' + job.tenant_id,
      ]);
      const active = (
        await c.query(
          "SELECT count(*)::int n FROM jobs WHERE (state='pending' OR state='running') AND (kind='automation' AND payload->>'trigger'='customer_message.received' OR kind='automation.run' AND EXISTS(SELECT 1 FROM automation_runs r WHERE r.job_id=jobs.id AND r.definition->>'trigger'='customer_message.received'))",
        )
      ).rows[0].n;
      const candidates = (job.payload.rules ?? []).filter(
        (r: any) => !job.payload.context?.trace?.includes(r.id),
      ).length;
      ensure(active + candidates <= 200, 429, 'Kolejka workflow wiadomości jest pełna');
    }
    // Pre-migration jobs have no frozen definition. Never apply newly created rules retroactively.
    if (Array.isArray(job.payload.rules) && job.payload.snapshot) {
      const chain = job.payload.context?.chain_id;
      ensure(
        typeof chain === 'string' && chain.length <= 100,
        409,
        'Brak identyfikatora łańcucha zdarzeń',
      );
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'automation-chain:' + job.tenant_id + ':' + chain,
      ]);
      let scheduled = (
        await c.query(
          "SELECT count(*)::int AS n FROM automation_runs WHERE context->>'chain_id'=$1 AND (definition->>'limit_notice') IS DISTINCT FROM 'true'",
          [chain],
        )
      ).rows[0].n;
      for (let i = 0; i < job.payload.rules.length; i++) {
        const r = job.payload.rules[i];
        const definition = normalizedRule(r),
          id = randomUUID(),
          jid = randomUUID();
        const existing = (
          await c.query(
            'SELECT id FROM automation_runs WHERE event_id=$1 AND rule_id=$2 AND rule_version=$3',
            [event.id, r.id, r.version],
          )
        ).rowCount;
        if (existing) continue;
        if (scheduled >= 100) {
          const reason =
            'Limit 100 wykonań w łańcuchu zdarzeń — pominięto ' +
            (job.payload.rules.length - i) +
            ' reguł tego zdarzenia';
          await c.query(
            "INSERT INTO automation_runs(id,tenant_id,rule_id,rule_version,event_id,order_id,job_id,definition,snapshot,context,state,result,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'skipped',$11,now())",
            [
              id,
              job.tenant_id,
              r.id,
              r.version,
              event.id,
              event.order_id,
              job.id,
              JSON.stringify({ ...definition, name: 'Limit automatyzacji', limit_notice: true }),
              JSON.stringify(job.payload.snapshot),
              JSON.stringify(job.payload.context),
              JSON.stringify({
                matched: false,
                reason,
                suppressed_rules: job.payload.rules.length - i,
              }),
            ],
          );
          await c.query(
            'INSERT INTO audit_events(id,tenant_id,action,entity_id,detail) VALUES($1,$2,$3,$4,$5)',
            [
              randomUUID(),
              job.tenant_id,
              'automation.chain_limit',
              event.order_id,
              JSON.stringify({
                chain_id: chain,
                event_id: event.id,
                suppressed_rules: job.payload.rules.length - i,
              }),
            ],
          );
          break;
        }
        scheduled++;
        await c.query(
          'INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,run_at,priority) VALUES($1,$2,$3,$4,$5,$6::timestamptz+make_interval(secs=>$7),$8)',
          [
            jid,
            job.tenant_id,
            'automation.run',
            JSON.stringify({ run_id: id }),
            `automation:${event.id}:${r.id}:${r.version}`,
            event.created_at,
            definition.delay_seconds,
            definition.priority,
          ],
        );
        await c.query(
          'INSERT INTO automation_runs(id,tenant_id,rule_id,rule_version,event_id,order_id,job_id,definition,snapshot,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            id,
            job.tenant_id,
            r.id,
            r.version,
            event.id,
            event.order_id,
            jid,
            JSON.stringify({
              ...definition,
              actor_id: r.actor_id,
              legacy: r.action === 'add_note',
            }),
            JSON.stringify(job.payload.snapshot),
            JSON.stringify(job.payload.context),
          ],
        );
      }
    }
    await c.query(
      "UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1",
      [job.id],
    );
  });
}
export async function processAutomation(job: any, automaticLease?: AutomaticLease) {
  const run = await tenantTx(
    job.tenant_id,
    async (c) =>
      (await c.query('SELECT * FROM automation_runs WHERE id=$1', [job.payload.run_id])).rows[0],
  );
  ensure(run, 404, 'Nie znaleziono wykonania reguły');
  // The exact supported two-phase group owns its whole transaction; other native rules retain the existing path.
  if (automaticLease===undefined && await processMinimalLegacyReturnRule(job,run)) return;
  const owner = run.definition.actor_id;
  const member = (
    await pool.query(
      owner
        ? 'SELECT user_id,role FROM memberships WHERE tenant_id=$1 AND user_id=$2'
        : "SELECT user_id,role FROM memberships WHERE tenant_id=$1 AND role='admin' ORDER BY user_id LIMIT 1",
      owner ? [job.tenant_id, owner] : [job.tenant_id],
    )
  ).rows[0];
  return tenantTx(job.tenant_id, async (c) => {
    // Admission only; author/current IAM remain the existing later managed checks.
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`order-fields:${job.tenant_id}`]);
    if(automaticLease!==undefined)await requireAutomaticLeaseInTx(c,automaticLease,job);
    if (run.definition.actions?.some((a: any) => a.type === 'email'))
      await lockEmailQueue(c, job.tenant_id);
    if (
      !(
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rowCount
    )
      return;
    const current = (
      await c.query('SELECT * FROM automation_runs WHERE id=$1 FOR UPDATE', [run.id])
    ).rows[0];
    ensure(
      current.state === 'queued' && current.job_id === job.id,
      409,
      'Nieaktualne wykonanie reguły',
    );
    const rule = (
      await c.query('SELECT * FROM automation_rules WHERE id=$1 FOR SHARE', [run.rule_id])
    ).rows[0];
    const o = await lockedOrder(c, run.order_id),
      r = normalizedRule({ ...run.definition, action: 'actions', config: run.definition });
    const context: EventContext = run.context ?? { chain_id: randomUUID(), depth: 0, trace: [] };
    let reason: string | null = null;
    if (
      run.definition.trigger !== 'customer_message.received' &&
      (await isLocalFinancialVersion(c, o.id))
    )
      reason = 'Bieżąca wersja zamówienia wynika z lokalnego rozliczenia';
    else if (!member || member.role !== 'admin' || (!owner && !run.definition.legacy))
      reason = 'Autor reguły nie ma już uprawnień administratora';
    else if (!rule?.enabled || rule.version !== run.rule_version)
      reason = 'Reguła wyłączona lub zmieniona po zdarzeniu';
    else if (context.depth >= 8 || context.trace.includes(run.rule_id))
      reason = 'Zatrzymano powtarzającą się regułę lub łańcuch 8 zdarzeń';
    else if (!matchesRule(r, run.snapshot)) reason = 'Warunki zdarzenia nie są spełnione';
    else if (
      r.actions.some((a) => ['set_status', 'set_workflow'].includes(a.type)) &&
      (o.status !== run.snapshot.status || o.workflow_status_id !== run.snapshot.workflow_status_id)
    )
      reason = 'Etap zamówienia zmienił się od zdarzenia';
    const actor: Actor = { tenantId: job.tenant_id, userId: member?.user_id, role: 'admin' },
      results = [];
    let state = reason ? 'skipped' : 'done',
      error: string | null = null;
    if (!reason) {
      await c.query('SAVEPOINT rule_actions');
      try {
        if (r.actions.some(isCustomerWorkflowAction))
          await prepareCustomerMessageWorkflowActionsInTx(
            c,
            actor,
            o.id,
            r.actions.filter(isCustomerWorkflowAction),
            { ...context, operation: { kind: 'rule', id: run.id, action_index: 0 } },
          );
        for (const [action_index, action] of r.actions.entries())
          results.push(
            await applyOrderAction(c, actor, o.id, action, {
              ...context,
              operation: { kind: 'rule', id: run.id, action_index },
              depth: context.depth + 1,
              trace: [...context.trace, run.rule_id],
            }),
          );
        await c.query('RELEASE SAVEPOINT rule_actions');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT rule_actions');
        await c.query('RELEASE SAVEPOINT rule_actions');
        if (!(e instanceof Problem)) throw e;
        state = 'failed';
        error = e.message;
        results.length = 0;
      }
    }
    await c.query(
      'UPDATE automation_runs SET state=$2,result=$3,error=$4,finished_at=now() WHERE id=$1',
      [run.id, state, JSON.stringify({ matched: !reason, reason, actions: results }), error],
    );
    await c.query(
      "UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1",
      [job.id],
    );
    if (member)
      await audit(
        c,
        actor,
        state === 'done' ? 'automation.executed' : 'automation.' + state,
        run.rule_id,
        {
          eventId: run.event_id,
          orderId: o.id,
          runId: run.id,
          version: run.rule_version,
          reason,
          error,
        },
      );
  });
}
const DATABASE_CAUSES: Record<string, string> = {
  '57014': 'przekroczony limit czasu instrukcji',
  '40P01': 'zakleszczenie transakcji',
  '40001': 'konflikt serializacji transakcji',
  '55P03': 'blokada niedostępna',
  '53300': 'brak wolnych połączeń z bazą',
  '23503': 'naruszenie klucza obcego',
  '23505': 'naruszenie unikalności',
  '23514': 'naruszenie warunku CHECK',
};
/** jobs.error and automation_runs.error of a failed attempt. A Problem keeps its own message; any other error
 * records its cause (database SQLSTATE, or the error class and message) instead of the generic text alone. */
export function automationFailureMessage(e: unknown): string {
  if (e instanceof Problem) return e.message;
  const code = (e as { code?: unknown } | null)?.code;
  const cause =
    typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
      ? 'kod bazy ' + code + (DATABASE_CAUSES[code] ? ' — ' + DATABASE_CAUSES[code] : '')
      : e instanceof Error
        ? e.name + ': ' + e.message.slice(0, 200)
        : 'nieznana';
  return 'Błąd wykonania automatyzacji (przyczyna: ' + cause + ')';
}
export async function failAutomation(job: any, e: unknown) {
  const message = automationFailureMessage(e);
  return tenantTx(job.tenant_id, async (c) => {
    const changed = (
      await c.query(
        "UPDATE jobs SET state=CASE WHEN attempts>=max_attempts OR $4 THEN 'failed' ELSE 'pending' END,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+interval '10 seconds' WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING state",
        [
          job.id,
          job.lease_token,
          message,
          e instanceof Problem && [403, 404, 409, 422].includes(e.status),
        ],
      )
    ).rows[0];
    if (changed?.state === 'failed')
      await c.query(
        "UPDATE automation_runs SET state='failed',error=$2,finished_at=now() WHERE id=$1 AND job_id=$3",
        [job.payload.run_id, message, job.id],
      );
  });
}
export const AUTOMATION_LEASE_EXPIRY = '5 minutes';
const LEASE_EXPIRED =
  'Dzierżawa wykonania automatyzacji wygasła po 5 min bez zapisanego wyniku (proces zatrzymany lub zawieszony albo zapis błędu ' +
  'się nie powiódł); skutki reguły nie zostały zapisane, zadanie nie będzie ponowione';
/** Finishes, as failed with a cause, `automation` and `automation.run` jobs whose last attempt holds its lease longer
 * than AUTOMATION_LEASE_EXPIRY (process stopped or hung mid-job, or failAutomation itself failed). Never back to pending:
 * attempted work is not repeated. Safe against a job still in flight: its effects and its `done` commit in one
 * transaction that first re-checks state='running' AND lease_token FOR UPDATE, so a row locked by that transaction is
 * skipped here, and a job failed here before that check is then left without effects. */
export async function expireAutomationLeases(tenants: readonly string[] | null): Promise<{ jobs: number; runs: number }> {
  const r = await pool.query(
    `WITH stale AS (SELECT tenant_id,id FROM jobs WHERE kind IN ('automation','automation.run') AND state='running'
       AND attempts>=max_attempts AND lease_token IS NOT NULL AND locked_at<now()-$2::interval
       AND ($1::uuid[] IS NULL OR tenant_id=ANY($1::uuid[])) ORDER BY locked_at,id LIMIT 32 FOR UPDATE SKIP LOCKED),
     failed AS (UPDATE jobs j SET state='failed',error=$3,lease_token=NULL,locked_at=NULL FROM stale s
       WHERE (j.tenant_id,j.id)=(s.tenant_id,s.id) RETURNING j.tenant_id,j.id,j.kind,j.payload),
     runs AS (UPDATE automation_runs r SET state='failed',error=$3,finished_at=now() FROM failed f
       WHERE f.kind='automation.run' AND (r.tenant_id,r.id)=(f.tenant_id,(f.payload->>'run_id')::uuid) AND r.job_id=f.id AND r.state='queued' RETURNING r.id)
     SELECT (SELECT count(*)::int FROM failed) jobs,(SELECT count(*)::int FROM runs) runs`,
    [tenants === null ? null : [...tenants], AUTOMATION_LEASE_EXPIRY, LEASE_EXPIRED],
  );
  return { jobs: r.rows[0].jobs, runs: r.rows[0].runs };
}
