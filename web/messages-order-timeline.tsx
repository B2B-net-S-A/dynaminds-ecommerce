import { useEffect, useRef, useState } from 'react';
import './messages.css';
import { api, date } from './api';

type Entry = {
  id: string;
  channel: 'email' | 'sms' | 'portal';
  direction: 'in' | 'out' | 'internal';
  state: string;
  order_id: string;
  order_number: string | null;
  at: string;
  title: string | null;
  body: string | null;
  party: string | null;
};
type Timeline = {
  order: { id: string; number: string };
  scope: 'order' | 'customer';
  customer: { email_known: boolean; orders: { id: string; number: string; status: string }[]; order_limit: number };
  portal_available: boolean;
  private_visible: boolean;
  data: Entry[];
  meta: { cursor: string | null };
};
const states: Record<string, string> = {
  queued: 'W kolejce',
  simulated: 'Symulacja lokalna',
  smtp_accepted: 'Przyjęta przez SMTP',
  tested: 'Test SMSAPI',
  submitted: 'Przyjęta przez SMSAPI',
  uncertain: 'Wynik niepewny',
  failed: 'Błąd',
  cancelled: 'Anulowano',
};
function ordersLabel(n: number) {
  const tens = n % 100, units = n % 10;
  return n + (n === 1 ? ' zamówienie' : units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? ' zamówienia' : ' zamówień');
}
function label(e: Entry) {
  if (e.channel === 'portal')
    return e.state === 'buyer'
      ? 'Portal · wiadomość kupującego'
      : e.state === 'reply'
        ? 'Portal · odpowiedź sprzedawcy'
        : 'Notatka prywatna';
  if (e.channel === 'email') return e.direction === 'in' ? 'Email przychodzący' : 'Email wysłany';
  return 'SMS';
}

/** Order card: one timeline of email, SMS and portal messages; optionally all recent orders
 * of the same buyer email. Private notes and inbound email only for current admin/operator. */
export function OrderCommunicationTimeline({ orderId, refresh, onOrder }: { orderId: string; refresh: number; onOrder?: (id: string) => void }) {
  const [scope, setScope] = useState<'order' | 'customer'>('order');
  const [channel, setChannel] = useState('');
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  async function load(cursor?: string | null) {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const t = await api<Timeline>(
        '/orders/' + orderId + '/communication?' +
          new URLSearchParams({ scope, ...(channel ? { channel } : {}), ...(cursor ? { cursor } : {}) }),
      );
      if (current !== generation.current) return;
      setTimeline((prev) => (cursor && prev ? { ...t, data: [...prev.data, ...t.data.filter((e) => !prev.data.some((p) => p.id === e.id))] } : t));
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [orderId, scope, channel, refresh]);
  return (
    <div className="order-communication">
      <div className="sms-controls">
        <label>
          Zakres
          <select aria-label="Zakres historii komunikacji" value={scope} onChange={(e) => setScope(e.target.value as 'order' | 'customer')}>
            <option value="order">To zamówienie</option>
            <option value="customer">Wszystkie zamówienia kupującego</option>
          </select>
        </label>
        <label>
          Kanał
          <select aria-label="Kanał historii komunikacji" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">Wszystkie kanały</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="portal">Portal zamówienia</option>
          </select>
        </label>
        <button type="button" className="button" disabled={busy} onClick={() => void load()}>
          Odśwież historię
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {timeline?.scope === 'customer' && (
        <p className="muted">
          {timeline.customer.email_known
            ? 'Kupujący (ten sam adres email): ' +
              ordersLabel(timeline.customer.orders.length) +
              (timeline.customer.orders.length >= timeline.customer.order_limit
                ? ' — pokazano ' + timeline.customer.order_limit + ' najnowszych.'
                : '.')
            : 'Zamówienie nie ma adresu email — historia obejmuje tylko to zamówienie.'}
        </p>
      )}
      {timeline && !timeline.private_visible && timeline.portal_available && (
        <p className="muted">Notatki prywatne i odebrane emaile widzi administrator lub operator.</p>
      )}
      <ol className="communication-timeline">
        {timeline?.data.map((e) => (
          <li key={e.channel + e.id} className={'communication-entry communication-' + e.channel + ' communication-' + e.direction}>
            <div>
              <strong>{label(e)}</strong> <time dateTime={e.at}>{date(e.at)}</time>
              {e.channel !== 'portal' && states[e.state] && <span className="tag-pill">{states[e.state]}</span>}
              {timeline.scope === 'customer' && e.order_number && (
                onOrder && e.order_id !== orderId ? (
                  <button type="button" className="button small" onClick={() => onOrder(e.order_id)}>
                    {e.order_number}
                  </button>
                ) : (
                  <small className="cell-sub">{e.order_number}</small>
                )
              )}
            </div>
            {(e.party || e.title) && (
              <small>
                {e.party ? (e.direction === 'out' ? 'Do: ' : 'Od: ') + e.party : ''}
                {e.party && e.title ? ' · ' : ''}
                {e.title}
              </small>
            )}
            <p className="sms-text">{e.body || '(brak treści)'}</p>
          </li>
        ))}
      </ol>
      {timeline && !timeline.data.length && <p className="muted">Brak wiadomości w tym zakresie.</p>}
      {timeline?.meta.cursor && (
        <button type="button" className="button" disabled={busy} onClick={() => void load(timeline.meta.cursor)}>
          Starsze wiadomości
        </button>
      )}
    </div>
  );
}
