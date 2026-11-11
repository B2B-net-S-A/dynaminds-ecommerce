import { useRef } from 'react';
import { date } from './api';

type Head = {
  id: string; receipt_id: string; return_id: string; order_id: string;
  warehouse_id: string; kind: 'PZ'; number: string; year: number;
  sequence: string; series_id: string; row_count: number; quantity: string;
  wms_enabled: boolean; created_at: string;
  warehouse: { id: string; name: string; code: string };
  series: { id: string; warehouse_id: string; kind: 'PZ'; name: string; prefix: string };
};
const uuid = (v: unknown): v is string => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const positive = (v: unknown): v is string => typeof v === 'string' &&
  /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const label = (v: unknown, max: number): v is string => typeof v === 'string' &&
  v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** Validate the complete returned list before showing any document number. */
export function validateReturnStockReceipts(value: unknown, returnId: string, orderId: string): Head[] {
  if (!uuid(returnId) || !uuid(orderId) || !Array.isArray(value) || value.length > 100)
    throw Error('Nie można potwierdzić dokumentów przyjęcia tego zwrotu.');
  const ids = new Set<string>(), warehouses = new Set<string>();
  let receiptId: string | undefined;
  for (const raw of value) {
    const h = raw as Partial<Head> | null;
    if (!h || !uuid(h.id) || !uuid(h.receipt_id) || h.return_id !== returnId || h.order_id !== orderId ||
      !uuid(h.warehouse_id) || !uuid(h.series_id) || h.kind !== 'PZ' ||
      !Number.isInteger(h.year) || h.year! < 1 || h.year! > 9999 || !positive(h.sequence) ||
      !positive(h.quantity) || !Number.isInteger(h.row_count) || h.row_count! < 1 || h.row_count! > 10000 ||
      typeof h.wms_enabled !== 'boolean' || typeof h.created_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(h.created_at) ||
      !Number.isFinite(Date.parse(h.created_at)) || h.warehouse?.id !== h.warehouse_id ||
      !label(h.warehouse.name, 300) || !label(h.warehouse.code, 100) ||
      h.series?.id !== h.series_id || h.series.warehouse_id !== h.warehouse_id || h.series.kind !== 'PZ' ||
      !label(h.series.name, 300) || !label(h.series.prefix, 100) ||
      h.number !== `${h.series.prefix}/${h.year}/${h.sequence.padStart(6, '0')}` ||
      ids.has(h.id) || warehouses.has(h.warehouse_id) || (receiptId !== undefined && receiptId !== h.receipt_id))
      throw Error('Nie można potwierdzić dokumentów przyjęcia tego zwrotu.');
    ids.add(h.id); warehouses.add(h.warehouse_id); receiptId = h.receipt_id;
  }
  return value as Head[];
}

export function ReturnStockReceipts({ receipts, returnId, orderId, contextKey }: {
  receipts: unknown; returnId: string; orderId: string; contextKey: string;
}) {
  // A context change cannot relabel the previous actor's retained heads. Wait
  // for a new response array; this component never fetches or acknowledges writes.
  const scope = useRef({ key: contextKey, receipts, stale: false });
  if (scope.current.key !== contextKey)
    scope.current = { key: contextKey, receipts: scope.current.receipts, stale: true };
  if (scope.current.stale && receipts !== scope.current.receipts)
    scope.current = { key: contextKey, receipts, stale: false };
  if (scope.current.stale) return null;
  scope.current.receipts = receipts;
  const parts = contextKey.split(':');
  if (parts.length !== 4 || !uuid(parts[0]) || !uuid(parts[1]) ||
    !['admin', 'operator', 'viewer'].includes(parts[2]) || !['true', 'false'].includes(parts[3])) return null;
  if (receipts === undefined || (Array.isArray(receipts) && receipts.length === 0)) return null;
  let heads: Head[];
  try { heads = validateReturnStockReceipts(receipts, returnId, orderId); }
  catch { return <p className="error-block" role="alert">Nie można potwierdzić dokumentów przyjęcia tego zwrotu. Odśwież szczegóły sprawy.</p>; }
  return <section aria-label="Dokumenty przyjęcia zwrotu">
    <h3>Dokumenty przyjęcia zwrotu</h3>
    <p className="muted">Wystawione PZ potwierdzają przyjęcie towaru do wskazanych magazynów. Rozliczenie klienta pozostaje osobne.</p>
    <div className="table-scroll"><table><thead><tr>
      <th>Dokument</th><th>Magazyn</th><th>Przyjęta ilość fizyczna</th><th>Pozycje dokumentu</th><th>Wystawiono</th>
    </tr></thead><tbody>{heads.map(h => <tr key={h.id}>
      <td><strong>{h.number}</strong></td><td>{h.warehouse.name} <small>{h.warehouse.code}</small></td>
      <td>{BigInt(h.quantity).toLocaleString('pl-PL')}</td><td>{h.row_count}</td><td>{date(h.created_at)}</td>
    </tr>)}</tbody></table></div>
  </section>;
}
