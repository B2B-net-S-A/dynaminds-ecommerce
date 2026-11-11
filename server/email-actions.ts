import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import type { Actor } from './domain';
import type { EventContext } from './events';
import { emailChannelHash, prepareEmail, queueEmail, emailBatch } from './email';
export const emailAction = z
  .object({
    type: z.literal('email'),
    template_id: z.uuid(),
    template_version: z.string().regex(/^\d+$/).optional(),
    order_version: z.string().regex(/^\d+$/).optional(),
    mode: z.enum(['local', 'smtp']).default('local'),
    channel_id: z.uuid().optional(),
    channel_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    client_key: z.uuid().optional(),
    confirmed: z.literal(true).optional(),
    confirm_external: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => (v.mode === 'smtp' ? Boolean(v.channel_id) : !v.channel_id),
    'SMTP wymaga konta; symulacja jest lokalna',
  );
// All email-producing operations and origin mutations take this lock before row locks.
export async function lockEmailQueue(c: PoolClient, tenant: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['email-queue:' + tenant]);
}
export type EmailAction = z.infer<typeof emailAction>;
// Missing or inactive references never block the core order event. A frozen sentinel
// version then fails the communication action rather than silently rebinding later.
export async function freezeEmailActions<T extends { type: string }>(
  c: PoolClient,
  actions: T[],
  strict = true,
): Promise<T[]> {
  const selected = actions.filter((a) => a.type === 'email') as unknown as EmailAction[];
  if (!selected.length) return actions;
  const available = (
    await c.query(
      "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.email_batches') AND attname='automation_run_id' AND NOT attisdropped) available",
    )
  ).rows[0].available;
  if (!available) {
    ensure(!strict, 404, 'Akcje email niedostępne w tym schemacie');
    return actions.map((a) => (a.type === 'email' ? ({ ...a, template_version: '0' } as T) : a));
  }
  const templates = (
    await c.query('SELECT id,version,active FROM email_templates WHERE id=ANY($1::uuid[])', [
      selected.map((a) => a.template_id),
    ])
  ).rows;
  const channels = (
    await c.query('SELECT * FROM channels WHERE id=ANY($1::uuid[])', [
      selected.flatMap((a) => (a.channel_id ? [a.channel_id] : [])),
    ])
  ).rows;
  return actions.map((raw) => {
    if (raw.type !== 'email') return raw;
    const a = raw as unknown as EmailAction,
      t = templates.find((t) => t.id === a.template_id),
      ch = channels.find((ch) => ch.id === a.channel_id);
    if (strict) {
      ensure(t?.active, 422, 'Brak aktywnego szablonu email');
      ensure(
        !a.template_version || a.template_version === t.version,
        409,
        'Szablon email zmienił się',
      );
      if (a.mode === 'smtp') {
        ensure(ch?.provider === 'smtp', 422, 'Wymagane konto SMTP');
        if (ch.settings.delivery === 'external')
          ensure(a.confirm_external, 403, 'Akcja wymaga jawnej zgody na zewnętrzny email');
        ensure(
          !a.channel_hash || a.channel_hash === emailChannelHash(ch),
          409,
          'Połączenie SMTP zmieniło się',
        );
      }
    }
    return {
      ...a,
      template_version: a.template_version ?? t?.version ?? '0',
      ...(a.mode === 'smtp'
        ? { channel_hash: a.channel_hash ?? (ch ? emailChannelHash(ch) : '0'.repeat(64)) }
        : {}),
    } as unknown as T;
  });
}
function executionKey(context: EventContext, orderId: string) {
  const hash = createHash('sha256')
    .update(JSON.stringify({ source: context.operation, orderId }))
    .digest('hex');
  return (
    hash.slice(0, 8) +
    '-' +
    hash.slice(8, 12) +
    '-4' +
    hash.slice(13, 16) +
    '-a' +
    hash.slice(17, 20) +
    '-' +
    hash.slice(20, 32)
  );
}
export async function queueEmailAction(
  c: PoolClient,
  a: Actor,
  orderId: string,
  action: EmailAction,
  context?: EventContext,
) {
  ensure(a.role !== 'viewer', 403, 'Brak prawa do tego trybu email');
  await lockEmailQueue(c, a.tenantId);
  const source = context?.operation;
  if (!source && !context?.preview)
    ensure(
      action.client_key &&
        action.confirmed &&
        action.order_version &&
        action.template_version &&
        (action.mode === 'local' || action.channel_hash),
      422,
      'email wymaga podglądu, wersji zamówienia, confirmed:true i klucza klienta',
    );
  const key = source ? executionKey(context!, orderId) : (action.client_key ?? randomUUID());
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'email-preview:' + a.tenantId + ':' + key,
  ]);
  const old = (await c.query('SELECT * FROM email_batches WHERE client_key=$1', [key])).rows[0];
  if (old) {
    const b = await emailBatch(c, old.id);
    ensure(
      b.actor_id === a.userId &&
        b.template_id === action.template_id &&
        b.mode === action.mode &&
        b.external_allowed === action.confirm_external &&
        b.channel_id === (action.channel_id ?? null) &&
        b.items.length === 1 &&
        b.items[0].order_id === orderId &&
        (!action.order_version || action.order_version === b.items[0].snapshot.version) &&
        b.automation_run_id === (source?.kind === 'rule' ? source.id : null) &&
        b.automation_schedule_run_id === (source?.kind === 'schedule' ? source.id : null) &&
        b.order_batch_id === (source?.kind === 'batch' ? source.id : null) &&
        (!action.channel_hash || action.channel_hash === b.channel_hash) &&
        (!action.template_version || action.template_version === b.template_version),
      409,
      'Klucz akcji email ma inny zakres',
    );
    return {
      changed: false,
      email: {
        batch_id: b.id,
        message_id: b.items[0].id,
        state: b.items[0].state,
        mode: b.mode,
        payload: b.items[0].payload,
        recipient: b.items[0].payload?.recipient,
        sender: b.items[0].sender,
      },
    };
  }
  if (!source && !context?.preview) {
    const o = (await c.query('SELECT version FROM orders WHERE id=$1 FOR UPDATE', [orderId]))
      .rows[0];
    ensure(o?.version === action.order_version, 409, 'Zamówienie zmieniło się od podglądu email');
  }
  const frozen = (await freezeEmailActions(c, [action]))[0];
  if (frozen.channel_id) {
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [frozen.channel_id]))
      .rows[0];
    ensure(emailChannelHash(ch) === frozen.channel_hash, 409, 'Połączenie SMTP zmieniło się');
  }
  const b = await prepareEmail(c, a, {
    template_id: frozen.template_id,
    template_version: frozen.template_version!,
    order_ids: [orderId],
    mode: frozen.mode,
    channel_id: frozen.channel_id,
    client_key: key,
  });
  ensure(b.items[0].state === 'draft', 422, b.items[0].error ?? 'Niepoprawna wiadomość email');
  if (context?.preview)
    return {
      changed: false,
      email: {
        batch_id: b.id,
        message_id: b.items[0].id,
        state: 'draft',
        mode: b.mode,
        payload: b.items[0].payload,
        recipient: b.items[0].payload.recipient,
        sender: b.items[0].sender,
      },
    };
  await c.query(
    'UPDATE email_batches SET automation_run_id=$2,automation_schedule_run_id=$3,order_batch_id=$4,order_guard=$5,external_allowed=$6 WHERE id=$1',
    [
      b.id,
      source?.kind === 'rule' ? source.id : null,
      source?.kind === 'schedule' ? source.id : null,
      source?.kind === 'batch' ? source.id : null,
      source ? 'content' : 'version',
      frozen.confirm_external,
    ],
  );
  const result = await queueEmail(c, a, b.id, {
    confirmed: true,
    confirm_external: frozen.confirm_external,
  });
  return {
    changed: true,
    email: {
      batch_id: result.id,
      message_id: result.items[0].id,
      state: result.items[0].state,
      mode: result.mode,
      payload: result.items[0].payload,
      recipient: result.items[0].payload?.recipient,
      sender: result.items[0].sender,
    },
  };
}
export async function checkEmailOrigin(c: PoolClient, m: any) {
  if(m.inbound_reply_preview_id){
    await c.query('SELECT email_inbound_worker_context($1,false)',[m.id]);
    return;
  }
  if (m.automation_run_id || m.automation_schedule_run_id || m.order_batch_id)
    ensure(
      m.mode !== 'smtp' || m.sender?.local_sink === true || m.external_allowed === true,
      403,
      'Akcja nie ma zapisanej zgody na zewnętrzny email',
    );
  if (m.automation_run_id) {
    const p = (
      await c.query(
        "SELECT r.state,r.definition->>'actor_id' AS actor_id,r.rule_version,a.enabled,a.version FROM automation_runs r JOIN automation_rules a ON (a.tenant_id,a.id)=(r.tenant_id,r.rule_id) WHERE r.id=$1 FOR SHARE OF r,a",
        [m.automation_run_id],
      )
    ).rows[0];
    ensure(
      p?.state === 'done' && p.actor_id === m.actor_id && p.enabled && p.version === p.rule_version,
      409,
      'Źródłowa reguła email wyłączona, zmieniona lub nieukończona',
    );
  }
  if (m.automation_schedule_run_id) {
    const p = (
      await c.query(
        'SELECT r.state,r.actor_id,r.schedule_version,a.enabled,a.version FROM automation_schedule_runs r JOIN automation_schedules a ON (a.tenant_id,a.id)=(r.tenant_id,r.schedule_id) WHERE r.id=$1 FOR SHARE OF r,a',
        [m.automation_schedule_run_id],
      )
    ).rows[0];
    ensure(
      p &&
        ['queued', 'done'].includes(p.state) &&
        p.actor_id === m.actor_id &&
        p.enabled &&
        p.version === p.schedule_version,
      409,
      'Źródłowy harmonogram email wyłączony, zmieniony lub przerwany',
    );
  }
  if (m.order_batch_id) {
    const p = (
      await c.query('SELECT state,actor_id FROM order_batches WHERE id=$1 FOR SHARE', [
        m.order_batch_id,
      ])
    ).rows[0];
    ensure(
      p && ['queued', 'done'].includes(p.state) && p.actor_id === m.actor_id,
      409,
      'Źródłowa operacja masowa email jest przerwana',
    );
  }
}
