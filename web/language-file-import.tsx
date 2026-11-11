import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './language-file-import.css';

export type LanguageFileImportWorkspaceProps = {
  contextKey: string;
  readOnly: boolean;
  disabled?: boolean;
  externalWriteBlocked?: boolean;
  onLockedChange?: (locked: boolean) => void;
  onApplied?: () => void;
  onError?: (message: string) => void;
};
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string | null;
  can_read: boolean;
  can_write: boolean;
};
type Language = {
  locale: string;
  mapping?: { name?: string; description?: string; operation?: string };
  empty_name: 'preserve';
  empty_description: 'preserve' | 'clear';
};
type Definition = {
  format: 'csv' | 'xml';
  mode: 'columns' | 'translations_json';
  delimiter: ';' | ',' | '\t' | '|';
  identity: 'uuid' | 'sku' | 'historical_sku' | 'ean' | 'name';
  mapping: { identity: string; translations_json?: string };
  spreadsheet_safe: boolean;
  spreadsheet_text_prefix: 'reject_ambiguous' | 'decode_export' | 'preserve_literal';
  languages: Language[];
};
type Options = Flags & {
  locales: string[];
  can_use_custom_locale: boolean;
  modes: string[];
  meta: { cursor: string | null };
  limits: {
    products: number;
    locales: number;
    pairs: number;
    page: number;
    file_bytes: number;
    request_bytes: number;
    profiles: number;
    history_per_tenant: number;
  };
};
type Summary = {
  source_rows: number;
  product_count: number;
  total_pairs: number;
  changed_pairs: number;
  unchanged_pairs: number;
  skipped_pairs: number;
  changed_products: number;
  invalid: number;
  conflicts: number;
  missing_after_count: number;
  skipped_locale_entries: number;
  ready: boolean;
};
type LocaleSummary = {
  locale: string;
  total_pairs: number;
  changed_pairs: number;
  unchanged_pairs: number;
  skipped_pairs: number;
  invalid: number;
  conflicts: number;
  missing_after_count: number;
};
type Head = {
  id: string;
  created_at: string;
  source_hash: string;
  scope_hash: string;
  definition: Definition;
  profile_snapshot: { id: string; version: number; name: string } | null;
  summary: Summary;
  per_locale: LocaleSummary[];
  can_execute: boolean;
  core_preview_id?: string | null;
  executed_execution_id?: string | null;
  preview_id?: string;
  core_execution_id?: string;
  state?: 'done';
  ack_missing_locale_codes?: string[];
};
type Translation = {
  present: boolean;
  name: string | null;
  description: string | null;
  version: number | null;
  provenance: { kind: string; id: string } | null;
};
type Row = {
  index: number;
  source_index: number;
  locale: string;
  raw_cells: Record<string, unknown>;
  resolution: { identity: string; value: string | null; matched_historical_sku: boolean };
  product_id: string | null;
  sku: string | null;
  kind: string | null;
  product_name: string | null;
  product_version: number | null;
  input: {
    operation: 'set' | 'remove' | 'none';
    patch?: { name?: string; description?: string };
  } | null;
  before: Translation | null;
  after: Translation | null;
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict';
  skip_reason: string | null;
  errors: string[];
  receipt_id: string | null;
  core_receipt_id?: string | null;
  source_translation_version?: number | null;
};
type Profile = {
  id: string;
  version: number;
  name: string;
  definition: Definition;
  archived: boolean;
  created_at: string;
  updated_at: string;
};
type Page<T> = Flags & { data: T[]; meta: { total: number; cursor: string | null } };
type Reply = Flags & { preview?: Head; execution?: Head; profile?: Profile; reused?: boolean };
type Review = { kind: 'preview' | 'execution'; head: Head; rows: Row[]; complete: boolean };
type Attempt = {
  context: string;
  identity: string;
  kind: 'preview' | 'execute' | 'profile';
  path: string;
  method: 'POST' | 'PATCH';
  serialized: string;
  label: string;
};
const prefix = '/language-file-imports';
// RAM only. An unresolved write survives same-actor navigation, including unmount.
const retained: {
  context: string;
  identity: string;
  attempt: Attempt | null;
  flight: Attempt | null;
} = { context: '', identity: '', attempt: null, flight: null };
const subscriptions = new Set<() => void>();
const publish = () => subscriptions.forEach((notify) => notify());
const lockedFor = (context: string) =>
  retained.context === context && Boolean(retained.attempt || retained.flight);
export function subscribeLanguageFileImportLock(
  contextKey: string,
  callback: (locked: boolean) => void,
) {
  const notify = () => callback(lockedFor(contextKey));
  subscriptions.add(notify);
  notify();
  return () => {
    subscriptions.delete(notify);
  };
}
export function resetLanguageFileImportContext(contextKey: string) {
  retained.context = contextKey;
  retained.identity = '';
  retained.attempt = null;
  retained.flight = null;
  publish();
}
const initialDefinition = (): Definition => ({
  format: 'csv',
  mode: 'columns',
  delimiter: ';',
  identity: 'sku',
  mapping: { identity: '' },
  spreadsheet_safe: false,
  spreadsheet_text_prefix: 'reject_ambiguous',
  languages: [],
});
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const operationNames = { none: 'Pomiń', set: 'Ustaw tekst', remove: 'Usuń wersję językową' };
const statusNames = {
  changed: 'Zmiana',
  unchanged: 'Bez zmian',
  invalid: 'Błąd',
  conflict: 'Konflikt',
};
const prefixNames = {
  reject_ambiguous: 'Zatrzymaj niejednoznaczny apostrof',
  decode_export: 'Usuń jeden ochronny apostrof z eksportu',
  preserve_literal: 'Zachowaj apostrof jako część tekstu',
};
function TextValue({ value }: { value: string | null | undefined }) {
  return value === undefined ? (
    <em>Pole nie jest zmieniane</em>
  ) : value === null ? (
    <em>Brak danych</em>
  ) : value === '' ? (
    <em>Pusty tekst</em>
  ) : (
    <span className="lfi-text">{value}</span>
  );
}
function TranslationView({ value }: { value: Translation | null }) {
  if (!value) return <em>Brak poprawnego wyniku</em>;
  if (!value.present) return <strong>Brak wersji językowej</strong>;
  return (
    <div>
      <b>Nazwa</b>
      <TextValue value={value.name} />
      <b>Opis</b>
      <TextValue value={value.description} />
      <small>
        Wersja {value.version} ·{' '}
        {value.provenance?.kind === 'manual'
          ? 'Ręczna zmiana'
          : value.provenance?.kind === 'ai'
            ? 'AI'
            : value.provenance?.kind === 'deepl'
              ? 'DeepL'
              : 'Nieznane pochodzenie'}
      </small>
    </div>
  );
}
function DefinitionView({ value }: { value: Definition }) {
  return (
    <div className="lfi-hint">
      <p>
        {value.format.toUpperCase()} ·{' '}
        {value.mode === 'columns' ? 'Kolumny języków' : 'Tablica tłumaczeń'} · rozpoznanie:{' '}
        {value.identity === 'historical_sku'
          ? 'Historyczne SKU'
          : value.identity === 'uuid'
            ? 'ID produktu'
            : value.identity.toUpperCase()}{' '}
        · pole „{value.mapping.identity}”
      </p>
      <p>
        Języki: {value.languages.map((l) => l.locale).join(', ')}.{' '}
        {value.spreadsheet_safe
          ? prefixNames[value.spreadsheet_text_prefix]
          : 'Apostrofy są zachowane bez interpretacji arkusza.'}
      </p>
      {value.languages.map((l) => (
        <small key={l.locale}>
          {l.locale}:{' '}
          {l.mapping
            ? Object.entries(l.mapping)
                .map(
                  ([key, column]) =>
                    `${key === 'name' ? 'nazwa' : key === 'description' ? 'opis' : 'operacja'}: ${column}`,
                )
                .join(' · ')
            : `pole ${value.mapping.translations_json}`}{' '}
          · pusty opis: {l.empty_description === 'clear' ? 'wyczyść' : 'zachowaj'}
        </small>
      ))}
    </div>
  );
}
function RawFields({ value }: { value: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Oryginalne pola wiersza</summary>
      {open && <pre>{JSON.stringify(value, null, 2)}</pre>}
    </details>
  );
}
function RowsView({ rows }: { rows: Row[] }) {
  const [filter, setFilter] = useState<'all' | 'errors' | 'changed'>('all');
  const [locale, setLocale] = useState('');
  const [page, setPage] = useState(0);
  const visible = rows.filter(
    (r) =>
      (!locale || r.locale === locale) &&
      (filter === 'all' ||
        (filter === 'errors'
          ? r.errors.length > 0 || ['invalid', 'conflict'].includes(r.status)
          : r.status === 'changed')),
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / 50));
  const currentPage = Math.min(page, pageCount - 1);
  const displayed = visible.slice(currentPage * 50, (currentPage + 1) * 50);
  return (
    <div>
      <div className="lfi-toolbar">
        <label>
          Widok wierszy
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as typeof filter);
              setPage(0);
            }}
          >
            <option value="all">Wszystkie · {rows.length}</option>
            <option value="errors">Błędy i konflikty</option>
            <option value="changed">Zmiany</option>
          </select>
        </label>
        <label>
          Język w podglądzie
          <select
            value={locale}
            onChange={(e) => {
              setLocale(e.target.value);
              setPage(0);
            }}
          >
            <option value="">Wszystkie języki</option>
            {[...new Set(rows.map((r) => r.locale))].sort().map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p>
        Par w wybranym widoku: {visible.length}. Pokazano {displayed.length} na stronie. Zgoda
        dotyczy całej odczytanej partii {rows.length} par.
      </p>
      <div className="lfi-toolbar" aria-label="Strony podglądu tłumaczeń">
        <button
          className="button"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Poprzednie 50 par
        </button>
        <span role="status">
          Strona {currentPage + 1} z {pageCount}
        </span>
        <button
          className="button"
          disabled={currentPage + 1 >= pageCount}
          onClick={() => setPage(currentPage + 1)}
        >
          Następne 50 par
        </button>
      </div>
      <div className="lfi-scroll">
        <table>
          <thead>
            <tr>
              <th>Wiersz, produkt i język</th>
              <th>Wejście</th>
              <th>Przed</th>
              <th>Po</th>
              <th>Wynik</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((r) => (
              <tr key={r.index}>
                <td>
                  <strong>
                    {r.source_index + 1}. {r.sku ?? 'Bez dopasowania'}
                  </strong>
                  <small>{r.product_name}</small>
                  <b>{r.locale}</b>
                  <small>Identyfikator z pliku: {r.resolution.value ?? 'Brak'}</small>
                  {r.resolution.matched_historical_sku && (
                    <small>Dopasowano wcześniejsze SKU. Kod produktu pozostaje bez zmian.</small>
                  )}
                  <small>Wersja produktu: {r.product_version ?? 'Brak'}</small>
                </td>
                <td>
                  <strong>
                    {r.input ? operationNames[r.input.operation] : 'Niepoprawne wejście'}
                  </strong>
                  {r.input?.patch && (
                    <>
                      <b>Nazwa</b>
                      <TextValue value={r.input.patch.name} />
                      <b>Opis</b>
                      <TextValue value={r.input.patch.description} />
                    </>
                  )}
                  {r.source_translation_version !== undefined && (
                    <small>
                      Wersja z pliku: {r.source_translation_version ?? 'Nie podano'}; nie zastępuje
                      bieżącej wersji.
                    </small>
                  )}
                  <RawFields value={r.raw_cells} />
                </td>
                <td>
                  <TranslationView value={r.before} />
                </td>
                <td>
                  <TranslationView value={r.after} />
                </td>
                <td>
                  <strong>{statusNames[r.status]}</strong>
                  {r.skip_reason && <small>{r.skip_reason}</small>}
                  {r.errors.length > 0 && (
                    <ul>
                      {r.errors.map((error, i) => (
                        <li key={i}>{error}</li>
                      ))}
                    </ul>
                  )}
                  {(r.core_receipt_id || r.receipt_id) && (
                    <small>Potwierdzenie: {r.core_receipt_id ?? r.receipt_id}</small>
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

export function LanguageFileImportWorkspace({
  contextKey,
  readOnly,
  disabled = false,
  externalWriteBlocked = false,
  onLockedChange,
  onApplied,
  onError,
}: LanguageFileImportWorkspaceProps) {
  const identity = `${contextKey}:readonly=${readOnly}`;
  const scopeRef = useRef(identity);
  scopeRef.current = identity;
  const mounted = useRef(false),
    epoch = useRef(0),
    busyRef = useRef(false);
  const flagsRef = useRef<Flags | null>(null),
    signatureRef = useRef<string | null>(null);
  const blockedRef = useRef({ disabled, externalWriteBlocked });
  blockedRef.current = { disabled, externalWriteBlocked };
  const [viewIdentity, setViewIdentity] = useState(identity);
  const [options, setOptions] = useState<Options | null>(null),
    [flags, setFlags] = useState<Flags | null>(null);
  const [definition, setDefinition] = useState<Definition>(initialDefinition),
    [content, setContent] = useState(''),
    [fileName, setFileName] = useState('');
  const [localeInput, setLocaleInput] = useState(''),
    [tab, setTab] = useState<'import' | 'history' | 'profiles'>('import');
  const [profiles, setProfiles] = useState<Profile[]>([]),
    [selectedProfile, setSelectedProfile] = useState<Profile | null>(null),
    [appliedProfile, setAppliedProfile] = useState<{ id: string; version: number } | null>(null),
    [profileName, setProfileName] = useState(''),
    [showArchived, setShowArchived] = useState(false),
    [profileConsent, setProfileConsent] = useState(false);
  const [review, setReview] = useState<Review | null>(null),
    [consent, setConsent] = useState(false),
    [ack, setAck] = useState<string[]>([]);
  const [historyKind, setHistoryKind] = useState<'previews' | 'executions'>('previews'),
    [history, setHistory] = useState<Head[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const historyCursors = useRef(new Set<string>());
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [remoteBusy, setRemoteBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const current = viewIdentity === identity;
  const liveFlags = current ? flags : null;
  const authorizedWrite = Boolean(
    liveFlags?.available &&
    liveFlags.can_read &&
    liveFlags.can_write &&
    liveFlags.current_role === 'admin' &&
    !liveFlags.read_only &&
    !readOnly &&
    !disabled,
  );
  const locked = retained.context === contextKey && Boolean(pending || remoteBusy);
  const freshBlocked = !authorizedWrite || busy || locked || externalWriteBlocked;
  function newWriteAllowed() {
    const f = flagsRef.current;
    return (
      mounted.current &&
      identity === scopeRef.current &&
      !busyRef.current &&
      !retained.attempt &&
      !retained.flight &&
      !readOnly &&
      !blockedRef.current.disabled &&
      !blockedRef.current.externalWriteBlocked &&
      f?.available &&
      f.can_read &&
      f.can_write &&
      f.current_role === 'admin' &&
      !f.read_only
    );
  }

  function clearSensitive() {
    setOptions(null);
    setContent('');
    setFileName('');
    setDefinition(initialDefinition());
    setLocaleInput('');
    setProfiles([]);
    setSelectedProfile(null);
    setAppliedProfile(null);
    setProfileName('');
    setProfileConsent(false);
    setReview(null);
    setConsent(false);
    setAck([]);
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
    historyCursors.current.clear();
    if (fileRef.current) fileRef.current.value = '';
  }
  function accept(d: Flags): boolean {
    if (![d.available, d.can_read, d.can_write, d.read_only].every((v) => typeof v === 'boolean'))
      throw new Error('Nie otrzymano pełnych uprawnień importu.');
    const signature = JSON.stringify([
      d.current_role,
      d.available,
      d.can_read,
      d.can_write,
      d.read_only,
    ]);
    const changed = signatureRef.current !== null && signatureRef.current !== signature;
    if (changed || !d.can_read) {
      clearSensitive();
      if (retained.context === contextKey) resetLanguageFileImportContext(contextKey);
    }
    signatureRef.current = signature;
    flagsRef.current = d;
    setFlags(d);
    if (changed) {
      setStatus(
        'Uprawnienia zmieniły się. Dane poprzedniego odczytu usunięto; odczytaj wybrany zakres ponownie.',
      );
      return false;
    }
    return d.available && d.can_read;
  }
  function fail(e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    const message =
      (e instanceof Error ? e.message : 'Nie udało się wykonać operacji.') +
      (e instanceof ApiError && e.status === 409
        ? ' Odczytaj aktualny zakres. Nowy zapis wymaga ponownego podglądu i zgody.'
        : '');
    setError(message);
    onError?.(message);
    if (e instanceof ApiError && [401, 403, 423].includes(e.status)) {
      clearSensitive();
      flagsRef.current = null;
      signatureRef.current = null;
      setFlags(null);
      if (retained.context === contextKey) resetLanguageFileImportContext(contextKey);
    }
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    const scope = identity;
    try {
      const result = await api<T>(prefix + path, method, body);
      if (!mounted.current || e !== epoch.current || scope !== scopeRef.current)
        throw new DOMException('Kontekst został zmieniony.', 'AbortError');
      return result;
    } catch (err) {
      if (!mounted.current || e !== epoch.current || scope !== scopeRef.current)
        throw new DOMException('Kontekst został zmieniony.', 'AbortError');
      throw err;
    }
  }
  async function read(task: (e: number) => Promise<void>) {
    if (busyRef.current || retained.flight || !current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    const e = epoch.current;
    try {
      await task(e);
    } catch (err) {
      if (e === epoch.current) fail(err);
    } finally {
      if (e === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function loadOptions(e: number) {
    const locales: string[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null,
      first: Options | null = null;
    do {
      const d: Options = await request<Options>(
        '/options' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        e,
      );
      if (!accept(d)) {
        setOptions(d);
        return;
      }
      first ??= d;
      if (
        !Array.isArray(d.locales) ||
        d.locales.some((l) => typeof l !== 'string') ||
        d.locales.some((l) => locales.includes(l))
      )
        throw new Error('Lista języków zawiera niepoprawne lub powtórzone pozycje.');
      locales.push(...d.locales);
      if (
        locales.length > 10000 ||
        cursors.size >= 200 ||
        (!d.locales.length && d.meta.cursor) ||
        (d.meta.cursor && cursors.has(d.meta.cursor))
      )
        throw new Error('Nie można potwierdzić pełnej listy języków.');
      cursor = d.meta.cursor;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (first) setOptions({ ...first, locales, meta: { cursor: null } });
  }
  async function loadProfiles(e: number) {
    const all: Profile[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null,
      total: number | null = null;
    do {
      const d: Page<Profile> = await request<Page<Profile>>(
        '/profiles' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        e,
      );
      if (!accept(d)) return;
      total ??= d.meta.total;
      if (!Number.isInteger(total) || total < 0 || total > 100 || d.meta.total !== total)
        throw new Error('Lista profili przekracza pełny dozwolony zakres.');
      all.push(...d.data);
      if (
        all.length > total ||
        cursors.size >= 100 ||
        (!d.data.length && d.meta.cursor) ||
        (d.meta.cursor && cursors.has(d.meta.cursor))
      )
        throw new Error('Nie można potwierdzić kompletności profili.');
      cursor = d.meta.cursor;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (all.length !== total || new Set(all.map((p) => p.id)).size !== all.length)
      throw new Error('Brakuje profili albo odczyt zawiera duplikaty.');
    setProfiles(all);
  }
  async function loadReview(kind: Review['kind'], id: string, e: number) {
    const base = `/${kind === 'preview' ? 'previews' : 'executions'}/${encodeURIComponent(id)}`;
    const d = await request<Reply>(base, e);
    if (!accept(d)) return;
    const head = kind === 'preview' ? d.preview : d.execution;
    if (
      !head ||
      !Number.isInteger(head.summary.total_pairs) ||
      head.summary.total_pairs < 1 ||
      head.summary.total_pairs > 3000
    )
      throw new Error('Niepoprawny zakres nagłówka importu.');
    setReview({ kind, head, rows: [], complete: false });
    setConsent(false);
    setAck([]);
    const rows: Row[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Page<Row> = await request<Page<Row>>(
        base + '/rows' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
        e,
      );
      if (!accept(page)) return;
      if (
        page.meta.total !== head.summary.total_pairs ||
        page.data.length > 50 ||
        !page.data.length
      )
        throw new Error('Strony nie odpowiadają pełnemu zakresowi podglądu.');
      rows.push(...page.data);
      if (
        rows.length > head.summary.total_pairs ||
        (page.meta.cursor && cursors.has(page.meta.cursor))
      )
        throw new Error('Powtórzona strona lub zbyt wiele wierszy.');
      cursor = page.meta.cursor;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (
      rows.length !== head.summary.total_pairs ||
      rows.some((r, i) => r.index !== i) ||
      head.definition.languages.some((l) => !head.per_locale.some((s) => s.locale === l.locale)) ||
      head.per_locale.length !== head.definition.languages.length
    )
      throw new Error('Nie odczytano całej uporządkowanej macierzy. Zgoda jest zablokowana.');
    setReview({ kind, head, rows, complete: true });
  }
  async function loadHistory(e: number, more = false) {
    if (!more) historyCursors.current.clear();
    const d: Page<Head> = await request<Page<Head>>(
      `/${historyKind}` +
        (more && historyCursor ? `?cursor=${encodeURIComponent(historyCursor)}` : ''),
      e,
    );
    if (!accept(d)) return;
    if (
      !Number.isInteger(d.meta.total) ||
      d.meta.total < 0 ||
      d.meta.total > 2000 ||
      (d.meta.cursor && historyCursors.current.has(d.meta.cursor))
    )
      throw new Error('Nie można potwierdzić zakresu historii.');
    const all = more ? [...history, ...d.data] : d.data;
    if (new Set(all.map((h) => h.id)).size !== all.length || all.length > d.meta.total)
      throw new Error('Powtórzone pozycje historii.');
    if (d.meta.cursor) historyCursors.current.add(d.meta.cursor);
    setHistory(all);
    setHistoryCursor(d.meta.cursor);
    setHistoryLoaded(true);
  }
  useEffect(() => {
    mounted.current = true;
    if (retained.context !== contextKey || (retained.identity && retained.identity !== identity))
      resetLanguageFileImportContext(contextKey);
    retained.identity = identity;
    const sync = () => {
      setPending(retained.context === contextKey ? retained.attempt : null);
      setRemoteBusy(retained.context === contextKey && Boolean(retained.flight));
    };
    subscriptions.add(sync);
    sync();
    const e = ++epoch.current;
    busyRef.current = true;
    flagsRef.current = null;
    signatureRef.current = null;
    setViewIdentity(identity);
    setFlags(null);
    setOptions(null);
    clearSensitive();
    setError('');
    setStatus('');
    setBusy(true);
    void loadOptions(e)
      .catch((err) => {
        if (e === epoch.current) fail(err);
      })
      .finally(() => {
        if (e === epoch.current) {
          busyRef.current = false;
          setBusy(false);
        }
      });
    return () => {
      mounted.current = false;
      ++epoch.current;
      busyRef.current = false;
      subscriptions.delete(sync);
    };
  }, [contextKey, readOnly]);
  useEffect(
    () =>
      onLockedChange ? subscribeLanguageFileImportLock(contextKey, onLockedChange) : undefined,
    [contextKey, onLockedChange],
  );

  function invalidate() {
    setReview(null);
    setConsent(false);
    setAck([]);
    setAppliedProfile(null);
    setProfileConsent(false);
    setStatus('');
    setError('');
  }
  function configure(next: Definition) {
    if (!newWriteAllowed()) return;
    invalidate();
    setDefinition(next);
  }
  function validatedDefinition(): Definition {
    const result = copy(definition);
    result.languages = result.languages
      .map((l) => ({ ...l, locale: l.locale.toLowerCase() }))
      .sort((a, b) => a.locale.localeCompare(b.locale));
    if (
      result.languages.length < 1 ||
      result.languages.length > 6 ||
      new Set(result.languages.map((l) => l.locale)).size !== result.languages.length ||
      result.languages.some((l) => !/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/.test(l.locale))
    )
      throw new Error('Wybierz 1–6 różnych kodów języków, np. pl, en lub de.');
    if (!result.mapping.identity.trim())
      throw new Error('Podaj dokładną nazwę pola identyfikatora z pliku.');
    if (result.mode === 'translations_json' && !result.mapping.translations_json?.trim())
      throw new Error('Podaj pole tablicy tłumaczeń.');
    if (
      result.mode === 'columns' &&
      result.languages.some((l) => !l.mapping || !Object.values(l.mapping).some(Boolean))
    )
      throw new Error('Dla każdego języka wskaż co najmniej jedną kolumnę.');
    return result;
  }
  async function submit(a: Attempt) {
    if (
      busyRef.current ||
      retained.flight ||
      (retained.attempt && retained.attempt !== a) ||
      a.identity !== scopeRef.current ||
      disabled ||
      readOnly ||
      (externalWriteBlocked && retained.attempt !== a)
    )
      return;
    retained.context = contextKey;
    retained.identity = identity;
    retained.attempt = a;
    retained.flight = a;
    publish();
    const e = epoch.current;
    let sent = false;
    setError('');
    setStatus('');
    try {
      const currentOptions = await request<Options>('/options', e);
      if (!accept(currentOptions)) return;
      if (
        !currentOptions.can_write ||
        currentOptions.current_role !== 'admin' ||
        currentOptions.read_only ||
        blockedRef.current.disabled ||
        readOnly
      )
        throw new ApiError('Brak bieżących uprawnień do zapisu importu.', 403);
      sent = true;
      const d = await request<Reply>(a.path, e, a.method, JSON.parse(a.serialized));
      if (!accept(d)) return;
      const result =
        a.kind === 'profile' ? d.profile : a.kind === 'execute' ? d.execution : d.preview;
      if (!result?.id) throw new Error('Nie otrzymano trwałego identyfikatora wyniku.');
      if (retained.attempt === a) {
        retained.attempt = null;
        publish();
      }
      if (a.kind === 'profile' && d.profile) {
        setSelectedProfile(d.profile);
        setProfileName(d.profile.name);
        setProfileConsent(false);
        setStatus(
          d.reused
            ? 'Odczytano wcześniejszy zapis profilu. Przed użyciem odczytaj jego aktualną wersję.'
            : 'Profil mapowania zapisany.',
        );
        await loadProfiles(e);
      } else {
        if (a.kind === 'execute') {
          setReview((r) =>
            r?.kind === 'preview'
              ? { ...r, head: { ...r.head, can_execute: false, executed_execution_id: result.id } }
              : r,
          );
          setConsent(false);
          setAck([]);
          onApplied?.();
        }
        await loadReview(a.kind === 'execute' ? 'execution' : 'preview', result.id, e);
        setStatus(
          a.kind === 'execute'
            ? d.reused
              ? 'Odczytano wcześniejsze wykonanie. Nie zapisano tłumaczeń ponownie.'
              : 'Import tłumaczeń wykonany. Wynik pokazuje trwałe potwierdzenia.'
            : 'Trwały podgląd odczytany; sprawdź wszystkie teksty i błędy.',
        );
      }
    } catch (err) {
      if (!mounted.current || e !== epoch.current || a.identity !== scopeRef.current) return;
      if (
        !sent ||
        (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408)
      ) {
        if (retained.attempt === a) {
          retained.attempt = null;
          publish();
        }
        setConsent(false);
        setAck([]);
        setProfileConsent(false);
        if (err instanceof ApiError && err.status === 409 && a.kind === 'execute')
          setReview((r) => (r ? { ...r, head: { ...r.head, can_execute: false } } : r));
      }
      fail(err);
      if (retained.attempt === a)
        setStatus(
          'Wynik zapisu jest nieznany. Nowe zapisy są zablokowane; możesz ręcznie ponowić wyłącznie tę samą próbę.',
        );
    } finally {
      if (retained.flight === a) {
        retained.flight = null;
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
    if (!newWriteAllowed()) return;
    try {
      const serialized = JSON.stringify(body);
      if (bytes(serialized) > (options?.limits.request_bytes ?? 3145728))
        throw new Error('Całe żądanie przekracza limit 3 MiB. Nie podzielono importu.');
      void submit({ context: contextKey, identity, kind, path, method, serialized, label });
    } catch (err) {
      fail(err);
    }
  }
  function preview() {
    try {
      if (!content || bytes(content) > (options?.limits.file_bytes ?? 2097152))
        throw new Error('Wgraj lub wklej treść do 2 MiB.');
      attempt(
        'preview',
        '/previews',
        {
          client_key: crypto.randomUUID(),
          content,
          definition: validatedDefinition(),
          ...(appliedProfile ? { profile: copy(appliedProfile) } : {}),
        },
        'Utworzenie podglądu',
      );
    } catch (err) {
      fail(err);
    }
  }
  async function upload(file: File) {
    if (!newWriteAllowed()) return;
    const e = epoch.current,
      scope = identity;
    busyRef.current = true;
    setBusy(true);
    try {
      if (file.size > (options?.limits.file_bytes ?? 2097152))
        throw new Error('Plik przekracza 2 MiB.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer(),
      );
      if (!mounted.current || e !== epoch.current || scope !== scopeRef.current) return;
      if (bytes(text) > (options?.limits.file_bytes ?? 2097152))
        throw new Error('Treść przekracza 2 MiB.');
      invalidate();
      setContent(text);
      setFileName(file.name);
      setStatus('Plik UTF-8 odczytany w całości. Nie zmieniono BOM ani końców linii.');
    } catch (err) {
      if (mounted.current && e === epoch.current && scope === scopeRef.current) {
        setContent('');
        setFileName('');
        if (fileRef.current) fileRef.current.value = '';
        fail(err);
      }
    } finally {
      if (e === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function addLanguage() {
    const locale = localeInput.trim().toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/.test(locale)) {
      setError('Podaj kod języka, np. pl, en lub de.');
      return;
    }
    if (definition.languages.some((l) => l.locale === locale) || definition.languages.length >= 6) {
      setError('Wybierz maksymalnie sześć różnych języków.');
      return;
    }
    configure({
      ...definition,
      languages: [
        ...definition.languages,
        {
          locale,
          ...(definition.mode === 'columns' ? { mapping: {} } : {}),
          empty_name: 'preserve',
          empty_description: 'preserve',
        },
      ],
    });
    setLocaleInput('');
  }
  function setFormat(format: 'csv' | 'xml') {
    configure(
      format === 'xml'
        ? {
            ...definition,
            format,
            mode: 'translations_json',
            delimiter: ';',
            spreadsheet_safe: false,
            mapping: {
              identity:
                definition.identity === 'uuid'
                  ? 'id'
                  : definition.identity === 'historical_sku'
                    ? 'sku'
                    : definition.identity,
              translations_json: 'translations_json',
            },
            languages: definition.languages.map(({ mapping: _mapping, ...l }) => l),
          }
        : { ...definition, format },
    );
  }
  function saveProfile(update = false, archive?: boolean, renameOnly = false) {
    try {
      if (!profileName.trim() || profileName.trim().length > 120)
        throw new Error('Nazwa profilu wymaga 1–120 znaków.');
      if (!profileConsent) throw new Error('Potwierdź zapis definicji profilu.');
      const p = selectedProfile;
      if (update && !p) return;
      attempt(
        'profile',
        update && p ? `/profiles/${encodeURIComponent(p.id)}` : '/profiles',
        {
          client_key: crypto.randomUUID(),
          name: archive === undefined ? profileName.trim() : p!.name,
          definition:
            archive === undefined && !renameOnly ? validatedDefinition() : copy(p!.definition),
          ...(update && p ? { version: p.version, archived: archive ?? p.archived } : {}),
        },
        renameOnly
          ? 'Zmiana nazwy profilu'
          : archive === undefined
            ? 'Zapis profilu mapowania'
            : archive
              ? 'Archiwizacja profilu'
              : 'Przywrócenie profilu',
        update ? 'PATCH' : 'POST',
      );
    } catch (err) {
      fail(err);
    }
  }
  const requiredAck =
    review?.head.per_locale
      .filter((l) => l.missing_after_count > 0)
      .map((l) => l.locale)
      .sort() ?? [];
  const executeAllowed =
    !freshBlocked &&
    review?.kind === 'preview' &&
    review.complete &&
    review.head.can_execute &&
    review.head.summary.ready &&
    !review.head.executed_execution_id &&
    consent &&
    JSON.stringify([...ack].sort()) === JSON.stringify(requiredAck);
  if (!current)
    return (
      <section className="panel language-file-import">
        <p>Odczytywanie bieżącego kontekstu…</p>
      </section>
    );
  return (
    <section className="panel language-file-import">
      <h2>Import tłumaczeń z CSV / XML</h2>
      <p>
        Wgraj nazwy i opisy istniejących produktów w 1–6 językach. Podgląd obejmuje całą partię;
        zapis wymaga osobnej zgody. Import nie zmienia podstawowych danych katalogu, cen ani stanów
        i nie publikuje tłumaczeń w sklepach.
      </p>
      <p className="lfi-hint">
        Do 500 wierszy produktów i 3000 par produkt–język · UTF-8 do 2 MiB. Puste pole może zachować
        tekst albo wyczyścić opis; usunięcie całej wersji wymaga jawnej operacji remove.
      </p>
      {error && (
        <div className="lfi-error" role="alert">
          {error}
          {error.includes('409') && ' Odczytaj zakres i przygotuj nowy podgląd.'}
        </div>
      )}
      {status && (
        <div className="lfi-status" role="status">
          {status}
        </div>
      )}
      {readOnly && (
        <p className="lfi-hint">Tryb odczytu odtworzonej kopii. Zapisy są zablokowane.</p>
      )}
      {flags && !flags.available && (
        <p className="lfi-hint">Import tłumaczeń nie jest dostępny w tej kopii.</p>
      )}
      {flags?.available && !authorizedWrite && !readOnly && (
        <p className="lfi-hint">
          Historia jest dostępna według bieżących uprawnień. Zapis wymaga administratora z dostępem
          do katalogu.
        </p>
      )}
      {externalWriteBlocked && !pending && (
        <p className="lfi-pending">
          Inny proces ma nierozstrzygnięty zapis. Nowa konfiguracja i zapisy są wstrzymane.
        </p>
      )}
      {pending && (
        <div className="lfi-pending" role="status">
          <strong>
            {remoteBusy ? 'Trwa zapis: ' : 'Nierozstrzygnięta próba: '}
            {pending.label}
          </strong>
          <p>
            Zachowano dokładne żądanie i klucz w pamięci tej sesji. Odczyt historii nie odblokowuje
            próby. Nie zamykaj ani nie odświeżaj przeglądarki przed sprawdzeniem wyniku.
          </p>
          <button
            className="button"
            disabled={!authorizedWrite || busy || remoteBusy}
            onClick={() => void submit(pending)}
          >
            Ponów dokładnie tę próbę
          </button>
        </div>
      )}
      <div className="lfi-toolbar">
        <button className="button" onClick={() => setTab('import')}>
          Plik i podgląd
        </button>
        <button className="button" onClick={() => setTab('profiles')}>
          Profile mapowania
        </button>
        <button className="button" onClick={() => setTab('history')}>
          Historia importów
        </button>
        <button
          className="button"
          disabled={busy || remoteBusy}
          onClick={() => void read(loadOptions)}
        >
          Odśwież uprawnienia i języki
        </button>
        {busy && <span role="status">Odczytywanie pełnego zakresu…</span>}
      </div>
      {tab === 'profiles' && selectedProfile && (
        <fieldset disabled={freshBlocked}>
          <legend>Zmiana samej nazwy</legend>
          <p>Użyje nazwy wpisanej poniżej i zachowa definicję wybranej wersji profilu.</p>
          <button
            className="button"
            disabled={!profileConsent || !profileName.trim()}
            onClick={() => saveProfile(true, undefined, true)}
          >
            Zmień tylko nazwę wybranego profilu
          </button>
        </fieldset>
      )}
      {tab === 'import' && (
        <>
          <fieldset disabled={freshBlocked}>
            <legend>1. Plik i sposób rozpoznania produktów</legend>
            <div className="lfi-grid">
              <label>
                Plik UTF-8
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
                Format
                <select
                  value={definition.format}
                  onChange={(e) => setFormat(e.target.value as 'csv' | 'xml')}
                >
                  <option value="csv">CSV</option>
                  <option value="xml">XML z eksportu katalogu</option>
                </select>
              </label>
              <label>
                Zawartość języków
                <select
                  value={definition.mode}
                  disabled={definition.format === 'xml'}
                  onChange={(e) => {
                    const mode = e.target.value as Definition['mode'];
                    configure({
                      ...definition,
                      mode,
                      mapping: {
                        identity: definition.mapping.identity,
                        ...(mode === 'translations_json' ? { translations_json: '' } : {}),
                      },
                      languages: definition.languages.map((l) => ({
                        locale: l.locale,
                        empty_name: l.empty_name,
                        empty_description: l.empty_description,
                        ...(mode === 'columns' ? { mapping: {} } : {}),
                      })),
                    });
                  }}
                >
                  <option value="columns">Osobne kolumny języków</option>
                  <option value="translations_json">Tablica translations_json</option>
                </select>
              </label>
              <label>
                Rozpoznaj produkt przez
                <select
                  value={definition.identity}
                  onChange={(e) => {
                    const value = e.target.value as Definition['identity'];
                    configure({
                      ...definition,
                      identity: value,
                      mapping: {
                        ...definition.mapping,
                        ...(definition.format === 'xml'
                          ? {
                              identity:
                                value === 'uuid'
                                  ? 'id'
                                  : value === 'historical_sku'
                                    ? 'sku'
                                    : value,
                            }
                          : {}),
                      },
                    });
                  }}
                >
                  <option value="sku">Aktualne SKU</option>
                  <option value="historical_sku">Aktualne i historyczne SKU</option>
                  <option value="uuid">ID produktu</option>
                  <option value="ean">EAN</option>
                  <option value="name">Nazwa</option>
                </select>
              </label>
              <label>
                Nazwa pola identyfikatora
                <input
                  value={definition.mapping.identity}
                  disabled={definition.format === 'xml'}
                  onChange={(e) =>
                    configure({
                      ...definition,
                      mapping: { ...definition.mapping, identity: e.target.value },
                    })
                  }
                  placeholder="Dokładny nagłówek z pliku"
                />
              </label>
              {definition.format === 'csv' && (
                <label>
                  Separator CSV
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
                    <option value="|">Pionowa kreska</option>
                  </select>
                </label>
              )}
              {definition.mode === 'translations_json' && (
                <label>
                  Pole tablicy tłumaczeń
                  <input
                    value={definition.mapping.translations_json ?? ''}
                    disabled={definition.format === 'xml'}
                    onChange={(e) =>
                      configure({
                        ...definition,
                        mapping: { ...definition.mapping, translations_json: e.target.value },
                      })
                    }
                  />
                </label>
              )}
            </div>
            {definition.format === 'csv' && (
              <>
                <label className="lfi-check">
                  <input
                    type="checkbox"
                    checked={definition.spreadsheet_safe}
                    onChange={(e) =>
                      configure({ ...definition, spreadsheet_safe: e.target.checked })
                    }
                  />
                  Plik pochodzi z eksportu CSV dla arkusza (ochronne apostrofy)
                </label>
                {definition.spreadsheet_safe && (
                  <label>
                    Interpretacja apostrofów w nazwach i opisach
                    <select
                      value={definition.spreadsheet_text_prefix}
                      onChange={(e) =>
                        configure({
                          ...definition,
                          spreadsheet_text_prefix: e.target
                            .value as Definition['spreadsheet_text_prefix'],
                        })
                      }
                    >
                      {Object.entries(prefixNames).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p>
                  Eksport arkuszowy może zapisać liczbę lub formułę tak samo jak prawdziwy tekst
                  zaczynający się apostrofem. Domyślnie taki tekst wymaga wyjaśnienia; wybierz
                  świadomie usunięcie prefiksu albo zachowanie go.
                </p>
              </>
            )}
            {fileName && (
              <p>
                Odczytany plik: {fileName} · {bytes(content)} bajtów
              </p>
            )}
            <details>
              <summary>Wklej lub edytuj treść pliku</summary>
              <p>Edycja treści tworzy nowy zakres źródła i unieważnia poprzednią zgodę.</p>
              <textarea
                rows={9}
                value={content}
                onChange={(e) => {
                  invalidate();
                  setContent(e.target.value);
                  setFileName('');
                }}
                aria-label="Treść pliku importu tłumaczeń"
              />
            </details>
          </fieldset>
          <fieldset disabled={freshBlocked}>
            <legend>2. Wybierz języki i kolumny</legend>
            <div className="lfi-toolbar">
              <label>
                Kod języka
                <input
                  list="lfi-known-locales"
                  value={localeInput}
                  onChange={(e) => setLocaleInput(e.target.value)}
                  placeholder="np. de"
                />
                <datalist id="lfi-known-locales">
                  {options?.locales.map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </label>
              <button
                className="button"
                disabled={definition.languages.length >= 6}
                onClick={addLanguage}
              >
                Dodaj język
              </button>
            </div>
            {!definition.languages.length && (
              <p>Nie wybrano języka. Wskaż jawnie co najmniej jeden.</p>
            )}
            {definition.languages.map((l, i) => (
              <div className="lfi-language" key={l.locale}>
                <div className="lfi-toolbar">
                  <strong>{l.locale}</strong>
                  <button
                    className="button"
                    onClick={() =>
                      configure({
                        ...definition,
                        languages: definition.languages.filter((_, index) => index !== i),
                      })
                    }
                  >
                    Usuń z wyboru
                  </button>
                </div>
                {definition.mode === 'columns' && (
                  <div className="lfi-grid">
                    {(['name', 'description', 'operation'] as const).map((field) => (
                      <label key={field}>
                        {field === 'name'
                          ? 'Kolumna nazwy'
                          : field === 'description'
                            ? 'Kolumna opisu'
                            : 'Kolumna operacji (opcjonalna)'}
                        <input
                          value={l.mapping?.[field] ?? ''}
                          onChange={(e) => {
                            const mapping = { ...l.mapping };
                            if (e.target.value === '') delete mapping[field];
                            else mapping[field] = e.target.value;
                            configure({
                              ...definition,
                              languages: definition.languages.map((lang, index) =>
                                index === i ? { ...lang, mapping } : lang,
                              ),
                            });
                          }}
                          placeholder="Brak mapowania = bez zmiany"
                        />
                      </label>
                    ))}
                  </div>
                )}
                <label>
                  Pusty opis
                  <select
                    value={l.empty_description}
                    onChange={(e) =>
                      configure({
                        ...definition,
                        languages: definition.languages.map((lang, index) =>
                          index === i
                            ? {
                                ...lang,
                                empty_description: e.target.value as Language['empty_description'],
                              }
                            : lang,
                        ),
                      })
                    }
                  >
                    <option value="preserve">Zachowaj bieżący opis</option>
                    <option value="clear">Wyczyść opis</option>
                  </select>
                </label>
                <small>
                  Pusta nazwa jest pomijana. Utworzenie nowej wersji językowej nadal wymaga
                  poprawnej nazwy.
                </small>
              </div>
            ))}
            <p>
              Operacje z pliku: set — ustaw wskazane teksty; none — pomiń; remove — usuń całą wersję
              tego języka. Brak operacji i pusty tekst nie oznaczają usunięcia.
            </p>
            <button
              className="button primary"
              disabled={!content || !definition.languages.length}
              onClick={preview}
            >
              Utwórz trwały podgląd wszystkich tłumaczeń
            </button>
          </fieldset>
        </>
      )}
      {tab === 'profiles' && (
        <>
          <h3>Profile mapowania</h3>
          <p>
            Profil zapisuje format, języki i mapowanie. Nie zapisuje pliku, produktów ani zgody na
            import.
          </p>
          <button
            className="button"
            disabled={busy || remoteBusy || !liveFlags?.can_read}
            onClick={() => void read(loadProfiles)}
          >
            Odczytaj wszystkie profile
          </button>
          <label className="lfi-check">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Pokaż archiwalne
          </label>
          <div className="lfi-profiles">
            {profiles
              .filter((p) => showArchived || !p.archived)
              .map((p) => (
                <button
                  className="button"
                  key={p.id}
                  disabled={busy || remoteBusy}
                  onClick={() =>
                    void read(async (e) => {
                      const d = await request<Reply>(`/profiles/${encodeURIComponent(p.id)}`, e);
                      if (!accept(d)) return;
                      if (!d.profile) throw new Error('Brak profilu.');
                      setSelectedProfile(d.profile);
                      setProfileName(d.profile.name);
                      setProfileConsent(false);
                    })
                  }
                >
                  {p.name} · wersja {p.version}
                  {p.archived ? ' · archiwalny' : ''}
                </button>
              ))}
          </div>
          {selectedProfile && (
            <>
              <h4>
                {selectedProfile.name} · wersja {selectedProfile.version}
              </h4>
              <DefinitionView value={selectedProfile.definition} />
              <button
                className="button"
                disabled={freshBlocked || selectedProfile.archived}
                onClick={() =>
                  void read(async (e) => {
                    const d = await request<Reply>(
                      `/profiles/${encodeURIComponent(selectedProfile.id)}`,
                      e,
                    );
                    if (!accept(d)) return;
                    const p = d.profile;
                    if (!p || p.archived)
                      throw new Error('Profil jest niedostępny lub archiwalny.');
                    invalidate();
                    setDefinition(copy(p.definition));
                    setAppliedProfile({ id: p.id, version: p.version });
                    setSelectedProfile(p);
                    setProfileName(p.name);
                    setTab('import');
                    setStatus(
                      'Skopiowano świeżo odczytaną definicję profilu. Plik wymaga nowego podglądu.',
                    );
                  })
                }
              >
                Użyj świeżo odczytanego profilu
              </button>
            </>
          )}
          <fieldset disabled={freshBlocked}>
            <legend>Zapis definicji</legend>
            <label>
              Nazwa profilu
              <input
                maxLength={120}
                value={profileName}
                onChange={(e) => {
                  setProfileName(e.target.value);
                  setProfileConsent(false);
                }}
              />
            </label>
            <label className="lfi-check">
              <input
                type="checkbox"
                checked={profileConsent}
                onChange={(e) => setProfileConsent(e.target.checked)}
              />
              Potwierdzam zapis definicji. Aktualizacja lub archiwizacja obejmie wybraną wersję
              profilu.
            </label>
            <div className="lfi-toolbar">
              <button className="button" disabled={!profileConsent} onClick={() => saveProfile()}>
                Zapisz jako nowy profil
              </button>
              <button
                className="button"
                disabled={!profileConsent || !selectedProfile}
                onClick={() => saveProfile(true)}
              >
                Aktualizuj wybraną wersję
              </button>
              {selectedProfile && (
                <button
                  className="button"
                  disabled={!profileConsent}
                  onClick={() => saveProfile(true, !selectedProfile.archived)}
                >
                  {selectedProfile.archived ? 'Przywróć profil' : 'Archiwizuj profil'}
                </button>
              )}
            </div>
            <p>
              Przy konflikcie wersji odczytaj profil i ponownie zdecyduj o zmianie. Nie nadpisujemy
              nowszej wersji automatycznie.
            </p>
          </fieldset>
        </>
      )}
      {tab === 'history' && (
        <>
          <h3>Historia importów</h3>
          <div className="lfi-toolbar">
            <label>
              Rodzaj historii
              <select
                value={historyKind}
                disabled={busy || remoteBusy}
                onChange={(e) => {
                  setHistoryKind(e.target.value as typeof historyKind);
                  setHistory([]);
                  setHistoryCursor(null);
                  setHistoryLoaded(false);
                  historyCursors.current.clear();
                }}
              >
                <option value="previews">Podglądy</option>
                <option value="executions">Wykonania</option>
              </select>
            </label>
            <button
              className="button"
              disabled={busy || remoteBusy || !liveFlags?.can_read}
              onClick={() => void read((e) => loadHistory(e))}
            >
              Odczytaj historię
            </button>
          </div>
          {historyLoaded && !history.length && (
            <p>Odczyt zakończony. Brak importów w tym zakresie.</p>
          )}
          {history.map((h) => (
            <div className="lfi-history-row" key={h.id}>
              <strong>
                {date(h.created_at)} · {h.summary.source_rows} wierszy · {h.summary.total_pairs} par
                · {h.definition.languages.map((l) => l.locale).join(', ')}
              </strong>
              <small>
                {historyKind === 'executions' || h.executed_execution_id
                  ? 'Wykonany'
                  : h.summary.ready
                    ? 'Podgląd gotowy'
                    : 'Podgląd z błędami'}{' '}
                · zmiany {h.summary.changed_pairs} · błędy {h.summary.invalid}
              </small>
              <button
                className="button"
                disabled={busy || remoteBusy}
                onClick={() =>
                  void read((e) =>
                    loadReview(historyKind === 'previews' ? 'preview' : 'execution', h.id, e),
                  )
                }
              >
                Odczytaj pełny szczegół
              </button>
            </div>
          ))}
          {historyCursor && (
            <button
              className="button"
              disabled={busy || remoteBusy}
              onClick={() => void read((e) => loadHistory(e, true))}
            >
              Więcej historii
            </button>
          )}
        </>
      )}
      {review && (
        <div className="lfi-review">
          <h3>
            {review.kind === 'execution'
              ? 'Trwały wynik importu'
              : '3. Pełny podgląd przed zapisem'}
          </h3>
          <DefinitionView value={review.head.definition} />
          <div className="lfi-counts">
            <span>Wiersze źródła: {review.head.summary.source_rows}</span>
            <span>Produkty: {review.head.summary.product_count}</span>
            <span>Pary: {review.head.summary.total_pairs}</span>
            <span>Zmiany: {review.head.summary.changed_pairs}</span>
            <span>Bez zmian: {review.head.summary.unchanged_pairs}</span>
            <span>Błędy: {review.head.summary.invalid}</span>
            <span>Konflikty: {review.head.summary.conflicts}</span>
            <span>
              Pominięte wpisy innych języków: {review.head.summary.skipped_locale_entries}
            </span>
          </div>
          <div className="lfi-scroll">
            <table className="lfi-summary-table">
              <thead>
                <tr>
                  <th>Język</th>
                  <th>Pary</th>
                  <th>Zmiany</th>
                  <th>Bez zmian</th>
                  <th>Błędy / konflikty</th>
                  <th>Pozostające braki</th>
                </tr>
              </thead>
              <tbody>
                {review.head.per_locale.map((l) => (
                  <tr key={l.locale}>
                    <td>{l.locale}</td>
                    <td>{l.total_pairs}</td>
                    <td>{l.changed_pairs}</td>
                    <td>{l.unchanged_pairs}</td>
                    <td>
                      {l.invalid} / {l.conflicts}
                    </td>
                    <td>{l.missing_after_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p role="status">
            {review.complete
              ? `Odczytano wszystkie ${review.rows.length} par. Zakres nie został obcięty.`
              : 'Odczyt nie jest kompletny. Zgoda i zapis są zablokowane.'}
          </p>
          <RowsView key={review.head.id} rows={review.rows} />
          {review.head.executed_execution_id && (
            <>
              <p>Ten podgląd został już wykonany. Nie twórz ponownego zapisu.</p>
              <button
                className="button"
                disabled={busy || remoteBusy}
                onClick={() =>
                  void read((e) => loadReview('execution', review.head.executed_execution_id!, e))
                }
              >
                Odczytaj wcześniejsze wykonanie
              </button>
            </>
          )}
          {review.kind === 'preview' && !review.head.executed_execution_id && (
            <fieldset
              disabled={
                freshBlocked ||
                !review.complete ||
                !review.head.can_execute ||
                !review.head.summary.ready
              }
            >
              <legend>4. Zgoda na całą partię</legend>
              {requiredAck.map((locale) => (
                <label className="lfi-check" key={locale}>
                  <input
                    type="checkbox"
                    checked={ack.includes(locale)}
                    onChange={(e) =>
                      setAck((old) =>
                        e.target.checked
                          ? [...old.filter((l) => l !== locale), locale]
                          : old.filter((l) => l !== locale),
                      )
                    }
                  />
                  Akceptuję pozostające braki tłumaczeń w języku {locale} (
                  {review.head.per_locale.find((l) => l.locale === locale)!.missing_after_count}).
                </label>
              ))}
              <label className="lfi-check">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Sprawdziłem wszystkie teksty przed i po, usunięcia i pominięcia. Zatwierdzam całą
                partię {review.head.summary.total_pairs} par w{' '}
                {review.head.definition.languages.length} językach.
              </label>
              <button
                className="button primary"
                disabled={!executeAllowed}
                onClick={() =>
                  attempt(
                    'execute',
                    `/previews/${encodeURIComponent(review.head.id)}/execute`,
                    {
                      client_key: crypto.randomUUID(),
                      scope_hash: review.head.scope_hash,
                      confirmed: true,
                      ack_missing_locale_codes: [...ack].sort(),
                    },
                    'Wykonanie całego importu tłumaczeń',
                  )
                }
              >
                Zatwierdź cały import tłumaczeń
              </button>
            </fieldset>
          )}
          {review.kind === 'preview' && !review.head.summary.ready && (
            <p className="lfi-error">
              Partia zawiera błędy lub konflikty. Żaden poprawny wiersz nie zostanie zapisany
              osobno. Popraw źródło i przygotuj nowy podgląd.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
