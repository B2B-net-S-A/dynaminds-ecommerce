/**
 * "Zgłoś brak" (automation rules v2 trigger order.item_missing): the picker or packer reports that an order line
 * cannot be completed. Nothing in the order changes; the order history gets `order.item_missing`
 * {item_id, sku, name, quantity_missing, actor} and the v2 rules of that trigger are evaluated.
 */
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { audit, lockedOrder, type Actor } from './domain';
import { ensure } from './errors';
import { automationOnlyEvent } from './automation-v2-triggers';

/** Stages in which goods are still being collected: before the label is handed over, after payment. */
export const ITEM_MISSING_STATUSES = ['paid', 'picking', 'packed'];

export const itemMissingInput = z.strictObject({
  quantity_missing: z.number({ error: 'Podaj liczbę brakujących sztuk' }).int('Podaj całą liczbę sztuk').min(1, 'Brak to co najmniej 1 sztuka').max(100000),
  /** Retry key: the same key returns the first report instead of a second history entry. */
  client_key: z.uuid().optional(),
});

export interface ItemMissingResult {
  event_id: string;
  item_id: string;
  sku: string;
  quantity_missing: number;
  replayed: boolean;
}

export async function reportItemMissingInTx(c: PoolClient, a: Actor, orderId: string, itemId: string, raw: unknown): Promise<ItemMissingResult> {
  ensure(a.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
  const b = itemMissingInput.parse(raw);
  const o = await lockedOrder(c, orderId);
  if (b.client_key) {
    const prior = (
      await c.query("SELECT id,detail FROM order_events WHERE order_id=$1 AND kind='order.item_missing' AND detail->>'client_key'=$2", [orderId, b.client_key])
    ).rows[0];
    if (prior) {
      ensure(prior.detail.item_id === itemId && prior.detail.quantity_missing === b.quantity_missing, 409, 'Klucz zgłoszenia wykorzystano dla innych danych');
      return { event_id: prior.id, item_id: itemId, sku: prior.detail.sku, quantity_missing: b.quantity_missing, replayed: true };
    }
  }
  ensure(ITEM_MISSING_STATUSES.includes(o.status), 409, 'Brak zgłosisz w zamówieniu w realizacji: opłaconym, w kompletacji lub spakowanym');
  const item = (await c.query('SELECT id,sku,name,quantity FROM order_items WHERE id=$1 AND order_id=$2', [itemId, orderId])).rows[0];
  ensure(item, 404, 'Nie znaleziono pozycji zamówienia');
  ensure(b.quantity_missing <= item.quantity, 422, `Brak nie może przekraczać ilości w pozycji (${item.quantity} szt.)`);
  const name = (await c.query('SELECT customer_message_actor_name($1) n', [a.userId])).rows[0]?.n ?? null;
  const eventId = await automationOnlyEvent(c, a.tenantId, orderId, 'order.item_missing', {
    item_id: item.id,
    sku: item.sku,
    name: item.name,
    quantity_missing: b.quantity_missing,
    actor: { user_id: a.userId, name },
    ...(b.client_key ? { client_key: b.client_key } : {}),
  });
  await audit(c, a, 'order.item_missing', orderId, { item_id: item.id, sku: item.sku, quantity_missing: b.quantity_missing });
  return { event_id: eventId, item_id: item.id, sku: item.sku, quantity_missing: b.quantity_missing, replayed: false };
}
