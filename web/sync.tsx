import {LocalWooJobControl,LocalWooOrderQueueButton,type LocalWooContext} from './configured-woo';
import {OrdinaryConnectorJobControl,type ConnectorJobContext} from './ordinary-connector-job';
import { ShopifySubscriptionsPanel } from './shopify-subscriptions';
import { useEffect, useState } from 'react';
import { ShopifyWebhooksPanel } from './shopify-webhooks';
import { api, date } from './api';
import { RefreshCw, ShieldCheck, Webhook, Clock, Check, AlertCircle } from 'lucide-react';
export function SyncPanel({ channelId,localWooContext,connectorContext }: { channelId: string;localWooContext?:LocalWooContext;connectorContext?:ConnectorJobContext }) {
  const [data, setData] = useState<any>(),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [interval, setIntervalValue] = useState(''),
    [secret, setSecret] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api(`/integrations/${channelId}/sync`)
        .then((d) => {
          if (active) {
            setData(d);
            setIntervalValue((v) => v || String(d.channel.sync_interval));
          }
        })
        .catch((e) => active && setError(e.message));
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [channelId]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      setData(await api(`/integrations/${channelId}/sync`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <div className="info-body">{error || 'Wczytywanie synchronizacji…'}</div>;
  const ch = data.channel;
  const manualConnector = !localWooContext && !!connectorContext && ch.provider === 'allegro' && !ch.simulation;
  const states: Record<string, string> = {
    pending: 'Oczekuje',
    running: 'W trakcie',
    done: 'Zakończone',
    failed: 'Nieudane',
  };
  return (
    <div className="import-workspace">
      <div className="notice">
        <ShieldCheck size={22} />
        <span>
          {ch.simulation
            ? ch.provider === 'ebay'
              ? 'Lokalny przykład eBay nie łączy się z marketplace ani nie uruchamia harmonogramu.'
              : ch.provider === 'odoo'
                ? 'Lokalny przykład Odoo nie łączy się z ERP ani nie uruchamia harmonogramu.'
                : ch.provider === 'prestashop'
                  ? 'Przykład lokalny PrestaShop nie łączy się ze sklepem ani nie uruchamia harmonogramu.'
                  : 'Przykład lokalny: można sprawdzić podpis i trwałe przyjęcie powiadomienia. Nie łączy się ze sklepem.'
            : 'Synchronizacja odczytuje zamówienia do kolejki importu. Zmiany zaimportowanych zamówień wymagają uzgodnienia. Publikacja ofert i zapisy cen/stanów nie są wykonywane.'}
        </span>
      </div>
      {error && (
        <div role="alert" className="notice import-error">
          <AlertCircle size={20} />
          {error}
        </div>
      )}
      {message && (
        <div role="status" className="notice">
          <Check size={20} />
          {message}
        </div>
      )}
      {!ch.simulation && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Pobieranie zamówień</h2>
              <p>{localWooContext?'Jedno jawnie zlecone zadanie. Wykonanie raz, następnie odczyt wyniku bez ponawiania.':'Jedno zadanie dla kanału, z ponowieniami i zapamiętanym postępem.'}</p>
            </div>
            <RefreshCw size={20} />
          </div>
          <div className="info-body">
            {localWooContext?<LocalWooOrderQueueButton {...localWooContext} channelId={channelId} onChanged={()=>void action(async()=>{})}/>:<div className="import-toolbar">
              <label>
                Interwał w sekundach
                <input
                  aria-label="Interwał synchronizacji"
                  type="number"
                  min="60"
                  max="86400"
                  value={interval}
                  onChange={(e) => setIntervalValue(e.target.value)}
                />
              </label>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api(`/integrations/${channelId}/sync`, 'PATCH', {
                      enabled: !ch.sync_enabled,
                      interval: Number(interval),
                    });
                    setMessage(
                      ch.sync_enabled ? 'Wyłączono harmonogram.' : 'Włączono harmonogram.',
                    );
                  })
                }
              >
                {ch.sync_enabled ? 'Wyłącz harmonogram' : 'Włącz harmonogram'}
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    const r = await api(`/integrations/${channelId}/sync`, 'POST');
                    setMessage(
                      r.reused
                        ? 'Ten kanał ma już aktywne zadanie.'
                        : 'Zlecono pobieranie zamówień.',
                    );
                  })
                }
              >
                Synchronizuj teraz
              </button>
            </div>}
            <p className="muted">
              <Clock size={14} /> Ostatni przebieg:{' '}
              {ch.last_sync_at ? date(ch.last_sync_at) : 'jeszcze nie zakończono'} · Harmonogram{' '}
              {ch.sync_enabled ? 'aktywny' : 'wyłączony'}
            </p>
            {ch.event_cursor && (
              <p className="muted">
                {ch.provider === 'odoo'
                  ? `Odczytano zmiany zamówień do ${ch.event_cursor} UTC.`
                  : ch.provider === 'allegro'
                    ? 'Zapisano postęp dziennika zdarzeń Allegro.'
                    : 'Zapisano postęp synchronizacji.'}
              </p>
            )}
            {ch.provider === 'odoo' && (
              <p className="muted">
                Harmonogram śledzi zmiany zamówień. Samodzielne zmiany płatności lub adresów mogą
                wymagać pełnego odczytu: Import i powiązania → Od początku → Pobierz zamówienia.
                Zmiany po imporcie wymagają uzgodnienia.
              </p>
            )}
          </div>
        </section>
      )}
      {data.webhook_url && !localWooContext && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Powiadomienia WooCommerce</h2>
              <p>Podpis HMAC oraz trwała kolejka dostaw.</p>
            </div>
            <Webhook size={20} />
          </div>
          <div className="info-body">
            <p>
              Adres odbioru: <code className="webhook-address">{data.webhook_url}</code>
            </p>
            <p className="muted">
              Lokalny adres nie jest dostępny z hostowanego sklepu. Dostawy zewnętrzne wymagają
              późniejszego ustalenia połączenia sieciowego.
            </p>
            <p className="source-label">
              Sekret podpisu: {ch.webhook_configured ? 'ustawiony' : 'nieustawiony'}
            </p>
            <form
              className="import-toolbar"
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  await api(`/integrations/${channelId}/webhook`, 'POST', { secret });
                  setSecret('');
                  setMessage(
                    'Zapisano sekret podpisu. Ustaw ten sam sekret w WooCommerce dla zamówień utworzonych i zmienionych.',
                  );
                });
              }}
            >
              <label>
                Sekret podpisu
                <input
                  aria-label="Sekret podpisu webhooka"
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  minLength={16}
                  maxLength={256}
                  required
                  autoComplete="new-password"
                />
              </label>
              <button className="button" disabled={busy}>
                Zapisz sekret
              </button>
            </form>
            {ch.simulation && (
              <button
                className="button primary"
                disabled={busy || !ch.webhook_configured}
                onClick={() =>
                  action(async () => {
                    await api(`/integrations/${channelId}/demo-webhook`, 'POST');
                    setMessage(
                      'Przyjęto podpisane powiadomienie lokalnego przykładu. Zadanie przetworzy kolejka.',
                    );
                  })
                }
              >
                Sprawdź lokalne powiadomienie
              </button>
            )}
          </div>
        </section>
      )}
      {ch.provider === 'shopify' && data.shopify_webhooks_available && (
        <ShopifyWebhooksPanel channelId={channelId} />
      )}
      {ch.provider === 'shopify' && data.shopify_subscriptions_available && (
        <ShopifySubscriptionsPanel channelId={channelId} />
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Zadania kanału</h2>
            <p>Odświeżanie co 3 sekundy. Próby i błędy są zapisane w bazie.</p>
          </div>
        </div>
        {!data.jobs.length ? (
          <p className="info-body">Brak zadań tego kanału.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Zadanie</th>
                  <th>Stan</th>
                  <th>Próby</th>
                  <th>Szczegóły</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((j: any) => (
                  <tr key={j.id}>
                    <td>
                      {j.kind === 'orders.sync'
                        ? 'Pobieranie zamówień'
                        : j.kind === 'shopify.subscription'
                          ? 'Rejestracja powiadomień Shopify'
                          : j.kind === 'shopify.webhook'
                            ? 'Odczyt powiadomienia Shopify'
                            : 'Powiadomienie sklepu'}
                      <small>{date(j.created_at)}</small>
                    </td>
                    <td>{states[j.state]}</td>
                    <td>
                      {j.attempts}/{j.max_attempts}
                    </td>
                    <td>
                      {j.error ||
                        (j.phase
                          ? `${j.phase === 'events' ? 'Zdarzenia' : 'Pierwszy odczyt'} · strona ${j.page}`
                          : j.kind === 'shopify.subscription'
                            ? 'Plan subskrypcji'
                            : 'Podpisana dostawa')}
                    </td>
                    <td>
                      {localWooContext&&j.kind==='orders.sync'&&<LocalWooJobControl {...localWooContext} channelId={channelId} jobId={j.id} onChanged={()=>void action(async()=>{})}/>}
                      {manualConnector&&j.kind==='orders.sync'&&<OrdinaryConnectorJobControl {...connectorContext!} jobId={j.id} kind={j.kind} onChanged={()=>void action(async()=>{})}/>}
                      {!localWooContext&&!manualConnector&&j.state === 'failed' &&
                        !['shopify.webhook', 'shopify.subscription'].includes(j.kind) && (
                          <button
                            className="button small-btn"
                            disabled={busy}
                            onClick={() =>
                              action(async () => {
                                await api(`/integration-jobs/${j.id}/retry`, 'POST');
                                setMessage('Zlecono ponowienie zadania.');
                              })
                            }
                          >
                            Ponów
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {data.deliveries.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <h2>Przyjęte powiadomienia</h2>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Dostawa</th>
                  <th>Zdarzenie</th>
                  <th>Odebrano</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((d: any) => (
                  <tr key={d.delivery_id}>
                    <td>
                      <code>{d.delivery_id}</code>
                    </td>
                    <td>{d.topic === 'order.created' ? 'Nowe zamówienie' : 'Zmiana zamówienia'}</td>
                    <td>{date(d.received_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
