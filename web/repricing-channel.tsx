import { useEffect, useState } from 'react';
import { api, money } from './api';

/** REPRICE-005/006: the channel result of a scheduled repricing run (offer-sync plans after the price write). */
export type ChannelSummary = { total: number; open: number; pending: number; sent: number; acknowledged: number; mismatch: number; failed: number; superseded: number };
export const CHANNEL_NAMES: Record<string, string> = {
  pending: 'Czeka na synchronizację',
  sent: 'Wysłano do kanału',
  acknowledged: 'Potwierdzono w kanale',
  mismatch: 'Rozbieżność',
  failed: 'Błąd zapisu',
  superseded: 'Zastąpione nowszą ceną',
};
/** One line for a run or history row: "3 oferty: 2 potwierdzone, 1 czeka". */
export function channelText(s: ChannelSummary | null | undefined): string {
  if (!s) return 'Kanał: brak powiązanych ofert';
  const parts = [
    [s.acknowledged, 'potwierdzone'],
    [s.sent, 'wysłane'],
    [s.pending, 'czeka'],
    [s.mismatch, 'rozbieżne'],
    [s.failed, 'błąd'],
    [s.superseded, 'zastąpione'],
  ].filter(([n]) => Number(n) > 0).map(([n, l]) => `${n} ${l}`);
  return `Kanał: ${s.total} ${s.total === 1 ? 'oferta' : s.total < 5 ? 'oferty' : 'ofert'} · ${parts.join(', ')}`;
}

export function RunChannelResults({ runId, write }: { runId: string; write: boolean }) {
  const [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api('/repricing-runs/' + runId + '/channel')
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [runId]);
  if (error) return <p className="error-block" role="alert">{error}</p>;
  if (!data) return <p>Wczytywanie wyniku w kanale…</p>;
  if (!data.available) return <p className="muted">Ta kopia nie zapisuje wyniku kanału (brak migracji).</p>;
  return (
    <section aria-label="Wynik w kanale">
      <h4>Wynik w kanale</h4>
      <p role="status">{channelText(data.summary)}</p>
      {write && data.summary?.open > 0 && (
        <button
          className="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              setData(await api('/repricing-runs/' + runId + '/channel/reconcile', 'POST', {}));
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Uzgodnij z kanałem teraz
        </button>
      )}
      {data.data.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>SKU / oferta</th>
                <th>Cena z przebiegu</th>
                <th>Odczyt w kanale</th>
                <th>Stan</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((r: any) => (
                <tr key={r.listing_id}>
                  <td>
                    <strong>{r.sku}</strong>
                    <small>
                      {r.channel_name} · {r.external_id}
                    </small>
                  </td>
                  <td>{money(r.expected_price, r.currency)}</td>
                  <td>{r.remote_price === null ? '—' : money(r.remote_price, r.currency)}</td>
                  <td>
                    {CHANNEL_NAMES[r.status] ?? r.status}
                    {r.error && <small>{r.error}</small>}
                    {r.checked_at && <small>sprawdzono {new Date(r.checked_at).toLocaleString('pl-PL')}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
