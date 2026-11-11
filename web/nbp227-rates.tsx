import { useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** 227 NBP rates in Dokumenty → Kursy NBP (stored table A rates, a read from NBP cached into
 * them, a manual rate, the rate a tax point would use) and the rate line of an issued invoice. */
export type NbpRate = { currency: string; effective_date: string; table_no: string; mid: string; covered_through: string; source: 'fetched' | 'manual'; fetched_at: string };
export type NbpRatesView = { currency: string; read_only: boolean; can_fetch: boolean; can_manual: boolean; today: string; rates: NbpRate[] };
export type DocumentNbp = { currency: string; tax_point: string; tax_point_basis: 'sell_date' | 'issue_date'; rate_date: string; table_no: string; mid: string; rate_source: 'fetched' | 'manual';
  vat_pln_minor: string; net_pln_minor: string; gross_pln_minor: string; captured_at: string; line: string };

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const isTable = (v: unknown, day: unknown) => typeof v === 'string' && /^\d{3}\/A\/NBP\/\d{4}$/.test(v) && typeof day === 'string' && v.slice(-4) === day.slice(0, 4);
const isMid = (v: unknown) => typeof v === 'string' && /^(0|[1-9]\d{0,5})\.\d{4}$/.test(v) && Number(v) > 0;
const minor = (v: unknown) => typeof v === 'string' && /^(0|[1-9]\d{0,17})$/.test(v);
export const plDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
export const plMid = (m: string) => m.replace('.', ',');

function validRate(r: any): r is NbpRate {
  return r && typeof r === 'object' && r.currency === 'EUR' && isDay(r.effective_date) && isTable(r.table_no, r.effective_date) && isMid(r.mid)
    && isDay(r.covered_through) && r.covered_through >= r.effective_date && (r.source === 'fetched' || r.source === 'manual') && Number.isFinite(Date.parse(r.fetched_at));
}
export function readNbpRates(value: unknown): NbpRatesView {
  const v = value as any;
  if (!v || v.currency !== 'EUR' || typeof v.read_only !== 'boolean' || typeof v.can_fetch !== 'boolean' || typeof v.can_manual !== 'boolean' || !isDay(v.today)
    || !Array.isArray(v.rates) || v.rates.length > 60 || !v.rates.every(validRate)) throw Error('Niepełna lub obca lista kursów NBP. Odśwież widok.');
  return v;
}
/** Record of an invoice: null for PLN or without a record, with the server's note. */
export function readDocumentNbp(value: unknown, documentId: string): { currency: string; nbp: DocumentNbp | null; note: string | null } {
  const v = value as any, n = v?.nbp;
  const ok = v && v.document_id === documentId && typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency)
    && (n === null ? typeof v.note === 'string' && v.note.length > 0 : v.currency !== 'PLN' && n && n.currency === v.currency && isDay(n.tax_point) && isDay(n.rate_date) && n.rate_date < n.tax_point
      && isTable(n.table_no, n.rate_date) && isMid(n.mid) && minor(n.vat_pln_minor) && minor(n.net_pln_minor) && minor(n.gross_pln_minor) && typeof n.line === 'string' && n.line.startsWith('Kurs NBP z dnia ' + plDate(n.rate_date)));
  if (!ok) throw Error('Niepełny lub obcy zapis kursu NBP faktury');
  return { currency: v.currency, nbp: n, note: v.note ?? null };
}
/** "12,34" or "12.34" or "1 234,56" → minor units as text. */
export function amountMinor(text: string): string {
  const t = text.trim().replace(/[\s ]/g, '').replace(',', '.');
  if (!/^(0|[1-9]\d{0,13})(\.\d{1,2})?$/.test(t)) throw Error('Podaj kwotę VAT w EUR, np. 23,00');
  const [w, f = ''] = t.split('.');
  return String(BigInt(w!) * 100n + BigInt(f.padEnd(2, '0')));
}

type Choice = { rate: NbpRate | null; refusal: string | null; line: string | null };
export function NbpRatesPanel({ contextKey, readOnly }: { contextKey: string; readOnly: boolean }) {
  const [view, setView] = useState<NbpRatesView | null>(null), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [actionError, setActionError] = useState('');
  const [taxPoint, setTaxPoint] = useState(''), [vat, setVat] = useState(''), [choice, setChoice] = useState<Choice | null>(null);
  const [manual, setManual] = useState({ effective_date: '', table_no: '', mid: '', covered_through: '' }), [place, setPlace] = useState<'top' | 'manual'>('top');
  async function load() { setView(readNbpRates(await api('/nbp227/rates?currency=EUR'))); }
  useEffect(() => {
    let alive = true;
    setView(null); setError(''); setUnavailable(false); setMessage(''); setActionError(''); setChoice(null);
    api('/nbp227/rates?currency=EUR').then(v => { if (alive) setView(readNbpRates(v)); })
      .catch(e => { if (!alive) return; if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(e instanceof Error ? e.message : 'Nie udało się odczytać kursów NBP'); });
    return () => { alive = false; };
  }, [contextKey]);
  async function run(action: () => Promise<string>, where: 'top' | 'manual' = 'top') {
    if (busy) return;
    setBusy(true); setMessage(''); setActionError(''); setPlace(where);
    try { setMessage(await action()); await load(); } catch (e) { setActionError(e instanceof Error ? e.message : 'Operacja nie powiodła się'); } finally { setBusy(false); }
  }
  const check = () => run(async () => {
    if (!isDay(taxPoint)) throw Error('Podaj datę obowiązku podatkowego');
    const q = new URLSearchParams({ currency: 'EUR', tax_point: taxPoint, ...(vat.trim() ? { vat_minor: amountMinor(vat) } : {}) });
    const c = await api('/nbp227/rate-for?' + q) as Choice;
    if (c.rate !== null && !validRate(c.rate)) throw Error('Niepełna odpowiedź kursu NBP');
    setChoice(c);
    return '';
  });
  const fetchFor = () => run(async () => {
    if (!isDay(taxPoint)) throw Error('Podaj datę obowiązku podatkowego');
    const r = await api('/nbp227/rates/fetch', 'POST', { currency: 'EUR', tax_point: taxPoint });
    setChoice(null);
    return `Pobrano z NBP ${r.publications} ${r.publications === 1 ? 'tabelę' : 'tabel'} z okresu ${plDate(r.start)}–${plDate(r.end)}.`;
  });
  const saveManual = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); void run(async () => {
    const r = await api('/nbp227/rates/manual', 'PUT', { currency: 'EUR', ...manual, mid: manual.mid.trim().replace(',', '.') });
    setManual({ effective_date: '', table_no: '', mid: '', covered_through: '' });
    return `Zapisano kurs ręczny ${plMid(r.rate.mid)} PLN z tabeli ${r.rate.table_no}.`;
  }, 'manual'); };
  const feedback = <>{busy && <p role="status">Trwa operacja…</p>}{message && <p role="status">{message}</p>}{actionError && <p className="notice" role="alert">{actionError}</p>}</>;
  return <section className="panel" aria-label="Kursy NBP">
    <div className="panel-heading"><div><h2>Kursy NBP</h2><p>Kurs średni tabeli A z ostatniego dnia przed obowiązkiem podatkowym (art. 31a ustawy o VAT) dla dokumentów w walucie obcej.</p></div></div>
    <div className="form-body">
      {unavailable && <p className="muted">Kursy NBP (migracja 227) są niedostępne w tej kopii.</p>}
      {error && <p className="notice" role="alert">{error}</p>}
      {!view && !error && !unavailable && <p role="status">Odczytywanie kursów NBP…</p>}
      {view && <div style={{ display: 'grid', gap: 16 }}>
        <p className="notice">Faktura w walucie obcej zostanie wstrzymana, jeśli nie ma zapisanego kursu dla jej daty obowiązku podatkowego. Wystawienie nie łączy się z NBP — kurs pobierz tutaj albo wpisz ręcznie.</p>
        <div className="inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
          <label>Data obowiązku podatkowego <input type="date" value={taxPoint} max={view.today} onChange={e => { setTaxPoint(e.target.value); setChoice(null); }} /></label>
          <label>VAT w EUR (opcjonalnie) <input inputMode="decimal" value={vat} placeholder="np. 23,00" onChange={e => { setVat(e.target.value); setChoice(null); }} /></label>
          <button type="button" className="button" disabled={busy} onClick={() => void check()}>Sprawdź kurs</button>
          {view.can_fetch && <button type="button" className="button" disabled={busy || readOnly} onClick={() => void fetchFor()}>Pobierz z NBP</button>}
        </div>
        {!view.can_fetch && <p className="muted">Odczyt tabel NBP nie jest włączony w tym środowisku{view.can_manual ? ' — wpisz kurs ręcznie poniżej' : ''}.</p>}
        {place === 'top' && feedback}
        {choice && (choice.rate ? <div className="catalog-section" role="status" style={{ display: 'grid', gap: 6, lineHeight: 1.6 }}>
          <p><strong>{choice.line ?? `Kurs NBP z dnia ${plDate(choice.rate.effective_date)}, tabela ${choice.rate.table_no}, 1 EUR = ${plMid(choice.rate.mid)} PLN`}</strong></p>
          <p className="muted">Źródło: {choice.rate.source === 'fetched' ? 'odczyt z NBP' : 'wpis ręczny'} · obowiązuje do {plDate(choice.rate.covered_through)}</p>
        </div> : <p className="notice" role="alert">{choice.refusal}</p>)}
        <h3 style={{ margin: '8px 0 0' }}>Zapisane kursy EUR</h3>
        {!view.rates.length ? <p className="muted">Brak zapisanych kursów.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Data tabeli</th><th>Tabela</th><th>1 EUR</th><th>Obowiązuje do</th><th>Źródło</th></tr></thead>
          <tbody>{view.rates.map(r => <tr key={r.effective_date}><td>{plDate(r.effective_date)}</td><td>{r.table_no}</td><td>{plMid(r.mid)} PLN</td><td>{plDate(r.covered_through)}</td>
            <td>{r.source === 'fetched' ? 'NBP' : 'ręcznie'}</td></tr>)}</tbody></table></div>}
        {view.can_manual && <form onSubmit={saveManual} style={{ display: 'grid', gap: 12 }}>
          <h3 style={{ margin: '8px 0 0' }}>Kurs ręczny</h3>
          <p className="muted" style={{ margin: 0 }}>Gdy NBP jest niedostępny: przepisz kurs z tabeli A. „Obowiązuje do” to ostatni dzień przed następną tabelą (np. niedziela dla tabeli z piątku).</p>
          <div className="inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
            <label>Data tabeli <input type="date" required max={view.today} value={manual.effective_date} onChange={e => setManual({ ...manual, effective_date: e.target.value, covered_through: manual.covered_through || e.target.value })} /></label>
            <label>Numer tabeli <input required placeholder="206/A/NBP/2026" value={manual.table_no} onChange={e => setManual({ ...manual, table_no: e.target.value.trim() })} /></label>
            <label>1 EUR w PLN <input required inputMode="decimal" placeholder="4,3685" value={manual.mid} onChange={e => setManual({ ...manual, mid: e.target.value })} /></label>
            <label>Obowiązuje do <input type="date" required max={view.today} value={manual.covered_through} onChange={e => setManual({ ...manual, covered_through: e.target.value })} /></label>
            <button className="button" disabled={busy || readOnly}>Zapisz kurs ręczny</button>
          </div>
          {place === 'manual' && feedback}
        </form>}
      </div>}
    </div>
  </section>;
}

/** NBP line of an issued local invoice, or why it has none. */
export function LocalInvoiceDocumentNbp({ documentId }: { documentId: string }) {
  const [state, setState] = useState<ReturnType<typeof readDocumentNbp> | null>(null), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let alive = true; setState(null); setError(''); setUnavailable(false);
    api(`/local-invoices/documents/${documentId}/nbp`).then(v => { if (alive) setState(readDocumentNbp(v, documentId)); })
      .catch(e => { if (!alive) return; if (e instanceof ApiError && e.status === 503 && /227/.test(e.message)) setUnavailable(true); else setError(e instanceof Error ? e.message : 'Nie udało się odczytać kursu NBP faktury'); });
    return () => { alive = false; };
  }, [documentId]);
  return <section className="local-invoice-tax" aria-label="Kurs NBP faktury"><h4>Kurs NBP</h4>
    {unavailable && <p className="muted">Kursy NBP niedostępne w tej kopii.</p>}
    {error && <p role="alert">{error}</p>}
    {!state && !error && !unavailable && <p role="status">Odczytywanie kursu NBP…</p>}
    {state?.nbp && <><p><strong>{state.nbp.line}</strong></p>
      <p className="muted">Data obowiązku podatkowego {plDate(state.nbp.tax_point)} ({state.nbp.tax_point_basis === 'sell_date' ? 'data sprzedaży' : 'data wystawienia'}) · źródło kursu: {state.nbp.rate_source === 'fetched' ? 'NBP' : 'wpis ręczny'}.</p></>}
    {state && !state.nbp && <p>{state.note}</p>}
  </section>;
}
