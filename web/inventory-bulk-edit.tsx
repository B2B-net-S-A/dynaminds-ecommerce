import { CatalogStockCountDocuments } from './catalog-stock-count-documents';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './inventory-bulk-edit.css';

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string | null;
  can_read: boolean;
  can_write: boolean;
};
type Metadata = Flags & {
  warehouses: { id: string; name: string }[];
  limits: {
    products: number;
    rows: number;
    page: number;
    body_bytes: number;
    selection_products: number;
  };
};
type SelectionRow = {
  product_id: string;
  product_version: number;
  sku: string;
  name: string;
  kind: string;
  location: string;
  stock_version: string | null;
  quantity: number;
  reserved: number;
  available: number;
  warehouse_on_hand: number;
  warehouse_reserved: number;
  exists: boolean;
  editable: boolean;
  errors: string[];
};
type Operation = 'none' | 'count' | 'move';
type Input = {
  product_id: string;
  product_version: number;
  location: string;
  stock_version: string | null;
  operation: Operation;
  quantity?: number;
  destination?: string;
};
type Draft = { operation: Operation; quantity: string; destination: string };
type Snapshot = {
  exists: boolean;
  stock_version: string | null;
  warehouse_on_hand: number;
  warehouse_reserved: number;
  location: string;
  quantity: number;
  reserved: number;
  available: number;
  bins: { location: string; quantity: number; reserved: number; available: number }[];
};
type Status = 'changed' | 'unchanged' | 'invalid' | 'conflict' | 'missing';
type PreviewRow = {
  index: number;
  product_id: string;
  sku: string | null;
  location: string;
  operation: Operation;
  status: Status;
  input: Input;
  before: Snapshot | null;
  after: Snapshot | null;
  errors: string[];
};
type Preview = {
  id: string;
  warehouse_id: string;
  note: string;
  scope_hash: string;
  total: number;
  changed: number;
  unchanged: number;
  invalid: number;
  conflicts: number;
  ready: boolean;
  created_at: string;
};
type Execution = {
  stock_count_documents?: unknown;
  id: string;
  preview_id: string;
  state: 'done';
  scope_hash: string;
  total: number;
  changed: number;
  unchanged: number;
  created_at: string;
};
type ExecutionRow = {
  index: number;
  product_id: string;
  sku: string;
  location: string;
  operation: Operation;
  status: 'changed' | 'unchanged';
  before: Snapshot | null;
  after: Snapshot | null;
  before_stock_version: string | null;
  after_stock_version: string | null;
  operation_ids: string[];
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null; total?: number } };
type PreviewRequest = { client_key: string; warehouse_id: string; note: string; rows: Input[] };
type ExecuteRequest = { client_key: string; scope_hash: string; confirmed: true };
const prefix = '/inventory-bulk-edit';
const MAX_BYTES = 786432;
const operations: Record<Operation, string> = {
  none: 'Bez operacji',
  count: 'Pomiar ilości',
  move: 'Przesunięcie wolnych sztuk',
};
const statuses: Record<Status, string> = {
  changed: 'Do zmiany',
  unchanged: 'Bez zmiany',
  invalid: 'Błąd',
  conflict: 'Konflikt',
  missing: 'Niedostępne',
};
const keyOf = (row: { product_id: string; location: string }) =>
  row.product_id + ':' + row.location;
function quantity(raw: string, move: boolean) {
  if (!/^(0|[1-9]\d*)$/.test(raw) || raw.length > 7)
    throw new Error('Ilość musi być całkowitą liczbą bez znaku, wykładnika i separatorów.');
  const n = Number(raw);
  if (n > 1000000 || (move && n < 1))
    throw new Error(
      move
        ? 'Przesunięcie wymaga od 1 do 1 000 000 sztuk.'
        : 'Pomiar wymaga od 0 do 1 000 000 sztuk.',
    );
  return n;
}
function destination(raw: string) {
  const value = raw.trim();
  if (
    !value ||
    value.length > 80 ||
    value.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
  )
    throw new Error('Lokalizacja docelowa wymaga poprawnego tekstu 1–80 znaków bez NUL.');
  return value;
}
function mergeRows<T extends { index: number }>(old: T[], data: T[]) {
  return [...old, ...data.filter((r) => !old.some((p) => p.index === r.index))];
}
function SnapshotDifference({
  before,
  after,
}: {
  before: Snapshot | null;
  after: Snapshot | null;
}) {
  const locations = [
    ...new Set([
      ...(before?.bins ?? []).map((b) => b.location),
      ...(after?.bins ?? []).map((b) => b.location),
    ]),
  ].sort();
  return (
    <div className="ibe-difference">
      <p>
        Stan w magazynie: {before?.warehouse_on_hand ?? 'brak'} →{' '}
        {after?.warehouse_on_hand ?? 'nie wyliczono'}; zarezerwowane:{' '}
        {before?.warehouse_reserved ?? 'brak'} → {after?.warehouse_reserved ?? 'nie wyliczono'}.
      </p>
      {locations.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Lokalizacja</th>
              <th>Fizycznie przed → po</th>
              <th>Zarezerwowane przed → po</th>
              <th>Wolne przed → po</th>
            </tr>
          </thead>
          <tbody>
            {locations.map((location) => {
              const a = before?.bins.find((b) => b.location === location),
                b = after?.bins.find((b) => b.location === location);
              return (
                <tr key={location}>
                  <th>{location}</th>
                  <td>
                    {a?.quantity ?? 'brak lokalizacji'} → {b?.quantity ?? 'brak lokalizacji'}
                  </td>
                  <td>
                    {a?.reserved ?? '—'} → {b?.reserved ?? '—'}
                  </td>
                  <td>
                    {a?.available ?? '—'} → {b?.available ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {!after && <p>Brak poprawnego końcowego modelu — partia nie może zostać zapisana.</p>}
    </div>
  );
}
function FrozenRows({
  rows,
  receipt = false,
}: {
  rows: (PreviewRow | ExecutionRow)[];
  receipt?: boolean;
}) {
  return (
    <div className="ibe-scroll">
      <table className="ibe-result-table">
        <thead>
          <tr>
            <th>Produkt / lokalizacja</th>
            <th>Operacja</th>
            <th>Wynik / wersje</th>
            <th>Końcowy model</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index}>
              <td>
                <strong>{r.sku ?? 'Produkt niedostępny'}</strong>
                <small>
                  {r.location} · wiersz {r.index + 1}
                </small>
                <small>SKU zapisane w podglądzie</small>
              </td>
              <td>
                {operations[r.operation]}
                {'input' in r && r.input.operation !== 'none' && (
                  <small>
                    {r.input.operation === 'count' ? 'Docelowy pomiar: ' : 'Do przeniesienia: '}
                    {r.input.quantity} szt.{r.input.destination && ' → ' + r.input.destination}
                  </small>
                )}
              </td>
              <td>
                {receipt
                  ? r.status === 'changed'
                    ? 'Zapisano zmianę'
                    : 'Bez zmiany'
                  : statuses[r.status]}
                {'errors' in r &&
                  r.errors.map((e, i) => (
                    <p className="error" role="alert" key={i}>
                      {e}
                    </p>
                  ))}
                {'before_stock_version' in r ? (
                  <small>
                    Stock: {r.before_stock_version ?? 'brak'} → {r.after_stock_version ?? 'brak'}
                  </small>
                ) : (
                  <small>
                    Wybrana wersja produktu: {r.input.product_version}; stock:{' '}
                    {r.input.stock_version ?? 'brak'}
                  </small>
                )}
              </td>
              <td>
                <details>
                  <summary>Stan i rezerwacje przed / po</summary>
                  <SnapshotDifference before={r.before} after={r.after} />
                </details>
                {'operation_ids' in r && r.operation_ids.length > 0 && (
                  <details>
                    <summary>Dowody ruchów</summary>
                    <p className="ibe-technical">{r.operation_ids.join(', ')}</p>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InventoryBulkEdit({
  contextKey = '',
  productIds,
  readOnly,
  externalWriteBlocked = false,
  onClose,
  onChanged,
  onPendingChange,
  initialTab = 'editor',
}: {
  contextKey?: string;
  productIds: readonly string[];
  readOnly: boolean;
  externalWriteBlocked?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onPendingChange?: (pending: boolean) => void;
  initialTab?: 'editor' | 'history';
}) {
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [tab, setTab] = useState<'editor' | 'history'>(initialTab);
  const [warehouse, setWarehouse] = useState('');
  const [selection, setSelection] = useState<SelectionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState({ products: 0, rows: 0 });
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewCursor, setPreviewCursor] = useState<string | null>(null);
  const [consent, setConsent] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState<PreviewRequest | null>(null);
  const [executeAttempt, setExecuteAttempt] = useState<ExecuteRequest | null>(null);
  const previewRequest = useRef<PreviewRequest | null>(null),
    executionRequest = useRef<ExecuteRequest | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [executionRows, setExecutionRows] = useState<ExecutionRow[]>([]);
  const [executionCursor, setExecutionCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Page<Execution> | null>(null);
  const [historical, setHistorical] = useState<Execution | null>(null);
  const [historicalPreview, setHistoricalPreview] = useState<Preview | null>(null);
  const [historicalRows, setHistoricalRows] = useState<ExecutionRow[]>([]);
  const [historicalCursor, setHistoricalCursor] = useState<string | null>(null);
  const alive = useRef(false),
    epoch = useRef(0),
    ticket = useRef(0),
    inFlight = useRef<number | null>(null);
  const ids = [...productIds].sort(),
    scopeKey = ids.join(',');
  const validScope = ids.length >= 1 && ids.length <= 500 && new Set(ids).size === ids.length;
  const frozen = busy || !!previewAttempt || !!executeAttempt;
  const writable =
    !readOnly && !blocked && !!metadata?.available && metadata.can_write && !metadata.read_only;
  const editable = writable && !externalWriteBlocked && !frozen && !execution;
  const fence = preview ? preview.id + ':' + preview.scope_hash : '';
  const current = (context: number) => alive.current && context === epoch.current;
  function clearPlan() {
    setPreview(null);
    setPreviewRows([]);
    setPreviewCursor(null);
    setConsent('');
  }
  function clearExecution() {
    setExecution(null);
    setExecutionRows([]);
    setExecutionCursor(null);
  }
  function releaseAttempts() {
    previewRequest.current = null;
    executionRequest.current = null;
    setPreviewAttempt(null);
    setExecuteAttempt(null);
  }
  function purge() {
    ++epoch.current;
    ++ticket.current;
    inFlight.current = null;
    setMetadata(null);
    setWarehouse('');
    setSelection([]);
    setLoaded(false);
    setDrafts({});
    setNote('');
    clearPlan();
    clearExecution();
    releaseAttempts();
    setHistory(null);
    setHistorical(null);
    setHistoricalPreview(null);
    setHistoricalRows([]);
    setHistoricalCursor(null);
    setNotice('');
    setBlocked(true);
    setBusy(false);
    onPendingChange?.(false);
  }
  function fail(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403].includes(e.status)) purge();
    else if (e instanceof ApiError && e.status === 423) {
      releaseAttempts();
      setConsent('');
      setMetadata((m) => (m ? { ...m, read_only: true, can_write: false } : m));
      setNotice(
        'Zapis jest zablokowany w kopii tylko do odczytu. Szkic zachowano; dostępny jest odczyt historii.',
      );
    } else if (e instanceof ApiError && e.status === 503) {
      releaseAttempts();
      setConsent('');
      setBlocked(true);
      setNotice('Moduł jest niedostępny; dalszy zapis zablokowano. Szkic zachowano.');
    }
  }
  function acceptFlags(d: Flags) {
    if (!d.can_read) {
      setError('Utracono uprawnienia do odczytu magazynu.');
      purge();
      return false;
    }
    setMetadata((m) =>
      m
        ? {
            ...m,
            available: d.available,
            read_only: d.read_only,
            can_read: d.can_read,
            can_write: d.can_write,
            current_role: d.current_role,
          }
        : m,
    );
    if (!d.available) {
      setSelection([]);
      setLoaded(false);
      clearPlan();
      clearExecution();
      releaseAttempts();
      setHistory(null);
      setHistorical(null);
      setHistoricalPreview(null);
      setHistoricalRows([]);
      return false;
    }
    return true;
  }
  async function run(fn: (context: number) => Promise<void>) {
    if (inFlight.current !== null) return;
    const context = epoch.current,
      id = ++ticket.current;
    inFlight.current = id;
    setBusy(true);
    setError('');
    onPendingChange?.(true);
    try {
      await fn(context);
    } catch (e) {
      if (current(context)) fail(e);
    } finally {
      if (current(context) && inFlight.current === id) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }
  async function loadHistory(context: number, cursor?: string | null) {
    const d = await api<Page<Execution>>(
      prefix + '/executions' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    if (!current(context) || !acceptFlags(d)) return;
    setHistory((old) => ({
      ...d,
      data: cursor
        ? [...(old?.data ?? []), ...d.data.filter((r) => !old?.data.some((p) => p.id === r.id))]
        : d.data,
    }));
  }
  useEffect(() => {
    alive.current = true;
    ++epoch.current;
    inFlight.current = null;
    setMetadata(null);
    setBlocked(false);
    setWarehouse('');
    setSelection([]);
    setLoaded(false);
    setDrafts({});
    setNote('');
    clearPlan();
    clearExecution();
    releaseAttempts();
    setHistory(null);
    setHistorical(null);
    setHistoricalPreview(null);
    setHistoricalRows([]);
    setBusy(false);
    setError('');
    setNotice('');
    setPage(0);
    void run(async (context) => {
      const m = await api<Metadata>(prefix);
      if (!current(context)) return;
      setMetadata(m);
      if (m.available && m.can_read && initialTab === 'history') await loadHistory(context);
    });
    return () => {
      alive.current = false;
      ++epoch.current;
      ++ticket.current;
      inFlight.current = null;
      onPendingChange?.(false);
    };
  }, [scopeKey, readOnly, contextKey]);
  useEffect(() => {
    onPendingChange?.(frozen);
  }, [frozen]);
  async function loadSelection(target: string) {
    if (!target || !validScope || frozen || !metadata?.available || !metadata.can_read) return;
    setWarehouse(target);
    setSelection([]);
    setLoaded(false);
    setDrafts({});
    clearPlan();
    clearExecution();
    setNotice('');
    setPage(0);
    setProgress({ products: 0, rows: 0 });
    await run(async (context) => {
      const all: SelectionRow[] = [],
        seen = new Set<string>();
      const size = Math.min(50, metadata.limits?.selection_products ?? 50);
      if (!Number.isInteger(size) || size < 1)
        throw new Error('Nieprawidłowy limit wyboru zwrócony przez API.');
      for (let start = 0; start < ids.length; start += size) {
        const chunk = ids.slice(start, start + size),
          cursors = new Set<string>();
        let cursor: string | null = null,
          chunkCount = 0,
          expected: number | null = null;
        do {
          const query: string =
            '?warehouse_id=' +
            encodeURIComponent(target) +
            '&ids=' +
            encodeURIComponent(chunk.join(',')) +
            (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
          const d: Page<SelectionRow> = await api<Page<SelectionRow>>(
            prefix + '/selection' + query,
          );
          if (!current(context) || !acceptFlags(d)) return;
          if (
            typeof d.meta.total !== 'number' ||
            !Number.isInteger(d.meta.total) ||
            d.meta.total < 0
          )
            throw new Error('API nie podało pełnej liczby lokalizacji. Wybór nie został przyjęty.');
          if (expected === null) expected = d.meta.total;
          if (expected !== d.meta.total)
            throw new Error('Zakres lokalizacji zmienił się podczas odczytu. Wczytaj go ponownie.');
          for (const row of d.data) {
            const key = keyOf(row);
            if (!chunk.includes(row.product_id) || seen.has(key))
              throw new Error(
                'API zwróciło powtórzony lub obcy wiersz wyboru. Cały zakres odrzucono.',
              );
            seen.add(key);
            all.push(row);
            ++chunkCount;
          }
          if (all.length > Math.min(500, metadata.limits?.rows ?? 500))
            throw new Error(
              'Wybrane produkty obejmują ponad 500 lokalizacji. Zmniejsz wybór produktów; nie obcinamy zakresu.',
            );
          setProgress({ products: start, rows: all.length });
          cursor = d.meta.cursor;
          if (cursor) {
            if (cursors.has(cursor) || !d.data.length)
              throw new Error('Nieprawidłowy kursor lokalizacji. Cały zakres odrzucono.');
            cursors.add(cursor);
          }
        } while (cursor);
        if (
          chunkCount !== expected ||
          !chunk.every((product) => all.some((r) => r.product_id === product))
        )
          throw new Error(
            'Odczyt nie objął wszystkich wybranych produktów i lokalizacji. Nie tworzymy częściowego podglądu.',
          );
        setProgress({ products: start + chunk.length, rows: all.length });
      }
      setSelection(all);
      setLoaded(true);
    });
  }
  function dirty() {
    clearPlan();
    setNotice('');
    setError('');
  }
  function change(row: SelectionRow, patch: Partial<Draft>) {
    if (!editable || !row.editable) return;
    const initial: Draft = drafts[keyOf(row)] ?? {
      operation: 'none',
      quantity: String(row.quantity),
      destination: '',
    };
    setDrafts((old) => ({ ...old, [keyOf(row)]: { ...initial, ...patch } }));
    dirty();
  }
  const prepared = useMemo(() => {
    const errors: string[] = [],
      rows: Input[] = [];
    const normalizedNote = note.trim();
    if (
      normalizedNote.length < 3 ||
      normalizedNote.length > 500 ||
      normalizedNote.includes('\0') ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(normalizedNote)
    )
      errors.push('Uzasadnienie wymaga od 3 do 500 znaków poprawnego tekstu bez NUL.');
    for (const row of selection) {
      const d = drafts[keyOf(row)] ?? {
        operation: 'none',
        quantity: String(row.quantity),
        destination: '',
      };
      const input: Input = {
        product_id: row.product_id,
        product_version: row.product_version,
        location: row.location,
        stock_version: row.stock_version,
        operation: d.operation,
      };
      try {
        if (d.operation !== 'none') input.quantity = quantity(d.quantity, d.operation === 'move');
        if (d.operation === 'move') {
          input.destination = destination(d.destination);
          if (input.destination === row.location)
            throw new Error('Lokalizacja docelowa musi różnić się od źródłowej.');
        }
      } catch (e) {
        errors.push(row.sku + ' · ' + row.location + ': ' + (e as Error).message);
      }
      rows.push(input);
    }
    const body = {
      client_key: '00000000-0000-4000-8000-000000000000',
      warehouse_id: warehouse,
      note: normalizedNote,
      rows,
    };
    return {
      rows,
      note: normalizedNote,
      errors,
      bytes: new TextEncoder().encode(JSON.stringify(body)).length,
    };
  }, [selection, drafts, note, warehouse]);
  async function previewPage(context: number, id: string, cursor?: string | null) {
    const d = await api<Page<PreviewRow>>(
      prefix +
        '/previews/' +
        id +
        '/rows' +
        (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    if (!current(context) || !acceptFlags(d)) return;
    setPreviewRows((old) => (cursor ? mergeRows(old, d.data) : d.data));
    setPreviewCursor(d.meta.cursor);
  }
  async function executionPage(context: number, id: string, cursor?: string | null) {
    const d = await api<Page<ExecutionRow>>(
      prefix +
        '/executions/' +
        id +
        '/rows' +
        (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    if (!current(context) || !acceptFlags(d)) return;
    setExecutionRows((old) => (cursor ? mergeRows(old, d.data) : d.data));
    setExecutionCursor(d.meta.cursor);
  }
  async function makePreview() {
    if (
      !writable ||
      (externalWriteBlocked && !previewRequest.current) ||
      !loaded ||
      !validScope ||
      execution ||
      executeAttempt
    )
      return;
    if (
      !previewRequest.current &&
      (prepared.errors.length ||
        prepared.bytes > Math.min(MAX_BYTES, metadata?.limits?.body_bytes ?? MAX_BYTES))
    ) {
      setError(
        prepared.errors[0] ??
          'Całe żądanie przekracza 786432 bajty. Zmniejsz treść lub zakres; niczego nie obcinamy.',
      );
      return;
    }
    const body = previewRequest.current ?? {
      client_key: crypto.randomUUID(),
      warehouse_id: warehouse,
      note: prepared.note,
      rows: prepared.rows,
    };
    await run(async (context) => {
      previewRequest.current = body;
      setPreviewAttempt(body);
      clearPlan();
      setNotice('');
      try {
        const d = await api<Flags & { preview: Preview; reused: boolean }>(
          prefix + '/previews',
          'POST',
          body,
        );
        if (!current(context)) return;
        previewRequest.current = null;
        setPreviewAttempt(null);
        if (!acceptFlags(d)) return;
        setPreview(d.preview);
        setPreviewRows([]);
        setPreviewCursor(null);
        await previewPage(context, d.preview.id);
      } catch (e) {
        if (!current(context)) return;
        if (e instanceof ApiError && [409, 422, 413].includes(e.status)) {
          previewRequest.current = null;
          setPreviewAttempt(null);
          setConsent('');
        }
        if (previewRequest.current)
          setNotice(
            'Odpowiedź podglądu jest niepewna. Zachowano body i klucz; ponów tę samą próbę.',
          );
        throw e;
      }
    });
  }
  async function execute() {
    if (
      !writable ||
      (externalWriteBlocked && !executionRequest.current) ||
      !preview?.ready ||
      execution ||
      (!executionRequest.current && consent !== fence)
    )
      return;
    const id = preview.id,
      body = executionRequest.current ?? {
        client_key: crypto.randomUUID(),
        scope_hash: preview.scope_hash,
        confirmed: true as const,
      };
    await run(async (context) => {
      executionRequest.current = body;
      setExecuteAttempt(body);
      setNotice('');
      try {
        const d = await api<Flags & { execution: Execution; reused: boolean }>(
          prefix + '/previews/' + id + '/execute',
          'POST',
          body,
        );
        if (!current(context)) return;
        executionRequest.current = null;
        setExecuteAttempt(null);
        if (!acceptFlags(d)) return;
        setExecution(d.execution);
        setExecutionRows([]);
        setConsent('');
        setNotice('Cała partia została zapisana lokalnie. Wynik jest trwały.');
        onChanged();
        await executionPage(context, d.execution.id);
      } catch (e) {
        if (!current(context)) return;
        if (
          executionRequest.current &&
          e instanceof ApiError &&
          [409, 422, 413].includes(e.status)
        ) {
          executionRequest.current = null;
          setExecuteAttempt(null);
          clearPlan();
          setNotice(
            'Partia nie została zapisana. Szkic i wybrane wersje zachowano; potrzebny nowy podgląd i zgoda. Odczyt zakresu od nowa usuwa szkic.',
          );
        }
        if (executionRequest.current)
          setNotice(
            'Wynik jest niepewny. Ponowienie użyje tego samego zakresu, zgody i klucza; nie tworzymy drugiego wykonania.',
          );
        throw e;
      }
    });
  }
  async function readHistory(head: Execution, cursor?: string | null) {
    await run(async (context) => {
      const [detail, data] = await Promise.all([
        api<Flags & { execution: Execution }>(prefix + '/executions/' + head.id),
        api<Page<ExecutionRow>>(
          prefix +
            '/executions/' +
            head.id +
            '/rows' +
            (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        ),
      ]);
      if (!current(context) || !acceptFlags(detail) || !acceptFlags(data)) return;
      const frozenPreview = await api<Flags & { preview: Preview }>(
        prefix + '/previews/' + detail.execution.preview_id,
      );
      if (!current(context) || !acceptFlags(frozenPreview)) return;
      setHistoricalPreview(frozenPreview.preview);
      setHistorical(detail.execution);
      setHistoricalRows((old) => (cursor ? mergeRows(old, data.data) : data.data));
      setHistoricalCursor(data.meta.cursor);
    });
  }
  const pages = Math.max(1, Math.ceil(selection.length / 50));
  return (
    <section className="panel inventory-bulk-edit" aria-label="Arkusz stanów i lokalizacji">
      <div className="panel-heading">
        <div>
          <h2>Stany i lokalizacje</h2>
          <p>{ids.length} jawnie wybranych produktów · osobna partia magazynowa</p>
        </div>
        <button className="button" disabled={frozen} onClick={onClose}>
          Zamknij panel
        </button>
      </div>
      <div className="ibe-body">
        <p className="notice">
          Operacje zapisują lokalny pomiar ilości lub przesunięcie wolnych sztuk. Nie zmieniają PIM
          ani ofert w kanałach. Stan fizyczny, rezerwacje i wolne sztuki są odrębnymi wielkościami.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {busy && (
          <p role="status">
            Trwa lokalna operacja…
            {warehouse &&
              !loaded &&
              ' Odczytano ' +
                progress.rows +
                ' lokalizacji dla ' +
                progress.products +
                ' z ' +
                ids.length +
                ' produktów.'}
          </p>
        )}
        {metadata && !metadata.available && (
          <p>Ta kopia nie zawiera arkusza stanów i lokalizacji.</p>
        )}
        {(readOnly || metadata?.read_only) && (
          <p className="notice">Kopia tylko do odczytu — zapis jest zablokowany.</p>
        )}
        {metadata?.available && metadata.can_read && (
          <>
            <div className="ibe-toolbar" role="tablist" aria-label="Arkusz i historia">
              <button
                className="button"
                role="tab"
                aria-selected={tab === 'editor'}
                disabled={frozen || !validScope}
                onClick={() => setTab('editor')}
              >
                Arkusz wybranych produktów
              </button>
              <button
                className="button"
                role="tab"
                aria-selected={tab === 'history'}
                disabled={frozen}
                onClick={() => {
                  setTab('history');
                  if (!history) void run((context) => loadHistory(context));
                }}
              >
                Historia stanów i lokalizacji
              </button>
            </div>
            {tab === 'editor' && (
              <>
                {!writable && (
                  <p>
                    Ten kontekst nie ma uprawnienia do zapisu. Dostępny jest odczyt lokalnych danych
                    i historii.
                  </p>
                )}
                {!validScope && (
                  <p className="error">
                    Wybierz 1–500 różnych produktów. Większego zakresu nie obcinamy.
                  </p>
                )}
                <label>
                  Magazyn
                  <select
                    aria-label="Magazyn arkusza"
                    value={warehouse}
                    disabled={frozen || !validScope}
                    onChange={(e) => {
                      const target = e.target.value;
                      if (!target) {
                        setWarehouse('');
                        setSelection([]);
                        setLoaded(false);
                        setDrafts({});
                        clearPlan();
                        clearExecution();
                      } else void loadSelection(target);
                    }}
                  >
                    <option value="">Wybierz magazyn</option>
                    {metadata.warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
                {warehouse && (
                  <button
                    className="button"
                    disabled={frozen}
                    onClick={() => void loadSelection(warehouse)}
                  >
                    Wczytaj cały zakres od nowa (usuwa szkic)
                  </button>
                )}
                {loaded && (
                  <>
                    <p>
                      <strong>
                        Pełny zakres: {selection.length} lokalizacji z {ids.length} produktów.
                      </strong>{' '}
                      Odczytano wszystkie strony i porcje wyboru. Nie podmieniamy wersji podczas
                      edycji.
                    </p>
                    <p className="notice">
                      Pomiary są obliczane przed przesunięciami. Przesunięcie korzysta z wolnych
                      sztuk po pomiarze w źródle, bez doliczania przychodzących przesunięć. Przed
                      zapisem sprawdź końcowy model wszystkich lokalizacji.
                    </p>
                    <label>
                      Uzasadnienie operacji
                      <textarea
                        aria-label="Uzasadnienie operacji magazynowej"
                        rows={2}
                        value={note}
                        disabled={!editable}
                        onChange={(e) => {
                          setNote(e.target.value);
                          dirty();
                        }}
                      />
                    </label>
                    <div className="ibe-toolbar">
                      <strong>
                        Strona {page + 1} z {pages} · lokalizacje po 50
                      </strong>
                      <button
                        className="button"
                        disabled={frozen || page === 0}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        Poprzednie lokalizacje
                      </button>
                      <button
                        className="button"
                        disabled={frozen || page + 1 >= pages}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Następne lokalizacje
                      </button>
                    </div>
                    <div className="ibe-scroll">
                      <table className="ibe-sheet">
                        <thead>
                          <tr>
                            <th>Produkt / wersje</th>
                            <th>Lokalizacja</th>
                            <th>Fizycznie / rezerwacja / wolne</th>
                            <th>Operacja</th>
                            <th>Ilość</th>
                            <th>Cel przesunięcia</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selection.slice(page * 50, page * 50 + 50).map((r) => {
                            const d = drafts[keyOf(r)] ?? {
                              operation: 'none' as const,
                              quantity: String(r.quantity),
                              destination: '',
                            };
                            return (
                              <tr key={keyOf(r)}>
                                <td>
                                  <strong>{r.sku}</strong>
                                  <small>{r.name}</small>
                                  <small>
                                    Produkt: {r.product_version}; stock: {r.stock_version ?? 'brak'}
                                  </small>
                                </td>
                                <td>
                                  {r.location}
                                  {!r.exists && r.editable && (
                                    <small>Brak stanu — początkowy pomiar w A-01</small>
                                  )}
                                  {r.errors.map((e, i) => (
                                    <p className="error" key={i}>
                                      {e}
                                    </p>
                                  ))}
                                </td>
                                <td>
                                  {r.quantity} / {r.reserved} / {r.available}
                                  <small>
                                    Magazyn: {r.warehouse_on_hand} fizycznie, {r.warehouse_reserved}{' '}
                                    zarezerwowane
                                  </small>
                                </td>
                                <td>
                                  <select
                                    aria-label={'Operacja · ' + r.sku + ' · ' + r.location}
                                    disabled={!editable || !r.editable}
                                    value={d.operation}
                                    onChange={(e) =>
                                      change(r, {
                                        operation: e.target.value as Operation,
                                        quantity:
                                          e.target.value === 'move' ? '1' : String(r.quantity),
                                      })
                                    }
                                  >
                                    <option value="none">Bez operacji</option>
                                    <option value="count">Pomiar ilości</option>
                                    <option value="move" disabled={!r.exists}>
                                      Przesunięcie wolnych sztuk
                                    </option>
                                  </select>
                                </td>
                                <td>
                                  <input
                                    aria-label={'Ilość · ' + r.sku + ' · ' + r.location}
                                    inputMode="numeric"
                                    value={d.operation === 'none' ? '' : d.quantity}
                                    disabled={!editable || !r.editable || d.operation === 'none'}
                                    onChange={(e) => change(r, { quantity: e.target.value })}
                                  />
                                  <small>
                                    {d.operation === 'count'
                                      ? 'Docelowy stan fizyczny w tej lokalizacji'
                                      : d.operation === 'move'
                                        ? 'Ile wolnych sztuk przenieść'
                                        : 'Brak zmiany'}
                                  </small>
                                </td>
                                <td>
                                  <input
                                    aria-label={'Cel przesunięcia · ' + r.sku + ' · ' + r.location}
                                    value={d.destination}
                                    disabled={!editable || !r.editable || d.operation !== 'move'}
                                    placeholder="np. B-02"
                                    onChange={(e) => change(r, { destination: e.target.value })}
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p>
                      Całe żądanie: {prepared.bytes.toLocaleString('pl-PL')} /{' '}
                      {Math.min(MAX_BYTES, metadata.limits?.body_bytes ?? MAX_BYTES).toLocaleString(
                        'pl-PL',
                      )}{' '}
                      bajtów. Brak cichego obcinania.
                    </p>
                    {prepared.errors.map((e, i) => (
                      <p className="error" key={i}>
                        {e}
                      </p>
                    ))}
                    <button
                      className="button primary"
                      disabled={
                        !writable ||
                        (externalWriteBlocked && !previewAttempt) ||
                        busy ||
                        !!executeAttempt ||
                        !!execution
                      }
                      onClick={() => void makePreview()}
                    >
                      {previewAttempt ? 'Ponów ten sam podgląd' : 'Utwórz podgląd całej partii'}
                    </button>
                  </>
                )}
                {preview && (
                  <section className="ibe-result">
                    <h3>Niezmienny podgląd całej partii</h3>
                    <p>
                      Łącznie {preview.total} lokalizacji; zmiany {preview.changed}; bez zmiany{' '}
                      {preview.unchanged}; błędy {preview.invalid}; konflikty {preview.conflicts}.
                    </p>
                    <p>
                      Magazyn:{' '}
                      {metadata.warehouses.find((w) => w.id === preview.warehouse_id)?.name ??
                        'Historyczny magazyn'}
                      . Uzasadnienie: {preview.note}
                    </p>
                    <FrozenRows rows={previewRows} />
                    <p>
                      Wczytano {previewRows.length} z {preview.total} wierszy podglądu. Zgoda
                      dotyczy wszystkich wierszy, również na kolejnych stronach.
                    </p>
                    {previewCursor && (
                      <button
                        className="button"
                        disabled={frozen}
                        onClick={() =>
                          void run((context) => previewPage(context, preview.id, previewCursor))
                        }
                      >
                        Kolejne wiersze podglądu
                      </button>
                    )}
                    <button
                      className="button"
                      disabled={frozen}
                      onClick={() => void run((context) => previewPage(context, preview.id))}
                    >
                      Odśwież lokalny podgląd
                    </button>
                    {!preview.ready && (
                      <p className="error">
                        Jeden błędny, brakujący lub konfliktowy wiersz blokuje całą partię. Popraw
                        szkic albo jawnie wczytaj zakres od nowa.
                      </p>
                    )}
                    {preview.ready && !execution && (
                      <>
                        <label className="ibe-check">
                          <input
                            type="checkbox"
                            aria-label="Zgoda na całą partię magazynową"
                            checked={consent === fence}
                            disabled={!writable || externalWriteBlocked || frozen}
                            onChange={(e) => setConsent(e.target.checked ? fence : '')}
                          />
                          Potwierdzam lokalny zapis całej partii {preview.total} lokalizacji:{' '}
                          {preview.changed} ze zmianą, {preview.unchanged} bez zmiany. Sprawdziłem
                          końcowy model, rezerwacje i uzasadnienie. Bez zapisu do dostawców.
                        </label>
                        <button
                          className="button primary"
                          disabled={
                            !writable ||
                            (externalWriteBlocked && !executeAttempt) ||
                            busy ||
                            (!executeAttempt && consent !== fence)
                          }
                          onClick={() => void execute()}
                        >
                          {executeAttempt
                            ? 'Ponów tę samą próbę / odczytaj wynik'
                            : 'Zapisz całą zatwierdzoną partię'}
                        </button>
                      </>
                    )}
                    <details>
                      <summary>Identyfikator i hash zakresu</summary>
                      <p className="ibe-technical">
                        {preview.id}
                        <br />
                        {preview.scope_hash}
                      </p>
                    </details>
                  </section>
                )}
                {execution && (
                  <section className="ibe-result">
                    <h3>Zapisano całą partię</h3>
                    <CatalogStockCountDocuments documents={execution.stock_count_documents} protocol="inventory_bulk" sourceId={execution.preview_id} contextKey={contextKey} warehouses={metadata.warehouses.map(w => ({...w,code:''}))} />
                    <p>
                      {execution.total} lokalizacji; zmieniono {execution.changed}; bez zmiany{' '}
                      {execution.unchanged}. Wersje stock poniżej dotyczą końca całej partii; wersje
                      produktów pozostają bez zmiany.
                    </p>
                    <FrozenRows rows={executionRows} receipt />
                    <p>
                      Wczytano {executionRows.length} z {execution.total} wyników.
                    </p>
                    {executionCursor && (
                      <button
                        className="button"
                        disabled={frozen}
                        onClick={() =>
                          void run((context) =>
                            executionPage(context, execution.id, executionCursor),
                          )
                        }
                      >
                        Kolejne wyniki wykonania
                      </button>
                    )}
                    <button
                      className="button"
                      disabled={frozen}
                      onClick={() => void run((context) => executionPage(context, execution.id))}
                    >
                      Odśwież trwały wynik
                    </button>
                    <p>
                      Aby przygotować następną partię, wczytaj zakres od nowa lub zamknij panel.
                    </p>
                  </section>
                )}
              </>
            )}
            {tab === 'history' && (
              <>
                <div className="ibe-toolbar">
                  <button
                    className="button"
                    disabled={frozen}
                    onClick={() => void run((context) => loadHistory(context))}
                  >
                    Odśwież historię
                  </button>
                  {history?.meta.cursor && (
                    <button
                      className="button"
                      disabled={frozen}
                      onClick={() =>
                        void run((context) => loadHistory(context, history.meta.cursor))
                      }
                    >
                      Starsze wykonania
                    </button>
                  )}
                </div>
                {history && !history.data.length && (
                  <p>Brak wykonanych partii. Sam podgląd nie zmienia magazynu.</p>
                )}
                {history && (
                  <div className="ibe-scroll">
                    <table className="ibe-history">
                      <thead>
                        <tr>
                          <th>Data</th>
                          <th>Zakres</th>
                          <th>Zmienione / bez zmiany</th>
                          <th>Wynik</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.data.map((h) => (
                          <tr key={h.id}>
                            <td>{date(h.created_at)}</td>
                            <td>{h.total} lokalizacji</td>
                            <td>
                              {h.changed} / {h.unchanged}
                            </td>
                            <td>
                              <button
                                className="button"
                                disabled={frozen}
                                onClick={() => void readHistory(h)}
                              >
                                Pokaż trwały wynik
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {historical && (
                  <section className="ibe-result">
                    <h3>Trwały wynik · {date(historical.created_at)}</h3>
                    <CatalogStockCountDocuments documents={historical.stock_count_documents} protocol="inventory_bulk" sourceId={historical.preview_id} contextKey={contextKey} warehouses={metadata.warehouses.map(w => ({...w,code:''}))} />
                    <p>
                      {historical.total} lokalizacji; zmieniono {historical.changed}; bez zmiany{' '}
                      {historical.unchanged}.
                    </p>
                    {historicalPreview && (
                      <p>
                        Magazyn:{' '}
                        {metadata.warehouses.find((w) => w.id === historicalPreview.warehouse_id)
                          ?.name ?? 'Historyczny magazyn'}
                        . Uzasadnienie: {historicalPreview.note}
                      </p>
                    )}
                    <FrozenRows rows={historicalRows} receipt />
                    <p>
                      Wczytano {historicalRows.length} z {historical.total} wierszy.
                    </p>
                    {historicalCursor && (
                      <button
                        className="button"
                        disabled={frozen}
                        onClick={() => void readHistory(historical, historicalCursor)}
                      >
                        Kolejne wiersze wyniku
                      </button>
                    )}
                    <button
                      className="button"
                      disabled={frozen}
                      onClick={() => void readHistory(historical)}
                    >
                      Odśwież ten wynik
                    </button>
                    <details>
                      <summary>Identyfikatory i hash zakresu</summary>
                      <p className="ibe-technical">
                        {historical.id}
                        <br />
                        Podgląd: {historical.preview_id}
                        <br />
                        {historical.scope_hash}
                      </p>
                    </details>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
