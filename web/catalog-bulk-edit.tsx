import {parseCatalogAttributesEdit} from './catalog-attributes';
import type {JsonValue} from '../shared/pim-json';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, date, money } from './api';
import {
  isLogisticsField,
  logisticsLabels,
  logisticsRaw,
  logisticsDisplay,
  parseLogisticsValue,
  type ProductLogistics,
} from './product-logistics';
import './catalog-bulk-edit.css';

type Field =
  | 'name'
  | 'ean'
  | 'price'
  | 'vat'
  | 'category'
  | 'description'
  | 'active'
  | 'attributes'
  | 'images'
  | 'weight_grams'
  | 'length_mm'
  | 'width_mm'
  | 'height_mm'
  | 'manufacturer'
  | 'sku';
type Fields = {
  sku?: string;
  name: string;
  ean: string | null;
  price: number;
  vat: number;
  category: string;
  description: string;
  active: boolean;
  attributes: Record<string, JsonValue>;
  images: string[] | null;
} & ProductLogistics;
type Product = Fields & {
  id: string;
  version: number;
  sku: string;
  kind: string;
  parent_id: string | null;
};
export type CatalogBulkSelection = ReadonlyArray<{ id: string; version: number; sku: string }>;
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string | null;
  can_read: boolean;
  can_write: boolean;
};
type Metadata = Flags & {
  product_sku_edit_available?: boolean;
  product_logistics_available?: boolean;
  active_product_rules: number;
  limits: {
    products: number;
    page: number;
    request_bytes: number;
    previews: number;
    executions: number;
  };
};
type Preview = {
  id: string;
  actor_id: string;
  created_at: string;
  scope_hash: string;
  ready: boolean;
  total: number;
  changed: number;
  unchanged: number;
  invalid: number;
  conflicts: number;
  active_product_rules: number;
};
type PreviewRow = {
  index: number;
  product_id: string;
  sku: string | null;
  expected_version: number;
  current_version: number | null;
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict' | 'missing';
  before: Fields | null;
  after: Fields | null;
  changed_fields: string[];
  errors: string[];
};
type Execution = {
  id: string;
  preview_id: string;
  actor_id: string;
  state: 'done';
  total: number;
  changed: number;
  unchanged: number;
  scope_hash: string;
  created_at: string;
};
type ExecutionRow = {
  index: number;
  product_id: string;
  sku: string;
  status: 'changed' | 'unchanged';
  before_version: number;
  after_version: number;
  changed_fields: string[];
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null } };
type Raw = string | boolean;
type Changes = Partial<Record<Field, unknown>>;
type Edits = Record<string, Partial<Record<Field, Raw>>>;
type PreviewRequest = {
  client_key: string;
  rows: { product_id: string; version: number; changes: Changes }[];
};
type ExecutionRequest = { client_key: string; scope_hash: string; confirmed: true };
const prefix = '/catalog-bulk-edit';
const BYTE_LIMIT = 786432;
const fieldNames: Record<Field, string> = {
  name: 'Nazwa',
  ean: 'EAN',
  price: 'Cena brutto (PLN)',
  vat: 'VAT',
  category: 'Kategoria',
  description: 'Opis',
  active: 'Aktywny',
  attributes: 'Atrybuty — pełny obiekt',
  images: 'Zdjęcia — pełna lista',
  ...logisticsLabels,
  sku: 'SKU — nowy kod',
};
export function normalizeSkuDraft(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > 80)
    throw new Error('SKU wymaga od 1 do 80 znaków. Nie może być puste.');
  if (
    value.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
  )
    throw new Error('SKU wymaga poprawnego tekstu Unicode bez NUL.');
  return value;
}
const allFields = Object.keys(fieldNames) as Field[];
const defaultColumns: Field[] = ['name', 'price', 'category', 'active'];
const statusNames: Record<PreviewRow['status'], string> = {
  changed: 'Do zmiany',
  unchanged: 'Bez zmiany',
  invalid: 'Błąd wartości',
  conflict: 'Konflikt wersji',
  missing: 'Produkt niedostępny',
};
const numberPrice = (minor: number) =>
  Math.trunc(minor / 100) + '.' + String(minor % 100).padStart(2, '0');
function parsePrice(raw: string) {
  if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw))
    throw new Error(
      'Cena: wpisz nieujemną kwotę PLN z kropką i najwyżej dwoma miejscami, bez wykładnika lub separatorów tysięcy.',
    );
  const [whole, fraction = ''] = raw.split('.');
  if (whole.length > 7) throw new Error('Cena przekracza 1 000 000,00 PLN.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > 100000000n) throw new Error('Cena przekracza 1 000 000,00 PLN.');
  return Number(minor);
}
function rawValue(field: Field, values?: Fields): Raw {
  if (!values) return field === 'active' ? false : '';
  if (field === 'sku') return values.sku ?? '';
  if (isLogisticsField(field)) return logisticsRaw(field, values[field]);
  if (field === 'ean') return values.ean ?? '';
  if (field === 'price') return numberPrice(values.price);
  if (field === 'vat') return String(values.vat);
  if (field === 'attributes') return JSON.stringify(values.attributes, null, 2);
  if (field === 'images') return (values.images ?? []).join('\n');
  return values[field];
}
function parseValue(field: Field, value: Raw): unknown {
  if (field === 'sku') return normalizeSkuDraft(String(value));
  if (isLogisticsField(field)) return parseLogisticsValue(field, String(value));
  if (field === 'active') return value === true;
  if (field === 'price') return parsePrice(String(value));
  if (field === 'vat') return Number(value);
  if (field === 'attributes') return parseCatalogAttributesEdit(String(value));
  if (field === 'images')
    return String(value)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  return String(value);
}
function formatValue(field: Field, value: unknown) {
  if (field === 'sku' && value === undefined) return 'Nie zapisano w tym historycznym podglądzie';
  if (isLogisticsField(field))
    return value === undefined
      ? 'Nie zapisano w tym historycznym podglądzie'
      : logisticsDisplay(field, value);
  if (field === 'price' && typeof value === 'number') return money(value, 'PLN');
  if (field === 'active') return value === true ? 'Tak' : 'Nie';
  if (field === 'vat') return String(value) + '%';
  if (typeof value === 'string') return value === '' ? '(pusty tekst)' : value;
  if (value === null || value === undefined) return '(brak wartości)';
  return JSON.stringify(value, null, 2);
}
function merge<T extends { index: number }>(old: T[], incoming: T[]) {
  return [...old, ...incoming.filter((r) => !old.some((p) => p.index === r.index))];
}
function ValueInput({
  field,
  value,
  disabled,
  onChange,
  label,
}: {
  field: Field;
  value: Raw;
  disabled: boolean;
  onChange: (value: Raw) => void;
  label: string;
}) {
  if (field === 'active')
    return (
      <label className="cbe-checkbox">
        <input
          aria-label={label}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        Aktywny
      </label>
    );
  if (field === 'vat')
    return (
      <select
        aria-label={label}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {[0, 5, 8, 23].map((n) => (
          <option key={n} value={n}>
            {n}%
          </option>
        ))}
      </select>
    );
  if (['description', 'attributes', 'images'].includes(field))
    return (
      <textarea
        aria-label={label}
        rows={field === 'attributes' ? 5 : 3}
        value={String(value)}
        disabled={disabled}
        spellCheck={field === 'description'}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <input
      aria-label={label}
      value={String(value)}
      inputMode={
        field === 'price' || (isLogisticsField(field) && field !== 'manufacturer')
          ? 'decimal'
          : undefined
      }
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
function Differences({ row }: { row: PreviewRow }) {
  if (!row.changed_fields.length)
    return (
      <p>
        {row.status === 'unchanged'
          ? 'Żadne pole nie zmieni wartości.'
          : 'Brak wyliczonej różnicy.'}
      </p>
    );
  return (
    <div className="cbe-differences">
      <table>
        <thead>
          <tr>
            <th>Pole</th>
            <th>Przed</th>
            <th>Po</th>
          </tr>
        </thead>
        <tbody>
          {row.changed_fields.map((name) => {
            const field = name as Field;
            return (
              <tr key={name}>
                <th>{fieldNames[field] ?? name}</th>
                <td>
                  <pre>{row.before ? formatValue(field, row.before[field]) : 'Niedostępne'}</pre>
                </td>
                <td>
                  <pre>{row.after ? formatValue(field, row.after[field]) : 'Nie wyliczono'}</pre>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="cbe-scroll">
      <table className="cbe-preview-table">
        <thead>
          <tr>
            <th>Produkt</th>
            <th>Wersje</th>
            <th>Wynik podglądu</th>
            <th>Przed / po</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index}>
              <td>
                <strong>{r.sku ?? 'Produkt niedostępny'}</strong>
                <small>SKU zapisane przed tą edycją</small>
                <small>Wiersz {r.index + 1}</small>
              </td>
              <td>
                Wybrana: {r.expected_version}
                <br />W podglądzie: {r.current_version ?? 'brak'}
              </td>
              <td>
                {statusNames[r.status]}
                {r.errors.map((e, i) => (
                  <p className="error" role="alert" key={i}>
                    {e}
                  </p>
                ))}
              </td>
              <td>
                <details>
                  <summary>
                    {r.changed_fields.length
                      ? 'Pokaż ' + r.changed_fields.length + ' pól'
                      : 'Szczegóły'}
                  </summary>
                  <Differences row={r} />
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CatalogBulkEdit({
  selection,
  workspaceId,
  actorId,
  admin,
  readOnly,
  onChanged,
  onClose,
  onPendingChange,
}: {
  selection: CatalogBulkSelection;
  workspaceId: string;
  actorId: string;
  admin: boolean;
  readOnly: boolean;
  onChanged: () => void;
  onClose: () => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [cache, setCache] = useState<Record<string, Product>>({});
  const [edits, setEdits] = useState<Edits>({});
  const [columns, setColumns] = useState<Field[]>(defaultColumns);
  const [page, setPage] = useState(0);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [bulkField, setBulkField] = useState<Field>('category');
  const [bulkValue, setBulkValue] = useState<Raw>('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewCursor, setPreviewCursor] = useState<string | null>(null);
  const [consent, setConsent] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState<PreviewRequest | null>(null);
  const [executionAttempt, setExecutionAttempt] = useState<ExecutionRequest | null>(null);
  const previewRequest = useRef<PreviewRequest | null>(null);
  const executeRequest = useRef<ExecutionRequest | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [executionRows, setExecutionRows] = useState<ExecutionRow[]>([]);
  const [executionCursor, setExecutionCursor] = useState<string | null>(null);
  const alive = useRef(true),
    epoch = useRef(0),
    pageGeneration = useRef(0),
    pending = useRef(false);
  const scope = [...selection].sort((a, b) => a.id.localeCompare(b.id));
  const selectionKey = scope.map((p) => p.id + ':' + p.version).join('|');
  const scopeRef = useRef(selectionKey);
  scopeRef.current = selectionKey;
  const scopeToken =
    workspaceId + ':' + actorId + ':' + admin + ':' + readOnly + ':' + selectionKey;
  const frozen = busy || !!previewAttempt || !!executionAttempt;
  const writable =
    admin &&
    !readOnly &&
    !!metadata?.available &&
    metadata.can_write &&
    !metadata.read_only &&
    !blocked;
  const editable = writable && !frozen && !execution;
  const logisticsAvailable = metadata?.product_logistics_available === true;
  const skuAvailable = metadata?.product_sku_edit_available === true;
  const validScope =
    selection.length >= 1 &&
    selection.length <= 500 &&
    new Set(selection.map((p) => p.id)).size === selection.length &&
    selection.every((p) => Number.isInteger(p.version) && p.version > 0);
  const visible = scope.slice(page * 50, page * 50 + 50);
  const previewFence = preview ? preview.id + ':' + preview.scope_hash : '';
  const fenceRef = useRef(previewFence);
  fenceRef.current = previewFence;
  const prepared = useMemo(() => {
    const errors: string[] = [];
    const rows = [...selection]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => {
        const changes: Changes = {};
        for (const [name, raw] of Object.entries(edits[p.id] ?? {})) {
          if (name === 'sku' && !skuAvailable)
            errors.push(
              p.sku +
                ' · Zmiana SKU jest niedostępna w tej kopii. Szkic zachowano; cofnij zmianę SKU przed podglądem pozostałych pól.',
            );
          if (isLogisticsField(name) && !logisticsAvailable)
            errors.push(
              p.sku +
                ' · Dane logistyczne są niedostępne do zapisu w tej kopii. Cofnij zmianę pola.',
            );
          try {
            changes[name as Field] = parseValue(name as Field, raw as Raw);
          } catch (e) {
            errors.push(p.sku + ' · ' + (e as Error).message);
          }
        }
        return { product_id: p.id, version: p.version, changes };
      });
    const bytes = new TextEncoder().encode(
      JSON.stringify({ client_key: '00000000-0000-4000-8000-000000000000', rows }),
    ).length;
    return { rows, errors, bytes };
  }, [selectionKey, edits, logisticsAvailable, skuAvailable]);
  const limit = Math.min(BYTE_LIMIT, metadata?.limits?.request_bytes ?? BYTE_LIMIT);
  const modified = Object.values(edits).filter((p) => Object.keys(p).length > 0).length;
  function purge() {
    ++epoch.current;
    ++pageGeneration.current;
    setCache({});
    setEdits({});
    setTargets(new Set());
    setPreview(null);
    setPreviewRows([]);
    setConsent('');
    setPreviewAttempt(null);
    previewRequest.current = null;
    setExecutionAttempt(null);
    executeRequest.current = null;
    setExecution(null);
    setExecutionRows([]);
    setMetadata(null);
    setBlocked(true);
    setBusy(false);
    setLoading(false);
    pending.current = false;
    onPendingChange?.(false);
  }
  function failure(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403].includes(e.status)) purge();
    else if (e instanceof ApiError && e.status === 423) {
      setPreviewAttempt(null);
      previewRequest.current = null;
      setExecutionAttempt(null);
      executeRequest.current = null;
      setConsent('');
      setMetadata((m) => (m ? { ...m, read_only: true, can_write: false } : m));
    } else if (e instanceof ApiError && e.status === 503) {
      setPreviewAttempt(null);
      previewRequest.current = null;
      setExecutionAttempt(null);
      executeRequest.current = null;
      setConsent('');
      setBlocked(true);
    }
  }
  function flags(d: Flags) {
    if (!d.available || !d.can_read) {
      purge();
      return false;
    }
    setMetadata((m) =>
      m
        ? {
            ...m,
            available: d.available,
            read_only: d.read_only,
            current_role: d.current_role,
            can_read: d.can_read,
            can_write: d.can_write,
          }
        : m,
    );
    return true;
  }
  async function loadPage(index: number) {
    if (!validScope) return;
    const current = epoch.current,
      generation = ++pageGeneration.current,
      signature = scopeRef.current;
    const ids = scope.slice(index * 50, index * 50 + 50).map((p) => p.id);
    if (!ids.length) return;
    setLoading(true);
    setError('');
    try {
      const d = await api<Flags & { data: Product[] }>(
        prefix + '/selection?ids=' + encodeURIComponent(ids.join(',')),
      );
      if (
        !alive.current ||
        current !== epoch.current ||
        signature !== scopeRef.current ||
        generation !== pageGeneration.current
      )
        return;
      if (!flags(d)) return;
      setCache((old) => ({ ...old, ...Object.fromEntries(d.data.map((p) => [p.id, p])) }));
    } catch (e) {
      if (alive.current && current === epoch.current && generation === pageGeneration.current)
        failure(e);
    } finally {
      if (alive.current && generation === pageGeneration.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    const current = ++epoch.current;
    setCache({});
    setEdits({});
    setPage(0);
    setTargets(new Set(selection.map((p) => p.id)));
    setPreview(null);
    setPreviewRows([]);
    setConsent('');
    setExecution(null);
    setExecutionRows([]);
    setPreviewAttempt(null);
    previewRequest.current = null;
    setExecutionAttempt(null);
    executeRequest.current = null;
    setBlocked(false);
    setMetadata(null);
    setError('');
    setNotice('');
    setBusy(false);
    pending.current = false;
    onPendingChange?.(false);
    setLoading(true);
    api<Metadata>(prefix)
      .then(async (m) => {
        if (!alive.current || current !== epoch.current) return;
        setMetadata(m);
        if (m.available && m.can_read && validScope) await loadPage(0);
      })
      .catch((e) => alive.current && current === epoch.current && failure(e))
      .finally(() => alive.current && current === epoch.current && setLoading(false));
    return () => {
      alive.current = false;
      ++epoch.current;
      ++pageGeneration.current;
      onPendingChange?.(false);
    };
  }, [scopeToken]);
  useEffect(() => {
    onPendingChange?.(frozen);
  }, [frozen]);
  function dirty(next: Edits) {
    setEdits(next);
    setPreview(null);
    setPreviewRows([]);
    setPreviewCursor(null);
    setConsent('');
    setError('');
    setNotice('');
  }
  function setCell(id: string, field: Field, value: Raw) {
    if (
      !editable ||
      (isLogisticsField(field) && !logisticsAvailable) ||
      (field === 'sku' && !skuAvailable)
    ) return;
    const next = { ...(edits[id] ?? {}) };
    if (cache[id] && value === rawValue(field, cache[id])) delete next[field];
    else next[field] = value;
    dirty({ ...edits, [id]: next });
  }
  function resetCell(id: string, field: Field) {
    if (!editable) return;
    const next = { ...(edits[id] ?? {}) };
    delete next[field];
    dirty({ ...edits, [id]: next });
  }
  function applyBulk() {
    if (
      !editable || !targets.size ||
      (isLogisticsField(bulkField) && !logisticsAvailable) ||
      (bulkField === 'sku' && !skuAvailable)
    ) return;
    if (bulkField === 'sku' && targets.size !== 1) {
      setError(
        'SKU można ustawić wspólnie tylko dla jednego produktu. Dla kilku produktów wpisz różne kody w komórkach arkusza.',
      );
      return;
    }
    try {
      parseValue(bulkField, bulkValue);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const next = { ...edits };
    for (const id of targets) next[id] = { ...(next[id] ?? {}), [bulkField]: bulkValue };
    dirty(next);
    setNotice(
      'Ustawiono pole „' +
        fieldNames[bulkField] +
        '” w szkicu dla ' +
        targets.size +
        ' produktów. Katalog nie został zapisany.',
    );
  }
  async function readPreviewRows(id: string, cursor?: string | null) {
    const current = epoch.current;
    const d = await api<Page<PreviewRow>>(
      prefix +
        '/previews/' +
        id +
        '/rows' +
        (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    if (!alive.current || current !== epoch.current) return;
    if (!flags(d)) return;
    setPreviewRows((old) => (cursor ? merge(old, d.data) : d.data));
    setPreviewCursor(d.meta.cursor);
  }
  async function readExecutionRows(id: string, cursor?: string | null) {
    const current = epoch.current;
    const d = await api<Page<ExecutionRow>>(
      prefix +
        '/executions/' +
        id +
        '/rows' +
        (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    if (!alive.current || current !== epoch.current) return;
    if (!flags(d)) return;
    setExecutionRows((old) => (cursor ? merge(old, d.data) : d.data));
    setExecutionCursor(d.meta.cursor);
  }
  async function localRead(fn: () => Promise<void>) {
    if (pending.current) return;
    const current = epoch.current;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (alive.current && current === epoch.current) failure(e);
    } finally {
      pending.current = false;
      if (alive.current && current === epoch.current) setBusy(false);
    }
  }
  async function createPreview() {
    if (!writable || pending.current || !validScope || execution || executionAttempt) return;
    if (!previewRequest.current && (prepared.errors.length || prepared.bytes > limit)) {
      setError(
        prepared.errors[0] ??
          'Całe żądanie przekracza limit ' +
            limit +
            ' bajtów. Zmniejsz zakres lub treść; niczego nie obcinamy.',
      );
      return;
    }
    const request = previewRequest.current ?? {
      client_key: crypto.randomUUID(),
      rows: prepared.rows,
    };
    previewRequest.current = request;
    setPreviewAttempt(request);
    setConsent('');
    pending.current = true;
    setBusy(true);
    onPendingChange?.(true);
    setError('');
    setNotice('');
    const current = epoch.current;
    try {
      const d = await api<Flags & { preview: Preview; reused?: boolean }>(
        prefix + '/previews',
        'POST',
        request,
      );
      if (!alive.current || current !== epoch.current) return;
      previewRequest.current = null;
      setPreviewAttempt(null);
      if (!flags(d)) return;
      setPreview(d.preview);
      fenceRef.current = d.preview.id + ':' + d.preview.scope_hash;
      setPreviewRows([]);
      setPreviewCursor(null);
      await readPreviewRows(d.preview.id);
    } catch (e) {
      if (!alive.current || current !== epoch.current) return;
      if (e instanceof ApiError && [409, 422, 413].includes(e.status)) {
        previewRequest.current = null;
        setPreviewAttempt(null);
        setConsent('');
      }
      failure(e);
      if (previewRequest.current)
        setNotice(
          'Odpowiedź podglądu jest niepewna. Zamrożono treść i klucz; ponów dokładnie tę samą próbę.',
        );
    } finally {
      pending.current = false;
      if (alive.current && current === epoch.current) setBusy(false);
    }
  }
  async function execute() {
    if (
      !writable ||
      pending.current ||
      !preview ||
      execution ||
      !preview.ready ||
      (!executeRequest.current && consent !== previewFence)
    )
      return;
    const request = executeRequest.current ?? {
      client_key: crypto.randomUUID(),
      scope_hash: preview.scope_hash,
      confirmed: true as const,
    };
    executeRequest.current = request;
    setExecutionAttempt(request);
    pending.current = true;
    setBusy(true);
    onPendingChange?.(true);
    setError('');
    setNotice('');
    const current = epoch.current;
    try {
      const d = await api<Flags & { execution: Execution; reused?: boolean }>(
        prefix + '/previews/' + preview.id + '/execute',
        'POST',
        request,
      );
      if (!alive.current || current !== epoch.current) return;
      executeRequest.current = null;
      setExecutionAttempt(null);
      if (!flags(d)) return;
      setExecution(d.execution);
      setExecutionRows([]);
      setExecutionCursor(null);
      setConsent('');
      setNotice(
        'Zapisano całą partię. Wynik jest trwały; aktywne reguły produktów mogą wykonać dalsze zmiany lokalne.',
      );
      onChanged();
      await readExecutionRows(d.execution.id);
    } catch (e) {
      if (!alive.current || current !== epoch.current) return;
      if (executeRequest.current && e instanceof ApiError && [409, 422, 413].includes(e.status)) {
        executeRequest.current = null;
        setExecutionAttempt(null);
        setPreview(null);
        setPreviewRows([]);
        setConsent('');
        setNotice(
          'Partia nie została zapisana. Potrzebny jest nowy podgląd i zgoda. W razie konfliktu produktu ponownie wybierz jego aktualną wersję w katalogu.',
        );
      }
      failure(e);
      if (executeRequest.current)
        setNotice(
          'Wynik zapisu jest niepewny. Zachowano dokładny zakres, treść zgody i klucz. Ponowienie odczyta wcześniejszy wynik albo wykona tę samą zatwierdzoną próbę.',
        );
    } finally {
      pending.current = false;
      if (alive.current && current === epoch.current) setBusy(false);
    }
  }
  return (
    <section className="panel catalog-bulk-edit" aria-label="Arkusz edycji produktów">
      <div className="panel-heading">
        <div>
          <h2>Arkusz edycji produktów</h2>
          <p>
            {selection.length} jawnie wybranych produktów · wersje z momentu wyboru · cena bazowa w
            PLN
          </p>
        </div>
        <button className="button" disabled={frozen} onClick={onClose}>
          Zamknij arkusz
        </button>
      </div>
      <div className="cbe-body">
        <p className="notice">
          Edytujesz lokalne dane PIM. Typ, relacje wariantów, składniki zestawu, zapasy,
          rezerwacje i cenniki pozostają poza tym arkuszem. Nie publikujemy zmian do kanałów.
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
        {!validScope && (
          <p className="error" role="alert">
            Wybierz 1–500 różnych produktów z dodatnimi wersjami. Większego zakresu nie obcinamy.
          </p>
        )}
        {loading && !metadata && <p role="status">Wczytywanie arkusza…</p>}
        {metadata && !metadata.available && (
          <p>Ta kopia nie zawiera zbiorczego edytora PIM. Katalog nadal można przeglądać.</p>
        )}
        {metadata?.available && !metadata.can_read && (
          <p>Brak aktualnego prawa odczytu tego modułu.</p>
        )}
        {(readOnly || metadata?.read_only) && (
          <p className="notice">
            Podgląd kopii — odczyt i historia są dostępne, wszystkie zapisy są wyłączone.
          </p>
        )}
        {metadata?.available && metadata.can_read && validScope && (
          <>
            {!writable && !readOnly && !metadata.read_only && (
              <p>Zmiany może zatwierdzić wyłącznie aktualny administrator.</p>
            )}
            <p className="notice">
              Aktywne reguły produktów: <strong>{metadata.active_product_rules}</strong>. Zapis pól
              może uruchomić ich lokalne akcje. Dokładny stan reguł jest zamrażany w podglądzie i
              ponownie sprawdzany przed zapisem.
            </p>
            <fieldset className="cbe-columns">
              <legend>Widoczne kolumny arkusza</legend>
              {allFields.map((f) => (
                <label className="cbe-checkbox" key={f}>
                  <input
                    type="checkbox"
                    checked={columns.includes(f)}
                    onChange={(e) =>
                      setColumns((old) =>
                        e.target.checked
                          ? allFields.filter((v) => old.includes(v) || v === f)
                          : old.filter((v) => v !== f),
                      )
                    }
                  />
                  {fieldNames[f]}
                </label>
              ))}
            </fieldset>
            <p className="notice">
              Zmiana SKU zachowuje tożsamość produktu. Istniejące zamówienia i ich kody kompletacji
              zachowują zapisane SKU. Aktualne i historyczne kody pozostają przypisane do tego
              samego produktu; kod należący do innego produktu blokuje całą partię. Wielkość liter
              ma znaczenie. Nowy kod może kolidować z EAN przy skanowaniu.
            </p>
            {!skuAvailable && (
              <p className="muted">
                Zmiana SKU jest niedostępna w tej kopii; kolumna pozostaje tylko do odczytu.
              </p>
            )}
            {!logisticsAvailable && (
              <p className="muted">
                Ta kopia nie udostępnia zapisu wagi, wymiarów i producenta. Nowe kolumny służą
                wyłącznie odczytowi.
              </p>
            )}
            <div className="cbe-bulk-setting">
              <h3>Ustaw dla wybranych</h3>
              <p>
                Wybrano do ustawienia:{' '}
                <strong>
                  {targets.size} z {selection.length}
                </strong>
                . Ten wybór dotyczy ustawienia pola; podgląd obejmie wszystkie produkty wybrane w
                katalogu, również bez zmian.
              </p>
              <div className="cbe-toolbar">
                <button
                  className="button"
                  disabled={!editable}
                  onClick={() => setTargets(new Set(scope.map((p) => p.id)))}
                >
                  Wybierz wszystkie {selection.length}
                </button>
                <button
                  className="button"
                  disabled={!editable}
                  onClick={() => setTargets(new Set(visible.map((p) => p.id)))}
                >
                  Tylko bieżąca strona
                </button>
                <button
                  className="button"
                  disabled={!editable}
                  onClick={() => setTargets(new Set())}
                >
                  Wyczyść wybór do ustawienia
                </button>
              </div>
              <div className="cbe-setting-grid">
                <label>
                  Pole do ustawienia
                  <select
                    value={bulkField}
                    disabled={!editable}
                    onChange={(e) => {
                      const f = e.target.value as Field;
                      setBulkField(f);
                      setBulkValue(
                        f === 'active' ? true : f === 'vat' ? '23' : f === 'attributes' ? '{}' : '',
                      );
                    }}
                  >
                    {allFields.map((f) => (
                      <option
                        key={f}
                        value={f}
                        disabled={
                          (isLogisticsField(f) && !logisticsAvailable) ||
                          (f === 'sku' && !skuAvailable)
                        }
                      >
                        {fieldNames[f]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Nowa wartość
                  <ValueInput
                    field={bulkField}
                    value={bulkValue}
                    disabled={!editable || (bulkField === 'sku' && !skuAvailable)}
                    label={'Nowa wartość: ' + fieldNames[bulkField]}
                    onChange={setBulkValue}
                  />
                </label>
              </div>
              <p className="muted">
                Atrybuty zastępują cały obiekt; <code>{'{}'}</code> usuwa wszystkie. Zdjęcia
                zastępują całą listę; jedno HTTPS lub własny plik aplikacji na linię, puste pole
                usuwa listę. Cena: np. 12.30 PLN. Pominięte pola pozostają bez zmian.
              </p>
              <p className="muted">
                Waga: kg, do 3 miejsc po separatorze. Wymiary produktu: cm, do 1 miejsca. Puste pole
                logistyczne ustawia brak danych. Producent jest tekstem, bez zarządzanego
                słownika. Dane nie określają gotowej paczki.
              </p>
              <button
                className="button"
                disabled={!editable || targets.size === 0}
                onClick={applyBulk}
              >
                Ustaw pole w szkicu dla {targets.size} produktów
              </button>
            </div>
            <div className="cbe-toolbar">
              <strong>
                Strona {page + 1} z {Math.max(1, Math.ceil(selection.length / 50))} · do 50
                produktów
              </strong>
              <button
                className="button"
                disabled={frozen || loading || page === 0}
                onClick={() => {
                  const n = page - 1;
                  setPage(n);
                  void loadPage(n);
                }}
              >
                Poprzednia strona arkusza
              </button>
              <button
                className="button"
                disabled={frozen || loading || (page + 1) * 50 >= selection.length}
                onClick={() => {
                  const n = page + 1;
                  setPage(n);
                  void loadPage(n);
                }}
              >
                Następna strona arkusza
              </button>
              <button
                className="button"
                disabled={frozen || loading}
                onClick={() => {
                  setPreview(null);
                  setPreviewRows([]);
                  setConsent('');
                  void loadPage(page);
                }}
              >
                Odśwież dane tej strony
              </button>
            </div>
            {loading && <p role="status">Wczytywanie bieżących danych produktów…</p>}
            <div className="cbe-scroll">
              <table className="cbe-sheet">
                <thead>
                  <tr>
                    <th>Do ustawienia</th>
                    <th>Produkt / wersja</th>
                    {columns.map((f) => (
                      <th key={f}>{fieldNames[f]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => {
                    const product = cache[p.id];
                    const value = (f: Field): Raw => edits[p.id]?.[f] ?? rawValue(f, product);
                    const control = (f: Field) => (
                      <>
                        <ValueInput
                          field={f}
                          value={value(f)}
                          disabled={
                            !editable ||
                            !product ||
                            loading ||
                            (isLogisticsField(f) && !logisticsAvailable) ||
                            (f === 'sku' && !skuAvailable)
                          }
                          label={fieldNames[f] + ' · ' + p.sku}
                          onChange={(v) => setCell(p.id, f, v)}
                        />
                        {edits[p.id]?.[f] !== undefined && (
                          <button
                            type="button"
                            className="cbe-reset"
                            disabled={!editable}
                            onClick={() => resetCell(p.id, f)}
                          >
                            Cofnij zmianę pola
                          </button>
                        )}
                      </>
                    );
                    return (
                      <tr key={p.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={'Wybierz do ustawienia zbiorczego: ' + p.sku}
                            checked={targets.has(p.id)}
                            disabled={!editable}
                            onChange={(e) =>
                              setTargets((old) => {
                                const next = new Set(old);
                                if (e.target.checked) next.add(p.id);
                                else next.delete(p.id);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="cbe-identity">
                          <strong>{p.sku}</strong>
                          <small>{product?.name ?? 'Dane jeszcze niewczytane'}</small>
                          <small>
                            Wybrana wersja: {p.version}
                            {product && ' · odczytana: ' + product.version}
                          </small>
                          {product && product.version !== p.version && (
                            <p className="error">
                              Wersja zmieniła się. Nie zastępujemy wybranej wersji bieżącą; zapis
                              całej partii zostanie zablokowany.
                            </p>
                          )}
                          {product && (
                            <details>
                              <summary>Opis, atrybuty i zdjęcia</summary>
                              <div className="cbe-long-fields">
                                {(['description', 'attributes', 'images'] as Field[]).map((f) => (
                                  <label key={f}>
                                    {fieldNames[f]}
                                    {control(f)}
                                  </label>
                                ))}
                              </div>
                            </details>
                          )}
                        </td>
                        {columns.map((f) => (
                          <td
                            key={f}
                            className={edits[p.id]?.[f] !== undefined ? 'cbe-edited' : undefined}
                          >
                            {product ? (
                              control(f)
                            ) : (
                              <span>Wczytaj dane tej strony przed edycją.</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="cbe-request">
              <strong>
                Szkic: {modified} produktów z ustawionymi polami; pełny zakres: {selection.length}.
              </strong>
              <p className={prepared.bytes > limit ? 'error' : 'muted'}>
                Rozmiar całego żądania: {prepared.bytes.toLocaleString('pl-PL')} /{' '}
                {limit.toLocaleString('pl-PL')} bajtów. Przekroczenie blokuje całość; niczego nie
                obcinamy.
              </p>
              {prepared.errors.map((e, i) => (
                <p className="error" role="alert" key={i}>
                  {e}
                </p>
              ))}
            </div>
            {previewAttempt && (
              <p className="notice">
                Zamrożono żądanie podglądu i klucz. Ponów tę samą próbę, aby odzyskać trwały
                podgląd. W międzyczasie szkic jest zablokowany.
              </p>
            )}
            {!execution && (
              <button
                className="button primary"
                disabled={
                  !writable ||
                  busy ||
                  !!executionAttempt ||
                  (!previewAttempt && (prepared.bytes > limit || prepared.errors.length > 0))
                }
                onClick={() => void createPreview()}
              >
                {previewAttempt ? 'Ponów ten sam podgląd' : 'Przygotuj trwały podgląd całej partii'}
              </button>
            )}
            {preview && (
              <section className="cbe-result">
                <h3>Podgląd całej partii</h3>
                <p>
                  Łącznie {preview.total} · do zmiany {preview.changed} · bez zmiany{' '}
                  {preview.unchanged} · błędne {preview.invalid} · konflikty {preview.conflicts}
                </p>
                <p>
                  Aktywne reguły w tym podglądzie: {preview.active_product_rules}. Podgląd nie
                  zmienił produktów, wersji ani stanów.
                </p>
                {!preview.ready && (
                  <p className="error" role="alert">
                    Cała partia jest zablokowana. Popraw błędne wartości lub ponownie wybierz
                    aktualne wersje produktów i przygotuj nowy podgląd.
                  </p>
                )}
                <p>
                  Wczytano {previewRows.length} z {preview.total} wierszy. Zatwierdzenie dotyczy
                  całego zakresu, również dalszych stron.
                </p>
                <PreviewTable rows={previewRows} />
                <div className="cbe-toolbar">
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void localRead(() => readPreviewRows(preview.id))}
                  >
                    Odśwież wiersze podglądu
                  </button>
                  {previewCursor && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        void localRead(() => readPreviewRows(preview.id, previewCursor))
                      }
                    >
                      Wczytaj kolejne wiersze podglądu
                    </button>
                  )}
                </div>
                {!execution && (
                  <>
                    <label className="cbe-checkbox cbe-consent">
                      <input
                        type="checkbox"
                        checked={consent === previewFence}
                        disabled={!writable || !preview.ready || frozen}
                        onChange={(e) => setConsent(e.target.checked ? previewFence : '')}
                      />
                      Potwierdzam dokładny zakres {preview.total} produktów: {preview.changed} do
                      zmiany i {preview.unchanged} bez zmiany. Zatwierdzam wszystkie wskazane pola i
                      możliwość uruchomienia {preview.active_product_rules} aktywnych reguł
                      produktów. To lokalna edycja katalogu.
                    </label>
                    {executionAttempt && (
                      <p className="notice">
                        Zapis mógł się udać. Zachowano tę samą treść i klucz; nie tworzymy nowej
                        próby. Ponowienie odczyta zapisany wynik albo wykona tę samą zatwierdzoną
                        partię.
                      </p>
                    )}
                    <button
                      className="button primary"
                      disabled={
                        !writable ||
                        busy ||
                        !preview.ready ||
                        (!executionAttempt && consent !== previewFence)
                      }
                      onClick={() => void execute()}
                    >
                      {executionAttempt
                        ? 'Ponów tę samą próbę / odczytaj wynik'
                        : 'Zapisz całą zatwierdzoną partię'}
                    </button>
                  </>
                )}
                <details>
                  <summary>Identyfikator i zakres podglądu</summary>
                  <p className="cbe-technical">
                    {preview.id}
                    <br />
                    {preview.scope_hash}
                  </p>
                </details>
              </section>
            )}
            {execution && (
              <section className="cbe-result">
                <h3>Zakończono edycję</h3>
                <p>
                  {execution.total} produktów · zmieniono {execution.changed} · bez zmiany{' '}
                  {execution.unchanged} · {date(execution.created_at)}
                </p>
                <p>
                  Zmiany zostały zapisane atomowo. Produkty bez zmiany nie zwiększyły wersji. Wynik
                  przedstawia wersje po tej edycji; późniejsze reguły mogą je zmienić.
                </p>
                <ExecutionTable rows={executionRows} previewRows={previewRows} />
                <p>
                  Wczytano {executionRows.length} z {execution.total} wyników.
                </p>
                {executionCursor && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void localRead(() => readExecutionRows(execution.id, executionCursor))
                    }
                  >
                    Wczytaj kolejne wyniki
                  </button>
                )}
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void localRead(() => readExecutionRows(execution.id))}
                >
                  Odśwież trwały wynik
                </button>
                <p>
                  Aby wykonać kolejną partię, zamknij arkusz i ponownie wybierz produkty z ich
                  aktualnymi wersjami. Nie podmieniamy dotychczasowego wyboru.
                </p>
                <details>
                  <summary>Identyfikator wykonania</summary>
                  <p className="cbe-technical">{execution.id}</p>
                </details>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
function ExecutionTable({
  rows,
  previewRows,
}: {
  rows: ExecutionRow[];
  previewRows: PreviewRow[];
}) {
  return (
    <div className="cbe-scroll">
      <table className="cbe-execution-table">
        <thead>
          <tr>
            <th>Produkt</th>
            <th>Wynik</th>
            <th>Wersja przed → po</th>
            <th>Pola</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const beforeAfter = previewRows.find(
              (p) => p.product_id === r.product_id && p.index === r.index,
            );
            return (
              <tr key={r.index}>
                <td>
                  <strong>{r.sku}</strong>
                  <small>SKU zapisane przed tą edycją</small>
                </td>
                <td>{r.status === 'changed' ? 'Zmieniono' : 'Bez zmiany'}</td>
                <td>
                  {r.before_version} → {r.after_version}
                </td>
                <td>
                  {r.changed_fields.map((f) => fieldNames[f as Field] ?? f).join(', ') || 'Żadne'}
                  {beforeAfter && (
                    <details>
                      <summary>Przed / po</summary>
                      <Differences row={beforeAfter} />
                    </details>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CatalogBulkEditHistory({
  readOnly,
  onClose,
}: {
  readOnly: boolean;
  onClose: () => void;
}) {
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [history, setHistory] = useState<Page<Execution> | null>(null);
  const [selected, setSelected] = useState<Execution | null>(null);
  const [rows, setRows] = useState<ExecutionRow[]>([]);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true),
    generation = useRef(0),
    inFlight = useRef(false);
  function failure(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      ++generation.current;
      inFlight.current = false;
      setBusy(false);
      setMetadata(null);
      setHistory(null);
      setSelected(null);
      setRows([]);
      setPreviewRows([]);
    }
  }
  async function load(after?: string | null) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const current = ++generation.current;
    try {
      const m = await api<Metadata>(prefix);
      if (!alive.current || current !== generation.current) return;
      setMetadata(m);
      if (!m.available || !m.can_read) {
        setHistory(null);
        setSelected(null);
        setRows([]);
        setPreviewRows([]);
        return;
      }
      const d = await api<Page<Execution>>(
        prefix + '/executions' + (after ? '?cursor=' + encodeURIComponent(after) : ''),
      );
      if (!alive.current || current !== generation.current) return;
      if (!d.can_read || !d.available) {
        setHistory(null);
        setSelected(null);
        setRows([]);
        setPreviewRows([]);
        return;
      }
      setHistory((old) => ({
        ...d,
        data: after
          ? [...(old?.data ?? []), ...d.data.filter((r) => !old?.data.some((p) => p.id === r.id))]
          : d.data,
      }));
    } catch (e) {
      if (alive.current && current === generation.current) failure(e);
    } finally {
      if (alive.current && current === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    inFlight.current = false;
    void load();
    return () => {
      alive.current = false;
      ++generation.current;
      inFlight.current = false;
    };
  }, []);
  async function details(head: Execution, after?: string | null) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const current = ++generation.current;
    if (!after) {
      setSelected(null);
      setRows([]);
      setPreviewRows([]);
      setCursor(null);
    }
    try {
      const query = after ? '?cursor=' + encodeURIComponent(after) : '';
      const [d, e, p] = await Promise.all([
        api<Flags & { execution: Execution }>(prefix + '/executions/' + head.id),
        api<Page<ExecutionRow>>(prefix + '/executions/' + head.id + '/rows' + query),
        api<Page<PreviewRow>>(prefix + '/previews/' + head.preview_id + '/rows' + query),
      ]);
      if (!alive.current || current !== generation.current) return;
      if (![d, e, p].every((r) => r.available && r.can_read)) {
        setSelected(null);
        setRows([]);
        setPreviewRows([]);
        return;
      }
      setSelected(d.execution);
      setRows((old) => (after ? merge(old, e.data) : e.data));
      setPreviewRows((old) => (after ? merge(old, p.data) : p.data));
      setCursor(e.meta.cursor);
    } catch (e) {
      if (alive.current && current === generation.current) failure(e);
    } finally {
      if (alive.current && current === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="panel catalog-bulk-edit" aria-label="Historia zbiorczych edycji katalogu">
      <div className="panel-heading">
        <div>
          <h2>Historia edycji katalogu</h2>
          <p>Trwałe wyniki całych partii, wersje i niezmienny podgląd pól.</p>
        </div>
        <div className="cbe-toolbar">
          <button className="button" disabled={busy} onClick={() => void load()}>
            Odśwież historię
          </button>
          <button className="button" onClick={onClose}>
            Zamknij historię
          </button>
        </div>
      </div>
      <div className="cbe-body">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {busy && !metadata && <p role="status">Wczytywanie historii…</p>}
        {metadata && !metadata.available && (
          <p>Ta kopia nie zawiera historii zbiorczego edytora PIM.</p>
        )}
        {(readOnly || metadata?.read_only) && (
          <p className="notice">Podgląd kopii — wyłącznie odczyt.</p>
        )}
        {history && (
          <>
            <div className="cbe-scroll">
              <table className="cbe-execution-table">
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
                      <td>{h.total} produktów</td>
                      <td>
                        {h.changed} / {h.unchanged}
                      </td>
                      <td>
                        <button className="button" disabled={busy} onClick={() => void details(h)}>
                          Pokaż trwały wynik
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!history.data.length && (
              <p>
                Brak wykonanych edycji arkuszowych. Podgląd sam nie zmienia katalogu i nie jest
                wykonaniem.
              </p>
            )}
            {history.meta.cursor && (
              <button
                className="button"
                disabled={busy}
                onClick={() => void load(history.meta.cursor)}
              >
                Starsze edycje
              </button>
            )}
          </>
        )}
        {selected && (
          <section className="cbe-result">
            <h3>Zapisana partia · {date(selected.created_at)}</h3>
            <p>
              Łącznie {selected.total}; zmieniono {selected.changed}; bez zmiany{' '}
              {selected.unchanged}. Wynik jest niezmienny i może różnić się od późniejszych danych
              produktu.
            </p>
            <ExecutionTable rows={rows} previewRows={previewRows} />
            <p>
              Wczytano {rows.length} z {selected.total} wierszy.
            </p>
            {cursor && (
              <button
                className="button"
                disabled={busy}
                onClick={() => void details(selected, cursor)}
              >
                Kolejne wiersze wykonania
              </button>
            )}
            <button className="button" disabled={busy} onClick={() => void details(selected)}>
              Odśwież ten trwały wynik
            </button>
            <details>
              <summary>Identyfikatory i hash zakresu</summary>
              <p className="cbe-technical">
                Wykonanie: {selected.id}
                <br />
                Podgląd: {selected.preview_id}
                <br />
                {selected.scope_hash}
              </p>
            </details>
          </section>
        )}
      </div>
    </section>
  );
}
