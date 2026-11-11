import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import {
  performDropshipReturnWrite,
  purgeDropshipReturnAttempts,
  resetDropshipReturnContext,
  useDropshipReturnWriteState,
} from './b2b-dropshipping-returns';
import './return-assistant-queues.css';

const prefix = '/return-assistant';
const maxSelected = 200, pageSize = 50;
const caseFields = { number: 'Numer RMA', order_number: 'Numer zamówienia', created_at: 'Data zgłoszenia', kind: 'Rodzaj sprawy', customer: 'Klient', commercial_value: 'Wartość handlowa' };
const productFields = { sku: 'SKU', name: 'Nazwa', quantity: 'Ilość', line_total: 'Kwota całej pozycji', ean: 'EAN z oznaczonym źródłem', components: 'Składniki zestawu', locations: 'Lokalizacje', stock: 'Aktualny stan magazynowy' };
export type ReturnAssistantViewSettings = {
  auto_next: boolean;
  hide_accepted: boolean;
  name_source: 'historical' | 'current';
  product_sort: 'historical' | 'name' | 'sku';
  thumbnail_size: 'none' | 'small' | 'large';
  case_fields: (keyof typeof caseFields)[];
  product_fields: (keyof typeof productFields)[];
};
export type ReturnAssistantQueueGuard = { dirty: boolean; inFlight: boolean; unknown: boolean; hasActiveSession: boolean };
export type ReturnAssistantQueueCompletion = { returnId: string; sessionId: string; receiptId: string; action: 'receive' | 'reject'; protocol?: 'destinations_v1' };
export type ReturnAssistantQueueSelection = { returnId: string; returnNumber: string; queueId: string; viewSettings: ReturnAssistantViewSettings };
type Flags = { available: boolean; read_only: boolean; current_role: string | null; can_read: boolean; can_write: boolean; can_save_settings: boolean; can_manage_queue: boolean };
type Navigation = { auto_next: boolean; hide_accepted: boolean };
type Settings = { version: string; values: ReturnAssistantViewSettings };
type Queue = { id: string; version: string; count: number; position: number; skipped_return_ids: string[]; navigation: Navigation; created_at: string; updated_at: string };
type QueueItem = { index: number; return_id: string; number: string; order_id: string; order_number: string; kind: string; state: string; created_at: string; accepted: boolean; skipped: boolean; current_session: { id: string; state: string; owner_id: string; lease_expires_at: string } | null; receipt_id: string | null };
type SourceItem = { id: string; number: string; order_id: string; order_number: string; state: string; kind: string; created_at: string };
type SettingsReply = Flags & { settings: Settings; operation_id?: string; reused?: boolean };
type QueueReply = Flags & { queue: Queue; operation_id?: string; reused?: boolean };
type ItemsReply = QueueReply & { data: QueueItem[]; next_cursor: string | null };
type HistoryReply = Flags & { data: Queue[]; next_cursor: string | null };
type Props = {
  contextKey: string; readOnly: boolean; write: boolean;
  onOpenReturn: (selection: ReturnAssistantQueueSelection) => void;
  onViewSettingsChange?: (settings: ReturnAssistantViewSettings) => void;
  completion?: ReturnAssistantQueueCompletion | null;
  guard?: ReturnAssistantQueueGuard;
  onLockedChange?: (locked: boolean) => void;
  onError?: (message: string) => void;
};
const emptyGuard: ReturnAssistantQueueGuard = { dirty: false, inFlight: false, unknown: false, hasActiveSession: false };
let rememberedActor = '';
const lastQueue = new Map<string, string>();
const handledCompletions = new Set<string>();
export function resetReturnAssistantQueuesContext(contextKey: string, readOnly: boolean) {
  const actor = contextKey + ':' + readOnly;
  if (actor !== rememberedActor) { rememberedActor = actor; lastQueue.clear(); handledCompletions.clear(); }
  resetDropshipReturnContext(contextKey, readOnly);
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const version = (v: unknown, zero = false): v is string => typeof v === 'string' && (zero ? /^(0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/).test(v);
function sameValues(a: ReturnAssistantViewSettings, b: ReturnAssistantViewSettings) {
  return a.auto_next === b.auto_next && a.hide_accepted === b.hide_accepted && a.name_source === b.name_source && a.product_sort === b.product_sort && a.thumbnail_size === b.thumbnail_size && [...a.case_fields].sort().join('|') === [...b.case_fields].sort().join('|') && [...a.product_fields].sort().join('|') === [...b.product_fields].sort().join('|');
}
function checkSettings(s: Settings) {
  const v = s?.values;
  if (!s || !version(s.version, true) || !v || typeof v.auto_next !== 'boolean' || typeof v.hide_accepted !== 'boolean' || !['historical', 'current'].includes(v.name_source) || !['historical', 'name', 'sku'].includes(v.product_sort) || !['none', 'small', 'large'].includes(v.thumbnail_size)) throw Error('Niepełny odczyt ustawień asystenta.');
  for (const [fields, allowed] of [[v.case_fields, caseFields], [v.product_fields, productFields]] as const) if (!Array.isArray(fields) || new Set(fields).size !== fields.length || fields.some(f => !Object.hasOwn(allowed, f))) throw Error('Niepełny wybór widocznych danych asystenta.');
}
function checkQueue(q: Queue) {
  if (!q || !uuid(q.id) || !version(q.version) || !Number.isSafeInteger(q.count) || q.count < 1 || q.count > maxSelected || !Number.isSafeInteger(q.position) || q.position < 0 || q.position >= q.count || !Array.isArray(q.skipped_return_ids) || q.skipped_return_ids.length > q.count || new Set(q.skipped_return_ids).size !== q.skipped_return_ids.length || q.skipped_return_ids.some(id => !uuid(id)) || typeof q.navigation?.auto_next !== 'boolean' || typeof q.navigation.hide_accepted !== 'boolean') throw Error('Niepełna zapisana kolejka zwrotów.');
}
function checkMutationReply(reply: QueueReply | SettingsReply, path: string, method: 'POST' | 'PATCH', b: Record<string, any>, role: string, readOnly: boolean) {
  if (!reply || reply.current_role !== role || !reply.available || !reply.can_read || reply.read_only !== readOnly || !uuid(reply.operation_id) || typeof reply.reused !== 'boolean') throw Error('Niepełne pokwitowanie zapisu. Zachowano dokładną próbę.');
  const expectedVersion = method === 'POST' ? '1' : version(b.version, path === prefix + '/settings') ? (BigInt(b.version) + 1n).toString() : null;
  if (path === prefix + '/settings') {
    if (!('settings' in reply)) throw Error('Brak zapisanych ustawień. Zachowano dokładną próbę.');
    checkSettings(reply.settings);
    if (reply.settings.version !== expectedVersion || !sameValues(reply.settings.values, b.values)) throw Error('Pokwitowanie nie odpowiada wersji i treści zapisanych ustawień.');
  } else {
    if (!('queue' in reply)) throw Error('Brak zapisanej kolejki. Zachowano dokładną próbę.');
    checkQueue(reply.queue);
    if (reply.queue.version !== expectedVersion) throw Error('Pokwitowanie ma inną wersję kolejki. Zachowano dokładną próbę.');
    if (method === 'POST' && (reply.queue.count !== b.return_ids.length || reply.queue.position !== 0 || reply.queue.skipped_return_ids.length !== 0)) throw Error('Zapis nie obejmuje nowej kolejki wszystkich wybranych spraw.');
    if (method === 'PATCH' && (reply.queue.id !== path.split('/').at(-1) || reply.queue.position !== b.position || [...reply.queue.skipped_return_ids].sort().join('|') !== [...b.skipped_return_ids].sort().join('|'))) throw Error('Wynik nie odpowiada zmianie kolejki.');
    if (reply.queue.navigation.auto_next !== b.navigation.auto_next || reply.queue.navigation.hide_accepted !== b.navigation.hide_accepted) throw Error('Wynik nie odpowiada ustawieniom nawigacji.');
  }
}
const stateName: Record<string, string> = { requested: 'Do rozpatrzenia', refund_pending: 'Uznane — do rozliczenia', closed: 'Zamknięte', rejected: 'Odrzucone', cancelled: 'Anulowane' };

export function ReturnAssistantQueuesPanel(props: Props) {
  const { contextKey, readOnly, write } = props, actor = contextKey + ':' + readOnly, scope = actor + ':return-assistant-queues';
  const shared = useDropshipReturnWriteState(contextKey, readOnly), pending = shared.entries.find(e => e.scope === scope);
  const [flags, setFlags] = useState<Flags | null>(null), [settings, setSettings] = useState<Settings | null>(null), [settingsDraft, setSettingsDraft] = useState<Settings | null>(null), [settingsDirty, setSettingsDirty] = useState(false);
  const [source, setSource] = useState<SourceItem[]>([]), [sourceCursor, setSourceCursor] = useState<string | null>(null), [search, setSearch] = useState(''), [query, setQuery] = useState(''), [selected, setSelected] = useState<Map<string, SourceItem>>(new Map());
  const [draftPage, setDraftPage] = useState(0), [draftSeen, setDraftSeen] = useState<Set<number>>(new Set([0])), [manifestConsent, setManifestConsent] = useState(false);
  const [queue, setQueue] = useState<Queue | null>(null), [items, setItems] = useState<QueueItem[]>([]), [itemsPage, setItemsPage] = useState(0), [showAccepted, setShowAccepted] = useState(false), [navDraft, setNavDraft] = useState<Navigation | null>(null);
  const [history, setHistory] = useState<Queue[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(false), generation = useRef(0), gate = useRef(false), latest = useRef(actor), bound = useRef(actor), callbacks = useRef(props), draftsDirty = useRef(false), sourceCursors = useRef(new Set<string>()), historyCursors = useRef(new Set<string>()), completionReads = useRef(new Set<string>());
  latest.current = actor; callbacks.current = props; draftsDirty.current = settingsDirty;
  const current = (g: number) => alive.current && bound.current === latest.current && generation.current === g;
  const guard = props.guard ?? emptyGuard, leaveBlocked = guard.dirty || guard.inFlight || guard.unknown || shared.locked;
  const writable = !!flags?.available && flags.can_write && !flags.read_only && !readOnly && write && ['admin', 'operator'].includes(flags.current_role ?? '');
  const freshWrite = writable && !busy && !shared.locked;
  const selection = [...selected.values()], draftPages = Math.max(1, Math.ceil(selection.length / pageSize));
  function clearSensitive() { setFlags(null); setSettings(null); setSettingsDraft(null); setSettingsDirty(false); draftsDirty.current = false; setSource([]); setSourceCursor(null); setSelected(new Map()); setManifestConsent(false); setDraftSeen(new Set([0])); setDraftPage(0); setQueue(null); setItems([]); setHistory([]); setHistoryCursor(null); setNavDraft(null); }
  function accept(d: Flags) {
    if (!d || ['available', 'read_only', 'can_read', 'can_write', 'can_save_settings', 'can_manage_queue'].some(k => typeof d[k as keyof Flags] !== 'boolean')) throw Error('Niepełny odczyt dostępu do kolejek.');
    if (d.available && (!d.can_read || d.current_role !== contextKey.split(':')[2])) throw new ApiError('Uprawnienia do kolejki zmieniły się. Odczytaj ponownie firmę.', 403);
    if (d.read_only !== readOnly) throw new ApiError('Tryb kopii zmienił się. Odczytaj ponownie firmę.', 423);
    setFlags(d);
  }
  async function get<T extends Flags>(path: string, g: number): Promise<T> { const d = await api<T>(path); if (!current(g)) throw Error('Kontekst firmy zmienił się.'); accept(d); return d; }
  function errorResult(e: unknown) {
    const message = e instanceof Error ? e.message : 'Nie udało się odczytać kolejki.'; setError(message); callbacks.current.onError?.(message);
    if (e instanceof ApiError && [401, 403, 423].includes(e.status)) { clearSensitive(); lastQueue.clear(); handledCompletions.clear(); purgeDropshipReturnAttempts(contextKey, readOnly); }
    if (e instanceof ApiError && [400, 404, 409, 413, 422, 429].includes(e.status)) setManifestConsent(false);
  }
  async function run<T>(fn: (g: number) => Promise<T>, apply?: (d: T) => void) {
    if (gate.current || bound.current !== latest.current) return; const g = generation.current; gate.current = true; setBusy(true); setError('');
    try { const d = await fn(g); if (current(g)) apply?.(d); }
    catch (e) { if (current(g)) errorResult(e); }
    finally { if (alive.current && bound.current === latest.current && generation.current === g) { gate.current = false; setBusy(false); } }
  }
  async function readSettings(g: number) { const d = await get<SettingsReply>(prefix + '/settings', g); checkSettings(d.settings); return d; }
  function applySettings(d: SettingsReply, replace = false) {
    setSettings(d.settings); if (replace || !draftsDirty.current) { setSettingsDraft(structuredClone(d.settings)); setSettingsDirty(false); draftsDirty.current = false; }
    callbacks.current.onViewSettingsChange?.(structuredClone(d.settings.values));
  }
  async function fetchQueue(id: string, g: number) {
    if (!uuid(id)) throw Error('Nieprawidłowy identyfikator zapisanej kolejki.');
    const head = await get<QueueReply>(prefix + '/queues/' + id, g); checkQueue(head.queue); if (head.queue.id !== id) throw Error('Odczytano inną kolejkę.');
    const rows: QueueItem[] = [], cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const d: ItemsReply = await get<ItemsReply>(prefix + '/queues/' + id + '/items?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), g);
      checkQueue(d.queue); if (d.queue.id !== id || d.queue.version !== head.queue.version || d.queue.count !== head.queue.count || !Array.isArray(d.data) || d.data.length > pageSize || (d.next_cursor !== null && !uuid(d.next_cursor))) throw Error('Kolejka zmieniła się podczas odczytu. Odczytaj cały manifest ponownie.');
      for (const r of d.data) {
        if (!r || !uuid(r.return_id) || !uuid(r.order_id) || r.index !== rows.length || typeof r.number !== 'string' || typeof r.order_number !== 'string' || typeof r.accepted !== 'boolean' || typeof r.skipped !== 'boolean' || (r.receipt_id !== null && !uuid(r.receipt_id)) || (r.current_session !== null && (!uuid(r.current_session?.id) || !uuid(r.current_session.owner_id) || !Number.isFinite(Date.parse(r.current_session.lease_expires_at)))) || rows.some(x => x.return_id === r.return_id)) throw Error('Niepełny lub powtórzony manifest kolejki.');
        rows.push(r);
      }
      if (rows.length > maxSelected || (d.next_cursor && (!d.data.length || cursors.has(d.next_cursor)))) throw Error('Przekroczono limit lub powtórzono stronę kolejki.');
      cursor = d.next_cursor; if (cursor) cursors.add(cursor);
    } while (cursor);
    if (rows.length !== head.queue.count || head.queue.skipped_return_ids.some(id => !rows.some(r => r.return_id === id))) throw Error('Nie odczytano wszystkich wybranych spraw.');
    return { queue: head.queue, items: rows };
  }
  function applyQueue(d: { queue: Queue; items: QueueItem[] }) { setQueue(d.queue); setItems(d.items); setItemsPage(Math.floor(d.queue.position / pageSize)); setNavDraft({ ...d.queue.navigation }); lastQueue.set(actor, d.queue.id); }
  async function loadSource(g: number, text: string, cursor?: string | null) {
    const p = new URLSearchParams({ limit: '50', state: 'requested', search: text }); if (cursor) p.set('after', cursor);
    const d = await api<{ data: SourceItem[]; meta: { cursor: string | null } }>('/returns?' + p);
    if (!current(g)) throw Error('Kontekst firmy zmienił się.');
    if (!Array.isArray(d.data) || d.data.length > pageSize || d.data.some(r => !uuid(r.id) || !uuid(r.order_id) || typeof r.number !== 'string') || new Set(d.data.map(r => r.id)).size !== d.data.length || (d.meta?.cursor !== null && typeof d.meta?.cursor !== 'string') || (cursor && d.meta.cursor === cursor)) throw Error('Niepełna strona spraw zwrotowych.');
    if (cursor && d.meta.cursor && sourceCursors.current.has(d.meta.cursor)) throw Error('Powtórzony kursor spraw zwrotowych.');
    const access = await readSettings(g); if (!access.available || !access.can_read) throw Error('Kolejki nie są dostępne w tej kopii.');
    if (!cursor) sourceCursors.current.clear(); if (d.meta.cursor) sourceCursors.current.add(d.meta.cursor);
    return { rows: d.data, cursor: d.meta.cursor };
  }
  function mutate(action: string, path: string, method: 'POST' | 'PATCH', body: unknown, retry = false, after?: (d: QueueReply | SettingsReply, g: number) => Promise<void>) {
    if (readOnly || !write || gate.current || (!retry && shared.locked)) return;
    const attempt = retry ? pending?.attempt : { action, path, method, body: JSON.stringify(body) }; if (!attempt) return;
    void run(async g => {
      const access = await readSettings(g); applySettings(access);
      const isSettings = attempt.path === prefix + '/settings';
      if (!access.available || access.read_only || !access.can_write || !(isSettings ? access.can_save_settings : access.can_manage_queue) || !['admin', 'operator'].includes(access.current_role ?? '')) throw new ApiError('Brak bieżącego prawa zapisu kolejki lub ustawień.', 403);
      const b = JSON.parse(attempt.body);
      const d = await performDropshipReturnWrite<QueueReply | SettingsReply>(contextKey, readOnly, scope, attempt, reply => {
        // Runs before the shared registry releases an uncertain result, including after unmount.
        checkMutationReply(reply, attempt.path, attempt.method as 'POST' | 'PATCH', b, contextKey.split(':')[2], readOnly);
        if ('queue' in reply && rememberedActor === actor) lastQueue.set(actor, reply.queue.id);
      });
      if (!current(g)) return;
      accept(d); if ('settings' in d) applySettings(d, true); else {
        const full = await fetchQueue(d.queue.id, g); if (!current(g)) return; applyQueue(full);
        if (retry && attempt.action === 'Automatyczne otwarcie następnej sprawy po pokwitowaniu') openRow(full.queue, full.items[full.queue.position]);
      }
      setNotice('Zapisano ' + (isSettings ? 'ustawienia prezentacji.' : 'metadane kolejki. Nie rozpoczęto kontroli ani przyjęcia.'));
      await after?.(d, g);
    });
  }
  useEffect(() => {
    alive.current = true; ++generation.current; bound.current = actor; gate.current = false; resetReturnAssistantQueuesContext(contextKey, readOnly); clearSensitive(); sourceCursors.current.clear(); historyCursors.current.clear(); completionReads.current.clear(); setBusy(false); setError(''); setNotice(''); setSearch(''); setQuery('');
    void run(readSettings, d => applySettings(d, true));
    return () => { alive.current = false; ++generation.current; gate.current = false; };
  }, [actor]);
  useEffect(() => { callbacks.current.onLockedChange?.(shared.locked); }, [shared.locked, actor]);
  function changeSettings(patch: Partial<ReturnAssistantViewSettings>) { if (!settingsDraft || !freshWrite) return; setSettingsDraft({ version: settingsDraft.version, values: { ...settingsDraft.values, ...patch } }); setSettingsDirty(true); draftsDirty.current = true; }
  function choose(row: SourceItem, checked: boolean) {
    if (!freshWrite) return; const next = new Map(selected);
    if (checked) { if (next.size >= maxSelected) { setError('Możesz wybrać najwyżej 200 spraw.'); return; } next.set(row.id, row); } else next.delete(row.id);
    setSelected(next); setDraftPage(0); setDraftSeen(new Set([0])); setManifestConsent(false);
  }
  function selectPage() {
    if (!freshWrite) return; const next = new Map(selected); for (const row of source) next.set(row.id, row);
    if (next.size > maxSelected) { setError('Cała strona przekroczyłaby limit 200 spraw. Wybierz pojedyncze sprawy.'); return; }
    setSelected(next); setDraftPage(0); setDraftSeen(new Set([0])); setManifestConsent(false);
  }
  function openRow(q: Queue, row: QueueItem) {
    if (!settings || callbacks.current.guard?.dirty || callbacks.current.guard?.inFlight || callbacks.current.guard?.unknown) return;
    callbacks.current.onOpenReturn({ returnId: row.return_id, returnNumber: row.number, queueId: q.id, viewSettings: { ...settings.values, ...q.navigation } });
  }
  function move(index: number, skip = false) {
    if (!queue || !items[index] || leaveBlocked || !freshWrite || !flags?.can_manage_queue) return;
    const skipped = new Set(queue.skipped_return_ids); if (skip) skipped.add(items[queue.position].return_id); else skipped.delete(items[index].return_id);
    mutate('Zmiana pozycji kolejki', prefix + '/queues/' + queue.id, 'PATCH', { client_key: crypto.randomUUID(), version: queue.version, position: index, skipped_return_ids: [...skipped], navigation: queue.navigation }, false, async (d, g) => { if ('queue' in d) { const full = await fetchQueue(d.queue.id, g); if (current(g)) { applyQueue(full); openRow(full.queue, full.items[index]); } } });
  }
  const completionKey = props.completion ? actor + ':' + (props.completion.protocol ?? 'legacy') + ':' + props.completion.receiptId : '';
  useEffect(() => {
    const c = props.completion;
    if (!c || !queue || !settings || busy || leaveBlocked || handledCompletions.has(completionKey) || completionReads.current.has(completionKey) || ![c.returnId, c.sessionId, c.receiptId].every(uuid) || !['receive', 'reject'].includes(c.action) || (c.protocol !== undefined && c.protocol !== 'destinations_v1') || items[queue.position]?.return_id !== c.returnId) return;
    // Failed verification stays visible and cannot spin an automatic read loop.
    // Only a validated durable receipt is marked globally as handled.
    completionReads.current.add(completionKey);
    // The callback supplies a validated receipt. Verify durable identity again before navigation.
    void run(async g => {
      type ReceiptIdentity = { id: string; return_id: string; session_id: string; action: string; kind?: string; protocol?: string; snapshot?: { protocol?: string; session?: { id: string; return_id: string } } };
      const destinations = c.protocol === 'destinations_v1';
      const d = await api<{ receipt?: ReceiptIdentity; operation?: ReceiptIdentity; available: boolean; can_read: boolean; current_role: string; read_only: boolean }>((destinations ? '/return-destinations/operations/' : prefix + '/receipts/') + c.receiptId);
      if (!current(g)) return;
      if (!d.available || !d.can_read || d.current_role !== contextKey.split(':')[2] || d.read_only !== readOnly) throw new ApiError('Uprawnienia do pokwitowania zmieniły się.', 403);
      const receipt = destinations ? d.operation : d.receipt;
      if (!receipt || receipt.id !== c.receiptId || receipt.return_id !== c.returnId || receipt.session_id !== c.sessionId || receipt.action !== c.action || (destinations && (receipt.kind !== 'operation' || receipt.protocol !== 'destinations_v1' || receipt.snapshot?.protocol !== 'destinations_v1' || receipt.snapshot.session?.id !== c.sessionId || receipt.snapshot.session.return_id !== c.returnId))) throw Error('Pokwitowanie nie odpowiada zakończonej sprawie.');
      handledCompletions.add(completionKey);
      const full = await fetchQueue(queue.id, g); if (!current(g)) return; applyQueue(full);
      const next = full.items.find(r => r.index > full.queue.position && !r.accepted && !r.skipped && !['rejected', 'cancelled', 'closed'].includes(r.state));
      if (!full.queue.navigation.auto_next || !next || readOnly || !write) { setNotice(next ? 'Decyzja zapisana. Następną sprawę możesz otworzyć ręcznie.' : 'Brak następnej sprawy do kontroli. Historia kolejki pozostaje dostępna.'); return; }
      const fresh = await readSettings(g); applySettings(fresh);
      if (!fresh.available || !fresh.can_write || !fresh.can_manage_queue || fresh.read_only || callbacks.current.guard?.dirty || callbacks.current.guard?.inFlight || callbacks.current.guard?.unknown) return;
      const attempt = { action: 'Automatyczne otwarcie następnej sprawy po pokwitowaniu', path: prefix + '/queues/' + full.queue.id, method: 'PATCH' as const, body: JSON.stringify({ client_key: crypto.randomUUID(), version: full.queue.version, position: next.index, skipped_return_ids: full.queue.skipped_return_ids, navigation: full.queue.navigation }) };
      const reply = await performDropshipReturnWrite<QueueReply>(contextKey, readOnly, scope, attempt, d => { checkMutationReply(d, attempt.path, attempt.method, JSON.parse(attempt.body), contextKey.split(':')[2], readOnly); if (rememberedActor === actor) lastQueue.set(actor, d.queue.id); });
      if (!current(g)) return; accept(reply); const updated = await fetchQueue(reply.queue.id, g); if (current(g)) { applyQueue(updated); openRow(updated.queue, updated.items[next.index]); setNotice('Otworzono przegląd następnej sprawy. Rozpoczęcie kontroli wymaga osobnego kliknięcia.'); }
    });
  }, [completionKey, queue?.id, queue?.position, busy, leaveBlocked]);
  function loadHistory(more = false) { void run(async g => {
    const d = await get<HistoryReply>(prefix + '/queues?limit=50' + (more && historyCursor ? '&cursor=' + encodeURIComponent(historyCursor) : ''), g);
    if (!Array.isArray(d.data) || d.data.length > pageSize || (d.next_cursor !== null && !uuid(d.next_cursor)) || (more && d.next_cursor && historyCursors.current.has(d.next_cursor))) throw Error('Niepełna strona historii kolejek.');
    d.data.forEach(checkQueue); const all = more ? [...history, ...d.data] : d.data; if (all.length > 2000 || new Set(all.map(q => q.id)).size !== all.length) throw Error('Powtórzona lub zbyt duża historia kolejek.'); if (!more) historyCursors.current.clear(); if (d.next_cursor) historyCursors.current.add(d.next_cursor); return { rows: all, cursor: d.next_cursor };
  }, d => { setHistory(d.rows); setHistoryCursor(d.cursor); }); }
  const activeItem = queue ? items[queue.position] : null;
  const visibleItems = items.filter(r => showAccepted || !queue?.navigation.hide_accepted || !r.accepted), itemPages = Math.max(1, Math.ceil(visibleItems.length / pageSize));
  if (bound.current !== actor) return <section className="panel return-assistant-queues"><div className="info-body"><p>Zmiana kontekstu firmy — poprzednia kolejka została ukryta.</p></div></section>;
  return <section className="panel return-assistant-queues" aria-label="Kolejki i ustawienia asystenta zwrotów">
    <div className="panel-heading"><div><h2>Kolejki i ustawienia asystenta</h2><p>Wybrane sprawy i wygodny widok. Każda kontrola i decyzja wymagają osobnego działania.</p></div></div>
    <div className="info-body">
      {error && <p className="error-block" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
      <div className="raq-actions"><button type="button" className="button" disabled={busy} onClick={() => void run(readSettings, d => applySettings(d))}>Odczytaj ustawienia i dostęp</button>{lastQueue.get(actor) && !queue && <button type="button" className="button" disabled={busy} onClick={() => void run(g => fetchQueue(lastQueue.get(actor)!, g), applyQueue)}>Wznów zapamiętaną kolejkę</button>}</div>
      {pending && <div className="notice"><p>Wynik zapisu „{pending.attempt.action}” jest nieznany. Nowe zapisy zwrotów są wstrzymane. Odczyt nie usuwa zachowanej próby.</p><button type="button" className="button" disabled={!writable || busy || pending.inFlight} onClick={() => mutate('', '', 'POST', null, true)}>Ponów dokładny zapis kolejki lub ustawień</button></div>}
      {shared.locked && !pending && <p className="notice">Inny zapis zwrotu wymaga potwierdzenia. Wróć do jego dokładnej próby; nowe zapisy i przejścia są wstrzymane.</p>}
      {flags && !flags.available && <p className="notice">Kolejki i ustawienia nie są dostępne w tej kopii. Pojedynczy asystent pozostaje osobnym procesem.</p>}
      {flags?.available && (!writable || readOnly) && <p className="notice">Tryb odczytu: możesz przeglądać zapisane kolejki i ustawienia, bez nowych zapisów.</p>}
      {settingsDraft && flags?.available && <details><summary>Ustawienia prezentacji asystenta</summary><fieldset disabled={!freshWrite || !flags.can_save_settings}>
        <div className="raq-grid"><label>Źródło nazwy produktu<select value={settingsDraft.values.name_source} onChange={e => changeSettings({ name_source: e.target.value as ReturnAssistantViewSettings['name_source'] })}><option value="historical">Historyczna nazwa ze sprzedaży</option><option value="current">Aktualna nazwa własnego katalogu obok historycznej</option></select></label><label>Kolejność pozycji<select value={settingsDraft.values.product_sort} onChange={e => changeSettings({ product_sort: e.target.value as ReturnAssistantViewSettings['product_sort'] })}><option value="historical">Historyczna kolejność pozycji</option><option value="name">Nazwa produktu</option><option value="sku">SKU produktu</option></select></label><label>Miniaturki produktów<select value={settingsDraft.values.thumbnail_size} onChange={e => changeSettings({ thumbnail_size: e.target.value as ReturnAssistantViewSettings['thumbnail_size'] })}><option value="none">Bez miniaturek</option><option value="small">Małe miniaturki</option><option value="large">Duże miniaturki</option></select></label></div>
        <div className="raq-grid"><div><h3>Dane sprawy</h3>{Object.entries(caseFields).map(([key, label]) => <label className="raq-check" key={key}><input type="checkbox" checked={settingsDraft.values.case_fields.includes(key as keyof typeof caseFields)} onChange={e => changeSettings({ case_fields: e.target.checked ? [...settingsDraft.values.case_fields, key as keyof typeof caseFields] : settingsDraft.values.case_fields.filter(k => k !== key) })}/>{label}</label>)}</div><div><h3>Dane produktów</h3>{Object.entries(productFields).map(([key, label]) => <label className="raq-check" key={key}><input type="checkbox" checked={settingsDraft.values.product_fields.includes(key as keyof typeof productFields)} onChange={e => changeSettings({ product_fields: e.target.checked ? [...settingsDraft.values.product_fields, key as keyof typeof productFields] : settingsDraft.values.product_fields.filter(k => k !== key) })}/>{label}</label>)}</div></div>
        <label className="raq-check"><input type="checkbox" checked={settingsDraft.values.auto_next} onChange={e => changeSettings({ auto_next: e.target.checked })}/>Otwieraj następną sprawę po zapisaniu decyzji — bez rozpoczynania jej kontroli</label>
        <label className="raq-check"><input type="checkbox" checked={settingsDraft.values.hide_accepted} onChange={e => changeSettings({ hide_accepted: e.target.checked })}/>Ukrywaj przyjęte w roboczym widoku kolejki; zachowaj historię i rozliczenie</label>
        <p>Ustawienia nie zmieniają decyzji, pochodzenia, skanów ani magazynu. Numery pozycji i różne historyczne kwoty pozostają dostępne. Stan katalogu jest tylko pomocniczym odczytem.</p>
        {settings?.version !== settingsDraft.version && <p className="notice">Ustawienia zmieniły się na serwerze. Zachowano szkic; odczytaj konfigurację do edycji przed nowym zapisem.</p>}
        <button type="button" className="button" disabled={!settingsDirty || settings?.version !== settingsDraft.version} onClick={() => mutate('Zapis ustawień prezentacji', prefix + '/settings', 'PATCH', { client_key: crypto.randomUUID(), version: settingsDraft.version, values: settingsDraft.values })}>Zapisz ustawienia prezentacji</button>
      </fieldset><button type="button" className="button" disabled={busy || shared.locked} onClick={() => void run(readSettings, d => applySettings(d, true))}>Odczytaj konfigurację do edycji — zastąp szkic</button></details>}
      {flags?.available && <details><summary>Wybierz sprawy do nowej kolejki ({selected.size} / 200)</summary>
        <form className="raq-actions" onSubmit={e => { e.preventDefault(); setQuery(search); void run(g => loadSource(g, search), d => { setSource(d.rows); setSourceCursor(d.cursor); }); }}><label>Numer RMA, zamówienia lub klient<input value={search} maxLength={100} disabled={busy} onChange={e => setSearch(e.target.value)}/></label><button className="button" disabled={busy}>Odczytaj sprawy do wyboru</button></form>
        <p>Zaznaczenie dotyczy konkretnych spraw, także z wcześniej odczytanych stron. Nowa strona nie jest zaznaczana automatycznie.</p>
        <button type="button" className="button" disabled={!freshWrite || !source.length} onClick={selectPage}>Zaznacz tylko tę stronę spraw</button>
        <div className="table-scroll"><table><thead><tr><th>Wybór</th><th>Sprawa</th><th>Zamówienie</th><th>Status</th></tr></thead><tbody>{source.map(r => <tr key={r.id}><td><input type="checkbox" aria-label={'Wybierz ' + r.number} checked={selected.has(r.id)} disabled={!freshWrite || (!selected.has(r.id) && selected.size >= maxSelected)} onChange={e => choose(r, e.target.checked)}/></td><td>{r.number}</td><td>{r.order_number}</td><td>{stateName[r.state] ?? r.state}</td></tr>)}</tbody></table></div>
        {sourceCursor && <button type="button" className="button" disabled={busy} onClick={() => void run(g => loadSource(g, query, sourceCursor), d => { if (source.some(r => d.rows.some(n => n.id === r.id))) throw Error('Powtórzona strona spraw.'); setSource(d.rows); setSourceCursor(d.cursor); })}>Następna strona spraw do wyboru</button>}
        {!!selected.size && <div className="raq-card"><h3>Pełny manifest nowej kolejki: {selected.size} spraw</h3><p>Kolejność zaznaczenia jest kolejnością przeglądu. Sprawdzone strony: {draftSeen.size} / {draftPages}.</p><ol start={draftPage * pageSize + 1}>{selection.slice(draftPage * pageSize, (draftPage + 1) * pageSize).map(r => <li key={r.id}>{r.number} · {r.order_number} <button type="button" className="button" disabled={!freshWrite} onClick={() => choose(r, false)}>Usuń z wyboru {r.number}</button></li>)}</ol>
          <div className="raq-actions"><button type="button" className="button" disabled={draftPage === 0} onClick={() => { setDraftPage(draftPage - 1); setDraftSeen(new Set([...draftSeen, draftPage - 1])); }}>Poprzednia strona manifestu</button><span>Strona {draftPage + 1} / {draftPages}</span><button type="button" className="button" disabled={draftPage + 1 >= draftPages} onClick={() => { setDraftPage(draftPage + 1); setDraftSeen(new Set([...draftSeen, draftPage + 1])); }}>Następna strona manifestu</button></div>
          <label className="raq-check"><input type="checkbox" checked={manifestConsent} disabled={!freshWrite || draftSeen.size !== draftPages} onChange={e => setManifestConsent(e.target.checked)}/>Sprawdziłem wszystkie wybrane sprawy i kolejność. Zapisuję kolejkę do przeglądu, bez rozpoczynania kontroli.</label>
          <button type="button" className="button primary" disabled={!freshWrite || !flags.can_manage_queue || !manifestConsent || draftSeen.size !== draftPages || !settings} onClick={() => mutate('Zapis wybranej kolejki', prefix + '/queues', 'POST', { client_key: crypto.randomUUID(), return_ids: selection.map(r => r.id), navigation: { auto_next: settings!.values.auto_next, hide_accepted: settings!.values.hide_accepted } })}>Zapisz kolejkę wybranych spraw</button>
        </div>}
      </details>}
      {queue && items.length === queue.count && <div className="raq-card"><h3>Zapisana kolejka · sprawa {queue.position + 1} z {queue.count}</h3><p>Aktualna pozycja: {activeItem?.number} · rewizja {queue.version}. Przyjęcie nie oznacza wypłaty ani zamknięcia rozliczenia.</p>
        {guard.dirty && <p className="notice">Masz niezapisane oceny, zdjęcie lub wybór partii. Zapisz szkic albo jawnie odrzuć zmiany w bieżącym asystencie przed przejściem.</p>}
        {guard.hasActiveSession && !guard.dirty && <p className="notice">Bieżąca sesja pozostanie aktywna po przejściu; nie odnawiamy ani nie anulujemy jej automatycznie.</p>}
        <div className="raq-actions"><button type="button" className="button" disabled={busy} onClick={() => void run(g => fetchQueue(queue.id, g), applyQueue)}>Odczytaj pełną zapisaną kolejkę</button><button type="button" className="button" disabled={busy || leaveBlocked || !activeItem} onClick={() => activeItem && openRow(queue, activeItem)}>Otwórz bieżącą sprawę do przeglądu</button><button type="button" className="button" disabled={!freshWrite || leaveBlocked || queue.position === 0} onClick={() => move(queue.position - 1)}>Poprzednia sprawa</button><button type="button" className="button" disabled={!freshWrite || leaveBlocked || queue.position + 1 >= queue.count} onClick={() => move(queue.position + 1)}>Następna sprawa</button><button type="button" className="button" disabled={!freshWrite || leaveBlocked || queue.position + 1 >= queue.count} onClick={() => move(queue.position + 1, true)}>Pomiń bieżącą na teraz</button></div>
        {navDraft && <fieldset disabled={!freshWrite || !flags?.can_manage_queue}><label className="raq-check"><input type="checkbox" checked={navDraft.auto_next} onChange={e => setNavDraft({ ...navDraft, auto_next: e.target.checked })}/>Otwieraj następną sprawę po zapisaniu decyzji w tej kolejce</label><label className="raq-check"><input type="checkbox" checked={navDraft.hide_accepted} onChange={e => setNavDraft({ ...navDraft, hide_accepted: e.target.checked })}/>Ukrywaj przyjęte w tej kolejce</label><button type="button" className="button" disabled={navDraft.auto_next === queue.navigation.auto_next && navDraft.hide_accepted === queue.navigation.hide_accepted} onClick={() => mutate('Zapis nawigacji kolejki', prefix + '/queues/' + queue.id, 'PATCH', { client_key: crypto.randomUUID(), version: queue.version, position: queue.position, skipped_return_ids: queue.skipped_return_ids, navigation: navDraft })}>Zapisz ustawienia tej kolejki</button></fieldset>}
        <label className="raq-check"><input type="checkbox" checked={showAccepted} onChange={e => { setShowAccepted(e.target.checked); setItemsPage(0); }}/>Pokaż także przyjęte sprawy w pełnym manifeście</label>
        <p>Widoczne: {visibleItems.length} / {queue.count}. Pominięte i zakończone pozostają zapisane.</p>
        <div className="table-scroll"><table><thead><tr><th>Pozycja / RMA</th><th>Zamówienie</th><th>Aktualny stan</th><th>Sesja kontroli</th><th>Przegląd</th></tr></thead><tbody>{visibleItems.slice(Math.min(itemsPage, itemPages - 1) * pageSize, (Math.min(itemsPage, itemPages - 1) + 1) * pageSize).map(r => <tr key={r.return_id}><td>{r.index + 1}. {r.number}{r.skipped && <small>Pominięta na teraz</small>}</td><td>{r.order_number}</td><td>{r.accepted ? 'Przyjęta · ' : ''}{stateName[r.state] ?? r.state}</td><td>{r.current_session ? <><span>{r.current_session.state === 'active' && r.current_session.owner_id !== contextKey.split(':')[1] && Date.parse(r.current_session.lease_expires_at) > Date.now() ? 'Obsługiwana przez innego operatora' : 'Istnieje zapisana kontrola'}</span><small>Ważność dostępu: {date(r.current_session.lease_expires_at)}</small></> : 'Brak sesji'}</td><td><button type="button" className="button" disabled={busy || leaveBlocked || (writable && r.index !== queue.position && !freshWrite)} onClick={() => r.index === queue.position || !writable ? openRow(queue, r) : move(r.index)}>Przegląd {r.number}</button>{r.receipt_id && <small>Trwałe pokwitowanie dostępne w historii sprawy</small>}</td></tr>)}</tbody></table></div>
        <div className="raq-actions"><button type="button" className="button" disabled={itemsPage === 0} onClick={() => setItemsPage(Math.max(0, itemsPage - 1))}>Poprzednia strona zapisanej kolejki</button><span>Strona {Math.min(itemsPage + 1, itemPages)} / {itemPages}</span><button type="button" className="button" disabled={itemsPage + 1 >= itemPages} onClick={() => setItemsPage(itemsPage + 1)}>Następna strona zapisanej kolejki</button></div>
      </div>}
      {flags?.available && <details><summary>Historia moich zapisanych kolejek</summary><button type="button" className="button" disabled={busy} onClick={() => loadHistory()}>Odczytaj historię kolejek</button>{history.map(q => <div className="raq-actions" key={q.id}><span>{date(q.created_at)} · {q.count} spraw · pozycja {q.position + 1}</span><button type="button" className="button" disabled={busy || leaveBlocked} onClick={() => void run(g => fetchQueue(q.id, g), applyQueue)}>Wznów kolejkę z {date(q.created_at)}</button></div>)}{historyCursor && <button type="button" className="button" disabled={busy} onClick={() => loadHistory(true)}>Starsze zapisane kolejki</button>}</details>}
    </div>
  </section>;
}
