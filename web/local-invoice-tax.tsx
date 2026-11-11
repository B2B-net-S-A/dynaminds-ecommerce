import './tax226.css';
import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { EXEMPTION_BASIS_KINDS, GTU_CODES, exemptionBasisKindLabels, npKindLabels } from './catalog-tax-profile';

/** Tax facts (226) of a local invoice: the preview's facts before issue and the
 * snapshot stored with the issued document. Every line must be the exact line of
 * the invoice it describes; anything else is refused as foreign data. */
type SourceLine = { kind: 'item' | 'shipping'; item_id: string | null; product_id: string | null; sku: string; name: string; vat_rate: number; gross_minor: string };
type Source = { buyer: { kind: string; address: { country: string } }; totals: { gross_minor: string }; lines: SourceLine[] };
export type TaxLine = {
  line_no: number; kind: 'item' | 'shipping'; item_id: string | null; product_id: string | null; sku: string; name: string;
  category: 'standard' | 'zw' | 'np' | 'oo'; rate: string | null; rate_code: string;
  exemption_basis_kind: string | null; exemption_basis: string | null; np_kind: string | null; gtu: string | null; annex15: boolean; profile_version: number | null;
};
export type TaxFacts = {
  buyer_kind: 'consumer' | 'business'; buyer_country: string; procedure: 'domestic' | 'oss'; oss_country: string | null;
  gross_minor: string; annex15_gross_minor: string; mpp_required: boolean; mpp_reason: string; lines: TaxLine[];
};
export type TaxSnapshot = TaxFacts & { captured_with_issue: boolean; captured_at: string };
type Access = { readOnly: boolean; role: string };

const text = (v: unknown): v is string => typeof v === 'string' && !/[\x00-\x1f\x7f-\x9f]/.test(v);
const filled = (v: unknown): v is string => text(v) && v.trim().length > 0;
const minor = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const stamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
function requireTax(ok: unknown): asserts ok { if (!ok) throw new Error('Niepełne lub obce dane podatkowe faktury'); }
function requireFlags(v: any, a: Access) {
  requireTax(v && v.available === true && v.can_read === true && v.read_only === a.readOnly && v.current_role === a.role && typeof v.can_write === 'boolean');
}
function validLine(l: any, s: SourceLine, lineNo: number) {
  const ordinary = s.vat_rate === 0 ? '0 KR' : String(s.vat_rate), item = s.kind === 'item';
  const rate = l.category === 'standard'
    ? l.rate_code === 'oss' ? typeof l.rate === 'string' && /^(0|[1-9][0-9]?)\.[0-9]{2}$/.test(l.rate) && Number(l.rate) <= 30 : l.rate === s.vat_rate.toFixed(2) && l.rate_code === ordinary
    : l.rate === null && l.rate_code === ({ zw: 'zw', oo: 'oo', np: l.np_kind === 'np_i' ? 'np I' : 'np II' } as Record<string, string>)[l.category];
  return l && l.line_no === lineNo && l.kind === s.kind && l.item_id === s.item_id && l.product_id === s.product_id && l.sku === s.sku && l.name === s.name
    && ['standard', 'zw', 'np', 'oo'].includes(l.category) && rate
    && (l.category === 'zw' ? (EXEMPTION_BASIS_KINDS as readonly string[]).includes(l.exemption_basis_kind) && filled(l.exemption_basis) && l.exemption_basis.length <= 256 : l.exemption_basis_kind === null && l.exemption_basis === null)
    && (l.category === 'np' ? ['np_i', 'np_ii'].includes(l.np_kind) : l.np_kind === null)
    && (l.gtu === null || item && GTU_CODES.includes(l.gtu)) && typeof l.annex15 === 'boolean' && (item || !l.annex15 && l.category === 'standard')
    && (l.profile_version === null || item && Number.isSafeInteger(l.profile_version) && l.profile_version > 0);
}
/** Header and lines; `complete` requires every invoice line (a stored snapshot), otherwise refused lines may be missing. */
function validateFacts(f: any, source: Source, complete: boolean): TaxFacts {
  requireTax(f && ['consumer', 'business'].includes(f.buyer_kind) && f.buyer_kind === source.buyer.kind && f.buyer_country === source.buyer.address.country && /^[A-Z]{2}$/.test(f.buyer_country));
  requireTax(f.gross_minor === source.totals.gross_minor && minor(f.annex15_gross_minor) && typeof f.mpp_required === 'boolean' && filled(f.mpp_reason) && Array.isArray(f.lines));
  requireTax(complete ? f.lines.length === source.lines.length : f.lines.length <= source.lines.length);
  let previous = 0, annex = 0n;
  for (const l of f.lines) {
    requireTax(Number.isSafeInteger(l?.line_no) && l.line_no > previous && l.line_no <= source.lines.length);
    const s = source.lines[l.line_no - 1]; requireTax(validLine(l, s, complete ? previous + 1 : l.line_no));
    previous = l.line_no; if (l.annex15) annex += BigInt(s.gross_minor);
  }
  const oss = f.lines.some((l: TaxLine) => l.rate_code === 'oss');
  requireTax(f.annex15_gross_minor === annex.toString() && f.procedure === (oss ? 'oss' : 'domestic') && f.oss_country === (oss ? f.buyer_country : null));
  return f;
}
export function readLocalInvoiceTaxFacts(value: unknown, preview: { id: string; snapshot: Source }, a: Access): { facts: TaxFacts; blockers: string[] } {
  const v = value as any; requireFlags(v, a);
  requireTax(v.preview_id === preview.id && Array.isArray(v.blockers) && v.blockers.length <= 200 && v.blockers.every(filled));
  const facts = validateFacts(v.facts, preview.snapshot, false);
  // Refused lines, special categories and MPP all stop the issue; the server must say so.
  requireTax(v.blockers.length > 0 || facts.lines.length === preview.snapshot.lines.length && !facts.mpp_required && facts.lines.every(l => l.category === 'standard'));
  return { facts, blockers: v.blockers };
}
export function readLocalInvoiceTaxSnapshot(value: unknown, data: Source): TaxSnapshot {
  const v = value as any; requireTax(v && typeof v.captured_with_issue === 'boolean' && stamp(v.captured_at));
  validateFacts(v, data, true); return v;
}
export function readLocalInvoiceDocumentTax(value: unknown, document: { id: string; data: Source }, a: Access): { tax: TaxSnapshot | null; note: string | null } {
  const v = value as any; requireFlags(v, a); requireTax(v.document_id === document.id);
  if (v.tax === null) { requireTax(filled(v.note)); return { tax: null, note: v.note }; }
  requireTax(v.note === null); return { tax: readLocalInvoiceTaxSnapshot(v.tax, document.data), note: null };
}

const categoryLabel: Record<string, string> = { standard: 'Zwykła stawka', zw: 'Zwolnienie ZW', np: 'Niepodlegające NP', oo: 'Odwrotne obciążenie OO' };
export const taxRateLabel = (l: Pick<TaxLine, 'rate' | 'rate_code'>) =>
  l.rate_code === 'oss' ? `OSS ${l.rate!.replace('.', ',')}%` : l.rate_code === '0 KR' ? '0% (KR)' : l.rate !== null ? l.rate_code + '%' : l.rate_code;
export function TaxFactsTable({ facts }: { facts: TaxFacts }) {
  return <>
    <div className="table-scroll"><table><thead><tr><th>Poz.</th><th>Pozycja / SKU</th><th>Kategoria</th><th>Stawka</th><th>Podstawa / rodzaj</th><th>GTU</th><th>Zał. 15</th></tr></thead>
      <tbody>{facts.lines.map(l => <tr key={l.line_no}><td>{l.line_no}</td><td>{l.name}<small>{l.sku}</small></td><td>{categoryLabel[l.category]}</td><td>{taxRateLabel(l)}</td>
        <td>{l.category === 'zw' ? `${exemptionBasisKindLabels[l.exemption_basis_kind!]}: ${l.exemption_basis}` : l.category === 'np' ? npKindLabels[l.np_kind!] : '—'}</td><td>{l.gtu ?? 'brak'}</td><td>{l.annex15 ? 'tak' : 'nie'}</td></tr>)}</tbody></table></div>
    <p>Procedura: {facts.procedure === 'oss' ? `OSS (${facts.oss_country})` : 'krajowa'} · nabywca: {facts.buyer_kind === 'consumer' ? 'konsument' : 'podatnik'}, {facts.buyer_country}</p>
    <p>MPP: {facts.mpp_required ? 'wymagany' : 'nie dotyczy'} — {facts.mpp_reason}</p>
  </>;
}

export type TaxGate = { previewId: string; issuable: boolean; path: string };
/** Tax facts of a preview. Reports whether it may be issued and through which path:
 * tax-issue with 226, the native issue when this copy has no tax model (503). */
export function LocalInvoiceTaxFacts({ preview, readOnly, role, onGate }: { preview: { id: string; snapshot: Source }; readOnly: boolean; role: string; onGate: (g: TaxGate) => void }) {
  const [state, setState] = useState<{ facts: TaxFacts; blockers: string[] } | null>(null), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(false), [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true; setState(null); setError(''); setUnavailable(false); onGate({ previewId: preview.id, issuable: false, path: '' });
    api(`/local-invoices/previews/${preview.id}/tax`).then(v => {
      if (!alive) return; const t = readLocalInvoiceTaxFacts(v, preview, { readOnly, role }); setState(t);
      onGate({ previewId: preview.id, issuable: t.blockers.length === 0, path: `/local-invoices/previews/${preview.id}/tax-issue` });
    }).catch(e => {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 503 && /Model podatkowy/.test(e.message)) { setUnavailable(true); onGate({ previewId: preview.id, issuable: true, path: `/local-invoices/previews/${preview.id}/issue` }); }
      else setError(e instanceof Error ? e.message : 'Nie udało się odczytać danych podatkowych');
    });
    return () => { alive = false; };
  }, [preview.id, readOnly, role, round]);
  return <section className="local-invoice-tax" aria-label="Dane podatkowe podglądu"><h4>Dane podatkowe</h4>
    {unavailable && <p className="muted">Model podatkowy niedostępny w tej kopii.</p>}
    {error && <p role="alert">{error}</p>}
    {!state && !error && !unavailable && <p role="status">Odczytywanie danych podatkowych…</p>}
    {state && <><TaxFactsTable facts={state.facts} />{state.blockers.length > 0 && <div role="alert"><p><strong>Wystawienie wstrzymane:</strong></p><ul>{state.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}</>}
    {(state || error) && <button type="button" className="text-button" onClick={() => setRound(n => n + 1)}>Odśwież dane podatkowe</button>}
  </section>;
}
/** Stored tax snapshot of an issued local invoice, or why it has none. */
export function LocalInvoiceDocumentTax({ document, readOnly, role }: { document: { id: string; data: Source }; readOnly: boolean; role: string }) {
  const [state, setState] = useState<{ tax: TaxSnapshot | null; note: string | null } | null>(null), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let alive = true; setState(null); setError(''); setUnavailable(false);
    api(`/local-invoices/documents/${document.id}/tax`).then(v => { if (alive) setState(readLocalInvoiceDocumentTax(v, document, { readOnly, role })); })
      .catch(e => { if (!alive) return; if (e instanceof ApiError && e.status === 503 && /Model podatkowy/.test(e.message)) setUnavailable(true); else setError(e instanceof Error ? e.message : 'Nie udało się odczytać danych podatkowych'); });
    return () => { alive = false; };
  }, [document.id, readOnly, role]);
  return <section className="local-invoice-tax" aria-label="Dane podatkowe faktury"><h4>Dane podatkowe (migawka z wystawienia)</h4>
    {unavailable && <p className="muted">Model podatkowy niedostępny w tej kopii.</p>}
    {error && <p role="alert">{error}</p>}
    {!state && !error && !unavailable && <p role="status">Odczytywanie danych podatkowych…</p>}
    {state?.tax && <><TaxFactsTable facts={state.tax} /><p className="muted">Zapisano {new Date(state.tax.captured_at).toLocaleString('pl-PL')}{state.tax.captured_with_issue ? ' przy wystawieniu' : ' przy ponowieniu wystawienia'}.</p></>}
    {state && !state.tax && <p>{state.note}</p>}
  </section>;
}
