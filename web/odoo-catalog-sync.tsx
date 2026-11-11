import { useEffect, useRef, useState } from 'react';
import { api, date, money } from './api';
export function OdooCatalogSync({ channelId }: { channelId: string }) {
  const [data, setData] = useState<any>(),
    [enabled, setEnabled] = useState(false),
    [prices, setPrices] = useState(false),
    [interval, setInterval] = useState(60),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [runId, setRunId] = useState(''),
    [detail, setDetail] = useState<any>(),
    [after, setAfter] = useState('');
  const version = useRef(-1),
    key = useRef(crypto.randomUUID());
  const accept = (d: any) => {
    setData(d);
    const v = d.config?.version ?? 0;
    if (v !== version.current) {
      version.current = v;
      setEnabled(d.config?.enabled ?? false);
      setPrices(d.config?.prices ?? false);
      setInterval(d.config?.interval_minutes ?? 60);
      setConfirmed(false);
      key.current = crypto.randomUUID();
    }
  };
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api(`/integrations/${channelId}/odoo-catalog-sync`)
        .then((d) => active && accept(d))
        .catch((e) => active && setError(e.message));
    refresh();
    const t = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, [channelId]);
  useEffect(() => {
    if (!runId) return;
    let active = true;
    const refresh = () =>
      api(`/odoo-catalog-sync-runs/${runId}${after ? '?after=' + after : ''}`)
        .then((d) => active && setDetail(d))
        .catch((e) => active && setError(e.message));
    refresh();
    const t = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, [runId, after]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      accept(await api(`/integrations/${channelId}/odoo-catalog-sync`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <p>{error || 'Wczytywanie harmonogramu Odoo…'}</p>;
  const states: Record<string, string> = {
    queued: 'Odczyt w kolejce',
    success: 'Zakończono',
    partial: 'Częściowy wynik',
    failed: 'Błąd',
    cancelled: 'Zatrzymano',
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Ceny i dostępność Odoo</h2>
          <p>Automatyczny odczyt już powiązanych wariantów.</p>
        </div>
      </div>
      <div className="info-body">
        <p className="notice">
          {data.channel.simulation
            ? 'PRZYKŁAD LOKALNY — dane syntetyczne, bez API ERP.'
            : 'Odczyt API ERP, zapis danych lokalnie.'}{' '}
          Dostępność ERP jest oddzielna od fizycznego stanu i rezerwacji. Nowe SKU importuj z
          podglądu katalogu.
        </p>
        {error && (
          <p role="alert" className="error-block">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <div className="import-toolbar">
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />{' '}
            Harmonogram aktywny
          </label>
          <label>
            Interwał w minutach
            <input
              aria-label="Interwał katalogu Odoo"
              type="number"
              min={30}
              max={10080}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={prices}
              onChange={(e) => {
                setPrices(e.target.checked);
                setConfirmed(false);
              }}
            />{' '}
            Aktualizuj lokalne ceny
          </label>
        </div>
        {enabled && prices && (
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            Potwierdzam automatyczne zmiany cen powiązanych produktów według ERP i lokalnego VAT.
          </label>
        )}
        <p className="muted">
          Kwoty brutto obliczamy z ceny ERP według wybranego trybu netto/brutto i lokalnego VAT, bez
          przeliczeń walut. Zmiana produktu, VAT lub powiązania podczas odczytu powoduje pominięcie
          pozycji. Nowe zamówienia korzystają z aktualnej ceny; wcześniejsze zachowują zapisane
          kwoty. Aktywne automatyzacje ofert mogą korzystać ze zmienionych cen.
        </p>
        <button
          className="button"
          disabled={busy || (enabled && prices && !confirmed)}
          onClick={() =>
            act(async () => {
              await api(`/integrations/${channelId}/odoo-catalog-sync`, 'PUT', {
                version: data.config?.version ?? 0,
                enabled,
                prices,
                interval_minutes: interval,
                confirmed,
              });
              setMessage(
                'Zapisano harmonogram. Zmiana konfiguracji zatrzymuje poprzednie odczyty.',
              );
            })
          }
        >
          Zapisz harmonogram katalogu
        </button>{' '}
        <button
          className="button primary"
          disabled={busy || !data.config?.enabled}
          onClick={() =>
            act(async () => {
              const r = await api(`/integrations/${channelId}/odoo-catalog-sync`, 'POST', {
                version: data.config.version,
                client_key: key.current,
              });
              key.current = crypto.randomUUID();
              setRunId(r.id);
              setAfter('');
              setMessage(
                r.replayed ? 'Zwrócono wcześniejsze zlecenie.' : 'Zlecono odczyt katalogu.',
              );
            })
          }
        >
          Odśwież katalog teraz
        </button>
        <p>
          Status: {data.config?.enabled ? 'Aktywny' : 'Wyłączony'} · Następny:{' '}
          {data.config?.next_at ? date(data.config.next_at) : '—'}
        </p>
        {data.config?.error && <p role="alert">{data.config.error}</p>}
        <h3>Historia odczytów</h3>
        {!data.runs.length && <p>Brak odczytów.</p>}
        {data.runs.map((r: any) => (
          <div key={r.id}>
            <button
              className="button small-btn"
              onClick={() => {
                setRunId(r.id);
                setAfter('');
                setDetail(null);
              }}
            >
              {date(r.created_at)} · {states[r.state]} · {r.applied}/{r.total} odświeżono,{' '}
              {r.skipped} pominięto
            </button>
          </div>
        ))}
        {detail && (
          <>
            <h3>Wyniki wybranego odczytu</h3>
            <p>
              {states[detail.run.state]}
              {detail.run.error ? ' · ' + detail.run.error : ''}
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU / ID ERP</th>
                  <th>Dostępność ERP</th>
                  <th>Cena brutto z ERP</th>
                  <th>Cena lokalna</th>
                  <th>Wynik</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.map((i: any) => (
                  <tr key={i.id}>
                    <td>
                      {i.sku} / {i.external_id}
                    </td>
                    <td>{i.result?.availability ?? '—'}</td>
                    <td>{i.result ? money(i.result.price, i.result.currency) : '—'}</td>
                    <td>{i.result ? money(i.result.local_price_after, i.local_currency) : '—'}</td>
                    <td>{i.state === 'applied' ? 'Odświeżono' : i.error || 'Oczekuje'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="button small-btn" disabled={!after} onClick={() => setAfter('')}>
              Pierwsza strona
            </button>{' '}
            <button
              className="button small-btn"
              disabled={!detail.next_cursor}
              onClick={() => setAfter(detail.next_cursor)}
            >
              Kolejna strona
            </button>
          </>
        )}
      </div>
    </section>
  );
}
