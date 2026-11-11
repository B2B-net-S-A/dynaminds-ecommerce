import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, date } from './api';
import { StocktakeScans } from './stocktake-scans';
import { StocktakeAdjustmentsPanel, stocktakeAdjustmentsLocked, subscribeStocktakeAdjustmentsLock } from './stocktake-adjustments';
const states: Record<string, string> = {
  counting: 'Liczenie',
  review: 'Przegląd różnic',
  posted: 'Rozliczony',
  cancelled: 'Anulowany',
};
export function Stocktakes({
  admin,
  write,
  refresh,
  reload,
  onOpenWms,
  contextKey = 'quantity-stocktakes',
  readOnly = false,
  onBlindCountingChange,
  externalWriteBlocked = false,
  adjustmentsAvailable = false,
  adjustmentsContextKey = '',
  focusStocktakeId,
  focusToken,
  onNavigationLockedChange,
}: {
  admin: boolean;
  write: boolean;
  refresh: number;
  reload: () => void;
  onOpenWms?: () => void;
  contextKey?: string;
  readOnly?: boolean;
  onBlindCountingChange?: (active: boolean) => void;
  externalWriteBlocked?: boolean;
  adjustmentsAvailable?: boolean;
  adjustmentsContextKey?: string;
  focusStocktakeId?: string;
  focusToken?: number;
  onNavigationLockedChange?: (locked: boolean) => void;
}) {
  const [rows, setRows] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [selected, setSelected] = useState(''),
    [detail, setDetail] = useState<any>(null),
    [after, setAfter] = useState(''),
    [search, setSearch] = useState(''),
    [creating, setCreating] = useState(false),
    [form, setForm] = useState<any>({
      name: '',
      warehouse_id: '',
      location_prefix: '',
      blind: true,
      client_key: crypto.randomUUID(),
    }),
    [values, setValues] = useState<Record<string, string>>({}),
    [countKey, setCountKey] = useState(crypto.randomUUID()),
    [note, setNote] = useState('Pomiar spisu magazynowego'),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [lotsEnabled, setLotsEnabled] = useState(false),
    [history, setHistory] = useState<any>(null);
  const [scanLocked, setScanLocked] = useState(false),
    [scanStale, setScanStale] = useState(false);
  const [scanDenied, setScanDenied] = useState(false);
  const [adjustmentsLocked, setAdjustmentsLocked] = useState(() => stocktakeAdjustmentsLocked(adjustmentsContextKey));
  const appliedFocus = useRef('');
  useEffect(() => subscribeStocktakeAdjustmentsLock(adjustmentsContextKey, setAdjustmentsLocked), [adjustmentsContextKey]);
  useEffect(() => {
    // Immutable register navigation reads an existing source. It never releases
    // a retained adjustment attempt or changes measured quantities.
    const focus = `${focusToken ?? 0}:${focusStocktakeId ?? ''}`;
    if (!focusStocktakeId || !/^[a-f0-9-]{36}$/.test(focusStocktakeId) || appliedFocus.current === focus ||
      busy || scanLocked || scanDenied || Object.keys(values).length > 0 ||
      (creating && (form.name || form.location_prefix))) return;
    appliedFocus.current = focus;
    setSelected(focusStocktakeId);
    setAfter('');
    setSearch('');
    setCreating(false);
    setHistory(null);
  }, [focusStocktakeId, focusToken, busy, scanLocked, scanDenied, values, creating, form.name, form.location_prefix]);
  const locked = busy || scanLocked || scanDenied;
  const navigationLocked = locked || Object.keys(values).length > 0 || Boolean(creating && (form.name || form.location_prefix));
  useLayoutEffect(() => {
    onNavigationLockedChange?.(navigationLocked);
    return () => onNavigationLockedChange?.(false);
  }, [navigationLocked, onNavigationLockedChange]);
  const writeLocked = locked || readOnly || externalWriteBlocked || adjustmentsLocked;
  const blindCounting = Boolean(
    !admin &&
    selected &&
    detail?.id === selected &&
    detail.blind &&
    ['counting', 'review'].includes(detail.state),
  );
  useLayoutEffect(() => {
    onBlindCountingChange?.(blindCounting);
    return () => onBlindCountingChange?.(false);
  }, [blindCounting, onBlindCountingChange]);
  useEffect(() => {
    let live = true;
    Promise.all([api('/stocktakes'), api('/warehouses'), api('/wms-lots')])
      .then(([d, w, lots]) => {
        if (live) {
          setRows(d.data);
          setCursor(d.meta.cursor);
          setWarehouses(w.data);
          setLotsEnabled(Boolean(lots.policy?.enabled));
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refresh]);
  async function load() {
    if (!selected) return;
    const d = await api(
      '/stocktakes/' +
        selected +
        '?' +
        new URLSearchParams({ ...(after ? { after } : {}), ...(search ? { q: search } : {}) }),
    );
    setDetail(d);
    setScanStale(false);
    setValues({});
    setConfirm(false);
    setCountKey(crypto.randomUUID());
  }
  useEffect(() => {
    let live = true;
    if (!selected) {
      setDetail(null);
      return;
    }
    api(
      '/stocktakes/' +
        selected +
        '?' +
        new URLSearchParams({ ...(after ? { after } : {}), ...(search ? { q: search } : {}) }),
    )
      .then((d) => {
        if (live) {
          setDetail(d);
          setScanStale(false);
          setValues({});
          setConfirm(false);
          setError('');
          setCountKey(crypto.randomUUID());
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [selected, after, search, refresh]);
  async function perform(fn: () => Promise<void>, mutating = false) {
    if (scanLocked || scanDenied || (mutating && stocktakeAdjustmentsLocked(adjustmentsContextKey))) {
      setError('Najpierw zakończ tryb skanowania i rozstrzygnij ewentualną niepotwierdzoną próbę.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function transition(action: string) {
    if (writeLocked || scanStale || (action === 'post' && adjustmentsAvailable)) {
      setError('Odczytaj aktualny spis po skanowaniu przed zmianą jego stanu.');
      return;
    }
    await perform(async () => {
      await api('/stocktakes/' + selected + '/' + action, 'POST', {
        version: detail.version,
        ...(action === 'post' ? { confirmed: true } : {}),
      });
      await load();
      reload();
    }, true);
  }
  return (
    <section className="panel stocktakes-panel">
      <div className="panel-heading">
        <div>
          <h2>Spisy inwentaryzacyjne</h2>
          <p>Liczenie lokalizacji → przegląd różnic → wspólne rozliczenie.</p>
        </div>
        {admin && !lotsEnabled && (
          <button
            className="button primary"
            disabled={writeLocked}
            onClick={() => {
              if (writeLocked) return;
              setCreating(true);
              setForm({
                name: '',
                warehouse_id: warehouses[0]?.id ?? '',
                location_prefix: '',
                blind: true,
                client_key: crypto.randomUUID(),
              });
            }}
          >
            Nowy spis
          </button>
        )}
      </div>
      {lotsEnabled && (
        <p className="notice">
          Magazyn śledzi partie. Nowy spis utwórz w inwentaryzacjach partii.
          {onOpenWms && (
            <button className="button" onClick={onOpenWms}>
              Otwórz inwentaryzacje partii
            </button>
          )}
        </p>
      )}
      {error && (
        <p className="notice import-error" role="alert">
          {error}
        </p>
      )}
      {externalWriteBlocked && (
        <p className="notice">
          Nowe pomiary i rozliczenia są zablokowane do czasu rozstrzygnięcia importu stanów.
          Historię można nadal odczytywać.
        </p>
      )}
      {creating && !lotsEnabled && (
        <form
          className="stocktake-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (writeLocked) return;
            perform(async () => {
              const d = await api('/stocktakes', 'POST', form);
              setCreating(false);
              setSelected(d.id);
              setAfter('');
              setSearch('');
              reload();
            }, true);
          }}
        >
          <label>
            Nazwa spisu
            <input
              aria-label="Nazwa spisu"
              required
              minLength={3}
              maxLength={100}
              value={form.name}
              disabled={writeLocked}
              onChange={(e) =>
                setForm({ ...form, name: e.target.value, client_key: crypto.randomUUID() })
              }
            />
          </label>
          <label>
            Magazyn
            <select
              aria-label="Magazyn spisu"
              value={form.warehouse_id}
              disabled={writeLocked}
              onChange={(e) =>
                setForm({ ...form, warehouse_id: e.target.value, client_key: crypto.randomUUID() })
              }
            >
              {warehouses.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Początek lokalizacji
            <input
              aria-label="Początek lokalizacji spisu"
              maxLength={80}
              placeholder="Puste = wszystkie obecne lokalizacje"
              value={form.location_prefix}
              disabled={writeLocked}
              onChange={(e) =>
                setForm({
                  ...form,
                  location_prefix: e.target.value,
                  client_key: crypto.randomUUID(),
                })
              }
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={form.blind}
              disabled={writeLocked}
              onChange={(e) =>
                setForm({ ...form, blind: e.target.checked, client_key: crypto.randomUUID() })
              }
            />
            Ukryj oczekiwane ilości osobom liczącym
          </label>
          <p className="muted">
            Zakres zostanie zapisany przy utworzeniu. Do 2000 pozycji na arkusz; dla większego
            magazynu podziel spis według lokalizacji. Licz wszystkie sztuki, także zarezerwowane.
          </p>
          <div className="ops-buttons">
            <button className="button primary" disabled={writeLocked}>
              Utwórz arkusz spisu
            </button>
            <button
              type="button"
              className="button"
              disabled={locked}
              onClick={() => setCreating(false)}
            >
              Zamknij formularz
            </button>
          </div>
        </form>
      )}
      {detail ? (
        <div className="stocktake-detail">
          <button
            className="button subtle"
            disabled={locked}
            onClick={() => {
              setSelected('');
              setDetail(null);
              setAfter('');
              setHistory(null);
              setSearch('');
            }}
          >
            Lista spisów
          </button>
          <div className="panel-heading">
            <div>
              <h3>{detail.name}</h3>
              <p>
                {detail.warehouse_name} · {states[detail.state]} · wersja {detail.version}
              </p>
            </div>
            <button className="button" disabled={locked} onClick={() => perform(load)}>
              Odśwież spis
            </button>
          </div>
          <StocktakeScans
            engine="quantity"
            stocktakeId={selected}
            contextKey={contextKey}
            readOnly={readOnly}
            refresh={refresh}
            disabled={
              busy ||
              scanDenied ||
              Object.values(values).some((v) => v !== '') ||
              ((externalWriteBlocked || adjustmentsLocked) && !scanLocked)
            }
            onPendingChange={setScanLocked}
            onAccessDenied={() => {
              setScanDenied(true);
              setSelected('');
              setDetail(null);
              setRows([]);
              setWarehouses([]);
              setValues({});
              setNote('');
              setConfirm(false);
              setForm({
                name: '',
                warehouse_id: '',
                location_prefix: '',
                blind: true,
                client_key: crypto.randomUUID(),
              });
              setHistory(null);
              setCreating(false);
              setError(
                'Dostęp do spisu został cofnięty. Ponownie otwórz panel po odświeżeniu uprawnień.',
              );
            }}
            onChanged={() => {
              setScanStale(true);
              setConfirm(false);
            }}
          />
          {scanStale && (
            <p className="notice">
              Zapisano pomiar skanera. Wyłącz skanowanie i odśwież spis przed przeglądem albo
              ręcznym pomiarem.
            </p>
          )}
          <div className="stocktake-summary">
            <strong>
              Policzono {detail.summary.counted} / {detail.summary.total}
            </strong>
            {detail.summary.changed !== undefined && (
              <span>
                Różnice: {detail.summary.changed} · bilans {detail.summary.delta > 0 ? '+' : ''}
                {detail.summary.delta}
              </span>
            )}
            <span>Zmiana stanu po pomiarze: {detail.summary.conflicts}</span>
            {detail.summary.below_reserved !== undefined && (
              <span>Poniżej rezerwacji: {detail.summary.below_reserved}</span>
            )}
          </div>
          <p className="muted">
            Pomiar nie zmienia stanów. Ruch towaru lub rezerwacji wymaga ponownego liczenia
            zmienionego SKU. Rozliczenie zachowuje rezerwacje; wynik poniżej rezerwacji trzeba
            najpierw wyjaśnić.
          </p>
          <label>
            Szukaj pozycji
            <input
              aria-label="Szukaj pozycji spisu"
              disabled={locked}
              value={search}
              maxLength={80}
              onChange={(e) => {
                setSearch(e.target.value);
                setAfter('');
              }}
              placeholder="Początek SKU lub lokalizacji"
            />
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (writeLocked || scanStale) return;
              perform(async () => {
                const lines = detail.lines
                  .filter((l: any) => values[l.id] !== undefined && values[l.id] !== '')
                  .map((l: any) => ({
                    id: l.id,
                    version: l.version,
                    expected_stock_version: l.current_stock_version,
                    quantity: Number(values[l.id]),
                  }));
                await api('/stocktakes/' + selected + '/counts', 'POST', {
                  client_key: countKey,
                  note,
                  lines,
                });
                await load();
                reload();
              }, true);
            }}
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU / produkt</th>
                    <th>Miejsce</th>
                    <th>Baza pomiaru</th>
                    <th>Zmierzono</th>
                    <th>Różnica / kontrola</th>
                    {write && !lotsEnabled && detail.state === 'counting' && <th>Nowy pomiar</th>}
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((l: any) => (
                    <tr key={l.id}>
                      <td>
                        <strong>{l.sku}</strong>
                        <small>{l.name}</small>
                      </td>
                      <td>
                        <code>{l.location}</code>
                      </td>
                      <td>
                        {l.basis_quantity ?? 'Ukryta'}
                        {l.original_quantity !== undefined &&
                          l.original_quantity !== l.basis_quantity && (
                            <small>Przy otwarciu: {l.original_quantity}</small>
                          )}
                      </td>
                      <td>{l.counted ?? 'Nie policzono'}</td>
                      <td>
                        {l.difference ?? '—'}
                        {l.conflict && <small className="negative">Przelicz SKU ponownie</small>}
                        {l.counted !== null &&
                          ['counting', 'review'].includes(detail.state) &&
                          l.reserved !== undefined &&
                          l.counted < l.reserved && (
                            <small className="negative">Rezerwacje: {l.reserved}</small>
                          )}
                      </td>
                      {write && !lotsEnabled && detail.state === 'counting' && (
                        <td>
                          <input
                            aria-label={'Pomiar ' + l.sku + ' ' + l.location}
                            type="number"
                            min={0}
                            max={1000000}
                            step={1}
                            disabled={writeLocked || scanStale}
                            value={values[l.id] ?? ''}
                            onChange={(e) => {
                              setValues({ ...values, [l.id]: e.target.value });
                              setCountKey(crypto.randomUUID());
                            }}
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {write && !lotsEnabled && detail.state === 'counting' && (
              <div className="stocktake-count-controls">
                <label>
                  Notatka pomiaru
                  <input
                    aria-label="Notatka pomiaru spisu"
                    minLength={3}
                    maxLength={500}
                    value={note}
                    disabled={writeLocked || scanStale}
                    onChange={(e) => {
                      setNote(e.target.value);
                      setCountKey(crypto.randomUUID());
                    }}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={
                    writeLocked || scanStale || !Object.values(values).some((v) => v !== '')
                  }
                >
                  Zapisz pomiary z tej strony
                </button>
              </div>
            )}
          </form>
          <div className="ops-buttons">
            <button className="button" disabled={locked || !after} onClick={() => setAfter('')}>
              Pierwsza strona spisu
            </button>
            <button
              className="button"
              disabled={locked || !detail.meta.cursor}
              onClick={() => setAfter(detail.meta.cursor)}
            >
              Następne pozycje spisu
            </button>
            <button
              className="button"
              disabled={locked}
              onClick={() =>
                perform(async () =>
                  setHistory(await api('/stocktakes/' + selected + '/measurements')),
                )
              }
            >
              Historia pomiarów
            </button>
          </div>
          {admin && ['counting', 'review'].includes(detail.state) && (
            <div className="stocktake-review-controls">
              <div className="ops-buttons">
                {detail.state === 'counting' ? (
                  <button
                    className="button primary"
                    disabled={writeLocked || scanStale || lotsEnabled}
                    onClick={() => transition('review')}
                  >
                    Przekaż do przeglądu różnic
                  </button>
                ) : (
                  <button
                    className="button"
                    disabled={writeLocked || scanStale || lotsEnabled}
                    onClick={() => transition('reopen')}
                  >
                    Wróć do liczenia
                  </button>
                )}
                <button
                  className="button"
                  disabled={writeLocked || scanStale}
                  onClick={() => transition('cancel')}
                >
                  Anuluj spis
                </button>
              </div>
              {detail.state === 'review' && !lotsEnabled && !adjustmentsAvailable && (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={confirm}
                      disabled={writeLocked || scanStale}
                      onChange={(e) => setConfirm(e.target.checked)}
                    />
                    Potwierdzam policzone ilości i korekty stanów wszystkich pozycji spisu.
                  </label>
                  <button
                    className="button primary"
                    disabled={writeLocked || scanStale || !confirm}
                    onClick={() => transition('post')}
                  >
                    Rozlicz różnice spisu
                  </button>
                </>
              )}
            </div>
          )}
          {detail.posted_at && (
            <p className="notice">
              Spis rozliczony {date(detail.posted_at)}. Korekty i historia są zachowane; ponowne
              zatwierdzenie nie zmienia stanów.
            </p>
          )}
          {adjustmentsAvailable && adjustmentsContextKey && ['review', 'posted'].includes(detail.state) && !lotsEnabled && (
            <StocktakeAdjustmentsPanel contextKey={adjustmentsContextKey} readOnly={readOnly}
              sourceKind="quantity" stocktakeId={detail.id}
              externalWriteBlocked={externalWriteBlocked || locked || scanStale}
              onChanged={() => { void load(); reload(); }}/>
          )}
          {history && (
            <div className="stocktake-history">
              <h3>Historia pomiarów</h3>
              {history.data.map((m: any) => (
                <article key={m.id}>
                  <strong>
                    {m.actor_name} · {date(m.created_at)}
                  </strong>
                  <p>
                    {m.note} · {m.inputs.length} pozycji
                  </p>
                  <details>
                    <summary>Zobacz zapisane ilości</summary>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>SKU</th>
                            <th>Lokalizacja</th>
                            <th>Zmierzono</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.display_inputs.map((l: any) => (
                            <tr key={l.id}>
                              <td>{l.sku}</td>
                              <td>{l.location}</td>
                              <td>{l.quantity}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </article>
              ))}
              {history.meta.cursor && (
                <button
                  className="button"
                  onClick={() =>
                    perform(async () => {
                      const next = await api(
                        '/stocktakes/' + selected + '/measurements?after=' + history.meta.cursor,
                      );
                      setHistory({ data: [...history.data, ...next.data], meta: next.meta });
                    })
                  }
                >
                  Starsze pomiary
                </button>
              )}
              <button className="button" onClick={() => setHistory(null)}>
                Zamknij historię pomiarów
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Spis</th>
                  <th>Magazyn</th>
                  <th>Stan</th>
                  <th>Utworzono</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>{d.warehouse_name}</td>
                    <td>{states[d.state]}</td>
                    <td>{date(d.created_at)}</td>
                    <td>
                      <button
                        className="button"
                        disabled={locked}
                        onClick={() => {
                          setSelected(d.id);
                          setAfter('');
                          setSearch('');
                          setHistory(null);
                        }}
                      >
                        Otwórz spis
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <p className="muted">
              {lotsEnabled
                ? 'Brak starszych spisów. Nowy spis utwórz w inwentaryzacjach partii.'
                : 'Brak spisów. Utwórz arkusz dla wybranego magazynu.'}
            </p>
          )}
          {cursor && (
            <button
              className="button"
              disabled={locked}
              onClick={() =>
                perform(async () => {
                  const next = await api('/stocktakes?after=' + cursor);
                  setRows([...rows, ...next.data]);
                  setCursor(next.meta.cursor);
                })
              }
            >
              Starsze spisy
            </button>
          )}
        </>
      )}
    </section>
  );
}
