import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date, money } from './api';
import { ReturnDestinationPartsEditor, type ReturnDestinationPart, type ReturnDestinationPartLine, type ReturnDestinationPartStatus } from './return-destination-parts';
import './return-destinations-intake.css';

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const quantity = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 2147483647;
const canonical = (key: string) => { const p = key.split(':'); return p.length === 4 && uuid(p[0]) && uuid(p[1]) && ['admin', 'operator', 'viewer'].includes(p[2]) && ['true', 'false'].includes(p[3]); };
type Attempt = { context: string; returnId: string; orderId: string; sessionId: string; kind: 'preview' | 'receive'; path: string; body: string; preview?: Preview };
let actorContext = '', actorEpoch = 0, inFlight = false;
let pending: Attempt | null = null;
let outcome: { context: string; returnId: string; sessionId: string; reply: Reply } | null = null;
const rememberedDrafts = new Map<string, Draft>();
const subscribers = new Set<() => void>();
const publish = () => subscribers.forEach(fn => fn());
export function resetReturnDestinationsIntakeContext(next: string) {
  if (actorContext === next) return;
  actorContext = next; actorEpoch++; pending = null; outcome = null; inFlight = false; rememberedDrafts.clear(); publish();
}
export function returnDestinationsIntakeWriteLocked(key: string) { return actorContext === key && Boolean(pending || inFlight); }
export function subscribeReturnDestinationsIntakeLock(key: string, callback: (locked: boolean) => void) {
  const notify = () => callback(returnDestinationsIntakeWriteLocked(key));
  subscribers.add(notify); notify(); return () => { subscribers.delete(notify); };
}
function purge(key: string) { if (actorContext !== key) return; actorEpoch++; pending = null; outcome = null; inFlight = false; rememberedDrafts.clear(); publish(); }
async function verifyActor(key: string) {
  const d = await api('/auth/me');
  if (!canonical(key) || `${d.user?.tenant_id}:${d.user?.id}:${d.user?.role}` !== key.split(':').slice(0, 3).join(':')) throw new ApiError('Zmieniła się firma, użytkownik lub rola.', 403);
}
export type ReturnDestinationsIntakePanelProps = {
  contextKey: string; readOnly: boolean; write: boolean; returnId: string; orderId: string;
  sessionId: string; leaseToken: string;
  externalWriteBlocked?: boolean; onLockedChange?: (locked: boolean) => void; onChanged?: () => void;
  inspectionOnly?: boolean;
  onGuardChange?: (guard: { dirty: boolean; inFlight: boolean }) => void;
  onReceipt?: (receipt: { returnId: string; sessionId: string; receiptId: string; action: 'receive' | 'reject'; protocol: 'destinations_v1' }) => void;
};

type LocationChoice = { part_id: string; product_id: string; location: string; confirmed: boolean };
type FragmentChoice = { part_id: string; issue_fragment_id: string; quantity: number; location: string };
type Draft = { parts: ReturnDestinationPart[]; retired: string[]; locations: LocationChoice[]; picks: FragmentChoice[]; shipping: string; note: string };
const emptyDraft = (): Draft => ({ parts: [], retired: [], locations: [], picks: [], shipping: '0', note: '' });
const same = (a: unknown, b: unknown): boolean => {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, normalize(value)])) : v;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
};
const recipe = (components: { product_id: string; quantity: number }[]) => { const sums = new Map<string, number>(); for (const c of components) sums.set(c.product_id, (sums.get(c.product_id) ?? 0) + c.quantity); return [...sums].map(([product_id, quantity]) => ({ product_id, quantity })).sort((a, b) => a.product_id.localeCompare(b.product_id)); };
type StockCell = { warehouse_id: string; product_id: string; version: string; on_hand: number; reserved: number };
type Fragment = { id: string; product_id: string; layer_id: string; eligible_item_ids: string[]; quantity: number; returned_quantity: number };
type Arrival = { part: ReturnDestinationPart; line: ReturnDestinationPartLine; product_id: string; quantity: number; status: ReturnDestinationPartStatus };
function physicalArrivals(parts: ReturnDestinationPart[], lines: ReturnDestinationPartLine[], statuses: ReturnDestinationPartStatus[]): Arrival[] {
  const result: Arrival[] = [];
  for (const part of parts) {
    const line = lines.find(l => l.item_id === part.item_id), status = statuses.find(s => s.id === part.status_id && s.version === part.status_version);
    if (!line || !status || status.settings.decision !== 'accept') continue;
    const recipe = new Map<string, number>();
    for (const c of line.components) recipe.set(c.product_id, (recipe.get(c.product_id) ?? 0) + c.quantity);
    for (const [product_id, coefficient] of recipe) result.push({ part, line, product_id, quantity: coefficient * part.quantity, status });
  }
  return result;
}
const pairKey = (warehouse: string, product: string) => warehouse + ':' + product;
const locationKey = (part: string, product: string) => part + ':' + product;
function physicalErrors(arrivals: Arrival[], locations: LocationChoice[], picks: FragmentChoice[], stocks: StockCell[], fragments: Fragment[], wms: boolean): string[] {
  const errors: string[] = [], used = new Map<string, number>();
  if (arrivals.length > 500 || picks.length > 500) errors.push('Zakres przyjęcia przekracza 500 fizycznych wierszy lub wyborów fragmentów.');
  for (const a of arrivals) {
    const label = `Pozycja ${a.line.ordinal + 1}, składnik ${a.product_id}`;
    const loc = locations.find(l => l.part_id === a.part.part_id && l.product_id === a.product_id);
    if (!loc?.confirmed || !loc.location.trim() || loc.location !== loc.location.trim() || loc.location.length > 80 || /[\u0000-\u001f\u007f\p{Cs}]/u.test(loc.location)) errors.push(`${label}: potwierdź prawidłową lokalizację docelową.`);
    const stock = stocks.find(s => s.warehouse_id === a.status.settings.warehouse_id && s.product_id === a.product_id);
    if (!stock || !version(stock.version)) errors.push(`${label}: brak aktualnej wersji zapasu magazynu docelowego.`);
    if (wms) {
      const rows = picks.filter(p => p.part_id === a.part.part_id && fragments.find(f => f.id === p.issue_fragment_id)?.product_id === a.product_id);
      if (rows.reduce((n, p) => n + p.quantity, 0) !== a.quantity) errors.push(`${label}: wybierz dokładnie ${a.quantity} sztuk z pierwotnego wydania.`);
    }
  }
  for (const p of picks) {
    const f = fragments.find(f => f.id === p.issue_fragment_id), a = arrivals.find(a => a.part.part_id === p.part_id && a.product_id === f?.product_id);
    if (!wms || !f || !a || !f.eligible_item_ids.includes(a.part.item_id) || !quantity(p.quantity) || p.quantity === 0 || p.location !== locations.find(l => l.part_id === p.part_id && l.product_id === f.product_id)?.location) errors.push('Wybrany fragment nie odpowiada części, oryginalnej pozycji lub lokalizacji.');
    used.set(p.issue_fragment_id, (used.get(p.issue_fragment_id) ?? 0) + p.quantity);
  }
  for (const f of fragments) if ((used.get(f.id) ?? 0) > f.quantity - f.returned_quantity) errors.push(`Fragment ${f.id}: przekroczono wspólną pozostałą ilość wydania.`);
  return [...new Set(errors)];
}
function PhysicalChoices(props: {
  arrivals: Arrival[]; locations: LocationChoice[]; picks: FragmentChoice[]; fragments: Fragment[];
  warehouses: { id: string; name: string; code: string }[]; wms: boolean; disabled: boolean;
  onLocations: (v: LocationChoice[]) => void; onPicks: (v: FragmentChoice[]) => void;
}) {
  const { arrivals, locations, picks, fragments, disabled } = props;
  function setLocation(a: Arrival, change: Partial<LocationChoice>) {
    if (disabled) return;
    const current = locations.find(l => l.part_id === a.part.part_id && l.product_id === a.product_id) ?? { part_id: a.part.part_id, product_id: a.product_id, location: a.status.settings.default_location ?? '', confirmed: false };
    const next = { ...current, ...change };
    props.onLocations([...locations.filter(l => locationKey(l.part_id, l.product_id) !== locationKey(a.part.part_id, a.product_id)), next]);
    if (change.location !== undefined) props.onPicks(picks.filter(p => p.part_id !== a.part.part_id || fragments.find(f => f.id === p.issue_fragment_id)?.product_id !== a.product_id));
  }
  function setPick(a: Arrival, f: Fragment, text: string) {
    if (disabled || !/^(0|[1-9][0-9]*)$/.test(text)) return;
    const n = Number(text); if (!quantity(n)) return;
    const loc = locations.find(l => l.part_id === a.part.part_id && l.product_id === a.product_id);
    const others = picks.filter(p => !(p.part_id === a.part.part_id && p.issue_fragment_id === f.id));
    props.onPicks(n ? [...others, { part_id: a.part.part_id, issue_fragment_id: f.id, quantity: n, location: loc?.location ?? '' }] : others);
  }
  return <div className="rdi-grid">{arrivals.map((a, i) => {
    const loc = locations.find(l => l.part_id === a.part.part_id && l.product_id === a.product_id), w = props.warehouses.find(w => w.id === a.status.settings.warehouse_id);
    const candidates = fragments.filter(f => f.product_id === a.product_id && f.eligible_item_ids.includes(a.part.item_id));
    return <fieldset className="rdi-part" key={locationKey(a.part.part_id, a.product_id)} disabled={disabled}><legend>Cel składnika {i + 1} · pozycja {a.line.ordinal + 1}</legend><p>{a.line.sku} · {a.quantity} szt. fizycznych · {a.product_id}</p><p>{a.status.settings.name} · {w ? `${w.name} (${w.code})` : a.status.settings.warehouse_id}</p><small>Część: {a.part.part_id}</small>
      <label>Lokalizacja składnika {i + 1}<input aria-label={`Lokalizacja składnika ${i + 1}`} maxLength={80} value={loc?.location ?? a.status.settings.default_location ?? ''} onChange={e => setLocation(a, { location: e.target.value, confirmed: false })}/></label>
      <label className="rdi-check"><input aria-label={`Potwierdzam lokalizację składnika ${i + 1}`} type="checkbox" checked={loc?.confirmed ?? false} onChange={e => setLocation(a, { confirmed: e.target.checked })}/>Potwierdzam lokalizację tego składnika.</label>
      {props.wms && <><h4>Fragmenty pierwotnego wydania</h4>{!candidates.length && <p className="notice">Brak fragmentu dozwolonego dla tej oryginalnej pozycji.</p>}{candidates.map(f => { const used = picks.filter(p => p.issue_fragment_id === f.id).reduce((n, p) => n + p.quantity, 0); return <label key={f.id}>Fragment {f.id}<small>Pozostało łącznie {f.quantity - f.returned_quantity}; wybrano we wszystkich częściach {used}. Warstwa {f.layer_id}.</small><input aria-label={`Fragment ${f.id} składnika ${i + 1}`} type="number" min={0} max={f.quantity - f.returned_quantity} value={picks.find(p => p.part_id === a.part.part_id && p.issue_fragment_id === f.id)?.quantity ?? 0} disabled={!loc?.confirmed} onChange={e => setPick(a, f, e.target.value)}/></label>; })}</>}
    </fieldset>;
  })}</div>;
}

type StockEffect = { warehouse_id: string; product_id: string; quantity: number; effect: 'sale' | 'custody'; before: { exists: boolean; version: string; on_hand: number; reserved: number; physical_available: number; sellable_available: number }; after: { on_hand: number; reserved: number; physical_available: number; sellable_available: number } };
function StockReview({ rows, warehouses }: { rows: StockEffect[]; warehouses: { id: string; name: string; code: string }[] }) {
  return <div className="rdi-table"><table><caption>Pełna unia docelowego zapasu — podgląd jednego przyjęcia</caption><thead><tr><th>Magazyn / składnik</th><th>Przeznaczenie</th><th>Stan fizyczny przed → po</th><th>Przyjęcie</th><th>Rezerwacja przed → po</th><th>Fizycznie dostępne przed → po</th><th>Do sprzedaży przed → po</th><th>Wersja zapasu przed</th></tr></thead><tbody>{rows.map(row => {
    const w = warehouses.find(w => w.id === row.warehouse_id);
    return <tr key={pairKey(row.warehouse_id, row.product_id)}><td>{w ? `${w.name} (${w.code})` : row.warehouse_id}<br/><small>{row.product_id}</small></td><td>{row.effect === 'custody' ? 'Poza sprzedażą' : 'Sprzedaż'}</td><td>{row.before.on_hand} → {row.after.on_hand}</td><td>{row.quantity}</td><td>{row.before.reserved} → {row.after.reserved}</td><td>{row.before.physical_available} → {row.after.physical_available}</td><td>{row.before.sellable_available} → {row.after.sellable_available}</td><td>{row.before.version}{!row.before.exists ? ' · nowa para zapasu' : ''}</td></tr>;
  })}</tbody></table></div>;
}

const base = '/return-destinations';
type Flags = { available: boolean; read_only: boolean; current_role: 'admin' | 'operator' | 'viewer' | null; can_read: boolean; can_write: boolean; intake_available: boolean; can_read_value: false };
type Session = { id: string; return_id: string; order_id: string; state: string; version: string; station_id: string; lease_generation: string; lease_expires_at: string; can_control: boolean };
type StatusSnapshot = { status_id: string; version: string; revision_id: string; active: boolean; name: string; color: string; decision: 'accept' | 'reject'; inventory_effect: 'sale' | 'custody' | 'none'; warehouse_id: string | null; warehouse_policy_version: string | null; default_location: string | null };
type PlannerSource = {
  order_id: string; return_id: string; currency: string; requested_shipping_refund: number;
  lines: { item_id: string; ordinal: number; ordered_quantity: number; requested: number; prior_accepted: number; scanned_quantity: number; line_total_minor: number; components: { product_id: string; quantity: number }[] }[];
  statuses: StatusSnapshot[]; warehouse_policies: { warehouse_id: string; usage: 'sale' | 'custody'; enabled: boolean; version: string }[];
  catalog_assignments: { product_id: string; warehouse_ids: string[] }[]; stocks: (StockCell & { exists: boolean })[];
  wms: { enabled: boolean; policy_version: string; issue_fragments: (Fragment & { order_id: string; available: number; currency: string })[] };
};
type DisplayLine = { item_id: string; product_id: string; ordinal: number; sku: string; name: string; components: { product_id: string; quantity: number }[] };
type IssuedOrigin = { origin_id: string; item_id: string; dispatch_id: string; parcel_index: number; shipment_id: string; quantity: number; fragments: { fragment_id: string; product_id: string; quantity: number; available: number }[] };
type Warehouse = { id: string; name: string; code: string };
type Summary = { accepted: number; restocked_to_sale: number; received_into_custody: number; rejected: number; commercial_credit_minor: number; shipping_refund_minor: number };
type Plan = { protocol: 'destinations_v1'; order_id: string; return_id: string; currency: string; parts: { part_id: string; item_id: string; quantity: number; status: StatusSnapshot; refund_minor: number; components: { product_id: string; quantity: number }[] }[]; decisions: { item_id: string; accepted: number; restocked: number; custody: number; rejected: number; refund_minor: number }[]; arrivals: { part_id: string; item_id: string; product_id: string; warehouse_id: string; location: string; quantity: number; effect: 'sale' | 'custody' }[]; stock_effects: StockEffect[]; fragments: { part_id: string; item_id: string; product_id: string; warehouse_id: string; location: string; effect: 'sale' | 'custody'; issue_fragment_id: string; layer_id: string; quantity: number; currency: string }[]; summary: Summary };
type Source = { protocol: 'destinations_v1'; session: Session; return_version: string; return_case: { id: string; number: string }; order: { id: string; number: string; currency: string }; lines: DisplayLine[]; origins: IssuedOrigin[]; station: { id: string; code?: string; label?: string }; scanned: { item_id: string; quantity: number }[]; photos: { id: string; item_id: string; part_id?: string | null }[]; planner_source: PlannerSource; warehouses?: Warehouse[] };
type Snapshot = Omit<Source, 'planner_source' | 'return_version' | 'session'> & { session: Omit<Session, 'can_control'>; source: PlannerSource; plan: Plan; request: Record<string, unknown> };
type Preview = { id: string; kind: 'preview'; protocol: 'destinations_v1'; session_id: string; return_id: string; order_id: string; scope_hash: string; created_at: string; expires_at: string; action: 'receive' | 'reject'; request: Record<string, unknown>; core_input: unknown; summary: Summary; snapshot: Snapshot; operation_id: string | null; can_receive: boolean };
type Operation = { id: string; kind: 'operation'; protocol: 'destinations_v1'; preview_id: string; session_id: string; return_id: string; order_id: string; scope_hash: string; created_at: string; action: 'receive' | 'reject'; request: Record<string, unknown>; snapshot: Snapshot; core_input: unknown; summary: Summary; result: { id: string; number: string; state: string; version: number | string; refund_amount: number; refunded_shipping: number; received_at: string | null } };
type Reply = Flags & { preview?: Preview; operation?: Operation; return_case?: Source['return_case']; reused?: boolean };
type SourceReply = Flags & { source: Source | null; limits: Record<string, number> };
type HistoryHead = Pick<Operation, 'id' | 'preview_id' | 'session_id' | 'return_id' | 'order_id' | 'created_at' | 'action' | 'scope_hash' | 'summary'>;
const publicBody = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'lease_token'));
function checkFlags(d: Flags, key: string) {
  if (!d || ['available', 'read_only', 'can_read', 'can_write', 'intake_available'].some(k => typeof d[k as keyof Flags] !== 'boolean') || d.can_read_value !== false || (d.current_role !== null && !['admin', 'operator', 'viewer'].includes(d.current_role))) throw Error('Niepełny odczyt dostępu do przyjęcia.');
  if (d.current_role !== null && d.current_role !== key.split(':')[2]) throw new ApiError('Zmieniła się rola użytkownika.', 403);
  if (d.available && !d.can_read) throw new ApiError('Odebrano dostęp do zwrotu.', 403);
}
function checkPlanner(s: PlannerSource, returnId: string, orderId: string) {
  if (!s || s.return_id !== returnId || s.order_id !== orderId || !/^[A-Z]{3}$/.test(s.currency) || !quantity(s.requested_shipping_refund) || !Array.isArray(s.lines) || !s.lines.length || s.lines.length > 100 || new Set(s.lines.map(l => l.item_id)).size !== s.lines.length || s.lines.some(l => !uuid(l.item_id) || !quantity(l.requested) || l.requested < 1 || !quantity(l.ordered_quantity) || l.ordered_quantity < l.requested || !quantity(l.prior_accepted) || !quantity(l.scanned_quantity) || l.scanned_quantity > l.requested || !Number.isSafeInteger(l.line_total_minor) || l.line_total_minor < 0 || !Array.isArray(l.components) || !l.components.length || l.components.some(c => !uuid(c.product_id) || !quantity(c.quantity) || c.quantity < 1))) throw Error('Niepełne historyczne pozycje i receptury zwrotu.');
  if (!Array.isArray(s.statuses) || s.statuses.length > 200 || new Set(s.statuses.map(v => v.status_id)).size !== s.statuses.length || s.statuses.some(v => !uuid(v.status_id) || !uuid(v.revision_id) || !version(v.version) || v.version === '0' || typeof v.active !== 'boolean' || typeof v.name !== 'string' || !/^#[a-f0-9]{6}$/i.test(v.color) || !['accept', 'reject'].includes(v.decision) || !['sale', 'custody', 'none'].includes(v.inventory_effect))) throw Error('Niepełne aktywne rewizje statusów.');
  if (new Set(s.lines.map(l => l.ordinal)).size !== s.lines.length || s.lines.some(l => !Number.isInteger(l.ordinal) || l.ordinal < 0 || l.ordinal > 99 || l.requested > 100000 || l.ordered_quantity > 100000)) throw Error('Niepełne numery oryginalnych pozycji.');
  if (!Array.isArray(s.stocks) || s.stocks.length > 500 || new Set(s.stocks.map(v => pairKey(v.warehouse_id, v.product_id))).size !== s.stocks.length || s.stocks.some(v => !uuid(v.warehouse_id) || !uuid(v.product_id) || !version(v.version) || !quantity(v.on_hand) || !quantity(v.reserved) || v.reserved > v.on_hand || typeof v.exists !== 'boolean')) throw Error('Niepełna unia wersji zapasu.');
  if (!Array.isArray(s.warehouse_policies) || !Array.isArray(s.catalog_assignments) || !s.wms || typeof s.wms.enabled !== 'boolean' || !version(s.wms.policy_version) || (s.wms.enabled && s.wms.policy_version === '0') || !Array.isArray(s.wms.issue_fragments) || s.wms.issue_fragments.length > 10000 || new Set(s.wms.issue_fragments.map(f => f.id)).size !== s.wms.issue_fragments.length || s.wms.issue_fragments.some(f => !uuid(f.id) || !uuid(f.product_id) || !uuid(f.layer_id) || f.order_id !== orderId || !quantity(f.quantity) || !quantity(f.returned_quantity) || f.returned_quantity > f.quantity || f.available !== f.quantity - f.returned_quantity || !Array.isArray(f.eligible_item_ids) || f.eligible_item_ids.some(id => !s.lines.some(l => l.item_id === id)))) throw Error('Niepełne polityki lub pochodzenie fragmentów.');
  if (s.warehouse_policies.some(p => !uuid(p.warehouse_id) || !['sale', 'custody'].includes(p.usage) || typeof p.enabled !== 'boolean' || !version(p.version)) || s.catalog_assignments.some(a => !uuid(a.product_id) || !Array.isArray(a.warehouse_ids) || a.warehouse_ids.some(id => !uuid(id))) || s.stocks.some(v => !v.exists && (v.version !== '0' || v.on_hand !== 0 || v.reserved !== 0))) throw Error('Niepełne przeznaczenie magazynów lub przypisania katalogów.');
}
function checkSource(s: Source, props: ReturnDestinationsIntakePanelProps) {
  if (!s || s.protocol !== 'destinations_v1' || s.session?.id !== props.sessionId || s.session.return_id !== props.returnId || s.session.order_id !== props.orderId || !version(s.session.version) || s.session.version === '0' || !version(s.return_version) || s.return_version === '0' || !uuid(s.session.station_id) || typeof s.session.can_control !== 'boolean' || !Number.isFinite(Date.parse(s.session.lease_expires_at)) || s.return_case?.id !== props.returnId || s.order?.id !== props.orderId || !Array.isArray(s.lines) || !Array.isArray(s.scanned) || !Array.isArray(s.photos)) throw Error('Odczytano niepełną lub obcą sesję przyjęcia.');
  checkPlanner(s.planner_source, props.returnId, props.orderId);
  checkOrigins(s.origins, s.planner_source.lines);
  if (s.lines.length !== s.planner_source.lines.length || new Set(s.lines.map(l => l.item_id)).size !== s.lines.length || s.lines.some(l => typeof l.sku !== 'string' || typeof l.name !== 'string' || !Array.isArray(l.components) || !s.planner_source.lines.some(p => p.item_id === l.item_id && p.ordinal === l.ordinal && same(recipe(p.components), recipe(l.components))))) throw Error('Nazwy lub receptury nie odpowiadają oryginalnym pozycjom.');
  if (s.warehouses && (!Array.isArray(s.warehouses) || s.warehouses.some(w => !uuid(w.id) || typeof w.name !== 'string' || typeof w.code !== 'string'))) throw Error('Niepełne nazwy magazynów docelowych.');
}
function checkOrigins(origins: IssuedOrigin[], lines: PlannerSource['lines']) {
  if (!Array.isArray(origins) || origins.length > 500 || new Set(origins.map(o => o.origin_id)).size !== origins.length || origins.some(o => !uuid(o.origin_id) || !uuid(o.dispatch_id) || !uuid(o.shipment_id) || !Number.isInteger(o.parcel_index) || o.parcel_index < 0 || o.parcel_index > 49 || !quantity(o.quantity) || o.quantity < 1 || !lines.some(l => l.item_id === o.item_id) || !Array.isArray(o.fragments) || o.fragments.length > 10000 || new Set(o.fragments.map(f => f.fragment_id)).size !== o.fragments.length || o.fragments.some(f => !uuid(f.fragment_id) || !lines.find(l => l.item_id === o.item_id)!.components.some(c => c.product_id === f.product_id) || !quantity(f.quantity) || !quantity(f.available) || f.available > f.quantity))) throw Error('Niepełne rzeczywiste pochodzenie wydanych pozycji RMA.');
}
function checkSummary(s: Summary) { if (!s || Object.values(s).some(n => !Number.isSafeInteger(n) || n < 0) || !['accepted', 'restocked_to_sale', 'received_into_custody', 'rejected', 'commercial_credit_minor', 'shipping_refund_minor'].every(k => typeof s[k as keyof Summary] === 'number')) throw Error('Niepełne podsumowanie przyjęcia.'); }
function checkPlan(p: Plan, returnId: string, orderId: string) {
  if (!p || p.protocol !== 'destinations_v1' || p.return_id !== returnId || p.order_id !== orderId || !Array.isArray(p.parts) || p.parts.length > 200 || !Array.isArray(p.decisions) || !Array.isArray(p.arrivals) || !Array.isArray(p.stock_effects) || !Array.isArray(p.fragments)) throw Error('Brak pełnego podglądu wszystkich części i magazynów.');
  checkSummary(p.summary);
  if (p.parts.some(v => !uuid(v.part_id) || !uuid(v.item_id) || !quantity(v.quantity) || v.quantity < 1 || !v.status || !uuid(v.status.status_id)) || new Set(p.parts.map(v => v.part_id)).size !== p.parts.length || p.stock_effects.some(v => !uuid(v.warehouse_id) || !uuid(v.product_id) || !quantity(v.quantity) || !['sale', 'custody'].includes(v.effect) || !v.before || !version(v.before.version) || !v.after || ['on_hand', 'reserved', 'physical_available', 'sellable_available'].some(k => !quantity(v.before[k as keyof StockEffect['before']]) || !quantity(v.after[k as keyof StockEffect['after']])))) throw Error('Niepełny fizyczny wynik podglądu.');
}
function checkSnapshotPlan(snapshot: Snapshot) {
  if (snapshot.protocol !== 'destinations_v1') throw Error('Zapisany podgląd ma inny protokół przyjęcia.');
  const p = snapshot.plan, input = snapshot.request.parts;
  if (!Array.isArray(input) || input.length !== p.parts.length || !same([...input].sort((a, b) => String(a.part_id).localeCompare(String(b.part_id))), p.parts.map(v => ({ part_id: v.part_id, item_id: v.item_id, quantity: v.quantity, status_id: v.status.status_id, status_version: v.status.version })).sort((a, b) => a.part_id.localeCompare(b.part_id)))) throw Error('Zapisany plan zmienił części lub rewizje wysłanej decyzji.');
  for (const l of snapshot.source.lines) {
    const rows = p.parts.filter(v => v.item_id === l.item_id);
    if (rows.reduce((n, v) => n + v.quantity, 0) !== l.requested || rows.some(v => !same(recipe(v.components), recipe(l.components)) || !snapshot.source.statuses.some(s => s.status_id === v.status.status_id && same(s, v.status)))) throw Error('Plan nie zachowuje całej oryginalnej pozycji i historycznej receptury.');
  }
  if (p.parts.some(v => !snapshot.source.lines.some(l => l.item_id === v.item_id))) throw Error('Plan zawiera obcą oryginalną pozycję.');
  const accepted = p.parts.filter(v => v.status.decision === 'accept'), rejected = p.parts.filter(v => v.status.decision === 'reject');
  if (p.summary.accepted !== accepted.reduce((n, v) => n + v.quantity, 0) || p.summary.rejected !== rejected.reduce((n, v) => n + v.quantity, 0) || p.summary.restocked_to_sale !== accepted.filter(v => v.status.inventory_effect === 'sale').reduce((n, v) => n + v.quantity, 0) || p.summary.received_into_custody !== accepted.filter(v => v.status.inventory_effect === 'custody').reduce((n, v) => n + v.quantity, 0) || p.summary.commercial_credit_minor !== p.parts.reduce((n, v) => n + v.refund_minor, p.summary.shipping_refund_minor)) throw Error('Podsumowanie nie zachowuje ilości i kwoty zatwierdzonych części.');
  const expected = accepted.flatMap(v => recipe(v.components).map(c => ({ part_id: v.part_id, item_id: v.item_id, product_id: c.product_id, warehouse_id: v.status.warehouse_id, quantity: c.quantity * v.quantity, effect: v.status.inventory_effect, location: (snapshot.request.locations as LocationChoice[] | undefined)?.find(l => l.part_id === v.part_id && l.product_id === c.product_id)?.location })));
  const sorted = (v: unknown[]) => [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // Compare selected fields independently of server object-key ordering.
  const arrivalFields = (v: typeof p.arrivals[number]) => ({ part_id: v.part_id, item_id: v.item_id, product_id: v.product_id, warehouse_id: v.warehouse_id, quantity: v.quantity, effect: v.effect, location: v.location });
  if (!same(sorted(expected), sorted(p.arrivals.map(arrivalFields)))) throw Error('Plan nie obejmuje dokładnie wszystkich fizycznych składników i lokalizacji.');
  const cells = new Map<string, number>();
  for (const a of p.arrivals) cells.set(pairKey(a.warehouse_id, a.product_id), (cells.get(pairKey(a.warehouse_id, a.product_id)) ?? 0) + a.quantity);
  if (cells.size !== p.stock_effects.length || new Set(p.stock_effects.map(v => pairKey(v.warehouse_id, v.product_id))).size !== p.stock_effects.length) throw Error('Brak całej unii docelowego zapasu.');
  for (const row of p.stock_effects) {
    const old = snapshot.source.stocks.find(s => s.warehouse_id === row.warehouse_id && s.product_id === row.product_id), n = cells.get(pairKey(row.warehouse_id, row.product_id));
    if (!old || row.quantity !== n || row.before.version !== old.version || row.before.on_hand !== old.on_hand || row.before.reserved !== old.reserved || row.after.on_hand !== old.on_hand + row.quantity || row.after.reserved !== old.reserved || row.after.physical_available !== row.after.on_hand - row.after.reserved || row.after.sellable_available !== (row.effect === 'sale' ? row.after.physical_available : 0)) throw Error('Wiersz zapasu nie odpowiada pełnemu przyjęciu do tego magazynu.');
  }
  const chosen = (snapshot.request.wms_lots as { picks?: FragmentChoice[] } | undefined)?.picks ?? [];
  const fragmentFields = (f: typeof p.fragments[number]) => ({ part_id: f.part_id, issue_fragment_id: f.issue_fragment_id, quantity: f.quantity, location: f.location });
  if (!same(sorted(chosen.map(v => ({ part_id: v.part_id, issue_fragment_id: v.issue_fragment_id, quantity: v.quantity, location: v.location }))), sorted(p.fragments.map(fragmentFields)))) throw Error('Plan nie zachowuje dokładnego wyboru źródłowych fragmentów.');
  for (const f of p.fragments) {
    const original = snapshot.source.wms.issue_fragments.find(v => v.id === f.issue_fragment_id), arrival = p.arrivals.find(v => v.part_id === f.part_id && v.product_id === f.product_id);
    if (!original || !arrival || f.layer_id !== original.layer_id || f.product_id !== original.product_id || f.item_id !== arrival.item_id || !original.eligible_item_ids.includes(f.item_id) || f.warehouse_id !== arrival.warehouse_id || f.effect !== arrival.effect || f.location !== arrival.location || !quantity(f.quantity) || f.quantity < 1) throw Error('Fragment podglądu nie ma dokładnego pochodzenia i celu tej części.');
  }
}
function checkPreview(p: Preview, props: Pick<ReturnDestinationsIntakePanelProps, 'returnId' | 'orderId' | 'sessionId'>) {
  if (!p || !uuid(p.id) || p.kind !== 'preview' || p.protocol !== 'destinations_v1' || p.return_id !== props.returnId || p.order_id !== props.orderId || p.session_id !== props.sessionId || !hash(p.scope_hash) || !Number.isFinite(Date.parse(p.expires_at)) || !['receive', 'reject'].includes(p.action) || !p.request || typeof p.can_receive !== 'boolean' || (p.operation_id !== null && !uuid(p.operation_id)) || p.snapshot?.session?.id !== props.sessionId || p.snapshot.return_case?.id !== props.returnId || p.snapshot.order?.id !== props.orderId) throw Error('Niepełny lub obcy zapisany podgląd przyjęcia.');
  checkPlanner(p.snapshot.source, props.returnId, props.orderId); checkPlan(p.snapshot.plan, props.returnId, props.orderId); checkSummary(p.summary);
  checkOrigins(p.snapshot.origins, p.snapshot.source.lines);
  checkSnapshotPlan(p.snapshot);
  if (!same(p.summary, p.snapshot.plan.summary) || !same(p.request, p.snapshot.request)) throw Error('Podsumowanie lub żądanie nie odpowiada pełnemu podglądowi.');
}
function checkOperation(op: Operation, props: Pick<ReturnDestinationsIntakePanelProps, 'returnId' | 'orderId' | 'sessionId'>) {
  if (!op || !uuid(op.id) || !uuid(op.preview_id) || op.kind !== 'operation' || op.protocol !== 'destinations_v1' || op.return_id !== props.returnId || op.order_id !== props.orderId || op.session_id !== props.sessionId || !hash(op.scope_hash) || !['receive', 'reject'].includes(op.action) || !op.request || !op.result || typeof op.result.state !== 'string' || !quantity(op.result.refund_amount) || !quantity(op.result.refunded_shipping) || op.snapshot?.session?.id !== props.sessionId || op.snapshot.return_case?.id !== props.returnId || op.snapshot.order?.id !== props.orderId) throw Error('Brak pełnego trwałego wyniku przyjęcia. Dokładna próba pozostaje zachowana.');
  checkPlanner(op.snapshot.source, props.returnId, props.orderId); checkPlan(op.snapshot.plan, props.returnId, props.orderId); checkSummary(op.summary);
  checkOrigins(op.snapshot.origins, op.snapshot.source.lines);
  checkSnapshotPlan(op.snapshot);
  if (!same(op.summary, op.snapshot.plan.summary)) throw Error('Wynik nie odpowiada wszystkim częściom przyjęcia.');
  const originalVersion = op.snapshot.request.return_version, resultVersion = String(op.result.version);
  if (!version(originalVersion) || originalVersion === '0' || !version(resultVersion) || BigInt(resultVersion) !== BigInt(originalVersion) + 1n || op.result.id !== props.returnId || op.result.number !== op.snapshot.return_case.number || op.result.state !== (op.action === 'receive' ? 'refund_pending' : 'rejected') || op.result.refund_amount !== op.summary.commercial_credit_minor || op.result.refunded_shipping !== op.summary.shipping_refund_minor || (op.action === 'receive' && (typeof op.result.received_at !== 'string' || !Number.isFinite(Date.parse(op.result.received_at))))) throw Error('Rzeczywisty wynik RMA nie odpowiada zatwierdzonej decyzji i kwocie. Dokładna próba pozostaje zachowana.');
}
function validateReply(d: Reply, a: Attempt) {
  checkFlags(d, a.context);
  if (typeof d.reused !== 'boolean' || !d.available || !d.intake_available || !d.can_read || d.read_only) throw Error('Brak autorytatywnego wyniku dokładnej próby.');
  const b = JSON.parse(a.body), props = { returnId: a.returnId, orderId: a.orderId, sessionId: a.sessionId };
  if (a.kind === 'preview') {
    if (!d.preview) throw Error('Brak zapisanego podglądu.'); checkPreview(d.preview, props);
    if (!same(d.preview.request, publicBody(b))) throw Error('Podgląd nie odpowiada dokładnie wysłanemu podziałowi.');
  } else {
    const op = d.operation, p = a.preview;
    if (!op || !p || d.return_case?.id !== a.returnId) throw Error('Brak trwałego potwierdzenia tego RMA.'); checkOperation(op, props);
    if (op.preview_id !== p.id || op.scope_hash !== p.scope_hash || !same(op.request, publicBody(b)) || !same(op.snapshot, p.snapshot) || !same(op.core_input, p.core_input) || !same(op.summary, p.summary) || op.action !== p.action) throw Error('Wynik nie odpowiada pełnemu zatwierdzonemu podglądowi.');
  }
}

function PlanReview({ snapshot, summary }: { snapshot: Snapshot; summary: Summary }) {
  const { plan } = snapshot;
  return <>
    <dl className="rdi-summary"><dt>RMA / zamówienie</dt><dd>{snapshot.return_case.number} / {snapshot.order.number}</dd><dt>Stanowisko kontroli</dt><dd>{snapshot.station.label ?? snapshot.station.code ?? snapshot.session.station_id}</dd><dt>Przyjęte handlowo</dt><dd>{summary.accepted}</dd><dt>Do magazynu sprzedaży</dt><dd>{summary.restocked_to_sale}</dd><dt>Fizycznie poza sprzedażą</dt><dd>{summary.received_into_custody}</dd><dt>Odrzucone</dt><dd>{summary.rejected}</dd><dt>Kwota uznania</dt><dd>{money(summary.commercial_credit_minor, plan.currency)} — bez wypłaty pieniędzy</dd><dt>Uznanie dostawy</dt><dd>{money(summary.shipping_refund_minor, plan.currency)}</dd><dt>Zdjęcia kontroli</dt><dd>{snapshot.photos.length}</dd></dl>
    {plan.parts.map(part => {
      const line = snapshot.lines.find(l => l.item_id === part.item_id), original = snapshot.source.lines.find(l => l.item_id === part.item_id), w = snapshot.warehouses?.find(w => w.id === part.status.warehouse_id);
      return <article className="rdi-part" key={part.part_id}><h4>Pozycja {(line?.ordinal ?? 0) + 1} · {line?.sku} · {line?.name}</h4><small>Oryginalna pozycja {part.item_id} · część {part.part_id}</small><p>Oryginalnie {original?.ordered_quantity} szt. / {money(original?.line_total_minor ?? 0, plan.currency)} za całą pozycję. Ta część: {part.quantity} szt.</p><p>{part.status.name} · rewizja {part.status.version} · {part.status.decision === 'reject' ? 'Odrzucenie bez przyjęcia zapasu' : part.status.inventory_effect === 'custody' ? 'Przyjęcie fizyczne poza sprzedażą' : 'Przyjęcie do sprzedaży'}</p>{part.status.warehouse_id && <p>Magazyn {w ? `${w.name} (${w.code})` : part.status.warehouse_id} · polityka {part.status.warehouse_policy_version}</p>}<p>Historyczna receptura: {part.components.map(c => `${c.product_id} × ${c.quantity}`).join('; ')} na pełną sztukę. Kwota uznania części: {money(part.refund_minor, plan.currency)}.</p>{plan.arrivals.filter(a => a.part_id === part.part_id).map(a => <p key={a.product_id}>{a.product_id}: {a.quantity} szt. → lokalizacja {a.location}</p>)}
      {plan.fragments.filter(f => f.part_id === part.part_id).map(f => <p key={f.issue_fragment_id + ':' + f.location}>Źródłowy fragment {f.issue_fragment_id} · warstwa {f.layer_id} · {f.product_id} · {f.quantity} szt. → {f.location}</p>)}
      {snapshot.origins.filter(o => o.item_id === part.item_id).map(o => <div key={o.origin_id}><p>Pochodzenie wydania: paczka {o.parcel_index + 1} · wydanie {o.dispatch_id} · zgłoszono {o.quantity} szt.</p><small>Przesyłka {o.shipment_id} · pochodzenie {o.origin_id}</small>{o.fragments.map(f => <p key={f.fragment_id}>Fragment pochodzenia {f.fragment_id} · {f.product_id} · pozostało {f.available} / {f.quantity} szt. fizycznych w chwili podglądu.</p>)}</div>)}
    </article>; })}
    <StockReview rows={plan.stock_effects} warehouses={snapshot.warehouses ?? []}/>
    <p>Podgląd obejmuje jeden zapis przyjęcia. Nie wykonuje osobnego transferu, wysyłki, płatności ani kontaktu z dostawcą.</p>
  </>;
}

export function ReturnDestinationsIntakePanel(props: ReturnDestinationsIntakePanelProps) {
  const scope = props.contextKey, binding = `${scope}:${props.returnId}:${props.orderId}:${props.sessionId}:${Boolean(props.inspectionOnly)}`, draftKey = `${scope}:${props.returnId}:${props.sessionId}`;
  const [sourceReply, setSourceReply] = useState<SourceReply | null>(null), [draft, setDraft] = useState<Draft>(() => actorContext === scope ? structuredClone(rememberedDrafts.get(draftKey) ?? emptyDraft()) : emptyDraft()), [validParts, setValidParts] = useState(false), [preview, setPreview] = useState<Preview | null>(null), [operation, setOperation] = useState<Operation | null>(null), [consent, setConsent] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState(''), [history, setHistory] = useState<HistoryHead[]>([]), [cursor, setCursor] = useState<string | null>(null), [signal, setSignal] = useState(0), [loaded, setLoaded] = useState<{ binding: string; epoch: number } | null>(null);
  const [needsFreshSource, setNeedsFreshSource] = useState(false);
  const [historyLoaded,setHistoryLoaded]=useState(false);
  const alive = useRef(false), generation = useRef(0), currentBinding = useRef(binding), latest = useRef(props), applied = useRef<Reply | null>(null), previousReadOnly = useRef(props.readOnly);
  currentBinding.current = binding; latest.current = props;
  const current = (g: number, e: number) => alive.current && currentBinding.current === binding && generation.current === g && actorContext === scope && actorEpoch === e;
  const visible = loaded?.binding === binding && loaded.epoch === actorEpoch && actorContext === scope;
  const source = visible ? sourceReply?.source : null;
  const locked = returnDestinationsIntakeWriteLocked(scope), retained = pending?.context === scope && pending.returnId === props.returnId && pending.orderId === props.orderId && pending.sessionId === props.sessionId ? pending : null;
  const writable = Boolean(!props.inspectionOnly && visible && sourceReply?.available && sourceReply.intake_available && sourceReply.can_write && !sourceReply.read_only && ['admin', 'operator'].includes(sourceReply.current_role ?? '') && props.write && !props.readOnly && scope.split(':')[3] === 'false');
  const controlled = Boolean(source?.session.state === 'active' && source.session.can_control && Date.parse(source.session.lease_expires_at) > Date.now() && uuid(props.leaseToken));
  const freshBlocked = !writable || !controlled || locked || props.externalWriteBlocked || reading || needsFreshSource;
  const lines: ReturnDestinationPartLine[] = source ? source.planner_source.lines.map(l => ({ ...l, sku: source.lines.find(d => d.item_id === l.item_id)!.sku, name: source.lines.find(d => d.item_id === l.item_id)!.name })) : [];
  const statuses: ReturnDestinationPartStatus[] = source ? source.planner_source.statuses.map(s => ({ id: s.status_id, version: s.version, revision_id: s.revision_id, settings: { name: s.name, color: s.color, active: s.active, decision: s.decision, inventory_effect: s.inventory_effect, warehouse_id: s.warehouse_id, warehouse_policy_version: s.warehouse_policy_version, default_location: s.default_location } })) : [];
  const arrivals = physicalArrivals(draft.parts, lines, statuses), warehouses = source?.warehouses ?? [];
  const errors = source ? physicalErrors(arrivals, draft.locations, draft.picks, source.planner_source.stocks, source.planner_source.wms.issue_fragments, source.planner_source.wms.enabled) : [];
  if (source) for (const l of source.planner_source.lines) {
    const n = draft.parts.filter(p => p.item_id === l.item_id && statuses.find(s => s.id === p.status_id && s.version === p.status_version)?.settings.decision === 'accept').reduce((sum, p) => sum + p.quantity, 0);
    if (n > l.scanned_quantity) errors.push(`Pozycja ${l.ordinal + 1}: przyjęcie ${n} sztuk przekracza trwałą kontrolę ${l.scanned_quantity} sztuk. Wróć do skanowania w asystencie.`);
  }
  if (source) for (const a of arrivals) {
    const policy = source.planner_source.warehouse_policies.find(p => p.warehouse_id === a.status.settings.warehouse_id), assignment = source.planner_source.catalog_assignments.find(p => p.product_id === a.product_id);
    if (!policy?.enabled || policy.usage !== a.status.settings.inventory_effect || policy.version !== a.status.settings.warehouse_policy_version) errors.push(`Pozycja ${a.line.ordinal + 1}: status nie odpowiada aktualnej polityce magazynu docelowego.`);
    if (!assignment?.warehouse_ids.includes(a.status.settings.warehouse_id!)) errors.push(`Pozycja ${a.line.ordinal + 1}: magazyn nie jest przypisany do katalogu składnika ${a.product_id}.`);
  }
  function clear() { setSourceReply(null); setLoaded(null); setPreview(null); setOperation(null); setConsent(false); setHistory([]); setHistoryLoaded(false); setCursor(null); setValidParts(false); }
  function fail(err: unknown) { setError(err instanceof Error ? err.message : 'Nie udało się odczytać przyjęcia.'); setConsent(false); if (err instanceof ApiError && [401, 403].includes(err.status)) { purge(scope); clear(); setDraft(emptyDraft()); } }
  async function read<T extends Flags>(path: string | (() => Promise<T>), apply: (d: T) => void) {
    const g = ++generation.current, e = actorEpoch; setReading(true); setError('');
    try { await verifyActor(scope); const d = await (typeof path === 'string' ? api<T>(path) : path()); await verifyActor(scope); if (!current(g, e)) return; checkFlags(d, scope); apply(d); }
    catch (err) { if (current(g, e)) fail(err); }
    finally { if (alive.current && currentBinding.current === binding && generation.current === g) setReading(false); }
  }
  const sourcePath = `${base}/returns/${props.returnId}/source?session_id=${encodeURIComponent(props.sessionId)}`;
  async function getAccess(): Promise<SourceReply> {
    const access = await api<Flags & { limits: Record<string, number> }>(base + '/options'); checkFlags(access, scope);
    return { ...access, source: null };
  }
  async function getSource(): Promise<SourceReply> {
    const access = await getAccess();
    if (!access.available || !access.intake_available || props.inspectionOnly) return { ...access, source: null };
    return api<SourceReply>(sourcePath);
  }
  function loadSource(invalidate = true) {
    setPreview(null); setConsent(false);
    if (invalidate && !props.inspectionOnly && outcome?.context === scope && outcome.returnId === props.returnId && outcome.sessionId === props.sessionId && outcome.reply.preview) outcome = null;
    const recovery = !props.inspectionOnly && pending?.context === scope && pending.returnId === props.returnId && pending.orderId === props.orderId && pending.sessionId === props.sessionId;
    void read<SourceReply>(recovery ? getAccess : getSource, d => { if (d.available && d.intake_available && !props.inspectionOnly && !recovery) { if (!d.source) throw Error('Brak pełnego źródła przyjęcia.'); checkSource(d.source, props); } setSourceReply(d); setNeedsFreshSource(false); setLoaded({ binding, epoch: actorEpoch }); });
  }
  useEffect(() => {
    alive.current = true; generation.current++; resetReturnDestinationsIntakeContext(canonical(scope) ? scope : '');
    if (previousReadOnly.current !== props.readOnly) purge(scope); previousReadOnly.current = props.readOnly;
    clear(); setDraft(structuredClone(rememberedDrafts.get(draftKey) ?? emptyDraft())); setNeedsFreshSource(false); setReading(false); setError(''); applied.current = null;
    const unsubscribe = subscribeReturnDestinationsIntakeLock(scope, () => setSignal(v => v + 1));
    if (canonical(scope) && uuid(props.returnId) && uuid(props.orderId) && uuid(props.sessionId)) loadSource(false);
    else setError('Brak prawidłowego kontekstu sprawy i własnej sesji kontroli.');
    return () => { alive.current = false; generation.current++; unsubscribe(); };
  }, [binding, props.readOnly]);
  useEffect(() => { if (!props.inspectionOnly && actorContext === scope && loaded?.binding === binding) rememberedDrafts.set(draftKey, structuredClone(draft)); }, [draft, loaded, binding, draftKey, scope,props.inspectionOnly]);
  useEffect(() => { props.onLockedChange?.(locked); }, [locked, props.onLockedChange, signal]);
  const dirtyDraft = !props.inspectionOnly && visible && !preview && !operation && Boolean(draft.parts.length || draft.note || draft.locations.length || draft.picks.length || draft.shipping !== '0');
  useEffect(() => { latest.current.onGuardChange?.({ dirty: dirtyDraft, inFlight: locked && inFlight }); }, [dirtyDraft, locked, signal]);
  useEffect(() => { if (loaded && loaded.epoch !== actorEpoch) { clear(); setDraft(emptyDraft()); } }, [signal, loaded]);
  useEffect(() => {
    const result = outcome;
    if (props.inspectionOnly || !visible || !sourceReply?.can_read || !result || result.context !== scope || result.returnId !== props.returnId || result.sessionId !== props.sessionId || applied.current === result.reply) return;
    applied.current = result.reply; setConsent(false); if (result.reply.preview) { setPreview(result.reply.preview); setOperation(null); } else if (result.reply.operation) { setOperation(result.reply.operation); setPreview(null); }
  }, [visible, sourceReply, scope, props.returnId, props.sessionId, signal,props.inspectionOnly]);
  function invalidateOutcome() { if (outcome?.context === scope && outcome.returnId === props.returnId && outcome.sessionId === props.sessionId) outcome = null; }
  function edit(change: Partial<Draft>) { if (freshBlocked) return; invalidateOutcome(); setDraft(v => ({ ...v, ...change })); setPreview(null); setOperation(null); setConsent(false); }
  async function mutate(a: Attempt, retry = false) {
    if (latest.current.inspectionOnly || inFlight || reading || !writable || (!retry && freshBlocked) || (retry ? pending !== a : pending !== null)) return;
    const e = actorEpoch, g = generation.current; setError(''); setConsent(false); inFlight = true; publish(); let sent = false, responseReceived = false;
    const allowed = () => alive.current && currentBinding.current === binding && latest.current.contextKey === scope && latest.current.returnId === a.returnId && latest.current.orderId === a.orderId && latest.current.sessionId === a.sessionId && latest.current.write && !latest.current.readOnly && (retry || !latest.current.externalWriteBlocked);
    try {
      await verifyActor(scope); const access = await (retry ? getAccess() : getSource());
      await verifyActor(scope);
      if (!current(g, e)) return; checkFlags(access, scope);
      if (!access.available || !access.intake_available || !access.can_write || access.read_only || !['admin', 'operator'].includes(access.current_role ?? '')) throw new ApiError('Brak bieżącego prawa do przyjęcia.', access.read_only ? 423 : 403);
      if (!allowed()) throw Error('Zmiana kontekstu lub inny zapis wstrzymały świeże przyjęcie.');
      if (!retry) {
        if (!access.source) throw Error('Brak pełnego aktualnego źródła.'); checkSource(access.source, latest.current);
        if (!access.source.session.can_control || access.source.session.state !== 'active' || Date.parse(access.source.session.lease_expires_at) <= Date.now()) throw new ApiError('Kontrola nie ma aktualnej własnej rezerwacji stanowiska.', 409);
      }
      pending = a; sent = true; publish(); const d = await api<Reply>(a.path, 'POST', JSON.parse(a.body)); responseReceived = true;
      if (actorContext !== scope || actorEpoch !== e) return; validateReply(d, a);
      // A committed historical receipt does not depend on today's source
      // eligibility, resource count or station lease. Pin actual current grants.
      await verifyActor(scope); const fresh = await getAccess(); await verifyActor(scope); if (actorContext !== scope || actorEpoch !== e) return;
      checkFlags(fresh, scope); if (!fresh.available || !fresh.intake_available || !fresh.can_read) throw new ApiError('Odebrano dostęp do sprawy lub przyjęcie nie jest dostępne.', fresh.can_read ? 503 : 403);
      outcome = { context: scope, returnId: a.returnId, sessionId: a.sessionId, reply: d }; pending = null;
      if (current(g, e)) { applied.current = d; if (d.preview) { setPreview(d.preview); setOperation(null); } else if (d.operation) { setOperation(d.operation); setPreview(null); latest.current.onReceipt?.({ returnId: d.operation.return_id, sessionId: d.operation.session_id, receiptId: d.operation.id, action: d.operation.action, protocol: d.operation.protocol }); latest.current.onChanged?.(); } }
    } catch (err) {
      if (actorContext === scope && actorEpoch === e && err instanceof ApiError) {
        if ([401, 403].includes(err.status)) {
          const publishHere=current(g,e);purge(scope);
          if(publishHere){clear();setDraft(emptyDraft());setConsent(false);setError(err.message);}
        }
        else if (sent && !responseReceived && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) { pending = null; invalidateOutcome(); if (current(g, e)) { setPreview(null); setNeedsFreshSource(true); } }
      }
      if (current(g, e)) fail(err);
    } finally { if (actorContext === scope && actorEpoch === e) { inFlight = false; publish(); } }
  }
  function prepare() {
    if (!source || freshBlocked || !validParts || errors.length || !/^(0|[1-9][0-9]*)$/.test(draft.shipping) || !quantity(Number(draft.shipping)) || Number(draft.shipping) > source.planner_source.requested_shipping_refund || draft.note.trim().length < 3 || draft.note.trim().length > 2000) { setError('Sprawdź pełny podział, kontrolę sztuk, lokalizacje, fragmenty, notatkę i kwotę dostawy.'); return; }
    const wanted = new Set(arrivals.map(a => pairKey(a.status.settings.warehouse_id!, a.product_id))), stock_versions = source.planner_source.stocks.filter(s => wanted.has(pairKey(s.warehouse_id, s.product_id))).map(({ warehouse_id, product_id, version }) => ({ warehouse_id, product_id, version }));
    const body = { protocol: 'destinations_v1', client_key: crypto.randomUUID(), return_version: source.return_version, session_id: props.sessionId, session_version: source.session.version, lease_token: props.leaseToken, note: draft.note.trim(), parts: draft.parts, locations: draft.locations.filter(l => arrivals.some(a => a.part.part_id === l.part_id && a.product_id === l.product_id)).map(l => ({ ...l, confirmed: true })), stock_versions, ...(source.planner_source.wms.enabled && arrivals.length ? { wms_lots: { policy_version: source.planner_source.wms.policy_version, picks: draft.picks } } : {}), shipping_refund: Number(draft.shipping) };
    void mutate({ context: scope, returnId: props.returnId, orderId: props.orderId, sessionId: props.sessionId, kind: 'preview', path: `${base}/returns/${props.returnId}/previews`, body: JSON.stringify(body) });
  }
  function loadHistory(more = false) {
    void read<Flags & { data: HistoryHead[]; next_cursor: string | null }>(`${base}/returns/${props.returnId}/history?session_id=${encodeURIComponent(props.sessionId)}&limit=50${more && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, d => {
      if (!Array.isArray(d.data) || d.data.length > 50 || (d.next_cursor !== null && !uuid(d.next_cursor)) || (more && cursor && d.next_cursor === cursor) || d.data.some(h => !uuid(h.id) || !uuid(h.preview_id) || h.return_id !== props.returnId || h.order_id !== props.orderId || h.session_id !== props.sessionId || !hash(h.scope_hash))) throw Error('Niepełna historia tej sesji przyjęcia.');
      setHistory(v => more ? [...v, ...d.data] : d.data); setHistoryLoaded(true); setCursor(d.next_cursor);
    });
  }
  return <section className="panel return-destinations-intake" aria-label="Przyjęcie zwrotu do wybranych magazynów"><header><h3>Przyjęcie zwrotu do wybranych magazynów</h3><p>Podział oryginalnych pozycji i jeden zatwierdzony zapis przyjęcia.</p></header><div className="rdi-body">
    <div className="rdi-actions"><button className="button" type="button" disabled={reading || inFlight} onClick={() => loadSource()}>{props.inspectionOnly?'Odczytaj dostęp do historii':'Odczytaj źródło przyjęcia'}</button>{visible && sourceReply?.can_read && sourceReply.available && sourceReply.intake_available && <button className="button" type="button" disabled={reading || inFlight} onClick={() => loadHistory()}>Odczytaj historię przyjęcia</button>}</div>
    {props.inspectionOnly&&<p className="notice">Odczyt zapisanych przyjęć tej sesji. Bez skanowania, tokenu rezerwacji, formularza przyjęcia i zapisu nowej decyzji.</p>}
    {historyLoaded&&!history.length&&<p className="notice" role="status">Brak zapisanych przyjęć do wybranych magazynów w tej sesji.</p>}
    {error && <p className="error-block" role="alert">{error}</p>}
    {needsFreshSource && <p className="notice">Próba została jednoznacznie odrzucona. Odczytaj źródło przyjęcia ponownie, przygotuj nowy pełny podgląd i potwierdź go osobno.</p>}
    {visible && sourceReply && (!sourceReply.available || !sourceReply.intake_available) && <p className="notice">Przyjęcie do wielu magazynów nie jest dostępne w tej kopii. Ustawienia statusów nie włączają tego procesu.</p>}
    {visible && retained && !props.inspectionOnly && <div className="notice">{inFlight ? <p role="status">Trwa zapis przyjęcia. Poczekaj na potwierdzenie; nie ponawiaj tej próby.</p> : <><p>Wynik wysłanej próby jest niepewny. Odczyt historii ani źródła nie zwalnia tej próby. Ponowienie zachowuje dokładne części, wersje, token rezerwacji i klucz.</p><button className="button primary" type="button" disabled={!writable || reading || inFlight} onClick={() => void mutate(retained, true)}>Ponów dokładną próbę przyjęcia</button></>}</div>}
    {visible && source && sourceReply?.available && sourceReply.intake_available && <>
      <p>RMA {source.return_case.number} · zamówienie {source.order.number} · własna sesja kontroli {source.session.id}. Skany, zdjęcia i kontrola pochodzą z zapisanej sesji asystenta.</p>
      {!writable && <p className="notice">Przyjęcie jest dostępne tylko do odczytu.</p>}{writable && !controlled && <p className="notice">Ta kontrola nie ma aktualnej własnej rezerwacji stanowiska. Wznów ją w asystencie; sam odczyt nie rozpoczyna sesji.</p>}
      {locked && !retained && <p className="notice" role="status">{inFlight ? 'Trwa zapis przyjęcia tego użytkownika. Poczekaj na jego wynik.' : 'Inna sprawa tego użytkownika ma niepewny wynik przyjęcia. Najpierw wróć do tej sprawy.'}</p>}
      {source.planner_source.lines.map(l => <p key={l.item_id}>Kontrola pozycji {l.ordinal + 1}: {l.scanned_quantity} / {l.requested} szt. · oryginalna pozycja {l.item_id}</p>)}
      <ReturnDestinationPartsEditor key={binding} returnId={props.returnId} currency={source.planner_source.currency} lines={lines} statuses={statuses} warehouses={warehouses} value={draft.parts} retiredPartIds={draft.retired} readOnly={Boolean(freshBlocked)} onValidityChange={v => setValidParts(v.valid)} onChange={(parts, change) => { if (freshBlocked) return; invalidateOutcome(); setDraft(v => ({ ...v, parts, retired: [...new Set([...v.retired, ...change.retired_part_ids])], locations: [], picks: [] })); setPreview(null); setOperation(null); setConsent(false); }}/>
      <h4>Lokalizacje i źródłowe wydania</h4><p>{source.planner_source.wms.enabled ? 'WMS włączony: fragmenty obejmują także przyjęcie poza sprzedażą. Limity są wspólne dla wszystkich części.' : 'WMS wyłączony: bez wyboru partii i bez tworzenia znanych kosztów. Lokalizacje i wersje zapasu pozostają wymagane.'}</p>
      <PhysicalChoices arrivals={arrivals} locations={draft.locations} picks={draft.picks} fragments={source.planner_source.wms.issue_fragments} warehouses={warehouses} wms={source.planner_source.wms.enabled} disabled={Boolean(freshBlocked)} onLocations={locations => edit({ locations })} onPicks={picks => edit({ picks })}/>
      {errors.length > 0 && <div className="notice" role="status"><ul>{errors.map(e => <li key={e}>{e}</li>)}</ul></div>}
      <fieldset disabled={Boolean(freshBlocked)}><legend>Opis decyzji</legend><div className="rdi-grid"><label>Notatka przyjęcia<textarea aria-label="Notatka przyjęcia" minLength={3} maxLength={2000} value={draft.note} onChange={e => edit({ note: e.target.value })}/></label><label>Uznanie dostawy w groszach ({source.planner_source.currency})<input aria-label="Uznanie dostawy w groszach" type="number" min={0} max={source.planner_source.requested_shipping_refund} step={1} value={draft.shipping} onChange={e => edit({ shipping: e.target.value })}/></label></div><button className="button primary" type="button" disabled={!validParts || errors.length > 0} onClick={prepare}>Przygotuj pełny podgląd przyjęcia</button></fieldset>
    </>}
    {visible && preview && <div className="rdi-review"><h4>Pełny zapisany podgląd przyjęcia</h4><p>Podgląd {preview.id} · ważny do {date(preview.expires_at)}</p><PlanReview snapshot={preview.snapshot} summary={preview.summary}/><label className="rdi-check"><input type="checkbox" checked={consent} disabled={Boolean(freshBlocked || !preview.can_receive || preview.operation_id || Date.parse(preview.expires_at) <= Date.now())} onChange={e => setConsent(e.target.checked)}/>Sprawdziłem wszystkie części, magazyny, lokalizacje i źródłowe wydania. Potwierdzam jeden zapis przyjęcia.</label><button className="button primary" type="button" disabled={Boolean(freshBlocked || !consent || !preview.can_receive || preview.operation_id || Date.parse(preview.expires_at) <= Date.now())} onClick={() => void mutate({ context: scope, returnId: props.returnId, orderId: props.orderId, sessionId: props.sessionId, kind: 'receive', path: `${base}/previews/${preview.id}/receive`, body: JSON.stringify({ client_key: crypto.randomUUID(), scope_hash: preview.scope_hash, confirmed: true, lease_token: props.leaseToken }), preview: structuredClone(preview) })}>Zatwierdź przyjęcie do wybranych magazynów</button></div>}
    {visible && operation && <div className="rdi-review"><h4>Przyjęcie zapisane</h4><p>Operacja {operation.id} · {date(operation.created_at)} · stan RMA: {operation.result.state} · wersja {operation.result.version}</p><p>Rzeczywista kwota uznania: {money(operation.result.refund_amount, operation.snapshot.plan.currency)}. Wynik nie oznacza wypłaty pieniędzy.</p><PlanReview snapshot={operation.snapshot} summary={operation.summary}/></div>}
    {visible && history.length > 0 && <div><h4>Historia zapisanych przyjęć</h4><ul className="rdi-history">{history.map(h => <li key={h.id}>{date(h.created_at)} · operacja {h.id} <button className="button" type="button" disabled={reading || inFlight} onClick={() => void read<Reply>(`${base}/operations/${h.id}`, d => { if (!d.operation) throw Error('Brak pełnego zapisanego przyjęcia.'); checkOperation(d.operation, props); if (d.operation.id !== h.id || d.operation.preview_id !== h.preview_id || d.operation.scope_hash !== h.scope_hash) throw Error('Odczytano inne przyjęcie.'); setOperation(d.operation); setPreview(null); setConsent(false); })}>Otwórz pełne przyjęcie {h.id}</button></li>)}</ul></div>}
    {visible && cursor && <button className="button" type="button" disabled={reading || inFlight} onClick={() => loadHistory(true)}>Dalsza historia przyjęcia</button>}
  </div></section>;
}
