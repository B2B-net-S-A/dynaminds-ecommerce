import { isCustomerWorkflowAction } from './customer-message-workflow-schema';
import {
  customerMessageWorkflowAvailableInTx,
  customerMessageWorkflowGrantsInTx,
  customerMessageWorkflowRoleInTx,
} from './customer-message-workflows';
import { freezeEmailActions, lockEmailQueue } from './email-actions';
import { freezeSmsActions } from './sms-actions';
import {validateAutomaticEffectsInTx,readAutomaticEffects} from './automation-local-effects';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tenantTx, tenantReadTx } from './db';
import { ensure } from './errors';
import { audit,type Actor } from './domain';
import { orderSnapshot } from './events';
import { validateCustomEventReferencesInTx } from './custom-events';
import { registerCustomEventRoutes } from './custom-event-routes';
import { registerAutomationV2Routes } from './automation-v2-routes';
import { setWorkflowCategoryInTx, workflowCategoriesAvailable, workflowCategoryInput, workflowStatusSelectSql } from './workflow-status-categories';
import {
  orderAction,
  automationRuleInput,
  normalizedRule,
  matchesRule,
  matchesCondition,
  matchesItem,
  conditionLeaves,
  type AutomationRuleInput,
} from './operation-schema';
import {
  workflowInput,
  applyOrderAction,
  previewAction,
  previewBatch,
  queueBatch,
} from './order-operations';
export async function validateReferences(c: PoolClient, b: AutomationRuleInput,actor?:Actor) {
  await validateCustomEventReferencesInTx(c, b);
  for(const action of b.actions)if(action.type==='sync_local_woo_stock'){
    ensure(actor?.role==='admin'&&actor.userId,422,'Synchronizacja stanu wymaga reguły własnego administratora');
    await validateAutomaticEffectsInTx(c,actor.tenantId,actor.userId,[action]);
  }
  if (b.trigger === 'customer_message.received' || b.actions.some(isCustomerWorkflowAction))
    ensure(
      await customerMessageWorkflowAvailableInTx(c),
      503,
      'Kopia nie zawiera workflow wiadomości',
    );
  ensure(
    (!b.actions.some(isCustomerWorkflowAction) || b.trigger === 'customer_message.received') &&
      (b.trigger !== 'customer_message.received' || b.actions.every(isCustomerWorkflowAction)),
    422,
    'Akcje wiadomości wymagają reguły kupującego',
  );
  if (b.actions.some((a) => a.type === 'email')) {
    ensure(
      (
        await c.query(
          "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.email_batches') AND attname='automation_run_id' AND NOT attisdropped) available",
        )
      ).rows[0].available,
      404,
      'Akcje email niedostępne w tym schemacie',
    );
    for (const a of b.actions)
      if (a.type === 'email') {
        ensure(
          (
            await c.query(
              'SELECT id FROM email_templates WHERE id=$1 AND ($2::boolean=false OR active)',
              [a.template_id, b.enabled],
            )
          ).rowCount,
          422,
          'Szablon email jest nieaktywny lub spoza organizacji',
        );
        if (a.channel_id)
          ensure(
            (
              await c.query("SELECT id FROM channels WHERE id=$1 AND provider='smtp'", [
                a.channel_id,
              ])
            ).rowCount,
            422,
            'Konto SMTP jest spoza organizacji',
          );
      }
  }
  for (const a of b.actions)
    if (a.type === 'sms') {
      ensure(
        (
          await c.query(
            'SELECT id FROM sms_templates WHERE id=$1 AND ($2::boolean=false OR active)',
            [a.template_id, b.enabled],
          )
        ).rowCount,
        422,
        'Szablon SMS jest nieaktywny lub spoza organizacji',
      );
      if (a.channel_id)
        ensure(
          (
            await c.query(
              "SELECT id FROM channels WHERE id=$1 AND provider='smsapi' AND mode='sandbox'",
              [a.channel_id],
            )
          ).rowCount,
          422,
          'Kanał SMSAPI jest spoza organizacji',
        );
    }
  await freezeEmailActions(c, await freezeSmsActions(c, b.actions, b.enabled), b.enabled);
  for (const a of b.actions)
    if (a.type === 'set_workflow')
      ensure(
        (
          await c.query(
            'SELECT id FROM workflow_statuses WHERE id=$1 AND ($2::boolean=false OR active)',
            [a.status_id, b.enabled],
          )
        ).rowCount,
        422,
        'Nie znaleziono aktywnego własnego statusu',
      );
  for (const v of conditionLeaves(b))
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
        'Warunek wskazuje dane spoza organizacji',
      );
}
// Read-only explanation of one rule: condition results on the given snapshot,
// the events its actions would emit and the enabled rules listening to them.
// Dependent rules are one level deep; their conditions really run later on the
// event snapshot, so `estimate` only evaluates them on the current one.
async function previewChain(c: PoolClient, ruleId: string, r: AutomationRuleInput, s: any, matched: boolean) {
  const stages = new Map<string, string>();
  for (const a of r.actions)
    if (a.type === 'set_workflow')
      stages.set(
        a.status_id,
        (await c.query('SELECT stage FROM workflow_statuses WHERE id=$1', [a.status_id])).rows[0]?.stage,
      );
  const emits = (a: AutomationRuleInput['actions'][number]): string[] =>
    a.type === 'set_status'
      ? ['order.' + a.status]
      : a.type === 'set_workflow'
        ? [
            ...(stages.get(a.status_id) && stages.get(a.status_id) !== s.status
              ? ['order.' + stages.get(a.status_id)]
              : []),
            'order.workflow_changed',
          ]
        : a.type === 'raise_event'
          ? ['custom.' + a.event_key]
          : a.type === 'add_note'
          ? ['order.note_added']
          : (a.type === 'add_tag' || a.type === 'remove_tag') &&
              s.tags.includes(a.tag) !== (a.type === 'add_tag')
            ? ['order.tags_changed']
            : [];
  const listeners = async (trigger: string) =>
    (
      await c.query(
        'SELECT * FROM automation_rules WHERE enabled AND trigger=$1 ORDER BY priority,id LIMIT 100',
        [trigger],
      )
    ).rows.map((d) => ({
      id: d.id,
      name: d.name,
      priority: d.priority,
      delay_seconds: d.delay_seconds,
      self: d.id === ruleId,
      estimate: matchesRule(normalizedRule(d), s),
    }));
  const actions = [];
  for (const a of r.actions) {
    const emitted = [];
    for (const trigger of emits(a)) {
      const rules = await listeners(trigger);
      // The worker skips a rule already in the chain trace (automations.ts).
      emitted.push({ trigger, rules: rules.filter((d) => !d.self), skips_self: rules.some((d) => d.self) });
    }
    actions.push({ type: a.type, emits: emitted });
  }
  return {
    trigger: r.trigger,
    match: r.match,
    matched,
    delay_seconds: r.delay_seconds,
    depth_limit: 8,
    conditions: r.conditions.map((v) =>
      'group' in v
        ? {
            group: {
              match: v.group.match,
              matched: matchesItem(v, s),
              conditions: v.group.conditions.map((l) => ({ ...l, matched: matchesCondition(l, s) })),
            },
          }
        : { ...v, matched: matchesCondition(v, s) },
    ),
    actions,
  };
}
export function registerOperationRoutes(app: FastifyInstance) {
  registerCustomEventRoutes(app);
  registerAutomationV2Routes(app);
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const write = (req: any, admin = false) =>
    ensure(
      admin ? req.actor.role === 'admin' : ['admin', 'operator'].includes(req.actor.role),
      403,
      admin ? 'Wymagana rola administratora' : 'Brak prawa obsługi zamówień',
    );
  const page = z.object({ after: z.uuid().optional() });
  app.get('/api/workflow-statuses', (req) =>
    tenantReadTx(req.actor.tenantId, async (c) => ({
      data: (await c.query(workflowStatusSelectSql(await workflowCategoriesAvailable(c)) + ' ORDER BY w.stage,w.name,w.id')).rows,
    })),
  );
  app.post('/api/workflow-statuses', (req) => {
    write(req, true);
    const b = workflowInput.parse(req.body);
    const { category } = workflowCategoryInput.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'workflow:' + req.actor.tenantId,
      ]);
      ensure(
        (await c.query('SELECT count(*)::int AS n FROM workflow_statuses')).rows[0].n < 100,
        422,
        'Limit 100 własnych statusów',
      );
      const r = (
        await c.query(
          'INSERT INTO workflow_statuses(id,tenant_id,name,color,stage,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [randomUUID(), req.actor.tenantId, b.name, b.color, b.stage, b.active],
        )
      ).rows[0];
      const stored = await setWorkflowCategoryInTx(c, req.actor.tenantId, r.id, category);
      await audit(c, req.actor, 'workflow.create', r.id, category ? { category } : undefined);
      return { ...r, category: stored };
    });
  });
  app.patch('/api/workflow-statuses/:id', (req) => {
    write(req, true);
    const b = workflowInput.extend({ version: z.string().regex(/^\d+$/) }).parse(req.body);
    const { category } = workflowCategoryInput.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      const r = (
        await c.query('SELECT * FROM workflow_statuses WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(r, 404, 'Nie znaleziono statusu');
      ensure(r.version === b.version, 409, 'Status zmienił się, odśwież dane');
      if (r.stage !== b.stage)
        ensure(
          !(await c.query('SELECT id FROM orders WHERE workflow_status_id=$1 LIMIT 1', [r.id]))
            .rowCount,
          409,
          'Nie zmieniaj etapu statusu używanego w zamówieniach',
        );
      const result = (
        await c.query(
          'UPDATE workflow_statuses SET name=$2,color=$3,stage=$4,active=$5,version=version+1 WHERE id=$1 RETURNING *',
          [r.id, b.name, b.color, b.stage, b.active],
        )
      ).rows[0];
      const stored = await setWorkflowCategoryInTx(c, req.actor.tenantId, r.id, category);
      await audit(c, req.actor, 'workflow.update', r.id, { active: b.active, stage: b.stage, ...(category ? { category } : {}) });
      return { ...result, category: stored };
    });
  });
  app.post('/api/orders/:id/operations', (req) => {
    write(req);
    const action = orderAction.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) =>
      applyOrderAction(c, req.actor, id(req.params), action),
    );
  });
  app.post('/api/orders/:id/operations/preview', (req) => {
    write(req);
    const action = orderAction.parse(req.body);
    return tenantTx(req.actor.tenantId, (c) =>
      previewAction(c, req.actor, id(req.params), [action]),
    );
  });
  app.get('/api/automations', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const priv = ['admin', 'operator'].includes(
        (await customerMessageWorkflowAvailableInTx(c))
          ? await customerMessageWorkflowRoleInTx(c, req.actor)
          : req.actor.role,
      );
      return {
        data: (await c.query("SELECT * FROM automation_rules WHERE trigger NOT LIKE 'v2:%' ORDER BY priority,name,id")).rows.map(
          (r) =>
            r.trigger === 'customer_message.received' && !priv
              ? {
                  id: r.id,
                  name: r.name,
                  trigger: r.trigger,
                  enabled: r.enabled,
                  priority: r.priority,
                  version: r.version,
                  redacted: true,
                }
              : { ...r, definition: normalizedRule(r) },
        ),
        jobs: (await c.query('SELECT state,count(*)::int AS count FROM jobs GROUP BY state')).rows,
      };
    }),
  );
  app.post('/api/automations', (req) => {
    write(req, true);
    const raw = req.body as any;
    const b = automationRuleInput.parse(
      raw?.actions ? raw : { ...raw, actions: [{ type: 'add_note', note: raw?.note }] },
    );
    return tenantTx(req.actor.tenantId, async (c) => {
      await lockEmailQueue(c, req.actor.tenantId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'rules:' + req.actor.tenantId,
      ]);
      ensure(
        (await c.query('SELECT count(*)::int AS n FROM automation_rules')).rows[0].n < 100,
        422,
        'Limit 100 reguł',
      );
      await validateReferences(c, b,req.actor);
      if (b.trigger === 'customer_message.received')
        await customerMessageWorkflowGrantsInTx(
          c,
          req.actor,
          b.actions
            .filter(isCustomerWorkflowAction)
            .filter((a) => a.type === 'customer_message_assign')
            .map((a) => a.assigned_user_id),
          true,
        );
      const r = (
        await c.query(
          "INSERT INTO automation_rules(id,tenant_id,name,trigger,action,config,enabled,priority,delay_seconds,actor_id) VALUES($1,$2,$3,$4,'actions',$5,$6,$7,$8,$9) RETURNING *",
          [
            randomUUID(),
            req.actor.tenantId,
            b.name,
            b.trigger,
            JSON.stringify({ match: b.match, conditions: b.conditions, actions: b.actions }),
            b.enabled,
            b.priority,
            b.delay_seconds,
            req.actor.userId,
          ],
        )
      ).rows[0];
      await audit(c, req.actor, 'automation.create', r.id);
      return r;
    });
  });
  app.patch('/api/automations/:id', (req) => {
    write(req, true);
    const raw = req.body as any;
    const toggle = z
      .object({ enabled: z.boolean(), version: z.string().regex(/^\d+$/).optional() })
      .strict()
      .safeParse(raw);
    const full = toggle.success
      ? null
      : automationRuleInput.safeExtend({ version: z.string().regex(/^\d+$/) }).parse(raw);
    return tenantTx(req.actor.tenantId, async (c) => {
      await lockEmailQueue(c, req.actor.tenantId);
      const r = (
        await c.query('SELECT * FROM automation_rules WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(r, 404, 'Nie znaleziono reguły');
      const version = full?.version ?? (toggle.success ? toggle.data.version : undefined);
      if (version) ensure(version === r.version, 409, 'Reguła zmieniła się, odśwież dane');
      const b = full ?? { ...normalizedRule(r), enabled: toggle.success && toggle.data.enabled };
      if (!toggle.success || b.enabled) await validateReferences(c, b,req.actor);
      if (b.trigger === 'customer_message.received')
        await customerMessageWorkflowGrantsInTx(
          c,
          req.actor,
          b.actions
            .filter(isCustomerWorkflowAction)
            .filter((a) => a.type === 'customer_message_assign')
            .map((a) => a.assigned_user_id),
          true,
        );
      const result = (
        await c.query(
          "UPDATE automation_rules SET name=$2,trigger=$3,action='actions',config=$4,enabled=$5,priority=$6,delay_seconds=$7,version=version+1,actor_id=$8,updated_at=now() WHERE id=$1 RETURNING *",
          [
            r.id,
            b.name,
            b.trigger,
            JSON.stringify({ match: b.match, conditions: b.conditions, actions: b.actions }),
            b.enabled,
            b.priority,
            b.delay_seconds,
            req.actor.userId,
          ],
        )
      ).rows[0];
      await audit(c, req.actor, 'automation.update', r.id, {
        enabled: b.enabled,
        version: result.version,
      });
      return result;
    });
  });
  app.post('/api/automations/:id/preview', (req) => {
    write(req, true);
    const b = z.object({ order_id: z.uuid() }).parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await lockEmailQueue(c, req.actor.tenantId);
      const row = (await c.query('SELECT * FROM automation_rules WHERE id=$1', [id(req.params)]))
        .rows[0];
      ensure(row, 404, 'Nie znaleziono reguły');
      const s = await orderSnapshot(c, b.order_id);
      ensure(s, 404, 'Nie znaleziono zamówienia');
      const r = normalizedRule(row),
        matched = matchesRule(r, s);
      return {
        snapshot: s,
        matched,
        chain: await previewChain(c, row.id, r, s, matched),
        ...(matched
          ? await previewAction(
              c,
              req.actor,
              b.order_id,
              r.actions,
              r.trigger === 'customer_message.received',
            )
          : { allowed: false, error: 'Warunki nie są spełnione' }),
      };
    });
  });
  app.get('/api/automation-runs', (req) => {
    const q = page.parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          "SELECT r.*,o.number,r.definition->>'name' AS rule_name FROM automation_runs r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id) WHERE (r.definition->>'engine') IS DISTINCT FROM 'v2' AND ($1::uuid IS NULL OR (r.created_at,r.id)<(SELECT created_at,id FROM automation_runs WHERE id=$1)) ORDER BY r.created_at DESC,r.id DESC LIMIT 26",
          [q.after ?? null],
        )
      ).rows;
      const effects=await readAutomaticEffects(c,rows.slice(0,25).map((r:any)=>r.id));
      const priv = ['admin', 'operator'].includes(
        (await customerMessageWorkflowAvailableInTx(c))
          ? await customerMessageWorkflowRoleInTx(c, req.actor)
          : req.actor.role,
      );
      return {
        data: rows
          .slice(0, 25)
          .map((r) =>
            r.definition.trigger === 'customer_message.received' && !priv
              ? {
                  id: r.id,
                  order_id: r.order_id,
                  state: r.state,
                  created_at: r.created_at,
                  finished_at: r.finished_at,
                  rule_name: r.rule_name,
                  trigger: r.definition.trigger,
                  redacted: true,
                }
              : {...r,child_effects:effects.get(r.id)??[]},
          ),
        meta: { cursor: rows.length > 25 ? rows[24].id : null },
      };
    });
  });
  app.post('/api/orders/batches/preview', (req) => {
    write(req);
    const b = z
      .object({
        order_ids: z
          .array(z.uuid())
          .min(1)
          .max(100)
          .refine((ids) => new Set(ids).size === ids.length, 'Powtórzone zamówienie'),
        action: orderAction,
      })
      .parse(req.body);
    return previewBatch(req.actor, b.order_ids, b.action);
  });
  app.post('/api/order-batches/:id/queue', (req) => {
    write(req);
    const b = z.object({ confirmed: z.boolean().default(false) }).parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, (c) =>
      queueBatch(c, req.actor, id(req.params), b.confirmed),
    );
  });
  app.get('/api/order-batches', (req) => {
    const q = page.parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          'SELECT * FROM order_batches WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM order_batches WHERE id=$1)) ORDER BY created_at DESC,id DESC LIMIT 26',
          [q.after ?? null],
        )
      ).rows;
      return { data: rows.slice(0, 25), meta: { cursor: rows.length > 25 ? rows[24].id : null } };
    });
  });
  app.get('/api/order-batches/:id', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const r = (
        await c.query(
          'SELECT b.*,j.state AS job_state,j.error AS job_error FROM order_batches b LEFT JOIN jobs j ON (j.tenant_id,j.id)=(b.tenant_id,b.job_id) WHERE b.id=$1',
          [id(req.params)],
        )
      ).rows[0];
      ensure(r, 404, 'Nie znaleziono operacji masowej');
      return {
        ...r,
        items: (
          await c.query(
            'SELECT * FROM order_batch_items WHERE batch_id=$1 ORDER BY number,order_id',
            [r.id],
          )
        ).rows,
      };
    }),
  );
}
