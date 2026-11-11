import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import { catalogXmlPathValid } from '../shared/catalog-xml-path';
import {
  SupplierRemoteFeeds,
  getSupplierRemoteFeedsSource,
  getSupplierRemoteFeedsLocked,
  subscribeSupplierRemoteFeedsLock,
} from './supplier-remote-feeds';
import './supplier-file-sources.css';

type Flags = {
  available: boolean;
  can_read: boolean;
  can_write: boolean;
  can_read_value?: boolean;
  current_role: string;
  read_only: boolean;
};
type Field =
  | 'remote_id'
  | 'remote_variant_id'
  | 'sku'
  | 'name'
  | 'ean'
  | 'description'
  | 'cost_minor'
  | 'quantity'
  | 'handling_days';
type ValueType = 'text' | 'integer' | 'decimal_money';
type Mapping = { path: string; value_type: ValueType };
type Config = {
  format: 'csv' | 'xml';
  delimiter: ';' | ',' | '\t' | '|';
  record_path?: string;
  fields: Partial<Record<Field, Mapping>>;
};
type Source = {
  id: string;
  kind: 'file';
  supplier_id: string;
  supplier_name?: string;
  name: string;
  language: string;
  currency: string;
  max_handling_days: number;
  paused: boolean;
  version: number;
  config: Config;
};
type Snapshot = {
  unit_cost?: number | string | null;
  quantity: number;
  name: string;
  sku: string;
  currency: string;
  active?: boolean;
  description?: string;
  handling?: { quantity: number; maxHandlingDays: number }[];
};
type SavedItem = { snapshot: Snapshot; version: number };
type Row = {
  index: number;
  remote_product_id: string;
  remote_variant_id: string;
  sku: string;
  name: string;
  snapshot: Snapshot | null;
  before: Snapshot | null;
  after?: SavedItem;
  errors: string[];
  item_id: string | null;
  expected_version: number | null;
  status: 'new' | 'changed' | 'unchanged' | 'invalid';
};
type Missing = {
  id: string;
  version: number;
  remote_product_id: string;
  remote_variant_id: string;
  sku: string;
  snapshot: Snapshot;
  after?: SavedItem;
  item_id?: string;
};
type Summary = {
  total: number;
  valid: number;
  invalid: number;
  new: number;
  changed: number;
  unchanged: number;
  missing: number;
};
type Evidence = {
  id: string;
  source_id: string;
  source_version: number;
  scope_hash: string;
  raw_hash: string;
  filename: string;
  scope: 'delta' | 'full';
  config_snapshot: Config;
  source_snapshot: Source;
  summary: Summary;
  rows: Row[];
  missing: Missing[];
  created_at: string;
};
type Preview = Evidence & {
  client_key: string;
  can_apply: boolean;
  executed_run_id: string | null;
};
type Run = Evidence & { preview_id: string };
type Reply = Flags & { source?: Source; preview?: Preview; run?: Run; reused?: boolean };
type Options = Flags & {
  limits: {
    rows: number;
    file_bytes: number;
    source_items: number;
    preview_bytes: number;
    retained_evidence_bytes: number;
  };
};
type SourceList = {
  data: {
    id: string;
    kind?: string;
    name?: string;
    channel_name?: string;
    supplier_name?: string;
  }[];
  meta: { cursor: string | null };
};
type SupplierList = {
  data: { id: string; name: string; active: boolean }[];
  meta: { cursor: string | null };
};
type History = Flags & {
  data: Run[];
  meta: { cursor: string | null; total: number; has_more: boolean };
};
type Attempt = {
  scope: string;
  path: string;
  method: 'POST' | 'PATCH';
  body: string;
  kind: 'create' | 'update' | 'preview' | 'apply';
  label: string;
};
type Retained = { scope: string; attempt: Attempt | null; inFlight: boolean };
let retained: Retained = { scope: '', attempt: null, inFlight: false };
let actorContext = '';
const listeners = new Set<() => void>();
function publish() {
  listeners.forEach((fn) => fn());
}
export function resetSupplierFileSourcesContext(contextKey: string) {
  if (actorContext !== contextKey) {
    actorContext = contextKey;
    retained = { scope: '', attempt: null, inFlight: false };
    publish();
  }
}
export function subscribeSupplierFileSourcesLock(
  contextKey: string,
  callback: (locked: boolean) => void,
) {
  const listener = () =>
    callback(actorContext === contextKey && (!!retained.attempt || retained.inFlight));
  listeners.add(listener);
  listener();
  return () => {
    listeners.delete(listener);
  };
}
function scopeState(scope: string) {
  if (retained.scope !== scope) {
    retained = { scope, attempt: null, inFlight: false };
    publish();
  }
  return retained;
}
const fields: { key: Field; label: string; required?: boolean }[] = [
  { key: 'remote_id', label: 'ID produktu dostawcy', required: true },
  { key: 'name', label: 'Nazwa produktu dostawcy', required: true },
  { key: 'cost_minor', label: 'Cena zakupu netto', required: true },
  { key: 'quantity', label: 'Dostępność dostawcy', required: true },
  { key: 'remote_variant_id', label: 'ID wariantu dostawcy' },
  { key: 'sku', label: 'SKU dostawcy' },
  { key: 'ean', label: 'EAN' },
  { key: 'description', label: 'Opis' },
  { key: 'handling_days', label: 'Czas obsługi w dniach' },
];
const statusNames = { new: 'Nowa', changed: 'Zmiana', unchanged: 'Bez zmian', invalid: 'Błąd' };
const defaultType = (key: Field): ValueType =>
  ['cost_minor', 'quantity', 'handling_days'].includes(key) ? 'integer' : 'text';
const blankConfig = (): Config => ({ format: 'csv', delimiter: ';', fields: {} });
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function money(value: Snapshot['unit_cost'], currency: string) {
  if (value === undefined || value === null) return 'Brak danych';
  if (!/^\d+$/.test(String(value))) return 'Niepoprawna kwota';
  const n = BigInt(String(value));
  return `${n / 100n},${String(n % 100n).padStart(2, '0')} ${currency}`;
}
function ConfigView({ config }: { config: Config }) {
  return (
    <div className="sfs-config-view">
      <p>{config.format === 'xml' ? `XML · ${config.record_path}` : 'CSV'}</p>
      <ul>
        {fields
          .filter((f) => config.fields[f.key])
          .map((f) => {
            const mapping = config.fields[f.key]!;
            return (
              <li key={f.key}>
                {f.label}: <code>{mapping.path}</code> ·{' '}
                {mapping.value_type === 'decimal_money'
                  ? 'kwota dziesiętna z kropką'
                  : mapping.value_type === 'integer'
                    ? f.key === 'cost_minor'
                      ? 'najmniejsza jednostka waluty'
                      : 'liczba całkowita'
                    : 'tekst'}
              </li>
            );
          })}
      </ul>
    </div>
  );
}
function SnapshotView({ value, financial }: { value: Snapshot | null; financial: boolean }) {
  if (!value) return <>Brak wcześniejszej pozycji lub poprawnych danych</>;
  return (
    <div>
      <strong>{value.name}</strong>
      <p>
        SKU: {value.sku || 'Brak'} · dostępność {value.quantity}
        {value.active === false && ' · nieaktywna u dostawcy'}
      </p>
      {financial && <p>Zakup netto: {money(value.unit_cost, value.currency)}</p>}
      {value.description && (
        <details>
          <summary>Opis</summary>
          <pre>{value.description}</pre>
        </details>
      )}
      {value.handling?.map((h, i) => (
        <p key={i}>
          {h.quantity} szt. · obsługa do {h.maxHandlingDays} dni
        </p>
      ))}
    </div>
  );
}
function EvidenceView({ evidence, financial }: { evidence: Evidence; financial: boolean }) {
  const [page, setPage] = useState(0),
    [missingPage, setMissingPage] = useState(0);
  const visible = evidence.rows.slice(page * 50, (page + 1) * 50);
  return (
    <div className="sfs-evidence">
      <p>
        {evidence.filename || 'Wklejona treść'} · {date(evidence.created_at)} ·{' '}
        {evidence.scope === 'full' ? 'Pełny katalog' : 'Tylko pozycje z pliku'} ·{' '}
        {evidence.source_snapshot.currency} netto
      </p>
      <p>
        Źródło: {evidence.source_snapshot.name} · wersja {evidence.source_version} · obsługa do{' '}
        {evidence.source_snapshot.max_handling_days} dni.
      </p>
      <ConfigView config={evidence.config_snapshot} />
      <p>
        Wiersze {evidence.summary.total} · nowe {evidence.summary.new} · zmiany{' '}
        {evidence.summary.changed} · bez zmian {evidence.summary.unchanged} · błędy{' '}
        {evidence.summary.invalid} · brakujące {evidence.summary.missing}.
      </p>
      <p>
        Odczytano cały zakres {evidence.rows.length} wierszy i {evidence.missing.length} brakujących
        pozycji. Widok stron nie zmienia zakresu zgody.
      </p>
      <div className="sfs-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Wiersz / tożsamość dostawcy</th>
              <th>Przed</th>
              <th>Po</th>
              <th>Wynik</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.index}>
                <td>
                  {row.index + 1}. {row.name || row.sku || 'Brak nazwy'}
                  <p>
                    ID: {row.remote_product_id || 'Brak'}
                    {row.remote_variant_id && ` · wariant ${row.remote_variant_id}`}
                  </p>
                </td>
                <td>
                  <SnapshotView value={row.before} financial={financial} />
                </td>
                <td>
                  <SnapshotView
                    value={row.after ? row.after.snapshot : row.snapshot}
                    financial={financial}
                  />
                  {row.after && <p>Zapisana wersja: {row.after.version}</p>}
                </td>
                <td>
                  {statusNames[row.status]}
                  {row.errors.map((error, i) => (
                    <p className="sfs-error-text" key={i}>
                      {error}
                    </p>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {evidence.rows.length > 50 && (
        <nav aria-label="Wiersze pliku">
          <button
            type="button"
            className="button"
            disabled={page === 0}
            onClick={() => setPage((v) => v - 1)}
          >
            Poprzednie 50
          </button>
          <span>
            Strona {page + 1} z {Math.ceil(evidence.rows.length / 50)}
          </span>
          <button
            type="button"
            className="button"
            disabled={(page + 1) * 50 >= evidence.rows.length}
            onClick={() => setPage((v) => v + 1)}
          >
            Następne 50
          </button>
        </nav>
      )}
      {!!evidence.missing.length && (
        <details>
          <summary>Brakujące pozycje · {evidence.missing.length}</summary>
          <p>
            Pełny katalog wycofuje te pozycje z dostępnością zero u dostawcy. Powiązane produkty,
            ceny sprzedaży i własne zapasy pozostają.
          </p>
          {evidence.missing.slice(missingPage * 50, (missingPage + 1) * 50).map((item) => (
            <div className="sfs-missing" key={item.id}>
              <p>
                {item.sku || item.remote_product_id}
                {item.remote_variant_id && ` · wariant ${item.remote_variant_id}`}
              </p>
              <p>Przed:</p>
              <SnapshotView value={item.snapshot} financial={financial} />
              {item.after && (
                <>
                  <p>Po · zapisana wersja {item.after.version}:</p>
                  <SnapshotView value={item.after.snapshot} financial={financial} />
                </>
              )}
            </div>
          ))}
          {evidence.missing.length > 50 && (
            <nav aria-label="Brakujące pozycje">
              <button
                type="button"
                className="button"
                disabled={!missingPage}
                onClick={() => setMissingPage((v) => v - 1)}
              >
                Poprzednie brakujące
              </button>
              <span>
                Strona {missingPage + 1} z {Math.ceil(evidence.missing.length / 50)}
              </span>
              <button
                type="button"
                className="button"
                disabled={(missingPage + 1) * 50 >= evidence.missing.length}
                onClick={() => setMissingPage((v) => v + 1)}
              >
                Następne brakujące
              </button>
            </nav>
          )}
        </details>
      )}
      <details>
        <summary>Identyfikatory dowodu</summary>
        <p>Plik: {evidence.raw_hash}</p>
        <p>Zakres: {evidence.scope_hash}</p>
      </details>
    </div>
  );
}
export type SupplierFileSourcesProps = {
  contextKey: string;
  readOnly: boolean;
  admin: boolean;
  refresh: number;
  reload: () => void;
  notify: (message: string) => void;
  onLockedChange?: (locked: boolean) => void;
  externalWriteBlocked?: boolean;
};
export function SupplierFileSources({
  contextKey,
  readOnly,
  admin,
  refresh,
  reload,
  notify,
  onLockedChange,
  externalWriteBlocked = false,
}: SupplierFileSourcesProps) {
  const scope = `${contextKey}:${readOnly}:${admin}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const epoch = useRef(0),
    busyRef = useRef(false),
    flagsRef = useRef<Flags | null>(null);
  const valueGrant = useRef<boolean | undefined>(undefined);
  const authorized = useRef('');
  const [, render] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const [options, setOptions] = useState<Options | null>(null),
    [flags, setFlags] = useState<Flags | null>(null);
  const [sources, setSources] = useState<SourceList['data']>([]),
    [sourceCursor, setSourceCursor] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierList['data']>([]),
    [supplierCursor, setSupplierCursor] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null),
    [sourceId, setSourceId] = useState('');
  const [name, setName] = useState(''),
    [supplierId, setSupplierId] = useState(''),
    [currency, setCurrency] = useState(''),
    [days, setDays] = useState('2');
  const [config, setConfig] = useState<Config>(blankConfig),
    [content, setContent] = useState(''),
    [filename, setFilename] = useState(''),
    [fileScope, setFileScope] = useState<'delta' | 'full'>('delta');
  const [configDraftVersion, setConfigDraftVersion] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null),
    [run, setRun] = useState<Run | null>(null),
    [history, setHistory] = useState<Run[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [tab, setTab] = useState<'source' | 'file' | 'history'>('source'),
    [confirmRows, setConfirmRows] = useState(false),
    [confirmMissing, setConfirmMissing] = useState(false);
  const [dataScope, setDataScope] = useState('');
  const [remoteLocked, setRemoteLocked] = useState(false);
  const current = retained.scope === scope ? retained : null;
  const pending = current?.attempt ?? null;
  const locked = !!pending || !!current?.inFlight || busy;
  const visible = dataScope === scope && authorized.current === scope;
  const readable = visible && !!flags?.available && !!flags.can_read;
  const writable = readable && admin && !readOnly && !!flags?.can_write && !flags.read_only;
  const freshDisabled = !writable || locked || externalWriteBlocked || remoteLocked;
  function clearDrafts() {
    setContent('');
    setFilename('');
    setConfig(blankConfig());
    setConfigDraftVersion(null);
    setName('');
    setCurrency('');
    setSupplierId('');
    setDays('2');
    setFileScope('delta');
    setSource(null);
    setSourceId('');
    setPreview(null);
    setRun(null);
    setHistory([]);
    setHistoryCursor(null);
    setConfirmRows(false);
    setConfirmMissing(false);
  }
  function purge() {
    authorized.current = '';
    flagsRef.current = null;
    valueGrant.current = undefined;
    setFlags(null);
    setOptions(null);
    setSources([]);
    setSuppliers([]);
    clearDrafts();
    if (retained.scope === scopeRef.current) {
      retained.attempt = null;
      retained.inFlight = false;
      publish();
    }
  }
  function accept(next: Flags) {
    if (!next.available || !next.can_read) {
      purge();
      return false;
    }
    const old = flagsRef.current;
    if (
      old &&
      (old.current_role !== next.current_role ||
        (valueGrant.current !== undefined &&
          next.can_read_value !== undefined &&
          valueGrant.current !== next.can_read_value) ||
        (old.can_write && !next.can_write) ||
        (!old.read_only && next.read_only))
    ) {
      clearDrafts();
      if (retained.scope === scopeRef.current) {
        retained.attempt = null;
        publish();
      }
    }
    if (next.can_read_value !== undefined) valueGrant.current = next.can_read_value;
    flagsRef.current = next;
    setFlags(next);
    authorized.current = scopeRef.current;
    return true;
  }
  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    setError(err instanceof Error ? err.message : 'Operacja nie powiodła się.');
    if (err instanceof ApiError && [401, 403, 423].includes(err.status)) purge();
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    const sentScope = scopeRef.current;
    try {
      const result = await api<T>(path, method, body);
      if (e !== epoch.current || sentScope !== scopeRef.current || actorContext !== contextKey)
        throw new DOMException('Kontekst zmieniono.', 'AbortError');
      return result;
    } catch (err) {
      if (e !== epoch.current || sentScope !== scopeRef.current || actorContext !== contextKey)
        throw new DOMException('Kontekst zmieniono.', 'AbortError');
      throw err;
    }
  }
  async function read<T>(work: (e: number) => Promise<T>, apply: (value: T) => void) {
    if (busyRef.current) return;
    const e = epoch.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await work(e);
      if (e === epoch.current) apply(value);
    } catch (err) {
      if (e === epoch.current) fail(err);
    } finally {
      if (e === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const handler = () => render((v) => v + 1);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);
  useEffect(() => subscribeSupplierRemoteFeedsLock(contextKey, setRemoteLocked), [contextKey]);
  useEffect(() => {
    onLockedChange?.(locked);
  }, [locked, onLockedChange]);
  useEffect(
    () => () => {
      onLockedChange?.(retained.scope === scope && (!!retained.attempt || retained.inFlight));
    },
    [scope, onLockedChange],
  );
  function loadMetadata() {
    void read(
      async (e) => {
        const o = await request<Options>('/supplier-file-sources/options', e);
        if (!o.available || !o.can_read) return { o, s: null, p: null };
        const [s, p] = await Promise.all([
          request<SourceList>('/supplier-sources?limit=100', e),
          request<SupplierList>('/suppliers?limit=50', e),
        ]);
        return { o, s, p };
      },
      ({ o, s, p }) => {
        if (!o.available || !o.can_read) {
          purge();
          setOptions(o);
          authorized.current = scopeRef.current;
          return;
        }
        setOptions(o);
        if (!accept(o) || !s || !p) return;
        setSources(s.data.filter((item) => item.kind === 'file'));
        setSourceCursor(s.meta.cursor);
        setSuppliers(p.data.filter((item) => item.active));
        setSupplierCursor(p.meta.cursor);
      },
    );
  }
  useEffect(() => {
    ++epoch.current;
    busyRef.current = false;
    setBusy(false);
    authorized.current = '';
    flagsRef.current = null;
    valueGrant.current = undefined;
    setFlags(null);
    setOptions(null);
    clearDrafts();
    setSources([]);
    setSuppliers([]);
    setError('');
    setStatus('');
    setDataScope(scope);
    resetSupplierFileSourcesContext(contextKey);
    scopeState(scope);
    loadMetadata();
    return () => {
      ++epoch.current;
      busyRef.current = false;
      authorized.current = '';
    };
  }, [scope]);
  useEffect(() => {
    if (!visible || busyRef.current || !sourceId) return;
    void read(
      (e) => request<Reply>('/supplier-file-sources/' + sourceId, e),
      (r) => {
        if (accept(r) && r.source) setSource(r.source);
      },
    );
  }, [refresh]);
  function invalidate() {
    setPreview(null);
    setRun(null);
    setConfirmRows(false);
    setConfirmMissing(false);
    setStatus('');
  }
  function validatedConfig(): Config {
    const selected: Config['fields'] = {},
      paths = new Set<string>();
    for (const f of fields) {
      const value = config.fields[f.key],
        path = value?.path.trim() ?? '';
      if (!path) {
        if (f.required) throw Error(`Wypełnij mapowanie: ${f.label}.`);
        continue;
      }
      if (
        config.format === 'xml'
          ? !catalogXmlPathValid(path, false, 16)
          : path.length > 80 ||
            /[\u0000-\u001f\u007f-\u009f]/u.test(path) ||
            ['__proto__', 'prototype', 'constructor'].includes(path)
      )
        throw Error(`Niepoprawne mapowanie: ${f.label}.`);
      const id = config.format === 'csv' ? path.toLowerCase() : path;
      if (paths.has(id)) throw Error('Jedno pole źródłowe nie może być przypisane do kilku pól.');
      paths.add(id);
      selected[f.key] = { path, value_type: value!.value_type };
    }
    const recordPath = config.record_path?.trim();
    if (config.format === 'xml' && (!recordPath || !catalogXmlPathValid(recordPath, true, 16)))
      throw Error('Wskaż pełną ścieżkę produktów w XML.');
    return {
      format: config.format,
      delimiter: config.delimiter,
      fields: selected,
      ...(config.format === 'xml' ? { record_path: recordPath } : {}),
    };
  }
  function validateEvidence(value: Evidence) {
    if (
      !value.id ||
      !/^[a-f0-9]{64}$/.test(value.scope_hash) ||
      !/^[a-f0-9]{64}$/.test(value.raw_hash) ||
      !Number.isInteger(value.summary.total) ||
      value.summary.total < 1 ||
      value.summary.total > 500 ||
      value.rows.length !== value.summary.total ||
      value.missing.length !== value.summary.missing ||
      value.missing.length > 10000
    )
      throw Error('Nie odczytano pełnego dowodu. Zgoda jest zablokowana.');
    if (
      Object.values(value.summary).some((n) => !Number.isInteger(n) || n < 0) ||
      value.summary.valid + value.summary.invalid !== value.summary.total ||
      value.summary.new +
        value.summary.changed +
        value.summary.unchanged +
        value.summary.invalid !==
        value.summary.total
    )
      throw Error('Niezgodne podsumowanie wierszy. Zgoda jest zablokowana.');
    const ids = new Set<number>();
    for (const row of value.rows) {
      if (
        !Number.isInteger(row.index) ||
        row.index < 0 ||
        row.index >= value.rows.length ||
        ids.has(row.index)
      )
        throw Error('Nieprawidłowy lub powtórzony wiersz dowodu.');
      ids.add(row.index);
    }
    if (new Set(value.missing.map((m) => m.id)).size !== value.missing.length)
      throw Error('Powtórzone brakujące pozycje.');
  }
  function validateRun(value: Run) {
    validateEvidence(value);
    if (
      !value.preview_id ||
      value.rows.some((row) => !row.item_id || !row.after?.snapshot) ||
      value.missing.some((item) => !item.item_id || !item.after?.snapshot)
    )
      throw Error('Brak pełnego potwierdzenia zapisanych pozycji. Odczytaj wynik ponownie.');
  }
  async function send(attempt: Attempt) {
    const state = scopeState(scopeRef.current);
    if (
      busyRef.current ||
      state.inFlight ||
      attempt.scope !== scopeRef.current ||
      !admin ||
      readOnly ||
      (state.attempt && state.attempt !== attempt)
    )
      return;
    const e = epoch.current,
      sentScope = scopeRef.current;
    state.attempt = attempt;
    state.inFlight = true;
    publish();
    busyRef.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    let acknowledged = false;
    try {
      const live = await request<Options>('/supplier-file-sources/options', e);
      if (!accept(live) || !live.can_write || live.read_only || live.current_role !== 'admin')
        throw new ApiError('Brak aktualnego prawa zapisu.', 403);
      const r = await request<Reply>(attempt.path, e, attempt.method, JSON.parse(attempt.body));
      if (!accept(r)) return;
      if (attempt.kind === 'create' || attempt.kind === 'update') {
        if (!r.source?.id) throw Error('Brak potwierdzenia zapisu źródła.');
        setSource(r.source);
        setSourceId(r.source.id);
        setName(r.source.name);
        setConfig(structuredClone(r.source.config));
        setConfigDraftVersion(r.source.version);
        setCurrency(r.source.currency);
        setSupplierId(r.source.supplier_id);
        setDays(String(r.source.max_handling_days));
        setSources((v) => [...v.filter((s) => s.id !== r.source!.id), r.source!]);
        setTab('file');
        invalidate();
      } else if (attempt.kind === 'preview') {
        if (!r.preview) throw Error('Brak potwierdzenia utworzenia podglądu.');
        if (!source) {
          setSource({
            ...r.preview.source_snapshot,
            id: r.preview.source_id,
            kind: 'file',
            version: r.preview.source_version,
            config: r.preview.config_snapshot,
          });
          setSourceId(r.preview.source_id);
        }
        validateEvidence(r.preview);
        setPreview(r.preview);
        setRun(null);
        setConfirmRows(false);
        setConfirmMissing(false);
        setTab('file');
      } else {
        if (!r.run) throw Error('Brak potwierdzenia zastosowania pliku.');
        if (!source) {
          setSource({
            ...r.run.source_snapshot,
            id: r.run.source_id,
            kind: 'file',
            version: r.run.source_version,
            config: r.run.config_snapshot,
          });
          setSourceId(r.run.source_id);
        }
        validateRun(r.run);
        setRun(r.run);
        setPreview((p) => (p ? { ...p, can_apply: false, executed_run_id: r.run!.id } : p));
        setTab('file');
        reload();
      }
      acknowledged = true;
      state.attempt = null;
      publish();
      if (attempt.kind === 'create' || attempt.kind === 'update') reload();
      setStatus(
        r.reused
          ? 'Odczytano wynik wcześniej wykonanej dokładnie tej próby.'
          : 'Operacja zapisana.',
      );
      notify(
        attempt.kind === 'apply'
          ? 'Katalog dostawcy z pliku uzgodniony.'
          : 'Dowód operacji zapisany.',
      );
    } catch (err) {
      if (e !== epoch.current || sentScope !== scopeRef.current || actorContext !== contextKey)
        return;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408) {
        state.attempt = null;
        publish();
        setConfirmRows(false);
        setConfirmMissing(false);
      }
      fail(err);
      if (!acknowledged && state.attempt)
        setError(
          'Wynik jest nieznany. Zablokowano nowe zapisy i edycję. Ponów ręcznie wyłącznie dokładną zapamiętaną próbę lub odczytaj historię.',
        );
    } finally {
      if (retained === state) {
        state.inFlight = false;
        publish();
      }
      if (e === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function start(
    kind: Attempt['kind'],
    path: string,
    method: Attempt['method'],
    body: object,
    label: string,
  ) {
    if (
      freshDisabled ||
      getSupplierRemoteFeedsLocked(contextKey) ||
      busyRef.current ||
      retained.attempt ||
      retained.inFlight
    )
      return;
    void send({ kind, path, method, body: JSON.stringify(body), label, scope: scopeRef.current });
  }
  function saveSource() {
    if (freshDisabled) return;
    try {
      const c = validatedConfig();
      if (!name.trim() || name.trim().length > 120)
        throw Error('Nazwa źródła wymaga 1–120 znaków.');
      if (source) {
        if (configDraftVersion === null)
          throw Error('Najpierw odczytaj aktualną konfigurację źródła.');
        start(
          'update',
          '/supplier-file-sources/' + source.id,
          'PATCH',
          {
            client_key: crypto.randomUUID(),
            version: configDraftVersion,
            name: name.trim(),
            config: c,
          },
          'Zmiana konfiguracji źródła',
        );
      } else {
        if (!supplierId || !currency) throw Error('Wybierz dostawcę i walutę ceny zakupu netto.');
        if (!/^(0|[1-9][0-9]*)$/.test(days) || BigInt(days) > 365n)
          throw Error('Czas obsługi musi być liczbą całkowitą 0–365.');
        start(
          'create',
          '/supplier-file-sources',
          'POST',
          {
            client_key: crypto.randomUUID(),
            supplier_id: supplierId,
            name: name.trim(),
            language: 'pl',
            currency,
            max_handling_days: Number(days),
            config: c,
          },
          'Utworzenie źródła plikowego',
        );
      }
    } catch (err) {
      fail(err);
    }
  }
  function prepare() {
    if (!source || freshDisabled) return;
    if (!content.trim() || bytes(content) > (options?.limits.file_bytes ?? 2097152)) {
      setError('Wybierz pełny plik UTF-8 do 2 MiB. Nie obcięto treści.');
      return;
    }
    start(
      'preview',
      `/supplier-file-sources/${source.id}/previews`,
      'POST',
      {
        client_key: crypto.randomUUID(),
        version: source.version,
        filename,
        content,
        scope: fileScope,
      },
      'Utworzenie podglądu pliku',
    );
  }
  async function upload(file: File | undefined) {
    if (!file || freshDisabled || getSupplierRemoteFeedsLocked(contextKey) || busyRef.current)
      return;
    const e = epoch.current;
    busyRef.current = true;
    setBusy(true);
    invalidate();
    try {
      if (file.size > (options?.limits.file_bytes ?? 2097152))
        throw Error('Plik przekracza 2 MiB.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer(),
      );
      if (e !== epoch.current || actorContext !== contextKey) return;
      if (bytes(text) > (options?.limits.file_bytes ?? 2097152))
        throw Error('Plik przekracza 2 MiB.');
      setContent(text);
      setFilename(file.name);
    } catch (err) {
      if (e === epoch.current)
        fail(
          err instanceof TypeError
            ? Error('Plik nie jest poprawnym UTF-8. Nie zastąpiono treści.')
            : err,
        );
    } finally {
      if (e === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function choose(id: string) {
    if (locked || remoteLocked || getSupplierRemoteFeedsLocked(contextKey) || externalWriteBlocked)
      return;
    clearDrafts();
    setSourceId(id);
    if (!id) return;
    void read(
      (e) => request<Reply>('/supplier-file-sources/' + id, e),
      (r) => {
        if (!accept(r) || !r.source) return;
        setSource(r.source);
        setName(r.source.name);
        setConfig(structuredClone(r.source.config));
        setConfigDraftVersion(r.source.version);
        setSupplierId(r.source.supplier_id);
        setCurrency(r.source.currency);
        setDays(String(r.source.max_handling_days));
      },
    );
  }
  function reloadConfiguration() {
    if (
      !sourceId ||
      !readable ||
      locked ||
      remoteLocked ||
      externalWriteBlocked ||
      retained.attempt ||
      retained.inFlight
    )
      return;
    void read(
      (e) => request<Reply>('/supplier-file-sources/' + sourceId, e),
      (r) => {
        if (!accept(r) || !r.source) return;
        setSource(r.source);
        setName(r.source.name);
        setConfig(structuredClone(r.source.config));
        setConfigDraftVersion(r.source.version);
        setSupplierId(r.source.supplier_id);
        setCurrency(r.source.currency);
        setDays(String(r.source.max_handling_days));
        invalidate();
      },
    );
  }
  function readPreview() {
    if (!preview || !readable) return;
    void read(
      (e) => request<Reply>('/supplier-file-previews/' + preview.id, e),
      (r) => {
        if (!accept(r) || !r.preview) return;
        try {
          validateEvidence(r.preview);
          setPreview(r.preview);
          setConfirmRows(false);
          setConfirmMissing(false);
        } catch (err) {
          fail(err);
        }
      },
    );
  }
  function openRemotePreview(id: string) {
    if (!readable || busyRef.current || retained.attempt || retained.inFlight) return;
    void read(
      (e) => request<Reply>('/supplier-file-previews/' + id, e),
      (r) => {
        if (!accept(r) || !r.preview) return;
        try {
          validateEvidence(r.preview);
          const expectedSource = sourceId || getSupplierRemoteFeedsSource(contextKey);
          if (expectedSource && r.preview.source_id !== expectedSource)
            throw Error('Podgląd należy do innego źródła.');
          setSource(r.preview.source_snapshot);
          setSourceId(r.preview.source_id);
          setPreview(r.preview);
          setRun(null);
          setConfirmRows(false);
          setConfirmMissing(false);
          setTab('file');
        } catch (err) {
          fail(err);
        }
      },
    );
  }
  function loadHistory(more = false) {
    if (!source || !readable || (more && !historyCursor)) return;
    void read(
      (e) =>
        request<History>(
          `/supplier-file-sources/${source.id}/history?limit=25${more ? '&after=' + encodeURIComponent(historyCursor!) : ''}`,
          e,
        ),
      (r) => {
        if (!accept(r)) return;
        if (
          r.data.length > 25 ||
          new Set(r.data.map((item) => item.id)).size !== r.data.length ||
          (r.meta.has_more && (!r.meta.cursor || (more && r.meta.cursor === historyCursor)))
        ) {
          setError('Niekompletna lub powtórzona strona historii.');
          return;
        }
        try {
          r.data.forEach(validateRun);
        } catch (err) {
          fail(err);
          return;
        }
        setHistory((v) =>
          more ? [...v, ...r.data.filter((item) => !v.some((old) => old.id === item.id))] : r.data,
        );
        setHistoryCursor(r.meta.cursor);
      },
    );
  }
  const financial = flags?.can_read_value === true;
  return (
    <section className="supplier-file-sources panel" aria-label="Plikowe źródła dostawcy">
      <h2>Plikowe źródła dostawcy</h2>
      <p>
        Plik CSV lub XML → ceny zakupu netto i dostępność dostawcy → pełny podgląd → zgoda. Własne
        ceny sprzedaży i zapasy nie są zmieniane. Zakup oraz przyjęcie PZ są osobnymi operacjami.
      </p>
      {error && (
        <p className="sfs-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="sfs-status" role="status">
          {status}
        </p>
      )}
      <button
        type="button"
        className="button"
        disabled={busy || !!current?.inFlight}
        onClick={loadMetadata}
      >
        Odśwież źródła i uprawnienia
      </button>
      {pending && (
        <div className="sfs-pending" role="status">
          <strong>
            {current?.inFlight ? 'Trwa próba: ' : 'Nieznany wynik: '}
            {pending.label}
          </strong>
          <p>
            Treść i klucz są zachowane w RAM w tym samym kontekście, także po nawigacji. Nowe zapisy
            w katalogu dostawcy są wstrzymane. Nie odświeżaj strony przed rozstrzygnięciem. Odczyt
            historii sam nie usuwa próby.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={!writable || busy || !!current?.inFlight}
            onClick={() => void send(pending)}
          >
            Ponów dokładnie tę próbę
          </button>
        </div>
      )}
      {!visible || !options ? (
        <p>Odczytywanie dostępności i własnych źródeł…</p>
      ) : !readable ? (
        <p>Źródła plikowe nie są dostępne albo nie masz bieżącego prawa odczytu.</p>
      ) : (
        <>
          {!writable && (
            <p className="sfs-hint">
              Tryb odczytu. Zapisy wymagają bieżących uprawnień administratora do zakupów.
            </p>
          )}
          <label>
            Źródło plikowe
            <select
              value={sourceId}
              disabled={locked || remoteLocked || externalWriteBlocked}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="">— Nowe źródło / wybierz istniejące —</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.channel_name || s.id}
                  {s.supplier_name && ` · ${s.supplier_name}`}
                </option>
              ))}
            </select>
          </label>
          {sourceCursor && (
            <button
              type="button"
              className="button"
              disabled={locked || remoteLocked || externalWriteBlocked}
              onClick={() =>
                void read(
                  (e) =>
                    request<SourceList>(
                      '/supplier-sources?limit=100&after=' + encodeURIComponent(sourceCursor),
                      e,
                    ),
                  (r) => {
                    setSources((v) => [
                      ...v,
                      ...r.data.filter(
                        (s) => s.kind === 'file' && !v.some((old) => old.id === s.id),
                      ),
                    ]);
                    setSourceCursor(r.meta.cursor);
                  },
                )
              }
            >
              Więcej źródeł
            </button>
          )}
          <nav aria-label="Źródło i pliki">
            {(['source', 'file', 'history'] as const).map((v) => (
              <button
                type="button"
                className={'button ' + (tab === v ? 'primary' : '')}
                key={v}
                onClick={() => setTab(v)}
              >
                {v === 'source'
                  ? 'Konfiguracja źródła'
                  : v === 'file'
                    ? 'Plik i podgląd'
                    : 'Historia uzgodnień'}
              </button>
            ))}
          </nav>
          {tab === 'file' && preview && (
            <button
              type="button"
              className="button"
              disabled={busy || !readable}
              onClick={readPreview}
            >
              Odczytaj podgląd ponownie
            </button>
          )}
          {tab === 'source' && (
            <>
              {source && (
                <>
                  <button
                    type="button"
                    className="button"
                    disabled={locked || remoteLocked || externalWriteBlocked || !readable}
                    onClick={reloadConfiguration}
                  >
                    Odczytaj aktualną konfigurację · zastąp edycję
                  </button>
                  {configDraftVersion !== source.version && (
                    <p className="sfs-hint">
                      Źródło ma obecnie wersję {source.version}. Edycja zachowuje wersję{' '}
                      {configDraftVersion ?? 'nieodczytaną'}; odczytaj aktualną konfigurację przed
                      jej ponowną zmianą.
                    </p>
                  )}
                </>
              )}
              <fieldset disabled={freshDisabled}>
                <legend>
                  {source
                    ? `Konfiguracja · wersja edycji ${configDraftVersion ?? 'nieodczytana'}`
                    : 'Nowe nazwane źródło'}
                </legend>
                <div className="sfs-grid">
                  <label>
                    Nazwa źródła
                    <input
                      value={name}
                      maxLength={120}
                      onChange={(e) => {
                        invalidate();
                        setName(e.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Dostawca
                    <select
                      value={supplierId}
                      disabled={!!source}
                      onChange={(e) => setSupplierId(e.target.value)}
                    >
                      <option value="">— Wybierz własnego dostawcę —</option>
                      {source && !suppliers.some((s) => s.id === source.supplier_id) && (
                        <option value={source.supplier_id}>
                          {source.supplier_name || source.supplier_id}
                        </option>
                      )}
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Waluta ceny zakupu netto
                    <select
                      value={currency}
                      disabled={!!source}
                      onChange={(e) => setCurrency(e.target.value)}
                    >
                      <option value="">— Wybierz walutę —</option>
                      {['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Uwzględniaj dostępność z obsługą do (dni)
                    <input
                      value={days}
                      disabled={!!source}
                      inputMode="numeric"
                      onChange={(e) => setDays(e.target.value)}
                    />
                  </label>
                  <label>
                    Format pliku
                    <select
                      value={config.format}
                      onChange={(e) => {
                        invalidate();
                        setConfig((v) => ({
                          ...v,
                          format: e.target.value as Config['format'],
                          record_path: undefined,
                        }));
                      }}
                    >
                      <option value="csv">CSV</option>
                      <option value="xml">XML z mapowaniem</option>
                    </select>
                  </label>
                  {config.format === 'csv' ? (
                    <label>
                      Separator CSV
                      <select
                        value={config.delimiter}
                        onChange={(e) => {
                          invalidate();
                          setConfig((v) => ({
                            ...v,
                            delimiter: e.target.value as Config['delimiter'],
                          }));
                        }}
                      >
                        {[
                          [';', 'Średnik'],
                          [',', 'Przecinek'],
                          ['\t', 'Tabulator'],
                          ['|', 'Pionowa kreska'],
                        ].map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label>
                      Pełna ścieżka produktów
                      <input
                        value={config.record_path ?? ''}
                        placeholder="/feed/items/item"
                        onChange={(e) => {
                          invalidate();
                          setConfig((v) => ({ ...v, record_path: e.target.value }));
                        }}
                      />
                    </label>
                  )}
                </div>
                {supplierCursor && !source && (
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      void read(
                        (e) =>
                          request<SupplierList>(
                            '/suppliers?limit=50&after=' + encodeURIComponent(supplierCursor),
                            e,
                          ),
                        (r) => {
                          setSuppliers((v) => [
                            ...v,
                            ...r.data.filter((s) => s.active && !v.some((old) => old.id === s.id)),
                          ]);
                          setSupplierCursor(r.meta.cursor);
                        },
                      )
                    }
                  >
                    Więcej dostawców
                  </button>
                )}
                <p>
                  Język opisów: polski. ID produktu i wariantu mogą być własnymi identyfikatorami
                  dostawcy; SKU nie zastępuje ich tożsamości. Mapowanie nie nadaje cenom zakupu
                  znaczenia ceny sprzedaży.
                </p>
                <div className="sfs-grid">
                  {fields.map((f) => {
                    const value = config.fields[f.key] ?? {
                      path: '',
                      value_type: defaultType(f.key),
                    };
                    return (
                      <div className="sfs-field" key={f.key}>
                        <label>
                          {f.label}
                          {f.required ? ' · wymagane' : ' · opcjonalne'}
                          <input
                            value={value.path}
                            placeholder={
                              config.format === 'csv'
                                ? 'Dokładny nagłówek kolumny'
                                : 'Ścieżka lub @atrybut'
                            }
                            onChange={(e) => {
                              invalidate();
                              setConfig((v) => ({
                                ...v,
                                fields: {
                                  ...v.fields,
                                  [f.key]: { ...value, path: e.target.value },
                                },
                              }));
                            }}
                          />
                        </label>
                        <label>
                          Sposób odczytu {f.label.toLowerCase()}
                          <select
                            value={value.value_type}
                            onChange={(e) => {
                              invalidate();
                              setConfig((v) => ({
                                ...v,
                                fields: {
                                  ...v.fields,
                                  [f.key]: { ...value, value_type: e.target.value as ValueType },
                                },
                              }));
                            }}
                          >
                            {(f.key === 'cost_minor'
                              ? ['integer', 'decimal_money']
                              : [defaultType(f.key)]
                            ).map((type) => (
                              <option key={type} value={type}>
                                {type === 'decimal_money'
                                  ? 'Kwota z kropką (np. 12.34)'
                                  : type === 'integer'
                                    ? f.key === 'cost_minor'
                                      ? 'Najmniejsza jednostka waluty (1234 = 12,34)'
                                      : 'Liczba całkowita'
                                    : 'Tekst'}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    );
                  })}
                </div>
                <p className="sfs-hint">
                  XML używa dosłownych nazw i prefiksów, np. p:name lub group/@code, bez wyrażeń
                  XPath. Brak lub błędna cena / ilość blokuje zapis całego pliku; zero jest
                  prawdziwą wartością. Ilość z obsługą poza wybranym limitem nie jest dostępnością
                  do zakupu.
                </p>
              </fieldset>
              <button
                type="button"
                className="button primary"
                disabled={freshDisabled}
                onClick={saveSource}
              >
                {source ? 'Zapisz nową wersję konfiguracji' : 'Utwórz źródło plikowe'}
              </button>
            </>
          )}
          {tab === 'file' &&
            (source ? (
              <>
                <p>
                  {source.name} · {source.currency} netto · konfiguracja v{source.version}
                  {source.paused && ' · wstrzymane'}
                </p>
                <ConfigView config={source.config} />
                <fieldset disabled={freshDisabled || source.paused}>
                  <legend>Plik do zapisanej konfiguracji</legend>
                  <label>
                    Plik UTF-8 do 2 MiB
                    <input
                      type="file"
                      accept=".csv,.xml,text/csv,application/xml,text/xml"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        void upload(file);
                      }}
                    />
                  </label>
                  <label>
                    Nazwa pliku
                    <input
                      value={filename}
                      maxLength={200}
                      onChange={(e) => {
                        invalidate();
                        setFilename(e.target.value);
                      }}
                    />
                  </label>
                  <label>
                    Pełna treść pliku
                    <textarea
                      rows={8}
                      value={content}
                      onChange={(e) => {
                        if (bytes(e.target.value) > (options.limits.file_bytes ?? 2097152)) {
                          setError('Treść przekracza 2 MiB. Nie obcięto pliku.');
                          return;
                        }
                        invalidate();
                        setContent(e.target.value);
                      }}
                    />
                  </label>
                  <p>
                    {bytes(content)} B · do {options.limits.rows} wierszy. BOM i końce linii są
                    zachowane.
                  </p>
                  <label>
                    Zakres pliku
                    <select
                      value={fileScope}
                      onChange={(e) => {
                        invalidate();
                        setFileScope(e.target.value as 'delta' | 'full');
                      }}
                    >
                      <option value="delta">Tylko pozycje z pliku · pozostałe zachowaj</option>
                      <option value="full">
                        Pełny katalog · pokaż i wycofaj brakujące po zgodzie
                      </option>
                    </select>
                  </label>
                </fieldset>
                <button
                  type="button"
                  className="button primary"
                  disabled={freshDisabled || source.paused}
                  onClick={prepare}
                >
                  Utwórz pełny podgląd pliku
                </button>
                {preview && (
                  <div className="sfs-review">
                    <h3>Trwały podgląd</h3>
                    <EvidenceView key={preview.id} evidence={preview} financial={financial} />
                    {preview.executed_run_id ? (
                      <p>
                        Ten podgląd zastosowano wcześniej. Wynik: {preview.executed_run_id}.
                        Odczytaj historię.
                      </p>
                    ) : (
                      <>
                        <label className="sfs-check">
                          <input
                            type="checkbox"
                            checked={confirmRows}
                            disabled={
                              freshDisabled || !preview.can_apply || !!preview.summary.invalid
                            }
                            onChange={(e) => setConfirmRows(e.target.checked)}
                          />
                          Potwierdzam wszystkie {preview.summary.total} wierszy tego pliku.
                        </label>
                        {preview.scope === 'full' && !!preview.missing.length && (
                          <label className="sfs-check">
                            <input
                              type="checkbox"
                              checked={confirmMissing}
                              disabled={
                                freshDisabled || !preview.can_apply || !!preview.summary.invalid
                              }
                              onChange={(e) => setConfirmMissing(e.target.checked)}
                            />
                            Potwierdzam wycofanie dokładnie {preview.missing.length} brakujących
                            pozycji dostawcy.
                          </label>
                        )}
                        <button
                          type="button"
                          className="button primary"
                          disabled={
                            freshDisabled ||
                            !preview.can_apply ||
                            !!preview.summary.invalid ||
                            !confirmRows ||
                            (preview.scope === 'full' &&
                              !!preview.missing.length &&
                              !confirmMissing)
                          }
                          onClick={() => {
                            if (
                              !confirmRows ||
                              (preview.missing.length && !confirmMissing) ||
                              !preview.can_apply
                            )
                              return;
                            start(
                              'apply',
                              `/supplier-file-previews/${preview.id}/apply`,
                              'POST',
                              {
                                client_key: crypto.randomUUID(),
                                confirm_rows: preview.summary.total,
                                confirm_missing:
                                  preview.scope === 'full' &&
                                  !!preview.missing.length &&
                                  confirmMissing,
                              },
                              'Zastosowanie całego pliku dostawcy',
                            );
                          }}
                        >
                          Zastosuj cały plik do katalogu dostawcy
                        </button>
                      </>
                    )}
                  </div>
                )}
                {run && (
                  <div className="sfs-review">
                    <h3>Trwały wynik uzgodnienia</h3>
                    <EvidenceView key={run.id} evidence={run} financial={financial} />
                  </div>
                )}
              </>
            ) : (
              <p>Najpierw wybierz lub utwórz nazwane źródło i zapisz jego konfigurację.</p>
            ))}
          {tab === 'history' && (
            <>
              <button
                type="button"
                className="button"
                disabled={!source || busy}
                onClick={() => loadHistory()}
              >
                Odczytaj historię uzgodnień
              </button>
              {history.map((item) => (
                <details key={item.id}>
                  <summary>
                    {date(item.created_at)} · {item.summary.total} wierszy · {item.summary.changed}{' '}
                    zmian · {item.summary.missing} brakujących
                  </summary>
                  <EvidenceView evidence={item} financial={financial} />
                </details>
              ))}
              {historyCursor && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => loadHistory(true)}
                >
                  Starsze uzgodnienia
                </button>
              )}
              <p>
                Historia zawiera zamrożoną konfigurację i skrót pliku. Nie udostępnia jego pełnej
                pierwotnej treści i nie wykonuje ponownego zapisu.
              </p>
            </>
          )}
        </>
      )}
      {readable && (sourceId || getSupplierRemoteFeedsSource(contextKey)) && (
        <SupplierRemoteFeeds
          contextKey={contextKey}
          readOnly={readOnly}
          admin={admin}
          sourceId={sourceId || getSupplierRemoteFeedsSource(contextKey)}
          sourceVersion={source?.version}
          currency={source?.currency}
          externalWriteBlocked={locked}
          getExternalWriteBlocked={() => busyRef.current || !!retained.attempt || retained.inFlight}
          onPreview={openRemotePreview}
          onHistory={() => {
            setTab('history');
            loadHistory();
          }}
          onSourceChanged={reload}
        />
      )}
    </section>
  );
}
