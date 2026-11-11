import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, date } from './api';
import { ConditionEditor } from './operations';
import './customer-messages.css';

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_admin: boolean;
};
type Person = { user_id: string; name: string; role: string };
type People = {
  available: boolean;
  workflow_available: boolean;
  can_assign: boolean;
  data: Person[];
  meta: { cursor: string | null };
};
type LocalAction =
  | { type: 'customer_message_reply' | 'customer_message_note'; body: string }
  | { type: 'customer_message_assign'; assigned_user_id: string | null }
  | { type: 'customer_message_status'; status: 'open' | 'closed' };
type Definition = {
  name: string;
  trigger: 'customer_message.received';
  enabled: boolean;
  priority: number;
  delay_seconds: number;
  match: 'all' | 'any';
  conditions: any[];
  actions: LocalAction[];
};
type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  delay_seconds: number;
  version: string;
  definition: Definition;
  updated_at: string;
};
type Run = {
  id: string;
  rule_id: string;
  rule_version: string;
  number: string;
  rule_name: string;
  state: string;
  created_at: string;
  finished_at?: string | null;
  error?: string | null;
  result?: { reason?: string; actions?: any[] };
  definition?: Definition;
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null } };
type Metadata = Flags & {
  trigger: string;
  actions: LocalAction['type'][];
  limits: { rules: number; actions: number; thread_messages: number; page: number };
};
type Preview = Flags & {
  matched: boolean;
  allowed: boolean;
  error?: string;
  result?: any[];
  snapshot?: { number?: string };
  order_version?: string;
  actions?: LocalAction[];
};
type Draft = Definition & { id?: string; version?: string };
type Attempt = { path: string; method: string; body: Record<string, unknown> };
const prefix = '/customer-message-workflows';
const actionNames: Record<LocalAction['type'], string> = {
  customer_message_reply: 'Zapisz odpowiedź w portalu',
  customer_message_note: 'Dodaj prywatną notatkę',
  customer_message_assign: 'Przypisz opiekuna rozmowy',
  customer_message_status: 'Zmień status rozmowy',
};
const states: Record<string, string> = {
  queued: 'W kolejce',
  pending: 'Oczekuje',
  running: 'W trakcie',
  done: 'Wykonano',
  failed: 'Błąd',
  skipped: 'Pominięto',
  cancelled: 'Anulowano',
};
const empty = (): Draft => ({
  name: '',
  trigger: 'customer_message.received',
  enabled: false,
  priority: 50,
  delay_seconds: 0,
  match: 'all',
  conditions: [],
  actions: [{ type: 'customer_message_reply', body: '' }],
});
function newAction(type: LocalAction['type']): LocalAction {
  return type === 'customer_message_assign'
    ? { type, assigned_user_id: null }
    : type === 'customer_message_status'
      ? { type, status: 'open' }
      : { type, body: '' };
}
function append<T extends { id: string }>(old: T[], incoming: T[]) {
  return [...old, ...incoming.filter((v) => !old.some((o) => o.id === v.id))];
}
function actionText(action: LocalAction, people: Person[]) {
  if (action.type === 'customer_message_assign')
    return action.assigned_user_id
      ? 'Przypisz: ' +
          (people.find((p) => p.user_id === action.assigned_user_id)?.name ??
            'osoba wskazana w regule')
      : 'Usuń przypisanie opiekuna';
  if (action.type === 'customer_message_status')
    return 'Status rozmowy: ' + (action.status === 'open' ? 'otwarta' : 'zamknięta');
  return actionNames[action.type];
}
function ActionResults({
  results,
  actions,
  people,
  preview = false,
}: {
  results?: any[];
  actions?: LocalAction[];
  people: Person[];
  preview?: boolean;
}) {
  if (!results?.length) return <p>Brak wyników akcji.</p>;
  return (
    <ol>
      {results.map((r, i) => {
        const type = actions?.[i]?.type;
        return (
          <li key={i}>
            <strong>{type ? actionNames[type] : 'Akcja ' + (i + 1)}</strong>
            {r.status && (
              <span>
                {' '}
                ·{' '}
                {r.status === 'open'
                  ? 'rozmowa otwarta'
                  : r.status === 'closed'
                    ? 'rozmowa zamknięta'
                    : r.status}
              </span>
            )}
            {r.delivery === 'local_portal' && (
              <span>
                {' '}
                ·{' '}
                {preview
                  ? 'odpowiedź zostałaby zapisana w portalu'
                  : 'odpowiedź w lokalnym portalu'}
                ; bez wysyłki email/SMS
              </span>
            )}
            {r.delivery === 'private_note' && (
              <span>
                {' '}
                ·{' '}
                {preview
                  ? 'prywatna notatka zostałaby zapisana'
                  : 'prywatna notatka zapisana dla pracowników'}
              </span>
            )}
            {'assigned_user_id' in r && (
              <span>
                {' '}
                ·{' '}
                {r.assigned_user_id
                  ? 'opiekun: ' +
                    (people.find((p) => p.user_id === r.assigned_user_id)?.name ??
                      'osoba wskazana w zapisanej regule')
                  : 'bez opiekuna'}
              </span>
            )}
            {r.reused === true && <span> · wcześniejszy zapis, bez duplikatu</span>}
            {r.changed === false && <span> · bez zmiany</span>}
            {r.error && <p role="alert">{String(r.error)}</p>}
          </li>
        );
      })}
    </ol>
  );
}

export function CustomerMessageWorkflows({
  admin,
  readOnly,
  refresh,
  onChanged,
}: {
  admin: boolean;
  readOnly: boolean;
  refresh: number;
  onChanged: () => void;
}) {
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [rules, setRules] = useState<Page<Rule> | null>(null);
  const [runs, setRuns] = useState<Page<Run> | null>(null);
  const [people, setPeople] = useState<People | null>(null);
  const [statuses, setStatuses] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const attempted = useRef<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);
  const reloadWanted = useRef(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [testRule, setTestRule] = useState<Rule | null>(null);
  const [threads, setThreads] = useState<
    { id: string; order_id: string; order_number: string; customer_name: string }[]
  >([]);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [testOrder, setTestOrder] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const alive = useRef(true);
  const epoch = useRef(0);
  const canAdmin =
    admin &&
    !readOnly &&
    !!metadata?.available &&
    metadata.can_admin &&
    !metadata.read_only &&
    !blocked;
  const canRead = !!metadata?.available && metadata.can_read && !blocked;
  function clearPrivate() {
    setRules(null);
    setRuns(null);
    setPeople(null);
    setDraft(null);
    setAttempt(null);
    attempted.current = null;
    setReviewed(false);
    setPreview(null);
    setTestRule(null);
    setThreads([]);
    setTestOrder('');
    setRun(null);
    setStatuses([]);
    setWarehouses([]);
  }
  function failure(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      ++epoch.current;
      setBlocked(true);
      clearPrivate();
      setMetadata(null);
    } else if (e instanceof ApiError && e.status === 423) {
      setBlocked(false);
      setReviewed(false);
      setPreview(null);
      setMetadata((m) => (m ? { ...m, read_only: true, can_admin: false } : m));
    } else if (e instanceof ApiError && e.status === 503) {
      setBlocked(true);
      setReviewed(false);
      setPreview(null);
    }
  }
  async function load() {
    if (inFlight.current) {
      reloadWanted.current = true;
      return;
    }
    const current = ++epoch.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const m = await api<Metadata>(prefix);
      if (!alive.current || current !== epoch.current) return;
      setMetadata(m);
      setBlocked(false);
      if (!m.available || !m.can_read) {
        clearPrivate();
        return;
      }
      const [r, h, p] = await Promise.all([
        api<Page<Rule>>(prefix + '/rules'),
        api<Page<Run>>(prefix + '/runs'),
        api<People>('/customer-messages/assignees'),
      ]);
      if (!alive.current || current !== epoch.current) return;
      if (!r.can_read || !h.can_read) {
        clearPrivate();
        setBlocked(true);
        return;
      }
      setRules(r);
      setRuns(h);
      setPeople(p);
      setMetadata((previous) =>
        previous
          ? {
              ...previous,
              can_admin: r.can_admin,
              read_only: r.read_only,
              current_role: r.current_role,
            }
          : previous,
      );
      if (admin && m.can_admin) {
        const [s, w] = await Promise.all([
          api<{ data: any[] }>('/workflow-statuses'),
          api<{ warehouses: any[] }>('/settings'),
        ]);
        if (!alive.current || current !== epoch.current) return;
        setStatuses(s.data);
        setWarehouses(w.warehouses);
      }
    } catch (e) {
      if (alive.current && current === epoch.current) failure(e);
    } finally {
      finish();
    }
  }
  function finish() {
    inFlight.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (reloadWanted.current) {
      reloadWanted.current = false;
      setLocalRefresh((n) => n + 1);
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++epoch.current;
    };
  }, []);
  useEffect(() => {
    void load();
  }, [refresh, localRefresh]);
  async function readAction(fn: () => Promise<void>) {
    if (inFlight.current || !canRead) return;
    const current = epoch.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (alive.current && current === epoch.current) failure(e);
    } finally {
      finish();
    }
  }
  function change(next: Draft) {
    setDraft(next);
    setReviewed(false);
    setPreview(null);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || !canAdmin || !draft || !reviewed || (conflict && !attempted.current))
      return;
    if (!attempted.current) {
      const bad = draft.actions.find(
        (a) =>
          'body' in a &&
          (!a.body.trim() ||
            Array.from(a.body.trim()).length > 4000 ||
            new TextEncoder().encode(a.body.trim()).length > 16384),
      );
      if (bad) {
        setError(
          'Treść odpowiedzi lub notatki musi zawierać 1–4000 znaków i nie więcej niż 16 KiB.',
        );
        return;
      }
    }
    const body = {
      client_key: crypto.randomUUID(),
      name: draft.name,
      trigger: 'customer_message.received',
      enabled: draft.enabled,
      priority: draft.priority,
      delay_seconds: draft.delay_seconds,
      match: draft.match,
      conditions: draft.conditions,
      actions: draft.actions,
      ...(draft.id ? { version: draft.version } : {}),
    };
    const request = attempted.current ?? {
      path: prefix + '/rules' + (draft.id ? '/' + draft.id : ''),
      method: draft.id ? 'PATCH' : 'POST',
      body,
    };
    attempted.current = request;
    setAttempt(request);
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const current = epoch.current;
    try {
      const response = await api<Flags & { rule: Rule; reused: boolean }>(
        request.path,
        request.method,
        request.body,
      );
      if (!alive.current || current !== epoch.current) return;
      attempted.current = null;
      setAttempt(null);
      setDraft(null);
      setReviewed(false);
      setConflict(false);
      if (!response.can_read) {
        clearPrivate();
        setBlocked(true);
        return;
      }
      setNotice(
        'Zapisano regułę ' +
          response.rule.name +
          (response.rule.enabled
            ? '. Zadziała na nowe wiadomości kupującego.'
            : '. Reguła pozostaje wyłączona.'),
      );
      setMetadata((m) =>
        m
          ? {
              ...m,
              can_admin: response.can_admin,
              can_read: response.can_read,
              read_only: response.read_only,
              current_role: response.current_role,
            }
          : m,
      );
      setRules((old) =>
        old
          ? { ...old, data: [response.rule, ...old.data.filter((r) => r.id !== response.rule.id)] }
          : old,
      );
      onChanged();
    } catch (e) {
      if (!alive.current || current !== epoch.current) return;
      if (e instanceof ApiError && [409, 422].includes(e.status)) {
        attempted.current = null;
        setAttempt(null);
        setReviewed(false);
        if (e.status === 409) {
          setConflict(true);
          setNotice(
            'Zachowano szkic. Wczytaj aktualną wersję reguł, a następnie wybierz świeżą wersję do edycji. Nie nadpisujemy jej automatycznie.',
          );
        }
      }
      failure(e);
    } finally {
      finish();
    }
  }
  async function loadThreads(cursor?: string | null) {
    const current = epoch.current;
    const d = await api<{
      available: boolean;
      can_note: boolean;
      data: typeof threads;
      meta: { cursor: string | null };
    }>('/customer-messages' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    if (!alive.current || current !== epoch.current) return;
    if (!d.available || !d.can_note) {
      setThreads([]);
      setThreadCursor(null);
      return;
    }
    setThreads((old) => (cursor ? append(old, d.data) : d.data));
    setThreadCursor(d.meta.cursor);
  }
  async function moreRules() {
    if (!rules?.meta.cursor) return;
    const current = epoch.current;
    const d = await api<Page<Rule>>(
      prefix + '/rules?cursor=' + encodeURIComponent(rules.meta.cursor),
    );
    if (!alive.current || current !== epoch.current) return;
    if (!d.can_read) {
      clearPrivate();
      setBlocked(true);
      return;
    }
    setMetadata((m) =>
      m
        ? { ...m, can_admin: d.can_admin, read_only: d.read_only, current_role: d.current_role }
        : m,
    );
    setRules((old) => ({ ...d, data: append(old?.data ?? [], d.data) }));
  }
  async function moreRuns() {
    if (!runs?.meta.cursor) return;
    const current = epoch.current;
    const d = await api<Page<Run>>(prefix + '/runs?cursor=' + encodeURIComponent(runs.meta.cursor));
    if (!alive.current || current !== epoch.current) return;
    if (!d.can_read) {
      clearPrivate();
      setBlocked(true);
      return;
    }
    setMetadata((m) =>
      m
        ? { ...m, can_admin: d.can_admin, read_only: d.read_only, current_role: d.current_role }
        : m,
    );
    setRuns((old) => ({ ...d, data: append(old?.data ?? [], d.data) }));
  }
  async function morePeople() {
    if (!people?.meta.cursor) return;
    const current = epoch.current;
    const d = await api<People>(
      '/customer-messages/assignees?cursor=' + encodeURIComponent(people.meta.cursor),
    );
    if (!alive.current || current !== epoch.current) return;
    setPeople((old) => ({
      ...d,
      data: [
        ...(old?.data ?? []),
        ...d.data.filter((p) => !old?.data.some((o) => o.user_id === p.user_id)),
      ],
    }));
  }
  return (
    <section className="panel customer-message-workflows">
      <div className="panel-heading">
        <div>
          <h2>Obsługa wiadomości kupującego</h2>
          <p>Nowa wiadomość → warunki zamówienia → opiekun, odpowiedź, notatka i status rozmowy.</p>
        </div>
        <div className="cmw-toolbar">
          <button className="button" disabled={busy} onClick={() => void load()}>
            Odśwież reguły i wyniki
          </button>
          {canAdmin && (
            <button
              className="button primary"
              disabled={busy || !!attempt}
              onClick={() => {
                setDraft(empty());
                setReviewed(false);
                setConflict(false);
                setError('');
              }}
            >
              Nowa reguła wiadomości
            </button>
          )}
        </div>
      </div>
      <div className="customer-message-workflows-body">
        <p className="notice">
          Te akcje zapisują dane lokalnie. Odpowiedź jest widoczna w portalu kupującego; notatka
          pozostaje prywatna. Nie wysyłają emaila ani SMS i nie odczytują skrzynek marketplace.
        </p>
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
        {busy && !metadata && <p role="status">Wczytywanie procesu wiadomości…</p>}
        {metadata && !metadata.available && (
          <p>
            Ta kopia nie zawiera automatyzacji wiadomości. Zwykła rozmowa może nadal być dostępna.
          </p>
        )}
        {metadata?.available && !metadata.can_read && (
          <p>Reguły i ich historia są dostępne dla administratora i operatora tej firmy.</p>
        )}
        {(readOnly || metadata?.read_only) && (
          <p className="notice">
            Podgląd kopii — reguły i ich wyniki można czytać; zapis i test wykonania są wyłączone.
          </p>
        )}
        {canRead && (
          <>
            {draft && (
              <form className="cmw-editor" onSubmit={save}>
                <h3>{draft.id ? 'Edycja reguły' : 'Nowa reguła'}</h3>
                <fieldset disabled={busy || !!attempt || !canAdmin}>
                  <div className="cmw-grid">
                    <label>
                      Nazwa reguły
                      <input
                        required
                        minLength={2}
                        maxLength={120}
                        value={draft.name}
                        onChange={(e) => change({ ...draft, name: e.target.value })}
                      />
                    </label>
                    <label>
                      Zdarzenie
                      <input value="Nowa wiadomość kupującego w portalu" readOnly />
                    </label>
                    <label>
                      Priorytet (0 wykonuje się pierwszy)
                      <input
                        type="number"
                        required
                        min={0}
                        max={100}
                        step={1}
                        value={draft.priority}
                        onChange={(e) => change({ ...draft, priority: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      Opóźnienie w sekundach
                      <input
                        type="number"
                        required
                        min={0}
                        max={604800}
                        step={1}
                        value={draft.delay_seconds}
                        onChange={(e) =>
                          change({ ...draft, delay_seconds: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <label className="cmw-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => change({ ...draft, enabled: e.target.checked })}
                    />
                    Włącz regułę dla przyszłych wiadomości kupujących
                  </label>
                  <h4>Warunki dotyczące zamówienia</h4>
                  <label>
                    Łączenie warunków
                    <select
                      value={draft.match}
                      onChange={(e) =>
                        change({ ...draft, match: e.target.value as Draft['match'] })
                      }
                    >
                      <option value="all">Wszystkie (AND)</option>
                      <option value="any">Dowolny (OR)</option>
                    </select>
                  </label>
                  {!draft.conditions.length && (
                    <p>
                      Bez warunków — każda nowa wiadomość kupującego. Treść wiadomości nie jest
                      analizowana.
                    </p>
                  )}
                  {draft.conditions.map((c, i) => (
                    <div className="cmw-action-row" key={i}>
                      <ConditionEditor
                        value={c}
                        onChange={(value) =>
                          change({
                            ...draft,
                            conditions: draft.conditions.map((v, j) => (j === i ? value : v)),
                          })
                        }
                        statuses={statuses}
                        warehouses={warehouses}
                      />
                      <button
                        type="button"
                        className="button"
                        onClick={() =>
                          change({
                            ...draft,
                            conditions: draft.conditions.filter((_, j) => j !== i),
                          })
                        }
                      >
                        Usuń warunek {i + 1}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="button"
                    disabled={draft.conditions.length >= 10}
                    onClick={() =>
                      change({
                        ...draft,
                        conditions: [
                          ...draft.conditions,
                          { field: 'source', op: 'eq', value: 'manual' },
                        ],
                      })
                    }
                  >
                    Dodaj warunek
                  </button>
                  <h4>Akcje w kolejności</h4>
                  <p>
                    Wszystkie akcje danej reguły zostaną zatwierdzone razem albo wycofane razem.
                    Kolejne reguły mają osobne wyniki.
                  </p>
                  {draft.actions.map((a, i) => (
                    <div className="cmw-action-row" key={i}>
                      <label>
                        Akcja {i + 1}
                        <select
                          value={a.type}
                          onChange={(e) =>
                            change({
                              ...draft,
                              actions: draft.actions.map((v, j) =>
                                j === i ? newAction(e.target.value as LocalAction['type']) : v,
                              ),
                            })
                          }
                        >
                          {(metadata?.actions ?? []).map((type) => (
                            <option key={type} value={type}>
                              {actionNames[type]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {'body' in a && (
                        <>
                          <label>
                            {a.type === 'customer_message_reply'
                              ? 'Odpowiedź widoczna dla kupującego'
                              : 'Notatka dla uprawnionych pracowników'}
                            <textarea
                              required
                              rows={4}
                              value={a.body}
                              onChange={(e) =>
                                change({
                                  ...draft,
                                  actions: draft.actions.map((v, j) =>
                                    j === i ? { ...a, body: e.target.value } : v,
                                  ),
                                })
                              }
                            />
                          </label>
                          <small>
                            {Array.from(a.body).length} / 4000 znaków · zwykły tekst, bez zmiennych
                            i załączników
                          </small>
                        </>
                      )}
                      {a.type === 'customer_message_assign' && (
                        <label>
                          Opiekun rozmowy
                          <select
                            value={a.assigned_user_id ?? ''}
                            onChange={(e) =>
                              change({
                                ...draft,
                                actions: draft.actions.map((v, j) =>
                                  j === i ? { ...a, assigned_user_id: e.target.value || null } : v,
                                ),
                              })
                            }
                          >
                            <option value="">Usuń przypisanie</option>
                            {a.assigned_user_id &&
                              !people?.data.some((p) => p.user_id === a.assigned_user_id) && (
                                <option value={a.assigned_user_id} disabled>
                                  Osoba spoza wczytanej listy — sprawdź dostępność
                                </option>
                              )}
                            {people?.data.map((p) => (
                              <option value={p.user_id} key={p.user_id}>
                                {p.name} · {p.role === 'admin' ? 'administrator' : 'operator'}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {a.type === 'customer_message_status' && (
                        <label>
                          Status rozmowy
                          <select
                            value={a.status}
                            onChange={(e) =>
                              change({
                                ...draft,
                                actions: draft.actions.map((v, j) =>
                                  j === i
                                    ? { ...a, status: e.target.value as 'open' | 'closed' }
                                    : v,
                                ),
                              })
                            }
                          >
                            <option value="open">Otwarta</option>
                            <option value="closed">Zamknięta</option>
                          </select>
                        </label>
                      )}
                      <button
                        type="button"
                        className="button"
                        disabled={draft.actions.length <= 1}
                        onClick={() =>
                          change({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })
                        }
                      >
                        Usuń akcję {i + 1}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="button"
                    disabled={draft.actions.length >= (metadata?.limits.actions ?? 5)}
                    onClick={() =>
                      change({
                        ...draft,
                        actions: [...draft.actions, { type: 'customer_message_note', body: '' }],
                      })
                    }
                  >
                    Dodaj akcję
                  </button>
                </fieldset>
                {people?.meta.cursor && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !!attempt}
                    onClick={() => void readAction(morePeople)}
                  >
                    Wczytaj kolejne osoby do przypisania
                  </button>
                )}
                {conflict && (
                  <p className="notice">
                    Konflikt wersji. Szkic zachowano do porównania. Po odświeżeniu wybierz „Edytuj”
                    przy aktualnej regule; poniższy zapis pozostaje zablokowany.
                  </p>
                )}
                {attempt && (
                  <p className="notice">
                    Wynik zapisu może być niepewny. Zamrożono treść, zakres i klucz. Ponowienie
                    wysyła dokładnie tę samą próbę; nie twórz drugiej reguły.
                  </p>
                )}
                <label className="cmw-checkbox">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={busy || !canAdmin}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  {draft.enabled
                    ? 'Sprawdziłem warunki i kolejność akcji. Zatwierdzam ich automatyczne wykonywanie dla przyszłych wiadomości kupującego.'
                    : 'Sprawdziłem treść reguły. Zapisuję ją jako wyłączoną.'}
                </label>
                <div className="cmw-toolbar">
                  <button
                    className="button primary"
                    disabled={busy || !canAdmin || !reviewed || (conflict && !attempt)}
                  >
                    {' '}
                    {attempt ? 'Ponów ten sam zapis reguły' : 'Zapisz regułę'}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy || !!attempt}
                    onClick={() => {
                      setDraft(null);
                      setReviewed(false);
                      setConflict(false);
                    }}
                  >
                    Zamknij edytor
                  </button>
                </div>
              </form>
            )}
            <div className="cmw-grid">
              {rules?.data.map((r) => (
                <article className="cmw-rule" key={r.id}>
                  <h3>{r.name}</h3>
                  <p>
                    {r.enabled ? 'Włączona' : 'Wyłączona'} · priorytet {r.priority} · opóźnienie{' '}
                    {r.delay_seconds} s · wersja {r.version}
                  </p>
                  <p>
                    {r.definition.match === 'all' ? 'Wszystkie' : 'Dowolny'} z{' '}
                    {r.definition.conditions.length} warunków zamówienia
                  </p>
                  <ol>
                    {r.definition.actions.map((a, i) => (
                      <li key={i}>
                        {actionText(a, people?.data ?? [])}
                        {'body' in a && (
                          <details>
                            <summary>
                              {a.type === 'customer_message_reply'
                                ? 'Treść odpowiedzi w portalu'
                                : 'Treść prywatnej notatki'}
                            </summary>
                            <p className="cmw-text">{a.body}</p>
                          </details>
                        )}
                      </li>
                    ))}
                  </ol>
                  {canAdmin && (
                    <div className="cmw-toolbar">
                      <button
                        className="button"
                        disabled={busy || !!attempt}
                        onClick={() => {
                          setDraft({ ...r.definition, id: r.id, version: r.version });
                          setReviewed(false);
                          setConflict(false);
                        }}
                      >
                        Edytuj regułę
                      </button>
                      <button
                        className="button"
                        disabled={busy || !!attempt}
                        onClick={() =>
                          void readAction(async () => {
                            setTestRule(r);
                            setTestOrder('');
                            setPreview(null);
                            await loadThreads();
                          })
                        }
                      >
                        Sprawdź bez zapisu
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            {rules && !rules.data.length && (
              <p>
                Brak reguł wiadomości. Nowe wiadomości pozostają zwykłymi wpisami w rozmowie, dopóki
                administrator nie włączy reguły.
              </p>
            )}
            {rules?.meta.cursor && (
              <button className="button" disabled={busy} onClick={() => void readAction(moreRules)}>
                Starsze reguły
              </button>
            )}
            {testRule && (
              <div className="cmw-preview">
                <h3>Sprawdzenie: {testRule.name}</h3>
                <p>
                  Podgląd wykonuje akcje w transakcji, która jest całkowicie wycofana. Nie zapisuje
                  odpowiedzi, opiekuna, statusu ani nowych jobów.
                </p>
                <label>
                  Rozmowa do sprawdzenia
                  <select
                    value={testOrder}
                    disabled={busy}
                    onChange={(e) => {
                      setTestOrder(e.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="">Wybierz istniejącą rozmowę</option>
                    {threads.map((t) => (
                      <option key={t.id} value={t.order_id}>
                        {t.order_number} · {t.customer_name}
                      </option>
                    ))}
                  </select>
                </label>
                {threadCursor && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void readAction(() => loadThreads(threadCursor))}
                  >
                    Starsze rozmowy do sprawdzenia
                  </button>
                )}
                {!threads.length && (
                  <p>Brak dostępnej rozmowy. Kupujący musi najpierw zapisać wiadomość w portalu.</p>
                )}
                <button
                  className="button"
                  disabled={busy || !canAdmin || !testOrder}
                  onClick={() =>
                    void readAction(async () => {
                      const current = epoch.current;
                      const d = await api<Preview>(
                        prefix + '/rules/' + testRule.id + '/preview',
                        'POST',
                        { order_id: testOrder },
                      );
                      if (alive.current && current === epoch.current) setPreview(d);
                    })
                  }
                >
                  Sprawdź regułę bez zapisu
                </button>
                {preview && (
                  <>
                    <p role="status">
                      {!preview.matched
                        ? 'Warunki nie są spełnione.'
                        : preview.allowed
                          ? 'Warunki spełnione. Wszystkie akcje można wykonać — podgląd został wycofany.'
                          : 'Warunki spełnione, wykonanie zablokowane: ' +
                            (preview.error ?? 'sprawdź aktualny stan rozmowy')}
                    </p>
                    {preview.allowed && (
                      <ActionResults
                        results={preview.result}
                        actions={preview.actions ?? testRule.definition.actions}
                        people={people?.data ?? []}
                        preview
                      />
                    )}
                  </>
                )}
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setTestRule(null);
                    setPreview(null);
                  }}
                >
                  Zamknij podgląd
                </button>
              </div>
            )}
            <div className="cmw-runs">
              <h3>Wykonania reguł wiadomości</h3>
              <p>
                Historia jest odczytywana lokalnie. Odśwież ją po wiadomości kupującego; nie
                potwierdza doręczenia emaila ani SMS.
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Reguła / data</th>
                      <th>Zamówienie</th>
                      <th>Wynik</th>
                      <th>Szczegóły</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs?.data.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <strong>{r.rule_name}</strong>
                          <small>
                            {date(r.created_at)} · wersja {r.rule_version}
                          </small>
                        </td>
                        <td>{r.number}</td>
                        <td>
                          {states[r.state] ?? r.state}
                          {r.error && <p role="alert">{r.error}</p>}
                          {r.result?.reason && <p>{r.result.reason}</p>}
                        </td>
                        <td>
                          <button
                            className="button"
                            disabled={busy}
                            onClick={() =>
                              void readAction(async () => {
                                const current = epoch.current;
                                const d = await api<Flags & { run: Run }>(prefix + '/runs/' + r.id);
                                if (alive.current && current === epoch.current) {
                                  if (!d.can_read) {
                                    clearPrivate();
                                    setBlocked(true);
                                    return;
                                  }
                                  setRun(d.run);
                                }
                              })
                            }
                          >
                            Wyniki akcji
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {runs && !runs.data.length && (
                <p>
                  Brak wykonań. Podgląd nie tworzy wpisu historii; włączona reguła zadziała po nowej
                  wiadomości kupującego.
                </p>
              )}
              {runs?.meta.cursor && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void readAction(moreRuns)}
                >
                  Starsze wykonania
                </button>
              )}
            </div>
            {run && (
              <div className="cmw-preview">
                <h3>
                  {run.rule_name} · {run.number}
                </h3>
                <p>
                  {states[run.state] ?? run.state} · {date(run.created_at)}
                </p>
                {run.error && (
                  <p className="error" role="alert">
                    {run.error}
                  </p>
                )}
                {run.result?.reason && <p>{run.result.reason}</p>}
                <ActionResults
                  results={run.result?.actions}
                  actions={run.definition?.actions}
                  people={people?.data ?? []}
                />
                {run.definition && (
                  <details>
                    <summary>Reguła zapisana dla tego wykonania</summary>
                    <ol>
                      {run.definition.actions.map((a, i) => (
                        <li key={i}>
                          {actionText(a, people?.data ?? [])}
                          {'body' in a && <p className="cmw-text">{a.body}</p>}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                <button className="button" disabled={busy} onClick={() => setRun(null)}>
                  Zamknij wynik
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
