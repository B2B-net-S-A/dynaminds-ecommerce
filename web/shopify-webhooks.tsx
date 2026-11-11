import { useEffect, useState } from 'react';
import { api, date } from './api';
export function ShopifyWebhooksPanel({ channelId }: { channelId: string }) {
  const [data, setData] = useState<any>(),
    [enabled, setEnabled] = useState(false),
    [secret, setSecret] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [dirty, setDirty] = useState(false),
    [editVersion, setEditVersion] = useState<number | null>(null);
  async function refresh() {
    const d = await api(`/integrations/${channelId}/shopify-webhooks`);
    setData(d);
    return d;
  }
  useEffect(() => {
    let active = true;
    const load = () =>
      api(`/integrations/${channelId}/shopify-webhooks`)
        .then((d) => {
          if (active) {
            setData(d);
            if (!dirty) setEnabled(!!d.config?.enabled);
          }
        })
        .catch((e) => active && setError(e.message));
    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [channelId, dirty]);
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
  if (!data) return <p className="info-body">{error || 'Wczytywanie powiadomień Shopify…'}</p>;
  return (
    <section className="panel shopify-webhooks-panel">
      <div className="panel-heading">
        <div>
          <h2>Powiadomienia Shopify</h2>
          <p>Powiadomienie zleca pobranie aktualnego zamówienia do przeglądu.</p>
        </div>
      </div>
      <div className="info-body">
        <p className="notice">
          {data.simulation
            ? 'Przykład lokalny weryfikuje podpis i wykonuje zadanie na danych demonstracyjnych. Nie korzysta z konta Shopify.'
            : 'Shopify wymaga dostępnego adresu HTTPS. Adres lokalny nie jest dostępny dla dostawcy. Konfiguracja tutaj włącza odbiornik; subskrypcje muszą zostać skonfigurowane w aplikacji Shopify.'}
        </p>
        <p>
          Obsługiwane powiadomienia: utworzenie, zmiana, opłacenie, anulowanie i realizacja
          zamówienia oraz zwrot. Zmiany już zaimportowanych zamówień wymagają uzgodnienia.
        </p>
        <label>
          Odbiornik lokalny
          <input aria-label="Odbiornik webhooków Shopify" readOnly value={data.receiver_path} />
        </label>
        <small>
          Wersja API {data.api_version} · maksymalnie {data.queue_limit} oczekujących zadań na
          kanał.
        </small>
        {data.config && !data.config.connection_matches && (
          <p className="import-error">
            Połączenie zmieniło się. Zapisz konfigurację dla aktualnego konta.
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const result = await api(`/integrations/${channelId}/shopify-webhooks`, 'PATCH', {
                version: editVersion ?? data.config?.version ?? 0,
                enabled,
                ...(secret ? { signing_secret: secret } : {}),
              });
              setSecret('');
              setDirty(false);
              setEditVersion(null);
              setEnabled(result.enabled);
              setMessage(
                result.enabled
                  ? 'Włączono odbiór powiadomień Shopify.'
                  : 'Wyłączono odbiór powiadomień Shopify.',
              );
            });
          }}
        >
          {!data.simulation && !data.client_secret_configured && (
            <label>
              Sekret aplikacji podpisującej webhooki
              <input
                type="password"
                autoComplete="new-password"
                aria-label="Sekret aplikacji webhooków Shopify"
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value);
                  setDirty(true);
                  setEditVersion((v) => v ?? data.config?.version ?? 0);
                }}
                placeholder={
                  data.signing_secret_configured
                    ? 'Zapisany; wpisz tylko przy zmianie'
                    : 'Sekret aplikacji Shopify'
                }
                minLength={16}
                required={!data.signing_secret_configured}
              />
            </label>
          )}
          <label className="check-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setDirty(true);
                setEditVersion((v) => v ?? data.config?.version ?? 0);
              }}
            />{' '}
            Odbieraj powiadomienia Shopify
          </label>
          <button className="button primary" disabled={busy}>
            Zapisz odbiór Shopify
          </button>
        </form>
        {data.simulation && data.config?.enabled && (
          <div className="inbound-actions">
            {(
              [
                ['created', 'Utworzenie'],
                ['updated', 'Zmiana'],
                ['cancelled', 'Anulowanie'],
              ] as const
            ).map(([kind, label]) => (
              <button
                className="button"
                key={kind}
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api(`/integrations/${channelId}/shopify-webhooks/example`, 'POST', {
                      kind,
                    });
                    setMessage(
                      'Przyjęto podpisane powiadomienie lokalne. Zadanie pobierze aktualne dane demonstracyjne.',
                    );
                  })
                }
              >
                {label} — przykład Shopify
              </button>
            ))}
          </div>
        )}
        {dirty && editVersion !== (data.config?.version ?? 0) && (
          <p className="import-error">
            Konfiguracja zmieniła się podczas edycji.
            <button
              type="button"
              className="button small-btn"
              disabled={busy}
              onClick={() => {
                setDirty(false);
                setEditVersion(null);
                setSecret('');
                setEnabled(!!data.config?.enabled);
                setError('');
              }}
            >
              Wczytaj aktualną konfigurację Shopify
            </button>
          </p>
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
        {!data.deliveries.length ? (
          <p>Brak dostaw Shopify.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Dostawa</th>
                  <th>Zamówienie</th>
                  <th>Wynik</th>
                  <th>Próby</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((d: any) => (
                  <tr key={d.id}>
                    <td>
                      {d.topic}
                      <small>{date(d.received_at)}</small>
                      <small>{d.delivery_id}</small>
                    </td>
                    <td>{d.order_gid}</td>
                    <td>
                      {
                        (
                          {
                            queued: 'W kolejce',
                            processed: 'Dane pobrane',
                            stopped: 'Zatrzymano',
                            failed: 'Błąd',
                          } as any
                        )[d.outcome]
                      }
                      <small>
                        {d.result.observation === 'older_ignored'
                          ? 'Pominięto starszą wersję'
                          : d.result.observation === 'unchanged'
                            ? 'Źródło bez zmian'
                            : d.error || d.result.reason || ''}
                      </small>
                    </td>
                    <td>
                      {d.attempts}/{d.max_attempts}
                    </td>
                    <td>
                      {['failed', 'stopped'].includes(d.outcome) && (
                        <button
                          className="button small-btn"
                          disabled={busy}
                          onClick={() =>
                            act(async () => {
                              await api(`/shopify-webhook-deliveries/${d.id}/retry`, 'POST', {});
                              setMessage('Zlecono ponowny odczyt źródła Shopify.');
                            })
                          }
                        >
                          Ponów odczyt Shopify
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
