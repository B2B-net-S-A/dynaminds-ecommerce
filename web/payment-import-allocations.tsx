import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './payment-import-allocations.css';

export type PaymentAllocationSource = { previewId: string; rowId: string; position?: number };
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_write: boolean;
};
type Source = {
  source_preview_id: string;
  source_row_id: string;
  source_version: number;
  gross_minor: number | string;
  available_minor: number | string;
  fee_minor: number | string;
  remaining_minor: number | string;
  remaining_amount_minor: string;
  remaining_fee_minor: string;
  currency: string;
  ledger_kind: string;
  transaction_id: string;
  can_allocate: boolean;
};
type Options = Flags & { source?: Source | null };
type Balance = Record<string, number | string | null | undefined>;
type ShipmentSums = Record<string, number | string | null | undefined>;
type Order = {
  id: string;
  number: string;
  currency: string;
  payment_mode?: string;
  payment?: Balance;
  shipments: Array<{
    id: string;
    carrier: string;
    tracking_number: string;
    dispatched_at: string | null;
    cod_expected?: number;
  }>;
};
type Allocation = {
  index: number;
  order_id: string;
  shipment_id: string | null;
  amount_minor: number;
  fee_minor: number;
  before: {
    order: { id: string; number: string; currency: string };
    owner?: { id: string; number: string };
    balance: Balance;
    shipment?: Order['shipments'][number] | null;
    shipment_sums?: ShipmentSums | null;
  };
  after?: { balance: Balance; shipment_sums: ShipmentSums | null } | null;
  before_balance?: Balance;
  after_balance?: Balance;
  after_shipment_sums?: ShipmentSums | null;
  entry_id?: string;
};
type Head = {
  id: string;
  version: number;
  scope_hash: string;
  created_at: string;
  source_preview_id: string;
  source_row_id: string;
  source_version: number;
  expires_at?: string;
  summary: {
    count: number;
    amount_minor: number | string;
    fee_minor: number | string;
    unallocated_minor: number | string;
    unallocated_fee_minor: number | string;
    currency: string;
  };
  can_execute?: boolean;
  executed_execution_id?: string | null;
  preview_id?: string;
  state?: string;
};
type Reply = Flags & {
  preview?: Head;
  execution?: Head;
  allocations: Allocation[];
  source: Source;
  reused?: boolean;
};
type Draft = { key: string; order: Order; shipmentId: string; amount: string; fee: string };
type Attempt = {
  context: string;
  identity: string;
  path: string;
  serialized: string;
  kind: 'preview' | 'execute';
  source: PaymentAllocationSource;
};
const prefix = '/payment-import-allocations';
const ledgerNames: Record<string, string> = {
  receipt: 'Wpłata klienta',
  courier_collection: 'Pobranie od kupującego przez kuriera',
  courier_remittance: 'Przekazanie pobrania sprzedawcy',
};
const retained: {
  context: string;
  identity: string;
  epoch: number;
  attempt: Attempt | null;
  flight: Attempt | null;
  outcome: { kind: 'preview' | 'execute'; reply: Reply } | null;
} = { context: '', identity: '', epoch: 0, attempt: null, flight: null, outcome: null };
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((f) => f());
export const getPaymentImportAllocationsLocked = (contextKey: string) =>
  retained.context === contextKey && Boolean(retained.attempt || retained.flight);
export function subscribePaymentImportAllocationsLock(
  contextKey: string,
  callback: (locked: boolean) => void,
) {
  const notify = () => callback(getPaymentImportAllocationsLocked(contextKey));
  listeners.add(notify);
  notify();
  return () => {
    listeners.delete(notify);
  };
}
export function resetPaymentImportAllocationsContext(contextKey: string) {
  retained.context = contextKey;
  retained.identity = '';
  ++retained.epoch;
  retained.attempt = null;
  retained.flight = null;
  retained.outcome = null;
  publish();
}
const uuid = (s: unknown): s is string =>
  typeof s === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
function integer(value: unknown): bigint {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value)))
    throw Error('Nieprawidłowa kwota w odpowiedzi.');
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw Error('Nieprawidłowa kwota w odpowiedzi.');
  return BigInt(value);
}
function minor(text: string): number | null {
  const m = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const n = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  return n <= 2147483647n ? Number(n) : null;
}
function money(value: unknown, currency: string) {
  if (value === null || value === undefined || !/^-?\d+$/.test(String(value))) return '—';
  const n = BigInt(String(value)),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${(a % 100n).toString().padStart(2, '0')} ${currency}`;
}
function checkFlags(r: Flags) {
  if (
    typeof r.available !== 'boolean' ||
    typeof r.read_only !== 'boolean' ||
    typeof r.can_read !== 'boolean' ||
    typeof r.can_write !== 'boolean' ||
    typeof r.current_role !== 'string'
  )
    throw Error('Niepełna odpowiedź uprawnień podziału wpłaty.');
}
function validateReply(r: Reply, kind: 'preview' | 'execute') {
  checkFlags(r);
  if (!r.available || !r.can_read || r.current_role !== 'admin')
    throw new ApiError('Brak aktualnego dostępu do trwałego podziału wpłaty.', 403);
  const h = kind === 'preview' ? r.preview : r.execution;
  if (
    !h ||
    !uuid(h.id) ||
    h.version !== 1 ||
    !uuid(h.source_preview_id) ||
    !uuid(h.source_row_id) ||
    !/^[a-f0-9]{64}$/.test(h.scope_hash) ||
    !h.summary ||
    !Array.isArray(r.allocations) ||
    r.allocations.length < 1 ||
    r.allocations.length > 100 ||
    h.summary.count !== r.allocations.length ||
    !r.source ||
    r.source.source_preview_id !== h.source_preview_id ||
    r.source.source_row_id !== h.source_row_id ||
    h.summary.currency !== r.source.currency
  )
    throw Error('Niepełny trwały wynik podziału. Zachowano dokładną próbę.');
  let amount = 0n,
    fee = 0n;
  const pairs = new Set<string>();
  r.allocations.forEach((row, i) => {
    const pair = `${row.order_id}:${row.shipment_id ?? ''}`;
    if (
      row.index !== i ||
      !uuid(row.order_id) ||
      (row.shipment_id !== null && !uuid(row.shipment_id)) ||
      !row.before?.order ||
      row.before.order.id !== row.order_id ||
      row.before.order.currency !== h.summary.currency ||
      !row.after?.balance ||
      row.after.balance.currency !== h.summary.currency ||
      pairs.has(pair) ||
      (kind === 'execute' && (!uuid(row.entry_id) || !row.after_balance))
    )
      throw Error('Niespójny zakres trwałego podziału wpłaty.');
    amount += integer(row.amount_minor);
    fee += integer(row.fee_minor);
    pairs.add(pair);
  });
  if (amount !== integer(h.summary.amount_minor) || fee !== integer(h.summary.fee_minor))
    throw Error('Sumy trwałego podziału nie zgadzają się z pełnym zakresem.');
  return h;
}
function BalanceView({ balance, currency }: { balance: Balance | undefined; currency: string }) {
  if (!balance) return <span>Brak odczytu salda</span>;
  const labels: Record<string, string> = {
    received: 'Wpłacono',
    refunded: 'Zwrócono klientowi',
    credit: 'Uznane pomniejszenie należności',
    amount_due: 'Do zapłaty',
    overpayment: 'Nadpłata',
  };
  return (
    <>
      <strong>Saldo klienta</strong>
      {Object.entries(labels)
        .filter(([key]) => balance[key] !== undefined && balance[key] !== null)
        .map(([key, label]) => (
          <small key={key}>
            {label}: {money(balance[key], currency)}
          </small>
        ))}
      {['collected', 'remitted', 'fees', 'courier_due'].some((key) => balance[key] != null) && (
        <>
          <strong>Rozliczenie COD zamówienia</strong>
          <CodValues values={balance} currency={currency} />
        </>
      )}
    </>
  );
}
function CodValues({ values, currency }: { values: Balance; currency: string }) {
  const labels: Record<string, string> = {
    collected: 'Pobrano od klienta',
    remitted: 'Przekazano sprzedawcy (bez prowizji)',
    fees: 'Prowizje',
    courier_due: 'Pozostało do rozliczenia przez kuriera',
    settled: 'Rozliczono łącznie z prowizją',
  };
  return (
    <>
      {Object.entries(labels)
        .filter(([key]) => values[key] != null)
        .map(([key, label]) => (
          <small key={key}>
            {label}: {money(values[key], currency)}
          </small>
        ))}
    </>
  );
}
function ShipmentSumsView({
  values,
  currency,
  title,
}: {
  values: ShipmentSums | null | undefined;
  currency: string;
  title: string;
}) {
  return (
    <>
      <strong>{title}</strong>
      {values ? (
        <CodValues values={values} currency={currency} />
      ) : (
        <small>Ten zapis nie zawiera potwierdzonych sum rozliczenia przesyłki.</small>
      )}
    </>
  );
}
function AllocationTable({
  rows,
  currency,
  execution,
}: {
  rows: Allocation[];
  currency: string;
  execution: boolean;
}) {
  return (
    <div className="table-scroll">
      <table>
        <caption>
          {execution
            ? 'Potwierdzone saldo przed i po zapisie'
            : 'Saldo przed i przewidywane saldo po całym podziale'}
        </caption>
        <thead>
          <tr>
            <th>Zamówienie / przesyłka</th>
            <th>Przydział</th>
            <th>Saldo przed</th>
            <th>{execution ? 'Saldo po zapisie' : 'Przewidywane saldo po całym podziale'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index}>
              <td>
                {r.before.order.number}
                {r.before.owner && r.before.owner.id !== r.order_id && (
                  <small>Właściciel salda: {r.before.owner.number}</small>
                )}
                <small>
                  {r.before.shipment?.carrier} {r.before.shipment?.tracking_number}
                </small>
              </td>
              <td>
                {money(r.amount_minor, currency)}
                <small>Prowizja {money(r.fee_minor, currency)}</small>
              </td>
              <td>
                <BalanceView balance={r.before_balance ?? r.before.balance} currency={currency} />
                {r.shipment_id && (
                  <ShipmentSumsView
                    values={r.before.shipment_sums}
                    currency={currency}
                    title="Rozliczenie tej przesyłki przed podziałem"
                  />
                )}
              </td>
              <td>
                <BalanceView
                  balance={execution ? r.after_balance : r.after?.balance}
                  currency={currency}
                />
                {r.shipment_id && (
                  <ShipmentSumsView
                    values={execution ? r.after_shipment_sums : r.after?.shipment_sums}
                    currency={currency}
                    title={
                      execution
                        ? 'Potwierdzone rozliczenie tej przesyłki po zapisie'
                        : 'Przewidywane rozliczenie tej przesyłki po całym podziale'
                    }
                  />
                )}
                {!execution && <small>Podgląd — żadnej wpłaty nie zapisano.</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function PaymentImportAllocationsPanel({
  contextKey,
  readOnly,
  source,
  externalWriteBlocked = false,
  onError,
  onApplied,
  onSourceSelected,
}: {
  contextKey: string;
  readOnly: boolean;
  source: PaymentAllocationSource | null;
  externalWriteBlocked?: boolean;
  onError?: (message: string) => void;
  onApplied?: () => void;
  onSourceSelected?: (source: PaymentAllocationSource) => void;
}) {
  const identity = `${contextKey}:readonly=${readOnly}`;
  const scope = useRef(identity);
  scope.current = identity;
  const mounted = useRef(true),
    generation = useRef(0),
    busyRef = useRef(false);
  const [revision, setRevision] = useState(0),
    [options, setOptions] = useState<Options | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [search, setSearch] = useState(''),
    [orders, setOrders] = useState<Array<{ id: string; number: string; currency: string }>>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [orderUuid, setOrderUuid] = useState('');
  const [residual, setResidual] = useState('0'),
    [residualFee, setResidualFee] = useState('0'),
    [reason, setReason] = useState('');
  const [view, setView] = useState<{ kind: 'preview' | 'execute'; reply: Reply } | null>(null),
    [consent, setConsent] = useState(false),
    [retryConsent, setRetryConsent] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [history, setHistory] = useState<Array<Head & { kind?: string }>>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyKind, setHistoryKind] = useState<'preview' | 'execution'>('execution');
  const [now, setNow] = useState(Date.now());
  const [dataScope, setDataScope] = useState(identity),
    [dataSource, setDataSource] = useState(source ? `${source.previewId}:${source.rowId}` : '');
  const sameContext = retained.context === contextKey && retained.identity === identity;
  const pending = sameContext ? retained.attempt : null,
    flight = sameContext ? retained.flight : null;
  const locked = Boolean(pending || flight);
  const writable =
    options?.available === true &&
    options.can_write &&
    options.current_role === 'admin' &&
    !options.read_only &&
    !readOnly;
  const freshBlocked = !writable || busy || locked || externalWriteBlocked;
  const sourceKey = source ? `${source.previewId}:${source.rowId}` : '';
  const sourceRef = useRef(sourceKey);
  sourceRef.current = sourceKey;
  const invalid = () => {
    setView(null);
    setConsent(false);
    setNotice('');
  };
  const active = (id: string, n: number, key?: string) =>
    mounted.current &&
    scope.current === id &&
    generation.current === n &&
    (key === undefined || sourceRef.current === key);
  function failure(e: unknown) {
    const message = e instanceof Error ? e.message : 'Nie udało się odczytać podziału.';
    setError(message);
    onError?.(message);
    setConsent(false);
    setRetryConsent(false);
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      setOptions(null);
      setDrafts([]);
      setOrders([]);
      setHistory([]);
      setView(null);
      resetPaymentImportAllocationsContext(contextKey);
      retained.identity = identity;
    }
    if (e instanceof ApiError && e.status === 423)
      setOptions((old) => (old ? { ...old, read_only: true, can_write: false } : old));
    if (e instanceof ApiError && e.status === 503) setOptions(null);
  }
  async function checkActor() {
    const r = await api<{ user: { id: string; tenant_id: string; role: string } }>('/auth/me');
    if (!r.user || `${r.user.tenant_id}:${r.user.id}:${r.user.role}:${readOnly}` !== contextKey)
      throw new ApiError('Kontekst użytkownika zmienił się. Odśwież widok podziału wpłat.', 403);
  }
  async function sourceOptions(s: PaymentAllocationSource) {
    await checkActor();
    const r = await api<Options>(
      `${prefix}/options?source_preview_id=${encodeURIComponent(s.previewId)}&source_row_id=${encodeURIComponent(s.rowId)}`,
    );
    checkFlags(r);
    if (r.available && (!r.can_read || r.current_role !== 'admin'))
      throw new ApiError('Podział wpłaty wymaga aktualnego administratora.', 403);
    if (
      r.available &&
      (!r.source ||
        r.source.source_preview_id !== s.previewId ||
        r.source.source_row_id !== s.rowId)
    )
      throw Error('Odczyt źródła dotyczy innego wiersza.');
    if (r.source) {
      integer(r.source.available_minor);
      integer(r.source.remaining_amount_minor);
      integer(r.source.remaining_fee_minor);
    }
    return r;
  }
  async function read(run: () => Promise<void>) {
    if (busyRef.current || flight) return;
    const id = identity,
      n = generation.current,
      key = sourceKey;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await checkActor();
      if (active(id, n, key)) await run();
    } catch (e) {
      if (active(id, n, key)) failure(e);
    } finally {
      busyRef.current = false;
      if (mounted.current && scope.current === id) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (retained.context !== contextKey || (retained.identity && retained.identity !== identity))
      resetPaymentImportAllocationsContext(contextKey);
    retained.identity = identity;
    let seenEpoch = retained.epoch;
    const notify = () => {
      if (mounted.current) {
        setRevision((n) => n + 1);
        if (seenEpoch !== retained.epoch) {
          seenEpoch = retained.epoch;
          ++generation.current;
          setOptions(null);
          setDrafts([]);
          setOrders([]);
          setHistory([]);
          setView(null);
          setConsent(false);
          setRetryConsent(false);
        } else if (
          retained.context === contextKey &&
          retained.outcome &&
          (!sourceRef.current ||
            sourceRef.current ===
              `${retained.outcome.reply.source.source_preview_id}:${retained.outcome.reply.source.source_row_id}`)
        )
          setView(retained.outcome);
      }
    };
    listeners.add(notify);
    notify();
    return () => {
      mounted.current = false;
      ++generation.current;
      listeners.delete(notify);
    };
  }, [identity]);
  useEffect(() => {
    const id = identity,
      n = ++generation.current,
      key = sourceKey;
    setDataScope(identity);
    setDataSource(sourceKey);
    setOptions(null);
    setOrders([]);
    setDrafts([]);
    setOrderUuid('');
    setSearch('');
    setConsent(false);
    setRetryConsent(false);
    setCursor(null);
    setReason('');
    setResidual('0');
    setResidualFee('0');
    setError('');
    setHistory([]);
    setHistoryCursor(null);
    if (
      !locked &&
      (!retained.outcome ||
        (source &&
          !(
            retained.outcome.reply.source.source_preview_id === source.previewId &&
            retained.outcome.reply.source.source_row_id === source.rowId
          )))
    )
      setView(null);
    const priorSource = retained.outcome?.reply.source;
    const selected =
      pending?.source ??
      source ??
      (priorSource
        ? { previewId: priorSource.source_preview_id, rowId: priorSource.source_row_id }
        : null);
    if (!selected) {
      void api<Options>(`${prefix}/options`)
        .then((r) => {
          if (active(id, n, key)) {
            checkFlags(r);
            if (r.available && r.current_role !== 'admin')
              throw new ApiError('Brak dostępu do podziału wpłat.', 403);
            setOptions(r);
          }
        })
        .catch((e) => {
          if (active(id, n, key)) failure(e);
        });
      return;
    }
    void sourceOptions(selected)
      .then((r) => {
        if (active(id, n, key)) setOptions(r);
      })
      .catch((e) => {
        if (active(id, n, key)) failure(e);
      });
  }, [identity, sourceKey]);
  useEffect(() => {
    setConsent(false);
    setNow(Date.now());
    if (!view?.reply.preview?.expires_at) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view?.reply.preview?.id, view?.reply.preview?.expires_at, externalWriteBlocked, readOnly]);
  async function find(next?: string) {
    const id = identity,
      n = ++generation.current;
    await read(async () => {
      const r = await api<{
        data: Array<{ id: string; number: string; currency: string }>;
        meta: { cursor: string | null };
      }>(
        `/orders?limit=20&search=${encodeURIComponent(search.trim())}${next ? '&after=' + encodeURIComponent(next) : ''}`,
      );
      if (!active(id, n)) return;
      if (
        !Array.isArray(r.data) ||
        r.data.some((o) => !uuid(o.id)) ||
        (next && r.meta.cursor === next)
      )
        throw Error('Nieprawidłowa strona wyszukiwania zamówień.');
      setOrders((old) =>
        next ? [...old, ...r.data.filter((o) => !old.some((v) => v.id === o.id))] : r.data,
      );
      setCursor(r.meta.cursor);
    });
  }
  async function choose(id: string) {
    if (freshBlocked || drafts.length >= 100) return;
    const ident = identity,
      n = ++generation.current,
      key = sourceKey;
    await read(async () => {
      const r = await api<Order>('/orders/' + id);
      if (!active(ident, n, key)) return;
      if (r.id !== id || !Array.isArray(r.shipments))
        throw Error('Niespójny odczyt wybranego zamówienia.');
      setDrafts((old) => [
        ...old,
        { key: crypto.randomUUID(), order: r, shipmentId: '', amount: '', fee: '0' },
      ]);
      invalid();
    });
  }
  function update(key: string, patch: Partial<Draft>) {
    if (freshBlocked) return;
    setDrafts((old) => old.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    invalid();
  }
  const isCod = ['courier_collection', 'courier_remittance'].includes(
      options?.source?.ledger_kind ?? '',
    ),
    remittance = options?.source?.ledger_kind === 'courier_remittance';
  const parsed = drafts.map((d) => ({
    order_id: d.order.id,
    ...(isCod && d.shipmentId ? { shipment_id: d.shipmentId } : {}),
    amount_minor: minor(d.amount),
    fee_minor: remittance ? minor(d.fee) : 0,
  }));
  const remainder = minor(residual),
    remainderFee = remittance ? minor(residualFee) : 0;
  const complete =
    parsed.length > 0 &&
    parsed.length <= 100 &&
    parsed.every(
      (r, i) =>
        r.amount_minor !== null &&
        r.fee_minor !== null &&
        r.amount_minor + r.fee_minor > 0 &&
        (!isCod || Boolean(r.shipment_id)) &&
        drafts[i].order.currency === options?.source?.currency,
    );
  const sumAmount = parsed.reduce((n, r) => n + BigInt(r.amount_minor ?? 0), 0n),
    sumFee = parsed.reduce((n, r) => n + BigInt(r.fee_minor ?? 0), 0n);
  const allocationKeys = new Set(parsed.map((r) => `${r.order_id}:${r.shipment_id ?? ''}`));
  let problem = '';
  if (!complete)
    problem =
      'Wybierz zamówienia w walucie źródła, przesyłki COD i dodatnie kwoty. Kwoty mają najwyżej dwa miejsca po przecinku.';
  else if (allocationKeys.size !== parsed.length)
    problem = 'Jedna para zamówienie/przesyłka może wystąpić tylko raz.';
  else if (remainder === null || remainderFee === null)
    problem = 'Podaj poprawną resztę i jej prowizję; jawne zero jest dozwolone.';
  else if (reason.trim().length < 3 || /[\x00-\x1f\x7f]/.test(reason))
    problem = 'Podaj powód podziału (3–2000 znaków, bez znaków sterujących).';
  else if (
    options?.source &&
    sumAmount + BigInt(remainder) !== integer(options.source.remaining_amount_minor)
  )
    problem = 'Suma przydziałów i pozostawionej kwoty musi odpowiadać kwocie źródła bez prowizji.';
  else if (
    options?.source &&
    sumFee + BigInt(remainderFee) !== integer(options.source.remaining_fee_minor)
  )
    problem =
      'Suma prowizji przydziałów i prowizji reszty musi odpowiadać pozostałej prowizji źródła.';
  async function write(a: Attempt, retry = false) {
    if (
      !writable ||
      readOnly ||
      busyRef.current ||
      retained.flight ||
      scope.current !== a.identity ||
      retained.context !== contextKey ||
      (retained.attempt && retained.attempt !== a) ||
      (!retry && externalWriteBlocked) ||
      (retry && !retryConsent)
    )
      return;
    retained.attempt = a;
    retained.flight = a;
    const token = retained.epoch;
    retained.outcome = null;
    publish();
    busyRef.current = true;
    setBusy(true);
    setError('');
    setRetryConsent(false);
    setConsent(false);
    try {
      const f = await sourceOptions(a.source);
      if (retained.epoch !== token || retained.attempt !== a) return;
      if (!f.available || f.read_only || f.current_role !== 'admin' || !f.can_write)
        throw new ApiError(
          'Aktualny dostęp nie pozwala zapisać podziału.',
          f.read_only ? 423 : 403,
        );
      const result = await api<Reply>(a.path, 'POST', JSON.parse(a.serialized));
      await checkActor();
      if (retained.epoch !== token || retained.attempt !== a) return;
      validateReply(result, a.kind);
      if (
        result.source.source_preview_id !== a.source.previewId ||
        result.source.source_row_id !== a.source.rowId
      )
        throw Error('Wynik dotyczy innego źródłowego wiersza. Zachowano próbę.');
      if (!result.available || result.current_role !== 'admin')
        throw new ApiError('Dostęp do wyniku podziału został wycofany.', 403);
      retained.outcome = { kind: a.kind, reply: result };
      retained.attempt = null;
      if (mounted.current && scope.current === a.identity) {
        setView(retained.outcome);
        setOptions({ ...f, source: result.source });
        setNotice(
          a.kind === 'execute'
            ? 'Podział został zapisany w lokalnym rejestrze płatności.'
            : 'Pełny podgląd zapisano. Płatności nie zostały jeszcze dopisane.',
        );
        if (a.kind === 'execute') onApplied?.();
      }
    } catch (e) {
      if (retained.epoch !== token || retained.attempt !== a) return;
      if (e instanceof ApiError && [409, 422].includes(e.status)) retained.attempt = null;
      if (mounted.current && scope.current === a.identity) failure(e);
      else if (e instanceof ApiError && [401, 403].includes(e.status))
        resetPaymentImportAllocationsContext(contextKey);
    } finally {
      if (retained.flight === a) retained.flight = null;
      busyRef.current = false;
      publish();
      if (mounted.current && scope.current === a.identity) setBusy(false);
    }
  }
  function prepare() {
    if (!source || freshBlocked || problem || !options?.source?.can_allocate) return;
    const body = {
      client_key: crypto.randomUUID(),
      source_preview_id: source.previewId,
      source_row_id: source.rowId,
      source_version: options.source.source_version,
      allocations: parsed,
      unallocated_minor: remainder,
      unallocated_fee_minor: remainderFee,
      reason: reason.trim(),
    };
    void write({
      context: contextKey,
      identity,
      path: `${prefix}/previews`,
      kind: 'preview',
      source,
      serialized: JSON.stringify(body),
    });
  }
  function execute() {
    const h = view?.kind === 'preview' ? view.reply.preview : null;
    if (
      !h ||
      freshBlocked ||
      !h.can_execute ||
      h.executed_execution_id ||
      !consent ||
      (h.expires_at && new Date(h.expires_at).getTime() <= Date.now())
    )
      return;
    void write({
      context: contextKey,
      identity,
      path: `${prefix}/previews/${h.id}/execute`,
      kind: 'execute',
      source: {
        previewId: h.source_preview_id,
        rowId: h.source_row_id,
        ...(source?.position !== undefined ? { position: source.position } : {}),
      },
      serialized: JSON.stringify({
        client_key: crypto.randomUUID(),
        version: h.version,
        scope_hash: h.scope_hash,
        confirmed: true,
        local_ledger_only: true,
      }),
    });
  }
  async function open(kind: 'preview' | 'execute', id: string) {
    const ident = identity,
      n = ++generation.current;
    await read(async () => {
      const r = await api<Reply>(
        `${prefix}/${kind === 'preview' ? 'previews' : 'executions'}/${id}`,
      );
      validateReply(r, kind);
      if (!active(ident, n)) return;
      if (!r.available || r.current_role !== 'admin')
        throw new ApiError('Brak dostępu do historii podziału.', 403);
      setView({ kind, reply: r });
      setConsent(false);
    });
  }
  async function loadHistory(kind: 'preview' | 'execution', next?: string) {
    const ident = identity,
      n = ++generation.current;
    await read(async () => {
      const r = await api<
        Flags & { data: Array<Head & { kind?: string }>; next_cursor: string | null }
      >(`${prefix}/history?kind=${kind}${next ? '&cursor=' + encodeURIComponent(next) : ''}`);
      checkFlags(r);
      if (!active(ident, n)) return;
      if (!r.available || !r.can_read || r.current_role !== 'admin')
        throw new ApiError('Brak dostępu do historii podziału.', 403);
      if (
        !Array.isArray(r.data) ||
        r.data.some(
          (h) => !uuid(h.id) || !h.summary || !['preview', 'execution'].includes(h.kind ?? ''),
        ) ||
        (next && r.next_cursor === next)
      )
        throw Error('Nieprawidłowa strona historii podziału.');
      setHistory((old) =>
        next ? [...old, ...r.data.filter((h) => !old.some((v) => v.id === h.id))] : r.data,
      );
      setHistoryCursor(r.next_cursor);
      setHistoryKind(kind);
    });
  }
  void revision;
  const head = view?.kind === 'preview' ? view.reply.preview : view?.reply.execution;
  const expired = Boolean(
    view?.kind === 'preview' && head?.expires_at && new Date(head.expires_at).getTime() <= now,
  );
  async function refreshAccess() {
    const id = identity,
      n = ++generation.current;
    const selected =
      pending?.source ??
      (head ? { previewId: head.source_preview_id, rowId: head.source_row_id } : source);
    await read(async () => {
      const r = selected ? await sourceOptions(selected) : await api<Options>(`${prefix}/options`);
      checkFlags(r);
      if (!active(id, n)) return;
      if (r.available && r.current_role !== 'admin')
        throw new ApiError('Brak dostępu do podziału wpłat.', 403);
      setOptions(r);
      setConsent(false);
      setRetryConsent(false);
    });
  }
  async function continueRemaining() {
    if (!head || freshBlocked || !onSourceSelected) return;
    const id = identity,
      n = ++generation.current;
    const selected = { previewId: head.source_preview_id, rowId: head.source_row_id };
    await read(async () => {
      const r = await sourceOptions(selected);
      if (!active(id, n)) return;
      if (!r.source?.can_allocate || integer(r.source.available_minor) === 0n)
        throw Error('Źródło nie ma już dostępnej kwoty do nowego podziału.');
      setOptions(r);
      setDrafts([]);
      setReason('');
      setResidual('0');
      setResidualFee('0');
      setConsent(false);
      setView(null);
      onSourceSelected(selected);
    });
  }
  if (dataScope !== identity || dataSource !== sourceKey)
    return (
      <section className="payment-allocation-panel">
        <p>Odświeżanie kontekstu podziału wpłat…</p>
      </section>
    );
  return (
    <section className="payment-allocation-panel" aria-label="Podział zbiorczej wpłaty">
      <h3>Podział zbiorczej wpłaty na zamówienia</h3>
      <p>
        Wybierz wiersz źródłowego podglądu, następnie własne zamówienia i kwoty. Zapis dotyczy
        lokalnego rejestru; nie wykonuje przelewu ani operacji u przewoźnika.
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
      <button
        className="button"
        disabled={busy || Boolean(flight)}
        onClick={() => void refreshAccess()}
      >
        Odśwież dostęp i pozostałą kwotę
      </button>
      {(readOnly || options?.read_only) && <p>Kopia tylko do odczytu.</p>}
      {options?.available === false && <p>Ta kopia nie udostępnia podziału wpłat.</p>}
      {pending && (
        <div className="pa-pending">
          <strong>Wynik ostatniej próby nie jest rozstrzygnięty.</strong>
          <p>
            Zachowano dokładne żądanie i klucz. Odczyt historii nie tworzy nowej próby i nie usuwa
            tej blokady. Ponów ręcznie tę samą próbę po sprawdzeniu wyniku.
          </p>
          <label className="pi-check">
            <input
              type="checkbox"
              checked={retryConsent}
              disabled={busy || Boolean(flight) || !writable}
              onChange={(e) => setRetryConsent(e.target.checked)}
            />
            Chcę ponowić dokładnie zachowaną próbę
          </label>
          <button
            className="button"
            disabled={busy || Boolean(flight) || !writable || !retryConsent}
            onClick={() => void write(pending, true)}
          >
            Ponów tę samą próbę
          </button>
        </div>
      )}
      {source && options?.source && (
        <>
          <p>
            <strong>
              {source.position === undefined
                ? 'Wybrany źródłowy zapis'
                : `Wiersz ${source.position + 1}`}
            </strong>{' '}
            · {ledgerNames[options.source.ledger_kind] ?? 'Źródłowy przepływ'} · transakcja{' '}
            {options.source.transaction_id} · {options.source.currency} · rewizja pozostałej kwoty{' '}
            {options.source.source_version}
          </p>
          <p>
            Źródło brutto: {money(options.source.gross_minor, options.source.currency)} · dostępne
            razem: {money(options.source.available_minor, options.source.currency)} · kwota bez
            prowizji do podziału:{' '}
            {money(options.source.remaining_amount_minor, options.source.currency)} · pozostała
            prowizja: {money(options.source.remaining_fee_minor, options.source.currency)}.
          </p>
          {!options.source.can_allocate && (
            <p>
              Ten wiersz nie może otrzymać nowego podziału. Sprawdź jego wynik lub źródłowe dane
              finansowe.
            </p>
          )}
          {view?.kind !== 'execute' && !head?.executed_execution_id && (
            <fieldset disabled={freshBlocked || !options.source.can_allocate}>
              <legend>Własne zamówienia i dokładne przydziały</legend>
              <div className="pa-search">
                <label>
                  Numer zamówienia
                  <input
                    value={search}
                    maxLength={200}
                    onChange={(e) => {
                      ++generation.current;
                      setSearch(e.target.value);
                      setOrders([]);
                      setCursor(null);
                    }}
                  />
                </label>
                <button className="button" disabled={!search.trim()} onClick={() => void find()}>
                  Szukaj zamówień po numerze
                </button>
              </div>
              <div className="pa-choices">
                {orders.map((o) => (
                  <button
                    className="button"
                    key={o.id}
                    disabled={drafts.length >= 100 || o.currency !== options.source?.currency}
                    onClick={() => void choose(o.id)}
                  >
                    Dodaj {o.number} · {o.currency}
                  </button>
                ))}
              </div>
              <details>
                <summary>Odczyt po dokładnym identyfikatorze (zaawansowane)</summary>
                <label>
                  UUID własnego zamówienia
                  <input value={orderUuid} onChange={(e) => setOrderUuid(e.target.value)} />
                </label>
                <button
                  className="button"
                  disabled={!uuid(orderUuid.trim()) || drafts.length >= 100}
                  onClick={() => void choose(orderUuid.trim().toLowerCase())}
                >
                  Odczytaj i dodaj własne zamówienie po UUID
                </button>
              </details>
              {cursor && (
                <button className="button" onClick={() => void find(cursor)}>
                  Kolejne zamówienia
                </button>
              )}
              {drafts.map((d, i) => (
                <article className="pa-draft" key={d.key}>
                  <h4>
                    {i + 1}. {d.order.number} · {d.order.currency}
                  </h4>
                  <BalanceView balance={d.order.payment} currency={d.order.currency} />
                  {isCod && (
                    <label>
                      Dokładna przekazana przesyłka COD
                      <select
                        value={d.shipmentId}
                        onChange={(e) => update(d.key, { shipmentId: e.target.value })}
                      >
                        <option value="">Wybierz przesyłkę</option>
                        {d.order.shipments
                          .filter((s) => Boolean(s.dispatched_at))
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.carrier} · {s.tracking_number} · pobranie{' '}
                              {money(s.cod_expected, d.order.currency)}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <div className="pa-grid">
                    <label>
                      {remittance ? 'Kwota przekazana po prowizji' : 'Kwota wpłaty / pobrania'} (
                      {options.source?.currency})
                      <input
                        inputMode="decimal"
                        value={d.amount}
                        onChange={(e) => update(d.key, { amount: e.target.value })}
                        placeholder="np. 125,50"
                      />
                    </label>
                    {remittance && (
                      <label>
                        Prowizja tego przydziału
                        <input
                          inputMode="decimal"
                          value={d.fee}
                          onChange={(e) => update(d.key, { fee: e.target.value })}
                        />
                      </label>
                    )}
                  </div>
                  <button
                    className="button"
                    onClick={() => {
                      setDrafts((old) => old.filter((v) => v.key !== d.key));
                      invalid();
                    }}
                  >
                    Usuń przydział
                  </button>
                </article>
              ))}
              <div className="pa-grid">
                <label>
                  Kwota pozostawiona do późniejszego podziału (bez prowizji)
                  <input
                    inputMode="decimal"
                    value={residual}
                    onChange={(e) => {
                      setResidual(e.target.value);
                      invalid();
                    }}
                  />
                </label>
                {remittance && (
                  <label>
                    Oddzielna prowizja pozostawiona do późniejszego podziału
                    <input
                      inputMode="decimal"
                      value={residualFee}
                      onChange={(e) => {
                        setResidualFee(e.target.value);
                        invalid();
                      }}
                    />
                  </label>
                )}
                <label>
                  Powód podziału
                  <input
                    maxLength={2000}
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      invalid();
                    }}
                  />
                </label>
              </div>
              <p>
                Przydzielono: {money(sumAmount, options.source.currency)} · prowizje:{' '}
                {money(sumFee, options.source.currency)}. Niewykorzystana kwota pozostaje jawną
                resztą; nie jest wpłatą na losowe zamówienie.
              </p>
              {problem && <p>{problem}</p>}
              <button className="button primary" disabled={Boolean(problem)} onClick={prepare}>
                Przygotuj pełny podgląd podziału
              </button>
            </fieldset>
          )}
        </>
      )}
      {!source && !pending && (
        <p>Przy źródłowym wierszu wybierz „Podziel tę wpłatę na kilka zamówień”.</p>
      )}
      {head && view && (
        <div className="pa-review">
          <h4>
            {view.kind === 'preview' ? 'Pełny zapisany podgląd' : 'Zapisany wynik podziału'} ·{' '}
            {date(head.created_at)}
          </h4>
          <p>
            {head.summary.count} przydziałów · kwota{' '}
            {money(head.summary.amount_minor, head.summary.currency)} · prowizje{' '}
            {money(head.summary.fee_minor, head.summary.currency)} · pozostawiono kwotę{' '}
            {money(head.summary.unallocated_minor, head.summary.currency)} oraz oddzielną prowizję{' '}
            {money(head.summary.unallocated_fee_minor, head.summary.currency)}.
          </p>
          <AllocationTable
            rows={view.reply.allocations}
            currency={head.summary.currency}
            execution={view.kind === 'execute'}
          />
          <p>
            Źródłowa transakcja: {view.reply.source.transaction_id} · {view.reply.source.currency} ·
            {view.kind === 'execute' ? 'rewizja po zapisie' : 'rewizja użyta w podglądzie'}:{' '}
            {head.source_version}. Źródło brutto:{' '}
            {money(view.reply.source.gross_minor, view.reply.source.currency)}.
          </p>
          {view.kind === 'preview' && head.expires_at && (
            <p>
              {expired
                ? 'Podgląd wygasł. Przygotuj nowy podgląd z aktualną pozostałą kwotą.'
                : `Podgląd ważny do ${date(head.expires_at)}.`}
            </p>
          )}
          {view.kind === 'preview' && head.executed_execution_id && (
            <button
              className="button"
              disabled={busy || Boolean(flight)}
              onClick={() => void open('execute', head.executed_execution_id!)}
            >
              Odczytaj zapisany wynik tego podglądu
            </button>
          )}
          {(view.kind === 'execute' || Boolean(head.executed_execution_id)) && (
            <button
              className="button"
              disabled={freshBlocked || !onSourceSelected}
              onClick={() => void continueRemaining()}
            >
              Przypisz pozostałą kwotę z tego źródła
            </button>
          )}
          {view.kind === 'preview' && !head.executed_execution_id && (
            <>
              <label className="pi-check">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={
                    freshBlocked ||
                    expired ||
                    !head.can_execute ||
                    view.reply.allocations.length !== head.summary.count
                  }
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Sprawdziłem wszystkie przydziały, walutę, przesyłki, prowizje i resztę. Zatwierdzam
                jeden lokalny zapis całego podziału.
              </label>
              <button
                className="button primary"
                disabled={freshBlocked || expired || !head.can_execute || !consent}
                onClick={execute}
              >
                Zatwierdź cały podział w lokalnym rejestrze
              </button>
            </>
          )}
        </div>
      )}
      <div className="pa-history">
        <button
          className="button"
          disabled={busy || Boolean(flight)}
          onClick={() => void loadHistory('execution')}
        >
          Odczytaj historię zapisanych podziałów
        </button>
        <button
          className="button"
          disabled={busy || Boolean(flight)}
          onClick={() => void loadHistory('preview')}
        >
          Odczytaj historię podglądów podziału
        </button>
        {history.map((h) => (
          <button
            className="button"
            key={h.id}
            disabled={busy || Boolean(flight)}
            onClick={() =>
              void open(h.kind === 'execution' || h.preview_id ? 'execute' : 'preview', h.id)
            }
          >
            {h.kind === 'execution' || h.preview_id ? 'Wynik' : 'Podgląd'} · {date(h.created_at)} ·{' '}
            {h.summary.count} przydziałów · {money(h.summary.amount_minor, h.summary.currency)}
          </button>
        ))}
        {historyCursor && (
          <button
            className="button"
            disabled={busy || Boolean(flight)}
            onClick={() => void loadHistory(historyKind, historyCursor)}
          >
            Starsze podziały
          </button>
        )}
      </div>
    </section>
  );
}
