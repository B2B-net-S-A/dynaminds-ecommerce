import { CatalogStockCountDocuments } from './catalog-stock-count-documents';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import { ProductPicker } from './catalog';
import { StockFileExistingLotPicker } from './stock-file-existing-lot-picker';
import './stock-file-import.css';

export type StockFileImportWorkspaceProps = {
  contextKey: string;
  readOnly: boolean;
  onApplied?: () => void;
  onError?: (message: string) => void;
  onLockedChange?: (locked: boolean) => void;
  externalWriteBlocked?: boolean;
};
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string | null;
  can_read: boolean;
  can_write: boolean;
  can_read_value: boolean;
};
type Policy = { enabled: boolean; version: string; currency: string | null };
type Warehouse = { id: string; name: string; code: string };
type Definition = {
  format: 'csv' | 'xml';
  xml_mode: 'positions' | 'catalog';
  delimiter: ';' | ',' | '\t';
  identity: 'uuid' | 'sku' | 'historical_sku' | 'ean' | 'name';
  identity_field: string;
  spreadsheet_safe: boolean;
  empty_policy: 'skip' | 'error';
};
type Mapping = {
  quantity: string;
  location?: string;
  operation?: string;
  lot_id?: string;
  lot_code?: string;
  expiry_date?: string;
  unit_cost_minor?: string;
  currency?: string;
};
type Target = {
  warehouse_id: string;
  quantity_scope: 'position' | 'warehouse_total';
  mapping: Mapping;
  default_location: string | null;
};
type Lot =
  | { kind: 'existing'; lot_id: string }
  | { kind: 'new'; lot_code: string; expiry_date: string | null };
type Position = {
  location: string;
  lot: Lot | null;
  quantity: number;
  unit_cost_minor: string | null;
  currency: string | null;
};
type Resolution = { source_index: number; warehouse_id: string; positions: Position[] };
type PositionDraft = {
  id: string;
  location: string;
  lot_kind: '' | 'existing' | 'new';
  lot_id: string;
  lot_code: string;
  expiry_date: string;
  quantity: string;
  cost_mode: '' | 'known' | 'unspecified';
  cost_decimal: string;
  currency: string;
};
type DistributionDraft = {
  id: string;
  row_number: string;
  warehouse_id: string;
  positions: PositionDraft[];
};
type HelperProduct = { id: string; sku: string; name: string; kind: 'simple' | 'variant' };
type HelperSelection = { scope: string; product: HelperProduct };
function emptyPosition(): PositionDraft {
  return {
    id: crypto.randomUUID(),
    location: '',
    lot_kind: '',
    lot_id: '',
    lot_code: '',
    expiry_date: '',
    quantity: '',
    cost_mode: '',
    cost_decimal: '',
    currency: '',
  };
}
type Limits = {
  file_bytes: number;
  request_bytes: number;
  source_rows: number;
  products: number;
  warehouses: number;
  positions: number;
  expanded_layers: number;
  quantity: number;
  page: number;
  profiles: number;
  history_per_tenant: number;
};
type Options = Flags & {
  limits: Limits;
  policy: Policy;
  warehouses: Warehouse[];
  next_cursor: string | null;
};
type Summary = {
  source_rows: number;
  products: number;
  positions: number;
  changed: number;
  unchanged: number;
  invalid: number;
  conflicts: number;
  skipped: number;
  unknown_loss_quantity?: number;
  surplus_quantity?: number;
};
type FrozenTarget = Target & {
  warehouse_name: string;
  summary: {
    positions: number;
    changed: number;
    unchanged: number;
    invalid: number;
    conflicts: number;
    unknown_loss_quantity?: number;
    surplus_quantity?: number;
  };
  valuation: { currency: string; known_loss_minor: string; known_surplus_minor: string } | null;
};
type Head = {
  stock_count_documents?: unknown;
  id: string;
  client_key: string;
  file_name: string;
  source_hash: string;
  scope_hash: string;
  definition: Definition;
  targets: FrozenTarget[];
  note: string;
  summary: Summary;
  created_at: string;
  can_execute: boolean;
  policy: Policy;
  preview_id?: string;
  links?: {
    warehouse_id: string;
    mode: 'off' | 'on';
    core_preview_id?: string;
    core_execution_id?: string;
    stocktake_id?: string;
    review_id?: string;
    posting_id?: string;
    operation_id?: string;
  }[];
};
type State = {
  present: boolean;
  quantity: number;
  reserved: number;
  available: number;
  warehouse_on_hand: number;
  warehouse_reserved: number;
  stock_version: string | null;
};
type Fragment = {
  layer_id: string | null;
  quantity: number;
  delta: number;
  unit_cost_minor: string | null;
  currency: string;
};
type Row = {
  index: number;
  source_index: number;
  raw_cells: Record<string, unknown> | null;
  resolution: { identity: string; value: string | null; matched_historical_sku: string | null };
  product_id: string | null;
  sku: string | null;
  name: string | null;
  warehouse_id: string;
  warehouse_name: string;
  location: string | null;
  lot: {
    id?: string | null;
    lot_id?: string;
    kind?: 'existing' | 'new';
    lot_code?: string;
    expiry_date?: string | null;
  } | null;
  input: { operation: 'none' | 'count'; quantity?: number };
  before: State | null;
  after: State | null;
  fragments: Fragment[] | null;
  valuation: unknown | null;
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict' | 'skipped';
  errors: string[];
};
type Profile = {
  id: string;
  name: string;
  version: number;
  definition: Definition;
  targets: Target[];
};
type Collection<T> = Flags & { data: T[]; next_cursor: string | null; total: number };
type RowsReply = Flags & { rows: Row[]; next_cursor: string | null; total: number };
type Reply = Flags & { preview?: Head; execution?: Head; profile?: Profile; reused?: boolean };
type Review = { kind: 'preview' | 'execution'; head: Head; rows: Row[]; complete: boolean };
type Attempt = {
  context: string;
  kind: 'preview' | 'execute' | 'profile';
  path: string;
  method: 'POST' | 'PATCH';
  serialized: string;
  label: string;
};
// Only RAM retains uncertain requests. Remounting the same actor never resends them.
const retained: { context: string; attempt: Attempt | null; inFlight: boolean } = {
  context: '',
  attempt: null,
  inFlight: false,
};
const listeners = new Set<() => void>();
function publish() {
  listeners.forEach((fn) => fn());
}
export function getStockFileImportLock(contextKey: string): boolean {
  return retained.context === contextKey && (retained.inFlight || !!retained.attempt);
}
export function subscribeStockFileImportLock(
  contextKey: string,
  callback: (locked: boolean) => void,
): () => void {
  const sync = () => callback(getStockFileImportLock(contextKey));
  listeners.add(sync);
  sync();
  return () => {
    listeners.delete(sync);
  };
}
export function resetStockFileImportContext(contextKey: string) {
  retained.context = contextKey;
  retained.attempt = null;
  retained.inFlight = false;
  publish();
}
const prefix = '/stock-file-imports';
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const copyTarget = (t: Target): Target => ({
  warehouse_id: t.warehouse_id,
  quantity_scope: t.quantity_scope,
  mapping: { ...t.mapping },
  default_location: t.default_location,
});
const initialDefinition = (): Definition => ({
  format: 'csv',
  xml_mode: 'positions',
  delimiter: ';',
  identity: 'sku',
  identity_field: 'sku',
  spreadsheet_safe: false,
  empty_policy: 'skip',
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const currencies = ['PLN', 'EUR', 'USD', 'GBP', 'CZK'];
function costMinor(text: string): string {
  const match = /^(0|[1-9][0-9]*)(?:[,.]([0-9]{1,2}))?$/.exec(text.trim());
  if (!match || text.length > 24)
    throw new Error(
      'Koszt: wpisz kwotę nieujemną, np. 12,99; maksymalnie dwie cyfry po przecinku.',
    );
  const amount = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (amount > 9223372036854775807n) throw new Error('Koszt przekracza dopuszczalny zakres.');
  return amount.toString();
}
function countedInteger(text: string, maximum: number, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 12)
    throw new Error(`${label}: wpisz pełną liczbę sztuk. Puste pole nie oznacza zera.`);
  const n = BigInt(text);
  if (n > BigInt(maximum)) throw new Error(`${label}: przekroczono dopuszczalny zakres.`);
  return Number(n);
}
function formResolutions(
  drafts: DistributionDraft[],
  targets: Target[],
  policy: Policy,
  limits: Limits,
): Resolution[] {
  const result = drafts.map((draft) => {
    const row = countedInteger(draft.row_number, limits.source_rows, 'Wiersz danych w pliku');
    if (row < 1) throw new Error('Numer wiersza danych zaczyna się od 1, bez nagłówka CSV.');
    return {
      source_index: row - 1,
      warehouse_id: draft.warehouse_id,
      positions: draft.positions.map((p) => {
        if (policy.enabled && !p.lot_kind) throw new Error(`Wiersz ${row}: wybierz rodzaj partii.`);
        if (policy.enabled && !p.cost_mode)
          throw new Error(`Wiersz ${row}: jawnie wybierz, czy podajesz nowy koszt.`);
        const known = policy.enabled && p.cost_mode === 'known';
        return {
          location: p.location,
          lot: !policy.enabled
            ? null
            : p.lot_kind === 'existing'
              ? { kind: 'existing', lot_id: p.lot_id }
              : { kind: 'new', lot_code: p.lot_code, expiry_date: p.expiry_date || null },
          quantity: countedInteger(p.quantity, limits.quantity, `Wiersz ${row} · policzona ilość`),
          unit_cost_minor: known ? costMinor(p.cost_decimal) : null,
          currency: known ? p.currency : null,
        };
      }),
    };
  });
  // Both editors pass through the same closed transport validation.
  return parseResolutions(JSON.stringify(result), targets, policy, limits);
}
function validText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) === value
  );
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Rozkład musi zawierać obiekty JSON.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], required = allowed) {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in value))
  )
    throw new Error(
      'Rozkład zawiera brakujące lub niedozwolone pola. Nie podawaj product_id ani wersji.',
    );
}
function parseResolutions(
  text: string,
  targets: Target[],
  policy: Policy,
  limits: Limits,
): Resolution[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length > limits.source_rows * limits.warehouses)
    throw new Error('Rozkład musi być ograniczoną tablicą JSON.');
  const seen = new Set<string>();
  let totalPositions = 0;
  const result = parsed.map((value): Resolution => {
    const r = record(value);
    keys(r, ['source_index', 'warehouse_id', 'positions']);
    if (
      !Number.isInteger(r.source_index) ||
      (r.source_index as number) < 0 ||
      (r.source_index as number) >= limits.source_rows
    )
      throw new Error('Numer wiersza danych jest poza dopuszczalnym zakresem pliku.');
    if (
      typeof r.warehouse_id !== 'string' ||
      !uuid.test(r.warehouse_id) ||
      !targets.some((t) => t.warehouse_id === (r.warehouse_id as string).toLowerCase())
    )
      throw new Error('Wybierz własny magazyn zaznaczony w zakresie importu.');
    const warehouse_id = r.warehouse_id.toLowerCase(),
      key = `${r.source_index}:${warehouse_id}`;
    if (seen.has(key)) throw new Error('Powtórzony rozkład tego samego wiersza i magazynu.');
    seen.add(key);
    if (!Array.isArray(r.positions) || !r.positions.length || r.positions.length > limits.positions)
      throw new Error('Każdy rozkład wymaga pełnych pozycji.');
    totalPositions += r.positions.length;
    if (totalPositions > limits.positions)
      throw new Error('Przekroczono limit pozycji fizycznych. Nie obcięto rozkładu.');
    const positionKeys = new Set<string>();
    const positions = r.positions.map((value): Position => {
      const p = record(value);
      keys(p, ['location', 'lot', 'quantity', 'unit_cost_minor', 'currency']);
      if (!validText(p.location, 80))
        throw new Error('Każda pozycja wymaga poprawnej lokalizacji do 80 znaków.');
      if (
        !Number.isSafeInteger(p.quantity) ||
        (p.quantity as number) < 0 ||
        (p.quantity as number) > limits.quantity
      )
        throw new Error('Policzona ilość musi być pełną liczbą od 0 do 1000000 szt.');
      let lot: Lot | null = null;
      if (p.lot !== null) {
        const l = record(p.lot);
        if (l.kind === 'existing') {
          keys(l, ['kind', 'lot_id']);
          if (typeof l.lot_id !== 'string' || !uuid.test(l.lot_id))
            throw new Error('Istniejąca partia wymaga poprawnego identyfikatora z ewidencji WMS.');
          lot = { kind: 'existing', lot_id: l.lot_id.toLowerCase() };
        } else if (l.kind === 'new') {
          keys(l, ['kind', 'lot_code', 'expiry_date']);
          if (
            !validText(l.lot_code, 100) ||
            (l.expiry_date !== null &&
              (typeof l.expiry_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(l.expiry_date)))
          )
            throw new Error(
              'Nowa partia wymaga kodu i poprawnej daty ważności, jeśli ją podajesz.',
            );
          lot = {
            kind: 'new',
            lot_code: l.lot_code.trim(),
            expiry_date: l.expiry_date as string | null,
          };
        } else throw new Error('Wybierz istniejącą albo nową partię.');
      }
      if (policy.enabled && !lot)
        throw new Error('WMS jest włączony: każda pozycja wymaga jawnej partii.');
      if (!policy.enabled && lot)
        throw new Error('Przy wyłączonym WMS pomiar nie wskazuje partii.');
      if (
        p.unit_cost_minor !== null &&
        (typeof p.unit_cost_minor !== 'string' ||
          !/^(0|[1-9][0-9]{0,18})$/.test(p.unit_cost_minor) ||
          BigInt(p.unit_cost_minor) > 9223372036854775807n)
      )
        throw new Error(
          'unit_cost_minor: wpisz kanoniczny string najmniejszej jednostki lub null. Zero "0" jest znanym kosztem.',
        );
      if (
        p.currency !== null &&
        (typeof p.currency !== 'string' || !currencies.includes(p.currency))
      )
        throw new Error('Niepoprawna waluta kosztu.');
      if ((p.unit_cost_minor === null) !== (p.currency === null))
        throw new Error('Koszt i waluta muszą być podane razem albo oba mieć wartość null.');
      if (policy.enabled && p.currency !== null && p.currency !== policy.currency)
        throw new Error('Waluta kosztu musi być walutą polityki WMS.');
      const location = p.location.trim(),
        pk = `${location}:${JSON.stringify(lot)}`;
      if (positionKeys.has(pk))
        throw new Error('Powtórzona fizyczna lokalizacja i partia w rozkładzie.');
      positionKeys.add(pk);
      return {
        location,
        lot,
        quantity: p.quantity as number,
        unit_cost_minor: p.unit_cost_minor as string | null,
        currency: p.currency as string | null,
      };
    });
    return { source_index: r.source_index as number, warehouse_id, positions };
  });
  return result.sort(
    (a, b) => a.source_index - b.source_index || a.warehouse_id.localeCompare(b.warehouse_id),
  );
}
function money(value: string | null | undefined, currency: string) {
  if (value === null || value === undefined) return 'Koszt nieznany';
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) return 'Nieprawidłowa kwota';
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')} ${currency}`;
}
const statusNames = {
  changed: 'Zmiana',
  unchanged: 'Bez zmian',
  invalid: 'Błąd',
  conflict: 'Konflikt',
  skipped: 'Pominięto',
};
function StateView({ value }: { value: State | null }) {
  return value ? (
    <div className="sfi-state">
      <strong>Fizycznie: {value.quantity}</strong>
      <span>
        Rezerwacje: {value.reserved} · dostępne: {value.available}
      </span>
      <small>
        {value.present ? 'Istniejący zapas' : 'Brak zapasu'} · wersja{' '}
        {value.stock_version ?? 'Nie istnieje'}
      </small>
      <small>
        Magazyn: {value.warehouse_on_hand} · rezerwacje {value.warehouse_reserved}
      </small>
    </div>
  ) : (
    <span>Brak poprawnego wyniku</span>
  );
}
function RowsView({ review, financial }: { review: Review; financial: boolean }) {
  const [page, setPage] = useState(0),
    [errorsOnly, setErrorsOnly] = useState(false);
  const rows = errorsOnly
    ? review.rows.filter((r) => r.errors.length || ['invalid', 'conflict'].includes(r.status))
    : review.rows;
  const pages = Math.max(1, Math.ceil(rows.length / 25)),
    current = Math.min(page, pages - 1);
  return (
    <>
      <div className="sfi-toolbar">
        <label className="sfi-check">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => {
              setErrorsOnly(e.target.checked);
              setPage(0);
            }}
          />
          Tylko błędy i konflikty
        </label>
        <span>
          Odczytano {review.rows.length} / {review.head.summary.positions} pozycji · widoczne{' '}
          {rows.length}
        </span>
        <button className="button" disabled={!current} onClick={() => setPage(current - 1)}>
          Poprzednie pozycje
        </button>
        <span>
          Strona {current + 1} / {pages}
        </span>
        <button
          className="button"
          disabled={current + 1 >= pages}
          onClick={() => setPage(current + 1)}
        >
          Następne pozycje
        </button>
      </div>
      {rows.slice(current * 25, (current + 1) * 25).map((row) => (
        <article key={row.index} className={`sfi-row ${row.errors.length ? 'sfi-invalid' : ''}`}>
          <h4>
            {row.index + 1}. {row.sku ?? 'Produkt nierozpoznany'} · {row.name}
          </h4>
          <p>
            Wiersz danych w pliku: {row.source_index + 1} · {row.warehouse_name} · lokalizacja{' '}
            {row.location ?? 'Niewskazana'}
            {row.lot && ` · partia ${row.lot.lot_code ?? row.lot.lot_id ?? row.lot.id ?? 'Nowa'}`}
            {row.lot?.expiry_date && ` · ważność ${row.lot.expiry_date}`}
          </p>
          <small>
            ID produktu: {row.product_id ?? 'Nie rozpoznano'} · ID magazynu: {row.warehouse_id}
          </small>
          {row.resolution.matched_historical_sku && (
            <p>
              Wcześniejsze SKU dopasowano do tego samego produktu. Aktualne SKU pokazano powyżej;
              kod nie zostanie zmieniony.
            </p>
          )}
          <strong>{statusNames[row.status]}</strong>
          {row.errors.length > 0 && (
            <ul className="sfi-error">
              {row.errors.map((error, i) => (
                <li key={i}>{error}</li>
              ))}
            </ul>
          )}
          <div className="sfi-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pomiar z pliku</th>
                  <th>Przed</th>
                  <th>Po</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    {row.input.operation === 'none'
                      ? 'Pomiń — zachowaj zapas'
                      : `Policzone: ${row.input.quantity ?? 'Brak'}`}
                    <small>Tożsamość z pliku: {row.resolution.value ?? 'Brak'}</small>
                  </td>
                  <td>
                    <StateView value={row.before} />
                  </td>
                  <td>
                    <StateView value={row.after} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {financial && row.fragments && row.fragments.length > 0 && (
            <details>
              <summary>Fizyczne fragmenty i koszt rozbieżności</summary>
              <div className="sfi-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Warstwa</th>
                      <th>Ilość / różnica</th>
                      <th>Koszt jednostkowy netto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.fragments.map((f, i) => (
                      <tr key={`${f.layer_id}:${i}`}>
                        <td>{f.layer_id ?? 'Nowa warstwa nadwyżki'}</td>
                        <td>
                          {f.quantity} / {f.delta > 0 ? '+' : ''}
                          {f.delta}
                        </td>
                        <td>{money(f.unit_cost_minor, f.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>Koszt nieznany pozostaje nieznany; cena sprzedaży nie jest kosztem magazynu.</p>
            </details>
          )}
          {financial && row.raw_cells && (
            <details>
              <summary>Oryginalne komórki pliku</summary>
              <dl className="sfi-raw">
                {Object.entries(row.raw_cells).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>
                      {value === null
                        ? 'Brak (null)'
                        : value === ''
                          ? 'Puste'
                          : typeof value === 'object'
                            ? JSON.stringify(value)
                            : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </article>
      ))}
      {!rows.length && (
        <p>{errorsOnly ? 'Nie ma błędów w odczytanym zakresie.' : 'Brak pozycji.'}</p>
      )}
    </>
  );
}

export function StockFileImportWorkspace({
  contextKey,
  readOnly,
  onApplied,
  onError,
  onLockedChange,
  externalWriteBlocked = false,
}: StockFileImportWorkspaceProps) {
  const [flags, setFlags] = useState<Flags | null>(null),
    [options, setOptions] = useState<Options | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]),
    [warehouseCursor, setWarehouseCursor] = useState<string | null>(null);
  const [definition, setDefinition] = useState<Definition>(initialDefinition),
    [targets, setTargets] = useState<Target[]>([]);
  const [content, setContent] = useState(''),
    [fileName, setFileName] = useState(''),
    [note, setNote] = useState(''),
    [resolutionsText, setResolutionsText] = useState('[]');
  const [distributionDrafts, setDistributionDrafts] = useState<DistributionDraft[]>([]),
    [distributionMode, setDistributionMode] = useState<'form' | 'json'>('form');
  const [helperProducts, setHelperProducts] = useState<Record<string, HelperSelection>>({});
  const [tab, setTab] = useState<'import' | 'profiles' | 'history'>('import'),
    [review, setReview] = useState<Review | null>(null);
  const [consent, setConsent] = useState(false),
    [unknownConsent, setUnknownConsent] = useState<Record<string, boolean>>({}),
    [surplusConsent, setSurplusConsent] = useState<Record<string, boolean>>({});
  const [profiles, setProfiles] = useState<Profile[]>([]),
    [profileId, setProfileId] = useState(''),
    [profileName, setProfileName] = useState(''),
    [profileConsent, setProfileConsent] = useState(false);
  const [historyKind, setHistoryKind] = useState<'previews' | 'executions'>('executions'),
    [history, setHistory] = useState<Head[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const [busy, setBusy] = useState(false),
    [remoteBusy, setRemoteBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null);
  const [blocked, setBlocked] = useState(false),
    [writeBlocked, setWriteBlocked] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const epoch = useRef(0),
    readId = useRef(0),
    localBusy = useRef(false),
    authorized = useRef<string | null>(null),
    fileRef = useRef<HTMLInputElement | null>(null);
  const scope = useRef('');
  scope.current = `${contextKey}:${readOnly}`;
  const stateScope = useRef(scope.current);
  const actor = useRef(contextKey);
  actor.current = contextKey;
  const externalLock = useRef(externalWriteBlocked);
  externalLock.current = externalWriteBlocked;
  const flagsRef = useRef<Flags | null>(null);
  flagsRef.current = flags;
  const readable =
    !!flags?.available && flags.can_read && !blocked && authorized.current === scope.current;
  const authorizedWritable =
    readable && !!flags?.can_write && !flags.read_only && !readOnly && !writeBlocked;
  const writable = authorizedWritable && !externalWriteBlocked,
    locked = busy || remoteBusy || !!pending,
    writeDisabled = !writable || locked;
  const financial = readable && !!flags?.can_read_value;
  const helperScope = JSON.stringify([
    scope.current,
    flags?.current_role,
    flags?.can_read_value,
    flags?.can_write,
    flags?.read_only,
  ]);
  const helperScopeRef = useRef(helperScope);
  helperScopeRef.current = helperScope;
  const editorBlocked = useRef(true);
  editorBlocked.current = writeDisabled || distributionMode !== 'form';
  const draftsRef = useRef(distributionDrafts);
  draftsRef.current = distributionDrafts;
  const helperProductsRef = useRef(helperProducts);
  helperProductsRef.current = helperProducts;
  const profile = profiles.find((p) => p.id === profileId);
  const catalogMode = definition.format === 'xml' && definition.xml_mode === 'catalog';
  function invalidate() {
    setReview(null);
    setConsent(false);
    setUnknownConsent({});
    setSurplusConsent({});
    setProfileConsent(false);
    setError('');
    setStatus('');
  }
  function clearSensitive() {
    setContent('');
    setFileName('');
    setNote('');
    setTargets([]);
    setDefinition(initialDefinition());
    setResolutionsText('[]');
    setDistributionDrafts([]);
    setDistributionMode('form');
    setHelperProducts({});
    setReview(null);
    setConsent(false);
    setUnknownConsent({});
    setSurplusConsent({});
    setProfiles([]);
    setProfileId('');
    setProfileName('');
    setProfileConsent(false);
    if (fileRef.current) fileRef.current.value = '';
  }
  function purge() {
    ++epoch.current;
    ++readId.current;
    authorized.current = null;
    localBusy.current = false;
    setBlocked(true);
    setFlags(null);
    setOptions(null);
    setWarehouses([]);
    setWarehouseCursor(null);
    clearSensitive();
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
    setBusy(false);
    resetStockFileImportContext(actor.current);
  }
  function accept(d: Flags) {
    if (!d.can_read) {
      purge();
      return false;
    }
    const old = flagsRef.current;
    if (old?.current_role && old.current_role !== d.current_role) {
      purge();
      return false;
    }
    if (
      old &&
      ((old.can_read_value && !d.can_read_value) ||
        (old.can_write && (!d.can_write || d.read_only)))
    ) {
      clearSensitive();
      setHistory([]);
      setHistoryLoaded(false);
      resetStockFileImportContext(actor.current);
    }
    authorized.current = scope.current;
    flagsRef.current = d;
    setFlags(d);
    return d.available;
  }
  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    const message =
      err instanceof Error ? err.message : 'Nie udało się wykonać operacji importu pomiarów.';
    setError(message);
    onError?.(message);
    if (err instanceof ApiError && [401, 403].includes(err.status)) purge();
    else if (err instanceof ApiError && err.status === 423) {
      setWriteBlocked(true);
      clearSensitive();
      resetStockFileImportContext(actor.current);
      setFlags((f) => (f ? { ...f, can_write: false, read_only: true } : f));
    }
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    const s = scope.current;
    try {
      const d = await api<T>(prefix + path, method, body);
      if (e !== epoch.current || s !== scope.current)
        throw new DOMException('Zmieniono kontekst.', 'AbortError');
      return d;
    } catch (err) {
      if (e !== epoch.current || s !== scope.current)
        throw new DOMException('Zmieniono kontekst.', 'AbortError');
      throw err;
    }
  }
  async function read(task: (e: number) => Promise<void>) {
    if (localBusy.current || retained.inFlight || blocked) return;
    const e = epoch.current,
      id = ++readId.current;
    localBusy.current = true;
    setBusy(true);
    setError('');
    try {
      await task(e);
    } catch (err) {
      if (e === epoch.current) fail(err);
    } finally {
      if (e === epoch.current && id === readId.current) {
        localBusy.current = false;
        setBusy(false);
      }
    }
  }
  async function optionsPage(e: number, cursor?: string) {
    const d = await request<Options>(
      '/options' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
      e,
    );
    if (!accept(d) && (d.available || !d.can_read))
      throw new DOMException('Dostęp został zmieniony.', 'AbortError');
    return d;
  }
  async function loadOptions(e: number, cursor?: string) {
    const d = await optionsPage(e, cursor);
    setOptions(d);
    if (!d.available || !d.can_read) return;
    setWarehouses((old) =>
      cursor
        ? [...old.filter((w) => !d.warehouses.some((next) => next.id === w.id)), ...d.warehouses]
        : d.warehouses,
    );
    setWarehouseCursor(d.next_cursor);
  }
  async function allWarehouses(e: number): Promise<Warehouse[]> {
    const all: Warehouse[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const d: Options = await optionsPage(e, cursor ?? undefined);
      if (!d.available) throw new Error('Moduł importu jest niedostępny.');
      all.push(...d.warehouses);
      if (
        all.length > 2000 ||
        new Set(all.map((w) => w.id)).size !== all.length ||
        (d.next_cursor && seen.has(d.next_cursor))
      )
        throw new Error('Nie można potwierdzić kompletnych stron magazynów.');
      cursor = d.next_cursor;
      if (cursor) seen.add(cursor);
      setOptions(d);
    } while (cursor);
    setWarehouses(all);
    setWarehouseCursor(null);
    return all;
  }
  async function loadProfiles(e: number) {
    const all: Profile[] = [],
      seen = new Set<string>();
    let cursor: string | null = null,
      total = 0;
    do {
      const d: Collection<Profile> = await request<Collection<Profile>>(
        '/profiles' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        e,
      );
      if (!accept(d)) return;
      if (d.total > 100 || (all.length && d.total !== total))
        throw new Error('Zakres profili zmienił się podczas odczytu.');
      total = d.total;
      all.push(...d.data);
      if (all.length > 100 || (d.next_cursor && seen.has(d.next_cursor)))
        throw new Error('Nie można potwierdzić pełnej listy profili.');
      cursor = d.next_cursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (all.length !== total || new Set(all.map((p) => p.id)).size !== all.length)
      throw new Error('Nie odczytano pełnej listy profili.');
    setProfiles(all);
  }
  async function loadReview(kind: Review['kind'], id: string, e: number) {
    const base = `/${kind === 'preview' ? 'previews' : 'executions'}/${encodeURIComponent(id)}`;
    const d = await request<Reply>(base, e);
    if (!accept(d)) return;
    const head = kind === 'preview' ? d.preview : d.execution;
    if (
      !head ||
      !Number.isInteger(head.summary.positions) ||
      head.summary.positions < 0 ||
      head.summary.positions > 4000 ||
      head.targets.length < 1 ||
      head.targets.length > 8 ||
      new Set(head.targets.map((t) => t.warehouse_id)).size !== head.targets.length
    )
      throw new Error('Nie odczytano pełnego nagłówka importu.');
    setReview({ kind, head, rows: [], complete: false });
    setConsent(false);
    setUnknownConsent({});
    setSurplusConsent({});
    const rows: Row[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const p: RowsReply = await request<RowsReply>(
        base + '/rows' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        e,
      );
      if (!accept(p)) return;
      if (p.total !== head.summary.positions || p.rows.length > 50)
        throw new Error('Strony nie odpowiadają pełnemu nagłówkowi.');
      rows.push(...p.rows);
      if (rows.length > 4000 || (p.next_cursor && seen.has(p.next_cursor)))
        throw new Error('Nie można potwierdzić pełnego zakresu pozycji.');
      cursor = p.next_cursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (
      rows.length !== head.summary.positions ||
      new Set(rows.map((r) => r.index)).size !== rows.length ||
      rows.some((r) => !head.targets.some((t) => t.warehouse_id === r.warehouse_id)) ||
      head.targets.some(
        (t) => rows.filter((r) => r.warehouse_id === t.warehouse_id).length !== t.summary.positions,
      )
    )
      throw new Error('Brak pozycji lub niespójny zakres magazynów. Zatwierdzenie zablokowane.');
    setReview({ kind, head, rows, complete: true });
  }
  async function loadHistory(e: number, more = false) {
    const d = await request<Collection<Head>>(
      `/${historyKind}` +
        (more && historyCursor ? `?cursor=${encodeURIComponent(historyCursor)}` : ''),
      e,
    );
    if (!accept(d)) return;
    if (d.total > 2000) throw new Error('Historia przekracza obsługiwany zakres.');
    setHistory((old) =>
      more ? [...old.filter((h) => !d.data.some((n) => n.id === h.id)), ...d.data] : d.data,
    );
    setHistoryCursor(d.next_cursor);
    setHistoryLoaded(true);
  }
  useEffect(() => {
    const sync = () => {
      setPending(retained.context === contextKey ? retained.attempt : null);
      setRemoteBusy(retained.context === contextKey && retained.inFlight);
    };
    if (retained.context !== contextKey || readOnly) resetStockFileImportContext(contextKey);
    listeners.add(sync);
    sync();
    const e = ++epoch.current;
    stateScope.current = scope.current;
    ++readId.current;
    localBusy.current = true;
    authorized.current = null;
    flagsRef.current = null;
    setFlags(null);
    setOptions(null);
    setWarehouses([]);
    setWarehouseCursor(null);
    clearSensitive();
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
    setError('');
    setStatus('');
    setBlocked(false);
    setWriteBlocked(false);
    setBusy(true);
    void loadOptions(e)
      .catch((err) => {
        if (e === epoch.current) fail(err);
      })
      .finally(() => {
        if (e === epoch.current) {
          localBusy.current = false;
          setBusy(false);
        }
      });
    return () => {
      listeners.delete(sync);
      ++epoch.current;
      ++readId.current;
      localBusy.current = false;
    };
  }, [contextKey, readOnly]);
  useEffect(() => {
    onLockedChange?.(locked);
    return () => onLockedChange?.(getStockFileImportLock(contextKey));
  }, [locked, onLockedChange, contextKey]);
  async function submit(a: Attempt) {
    if (
      !authorizedWritable ||
      (externalWriteBlocked && retained.attempt !== a) ||
      localBusy.current ||
      retained.inFlight ||
      (retained.attempt && retained.attempt !== a) ||
      a.context !== contextKey
    )
      return;
    retained.context = contextKey;
    retained.attempt = a;
    retained.inFlight = true;
    publish();
    const e = epoch.current;
    setError('');
    setStatus('');
    try {
      const d = await request<Reply>(a.path, e, a.method, JSON.parse(a.serialized));
      if (!accept(d)) return;
      if (a.kind === 'profile') {
        if (!d.profile?.id)
          throw new Error('Brak identyfikatora profilu w odpowiedzi. Zachowano dokładną próbę.');
        if (retained.attempt === a) {
          retained.attempt = null;
          publish();
        }
        setProfileId(d.profile.id);
        setProfileName(d.profile.name);
        setProfileConsent(false);
        setStatus(
          d.reused
            ? 'Odczytano wcześniejszy zapis profilu. Przed użyciem odczytaj bieżący profil.'
            : 'Profil mapowania zapisany.',
        );
        await loadProfiles(e);
      } else {
        const kind = a.kind === 'execute' ? 'execution' : 'preview',
          head = kind === 'execution' ? d.execution : d.preview;
        if (!head?.id)
          throw new Error('Nie otrzymano trwałego identyfikatora. Zachowano dokładną próbę.');
        if (retained.attempt === a) {
          retained.attempt = null;
          publish();
        }
        await loadReview(kind, head.id, e);
        setStatus(
          kind === 'execution'
            ? d.reused
              ? 'Odczytano wcześniejszy wynik. Nie zaksięgowano pomiarów ponownie.'
              : 'Zaksięgowano cały import pomiarów we wszystkich wybranych magazynach.'
            : 'Odczytano trwały podgląd. Sprawdź wszystkie pozycje i błędy.',
        );
        if (kind === 'execution') onApplied?.();
      }
    } catch (err) {
      if (e !== epoch.current) return;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        if (retained.attempt === a) {
          retained.attempt = null;
          publish();
        }
        if (err.status === 409 && a.kind === 'execute')
          setReview((r) => (r ? { ...r, head: { ...r.head, can_execute: false } } : r));
        setConsent(false);
        setUnknownConsent({});
        setSurplusConsent({});
        fail(err);
      } else {
        fail(err);
        if (retained.attempt === a)
          setStatus(
            'Wynik zapisu jest nieznany. Zachowano dokładne żądanie; nowe zapisy pozostają zablokowane.',
          );
      }
    } finally {
      if (retained.context === a.context && (retained.attempt === a || !retained.attempt)) {
        retained.inFlight = false;
        publish();
      }
    }
  }
  function attempt(
    kind: Attempt['kind'],
    path: string,
    body: unknown,
    label: string,
    method: Attempt['method'] = 'POST',
  ) {
    if (writeDisabled || retained.attempt || retained.inFlight) return;
    void submit({
      context: contextKey,
      kind,
      path,
      method,
      serialized: JSON.stringify(body),
      label,
    });
  }
  function configure(next: Definition) {
    invalidate();
    setDefinition(next);
    if (next.format === 'xml' && next.xml_mode === 'catalog')
      setTargets((old) =>
        old.map((t) => ({
          ...t,
          quantity_scope: 'warehouse_total',
          mapping: { ...t.mapping, quantity: 'inventory_json' },
        })),
      );
  }
  function updateTarget(id: string, patch: Partial<Target>) {
    invalidate();
    setTargets((old) => old.map((t) => (t.warehouse_id === id ? { ...t, ...patch } : t)));
  }
  function editDistribution(id: string, patch: Partial<DistributionDraft>) {
    if (writeDisabled || distributionMode !== 'form') return;
    invalidate();
    const changesBasis = patch.warehouse_id !== undefined || patch.row_number !== undefined;
    if (changesBasis) {
      setHelperProducts((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
    }
    setDistributionDrafts((old) =>
      old.map((d) =>
        d.id === id
          ? {
              ...d,
              ...patch,
              ...(changesBasis
                ? {
                    positions: (patch.positions ?? d.positions).map((p) =>
                      p.lot_kind === 'existing' ? { ...p, lot_id: '' } : p,
                    ),
                  }
                : {}),
            }
          : d,
      ),
    );
  }
  function selectHelperProduct(
    groupId: string,
    expectedScope: string,
    warehouse: string,
    row: string,
    candidate: unknown,
  ) {
    if (editorBlocked.current || helperScopeRef.current !== expectedScope) return;
    const currentDraft = draftsRef.current.find((d) => d.id === groupId);
    if (!currentDraft || currentDraft.warehouse_id !== warehouse || currentDraft.row_number !== row)
      return;
    let product: HelperProduct | null = null;
    if (candidate !== undefined && candidate !== null) {
      if (typeof candidate !== 'object') return;
      const p = candidate as Record<string, unknown>;
      if (
        typeof p.id !== 'string' ||
        !uuid.test(p.id) ||
        typeof p.sku !== 'string' ||
        typeof p.name !== 'string' ||
        (p.kind !== 'simple' && p.kind !== 'variant')
      )
        return;
      product = { id: p.id, sku: p.sku, name: p.name, kind: p.kind };
    }
    invalidate();
    setHelperProducts((old) => {
      const next = { ...old };
      if (product) next[groupId] = { scope: expectedScope, product };
      else delete next[groupId];
      return next;
    });
    setDistributionDrafts((old) =>
      old.map((d) =>
        d.id === groupId
          ? {
              ...d,
              positions: d.positions.map((p) =>
                p.lot_kind === 'existing' ? { ...p, lot_id: '' } : p,
              ),
            }
          : d,
      ),
    );
  }
  function editPosition(groupId: string, positionId: string, patch: Partial<PositionDraft>) {
    if (writeDisabled || distributionMode !== 'form') return;
    invalidate();
    setDistributionDrafts((old) =>
      old.map((d) =>
        d.id === groupId
          ? {
              ...d,
              positions: d.positions.map((p) =>
                p.id === positionId
                  ? {
                      ...p,
                      ...patch,
                      ...(patch.location !== undefined &&
                      patch.location !== p.location &&
                      p.lot_kind === 'existing'
                        ? { lot_id: '' }
                        : {}),
                    }
                  : p,
              ),
            }
          : d,
      ),
    );
  }
  function currentResolutions(): Resolution[] {
    if (!options) throw new Error('Najpierw odczytaj aktualną politykę i magazyny.');
    return distributionMode === 'json'
      ? parseResolutions(resolutionsText, targets, options.policy, options.limits)
      : formResolutions(distributionDrafts, targets, options.policy, options.limits);
  }
  async function upload(file: File) {
    if (writeDisabled || !options) return;
    const e = epoch.current,
      s = scope.current,
      id = ++readId.current;
    localBusy.current = true;
    setBusy(true);
    invalidate();
    try {
      if (file.size > options.limits.file_bytes)
        throw new Error('Plik przekracza 2 MiB. Nie obcięto treści.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer(),
      );
      if (e !== epoch.current || s !== scope.current || externalLock.current) return;
      if (bytes(text) > options.limits.file_bytes) throw new Error('Treść przekracza 2 MiB.');
      setContent(text);
      setFileName(file.name);
    } catch (err) {
      if (e === epoch.current) fail(err);
    } finally {
      if (e === epoch.current && id === readId.current) {
        localBusy.current = false;
        setBusy(false);
      }
    }
  }
  function preview() {
    try {
      if (!options || !targets.length || !content.trim() || note.trim().length < 3)
        throw new Error(
          'Wybierz magazyny, wczytaj plik i podaj uzasadnienie (co najmniej 3 znaki).',
        );
      if (bytes(content) > options.limits.file_bytes) throw new Error('Treść przekracza 2 MiB.');
      const resolutions = currentResolutions();
      const body = {
        client_key: crypto.randomUUID(),
        file_name: fileName || 'tekst-wklejony',
        content,
        note: note.trim(),
        definition: { ...definition },
        targets: targets
          .map(copyTarget)
          .sort((a, b) => a.warehouse_id.localeCompare(b.warehouse_id)),
        resolutions,
      };
      if (bytes(JSON.stringify(body)) > options.limits.request_bytes)
        throw new Error('Żądanie przekracza 6 MiB. Nie wysłano częściowego zakresu.');
      attempt('preview', '/previews', body, 'Utworzenie podglądu pomiarów stanów');
    } catch (err) {
      fail(err);
    }
  }
  function requiredAcks(head: Head) {
    if (
      head.policy.enabled &&
      head.targets.some(
        (t) =>
          t.summary.unknown_loss_quantity === undefined || t.summary.surplus_quantity === undefined,
      )
    )
      throw new Error('Brak pełnych danych zgody kosztowej. Zatwierdzenie zablokowane.');
    return {
      unknown: head.targets
        .filter((t) => (t.summary.unknown_loss_quantity ?? 0) > 0)
        .map((t) => t.warehouse_id)
        .sort(),
      surplus: head.targets
        .filter((t) => (t.summary.surplus_quantity ?? 0) > 0)
        .map((t) => t.warehouse_id)
        .sort(),
    };
  }
  function execute() {
    if (
      !review ||
      review.kind !== 'preview' ||
      !review.complete ||
      !review.head.can_execute ||
      !consent ||
      review.head.summary.invalid ||
      review.head.summary.conflicts
    )
      return;
    try {
      const ack = requiredAcks(review.head);
      if (
        ack.unknown.some((id) => !unknownConsent[id]) ||
        ack.surplus.some((id) => !surplusConsent[id])
      )
        return;
      attempt(
        'execute',
        `/previews/${encodeURIComponent(review.head.id)}/execute`,
        {
          client_key: crypto.randomUUID(),
          scope_hash: review.head.scope_hash,
          confirmed: true,
          ack_unknown_loss_warehouse_ids: ack.unknown,
          ack_surplus_warehouse_ids: ack.surplus,
        },
        'Zatwierdzenie całego importu pomiarów',
      );
    } catch (err) {
      fail(err);
    }
  }
  async function applyProfile(e: number) {
    if (!profileId || writeDisabled) return;
    const d = await request<Reply>(`/profiles/${encodeURIComponent(profileId)}`, e);
    if (!accept(d) || !d.profile) return;
    const p = d.profile;
    if (
      !p.targets.length ||
      p.targets.length > 8 ||
      new Set(p.targets.map((t) => t.warehouse_id)).size !== p.targets.length
    )
      throw new Error('Profil nie zawiera poprawnego pełnego zakresu magazynów.');
    const current = await allWarehouses(e);
    if (externalLock.current || !flagsRef.current?.can_write || flagsRef.current.read_only) return;
    if (p.targets.some((t) => !current.some((w) => w.id === t.warehouse_id)))
      throw new Error('Magazyn z profilu nie jest dostępny. Nie zastosowano części profilu.');
    invalidate();
    setDefinition({ ...p.definition });
    setTargets(p.targets.map(copyTarget));
    setResolutionsText('[]');
    setProfileId(p.id);
    setProfileName(p.name);
    setProfiles((old) => [...old.filter((v) => v.id !== p.id), p]);
    setTab('import');
    setStatus(
      'Zastosowano bieżący profil po odczycie magazynów i polityki WMS. Jawne rozkłady usunięto; sprawdź je dla tego pliku.',
    );
  }
  function saveProfile(update: boolean) {
    if (!targets.length || !profileName.trim() || (update && (!profile || !profileConsent))) return;
    const body = {
      client_key: crypto.randomUUID(),
      name: profileName.trim(),
      definition: { ...definition },
      targets: targets.map(copyTarget).sort((a, b) => a.warehouse_id.localeCompare(b.warehouse_id)),
      ...(update && profile ? { version: profile.version } : {}),
    };
    attempt(
      'profile',
      update && profile ? `/profiles/${encodeURIComponent(profile.id)}` : '/profiles',
      body,
      update ? 'Aktualizacja profilu pomiarów' : 'Zapis nowego profilu pomiarów',
      update ? 'PATCH' : 'POST',
    );
  }
  const ackDataComplete =
    !review?.head.policy.enabled ||
    review.head.targets.every(
      (t) =>
        t.summary.unknown_loss_quantity !== undefined && t.summary.surplus_quantity !== undefined,
    );
  const ready =
    !!review?.complete &&
    !!review.head.can_execute &&
    !review.head.summary.invalid &&
    !review.head.summary.conflicts &&
    ackDataComplete;
  const ackMissing = !!review?.head.targets.some(
    (t) =>
      ((t.summary.unknown_loss_quantity ?? 0) > 0 && !unknownConsent[t.warehouse_id]) ||
      ((t.summary.surplus_quantity ?? 0) > 0 && !surplusConsent[t.warehouse_id]),
  );
  return (
    <section className="stock-file-import panel" aria-label="Import pomiarów stanów">
      <h2>Import pomiarów stanów z CSV / XML</h2>
      <p>
        Jeden plik i jawnie wybrane własne magazyny. Ilość oznacza policzony towar fizyczny;
        rezerwacje i dostępność pozostają oddzielne. Jeden błąd blokuje całą partię.
      </p>
      {stateScope.current === scope.current && error && (
        <p className="sfi-error" role="alert">
          {error}
        </p>
      )}
      {status && readable && (
        <p className="sfi-status" role="status">
          {status}
        </p>
      )}
      {pending && retained.context === contextKey && (
        <div className="sfi-pending" role="status">
          <strong>
            {remoteBusy ? 'Żądanie w toku' : 'Nieznany wynik zapisu'}: {pending.label}
          </strong>
          <p>
            Zachowano dokładne dane i klucz próby. Nowe zapisy są zablokowane. Odczyt historii nie
            usuwa próby. Przeładowanie strony usuwa RAM — wtedy najpierw sprawdź trwałą historię.
          </p>
          <button
            className="button primary"
            disabled={!authorizedWritable || busy || remoteBusy}
            onClick={() => void submit(pending)}
          >
            Ponów dokładnie tę próbę
          </button>
        </div>
      )}
      {busy && <p role="status">Odczyt / przetwarzanie…</p>}
      {!readable ? (
        <>
          <p>
            {blocked
              ? 'Dostęp został odebrany; dane importu usunięto z widoku.'
              : options && !options.available
                ? 'Import pomiarów nie jest dostępny w tej wersji danych.'
                : 'Odczytywanie dostępności importu…'}
          </p>
          {!options && !blocked && (
            <button
              className="button"
              disabled={busy || remoteBusy}
              onClick={() => void read((e) => loadOptions(e))}
            >
              Odczytaj dostępność ponownie
            </button>
          )}
        </>
      ) : (
        <>
          {!authorizedWritable && (
            <p className="sfi-hint">
              Tryb odczytu: dostępna historia i profile. Nowe podglądy i księgowanie wymagają
              aktualnych uprawnień.
            </p>
          )}
          {externalWriteBlocked && (
            <p className="sfi-hint">
              Nowe zapisy i konfiguracja są zablokowane do czasu rozstrzygnięcia operacji w
              powiązanym panelu. Własna dokładna próba pozostaje dostępna do ręcznego retry.
            </p>
          )}
          <p className="sfi-hint">
            WMS:{' '}
            {options?.policy.enabled
              ? `włączony · wersja ${options.policy.version} · koszty netto w ${options.policy.currency}`
              : 'wyłączony · pomiary ilości i lokalizacji'}
            . Import nie tworzy zakupu ani fikcyjnego przyjęcia PZ i nie zmienia PIM/cenników.
          </p>
          <nav className="sfi-toolbar" aria-label="Proces importu pomiarów">
            {(['import', 'profiles', 'history'] as const).map((t) => (
              <button
                key={t}
                className={`button ${tab === t ? 'primary' : ''}`}
                disabled={busy || remoteBusy}
                onClick={() => setTab(t)}
              >
                {t === 'import'
                  ? 'Plik i pomiary'
                  : t === 'profiles'
                    ? 'Profile mapowania'
                    : 'Historia'}
              </button>
            ))}
          </nav>
          {tab === 'import' && (
            <>
              <fieldset disabled={writeDisabled}>
                <legend>1. Plik i tożsamość produktu</legend>
                <div className="sfi-grid">
                  <label>
                    Format
                    <select
                      value={definition.format === 'csv' ? 'csv' : definition.xml_mode}
                      onChange={(e) =>
                        configure(
                          e.target.value === 'csv'
                            ? { ...definition, format: 'csv' }
                            : {
                                ...definition,
                                format: 'xml',
                                xml_mode: e.target.value as Definition['xml_mode'],
                              },
                        )
                      }
                    >
                      <option value="csv">CSV pomiarów</option>
                      <option value="positions">XML pomiarów</option>
                      <option value="catalog">XML katalogu · jawny rozkład sum</option>
                    </select>
                  </label>
                  <label>
                    Rozpoznawanie produktu
                    <select
                      value={definition.identity}
                      onChange={(e) =>
                        configure({
                          ...definition,
                          identity: e.target.value as Definition['identity'],
                        })
                      }
                    >
                      <option value="uuid">ID produktu (UUID)</option>
                      <option value="sku">Aktualne SKU</option>
                      <option value="historical_sku">SKU z wcześniejszymi kodami</option>
                      <option value="ean">EAN</option>
                      <option value="name">Nazwa</option>
                    </select>
                  </label>
                  <label>
                    Pole identyfikatora
                    <input
                      value={definition.identity_field}
                      onChange={(e) => configure({ ...definition, identity_field: e.target.value })}
                    />
                  </label>
                  {definition.format === 'csv' && (
                    <label>
                      Separator kolumn
                      <select
                        value={definition.delimiter}
                        onChange={(e) =>
                          configure({
                            ...definition,
                            delimiter: e.target.value as Definition['delimiter'],
                          })
                        }
                      >
                        <option value=";">Średnik (;)</option>
                        <option value=",">Przecinek (,)</option>
                        <option value={'\t'}>Tabulator</option>
                      </select>
                    </label>
                  )}
                  <label>
                    Puste pomiary
                    <select
                      value={definition.empty_policy}
                      onChange={(e) =>
                        configure({
                          ...definition,
                          empty_policy: e.target.value as Definition['empty_policy'],
                        })
                      }
                    >
                      <option value="skip">Pomiń · zachowaj stan</option>
                      <option value="error">Błąd · wymagaj pomiaru</option>
                    </select>
                  </label>
                  <label>
                    Plik UTF-8 · maks. 2 MiB
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".csv,.xml,text/csv,application/xml,text/xml"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void upload(file);
                      }}
                    />
                  </label>
                  <label>
                    Nazwa pliku
                    <input
                      maxLength={120}
                      value={fileName}
                      onChange={(e) => {
                        invalidate();
                        setFileName(e.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Uzasadnienie pomiaru
                    <input
                      maxLength={500}
                      value={note}
                      onChange={(e) => {
                        invalidate();
                        setNote(e.target.value);
                      }}
                      placeholder="np. Fizyczne przeliczenie magazynu"
                    />
                  </label>
                </div>
                {definition.format === 'csv' && (
                  <label className="sfi-check">
                    <input
                      type="checkbox"
                      checked={definition.spreadsheet_safe}
                      onChange={(e) =>
                        configure({ ...definition, spreadsheet_safe: e.target.checked })
                      }
                    />
                    CSV z eksportu „dla arkusza”: rozpoznaj ochronne apostrofy. Wyłącz dla
                    dokładnego tekstu innego źródła.
                  </label>
                )}
                <label>
                  Treść pliku
                  <textarea
                    rows={7}
                    value={content}
                    onChange={(e) => {
                      invalidate();
                      setContent(e.target.value);
                    }}
                  />
                </label>
                <small>
                  {bytes(content).toLocaleString('pl-PL')} bajtów · maks. 500 wierszy źródła / 500
                  produktów / 4000 pozycji / 10000 warstw. Nadmiar jest błędem, bez obcinania.
                </small>
                {definition.format === 'xml' && definition.xml_mode === 'positions' && (
                  <p className="sfi-hint">
                    XML pomiarów ma korzeń dynaminds-stock-counts version="1", elementy row i
                    tekstowe field name="…". Mapuj rzeczywiste nazwy pól; nie XPath.
                  </p>
                )}
                {catalogMode && (
                  <p className="sfi-hint">
                    XML katalogu odczytuje fizyczne on_hand z inventory_json wybranych magazynów.
                    Każda suma wymaga jawnego rozkładu poniżej, także przy jednym binie.
                    Missing/null, zestawy i dostępność hurtowni nie stają się zerem.
                  </p>
                )}
              </fieldset>
              <fieldset disabled={writeDisabled}>
                <legend>2. Własne magazyny · wybrano {targets.length} / 8</legend>
                <div className="sfi-choices">
                  {warehouses.map((w) => (
                    <label className="sfi-check" key={w.id}>
                      <input
                        type="checkbox"
                        checked={targets.some((t) => t.warehouse_id === w.id)}
                        disabled={
                          !targets.some((t) => t.warehouse_id === w.id) && targets.length >= 8
                        }
                        onChange={(e) => {
                          invalidate();
                          setTargets((old) =>
                            e.target.checked
                              ? [
                                  ...old,
                                  {
                                    warehouse_id: w.id,
                                    quantity_scope: catalogMode
                                      ? ('warehouse_total' as const)
                                      : ('position' as const),
                                    mapping: {
                                      quantity: catalogMode ? 'inventory_json' : 'quantity',
                                    },
                                    default_location: null,
                                  },
                                ].sort((a, b) => a.warehouse_id.localeCompare(b.warehouse_id))
                              : old.filter((t) => t.warehouse_id !== w.id),
                          );
                        }}
                      />
                      <span>
                        {w.name} · {w.code}
                        <small>{w.id}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="sfi-toolbar">
                <button
                  className="button"
                  disabled={locked || !warehouseCursor}
                  onClick={() => void read((e) => loadOptions(e, warehouseCursor ?? undefined))}
                >
                  Dalsze magazyny
                </button>
                <button
                  className="button"
                  disabled={writeDisabled}
                  onClick={() =>
                    void read(async (e) => {
                      await allWarehouses(e);
                      invalidate();
                      setStatus(
                        'Odczytano aktualne magazyny i politykę. Sprawdź wszystkie mapowania i rozkłady.',
                      );
                    })
                  }
                >
                  Odczytaj aktualną politykę i magazyny
                </button>
              </div>
              {targets.map((target) => {
                const warehouse = warehouses.find((w) => w.id === target.warehouse_id);
                const map = (key: keyof Mapping, value: string) => {
                  const next = { ...target.mapping };
                  if (value || key === 'quantity') next[key] = value;
                  else delete next[key];
                  updateTarget(target.warehouse_id, { mapping: next });
                };
                return (
                  <fieldset key={target.warehouse_id} disabled={writeDisabled}>
                    <legend>{warehouse?.name ?? target.warehouse_id} · mapowanie</legend>
                    <div className="sfi-grid">
                      <label>
                        Zakres ilości
                        <select
                          disabled={catalogMode}
                          value={target.quantity_scope}
                          onChange={(e) =>
                            updateTarget(target.warehouse_id, {
                              quantity_scope: e.target.value as Target['quantity_scope'],
                            })
                          }
                        >
                          <option value="position">Konkretny bin / partia</option>
                          <option value="warehouse_total">
                            Suma całego magazynu · wymagany rozkład
                          </option>
                        </select>
                      </label>
                      <label>
                        Pole ilości
                        <input
                          disabled={catalogMode}
                          value={target.mapping.quantity}
                          onChange={(e) => map('quantity', e.target.value)}
                        />
                      </label>
                      <label>
                        Pole lokalizacji (opcjonalne)
                        <input
                          value={target.mapping.location ?? ''}
                          onChange={(e) => map('location', e.target.value)}
                        />
                      </label>
                      <label>
                        Jawna lokalizacja, gdy nie ma pola
                        <input
                          value={target.default_location ?? ''}
                          onChange={(e) =>
                            updateTarget(target.warehouse_id, {
                              default_location: e.target.value || null,
                            })
                          }
                          placeholder="Nie wybrano"
                        />
                      </label>
                      <label>
                        Pole operacji (count / none)
                        <input
                          value={target.mapping.operation ?? ''}
                          onChange={(e) => map('operation', e.target.value)}
                        />
                      </label>
                      {options?.policy.enabled && (
                        <>
                          <label>
                            Pole ID istniejącej partii
                            <input
                              value={target.mapping.lot_id ?? ''}
                              onChange={(e) => map('lot_id', e.target.value)}
                            />
                          </label>
                          <label>
                            Pole kodu nowej partii
                            <input
                              value={target.mapping.lot_code ?? ''}
                              onChange={(e) => map('lot_code', e.target.value)}
                            />
                          </label>
                          <label>
                            Pole daty ważności
                            <input
                              value={target.mapping.expiry_date ?? ''}
                              onChange={(e) => map('expiry_date', e.target.value)}
                            />
                          </label>
                          <label>
                            Pole kosztu netto w najmniejszej jednostce
                            <input
                              value={target.mapping.unit_cost_minor ?? ''}
                              onChange={(e) => map('unit_cost_minor', e.target.value)}
                            />
                          </label>
                          <label>
                            Pole waluty kosztu
                            <input
                              value={target.mapping.currency ?? ''}
                              onChange={(e) => map('currency', e.target.value)}
                            />
                          </label>
                        </>
                      )}
                    </div>
                  </fieldset>
                );
              })}
              <fieldset disabled={writeDisabled}>
                <legend>3. Rozłożenie pomiarów na lokalizacje i partie</legend>
                <p>
                  Dla każdej sumy magazynu wskaż wiersz danych i wszystkie rzeczywiste miejsca
                  przechowywania. Pierwszy wiersz danych ma numer 1, bez nagłówka CSV. Dodaj osobną
                  pozycję dla każdej lokalizacji i partii, także zarezerwowanej lub zerowej. Nie
                  rozdzielamy ilości automatycznie. Przy bezpośrednich pomiarach pozycji rozkład
                  może pozostać pusty, jeśli wszystkie decyzje zawiera plik.
                </p>
                {options?.policy.enabled && (
                  <p className="sfi-hint">
                    Wybierz pomocniczo własny produkt odpowiadający wierszowi pliku, aby odczytać
                    nazwy jego partii. Ten wybór nie zmienia tożsamości pozycji importu i nie jest
                    wysyłany w rozkładzie pomiarów. Podgląd importu sprawdzi zgodność z plikiem.
                    Ilość, lokalizację oraz ewentualny nowy koszt wskaż samodzielnie.
                  </p>
                )}
                {distributionMode === 'json' && (
                  <p className="sfi-hint">
                    Aktywny jest rozkład JSON z opcji zaawansowanych. Formularz poniżej nie zostanie
                    wysłany.
                  </p>
                )}
                <fieldset
                  className="sfi-distribution-editor"
                  disabled={distributionMode !== 'form'}
                >
                  <legend>Decyzje o rzeczywistym rozmieszczeniu</legend>
                  {distributionDrafts.map((draft, groupIndex) => {
                    const helper =
                      helperProducts[draft.id]?.scope === helperScope
                        ? helperProducts[draft.id].product
                        : null;
                    const ownWarehouse =
                      uuid.test(draft.warehouse_id) &&
                      targets.some((t) => t.warehouse_id === draft.warehouse_id) &&
                      warehouses.some((w) => w.id === draft.warehouse_id);
                    return (
                      <article className="sfi-distribution" key={draft.id}>
                        <h4>Pomiar {groupIndex + 1}</h4>
                        <div className="sfi-grid">
                          <label>
                            Wiersz danych w pliku
                            <input
                              inputMode="numeric"
                              value={draft.row_number}
                              placeholder="np. 1"
                              onChange={(e) =>
                                editDistribution(draft.id, { row_number: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            Magazyn pomiaru
                            <select
                              value={draft.warehouse_id}
                              onChange={(e) =>
                                editDistribution(draft.id, { warehouse_id: e.target.value })
                              }
                            >
                              <option value="">Wybierz wybrany wcześniej magazyn</option>
                              {draft.warehouse_id &&
                                !targets.some((t) => t.warehouse_id === draft.warehouse_id) && (
                                  <option value={draft.warehouse_id}>
                                    Magazyn nie jest już wybrany — zmień wybór
                                  </option>
                                )}
                              {targets.map((t) => {
                                const w = warehouses.find((item) => item.id === t.warehouse_id);
                                return (
                                  <option key={t.warehouse_id} value={t.warehouse_id}>
                                    {w ? `${w.name} · ${w.code}` : t.warehouse_id}
                                  </option>
                                );
                              })}
                            </select>
                          </label>
                        </div>
                        {options?.policy.enabled && (
                          <div className="sfi-lot-product-helper">
                            {ownWarehouse ? (
                              <>
                                <ProductPicker
                                  key={JSON.stringify([
                                    helperScope,
                                    draft.id,
                                    draft.warehouse_id,
                                    draft.row_number,
                                  ])}
                                  label="Produkt pomocniczy do odczytu partii"
                                  value={helper?.id ?? ''}
                                  initial={helper ?? undefined}
                                  filter={(p) =>
                                    !!p &&
                                    typeof p.id === 'string' &&
                                    uuid.test(p.id) &&
                                    (p.kind === 'simple' || p.kind === 'variant')
                                  }
                                  select={(p) =>
                                    selectHelperProduct(
                                      draft.id,
                                      helperScope,
                                      draft.warehouse_id,
                                      draft.row_number,
                                      p,
                                    )
                                  }
                                />
                                {helper && (
                                  <button
                                    className="button"
                                    type="button"
                                    onClick={() =>
                                      selectHelperProduct(
                                        draft.id,
                                        helperScope,
                                        draft.warehouse_id,
                                        draft.row_number,
                                        null,
                                      )
                                    }
                                  >
                                    Wyczyść pomocniczy wybór produktu
                                  </button>
                                )}
                              </>
                            ) : (
                              <p>Najpierw wybierz własny magazyn pomiaru z odczytanej listy.</p>
                            )}
                            <p>
                              Pomocniczy produkt musi odpowiadać temu wierszowi pliku. Zmiana
                              produktu, magazynu lub numeru wiersza usuwa wybór istniejących partii.
                              Nie pobieramy automatycznie ilości, lokalizacji ani kosztów do
                              formularza. Lista partii dotyczy wpisanej lokalizacji; puste pole
                              oznacza miejsce przechowywania bez nazwy.
                            </p>
                          </div>
                        )}
                        {draft.positions.map((position, positionIndex) => (
                          <div className="sfi-position-editor" key={position.id}>
                            <h4>Miejsce przechowywania {positionIndex + 1}</h4>
                            <div className="sfi-grid">
                              <label>
                                Lokalizacja
                                <input
                                  value={position.location}
                                  placeholder="np. A-01"
                                  onChange={(e) =>
                                    editPosition(draft.id, position.id, {
                                      location: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Policzona ilość (szt.)
                                <input
                                  inputMode="numeric"
                                  value={position.quantity}
                                  placeholder="Wpisz pomiar, także 0"
                                  onChange={(e) =>
                                    editPosition(draft.id, position.id, {
                                      quantity: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              {options?.policy.enabled && (
                                <>
                                  <label>
                                    Partia
                                    <select
                                      value={position.lot_kind}
                                      onChange={(e) =>
                                        editPosition(draft.id, position.id, {
                                          lot_kind: e.target.value as PositionDraft['lot_kind'],
                                          lot_id: '',
                                          cost_mode: '',
                                          cost_decimal: '',
                                          currency: '',
                                        })
                                      }
                                    >
                                      <option value="">Wybierz rodzaj partii</option>
                                      <option value="existing">Istniejąca partia</option>
                                      <option value="new">Nowa partia nadwyżki</option>
                                    </select>
                                  </label>
                                  {position.lot_kind === 'new' && (
                                    <>
                                      <label>
                                        Kod nowej partii
                                        <input
                                          value={position.lot_code}
                                          onChange={(e) =>
                                            editPosition(draft.id, position.id, {
                                              lot_code: e.target.value,
                                            })
                                          }
                                        />
                                      </label>
                                      <label>
                                        Data ważności (opcjonalna)
                                        <input
                                          type="date"
                                          value={position.expiry_date}
                                          onChange={(e) =>
                                            editPosition(draft.id, position.id, {
                                              expiry_date: e.target.value,
                                            })
                                          }
                                        />
                                      </label>
                                    </>
                                  )}
                                  <label>
                                    Koszt jednostkowy netto
                                    <select
                                      value={position.cost_mode}
                                      onChange={(e) =>
                                        editPosition(draft.id, position.id, {
                                          cost_mode: e.target.value as PositionDraft['cost_mode'],
                                          cost_decimal: '',
                                          currency: '',
                                        })
                                      }
                                    >
                                      <option value="">Wybierz sposób podania kosztu</option>
                                      <option value="known">Podaj znany koszt</option>
                                      <option value="unspecified">Nie podaję nowego kosztu</option>
                                    </select>
                                  </label>
                                  {position.cost_mode === 'known' && (
                                    <>
                                      <label>
                                        Kwota netto za sztukę
                                        <input
                                          inputMode="decimal"
                                          value={position.cost_decimal}
                                          placeholder="np. 12,99; znane zero: 0,00"
                                          onChange={(e) =>
                                            editPosition(draft.id, position.id, {
                                              cost_decimal: e.target.value,
                                            })
                                          }
                                        />
                                      </label>
                                      <label>
                                        Waluta kosztu
                                        <select
                                          value={position.currency}
                                          onChange={(e) =>
                                            editPosition(draft.id, position.id, {
                                              currency: e.target.value,
                                            })
                                          }
                                        >
                                          <option value="">Wybierz walutę</option>
                                          {currencies.map((c) => (
                                            <option key={c} value={c}>
                                              {c}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                    </>
                                  )}
                                </>
                              )}
                            </div>
                            {options?.policy.enabled && position.lot_kind === 'existing' && (
                              <>
                                <StockFileExistingLotPicker
                                  key={JSON.stringify([helperScope, draft.id, position.id])}
                                  contextKey={contextKey}
                                  readOnly={readOnly || !!flags?.read_only}
                                  warehouseId={ownWarehouse ? draft.warehouse_id : undefined}
                                  productId={helper?.id}
                                  location={position.location}
                                  value={position.lot_id || null}
                                  disabled={writeDisabled || distributionMode !== 'form'}
                                  canReadValue={financial}
                                  onChange={(choice) => {
                                    if (
                                      editorBlocked.current ||
                                      helperScopeRef.current !== helperScope
                                    )
                                      return;
                                    const latest = draftsRef.current.find((d) => d.id === draft.id);
                                    const latestPosition = latest?.positions.find(
                                      (p) => p.id === position.id,
                                    );
                                    const latestHelper = helperProductsRef.current[draft.id];
                                    if (
                                      !latest ||
                                      latest.warehouse_id !== draft.warehouse_id ||
                                      latest.row_number !== draft.row_number ||
                                      !latestPosition ||
                                      latestPosition.location !== position.location ||
                                      latestPosition.lot_kind !== 'existing' ||
                                      latestHelper?.scope !== helperScope ||
                                      latestHelper.product.id !== helper?.id
                                    )
                                      return;
                                    editPosition(draft.id, position.id, {
                                      lot_id: choice?.lot_id ?? '',
                                    });
                                  }}
                                />
                                <details className="sfi-advanced">
                                  <summary>
                                    Zaawansowane · wpisz identyfikator własnej partii
                                  </summary>
                                  <p>
                                    Alternatywa dla listy partii. Podgląd importu sprawdzi
                                    przynależność do rzeczywistego produktu z pliku, magazynu i
                                    lokalizacji.
                                  </p>
                                  <label>
                                    Identyfikator istniejącej partii
                                    <input
                                      value={position.lot_id}
                                      placeholder="Identyfikator z ewidencji WMS"
                                      onChange={(e) =>
                                        editPosition(draft.id, position.id, {
                                          lot_id: e.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                </details>
                              </>
                            )}
                            {options?.policy.enabled && position.cost_mode === 'unspecified' && (
                              <p className="sfi-hint">
                                Nie zastępujemy braku kosztu zerem ani nie zmieniamy kosztu
                                istniejącej partii. Nadwyżka bez wymaganego kosztu zostanie
                                odrzucona w podglądzie.
                              </p>
                            )}
                            <button
                              className="button"
                              type="button"
                              onClick={() =>
                                editDistribution(draft.id, {
                                  positions: draft.positions.filter((p) => p.id !== position.id),
                                })
                              }
                            >
                              Usuń to miejsce przechowywania
                            </button>
                          </div>
                        ))}
                        <div className="sfi-toolbar">
                          <button
                            className="button"
                            type="button"
                            disabled={
                              !options ||
                              distributionDrafts.reduce((n, d) => n + d.positions.length, 0) >=
                                options.limits.positions
                            }
                            onClick={() =>
                              editDistribution(draft.id, {
                                positions: [...draft.positions, emptyPosition()],
                              })
                            }
                          >
                            Dodaj miejsce przechowywania
                          </button>
                          <button
                            className="button"
                            type="button"
                            onClick={() => {
                              if (writeDisabled || distributionMode !== 'form') return;
                              invalidate();
                              setDistributionDrafts((old) => old.filter((d) => d.id !== draft.id));
                              setHelperProducts((old) => {
                                const next = { ...old };
                                delete next[draft.id];
                                return next;
                              });
                            }}
                          >
                            Usuń ten rozkład pomiaru
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  {!distributionDrafts.length && (
                    <p>
                      Nie dodano decyzji o rozmieszczeniu. Puste pola nie zostaną uzupełnione za
                      Ciebie.
                    </p>
                  )}
                  <button
                    className="button"
                    type="button"
                    disabled={
                      !options ||
                      !targets.length ||
                      distributionDrafts.length >=
                        options.limits.source_rows * options.limits.warehouses ||
                      distributionDrafts.reduce((n, d) => n + d.positions.length, 0) >=
                        options.limits.positions
                    }
                    onClick={() => {
                      if (writeDisabled || distributionMode !== 'form') return;
                      invalidate();
                      setDistributionDrafts((old) => [
                        ...old,
                        {
                          id: crypto.randomUUID(),
                          row_number: '',
                          warehouse_id: '',
                          positions: [emptyPosition()],
                        },
                      ]);
                    }}
                  >
                    Dodaj rozkład pomiaru
                  </button>
                </fieldset>
                <details className="sfi-advanced">
                  <summary>Zaawansowane · rozkład w JSON</summary>
                  <p>
                    Alternatywa dla formularza. Wysyłany jest tylko wybrany sposób rozkładu; dane
                    obu edytorów nie są łączone.
                  </p>
                  <label className="sfi-check">
                    <input
                      type="checkbox"
                      checked={distributionMode === 'json'}
                      onChange={(e) => {
                        if (writeDisabled) return;
                        invalidate();
                        setDistributionMode(e.target.checked ? 'json' : 'form');
                      }}
                    />
                    Użyj JSON zamiast formularza rozmieszczenia
                  </label>
                  <label>
                    Rozkład JSON
                    <textarea
                      rows={10}
                      value={resolutionsText}
                      disabled={distributionMode !== 'json'}
                      onChange={(e) => {
                        invalidate();
                        setResolutionsText(e.target.value);
                      }}
                      spellCheck={false}
                    />
                  </label>
                  <small>
                    source_index jest liczony od 0; warehouse_id musi należeć do wybranych
                    magazynów. Pozycja: location, lot, quantity, unit_cost_minor, currency. OFF:
                    lot=null. ON: istniejąca lub nowa partia. Koszt jako tekst najmniejszej
                    jednostki (np. "1299"), znane zero "0", brak null.
                  </small>
                  <pre>
                    {JSON.stringify(
                      [
                        {
                          source_index: 0,
                          warehouse_id: 'UUID-WYBRANEGO-MAGAZYNU',
                          positions: [
                            {
                              location: 'FAKTYCZNY-BIN',
                              lot: null,
                              quantity: 0,
                              unit_cost_minor: null,
                              currency: null,
                            },
                          ],
                        },
                      ],
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <button
                  className="button"
                  disabled={!options || !targets.length}
                  onClick={() => {
                    try {
                      if (!options) return;
                      currentResolutions();
                      setError('');
                      setStatus(
                        'Struktura rozkładu jest poprawna. Zgodność ilości, partii i całego zakresu potwierdzi serwer w podglądzie.',
                      );
                    } catch (err) {
                      fail(err);
                    }
                  }}
                >
                  Sprawdź strukturę rozkładu
                </button>
              </fieldset>
              <p className="sfi-hint">
                0 jest jawnym pomiarem, puste nie jest 0. Pomiar poniżej rezerwacji zostanie
                odrzucony. Nadwyżka WMS wymaga jawnego kosztu i partii; wcześniejszy koszt nieznany
                pozostaje nieznany. Dostępność zestawu lub hurtowni nie jest fizycznym zapasem.
              </p>
              <button
                className="button primary"
                disabled={
                  writeDisabled || !targets.length || !content.trim() || note.trim().length < 3
                }
                onClick={preview}
              >
                Utwórz trwały podgląd wszystkich pomiarów
              </button>
            </>
          )}
          {tab === 'profiles' && (
            <>
              <h3>Profile mapowania stanów</h3>
              <p>
                Profil zapisuje format, tożsamość, mapowania i własne magazyny. Nie przechowuje
                pliku, pomiarów, rozkładów, kosztu konkretnej korekty ani zgody.
              </p>
              <button
                className="button"
                disabled={busy || remoteBusy}
                onClick={() => void read(loadProfiles)}
              >
                Odczytaj profile
              </button>
              <div className="sfi-grid">
                <label>
                  Profil
                  <select
                    value={profileId}
                    disabled={locked}
                    onChange={(e) => {
                      setProfileId(e.target.value);
                      setProfileName(profiles.find((p) => p.id === e.target.value)?.name ?? '');
                      setProfileConsent(false);
                    }}
                  >
                    <option value="">Nowy profil / wybierz istniejący</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · wersja {p.version}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Nazwa profilu
                  <input
                    value={profileName}
                    maxLength={120}
                    disabled={writeDisabled}
                    onChange={(e) => {
                      setProfileName(e.target.value);
                      setProfileConsent(false);
                    }}
                  />
                </label>
              </div>
              {profile && (
                <article className="sfi-row">
                  <h4>
                    {profile.name} · wersja {profile.version}
                  </h4>
                  <p>
                    {profile.definition.format.toUpperCase()} · {profile.definition.identity_field}{' '}
                    · puste: {profile.definition.empty_policy === 'skip' ? 'pomiń' : 'błąd'}
                  </p>
                  {profile.targets.map((t) => (
                    <p key={t.warehouse_id}>
                      {warehouses.find((w) => w.id === t.warehouse_id)?.name ?? t.warehouse_id} ·{' '}
                      {t.quantity_scope === 'position' ? 'pozycja fizyczna' : 'suma magazynu'} ·
                      ilość z „{t.mapping.quantity}” · lokalizacja{' '}
                      {t.default_location ?? t.mapping.location ?? 'nie wskazano'}
                    </p>
                  ))}
                  <button
                    className="button"
                    disabled={writeDisabled}
                    onClick={() => void read(applyProfile)}
                  >
                    Odczytaj bieżący profil i zastosuj
                  </button>
                </article>
              )}
              <p>Bieżąca konfiguracja obejmuje {targets.length} magazynów.</p>
              <button
                className="button primary"
                disabled={writeDisabled || !targets.length || !profileName.trim()}
                onClick={() => saveProfile(false)}
              >
                Zapisz nowy profil z tej konfiguracji
              </button>
              {profile && (
                <>
                  <label className="sfi-check">
                    <input
                      type="checkbox"
                      checked={profileConsent}
                      disabled={writeDisabled}
                      onChange={(e) => setProfileConsent(e.target.checked)}
                    />
                    Zastąpię profil „{profile.name}”, wersja {profile.version}, obecną konfiguracją.
                  </label>
                  <button
                    className="button"
                    disabled={
                      writeDisabled || !targets.length || !profileConsent || !profileName.trim()
                    }
                    onClick={() => saveProfile(true)}
                  >
                    Aktualizuj wybrany profil
                  </button>
                </>
              )}
            </>
          )}
          {tab === 'history' && (
            <>
              <h3>Trwała historia pomiarów</h3>
              <div className="sfi-toolbar">
                <label>
                  Rodzaj
                  <select
                    value={historyKind}
                    disabled={busy || remoteBusy}
                    onChange={(e) => {
                      setHistoryKind(e.target.value as typeof historyKind);
                      setHistory([]);
                      setHistoryCursor(null);
                      setHistoryLoaded(false);
                    }}
                  >
                    <option value="executions">Wykonania</option>
                    <option value="previews">Podglądy</option>
                  </select>
                </label>
                <button
                  className="button"
                  disabled={busy || remoteBusy}
                  onClick={() => void read((e) => loadHistory(e))}
                >
                  Odczytaj historię
                </button>
              </div>
              {historyLoaded && !history.length && (
                <p>Odczyt zakończony. Brak zapisanych pozycji tego rodzaju.</p>
              )}
              <div className="sfi-history">
                {history.map((h) => (
                  <button
                    className="button"
                    key={h.id}
                    disabled={busy || remoteBusy}
                    onClick={() =>
                      void read((e) =>
                        loadReview(historyKind === 'previews' ? 'preview' : 'execution', h.id, e),
                      )
                    }
                  >
                    {date(h.created_at)} · {h.file_name} · {h.summary.products} produktów ·{' '}
                    {h.summary.positions} pozycji · {h.targets.length} magazynów · zmiany{' '}
                    {h.summary.changed} · błędy {h.summary.invalid + h.summary.conflicts}
                  </button>
                ))}
              </div>
              {historyCursor && (
                <button
                  className="button"
                  disabled={busy || remoteBusy}
                  onClick={() => void read((e) => loadHistory(e, true))}
                >
                  Dalsza historia
                </button>
              )}
            </>
          )}
          {review && (
            <section className="sfi-review">
              <h3>
                {review.kind === 'execution' ? 'Wynik całego importu' : 'Pełny podgląd pomiarów'} ·{' '}
                {review.head.file_name}
              </h3>
              <p>
                {date(review.head.created_at)} · {review.head.summary.source_rows} wierszy źródła ·{' '}
                {review.head.summary.products} produktów · {review.head.summary.positions} pozycji ·
                zmiany {review.head.summary.changed} · bez zmian {review.head.summary.unchanged} ·
                pominięte {review.head.summary.skipped} · błędy {review.head.summary.invalid} ·
                konflikty {review.head.summary.conflicts}
              </p>
              {review.kind === 'execution' && <CatalogStockCountDocuments documents={review.head.stock_count_documents} protocol="stock_file" sourceId={review.head.preview_id ?? ''} contextKey={contextKey} warehouses={warehouses} />}
              <p>Uzasadnienie: {review.head.note}</p>
              <small>
                ID: {review.head.id} · WMS {review.head.policy.enabled ? 'ON' : 'OFF'} · wersja
                polityki {review.head.policy.version}
              </small>
              <div className="sfi-summaries">
                {review.head.targets.map((t) => (
                  <article className="sfi-row" key={t.warehouse_id}>
                    <h4>{t.warehouse_name}</h4>
                    <p>
                      Pozycje {t.summary.positions} · zmiany {t.summary.changed} · bez zmian{' '}
                      {t.summary.unchanged} · błędy {t.summary.invalid} · konflikty{' '}
                      {t.summary.conflicts}
                    </p>
                    {financial && t.valuation && (
                      <>
                        <p>
                          Znany koszt niedoboru:{' '}
                          {money(t.valuation.known_loss_minor, t.valuation.currency)} · nadwyżki:{' '}
                          {money(t.valuation.known_surplus_minor, t.valuation.currency)}
                        </p>
                        <p>
                          Niedobór o nieznanym koszcie:{' '}
                          {t.summary.unknown_loss_quantity ?? 'Nie odczytano'} szt. · nadwyżka:{' '}
                          {t.summary.surplus_quantity ?? 'Nie odczytano'} szt.
                        </p>
                      </>
                    )}
                  </article>
                ))}
              </div>
              {review.complete ? (
                <RowsView
                  key={`${review.kind}:${review.head.id}`}
                  review={review}
                  financial={financial}
                />
              ) : (
                <p className="sfi-hint">
                  Nie odczytano jeszcze wszystkich stron. Zatwierdzenie zablokowane.
                </p>
              )}
              {review.kind === 'preview' && (
                <>
                  <button
                    className="button"
                    disabled={busy || remoteBusy}
                    onClick={() => void read((e) => loadReview('preview', review.head.id, e))}
                  >
                    Odczytaj ponownie cały podgląd
                  </button>
                  {(!review.head.can_execute ||
                    review.head.summary.invalid > 0 ||
                    review.head.summary.conflicts > 0) && (
                    <p className="sfi-error">
                      Nie można zatwierdzić tego podglądu. Popraw błędy lub odczytaj zmieniony stan
                      i utwórz nowy podgląd. Nie zmieniamy rezerwacji ani partii automatycznie.
                    </p>
                  )}
                  {!ackDataComplete && (
                    <p className="sfi-hint">
                      Brak pełnych danych zgody kosztowej. Zatwierdzenie pozostaje zablokowane.
                    </p>
                  )}
                  <label className="sfi-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={writeDisabled || !ready}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    Sprawdziłem pełny zakres {review.head.summary.products} produktów i{' '}
                    {review.head.summary.positions} fizycznych pozycji we wszystkich{' '}
                    {review.head.targets.length} magazynach. Zatwierdzam dokładnie te pomiary i
                    korekty jako jedną partię.
                  </label>
                  {review.head.targets.map((t) => (
                    <div key={t.warehouse_id}>
                      {financial && (t.summary.unknown_loss_quantity ?? 0) > 0 && (
                        <label className="sfi-check">
                          <input
                            type="checkbox"
                            checked={!!unknownConsent[t.warehouse_id]}
                            disabled={writeDisabled || !ready}
                            onChange={(e) =>
                              setUnknownConsent((old) => ({
                                ...old,
                                [t.warehouse_id]: e.target.checked,
                              }))
                            }
                          />
                          Świadomie rozliczam niedobór {t.summary.unknown_loss_quantity} szt. o
                          nieznanym koszcie w „{t.warehouse_name}”. Koszt nie zostanie zastąpiony
                          zerem.
                        </label>
                      )}
                      {financial && (t.summary.surplus_quantity ?? 0) > 0 && (
                        <label className="sfi-check">
                          <input
                            type="checkbox"
                            checked={!!surplusConsent[t.warehouse_id]}
                            disabled={writeDisabled || !ready}
                            onChange={(e) =>
                              setSurplusConsent((old) => ({
                                ...old,
                                [t.warehouse_id]: e.target.checked,
                              }))
                            }
                          />
                          Potwierdzam nadwyżkę {t.summary.surplus_quantity} szt. oraz jej jawne
                          partie i koszty netto w „{t.warehouse_name}”.
                        </label>
                      )}
                    </div>
                  ))}
                  <button
                    className="button primary"
                    disabled={writeDisabled || !ready || !consent || ackMissing}
                    onClick={execute}
                  >
                    Zatwierdź cały import stanów
                  </button>
                </>
              )}
              {review.kind === 'execution' && review.head.links && (
                <div className="sfi-row">
                  <h4>Trwałe dowody księgowania</h4>
                  {review.head.links.map((link) => (
                    <p key={link.warehouse_id}>
                      {review.head.targets.find((t) => t.warehouse_id === link.warehouse_id)
                        ?.warehouse_name ?? link.warehouse_id}{' '}
                      · {link.mode === 'on' ? 'WMS partie' : 'Pomiar ilości'}
                      {link.core_execution_id && ` · wykonanie ${link.core_execution_id}`}
                      {link.stocktake_id && ` · spis ${link.stocktake_id}`}
                      {link.posting_id && ` · księgowanie ${link.posting_id}`}
                      {link.operation_id && ` · operacja ${link.operation_id}`}
                    </p>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
