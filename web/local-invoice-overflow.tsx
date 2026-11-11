/** The 157 panel past the company's lifetime limit of local invoices: the server answers the 157 preview
 * with a FV-S (230) preview and a note (server/invoice-overflow230.ts). This view checks that answer,
 * shows the note and the calculation, and issues it through the shared tax-issue path. */
import { Invoice230SnapshotView } from './invoice230';
import type { Invoice230Document, Invoice230Snapshot } from '../server/invoice230';

export type OverflowPreview = { preview: { id: string; order_id: string; scope_hash: string; expires_at: string; snapshot: Invoice230Snapshot }; note: string; path: string };
export type OverflowIssued = { document: Invoice230Document; note: string };
type PreviewBody = { series_id: string; order_version: string; shipping_vat: number; sell_date: string; buyer: { name: string; street: string; postal_code: string; city: string; country: string } };

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2000;
function requireValue(ok: unknown): asserts ok { if (!ok) throw new Error('Niepełne lub obce dane faktury FV-S'); }

/** A 157 preview answer is a FV-S preview only with the server's marks; anything else is not this module's. */
export const isOverflowAnswer = (v: unknown) => Boolean(v && typeof v === 'object' && (v as { invoice230?: unknown }).invoice230 === true);

/** The FV-S preview must be exactly the consumer sale the 157 form sent. */
export function readOverflowPreview(v: any, orderId: string, b: PreviewBody): OverflowPreview {
  const p = v?.preview, s = p?.snapshot;
  requireValue(v.invoice230 === true && v.series === 'FV-S' && text(v.series_note) && uuid(p?.id) && p.order_id === orderId && /^[a-f0-9]{64}$/.test(p.scope_hash) && Number.isFinite(Date.parse(p.expires_at)));
  requireValue(v.issue_path === `/local-invoices/previews/${p.id}/tax-issue` && s?.format === 'invoice230/v1' && s.currency === 'PLN' && s.procedure === 'domestic' && s.order?.version === b.order_version);
  requireValue(s.series?.id === b.series_id && s.sell_date === b.sell_date && s.buyer?.kind === 'consumer' && s.buyer.name === b.buyer.name
    && s.buyer.address?.street === b.buyer.street && s.buyer.address.postal_code === b.buyer.postal_code && s.buyer.address.city === b.buyer.city && s.buyer.address.country === b.buyer.country);
  requireValue(Array.isArray(s.lines) && s.lines.at(-1)?.kind === 'shipping' && s.lines.at(-1)?.vat_rate === b.shipping_vat);
  return { preview: p, note: v.series_note, path: '/local-invoices/previews/' + p.id + '/tax-issue' };
}
/** The issued FV-S document of that preview. */
export function readOverflowIssue(v: any, o: OverflowPreview): OverflowIssued {
  const d = v?.document;
  requireValue(v.invoice230 === true && text(v.series_note) && uuid(d?.id) && d.order_id === o.preview.order_id && d.kind === 'invoice' && d.mode === 'invoice230');
  requireValue(typeof d.number === 'string' && d.number.startsWith(`FV-S/${o.preview.snapshot.series.prefix}/`) && d.data?.number === d.number && d.data.preview_id === o.preview.id && d.data.scope_hash === o.preview.scope_hash);
  return { document: d, note: v.series_note };
}

type ReviewProps = { overflow: OverflowPreview; canWrite: boolean; busy: boolean; consent: boolean; onConsent: (v: boolean) => void; onIssue: () => void };
export function LocalInvoiceOverflowReview({ overflow: o, canWrite, busy, consent, onConsent, onIssue }: ReviewProps) {
  const expired = Date.parse(o.preview.expires_at) <= Date.now();
  return <article className="notice local-invoices-review" aria-label="Podgląd faktury FV-S">
    <h4>Podgląd przed wystawieniem — seria FV-S</h4>
    <p className="local-invoices-overflow-note" role="status"><strong>Seria FV-S.</strong> {o.note}</p>
    <Invoice230SnapshotView s={o.preview.snapshot} />
    <p>Numer FV-S zostanie nadany dopiero przy wystawieniu. Podgląd ważny do {new Date(o.preview.expires_at).toLocaleString('pl-PL')}.</p>
    <label className="local-invoices-check"><input type="checkbox" checked={consent} disabled={!canWrite || busy || expired} onChange={e => onConsent(e.target.checked)} />Sprawdziłem pełne dane i zatwierdzam wystawienie faktury w serii FV-S.</label>
    <button type="button" className="button primary" disabled={!canWrite || busy || !consent || expired} onClick={onIssue}>Wystaw fakturę FV-S</button>
  </article>;
}
export function LocalInvoiceOverflowIssued({ issued }: { issued: OverflowIssued }) {
  const d = issued.document;
  return <article className="local-invoices-detail local-invoices-overflow-issued" aria-label={`Faktura ${d.number}`}>
    <h4>Faktura {d.number}</h4>
    <p className="local-invoices-overflow-note" role="status">{issued.note}</p>
    <p>Wydruk, plik FA(3), wysyłka do KSeF i korekta KOR-S są w panelu „Faktura VAT: B2B, EUR, ZW/NP/OO/OSS” tego zamówienia.</p>
    <a className="button" href={`/api/invoice230/documents/${d.id}/print`} target="_blank" rel="noreferrer">Drukuj</a>
  </article>;
}
