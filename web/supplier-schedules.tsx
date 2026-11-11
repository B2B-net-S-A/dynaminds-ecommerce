import { useEffect, useState } from 'react';
import { api, date } from './api';
export function SupplierSchedule({
  source,
  admin,
  refresh,
  reload,
  notify,
}: {
  source: any;
  admin: boolean;
  refresh: number;
  reload: () => void;
  notify: (s: string) => void;
}) {
  const [cfg, setCfg] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [enabled, setEnabled] = useState(false),
    [minutes, setMinutes] = useState(360),
    [pageSize, setPageSize] = useState(10000),
    [taxonomy, setTaxonomy] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api('/supplier-sources/' + source.id + '/schedule')
      .then((r) => {
        if (!active) return;
        setCfg(r.schedule);
        setEnabled(!!r.schedule?.enabled);
        setMinutes(r.schedule?.interval_minutes ?? 360);
        setPageSize(r.schedule?.page_size ?? 10000);
        setTaxonomy(r.schedule?.taxonomy ?? '');
        setKey(crypto.randomUUID());
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [source.id, refresh]);
  const submit = async (fn: () => Promise<any>, message: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      reload();
      notify(message);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="warehouse-detail">
      <summary>
        Automatyczne odświeżanie hurtowni ·{' '}
        {loading ? 'Wczytywanie' : cfg?.enabled ? 'Włączone' : 'Wyłączone'}
      </summary>
      {error && (
        <div className="notice import-error" role="alert">
          {error}
        </div>
      )}
      {!loading && (
        <>
          <p>
            Cały katalog, ceny i dostępność hurtowni. Kolejne pobieranie rozpocznie się po
            zakończeniu poprzedniego i ustawionej przerwie. Odczyt nie zmienia własnych cen
            sprzedaży ani stanu magazynu.
          </p>
          {cfg?.next_at && cfg.enabled && (
            <p>
              {cfg.last_state === 'queued'
                ? 'Następny odczyt zostanie zaplanowany po zakończeniu bieżącego pobierania.'
                : 'Następny odczyt: ' + date(cfg.next_at) + '.'}
            </p>
          )}
          {cfg?.last_finished_at && <p>Ostatnie zakończenie: {date(cfg.last_finished_at)}.</p>}
          {cfg?.last_state && (
            <p>
              Ostatni przebieg:{' '}
              {
                (
                  {
                    queued: 'W toku',
                    success: 'Zakończony',
                    failed: 'Błąd',
                    cancelled: 'Anulowany',
                  } as any
                )[cfg.last_state]
              }{' '}
              · {cfg.last_published ?? 0} SKU · odrzucono {cfg.last_rejected ?? 0}.
            </p>
          )}
          {(cfg?.error || cfg?.last_error) && (
            <div className="notice import-error" role="alert">
              {cfg.error ?? cfg.last_error}
            </div>
          )}
          {admin && (
            <form
              className="warehouse-form"
              onSubmit={(e) => {
                e.preventDefault();
                submit(
                  () =>
                    api('/supplier-sources/' + source.id + '/schedule', 'PUT', {
                      version: cfg?.version ?? 0,
                      enabled,
                      interval_minutes: minutes,
                      page_size: pageSize,
                      taxonomy: taxonomy || null,
                    }),
                  'Harmonogram zapisany.',
                );
              }}
            >
              <label className="warehouse-check">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy || source.paused}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                Automatycznie pobieraj katalog BigBuy
              </label>
              <label>
                Przerwa po zakończeniu (minuty)
                <input
                  type="number"
                  required
                  min={30}
                  max={10080}
                  disabled={busy}
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </label>
              <label>
                Rozmiar strony harmonogramu
                <input
                  type="number"
                  required
                  min={1}
                  max={10000}
                  disabled={busy}
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                />
              </label>
              <label>
                Taksonomia harmonogramu (opcjonalnie)
                <input
                  value={taxonomy}
                  disabled={busy}
                  pattern="[1-9][0-9]*"
                  onChange={(e) => setTaxonomy(e.target.value)}
                />
              </label>
              <div className="notice">
                Zmiana lub wyłączenie harmonogramu anuluje jego trwający odczyt. Wstrzymanie źródła
                wyłącza harmonogram. Po zmianie klucza API zapisz ustawienia ponownie. Limity BigBuy
                mogą wydłużyć pobieranie; przed zakupem odśwież starszą pozycję.
              </div>
              <div className="form-actions">
                <button className="button primary" disabled={busy}>
                  Zapisz harmonogram
                </button>
                {cfg?.enabled && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy || source.paused || cfg.last_state === 'queued'}
                    onClick={() =>
                      submit(
                        () =>
                          api('/supplier-sources/' + source.id + '/schedule/run', 'POST', {
                            version: cfg.version,
                            client_key: key,
                          }),
                        'Odczyt harmonogramu uruchomiony. Odśwież katalog, aby sprawdzić postęp.',
                      )
                    }
                  >
                    Uruchom harmonogram teraz
                  </button>
                )}
              </div>
            </form>
          )}
        </>
      )}
    </details>
  );
}
