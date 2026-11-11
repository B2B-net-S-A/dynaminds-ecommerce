import { useEffect, useRef, useState } from 'react';
import './catalog-stock-control.css';
import { api, ApiError, date } from './api';
import type { CatalogStockControlFlags as Flags, CatalogStockControlSource as Source, CatalogStockControlSnapshot as Snapshot, CatalogStockControlPreview as Preview, CatalogStockControlOperation as Operation, CatalogStockControlBoDocument as BoDocument, CatalogStockControlRow as StockRow, CatalogStockControlTotals as Totals } from '../server/catalog-stock-control-schema';

// The registry is independent of mount/navigation and contains no persistent data.
type Attempt = { context: string; kind: 'preview' | 'commit'; catalogId: string; path: string; body: string; preview?: Preview };
let context = '', epoch = 0, inFlight = false;
let pending: Attempt | null = null;
let outcome: Reply | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(notify => notify());
export function resetCatalogStockControlContext(next: string) {
  if (context === next) return;
  context = next; epoch++; inFlight = false; pending = null; outcome = null; publish();
}
export function catalogStockControlLocked(key: string) {
  return context === key && Boolean(pending || inFlight);
}
export function subscribeCatalogStockControlLock(key: string, callback: (locked: boolean) => void) {
  const notify = () => callback(catalogStockControlLocked(key));
  listeners.add(notify); notify(); return () => { listeners.delete(notify); };
}
function purge(key: string) {
  if (context !== key) return;
  epoch++; pending = null; outcome = null; inFlight = false; publish();
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
async function actor(key: string) {
  const p = key.split(':'), d = await api('/auth/me');
  if (p.length !== 4 || !uuid(p[0]) || !uuid(p[1]) || !['admin', 'operator', 'viewer'].includes(p[2]) || !['true', 'false'].includes(p[3]) || `${d.user?.tenant_id}:${d.user?.id}:${d.user?.role}` !== p.slice(0, 3).join(':')) throw new ApiError('Zmieniła się firma, użytkownik lub rola.', 403);
}
function money(value: string, currency: string, exponent: number) {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value) || !/^[A-Z]{3}$/.test(currency) || !Number.isInteger(exponent) || exponent < 0 || exponent > 6) throw Error('Niepełna zapisana wycena BO.');
  const n = BigInt(value), absolute = n < 0n ? -n : n, scale = 10n ** BigInt(exponent);
  return `${n < 0n ? '−' : ''}${(absolute / scale).toLocaleString('pl-PL')}${exponent ? ',' + (absolute % scale).toString().padStart(exponent, '0') : ''} ${currency}`;
}
export type CatalogStockControlPanelProps = {
  contextKey: string; available: boolean; readOnly: boolean; refresh?: number;
  externalWriteBlocked?: boolean; catalogId?: string;
  onChanged?: () => void; onLockedChange?: (locked: boolean) => void;
};

const base = '/catalog-stock-control';
type Reply = Flags & { reused?: boolean; preview?: Preview; operation?: Operation; document?: BoDocument };
type RowPage = Flags & { data: StockRow[]; meta: { cursor: number | null; limit: number; total: number; scope_hash?: string; document_id?: string } };
type History = Flags & { data: Operation[]; meta: { cursor: string | null; limit: number } };
type Catalog = { id: string; name: string; active: boolean };
const numeric = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= 9223372036854775807n;
const valueKeys = new Set(['unit_cost_minor', 'value_minor', 'known_value_minor', 'known_quantity', 'zero_cost_quantity', 'unknown_quantity', 'currency', 'exponent', 'rows_sha256']);
function withoutValues<T>(v: T): T {
  if (Array.isArray(v)) return v.map(withoutValues) as T;
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !valueKeys.has(k)).map(([k, x]) => [k, withoutValues(x)])) as T;
  return v;
}
function flags(d: Flags, key: string) {
  if (!d || ['available', 'activation_available', 'writers_available', 'can_read', 'can_manage', 'can_read_value', 'read_only'].some(k => typeof d[k as keyof Flags] !== 'boolean') || !['admin', 'operator', 'viewer'].includes(d.current_role)) throw Error('Niepełny odczyt uprawnień ścisłej kontroli.');
  if (d.current_role !== key.split(':')[2] || String(d.read_only) !== key.split(':')[3]) throw new ApiError('Zmieniła się rola lub tryb kopii.', 403);
  if (!d.can_read) throw new ApiError('Odebrano dostęp do bilansu otwarcia.', 403);
}
function totals(t: Totals) {
  if (!t || !numeric(t.physical_quantity) || !numeric(t.reserved_quantity) || BigInt(t.reserved_quantity) > BigInt(t.physical_quantity)) throw Error('Niepełne ilości bilansu otwarcia.');
  const cost = ['known_quantity', 'zero_cost_quantity', 'unknown_quantity', 'known_value_minor', 'currency', 'exponent'];
  if (cost.some(k => Object.hasOwn(t, k))) {
    if (!numeric(t.known_quantity) || !numeric(t.zero_cost_quantity) || !numeric(t.unknown_quantity) || !numeric(t.known_value_minor) || typeof t.currency !== 'string' || !/^[A-Z]{3}$/.test(t.currency) || !Number.isInteger(t.exponent) || t.exponent! < 0 || t.exponent! > 6 || BigInt(t.known_quantity) + BigInt(t.unknown_quantity) !== BigInt(t.physical_quantity) || BigInt(t.zero_cost_quantity) > BigInt(t.known_quantity)) throw Error('Niepełna lub niespójna historyczna wycena BO.');
  }
}
function snapshot(s: Snapshot) {
  if (!s || !uuid(s.catalog?.id) || typeof s.catalog.name !== 'string' || !version(s.catalog.version) || s.policy?.catalog_id !== s.catalog.id || !version(s.policy.version) || typeof s.policy.strict !== 'boolean' || (s.policy.operation_id !== null && !uuid(s.policy.operation_id)) || typeof s.wms_enabled !== 'boolean' || !Number.isInteger(s.row_count) || s.row_count < 0 || s.row_count > 10000 || !Array.isArray(s.warehouses) || s.warehouses.length > 100 || new Set(s.warehouses.map(w => w.id)).size !== s.warehouses.length || (s.rows_sha256 !== undefined && !digest(s.rows_sha256))) throw Error('Niepełny zakres katalogu i magazynów BO.');
  for (const w of s.warehouses) if (!uuid(w.id) || typeof w.name !== 'string' || typeof w.code !== 'string' || !['sale', 'custody'].includes(w.policy?.usage) || typeof w.policy.enabled !== 'boolean' || !version(w.policy.version) || (w.policy.version === '0' && (w.policy.usage !== 'sale' || !w.policy.enabled)) || !w.series || (w.series.id !== null && !uuid(w.series.id)) || !version(w.series.version) || typeof w.series.name !== 'string' || !w.series.name.length || typeof w.series.prefix !== 'string' || !w.series.prefix.length) throw Error('Niepełna polityka magazynu lub seria BO.');
  totals(s.summary);
}
function same(a: unknown, b: unknown) {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, ordered(x)])) : v;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}
function checkPreview(p: Preview) {
  if (!p || !uuid(p.id) || !uuid(p.catalog_id) || !uuid(p.client_key) || !digest(p.scope_hash) || p.request?.client_key !== p.client_key || !version(p.request.catalog_version) || !version(p.request.policy_version) || !timestamp(p.created_at) || !timestamp(p.expires_at) || typeof p.ready !== 'boolean' || typeof p.can_commit !== 'boolean' || (p.operation_id !== null && !uuid(p.operation_id)) || !Array.isArray(p.blockers) || p.blockers.some(b => typeof b.code !== 'string' || typeof b.message !== 'string')) throw Error('Niepełny zapisany podgląd aktywacji. Dokładna próba pozostaje zachowana.');
  snapshot(p.snapshot);
  const warehouses = [...p.snapshot.warehouses].sort((a, b) => a.id.localeCompare(b.id));
  if (p.catalog_id !== p.snapshot.catalog.id || p.row_count !== p.snapshot.row_count || p.request.catalog_version !== p.snapshot.catalog.version || p.request.policy_version !== p.snapshot.policy.version || !same(p.request.warehouse_policy_versions, warehouses.map(w => ({ warehouse_id: w.id, version: w.policy.version }))) || !same(p.request.series_versions, warehouses.map(w => ({ warehouse_id: w.id, version: w.series.version })))) throw Error('Podgląd nie odpowiada wskazanym wersjom katalogu i magazynów.');
}
function checkRows(data: StockRow[], s: Snapshot, local = false) {
  if (!Array.isArray(data) || (!local && data.length !== s.row_count) || data.length > 10000) throw Error('Nie odczytano wszystkich pozycji BO.');
  let quantity = 0n, reserved = 0n, known = 0n, zero = 0n, unknown = 0n, value = 0n;
  for (const [i, r] of data.entries()) {
    if (r.ordinal !== i || !s.warehouses.some(w => w.id === r.warehouse_id) || !uuid(r.product_id) || typeof r.sku !== 'string' || typeof r.name !== 'string' || typeof r.location !== 'string' || !Number.isSafeInteger(r.quantity) || r.quantity <= 0 || !Number.isSafeInteger(r.reserved) || r.reserved < 0 || r.reserved > r.quantity || !version(r.stock_version) || !digest(r.bin_basis_hash) || (s.wms_enabled ? !uuid(r.layer_id) || !uuid(r.lot_id) || !version(r.position_version) : r.layer_id !== null || r.lot_id !== null || r.position_version !== null)) throw Error('Niepełna lub obca pozycja bilansu otwarcia.');
    quantity += BigInt(r.quantity); reserved += BigInt(r.reserved);
    if (s.summary.currency !== undefined) {
      if (!Object.hasOwn(r, 'unit_cost_minor') || !Object.hasOwn(r, 'value_minor') || r.currency !== s.summary.currency || r.exponent !== s.summary.exponent || (r.unit_cost_minor !== null && !numeric(r.unit_cost_minor))) throw Error('Niepełna wycena pozycji BO.');
      if (r.unit_cost_minor === null) { if (r.value_minor !== null) throw Error('Nieznany koszt nie może mieć wartości.'); unknown += BigInt(r.quantity); }
      else { const expected = BigInt(r.quantity) * BigInt(r.unit_cost_minor!); if (r.value_minor !== expected.toString()) throw Error('Niespójna wartość pozycji BO.'); value += expected; known += BigInt(r.quantity); if (r.unit_cost_minor === '0') zero += BigInt(r.quantity); }
    }
  }
  if (!local && (quantity.toString() !== s.summary.physical_quantity || reserved.toString() !== s.summary.reserved_quantity || (s.summary.currency !== undefined && [known.toString(), zero.toString(), unknown.toString(), value.toString()].join(':') !== [s.summary.known_quantity, s.summary.zero_cost_quantity, s.summary.unknown_quantity, s.summary.known_value_minor].join(':')))) throw Error('Pełne pozycje nie pokrywają podsumowania BO.');
}
function checkDocument(d: BoDocument) {
  if (!d || !uuid(d.id) || !uuid(d.operation_id) || !uuid(d.catalog_id) || d.kind !== 'BO' || !uuid(d.warehouse?.id) || !uuid(d.series_id) || !version(d.series_version) || d.series_version === '0' || !numeric(d.sequence) || d.sequence === '0' || !Number.isInteger(d.year) || d.year < 2000 || d.year > 9999 || !Number.isInteger(d.row_count) || d.row_count < 0 || d.row_count > 10000 || !timestamp(d.created_at) || d.number !== `${d.warehouse.series.prefix}/${d.year}/${d.sequence.padStart(6, '0')}`) throw Error('Niepełny numerowany dokument BO.');
  totals(d.summary);
}
function checkOperation(o: Operation) {
  if (!o || !uuid(o.id) || !uuid(o.catalog_id) || !uuid(o.preview_id) || !uuid(o.client_key) || !digest(o.scope_hash) || o.request?.client_key !== o.client_key || o.request.scope_hash !== o.scope_hash || o.request.confirmed !== true || !timestamp(o.created_at) || !Array.isArray(o.documents) || new Set(o.documents.map(d => d.id)).size !== o.documents.length) throw Error('Niepełne trwałe potwierdzenie aktywacji katalogu.');
  snapshot(o.snapshot);
  if (o.catalog_id !== o.snapshot.catalog.id || !same(o.before, o.snapshot.policy) || o.before.version !== '0' || o.before.strict || o.before.operation_id !== null || o.after.catalog_id !== o.catalog_id || o.after.version !== '1' || o.after.strict !== true || o.after.operation_id !== o.id || o.documents.length !== o.snapshot.warehouses.length) throw Error('Potwierdzenie nie odpowiada pierwszej aktywacji tego katalogu.');
  let count = 0, quantity = 0n, reserved = 0n, known = 0n, zero = 0n, unknown = 0n, value = 0n;
  for (const w of o.snapshot.warehouses) {
    const docs = o.documents.filter(d => d.warehouse.id === w.id);
    if (docs.length !== 1) throw Error('Brakuje BO jednego z przypisanych magazynów.');
    const d = docs[0]; checkDocument(d);
    if (d.operation_id !== o.id || d.catalog_id !== o.catalog_id || !same(d.warehouse, w) || (w.series.id !== null && d.series_id !== w.series.id) || (w.series.id === null && d.series_version !== '1') || (w.series.id !== null && d.series_version !== w.series.version)) throw Error('BO wskazuje inny katalog, magazyn lub serię.');
    count += d.row_count; quantity += BigInt(d.summary.physical_quantity); reserved += BigInt(d.summary.reserved_quantity);
    if (o.snapshot.summary.currency !== undefined) {
      if (d.summary.currency !== o.snapshot.summary.currency || d.summary.exponent !== o.snapshot.summary.exponent || !numeric(d.summary.known_quantity) || !numeric(d.summary.zero_cost_quantity) || !numeric(d.summary.unknown_quantity) || !numeric(d.summary.known_value_minor)) throw Error('BO nie pokrywa zapisanej wyceny katalogu.');
      known += BigInt(d.summary.known_quantity); zero += BigInt(d.summary.zero_cost_quantity); unknown += BigInt(d.summary.unknown_quantity); value += BigInt(d.summary.known_value_minor);
    }
  }
  if (count !== o.snapshot.row_count || quantity.toString() !== o.snapshot.summary.physical_quantity || reserved.toString() !== o.snapshot.summary.reserved_quantity || (o.snapshot.summary.currency !== undefined && [known.toString(), zero.toString(), unknown.toString(), value.toString()].join(':') !== [o.snapshot.summary.known_quantity, o.snapshot.summary.zero_cost_quantity, o.snapshot.summary.unknown_quantity, o.snapshot.summary.known_value_minor].join(':'))) throw Error('Dokumenty BO nie pokrywają pełnego zatwierdzonego zakresu.');
}
function validateReply(d: Reply, a: Attempt) {
  flags(d, a.context);
  if (typeof d.reused !== 'boolean' || !d.available || d.read_only) throw Error('Brak potwierdzenia dokładnej próby aktywacji.');
  const b = JSON.parse(a.body);
  if (a.kind === 'preview') {
    if (!d.preview) throw Error('Brak zapisanego podglądu BO.'); checkPreview(d.preview);
    if (d.preview.catalog_id !== a.catalogId || !same(d.preview.request, b)) throw Error('Podgląd nie odpowiada dokładnej próbie.');
  } else {
    if (!d.operation || !a.preview) throw Error('Brak trwałego wyniku zatwierdzenia BO.'); checkOperation(d.operation);
    if (d.operation.preview_id !== a.preview.id || d.operation.catalog_id !== a.catalogId || !same(d.operation.request, b) || d.operation.scope_hash !== a.preview.scope_hash || !same(withoutValues(d.operation.snapshot), withoutValues(a.preview.snapshot))) throw Error('Aktywacja nie odpowiada zatwierdzonemu podglądowi.');
  }
}
function TotalsView({ value: t }: { value: Totals }) {
  return <dl><dt>Ilość fizyczna</dt><dd>{t.physical_quantity}</dd><dt>Zarezerwowane</dt><dd>{t.reserved_quantity}</dd>{t.currency !== undefined && t.known_value_minor !== undefined ? <><dt>Znana wartość</dt><dd>{money(t.known_value_minor, t.currency, t.exponent!)}</dd><dt>Sztuki o znanym koszcie</dt><dd>{t.known_quantity} · w tym koszt zero: {t.zero_cost_quantity}</dd><dt>Sztuki o nieznanym koszcie</dt><dd>{t.unknown_quantity}</dd></> : <><dt>Wycena</dt><dd>Wycena niedostępna</dd></>}</dl>;
}
function RowsView({ data }: { data: StockRow[] }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [data]);
  return <><div style={{ overflowX: 'auto' }}><table className="data-table"><caption>Wszystkie zapisane pozycje BO: {data.length}</caption><thead><tr><th>Produkt i UUID</th><th>Magazyn</th><th>Lokalizacja</th><th>Ilość fizyczna</th><th>Rezerwacja</th><th>Pochodzenie warstwy</th><th>Koszt jednostkowy</th></tr></thead><tbody>{data.slice(page * 100, (page + 1) * 100).map(r => <tr key={r.ordinal}><td>{r.name} · {r.sku}<small>{r.product_id}</small></td><td>{r.warehouse_id}</td><td>{r.location}</td><td>{r.quantity}</td><td>{r.reserved}</td><td>{r.layer_id ?? 'Bez śledzenia partii'}{r.lot_id && <small>{r.lot_id}</small>}</td><td>{r.unit_cost_minor === null ? 'Koszt nieznany' : r.unit_cost_minor !== undefined && r.currency ? money(r.unit_cost_minor, r.currency, r.exponent!) : 'Wycena niedostępna'}</td></tr>)}</tbody></table></div><p>Strona {page + 1} / {Math.max(1, Math.ceil(data.length / 100))}. Podgląd obejmuje cały odczytany zakres.</p><button className="button" type="button" disabled={page === 0} onClick={() => setPage(v => v - 1)}>Poprzednie pozycje BO</button><button className="button" type="button" disabled={(page + 1) * 100 >= data.length} onClick={() => setPage(v => v + 1)}>Następne pozycje BO</button></>;
}

export function CatalogStockControlPanel(props: CatalogStockControlPanelProps) {
  const scope = props.contextKey;
  const [catalogs, setCatalogs] = useState<Catalog[]>([]), [selected, setSelected] = useState(''), [access, setAccess] = useState<Flags | null>(null), [source, setSource] = useState<Source | null>(null), [preview, setPreview] = useState<Preview | null>(null), [previewRows, setPreviewRows] = useState<StockRow[] | null>(null), [operation, setOperation] = useState<Operation | null>(null), [document, setDocument] = useState<BoDocument | null>(null), [documentRows, setDocumentRows] = useState<StockRow[] | null>(null), [history, setHistory] = useState<Operation[]>([]), [cursor, setCursor] = useState<string | null>(null), [consent, setConsent] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState(''), [signal, setSignal] = useState(0), [loaded, setLoaded] = useState(''), [format, setFormat] = useState<'csv' | 'xml'>('csv'), [includeValues, setIncludeValues] = useState(false), [handoff, setHandoff] = useState('');
  const alive = useRef(false), generation = useRef(0), latest = useRef(props), applied = useRef<Reply | null>(null), known = useRef<Flags | null>(null);
  latest.current = props;
  const current = (g: number, e: number) => alive.current && latest.current.contextKey === scope && context === scope && epoch === e && generation.current === g;
  const locked = catalogStockControlLocked(scope), retained = context === scope ? pending : null;
  const visible = context === scope && loaded === scope;
  const writable = Boolean(visible && props.available && !props.readOnly && access?.available && access.activation_available && access.writers_available && access.can_manage && access.current_role === 'admin' && !access.read_only);
  const freshBlocked = Boolean(!writable || props.externalWriteBlocked || locked || reading);
  function clear() { setCatalogs([]); setSelected(''); setSource(null); setPreview(null); setPreviewRows(null); setOperation(null); setDocument(null); setDocumentRows(null); setHistory([]); setCursor(null); setConsent(false); setIncludeValues(false); setAccess(null); known.current = null; setLoaded(''); setHandoff(''); setReading(false); }
  function observe(d: Flags) {
    flags(d, scope);
    if (!d.can_read_value) {
      setSource(v => v && withoutValues(v)); setPreview(v => v && withoutValues(v)); setPreviewRows(v => v && withoutValues(v)); setOperation(v => v && withoutValues(v)); setDocument(v => v && withoutValues(v)); setDocumentRows(v => v && withoutValues(v)); setHistory(v => withoutValues(v)); setIncludeValues(false);
      if (context === scope) { if (outcome) outcome = withoutValues(outcome); if (pending?.preview) pending.preview = withoutValues(pending.preview); }
    }
    known.current = d; setAccess(d); return d;
  }
  function fail(err: unknown) {
    if (err instanceof ApiError && [401, 403].includes(err.status)) { purge(scope); clear(); }
    setError(err instanceof Error ? err.message : 'Nie udało się odczytać lub zapisać BO.');
  }
  async function grant(catalogId: string) {
    await actor(scope); const d = await api<History>(`${base}/history?catalog_id=${catalogId}&limit=1`); await actor(scope); flags(d, scope); return d;
  }
  async function read<T extends Flags>(catalogId: string, path: string, g: number, e: number): Promise<T | null> {
    const early = await grant(catalogId); if (!current(g, e)) return null; observe(early);
    const d = await api<T>(path); if (!current(g, e)) return null; flags(d, scope); observe(d);
    const last = await grant(catalogId); if (!current(g, e)) return null;
    const value = early.can_read_value && d.can_read_value && last.can_read_value;
    observe({ ...last, can_read_value: value });
    return { ...(value ? d : withoutValues(d)), can_read_value: value };
  }
  async function paged(catalogId: string, kind: 'previews' | 'documents', id: string, count: number, pin: string, g: number, e: number) {
    let offset = 0; const all: StockRow[] = []; let value = true;
    do {
      const d = await read<RowPage>(catalogId, `${base}/${kind}/${id}/rows?limit=100&cursor=${offset}`, g, e); if (!d) return null;
      if (!Array.isArray(d.data) || d.data.length > 100 || d.meta?.total !== count || d.meta.limit !== 100 || (kind === 'previews' ? d.meta.scope_hash !== pin : d.meta.document_id !== id) || d.data.some((r, i) => r.ordinal !== offset + i) || (d.meta.cursor !== null && d.meta.cursor !== offset + d.data.length) || (d.meta.cursor !== null && d.data.length === 0) || all.length + d.data.length > count) throw Error('Niepełna, obca lub powtórzona strona pozycji BO.');
      if (!d.can_read_value || !known.current?.can_read_value) value = false;
      all.push(...d.data); if (d.meta.cursor === null) break; offset = d.meta.cursor;
    } while (all.length <= count);
    if (all.length !== count) throw Error('Nie odczytano wszystkich pozycji BO.');
    return value ? all : withoutValues(all);
  }
  async function load() {
    const g = ++generation.current, e = epoch; setReading(true); setError('');
    try {
      await actor(scope); const d = await api('/product-catalogs/options'); if (!current(g, e)) return;
      if (!d.available || !d.can_read || !Array.isArray(d.catalogs) || d.catalogs.length > 100 || new Set(d.catalogs.map((c: Catalog) => c.id)).size !== d.catalogs.length || d.catalogs.some((c: Catalog) => !uuid(c.id) || typeof c.name !== 'string' || typeof c.active !== 'boolean')) throw Error('Niepełna lista własnych katalogów.');
      await actor(scope); if (!current(g, e)) return; setCatalogs(d.catalogs); setLoaded(scope);
      const wanted = retained?.catalogId ?? props.catalogId ?? (selected || outcome?.operation?.catalog_id || outcome?.preview?.catalog_id); if (wanted && d.catalogs.some((c: Catalog) => c.id === wanted)) { setSelected(wanted); const fresh = await grant(wanted); if (!current(g, e)) return; observe(fresh); }
      if (outcome?.operation && context === scope && current(g, e)) { const saved = known.current?.can_read_value ? outcome : withoutValues(outcome); checkOperation(saved.operation!); setOperation(saved.operation!); applied.current = outcome; }
    } catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && latest.current.contextKey === scope && generation.current === g) setReading(false); }
  }
  useEffect(() => {
    alive.current = true; resetCatalogStockControlContext(scope); clear(); applied.current = null; generation.current++;
    const notify = () => setSignal(v => v + 1); listeners.add(notify);
    if (props.available) void load();
    return () => { alive.current = false; generation.current++; listeners.delete(notify); };
  }, [scope, props.available, props.refresh]);
  useEffect(() => props.onLockedChange?.(locked), [locked, signal, props.onLockedChange]);
  useEffect(() => { if (context === scope && outcome && outcome !== applied.current && known.current?.can_read) { applied.current = outcome; const saved = known.current.can_read_value ? outcome : withoutValues(outcome); setPreview(saved.preview ?? null); setOperation(saved.operation ?? null); setConsent(false); } }, [signal]);
  async function select(id: string) {
    if (reading || locked || !catalogs.some(c => c.id === id)) return;
    const g = ++generation.current, e = epoch; setReading(true); setSelected(id); setSource(null); setPreview(null); setPreviewRows(null); setOperation(null); setDocument(null); setDocumentRows(null); setHistory([]); setCursor(null); setConsent(false); setError(''); setHandoff('');
    try { const d = await grant(id); if (current(g, e)) observe(d); } catch (err) { if (current(g, e)) fail(err); }
    finally { if (current(g, e)) setReading(false); }
  }
  async function loadSource() {
    if (!selected || reading || inFlight) return; const g = ++generation.current, e = epoch; setReading(true); setError(''); setSource(null); setPreview(null); setPreviewRows(null); setConsent(false);
    try { const d = await read<Flags & { source: Source }>(selected, `${base}/catalogs/${selected}/source`, g, e); if (!d) return; snapshot(d.source.snapshot); if (d.source.snapshot.catalog.id !== selected || !Array.isArray(d.source.blockers) || d.source.blockers.some(b => typeof b.code !== 'string' || typeof b.message !== 'string') || typeof d.source.ready !== 'boolean' || typeof d.source.can_preview !== 'boolean') throw Error('Niepełny rzeczywisty stan katalogu.'); setSource(d.source); }
    catch (err) { if (current(g, e)) fail(err); } finally { if (current(g, e)) setReading(false); }
  }
  async function openPreview(id: string, catalogId: string, g: number, e: number) {
    const d = await read<Reply>(catalogId, `${base}/previews/${id}`, g, e); if (!d?.preview) return; checkPreview(d.preview); if (d.preview.id !== id || d.preview.catalog_id !== catalogId) throw Error('Odczytano inny podgląd BO.');
    const data = await paged(catalogId, 'previews', id, d.preview.row_count, d.preview.scope_hash, g, e); if (!data || !current(g, e)) return;
    const last = await read<Reply>(catalogId, `${base}/previews/${id}`, g, e); if (!last?.preview) return; checkPreview(last.preview); if (!same(withoutValues(last.preview.snapshot), withoutValues(d.preview.snapshot)) || last.preview.scope_hash !== d.preview.scope_hash) throw Error('Podgląd zmienił się w trakcie odczytu pozycji.');
    const p = known.current?.can_read_value ? last.preview : withoutValues(last.preview), full = known.current?.can_read_value ? data : withoutValues(data); checkRows(full, p.snapshot); setPreview(p); setPreviewRows(full); setOperation(null); setDocument(null); setDocumentRows(null); setConsent(false);
  }
  async function mutate(a: Attempt, retry = false) {
    if (!props.available || props.readOnly || reading || inFlight || context !== scope || (retry ? pending !== a : freshBlocked)) return;
    const g = generation.current, e = epoch; const allowed = () => current(g, e) && latest.current.available && !latest.current.readOnly && (retry || !latest.current.externalWriteBlocked);
    setError(''); setConsent(false); inFlight = true; publish(); let sent = false;
    try {
      const before = await grant(a.catalogId); if (!current(g, e)) return; observe(before);
      if (!before.available || !before.activation_available || !before.writers_available || !before.can_manage || before.current_role !== 'admin' || before.read_only) throw new ApiError('Brak aktualnego prawa do aktywacji katalogu.', before.read_only ? 423 : 403);
      if (!allowed()) throw Error('Inna operacja wstrzymała świeżą aktywację katalogu.');
      pending = a; sent = true; publish(); const reply = await api<Reply>(a.path, 'POST', JSON.parse(a.body)); if (!current(g, e)) return; flags(reply, scope); observe(reply);
      const d = reply.can_read_value ? reply : withoutValues(reply); validateReply(d, a);
      const after = await grant(a.catalogId); if (!current(g, e)) return; observe(after);
      if (!after.can_manage || after.read_only || !after.available) throw new ApiError('Odebrano prawo do aktywacji katalogu.', after.read_only ? 423 : 403);
      const value = before.can_read_value && reply.can_read_value && after.can_read_value;
      observe({ ...after, can_read_value: value });
      outcome = value ? d : withoutValues(d); pending = null; applied.current = outcome; setPreview(outcome.preview ?? null); setOperation(outcome.operation ?? null); setPreviewRows(null); publish();
      if (outcome.preview) { setReading(true); await openPreview(outcome.preview.id, a.catalogId, g, e); }
      if (outcome.operation && current(g, e)) latest.current.onChanged?.();
    } catch (err) {
      const denied = err instanceof ApiError && [401, 403].includes(err.status);
      if (context === scope && epoch === e && sent && err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) pending = null;
      if (alive.current && latest.current.contextKey === scope && generation.current === g && (current(g, e) || denied)) fail(err);
    } finally { if (context === scope && epoch === e) { inFlight = false; publish(); } if (alive.current && latest.current.contextKey === scope && generation.current === g) setReading(false); }
  }
  function prepare() {
    if (!source?.ready || !source.can_preview || source.snapshot.policy.strict || freshBlocked) return;
    const s = source.snapshot, warehouses = [...s.warehouses].sort((a, b) => a.id.localeCompare(b.id));
    void mutate({ context: scope, kind: 'preview', catalogId: selected, path: `${base}/catalogs/${selected}/previews`, body: JSON.stringify({ client_key: crypto.randomUUID(), catalog_version: s.catalog.version, policy_version: s.policy.version, warehouse_policy_versions: warehouses.map(w => ({ warehouse_id: w.id, version: w.policy.version })), series_versions: warehouses.map(w => ({ warehouse_id: w.id, version: w.series.version })) }) });
  }
  async function readHistory(more = false) {
    if (!selected || reading || inFlight) return; const g = ++generation.current, e = epoch, old = cursor; setReading(true); setError(''); setConsent(false);
    try { const d = await read<History>(selected, `${base}/history?catalog_id=${selected}&limit=50${more && old ? '&cursor=' + encodeURIComponent(old) : ''}`, g, e); if (!d) return;
      if (!Array.isArray(d.data) || d.data.length > 50 || d.meta?.limit !== 50 || (d.meta.cursor !== null && !uuid(d.meta.cursor)) || new Set(d.data.map(o => o.id)).size !== d.data.length || (more && (d.meta.cursor === old || d.data.some(o => history.some(h => h.id === o.id)))) || (d.meta.cursor !== null && d.data.length === 0)) throw Error('Niepełna lub powtórzona strona historii aktywacji.');
      for (const o of d.data) { checkOperation(o); if (o.catalog_id !== selected) throw Error('Historia wskazuje inny katalog.'); } setHistory(v => more ? [...v, ...d.data] : d.data); setCursor(d.meta.cursor);
    } catch (err) { if (current(g, e)) fail(err); } finally { if (current(g, e)) setReading(false); }
  }
  async function openOperation(id: string) {
    const g = ++generation.current, e = epoch; setReading(true); setError(''); setConsent(false);
    try { const d = await read<Reply>(selected, `${base}/operations/${id}`, g, e); if (!d?.operation) return; checkOperation(d.operation); if (d.operation.id !== id || d.operation.catalog_id !== selected) throw Error('Odczytano inną aktywację katalogu.'); setOperation(d.operation); setPreview(null); setPreviewRows(null); }
    catch (err) { if (current(g, e)) fail(err); } finally { if (current(g, e)) setReading(false); }
  }
  async function openDocument(head: BoDocument) {
    if (!operation || operation.id !== head.operation_id) return;
    const origin = operation;
    const g = ++generation.current, e = epoch; setReading(true); setError(''); setDocument(null); setDocumentRows(null); setConsent(false); setHandoff('');
    try { const d = await read<Reply>(head.catalog_id, `${base}/documents/${head.id}`, g, e); if (!d?.document) return; checkDocument(d.document); if (!same(withoutValues(head), withoutValues(d.document))) throw Error('BO nie odpowiada zapisanej aktywacji.');
      const data = await paged(head.catalog_id, 'documents', head.id, head.row_count, head.id, g, e); if (!data || !current(g, e)) return;
      const last = await read<Reply>(head.catalog_id, `${base}/documents/${head.id}`, g, e); if (!last?.document) return; if (!same(withoutValues(last.document), withoutValues(d.document))) throw Error('Odczytano zmieniony dokument BO.');
      const doc = known.current?.can_read_value ? last.document : withoutValues(last.document), full = known.current?.can_read_value ? data : withoutValues(data); const s: Snapshot = { ...origin.snapshot, warehouses: [doc.warehouse], row_count: doc.row_count, summary: doc.summary }; checkRows(full, s);
      const expected = new Set<number>(); for (const row of full) { const ordinal = row.source_ordinal; if (ordinal === undefined || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= origin.snapshot.row_count || expected.has(ordinal)) throw Error('BO nie zachowuje oryginalnych pozycji podglądu.'); expected.add(ordinal); }
      setDocument(doc); setDocumentRows(full);
    } catch (err) { if (current(g, e)) fail(err); } finally { if (current(g, e)) setReading(false); }
  }
  async function download() {
    if (!document || !documentRows || reading || inFlight) return; const g = ++generation.current, e = epoch, head = document; setReading(true); setError(''); setHandoff('');
    try { const d = await read<Flags & { document: BoDocument; format: 'csv' | 'xml'; values_included: boolean; filename: string; content_type: string; content: string; row_count: number }>(head.catalog_id, `${base}/documents/${head.id}/export?format=${format}&include_values=${includeValues}`, g, e); if (!d) return;
      if (includeValues && !known.current?.can_read_value) throw new ApiError('Odebrano prawo do wyceny eksportu BO.', 403);
      if (!same(withoutValues(d.document), withoutValues(head)) || d.format !== format || d.row_count !== head.row_count || typeof d.values_included !== 'boolean' || d.values_included !== Boolean(includeValues && head.summary.currency) || typeof d.content !== 'string' || new TextEncoder().encode(d.content).byteLength > 8388608 || !/^[A-Za-z0-9_.-]+$/.test(d.filename) || !d.filename.endsWith('.' + format) || d.content_type !== (format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8')) throw Error('Niepełny lub obcy pełny eksport BO.');
      const final = await grant(head.catalog_id); if (!current(g, e)) return; observe(final); if (includeValues && !final.can_read_value) throw new ApiError('Odebrano prawo do wyceny eksportu BO.', 403);
      const url = URL.createObjectURL(new Blob([d.content], { type: d.content_type })); const a = window.document.createElement('a'); a.href = url; a.download = d.filename; a.click(); URL.revokeObjectURL(url); setHandoff('Przekazano plik do przeglądarki. Sprawdź jego zapis w pobranych plikach.');
    } catch (err) { if (current(g, e)) fail(err); } finally { if (current(g, e)) setReading(false); }
  }
  const reviewBlocked = Boolean(freshBlocked || !preview?.ready || !preview.can_commit || preview.operation_id || !previewRows || Date.parse(preview.expires_at) <= Date.now());
  return <section className="panel catalog-stock-control" aria-label="Ścisła kontrola katalogu"><header><h2>Ścisła kontrola katalogu i bilans otwarcia</h2><p>BO zapisuje istniejący zapas. Nie przyjmuje towaru, nie zmienia ilości ani nie aktywuje ponownie partii WMS.</p></header>
    {error && <p role="alert">{error}</p>}
    {!props.available && <p>Aktywacja ścisłej kontroli nie jest dostępna w tej kopii.</p>}
    {inFlight && context === scope && <p role="status">Trwa zapis aktywacji katalogu. Poczekaj na potwierdzenie.</p>}
    {retained && !inFlight && <div className="notice"><p role="status">Wynik zapisu jest niepewny. Zachowano dokładną próbę. Odczyt historii nie potwierdza tego zapisu.</p><button className="button" type="button" disabled={!writable || reading} onClick={() => void mutate(retained, true)}>Ponów dokładną próbę aktywacji</button></div>}
    {props.available && <button className="button" type="button" disabled={reading || inFlight} onClick={() => void load()}>Odczytaj katalogi do ścisłej kontroli</button>}
    {visible && <><label>Katalog ścisłej kontroli<select value={selected} disabled={reading || locked} onChange={e => void select(e.target.value)}><option value="">Wybierz katalog</option>{catalogs.map(c => <option key={c.id} value={c.id}>{c.name}{!c.active ? ' · nieaktywny' : ''}</option>)}</select></label>
      {access && !access.writers_available && <p>Aktywacja jest wstrzymana: obsługa dalszych dokumentów tego katalogu nie jest jeszcze dostępna.</p>}
      {(props.readOnly || access?.read_only) && <p>Kopia tylko do odczytu — można przeglądać historię i eksportować zapisane BO.</p>}
      {selected && <><button className="button" type="button" disabled={reading || inFlight || access?.current_role !== 'admin'} onClick={() => void loadSource()}>Odczytaj pełny stan katalogu do BO</button><button className="button" type="button" disabled={reading || inFlight} onClick={() => void readHistory()}>Odczytaj historię aktywacji katalogu</button></>}
      {source && <article><h3>{source.snapshot.catalog.name} · {source.snapshot.policy.strict ? 'Ścisła kontrola aktywna' : 'Ścisła kontrola nieaktywna'}</h3><TotalsView value={source.snapshot.summary}/><p>{source.snapshot.row_count} pozycji fizycznych · {source.snapshot.warehouses.length} przypisanych magazynów. SKU i jego historia pozostają unikalne w całej firmie.</p>{source.blockers.map(b => <p role="alert" key={b.code}>{b.message}</p>)}<button className="button" type="button" disabled={freshBlocked || !source.ready || !source.can_preview || source.snapshot.policy.strict} onClick={prepare}>Przygotuj podgląd aktywacji i BO</button></article>}
      {preview && <article className="notice"><h3>Pełny zapisany podgląd aktywacji i BO</h3><p>{preview.snapshot.catalog.name} · wersja {preview.snapshot.catalog.version} · ważny do {date(preview.expires_at)}</p><TotalsView value={preview.snapshot.summary}/><ul>{preview.snapshot.warehouses.map(w => <li key={w.id}>{w.name} ({w.code}) · {w.policy.usage === 'custody' ? 'Przechowanie — bez dostępności sprzedażowej' : 'Magazyn sprzedażowy'} · {w.policy.enabled ? 'włączony' : 'wyłączony'} · seria {w.series.prefix}. Numer BO powstanie przy zatwierdzeniu.</li>)}</ul>{preview.blockers.map(b => <p role="alert" key={b.code}>{b.message}</p>)}{previewRows ? <RowsView data={previewRows}/> : <button className="button" type="button" disabled={reading || inFlight} onClick={() => { const g = ++generation.current, e = epoch; setReading(true); void openPreview(preview.id, preview.catalog_id, g, e).catch(err => { if (current(g, e)) fail(err); }).finally(() => { if (current(g, e)) setReading(false); }); }}>Odczytaj wszystkie pozycje podglądu BO</button>}<p>Każdy przypisany magazyn otrzyma własny numerowany BO, także przy pustym zapasie. W tym etapie nie ma możliwości wyłączenia ścisłej kontroli.</p><label><input type="checkbox" checked={consent} disabled={reviewBlocked} onChange={e => setConsent(e.target.checked)}/>Sprawdziłem cały katalog i BO. Włączam ścisłą kontrolę bez zmiany ilości i bez możliwości jej wyłączenia w tym etapie.</label><button className="button primary" type="button" disabled={reviewBlocked || !consent} onClick={() => { if (!preview || reviewBlocked || !consent) return; void mutate({ context: scope, kind: 'commit', catalogId: preview.catalog_id, path: `${base}/previews/${preview.id}/commit`, body: JSON.stringify({ client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true }), preview: structuredClone(preview) }); }}>Włącz ścisłą kontrolę i zapisz BO</button></article>}
      {operation && <article><h3>Ścisła kontrola włączona — zapisany wynik</h3><p>{operation.snapshot.catalog.name} · wersja {operation.after.version} · {date(operation.created_at)} · potwierdzenie {operation.id}</p><p>Od tego momentu zmiany ilości wymagają właściwego dokumentu. BO nie jest dodatkowym przyjęciem towaru.</p><ul>{operation.documents.map(d => <li key={d.id}>{d.number} · {d.warehouse.name} · {d.row_count} pozycji · {d.summary.physical_quantity} szt.<button className="button" type="button" disabled={reading || inFlight} onClick={() => void openDocument(d)}>Otwórz BO {d.number}</button></li>)}</ul></article>}
      {document && documentRows && <article><h3>Pełny zapisany BO {document.number}</h3><p>{document.warehouse.name} ({document.warehouse.code}) · nazwy i polityka z dnia aktywacji · {date(document.created_at)}</p><TotalsView value={document.summary}/><RowsView data={documentRows}/><label>Format eksportu BO<select value={format} disabled={reading} onChange={e => { setFormat(e.target.value as typeof format); setHandoff(''); }}><option value="csv">CSV</option><option value="xml">XML</option></select></label><label><input type="checkbox" checked={includeValues} disabled={reading || !access?.can_read_value || !document.summary.currency} onChange={e => setIncludeValues(e.target.checked)}/>Dołącz historyczną wycenę BO</label><button className="button" type="button" disabled={reading || inFlight} onClick={() => void download()}>Pobierz pełny zapisany BO</button>{handoff && <p role="status">{handoff}</p>}</article>}
      <ul>{history.map(o => <li key={o.id}>{o.snapshot.catalog.name} · {date(o.created_at)}<button className="button" type="button" disabled={reading || inFlight} onClick={() => void openOperation(o.id)}>Otwórz aktywację katalogu {o.id}</button></li>)}</ul>{cursor && <button className="button" type="button" disabled={reading || inFlight} onClick={() => void readHistory(true)}>Dalsza historia aktywacji katalogu</button>}
    </>}
  </section>;
}
