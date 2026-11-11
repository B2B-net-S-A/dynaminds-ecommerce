import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, MessagesSquare, RefreshCw } from 'lucide-react';
import { api, ApiError, date } from './api';
import './customer-messages.css';
import { PortalReplyNotify } from './portal-reply-notify';

type MessageKind = 'buyer' | 'reply' | 'note' | 'email';
type Message = {
  id: string;
  kind: MessageKind;
  body: string;
  created_at: string;
  author_name?: string | null;
  email?: { message_id: string; from: { name: string; address: string }; subject: string; account_id?: string; raw_sha256?: string } | null;
};
type Permissions = {
  available: boolean;
  read_only: boolean;
  can_reply: boolean;
  can_note: boolean;
  can_status: boolean;
  can_assign?: boolean;
  workflow_available?: boolean;
  current_role?: string;
};
type Thread = {
  id: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  status: 'open' | 'closed';
  assigned_user_id?: string | null;
  assigned_user_name?: string | null;
  version?: number;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  last_public_message_at: string;
  message_count: number;
  public_message_count: number;
};
type ThreadList = Permissions & { data: Thread[]; meta: { cursor: string | null } };
type ThreadDetail = Permissions & Thread & { data: Message[]; meta: { cursor: string | null } };
type Assignee = { user_id: string; name: string; role: 'admin' | 'operator' };
type AssigneeList = Permissions & { data: Assignee[]; meta: { cursor: string | null } };
type Draft = { body: string; clientKey: string; attemptedBody: string | null };
type DraftCache = Map<string, Draft>;
const newDraft = (): Draft => ({ body: '', clientKey: crypto.randomUUID(), attemptedBody: null });
const messageNames: Record<MessageKind, string> = {
  buyer: 'Kupujący',
  reply: 'Odpowiedź w portalu',
  note: 'Notatka prywatna',
  email: 'Wiadomość email — dla pracowników',
};
function mergeRows<T extends { id: string }>(current: T[], incoming: T[]) {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...incoming.filter((r) => !seen.has(r.id))];
}
function canReadPrivate(d: { current_role?: string; can_note: boolean }) {
  return d.current_role ? ['admin', 'operator'].includes(d.current_role) : d.can_note;
}
function withoutPrivate(d: ThreadDetail): ThreadDetail {
  return {
    ...d,
    can_reply: false,
    can_note: false,
    can_status: false,
    can_assign: false,
    assigned_user_id: undefined,
    assigned_user_name: undefined,
    data: d.data.filter((m) => m.kind !== 'note' && m.kind !== 'email'),
  };
}

export function CustomerMessages({
  write,
  readOnly,
  refresh,
  onOrder,
  externalWriteBlocked = false,
  focusThreadId,
  focusToken,
  onEmail,
}: {
  write: boolean;
  readOnly: boolean;
  refresh: number;
  onOrder: (id: string) => void;
  externalWriteBlocked?: boolean;
  focusThreadId?: string;
  focusToken?: number;
  onEmail?: (messageId: string) => void;
}) {
  const [status, setStatus] = useState('open');
  const [orderId, setOrderId] = useState('');
  const [orderSearch, setOrderSearch] = useState('');
  const [orders, setOrders] = useState<{ id: string; number: string; customer_name: string }[]>([]);
  const [finding, setFinding] = useState(false);
  const [list, setList] = useState<ThreadList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [accessRole, setAccessRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [local, setLocal] = useState(0);
  const drafts = useRef<DraftCache>(new Map());
  const generation = useRef(0);
  const orderGeneration = useRef(0);
  const selectedOrderId = useRef(orderId);
  selectedOrderId.current = orderId;
  useEffect(() => { if (focusThreadId && /^[a-f0-9-]{36}$/i.test(focusThreadId)) setSelected(focusThreadId); }, [focusThreadId, focusToken]);
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (orderId) params.set('order_id', orderId);
  const path = '/customer-messages?' + params.toString();
  function accessFailure(e: unknown) {
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      drafts.current.clear();
      ++orderGeneration.current;
      setOrders([]);
      setOrderSearch('');
      setSelected(null);
      setList(null);
    }
    setError((e as Error).message);
  }
  const identity = useRef('');
  identity.current = path + ':' + refresh + ':' + local;

  useEffect(() => {
    const current = ++generation.current;
    let alive = true;
    setBusy(true);
    setError('');
    setList(null);
    api<ThreadList>(path)
      .then((d) => {
        if (alive && generation.current === current) {
          setList(d);
          setAccessRole(d.current_role ?? '');
          if (!canReadPrivate(d)) {
            for (const key of drafts.current.keys())
              if (key.endsWith('/note')) drafts.current.delete(key);
          }
          if (!d.available) setSelected(null);
        }
      })
      .catch((e) => alive && generation.current === current && accessFailure(e))
      .finally(() => alive && generation.current === current && setBusy(false));
    return () => {
      alive = false;
    };
  }, [path, refresh, local]);

  async function more() {
    if (!list?.meta.cursor || busy) return;
    const current = identity.current;
    setBusy(true);
    setError('');
    try {
      const d = await api<ThreadList>(path + '&cursor=' + encodeURIComponent(list.meta.cursor));
      if (current !== identity.current) return;
      setAccessRole(d.current_role ?? '');
      setList((prev) => ({
        ...d,
        data: mergeRows(
          prev && prev.current_role === d.current_role && prev.can_note === d.can_note
            ? prev.data
            : [],
          d.data,
        ),
      }));
    } catch (e) {
      if (current === identity.current) accessFailure(e);
    } finally {
      if (current === identity.current) setBusy(false);
    }
  }

  async function findOrder(e: FormEvent) {
    e.preventDefault();
    const current = ++orderGeneration.current;
    setFinding(true);
    setError('');
    try {
      const d = await api<{ data: typeof orders; meta: { cursor: string | null } }>(
        '/orders?' + new URLSearchParams({ search: orderSearch.trim(), limit: '25' }),
      );
      if (current === orderGeneration.current)
        setOrders((previous) =>
          mergeRows(
            previous.filter((o) => o.id === selectedOrderId.current),
            d.data,
          ),
        );
    } catch (e) {
      if (current === orderGeneration.current) accessFailure(e);
    } finally {
      if (current === orderGeneration.current) setFinding(false);
    }
  }

  return (
    <div className="customer-messages">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              <MessagesSquare size={20} /> Wiadomości klientów
            </h2>
            <p>
              Rozmowy zamówień. Odpowiedź portalowa jest widoczna dla kupującego; email pozostaje osobnym kanałem.
            </p>
          </div>
          <button className="button" disabled={busy} onClick={() => setLocal((n) => n + 1)}>
            <RefreshCw size={16} /> Odśwież listę
          </button>
        </div>
        <div className="customer-messages-body">
          <p className="notice">
            Zapis odpowiedzi w tym module nie wysyła emaila ani SMS. Notatki prywatne są widoczne
            wyłącznie dla uprawnionych pracowników.
          </p>
          {externalWriteBlocked && <p className="notice">Trwa potwierdzanie operacji skrzynki email. Świeże zapisy rozmowy są wstrzymane; własną dokładną próbę można ponowić.</p>}
          {(readOnly || list?.read_only) && (
            <p className="notice">
              Podgląd kopii — zapis wiadomości i zmiana statusu są wyłączone.
            </p>
          )}
          {list && !list.available && (
            <p className="notice">Ta kopia nie zawiera modułu wiadomości klientów.</p>
          )}
          <div className="customer-message-filters">
            <label>
              Status rozmowy
              <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={busy}>
                <option value="open">Otwarte</option>
                <option value="closed">Zamknięte</option>
                <option value="">Wszystkie</option>
              </select>
            </label>
            <form onSubmit={findOrder}>
              <label>
                Wyszukaj zamówienie
                <input
                  value={orderSearch}
                  onChange={(e) => setOrderSearch(e.target.value)}
                  maxLength={100}
                  placeholder="Numer zamówienia lub klient"
                />
              </label>
              <button className="button" disabled={finding}>
                Wyszukaj
              </button>
            </form>
            <label>
              Rozmowy do zamówienia
              <select value={orderId} onChange={(e) => setOrderId(e.target.value)} disabled={busy}>
                <option value="">Wszystkie zamówienia</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.number} · {o.customer_name}
                  </option>
                ))}
              </select>
              <small>
                Wyszukiwanie pokazuje do 25 zamówień. Zawęź wyszukiwanie, jeśli nie ma właściwej
                pozycji.
              </small>
            </label>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {busy && !list && <p role="status">Wczytywanie rozmów…</p>}
          {list?.available && (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Zamówienie / klient</th>
                      <th>Status</th>
                      <th>Ostatnia wiadomość</th>
                      <th>Historia</th>
                      <th>Obsługa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.map((t) => (
                      <tr key={t.id} className={selected === t.id ? 'selected' : undefined}>
                        <td>
                          <strong>{t.order_number}</strong>
                          <small>{t.customer_name}</small>
                        </td>
                        <td>
                          {t.status === 'open' ? 'Otwarta' : 'Zamknięta'}
                          {['admin', 'operator'].includes(list.current_role ?? '') &&
                            t.assigned_user_name !== undefined && (
                              <small className="customer-message-assignment-name">
                                {t.assigned_user_name
                                  ? 'Opiekun: ' + t.assigned_user_name
                                  : 'Bez opiekuna'}
                              </small>
                            )}
                        </td>
                        <td>
                          {date(
                            canReadPrivate(list) ? t.last_message_at : t.last_public_message_at,
                          )}
                        </td>
                        <td>
                          {canReadPrivate(list) ? t.message_count : t.public_message_count}{' '}
                          wiadomości
                        </td>
                        <td>
                          <button className="button" onClick={() => setSelected(t.id)}>
                            Otwórz rozmowę <ArrowRight size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!list.data.length && (
                <p className="empty">
                  Brak rozmów dla wybranych filtrów. Rozmowa powstaje po pierwszej wiadomości
                  kupującego w portalu lub po przypisaniu emaila do zamówienia.
                </p>
              )}
              {list.meta.cursor && (
                <button className="button" onClick={more} disabled={busy}>
                  Starsze rozmowy
                </button>
              )}
            </>
          )}
        </div>
      </section>
      {selected && (
        <CustomerThread
          key={selected + ':' + accessRole}
          id={selected}
          write={write}
          readOnly={readOnly}
          refresh={refresh}
          drafts={drafts.current}
          onOrder={onOrder}
          externalWriteBlocked={externalWriteBlocked}
          onEmail={onEmail}
          onChanged={() => setLocal((n) => n + 1)}
          onDenied={accessFailure}
        />
      )}
    </div>
  );
}

function CustomerThread({
  id,
  write,
  readOnly,
  refresh,
  drafts,
  onOrder,
  onChanged,
  onDenied,
  externalWriteBlocked,
  onEmail,
}: {
  id: string;
  write: boolean;
  readOnly: boolean;
  refresh: number;
  drafts: DraftCache;
  onOrder: (id: string) => void;
  onChanged: () => void;
  onDenied: (e: unknown) => void;
  externalWriteBlocked: boolean;
  onEmail?: (messageId: string) => void;
}) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const busy = loading || mutating;
  const mutationInFlight = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [draft, setDraftState] = useState(() => drafts.get(id + '/reply') ?? newDraft());
  const [reviewed, setReviewed] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [versionBlocked, setVersionBlocked] = useState(false);
  const [assignees, setAssignees] = useState<AssigneeList | null>(null);
  const [assigneeBusy, setAssigneeBusy] = useState(false);
  const [assigneeId, setAssigneeId] = useState('');
  const assigneeGeneration = useRef(0);
  const generation = useRef(0);
  const alive = useRef(true);
  const draftKey = id + '/' + mode;
  function setDraft(next: Draft) {
    drafts.set(draftKey, next);
    setDraftState(next);
  }
  function changeMode(next: 'reply' | 'note') {
    drafts.set(draftKey, draft);
    setMode(next);
    setDraftState(drafts.get(id + '/' + next) ?? newDraft());
    setReviewed(false);
    setError('');
    setNotice('');
  }
  async function load(cursor?: string | null) {
    const current = ++generation.current;
    setLoading(true);
    try {
      const d = await api<ThreadDetail>(
        '/customer-messages/' + id + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      );
      if (!alive.current || current !== generation.current) return;
      setDetail((previous) => ({
        ...d,
        data: (cursor &&
        previous &&
        previous.current_role === d.current_role &&
        previous.can_note === d.can_note
          ? mergeRows(previous.data, d.data)
          : d.data
        )
          .filter((m) => canReadPrivate(d) || (m.kind !== 'note' && m.kind !== 'email'))
          .map((m) => (canReadPrivate(d) ? m : { ...m, author_name: null })),
      }));
      setBlocked(false);
      setVersionBlocked(false);
      setAssigneeId(d.assigned_user_id ?? '');
      if (!canReadPrivate(d)) {
        drafts.delete(id + '/note');
        setReviewed(false);
      }
      if (!d.can_note && mode === 'note') {
        setMode('reply');
        setDraftState(drafts.get(id + '/reply') ?? newDraft());
      }
      if (!d.can_note) onChanged();
    } catch (e) {
      if (alive.current && current === generation.current) handleFailure(e);
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      ++generation.current;
      ++assigneeGeneration.current;
    };
  }, [id, refresh]);
  const permitted = write && !readOnly && !!detail?.available && !detail.read_only && !blocked;
  async function loadAssignees(cursor?: string | null) {
    if (!permitted || !detail?.can_assign) return;
    const current = ++assigneeGeneration.current;
    setAssigneeBusy(true);
    try {
      const d = await api<AssigneeList>(
        '/customer-messages/assignees' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      );
      if (!alive.current || current !== assigneeGeneration.current) return;
      setAssignees((prev) => ({
        ...d,
        data: cursor
          ? [
              ...(prev?.data ?? []),
              ...d.data.filter((a) => !prev?.data.some((old) => old.user_id === a.user_id)),
            ]
          : d.data,
      }));
      if (!d.can_assign) setAssigneeId('');
    } catch (e) {
      if (alive.current && current === assigneeGeneration.current) handleFailure(e);
    } finally {
      if (alive.current && current === assigneeGeneration.current) setAssigneeBusy(false);
    }
  }
  useEffect(() => {
    if (permitted && detail?.can_assign) void loadAssignees();
    else {
      setAssignees(null);
      ++assigneeGeneration.current;
    }
  }, [permitted, detail?.can_assign, refresh]);
  const canWrite = permitted && (!externalWriteBlocked || draft.attemptedBody !== null) && (mode === 'reply' ? detail.can_reply : detail.can_note);
  const text = (draft.attemptedBody ?? draft.body).trim();
  const visible =
    detail?.data
      .filter((m) => !['note', 'email'].includes(m.kind) || (canReadPrivate(detail) && !blocked))
      .slice()
      .reverse() ?? [];
  function handleFailure(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      drafts.clear();
      ++assigneeGeneration.current;
      setAssignees(null);
      setAssigneeId('');
      setDraftState(newDraft());
      setReviewed(false);
      setDetail(null);
      setBlocked(true);
      ++generation.current;
      onDenied(e);
      return;
    }
    if (e instanceof ApiError && [423, 503].includes(e.status)) {
      ++generation.current;
      setLoading(false);
      setBlocked(e.status !== 423);
      setDetail((d) =>
        d
          ? e.status === 423
            ? {
                ...d,
                read_only: true,
                can_reply: false,
                can_note: false,
                can_status: false,
                can_assign: false,
              }
            : withoutPrivate(d)
          : d,
      );
      onChanged();
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy || mutationInFlight.current || !canWrite || !reviewed || !text || text.length > 4000)
      return;
    const sent = { ...draft, body: text, attemptedBody: text };
    const sentKey = draftKey;
    const sentMode = mode;
    setDraft(sent);
    mutationInFlight.current = true;
    setMutating(true);
    setError('');
    setNotice('');
    try {
      await api('/customer-messages/' + id + '/' + sentMode, 'POST', {
        client_key: sent.clientKey,
        body: sent.attemptedBody,
      });
      const cleared = newDraft();
      drafts.set(sentKey, cleared);
      if (!alive.current) return;
      setDraftState(cleared);
      setReviewed(false);
      setNotice(
        sentMode === 'reply'
          ? 'Odpowiedź zapisano w portalu kupującego. Nie wysłano emaila ani SMS — powiadomienie możesz przygotować poniżej.'
          : 'Zapisano prywatną notatkę. Kupujący jej nie widzi.',
      );
      onChanged();
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const editable = { ...sent, attemptedBody: null };
        if (alive.current) {
          drafts.set(sentKey, editable);
          setDraftState(editable);
          setReviewed(false);
        }
      }
      if (alive.current) handleFailure(e);
    } finally {
      mutationInFlight.current = false;
      if (alive.current) setMutating(false);
    }
  }
  async function changeStatus() {
    if (
      busy ||
      mutationInFlight.current ||
      !permitted ||
      externalWriteBlocked ||
      versionBlocked ||
      !detail?.can_status ||
      !Number.isInteger(detail.version)
    )
      return;
    mutationInFlight.current = true;
    setMutating(true);
    setError('');
    setNotice('');
    try {
      const d = await api<ThreadDetail>('/customer-messages/' + id, 'PATCH', {
        status: detail.status === 'open' ? 'closed' : 'open',
        version: detail.version,
      });
      if (!alive.current) return;
      ++generation.current;
      setLoading(false);
      setDetail(d);
      setNotice('Zapisano status rozmowy. Nowa wiadomość kupującego ponownie otworzy rozmowę.');
      onChanged();
    } catch (e) {
      if (alive.current) {
        handleFailure(e);
        setVersionBlocked(true);
        if (e instanceof ApiError && e.status === 409)
          setError(
            'Rozmowa zmieniła się w trakcie pracy. Odśwież wątek przed kolejną zmianą statusu.',
          );
        else if (!(e instanceof ApiError) || e.status >= 500)
          setNotice(
            'Wynik zmiany statusu jest niepewny. Odśwież wątek, aby sprawdzić aktualny status przed następną zmianą.',
          );
      }
    } finally {
      mutationInFlight.current = false;
      if (alive.current) setMutating(false);
    }
  }
  async function changeAssignment(e: FormEvent) {
    e.preventDefault();
    if (
      busy ||
      mutationInFlight.current ||
      assigneeBusy ||
      versionBlocked ||
      !permitted ||
      externalWriteBlocked ||
      !detail?.can_assign ||
      !assignees?.can_assign ||
      !Number.isInteger(detail.version)
    )
      return;
    const target = assigneeId || null;
    if (target && !assignees.data.some((a) => a.user_id === target)) return;
    mutationInFlight.current = true;
    setMutating(true);
    setError('');
    setNotice('');
    try {
      const d = await api<ThreadDetail>('/customer-messages/' + id + '/assignment', 'PATCH', {
        assigned_user_id: target,
        version: detail.version,
      });
      if (!alive.current) return;
      ++generation.current;
      setLoading(false);
      setDetail(d);
      setAssigneeId(d.assigned_user_id ?? '');
      setNotice(
        d.assigned_user_name
          ? 'Opiekun rozmowy: ' + d.assigned_user_name + '.'
          : 'Usunięto przypisanie opiekuna.',
      );
      onChanged();
    } catch (e) {
      if (alive.current) {
        handleFailure(e);
        setVersionBlocked(true);
        if (e instanceof ApiError && e.status === 409)
          setError(
            'Rozmowa zmieniła się. Odśwież wątek i ponownie sprawdź opiekuna przed przypisaniem.',
          );
        else if (!(e instanceof ApiError) || e.status >= 500)
          setNotice(
            'Wynik przypisania jest niepewny. Odśwież wątek, aby sprawdzić opiekuna przed następną zmianą.',
          );
      }
    } finally {
      mutationInFlight.current = false;
      if (alive.current) setMutating(false);
    }
  }
  return (
    <section className="panel customer-message-thread">
      <div className="panel-heading">
        <div>
          <h2>{detail?.order_number ?? 'Rozmowa z kupującym'}</h2>
          <p>{detail?.customer_name}</p>
        </div>
        <div className="customer-message-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() => {
              setError('');
              void load();
            }}
          >
            <RefreshCw size={16} /> Odśwież wątek
          </button>
          {detail?.order_id && (
            <button className="button" onClick={() => onOrder(detail.order_id)}>
              Zamówienie <ArrowRight size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="customer-messages-body">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {!detail && busy && <p role="status">Wczytywanie wiadomości…</p>}
        {detail && !detail.available && (
          <p className="notice">Ta kopia nie zawiera rozmów klientów.</p>
        )}
        {detail?.available && (
          <>
            <div className="customer-message-actions">
              <strong>Status: {detail.status === 'open' ? 'otwarta' : 'zamknięta'}</strong>
              {permitted && detail.can_status && (
                <button className="button" disabled={busy || versionBlocked || externalWriteBlocked} onClick={changeStatus}>
                  {detail.status === 'open' ? 'Zamknij rozmowę' : 'Otwórz ponownie'}
                </button>
              )}
            </div>
            {['admin', 'operator'].includes(detail.current_role ?? '') &&
              detail.assigned_user_name !== undefined && (
                <p>
                  Opiekun rozmowy: <strong>{detail.assigned_user_name ?? 'Nie przypisano'}</strong>
                </p>
              )}
            {permitted && detail.can_assign && (
              <form className="customer-message-assignment" onSubmit={changeAssignment}>
                <label>
                  Opiekun tej rozmowy
                  <select
                    value={assigneeId}
                    disabled={busy || assigneeBusy || versionBlocked || externalWriteBlocked}
                    onChange={(e) => setAssigneeId(e.target.value)}
                  >
                    <option value="">Bez opiekuna</option>
                    {assigneeId && !assignees?.data.some((a) => a.user_id === assigneeId) && (
                      <option value={assigneeId} disabled>
                        {detail.assigned_user_name ?? 'Dotychczasowy opiekun'} — poza wczytaną listą
                      </option>
                    )}
                    {assignees?.data.map((a) => (
                      <option key={a.user_id} value={a.user_id}>
                        {a.name} · {a.role === 'admin' ? 'administrator' : 'operator'}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button"
                  disabled={
                    busy ||
                    assigneeBusy ||
                    versionBlocked ||
                    externalWriteBlocked ||
                    !assignees?.can_assign ||
                    (assigneeId || null) === (detail.assigned_user_id ?? null)
                  }
                >
                  Zapisz opiekuna
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy || assigneeBusy}
                  onClick={() => void loadAssignees()}
                >
                  Odśwież osoby
                </button>
                {assignees?.meta.cursor && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy || assigneeBusy}
                    onClick={() => void loadAssignees(assignees.meta.cursor)}
                  >
                    Wczytaj kolejne osoby
                  </button>
                )}
                <p>
                  {assigneeBusy
                    ? 'Wczytywanie uprawnionych osób…'
                    : 'Przypisanie dotyczy aktualnego administratora lub operatora tej firmy. Nie wysyła wiadomości.'}
                </p>
                {assignees && !assignees.data.length && (
                  <p>
                    Brak osób dostępnych do przypisania. Możesz pozostawić rozmowę bez opiekuna.
                  </p>
                )}
                {versionBlocked && (
                  <p role="status">Odśwież wątek przed następną zmianą opiekuna lub statusu.</p>
                )}
              </form>
            )}
            <p className="muted">
              Pierwsza strona zawiera do 20 najnowszych wiadomości; starsze można wczytać poniżej.
              Odpowiedź w portalu nie zmienia automatycznie statusu rozmowy.
            </p>
            {detail.meta.cursor && (
              <button
                className="button"
                disabled={busy}
                onClick={() => void load(detail.meta.cursor)}
              >
                Wczytaj starsze wiadomości
              </button>
            )}
            <div className="customer-message-history">
              {visible.map((m) => (
                <article key={m.id} className={'customer-message customer-message-' + m.kind}>
                  <div>
                    <strong>{messageNames[m.kind]}</strong>
                    <time dateTime={m.created_at}>{date(m.created_at)}</time>
                  </div>
                  {m.kind !== 'buyer' && m.kind !== 'email' && m.author_name && <small>{m.author_name}</small>}
                  {m.kind === 'email' && <><small>{m.email ? <>Od: {m.email.from.name} &lt;{m.email.from.address}&gt; · Temat: {m.email.subject || '(bez tematu)'}</> : 'Nadawca emaila wymaga odczytu źródła.'}</small><small>Źródło: odebrana wiadomość IMAP, nie formularz kupującego.</small>{m.author_name && <small>Przypisał operator: {m.author_name}</small>}{onEmail && m.email && <button type="button" className="button" disabled={busy} onClick={() => onEmail(m.email!.message_id)}>Otwórz email i odpowiedź SMTP</button>}</>}
                  <p>{m.body || '(Brak treści tekstowej)'}</p>
                </article>
              ))}
              {!visible.length && <p>Brak wiadomości.</p>}
            </div>
            {(readOnly || detail.read_only) && (
              <p className="notice">Podgląd kopii — tylko odczyt rozmowy.</p>
            )}
            {(!write || (!detail.can_reply && !detail.can_note) || blocked) && (
              <p className="notice">
                Zapis jest wyłączony. Zakres widocznej historii zależy od aktualnych uprawnień.
              </p>
            )}
            {!permitted && mode === 'reply' && draft.body && (
              <div className="customer-message-review">
                <strong>Zachowany szkic odpowiedzi</strong>
                <p>{draft.body}</p>
                <small>Zapis jest wyłączony. Treść pozostaje w pamięci tego panelu.</small>
              </div>
            )}
            {permitted && (detail.can_reply || detail.can_note) && (
              <form onSubmit={save} className="customer-message-composer">
                <div className="customer-message-actions">
                  {detail.can_reply && (
                    <button
                      className={'button ' + (mode === 'reply' ? 'active' : '')}
                      type="button"
                      disabled={busy}
                      onClick={() => changeMode('reply')}
                    >
                      Odpowiedź w portalu
                    </button>
                  )}
                  {detail.can_note && (
                    <button
                      className={'button ' + (mode === 'note' ? 'active' : '')}
                      type="button"
                      disabled={busy}
                      onClick={() => changeMode('note')}
                    >
                      Notatka prywatna
                    </button>
                  )}
                </div>
                <label>
                  {mode === 'reply'
                    ? 'Treść odpowiedzi dla kupującego'
                    : 'Treść notatki dla pracowników'}
                  <textarea
                    rows={6}
                    maxLength={4000}
                    value={draft.body}
                    disabled={busy || draft.attemptedBody !== null}
                    onChange={(e) => {
                      setDraft({ ...draft, body: e.target.value });
                      setReviewed(false);
                    }}
                  />
                </label>
                <small>{draft.body.length} / 4000 znaków · zwykły tekst</small>
                {draft.attemptedBody !== null && (
                  <p className="notice">
                    Zachowano treść i klucz próby. Po utracie odpowiedzi zapis mógł się udać. „Ponów
                    ten sam zapis” używa tej samej treści i klucza, aby nie utworzyć duplikatu.
                  </p>
                )}
                {text && (
                  <div className="customer-message-review">
                    <strong>
                      {mode === 'reply'
                        ? 'Podgląd odpowiedzi widocznej w portalu'
                        : 'Podgląd prywatnej notatki'}
                    </strong>
                    <p>{text}</p>
                  </div>
                )}
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={busy}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  {mode === 'reply'
                    ? 'Sprawdziłem treść. Odpowiedź ma być widoczna dla kupującego w portalu zamówienia.'
                    : 'Sprawdziłem treść. To prywatna notatka dla uprawnionych pracowników.'}
                </label>
                <button
                  className="button primary"
                  disabled={busy || !canWrite || !reviewed || !text || text.length > 4000}
                >
                  {draft.attemptedBody !== null
                    ? 'Ponów ten sam zapis'
                    : mode === 'reply'
                      ? 'Zapisz odpowiedź w portalu'
                      : 'Zapisz prywatną notatkę'}
                </button>
              </form>
            )}
            {permitted && detail.can_reply && detail.order_id && (
              <PortalReplyNotify
                orderId={detail.order_id}
                admin={detail.current_role === 'admin'}
                disabled={busy || externalWriteBlocked}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}
