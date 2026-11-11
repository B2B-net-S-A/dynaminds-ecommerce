import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './product-catalogs.css';
import { productCatalogsWriteLocked } from './product-catalogs';
import { catalogExportLocked } from './catalog-export';
import { getStockFileImportLock } from './stock-file-import';
import { subscribeLanguageFileImportLock } from './language-file-import';

const base = '/b2b/catalog-scope';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
type Side = 'supplier' | 'buyer';
type Attempt = { context: string; side: Side; entityId: string; kind: 'preview' | 'commit'; path: string; body: string; preview?: Preview };
type Flags = { available: boolean; read_only: boolean; current_role: string | null; can_read: boolean; can_manage: boolean; can_read_inventory: boolean };
let actorContext = '', epoch = 0, inFlight = false;
let languageLocked = false, releaseLanguageLock: (() => void) | null = null;
let retained: Attempt | null = null;
let outcome: { attempt: Attempt; reply: unknown } | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((fn) => fn());
export function resetB2bCatalogScopeContext(next: string) {
  if (next === actorContext) return;
  actorContext = next; epoch++; inFlight = false; retained = null; outcome = null; publish();
  releaseLanguageLock?.(); languageLocked = false;
  releaseLanguageLock = subscribeLanguageFileImportLock(next, locked => { if (actorContext === next) languageLocked = locked; });
}
const siblingLocked = (key: string) => productCatalogsWriteLocked(key) || catalogExportLocked(key) || getStockFileImportLock(key) || (actorContext === key && languageLocked);
export function b2bCatalogScopeWriteLocked(contextKey: string) { return contextKey === actorContext && Boolean(inFlight || retained); }
export function subscribeB2bCatalogScopeLock(contextKey: string, callback: (locked: boolean) => void) {
  const fn = () => callback(b2bCatalogScopeWriteLocked(contextKey));
  listeners.add(fn); fn(); return () => { listeners.delete(fn); };
}
export type B2bFreshWriteGuard = (exactRetry?: boolean) => Promise<() => void>;
/** Return the same synchronous fence for the caller's immediate pre-POST check. */
export function b2bCatalogSiblingWriteGuard(contextKey: string, allowed: (exactRetry: boolean) => boolean): B2bFreshWriteGuard {
  return async (exactRetry = false) => {
    const check = () => {
      if (actorContext !== contextKey || !allowed(exactRetry) || (!exactRetry && (b2bCatalogScopeWriteLocked(contextKey) || siblingLocked(contextKey)))) throw Error('Zmienił się kontekst lub inna operacja blokuje nowy zapis B2B.');
    };
    check(); await checkActor(contextKey); check(); return check;
  };
}
function purge(contextKey: string) {
  if (contextKey !== actorContext) return;
  epoch++; inFlight = false; retained = null; outcome = null; publish();
}
function checkFlags(d: Flags, contextKey: string) {
  if (!d || ['available', 'read_only', 'can_read', 'can_manage', 'can_read_inventory'].some((k) => typeof d[k as keyof Flags] !== 'boolean') || (d.current_role !== null && !['admin', 'operator', 'viewer'].includes(d.current_role))) throw Error('Niepełny odczyt dostępu do konfiguracji B2B.');
  if (d.current_role !== null && d.current_role !== contextKey.split(':')[2]) throw new ApiError('Zmieniła się rola użytkownika.', 403);
}
async function checkActor(contextKey: string) {
  const parts = contextKey.split(':'), d = await api('/auth/me');
  if (parts.length !== 4 || !uuid(parts[0]) || !uuid(parts[1]) || !['admin', 'operator', 'viewer'].includes(parts[2]) || !['true', 'false'].includes(parts[3]) || `${d.user?.tenant_id}:${d.user?.id}:${d.user?.role}` !== parts.slice(0, 3).join(':')) throw new ApiError('Zmienił się użytkownik lub firma.', 403);
}
function entityPath(side: Side, entityId: string) {
  if (!uuid(entityId)) throw Error('Nieprawidłowe konto lub połączenie B2B.');
  return side === 'supplier' ? `/b2b/accounts/${entityId}/catalog-scope` : `/b2b/network/links/${entityId}/catalog-scope`;
}
async function perform<T extends Flags>(attempt: Attempt, retry: boolean, gate: () => { active: boolean; readOnly: boolean; externalBlocked: boolean }, validate: (d: unknown, attempt: Attempt) => T): Promise<T | null> {
  if (attempt.context !== actorContext || inFlight || !gate().active || gate().readOnly || (retry ? retained !== attempt : Boolean(retained))) return null;
  if (!retry && (gate().externalBlocked || siblingLocked(attempt.context))) return null;
  const e = epoch, current = () => actorContext === attempt.context && epoch === e;
  const body = JSON.parse(attempt.body);
  const expectedPath = attempt.kind === 'preview' ? entityPath(attempt.side, attempt.entityId) + '/previews' : new RegExp('^' + base + '/previews/[a-f0-9-]{36}/commit$');
  if (!uuid(body.client_key) || (typeof expectedPath === 'string' ? attempt.path !== expectedPath : !expectedPath.test(attempt.path))) throw Error('Nieprawidłowa zachowana próba konfiguracji B2B.');
  inFlight = true; publish(); let sent = false;
  try {
    await checkActor(attempt.context);
    if (!current()) return null;
    const fresh = await api<SourceReply>(entityPath(attempt.side, attempt.entityId));
    if (!current()) return null;
    checkSource(fresh, attempt.side, attempt.entityId, attempt.context);
    if (!gate().active) return null;
    if (!fresh.available) throw new ApiError('Ta kopia nie obsługuje zakresu katalogu B2B. Zachowano dokładną próbę.', 503);
    if (!fresh.can_manage || (attempt.side === 'supplier' && !fresh.can_read_inventory) || fresh.read_only || gate().readOnly) throw new ApiError('Brak aktualnego prawa do zmiany zakresu B2B.', fresh.read_only || gate().readOnly ? 423 : 403);
    if (!retry && attempt.kind === 'preview' && !fresh.can_preview) throw new ApiError('Pierwsze przypisanie nie jest już dostępne. Odczytaj aktualną konfigurację.', 409);
    if (!retry && (gate().externalBlocked || siblingLocked(attempt.context))) throw Error('Inna operacja blokuje nową zmianę produktów.');
    retained = attempt; sent = true; publish();
    const raw = await api(attempt.path, 'POST', body);
    if (!current()) return null;
    const reply = validate(raw, attempt); checkFlags(reply, attempt.context);
    await checkActor(attempt.context);
    if (!current()) return null;
    const final = await api<SourceReply>(entityPath(attempt.side, attempt.entityId));
    if (!current()) return null;
    checkSource(final, attempt.side, attempt.entityId, attempt.context);
    if (!final.available) throw new ApiError('Zakres katalogu B2B jest obecnie niedostępny. Zachowano dokładną próbę.', 503);
    if (!final.can_read) throw new ApiError('Odebrano dostęp do zapisanego zakresu B2B.', 403);
    if (reply.can_read_inventory && !final.can_read_inventory) throw new ApiError('Odebrano dostęp do danych magazynu.', 403);
    outcome = { attempt: { ...attempt, body: '{}' }, reply }; retained = null; return reply;
  } catch (error) {
    if (current() && error instanceof ApiError) {
      if ([401, 403].includes(error.status)) purge(attempt.context);
      else if (sent && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) retained = null;
    }
    throw error;
  } finally { if (current()) { inFlight = false; publish(); } }
}

export type B2bCatalogScopePanelProps = { contextKey: string; readOnly: boolean; kind: Side; entityId: string; externalWriteBlocked?: boolean; onLockedChange?: (locked: boolean) => void; onChanged?: () => void; onError?: (message: string) => void };

type CatalogChoice = { id: string; name: string; version: string; active: boolean; languages: string[]; warehouse_ids: string[]; price_list_ids: string[] };
type Warehouse = { id: string; name: string; code?: string };
type PriceList = { id: string; name: string; currency: string; version: string; active: boolean };
type Selection = { catalog: string; warehouse: string; priceList: string; language: string };
const blankSelection = (): Selection => ({ catalog: '', warehouse: '', priceList: '', language: '' });
type Entity = { id: string; version: string; name?: string; active?: boolean; warehouse_id?: string | null; price_list_id?: string; account_id?: string; supplier_name?: string; paused?: boolean; schedule_minutes?: number };
type Scope = { protocol: 'catalog_scope_v1'; kind: Side; account_id?: string; link_id?: string; catalog_id?: string; target_catalog_id?: string; warehouse_id?: string | null; price_list_id?: string; language?: string; version: '1'; operation_id: string; created_at: string };
type Snapshot = { protocol: 'catalog_scope_v1'; kind: Side; entity_id: string; before: Entity; catalog: CatalogChoice; resources: { warehouse?: Warehouse | null; price_list?: Omit<PriceList, 'name'>; language?: string; supplier?: { name: string; account_id: string } }; scope_before: null };
type Preview = { id: string; kind: Side; entity_id: string; catalog_id: string; request: Record<string, string | null>; scope_hash: string; snapshot: Snapshot; created_at: string; expires_at: string; ready: true; committed_operation_id: string | null; can_commit: boolean };
type Operation = { id: string; preview_id: string; kind: Side; entity_id: string; scope_hash: string; request: { client_key: string; scope_hash: string; confirmed: true }; snapshot: Snapshot; before: Entity; after: Entity; scope: Scope; created_at: string };
type SourceReply = Flags & { source: { kind: Side; entity_id: string; account?: Entity; link?: Entity; scope: Scope | null } | null; scope: Scope | null; resources: { catalogs: CatalogChoice[]; warehouses: Warehouse[]; price_lists: PriceList[]; languages: string[] }; capabilities: { protocol: string; first_configuration_only: boolean; publication_available: boolean; import_available: boolean }; can_preview?: boolean };
type Reply = Flags & { preview?: Preview; operation?: Operation; scope?: Scope; reused?: boolean };
type Header = { id: string; kind: Side; entity_id: string; scope_hash: string; created_at: string; catalog_id?: string; preview_id?: string; expires_at?: string; committed_operation_id?: string | null };
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => [k, canonical(value)])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function checkCatalog(c: CatalogChoice) {
  if (!c || !uuid(c.id) || !version(c.version) || typeof c.name !== 'string' || typeof c.active !== 'boolean' || ['languages', 'warehouse_ids', 'price_list_ids'].some(k => !Array.isArray(c[k as 'languages']))) throw Error('Niepełne przypisania katalogu B2B.');
  if (c.languages.length > 64 || c.languages.some(l => typeof l !== 'string' || !/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/.test(l)) || c.warehouse_ids.length > 100 || c.price_list_ids.length > 100 || [...c.warehouse_ids, ...c.price_list_ids].some(id => !uuid(id)) || [c.languages, c.warehouse_ids, c.price_list_ids].some(ids => new Set(ids).size !== ids.length)) throw Error('Niepoprawny zakres przypisań katalogu.');
}
function checkSnapshot(s: Snapshot, side: Side, entityId: string, inventory: boolean) {
  if (!s || s.protocol !== 'catalog_scope_v1' || s.kind !== side || s.entity_id !== entityId || s.scope_before !== null || s.before?.id !== entityId || !version(s.before.version) || !s.resources) throw Error('Niepełny historyczny zakres B2B.');
  checkCatalog(s.catalog);
  if (!inventory && s.catalog.warehouse_ids.length) throw Error('Odczyt zawiera dane magazynu bez uprawnienia.');
  if (side === 'supplier') {
    const warehouse = s.resources.warehouse, list = s.resources.price_list;
    if (typeof s.before.active !== 'boolean' || !uuid(s.before.price_list_id) || !list || !uuid(list.id) || !version(list.version) || typeof list.currency !== 'string' || list.active !== true || !s.catalog.price_list_ids.includes(list.id) || !s.catalog.languages.includes(s.resources.language ?? '')) throw Error('Niepełne zasoby dostawcy. Podgląd nie uprawnia do zapisu.');
    if (inventory ? (!uuid(s.before.warehouse_id) || !warehouse || !uuid(warehouse.id) || typeof warehouse.name !== 'string' || !s.catalog.warehouse_ids.includes(warehouse.id)) : (s.before.warehouse_id !== null || warehouse !== null)) throw Error('Niezgodny odczyt danych magazynu.');
  } else if (!uuid(s.before.account_id) || typeof s.before.paused !== 'boolean' || !Number.isInteger(s.before.schedule_minutes) || s.resources.supplier?.account_id !== s.before.account_id || typeof s.resources.supplier?.name !== 'string') throw Error('Niepełne powiązanie odbiorcy.');
}
function checkScope(s: Scope, snapshot: Snapshot, inventory: boolean, operationId?: string) {
  const supplier = snapshot.kind === 'supplier';
  if (!s || s.protocol !== 'catalog_scope_v1' || s.kind !== snapshot.kind || s.version !== '1' || !uuid(s.operation_id) || (operationId && s.operation_id !== operationId) || (supplier ? s.account_id : s.link_id) !== snapshot.entity_id || (supplier ? s.catalog_id : s.target_catalog_id) !== snapshot.catalog.id) throw Error('Niezgodny trwały zakres B2B.');
  if (supplier && (s.warehouse_id !== (inventory ? snapshot.resources.warehouse?.id : null) || s.price_list_id !== snapshot.resources.price_list?.id || s.language !== snapshot.resources.language)) throw Error('Niezgodne trwałe przypisania dostawcy.');
}
function checkPreview(p: Preview, side: Side, entityId: string, inventory: boolean) {
  if (!p || !uuid(p.id) || p.kind !== side || p.entity_id !== entityId || !uuid(p.catalog_id) || !hash(p.scope_hash) || p.ready !== true || typeof p.can_commit !== 'boolean' || !Number.isFinite(Date.parse(p.expires_at)) || (p.committed_operation_id !== null && !uuid(p.committed_operation_id)) || !uuid(p.request?.client_key)) throw Error('Niepełny podgląd konfiguracji B2B. Dokładna próba została zachowana.');
  checkSnapshot(p.snapshot, side, entityId, inventory);
  if (side === 'supplier' && !inventory && p.can_commit) throw Error('Ograniczony odczyt magazynu nie uprawnia do zapisu.');
  const r = p.request, s = p.snapshot, supplier = side === 'supplier';
  if (p.catalog_id !== s.catalog.id || (supplier ? r.catalog_id : r.target_catalog_id) !== s.catalog.id || (supplier ? r.catalog_version : r.target_catalog_version) !== s.catalog.version || (supplier ? r.account_version : r.link_version) !== s.before.version || Object.keys(r).length !== (supplier ? 7 : 4)) throw Error('Podgląd nie potwierdza wersji wybranej konfiguracji.');
  if (supplier && (r.warehouse_id !== (inventory ? s.resources.warehouse?.id : null) || r.price_list_id !== s.resources.price_list?.id || r.language !== s.resources.language)) throw Error('Podgląd nie potwierdza wybranych zasobów.');
}
function checkOperation(op: Operation, side: Side, entityId: string, inventory: boolean) {
  if (!op || !uuid(op.id) || !uuid(op.preview_id) || op.kind !== side || op.entity_id !== entityId || !hash(op.scope_hash) || !uuid(op.request?.client_key) || op.request.scope_hash !== op.scope_hash || op.request.confirmed !== true) throw Error('Niepełne potwierdzenie konfiguracji B2B. Dokładna próba została zachowana.');
  checkSnapshot(op.snapshot, side, entityId, inventory); checkScope(op.scope, op.snapshot, inventory, op.id);
  if (!same(op.before, op.snapshot.before) || op.after?.id !== entityId || op.after.version !== String(BigInt(op.before.version) + 1n)) throw Error('Niezgodne wersje wyniku B2B.');
  const expected = side === 'supplier' ? { ...op.before, version: op.after.version, warehouse_id: inventory ? op.snapshot.resources.warehouse?.id : null, price_list_id: op.snapshot.resources.price_list?.id } : { ...op.before, version: op.after.version };
  if (!same(op.after, expected)) throw Error('Wynik zmienił zakres spoza zatwierdzonej konfiguracji.');
}
function validate(d: unknown, a: Attempt): Reply {
  const r = d as Reply; checkFlags(r, a.context);
  if (typeof r.reused !== 'boolean') throw Error('Brak potwierdzenia dokładnej operacji B2B.');
  const body = JSON.parse(a.body);
  if (a.side === 'supplier' && !r.can_read_inventory) throw Error('Brak pełnego potwierdzenia zasobów magazynu dla zachowanej próby.');
  if (a.kind === 'preview') { checkPreview(r.preview!, a.side, a.entityId, r.can_read_inventory); if (!same(r.preview!.request, body)) throw Error('Podgląd odpowiada innej próbie.'); }
  else {
    checkOperation(r.operation!, a.side, a.entityId, r.can_read_inventory);
    const op = r.operation!;
    if (!a.preview || op.preview_id !== a.preview.id || !same(op.request, body) || op.scope_hash !== body.scope_hash || !same(op.snapshot, a.preview.snapshot) || !same(r.scope, op.scope)) throw Error('Wynik nie odpowiada zachowanej zgodzie.');
  }
  return r;
}
function checkSource(d: SourceReply, side: Side, entityId: string, key: string) {
  checkFlags(d, key);
  if (!d.can_read && d.available) throw new ApiError('Brak dostępu do konfiguracji B2B.', 403);
  if (!d.available) return;
  const s = d.source, r = d.resources, entity = side === 'supplier' ? s?.account : s?.link;
  if (!s || !entity || s.kind !== side || s.entity_id !== entityId || entity.id !== entityId || !version(entity.version) || typeof d.can_preview !== 'boolean' || !same(s.scope, d.scope) || !r || !d.capabilities || d.capabilities.protocol !== 'catalog_scope_v1' || d.capabilities.first_configuration_only !== true || typeof d.capabilities.publication_available !== 'boolean' || typeof d.capabilities.import_available !== 'boolean') throw Error('Niepełny odczyt konfiguracji B2B.');
  for (const [name, cap] of [['catalogs', 100], ['warehouses', 100], ['price_lists', 100], ['languages', 6400]] as const) if (!Array.isArray(r[name]) || r[name].length > cap) throw Error('Niepełna lista zasobów B2B.');
  r.catalogs.forEach(checkCatalog);
  if (!d.can_read_inventory && (r.warehouses.length || r.catalogs.some(c => c.warehouse_ids.length) || (side === 'supplier' && (entity.warehouse_id !== null || (d.scope && d.scope.warehouse_id !== null))))) throw Error('Odczyt zawiera dane magazynu bez uprawnienia.');
  if ([r.catalogs, r.warehouses, r.price_lists].some(rows => rows.some(row => !uuid(row.id)) || new Set(rows.map(row => row.id)).size !== rows.length) || r.warehouses.some(w => typeof w.name !== 'string') || r.price_lists.some(p => !version(p.version) || typeof p.name !== 'string' || typeof p.currency !== 'string' || typeof p.active !== 'boolean')) throw Error('Niepoprawne zasoby konfiguracji B2B.');
  if (d.scope && (d.scope.kind !== side || d.scope.version !== '1' || !uuid(d.scope.operation_id) || (side === 'supplier' ? d.scope.account_id : d.scope.link_id) !== entityId)) throw Error('Odczytano inny zapisany zakres.');
}
function ConfigurationFields({ side, catalogs, warehouses, priceLists, selection, disabled, change }: { side: Side; catalogs: CatalogChoice[]; warehouses: Warehouse[]; priceLists: PriceList[]; selection: Selection; disabled: boolean; change: (selection: Selection) => void }) {
  const selected = catalogs.find(c => c.id === selection.catalog);
  return <fieldset disabled={disabled}>
    <legend>{side === 'supplier' ? 'Zakres udostępnianych produktów' : 'Katalog własnych produktów odbiorcy'}</legend>
    <label>{side === 'supplier' ? 'Katalog dostawcy' : 'Katalog docelowy'}<select aria-label={side === 'supplier' ? 'Katalog dostawcy' : 'Katalog docelowy'} value={selection.catalog} onChange={e => change({ ...blankSelection(), catalog: e.target.value })}>
      <option value="">Wybierz aktywny katalog</option>{catalogs.map(c => <option key={c.id} value={c.id} disabled={!c.active}>{c.name}{!c.active ? ' · nieaktywny' : ''}</option>)}
    </select></label>
    {side === 'supplier' && <>
      <label>Magazyn dostępności<select aria-label="Magazyn dostępności" value={selection.warehouse} disabled={!selected} onChange={e => change({ ...selection, warehouse: e.target.value })}><option value="">Wybierz przypisany magazyn</option>{warehouses.filter(w => selected?.warehouse_ids.includes(w.id)).map(w => <option key={w.id} value={w.id}>{w.name}{w.code ? ` (${w.code})` : ''}</option>)}</select></label>
      <label>Cennik oferty<select aria-label="Cennik oferty" value={selection.priceList} disabled={!selected} onChange={e => change({ ...selection, priceList: e.target.value })}><option value="">Wybierz przypisany cennik</option>{priceLists.filter(p => selected?.price_list_ids.includes(p.id)).map(p => <option key={p.id} value={p.id} disabled={!p.active}>{p.name} ({p.currency}){!p.active ? ' · nieaktywny' : ''}</option>)}</select></label>
      <label>Język oferty<select aria-label="Język oferty" value={selection.language} disabled={!selected} onChange={e => change({ ...selection, language: e.target.value })}><option value="">Wybierz przypisany język</option>{selected?.languages.map(l => <option key={l} value={l}>{l}</option>)}</select></label>
    </>}
    <p>{side === 'supplier' ? 'Dostępność dostawcy jest informacją oferty. Nie przyjmuje towaru do magazynu odbiorcy.' : 'Wybór katalogu nie przenosi istniejących produktów ani nie tworzy ich automatycznie.'}</p>
  </fieldset>;
}

function SnapshotView({ snapshot, after }: { snapshot: Snapshot; after?: Entity }) {
  const s = snapshot, supplier = s.kind === 'supplier';
  return <dl className="pc-summary">
    <dt>Katalog</dt><dd>{s.catalog.name} · sprawdzona wersja {s.catalog.version}</dd>
    <dt>Wersja {supplier ? 'konta' : 'powiązania'}</dt><dd>{s.before.version}{after ? ` → ${after.version}` : ' · przed zapisem'}</dd>
    {supplier ? <><dt>Magazyn dostępności</dt><dd>{s.resources.warehouse ? `${s.resources.warehouse.name}${s.resources.warehouse.code ? ` (${s.resources.warehouse.code})` : ''}` : 'Dane magazynu niedostępne przy tym uprawnieniu.'}</dd><dt>Cennik</dt><dd>{s.resources.price_list?.id} · {s.resources.price_list?.currency} · wersja {s.resources.price_list?.version}</dd><dt>Język</dt><dd>{s.resources.language}</dd><dt>Przed zmianą</dt><dd>Magazyn {s.before.warehouse_id ?? 'niedostępny przy tym uprawnieniu'}; cennik {s.before.price_list_id}. Konto {s.before.active ? 'aktywne' : 'nieaktywne'}.</dd></> : <><dt>Dostawca</dt><dd>{s.resources.supplier?.name}</dd><dt>Harmonogram</dt><dd>{s.before.schedule_minutes} min · {s.before.paused ? 'wstrzymany' : 'niewstrzymany'}; konfiguracja go nie zmienia.</dd></>}
    <dt>Skutek</dt><dd>Pierwsze przypisanie zakresu. Nie publikuje ofert, nie importuje produktów i nie porusza towaru ani płatności.</dd>
  </dl>;
}

// Isolated consumer of WIRE159. Routes and parent mount are separate root work.
export function B2bCatalogScopePanel(props: B2bCatalogScopePanelProps) {
  const key = props.contextKey, side = props.kind, entityId = props.entityId;
  const scope = `${key}:${side}:${entityId}:${props.readOnly}`;
  const [source, setSource] = useState<SourceReply | null>(null), [selection, setSelection] = useState(blankSelection), [preview, setPreview] = useState<Preview | null>(null), [operation, setOperation] = useState<Operation | null>(null), [consent, setConsent] = useState(false), [error, setError] = useState(''), [reading, setReading] = useState(false), [signal, setSignal] = useState(0), [history, setHistory] = useState<Header[]>([]), [historyKind, setHistoryKind] = useState<'preview' | 'operation'>('operation'), [cursor, setCursor] = useState<string | null>(null), [historyLoaded, setHistoryLoaded] = useState(false), [failedPreview, setFailedPreview] = useState('');
  const alive = useRef(false), generation = useRef(0), latest = useRef({ scope, readOnly: props.readOnly, externalBlocked: Boolean(props.externalWriteBlocked) }), seenOutcome = useRef<typeof outcome>(null), previousReadOnly = useRef(props.readOnly), loadedEpoch = useRef(-1), loadedInventory = useRef<boolean | null>(null);
  latest.current = { scope, readOnly: props.readOnly, externalBlocked: Boolean(props.externalWriteBlocked) };
  const current = (g: number, e: number) => alive.current && latest.current.scope === scope && generation.current === g && actorContext === key && epoch === e;
  const locked = b2bCatalogScopeWriteLocked(key), busy = reading || (actorContext === key && inFlight), writable = Boolean(source?.available && source.can_manage && (side !== 'supplier' || source.can_read_inventory) && !source.read_only && !props.readOnly), blocked = !writable || busy || locked || Boolean(props.externalWriteBlocked);
  const ownAttempt = retained?.context === key && retained.side === side && retained.entityId === entityId ? retained : null;
  const catalog = source?.resources.catalogs.find(c => c.id === selection.catalog);
  function clear() { setSource(null); setSelection(blankSelection()); setPreview(null); setOperation(null); setConsent(false); setHistory([]); setCursor(null); setHistoryLoaded(false); setFailedPreview(''); loadedEpoch.current = -1; loadedInventory.current = null; }
  function fail(err: unknown) {
    const text = err instanceof Error ? err.message : 'Nie udało się odczytać zakresu B2B.'; setError(text); props.onError?.(text);
    if (err instanceof ApiError && [401, 403].includes(err.status)) { purge(key); clear(); }
    else if (err instanceof ApiError && [404, 503].includes(err.status)) { setSource(null); setConsent(false); }
  }
  useEffect(() => {
    alive.current = true; generation.current++; resetB2bCatalogScopeContext(key);
    if (previousReadOnly.current !== props.readOnly) purge(key);
    previousReadOnly.current = props.readOnly; clear(); setError('');
    const un = subscribeB2bCatalogScopeLock(key, () => setSignal(v => v + 1));
    void readSource();
    return () => { alive.current = false; generation.current++; un(); };
  }, [scope]);
  useEffect(() => { props.onLockedChange?.(locked); }, [locked, signal, props.onLockedChange]);
  useEffect(() => {
    if (loadedEpoch.current >= 0 && loadedEpoch.current !== epoch) clear();
    if (!source?.can_read || !outcome || outcome === seenOutcome.current || outcome.attempt.context !== key || outcome.attempt.side !== side || outcome.attempt.entityId !== entityId) return;
    seenOutcome.current = outcome; const r = outcome.reply as Reply;
    if (r.can_read_inventory !== source.can_read_inventory) return;
    if (r.preview) { setPreview(r.preview); setOperation(null); }
    if (r.operation) { setOperation(r.operation); setPreview(null); }
    setConsent(false);
  }, [signal, source, scope]);
  async function readSource() {
    const g = generation.current, e = epoch; setReading(true);
    try { await checkActor(key); if (!current(g, e)) return; const d = await api<SourceReply>(entityPath(side, entityId)); if (!current(g, e)) return; checkSource(d, side, entityId, key); if (loadedInventory.current && !d.can_read_inventory) { setPreview(null); setOperation(null); setSelection(blankSelection()); setConsent(false); } loadedInventory.current = d.can_read_inventory; setSource(d); loadedEpoch.current = e; setError(''); }
    catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && generation.current === g && latest.current.scope === scope) setReading(false); }
  }
  async function mutate(attempt: Attempt, retry = false) {
    if (busy || props.readOnly || (!retry && blocked)) return;
    const g = generation.current, e = epoch; setConsent(false); setError('');
    try {
      const r = await perform(attempt, retry, () => ({ active: alive.current && generation.current === g && latest.current.scope === scope, readOnly: latest.current.readOnly, externalBlocked: latest.current.externalBlocked }), validate);
      if (!r || !current(g, e)) return;
      seenOutcome.current = outcome;
      loadedInventory.current = r.can_read_inventory;
      if (r.preview) { setPreview(r.preview); setOperation(null); setFailedPreview(''); }
      if (r.operation) { setOperation(r.operation); setPreview(null); props.onChanged?.(); }
      await readSource();
    } catch (err) { if (current(g, e)) { if (err instanceof ApiError && err.status === 409 && attempt.kind === 'commit') setFailedPreview(attempt.preview?.id ?? ''); fail(err); } }
  }
  function createPreview() {
    if (blocked || !catalog?.active || source?.scope || !source?.can_preview) return;
    const entity = side === 'supplier' ? source?.source?.account : source?.source?.link;
    if (!entity || !version(entity.version) || !version(catalog.version)) return;
    if (side === 'supplier' && (!catalog.warehouse_ids.includes(selection.warehouse) || !catalog.price_list_ids.includes(selection.priceList) || !catalog.languages.includes(selection.language) || !source.resources.price_lists.some(p => p.id === selection.priceList && p.active))) { setError('Wybierz magazyn, cennik i język przypisane do tego katalogu.'); return; }
    const body = side === 'supplier' ? { client_key: crypto.randomUUID(), account_version: entity.version, catalog_id: catalog.id, catalog_version: catalog.version, warehouse_id: selection.warehouse, price_list_id: selection.priceList, language: selection.language } : { client_key: crypto.randomUUID(), link_version: entity.version, target_catalog_id: catalog.id, target_catalog_version: catalog.version };
    void mutate({ context: key, side, entityId, kind: 'preview', path: entityPath(side, entityId) + '/previews', body: JSON.stringify(body) });
  }
  const canCommit = !blocked && Boolean(preview?.can_commit && !preview.committed_operation_id && preview.id !== failedPreview && Date.parse(preview.expires_at) > Date.now());
  function commit() { if (!canCommit || !consent || !preview) return; void mutate({ context: key, side, entityId, kind: 'commit', path: base + '/previews/' + preview.id + '/commit', body: JSON.stringify({ client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true }), preview: structuredClone(preview) }); }
  async function readHistory(more = false) {
    if (busy) return; const g = generation.current, e = epoch; setReading(true);
    try {
      await checkActor(key); if (!current(g, e)) return;
      const d = await api<Flags & { data: Header[]; next_cursor: string | null }>(entityPath(side, entityId) + '/history?kind=' + historyKind + '&limit=50' + (more && cursor ? '&cursor=' + cursor : ''));
      if (!current(g, e)) return; checkFlags(d, key); if (!d.can_read) throw new ApiError('Brak prawa do odczytu historii B2B.', 403);
      const existing = more ? history : [];
      if (!Array.isArray(d.data) || d.data.length > 50 || (d.next_cursor !== null && (!uuid(d.next_cursor) || d.next_cursor === cursor)) || d.data.some(h => !uuid(h.id) || h.kind !== side || h.entity_id !== entityId || !hash(h.scope_hash)) || new Set([...existing, ...d.data].map(h => h.id)).size !== existing.length + d.data.length) throw Error('Niepełna strona historii B2B.');
      setHistory([...existing, ...d.data]); setCursor(d.next_cursor); setHistoryLoaded(true); setError('');
    } catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && generation.current === g && latest.current.scope === scope) setReading(false); }
  }
  async function openDetail(h: Header, detailKind = historyKind) {
    if (busy) return; const g = generation.current, e = epoch; setReading(true); setConsent(false);
    try {
      await checkActor(key); if (!current(g, e)) return;
      const d = await api<Reply>(base + (detailKind === 'preview' ? '/previews/' : '/operations/') + h.id);
      if (!current(g, e)) return; checkFlags(d, key); if (!d.can_read) throw new ApiError('Brak prawa do szczegółów B2B.', 403);
      if (detailKind === 'preview') { checkPreview(d.preview!, side, entityId, d.can_read_inventory); if (d.preview!.id !== h.id || d.preview!.scope_hash !== h.scope_hash) throw Error('Niezgodny szczegół podglądu.'); setPreview(d.preview!); setOperation(null); }
      else { checkOperation(d.operation!, side, entityId, d.can_read_inventory); if (d.operation!.id !== h.id || (h.scope_hash && d.operation!.scope_hash !== h.scope_hash)) throw Error('Niezgodny szczegół operacji.'); setOperation(d.operation!); setPreview(null); }
      loadedInventory.current = d.can_read_inventory; setError('');
    } catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && generation.current === g && latest.current.scope === scope) setReading(false); }
  }
  return <section className="panel product-catalogs" aria-label="Zakres katalogu B2B">
    <header><h2>{side === 'supplier' ? 'Katalog udostępniany odbiorcy B2B' : 'Katalog odbiorcy B2B'}</h2></header><div className="pc-body">
      <p>Pierwsze jawne przypisanie katalogu. Publikacja ofert i import produktów są oddzielnymi procesami.</p>
      <button type="button" disabled={busy} onClick={() => void readSource()}>Odczytaj konfigurację B2B</button>
      {error && <p role="alert">{error}</p>}
      {source && !source.available && <p>Ta kopia nie obsługuje zakresu katalogu B2B. Nic nie zostanie zapisane.</p>}
      {source?.available && <>
        {!writable && <p>Konfiguracja jest dostępna tylko do odczytu.</p>}
        {source.scope ? <div className="pc-review"><h3>Zapisane przypisanie</h3><p>Katalog: {source.resources.catalogs.find(c => c.id === (source.scope?.catalog_id ?? source.scope?.target_catalog_id))?.name ?? (source.scope.catalog_id ?? source.scope.target_catalog_id)} · wersja przypisania 1. Zmiana istniejącego zakresu nie jest dostępna.</p><button type="button" disabled={busy} onClick={() => void openDetail({ id: source.scope!.operation_id, kind: side, entity_id: entityId, scope_hash: '', created_at: source.scope!.created_at }, 'operation')}>Odczytaj wynik pierwszej konfiguracji</button></div> : <><ConfigurationFields side={side} catalogs={source.resources.catalogs} warehouses={source.resources.warehouses} priceLists={source.resources.price_lists} selection={selection} disabled={blocked} change={v => { if (!blocked) { setSelection(v); setPreview(null); setOperation(null); setConsent(false); } }} /><button type="button" disabled={blocked || !source.can_preview || !catalog?.active || (side === 'supplier' && (!selection.warehouse || !selection.priceList || !selection.language))} onClick={createPreview}>Przygotuj podgląd zakresu B2B</button></>}
        <label>Rodzaj historii<select aria-label="Rodzaj historii B2B" value={historyKind} disabled={busy} onChange={e => { setHistoryKind(e.target.value as 'preview' | 'operation'); setHistory([]); setCursor(null); setHistoryLoaded(false); }}><option value="operation">Zapisane konfiguracje</option><option value="preview">Podglądy</option></select></label>
        <button type="button" disabled={busy} onClick={() => void readHistory()}>Odczytaj historię zakresu B2B</button>
        {historyLoaded && <ul className="pc-history">{history.map(h => <li key={h.id}>{date(h.created_at)} <button type="button" disabled={busy} onClick={() => void openDetail(h)}>Otwórz pełny zapis {h.id}</button></li>)}</ul>}
        {cursor && <button type="button" disabled={busy} onClick={() => void readHistory(true)}>Następna strona historii B2B</button>}
      </>}
      {locked && <p role="status">{ownAttempt ? 'Wynik próby jest niepotwierdzony. Zachowano dokładne żądanie. Odczyt historii nie zwalnia tej próby.' : 'Inna próba konfiguracji B2B blokuje nowe zapisy. Wróć do właściwego konta lub powiązania.'}</p>}
      {ownAttempt && <button type="button" disabled={busy || !writable} onClick={() => void mutate(ownAttempt, true)}>Ponów dokładną próbę zakresu B2B</button>}
      {preview && <div className="pc-review"><h3>Podgląd zakresu do zapisania</h3><SnapshotView snapshot={preview.snapshot} /><p>Wygasa: {date(preview.expires_at)}</p>{preview.id === failedPreview && <p>Ten podgląd został odrzucony. Przygotuj nowy podgląd.</p>}{preview.committed_operation_id && <p>Podgląd ma już zapisany wynik. Odczytaj historię konfiguracji.</p>}<label className="pc-check"><input type="checkbox" checked={consent} disabled={!canCommit} onChange={e => setConsent(e.target.checked)} />Sprawdziłem pełny zakres i zatwierdzam pierwsze przypisanie katalogu B2B.</label><button type="button" disabled={!canCommit || !consent} onClick={commit}>Zapisz zatwierdzony zakres B2B</button></div>}
      {operation && <div className="pc-review"><h3>Konfiguracja B2B zapisana</h3><p>Operacja {operation.id} · {date(operation.created_at)}</p><SnapshotView snapshot={operation.snapshot} after={operation.after} /></div>}
    </div>
  </section>;
}
