import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import type { Actor } from './domain';
import type { EventContext } from './events';
import { smsChannelHash, smsPrepare, smsQueue, smsBatch } from './sms';
export const smsAction = z
  .object({
    type: z.literal('sms'),
    template_id: z.uuid(),
    template_version: z.string().regex(/^\d+$/).optional(),
    order_version: z.string().regex(/^\d+$/).optional(),
    mode: z.enum(['local', 'provider_test']).default('local'),
    channel_id: z.uuid().optional(),
    channel_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    client_key: z.uuid().optional(),
    confirmed: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (v) => (v.mode === 'provider_test' ? Boolean(v.channel_id) : !v.channel_id),
    'Test SMSAPI wymaga kanału; symulacja jest lokalna',
  );
export type SmsAction = z.infer<typeof smsAction>;
// Missing or inactive references never block the core order event. A frozen sentinel
// version then fails the communication action rather than silently rebinding later.
export async function freezeSmsActions<T extends { type: string }>(
  c: PoolClient,
  actions: T[],
  strict = true,
): Promise<T[]> {
  const selected = actions.filter((a) => a.type === 'sms') as unknown as SmsAction[];
  if (!selected.length) return actions;
  const templates = (
    await c.query('SELECT id,version,active FROM sms_templates WHERE id=ANY($1::uuid[])', [
      selected.map((a) => a.template_id),
    ])
  ).rows;
  const channels = (
    await c.query('SELECT * FROM channels WHERE id=ANY($1::uuid[])', [
      selected.flatMap((a) => (a.channel_id ? [a.channel_id] : [])),
    ])
  ).rows;
  return actions.map((raw) => {
    if (raw.type !== 'sms') return raw;
    const a = raw as unknown as SmsAction,
      t = templates.find((t) => t.id === a.template_id),
      ch = channels.find((ch) => ch.id === a.channel_id);
    if (strict) {
      ensure(t?.active, 422, 'Brak aktywnego szablonu SMS');
      ensure(
        !a.template_version || a.template_version === t.version,
        409,
        'Szablon SMS zmienił się',
      );
      if (a.mode === 'provider_test') {
        ensure(
          ch?.provider === 'smsapi' && ch.mode === 'sandbox' && !ch.settings.simulation,
          422,
          'Wymagane połączenie testowe SMSAPI',
        );
        ensure(
          !a.channel_hash || a.channel_hash === smsChannelHash(ch),
          409,
          'Połączenie SMSAPI zmieniło się',
        );
      }
    }
    return {
      ...a,
      template_version: a.template_version ?? t?.version ?? '0',
      ...(a.mode === 'provider_test'
        ? { channel_hash: a.channel_hash ?? (ch ? smsChannelHash(ch) : '0'.repeat(64)) }
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
export async function queueSmsAction(
  c: PoolClient,
  a: Actor,
  orderId: string,
  action: SmsAction,
  context?: EventContext,
) {
  ensure(
    a.role !== 'viewer' && (action.mode === 'local' || a.role === 'admin'),
    403,
    'Brak prawa do tego trybu SMS',
  );
  const source = context?.operation;
  if (!source && !context?.preview)
    ensure(
      action.client_key &&
        action.confirmed &&
        action.order_version &&
        action.template_version &&
        (action.mode === 'local' || action.channel_hash),
      422,
      'SMS wymaga podglądu, wersji zamówienia, confirmed:true i klucza klienta',
    );
  const key = source ? executionKey(context!, orderId) : (action.client_key ?? randomUUID());
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'sms-preview:' + a.tenantId + ':' + key,
  ]);
  const old = (await c.query('SELECT * FROM sms_batches WHERE client_key=$1', [key])).rows[0];
  if (old) {
    const b = await smsBatch(c, old.id);
    ensure(
      b.actor_id === a.userId &&
        b.template_id === action.template_id &&
        b.mode === action.mode &&
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
      'Klucz akcji SMS ma inny zakres',
    );
    return {
      changed: false,
      sms: {
        batch_id: b.id,
        message_id: b.items[0].id,
        state: b.items[0].state,
        mode: b.mode,
        payload: b.items[0].payload,
        recipient: b.items[0].recipient,
      },
    };
  }
  if (!source && !context?.preview) {
    const o = (await c.query('SELECT version FROM orders WHERE id=$1 FOR UPDATE', [orderId]))
      .rows[0];
    ensure(o?.version === action.order_version, 409, 'Zamówienie zmieniło się od podglądu SMS');
  }
  const frozen = (await freezeSmsActions(c, [action]))[0];
  if (frozen.channel_id) {
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [frozen.channel_id]))
      .rows[0];
    ensure(smsChannelHash(ch) === frozen.channel_hash, 409, 'Połączenie SMSAPI zmieniło się');
  }
  const b = await smsPrepare(c, a, {
    template_id: frozen.template_id,
    template_version: frozen.template_version!,
    order_ids: [orderId],
    mode: frozen.mode,
    channel_id: frozen.channel_id,
    client_key: key,
  });
  await c.query(
    'UPDATE sms_batches SET automation_run_id=$2,automation_schedule_run_id=$3,order_batch_id=$4,order_guard=$5 WHERE id=$1',
    [
      b.id,
      source?.kind === 'rule' ? source.id : null,
      source?.kind === 'schedule' ? source.id : null,
      source?.kind === 'batch' ? source.id : null,
      source ? 'content' : 'version',
    ],
  );
  const result = await smsQueue(c, a, b.id);
  return {
    changed: true,
    sms: {
      batch_id: result.id,
      message_id: result.items[0].id,
      state: result.items[0].state,
      mode: result.mode,
      payload: result.items[0].payload,
      recipient: result.items[0].recipient,
    },
  };
}
export async function checkSmsOrigin(c: PoolClient, m: any) {
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
      'Źródłowa reguła SMS wyłączona, zmieniona lub nieukończona',
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
      'Źródłowy harmonogram SMS wyłączony, zmieniony lub przerwany',
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
      'Źródłowa operacja masowa SMS jest przerwana',
    );
  }
}
