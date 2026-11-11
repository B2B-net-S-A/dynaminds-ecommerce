import { isCustomerWorkflowAction } from './customer-message-workflow-schema';
import {queueAutomaticStockAction} from './automation-local-effects';
import {
  applyCustomerMessageWorkflowActionInTx,
  prepareCustomerMessageWorkflowActionsInTx,
} from './customer-message-workflows';
import { freezeEmailActions, queueEmailAction, lockEmailQueue } from './email-actions';
import { freezeSmsActions, queueSmsAction } from './sms-actions';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { acquirePackingFieldAdmissionInTx } from './packing-order-field-requirements';
import { lockedOrder, transition, audit, type Actor } from './domain';
import { event, type EventContext } from './events';
import { raiseCustomEventInTx } from './custom-events';
import { type OrderAction, orderAction } from './operation-schema';
export const workflowInput = z.object({
  name: z.string().trim().min(2).max(80),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#3455db'),
  stage: z.enum([
    'new',
    'paid',
    'picking',
    'packed',
    'shipped',
    'delivered',
    'completed',
    'cancelled',
    'return_initiated',
    'return_received',
    'return_completed',
  ]),
  active: z.boolean().default(true),
});
export async function applyOrderAction(
  c: PoolClient,
  a: Actor,
  id: string,
  action: OrderAction,
  context?: EventContext,
) {
  await acquirePackingFieldAdmissionInTx(c,a);
  if(action.type==='sync_local_woo_stock')return queueAutomaticStockAction(c,a,id,action,context);
  if (isCustomerWorkflowAction(action))
    return applyCustomerMessageWorkflowActionInTx(c, a, id, action, context);
  if (action.type === 'email') {
    await lockEmailQueue(c, a.tenantId);
    return queueEmailAction(c, a, id, action, context);
  }
  if (action.type === 'raise_event') {
    const r = await raiseCustomEventInTx(c, a, id, action.event_key, action.client_key, context);
    return { changed: !r.replayed, replayed: r.replayed, call_id: r.call.id, event_key: action.event_key };
  }
  const o = await lockedOrder(c, id);
  if (action.type === 'sms') return queueSmsAction(c, a, id, action, context);
  if (action.type === 'set_status') {
    if (o.status === action.status) return { changed: false, status: o.status };
    await transition(c, a, id, action.status, context);
  } else if (action.type === 'set_workflow') {
    const s = (
      await c.query('SELECT * FROM workflow_statuses WHERE id=$1 FOR SHARE', [action.status_id])
    ).rows[0];
    ensure(s?.active, 422, 'Własny status jest nieaktywny lub nie istnieje');
    ensure(
      !action.status_version || action.status_version === s.version,
      409,
      'Własny status zmienił się od przygotowania akcji',
    );
    if (o.workflow_status_id === s.id && o.status === s.stage)
      return { changed: false, status: o.status, workflow_status_id: s.id };
    if (o.status !== s.stage) await transition(c, a, id, s.stage, context);
    await c.query('UPDATE orders SET workflow_status_id=$2,updated_at=now() WHERE id=$1', [
      id,
      s.id,
    ]);
    await event(
      c,
      a.tenantId,
      id,
      'order.workflow_changed',
      { from: o.workflow_status_id, to: s.id, stage: s.stage },
      context,
    );
    await audit(c, a, 'order.workflow', id, {
      from: o.workflow_status_id,
      to: s.id,
      stage: s.stage,
    });
  } else if (action.type === 'add_note') {
    ensure(
      o.note.length + action.note.length + 1 <= 20000,
      422,
      'Notatki przekroczyły limit 20000 znaków',
    );
    await c.query(
      "UPDATE orders SET note=concat_ws(chr(10),nullif(note,''),$2::text),updated_at=now() WHERE id=$1",
      [id, action.note],
    );
    await event(c, a.tenantId, id, 'order.note_added', {}, context);
    await audit(c, a, 'order.note', id, { length: action.note.length });
  } else {
    const exists = o.tags.includes(action.tag);
    if (exists === (action.type === 'add_tag')) return { changed: false, tags: o.tags };
    ensure(
      action.type === 'remove_tag' || o.tags.length < 20,
      422,
      'Zamówienie może mieć do 20 tagów',
    );
    const tags =
      action.type === 'add_tag'
        ? [...o.tags, action.tag].sort()
        : o.tags.filter((t: string) => t !== action.tag);
    await c.query('UPDATE orders SET tags=$2,updated_at=now() WHERE id=$1', [id, tags]);
    await event(
      c,
      a.tenantId,
      id,
      'order.tags_changed',
      { tag: action.tag, operation: action.type },
      context,
    );
    await audit(c, a, 'order.tags', id, { tag: action.tag, operation: action.type });
  }
  const after = await lockedOrder(c, id);
  return {
    changed: true,
    status: after.status,
    workflow_status_id: after.workflow_status_id,
    tags: after.tags,
    version: after.version,
  };
}
export async function previewAction(
  c: PoolClient,
  a: Actor,
  id: string,
  actions: OrderAction[],
  customerMessagePreview = false,
) {
  await acquirePackingFieldAdmissionInTx(c,a);
  if (actions.some((a) => a.type === 'email')) await lockEmailQueue(c, a.tenantId);
  const orderVersion = (await lockedOrder(c, id)).version;
  await c.query('SAVEPOINT operation_preview');
  try {
    const frozen = await freezeEmailActions(c, await freezeSmsActions(c, actions));
    const result = [];
    if (frozen.some(isCustomerWorkflowAction)) {
      ensure(customerMessagePreview, 422, 'Akcje wiadomości wymagają podglądu reguły kupującego');
      await prepareCustomerMessageWorkflowActionsInTx(
        c,
        a,
        id,
        frozen.filter(isCustomerWorkflowAction),
        { chain_id: 'preview', depth: 0, trace: [], preview: true, customer_message_preview: true },
      );
    }
    for (const action of frozen)
      result.push(
        await applyOrderAction(
          c,
          a,
          id,
          action,
          ['sms', 'email', 'raise_event'].includes(action.type) || isCustomerWorkflowAction(action)
            ? {
                chain_id: 'preview',
                depth: 0,
                trace: [],
                preview: true,
                ...(customerMessagePreview ? { customer_message_preview: true as const } : {}),
              }
            : undefined,
        ),
      );
    await c.query('ROLLBACK TO SAVEPOINT operation_preview');
    await c.query('RELEASE SAVEPOINT operation_preview');
    return { allowed: true, result, order_version: orderVersion, actions: frozen };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT operation_preview');
    await c.query('RELEASE SAVEPOINT operation_preview');
    if (!(e instanceof Problem)) throw e;
    return { allowed: false, error: e.message };
  }
}
export async function previewBatch(a: Actor, ids: string[], action: OrderAction) {
  ensure(
    !isCustomerWorkflowAction(action),
    422,
    'Akcje wiadomości nie obsługują operacji masowych',
  );
  return tenantTx(a.tenantId, async (c) => {
    await acquirePackingFieldAdmissionInTx(c,a);
    if (action.type === 'email') await lockEmailQueue(c, a.tenantId);
    if (action.type === 'set_workflow') {
      const s = (
        await c.query('SELECT version FROM workflow_statuses WHERE id=$1 FOR SHARE', [
          action.status_id,
        ])
      ).rows[0];
      ensure(s, 422, 'Nie znaleziono własnego statusu');
      ensure(
        !action.status_version || action.status_version === s.version,
        409,
        'Własny status zmienił się; odśwież dane',
      );
      action = { ...action, status_version: s.version };
    }
    action = (await freezeEmailActions(c, await freezeSmsActions(c, [action])))[0];
    const ordered = [...ids].sort();
    // Lock all selected orders in one deterministic order; a foreign ID rejects the entire selection.
    const rows = (
      await c.query(
        'SELECT id,number,status,workflow_status_id,tags,version FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [ordered],
      )
    ).rows;
    ensure(
      rows.length === ordered.length,
      404,
      'Nie znaleziono wszystkich zamówień w tej organizacji',
    );
    const id = randomUUID();
    await c.query('INSERT INTO order_batches(id,tenant_id,actor_id,action) VALUES($1,$2,$3,$4)', [
      id,
      a.tenantId,
      a.userId,
      JSON.stringify(action),
    ]);
    const preview = [];
    for (const o of rows) {
      const result = await previewAction(c, a, o.id, [action]);
      await c.query(
        'INSERT INTO order_batch_items(tenant_id,batch_id,order_id,number,snapshot,preview) VALUES($1,$2,$3,$4,$5,$6)',
        [a.tenantId, id, o.id, o.number, JSON.stringify(o), JSON.stringify(result)],
      );
      preview.push({ order_id: o.id, number: o.number, before: o, ...result });
    }
    await audit(c, a, 'orders.batch.preview', id, { count: rows.length, type: action.type });
    return { id, state: 'preview', action, items: preview };
  });
}
export async function queueBatch(c: PoolClient, a: Actor, id: string, confirmed: boolean) {
  const b = (await c.query('SELECT * FROM order_batches WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(b, 404, 'Nie znaleziono operacji masowej');
  ensure(b.actor_id === a.userId, 403, 'Operację zatwierdza jej autor');
  if (['queued', 'done'].includes(b.state)) return { id, job_id: b.job_id };
  ensure(
    b.state === 'preview' && Date.now() - new Date(b.created_at).getTime() < 30 * 60 * 1000,
    409,
    'Przygotuj nowy podgląd operacji',
  );
  ensure(confirmed, 422, 'Potwierdź operację dla wybranych zamówień');
  const count = (
    await c.query(
      "SELECT count(*)::int AS n FROM order_batch_items WHERE batch_id=$1 AND (preview->>'allowed')::boolean",
      [id],
    )
  ).rows[0].n;
  ensure(count > 0, 409, 'Żadne zamówienie nie przechodzi podglądu');
  const job = randomUUID();
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    job,
    a.tenantId,
    'orders.batch',
    JSON.stringify({ batch_id: id, actor_id: a.userId }),
    'batch:' + id,
  ]);
  await c.query("UPDATE order_batches SET state='queued',job_id=$2,updated_at=now() WHERE id=$1", [
    id,
    job,
  ]);
  await audit(c, a, 'orders.batch.queue', id, { allowed: count });
  return { id, job_id: job };
}
export async function processBatch(job: any) {
  const membership = (
    await pool.query('SELECT role FROM memberships WHERE user_id=$1 AND tenant_id=$2', [
      job.payload.actor_id,
      job.tenant_id,
    ])
  ).rows[0];
  ensure(
    membership && ['admin', 'operator'].includes(membership.role),
    403,
    'Autor utracił prawo obsługi zamówień',
  );
  const a: Actor = { tenantId: job.tenant_id, userId: job.payload.actor_id, role: membership.role };
  return tenantTx(a.tenantId, async (c) => {
    await acquirePackingFieldAdmissionInTx(c,a);
    await lockEmailQueue(c, a.tenantId);
    const fence = (
      await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rowCount;
    if (!fence) return;
    const b = (
      await c.query('SELECT * FROM order_batches WHERE id=$1 FOR UPDATE', [job.payload.batch_id])
    ).rows[0];
    ensure(
      b?.state === 'queued' && b.job_id === job.id && b.actor_id === a.userId,
      409,
      'Nieaktualne zadanie masowe',
    );
    const rows = (
      await c.query(
        "SELECT * FROM order_batch_items WHERE batch_id=$1 AND state='pending' ORDER BY order_id LIMIT 10 FOR UPDATE",
        [b.id],
      )
    ).rows;
    const action = orderAction.parse(b.action);
    for (const row of rows) {
      let state = 'done',
        result: any = null,
        error: string | null = null;
      await c.query('SAVEPOINT batch_item');
      try {
        const o = await lockedOrder(c, row.order_id);
        if (!row.preview.allowed) {
          state = 'skipped';
          error = row.preview.error;
        } else if (o.version !== row.snapshot.version) {
          state = 'skipped';
          error = 'Zamówienie zmieniło się od podglądu';
        } else
          result = await applyOrderAction(
            c,
            a,
            row.order_id,
            action,
            ['sms', 'email', 'raise_event'].includes(action.type)
              ? {
                  chain_id: 'batch:' + b.id + ':' + row.order_id,
                  depth: 0,
                  trace: [],
                  operation: { kind: 'batch', id: b.id, action_index: 0 },
                }
              : undefined,
          );
        await c.query('RELEASE SAVEPOINT batch_item');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT batch_item');
        await c.query('RELEASE SAVEPOINT batch_item');
        if (!(e instanceof Problem)) throw e;
        state = 'failed';
        error = e.message;
      }
      await c.query(
        'UPDATE order_batch_items SET state=$3,result=$4,error=$5 WHERE batch_id=$1 AND order_id=$2',
        [b.id, row.order_id, state, result ? JSON.stringify(result) : null, error],
      );
    }
    const pending = (
      await c.query(
        "SELECT 1 FROM order_batch_items WHERE batch_id=$1 AND state='pending' LIMIT 1",
        [b.id],
      )
    ).rowCount;
    await c.query(
      'UPDATE jobs SET state=$2,attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now() WHERE id=$1',
      [job.id, pending ? 'pending' : 'done'],
    );
    if (!pending) {
      await c.query("UPDATE order_batches SET state='done',updated_at=now() WHERE id=$1", [b.id]);
      await audit(c, a, 'orders.batch.done', b.id);
    }
  });
}
export async function failBatch(job: any, e: unknown) {
  return tenantTx(job.tenant_id, async (c) => {
    const changed = (
      await c.query(
        "UPDATE jobs SET state=CASE WHEN $4 OR attempts>=max_attempts THEN 'failed' ELSE 'pending' END,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+interval '10 seconds' WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING state",
        [
          job.id,
          job.lease_token,
          e instanceof Problem ? e.message : 'Błąd operacji masowej',
          e instanceof Problem && [403, 404, 409, 422].includes(e.status),
        ],
      )
    ).rows[0];
    if (changed?.state === 'failed') {
      await c.query(
        "UPDATE order_batches SET state='failed',updated_at=now() WHERE id=$1 AND job_id=$2",
        [job.payload.batch_id, job.id],
      );
      await c.query(
        "UPDATE order_batch_items SET state='skipped',error=$2 WHERE batch_id=$1 AND state='pending'",
        [job.payload.batch_id, e instanceof Problem ? e.message : 'Przerwano po wyczerpaniu prób'],
      );
    }
  });
}
