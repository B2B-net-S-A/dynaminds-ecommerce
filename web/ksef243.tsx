import { useEffect, useState } from 'react';
import { api, ApiError, currentWorkspace } from './api';

/** 243 in the UI: Dokumenty → "Faktury zakupowe (KSeF)". Fetch state per NIP with "Pobierz teraz" and, for the
 * administrator, the fetch settings; the list with filters and paging, the detail (rates, KOR chain, workflow,
 * "Pobierz XML"), the accountant's package (CSV + FA(3) files) and refused files with "Pobierz ponownie".
 * This local build never connects to the Ministry of Finance: only the local test server. */
export type PurchaseSync = { nip: string; enabled: boolean; date_type: string; start_from: string | null; completed_up_to: string | null; window_open: boolean; running: boolean;
  last_run_at: string | null; last_ok_at: string | null; last_error: string | null; rate_limited_until: string | null; invoices: number; new_invoices: number; open_rejects: number;
  next_run_at: string | null; events: { at: string; kind: string; message: string }[] };
export type PurchaseStatusView = { read_only: boolean; can_configure: boolean; can_fetch: boolean; can_reopen: boolean; configs: { nip: string; environment: string; active: boolean }[]; syncs: PurchaseSync[] };
export type PurchaseItem = { id: string; buyer_nip: string; ksef_number: string; seller_nip: string; seller_name: string; invoice_number: string; fa3_kind: string; issue_date: string;
  currency: string; net_total: string; vat_total: string; gross_total: string; split_payment: boolean; reverse_charge: boolean; payment_due_date: string | null; status: Status;
  status_label: string; accounting_ref: string | null; version: number; legal_hold: boolean; retain_until: string; corrected: boolean };
export type PurchaseDetail = PurchaseItem & { note: string | null; sale_date: string | null; correction_reason: string | null; xml_bytes: number; invoice_hash: string; permanent_storage_date: string | null;
  rates: { rate_code: string; net: string; vat: string | null; vat_pln: string | null }[];
  corrects: { ordinal: number; ref_invoice_number: string; ref_issue_date: string; ref_ksef_number: string | null; problem: string | null; invoice_id: string | null; ksef_number: string | null }[];
  corrected_by: { invoice_id: string; ksef_number: string; invoice_number: string; issue_date: string; gross_total: string }[] };
type Status = 'new' | 'accepted' | 'booked' | 'ignored';
export type PurchaseFilters = { nip: string; seller: string; status: string; kind: string; from: string; to: string; q: string };
type Reject = { ksef_number: string; buyer_nip: string; code: string; reason: string; attempts: number; last_seen_at: string; invoice_number: string | null; seller_name: string | null };

const KSEF_NUMBER = /^[0-9]{10}-[0-9]{8}-[0-9A-F]{12}-[0-9A-F]{2}$/;
const DATE_TYPES: Record<string, string> = { PermanentStorage: 'data trwałego zapisu w KSeF (zalecane)', Invoicing: 'data przyjęcia w KSeF', Issue: 'data wystawienia' };
const RATE_LABELS: Record<string, string> = { '23': '23% (22%)', '8': '8% (7%)', '5': '5%', '4': '4% (taxi)', oss: 'OSS', '0_kr': '0% kraj', '0_wdt': '0% WDT', '0_ex': '0% eksport', zw: 'zw', np_i: 'np (art. 100)', np_ii: 'np', oo: 'odwrotne obciążenie', marza: 'marża' };
const PROBLEMS: Record<string, string> = { seller_mismatch: 'numer KSeF należy do innego sprzedawcy', ambiguous: 'kilka faktur o tym numerze i dacie' };
const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
export const plDay = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '—');
export const plTime = (d: string | null) => (d ? new Date(d).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' }) : '—');
/** Minor units (string, may be negative) → "1 234,56". */
export function amountPl(minor: string | null, currency = ''): string {
  if (minor === null) return '—';
  const neg = minor.startsWith('-'), digits = (neg ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '-' : ''}${whole},${digits.slice(-2)}${currency ? ' ' + currency : ''}`;
}
/** Query string of the filters (empty values left out); `before` pages the list. */
export function filterQuery(f: PurchaseFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v.trim()) p.set(k, v.trim());
  const s = p.toString();
  return s ? '?' + s : '';
}
/** A list reply must be a list of purchase invoices; nothing else (and no file) is shown. */
export function readPurchaseList(v: unknown): { items: PurchaseItem[]; next: string | null } {
  const x = v as { items?: PurchaseItem[]; next?: string | null };
  if (!x || !Array.isArray(x.items) || !x.items.every(i => KSEF_NUMBER.test(i.ksef_number) && typeof i.id === 'string' && !('xml' in i)) || !(x.next === null || typeof x.next === 'string'))
    throw Error('Niepełna lista faktur zakupowych. Odśwież widok.');
  return { items: x.items, next: x.next ?? null };
}
async function download(path: string, fallback: string, type: 'xml' | 'zip') {
  const workspace = currentWorkspace();
  const response = await fetch('/api' + path, { credentials: 'same-origin', headers: workspace ? { 'X-Workspace-ID': workspace } : {} });
  if (!response.ok) { const b = await response.json().catch(() => null) as { detail?: string } | null; throw Error(b?.detail ?? 'Nie udało się pobrać pliku'); }
  const blob = await response.blob();
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? fallback;
  const url = URL.createObjectURL(new Blob([blob], { type: type === 'xml' ? 'application/xml' : 'application/zip' })), a = document.createElement('a');
  a.href = url; a.download = name;
  try { document.body.appendChild(a); a.click(); } finally { a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
const blankFilters: PurchaseFilters = { nip: '', seller: '', status: '', kind: '', from: '', to: '', q: '' };

export function PurchaseInvoicesPanel({ readOnly }: { readOnly: boolean }) {
  const [status, setStatus] = useState<PurchaseStatusView | null>(null), [unavailable, setUnavailable] = useState(false), [error, setError] = useState('');
  const [filters, setFilters] = useState<PurchaseFilters>(blankFilters), [applied, setApplied] = useState<PurchaseFilters>(blankFilters);
  const [list, setList] = useState<{ items: PurchaseItem[]; next: string | null } | null>(null), [selected, setSelected] = useState<string | null>(null);
  const [rejects, setRejects] = useState<Reject[]>([]), [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [actionError, setActionError] = useState('');
  async function loadStatus() { setStatus(await api<PurchaseStatusView>('/ksef243/status')); setRejects((await api<{ items: Reject[] }>('/ksef243/rejects')).items); }
  async function loadList(f: PurchaseFilters, before?: string) {
    const page = readPurchaseList(await api('/ksef243/invoices' + filterQuery(f, before ? { before } : {})));
    setList(prev => (before && prev ? { items: [...prev.items, ...page.items], next: page.next } : page));
  }
  useEffect(() => {
    loadStatus().then(() => loadList(blankFilters)).catch(e => { if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(message(e, 'Nie udało się odczytać faktur zakupowych')); });
  }, []);
  async function act(name: string, f: () => Promise<string | null>) {
    if (busy) return; setBusy(name); setNotice(''); setActionError('');
    try { const n = await f(); if (n) setNotice(n); } catch (e) { setActionError(message(e, 'Operacja się nie powiodła')); } finally { setBusy(''); }
  }
  if (unavailable) return null;
  const write = !!status?.can_fetch && !readOnly;
  return <section className="panel ksef-purchase" aria-label="Faktury zakupowe (KSeF)">
    <div className="panel-heading"><div><h2>Faktury zakupowe (KSeF)</h2><p>Faktury kosztowe wystawione na NIP firmy i pobrane z KSeF. Plik FA(3) jest przechowywany bez zmian do 31.12 roku wystawienia + 6 lat.</p></div>
      {write && <button type="button" className="button" disabled={!!busy || !list?.items.length} onClick={() => void act('zip', async () => { await download('/ksef243/export.zip' + filterQuery(applied), 'faktury-zakupowe-ksef.zip', 'zip'); return 'Pobrano paczkę dla księgowości (zestawienie CSV i pliki FA(3)).'; })}>{busy === 'zip' ? 'Przygotowanie…' : 'Pobierz paczkę (CSV + XML)'}</button>}</div>
    <div className="form-body">
      {error && <p role="alert" className="notice error">{error}</p>}
      {status && <SyncState status={status} readOnly={readOnly} busy={busy} onRun={nip => void act('run:' + nip, async () => {
        const r = await api<{ outcome: string; stored: number; rejected: number; message: string | null; done: boolean }>(`/ksef243/sync/${nip}/run`, 'POST', {});
        await loadStatus(); await loadList(applied);
        return r.outcome === 'ok' || r.outcome === 'partial' ? `Pobrano ${r.stored} nowych faktur${r.rejected ? `, odrzucono ${r.rejected}` : ''}${r.done ? '.' : '; pozostałe pobierze zadanie w tle.'}` : (r.message ?? 'Pobieranie nie powiodło się');
      })} onSaved={() => void loadStatus()} />}
      <form className="ksef-form ksef-purchase-filters" onSubmit={e => { e.preventDefault(); setApplied(filters); setSelected(null); void act('list', async () => { await loadList(filters); return null; }); }}>
        <label>NIP nabywcy<select value={filters.nip} onChange={e => setFilters({ ...filters, nip: e.target.value })}><option value="">wszystkie</option>{status?.syncs.map(s => <option key={s.nip} value={s.nip}>{s.nip}</option>)}</select></label>
        <label>Sprzedawca (nazwa lub NIP)<input value={filters.seller} maxLength={100} onChange={e => setFilters({ ...filters, seller: e.target.value })} /></label>
        <label>Numer faktury lub KSeF<input value={filters.q} maxLength={100} onChange={e => setFilters({ ...filters, q: e.target.value })} /></label>
        <label>Status<select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">wszystkie</option><option value="new">Nowa</option><option value="accepted">Zaakceptowana</option><option value="booked">Zaksięgowana</option><option value="ignored">Pominięta</option></select></label>
        <label>Rodzaj<select value={filters.kind} onChange={e => setFilters({ ...filters, kind: e.target.value })}><option value="">wszystkie</option>{['VAT', 'KOR', 'ZAL', 'ROZ', 'UPR', 'KOR_ZAL', 'KOR_ROZ'].map(k => <option key={k} value={k}>{k}</option>)}</select></label>
        <label>Wystawiona od<input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label>
        <label>Wystawiona do<input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>
        <div className="ksef-actions"><button className="button primary" type="submit" disabled={!!busy}>Szukaj</button><button type="button" className="text-button" onClick={() => { setFilters(blankFilters); setApplied(blankFilters); void act('list', async () => { await loadList(blankFilters); return null; }); }}>Wyczyść filtry</button></div>
      </form>
      {list && !list.items.length && <p className="muted">Brak faktur zakupowych dla wybranych filtrów.</p>}
      {list && list.items.length > 0 && <div className="table-scroll"><table><thead><tr><th>Wystawiona</th><th>Numer</th><th>Sprzedawca</th><th className="num">Brutto</th><th>Oznaczenia</th><th>Status</th></tr></thead><tbody>
        {list.items.map(i => <tr key={i.id} className={selected === i.id ? 'selected' : ''}>
          <td>{plDay(i.issue_date)}</td>
          <td><button type="button" className="text-button" onClick={() => setSelected(selected === i.id ? null : i.id)} aria-expanded={selected === i.id}>{i.invoice_number}</button><small><code>{i.ksef_number}</code></small></td>
          <td>{i.seller_name}<small>NIP {i.seller_nip}</small></td>
          <td className="num">{amountPl(i.gross_total, i.currency)}</td>
          <td className="ksef-badges">{i.fa3_kind.startsWith('KOR') && <span className="badge">KOR</span>}{i.corrected && <span className="badge">korygowana</span>}{i.split_payment && <span className="badge">MPP</span>}{i.reverse_charge && <span className="badge">OO</span>}{i.legal_hold && <span className="badge">wstrzymane usunięcie</span>}</td>
          <td>{i.status_label}{i.accounting_ref && <small>{i.accounting_ref}</small>}</td>
        </tr>)}
      </tbody></table></div>}
      {list?.next && <button type="button" className="button" disabled={!!busy} onClick={() => void act('more', async () => { await loadList(applied, list.next!); return null; })}>Pokaż kolejne</button>}
      {selected && <PurchaseDetailView key={selected} id={selected} write={write} admin={!!status?.can_reopen} onOpen={setSelected} onChanged={() => void loadList(applied).then(loadStatus)} />}
      {rejects.length > 0 && <div className="ksef-document"><h3>Odrzucone pliki ({rejects.length})</h3><p className="muted">Faktury widoczne w KSeF, których plik nie przeszedł kontroli. Treść pliku nie jest zapisywana — sprawdź ją w aplikacji MF.</p>
        <div className="table-scroll"><table><thead><tr><th>Numer KSeF</th><th>Faktura</th><th>Powód</th><th>Próby</th><th /></tr></thead><tbody>
          {rejects.map(r => <tr key={r.ksef_number}><td><code>{r.ksef_number}</code></td><td>{r.invoice_number ?? '—'}<small>{r.seller_name ?? ''}</small></td><td>{r.reason}</td><td>{r.attempts}</td>
            <td>{write && <button type="button" className="text-button" disabled={!!busy} onClick={() => void act('retry:' + r.ksef_number, async () => { await api(`/ksef243/rejects/${r.ksef_number}/retry`, 'POST', {}); await loadStatus(); await loadList(applied); return `Pobrano fakturę ${r.ksef_number}.`; })}>Pobierz ponownie</button>}</td></tr>)}
        </tbody></table></div></div>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {actionError && <p role="alert" className="notice error">{actionError}</p>}
    </div>
  </section>;
}

function SyncState({ status, readOnly, busy, onRun, onSaved }: { status: PurchaseStatusView; readOnly: boolean; busy: string; onRun: (nip: string) => void; onSaved: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const unconfigured = status.configs.filter(c => !status.syncs.some(s => s.nip === c.nip));
  return <div className="ksef-purchase-sync">
    {!status.syncs.length && <p className="muted">Pobieranie faktur zakupowych nie jest jeszcze włączone{status.can_configure ? '' : ' — włącza je administrator'}.</p>}
    {status.syncs.map(s => <div key={s.nip} className="ksef-purchase-nip">
      <div><strong>NIP {s.nip}</strong> · {s.enabled ? 'pobieranie włączone' : 'pobieranie wyłączone'} · według: {DATE_TYPES[s.date_type] ?? s.date_type}</div>
      <div className="muted">Pobrane do: {plTime(s.completed_up_to)}{s.window_open ? ' (w toku)' : ''} · ostatni przebieg: {plTime(s.last_run_at)} · następny: {s.running ? 'trwa teraz' : plTime(s.next_run_at)}</div>
      <div className="muted">Faktur: {s.invoices} (nowych {s.new_invoices}) · odrzuconych plików: {s.open_rejects}</div>
      {s.rate_limited_until && Date.parse(s.rate_limited_until) > Date.now() && <p className="notice">KSeF ogranicza liczbę zapytań — pobieranie wznowi się po {plTime(s.rate_limited_until)}.</p>}
      {s.last_error && <p className="notice error">Ostatni błąd: {s.last_error}</p>}
      <div className="ksef-actions">
        {status.can_fetch && !readOnly && s.enabled && <button type="button" className="button primary" disabled={!!busy || s.running} onClick={() => onRun(s.nip)}>{busy === 'run:' + s.nip ? 'Pobieranie…' : 'Pobierz teraz'}</button>}
        {status.can_configure && !readOnly && <button type="button" className="text-button" onClick={() => setEditing(editing === s.nip ? null : s.nip)}>Ustawienia pobierania</button>}
      </div>
      {editing === s.nip && <SyncForm nip={s.nip} sync={s} onSaved={() => { setEditing(null); onSaved(); }} />}
      {s.events.length > 0 && <details><summary>Ostatnie zdarzenia</summary><ul className="ksef-purchase-events">{s.events.map((e, i) => <li key={i}>{plTime(e.at)} — {e.message}</li>)}</ul></details>}
    </div>)}
    {status.can_configure && !readOnly && unconfigured.map(c => <div key={c.nip} className="ksef-purchase-nip"><strong>NIP {c.nip}</strong> · ustawienia KSeF są zapisane, pobieranie faktur zakupowych jest wyłączone
      <div className="ksef-actions"><button type="button" className="button" onClick={() => setEditing(c.nip)}>Włącz pobieranie</button></div>
      {editing === c.nip && <SyncForm nip={c.nip} sync={null} onSaved={() => { setEditing(null); onSaved(); }} />}</div>)}
    {status.can_configure && !status.configs.length && <p className="muted">Najpierw zapisz połączenie z KSeF dla NIP firmy (Ustawienia → KSeF).</p>}
  </div>;
}

function SyncForm({ nip, sync, onSaved }: { nip: string; sync: PurchaseSync | null; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(sync?.enabled ?? true), [dateType, setDateType] = useState(sync?.date_type ?? 'PermanentStorage');
  const [start, setStart] = useState((sync?.start_from ?? '2026-02-01T00:00:00.000Z').slice(0, 10)), [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  async function save() {
    if (busy) return; setBusy(true); setErr('');
    try { await api(`/ksef243/sync/${nip}`, 'PUT', { enabled, date_type: dateType, start_from: start + 'T00:00:00Z', ...(restart ? { restart: true } : {}) }); onSaved(); }
    catch (e) { setErr(message(e, 'Nie udało się zapisać ustawień')); } finally { setBusy(false); }
  }
  return <form className="ksef-form" onSubmit={e => { e.preventDefault(); void save(); }} aria-label={'Ustawienia pobierania faktur zakupowych NIP ' + nip}>
    <label className="ksef-check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Pobieraj faktury zakupowe z KSeF (co 30 minut)</label>
    <label>Kolejność pobierania według<select value={dateType} onChange={e => setDateType(e.target.value)}>{Object.entries(DATE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
    <label>Pobieraj od dnia<input type="date" min="2026-02-01" value={start} onChange={e => setStart(e.target.value)} /></label>
    <label className="ksef-check"><input type="checkbox" checked={restart} onChange={e => setRestart(e.target.checked)} /> Pobierz ponownie od tego dnia (zapisane faktury nie zostaną zdublowane)</label>
    {err && <p role="alert" className="notice error">{err}</p>}
    <div className="ksef-actions"><button type="submit" className="button primary" disabled={busy}>{busy ? 'Zapisywanie…' : 'Zapisz'}</button></div>
  </form>;
}

function PurchaseDetailView({ id, write, admin, onOpen, onChanged }: { id: string; write: boolean; admin: boolean; onOpen: (id: string) => void; onChanged: () => void }) {
  const [d, setD] = useState<PurchaseDetail | null>(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [ref, setRef] = useState(''), [note, setNote] = useState('');
  useEffect(() => { api<PurchaseDetail>('/ksef243/invoices/' + id).then(v => { if (v.id !== id) throw Error('Obca faktura w odpowiedzi. Odśwież widok.'); setD(v); setRef(v.accounting_ref ?? ''); setNote(v.note ?? ''); }).catch(e => setErr(message(e, 'Nie udało się odczytać faktury'))); }, [id]);
  async function patch(body: Record<string, unknown>) {
    if (!d || busy) return; setBusy(true); setErr('');
    try { setD(await api<PurchaseDetail>('/ksef243/invoices/' + id, 'PATCH', { version: d.version, ...body })); onChanged(); }
    catch (e) { setErr(message(e, 'Nie udało się zapisać zmiany')); } finally { setBusy(false); }
  }
  if (err && !d) return <p role="alert" className="notice error">{err}</p>;
  if (!d) return <p className="muted">Wczytywanie faktury…</p>;
  const canChange = write && (d.status !== 'booked' || admin);
  return <div className="ksef-document ksef-purchase-detail" aria-label={'Faktura zakupowa ' + d.invoice_number}>
    <h3>{d.fa3_kind.startsWith('KOR') ? 'Faktura korygująca' : 'Faktura'} {d.invoice_number} · {d.status_label}</h3>
    <dl className="ksef-purchase-facts">
      <dt>Sprzedawca</dt><dd>{d.seller_name} (NIP {d.seller_nip})</dd>
      <dt>Nabywca</dt><dd>NIP {d.buyer_nip}</dd>
      <dt>Numer KSeF</dt><dd><code>{d.ksef_number}</code></dd>
      <dt>Wystawiona / sprzedaż</dt><dd>{plDay(d.issue_date)} / {plDay(d.sale_date)}</dd>
      <dt>W KSeF od</dt><dd>{plTime(d.permanent_storage_date)}</dd>
      <dt>Netto / VAT / brutto</dt><dd>{amountPl(d.net_total)} / {amountPl(d.vat_total)} / <strong>{amountPl(d.gross_total, d.currency)}</strong></dd>
      <dt>Termin płatności</dt><dd>{plDay(d.payment_due_date)}{d.split_payment ? ' · mechanizm podzielonej płatności' : ''}{d.reverse_charge ? ' · odwrotne obciążenie' : ''}</dd>
      <dt>Przechowywana do</dt><dd>{plDay(d.retain_until)}{d.legal_hold ? ' · wstrzymane usunięcie' : ''}</dd>
      {d.correction_reason && <><dt>Przyczyna korekty</dt><dd>{d.correction_reason}</dd></>}
    </dl>
    {d.rates.length > 0 && <div className="table-scroll"><table><thead><tr><th>Stawka</th><th className="num">Netto</th><th className="num">VAT</th><th className="num">VAT w PLN</th></tr></thead><tbody>
      {d.rates.map(r => <tr key={r.rate_code}><td>{RATE_LABELS[r.rate_code] ?? r.rate_code}</td><td className="num">{amountPl(r.net)}</td><td className="num">{amountPl(r.vat)}</td><td className="num">{amountPl(r.vat_pln)}</td></tr>)}
    </tbody></table></div>}
    {d.corrects.length > 0 && <div><strong>Koryguje:</strong><ul>{d.corrects.map(c => <li key={c.ordinal}>{c.ref_invoice_number} z {plDay(c.ref_issue_date)}{c.invoice_id ? <> — <button type="button" className="text-button" onClick={() => onOpen(c.invoice_id!)}>otwórz {c.ksef_number}</button></> : c.problem ? ` — nie powiązano: ${PROBLEMS[c.problem] ?? c.problem}` : ' — oryginału jeszcze nie pobrano'}</li>)}</ul></div>}
    {d.corrected_by.length > 0 && <div><strong>Korygowana przez:</strong><ul>{d.corrected_by.map(c => <li key={c.invoice_id}><button type="button" className="text-button" onClick={() => onOpen(c.invoice_id)}>{c.invoice_number}</button> z {plDay(c.issue_date)} ({amountPl(c.gross_total)})</li>)}</ul></div>}
    <div className="ksef-actions">
      <button type="button" className="button" onClick={() => void download(`/ksef243/invoices/${id}/fa3.xml`, d.ksef_number + '.xml', 'xml').catch(e => setErr(message(e, 'Nie udało się pobrać pliku')))}>Pobierz XML</button>
      {canChange && d.status !== 'accepted' && d.status !== 'booked' && <button type="button" className="button" disabled={busy} onClick={() => void patch({ status: 'accepted' })}>Zaakceptuj</button>}
      {canChange && d.status !== 'booked' && <button type="button" className="button primary" disabled={busy} onClick={() => void patch({ status: 'booked', ...(ref.trim() ? { accounting_ref: ref.trim() } : {}) })}>Oznacz jako zaksięgowaną</button>}
      {canChange && d.status !== 'ignored' && d.status !== 'booked' && <button type="button" className="text-button" disabled={busy} onClick={() => void patch({ status: 'ignored' })}>Pomiń</button>}
      {canChange && (d.status === 'ignored' || d.status === 'booked') && <button type="button" className="text-button" disabled={busy} onClick={() => void patch({ status: 'accepted' })}>{d.status === 'booked' ? 'Cofnij zaksięgowanie' : 'Przywróć'}</button>}
      {write && admin && <button type="button" className="text-button" disabled={busy} onClick={() => void patch({ legal_hold: !d.legal_hold })}>{d.legal_hold ? 'Zdejmij wstrzymanie usunięcia' : 'Wstrzymaj usunięcie (kontrola, postępowanie)'}</button>}
    </div>
    {canChange && <form className="ksef-form" onSubmit={e => { e.preventDefault(); void patch({ accounting_ref: ref.trim() || null, note: note.trim() || null }); }}>
      <label>Numer w księgach<input value={ref} maxLength={120} onChange={e => setRef(e.target.value)} /></label>
      <label>Notatka<input value={note} maxLength={2000} onChange={e => setNote(e.target.value)} /></label>
      <div className="ksef-actions"><button type="submit" className="button" disabled={busy}>Zapisz numer i notatkę</button></div>
    </form>}
    {err && <p role="alert" className="notice error">{err}</p>}
  </div>;
}
