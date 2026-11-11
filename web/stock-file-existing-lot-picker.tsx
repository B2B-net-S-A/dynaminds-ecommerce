import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from './api';
import './stock-file-existing-lot-picker.css';

export type StockFileExistingLotChoice = {
  lot_id: string;
  lot_code: string;
  expiry_date: string | null;
  locations: string[];
};
export type StockFileExistingLotPickerProps = {
  contextKey: string;
  readOnly: boolean;
  warehouseId?: string;
  productId?: string;
  /** Exact location filter, applied only after reading every page. */
  location?: string;
  value: string | null;
  disabled?: boolean;
  /** Additional restriction only; the current API grant remains authoritative. */
  canReadValue?: boolean;
  onChange: (choice: StockFileExistingLotChoice | null) => void;
  onError?: (message: string) => void;
};
type Position = {
  warehouse_id: string;
  product_id: string;
  location: string;
  layer_id: string;
  lot_id: string;
  lot_code: string;
  expiry_date: string | null;
  stock_version: string;
  unit_cost_minor: string | null;
  currency: string;
};
type PositionsReply = {
  available: boolean;
  can_read: boolean;
  can_write: boolean;
  can_read_value: boolean;
  current_role: string | null;
  read_only: boolean;
  data: Position[];
  meta: { cursor: string | null; total?: number };
};
type ChoiceView = StockFileExistingLotChoice & { costLabel: string };
type Loaded = {
  scope: string;
  choices: ChoiceView[];
  positions: number;
  readOnly: boolean;
  canWrite: boolean;
  role: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_POSITIONS = 10_000;
const PAGE_SIZE = 50;
const MAX_PAGES = MAX_POSITIONS / PAGE_SIZE;
const malformed = () =>
  new Error('Odczyt partii jest niepełny lub niespójny. Odczytaj je ponownie.');

function costText(minor: string, currency: string): string {
  const amount = BigInt(minor);
  return `${(amount / 100n).toLocaleString('pl-PL')},${(amount % 100n).toString().padStart(2, '0')} ${currency}`;
}
function groupLots(rows: Position[], showCosts: boolean, location?: string): ChoiceView[] {
  const groups = new Map<
    string,
    {
      choice: StockFileExistingLotChoice;
      costs: Set<string>;
      unknown: boolean;
    }
  >();
  for (const row of rows) {
    if (location !== undefined && row.location !== location) continue;
    const key = row.lot_id.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        choice: {
          lot_id: row.lot_id,
          lot_code: row.lot_code,
          expiry_date: row.expiry_date,
          locations: [],
        },
        costs: new Set(),
        unknown: false,
      };
      groups.set(key, group);
    }
    if (group.choice.lot_code !== row.lot_code || group.choice.expiry_date !== row.expiry_date)
      throw malformed();
    if (!group.choice.locations.includes(row.location)) group.choice.locations.push(row.location);
    if (showCosts) {
      if (row.unit_cost_minor === null) group.unknown = true;
      else group.costs.add(costText(row.unit_cost_minor, row.currency));
    }
  }
  return [...groups.values()]
    .map(({ choice, costs, unknown }) => {
      let costLabel = 'Koszt ukryty dla tego dostępu';
      if (showCosts) {
        const known = [...costs];
        costLabel =
          known.length === 0
            ? 'Koszt nieznany'
            : known.length === 1
              ? `Koszt warstwy: ${known[0]}${unknown ? ' · część kosztów nieznana' : ''}`
              : `Różne koszty warstw (${known.length})${known.some((c) => c.startsWith('0,00 ')) ? ' · obejmują znany koszt 0,00' : ''}${unknown ? ' · część kosztów nieznana' : ''}`;
      }
      return { ...choice, locations: [...choice.locations].sort(), costLabel };
    })
    .sort((a, b) => a.lot_code.localeCompare(b.lot_code, 'pl') || a.lot_id.localeCompare(b.lot_id));
}

export function StockFileExistingLotPicker(props: StockFileExistingLotPickerProps) {
  const {
    contextKey,
    readOnly,
    warehouseId,
    productId,
    location,
    value,
    disabled = false,
    canReadValue,
  } = props;
  const scope = JSON.stringify([
    contextKey,
    readOnly,
    warehouseId ?? null,
    productId ?? null,
    location ?? null,
    canReadValue ?? null,
  ]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const previousScope = useRef(scope);
  const callbacks = useRef(props);
  callbacks.current = props;
  const epoch = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const inputId = useId();
  const readyScope =
    !!contextKey && !!warehouseId && UUID.test(warehouseId) && !!productId && UUID.test(productId);
  const current = loaded?.scope === scope ? loaded : null;
  const selected = current?.choices.find((c) => c.lot_id.toLowerCase() === value?.toLowerCase());
  const canSelect =
    readyScope && !!current && current.canWrite && current.role === 'admin' &&
    !readOnly && !current.readOnly && !disabled && !busy;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    epoch.current++;
    busyRef.current = false;
    setBusy(false);
    setLoaded(null);
    setError(null);
    callbacks.current.onChange(null);
  }, [scope]);

  async function loadAll() {
    if (!readyScope || busyRef.current || disabled || !warehouseId || !productId) return;
    const requestScope = scope;
    const requestEpoch = ++epoch.current;
    const live = () =>
      mounted.current && scopeRef.current === requestScope && epoch.current === requestEpoch;
    busyRef.current = true;
    setBusy(true);
    setLoaded(null);
    setError(null);
    callbacks.current.onChange(null);
    try {
      const rows: Position[] = [];
      const cursors = new Set<string>();
      const identities = new Set<string>();
      let cursor: string | null = null;
      let signature: string | null = null;
      let stockVersion: string | null = null;
      let total: number | undefined;
      let financial = false;
      let apiReadOnly = false;
      let apiCanWrite = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ warehouse_id: warehouseId, product_id: productId });
        if (cursor) query.set('cursor', cursor);
        const reply = await api<PositionsReply>(`/wms-lots/positions?${query}`);
        if (!live()) return;
        if (!reply.available) throw new Error('Śledzenie partii jest teraz niedostępne.');
        if (!reply.can_read) throw new Error('Brak bieżącego dostępu do odczytu partii.');
        if (
          typeof reply.can_read_value !== 'boolean' ||
          typeof reply.can_write !== 'boolean' ||
          typeof reply.read_only !== 'boolean' ||
          typeof reply.current_role !== 'string' ||
          !Array.isArray(reply.data) ||
          reply.data.length > PAGE_SIZE ||
          !reply.meta ||
          !(
            reply.meta.cursor === null ||
            (typeof reply.meta.cursor === 'string' &&
              reply.meta.cursor.length > 0 &&
              reply.meta.cursor.length <= 2000)
          )
        )
          throw malformed();
        const currentSignature = JSON.stringify([
          reply.current_role,
          reply.can_read_value,
          reply.can_write,
          reply.read_only,
        ]);
        if (signature !== null && signature !== currentSignature)
          throw new Error(
            'Dostęp zmienił się podczas odczytu. Lista i wybór partii zostały wyczyszczone.',
          );
        signature = currentSignature;
        financial = reply.can_read_value && canReadValue !== false;
        apiReadOnly = reply.read_only;
        apiCanWrite = reply.can_write;
        if (reply.meta.total !== undefined) {
          if (
            !Number.isSafeInteger(reply.meta.total) ||
            reply.meta.total < 0 ||
            reply.meta.total > MAX_POSITIONS ||
            (total !== undefined && total !== reply.meta.total)
          )
            throw malformed();
          total = reply.meta.total;
        }
        for (const row of reply.data) {
          if (
            !row ||
            !UUID.test(row.warehouse_id) ||
            !UUID.test(row.product_id) ||
            !UUID.test(row.layer_id) ||
            !UUID.test(row.lot_id) ||
            row.warehouse_id.toLowerCase() !== warehouseId.toLowerCase() ||
            row.product_id.toLowerCase() !== productId.toLowerCase() ||
            typeof row.location !== 'string' ||
            typeof row.lot_code !== 'string' ||
            !row.lot_code ||
            !(
              row.expiry_date === null ||
              (typeof row.expiry_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.expiry_date))
            ) ||
            typeof row.stock_version !== 'string' ||
            !/^\d+$/.test(row.stock_version)
          )
            throw malformed();
          if (stockVersion !== null && stockVersion !== row.stock_version) throw malformed();
          stockVersion = row.stock_version;
          const identity = JSON.stringify([
            row.warehouse_id.toLowerCase(),
            row.product_id.toLowerCase(),
            row.location,
            row.layer_id.toLowerCase(),
          ]);
          if (identities.has(identity)) throw malformed();
          identities.add(identity);
          if (
            financial &&
            (typeof row.currency !== 'string' ||
              !/^[A-Z]{3}$/.test(row.currency) ||
              !(
                row.unit_cost_minor === null ||
                (typeof row.unit_cost_minor === 'string' &&
                  /^(0|[1-9]\d*)$/.test(row.unit_cost_minor) &&
                  row.unit_cost_minor.length <= 19 &&
                  BigInt(row.unit_cost_minor) <= 9223372036854775807n)
              ))
          )
            throw malformed();
          rows.push(financial ? row : { ...row, unit_cost_minor: null });
        }
        if (rows.length > MAX_POSITIONS) throw malformed();
        cursor = reply.meta.cursor;
        if (cursor === null) {
          if (total !== undefined && total !== rows.length) throw malformed();
          const choices = groupLots(rows, financial, location);
          if (live())
            setLoaded({
              scope: requestScope,
              choices,
              positions: rows.length,
              readOnly: apiReadOnly,
              canWrite: apiCanWrite,
              role: reply.current_role,
            });
          return;
        }
        if (reply.data.length === 0 || cursors.has(cursor)) throw malformed();
        cursors.add(cursor);
      }
      throw new Error(
        'Lista przekracza limit 10 000 pozycji. Nie można wybrać partii z niepełnego odczytu.',
      );
    } catch (e) {
      if (!live()) return;
      setLoaded(null);
      callbacks.current.onChange(null);
      const message =
        e instanceof ApiError && [401, 403, 423].includes(e.status)
          ? 'Bieżący dostęp nie pozwala odczytać partii. Lista i wybór zostały wyczyszczone.'
          : e instanceof Error
            ? e.message
            : 'Nie udało się odczytać partii.';
      setError({ scope: requestScope, message });
      callbacks.current.onError?.(message);
    } finally {
      if (live()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <section className="stock-file-lot-picker" aria-label="Wybór istniejącej partii">
      <div className="stock-file-lot-picker-toolbar">
        <strong>Istniejąca partia produktu</strong>
        <button
          type="button"
          className="button"
          disabled={!readyScope || disabled || busy}
          onClick={() => void loadAll()}
        >
          {busy
            ? 'Odczytywanie wszystkich stron…'
            : current
              ? 'Odczytaj partie ponownie'
              : 'Odczytaj wszystkie partie'}
        </button>
      </div>
      {!readyScope && <p>Wskaż własny magazyn i produkt, aby odczytać ich partie.</p>}
      {error?.scope === scope && (
        <p className="stock-file-lot-picker-error" role="alert">
          {error.message}
        </p>
      )}
      {current && (
        <>
          <p role="status">
            Odczyt zakończony: {current.positions} pozycji magazynowych, {current.choices.length}{' '}
            partii{location !== undefined ? ` w lokalizacji „${location || '(pusta)'}”` : ''}.
            Wszystkie strony odczytano.
          </p>
          {current.choices.length === 0 ? (
            <p>Brak istniejących partii w wybranym zakresie. Nie przypisano żadnej partii.</p>
          ) : (
            <>
              <label htmlFor={inputId}>Wybierz partię</label>
              <select
                id={inputId}
                value={selected?.lot_id ?? ''}
                disabled={!canSelect}
                onChange={(event) => {
                  if (!canSelect || scopeRef.current !== scope) return;
                  const choice = current.choices.find((c) => c.lot_id === event.target.value);
                  callbacks.current.onChange(
                    choice
                      ? {
                          lot_id: choice.lot_id,
                          lot_code: choice.lot_code,
                          expiry_date: choice.expiry_date,
                          locations: [...choice.locations],
                        }
                      : null,
                  );
                }}
              >
                <option value="">Wybierz partię świadomie</option>
                {current.choices.map((choice) => (
                  <option key={choice.lot_id} value={choice.lot_id}>
                    {choice.lot_code} ·{' '}
                    {choice.expiry_date ? `ważna do ${choice.expiry_date}` : 'brak daty ważności'} ·{' '}
                    {choice.costLabel}
                  </option>
                ))}
              </select>
              {value && !selected && (
                <p role="alert">
                  Poprzednio wskazana partia nie występuje w pełnym odczycie tego zakresu. Wybierz
                  ją ponownie.
                </p>
              )}
              {selected && (
                <p>
                  Lokalizacje: {selected.locations.map((l) => l || '(pusta)').join(', ')}.{' '}
                  {selected.costLabel}.
                </p>
              )}
            </>
          )}
          {(readOnly || current.readOnly) && (
            <p>Tryb tylko do odczytu: zmiana wybranej partii jest zablokowana.</p>
          )}
          {!readOnly && !current.readOnly && (!current.canWrite || current.role !== 'admin') && (
            <p>Bieżący dostęp pozwala tylko odczytać partie. Zmiana wybranej partii jest zablokowana.</p>
          )}
        </>
      )}
      <p className="stock-file-lot-picker-help">
        Lista pomaga wskazać partię; nie zamraża stanu magazynu i nie przypisuje ilości ani kosztu
        korekty. Aktualność i pełny rozkład potwierdzi dopiero podgląd importu. Odczyt obejmuje też
        istniejące pozycje z zerowym stanem.
      </p>
    </section>
  );
}
