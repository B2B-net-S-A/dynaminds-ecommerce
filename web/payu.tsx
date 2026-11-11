// PayU payment sessions (migration 242, docs/parity/PAYU242-20261027.md): the administrator's PayU configuration
// and the order card's list of portal payments with „Sprawdź w PayU” and a PayU refund. Secrets are write-only.
import { useEffect, useState, type FormEvent } from 'react';
import { CreditCard, RefreshCw } from 'lucide-react';
import { api, money, date } from './api';

const statusLabels: Record<string, string> = {
  NEW: 'Rozpoczęta',
  PENDING: 'W toku w PayU',
  WAITING_FOR_CONFIRMATION: 'Czeka na potwierdzenie',
  COMPLETED: 'Opłacona',
  CANCELED: 'Anulowana',
  REJECTED: 'Nieudana',
};
const reviewLabels: Record<string, string> = {
  completed_after_canceled: 'Do uzgodnienia: PayU zgłosił wpłatę po anulowaniu. Nic nie zaksięgowano — sprawdź panel PayU.',
  amount_mismatch: 'Do uzgodnienia: PayU zgłosił inną kwotę niż sesja. Nic nie zaksięgowano.',
  booking_refused: 'Do uzgodnienia: wpłata potwierdzona w PayU, ale zapis został odrzucony. Użyj „Sprawdź w PayU”.',
  uncertain: 'Wynik zwrotu niepewny — użyj „Sprawdź w PayU”.',
};
const refundLabels: Record<string, string> = { started: 'Wysłany', PENDING: 'W toku', FINALIZED: 'Zwrócony', CANCELED: 'Anulowany', refused: 'Odrzucony' };

interface Session {
  id: string;
  status: string;
  phase: string;
  amount: number;
  currency: string;
  simulated: boolean;
  provider_order_id: string | null;
  review: string | null;
  created_at: string;
  refundable: number;
  refunds: { id: string; amount: number; status: string; review: string | null; created_at: string }[];
}
interface SessionsProps {
  order: { id: string; currency: string; version: string | number };
  write: boolean;
  admin: boolean;
  readOnly: boolean;
  onChanged: () => void;
}
function minor(v: FormDataEntryValue | null) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw Error('Kwota wymaga maksymalnie dwóch miejsc po przecinku');
  const [whole, f = ''] = s.split('.');
  return Number(whole) * 100 + Number(f.padEnd(2, '0'));
}

export function PayuSessionsPanel({ order, write, admin, readOnly, onChanged }: SessionsProps) {
  const [rows, setRows] = useState<Session[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [refund, setRefund] = useState<{ session: string; key: string } | null>(null);
  const load = () =>
    api('/orders/' + order.id + '/payu-sessions')
      .then((d) => setRows(d.data))
      .catch((e) => setError(e.message));
  useEffect(() => {
    setRows(null);
    setError('');
    load();
  }, [order.id, String(order.version)]);
  if (!rows?.length) return error ? <p className="notice error" role="alert">{error}</p> : null;
  async function check(id: string) {
    if (busy) return;
    setBusy(id);
    setError('');
    try {
      await api('/orders/' + order.id + '/payu-sessions/' + id + '/reconcile', 'POST', {});
      await load();
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  async function submitRefund(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !refund) return;
    const f = new FormData(e.currentTarget);
    setBusy(refund.session);
    setError('');
    try {
      await api('/orders/' + order.id + '/payu-sessions/' + refund.session + '/refunds', 'POST', {
        client_key: refund.key, amount: minor(f.get('amount')), confirmed: f.get('confirmed') === 'on',
      });
      setRefund(null);
      await load();
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel payments-panel">
      <div className="panel-heading">
        <h2>
          <CreditCard size={18} /> Płatności PayU z portalu
        </h2>
        <span>{rows.length} {rows.length === 1 ? 'próba' : [2, 3, 4].includes(rows.length % 10) && ![12, 13, 14].includes(rows.length % 100) ? 'próby' : 'prób'}</span>
      </div>
      <div className="shipping-body">
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Rozpoczęta</th><th>Kwota</th><th>Stan</th><th>PayU</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>{date(s.created_at)}</td>
                  <td>{money(s.amount, s.currency)}</td>
                  <td>
                    <strong>{statusLabels[s.status] ?? s.status}</strong>
                    {s.simulated && <span className="badge"> SYMULACJA</span>}
                    {s.review && <p className="notice error">{reviewLabels[s.review] ?? s.review}</p>}
                    {s.refunds.map((r) => (
                      <p key={r.id} className="muted">Zwrot {money(r.amount, s.currency)}: {refundLabels[r.status] ?? r.status}{r.review ? ' · ' + (reviewLabels[r.review] ?? r.review) : ''}</p>
                    ))}
                  </td>
                  <td><code>{s.provider_order_id ?? '—'}</code></td>
                  <td>
                    {write && !readOnly && (s.provider_order_id || s.phase === 'create_started') && (
                      <button className="button" type="button" disabled={!!busy} onClick={() => check(s.id)}>
                        <RefreshCw size={14} /> Sprawdź w PayU
                      </button>
                    )}
                    {admin && !readOnly && s.refundable > 0 && (
                      <button className="button" type="button" disabled={!!busy} onClick={() => setRefund({ session: s.id, key: crypto.randomUUID() })}>
                        Zwróć przez PayU
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {refund && (
          <form onSubmit={submitRefund} className="payment-form">
            <label>
              Kwota zwrotu ({order.currency})
              <input name="amount" inputMode="decimal" required />
            </label>
            <label>
              <input type="checkbox" name="confirmed" required /> Potwierdzam zwrot pieniędzy kupującemu przez PayU
            </label>
            <p className="muted">Zwrot jest możliwy do kwoty nadpłaty zamówienia i kwoty tej płatności. Zapis w historii powstaje, gdy PayU potwierdzi zwrot.</p>
            <button className="button primary" disabled={!!busy}>Zleć zwrot</button>{' '}
            <button className="button" type="button" onClick={() => setRefund(null)}>Anuluj</button>
          </form>
        )}
      </div>
    </section>
  );
}

interface ConfigView {
  configured: boolean;
  simulation: boolean;
  environment?: string;
  pos_id?: string;
  client_id?: string;
  public_origin?: string;
  enabled?: boolean;
  version?: number;
  client_secret_set?: boolean;
  second_key_set?: boolean;
  notify_url?: string;
}
export function PayuSettings({ readOnly }: { readOnly: boolean }) {
  const [cfg, setCfg] = useState<ConfigView | null>(null),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/payu/config').then(setCfg).catch((e) => setError(e.message));
  }, []);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || readOnly) return;
    const f = new FormData(e.currentTarget), text = (k: string) => String(f.get(k) ?? '').trim();
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const next = await api('/payu/config', 'PUT', {
        environment: 'sandbox',
        pos_id: text('pos_id'),
        ...(text('client_id') ? { client_id: text('client_id') } : {}),
        public_origin: text('public_origin'),
        ...(text('client_secret') ? { client_secret: text('client_secret') } : {}),
        ...(text('second_key') ? { second_key: text('second_key') } : {}),
        enabled: f.get('enabled') === 'on',
        ...(cfg?.configured ? { version: cfg.version } : {}),
      });
      setCfg(next);
      setSaved('Zapisano konfigurację PayU.');
      (e.target as HTMLFormElement).reset();
    } catch (x: any) {
      setError(x.message);
    } finally {
      setBusy(false);
    }
  }
  if (!cfg) return error ? <p className="notice error" role="alert">{error}</p> : null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2><CreditCard size={18} /> PayU — płatności z portalu klienta</h2>
        <span>{cfg.configured ? (cfg.enabled ? 'Włączone' : 'Wyłączone') : 'Nieskonfigurowane'}</span>
      </div>
      <div className="shipping-body">
        {cfg.simulation && <p className="notice">SYMULACJA lokalna: płatności idą do lokalnego fałszywego PayU, bez prawdziwych pieniędzy. Każda wpłata ma w opisie „SYMULACJA”.</p>}
        <p className="muted">Środowisko: testowe (sandbox). Tryb produkcyjny jest wyłączony w tej instalacji. Klucze z panelu PayU są zapisywane zaszyfrowane i nie są później wyświetlane.</p>
        {error && <p className="notice error" role="alert">{error}</p>}
        {saved && <p className="notice" role="status">{saved}</p>}
        <form key={String(cfg.version ?? 0)} onSubmit={save} className="payment-form">
          <label>Numer punktu płatności (POS ID)<input name="pos_id" defaultValue={cfg.pos_id ?? ''} inputMode="numeric" required disabled={readOnly} /></label>
          <label>client_id (OAuth, domyślnie POS ID)<input name="client_id" defaultValue={cfg.client_id ?? ''} inputMode="numeric" disabled={readOnly} /></label>
          <label>Publiczny adres sklepu (HTTPS)<input name="public_origin" defaultValue={cfg.public_origin ?? ''} placeholder="https://sklep.example.pl" required disabled={readOnly} /></label>
          <label>client_secret {cfg.client_secret_set && <small>(zapisany — zostaw puste, aby nie zmieniać)</small>}<input name="client_secret" type="password" autoComplete="off" required={!cfg.configured} disabled={readOnly} /></label>
          <label>Drugi klucz (MD5) {cfg.second_key_set && <small>(zapisany — zostaw puste, aby nie zmieniać)</small>}<input name="second_key" type="password" autoComplete="off" required={!cfg.configured} disabled={readOnly} /></label>
          <label><input type="checkbox" name="enabled" defaultChecked={cfg.enabled ?? true} disabled={readOnly} /> Pokazuj przycisk „Zapłać przez PayU” w portalu</label>
          {cfg.notify_url && <p className="muted">Adres powiadomień (ustawiany automatycznie przy każdej płatności): <code>{cfg.notify_url}</code></p>}
          <button className="button primary" disabled={busy || readOnly}>Zapisz konfigurację PayU</button>
        </form>
      </div>
    </section>
  );
}
