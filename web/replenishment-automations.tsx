import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, date } from './api';
import './replenishment-automations.css';
export type ReplenishmentAutomationsProps = {
  contextKey: string;
  readOnly: boolean;
  warehouseId?: string;
  onOpenPurchase: (id: string) => void;
  onOpenPlan?: (kind: 'preview' | 'execution', id: string) => void;
  onError?: (message: string) => void;
  onLockedChange?: (locked: boolean) => void;
};
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_manage: boolean;
  can_read_value: boolean;
};
type Forecast = { lookback_days: 7 | 14 | 30 | 60 | 90; coverage_days: number };
type Definition = {
  warehouse_id: string;
  product_ids: string[];
  enabled: boolean;
  destination: 'new_drafts' | 'append_matching_draft';
  forecast?: Forecast;
};
type Rule = {
  id: string;
  name: string;
  version: number;
  definition: Definition;
  actor_id: string;
  policy_items: {
    product_id: string;
    policy_id: string;
    policy_version: number;
    product_version: number;
  }[];
  created_at: string;
  updated_at: string;
};
type Run = {
  id: string;
  rule_id: string;
  rule_version: number;
  version: number;
  can_cancel: boolean;
  state: 'queued' | 'done' | 'nop' | 'skipped' | 'error' | 'cancelled';
  name: string;
  definition: Definition;
  crossings: {
    product_id: string;
    before_available: number;
    after_available: number;
    minimum_quantity: number;
  }[];
  result: {
    preview_id?: string;
    execution_id?: string;
    purchase_order_ids?: string[];
    reason?: string;
  };
  created_at: string;
  finished_at?: string | null;
};
type Options = Flags & {
  warehouses: { data: { id: string; name: string; code: string }[]; capped: boolean };
  forecast_available: boolean;
  append_available: boolean;
  limits: {
    rules: number;
    products: number;
    pending: number;
    runs: number;
    rows_page: number;
    request_bytes: number;
  };
};
type Product = {
  id: string;
  sku: string;
  name: string;
  kind: string;
  active: boolean;
  product_version: number;
  policy_version: number | null;
  policy: {
    id: string;
    enabled: boolean;
    minimum_quantity: number;
    target_quantity: number;
    supplier_id: string;
    currency: string;
  } | null;
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null; total?: number } };
type Draft = {
  id?: string;
  version?: number;
  name: string;
  warehouse: string;
  enabled: boolean;
  destination: Definition['destination'];
  forecast: boolean;
  lookback: Forecast['lookback_days'];
  coverage: string;
  products: Record<string, Product | null>;
};
type Attempt = {
  kind: 'create' | 'patch' | 'cancel';
  path: string;
  serialized: string;
  method: 'POST' | 'PATCH';
};
type PlanLine = {
  product_id: string;
  sku: string;
  name: string;
  quantity: number;
  supplier_sku: string;
  unit_cost?: number;
};
type PlanGroup = {
  index: number;
  supplier_name: string;
  currency: string;
  line_count: number;
  total_minor?: string;
  purchase_order_id?: string;
  number?: string;
  version?: number;
  destination?: {
    kind: 'existing_draft';
    number: string;
    version: number;
    line_count_before: number;
    line_count_after: number;
    total_before_minor?: string;
    total_after_minor?: string;
    snapshot: {
      head: { reference: string; note: string; expected_date: string | null };
      lines: PlanLine[];
    };
  };
};
type PlanHead = {
  id: string;
  total: number;
  ready: boolean;
  scope_hash: string;
  purchase: number;
  unchanged: number;
  invalid: number;
  conflicts: number;
  groups: PlanGroup[];
  warnings: string[];
  created_at: string;
  config?: { forecast?: Forecast };
};
type PlanRow = {
  id: string;
  index: number;
  product_id: string | null;
  sku: string | null;
  name: string | null;
  status: string;
  recommended_quantity: string;
  available: string;
  incoming_draft_quantity: string;
  incoming_ordered_quantity: string;
  projected_available: string;
  group_index: number | null;
  errors: string[];
  warnings: string[];
  currency: string | null;
  unit_cost_minor?: number | null;
  line_total_minor?: string | null;
  demand?: {
    semantic: string;
    from: string;
    to: string;
    shipped_quantity: string;
    restocked_return_quantity: string;
    coverage_target: string;
  };
};
type Evidence = {
  kind: 'preview' | 'execution';
  head: PlanHead;
  rows: PlanRow[];
  valueVisible: boolean;
};
const prefix = '/replenishment/automations';
const windows = [7, 14, 30, 60, 90] as const;
const states: Record<Run['state'], string> = {
  queued: 'W kolejce',
  done: 'Zapisano szkice',
  nop: 'Bez nowego zakupu',
  skipped: 'Pominięto',
  error: 'Błąd',
  cancelled: 'Anulowano',
};
const blank = (): Draft => ({
  name: '',
  warehouse: '',
  enabled: false,
  destination: 'new_drafts',
  forecast: false,
  lookback: 30,
  coverage: '30',
  products: {},
});
function money(value: number | string | null | undefined, currency: string) {
  if (value === null) return 'Koszt nieznany';
  if (value === undefined) return 'Brak odczytu wartości';
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')} ${currency}`;
}
function EvidenceView({ evidence, canValue }: { evidence: Evidence; canValue: boolean }) {
  const show = canValue && evidence.valueVisible;
  return (
    <section className="ra-card" aria-label="Zamrożony dowód planu">
      <h4>
        {evidence.kind === 'execution' ? 'Zamrożone wykonanie' : 'Zamrożony podgląd'} ·{' '}
        {evidence.head.total} produktów
      </h4>
      <p>
        Do zakupu {evidence.head.purchase} · bez zakupu {evidence.head.unchanged} · błędy{' '}
        {evidence.head.invalid} · konflikty {evidence.head.conflicts}. Odczytano wszystkie{' '}
        {evidence.rows.length} wierszy. Dane nie są przeliczane z dzisiejszego stanu.
      </p>
      {evidence.head.warnings.map((w, i) => (
        <p className="ra-hint" key={i}>
          {w}
        </p>
      ))}
      {evidence.head.groups.map((g) => (
        <div className="ra-card" key={g.index}>
          <strong>
            {g.supplier_name} · {g.currency} · {g.line_count} pozycji
          </strong>
          <p>
            {g.destination
              ? `Dopisanie do ${g.destination.number} · ${g.destination.line_count_before} → ${g.destination.line_count_after} pozycji`
              : `Nowy szkic ${g.number ?? ''}`}
            {show && g.total_minor !== undefined
              ? ` · dodatkowy zakup netto ${money(g.total_minor, g.currency)}`
              : ''}
          </p>
          {g.destination && (
            <>
              <p>
                Pełny szkic przed dopisaniem · wersja {g.destination.version}
                {g.version ? ` → ${g.version}` : ''}. Zachowany termin{' '}
                {g.destination.snapshot.head.expected_date ?? 'nie ustalono'}, referencja{' '}
                {g.destination.snapshot.head.reference || 'brak'}, notatka{' '}
                {g.destination.snapshot.head.note || 'brak'}.
              </p>
              {show && (
                <p>
                  Netto przed {money(g.destination.total_before_minor, g.currency)} → po{' '}
                  {money(g.destination.total_after_minor, g.currency)}
                </p>
              )}
              <div className="ra-table">
                <table>
                  <thead>
                    <tr>
                      <th>Zachowana pozycja</th>
                      <th>Ilość przed</th>
                      <th>Dopisanie</th>
                      <th>Ilość po</th>
                      <th>Kod dostawcy</th>
                      {show && <th>Koszt netto</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {g.destination.snapshot.lines.map((l) => {
                      const r = evidence.rows.find(
                        (r) => r.product_id === l.product_id && r.group_index === g.index,
                      );
                      const added = r?.recommended_quantity ?? '0';
                      return (
                        <tr key={l.product_id}>
                          <td>
                            {l.sku} · {l.name}
                          </td>
                          <td>{l.quantity}</td>
                          <td>{added}</td>
                          <td>{(BigInt(l.quantity) + BigInt(added)).toString()}</td>
                          <td>{l.supplier_sku || 'Brak'}</td>
                          {show && <td>{money(l.unit_cost, g.currency)}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ))}
      <div className="ra-table">
        <table>
          <thead>
            <tr>
              <th>Produkt / wynik</th>
              <th>Dostępne</th>
              <th>Szkice / dostawy</th>
              <th>Łącznie planowane</th>
              <th>Dodatkowy zakup</th>
              {show && <th>Netto</th>}
            </tr>
          </thead>
          <tbody>
            {evidence.rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.sku ?? r.product_id} · {r.name} <small>{r.status}</small>
                  {r.errors.map((e, i) => (
                    <p key={i} className="ra-error">
                      {e}
                    </p>
                  ))}
                  {r.warnings.map((e, i) => (
                    <p key={i} className="ra-hint">
                      {e}
                    </p>
                  ))}
                  {r.demand && (
                    <small>
                      Okres {new Date(r.demand.from).toLocaleString('pl-PL')} —{' '}
                      {new Date(r.demand.to).toLocaleString('pl-PL')} (koniec wyłączony), wydania{' '}
                      {r.demand.shipped_quantity}, przyjęte zwroty{' '}
                      {r.demand.restocked_return_quantity}, cel ze sprzedaży{' '}
                      {r.demand.coverage_target}.
                    </small>
                  )}
                </td>
                <td>{r.available}</td>
                <td>
                  {r.incoming_draft_quantity} / {r.incoming_ordered_quantity}
                </td>
                <td>{r.projected_available}</td>
                <td>{r.recommended_quantity}</td>
                {show && <td>{money(r.line_total_minor, r.currency ?? '')}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
export function ReplenishmentAutomations({
  contextKey,
  readOnly,
  warehouseId,
  onOpenPurchase,
  onOpenPlan,
  onError,
  onLockedChange,
}: ReplenishmentAutomationsProps) {
  const context = `${contextKey}:${warehouseId ?? ''}:${readOnly}`,
    live = useRef(context);
  live.current = context;
  const epoch = useRef(0),
    sequence = useRef(0),
    inFlight = useRef(false),
    authority = useRef<string | null>(null),
    deniedErrorContext = useRef<string | null>(null),
    flagsRef = useRef<Flags | null>(null),
    pendingRef = useRef<Attempt | null>(null);
  const [options, setOptions] = useState<Options | null>(null),
    [flags, setFlags] = useState<Flags | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [blocked, setBlocked] = useState(false);
  const [tab, setTab] = useState<'rules' | 'editor' | 'runs'>('rules'),
    [rules, setRules] = useState<Rule[]>([]),
    [rulesCursor, setRulesCursor] = useState<string | null>(null),
    [rulesLoaded, setRulesLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank),
    [consent, setConsent] = useState(false),
    [conflict, setConflict] = useState(false),
    [currentRule, setCurrentRule] = useState<Rule | null>(null),
    [savedRule, setSavedRule] = useState<Rule | null>(null);
  const [products, setProducts] = useState<Product[]>([]),
    [productCursor, setProductCursor] = useState<string | null>(null),
    [productTotal, setProductTotal] = useState<number | null>(null),
    [productsLoaded, setProductsLoaded] = useState(false),
    [search, setSearch] = useState('');
  const [runs, setRuns] = useState<Run[]>([]),
    [runCursor, setRunCursor] = useState<string | null>(null),
    [runsLoaded, setRunsLoaded] = useState(false),
    [runFilter, setRunFilter] = useState(''),
    [selectedRun, setSelectedRun] = useState<Run | null>(null),
    [evidence, setEvidence] = useState<Evidence | null>(null),
    [pending, setPending] = useState<Attempt | null>(null);
  const readable =
    authority.current === context && !!flags?.available && !!flags.can_read && !blocked;
  const manage = readable && !!flags?.can_manage && !readOnly && !flags.read_only;
  const locked = busy || !!pending;
  useEffect(() => {
    onLockedChange?.(locked);
    return () => onLockedChange?.(false);
  }, [locked, onLockedChange]);
  function clearPrivate() {
    setRules([]);
    setRulesCursor(null);
    setRulesLoaded(false);
    setDraft({ ...blank(), warehouse: warehouseId ?? '' });
    setConsent(false);
    setConflict(false);
    setCurrentRule(null);
    setSavedRule(null);
    setProducts([]);
    setProductCursor(null);
    setProductTotal(null);
    setProductsLoaded(false);
    setSearch('');
    setRuns([]);
    setRunCursor(null);
    setRunsLoaded(false);
    setRunFilter('');
    setSelectedRun(null);
    setEvidence(null);
    setPending(null);
    pendingRef.current = null;
  }
  function purge() {
    ++epoch.current;
    ++sequence.current;
    inFlight.current = false;
    authority.current = null;
    flagsRef.current = null;
    setFlags(null);
    setOptions(null);
    setBlocked(true);
    setBusy(false);
    clearPrivate();
  }
  function accept(d: Flags) {
    if (!d.available) {
      clearPrivate();
      flagsRef.current = d;
      setFlags(d);
      return false;
    }
    if (!d.can_read) {
      purge();
      return false;
    }
    const old = flagsRef.current;
    if (
      old &&
      (old.current_role !== d.current_role ||
        (old.can_read_value && !d.can_read_value) ||
        (old.can_manage && !d.can_manage && !d.read_only))
    ) {
      purge();
      return false;
    }
    flagsRef.current = d;
    setFlags(d);
    return true;
  }
  function failure(e: unknown) {
    if (e instanceof ApiError && [401, 403, 423].includes(e.status)) purge();
    const message = e instanceof Error ? e.message : 'Nie udało się wykonać operacji.';
    deniedErrorContext.current = live.current;
    setError(message);
    onError?.(message);
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    const key = live.current;
    try {
      const r = await api<T>(path, method, body);
      if (e !== epoch.current || key !== live.current)
        throw new DOMException('Kontekst zmieniony', 'AbortError');
      return r;
    } catch (err) {
      if (e !== epoch.current || key !== live.current)
        throw new DOMException('Kontekst zmieniony', 'AbortError');
      throw err;
    }
  }
  function begin() {
    inFlight.current = true;
    setBusy(true);
    setError('');
    return { e: epoch.current, n: ++sequence.current };
  }
  function end(e: number, n: number) {
    if (e === epoch.current && n === sequence.current) {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function loadOptions() {
    if (inFlight.current || pendingRef.current) return;
    const { e, n } = begin();
    try {
      const d = await request<Options>(prefix + '/options', e);
      if (!d.available) {
        clearPrivate();
        setOptions(d);
        setFlags(d);
        flagsRef.current = d;
        authority.current = live.current;
        return;
      }
      if (!accept(d)) return;
      setOptions(d);
      if (warehouseId && !d.warehouses.data.some((w) => w.id === warehouseId)) {
        setDraft((old) => ({ ...old, warehouse: '' }));
        setError(
          'Wybrany magazyn planowania nie jest dostępny na tej liście; wybierz własny magazyn jawnie.',
        );
      }
      authority.current = live.current;
      setBlocked(false);
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, n);
    }
  }
  useEffect(() => {
    ++epoch.current;
    ++sequence.current;
    inFlight.current = false;
    authority.current = null;
    flagsRef.current = null;
    setOptions(null);
    setFlags(null);
    setBlocked(false);
    setBusy(false);
    clearPrivate();
    setTab('rules');
    setError('');
    deniedErrorContext.current = null;
    setStatus('');
    void loadOptions();
    return () => {
      ++epoch.current;
      ++sequence.current;
      inFlight.current = false;
      authority.current = null;
      pendingRef.current = null;
    };
  }, [contextKey, warehouseId, readOnly]);
  function changed(p: Partial<Draft>) {
    if (!manage || locked || inFlight.current || pendingRef.current) return;
    setDraft((d) => ({ ...d, ...p }));
    setConsent(false);
    setCurrentRule(null);
    setStatus('');
  }
  function edit(r?: Rule) {
    if (!readable || locked || inFlight.current) return;
    setDraft(
      r
        ? {
            id: r.id,
            version: r.version,
            name: r.name,
            warehouse: r.definition.warehouse_id,
            enabled: r.definition.enabled,
            destination: r.definition.destination,
            forecast: !!r.definition.forecast,
            lookback: r.definition.forecast?.lookback_days ?? 30,
            coverage: String(r.definition.forecast?.coverage_days ?? 30),
            products: Object.fromEntries(r.definition.product_ids.map((id) => [id, null])),
          }
        : { ...blank(), warehouse: warehouseId ?? '' },
    );
    setSavedRule(r ?? null);
    setConsent(false);
    setConflict(false);
    setCurrentRule(null);
    setProducts([]);
    setProductCursor(null);
    setProductsLoaded(false);
    setProductTotal(null);
    setSearch('');
    setTab('editor');
  }
  async function loadRules(more = false) {
    if (!readable || inFlight.current || (more && !rulesCursor)) return;
    const { e, n } = begin();
    try {
      const d = await request<Page<Rule>>(
        prefix +
          '/rules?' +
          new URLSearchParams({
            limit: '100',
            ...(more && rulesCursor ? { cursor: rulesCursor } : {}),
          }),
        e,
      );
      if (!accept(d)) return;
      if (d.data.length > 100) throw Error('Nieprawidłowy zakres strony reguł.');
      setRules((old) =>
        more ? [...old, ...d.data.filter((r) => !old.some((o) => o.id === r.id))] : d.data,
      );
      setRulesCursor(d.meta.cursor);
      setRulesLoaded(true);
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, n);
    }
  }
  async function openRule(r: Rule) {
    if (!readable || locked || inFlight.current) return;
    const { e, n } = begin();
    try {
      const d = await request<Flags & { rule: Rule }>(prefix + '/rules/' + r.id, e);
      if (!accept(d)) return;
      if (d.rule.id !== r.id) throw Error('Nieprawidłowa reguła.');
      const q = d.rule;
      setSavedRule(q);
      setDraft({
        id: q.id,
        version: q.version,
        name: q.name,
        warehouse: q.definition.warehouse_id,
        enabled: q.definition.enabled,
        destination: q.definition.destination,
        forecast: !!q.definition.forecast,
        lookback: q.definition.forecast?.lookback_days ?? 30,
        coverage: String(q.definition.forecast?.coverage_days ?? 30),
        products: Object.fromEntries(q.definition.product_ids.map((id) => [id, null])),
      });
      setConsent(false);
      setConflict(false);
      setCurrentRule(null);
      setProducts([]);
      setProductCursor(null);
      setProductsLoaded(false);
      setProductTotal(null);
      setSearch('');
      setTab('editor');
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, n);
    }
  }
  async function loadProducts(more = false, all = false) {
    if (
      !readable ||
      !draft.warehouse ||
      inFlight.current ||
      pendingRef.current ||
      (more && !productCursor)
    )
      return;
    const { e, n } = begin(),
      wh = draft.warehouse;
    try {
      let cursor = more ? productCursor : null;
      const found: Product[] = more ? [...products] : [],
        seen = new Set(found.map((p) => p.id)),
        cursors = new Set<string>();
      let total: number | null = more ? productTotal : null;
      do {
        const d: Page<Product> = await request<Page<Product>>(
          '/replenishment/selection?' +
            new URLSearchParams({
              warehouse_id: wh,
              search,
              limit: '100',
              ...(cursor ? { cursor } : {}),
            }),
          e,
        );
        if (!accept(d)) return;
        if (!Number.isInteger(d.meta.total) || d.data.length > 100)
          throw Error('Nieprawidłowy zakres produktów.');
        if (total === null) total = d.meta.total!;
        if (total !== d.meta.total || (all && total > 500))
          throw Error('Wynik przekracza 500 produktów lub zmienił zakres; niczego nie zaznaczono.');
        for (const p of d.data) {
          if (seen.has(p.id)) throw Error('Powtórzony produkt na kolejnych stronach.');
          seen.add(p.id);
          found.push(p);
        }
        const previousCursor = cursor;
        cursor = d.meta.cursor;
        if (found.length > total || (!cursor && found.length !== total))
          throw Error('Nie odczytano spójnego pełnego zakresu produktów; odczytaj go ponownie.');
        if (cursor) {
          if (
            !d.data.length ||
            cursor === previousCursor ||
            cursors.has(cursor) ||
            (cursors.size >= 5 && all)
          )
            throw Error('Nie odczytano całego zakresu.');
          cursors.add(cursor);
        }
      } while (all && cursor);
      setProducts(found);
      setProductCursor(cursor);
      setProductTotal(total);
      setProductsLoaded(true);
      if (all) {
        if (
          found.length !== total ||
          found.some(
            (p) => !p.policy?.enabled || !p.active || !['simple', 'variant'].includes(p.kind),
          )
        )
          throw Error(
            'Wynik zawiera produkty bez włączonej polityki lub niefizyczne; wybierz je pojedynczo.',
          );
        const next = { ...draft.products };
        for (const p of found) next[p.id] = p;
        if (Object.keys(next).length > 500)
          throw Error('Łączny wybór przekracza 500; niczego nie zaznaczono.');
        setDraft((d) => ({ ...d, products: next }));
        setConsent(false);
      }
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, n);
    }
  }
  function toggle(p: Product, checked: boolean) {
    if (
      !manage ||
      locked ||
      inFlight.current ||
      !p.policy?.enabled ||
      !p.active ||
      !['simple', 'variant'].includes(p.kind)
    )
      return;
    const next = { ...draft.products };
    if (checked) {
      if (Object.keys(next).length >= 500 && !next[p.id]) {
        setError('Najwyżej 500 jawnych produktów.');
        return;
      }
      next[p.id] = p;
    } else delete next[p.id];
    changed({ products: next });
  }
  async function submit(a: Attempt) {
    if (!manage || inFlight.current || (pendingRef.current && pendingRef.current !== a)) return;
    const { e, n } = begin();
    pendingRef.current = a;
    setPending(a);
    setConsent(false);
    let acknowledged = false;
    try {
      const d = await request<Flags & { rule?: Rule; run?: Run; reused: boolean }>(
        a.path,
        e,
        a.method,
        JSON.parse(a.serialized),
      );
      if (!accept(d)) return;
      const target = a.kind === 'cancel' ? d.run : d.rule;
      if (
        !target ||
        !/^[a-f0-9-]{36}$/i.test(target.id) ||
        !Number.isInteger(target.version) ||
        target.version < 1 ||
        (a.kind === 'patch' && a.path !== prefix + '/rules/' + target.id) ||
        (a.kind === 'cancel' && a.path !== prefix + '/runs/' + target.id + '/cancel')
      )
        throw Error('Odpowiedź nie potwierdza wyniku; zachowano dokładną próbę.');
      acknowledged = true;
      pendingRef.current = null;
      setPending(null);
      if (a.kind === 'cancel') {
        setSelectedRun(d.run!);
        setRuns((old) => old.map((r) => (r.id === d.run!.id ? d.run! : r)));
        setStatus(
          d.reused
            ? 'Odczytano wcześniejsze anulowanie; nie powtórzono zmiany.'
            : 'Anulowano oczekujące uruchomienie.',
        );
      } else {
        const r = d.rule!;
        setSavedRule(r);
        setRules((old) => [r, ...old.filter((o) => o.id !== r.id)]);
        setDraft({
          id: r.id,
          version: r.version,
          name: r.name,
          warehouse: r.definition.warehouse_id,
          enabled: r.definition.enabled,
          destination: r.definition.destination,
          forecast: !!r.definition.forecast,
          lookback: r.definition.forecast?.lookback_days ?? 30,
          coverage: String(r.definition.forecast?.coverage_days ?? 30),
          products: Object.fromEntries(
            r.definition.product_ids.map((id) => [
              id,
              r.definition.warehouse_id === draft.warehouse ? (draft.products[id] ?? null) : null,
            ]),
          ),
        });
        setConflict(false);
        setCurrentRule(null);
        setStatus(
          d.reused
            ? 'Odnaleziono wcześniej utworzoną regułę; pokazano jej bieżącą wersję.'
            : 'Reguła zapisana. Włączenie nie uruchamia zakupu dla już niskiego stanu.',
        );
      }
    } catch (err) {
      if (e !== epoch.current) return;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        pendingRef.current = null;
        setPending(null);
        if (a.kind === 'patch' && err.status === 409) setConflict(true);
        failure(err);
      } else if (acknowledged) failure(err);
      else
        setError(
          'Niepewny wynik zapisu. Zatrzymano nowe zapisy; zachowano dokładną treść i klucz w pamięci. Ponów ręcznie tę samą próbę. PATCH po utracie odpowiedzi można porównać z bieżącą wersją.',
        );
    } finally {
      end(e, n);
    }
  }
  function saveRule(event: FormEvent) {
    event.preventDefault();
    if (!manage || locked || inFlight.current || conflict) return;
    try {
      const name = draft.name.trim();
      if (
        !name ||
        name.length > 120 ||
        /[\x00-\x1f\x7f]/.test(name) ||
        new TextDecoder().decode(new TextEncoder().encode(name)) !== name
      )
        throw Error('Nazwa: 1–120 znaków, bez znaków sterujących.');
      const ids = Object.keys(draft.products).sort();
      if (!ids.length || ids.length > 500 || !draft.warehouse)
        throw Error('Wybierz magazyn i od 1 do 500 własnych produktów z polityką.');
      if (draft.enabled && !consent)
        throw Error('Potwierdź przyszłe lokalne zmiany przed włączeniem reguły.');
      if (draft.destination === 'append_matching_draft' && options?.append_available !== true)
        throw Error('Dopisanie do najstarszego szkicu jest niedostępne.');
      let forecast: Forecast | undefined;
      if (draft.forecast) {
        if (options?.forecast_available !== true) throw Error('Prognoza niedostępna w tej kopii.');
        if (!/^[1-9]\d*$/.test(draft.coverage) || BigInt(draft.coverage) > 365n)
          throw Error('Dni pokrycia: liczba całkowita 1–365.');
        forecast = { lookback_days: draft.lookback, coverage_days: Number(draft.coverage) };
      }
      const definition: Definition = {
        warehouse_id: draft.warehouse,
        product_ids: ids,
        enabled: draft.enabled,
        destination: draft.destination,
        ...(forecast ? { forecast } : {}),
      };
      const body = {
        name,
        definition,
        ...(draft.id ? { version: draft.version } : { client_key: crypto.randomUUID() }),
        ...(draft.enabled ? { confirmed_future_drafts: true } : {}),
      };
      const serialized = JSON.stringify(body);
      if (
        new TextEncoder().encode(serialized).byteLength > (options?.limits.request_bytes ?? 262144)
      )
        throw Error('Żądanie przekracza 256 KiB; nie obcięto wyboru.');
      void submit({
        kind: draft.id ? 'patch' : 'create',
        path: prefix + '/rules' + (draft.id ? '/' + draft.id : ''),
        method: draft.id ? 'PATCH' : 'POST',
        serialized,
      });
    } catch (err) {
      failure(err);
    }
  }
  async function readCurrentRule() {
    if (!readable || !draft.id || inFlight.current) return;
    const { e, n } = begin();
    try {
      const d = await request<Flags & { rule: Rule }>(prefix + '/rules/' + draft.id, e);
      if (!accept(d)) return;
      if (d.rule.id !== draft.id) throw Error('Odczytano inną regułę.');
      setCurrentRule(d.rule);
      setConsent(false);
      setStatus('Odczytano bieżącą regułę. Nie podmieniono szkicu ani wersji zapisu.');
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, n);
    }
  }
  function adoptCurrent() {
    if (!manage || inFlight.current || !currentRule) return;
    if (pendingRef.current) {
      if (pendingRef.current.kind !== 'patch') return;
      const old = JSON.parse(pendingRef.current.serialized) as { version: number };
      if (currentRule.version <= old.version) {
        setError(
          'Bieżąca wersja nie rozstrzyga wcześniejszej próby. Zachowano ją do ręcznego ponowienia.',
        );
        return;
      }
    }
    pendingRef.current = null;
    setPending(null);
    const r = currentRule;
    setSavedRule(r);
    setDraft({
      id: r.id,
      version: r.version,
      name: r.name,
      warehouse: r.definition.warehouse_id,
      enabled: r.definition.enabled,
      destination: r.definition.destination,
      forecast: !!r.definition.forecast,
      lookback: r.definition.forecast?.lookback_days ?? 30,
      coverage: String(r.definition.forecast?.coverage_days ?? 30),
      products: Object.fromEntries(r.definition.product_ids.map((id) => [id, null])),
    });
    setCurrentRule(null);
    setConflict(false);
    setConsent(false);
    setProducts([]);
    setProductsLoaded(false);
    setProductCursor(null);
    setProductTotal(null);
    setSearch('');
    setStatus('Świadomie przyjęto bieżącą wersję po porównaniu. Nie wykonano nowego zapisu.');
  }
  async function loadRuns(more = false) {
    if (!readable || inFlight.current || (more && !runCursor)) return;
    const { e, n } = begin();
    try {
      const d = await request<Page<Run>>(
        prefix +
          '/runs?' +
          new URLSearchParams({
            limit: '100',
            ...(runFilter ? { rule_id: runFilter } : {}),
            ...(more && runCursor ? { cursor: runCursor } : {}),
          }),
        e,
      );
      if (!accept(d)) return;
      if (d.data.length > 100) throw Error('Nieprawidłowa strona uruchomień.');
      setRuns((old) =>
        more ? [...old, ...d.data.filter((r) => !old.some((o) => o.id === r.id))] : d.data,
      );
      setRunCursor(d.meta.cursor);
      setRunsLoaded(true);
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, n);
    }
  }
  async function readRun(id: string) {
    if (!readable || inFlight.current) return;
    const { e, n } = begin();
    setEvidence(null);
    try {
      const d = await request<Flags & { run: Run }>(prefix + '/runs/' + id, e);
      if (!accept(d)) return;
      if (d.run.id !== id) throw Error('Odczytano inne uruchomienie.');
      setSelectedRun(d.run);
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, n);
    }
  }
  async function readEvidence(kind: 'preview' | 'execution', id: string) {
    if (!readable || inFlight.current) return;
    const { e, n } = begin();
    setEvidence(null);
    try {
      const base = '/replenishment/' + (kind === 'preview' ? 'previews/' : 'executions/') + id;
      const d = await request<Flags & { preview?: PlanHead; execution?: PlanHead }>(base, e);
      if (!accept(d)) return;
      const h = kind === 'preview' ? d.preview : d.execution;
      if (!h || h.id !== id || !Number.isInteger(h.total) || h.total < 1 || h.total > 500)
        throw Error('Nie potwierdzono pełnego zakresu planu.');
      const rows: PlanRow[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: Page<PlanRow> = await request<Page<PlanRow>>(
          base + '/rows?' + new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }),
          e,
        );
        if (!accept(page)) return;
        if (page.meta.total !== h.total || page.data.length > 100)
          throw Error('Strona nie odpowiada pełnemu dowodowi.');
        for (const r of page.data) {
          if (seen.has(r.id)) throw Error('Powtórzony wiersz dowodu.');
          seen.add(r.id);
          rows.push(r);
        }
        if (rows.length > h.total)
          throw Error('Zakres dowodu przekroczył deklarowaną liczbę produktów.');
        cursor = page.meta.cursor;
        if (cursor) {
          if (!page.data.length || cursors.has(cursor) || cursors.size >= 5)
            throw Error('Nie odczytano pełnych stron dowodu.');
          cursors.add(cursor);
        }
      } while (cursor);
      if (rows.length !== h.total) throw Error('Nie odczytano pełnego dowodu.');
      for (const g of h.groups)
        if (
          g.destination &&
          g.destination.snapshot.lines.length !== g.destination.line_count_before
        )
          throw Error('Nie odczytano wszystkich zachowanych pozycji szkicu.');
      setEvidence({ kind, head: h, rows, valueVisible: d.can_read_value });
    } catch (err) {
      if (e === epoch.current) failure(err);
    } finally {
      end(e, n);
    }
  }
  const productIds = Object.keys(draft.products),
    ownContext = authority.current === context;
  return (
    <section className="replenishment-automations" aria-label="Automatyczne uzupełnianie zapasu">
      <div className="ra-header">
        <div>
          <h2>Automatyczne uzupełnianie zapasu</h2>
          <p>
            Przekroczenie minimum → lokalny plan → szkic zakupu. Bez zatwierdzenia PO ani wysyłki do
            dostawcy.
          </p>
        </div>
        <button className="button" disabled={busy || !!pending} onClick={() => void loadOptions()}>
          Odśwież dostęp i opcje
        </button>
      </div>
      {(ownContext || deniedErrorContext.current === context) && error && (
        <p className="ra-error" role="alert">
          {error}
        </p>
      )}
      {ownContext && status && (
        <p className="ra-status" role="status">
          {status}
        </p>
      )}
      {blocked && <p className="ra-error">Dostęp utracony. Szkice i dowody usunięto z panelu.</p>}
      {!options && !blocked && <p>Odczytywanie dostępności…</p>}
      {options && !options.available && (
        <p className="ra-hint">
          Ta kopia nie obsługuje automatycznego uzupełniania. Ręczne planowanie pozostaje osobnym
          procesem.
        </p>
      )}
      {readable && options && (
        <>
          <p className="ra-hint">
            Reguła reaguje wyłącznie na zmianę istniejącego zapasu: dostępne było co najmniej równe
            minimum polityki i spadło poniżej minimum. Włączenie przy już niskim stanie i początkowy
            zapis niskiego stanu nie uruchamiają zakupu. Plan uwzględnia wszystkie pozostałe szkice
            i dostawy, aby nie dublować zakupów.
          </p>
          {!manage && (
            <p className="ra-hint">
              Dostępny odczyt; zmiany reguł i anulowanie wymagają bieżących uprawnień
              administratora.
            </p>
          )}
          {pending && (
            <div className="ra-pending" role="status">
              <strong>
                {busy
                  ? 'Trwa zapis dokładnej próby.'
                  : 'Niepewny wynik — zachowano dokładną próbę w pamięci.'}
              </strong>
              <p>
                Nowe zapisy są zablokowane. Przełączenie widoku wewnątrz panelu zachowuje próbę;
                opuszczenie modułu lub odświeżenie strony nie zachowuje RAM.
              </p>
              <div className="ra-actions">
                <button
                  className="button"
                  disabled={!manage || busy}
                  onClick={() => void submit(pending)}
                >
                  Ponów dokładnie tę samą próbę
                </button>
                {pending.kind === 'patch' && (
                  <button className="button" disabled={busy} onClick={() => void readCurrentRule()}>
                    Odczytaj bieżącą regułę do porównania
                  </button>
                )}
              </div>
            </div>
          )}
          <nav className="ra-actions" aria-label="Widoki automatycznego uzupełniania">
            <button className="button" onClick={() => setTab('rules')}>
              Reguły
            </button>
            <button className="button" disabled={!manage || locked} onClick={() => edit()}>
              Nowa reguła
            </button>
            <button className="button" onClick={() => setTab('runs')}>
              Historia uruchomień
            </button>
          </nav>
          {tab === 'rules' && (
            <>
              <div className="ra-actions">
                <button className="button" disabled={busy} onClick={() => void loadRules()}>
                  Odczytaj reguły
                </button>
                {rulesCursor && (
                  <button className="button" disabled={busy} onClick={() => void loadRules(true)}>
                    Odczytaj kolejną stronę reguł
                  </button>
                )}
              </div>
              {rulesLoaded && !rules.length && <p role="status">Odczyt zakończony. Brak reguł.</p>}
              <div className="ra-rule-list">
                {rules.map((r) => (
                  <button
                    className="button"
                    key={r.id}
                    disabled={locked}
                    onClick={() => void openRule(r)}
                  >
                    {r.name} · {r.definition.enabled ? 'Włączona' : 'Wyłączona'} · wersja{' '}
                    {r.version} · {r.definition.product_ids.length} produktów
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === 'editor' && (
            <form onSubmit={saveRule}>
              <h3>{draft.id ? 'Edytuj regułę' : 'Nowa reguła — domyślnie wyłączona'}</h3>
              <div className="ra-grid">
                <label>
                  Nazwa reguły
                  <input
                    value={draft.name}
                    disabled={!manage || locked}
                    maxLength={120}
                    onChange={(e) => changed({ name: e.target.value })}
                  />
                </label>
                <label>
                  Magazyn
                  <select
                    value={draft.warehouse}
                    disabled={!manage || locked}
                    onChange={(e) => {
                      changed({ warehouse: e.target.value, products: {} });
                      setProducts([]);
                      setProductCursor(null);
                      setProductTotal(null);
                      setProductsLoaded(false);
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
                <label>
                  Docelowy zakup
                  <select
                    value={draft.destination}
                    disabled={!manage || locked}
                    onChange={(e) =>
                      changed({ destination: e.target.value as Definition['destination'] })
                    }
                  >
                    <option value="new_drafts">Nowe szkice</option>
                    <option value="append_matching_draft" disabled={!options.append_available}>
                      Najstarszy pasujący szkic albo nowy
                    </option>
                  </select>
                </label>
              </div>
              {options.warehouses.capped && (
                <p className="ra-hint">
                  Lista magazynów jest ograniczona; pozostałych nie wybrano automatycznie.
                </p>
              )}
              {draft.destination === 'append_matching_draft' && (
                <p className="ra-hint">
                  Wybieramy najstarszy własny pasujący niezatwierdzony szkic; gdy nie ma żadnego,
                  tworzymy nowy. Konflikt kosztu, kodu dostawcy albo pojemności wybranego szkicu
                  blokuje całe uruchomienie — bez zamiany na nowy dokument.
                </p>
              )}
              <label className="ra-check">
                <input
                  type="checkbox"
                  checked={draft.forecast}
                  disabled={!manage || locked || !options.forecast_available}
                  onChange={(e) => changed({ forecast: e.target.checked })}
                />
                <span>Wylicz ilości według zapisanych wydań</span>
              </label>
              {draft.forecast && (
                <>
                  <div className="ra-grid">
                    <label>
                      Okno sprzedaży
                      <select
                        value={draft.lookback}
                        disabled={!manage || locked}
                        onChange={(e) =>
                          changed({ lookback: Number(e.target.value) as Forecast['lookback_days'] })
                        }
                      >
                        {windows.map((n) => (
                          <option value={n} key={n}>
                            {n} dni
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Dni pokrycia
                      <input
                        value={draft.coverage}
                        inputMode="numeric"
                        disabled={!manage || locked}
                        onChange={(e) => changed({ coverage: e.target.value })}
                      />
                      <small>1–365 dni</small>
                    </label>
                  </div>
                  <p className="ra-hint">
                    Prognoza obejmuje tylko wydania zapisane w systemie, również DEMO/sandbox. Brak
                    wpisów nie potwierdza braku sprzedaży poza systemem. Przyjęte zwroty są
                    informacyjne i nie pomniejszają wydań; dostępność uwzględnia już przyjęcie.
                    Minimum polityki jest dolnym progiem celu; ręczny cel jest pomijany.
                  </p>
                </>
              )}
              <fieldset>
                <legend>Jawne produkty · {productIds.length}/500</legend>
                <label>
                  Szukaj SKU lub nazwy
                  <input
                    value={search}
                    disabled={locked}
                    maxLength={200}
                    onChange={(e) => {
                      if (inFlight.current || pendingRef.current) return;
                      setSearch(e.target.value);
                      setProducts([]);
                      setProductsLoaded(false);
                      setProductCursor(null);
                      setProductTotal(null);
                    }}
                  />
                </label>
                <div className="ra-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !!pending || !draft.warehouse}
                    onClick={() => void loadProducts()}
                  >
                    Odczytaj produkty z politykami
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={!manage || locked || !draft.warehouse}
                    onClick={() => void loadProducts(false, true)}
                  >
                    Zaznacz cały wynik · maks. 500
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={!manage || locked || !productIds.length}
                    onClick={() => changed({ products: {} })}
                  >
                    Wyczyść wybór
                  </button>
                </div>
                {productsLoaded && (
                  <p role="status">
                    Odczytano {products.length} z {productTotal} produktów.
                    {!products.length ? ' Brak wyników.' : ''}
                  </p>
                )}
                {!!products.length && (
                  <div className="ra-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Wybór</th>
                          <th>Produkt</th>
                          <th>Minimum / cel</th>
                          <th>Polityka</th>
                        </tr>
                      </thead>
                      <tbody>
                        {products.map((p) => (
                          <tr key={p.id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Wybierz ${p.sku}`}
                                checked={Object.hasOwn(draft.products, p.id)}
                                disabled={
                                  !manage ||
                                  locked ||
                                  !p.policy?.enabled ||
                                  !p.active ||
                                  !['simple', 'variant'].includes(p.kind)
                                }
                                onChange={(e) => toggle(p, e.target.checked)}
                              />
                            </td>
                            <td>
                              {p.sku} · {p.name}
                            </td>
                            <td>
                              {p.policy?.minimum_quantity ?? 'Brak'} /{' '}
                              {p.policy?.target_quantity ?? 'Brak'}
                            </td>
                            <td>
                              {p.policy?.enabled ? 'Włączona' : 'Brak włączonej polityki'} · wersja{' '}
                              {p.policy_version ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {productCursor && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !!pending}
                    onClick={() => void loadProducts(true)}
                  >
                    Odczytaj kolejną stronę produktów
                  </button>
                )}
                {!!productIds.length && (
                  <details>
                    <summary>Pokaż cały wybór · {productIds.length}</summary>
                    <ul>
                      {productIds.map((id) => (
                        <li key={id}>
                          {draft.products[id]?.sku ?? id} ·{' '}
                          {draft.products[id]?.name ?? 'Zapisany produkt'}{' '}
                          {manage && !locked && (
                            <button
                              type="button"
                              className="button"
                              onClick={() => {
                                const next = { ...draft.products };
                                delete next[id];
                                changed({ products: next });
                              }}
                            >
                              Usuń z wyboru
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <p>
                  Bieżące polityki i wersje produktów serwer utrwala przy zapisie reguły. Brak
                  włączonej polityki jest błędem; nie pomijamy produktu po cichu.
                </p>
              </fieldset>
              {savedRule && (
                <details className="ra-card">
                  <summary>Zapisany zakres reguły · wersja {savedRule.version}</summary>
                  <p>
                    Magazyn{' '}
                    {options.warehouses.data.find((w) => w.id === savedRule.definition.warehouse_id)
                      ?.name ?? savedRule.definition.warehouse_id}
                    . Poniższe wersje polityk są zgodą zapisaną na serwerze, nie bieżącym podglądem
                    produktów.
                  </p>
                  <ul>
                    {savedRule.policy_items.map((p) => (
                      <li key={p.product_id}>
                        {draft.products[p.product_id]?.sku ?? p.product_id} · polityka {p.policy_id}
                        , wersja {p.policy_version} · produkt wersja {p.product_version}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <label className="ra-check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  disabled={!manage || locked}
                  onChange={(e) => changed({ enabled: e.target.checked })}
                />
                <span>Włącz regułę dla przyszłych przekroczeń minimum</span>
              </label>
              {draft.enabled && (
                <>
                  <p className="ra-hint">
                    Pełna kolejka {options.limits.pending} oczekujących uruchomień lub historia{' '}
                    {options.limits.runs} wpisów może zatrzymać zmianę zapasu z błędem, aby nie
                    zgubić zdarzenia. Włączenie nie wykonuje natychmiastowego uzupełnienia już
                    niskich stanów.
                  </p>
                  <label className="ra-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={!manage || locked}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      Potwierdzam przyszłe lokalne zmiany dla tych {productIds.length} produktów i
                      magazynu: tworzenie szkiców
                      {draft.destination === 'append_matching_draft'
                        ? ' lub dopisywanie do najstarszego pasującego szkicu'
                        : ''}{' '}
                      po przekroczeniu minimum, z uwzględnieniem istniejących zakupów. Bez
                      zatwierdzania PO, zmiany stanów przez sam plan ani kontaktu z dostawcą.
                    </span>
                  </label>
                </>
              )}
              {conflict && (
                <p className="ra-error">
                  Reguła lub zatwierdzona polityka zmieniła się. Szkic zachowano; odczytaj i
                  porównaj bieżącą wersję. Przy zmianie polityki zapisz regułę wyłączoną, odczytaj
                  ją, sprawdź zakres i dopiero ponownie włącz z nową zgodą.
                </p>
              )}
              <div className="ra-actions">
                <button
                  type="submit"
                  className="button primary"
                  disabled={!manage || locked || conflict || (draft.enabled && !consent)}
                >
                  {draft.id ? 'Zapisz zmiany reguły' : 'Utwórz regułę'}
                </button>
                {draft.id && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => void readCurrentRule()}
                  >
                    Odczytaj bieżącą regułę do porównania
                  </button>
                )}
              </div>
              {currentRule && (
                <div className="ra-card">
                  <h4>Bieżąca wersja {currentRule.version}</h4>
                  <p>
                    {currentRule.name} · {currentRule.definition.enabled ? 'Włączona' : 'Wyłączona'}{' '}
                    · {currentRule.definition.product_ids.length} produktów ·{' '}
                    {currentRule.definition.destination === 'new_drafts'
                      ? 'Nowe szkice'
                      : 'Najstarszy szkic albo nowy'}
                  </p>
                  <button
                    type="button"
                    className="button"
                    disabled={!manage || busy || (!!pending && pending.kind !== 'patch')}
                    onClick={adoptCurrent}
                  >
                    Przyjmij bieżącą wersję po porównaniu
                  </button>
                </div>
              )}
            </form>
          )}
          {tab === 'runs' && (
            <>
              <h3>Historia uruchomień</h3>
              <label>
                Reguła w historii
                <select
                  value={runFilter}
                  disabled={busy}
                  onChange={(e) => {
                    setRunFilter(e.target.value);
                    setRuns([]);
                    setRunCursor(null);
                    setRunsLoaded(false);
                    setSelectedRun(null);
                    setEvidence(null);
                  }}
                >
                  <option value="">Wszystkie własne reguły</option>
                  {rules.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="ra-actions">
                <button className="button" disabled={busy} onClick={() => void loadRuns()}>
                  Odczytaj uruchomienia
                </button>
                {runCursor && (
                  <button className="button" disabled={busy} onClick={() => void loadRuns(true)}>
                    Odczytaj starsze uruchomienia
                  </button>
                )}
              </div>
              {runsLoaded && !runs.length && (
                <p role="status">Odczyt zakończony. Brak uruchomień w tym zakresie.</p>
              )}
              <div className="ra-rule-list">
                {runs.map((r) => (
                  <button
                    className="button"
                    key={r.id}
                    disabled={busy}
                    onClick={() => void readRun(r.id)}
                  >
                    {date(r.created_at)} · {r.name} · {states[r.state]} · wersja reguły{' '}
                    {r.rule_version}
                  </button>
                ))}
              </div>
              {selectedRun && (
                <section className="ra-card">
                  <h4>
                    {selectedRun.name} · {states[selectedRun.state]}
                  </h4>
                  <p>
                    Reguła wersja {selectedRun.rule_version}, uruchomienie wersja{' '}
                    {selectedRun.version}. {selectedRun.result.reason}
                  </p>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void readRun(selectedRun.id)}
                  >
                    Odczytaj stan ponownie
                  </button>
                  <div className="ra-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Produkt</th>
                          <th>Dostępne przed</th>
                          <th>Dostępne po</th>
                          <th>Minimum przy przekroczeniu</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRun.crossings.map((c) => (
                          <tr key={c.product_id}>
                            <td>{c.product_id}</td>
                            <td>{c.before_available}</td>
                            <td>{c.after_available}</td>
                            <td>{c.minimum_quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {selectedRun.can_cancel && (
                    <button
                      className="button"
                      disabled={!manage || locked}
                      onClick={() =>
                        void submit({
                          kind: 'cancel',
                          path: prefix + '/runs/' + selectedRun.id + '/cancel',
                          method: 'POST',
                          serialized: JSON.stringify({
                            client_key: crypto.randomUUID(),
                            version: selectedRun.version,
                          }),
                        })
                      }
                    >
                      Anuluj oczekujące uruchomienie
                    </button>
                  )}
                  <div className="ra-actions">
                    {(['preview', 'execution'] as const).map((kind) => {
                      const id =
                        kind === 'preview'
                          ? selectedRun.result.preview_id
                          : selectedRun.result.execution_id;
                      return id ? (
                        <button
                          className="button"
                          key={kind}
                          disabled={busy}
                          onClick={() => void readEvidence(kind, id)}
                        >
                          Odczytaj pełny {kind === 'preview' ? 'podgląd' : 'wynik'} planu
                        </button>
                      ) : null;
                    })}
                    {(selectedRun.result.purchase_order_ids ?? []).map((id) =>
                      flags?.can_read_value || flags?.can_manage ? (
                        <button
                          className="button"
                          key={id}
                          disabled={locked}
                          onClick={() => onOpenPurchase(id)}
                        >
                          Otwórz zakup{' '}
                          {evidence?.head.groups.find((g) => g.purchase_order_id === id)?.number ??
                            id}
                        </button>
                      ) : (
                        <span key={id}>Zakup {id}</span>
                      ),
                    )}
                  </div>
                  {onOpenPlan && selectedRun.result.execution_id && (
                    <button
                      className="button"
                      disabled={locked}
                      onClick={() => onOpenPlan('execution', selectedRun.result.execution_id!)}
                    >
                      Pokaż wynik w planowaniu
                    </button>
                  )}
                  {evidence && (
                    <EvidenceView evidence={evidence} canValue={!!flags?.can_read_value} />
                  )}
                </section>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
