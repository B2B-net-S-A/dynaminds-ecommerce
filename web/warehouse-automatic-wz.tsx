import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import type { AutomaticWzConfiguration as Configuration, AutomaticWzSettings as Settings, AutomaticWzSnapshot as Snapshot, AutomaticWzPreview as Preview, AutomaticWzOperation as Operation, AutomaticWzWarehouse as Warehouse } from '../server/warehouse-automatic-wz-schema';
import './warehouse-automatic-wz.css';

const base = '/warehouse-automatic-wz';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) < 9223372036854775807n;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
type Flags = { available: boolean; configuration_available: boolean; issuer_available: boolean; current_role: 'admin' | 'operator' | 'viewer' | null; can_read: boolean; can_manage: boolean; read_only: boolean };
type Options = Flags & { warehouses: (Warehouse & { configuration: Configuration })[]; next_cursor: string | null; limits: { warehouses: number; page: number } };
type Reply = Flags & { reused?: boolean; preview?: Preview; operation?: Operation };
type Attempt = { context: string; kind: 'preview' | 'commit'; warehouseId: string; path: string; body: string; preview?: Preview };
type History = Flags & { kind: 'preview' | 'operation'; data: (Preview | Operation)[]; next_cursor: string | null };
const defaultSettings: Settings = { enabled: false, moment: 'physical_dispatch', series_name: 'Wydania zewnętrzne', prefix: 'WZ' };

let context = '', epoch = 0, inFlight = false;
let pending: Attempt | null = null, outcome: Reply | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(fn => fn());
export function resetWarehouseAutomaticWzContext(next: string) {
  if (context === next) return;
  context = next; epoch++; inFlight = false; pending = null; outcome = null; publish();
}
export function warehouseAutomaticWzLocked(key: string) { return context === key && Boolean(pending || inFlight); }
export function subscribeWarehouseAutomaticWzLock(key: string, callback: (locked: boolean) => void) {
  const notify = () => callback(warehouseAutomaticWzLocked(key));
  listeners.add(notify); notify(); return () => { listeners.delete(notify); };
}
function purge(key: string) { if (context === key) { epoch++; pending = null; outcome = null; inFlight = false; publish(); } }
function checkFlags(d: Flags, key: string) {
  if (!d || ['available', 'configuration_available', 'issuer_available', 'can_read', 'can_manage', 'read_only'].some(k => typeof d[k as keyof Flags] !== 'boolean') || (d.current_role !== null && !['admin', 'operator', 'viewer'].includes(d.current_role))) throw Error('Niepełny odczyt uprawnień do konfiguracji WZ.');
  if (d.current_role !== null && d.current_role !== key.split(':')[2]) throw new ApiError('Zmieniła się rola użytkownika.', 403);
  if (d.available !== d.configuration_available) throw Error('Niezgodna dostępność konfiguracji WZ.');
}
async function actor(key: string) {
  const parts = key.split(':'), d = await api('/auth/me');
  if (parts.length !== 4 || !uuid(parts[0]) || !uuid(parts[1]) || !['admin', 'operator', 'viewer'].includes(parts[2]) || !['true', 'false'].includes(parts[3]) || `${d.user?.tenant_id}:${d.user?.id}:${d.user?.role}` !== parts.slice(0, 3).join(':')) throw new ApiError('Zmieniła się firma lub użytkownik.', 403);
}
function validSettings(s: Settings) {
  return Boolean(s && typeof s.enabled === 'boolean' && s.moment === 'physical_dispatch' && typeof s.series_name === 'string' && s.series_name === s.series_name.trim() && s.series_name.length >= 2 && s.series_name.length <= 80 && !/[\p{Cc}\p{Cs}]/u.test(s.series_name) && typeof s.prefix === 'string' && /^[A-Z0-9][A-Z0-9_-]{1,23}$/.test(s.prefix));
}
function sameSettings(a: Settings | null, b: Settings | null) {
  return a === null || b === null ? a === b : validSettings(a) && validSettings(b) && a.enabled === b.enabled && a.moment === b.moment && a.series_name === b.series_name && a.prefix === b.prefix;
}
function checkConfiguration(c: Configuration, warehouseId: string) {
  if (!c || c.warehouse_id !== warehouseId || !version(c.version) || (c.version === '0' ? c.series_id !== null || c.settings !== null : !uuid(c.series_id) || !c.settings || !validSettings(c.settings))) throw Error('Niepełna konfiguracja i seria WZ magazynu.');
}
function sameConfiguration(a: Configuration, b: Configuration) {
  return a.warehouse_id === b.warehouse_id && a.version === b.version && a.series_id === b.series_id && sameSettings(a.settings, b.settings);
}
function checkSnapshot(s: Snapshot, warehouseId: string) {
  if (!s || s.warehouse?.id !== warehouseId || typeof s.warehouse.name !== 'string' || typeof s.warehouse.code !== 'string') throw Error('Brak magazynu w zapisanej konfiguracji WZ.');
  checkConfiguration(s.before, warehouseId); checkConfiguration(s.after, warehouseId);
  if (s.after.version !== String(BigInt(s.before.version) + 1n) || (s.before.series_id !== null && s.after.series_id !== s.before.series_id)) throw Error('Zapis nie zachowuje wersji lub serii tego magazynu.');
}
function checkPreview(p: Preview) {
  if (!p || !uuid(p.id) || !uuid(p.warehouse_id) || !uuid(p.client_key) || !hash(p.scope_hash) || !p.request || p.request.client_key !== p.client_key || !version(p.request.expected_version) || !validSettings(p.request.settings) || typeof p.ready !== 'boolean' || typeof p.can_commit !== 'boolean' || (p.operation_id !== null && !uuid(p.operation_id)) || !timestamp(p.created_at) || !timestamp(p.expires_at)) throw Error('Niepełny zapisany podgląd konfiguracji WZ. Dokładna próba pozostaje zachowana.');
  checkSnapshot(p.snapshot, p.warehouse_id);
  if (p.snapshot.before.version !== p.request.expected_version || !sameSettings(p.request.settings, p.snapshot.after.settings)) throw Error('Podgląd nie odpowiada wysłanej konfiguracji WZ.');
}
function checkOperation(o: Operation) {
  if (!o || !uuid(o.id) || !uuid(o.warehouse_id) || !uuid(o.preview_id) || !uuid(o.client_key) || !uuid(o.revision_id) || !hash(o.scope_hash) || o.request?.client_key !== o.client_key || o.request.scope_hash !== o.scope_hash || o.request.confirmed !== true || !timestamp(o.created_at)) throw Error('Niepełne trwałe potwierdzenie konfiguracji WZ.');
  checkSnapshot(o.snapshot, o.warehouse_id); checkConfiguration(o.before, o.warehouse_id); checkConfiguration(o.after, o.warehouse_id);
  if (!sameConfiguration(o.before, o.snapshot.before) || !sameConfiguration(o.after, o.snapshot.after)) throw Error('Potwierdzenie nie odpowiada zapisanej rewizji WZ.');
}
function checkOptions(d: Options, key: string) {
  checkFlags(d, key);
  if (!Array.isArray(d.warehouses) || d.warehouses.length > 50 || new Set(d.warehouses.map(w => w.id)).size !== d.warehouses.length || (d.next_cursor !== null && !uuid(d.next_cursor)) || !d.limits || !Number.isInteger(d.limits.warehouses) || d.limits.warehouses < 1 || d.limits.warehouses > 200 || d.limits.page !== 50) throw Error('Niepełna strona magazynów konfiguracji WZ.');
  for (const w of d.warehouses) { if (!uuid(w.id) || typeof w.name !== 'string' || typeof w.code !== 'string') throw Error('Niepełny odczyt magazynu.'); checkConfiguration(w.configuration, w.id); }
}
function validateReply(d: Reply, a: Attempt) {
  checkFlags(d, a.context);
  if (typeof d.reused !== 'boolean' || !d.available || !d.can_read || d.read_only) throw Error('Brak potwierdzenia dokładnej próby WZ.');
  const b = JSON.parse(a.body);
  if (a.kind === 'preview') {
    if (!d.preview) throw Error('Brak trwałego podglądu WZ.'); checkPreview(d.preview);
    if (d.preview.warehouse_id !== a.warehouseId || d.preview.client_key !== b.client_key || d.preview.request.expected_version !== b.expected_version || !sameSettings(d.preview.request.settings, b.settings)) throw Error('Podgląd WZ nie odpowiada dokładnej próbie.');
  } else {
    if (!d.operation || !a.preview) throw Error('Brak trwałego wyniku zgody na konfigurację WZ.'); checkOperation(d.operation);
    const o = d.operation, p = a.preview;
    if (o.warehouse_id !== a.warehouseId || o.preview_id !== p.id || o.client_key !== b.client_key || o.scope_hash !== p.scope_hash || b.scope_hash !== p.scope_hash || b.confirmed !== true || !sameConfiguration(o.before, p.snapshot.before) || !sameConfiguration(o.after, p.snapshot.after) || o.snapshot.warehouse.id !== p.snapshot.warehouse.id || o.snapshot.warehouse.name !== p.snapshot.warehouse.name || o.snapshot.warehouse.code !== p.snapshot.warehouse.code) throw Error('Zapisana konfiguracja WZ nie odpowiada dokładnej zgodzie.');
  }
}
async function write(a: Attempt, retry: boolean, allowed: () => boolean): Promise<Reply | null> {
  if (context !== a.context || a.context.split(':')[3] !== 'false' || inFlight || (retry ? pending !== a : pending !== null) || !allowed()) return null;
  const e = epoch; inFlight = true; publish(); let sent = false;
  try {
    await actor(a.context); const access = await api<Options>(base + '/options?limit=50');
    if (context !== a.context || epoch !== e) return null; checkOptions(access, a.context);
    if (!access.available || !access.can_manage || access.current_role !== 'admin' || access.read_only) throw new ApiError('Brak aktualnego prawa do konfiguracji WZ.', access.read_only ? 423 : 403);
    if (!allowed()) throw Error('Inny zapis lub zmiana trybu wstrzymały świeżą konfigurację WZ.');
    pending = a; sent = true; publish();
    const d = await api<Reply>(a.path, 'POST', JSON.parse(a.body));
    if (context !== a.context || epoch !== e) return null; validateReply(d, a);
    await actor(a.context); const latest = await api<Options>(base + '/options?limit=50');
    if (context !== a.context || epoch !== e) return null; checkOptions(latest, a.context);
    if (!latest.can_read || !latest.can_manage || latest.read_only || !latest.available) throw new ApiError('Odebrano dostęp do konfiguracji WZ.', latest.read_only ? 423 : 403);
    outcome = { ...d, ...flagsOnly(latest) }; pending = null; return outcome;
  } catch (err) {
    if (context === a.context && epoch === e && err instanceof ApiError) {
      if ([401, 403].includes(err.status)) purge(a.context);
      else if (sent && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) pending = null;
    }
    throw err;
  } finally { if (context === a.context && epoch === e) { inFlight = false; publish(); } }
}
function flagsOnly(d: Flags): Flags { return { available: d.available, configuration_available: d.configuration_available, issuer_available: d.issuer_available, current_role: d.current_role, can_read: d.can_read, can_manage: d.can_manage, read_only: d.read_only }; }
function ConfigurationView({ configuration: c }: { configuration: Configuration }) {
  return <dl className="waw-summary"><dt>Wersja konfiguracji</dt><dd>{c.version}</dd><dt>Automatyczne WZ</dt><dd>{c.settings?.enabled ? 'Włączone w konfiguracji' : 'Wyłączone w konfiguracji'}</dd><dt>Moment wystawienia</dt><dd>{c.settings ? 'Fizyczne wydanie towaru do wysyłki' : 'Nie skonfigurowano'}</dd><dt>Seria magazynu</dt><dd>{c.settings ? `${c.settings.series_name} · prefiks ${c.settings.prefix}` : 'Powstanie przy pierwszym zapisie konfiguracji'}</dd>{c.series_id && <><dt>Identyfikator serii</dt><dd>{c.series_id}</dd></>}</dl>;
}
export type WarehouseAutomaticWzPanelProps = { contextKey: string; available: boolean; readOnly: boolean; externalWriteBlocked?: boolean; refresh?: number; onLockedChange?: (locked: boolean) => void; onChanged?: () => void };

export function WarehouseAutomaticWzPanel(props: WarehouseAutomaticWzPanelProps) {
  const scope = props.contextKey;
  const [options, setOptions] = useState<Options | null>(null), [warehouses, setWarehouses] = useState<Options['warehouses']>([]), [cursor, setCursor] = useState<string | null>(null), [selected, setSelected] = useState(''), [draft, setDraft] = useState<Settings>({ ...defaultSettings }), [preview, setPreview] = useState<Preview | null>(null), [operation, setOperation] = useState<Operation | null>(null), [consent, setConsent] = useState(false), [historyKind, setHistoryKind] = useState<'preview' | 'operation'>('operation'), [history, setHistory] = useState<(Preview | Operation)[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null), [reading, setReading] = useState(false), [error, setError] = useState(''), [signal, setSignal] = useState(0), [loadedScope, setLoadedScope] = useState(''), [loadedEpoch, setLoadedEpoch] = useState(-1);
  const alive = useRef(false), generation = useRef(0), scopeRef = useRef(scope), latest = useRef(props), applied = useRef<Reply | null>(null);
  scopeRef.current = scope; latest.current = props;
  const current = (g: number, e: number) => alive.current && scopeRef.current === scope && generation.current === g && context === scope && epoch === e;
  const locked = warehouseAutomaticWzLocked(scope), retained = context === scope ? pending : null;
  const visible = context === scope && loadedScope === scope && loadedEpoch === epoch;
  const writable = Boolean(visible && props.available && !props.readOnly && scope.split(':')[3] === 'false' && options?.available && options.can_manage && options.current_role === 'admin' && !options.read_only);
  const freshBlocked = !writable || locked || props.externalWriteBlocked || reading;
  const baseline = warehouses.find(w => w.id === selected);
  function clear() { setOptions(null); setWarehouses([]); setCursor(null); setSelected(''); setDraft({ ...defaultSettings }); setPreview(null); setOperation(null); setConsent(false); setHistory([]); setHistoryCursor(null); setLoadedScope(''); setLoadedEpoch(-1); }
  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : 'Nie udało się odczytać konfiguracji WZ.'); setConsent(false);
    if (err instanceof ApiError && [401, 403].includes(err.status)) { purge(scope); clear(); }
    else if (err instanceof ApiError && err.status === 503) { clear(); }
  }
  async function loadOptions(more = false, preserveReview = false) {
    if (!props.available) return;
    const g = ++generation.current, e = epoch, oldCursor = cursor; setReading(true); setError('');
    try {
      await actor(scope); const d = await api<Options>(base + '/options?limit=50' + (more && oldCursor ? '&cursor=' + oldCursor : ''));
      if (!current(g, e)) return; checkOptions(d, scope); if (!d.can_read) throw new ApiError('Brak prawa do odczytu konfiguracji WZ.', 403);
      if (more && (d.next_cursor === oldCursor || d.warehouses.some(w => warehouses.some(old => old.id === w.id)))) throw Error('Powtórzona strona magazynów WZ.');
      if ((more ? warehouses.length : 0) + d.warehouses.length > d.limits.warehouses) throw Error('Odczyt przekracza limit magazynów WZ.');
      setOptions(d); setWarehouses(v => more ? [...v, ...d.warehouses] : d.warehouses); setCursor(d.next_cursor); setLoadedScope(scope); setLoadedEpoch(e);
      if (!more && !preserveReview) {
        setPreview(null); setOperation(outcome?.operation ?? null); setConsent(false);
        if (outcome?.operation) applied.current = outcome;
      }
    } catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && generation.current === g && scopeRef.current === scope) setReading(false); }
  }
  useEffect(() => { alive.current = true; generation.current++; resetWarehouseAutomaticWzContext(scope); applied.current = outcome?.operation ? null : outcome; clear(); const off = subscribeWarehouseAutomaticWzLock(scope, () => setSignal(n => n + 1)); void loadOptions(); return () => { alive.current = false; generation.current++; off(); }; }, [scope, props.readOnly, props.available, props.refresh]);
  useEffect(() => { props.onLockedChange?.(locked); }, [locked, signal, props.onLockedChange]);
  useEffect(() => { if (loadedEpoch !== -1 && loadedEpoch !== epoch) clear(); }, [signal, loadedEpoch]);
  useEffect(() => { if (!visible || !options?.can_read || !outcome || applied.current === outcome) return; applied.current = outcome; setConsent(false); setPreview(outcome.preview ?? null); setOperation(outcome.operation ?? null); }, [visible, options, signal]);
  function choose(id: string) {
    if (reading || locked) return; const w = warehouses.find(w => w.id === id);
    setSelected(id); setDraft(w?.configuration.settings ? { ...w.configuration.settings } : { ...defaultSettings }); setPreview(null); setOperation(null); setConsent(false); setHistory([]); setHistoryCursor(null);
  }
  function change(next: Settings) { if (freshBlocked) return; setDraft(next); setPreview(null); setOperation(null); setConsent(false); }
  async function mutate(a: Attempt, retry = false) {
    if (props.readOnly || reading || (!retry && freshBlocked)) return;
    const g = generation.current, e = epoch; setError(''); setConsent(false);
    const allowed = () => alive.current && scopeRef.current === scope && latest.current.contextKey === scope && latest.current.available && !latest.current.readOnly && (retry || !latest.current.externalWriteBlocked);
    try {
      const d = await write(a, retry, allowed); if (!d || !current(g, e)) return;
      applied.current = outcome; setPreview(d.preview ?? null); setOperation(d.operation ?? null);
      // An exact replay acknowledges the historical operation. Its after-image
      // cannot replace the separately read current warehouse configuration.
      if (d.operation) { await loadOptions(false, true); if (alive.current && scopeRef.current === scope && context === scope && epoch === e) latest.current.onChanged?.(); }
    } catch (err) {
      const denied = err instanceof ApiError && [401, 403].includes(err.status);
      if (alive.current && scopeRef.current === scope && context === scope && generation.current === g && (current(g, e) || denied)) {
        // write() already purged this actor on denial; its changed epoch must
        // hide old data without also hiding the reason for the denial.
        if (denied) { setError(err.message); setConsent(false); clear(); } else fail(err);
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) setPreview(null);
      }
    }
  }
  function prepare() {
    const settings = { ...draft, series_name: draft.series_name.trim() };
    if (!baseline || !validSettings(settings)) return;
    void mutate({ context: scope, kind: 'preview', warehouseId: baseline.id, path: base + '/warehouses/' + baseline.id + '/previews', body: JSON.stringify({ client_key: crypto.randomUUID(), expected_version: baseline.configuration.version, settings }) });
  }
  async function readSaved(path: string, apply: (d: Reply | History) => void) {
    const g = ++generation.current, e = epoch; setReading(true); setError('');
    try {
      await actor(scope); const access = await api<Options>(base + '/options?limit=50'); if (!current(g, e)) return; checkOptions(access, scope); if (!access.can_read || !access.available) throw new ApiError('Brak prawa do odczytu zapisów WZ.', 403);
      const d = await api<Reply | History>(path); if (!current(g, e)) return; checkFlags(d, scope); if (!d.can_read) throw new ApiError('Odebrano prawo do odczytu zapisów WZ.', 403);
      await actor(scope); const latestOptions = await api<Options>(base + '/options?limit=50'); if (!current(g, e)) return; checkOptions(latestOptions, scope); if (!latestOptions.can_read || !latestOptions.available) throw new ApiError('Odebrano prawo do odczytu zapisów WZ.', 403);
      setOptions(latestOptions); setConsent(false); apply(d);
    } catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && scopeRef.current === scope && generation.current === g) setReading(false); }
  }
  function readHistory(more = false) {
    const kind = historyKind, warehouseId = selected, oldCursor = historyCursor;
    void readSaved(base + '/history?kind=' + kind + '&limit=50' + (warehouseId ? '&warehouse_id=' + warehouseId : '') + (more && oldCursor ? '&cursor=' + oldCursor : ''), raw => {
      const d = raw as History;
      if (d.kind !== kind || !Array.isArray(d.data) || d.data.length > 50 || new Set(d.data.map(h => h.id)).size !== d.data.length || (d.next_cursor !== null && !uuid(d.next_cursor)) || (more && (d.next_cursor === oldCursor || d.data.some(h => history.some(old => old.id === h.id))))) throw Error('Niepełna lub powtórzona strona historii WZ.');
      for (const h of d.data) { if (kind === 'preview') checkPreview(h as Preview); else checkOperation(h as Operation); if (warehouseId && h.warehouse_id !== warehouseId) throw Error('Historia wskazuje inny magazyn.'); }
      setHistory(v => more ? [...v, ...d.data] : d.data); setHistoryCursor(d.next_cursor);
    });
  }
  const reviewBlocked = Boolean(freshBlocked || !preview?.ready || !preview.can_commit || preview.operation_id || Date.parse(preview.expires_at) <= Date.now());
  return <section className="panel warehouse-automatic-wz" aria-label="Automatyczne dokumenty WZ"><header><h3>Automatyczne dokumenty WZ</h3><p>Każdy magazyn ma jedną serię WZ, tworzoną przy pierwszym zapisie konfiguracji. Dokument powstaje przy fizycznym wydaniu towaru, jeśli wystawianie jest dostępne.</p></header><div className="waw-body">
    {error && <p role="alert">{error}</p>}
    {!props.available && <p>Konfiguracja automatycznych WZ nie jest dostępna w tej kopii.</p>}
    {inFlight && context === scope && <p role="status">Trwa zapis konfiguracji WZ. Poczekaj na potwierdzenie wyniku.</p>}
    {retained && !inFlight && <div className="waw-review"><p role="status">Wynik zapisu konfiguracji WZ jest niepewny. Zachowano dokładną próbę; nie rozpoczynaj nowego zapisu.</p><button className="button" type="button" disabled={!writable || reading} onClick={() => void mutate(retained, true)}>Ponów dokładną próbę konfiguracji WZ</button></div>}
    {props.available && <button className="button" type="button" disabled={reading || inFlight} onClick={() => void loadOptions()}>Odczytaj konfiguracje WZ</button>}
    {visible && options && <>
      {!options.available && <p>Konfiguracja automatycznych WZ nie jest dostępna w tej kopii.</p>}
      <p role="status">{options.issuer_available ? 'Wystawianie WZ przy wydaniu jest dostępne. Obowiązuje zapisana konfiguracja magazynu.' : 'Wystawianie WZ przy wydaniu nie jest jeszcze dostępne. Zapis konfiguracji nie uruchamia wysyłki ani ruchu magazynowego.'}</p>
      {(props.readOnly || options.read_only) && <p>Kopia tylko do odczytu — konfigurację i historię można przeglądać.</p>}
      <label>Magazyn automatycznych WZ<select value={selected} disabled={reading || locked} onChange={e => choose(e.target.value)}><option value="">Wybierz magazyn</option>{warehouses.map(w => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></label>
      {cursor && <button className="button" type="button" disabled={reading || inFlight} onClick={() => void loadOptions(true)}>Dalsze magazyny WZ</button>}
      {baseline && <><h4>Aktualna konfiguracja magazynu {baseline.name} ({baseline.code})</h4><ConfigurationView configuration={baseline.configuration}/><fieldset disabled={Boolean(freshBlocked)}><legend>Nowa konfiguracja WZ</legend><label className="waw-check"><input type="checkbox" checked={draft.enabled} onChange={e => change({ ...draft, enabled: e.target.checked })}/>Włącz automatyczne WZ dla tego magazynu</label><p>Moment wystawienia: fizyczne wydanie towaru do wysyłki. Samo spakowanie lub kupienie etykiety nie wystawia WZ.</p><label>Nazwa serii WZ<input value={draft.series_name} maxLength={80} onChange={e => change({ ...draft, series_name: e.target.value })}/></label><label>Prefiks serii WZ<input value={draft.prefix} maxLength={24} onChange={e => change({ ...draft, prefix: e.target.value })}/></label><p>Prefiks: od 2 do 24 wielkich liter, cyfr, znaków „_” lub „-”. Numer dokumentu zostanie nadany podczas rzeczywistego wydania towaru.</p><button className="button" type="button" disabled={!validSettings({ ...draft, series_name: draft.series_name.trim() })} onClick={prepare}>Przygotuj podgląd konfiguracji WZ</button></fieldset></>}
      {preview && <div className="waw-review"><h4>Pełny zapisany podgląd konfiguracji WZ</h4><p>{preview.snapshot.warehouse.name} ({preview.snapshot.warehouse.code}) · podgląd {preview.id} · ważny do {date(preview.expires_at)}</p><h5>Przed zmianą</h5><ConfigurationView configuration={preview.snapshot.before}/><h5>Po zatwierdzeniu</h5><ConfigurationView configuration={preview.snapshot.after}/><label className="waw-check"><input type="checkbox" checked={consent} disabled={reviewBlocked} onChange={e => setConsent(e.target.checked)}/>Sprawdziłem magazyn, serię i moment wystawienia. Zatwierdzam tę konfigurację WZ.</label><button className="button primary" type="button" disabled={reviewBlocked || !consent} onClick={() => void mutate({ context: scope, kind: 'commit', warehouseId: preview.warehouse_id, path: base + '/previews/' + preview.id + '/commit', body: JSON.stringify({ client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true }), preview: structuredClone(preview) })}>Zapisz zatwierdzoną konfigurację WZ</button></div>}
      {operation && <div className="waw-review"><h4>Konfiguracja WZ zapisana — historyczna wersja {operation.after.version}</h4><p>{operation.snapshot.warehouse.name} ({operation.snapshot.warehouse.code}) · operacja {operation.id} · {date(operation.created_at)}</p><h5>Przed zmianą</h5><ConfigurationView configuration={operation.before}/><h5>Zapisana konfiguracja</h5><ConfigurationView configuration={operation.after}/><p>To trwałe potwierdzenie konfiguracji. Nie potwierdza wystawienia dokumentu WZ ani wysyłki.</p></div>}
      {options.available && <div><h4>Historia konfiguracji WZ</h4><label>Rodzaj historii WZ<select value={historyKind} disabled={reading || inFlight} onChange={e => { setHistoryKind(e.target.value as typeof historyKind); setHistory([]); setHistoryCursor(null); setConsent(false); }}><option value="operation">Zapisane konfiguracje</option><option value="preview">Podglądy</option></select></label><button className="button" type="button" disabled={reading || inFlight} onClick={() => readHistory()}>Odczytaj historię WZ</button><ul className="waw-history">{history.map(h => <li key={historyKind + ':' + h.id}>{h.snapshot.warehouse.name} · {date(h.created_at)} <button className="button" type="button" disabled={reading || inFlight} onClick={() => void readSaved(base + (historyKind === 'preview' ? '/previews/' : '/operations/') + h.id, raw => { const d = raw as Reply; if (historyKind === 'preview') { if (!d.preview) throw Error('Brak zapisanego podglądu WZ.'); checkPreview(d.preview); if (d.preview.id !== h.id || d.preview.warehouse_id !== h.warehouse_id || d.preview.client_key !== h.client_key) throw Error('Odczytano inny podgląd WZ.'); setPreview(d.preview); setOperation(null); } else { if (!d.operation) throw Error('Brak zapisanej operacji WZ.'); checkOperation(d.operation); if (d.operation.id !== h.id || d.operation.warehouse_id !== h.warehouse_id || d.operation.client_key !== h.client_key) throw Error('Odczytano inną operację WZ.'); setOperation(d.operation); setPreview(null); } })}>Otwórz pełny zapis WZ {h.id}</button></li>)}</ul>{historyCursor && <button className="button" type="button" disabled={reading || inFlight} onClick={() => readHistory(true)}>Dalsza historia WZ</button>}</div>}
    </>}
  </div></section>;
}
