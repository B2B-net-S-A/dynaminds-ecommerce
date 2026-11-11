import { useRef } from 'react';
import { date } from './api';

type Protocol = 'inventory_bulk'|'stock_file';
type Head = {
  id: string; receipt_id: string; source_id: string; protocol: Protocol;
  warehouse_id: string; kind: 'PW'|'RW'; number: string; year: number;
  sequence: string; series_id: string; row_count: number; quantity: string;
  wms_enabled: boolean; created_at: string;
};
const uuid = (v: unknown): v is string => typeof v === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const positive = (v: unknown): v is string => typeof v === 'string' &&
  /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;

/** Native execution read supplies headings only: this view has no HTTP/writes,
 * no cost projection and no acknowledgement of any uncertain count attempt. */
export function CatalogStockCountDocuments({ documents, protocol, sourceId, contextKey,
  warehouses = [] }: { documents: unknown; protocol: Protocol; sourceId: string; contextKey: string;
  warehouses?: readonly { id: string; name: string; code: string }[] }) {
  const scope = useRef({ key: contextKey, documents, stale: false });
  if (scope.current.key !== contextKey)
    scope.current = { key: contextKey, documents: scope.current.documents, stale: true };
  if (scope.current.stale && documents !== scope.current.documents)
    scope.current = { key: contextKey, documents, stale: false };
  if (scope.current.stale) return null;
  scope.current.documents = documents;
  const actor = contextKey.split(':');
  if (actor.length !== 4 || !uuid(actor[0]) || !uuid(actor[1]) ||
    !['admin','operator','viewer'].includes(actor[2]) || !['true','false'].includes(actor[3])) return null;
  if (documents === undefined || (Array.isArray(documents) && documents.length === 0)) return null;
  const bad = <p className="error-block" role="alert">Nie można potwierdzić dokumentów rozliczenia tego pomiaru. Odśwież historię wykonania.</p>;
  if (!uuid(sourceId) || !['inventory_bulk','stock_file'].includes(protocol) ||
    !Array.isArray(documents) || documents.length > 200) return bad;
  const ids = new Set<string>(), pairs = new Set<string>();
  let receipt: string|undefined, wms: boolean|undefined;
  for (const raw of documents) {
    const h = raw as Partial<Head>|null;
    if (!h || !uuid(h.id) || !uuid(h.receipt_id) || h.source_id !== sourceId || h.protocol !== protocol ||
      !uuid(h.warehouse_id) || !uuid(h.series_id) || !['PW','RW'].includes(h.kind ?? '') ||
      !Number.isInteger(h.year) || h.year! < 1 || h.year! > 9999 || !positive(h.sequence) || !positive(h.quantity) ||
      !Number.isInteger(h.row_count) || h.row_count! < 1 || h.row_count! > 10000 || typeof h.wms_enabled !== 'boolean' ||
      typeof h.number !== 'string' || h.number.length > 300 || /[\u0000-\u001f\u007f]/.test(h.number) ||
      !h.number.endsWith(`/${h.year}/${h.sequence.padStart(6,'0')}`) || h.number.split('/').slice(0,-2).join('/').trim().length === 0 ||
      typeof h.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(h.created_at) ||
      !Number.isFinite(Date.parse(h.created_at)) || ids.has(h.id) || pairs.has(`${h.warehouse_id}:${h.kind}`) ||
      (receipt !== undefined && receipt !== h.receipt_id) || (wms !== undefined && wms !== h.wms_enabled)) return bad;
    ids.add(h.id); pairs.add(`${h.warehouse_id}:${h.kind}`); receipt = h.receipt_id; wms = h.wms_enabled;
  }
  return <section aria-label="Dokumenty rozliczenia pomiaru">
    <h3>Dokumenty rozliczenia pomiaru</h3>
    <p className="muted">Wystawione PW i RW opisują zapisane różnice pomiaru. Odczyt dokumentów nie zmienia ponownie zapasu.</p>
    <div className="table-scroll"><table><thead><tr>
      <th>Dokument</th><th>Magazyn</th><th>Ilość fizyczna</th><th>Pozycje dokumentu</th><th>Wystawiono</th>
    </tr></thead><tbody>{(documents as Head[]).map(h => {
      const warehouse = warehouses.find(w => w.id === h.warehouse_id);
      return <tr key={h.id}><td><strong>{h.number}</strong></td>
        <td>{warehouse ? <>{warehouse.name} <small>{warehouse.code}</small></> : h.warehouse_id}</td>
        <td>{BigInt(h.quantity).toLocaleString('pl-PL')}</td><td>{h.row_count}</td><td>{date(h.created_at)}</td></tr>;
    })}</tbody></table></div>
  </section>;
}
