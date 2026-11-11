import { useEffect, useRef, useState } from 'react';
import { api, ApiError, statusNames } from './api';
import './reports-analytics.css';
import { GroupsView } from './reports-groups';

/** Analytics reports (S7): sales over time with a chart, products per SKU, customers
 * and employees. The server decides values and personal data from the current
 * membership; this view only shows what it receives. */
type Granularity = 'day' | 'week' | 'month';
type Tab = 'periods' | 'groups' | 'products' | 'customers' | 'employees';
type Filters = { from: string; to: string; granularity: Granularity; currency: string; source: string; status: string };
type Flags = { current_role: string; can_read_value: boolean; read_only?: boolean };
type Bucket = { key: string; label: string; from: string; to: string; from_at: string; to_exclusive_at: string; hours: number };
type Metrics = { orders: string; commercial_quantity: string; goods_gross_minor?: string; goods_net_minor?: string; delivery_gross_minor?: string; total_gross_minor?: string };
type Periods = Flags & {
  buckets: Bucket[];
  series: { currency: string; points: (Metrics & { key: string })[]; totals: Metrics }[];
  by_source: (Metrics & { currency: string; source: string })[];
  by_status: (Metrics & { currency: string; status: string })[];
  options: { sources: string[]; statuses: string[] };
  as_of: string;
};
type SkuRow = {
  sku: string; name: string; currency: string; lines: string; quantity: string; returned_quantity: string; net_quantity: string;
  gross_minor?: string; returned_gross_minor?: string; gross_after_returns_minor?: string; min_unit_price_minor?: string; max_unit_price_minor?: string; avg_unit_price_minor?: string;
  price_bands?: { from_minor: string; to_minor: string | null; quantity: string }[];
};
type Products = Flags & { data: SkuRow[]; totals: (Record<string, string> & { currency: string })[]; meta: { total: number; shown: number } };
type Customers = Flags & {
  personal_data: 'visible' | 'masked';
  summary: { customers: number; new_customers: number; returning_customers: number; repeat_in_period: number; orders: number; orders_without_email: number };
  currencies: { currency: string; customers: number; new_customers: number; returning_customers: number; orders: number; total_gross_minor?: string; avg_per_customer_minor?: string | null; returning_gross_minor?: string }[];
  countries: { country: string; currency: string; customers: number; orders: number; total_gross_minor?: string }[];
  top_customers: { rank: number; currency: string; email: string; customer_name: string; country: string; kind: 'new' | 'returning'; orders: number; lifetime_orders: number; total_gross_minor?: string }[];
};
type Employees = Flags & {
  employees: { user_id: string | null; name: string; email: string; role: string | null; status_changes: number; packings: number; payments: number; refunds: number; orders_touched: number;
    status_targets: { status: string; count: number }[]; amounts: { kind: string; currency: string; count: number; amount_minor: string }[] }[];
  totals: { status_changes: number; packings: number; payments: number; refunds: number };
};

export function analyticsMoney(value: string | null | undefined, currency: string): string {
  if (value == null || !/^-?\d+$/.test(value)) return '—';
  const n = BigInt(value), abs = n < 0n ? -n : n;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0n ? '−' : ''}${whole},${(abs % 100n).toString().padStart(2, '0')} ${currency}`;
}
const sourceNames: Record<string, string> = { manual: 'Ręczne', demo: 'Demo', woocommerce: 'WooCommerce', shopify: 'Shopify', allegro: 'Allegro', prestashop: 'PrestaShop', ebay: 'eBay', amazon: 'Amazon', b2b: 'B2B', order_merge: 'Połączone zamówienia', mirakl: 'Mirakl', odoo: 'Odoo' };
/** Band edges are whole currency units in the label (5000 gr → 50). */
const bandEdge = (minor: string) => (BigInt(minor) % 100n === 0n ? num((BigInt(minor) / 100n).toString()) : analyticsMoney(minor, '').trim());
const roleNames: Record<string, string> = { admin: 'Administrator', operator: 'Operator', viewer: 'Podgląd' };
const tabNames: Record<Tab, string> = { periods: 'Sprzedaż w czasie', groups: 'Grupy i porównanie', products: 'Produkty', customers: 'Klienci', employees: 'Pracownicy' };
const num = (v: string | number) => String(v).replace(/^-/, '−').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function today() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map((k) => p.find((x) => x.type === k)!.value).join('-');
}
const initial = (): Filters => {
  const to = today();
  return { from: to.slice(0, 8) + '01', to, granularity: 'day', currency: '', source: '', status: '' };
};
function query(f: Filters, tab: Tab, extra: Record<string, string> = {}) {
  const p = new URLSearchParams({ from: f.from, to: f.to, ...extra });
  if (tab !== 'employees') {
    if (f.currency) p.set('currency', f.currency);
    if (f.source) p.set('sources', f.source);
    if (f.status) p.set('statuses', f.status);
  }
  if (tab === 'periods') p.set('granularity', f.granularity);
  return p.toString();
}
const paths: Record<Tab, string> = { periods: '/reports/sales/periods', groups: '/reports/sales/groups', products: '/reports/products', customers: '/reports/customers', employees: '/reports/employees' };

export type ReportAnalyticsProps = { workspaceId: string; contextKey: string; readOnly: boolean };

export function ReportAnalytics({ workspaceId, contextKey, readOnly }: ReportAnalyticsProps) {
  const admin = contextKey.split(':')[2] === 'admin';
  const [draft, setDraft] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters | null>(null);
  const [tab, setTab] = useState<Tab>('periods');
  const [data, setData] = useState<Partial<Record<Tab, unknown>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setData({});
    setApplied(null);
    setError('');
  }, [workspaceId, contextKey]);

  async function load(t: Tab, f: Filters) {
    if (t === 'groups') return; // GroupsView reads its own grouping and comparison period.
    const g = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const body = await api<any>(paths[t] + '?' + query(f, t));
      if (g !== generation.current) return;
      setData((d) => ({ ...d, [t]: body }));
      if (body.options?.sources) setSources(body.options.sources);
    } catch (e) {
      if (g !== generation.current) return;
      setData((d) => ({ ...d, [t]: undefined }));
      setError(e instanceof Error ? e.message : 'Nie udało się odczytać raportu.');
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  async function download(t: 'periods' | 'products') {
    if (!applied) return;
    setError('');
    try {
      const r = await fetch('/api' + paths[t] + '/file?' + query(applied, t), { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Workspace-ID': workspaceId } });
      if (!r.ok) {
        const p = (await r.json().catch(() => ({}))) as { detail?: string; code?: string };
        throw new ApiError(p.detail ?? 'Nie udało się pobrać CSV.', r.status, p.code);
      }
      if (!(r.headers.get('Content-Type') ?? '').includes('text/csv')) throw new Error('Serwer nie zwrócił pliku CSV.');
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${t === 'periods' ? 'sprzedaz-okresy' : 'produkty'}-${applied.from}-${applied.to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nie udało się pobrać CSV.');
    }
  }
  const dirty = applied !== null && JSON.stringify(applied) !== JSON.stringify(draft);
  const current = data[tab];
  const tabs: Tab[] = admin ? ['periods', 'groups', 'products', 'customers', 'employees'] : ['periods', 'groups', 'products', 'customers'];

  return (
    <section className="report-analytics" aria-label="Analizy sprzedaży">
      <div className="report-analytics-intro">
        <h2>Analizy: okresy, produkty, klienci i pracownicy</h2>
        <p>
          Okresy liczone według czasu w Polsce (także w dniach zmiany czasu). Sumy każdej waluty są osobne. Anulowane zamówienia nie są sprzedażą; status
          to bieżący status zamówienia.
        </p>
      </div>
      <form
        className="report-analytics-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
          setData({});
          void load(tab, draft);
        }}
      >
        <label>
          Data od
          <input type="date" required value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label>
          Data do
          <input type="date" required value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <label>
          Podział
          <select value={draft.granularity} onChange={(e) => setDraft({ ...draft, granularity: e.target.value as Granularity })}>
            <option value="day">Dzień</option>
            <option value="week">Tydzień (od poniedziałku)</option>
            <option value="month">Miesiąc</option>
          </select>
        </label>
        <label>
          Źródło
          <select value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })}>
            <option value="">Wszystkie źródła</option>
            {[...new Set([...sources, ...Object.keys(sourceNames)])].map((s) => (
              <option key={s} value={s}>
                {sourceNames[s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
            <option value="">Wszystkie poza anulowanymi</option>
            {['new', 'paid', 'picking', 'packed', 'shipped', 'delivered', 'completed', 'return_initiated', 'return_received', 'return_completed'].map((s) => (
              <option key={s} value={s}>
                {statusNames[s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Waluta
          <select value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}>
            <option value="">Wszystkie, osobno</option>
            {['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <button className="button primary" disabled={busy}>
          {busy ? 'Odczytywanie…' : 'Pokaż analizę'}
        </button>
      </form>
      {readOnly && <p className="report-analytics-note">Kopia tylko do odczytu. Analizy można przeglądać i pobierać.</p>}
      {dirty && <p className="report-analytics-note">Filtry zmieniono. Kliknij „Pokaż analizę”, aby przeliczyć.</p>}
      {error && (
        <div className="report-analytics-error" role="alert">
          {error}
        </div>
      )}
      {applied && (
        <>
          <nav className="report-analytics-tabs" role="tablist" aria-label="Rodzaj analizy">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={'button ' + (tab === t ? 'primary' : '')}
                onClick={() => {
                  setTab(t);
                  if (!data[t]) void load(t, applied);
                }}
              >
                {tabNames[t]}
              </button>
            ))}
          </nav>
          {busy && !current && tab !== 'groups' && <p role="status">Odczytywanie analizy…</p>}
          {tab === 'groups' && <GroupsView filters={applied} admin={admin} readOnly={readOnly} sourceNames={sourceNames} />}
          {tab === 'periods' && current != null && <PeriodsView data={current as Periods} onCsv={() => void download('periods')} />}
          {tab === 'products' && current != null && <ProductsView data={current as Products} onCsv={() => void download('products')} />}
          {tab === 'customers' && current != null && <CustomersView data={current as Customers} />}
          {tab === 'employees' && current != null && <EmployeesView data={current as Employees} />}
        </>
      )}
      {!applied && <div className="report-analytics-empty">Wybierz zakres i kliknij „Pokaż analizę”. Odczyt niczego nie zmienia.</div>}
    </section>
  );
}

function ValueNote({ data }: { data: Flags }) {
  return data.can_read_value ? null : <p className="report-analytics-note">Ten dostęp obejmuje ilości. Kwoty są ukryte.</p>;
}

/** Bar chart in plain SVG with a data table: every bar has a text equivalent. */
export function SeriesChart({ buckets, points, metric, currency, title }: { buckets: Bucket[]; points: (Metrics & { key: string })[]; metric: keyof Metrics; currency: string; title: string }) {
  const values = points.map((p) => Number(p[metric] ?? 0));
  const max = Math.max(1, ...values);
  const money = metric.endsWith('_minor');
  const show = (v: number) => (money ? analyticsMoney(String(v), currency) : num(v));
  const W = 720, H = 220, left = 8, bottom = 28, top = 18;
  const step = (W - left * 2) / Math.max(1, points.length);
  const labelEvery = Math.ceil(points.length / 12);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <figure className="report-analytics-chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${points.length} okresów, razem ${show(total)}, najwyżej ${show(Math.max(...values, 0))}.`}>
        <line x1={left} x2={W - left} y1={H - bottom} y2={H - bottom} className="axis" />
        <text x={left} y={12} className="max">
          maks. {show(max)}
        </text>
        {points.map((p, i) => {
          const h = ((H - bottom - top) * values[i]) / max;
          const b = buckets[i];
          return (
            <g key={p.key}>
              <rect x={left + i * step + step * 0.12} width={Math.max(1, step * 0.76)} y={H - bottom - h} height={h} className={values[i] < 0 ? 'bar negative' : 'bar'}>
                <title>{`${b.label}: ${show(values[i])}`}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text x={left + i * step + step / 2} y={H - 10} textAnchor="middle" className="tick">
                  {/[a-ząćęłńóśźż]/i.test(b.label) ? b.label.slice(0, 3) + ' ' + b.label.slice(-4) : b.label.slice(0, 5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function PeriodsView({ data, onCsv }: { data: Periods; onCsv: () => void }) {
  const [currency, setCurrency] = useState(data.series[0]?.currency ?? '');
  const series = data.series.find((s) => s.currency === currency) ?? data.series[0];
  const value = data.can_read_value;
  const metric: keyof Metrics = value ? 'total_gross_minor' : 'commercial_quantity';
  if (!series) return <div className="report-analytics-empty">Brak sprzedaży w wybranym zakresie.</div>;
  return (
    <div className="report-analytics-panel">
      <ValueNote data={data} />
      <div className="report-analytics-totals">
        {data.series.map((s) => (
          <div key={s.currency} className="report-analytics-tile">
            <span>{s.currency}</span>
            <strong>{value ? analyticsMoney(s.totals.total_gross_minor, s.currency) : num(s.totals.commercial_quantity) + ' szt.'}</strong>
            <small>
              {num(s.totals.orders)} zamówień · {num(s.totals.commercial_quantity)} szt.
            </small>
          </div>
        ))}
      </div>
      {data.series.length > 1 && (
        <label className="report-analytics-inline">
          Waluta wykresu{' '}
          <select value={series.currency} onChange={(e) => setCurrency(e.target.value)}>
            {data.series.map((s) => (
              <option key={s.currency}>{s.currency}</option>
            ))}
          </select>
        </label>
      )}
      <SeriesChart buckets={data.buckets} points={series.points} metric={metric} currency={series.currency} title={`${value ? 'Wartość brutto' : 'Sprzedane sztuki'} według okresu, ${series.currency}`} />
      <div className="report-analytics-actions">
        <button type="button" className="button" onClick={onCsv}>
          Pobierz dane wykresu CSV
        </button>
        <span>Wiersze CSV sumują się do wiersza „Razem” i do podsumowania raportu sprzedaży.</span>
      </div>
      <details open>
        <summary>Dane wykresu ({series.currency})</summary>
        <div className="report-analytics-table">
          <table>
            <thead>
              <tr>
                <th>Okres</th>
                <th>Zamówienia</th>
                <th>Sztuki</th>
                {value && <th>Towar brutto</th>}
                {value && <th>Dostawa</th>}
                {value && <th>Razem brutto</th>}
              </tr>
            </thead>
            <tbody>
              {series.points.map((p, i) => (
                <tr key={p.key}>
                  <td>{data.buckets[i].label}{data.buckets[i].hours !== 24 && data.buckets[i].hours % 24 !== 0 ? ` (${data.buckets[i].hours} h)` : ''}</td>
                  <td>{num(p.orders)}</td>
                  <td>{num(p.commercial_quantity)}</td>
                  {value && <td>{analyticsMoney(p.goods_gross_minor, series.currency)}</td>}
                  {value && <td>{analyticsMoney(p.delivery_gross_minor, series.currency)}</td>}
                  {value && <td>{analyticsMoney(p.total_gross_minor, series.currency)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Razem</th>
                <th>{num(series.totals.orders)}</th>
                <th>{num(series.totals.commercial_quantity)}</th>
                {value && <th>{analyticsMoney(series.totals.goods_gross_minor, series.currency)}</th>}
                {value && <th>{analyticsMoney(series.totals.delivery_gross_minor, series.currency)}</th>}
                {value && <th>{analyticsMoney(series.totals.total_gross_minor, series.currency)}</th>}
              </tr>
            </tfoot>
          </table>
        </div>
      </details>
      <div className="report-analytics-split">
        <Breakdown title="Według źródła" rows={data.by_source.map((r) => ({ ...r, label: sourceNames[r.source] ?? r.source }))} value={value} />
        <Breakdown title="Według statusu" rows={data.by_status.map((r) => ({ ...r, label: statusNames[r.status] ?? r.status }))} value={value} />
      </div>
    </div>
  );
}
function Breakdown({ title, rows, value }: { title: string; rows: (Metrics & { currency: string; label: string })[]; value: boolean }) {
  return (
    <section>
      <h3>{title}</h3>
      <div className="report-analytics-table">
        <table>
          <thead>
            <tr>
              <th>Pozycja</th>
              <th>Waluta</th>
              <th>Zamówienia</th>
              <th>Sztuki</th>
              {value && <th>Razem brutto</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.currency + r.label}>
                <td>{r.label}</td>
                <td>{r.currency}</td>
                <td>{num(r.orders)}</td>
                <td>{num(r.commercial_quantity)}</td>
                {value && <td>{analyticsMoney(r.total_gross_minor, r.currency)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProductsView({ data, onCsv }: { data: Products; onCsv: () => void }) {
  const value = data.can_read_value;
  return (
    <div className="report-analytics-panel">
      <ValueNote data={data} />
      <div className="report-analytics-totals">
        {data.totals.map((t) => (
          <div key={t.currency} className="report-analytics-tile">
            <span>{t.currency}</span>
            <strong>{num(t.skus)} SKU</strong>
            <small>
              {num(t.quantity)} szt. · zwroty {num(t.returned_quantity)}
              {value && ' · ' + analyticsMoney(t.gross_minor, t.currency)}
            </small>
          </div>
        ))}
      </div>
      <div className="report-analytics-actions">
        <button type="button" className="button" onClick={onCsv}>
          Pobierz statystykę produktów CSV
        </button>
        <span>
          Pokazano {data.meta.shown} z {data.meta.total} pozycji; CSV zawiera wszystkie. Zwroty przyjęte do chwili odczytu dla sprzedaży z okresu, ze znakiem minus.
        </span>
      </div>
      <div className="report-analytics-table">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Nazwa</th>
              <th>Waluta</th>
              <th>Sprzedane</th>
              <th>Zwroty</th>
              <th>Netto szt.</th>
              {value && <th>Wartość brutto</th>}
              {value && <th>Zwroty brutto</th>}
              {value && <th>Śr. cena</th>}
              {value && <th>Cena min – maks.</th>}
              {value && <th>Przedziały cen (szt.)</th>}
            </tr>
          </thead>
          <tbody>
            {data.data.map((s) => (
              <tr key={s.currency + s.sku}>
                <td className="mono">{s.sku}</td>
                <td>{s.name}</td>
                <td>{s.currency}</td>
                <td>{num(s.quantity)}</td>
                <td>{num(s.returned_quantity)}</td>
                <td>{num(s.net_quantity)}</td>
                {value && <td>{analyticsMoney(s.gross_minor, s.currency)}</td>}
                {value && <td>{analyticsMoney(s.returned_gross_minor, s.currency)}</td>}
                {value && <td className="nowrap">{analyticsMoney(s.avg_unit_price_minor, s.currency)}</td>}
                {value && (
                  <td className="nowrap">
                    {s.min_unit_price_minor === s.max_unit_price_minor
                      ? analyticsMoney(s.min_unit_price_minor, s.currency)
                      : `${analyticsMoney(s.min_unit_price_minor, '').trim()} – ${analyticsMoney(s.max_unit_price_minor, s.currency)}`}
                  </td>
                )}
                {value && (
                  <td>
                    {s.price_bands
                      ?.filter((b) => b.quantity !== '0')
                      .map((b) => `${bandEdge(b.from_minor)}–${b.to_minor ? bandEdge(b.to_minor) : '∞'} ${s.currency}: ${b.quantity} szt.`)
                      .join('; ')}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CustomersView({ data }: { data: Customers }) {
  const value = data.can_read_value;
  const s = data.summary;
  return (
    <div className="report-analytics-panel">
      <ValueNote data={data} />
      {data.personal_data === 'masked' && <p className="report-analytics-note">Dane osobowe klientów są zamaskowane dla Twojej roli.</p>}
      <div className="report-analytics-totals">
        {[
          ['Klienci', s.customers],
          ['Nowi', s.new_customers],
          ['Powracający', s.returning_customers],
          ['Kilka zamówień w okresie', s.repeat_in_period],
          ['Zamówienia bez e-maila', s.orders_without_email],
        ].map(([label, n]) => (
          <div key={label} className="report-analytics-tile">
            <span>{label}</span>
            <strong>{num(n)}</strong>
          </div>
        ))}
      </div>
      <p className="report-analytics-muted">Klient = adres e-mail bez względu na wielkość liter. Powracający = miał wcześniejsze zamówienie w tej firmie.</p>
      <div className="report-analytics-split">
        <section>
          <h3>Waluty</h3>
          <div className="report-analytics-table">
            <table>
              <thead>
                <tr>
                  <th>Waluta</th>
                  <th>Klienci</th>
                  <th>Nowi / powracający</th>
                  <th>Zamówienia</th>
                  {value && <th>Razem brutto</th>}
                  {value && <th>Na klienta</th>}
                </tr>
              </thead>
              <tbody>
                {data.currencies.map((c) => (
                  <tr key={c.currency}>
                    <td>{c.currency}</td>
                    <td>{num(c.customers)}</td>
                    <td>
                      {num(c.new_customers)} / {num(c.returning_customers)}
                    </td>
                    <td>{num(c.orders)}</td>
                    {value && <td>{analyticsMoney(c.total_gross_minor, c.currency)}</td>}
                    {value && <td>{analyticsMoney(c.avg_per_customer_minor, c.currency)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section>
          <h3>Kraje dostawy</h3>
          <div className="report-analytics-table">
            <table>
              <thead>
                <tr>
                  <th>Kraj</th>
                  <th>Waluta</th>
                  <th>Klienci</th>
                  <th>Zamówienia</th>
                  {value && <th>Razem brutto</th>}
                </tr>
              </thead>
              <tbody>
                {data.countries.map((c) => (
                  <tr key={c.country + c.currency}>
                    <td>{c.country || 'Brak'}</td>
                    <td>{c.currency}</td>
                    <td>{num(c.customers)}</td>
                    <td>{num(c.orders)}</td>
                    {value && <td>{analyticsMoney(c.total_gross_minor, c.currency)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <h3>Najwięksi klienci</h3>
      <div className="report-analytics-table">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Klient</th>
              <th>E-mail</th>
              <th>Kraj</th>
              <th>Rodzaj</th>
              <th>Zamówienia w okresie / łącznie</th>
              {value && <th>Wartość brutto</th>}
            </tr>
          </thead>
          <tbody>
            {data.top_customers.map((c) => (
              <tr key={c.currency + c.rank}>
                <td>{c.rank}</td>
                <td>{c.customer_name}</td>
                <td>{c.email}</td>
                <td>{c.country}</td>
                <td>{c.kind === 'new' ? 'Nowy' : 'Powracający'}</td>
                <td>
                  {num(c.orders)} / {num(c.lifetime_orders)}
                </td>
                {value && <td>{analyticsMoney(c.total_gross_minor, c.currency)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmployeesView({ data }: { data: Employees }) {
  return (
    <div className="report-analytics-panel">
      <div className="report-analytics-totals">
        {[
          ['Zmiany statusów', data.totals.status_changes],
          ['Pakowania', data.totals.packings],
          ['Płatności', data.totals.payments],
          ['Zwroty płatności', data.totals.refunds],
        ].map(([label, n]) => (
          <div key={label} className="report-analytics-tile">
            <span>{label}</span>
            <strong>{num(n)}</strong>
          </div>
        ))}
      </div>
      <p className="report-analytics-muted">Źródło: dziennik zdarzeń. Pakowanie = zakończona sesja pakowania na stanowisku.</p>
      <div className="report-analytics-table">
        <table>
          <thead>
            <tr>
              <th>Pracownik</th>
              <th>Rola</th>
              <th>Zmiany statusów</th>
              <th>Pakowania</th>
              <th>Płatności</th>
              <th>Zwroty</th>
              <th>Zamówienia</th>
              <th>Kwoty</th>
            </tr>
          </thead>
          <tbody>
            {data.employees.map((e) => (
              <tr key={e.user_id ?? 'system'}>
                <td>
                  {e.name || 'Użytkownik'}
                  {e.email && <small className="report-analytics-sub">{e.email}</small>}
                </td>
                <td>{e.role ? (roleNames[e.role] ?? e.role) : e.user_id ? 'Poza firmą' : '—'}</td>
                <td title={e.status_targets.map((s) => `${statusNames[s.status] ?? s.status}: ${s.count}`).join(', ')}>{num(e.status_changes)}</td>
                <td>{num(e.packings)}</td>
                <td>{num(e.payments)}</td>
                <td>{num(e.refunds)}</td>
                <td>{num(e.orders_touched)}</td>
                <td>
                  {e.amounts
                    .map((m) => `${m.kind === 'refund' ? 'zwrot ' : ''}${analyticsMoney(m.amount_minor, m.currency)}`)
                    .join('; ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
