/** Exact FIFO allocation and known/unknown inventory value. No database or side effects. */
import { ensure } from './errors';

export const WMS_INT64_MAX = 9223372036854775807n;
export const WMS_QUANTITY_MAX = 2147483647;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function quantity(value: unknown, positive = false): asserts value is number {
  ensure(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= (positive ? 1 : 0) &&
      value <= WMS_QUANTITY_MAX,
    422,
    'Ilość musi być całkowita i mieścić się w zakresie zapasu',
  );
}
function bounded(value: bigint): string {
  ensure(value >= 0n && value <= WMS_INT64_MAX, 422, 'Wartość WMS przekracza zakres bigint');
  return value.toString();
}
export function parseWmsMinor(value: unknown): string {
  ensure(
    typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value),
    422,
    'Koszt WMS wymaga dokładnej liczby całkowitej w najmniejszej jednostce waluty',
  );
  return bounded(BigInt(value));
}
export function wmsCostValue(qty: number, unitCostMinor: string | null) {
  quantity(qty);
  if (unitCostMinor === null) return { known_minor: '0', unknown_quantity: qty };
  return {
    known_minor: bounded(BigInt(qty) * BigInt(parseWmsMinor(unitCostMinor))),
    unknown_quantity: 0,
  };
}
export type WmsValueRow = { quantity: number; unit_cost_minor: string | null; currency: string };
export function wmsValueSummary(rows: WmsValueRow[], currency: string) {
  ensure(/^[A-Z]{3}$/.test(currency), 422, 'Wymagana jest jawna waluta wyceny');
  let known = 0n,
    unknown = 0n,
    total = 0n;
  for (const row of rows) {
    ensure(row.currency === currency, 422, 'Nie można sumować kosztów w różnych walutach');
    const value = wmsCostValue(row.quantity, row.unit_cost_minor);
    known += BigInt(value.known_minor);
    unknown += BigInt(value.unknown_quantity);
    total += BigInt(row.quantity);
  }
  return {
    currency,
    quantity: bounded(total),
    known_minor: bounded(known),
    unknown_quantity: bounded(unknown),
    known_quantity: bounded(total - unknown),
  };
}
export type WmsFifoLayer = {
  layer_id: string;
  location: string;
  fifo_sequence: string;
  available: number;
  unit_cost_minor: string | null;
  currency: string;
};
export type WmsFifoPick = WmsFifoLayer & {
  quantity: number;
  known_minor: string;
  unknown_quantity: number;
};
export function selectFifoLayers(rows: WmsFifoLayer[], requested: number): WmsFifoPick[] {
  quantity(requested, true);
  const identities = new Set<string>();
  let currency: string | undefined;
  for (const row of rows) {
    ensure(uuid.test(row.layer_id), 422, 'Nieprawidłowa tożsamość warstwy');
    ensure(
      typeof row.location === 'string' &&
        row.location.length > 0 &&
        row.location.length <= 80 &&
        !/[\u0000-\u001f\u007f]/.test(row.location),
      422,
      'Nieprawidłowa lokalizacja warstwy',
    );
    const key = JSON.stringify([row.layer_id, row.location]);
    ensure(!identities.has(key), 422, 'Warstwa w lokalizacji występuje więcej niż raz');
    identities.add(key);
    ensure(
      BigInt(parseWmsMinor(row.fifo_sequence)) > 0n,
      422,
      'Warstwa wymaga niezmiennej kolejności przyjęcia',
    );
    quantity(row.available);
    if (row.unit_cost_minor !== null) parseWmsMinor(row.unit_cost_minor);
    ensure(/^[A-Z]{3}$/.test(row.currency), 422, 'Nieprawidłowa waluta warstwy');
    currency ??= row.currency;
    ensure(currency === row.currency, 422, 'Warstwy wymagają tej samej waluty wyceny');
  }
  const ordered = [...rows].sort((a, b) => {
    const left = BigInt(a.fifo_sequence),
      right = BigInt(b.fifo_sequence);
    if (left !== right) return left < right ? -1 : 1;
    if (a.layer_id !== b.layer_id) return a.layer_id < b.layer_id ? -1 : 1;
    return Buffer.compare(Buffer.from(a.location, 'utf8'), Buffer.from(b.location, 'utf8'));
  });
  let remaining = requested;
  const picked: WmsFifoPick[] = [];
  for (const row of ordered) {
    const take = Math.min(remaining, row.available);
    if (take > 0)
      picked.push({ ...row, quantity: take, ...wmsCostValue(take, row.unit_cost_minor) });
    remaining -= take;
    if (remaining === 0) break;
  }
  ensure(remaining === 0, 409, 'Brak dostępnych warstw FIFO dla całej rezerwacji');
  wmsValueSummary(picked, currency!); // Reject aggregate overflow before returning any allocation.
  return picked;
}
