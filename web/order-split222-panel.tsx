/** Native 222 order split: choose lines → server preview (exact grosze) →
 * confirmed execute with the preview's scope_hash → link to the child order.
 * Each attempt has its own client_key; an attempt without a definitive answer
 * keeps its body (and key) in sessionStorage, so a retry or "Sprawdź wynik"
 * never creates a second split (same pattern as mobile picking scans). */
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, date, money } from './api';

export type Split222OrderItem = { id: string; name: string; sku?: string | null; quantity: number; price: number; line_total: number };
export type Split222Order = {
  id: string;
  version: string | number;
  status: string;
  currency: string;
  shipping_cost: number;
  total: number;
  items: Split222OrderItem[];
};
export type OrderSplit222PanelProps = {
  order: Split222Order;
  /** tenant:user:role of the current session. */
  contextKey: string;
  /** Detail-level write locks (restore preview, missing write right, other open operations). */
  writeBlocked: boolean;
  onOpenOrder: (id: string) => void;
  onChanged: () => void;
};
type PreviewBody = { client_key: string; items: { item_id: string; quantity: number }[]; shipping_cost_to_child: number };
type ExecuteBody = { client_key: string; scope_hash: string };
type PreviewLine = {
  item_id: string; sku?: string | null; name: string; move_quantity: number; parent_quantity_after: number;
  child_line_total: number; parent_line_total_after: number;
};
type Preview = {
  id: string; scope_hash: string; currency: string; parent_total_before: number; parent_total_after: number; child_total: number;
  child_shipping_cost: number; parent_shipping_cost_after: number; lines: PreviewLine[]; expires_at: string;
};
type Execution = {
  id: string; preview_id: string; parent_order_id: string; child_order_id: string; child_number?: string | null; currency: string;
  parent_total_before: number; parent_total_after: number; child_total: number; child_shipping_cost: number;
  targets: unknown[]; created_at: string;
};
type Flags = { available: boolean; current_role: string; can_split: boolean; read_only: boolean };
type Lineage = Flags & { children: Execution[]; origin: Execution | null };
type Pending = { kind: 'preview'; body: PreviewBody } | { kind: 'execute'; preview: Preview; body: ExecuteBody };

export const SPLIT222_LINE_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const int = (v: unknown) => Number.isSafeInteger(v);

export function split222StorageKey(contextKey: string, orderId: string) {
  const [tenant, user] = contextKey.split(':');
  return 'dyna:order-split222:v1:' + tenant + ':' + user + ':' + orderId;
}
function validPreview(p: any): p is Preview {
  return !!p && typeof p === 'object' && typeof p.id === 'string' && UUID.test(p.id) && typeof p.scope_hash === 'string' &&
    HASH.test(p.scope_hash) && typeof p.currency === 'string' && Array.isArray(p.lines) &&
    ['parent_total_before', 'parent_total_after', 'child_total', 'child_shipping_cost', 'parent_shipping_cost_after'].every((k) => int(p[k]));
}
function validExecution(e: any): e is Execution {
  return !!e && typeof e === 'object' && typeof e.id === 'string' && UUID.test(e.id) && typeof e.child_order_id === 'string' &&
    UUID.test(e.child_order_id) && typeof e.parent_order_id === 'string' && UUID.test(e.parent_order_id) &&
    ['parent_total_after', 'child_total'].every((k) => int(e[k])) && Array.isArray(e.targets);
}
function readPending(key: string): Pending | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (v?.kind === 'preview' && typeof v.body?.client_key === 'string' && UUID.test(v.body.client_key) && Array.isArray(v.body.items)) return v;
    if (v?.kind === 'execute' && validPreview(v.preview) && UUID.test(v.body?.client_key ?? '') && v.body.scope_hash === v.preview.scope_hash) return v;
  } catch {
    /* unreadable storage: no recoverable attempt */
  }
  return null;
}
function writePending(key: string, value: Pending | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable: the attempt is still kept in memory for this view */
  }
}
/** True when an unconfirmed split attempt waits for retry/check (parent opens the panel). */
export function hasPendingSplit222(contextKey: string, orderId: string) {
  return readPending(split222StorageKey(contextKey, orderId)) !== null;
}

/** Złote with at most two decimals ("12,50") → exact grosze, without floats. */
export function parseGrosze(raw: string): number | null {
  const v = raw.trim().replace(/\s/g, '');
  if (v === '') return 0;
  const m = /^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
/** Client-side check of the selection; the server re-validates everything. */
export function validateSplit222Selection(
  order: Pick<Split222Order, 'items' | 'shipping_cost' | 'currency'>,
  quantities: Record<string, string>,
  shipping: string,
): { items: PreviewBody['items']; shipping_cost_to_child: number } | { error: string } {
  const items: PreviewBody['items'] = [];
  for (const i of order.items) {
    const raw = (quantities[i.id] ?? '').trim();
    if (raw === '' || raw === '0') continue;
    const q = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(q) || q < 0 || q > i.quantity)
      return { error: `Ilość w pozycji „${i.name}” musi być liczbą całkowitą od 0 do ${i.quantity}.` };
    if (q > 0) items.push({ item_id: i.id, quantity: q });
  }
  if (!items.length) return { error: 'Wybierz co najmniej jedną pozycję i ilość do przeniesienia.' };
  if (items.length > SPLIT222_LINE_LIMIT) return { error: `Jeden podział może przenieść najwyżej ${SPLIT222_LINE_LIMIT} pozycji.` };
  const whole = new Set(items.filter((x) => x.quantity === order.items.find((i) => i.id === x.item_id)!.quantity).map((x) => x.item_id));
  if (order.items.every((i) => whole.has(i.id)))
    return { error: 'Zamówienie źródłowe musi zachować co najmniej jedną pozycję. Zmniejsz ilość w jednej z linii.' };
  const cost = parseGrosze(shipping);
  if (cost === null) return { error: 'Koszt dostawy podaj w złotych, np. 12,50.' };
  if (cost > order.shipping_cost)
    return { error: `Przenoszona dostawa nie może przekroczyć kosztu dostawy zamówienia (${money(order.shipping_cost, order.currency)}).` };
  return { items, shipping_cost_to_child: cost };
}

/** Definitive server answers roll everything back; network errors and 5xx (except 503) are unknown outcomes. */
export const isUncertainSplit222Error = (e: unknown) => !(e instanceof ApiError) || (e.status >= 500 && e.status !== 503);
export function split222ErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Brak odpowiedzi serwera.';
  if (e.status === 401) return 'Sesja wygasła. Zaloguj się ponownie.';
  if (e.status === 403) return 'Brak uprawnień: podział zamówienia wymaga roli administratora lub operatora.';
  if (e.status === 423) return 'Ta kopia jest tylko do odczytu — podziału nie można wykonać.';
  if (e.status === 503) return 'Podział zamówień jest niedostępny w tej kopii.';
  // 409 refusals (WMS partie, płatności, dokumenty, plan paczek, skany, łączenie, zwroty, zmiany zamówienia)
  // carry the exact Polish reason from the server; nothing was changed.
  if (e.status === 409) return 'Podziału odmówiono: ' + (e.message || 'zamówienie nie spełnia warunków podziału') + '. Nic nie zostało zmienione.';
  return e.message || 'Nie udało się wykonać operacji.';
}

export function OrderSplit222Panel(props: OrderSplit222PanelProps) {
  return <Split222Scope key={props.contextKey + ':' + props.order.id} {...props} />;
}
function Split222Scope({ order, contextKey, writeBlocked, onOpenOrder, onChanged }: OrderSplit222PanelProps) {
  const role = contextKey.split(':')[2];
  const storageKey = split222StorageKey(contextKey, order.id);
  const live = useRef(true),
    flight = useRef(false);
  const [lineage, setLineage] = useState<Lineage | null>(null),
    [hidden, setHidden] = useState(false),
    [loadError, setLoadError] = useState(''),
    [quantities, setQuantities] = useState<Record<string, string>>({}),
    [shipping, setShipping] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState<Pending | null>(() => readPending(storageKey)),
    [result, setResult] = useState<Execution | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const itemsKey = JSON.stringify([order.version, order.items.map((i) => [i.id, i.quantity, i.line_total])]);
  useEffect(() => {
    live.current = true;
    void loadLineage();
    return () => {
      live.current = false;
    };
  }, []);
  // A changed order (also after our own execute) invalidates the selection and any shown preview.
  useEffect(() => {
    setQuantities({});
    setShipping('');
    setPreview(null);
    setConfirmed(false);
  }, [itemsKey]);

  function keepPending(next: Pending | null) {
    writePending(storageKey, next);
    setPending(next);
  }
  async function loadLineage() {
    try {
      const d = await api<Lineage>('/orders/' + order.id + '/splits');
      if (!live.current) return;
      if (d?.available !== true) return setHidden(true);
      if (!Array.isArray(d.children) || !d.children.every(validExecution) || (d.origin !== null && !validExecution(d.origin)))
        throw Error('Nie potwierdzono historii podziału.');
      setLineage(d);
      setLoadError('');
    } catch (e) {
      if (!live.current) return;
      if (e instanceof ApiError && e.status === 503) setHidden(true);
      else setLoadError(e instanceof ApiError ? split222ErrorMessage(e) : 'Nie udało się odczytać historii podziału.');
    }
  }
  async function run(fn: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } finally {
      flight.current = false;
      if (live.current) setBusy(false);
    }
  }
  function sendPreview(body: PreviewBody) {
    return run(async () => {
      keepPending({ kind: 'preview', body });
      setPreview(null);
      setConfirmed(false);
      try {
        const r = await api<{ preview: Preview }>('/orders/' + order.id + '/splits/previews', 'POST', body);
        if (!validPreview(r?.preview)) throw Error('Niekompletny podgląd podziału.');
        if (!live.current) return;
        keepPending(null);
        setPreview(r.preview);
      } catch (e) {
        if (!live.current) return;
        if (isUncertainSplit222Error(e))
          setError('Brak potwierdzenia podglądu (' + (e instanceof Error ? e.message : 'błąd sieci') + '). Ponów — użyjemy tego samego klucza próby.');
        else {
          keepPending(null);
          setError(split222ErrorMessage(e));
        }
      }
    });
  }
  function requestPreview() {
    const v = validateSplit222Selection(order, quantities, shipping);
    if ('error' in v) return setError(v.error);
    // Same selection after a lost response → same client_key (server replays); otherwise a new attempt.
    const prior = pending?.kind === 'preview' ? pending.body : null;
    const same = prior && JSON.stringify([prior.items, prior.shipping_cost_to_child]) === JSON.stringify([v.items, v.shipping_cost_to_child]);
    void sendPreview(same ? prior : { client_key: crypto.randomUUID(), ...v });
  }
  async function finished(e: Execution) {
    keepPending(null);
    setPreview(null);
    setConfirmed(false);
    setResult(e);
    void loadLineage();
    onChanged();
  }
  function sendExecute(p: Preview, body: ExecuteBody) {
    return run(async () => {
      keepPending({ kind: 'execute', preview: p, body });
      try {
        const r = await api<{ execution: Execution }>('/order-splits/' + p.id + '/execute', 'POST', body);
        if (!validExecution(r?.execution)) throw Error('Niekompletny wynik podziału.');
        if (live.current) await finished(r.execution);
      } catch (e) {
        if (!live.current) return;
        if (isUncertainSplit222Error(e))
          setError('Brak potwierdzenia podziału (' + (e instanceof Error ? e.message : 'błąd sieci') +
            '). Ponów ten sam podział albo sprawdź wynik — zamówienie nie zostanie podzielone dwa razy.');
        else {
          keepPending(null);
          if (e instanceof ApiError && e.status === 409) setPreview(null);
          setError(split222ErrorMessage(e));
        }
      }
    });
  }
  function checkExecute(p: Preview) {
    return run(async () => {
      try {
        const d = await api<{ preview: Preview; execution_id: string | null }>('/order-splits/previews/' + p.id);
        if (!live.current) return;
        if (typeof d?.execution_id === 'string' && UUID.test(d.execution_id)) {
          const x = await api<{ execution: Execution }>('/order-splits/executions/' + d.execution_id);
          if (!validExecution(x?.execution)) throw Error('Niekompletny wynik podziału.');
          if (live.current) await finished(x.execution);
        } else setError('Podział nie został jeszcze wykonany. Ponów ten sam podział — użyjemy tego samego klucza.');
      } catch (e) {
        if (live.current) setError(e instanceof ApiError ? split222ErrorMessage(e) : 'Nie udało się sprawdzić wyniku podziału.');
      }
    });
  }

  if (hidden) return null;
  const canSplit = lineage?.can_split === true && !lineage.read_only && role !== 'viewer';
  const statusAllows = ['new', 'paid'].includes(order.status);
  const locked = busy || writeBlocked || !canSplit;
  const executing = pending?.kind === 'execute' ? pending : null;
  const currency = order.currency;
  return (
    <section className="order-merges" aria-label="Podział zamówienia">
      <h3>Podział zamówienia</h3>
      {!lineage && !loadError && <p className="om-hint">Wczytywanie…</p>}
      {loadError && (
        <div className="om-error" role="alert">
          {loadError}{' '}
          <button type="button" className="button" onClick={() => void loadLineage()}>
            Spróbuj ponownie
          </button>
        </div>
      )}
      {lineage?.origin && (
        <p className="om-hint">
          To zamówienie utworzono przez podział.{' '}
          <button type="button" className="button" onClick={() => onOpenOrder(lineage.origin!.parent_order_id)}>
            Otwórz zamówienie źródłowe
          </button>
        </p>
      )}
      {lineage?.read_only && <p className="om-hint">Ta kopia jest tylko do odczytu — podział jest wyłączony.</p>}
      {lineage && !lineage.read_only && !canSplit && (
        <p className="om-hint">Podział może wykonać administrator lub operator.</p>
      )}
      {error && (
        <p className={executing || pending?.kind === 'preview' ? 'om-pending' : 'om-error'} role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="om-status" role="status">
          <p>
            Utworzono nowe zamówienie {result.child_number ?? ''} ({money(result.child_total, result.currency ?? currency)}). W tym zamówieniu
            zostaje {money(result.parent_total_after, result.currency ?? currency)}.
          </p>
          <div className="om-actions">
            <button type="button" className="button primary" onClick={() => onOpenOrder(result.child_order_id)}>
              Otwórz zamówienie {result.child_number ?? 'wynikowe'}
            </button>
            <button type="button" className="button" onClick={() => setResult(null)}>
              Podziel ponownie
            </button>
          </div>
        </div>
      )}
      {canSplit && executing && (
        <div className="om-pending">
          <p>
            Zatwierdzony podział tego zamówienia nie ma jeszcze potwierdzenia (nowe zamówienie{' '}
            {money(executing.preview.child_total, executing.preview.currency)}). Ponowienie używa tego samego klucza.
          </p>
          <div className="om-actions">
            <button type="button" className="button primary" disabled={locked} onClick={() => void sendExecute(executing.preview, executing.body)}>
              Ponów podział
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void checkExecute(executing.preview)}>
              Sprawdź wynik
            </button>
          </div>
        </div>
      )}
      {canSplit && !executing && !result && (
        <>
          {!statusAllows && <p className="om-hint">Podział jest możliwy tylko dla zamówienia nowego lub opłaconego, przed kompletacją.</p>}
          <p className="om-hint">Wybierz pozycje i ilości, które trafią do nowego zamówienia. Kwoty policzy serwer w podglądzie.</p>
          <div className="om-table">
            <table>
              <thead>
                <tr>
                  <th>Pozycja</th>
                  <th>W zamówieniu</th>
                  <th>Wartość</th>
                  <th>Przenieś do nowego</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.name}
                      {i.sku && <small>{i.sku}</small>}
                    </td>
                    <td>{i.quantity}</td>
                    <td>{money(i.line_total, currency)}</td>
                    <td>
                      <input
                        type="number" min={0} max={i.quantity} step={1} inputMode="numeric"
                        aria-label={'Ilość do przeniesienia: ' + i.name}
                        value={quantities[i.id] ?? ''} placeholder="0" disabled={locked || !statusAllows}
                        onChange={(e) => {
                          const value = e.target.value;
                          setQuantities((q) => ({ ...q, [i.id]: value }));
                          setPreview(null);
                          setConfirmed(false);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="om-grid">
            <label>
              Koszt dostawy przenoszony do nowego zamówienia (zł)
              <input
                inputMode="decimal" value={shipping} placeholder="0,00" disabled={locked || !statusAllows}
                onChange={(e) => {
                  setShipping(e.target.value);
                  setPreview(null);
                  setConfirmed(false);
                }}
              />
              <small>Dostawa zamówienia: {money(order.shipping_cost, currency)}</small>
            </label>
          </div>
          <div className="om-actions">
            <button type="button" className="button" disabled={locked || !statusAllows} onClick={requestPreview}>
              {pending?.kind === 'preview' && !preview ? 'Ponów podgląd' : 'Przygotuj podgląd'}
            </button>
          </div>
          {preview && <PreviewView preview={preview} />}
          {preview && (
            <>
              <label className="om-check">
                <input type="checkbox" checked={confirmed} disabled={locked} onChange={(e) => setConfirmed(e.target.checked)} />
                Potwierdzam przeniesienie wybranych pozycji i kwot do nowego zamówienia.
              </label>
              <div className="om-actions">
                <button
                  type="button" className="button primary" disabled={locked || !confirmed}
                  onClick={() => void sendExecute(preview, { client_key: crypto.randomUUID(), scope_hash: preview.scope_hash })}
                >
                  Podziel zamówienie
                </button>
              </div>
            </>
          )}
        </>
      )}
      {busy && <p className="om-hint" role="status">Trwa komunikacja z serwerem…</p>}
      {lineage && lineage.children.length > 0 && (
        <section aria-label="Wykonane podziały">
          <h4>Wykonane podziały</h4>
          <ul className="om-history">
            {lineage.children.map((c) => (
              <li key={c.id}>
                <button type="button" className="button" onClick={() => onOpenOrder(c.child_order_id)}>
                  {c.child_number ?? 'Nowe zamówienie'} · {money(c.child_total, c.currency ?? currency)} · {date(c.created_at)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
function PreviewView({ preview: p }: { preview: Preview }) {
  return (
    <div className="om-card" aria-label="Podgląd podziału">
      <h4>Podgląd podziału</h4>
      <dl className="om-facts">
        <dt>Zamówienie przed podziałem</dt>
        <dd>{money(p.parent_total_before, p.currency)}</dd>
        <dt>Zostaje w tym zamówieniu</dt>
        <dd>
          {money(p.parent_total_after, p.currency)} (dostawa {money(p.parent_shipping_cost_after, p.currency)})
        </dd>
        <dt>Nowe zamówienie</dt>
        <dd>
          {money(p.child_total, p.currency)} (dostawa {money(p.child_shipping_cost, p.currency)})
        </dd>
        <dt>Ważny do</dt>
        <dd>{date(p.expires_at)}</dd>
      </dl>
      <div className="om-table">
        <table>
          <thead>
            <tr>
              <th>Pozycja</th>
              <th>Do nowego</th>
              <th>Wartość w nowym</th>
              <th>Zostaje</th>
              <th>Wartość, która zostaje</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l) => (
              <tr key={l.item_id}>
                <td>
                  {l.name}
                  {l.sku && <small>{l.sku}</small>}
                </td>
                <td>{l.move_quantity}</td>
                <td>{money(l.child_line_total, p.currency)}</td>
                <td>{l.parent_quantity_after}</td>
                <td>{money(l.parent_line_total_after, p.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
