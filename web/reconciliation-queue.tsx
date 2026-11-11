import { useEffect, useState } from 'react';
import { api, date } from './api';
import { MessageOutcomeDecision, type OutcomeItem } from './message-outcome';

const domainNames: Record<string, string> = {
  sms: 'SMS',
  email: 'Email',
  dpd_collection: 'Podjazdy DPD',
  shipping: 'Przesyłki',
  invoice: 'Faktury',
  order_status: 'Statusy w kanałach',
  offer: 'Oferty',
};
const where = (i: any) =>
  i.resolve === 'order_detail'
    ? 'Karta zamówienia ' + (i.order_number ?? '') + ' · „Uzgodnij wynik”'
    : i.resolve === 'dpd_collections'
      ? 'Integracje → DPD: podjazdy · „Potwierdź sprawdzony wynik DPD”'
      : i.resolve === 'offers'
        ? 'Integracje → Oferty · uzgodnienie oferty'
        : 'Sprawdź wynik u dostawcy i zapisz go tutaj';
const plural = (n: number) => (n === 1 ? 'skutek' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'skutki' : 'skutków');

/** One list of started side effects with an unknown result (AUTO-04). It points to the place where
 * each kind is resolved; SMS and email are decided here. Nothing here retries automatically. */
export function ReconciliationQueue({ refresh }: { refresh: number }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [local, setLocal] = useState(0),
    [deciding, setDeciding] = useState<OutcomeItem | null>(null);
  useEffect(() => {
    let live = true;
    api('/operations/reconciliation-queue')
      .then((r) => {
        if (!live) return;
        setData(r);
        setError('');
      })
      .catch((e) => live && (setData(null), setError(e instanceof Error ? e.message : 'Nie udało się odczytać kolejki')));
    return () => {
      live = false;
    };
  }, [refresh, local]);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  const counts = Object.entries((data?.counts ?? {}) as Record<string, number>).filter(([, n]) => n > 0);
  const total = counts.reduce((n, [, v]) => n + v, 0);
  return (
    <section className="panel ops-panel" aria-label="Do uzgodnienia">
      <div className="panel-heading">
        <div>
          <h2>Do uzgodnienia</h2>
          <p>Wysyłka albo zapis się rozpoczęły, ale wynik nie wrócił. Nic tu nie jest ponawiane automatycznie.</p>
        </div>
        <button className="button" onClick={() => setLocal((n) => n + 1)}>
          Odśwież
        </button>
      </div>
      {error && (
        <p className="notice import-error" role="alert">
          {error}
        </p>
      )}
      {data && !total && <p className="muted">Nic nie czeka na uzgodnienie.</p>}
      {total > 0 && (
        <p className="notice" role="status">
          <strong>
            {total} {plural(total)} o nieznanym wyniku
          </strong>
          {' · '}
          {counts.map(([d, n]) => (domainNames[d] ?? d) + ': ' + n).join(' · ')}
          {data.truncated && ' · lista pokazuje 100 najnowszych'}
        </p>
      )}
      {items.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Rodzaj</th>
                <th>Co</th>
                <th>Zamówienie</th>
                <th>Od</th>
                <th>Ostatni błąd</th>
                <th>Gdzie rozstrzygnąć</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.domain + ':' + i.id} data-domain={i.domain}>
                  <td>{domainNames[i.domain] ?? i.domain}</td>
                  <td>{i.label}</td>
                  <td>{i.order_number ?? '—'}</td>
                  <td>{date(i.at)}</td>
                  <td>{i.error ?? '—'}</td>
                  <td>
                    {where(i)}
                    {i.resolve === 'decide' && (
                      <>
                        {' '}
                        <button className="button small-btn" onClick={() => setDeciding(i)}>
                          Rozstrzygnij wynik
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deciding && (
        <MessageOutcomeDecision
          key={deciding.domain + ':' + deciding.id}
          item={deciding}
          onClose={() => setDeciding(null)}
          onDecided={() => setLocal((n) => n + 1)}
        />
      )}
      {data?.fulfillment_note && <p className="muted">{data.fulfillment_note}</p>}
    </section>
  );
}
