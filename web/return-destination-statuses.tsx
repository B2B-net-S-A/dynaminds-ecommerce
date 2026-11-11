import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './return-destination-statuses.css';

const base = '/return-assistant/statuses';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const version = (v: unknown, zero = false): v is string => typeof v === 'string' && (zero ? /^(0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(v) && BigInt(v) <= 9223372036854775807n;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
type Settings = { name: string; color: string; active: boolean; decision: 'accept' | 'reject'; inventory_effect: 'sale' | 'custody' | 'none'; warehouse_id: string | null; warehouse_policy_version: string | null; default_location: string | null };
type Warehouse = { id: string; name: string; code: string; policy: { usage: 'sale' | 'custody'; enabled: boolean; version: string } };
type Status = { id: string; version: string; revision_id: string; settings: Settings; created_at: string; updated_at: string };
type Flags = { available: boolean; read_only: boolean; current_role: 'admin' | 'operator' | 'viewer' | null; can_read: boolean; can_manage: boolean; intake_available: boolean };
type Options = Flags & { warehouses: Warehouse[]; limits: Record<string, number> };
type PreviewInput = { client_key: string; kind: 'create' | 'update'; status_id?: string; version?: string; settings: Settings };
type PreviewSnapshot = { id: string; kind: 'create' | 'update'; status_id: string; request: PreviewInput; scope_hash: string; before: Status | null; after: { id: string; version: string; settings: Settings }; resources: { warehouse: Warehouse | null }; ready: boolean; created_at: string; expires_at: string };
type Preview = PreviewSnapshot & { can_commit: boolean; operation_id: string | null };
type CommitInput = { client_key: string; scope_hash: string; confirmed: true };
type Operation = { id: string; preview_id: string; status_id: string; kind: 'create' | 'update'; scope_hash: string; request: CommitInput; before: Status | null; after: Status; snapshot: PreviewSnapshot; created_at: string };
type Reply = Flags & { reused: boolean; preview?: Preview; operation?: Operation; status?: Status };
type Head = { id: string; preview_id: string; status_id: string; kind: 'create' | 'update'; version: string; created_at: string };
type Attempt = { context: string; kind: 'preview' | 'commit'; path: string; body: string; preview?: Preview };

let context = '', epoch = 0, inFlight = false;
let pending: Attempt | null = null;
let outcome: Reply | null = null;
const subscribers = new Set<() => void>();
const publish = () => subscribers.forEach(fn => fn());
export function resetReturnDestinationStatusesContext(next: string) {
  if (context === next) return;
  context = next; epoch++; pending = null; outcome = null; inFlight = false; publish();
}
export function returnDestinationStatusesWriteLocked(key: string) { return context === key && Boolean(pending || inFlight); }
export function subscribeReturnDestinationStatusesLock(key: string, callback: (locked: boolean) => void) {
  const notify = () => callback(returnDestinationStatusesWriteLocked(key));
  subscribers.add(notify); notify(); return () => { subscribers.delete(notify); };
}
function purge(key: string) { if (context !== key) return; epoch++; pending = null; outcome = null; inFlight = false; publish(); }
function checkFlags(d: Flags, key: string) {
  if (!d || ['available', 'read_only', 'can_read', 'can_manage', 'intake_available'].some(k => typeof d[k as keyof Flags] !== 'boolean') || (d.current_role !== null && !['admin', 'operator', 'viewer'].includes(d.current_role))) throw Error('Niepełny odczyt uprawnień statusów zwrotu.');
  if (d.current_role !== null && d.current_role !== key.split(':')[2]) throw new ApiError('Zmieniła się rola użytkownika.', 403);
}
async function actor(key: string) {
  const parts = key.split(':'), d = await api('/auth/me');
  if (parts.length !== 4 || !uuid(parts[0]) || !uuid(parts[1]) || !['true', 'false'].includes(parts[3]) || `${d.user?.tenant_id}:${d.user?.id}:${d.user?.role}` !== parts.slice(0, 3).join(':')) throw new ApiError('Zmieniła się firma lub użytkownik.', 403);
}
const safeText = (v: string) => !/[\u0000-\u001f\u007f\p{Cs}]/u.test(v);
function validSettings(s: Settings): boolean {
  if (!s || typeof s.name !== 'string' || s.name.trim().length < 2 || s.name.length > 120 || !safeText(s.name) || !/^#[a-f0-9]{6}$/.test(s.color) || typeof s.active !== 'boolean') return false;
  return s.decision === 'reject' ? s.inventory_effect === 'none' && s.warehouse_id === null && s.warehouse_policy_version === null && s.default_location === null
    : s.decision === 'accept' && ['sale', 'custody'].includes(s.inventory_effect) && uuid(s.warehouse_id) && version(s.warehouse_policy_version, true) && typeof s.default_location === 'string' && s.default_location.trim().length > 0 && s.default_location.length <= 80 && safeText(s.default_location);
}
const equalSettings = (a: Settings, b: Settings) => validSettings(a) && validSettings(b) && (['name', 'color', 'active', 'decision', 'inventory_effect', 'warehouse_id', 'warehouse_policy_version', 'default_location'] as const).every(k => a[k] === b[k]);
const samePreviewInput = (a: PreviewInput, b: PreviewInput) => a.client_key === b.client_key && a.kind === b.kind && a.status_id === b.status_id && a.version === b.version && equalSettings(a.settings, b.settings);
function checkWarehouse(w: Warehouse) {
  if (!w || !uuid(w.id) || typeof w.name !== 'string' || typeof w.code !== 'string' || !w.policy || !['sale', 'custody'].includes(w.policy.usage) || typeof w.policy.enabled !== 'boolean' || !version(w.policy.version, true)) throw Error('Niepełna polityka magazynu docelowego.');
}
function checkStatus(s: Status) { if (!s || !uuid(s.id) || !uuid(s.revision_id) || !version(s.version) || !validSettings(s.settings)) throw Error('Niepełna zapisana rewizja statusu.'); }
const sameStatus = (a: Status | null, b: Status | null) => a === null || b === null ? a === b : a.id === b.id && a.revision_id === b.revision_id && a.version === b.version && a.created_at === b.created_at && a.updated_at === b.updated_at && equalSettings(a.settings, b.settings);
function checkSnapshot(p: PreviewSnapshot) {
  if (!p || !uuid(p.id) || !uuid(p.status_id) || !hash(p.scope_hash) || !['create', 'update'].includes(p.kind) || p.request?.kind !== p.kind || !uuid(p.request?.client_key) || !equalSettings(p.request.settings, p.after?.settings) || p.after.id !== p.status_id || !version(p.after.version) || p.ready !== true || !Number.isFinite(Date.parse(p.expires_at)) || !p.resources) throw Error('Niepełny zapisany podgląd statusu. Dokładna próba została zachowana.');
  if (p.kind === 'create') { if (p.before !== null || p.after.version !== '1' || p.request.status_id !== undefined || p.request.version !== undefined) throw Error('Nieprawidłowa pierwsza rewizja statusu.'); }
  else { if (!p.before) throw Error('Brak rewizji przed zmianą.'); checkStatus(p.before); if (p.before.id !== p.status_id || p.request.status_id !== p.status_id || p.request.version !== p.before.version || p.after.version !== String(BigInt(p.before.version) + 1n)) throw Error('Niezgodna wersja statusu w podglądzie.'); }
  const s = p.after.settings, w = p.resources.warehouse;
  if (s.decision === 'reject') { if (w !== null) throw Error('Odrzucenie nie może mieć celu magazynowego.'); }
  else { checkWarehouse(w!); if (!w || w.id !== s.warehouse_id || w.policy.version !== s.warehouse_policy_version || !w.policy.enabled || w.policy.usage !== s.inventory_effect) throw Error('Podgląd ma niezgodny magazyn lub politykę.'); }
}
function checkPreview(p: Preview) { checkSnapshot(p); if (typeof p.can_commit !== 'boolean' || (p.operation_id !== null && !uuid(p.operation_id))) throw Error('Brak aktualnego dostępu do podglądu.'); }
function checkOperation(op: Operation) {
  if (!op || !uuid(op.id) || !uuid(op.preview_id) || !uuid(op.status_id) || !uuid(op.request?.client_key) || !hash(op.scope_hash) || op.request.scope_hash !== op.scope_hash || op.request.confirmed !== true) throw Error('Niepełne trwałe potwierdzenie konfiguracji.');
  checkSnapshot(op.snapshot); checkStatus(op.after);
  if (op.snapshot.id !== op.preview_id || op.snapshot.status_id !== op.status_id || op.snapshot.scope_hash !== op.scope_hash || op.kind !== op.snapshot.kind || op.after.id !== op.status_id || op.after.version !== op.snapshot.after.version || !equalSettings(op.after.settings, op.snapshot.after.settings) || !sameStatus(op.before, op.snapshot.before)) throw Error('Trwały wynik nie odpowiada podglądowi.');
}
function validateReply(d: Reply, a: Attempt) {
  checkFlags(d, a.context); if (typeof d.reused !== 'boolean' || !d.available || !d.can_read || d.read_only) throw Error('Brak potwierdzenia dokładnej próby.');
  if (a.kind === 'preview') {
    const b: PreviewInput = JSON.parse(a.body), p = d.preview;
    if (!p) throw Error('Brak zapisanego podglądu.'); checkPreview(p);
    if (!samePreviewInput(p.request, b) || p.kind !== b.kind) throw Error('Podgląd nie odpowiada wysłanej konfiguracji.');
  } else {
    const b: CommitInput = JSON.parse(a.body), op = d.operation, p = a.preview;
    if (!op || !p || !d.status) throw Error('Brak trwałego wyniku zapisu statusu.'); checkOperation(op); checkStatus(d.status);
    if (op.preview_id !== p.id || op.scope_hash !== p.scope_hash || op.request.client_key !== b.client_key || op.request.scope_hash !== b.scope_hash || op.status_id !== p.status_id || !samePreviewInput(op.snapshot.request, p.request) || !sameStatus(op.before, p.before) || !equalSettings(op.after.settings, p.after.settings) || op.after.version !== p.after.version || !sameStatus(d.status, op.after)) throw Error('Trwały wynik nie odpowiada dokładnej zgodzie.');
  }
}
async function write(a: Attempt, retry: boolean, freshAllowed: () => boolean): Promise<Reply | null> {
  if (a.context !== context || a.context.split(':')[3] !== 'false' || inFlight || (retry ? pending !== a : pending !== null) || !freshAllowed()) return null;
  const e = epoch; inFlight = true; publish(); let sent = false;
  try {
    await actor(a.context); const access = await api<Options>(base + '/options');
    if (context !== a.context || epoch !== e) return null;
    checkFlags(access, a.context);
    if (!access.available || !access.can_manage || access.current_role !== 'admin' || access.read_only) throw new ApiError('Brak aktualnego prawa do konfiguracji statusów.', access.read_only ? 423 : 403);
    if (!freshAllowed()) throw Error('Inny zapis lub zmiana trybu wstrzymały świeżą konfigurację.');
    pending = a; sent = true; publish();
    const d = await api<Reply>(a.path, 'POST', JSON.parse(a.body));
    if (context !== a.context || epoch !== e) return null;
    validateReply(d, a);
    await actor(a.context); const latest = await api<Options>(base + '/options');
    if (context !== a.context || epoch !== e) return null;
    checkFlags(latest, a.context); if (!latest.can_read) throw new ApiError('Odebrano dostęp do konfiguracji.', 403);
    outcome = d; pending = null; return d;
  } catch (error) {
    if (context === a.context && epoch === e && error instanceof ApiError) {
      if ([401, 403].includes(error.status)) purge(a.context);
      else if (sent && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) pending = null;
    }
    throw error;
  } finally { if (context === a.context && epoch === e) { inFlight = false; publish(); } }
}
const empty = (): Settings => ({ name: '', color: '#2563eb', active: true, decision: 'accept', inventory_effect: 'sale', warehouse_id: null, warehouse_policy_version: null, default_location: null });
const effect = { sale: 'Stan sprzedaży', custody: 'Przyjęcie poza stanem sprzedaży', none: 'Bez przyjęcia zapasu' };
export type ReturnDestinationStatusesPanelProps = { contextKey: string; readOnly: boolean; externalWriteBlocked?: boolean; onLockedChange?: (locked: boolean) => void; onChanged?: () => void };

// Global entry point: no order is required, and closing the panel keeps actor RAM attempts.
export function ReturnDestinationStatusesSettings(props: ReturnDestinationStatusesPanelProps) {
  const scope = props.contextKey, parts = scope.split(':');
  const validContext = parts.length === 4 && uuid(parts[0]) && uuid(parts[1]) && ['admin', 'operator', 'viewer'].includes(parts[2]) && ['true', 'false'].includes(parts[3]);
  const validAdmin = validContext && parts[2] === 'admin';
  const [openScope, setOpenScope] = useState(''), [locked, setLocked] = useState(() => returnDestinationStatusesWriteLocked(scope));
  const latest = useRef(props); latest.current = props;
  useEffect(() => {
    setOpenScope('');
    resetReturnDestinationStatusesContext(validContext ? scope : '');
    if (!validAdmin) { setLocked(false); latest.current.onLockedChange?.(false); return; }
    return subscribeReturnDestinationStatusesLock(scope, value => {
      setLocked(value); latest.current.onLockedChange?.(value);
    });
  }, [scope, props.readOnly, validAdmin, validContext]);
  if (!validAdmin) return null;
  const open = openScope === `${scope}:${props.readOnly}`;
  return <section aria-label="Ustawienia statusów pozycji zwrotu">
    <button className="button" type="button" aria-expanded={open} onClick={() => setOpenScope(open ? '' : `${scope}:${props.readOnly}`)}>{open ? 'Zamknij ustawienia statusów zwrotu' : 'Statusy pozycji zwrotu — ustawienia'}</button>
    {locked && !open && <p role="status">Pozostała dokładna próba ustawień statusów. Otwórz ustawienia, aby sprawdzić wynik lub ponowić tę samą próbę.</p>}
    {open && <ReturnDestinationStatusesPanel key={`${scope}:${props.readOnly}`} contextKey={scope} readOnly={props.readOnly} externalWriteBlocked={props.externalWriteBlocked} onChanged={props.onChanged}/>}
  </section>;
}

function SettingsView({ settings: s, warehouse }: { settings: Settings; warehouse: Warehouse | null }) {
  return <dl className="rds-summary"><dt>Nazwa / kolor</dt><dd><span className="rds-swatch" style={{ backgroundColor: s.color }} aria-hidden="true"/>{s.name} · {s.color}</dd><dt>Stan konfiguracji</dt><dd>{s.active ? 'Aktywna' : 'Nieaktywna'}</dd><dt>Decyzja</dt><dd>{s.decision === 'accept' ? 'Przyjmij' : 'Odrzuć'}</dd><dt>Skutek zapasu</dt><dd>{effect[s.inventory_effect]}</dd><dt>Magazyn docelowy</dt><dd>{s.warehouse_id ? warehouse ? `${warehouse.name} (${warehouse.code})` : s.warehouse_id : 'Nie dotyczy'}</dd><dt>Wersja polityki</dt><dd>{s.warehouse_policy_version ?? 'Nie dotyczy'}</dd><dt>Lokalizacja</dt><dd>{s.default_location ?? 'Nie dotyczy'}</dd></dl>;
}

export function ReturnDestinationStatusesPanel(props: ReturnDestinationStatusesPanelProps) {
  const scope = props.contextKey;
  const [options, setOptions] = useState<Options | null>(null), [statuses, setStatuses] = useState<Status[]>([]), [listCursor, setListCursor] = useState<string | null>(null), [selected, setSelected] = useState(''), [draft, setDraft] = useState(empty), [baseline, setBaseline] = useState<Status | null>(null), [preview, setPreview] = useState<Preview | null>(null), [operation, setOperation] = useState<Operation | null>(null), [history, setHistory] = useState<Head[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null), [consent, setConsent] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState(''), [signal, setSignal] = useState(0), [loadedEpoch, setLoadedEpoch] = useState(-1);
  const alive = useRef(false), generation = useRef(0), scopeRef = useRef(scope), latest = useRef(props), applied = useRef<Reply | null>(null);
  const [loadedScope, setLoadedScope] = useState('');
  scopeRef.current = scope; latest.current = props;
  const current = (g: number, e: number) => alive.current && scopeRef.current === scope && generation.current === g && context === scope && epoch === e;
  const locked = returnDestinationStatusesWriteLocked(scope), retained = context === scope ? pending : null;
  const visible = loadedScope === scope && loadedEpoch === epoch && context === scope;
  const writable = Boolean(visible && scope.split(':')[3] === 'false' && options?.available && options.can_manage && options.current_role === 'admin' && !options.read_only && !props.readOnly);
  const freshBlocked = !writable || locked || props.externalWriteBlocked || reading;
  function clear() { setLoadedScope(''); setOptions(null); setStatuses([]); setSelected(''); setBaseline(null); setDraft(empty()); setPreview(null); setOperation(null); setHistory([]); setConsent(false); setListCursor(null); setHistoryCursor(null); setLoadedEpoch(-1); }
  function fail(err: unknown) { setError(err instanceof Error ? err.message : 'Nie udało się odczytać ustawień.'); setConsent(false); if (err instanceof ApiError && [401, 403].includes(err.status)) { purge(scope); clear(); } else if (err instanceof ApiError && err.status === 503) setOptions(null); }
  async function read<T>(path: string, apply: (d: T) => void) {
    const g = ++generation.current, e = epoch; setReading(true); setError('');
    try {
      await actor(scope); const d = await api<T & Flags>(path);
      if (!current(g, e)) return;
      checkFlags(d, scope); if (d.available && !d.can_read) throw new ApiError('Brak dostępu do ustawień.', 403);
      apply(d);
    } catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && scopeRef.current === scope && generation.current === g) setReading(false); }
  }
  async function loadOptions() {
    await read<Options>(base + '/options', d => {
      if (!Array.isArray(d.warehouses)) throw Error('Niepełna lista magazynów.'); d.warehouses.forEach(checkWarehouse);
      if (!d.available) clear(); setOptions(d); setLoadedScope(scope); setLoadedEpoch(epoch);
    });
  }
  useEffect(() => {
    alive.current = true; generation.current++; resetReturnDestinationStatusesContext(scope); clear();
    const unsubscribe = subscribeReturnDestinationStatusesLock(scope, () => setSignal(v => v + 1));
    void loadOptions();
    return () => { alive.current = false; generation.current++; unsubscribe(); };
  }, [scope, props.readOnly]);
  useEffect(() => { props.onLockedChange?.(locked); }, [locked, props.onLockedChange, signal]);
  useEffect(() => { if (loadedEpoch !== -1 && loadedEpoch !== epoch) clear(); }, [signal, loadedEpoch]);
  useEffect(() => {
    if (!visible || !options?.can_read || !outcome || applied.current === outcome) return;
    applied.current = outcome; setConsent(false); if (outcome.preview) { setPreview(outcome.preview); setOperation(null); } else if (outcome.operation) { setOperation(outcome.operation); setPreview(null); }
  }, [scope, options, loadedEpoch, loadedScope, signal]);
  function change(s: Settings) { if (freshBlocked) return; setDraft(s); setPreview(null); setOperation(null); setConsent(false); }
  function choose(id: string) {
    if (locked || reading) return; setSelected(id); setBaseline(null); setDraft(empty()); setPreview(null); setOperation(null); setHistory([]); setHistoryCursor(null); setConsent(false);
    if (!id || id === 'new') return;
    void read<Flags & { status: Status }>(base + '/' + id, d => { checkStatus(d.status); if (d.status.id !== id) throw Error('Odczytano inny status.'); setBaseline(d.status); setDraft(structuredClone(d.status.settings)); });
  }
  async function mutate(a: Attempt, retry = false) {
    if (props.readOnly || reading || (!retry && freshBlocked)) return;
    const g = generation.current, e = epoch; setError(''); setConsent(false);
    const allowed = () => alive.current && scopeRef.current === scope && latest.current.contextKey === scope && !latest.current.readOnly && (retry || !latest.current.externalWriteBlocked);
    try {
      const d = await write(a, retry, allowed); if (!d || !current(g, e)) return;
      if (d.preview) { setPreview(d.preview); setOperation(null); } else if (d.operation) { setOperation(d.operation); setPreview(null); props.onChanged?.(); }
      await loadOptions();
    } catch (err) { if (current(g, e)) { fail(err); if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) setPreview(null); } }
  }
  function prepare() {
    const s = { ...draft, name: draft.name.trim(), default_location: draft.default_location?.trim() ?? null };
    if (!validSettings(s) || !selected || (selected !== 'new' && !baseline)) { setError('Podaj nazwę, prawidłowy kolor i jawny zgodny cel przyjęcia albo wybierz odrzucenie.'); return; }
    const body: PreviewInput = { client_key: crypto.randomUUID(), kind: selected === 'new' ? 'create' : 'update', ...(baseline ? { status_id: baseline.id, version: baseline.version } : {}), settings: s };
    void mutate({ context: scope, kind: 'preview', path: base + '/previews', body: JSON.stringify(body) });
  }
  function list(more = false) {
    void read<Flags & { data: Status[]; next_cursor: string | null }>(base + '?limit=50' + (more && listCursor ? '&cursor=' + listCursor : ''), d => {
      if (!Array.isArray(d.data) || d.data.length > 50 || (d.next_cursor !== null && !uuid(d.next_cursor))) throw Error('Niepełna strona statusów.'); d.data.forEach(checkStatus); if (more && d.next_cursor && d.next_cursor === listCursor) throw Error('Powtórzona strona statusów.'); setStatuses(v => more ? [...v, ...d.data] : d.data); setListCursor(d.next_cursor);
    });
  }
  function readHistory(more = false) {
    if (!baseline) return;
    void read<Flags & { data: Head[]; next_cursor: string | null }>(base + '/' + baseline.id + '/history?limit=50' + (more && historyCursor ? '&cursor=' + historyCursor : ''), d => {
      if (!Array.isArray(d.data) || d.data.length > 50 || d.data.some(h => !uuid(h.id) || !uuid(h.preview_id) || h.status_id !== baseline.id || !version(h.version) || !['create', 'update'].includes(h.kind)) || (d.next_cursor !== null && !uuid(d.next_cursor))) throw Error('Niepełna historia konfiguracji.'); if (more && d.next_cursor && d.next_cursor === historyCursor) throw Error('Powtórzona strona historii.'); setHistory(v => more ? [...v, ...d.data] : d.data); setHistoryCursor(d.next_cursor);
    });
  }
  const warehouse = options?.warehouses.find(w => w.id === draft.warehouse_id) ?? null;
  const choices = options?.warehouses.filter(w => w.policy.enabled && w.policy.usage === draft.inventory_effect) ?? [];
  return <section className="panel return-destination-statuses" aria-label="Ustawienia statusów pozycji zwrotu"><header><h3>Statusy pozycji zwrotu — ustawienia</h3><p>Wersjonowana konfiguracja decyzji i magazynu docelowego.</p></header><div className="rds-body">
    <div className="rds-actions"><button type="button" className="button" disabled={reading || inFlight} onClick={() => void loadOptions()}>Odczytaj dostęp do statusów zwrotu</button>{visible && options?.available && <button type="button" className="button" disabled={reading || inFlight} onClick={() => list()}>Odczytaj statusy pozycji zwrotu</button>}</div>
    {error && <p className="error-block" role="alert">{error}</p>}
    {visible && options && !options.available && <p className="notice">Konfiguracja magazynów docelowych zwrotu nie jest dostępna w tej kopii.</p>}
    {visible && options?.available && <>
      {!options.intake_available && <p className="notice">Ten panel zapisuje wyłącznie ustawienia. Przyjęcie zwrotu nadal używa dotychczasowych „Do sprzedaży”, „Do kontroli” i „Odrzucone”. Nowa konfiguracja nie tworzy ruchu magazynowego ani kwarantanny.</p>}
      {!writable && <p className="notice">Konfiguracja jest dostępna tylko do odczytu.</p>}
      {retained && <div className="notice"><p>Wynik dokładnej próby wymaga potwierdzenia. Odczyt listy i historii nie zwalnia tej próby; świeże zmiany są wstrzymane. Próba pozostaje w pamięci tej sesji i tego użytkownika.</p><button className="button primary" type="button" disabled={reading || inFlight || !writable} onClick={() => void mutate(retained, true)}>Ponów dokładną próbę ustawień zwrotu</button></div>}
      <label>Status pozycji<select aria-label="Status pozycji zwrotu" value={selected} disabled={reading || locked} onChange={e => choose(e.target.value)}><option value="">Wybierz status</option>{writable && <option value="new">Nowy status</option>}{statuses.map(s => <option value={s.id} key={s.id}>{s.settings.name} · wersja {s.version}{!s.settings.active ? ' · nieaktywny' : ''}</option>)}</select></label>
      {listCursor && <button type="button" className="button" disabled={reading || inFlight} onClick={() => list(true)}>Dalsze statusy pozycji zwrotu</button>}
      {baseline && <p>Zapisana rewizja {baseline.version} · {date(baseline.updated_at)}. Edycja utworzy kolejną rewizję.</p>}
      {baseline && <button type="button" className="button" disabled={reading || locked} onClick={() => choose(baseline.id)}>Wczytaj ponownie zapisaną konfigurację</button>}
      {selected && <><fieldset disabled={freshBlocked}><legend>{selected === 'new' ? 'Nowa konfiguracja' : 'Nowa rewizja wybranego statusu'}</legend><div className="rds-grid">
        <label>Nazwa statusu<input aria-label="Nazwa statusu zwrotu" value={draft.name} maxLength={120} onChange={e => change({ ...draft, name: e.target.value })}/></label>
        <label>Kolor statusu<input aria-label="Kolor statusu zwrotu" type="color" value={draft.color} onChange={e => change({ ...draft, color: e.target.value.toLowerCase() })}/></label>
        <label>Decyzja o sztukach<select value={draft.decision} onChange={e => change(e.target.value === 'reject' ? { ...draft, decision: 'reject', inventory_effect: 'none', warehouse_id: null, warehouse_policy_version: null, default_location: null } : { ...draft, decision: 'accept', inventory_effect: 'sale', warehouse_id: null, warehouse_policy_version: null, default_location: null })}><option value="accept">Przyjmij</option><option value="reject">Odrzuć</option></select></label>
        {draft.decision === 'accept' && <><label>Przeznaczenie przyjęcia<select value={draft.inventory_effect} onChange={e => change({ ...draft, inventory_effect: e.target.value as 'sale' | 'custody', warehouse_id: null, warehouse_policy_version: null, default_location: null })}><option value="sale">Stan sprzedaży</option><option value="custody">Poza stanem sprzedaży</option></select></label><label>Magazyn docelowy<select value={draft.warehouse_id ?? ''} onChange={e => { const w = choices.find(w => w.id === e.target.value); change({ ...draft, warehouse_id: w?.id ?? null, warehouse_policy_version: w?.policy.version ?? null }); }}><option value="">Wybierz zgodny magazyn</option>{choices.map(w => <option key={w.id} value={w.id}>{w.name} ({w.code}) · polityka {w.policy.version}</option>)}</select></label><label>Domyślna lokalizacja przyjęcia<input value={draft.default_location ?? ''} maxLength={80} onChange={e => change({ ...draft, default_location: e.target.value || null })}/></label></>}
      </div><label className="rds-check"><input type="checkbox" checked={draft.active} onChange={e => change({ ...draft, active: e.target.checked })}/>Status aktywny</label><SettingsView settings={draft} warehouse={warehouse}/><button type="button" className="button primary" onClick={prepare}>Przygotuj podgląd statusu zwrotu</button></fieldset></>}
      {preview && <div className="rds-review"><h4>Pełny zapisany podgląd konfiguracji</h4><p>Rewizja {preview.after.version} · ważny do {date(preview.expires_at)}</p>{preview.before && <><h5>Przed zmianą — rewizja {preview.before.version}</h5><SettingsView settings={preview.before.settings} warehouse={preview.before.settings.warehouse_id === preview.resources.warehouse?.id ? preview.resources.warehouse : null}/></>}<h5>Po zatwierdzeniu</h5><SettingsView settings={preview.after.settings} warehouse={preview.resources.warehouse}/><p>Zapis zmienia konfigurację, bez przyjęcia towaru, uznania kwoty lub wypłaty.</p><label className="rds-check"><input type="checkbox" checked={consent} disabled={Boolean(freshBlocked || !preview.can_commit || preview.operation_id || Date.parse(preview.expires_at) <= Date.now())} onChange={e => setConsent(e.target.checked)}/>Sprawdziłem decyzję, przeznaczenie, magazyn, politykę i lokalizację. Zatwierdzam tę rewizję ustawień.</label><button type="button" className="button primary" disabled={Boolean(freshBlocked || !consent || !preview.can_commit || preview.operation_id || Date.parse(preview.expires_at) <= Date.now())} onClick={() => void mutate({ context: scope, kind: 'commit', path: base + '/previews/' + preview.id + '/commit', body: JSON.stringify({ client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true }), preview: structuredClone(preview) })}>Zapisz zatwierdzony status zwrotu</button></div>}
      {operation && <div className="rds-review"><h4>Konfiguracja zapisana</h4><p>Operacja {operation.id} · historyczna rewizja {operation.after.version} · {date(operation.created_at)}</p><SettingsView settings={operation.after.settings} warehouse={operation.snapshot.resources.warehouse}/><p>Późniejsza zmiana statusu nie zmienia tej zapisanej rewizji.</p></div>}
      {baseline && <div><h4>Historia wybranego statusu</h4><button type="button" className="button" disabled={reading || inFlight} onClick={() => readHistory()}>Odczytaj historię statusu zwrotu</button><ul className="rds-history">{history.map(h => <li key={h.id}>Rewizja {h.version} · {date(h.created_at)} <button type="button" className="button" disabled={reading || inFlight} onClick={() => void read<Flags & { operation: Operation }>(base + '/operations/' + h.id, d => { checkOperation(d.operation); if (d.operation.id !== h.id || d.operation.status_id !== h.status_id || d.operation.after.version !== h.version) throw Error('Odczytano inną operację konfiguracji.'); setOperation(d.operation); setPreview(null); setConsent(false); })}>Otwórz pełny zapis statusu {h.id}</button></li>)}</ul>{historyCursor && <button type="button" className="button" disabled={reading || inFlight} onClick={() => readHistory(true)}>Dalsza historia statusu zwrotu</button>}</div>}
    </>}
  </div></section>;
}
