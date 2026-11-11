import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './price-file-import.css';

export type PriceFileImportWorkspaceProps = {
  contextKey: string;
  readOnly: boolean;
  externalWriteBlocked?: boolean;
  onApplied?: () => void;
  onError?: (message: string) => void;
  onLockedChange?: (locked: boolean) => void;
};
type Attempt = {
  context: string;
  kind: 'preview' | 'execute' | 'profile';
  path: string;
  method: 'POST' | 'PATCH';
  serialized: string;
  label: string;
};
// Deliberately RAM-only: navigation may retain an uncertain request; actor changes purge it.
const retained: { context: string; attempt: Attempt | null; inFlight: boolean } = {
  context: '',
  attempt: null,
  inFlight: false,
};
const listeners = new Set<() => void>();
function publish() {
  listeners.forEach((listener) => listener());
}
export function resetPriceFileImportContext(contextKey: string) {
  retained.context = contextKey;
  retained.attempt = null;
  retained.inFlight = false;
  publish();
}
const prefix = '/price-file-imports';
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function amount(value: number | null | undefined, currency: string) {
  if (value === null || value === undefined) return 'Brak ceny';
  if (!Number.isSafeInteger(value)) return 'Nieprawidłowa kwota';
  const minor = BigInt(value);
  return `${minor / 100n},${String(minor % 100n).padStart(2, '0')} ${currency}`;
}

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
type Options = Flags & {
  catalog_currency: string;
  price_lists: List[];
  meta: { cursor: string | null; total?: number };
  limits: {
    rows: number;
    file_bytes: number;
    request_bytes: number;
    page: number;
    profiles: number;
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
type Head = {
  id: string;
  price_list_id?: string;
  list_snapshot: List;
  definition?: Definition;
  warnings: string[];
  summary: Summary;
  scope_hash: string;
  created_at: string;
  core_preview_id: string;
  execution_id?: string | null;
  can_execute?: boolean;
  preview_id?: string;
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
type Row = {
  index: number;
  raw_cells: Record<string, unknown>;
  resolution: { identity: string; value: string | null; matched_historical_sku: boolean };
  product_id: string | null;
  sku: string | null;
  name: string | null;
  input: null | {
    operation: 'none' | 'set' | 'remove';
    basis?: 'gross' | 'net';
    amount_minor?: number;
  };
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict';
  errors: string[];
  before: Price | null;
  after: Price | null;
  skipped_price_groups: number;
};
type Profile = {
  id: string;
  name: string;
  version: number;
  definition: Definition;
  price_list_id: string | null;
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null; total: number } };
type Detail = Flags & { preview?: Head; execution?: Head; reused?: boolean };
type ProfileReply = Flags & { profile: Profile; reused?: boolean };
type Review = {
  kind: 'preview' | 'execution';
  head: Head;
  definition: Definition;
  rows: Row[];
  complete: boolean;
};
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
const sourceLabels = { override: 'Własna cena', rule: 'Reguła cennika', missing: 'Brak ceny' };
const statusLabels = {
  changed: 'Zmiana',
  unchanged: 'Bez zmian',
  invalid: 'Błąd',
  conflict: 'Konflikt',
};
function DefinitionView({ value }: { value: Definition }) {
  return (
    <dl className="pfi-definition">
      <div>
        <dt>Format i tożsamość</dt>
        <dd>
          {value.format.toUpperCase()} ·{' '}
          {value.identity === 'uuid'
            ? 'ID produktu'
            : value.identity === 'ean'
              ? 'EAN'
              : value.identity === 'name'
                ? 'Nazwa'
                : 'SKU'}{' '}
          · pole {value.mapping.identity}
        </dd>
      </div>
      <div>
        <dt>Kwota</dt>
        <dd>
          {value.native_price_mode === 'own_entries'
            ? 'Własne wpisy z prices_json, brutto w najmniejszej jednostce'
            : `${value.mapping.price} · ${value.amount_mode === 'minor' ? 'najmniejsza jednostka' : `dziesiętnie, separator ${value.decimal_separator}`} · ${value.basis === 'net' ? 'netto → brutto' : 'brutto'}`}
        </dd>
      </div>
      <div>
        <dt>Pusta cena</dt>
        <dd>{value.empty_policy === 'skip' ? 'Pomiń' : 'Usuń własną cenę'}</dd>
      </div>
      <div>
        <dt>Operacja i waluta z pliku</dt>
        <dd>
          {value.mapping.operation ?? 'Operacja na podstawie ceny'} ·{' '}
          {value.mapping.currency ?? 'Waluta wybranego cennika'}
        </dd>
      </div>
      <div>
        <dt>CSV dla arkusza</dt>
        <dd>
          {value.spreadsheet_safe
            ? 'Jawna interpretacja ochronnych apostrofów'
            : 'Dokładny tekst bez usuwania apostrofów'}
        </dd>
      </div>
    </dl>
  );
}
function PriceView({ value }: { value: Price | null }) {
  return value ? (
    <div className="pfi-price">
      <strong>{amount(value.effective_price, value.currency)}</strong>
      <span>{sourceLabels[value.source]}</span>
      <small>
        Własny wpis:{' '}
        {value.override_present ? amount(value.override_price, value.currency) : 'Nie istnieje'} ·
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
  ) : (
    <span>Brak poprawnego wyniku</span>
  );
}
function RowsView({ rows, currency }: { rows: Row[]; currency: string }) {
  const [filter, setFilter] = useState<'all' | 'errors' | 'changes'>('all');
  const visible = rows.filter(
    (r) =>
      filter === 'all' ||
      (filter === 'errors'
        ? r.errors.length > 0 || ['invalid', 'conflict'].includes(r.status)
        : r.status === 'changed'),
  );
  return (
    <div>
      <div className="pfi-toolbar">
        <label>
          Widok wierszy
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">Wszystkie · {rows.length}</option>
            <option value="errors">Błędy i konflikty</option>
            <option value="changes">Zmiany</option>
          </select>
        </label>
      </div>
      {!visible.length && <p>Brak wierszy w tym widoku.</p>}
      <div className="pfi-scroll">
        <table>
          <thead>
            <tr>
              <th>Wiersz i produkt</th>
              <th>Wejście z pliku</th>
              <th>Przed</th>
              <th>Po</th>
              <th>Wynik</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.index}>
                <td>
                  <strong>
                    {r.index + 1}. {r.sku ?? 'Bez dopasowania'}
                  </strong>
                  <small>{r.name}</small>
                  <small>{r.product_id}</small>
                </td>
                <td>
                  {Object.entries(r.raw_cells ?? {}).map(([key, value]) => (
                    <small key={key}>
                      {key}:{' '}
                      {value === null
                        ? 'Brak (null)'
                        : value === ''
                          ? 'Puste'
                          : typeof value === 'object'
                            ? JSON.stringify(value)
                            : String(value)}
                    </small>
                  ))}
                  {r.input && (
                    <small>
                      <strong>
                        {r.input.operation === 'remove'
                          ? 'Usuń własną cenę'
                          : r.input.operation === 'none'
                            ? 'Pomiń'
                            : `Ustaw ${r.input.basis === 'net' ? 'netto' : 'brutto'}`}
                      </strong>
                      {r.input.amount_minor !== undefined &&
                        ` · ${amount(r.input.amount_minor, currency)}`}
                    </small>
                  )}
                  <small>Identyfikator z pliku: {r.resolution.value ?? 'Brak'}</small>
                  {r.resolution.matched_historical_sku && (
                    <small>
                      Wcześniejsze SKU dopasowano do tego samego produktu. Aktualne SKU pokazano po
                      lewej; kod nie zostanie zmieniony.
                    </small>
                  )}
                  {r.skipped_price_groups > 0 && (
                    <small>
                      Pominięte pozostałe cenniki w XML: {r.skipped_price_groups}. Ten import
                      dotyczy wyłącznie wskazanego cennika.
                    </small>
                  )}
                </td>
                <td>
                  <PriceView value={r.before} />
                </td>
                <td>
                  <PriceView value={r.after} />
                </td>
                <td>
                  <strong>{statusLabels[r.status]}</strong>
                  {r.errors.length > 0 && (
                    <ul>
                      {r.errors.map((error, i) => (
                        <li key={i}>{error}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PriceFileImportWorkspace({
  contextKey,
  readOnly,
  externalWriteBlocked = false,
  onApplied,
  onError,
  onLockedChange,
}: PriceFileImportWorkspaceProps) {
  const [options, setOptions] = useState<Options | null>(null);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [listId, setListId] = useState('');
  const [definition, setDefinition] = useState<Definition>(initialDefinition);
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<'import' | 'history' | 'profiles'>('import');
  const [review, setReview] = useState<Review | null>(null);
  const [consent, setConsent] = useState(false);
  const [missingConsent, setMissingConsent] = useState(false);
  const [nativeConsent, setNativeConsent] = useState(false);
  const [historyKind, setHistoryKind] = useState<'previews' | 'executions'>('executions');
  const [history, setHistory] = useState<Head[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileConsent, setProfileConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [writeBlocked, setWriteBlocked] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const epoch = useRef(0),
    readId = useRef(0),
    localBusy = useRef(false),
    authorized = useRef<string | null>(null);
  const currentContext = useRef('');
  currentContext.current = `${contextKey}:${readOnly}`;
  const flagsRef = useRef<Flags | null>(null);
  flagsRef.current = flags;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const externalLockRef = useRef(externalWriteBlocked);
  externalLockRef.current = externalWriteBlocked;
  const readable =
    !!flags?.available &&
    flags.can_read &&
    !blocked &&
    authorized.current === currentContext.current;
  const authorizedWritable =
    readable && !!flags?.can_write && !flags.read_only && !readOnly && !writeBlocked;
  const writable = authorizedWritable && !externalWriteBlocked;
  const locked = busy || remoteBusy || !!pending;
  const selectedList = lists.find((list) => list.id === listId);
  const profile = profiles.find((item) => item.id === profileId);
  const writeDisabled = !writable || locked;

  function clearSensitive() {
    setContent('');
    setFileName('');
    setDefinition(initialDefinition());
    setListId('');
    setReview(null);
    setConsent(false);
    setMissingConsent(false);
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
    clearSensitive();
    setHistory([]);
    setHistoryLoaded(false);
    setHistoryCursor(null);
    setBusy(false);
    resetPriceFileImportContext(contextKeyRef.current);
  }
  function accept(d: Flags) {
    if (!d.can_read) {
      purge();
      return false;
    }
    const old = flagsRef.current;
    if (old?.can_write && (!d.can_write || d.read_only || old.current_role !== d.current_role)) {
      clearSensitive();
      resetPriceFileImportContext(contextKeyRef.current);
    }
    authorized.current = currentContext.current;
    flagsRef.current = d;
    setFlags(d);
    return d.available;
  }
  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    const message =
      err instanceof Error ? err.message : 'Nie udało się wykonać operacji importu cen.';
    setError(message);
    onError?.(message);
    if (err instanceof ApiError && [401, 403].includes(err.status)) purge();
    else if (err instanceof ApiError && err.status === 423) {
      setWriteBlocked(true);
      clearSensitive();
      resetPriceFileImportContext(contextKeyRef.current);
      setFlags((f) => (f ? { ...f, can_write: false, read_only: true } : f));
    }
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    const scope = currentContext.current;
    try {
      const d = await api<T>(prefix + path, method, body);
      if (e !== epoch.current || scope !== currentContext.current)
        throw new DOMException('Kontekst został zmieniony.', 'AbortError');
      return d;
    } catch (err) {
      if (e !== epoch.current || scope !== currentContext.current)
        throw new DOMException('Kontekst został zmieniony.', 'AbortError');
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
    setMissingConsent(false);
    setNativeConsent(false);
    setProfileConsent(false);
    setError('');
    setStatus('');
  }
  function configure(next: Definition) {
    invalidate();
    setDefinition(next);
  }
  async function loadOptions(e: number, cursor?: string) {
    const d = await request<Options>(
      '/options' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
      e,
    );
    if (!accept(d) && d.available) return;
    setOptions(d);
    setLists((old) =>
      cursor
        ? [
            ...old.filter((list) => !d.price_lists.some((next) => next.id === list.id)),
            ...d.price_lists,
          ]
        : d.price_lists,
    );
    setListCursor(d.meta.cursor);
  }
  async function loadProfiles(e: number) {
    const all: Profile[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const d: Page<Profile> = await request<Page<Profile>>(
        '/profiles' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        e,
      );
      if (!accept(d)) return;
      if (d.meta.total > 100)
        throw new Error('Lista profili przekracza dopuszczalny zakres. Nie obcięto wyników.');
      all.push(...d.data);
      if (all.length > 100 || (d.meta.cursor && seen.has(d.meta.cursor)))
        throw new Error('Nie można potwierdzić kompletności profili.');
      cursor = d.meta.cursor;
      if (cursor) seen.add(cursor);
      if (!cursor && all.length !== d.meta.total)
        throw new Error('Nie odczytano pełnej listy profili.');
    } while (cursor);
    setProfiles(all);
  }
  async function loadReview(kind: 'preview' | 'execution', id: string, e: number) {
    const base = `/${kind === 'preview' ? 'previews' : 'executions'}/${encodeURIComponent(id)}`;
    const d = await request<Detail>(base, e);
    if (!accept(d)) return;
    const head = kind === 'preview' ? d.preview : d.execution;
    if (!head) throw new Error('Brak nagłówka trwałego podglądu lub wykonania.');
    let frozenDefinition = head.definition;
    if (!frozenDefinition && kind === 'execution' && head.preview_id) {
      const original = await request<Detail>(`/previews/${encodeURIComponent(head.preview_id)}`, e);
      if (!accept(original)) return;
      frozenDefinition = original.preview?.definition;
    }
    if (!frozenDefinition) throw new Error('Nie odczytano niezmiennej konfiguracji tego importu.');
    setReview({ kind, head, definition: frozenDefinition, rows: [], complete: false });
    setConsent(false);
    setMissingConsent(false);
    const rows: Row[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Page<Row> = await request<Page<Row>>(
        base + '/rows' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        e,
      );
      if (!accept(page)) return;
      if (page.meta.total !== head.summary.total || page.meta.total > 500)
        throw new Error('Zakres stron różni się od nagłówka. Zapis zablokowany.');
      rows.push(...page.data);
      if (rows.length > 500 || (page.meta.cursor && seen.has(page.meta.cursor)))
        throw new Error('Nie można potwierdzić pełnego zakresu wierszy.');
      cursor = page.meta.cursor;
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (
      rows.length !== head.summary.total ||
      new Set(rows.map((r) => r.index)).size !== rows.length
    )
      throw new Error(
        'Brakuje wierszy albo strony zawierają duplikaty. Nie można zatwierdzić importu.',
      );
    setReview({ kind, head, definition: frozenDefinition, rows, complete: true });
  }
  async function loadHistory(e: number, more = false) {
    const d = await request<Page<Head>>(
      `/${historyKind}` +
        (more && historyCursor ? `?cursor=${encodeURIComponent(historyCursor)}` : ''),
      e,
    );
    if (!accept(d)) return;
    setHistory((old) => (more ? [...old, ...d.data] : d.data));
    setHistoryCursor(d.meta.cursor);
    setHistoryLoaded(true);
  }

  useEffect(() => {
    const sync = () => {
      setPending(retained.context === contextKey ? retained.attempt : null);
      setRemoteBusy(retained.context === contextKey && retained.inFlight);
    };
    if (retained.context !== contextKey || readOnly) resetPriceFileImportContext(contextKey);
    listeners.add(sync);
    sync();
    const e = ++epoch.current;
    ++readId.current;
    localBusy.current = false;
    authorized.current = null;
    flagsRef.current = null;
    setFlags(null);
    setOptions(null);
    setLists([]);
    setListCursor(null);
    setBlocked(false);
    setWriteBlocked(false);
    clearSensitive();
    setHistory([]);
    setHistoryLoaded(false);
    setHistoryCursor(null);
    setError('');
    setStatus('');
    setBusy(true);
    localBusy.current = true;
    void loadOptions(e)
      .catch((err) => {
        if (e === epoch.current) fail(err);
      })
      .finally(() => {
        if (e === epoch.current) {
          setBusy(false);
          localBusy.current = false;
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
        if (!d.profile) throw new Error('Nie otrzymano profilu. Odczytaj listę profili.');
        if (retained.attempt === a) {
          retained.attempt = null;
          publish();
        }
        setProfileId(d.profile.id);
        setProfileName(d.profile.name);
        setProfileConsent(false);
        setStatus(
          d.reused
            ? 'Odnaleziono wcześniej zapisany profil; odczytaj jego bieżącą definicję przed użyciem.'
            : 'Profil mapowania zapisany.',
        );
        await loadProfiles(e);
      } else {
        const kind = a.kind === 'execute' ? 'execution' : 'preview';
        const head = kind === 'execution' ? d.execution : d.preview;
        if (!head)
          throw new Error(
            'Odpowiedź nie zawiera identyfikatora. Odczytaj trwałą historię przed kolejnym zapisem.',
          );
        if (retained.attempt === a) {
          retained.attempt = null;
          publish();
        }
        await loadReview(kind, head.id, e);
        setStatus(
          kind === 'execution'
            ? d.reused
              ? 'Odczytano wcześniejsze wykonanie. Nie zapisano cen ponownie.'
              : 'Import cen wykonany. Wynik poniżej.'
            : d.reused
              ? 'Odczytano wcześniej utworzony podgląd.'
              : 'Trwały podgląd gotowy do przeglądu.',
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
        setMissingConsent(false);
        fail(err);
      } else {
        fail(err);
        if (retained.attempt === a)
          setStatus(
            'Wynik zapisu jest nieznany. Zachowano dokładne żądanie; nowy zapis pozostaje zablokowany.',
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
      scope = currentContext.current,
      id = ++readId.current;
    localBusy.current = true;
    setBusy(true);
    invalidate();
    try {
      if (file.size > options.limits.file_bytes)
        throw new Error('Plik przekracza limit 2 MiB. Nie obcięto jego treści.');
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (e !== epoch.current || scope !== currentContext.current) return;
      if (bytes(decoded) > options.limits.file_bytes)
        throw new Error('Treść przekracza limit 2 MiB.');
      setContent(decoded);
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
      if (!options || !selectedList || !content.trim())
        throw new Error('Wybierz własny cennik i wczytaj treść pliku.');
      if (bytes(content) > options.limits.file_bytes)
        throw new Error('Treść przekracza limit 2 MiB.');
      if (
        definition.format === 'xml' &&
        definition.native_price_mode === 'own_entries' &&
        !nativeConsent
      )
        throw new Error('Potwierdź odtworzenie własnych wpisów z XML.');
      const body = {
        client_key: crypto.randomUUID(),
        price_list_id: selectedList.id,
        list_version: selectedList.version,
        file_name: fileName || 'tekst-wklejony',
        content,
        definition,
      };
      if (bytes(JSON.stringify(body)) > options.limits.request_bytes)
        throw new Error('Żądanie przekracza limit rozmiaru. Nie wysłano pliku.');
      attempt('preview', '/previews', body, 'Utworzenie podglądu importu cen');
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
      !consent ||
      (review.head.summary.missing_after_count > 0 && !missingConsent)
    )
      return;
    attempt(
      'execute',
      `/previews/${review.head.id}/execute`,
      {
        client_key: crypto.randomUUID(),
        scope_hash: review.head.scope_hash,
        confirmed: true,
        ack_missing_prices: missingConsent,
      },
      'Wykonanie zaakceptowanego importu cen',
    );
  }
  function saveProfile(update: boolean) {
    try {
      const name = profileName.trim();
      if (!name || name.length > 120) throw new Error('Nazwa profilu wymaga 1–120 znaków.');
      if (update && (!profile || !profileConsent))
        throw new Error('Wybierz profil i potwierdź jego aktualizację.');
      const body = {
        client_key: crypto.randomUUID(),
        name,
        definition,
        price_list_id: listId || null,
        ...(update && profile ? { version: profile.version } : {}),
      };
      attempt(
        'profile',
        update && profile ? `/profiles/${profile.id}` : '/profiles',
        body,
        update ? 'Aktualizacja profilu mapowania' : 'Utworzenie profilu mapowania',
        update ? 'PATCH' : 'POST',
      );
    } catch (err) {
      fail(err);
    }
  }
  async function applyProfile(e: number) {
    if (!profileId || externalLockRef.current) return;
    const d = await request<ProfileReply>(`/profiles/${encodeURIComponent(profileId)}`, e);
    if (!accept(d)) return;
    if (externalLockRef.current) return;
    invalidate();
    setDefinition(JSON.parse(JSON.stringify(d.profile.definition)) as Definition);
    setProfileName(d.profile.name);
    if (d.profile.price_list_id && !lists.some((list) => list.id === d.profile.price_list_id)) {
      setListId('');
      setStatus(
        'Mapowanie zastosowane. Powiązany cennik nie jest na odczytanej liście; odczytaj dalsze cenniki i wybierz go jawnie.',
      );
    } else {
      setListId(d.profile.price_list_id ?? '');
      setStatus('Zastosowano kopię mapowania. Sprawdź cennik i plik przed podglądem.');
    }
    setProfiles((old) => old.map((p) => (p.id === d.profile.id ? d.profile : p)));
    setTab('import');
  }

  return (
    <section className="price-file-import panel" aria-label="Import cen z pliku">
      <h2>Import cen z pliku</h2>
      <p>
        CSV lub XML → wybrany cennik → pełny podgląd → zatwierdzenie. Import aktualizuje istniejące
        produkty; ceny zamówień i stany magazynowe pozostają bez zmian.
      </p>
      <div className="pfi-toolbar" role="tablist" aria-label="Proces importu cen">
        {(['import', 'history', 'profiles'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'button primary' : 'button'}
            disabled={busy || remoteBusy}
            onClick={() => setTab(t)}
          >
            {t === 'import' ? 'Import' : t === 'history' ? 'Historia' : 'Profile mapowania'}
          </button>
        ))}
      </div>
      {error && (
        <p className="pfi-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="pfi-status" role="status">
          {status}
        </p>
      )}
      {pending && (
        <div className="pfi-pending" role="status">
          <strong>Niepewny wynik: {pending.label}</strong>
          <p>
            Zachowano treść i klucz próby w pamięci. Nie rozpoczynaj nowego importu. Ręczne
            ponowienie odczyta wcześniejszy rezultat, jeśli zapis już nastąpił. Odświeżenie
            przeglądarki usuwa tę pamięć — najpierw sprawdź trwałą historię.
          </p>
          <button
            type="button"
            className="button"
            disabled={!authorizedWritable || busy || remoteBusy}
            onClick={() => void submit(pending)}
          >
            Ponów dokładnie tę próbę
          </button>
        </div>
      )}
      {busy || remoteBusy ? <p role="status">Odczyt lub zapis w toku…</p> : null}
      {!options && !blocked && (
        <button
          type="button"
          className="button"
          disabled={busy || remoteBusy}
          onClick={() => void read((e) => loadOptions(e))}
        >
          Odczytaj dostępność ponownie
        </button>
      )}
      {options && !options.available && (
        <p>Import cen jest niedostępny w tej kopii. Nie zmieniono cenników.</p>
      )}
      {readable && !authorizedWritable && (
        <p className="pfi-hint">
          Tryb odczytu. Możesz przeglądać historię i profile; tworzenie podglądu i zapis są
          niedostępne.
        </p>
      )}
      {readable && externalWriteBlocked && (
        <p className="pfi-hint">
          Nowe zapisy i zmiany konfiguracji są zablokowane do czasu rozstrzygnięcia operacji w
          panelu macierzy cen. Własną zachowaną próbę możesz ponowić ręcznie.
        </p>
      )}
      {tab === 'import' && readable && (
        <>
          <fieldset disabled={writeDisabled}>
            <legend>1. Cennik i format</legend>
            <div className="pfi-grid">
              <label>
                Cennik
                <select
                  value={listId}
                  onChange={(e) => {
                    invalidate();
                    setListId(e.target.value);
                  }}
                >
                  <option value="">Wybierz cennik</option>
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name} · {list.currency} · v{list.version}
                      {list.active ? '' : ' · nieaktywny'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Format
                <select
                  value={definition.format}
                  onChange={(e) =>
                    configure({
                      ...definition,
                      format: e.target.value as Definition['format'],
                      native_price_mode: 'mapped',
                    })
                  }
                >
                  <option value="csv">CSV z mapowaniem kolumn</option>
                  <option value="xml">Natywny XML eksportu katalogu</option>
                </select>
              </label>
              <label>
                Identyfikacja
                <select
                  value={definition.identity}
                  onChange={(e) =>
                    configure({ ...definition, identity: e.target.value as Definition['identity'] })
                  }
                >
                  <option value="sku">SKU (także wcześniejszy kod)</option>
                  <option value="historical_sku">SKU z uwzględnieniem wcześniejszych kodów</option>
                  <option value="uuid">ID produktu (UUID)</option>
                  <option value="ean">EAN — tylko jednoznaczny</option>
                  <option value="name">Nazwa — tylko jednoznaczna</option>
                </select>
              </label>
            </div>
            {selectedList && (
              <p className="pfi-hint">
                Wybrano:{' '}
                <strong>
                  {selectedList.name} · {selectedList.currency}
                </strong>
                , wersja {selectedList.version}. Nie ma przeliczania walut.
                {!selectedList.active &&
                  ' Cennik jest nieaktywny; import go nie włączy i nowa wycena nie użyje go do czasu włączenia.'}
              </p>
            )}
          </fieldset>
          {listCursor && (
            <button
              className="button"
              type="button"
              disabled={locked}
              onClick={() => void read((e) => loadOptions(e, listCursor))}
            >
              Odczytaj dalsze cenniki
            </button>
          )}
          <button
            className="button"
            type="button"
            disabled={locked}
            onClick={() =>
              void read(async (e) => {
                invalidate();
                await loadOptions(e);
                setStatus(
                  'Odczytano aktualne cenniki i wersje. Sprawdź wybrany zakres przed nowym podglądem.',
                );
              })
            }
          >
            Odśwież cenniki i wersje
          </button>
          <fieldset disabled={writeDisabled}>
            <legend>2. Plik i mapowanie</legend>
            <label>
              Plik UTF-8 (do 2 MiB)
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
              Treść pliku
              <textarea
                rows={7}
                value={content}
                onChange={(e) => {
                  invalidate();
                  setContent(e.target.value);
                  setFileName('');
                }}
                placeholder={'sku;price\nPRODUKT-1;123,01'}
              />
            </label>
            <small>
              {fileName || 'Tekst wpisany ręcznie'} · {bytes(content)} /{' '}
              {options?.limits.file_bytes ?? 2097152} bajtów · do 500 produktów
            </small>
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
                  <option value=";">Średnik</option>
                  <option value=",">Przecinek</option>
                  <option value={'\t'}>Tabulator</option>
                </select>
              </label>
            )}
            {definition.format === 'xml' && (
              <label>
                Źródło ceny w XML
                <select
                  value={definition.native_price_mode}
                  onChange={(e) => {
                    const native = e.target.value === 'own_entries';
                    configure({
                      ...definition,
                      native_price_mode: native ? 'own_entries' : 'mapped',
                      ...(native
                        ? {
                            mapping: {
                              identity: definition.mapping.identity,
                              price: 'prices_json',
                            },
                            amount_mode: 'minor',
                            basis: 'gross',
                          }
                        : {}),
                    });
                  }}
                >
                  <option value="mapped">Pole ceny wskazane w mapowaniu</option>
                  <option value="own_entries">Własne wpisy wybranego cennika z prices_json</option>
                </select>
              </label>
            )}
            <div className="pfi-grid">
              {(['identity', 'price', 'operation', 'currency'] as const).map((key) => (
                <label key={key}>
                  {key === 'identity'
                    ? 'Kolumna / pole identyfikatora'
                    : key === 'price'
                      ? 'Kolumna / pole ceny'
                      : key === 'operation'
                        ? 'Kolumna operacji (opcjonalna)'
                        : 'Kolumna waluty (opcjonalna)'}
                  <input
                    value={definition.mapping[key] ?? ''}
                    disabled={definition.native_price_mode === 'own_entries' && key !== 'identity'}
                    onChange={(e) => {
                      const mapping = { ...definition.mapping };
                      if ((key === 'operation' || key === 'currency') && !e.target.value)
                        delete mapping[key];
                      else mapping[key] = e.target.value;
                      configure({ ...definition, mapping });
                    }}
                  />
                </label>
              ))}
            </div>
            <p className="pfi-hint">
              Operacje w pliku: set — ustaw własną cenę; remove — usuń własny wpis; none — pomiń.
              Brak dopasowania, niejednoznaczność lub powtórzony produkt blokują całą partię. Import
              nie tworzy produktów ani nie zmienia SKU.
            </p>
          </fieldset>
          <fieldset disabled={writeDisabled}>
            <legend>3. Znaczenie kwot i pustych pól</legend>
            <div className="pfi-grid">
              <label>
                Zapis kwoty
                <select
                  value={definition.amount_mode}
                  disabled={definition.native_price_mode === 'own_entries'}
                  onChange={(e) =>
                    configure({
                      ...definition,
                      amount_mode: e.target.value as Definition['amount_mode'],
                    })
                  }
                >
                  <option value="decimal">Kwota dziesiętna, np. 123,01</option>
                  <option value="minor">Najmniejsza jednostka, np. 12301</option>
                </select>
              </label>
              <label>
                Separator dziesiętny
                <select
                  value={definition.decimal_separator}
                  onChange={(e) =>
                    configure({
                      ...definition,
                      decimal_separator: e.target.value as Definition['decimal_separator'],
                    })
                  }
                >
                  <option value=",">Przecinek</option>
                  <option value=".">Kropka</option>
                </select>
              </label>
              <label>
                Podstawa ceny
                <select
                  value={definition.basis}
                  disabled={definition.native_price_mode === 'own_entries'}
                  onChange={(e) =>
                    configure({ ...definition, basis: e.target.value as Definition['basis'] })
                  }
                >
                  <option value="gross">Brutto</option>
                  <option value="net">Netto → brutto według VAT produktu</option>
                </select>
              </label>
              <label>
                Pusta cena
                <select
                  value={definition.empty_policy}
                  onChange={(e) =>
                    configure({
                      ...definition,
                      empty_policy: e.target.value as Definition['empty_policy'],
                    })
                  }
                >
                  <option value="skip">Pomiń — zachowaj wpis</option>
                  <option value="remove">Usuń własną cenę</option>
                </select>
              </label>
            </div>
            <label className="pfi-check">
              <input
                type="checkbox"
                checked={definition.spreadsheet_safe}
                onChange={(e) => configure({ ...definition, spreadsheet_safe: e.target.checked })}
              />
              Plik pochodzi z eksportu CSV dla arkusza — interpretuj jego ochronne apostrofy.
            </label>
            <p>
              Zero jest własną ceną 0,00. Usunięcie wpisu może włączyć regułę albo pozostawić brak
              ceny. Netto przeliczane jest dokładnie do brutto według zamrożonego VAT; wynik pokaże
              podgląd. Bez wykładnika, separatorów tysięcy i niejawnego zaokrąglania wejścia.
            </p>
            {definition.format === 'xml' && definition.native_price_mode === 'own_entries' && (
              <label className="pfi-check">
                <input
                  type="checkbox"
                  checked={nativeConsent}
                  onChange={(e) => setNativeConsent(e.target.checked)}
                />
                Rozumiem odtworzenie własnych wpisów: własna cena, także zero, zostanie ustawiona;
                źródło reguła lub brak usunie własną cenę. Bieżąca reguła może dać inną cenę
                efektywną. Podgląd pokaże wynik dla wybranego cennika.
              </label>
            )}
            <button
              type="button"
              className="button primary"
              disabled={
                !selectedList ||
                !content.trim() ||
                (definition.format === 'xml' &&
                  definition.native_price_mode === 'own_entries' &&
                  !nativeConsent)
              }
              onClick={preview}
            >
              Utwórz pełny podgląd
            </button>
          </fieldset>
        </>
      )}
      {tab === 'profiles' && readable && (
        <>
          <h3>Profile mapowania</h3>
          <p>
            Profil przechowuje znaczenie kolumn i kwot. Użycie kopiuje definicję; nie wykonuje
            importu ani nie wybiera produktów.
          </p>
          <button
            className="button"
            type="button"
            disabled={locked}
            onClick={() => void read(loadProfiles)}
          >
            Odczytaj profile
          </button>
          <div className="pfi-grid">
            <label>
              Profil
              <select
                value={profileId}
                disabled={locked}
                onChange={(e) => {
                  setProfileId(e.target.value);
                  setProfileConsent(false);
                  const p = profiles.find((item) => item.id === e.target.value);
                  setProfileName(p?.name ?? '');
                }}
              >
                <option value="">Nowy profil</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · v{p.version}
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
            <>
              <p>
                Powiązany cennik:{' '}
                {profile.price_list_id
                  ? (lists.find((l) => l.id === profile.price_list_id)?.name ??
                    profile.price_list_id)
                  : 'Nie zapisano powiązania'}{' '}
                · wersja {profile.version}.
              </p>
              <DefinitionView value={profile.definition} />
            </>
          )}
          <details>
            <summary>Bieżąca konfiguracja do zapisania w profilu</summary>
            <p>
              Powiązanie:{' '}
              {selectedList
                ? `${selectedList.name} · ${selectedList.currency}`
                : 'Bez powiązania z cennikiem'}
              .
            </p>
            <DefinitionView value={definition} />
          </details>
          <div className="pfi-toolbar">
            <button
              type="button"
              className="button"
              disabled={locked || externalWriteBlocked || !profile}
              onClick={() => void read(applyProfile)}
            >
              Użyj kopii profilu
            </button>
            <button
              type="button"
              className="button"
              disabled={writeDisabled || !profileName.trim()}
              onClick={() => saveProfile(false)}
            >
              Zapisz bieżące mapowanie jako nowy profil
            </button>
          </div>
          {profile && (
            <>
              <label className="pfi-check">
                <input
                  type="checkbox"
                  checked={profileConsent}
                  disabled={writeDisabled}
                  onChange={(e) => setProfileConsent(e.target.checked)}
                />
                Zastępuję profil {profile.name} v{profile.version} bieżącą konfiguracją importu oraz
                wybranym powiązaniem cennika.
              </label>
              <button
                type="button"
                className="button"
                disabled={writeDisabled || !profileConsent}
                onClick={() => saveProfile(true)}
              >
                Zaktualizuj wybrany profil
              </button>
            </>
          )}
        </>
      )}
      {tab === 'history' && readable && (
        <>
          <h3>Trwała historia</h3>
          <div className="pfi-toolbar">
            <label>
              Rodzaj dowodu
              <select
                value={historyKind}
                disabled={locked}
                onChange={(e) => {
                  setHistoryKind(e.target.value as typeof historyKind);
                  setHistory([]);
                  setHistoryLoaded(false);
                  setHistoryCursor(null);
                }}
              >
                <option value="executions">Wykonania</option>
                <option value="previews">Podglądy</option>
              </select>
            </label>
            <button
              type="button"
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
          <div className="pfi-history">
            {history.map((head) => (
              <button
                className="button"
                type="button"
                key={head.id}
                disabled={busy || remoteBusy}
                onClick={() =>
                  void read((e) =>
                    loadReview(historyKind === 'previews' ? 'preview' : 'execution', head.id, e),
                  )
                }
              >
                {head.list_snapshot.name} · {head.list_snapshot.currency} · {date(head.created_at)}{' '}
                · {head.summary.changed} zmian / {head.summary.total} wierszy
              </button>
            ))}
          </div>
          {historyCursor && (
            <button
              className="button"
              type="button"
              disabled={busy || remoteBusy}
              onClick={() => void read((e) => loadHistory(e, true))}
            >
              Odczytaj dalszą historię
            </button>
          )}
        </>
      )}
      {review && readable && (
        <fieldset>
          <legend>
            {review.kind === 'preview' ? 'Pełny podgląd' : 'Niezmienny wynik wykonania'} ·{' '}
            {review.head.list_snapshot.name} · {review.head.list_snapshot.currency}
          </legend>
          <div className="pfi-counts">
            <span>
              Wiersze: <strong>{review.head.summary.total}</strong>
            </span>
            <span>
              Zmiany: <strong>{review.head.summary.changed}</strong>
            </span>
            <span>
              Bez zmian: <strong>{review.head.summary.unchanged}</strong>
            </span>
            <span>
              Błędy: <strong>{review.head.summary.invalid}</strong>
            </span>
            <span>
              Konflikty: <strong>{review.head.summary.conflicts}</strong>
            </span>
            <span>
              Bez ceny po zmianie: <strong>{review.head.summary.missing_after_count}</strong>
            </span>
          </div>
          <p>
            {date(review.head.created_at)} · {review.definition.format.toUpperCase()} ·{' '}
            {review.definition.basis === 'net'
              ? 'Wejście netto; wynik brutto według VAT w podglądzie.'
              : 'Kwoty brutto.'}{' '}
            · wersja cennika {review.head.list_snapshot.version}
          </p>
          <details>
            <summary>Niezmienne mapowanie i znaczenie danych</summary>
            <DefinitionView value={review.definition} />
          </details>
          {review.head.warnings.length > 0 && (
            <ul className="pfi-hint">
              {review.head.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}
          {!review.complete && (
            <p role="status">
              Zakres nie został odczytany w całości. Zatwierdzenie jest zablokowane.{' '}
              <button
                type="button"
                className="button"
                disabled={busy || remoteBusy}
                onClick={() => void read((e) => loadReview(review.kind, review.head.id, e))}
              >
                Odczytaj cały zakres ponownie
              </button>
            </p>
          )}
          <RowsView
            key={review.head.id}
            rows={review.rows}
            currency={review.head.list_snapshot.currency}
          />
          {review.kind === 'preview' && review.head.execution_id && (
            <button
              className="button"
              type="button"
              disabled={busy || remoteBusy}
              onClick={() =>
                void read((e) => loadReview('execution', review.head.execution_id!, e))
              }
            >
              Odczytaj istniejące wykonanie
            </button>
          )}
          {review.kind === 'preview' && !review.head.execution_id && (
            <>
              {!review.head.summary.ready && (
                <p className="pfi-error">
                  Ten podgląd nie jest gotowy. Popraw plik lub konfigurację i utwórz nowy podgląd;
                  nie zapisano części poprawnych wierszy.
                </p>
              )}
              <label className="pfi-check">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={
                    writeDisabled ||
                    !review.complete ||
                    !review.head.can_execute ||
                    !review.head.summary.ready
                  }
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Przejrzałem wszystkie {review.rows.length} wierszy. Zatwierdzam dokładnie te zmiany
                w cenniku {review.head.list_snapshot.name} ({review.head.list_snapshot.currency}).
                Repricing może później zmienić ceny; import go nie wyłącza.
              </label>
              {review.head.summary.missing_after_count > 0 && (
                <label className="pfi-check">
                  <input
                    type="checkbox"
                    checked={missingConsent}
                    disabled={writeDisabled || !review.complete}
                    onChange={(e) => setMissingConsent(e.target.checked)}
                  />
                  Świadomie pozostawiam {review.head.summary.missing_after_count} produktów bez ceny
                  w tym cenniku. Brak nie oznacza zera.
                </label>
              )}
              <button
                className="button primary"
                type="button"
                disabled={
                  writeDisabled ||
                  !review.complete ||
                  !review.head.can_execute ||
                  !review.head.summary.ready ||
                  !consent ||
                  (review.head.summary.missing_after_count > 0 && !missingConsent)
                }
                onClick={execute}
              >
                Wykonaj zatwierdzony import
              </button>
            </>
          )}
        </fieldset>
      )}
    </section>
  );
}
