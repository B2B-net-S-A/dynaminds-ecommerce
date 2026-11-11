import { useEffect, useState, type FormEvent } from 'react';
import { api, date, statusNames } from './api';
import { shipmentStatusLabel } from '../server/shipment-status-labels';
export const trackingName = shipmentStatusLabel;
export function TrackingPanel({ channelId }: { channelId: string }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(''),
    [after, setAfter] = useState<string | null>(null),
    [notice, setNotice] = useState('');
  const [version, setVersion] = useState(0),
    [enabled, setEnabled] = useState(false),
    [mark, setMark] = useState(false),
    [interval, setIntervalValue] = useState(3600),
    [confirm, setConfirm] = useState(false);
  const [infoLogin, setInfoLogin] = useState(''),
    [infoPassword, setInfoPassword] = useState(''),
    [infoChannel, setInfoChannel] = useState('');
  async function load(configure = false) {
    const d = await api(
      '/integrations/' +
        channelId +
        '/tracking?' +
        new URLSearchParams({ search, ...(after ? { after } : {}) }),
    );
    setData(d);
    if (configure) {
      setVersion(d.config?.version ?? 0);
      setEnabled(d.config?.enabled ?? false);
      setMark(d.config?.mark_delivered ?? false);
      setIntervalValue(d.config?.interval_seconds ?? 3600);
      setConfirm(false);
    }
  }
  useEffect(() => {
    let active = true;
    load(true).catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [channelId]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const t = setInterval(() => load().catch((e) => setError(e.message)), 3000);
    return () => clearInterval(t);
  }, [channelId, search, after]);
  async function run(path: string, method: string, body: any = {}, configure = false) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await api(path, method, body);
      await load(configure);
      setNotice(
        r.queued !== undefined
          ? `Zlecono odczyt ${r.queued} paczek (maksymalnie ${r.batch_limit} w partii).`
          : 'Zapisano.',
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    await run(
      '/integrations/' + channelId + '/tracking',
      'PATCH',
      {
        version,
        enabled,
        mark_delivered: mark,
        interval_seconds: interval,
        confirm_external: confirm,
      },
      true,
    );
  }
  if (!data) return <p role="status">Wczytywanie trackingu…{error}</p>;
  const sim = data.channel.settings.simulation === true;
  const dpd = data.channel.provider === 'dpd';
  const provider = ({ dpd: 'DPD', dhl: 'DHL', pocztapolska: 'Poczta Polska' } as Record<string, string>)[data.channel.provider] ?? 'InPost';
  return (
    <section className="tracking-panel">
      <div className="panel-heading">
        <div>
          <h3>{data.channel.name}</h3>
          <p>Automatyczny tracking przekazanych paczek</p>
        </div>
        <span className="badge">{data.config?.enabled ? 'Włączony' : 'Wyłączony'}</span>
      </div>
      {sim ? (
        <p className="notice">
          PRZYKŁAD LOKALNY — harmonogram odczytuje symulator. Przyciski symulacji zmieniają jego
          odpowiedź, bez połączenia z {provider}.
        </p>
      ) : (
        <p className="notice">
          {dpd
            ? 'Odczyt historii z DPD InfoServices (SOAP) wymaga osobnego konta i uprawnień DPD. Tracking działa w trybie live; DEMO DPDServices nie zapewnia tego API.'
            : 'Odczyty numerów przesyłek z InPost. Tracking działa w środowisku live; sandbox ShipX nie zwraca statusów.'}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {data.config?.error && <p className="notice error">{data.config.error}</p>}
      {notice && <p role="status">{notice}</p>}
      {dpd && !sim && (
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api('/integrations/' + channelId + '/tracking-credentials', 'PATCH', {
                info_login: infoLogin,
                info_password: infoPassword,
                info_channel: infoChannel,
              });
              setInfoLogin('');
              setInfoPassword('');
              setInfoChannel('');
              await load(true);
              setNotice('Zapisano dane DPD InfoServices. Zatwierdź harmonogram.');
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            {data.channel.info_configured
              ? 'Dane DPD InfoServices zapisane.'
              : 'Skonfiguruj DPD InfoServices.'}
          </p>
          <label>
            Login DPD InfoServices
            <input
              required
              maxLength={500}
              autoComplete="off"
              value={infoLogin}
              onChange={(e) => setInfoLogin(e.target.value)}
            />
          </label>
          <label>
            Hasło DPD InfoServices
            <input
              required
              type="password"
              maxLength={500}
              autoComplete="new-password"
              value={infoPassword}
              onChange={(e) => setInfoPassword(e.target.value)}
            />
          </label>
          <label>
            Kanał DPD InfoServices (opcjonalny)
            <input
              maxLength={500}
              value={infoChannel}
              onChange={(e) => setInfoChannel(e.target.value)}
            />
          </label>
          <button className="button" disabled={busy}>
            Zapisz dane DPD InfoServices
          </button>
        </form>
      )}
      <form className="form-grid" onSubmit={save}>
        <label className="shipping-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Odczytuj tracking automatycznie
        </label>
        <label>
          Odstęp odczytów (sekundy)
          <input
            type="number"
            min={60}
            max={86400}
            required
            value={interval}
            onChange={(e) => setIntervalValue(Number(e.target.value))}
          />
        </label>
        <label className="shipping-check">
          <input type="checkbox" checked={mark} onChange={(e) => setMark(e.target.checked)} />
          Oznaczaj nadane zamówienia jako doręczone
        </label>
        {!sim && (
          <label className="shipping-check">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            Potwierdzam cykliczny odczyt numerów przesyłek z {provider}
          </label>
        )}
        <button className="button primary" disabled={busy || (!sim && enabled && !confirm)}>
          Zapisz harmonogram trackingu
        </button>
      </form>
      <p className="muted">
        Status „Doręczona” może zmienić tylko zamówienie „Nadane”. Zwroty i zakończone zamówienia
        zachowują swój etap. Tracking nie potwierdza rozliczenia pobrania.
      </p>
      <p className="muted">
        Odczyty kończą się po doręczeniu, zwrocie do nadawcy, anulowaniu lub po 45 dniach od
        utworzenia paczki. Pauza zatrzymuje nowe odczyty i zapis wyników rozpoczętych zadań.
      </p>
      <div className="shipping-actions">
        <button
          className="button"
          disabled={busy || !data.config?.enabled}
          onClick={() => run('/integrations/' + channelId + '/tracking', 'POST')}
        >
          Sprawdź przekazane paczki teraz
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => load(true).catch((e) => setError(e.message))}
        >
          Odśwież tracking
        </button>
      </div>
      <p>
        <strong>Przesyłki: {data.stats.total}</strong> · {data.stats.active} do monitorowania ·{' '}
        {data.stats.terminal} zakończonych · {data.stats.errors} z błędem
      </p>
      <label>
        Szukaj zamówienia lub paczki
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setAfter(null);
          }}
        />
      </label>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Zamówienie / paczka</th>
              <th>Status przewoźnika</th>
              <th>Odczyt</th>
              <th>Wynik</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((s: any) => {
              const terminal = ['delivered', 'returned_to_sender', 'canceled'].includes(
                s.tracking_data?.status,
              );
              return (
                <tr key={s.id}>
                  <td>
                    <strong>{s.order_number}</strong>
                    <div className="muted">{s.tracking_number}</div>
                    {s.tracking_data?.current_waybill &&
                      s.tracking_data.current_waybill !== s.tracking_number && (
                        <small>Aktualny numer: {s.tracking_data.current_waybill}</small>
                      )}
                    <small>Zamówienie: {statusNames[s.order_status] ?? s.order_status}</small>
                  </td>
                  <td>
                    {trackingName(s.tracking_data?.status ?? s.status)}
                    <div className="muted">
                      {s.tracking_data?.scope === 'local_simulation'
                        ? 'Symulacja lokalna'
                        : s.tracking_at
                          ? 'Odczyt API'
                          : 'Nie odczytano'}
                    </div>
                  </td>
                  <td>
                    {s.tracking_at ? date(s.tracking_at) : '—'}
                    <div className="muted">
                      {!s.dispatched_at
                        ? 'Paczka nieprzekazana'
                        : terminal
                          ? 'Odczyty zakończone'
                          : s.expired
                            ? 'Okno 45 dni minęło'
                            : data.config?.enabled && s.tracking_next_at
                              ? 'Następny: ' + date(s.tracking_next_at)
                              : 'Harmonogram wyłączony'}
                    </div>
                  </td>
                  <td>
                    {s.tracking_error || s.job_error ? (
                      <span className="notice error">{s.tracking_error ?? s.job_error}</span>
                    ) : ['pending', 'running'].includes(s.job_state) ? (
                      'Odczyt w kolejce'
                    ) : s.tracking_at ? (
                      s.tracking_data?.empty_history ? (
                        'Brak zdarzeń w API'
                      ) : (
                        'Potwierdzony'
                      )
                    ) : (
                      'Oczekuje'
                    )}
                    {sim && data.config?.enabled && s.dispatched_at && !terminal && !s.expired && (
                      <div className="shipping-actions">
                        <button
                          className="button small-btn"
                          disabled={busy}
                          onClick={() =>
                            run('/shipments/' + s.id + '/tracking-example', 'POST', {
                              status: 'out_for_delivery',
                            })
                          }
                        >
                          Symuluj trasę
                        </button>
                        <button
                          className="button small-btn"
                          disabled={busy}
                          onClick={() =>
                            run('/shipments/' + s.id + '/tracking-example', 'POST', {
                              status: 'delivered',
                            })
                          }
                        >
                          Symuluj doręczenie
                        </button>
                        {dpd && (
                          <button
                            className="button small-btn"
                            disabled={busy}
                            onClick={() =>
                              run('/shipments/' + s.id + '/tracking-example', 'POST', {
                                status: 'returned_to_sender',
                              })
                            }
                          >
                            Symuluj zwrot do nadawcy
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!data.data.length && <p>Brak paczek dla wybranego filtra.</p>}
      <div className="shipping-actions">
        <button className="button" disabled={!after} onClick={() => setAfter(null)}>
          Pierwsza strona
        </button>
        <button
          className="button"
          disabled={!data.meta.cursor}
          onClick={() => setAfter(data.meta.cursor)}
        >
          Następne paczki
        </button>
      </div>
    </section>
  );
}
