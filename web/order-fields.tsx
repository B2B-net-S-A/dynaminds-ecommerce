import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Plus, Download, Upload } from 'lucide-react';
import { api, ApiError, date } from './api';
import type { OrderFieldChange, OrderFieldSet } from '../server/order-fields-schema';
import './order-fields.css';
import { toggleOrderFieldRequirement, packingFieldRequirementHint } from './order-field-requirements';

type FieldType = OrderFieldSet['type'];
type FieldOption = { id: string; label: string; enabled: boolean };
type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  version: number;
  enabled: boolean;
  display: 'always' | 'edit_only';
  position: number;
  read_role: 'team' | 'admin';
  write_role: 'operator' | 'admin';
  required_on: ('manual_create' | 'pack_complete')[];
  config: {
    scale?: number;
    min?: string;
    max?: string;
    max_length?: number;
    default?: string | string[];
  };
  options: FieldOption[];
  can_write?: boolean;
};
type FieldFile = {
  id: string;
  filename: string;
  mime_type: string;
  byte_count: number;
  file_hash?: string;
};
type FieldValue = {
  type: FieldType;
  value: string | string[];
  definition_version: number;
  options_snapshot?: { id: string; label: string }[];
  file?: FieldFile | null;
  updated_at?: string;
};
type FieldRow = { definition: FieldDefinition; value: FieldValue | null };
type Flags = { available: boolean; read_only: boolean; current_role: string; pack_complete_requirements_available?: boolean };
type Catalog = Flags & { can_admin: boolean; data: FieldDefinition[] };
type FieldDetail = Flags & { order_id: string; order_version: number; data: FieldRow[] };
type HistoryEvent = {
  id: string;
  field_id: string;
  definition_snapshot: FieldDefinition;
  before: FieldValue | null;
  after: FieldValue | null;
  source: string;
  created_at: string;
};
type History = Flags & { data: HistoryEvent[]; meta: { cursor: string | null } };
export type OrderFieldFilter = {
  field_id: string;
  definition_version: number;
  operator: string;
  value?: string | string[];
};
export type OrderFieldListSelection = { columns: FieldDefinition[]; filters: OrderFieldFilter[] };
export type InitialOrderFieldsState = {
  ready: boolean;
  available: boolean;
  changes: OrderFieldSet[];
  error: string;
};
type Context = { workspaceId: string; readOnly: boolean; onError: (message: string) => void };
const types: Record<FieldType, string> = {
  text: 'Tekst',
  number: 'Liczba',
  select: 'Lista wyboru',
  radio: 'Wybór pojedynczy',
  multi_select: 'Wybór wielu opcji',
  date: 'Data',
  file: 'Prywatny plik',
};
const clone = <T,>(v: T): T => structuredClone(v);
const isPrivateFailure = (e: unknown) => e instanceof ApiError && [401, 403].includes(e.status);
function canonicalNumber(raw: string, scale: number) {
  const v = raw.trim().replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) throw Error('Podaj liczbę dziesiętną bez wykładnika.');
  const negative = v.startsWith('-'),
    parts = (negative ? v.slice(1) : v).split('.');
  if ((parts[1]?.length ?? 0) > scale)
    throw Error(`Liczba może mieć maksymalnie ${scale} miejsc po przecinku.`);
  const whole = parts[0].replace(/^0+(?=\d)/, ''),
    fraction = (parts[1] ?? '').padEnd(scale, '0');
  if (whole.length + fraction.length > 18) throw Error('Liczba przekracza 18 cyfr.');
  const zero = /^0+$/.test(whole + fraction);
  return (negative && !zero ? '-' : '') + whole + (scale ? '.' + fraction : '');
}
const scaled = (v: string) => BigInt(v.replace('.', ''));
function emptyValue(d: FieldDefinition): string | string[] {
  return d.type === 'multi_select'
    ? []
    : d.type === 'number'
      ? canonicalNumber('0', d.config.scale ?? 0)
      : '';
}
function prepareValue(
  d: FieldDefinition,
  value: string | string[],
  allowRetired = false,
): OrderFieldSet {
  let v = clone(value);
  if (d.type === 'multi_select') {
    if (!Array.isArray(v) || v.length > 50) throw Error('Wybierz maksymalnie 50 opcji.');
    v = [...new Set(v)].sort();
  } else if (typeof v !== 'string') throw Error('Nieprawidłowy typ wartości.');
  if (
    d.type === 'text' &&
    typeof v === 'string' &&
    (v.includes('\0') ||
      v.length > (d.config.max_length ?? 4000) ||
      new TextEncoder().encode(v).length > 16384)
  )
    throw Error('Tekst przekracza limit pola lub zawiera NUL.');
  if (d.type === 'number' && typeof v === 'string') {
    v = canonicalNumber(v, d.config.scale ?? 0);
    if (d.config.min !== undefined && scaled(v) < scaled(d.config.min))
      throw Error('Liczba jest poniżej minimum.');
    if (d.config.max !== undefined && scaled(v) > scaled(d.config.max))
      throw Error('Liczba jest powyżej maksimum.');
  }
  if (d.type === 'date' && typeof v === 'string') {
    const parsed = new Date(v + 'T00:00:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      v.startsWith('0000') ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== v
    )
      throw Error('Wybierz poprawną datę kalendarzową.');
  }
  if (['select', 'radio', 'multi_select'].includes(d.type)) {
    const ids = Array.isArray(v) ? v : [v];
    if (ids.some((id) => !d.options.some((o) => o.id === id && (o.enabled || allowRetired))))
      throw Error('Wybierz aktywną opcję słownika.');
  }
  if (d.type === 'file' && typeof v === 'string' && !/^[0-9a-f-]{36}$/i.test(v))
    throw Error('Najpierw wgraj prywatny plik.');
  return { field_id: d.id, definition_version: d.version, type: d.type, value: v } as OrderFieldSet;
}
function valueText(d: Pick<FieldDefinition, 'type' | 'options'>, v: FieldValue | null | undefined) {
  if (!v) return 'Nie ustawiono';
  if (v.type === 'file') return v.file?.filename ?? 'Prywatny plik';
  const label = (id: string) =>
    v.options_snapshot?.find((o) => o.id === id)?.label ??
    d.options?.find((o) => o.id === id)?.label ??
    'Opcja historyczna';
  if (v.type === 'multi_select')
    return (v.value as string[]).length
      ? (v.value as string[]).map(label).join(', ')
      : 'Pusta lista';
  if (['select', 'radio'].includes(v.type)) return label(String(v.value));
  return v.value === '' ? 'Pusty tekst' : String(v.value);
}
function useCatalog(refresh: number, readOnly: boolean, onError?: (message: string) => void) {
  const [data, setData] = useState<Catalog | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    setBusy(true);
    api<Catalog>('/order-fields')
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          onError?.(e.message);
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [refresh, generation]);
  return {
    data,
    error,
    busy,
    readOnly: readOnly || !!data?.read_only,
    reload: () => setGeneration((v) => v + 1),
    clear: () => setData(null),
  };
}
type Attempt = {
  path: string;
  method: string;
  body: unknown;
  title: string;
  success: (result: any) => void | Promise<void>;
};
function useRequest(allowed: boolean, onError: (message: string) => void, onPrivate: () => void) {
  const [attempt, setAttempt] = useState<Attempt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [readOnly, setReadOnly] = useState(false);
  const alive = useRef(true),
    sending = useRef(false),
    pending = useRef<Attempt | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pending.current = null;
    };
  }, []);
  async function send(a: Attempt, retry = false) {
    if (!allowed || readOnly || sending.current || (!retry && pending.current)) return;
    const frozen = retry ? pending.current : a;
    if (!frozen) return;
    pending.current = frozen;
    setAttempt(frozen);
    sending.current = true;
    setBusy(true);
    setError('');
    let confirmed = false;
    try {
      const result = await api(frozen.path, frozen.method, frozen.body);
      confirmed = true;
      if (!alive.current) return;
      pending.current = null;
      setAttempt(null);
      await frozen.success(result);
    } catch (e) {
      if (!alive.current) return;
      const err = e as Error;
      setError(err.message);
      onError(err.message);
      if (e instanceof ApiError && e.status === 423) setReadOnly(true);
      if (isPrivateFailure(e)) {
        pending.current = null;
        setAttempt(null);
        onPrivate();
      } else if (!confirmed && e instanceof ApiError && [409, 422].includes(e.status)) {
        pending.current = null;
        setAttempt(null);
      }
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return {
    attempt,
    busy,
    error,
    readOnly,
    allowed,
    locked: !allowed || readOnly || busy || !!attempt,
    send,
    drop: () => {
      pending.current = null;
      setAttempt(null);
    },
  };
}
function AttemptReview({ request }: { request: ReturnType<typeof useRequest> }) {
  const [review, setReview] = useState(false);
  useEffect(
    () => setReview(false),
    [request.attempt, request.busy, request.readOnly, request.allowed],
  );
  if (!request.attempt || request.busy)
    return request.error ? (
      <p className="error" role="alert">
        {request.error}
      </p>
    ) : null;
  const a = request.attempt;
  return (
    <div className="of-review">
      <h4>Niepotwierdzona próba</h4>
      <p>
        {a.title}. Odpowiedź mogła zostać utracona po zapisie. Przed nową operacją sprawdź odczyt;
        ponowienie zachowa identyczną treść i klucz.
      </p>
      <details>
        <summary>Dokładny zakres próby</summary>
        <pre>
          {JSON.stringify(
            {
              ...(a.body as object),
              ...(a.path === '/order-field-files'
                ? { content_base64: '(bajty zachowane wyłącznie w pamięci)' }
                : {}),
            },
            null,
            2,
          )}
        </pre>
      </details>
      <label className="of-check">
        <input
          type="checkbox"
          checked={review}
          disabled={request.readOnly || !request.allowed}
          onChange={(e) => setReview(e.target.checked)}
        />
        Potwierdzam ponowienie dokładnie tej samej lokalnej operacji.
      </label>
      <div className="of-actions">
        <button
          type="button"
          className="button"
          disabled={!review || request.readOnly || !request.allowed}
          onClick={() => void request.send(a, true)}
        >
          Ponów tę samą próbę
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            request.drop();
            setReview(false);
          }}
        >
          Zamknij próbę w widoku
        </button>
      </div>
      {request.error && <p className="error">{request.error}</p>}
    </div>
  );
}
function CatalogStatus({ catalog }: { catalog: ReturnType<typeof useCatalog> }) {
  return (
    <>
      {catalog.busy && !catalog.data && <p>Wczytywanie pól…</p>}
      {catalog.error && (
        <p className="error" role="alert">
          {catalog.error}
        </p>
      )}
      {catalog.data && !catalog.data.available && (
        <p className="notice">Ta kopia nie zawiera dodatkowych pól zamówień.</p>
      )}
      {catalog.readOnly && (
        <p className="notice">Kopia tylko do odczytu. Zapisy i upload są wyłączone.</p>
      )}
    </>
  );
}

function FieldControl({
  definition: d,
  value,
  disabled,
  change,
}: {
  definition: FieldDefinition;
  value: string | string[];
  disabled: boolean;
  change: (v: string | string[]) => void;
}) {
  if (d.type === 'text')
    return (
      <textarea
        rows={3}
        maxLength={d.config.max_length ?? 4000}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
      />
    );
  if (d.type === 'number')
    return (
      <>
        <input
          inputMode="decimal"
          value={String(value)}
          disabled={disabled}
          onChange={(e) => change(e.target.value)}
          placeholder={d.config.scale ? '0,' + '0'.repeat(d.config.scale) : '0'}
        />
        <small className="of-muted">
          {d.config.scale ?? 0} miejsc po przecinku
          {d.config.min !== undefined ? ' · minimum ' + d.config.min : ''}
          {d.config.max !== undefined ? ' · maksimum ' + d.config.max : ''}. Zapis zachowa dokładną
          liczbę.
        </small>
      </>
    );
  if (d.type === 'date')
    return (
      <input
        type="date"
        value={String(value)}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
      />
    );
  if (d.type === 'select')
    return (
      <select value={String(value)} disabled={disabled} onChange={(e) => change(e.target.value)}>
        <option value="">Wybierz opcję</option>
        {d.options
          .filter((o) => o.enabled || o.id === value)
          .map((o) => (
            <option key={o.id} value={o.id} disabled={!o.enabled}>
              {o.label}
              {!o.enabled ? ' (wycofana)' : ''}
            </option>
          ))}
      </select>
    );
  if (d.type === 'radio')
    return (
      <div className="of-options">
        {d.options
          .filter((o) => o.enabled || o.id === value)
          .map((o) => (
            <label className="of-check" key={o.id}>
              <input
                type="radio"
                name={'field-' + d.id}
                value={o.id}
                checked={value === o.id}
                disabled={disabled || !o.enabled}
                onChange={() => change(o.id)}
              />
              {o.label}
              {!o.enabled ? ' (wycofana)' : ''}
            </label>
          ))}
      </div>
    );
  if (d.type === 'multi_select') {
    const values = Array.isArray(value) ? value : [];
    return (
      <div className="of-options">
        {d.options
          .filter((o) => o.enabled || values.includes(o.id))
          .map((o) => (
            <label className="of-check" key={o.id}>
              <input
                type="checkbox"
                checked={values.includes(o.id)}
                disabled={
                  disabled ||
                  (!o.enabled && !values.includes(o.id)) ||
                  (!values.includes(o.id) && values.length >= 50)
                }
                onChange={(e) =>
                  change(
                    e.target.checked
                      ? [...values, o.id].sort()
                      : values.filter((id) => id !== o.id),
                  )
                }
              />
              {o.label}
              {!o.enabled ? ' (wycofana)' : ''}
            </label>
          ))}
      </div>
    );
  }
  return <p>Plik wgrywa się prywatnie w istniejącym zamówieniu.</p>;
}
function bytesBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 16384)
    s += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(s);
}
async function downloadFile(ctx: Context, file: FieldFile) {
  const r = await fetch('/api/order-field-files/' + encodeURIComponent(file.id) + '/download', {
    credentials: 'same-origin',
    headers: { 'X-Workspace-ID': ctx.workspaceId },
  });
  if (!r.ok) {
    let message = 'Nie można pobrać prywatnego pliku.';
    try {
      message = (await r.json()).detail ?? message;
    } catch {}
    throw new ApiError(message, r.status);
  }
  const blob = await r.blob();
  return { blob, filename: file.filename };
}
function PrivateFile({
  ctx,
  orderId,
  definition,
  value,
  disabled,
  change,
  onPrivate,
}: {
  ctx: Context;
  orderId: string;
  definition: FieldDefinition;
  value: FieldValue | null;
  disabled: boolean;
  change: (file: FieldFile) => void;
  onPrivate: () => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [error, setError] = useState(''),
    [reading, setReading] = useState(false);
  const alive = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++generation.current;
    };
  }, []);
  const request = useRequest(!disabled, ctx.onError, onPrivate);
  async function upload() {
    if (!file || request.locked) return;
    if (!file.size || file.size > 5 * 1024 * 1024) {
      setError('Plik wymaga od 1 bajtu do 5 MiB.');
      return;
    }
    if (file.name.length > 120 || /[\/\\\x00-\x1f\x7f]/.test(file.name)) {
      setError('Zmień nazwę pliku na maksymalnie 120 znaków bez separatorów ścieżki.');
      return;
    }
    const current = ++generation.current;
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!alive.current || current !== generation.current) return;
      await request.send({
        path: '/order-field-files',
        method: 'POST',
        title: 'Upload prywatnego pliku ' + file.name,
        body: {
          client_key: crypto.randomUUID(),
          order_id: orderId,
          field_id: definition.id,
          definition_version: definition.version,
          filename: file.name,
          content_base64: bytesBase64(bytes),
        },
        success: (d) => {
          change(d);
          setFile(null);
        },
      });
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        ctx.onError((e as Error).message);
      }
    } finally {
      if (alive.current) setReading(false);
    }
  }
  async function download() {
    if (!value?.file) return;
    const current = ++generation.current;
    setReading(true);
    try {
      const d = await downloadFile(ctx, value.file);
      if (!alive.current || current !== generation.current) return;
      const url = URL.createObjectURL(d.blob),
        a = document.createElement('a');
      a.href = url;
      a.download = d.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        ctx.onError((e as Error).message);
        if (isPrivateFailure(e)) onPrivate();
      }
    } finally {
      if (alive.current) setReading(false);
    }
  }
  return (
    <div className="of-file">
      {value?.file && (
        <p>
          {value.file.filename} · {value.file.byte_count} bajtów{' '}
          <button
            type="button"
            className="button"
            disabled={reading}
            onClick={() => void download()}
          >
            <Download size={16} />
            Pobierz prywatnie
          </button>
        </p>
      )}
      <label>
        PDF, JPEG lub PNG do 5 MiB
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          disabled={disabled || request.locked || reading}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError('');
            ++generation.current;
          }}
        />
      </label>
      <button
        type="button"
        className="button"
        disabled={disabled || request.locked || reading || !file}
        onClick={() => void upload()}
      >
        <Upload size={16} />
        Wgraj prywatny plik
      </button>
      <p className="of-muted">
        Upload zapisze plik lokalnie. Przypisanie go do pola wymaga zapisania zmian. Brak
        publicznego linku.
      </p>
      {error && <p className="error">{error}</p>}
      <AttemptReview request={request} />
    </div>
  );
}

type ValueDraft = { set: boolean; value: string | string[]; file?: FieldFile | null };
export function OrderFieldsPanel({
  orderId,
  refresh,
  onChanged,
  ...ctx
}: Context & { orderId: string; refresh: number; onChanged: () => void }) {
  const [detail, setDetail] = useState<FieldDetail | null>(null),
    [history, setHistory] = useState<History | null>(null),
    [drafts, setDrafts] = useState<Record<string, ValueDraft>>({}),
    [editing, setEditing] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState('');
  const alive = useRef(true),
    generation = useRef(0),
    historyGeneration = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++generation.current;
      ++historyGeneration.current;
    };
  }, []);
  const readonly = ctx.readOnly || !!detail?.read_only;
  function privateFailure() {
    setDetail(null);
    setHistory(null);
    setDrafts({});
    setEditing(false);
    setReview('');
  }
  const request = useRequest(
    !!detail?.available && !readonly && detail.current_role !== 'viewer',
    ctx.onError,
    privateFailure,
  );
  async function load() {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setReview('');
    try {
      const d = await api<FieldDetail>('/orders/' + orderId + '/fields');
      if (!alive.current || current !== generation.current) return;
      setDetail(d);
      setDrafts({});
      setEditing(false);
    } catch (e) {
      if (alive.current && (current === generation.current || isPrivateFailure(e))) {
        setError((e as Error).message);
        ctx.onError((e as Error).message);
        if (isPrivateFailure(e)) privateFailure();
      }
    } finally {
      if (alive.current && current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setDetail(null);
    setHistory(null);
    setDrafts({});
    void load();
  }, [orderId, refresh]);
  async function loadHistory(cursor?: string | null) {
    const current = ++historyGeneration.current;
    setBusy(true);
    try {
      const d = await api<History>(
        '/orders/' +
          orderId +
          '/fields/history' +
          (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      );
      if (!alive.current || current !== historyGeneration.current) return;
      if (d.current_role !== detail?.current_role || (d.read_only && !detail?.read_only)) {
        privateFailure();
        await load();
      }
      if (d.read_only || d.current_role === 'viewer') setReview('');
      setHistory((old) => ({
        ...d,
        data:
          cursor && old && old.current_role === d.current_role
            ? [...old.data, ...d.data.filter((r) => !old.data.some((o) => o.id === r.id))]
            : d.data,
      }));
    } catch (e) {
      if (alive.current && (current === historyGeneration.current || isPrivateFailure(e))) {
        setError((e as Error).message);
        ctx.onError((e as Error).message);
        if (isPrivateFailure(e)) privateFailure();
      }
    } finally {
      if (alive.current && current === historyGeneration.current) setBusy(false);
    }
  }
  function draft(row: FieldRow): ValueDraft {
    return (
      drafts[row.definition.id] ?? {
        set: !!row.value,
        value: row.value?.value ?? emptyValue(row.definition),
        file: row.value?.file,
      }
    );
  }
  function update(row: FieldRow, next: ValueDraft) {
    setDrafts((old) => ({ ...old, [row.definition.id]: next }));
    setReview('');
  }
  let changes: OrderFieldChange[] = [],
    problem = '';
  try {
    for (const row of detail?.data ?? []) {
      const d = drafts[row.definition.id];
      if (!d) continue;
      if (!row.definition.can_write || !row.definition.enabled)
        throw Error('To pole nie jest aktualnie dostępne do zapisu.');
      changes.push(
        d.set
          ? prepareValue(row.definition, d.value)
          : {
              field_id: row.definition.id,
              definition_version: row.definition.version,
              operation: 'clear',
            },
      );
    }
    if (changes.length > 20) throw Error('Jednorazowo zapisz maksymalnie 20 zmienionych pól.');
  } catch (e) {
    problem = (e as Error).message;
  }
  const fence = JSON.stringify({
    order_id: orderId,
    order_version: detail?.order_version,
    changes,
  });
  const lastRole = useRef<string | undefined>(undefined);
  useEffect(() => {
    setReview('');
    if (lastRole.current && detail?.current_role && lastRole.current !== detail.current_role) {
      request.drop();
      setDrafts({});
      setEditing(false);
      setHistory(null);
    }
    lastRole.current = detail?.current_role;
  }, [readonly, detail?.current_role]);
  async function save() {
    if (!detail || request.locked || busy || !changes.length || problem || review !== fence) return;
    const body = {
      client_key: crypto.randomUUID(),
      order_version: detail.order_version,
      changes: clone(changes),
    };
    await request.send({
      path: '/orders/' + orderId + '/fields',
      method: 'PATCH',
      title: 'Zapis ' + changes.length + ' pól zamówienia',
      body,
      success: async (d) => {
        setReview('');
        setDrafts({});
        setEditing(false);
        setDetail(d);
        onChanged();
      },
    });
  }
  return (
    <section className="panel order-fields">
      <div className="panel-heading">
        <div>
          <h2>Dodatkowe pola zamówienia</h2>
          <p>
            Własne informacje i prywatne załączniki. Zapis nie wysyła ich do kanałów ani kupującego.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={busy || request.busy || !!request.attempt}
          onClick={() => void load()}
        >
          <RefreshCw size={16} />
          Odśwież pola
        </button>
      </div>
      <div className="of-body">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {busy && !detail && <p>Wczytywanie pól…</p>}
        {detail && !detail.available && (
          <p className="notice">Ta kopia nie zawiera dodatkowych pól zamówień.</p>
        )}
        {readonly && <p className="notice">Kopia tylko do odczytu. Pliki pozostają prywatne.</p>}
        {detail?.available && (
          <>
            <div className="of-actions">
              <button
                type="button"
                className="button"
                disabled={
                  request.locked ||
                  busy ||
                  !detail.data.some((r) => r.definition.can_write && r.definition.enabled)
                }
                onClick={() => {
                  setEditing((v) => !v);
                  setDrafts({});
                  setReview('');
                }}
              >
                {editing ? 'Zamknij edycję' : 'Edytuj pola'}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy || request.busy}
                onClick={() => void loadHistory()}
              >
                Odczytaj historię pól
              </button>
            </div>
            {!detail.data.length && <p>Brak pól dostępnych dla Twojej roli.</p>}
            {detail.data
              .filter(
                (r) =>
                  (detail.current_role === 'admin' || r.definition.read_role === 'team') &&
                  (editing ||
                  r.definition.display === 'always' ||
                  (!r.definition.enabled && !!r.value)),
              )
              .map((row) => {
                const d = row.definition,
                  v = draft(row),
                  locked = request.locked || busy || !row.definition.can_write || !d.enabled;
                return (
                  <article
                    className="of-entry"
                    key={detail.order_version + ':' + d.id + ':' + d.version}
                  >
                    <h3>
                      {d.label} {!d.enabled && <small>(wyłączone)</small>}
                    </h3>
                    <p className="of-muted">
                      {types[d.type]}
                      {d.required_on.includes('pack_complete')
                        ? ' · wymagane przy zakończeniu pakowania'
                        : ''}
                      {d.read_role === 'admin' ? ' · widoczne tylko administratorom' : ''}
                    </p>
                    {packingFieldRequirementHint(d, row.value, detail.pack_complete_requirements_available === true) &&
                      <p className="of-muted" role="status">{packingFieldRequirementHint(d, row.value, detail.pack_complete_requirements_available === true)}</p>}
                    {!editing ? (
                      <>
                        <div className="of-value">{valueText(d, row.value)}</div>
                        {d.type === 'file' && row.value?.file && (
                          <PrivateFile
                            ctx={ctx}
                            orderId={orderId}
                            definition={d}
                            value={row.value}
                            disabled={true}
                            change={() => {}}
                            onPrivate={privateFailure}
                          />
                        )}
                      </>
                    ) : (
                      <>
                        <label className="of-check">
                          <input
                            type="checkbox"
                            checked={v.set}
                            disabled={locked}
                            onChange={(e) => update(row, { ...v, set: e.target.checked })}
                          />
                          Pole ustawione (odznaczenie usuwa wartość, pusty tekst i zero pozostają
                          wartościami)
                        </label>
                        {v.set &&
                          (d.type === 'file' ? (
                            <PrivateFile
                              ctx={ctx}
                              orderId={orderId}
                              definition={d}
                              value={
                                v.file
                                  ? {
                                      type: 'file',
                                      value: v.file.id,
                                      definition_version: d.version,
                                      file: v.file,
                                    }
                                  : row.value
                              }
                              disabled={locked}
                              onPrivate={privateFailure}
                              change={(file) => update(row, { set: true, value: file.id, file })}
                            />
                          ) : (
                            <FieldControl
                              definition={d}
                              value={v.value}
                              disabled={locked}
                              change={(value) => update(row, { ...v, set: true, value })}
                            />
                          ))}
                        {!row.definition.can_write && (
                          <p className="of-muted">
                            Pole dostępne wyłącznie do odczytu dla Twojej roli.
                          </p>
                        )}
                      </>
                    )}
                    <details>
                      <summary>Szczegóły pola</summary>
                      <small>
                        Klucz: {d.key} · wersja definicji: {d.version} · wersja wartości:{' '}
                        {row.value?.definition_version ?? 'brak'}
                      </small>
                    </details>
                  </article>
                );
              })}
            {editing && (
              <div className="of-review">
                <h3>Sprawdź zmiany: {changes.length} / 20</h3>
                {problem && <p className="error">{problem}</p>}
                {changes.map((c) => {
                  const row = detail.data.find((r) => r.definition.id === c.field_id)!;
                  return (
                    <p key={c.field_id}>
                      <strong>{row.definition.label}</strong>:{' '}
                      {valueText(row.definition, row.value)} →{' '}
                      {'operation' in c
                        ? 'Usuń wartość'
                        : valueText(row.definition, {
                            type: c.type,
                            value: c.value,
                            definition_version: c.definition_version,
                            options_snapshot: row.definition.options,
                            file: drafts[c.field_id]?.file,
                          })}
                    </p>
                  );
                })}
                <label className="of-check">
                  <input
                    type="checkbox"
                    checked={review === fence && !!review}
                    disabled={request.locked || busy || !!problem || !changes.length}
                    onChange={(e) => setReview(e.target.checked ? fence : '')}
                  />
                  Sprawdziłem dokładnie zmienione pola. Zapisuję lokalne wartości w jednej operacji.
                </label>
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    request.locked || busy || !!problem || !changes.length || review !== fence
                  }
                  onClick={() => void save()}
                >
                  Zapisz zmiany pól
                </button>
                <p>
                  Konflikt wersji zamówienia lub definicji nie zapisze żadnego z wybranych pól.
                  Odśwież i sprawdź aktualne wartości przed nową edycją.
                </p>
              </div>
            )}
            {history && (
              <div className="of-history">
                <h3>Historia wartości pól</h3>
                {history.data.map((h) => (
                  <article className="of-entry" key={h.id}>
                    <strong>{h.definition_snapshot.label}</strong>
                    <small>
                      {date(h.created_at)} ·{' '}
                      {(
                        {
                          manual: 'Ręcznie',
                          api: 'API',
                          channel_import: 'Import kanału',
                          csv_import: 'Import CSV',
                          automation: 'Automatyzacja',
                          copy: 'Kopia',
                        } as Record<string, string>
                      )[h.source] ?? h.source}
                    </small>
                    <p>
                      <span className="of-value">{valueText(h.definition_snapshot, h.before)}</span>{' '}
                      →{' '}
                      <span className="of-value">{valueText(h.definition_snapshot, h.after)}</span>
                    </p>
                    <small>
                      Definicja z chwili zmiany · wersja {h.definition_snapshot.version}
                    </small>
                  </article>
                ))}
                {!history.data.length && <p>Brak zmian pól.</p>}
                {history.meta.cursor && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => void loadHistory(history.meta.cursor)}
                  >
                    Starsze zmiany pól
                  </button>
                )}
              </div>
            )}
          </>
        )}
        <AttemptReview request={request} />
      </div>
    </section>
  );
}

export function OrderInitialFields({
  readOnly,
  onChange,
}: {
  readOnly: boolean;
  onChange: (state: InitialOrderFieldsState) => void;
}) {
  const catalog = useCatalog(0, readOnly),
    [drafts, setDrafts] = useState<Record<string, ValueDraft>>({});
  const definitions =
    catalog.data?.data.filter((d) => d.enabled && d.type !== 'file' && d.can_write === true) ?? [];
  let changes: OrderFieldSet[] = [],
    error = '';
  try {
    for (const d of definitions) {
      const v = drafts[d.id];
      if (v?.set) changes.push(prepareValue(d, v.value));
      else if (d.required_on.includes('manual_create') && d.config.default === undefined)
        throw Error('Uzupełnij wymagane pole: ' + d.label);
    }
    if (changes.length > 20) throw Error('Podczas tworzenia wpisz maksymalnie 20 pól.');
  } catch (e) {
    error = (e as Error).message;
  }
  if (catalog.data?.available && catalog.data.current_role === 'viewer')
    error = 'Aktualna rola nie pozwala tworzyć zamówień.';
  const ready =
    !!catalog.data &&
    !catalog.busy &&
    !catalog.error &&
    !error &&
    !catalog.readOnly &&
    (!catalog.data.available || ['admin', 'operator'].includes(catalog.data.current_role));
  const result = JSON.stringify({
    ready,
    available: !!catalog.data?.available,
    changes,
    error: catalog.error || error,
  });
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => callback.current(JSON.parse(result)), [result]);
  return (
    <section className="order-fields">
      <h3>Dodatkowe pola nowego zamówienia</h3>
      <CatalogStatus catalog={catalog} />
      {catalog.data?.available && (
        <>
          <p>
            Wartości zapiszą się razem z zamówieniem. Prywatny plik dodasz po utworzeniu zamówienia.
          </p>
          {definitions.map((d) => {
            const v = drafts[d.id] ?? {
              set: false,
              value: emptyValue(d),
            };
            return (
              <article className="of-entry" key={d.id + ':' + d.version}>
                <label className="of-check">
                  <input
                    type="checkbox"
                    checked={v.set}
                    disabled={catalog.readOnly}
                    onChange={(e) =>
                      setDrafts((old) => ({ ...old, [d.id]: { ...v, set: e.target.checked } }))
                    }
                  />
                  {d.label}
                  {d.required_on.includes('manual_create') ? ' (wymagane przy tworzeniu)' : ''}
                </label>
                {v.set && (
                  <FieldControl
                    definition={d}
                    value={v.value}
                    disabled={catalog.readOnly}
                    change={(value) =>
                      setDrafts((old) => ({ ...old, [d.id]: { set: true, value } }))
                    }
                  />
                )}{' '}
                {d.config.default !== undefined && (
                  <p className="of-muted">
                    Wartość domyślna, jeśli pole zostanie pominięte:{' '}
                    {valueText(d, {
                      type: d.type,
                      value: d.config.default,
                      definition_version: d.version,
                      options_snapshot: d.options,
                    })}
                  </p>
                )}
              </article>
            );
          })}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </section>
  );
}

type Editable = {
  label: string;
  enabled: boolean;
  display: 'always' | 'edit_only';
  position: number;
  read_role: 'team' | 'admin';
  write_role: 'operator' | 'admin';
  required_on: ('manual_create' | 'pack_complete')[];
  config: FieldDefinition['config'];
  options: FieldOption[];
};
function DefinitionEditor({
  initial,
  locked,
  packCompleteAvailable,
  resetReview,
  save,
  close,
}: {
  initial?: FieldDefinition;
  locked: boolean;
  packCompleteAvailable: boolean;
  resetReview: number;
  save: (body: Editable & { key?: string; type?: FieldType }) => void;
  close: () => void;
}) {
  const [key, setKey] = useState(initial?.key ?? ''),
    [type, setType] = useState<FieldType>(initial?.type ?? 'text'),
    [p, setP] = useState<Editable>(() =>
      initial
        ? {
            label: initial.label,
            enabled: initial.enabled,
            display: initial.display,
            position: initial.position,
            read_role: initial.read_role,
            write_role: initial.write_role,
            required_on: clone(initial.required_on),
            config: clone(initial.config),
            options: clone(initial.options),
          }
        : {
            label: '',
            enabled: true,
            display: 'always',
            position: 0,
            read_role: 'team',
            write_role: 'operator',
            required_on: [],
            config: { max_length: 4000 },
            options: [],
          },
    ),
    [review, setReview] = useState(false);
  useEffect(() => setReview(false), [locked, resetReview]);
  function update(next: Editable) {
    setP(next);
    setReview(false);
  }
  const def = {
    ...p,
    id: initial?.id ?? 'draft',
    key,
    type,
    version: initial?.version ?? 1,
  } as FieldDefinition;
  let problem = '',
    prepared = clone(p);
  try {
    if (!p.label.trim() || !/^[a-z][a-z0-9_]{0,63}$/.test(key))
      throw Error('Podaj etykietę oraz klucz ASCII: litery, cyfry i podkreślenie.');
    if (p.read_role === 'admin' && p.write_role !== 'admin')
      throw Error('Pole prywatne administratora wymaga zapisu tylko przez administratora.');
    if (type === 'number') {
      const scale = p.config.scale ?? 0;
      if (!Number.isInteger(scale) || scale < 0 || scale > 6)
        throw Error('Skala liczby wymaga 0–6 miejsc.');
      for (const k of ['min', 'max'] as const)
        if (prepared.config[k] !== undefined)
          prepared.config[k] = canonicalNumber(prepared.config[k]!, scale);
      if (
        prepared.config.min !== undefined &&
        prepared.config.max !== undefined &&
        scaled(prepared.config.min) > scaled(prepared.config.max)
      )
        throw Error('Minimum przekracza maksimum.');
    }
    if (p.options.some((o) => !o.label.trim())) throw Error('Każda opcja wymaga etykiety.');
    if (p.config.default !== undefined)
      prepared.config.default = prepareValue(
        { ...def, config: prepared.config },
        p.config.default,
      ).value;
  } catch (e) {
    problem = (e as Error).message;
  }
  const choice = ['select', 'radio', 'multi_select'].includes(type);
  return (
    <form
      className="of-review"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && review && !problem)
          save({ ...prepared, ...(!initial ? { key, type } : {}) });
      }}
    >
      <h3>{initial ? 'Edycja definicji pola' : 'Nowe pole zamówienia'}</h3>
      <fieldset disabled={locked}>
        <div className="of-grid">
          <label>
            Etykieta
            <input
              required
              maxLength={120}
              value={p.label}
              onChange={(e) => update({ ...p, label: e.target.value })}
            />
          </label>
          <label>
            Stały klucz
            <input
              required
              maxLength={64}
              disabled={!!initial}
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setReview(false);
              }}
              placeholder="np. numer_umowy"
            />
          </label>
          <label>
            Typ
            <select
              disabled={!!initial}
              value={type}
              onChange={(e) => {
                const t = e.target.value as FieldType;
                setType(t);
                update({
                  ...p,
                  config: t === 'text' ? { max_length: 4000 } : t === 'number' ? { scale: 2 } : {},
                  options: [],
                  required_on: t === 'file' ? toggleOrderFieldRequirement(p.required_on, 'manual_create', false) : p.required_on,
                });
              }}
            >
              {Object.entries(types).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Kolejność
            <input
              type="number"
              min={0}
              max={10000}
              step={1}
              value={p.position}
              onChange={(e) => update({ ...p, position: Number(e.target.value) })}
            />
          </label>
          <label>
            Wyświetlanie
            <select
              value={p.display}
              onChange={(e) => update({ ...p, display: e.target.value as Editable['display'] })}
            >
              <option value="always">Widoczne w zamówieniu</option>
              <option value="edit_only">Widoczne podczas edycji</option>
            </select>
          </label>
          <label>
            Dostęp do odczytu
            <select
              value={p.read_role}
              onChange={(e) => {
                const r = e.target.value as Editable['read_role'];
                update({ ...p, read_role: r, write_role: r === 'admin' ? 'admin' : p.write_role });
              }}
            >
              <option value="team">Zespół w tej organizacji</option>
              <option value="admin">Tylko administrator</option>
            </select>
          </label>
          <label>
            Dostęp do zapisu
            <select
              value={p.write_role}
              disabled={p.read_role === 'admin'}
              onChange={(e) =>
                update({ ...p, write_role: e.target.value as Editable['write_role'] })
              }
            >
              <option value="operator">Administrator i operator</option>
              <option value="admin">Tylko administrator</option>
            </select>
          </label>
        </div>
        <label className="of-check">
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => update({ ...p, enabled: e.target.checked })}
          />
          Pole aktywne. Wyłączenie zachowa stare wartości i historię.
        </label>
        <label className="of-check">
          <input
            type="checkbox"
            checked={p.required_on.includes('manual_create')}
            disabled={type === 'file'}
            onChange={(e) =>
              update({ ...p, required_on: toggleOrderFieldRequirement(p.required_on, 'manual_create', e.target.checked) })
            }
          />
          Wymagane podczas ręcznego tworzenia zamówienia
        </label>
        <label className="of-check">
          <input
            type="checkbox"
            checked={p.required_on.includes('pack_complete')}
            disabled={!packCompleteAvailable}
            onChange={(e) =>
              update({ ...p, required_on: toggleOrderFieldRequirement(p.required_on, 'pack_complete', e.target.checked) })
            }
          />
          Wymagane przy zakończeniu pakowania
        </label>
        {!packCompleteAvailable && <p className="of-muted">Ta wersja serwera nie udostępnia jeszcze sprawdzania wymaganych pól podczas pakowania. Zapisany wybór pozostaje zachowany.</p>}
        <p className="of-muted">
          Prywatny plik dodaje się do istniejącego zamówienia. Nie może być wymagany przy jego tworzeniu.
          Portal i mapowania kanałów mają osobne zasady.
        </p>
        {type === 'text' && (
          <label>
            Maksymalna długość tekstu
            <input
              type="number"
              min={1}
              max={4000}
              step={1}
              value={p.config.max_length ?? 4000}
              onChange={(e) =>
                update({ ...p, config: { ...p.config, max_length: Number(e.target.value) } })
              }
            />
          </label>
        )}
        {type === 'number' && (
          <div className="of-grid">
            <label>
              Miejsca po przecinku
              <input
                type="number"
                min={0}
                max={6}
                step={1}
                value={p.config.scale ?? 0}
                onChange={(e) =>
                  update({ ...p, config: { ...p.config, scale: Number(e.target.value) } })
                }
              />
            </label>
            {(['min', 'max'] as const).map((k) => (
              <label key={k}>
                {k === 'min' ? 'Minimum (opcjonalnie)' : 'Maksimum (opcjonalnie)'}
                <input
                  inputMode="decimal"
                  value={p.config[k] ?? ''}
                  onChange={(e) => {
                    const config = { ...p.config };
                    if (e.target.value === '') delete config[k];
                    else config[k] = e.target.value;
                    update({ ...p, config });
                  }}
                />
              </label>
            ))}
          </div>
        )}
        {choice && (
          <>
            <h4>Opcje słownika: {p.options.length} / 100</h4>
            <p>
              Wycofaj opcję, zamiast usuwać jej historię. Historyczne wartości zachowują etykietę z
              chwili zapisu.
            </p>
            {p.options.map((o, i) => (
              <div className="of-option" key={o.id}>
                <label>
                  Etykieta opcji {i + 1}
                  <input
                    maxLength={120}
                    required
                    value={o.label}
                    onChange={(e) =>
                      update({
                        ...p,
                        options: p.options.map((v) =>
                          v.id === o.id ? { ...v, label: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </label>
                <label className="of-check">
                  <input
                    type="checkbox"
                    checked={o.enabled}
                    onChange={(e) =>
                      update({
                        ...p,
                        options: p.options.map((v) =>
                          v.id === o.id ? { ...v, enabled: e.target.checked } : v,
                        ),
                      })
                    }
                  />
                  Opcja dostępna dla nowych wartości
                </label>
              </div>
            ))}
            <button
              type="button"
              className="button"
              disabled={p.options.length >= 100}
              onClick={() =>
                update({
                  ...p,
                  options: [...p.options, { id: crypto.randomUUID(), label: '', enabled: true }],
                })
              }
            >
              <Plus size={16} />
              Dodaj opcję
            </button>
          </>
        )}
        {type !== 'file' && (
          <>
            <label className="of-check">
              <input
                type="checkbox"
                checked={p.config.default !== undefined}
                onChange={(e) => {
                  const config = { ...p.config };
                  if (e.target.checked) config.default = emptyValue(def);
                  else delete config.default;
                  update({ ...p, config });
                }}
              />
              Użyj jawnej wartości domyślnej przy tworzeniu zamówienia
            </label>
            {p.config.default !== undefined && (
              <FieldControl
                definition={def}
                value={p.config.default}
                disabled={false}
                change={(value) => update({ ...p, config: { ...p.config, default: value } })}
              />
            )}
          </>
        )}
        {problem && <p className="error">{problem}</p>}
        <label className="of-check">
          <input
            type="checkbox"
            checked={review}
            disabled={!!problem}
            onChange={(e) => setReview(e.target.checked)}
          />
          Sprawdziłem typ, dostęp, opcje i wymagania tego pola. Zapisuję definicję lokalną.
        </label>
        <div className="of-actions">
          <button className="button primary" disabled={!review || !!problem}>
            Zapisz definicję
          </button>
          <button type="button" className="button" onClick={close}>
            Zamknij szkic
          </button>
        </div>
      </fieldset>
    </form>
  );
}
export function AdminOrderFields({
  refresh = 0,
  onChanged,
  ...ctx
}: Context & { refresh?: number; onChanged?: () => void }) {
  const catalog = useCatalog(refresh, ctx.readOnly, ctx.onError),
    [editor, setEditor] = useState<{ key: string; definition?: FieldDefinition } | null>(null),
    [disable, setDisable] = useState<FieldDefinition | null>(null),
    [review, setReview] = useState(false),
    [reset, setReset] = useState(0);
  const allowed = !!catalog.data?.available && catalog.data.can_admin && !catalog.readOnly;
  const request = useRequest(allowed, ctx.onError, () => {
    catalog.clear();
    setEditor(null);
    setDisable(null);
  });
  useEffect(() => {
    setReview(false);
    setReset((v) => v + 1);
    if (catalog.data?.available && !catalog.data.can_admin) {
      setEditor(null);
      setDisable(null);
      request.drop();
    }
  }, [request.error, catalog.readOnly, catalog.data?.current_role]);
  async function saved() {
    setEditor(null);
    setDisable(null);
    setReview(false);
    catalog.reload();
    onChanged?.();
  }
  return (
    <section className="panel order-fields">
      <div className="panel-heading">
        <div>
          <h2>Pola dodatkowe zamówień</h2>
          <p>
            Zaprojektuj lokalne informacje dla swojego procesu. Typ i klucz pozostają stałe;
            prywatne dane mają kontrolę dostępu.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={catalog.busy || request.busy || !!request.attempt}
          onClick={catalog.reload}
        >
          <RefreshCw size={16} />
          Odśwież definicje
        </button>
      </div>
      <div className="of-body">
        <CatalogStatus catalog={catalog} />
        {catalog.data?.available && (
          <>
            <div className="of-actions">
              <button
                type="button"
                className="button primary"
                disabled={request.locked}
                onClick={() => {
                  setEditor({ key: crypto.randomUUID() });
                  setDisable(null);
                }}
              >
                <Plus size={16} />
                Nowe pole
              </button>
            </div>
            {!catalog.data.can_admin && (
              <p className="notice">Projektant pól wymaga aktualnego administratora.</p>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Pole</th>
                    <th>Typ</th>
                    <th>Dostęp i stan</th>
                    <th>Obsługa</th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.data.data.map((d) => (
                    <tr key={d.id}>
                      <td>
                        {d.label}
                        <small>
                          {d.key} · wersja {d.version}
                        </small>
                      </td>
                      <td>{types[d.type]}</td>
                      <td>
                        {d.enabled ? 'Aktywne' : 'Wyłączone'} ·{' '}
                        {d.read_role === 'admin' ? 'Prywatne administratora' : 'Zespół'}
                        <small>
                          Zapis:{' '}
                          {d.write_role === 'admin' ? 'Administrator' : 'Administrator i operator'}
                        </small>
                      </td>
                      <td>
                        <div className="of-actions">
                          <button
                            type="button"
                            className="button"
                            disabled={request.locked}
                            onClick={() => {
                              setEditor({ key: crypto.randomUUID(), definition: clone(d) });
                              setDisable(null);
                            }}
                          >
                            Edytuj definicję
                          </button>
                          <button
                            type="button"
                            className="button"
                            disabled={request.locked || !d.enabled}
                            onClick={() => {
                              setDisable(clone(d));
                              setReview(false);
                              setEditor(null);
                            }}
                          >
                            Wyłącz
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!catalog.data.data.length && <p>Brak definicji pól. Utwórz pierwsze własne pole.</p>}
            {editor?.definition &&
              catalog.data.data.some(
                (d) => d.id === editor.definition!.id && d.version !== editor.definition!.version,
              ) && (
                <p className="error">
                  Szkic dotyczy starszej definicji. Zamknij szkic i otwórz aktualną wersję z listy;
                  nie przenosimy zgody automatycznie.
                </p>
              )}
            {editor && (
              <DefinitionEditor
                key={editor.key}
                initial={editor.definition}
                locked={request.locked}
                packCompleteAvailable={catalog.data.pack_complete_requirements_available === true}
                resetReview={reset}
                close={() => setEditor(null)}
                save={(body) =>
                  void request.send({
                    path: '/order-fields' + (editor.definition ? '/' + editor.definition.id : ''),
                    method: editor.definition ? 'PATCH' : 'POST',
                    body: editor.definition
                      ? { version: editor.definition.version, ...body }
                      : { client_key: crypto.randomUUID(), ...body },
                    title: editor.definition
                      ? 'Edycja definicji ' + body.label
                      : 'Utworzenie pola ' + body.label,
                    success: saved,
                  })
                }
              />
            )}
            {disable && (
              <div className="of-review">
                <h3>Wyłączenie pola {disable.label}</h3>
                <p>
                  Wersja {disable.version}. Wartości, opcje i historia pozostają czytelne zgodnie z
                  uprawnieniami.
                </p>
                <label className="of-check">
                  <input
                    type="checkbox"
                    checked={review}
                    disabled={request.locked}
                    onChange={(e) => setReview(e.target.checked)}
                  />
                  Potwierdzam wyłączenie tej wersji pola.
                </label>
                <div className="of-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={request.locked || !review}
                    onClick={() =>
                      void request.send({
                        path: '/order-fields/' + disable.id,
                        method: 'DELETE',
                        body: { version: disable.version },
                        title: 'Wyłączenie pola ' + disable.label,
                        success: saved,
                      })
                    }
                  >
                    Wyłącz pole
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={request.busy}
                    onClick={() => setDisable(null)}
                  >
                    Zamknij
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        <AttemptReview request={request} />
      </div>
    </section>
  );
}

const operatorNames: Record<string, string> = {
  is_set: 'Ustawione',
  is_unset: 'Nie ustawiono',
  eq: 'Równe',
  neq: 'Różne',
  contains: 'Tekst zawiera',
  prefix: 'Tekst zaczyna się od',
  gte: 'Większe lub równe',
  lte: 'Mniejsze lub równe',
  contains_option: 'Zawiera opcję',
};
function operators(type: FieldType) {
  return [
    'is_set',
    'is_unset',
    'eq',
    'neq',
    ...(type === 'text' ? ['contains', 'prefix'] : []),
    ...(['number', 'date'].includes(type) ? ['gte', 'lte'] : []),
    ...(type === 'multi_select' ? ['contains_option'] : []),
  ];
}
export function OrderFieldListControls({
  refresh,
  onChange,
}: {
  refresh: number;
  onChange: (selection: OrderFieldListSelection) => void;
}) {
  const catalog = useCatalog(refresh, false),
    [columnIds, setColumns] = useState<string[]>([]),
    [filters, setFilters] = useState<
      { field_id: string; operator: string; value: string | string[] }[]
    >([]),
    [error, setError] = useState(''),
    [applied, setApplied] = useState(false);
  const defs = catalog.data?.data.filter((d) => d.enabled) ?? [];
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    setColumns([]);
    setFilters([]);
    setApplied(false);
    callback.current({ columns: [], filters: [] });
  }, [catalog.data?.current_role, refresh]);
  function apply() {
    try {
      const typed: OrderFieldFilter[] = filters.map((f) => {
        const d = defs.find((d) => d.id === f.field_id);
        if (!d) throw Error('Wybierz dostępne pole filtra.');
        if (!operators(d.type).includes(f.operator))
          throw Error('Operator nie obsługuje tego typu.');
        if (['is_set', 'is_unset'].includes(f.operator))
          return { field_id: d.id, definition_version: d.version, operator: f.operator };
        let value: string | string[];
        if (['contains', 'prefix'].includes(f.operator)) {
          if (typeof f.value !== 'string' || [...f.value].length < 3 || f.value.length > 100)
            throw Error('Filtr tekstowy wymaga 3–100 znaków.');
          value = f.value;
        } else if (f.operator === 'contains_option') {
          if (typeof f.value !== 'string' || !d.options.some((o) => o.id === f.value))
            throw Error('Wybierz konkretną opcję filtra.');
          value = f.value;
        } else value = prepareValue(d, f.value, true).value;
        return { field_id: d.id, definition_version: d.version, operator: f.operator, value };
      });
      const columns = columnIds.map((id) => defs.find((d) => d.id === id)!);
      if (columns.some((d) => !d)) throw Error('Kolumna nie jest aktualnie dostępna.');
      setError('');
      callback.current({ columns, filters: typed });
      setApplied(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <details className="order-fields">
      <summary>Dodatkowe pola: kolumny i filtry</summary>
      <div className="of-review">
        <CatalogStatus catalog={catalog} />
        {catalog.data?.available && (
          <>
            <h3>Kolumny w wybranej kolejności: {columnIds.length} / 10</h3>
            <div className="of-options">
              {defs.map((d) => (
                <label className="of-check" key={d.id}>
                  <input
                    type="checkbox"
                    checked={columnIds.includes(d.id)}
                    disabled={!columnIds.includes(d.id) && columnIds.length >= 10}
                    onChange={(e) => {
                      setColumns((old) =>
                        e.target.checked ? [...old, d.id] : old.filter((id) => id !== d.id),
                      );
                      setApplied(false);
                    }}
                  />
                  {d.label}
                </label>
              ))}
            </div>
            {columnIds.map((id, i) => (
              <div className="of-actions" key={id}>
                <span>
                  {i + 1}. {defs.find((d) => d.id === id)?.label}
                </span>
                <button
                  type="button"
                  className="button"
                  disabled={!i}
                  onClick={() => {
                    setColumns((old) => {
                      const next = [...old];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      return next;
                    });
                    setApplied(false);
                  }}
                >
                  Przesuń wcześniej
                </button>
              </div>
            ))}
            <h3>Warunki AND: {filters.length} / 5</h3>
            {filters.map((f, i) => {
              const d = defs.find((d) => d.id === f.field_id);
              function update(next: typeof f) {
                setFilters((old) => old.map((v, n) => (n === i ? next : v)));
                setApplied(false);
              }
              return (
                <div className="of-option" key={i}>
                  <div className="of-grid">
                    <label>
                      Pole
                      <select
                        value={f.field_id}
                        onChange={(e) =>
                          update({ field_id: e.target.value, operator: 'is_set', value: '' })
                        }
                      >
                        <option value="">Wybierz pole</option>
                        {defs.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Warunek
                      <select
                        value={f.operator}
                        disabled={!d}
                        onChange={(e) =>
                          update({
                            ...f,
                            operator: e.target.value,
                            value: d?.type === 'multi_select' ? [] : '',
                          })
                        }
                      >
                        {(d ? operators(d.type) : ['is_set']).map((op) => (
                          <option key={op} value={op}>
                            {operatorNames[op]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {d &&
                    !['is_set', 'is_unset'].includes(f.operator) &&
                    (f.operator === 'contains_option' ? (
                      <select
                        value={String(f.value)}
                        onChange={(e) => update({ ...f, value: e.target.value })}
                      >
                        <option value="">Wybierz opcję</option>
                        {d.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                            {!o.enabled ? ' (wycofana)' : ''}
                          </option>
                        ))}
                      </select>
                    ) : d.type === 'file' ? (
                      <label>
                        Dokładny identyfikator własnego pliku
                        <input
                          value={String(f.value)}
                          onChange={(e) => update({ ...f, value: e.target.value })}
                        />
                      </label>
                    ) : (
                      <FieldControl
                        definition={{
                          ...d,
                          options: d.options.map((o) => ({ ...o, enabled: true })),
                        }}
                        value={f.value}
                        disabled={false}
                        change={(value) => update({ ...f, value })}
                      />
                    ))}
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setFilters((old) => old.filter((_, n) => n !== i));
                      setApplied(false);
                    }}
                  >
                    Usuń warunek
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="button"
              disabled={filters.length >= 5}
              onClick={() => {
                setFilters((old) => [...old, { field_id: '', operator: 'is_set', value: '' }]);
                setApplied(false);
              }}
            >
              Dodaj warunek
            </button>
            <p>
              Filtry pól są łączone ze zwykłymi filtrami listy. Wyświetlane są wyłącznie pola
              dostępne Twojej aktualnej roli.
            </p>
            {error && <p className="error">{error}</p>}
            <div className="of-actions">
              <button type="button" className="button primary" onClick={apply}>
                Zastosuj kolumny i filtry
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setColumns([]);
                  setFilters([]);
                  setError('');
                  setApplied(false);
                  callback.current({ columns: [], filters: [] });
                }}
              >
                Wyczyść
              </button>
            </div>
            {applied && <p role="status">Ustawienia pól zastosowane do listy.</p>}
          </>
        )}
      </div>
    </details>
  );
}
export function OrderFieldCell({
  definition,
  value,
}: {
  definition: FieldDefinition;
  value?: {
    type: FieldType;
    value: string | string[] | null;
    definition_version: number;
    options_snapshot?: { id: string; label: string }[];
    file?: FieldFile;
  };
}) {
  return (
    <span className="order-field-cell">
      {value?.value !== null && value?.value !== undefined
        ? valueText(definition, value as FieldValue)
        : 'Nie ustawiono'}
    </span>
  );
}
