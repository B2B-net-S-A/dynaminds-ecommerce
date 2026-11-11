import {useEffect, useRef, useState} from 'react';
import {api} from './api';

export type ConnectorJobContext = {
  tenantId: string; userId: string; admin: boolean; readOnly: boolean; externalWriteBlocked?: boolean;
};
type Props = ConnectorJobContext & {jobId: string; kind: string; onChanged?: () => void};
type Cut = {
  scope: 'sandbox_manual_once';
  job: {id: string; kind: string; state: string; attempts: number; max_attempts: number; lease_active: boolean};
  plan: {id: string; state: string; phase: string} | null;
  once_intent_recorded: boolean; completed: boolean; continuation_required: boolean;
  automatic_retry: false; provider_acceptance: false;
};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const kinds = ['orders.sync', 'offer.write', 'shipping', 'shipping.dpd', 'dpd.collection'];
const exact = (v: any, keys: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const invalid = () => Error('Odczyt nie potwierdza wybranego zadania.');
export function readOrdinaryConnectorJob(v: any, jobId: string, kind: string): Cut {
  if (!uuid(jobId) || !kinds.includes(kind) || !exact(v, ['scope', 'job', 'plan', 'once_intent_recorded', 'completed', 'continuation_required', 'automatic_retry', 'provider_acceptance']) ||
      v.scope !== 'sandbox_manual_once' || v.automatic_retry !== false || v.provider_acceptance !== false ||
      !exact(v.job, ['id', 'kind', 'state', 'attempts', 'max_attempts', 'lease_active']) || v.job.id !== jobId || v.job.kind !== kind ||
      !['pending', 'running', 'done', 'failed'].includes(v.job.state) || typeof v.job.lease_active !== 'boolean' ||
      !Number.isSafeInteger(v.job.attempts) || !Number.isSafeInteger(v.job.max_attempts) || v.job.attempts < 0 || v.job.max_attempts < 1 || v.job.attempts > v.job.max_attempts ||
      typeof v.once_intent_recorded !== 'boolean' || v.completed !== (v.job.state === 'done') || v.continuation_required !== (v.job.state === 'pending' && v.once_intent_recorded) ||
      v.plan !== null && (!exact(v.plan, ['id', 'state', 'phase']) || !uuid(v.plan.id) || typeof v.plan.state !== 'string' || !v.plan.state || v.plan.state.length > 80 || typeof v.plan.phase !== 'string' || !v.plan.phase || v.plan.phase.length > 80)) throw invalid();
  return v;
}
export function freshOrdinaryConnectorJob(c: Cut) {
  if (c.job.state !== 'pending' || c.job.attempts !== 0 || c.job.lease_active || c.once_intent_recorded) return false;
  if (c.job.kind === 'orders.sync') return c.plan === null;
  if (!c.plan) return false;
  const pair = c.plan.state + ':' + c.plan.phase;
  if (c.job.kind === 'shipping') return ['queued:ready', 'buy_queued:buy_ready', 'queued:refresh_ready'].includes(pair);
  return ['offer.write', 'shipping.dpd', 'dpd.collection'].includes(c.job.kind) && pair === 'queued:ready';
}
const names: Record<string, string> = {pending: 'Oczekujące', running: 'W trakcie — bez ponawiania', done: 'Zakończone', failed: 'Nieudane — sprawdź wynik'};

export function OrdinaryConnectorJobControl(p: Props) {
  return <JobControl key={[p.tenantId, p.userId, p.admin, p.readOnly, !!p.externalWriteBlocked, p.jobId, p.kind].join(':')} {...p} />;
}
function JobControl(p: Props) {
  const alive = useRef(true), flight = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [cut, setCut] = useState<Cut | null>(null);
  const [consent, setConsent] = useState(false), [available, setAvailable] = useState<boolean | null>(null);
  const key = 'dyna:connector-job-once:v1:' + p.tenantId + ':' + p.userId + ':' + p.jobId;
  const [marked, setMarked] = useState(() => {
    try { return typeof window !== 'undefined' && window.localStorage.getItem(key) !== null; } catch { return true; }
  });
  const route = '/local-operator/connector-jobs/' + p.jobId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current;
  async function actor() {
    if (!current() || !p.admin || p.readOnly || !uuid(p.jobId) || !kinds.includes(p.kind)) throw invalid();
    const me = await api('/auth/me');
    if (!current() || me.restore_preview !== false || me.user?.tenant_id !== p.tenantId || me.user?.id !== p.userId || me.user?.role !== 'admin' || me.user?.api_key_id != null) throw invalid();
  }
  async function capability() {
    const health = await api('/health');
    if (!current()) throw invalid();
    const enabled = health.ordinary_connector_jobs_available === true;
    setAvailable(enabled);
    if (!enabled) throw invalid();
  }
  async function read() {
    if (flight.current || !p.admin || p.readOnly) return;
    flight.current = true; setBusy(true); setError(''); setConsent(false); setCut(null);
    try {
      await capability(); await actor();
      const value = readOrdinaryConnectorJob(await api(route), p.jobId, p.kind);
      if (current()) { setCut(value); setMarked(window.localStorage.getItem(key) !== null); }
    } catch { if (current()) setError('Nie udało się potwierdzić zadania. Możesz ponowić wyłącznie odczyt.'); }
    finally { if (current()) { flight.current = false; setBusy(false); } }
  }
  async function run() {
    if (flight.current || !consent || !cut || !freshOrdinaryConnectorJob(cut) || marked || p.externalWriteBlocked || p.readOnly || !p.admin) return;
    flight.current = true; setBusy(true); setError('');
    let dispatched = false;
    try {
      if (!navigator.locks?.request) throw invalid();
      await navigator.locks.request(key, {mode: 'exclusive'}, async () => {
        if (!current() || window.localStorage.getItem(key) !== null) throw invalid();
        await capability(); await actor();
        const fresh = readOrdinaryConnectorJob(await api(route), p.jobId, p.kind);
        if (!current()) throw invalid();
        setCut(fresh);
        if (!freshOrdinaryConnectorJob(fresh)) throw invalid();
        await actor();
        if (!current() || window.localStorage.getItem(key) !== null) throw invalid();
        // UX fence only. Server owns admission, durable intent and exact lease; never erase this sent marker to retry.
        window.localStorage.setItem(key, 'sent'); setMarked(true);
        dispatched = true;
        const ack = readOrdinaryConnectorJob(await api(route + '/run-once', 'POST', {}), p.jobId, p.kind);
        if (!current()) return;
        if (!ack.once_intent_recorded) throw invalid();
        setCut(ack);
        const result = readOrdinaryConnectorJob(await api(route), p.jobId, p.kind);
        if (current()) { setCut(result); p.onChanged?.(); }
      });
    } catch {
      if (current()) { setCut(null); setError(dispatched
        ? 'Nie potwierdzono wyniku próby. Odczytaj oryginalne zadanie; nie wysyłaj ponownie wykonania.'
        : 'Warunki wykonania zmieniły się. Żądanie wykonania nie zostało wysłane; odczytaj zadanie ponownie.'); }
    } finally { if (current()) { flight.current = false; setBusy(false); setConsent(false); } }
  }
  if (!p.admin || p.readOnly) return <p>Jednorazowe wykonanie wymaga zwykłej sesji administratora.</p>;
  const fresh = cut && freshOrdinaryConnectorJob(cut) && !marked;
  return <div className="info-body">
    <button className="button small-btn" type="button" disabled={busy} onClick={() => void read()}>Odczytaj zadanie i dostęp do sandboxa</button>
    {available === false && <p>Ręczne wykonanie w sandboxie jest wyłączone w tym uruchomieniu.</p>}
    {busy && <p role="status">Sprawdzanie lub wykonywanie jednej próby…</p>}
    {cut && <p role="status">{names[cut.job.state]} · próby {cut.job.attempts}/{cut.job.max_attempts}</p>}
    {fresh && <>
      <label><input type="checkbox" checked={consent} disabled={busy || !!p.externalWriteBlocked} onChange={e => setConsent(e.target.checked)} /> Potwierdzam jedną rzeczywistą próbę w środowisku testowym dostawcy.</label>
      <button className="button small-btn" type="button" disabled={busy || !consent || !!p.externalWriteBlocked} onClick={() => void run()}>Wykonaj raz w sandboxie</button>
    </>}
    {(marked || cut && !freshOrdinaryConnectorJob(cut)) && <p>Próba rozpoczęta lub niedostępna do pierwszego wykonania. Odświeżenie tylko odczytuje zapisany stan; nie ponawia operacji u dostawcy.</p>}
    {cut?.continuation_required && <p>Dalszy przebieg wymaga sprawdzenia historii synchronizacji. Ta próba nie będzie ponawiana.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
