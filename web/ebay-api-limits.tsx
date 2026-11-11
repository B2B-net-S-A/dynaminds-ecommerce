import { useEffect, useRef, useState } from 'react';
import { api, date } from './api';
const names: Record<string, string> = {
  inventory: 'Produkty i oferty',
  fulfillment: 'Zamówienia i wysyłki',
  account: 'Ustawienia sprzedawcy',
  taxonomy: 'Kategorie',
  oauth: 'OAuth',
  trading: 'Tożsamość konta',
  analytics: 'Limity przyznane przez eBay',
};
export function EbayApiLimits({ channelId, refresh = 0 }: { channelId: string; refresh?: number }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [version, setVersion] = useState(0),
    [quota, setQuota] = useState<any>(null),
    [quotaError, setQuotaError] = useState(''),
    [quotaBusy, setQuotaBusy] = useState(false);
  const quotaRequest = useRef(0);
  useEffect(() => {
    ++quotaRequest.current;
    setQuota(null);
    setQuotaError('');
    setQuotaBusy(false);
    return () => { ++quotaRequest.current; };
  }, [channelId]);
  async function readQuota() {
    const request = ++quotaRequest.current;
    setQuotaBusy(true);
    setQuota(null);
    setQuotaError('');
    try {
      const result = await api('/integrations/' + channelId + '/ebay/provider-quota/read', 'POST', {});
      if (request === quotaRequest.current) setQuota(result);
    } catch (e: any) {
      if (request === quotaRequest.current) setQuotaError(e.message);
    } finally {
      if (request === quotaRequest.current) setQuotaBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    setData(null);
    api('/integrations/' + channelId + '/ebay/api-limits')
      .then((d) => {
        if (active) {
          setData(d);
          setError('');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [channelId, refresh, version]);
  return (
    <details className="notice ebay-api-limits">
      <summary>Kontrola żądań API eBay</summary>
      <p>
        Wspólna kontrola aplikacji w danym środowisku: maksymalnie 4 jednoczesne żądania na obszar
        API. Przerwa po 429 obowiązuje także inne kanały korzystające z tej aplikacji.
      </p>
      <p>
        {data?.scope === 'local_simulation'
          ? 'Dane demonstracyjne tej firmy.'
          : 'Lokalne obserwacje żądań aplikacji.'}{' '}
        Dostępna dzienna pula przyznana przez eBay wymaga osobnej weryfikacji.
      </p>
      <button className="button small-btn" onClick={() => setVersion((v) => v + 1)}>
        Odśwież kontrolę API
      </button>
      {error && <p role="alert">{error}</p>}
      {data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Obszar</th>
                <th>W trakcie</th>
                <th>Przerwa do</th>
                <th>Odpowiedzi 429</th>
              </tr>
            </thead>
            <tbody>
              {data.families.map((f: any) => (
                <tr key={f.family}>
                  <td>{names[f.family]}</td>
                  <td>
                    {f.active_requests} / {data.concurrency_limit}
                  </td>
                  <td>{f.cooldown_until ? date(f.cooldown_until) : '—'}</td>
                  <td>{f.limited_responses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="ebay-provider-quota">
        <h4>Limity aplikacji przyznane przez eBay</h4>
        <p>
          Osobny odczyt eBay Developer Analytics dla aplikacji w wybranym środowisku.
          Obejmuje jej żądania także poza tym kanałem; nie jest limitem konta sprzedawcy.
          Nie zmienia lokalnej kontroli żądań powyżej. Dane pobierasz wyłącznie na żądanie.
        </p>
        <button type="button" className="button small-btn" onClick={readQuota}
          disabled={!data || data.scope === 'local_simulation' || quotaBusy}>
          {quotaBusy ? 'Odczytuję limity eBay…' : 'Odczytaj limity przyznane przez eBay'}
        </button>
        {data?.scope === 'local_simulation' && <p>Przykład lokalny nie potwierdza limitów eBay.</p>}
        {quotaError && <p role="alert">{quotaError}</p>}
        {quota && <>
          <p>Odczyt: {date(quota.observed_at)} · {quota.mode === 'sandbox' ? 'sandbox' : 'live'} · aplikacja</p>
          {quota.status === 'no_data'
            ? <p>eBay nie zwrócił danych limitów. Nie oznacza to zerowej ani nieograniczonej puli.</p>
            : <div className="table-wrap"><table><thead><tr>
              <th>API / zasób</th><th>Okno (s)</th><th>Limit</th><th>Wykorzystano</th>
              <th>Pozostało</th><th>Reset</th>
            </tr></thead><tbody>{quota.rows.map((row: any) => <tr key={JSON.stringify([
              row.api_context, row.api_name, row.api_version, row.resource, row.window_seconds,
            ])}>
              <td>{row.api_context}/{row.api_name}/{row.api_version} · {row.resource}</td>
              <td>{row.window_seconds.toLocaleString('pl-PL')}</td>
              <td>{row.limit.toLocaleString('pl-PL')}</td>
              <td>{row.count === null ? 'Brak danych' : row.count.toLocaleString('pl-PL')}</td>
              <td>{row.remaining.toLocaleString('pl-PL')}</td><td>{date(row.reset)}</td>
            </tr>)}</tbody></table></div>}
        </>}
      </section>
    </details>
  );
}
