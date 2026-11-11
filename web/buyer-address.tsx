import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import type { BuyerDeliveryAddress166 } from '../server/buyer-delivery-address';

type Kind = 'address' | 'pickup_point' | 'unknown';
type Policy = { enabled: boolean; delivery_kind: Kind; classification_origin: 'unknown' | 'operator_confirmed' | 'adapter' };
type Access = Policy & { available: boolean; read_only: boolean; can_manage: boolean; order_version: string; policy_version: string;
  delivery_version: string; effective_delivery: BuyerDeliveryAddress166 | null; reason: string | null; last_change: { created_at: string } | null };
type Entry = { id: string; kind: 'access' | 'delivery' | 'merge_inherit'; changed: boolean; created_at: string;
  before: BuyerDeliveryAddress166 | null; after: BuyerDeliveryAddress166 | null; before_policy: Policy; after_policy: Policy };
type Page = { data: Entry[]; next_cursor: string | null };
type Attempt = { enabled: boolean; delivery_kind?: 'address' | 'pickup_point'; version: string; policy_version: string };
type Transport = (path: string, method?: string, body?: unknown) => Promise<unknown>;
// Only the non-PII CAS intent survives same-tab remount. It can be settled by GET;
// it is never replayed as a PATCH under another actor or newer version.
const uncertainPolicies = new Map<string, Attempt>();
const addressKeys = ['recipient_name', 'street', 'city', 'postal_code', 'country', 'phone'] as const;
const addressLabels = { recipient_name: 'Odbiorca', street: 'Ulica i numer', city: 'Miejscowość', postal_code: 'Kod pocztowy', country: 'Kraj', phone: 'Telefon' };
const kindNames = { address: 'Adresowa', pickup_point: 'Punkt odbioru', unknown: 'Niepotwierdzona' };
const originNames = { unknown: 'Brak potwierdzenia', operator_confirmed: 'Potwierdzona przez operatora', adapter: 'Potwierdzona przez adapter' };
const reasonNames: Record<string, string> = {
  module_unavailable: 'Moduł nie jest dostępny w tej kopii.', access_disabled: 'Korekta w portalu jest wyłączona.',
  read_only: 'Kopia jest tylko do odczytu.', fulfillment_started: 'Rozpoczęto realizację zamówienia.',
  shipment_locked: 'Istniejąca przesyłka wymaga obsługi przed zmianą adresu.', dependent_plan_locked: 'Inny przyjęty plan blokuje zmianę adresu.',
  pickup_point_delivery: 'Dostawa do punktu — korekta zwykłego adresu jest niedostępna.', delivery_kind_unknown: 'Potwierdź rzeczywisty rodzaj dostawy.',
};
function requireValue(v: unknown): asserts v { if (!v) throw Error('Niepoprawna odpowiedź serwera.'); }
function object(v: unknown, keys: string[]): Record<string, unknown> {
  requireValue(v && typeof v === 'object' && !Array.isArray(v)); const p = v as Record<string, unknown>;
  requireValue(Object.keys(p).length === keys.length && Object.keys(p).every(k => keys.includes(k))); return p;
}
const version = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
class ContextChanged extends Error {}
function address(v: unknown): BuyerDeliveryAddress166 | null {
  if (v === null) return null; const p = object(v, [...addressKeys]);
  for (const k of addressKeys) requireValue(typeof p[k] === 'string' && (p[k] as string).length <= 400 && !/[\p{Cc}]/u.test(p[k] as string));
  return p as BuyerDeliveryAddress166;
}
function policy(v: unknown): Policy {
  const p = object(v, ['enabled', 'delivery_kind', 'classification_origin']);
  requireValue(typeof p.enabled === 'boolean' && ['address', 'pickup_point', 'unknown'].includes(p.delivery_kind as string) &&
    ['unknown', 'operator_confirmed', 'adapter'].includes(p.classification_origin as string));
  requireValue((p.delivery_kind === 'unknown') === (p.classification_origin === 'unknown')); return p as Policy;
}
function descriptor(v: unknown, mutation = false): Access {
  const fields = ['available', 'read_only', 'can_manage', 'order_version', 'policy_version', 'enabled', 'delivery_kind', 'classification_origin', 'delivery_version', 'effective_delivery', 'reason', 'last_change'];
  const p = object(v, mutation ? [...fields, 'changed', 'receipt_id'] : fields);
  for (const k of ['available', 'read_only', 'can_manage']) requireValue(typeof p[k] === 'boolean');
  for (const k of ['order_version', 'policy_version', 'delivery_version']) requireValue(version(p[k]));
  policy({ enabled: p.enabled, delivery_kind: p.delivery_kind, classification_origin: p.classification_origin });
  requireValue(p.reason === null || typeof p.reason === 'string' && Object.hasOwn(reasonNames, p.reason));
  if (p.last_change !== null) { const c = object(p.last_change, ['created_at']); requireValue(typeof c.created_at === 'string' && Number.isFinite(Date.parse(c.created_at))); }
  requireValue(!p.can_manage || p.available && !p.read_only);
  if (mutation) requireValue(typeof p.changed === 'boolean' && typeof p.receipt_id === 'string' && /^[0-9a-f-]{36}$/i.test(p.receipt_id));
  return { ...p, effective_delivery: address(p.effective_delivery) } as Access;
}
function page(v: unknown): Page {
  const p = object(v, ['data', 'next_cursor']); requireValue(Array.isArray(p.data) && p.data.length <= 20 && (p.next_cursor === null || typeof p.next_cursor === 'string' && p.next_cursor.length <= 4096));
  const ids = new Set<string>();
  const data = p.data.map((v: unknown) => { const r = object(v, ['id', 'kind', 'changed', 'created_at', 'before', 'after', 'before_policy', 'after_policy']);
    requireValue(typeof r.id === 'string' && /^[0-9a-f-]{36}$/i.test(r.id) && !ids.has(r.id)); ids.add(r.id);
    requireValue(['access', 'delivery', 'merge_inherit'].includes(r.kind as string) && typeof r.changed === 'boolean' && typeof r.created_at === 'string' && Number.isFinite(Date.parse(r.created_at)));
    const before = address(r.before), after = address(r.after), beforePolicy = policy(r.before_policy), afterPolicy = policy(r.after_policy);
    if (r.kind === 'merge_inherit') requireValue(r.changed === true && before === null && !beforePolicy.enabled && beforePolicy.delivery_kind === 'unknown' && !afterPolicy.enabled && ((afterPolicy.delivery_kind === 'address') === (after !== null)));
    return { ...r, before, after, before_policy: beforePolicy, after_policy: afterPolicy } as Entry;
  }); return { data, next_cursor: p.next_cursor as string | null };
}
function Address({ value }: { value: BuyerDeliveryAddress166 | null }) {
  return value ? <div style={{ overflowWrap: 'anywhere' }}><strong>{value.recipient_name}</strong><p>{value.street}<br />{value.postal_code} {value.city}<br />{value.country}<br />{value.phone}</p></div> : <p className="muted">Brak adresu dla tego rodzaju dostawy.</p>;
}
/** Native private GET/PATCH only. Policy ACK loss is resolved by readback, never automatic CAS retry. */
export function BuyerAddressPanel({ orderId, contextKey, readOnly, admin, refresh, externalWriteBlocked = false, onChanged, transport = api }: {
  orderId: string; contextKey: string; readOnly: boolean; admin: boolean; refresh: number; externalWriteBlocked?: boolean;
  onChanged: () => void; transport?: Transport;
}) {
  const scope = contextKey + ':' + readOnly + ':' + orderId, live = useRef({ scope, readOnly, admin, externalWriteBlocked, transport, onChanged });
  live.current = { scope, readOnly, admin, externalWriteBlocked, transport, onChanged };
  const epoch = useRef(0), flight = useRef(false);
  const [state, setState] = useState<Access | null>(null), [tag, setTag] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [history, setHistory] = useState<Entry[]>([]), [cursor, setCursor] = useState<string | null>(null), [enabled, setEnabled] = useState(false);
  const [kind, setKind] = useState<'' | 'address' | 'pickup_point'>(''), [kindConsent, setKindConsent] = useState(false), [consent, setConsent] = useState(false);
  const [pending, setPendingState] = useState<Attempt | null>(uncertainPolicies.get(scope) ?? null), [notice, setNotice] = useState('');
  function setPending(v: Attempt | null) { if (v) uncertainPolicies.set(scope, v); else uncertainPolicies.delete(scope); setPendingState(v); }
  const current = (g: number) => { requireValue(g === epoch.current && scope === live.current.scope); };
  async function auth(g: number) { current(g); const v = await transport('/auth/me') as { user?: { tenant_id: string; id: string; role: string }; restore_preview?: boolean };
    current(g); if (!v.user || `${v.user.tenant_id}:${v.user.id}:${v.user.role}:${v.restore_preview === true}` !== contextKey) throw new ContextChanged('Kontekst zmienił się'); }
  function install(v: Access) { requireValue(v.read_only === live.current.readOnly); setState(v); setTag(scope); setEnabled(v.enabled); setKind(''); setKindConsent(false); setConsent(false); }
  const purge = () => { setState(null); setHistory([]); setCursor(null); setPending(null); setNotice(''); setConsent(false); setKindConsent(false); setKind(''); };
  async function task(fn: (g: number) => Promise<void>) {
    if (flight.current) return; const g = epoch.current; flight.current = true; setBusy(true); setError('');
    try { await fn(g); } catch (e) { if (g === epoch.current && scope === live.current.scope) {
      setError(e instanceof ApiError && [401,403,404].includes(e.status) ? 'Dostęp do adresu jest niedostępny.' : 'Nie udało się potwierdzić operacji.');
      if (e instanceof ContextChanged || e instanceof ApiError && [401,403,404].includes(e.status)) purge();
    } } finally { if (g === epoch.current) { flight.current = false; setBusy(false); } }
  }
  async function read(g: number) { await auth(g); current(g); const v = descriptor(await transport(`/orders/${orderId}/buyer-address-access`)); current(g); await auth(g); current(g); install(v); return v; }
  async function load(g: number) { const v = await read(g); if (!v.available) { setHistory([]); setCursor(null); return; }
    const p = page(await transport(`/orders/${orderId}/buyer-address-history`)); current(g); await auth(g); current(g); setHistory(p.data); setCursor(p.next_cursor); }
  useEffect(() => { ++epoch.current; flight.current = false; setState(null); setHistory([]); setCursor(null); setNotice(''); setConsent(false); setKindConsent(false); setKind('');
    setPendingState(uncertainPolicies.get(scope) ?? null); setTag(''); void task(load); return () => { ++epoch.current; }; }, [scope, transport]);
  const previousRefresh = useRef(refresh);
  useEffect(() => { if (previousRefresh.current !== refresh) { previousRefresh.current = refresh; void task(load); } }, [refresh]);
  async function save(g: number) {
    if (!state || pending || !consent || kind && !kindConsent) return;
    const attempt: Attempt = { enabled, version: state.order_version, policy_version: state.policy_version, ...(kind ? { delivery_kind: kind } : {}) };
    await auth(g); current(g); const fresh = descriptor(await transport(`/orders/${orderId}/buyer-address-access`)); current(g); await auth(g); current(g);
    requireValue(fresh.can_manage && !fresh.read_only && live.current.admin && !live.current.readOnly && !live.current.externalWriteBlocked);
    if (fresh.order_version !== attempt.version || fresh.policy_version !== attempt.policy_version) { install(fresh); setNotice('Polityka lub zamówienie zmieniły się. Sprawdź dane i potwierdź ponownie.'); return; }
    const wire = { ...attempt, ...(attempt.delivery_kind ? { confirmed_delivery_kind: true } : {}) };
    setPending(attempt); setConsent(false); setKindConsent(false);
    try { const v = descriptor(await transport(`/orders/${orderId}/buyer-address-access`, 'PATCH', wire), true); current(g); await auth(g); current(g);
      requireValue(v.enabled === attempt.enabled && (!attempt.delivery_kind || v.delivery_kind === attempt.delivery_kind));
      install(v); setPending(null); setNotice('Zapisano ustawienie dostępu. Dane nabywcy i faktury pozostają bez zmian.'); live.current.onChanged();
    } catch (e) { if (e instanceof ApiError && [409,422,423].includes(e.status)) { current(g); setPending(null); await read(g); setNotice('Serwer odmówił zapisu. Sprawdź aktualny stan przed nową zgodą.'); } else throw e; }
  }
  async function reconcile(g: number) { const v = await read(g); current(g); setPending(null);
    setNotice('Odczytano aktualne ustawienie. Odczyt nie potwierdza autorstwa wcześniejszej zmiany; nowy zapis wymaga nowej zgody.'); live.current.onChanged(); }
  const visible = tag === scope ? state : null, writable = visible?.available && visible.can_manage && admin && !readOnly && !externalWriteBlocked;
  return <section className="panel"><div className="panel-heading"><div><h2>Operacyjny adres dostawy</h2><p>Oddzielny od danych nabywcy i adresu faktury. Zmiana nie wysyła wiadomości ani żądania do przewoźnika.</p></div><button type="button" className="button" disabled={busy} onClick={() => void task(load)}>Odśwież adres i historię</button></div>
    <div className="info-body">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
      {!visible ? <p>Wczytywanie adresu dostawy…</p> : !visible.available ? <p>Moduł adresów jest niedostępny w tej kopii.</p> : <>
        <Address value={visible.effective_delivery} /><p>{kindNames[visible.delivery_kind]} · {originNames[visible.classification_origin]}</p>
        {visible.reason && <p className="muted">{reasonNames[visible.reason]}</p>}
        <p>Dostęp dla posiadacza prywatnego linku: <strong>{visible.enabled ? 'Włączony' : 'Wyłączony'}</strong></p>
        {pending ? <div className="notice"><p>Wynik zmiany ustawienia jest niepewny. Nie ponawiaj zapisu CAS. Sprawdź aktualny stan.</p><button type="button" className="button" disabled={busy} onClick={() => void task(reconcile)}>Sprawdź wynik ustawienia</button></div> : <fieldset disabled={!writable || busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <label><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); setConsent(false); }} /> Udostępnij adres i jego korektę posiadaczowi prywatnego linku</label>
          <label>Potwierdzony rodzaj dostawy<select aria-label="Potwierdzony rodzaj dostawy" value={kind} onChange={e => { setKind(e.target.value as typeof kind); setKindConsent(false); setConsent(false); }}><option value="">Zachowaj aktualną klasyfikację</option><option value="address">Dostawa na adres</option><option value="pickup_point">Dostawa do punktu odbioru</option></select></label>
          {kind && <label><input type="checkbox" checked={kindConsent} onChange={e => { setKindConsent(e.target.checked); setConsent(false); }} /> Sprawdziłem rzeczywisty rodzaj dostawy; nie wnioskuję z nazwy metody</label>}
          <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> Potwierdzam ustawienie dostępu dla posiadacza tego linku</label>
          <button type="button" className="button" disabled={!writable || busy || !consent || Boolean(kind && !kindConsent) || enabled && visible.delivery_kind === 'unknown' && !kind} onClick={() => void task(save)}>Zapisz ustawienie dostępu</button>
        </fieldset>}
        <h3>Historia adresu i udostępnienia</h3>{history.length === 0 && <p className="muted">Brak zapisanych zmian.</p>}
        {history.map(r => <article key={r.id}><h4>{r.kind === 'merge_inherit' ? 'Adres odziedziczony po połączeniu zamówień' : r.kind === 'delivery' ? 'Korekta adresu przez kupującego' : 'Ustawienie dostępu'} · {date(r.created_at)}</h4><p>{r.changed ? 'Zmiana zapisana' : 'Potwierdzenie bez zmiany'}</p>
          {r.kind === 'merge_inherit' && <p>Przeniesiono dane dostawy z wybranego głównego zamówienia. Edycja adresu w portalu pozostała wyłączona.</p>}
          {r.kind !== 'access' ? <div className="table-scroll"><table><thead><tr><th>Pole</th><th>Przed</th><th>Po</th></tr></thead><tbody>{addressKeys.map(k => <tr key={k}><td>{addressLabels[k]}</td><td>{r.before?.[k] ?? '—'}</td><td>{r.after?.[k] ?? '—'}</td></tr>)}</tbody></table></div> : <p>{r.before_policy.enabled ? 'Włączony' : 'Wyłączony'} → {r.after_policy.enabled ? 'Włączony' : 'Wyłączony'} · {kindNames[r.before_policy.delivery_kind]} → {kindNames[r.after_policy.delivery_kind]}</p>}</article>)}
        {cursor && <button type="button" className="button" disabled={busy} onClick={() => void task(async g => { await auth(g); current(g); const p = page(await transport(`/orders/${orderId}/buyer-address-history?cursor=${encodeURIComponent(cursor)}`)); current(g); await auth(g); current(g); requireValue(!p.data.some(r => history.some(old => old.id === r.id))); setHistory([...history, ...p.data]); setCursor(p.next_cursor); })}>Starsze zmiany adresu</button>}
      </>}
    </div></section>;
}
