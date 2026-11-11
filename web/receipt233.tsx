import './receipt233.css';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { DEFAULT_PTU_TABLE, PAYMENT_FORMS, PTU_LETTERS, ptuLabel, type PaymentForm, type PtuTable, type PtuValue } from '../server/receipt233-model';
import type { DailyReportView, PrinterView, Receipt233View, Receipt233Snapshot } from '../server/receipt233';
import { invoicePartyOf, invoicePartyPolishNip, type InvoicePartyOrder, type InvoiceSectionValues } from '../shared/order-invoice-party';

/** Fiscal receipts (233): the printer configuration in Settings (with the connection test and the daily
 * report) and the order's "Paragon fiskalny" panel (print, status, number, retry). The server decides what
 * may be printed and talks to the printer; this view only collects the choice and shows the answer. */
const UNAVAILABLE = 'Paragony fiskalne (migracja 233) są niedostępne w tej kopii';
const message = (e: unknown, fallback: string) => e instanceof ApiError && e.status === 503 && /233/.test(e.message) ? UNAVAILABLE : e instanceof Error ? e.message : fallback;
const uncertain = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;
export const receipt233Money = (minor: string | number) => {
  const v = BigInt(minor), abs = v < 0n ? -v : v;
  return `${v < 0n ? '−' : ''}${String(abs / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${(abs % 100n).toString().padStart(2, '0')} zł`;
};
const FAMILIES: Record<string, string> = { posnet: 'Posnet', elzab: 'Elzab', novitus: 'Novitus' };
const PTU_CHOICES: PtuValue[] = ['23', '8', '5', '0', 'zw', null];

type PrinterState = { printer: PrinterView | null; printers: PrinterView[]; can_write: boolean; can_configure: boolean; read_only: boolean };
type Form = { name: string; model_family: string; host: string; port: string; unique_number: string; ptu: PtuTable; active: boolean };
const blank: Form = { name: 'Kasa fiskalna', model_family: 'posnet', host: '127.0.0.1', port: '', unique_number: '', ptu: DEFAULT_PTU_TABLE, active: true };
const formOf = (p: PrinterView): Form => ({ name: p.name, model_family: p.model_family, host: p.host, port: String(p.port), unique_number: p.unique_number, ptu: p.ptu, active: p.active });
/** Client checks of the configuration; the server checks again. */
export function receipt233FormProblems(f: Form): string[] {
  const out: string[] = [];
  if (!f.name.trim()) out.push('Podaj nazwę drukarki');
  if (!/^\d{4,5}$/.test(f.port) || Number(f.port) < 1024 || Number(f.port) > 65535) out.push('Port to liczba 1024–65535');
  if (!/^[A-Z]{3}[0-9]{8}$/.test(f.unique_number.trim().toUpperCase())) out.push('Numer unikatowy kasy: 3 litery i 8 cyfr, np. ABC12345678');
  const used = Object.values(f.ptu).filter(v => v !== null);
  if (new Set(used).size !== used.length) out.push('Ta sama stawka PTU jest przypisana do dwóch liter');
  return out;
}
const bodyOf = (f: Form, version: number | null) => ({ version, name: f.name.trim(), model_family: f.model_family, host: f.host, port: Number(f.port), unique_number: f.unique_number.trim().toUpperCase(), ptu: f.ptu, active: f.active });

function DailyReports({ reports }: { reports: DailyReportView[] }) {
  if (!reports.length) return <p className="muted">Brak zapisanych raportów dobowych.</p>;
  return <div className="table-scroll"><table><thead><tr><th>Dzień</th><th>Nr raportu</th><th>Kasa</th><th className="num">Paragony (kasa / aplikacja)</th><th className="num">Sprzedaż brutto (kasa)</th><th>Zgodność</th></tr></thead><tbody>
    {reports.map(r => <tr key={r.id}><td>{r.fiscal_date}</td><td>{r.report_number}</td><td>{r.printer_unique_number}</td><td className="num">{r.printer_receipts} / {r.app_receipts}</td>
      <td className="num">{receipt233Money(r.printer_totals.reduce((s, t) => s + BigInt(t.gross_minor), 0n).toString())}<small>{r.printer_totals.map(t => `${t.ptu}: ${receipt233Money(t.gross_minor)}`).join(' · ')}</small></td>
      <td>{r.matches ? 'Zgodny z paragonami aplikacji' : <strong>Niezgodny — sprawdź paragony dnia</strong>}</td></tr>)}
  </tbody></table></div>;
}

/** Ustawienia → Drukarka fiskalna. */
export function FiscalPrinterSettingsPanel({ admin, readOnly }: { admin: boolean; readOnly: boolean }) {
  const [state, setState] = useState<PrinterState | null>(null), [reports, setReports] = useState<DailyReportView[]>([]);
  const [form, setForm] = useState<Form>(blank), [error, setError] = useState(''), [actionError, setActionError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [unavailable, setUnavailable] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; problems: string[]; status: { unique_number: string; fiscal_date: string; ptu: PtuTable } | null } | null>(null);
  async function load() {
    const v = await api<PrinterState>('/receipt233/printer'); setState(v); setForm(v.printer ? formOf(v.printer) : blank);
    setReports((await api<{ data: DailyReportView[] }>('/receipt233/daily-reports')).data);
  }
  useEffect(() => { load().catch(e => { if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(message(e, 'Nie udało się odczytać drukarki fiskalnej')); }); }, []);
  async function run(f: () => Promise<void>) { if (busy) return; setBusy(true); setActionError(''); setNotice(''); try { await f(); } catch (e) { setActionError(message(e, 'Operacja się nie powiodła')); } finally { setBusy(false); } }
  const problems = receipt233FormProblems(form), current = state?.printer ?? null;
  const sameDevice = current && current.unique_number === form.unique_number.trim().toUpperCase();
  const canConfigure = admin && !readOnly && Boolean(state?.can_configure), canWrite = !readOnly && Boolean(state?.can_write);
  return <section className="panel receipt233-panel" aria-label="Drukarka fiskalna">
    <div className="panel-heading"><div><h2>Drukarka fiskalna</h2><p>Paragony sprzedaży konsumenckiej drukuje kasa fiskalna online (JPK_KASA wysyła sama kasa). Ta wersja łączy się wyłącznie z drukarką pod adresem lokalnym, protokołem DYNA-FISC/1.</p></div></div>
    <div className="form-body">
      {unavailable && <p className="notice">{UNAVAILABLE}.</p>}
      {error && <p role="alert">{error}</p>}
      {!state && !error && !unavailable && <p role="status">Odczytywanie drukarki fiskalnej…</p>}
      {state && (current
        ? <p>Aktywna: <strong>{current.name}</strong> · {current.model_label} · {current.host}:{current.port} · numer unikatowy {current.unique_number} · wersja {current.version}<small>PTU: {PTU_LETTERS.map(l => `${l} ${ptuLabel(current.ptu[l])}`).join(' · ')}</small></p>
        : <p className="muted">Brak aktywnej drukarki fiskalnej — paragonów nie można drukować.</p>)}
      {state && !admin && <p className="muted">Konfigurację drukarki zmienia administrator.</p>}
      {state && admin && <fieldset className="receipt233-fields" disabled={!canConfigure || busy}><legend>{current ? 'Konfiguracja drukarki' : 'Dodaj drukarkę'}</legend>
        <label>Nazwa<input value={form.name} maxLength={80} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label>Rodzina drukarki<select value={form.model_family} onChange={e => setForm({ ...form, model_family: e.target.value })}>{Object.entries(FAMILIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Adres (lokalny)<select value={form.host} onChange={e => setForm({ ...form, host: e.target.value })}>{['127.0.0.1', '::1', 'localhost'].map(h => <option key={h} value={h}>{h}</option>)}</select></label>
        <label>Port<input value={form.port} inputMode="numeric" maxLength={5} onChange={e => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })} placeholder="np. 4339" /></label>
        <label>Numer unikatowy kasy<input value={form.unique_number} maxLength={11} onChange={e => setForm({ ...form, unique_number: e.target.value.toUpperCase() })} placeholder="ABC12345678" /></label>
        <label className="receipt233-check"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} />Drukarka aktywna (drukuje paragony)</label>
        <div className="receipt233-wide"><span className="receipt233-label">Stawki PTU zaprogramowane w drukarce</span><div className="receipt233-ptu">
          {PTU_LETTERS.map(l => <label key={l}>{l}<select aria-label={`Litera PTU ${l}`} value={form.ptu[l] ?? ''} onChange={e => setForm({ ...form, ptu: { ...form.ptu, [l]: (e.target.value || null) as PtuValue } })}>
            {PTU_CHOICES.map(v => <option key={String(v)} value={v ?? ''}>{ptuLabel(v)}</option>)}</select></label>)}</div>
          <small>Zwykle A 23%, B 8%, C 5%, D 0%, E zwolnione. Sprzedaż NP, OO i OSS nie jest ewidencjonowana na kasie.</small></div>
        {current && !sameDevice && <p className="notice receipt233-wide">Inny numer unikatowy to nowe urządzenie: zostanie dodane jako aktywne, a obecna drukarka wyłączona (jej paragony zostają).</p>}
        {problems.length > 0 && <ul className="receipt233-problems receipt233-wide">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
        <div className="receipt233-actions receipt233-wide">
          <button type="button" className="button primary" disabled={problems.length > 0} onClick={() => void run(async () => {
            const v = await api<PrinterState>('/receipt233/printer', 'PUT', bodyOf(form, sameDevice ? current!.version : null));
            setState(v); setForm(v.printer ? formOf(v.printer) : blank); setNotice('Zapisano konfigurację drukarki fiskalnej.');
          })}>Zapisz konfigurację</button>
          <button type="button" className="button" disabled={problems.length > 0} onClick={() => void run(async () => { setTest(await api('/receipt233/printer/test', 'POST', bodyOf(form, null))); })}>Sprawdź połączenie</button>
        </div>
      </fieldset>}
      {state && !admin && current && <p className="receipt233-actions"><button type="button" className="button" disabled={busy} onClick={() => void run(async () => { setTest(await api('/receipt233/printer/test', 'POST', {})); })}>Sprawdź połączenie</button></p>}
      {test && <div className={test.ok ? 'notice' : 'notice error'} role="status"><strong>{test.ok ? `Drukarka odpowiada: numer unikatowy ${test.status!.unique_number}, data fiskalna ${test.status!.fiscal_date}, stawki PTU zgodne.` : 'Drukarka nie jest gotowa:'}</strong>
        {!test.ok && <ul>{test.problems.map(p => <li key={p}>{p}</li>)}</ul>}</div>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {state && <div className="receipt233-daily"><h3>Raport fiskalny dobowy</h3>
        <p className="muted">Drukuje raport dobowy na aktywnej drukarce i zapisuje go z sumami paragonów aplikacji z tego dnia.</p>
        <p className="receipt233-actions"><button type="button" className="button" disabled={!canWrite || !current || busy} onClick={() => void run(async () => {
          const v = await api<{ report: DailyReportView; reused: boolean }>('/receipt233/daily-reports', 'POST', { confirmed: true });
          setNotice(v.reused ? `Raport dobowy za ${v.report.fiscal_date} był już zapisany (nr ${v.report.report_number}).` : `Wydrukowano raport dobowy nr ${v.report.report_number} za ${v.report.fiscal_date}.`);
          setReports((await api<{ data: DailyReportView[] }>('/receipt233/daily-reports')).data);
        })}>Drukuj raport dobowy</button></p>
        <DailyReports reports={reports} /></div>}
    </div>
  </section>;
}

type OrderState = { can_write: boolean; read_only: boolean; printer: PrinterView | null; receipt: Receipt233View | null;
  calculation: { snapshot: Receipt233Snapshot | null; blockers: string[]; printable: boolean } | null };
type Attempt = { path: string; body: Record<string, unknown> };
const attempts = new Map<string, Attempt>();
function Lines({ s }: { s: Receipt233Snapshot }) {
  return <div className="table-scroll"><table><thead><tr><th>Pozycja</th><th className="num">Ilość × cena</th><th>PTU</th><th className="num">Wartość</th></tr></thead><tbody>
    {s.lines.map(l => <tr key={l.line_no}><td>{l.name}{l.sku && <small>{l.sku}</small>}</td><td className="num">{l.quantity} × {receipt233Money(l.unit_gross_minor)}{l.discount_gross_minor !== '0' && <small>rabat {receipt233Money(l.discount_gross_minor)}</small>}</td>
      <td>{l.ptu} ({ptuLabel(s.ptu_table[l.ptu])})</td><td className="num">{receipt233Money(l.gross_minor)}</td></tr>)}
  </tbody></table></div>;
}
function ReceiptView({ r, canWrite, busy, onRetry }: { r: Receipt233View; canWrite: boolean; busy: boolean; onRetry: () => void }) {
  return <article className="receipt233-receipt" aria-label="Paragon fiskalny zamówienia">
    <p className={'receipt233-state receipt233-' + r.state}><strong>{r.state === 'printed' ? `Paragon nr ${r.number} z ${r.fiscal_date}` : r.state_label}</strong>
      {' · '}{receipt233Money(r.gross_minor)} · {PAYMENT_FORMS[r.payment_form]} · kasa {r.printer_unique_number}{r.attempts > 1 ? ` · próby druku: ${r.attempts}` : ''}</p>
    {r.buyer_nip && <p>NIP nabywcy: {r.buyer_nip}{r.simplified_invoice ? ' — paragon do 450 zł z NIP jest fakturą uproszczoną' : ''}</p>}
    {r.error && <p role="alert">{r.error.message}</p>}
    {r.state !== 'printed' && <p className="receipt233-actions"><button type="button" className="button primary" disabled={!canWrite || busy || (r.error !== null && !r.error.retry)} onClick={onRetry}>
      {r.state === 'sent' ? 'Sprawdź i ponów druk' : 'Ponów druk'}</button></p>}
    {r.state === 'printed' && (r.invoice
      ? <p>Faktura do paragonu: <strong>{r.invoice.number}</strong>.</p>
      : <p className="muted">Fakturę do tego paragonu wystaw w panelu „Faktura VAT: B2B, EUR, ZW/NP/OO/OSS” (FV-S): faktura dla firmy wymaga NIP nabywcy na paragonie. Lokalna faktura B2C potwierdza, że nie jest wystawiana do paragonu, więc dla tego zamówienia jest niedostępna.</p>)}
    <Lines s={r.snapshot} />
  </article>;
}

type ReceiptOrder = InvoicePartyOrder & { id: string; section_values?: { invoice?: InvoiceSectionValues } };
/** Prefill only: the Polish NIP of the invoice data edited on the order card (Uwagi v3 §6), otherwise none. */
export function receipt233InitialNip(order: ReceiptOrder): string {
  const p = invoicePartyOf(order, order.section_values?.invoice);
  return p.source === 'invoice_section' ? invoicePartyPolishNip(p) : '';
}
/** Order view: "Paragon fiskalny". */
export function Receipt233Panel({ order, contextKey, readOnly, onChanged }: { order: ReceiptOrder; contextKey: string; readOnly: boolean; onChanged?: () => void }) {
  const [state, setState] = useState<OrderState | null>(null), [error, setError] = useState(''), [actionError, setActionError] = useState(''), [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false), [form, setForm] = useState<PaymentForm | ''>(''), [nip, setNip] = useState(() => receipt233InitialNip(order)), [confirmed, setConfirmed] = useState(false);
  const pendingKey = contextKey + ':' + order.id, [pending, setPending] = useState<Attempt | null>(attempts.get(pendingKey) ?? null);
  const epoch = useRef(0);
  async function load() {
    const n = ++epoch.current, v = await api<OrderState>(`/receipt233/orders/${order.id}`);
    if (n !== epoch.current) return;
    setState(v); setError('');
    if (!form && v.calculation?.snapshot) setForm(v.calculation.snapshot.payment_form);
  }
  useEffect(() => { load().catch(e => { if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(message(e, 'Nie udało się odczytać paragonu')); }); }, [order.id, contextKey]);
  async function send(a: Attempt) {
    if (busy) return;
    setBusy(true); setActionError('');
    // Kept outside the component so a remount during the request still offers the same request again.
    attempts.set(pendingKey, a);
    try {
      const v = await api<{ receipt: Receipt233View }>(a.path, 'POST', a.body);
      attempts.delete(pendingKey); setPending(null);
      setState(s => s ? { ...s, receipt: v.receipt, calculation: null } : s);
      if (v.receipt.state === 'printed') { setConfirmed(false); onChanged?.(); }
    } catch (e) {
      if (uncertain(e)) setPending(a); else { attempts.delete(pendingKey); setPending(null); }
      setActionError(message(e, 'Nie udało się wydrukować paragonu'));
    } finally { setBusy(false); }
  }
  const canWrite = !readOnly && Boolean(state?.can_write), c = state?.calculation, r = state?.receipt;
  const nipValid = nip.trim() === '' || /^(PL)?\s*\d{3}-?\d{3}-?\d{2}-?\d{2}$/i.test(nip.trim());
  return <section className="receipt233-panel" aria-label="Paragon fiskalny">
    <h3>Paragon fiskalny</h3>
    {unavailable && <p className="notice">{UNAVAILABLE}.</p>}
    {error && <p role="alert">{error}</p>}
    {!state && !error && !unavailable && <p role="status">Odczytywanie paragonu…</p>}
    {busy && <p role="status" className="receipt233-busy">Trwa druk na drukarce fiskalnej — nie zamykaj tej karty.</p>}
    {pending && <div className="receipt233-pending" role="status"><p>Wynik druku nie został potwierdzony. Ponów to samo żądanie — drukarka nie wydrukuje paragonu drugi raz.</p>
      <button type="button" className="button" disabled={busy || !canWrite} onClick={() => void send(pending)}>Ponów to samo żądanie</button></div>}
    {r && <ReceiptView r={r} canWrite={canWrite} busy={busy} onRetry={() => void send({ path: `/receipt233/receipts/${r.id}/retry`, body: { confirmed: true } })} />}
    {state && !r && c && <>
      {c.blockers.length > 0 && <div className="receipt233-blockers" role="status"><strong>Paragonu nie można wydrukować:</strong><ul>{c.blockers.map(b => <li key={b}>{b}</li>)}</ul></div>}
      {c.snapshot && c.printable && <>
        <p>Do zapłaty: <strong>{receipt233Money(c.snapshot.totals.gross_minor)}</strong> · w tym VAT {receipt233Money(c.snapshot.totals.vat_minor)} · drukarka {c.snapshot.printer.name} ({c.snapshot.printer.unique_number})
          <small>{c.snapshot.ptu_totals.map(t => `PTU ${t.ptu} (${ptuLabel(t.value)}): ${receipt233Money(t.gross_minor)}, VAT ${receipt233Money(t.vat_minor)}`).join(' · ')}</small></p>
        <Lines s={c.snapshot} />
        <fieldset className="receipt233-fields" disabled={!canWrite || busy || Boolean(pending)}><legend>Druk paragonu</legend>
          <label>Forma płatności<select value={form} onChange={e => setForm(e.target.value as PaymentForm)}>{Object.entries(PAYMENT_FORMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>NIP nabywcy (opcjonalnie)<input value={nip} maxLength={20} inputMode="numeric" onChange={e => setNip(e.target.value)} placeholder="podaj przed drukiem, jeśli nabywca chce fakturę" /></label>
          {!nipValid && <p role="alert" className="receipt233-wide">NIP: 10 cyfr, np. 526-025-02-74</p>}
          {nip.trim() && nipValid && BigInt(c.snapshot.totals.gross_minor) <= 45000n && <p className="receipt233-wide muted">Paragon z NIP do 450 zł jest fakturą uproszczoną.</p>}
          <label className="receipt233-check receipt233-wide"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Potwierdzam druk paragonu fiskalnego na drukarce. Paragonu nie można potem zmienić.</label>
          <p className="receipt233-actions receipt233-wide"><button type="button" className="button primary" disabled={!confirmed || !form || !nipValid} onClick={() => void send({
            path: `/receipt233/orders/${order.id}/receipts`, body: { client_key: crypto.randomUUID(), payment_form: form, buyer_nip: nip.trim() || null, confirmed: true } })}>Drukuj paragon</button></p>
        </fieldset>
      </>}
    </>}
    {actionError && <p role="alert">{actionError}</p>}
  </section>;
}
