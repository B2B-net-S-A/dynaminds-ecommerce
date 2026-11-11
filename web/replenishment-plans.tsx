import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, date } from './api';
import { ProductPicker } from './catalog';
import { ReplenishmentAutomations } from './replenishment-automations';
import './replenishment-plans.css';

export type ReplenishmentPlansProps = {
  contextKey: string;
  readOnly: boolean;
  onOpenPurchase: (id: string) => void;
  onError?: (message: string) => void;
};

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_manage: boolean;
  can_preview: boolean;
  can_execute: boolean;
  can_read_value: boolean;
};
type Warehouse = { id: string; name: string; code: string };
type Supplier = { id: string; name: string; code: string; active: boolean; version: number };
type PolicyDefinition = {
  enabled: boolean;
  minimum_quantity: number;
  target_quantity: number;
  supplier_id: string;
  supplier_sku: string;
  currency: string;
  minimum_order_quantity: number;
  order_multiple: number;
  unit_cost_minor: number | null;
  cost_valid_until: string | null;
  expected_date: string | null;
  confirm_cost: boolean;
};
type Policy = Partial<PolicyDefinition> & {
  id: string;
  warehouse_id: string;
  product_id: string;
  version: number;
  enabled: boolean;
  minimum_quantity: number;
  target_quantity: number;
  supplier_id: string;
  supplier_sku: string;
  currency: string;
  minimum_order_quantity: number;
  order_multiple: number;
  cost_confirmed_at?: string | null;
  created_at: string;
  updated_at: string;
};
type ProductChoice = {
  id: string;
  sku: string;
  name: string;
  version: number;
  kind: string;
  active: boolean;
};
type PolicyDraft = {
  enabled: boolean;
  minimum: string;
  target: string;
  supplier: string;
  supplierSku: string;
  currency: string;
  moq: string;
  multiple: string;
  costKnown: boolean;
  cost: string;
  validUntil: string;
  expectedDate: string;
  confirmCost: boolean;
};
const prefix = '/replenishment';
const currencies = ['PLN', 'EUR', 'USD', 'GBP', 'CZK'];
const maxProducts = 500;
const maxRequestBytes = 262144;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const blankDraft = (): PolicyDraft => ({
  enabled: true,
  minimum: '',
  target: '',
  supplier: '',
  supplierSku: '',
  currency: '',
  moq: '1',
  multiple: '1',
  costKnown: false,
  cost: '',
  validUntil: '',
  expectedDate: '',
  confirmCost: false,
});
function integer(raw: string, label: string, min: number, max: number) {
  if (!/^(0|[1-9]\d*)$/.test(raw.trim()))
    throw Error(`${label}: podaj całkowitą liczbę bez znaku i wykładnika.`);
  const n = BigInt(raw.trim());
  if (n < BigInt(min) || n > BigInt(max)) throw Error(`${label}: zakres ${min}–${max}.`);
  return Number(n);
}
export function parseReplenishmentCost(raw: string): number {
  const text = raw.trim();
  if (!/^(0|[1-9]\d*)(?:[.,]\d{1,2})?$/.test(text))
    throw Error(
      'Koszt netto wymaga nieujemnej kwoty z najwyżej dwoma miejscami, bez wykładnika i separatorów tysięcy.',
    );
  const [whole, fraction = ''] = text.replace(',', '.').split('.');
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (value > 1000000000n) throw Error('Koszt netto przekracza 10 000 000,00.');
  return Number(value);
}
function minorText(value: number | string | null | undefined, currency: string | null) {
  if (value === undefined) return 'Brak uprawnień do wartości';
  if (value === null) return 'Koszt nieznany';
  if (!/^(0|[1-9]\d*)$/.test(String(value))) return 'Nieprawidłowa kwota';
  const n = BigInt(value);
  return `${n / 100n},${String(n % 100n).padStart(2, '0')} ${currency}`;
}
function amountInput(n: number | null | undefined) {
  if (n === null || n === undefined) return '';
  const value = BigInt(n);
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}
function localDateTime(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const poState: Record<string, string> = {
  draft: 'Szkic — jeszcze niezatwierdzony',
  ordered: 'Zatwierdzony lokalnie',
  partial: 'Częściowo przyjęty',
  received: 'Przyjęty',
  closed: 'Zamknięty',
  cancelled: 'Anulowany',
};
const planState: Record<string, string> = {
  purchase: 'Do zakupu',
  unchanged: 'Bez nowego zakupu',
  invalid: 'Błąd',
  conflict: 'Konflikt',
};

type ForecastInput = { lookback_days: 7 | 14 | 30 | 60 | 90; coverage_days: number };
type DemandSnapshot = ForecastInput & {
  semantic: 'warehouse_shipment_gross_v1';
  demand_hash: string;
  from: string;
  to: string;
  shipped_quantity: string;
  restocked_return_quantity: string;
  shipment_movement_count: string;
  return_movement_count: string;
  coverage_target: string;
};
const forecastWindows = [7, 14, 30, 60, 90] as const;
const forecastNotice =
  'Prognoza obejmuje tylko wysyłki zapisane w tym systemie; brak danych nie potwierdza braku sprzedaży poza systemem.';

type Options = Flags & {
  append_available?: boolean;
  forecast_available?: boolean;
  forecast_lookback_days?: ForecastInput['lookback_days'][];
  forecast_max_coverage_days?: number;
  warehouses: { data: Warehouse[]; capped: boolean };
  suppliers: { data: Supplier[]; capped: boolean };
  currencies: string[];
  limits: {
    products: number;
    purchase_order_lines: number;
    rows_page: number;
    history_page: number;
    choices: number;
    contributors: number;
    request_bytes: number;
    preview_bytes: number;
    evidence_bytes: number;
    previews: number;
    executions: number;
    preview_ttl_seconds: number;
  };
};
type PolicyRow = Policy & { sku?: string; name?: string; product_version?: number };
type Selection = {
  id: string;
  sku: string;
  name: string;
  kind: string;
  active: boolean;
  product_version: number;
  policy_id: string | null;
  policy_version: number | null;
  policy: Policy | null;
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null; total?: number } };
type DraftTarget = {
  id: string;
  number: string;
  version: number;
  supplier_id: string;
  currency: string;
  warehouse_id: string;
  line_count: number;
  total_minor?: string;
  expected_date: string | null;
};
type DraftChoice = { data: DraftTarget[]; cursor: string | null; total: number };
type TargetLine = {
  product_id: string;
  sku: string;
  name: string;
  supplier_sku: string;
  quantity: number;
  received_quantity: number;
  closed_quantity: number;
  unit_cost?: number;
};
type Destination = {
  kind: 'existing_draft';
  purchase_order_id: string;
  number: string;
  version: number;
  snapshot: {
    head: {
      id: string;
      state: string;
      version: number;
      reference: string;
      note: string;
      expected_date: string | null;
    };
    lines: TargetLine[];
  };
  line_count_before: number;
  line_count_after: number;
  total_before_minor?: string;
  total_after_minor?: string;
};
const supplierCurrency = (supplier: string, currency: string) => `${supplier}:${currency}`;
function groupSummary(groups: Group[]) {
  const appended = groups.filter((g) => g.destination?.kind === 'existing_draft').length;
  return `${groups.length - appended} nowych szkiców PO${appended ? ` i dopisanie do ${appended} istniejących szkiców` : ''}`;
}
type Group = {
  destination?: Destination;
  index: number;
  supplier_id: string;
  supplier_name: string;
  supplier_version: number;
  currency: string;
  expected_date: string | null;
  product_ids: string[];
  line_count: number;
  total_minor?: string;
  purchase_order_id?: string;
  number?: string;
  version?: number;
};
type Head = {
  config?: {
    forecast?: ForecastInput;
    forecast_window?: { from: string; to: string };
    draft_targets?: {
      supplier_id: string;
      currency: string;
      purchase_order_id: string;
      version: number;
    }[];
  };
  id: string;
  actor_id: string;
  warehouse_id: string;
  total: number;
  purchase: number;
  unchanged: number;
  invalid: number;
  conflicts: number;
  ready: boolean;
  scope_hash: string;
  created_at: string;
  expires_at?: string;
  groups: Group[];
  warnings: string[];
};
type Execution = Head & {
  preview_id: string;
  state: 'done';
  before_source_version: string;
  after_source_version: string;
};
type Row = {
  id: string;
  index: number;
  product_id: string | null;
  sku: string | null;
  name: string | null;
  policy_snapshot: Policy | null;
  stock_snapshot: {
    presence: boolean;
    on_hand: number | null;
    reserved: number | null;
    available: number;
    version: string | null;
  };
  demand?: DemandSnapshot;
  days_cover?: { numerator: string; denominator: string } | null;
  effective_minimum_quantity?: string;
  effective_target_quantity?: string;
  contributor_count: number;
  available: string;
  incoming_draft_quantity: string;
  incoming_ordered_quantity: string;
  projected_available: string;
  deficit: string;
  recommended_quantity: string;
  rounding_surplus: string;
  unit_cost_minor?: number | null;
  currency: string | null;
  line_total_minor?: string | null;
  status: 'purchase' | 'unchanged' | 'invalid' | 'conflict';
  errors: string[];
  warnings: string[];
  group_index: number | null;
  preview_row_id?: string;
  purchase_order_id?: string | null;
};
type Contributor = {
  source_kind: 'purchase_order' | 'b2b_network_order';
  source_id: string;
  number: string;
  version: number;
  state: string;
  warehouse_id: string;
  supplier_id?: string | null;
  currency: string;
  expected_date: string | null;
  quantity: number;
  received_quantity: number;
  closed_quantity: number;
  remaining_quantity: string;
  unit_cost_minor?: number | null;
  supplier_sku?: string;
};
type Detail = {
  kind: 'preview' | 'execution';
  head: Head | Execution;
  rows: Row[];
  contributors: Record<string, Contributor[]>;
  complete: boolean;
  valueVisible: boolean;
};
type Attempt = {
  kind: 'create_policy' | 'patch_policy' | 'preview' | 'execute';
  method: 'POST' | 'PATCH';
  path: string;
  serialized: string;
  scope: string;
  label: string;
};

function policyDraft(p: Policy): PolicyDraft {
  return {
    enabled: p.enabled,
    minimum: String(p.minimum_quantity),
    target: String(p.target_quantity),
    supplier: p.supplier_id,
    supplierSku: p.supplier_sku,
    currency: p.currency,
    moq: String(p.minimum_order_quantity),
    multiple: String(p.order_multiple),
    costKnown: p.unit_cost_minor !== undefined && p.unit_cost_minor !== null,
    cost: amountInput(p.unit_cost_minor),
    validUntil: localDateTime(p.cost_valid_until),
    expectedDate: p.expected_date ?? '',
    confirmCost: false,
  };
}
function quant(value: string | number | null | undefined) {
  if (value === null) return 'Brak wiersza';
  if (value === undefined) return '—';
  return String(value);
}
function HeadCounts({ head }: { head: Head }) {
  return (
    <div className="rp-metrics">
      <span>
        Produkty <strong>{head.total}</strong>
      </span>
      <span>
        Do zakupu <strong>{head.purchase}</strong>
      </span>
      <span>
        Bez nowego zakupu <strong>{head.unchanged}</strong>
      </span>
      <span>
        Błędy <strong>{head.invalid}</strong>
      </span>
      <span>
        Konflikty <strong>{head.conflicts}</strong>
      </span>
      <span>
        Docelowe szkice PO <strong>{head.groups.length}</strong>
      </span>
    </div>
  );
}
function ExistingDraftDetail({
  group,
  rows,
  showValues,
  executed,
}: {
  group: Group;
  rows: Row[];
  showValues: boolean;
  executed: boolean;
}) {
  const d = group.destination!;
  const additions = rows.filter((r) => r.group_index === group.index && r.status === 'purchase');
  const before = d.snapshot.lines;
  const ids = [
    ...new Set([
      ...before.map((l) => l.product_id),
      ...additions.map((r) => r.product_id).filter((id): id is string => id !== null),
    ]),
  ];
  return (
    <div className="rp-append-detail">
      <h4>
        {executed ? 'Dopisano do' : 'Dopisanie do'} {d.number} · zachowana wersja przed zapisem{' '}
        {d.version}
        {executed && group.version ? ` → ${group.version}` : ''}
      </h4>
      <p>
        Pozycje: {d.line_count_before} → {d.line_count_after}.{' '}
        {showValues && d.total_before_minor !== undefined && d.total_after_minor !== undefined
          ? `Wartość netto: ${minorText(d.total_before_minor, group.currency)} → ${minorText(d.total_after_minor, group.currency)}.`
          : ''}
      </p>
      <dl className="rp-facts">
        <dt>Zachowany termin dostawy</dt>
        <dd>{d.snapshot.head.expected_date ?? 'Nie ustalono'}</dd>
        <dt>Zachowana referencja</dt>
        <dd>{d.snapshot.head.reference || 'Brak'}</dd>
        <dt>Zachowana notatka</dt>
        <dd>{d.snapshot.head.note || 'Brak'}</dd>
      </dl>
      <p>
        Pełny zamrożony szkic przed zapisem i przyrost każdej pozycji. Dane historyczne nie pokazują
        późniejszych zmian na karcie PO.
      </p>
      <div className="rp-table">
        <table>
          <thead>
            <tr>
              <th>Produkt</th>
              <th>Przed</th>
              <th>Dopisanie</th>
              <th>Po</th>
              <th>Kod dostawcy</th>
              {showValues && <th>Koszt jednostki netto</th>}
              <th>Wynik</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const old = before.find((l) => l.product_id === id),
                added = additions.find((r) => r.product_id === id);
              const addition = added?.recommended_quantity ?? '0';
              const after = (BigInt(old?.quantity ?? 0) + BigInt(addition)).toString();
              return (
                <tr key={id}>
                  <td>
                    {old?.sku ?? added?.sku} · {old?.name ?? added?.name}
                  </td>
                  <td>{old?.quantity ?? 0}</td>
                  <td>{addition}</td>
                  <td>{after}</td>
                  <td>{old?.supplier_sku ?? added?.policy_snapshot?.supplier_sku ?? 'Brak'}</td>
                  {showValues && (
                    <td>
                      {minorText(old ? old.unit_cost : added?.unit_cost_minor, group.currency)}
                    </td>
                  )}
                  <td>
                    {addition === '0'
                      ? 'Zachowano bez zmian'
                      : old
                        ? 'Zwiększono ilość; zachowano koszt i kod'
                        : 'Dodano pozycję'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function PlanDetail({
  detail,
  valueVisible,
  canOpenPurchase,
  onOpenPurchase,
}: {
  detail: Detail;
  valueVisible: boolean;
  canOpenPurchase: boolean;
  onOpenPurchase: (id: string) => void;
}) {
  const [filter, setFilter] = useState('all');
  const showValues = valueVisible && detail.valueVisible;
  return (
    <div>
      <HeadCounts head={detail.head} />
      <p>
        Utworzono {date(detail.head.created_at)}
        {detail.head.expires_at
          ? ` · nowy zapis podglądu ważny do ${date(detail.head.expires_at)}`
          : ''}
        .
      </p>
      {detail.head.config?.forecast && (
        <div className="rp-forecast-summary">
          <strong>
            Prognoza według zapisanych wysyłek · {detail.head.config.forecast.lookback_days} dni ·
            pokrycie {detail.head.config.forecast.coverage_days} dni
          </strong>
          <p>
            {forecastNotice} Uwzględnia także wydania DEMO i sandbox zapisane lokalnie; nie
            potwierdza operacji u przewoźnika.
          </p>
          <p>
            Pokazano zamrożony rachunek podglądu. Historia nie jest przeliczana z bieżącej
            sprzedaży.
          </p>
        </div>
      )}
      {!!detail.head.warnings.length && (
        <ul className="rp-hint">
          {detail.head.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <h4>
        {detail.kind === 'execution' ? 'Zapisane szkice zakupów' : 'Planowane szkice zakupów'}
      </h4>
      {!detail.head.groups.length && <p>Ten zakres nie wymaga nowego zamówienia zakupowego.</p>}
      {detail.head.groups.map((g) => (
        <div className="rp-row" key={g.index}>
          <strong>
            {g.supplier_name} · {g.currency} · {g.line_count} pozycji
          </strong>
          <p>
            Oczekiwana dostawa: {g.expected_date ?? 'nie ustalono'}
            {showValues && g.total_minor !== undefined
              ? ` · wartość netto ${minorText(g.total_minor, g.currency)}`
              : ''}
          </p>
          {g.destination?.kind === 'existing_draft' ? (
            detail.complete ? (
              <ExistingDraftDetail
                group={g}
                rows={detail.rows}
                showValues={showValues}
                executed={detail.kind === 'execution'}
              />
            ) : (
              <p>Odczytywanie pełnych pozycji i rachunku dopisania; zgoda pozostaje zablokowana.</p>
            )
          ) : (
            <p>Nowy szkic PO</p>
          )}
          {detail.kind === 'execution' &&
            g.purchase_order_id &&
            (canOpenPurchase ? (
              <button className="button" onClick={() => onOpenPurchase(g.purchase_order_id!)}>
                Otwórz zakup {g.number ?? g.purchase_order_id}
              </button>
            ) : (
              <p>Zakup {g.number ?? g.purchase_order_id}</p>
            ))}
        </div>
      ))}
      <div className="rp-heading">
        <h4>Rachunek każdego produktu</h4>
        <label>
          Pokazuj
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">Wszystkie · {detail.rows.length}</option>
            <option value="purchase">Do zakupu</option>
            <option value="errors">Błędy i konflikty</option>
            <option value="unchanged">Bez nowego zakupu</option>
          </select>
        </label>
      </div>
      {detail.rows
        .filter(
          (r) =>
            filter === 'all' ||
            (filter === 'errors'
              ? r.status === 'invalid' || r.status === 'conflict'
              : r.status === filter),
        )
        .map((r) => (
          <details className={'rp-row ' + (r.errors.length ? 'rp-invalid' : '')} key={r.id}>
            <summary>
              {r.sku ?? 'Produkt nie jest już dostępny'} · {r.name ?? '—'} · {planState[r.status]} ·{' '}
              {r.recommended_quantity} szt.
            </summary>
            {!!r.errors.length && (
              <ul className="rp-error">
                {r.errors.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            )}
            {!!r.warnings.length && (
              <ul className="rp-hint">
                {r.warnings.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            )}
            <dl className="rp-facts">
              <dt>Stan fizyczny / rezerwacje</dt>
              <dd>
                {quant(r.stock_snapshot.on_hand)} / {quant(r.stock_snapshot.reserved)}
                {!r.stock_snapshot.presence ? ' · brak wiersza zapasu; do rachunku użyto 0' : ''}
              </dd>
              <dt>Dostępne teraz</dt>
              <dd>{r.available} szt.</dd>
              <dt>Planowane w szkicach</dt>
              <dd>{r.incoming_draft_quantity} szt. — jeszcze niezatwierdzone</dd>
              <dt>Pozostałe zatwierdzone dostawy</dt>
              <dd>{r.incoming_ordered_quantity} szt.</dd>
              <dt>Dostępne wraz z planowanymi zakupami</dt>
              <dd>{r.projected_available} szt. — to nie jest bieżący zapas</dd>
              {r.demand && (
                <>
                  <dt>Źródło prognozy</dt>
                  <dd>
                    Fizyczne wydania zapisane dla wybranego magazynu, ze wszystkich kanałów, również
                    w procesach DEMO i sandbox.
                  </dd>
                  <dt>Zamrożony okres</dt>
                  <dd>
                    {new Date(r.demand.from).toLocaleString('pl-PL')} —{' '}
                    {new Date(r.demand.to).toLocaleString('pl-PL')} (koniec wyłączony) ·{' '}
                    {r.demand.lookback_days} dni
                  </dd>
                  <dt>Wysłane sztuki / wpisy wysyłek</dt>
                  <dd>
                    {r.demand.shipped_quantity} / {r.demand.shipment_movement_count}
                    {r.demand.shipment_movement_count === '0'
                      ? ' · brak zapisanych wysyłek w tym okresie'
                      : ''}
                  </dd>
                  <dt>Średnia dzienna — dokładny rachunek</dt>
                  <dd>
                    {r.demand.shipped_quantity} ÷ {r.demand.lookback_days} szt./dzień
                  </dd>
                  <dt>Dni pokrycia / cel ze sprzedaży</dt>
                  <dd>
                    {r.demand.coverage_days} dni / {r.demand.coverage_target} szt. — zaokrąglono w
                    górę
                  </dd>
                  <dt>Pokrycie zapasu z planowanymi zakupami</dt>
                  <dd>
                    {r.days_cover === null
                      ? 'Nie wyznaczamy przy zerowych zarejestrowanych wydaniach.'
                      : r.days_cover
                        ? `${r.days_cover.numerator} ÷ ${r.days_cover.denominator} dni — dokładny ułamek`
                        : 'Brak odczytanego rachunku.'}
                  </dd>
                  <dt>Zwroty przyjęte na stan / wpisy przyjęć</dt>
                  <dd>
                    {r.demand.restocked_return_quantity} / {r.demand.return_movement_count} ·
                    informacyjnie; nie odejmujemy od wysyłek. Przyjęte zwroty są już uwzględnione w
                    bieżącym zapasie.
                  </dd>
                  <dt>Minimum polityki — dolny próg celu</dt>
                  <dd>
                    {r.policy_snapshot?.minimum_quantity ?? 'Brak polityki'} szt. · ręczny cel
                    polityki nie jest używany w prognozie.
                  </dd>
                  <dt>Efektywne minimum / cel</dt>
                  <dd>
                    {quant(r.effective_minimum_quantity)} / {quant(r.effective_target_quantity)}{' '}
                    szt. · większa z wartości: minimum polityki i cel ze sprzedaży.
                  </dd>
                </>
              )}
              <dt>{r.demand ? 'Zapisane minimum / ręczny cel polityki' : 'Minimum / cel'}</dt>
              <dd>
                {r.policy_snapshot
                  ? `${r.policy_snapshot.minimum_quantity} / ${r.policy_snapshot.target_quantity}`
                  : 'Brak polityki'}
              </dd>
              <dt>Brak do celu / rekomendacja</dt>
              <dd>
                {r.deficit} / {r.recommended_quantity} szt.
              </dd>
              <dt>MOQ / wielokrotność</dt>
              <dd>
                {r.policy_snapshot
                  ? `${r.policy_snapshot.minimum_order_quantity} / ${r.policy_snapshot.order_multiple}`
                  : '—'}
              </dd>
              <dt>Nadwyżka po zaokrągleniu</dt>
              <dd>{r.rounding_surplus} szt.</dd>
              {showValues && (
                <>
                  <dt>Koszt jednostki netto</dt>
                  <dd>{minorText(r.unit_cost_minor, r.currency)}</dd>
                  <dt>Wartość netto nowego zakupu</dt>
                  <dd>{minorText(r.line_total_minor, r.currency)}</dd>
                  <dt>Potwierdzenie / ważność kosztu</dt>
                  <dd>
                    {r.policy_snapshot?.cost_confirmed_at
                      ? date(r.policy_snapshot.cost_confirmed_at)
                      : 'Nie potwierdzono'}{' '}
                    /{' '}
                    {r.policy_snapshot?.cost_valid_until
                      ? date(r.policy_snapshot.cost_valid_until)
                      : 'Brak'}
                  </dd>
                </>
              )}
              <dt>Wersja polityki / zapasu</dt>
              <dd>
                {r.policy_snapshot?.version ?? 'brak'} / {r.stock_snapshot.version ?? 'brak'}
              </dd>
            </dl>
            <h4>Źródłowe zakupy · {r.contributor_count}</h4>
            {r.contributor_count === 0 ? (
              <p>Brak wcześniejszych zakupów w tym zakresie.</p>
            ) : !detail.contributors[r.id] ? (
              <p>Nie odczytano pełnej listy źródeł.</p>
            ) : (
              <div className="rp-table">
                <table>
                  <thead>
                    <tr>
                      <th>Dokument / stan</th>
                      <th>Oczekiwana dostawa</th>
                      <th>Zamówiono</th>
                      <th>Przyjęto</th>
                      <th>Zamknięto</th>
                      <th>Pozostało</th>
                      {showValues && <th>Koszt netto</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.contributors[r.id].map((c, i) => (
                      <tr key={`${c.source_kind}:${c.source_id}:${i}`}>
                        <td>
                          {c.source_kind === 'purchase_order' && canOpenPurchase ? (
                            <button className="button" onClick={() => onOpenPurchase(c.source_id)}>
                              {c.number}
                            </button>
                          ) : (
                            <strong>
                              {c.number}
                              {c.source_kind === 'b2b_network_order'
                                ? ' · zakup między firmami'
                                : ''}
                            </strong>
                          )}
                          <small>
                            {poState[c.state] ?? c.state} · wersja {c.version}
                          </small>
                        </td>
                        <td>{c.expected_date ?? 'Nie ustalono'}</td>
                        <td>{c.quantity}</td>
                        <td>{c.received_quantity}</td>
                        <td>{c.closed_quantity}</td>
                        <td>{c.remaining_quantity}</td>
                        {showValues && <td>{minorText(c.unit_cost_minor, c.currency)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        ))}
      {!showValues && (
        <p className="rp-hint">
          Ten widok przedstawia ilości. Koszty i wartości zakupów są niedostępne dla bieżących
          uprawnień.
        </p>
      )}
      <details>
        <summary>Identyfikator dowodu i zakresu</summary>
        <p>{detail.head.id}</p>
        <p>{detail.head.scope_hash}</p>
      </details>
    </div>
  );
}

export function ReplenishmentPlans({
  contextKey,
  readOnly,
  onOpenPurchase,
  onError,
}: ReplenishmentPlansProps) {
  const [options, setOptions] = useState<Options | null>(null);
  const [flags, setFlags] = useState<Flags | null>(null);
  const [tab, setTab] = useState<'plan' | 'policies' | 'history' | 'automations'>('plan');
  const [automationLocked, setAutomationLocked] = useState(false);
  const [warehouse, setWarehouse] = useState('');
  const [search, setSearch] = useState('');
  const [forecastEnabled, setForecastEnabled] = useState(false);
  const [lookbackDays, setLookbackDays] = useState<ForecastInput['lookback_days']>(30);
  const [coverageDays, setCoverageDays] = useState('30');
  const [selection, setSelection] = useState<Selection[]>([]);
  const [selectionCursor, setSelectionCursor] = useState<string | null>(null);
  const [selectionTotal, setSelectionTotal] = useState<number | null>(null);
  const [selectionLoaded, setSelectionLoaded] = useState(false);
  const [selected, setSelected] = useState<Record<string, Selection>>({});
  const [draftChoices, setDraftChoices] = useState<Record<string, DraftChoice>>({});
  const [draftTargets, setDraftTargets] = useState<Record<string, DraftTarget>>({});
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [policyCursor, setPolicyCursor] = useState<string | null>(null);
  const [policiesLoaded, setPoliciesLoaded] = useState(false);
  const [editing, setEditing] = useState<PolicyRow | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [product, setProduct] = useState<ProductChoice | null>(null);
  const [draft, setDraft] = useState<PolicyDraft>(blankDraft);
  const [policyConflict, setPolicyConflict] = useState(false);
  const [currentPolicy, setCurrentPolicy] = useState<PolicyRow | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [planScope, setPlanScope] = useState('');
  const [consent, setConsent] = useState(false);
  const [history, setHistory] = useState<Execution[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyDetail, setHistoryDetail] = useState<Detail | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const epoch = useRef(0),
    requestId = useRef(0),
    inFlight = useRef(false);
  const pendingRef = useRef<Attempt | null>(null);
  const flagsRef = useRef<Flags | null>(null);
  const context = `${contextKey}:${readOnly}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const authority = useRef<string | null>(null);
  const scopeRevision = useRef(0);
  const scopeRef = useRef('');
  const scope = `${context}:${warehouse}:${scopeRevision.current}`;
  scopeRef.current = scope;
  const warehouseRef = useRef(warehouse);
  warehouseRef.current = warehouse;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const readable =
    authority.current === context && !!flags?.available && !!flags.can_read && !blocked;
  const manage = readable && !!flags?.can_manage && !readOnly && !flags.read_only;
  const canPreview = readable && !!flags?.can_preview && !readOnly && !flags.read_only;
  const canExecute = readable && !!flags?.can_execute && !readOnly && !flags.read_only;
  const locked = busy || !!pending;

  function invalidate() {
    ++scopeRevision.current;
    scopeRef.current = `${contextRef.current}:${warehouseRef.current}:${scopeRevision.current}`;
    setDetail(null);
    setPlanScope('');
    setConsent(false);
    setStatus('');
  }
  function clearDraftChoices() {
    setDraftChoices({});
    setDraftTargets({});
  }
  function clearPrivate() {
    clearDraftChoices();
    setForecastEnabled(false);
    setLookbackDays(30);
    setCoverageDays('30');
    setDraft(blankDraft());
    setProduct(null);
    setEditing(null);
    setEditorOpen(false);
    setPolicyConflict(false);
    setCurrentPolicy(null);
    setDetail(null);
    setHistoryDetail(null);
    setPolicies([]);
    setPolicyCursor(null);
    setPoliciesLoaded(false);
    setSelection([]);
    setSelectionCursor(null);
    setSelectionTotal(null);
    setSelectionLoaded(false);
    setSelected({});
    selectedRef.current = {};
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
    setConsent(false);
    setPlanScope('');
    pendingRef.current = null;
    setPending(null);
    ++scopeRevision.current;
  }
  function purge() {
    authority.current = null;
    flagsRef.current = null;
    setFlags(null);
    setOptions(null);
    setBlocked(true);
    clearPrivate();
  }
  function accept(next: Flags) {
    if (!next.can_read || !next.available) {
      if (!next.available) {
        clearPrivate();
        flagsRef.current = next;
        setFlags(next);
        return false;
      }
      purge();
      return false;
    }
    const old = flagsRef.current;
    if (
      old &&
      (old.current_role !== next.current_role || (old.can_read_value && !next.can_read_value))
    ) {
      clearPrivate();
      authority.current = contextRef.current;
      flagsRef.current = next;
      setFlags(next);
      setStatus(
        'Dostęp lub zakres wartości zmienił się. Odczytaj dane ponownie w bieżącym zakresie uprawnień.',
      );
      return false;
    }
    if (
      old &&
      ((old.can_manage && !next.can_manage) ||
        (old.can_execute && !next.can_execute) ||
        next.read_only)
    ) {
      setEditorOpen(false);
      setEditing(null);
      setDraft(blankDraft());
      setConsent(false);
      pendingRef.current = null;
      setPending(null);
    }
    authority.current = contextRef.current;
    flagsRef.current = next;
    setFlags(next);
    return true;
  }
  function failure(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    const message = err instanceof Error ? err.message : 'Nie udało się wykonać operacji.';
    setError(message);
    onError?.(message);
    if (err instanceof ApiError && [401, 403].includes(err.status)) purge();
    if (err instanceof ApiError && err.status === 423) {
      clearPrivate();
      const next = flagsRef.current
        ? {
            ...flagsRef.current,
            read_only: true,
            can_manage: false,
            can_preview: false,
            can_execute: false,
          }
        : null;
      flagsRef.current = next;
      setFlags(next);
    }
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    const c = contextRef.current;
    try {
      const data = await api<T>(prefix + path, method, body);
      if (e !== epoch.current || c !== contextRef.current)
        throw new DOMException('Kontekst został zmieniony.', 'AbortError');
      return data;
    } catch (err) {
      if (e !== epoch.current || c !== contextRef.current)
        throw new DOMException('Kontekst został zmieniony.', 'AbortError');
      throw err;
    }
  }
  function begin() {
    inFlight.current = true;
    setBusy(true);
    setError('');
    return { e: epoch.current, id: ++requestId.current };
  }
  function end(e: number, id: number) {
    if (e === epoch.current && id === requestId.current) {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function loadOptions(reset = false) {
    if (inFlight.current || (blocked && !reset)) return;
    const { e, id } = begin();
    try {
      const d = await request<Options>('/options', e);
      if (!d.available) {
        clearPrivate();
        setOptions(d);
        flagsRef.current = d;
        setFlags(d);
        authority.current = contextRef.current;
        return;
      }
      if (!accept(d)) return;
      setOptions(d);
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      if (e === epoch.current) setLoading(false);
      end(e, id);
    }
  }
  useEffect(() => {
    ++epoch.current;
    ++requestId.current;
    inFlight.current = false;
    authority.current = null;
    flagsRef.current = null;
    setOptions(null);
    setFlags(null);
    setBlocked(false);
    clearPrivate();
    setWarehouse('');
    warehouseRef.current = '';
    setSearch('');
    setTab('plan');
    setError('');
    setStatus('');
    setBusy(false);
    setLoading(true);
    void loadOptions(true);
    return () => {
      ++epoch.current;
      ++requestId.current;
      inFlight.current = false;
      authority.current = null;
      pendingRef.current = null;
    };
  }, [contextKey, readOnly]);

  function query(kind: 'selection' | 'policies', cursor?: string | null) {
    return (
      `/${kind}?` +
      new URLSearchParams({
        warehouse_id: warehouseRef.current,
        limit: '100',
        ...(kind === 'selection' ? { search } : {}),
        ...(cursor ? { cursor } : {}),
      })
    );
  }
  async function loadSelection(more = false) {
    if (!readable || !warehouse || inFlight.current || (more && !selectionCursor)) return;
    const { e, id } = begin(),
      capturedWarehouse = warehouse;
    try {
      const d = await request<Page<Selection>>(
        query('selection', more ? selectionCursor : null),
        e,
      );
      if (!accept(d) || capturedWarehouse !== warehouseRef.current) return;
      if (d.data.length > 100 || !Number.isInteger(d.meta.total))
        throw Error('Nieprawidłowy zakres strony produktów.');
      if (!more && !pendingRef.current) {
        clearDraftChoices();
        invalidate();
      }
      setSelection(d.data);
      setSelectionCursor(d.meta.cursor);
      setSelectionTotal(d.meta.total!);
      setSelectionLoaded(true);
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, id);
    }
  }
  async function loadDrafts(supplierId: string, currency: string, more = false) {
    if (
      !canPreview ||
      options?.append_available !== true ||
      !warehouse ||
      locked ||
      inFlight.current ||
      pendingRef.current
    )
      return;
    const key = supplierCurrency(supplierId, currency),
      prior = draftChoices[key];
    if (more && !prior?.cursor) return;
    const { e, id } = begin(),
      capturedScope = scopeRef.current;
    try {
      const d: Page<DraftTarget> = await request<Page<DraftTarget>>(
        '/drafts?' +
          new URLSearchParams({
            warehouse_id: warehouse,
            supplier_id: supplierId,
            currency,
            limit: '100',
            ...(more && prior?.cursor ? { cursor: prior.cursor } : {}),
          }),
        e,
      );
      if (!accept(d) || capturedScope !== scopeRef.current) return;
      if (
        !Number.isInteger(d.meta.total) ||
        d.meta.total! < 0 ||
        d.data.length > 100 ||
        (more && d.meta.total !== prior.total)
      )
        throw Error('Zmienił się zakres szkiców. Odczytaj go ponownie.');
      const data = more ? [...prior.data, ...d.data] : d.data;
      const ids = new Set<string>();
      for (const r of data) {
        if (
          ids.has(r.id) ||
          r.supplier_id !== supplierId ||
          r.currency !== currency ||
          r.warehouse_id !== warehouse ||
          !Number.isInteger(r.version) ||
          r.version < 1
        )
          throw Error('Nieprawidłowa albo powtórzona pozycja szkicu.');
        ids.add(r.id);
      }
      if (
        data.length > d.meta.total! ||
        (!d.meta.cursor && data.length !== d.meta.total) ||
        (d.meta.cursor && (!d.data.length || d.meta.cursor === prior?.cursor))
      )
        throw Error('Nie odczytano pełnego zakresu strony szkiców.');
      if (!more) {
        setDraftTargets((old) => {
          const next = { ...old };
          delete next[key];
          return next;
        });
        invalidate();
      }
      setDraftChoices((old) => ({
        ...old,
        [key]: { data, cursor: d.meta.cursor, total: d.meta.total! },
      }));
      setStatus(
        `Odczytano ${data.length} z ${d.meta.total} szkiców. Nie wybrano żadnego automatycznie.`,
      );
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, id);
    }
  }
  function toggle(r: Selection, checked: boolean) {
    if (
      !canPreview ||
      locked ||
      inFlight.current ||
      pendingRef.current ||
      !r.policy ||
      !r.policy_version
    )
      return;
    const next = { ...selectedRef.current };
    if (checked) {
      if (Object.keys(next).length >= (options?.limits.products ?? maxProducts)) {
        setError('Można wybrać najwyżej 500 produktów. Nie obcięto wyboru.');
        return;
      }
      next[r.id] = structuredClone(r);
    } else delete next[r.id];
    selectedRef.current = next;
    setSelected(next);
    clearDraftChoices();
    invalidate();
  }
  async function selectAllResults() {
    if (!canPreview || !warehouse || inFlight.current || pendingRef.current) return;
    const { e, id } = begin(),
      capturedScope = scopeRef.current;
    try {
      let cursor: string | null = null;
      const found: Selection[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>();
      let total: number | null = null;
      do {
        const d: Page<Selection> = await request<Page<Selection>>(query('selection', cursor), e);
        if (!accept(d) || capturedScope !== scopeRef.current) return;
        if (!Number.isInteger(d.meta.total) || d.data.length > 100)
          throw Error('Nieprawidłowy zakres produktów.');
        if (total === null) total = d.meta.total!;
        if (total !== d.meta.total || total > (options?.limits.products ?? maxProducts))
          throw Error(
            'Pełny wynik przekracza 500 produktów lub zmienił zakres. Zawęź wyszukiwanie; niczego nie zaznaczono.',
          );
        for (const r of d.data) {
          if (seen.has(r.id)) throw Error('Strony produktów zawierają powtórzenia.');
          seen.add(r.id);
          found.push(r);
        }
        if (found.length > maxProducts) throw Error('Wynik przekroczył 500 produktów.');
        cursor = d.meta.cursor;
        if (cursor) {
          if (!d.data.length || cursors.has(cursor) || cursors.size >= 5)
            throw Error('Nie udało się odczytać pełnego wyboru.');
          cursors.add(cursor);
        }
      } while (cursor);
      if (found.length !== total) throw Error('Nie odczytano wszystkich produktów.');
      if (found.some((r) => !r.policy || !r.policy_version))
        throw Error(
          'Wynik zawiera produkty bez polityki. Skonfiguruj je lub wybierz produkty pojedynczo; nie pominięto ich po cichu.',
        );
      const next = { ...selectedRef.current };
      for (const r of found) if (!next[r.id]) next[r.id] = structuredClone(r);
      if (Object.keys(next).length > maxProducts)
        throw Error('Łączny wybór przekracza 500 produktów. Nie zmieniono wyboru.');
      selectedRef.current = next;
      setSelected(next);
      clearDraftChoices();
      invalidate();
      setStatus(
        `Zaznaczono pełny wynik ${found.length} produktów. Zachowano wersje wcześniejszego wyboru.`,
      );
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, id);
    }
  }
  async function loadPolicies(more = false) {
    if (!readable || !warehouse || inFlight.current || (more && !policyCursor)) return;
    const { e, id } = begin(),
      wh = warehouse;
    try {
      const d = await request<Page<PolicyRow>>(query('policies', more ? policyCursor : null), e);
      if (!accept(d) || wh !== warehouseRef.current) return;
      if (d.data.length > 100) throw Error('Przekroczono limit strony polityk.');
      setPolicies(d.data);
      setPolicyCursor(d.meta.cursor);
      setPoliciesLoaded(true);
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, id);
    }
  }
  function editPolicy(p: PolicyRow | null) {
    if (!manage || locked || inFlight.current || pendingRef.current) return;
    setEditing(p);
    setDraft(p ? policyDraft(p) : blankDraft());
    setPolicyConflict(false);
    setCurrentPolicy(null);
    setProduct(null);
    setEditorOpen(true);
    setError('');
  }
  function changeDraft(p: Partial<PolicyDraft>) {
    if (!manage || locked || inFlight.current || pendingRef.current) return;
    setDraft((old) => ({ ...old, ...p }));
    setError('');
  }

  async function getDetail(
    kind: 'preview' | 'execution',
    targetId: string,
    e: number,
  ): Promise<Detail> {
    const base = kind === 'preview' ? `/previews/${targetId}` : `/executions/${targetId}`;
    const response = await request<Flags & { preview?: Head; execution?: Execution }>(base, e);
    if (!accept(response)) throw Error('Brak aktualnego dostępu do podglądu.');
    const head = kind === 'preview' ? response.preview : response.execution;
    if (
      !head ||
      head.id !== targetId ||
      !/^[a-f0-9]{64}$/.test(head.scope_hash) ||
      !Number.isInteger(head.total) ||
      head.total < 1 ||
      head.total > maxProducts
    )
      throw Error('Serwer nie potwierdził pełnego zakresu dowodu.');
    if (kind === 'execution' && (!('state' in head) || head.state !== 'done'))
      throw Error('Nie potwierdzono zakończonego wykonania.');
    const rows: Row[] = [],
      rowIds = new Set<string>(),
      indexes = new Set<number>(),
      cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Page<Row> = await request<Page<Row>>(
        base + '/rows?' + new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }),
        e,
      );
      if (!accept(page)) throw Error('Brak aktualnego dostępu do wierszy.');
      if (page.meta.total !== head.total || page.data.length > 100)
        throw Error('Strona nie odpowiada pełnemu zakresowi dowodu.');
      for (const r of page.data) {
        if (!r.id || rowIds.has(r.id) || !Number.isInteger(r.index) || indexes.has(r.index))
          throw Error('Powtórzony lub nieprawidłowy wiersz podglądu.');
        rowIds.add(r.id);
        indexes.add(r.index);
        rows.push(r);
      }
      if (rows.length > head.total)
        throw Error('Podgląd przekroczył zadeklarowaną liczbę produktów.');
      cursor = page.meta.cursor;
      if (cursor) {
        if (!page.data.length || cursors.has(cursor) || cursors.size >= 5)
          throw Error('Nie udało się odczytać wszystkich stron podglądu.');
        cursors.add(cursor);
      }
    } while (cursor);
    if (rows.length !== head.total)
      throw Error('Nie odczytano wszystkich produktów. Zgoda pozostaje zablokowana.');
    if (head.ready)
      for (const g of head.groups)
        if (g.destination) {
          const d = g.destination;
          const lines = d.snapshot?.lines;
          if (
            d.kind !== 'existing_draft' ||
            !Array.isArray(lines) ||
            lines.length !== d.line_count_before ||
            lines.length > 200 ||
            new Set(lines.map((l) => l.product_id)).size !== lines.length ||
            d.snapshot.head.id !== d.purchase_order_id ||
            d.snapshot.head.state !== 'draft' ||
            d.snapshot.head.version !== d.version ||
            !Number.isInteger(d.version) ||
            d.version < 1 ||
            !Number.isInteger(d.line_count_after) ||
            d.line_count_after < lines.length ||
            d.line_count_after > 200 ||
            lines.some(
              (l) =>
                !l.product_id ||
                !Number.isInteger(l.quantity) ||
                l.quantity < 1 ||
                !Number.isInteger(l.received_quantity) ||
                !Number.isInteger(l.closed_quantity),
            )
          )
            throw Error(
              'Nie odczytano pełnego zamrożonego szkicu docelowego. Zgoda pozostaje zablokowana.',
            );
        }
    if (head.config?.forecast && head.ready) {
      const f = head.config.forecast;
      const first = rows[0]?.demand;
      for (const r of rows) {
        const d = r.demand;
        if (
          !d ||
          d.semantic !== 'warehouse_shipment_gross_v1' ||
          !/^[a-f0-9]{64}$/.test(d.demand_hash) ||
          d.lookback_days !== f.lookback_days ||
          d.coverage_days !== f.coverage_days ||
          !Number.isFinite(Date.parse(d.from)) ||
          !Number.isFinite(Date.parse(d.to)) ||
          Date.parse(d.from) >= Date.parse(d.to) ||
          d.from !== first?.from ||
          d.to !== first?.to ||
          [
            d.shipped_quantity,
            d.restocked_return_quantity,
            d.shipment_movement_count,
            d.return_movement_count,
            d.coverage_target,
            r.effective_minimum_quantity,
            r.effective_target_quantity,
          ].some((v) => typeof v !== 'string' || !/^(0|[1-9]\d*)$/.test(v))
        )
          throw Error(
            'Nie odczytano kompletnego zamrożonego rachunku prognozy. Zgoda pozostaje zablokowana.',
          );
        if (
          d.shipped_quantity === '0'
            ? r.days_cover !== null
            : !r.days_cover ||
              !/^(0|[1-9]\d*)$/.test(r.days_cover.numerator) ||
              !/^[1-9]\d*$/.test(r.days_cover.denominator)
        )
          throw Error('Nie odczytano dokładnego pokrycia zapasu. Zgoda pozostaje zablokowana.');
      }
    }
    const maxContributors = options?.limits.contributors ?? 10000;
    let count = 0;
    for (const r of rows) {
      if (!Number.isInteger(r.contributor_count) || r.contributor_count < 0)
        throw Error('Brak pełnej liczby źródłowych zakupów.');
      count += r.contributor_count;
    }
    if (count > maxContributors)
      throw Error('Źródłowe zakupy przekroczyły limit 10 000 pozycji. Nie obcięto zakresu.');
    const contributors: Record<string, Contributor[]> = {};
    const previewId = kind === 'preview' ? head.id : (head as Execution).preview_id;
    for (const r of rows) {
      contributors[r.id] = [];
      if (!r.contributor_count) continue;
      const sourceRow = kind === 'preview' ? r.id : r.preview_row_id;
      if (!sourceRow) throw Error('Wynik nie zawiera powiązania z wierszem źródłowego podglądu.');
      const seen = new Set<string>();
      let next: string | null = null;
      do {
        const page: Page<Contributor> = await request<Page<Contributor>>(
          `/previews/${previewId}/rows/${sourceRow}/contributors?` +
            new URLSearchParams({ limit: '100', ...(next ? { cursor: next } : {}) }),
          e,
        );
        if (!accept(page)) throw Error('Brak aktualnego dostępu do źródeł zakupów.');
        if (page.data.length > 100 || page.meta.total !== r.contributor_count)
          throw Error('Strona źródeł nie odpowiada zamrożonemu zakresowi.');
        contributors[r.id].push(...page.data);
        if (contributors[r.id].length > r.contributor_count)
          throw Error('Przekroczono zakres źródłowych zakupów.');
        next = page.meta.cursor;
        if (next) {
          if (!page.data.length || seen.has(next) || seen.size >= Math.ceil(maxContributors / 100))
            throw Error('Nie odczytano wszystkich stron źródeł.');
          seen.add(next);
        }
      } while (next);
      if (contributors[r.id].length !== r.contributor_count)
        throw Error('Nie odczytano pełnego źródła rachunku. Zgoda pozostaje zablokowana.');
    }
    return {
      kind,
      head,
      rows,
      contributors,
      complete: true,
      valueVisible: flagsRef.current?.can_read_value === true,
    };
  }
  async function submit(a: Attempt) {
    const f = flagsRef.current;
    const permitted =
      a.kind === 'create_policy' || a.kind === 'patch_policy'
        ? f?.can_manage
        : a.kind === 'preview'
          ? f?.can_preview
          : f?.can_execute;
    if (
      !readable ||
      readOnly ||
      f?.read_only ||
      !permitted ||
      inFlight.current ||
      (pendingRef.current && pendingRef.current !== a)
    )
      return;
    const { e, id } = begin();
    pendingRef.current = a;
    setPending(a);
    setConsent(false);
    setStatus('');
    let acknowledged = false;
    try {
      const d = await request<
        Flags & { policy?: Policy; preview?: Head; execution?: Execution; reused: boolean }
      >(a.path, e, a.method, JSON.parse(a.serialized));
      if (!accept(d)) return;
      if (
        (a.kind === 'preview' && !d.preview) ||
        (a.kind === 'execute' && (!d.execution || d.execution.state !== 'done')) ||
        ((a.kind === 'create_policy' || a.kind === 'patch_policy') && !d.policy)
      )
        throw Error('Odpowiedź nie potwierdza oczekiwanego wyniku. Zachowano klucz próby.');
      const resultHead = d.preview ?? d.execution;
      if (
        (a.kind === 'preview' || a.kind === 'execute') &&
        (!resultHead?.id ||
          !/^[a-f0-9]{64}$/.test(resultHead.scope_hash) ||
          !Number.isInteger(resultHead.total) ||
          resultHead.total < 1 ||
          resultHead.total > maxProducts)
      )
        throw Error('Odpowiedź nie potwierdza pełnego zakresu. Zachowano klucz próby.');
      if (
        (a.kind === 'create_policy' || a.kind === 'patch_policy') &&
        (!d.policy?.id || !Number.isInteger(d.policy.version) || d.policy.version < 1)
      )
        throw Error('Odpowiedź nie potwierdza wersji polityki. Zachowano klucz próby.');
      if (a.kind === 'preview') {
        const requested = JSON.parse(a.serialized) as { forecast?: ForecastInput };
        if (
          requested.forecast &&
          (d.preview?.config?.forecast?.lookback_days !== requested.forecast.lookback_days ||
            d.preview?.config?.forecast?.coverage_days !== requested.forecast.coverage_days)
        )
          throw Error(
            'Odpowiedź nie potwierdza wybranego okna i pokrycia. Zachowano dokładną próbę.',
          );
      }
      if (a.kind === 'preview') {
        const requested = JSON.parse(a.serialized) as {
          draft_targets?: {
            supplier_id: string;
            currency: string;
            purchase_order_id: string;
            version: number;
          }[];
        };
        if (
          requested.draft_targets?.length &&
          JSON.stringify(
            d.preview?.config?.draft_targets
              ?.map((t) => [t.supplier_id, t.currency, t.purchase_order_id, t.version])
              .sort(),
          ) !==
            JSON.stringify(
              requested.draft_targets
                .map((t) => [t.supplier_id, t.currency, t.purchase_order_id, t.version])
                .sort(),
            )
        )
          throw Error(
            'Odpowiedź nie potwierdza wybranych szkiców i wersji. Zachowano dokładną próbę.',
          );
      }
      acknowledged = true;
      pendingRef.current = null;
      setPending(null);
      if (a.kind === 'create_policy' || a.kind === 'patch_policy') {
        const raw = d.policy!;
        const labels =
          editing?.product_id === raw.product_id
            ? editing
            : product?.id === raw.product_id
              ? { sku: product.sku, name: product.name, product_version: product.version }
              : policies.find((p) => p.product_id === raw.product_id);
        const p: PolicyRow = {
          ...raw,
          ...(labels
            ? { sku: labels.sku, name: labels.name, product_version: labels.product_version }
            : {}),
        };
        invalidate();
        setEditing(p);
        setDraft(policyDraft(p));
        setPolicyConflict(false);
        setPolicies((old) => [...old.filter((x) => x.id !== p.id), p]);
        clearDraftChoices();
        setEditorOpen(true);
        setStatus(
          d.reused
            ? 'Odnaleziono wcześniej utworzoną politykę. Pokazano jej bieżącą wersję.'
            : 'Polityka zapisana. Koszt jest lokalnym potwierdzeniem administratora.',
        );
        return;
      }
      if (a.scope !== scopeRef.current) return;
      const head = a.kind === 'preview' ? d.preview! : d.execution!;
      setDetail({
        kind: a.kind === 'preview' ? 'preview' : 'execution',
        head,
        rows: [],
        contributors: {},
        complete: false,
        valueVisible: d.can_read_value,
      });
      setPlanScope(a.scope);
      const result = await getDetail(a.kind === 'preview' ? 'preview' : 'execution', head.id, e);
      if (a.scope !== scopeRef.current) return;
      setDetail(result);
      setStatus(
        a.kind === 'preview'
          ? d.reused
            ? 'Odczytano pełny wcześniejszy podgląd tej samej próby.'
            : 'Odczytano wszystkie produkty i źródłowe zakupy. Nie utworzono ani nie zmieniono szkiców PO.'
          : head.groups.length === 0
            ? 'Zapisano wykonanie planu. Wybrane produkty nie wymagają nowego zakupu; nie utworzono szkiców PO.'
            : d.reused
              ? 'Odczytano wcześniejszy zapis planu. Nie powtórzono tworzenia ani dopisania do szkiców.'
              : `Zapisano lokalnie: ${groupSummary(head.groups)}. Zatwierdzenie i przyjęcie wykonaj na kartach zakupów.`,
      );
    } catch (err) {
      if (e !== epoch.current || (err instanceof DOMException && err.name === 'AbortError')) return;
      if (acknowledged) failure(err);
      else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        pendingRef.current = null;
        setPending(null);
        setConsent(false);
        if (a.kind === 'patch_policy' && err.status === 409) setPolicyConflict(true);
        if (a.kind === 'execute') {
          setDetail(null);
          setPlanScope('');
        }
        failure(err);
        if (![401, 403, 423].includes(err.status))
          setStatus(
            err.status === 409
              ? 'Zakres lub wersja zmieniły się. Odczytaj bieżące dane i utwórz nowy podgląd; nie podmieniono wersji szkicu.'
              : 'Nie potwierdzono zapisu. Szkic zachowano do poprawy.',
          );
      } else
        setError(
          'Niepewny wynik żądania. Zatrzymano nowe zapisy; zachowano dokładną treść i klucz w pamięci. Ponów tę samą próbę ręcznie lub odczytaj trwałą historię.',
        );
    } finally {
      end(e, id);
    }
  }
  function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!manage || locked || pendingRef.current || inFlight.current || !warehouse || policyConflict)
      return;
    try {
      if (
        !editing &&
        (!product || !product.active || !['simple', 'variant'].includes(product.kind))
      )
        throw Error('Wybierz własny aktywny produkt fizyczny.');
      const minimum = integer(draft.minimum, 'Minimum', 0, 2147483647),
        target = integer(draft.target, 'Cel', 0, 2147483647);
      if (target < minimum) throw Error('Cel nie może być mniejszy od minimum.');
      const supplier = options?.suppliers.data.find((s) => s.id === draft.supplier);
      if (!supplier || (draft.enabled && !supplier.active))
        throw Error('Włączona polityka wymaga aktywnego własnego dostawcy.');
      if (!currencies.includes(draft.currency)) throw Error('Wybierz jawną walutę kosztu netto.');
      const sku = draft.supplierSku.trim();
      if (
        sku.length > 80 ||
        sku.includes('\0') ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(sku)
      )
        throw Error('SKU dostawcy wymaga poprawnego tekstu do 80 znaków bez NUL.');
      const cost = draft.costKnown ? parseReplenishmentCost(draft.cost) : null;
      let until: string | null = null;
      if (cost !== null) {
        if (!draft.validUntil) throw Error('Znany koszt wymaga jawnego terminu ważności.');
        const time = new Date(draft.validUntil).getTime();
        if (!Number.isFinite(time)) throw Error('Niepoprawny termin ważności kosztu.');
        until =
          editing && draft.validUntil === localDateTime(editing.cost_valid_until)
            ? (editing.cost_valid_until ?? null)
            : new Date(time).toISOString();
        const changed =
          !editing ||
          cost !== editing.unit_cost_minor ||
          until !== editing.cost_valid_until ||
          draft.currency !== editing.currency;
        if (
          (changed || draft.confirmCost) &&
          (time <= Date.now() || time > Date.now() + 30 * 86400000)
        )
          throw Error('Potwierdzany koszt musi być ważny w przyszłości, najwyżej przez 30 dni.');
        if (changed && !draft.confirmCost)
          throw Error('Jawnie potwierdź nowy koszt i termin ważności.');
      }
      const definition: PolicyDefinition = {
        enabled: draft.enabled,
        minimum_quantity: minimum,
        target_quantity: target,
        supplier_id: draft.supplier,
        supplier_sku: sku,
        currency: draft.currency,
        minimum_order_quantity: integer(draft.moq, 'Minimalna ilość zamówienia', 1, 1000000),
        order_multiple: integer(draft.multiple, 'Wielokrotność', 1, 1000000),
        unit_cost_minor: cost,
        cost_valid_until: until,
        expected_date: draft.expectedDate || null,
        confirm_cost: cost !== null && draft.confirmCost,
      };
      const body = editing
        ? { version: editing.version, definition }
        : {
            client_key: crypto.randomUUID(),
            warehouse_id: warehouse,
            product_id: product!.id,
            definition,
          };
      const serialized = JSON.stringify(body);
      if (bytes(serialized) > (options?.limits.request_bytes ?? maxRequestBytes))
        throw Error('Żądanie przekroczyło limit. Nie obcięto szkicu.');
      void submit({
        kind: editing ? 'patch_policy' : 'create_policy',
        method: editing ? 'PATCH' : 'POST',
        path: '/policies' + (editing ? `/${editing.id}` : ''),
        serialized,
        scope: scopeRef.current,
        label: editing ? 'Zapis zmiany polityki' : 'Utworzenie polityki',
      });
    } catch (err) {
      failure(err);
    }
  }
  function makePreview() {
    if (!canPreview || locked || pendingRef.current || inFlight.current || !warehouse) return;
    const chosen = Object.values(selectedRef.current);
    try {
      if (!chosen.length || chosen.length > maxProducts)
        throw Error('Wybierz od 1 do 500 produktów.');
      if (
        chosen.some(
          (r) => !r.policy_version || !Number.isInteger(r.product_version) || r.product_version < 1,
        )
      )
        throw Error('Brak jawnych wersji produktów lub polityk. Odczytaj i wybierz je ponownie.');
      let forecast: ForecastInput | undefined;
      if (forecastEnabled) {
        if (
          options?.forecast_available !== true ||
          !options.forecast_lookback_days?.includes(lookbackDays)
        )
          throw Error(
            'Prognoza jest niedostępna dla bieżącej kopii. Odczytaj dostępność lub jawnie wybierz minimum i cel.',
          );
        if (options.forecast_max_coverage_days !== 365)
          throw Error('Serwer nie potwierdził zakresu dni pokrycia. Odczytaj dostępność ponownie.');
        forecast = {
          lookback_days: lookbackDays,
          coverage_days: integer(
            coverageDays,
            'Dni pokrycia',
            1,
            options.forecast_max_coverage_days,
          ),
        };
      }
      const targets = Object.values(draftTargets);
      if (targets.length && options?.append_available !== true)
        throw Error(
          'Dopisanie do szkicu jest niedostępne; zachowano wybór, ale nie wysłano podglądu.',
        );
      if (new Set(targets.map((t) => t.id)).size !== targets.length)
        throw Error('Ten sam szkic nie może być wskazany dla kilku grup.');
      for (const t of targets)
        if (
          !chosen.some(
            (r) =>
              r.policy?.enabled &&
              r.policy.supplier_id === t.supplier_id &&
              r.policy.currency === t.currency,
          ) ||
          t.warehouse_id !== warehouse
        )
          throw Error(
            'Szkic nie odpowiada bieżącemu wyborowi produktów i magazynu. Odczytaj go ponownie.',
          );
      const body = {
        client_key: crypto.randomUUID(),
        warehouse_id: warehouse,
        ...(forecast ? { forecast } : {}),
        ...(targets.length
          ? {
              draft_targets: targets
                .map((t) => ({
                  supplier_id: t.supplier_id,
                  currency: t.currency,
                  purchase_order_id: t.id,
                  version: t.version,
                }))
                .sort((a, b) =>
                  supplierCurrency(a.supplier_id, a.currency).localeCompare(
                    supplierCurrency(b.supplier_id, b.currency),
                  ),
                ),
            }
          : {}),
        items: chosen
          .map((r) => ({
            product_id: r.id,
            product_version: r.product_version,
            policy_version: r.policy_version!,
          }))
          .sort((a, b) => a.product_id.localeCompare(b.product_id)),
      };
      const serialized = JSON.stringify(body);
      if (bytes(serialized) > (options?.limits.request_bytes ?? maxRequestBytes))
        throw Error('Żądanie przekroczyło 256 KiB; zakres nie został obcięty.');
      setDetail(null);
      setConsent(false);
      void submit({
        kind: 'preview',
        method: 'POST',
        path: '/previews',
        serialized,
        scope: scopeRef.current,
        label: 'Utworzenie trwałego podglądu uzupełnienia',
      });
    } catch (err) {
      failure(err);
    }
  }
  function execute() {
    if (
      !canExecute ||
      locked ||
      pendingRef.current ||
      inFlight.current ||
      !consent ||
      !detail ||
      detail.kind !== 'preview' ||
      !detail.complete ||
      !detail.head.ready ||
      detail.head.invalid ||
      detail.head.conflicts ||
      planScope !== scopeRef.current ||
      detail.rows.length !== detail.head.total
    )
      return;
    void submit({
      kind: 'execute',
      method: 'POST',
      path: `/previews/${detail.head.id}/execute`,
      serialized: JSON.stringify({
        client_key: crypto.randomUUID(),
        scope_hash: detail.head.scope_hash,
        confirmed: true,
      }),
      scope: scopeRef.current,
      label: `Zapis: ${groupSummary(detail.head.groups)}`,
    });
  }
  async function reread() {
    if (!readable || !detail || inFlight.current) return;
    const { e, id } = begin(),
      capturedScope = scopeRef.current;
    setConsent(false);
    setDetail((old) => (old ? { ...old, complete: false } : null));
    try {
      const d = await getDetail(detail.kind, detail.head.id, e);
      if (capturedScope !== scopeRef.current) return;
      setDetail(d);
      setStatus('Odczytano cały trwały dowód i wszystkie źródła. Nie wykonano nowego zapisu.');
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, id);
    }
  }
  async function loadHistory(more = false) {
    if (!readable || inFlight.current || (more && !historyCursor)) return;
    const { e, id } = begin();
    try {
      const d = await request<Page<Execution>>(
        '/executions?' +
          new URLSearchParams({
            limit: '25',
            ...(warehouse ? { warehouse_id: warehouse } : {}),
            ...(more && historyCursor ? { cursor: historyCursor } : {}),
          }),
        e,
      );
      if (!accept(d)) return;
      if (d.data.length > 25) throw Error('Historia przekroczyła limit strony.');
      setHistory((old) =>
        more ? [...old, ...d.data.filter((r) => !old.some((x) => x.id === r.id))] : d.data,
      );
      setHistoryCursor(d.meta.cursor);
      setHistoryLoaded(true);
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, id);
    }
  }
  async function openHistory(h: Execution) {
    if (!readable || inFlight.current) return;
    const { e, id } = begin();
    setHistoryDetail(null);
    try {
      const d = await getDetail('execution', h.id, e);
      setHistoryDetail(d);
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, id);
    }
  }
  function openPurchase(id: string) {
    if (
      !readable ||
      !(flagsRef.current?.can_read_value || flagsRef.current?.can_manage) ||
      pendingRef.current ||
      inFlight.current
    ) {
      setError('Najpierw uzgodnij wynik bieżącej próby; zachowany klucz pozostaje w tym panelu.');
      return;
    }
    onOpenPurchase(id);
  }
  async function readCurrentPolicy() {
    if (!readable || !editing || inFlight.current) return;
    const { e, id } = begin();
    try {
      const d = await request<Flags & { policy: Policy }>(`/policies/${editing.id}`, e);
      if (!accept(d)) return;
      if (d.policy.id !== editing.id) throw Error('Odczytano inną politykę.');
      setCurrentPolicy({
        ...d.policy,
        sku: editing.sku,
        name: editing.name,
        product_version: editing.product_version,
      });
      setPolicyConflict(true);
      setStatus(
        'Odczytano bieżącą politykę. Szkicu i wersji zapisu nie podmieniono; porównaj je przed świadomym przyjęciem aktualnych danych.',
      );
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, id);
    }
  }
  function useCurrentPolicy() {
    if (!manage || !currentPolicy || inFlight.current) return;
    if (pendingRef.current && pendingRef.current.kind !== 'patch_policy') return;
    if (pendingRef.current?.kind === 'patch_policy') {
      const attempted = JSON.parse(pendingRef.current.serialized) as { version: number };
      if (currentPolicy.version <= attempted.version) {
        setError(
          'Bieżąca wersja nie rozstrzyga poprzedniej próby. Ponów ręcznie zachowane żądanie lub odczytaj politykę ponownie.',
        );
        return;
      }
    }
    pendingRef.current = null;
    setPending(null);
    invalidate();
    clearDraftChoices();
    setEditing(currentPolicy);
    setDraft(policyDraft(currentPolicy));
    setCurrentPolicy(null);
    setPolicyConflict(false);
    setStatus('Przyjęto odczytaną bieżącą wersję do formularza. Nie wykonano zapisu.');
  }
  const chosen = Object.values(selected);
  const destinationGroups = [
    ...new Map(
      chosen
        .filter((r) => r.policy?.enabled)
        .map((r) => {
          const p = r.policy!;
          return [
            supplierCurrency(p.supplier_id, p.currency),
            {
              key: supplierCurrency(p.supplier_id, p.currency),
              supplier: p.supplier_id,
              currency: p.currency,
              name:
                options?.suppliers.data.find((s) => s.id === p.supplier_id)?.name ?? p.supplier_id,
            },
          ] as const;
        }),
    ).values(),
  ];
  const reviewed =
    detail?.kind === 'preview' &&
    detail.complete &&
    planScope === scope &&
    detail.rows.length === detail.head.total;
  return (
    <section className="replenishment-plans" aria-label="Uzupełnianie zapasu">
      <div className="rp-header">
        <div>
          <h2>Uzupełnianie zapasu</h2>
          <p>Minimum i cel → pełny podgląd → szkice zakupów → przyjęcie na kartach PO.</p>
        </div>
        <button className="button" disabled={busy || blocked} onClick={() => void loadOptions()}>
          Odśwież dostęp i opcje
        </button>
      </div>
      {loading && <p role="status">Odczytywanie opcji planowania…</p>}
      {error && (
        <p className="rp-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="rp-status" role="status">
          {status}
        </p>
      )}
      {blocked && (
        <p className="rp-error">
          Bieżący dostęp został utracony. Szkice, koszty i dowody usunięto z panelu. Sprawdź sesję i
          otwórz go ponownie.
        </p>
      )}
      {options && !options.available && (
        <p className="rp-hint">
          Ta kopia aplikacji nie obsługuje planów uzupełnienia. Dotychczasowe zamówienia zakupowe
          pozostają osobnym procesem.
        </p>
      )}
      {pending && (
        <div className="rp-pending" role="status">
          <strong>
            {busy ? 'Trwa próba: ' : 'Niepewny wynik: '}
            {pending.label}
          </strong>
          <p>
            Dokładna treść i klucz są zachowane w pamięci tego panelu. Nowe zapisy i zmiany zakresu
            zostały zatrzymane. Nie opuszczaj panelu przed uzgodnieniem wyniku.
          </p>
          <div className="rp-actions">
            <button
              className="button primary"
              disabled={busy || !readable || readOnly || !!flags?.read_only}
              onClick={() => void submit(pending)}
            >
              Ponów dokładnie tę samą próbę
            </button>
            {pending.kind === 'patch_policy' ? (
              <button
                className="button"
                disabled={busy || !readable}
                onClick={() => void readCurrentPolicy()}
              >
                Odczytaj bieżącą politykę
              </button>
            ) : pending.kind === 'execute' ? (
              <button
                className="button"
                disabled={busy || !readable}
                onClick={() => {
                  setTab('history');
                  void loadHistory();
                }}
              >
                Odczytaj historię szkiców
              </button>
            ) : null}
          </div>
        </div>
      )}
      {readable && options && (
        <>
          <label>
            Magazyn planowania
            <select
              value={warehouse}
              disabled={locked || automationLocked}
              onChange={(e) => {
                if (inFlight.current || pendingRef.current || automationLocked) return;
                const next = e.target.value;
                clearDraftChoices();
                warehouseRef.current = next;
                setWarehouse(next);
                setSelected({});
                selectedRef.current = {};
                setSelection([]);
                setSelectionLoaded(false);
                setSelectionCursor(null);
                setSelectionTotal(null);
                setPolicies([]);
                setPoliciesLoaded(false);
                setPolicyCursor(null);
                setEditing(null);
                setEditorOpen(false);
                setCurrentPolicy(null);
                setHistory([]);
                setHistoryCursor(null);
                setHistoryLoaded(false);
                setHistoryDetail(null);
                invalidate();
              }}
            >
              <option value="">— Wybierz własny magazyn —</option>
              {options.warehouses.data.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.code})
                </option>
              ))}
            </select>
          </label>
          {options.warehouses.capped && (
            <p className="rp-hint">
              Lista magazynów jest ograniczona. Pozostałych nie wybrano automatycznie.
            </p>
          )}
          <nav className="rp-tabs" aria-label="Widoki uzupełniania">
            <button
              className={'button ' + (tab === 'plan' ? 'primary' : '')}
              onClick={() => setTab('plan')}
            >
              Wybór i plan
            </button>
            <button
              className={'button ' + (tab === 'policies' ? 'primary' : '')}
              onClick={() => setTab('policies')}
            >
              Polityki produktów
            </button>
            <button
              className={'button ' + (tab === 'history' ? 'primary' : '')}
              onClick={() => setTab('history')}
            >
              Historia szkiców
            </button>
            <button
              className={'button ' + (tab === 'automations' ? 'primary' : '')}
              onClick={() => setTab('automations')}
            >
              Automatyczne uzupełnianie
            </button>
          </nav>
          {(readOnly || flags?.read_only || (!manage && !canPreview)) && (
            <p className="rp-hint">
              Dostępny jest odczyt. Zapis polityk, podgląd zapisujący dowód i tworzenie szkiców
              wymagają bieżących uprawnień administratora oraz kopii umożliwiającej zapis.
            </p>
          )}
          <p className="rp-hint">
            Dostępne teraz = stan fizyczny − rezerwacje. Plan uwzględnia wszystkie pozostałe zakupy
            tego magazynu, również niezatwierdzone szkice, zamówienia ręczne i między firmami. Nie
            są one towarem już dostępnym. Nie wysyłamy zamówień do dostawcy.
          </p>

          <div hidden={tab !== 'automations'}>
            <ReplenishmentAutomations
              contextKey={`${contextKey}:${warehouse}`}
              warehouseId={warehouse}
              readOnly={readOnly}
              onOpenPurchase={openPurchase}
              onError={onError}
              onLockedChange={setAutomationLocked}
            />
          </div>
          {tab === 'plan' && (
            <>
              <fieldset className="rp-forecast-controls">
                <legend>Sposób planowania</legend>
                <div className="rp-grid">
                  <label>
                    Źródło zapotrzebowania
                    <select
                      value={forecastEnabled ? 'forecast' : 'policy'}
                      disabled={locked || !canPreview}
                      onChange={(e) => {
                        if (inFlight.current || pendingRef.current) return;
                        setForecastEnabled(e.target.value === 'forecast');
                        invalidate();
                      }}
                    >
                      <option value="policy">Minimum i cel polityki</option>
                      <option value="forecast" disabled={options.forecast_available !== true}>
                        Według zapisanych wysyłek
                      </option>
                    </select>
                  </label>
                  {forecastEnabled && (
                    <>
                      <label>
                        Okno sprzedaży
                        <select
                          value={lookbackDays}
                          disabled={locked || !canPreview || options.forecast_available !== true}
                          onChange={(e) => {
                            if (inFlight.current || pendingRef.current) return;
                            const n = Number(e.target.value);
                            if (!forecastWindows.includes(n as ForecastInput['lookback_days']))
                              return;
                            setLookbackDays(n as ForecastInput['lookback_days']);
                            invalidate();
                          }}
                        >
                          {(options.forecast_lookback_days ?? []).map((n) => (
                            <option value={n} key={n}>
                              {n} dni
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Dni pokrycia zapasu
                        <input
                          type="text"
                          inputMode="numeric"
                          value={coverageDays}
                          disabled={locked || !canPreview || options.forecast_available !== true}
                          onChange={(e) => {
                            if (inFlight.current || pendingRef.current) return;
                            setCoverageDays(e.target.value);
                            invalidate();
                          }}
                        />
                        <small>Od 1 do {options.forecast_max_coverage_days ?? 365} dni.</small>
                      </label>
                    </>
                  )}
                </div>
                {forecastEnabled ? (
                  <>
                    <p className="rp-hint">{forecastNotice}</p>
                    <p>
                      Wszystkie kanały wybranego magazynu, także lokalne wydania DEMO i sandbox. Cel
                      = większa z wartości: minimum polityki oraz wysłane sztuki × dni pokrycia ÷
                      dni okna, zaokrąglone w górę. Ręczny cel polityki nie jest używany. Zwroty
                      pokażemy osobno, bez odejmowania od wysyłek.
                    </p>
                    <p>
                      Okres i ilości zostaną zamrożone w pełnym podglądzie; ustawienia nie zmieniają
                      zapisanej polityki.
                    </p>
                  </>
                ) : (
                  <p>
                    Zakup uruchamia spadek poniżej minimum; ilość wyrównuje zapas z planowanymi
                    zakupami do ręcznego celu polityki.
                  </p>
                )}
                {options.forecast_available !== true && (
                  <p className="rp-hint">
                    Prognoza sprzedaży jest niedostępna w tej kopii. Planowanie według minimum i
                    celu pozostaje dostępne.
                  </p>
                )}
              </fieldset>
              <div className="rp-grid">
                <label>
                  Szukaj produktów
                  <input
                    value={search}
                    disabled={locked}
                    placeholder="SKU lub nazwa"
                    maxLength={200}
                    onChange={(e) => {
                      if (inFlight.current || pendingRef.current) return;
                      setSearch(e.target.value);
                      setSelection([]);
                      setSelectionLoaded(false);
                      setSelectionCursor(null);
                      setSelectionTotal(null);
                    }}
                  />
                </label>
              </div>
              <div className="rp-actions">
                <button
                  className="button"
                  disabled={!warehouse || busy}
                  onClick={() => void loadSelection()}
                >
                  Odczytaj produkty i polityki
                </button>
                <button
                  className="button"
                  disabled={!warehouse || !canPreview || locked}
                  onClick={() => void selectAllResults()}
                >
                  Zaznacz cały wynik · maks. 500
                </button>
                <button
                  className="button"
                  disabled={locked || !chosen.length}
                  onClick={() => {
                    selectedRef.current = {};
                    setSelected({});
                    clearDraftChoices();
                    invalidate();
                  }}
                >
                  Wyczyść wybór
                </button>
              </div>
              {selectionLoaded && (
                <p role="status">
                  Odczytano {selection.length} produktów z {selectionTotal}. Wybór jest jawny i może
                  obejmować różne strony.
                </p>
              )}
              {selectionLoaded && !selection.length && <p>Brak produktów dla tego wyszukiwania.</p>}
              {!!selection.length && (
                <div className="rp-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Wybór</th>
                        <th>Produkt</th>
                        <th>Minimum / cel</th>
                        <th>Polityka</th>
                        <th>Dostawca / waluta</th>
                        {flags?.can_read_value && <th>Koszt netto</th>}
                        <th>Operacje</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selection.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Wybierz ${r.sku}`}
                              checked={!!selected[r.id]}
                              disabled={
                                !canPreview ||
                                locked ||
                                !r.policy ||
                                (!selected[r.id] && chosen.length >= maxProducts)
                              }
                              onChange={(e) => toggle(r, e.target.checked)}
                            />
                          </td>
                          <td>
                            <strong>{r.sku}</strong>
                            <small>
                              {r.name} · wersja {r.product_version}
                              {!r.active ? ' · nieaktywny' : ''}
                            </small>
                            {selected[r.id] &&
                              (selected[r.id].product_version !== r.product_version ||
                                selected[r.id].policy_version !== r.policy_version) && (
                                <small>
                                  Wybór zachowuje wcześniejsze wersje. Usuń i zaznacz ponownie, aby
                                  świadomie przyjąć aktualne.
                                </small>
                              )}
                          </td>
                          <td>
                            {r.policy
                              ? `${r.policy.minimum_quantity} / ${r.policy.target_quantity}`
                              : 'Brak polityki'}
                          </td>
                          <td>
                            {r.policy
                              ? `${r.policy.enabled ? 'Włączona' : 'Wyłączona'} · wersja ${r.policy.version}`
                              : 'Wymaga konfiguracji'}
                          </td>
                          <td>
                            {r.policy
                              ? (options.suppliers.data.find((s) => s.id === r.policy!.supplier_id)
                                  ?.name ?? r.policy.supplier_id)
                              : '—'}
                            <small>{r.policy?.currency}</small>
                          </td>
                          {flags?.can_read_value && (
                            <td>
                              {r.policy
                                ? minorText(r.policy.unit_cost_minor, r.policy.currency)
                                : 'Nie ustalono'}
                            </td>
                          )}
                          <td>
                            <button
                              className="button"
                              disabled={!manage || locked}
                              onClick={() => {
                                setTab('policies');
                                editPolicy(
                                  r.policy
                                    ? {
                                        ...r.policy,
                                        sku: r.sku,
                                        name: r.name,
                                        product_version: r.product_version,
                                      }
                                    : null,
                                );
                                if (!r.policy)
                                  setProduct({
                                    id: r.id,
                                    sku: r.sku,
                                    name: r.name,
                                    version: r.product_version,
                                    kind: r.kind,
                                    active: r.active,
                                  });
                              }}
                            >
                              {r.policy ? 'Edytuj politykę' : 'Ustaw politykę'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {selectionCursor && (
                <button className="button" disabled={busy} onClick={() => void loadSelection(true)}>
                  Odczytaj następną stronę produktów
                </button>
              )}
              <h3>Wybrane produkty · {chosen.length}/500</h3>
              {!chosen.length ? (
                <p>Wybierz produkty z ustawioną polityką dla tego magazynu.</p>
              ) : (
                <details>
                  <summary>Pokaż cały jawny wybór i zachowane wersje</summary>
                  <div className="rp-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Produkt</th>
                          <th>Wersja produktu / polityki</th>
                          <th>Operacja</th>
                        </tr>
                      </thead>
                      <tbody>
                        {chosen.map((r) => (
                          <tr key={r.id}>
                            <td>
                              {r.sku} · {r.name}
                            </td>
                            <td>
                              {r.product_version} / {r.policy_version}
                            </td>
                            <td>
                              <button
                                className="button"
                                disabled={locked}
                                onClick={() => toggle(r, false)}
                              >
                                Usuń z wyboru
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
              {!!destinationGroups.length && options.append_available === true && (
                <fieldset>
                  <legend>Gdzie zapisać zakup</legend>
                  <p>
                    Domyślnie tworzymy nowe szkice. Dopisanie zwiększa ilości w jawnie wybranym
                    własnym szkicu; zachowuje istniejące koszty, termin, notatkę i referencję. Nie
                    zatwierdza ani nie wysyła zamówienia.
                  </p>
                  {destinationGroups.map((g) => {
                    const choices = draftChoices[g.key],
                      target = draftTargets[g.key];
                    return (
                      <div className="rp-destination" key={g.key}>
                        <h4>
                          {g.name} · {g.currency}
                        </h4>
                        <label>
                          Docelowy szkic · {g.name} · {g.currency}
                          <select
                            value={target?.id ?? ''}
                            disabled={locked || !canPreview}
                            onChange={(e) => {
                              if (inFlight.current || pendingRef.current) return;
                              const selected = choices?.data.find((d) => d.id === e.target.value);
                              if (e.target.value && !selected) return;
                              setDraftTargets((old) => {
                                const next = { ...old };
                                if (selected) next[g.key] = structuredClone(selected);
                                else delete next[g.key];
                                return next;
                              });
                              invalidate();
                            }}
                          >
                            <option value="">Nowy szkic</option>
                            {choices?.data.map((d) => (
                              <option value={d.id} key={d.id}>
                                {d.number} · wersja {d.version} · {d.line_count} pozycji
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="rp-actions">
                          <button
                            className="button"
                            disabled={locked || !canPreview}
                            onClick={() => void loadDrafts(g.supplier, g.currency)}
                          >
                            Odczytaj istniejące szkice
                          </button>
                          {choices?.cursor && (
                            <button
                              className="button"
                              disabled={locked || !canPreview}
                              onClick={() => void loadDrafts(g.supplier, g.currency, true)}
                            >
                              Odczytaj kolejną stronę szkiców
                            </button>
                          )}
                        </div>
                        {choices && (
                          <p role="status">
                            Odczytano {choices.data.length} z {choices.total} szkiców
                            {choices.cursor
                              ? '; pozostałe dostępne na kolejnych stronach.'
                              : ' — pełna lista.'}
                          </p>
                        )}
                        {target && (
                          <p className="rp-hint">
                            Wybrano {target.number}, wersję {target.version}. Pełne zachowane
                            pozycje i wynik dopisania pokaże trwały podgląd przed zgodą.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </fieldset>
              )}
              <button
                className="button primary"
                disabled={!canPreview || !warehouse || locked || !chosen.length}
                onClick={makePreview}
              >
                Utwórz pełny podgląd · {chosen.length}
              </button>
              {detail && (
                <section
                  className="rp-row"
                  aria-label={
                    detail.kind === 'preview' ? 'Podgląd uzupełnienia' : 'Wynik uzupełnienia'
                  }
                >
                  <h3>
                    {detail.kind === 'preview'
                      ? 'Podgląd uzupełnienia'
                      : 'Wynik — lokalne szkice PO'}
                  </h3>
                  <button
                    className="button"
                    disabled={!readable || busy}
                    onClick={() => void reread()}
                  >
                    Odczytaj cały dowód ponownie
                  </button>
                  {!detail.complete && (
                    <p className="rp-error">
                      Pełny dowód nie został jeszcze odczytany. Zgoda i wykonanie są zablokowane.
                    </p>
                  )}
                  <PlanDetail
                    detail={detail}
                    valueVisible={!!flags?.can_read_value}
                    canOpenPurchase={!!flags?.can_read_value || !!flags?.can_manage}
                    onOpenPurchase={openPurchase}
                  />
                  {detail.kind === 'preview' && (
                    <>
                      <p className="rp-hint">
                        Nowe PO będą szkicami; wskazane istniejące szkice otrzymają tylko
                        zatwierdzone dopisanie. Stan, rezerwacje, produkty i koszt istniejących
                        partii pozostają bez zmian. Każdy szkic wymaga osobnego zatwierdzenia zakupu
                        i fizycznego przyjęcia PZ.
                      </p>
                      {!detail.head.ready && (
                        <p className="rp-error">
                          Błąd lub konflikt dowolnego produktu blokuje cały plan. Popraw politykę
                          lub źródłowy zakup i utwórz nowy podgląd.
                        </p>
                      )}
                      <label className="rp-check">
                        <input
                          type="checkbox"
                          checked={consent}
                          disabled={
                            !canExecute ||
                            locked ||
                            !reviewed ||
                            !detail.head.ready ||
                            !!detail.head.invalid ||
                            !!detail.head.conflicts
                          }
                          onChange={(e) => setConsent(e.target.checked)}
                        />
                        <span>
                          Sprawdzono pełny zakres {detail.head.total} produktów i wszystkie źródłowe
                          zakupy oraz pełne zachowane pozycje docelowych szkiców. Zatwierdzam:{' '}
                          {groupSummary(detail.head.groups)} z podanymi ilościami, kosztami i
                          walutami
                          {!detail.head.groups.length
                            ? ' — ten plan zapisze dowód bez nowego PO'
                            : ''}
                          .
                        </span>
                      </label>
                      <button
                        className="button primary"
                        disabled={
                          !canExecute ||
                          locked ||
                          !reviewed ||
                          !detail.head.ready ||
                          !consent ||
                          !!detail.head.invalid ||
                          !!detail.head.conflicts
                        }
                        onClick={execute}
                      >
                        Zapisz plan lokalnie · {groupSummary(detail.head.groups)}
                      </button>
                    </>
                  )}
                </section>
              )}
            </>
          )}

          {tab === 'policies' && (
            <>
              <div className="rp-actions">
                <button
                  className="button"
                  disabled={!warehouse || busy}
                  onClick={() => void loadPolicies()}
                >
                  Odczytaj polityki magazynu
                </button>
                <button
                  className="button primary"
                  disabled={!warehouse || !manage || locked}
                  onClick={() => editPolicy(null)}
                >
                  Nowa polityka produktu
                </button>
              </div>
              {policiesLoaded && (
                <p role="status">Odczyt zakończony: {policies.length} polityk na tej stronie.</p>
              )}
              {policiesLoaded && !policies.length && (
                <p>Brak polityk tego magazynu. Ustaw minimum, cel i warunki zakupu produktu.</p>
              )}
              {!!policies.length && (
                <div className="rp-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Produkt</th>
                        <th>Minimum / cel</th>
                        <th>MOQ / wielokrotność</th>
                        <th>Dostawca / waluta</th>
                        <th>Stan polityki</th>
                        {flags?.can_read_value && <th>Koszt netto i ważność</th>}
                        <th>Operacja</th>
                      </tr>
                    </thead>
                    <tbody>
                      {policies.map((p) => (
                        <tr key={p.id}>
                          <td>
                            {p.sku ?? p.product_id}
                            <small>
                              {p.name ?? 'Etykietę produktu odczytaj ponownie z listy polityk'}
                            </small>
                          </td>
                          <td>
                            {p.minimum_quantity} / {p.target_quantity}
                          </td>
                          <td>
                            {p.minimum_order_quantity} / {p.order_multiple}
                          </td>
                          <td>
                            {options.suppliers.data.find((s) => s.id === p.supplier_id)?.name ??
                              p.supplier_id}
                            <small>{p.currency}</small>
                          </td>
                          <td>
                            {p.enabled ? 'Włączona' : 'Wyłączona'}
                            <small>Wersja {p.version}</small>
                          </td>
                          {flags?.can_read_value && (
                            <td>
                              {minorText(p.unit_cost_minor, p.currency)}
                              <small>
                                {p.cost_valid_until
                                  ? date(p.cost_valid_until)
                                  : 'Bez potwierdzonego kosztu'}
                              </small>
                            </td>
                          )}
                          <td>
                            <button
                              className="button"
                              disabled={!manage || locked}
                              onClick={() => editPolicy(p)}
                            >
                              Edytuj politykę
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {policyCursor && (
                <button className="button" disabled={busy} onClick={() => void loadPolicies(true)}>
                  Odczytaj następną stronę polityk
                </button>
              )}
              {editorOpen && manage && (
                <form onSubmit={savePolicy}>
                  <fieldset disabled={locked || policyConflict}>
                    <legend>
                      {editing
                        ? `Polityka ${editing.sku ?? editing.product_id} · wersja ${editing.version}`
                        : 'Nowa polityka'}
                    </legend>
                    {!editing && (
                      <ProductPicker
                        label="Produkt fizyczny do uzupełniania"
                        value={product?.id ?? ''}
                        initial={product ?? undefined}
                        filter={(p) => p.active && ['simple', 'variant'].includes(p.kind)}
                        select={(p) => {
                          if (!inFlight.current && !pendingRef.current) setProduct(p ?? null);
                        }}
                      />
                    )}
                    <div className="rp-grid">
                      <label>
                        Minimalny poziom
                        <input
                          required
                          inputMode="numeric"
                          value={draft.minimum}
                          onChange={(e) => changeDraft({ minimum: e.target.value })}
                        />
                      </label>
                      <label>
                        Docelowy poziom
                        <input
                          required
                          inputMode="numeric"
                          value={draft.target}
                          onChange={(e) => changeDraft({ target: e.target.value })}
                        />
                      </label>
                      <label>
                        Dostawca
                        <select
                          required
                          value={draft.supplier}
                          onChange={(e) => changeDraft({ supplier: e.target.value })}
                        >
                          <option value="">— Wybierz dostawcę —</option>
                          {options.suppliers.data.map((s) => (
                            <option key={s.id} value={s.id} disabled={draft.enabled && !s.active}>
                              {s.name} ({s.code}){!s.active ? ' · nieaktywny' : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        SKU dostawcy
                        <input
                          value={draft.supplierSku}
                          maxLength={80}
                          onChange={(e) => changeDraft({ supplierSku: e.target.value })}
                        />
                      </label>
                      <label>
                        Waluta kosztu
                        <select
                          required
                          value={draft.currency}
                          onChange={(e) =>
                            changeDraft({ currency: e.target.value, confirmCost: false })
                          }
                        >
                          <option value="">— Wybierz walutę —</option>
                          {options.currencies.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Minimalna ilość zamówienia (MOQ)
                        <input
                          required
                          inputMode="numeric"
                          value={draft.moq}
                          onChange={(e) => changeDraft({ moq: e.target.value })}
                        />
                      </label>
                      <label>
                        Wielokrotność zamówienia
                        <input
                          required
                          inputMode="numeric"
                          value={draft.multiple}
                          onChange={(e) => changeDraft({ multiple: e.target.value })}
                        />
                      </label>
                      <label>
                        Oczekiwana dostawa (opcjonalna)
                        <input
                          type="date"
                          value={draft.expectedDate}
                          onChange={(e) => changeDraft({ expectedDate: e.target.value })}
                        />
                      </label>
                    </div>
                    {options.suppliers.capped && (
                      <p className="rp-hint">
                        Lista dostawców jest ograniczona. Brakującego dostawcy nie wybrano ani nie
                        zastąpiono automatycznie.
                      </p>
                    )}
                    <label className="rp-check">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) => changeDraft({ enabled: e.target.checked })}
                      />
                      Polityka włączona
                    </label>
                    <p className="rp-hint">
                      Zakup powstaje dopiero poniżej minimum. Równość nie uruchamia zakupu; minimum
                      0 nie wywoła niedoboru. MOQ i wielokrotność mogą zwiększyć zakup ponad cel —
                      pełny podgląd pokaże tę nadwyżkę.
                    </p>
                    {flags?.can_read_value && (
                      <>
                        <label className="rp-check">
                          <input
                            type="checkbox"
                            checked={draft.costKnown}
                            onChange={(e) =>
                              changeDraft({ costKnown: e.target.checked, confirmCost: false })
                            }
                          />
                          Znam i podaję koszt netto
                        </label>
                        <div className="rp-grid">
                          <label>
                            Koszt jednostki netto ({draft.currency || 'wybierz walutę'})
                            <input
                              inputMode="decimal"
                              disabled={!draft.costKnown}
                              required={draft.costKnown}
                              value={draft.cost}
                              onChange={(e) =>
                                changeDraft({ cost: e.target.value, confirmCost: false })
                              }
                              placeholder="Brak kosztu nie oznacza 0"
                            />
                          </label>
                          <label>
                            Koszt ważny do (czas lokalny)
                            <input
                              type="datetime-local"
                              disabled={!draft.costKnown}
                              required={draft.costKnown}
                              value={draft.validUntil}
                              onChange={(e) =>
                                changeDraft({ validUntil: e.target.value, confirmCost: false })
                              }
                            />
                          </label>
                        </div>
                        <label className="rp-check">
                          <input
                            type="checkbox"
                            disabled={!draft.costKnown}
                            checked={draft.confirmCost}
                            onChange={(e) => changeDraft({ confirmCost: e.target.checked })}
                          />
                          Potwierdzam podany koszt netto i jego ważność — maksymalnie 30 dni
                        </label>
                        <p className="rp-hint">
                          To lokalne oświadczenie administratora, nie odczyt ceny z konta dostawcy.
                          Koszt 0 jest jawną wartością; koszt nieznany blokuje tylko produkt
                          wymagający nowego zakupu. Nie przeliczamy walut.
                        </p>
                      </>
                    )}
                  </fieldset>
                  {policyConflict && (
                    <p className="rp-error">
                      Wersja polityki wymaga uzgodnienia. Szkic zachowano; nie podmieniono jego
                      wersji automatycznie.
                    </p>
                  )}
                  {currentPolicy && (
                    <div className="rp-row">
                      <h4>Bieżąca odczytana polityka · wersja {currentPolicy.version}</h4>
                      <dl className="rp-facts">
                        <dt>Minimum / cel</dt>
                        <dd>
                          {currentPolicy.minimum_quantity} / {currentPolicy.target_quantity}
                        </dd>
                        <dt>Dostawca / waluta</dt>
                        <dd>
                          {options.suppliers.data.find((s) => s.id === currentPolicy.supplier_id)
                            ?.name ?? currentPolicy.supplier_id}{' '}
                          / {currentPolicy.currency}
                        </dd>
                        <dt>MOQ / wielokrotność</dt>
                        <dd>
                          {currentPolicy.minimum_order_quantity} / {currentPolicy.order_multiple}
                        </dd>
                        {flags?.can_read_value && (
                          <>
                            <dt>Koszt / ważność</dt>
                            <dd>
                              {minorText(currentPolicy.unit_cost_minor, currentPolicy.currency)} /{' '}
                              {currentPolicy.cost_valid_until
                                ? date(currentPolicy.cost_valid_until)
                                : 'brak'}
                            </dd>
                          </>
                        )}
                      </dl>
                      <button
                        type="button"
                        className="button"
                        disabled={busy || (!!pending && pending.kind !== 'patch_policy') || !manage}
                        onClick={useCurrentPolicy}
                      >
                        Świadomie przyjmij bieżącą wersję do formularza
                      </button>
                    </div>
                  )}
                  <div className="rp-actions">
                    <button
                      className="button primary"
                      disabled={locked || policyConflict || !manage || !flags?.can_read_value}
                      type="submit"
                    >
                      {editing ? 'Zapisz zmianę polityki' : 'Utwórz politykę'}
                    </button>
                    {editing && (
                      <button
                        type="button"
                        className="button"
                        disabled={busy || !readable}
                        onClick={() => void readCurrentPolicy()}
                      >
                        Odczytaj bieżącą politykę bez zmiany szkicu
                      </button>
                    )}
                    <button
                      type="button"
                      className="button"
                      disabled={locked}
                      onClick={() => {
                        setEditorOpen(false);
                        setEditing(null);
                        setCurrentPolicy(null);
                        setDraft(blankDraft());
                      }}
                    >
                      Zamknij formularz
                    </button>
                  </div>
                </form>
              )}
            </>
          )}

          {tab === 'history' && (
            <>
              <h3>Trwałe wykonania i powiązane zakupy</h3>
              <p>
                Dowód zachowuje zatwierdzone ilości i koszty. Bieżący stan PO oraz częściowe PZ
                sprawdzisz na karcie zakupu; późniejsza edycja szkicu nie zmienia dawnego dowodu.
              </p>
              <button
                className="button"
                disabled={!readable || busy}
                onClick={() => void loadHistory()}
              >
                Odczytaj historię{warehouse ? ' magazynu' : ' wszystkich magazynów'}
              </button>
              {historyLoaded && !history.length && (
                <p role="status">Odczyt zakończony. Brak wykonań planu w tym zakresie.</p>
              )}
              <div className="rp-history">
                {history.map((h) => (
                  <button
                    className="button"
                    key={h.id}
                    disabled={busy}
                    onClick={() => void openHistory(h)}
                  >
                    {date(h.created_at)} · {h.total} produktów · {h.purchase} do zakupu ·{' '}
                    {groupSummary(h.groups)} ·{' '}
                    {h.config?.forecast
                      ? `Prognoza ${h.config.forecast.lookback_days} dni / pokrycie ${h.config.forecast.coverage_days} dni`
                      : 'Minimum i cel'}
                  </button>
                ))}
              </div>
              {historyCursor && (
                <button className="button" disabled={busy} onClick={() => void loadHistory(true)}>
                  Odczytaj starsze wykonania
                </button>
              )}
              {historyDetail && (
                <section className="rp-row">
                  <h3>Historyczny wynik</h3>
                  <PlanDetail
                    detail={historyDetail}
                    valueVisible={!!flags?.can_read_value}
                    canOpenPurchase={!!flags?.can_read_value || !!flags?.can_manage}
                    onOpenPurchase={openPurchase}
                  />
                </section>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
