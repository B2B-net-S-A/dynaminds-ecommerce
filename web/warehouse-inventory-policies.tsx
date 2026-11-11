import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './warehouse-inventory-policies.css';

const base = '/warehouse-inventory-policies';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) < 9223372036854775807n;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
type Policy = { usage: 'sale' | 'custody'; enabled: boolean; version: string };
type Choice = Omit<Policy, 'version'>;
type Warehouse = { id: string; name: string; code: string; policy: Policy };
type Flags = { available: boolean; read_only: boolean; current_role: 'admin' | 'operator' | 'viewer' | null; can_read: boolean; can_manage: boolean };
type Options = Flags & { warehouses: Warehouse[]; next_cursor: string | null };
type PreviewInput = Policy & { client_key: string };
type Preview = { id: string; warehouse_id: string; client_key: string; request: PreviewInput; scope_hash: string; snapshot: { warehouse: { id: string; name: string; code: string }; before: Policy; after: Choice; blockers: string[] }; ready: boolean; created_at: string; expires_at: string };
type Operation = { id: string; warehouse_id: string; preview_id: string; client_key: string; scope_hash: string; before: Policy; after: Policy; revision_id: string; created_at: string };
type Reply = Flags & { reused: boolean; preview?: Preview; operation?: Operation };
type Attempt = { context: string; kind: 'preview' | 'commit'; path: string; body: string; warehouseId: string; preview?: Preview };
type Head = { id: string; warehouse_id: string; client_key: string; created_at: string };
type Stock = { product_id: string; warehouse_id: string; sku: string; name: string; on_hand: number; reserved: number; physical_available: number; sellable_available: number; inventory_usage: 'sale' | 'custody'; inventory_enabled: boolean; inventory_policy_version: string };

let context = '', epoch = 0, inFlight = false;
let pending: Attempt | null = null, outcome: Reply | null = null;
const subscribers = new Set<() => void>();
const publish = () => subscribers.forEach(fn => fn());
export function resetWarehouseInventoryPoliciesContext(next: string) {
  if (context === next) return;
  context = next; epoch++; pending = null; outcome = null; inFlight = false; publish();
}
export function warehouseInventoryPoliciesWriteLocked(key: string) { return key === context && Boolean(pending || inFlight); }
export function subscribeWarehouseInventoryPoliciesLock(key: string, callback: (locked: boolean) => void) {
  const notify = () => callback(warehouseInventoryPoliciesWriteLocked(key));
  subscribers.add(notify); notify(); return () => { subscribers.delete(notify); };
}
function purge(key: string) { if (key !== context) return; epoch++; pending = null; outcome = null; inFlight = false; publish(); }
function checkFlags(d: Flags, key: string) {
  if (!d || ['available', 'read_only', 'can_read', 'can_manage'].some(k => typeof d[k as keyof Flags] !== 'boolean') || (d.current_role !== null && !['admin', 'operator', 'viewer'].includes(d.current_role))) throw Error('Niepełny odczyt dostępu do polityki magazynu.');
  if (d.current_role !== null && d.current_role !== key.split(':')[2]) throw new ApiError('Zmieniła się rola użytkownika.', 403);
}
async function actor(key: string) {
  const parts = key.split(':'), d = await api('/auth/me');
  if (parts.length !== 4 || !uuid(parts[0]) || !uuid(parts[1]) || !['true', 'false'].includes(parts[3]) || `${d.user?.tenant_id}:${d.user?.id}:${d.user?.role}` !== parts.slice(0, 3).join(':')) throw new ApiError('Zmieniła się firma lub użytkownik.', 403);
}
const validChoice = (p: Choice) => Boolean(p && ['sale', 'custody'].includes(p.usage) && typeof p.enabled === 'boolean');
const validPolicy = (p: Policy) => validChoice(p) && version(p.version);
const sameChoice = (a: Choice, b: Choice) => validChoice(a) && validChoice(b) && a.usage === b.usage && a.enabled === b.enabled;
const samePolicy = (a: Policy, b: Policy) => validPolicy(a) && validPolicy(b) && sameChoice(a, b) && a.version === b.version;
function checkWarehouse(w: Warehouse) { if (!w || !uuid(w.id) || typeof w.name !== 'string' || typeof w.code !== 'string' || !validPolicy(w.policy)) throw Error('Niepełny odczyt magazynu i jego polityki.'); }
function checkOptions(d: Options, key: string) {
  checkFlags(d, key);
  if (!Array.isArray(d.warehouses) || d.warehouses.length > 50 || (d.next_cursor !== null && !uuid(d.next_cursor)) || new Set(d.warehouses.map(w => w.id)).size !== d.warehouses.length) throw Error('Niepełna strona magazynów.');
  d.warehouses.forEach(checkWarehouse);
}
function checkPreview(p: Preview) {
  if (!p || !uuid(p.id) || !uuid(p.warehouse_id) || !uuid(p.client_key) || !hash(p.scope_hash) || !uuid(p.request?.client_key) || p.client_key !== p.request.client_key || !validPolicy(p.request) || !p.snapshot || p.snapshot.warehouse?.id !== p.warehouse_id || typeof p.snapshot.warehouse.name !== 'string' || typeof p.snapshot.warehouse.code !== 'string' || !validPolicy(p.snapshot.before) || !sameChoice(p.request, p.snapshot.after) || p.request.version !== p.snapshot.before.version || !Array.isArray(p.snapshot.blockers) || p.snapshot.blockers.some(v => typeof v !== 'string') || p.ready !== (p.snapshot.blockers.length === 0) || !Number.isFinite(Date.parse(p.expires_at)) || !Number.isFinite(Date.parse(p.created_at))) throw Error('Niepełny lub niezgodny zapisany podgląd polityki. Dokładna próba pozostaje zachowana.');
}
function checkOperation(op: Operation) {
  if (!op || !uuid(op.id) || !uuid(op.warehouse_id) || !uuid(op.preview_id) || !uuid(op.client_key) || !uuid(op.revision_id) || !hash(op.scope_hash) || !validPolicy(op.before) || !validPolicy(op.after) || op.after.version !== String(BigInt(op.before.version) + 1n) || !Number.isFinite(Date.parse(op.created_at))) throw Error('Niepełne trwałe potwierdzenie polityki magazynu.');
}
function validateReply(d: Reply, a: Attempt) {
  checkFlags(d, a.context);
  if (typeof d.reused !== 'boolean' || !d.available || !d.can_read || d.read_only) throw Error('Brak potwierdzenia dokładnej próby polityki.');
  if (a.kind === 'preview') {
    const b: PreviewInput = JSON.parse(a.body), p = d.preview;
    if (!p) throw Error('Brak trwałego podglądu polityki.'); checkPreview(p);
    if (p.warehouse_id !== a.warehouseId || p.request.client_key !== b.client_key || !samePolicy(p.request, b)) throw Error('Podgląd nie odpowiada wysłanej konfiguracji.');
  } else {
    const b = JSON.parse(a.body), op = d.operation, p = a.preview;
    if (!op || !p) throw Error('Brak trwałego wyniku zgody na politykę.'); checkOperation(op);
    if (op.preview_id !== p.id || op.warehouse_id !== a.warehouseId || op.client_key !== b.client_key || op.scope_hash !== p.scope_hash || b.scope_hash !== p.scope_hash || b.confirmed !== true || !samePolicy(op.before, p.snapshot.before) || !sameChoice(op.after, p.snapshot.after)) throw Error('Zapisana polityka nie odpowiada dokładnej zgodzie.');
  }
}
async function write(a: Attempt, retry: boolean, allowed: () => boolean): Promise<Reply | null> {
  if (context !== a.context || a.context.split(':')[3] !== 'false' || inFlight || (retry ? pending !== a : pending !== null) || !allowed()) return null;
  const e = epoch; inFlight = true; publish(); let sent = false;
  try {
    await actor(a.context); const access = await api<Options>(base + '/options');
    if (context !== a.context || epoch !== e) return null;
    checkOptions(access, a.context);
    if (!access.available || !access.can_manage || access.current_role !== 'admin' || access.read_only) throw new ApiError('Brak aktualnego prawa do konfiguracji magazynu.', access.read_only ? 423 : 403);
    if (!allowed()) throw Error('Inny zapis lub zmiana trybu wstrzymały świeżą zmianę polityki.');
    pending = a; sent = true; publish();
    const d = await api<Reply>(a.path, 'POST', JSON.parse(a.body));
    if (context !== a.context || epoch !== e) return null;
    validateReply(d, a);
    await actor(a.context); const latest = await api<Options>(base + '/options');
    if (context !== a.context || epoch !== e) return null;
    checkOptions(latest, a.context); if (!latest.can_read) throw new ApiError('Odebrano dostęp do konfiguracji magazynu.', 403);
    outcome = d; pending = null; return d;
  } catch (err) {
    if (context === a.context && epoch === e && err instanceof ApiError) {
      if ([401, 403].includes(err.status)) purge(a.context);
      else if (sent && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) pending = null;
    }
    throw err;
  } finally { if (context === a.context && epoch === e) { inFlight = false; publish(); } }
}
const usageNames = { sale: 'Magazyn sprzedażowy', custody: 'Magazyn poza sprzedażą' };
const blockers: Record<string, string> = { STOCK_NOT_EMPTY: 'Magazyn ma zapas lub rezerwacje.', BINS_NOT_EMPTY: 'Lokalizacje magazynowe nie są puste.', WMS_NOT_EMPTY: 'Partie WMS mają zapas lub rezerwacje.', ACTIVE_RESERVATIONS: 'Pozostają aktywne rezerwacje.', PENDING_ORDERS: 'Pozostają zamówienia do realizacji.', OPEN_PURCHASES: 'Pozostają otwarte zakupy.', DRAFT_DOCUMENTS: 'Pozostają dokumenty magazynowe w wersji roboczej.' };
function PolicyView({ policy: p }: { policy: Choice & { version?: string } }) { return <dl className="wip-summary"><dt>Przeznaczenie</dt><dd>{usageNames[p.usage]}</dd><dt>Dostępność sprzedażowa</dt><dd>{p.enabled && p.usage === 'sale' ? 'Fizycznie wolny zapas może być dostępny do sprzedaży' : 'Zero dostępności sprzedażowej; fizyczny zapas pozostaje osobnym stanem'}</dd><dt>Polityka aktywna</dt><dd>{p.enabled ? 'Tak' : 'Nie'}</dd>{p.version !== undefined && <><dt>Wersja polityki</dt><dd>{p.version}{p.version === '0' ? ' · domyślna polityka magazynu' : ''}</dd></>}</dl>; }
export type WarehouseInventoryPoliciesPanelProps = { contextKey: string; readOnly: boolean; externalWriteBlocked?: boolean; onLockedChange?: (locked: boolean) => void; onChanged?: () => void };

export function WarehouseInventoryPoliciesPanel(props: WarehouseInventoryPoliciesPanelProps) {
  const scope = props.contextKey;
  const [options, setOptions] = useState<Options | null>(null), [warehouses, setWarehouses] = useState<Warehouse[]>([]), [warehouseCursor, setWarehouseCursor] = useState<string | null>(null), [selected, setSelected] = useState(''), [draft, setDraft] = useState<Choice>({ usage: 'sale', enabled: true }), [preview, setPreview] = useState<Preview | null>(null), [operation, setOperation] = useState<Operation | null>(null), [consent, setConsent] = useState(false), [historyKind, setHistoryKind] = useState<'preview' | 'operation'>('operation'), [history, setHistory] = useState<Head[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null), [stock, setStock] = useState<Stock[]>([]), [stockCursor, setStockCursor] = useState<string | null>(null), [stockReadAt, setStockReadAt] = useState(''), [reading, setReading] = useState(false), [error, setError] = useState(''), [signal, setSignal] = useState(0), [loadedScope, setLoadedScope] = useState(''), [loadedEpoch, setLoadedEpoch] = useState(-1);
  const alive = useRef(false), generation = useRef(0), scopeRef = useRef(scope), latest = useRef(props), selectedRef = useRef(selected), applied = useRef<Reply | null>(null);
  scopeRef.current = scope; latest.current = props; selectedRef.current = selected;
  const current = (g: number, e: number) => alive.current && scopeRef.current === scope && generation.current === g && context === scope && epoch === e;
  const locked = warehouseInventoryPoliciesWriteLocked(scope), retained = context === scope ? pending : null;
  const visible = loadedScope === scope && loadedEpoch === epoch && context === scope;
  const writable = Boolean(visible && scope.split(':')[3] === 'false' && options?.available && options.can_manage && options.current_role === 'admin' && !options.read_only && !props.readOnly);
  const freshBlocked = !writable || locked || props.externalWriteBlocked || reading;
  const baseline = warehouses.find(w => w.id === selected) ?? null;
  function clear() { setOptions(null); setWarehouses([]); setWarehouseCursor(null); setSelected(''); setDraft({ usage: 'sale', enabled: true }); setPreview(null); setOperation(null); setConsent(false); setHistory([]); setHistoryCursor(null); setStock([]); setStockCursor(null); setStockReadAt(''); setLoadedScope(''); setLoadedEpoch(-1); }
  function fail(err: unknown) { setError(err instanceof Error ? err.message : 'Nie udało się odczytać polityki magazynu.'); setConsent(false); if (err instanceof ApiError && [401, 403].includes(err.status)) { purge(scope); clear(); } else if (err instanceof ApiError && err.status === 503) setOptions(null); }
  async function read<T>(path: string, apply: (d: T) => void) {
    const g = ++generation.current, e = epoch; setReading(true); setError('');
    try { await actor(scope); const d = await api<T & Flags>(path); if (!current(g, e)) return; checkFlags(d, scope); if (!d.can_read) throw new ApiError('Brak dostępu do polityki magazynu.', 403); apply(d); }
    catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && scopeRef.current === scope && generation.current === g) setReading(false); }
  }
  async function loadOptions(more = false) {
    await read<Options>(base + '/options?limit=50' + (more && warehouseCursor ? '&cursor=' + warehouseCursor : ''), d => {
      checkOptions(d, scope); if (more && d.next_cursor && d.next_cursor === warehouseCursor) throw Error('Powtórzona strona magazynów.');
      setOptions(d); setWarehouses(v => more ? [...v.filter(w => !d.warehouses.some(n => n.id === w.id)), ...d.warehouses] : d.warehouses); setWarehouseCursor(d.next_cursor); setLoadedScope(scope); setLoadedEpoch(epoch);
    });
  }
  useEffect(() => { alive.current = true; generation.current++; resetWarehouseInventoryPoliciesContext(scope); clear(); const unsub = subscribeWarehouseInventoryPoliciesLock(scope, () => setSignal(v => v + 1)); void loadOptions(); return () => { alive.current = false; generation.current++; unsub(); }; }, [scope, props.readOnly]);
  useEffect(() => { props.onLockedChange?.(locked); }, [locked, props.onLockedChange, signal]);
  useEffect(() => { if (loadedEpoch !== -1 && loadedEpoch !== epoch) clear(); }, [signal, loadedEpoch]);
  useEffect(() => { if (!visible || !options?.can_read || !outcome || applied.current === outcome) return; applied.current = outcome; setConsent(false); if (outcome.preview) { setPreview(outcome.preview); setOperation(null); } else if (outcome.operation) { setOperation(outcome.operation); setPreview(null); } }, [scope, options, loadedScope, loadedEpoch, signal]);
  function choose(id: string) { if (reading || locked) return; const w = warehouses.find(w => w.id === id); setSelected(id); setDraft(w ? { usage: w.policy.usage, enabled: w.policy.enabled } : { usage: 'sale', enabled: true }); setPreview(null); setOperation(null); setConsent(false); setStock([]); setStockCursor(null); setStockReadAt(''); }
  function change(next: Choice) { if (freshBlocked) return; setDraft(next); setPreview(null); setOperation(null); setConsent(false); }
  async function mutate(a: Attempt, retry = false) {
    if (props.readOnly || reading || (!retry && freshBlocked)) return;
    const g = generation.current, e = epoch; setError(''); setConsent(false);
    const allowed = () => alive.current && scopeRef.current === scope && latest.current.contextKey === scope && !latest.current.readOnly && (retry || !latest.current.externalWriteBlocked);
    try { const d = await write(a, retry, allowed); if (!d || !current(g, e)) return; if (d.preview) { setPreview(d.preview); setOperation(null); } else if (d.operation) { setOperation(d.operation); setPreview(null); setStock([]); setStockReadAt(''); props.onChanged?.(); } await loadOptions(); }
    catch (err) { if (current(g, e)) { fail(err); if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) setPreview(null); } }
  }
  function prepare() { if (!baseline || !validChoice(draft)) return; void mutate({ context: scope, kind: 'preview', warehouseId: baseline.id, path: base + '/warehouses/' + baseline.id + '/previews', body: JSON.stringify({ client_key: crypto.randomUUID(), version: baseline.policy.version, ...draft }) }); }
  function readHistory(more = false) {
    const kind = historyKind;
    void read<Flags & { kind: typeof kind; data: Head[]; next_cursor: string | null }>(base + '/history?kind=' + kind + '&limit=50' + (more && historyCursor ? '&cursor=' + historyCursor : ''), d => {
      if (d.kind !== kind || !Array.isArray(d.data) || d.data.length > 50 || d.data.some(h => !uuid(h.id) || !uuid(h.warehouse_id) || !uuid(h.client_key) || !Number.isFinite(Date.parse(h.created_at))) || (d.next_cursor !== null && !uuid(d.next_cursor)) || (more && d.next_cursor && d.next_cursor === historyCursor)) throw Error('Niepełna lub niezgodna strona historii polityki.');
      setHistory(v => more ? [...v, ...d.data] : d.data); setHistoryCursor(d.next_cursor);
    });
  }
  async function readStock(more = false) {
    if (!selected || reading) return; const warehouseId = selected, g = ++generation.current, e = epoch; setReading(true); setError('');
    try {
      await actor(scope); const access = await api<Options>(base + '/options'); if (!current(g, e)) return; checkOptions(access, scope); if (!access.can_read) throw new ApiError('Brak prawa do odczytu zapasu.', 403);
      const d = await api<{ data: Stock[]; meta: { has_more: boolean; cursor: string | null } }>('/inventory?warehouse_id=' + warehouseId + '&limit=50' + (more && stockCursor ? '&after=' + encodeURIComponent(stockCursor) : ''));
      if (!current(g, e) || selectedRef.current !== warehouseId) return;
      if (!Array.isArray(d.data) || d.data.length > 50 || !d.meta || typeof d.meta.has_more !== 'boolean' || (d.meta.has_more ? typeof d.meta.cursor !== 'string' || !d.meta.cursor : d.meta.cursor !== null) || (more && d.meta.cursor === stockCursor && d.meta.has_more)) throw Error('Niepełna strona zapasu magazynu.');
      for (const s of d.data) if (!uuid(s.product_id) || s.warehouse_id !== warehouseId || typeof s.sku !== 'string' || typeof s.name !== 'string' || ![s.on_hand, s.reserved, s.physical_available, s.sellable_available].every(Number.isSafeInteger) || !validPolicy({ usage: s.inventory_usage, enabled: s.inventory_enabled, version: s.inventory_policy_version })) throw Error('Brak rozdzielenia fizycznego i sprzedażowego zapasu w odczycie.');
      await actor(scope); const final = await api<Options>(base + '/options'); if (!current(g, e) || selectedRef.current !== warehouseId) return; checkOptions(final, scope); if (!final.can_read) throw new ApiError('Odebrano dostęp do zapasu.', 403);
      setStock(v => more ? [...v.filter(s => !d.data.some(n => n.product_id === s.product_id)), ...d.data] : d.data); setStockCursor(d.meta.cursor); setStockReadAt(new Date().toISOString());
    } catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && scopeRef.current === scope && generation.current === g) setReading(false); }
  }
  const reviewBlocked = Boolean(freshBlocked || !preview?.ready || Date.parse(preview.expires_at) <= Date.now());
  return <section className="panel warehouse-inventory-policies" aria-label="Polityka zapasu magazynów"><header><h3>Polityka zapasu magazynów</h3><p>Przeznaczenie fizycznego magazynu i jego dostępność sprzedażowa.</p></header><div className="wip-body">
    <button className="button" type="button" disabled={reading || inFlight} onClick={() => void loadOptions()}>Odczytaj polityki magazynów</button>
    {error && <p className="error-block" role="alert">{error}</p>}
    {visible && options && <>
      {!options.available && <p className="notice">Konfiguracja polityki nie jest dostępna w tej kopii. Domyślna polityka sprzedażowa w wersji 0 nie oznacza zainstalowania modułu.</p>}
      {!writable && <p className="notice">Polityki magazynów są dostępne tylko do odczytu.</p>}
      <p>Zmiana przeznaczenia lub aktywności wymaga pustego magazynu i braku spraw wskazanych w podglądzie. Ten panel nie przenosi ani nie przyjmuje towaru. Nie włącza nowego procesu przyjęcia zwrotu.</p>
      {retained && <div className="notice"><p>Wynik dokładnej próby wymaga potwierdzenia. Nowe zmiany są wstrzymane. Odczyt historii nie kończy niepewnej próby; zachowujemy to samo żądanie i klucz w pamięci tego użytkownika.</p><button className="button primary" type="button" disabled={reading || inFlight || !writable} onClick={() => void mutate(retained, true)}>Ponów dokładną próbę polityki magazynu</button></div>}
      <label>Magazyn polityki<select value={selected} disabled={reading || locked} onChange={e => choose(e.target.value)}><option value="">Wybierz magazyn</option>{warehouses.map(w => <option value={w.id} key={w.id}>{w.name} ({w.code}) · wersja {w.policy.version}</option>)}</select></label>
      {warehouseCursor && <button className="button" type="button" disabled={reading || inFlight} onClick={() => void loadOptions(true)}>Dalsze magazyny</button>}
      {baseline && <><h4>Aktualnie odczytana polityka — {baseline.name} ({baseline.code})</h4><PolicyView policy={baseline.policy}/>
        <fieldset disabled={freshBlocked}><legend>Nowa rewizja polityki</legend><label>Przeznaczenie magazynu<select value={draft.usage} onChange={e => change({ ...draft, usage: e.target.value as Choice['usage'] })}><option value="sale">Magazyn sprzedażowy</option><option value="custody">Magazyn poza sprzedażą</option></select></label><label className="wip-check"><input type="checkbox" checked={draft.enabled} onChange={e => change({ ...draft, enabled: e.target.checked })}/>Polityka magazynu aktywna</label><button className="button primary" type="button" onClick={prepare}>Przygotuj podgląd polityki magazynu</button></fieldset>
        <div><button className="button" type="button" disabled={reading || inFlight} onClick={() => void readStock()}>Odczytaj fizyczny i sprzedażowy zapas</button>{stockReadAt && <><p>Stan na czas odczytu {date(stockReadAt)}. To odczyt zapasu, oddzielny od zapisanej konfiguracji. Brak wiersza nie jest dowodem pustego magazynu.</p><div className="wip-table-scroll"><table><caption>{baseline.name} — fizyczny zapas i dostępność sprzedażowa</caption><thead><tr><th>Produkt</th><th>Stan fizyczny</th><th>Zarezerwowane</th><th>Fizycznie wolne</th><th>Do sprzedaży</th><th>Polityka odczytu</th></tr></thead><tbody>{stock.map(s => <tr key={s.product_id}><td>{s.sku} · {s.name}</td><td>{s.on_hand}</td><td>{s.reserved}</td><td>{s.physical_available}</td><td>{s.sellable_available}</td><td>{usageNames[s.inventory_usage]} · {s.inventory_enabled ? 'aktywna' : 'nieaktywna'} · wersja {s.inventory_policy_version}</td></tr>)}</tbody></table></div>{stockCursor && <button className="button" type="button" disabled={reading || inFlight} onClick={() => void readStock(true)}>Dalszy zapas magazynu</button>}</>}</div>
      </>}
      {preview && <div className="wip-review"><h4>Pełny zapisany podgląd polityki</h4><p>{preview.snapshot.warehouse.name} ({preview.snapshot.warehouse.code}) · {preview.warehouse_id} · ważny do {date(preview.expires_at)}</p><h5>Przed zmianą</h5><PolicyView policy={preview.snapshot.before}/><h5>Po zatwierdzeniu</h5><PolicyView policy={{ ...preview.snapshot.after, version: String(BigInt(preview.snapshot.before.version) + 1n) }}/>{preview.snapshot.blockers.length > 0 ? <><p className="notice">Zmiana niedozwolona. Usuń przyczyny w odpowiednich procesach, następnie odczytaj stan i przygotuj nowy podgląd.</p><ul>{preview.snapshot.blockers.map((b, i) => <li key={b + ':' + i}>{blockers[b] ?? `Blokada wskazana przez API: ${b}`}</li>)}</ul></> : <p>API nie wskazało blokad w tym podglądzie. Zapis ponownie sprawdzi bieżący stan magazynu i wersję.</p>}<label className="wip-check"><input type="checkbox" checked={consent} disabled={reviewBlocked} onChange={e => setConsent(e.target.checked)}/>Sprawdziłem magazyn, przeznaczenie, aktywność i blokady. Zatwierdzam tę zmianę polityki.</label><button className="button primary" type="button" disabled={reviewBlocked || !consent} onClick={() => void mutate({ context: scope, kind: 'commit', warehouseId: preview.warehouse_id, path: base + '/previews/' + preview.id + '/commit', body: JSON.stringify({ client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true }), preview: structuredClone(preview) })}>Zapisz zatwierdzoną politykę magazynu</button></div>}
      {operation && <div className="wip-review"><h4>Polityka zapisana — historyczna rewizja {operation.after.version}</h4><p>Magazyn {operation.warehouse_id} · operacja {operation.id} · {date(operation.created_at)}</p><h5>Przed zmianą</h5><PolicyView policy={operation.before}/><h5>Zapisana polityka</h5><PolicyView policy={operation.after}/><p>To trwały wynik tej operacji. Aktualną politykę odczytaj osobno; późniejsze zmiany nie zmieniają tego potwierdzenia.</p></div>}
      {options.available && <div><h4>Historia polityk magazynów</h4><label>Rodzaj historii polityki<select value={historyKind} disabled={reading || inFlight} onChange={e => { setHistoryKind(e.target.value as typeof historyKind); setHistory([]); setHistoryCursor(null); }}><option value="operation">Zapisane operacje</option><option value="preview">Podglądy</option></select></label><button className="button" type="button" disabled={reading || inFlight} onClick={() => readHistory()}>Odczytaj historię polityk</button><ul className="wip-history">{history.map(h => <li key={h.id}>{h.warehouse_id} · {date(h.created_at)} <button className="button" type="button" disabled={reading || inFlight} onClick={() => historyKind === 'preview' ? void read<Flags & { preview: Preview }>(base + '/previews/' + h.id, d => { checkPreview(d.preview); if (d.preview.id !== h.id || d.preview.warehouse_id !== h.warehouse_id || d.preview.client_key !== h.client_key) throw Error('Odczytano inny podgląd polityki.'); setPreview(d.preview); setOperation(null); setConsent(false); }) : void read<Flags & { operation: Operation }>(base + '/operations/' + h.id, d => { checkOperation(d.operation); if (d.operation.id !== h.id || d.operation.warehouse_id !== h.warehouse_id || d.operation.client_key !== h.client_key) throw Error('Odczytano inną operację polityki.'); setOperation(d.operation); setPreview(null); setConsent(false); })}>Otwórz pełny zapis polityki {h.id}</button></li>)}</ul>{historyCursor && <button className="button" type="button" disabled={reading || inFlight} onClick={() => readHistory(true)}>Dalsza historia polityk</button>}</div>}
    </>}
  </div></section>;
}
