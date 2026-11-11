import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { api } from './api';
import './automation-v2-notifications.css';

/** One in-app notification of the automation effect "Powiadom zespół" (server/automation-v2-notifications.ts). */
export interface AutomationNotification {
  id: string;
  created_at: string;
  rule_name: string;
  order_id: string | null;
  order_number: string | null;
  message: string;
  read: boolean;
  /** Effect "Połącz zamówienia": the proposed orders, merged by an administrator in the merge panel. */
  merge_order_ids?: string[] | null;
}
interface NotificationList {
  unread: number;
  data: AutomationNotification[];
}
interface Props {
  /** Opens the order card; when absent the order number is plain text. */
  onOpenOrder?: (orderId: string) => void;
  /** Opens the order list with these orders selected in the merge panel; when absent no merge button. */
  onOpenMerge?: (orderIds: string[]) => void;
}
const BASE = '/automations/v2/notifications';
const when = (iso: string) => new Date(iso).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });

/** Topbar bell with the unread count; the list opens on click. Refreshes on open and every minute. */
export function AutomationNotifications({ onOpenOrder, onOpenMerge }: Props) {
  const [list, setList] = useState<NotificationList>({ unread: 0, data: [] });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setList(await api<NotificationList>(BASE));
      setError('');
    } catch {
      setError('Nie udało się wczytać powiadomień');
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => clearInterval(timer);
  }, [load]);
  const markRead = async (n: AutomationNotification) => {
    if (n.read) return;
    try {
      const r = await api<{ unread: number }>(`${BASE}/${n.id}/read`, 'POST', {});
      setList((l) => ({ unread: r.unread, data: l.data.map((x) => (x.id === n.id ? { ...x, read: true } : x)) }));
    } catch {
      setError('Nie udało się oznaczyć powiadomienia');
    }
  };
  const markAll = async () => {
    try {
      await api(`${BASE}/read-all`, 'POST', {});
      setList((l) => ({ unread: 0, data: l.data.map((x) => ({ ...x, read: true })) }));
    } catch {
      setError('Nie udało się oznaczyć powiadomień');
    }
  };
  return (
    <div className="av2-notify">
      <button
        type="button"
        className="av2-notify-bell"
        aria-label={`Powiadomienia automatyzacji${list.unread ? `: ${list.unread} nieprzeczytane` : ''}`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        <Bell size={17} />
        {list.unread > 0 && <span className="av2-notify-count">{list.unread > 99 ? '99+' : list.unread}</span>}
      </button>
      {open && (
        <div className="av2-notify-panel" role="dialog" aria-label="Powiadomienia automatyzacji">
          <div className="av2-notify-head">
            <strong>Powiadomienia</strong>
            <button type="button" className="link" disabled={!list.unread} onClick={() => void markAll()}>
              Oznacz wszystkie jako przeczytane
            </button>
          </div>
          {error && <p className="av2-notify-error">{error}</p>}
          {!list.data.length && !error && <p className="muted">Brak powiadomień z ostatnich 30 dni</p>}
          <ul>
            {list.data.map((n) => (
              <li key={n.id} className={n.read ? 'read' : 'unread'}>
                <button type="button" onClick={() => void markRead(n)} title={n.read ? 'Przeczytane' : 'Oznacz jako przeczytane'}>
                  <span className="av2-notify-message">{n.message}</span>
                  <small>
                    {n.rule_name} · {when(n.created_at)}
                  </small>
                </button>
                {n.order_id && n.order_number && (
                  onOpenOrder ? (
                    <button type="button" className="link" onClick={() => { void markRead(n); onOpenOrder(n.order_id!); setOpen(false); }}>
                      Zamówienie {n.order_number}
                    </button>
                  ) : (
                    <small>Zamówienie {n.order_number}</small>
                  )
                )}
                {onOpenMerge && (n.merge_order_ids?.length ?? 0) > 1 && (
                  <button type="button" className="link" onClick={() => { void markRead(n); onOpenMerge(n.merge_order_ids!); setOpen(false); }}>
                    Otwórz łączenie zamówień
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
