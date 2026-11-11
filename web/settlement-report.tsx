import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Scale } from 'lucide-react';
import { api, ApiError, money, statusNames } from './api';

/** Settlement report: payments ↔ invoices ↔ corrections ↔ return credits per order.
 * All amounts arrive as integer grosze; the page only formats them. */
type Status =
  | 'scalone' | 'inna_waluta' | 'niedoplata' | 'nadplata' | 'brak_faktury' | 'korekta_bez_faktury'
  | 'korekta_bez_zwrotu' | 'zwrot_bez_korekty' | 'faktura_niezgodna' | 'wiele_faktur' | 'dokument_nieczytelny' | 'zgodne';
type Foreign = { currency: string; received: number; refunded: number; invoiced: number; corrections: number };
type Row = {
  order_id: string; number: string; customer: string; created_at: string; order_status: string; payment_mode: string; currency: string;
  order_total: number; return_credit: number; cancelled_credit: number; amount_due: number; received: number; refunded: number;
  net_paid: number; payment_difference: number; courier_due: number; invoiced: number; corrections: number; documented: number;
  document_difference: number; credit_difference: number; invoice_numbers: string[]; correction_numbers: string[]; foreign: Foreign[];
  merge_target_number: string | null; in_totals: boolean; status: Status; flags: Status[];
};
type Totals = {
  currency: string; orders: number; statuses: Partial<Record<Status, number>>; amount_due: number; net_paid: number; received: number;
  refunded: number; payment_difference: number; invoiced: number; corrections: number; documented: number; document_difference: number;
  return_credit: number; cancelled_credit: number; credit_difference: number; courier_due: number;
  foreign_received: number; foreign_refunded: number; foreign_documented: number;
};
type Report = { from: string; to: string; currency: string | null; generated_at: string; rows: Row[]; totals: Totals[] };

const labels: Record<Status, string> = {
  scalone: 'Scalone', inna_waluta: 'Inna waluta', niedoplata: 'Niedopłata', nadplata: 'Nadpłata', brak_faktury: 'Brak faktury',
  korekta_bez_faktury: 'Korekta bez faktury', korekta_bez_zwrotu: 'Korekta bez zwrotu', zwrot_bez_korekty: 'Zwrot bez korekty',
  faktura_niezgodna: 'Faktura niezgodna', wiele_faktur: 'Kilka faktur', dokument_nieczytelny: 'Nieczytelny dokument', zgodne: 'Zgodne',
};
const tone: Record<Status, { bg: string; fg: string }> = {
  zgodne: { bg: '#e7f6ee', fg: '#17703f' }, scalone: { bg: '#eef1f6', fg: '#56627a' },
  niedoplata: { bg: '#fdecec', fg: '#a32020' }, nadplata: { bg: '#fff4dc', fg: '#8a5a00' },
  brak_faktury: { bg: '#fff4dc', fg: '#8a5a00' }, korekta_bez_faktury: { bg: '#fdecec', fg: '#a32020' },
  korekta_bez_zwrotu: { bg: '#fdecec', fg: '#a32020' }, zwrot_bez_korekty: { bg: '#fff4dc', fg: '#8a5a00' },
  faktura_niezgodna: { bg: '#fdecec', fg: '#a32020' }, wiele_faktur: { bg: '#fff4dc', fg: '#8a5a00' },
  dokument_nieczytelny: { bg: '#fdecec', fg: '#a32020' }, inna_waluta: { bg: '#eaf0ff', fg: '#2a46b8' },
};
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const defaultRange = () => {
  const to = new Date(), from = new Date();
  from.setDate(from.getDate() - 29);
  return { from: isoDay(from), to: isoDay(to) };
};
const signed = (n: number, currency: string) => (n > 0 ? '+' : '') + money(n, currency);
const num = { textAlign: 'right' as const, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' as const };
const docNumber = { display: 'block', maxWidth: 150, marginLeft: 'auto', whiteSpace: 'normal' as const, overflowWrap: 'anywhere' as const };
const diffStyle = (n: number) => ({ ...num, color: n === 0 ? '#17703f' : n < 0 ? '#a32020' : '#8a5a00', fontWeight: 700 });

function Badge({ status, title }: { status: Status; title?: string }) {
  return (
    <span title={title} style={{ display: 'inline-block', padding: '3px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: tone[status].bg, color: tone[status].fg, whiteSpace: 'nowrap' }}>
      {labels[status]}
    </span>
  );
}

export function SettlementReport({ contextKey, admin }: { contextKey: string; admin: boolean }) {
  const [range, setRange] = useState(defaultRange);
  const [currency, setCurrency] = useState('');
  const [only, setOnly] = useState<'all' | 'issues' | Status>('issues');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const query = useMemo(() => new URLSearchParams({ from: range.from, to: range.to, ...(currency ? { currency } : {}) }).toString(), [range, currency]);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReport(await api<Report>('/settlement-report?' + query));
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : 'Nie udało się przygotować raportu');
    } finally {
      setLoading(false);
    }
  }, [query]);
  useEffect(() => {
    setReport(null);
    if (admin) void load();
    // Load once per workspace; later loads come from the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey, admin]);
  const download = async () => {
    setError('');
    try {
      const res = await fetch('/api/settlement-report/file?' + query, { credentials: 'same-origin' });
      if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).detail ?? 'Nie udało się pobrać pliku CSV', res.status);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `rozliczenie-${range.from}-${range.to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nie udało się pobrać pliku CSV');
    }
  };
  const rows = (report?.rows ?? []).filter((r) => (only === 'all' ? true : only === 'issues' ? r.status !== 'zgodne' && r.status !== 'scalone' : r.flags.includes(only)));
  return (
    <section className="panel">
      <div className="panel-heading" style={{ flexWrap: 'wrap' }}>
        <div>
          <h2><Scale size={18} style={{ verticalAlign: '-3px', marginRight: 6 }} />Rozliczenie płatności, faktur i korekt</h2>
          <p>Dla każdego zamówienia z okresu: należność po zwrotach, wpłaty i zwroty pieniędzy, faktury i korekty — co do grosza. Kwoty w innej walucie niż zamówienie są pokazane osobno.</p>
        </div>
      </div>
      {!admin ? (
        <div className="notice">Raport rozliczeń jest dostępny dla administratora finansów.</div>
      ) : (
        <div style={{ padding: '0 23px 23px' }}>
          <form
            onSubmit={(e) => { e.preventDefault(); void load(); }}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 16 }}
          >
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>Od
              <input type="date" value={range.from} required onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>Do
              <input type="date" value={range.to} required onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>Waluta zamówienia
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="">Wszystkie</option>
                {['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>Pokaż
              <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)}>
                <option value="issues">Tylko wymagające uwagi</option>
                <option value="all">Wszystkie zamówienia</option>
                {(Object.keys(labels) as Status[]).map((s) => <option key={s} value={s}>{labels[s]}</option>)}
              </select>
            </label>
            <button className="button primary" type="submit" disabled={loading}>
              <RefreshCw size={14} /> {loading ? 'Liczę…' : 'Przelicz'}
            </button>
            <button className="button" type="button" onClick={() => void download()} disabled={loading}>
              <Download size={14} /> Pobierz CSV
            </button>
          </form>
          {error && <div className="error" role="alert">{error}</div>}
          {report && (
            <>
              {report.totals.length === 0 && <div className="notice">Brak zamówień w wybranym okresie.</div>}
              {report.totals.map((t) => (
                <div key={t.currency} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                    <strong>Suma {t.currency} · {t.orders} zamówień</strong>
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {(Object.entries(t.statuses) as [Status, number][]).map(([s, n]) => <span key={s}><Badge status={s} /> {n}</span>)}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, fontSize: 12 }}>
                    {([
                      ['Należność po zwrotach', t.amount_due],
                      ['Zapłacono netto', t.net_paid],
                      ['Różnica płatności', t.payment_difference, true],
                      ['Zafakturowano', t.invoiced],
                      ['Korekty', t.corrections],
                      ['Różnica dokumentów', t.document_difference, true],
                      ['Zwroty uznane', t.return_credit],
                      ['Zwroty bez korekty', t.credit_difference, true],
                    ] as [string, number, boolean?][]).map(([label, value, diff]) => (
                      <div key={label}>
                        <div style={{ color: 'var(--muted)' }}>{label}</div>
                        <div style={diff ? diffStyle(value) : { ...num, textAlign: 'left', fontWeight: 700, color: 'var(--ink)' }}>{diff ? signed(value, t.currency) : money(value, t.currency)}</div>
                      </div>
                    ))}
                  </div>
                  {(t.foreign_received !== 0 || t.foreign_refunded !== 0 || t.foreign_documented !== 0) && (
                    <p style={{ fontSize: 12, color: '#2a46b8', marginTop: 8 }}>
                      Z zamówień w innej walucie: wpłaty {money(t.foreign_received, t.currency)}, zwroty {money(t.foreign_refunded, t.currency)}, dokumenty {money(t.foreign_documented, t.currency)} — nie wliczone do sum powyżej.
                    </p>
                  )}
                </div>
              ))}
              <div className="table-scroll" style={{ maxHeight: 560, overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 180 }}>Zamówienie i status</th><th style={num}>Należność</th><th style={num}>Zapłacono netto</th>
                      <th style={num}>Różnica</th><th style={num}>Faktury</th><th style={num}>Korekty</th><th style={num}>Zwroty uznane</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.order_id} style={r.in_totals ? undefined : { opacity: 0.6 }}>
                        <td>
                          <strong>{r.number}</strong>
                          <small style={{ display: 'block' }}>{new Date(r.created_at).toLocaleDateString('pl-PL')} · {r.customer} · {statusNames[r.order_status] ?? r.order_status}{r.payment_mode === 'cod' ? ' · pobranie' : ''}</small>
                          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                            {r.flags.map((f) => <Badge key={f} status={f} title={f === 'scalone' && r.merge_target_number ? 'Rozliczane w ' + r.merge_target_number : undefined} />)}
                          </span>
                          {r.foreign.map((x) => <small key={x.currency} style={{ display: 'block', color: '#2a46b8' }}>{x.currency}: wpłaty {money(x.received, x.currency)}, dok. {money(x.invoiced + x.corrections, x.currency)}</small>)}
                        </td>
                        <td style={num}>{money(r.amount_due, r.currency)}{r.amount_due !== r.order_total && <small style={{ display: 'block' }}>z {money(r.order_total, r.currency)}</small>}</td>
                        <td style={num}>{money(r.net_paid, r.currency)}{r.refunded !== 0 && <small style={{ display: 'block' }}>wpłaty {money(r.received, r.currency)} − zwroty {money(r.refunded, r.currency)}</small>}</td>
                        <td style={diffStyle(r.payment_difference)}>{signed(r.payment_difference, r.currency)}</td>
                        <td style={num} title={r.invoice_numbers.join(', ')}>{money(r.invoiced, r.currency)}{r.invoice_numbers.length > 0 && <small style={docNumber}>{r.invoice_numbers.length === 1 ? r.invoice_numbers[0] : r.invoice_numbers.length + ' dok.'}</small>}</td>
                        <td style={num} title={r.correction_numbers.join(', ')}>{money(r.corrections, r.currency)}{r.correction_numbers.length > 0 && <small style={docNumber}>{r.correction_numbers.length === 1 ? r.correction_numbers[0] : r.correction_numbers.length + ' dok.'}</small>}</td>
                        <td style={num}>{money(r.return_credit + r.cancelled_credit, r.currency)}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>{only === 'issues' ? 'Wszystkie zamówienia z okresu są rozliczone zgodnie.' : 'Brak zamówień dla wybranego filtra.'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10 }}>
                Okres według daty utworzenia zamówienia ({report.from} – {report.to}, czas polski); płatności, dokumenty i zwroty — wszystkie zarejestrowane do chwili przeliczenia.
                Różnica dodatnia oznacza nadpłatę, ujemna — niedopłatę.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
