// COM-005 (migration 245): periodic IMAP reading and automatic assignment of replies.
import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { api, date } from './api';
import { matchLabel, matchOutcomeLabel, scheduleOutcomeLabel } from './s5comm253-labels';

interface Schedule {
  account_id: string;
  account_name: string;
  account_enabled: boolean;
  enabled: boolean;
  interval_minutes: number;
  auto_bind: boolean;
  version: number;
  last_run_at?: string | null;
  last_outcome?: string | null;
  last_error?: string | null;
  last_fetched?: number | null;
  last_bound?: number | null;
  next_run_at?: string | null;
}
interface Match {
  message_id: string;
  outcome: string;
  method: string | null;
  order_number: string | null;
  evidence: string;
  created_at: string;
}
export function InboundSchedules({ readOnly, onOpenOrder }: { readOnly: boolean; onOpenOrder?: (id: string) => void }) {
  const [rows, setRows] = useState<Schedule[] | null>(null),
    [matches, setMatches] = useState<(Match & { order_id?: string | null })[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  const load = async () => {
    try {
      const s = await api('/email-inbound/schedules');
      if (!s.available) return setRows(null);
      setRows(s.data);
      setMatches((await api('/email-inbound/matches')).data);
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  async function save(s: Schedule, change: Partial<Schedule>) {
    if (busy || readOnly) return;
    setBusy(s.account_id);
    setError('');
    try {
      const next = { ...s, ...change };
      await api('/email-inbound/schedules/' + s.account_id, 'PUT', {
        enabled: next.enabled,
        interval_minutes: Number(next.interval_minutes),
        auto_bind: next.auto_bind,
        version: s.version,
      });
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  if (!rows) return error ? <p className="notice error" role="alert">{error}</p> : null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2><Clock size={18} /> Automatyczny odbiór skrzynek IMAP</h2>
      </div>
      <div className="shipping-body">
        <p className="muted">
          Skrzynka jest czytana co wybrany czas w imieniu administratora, który włączył odbiór. Automatycznie przypisujemy tylko odpowiedzi na nasze
          wiadomości oraz emaile z numerem zamówienia wysłane z adresu tego zamówienia. Pozostałe czekają na ręczne przypisanie.
        </p>
        {error && <p className="notice error" role="alert">{error}</p>}
        {!rows.length && <p className="empty">Brak kont IMAP. Dodaj konto w sekcji odbioru email.</p>}
        <div className="table-scroll" hidden={!rows.length}>
          <table>
            <thead>
              <tr><th>Konto</th><th>Odbiór</th><th>Co ile minut</th><th>Przypisywanie</th><th>Ostatni odczyt</th><th>Następny</th></tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.account_id}>
                  <td>{s.account_name}{!s.account_enabled && <small className="muted">Konto wyłączone</small>}</td>
                  <td>
                    <label><input type="checkbox" checked={s.enabled} disabled={readOnly || busy === s.account_id} onChange={(e) => save(s, { enabled: e.target.checked })} /> Włączony</label>
                  </td>
                  <td>
                    <select value={s.interval_minutes} disabled={readOnly || busy === s.account_id} onChange={(e) => save(s, { interval_minutes: Number(e.target.value) })}>
                      {[5, 15, 30, 60, 240, 1440].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </td>
                  <td>
                    <label><input type="checkbox" checked={s.auto_bind} disabled={readOnly || busy === s.account_id} onChange={(e) => save(s, { auto_bind: e.target.checked })} /> Automatycznie do zamówień</label>
                  </td>
                  <td>
                    {s.last_run_at ? date(s.last_run_at) : '—'}
                    <small>{scheduleOutcomeLabel(s.last_outcome ?? null)}{s.last_fetched != null ? ` · ${s.last_fetched} odczytanych, ${s.last_bound ?? 0} przypisanych` : ''}</small>
                    {s.last_error && <small className="notice error">{s.last_error}</small>}
                  </td>
                  <td>{s.enabled && s.next_run_at ? date(s.next_run_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {matches.length > 0 && (
          <details open>
            <summary>Ostatnie decyzje automatycznego przypisania ({matches.length})</summary>
            <ul>
              {matches.map((m) => (
                <li key={m.message_id}>
                  <strong>{matchOutcomeLabel(m.outcome)}</strong>
                  {m.order_number && (
                    <> · {onOpenOrder && m.order_id ? <button className="text-button" onClick={() => onOpenOrder(m.order_id!)}>{m.order_number}</button> : m.order_number}</>
                  )}{' '}
                  · {matchLabel(m.method)} <small className="muted">{date(m.created_at)}{m.evidence ? ' · ' + m.evidence : ''}</small>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
