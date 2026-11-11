import { useEffect, useRef, useState } from 'react';
import { api, date } from './api';
const names: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'W kolejce',
  done: 'Potwierdzono w Amazon',
  failed: 'Błąd / niepewny wynik',
  conflict: 'Wymaga uzgodnienia',
  cancelled: 'Anulowano',
};
export function AmazonFulfillmentPanel({
  order,
  refreshSignal = 0,
  readOnly = false,
}: {
  order: any;
  refreshSignal?: number;
  readOnly?: boolean;
}) {
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0),
    [carrier, setCarrier] = useState(''),
    [carrierName, setCarrierName] = useState(''),
    [shippingMethod, setShippingMethod] = useState(''),
    [confirm, setConfirm] = useState<string | null>(null),
    [ack, setAck] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api(`/orders/${order.id}/amazon-fulfillment`)
      .then((v) => {
        if (active) {
          setData(v);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [order.id, order.version, refresh, refreshSignal]);
  useEffect(() => {
    if (readOnly) return;
    if (!data?.data.some((p: any) => p.state === 'queued')) return;
    const t = setInterval(() => setRefresh((v) => v + 1), 2000);
    return () => clearInterval(t);
  }, [data, readOnly]);
  async function action(path: string, body?: any) {
    if (readOnlyRef.current) return;
    setBusy(true);
    setError('');
    try {
      await api(path, 'POST', body ?? {});
      setRefresh((v) => v + 1);
      setConfirm(null);
      setAck(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return error ? (
      <p role="alert" className="error-block">
        {error}
      </p>
    ) : null;
  const simulation = data.channel?.settings.simulation;
  return (
    <section className="panel amazon-fulfillment-panel">
      <div className="panel-heading">
        <div>
          <h2>Wysyłka i numer śledzenia w Amazon</h2>
          <p>
            {simulation
              ? 'Przykład lokalny — bez żądań do Amazon.'
              : 'Podgląd i osobne zatwierdzenie przekazania wysyłki.'}
          </p>
        </div>
        <button
          className="button small-btn"
          onClick={() => setRefresh((v) => v + 1)}
          disabled={busy}
        >
          Odśwież wysyłkę Amazon
        </button>
      </div>
      <div className="info-body">
        {error && (
          <p role="alert" className="error-block">
            {error}
          </p>
        )}
        {readOnly && <p className="muted">Podgląd zapisanej lokalnie historii wysyłki. Zlecanie zmian i odczyt API dostawcy są wyłączone.</p>}
        {!data.ready && <p>{data.reason}</p>}
        {!readOnly && data.ready && (
          <>
            <p>
              Przekażemy wszystkie pozycje jednej przesyłki wraz z numerem śledzenia i czasem
              przekazania kurierowi. Nie nadaje to nowej paczki.
            </p>
            <label>
              Kod przewoźnika Amazon
              <input
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="np. DPD"
                maxLength={64}
                autoComplete="off"
              />
            </label>
            <label>
              Nazwa przewoźnika (wymagana dla Other)
              <input
                value={carrierName}
                onChange={(e) => setCarrierName(e.target.value)}
                maxLength={100}
              />
            </label>
            <label>
              Usługa przewoźnika (opcjonalna)
              <input
                value={shippingMethod}
                onChange={(e) => setShippingMethod(e.target.value)}
                maxLength={100}
              />
            </label>
            <p>
              Kod musi odpowiadać faktycznemu przewoźnikowi. Dla przewoźnika spoza listy Amazon użyj
              Other i podaj nazwę.
            </p>
            <button
              className="button"
              disabled={busy || !carrier || (carrier === 'Other' && !carrierName)}
              onClick={() =>
                action(`/orders/${order.id}/amazon-fulfillment/preview`, {
                  carrier_code: carrier,
                  ...(carrierName ? { carrier_name: carrierName } : {}),
                  ...(shippingMethod ? { shipping_method: shippingMethod } : {}),
                })
              }
            >
              Podgląd przekazania wysyłki
            </button>
          </>
        )}
        {data.data.map((p: any) => (
          <article key={p.id} className="status-plan">
            <strong>
              {p.state === 'done' && simulation
                ? 'Potwierdzono w przykładzie lokalnym'
                : names[p.state]}{' '}
              · {date(p.created_at)}
            </strong>
            <p>
              Przewoźnik: {p.payload.packageDetail.carrierCode}
              {p.payload.packageDetail.carrierName
                ? ` · ${p.payload.packageDetail.carrierName}`
                : ''}{' '}
              · numer: <b>{p.payload.packageDetail.trackingNumber}</b>
              <br />
              Przekazano: {date(p.payload.packageDetail.shipDate)} ·{' '}
              {p.payload.packageDetail.orderItems.reduce((n: number, i: any) => n + i.quantity, 0)}{' '}
              szt.
            </p>
            {p.payload.packageDetail.shippingMethod && (
              <p>Usługa: {p.payload.packageDetail.shippingMethod}</p>
            )}
            <p>
              ID paczki Amazon: <b>{p.payload.packageDetail.packageReferenceId}</b>
            </p>
            <details>
              <summary>Pozycje przesyłki</summary>
              {p.payload.packageDetail.orderItems.map((i: any) => (
                <p key={i.orderItemId}>
                  Pozycja Amazon {i.orderItemId}: {i.quantity} szt.
                </p>
              ))}
            </details>
            {p.remote.existing && (
              <p>
                Amazon ma już zgodny numer śledzenia. Potwierdzenie wykona odczyt bez nowego zapisu.
              </p>
            )}
            {p.error && <p className="error-inline">{p.error}</p>}
            {p.state === 'queued' && p.job_state === 'pending' && p.provider_wait_until && (
              <p>
                Oczekiwanie na API do {new Date(p.provider_wait_until).toLocaleString('pl-PL')}.{' '}
                {p.phase === 'ready'
                  ? 'Zgłoszenie nie zostało rozpoczęte.'
                  : 'Wznowienie sprawdzi wynik odczytem.'}
              </p>
            )}
            {p.result?.fulfillment && (
              <p>
                Potwierdzony numer: <b>{p.result.fulfillment.trackingNumber}</b>
                {p.result.unchanged ? ' · bez nowego zapisu' : ''}
              </p>
            )}
            {!readOnly && p.state === 'preview' && (
              <div>
                {!simulation && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={confirm === p.id}
                      onChange={(e) => setConfirm(e.target.checked ? p.id : null)}
                    />
                    Potwierdzam przekazanie wysyłki do Amazon. Dostawca może powiadomić kupującego.
                  </label>
                )}
                <button
                  className="button primary"
                  disabled={busy || (!simulation && confirm !== p.id)}
                  onClick={() =>
                    action(`/amazon-fulfillment-plans/${p.id}/queue`, {
                      confirm_external: confirm === p.id,
                    })
                  }
                >
                  Zatwierdź przekazanie wysyłki
                </button>
              </div>
            )}
            {!readOnly && ['preview', 'queued'].includes(p.state) && p.phase === 'ready' && (
              <button
                className="button"
                disabled={busy}
                onClick={() => action(`/amazon-fulfillment-plans/${p.id}/cancel`)}
              >
                Anuluj przekazanie
              </button>
            )}
            {!readOnly && ['failed', 'conflict'].includes(p.state) &&
              ['write_started', 'verify'].includes(p.phase) && (
                <div>
                  <p>
                    Niepewny zapis nie zostanie ponowiony. Odczytaj wynik albo uzgodnij go na koncie
                    Amazon.
                  </p>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => action(`/amazon-fulfillment-plans/${p.id}/reconcile`)}
                  >
                    Odczytaj wynik wysyłki
                  </button>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={ack === p.id}
                      onChange={(e) => setAck(e.target.checked ? p.id : null)}
                    />
                    Sprawdziłem konto Amazon i uzgodniłem rozbieżność. Odczyt nie potwierdza żądanej
                    wysyłki.
                  </label>
                  <button
                    className="button"
                    disabled={busy || ack !== p.id}
                    onClick={() =>
                      action(`/amazon-fulfillment-plans/${p.id}/reconcile`, {
                        acknowledge_mismatch: true,
                      })
                    }
                  >
                    Zamknij uzgodnioną rozbieżność
                  </button>
                </div>
              )}
          </article>
        ))}
      </div>
    </section>
  );
}
