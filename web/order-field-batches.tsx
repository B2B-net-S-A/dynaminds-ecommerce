import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import type { OrderFieldChange } from '../server/order-fields-schema';
import './order-field-batches.css';

type Field = {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'radio' | 'multi_select' | 'date' | 'file';
  version: number;
  enabled: boolean;
  can_write?: boolean;
  write_role: 'operator' | 'admin';
  config: { scale?: number; min?: string; max?: string; max_length?: number };
  options: { id: string; label: string; enabled: boolean }[];
};
type Flags = { available: boolean; read_only: boolean; can_write?: boolean; current_role?: string };
type Row = {
  row_id: string;
  position: number;
  order_id: string | null;
  order_number: string | null;
  order_version: number | null;
  status: 'ready' | 'no_op' | 'invalid' | 'conflict';
  changes: OrderFieldChange[];
  before: unknown;
  after: unknown;
  skipped: unknown;
  issues: { code: string; message: string }[];
};
type Preview = Partial<Flags> & {
  definitions_snapshot?: Field[];
  id: string;
  kind: 'bulk' | 'csv';
  scope_hash: string;
  policy: Policy;
  expires_at: string;
  summary: { total: number; ready: number; no_op: number; invalid: number; conflict: number };
  data: Row[];
  meta: { cursor: string | null };
};
type Head = {
  id: string;
  kind?: string;
  state?: string;
  policy?: Policy;
  created_at?: string;
  expires_at?: string;
  selected_count?: number;
  summary?: Preview['summary'];
  error?: unknown;
  [key: string]: unknown;
};
type Execution = Partial<Flags> &
  Head & {
    data: (Row & { result: { changed: boolean; order_version: number } | null })[];
    meta?: { cursor: string | null };
  };
type History = Flags & { data: Head[]; meta: { cursor: string | null } };
type Policy = 'fill_unset' | 'replace';
type Order = {
  id: string;
  number: string;
  version: number | string;
  customer_name: string;
  status: string;
};
type ChangeDraft = { fieldId: string; operation: 'set' | 'clear'; value: string | string[] };
type Mapping = { fieldId: string; column: string };
type ExportResult = Partial<Flags> & {
  ui_scope?: string;
  filename: string;
  mime_type: string;
  content_base64: string;
  sha256: string;
  count: number;
  meta: { cursor: string | null };
  config?: unknown;
};
type Attempt = {
  path: string;
  body: unknown;
  title: string;
  success: (result: any) => void | Promise<void>;
};
const prefix = '/order-field-batches';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statusNames: Record<string, string> = {
  ready: 'Gotowy',
  no_op: 'Bez zmiany',
  invalid: 'Nieprawidłowy',
  conflict: 'Konflikt',
  queued: 'W kolejce',
  done: 'Zakończono',
  failed: 'Błąd',
  cancelled: 'Anulowano',
};
const types: Record<Field['type'], string> = {
  text: 'Tekst',
  number: 'Liczba',
  select: 'Lista wyboru',
  radio: 'Wybór pojedynczy',
  multi_select: 'Wiele opcji',
  date: 'Data',
  file: 'Prywatny plik',
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const privateError = (e: unknown) => e instanceof ApiError && [401, 403].includes(e.status);
const empty = (f: Field): string | string[] => (f.type === 'multi_select' ? [] : '');
function column(raw: string) {
  if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > 99)
    throw Error('Indeks kolumny musi być całkowitą liczbą od 0 do 99.');
  return Number(raw);
}
function orderVersion(raw: number | string) {
  if (!/^[1-9]\d*$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)))
    throw Error('Zamówienie nie ma poprawnej dodatniej wersji. Odczytaj je ponownie.');
  return Number(raw);
}
function valueChange(f: Field, d: ChangeDraft): OrderFieldChange {
  const base = { field_id: f.id, definition_version: f.version };
  if (d.operation === 'clear') return { ...base, operation: 'clear' };
  let v = structuredClone(d.value);
  if (f.type === 'multi_select') {
    if (!Array.isArray(v) || v.length > 50 || new Set(v).size !== v.length)
      throw Error(`${f.label}: wybierz do 50 różnych opcji.`);
    v = [...v].sort();
  } else if (typeof v !== 'string') throw Error(`${f.label}: nieprawidłowy typ wartości.`);
  if (
    f.type === 'text' &&
    typeof v === 'string' &&
    (v.includes('\0') ||
      Array.from(v).length > (f.config.max_length ?? 4000) ||
      new TextEncoder().encode(v).length > 16384)
  )
    throw Error(`${f.label}: tekst przekracza limit lub zawiera NUL.`);
  if (f.type === 'number' && typeof v === 'string') {
    const scale = f.config.scale ?? 0;
    const raw = v.trim().replace(',', '.');
    if (!/^-?\d+(?:\.\d+)?$/.test(raw))
      throw Error(`${f.label}: podaj liczbę dziesiętną bez wykładnika.`);
    const neg = raw.startsWith('-');
    const [wholeRaw, fractionRaw = ''] = (neg ? raw.slice(1) : raw).split('.');
    if (fractionRaw.length > scale)
      throw Error(`${f.label}: maksymalnie ${scale} miejsc po przecinku.`);
    const whole = wholeRaw.replace(/^0+(?=\d)/, '');
    const fraction = fractionRaw.padEnd(scale, '0');
    if (whole.length + fraction.length > 18) throw Error(`${f.label}: maksymalnie 18 cyfr.`);
    v = (neg && !/^0+$/.test(whole + fraction) ? '-' : '') + whole + (scale ? '.' + fraction : '');
    const n = BigInt(v.replace('.', ''));
    if (f.config.min !== undefined && n < BigInt(f.config.min.replace('.', '')))
      throw Error(`${f.label}: poniżej minimum.`);
    if (f.config.max !== undefined && n > BigInt(f.config.max.replace('.', '')))
      throw Error(`${f.label}: powyżej maksimum.`);
  }
  if (f.type === 'date' && typeof v === 'string') {
    const dt = new Date(v + 'T00:00:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      v.startsWith('0000') ||
      Number.isNaN(dt.getTime()) ||
      dt.toISOString().slice(0, 10) !== v
    )
      throw Error(`${f.label}: wybierz poprawną datę.`);
  }
  if (['select', 'radio', 'multi_select'].includes(f.type)) {
    const ids = Array.isArray(v) ? v : [v];
    if (ids.some((id) => !f.options.some((o) => o.id === id && o.enabled)))
      throw Error(`${f.label}: wybierz aktywną opcję.`);
  }
  if (f.type === 'file' && (typeof v !== 'string' || !uuid.test(v)))
    throw Error(`${f.label}: wpisz UUID istniejącego pliku należącego do tego zamówienia i pola.`);
  return { ...base, type: f.type, value: v } as OrderFieldChange;
}
function ValueControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: Field;
  value: string | string[];
  onChange: (v: string | string[]) => void;
  disabled: boolean;
}) {
  const options = field.options.filter((o) => o.enabled);
  if (field.type === 'multi_select')
    return (
      <div className="ofb-options">
        {options.map((o) => (
          <label key={o.id}>
            <input
              type="checkbox"
              disabled={
                disabled ||
                ((!Array.isArray(value) || !value.includes(o.id)) &&
                  Array.isArray(value) &&
                  value.length >= 50)
              }
              checked={Array.isArray(value) && value.includes(o.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...(Array.isArray(value) ? value : []), o.id]
                    : (Array.isArray(value) ? value : []).filter((id) => id !== o.id),
                )
              }
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  if (field.type === 'radio')
    return (
      <div className="ofb-options">
        {options.map((o) => (
          <label key={o.id}>
            <input
              type="radio"
              disabled={disabled}
              name={'ofb-' + field.id}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  if (field.type === 'select')
    return (
      <select disabled={disabled} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        <option value="">Wybierz opcję</option>
        {options.map((o) => (
          <option value={o.id} key={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    );
  if (field.type === 'text')
    return (
      <textarea
        disabled={disabled}
        value={String(value)}
        rows={2}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <input
      disabled={disabled}
      type={field.type === 'date' ? 'date' : 'text'}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      value={String(value)}
      placeholder={
        field.type === 'file'
          ? 'UUID własnego istniejącego pliku'
          : field.type === 'number'
            ? `Liczba, skala ${field.config.scale ?? 0}`
            : undefined
      }
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
function JsonEvidence({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="ofb-evidence">
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
type FrozenValue = {
  type: Field['type'];
  value: string | string[];
  options_snapshot?: { id: string; label: string }[];
  file?: { filename: string };
} | null;
function frozenText(value: FrozenValue) {
  if (value === null) return 'Nieustawione';
  if (value.type === 'file') return value.file?.filename ?? String(value.value);
  const label = (id: string) => value.options_snapshot?.find((o) => o.id === id)?.label ?? id;
  if (Array.isArray(value.value))
    return value.value.length ? value.value.map(label).join(', ') : 'Ustawiona pusta lista';
  if (['radio', 'select'].includes(value.type)) return label(value.value);
  return value.value === '' ? 'Ustawiony pusty tekst' : value.value;
}
function RowEvidence({ row, definitions }: { row: Row; definitions: Field[] }) {
  const before = (Array.isArray(row.before) ? row.before : []) as {
    field_id: string;
    value: FrozenValue;
  }[];
  const after = (Array.isArray(row.after) ? row.after : []) as {
    field_id: string;
    value: FrozenValue;
  }[];
  const skipped = (Array.isArray(row.skipped) ? row.skipped : []) as {
    field_id: string;
    reason: string;
  }[];
  const ids = [...new Set([...before, ...after, ...row.changes].map((v) => v.field_id))];
  const reasons: Record<string, string> = {
    protected_existing: 'Pominięto: wartość już ustawiona',
    unchanged: 'Wartość jest taka sama',
    already_unset: 'Pole już nieustawione',
  };
  return (
    <>
      <div className="ofb-table-wrap">
        <table className="ofb-values">
          <thead>
            <tr>
              <th>Pole</th>
              <th>Przed</th>
              <th>Po</th>
              <th>Wyjaśnienie</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => (
              <tr key={id}>
                <th>{definitions.find((d) => d.id === id)?.label ?? 'Pole z podglądu'}</th>
                <td>
                  {before.some((v) => v.field_id === id)
                    ? frozenText(before.find((v) => v.field_id === id)!.value)
                    : 'Brak dostępnego podglądu'}
                </td>
                <td>
                  {after.some((v) => v.field_id === id)
                    ? frozenText(after.find((v) => v.field_id === id)!.value)
                    : 'Brak dostępnego podglądu'}
                </td>
                <td>
                  {skipped
                    .filter((s) => s.field_id === id)
                    .map((s) => reasons[s.reason] ?? s.reason)
                    .join('; ') ||
                    (row.status === 'ready'
                      ? 'Zmiana w pokazanym zakresie'
                      : row.status === 'no_op'
                        ? 'Bez zmiany'
                        : 'Wiersz niegotowy')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <JsonEvidence
        title="Dokładne wartości, zmiany i pominięcia"
        value={{ before: row.before, after: row.after, changes: row.changes, skipped: row.skipped }}
      />
    </>
  );
}
function PolicyControl({
  value,
  onChange,
  disabled,
}: {
  value: Policy;
  onChange: (v: Policy) => void;
  disabled: boolean;
}) {
  return (
    <label>
      Sposób zapisu
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Policy)}
      >
        <option value="fill_unset">Uzupełnij wyłącznie nieustawione wartości</option>
        <option value="replace">Zastąp istniejące wartości lub wyczyść</option>
      </select>
      <small>
        Uzupełnianie chroni także zero, pusty tekst i pustą listę. Czyszczenie wymaga zastępowania.
      </small>
    </label>
  );
}

export function OrderFieldBatches({
  workspaceId,
  userId,
  role,
  readOnly,
  onError,
}: {
  workspaceId: string;
  userId: string;
  role: string;
  readOnly: boolean;
  onError: (m: string) => void;
}) {
  return (
    <OrderFieldBatchesSession
      key={`${workspaceId}:${userId}:${role}:${readOnly}`}
      workspaceId={workspaceId}
      role={role}
      readOnly={readOnly}
      onError={onError}
    />
  );
}
function OrderFieldBatchesSession({
  workspaceId,
  role,
  readOnly,
  onError,
}: {
  workspaceId: string;
  role: string;
  readOnly: boolean;
  onError: (m: string) => void;
}) {
  const [tab, setTab] = useState<'bulk' | 'csv' | 'export'>('bulk');
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [fields, setFields] = useState<Field[]>([]),
    [flags, setFlags] = useState<Flags | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<History | null>(null),
    [executions, setExecutions] = useState<History | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null),
    [execution, setExecution] = useState<Execution | null>(null),
    [rows, setRows] = useState<Row[]>([]);
  const [selectedRows, setSelectedRows] = useState<Record<string, Row>>({}),
    [consent, setConsent] = useState(false),
    [exceptionOnly, setExceptionOnly] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null),
    [retryConsent, setRetryConsent] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]),
    [orderCursor, setOrderCursor] = useState<string | null>(null),
    [orderSearch, setOrderSearch] = useState(''),
    [selectedOrders, setSelectedOrders] = useState<Record<string, Order>>({});
  const [policy, setPolicy] = useState<Policy>('fill_unset'),
    [changes, setChanges] = useState<ChangeDraft[]>([]);
  const [file, setFile] = useState<File | null>(null),
    [encoding, setEncoding] = useState('utf-8'),
    [delimiter, setDelimiter] = useState(';'),
    [identity, setIdentity] = useState<'order_id' | 'external_order_id'>('order_id'),
    [identityColumn, setIdentityColumn] = useState('0'),
    [versionColumn, setVersionColumn] = useState('1'),
    [channel, setChannel] = useState(''),
    [mappings, setMappings] = useState<Mapping[]>([]);
  const [exportFields, setExportFields] = useState<string[]>([]),
    [exportMode, setExportMode] = useState('csv_exact'),
    [exportScope, setExportScope] = useState<'all' | 'selected'>('selected'),
    [exportLimit, setExportLimit] = useState('100'),
    [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const alive = useRef(true),
    epoch = useRef(0),
    pending = useRef<Attempt | null>(null),
    sending = useRef(false),
    viewEpoch = useRef(0),
    orderEpoch = useRef(0);
  const canWrite =
    !!flags?.available &&
    !readOnly &&
    !flags.read_only &&
    flags.can_write === true &&
    ['operator', 'admin'].includes(flags.current_role ?? role);
  const locked = busy || !!attempt || !canWrite;
  const readable = !!flags?.available;
  const scope = JSON.stringify({
    id: preview?.id,
    hash: preview?.scope_hash,
    policy: preview?.policy,
    ids: Object.keys(selectedRows).sort(),
  });
  const exportScopeKey = JSON.stringify({
    fields: exportFields,
    mode: exportMode,
    scope: exportScope,
    limit: exportLimit,
    orders: Object.keys(selectedOrders).sort(),
  });
  useEffect(() => setConsent(false), [scope, canWrite]);
  useEffect(
    () => setConsent(false),
    [
      selectedOrders,
      changes,
      policy,
      file,
      encoding,
      delimiter,
      identity,
      identityColumn,
      versionColumn,
      channel,
      mappings,
    ],
  );
  useEffect(() => setRetryConsent(false), [attempt]);
  useEffect(() => {
    setExportResult(null);
  }, [exportFields, exportMode, exportScope, exportLimit, selectedOrders]);
  useEffect(() => {
    alive.current = true;
    void metadata();
    return () => {
      alive.current = false;
      epoch.current++;
      viewEpoch.current++;
      orderEpoch.current++;
      pending.current = null;
    };
  }, []);
  function clearPrivate() {
    epoch.current++;
    viewEpoch.current++;
    orderEpoch.current++;
    pending.current = null;
    setBusy(false);
    setChannels([]);
    setFields([]);
    setFlags(null);
    setPreviews(null);
    setExecutions(null);
    setPreview(null);
    setExecution(null);
    setRows([]);
    setSelectedRows({});
    setSelectedOrders({});
    setOrders([]);
    setChanges([]);
    setMappings([]);
    setFile(null);
    setExportFields([]);
    setExportResult(null);
    setAttempt(null);
    setConsent(false);
  }
  function fail(e: unknown) {
    if (!alive.current) return;
    if (privateError(e)) clearPrivate();
    if (e instanceof ApiError && e.status === 423)
      setFlags((f) => (f ? { ...f, read_only: true, can_write: false } : f));
    setError(message(e));
    onError(message(e));
  }
  function acceptFlags(data: Partial<Flags>) {
    if (data.current_role && data.current_role !== role) {
      clearPrivate();
      const text = 'Uprawnienia konta zmieniły się. Odśwież sesję przed dalszą pracą.';
      setError(text);
      onError(text);
      throw Error(text);
    }
    if (typeof data.available === 'boolean') setFlags((old) => ({ ...old, ...data }) as Flags);
  }
  async function metadata() {
    if (pending.current) return;
    const e = ++epoch.current;
    viewEpoch.current++;
    orderEpoch.current++;
    setFlags(null);
    setFields([]);
    setChannels([]);
    setPreviews(null);
    setExecutions(null);
    setPreview(null);
    setExecution(null);
    setRows([]);
    setSelectedRows({});
    setOrders([]);
    setSelectedOrders({});
    setChanges([]);
    setMappings([]);
    setExportFields([]);
    setExportResult(null);
    setConsent(false);
    setBusy(true);
    setError('');
    try {
      const meta = await api<
        Flags & { definitions: Field[]; channels: { id: string; name: string }[] }
      >(prefix);
      if (!alive.current || e !== epoch.current) return;
      acceptFlags(meta);
      if (!meta.available) {
        setFields([]);
        setChannels([]);
        return;
      }
      setFields(
        meta.definitions.map((f) => ({
          ...f,
          can_write:
            f.enabled &&
            (meta.current_role === 'admin' ||
              (meta.current_role === 'operator' && f.write_role === 'operator')),
        })),
      );
      setChannels(meta.channels);
      const list = await api<History>(prefix + '/previews');
      if (!alive.current || e !== epoch.current) return;
      acceptFlags(list);
      setPreviews(list);
      const history = await api<History>(prefix + '/executions');
      if (!alive.current || e !== epoch.current) return;
      acceptFlags(history);
      setExecutions(history);
    } catch (err) {
      if (alive.current && e === epoch.current) fail(err);
    } finally {
      if (alive.current && e === epoch.current) setBusy(false);
    }
  }
  async function mutate(a: Attempt, retry = false) {
    if (!canWrite || sending.current || (!retry && pending.current)) return;
    const frozen = retry ? pending.current : { ...a, body: structuredClone(a.body) };
    if (!frozen) return;
    pending.current = frozen;
    setAttempt(frozen);
    sending.current = true;
    setBusy(true);
    setError('');
    const e = epoch.current;
    let succeeded = false;
    try {
      const result = await api(frozen.path, 'POST', frozen.body);
      succeeded = true;
      if (!alive.current || e !== epoch.current) return;
      pending.current = null;
      setAttempt(null);
      await frozen.success(result);
    } catch (err) {
      if (!alive.current || e !== epoch.current) return;
      if (!succeeded && err instanceof ApiError && [409, 422, 423].includes(err.status)) {
        pending.current = null;
        setAttempt(null);
      }
      fail(err);
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function loadPreview(id: string, cursor?: string, append = false) {
    if (pending.current) return;
    const e = ++viewEpoch.current;
    setBusy(true);
    setError('');
    if (!append) {
      setPreview(null);
      setRows([]);
      setSelectedRows({});
      setExecution(null);
    }
    try {
      const p = await api<Preview>(
        prefix +
          '/previews/' +
          encodeURIComponent(id) +
          (cursor ? '?' + new URLSearchParams({ cursor }) : ''),
      );
      if (!alive.current || e !== viewEpoch.current) return;
      acceptFlags(p);
      setPreview(p);
      setRows(p.data);
    } catch (err) {
      if (alive.current && e === viewEpoch.current) fail(err);
    } finally {
      if (alive.current && e === viewEpoch.current) setBusy(false);
    }
  }
  async function loadExecution(id: string) {
    if (pending.current) return;
    const e = ++viewEpoch.current;
    setBusy(true);
    setError('');
    try {
      const detail = await api<Execution>(prefix + '/executions/' + encodeURIComponent(id));
      if (!alive.current || e !== viewEpoch.current) return;
      acceptFlags(detail);
      setExecution(detail);
      setPreview(null);
      setRows([]);
      setSelectedRows({});
    } catch (err) {
      if (alive.current && e === viewEpoch.current) fail(err);
    } finally {
      if (alive.current && e === viewEpoch.current) setBusy(false);
    }
  }
  async function history(kind: 'previews' | 'executions', cursor?: string) {
    if (pending.current) return;
    const e = epoch.current;
    setBusy(true);
    setError('');
    try {
      const data = await api<History>(
        prefix + '/' + kind + (cursor ? '?' + new URLSearchParams({ cursor }) : ''),
      );
      if (!alive.current || e !== epoch.current) return;
      acceptFlags(data);
      if (kind === 'previews') setPreviews(data);
      else setExecutions(data);
    } catch (err) {
      if (alive.current && e === epoch.current) fail(err);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function loadOrders(cursor?: string) {
    if (pending.current) return;
    const e = ++orderEpoch.current;
    setBusy(true);
    setError('');
    try {
      const data = await api<{ data: Order[]; meta: { cursor: string | null } }>(
        '/orders?' +
          new URLSearchParams({
            limit: '50',
            ...(orderSearch ? { search: orderSearch } : {}),
            ...(cursor ? { after: cursor } : {}),
          }),
      );
      if (!alive.current || e !== orderEpoch.current) return;
      setOrders(data.data);
      setOrderCursor(data.meta.cursor);
    } catch (err) {
      if (alive.current && e === orderEpoch.current) fail(err);
    } finally {
      if (alive.current && e === orderEpoch.current) setBusy(false);
    }
  }
  async function createPreview() {
    try {
      let body: unknown;
      if (tab === 'bulk') {
        const chosen = Object.values(selectedOrders);
        if (!chosen.length || chosen.length > 100) throw Error('Wybierz od 1 do 100 zamówień.');
        if (!changes.length || changes.length > 20) throw Error('Dodaj od 1 do 20 zmian pól.');
        if (new Set(changes.map((c) => c.fieldId)).size !== changes.length)
          throw Error('Każde pole może wystąpić w zmianach tylko raz.');
        if (policy !== 'replace' && changes.some((c) => c.operation === 'clear'))
          throw Error('Czyszczenie wymaga jawnego trybu zastępowania.');
        const prepared = changes.map((c) => {
          const f = fields.find((f) => f.id === c.fieldId && f.enabled && f.can_write);
          if (!f) throw Error('Wybrane pole nie jest obecnie dostępne do zapisu.');
          return valueChange(f, c);
        });
        body = {
          client_key: crypto.randomUUID(),
          kind: 'bulk',
          policy,
          orders: chosen.map((o) => ({ order_id: o.id, order_version: orderVersion(o.version) })),
          changes: prepared,
        };
      } else {
        if (!file || file.size < 1 || file.size > 5 * 1024 * 1024)
          throw Error('Wybierz plik CSV od 1 bajtu do 5 MiB.');
        if (file.name.length > 120 || /[\/\\\x00-\x1f\x7f]/.test(file.name))
          throw Error(
            'Nazwa pliku musi mieć do 120 znaków, bez separatorów ścieżki i znaków sterujących.',
          );
        if (
          !mappings.length ||
          mappings.length > 20 ||
          new Set(mappings.map((m) => m.fieldId)).size !== mappings.length
        )
          throw Error('Mapuj od 1 do 20 różnych pól.');
        const mapped = mappings.map((m) => {
          const f = fields.find((f) => f.id === m.fieldId && f.enabled && f.can_write);
          if (!f) throw Error('Mapowane pole nie jest dostępne do zapisu.');
          return { column: column(m.column), field_id: f.id, definition_version: f.version };
        });
        const ic = column(identityColumn),
          vc = column(versionColumn);
        const cols = [ic, vc, ...mapped.map((m) => m.column)];
        if (new Set(cols).size !== cols.length)
          throw Error('Kolumny tożsamości, wersji oraz pól muszą być różne.');
        if (identity === 'external_order_id' && !uuid.test(channel))
          throw Error('Podaj UUID własnego kanału dla zewnętrznego numeru zamówienia.');
        const e = epoch.current;
        setBusy(true);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!alive.current || e !== epoch.current) return;
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768)
          binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        body = {
          client_key: crypto.randomUUID(),
          kind: 'csv',
          policy,
          filename: file.name,
          content_base64: btoa(binary),
          config: {
            encoding,
            delimiter,
            header: true,
            identity:
              identity === 'order_id'
                ? { kind: identity, column: ic }
                : { kind: identity, channel_id: channel, column: ic },
            order_version_column: vc,
            fields: mapped,
          },
        };
        setBusy(false);
      }
      await mutate({
        path: prefix + '/previews',
        body,
        title: 'Utworzenie niezmiennego podglądu',
        success: (p) => {
          acceptFlags(p);
          setPreview(p);
          setRows(p.data);
          setSelectedRows({});
          setExecution(null);
          setConsent(false);
        },
      });
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }
  async function queue() {
    if (!preview || !consent) return;
    const ids = Object.keys(selectedRows).sort();
    if (!ids.length || ids.length > 100) {
      fail(Error('Wybierz od 1 do 100 gotowych wierszy.'));
      return;
    }
    await mutate({
      path: prefix + '/previews/' + preview.id + '/queue',
      body: {
        client_key: crypto.randomUUID(),
        selected_rows: ids,
        consent: {
          scope_hash: preview.scope_hash,
          selected_count: ids.length,
          policy: preview.policy,
          local_only: true,
        },
      },
      title: 'Zatwierdzenie dokładnie wybranych wierszy',
      success: async (result) => {
        setConsent(false);
        setSelectedRows({});
        await loadExecution(result.execution.id);
      },
    });
  }
  async function exportPage(cursor?: string) {
    if (!readable || pending.current || busy) return;
    const e = epoch.current;
    setBusy(true);
    setError('');
    try {
      if (cursor && exportResult?.ui_scope !== exportScopeKey)
        throw Error(
          'Zakres eksportu zmienił się. Pobierz najpierw pierwszą stronę nowego zakresu.',
        );
      if (!exportFields.length || exportFields.length > 20)
        throw Error('Wybierz od 1 do 20 pól eksportu.');
      if (!/^[1-9]\d*$/.test(exportLimit) || Number(exportLimit) > 500)
        throw Error('Strona eksportu musi zawierać od 1 do 500 zamówień.');
      const ids = Object.keys(selectedOrders).sort();
      if (exportScope === 'selected' && (!ids.length || ids.length > 100))
        throw Error('Dla tego eksportu wybierz od 1 do 100 zamówień w zakładce operacji masowych.');
      const result = await api<ExportResult>(
        prefix +
          '/export?' +
          new URLSearchParams({
            field_ids: JSON.stringify(exportFields),
            mode: exportMode,
            limit: exportLimit,
            ...(exportScope === 'selected' ? { order_ids: JSON.stringify(ids) } : {}),
            ...(cursor ? { cursor } : {}),
          }),
      );
      if (!alive.current || e !== epoch.current) return;
      acceptFlags(result);
      const binary = atob(result.content_base64),
        bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.mime_type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExportResult({ ...result, ui_scope: exportScopeKey });
    } catch (err) {
      if (alive.current && e === epoch.current) fail(err);
    } finally {
      if (alive.current && e === epoch.current) setBusy(false);
    }
  }
  const writableFields = fields.filter((f) => f.enabled && f.can_write);
  const visibleRows = exceptionOnly
    ? rows.filter((r) => ['invalid', 'conflict'].includes(r.status))
    : rows;
  return (
    <div className="order-field-batches">
      <section className="panel ofb-panel">
        <div className="panel-heading">
          <div>
            <h2>Pola — import i operacje</h2>
            <p>
              Zmiany wyłącznie w lokalnych polach zamówień. Bez tworzenia zamówień i wysyłania do
              kanałów.
            </p>
          </div>
          <button className="button" disabled={busy || !!attempt} onClick={() => void metadata()}>
            Odśwież dostępność
          </button>
        </div>
        {error && (
          <p className="ofb-error" role="alert">
            {error}
          </p>
        )}
        {!flags ? (
          <p>Wczytywanie dostępności modułu…</p>
        ) : !flags.available ? (
          <p>Ten moduł nie jest dostępny w tej kopii aplikacji.</p>
        ) : (
          <>
            {!canWrite && (
              <p className="notice">
                {readOnly || flags.read_only
                  ? 'Kopia tylko do odczytu: historia i lokalny eksport pozostają dostępne.'
                  : 'Dostęp tylko do odczytu. Zmiany wymagają aktualnej roli operatora lub administratora.'}
              </p>
            )}
            <div className="ofb-tabs">
              {(
                [
                  ['bulk', 'Zmiany masowe'],
                  ['csv', 'Import CSV'],
                  ['export', 'Eksport'],
                ] as const
              ).map(([id, label]) => (
                <button
                  className={'button ' + (tab === id ? 'primary' : '')}
                  key={id}
                  disabled={busy || !!attempt}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === 'bulk' && (
              <>
                <h3>1. Wybierz zamówienia i wspólne zmiany</h3>
                <p>
                  Zaznaczenia są jawne i zachowane między stronami. Limit jednej operacji: 100
                  zamówień.
                </p>
                <div className="ofb-toolbar">
                  <input
                    value={orderSearch}
                    disabled={busy || !!attempt}
                    onChange={(e) => {
                      setOrderSearch(e.target.value);
                      setOrderCursor(null);
                    }}
                    placeholder="Numer, klient lub e-mail"
                    aria-label="Szukaj zamówień do operacji"
                  />
                  <button
                    className="button"
                    disabled={busy || !!attempt}
                    onClick={() => void loadOrders()}
                  >
                    Wczytaj zamówienia
                  </button>
                  {orderCursor && (
                    <button
                      className="button"
                      disabled={busy || !!attempt}
                      onClick={() => void loadOrders(orderCursor)}
                    >
                      Następna strona zamówień
                    </button>
                  )}
                </div>
                <div className="ofb-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Wybór</th>
                        <th>Zamówienie</th>
                        <th>Klient</th>
                        <th>Wersja</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((o) => (
                        <tr key={o.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={'Wybierz ' + o.number}
                              checked={!!selectedOrders[o.id]}
                              disabled={
                                busy ||
                                !!attempt ||
                                (!selectedOrders[o.id] && Object.keys(selectedOrders).length >= 100)
                              }
                              onChange={(e) =>
                                setSelectedOrders((old) => {
                                  const copy = { ...old };
                                  if (e.target.checked) copy[o.id] = o;
                                  else delete copy[o.id];
                                  return copy;
                                })
                              }
                            />
                          </td>
                          <td>{o.number}</td>
                          <td>{o.customer_name}</td>
                          <td>{o.version}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details>
                  <summary>Wybrane zamówienia: {Object.keys(selectedOrders).length}/100</summary>
                  <ul>
                    {Object.values(selectedOrders).map((o) => (
                      <li key={o.id}>
                        {o.number}, wersja {o.version}{' '}
                        <button
                          className="button"
                          disabled={busy || !!attempt}
                          onClick={() =>
                            setSelectedOrders((old) => {
                              const copy = { ...old };
                              delete copy[o.id];
                              return copy;
                            })
                          }
                        >
                          Usuń z wyboru
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
                <PolicyControl value={policy} disabled={locked} onChange={setPolicy} />
                {changes.map((c, i) => {
                  const f = fields.find((f) => f.id === c.fieldId);
                  return (
                    <fieldset key={c.fieldId} className="ofb-change" disabled={locked}>
                      <legend>{f?.label ?? 'Niedostępne pole'}</legend>
                      <label>
                        Operacja
                        <select
                          value={c.operation}
                          onChange={(e) =>
                            setChanges((old) =>
                              old.map((d, j) =>
                                j === i
                                  ? { ...d, operation: e.target.value as 'set' | 'clear' }
                                  : d,
                              ),
                            )
                          }
                        >
                          <option value="set">Ustaw wartość</option>
                          <option value="clear" disabled={policy !== 'replace'}>
                            Wyczyść wartość
                          </option>
                        </select>
                      </label>
                      {f && c.operation === 'set' && (
                        <ValueControl
                          field={f}
                          value={c.value}
                          disabled={locked}
                          onChange={(v) =>
                            setChanges((old) =>
                              old.map((d, j) => (j === i ? { ...d, value: v } : d)),
                            )
                          }
                        />
                      )}
                      {f?.type === 'file' && (
                        <p className="ofb-help">
                          To przypisanie istniejącego własnego pliku, bez przesyłania bajtów. Ten
                          sam UUID nie będzie poprawny dla różnych zamówień.
                        </p>
                      )}
                      <button
                        className="button"
                        onClick={() => setChanges((old) => old.filter((_, j) => j !== i))}
                      >
                        Usuń zmianę
                      </button>
                    </fieldset>
                  );
                })}
                <label>
                  Dodaj pole do zmian
                  <select
                    value=""
                    disabled={locked || changes.length >= 20}
                    onChange={(e) => {
                      const f = fields.find((f) => f.id === e.target.value);
                      if (f)
                        setChanges((old) => [
                          ...old,
                          { fieldId: f.id, operation: 'set', value: empty(f) },
                        ]);
                    }}
                  >
                    <option value="">Wybierz pole ({changes.length}/20)</option>
                    {writableFields
                      .filter((f) => !changes.some((c) => c.fieldId === f.id))
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label} — {types[f.type]}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="button primary"
                  disabled={locked}
                  onClick={() => void createPreview()}
                >
                  Utwórz podgląd zmian
                </button>
              </>
            )}
            {tab === 'csv' && (
              <>
                <h3>1. Plik i jawne mapowanie kolumn</h3>
                <p>
                  CSV do 5 MiB i 5000 wierszy. Nagłówek obowiązkowy; indeksy kolumn od 0. Import nie
                  dopasowuje po nazwisku ani kwocie.
                </p>
                <fieldset disabled={locked} className="ofb-inputs">
                  <label>
                    Plik CSV
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <PolicyControl value={policy} disabled={locked} onChange={setPolicy} />
                  <div className="ofb-grid">
                    <label>
                      Kodowanie
                      <select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
                        <option value="utf-8">UTF-8</option>
                        <option value="windows-1250">Windows-1250</option>
                      </select>
                    </label>
                    <label>
                      Separator
                      <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                        <option value=";">Średnik</option>
                        <option value=",">Przecinek</option>
                        <option value={'\t'}>Tabulator</option>
                        <option value="|">Pionowa kreska</option>
                      </select>
                    </label>
                    <label>
                      Identyfikacja
                      <select
                        value={identity}
                        onChange={(e) => setIdentity(e.target.value as typeof identity)}
                      >
                        <option value="order_id">Własny UUID zamówienia</option>
                        <option value="external_order_id">Dokładny ID zamówienia w kanale</option>
                      </select>
                    </label>
                    {identity === 'external_order_id' && (
                      <label>
                        Własny kanał
                        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                          <option value="">Wybierz dokładny kanał</option>
                          {channels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label>
                      Kolumna identyfikatora
                      <input
                        value={identityColumn}
                        onChange={(e) => setIdentityColumn(e.target.value)}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      Kolumna wersji zamówienia
                      <input
                        value={versionColumn}
                        onChange={(e) => setVersionColumn(e.target.value)}
                        inputMode="numeric"
                      />
                    </label>
                  </div>
                  {mappings.map((m, i) => (
                    <div className="ofb-mapping" key={m.fieldId}>
                      <span>
                        {fields.find((f) => f.id === m.fieldId)?.label ?? 'Niedostępne pole'}
                      </span>
                      <label>
                        Kolumna
                        <input
                          value={m.column}
                          inputMode="numeric"
                          onChange={(e) =>
                            setMappings((old) =>
                              old.map((v, j) => (j === i ? { ...v, column: e.target.value } : v)),
                            )
                          }
                        />
                      </label>
                      <button
                        className="button"
                        onClick={() => setMappings((old) => old.filter((_, j) => i !== j))}
                      >
                        Usuń mapowanie
                      </button>
                    </div>
                  ))}
                  <label>
                    Mapuj dodatkowe pole
                    <select
                      value=""
                      disabled={mappings.length >= 20}
                      onChange={(e) => {
                        if (e.target.value)
                          setMappings((old) => [...old, { fieldId: e.target.value, column: '' }]);
                      }}
                    >
                      <option value="">Wybierz pole ({mappings.length}/20)</option>
                      {writableFields
                        .filter((f) => !mappings.some((m) => m.fieldId === f.id))
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label} — {types[f.type]}
                          </option>
                        ))}
                    </select>
                  </label>
                </fieldset>
                <details className="ofb-help">
                  <summary>Format komórki: ustawienie i czyszczenie</summary>
                  <p>
                    Każda mapowana komórka zawiera ścisły JSON. Pusta komórka nie jest domyślnie
                    pomijana.
                  </p>
                  <pre>
                    {
                      '{"operation":"set","value":"Tekst"}\n{"operation":"set","value":"12.30"}\n{"operation":"set","value":[]}\n{"operation":"clear"}'
                    }
                  </pre>
                  <p>
                    W pliku CSV cudzysłowy wewnątrz cytowanej komórki podwaja się. Eksport CSV
                    dokładny przygotowuje taki format automatycznie. Czyszczenie wymaga polityki
                    zastępowania.
                  </p>
                </details>
                <button
                  className="button primary"
                  disabled={locked || !file}
                  onClick={() => void createPreview()}
                >
                  Wczytaj plik i utwórz podgląd
                </button>
              </>
            )}
            {tab === 'export' && (
              <>
                <h3>Lokalny eksport — jawny zakres</h3>
                <p>
                  Każda pobrana strona jest osobnym snapshotem odczytu. Eksport nie zmienia
                  zamówień.
                </p>
                <fieldset disabled={busy || !!attempt} className="ofb-inputs">
                  <div className="ofb-grid">
                    <label>
                      Format
                      <select value={exportMode} onChange={(e) => setExportMode(e.target.value)}>
                        <option value="csv_exact">CSV dokładny — do ponownego importu</option>
                        <option value="csv_sheet">
                          CSV do arkusza — czytelny, bezstratny import niedostępny
                        </option>
                        <option value="json">JSON — wartości i metadane</option>
                      </select>
                    </label>
                    <label>
                      Zakres zamówień
                      <select
                        value={exportScope}
                        onChange={(e) => setExportScope(e.target.value as typeof exportScope)}
                      >
                        <option value="selected">
                          Jawnie wybrane ({Object.keys(selectedOrders).length}/100)
                        </option>
                        <option value="all">Wszystkie własne zamówienia, strona po stronie</option>
                      </select>
                    </label>
                    <label>
                      Limit strony (1–500)
                      <input
                        inputMode="numeric"
                        value={exportLimit}
                        onChange={(e) => setExportLimit(e.target.value)}
                      />
                    </label>
                  </div>
                  <p>Pola w kolejności eksportu: {exportFields.length}/20</p>
                  <div className="ofb-options">
                    {fields.map((f) => (
                      <label key={f.id}>
                        <input
                          type="checkbox"
                          checked={exportFields.includes(f.id)}
                          disabled={!exportFields.includes(f.id) && exportFields.length >= 20}
                          onChange={(e) =>
                            setExportFields((old) =>
                              e.target.checked ? [...old, f.id] : old.filter((id) => id !== f.id),
                            )
                          }
                        />
                        {f.label}
                        {!f.enabled ? ' (pole wyłączone)' : ''}
                      </label>
                    ))}
                  </div>
                  <ol>
                    {exportFields.map((id, i) => (
                      <li key={id}>
                        {fields.find((f) => f.id === id)?.label}
                        <button
                          className="button"
                          disabled={!i}
                          onClick={() =>
                            setExportFields((old) => {
                              const a = [...old];
                              [a[i - 1], a[i]] = [a[i], a[i - 1]];
                              return a;
                            })
                          }
                        >
                          Wyżej
                        </button>
                      </li>
                    ))}
                  </ol>
                </fieldset>
                <button
                  className="button primary"
                  disabled={busy || !!attempt || !exportFields.length}
                  onClick={() => void exportPage()}
                >
                  Pobierz pierwszą stronę
                </button>
                {exportResult && (
                  <div className="ofb-export-result">
                    <p>
                      Pobrano {exportResult.count} zamówień: {exportResult.filename}
                    </p>
                    {exportResult.meta.cursor && (
                      <button
                        className="button"
                        disabled={busy || !!attempt}
                        onClick={() => void exportPage(exportResult.meta.cursor!)}
                      >
                        Pobierz następną stronę
                      </button>
                    )}
                    <JsonEvidence
                      title="Hash pliku i mapowanie dokładnego CSV"
                      value={{ sha256: exportResult.sha256, config: exportResult.config }}
                    />
                  </div>
                )}
                <p className="ofb-help">
                  CSV do arkusza neutralizuje formuły i służy do czytania. Pliki prywatne są
                  reprezentowane UUID oraz metadanymi, bez treści i publicznych linków.
                </p>
              </>
            )}
          </>
        )}
      </section>
      {attempt && (
        <section className="panel ofb-panel">
          <h3>
            {attempt.title}: {busy ? 'trwa próba' : 'odpowiedź niepewna'}
          </h3>
          <p>
            Treść i klucz tej próby pozostają zamrożone. Ponowienie używa dokładnie tej samej
            treści; nie tworzy nowego zakresu.
          </p>
          <JsonEvidence
            title="Dokładna treść próby (bez bajtów CSV)"
            value={
              typeof attempt.body === 'object' && attempt.body !== null
                ? {
                    ...attempt.body,
                    ...('content_base64' in attempt.body
                      ? {
                          content_base64:
                            '[bajty pliku przechowywane wyłącznie w pamięci tej próby]',
                        }
                      : {}),
                  }
                : attempt.body
            }
          />
          <label className="ofb-check">
            <input
              type="checkbox"
              disabled={busy || !canWrite}
              checked={retryConsent}
              onChange={(e) => setRetryConsent(e.target.checked)}
            />
            Sprawdziłem niezmienny zakres i chcę ponowić tę samą próbę.
          </label>
          <button
            className="button primary"
            disabled={busy || !canWrite || !retryConsent}
            onClick={() => void mutate(attempt, true)}
          >
            Ponów dokładnie tę próbę
          </button>
          <p>
            Zamknięcie panelu porzuca jedynie lokalną pamięć próby. Nie anuluje skutku, który mógł
            już zostać zatwierdzony.
          </p>
        </section>
      )}
      {preview && (
        <section className="panel ofb-panel">
          <div className="panel-heading">
            <div>
              <h2>2. Podgląd i dokładny wybór</h2>
              <p>
                {preview.kind === 'csv' ? 'Import CSV' : 'Zmiany masowe'} ·{' '}
                {preview.policy === 'fill_unset'
                  ? 'uzupełnianie nieustawionych'
                  : 'zastępowanie / czyszczenie'}{' '}
                · ważny do {date(preview.expires_at)}
              </p>
            </div>
            <button
              className="button"
              disabled={busy || !!attempt}
              onClick={() => void loadPreview(preview.id)}
            >
              Odczytaj ponownie / wyczyść wybór
            </button>
          </div>
          <div className="ofb-summary">
            {Object.entries(preview.summary).map(([k, v]) => (
              <span key={k}>
                {(
                  {
                    total: 'Wiersze',
                    ready: 'Gotowe',
                    no_op: 'Bez zmiany',
                    invalid: 'Błędne',
                    conflict: 'Konflikty',
                  } as Record<string, string>
                )[k] ?? k}
                : <strong>{v}</strong>
              </span>
            ))}
          </div>
          <label className="ofb-check">
            <input
              type="checkbox"
              checked={exceptionOnly}
              onChange={(e) => setExceptionOnly(e.target.checked)}
            />
            Pokaż wyłącznie błędy i konflikty na bieżącej stronie
          </label>
          <p>
            Ten podgląd jest niezmienny. Edycja szkicu powyżej wymaga utworzenia nowego podglądu,
            aby zastosować nowe dane.
          </p>
          <p>
            Bieżąca strona: {rows.length} wierszy z {preview.summary.total} łącznie. Wybrano{' '}
            {Object.keys(selectedRows).length}/100.
          </p>
          {visibleRows.map((r) => (
            <article className="ofb-row" key={r.row_id}>
              <div className="ofb-row-title">
                <label>
                  <input
                    type="checkbox"
                    checked={!!selectedRows[r.row_id]}
                    disabled={
                      locked ||
                      !['ready', 'no_op'].includes(r.status) ||
                      (!selectedRows[r.row_id] && Object.keys(selectedRows).length >= 100)
                    }
                    onChange={(e) =>
                      setSelectedRows((old) => {
                        const copy = { ...old };
                        if (e.target.checked) copy[r.row_id] = r;
                        else delete copy[r.row_id];
                        return copy;
                      })
                    }
                  />
                  Wiersz {r.position + 1}: {r.order_number ?? 'Niedopasowane zamówienie'}
                </label>
                <strong>{statusNames[r.status]}</strong>
              </div>
              {r.issues.map((issue, i) => (
                <p className="ofb-error" key={i}>
                  {issue.message} <small>({issue.code})</small>
                </p>
              ))}
              <RowEvidence row={r} definitions={preview.definitions_snapshot ?? fields} />
              <JsonEvidence
                title="Identyfikatory i wersja tego wiersza"
                value={{ row_id: r.row_id, order_id: r.order_id, order_version: r.order_version }}
              />
            </article>
          ))}
          {preview.meta.cursor && (
            <button
              className="button"
              disabled={busy || !!attempt}
              onClick={() => void loadPreview(preview.id, preview.meta.cursor!, true)}
            >
              Przejdź do kolejnych 50 wierszy (zachowaj wybór)
            </button>
          )}
          <h3>3. Zgoda na lokalny zapis wybranych wierszy</h3>
          <details open>
            <summary>Dokładny zakres: {Object.keys(selectedRows).length} wierszy</summary>
            <ul>
              {Object.values(selectedRows).map((r) => (
                <li key={r.row_id}>
                  {r.order_number ?? r.order_id} · wersja {r.order_version} ·{' '}
                  {statusNames[r.status]}
                  <button
                    className="button"
                    disabled={locked}
                    onClick={() =>
                      setSelectedRows((old) => {
                        const copy = { ...old };
                        delete copy[r.row_id];
                        return copy;
                      })
                    }
                  >
                    Usuń z wyboru
                  </button>
                  <details>
                    <summary>Sprawdź wartości tego wybranego wiersza</summary>
                    <RowEvidence row={r} definitions={preview.definitions_snapshot ?? fields} />
                  </details>
                </li>
              ))}
            </ul>
          </details>
          <JsonEvidence
            title="Niezmienny hash podglądu i dokładne ID wyboru"
            value={{
              scope_hash: preview.scope_hash,
              selected_rows: Object.keys(selectedRows).sort(),
              policy: preview.policy,
            }}
          />
          <label className="ofb-check">
            <input
              type="checkbox"
              checked={consent}
              disabled={locked || !Object.keys(selectedRows).length}
              onChange={(e) => setConsent(e.target.checked)}
            />
            Zatwierdzam dokładnie te {Object.keys(selectedRows).length} wierszy i pokazane zmiany{' '}
            {preview.policy === 'replace'
              ? 'z zastąpieniem lub czyszczeniem istniejących wartości'
              : 'wyłącznie w nieustawionych polach'}
            . Zapis wyłącznie lokalny.
          </label>
          <p>
            Wybrane wiersze są jednym atomowym wykonaniem. Konflikt któregokolwiek cofa cały ten
            zakres. Inne wykonania importu są odrębnymi transakcjami.
          </p>
          <button
            className="button primary"
            disabled={
              locked ||
              !consent ||
              !Object.keys(selectedRows).length ||
              new Date(preview.expires_at).getTime() <= Date.now()
            }
            onClick={() => void queue()}
          >
            Zatwierdź i dodaj wybrane wiersze do kolejki
          </button>
        </section>
      )}
      {execution && (
        <section className="panel ofb-panel">
          <div className="panel-heading">
            <div>
              <h2>Wynik wykonania</h2>
              <p>
                {statusNames[String(execution.state)] ?? String(execution.state)} · wybrane wiersze:{' '}
                {execution.selected_count ?? 'patrz zakres'}
              </p>
            </div>
            <button
              className="button"
              disabled={busy || !!attempt}
              onClick={() => void loadExecution(execution.id)}
            >
              Odczytaj stan
            </button>
          </div>
          {!!execution.error && (
            <p className="ofb-error">
              {typeof execution.error === 'string'
                ? execution.error
                : JSON.stringify(execution.error)}
            </p>
          )}
          <div className="ofb-execution-rows">
            {execution.data.map((r) => (
              <article className="ofb-row" key={r.row_id}>
                <h3>{r.order_number ?? 'Niedostępny numer'}</h3>
                <p>
                  {r.result
                    ? r.result.changed
                      ? 'Zapisano zmiany'
                      : 'Bez zmiany wartości'
                    : execution.state === 'queued'
                      ? 'Oczekuje na zatwierdzenie'
                      : 'Brak zatwierdzonego skutku'}
                  {r.result ? ` · wersja zamówienia po operacji: ${r.result.order_version}` : ''}
                </p>
                <RowEvidence row={r} definitions={fields} />
              </article>
            ))}
          </div>
          <JsonEvidence title="Techniczne dowody wykonania i zgoda" value={execution} />
          {execution.state === 'queued' && (
            <button
              className="button"
              disabled={locked}
              onClick={() =>
                void mutate({
                  path: prefix + '/executions/' + execution.id + '/cancel',
                  body: {},
                  title: 'Anulowanie wykonania przed zapisem',
                  success: () => loadExecution(execution.id),
                })
              }
            >
              Anuluj przed zatwierdzeniem efektu
            </button>
          )}
          <p>
            Anulowanie po zapisaniu zmian jest niedostępne. Odczyt stanu nie uruchamia zapisu ani
            dostawcy.
          </p>
        </section>
      )}
      {readable && (
        <section className="panel ofb-panel">
          <h2>Historia podglądów i wykonań</h2>
          {(['previews', 'executions'] as const).map((kind) => {
            const h = kind === 'previews' ? previews : executions;
            return (
              <div key={kind}>
                <h3>{kind === 'previews' ? 'Podglądy' : 'Wykonania'}</h3>
                <button
                  className="button"
                  disabled={busy || !!attempt}
                  onClick={() => void history(kind)}
                >
                  Odśwież historię
                </button>
                <ul className="ofb-history">
                  {h?.data.map((item) => (
                    <li key={item.id}>
                      <button
                        className="button"
                        disabled={busy || !!attempt}
                        onClick={() =>
                          kind === 'previews'
                            ? void loadPreview(item.id)
                            : void loadExecution(item.id)
                        }
                      >
                        {item.kind === 'csv' || item.source === 'csv_import'
                          ? 'CSV'
                          : 'Zmiany masowe'}{' '}
                        {item.state ? '· ' + (statusNames[item.state] ?? item.state) : ''}{' '}
                        {item.created_at ? '· ' + date(item.created_at) : ''}
                      </button>
                      {item.summary && (
                        <span>
                          {item.summary.total} wierszy, {item.summary.ready} gotowych
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {h?.meta.cursor && (
                  <button
                    className="button"
                    disabled={busy || !!attempt}
                    onClick={() => void history(kind, h.meta.cursor!)}
                  >
                    Starsze 20 wpisów
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
