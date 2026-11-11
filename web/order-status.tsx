import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date, statusNames } from './api';
import {LocalWooJobControl,readConfiguredWooList,type LocalWooContext} from './configured-woo';
const names: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'W kolejce',
  done: 'Potwierdzono',
  conflict: 'Wymaga decyzji',
  failed: 'Błąd / niepewny wynik',
  cancelled: 'Anulowano',
};
function useStatus(path: string, version?: unknown, readOnly = false) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    api(path)
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
  }, [path, refresh, version]);
  useEffect(() => {
    if (readOnly) return;
    if (!data?.config?.enabled && !data?.data?.some((p: any) => p.state === 'queued')) return;
    const t = setInterval(() => setRefresh((v) => v + 1), 2500);
    return () => clearInterval(t);
  }, [data, readOnly]);
  return { data, error, setError, reload: () => setRefresh((v) => v + 1) };
}
function Plans({
  data,
  action,
  busy,
  localWooContext,
  channelId,
  onLocalChanged,
  readOnly = false,
}: {
  readOnly?: boolean;
  localWooContext?: LocalWooContext;
  channelId?: string;
  onLocalChanged?: () => void;
  data: any[];
  action: (path: string, body?: any) => Promise<void>;
  busy: boolean;
}) {
  const [ack, setAck] = useState<string | null>(null);
  return (
    <div className="status-plans">
      {data.map((p) => (
        <article className="status-plan" key={p.id}>
          <div>
            <strong>
              {p.number ?? statusNames[p.local_status]} → {p.target}
            </strong>
            <span>
              {names[p.state]} · {date(p.created_at)}
            </span>
          </div>
          {p.remote.status && (
            <p>
              Status kanału w podglądzie: <b>{p.remote.status}</b>
              {p.result && (
                <>
                  {' '}
                  · ostatni odczyt: <b>{p.result.status}</b>
                  {p.result.unchanged && ' · bez zapisu'}
                  {p.result.stale_local && ' · zamówienie zmieniono po podglądzie'}
                </>
              )}
            </p>
          )}
          {p.error && <p className="error-inline">{p.error}</p>}
          {!readOnly && localWooContext && p.job_id && p.channel_id === channelId && p.tenant_id === localWooContext.tenantId && p.actor_id === localWooContext.userId && (
            <LocalWooJobControl key={localWooContext.tenantId + ':' + localWooContext.userId + ':' + p.channel_id + ':' + p.job_id} {...localWooContext} channelId={p.channel_id} jobId={p.job_id} onChanged={onLocalChanged} />
          )}
          {!readOnly && p.state === 'queued' && p.phase === 'ready' && (
            <button
              className="button small-btn"
              disabled={busy}
              onClick={() => action('/channel-status-plans/' + p.id + '/cancel')}
            >
              Anuluj oczekujący zapis
            </button>
          )}
          {!readOnly && p.state === 'failed' && ['write_started', 'verify'].includes(p.phase) && (
            <div>
              <button
                className="button small-btn"
                disabled={busy}
                onClick={() => action('/channel-status-plans/' + p.id + '/reconcile')}
              >
                Odczytaj wynik ponownie
              </button>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={ack === p.id}
                  onChange={(e) => setAck(e.target.checked ? p.id : null)}
                />
                Potwierdzam zamknięcie niezgodności po odczycie. Kolejny zapis będzie wymagał nowego
                podglądu.
              </label>
              <button
                className="button small-btn"
                disabled={busy || ack !== p.id}
                onClick={() =>
                  action('/channel-status-plans/' + p.id + '/reconcile', {
                    acknowledge_mismatch: true,
                  })
                }
              >
                Odczytaj i zamknij niezgodność
              </button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
export function OrderChannelStatus({ order, localWooContext, readOnly = false }: { order: any; localWooContext?: LocalWooContext; readOnly?: boolean }) {
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const { data, error, setError, reload } = useStatus(
      '/orders/' + order.id + '/channel-status',
      order.version,
      readOnly,
    ),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<any>(null),
    [confirm, setConfirm] = useState(false);
  const localScope = localWooContext ? [localWooContext.tenantId, localWooContext.userId, localWooContext.admin, localWooContext.readOnly, !!localWooContext.externalWriteBlocked, order.id, order.channel_id].join(':') : '';
  const [localChannel, setLocalChannel] = useState<{scope:string;id:string}|null>(null);
  const [localError, setLocalError] = useState('');
  useEffect(() => {
    let active = true;setLocalChannel(null);setLocalError('');
    if (!readOnly && order.source === 'woocommerce' && localWooContext?.admin && order.channel_id) {
      api('/local-fixtures/woocommerce/channels').then(value => {
        const match = readConfiguredWooList(value).find(ch => ch.channel_id === order.channel_id && ch.enrolled);
        if (active && match) setLocalChannel({scope:localScope,id:match.channel_id});
      }).catch(e => {if (active && !(e instanceof ApiError && e.status === 404)) setLocalError(e.message);});
    }
    return () => {active = false;};
  }, [localScope, order.source, readOnly]);
  const ownLocalContext = localChannel?.scope === localScope && localChannel?.id === order.channel_id && data?.channel?.id === order.channel_id && data?.channel?.provider === 'woocommerce' ? localWooContext : undefined;
  async function action(path: string, body: any = {}) {
    if (readOnlyRef.current) return;
    setBusy(true);
    setError('');
    try {
      await api(path, 'POST', body);
      setPreview(null);
      setConfirm(false);
      reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <section className="panel order-channel-status">
        <h2>Status w kanale sprzedaży</h2>
        {error && <p className="error-inline">{error}</p>}
      </section>
    );
  const simulation = Boolean(data.channel?.settings.simulation);
  return (
    <section className="panel order-channel-status">
      <div className="panel-heading">
        <div>
          <h2>Status w kanale sprzedaży</h2>
          <p>
            {data.channel?.name} · {simulation ? 'Symulacja lokalna' : 'API dostawcy'}
            {data.config?.enabled ? ' · automatyczny zapis włączony' : ''}
          </p>
        </div>
        <button className="button small-btn" disabled={busy} onClick={reload}>
          Odśwież status kanału
        </button>
      </div>
      <p>
        {data.target ? (
          <>
            Lokalnie: <b>{statusNames[data.local_status]}</b> → w kanale: <b>{data.target}</b>.
          </>
        ) : (
          data.reason
        )}
      </p>
      {error && (
        <p className="error-inline" role="alert">
          {error}
        </p>
      )}
      {!readOnly && data.target && (
        <button
          className="button small-btn"
          disabled={busy}
          onClick={async () => {
            if (readOnlyRef.current) return;
            setBusy(true);
            setError('');
            try {
              setPreview(await api('/orders/' + order.id + '/channel-status/preview', 'POST', {}));
              setConfirm(false);
              reload();
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Podgląd zmiany statusu
        </button>
      )}
      {!readOnly && preview && (
        <div className="status-preview">
          <strong>
            W kanale: {preview.remote.status} → {preview.target}
          </strong>
          <p>Po zleceniu system ponownie sprawdzi zamówienie i potwierdzi wynik odczytem.</p>
          {data.channel?.provider === 'prestashop' && (
            <p>
              Wpis historii PrestaShop bez email. Zmiana może uruchomić moduły sklepu i jego
              operacje magazynowe/dokumentowe. Zwrot ani płatność nie są zlecane przez DYNAMINDS.
            </p>
          )}
          {!simulation && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              Zatwierdzam zapis do API. Kanał sprzedaży może wysłać powiadomienie kupującemu,
              również dla połączenia sandbox.
            </label>
          )}
          <button
            className="button primary"
            disabled={busy || (!simulation && !confirm)}
            onClick={() =>
              action('/channel-status-plans/' + preview.id + '/queue', {
                confirm_external: confirm,
              })
            }
          >
            Zleć zmianę statusu
          </button>
        </div>
      )}
      {readOnly && <p className="muted">Zapisane lokalnie informacje o statusie. Odczyt API dostawcy i zlecanie zmian są wyłączone w podglądzie.</p>}
      {localError && <p className="error-inline" role="alert">{localError}</p>}
      <Plans
        readOnly={readOnly}
        localWooContext={ownLocalContext}
        channelId={data.channel?.id}
        onLocalChanged={reload}
        data={data.data.filter((p: any) => p.state !== 'preview')}
        action={action}
        busy={busy}
      />
    </section>
  );
}
export function OrderStatusConfig({ channelId, readOnly = false }: { channelId: string; readOnly?: boolean }) {
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const { data, error, setError, reload } = useStatus(
      '/integrations/' + channelId + '/order-status', undefined, readOnly,
    ),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  async function action(path: string, body: any = {}) {
    if (readOnlyRef.current) return;
    setBusy(true);
    setError('');
    try {
      await api(path, 'POST', body);
      reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <p>{error || 'Wczytywanie konfiguracji statusów…'}</p>;
  const simulation = Boolean(data.channel.settings.simulation);
  return (
    <div className="order-status-config">
      <p>
        <b>{data.channel.name}</b> · {simulation ? 'Symulacja lokalna' : 'Zapis do API dostawcy'}
      </p>
      <p>
        Automatyczny zapis podąża za realizacją zamówienia. Obejmuje wcześniejsze importy. Zwroty i
        refundacje wymagają osobnego uzgodnienia.
      </p>
      {readOnly && <p className="muted">Konfiguracja i historia są dostępne do odczytu. Zapisy i odczyt API dostawcy są wyłączone w podglądzie.</p>}
      <button className="button" disabled={busy} onClick={reload}>Odśwież konfigurację statusów</button>
      <form
        key={data.config?.version ?? 0}
        onSubmit={async (e) => {
          e.preventDefault();
          if (readOnlyRef.current) return;
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          setNotice('');
          try {
            await api('/integrations/' + channelId + '/order-status', 'PATCH', {
              version: data.config?.version ?? 0,
              enabled: f.get('enabled') === 'on',
              confirm_external: f.get('confirm') === 'on',
              ...(data.channel.provider === 'prestashop'
                ? {
                    mappings: Object.fromEntries(
                      [
                        'paid',
                        'picking',
                        'packed',
                        'shipped',
                        'delivered',
                        'completed',
                        'cancelled',
                      ].map((k) => [k, String(f.get('state_' + k) ?? '')]),
                    ),
                  }
                : {}),
            });
            setNotice('Zapisano konfigurację statusów.');
            reload();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {data.channel.provider === 'prestashop' && (
          <>
            <p>
              Wprowadź ID statusów z własnego sklepu. Znaczenie flag wysyłki i doręczenia będzie
              sprawdzone przed zmianą. Pobranie wymaga statusów bez flagi opłacenia. Email historii
              pozostaje wyłączony; moduły sklepu mogą reagować na zmianę.
            </p>
            <div className="ps-status-mappings">
              {['paid', 'picking', 'packed', 'shipped', 'delivered', 'completed', 'cancelled'].map(
                (k) => (
                  <label key={k}>
                    {statusNames[k]} — ID statusu sklepu
                    <input
                      name={'state_' + k}
                      aria-label={'PrestaShop ' + statusNames[k]}
                      defaultValue={data.mappings[k] ?? ''}
                      required
                      inputMode="numeric"
                      pattern="[1-9][0-9]{0,9}"
                      disabled={busy || readOnly}
                    />
                  </label>
                ),
              )}
            </div>
          </>
        )}
        <label className="checkbox-row">
          <input disabled={busy || readOnly} name="enabled" type="checkbox" defaultChecked={data.config?.enabled ?? false} />
          Synchronizuj statusy automatycznie
        </label>
        {!simulation && (
          <label className="checkbox-row">
            <input disabled={busy || readOnly} name="confirm" type="checkbox" />
            Zatwierdzam automatyczny zapis do tego konta. Kanał może wysyłać powiadomienia
            kupującym, również dla połączenia sandbox.
          </label>
        )}
        <button className="button primary" disabled={busy || readOnly}>
          Zapisz synchronizację statusów
        </button>
      </form>
      {error && (
        <p className="error-inline" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {data.config?.error && <p className="error-inline">{data.config.error}</p>}
      <table>
        <thead>
          <tr>
            <th>Etap DYNAMINDS</th>
            <th>Status kanału</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data.mappings).map(([local, remote]) => (
            <tr key={local}>
              <td>{statusNames[local]}</td>
              <td>{String(remote)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.jobs[0] && (
        <p>
          Ostatni przegląd: {data.jobs[0].state} · sprawdzono {data.jobs[0].stats?.checked ?? 0},
          zlecono {data.jobs[0].stats?.queued ?? 0}, pominięto {data.jobs[0].stats?.skipped ?? 0},
          błędy {data.jobs[0].stats?.errors ?? 0}. {data.jobs[0].error}
        </p>
      )}
      <Plans
        readOnly={readOnly}
        data={data.data.filter((p: any) => p.state !== 'preview')}
        action={action}
        busy={busy}
      />
    </div>
  );
}
