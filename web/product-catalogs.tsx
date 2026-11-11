import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './product-catalogs.css';

const base = '/product-catalogs';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export type ProductCatalogSettings = { name: string; active: boolean; languages: string[]; default_language: string; warehouse_ids: string[]; price_list_ids: string[] };
export type ProductCatalog = { id: string; name: string; active: boolean; is_default: boolean; version: string; settings: ProductCatalogSettings; product_count: number; created_at: string; updated_at: string };
type Flags = { available: boolean; read_only: boolean; current_role: string | null; can_read: boolean; can_manage: boolean };
type Warehouse = { id: string; name: string; code?: string };
type PriceList = { id: string; name: string; currency: string; active: boolean; version: string };
type Options = Flags & { catalogs: ProductCatalog[]; warehouses: Warehouse[]; price_lists: PriceList[]; languages: string[]; capabilities: Record<string, boolean>; limits: Record<string, number> };
type Preview = { id: string; kind: 'create' | 'update'; catalog_id: string | null; version: string | null; client_key: string; scope_hash: string; before: ProductCatalog | null; after: ProductCatalogSettings; resources: { warehouses: Warehouse[]; price_lists: PriceList[]; languages: string[] }; blockers: string[]; ready: boolean; created_at: string; expires_at: string; can_commit: boolean; operation_id: string | null };
type Operation = { id: string; preview_id: string; catalog_id: string; kind: 'create' | 'update'; client_key: string; request: { client_key: string; scope_hash: string; confirmed: true }; before: ProductCatalog | null; after: ProductCatalog; scope_hash: string; created_at: string };
type Reply = Flags & { preview?: Preview; operation?: Operation; catalog?: ProductCatalog; reused: boolean };
type Attempt = { context: string; kind: 'preview' | 'commit'; path: string; body: string };
let context = '', epoch = 0, inFlight = false;
let pending: Attempt | null = null;
let outcome: { attempt: Attempt; reply: Reply } | null = null;
const subscribers = new Set<() => void>();
const publish = () => subscribers.forEach((fn) => fn());
export function resetProductCatalogsContext(next: string) {
  if (context === next) return;
  context = next; epoch++; pending = null; outcome = null; inFlight = false; publish();
}
export function subscribeProductCatalogsLock(key: string, callback: (locked: boolean) => void) {
  const fn = () => callback(key === context && Boolean(pending || inFlight));
  subscribers.add(fn); fn(); return () => { subscribers.delete(fn); };
}
export function productCatalogsWriteLocked(key: string) { return context === key && Boolean(pending || inFlight); }
function purge(key: string) { if (key !== context) return; epoch++; pending = null; outcome = null; inFlight = false; publish(); }
function checkFlags(d: Flags, key: string) {
  if (!d || ['available', 'read_only', 'can_read', 'can_manage'].some((k) => typeof d[k as keyof Flags] !== 'boolean') || (d.current_role !== null && !['admin', 'operator', 'viewer'].includes(d.current_role))) throw Error('Niepełny odczyt uprawnień katalogów.');
  if (d.current_role !== null && d.current_role !== key.split(':')[2]) throw new ApiError('Zmieniła się rola użytkownika.', 403);
}
async function actor(key: string) {
  const parts = key.split(':'), d = await api('/auth/me');
  if (parts.length !== 4 || !uuid(parts[0]) || !uuid(parts[1]) || !['true', 'false'].includes(parts[3]) || `${d.user?.tenant_id}:${d.user?.id}:${d.user?.role}` !== parts.slice(0, 3).join(':')) throw new ApiError('Zmienił się użytkownik lub firma.', 403);
}
function settingsValid(s: ProductCatalogSettings) {
  return s && typeof s.name === 'string' && s.name.trim().length >= 2 && s.name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(s.name) && typeof s.active === 'boolean' && Array.isArray(s.languages) && s.languages.length > 0 && s.languages.length <= 64 && s.languages.every((v) => typeof v === 'string' && v.length <= 40 && /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/.test(v)) && new Set(s.languages).size === s.languages.length && s.languages.includes(s.default_language) && [s.warehouse_ids, s.price_list_ids].every((ids) => Array.isArray(ids) && ids.length <= 100 && ids.every(uuid) && new Set(ids).size === ids.length) && s.warehouse_ids.length > 0;
}
const settingsEqual = (a: ProductCatalogSettings, b: ProductCatalogSettings) => settingsValid(a) && settingsValid(b) && a.name === b.name && a.active === b.active && a.default_language === b.default_language && ['languages', 'warehouse_ids', 'price_list_ids'].every((k) => JSON.stringify([...a[k as 'languages']].sort()) === JSON.stringify([...b[k as 'languages']].sort()));
function checkCatalog(c: ProductCatalog) { if (!c || !uuid(c.id) || !version(c.version) || !settingsValid(c.settings) || c.name !== c.settings.name || c.active !== c.settings.active || typeof c.is_default !== 'boolean' || !Number.isSafeInteger(c.product_count) || c.product_count < 0) throw Error('Niepełny zapis katalogu.'); }
function checkOperation(op: Operation) {
  if (!op || !uuid(op.id) || !uuid(op.preview_id) || !uuid(op.catalog_id) || !uuid(op.client_key) || !sha(op.scope_hash) || op.request?.client_key !== op.client_key || op.request?.scope_hash !== op.scope_hash || op.request?.confirmed !== true || !['create', 'update'].includes(op.kind)) throw Error('Niepełny trwały wynik konfiguracji.');
  checkCatalog(op.after);
  if (op.after.id !== op.catalog_id) throw Error('Niezgodny katalog trwałego wyniku.');
  if (op.kind === 'create') { if (op.before !== null || op.after.version !== '1') throw Error('Niezgodny zapis nowego katalogu.'); }
  else { if (!op.before) throw Error('Brak konfiguracji przed zmianą.'); checkCatalog(op.before); if (op.before.id !== op.catalog_id || op.after.version !== String(BigInt(op.before.version) + 1n)) throw Error('Niezgodna wersja trwałego wyniku.'); }
}
function checkPreview(p: Preview) {
  if (!p || !uuid(p.id) || !uuid(p.client_key) || !sha(p.scope_hash) || !['create', 'update'].includes(p.kind) || !settingsValid(p.after) || !Array.isArray(p.blockers) || p.blockers.some((b) => typeof b !== 'string') || typeof p.ready !== 'boolean' || typeof p.can_commit !== 'boolean' || !Number.isFinite(Date.parse(p.expires_at)) || !p.resources || !Array.isArray(p.resources.warehouses) || !Array.isArray(p.resources.price_lists) || !Array.isArray(p.resources.languages) || (p.operation_id !== null && !uuid(p.operation_id))) throw Error('Niepełny podgląd katalogu. Dokładna próba została zachowana.');
  if (p.kind === 'update') { if (!uuid(p.catalog_id) || !version(p.version) || !p.before || p.before.id !== p.catalog_id || p.before.version !== p.version) throw Error('Niezgodny katalog podglądu.'); checkCatalog(p.before); }
  else if (p.catalog_id !== null || p.version !== null || p.before !== null) throw Error('Niezgodny nowy katalog podglądu.');
}
function validateReply(d: Reply, a: Attempt) {
  checkFlags(d, a.context);
  if (typeof d.reused !== 'boolean') throw Error('Brak trwałego potwierdzenia katalogu.');
  const body = JSON.parse(a.body);
  if (a.kind === 'preview') {
    checkPreview(d.preview!);
    const p = d.preview!;
    if (p.client_key !== body.client_key || p.kind !== body.kind || !settingsEqual(p.after, body.settings) || (p.kind === 'update' && (p.catalog_id !== body.catalog_id || p.version !== body.version))) throw Error('Podgląd nie odpowiada dokładnej próbie.');
  } else {
    const op = d.operation, c = d.catalog;
    if (!op || !uuid(op.id) || !uuid(op.preview_id) || op.preview_id !== a.path.split('/')[3] || op.scope_hash !== body.scope_hash || !uuid(op.catalog_id) || op.client_key !== body.client_key || op.request?.client_key !== body.client_key || op.request?.scope_hash !== body.scope_hash || op.request?.confirmed !== true || !c || c.id !== op.catalog_id) throw Error('Niepełne potwierdzenie zapisu katalogu. Dokładna próba została zachowana.');
    checkCatalog(c); checkOperation(op);
  }
}
async function write(a: Attempt, retry: boolean, readOnly: boolean): Promise<Reply | null> {
  if (a.context !== context || inFlight || readOnly || (retry ? pending !== a : Boolean(pending))) return null;
  const e = epoch;
  if (!uuid(JSON.parse(a.body).client_key) || !a.path.startsWith(base + '/previews')) throw Error('Nieprawidłowa zachowana próba katalogu.');
  inFlight = true; publish(); let sent = false;
  try {
    await actor(a.context);
    const access = await api<Options>(base + '/options');
    if (context !== a.context || e !== epoch) return null;
    checkFlags(access, a.context);
    if (!access.available || !access.can_manage || access.read_only) throw new ApiError('Brak aktualnego prawa do zarządzania katalogami.', access.read_only ? 423 : 403);
    pending = a; sent = true; publish();
    const d = await api<Reply>(a.path, 'POST', JSON.parse(a.body));
    if (context !== a.context || e !== epoch) return null;
    validateReply(d, a);
    await actor(a.context);
    const current = await api<Options>(base + '/options');
    if (context !== a.context || e !== epoch) return null;
    checkFlags(current, a.context);
    if (!current.can_read) throw new ApiError('Dostęp do zapisanego katalogu został odebrany.', 403);
    outcome = { attempt: { ...a, body: '{}' }, reply: d }; pending = null; return d;
  } catch (error) {
    if (context === a.context && e === epoch && error instanceof ApiError) {
      if ([401, 403].includes(error.status)) purge(a.context);
      else if (sent && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) pending = null;
    }
    throw error;
  } finally { if (context === a.context && e === epoch) { inFlight = false; publish(); } }
}
const emptySettings = (): ProductCatalogSettings => ({ name: '', active: true, languages: [], default_language: '', warehouse_ids: [], price_list_ids: [] });
const toggleId = (values: string[], value: string) => values.includes(value) ? values.filter((id) => id !== value) : [...values, value].sort();
export type ProductCatalogsPanelProps = { contextKey: string; readOnly: boolean; externalWriteBlocked?: boolean; onLockedChange?: (locked: boolean) => void; onChanged?: () => void; onError?: (message: string) => void; refresh?: unknown };

function SettingsView({ settings, resources }: { settings: ProductCatalogSettings; resources: { warehouses: Warehouse[]; price_lists: PriceList[]; languages?: string[] } }) {
  return <dl className="pc-summary"><dt>Nazwa</dt><dd>{settings.name}</dd><dt>Stan</dt><dd>{settings.active ? 'Aktywny' : 'Nieaktywny'}</dd><dt>Języki</dt><dd>{settings.languages.join(', ')} · domyślny: {settings.default_language}</dd><dt>Magazyny</dt><dd>{settings.warehouse_ids.map((id) => resources.warehouses.find((w) => w.id === id)?.name ?? id).join(', ') || 'Brak przypisań'}</dd><dt>Cenniki</dt><dd>{settings.price_list_ids.map((id) => { const p = resources.price_lists.find((p) => p.id === id); return p ? `${p.name} (${p.currency})` : id; }).join(', ') || 'Brak przypisań'}</dd></dl>;
}

export function ProductCatalogsPanel(props: ProductCatalogsPanelProps) {
  const scope = props.contextKey;
  const [options, setOptions] = useState<Options | null>(null), [selected, setSelected] = useState(''), [settings, setSettings] = useState(emptySettings), [customLanguage, setCustomLanguage] = useState(''), [addedLanguages, setAddedLanguages] = useState<string[]>([]), [baseline, setBaseline] = useState<ProductCatalog | null>(null), [preview, setPreview] = useState<Preview | null>(null), [receipt, setReceipt] = useState<Reply | null>(null), [consent, setConsent] = useState(false), [error, setError] = useState(''), [reading, setReading] = useState(false), [signal, setSignal] = useState(0), [history, setHistory] = useState<any[]>([]), [historyKind, setHistoryKind] = useState<'preview' | 'operation'>('operation'), [cursor, setCursor] = useState<string | null>(null), [historyLoaded, setHistoryLoaded] = useState(false);
  const alive = useRef(false), generation = useRef(0), scopeRef = useRef(scope);
  const appliedOutcome = useRef<typeof outcome>(null);
  const optionsRequest = useRef(0), seenRefresh = useRef({scope,value:props.refresh});
  const [loadedScope, setLoadedScope] = useState('');
  const [loadedEpoch, setLoadedEpoch] = useState(-1);
  scopeRef.current = scope;
  const current = (g: number, e: number) => alive.current && scopeRef.current === scope && generation.current === g && context === scope && epoch === e;
  const locked = productCatalogsWriteLocked(scope), freshBlocked = props.readOnly || props.externalWriteBlocked || locked;
  const writable = Boolean(options?.available && options.can_manage && !options.read_only && !props.readOnly);
  function clearSensitive() { setLoadedScope(''); setOptions(null); setSelected(''); setSettings(emptySettings()); setCustomLanguage(''); setAddedLanguages([]); setBaseline(null); setPreview(null); setReceipt(null); setConsent(false); setHistory([]); setHistoryLoaded(false); setCursor(null); }
  function fail(e: unknown) { const message = e instanceof Error ? e.message : 'Nie udało się odczytać katalogów.'; setError(message); props.onError?.(message); if (e instanceof ApiError && [401, 403].includes(e.status)) { purge(scope); clearSensitive(); } else if (e instanceof ApiError && e.status === 503) { setOptions(null); setConsent(false); } }
  useEffect(() => {
    alive.current = true; generation.current++; resetProductCatalogsContext(scope); clearSensitive();
    const unsubscribe = subscribeProductCatalogsLock(scope, () => setSignal((s) => s + 1));
    void readOptions();
    return () => { alive.current = false; generation.current++; unsubscribe(); };
  }, [scope, props.readOnly]);
  useEffect(() => {
    const previous=seenRefresh.current;seenRefresh.current={scope,value:props.refresh};
    if(previous.scope===scope&&!Object.is(previous.value,props.refresh))void readOptions(true);
  }, [scope,props.refresh]);
  useEffect(() => { props.onLockedChange?.(locked); }, [locked, props.onLockedChange, signal]);
  useEffect(() => { if (loadedScope === scope && loadedEpoch !== epoch) clearSensitive(); }, [signal, scope, loadedEpoch]);
  useEffect(() => {
    if (context !== scope || !outcome || !options?.can_read || loadedScope !== scope || appliedOutcome.current === outcome) return;
    appliedOutcome.current = outcome;
    if (outcome.reply.preview) { setPreview(outcome.reply.preview); setReceipt(null); }
    else if (outcome.reply.operation) { setReceipt(outcome.reply); setPreview(null); }
    setConsent(false);
  }, [scope, signal, options, loadedScope]);
  async function readOptions(background = false) {
    const g = generation.current, e = epoch, request = ++optionsRequest.current;
    if(!background)setReading(true);
    try {
      await actor(scope); const d = await api<Options>(base + '/options');
      if (!current(g, e)||request!==optionsRequest.current) return;
      checkFlags(d, scope);
      if (!d.can_read && d.available) throw new ApiError('Brak prawa do odczytu katalogów.', 403);
      if (!d.available) { clearSensitive(); setOptions(d); setLoadedScope(scope); setLoadedEpoch(e); return; }
      if (!Array.isArray(d.catalogs) || d.catalogs.length > 100 || !Array.isArray(d.warehouses) || !Array.isArray(d.price_lists) || !Array.isArray(d.languages)) throw Error('Niepełna lista katalogów i przypisań.');
      d.catalogs.forEach(checkCatalog); setOptions(d); setLoadedScope(scope); setLoadedEpoch(e); setError('');
    } catch (error) { if (current(g, e)&&request===optionsRequest.current) fail(error); }
    finally { if (!background&&alive.current && generation.current === g && scopeRef.current === scope) setReading(false); }
  }
  function change(next: ProductCatalogSettings) { if (freshBlocked || !writable) return; setSettings(next); setPreview(null); setReceipt(null); setConsent(false); }
  async function choose(id: string) {
    if (locked || reading) return;
    setSelected(id); setPreview(null); setReceipt(null); setConsent(false); setBaseline(null); setSettings(emptySettings());
    if (!id || id === 'new') return;
    const g = generation.current, e = epoch;
    setReading(true);
    try { const d = await api<Flags & { catalog: ProductCatalog }>(base + '/' + id); if (!current(g, e)) return; checkFlags(d, scope); if (!d.can_read) throw new ApiError('Brak dostępu do katalogu.', 403); checkCatalog(d.catalog); if (d.catalog.id !== id) throw Error('Odczytano inny katalog.'); setBaseline(d.catalog); setSettings(structuredClone(d.catalog.settings)); }
    catch (error) { if (current(g, e)) fail(error); }
    finally { if (alive.current && generation.current === g && scopeRef.current === scope) setReading(false); }
  }
  async function mutate(a: Attempt, retry = false) {
    if (!retry && (freshBlocked || !writable)) return;
    const g = generation.current, e = epoch; setError('');
    try { const d = await write(a, retry, props.readOnly); if (!d || !current(g, e)) return; setConsent(false); if (d.preview) { setPreview(d.preview); setReceipt(null); } else {
      setReceipt(d); setPreview(null); setBaseline(null);props.onChanged?.();
      // The ACK remains a receipt; only a fresh own detail becomes the next CAS baseline.
      setReading(true);
      try {
        const fresh=await api<Flags & {catalog:ProductCatalog}>(base+'/'+d.catalog!.id);
        if(!current(g,e))return;checkFlags(fresh,scope);
        if(!fresh.can_read)throw new ApiError('Brak dostępu do zapisanego katalogu.',403);
        checkCatalog(fresh.catalog);
        if(fresh.catalog.id!==d.catalog!.id||BigInt(fresh.catalog.version)<BigInt(d.operation!.after.version))throw Error('Nieaktualny lub obcy odczyt zapisanego katalogu.');
        setSelected(fresh.catalog.id);setBaseline(fresh.catalog);setSettings(structuredClone(fresh.catalog.settings));setCustomLanguage('');setAddedLanguages([]);
      } finally {if(alive.current&&generation.current===g&&scopeRef.current===scope)setReading(false);}
    } await readOptions(); }
    catch (error) { if (current(g, e)) { fail(error); setConsent(false); if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) setPreview(null); } }
  }
  async function prepare() {
    if (!settingsValid(settings) || !selected || (selected !== 'new' && !baseline)) { setError('Wskaż katalog, nazwę (2–120 znaków), języki, język domyślny i co najmniej jeden magazyn.'); return; }
    await mutate({ context: scope, kind: 'preview', path: base + '/previews', body: JSON.stringify({ client_key: crypto.randomUUID(), kind: selected === 'new' ? 'create' : 'update', ...(baseline ? { catalog_id: baseline.id, version: baseline.version } : {}), settings: { ...settings, name: settings.name.trim(), languages: [...settings.languages].sort(), warehouse_ids: [...settings.warehouse_ids].sort(), price_list_ids: [...settings.price_list_ids].sort() } }) });
  }
  async function historyRead(more = false) {
    const g = generation.current, e = epoch; setReading(true);
    try { const d = await api<Flags & { data: any[]; next_cursor?: string | null; meta?: { cursor: string | null } }>(base + '/previews?kind=' + historyKind + '&limit=50' + (more && cursor ? '&cursor=' + cursor : '')); if (!current(g, e)) return; checkFlags(d, scope); if (!d.can_read) throw new ApiError('Brak dostępu do historii.', 403); if (!Array.isArray(d.data) || d.data.length > 50 || d.data.some((h) => !uuid(h.id))) throw Error('Niepełna historia katalogów.'); const next = d.next_cursor ?? d.meta?.cursor ?? null; if (more && next === cursor) throw Error('Powtórzona strona historii.'); setHistory((v) => more ? [...v, ...d.data] : d.data); setCursor(next); setHistoryLoaded(true); }
    catch (error) { if (current(g, e)) fail(error); }
    finally { if (alive.current && generation.current === g && scopeRef.current === scope) setReading(false); }
  }
  async function openHistory(id: string) {
    const g = generation.current, e = epoch; setReading(true);
    try { const d = await api<Reply>(base + (historyKind === 'preview' ? '/previews/' : '/operations/') + id); if (!current(g, e)) return; checkFlags(d, scope); if (!d.can_read) throw new ApiError('Brak dostępu do zapisu katalogu.', 403); if (historyKind === 'preview') { checkPreview(d.preview!); if (d.preview!.id !== id) throw Error('Odczytano inny podgląd.'); setPreview(d.preview!); setReceipt(null); } else { checkOperation(d.operation!); if (d.operation!.id !== id) throw Error('Odczytano inny wynik konfiguracji.'); setReceipt(d); setPreview(null); } setConsent(false); }
    catch (error) { if (current(g, e)) fail(error); }
    finally { if (alive.current && generation.current === g && scopeRef.current === scope) setReading(false); }
  }
  const attempt = context === scope ? pending : null;
  const languageChoices = [...new Set([...(options?.languages ?? []), ...addedLanguages, ...settings.languages])].sort();
  const canCommit = Boolean(writable && !freshBlocked && preview?.ready && preview.can_commit && !preview.operation_id && Date.parse(preview.expires_at) > Date.now());
  const visible = loadedScope === scope && context === scope && loadedEpoch === epoch;
  return <section className="panel product-catalogs" aria-label="Katalogi produktów">
    <header><h2>Katalogi produktów</h2><p>Oddzielne spisy produktów jednej firmy. Konfiguracja nie przenosi towaru i nie publikuje danych do kanałów.</p></header>
    <div className="pc-body">
      {error && <p role="alert" className="notice import-error">{error}</p>}
      <button type="button" className="button" disabled={reading || inFlight} onClick={() => void readOptions()}>Odczytaj katalogi i przypisania</button>
      {visible && options && !options.available && <p className="notice">Katalogi są niedostępne w tej kopii.</p>}
      {visible && options?.available && <>
        <p className="notice">SKU i historyczne kody są unikalne w całej firmie. Tryb WMS jest wspólny dla firmy. Przenoszenie produktów, zmiana katalogu domyślnego i ujemne stany nie są dostępne w tym formularzu.</p>
        {props.readOnly || options.read_only || !options.can_manage ? <p>Konfiguracja jest dostępna tylko do odczytu.</p> : null}
        {props.externalWriteBlocked && !locked && <p className="notice">Nowe zapisy wstrzymano do wyjaśnienia innej operacji produktów.</p>}
        <label>Katalog<select value={selected} disabled={locked || reading} onChange={(e) => void choose(e.target.value)}><option value="">Wybierz katalog</option>{options.catalogs.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' · domyślny' : ''}{!c.active ? ' · nieaktywny' : ''} · {c.product_count} produktów</option>)}{writable && <option value="new">Nowy katalog</option>}</select></label>
        {selected && <fieldset disabled={freshBlocked || !writable || reading}>
          <legend>{baseline ? `Konfiguracja · wersja ${baseline.version}` : 'Nowy katalog'}</legend>
          <label>Nazwa katalogu<input value={settings.name} maxLength={120} onChange={(e) => change({ ...settings, name: e.target.value })} /></label>
          <label className="pc-check"><input type="checkbox" checked={settings.active} onChange={(e) => change({ ...settings, active: e.target.checked })} />Katalog aktywny</label>
          <label>Dodatkowy kod języka<input value={customLanguage} maxLength={40} placeholder="np. pl-pl" onChange={(e) => setCustomLanguage(e.target.value)} /></label>
          <button type="button" className="button" onClick={() => { const locale = customLanguage.trim().toLowerCase(); if (locale.length > 40 || !/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/.test(locale) || languageChoices.length >= 64) { setError('Podaj poprawny kod języka. Katalog obsługuje do 64 języków.'); return; } setAddedLanguages((v) => [...new Set([...v, locale])].sort()); change({ ...settings, languages: [...new Set([...settings.languages, locale])].sort() }); setCustomLanguage(''); }}>Dodaj język do wyboru</button>
          {addedLanguages.filter((l) => !options.languages.includes(l)).map((l) => <label className="pc-check" key={l}><input type="checkbox" checked={settings.languages.includes(l)} onChange={() => { const languages = toggleId(settings.languages, l); change({ ...settings, languages, default_language: languages.includes(settings.default_language) ? settings.default_language : '' }); }} />{l}</label>)}
          <div className="pc-groups"><div><h3>Języki</h3>{options.languages.map((locale) => <label className="pc-check" key={locale}><input type="checkbox" checked={settings.languages.includes(locale)} onChange={() => { const languages = toggleId(settings.languages, locale); change({ ...settings, languages, default_language: languages.includes(settings.default_language) ? settings.default_language : '' }); }} />{locale}</label>)}<label>Język domyślny<select value={settings.default_language} onChange={(e) => change({ ...settings, default_language: e.target.value })}><option value="">Wybierz język</option>{settings.languages.map((l) => <option key={l} value={l}>{l}</option>)}</select></label></div><div><h3>Magazyny</h3>{options.warehouses.map((w) => <label className="pc-check" key={w.id}><input type="checkbox" checked={settings.warehouse_ids.includes(w.id)} onChange={() => change({ ...settings, warehouse_ids: toggleId(settings.warehouse_ids, w.id) })} />{w.name}{w.code ? ` · ${w.code}` : ''}</label>)}</div><div><h3>Cenniki</h3>{options.price_lists.map((p) => <label className="pc-check" key={p.id}><input type="checkbox" checked={settings.price_list_ids.includes(p.id)} onChange={() => change({ ...settings, price_list_ids: toggleId(settings.price_list_ids, p.id) })} />{p.name} · {p.currency}{!p.active ? ' · nieaktywny' : ''}</label>)}</div></div>
          <button type="button" className="button" onClick={() => void prepare()}>Przygotuj podgląd katalogu</button>
        </fieldset>}
      </>}
      {visible && preview && <article className="pc-review"><h3>Pełny zapisany podgląd konfiguracji</h3><p>{preview.kind === 'create' ? 'Nowy katalog' : 'Zmiana katalogu'} · ważny do {date(preview.expires_at)}</p>{preview.before && <><h4>Przed</h4><SettingsView settings={preview.before.settings} resources={preview.resources} /></>}<h4>Po</h4><SettingsView settings={preview.after} resources={preview.resources} />{preview.blockers.length > 0 && <div role="alert"><h4>Konflikty</h4><ul>{preview.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>}{preview.operation_id && <p>Ten podgląd jest już zapisany. Otwórz wynik w historii.</p>}{Date.parse(preview.expires_at) <= Date.now() && <p>Podgląd wygasł. Przygotuj świeży podgląd konfiguracji.</p>}<label className="pc-check"><input type="checkbox" disabled={!canCommit} checked={consent} onChange={(e) => setConsent(e.target.checked)} />Sprawdziłem pełną konfigurację i przypisania. Zatwierdzam jeden zapis katalogu.</label><button type="button" className="button primary" disabled={!canCommit || !consent} onClick={() => { if (!preview || !canCommit || !consent) return; void mutate({ context: scope, kind: 'commit', path: base + '/previews/' + preview.id + '/commit', body: JSON.stringify({ client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true }) }); }}>Zapisz zatwierdzony katalog</button></article>}
      {visible && receipt?.operation && <article className="pc-review"><h3>Konfiguracja zapisana</h3><p>Trwały wynik: {receipt.operation.id} · {date(receipt.operation.created_at)}</p><p>{receipt.operation.after.name} · zapisana wersja {receipt.operation.after.version} · {receipt.operation.after.product_count} produktów</p><SettingsView settings={receipt.operation.after.settings} resources={{ warehouses: [], price_lists: [] }} /><p className="muted">UUID przypisań pochodzą z trwałego wyniku. Bieżące nazwy zasobów znajdziesz w odczycie konfiguracji.</p></article>}
      {attempt && <div className="notice" role="status"><p>Wynik zapisu jest niepewny. Dokładne body i klucz zachowano w pamięci tego użytkownika. Historia nie usuwa próby.</p><button type="button" className="button" disabled={!writable || inFlight || reading} onClick={() => void mutate(attempt, true)}>Ponów dokładną próbę katalogu</button></div>}
      {visible && <details><summary>Historia konfiguracji katalogów</summary><label>Rodzaj historii<select value={historyKind} disabled={reading} onChange={(e) => { setHistoryKind(e.target.value as 'preview' | 'operation'); setHistory([]); setCursor(null); setHistoryLoaded(false); }}><option value="operation">Zapisane konfiguracje</option><option value="preview">Podglądy</option></select></label><button type="button" className="button" disabled={!options?.can_read || reading || inFlight} onClick={() => void historyRead()}>Odczytaj historię katalogów</button>{historyLoaded && history.length === 0 && <p>Brak zapisów dla wybranego rodzaju.</p>}<ul className="pc-history">{history.map((h) => <li key={h.id}><button type="button" className="button" disabled={reading || inFlight} onClick={() => void openHistory(h.id)}>{h.name ?? h.kind ?? 'Konfiguracja'} · {date(h.created_at)} · Otwórz pełny zapis</button></li>)}</ul>{cursor && <button type="button" className="button" disabled={reading || inFlight} onClick={() => void historyRead(true)}>Następna strona historii</button>}</details>}
    </div>
  </section>;
}
