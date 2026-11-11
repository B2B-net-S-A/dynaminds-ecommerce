import { useEffect, useState } from 'react';
import { api, date } from './api';

function usePage(base: string, refresh: string | number = 0, enabled = true) {
  const [page, setPage] = useState<{
    base: string;
    cursor: string | null;
    previous: (string | null)[];
  }>({ base, cursor: null, previous: [] });
  useEffect(() => {
    setPage({ base, cursor: null, previous: [] });
  }, [base]);
  const [result, setResult] = useState<{ path: string; data?: any; error?: string } | null>(null);
  const cursor = page.base === base ? page.cursor : null,
    previous = page.base === base ? page.previous : [];
  const path = base + (cursor ? '&after=' + encodeURIComponent(cursor) : '');
  useEffect(() => {
    let active = true;
    setResult(null);
    if (!enabled) {
      setResult({ path, data: { data: [], meta: { has_more: false, cursor: null } } });
      return () => {
        active = false;
      };
    }
    api(path)
      .then((data) => active && setResult({ path, data }))
      .catch((e) => active && setResult({ path, error: e.message }));
    return () => {
      active = false;
    };
  }, [path, refresh, enabled]);
  const data = result?.path === path ? result.data : null,
    error = result?.path === path ? result.error : '';
  return {
    data,
    error,
    number: previous.length + 1,
    canBack: previous.length > 0,
    back: () => setPage({ base, cursor: previous.at(-1) ?? null, previous: previous.slice(0, -1) }),
    next: () =>
      data?.meta.cursor &&
      setPage({ base, cursor: data.meta.cursor, previous: [...previous, cursor] }),
  };
}
function Pager({ page, label }: { page: ReturnType<typeof usePage>; label: string }) {
  return (
    <div className="pagination">
      <button
        type="button"
        className="button subtle"
        aria-label={'Poprzednia: ' + label}
        disabled={!page.canBack || !page.data}
        onClick={page.back}
      >
        Poprzednia
      </button>
      <span>
        Strona {page.number} · {page.data?.data.length ?? 0} na stronie
      </span>
      <button
        type="button"
        className="button subtle"
        aria-label={'Następna: ' + label}
        disabled={!page.data?.meta.has_more}
        onClick={page.next}
      >
        Następna
      </button>
    </div>
  );
}
export async function fetchStockSnapshot(warehouse: string, ids: string[]) {
  const products = [...new Set(ids.filter(Boolean))];
  if (!warehouse || !products.length) return [];
  return (
    await api(
      '/inventory/snapshot?' +
        new URLSearchParams({ warehouse_id: warehouse, product_ids: products.join(',') }),
    )
  ).data;
}
export function StockPicker({
  label,
  warehouse,
  value,
  select,
  initial,
  disabled = false,
  refresh = 0,
}: {
  label: string;
  warehouse: string;
  value: string;
  select: (stock: any) => void;
  initial?: any;
  disabled?: boolean;
  refresh?: string | number;
}) {
  const [search, setSearch] = useState('');
  const page = usePage(
    '/inventory?' +
      new URLSearchParams({
        limit: '50',
        warehouse_id: warehouse,
        search,
      }),
    refresh,
    !!warehouse,
  );
  const rows = [...(page.data?.data ?? [])];
  if (initial && value && !rows.some((s) => s.product_id === value))
    rows.unshift({ ...initial, product_id: value });
  return (
    <fieldset className="catalog-picker stock-picker" disabled={disabled || !warehouse}>
      <label>
        {label}
        <input
          aria-label={'Szukaj: ' + label}
          placeholder="Nazwa, SKU lub EAN"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label={label}
          required
          value={value}
          onChange={(e) => select(rows.find((s) => s.product_id === e.target.value) ?? null)}
        >
          <option value="">Wybierz produkt ze stanem</option>
          {rows.map((s) => (
            <option key={s.product_id} value={s.product_id}>
              {s.sku} · {s.name} · fizycznie dostępne {s.available ?? '—'}
            </option>
          ))}
        </select>
      </label>
      {page.error ? (
        <div className="notice import-error" role="alert">
          {page.error}
        </div>
      ) : !page.data ? (
        <small>Wczytywanie stanów…</small>
      ) : !page.data.data.length ? (
        <small>Brak stanów dla wybranego filtra.</small>
      ) : null}
      <Pager page={page} label={label} />
    </fieldset>
  );
}
const movementNames: Record<string, string> = {
  shipment: 'Wysyłka',
  return: 'Zwrot',
  adjustment: 'Korekta',
  initial: 'Stan początkowy',
  receipt: 'Przyjęcie PZ',
  transfer_in: 'Przesunięcie — przyjęcie',
  transfer_out: 'Przesunięcie — wydanie',
  count: 'Inwentaryzacja',
  location_count: 'Pomiar lokalizacji',
  stocktake: 'Rozliczenie spisu',
  wms_stocktake: 'Inwentaryzacja partii',
};
function inventoryAvailability(s: any) {
  const fields = ['physical_available', 'sellable_available', 'inventory_usage', 'inventory_enabled', 'inventory_policy_version'];
  const legacy = fields.every(key => s[key] === undefined);
  const complete = Number.isSafeInteger(s.physical_available) && Number.isSafeInteger(s.sellable_available) &&
    ['sale', 'custody'].includes(s.inventory_usage) && typeof s.inventory_enabled === 'boolean' &&
    typeof s.inventory_policy_version === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(s.inventory_policy_version) &&
    BigInt(s.inventory_policy_version) < 9223372036854775807n;
  return {
    physical: Number.isSafeInteger(s.physical_available) ? s.physical_available : s.available ?? '—',
    sellable: complete ? s.sellable_available : legacy ? s.available ?? '—' : '—',
    policy: complete
      ? `${s.inventory_usage === 'custody' ? 'Poza sprzedażą' : 'Sprzedażowy'} · ${s.inventory_enabled ? 'aktywna' : 'nieaktywna'} · wersja ${s.inventory_policy_version}${s.inventory_policy_version === '0' ? ' (domyślna)' : ''}`
      : legacy ? 'Sprzedażowy · starszy odczyt, bez wersji polityki' : 'Niepełny odczyt polityki — dostępność sprzedażowa niepotwierdzona',
  };
}
export function InventoryPanel({ refresh,onOpenProduct }: { refresh: number;onOpenProduct?:(id:string)=>void }) {
  const [warehouse, setWarehouse] = useState(''),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [stockSearch, setStockSearch] = useState(''),
    [movementSearch, setMovementSearch] = useState(''),
    [kind, setKind] = useState(''),
    [warehouseError, setWarehouseError] = useState('');
  useEffect(() => {
    let active = true;
    api('/warehouses')
      .then((r) => active && setWarehouses(r.data))
      .catch((e) => active && setWarehouseError(e.message));
    return () => {
      active = false;
    };
  }, [refresh]);
  const filter: Record<string, string> = warehouse ? { warehouse_id: warehouse } : {};
  const stock = usePage(
    '/inventory?' + new URLSearchParams({ limit: '50', search: stockSearch, ...filter }),
    refresh,
  );
  const movements = usePage(
    '/inventory/movements?' +
      new URLSearchParams({
        limit: '50',
        search: movementSearch,
        ...filter,
        ...(kind ? { kind } : ({} as Record<string, string>)),
      }),
    refresh,
  );
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Łączne stany magazynów</h2>
            <p>Fizycznie dostępne = na stanie − rezerwacje. Dostępność sprzedażowa wynika z polityki magazynu i jest odrębną wartością.</p>
          </div>
        </div>
        <div className="warehouse-filters">
          <label>
            Magazyn stanów i ruchów
            <select
              aria-label="Magazyn stanów i ruchów"
              value={warehouse}
              onChange={(e) => setWarehouse(e.target.value)}
            >
              <option value="">Wszystkie magazyny</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Szukaj stanów
            <input
              aria-label="Szukaj stanów"
              placeholder="Nazwa, SKU lub EAN"
              value={stockSearch}
              onChange={(e) => setStockSearch(e.target.value)}
            />
          </label>
        </div>
        {stock.error || warehouseError ? (
          <div role="alert" className="notice import-error">
            {stock.error || warehouseError}
          </div>
        ) : !stock.data ? (
          <p>Wczytywanie stanów…</p>
        ) : !stock.data.data.length ? (
          <p>Brak stanów dla wybranego filtra.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Magazyn</th>
                  <th>Domyślne przyjęcie</th>
                  <th>Na stanie</th>
                  <th>Rezerwacje</th>
                  <th>Fizycznie dostępne</th>
                  <th>Dostępne do sprzedaży</th>
                  <th>Polityka magazynu</th>
                </tr>
              </thead>
              <tbody>
                {stock.data.data.map((s: any) => {
                  const availability = inventoryAvailability(s);
                  return (
                  <tr key={s.warehouse_id + s.product_id}>
                    <td>
                      {onOpenProduct?<button type="button" className="text-button" onClick={()=>onOpenProduct(s.product_id)}>{s.name}</button>:<strong>{s.name}</strong>}
                      <small>{s.sku}</small>
                    </td>
                    <td>{s.warehouse_name}</td>
                    <td>
                      <code>{s.location}</code>
                    </td>
                    <td>{s.on_hand}</td>
                    <td>{s.reserved}</td>
                    <td>
                      <span className="stock-pill">{availability.physical}</span>
                    </td>
                    <td><span className="stock-pill">{availability.sellable}</span></td>
                    <td>{availability.policy}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={stock} label="stany magazynowe" />
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Ruchy magazynowe</h2>
            <p>Historia wysyłek, zwrotów i korekt</p>
          </div>
        </div>
        <div className="warehouse-filters">
          <label>
            Szukaj ruchów
            <input
              aria-label="Szukaj ruchów"
              placeholder="SKU, nazwa, dokument lub notatka"
              value={movementSearch}
              onChange={(e) => setMovementSearch(e.target.value)}
            />
          </label>
          <label>
            Rodzaj ruchu
            <select
              aria-label="Rodzaj ruchu"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">Wszystkie rodzaje</option>
              {Object.entries(movementNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
        {movements.error ? (
          <div role="alert" className="notice import-error">
            {movements.error}
          </div>
        ) : !movements.data ? (
          <p>Wczytywanie ruchów…</p>
        ) : !movements.data.data.length ? (
          <p>Brak ruchów dla wybranego filtra.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>SKU</th>
                  <th>Magazyn / dokument</th>
                  <th>Operacja</th>
                  <th>Zmiana</th>
                  <th>Notatka</th>
                </tr>
              </thead>
              <tbody>
                {movements.data.data.map((m: any) => (
                  <tr key={m.id}>
                    <td>{date(m.created_at)}</td>
                    <td>{m.sku}</td>
                    <td>
                      {m.warehouse_name}
                      <small>{m.warehouse_document_number ?? '—'}</small>
                    </td>
                    <td>{movementNames[m.kind] ?? m.kind}</td>
                    <td>
                      <strong className={m.delta > 0 ? 'positive' : 'negative'}>
                        {m.delta > 0 ? '+' : ''}
                        {m.delta}
                      </strong>
                    </td>
                    <td>{m.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={movements} label="ruchy magazynowe" />
      </section>
    </>
  );
}
