import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export type ReturnExchangeProduct = {
  id: string;
  sku: string;
  name: string;
  kind: 'simple' | 'variant' | 'bundle';
  active: true;
  available: number;
};
type Page = {
  data: ReturnExchangeProduct[];
  meta: { cursor: string | null; has_more: boolean };
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validProduct(p: ReturnExchangeProduct) {
  return (
    p &&
    uuid.test(p.id) &&
    typeof p.sku === 'string' &&
    typeof p.name === 'string' &&
    p.active === true &&
    ['simple', 'variant', 'bundle'].includes(p.kind) &&
    Number.isSafeInteger(p.available) &&
    p.available >= 0
  );
}

/** Catalog hints only; the server exchange preview freezes and validates the actual recipe and stock. */
export function ReturnExchangeProductPicker({
  contextKey,
  warehouseId,
  itemId,
  value,
  disabled,
  readOnly,
  onChange,
  onError,
}: {
  contextKey: string;
  warehouseId: string;
  itemId: string;
  value: ReturnExchangeProduct | null;
  disabled: boolean;
  readOnly: boolean;
  onChange: (product: ReturnExchangeProduct | null) => void;
  onError?: (error: Error) => void;
}) {
  const scope = `${contextKey}:${warehouseId}:${itemId}:${readOnly}:${disabled}`;
  const [search, setSearch] = useState('');
  const [loaded, setLoaded] = useState<{
    scope: string;
    search: string;
    data: ReturnExchangeProduct[];
    cursor: string | null;
    seenCursors: string[];
    pages: number;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [allowed, setAllowed] = useState(false);
  const epoch = useRef(0),
    gate = useRef(false);
  const current = useRef({ scope, search });
  current.current = { scope, search };
  const callbacks = useRef({ onChange, onError });
  callbacks.current = { onChange, onError };
  const visible = loaded?.scope === scope && loaded.search === search;
  const canSelect = visible && allowed && !busy && !disabled && !readOnly && !error;
  async function load(more: boolean, generation: number) {
    if (gate.current || disabled || readOnly || !uuid.test(warehouseId) || !uuid.test(itemId))
      return;
    const sent = { scope, search };
    const matches = () =>
      epoch.current === generation &&
      current.current.scope === sent.scope &&
      current.current.search === sent.search;
    const previous = more && visible ? loaded : null;
    if (more && (!previous?.cursor || previous.pages >= 200)) return;
    gate.current = true;
    setBusy(true);
    setError('');
    setAllowed(false);
    try {
      const page = await api<Page>(
        '/products?' +
          new URLSearchParams({
            limit: '50',
            search,
            warehouse_id: warehouseId,
            sellable: 'true',
            ...(previous?.cursor ? { after: previous.cursor } : {}),
          }),
      );
      if (!matches()) return;
      const actor = await api<{ user: { role: string } }>('/auth/me');
      if (!matches()) return;
      if (actor.user?.role !== 'admin')
        throw new ApiError('Wybór zamiennika wymaga bieżących uprawnień administratora.', 403);
      if (
        !Array.isArray(page.data) ||
        page.data.length > 50 ||
        !page.data.every(validProduct) ||
        !page.meta ||
        typeof page.meta.has_more !== 'boolean' ||
        !(
          page.meta.cursor === null ||
          (typeof page.meta.cursor === 'string' && uuid.test(page.meta.cursor))
        ) ||
        page.meta.has_more !== (page.meta.cursor !== null) ||
        (page.meta.cursor && (!page.data.length || page.meta.cursor !== page.data.at(-1)?.id))
      )
        throw Error('Niepełna lista własnych produktów. Wyszukaj ponownie.');
      const data = [...(previous?.data ?? []), ...page.data];
      if (
        new Set(data.map((p) => p.id)).size !== data.length ||
        data.length > 10000 ||
        (page.meta.cursor && previous?.seenCursors.includes(page.meta.cursor))
      )
        throw Error('Nieprawidłowa paginacja produktów. Zawęź wyszukiwanie.');
      setLoaded({
        ...sent,
        data,
        cursor: page.meta.cursor,
        seenCursors: [
          ...(previous?.seenCursors ?? []),
          ...(page.meta.cursor ? [page.meta.cursor] : []),
        ],
        pages: (previous?.pages ?? 0) + 1,
      });
      setAllowed(true);
    } catch (e) {
      if (!matches()) return;
      const failure = e instanceof Error ? e : Error('Nie udało się odczytać produktów.');
      setError(failure.message);
      setLoaded(null);
      setAllowed(false);
      if (e instanceof ApiError && [401, 403, 423].includes(e.status))
        callbacks.current.onError?.(e);
    } finally {
      if (matches()) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const generation = ++epoch.current;
    gate.current = false;
    setLoaded(null);
    setAllowed(false);
    setBusy(false);
    setError('');
    const timer = window.setTimeout(() => void load(false, generation), 250);
    return () => {
      window.clearTimeout(timer);
      ++epoch.current;
      gate.current = false;
    };
  }, [scope, search]);
  const choices = visible && loaded ? loaded.data : [];
  const options = value && !choices.some((p) => p.id === value.id) ? [value, ...choices] : choices;
  return (
    <div className="catalog-picker">
      <label>
        Szukaj zamiennika
        <input
          value={search}
          maxLength={200}
          placeholder="Nazwa, SKU lub EAN"
          disabled={disabled || readOnly || !warehouseId}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <label>
        Produkt zamienny
        <select
          value={value?.id ?? ''}
          required
          disabled={!canSelect}
          onChange={(e) => {
            if (current.current.scope !== scope || current.current.search !== search || !canSelect)
              return;
            callbacks.current.onChange(options.find((p) => p.id === e.target.value) ?? null);
          }}
        >
          <option value="">Wybierz produkt</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} · {p.name} · dostępne w wybranym magazynie: {p.available}
            </option>
          ))}
        </select>
      </label>
      {!warehouseId && <p>Najpierw wybierz magazyn realizacji zamiennika.</p>}
      <small>
        To bieżący odczyt katalogu. Pełny podgląd sprawdzi recepturę i zapas przed rezerwacją.
        Zamiennik pozostaje bezpłatny niezależnie od ceny katalogowej.
      </small>
      {busy && <p role="status">Odczytywanie produktów…</p>}
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      {visible && loaded && loaded.cursor && (
        <button
          type="button"
          className="button"
          disabled={!canSelect || loaded.pages >= 200}
          onClick={() => void load(true, epoch.current)}
        >
          Więcej wyników
        </button>
      )}
      {visible && loaded && loaded.pages >= 200 && loaded.cursor && (
        <p>
          Zawęź wyszukiwanie. Odczytano limit 10000 wyników; pozostałych nie ukryto jako pełnej
          listy.
        </p>
      )}
    </div>
  );
}
