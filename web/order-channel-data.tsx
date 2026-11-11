/** Tab "Kanał sprzedaży" of the order card: the channel data the automation conditions read
 * (GET /api/orders/:id/channel-data, server/channel-projection.ts), each with its source. */
import { useEffect, useState } from 'react';
import { api } from './api';
import type { ChannelData } from '../shared/channel-projection';

interface OrderChannelDataProps {
  orderId: string;
  /** Changes when the order changes (version), so the data is read again. */
  version: string | number;
}

export function OrderChannelData({ orderId, version }: OrderChannelDataProps) {
  const [data, setData] = useState<ChannelData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const ctrl = new AbortController();
    setError('');
    api<ChannelData>(`/orders/${orderId}/channel-data`, 'GET', undefined, {}, ctrl.signal)
      .then(setData)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Nie udało się wczytać danych kanału');
      });
    return () => ctrl.abort();
  }, [orderId, version]);
  return (
    <section className="panel order-channel-data" aria-label="Dane z kanału sprzedaży">
      <div className="panel-heading">
        <h2>Dane z kanału sprzedaży</h2>
      </div>
      {error && <p className="error-block" role="alert">{error}</p>}
      {!data && !error && <p className="muted info-body">Wczytywanie…</p>}
      {data && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Pole</th>
                <th scope="col">Wartość</th>
                <th scope="col">Źródło</th>
              </tr>
            </thead>
            <tbody>
              {data.fields.map((f) => (
                <tr key={f.key}>
                  <th scope="row">{f.label}</th>
                  <td className="order-channel-value">{f.value || <span className="muted">brak</span>}</td>
                  <td className="muted">{f.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
