import './invoice232.css';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { Fa3DownloadButton } from './fa3-download';
import { KsefDocumentStatus } from './ksef229';
import { invoice230Money, invoice230RateLabel } from './invoice230';
import { CORRECTION_REASONS, type CorrectionReason } from '../server/invoice232-model';
import type { Invoice232Document, Invoice232Snapshot } from '../server/invoice232';

/** KOR-S corrections (232) of a FV-S invoice: the editor (lines, a received return or a cancellation),
 * the calculation and preview the server computes, the issue, and the register. The server decides every
 * amount and what may be issued; this view only collects the change and shows the result. */
type Flags = { can_write: boolean; read_only: boolean; current_role: string | null };
type StateLine = { line_no: number; kind: 'item' | 'shipping'; sku: string; name: string; unit: string; rate_code: string; rate: string | null;
  current: { quantity: number; gross_minor: string } };
type ReturnSource = { id: string; number: string; state: string; received: boolean; corrected_by: string | null };
type State = { original: { id: string; number: string; currency: 'PLN' | 'EUR' }; lines: StateLine[]; current_gross_minor: string; next_position: number;
  corrections: { position: number; number: string; reason: string; delta_gross_minor: string; issue_date: string }[]; returns: ReturnSource[] };
export type Invoice232Mode = 'manual' | 'return' | 'cancellation';
export type Invoice232LineDraft = { line_no: number; quantity: string; gross: string };
export type Invoice232Draft = { mode: Invoice232Mode; reason: CorrectionReason; note: string; returnId: string; lines: Invoice232LineDraft[] };
type Calculation = { correction: Record<string, unknown>; snapshot: Invoice232Snapshot; blockers: string[]; issuable: boolean };
type Preview = { id: string; scope_hash: string; snapshot: Invoice232Snapshot; expires_at: string };
type Attempt = { kind: 'preview' | 'issue'; path: string; body: Record<string, unknown> };

const UNAVAILABLE = 'Korekty faktur FV-S (migracja 232) są niedostępne w tej kopii';
export const INVOICE232_MANUAL_REASONS = (Object.keys(CORRECTION_REASONS) as CorrectionReason[]).filter(r => r !== 'zwrot' && r !== 'anulowanie');
const attempts = new Map<string, Attempt>();
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function requireData(ok: unknown): asserts ok { if (!ok) throw new Error('Niepełne lub obce dane korekty 232'); }
const message = (e: unknown, fallback: string) => e instanceof ApiError && e.status === 503 ? UNAVAILABLE : e instanceof Error ? e.message : fallback;
const uncertain = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;

/** "1 234,56" / "1234.5" → minor units as a string; null when it is not a non-negative amount with at most 2 decimals. */
export function invoice232ParseAmount(text: string): string | null {
  const t = text.replace(/[\s ]/g, '').replace(',', '.');
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return String(BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0'));
}
const minorText = (minor: string) => { const v = BigInt(minor); return `${v / 100n},${(v % 100n).toString().padStart(2, '0')}`; };
export const invoice232BlankLines = (lines: readonly StateLine[]): Invoice232LineDraft[] =>
  lines.map(l => ({ line_no: l.line_no, quantity: String(l.current.quantity), gross: minorText(l.current.gross_minor) }));

/** Client checks of the editor; the server checks again and stays the authority. */
export function invoice232DraftProblems(d: Invoice232Draft, lines: readonly StateLine[]): string[] {
  if (d.mode === 'cancellation') return [];
  if (d.mode === 'return') return d.returnId ? [] : ['Wybierz przyjęty zwrot'];
  const out: string[] = [];
  if (d.reason === 'inna' && d.note.trim().length < 5) out.push('Przy przyczynie „Inna” opisz ją (co najmniej 5 znaków)');
  for (const x of d.lines) {
    const l = lines.find(y => y.line_no === x.line_no);
    if (!l) continue;
    if (!/^\d{1,6}$/.test(x.quantity.trim())) out.push(`${l.sku || l.name}: ilość po korekcie musi być liczbą całkowitą`);
    if (invoice232ParseAmount(x.gross) === null) out.push(`${l.sku || l.name}: wartość brutto po korekcie, np. 123,45`);
  }
  if (!out.length && !invoice232ChangedLines(d, lines).length) out.push('Zmień ilość lub wartość co najmniej jednej pozycji');
  return out;
}
/** Only the lines whose quantity or value differ from the current state. */
export function invoice232ChangedLines(d: Invoice232Draft, lines: readonly StateLine[]) {
  return d.lines.flatMap(x => {
    const l = lines.find(y => y.line_no === x.line_no), q = Number(x.quantity.trim()), g = invoice232ParseAmount(x.gross);
    if (!l || g === null || !Number.isInteger(q)) return [];
    return q === l.current.quantity && g === l.current.gross_minor ? [] : [{ line_no: l.line_no, quantity: q, gross_minor: g }];
  });
}
export function invoice232CorrectionBody(d: Invoice232Draft, lines: readonly StateLine[]): Record<string, unknown> {
  const note = d.note.trim();
  if (d.mode === 'cancellation') return { mode: 'cancellation', reason_note: note };
  if (d.mode === 'return') return { mode: 'return', return_id: d.returnId, reason_note: note };
  return { mode: 'manual', reason_code: d.reason, reason_note: note, lines: invoice232ChangedLines(d, lines) };
}

function validFlags(v: any): Flags {
  requireData(v && typeof v.can_write === 'boolean' && typeof v.read_only === 'boolean');
  return { can_write: v.can_write, read_only: v.read_only, current_role: v.current_role ?? null };
}
function validSnapshot(s: any): Invoice232Snapshot {
  requireData(s && s.format === 'invoice232/v1' && Array.isArray(s.rows) && Array.isArray(s.categories) && s.totals?.delta && s.original?.number);
  return s;
}
function validDocument(d: any): Invoice232Document {
  requireData(d && uuid(d.id) && d.kind === 'correction' && d.mode === 'invoice232_correction' && typeof d.number === 'string' && d.data?.number === d.number);
  validSnapshot(d.data); return d;
}
function validState(v: any): State {
  requireData(v?.original && uuid(v.original.id) && Array.isArray(v.lines) && Array.isArray(v.corrections) && Array.isArray(v.returns));
  return v;
}
const printHref = (id: string) => `/api/invoice232/corrections/${id}/print`;

/** Before / after / difference of each line and category; EUR also in PLN at the invoice's rate. */
export function Invoice232SnapshotView({ s }: { s: Invoice232Snapshot }) {
  const money = (v: string) => invoice230Money(v, s.currency), pln = (v: string) => invoice230Money(v, 'PLN'), t = s.totals;
  return <div className="invoice232-snapshot">
    <p>Korygowana faktura <strong>{s.original.number}</strong> z {s.original.issue_date}{s.original.ksef_number ? <> · numer KSeF {s.original.ksef_number}</> : ' · bez numeru KSeF'}.<br />
      Przyczyna: {s.reason}. {s.direction === 'increase' ? 'Korekta zwiększająca' : 'Korekta zmniejszająca'}, rozliczana w okresie {s.tax_period}.</p>
    <div className="table-scroll"><table aria-label="Pozycje korekty"><thead><tr><th>Pozycja</th><th>Stawka</th><th className="num">Przed</th><th className="num">Po</th><th className="num">Różnica brutto</th></tr></thead>
      <tbody>{s.rows.filter(r => r.delta.quantity !== 0 || r.delta.gross_minor !== '0').map(r => <tr key={r.line_no}><td>{r.name}{r.sku && <small>{r.sku}</small>}</td><td>{invoice230RateLabel(r)}</td>
        <td className="num">{r.before.quantity} {r.unit} · {money(r.before.gross_minor)}</td><td className="num">{r.after.quantity} {r.unit} · {money(r.after.gross_minor)}</td>
        <td className="num">{money(r.delta.gross_minor)}</td></tr>)}</tbody></table></div>
    <div className="table-scroll"><table aria-label="Różnice według kategorii"><thead><tr><th>Kategoria</th><th>Pole FA(3)</th><th className="num">Netto</th><th className="num">VAT</th><th className="num">Brutto</th>{s.pln_totals && <th className="num">VAT w PLN</th>}</tr></thead>
      <tbody>{s.categories.map(c => <tr key={c.key}><td>{c.label}</td><td>{c.fa3_vat ? `${c.fa3_net} / ${c.fa3_vat}` : c.fa3_net}</td><td className="num">{money(c.delta.net_minor)}</td>
        <td className="num">{c.fa3_vat ? money(c.delta.vat_minor) : '—'}</td><td className="num">{money(c.delta.gross_minor)}</td>{s.pln_totals && <td className="num">{c.pln ? pln(c.pln.delta.vat_pln_minor) : '—'}</td>}</tr>)}</tbody></table></div>
    <p className="invoice232-totals">Przed {money(t.before.gross_minor)} · po {money(t.after.gross_minor)} · <strong>różnica {money(t.delta.gross_minor)}</strong> (netto {money(t.delta.net_minor)}, VAT {money(t.delta.vat_minor)})</p>
    {s.nbp && s.pln_totals && <p className="invoice232-nbp">Kurs faktury korygowanej: 1 EUR = {s.nbp.mid.replace('.', ',')} PLN (tabela {s.nbp.table_no} z {s.nbp.rate_date}). Różnica w PLN: netto {pln(s.pln_totals.delta.net_pln_minor)} · VAT {pln(s.pln_totals.delta.vat_pln_minor)}</p>}
  </div>;
}

type PanelProps = { documentId: string; contextKey: string; readOnly: boolean; onChanged?: () => void };
/** Corrections of one issued FV-S invoice: the KOR-S list and the "Wystaw korektę" editor. */
export function Invoice232Panel({ documentId, contextKey, readOnly, onChanged }: PanelProps) {
  const key = `${contextKey}:${documentId}`, workspaceId = contextKey.split(':')[0] ?? '', role = contextKey.split(':')[2] ?? '';
  const epoch = useRef(0), round = useRef(0);
  const [flags, setFlags] = useState<Flags | null>(null), [state, setState] = useState<State | null>(null), [docs, setDocs] = useState<Invoice232Document[]>([]);
  const [unavailable, setUnavailable] = useState(false), [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Invoice232Draft>({ mode: 'manual', reason: 'obnizka_ceny', note: '', returnId: '', lines: [] });
  const [calc, setCalc] = useState<Calculation | null>(null), [preview, setPreview] = useState<Preview | null>(null), [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(() => attempts.get(key) ?? null), [busy, setBusy] = useState(false), [error, setError] = useState('');

  async function run(fn: (g: number) => Promise<void>, fallback: string) {
    if (busy) return;
    const g = epoch.current; setBusy(true); setError('');
    try { await fn(g); } catch (e) { if (g === epoch.current) setError(message(e, fallback)); } finally { if (g === epoch.current) setBusy(false); }
  }
  async function load(g: number) {
    setCalc(null); setPreview(null); setConsent(false); setUnavailable(false);
    let v: any;
    try { v = await api(`/invoice232/invoices/${documentId}`); }
    catch (e) { if (g === epoch.current && e instanceof ApiError && e.status === 503) { setUnavailable(true); return; } throw e; }
    const list = await api(`/invoice232/corrections?original_document_id=${encodeURIComponent(documentId)}`);
    if (g !== epoch.current) return;
    const s = validState(v); requireData(Array.isArray(list?.data));
    setFlags(validFlags(v)); setState(s); setDocs(list.data.map(validDocument));
    setDraft(d => ({ ...d, returnId: '', lines: invoice232BlankLines(s.lines) }));
  }
  useEffect(() => {
    epoch.current++; round.current++; setFlags(null); setState(null); setDocs([]); setError(''); setBusy(false); setOpen(false); setPending(attempts.get(key) ?? null);
    void run(load, 'Nie udało się odczytać korekt faktury');
    return () => { epoch.current++; };
  }, [contextKey, readOnly, documentId]);

  function edit(patch: Partial<Invoice232Draft>) { round.current++; setDraft(d => ({ ...d, ...patch })); setCalc(null); setPreview(null); setConsent(false); }
  function editLine(lineNo: number, patch: Partial<Invoice232LineDraft>) { edit({ lines: draft.lines.map(l => l.line_no === lineNo ? { ...l, ...patch } : l) }); }
  async function calculate(g: number, d = draft) {
    const r = round.current, correction = invoice232CorrectionBody(d, state?.lines ?? []);
    const v = await api(`/invoice232/invoices/${documentId}/calculate`, 'POST', correction);
    if (g !== epoch.current || r !== round.current) return;
    requireData(v && v.original_document_id === documentId && Array.isArray(v.blockers));
    setFlags(validFlags(v));
    setCalc({ correction, snapshot: validSnapshot(v.snapshot), blockers: v.blockers.map(String), issuable: v.issuable === true && v.blockers.length === 0 });
  }
  /** "Koryguj ze zwrotu": opens the editor on that return and calculates at once. */
  function fromReturn(id: string) {
    const d = { ...draft, mode: 'return' as const, returnId: id };
    setOpen(true); edit({ mode: 'return', returnId: id });
    void run(g => calculate(g, d), 'Nie udało się przeliczyć korekty');
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
      validDocument(v?.document);
      setOpen(false); onChanged?.(); await load(g);
    }
  }

  const canWrite = Boolean(flags?.can_write) && !flags?.read_only && !readOnly;
  const writeReason = readOnly || flags?.read_only ? 'Kopia tylko do odczytu — możesz przeliczyć korektę, ale nie wystawisz jej tutaj.'
    : flags && !flags.can_write ? `Rola ${flags.current_role ?? 'bez uprawnień'} pozwala tylko przeliczyć korektę.` : '';
  const lines = state?.lines ?? [], problems = invoice232DraftProblems(draft, lines), shown = preview?.snapshot ?? calc?.snapshot ?? null;
  const expired = preview ? Date.parse(preview.expires_at) <= Date.now() : false, cur = state?.original.currency ?? 'PLN';
  const open230 = state ? BigInt(state.current_gross_minor) > 0n : false;
  const returnsToCorrect = (state?.returns ?? []).filter(r => r.received && !r.corrected_by);

  return <section className="invoice232-panel" aria-label="Korekty faktury">
    <h4>Korekty (KOR-S)</h4>
    {error && <p role="alert">{error}</p>}
    {unavailable && <p className="notice">{UNAVAILABLE}</p>}
    {!flags && !unavailable && !error && <p role="status">Odczytywanie korekt…</p>}
    {pending && <div className="invoice232-pending" role="status"><p>Wynik {pending.kind === 'issue' ? 'wystawienia korekty' : 'przygotowania podglądu korekty'} nie został potwierdzony. Ponów to samo żądanie — serwer nie utworzy drugiej korekty.</p>
      <button type="button" className="button" disabled={busy || !canWrite} onClick={() => void run(g => send(pending, g), 'Nie udało się ponowić żądania')}>Ponów to samo żądanie</button></div>}
    {state && <>
      {docs.length > 0 ? <ul className="invoice232-list" aria-label="Wystawione korekty">{docs.map(d => <li key={d.id}>
        <p><strong>{d.number}</strong> z {d.data.issue_date} · {d.data.reason} · różnica {invoice230Money(d.data.totals.delta.gross_minor, d.data.currency)}</p>
        <p className="invoice232-actions"><a className="button" href={printHref(d.id)} target="_blank" rel="noreferrer">Drukuj korektę</a><Fa3DownloadButton documentId={d.id} workspaceId={workspaceId} number={d.number} /></p>
        <KsefDocumentStatus key={d.id} documentId={d.id} workspaceId={workspaceId} role={role} readOnly={readOnly || Boolean(flags?.read_only)} />
      </li>)}</ul> : <p className="muted">Faktura nie ma korekt. Bieżąca wartość brutto: {invoice230Money(state.current_gross_minor, cur)}.</p>}
      {returnsToCorrect.length > 0 && <div className="invoice232-returns"><p>Przyjęte zwroty bez korekty:</p>
        {returnsToCorrect.map(r => <button key={r.id} type="button" className="button" disabled={busy || Boolean(pending)} onClick={() => fromReturn(r.id)}>Koryguj ze zwrotu {r.number}</button>)}</div>}
      {!open && open230 && <button type="button" className="button" disabled={busy || Boolean(pending)} onClick={() => setOpen(true)}>Wystaw korektę</button>}
      {!open230 && <p className="muted">Faktura jest skorygowana do zera — kolejna korekta nie jest możliwa.</p>}
    </>}
    {state && open && <>
      <fieldset className="invoice232-fields" disabled={busy || Boolean(pending)}><legend>Korekta nr {state.next_position} faktury {state.original.number}</legend>
        <label>Rodzaj korekty<select value={draft.mode} onChange={e => edit({ mode: e.target.value as Invoice232Mode })}>
          <option value="manual">Zmiana ilości lub ceny pozycji</option><option value="return">Ze zwrotu towaru</option><option value="cancellation">Anulowanie — korekta do zera</option></select></label>
        {draft.mode === 'manual' && <label>Przyczyna<select value={draft.reason} onChange={e => edit({ reason: e.target.value as CorrectionReason })}>
          {INVOICE232_MANUAL_REASONS.map(r => <option key={r} value={r}>{CORRECTION_REASONS[r].label}</option>)}</select></label>}
        {draft.mode === 'return' && <label>Zwrot<select value={draft.returnId} onChange={e => edit({ returnId: e.target.value })}><option value="">Wybierz zwrot</option>
          {state.returns.map(r => <option key={r.id} value={r.id} disabled={!r.received || Boolean(r.corrected_by)}>{r.number}{r.corrected_by ? ` (korekta ${r.corrected_by})` : r.received ? '' : ' (nieprzyjęty)'}</option>)}</select></label>}
        <label className="invoice232-wide">Opis przyczyny (opcjonalnie)<input value={draft.note} maxLength={200} onChange={e => edit({ note: e.target.value })} /></label>
        {draft.mode === 'manual' && <div className="table-scroll invoice232-wide"><table aria-label="Pozycje po korekcie"><thead><tr><th>Pozycja</th><th className="num">Teraz</th><th>Ilość po korekcie</th><th>Brutto po korekcie ({cur})</th></tr></thead>
          <tbody>{lines.map(l => { const d = draft.lines.find(x => x.line_no === l.line_no); return <tr key={l.line_no}><td>{l.name}{l.sku && <small>{l.sku}</small>}</td>
            <td className="num">{l.current.quantity} {l.unit} · {invoice230Money(l.current.gross_minor, cur)}</td>
            <td><input aria-label={`Ilość po korekcie: ${l.sku || l.name}`} inputMode="numeric" value={d?.quantity ?? ''} onChange={e => editLine(l.line_no, { quantity: e.target.value })} /></td>
            <td><input aria-label={`Brutto po korekcie: ${l.sku || l.name}`} inputMode="decimal" value={d?.gross ?? ''} onChange={e => editLine(l.line_no, { gross: e.target.value })} /></td></tr>; })}</tbody></table></div>}
        {draft.mode === 'cancellation' && <p className="invoice232-wide">Wszystkie pozycje zostaną skorygowane do zera (przyczyna: {CORRECTION_REASONS.anulowanie.label}).</p>}
        {problems.length > 0 && <ul className="invoice232-problems invoice232-wide" aria-label="Brakujące dane">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
        <p className="invoice232-actions invoice232-wide">
          <button type="button" className="button primary" disabled={busy || problems.length > 0} onClick={() => void run(g => calculate(g), 'Nie udało się przeliczyć korekty')}>Przelicz korektę</button>
          <button type="button" className="text-button" onClick={() => { setOpen(false); edit({}); }}>Anuluj</button></p>
      </fieldset>
      {shown && <section className="invoice232-calculation" aria-label="Wynik przeliczenia korekty">
        <h4>{preview ? 'Podgląd korekty przed wystawieniem' : 'Przeliczenie korekty'}</h4>
        <Invoice232SnapshotView s={shown} />
        {calc && calc.blockers.length > 0 && <div className="invoice232-blockers" role="alert"><p><strong>Korekty nie można wystawić:</strong></p><ul>{calc.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}
        {writeReason && <p className="muted invoice232-write-reason">{writeReason}</p>}
        {!preview && <button type="button" className="button" disabled={busy || !calc?.issuable || !canWrite || Boolean(pending)}
          onClick={() => calc && void run(g => send({ kind: 'preview', path: `/invoice232/invoices/${documentId}/previews`, body: { client_key: crypto.randomUUID(), correction: calc.correction } }, g), 'Nie udało się przygotować podglądu korekty')}>Przygotuj podgląd korekty</button>}
        {preview && <>
          <p>Numer KOR-S zostanie nadany przy wystawieniu. {expired ? 'Podgląd wygasł — przelicz korektę ponownie.' : `Podgląd ważny do ${new Date(preview.expires_at).toLocaleString('pl-PL')}.`}</p>
          <label className="invoice232-check"><input type="checkbox" checked={consent} disabled={!canWrite || expired || Boolean(pending)} onChange={e => setConsent(e.target.checked)} />Sprawdziłem różnice i zatwierdzam wystawienie korekty.</label>
          <button type="button" className="button primary" disabled={busy || !canWrite || !consent || expired || Boolean(pending)}
            onClick={() => void run(g => send({ kind: 'issue', path: `/invoice232/previews/${preview.id}/issue`, body: { client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true } }, g), 'Nie udało się wystawić korekty')}>Wystaw korektę KOR-S</button>
        </>}
      </section>}
    </>}
  </section>;
}

/** The last KOR-S corrections (server limit 100) for the documents view. */
export function Invoice232Register({ contextKey, readOnly, refresh }: { contextKey: string; readOnly: boolean; refresh?: unknown }) {
  const workspaceId = contextKey.split(':')[0] ?? '';
  const [rows, setRows] = useState<Invoice232Document[] | null>(null), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let alive = true; setRows(null); setError(''); setUnavailable(false);
    api('/invoice232/corrections').then(v => { if (!alive) return; requireData(Array.isArray(v?.data)); setRows(v.data.map(validDocument)); })
      .catch(e => { if (!alive) return; if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(message(e, 'Nie udało się odczytać korekt KOR-S')); });
    return () => { alive = false; };
  }, [contextKey, readOnly, refresh]);
  return <section className="panel invoice232-panel" aria-label="Korekty KOR-S">
    <h3>Korekty faktur FV-S (KOR-S)</h3>
    {error && <p role="alert">{error}</p>}
    {unavailable && <p className="notice">{UNAVAILABLE}</p>}
    {!rows && !error && !unavailable && <p role="status">Odczytywanie korekt…</p>}
    {rows && !rows.length && <p className="muted">Brak wystawionych korekt KOR-S.</p>}
    {rows && rows.length > 0 && <div className="table-scroll"><table><thead><tr><th>Korekta</th><th>Data</th><th>Faktura korygowana</th><th>Przyczyna</th><th className="num">Różnica brutto</th><th /></tr></thead>
      <tbody>{rows.map(d => <tr key={d.id}><td>{d.number}<small>Zamówienie {d.data.order.number}</small></td><td>{d.data.issue_date}</td><td>{d.data.original.number}<small>{d.data.buyer.name}</small></td>
        <td>{d.data.reason}</td><td className="num">{invoice230Money(d.data.totals.delta.gross_minor, d.data.currency)}</td>
        <td><a className="text-button" href={printHref(d.id)} target="_blank" rel="noreferrer">Drukuj</a><Fa3DownloadButton documentId={d.id} workspaceId={workspaceId} number={d.number} /></td></tr>)}</tbody></table></div>}
  </section>;
}
