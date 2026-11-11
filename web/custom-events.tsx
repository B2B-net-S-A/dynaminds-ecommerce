/** AUTO-07 „Zdarzenia własne”: definitions (administrator), raising one for an order (administrator or operator)
 * and the call history with the rule runs each call started. One idempotency key per attempt: when the answer is
 * lost the retry sends the same key, so the server returns the same call instead of a second one. */
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, ApiError, date } from './api';

interface CustomEvent { id: string; key: string; name: string; description: string; active: boolean; version: string }
interface CallRun { rule_id: string; rule_name: string | null; state: string; error?: string | null }
interface Call { id: string; source: string; order_number: string | null; created_at: string; runs: CallRun[] }
const sourceNames: Record<string, string> = { ui: 'Panel', api: 'API', rule: 'Reguła', schedule: 'Harmonogram', batch: 'Operacja masowa' };
const runStates: Record<string, string> = { queued: 'W kolejce', done: 'Wykonano', skipped: 'Pominięto', failed: 'Błąd' };

/** Fields of the `raise_event` action in the shared action editor. */
export function CustomEventActionFields({ value, onChange }: { value: { event_key?: string }; onChange: (v: any) => void }) {
  const [events, setEvents] = useState<CustomEvent[]>([]), [error, setError] = useState('');
  useEffect(() => { let live = true; api('/custom-events').then((r) => live && setEvents(r.data)).catch((e) => live && setError(e.message)); return () => { live = false; }; }, []);
  return (
    <>
      <select aria-label="Zdarzenie własne" value={value.event_key ?? ''} onChange={(e) => onChange({ ...value, event_key: e.target.value })}>
        <option value="">Wybierz zdarzenie</option>
        {events.filter((x) => x.active || x.key === value.event_key).map((x) => <option key={x.id} value={x.key}>{x.name} · custom.{x.key}</option>)}
      </select>
      {error && <span className="notice import-error" role="alert">{error}</span>}
    </>
  );
}

/** Rule-trigger options for the active own events. */
export function useCustomEventTriggers(refresh = 0): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => { let live = true; api('/custom-events').then((r) => live && setNames(Object.fromEntries((r.data as CustomEvent[]).map((x) => ['custom.' + x.key, 'Zdarzenie własne: ' + x.name])))).catch(() => live && setNames({})); return () => { live = false; }; }, [refresh]);
  return names;
}

type Raise = { event: CustomEvent; order_id: string; client_key: string; phase: 'draft' | 'sending' | 'unknown' | 'done' | 'refused'; message: string };

export function CustomEventsPanel({ admin, canRaise = true, readOnly = false, refresh, notify }: { admin: boolean; canRaise?: boolean; readOnly?: boolean; refresh: number; notify: (s: string, error?: boolean) => void }) {
  const [events, setEvents] = useState<CustomEvent[] | null>(null), [available, setAvailable] = useState(true), [error, setError] = useState(''), [local, setLocal] = useState(0);
  const [draft, setDraft] = useState<{ key: string; name: string; description: string } | null>(null), [busy, setBusy] = useState(false);
  const [raise, setRaise] = useState<Raise | null>(null), [orders, setOrders] = useState<{ id: string; number: string }[]>([]);
  const [history, setHistory] = useState<{ event: CustomEvent; calls: Call[] | null; error: string } | null>(null);
  const write = admin && !readOnly, raising = canRaise && !readOnly;
  useEffect(() => {
    let live = true;
    api('/custom-events').then((r) => { if (live) { setEvents(r.data); setAvailable(r.available !== false); setError(''); } }).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [refresh, local]);
  async function create() {
    if (!draft || !write) return;
    setBusy(true); setError('');
    try { await api('/custom-events', 'POST', { ...draft, active: true }); setDraft(null); setLocal((n) => n + 1); notify('Zapisano zdarzenie własne.'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function toggle(x: CustomEvent) {
    if (!write) return;
    setBusy(true); setError('');
    try { await api('/custom-events/' + x.id, 'PATCH', { name: x.name, description: x.description, active: !x.active, version: x.version }); setLocal((n) => n + 1); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function openRaise(x: CustomEvent) {
    setRaise({ event: x, order_id: '', client_key: crypto.randomUUID(), phase: 'draft', message: '' });
    api('/orders?limit=50').then((r) => setOrders(r.data)).catch((e) => setError(e.message));
  }
  async function send() {
    if (!raise || !raising || !raise.order_id) return;
    const attempt = { ...raise, phase: 'sending' as const };
    setRaise(attempt);
    try {
      const r = await api('/custom-events/' + attempt.event.key + '/raise', 'POST', { order_id: attempt.order_id, client_key: attempt.client_key });
      setRaise({ ...attempt, phase: 'done', message: r.replayed ? 'Zdarzenie wywołane wcześniej tym samym kluczem — bez nowego wywołania.' : 'Zdarzenie wywołane. Reguły ruszą w kolejce zadań.' });
    } catch (e) {
      // Only a server answer is a refusal; without one the call may have been recorded, so the key is kept.
      setRaise(e instanceof ApiError ? { ...attempt, phase: 'refused', message: e.message } : { ...attempt, phase: 'unknown', message: 'Nie wiadomo, czy zdarzenie zostało wywołane. Ponów z tym samym kluczem — serwer nie wywoła go drugi raz.' });
    }
  }
  async function openHistory(x: CustomEvent) {
    setHistory({ event: x, calls: null, error: '' });
    try { setHistory({ event: x, calls: (await api('/custom-events/' + x.id + '/calls')).data, error: '' }); }
    catch (e) { setHistory({ event: x, calls: null, error: (e as Error).message }); }
  }
  return (
    <section className="panel ops-panel">
      <div className="panel-heading">
        <div>
          <h2>Zdarzenia własne</h2>
          <p>Wywołanie dla zamówienia uruchamia reguły ze zdarzeniem „custom.klucz” · historia każdego wywołania</p>
        </div>
        {write && available && (
          <button className="button primary" disabled={busy} onClick={() => setDraft({ key: '', name: '', description: '' })}><Plus size={16} />Nowe zdarzenie</button>
        )}
      </div>
      {!available && <p className="notice" role="status">Ta kopia bazy nie zawiera zdarzeń własnych.</p>}
      {error && <p className="notice import-error" role="alert">{error}</p>}
      {draft && write && (
        <form className="rule-editor" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div className="form-grid">
            <label>Klucz<input aria-label="Klucz zdarzenia" required pattern="[a-z][a-z0-9_]{1,39}" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></label>
            <label>Nazwa<input aria-label="Nazwa zdarzenia" required minLength={2} maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label>Opis<input aria-label="Opis zdarzenia" maxLength={500} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
          </div>
          <div className="button-row">
            <button className="button primary" type="submit" disabled={busy}>Zapisz zdarzenie</button>
            <button className="button" type="button" onClick={() => setDraft(null)}>Anuluj</button>
          </div>
        </form>
      )}
      {events?.length === 0 && available && <p>Brak zdarzeń własnych.</p>}
      {events?.map((x) => (
        <article key={x.id} className="rule-card">
          <div>
            <h3>{x.name}</h3>
            <p>custom.{x.key} · {x.active ? 'aktywne' : 'wyłączone'}{x.description ? ' · ' + x.description : ''}</p>
          </div>
          <div className="button-row">
            {raising && x.active && <button className="button" type="button" onClick={() => openRaise(x)}>Wywołaj</button>}
            <button className="button" type="button" onClick={() => void openHistory(x)}>Historia</button>
            {write && <button className="button" type="button" disabled={busy} onClick={() => void toggle(x)}>{x.active ? 'Wyłącz' : 'Włącz'}</button>}
          </div>
        </article>
      ))}
      {raise && raising && (
        <div className="ops-result">
          <h3>Wywołanie: {raise.event.name}</h3>
          <label>Zamówienie
            <select aria-label="Zamówienie zdarzenia" value={raise.order_id} disabled={raise.phase !== 'draft'} onChange={(e) => setRaise({ ...raise, order_id: e.target.value })}>
              <option value="">Wybierz zamówienie</option>
              {orders.map((o) => <option key={o.id} value={o.id}>{o.number}</option>)}
            </select>
          </label>
          {raise.message && <p role={raise.phase === 'refused' || raise.phase === 'unknown' ? 'alert' : 'status'}>{raise.message}</p>}
          <div className="button-row">
            {raise.phase === 'draft' && <button className="button primary" type="button" disabled={!raise.order_id} onClick={() => void send()}>Wywołaj dla zamówienia</button>}
            {raise.phase === 'unknown' && <button className="button primary" type="button" onClick={() => void send()}>Ponów z tym samym kluczem</button>}
            <button className="button" type="button" disabled={raise.phase === 'sending'} onClick={() => setRaise(null)}>Zamknij</button>
          </div>
        </div>
      )}
      {history && (
        <div className="ops-result">
          <h3>Historia: {history.event.name}</h3>
          {history.error && <p className="notice import-error" role="alert">{history.error}</p>}
          {!history.calls && !history.error && <p>Wczytywanie historii…</p>}
          {history.calls?.length === 0 && <p>Brak wywołań.</p>}
          {history.calls && history.calls.length > 0 && (
            <table>
              <thead><tr><th>Kiedy</th><th>Zamówienie</th><th>Źródło</th><th>Reguły</th></tr></thead>
              <tbody>
                {history.calls.map((call) => (
                  <tr key={call.id}>
                    <td>{date(call.created_at)}</td>
                    <td>{call.order_number ?? '—'}</td>
                    <td>{sourceNames[call.source] ?? call.source}</td>
                    <td>{call.runs.length ? call.runs.map((r) => (r.rule_name ?? r.rule_id) + ': ' + (runStates[r.state] ?? r.state)).join(', ') : 'Brak reguł'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
