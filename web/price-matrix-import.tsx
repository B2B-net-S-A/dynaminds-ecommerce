import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './price-matrix-import.css';

export type PriceMatrixImportWorkspaceProps = {
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
};
type Definition = {
  format: 'csv' | 'xml';
  delimiter: ';' | ',' | '\t';
  identity: 'uuid' | 'sku' | 'historical_sku' | 'ean' | 'name';
  mapping: { identity: string; price: string; operation?: string; currency?: string };
  amount_mode: 'minor' | 'decimal';
  decimal_separator: '.' | ',';
  basis: 'gross' | 'net';
  empty_policy: 'skip' | 'remove';
  spreadsheet_safe: boolean;
  native_price_mode: 'mapped' | 'own_entries';
};
type List = {
  id: string;
  name: string;
  currency: string;
  version: number;
  active: boolean;
  fallback: boolean;
};
type Target = { price_list_id: string; list_version: number; definition: Definition };
type Options = Flags & {
  catalog_currency: string | null;
  price_lists: List[];
  meta: { cursor: string | null; total?: number };
  limits: {
    products: number;
    cells: number;
    lists: number;
    file_bytes: number;
    request_bytes: number;
    profiles: number;
    page: number;
  };
};
type Summary = {
  total: number;
  changed: number;
  unchanged: number;
  invalid: number;
  conflicts: number;
  missing_after_count: number;
  ready: boolean;
};
type MatrixSummary = Omit<Summary, 'total'> & { total_products: number; total_cells: number };
type FrozenTarget = {
  price_list_id: string;
  definition: Definition;
  list_snapshot: List;
  repricing_snapshot: unknown;
  warnings: string[];
  summary: Summary;
  core_preview_id: string | null;
};
type Head = {
  id: string;
  actor_id: string;
  file_name: string;
  source_hash: string;
  targets: FrozenTarget[];
  warnings: string[];
  summary: MatrixSummary;
  scope_hash: string;
  execution_id: string | null;
  can_execute: boolean;
  created_at: string;
  preview_id?: string;
  core_execution_ids?: { price_list_id: string; core_execution_id: string }[];
  ack_missing_price_list_ids?: string[];
};
type Price = {
  currency: string;
  vat: number;
  override_present: boolean;
  override_price: number | null;
  effective_price: number | null;
  source: 'override' | 'rule' | 'missing';
  issue: string | null;
};
type Cell = {
  price_list_id: string;
  input: null | {
    operation: 'none' | 'set' | 'remove';
    basis?: 'gross' | 'net';
    amount_minor?: number;
  };
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict';
  before: Price | null;
  after: Price | null;
  errors: string[];
  skipped_price_groups: number;
};
type Row = {
  index: number;
  raw_cells: Record<string, unknown>;
  resolution: { identity: string; value: string | null; matched_historical_sku: boolean };
  product_id: string | null;
  sku: string | null;
  name: string | null;
  cells: Cell[];
  errors: string[];
};
type Profile = {
  id: string;
  name: string;
  version: number;
  targets: { price_list_id: string; definition: Definition }[];
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null; total: number } };
type Detail = Flags & { preview?: Head; execution?: Head; reused?: boolean };
type ProfileReply = Flags & { profile: Profile; reused?: boolean };
type Review = { kind: 'preview' | 'execution'; head: Head; rows: Row[]; complete: boolean };
type Attempt = {
  context: string;
  kind: 'preview' | 'execute' | 'profile';
  path: string;
  method: 'POST' | 'PATCH';
  serialized: string;
  label: string;
};
// Keep the exact request in RAM across navigation. Actor changes explicitly purge it.
const retained: { context: string; attempt: Attempt | null; inFlight: boolean } = {
  context: '',
  attempt: null,
  inFlight: false,
};
const listeners = new Set<() => void>();
function publish() {
  listeners.forEach((listener) => listener());
}
export function resetPriceMatrixImportContext(contextKey: string) {
  retained.context = contextKey;
  retained.attempt = null;
  retained.inFlight = false;
  publish();
}
const prefix = '/price-matrix-imports';
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const sorted = (ids: string[]) => [...ids].sort();
const copyDefinition = (d: Definition): Definition => ({ ...d, mapping: { ...d.mapping } });
const initialDefinition = (): Definition => ({
  format: 'csv',
  delimiter: ';',
  identity: 'sku',
  mapping: { identity: 'sku', price: 'price' },
  amount_mode: 'decimal',
  decimal_separator: ',',
  basis: 'gross',
  empty_policy: 'skip',
  spreadsheet_safe: false,
  native_price_mode: 'mapped',
});
function money(value: number | null | undefined, currency: string) {
  if (value === null || value === undefined) return 'Brak ceny';
  if (!Number.isSafeInteger(value)) return 'Nieprawidłowa kwota';
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')} ${currency}`;
}
const statusNames = {
  changed: 'Zmiana',
  unchanged: 'Bez zmian',
  invalid: 'Błąd',
  conflict: 'Konflikt',
};
function PriceView({ value }: { value: Price | null }) {
  if (!value) return <span>Brak poprawnego wyniku</span>;
  return (
    <div className="pmi-price">
      <strong>{money(value.effective_price, value.currency)}</strong>
      <span>
        {value.source === 'override'
          ? 'Własna cena'
          : value.source === 'rule'
            ? 'Reguła cennika'
            : 'Brak ceny'}
      </span>
      <small>
        Własny wpis:{' '}
        {value.override_present ? money(value.override_price, value.currency) : 'Nie istnieje'} ·
        VAT {value.vat}%
      </small>
      {value.issue && (
        <small>
          {value.issue === 'missing_override'
            ? 'Brak własnej ceny i dostępnej reguły.'
            : value.issue === 'invalid_fallback'
              ? 'Reguła nie daje poprawnej ceny.'
              : value.issue === 'non_sellable_group'
                ? 'Grupa wariantów nie ma ceny sprzedaży.'
                : value.issue}
        </small>
      )}
    </div>
  );
}
function DefinitionView({ value }: { value: Definition }) {
  return (
    <div className="pmi-definition">
      <span>
        {value.format.toUpperCase()} · tożsamość {value.identity} z pola „{value.mapping.identity}”
      </span>
      <span>
        {value.native_price_mode === 'own_entries'
          ? 'Odtworzenie własnych wpisów prices_json · brutto w najmniejszej jednostce'
          : `Cena z „${value.mapping.price}” · ${value.amount_mode === 'minor' ? 'najmniejsza jednostka' : `dziesiętnie (${value.decimal_separator})`} · ${value.basis === 'net' ? 'netto → brutto' : 'brutto'}`}
      </span>
      <span>
        Pusta cena: {value.empty_policy === 'skip' ? 'Pomiń' : 'Usuń własny wpis'} · operacja:{' '}
        {value.mapping.operation || 'Na podstawie ceny'} · waluta:{' '}
        {value.mapping.currency || 'Waluta cennika'}
      </span>
    </div>
  );
}
function RowsView({ review }: { review: Review }) {
  const [page, setPage] = useState(0),
    [errorsOnly, setErrorsOnly] = useState(false);
  const filtered = errorsOnly
    ? review.rows.filter(
        (r) =>
          r.errors.length ||
          r.cells.some((c) => c.errors.length || c.status === 'invalid' || c.status === 'conflict'),
      )
    : review.rows;
  const pages = Math.max(1, Math.ceil(filtered.length / 25));
  const current = Math.min(page, pages - 1);
  return (
    <div className="pmi-rows">
      <div className="pmi-toolbar">
        <label className="pmi-check">
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
          Odczytano {review.rows.length} / {review.head.summary.total_products} produktów · widoczne{' '}
          {filtered.length}
        </span>
        <button className="button" disabled={!current} onClick={() => setPage(current - 1)}>
          Poprzednie produkty
        </button>
        <span>
          Strona {current + 1} / {pages}
        </span>
        <button
          className="button"
          disabled={current + 1 >= pages}
          onClick={() => setPage(current + 1)}
        >
          Następne produkty
        </button>
      </div>
      {filtered.slice(current * 25, (current + 1) * 25).map((row) => (
        <article
          className={`pmi-product ${row.errors.length || row.cells.some((c) => c.errors.length) ? 'pmi-invalid' : ''}`}
          key={row.index}
        >
          <h4>
            {row.index + 1}. {row.sku ?? 'Bez dopasowania'} {row.name && `· ${row.name}`}
          </h4>
          <small>
            Identyfikator z pliku: {row.resolution.value ?? 'Brak'} · produkt:{' '}
            {row.product_id ?? 'Nie rozpoznano'}
          </small>
          {row.resolution.matched_historical_sku && (
            <p>
              Wcześniejsze SKU wskazuje ten sam produkt. Aktualne SKU pokazano powyżej; kod produktu
              nie zostanie zmieniony.
            </p>
          )}
          {row.errors.length > 0 && (
            <ul className="pmi-error">
              {row.errors.map((error, i) => (
                <li key={i}>{error}</li>
              ))}
            </ul>
          )}
          <details>
            <summary>Oryginalne komórki pliku</summary>
            <dl className="pmi-raw">
              {Object.entries(row.raw_cells ?? {}).map(([key, value]) => (
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
          <div className="pmi-scroll">
            <table>
              <thead>
                <tr>
                  <th>Cennik i wejście</th>
                  <th>Przed</th>
                  <th>Po</th>
                  <th>Wynik</th>
                </tr>
              </thead>
              <tbody>
                {row.cells.map((cell) => {
                  const target = review.head.targets.find(
                    (t) => t.price_list_id === cell.price_list_id,
                  );
                  return (
                    <tr key={cell.price_list_id}>
                      <td>
                        <strong>
                          {target?.list_snapshot.name ?? cell.price_list_id} ·{' '}
                          {target?.list_snapshot.currency}
                        </strong>
                        {cell.input && (
                          <small>
                            {cell.input.operation === 'none'
                              ? 'Pomiń (bez zmian)'
                              : cell.input.operation === 'remove'
                                ? 'Usuń własny wpis'
                                : `Ustaw ${cell.input.basis === 'net' ? 'netto' : 'brutto'}`}
                            {cell.input.amount_minor !== undefined &&
                              ` · ${money(cell.input.amount_minor, target?.list_snapshot.currency ?? '')}`}
                          </small>
                        )}
                        {cell.input?.basis === 'net' && (
                          <small>
                            Brutto obliczono z VAT zamrożonego w podglądzie; wynik pokazano w
                            kolumnie „Po”.
                          </small>
                        )}
                        {cell.skipped_price_groups > 0 && (
                          <small>
                            Pominięto {cell.skipped_price_groups} pozostałych grup cenowych w XML
                            dla tej listy.
                          </small>
                        )}
                      </td>
                      <td>
                        <PriceView value={cell.before} />
                      </td>
                      <td>
                        <PriceView value={cell.after} />
                      </td>
                      <td>
                        <strong>{statusNames[cell.status]}</strong>
                        {cell.errors.length > 0 && (
                          <ul>
                            {cell.errors.map((error, i) => (
                              <li key={i}>{error}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </article>
      ))}
      {!filtered.length && (
        <p>
          {errorsOnly
            ? 'W odczytanym zakresie nie ma błędów ani konfliktów.'
            : 'Brak produktów w tym zakresie.'}
        </p>
      )}
    </div>
  );
}

export function PriceMatrixImportWorkspace({
  contextKey,
  readOnly,
  onApplied,
  onError,
  onLockedChange,
  externalWriteBlocked = false,
}: PriceMatrixImportWorkspaceProps) {
  const [flags, setFlags] = useState<Flags | null>(null),
    [options, setOptions] = useState<Options | null>(null);
  const [lists, setLists] = useState<List[]>([]),
    [listCursor, setListCursor] = useState<string | null>(null);
  const [common, setCommon] = useState<Definition>(initialDefinition),
    [targets, setTargets] = useState<Target[]>([]);
  const [content, setContent] = useState(''),
    [fileName, setFileName] = useState('');
  const [tab, setTab] = useState<'import' | 'profiles' | 'history'>('import');
  const [review, setReview] = useState<Review | null>(null),
    [consent, setConsent] = useState(false);
  const [missing, setMissing] = useState<Record<string, boolean>>({}),
    [nativeConsent, setNativeConsent] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]),
    [profileId, setProfileId] = useState(''),
    [profileName, setProfileName] = useState(''),
    [profileConsent, setProfileConsent] = useState(false);
  const [historyKind, setHistoryKind] = useState<'previews' | 'executions'>('executions'),
    [history, setHistory] = useState<Head[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null),
    [remoteBusy, setRemoteBusy] = useState(false),
    [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false),
    [writeBlocked, setWriteBlocked] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const epoch = useRef(0),
    readId = useRef(0),
    localBusy = useRef(false),
    authorized = useRef<string | null>(null),
    fileRef = useRef<HTMLInputElement | null>(null);
  const scopeRef = useRef('');
  scopeRef.current = `${contextKey}:${readOnly}`;
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const externalLockRef = useRef(externalWriteBlocked);
  externalLockRef.current = externalWriteBlocked;
  const flagsRef = useRef<Flags | null>(null);
  flagsRef.current = flags;
  const readable =
    !!flags?.available && flags.can_read && !blocked && authorized.current === scopeRef.current;
  const authorizedWritable =
    readable && !!flags?.can_write && !flags.read_only && !readOnly && !writeBlocked;
  const writable = authorizedWritable && !externalWriteBlocked;
  const locked = busy || remoteBusy || !!pending,
    writeDisabled = !writable || locked;
  const profile = profiles.find((p) => p.id === profileId);

  function clearSensitive() {
    setContent('');
    setFileName('');
    setTargets([]);
    setCommon(initialDefinition());
    setReview(null);
    setConsent(false);
    setMissing({});
    setNativeConsent(false);
    setProfiles([]);
    setProfileId('');
    setProfileName('');
    setProfileConsent(false);
    if (fileRef.current) fileRef.current.value = '';
  }
  function purge() {
    ++epoch.current;
    ++readId.current;
    localBusy.current = false;
    authorized.current = null;
    setBlocked(true);
    setFlags(null);
    setOptions(null);
    setLists([]);
    setListCursor(null);
    clearSensitive();
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
    setBusy(false);
    resetPriceMatrixImportContext(contextRef.current);
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
    if (old?.can_write && (!d.can_write || d.read_only)) {
      clearSensitive();
      resetPriceMatrixImportContext(contextRef.current);
    }
    authorized.current = scopeRef.current;
    flagsRef.current = d;
    setFlags(d);
    return d.available;
  }
  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    const message =
      err instanceof Error ? err.message : 'Nie udało się wykonać operacji importu macierzy cen.';
    setError(message);
    onError?.(message);
    if (err instanceof ApiError && [401, 403].includes(err.status)) purge();
    else if (err instanceof ApiError && err.status === 423) {
      setWriteBlocked(true);
      clearSensitive();
      resetPriceMatrixImportContext(contextRef.current);
      setFlags((f) => (f ? { ...f, can_write: false, read_only: true } : f));
    }
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    const scope = scopeRef.current;
    try {
      const d = await api<T>(prefix + path, method, body);
      if (e !== epoch.current || scope !== scopeRef.current)
        throw new DOMException('Zmieniono kontekst.', 'AbortError');
      return d;
    } catch (err) {
      if (e !== epoch.current || scope !== scopeRef.current)
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
  function invalidate() {
    setReview(null);
    setConsent(false);
    setMissing({});
    setNativeConsent(false);
    setProfileConsent(false);
    setError('');
    setStatus('');
  }
  function changeCommon(next: Definition) {
    invalidate();
    setCommon(next);
    setTargets((old) =>
      old.map((t) => ({
        ...t,
        definition: {
          ...t.definition,
          format: next.format,
          delimiter: next.delimiter,
          identity: next.identity,
          spreadsheet_safe: next.spreadsheet_safe,
          mapping: { ...t.definition.mapping, identity: next.mapping.identity },
          ...(next.format === 'csv' ? { native_price_mode: 'mapped' as const } : {}),
        },
      })),
    );
  }
  function changeTarget(id: string, definition: Definition) {
    invalidate();
    setTargets((old) => old.map((t) => (t.price_list_id === id ? { ...t, definition } : t)));
  }
  function toggleList(list: List, selected: boolean) {
    invalidate();
    setTargets((old) =>
      selected
        ? [
            ...old,
            {
              price_list_id: list.id,
              list_version: list.version,
              definition: copyDefinition(common),
            },
          ].sort((a, b) => a.price_list_id.localeCompare(b.price_list_id))
        : old.filter((t) => t.price_list_id !== list.id),
    );
  }
  async function optionsPage(e: number, cursor?: string): Promise<Options> {
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
    if (!d.can_read || !d.available) {
      setOptions(d);
      return;
    }
    setOptions(d);
    setLists((old) =>
      cursor
        ? [...old.filter((l) => !d.price_lists.some((n) => n.id === l.id)), ...d.price_lists]
        : d.price_lists,
    );
    setListCursor(d.meta.cursor);
  }
  async function allCurrentLists(e: number): Promise<List[]> {
    const all: List[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const d: Options = await optionsPage(e, cursor ?? undefined);
      if (!d.available || !d.can_read) throw new Error('Nie można odczytać aktualnych cenników.');
      if (d.price_lists.length > 50 || (d.meta.cursor && seen.has(d.meta.cursor)))
        throw new Error('Nie można potwierdzić kompletnych stron cenników.');
      all.push(...d.price_lists);
      if (all.length > 2000 || new Set(all.map((l) => l.id)).size !== all.length)
        throw new Error(
          'Lista cenników przekracza pełny obsługiwany zakres lub zawiera duplikaty.',
        );
      cursor = d.meta.cursor;
      if (cursor) seen.add(cursor);
      setOptions(d);
    } while (cursor);
    setLists(all);
    setListCursor(null);
    return all;
  }
  async function loadProfiles(e: number) {
    const all: Profile[] = [],
      seen = new Set<string>();
    let cursor: string | null = null,
      total = 0;
    do {
      const d: Page<Profile> = await request<Page<Profile>>(
        '/profiles' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        e,
      );
      if (!accept(d)) return;
      if (d.meta.total > 100 || (all.length && total !== d.meta.total))
        throw new Error('Zakres profili zmienił się podczas odczytu.');
      total = d.meta.total;
      all.push(...d.data);
      if (all.length > 100 || (d.meta.cursor && seen.has(d.meta.cursor)))
        throw new Error('Nie odczytano kompletnej listy profili.');
      cursor = d.meta.cursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (all.length !== total || new Set(all.map((p) => p.id)).size !== all.length)
      throw new Error('Brak pełnej listy profili. Nie obcięto wyników.');
    setProfiles(all);
  }
  async function loadReview(kind: Review['kind'], id: string, e: number) {
    const base = `/${kind === 'preview' ? 'previews' : 'executions'}/${encodeURIComponent(id)}`;
    const d = await request<Detail>(base, e);
    if (!accept(d)) return;
    const head = kind === 'preview' ? d.preview : d.execution;
    if (
      !head ||
      head.targets.length < 2 ||
      head.targets.length > 8 ||
      !Number.isInteger(head.summary.total_products) ||
      head.summary.total_products < 1
    )
      throw new Error('Nie odczytano pełnego nagłówka macierzy.');
    const targetIds = sorted(head.targets.map((t) => t.price_list_id));
    if (
      new Set(targetIds).size !== targetIds.length ||
      head.summary.total_products > 500 ||
      head.summary.total_cells !== head.summary.total_products * targetIds.length ||
      head.summary.total_cells > 4000 ||
      head.targets.some((t) => t.summary.total !== head.summary.total_products)
    )
      throw new Error('Niespójny zakres produktów i cenników. Zapis zablokowany.');
    setReview({ kind, head, rows: [], complete: false });
    setConsent(false);
    setMissing({});
    const rows: Row[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const p: Page<Row> = await request<Page<Row>>(
        base + '/rows' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        e,
      );
      if (!accept(p)) return;
      if (p.meta.total !== head.summary.total_products || p.data.length > 50)
        throw new Error('Strony nie odpowiadają pełnemu podglądowi.');
      rows.push(...p.data);
      if (rows.length > 500 || (p.meta.cursor && seen.has(p.meta.cursor)))
        throw new Error('Nie potwierdzono kompletności stron.');
      cursor = p.meta.cursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (
      rows.length !== head.summary.total_products ||
      new Set(rows.map((r) => r.index)).size !== rows.length ||
      rows.some(
        (r) =>
          JSON.stringify(sorted(r.cells.map((c) => c.price_list_id))) !== JSON.stringify(targetIds),
      )
    )
      throw new Error(
        'Brakuje produktów lub komórek, albo strony zawierają duplikaty. Zapis zablokowany.',
      );
    const cells = rows.flatMap((r) => r.cells);
    if (
      (head.summary.ready &&
        cells.some((c) => c.status !== 'changed' && c.status !== 'unchanged')) ||
      head.targets.some(
        (t) =>
          cells.filter((c) => c.price_list_id === t.price_list_id && c.after?.source === 'missing')
            .length !== t.summary.missing_after_count,
      )
    )
      throw new Error('Wyniki komórek nie odpowiadają podsumowaniu zgody. Zapis zablokowany.');
    setReview({ kind, head, rows, complete: true });
  }
  async function loadHistory(e: number, more = false) {
    const d = await request<Page<Head>>(
      `/${historyKind}` +
        (more && historyCursor ? `?cursor=${encodeURIComponent(historyCursor)}` : ''),
      e,
    );
    if (!accept(d)) return;
    if (d.meta.total > 2000) throw new Error('Historia przekracza obsługiwany zakres.');
    setHistory((old) =>
      more ? [...old.filter((h) => !d.data.some((n) => n.id === h.id)), ...d.data] : d.data,
    );
    setHistoryCursor(d.meta.cursor);
    setHistoryLoaded(true);
  }
  useEffect(() => {
    const sync = () => {
      setPending(retained.context === contextKey ? retained.attempt : null);
      setRemoteBusy(retained.context === contextKey && retained.inFlight);
    };
    if (retained.context !== contextKey || readOnly) resetPriceMatrixImportContext(contextKey);
    listeners.add(sync);
    sync();
    const e = ++epoch.current;
    ++readId.current;
    localBusy.current = true;
    authorized.current = null;
    flagsRef.current = null;
    setFlags(null);
    setOptions(null);
    setLists([]);
    setListCursor(null);
    clearSensitive();
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
    setBlocked(false);
    setWriteBlocked(false);
    setError('');
    setStatus('');
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
    return () => onLockedChange?.(false);
  }, [locked, onLockedChange]);

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
      const d = await request<Detail & Partial<ProfileReply>>(
        a.path,
        e,
        a.method,
        JSON.parse(a.serialized),
      );
      if (!accept(d)) return;
      if (a.kind === 'profile') {
        if (!d.profile) throw new Error('Nie otrzymano identyfikatora profilu. Zachowano próbę.');
        if (retained.attempt === a) {
          retained.attempt = null;
          publish();
        }
        setProfileId(d.profile.id);
        setProfileName(d.profile.name);
        setProfileConsent(false);
        setStatus(
          d.reused
            ? 'Odczytano pierwotną rewizję wcześniejszego zapisu profilu. Przed użyciem odczytaj bieżący profil i wersje cenników.'
            : 'Profil macierzy zapisany.',
        );
        await loadProfiles(e);
      } else {
        const kind = a.kind === 'execute' ? 'execution' : 'preview',
          head = kind === 'execution' ? d.execution : d.preview;
        if (!head?.id)
          throw new Error(
            'Nie otrzymano trwałego identyfikatora. Zachowano dokładną próbę; sprawdź historię.',
          );
        if (retained.attempt === a) {
          retained.attempt = null;
          publish();
        }
        await loadReview(kind, head.id, e);
        setStatus(
          kind === 'execution'
            ? d.reused
              ? 'Odczytano wcześniejsze wykonanie całej macierzy. Nie zapisano cen ponownie.'
              : 'Wykonano całą macierz we wszystkich wybranych cennikach.'
            : d.reused
              ? 'Odczytano wcześniejszy trwały podgląd.'
              : 'Odczytano kompletny podgląd macierzy.',
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
        setMissing({});
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
  async function upload(file: File) {
    if (writeDisabled || !options) return;
    const e = epoch.current,
      scope = scopeRef.current,
      id = ++readId.current;
    localBusy.current = true;
    setBusy(true);
    invalidate();
    try {
      if (file.size > options.limits.file_bytes)
        throw new Error('Plik przekracza limit 2 MiB. Nie obcięto treści.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (e !== epoch.current || scope !== scopeRef.current) return;
      if (bytes(text) > options.limits.file_bytes) throw new Error('Treść przekracza limit 2 MiB.');
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
      if (!options || targets.length < 2 || targets.length > 8 || !content.trim())
        throw new Error('Wybierz od 2 do 8 cenników i wczytaj treść pliku.');
      if (targets.some((t) => !lists.find((l) => l.id === t.price_list_id)))
        throw new Error('Nie odczytano wszystkich wybranych własnych cenników.');
      if (bytes(content) > options.limits.file_bytes)
        throw new Error('Treść przekracza limit 2 MiB.');
      if (targets.some((t) => t.definition.native_price_mode === 'own_entries') && !nativeConsent)
        throw new Error('Potwierdź odtworzenie własnych wpisów z XML.');
      const body = {
        client_key: crypto.randomUUID(),
        file_name: fileName || 'tekst-wklejony',
        content,
        targets: targets
          .map((t) => ({ ...t, definition: copyDefinition(t.definition) }))
          .sort((a, b) => a.price_list_id.localeCompare(b.price_list_id)),
      };
      if (bytes(JSON.stringify(body)) > options.limits.request_bytes)
        throw new Error('Żądanie przekracza limit 3 MiB. Nie wysłano pliku.');
      attempt('preview', '/previews', body, 'Utworzenie podglądu całej macierzy');
    } catch (err) {
      fail(err);
    }
  }
  function execute() {
    if (
      !review ||
      review.kind !== 'preview' ||
      !review.complete ||
      !review.head.can_execute ||
      !review.head.summary.ready ||
      !consent
    )
      return;
    const ids = sorted(
      review.head.targets
        .filter((t) => t.summary.missing_after_count > 0)
        .map((t) => t.price_list_id),
    );
    if (ids.some((id) => !missing[id])) return;
    attempt(
      'execute',
      `/previews/${encodeURIComponent(review.head.id)}/execute`,
      {
        client_key: crypto.randomUUID(),
        scope_hash: review.head.scope_hash,
        confirmed: true,
        ack_missing_price_list_ids: ids,
      },
      'Wykonanie całej macierzy cen',
    );
  }
  async function applyProfile(e: number) {
    if (!profileId || writeDisabled) return;
    const d = await request<ProfileReply>(`/profiles/${encodeURIComponent(profileId)}`, e);
    if (!accept(d)) return;
    const p = d.profile;
    if (
      p.targets.length < 2 ||
      p.targets.length > 8 ||
      new Set(p.targets.map((t) => t.price_list_id)).size !== p.targets.length
    )
      throw new Error('Profil nie zawiera pełnego zakresu 2–8 cenników.');
    const current = await allCurrentLists(e);
    if (!flagsRef.current?.can_write || flagsRef.current.read_only || externalLockRef.current)
      return;
    const next: Target[] = p.targets
      .map((t) => {
        const l = current.find((list) => list.id === t.price_list_id);
        if (!l)
          throw new Error(
            'Nie odczytano własnego cennika wskazanego przez profil. Nie zastosowano części profilu.',
          );
        return {
          price_list_id: l.id,
          list_version: l.version,
          definition: copyDefinition(t.definition),
        };
      })
      .sort((a, b) => a.price_list_id.localeCompare(b.price_list_id));
    invalidate();
    setTargets(next);
    setCommon(copyDefinition(next[0].definition));
    setProfileId(p.id);
    setProfileName(p.name);
    setProfiles((old) => [...old.filter((v) => v.id !== p.id), p]);
    setTab('import');
    setStatus(
      'Zastosowano bieżący profil i aktualne wersje wszystkich cenników. Treść pliku nie została wysłana.',
    );
  }
  function saveProfile(update: boolean) {
    if (
      targets.length < 2 ||
      targets.length > 8 ||
      !profileName.trim() ||
      profileName.trim().length > 120 ||
      (update && (!profile || !profileConsent))
    )
      return;
    const body = {
      client_key: crypto.randomUUID(),
      name: profileName.trim(),
      targets: targets
        .map((t) => ({ price_list_id: t.price_list_id, definition: copyDefinition(t.definition) }))
        .sort((a, b) => a.price_list_id.localeCompare(b.price_list_id)),
      ...(update && profile ? { version: profile.version } : {}),
    };
    attempt(
      'profile',
      update && profile ? `/profiles/${encodeURIComponent(profile.id)}` : '/profiles',
      body,
      update ? 'Aktualizacja profilu macierzy' : 'Zapis nowego profilu macierzy',
      update ? 'PATCH' : 'POST',
    );
  }

  const visiblePending = retained.context === contextKey ? pending : null;
  return (
    <section className="price-matrix-import card">
      <h2>Import macierzy cen z CSV / XML</h2>
      <p>
        Jeden plik, od 2 do 8 jawnie wybranych cenników. Wszystkie ceny zostaną zatwierdzone razem;
        błąd jednej listy blokuje całą partię.
      </p>
      {error && (
        <p className="pmi-error" role="alert">
          {error}
        </p>
      )}
      {status && readable && (
        <p className="pmi-status" role="status">
          {status}
        </p>
      )}
      {visiblePending && (
        <div className="pmi-pending" role="status">
          <strong>{remoteBusy ? 'Trwa żądanie.' : 'Nieznany wynik zapisu.'}</strong>
          <p>
            {visiblePending.label}. Zachowano dokładne dane i klucz próby. Odczyt historii nie usuwa
            tej blokady. Ponów ręcznie tę samą próbę, aby odzyskać wynik. Przeładowanie strony usuwa
            pamięć próby; wtedy najpierw sprawdź trwałą historię.
          </p>
          <button
            className="button primary"
            disabled={!authorizedWritable || busy || remoteBusy}
            onClick={() => void submit(visiblePending)}
          >
            Ponów dokładnie tę próbę
          </button>
        </div>
      )}
      {busy && <p role="status">Odczyt / przetwarzanie…</p>}
      {!readable ? (
        <p>
          {blocked
            ? 'Dostęp został odebrany. Dane importu usunięto z tego widoku.'
            : options && !options.available
              ? 'Import macierzy cen nie jest dostępny w tej wersji danych.'
              : 'Odczytywanie dostępności importu…'}
        </p>
      ) : (
        <>
          {!authorizedWritable && (
            <p className="pmi-hint">
              Tryb odczytu: możesz przeglądać trwałe podglądy, wyniki i profile. Import i zapis
              profili wymagają aktualnych uprawnień administratora.
            </p>
          )}
          {externalWriteBlocked && (
            <p className="pmi-hint">
              Nowe zapisy i zmiany konfiguracji są zablokowane do czasu rozstrzygnięcia operacji w
              sąsiednim panelu cen.
            </p>
          )}
          <nav className="pmi-toolbar" aria-label="Import macierzy cen">
            {(['import', 'profiles', 'history'] as const).map((name) => (
              <button
                key={name}
                className={`button ${tab === name ? 'primary' : ''}`}
                disabled={busy || remoteBusy}
                onClick={() => setTab(name)}
              >
                {name === 'import'
                  ? 'Plik i cenniki'
                  : name === 'profiles'
                    ? 'Profile mapowania'
                    : 'Historia'}
              </button>
            ))}
          </nav>
          {tab === 'import' && (
            <>
              <fieldset disabled={writeDisabled}>
                <legend>1. Wspólny plik i identyfikacja produktu</legend>
                <div className="pmi-grid">
                  <label>
                    Format
                    <select
                      value={common.format}
                      onChange={(e) =>
                        changeCommon({ ...common, format: e.target.value as Definition['format'] })
                      }
                    >
                      <option value="csv">CSV</option>
                      <option value="xml">XML</option>
                    </select>
                  </label>
                  <label>
                    Rozpoznawanie produktu
                    <select
                      value={common.identity}
                      onChange={(e) =>
                        changeCommon({
                          ...common,
                          identity: e.target.value as Definition['identity'],
                        })
                      }
                    >
                      <option value="uuid">ID produktu (UUID)</option>
                      <option value="sku">Aktualne SKU</option>
                      <option value="historical_sku">
                        SKU z uwzględnieniem wcześniejszych kodów
                      </option>
                      <option value="ean">EAN</option>
                      <option value="name">Nazwa produktu</option>
                    </select>
                  </label>
                  <label>
                    Pole identyfikatora
                    <input
                      value={common.mapping.identity}
                      onChange={(e) =>
                        changeCommon({
                          ...common,
                          mapping: { ...common.mapping, identity: e.target.value },
                        })
                      }
                    />
                  </label>
                  {common.format === 'csv' && (
                    <label>
                      Separator kolumn
                      <select
                        value={common.delimiter}
                        onChange={(e) =>
                          changeCommon({
                            ...common,
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
                    Plik UTF-8 · maks. 2 MiB
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".csv,.xml,text/csv,application/xml,text/xml"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void upload(f);
                      }}
                    />
                  </label>
                  <label>
                    Nazwa pliku
                    <input
                      value={fileName}
                      onChange={(e) => {
                        invalidate();
                        setFileName(e.target.value);
                      }}
                    />
                  </label>
                </div>
                {common.format === 'csv' && (
                  <label className="pmi-check">
                    <input
                      type="checkbox"
                      checked={common.spreadsheet_safe}
                      onChange={(e) =>
                        changeCommon({ ...common, spreadsheet_safe: e.target.checked })
                      }
                    />
                    Plik CSV pochodzi z eksportu „dla arkusza”: rozpoznaj ochronne apostrofy. Wyłącz
                    dla dokładnego tekstu z innego źródła.
                  </label>
                )}
                <label>
                  Treść pliku (możesz wkleić lub poprawić)
                  <textarea
                    rows={8}
                    value={content}
                    onChange={(e) => {
                      invalidate();
                      setContent(e.target.value);
                    }}
                  />
                </label>
                <small>
                  {bytes(content).toLocaleString('pl-PL')} bajtów · maks. 500 produktów / 4000
                  komórek. Nie obcinamy pliku ani zakresu.
                </small>
              </fieldset>
              <fieldset disabled={writeDisabled}>
                <legend>2. Cenniki i mapowanie ich cen · wybrano {targets.length} / 8</legend>
                <p>
                  Waluta pochodzi z każdego cennika. Import nie przelicza walut. Wybierz co najmniej
                  dwa cenniki.
                </p>
                <div className="pmi-list-options">
                  {lists.map((list) => (
                    <label className="pmi-check" key={list.id}>
                      <input
                        type="checkbox"
                        checked={targets.some((t) => t.price_list_id === list.id)}
                        disabled={
                          !targets.some((t) => t.price_list_id === list.id) && targets.length >= 8
                        }
                        onChange={(e) => toggleList(list, e.target.checked)}
                      />
                      <span>
                        {list.name} · {list.currency} · wersja {list.version}
                        {!list.active && ' · nieaktywny'}
                        {list.fallback && ' · reguła zastępcza'}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="pmi-toolbar">
                <button
                  className="button"
                  disabled={locked || !listCursor}
                  onClick={() => void read((e) => loadOptions(e, listCursor ?? undefined))}
                >
                  Dalsze cenniki
                </button>
                <button
                  className="button"
                  disabled={writeDisabled}
                  onClick={() =>
                    void read(async (e) => {
                      const current = await allCurrentLists(e);
                      const next = targets.map((t) => {
                        const l = current.find((x) => x.id === t.price_list_id);
                        if (!l)
                          throw new Error(
                            'Wybranego cennika nie ma w aktualnym zakresie. Nie odświeżono części wersji.',
                          );
                        return { ...t, list_version: l.version };
                      });
                      invalidate();
                      setTargets(next);
                      setStatus('Odczytano aktualne wersje wszystkich wybranych cenników.');
                    })
                  }
                >
                  Odczytaj aktualne wersje cenników
                </button>
              </div>
              {targets.map((target) => {
                const d = target.definition,
                  list = lists.find((l) => l.id === target.price_list_id);
                const change = (patch: Partial<Definition>) =>
                  changeTarget(target.price_list_id, { ...d, ...patch });
                const mapping = (key: keyof Definition['mapping'], value: string) => {
                  const next = { ...d.mapping };
                  if (value || key === 'identity' || key === 'price') next[key] = value;
                  else delete next[key];
                  change({ mapping: next });
                };
                const native = d.native_price_mode === 'own_entries';
                return (
                  <fieldset disabled={writeDisabled} key={target.price_list_id}>
                    <legend>
                      {list?.name ?? target.price_list_id} · {list?.currency} · wersja do podglądu{' '}
                      {target.list_version}
                    </legend>
                    <div className="pmi-grid">
                      {common.format === 'xml' && (
                        <label>
                          Odczyt cen z XML
                          <select
                            value={d.native_price_mode}
                            onChange={(e) =>
                              change(
                                e.target.value === 'own_entries'
                                  ? {
                                      native_price_mode: 'own_entries',
                                      mapping: { ...d.mapping, price: 'prices_json' },
                                      amount_mode: 'minor',
                                      basis: 'gross',
                                    }
                                  : { native_price_mode: 'mapped' },
                              )
                            }
                          >
                            <option value="mapped">Wskazane pole ceny</option>
                            <option value="own_entries">
                              Własne wpisy prices_json wybranego cennika
                            </option>
                          </select>
                        </label>
                      )}
                      <label>
                        Pole ceny
                        <input
                          disabled={native}
                          value={d.mapping.price}
                          onChange={(e) => mapping('price', e.target.value)}
                        />
                      </label>
                      <label>
                        Zapis kwoty
                        <select
                          disabled={native}
                          value={d.amount_mode}
                          onChange={(e) =>
                            change({ amount_mode: e.target.value as Definition['amount_mode'] })
                          }
                        >
                          <option value="decimal">Kwota dziesiętna (np. 12,99)</option>
                          <option value="minor">Najmniejsza jednostka (np. 1299)</option>
                        </select>
                      </label>
                      <label>
                        Separator dziesiętny
                        <select
                          disabled={native || d.amount_mode === 'minor'}
                          value={d.decimal_separator}
                          onChange={(e) =>
                            change({
                              decimal_separator: e.target.value as Definition['decimal_separator'],
                            })
                          }
                        >
                          <option value=",">Przecinek (,)</option>
                          <option value=".">Kropka (.)</option>
                        </select>
                      </label>
                      <label>
                        Kwota w pliku
                        <select
                          disabled={native}
                          value={d.basis}
                          onChange={(e) => change({ basis: e.target.value as Definition['basis'] })}
                        >
                          <option value="gross">Brutto</option>
                          <option value="net">Netto → brutto według VAT produktu</option>
                        </select>
                      </label>
                      <label>
                        Pusta komórka ceny
                        <select
                          value={d.empty_policy}
                          onChange={(e) =>
                            change({ empty_policy: e.target.value as Definition['empty_policy'] })
                          }
                        >
                          <option value="skip">Pomiń · zachowaj cenę</option>
                          <option value="remove">Usuń własną cenę</option>
                        </select>
                      </label>
                      <label>
                        Pole operacji (opcjonalne)
                        <input
                          value={d.mapping.operation ?? ''}
                          onChange={(e) => mapping('operation', e.target.value)}
                          placeholder="np. operation_pln"
                        />
                      </label>
                      <label>
                        Pole waluty (opcjonalne)
                        <input
                          value={d.mapping.currency ?? ''}
                          onChange={(e) => mapping('currency', e.target.value)}
                          placeholder="np. currency_pln"
                        />
                      </label>
                    </div>
                    {native && (
                      <p className="pmi-hint">
                        XML odtwarza własny wpis tej listy, także 0. Cena wynikająca z reguły lub
                        brak ceny oznacza usunięcie własnego wpisu. Brak wskazanej grupy cenowej w
                        XML jest błędem, a pozostałe grupy zostaną pominięte.
                      </p>
                    )}
                  </fieldset>
                );
              })}
              <p className="pmi-hint">
                Brak kolumny, pusta komórka i cena 0 mają różne znaczenie. Pomiń nie zmienia wpisu;
                usuń usuwa własny wpis i może odsłonić regułę albo pozostawić brak ceny. Cena
                wynikająca z reguły nie staje się automatycznie własnym wpisem. Wartości netto i
                wynik brutto zobaczysz przed zatwierdzeniem.
              </p>
              <p className="pmi-hint">
                Dla CSV wskaż osobne pola cen, np. price_pln i price_eur. Opcjonalne pole operacji
                przyjmuje set (ustaw), remove (usuń własny wpis) lub none (pomiń).
              </p>
              {targets.some((t) => t.definition.native_price_mode === 'own_entries') && (
                <label className="pmi-check">
                  <input
                    type="checkbox"
                    checked={nativeConsent}
                    disabled={writeDisabled}
                    onChange={(e) => setNativeConsent(e.target.checked)}
                  />
                  Rozumiem, że odtworzenie wpisów XML może usunąć własne ceny w wybranych cennikach.
                  Sprawdzę pełny podgląd przed wykonaniem.
                </label>
              )}
              <button
                className="button primary"
                disabled={writeDisabled || targets.length < 2 || !content.trim()}
                onClick={preview}
              >
                Utwórz trwały podgląd całej macierzy
              </button>
            </>
          )}
          {tab === 'profiles' && (
            <>
              <h3>Profile mapowania wielu cenników</h3>
              <p>
                Profil zapisuje pola i sposób interpretacji cen oraz konkretne cenniki. Nie zapisuje
                pliku ani zgody na zmianę cen.
              </p>
              <button
                className="button"
                disabled={busy || remoteBusy}
                onClick={() => void read(loadProfiles)}
              >
                Odczytaj profile
              </button>
              <div className="pmi-grid">
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
                    <option value="">Wybierz profil / zapisz nowy</option>
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
                <article className="pmi-product">
                  <h4>
                    {profile.name} · wersja {profile.version}
                  </h4>
                  {profile.targets.map((t) => (
                    <div className="pmi-profile-target" key={t.price_list_id}>
                      <strong>
                        {lists.find((l) => l.id === t.price_list_id)?.name ?? t.price_list_id}
                      </strong>
                      <DefinitionView value={t.definition} />
                    </div>
                  ))}
                  <button
                    className="button"
                    disabled={writeDisabled}
                    onClick={() => void read(applyProfile)}
                  >
                    Odczytaj bieżący profil i zastosuj aktualne wersje cenników
                  </button>
                </article>
              )}
              <p>Zapisywana konfiguracja: {targets.length} cenników z zakładki „Plik i cenniki”.</p>
              <button
                className="button primary"
                disabled={writeDisabled || targets.length < 2 || !profileName.trim()}
                onClick={() => saveProfile(false)}
              >
                Zapisz nowy profil z tej konfiguracji
              </button>
              {profile && (
                <>
                  <label className="pmi-check">
                    <input
                      type="checkbox"
                      checked={profileConsent}
                      disabled={writeDisabled}
                      onChange={(e) => setProfileConsent(e.target.checked)}
                    />
                    Zastąpię profil „{profile.name}”, wersja {profile.version}, obecną konfiguracją
                    macierzy.
                  </label>
                  <button
                    className="button"
                    disabled={
                      writeDisabled || !profileConsent || targets.length < 2 || !profileName.trim()
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
              <h3>Trwała historia macierzy</h3>
              <div className="pmi-toolbar">
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
              <div className="pmi-history">
                {history.map((head) => (
                  <button
                    className="button"
                    key={head.id}
                    disabled={busy || remoteBusy}
                    onClick={() =>
                      void read((e) =>
                        loadReview(
                          historyKind === 'previews' ? 'preview' : 'execution',
                          head.id,
                          e,
                        ),
                      )
                    }
                  >
                    {date(head.created_at)} · {head.file_name} · {head.summary.total_products}{' '}
                    produktów × {head.targets.length} cenników · zmiany {head.summary.changed} ·
                    błędy {head.summary.invalid + head.summary.conflicts}
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
            <section className="pmi-review">
              <h3>
                {review.kind === 'execution' ? 'Wynik całej macierzy' : 'Pełny podgląd macierzy'} ·{' '}
                {review.head.file_name}
              </h3>
              <p>
                {date(review.head.created_at)} · {review.head.summary.total_products} produktów ·{' '}
                {review.head.summary.total_cells} komórek · zmiany {review.head.summary.changed} ·
                bez zmian {review.head.summary.unchanged} · błędy {review.head.summary.invalid} ·
                konflikty {review.head.summary.conflicts}
              </p>
              {review.head.warnings.length > 0 && (
                <ul className="pmi-hint">
                  {review.head.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="pmi-target-summaries">
                {review.head.targets.map((t) => (
                  <article className="pmi-product" key={t.price_list_id}>
                    <h4>
                      {t.list_snapshot.name} · {t.list_snapshot.currency} · wersja{' '}
                      {t.list_snapshot.version}
                    </h4>
                    <DefinitionView value={t.definition} />
                    <p>
                      Komórki {t.summary.total} · zmiany {t.summary.changed} · bez zmian{' '}
                      {t.summary.unchanged} · błędy {t.summary.invalid} · konflikty{' '}
                      {t.summary.conflicts} · braki ceny po operacji {t.summary.missing_after_count}
                    </p>
                    {t.warnings.length > 0 && (
                      <ul className="pmi-hint">
                        {t.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </article>
                ))}
              </div>
              {review.complete ? (
                <RowsView key={`${review.kind}:${review.head.id}`} review={review} />
              ) : (
                <p className="pmi-hint">
                  Nie odczytano jeszcze wszystkich stron produktów i komórek. Zatwierdzenie jest
                  zablokowane.
                </p>
              )}
              {review.kind === 'preview' && (
                <>
                  <div className="pmi-toolbar">
                    <button
                      className="button"
                      disabled={busy || remoteBusy}
                      onClick={() => void read((e) => loadReview('preview', review.head.id, e))}
                    >
                      Odczytaj ponownie cały podgląd
                    </button>
                    {review.head.execution_id && (
                      <button
                        className="button"
                        disabled={busy || remoteBusy}
                        onClick={() =>
                          void read((e) => loadReview('execution', review.head.execution_id!, e))
                        }
                      >
                        Odczytaj istniejący wynik
                      </button>
                    )}
                  </div>
                  {!review.head.summary.ready && (
                    <p className="pmi-error">
                      Cała partia jest zablokowana. Popraw błędy lub konflikty i utwórz nowy
                      podgląd.
                    </p>
                  )}
                  {!review.head.can_execute && (
                    <p className="pmi-hint">
                      Ten podgląd nie może zostać wykonany. Jeśli istnieje wynik, odczytaj go; po
                      konflikcie utwórz nowy podgląd.
                    </p>
                  )}
                  <label className="pmi-check">
                    <input
                      type="checkbox"
                      disabled={
                        writeDisabled ||
                        !review.complete ||
                        !review.head.summary.ready ||
                        !review.head.can_execute
                      }
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    Sprawdziłem pełny zakres {review.head.summary.total_products} produktów i{' '}
                    {review.head.summary.total_cells} komórek we wszystkich{' '}
                    {review.head.targets.length} cennikach. Zatwierdzam dokładnie te zmiany jako
                    jedną partię.
                  </label>
                  {review.head.targets
                    .filter((t) => t.summary.missing_after_count > 0)
                    .map((t) => (
                      <label className="pmi-check" key={t.price_list_id}>
                        <input
                          type="checkbox"
                          checked={!!missing[t.price_list_id]}
                          disabled={writeDisabled || !review.complete}
                          onChange={(e) =>
                            setMissing((old) => ({ ...old, [t.price_list_id]: e.target.checked }))
                          }
                        />
                        Świadomie pozostawiam brak ceny dla {t.summary.missing_after_count}{' '}
                        produktów w cenniku „{t.list_snapshot.name}” ({t.list_snapshot.currency}).
                        Brak ceny nie oznacza 0.
                      </label>
                    ))}
                  <button
                    className="button primary"
                    disabled={
                      writeDisabled ||
                      !review.complete ||
                      !review.head.summary.ready ||
                      !review.head.can_execute ||
                      !consent ||
                      review.head.targets.some(
                        (t) => t.summary.missing_after_count > 0 && !missing[t.price_list_id],
                      )
                    }
                    onClick={execute}
                  >
                    Zatwierdź całą macierz cen
                  </button>
                </>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
