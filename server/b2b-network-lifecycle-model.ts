/** Pure rules of the 251 network lifecycle (B2B-002 link, B2B-003 mapping, B2B-004-X supplier decision,
 * B2B-005 dropshipping tracking). No database access; the routes apply them under their row locks. */
import { Problem } from './errors';

/** The supplier decides within this window; until then the supplier order keeps its ordinary reservation. */
export const DECISION_WINDOW_HOURS = 48;

export type LinkState = 'connected' | 'disconnected';
export type Side = 'buyer' | 'supplier';
/** Disconnecting an already disconnected link is a replay (no second event), whichever side asks. */
export function disconnectPlan(current: LinkState | null): 'disconnect' | 'replay' {
  return current === 'disconnected' ? 'replay' : 'disconnect';
}
/** A new invitation reconnects only the company that owned the link; another company needs a new account. */
export function reconnectPlan(row: { state: LinkState; tenant_id: string } | null, buyerTenantId: string): 'insert' | 'reconnect' {
  if (!row) return 'insert';
  if (row.state !== 'disconnected') throw new Problem(409, 'Kontrahent ma juz polaczona firme');
  if (row.tenant_id !== buyerTenantId)
    throw new Problem(409, 'Konto kontrahenta było połączone z inną firmą; dla nowej firmy załóż nowe konto kontrahenta');
  return 'reconnect';
}

export type MappingState = 'bound' | 'unbound';
export interface MappingItem { product_id: string | null; proof: boolean }
export function unbindPlan(item: MappingItem, overlay: MappingState | null): 'unbind' | 'replay' {
  if (!item.product_id) throw new Problem(409, 'Oferta nie ma powiązania z własnym produktem');
  return overlay === 'unbound' ? 'replay' : 'unbind';
}
/** Rebinding to the bound product is a replay; back to the unbound product it reattaches. Any other product needs a
 * mapping without the 144 scope proof, which is immutable evidence of the bound product. */
export function rebindPlan(item: MappingItem, overlay: MappingState | null, target: string): 'replay' | 'reattach' | 'switch' {
  if (!item.product_id) throw new Problem(409, 'Oferta nie ma powiązania; użyj importu lub powiązania produktu');
  if (target === item.product_id) return overlay === 'unbound' ? 'reattach' : 'replay';
  if (item.proof)
    throw new Problem(409, 'Powiązanie potwierdzone dowodem zakresu katalogu można przywrócić tylko do tego samego produktu');
  return 'switch';
}

export interface StoredPrice { minor: number; currency: string }
/** The supplier purchase price taken from the offer snapshot (minor units). Same price and currency = no change. */
export function priceSyncPlan(stored: StoredPrice | null, snapshot: { price: unknown; currency: unknown }) {
  const price = snapshot.price, currency = snapshot.currency;
  if (!Number.isSafeInteger(price) || (price as number) < 0 || (price as number) > 100000000000 || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
    throw new Problem(409, 'Oferta dostawcy nie ma poprawnej ceny; odśwież katalog');
  const after: StoredPrice = { minor: price as number, currency };
  const changed = !stored || stored.minor !== after.minor || stored.currency !== after.currency;
  return { changed, before: stored, after };
}

export type DecisionState = 'pending' | 'accepted' | 'rejected' | 'expired' | 'withdrawn';
export interface DecisionRow { state: DecisionState; version: number; decide_by: Date }
/** The supplier's explicit decision. The same final decision again is a replay; anything else needs a pending row of
 * the given version before the deadline. */
export function decisionPlan(d: DecisionRow, decision: 'accept' | 'reject', version: number, now: Date): 'replay' | 'accepted' | 'rejected' {
  const wanted = decision === 'accept' ? 'accepted' : 'rejected';
  if (d.state === wanted) return 'replay';
  if (d.state !== 'pending') throw new Problem(409, 'Decyzja o tym zamówieniu już zapadła');
  if (d.version !== version) throw new Problem(409, 'Zamówienie zmieniło się; odśwież listę');
  if (now.getTime() >= d.decide_by.getTime()) throw new Problem(409, 'Termin decyzji minął; zamówienie wygasa');
  return wanted;
}
const FULFILMENT = ['picking', 'packed', 'shipped', 'delivered', 'completed'];
/** What the background sweep does with a pending decision: the supplier's own cancel is a rejection; started
 * fulfilment or a dispatched parcel is an implicit acceptance; past the deadline an untouched order expires. */
export function sweepPlan(status: string, dispatched: boolean, now: Date, decideBy: Date): 'reject' | 'accept' | 'expire' | 'wait' {
  if (status === 'cancelled') return 'reject';
  if (dispatched || FULFILMENT.includes(status)) return 'accept';
  return now.getTime() >= decideBy.getTime() ? 'expire' : 'wait';
}

export interface SupplierShipment { id: string; carrier: string; tracking_number: string; dispatched_at: Date | null }
/** Dispatched supplier parcels with a parcel number that are not copied yet, oldest first. */
export function trackingToCopy(shipments: SupplierShipment[], copied: ReadonlySet<string>) {
  return shipments
    .filter((s) => s.dispatched_at && typeof s.tracking_number === 'string' && s.tracking_number.trim() && !copied.has(s.id))
    .map((s) => ({ ...s, carrier: s.carrier.trim().slice(0, 100) || 'nieznany', tracking_number: s.tracking_number.trim().slice(0, 200), dispatched_at: s.dispatched_at as Date }))
    .sort((a, b) => a.dispatched_at.getTime() - b.dispatched_at.getTime() || a.id.localeCompare(b.id));
}
