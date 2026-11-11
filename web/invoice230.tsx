import './invoice230.css';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { Fa3DownloadButton } from './fa3-download';
import { KsefDocumentStatus } from './ksef229';
import { Invoice232Panel } from './invoice232';
import { EU_VAT_PREFIX, checkEuVatId, normalizeNip } from '../server/invoice230-model';
import type { Invoice230Document, Invoice230Snapshot } from '../server/invoice230';
import { invoicePartyOf, invoicePartyPolishNip, type InvoiceSectionValues } from '../shared/order-invoice-party';

/** Invoices 230 (FV-S): B2B buyers, EUR with the NBP rate, ZW/NP/OO/OSS lines. The server computes
 * every amount and decides what may be issued; this view only collects the buyer, shows the
 * calculation and sends the confirmed preview to the shared tax-issue path. */
type Order = { id: string; version: string | number; status: string; currency: string; customer_name?: string;
  address?: { street?: string; postal_code?: string; city?: string; country?: string } | null;
  /** Card payload (Uwagi v3 §6): the invoice data edited on the card prefill the buyer. */
  section_values?: { invoice?: InvoiceSectionValues } };
type Flags = { can_write: boolean; read_only: boolean; current_role: string | null };
type Series = { id: string; name: string; prefix: string };
export type Invoice230BuyerType = 'consumer' | 'pl' | 'eu' | 'non_eu';
type Form = { seriesId: string; type: Invoice230BuyerType; name: string; street: string; postal_code: string; city: string; country: string;
  taxId: string; plVatPayer: boolean; shippingVat: 0 | 5 | 8 | 23; sellDate: string };
type CalcRequest = { series_id: string; order_version: string; shipping_vat: number; buyer: Record<string, unknown>; sell_date: string };
type Calculation = { request: CalcRequest; snapshot: Invoice230Snapshot; blockers: string[]; issuable: boolean };
type Preview = { id: string; scope_hash: string; snapshot: Invoice230Snapshot; expires_at: string };
type Attempt = { kind: 'preview' | 'issue'; path: string; body: Record<string, unknown>; preview?: Preview };

const UNAVAILABLE = 'Faktury szczególne (migracja 230) są niedostępne w tej kopii';
export const INVOICE230_BUYER_TYPES: readonly [Invoice230BuyerType, string][] = [
  ['consumer', 'Konsument'], ['pl', 'Firma z Polski (NIP)'], ['eu', 'Firma z UE (numer VAT UE)'], ['non_eu', 'Firma spoza UE'],
];
// A sent write whose answer was lost is kept per order, so the retry repeats exactly the same request.
const attempts = new Map<string, Attempt>();
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function requireData(ok: unknown): asserts ok { if (!ok) throw new Error('Niepełne lub obce dane faktury 230'); }
const todayUtc = () => new Date().toISOString().slice(0, 10);
const message = (e: unknown, fallback: string) => e instanceof ApiError && e.status === 503 ? UNAVAILABLE : e instanceof Error ? e.message : fallback;
/** The outcome of a write is unknown only without an answer, or with a server/timeout/rate-limit answer. */
const uncertain = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;

/** Minor units → "1 234,56 EUR" (non-breaking spaces); never through floating point. */
export function invoice230Money(minor: string, currency: string): string {
  if (typeof minor !== 'string' || !/^-?\d+$/.test(minor)) return '—';
  const v = BigInt(minor), abs = v < 0n ? -v : v, whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${v < 0n ? '-' : ''}${whole},${(abs % 100n).toString().padStart(2, '0')} ${currency}`;
}
const RATE_LABEL: Record<string, string> = { zw: 'zw', 'np I': 'np', 'np II': 'np', oo: 'oo', '0 KR': '0%' };
export const invoice230RateLabel = (l: { rate_code: string; rate: string | null }) =>
  l.rate_code === 'oss' ? `${(l.rate ?? '').replace(/\.00$/, '').replace('.', ',')}% (OSS)` : RATE_LABEL[l.rate_code] ?? `${l.rate_code}%`;

const countryOf = (f: Form) => f.type === 'pl' ? 'PL' : f.country.trim().toUpperCase();
/** Light client-side checks; the server validates again and stays the authority. */
export function invoice230FormProblems(f: Form, series: readonly Series[]): string[] {
  const out: string[] = [], c = countryOf(f);
  if (!series.some(s => s.id === f.seriesId)) out.push('Wybierz serię faktur');
  if (!f.name.trim()) out.push(f.type === 'consumer' ? 'Podaj imię i nazwisko nabywcy' : 'Podaj nazwę firmy');
  if (!f.street.trim()) out.push('Podaj ulicę i numer');
  if (!f.postal_code.trim()) out.push('Podaj kod pocztowy');
  if (!f.city.trim()) out.push('Podaj miejscowość');
  if (!/^[A-Z]{2}$/.test(c)) out.push('Kraj: dwuliterowy kod ISO, np. DE');
  else if (f.type === 'eu' && !EU_VAT_PREFIX[c]) out.push(c === 'PL' ? 'Firma z Polski: wybierz rodzaj „Firma z Polski (NIP)”' : `${c} nie jest państwem UE — wybierz „Firma spoza UE”`);
  else if (f.type === 'non_eu' && (c === 'PL' || EU_VAT_PREFIX[c])) out.push(`${c} należy do UE — wybierz firmę z Polski albo z UE`);
  if (f.type === 'pl' && !normalizeNip(f.taxId)) out.push('Niepoprawny NIP nabywcy (10 cyfr z cyfrą kontrolną)');
  if (f.type === 'eu' && EU_VAT_PREFIX[c]) {
    if (!f.taxId.trim()) out.push('Podaj numer VAT UE nabywcy');
    else { const r = checkEuVatId(c, f.taxId); if (!r.ok) out.push(r.reason); }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.sellDate)) out.push('Podaj datę sprzedaży');
  return out;
}
export function invoice230BuyerBody(f: Form): Record<string, unknown> {
  const address = { street: f.street.trim(), postal_code: f.postal_code.trim(), city: f.city.trim(), country: countryOf(f) };
  if (f.type === 'consumer') return { kind: 'consumer', name: f.name.trim(), address };
  return { kind: 'business', name: f.name.trim(), address, tax_id: f.type === 'non_eu' ? '' : f.taxId.trim(), pl_vat_payer: f.type === 'pl' && f.plVatPayer };
}

function validSnapshot(s: any): Invoice230Snapshot {
  requireData(s && s.format === 'invoice230/v1' && ['PLN', 'EUR'].includes(s.currency) && Array.isArray(s.lines) && Array.isArray(s.categories) && s.totals && s.mpp && s.buyer?.address && s.seller);
  return s;
}
function validDocument(d: any, orderId?: string): Invoice230Document {
  requireData(d && uuid(d.id) && uuid(d.order_id) && (!orderId || d.order_id === orderId) && d.kind === 'invoice' && d.mode === 'invoice230' && typeof d.number === 'string' && d.data?.number === d.number);
  validSnapshot(d.data); return d;
}
function validFlags(v: any): Flags {
  requireData(v && typeof v.can_write === 'boolean' && typeof v.read_only === 'boolean');
  return { can_write: v.can_write, read_only: v.read_only, current_role: v.current_role ?? null };
}

function Badges({ s }: { s: Invoice230Snapshot }) {
  const marks = [s.mpp.required && 'MPP — mechanizm podzielonej płatności', s.reverse_charge && 'Odwrotne obciążenie',
    s.exemption && `Zwolnienie: ${s.exemption.basis}`, s.procedure === 'oss' && 'OSS'].filter((m): m is string => Boolean(m));
  return marks.length ? <p className="invoice230-badges">{marks.map(m => <span key={m} className="invoice230-badge">{m}</span>)}</p> : null;
}
function Buyer({ s }: { s: Invoice230Snapshot }) {
  const b = s.buyer, tax = b.tax_id_kind === 'nip' ? `NIP: ${b.tax_id}` : b.tax_id_kind === 'eu_vat' ? `Numer VAT UE: ${b.tax_id}` : null;
  return <p>Nabywca: <strong>{b.name}</strong><br />{b.address.street}, {b.address.postal_code} {b.address.city}, {b.address.country}
    {tax && <><br />{tax}</>}{b.pl_vat_payer && <><br />Czynny podatnik VAT w Polsce</>}</p>;
}
/** Lines, the FA(3) category summary, totals and, for EUR, the NBP line with PLN amounts. */
function SnapshotView({ s }: { s: Invoice230Snapshot }) {
  const money = (v: string) => invoice230Money(v, s.currency), pln = (v: string) => invoice230Money(v, 'PLN'), n = s.nbp;
  return <div className="invoice230-snapshot">
    <Badges s={s} />
    <div className="table-scroll"><table aria-label="Pozycje faktury"><thead><tr><th>Pozycja</th><th className="num">Ilość</th><th>Stawka</th><th className="num">Netto</th><th className="num">VAT</th><th className="num">Brutto</th></tr></thead>
      <tbody>{s.lines.map(l => <tr key={l.line_no}><td>{l.name}{l.sku && <small>{l.sku}</small>}</td><td className="num">{l.quantity} {l.unit}</td><td>{invoice230RateLabel(l)}</td>
        <td className="num">{money(l.net_minor)}</td><td className="num">{money(l.vat_minor)}</td><td className="num">{money(l.gross_minor)}</td></tr>)}</tbody></table></div>
    <h4>Podsumowanie według kategorii</h4>
    <div className="table-scroll"><table aria-label="Podsumowanie według kategorii"><thead><tr><th>Kategoria</th><th>Pole FA(3)</th><th className="num">Netto</th><th className="num">VAT</th><th className="num">Brutto</th>{n && <th className="num">VAT w PLN</th>}</tr></thead>
      <tbody>{s.categories.map(c => { const p = n?.categories.find(x => x.key === c.key); return <tr key={c.key}><td>{c.label}</td><td>{c.fa3_vat ? `${c.fa3_net} / ${c.fa3_vat}` : c.fa3_net}</td>
        <td className="num">{money(c.net_minor)}</td><td className="num">{c.fa3_vat ? money(c.vat_minor) : '—'}</td><td className="num">{money(c.gross_minor)}</td>{n && <td className="num">{p ? pln(p.vat_pln_minor) : '—'}</td>}</tr>; })}</tbody></table></div>
    <p className="invoice230-totals">Netto {money(s.totals.net_minor)} · VAT {money(s.totals.vat_minor)} · <strong>Do zapłaty {money(s.totals.gross_minor)}</strong></p>
    {n && <p className="invoice230-nbp">{n.line}<br />Kwoty w PLN: netto {pln(n.totals.net_pln_minor)} · VAT {pln(n.totals.vat_pln_minor)} · brutto {pln(n.totals.gross_pln_minor)}</p>}
    <p className="muted">MPP: {s.mpp.reason}</p>
  </div>;
}
/** Shared with the 157 panel past its limit (local-invoice-overflow.tsx). */
export const Invoice230SnapshotView = SnapshotView;
const printHref = (id: string) => `/api/invoice230/documents/${id}/print`;
function DocumentView({ d, workspaceId, role, readOnly, contextKey, onChanged }: { d: Invoice230Document; workspaceId: string; role: string; readOnly: boolean; contextKey: string; onChanged?: () => void }) {
  const s = d.data;
  return <article className="invoice230-document" aria-label={`Faktura ${d.number}`}>
    <h4>Faktura {d.number}</h4>
    <p>Wystawiona {s.issue_date} · data sprzedaży {s.sell_date} · płatność do {s.due_date} · waluta {s.currency}.</p>
    <Buyer s={s} />
    <SnapshotView s={s} />
    <p className="invoice230-actions"><a className="button" href={printHref(d.id)} target="_blank" rel="noreferrer">Drukuj</a><Fa3DownloadButton documentId={d.id} workspaceId={workspaceId} number={d.number} /></p>
    <KsefDocumentStatus key={d.id} documentId={d.id} workspaceId={workspaceId} role={role} readOnly={readOnly} />
    <Invoice232Panel key={'kor232:' + d.id} documentId={d.id} contextKey={contextKey} readOnly={readOnly} onChanged={onChanged} />
  </article>;
}

type PanelProps = { order: Order; contextKey: string; readOnly: boolean; refresh?: unknown; externalWriteBlocked?: boolean; onChanged?: () => void };
const blankForm = (o: Order): Form => ({ seriesId: '', type: 'consumer', name: o.customer_name ?? '', street: o.address?.street ?? '', postal_code: o.address?.postal_code ?? '',
  city: o.address?.city ?? '', country: (o.address?.country ?? 'PL').toUpperCase(), taxId: '', plVatPayer: false, shippingVat: 23, sellDate: todayUtc() });
/** Prefill only: the invoice data edited on the order card (buyer, NIP, address), otherwise the order customer. */
export function invoice230InitialForm(o: Order): Form {
  const p = invoicePartyOf(o, o.section_values?.invoice), blank = blankForm(o);
  if (p.source === 'order') return blank;
  const c = p.address.country, nip = invoicePartyPolishNip(p);
  const type: Invoice230BuyerType = !p.tax_id ? 'consumer' : c === 'PL' ? 'pl' : EU_VAT_PREFIX[c] ? 'eu' : 'non_eu';
  return { ...blank, type, name: p.name, ...p.address, taxId: type === 'pl' ? nip || p.tax_id : type === 'eu' ? p.tax_id : '' };
}

/** The FV-S invoice of one order: the issued document, or the form, calculation, preview and issue. */
export function Invoice230Panel({ order, contextKey, readOnly, refresh, externalWriteBlocked = false, onChanged }: PanelProps) {
  const key = `${contextKey}:${order.id}`, workspaceId = contextKey.split(':')[0] ?? '';
  const epoch = useRef(0), round = useRef(0);
  const [flags, setFlags] = useState<Flags | null>(null), [unavailable, setUnavailable] = useState(false), [series, setSeries] = useState<Series[]>([]);
  const [issued, setIssued] = useState<Invoice230Document | null>(null), [form, setForm] = useState<Form>(() => invoice230InitialForm(order));
  const [calc, setCalc] = useState<Calculation | null>(null), [preview, setPreview] = useState<Preview | null>(null), [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(() => attempts.get(key) ?? null), [busy, setBusy] = useState(false), [error, setError] = useState('');

  async function run(fn: (g: number) => Promise<void>, fallback: string) {
    if (busy) return;
    const g = epoch.current; setBusy(true); setError('');
    try { await fn(g); } catch (e) { if (g === epoch.current) setError(message(e, fallback)); } finally { if (g === epoch.current) setBusy(false); }
  }
  async function load(g: number) {
    setIssued(null); setCalc(null); setPreview(null); setConsent(false); setUnavailable(false);
    let v: any;
    try { v = await api(`/invoice230/documents?order_id=${encodeURIComponent(order.id)}`); }
    catch (e) { if (g === epoch.current && e instanceof ApiError && e.status === 503) { setUnavailable(true); return; } throw e; }
    if (g !== epoch.current) return;
    const f = validFlags(v); requireData(Array.isArray(v.data));
    const docs = v.data.map((d: any) => validDocument(d, order.id));
    setFlags(f); setIssued(docs[0] ?? null);
    if (docs.length) { attempts.delete(key); setPending(null); return; }
    const s = await api('/local-invoices/series');
    if (g !== epoch.current) return;
    requireData(Array.isArray(s.data));
    setSeries(s.data.filter((x: any) => uuid(x?.id) && typeof x.name === 'string' && typeof x.prefix === 'string').map((x: any) => ({ id: x.id, name: x.name, prefix: x.prefix })));
  }
  useEffect(() => {
    epoch.current++; round.current++; setFlags(null); setSeries([]); setError(''); setBusy(false); setPending(attempts.get(key) ?? null);
    void run(load, 'Nie udało się odczytać faktur 230');
    return () => { epoch.current++; };
  }, [contextKey, readOnly, refresh, order.id, order.version]);
  useEffect(() => { setForm(invoice230InitialForm(order)); }, [contextKey, order.id]);

  function edit(patch: Partial<Form>) { round.current++; setForm(f => ({ ...f, ...patch })); setCalc(null); setPreview(null); setConsent(false); }
  function changeType(type: Invoice230BuyerType) {
    const country = type === 'pl' ? 'PL' : type === 'consumer' ? form.country : form.country === 'PL' ? '' : form.country;
    edit({ type, country, taxId: '', plVatPayer: false });
  }
  const request = (): CalcRequest => ({ series_id: form.seriesId, order_version: String(order.version), shipping_vat: form.shippingVat, buyer: invoice230BuyerBody(form), sell_date: form.sellDate });
  async function calculate(g: number) {
    const r = round.current, body = request();
    const v = await api(`/invoice230/orders/${order.id}/calculate`, 'POST', body);
    if (g !== epoch.current || r !== round.current) return;
    requireData(v && v.order_id === order.id && v.order_version === body.order_version && Array.isArray(v.blockers) && typeof v.issuable === 'boolean');
    setFlags(validFlags(v));
    setCalc({ request: body, snapshot: validSnapshot(v.snapshot), blockers: v.blockers.map(String), issuable: v.issuable && v.blockers.length === 0 });
  }
  async function send(a: Attempt, g: number) {
    attempts.set(key, a); setPending(a);
    let v: any;
    try { v = await api(a.path, 'POST', a.body); }
    catch (e) { if (!uncertain(e) && attempts.get(key) === a) { attempts.delete(key); if (g === epoch.current) setPending(null); } throw e; }
    if (attempts.get(key) === a) attempts.delete(key);
    if (g !== epoch.current) return;
    setPending(null);
    if (a.kind === 'preview') {
      const p = v?.preview;
      requireData(p && uuid(p.id) && hash(p.scope_hash) && Number.isFinite(Date.parse(p.expires_at)));
      setPreview({ id: p.id, scope_hash: p.scope_hash, snapshot: validSnapshot(p.snapshot), expires_at: p.expires_at }); setConsent(false);
    } else {
      requireData(v?.invoice230 === true);
      const d = validDocument(v.document, order.id);
      setIssued(d); setCalc(null); setPreview(null); setConsent(false); onChanged?.();
    }
  }

  const eligible = ['shipped', 'delivered'].includes(order.status) && ['PLN', 'EUR'].includes(order.currency);
  const canWrite = Boolean(flags?.can_write) && !flags?.read_only && !readOnly && !externalWriteBlocked;
  const writeReason = readOnly || flags?.read_only ? 'Kopia tylko do odczytu — możesz przeliczyć fakturę, ale nie wystawisz jej tutaj.'
    : flags && !flags.can_write ? `Rola ${flags.current_role ?? 'bez uprawnień'} pozwala tylko przeliczyć fakturę.`
      : externalWriteBlocked ? 'Trwa inny zapis zamówienia — wystawienie jest chwilowo wstrzymane.' : '';
  const problems = invoice230FormProblems(form, series), shown = preview?.snapshot ?? calc?.snapshot ?? null;
  const expired = preview ? Date.parse(preview.expires_at) <= Date.now() : false;
  const field = (k: 'name' | 'street' | 'postal_code' | 'city', label: string, max: number) =>
    <label>{label}<input value={form[k]} maxLength={max} onChange={e => edit({ [k]: e.target.value })} /></label>;

  return <section className="invoice230-panel" aria-label="Faktura VAT 230">
    <p className="muted">Faktura dla firmy (NIP, numer VAT UE), w EUR z kursem NBP oraz z pozycjami zw, np, oo lub OSS. Numeracja FV-S; wystawioną fakturę wyślesz do KSeF z jej sekcji KSeF.</p>
    {error && <p role="alert">{error}</p>}
    {unavailable && <p className="notice">{UNAVAILABLE}</p>}
    {!flags && !unavailable && !error && <p role="status">Odczytywanie faktur 230…</p>}
    {pending && <div className="invoice230-pending" role="status"><p>Wynik {pending.kind === 'issue' ? 'wystawienia faktury' : 'przygotowania podglądu'} nie został potwierdzony. Ponów to samo żądanie — serwer nie utworzy drugiego dokumentu.</p>
      <button type="button" className="button" disabled={busy || !canWrite} onClick={() => void run(g => send(pending, g), 'Nie udało się ponowić żądania')}>Ponów to samo żądanie</button></div>}
    {issued && <DocumentView d={issued} workspaceId={workspaceId} role={contextKey.split(':')[2] ?? ''} readOnly={readOnly || Boolean(flags?.read_only)} contextKey={contextKey} onChanged={onChanged} />}
    {flags && !issued && !eligible && <p>{!['shipped', 'delivered'].includes(order.status) ? 'Fakturę wystawisz po wysłaniu lub dostarczeniu zamówienia.' : `Waluta ${order.currency} nie jest obsługiwana — faktura 230 obsługuje PLN i EUR.`}</p>}
    {flags && !issued && eligible && <>
      <fieldset className="invoice230-fields" disabled={busy || Boolean(pending)}><legend>Dane faktury</legend>
        <label>Seria<select value={form.seriesId} onChange={e => edit({ seriesId: e.target.value })}><option value="">Wybierz serię</option>{series.map(s => <option key={s.id} value={s.id}>{s.name} (FV-S/{s.prefix})</option>)}</select></label>
        <label>Rodzaj nabywcy<select value={form.type} onChange={e => changeType(e.target.value as Invoice230BuyerType)}>{INVOICE230_BUYER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        {field('name', form.type === 'consumer' ? 'Imię i nazwisko' : 'Nazwa', 200)}
        {field('street', 'Ulica i numer', 200)}
        {field('postal_code', 'Kod pocztowy', 30)}
        {field('city', 'Miejscowość', 100)}
        <label>Kraj<input value={countryOf(form)} maxLength={2} readOnly={form.type === 'pl'} onChange={e => edit({ country: e.target.value.toUpperCase() })} /></label>
        {form.type === 'pl' && <label>NIP<input value={form.taxId} maxLength={20} onChange={e => edit({ taxId: e.target.value })} /></label>}
        {form.type === 'eu' && <label>Numer VAT UE<input value={form.taxId} maxLength={40} placeholder={EU_VAT_PREFIX[countryOf(form)] ? `${EU_VAT_PREFIX[countryOf(form)]}…` : undefined} onChange={e => edit({ taxId: e.target.value })} /></label>}
        {form.type === 'pl' && <label className="invoice230-check"><input type="checkbox" checked={form.plVatPayer} onChange={e => edit({ plVatPayer: e.target.checked })} />Czynny podatnik VAT w Polsce (wymagany dla odwrotnego obciążenia)</label>}
        <label>Stawka VAT dostawy<select value={form.shippingVat} onChange={e => edit({ shippingVat: Number(e.target.value) as Form['shippingVat'] })}>{[0, 5, 8, 23].map(v => <option key={v} value={v}>{v}%</option>)}</select></label>
        <label>Data sprzedaży<input type="date" value={form.sellDate} onChange={e => edit({ sellDate: e.target.value })} /></label>
        {!series.length && <p className="muted">Brak serii faktur — administrator dodaje serię w Dokumentach.</p>}
        {problems.length > 0 && <ul className="invoice230-problems" aria-label="Brakujące dane">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
        <button type="button" className="button primary" disabled={busy || problems.length > 0} onClick={() => void run(calculate, 'Nie udało się przeliczyć faktury')}>Przelicz</button>
      </fieldset>
      {shown && <section className="invoice230-calculation" aria-label="Wynik przeliczenia">
        <h4>{preview ? 'Podgląd przed wystawieniem' : 'Przeliczenie faktury'}</h4>
        <Buyer s={shown} />
        <SnapshotView s={shown} />
        {calc && calc.blockers.length > 0 && <div className="invoice230-blockers" role="alert"><p><strong>Faktury nie można wystawić:</strong></p><ul>{calc.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
        {writeReason && <p className="muted invoice230-write-reason">{writeReason}</p>}
        {!preview && <button type="button" className="button" disabled={busy || !calc?.issuable || !canWrite || Boolean(pending)}
          onClick={() => calc && void run(g => send({ kind: 'preview', path: `/invoice230/orders/${order.id}/previews`, body: { client_key: crypto.randomUUID(), ...calc.request } }, g), 'Nie udało się przygotować podglądu')}>Przygotuj podgląd</button>}
        {preview && <>
          <p>Numer FV-S zostanie nadany przy wystawieniu. {expired ? 'Podgląd wygasł — przelicz fakturę ponownie.' : `Podgląd ważny do ${new Date(preview.expires_at).toLocaleString('pl-PL')}.`}</p>
          <label className="invoice230-check"><input type="checkbox" checked={consent} disabled={!canWrite || expired || Boolean(pending)} onChange={e => setConsent(e.target.checked)} />Sprawdziłem dane i zatwierdzam wystawienie faktury.</label>
          <button type="button" className="button primary" disabled={busy || !canWrite || !consent || expired || Boolean(pending)}
            onClick={() => void run(g => send({ kind: 'issue', preview, path: `/local-invoices/previews/${preview.id}/tax-issue`, body: { client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true, local_only: true } }, g), 'Nie udało się wystawić faktury')}>Wystaw fakturę</button>
        </>}
      </section>}
    </>}
    {flags && <button type="button" className="text-button" disabled={busy} onClick={() => void run(load, 'Nie udało się odczytać faktur 230')}>Odśwież</button>}
  </section>;
}

/** The last FV-S invoices (server limit 50) for the documents view. */
export function Invoice230Register({ contextKey, readOnly, refresh }: { contextKey: string; readOnly: boolean; refresh?: unknown }) {
  const workspaceId = contextKey.split(':')[0] ?? '';
  const [rows, setRows] = useState<Invoice230Document[] | null>(null), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let alive = true; setRows(null); setError(''); setUnavailable(false);
    api('/invoice230/documents').then(v => { if (!alive) return; requireData(Array.isArray(v?.data)); setRows(v.data.map((d: any) => validDocument(d))); })
      .catch(e => { if (!alive) return; if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(message(e, 'Nie udało się odczytać faktur 230')); });
    return () => { alive = false; };
  }, [contextKey, readOnly, refresh]);
  return <section className="panel invoice230-panel" aria-label="Faktury VAT 230">
    <h3>Faktury VAT FV-S (B2B, EUR, ZW/NP/OO/OSS)</h3>
    {error && <p role="alert">{error}</p>}
    {unavailable && <p className="notice">{UNAVAILABLE}</p>}
    {!rows && !error && !unavailable && <p role="status">Odczytywanie faktur 230…</p>}
    {rows && !rows.length && <p className="muted">Brak wystawionych faktur FV-S.</p>}
    {rows && rows.length > 0 && <div className="table-scroll"><table><thead><tr><th>Faktura</th><th>Data wystawienia</th><th>Nabywca</th><th className="num">Brutto</th><th /></tr></thead>
      <tbody>{rows.map(d => <tr key={d.id}><td>{d.number}<small>Zamówienie {d.data.order.number}</small></td><td>{d.data.issue_date}</td><td>{d.data.buyer.name}<small>{d.data.buyer.address.country}{d.data.buyer.tax_id ? ` · ${d.data.buyer.tax_id}` : ''}</small></td>
        <td className="num">{invoice230Money(d.data.totals.gross_minor, d.data.currency)}</td>
        <td><a className="text-button" href={printHref(d.id)} target="_blank" rel="noreferrer">Drukuj</a><Fa3DownloadButton documentId={d.id} workspaceId={workspaceId} number={d.number} /></td></tr>)}</tbody></table></div>}
  </section>;
}
