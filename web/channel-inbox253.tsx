// COM-008 (migration 245): marketplace and helpdesk conversations in the customer inbox.
// Threads may have no order (questions before a purchase). Replies are recorded as intents: no connector sends them
// yet, which the UI says next to every pending reply.
import { useEffect, useState, type FormEvent } from 'react';
import { Inbox, RefreshCw } from 'lucide-react';
import { api, date } from './api';
import { CHANNELS } from '../server/channel-inbox253-input';
import { channelLabel, pendingRepliesLabel } from './s5comm253-labels';

export interface ChannelThreadRow {
  id: string;
  channel: string;
  connection_name: string;
  subject: string;
  buyer_ref: string;
  order_id: string | null;
  order_number: string | null;
  status: string;
  assigned_name: string | null;
  message_count: number;
  pending_replies: number;
  last_message_at: string;
  version?: number;
  assigned_user_id?: string | null;
}
interface ChannelMessage {
  id: string;
  kind: 'inbound' | 'reply' | 'note';
  state: string;
  body: string;
  created_at: string;
  sent_at: string | null;
  actor_name: string | null;
}
interface ListProps {
  threads: ChannelThreadRow[];
  selected: string | null;
  onSelect: (id: string) => void;
}
export function ChannelThreadList({ threads, selected, onSelect }: ListProps) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Kanał</th>
            <th>Temat / kupujący</th>
            <th>Zamówienie</th>
            <th>Status</th>
            <th>Ostatnia wiadomość</th>
          </tr>
        </thead>
        <tbody>
          {threads.map((t) => (
            <tr key={t.id} className={selected === t.id ? 'selected' : undefined} aria-current={selected === t.id ? 'true' : undefined}>
              <td>
                <span className="badge">{channelLabel(t.channel)}</span>
                <small>{t.connection_name}</small>
              </td>
              <td>
                <button className="text-button" onClick={() => onSelect(t.id)}>
                  {t.subject || 'Bez tematu'}
                </button>
                <small>{t.buyer_ref || 'Kupujący nieznany'}</small>
              </td>
              <td>{t.order_number ?? <span className="muted">Bez zamówienia</span>}</td>
              <td>
                {t.status === 'open' ? 'Otwarta' : 'Zamknięta'}
                <small>{t.assigned_name ? 'Opiekun: ' + t.assigned_name : 'Bez opiekuna'}</small>
                {t.pending_replies > 0 && <small className="notice">{pendingRepliesLabel(t.pending_replies)}</small>}
              </td>
              <td>
                {date(t.last_message_at)}
                <small>{t.message_count} wiadomości</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface InboxView {
  available: boolean;
  connections: { id: string; channel: string; name: string; enabled: boolean }[];
  can_write: boolean;
  can_manage: boolean;
}
export function ChannelInbox({ readOnly, onOrder }: { readOnly: boolean; onOrder: (id: string) => void }) {
  const [inbox, setInbox] = useState<InboxView | null>(null),
    [threads, setThreads] = useState<ChannelThreadRow[]>([]),
    [filters, setFilters] = useState({ channel: '', status: 'open', unlinked: false }),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = async () => {
    setError('');
    try {
      const v = await api<InboxView>('/channel-inbox');
      setInbox(v);
      if (!v.available) return;
      const q = new URLSearchParams();
      if (filters.channel) q.set('channel', filters.channel);
      if (filters.status) q.set('status', filters.status);
      if (filters.unlinked) q.set('unlinked', '1');
      setThreads((await api('/channel-inbox/threads?' + q.toString())).data);
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, [filters.channel, filters.status, filters.unlinked]);
  async function addConnection(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), form = e.currentTarget;
    setBusy(true);
    try {
      await api('/channel-inbox/connections', 'POST', { channel: String(f.get('channel')), name: String(f.get('name') ?? '').trim() });
      form.reset();
      await load();
    } catch (x: any) {
      setError(x.message);
    } finally {
      setBusy(false);
    }
  }
  if (!inbox) return error ? <p className="notice error" role="alert">{error}</p> : null;
  if (!inbox.available) return null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2><Inbox size={18} /> Marketplace i helpdesk</h2>
        <button className="button" onClick={load} disabled={busy}><RefreshCw size={16} /> Odśwież</button>
      </div>
      <div className="shipping-body">
        <p className="muted">
          Rozmowy z Allegro, eBay, Amazon i helpdesku w jednej skrzynce. Rozmowa nie musi mieć zamówienia (pytania przed zakupem).
          Wiadomości trafiają tu przez port konektora; odpowiedzi są zapisywane i czekają, aż konektor kanału je wyśle.
        </p>
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="customer-message-filters">
          <label>
            Kanał
            <select value={filters.channel} onChange={(e) => setFilters({ ...filters, channel: e.target.value })}>
              <option value="">Wszystkie kanały</option>
              {CHANNELS.map((c) => <option key={c} value={c}>{channelLabel(c)}</option>)}
            </select>
          </label>
          <label>
            Status
            <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="open">Otwarte</option>
              <option value="closed">Zamknięte</option>
              <option value="">Wszystkie</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={filters.unlinked} onChange={(e) => setFilters({ ...filters, unlinked: e.target.checked })} /> Tylko bez zamówienia
          </label>
        </div>
        {threads.length ? <ChannelThreadList threads={threads} selected={selected} onSelect={setSelected} /> : <p className="empty">Brak rozmów dla wybranych filtrów.</p>}
        {selected && <ChannelThread key={selected} id={selected} readOnly={readOnly} onChanged={load} onOrder={onOrder} />}
        {inbox.can_manage && (
          <details>
            <summary>Połączenia kanałów ({inbox.connections.length})</summary>
            <ul>
              {inbox.connections.map((c) => (
                <li key={c.id}>{channelLabel(c.channel)} · {c.name} {c.enabled ? '' : '(wyłączone)'} <small className="muted">ID: {c.id}</small></li>
              ))}
            </ul>
            <form onSubmit={addConnection} className="payment-form">
              <label>Kanał<select name="channel">{CHANNELS.map((c) => <option key={c} value={c}>{channelLabel(c)}</option>)}</select></label>
              <label>Nazwa połączenia<input name="name" minLength={2} maxLength={120} required disabled={readOnly} /></label>
              <button className="button" disabled={busy || readOnly}>Dodaj połączenie</button>
            </form>
          </details>
        )}
      </div>
    </section>
  );
}

function ChannelThread({ id, readOnly, onChanged, onOrder }: { id: string; readOnly: boolean; onChanged: () => void; onOrder: (id: string) => void }) {
  const [d, setD] = useState<{ thread: ChannelThreadRow & { version: number }; messages: ChannelMessage[]; can_write: boolean } | null>(null),
    [people, setPeople] = useState<{ user_id: string; name: string }[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = () => api('/channel-inbox/threads/' + id).then(setD).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api('/customer-messages/assignees').then((r) => setPeople(r.data ?? [])).catch(() => setPeople([]));
  }, [id]);
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      onChanged();
    } catch (x: any) {
      setError(x.message);
    } finally {
      setBusy(false);
    }
  }
  if (!d) return error ? <p className="notice error" role="alert">{error}</p> : <p role="status">Wczytywanie rozmowy…</p>;
  const t = d.thread, can = d.can_write && !readOnly;
  const patch = (body: object) => run(() => api('/channel-inbox/threads/' + id, 'PATCH', { version: t.version, ...body }));
  function send(kind: 'reply' | 'note') {
    return (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget, body = String(new FormData(form).get('body') ?? '').trim();
      if (!body) return;
      run(async () => {
        await api('/channel-inbox/threads/' + id + '/messages', 'POST', { kind, body, client_key: crypto.randomUUID() });
        form.reset();
      });
    };
  }
  function linkOrder(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const n = String(new FormData(e.currentTarget).get('order_number') ?? '').trim();
    if (n) patch({ order_number: n });
  }
  return (
    <article className="customer-thread">
      <h3>{channelLabel(t.channel)} · {t.subject || 'Bez tematu'}</h3>
      <p className="muted">
        {t.buyer_ref || 'Kupujący nieznany'} · {t.connection_name} ·{' '}
        {t.order_id ? <button className="text-button" onClick={() => onOrder(t.order_id!)}>Zamówienie {t.order_number}</button> : 'Bez zamówienia'}
      </p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <ol className="customer-thread-messages">
        {d.messages.map((m) => (
          <li key={m.id} className={'customer-message ' + m.kind}>
            <strong>{m.kind === 'inbound' ? 'Kupujący' : m.kind === 'reply' ? 'Odpowiedź: ' + (m.actor_name ?? '') : 'Notatka prywatna: ' + (m.actor_name ?? '')}</strong>{' '}
            <small>{date(m.sent_at ?? m.created_at)}</small>
            <p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p>
            {m.state === 'pending' && <small className="notice">Nie wysłano: czeka na konektor kanału {channelLabel(t.channel)}.</small>}
          </li>
        ))}
      </ol>
      {can && (
        <div className="toolbar-actions">
          <label>
            Opiekun
            <select value={t.assigned_user_id ?? ''} disabled={busy} onChange={(e) => patch({ assigned_user_id: e.target.value || null })}>
              <option value="">Bez opiekuna</option>
              {people.map((p) => <option key={p.user_id} value={p.user_id}>{p.name}</option>)}
            </select>
          </label>
          <button className="button" disabled={busy} onClick={() => patch({ status: t.status === 'open' ? 'closed' : 'open' })}>
            {t.status === 'open' ? 'Zamknij rozmowę' : 'Otwórz ponownie'}
          </button>
          <form onSubmit={linkOrder}>
            <label>Numer zamówienia<input name="order_number" maxLength={100} placeholder={t.order_number ?? 'np. DE-20261027-…'} /></label>
            <button className="button" disabled={busy}>Powiąż zamówienie</button>
          </form>
          {t.order_id && <button className="button" disabled={busy} onClick={() => patch({ order_id: null })}>Odłącz zamówienie</button>}
        </div>
      )}
      {can && (
        <div className="payment-form">
          <form onSubmit={send('reply')}>
            <label>Odpowiedź do kupującego<textarea name="body" maxLength={4000} rows={3} required /></label>
            <button className="button primary" disabled={busy}>Zapisz odpowiedź</button>
            <small className="muted"> Odpowiedź wyjdzie po podłączeniu konektora kanału; teraz zostaje zapisana w rozmowie.</small>
          </form>
          <form onSubmit={send('note')}>
            <label>Notatka prywatna (tylko dla zespołu)<textarea name="body" maxLength={4000} rows={2} required /></label>
            <button className="button" disabled={busy}>Dodaj notatkę</button>
          </form>
        </div>
      )}
    </article>
  );
}
