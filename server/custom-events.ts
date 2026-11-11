/** AUTO-07 (DOM-AUTO-008): own events. A definition names an event by key; raising it for an order writes one order
 * event `custom.<key>` (which starts the rules listening to it through the durable `automation` job, events.ts) and
 * one row of the append-only call history. Tables come from migration 244; on an older copy every
 * write answers 503 and the list is empty. */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import { audit, lockedOrder, type Actor } from './domain';
import { event, type EventContext } from './events';
import { customEventKey } from './operation-schema';

export const customEventInput = z.strictObject({
  key: customEventKey,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  active: z.boolean().default(true),
});
export const customEventUpdate = customEventInput.omit({ key: true }).extend({ version: z.string().regex(/^\d+$/) }).strict();
export const customEventRaiseInput = z.strictObject({ order_id: z.uuid(), client_key: z.uuid() });
export type CustomEventSource = 'ui' | 'api' | 'rule' | 'schedule' | 'batch';
export interface CustomEventCallKey { source: CustomEventSource; client_key: string; operation_id: string | null }

export async function customEventsAvailableInTx(c: PoolClient): Promise<boolean> {
  return (await c.query("SELECT to_regclass('public.custom_event_calls') IS NOT NULL AND to_regclass('public.custom_event_defs') IS NOT NULL AS present")).rows[0].present === true;
}
export async function requireCustomEventsInTx(c: PoolClient): Promise<void> {
  ensure(await customEventsAvailableInTx(c), 503, 'Kopia nie zawiera zdarzeń własnych');
}

/** The idempotency key of one call: the operation (rule run, schedule, batch) per action and order when there is
 * one, otherwise the caller's own key. A preview gets a throwaway key (its savepoint is rolled back). */
export function customEventClientKey(orderId: string, context: EventContext | undefined, callerKey: string | undefined, actorSource?: 'manual' | 'api'): CustomEventCallKey {
  const op = context?.operation;
  if (op) return { source: op.kind, client_key: `${op.kind}:${op.id}:${op.action_index}:${orderId}`, operation_id: op.id };
  if (context?.preview) return { source: 'ui', client_key: 'preview:' + randomUUID(), operation_id: null };
  ensure(callerKey, 422, 'Wywołanie zdarzenia wymaga klucza wywołania (client_key)');
  const source = actorSource === 'api' ? 'api' : 'ui';
  return { source, client_key: source + ':' + callerKey, operation_id: null };
}

export interface CustomEventRaise { replayed: boolean; call: Record<string, unknown> }
/** Raise `custom.<key>` for one order inside the caller's tenant transaction. */
export async function raiseCustomEventInTx(c: PoolClient, a: Actor, orderId: string, key: string, callerKey: string | undefined, context?: EventContext): Promise<CustomEventRaise> {
  await requireCustomEventsInTx(c);
  const k = customEventClientKey(orderId, context, callerKey, a.source);
  const requestSha = createHash('sha256').update(JSON.stringify({ key, order_id: orderId, source: k.source })).digest('hex');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['custom-event-call:' + a.tenantId + ':' + k.client_key]);
  const existing = (await c.query('SELECT * FROM custom_event_calls WHERE client_key=$1', [k.client_key])).rows[0];
  if (existing) {
    ensure(existing.request_sha256 === requestSha, 409, 'Klucz wywołania był już użyty dla innego zdarzenia lub zamówienia');
    return { replayed: true, call: existing };
  }
  const def = (await c.query('SELECT * FROM custom_event_defs WHERE key=$1 FOR SHARE', [key])).rows[0];
  ensure(def, 404, 'Nie znaleziono zdarzenia własnego');
  ensure(def.active, 422, 'Zdarzenie własne jest nieaktywne');
  await lockedOrder(c, orderId);
  const id = randomUUID();
  const eventId = await event(c, a.tenantId, orderId, 'custom.' + key, { custom_event_id: def.id, call_id: id, source: k.source }, context);
  const call = (await c.query(
    'INSERT INTO custom_event_calls(id,tenant_id,definition_id,definition_version,event_key,order_id,order_event_id,source,client_key,request_sha256,actor_id,api_key_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
    [id, a.tenantId, def.id, def.version, key, orderId, eventId, k.source, k.client_key, requestSha, a.userId ?? null, a.apiKeyId ?? null, k.operation_id],
  )).rows[0];
  if (!context?.preview) await audit(c, a, 'custom_event.raised', orderId, { key, call_id: id, source: k.source });
  return { replayed: false, call };
}

/** A rule listening to `custom.<key>` or raising one must name an own definition (active when the rule is on). */
export async function validateCustomEventReferencesInTx(c: PoolClient, rule: { trigger: string; enabled: boolean; actions: { type: string; event_key?: string }[] }): Promise<void> {
  const keys = [...(rule.trigger.startsWith('custom.') ? [rule.trigger.slice(7)] : []), ...rule.actions.filter((x) => x.type === 'raise_event').map((x) => x.event_key!)];
  if (!keys.length) return;
  await requireCustomEventsInTx(c);
  for (const key of keys)
    ensure((await c.query('SELECT 1 FROM custom_event_defs WHERE key=$1 AND ($2::boolean=false OR active)', [key, rule.enabled])).rowCount, 422, 'Reguła wskazuje nieznane lub nieaktywne zdarzenie własne: ' + key);
}
