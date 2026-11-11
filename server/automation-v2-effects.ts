/**
 * Automation rules v2: effects (shared/automation-v2.ts EFFECT_TYPES) on existing domain functions.
 * The engine runs every rule's effects in one savepoint; any Problem rolls back all of them.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { EffectSpec } from '../shared/automation-v2';
import { ensure, Problem } from './errors';
import { cancelOrder, issueDocument, lockedOrder } from './domain';
import { freezeEmailActions, lockEmailQueue, queueEmailAction, type EmailAction } from './email-actions';
import { freezeSmsActions, queueSmsAction, type SmsAction } from './sms-actions';
import { applyOrderAction } from './order-operations';
import { stages, tag as tagSchema } from './operation-schema';
import { paymentBalance, recordPayment } from './payments';
import { patchOrderFieldsInTx } from './order-fields';
import { dispatchShipping } from './shipping';
import { EFFECT_LABELS, UNSUPPORTED_EFFECTS } from './automation-v2-fields';
import { EFFECT_HANDLERS } from './automation-v2-effects-registry';
import type { EffectEnv, EffectResult } from './automation-v2-effect-types';

export type { EffectEnv, EffectResult } from './automation-v2-effect-types';

export const EMAIL_EFFECTS = new Set(['email', 'request_review', 'send_tracking', 'send_document', 'notify_team']);
const uuid = z.uuid();

/** A stable UUID for a run's effect, so a retried job reuses the same client key. */
export function stableUuid(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const params = {
  set_status: z.strictObject({ status: z.enum(stages) }),
  set_workflow: z.strictObject({ status_id: uuid }),
  set_payment: z.strictObject({
    state: z.literal('paid').default('paid'),
    method: z.enum(['bank_transfer', 'cash', 'card', 'other']).default('other'),
  }),
  add_tag: z.strictObject({ tag: tagSchema }),
  remove_tag: z.strictObject({ tag: tagSchema }),
  set_extra_field: z.strictObject({ field_id: uuid, value: z.union([z.string().max(4000), z.number(), z.array(z.string()).max(50), z.null()]) }),
  add_note: z.strictObject({ note: z.string().trim().min(1).max(500) }),
  cancel_order: z.strictObject({}),
  send_tracking: z.strictObject({ template_id: uuid }),
  issue_document: z.strictObject({ kind: z.literal('invoice').default('invoice') }),
  send_document: z.strictObject({ template_id: uuid }),
  email: z.strictObject({ template_id: uuid }),
  sms: z.strictObject({ template_id: uuid }),
  request_review: z.strictObject({ template_id: uuid }),
  run_rule: z.strictObject({ rule_id: uuid }),
} as const;
type Params = { [K in keyof typeof params]: z.infer<(typeof params)[K]> };

/** Validates effect params against the tenant's data (templates, statuses, fields, users, webhooks, rules). */
export async function validateEffectsInTx(c: PoolClient, effects: EffectSpec[], selfId?: string): Promise<EffectSpec[]> {
  const out: EffectSpec[] = [];
  for (const [i, e] of effects.entries()) {
    const handler = EFFECT_HANDLERS[e.type];
    if (handler) {
      const r = handler.schema.safeParse(e.params ?? {});
      ensure(r.success, 422, `Efekt ${i + 1} (${EFFECT_LABELS[e.type] ?? e.type}): uzupełnij parametry`);
      await handler.validate?.(c, r.data, { selfId });
      out.push({ type: e.type, params: r.data as Record<string, unknown> });
      continue;
    }
    ensure(!UNSUPPORTED_EFFECTS[e.type], 422, `Efekt niedostępny: ${UNSUPPORTED_EFFECTS[e.type] ?? e.type}`);
    const schema = (params as Record<string, z.ZodType>)[e.type];
    ensure(schema, 422, `Nieznany efekt ${e.type}`);
    const r = schema.safeParse(e.params ?? {});
    ensure(r.success, 422, `Efekt ${i + 1} (${EFFECT_LABELS[e.type] ?? e.type}): uzupełnij parametry`);
    const p = r.data as Record<string, any>;
    const exists = async (sql: string, v: unknown, message: string) =>
      ensure((await c.query(sql, [v])).rowCount, 422, message);
    if (e.type === 'set_workflow')
      await exists('SELECT 1 FROM workflow_statuses WHERE id=$1 AND active', p.status_id, 'Własny status jest nieaktywny lub spoza organizacji');
    if (EMAIL_EFFECTS.has(e.type))
      await exists('SELECT 1 FROM email_templates WHERE id=$1 AND active', p.template_id, 'Szablon e-mail jest nieaktywny lub spoza organizacji');
    if (e.type === 'sms')
      await exists('SELECT 1 FROM sms_templates WHERE id=$1 AND active', p.template_id, 'Szablon SMS jest nieaktywny lub spoza organizacji');
    if (e.type === 'set_extra_field')
      await exists("SELECT 1 FROM order_field_definitions WHERE id=$1 AND enabled AND type<>'file'", p.field_id, 'Pole dodatkowe nie istnieje lub nie przyjmuje wartości z reguły');
    if (e.type === 'run_rule') {
      ensure(p.rule_id !== selfId, 422, 'Reguła nie może uruchamiać samej siebie');
      await exists("SELECT 1 FROM automation_rules WHERE id=$1 AND config->>'version'='2'", p.rule_id, 'Nie znaleziono reguły do uruchomienia');
    }
    out.push({ type: e.type, params: p });
  }
  return out;
}

/** Human description for the test view ("co by się stało"). */
export function describeEffect(e: EffectSpec, names: Record<string, string> = {}): string {
  const p = e.params as Record<string, any>;
  const handler = EFFECT_HANDLERS[e.type];
  if (handler) {
    const r = handler.schema.safeParse(p ?? {});
    return r.success ? handler.describe(r.data, names) : EFFECT_LABELS[e.type] ?? e.type;
  }
  const n = (id: unknown) => names[String(id)] ?? String(id ?? '');
  switch (e.type) {
    case 'set_status': return `Zmieni status na ${n(p.status)}`;
    case 'set_workflow': return `Ustawi własny status ${n(p.status_id)}`;
    case 'set_payment': return 'Zapisze wpłatę brakującej kwoty i oznaczy jako opłacone';
    case 'add_tag': return `Doda tag „${p.tag}”`;
    case 'remove_tag': return `Usunie tag „${p.tag}”`;
    case 'set_extra_field': return `Ustawi pole ${n(p.field_id)}`;
    case 'add_note': return `Doda notatkę: ${String(p.note).slice(0, 80)}`;
    case 'cancel_order': return 'Anuluje zamówienie i zwolni rezerwacje';
    case 'send_tracking': return `Wyśle numer przesyłki szablonem ${n(p.template_id)}`;
    case 'issue_document': return 'Wystawi fakturę';
    case 'send_document': return `Wyśle dokument szablonem ${n(p.template_id)}`;
    case 'email': return `Wyśle e-mail ${n(p.template_id)}`;
    case 'sms': return `Wyśle SMS ${n(p.template_id)}`;
    case 'request_review': return `Poprosi o opinię szablonem ${n(p.template_id)}`;
    case 'run_rule': return `Uruchomi regułę ${n(p.rule_id)}`;
    default: return EFFECT_LABELS[e.type] ?? e.type;
  }
}

async function sendEmail(env: EffectEnv, index: number, templateId: string) {
  await lockEmailQueue(env.c, env.actor.tenantId);
  const [frozen] = await freezeEmailActions(env.c, [{ type: 'email', template_id: templateId, mode: 'local', confirm_external: false } as EmailAction]);
  const r = await queueEmailAction(env.c, env.actor, env.orderId, frozen, {
    ...env.context,
    operation: { kind: 'rule', id: env.runId, action_index: index },
  });
  return r.changed;
}

/** Applies one effect. Throws Problem on refusal; the engine records the message on the run. */
export async function applyEffect(env: EffectEnv, effect: EffectSpec, index: number): Promise<EffectResult> {
  const { c, actor, orderId, context } = env;
  const handler = EFFECT_HANDLERS[effect.type];
  if (handler) {
    const parsed = handler.schema.safeParse(effect.params ?? {});
    ensure(parsed.success, 422, `${EFFECT_LABELS[effect.type] ?? effect.type}: nieprawidłowe parametry efektu`);
    return handler.apply(env, parsed.data, index);
  }
  const type = effect.type as keyof Params;
  const schema = (params as Record<string, z.ZodType>)[type];
  ensure(schema && !UNSUPPORTED_EFFECTS[type], 422, `Efekt niedostępny: ${effect.type}`);
  const p = schema.parse(effect.params ?? {}) as any;
  const done = (changed: boolean, message: string): EffectResult => ({ type, changed, message });
  switch (type) {
    case 'set_status': {
      const o = await lockedOrder(c, orderId);
      if (o.status === p.status) return done(false, 'Status bez zmian');
      if (p.status === 'shipped' && o.status === 'packed') {
        // "Nadane" is a physical handover: dispatch the ready carrier label, never a bare status change.
        const plan = (await c.query("SELECT id FROM shipping_plans WHERE order_id=$1 AND state='ready' ORDER BY created_at DESC,id LIMIT 1", [orderId])).rows[0];
        ensure(plan, 409, 'Nadanie wymaga gotowej etykiety przewoźnika');
        await dispatchShipping(c, actor, plan.id);
        return done(true, 'Przekazano przesyłkę przewoźnikowi');
      }
      if (p.status === 'cancelled') {
        await cancelOrder(c, actor, orderId, context);
        return done(true, 'Anulowano zamówienie');
      }
      await applyOrderAction(c, actor, orderId, { type: 'set_status', status: p.status }, context);
      return done(true, `Zmieniono status na ${p.status}`);
    }
    case 'set_workflow': {
      const r = await applyOrderAction(c, actor, orderId, { type: 'set_workflow', status_id: p.status_id }, context);
      return done(r.changed, r.changed ? 'Ustawiono własny status' : 'Własny status bez zmian');
    }
    case 'add_tag':
    case 'remove_tag': {
      const r = await applyOrderAction(c, actor, orderId, { type, tag: p.tag }, context);
      return done(r.changed, `${type === 'add_tag' ? 'Dodano' : 'Usunięto'} tag ${p.tag}`);
    }
    case 'add_note': {
      await applyOrderAction(c, actor, orderId, { type: 'add_note', note: p.note }, context);
      return done(true, 'Dodano notatkę');
    }
    case 'set_payment': {
      const o = await lockedOrder(c, orderId);
      const due = (await paymentBalance(c, orderId)).amount_due;
      if (due === 0) return done(false, 'Zamówienie jest już opłacone');
      await recordPayment(c, actor, orderId, {
        client_key: stableUuid('v2-payment', env.runId, String(index)),
        version: Number(o.version),
        kind: 'receipt',
        amount: due,
        fee: 0,
        currency: o.currency,
        method: p.method,
        reference: `Reguła ${env.rule.name}`.slice(0, 200).padEnd(3, '.'),
        note: 'Wpłata zapisana przez automatyzację',
        confirmed: true,
      } as any);
      return done(true, `Zapisano wpłatę ${(due / 100).toFixed(2)} ${o.currency}`);
    }
    case 'set_extra_field': {
      const d = (await c.query('SELECT id,type,version FROM order_field_definitions WHERE id=$1 AND enabled', [p.field_id])).rows[0];
      ensure(d && d.type !== 'file', 422, 'Pole dodatkowe nie istnieje');
      const o = await lockedOrder(c, orderId);
      const empty = p.value === null || p.value === '' || (Array.isArray(p.value) && !p.value.length);
      const value =
        d.type === 'number' ? String(p.value) : d.type === 'multi_select' ? (Array.isArray(p.value) ? p.value : [String(p.value)]) : Array.isArray(p.value) ? String(p.value[0]) : String(p.value);
      const change = empty
        ? { field_id: d.id, definition_version: d.version, operation: 'clear' as const }
        : { field_id: d.id, definition_version: d.version, type: d.type, value };
      const r = await patchOrderFieldsInTx(c, actor, orderId, {
        client_key: stableUuid('v2-field', env.runId, String(index)),
        order_version: Number(o.version),
        changes: [change as any],
      });
      return done(Boolean(r.changed), 'Ustawiono pole dodatkowe');
    }
    case 'cancel_order': {
      const o = await lockedOrder(c, orderId);
      if (o.status === 'cancelled') return done(false, 'Zamówienie już anulowane');
      await cancelOrder(c, actor, orderId, context);
      return done(true, 'Anulowano zamówienie');
    }
    case 'issue_document': {
      if ((await c.query("SELECT 1 FROM documents WHERE order_id=$1 AND kind='invoice'", [orderId])).rowCount) return done(false, 'Faktura już wystawiona');
      await issueDocument(c, actor, orderId, 'invoice');
      return done(true, 'Wystawiono fakturę');
    }
    case 'send_tracking': {
      ensure((await c.query('SELECT 1 FROM shipments WHERE order_id=$1', [orderId])).rowCount, 409, 'Zamówienie nie ma jeszcze przesyłki');
      return done(await sendEmail(env, index, p.template_id), 'Wysłano numer przesyłki');
    }
    case 'send_document': {
      ensure((await c.query('SELECT 1 FROM documents WHERE order_id=$1', [orderId])).rowCount, 409, 'Zamówienie nie ma jeszcze dokumentu');
      return done(await sendEmail(env, index, p.template_id), 'Wysłano dokument');
    }
    case 'email':
    case 'request_review':
      return done(await sendEmail(env, index, p.template_id), type === 'email' ? 'Wysłano e-mail' : 'Wysłano prośbę o opinię');
    case 'sms': {
      const [frozen] = await freezeSmsActions(c, [{ type: 'sms', template_id: p.template_id, mode: 'local' } as SmsAction]);
      const r = await queueSmsAction(c, actor, orderId, frozen, { ...context, operation: { kind: 'rule', id: env.runId, action_index: index } });
      return done(r.changed, 'Wysłano SMS');
    }
    case 'run_rule':
      return done(true, await env.runRule(p.rule_id));
    default:
      throw new Problem(422, `Efekt niedostępny: ${effect.type}`);
  }
}
