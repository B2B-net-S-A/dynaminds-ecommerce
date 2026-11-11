import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date, money } from './api';
import './b2b-external-order-imports.css';

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_manage: boolean;
  can_read_value: boolean;
};
type Attempt = { path: string; body: string; role: string; action: 'preview' | 'execute' };
const attempts = new Map<string, Attempt>();
let rememberedContext = '';
export function resetExternalImportContext(contextKey: string, readOnly: boolean) {
  const actor = contextKey + ':' + readOnly;
  if (actor !== rememberedContext) {
    attempts.clear();
    rememberedContext = actor;
  }
}
export function hasExternalImportAttempt(contextKey: string, readOnly: boolean, inboundId: string) {
  return attempts.has(contextKey + ':' + readOnly + ':' + inboundId);
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : 'Nie udało się wykonać operacji.';
}
function count(text: string, maximum: number) {
  if (
    !/^(0|[1-9][0-9]*)$/.test(text) ||
    text.length > String(maximum).length ||
    BigInt(text) > BigInt(maximum)
  )
    throw Error('Ilość wymaga całej liczby od 0 do ' + maximum + '.');
  return Number(text);
}

function useExternalImportIO(contextKey: string, readOnly: boolean, inboundId: string) {
  const scope = contextKey + ':' + readOnly + ':' + inboundId;
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const epoch = useRef(0),
    gate = useRef(false);
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [purge, setPurge] = useState(0),
    [rejection, setRejection] = useState(0);
  const [accessRevision, setAccessRevision] = useState(0);
  const valid = (e: number) => epoch.current === e && liveScope.current === scope;
  function clearAttempt() {
    attempts.delete(scope);
    setPending(null);
  }
  function fail(e: unknown) {
    setError(errorText(e));
    if (e instanceof ApiError && [401, 403, 423].includes(e.status)) {
      clearAttempt();
      setFlags(null);
      setBlocked(true);
      setPurge((p) => p + 1);
    }
  }
  function acceptFlags(d: Flags, attempt?: Attempt) {
    if (
      (flags &&
        (flags.current_role !== d.current_role || flags.can_read_value !== d.can_read_value)) ||
      (attempt && attempt.role !== d.current_role)
    ) {
      clearAttempt();
      setFlags(null);
      setBlocked(true);
      setPurge((p) => p + 1);
      throw Error('Uprawnienia zmieniły się. Odczytaj źródło i historię ponownie.');
    }
    setFlags(d);
    if (d.read_only || !d.can_manage) clearAttempt();
  }
  useEffect(() => {
    resetExternalImportContext(contextKey, readOnly);
    ++epoch.current;
    gate.current = false;
    setBusy(false);
    setBlocked(false);
    setFlags(null);
    setError('');
    setNotice('');
    setPending(readOnly ? null : (attempts.get(scope) ?? null));
    setPurge((p) => p + 1);
    return () => {
      ++epoch.current;
      gate.current = false;
    };
  }, [scope, accessRevision]);
  async function read<T extends Flags>(fetcher: () => Promise<T>, accept: (d: T) => void) {
    if (gate.current || liveScope.current !== scope) return;
    gate.current = true;
    const e = epoch.current;
    setBusy(true);
    setError('');
    try {
      const d = await fetcher();
      if (!valid(e)) return;
      acceptFlags(d);
      const remembered = attempts.get(scope);
      if (remembered && remembered.role !== d.current_role) {
        clearAttempt();
        setPurge((p) => p + 1);
        throw Error('Rola zmieniła się. Próba została usunięta; odczytaj historię importu.');
      }
      accept(d);
    } catch (e2) {
      if (valid(e)) fail(e2);
    } finally {
      if (valid(e)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  const canWrite =
    !!flags?.available && !!flags.can_manage && !flags.read_only && !readOnly && !blocked;
  async function write<T extends Flags>(
    attempt: Attempt,
    accept: (d: T, action: Attempt['action']) => void,
  ) {
    if (!canWrite || gate.current || liveScope.current !== scope) return;
    const saved = attempts.get(scope);
    if (saved && (saved.path !== attempt.path || saved.body !== attempt.body)) {
      setError('Najpierw ustal wynik zachowanej próby.');
      return;
    }
    gate.current = true;
    const e = epoch.current;
    setBusy(true);
    setError('');
    setNotice('');
    attempts.set(scope, attempt);
    setPending(attempt);
    try {
      const d = await api<T>(attempt.path, 'POST', JSON.parse(attempt.body));
      if (!valid(e)) return;
      acceptFlags(d, attempt);
      if (d.read_only || !d.can_manage) {
        setPurge((p) => p + 1);
        setBlocked(true);
        throw Error('Dostęp zmienił się. Odczytaj zapisany wynik w historii.');
      }
      accept(d, attempt.action);
      clearAttempt();
    } catch (e2) {
      if (!valid(e)) return;
      if (
        e2 instanceof ApiError &&
        e2.status >= 400 &&
        e2.status < 500 &&
        ![408, 425, 429].includes(e2.status)
      ) {
        clearAttempt();
        if ([409, 422].includes(e2.status)) setRejection((r) => r + 1);
      }
      fail(e2);
    } finally {
      if (valid(e)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  return {
    flags,
    busy,
    blocked,
    pending,
    error,
    notice,
    purge,
    rejection,
    canWrite,
    read,
    write,
    setError,
    setNotice,
    accessRevision,
    reloadAccess: () => setAccessRevision((r) => r + 1),
    locked: busy || !!pending || blocked || readOnly || !!flags?.read_only,
    newAttempt: (path: string, body: object, action: Attempt['action']): Attempt => ({
      path,
      body: JSON.stringify(body),
      role: flags?.current_role ?? '',
      action,
    }),
    retry: <T extends Flags>(accept: (d: T, action: Attempt['action']) => void) => {
      const saved = attempts.get(scope);
      if (saved) void write<T>(saved, accept);
    },
  };
}

type Component = {
  product_id: string;
  quantity: number;
  sku: string;
  name: string;
  version: string;
};
type SourceLine = {
  source_index: number;
  remote_line_id: string;
  external_product_id: string;
  product_id: string;
  listing_id: string;
  sku: string;
  name: string;
  quantity: number;
  price?: number;
  line_total?: number;
  vat: number;
  product_version: string;
  components: Component[];
};
type Source = {
  inbound_id: string;
  channel_id: string;
  provider: string;
  external_id: string;
  source_hash: string;
  currency: string;
  total?: number;
  shipping_cost?: number;
  customer_name: string;
  email: string;
  address: Record<string, unknown>;
  payment: { payment_mode: string; paid_amount?: number; paid: boolean; declaration_only: true };
  lines: SourceLine[];
};
type Allocation = {
  remote_line_id: string;
  local_quantity: number;
  external_quantity: number;
  unassigned_quantity: number;
  link_id: string | null;
};
type PreviewRow = SourceLine &
  Omit<Allocation, 'remote_line_id'> & {
    customer_item_id: string;
    supplier_name: string | null;
  };
type Preview = {
  id: string;
  inbound_id: string;
  version: number;
  scope_hash: string;
  config: { warehouse_id: string; warehouse_name: string; allocations: Allocation[] };
  source: Source;
  rows: PreviewRow[];
  created_at: string;
  expires_at: string;
  executed_order_id: string | null;
  intent_id: string | null;
  can_execute: boolean;
};
type SourceReply = Flags & {
  source: Source;
  warehouses: { data: { id: string; name: string; code: string }[]; capped: boolean };
  links: { data: { id: string; supplier_name: string }[]; capped: boolean };
  limits: { items?: number; quantity?: number };
};
type PreviewReply = Flags & { preview: Preview; reused?: boolean };
type ExecuteReply = PreviewReply & {
  intent: { id: string; order_id: string; version: number };
  order: { id: string; number: string };
};
type HistoryReply = Flags & { data: Preview[]; meta: { cursor: string | null; total: number } };
type Draft = { local: string; external: string; unassigned: string; link: string };
export type B2bExternalOrderImportProps = {
  inboundId: string;
  contextKey: string;
  readOnly: boolean;
  warehouseId?: string;
  onImported: (order: { id: string; number: string }) => void;
  onClose: () => void;
};
export function B2bExternalOrderImport(props: B2bExternalOrderImportProps) {
  return (
    <ExternalImportWorkspace
      key={props.contextKey + ':' + props.readOnly + ':' + props.inboundId}
      {...props}
    />
  );
}
function amount(value: number | undefined, currency: string) {
  return typeof value === 'number' ? money(value, currency) : 'Brak dostępu do kwoty';
}
function Receiver({ source }: { source: Source }) {
  const address = ['street', 'postal_code', 'city', 'country', 'phone']
    .map((key) => source.address[key])
    .filter((v) => typeof v === 'string' && v.length > 0)
    .join(', ');
  return (
    <section>
      <h4>Odbiorca ze źródła</h4>
      <p>{source.customer_name}</p>
      <p>{source.email || 'Brak adresu email'}</p>
      <p>{address || 'Brak adresu dostawy'}</p>
    </section>
  );
}
function SourceSummary({ source, financial }: { source: Source; financial: boolean }) {
  return (
    <div className="external-import-summary">
      <Receiver source={source} />
      <section>
        <h4>Zamówienie źródłowe</h4>
        <p>
          {source.provider} · #{source.external_id}
        </p>
        <p>
          Waluta: {source.currency} · Pozycji: {source.lines.length}
        </p>
        {financial && (
          <>
            <p>Pełna kwota: {amount(source.total, source.currency)}</p>
            <p>Dostawa: {amount(source.shipping_cost, source.currency)}</p>
          </>
        )}
      </section>
      <section>
        <h4>Płatność klienta</h4>
        <p>{source.payment.payment_mode === 'cod' ? 'Pobranie' : 'Przedpłata'}</p>
        <p>
          {source.payment.paid
            ? 'Źródło oznacza zamówienie jako opłacone.'
            : 'Bez potwierdzenia opłacenia w źródle.'}
        </p>
        {financial && (
          <p>Deklarowana wpłata: {amount(source.payment.paid_amount, source.currency)}</p>
        )}
        <p className="muted">
          Deklaracja ze źródła. Import nie pobiera pieniędzy ani nie opłaca dostawcy.
        </p>
      </section>
    </div>
  );
}
function LineIdentity({ line }: { line: SourceLine }) {
  return (
    <>
      <strong>
        {line.sku} · {line.name}
      </strong>
      <small>Pozycja źródłowa {line.source_index + 1}</small>
      <details>
        <summary>ID pozycji i oferty</summary>
        <small>Pozycja: {line.remote_line_id}</small>
        <small>Oferta: {line.external_product_id}</small>
        <small>Wersja produktu: {line.product_version}</small>
      </details>
      <details>
        <summary>Składniki realizacji ({line.components.length})</summary>
        {line.components.map((c) => (
          <small key={c.product_id}>
            {c.sku} · {c.name} · {c.quantity} na jednostkę pozycji
          </small>
        ))}
      </details>
    </>
  );
}
function ExternalImportWorkspace({
  inboundId,
  contextKey,
  readOnly,
  warehouseId,
  onImported,
  onClose,
}: B2bExternalOrderImportProps) {
  const io = useExternalImportIO(contextKey, readOnly, inboundId);
  const [sourceReply, setSourceReply] = useState<SourceReply | null>(null);
  const [warehouse, setWarehouse] = useState(warehouseId ?? '');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<ExecuteReply | null>(null);
  const [history, setHistory] = useState<Preview[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyTotal, setHistoryTotal] = useState<number | null>(null);
  const appliedPurge = useRef(io.purge);
  function acceptSource(d: SourceReply) {
    if (!d.available) {
      setSourceReply(null);
      return;
    }
    if (!d.source)
      throw Error('Odpowiedź nie zawiera danych źródłowych. Odczytaj historię importu.');
    if (d.source.inbound_id !== inboundId)
      throw Error('Źródło odpowiedzi nie odpowiada wybranemu zamówieniu.');
    if (
      !d.source.lines.length ||
      d.source.lines.length > 100 ||
      new Set(d.source.lines.map((l) => l.remote_line_id)).size !== d.source.lines.length
    )
      throw Error('Niekompletny lub niejednoznaczny zakres pozycji źródłowych.');
    setSourceReply(d);
    setWarehouse((w) => (d.warehouses.data.some((x) => x.id === w) ? w : ''));
    setDrafts(
      Object.fromEntries(
        d.source.lines.map((l) => [
          l.remote_line_id,
          { local: String(l.quantity), external: '0', unassigned: '0', link: '' },
        ]),
      ),
    );
  }
  function validatePreview(p: Preview) {
    if (
      p.inbound_id !== inboundId ||
      !p.rows.length ||
      p.rows.length > 100 ||
      p.rows.length !== p.source.lines.length ||
      new Set(p.rows.map((r) => r.remote_line_id)).size !== p.rows.length ||
      p.rows.some((r) => !p.source.lines.some((l) => l.remote_line_id === r.remote_line_id))
    )
      throw Error('Podgląd nie zawiera całego zakresu wybranego źródła. Odczytaj źródło ponownie.');
  }
  function acceptPreview(d: PreviewReply) {
    if (!d.available) {
      setPreview(null);
      return;
    }
    validatePreview(d.preview);
    setPreview(d.preview);
    setConfirmed(false);
    setResult(null);
  }
  function acceptMutation(d: PreviewReply | ExecuteReply, action: Attempt['action']) {
    acceptPreview(d);
    if (action === 'execute') {
      if (
        !('order' in d) ||
        !d.order?.id ||
        !d.intent?.order_id ||
        d.intent.order_id !== d.order.id
      )
        throw Error(
          'Odpowiedź nie zawiera wyniku importu. Odczytaj historię przed następną próbą.',
        );
      setResult(d);
      io.setNotice(
        d.reused
          ? 'Odczytano wynik wcześniej zatwierdzonego importu.'
          : 'Zaimportowano zamówienie z podziałem realizacji. Zamówienie dostawcy wymaga osobnej wyceny i zgody.',
      );
      onImported(d.order);
    } else
      io.setNotice(
        d.reused
          ? 'Odczytano podgląd wcześniej zapisanej dokładnej próby.'
          : 'Zapisano pełny podgląd. Przejrzyj go przed importem.',
      );
  }
  useEffect(() => {
    const saved = attempts.get(contextKey + ':' + readOnly + ':' + inboundId);
    const restoredPreview =
      saved?.action === 'execute' ? saved.path.replace(/\/execute$/, '') : null;
    void io.read<PreviewReply | SourceReply>(
      () =>
        restoredPreview
          ? api<PreviewReply>(restoredPreview)
          : api<SourceReply>(`/imports/${inboundId}/external-intent-source`),
      (d) => {
        if ('preview' in d) acceptPreview(d);
        else acceptSource(d);
      },
    );
  }, [io.accessRevision]);
  useEffect(() => {
    if (appliedPurge.current === io.purge) return;
    appliedPurge.current = io.purge;
    setSourceReply(null);
    setPreview(null);
    setResult(null);
    setDrafts({});
    setConfirmed(false);
    setHistory([]);
    setCursor(null);
    setHistoryLoaded(false);
    setHistoryTotal(null);
  }, [io.purge]);
  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
  }, [io.rejection]);
  const readable = !!io.flags?.can_read && !io.blocked;
  const source = readable ? (preview?.source ?? sourceReply?.source ?? null) : null;
  const financial = !!io.flags?.can_read_value;
  const locked = io.locked;
  function invalidate() {
    setPreview(null);
    setConfirmed(false);
    setResult(null);
    io.setNotice('');
  }
  function edit(id: string, key: keyof Draft, value: string) {
    if (locked) return;
    invalidate();
    setDrafts((ds) => ({ ...ds, [id]: { ...ds[id], [key]: value } }));
  }
  function prepare() {
    if (!sourceReply || !io.canWrite || locked) return;
    try {
      if (!sourceReply.warehouses.data.some((w) => w.id === warehouse))
        throw Error('Wybierz własny magazyn importu.');
      const allocations: Allocation[] = sourceReply.source.lines.map((l) => {
        const draft = drafts[l.remote_line_id];
        if (!draft) throw Error('Brakuje przydziału pozycji źródłowej.');
        const local = count(draft.local, 100000),
          external = count(draft.external, 100000),
          unassigned = count(draft.unassigned, 100000);
        if (local + external + unassigned !== l.quantity)
          throw Error(`Pozycja ${l.source_index + 1}: podział musi sumować się do ${l.quantity}.`);
        if (external && !sourceReply.links.data.some((link) => link.id === draft.link))
          throw Error(`Pozycja ${l.source_index + 1}: wybierz własnego dostawcę.`);
        return {
          remote_line_id: l.remote_line_id,
          local_quantity: local,
          external_quantity: external,
          unassigned_quantity: unassigned,
          link_id: external ? draft.link : null,
        };
      });
      const attempt = io.newAttempt(
        `/imports/${inboundId}/external-intent-previews`,
        {
          client_key: crypto.randomUUID(),
          warehouse_id: warehouse,
          expected_source_hash: sourceReply.source.source_hash,
          allocations,
        },
        'preview',
      );
      void io.write<PreviewReply>(attempt, acceptMutation);
    } catch (e) {
      io.setError(errorText(e));
    }
  }
  function execute() {
    if (
      !preview ||
      !preview.can_execute ||
      preview.executed_order_id ||
      !confirmed ||
      !io.canWrite ||
      locked
    )
      return;
    const attempt = io.newAttempt(
      `/import-external-intent-previews/${preview.id}/execute`,
      {
        client_key: crypto.randomUUID(),
        version: preview.version,
        scope_hash: preview.scope_hash,
        confirmed: true,
      },
      'execute',
    );
    void io.write<ExecuteReply>(attempt, acceptMutation);
  }
  function loadHistory(next: string | null = null) {
    const q = new URLSearchParams({ limit: '25', inbound_id: inboundId });
    if (next) q.set('cursor', next);
    void io.read(
      () => api<HistoryReply>('/import-external-intent-previews?' + q),
      (d) => {
        setHistory(d.data);
        setCursor(d.meta.cursor);
        setHistoryTotal(d.meta.total);
        setHistoryLoaded(true);
      },
    );
  }
  function loadSource() {
    if (io.pending) return;
    invalidate();
    setSourceReply(null);
    setDrafts({});
    void io.read(
      () => api<SourceReply>(`/imports/${inboundId}/external-intent-source`),
      (d) => {
        acceptSource(d);
      },
    );
  }
  return (
    <div className="external-import-panel">
      <div className="external-import-header">
        <div>
          <h3>Import z podziałem realizacji</h3>
          <p>
            Kwoty i odbiorca pochodzą z kanału. Wybierz część realizowaną lokalnie, przez dostawcę
            lub później.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={io.busy || !!io.pending}
          onClick={onClose}
        >
          Wróć do kolejki
        </button>
      </div>
      <p className="external-import-notice">
        Import tworzy lokalne zamówienie i intencję realizacji. Rezerwuje tylko część lokalną. Nie
        składa zamówienia u dostawcy, nie tworzy przyjęcia towaru i nie uruchamia wysyłki.
        Dostępność części lokalnej zostanie sprawdzona przy imporcie.
      </p>
      {io.error && (
        <div className="external-import-error" role="alert">
          {io.error}
        </div>
      )}
      {io.blocked && (
        <button type="button" className="button" disabled={io.busy} onClick={io.reloadAccess}>
          Odczytaj dostęp ponownie
        </button>
      )}
      {io.notice && (
        <div className="external-import-notice" role="status">
          {io.notice}
        </div>
      )}
      {io.busy && <p role="status">Oczekiwanie na odpowiedź…</p>}
      {!source && !io.flags && !io.error && <p>Odczytywanie pełnego źródła…</p>}
      {io.flags && !io.flags.available && (
        <p>
          Ta kopia nie obsługuje importu z intencją dostawcy. Historia może wymagać nowszej wersji
          aplikacji.
        </p>
      )}
      {(readOnly || io.flags?.read_only) && (
        <p className="external-import-notice">
          Tylko odczyt. Import i zmiana podziału są zablokowane.
        </p>
      )}
      {io.flags?.available && !io.flags.can_manage && (
        <p>Tego dostępu nie można użyć do zatwierdzenia importu.</p>
      )}
      {io.pending && (
        <div className="external-import-notice" role="alert">
          <strong>
            Zachowano dokładną próbę {io.pending.action === 'execute' ? 'importu' : 'podglądu'}.
          </strong>
          <p>
            Nie wykonuj zwykłego importu tego źródła. Nowe zapisy są wstrzymane. Ponowienie wyśle tę
            samą treść i klucz. Po przeładowaniu aplikacji najpierw odczytaj historię.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={io.busy || !io.canWrite}
            onClick={() => io.retry<PreviewReply | ExecuteReply>(acceptMutation)}
          >
            Ponów dokładną próbę
          </button>
        </div>
      )}
      <div className="external-import-actions">
        <button
          type="button"
          className="button"
          disabled={io.busy || !!io.pending || io.blocked}
          onClick={loadSource}
        >
          Odczytaj źródło ponownie
        </button>
        <button
          type="button"
          className="button"
          disabled={io.busy || io.blocked}
          onClick={() => loadHistory()}
        >
          Odczytaj historię importów z intencją
        </button>
      </div>
      {source && <SourceSummary source={source} financial={financial} />}
      {readable && sourceReply && !result && !preview?.executed_order_id && (
        <>
          <div className="external-import-fields">
            <label>
              Magazyn importu
              <select
                value={warehouse}
                disabled={locked}
                onChange={(e) => {
                  invalidate();
                  setWarehouse(e.target.value);
                }}
              >
                <option value="">Wybierz magazyn</option>
                {sourceReply.warehouses.data.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} · {w.code}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(sourceReply.warehouses.capped || sourceReply.links.capped) && (
            <p className="external-import-notice">
              Lista wyboru ma ograniczony zakres. Niewidocznych magazynów lub dostawców nie
              wybieramy automatycznie.
            </p>
          )}
          <p>
            Każda pozycja pozostaje osobna, także przy tym samym SKU. Cena jednostkowa jest ilorazem
            pełnej kwoty i ilości z zaokrągleniem w dół; pełna kwota pozycji pozostaje wiążąca. VAT
            pochodzi z lokalnego katalogu.
          </p>
          <div className="external-import-scroll">
            <table className="external-import-lines">
              <thead>
                <tr>
                  <th>Pozycja i składniki</th>
                  <th>Pełna ilość</th>
                  {financial && <th>Kwota źródłowa / VAT</th>}
                  <th>Lokalnie</th>
                  <th>Do dostawcy</th>
                  <th>Nieprzydzielone</th>
                  <th>Dostawca intencji</th>
                </tr>
              </thead>
              <tbody>
                {sourceReply.source.lines.map((l) => (
                  <tr key={l.remote_line_id}>
                    <td>
                      <LineIdentity line={l} />
                    </td>
                    <td>{l.quantity}</td>
                    {financial && (
                      <td>
                        {amount(l.line_total, sourceReply.source.currency)}
                        <small>
                          Jednostkowo: {amount(l.price, sourceReply.source.currency)} · VAT {l.vat}%
                        </small>
                      </td>
                    )}
                    {(['local', 'external', 'unassigned'] as const).map((field, i) => (
                      <td key={field}>
                        <input
                          inputMode="numeric"
                          aria-label={`${['Lokalnie', 'Do dostawcy', 'Nieprzydzielone'][i]} — pozycja ${l.source_index + 1}`}
                          value={drafts[l.remote_line_id]?.[field] ?? ''}
                          disabled={locked}
                          onChange={(e) => edit(l.remote_line_id, field, e.target.value)}
                        />
                      </td>
                    ))}
                    <td>
                      <select
                        aria-label={`Dostawca intencji — pozycja ${l.source_index + 1}`}
                        value={drafts[l.remote_line_id]?.link ?? ''}
                        disabled={locked}
                        onChange={(e) => edit(l.remote_line_id, 'link', e.target.value)}
                      >
                        <option value="">Wybierz dostawcę</option>
                        {sourceReply.links.data.map((link) => (
                          <option key={link.id} value={link.id}>
                            {link.supplier_name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="button primary"
            disabled={locked || !io.canWrite || !sourceReply.source.lines.length}
            onClick={prepare}
          >
            Przygotuj pełny podgląd importu
          </button>
        </>
      )}
      {readable && preview && (
        <section>
          <h3>
            {result || preview.executed_order_id
              ? 'Podgląd zatwierdzonego importu'
              : 'Trwały podgląd przed importem'}
          </h3>
          <p>
            {preview.rows.length} pozycji · {date(preview.created_at)}
            {!result && !preview.executed_order_id && (
              <> · podgląd ważny do {date(preview.expires_at)}</>
            )}
          </p>
          <p>
            Magazyn:{' '}
            {preview.config.warehouse_name ??
              sourceReply?.warehouses.data.find((w) => w.id === preview.config.warehouse_id)
                ?.name ??
              preview.config.warehouse_id}
          </p>
          <div className="external-import-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pozycja źródłowa</th>
                  <th>Pełna ilość</th>
                  {financial && <th>Kwota / VAT</th>}
                  <th>Lokalnie</th>
                  <th>Do dostawcy</th>
                  <th>Nieprzydzielone</th>
                  <th>Dostawca</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.customer_item_id}>
                    <td>
                      <LineIdentity line={r} />
                    </td>
                    <td>{r.quantity}</td>
                    {financial && (
                      <td>
                        {amount(r.line_total, preview.source.currency)}
                        <small>
                          Jednostkowo: {amount(r.price, preview.source.currency)} · VAT {r.vat}%
                        </small>
                      </td>
                    )}
                    <td>{r.local_quantity}</td>
                    <td>{r.external_quantity}</td>
                    <td>{r.unassigned_quantity}</td>
                    <td>
                      {r.link_id
                        ? (r.supplier_name ??
                          sourceReply?.links.data.find((l) => l.id === r.link_id)?.supplier_name ??
                          r.link_id)
                        : 'Bez dostawcy'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Identyfikatory podglądu</summary>
            <p>
              {preview.id} · wersja {preview.version}
            </p>
            <p>{preview.scope_hash}</p>
          </details>
          {!result && !preview.executed_order_id && (
            <>
              <label className="external-import-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={locked || !io.canWrite || !preview.can_execute}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  Potwierdzam wszystkie pozycje, oryginalne kwoty, odbiorcę i pokazany podział
                  realizacji. Import nie składa zamówienia u dostawcy.
                </span>
              </label>
              <button
                type="button"
                className="button primary"
                disabled={locked || !io.canWrite || !preview.can_execute || !confirmed}
                onClick={execute}
              >
                Zaimportuj zamówienie z intencją dostawcy
              </button>
            </>
          )}
          {!result && preview.executed_order_id && (
            <div className="external-import-notice" role="status">
              <strong>Ten podgląd został już zaimportowany.</strong>
              <p>
                Nie zatwierdzaj nowej próby. Odczytaj utworzone zamówienie lub ponów zachowaną
                dokładną próbę, aby odzyskać jej odpowiedź.
              </p>
              <button
                type="button"
                className="button"
                disabled={io.busy || io.blocked}
                onClick={() => {
                  const p = preview;
                  void io.read(
                    () =>
                      api<
                        Flags & {
                          intent: { id: string; order_id: string; version: number } | null;
                          order: { id: string; number: string };
                        }
                      >(`/b2b/external-order-intents/orders/${p.executed_order_id}`),
                    (d) => {
                      if (
                        !d.intent ||
                        d.intent.id !== p.intent_id ||
                        d.order.id !== p.executed_order_id
                      )
                        throw Error('Wynik nie odpowiada zapisanej intencji importu.');
                      setResult({ ...d, preview: p, intent: d.intent, reused: true });
                      io.setNotice('Odczytano utworzone zamówienie i jego bieżącą intencję.');
                      onImported(d.order);
                    },
                  );
                }}
              >
                Odczytaj utworzone zamówienie
              </button>
              <details>
                <summary>Identyfikatory wyniku</summary>
                <p>Zamówienie: {preview.executed_order_id}</p>
                <p>Intencja: {preview.intent_id}</p>
              </details>
            </div>
          )}
          {!result && !preview.executed_order_id && !preview.can_execute && (
            <p className="external-import-notice">
              Ten podgląd nie pozwala na nowy import. Odczytaj historię lub przygotuj aktualny
              podgląd po odczytaniu źródła.
            </p>
          )}
        </section>
      )}
      {readable && result && (
        <div className="external-import-notice" role="status">
          <strong>Zaimportowano {result.order.number}.</strong>
          <p>
            Intencja wersja {result.intent.version}. Zlecenie dostawcy wymaga osobnej wyceny i zgody
            w sieci B2B.
          </p>
        </div>
      )}
      {readable && historyLoaded && (
        <section>
          <h3>Historia importów z intencją</h3>
          <p>
            Na stronie: {history.length}
            {typeof historyTotal === 'number' ? ` · w zakresie: ${historyTotal}` : ''}
          </p>
          {!history.length && <p>Zakończono odczyt. W tym zakresie nie ma podglądów.</p>}
          <div className="external-import-history">
            {history.map((p) => (
              <button
                type="button"
                className="button"
                key={p.id}
                disabled={io.busy || io.blocked}
                onClick={() =>
                  void io.read(
                    () => api<PreviewReply>(`/import-external-intent-previews/${p.id}`),
                    (d) => {
                      if (d.preview.inbound_id !== inboundId) {
                        io.setError(
                          'Ten podgląd dotyczy innego źródła. Otwórz właściwe zamówienie w kolejce.',
                        );
                        return;
                      }
                      acceptPreview(d);
                    },
                  )
                }
              >
                #{p.source.external_id} · {p.rows.length} pozycji · {date(p.created_at)}
              </button>
            ))}
          </div>
          {cursor && (
            <button
              type="button"
              className="button"
              disabled={io.busy || io.blocked}
              onClick={() => loadHistory(cursor)}
            >
              Następna strona historii
            </button>
          )}
        </section>
      )}
    </div>
  );
}
