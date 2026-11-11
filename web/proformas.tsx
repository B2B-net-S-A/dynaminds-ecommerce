import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './proformas.css';

type Address = {
  name: string;
  street: string;
  postal_code: string;
  city: string;
  country: string;
  tax_id?: string;
};
type Definition = {
  name: string;
  prefix: string;
  seller: Address;
  payment_terms_days: number;
  payment_instructions: string;
  notes: string;
};
type Series = Definition & { id: string; version: 1; created_at: string };
type Options = {
  available: boolean;
  read_only: boolean;
  can_read: boolean;
  can_write: boolean;
  current_role: string;
  limits?: Record<string, number>;
  series: Series[];
  batch_available?: boolean;
  batch_limits?: Record<string, number>;
};
type Document = {
  id: string;
  order_id?: string;
  number: string;
  kind: string;
  mode: string;
  data?: unknown;
};
type Order = { id: string; version: string | number; documents?: Document[] };
type Preview = {
  id: string;
  order_id: string;
  order_version: string;
  series_id: string;
  scope_hash: string;
  expires_at: string;
  snapshot: Snapshot;
  can_issue: boolean;
  issued_document_id: string | null;
};
type Snapshot = {
  order: {
    id: string;
    number: string;
    version: string;
    status: string;
    currency: string;
    total_minor: string;
    shipping_cost_minor: string;
    payment_mode: string;
  };
  seller: Address;
  buyer: {
    name: string;
    email: string;
    tax_id?: string;
    address: Omit<Address, 'name' | 'tax_id'>;
  };
  series: {
    id: string;
    name: string;
    prefix: string;
    payment_terms_days: number;
    payment_instructions: string;
    notes: string;
  };
  currency: string;
  lines: {
    item_id: string | null;
    product_id: string | null;
    kind: 'item' | 'shipping';
    sku: string;
    name: string;
    quantity: number;
    unit_gross_minor: string | null;
    vat_rate: number;
    gross_minor: string;
    net_minor: string;
    vat_minor: string;
  }[];
  totals: { gross_minor: string; net_minor: string; vat_minor: string };
  issue_date: string;
  due_date: string;
  year: number;
};
type Reply = { preview?: Preview; document?: Document; series?: Series; reused?: boolean };
export type ProformaSharedProps = {
  contextKey: string;
  readOnly: boolean;
  externalWriteBlocked?: boolean;
  onLockedChange?: (locked: boolean) => void;
  onError?: (message: string) => void;
};
type SharedProps = ProformaSharedProps;
export type ProformaAttempt = {
  context: string;
  owner: string;
  kind: 'series' | 'preview' | 'issue' | 'batch-preview' | 'batch-issue';
  path: string;
  body: string;
};
type Attempt = ProformaAttempt;
type RejectedAttempt = Pick<Attempt, 'context' | 'owner' | 'kind' | 'path'> & { status: number };
export type ProformaSnapshot = Snapshot;
let actorContext = '';
let epoch = 0;
let attempt: Attempt | null = null;
let inFlight = false;
let outcome: { owner: string; kind: Attempt['kind']; reply: unknown } | null = null;
const rejectedAttempts = new Map<string, RejectedAttempt>();
let notifiedReplies = new WeakSet<object>();
export const notifySavedOnce = (reply: object, callback?: () => void) => {
  if (notifiedReplies.has(reply)) return;
  notifiedReplies.add(reply);
  callback?.();
};
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((fn) => fn());
export function resetProformaContext(contextKey: string) {
  if (actorContext === contextKey) return;
  actorContext = contextKey;
  epoch++;
  attempt = null;
  inFlight = false;
  outcome = null;
  rejectedAttempts.clear();
  notifiedReplies = new WeakSet<object>();
  publish();
}
export function getProformaLocked(contextKey: string) {
  return actorContext === contextKey && Boolean(attempt || inFlight);
}
export function subscribeProformaLock(contextKey: string, callback: (locked: boolean) => void) {
  const notify = () => callback(getProformaLocked(contextKey));
  listeners.add(notify);
  notify();
  return () => {
    listeners.delete(notify);
  };
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function checkOptions(v: Options) {
  if (
    !v ||
    ['available', 'read_only', 'can_read', 'can_write'].some(
      (k) => typeof v[k as keyof Options] !== 'boolean',
    ) ||
    typeof v.current_role !== 'string'
  )
    throw Error('Niepełny odczyt dostępu do proform.');
}
export function checkSnapshot(s: Snapshot, orderId: string) {
  const amount = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
  if (
    !s ||
    s.order?.id !== orderId ||
    !s.seller?.name ||
    !s.buyer?.name ||
    !s.buyer.address ||
    !uuid(s.series?.id) ||
    !Array.isArray(s.lines) ||
    !s.lines.length ||
    !s.totals ||
    s.order.currency !== s.currency ||
    !s.issue_date ||
    !s.due_date
  )
    throw Error('Niepełny zakres zapisanego podglądu proformy.');
  let gross = 0n,
    net = 0n,
    vat = 0n;
  for (const line of s.lines) {
    if (
      !['item', 'shipping'].includes(line.kind) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      !Number.isInteger(line.vat_rate) ||
      line.vat_rate < 0 ||
      line.vat_rate > 100 ||
      ![line.gross_minor, line.net_minor, line.vat_minor].every(amount) ||
      (line.kind === 'item' && !uuid(line.item_id))
    )
      throw Error('Niepełne pozycje zapisanego podglądu proformy.');
    if (BigInt(line.net_minor) + BigInt(line.vat_minor) !== BigInt(line.gross_minor))
      throw Error('Kwoty pozycji podglądu nie zgadzają się.');
    gross += BigInt(line.gross_minor);
    net += BigInt(line.net_minor);
    vat += BigInt(line.vat_minor);
  }
  if (
    ![s.totals.gross_minor, s.totals.net_minor, s.totals.vat_minor].every(amount) ||
    gross !== BigInt(s.totals.gross_minor) ||
    net !== BigInt(s.totals.net_minor) ||
    vat !== BigInt(s.totals.vat_minor) ||
    gross !== BigInt(s.order.total_minor) ||
    s.lines.filter((l) => l.kind === 'shipping').length !== 1
  )
    throw Error('Sumy podglądu nie zgadzają się z pełnymi pozycjami.');
}
function checkReply(v: Reply, a: Attempt) {
  if (a.kind === 'preview') {
    if (
      !v.preview ||
      !uuid(v.preview.id) ||
      a.owner !== `order:${v.preview.order_id}` ||
      !/^[a-f0-9]{64}$/.test(v.preview.scope_hash) ||
      !Number.isFinite(Date.parse(v.preview.expires_at)) ||
      typeof v.preview.can_issue !== 'boolean' ||
      (v.preview.issued_document_id !== null && !uuid(v.preview.issued_document_id))
    )
      throw Error('Niepełny zapisany podgląd proformy. Zachowano dokładną próbę.');
    checkSnapshot(v.preview.snapshot, v.preview.order_id);
    const request = JSON.parse(a.body);
    if (
      v.preview.order_version !== request.order_version ||
      v.preview.series_id !== request.series_id ||
      v.preview.snapshot.series.id !== request.series_id ||
      v.preview.snapshot.order.version !== request.order_version ||
      v.preview.snapshot.lines.find((l) => l.kind === 'shipping')?.vat_rate !== request.shipping_vat
    )
      throw Error('Podgląd proformy nie odpowiada zachowanemu żądaniu.');
  } else if (a.kind === 'issue') {
    if (
      !v.document ||
      !uuid(v.document.id) ||
      v.document.kind !== 'proforma' ||
      v.document.mode !== 'local' ||
      !v.document.number ||
      (v.document.order_id && a.owner !== `order:${v.document.order_id}`)
    )
      throw Error('Niepełny wynik wystawienia proformy. Zachowano dokładną próbę.');
  } else if (!v.series || !uuid(v.series.id))
    throw Error('Niepełny wynik utworzenia serii. Zachowano dokładną próbę.');
}
export function useProformaIO<Result = Reply>(
  props: SharedProps,
  owner: string,
  validate?: (reply: Result, attempt: Attempt) => void,
) {
  const { contextKey, readOnly, externalWriteBlocked = false, onLockedChange, onError } = props;
  const liveExternalWriteBlocked = useRef(externalWriteBlocked); liveExternalWriteBlocked.current = externalWriteBlocked;
  const identity = `${contextKey}:readonly=${readOnly}:owner=${owner}`;
  const scope = useRef(identity);
  scope.current = identity;
  const generation = useRef(0);
  const [revision, update] = useState(0);
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [reply, setReply] = useState<{ kind: Attempt['kind']; value: Result } | null>(null);
  const [retryConsent, setRetryConsent] = useState(false);
  const [loadedScope, setLoadedScope] = useState('');
  const [loadedEpoch, setLoadedEpoch] = useState(-1);
  const current = (id: string, n: number, e: number) =>
    scope.current === id && generation.current === n && actorContext === contextKey && epoch === e;
  const locked = getProformaLocked(contextKey);
  const ownAttempt = actorContext === contextKey && attempt?.owner === owner ? attempt : null;
  const writable =
    loadedScope === identity &&
    loadedEpoch === epoch &&
    !!options?.available &&
    ['admin', 'operator'].includes(options.current_role) &&
    (owner !== 'series' || options.current_role === 'admin') &&
    options.can_write &&
    (owner !== 'batch' || options.batch_available === true) &&
    !options.read_only &&
    !readOnly;
  const freshBlocked = !writable || externalWriteBlocked || locked || reading;
  useEffect(() => {
    resetProformaContext(contextKey);
    const notify = () => update((v) => v + 1);
    listeners.add(notify);
    notify();
    return () => {
      listeners.delete(notify);
      generation.current++;
    };
  }, [contextKey, readOnly, owner]);
  useEffect(() => {
    onLockedChange?.(locked);
  }, [locked, onLockedChange]);
  useEffect(() => {
    setOptions(null);
    setReply(null);
    setError('');
    setRetryConsent(false);
    setLoadedScope('');
    void load();
  }, [contextKey, readOnly, owner]);
  useEffect(() => {
    if (loadedEpoch !== epoch) {
      setOptions(null);
      setReply(null);
      setRetryConsent(false);
    }
    if (actorContext === contextKey && outcome?.owner === owner)
      setReply({ kind: outcome.kind, value: outcome.reply as Result });
  }, [revision, contextKey, owner]);
  function fail(e: unknown) {
    const message = e instanceof Error ? e.message : 'Nie udało się odczytać proformy.';
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      epoch++;
      attempt = null;
      inFlight = false;
      outcome = null;
      rejectedAttempts.clear();
      setOptions(null);
      setReply(null);
      setReading(false);
      publish();
    }
    if (e instanceof ApiError && e.status === 503) setOptions(null);
    setError(message);
    onError?.(message);
  }
  async function freshOptions() {
    async function checkActor() {
      const r = await api<{ user: { tenant_id: string; id: string; role: string } }>('/auth/me');
      if (!r.user || `${r.user.tenant_id}:${r.user.id}:${r.user.role}:${readOnly}` !== contextKey)
        throw new ApiError(
          'Kontekst użytkownika proformy zmienił się. Otwórz panel ponownie.',
          403,
        );
    }
    await checkActor();
    const result = await api<Options>('/proformas/options');
    checkOptions(result);
    if (!result.available) return { ...result, series: [] };
    if (!result.can_read) throw new ApiError('Brak aktualnego dostępu do proform.', 403);
    const series: Series[] = [],
      cursors = new Set<string>(),
      ids = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const r: Options & { data: Series[]; next_cursor: string | null } = await api(
        `/proformas/series${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      checkOptions(r);
      if (
        !r.available ||
        !r.can_read ||
        r.current_role !== result.current_role ||
        r.read_only !== result.read_only ||
        r.can_write !== result.can_write ||
        !Array.isArray(r.data) ||
        r.data.length > 50 ||
        (r.next_cursor !== null && !uuid(r.next_cursor))
      )
        throw new ApiError('Dostęp lub kompletność listy serii zmieniły się. Odśwież panel.', 403);
      for (const s of r.data) {
        if (!uuid(s.id) || ids.has(s.id) || s.version !== 1 || !s.name || !s.prefix || !s.seller)
          throw Error('Niespójna lista serii proform.');
        ids.add(s.id);
        series.push(s);
        if (series.length > 100) throw Error('Lista serii przekracza dozwolony zakres.');
      }
      if (r.next_cursor === null) {
        await checkActor();
        return { ...result, series };
      }
      if (!r.data.length || cursors.has(r.next_cursor))
        throw Error('Niepełna lista serii proform.');
      cursors.add(r.next_cursor);
      cursor = r.next_cursor;
    }
    throw Error('Lista serii przekracza zakres pełnego odczytu.');
  }
  async function load() {
    const id = identity,
      n = ++generation.current,
      e = epoch;
    setReading(true);
    try {
      const result = await freshOptions();
      if (!current(id, n, e)) return;
      setOptions(result);
      setLoadedScope(id);
      setLoadedEpoch(e);
      setError('');
    } catch (err) {
      if (current(id, n, e)) fail(err);
    } finally {
      if (current(id, n, e)) setReading(false);
    }
  }
  async function readData<T>(
    run: () => Promise<T>,
    validateRead?: (value: T) => void,
  ): Promise<T | null> {
    if (inFlight || reading) return null;
    const id = identity,
      n = ++generation.current,
      e = epoch;
    setReading(true);
    setError('');
    try {
      const access = await freshOptions();
      if (!current(id, n, e)) return null;
      if (
        !access.available ||
        !access.can_read ||
        (owner === 'batch' && access.batch_available !== true)
      )
        throw new ApiError('Podgląd zbiorczy proform nie jest dostępny w tej kopii.', 503);
      const result = await run();
      validateRead?.(result);
      const finalAccess = await freshOptions();
      if (!current(id, n, e)) return null;
      if (
        !finalAccess.available ||
        !finalAccess.can_read ||
        (owner === 'batch' && finalAccess.batch_available !== true)
      )
        throw new ApiError('Dostęp do odczytu zbiorczych proform zmienił się.', 403);
      setOptions(finalAccess);
      setLoadedScope(id);
      setLoadedEpoch(e);
      return result;
    } catch (err) {
      if (current(id, n, e)) fail(err);
      return null;
    } finally {
      if (current(id, n, e)) setReading(false);
    }
  }
  async function write(a: Attempt, retry = false) {
    if (!writable || inFlight || reading || (retry ? attempt !== a : freshBlocked)) return;
    const id = identity,
      n = ++generation.current,
      e = epoch;
    let sent = false;
    inFlight = true;
    publish();
    setError('');
    setRetryConsent(false);
    try {
      const access = await freshOptions();
      if (!current(id, n, e)) return;
      setOptions(access);
      if (
        !access.available ||
        access.read_only ||
        !access.can_write ||
        (a.kind.startsWith('batch-') && access.batch_available !== true) ||
        !['admin', 'operator'].includes(access.current_role) ||
        (a.kind === 'series' && access.current_role !== 'admin') ||
        readOnly
      )
        throw new ApiError(
          'Brak aktualnego dostępu do zapisu proformy.',
          access.read_only || readOnly ? 423 : 403,
        );
      if (liveExternalWriteBlocked.current) throw Error('Zapis proformy jest zablokowany przez inną zachowaną próbę.');
      attempt = a;
      sent = true;
      publish();
      const result = await api<Result>(a.path, 'POST', JSON.parse(a.body));
      if (actorContext !== a.context || epoch !== e) return;
      if (validate) validate(result, a);
      else checkReply(result as Reply, a);
      const currentAccess = await freshOptions();
      if (actorContext !== a.context || epoch !== e) return;
      if (
        !currentAccess.can_read ||
        !currentAccess.can_write ||
        (a.kind.startsWith('batch-') && currentAccess.batch_available !== true) ||
        !['admin', 'operator'].includes(currentAccess.current_role) ||
        (a.kind === 'series' && currentAccess.current_role !== 'admin') ||
        currentAccess.read_only ||
        readOnly
      )
        throw new ApiError(
          'Dostęp do proformy zmienił się po zapisie. Odczytaj dokument po odzyskaniu dostępu.',
          403,
        );
      outcome = { owner: a.owner, kind: a.kind, reply: result };
      attempt = null;
      publish();
      if (current(id, n, e)) {
        setReply({ kind: a.kind, value: result });
        setOptions(currentAccess);
      }
    } catch (err) {
      if (actorContext !== a.context || epoch !== e) return;
      if (sent && err instanceof ApiError && err.status === 409) {
        rejectedAttempts.set(`${a.owner}:${a.kind}:${a.path}`, {
          context: a.context,
          owner: a.owner,
          kind: a.kind,
          path: a.path,
          status: err.status,
        });
      }
      if (err instanceof ApiError && err.status < 500 && ![408, 429].includes(err.status))
        attempt = null;
      if (err instanceof ApiError && err.status === 423)
        setOptions((old) => (old ? { ...old, read_only: true, can_write: false } : old));
      if (current(id, n, e)) fail(err);
    } finally {
      if (actorContext === a.context && epoch === e) {
        inFlight = false;
        if (!sent && !retry) attempt = null;
        publish();
      }
    }
  }
  function submit(kind: Attempt['kind'], path: string, body: Record<string, unknown>) {
    if (freshBlocked) return;
    void write({
      context: contextKey,
      owner,
      kind,
      path,
      body: JSON.stringify({ ...body, client_key: crypto.randomUUID() }),
    });
  }
  return {
    options: loadedScope === identity && loadedEpoch === epoch ? options : null,
    reply: loadedScope === identity && loadedEpoch === epoch ? reply : null,
    error,
    load,
    readData,
    submit,
    ownAttempt,
    knownRejectedAttempts:
      actorContext === contextKey
        ? [...rejectedAttempts.values()].filter((a) => a.owner === owner)
        : [],
    writable,
    freshBlocked,
    locked,
    busy: reading || inFlight,
    retryConsent,
    setRetryConsent,
    retry: () => ownAttempt && void write(ownAttempt, true),
  };
}
export function AccessAndRetry({ io }: { io: ReturnType<typeof useProformaIO> }) {
  return (
    <>
      {io.error && (
        <p className="error" role="alert">
          {io.error}
        </p>
      )}
      {io.options && !io.options.available && (
        <p>Proformy nie są dostępne w tej kopii aplikacji.</p>
      )}
      {io.options?.read_only && <p>Kopia jest dostępna tylko do odczytu.</p>}
      {io.locked && !io.ownAttempt && (
        <p>Inna próba proformy nie została jeszcze rozstrzygnięta. Nowe zapisy są zablokowane.</p>
      )}
      {io.ownAttempt && (
        <div className="proforma-pending">
          <p>
            Wynik ostatniej próby nie jest rozstrzygnięty. Odczyt danych nie zastępuje ponowienia
            dokładnej próby.
          </p>
          <label>
            <input
              type="checkbox"
              checked={io.retryConsent}
              disabled={io.busy || !io.writable}
              onChange={(e) => io.setRetryConsent(e.target.checked)}
            />{' '}
            Chcę ponowić zachowane żądanie z tym samym kluczem
          </label>
          <button
            className="button"
            disabled={io.busy || !io.writable || !io.retryConsent}
            onClick={io.retry}
          >
            Ponów tę samą próbę
          </button>
        </div>
      )}
      <button className="button" disabled={io.busy} onClick={() => void io.load()}>
        Odśwież dostęp i serie
      </button>
    </>
  );
}
const blankDefinition = (): Definition => ({
  name: '',
  prefix: '',
  seller: { name: '', street: '', postal_code: '', city: '', country: 'PL' },
  payment_terms_days: 14,
  payment_instructions: '',
  notes: '',
});
export function ProformaSeriesPanel(props: SharedProps & { onChanged?: () => void }) {
  const io = useProformaIO(props, 'series');
  const [form, setForm] = useState<Definition>(blankDefinition);
  const identity = `${props.contextKey}:readonly=${props.readOnly}`;
  const [formScope, setFormScope] = useState(identity);
  useEffect(() => {
    setForm(blankDefinition());
    setFormScope(identity);
  }, [identity]);
  useEffect(() => {
    if (!io.options?.can_read) setForm(blankDefinition());
  }, [io.options?.can_read]);
  const observed = useRef<Reply | null>(null);
  useEffect(() => {
    if (io.reply?.kind === 'series' && observed.current !== io.reply.value) {
      observed.current = io.reply.value;
      notifySavedOnce(io.reply.value, props.onChanged);
      setForm(blankDefinition());
    }
  }, [io.reply, props.onChanged]);
  const invalid =
    !form.name.trim() ||
    !/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(form.prefix) ||
    Object.entries(form.seller).some(([key, value]) => key !== 'tax_id' && !value?.trim()) ||
    !/^[A-Z]{2}$/.test(form.seller.country) ||
    !Number.isInteger(form.payment_terms_days) ||
    form.payment_terms_days < 0 ||
    form.payment_terms_days > 365 ||
    [form.name, form.payment_instructions, form.notes, ...Object.values(form.seller)].some((v) =>
      /[\x00-\x1f\x7f-\x9f]/.test(v ?? ''),
    );
  return (
    <section className="panel proforma-panel">
      <div className="panel-heading">
        <h2>Serie proform</h2>
        <p>Własne dane sprzedawcy, numeracja i instrukcja płatności.</p>
      </div>
      <div className="info-body">
        <AccessAndRetry io={io} />
        <ul>
          {io.options?.series.map((s) => (
            <li key={s.id}>
              {s.name} · {s.prefix}
            </li>
          ))}
        </ul>
        {io.reply?.kind === 'series' && <p role="status">Seria została zapisana.</p>}
        {formScope === identity && io.options?.can_read && (
          <fieldset disabled={io.freshBlocked || io.options.current_role !== 'admin'}>
            <legend>Dodaj serię proform</legend>
            <div className="proforma-grid">
              <label>
                Nazwa serii
                <input
                  value={form.name}
                  maxLength={120}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                Prefiks numeru
                <input
                  value={form.prefix}
                  maxLength={12}
                  onChange={(e) => setForm({ ...form, prefix: e.target.value })}
                />
                <small>
                  Do 12 znaków: wielkie litery, cyfry i myślnik; pierwszy znak jest literą lub
                  cyfrą.
                </small>
              </label>
              {Object.entries({
                name: 'Nazwa sprzedawcy',
                street: 'Ulica i numer',
                postal_code: 'Kod pocztowy',
                city: 'Miasto',
                country: 'Kod kraju',
                tax_id: 'NIP (opcjonalnie)',
              }).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={form.seller[key as keyof Address] ?? ''}
                    onChange={(e) =>
                      setForm({ ...form, seller: { ...form.seller, [key]: e.target.value } })
                    }
                  />
                </label>
              ))}
              <label>
                Termin płatności (dni)
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={form.payment_terms_days}
                  onChange={(e) => setForm({ ...form, payment_terms_days: Number(e.target.value) })}
                />
              </label>
            </div>
            <label>
              Instrukcja płatności
              <input
                maxLength={2000}
                value={form.payment_instructions}
                onChange={(e) => setForm({ ...form, payment_instructions: e.target.value })}
              />
            </label>
            <label>
              Uwagi na proformie
              <input
                maxLength={2000}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </label>
            <button
              className="button primary"
              disabled={invalid}
              onClick={() => {
                const { tax_id, ...seller } = form.seller;
                io.submit('series', '/proformas/series', {
                  ...form,
                  seller: { ...seller, ...(tax_id?.trim() ? { tax_id: tax_id.trim() } : {}) },
                });
              }}
            >
              Zapisz serię proform
            </button>
          </fieldset>
        )}
      </div>
    </section>
  );
}
function money(value: unknown, currency: string) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^-?\d+$/.test(String(value)))
    return '—';
  const n = BigInt(String(value)),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}${a / 100n},${(a % 100n).toString().padStart(2, '0')} ${currency}`;
}
function DocumentLink({ document }: { document: Document }) {
  return (
    <a
      className="document-link"
      href={`/api/documents/${document.id}/print`}
      target="_blank"
      rel="noreferrer"
    >
      Proforma {document.number} · Otwórz wydruk
    </a>
  );
}
export function SnapshotView({ snapshot }: { snapshot: Snapshot }) {
  const s = snapshot;
  return (
    <div className="proforma-snapshot">
      <p>
        Zamówienie {s.order.number} · seria {s.series.name} ({s.series.prefix}) · {s.currency}
      </p>
      <div className="proforma-grid">
        <div>
          <h4>Sprzedawca</h4>
          <p>
            {s.seller.name}
            <br />
            {s.seller.street}
            <br />
            {s.seller.postal_code} {s.seller.city} · {s.seller.country}
          </p>
          {s.seller.tax_id && <p>NIP: {s.seller.tax_id}</p>}
        </div>
        <div>
          <h4>Kupujący</h4>
          <p>
            {s.buyer.name}
            <br />
            {s.buyer.email}
            <br />
            {s.buyer.address.street}
            <br />
            {s.buyer.address.postal_code} {s.buyer.address.city} · {s.buyer.address.country}
          </p>
          {s.buyer.tax_id && <p>NIP: {s.buyer.tax_id}</p>}
        </div>
      </div>
      <p>
        Data wystawienia: {s.issue_date} · termin płatności: {s.due_date} (
        {s.series.payment_terms_days} dni)
      </p>
      <div className="table-scroll">
        <table>
          <caption>Pełne historyczne pozycje zamówienia i dostawa</caption>
          <thead>
            <tr>
              <th>Pozycja</th>
              <th>Ilość</th>
              <th>Cena jednostkowa brutto</th>
              <th>VAT</th>
              <th>Netto</th>
              <th>VAT — kwota</th>
              <th>Brutto</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l, index) => (
              <tr key={l.item_id ?? `shipping:${index}`}>
                <td>
                  {l.kind === 'shipping' ? 'Dostawa' : l.name}
                  {l.sku && <small>{l.sku}</small>}
                </td>
                <td>{l.quantity}</td>
                <td>{money(l.unit_gross_minor, s.currency)}</td>
                <td>{l.vat_rate}%</td>
                <td>{money(l.net_minor, s.currency)}</td>
                <td>{money(l.vat_minor, s.currency)}</td>
                <td>{money(l.gross_minor, s.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <strong>
          Łącznie netto: {money(s.totals.net_minor, s.currency)} · VAT:{' '}
          {money(s.totals.vat_minor, s.currency)} · brutto:{' '}
          {money(s.totals.gross_minor, s.currency)}
        </strong>
      </p>
      <p>
        Kwoty pozycji zachowują ceny z zamówienia; nie są przeliczane według aktualnego katalogu.
      </p>
      {s.series.payment_instructions && (
        <p className="proforma-text">Instrukcja płatności: {s.series.payment_instructions}</p>
      )}
      {s.series.notes && <p className="proforma-text">Uwagi: {s.series.notes}</p>}
    </div>
  );
}
export function ProformaPanel(props: SharedProps & { order: Order; onChanged: () => void }) {
  const { order } = props;
  const io = useProformaIO(props, `order:${order.id}`);
  const [seriesId, setSeriesId] = useState(''),
    [shippingVat, setShippingVat] = useState(''),
    [consent, setConsent] = useState(false);
  const [hiddenPreview, setHiddenPreview] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const observed = useRef<Reply | null>(null);
  useEffect(() => {
    setSeriesId('');
    setShippingVat('');
    setConsent(false);
    setHiddenPreview(null);
  }, [props.contextKey, props.readOnly, order.id, String(order.version)]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (io.reply?.kind === 'issue' && observed.current !== io.reply.value) {
      observed.current = io.reply.value;
      setConsent(false);
      notifySavedOnce(io.reply.value, props.onChanged);
    }
  }, [io.reply, props.onChanged]);
  const saved =
    io.reply?.kind === 'issue'
      ? io.reply.value.document
      : order.documents?.find((d) => d.kind === 'proforma' && d.mode === 'local');
  const preview =
    io.reply?.kind === 'preview' &&
    io.reply.value.preview?.id !== hiddenPreview &&
    io.reply.value.preview?.order_version === String(order.version)
      ? io.reply.value.preview
      : null;
  const vat = /^\d{1,3}$/.test(shippingVat) ? Number(shippingVat) : -1;
  const invalidate = () => {
    setConsent(false);
    setHiddenPreview(preview?.id ?? null);
  };
  const expired = !preview || Date.parse(preview.expires_at) <= now;
  const rejectedPreview =
    !!preview &&
    io.knownRejectedAttempts.some(
      (a) =>
        a.kind === 'issue' &&
        a.status === 409 &&
        a.path === `/proformas/previews/${preview.id}/issue`,
    );
  useEffect(() => {
    if (rejectedPreview) setConsent(false);
  }, [rejectedPreview]);
  return (
    <section className="panel proforma-panel">
      <div className="panel-heading">
        <h2>Proforma lokalna</h2>
        <p>Wezwanie do zapłaty. Nie jest fakturą VAT i nie zapisuje wpłaty ani wydania towaru.</p>
      </div>
      <div className="info-body">
        <AccessAndRetry io={io} />
        {io.options?.can_read &&
          (saved ? (
            <DocumentLink document={saved} />
          ) : (
            <>
              <fieldset disabled={io.freshBlocked}>
                <legend>Dane podglądu</legend>
                <label>
                  Seria proform
                  <select
                    value={seriesId}
                    onChange={(e) => {
                      setSeriesId(e.target.value);
                      invalidate();
                    }}
                  >
                    <option value="">Wybierz serię</option>
                    {io.options?.series.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.prefix}
                      </option>
                    ))}
                  </select>
                </label>
                {!io.options?.series.length && (
                  <p>Dodaj serię proform w Dokumentach, a następnie odśwież ten panel.</p>
                )}
                <label>
                  VAT dostawy (%)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={shippingVat}
                    onChange={(e) => {
                      setShippingVat(e.target.value);
                      invalidate();
                    }}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={
                    !uuid(seriesId) ||
                    vat < 0 ||
                    vat > 100 ||
                    !/^[1-9][0-9]{0,18}$/.test(String(order.version))
                  }
                  onClick={() => {
                    setHiddenPreview(null);
                    setConsent(false);
                    io.submit('preview', `/proformas/orders/${order.id}/previews`, {
                      series_id: seriesId,
                      order_version: String(order.version),
                      shipping_vat: vat,
                    });
                  }}
                >
                  Przygotuj podgląd proformy
                </button>
              </fieldset>
              {preview && (
                <div className="proforma-review">
                  <h3>Pełny zapisany podgląd proformy</h3>
                  <SnapshotView snapshot={preview.snapshot} />
                  <p>
                    {expired
                      ? 'Podgląd wygasł. Przygotuj nowy podgląd.'
                      : `Podgląd ważny do ${date(preview.expires_at)}.`}
                  </p>
                  {rejectedPreview && (
                    <p className="error" role="alert">
                      Wystawienie tego podglądu zostało odrzucone z powodu konfliktu. Przygotuj nowy
                      podgląd bieżących danych przed ponowną zgodą.
                    </p>
                  )}
                  {preview.issued_document_id ? (
                    <DocumentLink
                      document={{
                        id: preview.issued_document_id,
                        number: 'z tego podglądu',
                        kind: 'proforma',
                        mode: 'local',
                      }}
                    />
                  ) : (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          checked={consent}
                          disabled={
                            io.freshBlocked || expired || rejectedPreview || !preview.can_issue
                          }
                          onChange={(e) => setConsent(e.target.checked)}
                        />{' '}
                        Potwierdzam dane sprzedawcy, kupującego, pozycje, VAT, dostawę i sumy tego
                        podglądu. Wystaw lokalną proformę.
                      </label>
                      <button
                        className="button primary"
                        disabled={
                          io.freshBlocked ||
                          expired ||
                          rejectedPreview ||
                          !consent ||
                          !preview.can_issue
                        }
                        onClick={() =>
                          !rejectedPreview &&
                          io.submit('issue', `/proformas/previews/${preview.id}/issue`, {
                            scope_hash: preview.scope_hash,
                            confirmed: true,
                            local_only: true,
                          })
                        }
                      >
                        Wystaw proformę z tego podglądu
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          ))}
      </div>
    </section>
  );
}
