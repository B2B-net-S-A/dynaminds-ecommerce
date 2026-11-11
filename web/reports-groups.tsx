import { useEffect, useRef, useState } from 'react';
import { api } from './api';

/** ANALYTICS-002: sales grouped by source, delivery or payment, with an optional comparison period.
 * The server decides values from the current membership; operators see counts only. */
export type GroupBy = 'source' | 'delivery' | 'payment';
export interface GroupFilters { from: string; to: string; currency: string; source: string; status: string }
interface GroupRow {
  currency: string; group: string; label: string; orders: number; compare_orders: number | null; orders_delta?: number;
  total_gross_minor?: string; compare_total_gross_minor?: string; total_delta_minor?: string; total_change_bps?: number | null; share_bps?: number | null;
}
interface GroupsReport {
  can_read_value: boolean; current_role: string; read_only?: boolean; group_by: GroupBy;
  period: { from: string; to: string; orders: number; unrecorded_orders: number };
  compare: { from: string; to: string; orders: number; unrecorded_orders: number } | null;
  groups: GroupRow[];
  totals: { currency: string; orders: number; total_gross_minor?: string }[];
  compare_totals: { currency: string; orders: number; total_gross_minor?: string }[] | null;
  dimensions_available: boolean;
}

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** The period of the same length directly before [from, to] (calendar days). */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
  const days = Math.round((b - a) / DAY) + 1;
  return { from: iso(a - days * DAY), to: iso(a - DAY) };
}
const num = (v: number | string) => String(v).replace(/^-/, '−').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const signed = (v: number) => (v > 0 ? '+' : '') + num(v);
export function groupMoney(value: string | null | undefined, currency: string): string {
  if (value == null || !/^-?\d+$/.test(value)) return '—';
  const n = BigInt(value), abs = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}${(abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${(abs % 100n).toString().padStart(2, '0')} ${currency}`;
}
export const bps = (v: number | null | undefined): string => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + (Math.abs(v) / 100).toFixed(1).replace('.', ',') + ' %');
const share = (v: number | null | undefined) => (v == null ? '—' : (v / 100).toFixed(1).replace('.', ',') + ' %');
const dimNames: Record<GroupBy, string> = { source: 'Źródło', delivery: 'Forma dostawy', payment: 'Forma płatności' };

export function GroupsView({ filters, admin, readOnly, sourceNames }: { filters: GroupFilters; admin: boolean; readOnly: boolean; sourceNames: Record<string, string> }) {
  const [groupBy, setGroupBy] = useState<GroupBy>('delivery');
  const [compare, setCompare] = useState(true);
  const [range, setRange] = useState(() => previousPeriod(filters.from, filters.to));
  const [data, setData] = useState<GroupsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const generation = useRef(0);
  useEffect(() => setRange(previousPeriod(filters.from, filters.to)), [filters.from, filters.to]);

  async function load(g: GroupBy = groupBy, withCompare = compare, r = range) {
    const n = ++generation.current;
    setBusy(true);
    setError('');
    const q = new URLSearchParams({ from: filters.from, to: filters.to, group_by: g });
    if (filters.currency) q.set('currency', filters.currency);
    if (filters.source) q.set('sources', filters.source);
    if (filters.status) q.set('statuses', filters.status);
    if (withCompare) {
      q.set('compare_from', r.from);
      q.set('compare_to', r.to);
    }
    try {
      const body = await api<GroupsReport>('/reports/sales/groups?' + q.toString());
      if (n === generation.current) setData(body);
    } catch (e) {
      if (n === generation.current) {
        setData(null);
        setError(e instanceof Error ? e.message : 'Nie udało się odczytać raportu.');
      }
    } finally {
      if (n === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [filters.from, filters.to, filters.currency, filters.source, filters.status]);

  async function backfill() {
    setNote('');
    try {
      const r = await api<{ recorded: number; remaining: number }>('/reports/sales/dimensions/backfill', 'POST', { confirmed: true });
      setNote(`Uzupełniono ${num(r.recorded)} zamówień; pozostało ${num(r.remaining)}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nie udało się uzupełnić danych.');
    }
  }
  const value = data?.can_read_value ?? false;
  const cmp = data?.compare ?? null;
  const label = (r: GroupRow) => (data?.group_by === 'source' ? sourceNames[r.group] ?? r.group : r.label);
  const currencies = [...new Set((data?.groups ?? []).map((r) => r.currency))];
  return (
    <section aria-label="Grupy i porównanie okresów">
      <form
        className="report-analytics-filters"
        aria-label="Grupowanie i okres porównania"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          Grupuj według
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            {(Object.keys(dimNames) as GroupBy[]).map((g) => (
              <option key={g} value={g}>
                {dimNames[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="report-analytics-check">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Porównaj z okresem
        </label>
        <label>
          Porównanie od
          <input type="date" disabled={!compare} required={compare} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </label>
        <label>
          Porównanie do
          <input type="date" disabled={!compare} required={compare} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </label>
        <button className="button primary" disabled={busy}>
          {busy ? 'Odczytywanie…' : 'Pokaż grupy'}
        </button>
      </form>
      {error && (
        <div className="report-analytics-error" role="alert">
          {error}
        </div>
      )}
      {note && <p role="status" className="report-analytics-note">{note}</p>}
      {data && (
        <>
          <p className="report-analytics-note">
            {dimNames[data.group_by]} · okres {data.period.from} – {data.period.to}: {num(data.period.orders)} zamówień
            {cmp && ` · porównanie ${cmp.from} – ${cmp.to}: ${num(cmp.orders)} zamówień`}
            {!value && ' · Ten dostęp obejmuje liczby zamówień. Kwoty są ukryte.'}
          </p>
          {data.group_by !== 'source' && data.period.unrecorded_orders > 0 && (
            <p className="report-analytics-note">
              {num(data.period.unrecorded_orders)} zamówień nie ma zapisanej formy dostawy i płatności (zamówienia ręczne albo zaimportowane przed
              wdrożeniem); są w grupie „Brak danych”.
              {admin && !readOnly && (
                <>
                  {' '}
                  <button type="button" className="text-button" onClick={() => void backfill()}>
                    Uzupełnij z zapisanych importów
                  </button>
                </>
              )}
            </p>
          )}
          {currencies.map((c) => {
            const rows = data.groups.filter((r) => r.currency === c);
            const total = data.totals.find((t) => t.currency === c);
            const before = data.compare_totals?.find((t) => t.currency === c);
            return (
              <div className="report-analytics-table" key={c}>
                <table aria-label={`${dimNames[data.group_by]} · ${c}`}>
                  <thead>
                    <tr>
                      <th>{dimNames[data.group_by]}</th>
                      <th>Zamówienia</th>
                      {cmp && <th>Poprzednio</th>}
                      {cmp && <th>Zmiana</th>}
                      {value && <th>Razem brutto</th>}
                      {value && cmp && <th>Poprzednio brutto</th>}
                      {value && cmp && <th>Zmiana wartości</th>}
                      {value && <th>Udział</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.group}>
                        <td>{label(r)}</td>
                        <td>{num(r.orders)}</td>
                        {cmp && <td>{num(r.compare_orders ?? 0)}</td>}
                        {cmp && <td>{signed(r.orders_delta ?? 0)}</td>}
                        {value && <td>{groupMoney(r.total_gross_minor, c)}</td>}
                        {value && cmp && <td>{groupMoney(r.compare_total_gross_minor, c)}</td>}
                        {value && cmp && (
                          <td>
                            {groupMoney(r.total_delta_minor, c)} <small>{bps(r.total_change_bps)}</small>
                          </td>
                        )}
                        {value && <td>{share(r.share_bps)}</td>}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th>Razem {c}</th>
                      <th>{num(total?.orders ?? 0)}</th>
                      {cmp && <th>{num(before?.orders ?? 0)}</th>}
                      {cmp && <th>{signed((total?.orders ?? 0) - (before?.orders ?? 0))}</th>}
                      {value && <th>{groupMoney(total?.total_gross_minor ?? '0', c)}</th>}
                      {value && cmp && <th>{groupMoney(before?.total_gross_minor ?? '0', c)}</th>}
                      {value && cmp && <th>{groupMoney((BigInt(total?.total_gross_minor ?? '0') - BigInt(before?.total_gross_minor ?? '0')).toString(), c)}</th>}
                      {value && <th>100,0 %</th>}
                    </tr>
                  </tfoot>
                </table>
              </div>
            );
          })}
          {!data.groups.length && <div className="report-analytics-empty">Brak sprzedaży w wybranych okresach.</div>}
        </>
      )}
    </section>
  );
}
