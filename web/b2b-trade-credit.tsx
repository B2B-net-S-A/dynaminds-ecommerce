/** B2B-007 trade credit (migration 246): the supplier's line editor per account and the balance both sides read
 * (supplier panel, buyer portal, network link). Amounts are typed in złoty and sent in grosze. */
import { useEffect, useState, type FormEvent } from 'react';
import { api, date, money } from './api';
import { formatMinor, parseMinorAmount, tradeCreditCurrencies } from '../server/b2b-trade-credit-model';

export interface TradeCreditView {
  available: boolean;
  line: { id: string; currency: string; limit_minor: number; term_days: number; active: boolean; version: number } | null;
  summary: { currency: string; limit_minor: number; term_days: number; active: boolean; exposure_minor: number; available_minor: number; overdue_minor: number; overdue_orders: number; open_orders: number } | null;
  orders: { number: string; channel: string; amount_minor: number; amount_due: number; due_at: string; overdue: boolean }[];
}
const channels: Record<string, string> = { portal: 'portal', network: 'sieć B2B', dropship: 'dropshipping' };

/** The balance as both sides see it; nothing when the account has no line. */
export function TradeCreditBalance({ view, title = 'Kredyt kupiecki', className = 'card' }: { view: TradeCreditView | null; title?: string; className?: string }) {
  const s = view?.summary;
  if (!view?.line || !s) return null;
  return (
    <section className={className} aria-label="Saldo kredytu kupieckiego">
      <h3>{title}{s.active ? '' : ' · wyłączony'}</h3>
      <dl className="trade-credit-balance" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', margin: 0 }}>
        <div><dt className="muted">Limit</dt><dd style={{ margin: 0 }}>{money(s.limit_minor, s.currency)}</dd></div>
        <div><dt className="muted">Do zapłaty</dt><dd style={{ margin: 0 }}>{money(s.exposure_minor, s.currency)}</dd></div>
        <div><dt className="muted">Wolny limit</dt><dd style={{ margin: 0 }}><strong>{money(s.available_minor, s.currency)}</strong></dd></div>
        <div><dt className="muted">Termin</dt><dd style={{ margin: 0 }}>{s.term_days} dni</dd></div>
      </dl>
      {s.overdue_minor > 0 && (
        <p className="notice" role="alert">
          Po terminie: {money(s.overdue_minor, s.currency)} ({s.overdue_orders} zam.). Nowe zamówienia na kredyt są wstrzymane do spłaty.
        </p>
      )}
      {view.orders.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Zamówienie</th><th>Kanał</th><th>Na kredyt</th><th>Do zapłaty</th><th>Termin</th></tr></thead>
            <tbody>
              {view.orders.map((o) => (
                <tr key={o.number}>
                  <td>{o.number}</td>
                  <td>{channels[o.channel] ?? o.channel}</td>
                  <td>{money(o.amount_minor, s.currency)}</td>
                  <td>{money(o.amount_due, s.currency)}</td>
                  <td>{date(o.due_at)}{o.overdue ? ' · po terminie' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Reads a balance from `path` and shows it; `refresh` reloads it (e.g. after an order). */
export function TradeCreditBalanceFrom({ path, refresh, title, className }: { path: string; refresh?: unknown; title?: string; className?: string }) {
  const [view, setView] = useState<TradeCreditView | null>(null);
  useEffect(() => {
    let alive = true;
    api<TradeCreditView>(path).then((v) => alive && setView(v)).catch(() => alive && setView(null));
    return () => { alive = false; };
  }, [path, refresh]);
  return <TradeCreditBalance view={view} title={title} className={className} />;
}

/** The supplier's administrator sets currency, limit and term of one account; others read the balance. */
export function B2bTradeCreditPanel({ accountId, accountName, admin, readOnly, onClose }: { accountId: string; accountName: string; admin: boolean; readOnly: boolean; onClose: () => void }) {
  const [view, setView] = useState<TradeCreditView | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState('');
  const path = '/b2b/accounts/' + encodeURIComponent(accountId) + '/trade-credit';
  const load = () => api<TradeCreditView>(path).then(setView);
  useEffect(() => { setView(null); setError(''); setSaved(''); load().catch((e) => setError(e.message)); }, [accountId]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || readOnly || !admin) return;
    const f = new FormData(e.currentTarget);
    setError(''); setSaved('');
    let limit: number;
    try { limit = parseMinorAmount(String(f.get('limit') ?? '')); } catch (x: any) { setError(x.message); return; }
    setBusy(true);
    try {
      const v = await api<TradeCreditView>(path, 'PUT', {
        currency: String(f.get('currency')), limit_minor: limit, term_days: Number(f.get('term')), active: f.get('active') === 'on',
        version: view?.line?.version ?? 0, confirmed: true,
      });
      setView(v);
      setSaved('Zapisano kredyt kupiecki.');
    } catch (x: any) {
      setError(x.message);
    } finally {
      setBusy(false);
    }
  }
  const l = view?.line;
  return (
    <section className="card" aria-label="Kredyt kupiecki kontrahenta">
      <h2>Kredyt kupiecki · {accountName}</h2>
      <button type="button" className="button" onClick={onClose}>Zamknij kredyt kupiecki</button>
      {error && <p className="error" role="alert">{error}</p>}
      {saved && <p className="notice">{saved}</p>}
      {view && !view.available && <p className="notice">Ta kopia bazy nie ma migracji kredytu kupieckiego.</p>}
      {view?.available && (
        <>
          <p className="muted">
            Z aktywnym kredytem każde zamówienie kontrahenta (portal, sieć B2B, dropshipping) trafia na kredyt i może być
            kompletowane przed zapłatą. Zamówienie ponad wolny limit, w innej walucie albo przy zaległości po terminie
            nie zostanie złożone. Spłatę zapisujesz jak każdą wpłatę na zamówieniu.
          </p>
          {admin && !readOnly ? (
            <form onSubmit={save} key={l?.version ?? 0}>
              <fieldset disabled={busy}>
              <div className="form-grid">
              <label>Waluta
                <select name="currency" defaultValue={l?.currency ?? 'PLN'}>
                  {tradeCreditCurrencies.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label>Limit (zł)
                <input name="limit" inputMode="decimal" required defaultValue={l ? formatMinor(l.limit_minor) : ''} placeholder="np. 10 000,00" />
              </label>
              <label>Termin płatności (dni)
                <input name="term" type="number" min={1} max={365} required defaultValue={l?.term_days ?? 14} />
              </label>
              </div>
              <label className="check"><input name="active" type="checkbox" defaultChecked={l?.active ?? true} /> Kredyt aktywny</label>
              <div className="row"><button className="button primary" disabled={busy}>{l ? 'Zapisz zmiany kredytu' : 'Nadaj kredyt kupiecki'}</button></div>
              </fieldset>
            </form>
          ) : !l && <p>Kontrahent nie ma kredytu kupieckiego.</p>}
          <TradeCreditBalance view={view} title="Saldo kredytu" />
        </>
      )}
    </section>
  );
}
