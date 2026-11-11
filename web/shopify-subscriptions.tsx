import { useEffect, useState } from 'react';
import { api, date } from './api';
export function ShopifySubscriptionsPanel({ channelId }: { channelId: string }) {
  const [data, setData] = useState<any>(),
    [uri, setUri] = useState(''),
    [topic, setTopic] = useState('ORDERS_CREATE'),
    [preview, setPreview] = useState<any>(),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function refresh() {
    const d = await api(`/integrations/${channelId}/shopify-subscriptions`);
    setData(d);
    return d;
  }
  useEffect(() => {
    let active = true;
    const load = () =>
      api(`/integrations/${channelId}/shopify-subscriptions`)
        .then((d) => {
          if (active) {
            setData(d);
            setUri(
              (v) => v || (d.simulation ? 'https://local-example.invalid' + d.receiver_path : ''),
            );
          }
        })
        .catch((e) => active && setError(e.message));
    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [channelId]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <p>{error || 'Wczytywanie subskrypcji Shopify…'}</p>;
  const states: any = {
    preview: 'Podgląd',
    queued: 'W kolejce',
    done: 'Potwierdzone odczytem',
    failed: 'Błąd',
    uncertain: 'Wymaga odczytu wyniku',
    cancelled: 'Anulowane',
    conflict: 'Konflikt',
  };
  return (
    <section className="panel shopify-subscriptions-panel">
      <div className="panel-heading">
        <div>
          <h2>Subskrypcje zdarzeń Shopify</h2>
          <p>Zarejestruj tematy dla odbiornika lub sprawdź istniejące połączenie.</p>
        </div>
      </div>
      <div className="info-body">
        <p className="notice">
          {data.simulation
            ? 'Przykład lokalny przechowuje rejestrację w tej aplikacji. Nie tworzy subskrypcji Shopify ani publicznego adresu.'
            : 'Shopify wymaga osiągalnego HTTPS z prawidłowym certyfikatem. Rejestracja kieruje zdarzenia do podanego odbiornika. Sama lokalna aplikacja nie udostępnia go w Internecie.'}
        </p>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            act(async () => {
              await api(`/integrations/${channelId}/shopify-subscriptions/read`, 'POST', {});
              setMessage('Odczytano subskrypcje aplikacji i sklepu.');
            })
          }
        >
          {data.simulation ? 'Odczytaj lokalny rejestr' : 'Odczytaj subskrypcje Shopify'}
        </button>
        <p>
          Lista z API obejmuje subskrypcje danego sklepu utworzone przez bieżącą aplikację.
          Subskrypcje z konfiguracji aplikacji TOML nie są tu zwracane.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              setPreview(
                await api(`/integrations/${channelId}/shopify-subscriptions/preview`, 'POST', {
                  operation: 'create',
                  topic,
                  uri,
                }),
              );
              setApproved(false);
            });
          }}
        >
          <label>
            Adres odbiornika HTTPS
            <input
              type="url"
              aria-label="Adres subskrypcji Shopify"
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              required
              readOnly={data.simulation}
              placeholder={'https://twoja-domena.pl' + data.receiver_path}
            />
          </label>
          <label>
            Temat
            <select
              aria-label="Temat subskrypcji Shopify"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            >
              {data.topics.map((t: string) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <button className="button" disabled={busy}>
            Przygotuj rejestrację Shopify
          </button>
        </form>
        {preview && (
          <div className="notice">
            <div>
              <strong>
                {preview.operation === 'create' ? 'Podgląd rejestracji' : 'Podgląd usunięcia'}
              </strong>
              <p>
                {preview.spec.topic || preview.spec.remote?.topic} ·{' '}
                {preview.spec.webhookSubscription?.uri || preview.spec.remote?.uri}
              </p>
              <p>
                {preview.operation === 'create'
                  ? 'Zdarzenie będzie zawierało tylko ID. System pobierze aktualne dane zamówienia.'
                  : 'Usunięcie kończy dostawy tej subskrypcji. Nie usuwa historii zamówień ani danych lokalnych.'}
              </p>
              {!data.simulation && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={approved}
                    onChange={(e) => setApproved(e.target.checked)}
                  />
                  Zatwierdzam wskazany odbiornik HTTPS i zmianę na koncie Shopify
                </label>
              )}
              <button
                className="button primary"
                disabled={busy || (!data.simulation && !approved)}
                onClick={() =>
                  act(async () => {
                    await api(`/shopify-subscription-plans/${preview.id}/queue`, 'POST', {
                      external_authorized: approved,
                    });
                    setPreview(undefined);
                    setMessage('Zlecono zmianę subskrypcji. Wynik zostanie sprawdzony odczytem.');
                  })
                }
              >
                {data.simulation
                  ? preview.operation === 'create'
                    ? 'Zatwierdź przykład rejestracji'
                    : 'Zatwierdź przykład usunięcia'
                  : 'Zatwierdź zmianę w Shopify'}
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api(`/shopify-subscription-plans/${preview.id}/cancel`, 'POST', {});
                    setPreview(undefined);
                  })
                }
              >
                Anuluj podgląd subskrypcji
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="import-error">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="notice">
            {message}
          </p>
        )}
        {data.observation && (
          <>
            <p>
              Odczyt: {date(data.observation.observed_at)} ·{' '}
              {data.observation.source === 'local_simulation'
                ? 'przykład lokalny'
                : 'GraphQL Shopify'}
              {!data.observation.connection_matches ? ' · wcześniejsze połączenie' : ''}
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Temat</th>
                    <th>Odbiornik</th>
                    <th>Wersja / format</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.observation.data.map((r: any) => (
                    <tr key={r.id}>
                      <td>
                        {r.topic}
                        <small>{r.id}</small>
                      </td>
                      <td>{r.uri}</td>
                      <td>
                        {r.apiVersion.handle} / {r.format}
                        {r.filter ? ' · filtr' : ''}
                      </td>
                      <td>
                        {data.observation.connection_matches && r.managed_by_channel && (
                          <button
                            className="button small-btn"
                            disabled={busy}
                            onClick={() =>
                              act(async () => {
                                setPreview(
                                  await api(
                                    `/integrations/${channelId}/shopify-subscriptions/preview`,
                                    'POST',
                                    { operation: 'delete', remote_id: r.id },
                                  ),
                                );
                                setApproved(false);
                              })
                            }
                          >
                            Przygotuj usunięcie subskrypcji
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.observation.data.length === 0 && <p>Brak subskrypcji w tym odczycie.</p>}
          </>
        )}
        <h3>Historia rejestracji</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Operacja</th>
                <th>Wynik</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.plans.map((p: any) => (
                <tr key={p.id}>
                  <td>
                    {p.operation === 'create' ? 'Rejestracja' : 'Usunięcie'} ·{' '}
                    {p.spec.topic || p.spec.remote?.topic}
                    <small>{date(p.created_at)}</small>
                  </td>
                  <td>
                    {states[p.state]}
                    <small>{p.error || p.result.remote_id || ''}</small>
                  </td>
                  <td>
                    {p.state === 'uncertain' && (
                      <button
                        className="button small-btn"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await api(`/shopify-subscription-plans/${p.id}/reconcile`, 'POST', {});
                            setMessage('Wynik sprawdzony odczytem.');
                          })
                        }
                      >
                        Odczytaj wynik subskrypcji
                      </button>
                    )}
                    {['preview', 'queued'].includes(p.state) && p.phase === 'fresh' && (
                      <button
                        className="button small-btn"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await api(`/shopify-subscription-plans/${p.id}/cancel`, 'POST', {});
                          })
                        }
                      >
                        Anuluj subskrypcję w kolejce
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
