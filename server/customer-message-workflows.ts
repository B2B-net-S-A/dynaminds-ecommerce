import { assertOrderMergeActiveInTx } from './order-merge-guards';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { orderSnapshot, type EventContext, localAutomationEvent } from './events';
import { appendCustomerOrderMessage } from './customer-messages';
import {
  customerWorkflowAction,
  isCustomerWorkflowAction,
  type CustomerWorkflowAction,
} from './customer-message-workflow-schema';
import { normalizedRule, ruleInput, type RuleInput } from './operation-schema';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value ?? null)))
    .digest('hex');
export const customerMessagePortalHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export async function customerMessageWorkflowAvailableInTx(c: PoolClient) {
  return Boolean(
    (
      await c.query(
        "SELECT to_regclass('public.customer_message_workflow_receipts') IS NOT NULL available",
      )
    ).rows[0].available,
  );
}
export async function customerMessageWorkflowRoleInTx(c: PoolClient, a: Actor) {
  ensure(a.userId, 403, 'Brak aktualnego użytkownika');
  const role = (await c.query('SELECT customer_message_workflow_role($1) role', [a.userId])).rows[0]
    ?.role;
  ensure(role, 403, 'Brak aktualnego dostępu do firmy');
  return role as 'admin' | 'operator' | 'viewer';
}
const staff = (role: string) =>
  ensure(['admin', 'operator'].includes(role), 403, 'Wymagany aktualny administrator lub operator');
export async function customerMessageWorkflowGrantsInTx(
  c: PoolClient,
  a: Actor,
  targets: (string | null)[],
  requireAdmin = false,
) {
  const roles = new Map<string, string>();
  for (const id of [
    ...new Set([a.userId, ...targets].filter((id): id is string => Boolean(id))),
  ].sort())
    roles.set(
      id,
      (await c.query('SELECT customer_message_workflow_role($1) role', [id])).rows[0]?.role,
    );
  const role = roles.get(a.userId!);
  ensure(role, 403, 'Brak aktualnego dostępu do firmy');
  staff(role);
  if (requireAdmin) ensure(role === 'admin', 403, 'Autor reguły utracił rolę administratora');
  for (const id of targets)
    if (id)
      ensure(
        ['admin', 'operator'].includes(roles.get(id) ?? ''),
        422,
        'Przypisywany użytkownik nie jest aktualnym administratorem lub operatorem tej firmy',
      );
  return role;
}
export async function receiveCustomerMessageWorkflowInTx(
  c: PoolClient,
  tenantId: string,
  orderId: string,
  threadId: string,
  messageId: string,
  portalToken: string,
) {
  if (!(await customerMessageWorkflowAvailableInTx(c))) return;
  const rules = (
    await c.query(
      "SELECT * FROM automation_rules WHERE enabled AND trigger='customer_message.received' ORDER BY priority,id LIMIT 100",
    )
  ).rows;
  if (!rules.length) return;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'customer-message-dispatch:' + tenantId,
  ]);
  ensure(
    (
      await c.query(
        "SELECT count(*)::int n FROM jobs WHERE (state='pending' OR state='running') AND (kind='automation' AND payload->>'trigger'='customer_message.received' OR kind='automation.run' AND EXISTS(SELECT 1 FROM automation_runs r WHERE r.job_id=jobs.id AND r.definition->>'trigger'='customer_message.received'))",
      )
    ).rows[0].n < 200,
    429,
    'Kolejka workflow wiadomości jest pełna; spróbuj później',
  );
  for (const r of rules)
    ensure(
      normalizedRule(r).actions.every(isCustomerWorkflowAction),
      422,
      'Reguła wiadomości zawiera niedozwoloną akcję',
    );
  const eventId = await localAutomationEvent(
    c,
    tenantId,
    orderId,
    'customer_message.received',
    rules,
  );
  await c.query(
    'INSERT INTO customer_message_workflow_receipts(tenant_id,order_id,thread_id,message_id,event_id,portal_token_hash) VALUES($1,$2,$3,$4,$5,$6)',
    [tenantId, orderId, threadId, messageId, eventId, customerMessagePortalHash(portalToken)],
  );
}
export async function prepareCustomerMessageWorkflowActionsInTx(
  c: PoolClient,
  a: Actor,
  orderId: string,
  actions: { type: string; assigned_user_id?: string | null }[],
  context?: EventContext,
) {
  ensure(
    await customerMessageWorkflowAvailableInTx(c),
    503,
    'Kopia nie zawiera workflow wiadomości',
  );
  ensure(
    context?.operation?.kind === 'rule' ||
      (context?.preview === true && context.customer_message_preview === true),
    422,
    'Akcje wiadomości wymagają kontekstu reguły kupującego',
  );
  const order = (
    await c.query(
      'SELECT id,portal_token,portal_enabled,portal_expires_at FROM orders WHERE id=$1 FOR UPDATE',
      [orderId],
    )
  ).rows[0];
  ensure(order, 404, 'Nie znaleziono zamówienia');
  await assertOrderMergeActiveInTx(c, orderId);
  const thread = (
    await c.query('SELECT * FROM customer_message_threads WHERE order_id=$1 FOR UPDATE', [orderId])
  ).rows[0];
  ensure(thread, 404, 'Nie znaleziono rozmowy');
  if (!context?.preview) {
    const run = (
      await c.query(
        'SELECT r.id,r.order_id,r.event_id,r.definition,e.kind FROM automation_runs r JOIN order_events e ON (e.tenant_id,e.id)=(r.tenant_id,r.event_id) WHERE r.id=$1',
        [context!.operation!.id],
      )
    ).rows[0];
    ensure(
      run?.order_id === orderId &&
        run.kind === 'customer_message.received' &&
        run.definition.actor_id === a.userId,
      409,
      'Akcja nie jest związana z własną regułą wiadomości',
    );
    const receipt = (
      await c.query(
        'SELECT portal_token_hash,thread_id FROM customer_message_workflow_receipts WHERE event_id=$1 AND order_id=$2',
        [run.event_id, orderId],
      )
    ).rows[0];
    ensure(
      receipt?.thread_id === thread.id,
      409,
      'Brak trwałej wiadomości kupującego dla tej reguły',
    );
    if (actions.some((x) => x.type === 'customer_message_reply')) {
      ensure(
        order.portal_enabled &&
          (!order.portal_expires_at || order.portal_expires_at > new Date()) &&
          customerMessagePortalHash(order.portal_token) === receipt.portal_token_hash,
        409,
        'Link kupującego zmienił się, został wyłączony lub wygasł',
      );
    }
  } else if (actions.some((x) => x.type === 'customer_message_reply'))
    ensure(
      order.portal_enabled && (!order.portal_expires_at || order.portal_expires_at > new Date()),
      409,
      'Link kupującego jest wyłączony lub wygasł',
    );
  const targets = actions
    .filter((x) => x.type === 'customer_message_assign')
    .map((x) => x.assigned_user_id ?? null);
  await customerMessageWorkflowGrantsInTx(c, a, targets, true);
  return { order, thread };
}
const operationKey = (context: EventContext) => {
  const bytes = createHash('sha256')
    .update(JSON.stringify(canonical(context.operation)))
    .digest();
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export async function applyCustomerMessageWorkflowActionInTx(
  c: PoolClient,
  a: Actor,
  orderId: string,
  input: CustomerWorkflowAction,
  context?: EventContext,
) {
  const action = customerWorkflowAction.parse(input);
  const { thread } = await prepareCustomerMessageWorkflowActionsInTx(
    c,
    a,
    orderId,
    [action],
    context,
  );
  const op = context?.operation;
  if (op && !context?.preview) {
    const r = (
      await c.query('SELECT definition,state FROM automation_runs WHERE id=$1 AND order_id=$2', [
        op.id,
        orderId,
      ])
    ).rows[0];
    ensure(
      r?.state === 'queued' &&
        op.action_index >= 0 &&
        op.action_index < 5 &&
        hash(r.definition.actions?.[op.action_index]) === hash(action),
      409,
      'Akcja lub pozycja nie odpowiada zamrożonej definicji reguły',
    );
  }
  const requestHash = hash({ action, actor_id: a.userId, order_id: orderId });
  if (op && !context?.preview) {
    const old = (
      await c.query(
        'SELECT request_hash,result FROM customer_message_workflow_actions WHERE run_id=$1 AND action_index=$2',
        [op.id, op.action_index],
      )
    ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Akcję wykonano dla innych danych');
      return { ...old.result, reused: true };
    }
  }
  let result: any;
  if (action.type === 'customer_message_reply' || action.type === 'customer_message_note') {
    const value = await appendCustomerOrderMessage(
      c,
      a,
      orderId,
      action.type === 'customer_message_reply' ? 'reply' : 'note',
      { client_key: op ? operationKey(context!) : randomUUID(), body: action.body },
    );
    result = {
      changed: !value.reused,
      delivery: action.type === 'customer_message_reply' ? 'local_portal' : 'private_note',
      message_id: value.message.id,
      reused: value.reused,
    };
  } else if (action.type === 'customer_message_assign') {
    const changed = thread.assigned_user_id !== action.assigned_user_id;
    if (changed) {
      await c.query(
        'UPDATE customer_message_threads SET assigned_user_id=$2,version=version+1,updated_at=now(),last_message_at=now() WHERE id=$1',
        [thread.id, action.assigned_user_id],
      );
      await audit(c, a, 'customer.message.assignment', thread.id, {
        assigned_user_id: action.assigned_user_id,
      });
    }
    result = { changed, assigned_user_id: action.assigned_user_id };
  } else {
    const changed = thread.status !== action.status;
    if (changed) {
      await c.query(
        'UPDATE customer_message_threads SET status=$2,version=version+1,status_changed_at=now(),updated_at=now(),last_message_at=now() WHERE id=$1',
        [thread.id, action.status],
      );
      await audit(c, a, 'customer.message.status', thread.id, { status: action.status });
    }
    result = { changed, status: action.status };
  }
  if (op && !context?.preview)
    await c.query(
      'INSERT INTO customer_message_workflow_actions(tenant_id,run_id,action_index,order_id,thread_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [a.tenantId, op.id, op.action_index, orderId, thread.id, requestHash, JSON.stringify(result)],
    );
  return result;
}
export const customerWorkflowFlags = (role: string | null) => ({
  current_role: role,
  can_read: ['admin', 'operator'].includes(role ?? ''),
  can_admin: role === 'admin',
});
const workflowRule = (r: any) => ({
  id: r.id,
  name: r.name,
  trigger: r.trigger,
  enabled: r.enabled,
  priority: r.priority,
  delay_seconds: r.delay_seconds,
  version: r.version,
  actor_id: r.actor_id,
  updated_at: r.updated_at,
  definition: normalizedRule(r),
});
export async function customerMessageWorkflowMetadata(a: Actor) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await customerMessageWorkflowRoleInTx(c, a);
    return {
      ...customerWorkflowFlags(role),
      trigger: 'customer_message.received',
      actions: [
        'customer_message_reply',
        'customer_message_note',
        'customer_message_assign',
        'customer_message_status',
      ],
      limits: { rules: 100, actions: 5, thread_messages: 1000, page: 20 },
    };
  });
}
const pageCursor = (r: any) =>
  Buffer.from(JSON.stringify([r.cursor_time, r.id])).toString('base64url');
function pageAfter(cursor?: string) {
  if (!cursor) return null;
  try {
    return z
      .tuple([z.iso.datetime(), z.uuid()])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
  } catch {
    throw new Problem(422, 'Nieprawidłowy kursor workflow');
  }
}
export async function customerMessageWorkflowRules(a: Actor, cursor?: string) {
  const after = pageAfter(cursor);
  const params: any[] = after ? [...after] : [];
  return tenantTx(a.tenantId, async (c) => {
    const role = await customerMessageWorkflowRoleInTx(c, a);
    staff(role);
    const rows = (
      await c.query(
        `SELECT *,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM automation_rules WHERE trigger='customer_message.received' ${after ? 'AND (updated_at,id)<($1::timestamptz,$2::uuid)' : ''} ORDER BY updated_at DESC,id DESC LIMIT 21`,
        params,
      )
    ).rows;
    return {
      ...customerWorkflowFlags(role),
      data: rows.slice(0, 20).map(workflowRule),
      meta: { cursor: rows.length > 20 ? pageCursor(rows[19]) : null },
    };
  });
}
export async function saveCustomerMessageWorkflowRule(a: Actor, id: string | null, raw: any) {
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['rules:' + a.tenantId]);
    const old = id
      ? (await c.query('SELECT * FROM automation_rules WHERE id=$1 FOR UPDATE', [id])).rows[0]
      : null;
    if (id)
      ensure(
        old?.trigger === 'customer_message.received',
        404,
        'Nie znaleziono workflow wiadomości',
      );
    const targetActions = raw.actions ?? old?.config.actions ?? [];
    const role = await customerMessageWorkflowGrantsInTx(
      c,
      a,
      targetActions
        .filter((x: any) => x.type === 'customer_message_assign')
        .map((x: any) => x.assigned_user_id),
      true,
    );
    const requestHash = hash({ id, request: raw }),
      previous = (
        await c.query('SELECT * FROM customer_message_workflow_requests WHERE client_key=$1', [
          raw.client_key,
        ])
      ).rows[0];
    if (previous) {
      ensure(
        previous.actor_id === a.userId && previous.request_hash === requestHash,
        409,
        'Klucz workflow wykorzystano dla innych danych',
      );
      return { ...customerWorkflowFlags(role), rule: previous.response, reused: true };
    }
    ensure(
      (await c.query('SELECT count(*)::int n FROM customer_message_workflow_requests')).rows[0].n <
        5000,
      429,
      'Limit5000 zapisów konfiguracji workflow',
    );
    if (id) ensure(old.version === raw.version, 409, 'Reguła zmieniła się; odśwież dane');
    else
      ensure(
        (await c.query('SELECT count(*)::int n FROM automation_rules')).rows[0].n < 100,
        422,
        'Limit100 reguł',
      );
    const input = ruleInput.parse(
      raw.actions ? raw : { ...normalizedRule(old), enabled: raw.enabled },
    );
    for (const v of input.conditions)
      if (v.field === 'warehouse_id' || v.field === 'workflow_status_id')
        ensure(
          (
            await c.query(
              v.field === 'warehouse_id'
                ? 'SELECT id FROM warehouses WHERE id=$1'
                : 'SELECT id FROM workflow_statuses WHERE id=$1',
              [v.value],
            )
          ).rowCount,
          422,
          'Warunek wskazuje dane spoza firmy',
        );
    ensure(
      input.trigger === 'customer_message.received' &&
        input.actions.every(isCustomerWorkflowAction),
      422,
      'Panel workflow obsługuje wyłącznie lokalne akcje wiadomości',
    );
    const args = [
      input.name,
      JSON.stringify({ match: input.match, conditions: input.conditions, actions: input.actions }),
      input.enabled,
      input.priority,
      input.delay_seconds,
      a.userId,
    ];
    const row = id
      ? (
          await c.query(
            'UPDATE automation_rules SET name=$2,config=$3,enabled=$4,priority=$5,delay_seconds=$6,actor_id=$7,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
            [id, ...args],
          )
        ).rows[0]
      : (
          await c.query(
            "INSERT INTO automation_rules(id,tenant_id,name,trigger,action,config,enabled,priority,delay_seconds,actor_id) VALUES($1,$2,$3,'customer_message.received','actions',$4,$5,$6,$7,$8) RETURNING *",
            [randomUUID(), a.tenantId, ...args],
          )
        ).rows[0];
    const response = workflowRule(row);
    await c.query(
      'INSERT INTO customer_message_workflow_requests(tenant_id,client_key,actor_id,rule_id,request_hash,response) VALUES($1,$2,$3,$4,$5,$6)',
      [a.tenantId, raw.client_key, a.userId, row.id, requestHash, JSON.stringify(response)],
    );
    await audit(c, a, id ? 'customer.workflow.update' : 'customer.workflow.create', row.id, {
      version: row.version,
    });
    return { ...customerWorkflowFlags(role), rule: response, reused: false };
  });
}
export async function customerMessageWorkflowRuns(
  a: Actor,
  q: { cursor?: string; order_id?: string },
  id?: string,
) {
  const after = pageAfter(q.cursor);
  return tenantTx(a.tenantId, async (c) => {
    const role = await customerMessageWorkflowRoleInTx(c, a);
    staff(role);
    const rows = (
      await c.query(
        `SELECT r.*,o.number,r.definition->>'name' rule_name,t.id thread_id,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM automation_runs r JOIN order_events e ON (e.tenant_id,e.id)=(r.tenant_id,r.event_id) JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id) JOIN customer_message_threads t ON (t.tenant_id,t.order_id)=(r.tenant_id,r.order_id) WHERE e.kind='customer_message.received' AND ($1::uuid IS NULL OR r.order_id=$1) AND ($2::uuid IS NULL OR r.id=$2) ${after ? 'AND (r.created_at,r.id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY r.created_at DESC,r.id DESC LIMIT 21`,
        [q.order_id ?? null, id ?? null, ...(after ?? [])],
      )
    ).rows;
    const head = (r: any) => ({
      id: r.id,
      rule_id: r.rule_id,
      rule_version: r.rule_version,
      order_id: r.order_id,
      number: r.number,
      rule_name: r.rule_name,
      state: r.state,
      created_at: r.created_at,
      finished_at: r.finished_at,
      error: r.error,
      result: r.result,
    });
    if (id) {
      ensure(rows[0], 404, 'Nie znaleziono wykonania workflow');
      return {
        ...customerWorkflowFlags(role),
        run: { ...head(rows[0]), definition: rows[0].definition },
        thread_id: rows[0].thread_id,
      };
    }
    return {
      ...customerWorkflowFlags(role),
      data: rows.slice(0, 20).map(head),
      meta: { cursor: rows.length > 20 ? pageCursor(rows[19]) : null },
    };
  });
}
