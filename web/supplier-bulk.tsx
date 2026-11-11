import { useEffect, useState } from 'react';
import { api, date } from './api';
const states: any = {
    queued: 'W toku',
    success: 'Zakończony',
    failed: 'Błąd',
    cancelled: 'Anulowany',
  },
  phases: any = {
    fetch: 'Pobieranie stron',
    parents: 'Składanie produktów',
    variants: 'Składanie wariantów',
    retire: 'Wycofywanie brakujących SKU',
  };
export function SupplierBulk({
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
  const [runs, setRuns] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState(''),
    [detail, setDetail] = useState<any>(null),
    [form, setForm] = useState(false),
    [pageSize, setPageSize] = useState(10000),
    [taxonomy, setTaxonomy] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setRuns([]);
    setCursor(null);
    setSelected('');
    setDetail(null);
    api('/supplier-bulk-runs?source_id=' + source.id + '&limit=25')
      .then((r) => {
        if (active) {
          setRuns(r.data);
          setCursor(r.meta.cursor);
          setSelected(r.data[0]?.id ?? '');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [source.id, refresh]);
  useEffect(() => {
    let active = true;
    setDetail(null);
    if (selected)
      api('/supplier-bulk-runs/' + selected + '?limit=25')
        .then((r) => active && setDetail(r))
        .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [selected, refresh]);
  const run = detail?.run;
  return (
    <div className="warehouse-detail">
      <div className="panel-heading">
        <div>
          <h3>Masowy katalog BigBuy</h3>
          <p>Produkty, opisy, zdjęcia, warianty i stany łączone po identyfikatorach.</p>
        </div>
        {admin && (
          <button
            className="button"
            disabled={busy || source.paused || runs.some((r) => r.state === 'queued')}
            onClick={() => {
              setForm(!form);
              setError('');
              setKey(crypto.randomUUID());
            }}
          >
            Pobierz cały katalog
          </button>
        )}
      </div>
      {error && (
        <div className="notice import-error" role="alert">
          {error}
        </div>
      )}
      {form && (
        <form
          className="warehouse-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api('/supplier-sources/' + source.id + '/bulk-runs', 'POST', {
                client_key: key,
                page_size: pageSize,
                ...(taxonomy ? { taxonomy } : {}),
              });
              setForm(false);
              reload();
              notify('Masowy odczyt uruchomiony. Odśwież katalog, aby sprawdzić postęp.');
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="notice">
            Odczyt może trwać długo przez limity hurtowni. Postęp jest zapisywany, a pobieranie
            można kontynuować po przerwaniu. Nie zmienia cen sprzedaży ani fizycznych stanów
            magazynowych. Przed zakupem starszych danych odśwież wybraną pozycję.
          </div>
          <label>
            Rozmiar strony BigBuy
            <input
              required
              type="number"
              min="1"
              max="10000"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setKey(crypto.randomUUID());
              }}
            />
          </label>
          <label>
            ID taksonomii (opcjonalnie)
            <input
              pattern="[1-9][0-9]{0,15}"
              value={taxonomy}
              onChange={(e) => {
                setTaxonomy(e.target.value);
                setKey(crypto.randomUUID());
              }}
            />
          </label>
          <footer>
            <button type="button" className="button" disabled={busy} onClick={() => setForm(false)}>
              Wróć
            </button>
            <button className="button primary" disabled={busy}>
              Rozpocznij masowy odczyt
            </button>
          </footer>
        </form>
      )}
      {!!runs.length && (
        <>
          <label>
            Masowy odczyt
            <select
              aria-label="Masowy odczyt"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {date(r.created_at)} · {states[r.state]} · {r.published} SKU
                </option>
              ))}
            </select>
          </label>
          {cursor && (
            <button
              className="button"
              onClick={async () => {
                try {
                  const r = await api(
                    '/supplier-bulk-runs?source_id=' + source.id + '&limit=25&after=' + cursor,
                  );
                  setRuns((v) => [...v, ...r.data]);
                  setCursor(r.meta.cursor);
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              Starsze masowe odczyty
            </button>
          )}
          {run && (
            <details open>
              <summary>
                {states[run.state]} ·{' '}
                {run.state === 'success'
                  ? run.rejected
                    ? 'Z pominiętymi pozycjami'
                    : 'Wszystkie zbiory przetworzone'
                  : phases[run.phase]}{' '}
                · {run.published} SKU
              </summary>
              <p>
                Pobrano {Number(run.fetched_rows)} rekordów. Udostępniono {run.published} SKU;
                odrzucono {run.rejected}, zachowano {run.skipped_newer} nowszych odczytów, wycofano{' '}
                {run.withdrawn} brakujących pozycji.
              </p>
              {run.state === 'queued' && (
                <p>
                  Kolejna próba: {date(run.next_attempt_at)}. Zakupy pozycji tego odczytu będą
                  dostępne po zakończeniu.
                </p>
              )}
              {run.error && <div className="notice import-error">{run.error}</div>}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Zbiór API</th>
                      <th>Strony</th>
                      <th>Rekordy</th>
                      <th>Stan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(run.cursors).map(([resource, c]: any) => (
                      <tr key={resource}>
                        <td>{resource}</td>
                        <td>{c.page}</td>
                        <td>{c.rows}</td>
                        <td>{c.done ? 'Kompletny' : 'W toku'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.data.map((i: any) => (
                <div className="notice import-error" key={i.id}>
                  Produkt {i.remote_product_id}
                  {i.remote_variant_id ? ' / wariant ' + i.remote_variant_id : ''}: {i.error}
                </div>
              ))}
              {detail.meta.cursor && (
                <button
                  className="button"
                  onClick={async () => {
                    try {
                      const next = await api(
                        '/supplier-bulk-runs/' + selected + '?limit=25&after=' + detail.meta.cursor,
                      );
                      setDetail((d: any) => ({ ...next, data: [...d.data, ...next.data] }));
                    } catch (e: any) {
                      setError(e.message);
                    }
                  }}
                >
                  Kolejne błędy pozycji
                </button>
              )}
              {admin && run.state === 'queued' && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api('/supplier-bulk-runs/' + run.id + '/cancel', 'POST', {
                        version: run.version,
                      });
                      reload();
                      notify('Masowy odczyt anulowany.');
                    } catch (e: any) {
                      setError(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Anuluj masowy odczyt
                </button>
              )}
            </details>
          )}
        </>
      )}
    </div>
  );
}
