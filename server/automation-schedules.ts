import { freezeEmailActions, lockEmailQueue } from './email-actions';
import { freezeSmsActions } from './sms-actions';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, lockedOrder, type Actor } from './domain';
import { orderSnapshot } from './events';
import {
  isLocalFinancialVersion,
  localFinancialFencesAvailable,
  LOCAL_FINANCIAL_SELECTION_SQL,
} from './local-financial-policy';
import { matchesRule, type RuleInput } from './operation-schema';
import { applyOrderAction, previewAction } from './order-operations';
import { acquirePackingFieldAdmissionInTx } from './packing-order-field-requirements';
import { validateReferences } from './operation-routes';
import { type ScheduleInput } from './automation-schedule-schema';
export const scheduleHash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
export async function validateSchedule(c: PoolClient, input: ScheduleInput) {
  await validateReferences(c, {
    ...input,
    trigger: 'order.created',
    priority: 50,
    delay_seconds: 0,
  });
  if (input.frequency.kind === 'daily')
    ensure(
      (await c.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [input.frequency.timezone]))
        .rowCount,
      422,
      'Nieznana strefa czasowa',
    );
}
async function freeze(c: PoolClient, input: ScheduleInput) {
  const actions = [];
  for (const action of input.actions) {
    if (action.type !== 'set_workflow') {
      actions.push(action);
      continue;
    }
    const s = (
      await c.query('SELECT version,active FROM workflow_statuses WHERE id=$1 FOR SHARE', [
        action.status_id,
      ])
    ).rows[0];
    ensure(s?.active, 422, 'Własny status jest nieaktywny');
    ensure(
      !action.status_version || action.status_version === s.version,
      409,
      'Własny status zmienił się',
    );
    actions.push({ ...action, status_version: s.version });
  }
  return { ...input, actions: await freezeEmailActions(c, await freezeSmsActions(c, actions)) };
}
export async function enqueueSchedule(
  c: PoolClient,
  actor: Actor,
  schedule: any,
  clientKey: string,
  hash: string,
  scheduledFor?: string,
) {
  ensure(schedule.enabled, 409, 'Harmonogram jest wyłączony');
  ensure(
    !(
      await c.query(
        "SELECT id FROM automation_schedule_runs WHERE schedule_id=$1 AND state='queued'",
        [schedule.id],
      )
    ).rowCount,
    409,
    'Ten harmonogram ma już aktywne wykonanie',
  );
  ensure(
    (await c.query("SELECT count(*)::int AS n FROM jobs WHERE (state='pending' OR state='running')"))
      .rows[0].n < 1000,
    409,
    'Kolejka firmy jest pełna; spróbuj po jej przetworzeniu',
  );
  const input = await freeze(c, schedule.definition),
    id = randomUUID(),
    jobId = randomUUID();
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    jobId,
    actor.tenantId,
    'automation.schedule',
    JSON.stringify({ run_id: id }),
    'automation-schedule:' + id,
  ]);
  const result = (
    await c.query(
      `INSERT INTO automation_schedule_runs(id,tenant_id,schedule_id,schedule_version,definition_version,actor_id,definition,scheduled_for,job_id,client_key,request_hash)
    VALUES($1,$2,$3,$4,$11,$5,$6,coalesce($7::timestamptz,now()),$8,$9,$10) RETURNING *`,
      [
        id,
        actor.tenantId,
        schedule.id,
        schedule.version,
        schedule.actor_id,
        JSON.stringify(input),
        scheduledFor ?? null,
        jobId,
        clientKey,
        hash,
        schedule.definition_version,
      ],
    )
  ).rows[0];
  await audit(c, actor, 'automation.schedule.queue', schedule.id, {
    run_id: id,
    version: schedule.version,
  });
  return result;
}
export async function scheduleAutomationsDue() {
  const candidates = (
    await pool.query(`SELECT s.id,s.tenant_id,s.actor_id FROM automation_schedules s
    WHERE s.enabled AND s.next_at<=now() AND NOT EXISTS(SELECT 1 FROM automation_schedule_runs r
      WHERE (r.tenant_id,r.schedule_id)=(s.tenant_id,s.id) AND r.state='queued') ORDER BY s.next_at,s.id LIMIT 20`)
  ).rows;
  for (const candidate of candidates) {
    const member = (
      await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
        candidate.tenant_id,
        candidate.actor_id,
      ])
    ).rows[0];
    await tenantTx(candidate.tenant_id, async (c) => {
      const s = (
        await c.query(
          'SELECT *,next_at::text AS due_at FROM automation_schedules WHERE id=$1 AND enabled AND next_at<=now() FOR UPDATE SKIP LOCKED',
          [candidate.id],
        )
      ).rows[0];
      if (
        !s ||
        (
          await c.query(
            "SELECT id FROM automation_schedule_runs WHERE schedule_id=$1 AND state='queued'",
            [s.id],
          )
        ).rowCount
      )
        return;
      const actor: Actor = { tenantId: candidate.tenant_id, userId: s.actor_id, role: 'admin' };
      // Recheck the owner selected under the schedule lock; concurrent edits can replace the actor.
      if (s.actor_id !== candidate.actor_id) return;
      if (member?.role !== 'admin') {
        await c.query(
          "UPDATE automation_schedules SET enabled=false,definition=jsonb_set(definition,'{enabled}','false'),version=version+1,next_at=NULL,error='Autor utracił rolę administratora',updated_at=now() WHERE id=$1",
          [s.id],
        );
        await audit(c, actor, 'automation.schedule.suspended', s.id, {
          reason: 'Autor utracił rolę administratora',
        });
        return;
      }
      try {
        await c.query('SAVEPOINT schedule_enqueue');
        await enqueueSchedule(
          c,
          actor,
          s,
          randomUUID(),
          scheduleHash({ version: s.version, due_at: s.due_at }),
          s.due_at,
        );
        await c.query('RELEASE SAVEPOINT schedule_enqueue');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT schedule_enqueue');
        await c.query('RELEASE SAVEPOINT schedule_enqueue');
        if (!(e instanceof Problem)) throw e;
        // Backpressure and invalid references are visible and do not spin every worker tick.
        await audit(c, actor, 'automation.schedule.deferred', s.id, { error: e.message });
        await c.query(
          "UPDATE automation_schedules SET next_at=now()+interval '1 minute',error=$2 WHERE id=$1",
          [s.id, e.message],
        );
        return;
      }
      await c.query(
        "UPDATE automation_schedules SET error=NULL,next_at=automation_next_at(definition->'frequency',now()) WHERE id=$1",
        [s.id],
      );
    });
  }
}
export async function cancelScheduleRuns(c: PoolClient, scheduleId: string) {
  // Lock order matches processing: schedule -> job -> run -> orders.
  await c.query(
    `UPDATE jobs j SET state='failed',error='Harmonogram wyłączono lub zmieniono',lease_token=NULL,locked_at=NULL
    FROM automation_schedule_runs r WHERE j.id=r.job_id AND r.schedule_id=$1 AND r.state='queued' AND j.state IN ('pending','running')`,
    [scheduleId],
  );
  await c.query(
    "UPDATE automation_schedule_runs SET state='cancelled',error='Harmonogram wyłączono lub zmieniono',finished_at=now() WHERE schedule_id=$1 AND state='queued'",
    [scheduleId],
  );
}
export async function scheduleCandidates(c: PoolClient, run: any, limit = 25) {
  const input: ScheduleInput = run.definition;
  const localGuard = (await localFinancialFencesAvailable(c)) ? LOCAL_FINANCIAL_SELECTION_SQL : '';
  return (
    await c.query(
      `SELECT o.id,o.number,o.created_at::text AS cursor_at FROM orders o
    WHERE o.status=ANY($1::text[]) AND o.created_at<=$2::timestamptz-make_interval(secs=>$3)
    AND ($4::timestamptz IS NULL OR (o.created_at,o.id)>($4::timestamptz,$5::uuid))
    AND ($6::boolean OR NOT EXISTS(SELECT 1 FROM automation_schedule_receipts r
      WHERE (r.tenant_id,r.schedule_id,r.definition_version,r.order_id)=(o.tenant_id,$7::uuid,$8::bigint,o.id)))
    ${localGuard}
    ORDER BY o.created_at,o.id LIMIT $9`,
      [
        input.statuses,
        run.as_of_text ?? run.as_of,
        input.min_age_seconds,
        run.cursor_at_text ?? run.cursor_at ?? null,
        run.cursor_id ?? null,
        input.repetition === 'each_run',
        run.schedule_id,
        run.definition_version,
        limit,
      ],
    )
  ).rows;
}
const ruleOf = (s: ScheduleInput): RuleInput => ({
  ...s,
  trigger: 'order.created',
  priority: 50,
  delay_seconds: 0,
});
export async function previewSchedule(c: PoolClient, actor: Actor, s: any) {
  await acquirePackingFieldAdmissionInTx(c,actor);
  const definition = await freeze(c, s.definition);
  const asOf = (await c.query('SELECT now()::text AS at')).rows[0].at;
  const candidates = await scheduleCandidates(
    c,
    { definition, as_of: asOf, schedule_id: s.id, definition_version: s.definition_version },
    26,
  );
  const data = [];
  for (const o of candidates.slice(0, 25)) {
    await lockedOrder(c, o.id);
    const snapshot = await orderSnapshot(c, o.id);
    const matched = matchesRule(ruleOf(definition), snapshot);
    data.push({
      order_id: o.id,
      number: o.number,
      snapshot,
      matched,
      ...(matched
        ? await previewAction(c, actor, o.id, definition.actions)
        : { allowed: false, error: 'Warunki nie są spełnione' }),
    });
  }
  return {
    as_of: asOf,
    data,
    meta: { limit: 25, more_candidates: candidates.length > 25 },
    definition,
  };
}
export async function processSchedule(job: any) {
  const info = (
    await pool.query(
      'SELECT schedule_id,actor_id,definition FROM automation_schedule_runs WHERE id=$1 AND tenant_id=$2',
      [job.payload.run_id, job.tenant_id],
    )
  ).rows[0];
  ensure(info, 404, 'Nie znaleziono wykonania harmonogramu');
  return tenantTx(job.tenant_id, async (c) => {
    // Admission only; locked schedule/run and current IAM checks precede order effects.
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[`order-fields:${job.tenant_id}`]);
    if (info.definition.actions?.some((a: any) => a.type === 'email'))
      await lockEmailQueue(c, job.tenant_id);
    const s = (
      await c.query('SELECT * FROM automation_schedules WHERE id=$1 FOR UPDATE', [info.schedule_id])
    ).rows[0];
    if (
      !(
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rowCount
    )
      return;
    const r = (
      await c.query(
        'SELECT *,as_of::text AS as_of_text,cursor_at::text AS cursor_at_text FROM automation_schedule_runs WHERE id=$1 FOR UPDATE',
        [job.payload.run_id],
      )
    ).rows[0];
    ensure(r?.state === 'queued' && r.job_id === job.id, 409, 'Nieaktualne wykonanie harmonogramu');
    const actor: Actor = { tenantId: job.tenant_id, userId: r.actor_id, role: 'admin' };
    // The granted helper binds current IAM to this transaction's tenant GUC.
    // Its FOR SHARE membership lock lasts through native finalization/COMMIT;
    // an owner-pool role read before the transaction cannot provide that fence.
    const currentAdmin = (await c.query('SELECT public.offer_sync_is_admin($1) ok',[r.actor_id])).rows[0]?.ok===true;
    if (!s?.enabled || s.version !== r.schedule_version || s.definition_version !== r.definition_version || s.actor_id !== r.actor_id || !currentAdmin) {
      await c.query(
        "UPDATE automation_schedule_runs SET state='cancelled',error='Konfiguracja lub uprawnienia autora zmieniły się',finished_at=now() WHERE id=$1",
        [r.id],
      );
      await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
        job.id,
      ]);
      return;
    }
    if (
      (
        await c.query(
          "SELECT count(*)::int AS n FROM jobs WHERE (state='pending' OR state='running') AND id<>$1",
          [job.id],
        )
      ).rows[0].n >= 500
    ) {
      await c.query(
        "UPDATE jobs SET state='pending',attempts=0,run_at=now()+interval '10 seconds',error='Oczekiwanie na wolne miejsce w kolejce',lease_token=NULL,locked_at=NULL WHERE id=$1",
        [job.id],
      );
      return;
    }
    const input: ScheduleInput = r.definition,
      candidates = await scheduleCandidates(c, r, 26);
    const counts = { done: 0, skipped: 0, failed: 0 };
    for (const o of candidates.slice(0, 25)) {
      await lockedOrder(c, o.id);
      const snapshot = await orderSnapshot(c, o.id);
      let state: 'done' | 'skipped' | 'failed' = 'done',
        reason: string | null = null,
        results: unknown[] = [];
      const current = (
        await c.query(
          'SELECT status,created_at<=$2::timestamptz-make_interval(secs=>$3) AS old_enough FROM orders WHERE id=$1',
          [o.id, r.as_of_text, input.min_age_seconds],
        )
      ).rows[0];
      if (
        (await isLocalFinancialVersion(c, o.id)) ||
        !input.statuses.includes(current.status) ||
        !current.old_enough ||
        !matchesRule(ruleOf(input), snapshot)
      ) {
        state = 'skipped';
        reason = 'Warunki wykonania nie są spełnione';
      } else {
        await c.query('SAVEPOINT scheduled_actions');
        try {
          const context = {
            chain_id: 'schedule:' + r.id + ':' + o.id,
            depth: 1,
            trace: ['schedule:' + s.id],
          };
          for (const [action_index, action] of input.actions.entries())
            results.push(
              await applyOrderAction(c, actor, o.id, action, {
                ...context,
                operation: { kind: 'schedule', id: r.id, action_index },
              }),
            );
          await c.query('RELEASE SAVEPOINT scheduled_actions');
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT scheduled_actions');
          await c.query('RELEASE SAVEPOINT scheduled_actions');
          if (!(e instanceof Problem)) throw e;
          state = 'failed';
          reason = e.message;
          results = [];
        }
      }
      await c.query(
        `INSERT INTO automation_schedule_items(tenant_id,run_id,schedule_id,schedule_version,order_id,number,snapshot,state,result,error)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          job.tenant_id,
          r.id,
          s.id,
          r.schedule_version,
          o.id,
          o.number,
          JSON.stringify(snapshot),
          state,
          JSON.stringify({ actions: results }),
          reason,
        ],
      );
      if (state === 'done')
        await c.query(
          `INSERT INTO automation_schedule_receipts(tenant_id,schedule_id,definition_version,order_id,run_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [job.tenant_id, s.id, r.definition_version, o.id, r.id],
        );
      counts[state]++;
    }
    const last = candidates.slice(0, 25).at(-1),
      more = candidates.length > 25;
    await c.query(
      `UPDATE automation_schedule_runs SET scanned=scanned+$2,done=done+$3,skipped=skipped+$4,failed=failed+$5,
      cursor_at=coalesce($6::timestamptz,cursor_at),cursor_id=coalesce($7::uuid,cursor_id),state=$8,
      finished_at=CASE WHEN $8='done' THEN now() ELSE NULL END WHERE id=$1`,
      [
        r.id,
        counts.done + counts.skipped + counts.failed,
        counts.done,
        counts.skipped,
        counts.failed,
        last?.cursor_at ?? null,
        last?.id ?? null,
        more ? 'queued' : 'done',
      ],
    );
    await c.query(
      `UPDATE jobs SET state=$2,attempts=0,error=NULL,lease_token=NULL,locked_at=NULL,run_at=now()+interval '1 second' WHERE id=$1`,
      [job.id, more ? 'pending' : 'done'],
    );
    await audit(c, actor, 'automation.schedule.batch', s.id, { run_id: r.id, ...counts, more });
  });
}
export async function failSchedule(job: any, error: unknown) {
  return tenantTx(job.tenant_id, async (c) => {
    const state = (
      await c.query(
        `UPDATE jobs SET state=CASE WHEN attempts>=max_attempts OR $4 THEN 'failed' ELSE 'pending' END,
      error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+interval '10 seconds' WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING state`,
        [
          job.id,
          job.lease_token,
          error instanceof Problem ? error.message : 'Błąd harmonogramu',
          error instanceof Problem && [403, 404, 409, 422].includes(error.status),
        ],
      )
    ).rows[0]?.state;
    if (state === 'failed')
      await c.query(
        "UPDATE automation_schedule_runs SET state='failed',error=$2,finished_at=now() WHERE id=$1 AND state='queued'",
        [job.payload.run_id, error instanceof Problem ? error.message : 'Błąd harmonogramu'],
      );
  });
}
