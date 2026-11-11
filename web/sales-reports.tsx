import { useEffect, useRef, useState } from 'react';
import { api, ApiError, statusNames } from './api';
import './sales-reports.css';
import { ReportAnalytics } from './reports-analytics';

type Filters = { from: string; to: string; warehouse_id: string; currency: string };
type Flags = { current_role: string; can_read_value: boolean; read_only: boolean };
type Base = Flags & {
  filters: {
    from: string;
    to: string;
    time_zone: 'Europe/Warsaw';
    warehouse_id: string | null;
    currency: string | null;
    from_at: string;
    to_exclusive_at: string;
  };
  as_of: string;
};
type Options = Flags & {
  available: boolean;
  time_zone: string;
  currencies: string[];
  warehouses: { data: { id: string; name: string; code: string }[]; capped: boolean };
  limits: { days: number; page_rows: number; export_rows: number; file_bytes: number };
};
type Amounts = {
  goods_gross_minor?: string | null;
  goods_net_minor?: string | null;
  delivery_gross_minor?: string | null;
  total_gross_minor?: string | null;
  returned_goods_gross_minor?: string | null;
  returned_goods_net_minor?: string | null;
  returned_delivery_gross_minor?: string | null;
  current_goods_net_minor?: string | null;
  issued_known_cost_minor?: string | null;
  warranty_known_cost_minor?: string | null;
  restocked_known_cost_minor?: string | null;
  net_known_cost_minor?: string | null;
  unknown_cost_quantity?: string;
  missing_issue_quantity?: string;
  margin_minor?: string | null;
};
type OrderRow = Amounts & {
  id: string;
  number: string;
  created_at: string;
  dispatched_at: string | null;
  warehouse_id: string;
  currency: string;
  status: string;
  source: string;
  commercial_quantity: string;
  physical_quantity: string;
  accepted_quantity: string;
  physically_accepted_quantity?: string;
  restocked_quantity: string;
  cost_complete?: boolean;
  cost_reasons?: string[];
  tax_basis: 'order_item_snapshot';
};
type ReturnRow = Amounts & {
  id: string;
  number: string;
  order_id: string;
  order_number: string;
  received_at: string | null;
  accepted_at: string;
  acceptance_kind: 'physical' | 'partner';
  remedy?: 'refund' | 'exchange';
  warehouse_id: string;
  currency: string;
  accepted_quantity: string;
  restocked_quantity: string;
};
type Page<T> = Base & { data: T[]; meta: { total: number; cursor: string | null } };
type Summary = Base & {
  sales: (Amounts & { currency: string; orders: number; commercial_quantity: string })[];
  returns: (Amounts & {
    currency: string;
    cases: number;
    accepted_quantity: string;
    restocked_quantity: string;
  })[];
  costs: {
    currency: string;
    issued_quantity: string;
    restocked_quantity: string;
    issued_unknown_quantity?: string;
    restocked_unknown_quantity?: string;
    net_unknown_quantity?: string;
    issued_known_minor?: string | null;
    restocked_known_minor?: string | null;
  }[];
  cohort_current: (Amounts & {
    currency: string;
    orders: number;
    complete_order_count?: number;
    incomplete_order_count?: number;
  })[];
  warnings: string[];
};
type OrderDetail = Base & {
  order: OrderRow;
  commercial_lines: {
    id: string;
    product_id: string;
    sku: string;
    name: string;
    quantity: number | string;
    vat: number;
    line_total_minor?: string | null;
    net_minor?: string | null;
    accepted_quantity: string;
    physically_accepted_quantity?: string;
    restocked_quantity: string;
    returned_gross_minor?: string | null;
    returned_net_minor?: string | null;
    margin_minor?: null;
  }[];
  physical_costs: {
    product_id: string;
    sku?: string | null;
    name?: string | null;
    currency: string;
    issued_quantity: string;
    restocked_quantity: string;
    unknown_quantity?: string;
    issued_known_minor?: string | null;
    restocked_known_minor?: string | null;
  }[];
};
type Tab = 'summary' | 'orders' | 'returns';

export type SalesReportsProps = {
  workspaceId: string;
  contextKey: string;
  readOnly: boolean;
  refresh?: number;
  onOpenOrder: (id: string) => void;
  onError?: (message: string) => void;
};

/** Aggregate amounts are arbitrary signed decimal strings, never floating point. */
export function salesReportMoney(value: string | null | undefined, currency: string): string {
  if (value == null || !/^-?\d+$/.test(value)) return 'Brak danych';
  const n = BigInt(value);
  const absolute = n < 0n ? -n : n;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `${n < 0n ? '−' : ''}${whole},${(absolute % 100n).toString().padStart(2, '0')} ${currency}`;
}
const sources: Record<string, string> = {
  manual: 'Ręczne',
  order_merge: 'Połączone zamówienia',
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  allegro: 'Allegro',
  prestashop: 'PrestaShop',
  ebay: 'eBay',
  amazon: 'Amazon',
  b2b: 'B2B',
};
const reasonNames: Record<string, string> = {
  unknown_cost: 'Nieznany koszt towaru',
  unknown_costs: 'Nieznany koszt towaru',
  missing_issue: 'Brak dowodu wydania z kosztem',
  missing_issue_quantity: 'Brak dowodu wydania z kosztem',
  currency_mismatch: 'Waluta kosztu różni się od waluty sprzedaży',
  not_dispatched: 'Brak wydania towaru',
  not_tracked: 'Brak wyceny partii',
  missing_issue_cost: 'Brak dowodu wydania z kosztem',
  unknown_layer_cost: 'Nieznany koszt partii towaru',
  cost_currency_mismatch: 'Waluta kosztu różni się od waluty sprzedaży',
  physical_quantity_mismatch: 'Ilość wydana nie odpowiada fizycznym pozycjom zamówienia',
  physical_snapshot_unavailable:
    'Brak historycznego zapisu fizycznych składników zamówienia. Nie można potwierdzić pełnego kosztu towaru.',
  booking_and_return_and_cost_periods_are_separate:
    'Sprzedaż, przyjęte zwroty i ruchy kosztowe mają odrębne daty zdarzeń.',
  cohort_margin_is_current_as_of:
    'Marża zamówień z wybranego okresu uwzględnia wszystkie zdarzenia do chwili odczytu.',
  snapshot_vat_is_not_provider_tax_proof:
    'Kwoty netto wynikają z VAT zapisanego w pozycjach zamówienia; raport nie zastępuje dokumentów podatkowych.',
  delivery_vat_and_delivery_cost_not_in_margin:
    'Marża towarów nie obejmuje dostawy ani jej kosztów.',
  wms_cost_module_unavailable:
    'W tej kopii systemu nie ma wyceny partii. Koszty towaru mogą być niepełne.',
  replacement_issue_cost_attributed_to_original_sale:
    'Koszt wydania bezpłatnych zamienników obciąża marżę pierwotnej sprzedaży.',
  exchange_acceptance_does_not_reduce_sales_units:
    'Przyjęcie reklamacji z wymianą nie pomniejsza liczby sprzedanych sztuk ani wartości sprzedaży.',
};
const reason = (value: string) => reasonNames[value] ?? value;
const timestamp = (value: string) =>
  new Date(value).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day'].map((key) => parts.find((p) => p.type === key)!.value).join('-');
}
const initialFilters = (): Filters => {
  const to = today();
  return { from: to.slice(0, 8) + '01', to, warehouse_id: '', currency: '' };
};
function query(filters: Filters, extra: Record<string, string> = {}) {
  const p = new URLSearchParams({ from: filters.from, to: filters.to, ...extra });
  if (filters.warehouse_id) p.set('warehouse_id', filters.warehouse_id);
  if (filters.currency) p.set('currency', filters.currency);
  return p.toString();
}
const prefix = '/reports/sales';

export function SalesReports({
  workspaceId,
  contextKey,
  readOnly,
  refresh = 0,
  onOpenOrder,
  onError,
}: SalesReportsProps) {
  const [options, setOptions] = useState<Options | null>(null);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [draft, setDraft] = useState<Filters>(initialFilters);
  const [applied, setApplied] = useState<Filters | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<Page<OrderRow> | null>(null);
  const [returns, setReturns] = useState<Page<ReturnRow> | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [tab, setTab] = useState<Tab>('summary');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [safeCsv, setSafeCsv] = useState(true);
  const epoch = useRef(0);
  const gate = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const authority = useRef<Flags | null>(null);
  const scope = `${workspaceId}:${contextKey}:${readOnly}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const boundScope = useRef(scope);
  const matches = (generation: number) =>
    epoch.current === generation && currentScope.current === boundScope.current;

  function clearData() {
    setApplied(null);
    setSummary(null);
    setOrders(null);
    setReturns(null);
    setDetail(null);
    setStatus('');
  }
  function accept(d: Flags, generation: number) {
    if (!matches(generation)) return false;
    const previous = authority.current;
    if (
      previous &&
      (previous.current_role !== d.current_role || previous.can_read_value !== d.can_read_value)
    ) {
      clearData();
      authority.current = d;
      setFlags(d);
      throw new Error('Uprawnienia odczytu zmieniły się. Oblicz raport ponownie.');
    }
    authority.current = d;
    setFlags(d);
    return true;
  }
  function failure(e: unknown, generation: number) {
    if (!matches(generation)) return;
    const message = e instanceof Error ? e.message : 'Nie udało się odczytać raportu.';
    if (e instanceof ApiError && e.status === 409) {
      clearData();
      setFlags(null);
      authority.current = null;
    }
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      clearData();
      setOptions(null);
      setFlags(null);
      authority.current = null;
      setBlocked(true);
    }
    setError(message);
    onError?.(message);
  }
  function release(generation: number) {
    if (matches(generation)) {
      gate.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    const generation = ++epoch.current;
    const changedContext = boundScope.current !== scope;
    boundScope.current = scope;
    gate.current = false;
    authority.current = null;
    controller.current?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setOptions(null);
    setFlags(null);
    if (changedContext) setDraft(initialFilters());
    clearData();
    setTab('summary');
    setError('');
    setBusy(false);
    setBlocked(false);
    setLoading(true);
    void api<Options>(prefix + '/options')
      .then((d) => {
        if (!matches(generation)) return;
        authority.current = d;
        setFlags(d);
        setOptions(d);
      })
      .catch((e) => failure(e, generation))
      .finally(() => {
        if (matches(generation)) setLoading(false);
      });
    return () => {
      ++epoch.current;
      controller.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
  }, [scope, refresh]);

  const visible = boundScope.current === scope;
  const financial = visible && !!flags?.can_read_value;
  const locked = busy || loading || blocked || !visible || !options?.available;
  const dirty = applied !== null && JSON.stringify(draft) !== JSON.stringify(applied);

  async function calculate() {
    if (locked || gate.current || !options) return;
    const from = Date.parse(draft.from + 'T00:00:00Z');
    const to = Date.parse(draft.to + 'T00:00:00Z');
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from > to ||
      (to - from) / 86400000 + 1 > options.limits.days
    ) {
      setError(
        `Podaj poprawny okres od daty początkowej do końcowej, maksymalnie ${options.limits.days} dni.`,
      );
      return;
    }
    const frozen = { ...draft };
    const generation = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    clearData();
    try {
      const s = await api<Summary>(prefix + '/summary?' + query(frozen));
      if (!accept(s, generation)) return;
      const o = await api<Page<OrderRow>>(prefix + '/orders?' + query(frozen, { limit: '50' }));
      if (!accept(o, generation)) return;
      const r = await api<Page<ReturnRow>>(prefix + '/returns?' + query(frozen, { limit: '50' }));
      if (!accept(r, generation)) return;
      setSummary(s);
      setOrders(o);
      setReturns(r);
      setApplied(frozen);
      setStatus(
        'Raport odczytany. Zestawienia mają osobne daty zdarzeń; kwoty nie są przeliczane między walutami.',
      );
    } catch (e) {
      failure(e, generation);
    } finally {
      release(generation);
    }
  }
  async function more(kind: 'orders' | 'returns') {
    const previous = kind === 'orders' ? orders : returns;
    if (!applied || !previous?.meta.cursor || locked || gate.current || dirty) return;
    const generation = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      const path =
        prefix + '/' + kind + '?' + query(applied, { limit: '50', cursor: previous.meta.cursor });
      if (kind === 'orders') {
        const d = await api<Page<OrderRow>>(path);
        if (accept(d, generation)) setOrders(d);
      } else {
        const d = await api<Page<ReturnRow>>(path);
        if (accept(d, generation)) setReturns(d);
      }
    } catch (e) {
      failure(e, generation);
    } finally {
      release(generation);
    }
  }
  async function openDetail(id: string) {
    if (!applied || locked || gate.current || dirty) return;
    const generation = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    setDetail(null);
    try {
      const d = await api<OrderDetail>(
        prefix + '/orders/' + encodeURIComponent(id) + '?' + query(applied),
      );
      if (accept(d, generation)) setDetail(d);
    } catch (e) {
      failure(e, generation);
    } finally {
      release(generation);
    }
  }
  async function download(kind: 'orders' | 'returns') {
    if (!applied || !options || locked || gate.current || dirty) return;
    const generation = epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    gate.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const response = await fetch(
        '/api' + prefix + '/file?' + query(applied, { kind, spreadsheet_safe: String(safeCsv) }),
        {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: abort.signal,
          headers: { 'X-Workspace-ID': workspaceId },
        },
      );
      if (!matches(generation) || abort.signal.aborted) return;
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as {
          detail?: string;
          code?: string;
        };
        if (!matches(generation) || abort.signal.aborted) return;
        if (problem.code === 'MFA_REQUIRED')
          window.dispatchEvent(
            new CustomEvent('dyna:mfa-required', { detail: { workspace: workspaceId } }),
          );
        throw new ApiError(
          problem.detail ?? 'Nie udało się pobrać CSV.',
          response.status,
          problem.code,
        );
      }
      if (!(response.headers.get('Content-Type') ?? '').toLowerCase().includes('text/csv'))
        throw new Error('Serwer nie zwrócił pliku CSV. Nie zapisano pliku.');
      const length = response.headers.get('Content-Length');
      if (length && Number(length) > options.limits.file_bytes) {
        abort.abort();
        throw new Error('Plik przekracza dozwolony rozmiar. Skróć okres lub zawęź zakres.');
      }
      const blob = await response.blob();
      if (!matches(generation) || abort.signal.aborted) return;
      if (
        blob.size > options.limits.file_bytes ||
        (length !== null && blob.size !== Number(length))
      )
        throw new Error(
          'Pobranie pliku jest niepełne lub plik przekracza limit. Nie zapisano pliku.',
        );
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      const link = document.createElement('a');
      link.href = url;
      link.download = `${kind === 'orders' ? 'zamowienia' : 'zwroty'}-${applied.from}-${applied.to}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        if (objectUrl.current === url) objectUrl.current = null;
      }, 1000);
      setStatus(
        'Pełny plik CSV przekazano do pobrania. Eksport odczytuje aktualne dane tego samego zakresu; może zawierać późniejsze zmiany niż widoczne zestawienie.',
      );
    } catch (e) {
      failure(e, generation);
    } finally {
      if (controller.current === abort) controller.current = null;
      release(generation);
    }
  }

  return (
    <section className="sales-reports" aria-label="Raporty sprzedaży i zwrotów">
      <div className="sales-report-intro">
        <h2>Sprzedaż, zwroty i koszt towaru</h2>
        <p>
          Wybierz okres i porównaj zdarzenia zapisane w systemie. Kwoty pozostają w oryginalnych
          walutach. Raport nie jest potwierdzeniem otrzymanych wpłat ani wypłaconych refundacji.
        </p>
        <p>
          Zestawienie obejmuje nieanulowane zamówienia realizacyjne, także nowe i nieopłacone.
          Historyczne źródła połączonych zamówień nie są liczone ponownie.
        </p>
      </div>
      {visible && error && (
        <div className="sales-report-error" role="alert">
          {error}
        </div>
      )}
      {loading && <p role="status">Odczytywanie dostępnych filtrów…</p>}
      {visible && options && !options.available && (
        <p>Raporty nie są dostępne w tej kopii systemu. Pozostałe ekrany nadal mogą być używane.</p>
      )}
      {visible && options?.available && (
        <>
          {(readOnly || flags?.read_only) && (
            <p className="sales-report-notice">
              Kopia tylko do odczytu. Możesz przeglądać raporty i pobrać CSV.
            </p>
          )}
          {!financial && (
            <p className="sales-report-notice">
              Ten dostęp obejmuje ilości i statusy. Kwoty, koszt towaru i marża są ukryte.
            </p>
          )}
          <form
            className="sales-report-filters"
            onSubmit={(e) => {
              e.preventDefault();
              void calculate();
            }}
          >
            <label>
              Data od
              <input
                type="date"
                required
                value={draft.from}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            </label>
            <label>
              Data do
              <input
                type="date"
                required
                value={draft.to}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </label>
            <label>
              Magazyn
              <select
                value={draft.warehouse_id}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, warehouse_id: e.target.value })}
              >
                <option value="">Wszystkie magazyny</option>
                {options.warehouses.data.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} · {w.code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Waluta
              <select
                value={draft.currency}
                disabled={locked}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
              >
                <option value="">Wszystkie, osobno</option>
                {options.currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <button className="button primary" disabled={locked}>
              {busy ? 'Odczytywanie…' : 'Oblicz raport'}
            </button>
          </form>
          <p className="sales-report-muted">
            Obie daty włącznie, według czasu w Polsce. Maksymalnie {options.limits.days} dni.{' '}
            {options.warehouses.capped &&
              'Lista magazynów jest ograniczona; nie pokazuje wszystkich dostępnych magazynów.'}
          </p>
          {dirty && (
            <p className="sales-report-notice">
              Filtry zmieniono. Poniżej pozostaje poprzedni raport; oblicz nowy, aby otworzyć
              szczegóły lub pobrać CSV.
            </p>
          )}
          {status && (
            <p role="status" className="sales-report-notice">
              {status}
            </p>
          )}
          {summary && applied && (
            <>
              <div className="sales-report-scope">
                <strong>
                  {applied.from} — {applied.to}
                </strong>
                <span>
                  {options.warehouses.data.find((w) => w.id === applied.warehouse_id)?.name ??
                    (applied.warehouse_id || 'Wszystkie magazyny')}{' '}
                  · {applied.currency || 'Każda waluta osobno'}
                </span>
                <span>Stan zestawienia: {timestamp(summary.as_of)}</span>
              </div>
              <nav className="sales-report-tabs" aria-label="Zestawienia">
                <button
                  className={'button ' + (tab === 'summary' ? 'primary' : '')}
                  onClick={() => setTab('summary')}
                >
                  Podsumowanie
                </button>
                <button
                  className={'button ' + (tab === 'orders' ? 'primary' : '')}
                  onClick={() => setTab('orders')}
                >
                  Zamówienia · {orders?.meta.total ?? '—'}
                </button>
                <button
                  className={'button ' + (tab === 'returns' ? 'primary' : '')}
                  onClick={() => setTab('returns')}
                >
                  Przyjęte zwroty · {returns?.meta.total ?? '—'}
                </button>
              </nav>
              {tab === 'summary' && <SummaryView data={summary} financial={financial} />}
              {tab === 'orders' && orders && (
                <>
                  <h3>Zamówienia utworzone w okresie</h3>
                  <p>
                    Wartości zwrotów, koszty i marża w tej tabeli uwzględniają zdarzenia do
                    wskazanego stanu odczytu, także późniejsze niż wybrany okres.
                  </p>
                  <div className="sales-report-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Zamówienie</th>
                          <th>Utworzono / status</th>
                          <th>Źródło</th>
                          <th>Ilość towarów</th>
                          <th>Fizycznie przyjęto / na stan</th>
                          {financial && (
                            <>
                              <th>Towary netto po zwrotach</th>
                              <th>Znany koszt netto</th>
                              <th>Marża towarów</th>
                            </>
                          )}
                          <th>Szczegóły</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.data.map((o) => (
                          <tr key={o.id}>
                            <td>
                              <button
                                className="sales-report-link"
                                disabled={busy || dirty}
                                onClick={() => onOpenOrder(o.id)}
                              >
                                {o.number}
                              </button>
                              <small>{o.currency}</small>
                            </td>
                            <td>
                              {timestamp(o.created_at)}
                              <small>{statusNames[o.status] ?? o.status}</small>
                            </td>
                            <td>{sources[o.source] ?? o.source}</td>
                            <td>
                              {o.commercial_quantity}
                              <small>Fizyczne: {o.physical_quantity}</small>
                            </td>
                            <td>
                              {o.physically_accepted_quantity ?? '—'} / {o.restocked_quantity}
                              <small>Pomniejszenie sprzedaży: {o.accepted_quantity} szt.</small>
                            </td>
                            {financial && (
                              <>
                                <td>{salesReportMoney(o.current_goods_net_minor, o.currency)}</td>
                                <td>
                                  {salesReportMoney(o.net_known_cost_minor, o.currency)}
                                  <small>
                                    {o.cost_complete === false
                                      ? 'Koszt niepełny'
                                      : o.cost_complete === true
                                        ? 'Koszt kompletny'
                                        : 'Brak danych'}
                                  </small>
                                </td>
                                <td>
                                  {salesReportMoney(o.margin_minor, o.currency)}
                                  {o.cost_reasons?.length ? (
                                    <small>{o.cost_reasons.map(reason).join(' · ')}</small>
                                  ) : null}
                                </td>
                              </>
                            )}
                            <td>
                              <button
                                className="button"
                                disabled={locked || dirty}
                                onClick={() => void openDetail(o.id)}
                              >
                                Rozwiń raport
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!orders.data.length && <p>Brak zamówień utworzonych w tym zakresie.</p>}
                  <p className="sales-report-muted">
                    Stan odczytu strony: {timestamp(orders.as_of)}. Kolejne strony odczytują bieżące
                    dane.
                  </p>
                  <PageControl
                    count={orders.data.length}
                    total={orders.meta.total}
                    cursor={orders.meta.cursor}
                    disabled={locked || dirty}
                    onMore={() => void more('orders')}
                    onFirst={() => void calculate()}
                  />
                </>
              )}
              {tab === 'returns' && returns && (
                <>
                  <h3>Zwroty uznane w okresie</h3>
                  <p>
                    Według daty fizycznego przyjęcia lub uznania na podstawie dowodu dostawcy.
                    Obejmuje również zamówienia utworzone wcześniej. Uznana wartość nie oznacza
                    wypłaty pieniędzy; „na stan” oznacza towar przywrócony do własnego magazynu.
                  </p>
                  <div className="sales-report-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Zwrot / zamówienie</th>
                          <th>Uznano</th>
                          <th>Przyjęto we własnym magazynie</th>
                          <th>Ilość przyjęta</th>
                          <th>Przywrócono na stan</th>
                          {financial && (
                            <>
                              <th>Towary brutto</th>
                              <th>Towary netto</th>
                              <th>Dostawa brutto</th>
                              <th>Razem brutto</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {returns.data.map((r) => (
                          <tr key={r.id}>
                            <td>
                              {r.number}
                              <small>
                                <button
                                  className="sales-report-link"
                                  disabled={busy || dirty}
                                  onClick={() => onOpenOrder(r.order_id)}
                                >
                                  {r.order_number}
                                </button>{' '}
                                · {r.currency}
                              </small>
                            </td>
                            <td>
                              {timestamp(r.accepted_at)}
                              <small>
                                {r.acceptance_kind === 'partner'
                                  ? 'Dowód dostawcy'
                                  : 'Przyjęcie fizyczne'}
                                {r.remedy === 'exchange' ? ' · wymiana bez zwrotu środków' : ''}
                              </small>
                            </td>
                            <td>{r.received_at ? timestamp(r.received_at) : '—'}</td>
                            <td>{r.accepted_quantity}</td>
                            <td>{r.restocked_quantity}</td>
                            {financial && (
                              <>
                                <td>{salesReportMoney(r.goods_gross_minor, r.currency)}</td>
                                <td>{salesReportMoney(r.goods_net_minor, r.currency)}</td>
                                <td>{salesReportMoney(r.delivery_gross_minor, r.currency)}</td>
                                <td>{salesReportMoney(r.total_gross_minor, r.currency)}</td>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!returns.data.length && <p>Brak uznanych zwrotów w tym zakresie.</p>}
                  <p className="sales-report-muted">
                    Stan odczytu strony: {timestamp(returns.as_of)}. Kolejne strony odczytują
                    bieżące dane.
                  </p>
                  <PageControl
                    count={returns.data.length}
                    total={returns.meta.total}
                    cursor={returns.meta.cursor}
                    disabled={locked || dirty}
                    onMore={() => void more('returns')}
                    onFirst={() => void calculate()}
                  />
                </>
              )}
              {detail && (
                <OrderDetailView
                  detail={detail}
                  financial={financial}
                  onClose={() => setDetail(null)}
                />
              )}
              <div className="sales-report-export">
                <h3>Pobierz zestawienie CSV</h3>
                <label className="sales-report-check">
                  <input
                    type="checkbox"
                    checked={safeCsv}
                    disabled={locked}
                    onChange={(e) => setSafeCsv(e.target.checked)}
                  />
                  CSV do arkusza — ochrona tekstu przed formułami
                </label>
                <p>
                  {safeCsv
                    ? 'Tekst wymagający ochrony może otrzymać apostrof. To zmienia jego reprezentację w pliku.'
                    : 'CSV do wymiany danych zachowuje tekst bez ochronnych prefiksów. Przy otwieraniu w arkuszu wybierz typ tekstowy dla identyfikatorów.'}{' '}
                  Eksport obejmuje cały zastosowany zakres, do{' '}
                  {options.limits.export_rows.toLocaleString('pl-PL')} wierszy i{' '}
                  {Math.floor(options.limits.file_bytes / 1048576)} MiB. Obowiązują aktualne
                  uprawnienia.
                </p>
                <div className="sales-report-actions">
                  <button
                    className="button"
                    disabled={locked || dirty}
                    onClick={() => void download('orders')}
                  >
                    Pobierz zamówienia CSV
                  </button>
                  <button
                    className="button"
                    disabled={locked || dirty}
                    onClick={() => void download('returns')}
                  >
                    Pobierz zwroty CSV
                  </button>
                </div>
              </div>
            </>
          )}
          {!summary && !busy && !blocked && (
            <div className="sales-report-empty">
              Wybierz zakres i kliknij „Oblicz raport”. Odczyt nie zmienia zamówień, stanów ani
              rozliczeń.
            </div>
          )}
        </>
      )}
      {visible && options?.available && (
        <ReportAnalytics workspaceId={workspaceId} contextKey={contextKey} readOnly={readOnly} />
      )}
    </section>
  );
}

function PageControl({
  count,
  total,
  cursor,
  disabled,
  onMore,
  onFirst,
}: {
  count: number;
  total: number;
  cursor: string | null;
  disabled: boolean;
  onMore: () => void;
  onFirst: () => void;
}) {
  return (
    <div className="sales-report-pagination">
      <span>
        Na tej stronie: {count} wierszy. Cały zakres: {total}.
      </span>
      <button className="button" disabled={disabled} onClick={onFirst}>
        Odczytaj od początku
      </button>
      {cursor && (
        <button className="button" disabled={disabled} onClick={onMore}>
          Odczytaj kolejne 50
        </button>
      )}
    </div>
  );
}
function SummaryView({ data, financial }: { data: Summary; financial: boolean }) {
  return (
    <div className="sales-report-summary">
      {!!data.warnings.length && (
        <div className="sales-report-notice">
          {data.warnings.map((w, i) => (
            <p key={i}>{reason(w)}</p>
          ))}
        </div>
      )}
      <section>
        <h3>Sprzedaż według daty utworzenia zamówienia</h3>
        <p>
          Wartość pozycji zamówień, przed zwrotami. Magazyn oznacza magazyn zamówienia. Dostawa jest
          wykazywana osobno jako brutto.
        </p>
        <div className="sales-report-scroll">
          <table>
            <thead>
              <tr>
                <th>Waluta</th>
                <th>Zamówienia</th>
                <th>Ilość towarów</th>
                {financial && (
                  <>
                    <th>Towary brutto</th>
                    <th>Towary netto</th>
                    <th>Dostawa brutto</th>
                    <th>Razem brutto</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data.sales.map((r) => (
                <tr key={r.currency}>
                  <td>{r.currency}</td>
                  <td>{r.orders}</td>
                  <td>{r.commercial_quantity}</td>
                  {financial && (
                    <>
                      <td>{salesReportMoney(r.goods_gross_minor, r.currency)}</td>
                      <td>{salesReportMoney(r.goods_net_minor, r.currency)}</td>
                      <td>{salesReportMoney(r.delivery_gross_minor, r.currency)}</td>
                      <td>{salesReportMoney(r.total_gross_minor, r.currency)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.sales.length && <p>Brak sprzedaży w tym zakresie.</p>}
      </section>
      <section>
        <h3>Zwroty według daty uznania</h3>
        <p>
          Zwroty uznane w okresie, także dotyczące wcześniejszej sprzedaży. Uznanie na podstawie
          dowodu dostawcy nie jest przyjęciem we własnym magazynie. Wartość uznanych zwrotów jest
          odrębna od wypłaconych refundacji.
        </p>
        <div className="sales-report-scroll">
          <table>
            <thead>
              <tr>
                <th>Waluta</th>
                <th>Zwroty</th>
                <th>Przyjęto</th>
                <th>Na stan</th>
                {financial && (
                  <>
                    <th>Towary brutto</th>
                    <th>Towary netto</th>
                    <th>Dostawa brutto</th>
                    <th>Razem brutto</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data.returns.map((r) => (
                <tr key={r.currency}>
                  <td>{r.currency}</td>
                  <td>{r.cases}</td>
                  <td>{r.accepted_quantity}</td>
                  <td>{r.restocked_quantity}</td>
                  {financial && (
                    <>
                      <td>{salesReportMoney(r.goods_gross_minor, r.currency)}</td>
                      <td>{salesReportMoney(r.goods_net_minor, r.currency)}</td>
                      <td>{salesReportMoney(r.delivery_gross_minor, r.currency)}</td>
                      <td>{salesReportMoney(r.total_gross_minor, r.currency)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.returns.length && <p>Brak przyjętych zwrotów w tym zakresie.</p>}
      </section>
      <section>
        <h3>Koszt towaru według daty wydania i przywrócenia na stan</h3>
        <p>
          Fizyczne ruchy zapisane w systemie, także w trybie DEMO. Magazyn oznacza miejsce wydania
          lub przywrócenia na stan. Koszty FIFO są netto. Nieznany koszt nie jest kosztem zerowym.
        </p>
        <div className="sales-report-scroll">
          <table>
            <thead>
              <tr>
                <th>Waluta kosztu</th>
                <th>Wydano</th>
                <th>Na stan</th>
                {financial && (
                  <>
                    <th>Znany koszt wydań netto</th>
                    <th>Znany koszt przywrócony netto</th>
                    <th>Nieznany koszt · wydano</th>
                    <th>Nieznany koszt · na stan</th>
                    <th>Zmiana ilości z nieznanym kosztem</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data.costs.map((r) => (
                <tr key={r.currency}>
                  <td>{r.currency}</td>
                  <td>{r.issued_quantity}</td>
                  <td>{r.restocked_quantity}</td>
                  {financial && (
                    <>
                      <td>{salesReportMoney(r.issued_known_minor, r.currency)}</td>
                      <td>{salesReportMoney(r.restocked_known_minor, r.currency)}</td>
                      <td>{r.issued_unknown_quantity ?? 'Brak danych'}</td>
                      <td>{r.restocked_unknown_quantity ?? 'Brak danych'}</td>
                      <td>{r.net_unknown_quantity ?? 'Brak danych'}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.costs.length && (
          <p>
            Brak zarejestrowanych ruchów kosztowych w tym zakresie. Nie potwierdza to braku kosztu
            sprzedanego towaru.
          </p>
        )}
      </section>
      <section className="sales-report-cohort">
        <h3>Bieżąca marża towarów z zamówień utworzonych w okresie</h3>
        <p>
          Stan na {timestamp(data.as_of)}: towary netto po wszystkich przyjętych zwrotach,
          pomniejszone o koszt wydanych towarów netto po przywróceniach na stan. Dostawa nie wchodzi
          do tej marży. Filtr magazynu dotyczy magazynu zamówienia; wycena uwzględnia również jego
          zwroty przyjęte do innych magazynów. To odrębne zestawienie; nie odejmujemy od siebie
          trzech powyższych sum okresowych.
        </p>
        <div className="sales-report-scroll">
          <table>
            <thead>
              <tr>
                <th>Waluta</th>
                <th>Zamówienia</th>
                {financial && (
                  <>
                    <th>Towary netto po zwrotach</th>
                    <th>Znany koszt netto</th>
                    <th>Kompletne / niepełne</th>
                    <th>Nieznany koszt / brak wydania</th>
                    <th>Marża towarów netto</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data.cohort_current.map((r) => (
                <tr key={r.currency}>
                  <td>{r.currency}</td>
                  <td>{r.orders}</td>
                  {financial && (
                    <>
                      <td>{salesReportMoney(r.current_goods_net_minor, r.currency)}</td>
                      <td>{salesReportMoney(r.net_known_cost_minor, r.currency)}</td>
                      <td>
                        {r.complete_order_count ?? '—'} / {r.incomplete_order_count ?? '—'}
                      </td>
                      <td>
                        {r.unknown_cost_quantity ?? '—'} / {r.missing_issue_quantity ?? '—'}
                      </td>
                      <td>
                        <strong>{salesReportMoney(r.margin_minor, r.currency)}</strong>
                        {r.margin_minor == null && (
                          <small>
                            Marża niedostępna przy niepełnym lub nieporównywalnym koszcie.
                          </small>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.cohort_current.length && <p>Brak zamówień w tym zakresie.</p>}
      </section>
    </div>
  );
}
function OrderDetailView({
  detail,
  financial,
  onClose,
}: {
  detail: OrderDetail;
  financial: boolean;
  onClose: () => void;
}) {
  const o = detail.order;
  const originalIssueKnown =
    o.issued_known_cost_minor != null &&
    o.warranty_known_cost_minor != null &&
    /^-?\d+$/.test(o.issued_known_cost_minor) &&
    /^-?\d+$/.test(o.warranty_known_cost_minor)
      ? (BigInt(o.issued_known_cost_minor) - BigInt(o.warranty_known_cost_minor)).toString()
      : null;
  return (
    <section className="sales-report-detail" aria-label={'Raport zamówienia ' + o.number}>
      <div className="sales-report-actions">
        <h3>Szczegóły · {o.number}</h3>
        <button className="button" onClick={onClose}>
          Zamknij szczegóły
        </button>
      </div>
      <p>
        Stan na {timestamp(detail.as_of)} · {o.currency}. Ceny i VAT z zapisanych pozycji
        zamówienia.
      </p>
      {financial && (
        <>
          <div className="sales-report-totals">
            <span>
              Towary brutto <strong>{salesReportMoney(o.goods_gross_minor, o.currency)}</strong>
            </span>
            <span>
              Towary netto <strong>{salesReportMoney(o.goods_net_minor, o.currency)}</strong>
            </span>
            <span>
              Dostawa brutto <strong>{salesReportMoney(o.delivery_gross_minor, o.currency)}</strong>
            </span>
            <span>
              Razem brutto <strong>{salesReportMoney(o.total_gross_minor, o.currency)}</strong>
            </span>
            <span>
              Marża towarów <strong>{salesReportMoney(o.margin_minor, o.currency)}</strong>
            </span>
          </div>
          {o.cost_reasons?.length ? (
            <p className="sales-report-notice">{o.cost_reasons.map(reason).join(' · ')}</p>
          ) : null}
        </>
      )}
      <h4>Pozycje handlowe</h4>
      <p>
        Wymiana zachowuje sprzedaną ilość i wartość. Fizyczne przyjęcie reklamacji oraz przywrócenie
        na stan pokazano osobno od sztuk pomniejszających sprzedaż przy zwrocie środków.
      </p>
      <div className="sales-report-scroll">
        <table>
          <thead>
            <tr>
              <th>SKU / produkt</th>
              <th>Ilość</th>
              <th>Pomniejszenie sprzedaży · szt.</th>
              <th>Fizycznie przyjęto / na stan</th>
              {financial && (
                <>
                  <th>VAT</th>
                  <th>Wartość brutto</th>
                  <th>Wartość netto</th>
                  <th>Zwrot brutto</th>
                  <th>Zwrot netto</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {detail.commercial_lines.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.sku}
                  <small>{r.name}</small>
                </td>
                <td>{r.quantity}</td>
                <td>{r.accepted_quantity}</td>
                <td>
                  {r.physically_accepted_quantity ?? '—'} / {r.restocked_quantity}
                </td>
                {financial && (
                  <>
                    <td>{r.vat}%</td>
                    <td>{salesReportMoney(r.line_total_minor, o.currency)}</td>
                    <td>{salesReportMoney(r.net_minor, o.currency)}</td>
                    <td>{salesReportMoney(r.returned_gross_minor, o.currency)}</td>
                    <td>{salesReportMoney(r.returned_net_minor, o.currency)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Fizyczny koszt pierwotnej realizacji</h4>
      <p>
        Koszt jest przypisany do fizycznego produktu i partii. Pozycje handlowe o tym samym SKU lub
        składniki zestawów nie mają tutaj osobno wyliczonej marży.
      </p>
      {financial && (
        <>
          <p>
            Tabela poniżej obejmuje pierwotne wydanie i przywrócenie towaru. Koszt wydania
            zamienników jest doliczony osobno do kosztu pierwotnej sprzedaży. Znany koszt
            pierwotnych wydań + znany koszt zamienników − znany koszt przywrócony na stan daje znany
            koszt netto uwzględniony w marży, w walucie zamówienia. Nieznany koszt nie jest zerem.
          </p>
          <div className="sales-report-totals">
            <span>
              Znany koszt pierwotnych wydań netto{' '}
              <strong>{salesReportMoney(originalIssueKnown, o.currency)}</strong>
            </span>
            <span>
              Znany koszt zamienników netto{' '}
              <strong>{salesReportMoney(o.warranty_known_cost_minor, o.currency)}</strong>
            </span>
            <span>
              Znany koszt przywrócony na stan netto{' '}
              <strong>{salesReportMoney(o.restocked_known_cost_minor, o.currency)}</strong>
            </span>
            <span>
              Znany koszt netto w marży{' '}
              <strong>{salesReportMoney(o.net_known_cost_minor, o.currency)}</strong>
            </span>
          </div>
        </>
      )}
      <div className="sales-report-scroll">
        <table>
          <thead>
            <tr>
              <th>Produkt fizyczny</th>
              <th>Waluta kosztu</th>
              <th>Wydano</th>
              <th>Na stan</th>
              {financial && (
                <>
                  <th>Znany koszt wydań netto</th>
                  <th>Znany koszt przywrócony netto</th>
                  <th>Nieznany koszt · ilość</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {detail.physical_costs.map((r) => (
              <tr key={r.product_id + ':' + r.currency}>
                <td>
                  {r.name ??
                    detail.commercial_lines.find((l) => l.product_id === r.product_id)?.name ??
                    'Składnik fizyczny'}
                  {r.sku && <small>{r.sku}</small>}
                  <details>
                    <summary>Identyfikator produktu</summary>
                    <code>{r.product_id}</code>
                  </details>
                </td>
                <td>{r.currency}</td>
                <td>{r.issued_quantity}</td>
                <td>{r.restocked_quantity}</td>
                {financial && (
                  <>
                    <td>{salesReportMoney(r.issued_known_minor, r.currency)}</td>
                    <td>{salesReportMoney(r.restocked_known_minor, r.currency)}</td>
                    <td>{r.unknown_quantity ?? 'Brak danych'}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!detail.physical_costs.length && (
        <p>Brak zarejestrowanych fragmentów wyceny dla tego zamówienia.</p>
      )}
    </section>
  );
}
