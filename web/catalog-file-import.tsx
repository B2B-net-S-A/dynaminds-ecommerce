import { useEffect, useRef, useState, type ReactNode } from 'react';
import {previewCustody,executionCustody,type CoreCustody} from './pim/legacy-files/handoff';
import { api, ApiError, date } from './api';
import { catalogXmlPathValid as xmlPathValid } from '../shared/catalog-xml-path';
import './catalog-file-import.css';

type Format = 'xml' | 'csv';
type Mode = 'create' | 'update' | 'upsert';
type Identity = 'id' | 'sku' | 'ean' | 'name';
type XmlValueType = 'text' | 'integer' | 'decimal_money' | 'boolean';
type XmlField = { path: string; value_type: XmlValueType };
type XmlMapping = { record_path: string; fields: Record<string, XmlField> };
type Flags = {
  available: boolean;
  can_read: boolean;
  can_write: boolean;
  current_role: string;
  read_only: boolean;
};
type Config = {
  format: Format;
  warehouse_id: string;
  catalog_id?: string;
  currency: string;
  mode: Mode;
  identity: Identity;
  empty_policy: 'skip' | 'clear';
  delimiter: ',' | ';' | '\t' | '|';
  mapping: Record<string, string>;
  xml_mapping?: XmlMapping;
  ignore_readonly_fields: boolean;
  file_name?: string;
};
type Options = Flags & {
  catalog_currency: string;
  product_catalogs_available?: boolean;
  catalogs?: { data: { id: string; name: string; is_default: boolean; warehouse_ids: string[] }[]; capped: boolean };
  warehouses: { data: { id: string; name: string; code: string }[]; capped: boolean };
  fields: { key: string; label: string; readonly: boolean }[];
  formats: Format[];
  modes: Mode[];
  identities: Identity[];
  limits: {
    rows: number;
    file_bytes: number;
    request_bytes: number;
    page_rows: number;
    history_page: number;
    preview_bytes: number;
    xml_depth: number;
    xml_nodes: number;
  };
};
type Snapshot = Record<string, unknown>;
type ImportRow = {
  index: number;
  operation: 'create' | 'update' | 'unchanged' | 'invalid';
  identity_value: string | null;
  product_id: string | null;
  sku: string | null;
  current_sku: string | null;
  matched_historical_sku: boolean;
  before: Snapshot | null;
  after: Snapshot | null;
  changes: Snapshot;
  changed_fields: string[];
  errors: string[];
};
type Head = {
  id: string;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  invalid: number;
  ready: boolean;
  scope_hash: string;
  created_at: string;
  config: Config;
  active_product_rules: number;
};
type ExecutionHead = Head & { preview_id: string; state: 'done'; actor_id: string };
type PreviewResponse = Flags & {
  preview: Head;
  rows: ImportRow[];
  meta: { cursor: string | null };
  reused?: boolean;
};
type ExecutionResponse = Flags & {
  execution: ExecutionHead;
  rows: ImportRow[];
  meta: { cursor: string | null };
  reused?: boolean;
};
type HistoryHead = (Head | ExecutionHead) & { kind: 'preview' | 'execution' };
type HistoryResponse = Flags & { data: HistoryHead[]; meta: { cursor: string | null } };
type Attempt = {
  kind: 'preview' | 'execute';
  path: string;
  serialized: string;
  scope: string;
  label: string;
};
type ReadDetail = { kind: 'preview' | 'execution'; head: Head; rows: ImportRow[] };

export type CatalogFileImportProps = {
  contextKey: string;
  readOnly: boolean;
  onClose: () => void;
  onApplied: () => void;
  onError?: (message: string) => void;
  renderTypedContinuation?: (custody:CoreCustody)=>ReactNode;
  isExternalWriteBlocked?: ()=>boolean;
};
const prefix = '/catalog/file-imports';
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const modeLabel: Record<Mode, string> = {
  create: 'Tylko nowe produkty',
  update: 'Tylko aktualizacja istniejących',
  upsert: 'Nowe i aktualizacja istniejących',
};
const identityLabel: Record<Identity, string> = {
  id: 'ID produktu',
  sku: 'SKU (także wcześniejszy kod)',
  ean: 'EAN',
  name: 'Nazwa',
};
const operationLabel: Record<ImportRow['operation'], string> = {
  create: 'Nowy produkt',
  update: 'Aktualizacja',
  unchanged: 'Bez zmian',
  invalid: 'Błąd',
};
const snapshotLabels: Record<string, string> = {
  id: 'ID produktu',
  version: 'Wersja',
  sku: 'SKU',
  ean: 'EAN',
  name: 'Nazwa',
  description: 'Opis',
  price: 'Cena bazowa brutto',
  vat: 'VAT (%)',
  category: 'Kategoria',
  active: 'Aktywny',
  kind: 'Typ',
  parent_id: 'Grupa nadrzędna',
  attributes: 'Parametry',
  images: 'Adresy zdjęć',
  components: 'Składniki zestawu',
  weight_grams: 'Masa (g)',
  length_mm: 'Długość (mm)',
  width_mm: 'Szerokość (mm)',
  height_mm: 'Wysokość (mm)',
  manufacturer: 'Producent',
};
const importFieldLabels: Record<string, string> = {
  ...snapshotLabels,
  price_minor: 'Cena bazowa brutto (najmniejsza jednostka waluty)',
  vat_rate: 'VAT (%)',
  weight_g: 'Masa (g)',
  attributes_json: 'Parametry (JSON)',
  images_json: 'Adresy zdjęć (JSON)',
  bundle_components_json: 'Składniki zestawu (JSON)',
  parent_sku: 'SKU grupy nadrzędnej',
  variants_json: 'Warianty — tylko odczyt',
  translations_json: 'Wersje językowe — tylko odczyt',
  inventory_json: 'Stany magazynowe — tylko odczyt',
  prices_json: 'Ceny w cennikach — tylko odczyt',
};
const xmlReadonlyFields = new Set([
  'variants_json',
  'translations_json',
  'inventory_json',
  'prices_json',
]);
const xmlIntegerFields = new Set(['vat_rate', 'weight_g', 'length_mm', 'width_mm', 'height_mm']);
function xmlDefaultType(key: string): XmlValueType {
  return key === 'active'
    ? 'boolean'
    : key === 'price_minor' || xmlIntegerFields.has(key)
      ? 'integer'
      : 'text';
}
const xmlValueLabels: Record<XmlValueType, string> = {
  text: 'Tekst (dla pól JSON: zapis JSON)',
  integer: 'Liczba całkowita',
  decimal_money: 'Kwota dziesiętna (np. 12.34)',
  boolean: 'Wartość true / false (tak / nie)',
};

function valueText(value: unknown, field: string, currency: string): string {
  if (value === undefined) return 'Pominięte';
  if (value === null) return 'Brak (null)';
  if (value === '') return 'Pusty tekst';
  if (typeof value === 'boolean') return value ? 'Tak' : 'Nie';
  if (
    field === 'price' &&
    (typeof value === 'number' || typeof value === 'string') &&
    /^\d+$/.test(String(value))
  ) {
    const n = BigInt(String(value));
    return `${n / 100n},${String(n % 100n).padStart(2, '0')} ${currency} (${value} w najmniejszej jednostce)`;
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
function Counts({ head }: { head: Head }) {
  return (
    <div className="cfi-counts">
      <span>
        Wiersze <strong>{head.total}</strong>
      </span>
      <span>
        Nowe <strong>{head.created}</strong>
      </span>
      <span>
        Aktualizacje <strong>{head.updated}</strong>
      </span>
      <span>
        Bez zmian <strong>{head.unchanged}</strong>
      </span>
      <span>
        Błędy <strong>{head.invalid}</strong>
      </span>
    </div>
  );
}
function Rows({ rows, currency, title }: { rows: ImportRow[]; currency: string; title: string }) {
  const [filter, setFilter] = useState<'all' | 'errors' | 'changes'>('all');
  const visible = rows.filter(
    (r) =>
      filter === 'all' ||
      (filter === 'errors'
        ? r.errors.length > 0 || r.operation === 'invalid'
        : r.operation === 'create' || r.operation === 'update'),
  );
  return (
    <div className="cfi-rows">
      <div className="cfi-row-heading">
        <h4>{title}</h4>
        <label>
          Pokazuj wiersze
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">Wszystkie · {rows.length}</option>
            <option value="errors">Błędy i wyjątki</option>
            <option value="changes">Nowe i zmienione</option>
          </select>
        </label>
      </div>
      {!visible.length && <p>Brak wierszy w tym widoku.</p>}
      {visible.map((r) => {
        const fields = r.changed_fields.length
          ? r.changed_fields
          : r.operation === 'create' && r.after
            ? Object.keys(r.after)
            : [];
        return (
          <details
            key={r.index}
            className={
              'cfi-row ' + (r.errors.length || r.operation === 'invalid' ? 'cfi-invalid' : '')
            }
          >
            <summary>
              Wiersz {r.index + 1} · {r.sku ?? r.identity_value ?? 'bez identyfikatora'} ·{' '}
              {operationLabel[r.operation]}
              {r.errors.length ? ` · błędy: ${r.errors.length}` : ''}
              {r.before?.version !== undefined || r.after?.version !== undefined
                ? ` · wersja ${r.before?.version ?? 'brak'} → ${r.after?.version ?? 'brak'}`
                : ''}
            </summary>
            {r.errors.length > 0 && (
              <ul className="cfi-error" role="alert">
                {r.errors.map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            )}
            {r.matched_historical_sku && (
              <p className="cfi-hint">
                Kod z pliku {r.identity_value} wskazuje istniejący produkt o bieżącym SKU{' '}
                {r.current_sku}. Import zachowuje jego tożsamość i bieżący kod.
              </p>
            )}
            {r.operation === 'unchanged' && (
              <p>Wartości pozostają bez zmian; import nie podnosi wersji produktu.</p>
            )}
            {fields.length > 0 && (
              <div className="cfi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Pole</th>
                      <th>Przed importem</th>
                      <th>Po imporcie</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((field) => (
                      <tr key={field}>
                        <th>{snapshotLabels[field] ?? field}</th>
                        <td>
                          <pre>{valueText(r.before?.[field], field, currency)}</pre>
                        </td>
                        <td>
                          <pre>{valueText(r.after?.[field], field, currency)}</pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <details>
              <summary>Pełne wartości i identyfikatory</summary>
              <div className="cfi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Pole</th>
                      <th>Przed</th>
                      <th>Po</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ...new Set([...Object.keys(r.before ?? {}), ...Object.keys(r.after ?? {})]),
                    ].map((field) => (
                      <tr key={field}>
                        <th>{snapshotLabels[field] ?? field}</th>
                        <td>
                          <pre>{valueText(r.before?.[field], field, currency)}</pre>
                        </td>
                        <td>
                          <pre>{valueText(r.after?.[field], field, currency)}</pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>ID produktu: {r.product_id ?? 'nowy'}</p>
            </details>
          </details>
        );
      })}
    </div>
  );
}

export function CatalogFileImportPanel({
  contextKey,
  readOnly,
  onClose,
  onApplied,
  onError,
  renderTypedContinuation,
  isExternalWriteBlocked,
}: CatalogFileImportProps) {
  const [options, setOptions] = useState<Options | null>(null);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false),
    [writeBlocked, setWriteBlocked] = useState(false);
  const [tab, setTab] = useState<'import' | 'history'>('import');
  const [format, setFormat] = useState<Format>('xml');
  const [xmlKind, setXmlKind] = useState<'native' | 'mapped'>('native');
  const [xmlRecordPath, setXmlRecordPath] = useState('/products/product');
  const [xmlFields, setXmlFields] = useState<Record<string, XmlField>>({
    sku: { path: '@sku', value_type: 'text' },
    name: { path: 'name', value_type: 'text' },
  });
  const [content, setContent] = useState(''),
    [fileName, setFileName] = useState('');
  const [warehouseId, setWarehouseId] = useState(''),
    [currency, setCurrency] = useState('');
  const [catalogId, setCatalogId] = useState('');
  const [mode, setMode] = useState<Mode>('update'),
    [identity, setIdentity] = useState<Identity>('sku');
  const [emptyPolicy, setEmptyPolicy] = useState<'skip' | 'clear'>('skip');
  const [delimiter, setDelimiter] = useState<Config['delimiter']>(',');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [ignoreDerived, setIgnoreDerived] = useState(false);
  const [preview, setPreview] = useState<Head | null>(null),
    [previewRows, setPreviewRows] = useState<ImportRow[]>([]);
  const [previewComplete, setPreviewComplete] = useState(false),
    [previewScope, setPreviewScope] = useState('');
  const [consent, setConsent] = useState(false);
  const [execution, setExecution] = useState<ExecutionHead | null>(null),
    [executionRows, setExecutionRows] = useState<ImportRow[]>([]);
  const [executionComplete, setExecutionComplete] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [history, setHistory] = useState<HistoryHead[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false),
    [historyDetail, setHistoryDetail] = useState<ReadDetail | null>(null);
  const [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const writeFenceRef=useRef(isExternalWriteBlocked);writeFenceRef.current=isExternalWriteBlocked;
  const typedBound = useRef<ReturnType<typeof previewCustody>|null>(null);
  const [typedCustody,setTypedCustody]=useState<CoreCustody|null>(null),[typedNotice,setTypedNotice]=useState('');
  function finishTyped(head:ExecutionHead,rows:ImportRow[]){if(!renderTypedContinuation)return;try{if(!typedBound.current)throw Error('Brak zachowanej treści pierwotnego pliku; wybierz ponownie pełny import CSV/XML. Nie zgadujemy treści ani ID produktów.');setTypedCustody(executionCustody(typedBound.current,head,rows));}catch(e){setTypedCustody(null);setTypedNotice((e as Error).message);}}
  const epoch = useRef(0),
    requestId = useRef(0),
    busyRef = useRef(false);
  const pendingRef = useRef<Attempt | null>(null),
    authorizedContext = useRef<string | null>(null);
  const contextRef = useRef('');
  contextRef.current = `${contextKey}:${readOnly}`;
  const revision = useRef(0);
  const scope = `${contextRef.current}:${revision.current}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const readable =
    !!flags?.available &&
    !!flags.can_read &&
    !blocked &&
    authorizedContext.current === contextRef.current;
  const writable =
    readable && !!flags?.can_write && !flags?.read_only && !readOnly && !writeBlocked && !writeFenceRef.current?.();
  const contentBytes = byteLength(content);
  const inputDisabled = !writable || busy || !!pending;

  function clearSensitive() {
    typedBound.current=null;setTypedCustody(null);setTypedNotice('');
    setContent('');
    setFileName('');
    setMapping({});
    setXmlKind('native');
    setXmlRecordPath('/products/product');
    setXmlFields({
      sku: { path: '@sku', value_type: 'text' },
      name: { path: 'name', value_type: 'text' },
    });
    setWarehouseId('');
    setIgnoreDerived(false);
    setPreview(null);
    setPreviewRows([]);
    setPreviewComplete(false);
    setPreviewScope('');
    setConsent(false);
    setExecution(null);
    setExecutionRows([]);
    setExecutionComplete(false);
    setHistoryDetail(null);
    pendingRef.current = null;
    setPending(null);
    ++revision.current;
  }
  function purge() {
    authorizedContext.current = null;
    setBlocked(true);
    setFlags(null);
    setOptions(null);
    clearSensitive();
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
  }
  function acceptFlags(d: Flags) {
    if (!d.available || !d.can_read) {
      purge();
      return false;
    }
    if (flags?.can_write && (!d.can_write || d.read_only)) clearSensitive();
    authorizedContext.current = contextRef.current;
    setFlags({
      available: d.available,
      can_read: d.can_read,
      can_write: d.can_write,
      current_role: d.current_role,
      read_only: d.read_only,
    });
    return true;
  }
  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    const message = err instanceof Error ? err.message : 'Operacja importu nie powiodła się.';
    setError(message);
    onError?.(message);
    if (err instanceof ApiError && [401, 403].includes(err.status)) purge();
    if (err instanceof ApiError && err.status === 423) {
      clearSensitive();
      setWriteBlocked(true);
      setFlags((old) => (old ? { ...old, can_write: false, read_only: true } : old));
    }
  }
  function invalidate() {
    typedBound.current=null;setTypedCustody(null);setTypedNotice('');
    ++revision.current;
    scopeRef.current = `${contextRef.current}:${revision.current}`;
    setPreview(null);
    setPreviewRows([]);
    setPreviewComplete(false);
    setPreviewScope('');
    setConsent(false);
    setExecution(null);
    setExecutionRows([]);
    setExecutionComplete(false);
    setError('');
    setStatus('');
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    const context = contextRef.current;
    try {
      if(method==='POST'&&writeFenceRef.current?.())throw Error('Inna próba zapisu blokuje import; nie wysłano nowego żądania.');
      const result = await api<T>(prefix + path, method, body);
      if (e !== epoch.current || context !== contextRef.current)
        throw new DOMException('Kontekst został zmieniony.', 'AbortError');
      return result;
    } catch (err) {
      if (e !== epoch.current || context !== contextRef.current)
        throw new DOMException('Kontekst został zmieniony.', 'AbortError');
      throw err;
    }
  }
  function begin() {
    const id = ++requestId.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    return { e: epoch.current, id };
  }
  function end(e: number, id: number) {
    if (e === epoch.current && id === requestId.current) {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function loadOptions(expectedEpoch = epoch.current, contextReset = false) {
    if (busyRef.current || (blocked && !contextReset)) return;
    const { id } = begin(),
      e = expectedEpoch;
    try {
      const d = await request<Options>('/options', e);
      if (!d.available) {
        setOptions(d);
        setFlags(d);
        authorizedContext.current = contextRef.current;
        return;
      }
      if (!acceptFlags(d)) return;
      setOptions(d);
      setCurrency(d.catalog_currency);
      setCatalogId(old => d.catalogs?.data.some(c => c.id === old) ? old : (d.catalogs?.data.find(c => c.is_default)?.id ?? ''));
    } catch (err) {
      if (e === epoch.current) fail(err);
    } finally {
      if (e === epoch.current) setLoading(false);
      end(e, id);
    }
  }
  useEffect(() => {
    const e = ++epoch.current;
    ++requestId.current;
    busyRef.current = false;
    authorizedContext.current = null;
    pendingRef.current = null;
    setPending(null);
    setOptions(null);
    setFlags(null);
    setBlocked(false);
    setWriteBlocked(false);
    clearSensitive();
    setCurrency('');
    setCatalogId('');
    setFormat('xml');
    setMode('update');
    setIdentity('sku');
    setEmptyPolicy('skip');
    setDelimiter(',');
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
    setTab('import');
    setError('');
    setStatus('');
    setBusy(false);
    setLoading(true);
    // A context reset revokes old draft authority synchronously through the ref guard.
    void loadOptions(e, true);
    return () => {
      ++epoch.current;
      ++requestId.current;
      busyRef.current = false;
      pendingRef.current = null;
      authorizedContext.current = null;
    };
  }, [contextKey, readOnly]);

  async function allRows(
    kind: 'preview' | 'execution',
    first: PreviewResponse | ExecutionResponse,
    e: number,
  ) {
    const head = 'preview' in first ? first.preview : first.execution;
    const maxRows = options?.limits.rows ?? 500,
      pageRows = options?.limits.page_rows ?? 100;
    if (!Number.isInteger(head.total) || head.total < 0 || head.total > maxRows)
      throw Error('Podgląd przekroczył limit wierszy. Nie obcięto zakresu.');
    const rows: ImportRow[] = [],
      cursors = new Set<string>(),
      indexes = new Set<number>();
    let page: PreviewResponse | ExecutionResponse = first;
    while (true) {
      if (e !== epoch.current) throw new DOMException('Kontekst został zmieniony.', 'AbortError');
      const currentHead = 'preview' in page ? page.preview : page.execution;
      if (
        currentHead.id !== head.id ||
        currentHead.scope_hash !== head.scope_hash ||
        currentHead.total !== head.total
      )
        throw Error('Zakres dowodu zmienił się podczas odczytu. Odczytaj go ponownie.');
      if (!acceptFlags(page)) throw Error('Brak aktualnego dostępu do dowodu importu.');
      if (page.rows.length > pageRows) throw Error('Odpowiedź przekroczyła limit strony wierszy.');
      for (const row of page.rows) {
        if (!Number.isInteger(row.index) || indexes.has(row.index))
          throw Error('Odczyt zawiera powtórzony lub nieprawidłowy wiersz.');
        indexes.add(row.index);
        rows.push(row);
      }
      if (rows.length > head.total) throw Error('Odczyt przekroczył zadeklarowany zakres importu.');
      const cursor = page.meta.cursor;
      if (cursor === null) break;
      if (!page.rows.length || cursors.has(cursor) || cursors.size >= Math.ceil(maxRows / pageRows))
        throw Error('Nie udało się odczytać pełnego zakresu wierszy.');
      cursors.add(cursor);
      page =
        kind === 'preview'
          ? await request<PreviewResponse>(
              `/previews/${head.id}?cursor=${encodeURIComponent(cursor)}`,
              e,
            )
          : await request<ExecutionResponse>(
              `/executions/${head.id}?cursor=${encodeURIComponent(cursor)}`,
              e,
            );
    }
    if (rows.length !== head.total)
      throw Error('Nie odczytano wszystkich wierszy. Zatwierdzenie pozostaje zablokowane.');
    return rows;
  }
  async function submit(a: Attempt) {
    if (writeFenceRef.current?.() || !writable || busyRef.current || (pendingRef.current && pendingRef.current !== a)) return;
    const { e, id } = begin();
    pendingRef.current = a;
    setPending(a);
    setStatus('');
    setConsent(false);
    let acknowledged = false;
    try {
      const result = await request<PreviewResponse | ExecutionResponse>(
        a.path,
        e,
        'POST',
        JSON.parse(a.serialized),
      );
      if (!acceptFlags(result)) return;
      if (
        (a.kind === 'preview' && !('preview' in result)) ||
        (a.kind === 'execute' && (!('execution' in result) || result.execution.state !== 'done'))
      )
        throw Error('Odpowiedź nie potwierdza oczekiwanego rodzaju dowodu importu.');
      const head = 'preview' in result ? result.preview : result.execution;
      if (!head || !head.id || !/^[a-f0-9]{64}$/.test(head.scope_hash))
        throw Error('Odpowiedź nie potwierdza identyfikatora i zakresu dowodu.');
      acknowledged = true;
      pendingRef.current = null;
      setPending(null);
      if (!result.can_write || result.read_only || a.scope !== scopeRef.current) return;
      if (a.kind === 'preview' && 'preview' in result) {
        if(renderTypedContinuation){try{typedBound.current=previewCustody(contextKey,a.serialized,result.preview);setTypedNotice('');}catch(e){typedBound.current=null;setTypedNotice((e as Error).message);}}
        setPreview(result.preview);
        setPreviewScope(a.scope);
        setPreviewRows([]);
        setPreviewComplete(false);
        const rows = await allRows('preview', result, e);
        if (a.scope !== scopeRef.current) return;
        setPreviewRows(rows);
        setPreviewComplete(true);
        setStatus(
          result.reused
            ? 'Odczytano wcześniej utworzony podgląd tej samej próby.'
            : 'Odczytano pełny podgląd. Produkty nie zostały zmienione.',
        );
      } else if (a.kind === 'execute' && 'execution' in result) {
        if (result.execution.state !== 'done')
          throw Error('Odpowiedź nie potwierdza zakończonego zapisu.');
        setExecution(result.execution);
        setExecutionRows([]);
        setExecutionComplete(false);
        onApplied();
        const rows = await allRows('execution', result, e);
        if (a.scope !== scopeRef.current) return;
        setExecutionRows(rows);
        setExecutionComplete(true);
        finishTyped(result.execution,rows);
        setStatus(
          result.reused
            ? 'Odczytano wynik wcześniej wykonanej próby. Nie wykonano ponownego importu.'
            : 'Import zapisany lokalnie. Odczytano wynik wszystkich wierszy.',
        );
      } else throw Error('Serwer zwrócił inny rodzaj dowodu importu.');
    } catch (err) {
      if (e !== epoch.current || (err instanceof DOMException && err.name === 'AbortError')) return;
      if (acknowledged) fail(err);
      else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        pendingRef.current = null;
        setPending(null);
        setConsent(false);
        if (a.kind === 'execute') {
          setPreview(null);
          setPreviewRows([]);
          setPreviewComplete(false);
          setPreviewScope('');
        }
        fail(err);
        if (![401, 403, 423].includes(err.status))
          setStatus(
            'Nie zatwierdzono importu. Szkic zachowano; popraw błędy i utwórz nowy podgląd.',
          );
      } else {
        setError(
          'Wynik próby jest niepewny. Zatrzymano edycję i kolejne zapisy. Ponów ręcznie dokładnie tę samą treść z tym samym kluczem lub odczytaj historię.',
        );
      }
    } finally {
      end(e, id);
    }
  }
  function prepare() {
    if (!writable || busyRef.current || pendingRef.current || !options) return;
    setPreview(null);
    setPreviewRows([]);
    setPreviewComplete(false);
    setConsent(false);
    setExecution(null);
    setExecutionRows([]);
    setExecutionComplete(false);
    try {
      if (!content.trim()) throw Error('Wybierz plik lub wprowadź jego pełną treść.');
      if (contentBytes > options.limits.file_bytes)
        throw Error('Plik przekracza 2 MiB. Nie obcięto treści; podziel plik przed importem.');
      if (!warehouseId || !options.warehouses.data.some((w) => w.id === warehouseId))
        throw Error('Wybierz własny magazyn.');
      if (options.product_catalogs_available) {
        const catalog = options.catalogs?.data.find(c => c.id === catalogId);
        if (!catalog || options.catalogs?.capped) throw Error('Wybierz dostępny katalog produktów.');
        if (!catalog.warehouse_ids.includes(warehouseId)) throw Error('Magazyn nie jest przypisany do wybranego katalogu.');
      }
      if (!currency || currency !== options.catalog_currency)
        throw Error('Waluta pliku musi być zgodna z walutą katalogu. Nie przeliczamy walut.');
      if (fileName && (fileName.trim().length > 120 || !fileName.trim()))
        throw Error('Nazwa pliku może zawierać od 1 do 120 znaków.');
      const aliases = Object.fromEntries(
        Object.entries(format === 'xml' && xmlKind === 'mapped' ? {} : mapping)
          .filter(([, v]) => v.trim())
          .map(([k, v]) => [k, v.trim()]),
      );
      if (
        Object.values(aliases).some((v) => v.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(v))
      )
        throw Error('Nazwa źródłowego pola może zawierać do 80 znaków, bez znaków sterujących.');
      if (
        new Set(Object.values(aliases).map((v) => v.toLowerCase())).size !==
        Object.keys(aliases).length
      )
        throw Error('Jedno źródłowe pole nie może być przypisane do kilku pól katalogu.');
      let xmlMapping: XmlMapping | undefined;
      if (format === 'xml' && xmlKind === 'mapped') {
        const recordPath = xmlRecordPath.trim();
        if (!xmlPathValid(recordPath, true, options.limits.xml_depth))
          throw Error(
            'Podaj pełną ścieżkę produktów, np. /feed/items/item. Nie używaj wyrażeń XPath.',
          );
        const fields: Record<string, XmlField> = {};
        for (const field of options.fields) {
          if (field.readonly || xmlReadonlyFields.has(field.key)) continue;
          const entry = xmlFields[field.key];
          if (!entry?.path.trim()) continue;
          const path = entry.path.trim();
          if (!xmlPathValid(path, false, options.limits.xml_depth))
            throw Error(
              `Niepoprawna ścieżka pola ${importFieldLabels[field.key] ?? field.label}. Użyj np. name, group/@code lub @sku.`,
            );
          fields[field.key] = { path, value_type: entry.value_type };
        }
        if (!fields[identity]) throw Error('Wskaż ścieżkę pola wybranego do powiązania produktu.');
        xmlMapping = { record_path: recordPath, fields };
      }
      const body = {
        client_key: crypto.randomUUID(),
        format,
        content,
        warehouse_id: warehouseId,
        ...(options.product_catalogs_available ? { catalog_id: catalogId } : {}),
        currency,
        mode,
        identity,
        empty_policy: emptyPolicy,
        delimiter,
        mapping: aliases,
        ...(xmlMapping ? { xml_mapping: xmlMapping } : {}),
        ignore_readonly_fields: ignoreDerived,
        ...(fileName ? { file_name: fileName.trim() } : {}),
      };
      const serialized = JSON.stringify(body);
      if (byteLength(serialized) > options.limits.request_bytes)
        throw Error('Żądanie przekracza 4 MiB po zakodowaniu tekstu. Treści nie obcięto.');
      void submit({
        kind: 'preview',
        path: '/preview',
        serialized,
        scope: scopeRef.current,
        label: 'Utworzenie podglądu importu',
      });
    } catch (err) {
      fail(err);
    }
  }
  function execute() {
    if (
      !writable ||
      busyRef.current ||
      pendingRef.current ||
      !preview ||
      !preview.ready ||
      preview.invalid ||
      !previewComplete ||
      previewRows.length !== preview.total ||
      previewScope !== scopeRef.current ||
      !consent ||
      execution
    )
      return;
    void submit({
      kind: 'execute',
      path: `/previews/${preview.id}/execute`,
      serialized: JSON.stringify({
        client_key: crypto.randomUUID(),
        scope_hash: preview.scope_hash,
        confirmed: true,
      }),
      scope: scopeRef.current,
      label: `Zatwierdzenie ${preview.total} wierszy podglądu`,
    });
  }
  async function reread(kind: 'preview' | 'execution') {
    const head = kind === 'preview' ? preview : execution;
    if (!readable || busyRef.current || !head) return;
    const { e, id } = begin();
    const selectedScope = scopeRef.current;
    setConsent(false);
    if (kind === 'preview') setPreviewComplete(false);
    else setExecutionComplete(false);
    try {
      const d =
        kind === 'preview'
          ? await request<PreviewResponse>(`/previews/${head.id}`, e)
          : await request<ExecutionResponse>(`/executions/${head.id}`, e);
      const rows = await allRows(kind, d, e);
      if (selectedScope !== scopeRef.current) return;
      if ('preview' in d) {
        setPreview(d.preview);
        setPreviewRows(rows);
        setPreviewComplete(true);
      } else {
        setExecution(d.execution);
        setExecutionRows(rows);
        setExecutionComplete(true);
        finishTyped(d.execution,rows);
      }
      setStatus('Odczytano pełny dowód importu. Odczyt nie wykonuje ponownego zapisu.');
    } catch (err) {
      if (e === epoch.current) fail(err);
    } finally {
      end(e, id);
    }
  }
  async function loadHistory(more = false) {
    if (!readable || busyRef.current || (more && !historyCursor)) return;
    const { e, id } = begin();
    try {
      const d = await request<HistoryResponse>(
        '/history' + (more ? '?cursor=' + encodeURIComponent(historyCursor!) : ''),
        e,
      );
      if (!acceptFlags(d)) return;
      if (d.data.length > (options?.limits.history_page ?? 25))
        throw Error('Historia przekroczyła limit strony.');
      setHistory((old) =>
        more
          ? [...old, ...d.data.filter((h) => !old.some((p) => p.kind === h.kind && p.id === h.id))]
          : d.data,
      );
      setHistoryCursor(d.meta.cursor);
      setHistoryLoaded(true);
    } catch (err) {
      if (e === epoch.current) fail(err);
    } finally {
      end(e, id);
    }
  }
  async function openHistory(head: HistoryHead) {
    if (!readable || busyRef.current) return;
    const { e, id } = begin();
    setHistoryDetail(null);
    try {
      const d =
        head.kind === 'preview'
          ? await request<PreviewResponse>(`/previews/${head.id}`, e)
          : await request<ExecutionResponse>(`/executions/${head.id}`, e);
      const rows = await allRows(head.kind, d, e);
      setHistoryDetail({ kind: head.kind, head: 'preview' in d ? d.preview : d.execution, rows });
    } catch (err) {
      if (e === epoch.current) fail(err);
    } finally {
      end(e, id);
    }
  }
  async function upload(file: File | undefined) {
    if (!file || inputDisabled || busyRef.current || !options) return;
    invalidate();
    const { e, id } = begin();
    const selectedScope = scopeRef.current;
    try {
      if (file.size > options.limits.file_bytes)
        throw Error('Plik przekracza 2 MiB. Nie obcięto treści.');
      if (!/\.(xml|csv)$/i.test(file.name))
        throw Error('Wybierz plik XML lub CSV w kodowaniu UTF-8.');
      if (file.name.trim().length > 120)
        throw Error('Nazwa pliku przekracza 120 znaków. Zmień nazwę przed importem.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (e !== epoch.current || selectedScope !== scopeRef.current) return;
      if (!text.trim()) throw Error('Plik jest pusty.');
      if (byteLength(text) > options.limits.file_bytes)
        throw Error('Treść UTF-8 przekracza limit 2 MiB.');
      setContent(text);
      setFileName(file.name);
      setFormat(/\.xml$/i.test(file.name) ? 'xml' : 'csv');
    } catch (err) {
      if (e === epoch.current)
        fail(
          err instanceof TypeError
            ? Error('Plik nie jest poprawnym UTF-8. Nie zmieniono bieżącej treści.')
            : err,
        );
    } finally {
      end(e, id);
    }
  }
  const completeReview =
    preview && previewScope === scope && previewComplete && previewRows.length === preview.total;
  function configSummary(head: Head) {
    const c = head.config,
      warehouse = options?.warehouses.data.find((w) => w.id === c.warehouse_id);
    return (
      <dl>
        <dt>Plik</dt>
        <dd>
          {c.file_name ?? 'Treść wprowadzona ręcznie'} · {c.format.toUpperCase()}
          {c.format === 'xml' &&
            (c.xml_mapping ? ' · XML dostawcy z mapowaniem' : ' · XML z eksportu katalogu')}
        </dd>
        {c.xml_mapping && (
          <>
            <dt>Ścieżka produktów</dt>
            <dd>
              <code>{c.xml_mapping.record_path}</code>
            </dd>
            <dt>Mapowanie XML</dt>
            <dd>
              <ul className="cfi-frozen-xml-fields">
                {Object.entries(c.xml_mapping.fields).map(([key, field]) => (
                  <li key={key}>
                    {key === 'price_minor' ? 'Cena bazowa brutto' : (importFieldLabels[key] ?? key)}
                    : <code>{field.path}</code> ·{' '}
                    {key === 'price_minor' && field.value_type === 'integer'
                      ? 'Cena w najmniejszej jednostce waluty'
                      : xmlValueLabels[field.value_type]}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Tryb</dt>
        <dd>{modeLabel[c.mode]}</dd>
        <dt>Powiązanie</dt>
        <dd>{identityLabel[c.identity]}</dd>
        <dt>Magazyn</dt>
        <dd>{warehouse ? `${warehouse.name} (${warehouse.code})` : c.warehouse_id}</dd>
        {c.catalog_id && <><dt>Katalog produktów</dt><dd>{options?.catalogs?.data.find(p => p.id === c.catalog_id)?.name ?? c.catalog_id}</dd></>}
        <dt>Waluta</dt>
        <dd>{c.currency} · bez przeliczeń</dd>
        <dt>Puste pola</dt>
        <dd>{c.empty_policy === 'skip' ? 'Pomijane' : 'Jawne czyszczenie tam, gdzie dozwolone'}</dd>
        <dt>Dane pochodne</dt>
        <dd>
          {c.ignore_readonly_fields ? 'Pominięte za jawną zgodą' : 'Nie mogą występować w pliku'}
        </dd>
      </dl>
    );
  }
  return (
    <section className="catalog-file-import panel" aria-label="Import katalogu z pliku">
      <header className="cfi-heading">
        <div>
          <h2>Import katalogu z pliku</h2>
          <p>Wczytaj plik, sprawdź każdą zmianę i zatwierdź dokładny zakres.</p>
        </div>
        <button
          type="button"
          className="button"
          disabled={busy || !!pending}
          onClick={() => {
            if (!busyRef.current && !pendingRef.current) onClose();
          }}
        >
          Zamknij import
        </button>
      </header>
      {error && (
        <p className="cfi-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="cfi-status" role="status">
          {status}
        </p>
      )}
      {loading && <p role="status">Odczytywanie opcji importu…</p>}
      {options && !options.available && (
        <p>Import plikowy nie jest dostępny w tej kopii aplikacji.</p>
      )}
      {blocked && (
        <p>
          Brak bieżącego dostępu. Treść pliku i dowody usunięto z panelu; zamknij go i sprawdź swoją
          sesję.
        </p>
      )}
      {pending && (
        <div className="cfi-pending" role="status">
          <strong>
            {busy ? 'Trwa próba: ' : 'Niepewny wynik: '}
            {pending.label}
          </strong>
          <p>
            Treść i klucz zachowano w pamięci otwartego panelu. Zatrzymano kolejne zapisy i edycję.
            Ponowienie jest ręczne i wysyła dokładnie tę samą próbę. Nie zamykaj panelu przed
            uzgodnieniem wyniku.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={busy || !writable}
            onClick={() => void submit(pending)}
          >
            Ponów dokładnie tę samą próbę
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || !readable}
            onClick={() => {
              setTab('history');
              void loadHistory();
            }}
          >
            Odczytaj historię
          </button>
        </div>
      )}
      {readable && options && (
        <>
          <nav className="cfi-tabs" aria-label="Widok importu">
            <button
              type="button"
              className={'button ' + (tab === 'import' ? 'primary' : '')}
              onClick={() => setTab('import')}
            >
              Plik i podgląd
            </button>
            <button
              type="button"
              className={'button ' + (tab === 'history' ? 'primary' : '')}
              onClick={() => setTab('history')}
            >
              Historia importów
            </button>
          </nav>
          {!writable && (
            <p className="cfi-hint">
              Możesz odczytywać historię. Import wymaga aktualnych uprawnień administratora i trybu
              umożliwiającego zapis.
            </p>
          )}
          {tab === 'import' && (
            <>
              <fieldset disabled={inputDisabled}>
                <legend>Plik i sposób importu</legend>
                <div className="cfi-settings">
                  {options.product_catalogs_available && <label>Katalog produktów<select value={catalogId} onChange={e => { invalidate(); setCatalogId(e.target.value); setWarehouseId(''); }}>
                    <option value="">— Wybierz katalog —</option>
                    {options.catalogs?.data.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>{options.catalogs?.capped && <span role="alert">Nie odczytano pełnej listy katalogów.</span>}</label>}
                  <label>
                    Format
                    <select
                      value={format}
                      onChange={(e) => {
                        invalidate();
                        setFormat(e.target.value as Format);
                      }}
                    >
                      {options.formats.map((v) => (
                        <option key={v} value={v}>
                          {v.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </label>
                  {format === 'xml' && (
                    <label>
                      Rodzaj XML
                      <select
                        value={xmlKind}
                        onChange={(e) => {
                          invalidate();
                          const kind = e.target.value as 'native' | 'mapped';
                          setXmlKind(kind);
                          if (kind === 'mapped') setMapping({});
                        }}
                      >
                        <option value="native">XML z eksportu katalogu</option>
                        <option value="mapped">XML dostawcy z mapowaniem</option>
                      </select>
                    </label>
                  )}
                  <label>
                    Tryb importu
                    <select
                      value={mode}
                      onChange={(e) => {
                        invalidate();
                        setMode(e.target.value as Mode);
                      }}
                    >
                      {options.modes.map((v) => (
                        <option key={v} value={v}>
                          {modeLabel[v]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Powiązanie produktu
                    <select
                      value={identity}
                      onChange={(e) => {
                        invalidate();
                        setIdentity(e.target.value as Identity);
                      }}
                    >
                      {options.identities.map((v) => (
                        <option key={v} value={v}>
                          {identityLabel[v]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Magazyn
                    <select
                      value={warehouseId}
                      onChange={(e) => {
                        invalidate();
                        setWarehouseId(e.target.value);
                      }}
                    >
                      <option value="">— Wybierz własny magazyn —</option>
                      {options.warehouses.data.filter(w => !options.product_catalogs_available || options.catalogs?.data.find(c => c.id === catalogId)?.warehouse_ids.includes(w.id)).map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name} ({w.code})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Waluta katalogu
                    <input value={currency} readOnly />
                  </label>
                  <label>
                    Puste wartości
                    <select
                      value={emptyPolicy}
                      onChange={(e) => {
                        invalidate();
                        setEmptyPolicy(e.target.value as 'skip' | 'clear');
                      }}
                    >
                      <option value="skip">Pomiń puste wartości</option>
                      <option value="clear">Wyczyść wartości, które można wyczyścić</option>
                    </select>
                  </label>
                  {format === 'csv' && (
                    <label>
                      Separator CSV
                      <select
                        value={delimiter}
                        onChange={(e) => {
                          invalidate();
                          setDelimiter(e.target.value as Config['delimiter']);
                        }}
                      >
                        <option value=",">Przecinek</option>
                        <option value=";">Średnik</option>
                        <option value={'\t'}>Tabulator</option>
                        <option value="|">Pionowa kreska |</option>
                      </select>
                    </label>
                  )}
                  <label>
                    Plik UTF-8
                    <input
                      type="file"
                      accept=".xml,.csv,text/xml,application/xml,text/csv"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        void upload(file);
                      }}
                    />
                  </label>
                  <label>
                    Nazwa pliku lub szkicu
                    <input
                      value={fileName}
                      onChange={(e) => {
                        invalidate();
                        setFileName(e.target.value);
                      }}
                      placeholder="Opcjonalna nazwa do historii"
                    />
                  </label>
                </div>
                {options.warehouses.capped && (
                  <p className="cfi-hint">
                    Lista magazynów jest ograniczona. Wybór nie obejmuje automatycznie pozostałych
                    źródeł.
                  </p>
                )}
                <label>
                  Pełna treść pliku
                  <textarea
                    className="cfi-content"
                    rows={8}
                    value={content}
                    onChange={(e) => {
                      invalidate();
                      if (byteLength(e.target.value) > options.limits.file_bytes) {
                        setError(
                          'Treść przekracza 2 MiB. Nie obcięto tekstu ani nie zastąpiono bieżącego szkicu.',
                        );
                        return;
                      }
                      setContent(e.target.value);
                    }}
                    placeholder={
                      format === 'xml'
                        ? xmlKind === 'mapped'
                          ? 'Wczytaj XML dostawcy lub wklej jego pełną treść.'
                          : 'Wczytaj natywny XML katalogu lub wklej jego pełną treść.'
                        : 'Wczytaj CSV z nagłówkami lub wklej jego pełną treść.'
                    }
                  />
                </label>
                <p className={contentBytes > options.limits.file_bytes ? 'cfi-error' : 'cfi-hint'}>
                  Treść UTF-8: {contentBytes.toLocaleString('pl-PL')} B /{' '}
                  {options.limits.file_bytes.toLocaleString('pl-PL')} B. Maksymalnie{' '}
                  {options.limits.rows} produktów; zakres nie jest obcinany.
                </p>
                {format === 'xml' && xmlKind === 'mapped' ? (
                  <div className="cfi-xml-mapping">
                    <h3>Mapowanie XML dostawcy</h3>
                    <label>
                      Pełna ścieżka produktów
                      <input
                        value={xmlRecordPath}
                        placeholder="/feed/items/item"
                        onChange={(e) => {
                          invalidate();
                          setXmlRecordPath(e.target.value);
                        }}
                      />
                    </label>
                    <p className="cfi-hint">
                      Dla każdego pola podaj ścieżkę od pojedynczego produktu, np. name lub
                      group/@code. Atrybut samego produktu zapiszesz jako @sku. Prefiksy nazw, np.
                      p:name, muszą odpowiadać zapisowi w pliku. Nie używaj warunków, funkcji ani
                      wyrażeń XPath. Pusta ścieżka pomija pole. Cena nie ma domyślnego mapowania.
                    </p>
                    <div className="cfi-xml-fields">
                      {options.fields
                        .filter((f) => !f.readonly && !xmlReadonlyFields.has(f.key))
                        .map((f) => {
                          const field = xmlFields[f.key] ?? {
                            path: '',
                            value_type: xmlDefaultType(f.key),
                          };
                          const types: XmlValueType[] =
                            f.key === 'price_minor'
                              ? ['integer', 'decimal_money']
                              : [xmlDefaultType(f.key)];
                          return (
                            <div className="cfi-xml-field" key={f.key}>
                              <label>
                                {f.key === 'price_minor'
                                  ? 'Cena bazowa brutto'
                                  : f.label === f.key
                                    ? (importFieldLabels[f.key] ?? f.key)
                                    : f.label}
                                <input
                                  value={field.path}
                                  placeholder={
                                    f.key === 'sku'
                                      ? '@sku'
                                      : f.key === 'name'
                                        ? 'name'
                                        : 'Pomiń pole'
                                  }
                                  onChange={(e) => {
                                    invalidate();
                                    setXmlFields((old) => ({
                                      ...old,
                                      [f.key]: { ...field, path: e.target.value },
                                    }));
                                  }}
                                />
                              </label>
                              <label>
                                Sposób odczytu wartości
                                <select
                                  value={field.value_type}
                                  onChange={(e) => {
                                    invalidate();
                                    setXmlFields((old) => ({
                                      ...old,
                                      [f.key]: {
                                        ...field,
                                        value_type: e.target.value as XmlValueType,
                                      },
                                    }));
                                  }}
                                >
                                  {types.map((type) => (
                                    <option key={type} value={type}>
                                      {f.key === 'price_minor' && type === 'integer'
                                        ? 'Najmniejsza jednostka waluty (np. 1234 = 12,34)'
                                        : xmlValueLabels[type]}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                          );
                        })}
                    </div>
                    <p className="cfi-hint">
                      Cena bazowa jest ceną brutto w walucie katalogu {currency || '—'}; nie
                      przeliczamy walut. Kwotę wybierz jako najmniejszą jednostkę albo zapis
                      dziesiętny z kropką i najwyżej dwiema cyframi ułamka, np. 12.34. Pole
                      aktywności wymaga true lub false. Ilości i dostępność dostawcy nie są
                      importowane jako własny zapas magazynu. Ten import nie tworzy źródła hurtowni
                      ani cyklicznego pobierania jej katalogu.
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="cfi-hint">
                      XML musi mieć natywną strukturę eksportu katalogu. Mapowanie wskazuje nazwy
                      kolumn CSV lub pól XML, bez ścieżek i wyrażeń. Plik nie pobiera danych ani
                      zdjęć z internetu.
                    </p>
                    <details>
                      <summary>
                        Mapowanie pól — dla innych nazw kolumn lub własnych nazw eksportu
                      </summary>
                      <p>
                        Puste mapowanie używa nazwy pola podanej jako podpowiedź. Przypisz tylko
                        pola obecne w pliku; niewystępujące pola produktu pozostają bez zmian.
                      </p>
                      <div className="cfi-mapping">
                        {options.fields.map((f) => (
                          <label key={f.key}>
                            {f.label === f.key ? (importFieldLabels[f.key] ?? f.key) : f.label}
                            {f.readonly ? ' · tylko odczyt' : ''}
                            <input
                              value={mapping[f.key] ?? ''}
                              placeholder={f.key}
                              onChange={(e) => {
                                invalidate();
                                setMapping((old) => ({ ...old, [f.key]: e.target.value }));
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </details>
                  </>
                )}
                <label className="cfi-checkbox">
                  <input
                    type="checkbox"
                    checked={ignoreDerived}
                    onChange={(e) => {
                      invalidate();
                      setIgnoreDerived(e.target.checked);
                    }}
                  />
                  <span>
                    Świadomie pomijam spisy wariantów, tłumaczenia, stany magazynowe i ceny cenników
                    obecne w pliku.
                  </span>
                </label>
                <p className="cfi-hint">
                  Te cztery pola pochodne nie są zapisywane przez ten import. Tłumaczenia, stany i
                  cenniki edytujesz w ich osobnych procesach. Nowe produkty powstają bez stanu
                  początkowego; rezerwacje i zapasy nie są nadpisywane. Kwoty ceny bazowej są w{' '}
                  {format === 'xml' && xmlKind === 'mapped'
                    ? 'jednostce wybranej dla pola ceny, bez przeliczeń walut.'
                    : 'najmniejszej jednostce waluty katalogu, bez przeliczeń.'}
                </p>
              </fieldset>
              <button
                type="button"
                className="button primary"
                disabled={inputDisabled}
                onClick={prepare}
              >
                Utwórz podgląd importu
              </button>
              {preview && (
                <div className="cfi-review">
                  <h3>Podgląd importu</h3>
                  <Counts head={preview} />
                  {configSummary(preview)}
                  <p>
                    Podgląd nie zmienia produktów. Odczytano {previewRows.length}/{preview.total}{' '}
                    wierszy.
                  </p>
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !readable}
                    onClick={() => void reread('preview')}
                  >
                    Odczytaj cały podgląd ponownie
                  </button>
                  {preview.active_product_rules > 0 && (
                    <p className="cfi-hint">
                      Aktywne reguły produktów: {preview.active_product_rules}. Zapis może uruchomić
                      lokalne reguły; podgląd nie wykonuje ich skutków.
                    </p>
                  )}
                  <Rows
                    key={preview.id}
                    rows={previewRows}
                    currency={preview.config.currency}
                    title="Wiersze podglądu i zmiany pól"
                  />
                  {!preview.ready || preview.invalid > 0 ? (
                    <p className="cfi-error">
                      Podgląd zawiera błędy. Cały zapis jest zablokowany; popraw plik i utwórz nowy
                      podgląd.
                    </p>
                  ) : !completeReview ? (
                    <p className="cfi-hint">
                      Przed zgodą wymagany jest pełny odczyt wszystkich wierszy.
                    </p>
                  ) : (
                    <>
                      <label className="cfi-checkbox">
                        <input
                          type="checkbox"
                          checked={consent}
                          disabled={!writable || busy || !!pending || !!execution}
                          onChange={(e) => setConsent(e.target.checked)}
                        />
                        <span>
                          Potwierdzam lokalny import dokładnie {preview.total} wierszy:{' '}
                          {preview.created} nowych, {preview.updated} aktualizacji i{' '}
                          {preview.unchanged} bez zmian, w walucie {preview.config.currency}. Zapasy
                          nie są zmieniane.
                        </span>
                      </label>
                      <button
                        type="button"
                        className="button primary"
                        disabled={!writable || busy || !!pending || !consent || !!execution}
                        onClick={execute}
                      >
                        Zatwierdź import lokalnie
                      </button>
                    </>
                  )}
                </div>
              )}
              {execution && (
                <div className="cfi-result">
                  <h3>Import zapisany</h3>
                  {typedNotice&&<p className="notice">Drugi etap PIM niedostępny: {typedNotice}. Core import pozostaje zapisany.</p>}
                  <Counts head={execution} />
                  {configSummary(execution)}
                  <p>
                    Odczytano {executionRows.length}/{execution.total} wierszy wyniku
                    {executionComplete
                      ? ' · pełny wynik.'
                      : '. Możesz odczytać go ponownie bez nowego zapisu.'}
                  </p>
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !readable}
                    onClick={() => void reread('execution')}
                  >
                    Odczytaj pełny wynik
                  </button>
                  {executionComplete&&typedCustody&&typedCustody.context_key===contextKey&&typedCustody.execution.id===execution.id&&renderTypedContinuation?.(typedCustody)}
                  <Rows
                    key={execution.id}
                    rows={executionRows}
                    currency={execution.config.currency}
                    title="Zapisane wartości i wersje"
                  />
                </div>
              )}
            </>
          )}
          {tab === 'history' && (
            <div className="cfi-history">
              <h3>Historia podglądów i zapisów</h3>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void loadHistory()}
              >
                Odczytaj historię
              </button>
              {!historyLoaded && <p>Historia nie została jeszcze odczytana.</p>}
              {historyLoaded && !history.length && <p>Brak importów w tej firmie.</p>}
              <div className="cfi-history-list">
                {history.map((h) => (
                  <button
                    type="button"
                    className="button"
                    key={h.kind + ':' + h.id}
                    disabled={busy}
                    onClick={() => void openHistory(h)}
                  >
                    {h.kind === 'preview' ? 'Podgląd' : 'Zapis'} · {date(h.created_at)} · {h.total}{' '}
                    wierszy · {h.created} nowych / {h.updated} zmian / {h.invalid} błędów
                  </button>
                ))}
              </div>
              {historyCursor && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void loadHistory(true)}
                >
                  Odczytaj starsze importy
                </button>
              )}
              {historyDetail && (
                <div className="cfi-review">
                  <h3>
                    {historyDetail.kind === 'preview'
                      ? 'Historyczny podgląd — tylko odczyt'
                      : 'Dowód wykonanego importu'}
                  </h3>
                  <Counts head={historyDetail.head} />
                  {configSummary(historyDetail.head)}
                  <Rows
                    key={historyDetail.head.id}
                    rows={historyDetail.rows}
                    currency={historyDetail.head.config.currency}
                    title="Pełny zakres historycznego dowodu"
                  />
                  <details>
                    <summary>Identyfikator i zakres dowodu</summary>
                    <p>ID: {historyDetail.head.id}</p>
                    <p>Zakres: {historyDetail.head.scope_hash}</p>
                  </details>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
