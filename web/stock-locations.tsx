import { useEffect, useRef, useState } from 'react';
import { api, date } from './api';
export function StockLocations({
  admin,
  write,
  refresh,
  reload,
  externalWriteBlocked = false,
  readOnly = false,
}: {
  admin: boolean;
  write: boolean;
  refresh: number;
  reload: () => void;
  externalWriteBlocked?: boolean;
  readOnly?: boolean;
}) {
  const [warehouses, setWarehouses] = useState<any[]>([]),
    [warehouse, setWarehouse] = useState(''),
    [q, setQ] = useState(''),
    [page, setPage] = useState<{ scope: string; rows: any[]; cursor: string | null } | null>(null),
    [selection, setSelection] = useState<{ scope: string; warehouse: string; row: any } | null>(null),
    [historyPage, setHistoryPage] = useState<{ key: string; rows: any[] } | null>(null),
    [readRevision, setReadRevision] = useState(0),
    [warehouseRevision, setWarehouseRevision] = useState(0),
    [warehouseFailure, setWarehouseFailure] = useState(''),
    [loadingScope, setLoadingScope] = useState<string | null>(null),
    [pagingScope, setPagingScope] = useState<string | null>(null),
    [historyLoading, setHistoryLoading] = useState<string | null>(null),
    [kind, setKind] = useState('move'),
    [destination, setDestination] = useState(''),
    [quantity, setQuantity] = useState(1),
    [note, setNote] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [saving, setSaving] = useState(false),
    [failure, setFailure] = useState<{
      scope: string; kind: 'list' | 'page' | 'history' | 'write'; message: string; key?: string;
    } | null>(null);
  const path =
    '/stock-locations?' + new URLSearchParams({ warehouse_id: warehouse, q, limit: '25' });
  const scope = JSON.stringify([path, refresh, readRevision]);
  const currentScope = useRef(scope), currentSelection = useRef(selection), mounted = useRef(true);
  const paging = useRef<{ scope: string; cursor: string } | null>(null), writing = useRef(false);
  const historyRequest = useRef<object | null>(null);
  const access = useRef({ admin, write, readOnly, externalWriteBlocked });
  currentScope.current = scope;
  currentSelection.current = selection;
  access.current = { admin, write, readOnly, externalWriteBlocked };
  const live = (requestedScope: string) => mounted.current && currentScope.current === requestedScope;
  const selected = selection?.scope === scope ? selection.row : null;
  const rows = page?.scope === scope ? page.rows : [];
  const cursor = page?.scope === scope ? page.cursor : null;
  const history = historyPage && selected && historyPage.key === selected.client_key ? historyPage.rows : [];
  const error = warehouseFailure || (failure?.scope === scope && (!failure.key || failure.key === selected?.client_key)
    ? failure.message : '');
  const loading = !!warehouse && (loadingScope === scope || page?.scope !== scope && !(error && failure?.kind === 'list'));
  const busy = saving || pagingScope === scope;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; currentSelection.current = null; paging.current = null; historyRequest.current = null; };
  }, []);
  useEffect(() => {
    let active = true;
    setWarehouseFailure('');
    api('/warehouses')
      .then((r) => {
        if (active) {
          setWarehouses(r.data);
          setWarehouse(r.data[0]?.id ?? '');
          setSelected(null);
        }
      })
      .catch((e) => active && mounted.current && setWarehouseFailure(e.message));
    return () => {
      active = false;
    };
  }, [warehouseRevision]);
  useEffect(() => {
    let active = true;
    setSelected(null);
    setFailure(null);
    paging.current = null;
    setPagingScope(null);
    setLoadingScope(warehouse ? scope : null);
    if (warehouse)
      api(path)
        .then((r) => {
          if (active && live(scope)) {
            setPage({ scope, rows: r.data, cursor: r.meta.cursor });
          }
        })
        .catch((e) => active && live(scope) && setFailure({ scope, kind: 'list', message: e.message }))
        .finally(() => active && live(scope) && setLoadingScope(null));
    return () => {
      active = false;
    };
  }, [scope]);
  function setSelected(next: typeof selection) {
    currentSelection.current = next;
    if (!next) historyRequest.current = null;
    setSelection(next);
  }
  async function readHistory(binding: NonNullable<typeof selection>) {
    const key = binding.row.client_key;
    if (!live(binding.scope) || currentSelection.current !== binding) return;
    const request = {};
    historyRequest.current = request;
    const current = () => live(binding.scope) && currentSelection.current === binding && historyRequest.current === request;
    setHistoryPage(null);
    setHistoryLoading(key);
    setFailure(null);
    try {
      const result = await api('/stock-location-movements?' + new URLSearchParams({
        warehouse_id: binding.warehouse, product_id: binding.row.product_id,
      }));
      if (current()) setHistoryPage({ key, rows: result.data });
    } catch (e: any) {
      if (current()) setFailure({ scope: binding.scope, key, kind: 'history', message: e.message });
    } finally {
      if (current()) setHistoryLoading(null);
    }
  }
  async function select(b: any) {
    if (!live(scope)) return;
    const binding = { scope, warehouse, row: { ...b, client_key: crypto.randomUUID() } };
    setSelected(binding);
    setQuantity(1);
    setDestination('');
    setNote('');
    setConfirmed(false);
    await readHistory(binding);
  }
  async function more() {
    if (!cursor || !live(scope) || busy || paging.current?.scope === scope) return;
    const request = { scope, cursor };
    paging.current = request;
    setPagingScope(scope);
    setFailure(null);
    try {
      const result = await api(path + '&after=' + encodeURIComponent(cursor));
      if (live(scope) && paging.current === request)
        setPage((previous) => previous?.scope === scope && previous.cursor === cursor
          ? { scope, rows: [...previous.rows, ...result.data], cursor: result.meta.cursor } : previous);
    } catch (e: any) {
      if (live(scope) && paging.current === request) setFailure({ scope, kind: 'page', message: e.message });
    } finally {
      if (paging.current === request) {
        paging.current = null;
        if (live(scope)) setPagingScope(null);
      }
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const binding = selection, permission = access.current;
    if (!binding || currentSelection.current !== binding || !live(binding.scope) ||
      binding.warehouse !== warehouse || permission.readOnly || permission.externalWriteBlocked ||
      busy || writing.current || !permission.write || kind === 'count' && !permission.admin) return;
    writing.current = true;
    setSaving(true);
    setFailure(null);
    try {
      await api(kind === 'move' ? '/stock-location-moves' : '/stock-location-counts', 'POST', {
        warehouse_id: binding.warehouse,
        product_id: binding.row.product_id,
        location: binding.row.location,
        expected_version: binding.row.version,
        client_key: binding.row.client_key,
        quantity,
        note,
        ...(kind === 'move' ? { destination } : {}),
      });
      if (live(binding.scope)) {
        if (currentSelection.current === binding) setSelected(null);
        reload();
      }
    } catch (e: any) {
      if (live(binding.scope) && currentSelection.current === binding)
        setFailure({ scope: binding.scope, key: binding.row.client_key, kind: 'write', message: e.message });
    } finally {
      writing.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section className="panel location-panel">
      <div className="panel-heading">
        <div>
          <h2>Stany w lokalizacjach</h2>
          <p>
            Każda lokalizacja ma własną ilość i rezerwacje. Przesunięcie zachowuje sumę magazynu.
          </p>
        </div>
      </div>
      <div className="shipping-body">
        {readOnly && (
          <p className="notice">Tryb tylko do odczytu. Operacje lokalizacji są wyłączone.</p>
        )}
        {externalWriteBlocked && (
          <p className="notice">
            Nowe operacje lokalizacji są zablokowane do czasu rozstrzygnięcia importu stanów. Odczyt
            lokalizacji i historii pozostaje dostępny.
          </p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {warehouseFailure && (
          <button className="button" onClick={() => setWarehouseRevision((n) => n + 1)}>Ponów odczyt magazynów</button>
        )}
        {error && failure?.kind === 'list' && (
          <button className="button" onClick={() => setReadRevision((n) => n + 1)}>Ponów odczyt lokalizacji</button>
        )}
        <div className="inline-actions">
          <label>
            Magazyn lokalizacji
            <select value={warehouse} onChange={(e) => { setSelected(null); paging.current = null; setWarehouse(e.target.value); }}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Początek SKU lub lokalizacji
            <input value={q} onChange={(e) => { setSelected(null); paging.current = null; setQ(e.target.value); }} placeholder="np. LAMP lub A-" />
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>SKU / produkt</th>
                <th>Lokalizacja</th>
                <th>Ilość</th>
                <th>Rezerwacje</th>
                <th>Dostępne</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.product_id + ':' + b.location}>
                  <td>
                    <strong>{b.sku}</strong>
                    <small>{b.name}</small>
                  </td>
                  <td>
                    <code>{b.location}</code>
                  </td>
                  <td>{b.quantity}</td>
                  <td>{b.reserved}</td>
                  <td>{b.available}</td>
                  <td>
                    <button
                      className="button"
                      onClick={() => select(b)}
                      aria-label={'Lokalizacja ' + b.sku + ' ' + b.location}
                    >
                      Szczegóły
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && <p className="muted" role="status">Wczytywanie lokalizacji…</p>}
        {!rows.length && !loading && !(error && failure?.kind === 'list') && <p className="muted">Brak lokalizacji dla wybranego filtra.</p>}
        {cursor && (
          <button
            className="button"
            disabled={busy || loading}
            onClick={more}
          >
            Więcej lokalizacji
          </button>
        )}
        {selected && (
          <div className="location-detail">
            <div className="panel-heading">
              <h3>
                {selected.sku} · {selected.location}
              </h3>
              <button className="button" onClick={() => setSelected(null)}>
                Zamknij lokalizację
              </button>
            </div>
            <p>
              Stan {selected.quantity} · zarezerwowane {selected.reserved} · dostępne{' '}
              {selected.available}
            </p>
            {write && (
              <form className="payment-form" onSubmit={save}>
                <label>
                  Operacja lokalizacji
                  <select
                    value={kind}
                    disabled={readOnly || externalWriteBlocked || busy}
                    onChange={(e) => {
                      setKind(e.target.value);
                      setConfirmed(false);
                      setQuantity(e.target.value === 'count' ? selected.quantity : 1);
                    }}
                  >
                    <option value="move">Przesunięcie wewnętrzne</option>
                    {admin && <option value="count">Pomiar lokalizacji</option>}
                  </select>
                </label>
                {kind === 'move' && (
                  <label>
                    Lokalizacja docelowa
                    <input
                      value={destination}
                      disabled={readOnly || externalWriteBlocked || busy}
                      onChange={(e) => setDestination(e.target.value)}
                      maxLength={80}
                      required
                    />
                  </label>
                )}
                <label>
                  {kind === 'count' ? 'Policzona ilość w lokalizacji' : 'Ilość do przesunięcia'}
                  <input
                    type="number"
                    value={quantity}
                    disabled={readOnly || externalWriteBlocked || busy}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                    min={kind === 'count' ? 0 : 1}
                    max={1000000}
                    required
                  />
                </label>
                <label>
                  Powód operacji
                  <input
                    value={note}
                    disabled={readOnly || externalWriteBlocked || busy}
                    onChange={(e) => setNote(e.target.value)}
                    minLength={3}
                    maxLength={500}
                    required
                  />
                </label>
                <p className="muted">
                  Zarezerwowany towar pozostaje w swoim miejscu. Zmiana stanu lub rezerwacji wymaga
                  ponownego odczytu; pomiar oznacza wszystkie sztuki w tym miejscu, także
                  zarezerwowane.
                </p>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={readOnly || externalWriteBlocked || busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    required
                  />
                  {kind === 'count'
                    ? 'Potwierdzam nowy fizyczny pomiar'
                    : 'Potwierdzam fizyczne przesunięcie'}
                </label>
                <button
                  className="button primary"
                  disabled={readOnly || externalWriteBlocked || busy || !confirmed}
                >
                  Zapisz operację lokalizacji
                </button>
              </form>
            )}
            <h3>Ostatnie 50 ruchów tego SKU w magazynie</h3>
            {historyLoading === selected.client_key && <p className="muted" role="status">Wczytywanie historii…</p>}
            {error && failure?.kind === 'history' && (
              <button className="button" onClick={() => selection && readHistory(selection)}>Ponów odczyt historii</button>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Lokalizacja</th>
                    <th>Zmiana</th>
                    <th>Rodzaj</th>
                    <th>Powód</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((m) => (
                    <tr key={m.id}>
                      <td>{date(m.created_at)}</td>
                      <td>{m.location}</td>
                      <td>
                        {m.delta > 0 ? '+' : ''}
                        {m.delta}
                      </td>
                      <td>
                        {{
                          move: 'Przesunięcie',
                          count: 'Pomiar',
                          shipment: 'Wysyłka',
                          stock_in: 'Przyjęcie',
                          stock_out: 'Wydanie',
                        }[m.kind as string] ?? m.kind}
                      </td>
                      <td>{m.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
